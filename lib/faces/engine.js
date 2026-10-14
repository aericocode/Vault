/**
 * Face engine: detect faces in a frame, embed one face.
 *
 *   const engine = createEngine({ backend: 'onnx', keeper: 'ir50' });   // or 'stub'
 *   await engine.load();                                // lazy; throws FACE_MODELS_MISSING
 *   const faces = await engine.detect(frame, { minScore, minFacePx });
 *   const vec = await engine.embed(frame, faces[0]);    // SFace Float32Array(128), L2-normalized
 *   const kv = await engine.embedKeeper(frame, faces[0]);   // keeper Float32Array(512)
 *   engine.close();
 *
 * Grunt and keeper (models.js): embed / embedWithNorm are always SFace (the
 * norm filter and within-file grouping use it). The keeper (AdaFace IR-50 or
 * IR-101, option keeper: 'ir50' | 'ir101') embeds what is stored:
 *   embedKeeper(frame, face, [modelId])     one face of the current frame
 *   embedWithNorm(frame, face, { keepCrop: true }) also keeps the aligned crop
 *     in the worker and returns its cropId; embedCrops(ids, [modelId]) later
 *     embeds (and frees) those crops, freeCrops(ids) drops them.
 * engine.modelId is the id of the vectors analyze.js stores: the keeper's
 * (models.js KEEPERS) or 'sface-2021dec' without a keeper (libraries indexed
 * before keepers). engine.keeperIds lists every keeper model id this engine
 * can embed with (its own plus any other keeper file it was given, so a
 * search during a model switch can embed a query face in both spaces).
 * Keeper sessions are created on first use and go with the engine (the pool
 * closes idle engines, and every engine on a vault lock).
 *
 * Backends
 *   onnx  YuNet 2023mar (detector) + SFace 2021dec (recognizer) on
 *         onnxruntime-node, CPU only. engine.modelId = 'sface-2021dec'.
 *         Each engine owns ONE worker thread that does all the pixel work and
 *         inference (onnxruntime-node blocks its calling thread for the whole
 *         run, see onnx-core.js), so the server's event loop stays free and N
 *         engines really run in parallel. `inProcess: true` skips the worker
 *         (harness/debug only).
 *   stub  No models, fully deterministic, for tests. See lib/faces/stub.js.
 *
 * engine.frames is the frame source analyze.js reads files through: the real
 * ffmpeg module (lib/faces/frames.js) for onnx, a disk-free fake for the stub.
 * Server code that needs "the frame at 12.3 s" should call
 * engine.frames.grabFrame() so stub-backed tests never need ffmpeg.
 *
 * Frames are packed RGB (see frames.js) and must not be mutated after being
 * handed to an engine: the worker keeps the most recent frame so detect() and
 * the embed() calls that follow it send the pixels across only once.
 * Calls on one engine are serialized; for N parallel workers create N engines.
 */

const path = require('path');
const fs = require('fs');
const { resolveFaceModelPaths, FACE_MODEL_KEYS, KEEPERS, KEEPER_KEYS, SFACE_MODEL_ID, keeperNameOf } = require('./models');
const { buildCore } = require('./onnx-core');

const DEFAULT_MIN_SCORE = 0.80;
const DEFAULT_THREADS = 2;

function createEngine({ backend = 'onnx', modelPaths, threads, inProcess = false, keeper = null, ...rest } = {}) {
  if (backend === 'stub') return require('./stub').createStubEngine({ keeper, ...rest });
  if (backend !== 'onnx') throw new Error(`unknown face engine backend: ${backend}`);
  if (keeper != null && !KEEPERS[keeper]) throw new Error(`unknown face keeper model: ${keeper}`);
  return inProcess ? new InProcessEngine({ modelPaths, threads, keeper }) : new WorkerEngine({ modelPaths, threads, keeper });
}

function modelsMissing(missing, dir) {
  const e = new Error(`face models missing: ${missing.join(', ')}` + (dir ? ` (looked in ${dir})` : ''));
  e.code = 'FACE_MODELS_MISSING';
  e.missing = missing;
  return e;
}

