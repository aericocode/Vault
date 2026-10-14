/**
 * Face model registry: what the ONNX files are, where they come from, how to
 * verify them, where they live on disk, and the match thresholds per model.
 *
 * Location follows the other downloaded models (models/diarize, models/opus-mt):
 *   FACE_MODEL_DIR env  >  config.faces.modelDir  >  ROOT/models/faces
 *
 * Model files are never committed to the repo. Every URL is pinned to a
 * Hugging Face revision and every file to its byte size and sha256, so a
 * downloader must verify both before moving a file into place.
 *
 * Two kinds of model (FACE_MODELS_SPEC, pipeline "H1"):
 *   grunt   YuNet (face:detect) + SFace (face:embed): detection, the norm
 *           filter and grouping faces WITHIN a file, on every face. URLs are
 *           the official OpenCV mirrors of opencv_zoo; licences checked
 *           against the LICENSE beside each file: YuNet MIT, SFace Apache-2.0.
 *   keeper  AdaFace IR-50 (face:keeper-ir50, "Standard", the default) or
 *           IR-101 (face:keeper-ir101, "Best"): embeds only the faces a file
 *           keeps (<= 3 exemplars per person in a video, every face of a
 *           photo). Those 512-d vectors are what is stored, sorted and searched.
 *   A library indexed before keepers existed stores SFace vectors (model id
 *   sface-2021dec, 128-d). It keeps working until the switch job
 *   (model-switch.js) has re-read it with a keeper.
 *
 * Keeper weights: AdaFace (Kim et al., CVPR 2022) trained on WebFace4M /
 * WebFace12M, as published in the CVLface repos minchul/cvlface_adaface_
 * ir50_webface4m and minchul/cvlface_adaface_ir101_webface12m. Those repos
 * carry NO licence file; the code is MIT and the training data is for
 * research use (the owner accepted that risk, 2026-10-14). Do NOT swap in
 * InsightFace/ArcFace weights either: their terms are non-commercial.
 * The ONNX files below are third-party exports of exactly those weights,
 * checked against our own export (model-bench README, "Follow-up"): worst
 * cosine 1.0000000 on Vault-aligned LFW crops and noise.
 * Input RGB 1x3x112x112, (x/255 - 0.5) / 0.5; output the raw 512-d feature.
 * Input/output tensor names differ between exports, so the engine reads them
 * from the session. To host the files elsewhere, change the ONE url constant
 * per keeper (IR50_URL / IR101_URL) and keep sha256 + bytes.
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../approot');

// Keeper download sources: one constant per model (see the header).
const IR50_URL = 'https://huggingface.co/palhs/ekyc-adaface-ir50/resolve/926fa0e9f05576fa577a3f07c11466b72b73976f/adaface.onnx';
const IR101_URL = 'https://huggingface.co/Evn9172/cvlface_adaface_ir101_webface12m_onnx/resolve/3af39a8cf2f199127f34e247950df9c4d6f227e8/adaface_ir101.onnx';

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
    sizeHint: '~39 MB',
    license: 'Apache-2.0',
    licenseUrl: 'https://huggingface.co/opencv/face_recognition_sface/blob/3d7082438a6e4551e840c9b2bb60b71e8da4b524/LICENSE',
    source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface',
    label: 'face recognition model',
  },
  'face:keeper-ir50': {
    file: 'adaface_ir50_webface4m.onnx',
    url: IR50_URL,
    sha256: 'aad39f394fea7ecae15761417e6dc187f1531dafbbe68f124eab682ea7e2f7c8',
    bytes: 174394454,
    sizeHint: '~174 MB',
    license: 'none stated (MIT code, research-use training data)',
    licenseUrl: 'https://huggingface.co/minchul/cvlface_adaface_ir50_webface4m',
    source: 'https://huggingface.co/minchul/cvlface_adaface_ir50_webface4m',
    label: 'face matching model (Standard)',
  },
  'face:keeper-ir101': {
    file: 'adaface_ir101_webface12m.onnx',
    url: IR101_URL,
    sha256: '6168ed3961838a871e706e8e5ebbf963de2821ecb3f64da9d5c3fd373cc80c65',
    bytes: 260701576,
    sizeHint: '~261 MB',
    license: 'none stated (MIT code, research-use training data)',
    licenseUrl: 'https://huggingface.co/minchul/cvlface_adaface_ir101_webface12m',
    source: 'https://huggingface.co/minchul/cvlface_adaface_ir101_webface12m',
    label: 'face matching model (Best)',
  },
};

/** The grunt models every engine loads (detection + SFace). */
const FACE_MODEL_KEYS = Object.freeze(['face:detect', 'face:embed']);

/**
 * Keepers by settings value (facesModel). modelId is what face_groups.model,
 * face_vectors_prev.model and media.faces_model record for vectors it made.
 */
