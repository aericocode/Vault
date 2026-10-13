/**
 * Turn a file (or a single frame) into "people in this file".
 *
 * analyzeFrame  one frame -> every usable face with embedding + JPEG crop
 *               (search-by-example, "find people in this frame")
 * analyzeFile   image/gif: each face is its own group
 *               video: faces from all sampled frames are grouped greedily into
 *               people (centroid cosine >= GROUP_THRESHOLD, never two faces of
 *               the same frame in one group), then near-duplicate groups that
 *               never share a frame are merged. Each group keeps its best face
 *               (with a crop) and up to 3 diverse exemplar embeddings.
 *
 * Frames are read through engine.frames (real ffmpeg for the onnx engine, the
 * filename-driven fake for the stub), so this module never spawns anything
 * itself.
 */

const { encodeJpeg } = require('./jpeg');

// Faces below these are dropped before embedding: tiny or uncertain faces
// make embeddings that match everybody. Measured: see the faces-test README.
const MIN_SCORE = 0.75;
const MIN_FACE_PX = 40;          // shorter bbox side, in frame pixels (frames are <= 1280 px)
// Same-person threshold for grouping faces WITHIN one file. Stricter than the
// library-wide "Normal" (0.42) because a wrong merge hides a person for good,
// while a missed merge only shows the same person twice. On LFW through this
// pipeline 0.45 accepts 97.6% of same-person pairs and 0.006% of different
// ones; in the test videos the closest two different people (relatives) were
// 0.36 apart and one person across portraits/group shots 0.59+.
const GROUP_THRESHOLD = 0.45;
const EXEMPLAR_MAX = 3;
const EXEMPLAR_DIVERSITY = 0.8;  // a new exemplar must be below this cosine to every kept one
// A face seen in only one sampled frame of a longer video is usually a false
// detection, a passer-by or motion blur; keep it only if it is clear.
const SINGLETON_MIN_FRAMES = 8;  // policy applies when at least this many frames were checked
const SINGLETON_KEEP_SCORE = 0.9;
const SINGLETON_KEEP_PX = 80;

function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na > 0 && nb > 0 ? d / Math.sqrt(na * nb) : 0;
}

function facePx(frame, bbox) {
  return Math.min(bbox[2] * frame.width, bbox[3] * frame.height);
}

/** Ranking used for "best face" and exemplar order: confident and large first. */
function quality(detScore, px) {
  return detScore * Math.sqrt(Math.min(1, px / 112));
}

/**
 * Square crop with margin around the face, resampled to size x size, as JPEG.
 * The square is shifted to stay inside the frame where it can.
 */
async function cropJpeg(frame, bbox, size = 128) {
  const { width: W, height: H, data } = frame;
  const cx = (bbox[0] + bbox[2] / 2) * W, cy = (bbox[1] + bbox[3] / 2) * H;
  let side = Math.max(bbox[2] * W, bbox[3] * H) * 1.5;
  side = Math.max(4, Math.min(side, Math.max(W, H)));
  let x0 = cx - side / 2, y0 = cy - side / 2;
  if (side <= W) x0 = Math.min(Math.max(0, x0), W - side);
  if (side <= H) y0 = Math.min(Math.max(0, y0), H - side);
  const out = new Uint8Array(size * size * 3);
  const step = side / size;
  const k = Math.max(1, Math.min(4, Math.ceil(step)));   // supersample to avoid aliasing on big faces
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let j = 0; j < k; j++) {
        const y = Math.floor(y0 + (v + (j + 0.5) / k) * step);
        if (y < 0 || y >= H) { n++; continue; }
        for (let i = 0; i < k; i++) {
          const x = Math.floor(x0 + (u + (i + 0.5) / k) * step);
          n++;
          if (x < 0 || x >= W) continue;
          const p = (y * W + x) * 3;
          r += data[p]; g += data[p + 1]; b += data[p + 2];
        }
      }
      const o = (v * size + u) * 3;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
    }
  }
  return encodeJpeg({ width: size, height: size, data: out }, 85);
}

async function _facesIn(engine, frame, opts) {
  const minScore = opts.minScore ?? MIN_SCORE;
  const minFacePx = opts.minFacePx ?? MIN_FACE_PX;
  const faces = await engine.detect(frame, { minScore, minFacePx });
  const res = [];
  for (const f of faces) {
    res.push({ face: f, embedding: await engine.embed(frame, f), px: facePx(frame, f.bbox) });
  }
  return res;
}

/**
 * Every usable face in one frame, best first.
 * @returns [{ embedding, bbox, landmarks, detScore, crop }]
 */
