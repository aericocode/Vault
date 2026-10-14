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
 * and every "Same person?" pair is scored again. Named, favorite and hidden
 * people, people with faces a user placed (merges, adds), decisions,
 * rejects, a chosen cover or a studio stay exactly as they are.
 *
 * State (face_meta 'model_switch', JSON): { from, to, total, paused,
 * startedAt, failed: [media ids] }. Progress itself is the data (files still
 * in another model), so a restart resumes where it stopped. Paused survives
 * restarts. Guards: a vault lock stops it at once (lock generation, engines
 * dropped by the service), a library migrate defers it, feature off stops it.
 */

const { SWITCHABLE } = require('./models');

const MATCH_IOU = 0.8;
const TIME_EPS = 1e-3;
const DETECT_MIN_SCORE = 0.5;     // lenient: we look for a face we already found at >= 0.80
const RETRY_MS = 5000;
const META_KEY = 'model_switch';
const LAST_KEY = 'model_switch_last';
const FAILED_MAX = 5000;
const BIG_FRAMES = 1e6;
const TIERS = Object.freeze(['named', 'favorite', 'rest']);
const STATUS_TTL_MS = 2000;

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
 *   fileExists(path)
 *   onFinish({ from, to, files, fallbacks, ms })   after the re-sort
 *   workers, now
 */
