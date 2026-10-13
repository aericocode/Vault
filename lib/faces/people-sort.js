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
 * (visible groups only, any media state). Held in memory in fixed-size
 * blocks (no growth copies): float32 sums for updates plus an int8 copy for
 * scoring, brute force over people (the spike: ~10 M dots/s per thread),
 * about 650 bytes per person. The cache is rebuilt when anything outside
 * this job changed who is in which person (store.peopleVersion moved), and
 * dropped on vault lock.
 *
 * "Not this person" (reassign) goes through the job: the faces leave the
 * person and are sorted again at once with that person excluded, so they
 * join another person at >= 0.50 or start a new one, and several faces of
 * one person in that file land together.
 *
 * Unclear faces (norm below startNorm, models.js; quality experiment 2) may
 * join a person but never start one: they stay unsorted, marked sort_held
 * (searchable, shown on their file, not in the Faces grid). At the end of a
 * run held faces are tried again against the people that appeared since
 * (fresh: started by the job, or made by the user from faces). Faces with no
 * norm on record (found before norms were kept) sort as before.
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
const BLOCK = 1024;          // people per centroid block
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

/**
 * Person centroids for one model. Storage grows a block at a time, so adding
 * people never copies what is already there.
 */
function createCentroids() {
  const blocks = [];   // { pids: Int32Array, counts: Int32Array, sums: Float32Array, q: Int8Array }
  let n = 0;
  const slot = new Map();   // pid -> slot index
  const at = (i) => blocks[(i / BLOCK) | 0];
  function requantize(b, j) {
    const off = j * DIM;
    let s = 0;
    for (let k = 0; k < DIM; k++) s += b.sums[off + k] * b.sums[off + k];
    s = Math.sqrt(s) || 1;
    for (let k = 0; k < DIM; k++) {
      const v = Math.round((b.sums[off + k] / s) * Q);
      b.q[off + k] = v > Q ? Q : (v < -Q ? -Q : v);
    }
  }
  /** Add a group vector to a person (creating its slot). */
  function add(pid, vec, { requant = true } = {}) {
    let i = slot.get(pid);
    if (i === undefined) {
      if (n === blocks.length * BLOCK) {
        blocks.push({ pids: new Int32Array(BLOCK).fill(-1), counts: new Int32Array(BLOCK),
          sums: new Float32Array(BLOCK * DIM), q: new Int8Array(BLOCK * DIM) });
      }
      i = n++;
      at(i).pids[i % BLOCK] = pid;
      slot.set(pid, i);
    }
    const b = at(i), j = i % BLOCK, off = j * DIM;
    for (let k = 0; k < DIM; k++) b.sums[off + k] += vec[k];
    b.counts[j]++;
    if (requant) requantize(b, j);
  }
  /** Take a group vector out of a person; a person left with nothing is dropped. */
  function sub(pid, vec) {
    const i = slot.get(pid);
    if (i === undefined) return;
    const b = at(i), j = i % BLOCK, off = j * DIM;
    if (--b.counts[j] <= 0) {
      b.pids[j] = -1;
      b.sums.fill(0, off, off + DIM);
      b.q.fill(0, off, off + DIM);
      slot.delete(pid);
      return;
    }
    for (let k = 0; k < DIM; k++) b.sums[off + k] -= vec[k];
    requantize(b, j);
  }
  function finish() { for (let i = 0; i < n; i++) requantize(at(i), i % BLOCK); }
  /**
   * Best person for a quantized query, skipping `skip` (Set of pids).
   * @returns {{ pid: number|null, score: number }}
   */
  function best(gq, skip) {
    let bp = null, bs = -Infinity;
    const useSkip = !!(skip && skip.size);
    for (let bi = 0; bi < blocks.length; bi++) {
      const { pids, q } = blocks[bi];
      const m = Math.min(BLOCK, n - bi * BLOCK);
      for (let j = 0; j < m; j++) {
        const pid = pids[j];
        if (pid < 0 || (useSkip && skip.has(pid))) continue;
        const off = j * DIM;
        let d = 0;
        for (let k = 0; k < DIM; k++) d += gq[k] * q[off + k];
        if (d > bs) { bs = d; bp = pid; }
      }
    }
    return bp == null ? { pid: null, score: -1 } : { pid: bp, score: bs / SCALE };
  }
  function queryOf(pid) {
    const i = slot.get(pid);
    if (i === undefined) return null;
    const j = i % BLOCK;
    return at(i).q.subarray(j * DIM, (j + 1) * DIM);
  }
  /** Bytes held in typed arrays. */
  function bytes() { return blocks.length * BLOCK * (4 + 4 + DIM * 4 + DIM); }
  return { add, sub, finish, best, queryOf, bytes, has: (pid) => slot.has(pid), size: () => slot.size };
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
  debounceMs = 1500, retryMs = 5000, sliceMs = 20, now = Date.now,
} = {}) {
  let timer = null;
  let running = null;
  let again = false;
  let token = 0;          // bumped by suspend/cancel: a running job stops at its next slice
  let cache = null;       // { pv, models: Map<model, centroids> }
  const dirty = new Set();
  let lastError = null;
  // Faces a user just took out of a person ("Not this person"): sorted first,
  // and the request waits for them (waiters).
  const priority = new Set();
  const results = new Map();   // group id -> { personId, newPerson }
  let waiters = [];            // { ids: number[], resolve }
  const fresh = new Set();     // people started since held faces were last retried
  let heldPass = null;         // { targets: number[], after: group id } while retrying held faces

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
    let outcome = 'early';
    running = run(my)
      .then((o) => { outcome = o; })
      .catch((err) => {
        if (err === ABORT) return;
        if (isVaultLocked()) return;
        lastError = err && err.message;
        console.warn(`[Faces] sorting people stopped: ${err && err.stack ? err.stack : err}`);
      })
      .finally(() => {
        running = null;
        const more = again && my === token;
        again = false;
        if (priority.size && outcome === 'done' && my === token) { start(); return; }   // asked for during the run's tail
        // Stopped (lock, migrate, off) or finished: nobody waits forever. The
        // faces stay unsorted and the next run sorts them normally.
        priority.clear();
        flushWaiters();
        if (more) schedule();
      });
    return running;
  }

  function settleWaiters() {
    waiters = waiters.filter((w) => {
      if (w.ids.some(id => !results.has(id))) return true;
      w.resolve(w.ids.map(id => ({ groupId: id, ...results.get(id) })));
      for (const id of w.ids) results.delete(id);
      return false;
    });
  }
  function flushWaiters() {
    for (const w of waiters) {
      w.resolve(w.ids.map(id => ({ groupId: id, personId: null, newPerson: false, ...results.get(id) })));
      for (const id of w.ids) results.delete(id);
    }
    waiters = [];
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
  /** New people held faces should be tried against (e.g. one the user made from faces). */
  function markFresh(ids) { for (const id of ids || []) if (Number.isInteger(id)) fresh.add(id); }

  /** Vault locked or face data wiped: stop at the next slice, forget every vector. */
  function suspend() {
    token++;
    clearTimer();
    again = false;
    cache = null;
    heldPass = null;
    priority.clear();
    flushWaiters();
  }
  const cancel = suspend;
  async function settled() { while (running) await running; }

  const yieldTurn = () => new Promise((r) => setImmediate(r));

  async function run(my) {
    if (!enabled() || isVaultLocked()) return 'early';
    if (isMigrateRunning()) { schedule(retryMs); return 'early'; }
    const db = database.get();
    const check = async () => {
      await yieldTurn();
      if (my !== token || isVaultLocked() || !enabled()) throw ABORT;
      if (isMigrateRunning()) { schedule(retryMs); throw ABORT; }
    };

    // 1. Sort unsorted groups (faces a user just moved first).
    for (;;) {
      await check();
      if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
      if (!assignSlice(db) && !priority.size) break;
    }
    // 1b. Held (unclear) faces against the people that appeared meanwhile.
    while (fresh.size || heldPass) {
      await check();
      if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
      heldSlice(db);
    }
    // 2. Re-score people a merge or split changed.
    while (dirty.size) {
      await check();
      if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
      dirtySlice(db);
    }
    trimSuggestions(db);
    return 'done';
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
    if (a === b || hasDecision(db, a, b)) return false;
    db.prepare(`INSERT INTO face_person_suggestions (a, b, score) VALUES (?, ?, ?)
      ON CONFLICT(a, b) DO UPDATE SET score = excluded.score`).run(Math.min(a, b), Math.max(a, b), Math.round(score * 10000) / 10000);
    return true;
  }

  const isHiddenPerson = (db, pid) => !!db.prepare('SELECT hidden FROM face_people WHERE id = ?').get(pid)?.hidden;

  /**
   * Sort these unsorted groups (rows { id, model, hidden }) into people.
   * Inside the caller's transaction. Stops early when `deadline` passes.
   * @returns {{ done: number, suggested: number }}
   */
  function assignRows(db, rows, stamp, deadline = Infinity) {
    let done = 0, suggested = 0;
    if (!rows.length) return { done, suggested };
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
    const insP = db.prepare('INSERT INTO face_people (created_at, updated_at) VALUES (?, ?)');
    const setG = db.prepare('UPDATE face_groups SET cluster_id = ?, sort_held = 0 WHERE id = ? AND cluster_id IS NULL');
    const hold = db.prepare('UPDATE face_groups SET sort_held = 1 WHERE id = ? AND cluster_id IS NULL');
    const gq = new Int8Array(DIM);
    for (const r of rows) {
      const list = vecs.get(r.id);
      const th = peopleThresholds(r.model);
      let pid, created = false;
      if (!list || !list.length) {
        // No vectors (should not happen): its own person, never compared.
        pid = Number(insP.run(stamp, stamp).lastInsertRowid);
        created = true;
      } else {
        const gv = meanOf(list);
        quantizeInto(gv, gq, 0);
        const c = centroidsFor(r.model);
        const best = c.best(gq, rejects.get(r.id));
        if (best.pid != null && best.score >= th.people) {
          pid = best.pid;
        } else if (r.norm != null && r.norm < th.startNorm) {
          // Unclear face: never the start of a person. Stays unsorted (held).
          hold.run(r.id);
          if (priority.delete(r.id)) results.set(r.id, { personId: null, newPerson: false });
          done++;
          if (now() >= deadline) break;
          continue;
        } else {
          pid = Number(insP.run(stamp, stamp).lastInsertRowid);
          created = true;
          if (!r.hidden) fresh.add(pid);
          // Hidden people are never part of a "Same person?" question.
          if (best.pid != null && best.score >= th.suggest && !r.hidden && !isHiddenPerson(db, best.pid)) {
            if (putSuggestion(db, pid, best.pid, best.score)) suggested++;
          }
        }
        if (!r.hidden) c.add(pid, gv);   // hidden faces never shape a centroid
      }
      setG.run(pid, r.id);
      if (priority.delete(r.id)) results.set(r.id, { personId: pid, newPerson: created });
      done++;
      if (now() >= deadline) break;
    }
    return { done, suggested };
  }

  function priorityRows(db) {
    const ids = [...priority];
    const rows = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      rows.push(...db.prepare(`SELECT id, model, hidden, norm FROM face_groups WHERE cluster_id IS NULL AND id IN (${chunk.map(() => '?').join(',')})
        ORDER BY det_score DESC, id`).all(...chunk));
    }
    // Gone or already sorted meanwhile: report where they are now.
    const found = new Set(rows.map(r => r.id));
    for (const id of ids) {
      if (found.has(id)) continue;
      priority.delete(id);
      const g = db.prepare('SELECT cluster_id FROM face_groups WHERE id = ?').get(id);
      results.set(id, { personId: g ? g.cluster_id : null, newPerson: false });
    }
    return rows;
  }

  /** One slice of assignment. @returns {number} groups sorted (0 = nothing left) */
  function assignSlice(db) {
    const t0 = now();
    let done = 0, suggested = 0, user = false;
    const stamp = new Date(now()).toISOString();
    db.transaction(() => {
      if (priority.size) {
        const r = assignRows(db, priorityRows(db), stamp);
        done += r.done; suggested += r.suggested; user = true;
      }
      // The partial index keeps this a walk, not a sort of every unsorted face.
      const fetch = db.prepare(`SELECT id, model, hidden, norm FROM face_groups INDEXED BY idx_face_groups_unsorted2
        WHERE cluster_id IS NULL AND hidden = 0 AND sort_held = 0 ORDER BY det_score DESC, id LIMIT ${FETCH}`);
      while (now() - t0 < sliceMs) {
        const rows = fetch.all();
        if (!rows.length) break;
        const r = assignRows(db, rows, stamp, t0 + sliceMs);
        done += r.done; suggested += r.suggested;
      }
    })();
    if (done) {
      // The job's own writes reach the people stats within a few seconds;
      // faces a user moved count as the user's write.
      store.bumpPeople({ background: !user });
      cache.pv = store.peopleVersion();
    }
    if (suggested) trimSuggestions(db);   // also when the run stops before its end
    settleWaiters();
    return done;
  }

  /**
   * One slice of retrying held faces (a page at a time, by id) against the
   * people in heldPass.targets: a held face joins the best of them at
   * >= people (rejects respected). Ends the pass when the walk is done.
   */
  function heldSlice(db) {
    if (!heldPass) {
      heldPass = { targets: [...fresh], after: 0 };
      fresh.clear();
    }
    const t0 = now();
    let joined = 0;
    const page = db.prepare(`SELECT id, model FROM face_groups INDEXED BY idx_face_groups_held
      WHERE sort_held = 1 AND cluster_id IS NULL AND hidden = 0 AND id > ? ORDER BY id LIMIT ${FETCH}`);
    const setG = db.prepare('UPDATE face_groups SET cluster_id = ?, sort_held = 0 WHERE id = ? AND cluster_id IS NULL');
    const gq = new Int8Array(DIM);
    db.transaction(() => {
      while (heldPass && now() - t0 < sliceMs) {
        const rows = page.all(heldPass.after);
        if (!rows.length) { heldPass = null; break; }
        heldPass.after = rows[rows.length - 1].id;
        const ids = rows.map(r => r.id), ph = ids.map(() => '?').join(',');
        const vecs = new Map(), rejects = new Map();
        for (const r of db.prepare(`SELECT group_id, embedding FROM face_vectors WHERE group_id IN (${ph}) ORDER BY id`).all(...ids)) {
          if (!vecs.has(r.group_id)) vecs.set(r.group_id, []);
          vecs.get(r.group_id).push(store.decodeEmbedding(r.embedding));
        }
        for (const r of db.prepare(`SELECT person_id, group_id FROM face_person_rejects WHERE group_id IN (${ph})`).all(...ids)) {
          if (!rejects.has(r.group_id)) rejects.set(r.group_id, new Set());
          rejects.get(r.group_id).add(r.person_id);
        }
        for (const r of rows) {
          const list = vecs.get(r.id);
          const c = cache.models.get(r.model);
          if (!list || !list.length || !c) continue;
          const gv = meanOf(list);
          quantizeInto(gv, gq, 0);
          const skip = rejects.get(r.id);
          let bp = null, bs = -Infinity;
          for (const pid of heldPass.targets) {
            if (skip && skip.has(pid)) continue;
            const q = c.queryOf(pid);
            if (!q) continue;
            let d = 0;
            for (let k = 0; k < DIM; k++) d += gq[k] * q[k];
            if (d > bs) { bs = d; bp = pid; }
          }
          if (bp != null && bs / SCALE >= peopleThresholds(r.model).people && setG.run(bp, r.id).changes) {
            c.add(bp, gv);
            joined++;
          }
        }
      }
    })();
    if (joined) {
      store.bumpPeople({ background: true });
      cache.pv = store.peopleVersion();
    }
  }

  /**
   * "Not this person": take these faces out of person `fromPid`
   * (detach(db) does the database part and records the rejects), then sort
   * them again with that person excluded. With a current cache this happens
   * in the same transaction; otherwise the job runs now and the call waits.
   * @returns {Promise<[{ groupId, personId, newPerson }]>}
   */
  async function reassign(fromPid, groupIds, detach) {
    const db = database.get();
    const waiter = new Promise((resolve) => waiters.push({ ids: groupIds.slice(), resolve }));
    if (cache && cache.pv === store.peopleVersion()) {
      try {
        const stamp = new Date(now()).toISOString();
        db.transaction(() => {
          const rows = groupIds.map(id => db.prepare('SELECT id, model, hidden, cluster_id FROM face_groups WHERE id = ?').get(id))
            .filter(r => r && r.cluster_id === fromPid);
          for (const r of rows) {
            if (r.hidden) continue;
            const vecs = db.prepare('SELECT embedding FROM face_vectors WHERE group_id = ? ORDER BY id').all(r.id).map(x => store.decodeEmbedding(x.embedding));
            if (vecs.length) centroidsFor(r.model).sub(fromPid, meanOf(vecs));
          }
          detach(db);
          for (const id of groupIds) priority.add(id);
          assignRows(db, priorityRows(db), stamp);
        })();
      } catch (err) {
        cache = null;   // the transaction rolled back: the centroids no longer match
        priority.clear();
        flushWaiters();
        throw err;
      }
      store.bumpPeople();
      cache.pv = store.peopleVersion();
      settleWaiters();
      trimSuggestions(db);
    } else {
      db.transaction(() => detach(db))();
      store.bumpPeople();
      for (const id of groupIds) priority.add(id);
      clearTimer();
      start();
    }
    return waiter;
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
          // Pairs of two named people are never asked about, nor hidden people.
          const other = db.prepare('SELECT name, hidden FROM face_people WHERE id = ?').get(best.pid);
          if (!other || other.hidden || (row.name != null && other.name != null)) continue;
          putSuggestion(db, pid, best.pid, best.score);
        }
        if (now() - t0 >= sliceMs) break;
      }
    })();
    if (wrote) {
      store.bumpPeople({ background: true });
      if (cache) cache.pv = store.peopleVersion();
    }
    trimSuggestions(db);
  }

  function trimSuggestions(db) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM face_person_suggestions').get().n;
    if (n <= MAX_SUGGESTIONS) return;
    db.prepare(`DELETE FROM face_person_suggestions WHERE rowid NOT IN
      (SELECT rowid FROM face_person_suggestions ORDER BY score DESC LIMIT ${MAX_SUGGESTIONS})`).run();
    store.bumpPeople({ background: true });
    if (cache) cache.pv = store.peopleVersion();
  }

  /** Unsorted visible groups (what the job still has to do). */
  function pending() {
    try {
      return database.get().prepare('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id IS NULL AND hidden = 0 AND sort_held = 0').get().n;
    } catch { return 0; }
  }

  return {
    schedule, runNow, markDirty, markFresh, suspend, cancel, settled, pending, reassign,
    isRunning: () => !!running,
    /** Bytes the centroid cache holds in typed arrays (0 when not built). */
    cacheBytes: () => (cache ? [...cache.models.values()].reduce((a, c) => a + c.bytes(), 0) : 0),
    cachePeople: () => (cache ? [...cache.models.values()].reduce((a, c) => a + c.size(), 0) : 0),
    lastError: () => lastError,
    _cache: () => cache,
  };
}

module.exports = { createSorter, createCentroids, meanOf, MAX_SUGGESTIONS };