async function analyzeFrame(engine, frame, opts = {}) {
  const found = await _facesIn(engine, frame, opts);
  found.sort((a, b) => quality(b.face.score, b.px) - quality(a.face.score, a.px));
  const out = [];
  for (const { face, embedding } of found) {
    out.push({
      embedding, bbox: face.bbox, landmarks: face.landmarks, detScore: face.score,
      crop: await cropJpeg(frame, face.bbox, opts.cropSize || 128),
    });
  }
  return out;
}

// --- grouping ----------------------------------------------------------------

class Group {
  constructor(id) {
    this.id = id;
    this.sum = new Float64Array(128);
    this.centroid = new Float32Array(128);
    this.members = [];
    this.frames = new Set();
    this.best = null;
    this.firstTimeS = Infinity;
  }
  add(m, frameIdx) {
    this.members.push(m);
    this.frames.add(frameIdx);
    for (let i = 0; i < m.embedding.length; i++) this.sum[i] += m.embedding[i];
    this._renorm();
    if (m.frameTimeS !== null && m.frameTimeS < this.firstTimeS) this.firstTimeS = m.frameTimeS;
  }
  absorb(other) {
    for (const m of other.members) this.members.push(m);
    for (const f of other.frames) this.frames.add(f);
    for (let i = 0; i < 128; i++) this.sum[i] += other.sum[i];
    this._renorm();
    this.firstTimeS = Math.min(this.firstTimeS, other.firstTimeS);
    if (!this.best || (other.best && other.best.q > this.best.q)) this.best = other.best;
  }
  _renorm() {
    let s = 0;
    for (let i = 0; i < 128; i++) s += this.sum[i] * this.sum[i];
    const k = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let i = 0; i < 128; i++) this.centroid[i] = this.sum[i] * k;
  }
}

/**
 * Assign one frame's faces to groups. Pairs are taken best-similarity first and
 * each group takes at most one face per frame (two faces in one frame are two
 * people). Returns the group each face landed in.
 */
function assignFaces(groups, faces, frameIdx, threshold, nextId) {
  const pairs = [];
  faces.forEach((f, fi) => groups.forEach((g, gi) => {
    const c = cosine(f.embedding, g.centroid);
    if (c >= threshold) pairs.push([c, fi, gi]);
  }));
  pairs.sort((a, b) => b[0] - a[0]);
  const faceTo = new Array(faces.length).fill(null);
  const taken = new Set();
  for (const [, fi, gi] of pairs) {
    if (faceTo[fi] !== null || taken.has(gi)) continue;
    faceTo[fi] = groups[gi];
    taken.add(gi);
  }
  faces.forEach((f, fi) => {
    if (!faceTo[fi]) { faceTo[fi] = new Group(nextId()); groups.push(faceTo[fi]); }
    faceTo[fi].add(f, frameIdx);
  });
  return faceTo;
}

/** Merge groups that look like one person and never appear in the same frame. */
function mergeGroups(groups, threshold) {
  let merged = true;
  while (merged) {
    merged = false;
    let bestPair = null, bestC = threshold;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const c = cosine(groups[i].centroid, groups[j].centroid);
        if (c < bestC) continue;
        let overlap = false;
        const [a, b] = groups[i].frames.size < groups[j].frames.size ? [groups[i], groups[j]] : [groups[j], groups[i]];
        for (const f of a.frames) if (b.frames.has(f)) { overlap = true; break; }
        if (!overlap) { bestC = c; bestPair = [i, j]; }
      }
    }
    if (bestPair) {
      const [i, j] = bestPair;
      groups[i].absorb(groups[j]);
      groups.splice(j, 1);
      merged = true;
    }
  }
  return groups;
}

function pickExemplars(members) {
  const sorted = [...members].sort((a, b) => b.q - a.q);
  const out = [];
  for (const m of sorted) {
    if (out.length >= EXEMPLAR_MAX) break;
    if (out.every((e) => cosine(e.embedding, m.embedding) < EXEMPLAR_DIVERSITY)) out.push(m);
  }
  return out.map((m) => ({ embedding: m.embedding, bbox: m.bbox, frameTimeS: m.frameTimeS, detScore: m.detScore }));
}

function _finishGroup(g) {
  return {
    appearances: g.frames.size,
    firstTimeS: Number.isFinite(g.firstTimeS) ? g.firstTimeS : null,
    best: { bbox: g.best.bbox, frameTimeS: g.best.frameTimeS, detScore: g.best.detScore, crop: g.best.crop },
    exemplars: pickExemplars(g.members),
  };
}

