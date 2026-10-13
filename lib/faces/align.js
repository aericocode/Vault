/**
 * Five-point face alignment to the 112x112 template SFace was trained on
 * (same template and maths as OpenCV FaceRecognizerSF::alignCrop).
 *
 * Point order everywhere (YuNet output order, image-space left to right):
 *   0 right eye (the eye on the image's left), 1 left eye, 2 nose tip,
 *   3 right mouth corner, 4 left mouth corner.
 * Coordinates are pixel-index coordinates (OpenCV convention, no half-pixel
 * offset), which is what warpAffine assumes.
 *
 * similarityTransform(src, dst) -> [a, b, tx, ty]  with x' = a*x - b*y + tx,
 *   y' = b*x + a*y + ty: least-squares rotation + uniform scale + translation
 *   (no reflection); for 2D this closed form equals OpenCV's Umeyama estimate.
 * warpSimilarity(frame, M, out) -> out x out RGB, bilinear, black border.
 * alignFace(frame, landmarksPx) -> the 112x112 aligned face.
 *
 * The code lives in onnx-core.js so the worker thread runs the same functions.
 */
const { pure } = require('./onnx-core');

module.exports = {
  TEMPLATE_112: pure.TEMPLATE_112,
  similarityTransform: pure.similarityTransform,
  applyTransform: pure.applyTransform,
  warpSimilarity: pure.warpSimilarity,
  alignFace: pure.alignFace,
};
