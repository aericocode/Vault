/**
 * Face search service: settings, models, the indexing queue, search and the
 * query-face cache, wired together (FACES_BUILD_SPEC sections 3 to 7).
 *
 * The engine layer (frames.js / engine.js / analyze.js, spec section 2) is
 * reached ONLY through injected dependencies whose production defaults require
 * those modules lazily, at call time. Tests pass fakes that follow the
 * section 2 contract; nothing here loads a model or touches the network.
 *
 * instance() is the process-wide service the routes and server hooks use;
 * setInstance() swaps it (tests).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { createIndex } = require('./index-mem');
const { createQueue } = require('./queue');
const { thresholdFor, peopleThresholds, WIDTHS } = require('./thresholds');
const downloadLib = require('./download');
const { createEnginePool } = require('./engine-pool');
const people = require('./people');
const { createSorter } = require('./people-sort');
const candidates = require('./candidates');

// The UI's quick picks; any multiple of 0.5 s in [MIN_INTERVAL_S, MAX_INTERVAL_S] is valid.
const INTERVALS = Object.freeze([2, 3.5, 10]);
const DEFAULT_INTERVAL_S = 3.5;
const MIN_INTERVAL_S = 0.5;
const MAX_INTERVAL_S = 120;
const MAX_FRAMES = 2000;            // default "most frames per video"
const MIN_MAX_FRAMES = 100;
const MAX_MAX_FRAMES = 20000;
const PEOPLE_LIMIT_MAX = 500;
const REVIEW_LIMIT_MAX = 200;
const FACES_LIMIT_MAX = 50;
const MERGE_MAX = 50;
const ADD_MAX = 2000;
const ANSWER_MAX = 500;
const CANDIDATES_LIMIT_MAX = 100;
const MAX_SIDE = 1280;
const QUERY_TTL_MS = 15 * 60 * 1000;
const QUERY_MAX = 50;
const COUNTS_TTL_MS = 3000;
const MAX_TIME_S = 1e7;   // no duration on record: reject anything past ~115 days
const FACE_KEYS = Object.freeze(['face:detect', 'face:embed']);
const QUEUE_WORKERS = 2;
const ENGINE_THREADS = 2;                  // ORT intra-op threads per engine (best for 2 workers)
const QUEUE_IDLE_MS = 2 * 60 * 1000;       // close idle queue engines after 2 min
const INTERACTIVE_IDLE_MS = 5 * 60 * 1000; // and the interactive one after 5 min

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code }, extra);
}

/**
 * analyze.js, required on first use. Literal require() calls on purpose: the
 * exe bundles with esbuild, which only follows string-literal requires (a
 * require(variable) fails at run time inside the SEA with "No such built-in
 * module").
 */
const lazyAnalyze = {
  analyzeFile: (...a) => require('./analyze').analyzeFile(...a),
  analyzeFrame: (...a) => require('./analyze').analyzeFrame(...a),
};

/** Production model store: the registry in models.js, files under faceModelDir(). */
function defaultModelStore() {
  return downloadLib.createFileModelStore(() => require('./models').downloadEntries());
}

