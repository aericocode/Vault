/**
 * Face engine: detect faces in a frame, embed one face as a 128-d vector.
 *
 *   const engine = createEngine({ backend: 'onnx' });   // or 'stub'
 *   await engine.load();                                // lazy; throws FACE_MODELS_MISSING
 *   const faces = await engine.detect(frame, { minScore, minFacePx });
 *   const vec = await engine.embed(frame, faces[0]);    // Float32Array(128), L2-normalized
 *   engine.close();
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
const { resolveFaceModelPaths, FACE_MODEL_KEYS } = require('./models');
const { buildCore } = require('./onnx-core');

const DEFAULT_MIN_SCORE = 0.75;
const DEFAULT_THREADS = 2;

function createEngine({ backend = 'onnx', modelPaths, threads, inProcess = false, ...rest } = {}) {
  if (backend === 'stub') return require('./stub').createStubEngine(rest);
  if (backend !== 'onnx') throw new Error(`unknown face engine backend: ${backend}`);
  return inProcess ? new InProcessEngine({ modelPaths, threads }) : new WorkerEngine({ modelPaths, threads });
}

function modelsMissing(missing, dir) {
  const e = new Error(`face models missing: ${missing.join(', ')}` + (dir ? ` (looked in ${dir})` : ''));
  e.code = 'FACE_MODELS_MISSING';
  e.missing = missing;
  return e;
}

/** Model paths to load, or throw FACE_MODELS_MISSING naming the absent keys. */
function _checkPaths(modelPaths) {
  if (!modelPaths) {
    const r = resolveFaceModelPaths();
    if (!r.ok) throw modelsMissing(r.missing, r.dir);
    return r.paths;
  }
  const missing = FACE_MODEL_KEYS.filter((k) => !modelPaths[k] || !fs.existsSync(modelPaths[k]));
  if (missing.length) throw modelsMissing(missing);
  return modelPaths;
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
  constructor({ modelPaths, threads }) {
    this.backend = 'onnx';
    this.modelId = 'sface-2021dec';
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
   * @param opts.minScore  detection confidence floor (default 0.75)
   * @param opts.minFacePx drop faces whose shorter bbox side is below this, in frame pixels
   * @returns [{ bbox:[x,y,w,h] 0..1, score, landmarks:[[x,y]x5] 0..1 }] best score first
   */
  async detect(frame, { minScore = DEFAULT_MIN_SCORE, minFacePx = 0 } = {}) {
    await this.load();
    return this._serial(() => this._detect(frame, minScore, minFacePx));
  }

  /** 5-point alignment to the 112 template, SFace, L2-normalized Float32Array(128). */
  async embed(frame, face) {
    await this.load();
    return this._serial(() => this._embed(frame, face.landmarks));
  }
}

class InProcessEngine extends BaseEngine {
  async _load() {
    const paths = _checkPaths(this._modelPaths);
    const core = buildCore(_ortRequire()('onnxruntime-node'));
    this._core = new core.OnnxCore();
    await this._core.load(paths, this._threads);
  }
  _detect(frame, minScore, minFacePx) { return this._core.detect(frame, minScore, minFacePx); }
  _embed(frame, landmarks) { return this._core.embed(frame, landmarks); }
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
    else if (m.op === 'embed') result = await engine.embed(f, m.landmarks);
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
    const paths = _checkPaths(this._modelPaths);
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

  _embed(frame, landmarks) {
    return this._send(this._withFrame({ op: 'embed', landmarks }, frame));
  }

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
  l2normalize: pure.l2normalize, alignedToTensor: pure.alignedToTensor,
};
