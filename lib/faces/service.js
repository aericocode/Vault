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
const { thresholdFor, WIDTHS } = require('./thresholds');
const downloadLib = require('./download');

const INTERVALS = Object.freeze([2, 3.5, 10]);
const DEFAULT_INTERVAL_S = 3.5;
const MAX_FRAMES = 2000;
const MAX_SIDE = 1280;
const QUERY_TTL_MS = 15 * 60 * 1000;
const QUERY_MAX = 50;
const COUNTS_TTL_MS = 3000;
const MAX_TIME_S = 1e7;   // no duration on record: reject anything past ~115 days
const FACE_KEYS = Object.freeze(['face:detect', 'face:embed']);

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code }, extra);
}

/** Requires `name` (relative to this dir) on first property access. */
function lazyModule(name) {
  return new Proxy({}, { get: (_t, key) => require(name)[key] });
}

/*
 * TODO-WIRE (engine merge): replace this placeholder with the engine agent's
 * model registry. Expected shape:
 *   createFileModelStore(() => require('./<registry>').entries())
 * where entries() -> [{ key: 'face:detect'|'face:embed', url, sha256, size, dest }].
 * Until then models always read as missing, so every engine route answers
 * 409 FACE_MODELS_MISSING and downloads report "no download source".
 */
const placeholderModelStore = {
  entries: () => [],
  status: () => ({ ready: false, missing: [...FACE_KEYS], paths: {} }),
};

