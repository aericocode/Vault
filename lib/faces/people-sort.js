/**
 * Sorting faces into people: the background job (FACES_PEOPLE_SPEC sections
 * 2 and 9).
 *
 * v1 is incremental assignment only (the clustering spike measured it equal
 * to a full recluster): every unsorted, visible face group, best detection
 * score first, is scored against every person's centroid and joins the best
 * one when the join rule says so (joinOk: cosine >= join, or joinNamed for a
 * named person, AND at least joinMargin above the second-best person;
 * models.js has the numbers and the measurements), else starts a new unnamed
 * person. A group is never scored against a person it was rejected from
 * ("Not this person"). Sorted groups never move on their own, so user work
 * (names, merges, splits) is never undone; named people are never merged
 * automatically.
 *
 * One-time re-check (FACES_REVIEW_SPEC A.4): when the join rule changes
 * (JOIN_RULE vs face_meta 'join_rule'), every face the job put in a person
 * (person_locked = 0: no user put it there, not a chosen cover, not hidden,
 * the person not hidden) is checked again against its person WITHOUT itself
 * (leave-one-out centroid) and the second-best other person. Faces that fail
 * go back out into their own unnamed person, remembering where they were
 * (face_groups.recheck_from), so "Might also be" offers them to that person
 * for one Yes. A named person's faces locked without a per-face decision
 * (face_groups.confirmed = 0: 3.7 locked every face of a person when it
 * was named) are never moved: a failing one is flagged (recheck_ask) and the
 * person page asks "Check N faces in X" (people.js answerToCheck). Walked by group id in slices like everything else, progress
 * in face_meta 'join_recheck' so a restart resumes; it only covers groups
 * that existed when it began (newer ones were sorted under the new rule).
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
 * join another person under the join rule or start a new one, and several faces of
 * one person in that file land together.
 *
 * Unclear faces (norm below startNorm, models.js; quality experiment 2) may
 * join a person but never start one: they stay unsorted, marked sort_held
 * (searchable, shown on their file, not in the Faces grid). At the end of a
 * run held faces are tried again against the people that appeared since
 * (fresh: started by the job, or made by the user from faces). Faces with no
 * norm on record (found before norms were kept) sort as before.
 *
 * "Same person?" suggestions are person level (person centroid vs person
 * centroid, like "Might also be"): an UNNAMED person and its best other
 * person make a pair when the score is >= suggest (0.54) and beats the
 * unnamed person's second-best person by >= suggestMargin (0.04), models.js.
 * Never two named people, hidden people, or people with a decision or a
 * reject between them. A pair with a named person needs the margin over the
 * second-best NAMED person (ruleFor step 1); a pair of two unnamed people is
 * only made for people a user changed (merge, split, add, answers), against
 * everyone (step 2). Every person whose centroid changed is re-scored at the
 * end of a run: the job's own growth and the one-time pass below against
 * named people only (cheap at 200k people), user changes fully. Re-scoring a
 * person also drops its pairs the rule no longer makes (applyFor), so an
 * incremental re-score ends where a full one would. At most
 * SUGGESTION_CAP (500) rows are kept, named-vs-unnamed pairs first. Pairs a
 * different rule made (face_meta.suggest_rule, e.g. after an update) are
 * dropped at the first run and every person is scored again, once.
 *
 * Runs debounced after any face write, in synchronous slices of ~sliceMs with
 * an event-loop yield between them (a slice computes and writes atomically,
 * so nothing interleaves inside one). Before every slice it re-checks the
 * lock generation, the feature switch and the migrate probe: a lock or a
 * cancel stops it with nothing more written; a migrate defers it.
 */

const { peopleThresholds, SUGGESTION_CAP } = require('./thresholds');

// Vector length: whatever the model's vectors have (SFace 128, AdaFace 512).
const Q = 127;
const SCALE = Q * Q;
const FETCH = 64;
const BUILD_PAGE = 1000;
const MAX_SUGGESTIONS = SUGGESTION_CAP;
const TRIM_SLACK = 200;       // between slices the list may run this far over the cap
const BLOCK = 1024;          // people per centroid block
const ABORT = Symbol('people-sort-abort');
const MARGIN_NOW = 200;      // held faces a user's request scores against everyone at most (retryHeldNow)
// Which rule made the stored "Same person?" pairs (face_meta.suggest_rule).
// Pairs from another rule are dropped and every person is scored again once.
const SUGGEST_RULE = 'person-centroid-0.54-0.04-v2';   // v2: named pairs take the margin over named people
// Which rule put faces in people automatically (face_meta 'join_rule'). A
// library sorted under another rule gets the one-time re-check (see the header).
const JOIN_RULE = 'join-likely-margin-v1';

/**
 * The automatic join rule. best = { pid, score, second } (second -1 = no
 * other person); named = whether pid is a named person; th = peopleThresholds().
 */
