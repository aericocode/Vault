/**
 * Semantic search — embeddings over EXISTING text metadata.
 *
 * No file rescan involved: the vector for each item is computed from the
 * description/tags/themes/transcription already extracted by the tagger.
 * Embedding model runs locally in LM Studio (JIT-loaded on first request,
 * e.g. text-embedding-nomic-embed-text-v1.5).
 *
 * Vectors are stored as Float32 BLOBs in media.embedding. Search is
 * brute-force cosine over an in-memory cache — comfortably fast for 100k
 * rows (~100k × 768 dot products ≈ tens of ms).
 */

const config = require('../config');
const llm = require('./llm-client');

// Lazy DB (avoids import cycles)
function getDb() {
  return require('./database');
}

/**
 * Build the text that represents an item for embedding.
 * Uses existing metadata only — no file access.
 */
function textForItem(row) {
  const parse = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };
  const parts = [
    row.filename,
    row.description,
    parse(row.tags).join(', '),
    parse(row.themes).join(', '),
    parse(row.locations).join(', '),
    row.content_type,
    row.language,
    (row.audio_transcription || '').slice(0, 1000),
  ];
  return parts.filter(Boolean).join('\n').trim();
}

function bufferToVec(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function vecToBuffer(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Embed a batch of rows and store their vectors. Skips rows with no text.
 * @returns {number} how many rows were embedded
 */
async function embedRows(rows) {
  const withText = rows
    .map(row => ({ row, text: textForItem(row) }))
    .filter(x => x.text.length > 0);
  if (withText.length === 0) return 0;

  const vectors = await llm.embed(withText.map(x => x.text));
  const db = getDb();
  const handle = db.get();
  const stmt = handle.prepare('UPDATE media SET embedding = ?, embedding_model = ? WHERE id = ?');

  let saved = 0;
  for (let i = 0; i < withText.length; i++) {
    if (Array.isArray(vectors[i]) && vectors[i].length > 0) {
      stmt.run(vecToBuffer(vectors[i]), config.embeddings.model, withText[i].row.id);
      saved++;
    }
  }
  invalidateCache();
  return saved;
}

/**
 * Embed a single item by id (used at scan time). Errors are non-fatal —
 * a failed embedding just means the item won't semantic-match until the
 * next `embed` backfill.
 */
async function embedOne(id) {
  const db = getDb();
  const row = db.getById(id);
  if (!row) return false;
  try {
    return (await embedRows([row])) === 1;
  } catch (err) {
    console.warn(`  Embedding failed for ${row.filename}: ${err.message}`);
    return false;
  }
}

/**
 * Copy an embedding between rows (dupes share content → share vectors,
 * no API call needed).
 */
function copyEmbedding(fromId, toId) {
  const db = getDb();
  const handle = db.get();
  handle.prepare(`
    UPDATE media SET embedding = (SELECT embedding FROM media WHERE id = ?),
                     embedding_model = (SELECT embedding_model FROM media WHERE id = ?)
    WHERE id = ?
  `).run(fromId, fromId, toId);
  invalidateCache();
}

// ── In-memory vector cache for search ──────────────────────────────────────

let _cache = null; // Array<{id, vec}>

function invalidateCache() {
  _cache = null;
}

function loadCache() {
  if (_cache) return _cache;
  const handle = getDb().get();
  const rows = handle.prepare(
    'SELECT id, embedding FROM media WHERE embedding IS NOT NULL AND user_trashed = 0'
  ).all();
  _cache = rows.map(r => ({ id: r.id, vec: bufferToVec(r.embedding) }));
  return _cache;
}

/**
 * Semantic search: embed the query, rank all embedded items by cosine
 * similarity.
 * @returns {Promise<Array<{id:number, score:number}>>} top `limit`, best first
 */
async function search(query, limit = 500) {
  const [queryVec] = await llm.embed([query]);
  if (!Array.isArray(queryVec)) throw new Error('empty query embedding');
  const qv = new Float32Array(queryVec);

  const entries = loadCache();
  const scored = entries.map(e => ({ id: e.id, score: cosine(qv, e.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Count rows still missing embeddings (for status/reporting).
 */
function missingCount() {
  const handle = getDb().get();
  return handle.prepare(
    'SELECT COUNT(*) AS n FROM media WHERE embedding IS NULL AND processing_error IS NULL'
  ).get().n;
}

module.exports = {
  textForItem,
  embedRows,
  embedOne,
  copyEmbedding,
  search,
  invalidateCache,
  missingCount,
};