/**
 * Model paths to load, or throw FACE_MODELS_MISSING naming the absent keys.
 * Required: the grunt models and this engine's keeper; other keepers are
 * passed on when present (optional, for searches during a model switch).
 */
function _checkPaths(modelPaths, keeper) {
  const need = keeper ? [...FACE_MODEL_KEYS, KEEPERS[keeper].key] : [...FACE_MODEL_KEYS];
  if (!modelPaths) {
    const r = resolveFaceModelPaths({ keys: need });
    if (!r.ok) throw modelsMissing(r.missing, r.dir);
    const extra = resolveFaceModelPaths({ keys: KEEPER_KEYS.filter((k) => !need.includes(k)) });
    for (const k of extra.present) r.paths[k] = extra.paths[k];
    return r.paths;
  }
  const missing = need.filter((k) => !modelPaths[k] || !fs.existsSync(modelPaths[k]));
  if (missing.length) throw modelsMissing(missing);
  const out = {};
  for (const k of [...FACE_MODEL_KEYS, ...KEEPER_KEYS]) {
    if (modelPaths[k] && (need.includes(k) || fs.existsSync(modelPaths[k]))) out[k] = modelPaths[k];
  }
  return out;
}

/** Registry key of a keeper model id (throws for SFace / unknown ids). */
function _keeperKey(modelId) {
  const n = keeperNameOf(modelId);
  if (!n || KEEPERS[n].modelId !== modelId) throw new Error(`not a keeper model: ${modelId}`);
  return KEEPERS[n].key;
}

/** Add every keeper whose file the engine got to engine.keeperIds. */
function _knownKeepers(engine, paths) {
  for (const n of Object.keys(KEEPERS)) {
    if (paths[KEEPERS[n].key] && !engine.keeperIds.includes(KEEPERS[n].modelId)) engine.keeperIds.push(KEEPERS[n].modelId);
  }
}

/**
 * require() for onnxruntime-node: the packaged exe loads native addons from
 * runtime/node_modules beside it (same pattern as lib/database.js), dev from
 * the repo. Going through createRequire also keeps esbuild from trying to
 * bundle the addon.
 */
function _ortRequire() {
  const { createRequire } = require('module');
  const { isSea, ROOT } = require('../approot');
  return isSea ? createRequire(path.join(ROOT, 'runtime', 'index.js')) : createRequire(__filename);
}

class BaseEngine {
  constructor({ modelPaths, threads, keeper = null }) {
    this.backend = 'onnx';
    this.keeper = keeper;
    this.modelId = keeper ? KEEPERS[keeper].modelId : SFACE_MODEL_ID;
    this.gruntId = SFACE_MODEL_ID;
    // Known before load() when paths were handed in; load() completes it otherwise.
    this.keeperIds = keeper ? [KEEPERS[keeper].modelId] : [];
    if (modelPaths) {
      for (const n of Object.keys(KEEPERS)) {
        if (n !== keeper && modelPaths[KEEPERS[n].key] && fs.existsSync(modelPaths[KEEPERS[n].key])) this.keeperIds.push(KEEPERS[n].modelId);
      }
    }
    this.detectorId = 'yunet-2023mar';
    this.frames = require('./frames');
    this._modelPaths = modelPaths || null;
    this._threads = Math.max(1, (threads | 0) || DEFAULT_THREADS);
    this._loading = null;
    this._queue = Promise.resolve();
  }

  load() {
    if (!this._loading) {
      this._loading = this._load().catch((e) => { this._loading = null; throw e; });
    }
    return this._loading;
  }

  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * @param frame {width,height,data RGB}
   * @param opts.minScore  detection confidence floor (default 0.80)
   * @param opts.minFacePx drop faces whose shorter bbox side is below this, in frame pixels
   * @returns [{ bbox:[x,y,w,h] 0..1, score, landmarks:[[x,y]x5] 0..1 }] best score first
   */
  async detect(frame, { minScore = DEFAULT_MIN_SCORE, minFacePx = 0 } = {}) {
    // load() again inside the serialized step: if the engine was closed while
    // this call waited its turn, it reloads instead of failing.
    return this._serial(async () => { await this.load(); return this._detect(frame, minScore, minFacePx); });
  }