function joinOk(best, named, th) {
  if (!best || best.pid == null) return false;
  const bar = named ? th.joinNamed : th.join;
  return best.score >= bar && best.score - best.second >= th.joinMargin;
}

function quantizeInto(vec, out, off) {
  for (let i = 0; i < vec.length; i++) {
    const q = Math.round(vec[i] * Q);
    out[off + i] = q > Q ? Q : (q < -Q ? -Q : q);
  }
}

/** Quantize into `buf` (reused when it has the right length). */
function qbuf(vec, buf) {
  if (!buf || buf.length !== vec.length) buf = new Int8Array(vec.length);
  quantizeInto(vec, buf, 0);
  return buf;
}

function meanOf(vecs) {
  const dim = vecs.length ? vecs[0].length : 0;
  const out = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i];
  let s = 0;
  for (let i = 0; i < dim; i++) s += out[i] * out[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < dim; i++) out[i] /= s;
  return out;
}

/**
 * Person centroids for one model. Storage grows a block at a time, so adding
 * people never copies what is already there. The vector length is the
 * first vector's (one model = one length).
 */
function createCentroids(dim = 0) {
  const blocks = [];   // { pids: Int32Array, counts: Int32Array, sums: Float32Array, q: Int8Array }
  let n = 0;
  let D = dim;
  const slot = new Map();   // pid -> slot index
  const at = (i) => blocks[(i / BLOCK) | 0];
  function requantize(b, j) {
    const off = j * D;
    let s = 0;
    for (let k = 0; k < D; k++) s += b.sums[off + k] * b.sums[off + k];
    s = Math.sqrt(s) || 1;
    for (let k = 0; k < D; k++) {
      const v = Math.round((b.sums[off + k] / s) * Q);
      b.q[off + k] = v > Q ? Q : (v < -Q ? -Q : v);
    }
  }
  /** Add a group vector to a person (creating its slot). */
  function add(pid, vec, { requant = true } = {}) {
    if (!D) D = vec.length;
    let i = slot.get(pid);
    if (i === undefined) {
      if (n === blocks.length * BLOCK) {
        blocks.push({ pids: new Int32Array(BLOCK).fill(-1), counts: new Int32Array(BLOCK),
          sums: new Float32Array(BLOCK * D), q: new Int8Array(BLOCK * D) });
      }
      i = n++;
      at(i).pids[i % BLOCK] = pid;
      slot.set(pid, i);
    }
    const b = at(i), j = i % BLOCK, off = j * D;
    for (let k = 0; k < D; k++) b.sums[off + k] += vec[k];
    b.counts[j]++;
    if (requant) requantize(b, j);
  }
  /** Take a group vector out of a person; a person left with nothing is dropped. */
  function sub(pid, vec) {
    const i = slot.get(pid);
    if (i === undefined) return;
    const b = at(i), j = i % BLOCK, off = j * D;
    if (--b.counts[j] <= 0) {
      b.pids[j] = -1;
      b.sums.fill(0, off, off + D);
      b.q.fill(0, off, off + D);
      slot.delete(pid);
      return;
    }
    for (let k = 0; k < D; k++) b.sums[off + k] -= vec[k];
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
        const off = j * D;
        let d = 0;
        for (let k = 0; k < D; k++) d += gq[k] * q[off + k];
        if (d > bs) { bs = d; bp = pid; }
      }
    }
    return bp == null ? { pid: null, score: -1 } : { pid: bp, score: bs / SCALE };
  }
  /** Dot products of a quantized query with every person not in `skip`: fn(pid, raw dot). */
  function scan(gq, skip, fn) {
    for (let bi = 0; bi < blocks.length; bi++) {
      const { pids, q } = blocks[bi];
      const m = Math.min(BLOCK, n - bi * BLOCK);
      for (let j = 0; j < m; j++) {
        const pid = pids[j];
        if (pid < 0 || (skip && skip.has(pid))) continue;
        const off = j * D;
        let d = 0;
        for (let k = 0; k < D; k++) d += gq[k] * q[off + k];
        fn(pid, d);
      }
    }
  }
  /**
   * Best and second-best person for a quantized query, skipping `skip`.
   * @returns {{ pid: number|null, score: number, second: number }}  (-1 = none)
   */
  function top2(gq, skip) {
    let bp = null, bs = -Infinity, s2 = -Infinity;
    scan(gq, skip, (pid, d) => {
      if (d > bs) { s2 = bs; bs = d; bp = pid; } else if (d > s2) s2 = d;
    });
    return { pid: bp, score: bp == null ? -1 : bs / SCALE, second: s2 === -Infinity ? -1 : s2 / SCALE };
  }
  /** People scoring >= min against a quantized query, skipping `skip`. */
  function above(gq, min, skip) {
    const out = [];
    const lim = min * SCALE;
    scan(gq, skip, (pid, d) => { if (d >= lim) out.push(pid); });
    return out;
  }
  function queryOf(pid) {
    const i = slot.get(pid);
    if (i === undefined) return null;
    const j = i % BLOCK;
    return at(i).q.subarray(j * D, (j + 1) * D);
  }
  /**
   * A member's vector against its person's centroid WITHOUT it (float sums):
   * { score, count } (count = groups in the person; score -1 when it is the only one).
   */
  function loo(pid, vec) {
    const i = slot.get(pid);
    if (i === undefined) return { score: -1, count: 0 };
    const b = at(i), j = i % BLOCK, off = j * D;
    const count = b.counts[j];
    if (count <= 1) return { score: -1, count };
    let s = 0, d = 0;
    for (let k = 0; k < D; k++) { const r = b.sums[off + k] - vec[k]; s += r * r; d += r * vec[k]; }
    return { score: s > 0 ? d / Math.sqrt(s) : -1, count };
  }
  /** Bytes held in typed arrays. */
  function bytes() { return blocks.length * BLOCK * (4 + 4 + D * 4 + D); }
  return { add, sub, finish, best, top2, above, queryOf, loo, bytes, has: (pid) => slot.has(pid), size: () => slot.size, pids: () => [...slot.keys()] };
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
  const dirty = new Map();   // pid -> full (see dirtySlice)
  const markOne = (pid, full) => { if (full || !dirty.has(pid)) dirty.set(pid, !!full); };
  let lastError = null;
  // Faces a user just took out of a person ("Not this person"): sorted first,
  // and the request waits for them (waiters).
  const priority = new Set();
  const results = new Map();   // group id -> { personId, newPerson }
  let waiters = [];            // { ids: number[], resolve }
  const fresh = new Set();     // people started since held faces were last retried
  let heldPass = null;         // { targets: number[], after: group id } while retrying held faces
  let ruleChecked = false;     // face_meta.suggest_rule looked at (once per process)
  let ruleMarkPending = false; // everyone is being scored under SUGGEST_RULE: mark it when done
  let lastRescoreMs = 0;       // how long the last run spent on "Same person?" (diagnostics)
  let named = null;            // { uv, set } named people (names only move with a user's write)
  let recheck = null;          // { rule, after, upto, out } while the one-time re-check runs
  let lastRecheck = null;      // { rule, out, ms } of the last finished re-check (diagnostics, tests)

  function namedSet(db) {
    const uv = store.peopleUserVersion();
    if (named && named.uv === uv) return named.set;
    named = { uv, set: new Set(db.prepare('SELECT id FROM face_people WHERE name IS NOT NULL').all().map(r => r.id)) };
    return named.set;
  }

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

  function markDirty(ids) { for (const id of ids || []) if (Number.isInteger(id)) markOne(id, true); }
  /** New people held faces should be tried against (e.g. one the user made from faces). */
  function markFresh(ids) { for (const id of ids || []) if (Number.isInteger(id)) fresh.add(id); }

  /** Vault locked or face data wiped: stop at the next slice, forget every vector. */
  function suspend() {
    token++;
    clearTimer();
    again = false;
    cache = null;
    heldPass = null;
    named = null;
    recheck = null;   // resumes from face_meta at the next run
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
    // 1a. Faces sorted under an older join rule: the one-time re-check.
    if (recheckPending(db)) {
      for (;;) {
        await check();
        if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
        // New faces (and a user's "Not this person") never wait for the whole re-check.
        if (assignSlice(db)) continue;
        if (!recheckSlice(db)) break;
      }
    }
    // 1b. Held (unclear) faces against the people that appeared meanwhile.
    while (fresh.size || heldPass) {
      await check();
      if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
      heldSlice(db);
    }
    // 2. Re-score people a merge or split changed.
    const tScore = now();
    while (dirty.size) {
      await check();
      if (!cache || cache.pv !== store.peopleVersion()) { await build(db, check); continue; }
      dirtySlice(db);
    }
    lastRescoreMs = now() - tScore;
    trimSuggestions(db);
    if (ruleMarkPending && !dirty.size) {
      db.prepare("INSERT INTO face_meta (key, value) VALUES ('suggest_rule', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SUGGEST_RULE);
      ruleMarkPending = false;
    }
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
    // Pairs made by an older rule (an update changed it): drop them, score everyone again.
    if (!ruleChecked) {
      ruleChecked = true;
      if (db.prepare("SELECT value FROM face_meta WHERE key = 'suggest_rule'").get()?.value !== SUGGEST_RULE) {
        db.prepare('DELETE FROM face_person_suggestions').run();
        for (const c of models.values()) for (const pid of c.pids()) markOne(pid, false);
        ruleMarkPending = true;
      }
    }
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


  /**
   * Sort these unsorted groups (rows { id, model, hidden }) into people.
   * Inside the caller's transaction. Stops early when `deadline` passes.
   * @returns {number} groups handled
   */
  function assignRows(db, rows, stamp, deadline = Infinity) {
    let done = 0;
    if (!rows.length) return done;
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
    let gq = null;
    const namedIds = namedSet(db);
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
        gq = qbuf(gv, gq);
        const c = centroidsFor(r.model);
        const best = c.top2(gq, rejects.get(r.id));
        if (joinOk(best, namedIds.has(best.pid), th)) {
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
        }
        if (!r.hidden) {
          c.add(pid, gv);   // hidden faces never shape a centroid
          markOne(pid, false);   // its centroid moved: "Same person?" is scored at the end of the run (against named people)
        }
      }
      setG.run(pid, r.id);
      if (priority.delete(r.id)) results.set(r.id, { personId: pid, newPerson: created });
      done++;
      if (now() >= deadline) break;
    }
    return done;
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
    let done = 0, user = false;
    const stamp = new Date(now()).toISOString();
    db.transaction(() => {
      if (priority.size) {
        const r = assignRows(db, priorityRows(db), stamp);
        done += r; user = true;
      }
      // The partial index keeps this a walk, not a sort of every unsorted face.
      const fetch = db.prepare(`SELECT id, model, hidden, norm FROM face_groups INDEXED BY idx_face_groups_unsorted2
        WHERE cluster_id IS NULL AND hidden = 0 AND sort_held = 0 ORDER BY det_score DESC, id LIMIT ${FETCH}`);
      while (now() - t0 < sliceMs) {
        const rows = fetch.all();
        if (!rows.length) break;
        const r = assignRows(db, rows, stamp, t0 + sliceMs);
        done += r;
      }
    })();
    if (done) {
      // The job's own writes reach the people stats within a few seconds;
      // faces a user moved count as the user's write.
      store.bumpPeople({ background: !user });
      cache.pv = store.peopleVersion();
    }
    settleWaiters();
    return done;
  }

  /**
   * One slice of retrying held faces (a page at a time, by id) against the
   * people in heldPass.targets: a held face joins the best of them at
   * the join rule (rejects respected; the margin counts everyone). Ends the pass when the walk is done.
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
    let gq = null;
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
        const namedIds = namedSet(db);
        for (const r of rows) {
          const list = vecs.get(r.id);
          const c = cache.models.get(r.model);
          if (!list || !list.length || !c) continue;
          const gv = meanOf(list);
          gq = qbuf(gv, gq);
          const skip = rejects.get(r.id);
          let bp = null, bs = -Infinity;
          for (const pid of heldPass.targets) {
            if (skip && skip.has(pid)) continue;
            const q = c.queryOf(pid);
            if (!q) continue;
            let d = 0;
            for (let k = 0; k < gq.length; k++) d += gq[k] * q[k];
            if (d > bs) { bs = d; bp = pid; }
          }
          if (bp == null) continue;
          const th = peopleThresholds(r.model);
          // The bar first (cheap, against the new people only); only a face
          // that clears it is scored against everyone for the margin.
          if (bs / SCALE < (namedIds.has(bp) ? th.joinNamed : th.join)) continue;
          const best = c.top2(gq, skip);
          if (best.pid !== bp || !joinOk(best, namedIds.has(bp), th)) continue;
          if (setG.run(bp, r.id).changes) {
            c.add(bp, gv);
            markOne(bp, false);
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

  /**
   * What the "Same person?" rule needs besides centroids: who is named,
   * hidden, and who must never be paired with whom ('different' answers and
   * "not this person" rejects, either way). Loaded once and kept until
   * someone else changes people data (the job's own pair writes do not
   * touch any of it).
   */
  let ruleCtx = null;   // { key, named: Set, hidden: Set, blocked: Map<pid, Set> }
  const ctxKey = () => `${store.peopleVersion()}/${store.peopleUserVersion()}`;   // names and answers move only the second
  function ctxFor(db) {
    if (ruleCtx && ruleCtx.key === ctxKey()) return ruleCtx;
    const named = new Set(), hidden = new Set(), blocked = new Map();
    for (const r of db.prepare('SELECT id, name, hidden FROM face_people WHERE name IS NOT NULL OR hidden = 1').all()) {
      if (r.hidden) hidden.add(r.id); else named.add(r.id);
    }
    const block = (a, b) => {
      if (a === b) return;
      if (!blocked.has(a)) blocked.set(a, new Set());
      if (!blocked.has(b)) blocked.set(b, new Set());
      blocked.get(a).add(b); blocked.get(b).add(a);
    };
    for (const r of db.prepare('SELECT a, b FROM face_pair_decisions').all()) block(r.a, r.b);
    for (const r of db.prepare(`SELECT DISTINCT r.person_id AS p, g.cluster_id AS c FROM face_person_rejects r
      JOIN face_groups g ON g.id = r.group_id WHERE g.cluster_id IS NOT NULL`).all()) block(r.p, r.c);
    ruleCtx = { key: ctxKey(), named, hidden, blocked };
    return ruleCtx;
  }

  /**
   * The "Same person?" rule for unnamed person `u` in one model's centroids:
   *  1. its best NAMED person, at >= suggest with a margin >= suggestMargin
   *     over its second-best named person (named people are few: cheap);
   *  2. else, only when `full`: its best person overall, if that is an
   *     unnamed one at >= suggest with the margin over its second-best person.
   * Hidden and blocked people are never compared (not for a margin either).
   * @returns {{ pid, score } | null}
   */
  function ruleFor(c, u, th, ctx, full, namedQ) {
    const gq = c.queryOf(u);
    if (!gq || ctx.named.has(u) || ctx.hidden.has(u)) return null;
    let bp = null, b1 = -Infinity, b2 = -Infinity;
    const blocked = ctx.blocked.get(u);
    for (let i = 0; i < namedQ.pids.length; i++) {
      const pid = namedQ.pids[i];
      if (blocked && blocked.has(pid)) continue;
      const q = namedQ.qs[i];
      let d = 0;
      for (let k = 0; k < gq.length; k++) d += gq[k] * q[k];
      if (d > b1) { b2 = b1; b1 = d; bp = pid; } else if (d > b2) b2 = d;
    }
    const s1 = b1 / SCALE, s2 = b2 === -Infinity ? -1 : b2 / SCALE;
    if (bp != null && s1 >= th.suggest && s1 - s2 >= th.suggestMargin) return { pid: bp, score: s1 };
    if (!full) return null;
    const skip = new Set(ctx.hidden);
    for (const b of ctx.blocked.get(u) || []) skip.add(b);
    skip.add(u);
    const t = c.top2(gq, skip);
    if (t.pid == null || ctx.named.has(t.pid) || t.score < th.suggest || t.score - t.second < th.suggestMargin) return null;
    return { pid: t.pid, score: t.score };
  }

  /**
   * Bring unnamed person u's pairs in line with the rule: its own pair is
   * written, and every other pair it has is kept only while the rule still
   * makes it from the other side (that unnamed person's own pick is u).
   * So an incremental re-score ends where a full one would.
   */
  function applyFor(st, c, u, th, ctx, full, memo, namedQ) {
    const rows = st.pairs.all(u, u);
    const pairsOf = rows.map(r => (r.a === u ? r.b : r.a));
    // An existing pair with an unnamed person may come from step 2: judge it fully.
    const isFull = full || pairsOf.some(y => !ctx.named.has(y));
    const pick = (x, f) => {
      const key = `${x}/${f ? 1 : 0}`;
      if (!memo.has(key)) memo.set(key, ruleFor(c, x, th, ctx, f, namedQ));
      return memo.get(key);
    };
    const mine = pick(u, isFull);
    for (const y of pairsOf) {
      if (mine && mine.pid === y) continue;
      const theirs = !ctx.named.has(y) && !ctx.hidden.has(y) ? pick(y, true) : null;
      if (theirs && theirs.pid === u) continue;
      st.del.run(Math.min(u, y), Math.max(u, y));
    }
    if (!mine) return;
    const score = Math.round(mine.score * 10000) / 10000;
    // Unchanged: no write (most of a long pass changes nothing, and a slice that wrote nothing commits for free).
    if (rows.some(r => (r.a === u ? r.b : r.a) === mine.pid && r.score === score)) return;
    st.put.run(Math.min(u, mine.pid), Math.max(u, mine.pid), score);
  }

  /**
   * Re-score changed people (a slice). dirty: pid -> true (a user change:
   * also unnamed-vs-unnamed, against everyone) or false (the job's own
   * growth and the one-time pass after a rule change: against named people
   * only, so it stays cheap with hundreds of thousands of people).
   */
  function dirtySlice(db) {
    const t0 = now();
    let wrote = false;
    const ctx = ctxFor(db);
    const memo = new Map();
    const st = {
      exists: db.prepare('SELECT 1 FROM face_people WHERE id = ?'),
      pairs: db.prepare('SELECT a, b, score FROM face_person_suggestions WHERE a = ? OR b = ?'),
      delAll: db.prepare('DELETE FROM face_person_suggestions WHERE a = ? OR b = ?'),
      del: db.prepare('DELETE FROM face_person_suggestions WHERE a = ? AND b = ?'),
      // ctx.blocked already holds every decision: no pair here ever has one
      put: db.prepare(`INSERT INTO face_person_suggestions (a, b, score) VALUES (?, ?, ?)
        ON CONFLICT(a, b) DO UPDATE SET score = excluded.score`),
    };
    // Named people's centroids, per model, read once for the slice.
    const namedOf = new Map();
    const namedFor = (model, c) => {
      if (!namedOf.has(model)) {
        const pids = [], qs = [];
        for (const pid of ctx.named) { const q = c.queryOf(pid); if (q) { pids.push(pid); qs.push(q); } }
        namedOf.set(model, { pids, qs });
      }
      return namedOf.get(model);
    };
    db.transaction(() => {
      for (const [pid, full] of [...dirty]) {
        dirty.delete(pid);
        const exists = st.exists.get(pid);
        wrote = true;
        if (!exists || ctx.hidden.has(pid)) {   // gone or hidden: never part of a question
          st.delAll.run(pid, pid);
          continue;
        }
        for (const [model, c] of cache.models) {
          const gq = c.queryOf(pid);
          if (!gq) continue;
          const th = peopleThresholds(model);
          const namedQ = namedFor(model, c);
          // Everyone this person's change may concern: its own pair, its partners,
          // and the unnamed people close enough to pick it now.
          const todo = new Set();
          if (!ctx.named.has(pid)) todo.add(pid);
          for (const r of st.pairs.all(pid, pid)) {
            const y = r.a === pid ? r.b : r.a;
            if (!ctx.named.has(y)) todo.add(y);
            else if (ctx.named.has(pid)) st.del.run(r.a, r.b);   // two named people
          }
          if (full || ctx.named.has(pid)) {
            const skip = new Set(ctx.hidden);
            for (const b of ctx.blocked.get(pid) || []) skip.add(b);
            skip.add(pid);
            for (const u of c.above(gq, th.suggest, skip)) if (!ctx.named.has(u)) todo.add(u);
          }
          for (const u of todo) applyFor(st, c, u, th, ctx, full, memo, namedQ);
        }
        if (now() - t0 >= sliceMs) break;
      }
    })();
    if (wrote) {
      store.bumpPeople({ background: true });
      if (cache) cache.pv = store.peopleVersion();
      if (ruleCtx) ruleCtx.key = ctxKey();   // pair writes change nothing it holds
    }
    trimSuggestions(db, TRIM_SLACK);   // exact at the end of the run
  }

  /** Keep the best MAX_SUGGESTIONS pairs: named-vs-unnamed first (what Review shows first), then score. */
  function trimSuggestions(db, slack = 0) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM face_person_suggestions').get().n;
    if (n <= MAX_SUGGESTIONS + slack) return;
    db.prepare(`DELETE FROM face_person_suggestions WHERE rowid NOT IN
      (SELECT s.rowid FROM face_person_suggestions s
        LEFT JOIN face_people pa ON pa.id = s.a LEFT JOIN face_people pb ON pb.id = s.b
        ORDER BY ((pa.name IS NULL) != (pb.name IS NULL)) DESC, s.score DESC LIMIT ${MAX_SUGGESTIONS})`).run();
    store.bumpPeople({ background: true });
    if (cache) cache.pv = store.peopleVersion();
  }

  /* ── The one-time re-check of automatic joins (see the header) ─────────── */

  const metaGet = (db, key) => db.prepare('SELECT value FROM face_meta WHERE key = ?').get(key)?.value ?? null;
  const metaSet = (db, key, value) => db.prepare(`INSERT INTO face_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);

  /**
   * Does this library still need the re-check under JOIN_RULE? Loads (or
   * starts) its progress. A library with no sorted face yet has nothing
   * sorted under an older rule: it is marked done at once.
   */
  function recheckPending(db) {
    recheck = null;
    if (metaGet(db, 'join_rule') === JOIN_RULE) return false;
    let st = null;
    try { st = JSON.parse(metaGet(db, 'join_recheck') || 'null'); } catch { st = null; }
    if (!st || st.rule !== JOIN_RULE || !Number.isInteger(st.after) || !Number.isInteger(st.upto)) {
      const upto = db.prepare('SELECT MAX(id) AS m FROM face_groups WHERE cluster_id IS NOT NULL').get().m;
      if (upto == null) { metaSet(db, 'join_rule', JOIN_RULE); return false; }
      st = { rule: JOIN_RULE, after: 0, upto, out: 0, startedAt: now() };
      metaSet(db, 'join_recheck', JSON.stringify(st));
    }
    recheck = st;
    return true;
  }

  /**
   * One slice of the re-check: automatic faces (person_locked = 0), visible,
   * in a visible person, not a person's chosen cover, by group id. A face
   * that fails the join rule against its person without itself (and the
   * second-best other person, its rejects left out) moves into a new unnamed
   * person with recheck_from = the person it left. A person is never emptied
   * (its last face stays: nothing to compare it with).
   * @returns {boolean} more to do
   */
  function recheckSlice(db) {
    const t0 = now();
    const st = recheck;
    let moved = 0, asked = 0, done = false;
    // Automatic faces, and (named people only) faces locked without a
    // per-face decision: 3.7 locked a person's every face when it was named.
    const page = db.prepare(`SELECT g.id, g.model, g.cluster_id, g.person_locked FROM face_groups g
      JOIN face_people p ON p.id = g.cluster_id AND p.hidden = 0
      WHERE g.id > ? AND g.id <= ? AND g.hidden = 0
        AND (g.person_locked = 0 OR (g.confirmed = 0 AND g.recheck_ask IS NULL AND p.name IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM face_people c WHERE c.cover_group_id = g.id)
      ORDER BY g.id LIMIT ${FETCH}`);
    const insP = db.prepare('INSERT INTO face_people (created_at, updated_at) VALUES (?, ?)');
    const out = db.prepare('UPDATE face_groups SET cluster_id = ?, recheck_from = ? WHERE id = ? AND cluster_id = ? AND person_locked = 0');
    const ask = db.prepare('UPDATE face_groups SET recheck_ask = cluster_id WHERE id = ? AND cluster_id = ? AND person_locked = 1 AND confirmed = 0');
    const stamp = new Date(now()).toISOString();
    const namedIds = namedSet(db);
    let gq = null;
    db.transaction(() => {
      // At least one page per slice, however the clock moves: the walk always advances.
      for (let first = true; first || now() - t0 < sliceMs; first = false) {
        const rows = page.all(st.after, st.upto);
        if (!rows.length) { done = true; break; }
        st.after = rows[rows.length - 1].id;
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
          if (!list || !list.length || !c || !c.has(r.cluster_id)) continue;
          const gv = meanOf(list);
          const own = c.loo(r.cluster_id, gv);
          if (own.count <= 1) continue;
          gq = qbuf(gv, gq);
          const skip = new Set(rejects.get(r.id) || []);
          skip.add(r.cluster_id);
          const other = c.top2(gq, skip);
          const th = peopleThresholds(r.model);
          if (joinOk({ pid: r.cluster_id, score: own.score, second: other.score }, namedIds.has(r.cluster_id), th)) continue;
          // A locked face is never moved: the user is asked ("Check N faces in X").
          if (r.person_locked) { if (ask.run(r.id, r.cluster_id).changes) asked++; continue; }
          const pid = Number(insP.run(stamp, stamp).lastInsertRowid);
          if (!out.run(pid, r.cluster_id, r.id, r.cluster_id).changes) {
            db.prepare('DELETE FROM face_people WHERE id = ?').run(pid);
            continue;
          }
          c.sub(r.cluster_id, gv);
          c.add(pid, gv);
          markOne(r.cluster_id, false);
          markOne(pid, false);
          moved++;
        }
      }
      st.out += moved;
      st.asked = (st.asked || 0) + asked;
      if (done) {
        metaSet(db, 'join_rule', JOIN_RULE);
        db.prepare("DELETE FROM face_meta WHERE key = 'join_recheck'").run();
      } else metaSet(db, 'join_recheck', JSON.stringify(st));
    })();
    if (moved || asked) {
      store.bumpPeople({ background: true });
      cache.pv = store.peopleVersion();
    }
    if (done) {
      recheck = null;
      lastRecheck = { rule: st.rule, out: st.out, asked: st.asked || 0, ms: Math.max(0, now() - (st.startedAt || now())) };
      console.log(`[Faces] re-checked automatic people sorting (${st.rule}): ${st.out} face(s) taken back out into their own people, ${st.asked || 0} locked face(s) to check`);
    }
    return !done;
  }

  /** Unsorted visible groups (what the job still has to do). */
  function pending() {
    try {
      return database.get().prepare('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id IS NULL AND hidden = 0 AND sort_held = 0').get().n;
    } catch { return 0; }
  }

  /**
   * Retry the held (unclear) faces against these people right now, inside
   * the user's request, with the same rule as heldSlice (quantized centroid,
   * join bar and margin, the face's rejects respected). A user action that made
   * or grew a person answers after its held faces had their chance, so a
   * search run right after it sees them. These people's centroids come from
   * the DB, so it never waits for a rebuild; the margin's other people come
   * from the job's cache (no cache: the background pass decides). @returns {number} faces joined
   */
  function retryHeldNow(personIds) {
    const pids = [...new Set((personIds || []).filter(Number.isInteger))];
    if (!pids.length || !enabled() || isVaultLocked() || isMigrateRunning()) return 0;
    const db = database.get();
    const byModel = new Map();   // model -> centroids of these people
    const rows = db.prepare(`SELECT g.id, g.model, g.cluster_id, v.embedding FROM face_groups g JOIN face_vectors v ON v.group_id = g.id
      WHERE g.cluster_id IN (${pids.map(() => '?').join(',')}) AND g.hidden = 0 ORDER BY g.id, v.id`).all(...pids);
    for (let i = 0; i < rows.length;) {
      const g = rows[i];
      const vecs = [];
      while (i < rows.length && rows[i].id === g.id) { vecs.push(store.decodeEmbedding(rows[i].embedding)); i++; }
      if (!byModel.has(g.model)) byModel.set(g.model, createCentroids());
      byModel.get(g.model).add(g.cluster_id, meanOf(vecs), { requant: false });
    }
    if (!byModel.size) return 0;
    for (const c of byModel.values()) c.finish();
    const held = db.prepare(`SELECT g.id, g.model, v.embedding FROM face_groups g JOIN face_vectors v ON v.group_id = g.id
      WHERE g.sort_held = 1 AND g.cluster_id IS NULL AND g.hidden = 0 ORDER BY g.id, v.id`).all();
    const rejectsOf = db.prepare('SELECT person_id FROM face_person_rejects WHERE group_id = ?');
    const setG = db.prepare('UPDATE face_groups SET cluster_id = ?, sort_held = 0 WHERE id = ? AND cluster_id IS NULL');
    let gq = null;
    let joined = 0, margins = 0;
    const namedIds = namedSet(db);
    const targets = new Set(pids);
    db.transaction(() => {
      for (let i = 0; i < held.length;) {
        const g = held[i];
        const vecs = [];
        while (i < held.length && held[i].id === g.id) { vecs.push(store.decodeEmbedding(held[i].embedding)); i++; }
        const c = byModel.get(g.model);
        if (!c) continue;
        const gv = meanOf(vecs);
        gq = qbuf(gv, gq);
        const skip = new Set(rejectsOf.all(g.id).map(r => r.person_id));
        const t = c.top2(gq, skip);   // among these people only
        const th = peopleThresholds(g.model);
        if (t.pid == null || t.score < (namedIds.has(t.pid) ? th.joinNamed : th.join)) continue;
        // The margin also counts everyone else. Their centroids come from the
        // job's cache (stale is fine for people this request did not touch);
        // with no cache, or past MARGIN_NOW faces, the background pass decides.
        const others = cache && cache.models.get(g.model);
        if (!others || ++margins > MARGIN_NOW) continue;
        for (const p of targets) skip.add(p);
        const o = others.top2(gq, skip);
        const best = { pid: t.pid, score: t.score, second: Math.max(t.second, o.score) };
        if (joinOk(best, namedIds.has(t.pid), th) && setG.run(t.pid, g.id).changes) {
          const pid = t.pid;
          c.add(pid, gv);
          markOne(pid, true);
          joined++;
        }
      }
    })();
    if (joined) { store.bumpPeople(); cache = null; }
    return joined;
  }

  /**
   * How well faces fit person `pid` (the review cards' "Strong match"):
   * per item { model, vec }, { score: cosine to pid's centroid, second: best
   * other NAMED person } from the job's centroids (a stale cache is fine for
   * a hint), or null where the cache has no such person or model.
   * @returns {Array<{score, second}|null> | null}  null: no cache yet
   */
  function scoreFaces(pid, items) {
    if (!cache) return null;
    const namedIds = namedSet(database.get());
    let gq = null;
    return items.map(({ model, vec }) => {
      const c = cache.models.get(model);
      const q = c && c.queryOf(pid);
      if (!q || !vec || vec.length !== q.length) return null;
      gq = qbuf(vec, gq);
      let d = 0;
      for (let k = 0; k < gq.length; k++) d += gq[k] * q[k];
      let s2 = -Infinity;
      for (const n of namedIds) {
        if (n === pid) continue;
        const qn = c.queryOf(n);
        if (!qn) continue;
        let e = 0;
        for (let k = 0; k < gq.length; k++) e += gq[k] * qn[k];
        if (e > s2) s2 = e;
      }
      return { score: d / SCALE, second: s2 === -Infinity ? -1 : s2 / SCALE };
    });
  }

  return {
    schedule, runNow, markDirty, markFresh, retryHeldNow, suspend, cancel, settled, pending, reassign, scoreFaces,
    isRunning: () => !!running,
    /** Bytes the centroid cache holds in typed arrays (0 when not built). */
    cacheBytes: () => (cache ? [...cache.models.values()].reduce((a, c) => a + c.bytes(), 0) : 0),
    cachePeople: () => (cache ? [...cache.models.values()].reduce((a, c) => a + c.size(), 0) : 0),
    lastError: () => lastError,
    _cache: () => cache,
    _lastRescoreMs: () => lastRescoreMs,
    /** The last finished join re-check { rule, out, ms } (null: none in this process). */
    lastRecheck: () => lastRecheck,
    recheckRunning: () => !!recheck,
  };
}

module.exports = { createSorter, createCentroids, meanOf, joinOk, MAX_SUGGESTIONS, JOIN_RULE };
