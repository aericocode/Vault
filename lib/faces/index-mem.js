/**
 * In-memory face search index (FACES_BUILD_SPEC section 4).
 *
 * Brute force over every visible exemplar vector of the current model, built
 * lazily on the first query and rebuilt after any write (store.version()
 * moves). Vectors are quantized to Int8 (round(v * 127)) in one contiguous
 * Int8Array with parallel Int32Arrays of group and media ids: 1M vectors is
 * 128 MB. Dot products run in integers, score = dot / (127 * 127).
 *
 * Trashed media are excluded at query time (one SQL check over the candidate
 * ids), so trashing and restoring never forces a rebuild.
 */

const database = require('../database');
const store = require('./store');

const DIM = store.EMBED_DIM;
const Q = 127;
const SCALE = Q * Q;
const DEFAULT_CAP = 5000;
const SQL_CHUNK = 500;

function quantize(vec, out = new Int8Array(DIM), offset = 0) {
  for (let i = 0; i < DIM; i++) {
    const q = Math.round(vec[i] * Q);
    out[offset + i] = q > Q ? Q : (q < -Q ? -Q : q);
  }
  return out;
}

function createIndex({ getDb = () => database.get(), version = store.version, cap = DEFAULT_CAP } = {}) {
  let built = null;   // { version, modelId, n, vecs: Int8Array, gids: Int32Array, mids: Int32Array }

  function build(modelId) {
    const db = getDb();
    const where = 'FROM face_vectors v JOIN face_groups g ON g.id = v.group_id WHERE g.hidden = 0 AND g.model = ?';
    const v = version();
    const n = db.prepare(`SELECT COUNT(*) AS n ${where}`).get(modelId).n;
    const vecs = new Int8Array(n * DIM);
    const gids = new Int32Array(n);
    const mids = new Int32Array(n);
    let i = 0;
    for (const r of db.prepare(`SELECT v.embedding AS e, v.group_id AS g, v.media_id AS m ${where}`).iterate(modelId)) {
      if (i >= n) break;
      const f = store.decodeEmbedding(r.e);
      if (f.length !== DIM) continue;
      quantize(f, vecs, i * DIM);
      gids[i] = r.g;
      mids[i] = r.m;
      i++;
    }
    built = { version: v, modelId, n: i, vecs, gids, mids };
    return built;
  }

  function ensure(modelId) {
    if (built && built.modelId === modelId && built.version === version()) return built;
    return build(modelId);
  }

  function trashedAmong(ids) {
    const db = getDb();
    const out = new Set();
    for (let i = 0; i < ids.length; i += SQL_CHUNK) {
      const chunk = ids.slice(i, i + SQL_CHUNK);
      for (const r of db.prepare(`SELECT id FROM media WHERE user_trashed = 1 AND id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        out.add(r.id);
      }
    }
    return out;
  }

  /**
   * @param {ArrayLike<number>[]} queryVecs 1 to 3 L2-normalized embeddings
   * @param {number} threshold minimum cosine
   * @param {string} modelId only vectors of this model are searched
   * @returns {{ids:number[], scores:number[], total:number, capped:boolean}}
   */
  function query(queryVecs, threshold, modelId) {
    const idx = ensure(modelId);
    const qs = queryVecs.filter(q => q && q.length === DIM).map(q => quantize(q));
    const best = new Map();
    if (qs.length && idx.n) {
      const { vecs, mids, n } = idx;
      const minDot = threshold * SCALE;
      for (let i = 0; i < n; i++) {
        const off = i * DIM;
        let top = -Infinity;
        for (const q of qs) {
          let dot = 0;
          for (let k = 0; k < DIM; k++) dot += q[k] * vecs[off + k];
          if (dot > top) top = dot;
        }
        if (top < minDot) continue;
        const m = mids[i];
        const prev = best.get(m);
        if (prev === undefined || top > prev) best.set(m, top);
      }
    }
    let ids = [...best.keys()];
    if (ids.length) {
      const trashed = trashedAmong(ids);
      if (trashed.size) ids = ids.filter(id => !trashed.has(id));
    }
    ids.sort((a, b) => (best.get(b) - best.get(a)) || (a - b));
    const total = ids.length;
    const kept = ids.slice(0, cap);
    return {
      ids: kept,
      scores: kept.map(id => Math.round((best.get(id) / SCALE) * 10000) / 10000),
      total,
      capped: total > cap,
    };
  }

  function reset() { built = null; }

  function stats() {
    return { built: !!built, vectors: built ? built.n : 0, modelId: built ? built.modelId : null };
  }

  return { query, reset, stats, ensure };
}

module.exports = { createIndex, quantize, DEFAULT_CAP };