  /** 5-point alignment to the 112 template, SFace, L2-normalized Float32Array(128). */
  async embed(frame, face) {
    return (await this.embedWithNorm(frame, face)).embedding;
  }

  /**
   * Like embed, plus the embedding's length before L2 normalisation (SFace:
   * low = a face the model cannot read well, or not a face at all).
   * opts.keepCrop: keep the aligned crop for embedCrops (result.cropId).
   * @returns {{ embedding: Float32Array, norm: number, cropId?: number }}
   */
  async embedWithNorm(frame, face, { keepCrop = false } = {}) {
    return this._serial(async () => { await this.load(); return this._embed(frame, face.landmarks, keepCrop); });
  }

  /** Keeper embedding of one face of `frame` (L2-normalized, 512-d). */
  async embedKeeper(frame, face, modelId = this.modelId) {
    const key = _keeperKey(modelId);
    return this._serial(async () => { await this.load(); return this._embedKeeper(frame, face.landmarks, key); });
  }

  /** Keeper embeddings of crops kept by embedWithNorm (null = crop gone); frees them. */
  async embedCrops(ids, modelId = this.modelId) {
    const key = _keeperKey(modelId);
    return this._serial(async () => { await this.load(); return this._embedCrops(ids, key); });
  }

  /** Drop kept crops (the given ids, or all). */
  async freeCrops(ids = null) {
    return this._serial(async () => (this._loaded() ? this._freeCrops(ids) : 0));
  }
}

class InProcessEngine extends BaseEngine {
  async _load() {
    const paths = _checkPaths(this._modelPaths, this.keeper);
    _knownKeepers(this, paths);
    const core = buildCore(_ortRequire()('onnxruntime-node'));
    this._core = new core.OnnxCore();
    await this._core.load(paths, this._threads);
  }
  _loaded() { return !!this._core; }
  _detect(frame, minScore, minFacePx) { return this._core.detect(frame, minScore, minFacePx); }
  _embed(frame, landmarks, keepCrop) { return this._core.embedRaw(frame, landmarks, keepCrop); }
  _embedKeeper(frame, landmarks, key) { return this._core.embedKeeper(frame, landmarks, key); }
  _embedCrops(ids, key) { return this._core.embedCrops(ids, key); }
  _freeCrops(ids) { return this._core.freeCrops(ids); }
  close() {
    const c = this._core;
    this._core = null;
    this._loading = null;
    if (c) c.close().catch(() => {});
  }
}