const KEEPERS = Object.freeze({
  ir50: Object.freeze({ name: 'ir50', key: 'face:keeper-ir50', modelId: 'adaface-ir50-webface4m', dim: 512, label: 'Standard' }),
  ir101: Object.freeze({ name: 'ir101', key: 'face:keeper-ir101', modelId: 'adaface-ir101-webface12m', dim: 512, label: 'Best' }),
});
const KEEPER_NAMES = Object.freeze(Object.keys(KEEPERS));
const KEEPER_KEYS = Object.freeze(KEEPER_NAMES.map((n) => KEEPERS[n].key));
const DEFAULT_KEEPER = 'ir50';
const SFACE_MODEL_ID = 'sface-2021dec';
// Stub engine spaces (tests): stub-v1 = the SFace-keeper layout (128-d),
// stub-<keeper> = that keeper's layout (512-d) and thresholds.
const STUB_KEEPER_IDS = Object.freeze({ ir50: 'stub-ir50', ir101: 'stub-ir101' });

/** Vector length stored for a model id (null when unknown). */
function embedDim(modelId) {
  if (modelId === SFACE_MODEL_ID || modelId === 'stub-v1') return 128;
  const n = keeperNameOf(modelId);
  return n ? KEEPERS[n].dim : null;
}

/** Keeper settings name ('ir50' | 'ir101') of a model id, or null (SFace / unknown). */
function keeperNameOf(modelId) {
  for (const n of KEEPER_NAMES) if (KEEPERS[n].modelId === modelId || STUB_KEEPER_IDS[n] === modelId) return n;
  return null;
}

/**
 * Model ids the switch job may re-read into another one: the keeper family
 * (SFace-keeper, both AdaFace keepers, and their stub stand-ins). Files of
 * any other model id are left alone (shown as not indexed, as before).
 */
const SWITCHABLE = Object.freeze([SFACE_MODEL_ID, ...KEEPER_NAMES.map((n) => KEEPERS[n].modelId),
  'stub-v1', ...Object.values(STUB_KEEPER_IDS)]);

/**
 * Library search thresholds (cosine between L2-normalized embeddings) for the
 * three UI positions, per embedding model. SFace, calibrated through this
 * pipeline on LFW (11,614 same-person vs 4.48 M different-person pairs):
 *   close  0.50  TPR 94.4%  FPR 0.0015%
 *   normal 0.42  TPR 98.4%  FPR 0.017%
 *   wide   0.36  TPR 99.3%  FPR ~0.15%   (OpenCV's published 0.363)
 * Real library faces (video frames, blur, angles) score lower than LFW, so
 * expect somewhat lower recall at each position. The stub model uses the same
 * numbers (its same-person variants sit at 0.8-0.9, strangers below 0.35).
 *
 * people: sorting faces into people across the library (FACES_PEOPLE_SPEC
 * section 9, clustering spike on 10,262 LFW groups). A group joins a person
 * at centroid cosine >= people (0.50: about 99% pure, 99% recall; at 0.42
 * errors chain across a library).
 *
 * "Same person?" (person centroid vs person centroid, people-sort.js): an
 * unnamed person and its best named person become a question when the score
 * is >= suggest AND beats its second-best NAMED person by at least
 * suggestMargin; for people a user changed, also its best unnamed person
 * (margin over everyone). quality2 hard set (video-like faces), per 1,000:
 *   old rule (one face vs people, [0.46, 0.50))  166 questions, 29% right
 *   0.54 + 0.04 vs named people                    10 questions, 92% right
 *   0.54 + 0.04 unnamed pairs (where computed)     39 questions, 71% right
 *   Mixed set: old 51 at 31%; unnamed pairs 13 at 87% (named: too few to say).
 * At most SUGGESTION_CAP (thresholds.js) are kept.
 *
 * Embedding norm (SFace output length BEFORE L2 normalisation, quality2):
 *   dropNorm  7.0  faces below are dropped at detection (69% of the false
 *                  detections left at score 0.80 / 40 px, 0.18% of real faces)
 *   startNorm 9.0  faces below may join a person but never start one (hard
 *                  faces under 9 matched their own person 1-8% of the time)
 * "Might also be <person>" (person centroid vs person centroid), both tiers
 * need a margin >= mightMargin over the candidate's next-best named person:
 *   likely >= mightLikely (0.56: 99% precise), maybe >= mightMaybe (0.52;
 *   [0.48, 0.52) was 34% precise and is no longer listed).
 *
 * sameFile: "is this re-checked face the old one?" between two vectors of
 * one file (hidden faces stay hidden, names carry over). SFace: the
 * within-file grouping threshold 0.45 (analyze.js GROUP_THRESHOLD, which
 * keeps grouping on SFace vectors for every model).
 */
