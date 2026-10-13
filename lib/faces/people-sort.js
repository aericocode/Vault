/**
 * Sorting faces into people: the background job (FACES_PEOPLE_SPEC sections
 * 2 and 9).
 *
 * v1 is incremental assignment only (the clustering spike measured it equal
 * to a full recluster): every unsorted, visible face group, best detection
 * score first, is scored against every person's centroid and joins the best
 * one at cosine >= people (0.50), else starts a new unnamed person. A group
 * is never scored against a person it was rejected from ("Not this person").
 * Already sorted groups never move, so user work (names, merges, splits) is
 * never undone; named people are never merged automatically.
 *
 * Centroids: a group's vector is the normalised mean of its exemplars; a
 * person's centroid is the normalised running sum of its groups' vectors
 * (visible groups only, any media state). Held in memory as int8, brute
 * force over people (the spike: ~10 M dots/s per thread). The cache is
 * rebuilt when anything outside this job changed people data
 * (store.peopleVersion moved), and dropped on vault lock.
 *
 * "Same person?" suggestions: when a group starts a new person, its best
 * other person in [suggest, people) is stored as a pair. People changed by a
 * merge or a split are re-scored against everyone (pairs >= suggest), minus
 * 'different' answers and rejects. At most MAX_SUGGESTIONS rows are kept.
 *
 * Runs debounced after any face write, in synchronous slices of ~sliceMs with
 * an event-loop yield between them (a slice computes and writes atomically,
 * so nothing interleaves inside one). Before every slice it re-checks the
 * lock generation, the feature switch and the migrate probe: a lock or a
 * cancel stops it with nothing more written; a migrate defers it.
 */

const { peopleThresholds } = require('./thresholds');

const DIM = 128;
const Q = 127;
const SCALE = Q * Q;
const FETCH = 64;
const BUILD_PAGE = 1000;
const MAX_SUGGESTIONS = 2000;
const ABORT = Symbol('people-sort-abort');

function quantizeInto(vec, out, off) {
  for (let i = 0; i < DIM; i++) {
    const q = Math.round(vec[i] * Q);
    out[off + i] = q > Q ? Q : (q < -Q ? -Q : q);
  }
}

function meanOf(vecs) {
  const out = new Float32Array(DIM);
  for (const v of vecs) for (let i = 0; i < DIM; i++) out[i] += v[i];
  let s = 0;
  for (let i = 0; i < DIM; i++) s += out[i] * out[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < DIM; i++) out[i] /= s;
  return out;
}

/** Person centroids for one model, int8 for scoring plus float sums for updates. */
function createCentroids() {
  let cap = 64, n = 0;
  let pids = new Int32Array(cap);
  let sums = new Float64Array(cap * DIM);
  let q = new Int8Array(cap * DIM);
  const slot = new Map();
  function grow() {
    cap *= 2;
    const p2 = new Int32Array(cap); p2.set(pids); pids = p2;
    const s2 = new Float64Array(cap * DIM); s2.set(sums); sums = s2;
    const q2 = new Int8Array(cap * DIM); q2.set(q); q = q2;
  }
  function requantize(i) {
    const off = i * DIM;
    let s = 0;
    for (let k = 0; k < DIM; k++) s += sums[off + k] * sums[off + k];
    s = Math.sqrt(s) || 1;
    for (let k = 0; k < DIM; k++) {
      const v = Math.round((sums[off + k] / s) * Q);
      q[off + k] = v > Q ? Q : (v < -Q ? -Q : v);
    }
  }
  /** Add a group vector to a person (creating its slot). */
  function add(pid, vec, { requant = true } = {}) {
    let i = slot.get(pid);
    if (i === undefined) {
      if (n === cap) grow();
      i = n++;
      pids[i] = pid;
      slot.set(pid, i);
    }
    const off = i * DIM;
    for (let k = 0; k < DIM; k++) sums[off + k] += vec[k];
    if (requant) requantize(i);
  }
  function finish() { for (let i = 0; i < n; i++) requantize(i); }
  /**
   * Best person for a quantized query, skipping `skip` (Set of pids).
   * @returns {{ pid: number|null, score: number }}
   */
  function best(gq, skip) {
    let bi = -1, bs = -Infinity;
    for (let i = 0; i < n; i++) {
      if (skip && skip.size && skip.has(pids[i])) continue;
      const off = i * DIM;
      let d = 0;
      for (let k = 0; k < DIM; k++) d += gq[k] * q[off + k];
      if (d > bs) { bs = d; bi = i; }
    }
    return bi < 0 ? { pid: null, score: -1 } : { pid: pids[bi], score: bs / SCALE };
  }
  function queryOf(pid) {
    const i = slot.get(pid);
    return i === undefined ? null : q.subarray(i * DIM, (i + 1) * DIM);
  }
  return { add, finish, best, queryOf, has: (pid) => slot.has(pid), size: () => n };
}

