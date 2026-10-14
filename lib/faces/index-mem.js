/**
 * In-memory face search index (FACES_BUILD_SPEC section 4).
 *
 * Brute force over every visible exemplar vector of a model, built lazily on
 * the first query of that model and rebuilt after any write (store.version()
 * moves). Vectors are quantized to Int8 (round(v * 127)) in one contiguous
 * Int8Array with parallel Int32Arrays of group and media ids: 1M vectors is
 * 128 MB at 128-d (SFace-keeper libraries), 512 MB at 512-d (AdaFace
 * keepers). The dimension comes from the model (models.js embedDim) or the
 * stored vectors; nothing here assumes one. Dot products run in integers,
 * score = dot / (127 * 127).
 *
 * Model switch (model-switch.js): a model's index holds the vectors of every
 * group currently in that model (face_vectors) plus, marked stale, that
 * model's vectors still waiting in face_vectors_prev for groups that already
 * moved to another model. queryMulti() takes the query face in one or more
 * models; each file is scored in its CURRENT model when the query has a
 * vector there, else in any model the query and the file both have. So old
 * vectors keep serving search until each file is re-read, and a query face
 * found only in the old model still finds files already switched.
 *
 * Trashed media are excluded at query time (one SQL check over the candidate
 * ids), so trashing and restoring never forces a rebuild.
 */

const database = require('../database');
const store = require('./store');
const { embedDim } = require('./models');

const Q = 127;
const SCALE = Q * Q;
const DEFAULT_CAP = 5000;
const SQL_CHUNK = 500;

function quantize(vec, out = new Int8Array(vec.length), offset = 0) {
  const n = vec.length;
  for (let i = 0; i < n; i++) {
    const q = Math.round(vec[i] * Q);
    out[offset + i] = q > Q ? Q : (q < -Q ? -Q : q);
  }
  return out;
}