const SFACE_PEOPLE = Object.freeze({
  people: 0.5, suggest: 0.54, suggestMargin: 0.04, dropNorm: 7.0, startNorm: 9.0,
  mightLikely: 0.56, mightMargin: 0.05, mightMaybe: 0.52,
});
/*
 * Keeper thresholds (FACE_MODELS_SPEC). Every number is the SFace number
 * above mapped to the keeper cosine with the SAME false-accept rate on LFW
 * Protocol B (same pairs as above, model-bench out/fpr-map.json; a SFace
 * value between two measured points is interpolated linearly in the SFace
 * threshold). dropNorm / startNorm stay SFace's: the SFace norm remains the
 * quality signal (keeper norms separate false detections worse: AUC 0.92 /
 * 0.53 vs SFace 0.998 on clean faces, model-bench quality.out).
 *
 *   SFace   LFW FAR     IR-50   IR-101   used for
 *   0.50    1.54e-5     0.341   0.330    close
 *   0.42    1.69e-4     0.272   0.247    normal
 *   0.36    1.54e-3     0.211   0.186    wide
 *   0.45    6.31e-5     0.302   0.279    sameFile
 *   0.52    6.47e-6     0.365   0.353    mightMaybe
 *   0.54    (interp.)   0.381   0.371    suggest (0.52 -> 0.55, at 2/3)
 *   0.56    1.56e-6     0.402   0.394    mightLikely
 *   margins: suggestMargin T(0.54)-T(0.50) = 0.040 / 0.041 -> 0.04
 *            mightMargin   T(0.56)-T(0.51) = 0.049 / 0.053 -> 0.05
 *   people   0.35 for both (owner decision, FACE_MODELS_SPEC): the same FAR
 *            as SFace ~0.507 (IR-50) / ~0.517 (IR-101), a hair stricter than
 *            eq0.50 (0.341 / 0.330). Bench (hybrid-sim.out, H1 = SFace
 *            grouping + keeper): hard set named recall 43% (SFace) -> 82%
 *            (IR-50) / 84% (IR-101).
 */
const KEEPER_TABLES = Object.freeze({
  ir50: Object.freeze({ close: 0.341, normal: 0.272, wide: 0.211, sameFile: 0.302,
    people: 0.35, suggest: 0.381, suggestMargin: 0.04, dropNorm: 7.0, startNorm: 9.0,
    mightLikely: 0.402, mightMargin: 0.05, mightMaybe: 0.365 }),
  ir101: Object.freeze({ close: 0.33, normal: 0.247, wide: 0.186, sameFile: 0.279,
    people: 0.35, suggest: 0.371, suggestMargin: 0.04, dropNorm: 7.0, startNorm: 9.0,
    mightLikely: 0.394, mightMargin: 0.05, mightMaybe: 0.353 }),
});
const MATCH_THRESHOLDS = {
  'sface-2021dec': { close: 0.5, normal: 0.42, wide: 0.36, sameFile: 0.45, ...SFACE_PEOPLE },
  'stub-v1': { close: 0.5, normal: 0.42, wide: 0.36, sameFile: 0.45, ...SFACE_PEOPLE },
  'adaface-ir50-webface4m': KEEPER_TABLES.ir50,
  'adaface-ir101-webface12m': KEEPER_TABLES.ir101,
  'stub-ir50': KEEPER_TABLES.ir50,
  'stub-ir101': KEEPER_TABLES.ir101,
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
 * @param {{dir?: string, keys?: string[]}} [opts]  keys: default the grunt models
 * @returns {{dir, paths: {[key]: string}, present: string[], missing: string[], ok: boolean}}
 */
function resolveFaceModelPaths({ dir, keys = FACE_MODEL_KEYS } = {}) {
  const base = dir || faceModelDir();
  const paths = {}, present = [], missing = [];
  for (const key of keys) {
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
 * keys: which entries (default: the grunt models and every keeper; the
 * service downloads the grunt models plus ONE keeper at a time).
 * download.js checks exactly what verifyFaceModel() checks (byte size + sha256)
 * and readiness uses the same exact-size test as resolveFaceModelPaths().
 */
function downloadEntries({ dir, keys = [...FACE_MODEL_KEYS, ...KEEPER_KEYS] } = {}) {
  const base = dir || faceModelDir();
  return keys.map((key) => ({
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
  KEEPERS, KEEPER_NAMES, KEEPER_KEYS, DEFAULT_KEEPER, SFACE_MODEL_ID, STUB_KEEPER_IDS, SWITCHABLE, IR50_URL, IR101_URL,
  embedDim, keeperNameOf,
  faceModelDir, resolveFaceModelPaths, verifyFaceModel, downloadEntries,
};