function createModelSwitch(deps) {
  const {
    database, store, target, withEngine, framesOf, recheck, settings,
    enabled = () => true, isVaultLocked = () => false, isMigrateRunning = () => false, lockGen = () => 0,
    fileExists = require('fs').existsSync, onFinish = () => {}, onBatch = () => {}, workers = 2, now = Date.now, retryMs = RETRY_MS,
  } = deps;
  let statusCache = null;       // { at, key, counts }
  let running = null;
  let again = false;
  let timer = null;
  let token = 0;
  let current = new Map();      // media id -> filename (in flight)
  const times = [];             // ms per finished file (this process)
  let fallbacks = 0, swapped = 0, reembedded = 0, empty = 0, lastError = null;

  /* ── persisted state ───────────────────────────────────────────────── */

  function readState() {
    try { const v = store.getMeta(META_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
  }
  function writeState(st) { store.setMeta(META_KEY, st ? JSON.stringify(st) : null); }
  function readLast() {
    try { const v = store.getMeta(LAST_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
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

  /* ── the job ───────────────────────────────────────────────────────── */

  async function loop(my) {
    if (blocked()) {
      if (isMigrateRunning() && enabled() && !isVaultLocked()) schedule(retryMs);
      return;
    }
    const to = target();
    if (!to) return;
    let st = readState();
    let mix = pendingMix(to);
    const failed = new Set(st && st.to === to ? st.failed || [] : []);
    const todo = () => [...mix.values()].reduce((a, b) => a + b, 0);
    if (!st || st.to !== to) {
      if (!todo()) {
        // Nothing to re-read; only clean up what a finished/abandoned switch left.
        if (st) { writeState(null); }
        if (st || hasPrev()) await finish({ from: st?.from || null, to, files: 0, startedAt: now() });
        return;
      }
      const from = [...mix].sort((a, b) => b[1] - a[1])[0][0];
      st = { from, to, total: todo(), paused: false, startedAt: new Date(now()).toISOString(), failed: [] };
      writeState(st);
      fallbacks = 0; swapped = 0; reembedded = 0; empty = 0; times.length = 0;
      console.log(`[Faces] model switch ${from} -> ${to}: ${st.total} file(s) to re-read`);
    }
    if (st.paused) return;
    const gen = lockGen();
    const t0 = now();
    // Order (owner's rule): files holding a NAMED person's face first, then a
    // favorite's, then the rest, so named people are matchable in the new
    // model early. Within a tier by media id. A file that changed under us
    // ('retry') is seen again on the next pass, a failed one is skipped.
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
      const ids = batch.filter((id) => !failed.has(id));
      if (!ids.length) continue;
      // `workers` files at a time; each one through withEngine (pool).
      let next = 0;
      const doneIds = [];
      const lane = async () => {
        while (next < ids.length) {
          if (my !== token || gen !== lockGen() || blocked()) return;
          const s = readState();
          if (!s || s.paused || target() !== to) return;
          const id = ids[next++];
          const t = now();
          let ok = false;
          try { ok = await oneFile(id, to, my, gen); } catch (err) {
            if (my !== token || gen !== lockGen()) return;
            lastError = String(err && err.message || err);
            console.warn(`[Faces] model switch: file ${id} failed: ${lastError}`);
          }
          if (my !== token || gen !== lockGen()) return;
          if (ok === 'retry') { retried = true; continue; }
          if (ok) { progressed = true; doneIds.push(id); times.push(now() - t); if (times.length > 50) times.shift(); }
          else {
            failed.add(id);
            const cur = readState();
            if (cur && cur.to === to) { cur.failed = [...failed].slice(-FAILED_MAX); writeState(cur); }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, workers) }, lane));
      // After each batch: unsorted faces may now join the people re-read so far
      // (the service marks those people fresh and wakes the sorting job; it only
      // ever sorts unassigned groups, so named people never lose a face).
      if (doneIds.length && my === token && gen === lockGen()) { try { onBatch(doneIds); } catch { /* listener */ } }
    }
    if (my !== token || gen !== lockGen()) return;
    st = readState();
    if (!st || st.to !== to || st.paused) return;
    // Files that kept changing under us: not done yet, try again shortly.
    const left = store.filesInModels([...pendingMix(to).keys()], { limit: FAILED_MAX + 1 }).filter((id) => !failed.has(id));
    if (left.length) { schedule(retryMs); return; }
    writeState(null);
    await finish({ from: st.from, to, files: st.total, startedAt: Date.parse(st.startedAt) || t0, failed: failed.size });
  }

  function hasPrev() {
    try { return !!database.get().prepare('SELECT 1 FROM face_vectors_prev LIMIT 1').get(); } catch { return false; }
  }

  async function finish({ from, to, files, startedAt, failed = 0 }) {
    store.dropPrevVectors();
    resort();
    const info = { from, to, files, fallbacks, swapped, reembedded, noFaces: empty, failed, ms: Math.max(0, now() - startedAt), finishedAt: new Date(now()).toISOString() };
    try { store.setMeta(LAST_KEY, JSON.stringify(info)); } catch { /* DB closed */ }
    console.log(`[Faces] model switch -> ${to} done: ${files} file(s), ${reembedded} re-read, ${swapped} swapped back, ${empty} without faces, ${fallbacks} checked again, ${failed} failed, ${Math.round(info.ms / 1000)} s`);
    try { onFinish(info); } catch { /* listener */ }
  }

  /**
   * People again in the new model (see the header). One transaction.
   * @returns {{ dissolved: number, released: number }}
   */
  function resort() {
    const db = database.get();
    const out = db.transaction(() => {
      const ids = db.prepare(`SELECT p.id FROM face_people p
        WHERE p.name IS NULL AND p.favorite = 0 AND p.hidden = 0 AND p.cover_group_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM face_groups g WHERE g.cluster_id = p.id AND g.person_locked = 1)
          AND NOT EXISTS (SELECT 1 FROM studio_people s WHERE s.person_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM face_pair_decisions d WHERE d.a = p.id OR d.b = p.id)
          AND NOT EXISTS (SELECT 1 FROM face_person_rejects r WHERE r.person_id = p.id)`).all().map((r) => r.id);
      const free = db.prepare('UPDATE face_groups SET cluster_id = NULL, person_locked = 0, sort_held = 0 WHERE cluster_id = ?');
      for (const id of ids) free.run(id);
      store.pruneEmptyPeople(db, ids);
      // Held (unclear) faces: sorted again too (held again if still unclear).
      const released = db.prepare('UPDATE face_groups SET sort_held = 0 WHERE sort_held = 1 AND cluster_id IS NULL').run().changes;
      // Every "Same person?" pair is scored again in the new model.
      db.prepare("DELETE FROM face_meta WHERE key = 'suggest_rule'").run();
      return { dissolved: ids.length, released };
    })();
    store.bumpPeople();
    store.emit('modelSwitch');
    return out;
  }

  /**
   * Re-read one file into `to`. true = done (moved, swapped, re-checked, or
   * nothing to do), false = could not (file gone from disk, decode failed),
   * 'retry' = the file changed while we read it (try again next pass).
   */
  async function oneFile(mediaId, to, my, gen) {
    const snap = store.switchSnapshot(mediaId);
    if (!snap) return true;                       // deleted meanwhile
    const { media, groups } = snap;
    if (media.faces_model === to) return true;
    current.set(mediaId, media.filename);
    try {
      const expect = new Map(groups.map((g) => [g.id, g.model]));
      const moving = groups.filter((g) => g.model !== to);
      if (moving.every((g) => g.prev.get(to) > 0)) {
        if (store.switchFileModel(mediaId, to, { expect, fromPrev: true })) { if (moving.length) swapped++; else empty++; return true; }
        return 'retry';                           // changed meanwhile
      }
      const kind = store.kindOf(media);
      if (!kind || !fileExists(media.filepath)) return false;
      return await withEngine(async (eng) => {
        if (my !== token || gen !== lockGen()) return false;
        const found = await reembed(eng, media, kind, moving, to);
        if (my !== token || gen !== lockGen()) return false;
        const lost = moving.filter((g) => !(found.get(g.id) || []).length);
        if (!lost.length) {
          if (store.switchFileModel(mediaId, to, { expect, newVecs: found })) { reembedded++; return true; }
          return 'retry';                         // changed meanwhile: the next pass sees it again
        }
        // A face we can no longer find where it was: check the whole file again.
        await recheck(media, eng);
        if (my !== token || gen !== lockGen()) return false;
        fallbacks++;
        const after = database.get().prepare('SELECT faces_model FROM media WHERE id = ?').get(mediaId);
        return !!after && after.faces_model === to;
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
   * { from, to, done, total, paused, running, etaS, current: [filename], fallbacks, failed } while a
   * switch is pending, else null. lastSwitch: the last finished one.
   */
  function status() {
    let st = null;
    try { st = readState(); } catch { return null; }
    if (!st) return null;
    // Counts are index scans: at most one every STATUS_TTL_MS (status is polled).
    let c = statusCache && statusCache.key === st.to && now() - statusCache.at < STATUS_TTL_MS ? statusCache.counts : null;
    if (!c) {
      try {
        c = { pending: [...pendingMix(st.to).values()].reduce((a, b) => a + b, 0), named: store.namedProgress(st.to) };
      } catch { return null; }
      statusCache = { at: now(), key: st.to, counts: c };
    }
    const remaining = Math.max(0, c.pending - (st.failed || []).length);
    const total = Math.max(st.total || 0, remaining);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    return {
      from: st.from, to: st.to, done: total - remaining, total, paused: !!st.paused,
      running: !!running && !st.paused, startedAt: st.startedAt,
      etaS: avg == null || st.paused ? null : Math.round((remaining * avg) / 1000 / Math.max(1, workers)),
      current: [...current.values()], fallbacks, failed: (st.failed || []).length,
      // Named people whose every face is in the new model (they go first).
      namedDone: c.named.total - c.named.pending, namedTotal: c.named.total,
    };
  }

  return {
    schedule, kick, suspend, settled, status, setPaused, resort,
    lastSwitch: readLast, isRunning: () => !!running, lastError: () => lastError,
    _pendingMix: pendingMix,
  };
}

module.exports = { createModelSwitch, MATCH_IOU };
