/**
 * Flow measurements, one row per file, in the main library database (so an
 * encrypted library keeps them encrypted with everything else).
 *
 *   media_flow(media_id PK, version, src, lufs, peak_db, has_music, no_audio,
 *              bpm_start, bpm_mid, bpm_end, bpm_conf, e_start, e_mid, e_end,
 *              env, edges, measured_at, ms, error, error_code)
 *
 * src is the file's size and modification time when it was measured; a row
 * whose src or version no longer matches counts as not measured (the file
 * changed, or the method did), and is measured again when asked. Except: a
 * row from an older method whose numbers still mean the same (version
 * MIN_VERSION or later, no error) is used meanwhile, marked stale, and
 * measured again in the background (version 2 rows have no envelope: the
 * chart draws them from start, middle and end until then).
 * error: why it could not be measured, as ffmpeg (or Vault) said it (the
 * row's numbers are then null); error_code: what kind of failure (MISSING,
 * SPAWN, TIMEOUT, DECODE..., null for rows from before it was kept), so the
 * page can say it in plain words (lib/flow/service.js failReason).
 *
 * Rows that say "Flow worker ..." are not the file's fault: 3.10.0-beta.1's
 * exe could not start Flow's worker and saved that as every file's failure.
 * They are deleted when the database opens (ensureSchema), so those files
 * are measured again; Flow no longer saves such failures at all.
 * env: the energy envelope (lib/flow/analyze.js), JSON [[t, e], ...] with t
 * (0..1, where in the file) and e (0..1) to 3 decimals, about 10 pairs; NULL
 * when there is none (a very short file, a row from before version 3).
 * edges: the edge pieces (lib/flow/analyze.js), JSON { d, start, end }, so
 * Flow can look past a calm intro or credits (player-lib/flow-order.js
 * edgeSkips) without measuring again; NULL for a short file, a row from
 * before version 5 (Flow then looks at the edges as they are), or anything
 * not of that shape.
 */

const { VERSION, MIN_VERSION } = require('./analyze');

/** A row from an older method that is still used until it is measured again. */
const usableOld = (r) => r.version >= MIN_VERSION && r.version < VERSION && !r.error;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_flow (
      media_id    INTEGER PRIMARY KEY,
      version     INTEGER NOT NULL,
      src         TEXT,
      lufs        REAL,
      peak_db     REAL,
      has_music   INTEGER NOT NULL DEFAULT 0,
      no_audio    INTEGER NOT NULL DEFAULT 0,
      bpm_start   REAL,
      bpm_mid     REAL,
      bpm_end     REAL,
      bpm_conf    REAL,
      e_start     REAL,
      e_mid       REAL,
      e_end       REAL,
      env         TEXT,
      edges       TEXT,
      measured_at INTEGER,
      ms          INTEGER,
      error       TEXT,
      error_code  TEXT
    );
  `);
  // Columns added later (older libraries get them here; see database.js ensureColumns).
  const cols = new Set(db.prepare('PRAGMA table_info(media_flow)').all().map(c => c.name));
  for (const [name, type] of [['env', 'TEXT'], ['error_code', 'TEXT'], ['edges', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE media_flow ADD COLUMN ${name} ${type}`);
  }
  const n = purgeWorkerFailures(db);
  if (n) console.log(`[Flow] ${n} ${n === 1 ? 'file' : 'files'} that Flow's worker failed on (not the file's fault) will be measured again`);
}

/** Delete failures that were Flow's worker failing, not the file (see the top). @returns {number} rows deleted */
function purgeWorkerFailures(db) {
  return db.prepare("DELETE FROM media_flow WHERE error IS NOT NULL AND error LIKE 'Flow worker%'").run().changes;
}

/** The file's identity for a measurement: size and modification time. */
function srcOf(row) {
  if (!row) return null;
  return `${row.filesize_bytes ?? ''}:${row.file_mtime_ms ?? ''}`;
}

const COLS = ['version', 'src', 'lufs', 'peak_db', 'has_music', 'no_audio', 'bpm_start', 'bpm_mid', 'bpm_end',
  'bpm_conf', 'e_start', 'e_mid', 'e_end', 'env', 'edges', 'measured_at', 'ms', 'error', 'error_code'];

/** The envelope as stored: JSON pairs in time order, or null (malformed pairs are dropped). */
function encodeEnv(env) {
  if (typeof env === 'string') env = decodeEnv(env);
  if (!Array.isArray(env)) return null;
  // Pairs that are not two finite numbers are dropped; t and e kept inside 0..1; in time order.
  const r3 = (x) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000;
  const out = env.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(p => [r3(p[0]), r3(p[1])])
    .sort((a, b) => a[0] - b[0]);
  return out.length >= 2 ? JSON.stringify(out) : null;
}

