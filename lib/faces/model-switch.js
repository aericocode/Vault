/**
 * Face model switch (FACE_MODELS_SPEC "H3"): re-read a library's faces with
 * another keeper model WITHOUT re-checking every file.
 *
 * When it runs: the service's active keeper (models.js KEEPERS: 'ir50' by
 * default, 'ir101' when chosen and downloaded) differs from the model some
 * indexed files are in (any model id in models.js SWITCHABLE: the old
 * SFace-keeper libraries, or the other AdaFace keeper). Files of other model
 * ids are not touched.
 *
 * Order: files with a named person's face first, then a favorite's, then
 * the rest (each tier by media id), `workers` files at a time on the queue's
 * engines; after each batch the service lets unsorted faces join the people
 * re-read so far (onBatch). Per file:
 *   1. every group already has its target-model vectors waiting in
 *      face_vectors_prev (a switch back before the last one finished): swap
 *      them in, no decoding;
 *   2. else decode exactly what indexing decoded: photos decodeImage, videos
 *      sampleVideo on the file's stored spacing (faces_interval_s), stopping
 *      after the last frame holding an exemplar. On each such frame, detect,
 *      take the detection whose box overlaps the stored exemplar box by
 *      IoU >= MATCH_IOU (0.8), and embed it with the new keeper (the same
 *      alignment, so the vector equals a fresh index of that face: model-bench
 *      h3.out, 104/104 exemplars cosine 1.000000);
 *   3. a group none of whose exemplars could be matched (file changed,
 *      decoder drift): the whole file is checked again (analyzeFile +
 *      saveFileResult; its position carry-over keeps names, people, rejects
 *      and hidden faces).
 * Steps 1 and 2 write in ONE transaction per file (store.switchFileModel):
 * the groups keep their ids, so names, merges, "not this person" rejects,
 * hidden / not-a-face marks and studio memberships are untouched (they live
 * on groups and people, not vectors). The old vectors move to
 * face_vectors_prev: search keeps finding a file in its old model until it
 * is done, and a query face that exists only in the old model still finds
 * the files already switched.
 *
 * At the end: the waiting old vectors are deleted, and people are sorted
 * again in the new model (resort()): automatic people nobody touched are
 * dissolved and their faces sorted afresh (the point of a better model:
 * faces that missed their person now join it), held faces get another try,
 * and every "Same person?" pair is scored again; the faces the sorting job
 * put into the people that stay get the join re-check again (people-sort.js),
 * in the new model. Named, favorite and hidden
 * people, people with faces a user placed (merges, adds), decisions,
 * rejects, a chosen cover or a studio stay exactly as they are.
 *
 * State (face_meta 'model_switch', JSON): { from, to, total, paused,
 * startedAt, counts, finishing }. Progress itself is the data (files still in
 * another model), so a restart resumes where it stopped; paused and the
 * counters survive restarts; a finish that was interrupted is completed at
 * the next start. Files that could not be read (face_meta
 * 'model_switch_failed', with the reason and the file's path, size and
 * mtime) stay in their old model, still listed and searched there; they are
 * "stuck": no switch starts for them alone, and each is tried again only
 * when it changes on disk or the user asks (retry()). People are re-sorted at
 * the end only when files actually moved. Guards: a vault lock stops it at once (lock generation, engines
 * dropped by the service), a library migrate defers it, feature off stops it.
 */

const { SWITCHABLE } = require('./models');

const MATCH_IOU = 0.8;
const TIME_EPS = 1e-3;
const DETECT_MIN_SCORE = 0.5;     // lenient: we look for a face we already found at >= 0.80
const RETRY_MS = 5000;
const META_KEY = 'model_switch';
const LAST_KEY = 'model_switch_last';
const FAILED_KEY = 'model_switch_failed';
const FAILED_MAX = 5000;
const BIG_FRAMES = 1e6;
const TIERS = Object.freeze(['named', 'favorite', 'rest']);
const STATUS_TTL_MS = 2000;
const STATUS_TTL_RUNNING_MS = 250;   // while files are being re-read: the progress must move

function defaultStat(p) {
  try { const st = require('fs').statSync(p); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; }
}

function iou(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - i;
  return u > 0 ? i / u : 0;
}

