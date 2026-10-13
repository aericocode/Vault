/**
 * Everything the ONNX face backend computes, inside ONE self-contained
 * function so it can run either in-process or inside a worker thread.
 *
 * Why a factory instead of plain module code: onnxruntime-node's
 * InferenceSession.run() blocks the calling thread for the whole inference
 * (measured: a 1 ms timer fires once per run, not during it). Run on the
 * server's main thread, face indexing would stall every HTTP request for
 * 10-50 ms per frame, and two "concurrent" engines would not overlap at all.
 * engine.js therefore runs this core in a worker_thread. The worker is started
 * from SOURCE TEXT (buildCore.toString()), not a file path, so it works in the
 * single-file SEA bundle too; that is also why nothing in here may reference
 * anything outside the function (minification renames consistently only
 * within one function body). onnxruntime-node is passed in.
 *
 * Point order, pixel conventions and the 112 template: see align.js.
 */

function buildCore(ort) {
  const DET_SIZE = 640;                 // YuNet 2023mar ONNX has a fixed 1x3x640x640 input
  const STRIDES = [8, 16, 32];
  const NMS_IOU = 0.3;                  // OpenCV FaceDetectorYN default
  const TOP_K = 500;

  const TEMPLATE_112 = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
  ];

  /**
   * Least-squares similarity transform (rotation + uniform scale + translation,
   * no reflection) mapping src points onto dst points. For 2D this closed form
   * equals the Umeyama estimate OpenCV uses.
   * @returns {[number,number,number,number]} [a, b, tx, ty] with
   *   x' = a*x - b*y + tx,  y' = b*x + a*y + ty
   */
  function similarityTransform(src, dst) {
    const n = src.length;
    let sx = 0, sy = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
    sx /= n; sy /= n; dx /= n; dy /= n;
    let num1 = 0, num2 = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const px = src[i][0] - sx, py = src[i][1] - sy;
      const qx = dst[i][0] - dx, qy = dst[i][1] - dy;
      num1 += px * qx + py * qy;
      num2 += px * qy - py * qx;
      den += px * px + py * py;
    }
    if (den < 1e-9) return [1, 0, dx - sx, dy - sy];
    const a = num1 / den, b = num2 / den;
    return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
  }

  function applyTransform([a, b, tx, ty], [x, y]) {
    return [a * x - b * y + tx, b * x + a * y + ty];
  }

  /**
   * Warp a packed-RGB frame with the forward similarity transform M into an
   * out x out RGB image (bilinear, black border) — cv::warpAffine equivalent.
   */
  function warpSimilarity(frame, M, out = 112) {
    const { width: W, height: Hh, data } = frame;
    const [a, b, tx, ty] = M;
    const det = a * a + b * b;
    // inverse of [[a,-b],[b,a]] is [[a,b],[-b,a]]/det
    const ia = a / det, ib = b / det;
    const res = new Uint8Array(out * out * 3);
    for (let v = 0; v < out; v++) {
      for (let u = 0; u < out; u++) {
        const ux = u - tx, vy = v - ty;
        const x = ia * ux + ib * vy;
        const y = -ib * ux + ia * vy;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const fx = x - x0, fy = y - y0;
        const o = (v * out + u) * 3;
        for (let c = 0; c < 3; c++) {
          let acc = 0;
          for (let j = 0; j < 2; j++) {
            const yy = y0 + j;
            if (yy < 0 || yy >= Hh) continue;
            const wy = j ? fy : 1 - fy;
            for (let i = 0; i < 2; i++) {
              const xx = x0 + i;
              if (xx < 0 || xx >= W) continue;
              acc += data[(yy * W + xx) * 3 + c] * wy * (i ? fx : 1 - fx);
            }
          }
          res[o + c] = Math.round(acc);
        }
      }
    }
    return { width: out, height: out, data: res };
  }

  /** Align a face given its 5 landmarks in PIXEL coordinates of `frame`. */
  function alignFace(frame, landmarksPx) {
    const M = similarityTransform(landmarksPx, TEMPLATE_112);
    return warpSimilarity(frame, M, 112);
  }

  /**
   * Resize (bilinear, half-pixel centres like cv::resize) so the longer side is
   * `size`, pad bottom/right with zeros, and lay out as BGR float CHW 0..255
   * (what YuNet expects: cv::dnn::blobFromImage with no scaling or swapRB).
   */
  function letterboxBGR(frame, size, out) {
    const { width: W, height: H, data } = frame;
    const scale = size / Math.max(W, H);
    const nw = Math.min(size, Math.round(W * scale)), nh = Math.min(size, Math.round(H * scale));
    const plane = size * size;
    const t = out && out.length === 3 * plane ? out.fill(0) : new Float32Array(3 * plane);
    const sx = W / nw, sy = H / nh;
    for (let y = 0; y < nh; y++) {
      let fy = (y + 0.5) * sy - 0.5;
      if (fy < 0) fy = 0;
      const y0 = Math.min(H - 1, Math.floor(fy)), y1 = Math.min(H - 1, y0 + 1), wy = fy - y0;
      for (let x = 0; x < nw; x++) {
        let fx = (x + 0.5) * sx - 0.5;
        if (fx < 0) fx = 0;
        const x0 = Math.min(W - 1, Math.floor(fx)), x1 = Math.min(W - 1, x0 + 1), wx = fx - x0;
        const p00 = (y0 * W + x0) * 3, p01 = (y0 * W + x1) * 3, p10 = (y1 * W + x0) * 3, p11 = (y1 * W + x1) * 3;
        const o = y * size + x;
        for (let c = 0; c < 3; c++) {
          const v = (data[p00 + c] * (1 - wx) + data[p01 + c] * wx) * (1 - wy) +
                    (data[p10 + c] * (1 - wx) + data[p11 + c] * wx) * wy;
          t[(2 - c) * plane + o] = v;          // RGB -> BGR planes
        }
      }
    }
    return { tensorData: t, scaleX: nw / W, scaleY: nh / H };
  }

  /** Prior-free YuNet 2023mar decoding (port of OpenCV FaceDetectorYNImpl::postProcess). */
  function decodeYuNet(out, size, scoreThreshold) {
    const faces = [];
    for (const s of STRIDES) {
      const cls = out[`cls_${s}`].data, obj = out[`obj_${s}`].data;
      const bbox = out[`bbox_${s}`].data, kps = out[`kps_${s}`].data;
      const cols = size / s, rows = size / s;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          const cs = Math.min(1, Math.max(0, cls[idx]));
          const os = Math.min(1, Math.max(0, obj[idx]));
          const score = Math.sqrt(cs * os);
          if (score < scoreThreshold) continue;
          const cx = (c + bbox[idx * 4]) * s, cy = (r + bbox[idx * 4 + 1]) * s;
          const w = Math.exp(bbox[idx * 4 + 2]) * s, h = Math.exp(bbox[idx * 4 + 3]) * s;
          const lm = [];
          for (let n = 0; n < 5; n++) lm.push([(kps[idx * 10 + 2 * n] + c) * s, (kps[idx * 10 + 2 * n + 1] + r) * s]);
          faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score, lm });
        }
      }
    }
    return faces;
  }

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const u = a.w * a.h + b.w * b.h - inter;
    return u > 0 ? inter / u : 0;
  }

  function nms(faces, thr, topK) {
    faces.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const f of faces) {
      if (keep.every((k) => iou(k, f) <= thr)) keep.push(f);
      if (keep.length >= topK) break;
    }
    return keep;
  }

  /** Map detector-space boxes back to the frame and normalize to 0..1. */
  function toFrameSpace(faces, frame, scaleX, scaleY, minFacePx) {
    const W = frame.width, H = frame.height;
    // inverse of the half-pixel-centre resize
    const backX = (v) => (v + 0.5) / scaleX - 0.5, backY = (v) => (v + 0.5) / scaleY - 0.5;
    const res = [];
    for (const f of faces) {
      let x1 = f.x / scaleX, y1 = f.y / scaleY, x2 = (f.x + f.w) / scaleX, y2 = (f.y + f.h) / scaleY;
      x1 = Math.max(0, x1); y1 = Math.max(0, y1); x2 = Math.min(W, x2); y2 = Math.min(H, y2);
      const w = x2 - x1, h = y2 - y1;
      if (w <= 1 || h <= 1 || Math.min(w, h) < minFacePx) continue;
      res.push({
        bbox: [x1 / W, y1 / H, w / W, h / H],
        score: f.score,
        landmarks: f.lm.map(([x, y]) => [backX(x) / W, backY(y) / H]),
      });
    }
    return res;
  }

  /** 112x112 aligned RGB -> float CHW in RGB order, raw 0..255 (FaceRecognizerSF::feature). */
  function alignedToTensor(img) {
    const n = 112 * 112;
    const t = new Float32Array(3 * n);
    const d = img.data;
    for (let i = 0; i < n; i++) {
      t[i] = d[i * 3]; t[n + i] = d[i * 3 + 1]; t[2 * n + i] = d[i * 3 + 2];
    }
    return t;
  }

  function l2normalize(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    const k = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let i = 0; i < v.length; i++) v[i] *= k;
    return v;
  }

  class OnnxCore {
    async load(paths, threads) {
      if (!ort) throw new Error('onnxruntime-node not available');
      const opts = {
        executionProviders: ['cpu'],
        intraOpNumThreads: Math.max(1, threads | 0),
        interOpNumThreads: 1,
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
        logSeverityLevel: 3,            // YuNet's graph triggers harmless initializer warnings
      };
      this.det = await ort.InferenceSession.create(paths['face:detect'], opts);
      this.rec = await ort.InferenceSession.create(paths['face:embed'], opts);
    }

    async detect(frame, minScore, minFacePx) {
      // one reused input buffer: a fresh 4.9 MB array per frame only feeds the GC
      if (!this.detBuf) this.detBuf = new Float32Array(3 * DET_SIZE * DET_SIZE);
      const { tensorData, scaleX, scaleY } = letterboxBGR(frame, DET_SIZE, this.detBuf);
      const out = await this.det.run({ input: new ort.Tensor('float32', tensorData, [1, 3, DET_SIZE, DET_SIZE]) });
      const kept = nms(decodeYuNet(out, DET_SIZE, minScore), NMS_IOU, TOP_K);
      return toFrameSpace(kept, frame, scaleX, scaleY, minFacePx);
    }

    async embed(frame, landmarks) {
      const lm = landmarks.map(([x, y]) => [x * frame.width, y * frame.height]);
      const input = alignedToTensor(alignFace(frame, lm));
      const out = await this.rec.run({ data: new ort.Tensor('float32', input, [1, 3, 112, 112]) });
      return l2normalize(Float32Array.from(out.fc1.data));
    }

    async close() {
      for (const s of [this.det, this.rec]) { if (s && s.release) await s.release(); }
      this.det = this.rec = null;
    }
  }

  return {
    OnnxCore, TEMPLATE_112, similarityTransform, applyTransform, warpSimilarity, alignFace,
    letterboxBGR, decodeYuNet, nms, iou, toFrameSpace, alignedToTensor, l2normalize,
  };
}

module.exports = { buildCore, pure: buildCore(null) };