function createService(deps = {}) {
  const database = deps.database || require('../database');
  const settings = deps.settings || require('../app-settings');
  const consent = deps.consent || require('../model-consent');
  const modelStore = deps.modelStore || defaultModelStore();
  // One onnx engine = one worker thread running one call at a time.
  const engineFactory = deps.engineFactory
    || ((opts) => require('./engine').createEngine({ backend: 'onnx', threads: ENGINE_THREADS, ...opts }));
  const analyze = deps.analyze || lazyAnalyze;
  // Frame source: injected (tests) or the engine's own (engine.frames), so a
  // stub engine never needs ffmpeg.
  const framesOf = (eng) => deps.frames || eng.frames || require('./frames');
  const download = deps.download || downloadLib;
  const fetchImpl = deps.fetchImpl;   // undefined -> netFetch
  const now = deps.now || Date.now;
  const fileExists = deps.fileExists || fs.existsSync;
  const tmpRoot = deps.tmpDir || os.tmpdir();
  const isMigrateRunning = deps.isMigrateRunning || (() => _migrateProbe());
  const isVaultLocked = deps.isVaultLocked || (() => { try { return require('../vault').isLocked(); } catch { return false; } });

  const index = createIndex({ getDb: () => database.get() });
  // Screen time of faces found before screen_s was stored uses the current spacing.
  people.setSpacingSource(() => getSettings());
  // People across the library: the background sorting job (people-sort.js).
  const sorter = createSorter({
    database, store,
    enabled: () => { try { return getSettings().enabled; } catch { return false; } },
    isVaultLocked: () => isVaultLocked(), isMigrateRunning: () => isMigrateRunning(),
    debounceMs: deps.peopleDebounceMs ?? 1500, now,
  });
  const workers = deps.workers || QUEUE_WORKERS;
  const queue = createQueue({ runFile, workers, now });
  // Engines: one per queue worker, plus one for interactive requests (find
  // faces now, search by photo/frame) so a click never waits behind a long
  // background video. Lazy, closed when idle; see engine-pool.js.
  const makeEngine = () => engineFactory({ modelPaths: models().paths });
  const queueEngines = createEnginePool({ factory: makeEngine, size: workers, idleMs: deps.queueIdleMs || QUEUE_IDLE_MS });
  // Interactive work has two lanes with an engine each, so "find people in
  // this frame" (and find-faces on a photo or GIF) never waits behind "find
  // faces in this file" on a long video. Frame lane: one-frame work; file lane: videos.
  const frameEngines = createEnginePool({ factory: makeEngine, size: 1, idleMs: deps.interactiveIdleMs || INTERACTIVE_IDLE_MS });
  const fileEngines = createEnginePool({ factory: makeEngine, size: 1, idleMs: deps.interactiveIdleMs || INTERACTIVE_IDLE_MS });
  const queries = new Map();   // queryId -> { embedding, bbox, crop, at }
  let cachedModelId = null;
  // Bumped by onVaultLocked. Anything awaited that is about to write face data
  // (query cache, DB) compares it first: a lock during the await means the
  // result is dropped and the caller gets 423, never a write after the lock.
  let lockGen = 0;
  let deleting = null;         // the running deleteAll(), clicks wait for it before answering
  function lockedError() { return httpError(423, 'VAULT_LOCKED', 'vault is locked'); }
  function assertSameLock(gen) { if (gen !== lockGen) throw lockedError(); }
  let dl = null;               // { running, received, total, error, code }
  let dlCtrl = null;
  let countsCache = null;      // { at, version, modelId, value }
  let autoSkipped = 0;

  /* ── Settings ─────────────────────────────────────────────────────────── */

  function validInterval(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= MIN_INTERVAL_S && v <= MAX_INTERVAL_S && Number.isInteger(v * 2);
  }
  function validMaxFrames(v) {
    return typeof v === 'number' && Number.isInteger(v) && v >= MIN_MAX_FRAMES && v <= MAX_MAX_FRAMES;
  }

  function getSettings() {
    const a = settings.all();
    return {
      enabled: a.facesEnabled === true,
      autoIndex: a.facesAutoIndex === true,
      intervalS: validInterval(a.facesIntervalS) ? a.facesIntervalS : DEFAULT_INTERVAL_S,
      maxFrames: validMaxFrames(a.facesMaxFrames) ? a.facesMaxFrames : MAX_FRAMES,
    };
  }

  function updateSettings(body = {}) {
    const patch = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw httpError(400, 'BAD_SETTING', 'enabled must be true or false');
      patch.facesEnabled = body.enabled;
    }
    if (body.autoIndex !== undefined) {
      if (typeof body.autoIndex !== 'boolean') throw httpError(400, 'BAD_SETTING', 'autoIndex must be true or false');
      patch.facesAutoIndex = body.autoIndex;
    }
    if (body.intervalS !== undefined) {
      const v = body.intervalS;
      if (!validInterval(v)) throw httpError(400, 'BAD_SETTING', `intervalS must be ${MIN_INTERVAL_S} to ${MAX_INTERVAL_S} seconds in steps of 0.5`);
      patch.facesIntervalS = v;
    }
    if (body.maxFrames !== undefined) {
      const v = body.maxFrames;
      if (!validMaxFrames(v)) throw httpError(400, 'BAD_SETTING', `maxFrames must be a whole number from ${MIN_MAX_FRAMES} to ${MAX_MAX_FRAMES}`);
      patch.facesMaxFrames = v;
    }
    if (Object.keys(patch).length) settings.set(patch);
    if (patch.facesEnabled === false) {
      queue.cancel({ includeDirect: true });   // off means off, clicks too
      sorter.cancel();
    }
    if (patch.facesEnabled === true) sorter.schedule();
    return status();
  }

  /* ── Models and engine ────────────────────────────────────────────────── */

  function models() {
    const s = modelStore.status() || {};
    return { ready: !!s.ready, missing: Array.isArray(s.missing) ? s.missing : [], reasons: s.reasons || {}, paths: s.paths || {} };
  }

  /** The current engine model id, or null while models are not available. */
  function modelId() {
    if (!models().ready) return null;
    // Constructing an engine loads nothing. Production engines report a fixed
    // id, so it is cached (reset by dropEngine); injected factories are asked
    // every time.
    if (cachedModelId && !deps.engineFactory) return cachedModelId;
    try {
      const e = makeEngine();
      cachedModelId = e.modelId || null;
      if (!deps.engineFactory) e.close?.();
    } catch { return null; }
    return cachedModelId;
  }

  function modelsMissingError(missing) {
    return httpError(409, 'FACE_MODELS_MISSING', 'Face search models are not downloaded yet.', { missing });
  }

  /** Run fn(engine) with a loaded engine from the given pool. */
  async function withEngine(pool, fn) {
    const m = models();
    if (!m.ready) throw modelsMissingError(m.missing);
    let eng;
    try {
      eng = await pool.acquire();
    } catch (err) {
      if (err.code === 'FACE_MODELS_MISSING') throw modelsMissingError(err.missing || m.missing);
      // Raw onnxruntime errors ("Protobuf parsing failed", ...) never reach the
      // client: log them, answer with a code the UI can act on.
      console.error(`[Faces] engine failed to start: ${err && err.message}`);
      throw httpError(503, 'FACE_ENGINE_FAILED', 'Face search could not load its models. Download them again in Settings.');
    }
    try { return await fn(eng); } finally { pool.release(eng); }
  }

  /** Models changed or memory should go: close idle engines now, busy ones on release. */
  function dropEngine() {
    cachedModelId = null;
    queueEngines.retire();
    frameEngines.retire();
    fileEngines.retire();
  }

  /** Defense in depth behind MIGRATE_BLOCKED_ROUTES: no indexing under a migrate. */
  function refuseDuringMigrate() {
    if (isMigrateRunning()) {
      throw httpError(409, 'MIGRATE_RUNNING', 'a library migration is running. Wait for it to finish.');
    }
  }

  function requireModels() {
    const m = models();
    if (!m.ready) throw httpError(409, 'FACE_MODELS_MISSING', 'Face search models are not downloaded yet.', { missing: m.missing });
  }

  function startDownload() {
    if (dl?.running) return status();
    const m = models();
    if (m.ready) return status();
    const entries = modelStore.entries() || [];
    try {
      download.preflight(entries, { consent });
    } catch (err) {
      if (err.code === 'CONSENT_NEEDED') {
        for (const key of err.keys) {
          try { consent.request(key, { kind: 'faces', label: 'face search models', why: 'finding people in your photos and videos' }); } catch {}
        }
        throw httpError(409, 'CONSENT_NEEDED', err.message, { keys: err.keys });
      }
      throw httpError(err.code === 'BAD_ENTRY' ? 500 : 409, err.code || 'DOWNLOAD_FAILED', err.message);
    }
    const unsourced = m.missing.filter(k => !entries.some(e => e.key === k));
    dl = { running: true, received: 0, total: downloadLib.missingOf(entries).reduce((s, e) => s + (Number(e.size) || 0), 0), error: null, code: null };
    if (unsourced.length) {
      Object.assign(dl, { running: false, error: `No download source for: ${unsourced.join(', ')}`, code: 'NO_SOURCE' });
      return status();
    }
    dlCtrl = new AbortController();
    const mine = dl;
    download.downloadModels(entries, {
      consent, signal: dlCtrl.signal, ...(fetchImpl ? { fetchImpl } : {}),
      onProgress: (p) => { mine.received = p.received; if (p.total) mine.total = p.total; },
    }).then(() => {
      mine.running = false;
      dropEngine();   // reload with the new files on next use
    }).catch((err) => {
      mine.running = false;
      mine.error = err.message;
      mine.code = err.code || 'DOWNLOAD_FAILED';
    });
    return status();
  }

  /** Resolves when the current download (if any) has finished. Tests. */
  async function downloadSettled() {
    while (dl?.running) await new Promise(r => setTimeout(r, 5));
  }

  /* ── Indexing ─────────────────────────────────────────────────────────── */

  function shortError(err) {
    return String(err?.message || err || 'unknown error').replace(/\s+/g, ' ').slice(0, 200);
  }

  async function runFile(item, { signal, onProgress }) {
    const gen = lockGen;
    const row = database.get().prepare(
      'SELECT id, filepath, filename, media_type, duration_seconds FROM media WHERE id = ?'
    ).get(item.id);
    const kind = store.kindOf(row);
    if (!row || !kind) return false;
    try {
      if (!fileExists(row.filepath)) throw new Error('File not found on disk');
      // Clicks: photos and GIFs are one frame, so they take the frame lane and
      // never wait behind a long video; only videos use the file lane.
      const pool = !item.interactive ? queueEngines : kind === 'video' ? fileEngines : frameEngines;
      const { intervalS, maxFrames } = getSettings();
      return await withEngine(pool, async (eng) => {
        const result = await analyze.analyzeFile(eng, {
          filepath: row.filepath, kind, durationS: row.duration_seconds || undefined,
        }, { intervalS, maxFrames, signal, onProgress });
        if (signal?.aborted || gen !== lockGen) return false;   // locked meanwhile: write nothing
        // Screen time per face group = appearances x the spacing actually used
        // (long videos spread maxFrames evenly, so the step can be wider).
        const dur = Number(row.duration_seconds);
        const step = dur > 0 ? Math.max(intervalS, dur / maxFrames) : intervalS;
        store.saveFileResult(row.id, eng.modelId, result, { isVideo: kind === 'video', now: now(), screenIntervalS: step });
        // Visible faces found (hidden / not-a-face carry-overs excluded): the
        // queue's lastRun.withPeople.
        const faces = database.get().prepare('SELECT COUNT(*) AS n FROM face_groups WHERE media_id = ? AND hidden = 0').get(row.id).n;
        return { faces };
      });
    } catch (err) {
      if (signal?.aborted || gen !== lockGen) return false;
      try { store.markError(row.id, shortError(err)); } catch { /* DB closed */ }
      return false;
    }
  }

  const SQL_CHUNK = 500;

  /** ETA work units: 1 per photo/GIF, expected sampled frames per video (NaN if no duration). */
  function workUnits(row) {
    if (store.kindOf(row) !== 'video') return 1;
    const d = Number(row.duration_seconds);
    if (!(d > 0)) return NaN;
    const { intervalS, maxFrames } = getSettings();
    const step = Math.max(intervalS, d / maxFrames);
    return Math.min(maxFrames, Math.ceil(d / step));
  }

  function parseIds(raw) {
    if (!Array.isArray(raw)) return null;
    const ids = raw.map(v => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v
      : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : null))).filter(v => v);
    return [...new Set(ids)];
  }

  /**
   * Queue files. { ids:[...] } or { all:true }; force re-checks indexed files.
   * @returns queue status plus { added, skipped }
   */
  function enqueue({ ids, all = false, force = false, reason = 'user' } = {}) {
    refuseDuringMigrate();
    requireModels();
    const mid = modelId();
    const db = database.get();
    const types = store.ELIGIBLE_TYPES.map(t => `'${t}'`).join(',');
    const indexedClause = force ? '' : 'AND NOT (faces_indexed_at IS NOT NULL AND faces_model IS ?)';
    let rows = [];
    let asked = 0;
    if (all) {
      rows = db.prepare(`SELECT id, filename, media_type, filepath, duration_seconds FROM media
        WHERE user_trashed = 0 AND media_type IN (${types}) ${indexedClause} ORDER BY id`)
        .all(...(force ? [] : [mid]));
      asked = rows.length;
    } else {
      const list = parseIds(ids);
      if (!list || !list.length) throw httpError(400, 'BAD_IDS', 'ids must be a non-empty array of media ids');
      asked = list.length;
      for (let i = 0; i < list.length; i += SQL_CHUNK) {
        const chunk = list.slice(i, i + SQL_CHUNK);
        rows.push(...db.prepare(`SELECT id, filename, media_type, filepath, duration_seconds FROM media
          WHERE id IN (${chunk.map(() => '?').join(',')}) AND media_type IN (${types}) ${indexedClause}`)
          .all(...chunk, ...(force ? [] : [mid])));
      }
    }
    const items = rows.filter(r => store.kindOf(r)).map(r => ({ id: r.id, filename: r.filename, force, reason, units: workUnits(r) }));
    const { added } = queue.enqueue(items);
    return { ...queue.status(), added, skipped: asked - added };
  }

  /**
   * Import-pipeline hook: a NEW media row finished. Enqueues only when the
   * feature and auto-index are on, models are ready and no migrate runs.
   * @returns {boolean} queued
   */
  function autoEnqueue(mediaId) {
    const s = getSettings();
    if (!s.enabled || !s.autoIndex) return false;
    if (!models().ready || isMigrateRunning()) { autoSkipped++; return false; }
    try {
      const row = database.get().prepare('SELECT id, filename, filepath, media_type, user_trashed, duration_seconds FROM media WHERE id = ?').get(mediaId);
      if (!row || row.user_trashed || !store.kindOf(row)) return false;
      return queue.enqueue([{ id: row.id, filename: row.filename, force: false, reason: 'auto', units: workUnits(row) }]).added > 0;
    } catch (err) {
      console.warn(`[Faces] auto-index skipped for ${mediaId}: ${err.message}`);
      return false;
    }
  }

  function mediaRow(mediaId) {
    const row = database.get().prepare('SELECT id, filename, filepath, media_type, duration_seconds FROM media WHERE id = ?').get(mediaId);
    if (!row) throw httpError(404, 'NOT_FOUND', 'file not found');
    return row;
  }

  function fileFaces(mediaId) {
    const out = store.getFileFaces(mediaId, modelId());
    if (!out) throw httpError(404, 'NOT_FOUND', 'file not found');
    return out;
  }

  /** Index one file now (jumps the queue, awaits it). */
  async function findFacesNow(mediaId, { force = false } = {}) {
    const row = mediaRow(mediaId);
    if (!store.kindOf(row)) throw httpError(400, 'NOT_ELIGIBLE', 'Only photos, GIFs and videos can be checked for faces.');
    refuseDuringMigrate();
    requireModels();
    const current = fileFaces(mediaId);
    if (current.indexed && !force) return current;
    const gen = lockGen;
    await queue.runNow({ id: row.id, filename: row.filename, force, reason: 'user', interactive: true });
    // A delete-all that started meanwhile: answer what is true after it.
    while (deleting) await deleting.catch(() => {});
    assertSameLock(gen);
    return fileFaces(mediaId);
  }

  /* ── Search ───────────────────────────────────────────────────────────── */

  function widthOf(w) {
    if (w === undefined || w === null || w === '') return 'normal';
    if (!WIDTHS.includes(w)) throw httpError(400, 'BAD_WIDTH', `width must be one of ${WIDTHS.join(', ')}`);
    return w;
  }

  /**
   * Search, plus match: { [mediaId]: { groupId, personId, personName } } =
   * the face in each file whose score was used, and its person (null while
   * not sorted yet). @returns {{ ids, scores, total, capped, match, _modelId }}
   */
  function searchVectors(vecs, width) {
    requireModels();
    const mid = modelId();
    if (!mid) throw httpError(409, 'FACE_MODELS_MISSING', 'Face search models are not available.', { missing: models().missing });
    const { groupIds, ...out } = index.query(vecs, thresholdFor(widthOf(width)), mid, { withGroups: true });
    const persons = groupPersons(groupIds);
    out.match = {};
    out.ids.forEach((mediaId, i) => {
      const p = persons.get(groupIds[i]) || { personId: null, personName: null };
      out.match[mediaId] = { groupId: groupIds[i], personId: p.personId, personName: p.personName };
    });
    Object.defineProperty(out, '_hiddenPeople', { value: new Set([...persons.values()].filter(p => p.hidden).map(p => p.personId)) });
    return out;
  }

  /** group id -> { personId, personName, hidden } for these groups (sorted ones only). */
  function groupPersons(groupIds) {
    const out = new Map();
    const ids = [...new Set(groupIds)];
    const db = database.get();
    for (let i = 0; i < ids.length; i += SQL_CHUNK) {
      const chunk = ids.slice(i, i + SQL_CHUNK);
      for (const r of db.prepare(`SELECT g.id, p.id AS pid, p.name, p.hidden FROM face_groups g JOIN face_people p ON p.id = g.cluster_id
        WHERE g.id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        out.set(r.id, { personId: r.pid, personName: r.name ?? null, hidden: !!r.hidden });
      }
    }
    return out;
  }

  /**
   * The person a query search most likely shows: the person most results
   * (files) belong to when that is at least half of them, else the best
   * match's person when it scores >= the people threshold, else null.
   * Hidden people are never offered.
   */
  function likelyPersonOf(res) {
    const n = res.ids.length;
    if (!n) return null;
    const tally = new Map();   // person id -> { id, name, count, first } (first = rank of its best result)
    res.ids.forEach((mediaId, rank) => {
      const m = res.match[mediaId];
      if (m.personId == null || res._hiddenPeople.has(m.personId)) return;
      const t = tally.get(m.personId);
      if (t) t.count++;
      else tally.set(m.personId, { id: m.personId, name: m.personName, count: 1, first: rank });
    });
    let top = null;
    for (const t of tally.values()) {   // most results; a tie goes to the person ranked first
      if (!top || t.count > top.count || (t.count === top.count && t.first < top.first)) top = t;
    }
    if (top && top.count * 2 >= n) return { id: top.id, name: top.name };
    const best = res.match[res.ids[0]];
    if (best.personId != null && !res._hiddenPeople.has(best.personId)
      && res.scores[0] >= peopleThresholds(modelId()).people) {
      return { id: best.personId, name: best.personName };
    }
    return null;
  }

  function similarToGroup(groupId, width) {
    const g = store.groupInfo(groupId);
    if (!g) throw httpError(404, 'NOT_FOUND', 'face not found');
    widthOf(width);
    requireModels();
    if (g.model !== modelId()) throw httpError(409, 'FACE_MODEL_CHANGED', 'This face was found with an older model. Check the file again.');
    const out = searchVectors(store.groupVectors(groupId), width);
    const own = groupPersons([groupId]).get(groupId);
    out.source = { personId: own ? own.personId : null, personName: own ? own.personName : null };
    return out;
  }

  function sweepQueries() {
    const t = now();
    for (const [k, v] of queries) if (t - v.at > QUERY_TTL_MS) queries.delete(k);
    while (queries.size > QUERY_MAX) queries.delete(queries.keys().next().value);
  }

  function getQuery(queryId) {
    sweepQueries();
    const q = queries.get(String(queryId));
    if (!q) throw httpError(404, 'QUERY_EXPIRED', 'That search photo is no longer available. Add it again.');
    return q;
  }

  function similarToQuery(queryId, width) {
    const q = getQuery(queryId);
    const out = searchVectors([q.embedding], width);
    out.likelyPerson = likelyPersonOf(out);
    return out;
  }

  const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif', 'image/tiff': '.tif' };

  /**
   * Detect faces in an uploaded photo ({ buffer, contentType }) or a frame of a
   * library file ({ mediaId, timeS }). Query faces live in memory only.
   */
  async function searchImage(input) {
    // The interactive engine, so this never waits behind background indexing.
    // The lock generation is taken when the request arrives, not when it gets
    // an engine: waiting for the frame lane can straddle a lock.
    // input.lockGen: the route's snapshot from before the body was read.
    const gen = Number.isInteger(input.lockGen) ? input.lockGen : lockGen;
    if (isVaultLocked()) throw lockedError();
    assertSameLock(gen);
    return withEngine(frameEngines, (eng) => searchImageWith(eng, input, gen));
  }

  async function searchImageWith(eng, input, gen) {
    assertSameLock(gen);
    const frames = framesOf(eng);
    let frame;
    if (input.buffer) {
      if (!input.buffer.length) throw httpError(400, 'BAD_IMAGE', 'the photo is empty');
      const type = String(input.contentType || '').split(';')[0].trim().toLowerCase();
      const dir = fs.mkdtempSync(path.join(tmpRoot, 'vault-faceq-'));
      const file = path.join(dir, `query${EXT_BY_TYPE[type] || '.img'}`);
      try {
        fs.writeFileSync(file, input.buffer, { mode: 0o600 });
        frame = await frames.decodeImage(file, { maxSide: MAX_SIDE });
      } catch (err) {
        if (err.status) throw err;
        throw httpError(400, 'BAD_IMAGE', 'That file could not be read as a photo.');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } else {
      const id = input.mediaId;
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        throw httpError(400, 'BAD_REQUEST', 'mediaId must be a positive whole number');
      }
      const t = input.timeS === undefined || input.timeS === null ? 0 : input.timeS;
      if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
        throw httpError(400, 'BAD_REQUEST', 'timeS must be a number of seconds, 0 or more');
      }
      const row = mediaRow(id);
      const kind = store.kindOf(row);
      if (!kind) throw httpError(400, 'NOT_ELIGIBLE', 'Only photos, GIFs and videos can be searched for faces.');
      if (!fileExists(row.filepath)) throw httpError(409, 'FILE_MISSING', 'source file missing on disk');
      let at = t;
      if (kind === 'video') {
        const dur = Number(row.duration_seconds);
        if (Number.isFinite(dur) && dur > 0) at = Math.min(at, Math.max(0, dur - 0.1));
        else if (at > MAX_TIME_S) throw httpError(400, 'BAD_REQUEST', 'timeS is past the end of any video');
      }
      try {
        frame = kind === 'video'
          ? await frames.grabFrame(row.filepath, at, { maxSide: MAX_SIDE })
          : await frames.decodeImage(row.filepath, { maxSide: MAX_SIDE });
      } catch (err) {
        throw httpError(422, 'FRAME_FAILED', `Could not read that frame: ${shortError(err)}`);
      }
    }
    assertSameLock(gen);
    const found = await analyze.analyzeFrame(eng, frame, {});
    assertSameLock(gen);                          // no query face stored after a lock
    const faces = [];
    for (const f of found || []) {
      let embedding;
      try { embedding = store.decodeEmbedding(store.encodeEmbedding(f.embedding)); } catch { continue; }
      const queryId = crypto.randomBytes(12).toString('hex');
      const bbox = Array.from(f.bbox || []).slice(0, 4);
      queries.set(queryId, { embedding, bbox, crop: f.crop || null, at: now() });
      faces.push({ queryId, bbox, cropUrl: `/api/faces/query/${queryId}/crop` });
    }
    sweepQueries();
    return { faces };
  }

  function queryCrop(queryId) {
    const q = getQuery(queryId);
    if (!q.crop) throw httpError(404, 'NOT_FOUND', 'no crop for this face');
    return q.crop;
  }

  function groupCrop(groupId) {
    const buf = store.getCrop(groupId);
    if (!buf) throw httpError(404, 'NOT_FOUND', 'crop not found');
    return buf;
  }

  function hideGroup(groupId) {
    if (!store.hideGroup(groupId)) throw httpError(404, 'NOT_FOUND', 'face not found');
    return { ok: true };
  }

  /** Undo of a hide / not-a-face of one face (POST /faces/groups/:id/unhide). */
  function unhideGroup(groupId) {
    refuseDuringMigrate();
    if (!store.unhideGroup(groupId)) throw httpError(404, 'NOT_FOUND', 'face not found');
    const pid = database.get().prepare('SELECT cluster_id FROM face_groups WHERE id = ?').get(groupId)?.cluster_id ?? null;
    if (pid != null) touched([pid]);
    return { ok: true, personId: pid };
  }

  /** "Not a face" (E6): hidden like hide, and marked not_face for tuning. */
  function notFaceGroup(groupId) {
    refuseDuringMigrate();
    const g = store.groupInfo(groupId);
    if (!g) throw httpError(404, 'NOT_FOUND', 'face not found');
    const pid = database.get().prepare('SELECT cluster_id FROM face_groups WHERE id = ?').get(groupId)?.cluster_id ?? null;
    const partners = pid == null ? [] : suggestionPartners([pid]);
    store.hideGroup(groupId, { notFace: true });
    if (pid != null) touched([...(people.personRow(pid) ? [pid] : []), ...partners]);
    return { ok: true };
  }

  /**
   * "Not a face" for all of a person's faces (E6). The person is pruned
   * unless named or favorite. @returns {{ ok, groups, person: object|null }}
   */
  function notFacePerson(id) {
    refuseDuringMigrate();
    people.requirePerson(id);
    const partners = suggestionPartners([id]);
    const { groups, pruned } = store.notFacePerson(id);
    touched(partners);
    return { ok: true, groups, person: pruned ? null : people.get(id) };
  }

  /* ── People (FACES_PEOPLE_SPEC section 3) ───────────────────────────────── */

  const isId = (v) => Number.isInteger(v) && v > 0 && v <= 0xFFFFFFFF;
  function intParam(v, def, min, max, name) {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || !/^\d+$/.test(String(v).trim())) throw httpError(400, 'BAD_REQUEST', `${name} must be a whole number`);
    return Math.min(n, max);
  }
  const strParam = (v, def) => (v === undefined || v === null || v === '' ? def : String(v));

  function listPeople(query = {}) {
    return people.list({
      filter: strParam(query.filter, 'all'),
      sort: strParam(query.sort, 'files'),
      q: strParam(query.q, ''),
      offset: intParam(query.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
      limit: intParam(query.limit, 100, 1, PEOPLE_LIMIT_MAX, 'limit'),
    });
  }

  const getPerson = (id) => people.get(id);
  const personFiles = (id, kind) => people.files(id, strParam(kind, 'all'));
  const personFaces = (id, limit) => people.faces(id, intParam(limit, 8, 1, FACES_LIMIT_MAX, 'limit'));

  /** Partners of these people in the suggestion list (they need a re-score after a merge/split). */
  function suggestionPartners(ids) {
    const out = [];
    const q = database.get().prepare('SELECT a, b FROM face_person_suggestions WHERE a = ? OR b = ?');
    for (const id of ids) for (const r of q.all(id, id)) out.push(r.a === id ? r.b : r.a);
    return out;
  }

  /** Re-score these people's "Same person?" pairs soon. (Callers whose person's centroid moved by a user
   * action, merge / add / restore / accept / review same, also markFresh it: held faces retry against it.) */
  function touched(ids) {
    sorter.markDirty(ids);
    sorter.schedule();
  }

  /**
   * A person a user just made or grew: its held (unclear) faces get their
   * retry now, before the request answers, so a search right after it sees
   * them (the background pass, markFresh, still runs for everyone else).
   * @returns {number} held faces that joined
   */
  function freshNow(ids) {
    sorter.markFresh(ids);
    try { return sorter.retryHeldNow(ids); }
    catch (err) { console.warn(`[Faces] held-face retry failed: ${err && err.message}`); return 0; }
  }

  function updatePerson(id, body = {}) {
    const partners = body.mergeIfTaken === true ? suggestionPartners([id]) : [];
    const out = people.update(id, body);
    if (out.mergedInto != null) { if (freshNow([out.mergedInto])) out.person = people.get(out.mergedInto); touched([out.mergedInto, ...partners, ...suggestionPartners([out.mergedInto])]); }
    // A new name changes which "Same person?" pairs may be asked (never two named people).
    else if (body.name !== undefined && out.person) touched([out.person.id]);
    return out.person;
  }

  function mergePeople(body = {}) {
    const ids = Array.isArray(body.ids) ? body.ids : null;
    if (!ids || ids.length < 2 || ids.length > MERGE_MAX || !ids.every(isId) || new Set(ids).size !== ids.length) {
      throw httpError(400, 'BAD_IDS', `ids must be 2 to ${MERGE_MAX} different person ids`);
    }
    if (!isId(body.into) || !ids.includes(body.into)) throw httpError(400, 'BAD_IDS', 'into must be one of ids');
    const partners = suggestionPartners(ids);
    let { person } = people.merge(ids, body.into);
    if (freshNow([body.into])) person = people.get(body.into);
    touched([body.into, ...partners]);
    return person;
  }

  /**
   * "Not this person": the file's faces leave person `id` and are sorted
   * again with it excluded (another person at >= 0.50, else a new one).
   * moved[].newPerson says whether the face started a new person; the undo is
   * POST /people/:id/restore { groupIds: moved.map(m => m.groupId) }.
   * person is null when that was the person's last visible face and it had
   * no name or favorite (it is gone).
   */
  async function notInPerson(id, body = {}) {
    if (!isId(body.mediaId)) throw httpError(400, 'BAD_REQUEST', 'mediaId must be a media id');
    const gen = lockGen;
    const groupIds = people.notInGroups(id, body.mediaId);
    const partners = suggestionPartners([id]);
    const moved = await sorter.reassign(id, groupIds, (db) => people.detachForNotIn(db, id, groupIds));
    assertSameLock(gen);
    const db = database.get();
    const pruned = db.transaction(() => store.pruneEmptyPeople(db, [id]))();
    if (pruned) store.bumpPeople();
    touched([...(pruned ? [] : [id]), ...moved.map(m => m.personId).filter(Boolean), ...partners]);
    return { person: pruned ? null : people.get(id), moved };
  }

  /** Undo of not-in (or "these faces are this person"): POST /people/:id/restore { groupIds }. */
  function restorePerson(id, body = {}) {
    const ids = Array.isArray(body.groupIds) ? body.groupIds : null;
    if (!ids || !ids.length || ids.length > 500 || !ids.every(isId) || new Set(ids).size !== ids.length) {
      throw httpError(400, 'BAD_IDS', 'groupIds must be 1 to 500 different face ids');
    }
    const out = people.restore(id, ids);
    sorter.markFresh([id]);
    touched([id, ...out.from]);
    return out.person;
  }

  function groupIdsOf(raw) {
    const ids = Array.isArray(raw) ? raw : null;
    if (!ids || !ids.length || ids.length > ADD_MAX || !ids.every(isId) || new Set(ids).size !== ids.length) {
      throw httpError(400, 'BAD_IDS', `groupIds must be 1 to ${ADD_MAX} different face ids`);
    }
    return ids;
  }
  function boolOpt(body, k) {
    if (body[k] === undefined) return false;
    if (typeof body[k] !== 'boolean') throw httpError(400, 'BAD_REQUEST', `${k} must be true or false`);
    return body[k];
  }

  /**
   * Add faces to a person (E2): POST /people/:id/add { groupIds, takeFromNamed? }.
   * @returns {{ person, moved, skipped }}
   */
  function addToPerson(id, body = {}) {
    const groupIds = groupIdsOf(body.groupIds);
    const takeFromNamed = boolOpt(body, 'takeFromNamed');
    refuseDuringMigrate();
    const out = people.add(id, groupIds, { takeFromNamed });
    if (out.moved.length) {
      if (freshNow([id])) out.person = people.get(id);   // its centroid moved: held faces get a retry against it
      touched([id, ...out.from.filter(f => people.personRow(f)), ...suggestionPartners([id])]);
    }
    return { person: out.person, moved: out.moved, already: out.already, skipped: out.skipped };
  }

  /**
   * New person from faces (E3): POST /people { name?, groupIds, mergeIfTaken?, takeFromNamed? }.
   * @returns the person (people/:id shape) plus moved and skipped
   */
  function createPerson(body = {}) {
    const groupIds = groupIdsOf(body.groupIds);
    const mergeIfTaken = boolOpt(body, 'mergeIfTaken');
    const takeFromNamed = boolOpt(body, 'takeFromNamed');
    people.cleanName(body.name);   // 400 before any other check
    refuseDuringMigrate();
    const out = people.create({ name: body.name, groupIds, mergeIfTaken, takeFromNamed });
    if (out.moved.length) touched([out.person.id, ...out.from.filter(f => people.personRow(f))]);
    // A new (or grown) person: held (unclear) faces get a chance to join it.
    if (out.moved.length && freshNow([out.person.id])) out.person = people.get(out.person.id);
    return { ...out.person, moved: out.moved, already: out.already, skipped: out.skipped, mergedInto: out.mergedInto };
  }

  /** "Might also be" (E4): GET /people/:id/candidates?limit&offset */
  function personCandidates(id, query = {}) {
    return candidates.list(id, {
      limit: intParam(query.limit, 24, 1, CANDIDATES_LIMIT_MAX, 'limit'),
      offset: intParam(query.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset'),
    });
  }

  /** POST /people/:id/candidates { accept: [personIds], reject: [personIds] } */
  function answerCandidates(id, body = {}) {
    const list = (k) => {
      const v = body[k] === undefined ? [] : body[k];
      if (!Array.isArray(v) || v.length > ANSWER_MAX || !v.every(isId) || new Set(v).size !== v.length) {
        throw httpError(400, 'BAD_IDS', `${k} must be up to ${ANSWER_MAX} different person ids`);
      }
      return v;
    };
    const accept = list('accept'), reject = list('reject'), unreject = list('unreject');
    if (!accept.length && !reject.length && !unreject.length) throw httpError(400, 'BAD_IDS', 'accept or reject at least one person');
    if (unreject.some(u => accept.includes(u) || reject.includes(u))) throw httpError(400, 'BAD_IDS', 'a person cannot be un-rejected and answered at once');
    if (accept.some(a => reject.includes(a))) throw httpError(400, 'BAD_IDS', 'a person cannot be both accepted and rejected');
    if (accept.includes(id) || reject.includes(id) || unreject.includes(id)) throw httpError(400, 'BAD_IDS', 'a person cannot be its own candidate');
    refuseDuringMigrate();
    const partners = suggestionPartners([id, ...accept]);
    const out = people.answerCandidates(id, accept, reject, unreject);
    if (out.merged.length) { if (freshNow([id])) out.person = people.get(id); touched([id, ...partners]); }
    // A 'different' answer given or taken back (None of these, ✕, their Undo)
    // changes which "Same person?" pairs may be asked: re-score those people.
    const answered = [...out.rejected, ...out.unrejected];
    if (answered.length) touched([id, ...answered]);
    return out;
  }

  function reviewPairs(query = {}) {
    return people.review(intParam(query.limit, 20, 1, REVIEW_LIMIT_MAX, 'limit'));
  }

  function answerReview(body = {}) {
    if (!isId(body.a) || !isId(body.b)) throw httpError(400, 'BAD_IDS', 'a and b must be person ids');
    if (!['same', 'different'].includes(body.answer)) throw httpError(400, 'BAD_ANSWER', "answer must be 'same' or 'different'");
    const partners = body.answer === 'same' ? suggestionPartners([body.a, body.b]) : [];
    const out = people.answer(body.a, body.b, body.answer);
    if (out.person) { if (freshNow([out.person.id])) out.person = people.get(out.person.id); touched([out.person.id, ...partners]); }
    else touched([body.a, body.b]);   // 'different': either may have another question now
    return out;
  }

  function peopleStatus() {
    let total = 0, pending = 0, suggestions = '';
    try {
      total = people.total(); pending = sorter.pending();
      // A fingerprint of the "Same person?" pairs (500 rows at most): the strip reloads when it moves.
      const r = database.get().prepare('SELECT COUNT(*) AS n, TOTAL(a * 1000003 + b) AS s FROM face_person_suggestions').get();
      suggestions = `${r.n}:${r.s}`;
    } catch { /* DB locked or closed */ }
    return { sorting: sorter.isRunning(), pending, total, suggestions };
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  async function deleteAll() {
    const run = (async () => {
      queue.cancel({ includeDirect: true });
      sorter.cancel();
      await Promise.all([queue.settled(), sorter.settled()]);
      store.deleteAllData();
      people.resetCaches();
      candidates.reset();
      queue.resetHistory();   // recent files and lastRun describe data that is gone
      index.reset();
      queries.clear();
      countsCache = null;
    })();
    deleting = run;
    try { await run; } finally { if (deleting === run) deleting = null; }
    return { ok: true };
  }

  /** Vault locked: stop work and drop every face vector held in memory. */
  function onVaultLocked() {
    lockGen++;
    queue.clearRecent();   // file names
    candidates.reset();
    queue.suspend();
    sorter.suspend();      // its centroids are face vectors too
    people.resetCaches();
    dropEngine();          // frames and embeddings live in the engine workers too
    index.reset();
    queries.clear();
    countsCache = null;
  }

  function onVaultUnlocked() { queue.unsuspend(); sorter.schedule(); }

  function counts() {
    const mid = modelId();
    const v = store.version();
    const t = now();
    if (countsCache && countsCache.version === v && countsCache.modelId === mid && t - countsCache.at < COUNTS_TTL_MS) {
      return countsCache.value;
    }
    const value = store.counts(mid);
    countsCache = { at: t, version: v, modelId: mid, value };
    return value;
  }

  /**
   * Queue status for the scan panel. recent[] (E5) gets what is true NOW for
   * each finished file: faces (visible), people (distinct people among
   * them), names (up to 3, hidden people left out) and the stored error of a
   * failed file.
   */
  function queueStatus() {
    const st = queue.status();
    const live = new Map();
    const errors = new Map();
    let read = false;
    try {
      const db = database.get();
      const ids = [...new Set(st.recent.map(r => r.mediaId))];
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        for (const r of db.prepare(`SELECT g.media_id, g.cluster_id, p.name, p.hidden FROM face_groups g
          JOIN media m ON m.id = g.media_id LEFT JOIN face_people p ON p.id = g.cluster_id
          WHERE g.media_id IN (${ph}) AND g.hidden = 0 AND g.model = m.faces_model ORDER BY g.appearances DESC, g.id`).all(...ids)) {
          let e = live.get(r.media_id);
          if (!e) { e = { faces: 0, people: new Set(), names: [] }; live.set(r.media_id, e); }
          e.faces++;
          if (r.cluster_id != null && !r.hidden) e.people.add(r.cluster_id);
          if (r.name != null && !r.hidden && e.names.length < 3 && !e.names.includes(r.name)) e.names.push(r.name);
        }
        for (const r of db.prepare(`SELECT id, faces_error FROM media WHERE id IN (${ph})`).all(...ids)) errors.set(r.id, r.faces_error);
      }
      read = true;
    } catch { /* DB closed (locked): what the queue remembers */ }
    st.recent = st.recent.map((r) => {
      const l = live.get(r.mediaId);
      const out = {
        mediaId: r.mediaId, filename: r.filename, ok: r.ok, direct: r.direct, finishedAt: r.finishedAt,
        faces: l ? l.faces : (read ? 0 : (r.faces ?? 0)),
        people: l ? l.people.size : 0,
        names: l ? l.names : [],
      };
      if (!r.ok) out.error = errors.get(r.mediaId) || null;
      return out;
    });
    return st;
  }

  function status() {
    const s = getSettings();
    const m = models();
    return {
      enabled: s.enabled,
      autoIndex: s.autoIndex,
      intervalS: s.intervalS,
      maxFrames: s.maxFrames,
      modelsReady: m.ready,
      missing: m.missing,
      missingReasons: m.reasons,   // key -> 'absent' | 'size' | 'corrupt'
      download: dl ? { running: dl.running, received: dl.received, total: dl.total, error: dl.error } : null,
      counts: counts(),
      queue: queueStatus(),
      people: peopleStatus(),
    };
  }

  return {
    // settings / status
    getSettings, updateSettings, status, lockGeneration: () => lockGen, models, modelId, startDownload, downloadSettled,
    // indexing
    enqueue, autoEnqueue, findFacesNow, fileFaces,
    pause: () => queue.pause(), resume: () => { refuseDuringMigrate(); requireModels(); return queue.resume(); },
    cancel: () => queue.cancel(), queueStatus, settled: () => queue.settled(),
    isBusy: () => queue.isBusy(),
    // search
    similarToGroup, similarToQuery, searchImage, queryCrop, groupCrop, hideGroup, unhideGroup, notFaceGroup,
    // people
    listPeople, getPerson, personFiles, personFaces, updatePerson, mergePeople, notInPerson, restorePerson, reviewPairs, answerReview,
    addToPerson, createPerson, personCandidates, answerCandidates, notFacePerson,
    schedulePeople: () => sorter.schedule(), sortPeopleNow: () => sorter.runNow(), peopleSettled: () => sorter.settled(),
    // lifecycle
    deleteAll, onVaultLocked, onVaultUnlocked,
    // test seams
    _index: index, _queue: queue, _engines: { queue: queueEngines, frame: frameEngines, file: fileEngines }, _queries: queries, _autoSkipped: () => autoSkipped, _sorter: sorter,
  };
}

// server/index.js points this at its migrate job (module-level so it survives
// setInstance in tests).
let _migrateProbe = () => false;
function setMigrateProbe(fn) { _migrateProbe = fn; }

let _instance = null;
function instance() {
  if (!_instance) _instance = createService();
  return _instance;
}
function setInstance(svc) {
  if (_instance && _instance !== svc) { try { _instance._sorter.cancel(); } catch {} }
  _instance = svc;
  return svc;
}

// Any face write (a file checked or re-checked, a delete, delete-all) wakes
// the people sorting job of the live service.
store.onChange(() => { if (_instance) _instance.schedulePeople(); });

module.exports = {
  createService, instance, setInstance, setMigrateProbe,
  INTERVALS, MAX_FRAMES, MIN_INTERVAL_S, MAX_INTERVAL_S, MIN_MAX_FRAMES, MAX_MAX_FRAMES, QUERY_TTL_MS, QUERY_MAX, FACE_KEYS,
};