/**
 * @param {object} deps
 *   database, store            the usual modules
 *   enabled()                  feature switch
 *   isVaultLocked(), isMigrateRunning()
 *   debounceMs, retryMs, sliceMs, now
 */
function createSorter({
  database, store, enabled = () => true, isVaultLocked = () => false, isMigrateRunning = () => false,
  debounceMs = 1500, retryMs = 5000, sliceMs = 40, now = Date.now,
} = {}) {
  let timer = null;
  let running = null;
  let again = false;
  let token = 0;          // bumped by suspend/cancel: a running job stops at its next slice
  let cache = null;       // { pv, models: Map<model, centroids> }
  const dirty = new Set();
  let lastError = null;

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

  /** Run soon (debounced). Several calls within the window make one run. */
  function schedule(delay = debounceMs) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; start(); }, delay);
    if (timer.unref) timer.unref();
  }

  function start() {
    if (running) { again = true; return running; }
    const my = token;
    running = run(my)
      .catch((err) => {
        if (err === ABORT) return;
        if (isVaultLocked()) return;
        lastError = err && err.message;
        console.warn(`[Faces] sorting people stopped: ${err && err.stack ? err.stack : err}`);
      })
      .finally(() => {
        running = null;
        if (again && my === token) { again = false; schedule(); }
        again = false;
      });
    return running;
  }

  /** Run now and resolve when it (and any run it queued) finished. Tests. */
  async function runNow() {
    for (let i = 0; i < 5; i++) {
      clearTimer();
      await start();
      if (!timer || isMigrateRunning()) return;
    }
  }

  function markDirty(ids) { for (const id of ids || []) if (Number.isInteger(id)) dirty.add(id); }

  /** Vault locked or face data wiped: stop at the next slice, forget every vector. */
  function suspend() {
    token++;
    clearTimer();
    again = false;
    cache = null;
  }
  const cancel = suspend;
  async function settled() { while (running) await running; }

  const yieldTurn = () => new Promise((r) => setImmediate(r));

  async function run(my) {
    if (!enabled() || isVaultLocked()) return;
    if (isMigrateRunning()) { schedule(retryMs); return; }
    const db = database.get();
    const check = async () => {
      await yieldTurn();
      if (my !== token || isVaultLocked() || !enabled()) throw ABORT;
      if (isMigrateRunning()) { schedule(retryMs); throw ABORT; }
    };

    // 1. Sort unsorted groups.
    for (;;) {
      await check();
      if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
      if (!assignSlice(db)) break;
    }
    // 2. Re-score people a merge or split changed.
    while (dirty.size) {
      await check();
      if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
      dirtySlice(db);
    }
    trimSuggestions(db);
  }

  /** Rebuild every model's centroids from the DB, a page of groups per slice. */
  async function build(db, check) {
    const pv = store.peopleVersion();
    const models = new Map();
    let after = 0;
    for (;;) {
      const t0 = now();
      let rows;
      do {
        rows = db.prepare(`SELECT g.id, g.model, g.cluster_id, v.embedding FROM face_groups g
          JOIN face_vectors v ON v.group_id = g.id
          WHERE g.id IN (SELECT id FROM face_groups WHERE cluster_id IS NOT NULL AND hidden = 0 AND id > ? ORDER BY id LIMIT ${BUILD_PAGE})
          ORDER BY g.id, v.id`).all(after);
        let i = 0;
        while (i < rows.length) {
          const g = rows[i];
          const vecs = [];
          while (i < rows.length && rows[i].id === g.id) { vecs.push(store.decodeEmbedding(rows[i].embedding)); i++; }
          let c = models.get(g.model);
          if (!c) { c = createCentroids(); models.set(g.model, c); }
          c.add(g.cluster_id, meanOf(vecs), { requant: false });
          after = g.id;
        }
      } while (rows.length && now() - t0 < sliceMs);
      if (!rows.length) break;
      await check();
      if (store.peopleVersion() !== pv) return build(db, check);   // changed under us: start over
    }
    for (const c of models.values()) c.finish();
    cache = { pv, models };
  }

  function centroidsFor(model) {
    let c = cache.models.get(model);
    if (!c) { c = createCentroids(); cache.models.set(model, c); }
    return c;
  }

  function hasDecision(db, a, b) {
    return !!db.prepare('SELECT 1 FROM face_pair_decisions WHERE a = ? AND b = ?').get(Math.min(a, b), Math.max(a, b));
  }

  function putSuggestion(db, a, b, score) {
    if (a === b || hasDecision(db, a, b)) return;
    db.prepare(`INSERT INTO face_person_suggestions (a, b, score) VALUES (?, ?, ?)
      ON CONFLICT(a, b) DO UPDATE SET score = excluded.score`).run(Math.min(a, b), Math.max(a, b), Math.round(score * 10000) / 10000);
  }

  /** One slice of assignment. @returns {number} groups sorted (0 = nothing left) */
  function assignSlice(db) {
    const t0 = now();
    let done = 0;
    const stamp = new Date(now()).toISOString();
    db.transaction(() => {
      // The partial index keeps this a walk, not a sort of every unsorted face.
      const fetch = db.prepare(`SELECT id, model FROM face_groups INDEXED BY idx_face_groups_unsorted
        WHERE cluster_id IS NULL AND hidden = 0 ORDER BY det_score DESC, id LIMIT ${FETCH}`);
      const insP = db.prepare('INSERT INTO face_people (created_at, updated_at) VALUES (?, ?)');
      const setG = db.prepare('UPDATE face_groups SET cluster_id = ? WHERE id = ? AND cluster_id IS NULL');
      while (now() - t0 < sliceMs) {
        const rows = fetch.all();
        if (!rows.length) break;
        const ids = rows.map(r => r.id);
        const ph = ids.map(() => '?').join(',');
        const vecs = new Map(), rejects = new Map();
        for (const r of db.prepare(`SELECT group_id, embedding FROM face_vectors WHERE group_id IN (${ph}) ORDER BY id`).all(...ids)) {
          if (!vecs.has(r.group_id)) vecs.set(r.group_id, []);
          vecs.get(r.group_id).push(store.decodeEmbedding(r.embedding));
        }
        for (const r of db.prepare(`SELECT person_id, group_id FROM face_person_rejects WHERE group_id IN (${ph})`).all(...ids)) {
          if (!rejects.has(r.group_id)) rejects.set(r.group_id, new Set());
          rejects.get(r.group_id).add(r.person_id);
        }
        const gq = new Int8Array(DIM);
        for (const r of rows) {
          const list = vecs.get(r.id);
          const th = peopleThresholds(r.model);
          if (!list || !list.length) {
            // No vectors (should not happen): its own person, never compared.
            setG.run(Number(insP.run(stamp, stamp).lastInsertRowid), r.id);
            done++;
            continue;
          }
          const gv = meanOf(list);
          quantizeInto(gv, gq, 0);
          const c = centroidsFor(r.model);
          const best = c.best(gq, rejects.get(r.id));
          if (best.pid != null && best.score >= th.people) {
            setG.run(best.pid, r.id);
            c.add(best.pid, gv);
          } else {
            const pid = Number(insP.run(stamp, stamp).lastInsertRowid);
            setG.run(pid, r.id);
            c.add(pid, gv);
            if (best.pid != null && best.score >= th.suggest) putSuggestion(db, pid, best.pid, best.score);
          }
          done++;
          if (now() - t0 >= sliceMs) break;
        }
      }
    })();
    if (done) {
      store.bumpPeople();
      cache.pv = store.peopleVersion();
    }
    return done;
  }

  /** People a person must never be suggested with: 'different' answers and rejects either way. */
  function blockedFor(db, pid) {
    const out = new Set([pid]);
    for (const r of db.prepare('SELECT a, b FROM face_pair_decisions WHERE a = ? OR b = ?').all(pid, pid)) out.add(r.a === pid ? r.b : r.a);
    for (const r of db.prepare(`SELECT r.person_id AS p FROM face_person_rejects r JOIN face_groups g ON g.id = r.group_id
      WHERE g.cluster_id = ?`).all(pid)) out.add(r.p);
    for (const r of db.prepare(`SELECT DISTINCT g.cluster_id AS p FROM face_person_rejects r JOIN face_groups g ON g.id = r.group_id
      WHERE r.person_id = ? AND g.cluster_id IS NOT NULL`).all(pid)) out.add(r.p);
    return out;
  }

  /** Re-score changed people against everyone (a slice). */
  function dirtySlice(db) {
    const t0 = now();
    let wrote = false;
    db.transaction(() => {
      for (const pid of [...dirty]) {
        dirty.delete(pid);
        const row = db.prepare('SELECT name, hidden FROM face_people WHERE id = ?').get(pid);
        if (!row) continue;
        db.prepare('DELETE FROM face_person_suggestions WHERE a = ? OR b = ?').run(pid, pid);
        wrote = true;
        if (row.hidden) continue;
        for (const [model, c] of cache.models) {
          const gq = c.queryOf(pid);
          if (!gq) continue;
          const best = c.best(gq, blockedFor(db, pid));
          const th = peopleThresholds(model);
          if (best.pid == null || best.score < th.suggest) continue;
          // Pairs of two named people are never asked about.
          const other = db.prepare('SELECT name FROM face_people WHERE id = ?').get(best.pid);
          if (!other || (row.name != null && other.name != null)) continue;
          putSuggestion(db, pid, best.pid, best.score);
        }
        if (now() - t0 >= sliceMs) break;
      }
    })();
    if (wrote) {
      store.bumpPeople();
      if (cache) cache.pv = store.peopleVersion();
    }
  }

  function trimSuggestions(db) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM face_person_suggestions').get().n;
    if (n <= MAX_SUGGESTIONS) return;
    db.prepare(`DELETE FROM face_person_suggestions WHERE rowid NOT IN
      (SELECT rowid FROM face_person_suggestions ORDER BY score DESC LIMIT ${MAX_SUGGESTIONS})`).run();
    store.bumpPeople();
    if (cache) cache.pv = store.peopleVersion();
  }

  /** Unsorted visible groups (what the job still has to do). */
  function pending() {
    try {
      return database.get().prepare('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id IS NULL AND hidden = 0').get().n;
    } catch { return 0; }
  }

  return {
    schedule, runNow, markDirty, suspend, cancel, settled, pending,
    isRunning: () => !!running,
    lastError: () => lastError,
    _cache: () => cache,
  };
}

module.exports = { createSorter, createCentroids, meanOf };