/**
 * @param engine  from createEngine()
 * @param file    { filepath, kind: 'image'|'gif'|'video', durationS? }
 * @param opts    { intervalS=3.5, maxFrames=2000, signal, onProgress, minScore, minFacePx,
 *                  (onProgress gets { framesChecked, totalFrames, fraction 0..1 or null,
 *                   timeS, facesSeen, groups })
 *                  groupThreshold, maxSide, keepSingletons, decodeThreads }
 * @returns { framesChecked, facesSeen, groups:[{ appearances, firstTimeS, best:{bbox,frameTimeS,detScore,crop},
 *            exemplars:[{embedding,bbox,frameTimeS,detScore}] }] }   groups sorted by appearances desc
 */
async function analyzeFile(engine, { filepath, kind, durationS }, opts = {}) {
  await engine.load();
  const frames = engine.frames;
  const { signal, onProgress } = opts;

  if (kind === 'image' || kind === 'gif') {
    const frame = await frames.decodeImage(filepath, { maxSide: opts.maxSide });
    const faces = await analyzeFrame(engine, frame, opts);
    onProgress?.({ framesChecked: 1, totalFrames: 1, fraction: 1, timeS: null, facesSeen: faces.length, groups: faces.length });
    return {
      framesChecked: 1,
      facesSeen: faces.length,
      groups: faces.map((f) => ({
        appearances: 1,
        firstTimeS: null,
        best: { bbox: f.bbox, frameTimeS: null, detScore: f.detScore, crop: f.crop },
        exemplars: [{ embedding: f.embedding, bbox: f.bbox, frameTimeS: null, detScore: f.detScore }],
      })),
    };
  }
  if (kind !== 'video') throw new Error(`analyzeFile: unsupported kind ${kind}`);

  const threshold = opts.groupThreshold ?? GROUP_THRESHOLD;
  const groups = [];
  let gid = 0;
  const nextId = () => gid++;
  let framesChecked = 0, facesSeen = 0;

  const intervalS = opts.intervalS ?? 3.5, maxFrames = opts.maxFrames ?? 2000;
  // Expected frame count (same spacing rule as sampleVideo) for progress.
  const expectedFrames = (dur) => {
    if (!(dur > 0)) return null;
    const step = Math.max(intervalS, dur / maxFrames);
    return Math.max(1, Math.min(maxFrames, Math.ceil(dur / step)));
  };
  const it = frames.sampleVideo(filepath, {
    intervalS, maxFrames,
    maxSide: opts.maxSide, durationS, signal, threads: opts.decodeThreads,
  });
  for await (const { timeS, frame, durationS: sampledDur } of it) {
    const found = await _facesIn(engine, frame, opts);
    const members = found.map(({ face, embedding, px }) => ({
      embedding, bbox: face.bbox, frameTimeS: timeS, detScore: face.score, q: quality(face.score, px), px,
    }));
    const landed = assignFaces(groups, members, framesChecked, threshold, nextId);
    for (let i = 0; i < members.length; i++) {
      const g = landed[i], m = members[i];
      if (!g.best || m.q > g.best.q) {
        g.best = { ...m, crop: await cropJpeg(frame, m.bbox, opts.cropSize || 128) };
      }
    }
    framesChecked++;
    facesSeen += members.length;
    const totalFrames = expectedFrames(sampledDur || durationS);
    onProgress?.({
      framesChecked, totalFrames, timeS, facesSeen, groups: groups.length,
      fraction: totalFrames ? Math.min(0.99, framesChecked / totalFrames) : null,   // 1 only when done
    });
    if (signal?.aborted) break;   // sampleVideo throws on its next step anyway
  }
  if (signal?.aborted) {
    const e = new Error('aborted'); e.name = 'AbortError'; e.code = 'ABORT_ERR'; throw e;
  }

  mergeGroups(groups, threshold);

  const keepSingletons = opts.keepSingletons ?? false;
  const kept = groups.filter((g) => {
    if (keepSingletons || g.frames.size > 1 || framesChecked < SINGLETON_MIN_FRAMES) return true;
    return g.best.detScore >= SINGLETON_KEEP_SCORE && g.best.px >= SINGLETON_KEEP_PX;
  });
  kept.sort((a, b) => b.frames.size - a.frames.size || a.firstTimeS - b.firstTimeS);
  return { framesChecked, facesSeen, groups: kept.map(_finishGroup) };
}

module.exports = {
  analyzeFrame, analyzeFile, cropJpeg, cosine,
  // tuning constants and internals, exposed for tests and the calibration harness
  GROUP_THRESHOLD, MIN_SCORE, MIN_FACE_PX, assignFaces, mergeGroups, pickExemplars, Group,
};