function decodeEnv(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * The edge pieces as stored: JSON, or null unless it is { d, start, end }
 * with each side's l, e, w, b lists (numbers or null), w and b alike long.
 */
function encodeEdges(x) {
  if (typeof x === 'string') { try { x = JSON.parse(x); } catch { return null; } }
  if (!x || typeof x !== 'object' || !(Number(x.d) > 0)) return null;
  const nums = (a) => Array.isArray(a) && a.length <= 64 && a.every(v => v === null || Number.isFinite(v));
  const side = (s) => s && nums(s.l) && nums(s.e) && nums(s.w) && nums(s.b) && s.w.length === s.b.length && s.l.length === s.e.length
    ? { l: s.l, e: s.e, w: s.w, b: s.b } : null;
  const start = side(x.start), end = side(x.end);
  return start && end ? JSON.stringify({ d: x.d, start, end }) : null;
}

function save(db, mediaId, src, f, { error = null, errorCode = null, now = Date.now() } = {}) {
  const v = { version: VERSION, src, measured_at: now, error, error_code: error ? errorCode : null, ...(f || {}) };
  if (error) for (const k of ['lufs', 'peak_db', 'bpm_start', 'bpm_mid', 'bpm_end', 'bpm_conf', 'e_start', 'e_mid', 'e_end', 'env', 'edges']) v[k] = null;
  v.version = VERSION;
  v.has_music = v.has_music ? 1 : 0;
  v.no_audio = v.no_audio ? 1 : 0;
  v.env = encodeEnv(v.env);
  v.edges = encodeEdges(v.edges);
  db.prepare(`INSERT OR REPLACE INTO media_flow (media_id, ${COLS.join(', ')}) VALUES (?, ${COLS.map(() => '?').join(', ')})`)
    .run(mediaId, ...COLS.map(k => (v[k] === undefined ? null : v[k])));
}

/**
 * Rows for these ids that are current (version and src match the media row),
 * and usable older rows with stale: 1 (see the top).
 * @returns {Map<number, object>} id -> row
 */
function currentFor(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const CHUNK = 900;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db.prepare(`SELECT f.*, m.filesize_bytes, m.file_mtime_ms FROM media_flow f JOIN media m ON m.id = f.media_id
      WHERE f.media_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(part));
    for (const r of rows) {
      if (r.src !== srcOf(r)) continue;
      if (r.version !== VERSION && !usableOld(r)) continue;
      r.stale = r.version !== VERSION ? 1 : 0;
      delete r.filesize_bytes; delete r.file_mtime_ms;
      out.set(r.media_id, r);
    }
  }
  return out;
}

function get(db, id) {
  return currentFor(db, [id]).get(id) || null;
}

function remove(db, id) {
  db.prepare('DELETE FROM media_flow WHERE media_id = ?').run(id);
}

/**
 * For "Whole library now": the files after `afterId` (in id order) that can
 * be measured and are not, or are out of date (the file's size or time, or
 * the method, changed). A keyset walk on the primary key, `limit` rows a
 * step, at most `maxRows` rows a call, so each call is a few ms whatever the
 * library's size; the caller keeps the cursor.
 * @returns {{ids: number[], cursor: number, done: boolean}}
 */
const SWEEP_SQL = `SELECT m.id, m.media_type, m.user_trashed, m.filesize_bytes, m.file_mtime_ms, f.version, f.src
  FROM media m LEFT JOIN media_flow f ON f.media_id = m.id
  WHERE m.id > ? ORDER BY m.id LIMIT ?`;
function sweepBatch(db, afterId, { limit = 500, maxRows = 2000 } = {}) {
  const stmt = db.prepare(SWEEP_SQL);
  const ids = [];
  let cursor = afterId || 0;
  let seen = 0;
  while (seen < maxRows) {
    const rows = stmt.all(cursor, limit);
    for (const r of rows) {
      if ((r.media_type === 'video' || r.media_type === 'audio') && !r.user_trashed
        && (r.version == null || r.version !== VERSION || r.src !== srcOf(r))) ids.push(r.id);
    }
    if (rows.length) cursor = rows[rows.length - 1].id;
    seen += rows.length;
    if (rows.length < limit) return { ids, cursor, done: true };
    if (ids.length) break;
  }
  return { ids, cursor, done: false };
}

module.exports = { ensureSchema, purgeWorkerFailures, save, encodeEnv, encodeEdges, currentFor, get, remove, srcOf, sweepBatch, SWEEP_SQL };
