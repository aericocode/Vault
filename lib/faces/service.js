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
 *
 * Face models (FACE_MODELS_SPEC, models.js): settings.model picks the keeper
 * ('ir50' Standard, the default | 'ir101' Best). The ACTIVE keeper is the
 * chosen one once its file is on disk; until then a library that already
 * has vectors keeps using what it was indexed with (the other keeper, or
 * SFace for libraries from before keepers) and status reports needsModel so
 * the UI can offer the download. When the active keeper differs from what
 * files are indexed with, the switch job (model-switch.js) re-reads them in
 * the background; meanwhile both models serve: files are listed, counted and
 * searched in whichever model they are in now.
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
const { createModelSwitch } = require('./model-switch');
const { KEEPERS, KEEPER_NAMES, KEEPER_KEYS, DEFAULT_KEEPER, SFACE_MODEL_ID, SWITCHABLE, FACE_MODELS, keeperNameOf } = require('./models');

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
  const makeEngine = () => { const m = models(); return engineFactory({ modelPaths: m.paths, keeper: m.keeper }); };
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
  let libCache = null;         // { version, models: string[] } switchable models files are indexed with
  // The background model switch (model-switch.js), on the queue's engines.
  const modelSwitch = createModelSwitch({
    database, store,
    target: () => switchTarget(),
    withEngine: (fn) => withEngine(queueEngines, fn),
    framesOf,
    recheck: (row, eng) => analyzeAndSave(row, store.kindOf(row), eng, {}),
    settings: () => getSettings(),
    enabled: () => { try { return getSettings().enabled; } catch { return false; } },
    isVaultLocked: () => isVaultLocked(), isMigrateRunning: () => isMigrateRunning(), lockGen: () => lockGen,
    fileExists, fileStat: deps.fileStat, workers: deps.switchWorkers || QUEUE_WORKERS, now, retryMs: deps.switchRetryMs,
    onFinish: () => { people.resetCaches(); candidates.reset(); index.reset(); countsCache = null; libCache = null; },
    // A batch re-read: its named people are now matchable in the new model;
    // held (unclear) faces get a retry against them, the job wakes for the rest.
    onBatch: (mediaIds) => {
      let named = [];
      try { named = store.namedPeopleIn(mediaIds); } catch { return; }
      if (named.length) sorter.markFresh(named);
      sorter.schedule();
    },
  });

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
      model: KEEPER_NAMES.includes(a.facesModel) ? a.facesModel : DEFAULT_KEEPER,
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
    if (body.model !== undefined) {
      if (!KEEPER_NAMES.includes(body.model)) throw httpError(400, 'BAD_SETTING', `model must be one of ${KEEPER_NAMES.join(', ')}`);
      if (body.model !== getSettings().model) patch.facesModel = body.model;
    }
    if (Object.keys(patch).length) settings.set(patch);
    if (patch.facesEnabled === false) {
      queue.cancel({ includeDirect: true });   // off means off, clicks too
      sorter.cancel();
      modelSwitch.suspend();
    }
    if (patch.facesModel !== undefined) {
      // New engines with the new keeper; a running switch toward the old
      // choice stops at its next file and the job starts toward this one
      // (at once when its file is on disk, else after its download).
      dropEngine();
      libCache = null;
      modelSwitch.suspend();
      modelSwitch.schedule();
    }
    if (patch.facesEnabled === true) { sorter.schedule(); modelSwitch.schedule(); }
    return status();
  }

  /* ── Models and engine ────────────────────────────────────────────────── */

  /** Switchable models the library's files are indexed with (index probes, cached per store write). */
  function libraryModels() {
    const v = store.version();
    if (libCache && libCache.version === v) return libCache.models;
    let list = [];
    try { list = SWITCHABLE.filter(m => store.hasModel(m)); } catch { /* DB closed (locked) */ }
    libCache = { version: v, models: list };
    return list;
  }

  /**
   * Model files and the keeper in use.
   * { ready, missing, reasons, paths, keeper: 'ir50'|'ir101'|null, selected, needsModel: name|null, keyed }
   * keyed: the store knows keeper files (production). Stores that only list
   * the grunt models (test fakes) leave the keeper to the engine factory.
   * The keeper is the selected one when its file is there; else, for a
   * library already indexed, the model it is in (other keeper, or null =
   * SFace, a library from before keepers) with needsModel = the selection;
   * else not ready (the selected keeper is missing like any model).
   */
  function models() {
    const s = modelStore.status() || {};
    const missingAll = Array.isArray(s.missing) ? s.missing : [];
    const reasons = s.reasons || {};
    const paths = s.paths || {};
    const selected = (() => { try { return getSettings().model; } catch { return DEFAULT_KEEPER; } })();
    const keyed = KEEPER_KEYS.some(k => k in paths || missingAll.includes(k));
    if (!keyed) {
      return { ready: !!s.ready, missing: missingAll, reasons, paths, keeper: null, selected, needsModel: null, keyed };
    }
    const gruntMissing = FACE_KEYS.filter(k => missingAll.includes(k) || !paths[k]);
    const has = (name) => !!paths[KEEPERS[name].key] && !missingAll.includes(KEEPERS[name].key);
    let keeper = null, ready = false, needsModel = null;
    if (has(selected)) { keeper = selected; ready = true; }
    else {
      needsModel = selected;
      const lib = libraryModels();
      const other = KEEPER_NAMES.find(n => n !== selected && has(n) && lib.some(m => keeperNameOf(m) === n));
      if (other) { keeper = other; ready = true; }
      // SFace-keeper vectors (sface-2021dec; stub-v1 in tests): keep working without a keeper.
      else if (lib.some(m => !keeperNameOf(m))) { keeper = null; ready = true; }
    }
    if (gruntMissing.length) ready = false;
    const missing = ready ? [] : [...gruntMissing, ...(has(selected) ? [] : [KEEPERS[selected].key])];
    const rs = {};
    for (const k of missing) rs[k] = reasons[k] || 'absent';
    return { ready, missing, reasons: rs, paths, keeper, selected, needsModel, keyed, allReasons: reasons };
  }

  /** The model id the switch job moves files into, or null (no keeper active / not switch-capable). */
  function switchTarget() {
    const mid = modelId();
    return mid && keeperNameOf(mid) ? mid : null;
  }

  /**
   * Models whose files count as indexed and are searched: the active one,
   * plus (with a keeper active) any other keeper-family model files are still
   * in (a switch in progress, or files it could not re-read).
   */
  function servingModels() {
    const mid = modelId();
    if (!mid) return [];
    if (!keeperNameOf(mid)) return [mid];
    return [mid, ...libraryModels().filter(m => m !== mid)];
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

  /** Model ids this service's engines can embed a query face in (active first). */
  function embeddableModels() {
    const serving = servingModels();
    let eng = null;
    try { eng = makeEngine(); } catch { return serving.slice(0, 1); }
    const can = new Set([eng.modelId, ...(Array.isArray(eng.keeperIds) ? eng.keeperIds : []), eng.gruntId || (eng.backend === 'onnx' ? SFACE_MODEL_ID : null)]);
    if (!deps.engineFactory) eng.close?.();
    return serving.filter(m => can.has(m));
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

  /**
   * Download the grunt models plus one keeper (body.model, default the
   * selected one). Each file needs its own consent (face:keeper-ir50 /
   * face:keeper-ir101 like face:detect / face:embed).
   */
  function startDownload(body = {}) {
    if (dl?.running) return status();
    const want = body && body.model !== undefined ? body.model : getSettings().model;
    if (!KEEPER_NAMES.includes(want)) throw httpError(400, 'BAD_SETTING', `model must be one of ${KEEPER_NAMES.join(', ')}`);
    const m = models();
    const all = modelStore.entries() || [];
    const keyed = all.some(e => KEEPER_KEYS.includes(e.key));
    const entries = keyed ? all.filter(e => FACE_KEYS.includes(e.key) || e.key === KEEPERS[want].key) : all;
    if (keyed ? !downloadLib.missingOf(entries).length : m.ready) return status();
    try {
      download.preflight(entries, { consent });
    } catch (err) {
      if (err.code === 'CONSENT_NEEDED') {
        for (const key of err.keys) {
          try { consent.request(key, { kind: 'faces', label: FACE_MODELS[key]?.label || 'face search models', why: 'finding people in your photos and videos' }); } catch {}
        }
        throw httpError(409, 'CONSENT_NEEDED', err.message, { keys: err.keys });
      }
      throw httpError(err.code === 'BAD_ENTRY' ? 500 : 409, err.code || 'DOWNLOAD_FAILED', err.message);
    }
    const unsourced = keyed ? [] : m.missing.filter(k => !entries.some(e => e.key === k));
    dl = { running: true, model: want, received: 0, total: downloadLib.missingOf(entries).reduce((s, e) => s + (Number(e.size) || 0), 0), error: null, code: null };
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
      libCache = null;
      modelSwitch.schedule();   // a newly present keeper may start (or finish) a switch
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
      return await withEngine(pool, async (eng) => {
        if (!(await analyzeAndSave(row, kind, eng, { signal, onProgress, gen }))) return false;   // locked meanwhile: write nothing
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

  /**
   * Check one file with `eng` and store the result in eng.modelId. false
   * (nothing written) when aborted or the vault locked meanwhile.
   */
  async function analyzeAndSave(row, kind, eng, { signal, onProgress, gen = lockGen } = {}) {
    const { intervalS, maxFrames } = getSettings();
    const result = await analyze.analyzeFile(eng, {
      filepath: row.filepath, kind, durationS: row.duration_seconds || undefined,
    }, { intervalS, maxFrames, signal, onProgress });
    if (signal?.aborted || gen !== lockGen) return false;
    // Screen time per face group = appearances x the spacing actually used
    // (long videos spread maxFrames evenly, so the step can be wider).
    const dur = Number(row.duration_seconds);
    const step = dur > 0 ? Math.max(intervalS, dur / maxFrames) : intervalS;
    store.saveFileResult(row.id, eng.modelId, result, { isVideo: kind === 'video', now: now(), screenIntervalS: step });
    return true;
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
    // A file in any serving model counts as indexed: files of the model a
    // switch is leaving are re-read by the switch job, not checked again.
    const serving = servingModels();
    const mids = serving.length ? serving : [null];
    const db = database.get();
    const types = store.ELIGIBLE_TYPES.map(t => `'${t}'`).join(',');
    const indexedClause = force ? '' : `AND NOT (faces_indexed_at IS NOT NULL AND faces_model IN (${mids.map(() => '?').join(',')}))`;
    let rows = [];
    let asked = 0;
    if (all) {
      rows = db.prepare(`SELECT id, filename, media_type, filepath, duration_seconds FROM media
        WHERE user_trashed = 0 AND media_type IN (${types}) ${indexedClause} ORDER BY id`)
        .all(...(force ? [] : mids));
      asked = rows.length;
    } else {
      const list = parseIds(ids);
      if (!list || !list.length) throw httpError(400, 'BAD_IDS', 'ids must be a non-empty array of media ids');
      asked = list.length;
      for (let i = 0; i < list.length; i += SQL_CHUNK) {
        const chunk = list.slice(i, i + SQL_CHUNK);
        rows.push(...db.prepare(`SELECT id, filename, media_type, filepath, duration_seconds FROM media
          WHERE id IN (${chunk.map(() => '?').join(',')}) AND media_type IN (${types}) ${indexedClause}`)
          .all(...chunk, ...(force ? [] : mids)));
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
    const serving = servingModels();
    const out = store.getFileFaces(mediaId, serving.length > 1 ? serving : (serving[0] ?? null));
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
   * not sorted yet). byModel: Map model id -> the query face's vectors in
   * that model (one model normally; two during a model switch). Each model
   * uses its own threshold for the width (models.js).
   * @returns {{ ids, scores, total, capped, match }}
   */
  function searchVectors(byModel, width) {
    requireModels();
    const mid = modelId();
    if (!mid) throw httpError(409, 'FACE_MODELS_MISSING', 'Face search models are not available.', { missing: models().missing });
    const w = widthOf(width);
    const serving = new Set(servingModels());
    const parts = [...byModel].filter(([m, v]) => serving.has(m) && v && v.length)
      .map(([m, vecs]) => ({ modelId: m, vecs, threshold: thresholdFor(w, m) }));
    const { groupIds, models: scoredBy, ...out } = index.queryMulti(parts, { withGroups: true });
    const persons = groupPersons(groupIds);
    out.match = {};
    out.ids.forEach((mediaId, i) => {
      const p = persons.get(groupIds[i]) || { personId: null, personName: null };
      out.match[mediaId] = { groupId: groupIds[i], personId: p.personId, personName: p.personName };
    });
    Object.defineProperty(out, '_hiddenPeople', { value: new Set([...persons.values()].filter(p => p.hidden).map(p => p.personId)) });
    Object.defineProperty(out, '_models', { value: scoredBy });
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
      && res.scores[0] >= peopleThresholds(res._models?.[0] || modelId()).people) {
      return { id: best.personId, name: best.personName };
    }
    return null;
  }

  function similarToGroup(groupId, width) {
    const g = store.groupInfo(groupId);
    if (!g) throw httpError(404, 'NOT_FOUND', 'face not found');
    widthOf(width);
    requireModels();
    if (!servingModels().includes(g.model)) throw httpError(409, 'FACE_MODEL_CHANGED', 'This face was found with an older model. Check the file again.');
    const out = searchVectors(store.groupVectorsByModel(groupId), width);
    const own = groupPersons([groupId]).get(groupId);
    out.source = { personId: own ? own.personId : null, personName: own ? own.personName : null };
    out.rejected = rejectedFor(out, out.source.personId);
    return out;
  }

  /**
   * Result files whose matched face the user already said is NOT person
   * `pid` (a "not this person" reject): the review leaves them out.
   * @returns {number[]} media ids
   */
  function rejectedFor(res, pid) {
    if (pid == null || !res.ids.length) return [];
    const byGroup = new Map(res.ids.map(mid => [res.match[mid].groupId, mid]));
    const gids = [...byGroup.keys()];
    const out = [];
    const db = database.get();
    for (let i = 0; i < gids.length; i += SQL_CHUNK) {
      const chunk = gids.slice(i, i + SQL_CHUNK);
      for (const r of db.prepare(`SELECT group_id FROM face_person_rejects WHERE person_id = ? AND group_id IN (${chunk.map(() => '?').join(',')})`).all(pid, ...chunk)) {
        out.push(byGroup.get(r.group_id));
      }
    }
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
    const out = searchVectors(new Map(Object.entries(q.embeddings).map(([m, v]) => [m, [v]])), width);
    out.likelyPerson = likelyPersonOf(out);
    out.rejected = rejectedFor(out, out.likelyPerson ? out.likelyPerson.id : null);
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
    // During a model switch the query face is embedded in every model files
    // are in (models.js; the engine has the keeper files it was given).
    const found = await analyze.analyzeFrame(eng, frame, { models: embeddableModels() });
    assertSameLock(gen);                          // no query face stored after a lock
    const faces = [];
    for (const f of found || []) {
      const embeddings = {};
      const all = f.embeddings || { [eng.modelId]: f.embedding };
      for (const [m, v] of Object.entries(all)) {
        try { embeddings[m] = store.decodeEmbedding(store.encodeEmbedding(v, m)); } catch { /* wrong size: not searchable in m */ }
      }
      if (!Object.keys(embeddings).length) continue;
      const queryId = crypto.randomBytes(12).toString('hex');
      const bbox = Array.from(f.bbox || []).slice(0, 4);
      queries.set(queryId, { embeddings, bbox, crop: f.crop || null, at: now() });
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
   * again with it excluded (another person under the join rule, else a new one).
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

  /** Up to `max` different face ids from body[k] (default: may be empty). */
  function faceIdsOf(body, k, { max = ADD_MAX } = {}) {
    const v = body[k] === undefined ? [] : body[k];
    if (!Array.isArray(v) || v.length > max || !v.every(isId) || new Set(v).size !== v.length) {
      throw httpError(400, 'BAD_IDS', `${k} must be up to ${max} different face ids`);
    }
    return v;
  }

  /**
   * "Is this X?" answers (FACES_REVIEW_SPEC F2): POST /people/:id/review-faces
   * { add: [groupIds] (Yes), reject: [groupIds] (No) }.
   * @returns {{ person, moved, already, skipped, rejected }}
   */
  function reviewFaces(id, body = {}) {
    const add = faceIdsOf(body, 'add'), reject = faceIdsOf(body, 'reject');
    if (!add.length && !reject.length) throw httpError(400, 'BAD_IDS', 'answer at least one face');
    if (add.some(g => reject.includes(g))) throw httpError(400, 'BAD_IDS', 'a face cannot be both Yes and No');
    refuseDuringMigrate();
    const partners = suggestionPartners([id]);
    const out = people.reviewFaces(id, add, reject);
    if (out.moved.length && freshNow([id])) out.person = people.get(id);
    if (out.moved.length || out.rejected.length) touched([id, ...out.from.filter(f => people.personRow(f)), ...partners]);
    return { person: out.person, moved: out.moved, already: out.already, skipped: out.skipped, rejected: out.rejected };
  }

  /**
   * Compare (F3): POST /people/:id/move { from, groupIds: [moved to :id], keep: [stay in from] }.
   * @returns {{ person, moved, kept, skipped, fromPerson }}
   */
  function moveFaces(id, body = {}) {
    if (!isId(body.from)) throw httpError(400, 'BAD_IDS', 'from must be a person id');
    const groupIds = faceIdsOf(body, 'groupIds'), keep = faceIdsOf(body, 'keep');
    if (!groupIds.length && !keep.length) throw httpError(400, 'BAD_IDS', 'choose at least one face');
    if (groupIds.some(g => keep.includes(g))) throw httpError(400, 'BAD_IDS', 'a face cannot be moved and kept');
    refuseDuringMigrate();
    const partners = suggestionPartners([id, body.from]);
    const out = people.moveGroups(id, body.from, groupIds, keep);
    if (out.moved.length && freshNow([id])) out.person = people.get(id);
    touched([id, ...(out.fromPerson ? [body.from] : []), ...partners]);
    return out;
  }

  /**
   * The cards of a review (F2, F3, F4): POST /faces/check-faces { groupIds, personId? }
   * -> { items: [{ groupId, mediaId, filename, mediaType, timeS, bbox, cropUrl,
   *      personId, personName, hidden, rejected, tier }] } in the order asked.
   * tier (with personId): 'likely' = a strong match for that person (cosine
   * >= mightLikely with the mightMargin over every other named person, from
   * the sorting job's centroids), 'maybe' otherwise, null when unknown.
   * rejected: the user said this face is not personId.
   */
  function checkFaces(body = {}) {
    const groupIds = faceIdsOf(body, 'groupIds', { max: 200 });
    const pid = body.personId == null ? null : body.personId;
    if (pid != null && !isId(pid)) throw httpError(400, 'BAD_IDS', 'personId must be a person id');
    if (pid != null) people.requirePerson(pid);
    const db = database.get();
    if (!groupIds.length) return { items: [] };
    const ph = groupIds.map(() => '?').join(',');
    const rows = new Map(db.prepare(`SELECT g.id, g.media_id, g.cluster_id, g.first_time_s, g.best_time_s, g.best_bbox, g.hidden, g.model,
        m.filename, m.media_type, p.name AS pname
      FROM face_groups g JOIN media m ON m.id = g.media_id LEFT JOIN face_people p ON p.id = g.cluster_id
      WHERE g.id IN (${ph})`).all(...groupIds).map(r => [r.id, r]));
    const rejected = new Set(pid == null ? [] : db.prepare(`SELECT group_id FROM face_person_rejects WHERE person_id = ? AND group_id IN (${ph})`)
      .all(pid, ...groupIds).map(r => r.group_id));
    let scores = null;
    if (pid != null) {
      const vecs = new Map();
      for (const r of db.prepare(`SELECT group_id, embedding FROM face_vectors WHERE group_id IN (${ph}) ORDER BY id`).all(...groupIds)) {
        if (!vecs.has(r.group_id)) vecs.set(r.group_id, []);
        vecs.get(r.group_id).push(store.decodeEmbedding(r.embedding));
      }
      const asks = groupIds.map(g => {
        const list = vecs.get(g);
        if (!rows.has(g) || !list || !list.length) return { model: null, vec: null };
        const out = new Float32Array(list[0].length);
        for (const v of list) for (let k = 0; k < out.length; k++) out[k] += v[k];
        return { model: rows.get(g).model, vec: store.normalize(out) };
      });
      try { scores = sorter.scoreFaces(pid, asks); } catch { scores = null; }
      if (!scores) sorter.schedule();   // no centroids in memory yet: the next run builds them
    }
    const parse = (t) => { try { const b = JSON.parse(t); return Array.isArray(b) && b.length === 4 ? b : null; } catch { return null; } };
    const items = [];
    groupIds.forEach((g, i) => {
      const r = rows.get(g);
      if (!r) return;
      const s = scores && scores[i];
      const th = peopleThresholds(r.model);
      const video = r.media_type === 'video';
      items.push({
        groupId: g, mediaId: r.media_id, filename: r.filename, mediaType: r.media_type,
        timeS: video ? (r.best_time_s ?? r.first_time_s ?? null) : null,
        firstTimeS: video ? (r.first_time_s ?? null) : null,
        bbox: parse(r.best_bbox), cropUrl: people.cropUrlOf(g),
        personId: r.cluster_id ?? null, personName: r.pname ?? null, hidden: !!r.hidden, rejected: rejected.has(g),
        tier: !s ? null : (s.score >= th.mightLikely && s.score - s.second >= th.mightMargin ? 'likely' : 'maybe'),
      });
    });
    return { items };
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
      modelSwitch.suspend();
      await Promise.all([queue.settled(), sorter.settled(), modelSwitch.settled()]);
      store.deleteAllData();
      libCache = null;
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
    modelSwitch.suspend(); // stops at once; nothing it computed is written after this
    libCache = null;
    people.resetCaches();
    dropEngine();          // frames and embeddings live in the engine workers too
    index.reset();
    queries.clear();
    countsCache = null;
  }

  function onVaultUnlocked() { queue.unsuspend(); sorter.schedule(); modelSwitch.schedule(); }

  /* ── Model switch controls ────────────────────────────────────────────── */

  function pauseModelSwitch() {
    modelSwitch.setPaused(true);
    return status();
  }

  function resumeModelSwitch() {
    refuseDuringMigrate();
    modelSwitch.setPaused(false);
    return status();
  }

  /** Files the switch could not read: [{ mediaId, filename, model, reason, at }]. */
  function modelSwitchStuck() {
    try { return { files: modelSwitch.stuckFiles() }; } catch { return { files: [] }; }
  }

  /** Try the files the switch could not read again (POST /faces/model-switch/retry). */
  function retryModelSwitch() {
    refuseDuringMigrate();
    modelSwitch.retry();
    return status();
  }

  /** modelSwitch status for /api/faces/status and the scan panel (null when none is pending). */
  function switchStatus() {
    try { return modelSwitch.status(); } catch { return null; }
  }

  function counts() {
    const serving = servingModels();
    const mid = serving.length > 1 ? serving : (serving[0] ?? null);
    const v = store.version();
    const t = now();
    if (countsCache && countsCache.version === v && String(countsCache.modelId) === String(mid) && t - countsCache.at < COUNTS_TTL_MS) {
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
    // The scan panel's Faces tab shows a model switch as its own line.
    st.modelSwitch = switchStatus();
    return st;
  }

  /** Per keeper: file on disk, why not, consent, size, whether it is downloading now. */
  function faceModelsStatus(m) {
    const out = {};
    for (const n of KEEPER_NAMES) {
      const key = KEEPERS[n].key;
      const reason = m.keyed ? ((m.allReasons || {})[key] || (m.paths[key] ? null : 'absent')) : null;
      let allowed = false;
      try { allowed = !!consent.isAllowed(key); } catch { /* consent store unreadable */ }
      out[n] = {
        key, label: KEEPERS[n].label, modelId: KEEPERS[n].modelId,
        present: m.keyed ? !reason : null, reason, consent: allowed,
        sizeHint: FACE_MODELS[key].sizeHint, bytes: FACE_MODELS[key].bytes,
        downloading: !!(dl && dl.running && dl.model === n),
      };
    }
    return out;
  }

  function status() {
    const s = getSettings();
    const m = models();
    let active = null;
    try { active = modelId(); } catch { /* engine factory failed */ }
    let last = null;
    try { last = modelSwitch.lastSwitch(); } catch { /* DB closed */ }
    return {
      enabled: s.enabled,
      autoIndex: s.autoIndex,
      intervalS: s.intervalS,
      maxFrames: s.maxFrames,
      facesModel: s.model,          // the choice: 'ir50' (Standard) | 'ir101' (Best)
      activeModel: active,          // model id new files are indexed with (null: not ready)
      needsModel: m.needsModel,     // the choice is not on disk yet: offer its download
      faceModels: faceModelsStatus(m),
      modelsReady: m.ready,
      missing: m.missing,
      missingReasons: m.reasons,   // key -> 'absent' | 'size' | 'corrupt'
      download: dl ? { running: dl.running, model: dl.model || null, received: dl.received, total: dl.total, error: dl.error } : null,
      modelSwitch: switchStatus(),  // { from, to, done, total, paused, running, etaS, current, fallbacks, failed } or null
      lastModelSwitch: last,
      counts: counts(),
      queue: queueStatus(),
      people: peopleStatus(),
    };
  }

  return {
    // settings / status
    getSettings, updateSettings, status, lockGeneration: () => lockGen, models, modelId, servingModels, startDownload, downloadSettled,
    // model switch
    pauseModelSwitch, resumeModelSwitch, retryModelSwitch, modelSwitchStuck, scheduleModelSwitch: () => modelSwitch.schedule(), modelSwitchSettled: () => modelSwitch.settled(),
    // indexing
    enqueue, autoEnqueue, findFacesNow, fileFaces,
    pause: () => queue.pause(), resume: () => { refuseDuringMigrate(); requireModels(); return queue.resume(); },
    cancel: () => queue.cancel(), queueStatus, settled: () => queue.settled(),
    isBusy: () => queue.isBusy() || modelSwitch.isRunning(),
    // search
    similarToGroup, similarToQuery, searchImage, queryCrop, groupCrop, hideGroup, unhideGroup, notFaceGroup,
    // people
    listPeople, getPerson, personFiles, personFaces, updatePerson, mergePeople, notInPerson, restorePerson, reviewPairs, answerReview,
    addToPerson, createPerson, personCandidates, answerCandidates, notFacePerson, reviewFaces, moveFaces, checkFaces,
    schedulePeople: () => sorter.schedule(), sortPeopleNow: () => sorter.runNow(), peopleSettled: () => sorter.settled(),
    // lifecycle
    deleteAll, onVaultLocked, onVaultUnlocked,
    // test seams
    _index: index, _queue: queue, _engines: { queue: queueEngines, frame: frameEngines, file: fileEngines }, _queries: queries, _autoSkipped: () => autoSkipped, _sorter: sorter, _modelSwitch: modelSwitch,
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