// Worker source: built from buildCore's text so it needs no file on disk.
const WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const ort = require('module').createRequire(workerData.ortEntry)(workerData.ortEntry);
const core = (${buildCore.toString()})(ort);
const engine = new core.OnnxCore();
let frameId = -1, frame = null;
parentPort.on('message', async (m) => {
  try {
    if (m.frame) { frame = m.frame; frameId = m.frameId; }
    else if (m.frameId !== undefined && m.frameId !== frameId) throw new Error('frame not cached in face worker');
    const f = frame;
    let result;
    if (m.op === 'load') result = await engine.load(m.paths, m.threads);
    else if (m.op === 'detect') result = await engine.detect(f, m.minScore, m.minFacePx);
    else if (m.op === 'embed') result = await engine.embedRaw(f, m.landmarks, !!m.keepCrop);
    else if (m.op === 'embedKeeper') result = await engine.embedKeeper(f, m.landmarks, m.key);
    else if (m.op === 'embedCrops') result = await engine.embedCrops(m.ids, m.key);
    else if (m.op === 'freeCrops') result = engine.freeCrops(m.ids);
    else if (m.op === 'close') result = await engine.close();
    parentPort.postMessage({ id: m.id, ok: true, result });
  } catch (e) {
    parentPort.postMessage({ id: m.id, ok: false, error: { message: String((e && e.message) || e), code: e && e.code } });
  }
});
`;

class WorkerEngine extends BaseEngine {
  constructor(opts) {
    super(opts);
    this._worker = null;
    this._pending = new Map();
    this._seq = 0;
    this._frameSeq = 0;
    this._lastFrame = null;
  }

  async _load() {
    const paths = _checkPaths(this._modelPaths, this.keeper);
    _knownKeepers(this, paths);
    const ortEntry = _ortRequire().resolve('onnxruntime-node');
    const { Worker } = require('worker_threads');
    const w = new Worker(WORKER_SRC, { eval: true, workerData: { ortEntry }, name: 'vault-faces' });
    w.unref();                         // idle engines never keep the process alive
    w.on('message', (m) => this._reply(m));
    const fail = (err) => {
      if (this._worker !== w) return;
      this._worker = null;
      this._loading = null;
      this._lastFrame = null;
      const e = err instanceof Error ? err : new Error(`face worker exited (${err})`);
      for (const p of this._pending.values()) p.reject(e);
      this._pending.clear();
    };
    w.on('error', fail);
    w.on('exit', (code) => fail(code));
    this._worker = w;
    await this._send({ op: 'load', paths, threads: this._threads });
  }

  _send(msg) {
    const w = this._worker;
    if (!w) return Promise.reject(new Error('face worker is not running'));
    return new Promise((resolve, reject) => {
      const id = ++this._seq;
      if (this._pending.size === 0) w.ref();   // keep the process up while a call is in flight
      this._pending.set(id, { resolve, reject });
      w.postMessage({ ...msg, id });
    });
  }

  _reply(m) {
    const p = this._pending.get(m.id);
    if (!p) return;
    this._pending.delete(m.id);
    if (this._pending.size === 0 && this._worker) this._worker.unref();
    if (m.ok) p.resolve(m.result);
    else p.reject(Object.assign(new Error(m.error.message), m.error.code ? { code: m.error.code } : {}));
  }

  _withFrame(msg, frame) {
    if (frame !== this._lastFrame) {
      this._lastFrame = frame;
      msg.frame = { width: frame.width, height: frame.height, data: frame.data };
    }
    msg.frameId = this._frameSeq += msg.frame ? 1 : 0;
    return msg;
  }

  _detect(frame, minScore, minFacePx) {
    return this._send(this._withFrame({ op: 'detect', minScore, minFacePx }, frame));
  }

  _loaded() { return !!this._worker; }

  _embed(frame, landmarks, keepCrop) {
    return this._send(this._withFrame({ op: 'embed', landmarks, keepCrop: !!keepCrop }, frame));
  }

  _embedKeeper(frame, landmarks, key) {
    return this._send(this._withFrame({ op: 'embedKeeper', landmarks, key }, frame));
  }

  // Crops live in the worker: no frame is sent.
  _embedCrops(ids, key) { return this._send({ op: 'embedCrops', ids, key }); }
  _freeCrops(ids) { return this._send({ op: 'freeCrops', ids }); }

  close() {
    const w = this._worker;
    this._worker = null;
    this._loading = null;
    this._lastFrame = null;
    for (const p of this._pending.values()) p.reject(new Error('face engine closed'));
    this._pending.clear();
    if (w) w.terminate().catch(() => {});
  }
}

const { pure } = require('./onnx-core');

module.exports = {
  createEngine, DEFAULT_MIN_SCORE,
  // exposed for tests / harness
  letterboxBGR: pure.letterboxBGR, decodeYuNet: pure.decodeYuNet, nms: pure.nms, iou: pure.iou,
  l2normalize: pure.l2normalize, alignedToTensor: pure.alignedToTensor, alignedToTensorPm1: pure.alignedToTensorPm1,
};