/**
 * @param {object} deps
 *   database, store, kindOf (store.kindOf)
 *   target()            the active keeper model id, or null (no switching possible now)
 *   withEngine(fn)      runs fn(engine) with a loaded engine of the target model
 *   framesOf(engine)    frame source
 *   recheck(row, engine, signal)  full re-check of one file into the target model
 *   settings()          { intervalS, maxFrames } (spacing of files with no stored one)
 *   enabled(), isVaultLocked(), isMigrateRunning(), lockGen()
 *   fileExists(path), fileStat(path) -> { size, mtimeMs } | null
 *   onFinish({ from, to, files, fallbacks, ms })   after the re-sort
 *   onBatch(mediaIds)   after each batch of re-read files
 *   workers, now, retryMs
 */
function createModelSwitch(deps) {
  const {
    database, store, target, withEngine, framesOf, recheck, settings,
    enabled = () => true, isVaultLocked = () => false, isMigrateRunning = () => false, lockGen = () => 0,
    fileExists = require('fs').existsSync, fileStat = defaultStat,
    onFinish = () => {}, onBatch = () => {}, workers = 2, now = Date.now, retryMs = RETRY_MS,
  } = deps;
  let statusCache = null;       // { at, key, counts }
  let running = null;
  let again = false;
  let timer = null;
  let token = 0;
  let current = new Map();      // media id -> filename (in flight)
  const times = [];             // ms per finished file (this process)
  let lastError = null;

  /* ── persisted state ───────────────────────────────────────────────── */

  function readJson(key) {
    try { const v = store.getMeta(key); return v ? JSON.parse(v) : null; } catch { return null; }
  }
  function readState() { return readJson(META_KEY); }
  function writeState(st) { store.setMeta(META_KEY, st ? JSON.stringify(st) : null); }
  function readLast() { return readJson(LAST_KEY); }

  /*
   * Files the job could not read, kept across switches and restarts
   * (face_meta model_switch_failed): media id -> { reason, path, size,
   * mtimeMs, at }. Such a file stays in its old model (still listed and
   * searched there) and is "stuck": no switch starts for it alone. It is
   * tried again when it changes on disk (path, size or mtime) or on retry().
   */
  function readFailed() { return readJson(FAILED_KEY) || {}; }
  function writeFailed(f) { store.setMeta(FAILED_KEY, Object.keys(f).length ? JSON.stringify(f) : null); }
  function identity(path) { const st = fileStat(path); return st ? { size: st.size, mtimeMs: st.mtimeMs } : { size: null, mtimeMs: null }; }

  /**
   * The stuck files for a switch toward `to` (still in another switchable
   * model, unchanged since they failed). Entries for files that moved on,
   * went away or changed on disk are dropped (changed ones get retried).
   * @returns {Set<number>}
   */
  function stuckIds(to) {
    const failed = readFailed();
    const ids = Object.keys(failed);
    if (!ids.length) return new Set();
    const out = new Set();
    let dirty = false;
    const q = database.get().prepare('SELECT filepath, faces_model FROM media WHERE id = ?');
    for (const k of ids) {
      const f = failed[k];
      const row = q.get(Number(k));
      const pending = row && row.faces_model && row.faces_model !== to && SWITCHABLE.includes(row.faces_model);
      const idn = row ? identity(row.filepath) : null;
      if (!pending || row.filepath !== f.path || idn.size !== f.size || idn.mtimeMs !== f.mtimeMs) { delete failed[k]; dirty = true; continue; }
      out.add(Number(k));
    }
    if (dirty) writeFailed(failed);
    return out;
  }

  function markFailed(mediaId, reason) {
    const row = database.get().prepare('SELECT filepath FROM media WHERE id = ?').get(mediaId);
    if (!row) return;
    const failed = readFailed();
    failed[mediaId] = { reason: String(reason || 'could not be read').slice(0, 200), path: row.filepath, ...identity(row.filepath), at: new Date(now()).toISOString() };
    const keys = Object.keys(failed);
    if (keys.length > FAILED_MAX) for (const k of keys.slice(0, keys.length - FAILED_MAX)) delete failed[k];
    writeFailed(failed);
    statusCache = null;
  }

  /** Models (other than `to`) that indexed files are still in, with counts. */
  function pendingMix(to) {
    const mix = store.modelMix();
    const out = new Map();
    for (const [m, n] of mix) if (m !== to && SWITCHABLE.includes(m)) out.set(m, n);
    return out;
  }

  function blocked() {
    return !enabled() || isVaultLocked() || isMigrateRunning();
  }

  /* ── scheduling ────────────────────────────────────────────────────── */

  function schedule(delay = 0) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; kick(); }, delay);
    timer.unref?.();
  }

  function kick() {
    if (running) { again = true; return running; }
    const my = ++token;
    running = loop(my).catch((err) => {
      lastError = String(err && err.message || err);
      console.warn(`[Faces] model switch stopped: ${lastError}`);
    }).finally(() => {
      running = null;
      if (again) { again = false; schedule(0); }
    });
    return running;
  }

  /** Stop at the next file (vault lock, feature off, delete-all). Running files write nothing after a lock. */
  function suspend() { token++; current.clear(); }

  async function settled() {
    while (running || timer) {
      if (running) await running.catch(() => {});
      else await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Try the stuck files again now (the user asks; also any later switch). */
  function retry() {
    writeFailed({});
    statusCache = null;
    schedule(0);
  }

  /* ── the job ───────────────────────────────────────────────────────── */

  const COUNTERS = ['reembedded', 'swapped', 'noFaces', 'fallbacks', 'failed'];

  async function loop(my) {
    if (blocked()) {
      if (isMigrateRunning() && enabled() && !isVaultLocked()) schedule(retryMs);
      return;
    }
    const to = target();
    if (!to) return;
    let st = readState();
    // A finish a crash or a lock interrupted: complete it first.
    if (st && st.finishing) { await finish(st); return; }
    let mix = pendingMix(to);
    let stuck = stuckIds(to);
    const todo = () => [...mix.values()].reduce((a, b) => a + b, 0) - stuck.size;
    if (!st || st.to !== to) {
      if (todo() <= 0) {
        // Nothing to re-read (at most stuck files). An abandoned switch (the
        // choice went back to the model files are in) only drops the vectors
        // it left waiting; people are re-sorted only if files moved.
        if (st) await finish({ ...st, to, finishing: true });
        else if (hasPrev()) store.dropPrevVectors();
        return;
      }
      const from = [...mix].sort((x, y) => y[1] - x[1])[0][0];
      st = { from, to, total: todo(), paused: false, startedAt: new Date(now()).toISOString(),
        counts: Object.fromEntries(COUNTERS.map((k) => [k, 0])) };
      writeState(st);
      times.length = 0;
      console.log(`[Faces] model switch ${from} -> ${to}: ${st.total} file(s) to re-read`);
    }
    if (st.paused) return;
    const counts = { ...Object.fromEntries(COUNTERS.map((k) => [k, 0])), ...(st.counts || {}) };
    const saveCounts = () => {
      const cur = readState();
      if (cur && cur.to === to && !cur.finishing) { cur.counts = { ...counts }; writeState(cur); }
    };
    const gen = lockGen();
    // Order (owner's rule): files holding a NAMED person's face first, then a
    // favorite's, then the rest, so named people are matchable in the new
    // model early. Within a tier by media id. A file that changed under us
    // ('retry') is seen again on the next pass, a stuck one is skipped.
    let tier = 0, cursor = 0, progressed = false, retried = false;
    for (;;) {
      if (my !== token || gen !== lockGen() || blocked()) {
        if (my === token && isMigrateRunning() && !isVaultLocked() && enabled()) schedule(retryMs);
        return;
      }
      st = readState();
      if (!st || st.paused || target() !== to || st.to !== to) { if (st && target() !== to) again = true; return; }
      mix = pendingMix(to);
      const batch = store.filesInModels([...mix.keys()], { after: cursor, limit: 200, tier: TIERS[tier] });
      if (!batch.length) {
        if (tier < TIERS.length - 1) { tier++; cursor = 0; continue; }
        if (retried && progressed) { tier = 0; cursor = 0; progressed = false; retried = false; continue; }
        break;
      }
      cursor = batch[batch.length - 1];
      const ids = batch.filter((id) => !stuck.has(id));
      if (!ids.length) continue;
      // `workers` files at a time; each one through withEngine (pool).
      let next = 0;
      const doneIds = [];
      const lane = async () => {
        while (next < ids.length) {
          if (my !== token || gen !== lockGen() || blocked()) return;
          const cur = readState();
          if (!cur || cur.paused || target() !== to) return;
          const id = ids[next++];
          const t = now();
          let res;
          try { res = await oneFile(id, to, my, gen); } catch (err) {
            if (my !== token || gen !== lockGen()) return;
            lastError = String(err && err.message || err);
            console.warn(`[Faces] model switch: file ${id} failed: ${lastError}`);
            res = { fail: lastError };
          }
          // A file that moved is counted even if the run was stopped meanwhile.
          if (res && res.kind && gen === lockGen()) { counts[res.kind]++; saveCounts(); }
          if (my !== token || gen !== lockGen()) return;
          if (res === 'retry') { retried = true; continue; }
          if (res && res.fail) {
            counts.failed++;
            saveCounts();
            markFailed(id, res.fail);
            stuck.add(id);
            continue;
          }
          progressed = true; doneIds.push(id); times.push(now() - t); if (times.length > 50) times.shift();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, workers) }, lane));
      if (my !== token || gen !== lockGen()) return;
      // After each batch: unsorted faces may now join the people re-read so far
      // (the service marks those people fresh and wakes the sorting job; it only
      // ever sorts unassigned groups, so named people never lose a face).
      if (doneIds.length) { try { onBatch(doneIds); } catch { /* listener */ } }
    }
    if (my !== token || gen !== lockGen()) return;
    st = readState();
    if (!st || st.to !== to || st.paused) return;
    // Files that kept changing under us: not done yet, try again shortly.
    stuck = stuckIds(to);
    const left = store.filesInModels([...pendingMix(to).keys()], { limit: FAILED_MAX + 1 }).filter((id) => !stuck.has(id));
    if (left.length) { schedule(retryMs); return; }
    await finish({ ...st, counts, finishing: true });
  }

  function hasPrev() {
    try { return !!database.get().prepare('SELECT 1 FROM face_vectors_prev LIMIT 1').get(); } catch { return false; }
  }

  /**
   * The switch is over. Steps, persisted (state.finishing) so a crash or a
   * lock in the middle resumes here: drop the old vectors, re-sort people
   * (only when files actually moved in this switch), record the summary,
   * then clear the state.
   */
  async function finish(st) {
    writeState({ ...st, finishing: true });
    store.dropPrevVectors();
    const c = st.counts || {};
    const moved = (c.reembedded || 0) + (c.swapped || 0) + (c.fallbacks || 0);
    let resorted = null;
    if (moved > 0) resorted = resort(st.to);
    const startedAt = Date.parse(st.startedAt) || now();
    const info = { from: st.from || null, to: st.to, files: st.total || 0, fallbacks: c.fallbacks || 0, swapped: c.swapped || 0,
      reembedded: c.reembedded || 0, noFaces: c.noFaces || 0, failed: c.failed || 0, stuck: safeStuck(st.to),
      resorted: !!resorted, ms: Math.max(0, now() - startedAt), finishedAt: new Date(now()).toISOString() };
    try { store.setMeta(LAST_KEY, JSON.stringify(info)); } catch { /* DB closed */ }
    writeState(null);
    statusCache = null;
    console.log(`[Faces] model switch -> ${st.to} done: ${info.files} file(s), ${info.reembedded} re-read, ${info.swapped} swapped back, ${info.noFaces} without faces, ${info.fallbacks} checked again, ${info.stuck} could not be read, ${Math.round(info.ms / 1000)} s`);
    try { onFinish(info); } catch { /* listener */ }
  }

  function safeStuck(to) { try { return stuckIds(to).size; } catch { return 0; } }

  /**
   * People again in the new model (see the header). One transaction.
   * @returns {{ dissolved: number, released: number }}
   */
  function resort(to = target()) {
    const db = database.get();
    const out = db.transaction(() => {
      const ids = db.prepare(`SELECT p.id FROM face_people p
        WHERE p.name IS NULL AND p.favorite = 0 AND p.hidden = 0 AND p.cover_group_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM face_groups g WHERE g.cluster_id = p.id AND g.person_locked = 1)
          AND NOT EXISTS (SELECT 1 FROM studio_people s WHERE s.person_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM face_pair_decisions d WHERE d.a = p.id OR d.b = p.id)
          AND NOT EXISTS (SELECT 1 FROM face_person_rejects r WHERE r.person_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM face_groups g WHERE g.cluster_id = p.id AND g.model <> ?)`).all(to).map((r) => r.id);
      const free = db.prepare('UPDATE face_groups SET cluster_id = NULL, person_locked = 0, sort_held = 0 WHERE cluster_id = ?');
      for (const id of ids) free.run(id);
      store.pruneEmptyPeople(db, ids);
      // Held (unclear) faces: sorted again too (held again if still unclear).
      const released = db.prepare('UPDATE face_groups SET sort_held = 0 WHERE sort_held = 1 AND cluster_id IS NULL').run().changes;
      // Every "Same person?" pair is scored again in the new model.
      db.prepare("DELETE FROM face_meta WHERE key = 'suggest_rule'").run();
      // Faces the job put in the people that stay (named ones, say) are
      // checked again under the join rule, now with the new model's vectors.
      db.prepare("DELETE FROM face_meta WHERE key IN ('join_rule', 'join_recheck')").run();
      return { dissolved: ids.length, released };
    })();
    store.bumpPeople();
    store.emit('modelSwitch');
    return out;
  }

  /**
   * Re-read one file into `to`. { kind } = done ('reembedded', 'swapped',
   * 'noFaces', 'fallbacks', or null for nothing to do), { fail: reason } =
   * could not (file gone from disk, decode failed), 'retry' = the file
   * changed while we read it, or the run was stopped (next pass / next run).
   */
  async function oneFile(mediaId, to, my, gen) {
    const snap = store.switchSnapshot(mediaId);
    if (!snap) return { kind: null };             // deleted meanwhile
    const { media, groups } = snap;
    if (media.faces_model === to) return { kind: null };
    current.set(mediaId, media.filename);
    try {
      const expect = new Map(groups.map((g) => [g.id, g.model]));
      const moving = groups.filter((g) => g.model !== to);
      if (moving.every((g) => g.prev.get(to) > 0)) {
        if (store.switchFileModel(mediaId, to, { expect, fromPrev: true })) return { kind: moving.length ? 'swapped' : 'noFaces' };
        return 'retry';                           // changed meanwhile
      }
      const kind = store.kindOf(media);
      if (!kind) return { fail: 'not a photo, GIF or video any more' };
      if (!fileExists(media.filepath)) return { fail: 'file not found' };
      return await withEngine(async (eng) => {
        if (my !== token || gen !== lockGen()) return 'retry';
        const found = await reembed(eng, media, kind, moving, to);
        if (my !== token || gen !== lockGen()) return 'retry';
        const lost = moving.filter((g) => !(found.get(g.id) || []).length);
        if (!lost.length) {
          if (store.switchFileModel(mediaId, to, { expect, newVecs: found })) return { kind: 'reembedded' };
          return 'retry';                         // changed meanwhile: the next pass sees it again
        }
        // A face we can no longer find where it was: check the whole file again.
        await recheck(media, eng);
        if (my !== token || gen !== lockGen()) return 'retry';
        const after = database.get().prepare('SELECT faces_model, faces_error FROM media WHERE id = ?').get(mediaId);
        if (!after) return { kind: null };
        return after.faces_model === to ? { kind: 'fallbacks' } : { fail: after.faces_error || 'the file could not be checked again' };
      });
    } finally {
      current.delete(mediaId);
    }
  }

  /** Map group id -> [{ embedding, frameTimeS, bbox (stored text), detScore, norm }] for every exemplar found again. */
  async function reembed(eng, media, kind, moving, to) {
    const frames = framesOf(eng);
    const out = new Map(moving.map((g) => [g.id, []]));
    const wanted = [];                            // { group, ex }
    for (const g of moving) for (const ex of g.vectors) wanted.push({ g, ex });
    const onFrame = async (frame, at) => {
      const here = wanted.filter((w) => (at == null ? w.ex.frameTimeS == null : w.ex.frameTimeS != null && Math.abs(w.ex.frameTimeS - at) < TIME_EPS));
      if (!here.length) return;
      const dets = await eng.detect(frame, { minScore: DETECT_MIN_SCORE, minFacePx: 0 });
      for (const w of here) {
        let best = null, bi = 0;
        for (const d of dets) { const v = iou(d.bbox, w.ex.bbox); if (v > bi) { bi = v; best = d; } }
        if (!best || bi < MATCH_IOU) continue;
        const embedding = await eng.embedKeeper(frame, best, to);
        out.get(w.g.id).push({ embedding, frameTimeS: w.ex.frameTimeS, bbox: w.ex.bboxText, detScore: w.ex.detScore, norm: w.ex.norm });
      }
    };
    if (kind !== 'video') {
      await onFrame(await frames.decodeImage(media.filepath, {}), null);
      return out;
    }
    const times = [...new Set(wanted.map((w) => w.ex.frameTimeS).filter((t) => t != null))].sort((a, b) => a - b);
    if (!times.length) return out;
    const last = times[times.length - 1];
    const dur = Number(media.duration_seconds) > 0 ? Number(media.duration_seconds) : undefined;
    let step = Number(media.faces_interval_s);
    if (!(step > 0)) {
      const s = settings();
      step = dur ? Math.max(s.intervalS, dur / s.maxFrames) : s.intervalS;
    }
    // The stored spacing IS the step indexing used (max(intervalS, duration /
    // maxFrames)); a huge maxFrames keeps sampleVideo from widening it again.
    const it = frames.sampleVideo(media.filepath, { intervalS: step, maxFrames: BIG_FRAMES, durationS: dur });
    for await (const { timeS, frame } of it) {
      await onFrame(frame, timeS);
      if (timeS >= last - TIME_EPS) break;        // stops ffmpeg
    }
    return out;
  }

  /* ── controls and status ───────────────────────────────────────────── */

  function setPaused(paused) {
    const st = readState();
    if (!st) return status();
    st.paused = !!paused;
    writeState(st);
    statusCache = null;
    if (paused) token++;
    else schedule(0);
    return status();
  }

  /**
   * { from, to, done, total, paused, running, etaS, current: [filename], fallbacks, failed, stuck,
   * namedDone, namedTotal, finishing, idle } while a switch is pending; with no switch
   * pending but files it could not read, { idle: true, stuck: n, ... } (the UI says
   * "n files could not be read"; stuckFiles() lists them); else null.
   * lastSwitch: the last finished one (persisted).
   */
  function status() {
    let st = null;
    try { st = readState(); } catch { return null; }
    if (!st) {
      // No switch running, but files it could not read are still in their old model.
      const to = target();
      let stuck = 0;
      try { stuck = to ? stuckIds(to).size : 0; } catch { return null; }
      if (!stuck) return null;
      return { from: null, to, done: 0, total: stuck, paused: false, running: false, idle: true, etaS: null, current: [],
        fallbacks: 0, failed: stuck, stuck, namedDone: null, namedTotal: null };
    }
    // Counts are index scans: at most one every STATUS_TTL_MS (status is polled),
    // every STATUS_TTL_RUNNING_MS while the job runs (done and namedDone move).
    const ttl = running && !st.paused ? STATUS_TTL_RUNNING_MS : STATUS_TTL_MS;
    let c = statusCache && statusCache.key === st.to && now() - statusCache.at < ttl ? statusCache.counts : null;
    if (!c) {
      try {
        c = { pending: [...pendingMix(st.to).values()].reduce((a, b) => a + b, 0), named: store.namedProgress(st.to), stuck: stuckIds(st.to).size };
      } catch { return null; }
      statusCache = { at: now(), key: st.to, counts: c };
    }
    const remaining = Math.max(0, c.pending - c.stuck);
    const total = Math.max(st.total || 0, remaining);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    return {
      from: st.from, to: st.to, done: total - remaining, total, paused: !!st.paused,
      running: !!running && !st.paused, startedAt: st.startedAt,
      etaS: avg == null || st.paused ? null : Math.round((remaining * avg) / 1000 / Math.max(1, workers)),
      current: [...current.values()], fallbacks: (st.counts || {}).fallbacks || 0, failed: (st.counts || {}).failed || 0,
      stuck: c.stuck, finishing: !!st.finishing, idle: false,
      // Named people whose every face is in the new model (they go first).
      namedDone: c.named.total - c.named.pending, namedTotal: c.named.total,
    };
  }

  /** The files the job could not read (stuck in their old model), with why. */
  function stuckFiles() {
    const to = target();
    if (!to) return [];
    const ids = stuckIds(to);
    const failed = readFailed();
    const q = database.get().prepare('SELECT filename, faces_model FROM media WHERE id = ?');
    return [...ids].map((id) => ({ mediaId: id, filename: q.get(id)?.filename ?? null, model: q.get(id)?.faces_model ?? null,
      reason: failed[id]?.reason ?? null, at: failed[id]?.at ?? null }));
  }

  return {
    schedule, kick, suspend, settled, status, setPaused, resort, retry, stuckFiles,
    lastSwitch: readLast, isRunning: () => !!running, lastError: () => lastError,
    _pendingMix: pendingMix,
  };
}

module.exports = { createModelSwitch, MATCH_IOU };
