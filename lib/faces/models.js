/**
 * Face model registry: what the two ONNX files are, where they come from,
 * how to verify them, and where they live on disk.
 *
 * Location follows the other downloaded models (models/diarize, models/opus-mt):
 *   FACE_MODEL_DIR env  >  config.faces.modelDir  >  ROOT/models/faces
 *
 * Model files are never committed to the repo. URLs are pinned to a Hugging
 * Face revision of the official OpenCV mirrors of opencv_zoo, and the sha256
 * values match the opencv_zoo Git LFS pointers for the same files, so a
 * downloader must verify both size and hash before moving a file into place.
 *
 * Licences were checked against the LICENSE file shipped beside each model in
 * the same repo revision: YuNet MIT (Shiqi Yu), SFace Apache-2.0. Do NOT swap
 * in InsightFace/ArcFace weights: their terms are non-commercial.
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../approot');

const FACE_MODELS = {
  'face:detect': {
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    bytes: 232589,
    sizeHint: '~0.2 MB',
    license: 'MIT',
    licenseUrl: 'https://huggingface.co/opencv/face_detection_yunet/blob/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/LICENSE',
    source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
    label: 'face detection model',
  },
  'face:embed': {
    file: 'face_recognition_sface_2021dec.onnx',
    url: 'https://huggingface.co/opencv/face_recognition_sface/resolve/3d7082438a6e4551e840c9b2bb60b71e8da4b524/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79',
    bytes: 38696353,
    sizeHint: '~37 MB',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/opencv/face_recognition_sface/blob/3d7082438a6e4551e840c9b2bb60b71e8da4b524/LICENSE',
    source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface',
    label: 'face recognition model',
  },
};

const FACE_MODEL_KEYS = Object.keys(FACE_MODELS);

/**
 * Library search thresholds (cosine between L2-normalized embeddings) for the
 * three UI positions, per embedding model. Calibrated through this pipeline on
 * LFW (11,614 same-person vs 4.48 M different-person pairs):
 *   close  0.50  TPR 94.4%  FPR 0.0015%
 *   normal 0.42  TPR 98.4%  FPR 0.017%
 *   wide   0.36  TPR 99.3%  FPR ~0.15%   (OpenCV's published 0.363)
 * Real library faces (video frames, blur, angles) score lower than LFW, so
 * expect somewhat lower recall at each position. The stub model uses the same
 * numbers (its same-person variants sit at 0.8-0.9, strangers below 0.35).
 *
 * people / suggest: sorting faces into people across the library
 * (FACES_PEOPLE_SPEC section 9, clustering spike on 10,262 LFW groups). A
 * group joins a person at centroid cosine >= people (0.50: about 99% pure,
 * 99% recall; at 0.42 errors chain across a library). Pairs of people whose
 * best similarity falls in [suggest, people) become "Same person?" questions.
 */
const MATCH_THRESHOLDS = {
  'sface-2021dec': { close: 0.5, normal: 0.42, wide: 0.36, people: 0.5, suggest: 0.42 },
  'stub-v1': { close: 0.5, normal: 0.42, wide: 0.36, people: 0.5, suggest: 0.42 },
};

function matchThresholds(modelId) {
  const t = MATCH_THRESHOLDS[modelId];
  if (!t) throw new Error(`no match thresholds for face model ${modelId}`);
  return t;
}

function faceModelDir() {
  if (process.env.FACE_MODEL_DIR) return process.env.FACE_MODEL_DIR;
  let cfgDir = null;
  try { cfgDir = require('../../config').faces?.modelDir; } catch {}
  return cfgDir || path.join(ROOT, 'models', 'faces');
}

/**
 * Which face model files are on disk?
 * Presence is "exists with the registered byte size" (cheap; a full sha256 of
 * 37 MB on every check is not). Use verifyFaceModel() after a download.
 *
 * @param {{dir?: string}} [opts]
 * @returns {{dir, paths: {[key]: string}, present: string[], missing: string[], ok: boolean}}
 */
function resolveFaceModelPaths({ dir } = {}) {
  const base = dir || faceModelDir();
  const paths = {}, present = [], missing = [];
  for (const key of FACE_MODEL_KEYS) {
    const p = path.join(base, FACE_MODELS[key].file);
    paths[key] = p;
    let ok = false;
    try { ok = fs.statSync(p).size === FACE_MODELS[key].bytes; } catch {}
    (ok ? present : missing).push(key);
  }
  return { dir: base, paths, present, missing, ok: missing.length === 0 };
}

/**
 * Download registry entries for lib/faces/download.js:
 *   [{ key, url, sha256, size, dest }]   dest = <faceModelDir()>/<file>
 * download.js checks exactly what verifyFaceModel() checks (byte size + sha256)
 * and readiness uses the same exact-size test as resolveFaceModelPaths().
 */
function downloadEntries({ dir } = {}) {
  const base = dir || faceModelDir();
  return FACE_MODEL_KEYS.map((key) => ({
    key, url: FACE_MODELS[key].url, sha256: FACE_MODELS[key].sha256,
    size: FACE_MODELS[key].bytes, dest: path.join(base, FACE_MODELS[key].file),
  }));
}

/** Full sha256 check of one model file (for use right after a download). */
function verifyFaceModel(key, filePath) {
  const m = FACE_MODELS[key];
  if (!m) throw new Error(`unknown face model key ${key}`);
  const crypto = require('crypto');
  const buf = fs.readFileSync(filePath);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  return { ok: buf.length === m.bytes && sha === m.sha256, bytes: buf.length, sha256: sha };
}

module.exports = {
  FACE_MODELS, FACE_MODEL_KEYS, MATCH_THRESHOLDS, matchThresholds,
  faceModelDir, resolveFaceModelPaths, verifyFaceModel, downloadEntries,
};