function createService(deps = {}) {
  const database = deps.database || require('../database');
  const settings = deps.settings || require('../app-settings');
  const consent = deps.consent || require('../model-consent');
  const modelStore = deps.modelStore || placeholderModelStore;
  // TODO-WIRE (engine merge): confirm createEngine's options (backend, threads)
  // and worker count against the engine report.
  const engineFactory = deps.engineFactory
    || ((opts) => require('./engine').createEngine({ backend: 'onnx', ...opts }));
  const analyze = deps.analyze || lazyModule('./analyze');
  const frames = deps.frames || lazyModule('./frames');
  const download = deps.download || downloadLib;
  const fetchImpl = deps.fetchImpl;   // undefined -> netFetch
  const now = deps.now || Date.now;
  const fileExists = deps.fileExists || fs.existsSync;
  const tmpRoot = deps.tmpDir || os.tmpdir();
  const isMigrateRunning = deps.isMigrateRunning || (() => _migrateProbe());

  const index = createIndex({ getDb: () => database.get() });
  const queue = createQueue({ runFile, workers: deps.workers || 2, now });
  const queries = new Map();   // queryId -> { embedding, bbox, crop, at }
  let engine = null;
  let engineLoading = null;
  let dl = null;               // { running, received, total, error, code }
  let dlCtrl = null;
  let countsCache = null;      // { at, version, modelId, value }
  let autoSkipped = 0;

  /* ── Settings ─────────────────────────────────────────────────────────── */

  function getSettings() {
    const a = settings.all();
    return {
      enabled: a.facesEnabled === true,
      autoIndex: a.facesAutoIndex === true,
      intervalS: INTERVALS.includes(a.facesIntervalS) ? a.facesIntervalS : DEFAULT_INTERVAL_S,
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
      if (typeof v !== 'number' || !INTERVALS.includes(v)) throw httpError(400, 'BAD_SETTING', `intervalS must be one of ${INTERVALS.join(', ')}`);
      patch.facesIntervalS = v;
    }
    if (Object.keys(patch).length) settings.set(patch);
    if (patch.facesEnabled === false) queue.cancel();
    return status();
  }

  /* ── Models and engine ────────────────────────────────────────────────── */

  function models() {
    const s = modelStore.status() || {};
    return { ready: !!s.ready, missing: Array.isArray(s.missing) ? s.missing : [], paths: s.paths || {} };
  }

  function engineInstance() {
    if (!engine) engine = engineFactory({ modelPaths: models().paths });
    return engine;
  }

  /** The current engine model id, or null while models are not available. */
  function modelId() {
    if (!models().ready) return null;
    try { return engineInstance().modelId || null; } catch { return null; }
  }

  async function loadedEngine() {
    const m = models();
    if (!m.ready) throw httpError(409, 'FACE_MODELS_MISSING', 'Face search models are not downloaded yet.', { missing: m.missing });
    if (!engineLoading) {
      engineLoading = (async () => { const e = engineInstance(); await e.load(); return e; })();
    }
    try {
      return await engineLoading;
    } catch (err) {
      engineLoading = null;
      dropEngine();
      if (err.code === 'FACE_MODELS_MISSING') {
        throw httpError(409, 'FACE_MODELS_MISSING', 'Face search models are not downloaded yet.', { missing: err.missing || m.missing });
      }
      throw err;
    }
  }

  function dropEngine() {
    const e = engine;
    engine = null;
    engineLoading = null;
    try { e?.close?.(); } catch { /* best effort */ }
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
    dl = { running: true, received: 0, total: entries.reduce((s, e) => s + (fs.existsSync(e.dest) ? 0 : Number(e.size) || 0), 0), error: null, code: null };
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
    const row = database.get().prepare(
      'SELECT id, filepath, filename, media_type, duration_seconds FROM media WHERE id = ?'
    ).get(item.id);
    const kind = store.kindOf(row);
    if (!row || !kind) return false;
    try {
      if (!fileExists(row.filepath)) throw new Error('File not found on disk');
      const eng = await loadedEngine();
      const result = await analyze.analyzeFile(eng, {
        filepath: row.filepath, kind, durationS: row.duration_seconds || undefined,
      }, { intervalS: getSettings().intervalS, maxFrames: MAX_FRAMES, signal, onProgress });
      if (signal?.aborted) return false;
      store.saveFileResult(row.id, eng.modelId, result, { isVideo: kind === 'video', now: now() });
      return true;
    } catch (err) {
      if (signal?.aborted) return false;
      try { store.markError(row.id, shortError(err)); } catch { /* DB closed */ }
      return false;
    }
  }

  const SQL_CHUNK = 500;

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
      rows = db.prepare(`SELECT id, filename, media_type, filepath FROM media
        WHERE user_trashed = 0 AND media_type IN (${types}) ${indexedClause} ORDER BY id`)
        .all(...(force ? [] : [mid]));
      asked = rows.length;
    } else {
      const list = parseIds(ids);
      if (!list || !list.length) throw httpError(400, 'BAD_IDS', 'ids must be a non-empty array of media ids');
      asked = list.length;
      for (let i = 0; i < list.length; i += SQL_CHUNK) {
        const chunk = list.slice(i, i + SQL_CHUNK);
        rows.push(...db.prepare(`SELECT id, filename, media_type, filepath FROM media
          WHERE id IN (${chunk.map(() => '?').join(',')}) AND media_type IN (${types}) ${indexedClause}`)
          .all(...chunk, ...(force ? [] : [mid])));
      }
    }
    const items = rows.filter(r => store.kindOf(r)).map(r => ({ id: r.id, filename: r.filename, force, reason }));
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
      const row = database.get().prepare('SELECT id, filename, filepath, media_type, user_trashed FROM media WHERE id = ?').get(mediaId);
      if (!row || row.user_trashed || !store.kindOf(row)) return false;
      return queue.enqueue([{ id: row.id, filename: row.filename, force: false, reason: 'auto' }]).added > 0;
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
    await queue.runNow({ id: row.id, filename: row.filename, force, reason: 'user' });
    return fileFaces(mediaId);
  }

  /* ── Search ───────────────────────────────────────────────────────────── */

  function widthOf(w) {
    if (w === undefined || w === null || w === '') return 'normal';
    if (!WIDTHS.includes(w)) throw httpError(400, 'BAD_WIDTH', `width must be one of ${WIDTHS.join(', ')}`);
    return w;
  }

  function searchVectors(vecs, width) {
    requireModels();
    const mid = modelId();
    if (!mid) throw httpError(409, 'FACE_MODELS_MISSING', 'Face search models are not available.', { missing: models().missing });
    return index.query(vecs, thresholdFor(widthOf(width)), mid);
  }

  function similarToGroup(groupId, width) {
    const g = store.groupInfo(groupId);
    if (!g) throw httpError(404, 'NOT_FOUND', 'face not found');
    widthOf(width);
    requireModels();
    if (g.model !== modelId()) throw httpError(409, 'FACE_MODEL_CHANGED', 'This face was found with an older model. Check the file again.');
    return searchVectors(store.groupVectors(groupId), width);
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
    return searchVectors([q.embedding], width);
  }

  const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif', 'image/tiff': '.tif' };

  /**
   * Detect faces in an uploaded photo ({ buffer, contentType }) or a frame of a
   * library file ({ mediaId, timeS }). Query faces live in memory only.
   */
  async function searchImage(input) {
    const eng = await loadedEngine();
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
    const found = await analyze.analyzeFrame(eng, frame, {});
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

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  async function deleteAll() {
    queue.cancel();
    await queue.settled();
    store.deleteAllData();
    index.reset();
    queries.clear();
    countsCache = null;
    return { ok: true };
  }

  /** Vault locked: stop work and drop every face vector held in memory. */
  function onVaultLocked() {
    queue.suspend();
    index.reset();
    queries.clear();
    countsCache = null;
  }

  function onVaultUnlocked() { queue.unsuspend(); }

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

  function status() {
    const s = getSettings();
    const m = models();
    return {
      enabled: s.enabled,
      autoIndex: s.autoIndex,
      intervalS: s.intervalS,
      modelsReady: m.ready,
      missing: m.missing,
      download: dl ? { running: dl.running, received: dl.received, total: dl.total, error: dl.error } : null,
      counts: counts(),
      queue: queue.status(),
    };
  }

  return {
    // settings / status
    getSettings, updateSettings, status, models, modelId, startDownload, downloadSettled,
    // indexing
    enqueue, autoEnqueue, findFacesNow, fileFaces,
    pause: () => queue.pause(), resume: () => { refuseDuringMigrate(); requireModels(); return queue.resume(); },
    cancel: () => queue.cancel(), queueStatus: () => queue.status(), settled: () => queue.settled(),
    isBusy: () => queue.isBusy(),
    // search
    similarToGroup, similarToQuery, searchImage, queryCrop, groupCrop, hideGroup,
    // lifecycle
    deleteAll, onVaultLocked, onVaultUnlocked,
    // test seams
    _index: index, _queue: queue, _queries: queries, _autoSkipped: () => autoSkipped,
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
function setInstance(svc) { _instance = svc; return svc; }

module.exports = {
  createService, instance, setInstance, setMigrateProbe,
  INTERVALS, MAX_FRAMES, QUERY_TTL_MS, QUERY_MAX, FACE_KEYS,
};
