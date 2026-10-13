/**
 * Face engine layer — one import for the rest of the app.
 *   const faces = require('./lib/faces');
 *   const engine = faces.createEngine({ backend: 'onnx' });
 * See engine.js (detect/embed), analyze.js (files -> people), frames.js
 * (ffmpeg frames), models.js (model registry), stub.js (test backend).
 */
const { createEngine } = require('./engine');
const { analyzeFrame, analyzeFile, cropJpeg, cosine } = require('./analyze');
const { decodeImage, grabFrame, sampleVideo } = require('./frames');
const { FACE_MODELS, resolveFaceModelPaths, faceModelDir, verifyFaceModel, matchThresholds } = require('./models');
const { stubFrame } = require('./stub');

module.exports = {
  createEngine, analyzeFrame, analyzeFile, cropJpeg, cosine,
  decodeImage, grabFrame, sampleVideo,
  FACE_MODELS, resolveFaceModelPaths, faceModelDir, verifyFaceModel, matchThresholds,
  stubFrame,
};