function createIndex({ getDb = () => database.get(), version = store.version, cap = DEFAULT_CAP } = {}) {
  const built = new Map();   // modelId -> { version, modelId, dim, n, vecs, gids, mids, cur: Uint8Array, gmodel: string[] }

  function build(modelId) {
    const db = getDb();
    const v = version();
    const cur = 'FROM face_vectors v JOIN face_groups g ON g.id = v.group_id WHERE g.hidden = 0 AND g.model = ?';
    const stale = 'FROM face_vectors_prev p JOIN face_groups g ON g.id = p.group_id WHERE g.hidden = 0 AND p.model = ? AND g.model <> ?';
    const nCur = db.prepare(`SELECT COUNT(*) AS n ${cur}`).get(modelId).n;
    let nStale = 0;
    try { nStale = db.prepare(`SELECT COUNT(*) AS n ${stale}`).get(modelId, modelId).n; } catch { /* table missing (old test DBs) */ }
    const n = nCur + nStale;
    let dim = embedDim(modelId);
    if (!dim && n) {
      const first = db.prepare(`SELECT v.embedding AS e ${cur} LIMIT 1`).get(modelId);
      dim = first ? first.e.length / 4 : 0;
    }
    const vecs = new Int8Array(n * dim);
    const gids = new Int32Array(n);
    const mids = new Int32Array(n);
    const curFlag = new Uint8Array(n);
    const codes = [];               // stale entries: the group's current model, by code
    const gcode = new Uint8Array(n);
    let i = 0;
    const take = (r, isCur) => {
      if (i >= n) return;
      const f = store.decodeEmbedding(r.e);
      if (f.length !== dim) return;
      quantize(f, vecs, i * dim);
      gids[i] = r.g;
      mids[i] = r.m;
      curFlag[i] = isCur ? 1 : 0;
      if (!isCur) {
        let c = codes.indexOf(r.gm);
        if (c < 0) { codes.push(r.gm); c = codes.length - 1; }
        gcode[i] = c;
      }
      i++;
    };
    for (const r of db.prepare(`SELECT v.embedding AS e, v.group_id AS g, v.media_id AS m ${cur}`).iterate(modelId)) take(r, true);
    if (nStale) {
      for (const r of db.prepare(`SELECT p.embedding AS e, p.group_id AS g, p.media_id AS m, g.model AS gm ${stale}`).iterate(modelId, modelId)) take(r, false);
    }
    const idx = { version: v, modelId, dim, n: i, vecs, gids, mids, cur: curFlag, gcode, codes };
    built.set(modelId, idx);
    return idx;
  }

  function ensure(modelId) {
    const b = built.get(modelId);
    if (b && b.version === version()) return b;
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
   * Search one or more models at once.
   * @param {{ modelId: string, vecs: ArrayLike<number>[], threshold: number }[]} parts
   *   the query face's vectors (1 to 3 L2-normalized) and the minimum cosine, per model
   * @param {object} [opts]
   * @param {boolean} [opts.withGroups] also return groupIds (the face group whose
   *   vector gave each file its score) and models (which model scored it)
   * @returns {{ids:number[], scores:number[], total:number, capped:boolean, groupIds?:number[], models?:string[]}}
   *   Files rank by how far their score clears its model's threshold (scores of
   *   two models are not on one scale); scores are the raw cosines.
   */
  function queryMulti(parts, { withGroups = false } = {}) {
    const covered = new Set(parts.filter(p => p.vecs && p.vecs.length).map(p => p.modelId));
    // A model no query asks for any more (a finished switch) gives its memory back.
    for (const k of [...built.keys()]) if (!covered.has(k)) built.delete(k);
    const best = new Map();   // media id -> { margin, score, gid, model }
    for (const { modelId, vecs: queryVecs, threshold } of parts) {
      if (!covered.has(modelId)) continue;
      const idx = ensure(modelId);
      const qs = queryVecs.filter(q => q && q.length === idx.dim).map(q => quantize(q));
      if (!qs.length || !idx.n) continue;
      const { vecs, mids, gids, n, dim, cur, gcode, codes } = idx;
      const skipCode = codes.map(c => covered.has(c));   // stale entries whose file the query scores in its current model
      const minDot = threshold * SCALE;
      for (let i = 0; i < n; i++) {
        if (!cur[i] && skipCode[gcode[i]]) continue;
        const off = i * dim;
        let top = -Infinity;
        for (const q of qs) {
          let dot = 0;
          for (let k = 0; k < dim; k++) dot += q[k] * vecs[off + k];
          if (dot > top) top = dot;
        }
        if (top < minDot) continue;
        const m = mids[i];
        const score = top / SCALE, margin = score - threshold;
        const prev = best.get(m);
        if (!prev || margin > prev.margin || (margin === prev.margin && gids[i] < prev.gid)) {
          best.set(m, { margin, score, gid: gids[i], model: modelId });
        }
      }
    }
    let ids = [...best.keys()];
    if (ids.length) {
      const trashed = trashedAmong(ids);
      if (trashed.size) ids = ids.filter(id => !trashed.has(id));
    }
    ids.sort((a, b) => (best.get(b).margin - best.get(a).margin) || (a - b));
    const total = ids.length;
    const kept = ids.slice(0, cap);
    const out = {
      ids: kept,
      // int8 rounding can put a perfect match a hair above 1
      scores: kept.map(id => Math.min(1, Math.round(best.get(id).score * 10000) / 10000)),
      total,
      capped: total > cap,
    };
    if (withGroups) {
      out.groupIds = kept.map(id => best.get(id).gid);
      out.models = kept.map(id => best.get(id).model);
    }
    return out;
  }

  /**
   * One model (the original form).
   * @param {ArrayLike<number>[]} queryVecs 1 to 3 L2-normalized embeddings
   * @param {number} threshold minimum cosine
   * @param {string} modelId only vectors of this model are searched
   */
  function query(queryVecs, threshold, modelId, opts = {}) {
    const out = queryMulti([{ modelId, vecs: queryVecs, threshold }], opts);
    if (out.models) delete out.models;
    return out;
  }

  function reset() { built.clear(); }

  function stats() {
    const all = [...built.values()];
    const out = {
      built: all.length > 0,
      vectors: all.reduce((s, b) => s + b.n, 0),
      modelId: all.length ? all[all.length - 1].modelId : null,
    };
    if (all.length) out.models = all.map(b => ({ modelId: b.modelId, dim: b.dim, vectors: b.n }));
    return out;
  }

  return { query, queryMulti, reset, stats, ensure };
}

module.exports = { createIndex, quantize, DEFAULT_CAP };
