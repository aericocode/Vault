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
 *
 * Grunt + keeper (FACE_MODELS_SPEC "H1"): SFace (engine.embedWithNorm) runs on
 * every face: the norm filter, within-file grouping, merging and exemplar
 * choice all use it, unchanged. When the engine has a keeper (engine.modelId
 * is in engine.keeperIds), the vectors returned for storage are the keeper's:
 *   photos / single frames  every kept face is embedded by the keeper
 *   videos                  each face's aligned crop stays in the engine
 *                           worker; only the <= 3 exemplars per group get the
 *                           keeper at the end of the file (embedCrops). At
 *                           most CROPS_PER_GROUP crops per group are kept (the
 *                           best by quality: exemplars come from the top of
 *                           that order), the rest are freed as the file plays.
 * Without a keeper the SFace vectors are returned, as before.
 */

const { encodeJpeg } = require('./jpeg');
const { peopleThresholds } = require('./thresholds');

// Faces below these are dropped before embedding: tiny or uncertain faces
// make embeddings that match everybody. Measured: see the faces-test README
// (0.80: quality experiment 2). After embedding, a face whose SFace norm is
// below the model's dropNorm (models.js) is dropped too: mostly not a face.
const MIN_SCORE = 0.80;
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
// Keeper mode: aligned crops kept per group while a video is read (each is
// 112x112x3 = 37 KB in the worker). The top-K by quality of a merged group is
// inside the union of its parts' top-K, so merging never needs a freed crop.
const CROPS_PER_GROUP = 16;

/** Does this engine store keeper vectors (embedKeeper / embedCrops)? */
function keeperOf(engine) {
  return typeof engine.embedKeeper === 'function' && Array.isArray(engine.keeperIds)
    && engine.keeperIds.includes(engine.modelId) ? engine.modelId : null;
}

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

async function _facesIn(engine, frame, opts, { keepCrop = false } = {}) {
  const minScore = opts.minScore ?? MIN_SCORE;
  const minFacePx = opts.minFacePx ?? MIN_FACE_PX;
  const minNorm = opts.minNorm ?? peopleThresholds(engine.modelId).dropNorm;
  const faces = await engine.detect(frame, { minScore, minFacePx });
  const res = [];
  const drop = [];
  for (const f of faces) {
    // Engines without embedWithNorm (older fakes) report no norm: kept.
    let embedding, norm = null, cropId = null;
    if (typeof engine.embedWithNorm === 'function') {
      ({ embedding, norm, cropId = null } = await engine.embedWithNorm(frame, f, keepCrop ? { keepCrop: true } : undefined));
    } else embedding = await engine.embed(frame, f);
    if (Number.isFinite(norm) && norm < minNorm) { if (cropId != null) drop.push(cropId); continue; }
    res.push({ face: f, embedding, norm: Number.isFinite(norm) ? norm : null, px: facePx(frame, f.bbox), cropId });
  }
  if (drop.length) await engine.freeCrops(drop);
  return res;
}

/**
 * Every usable face in one frame, best first.
 * embedding is the keeper's vector when the engine has a keeper, else SFace's.
 * opts.models: also embed in these model ids (engine.keeperIds, or the SFace
 * id engine.gruntId): result.embeddings[modelId] (a search during a model
 * switch needs the query face in both spaces). embeddings always holds
 * engine.modelId too.
 * @returns [{ embedding, embeddings, norm, bbox, landmarks, detScore, crop }]   norm: SFace, before L2, null if unknown
 */
async function analyzeFrame(engine, frame, opts = {}) {
  const found = await _facesIn(engine, frame, opts);
  found.sort((a, b) => quality(b.face.score, b.px) - quality(a.face.score, a.px));
  const keeper = keeperOf(engine);
  const extra = (opts.models || []).filter((m) => m !== engine.modelId);
  const out = [];
  for (const { face, embedding: grunt, norm } of found) {
    const embedding = keeper ? await engine.embedKeeper(frame, face, keeper) : grunt;
    const embeddings = { [engine.modelId]: embedding };
    for (const m of extra) {
      if (m === (engine.gruntId || 'sface-2021dec')) embeddings[m] = grunt;
      else if (Array.isArray(engine.keeperIds) && engine.keeperIds.includes(m)) embeddings[m] = await engine.embedKeeper(frame, face, m);
    }
    out.push({
      embedding, embeddings, norm, bbox: face.bbox, landmarks: face.landmarks, detScore: face.score,
      crop: await cropJpeg(frame, face.bbox, opts.cropSize || 128),
    });
  }
  return out;
}

// --- grouping ----------------------------------------------------------------

class Group {
  constructor(id) {
    this.id = id;
    this.sum = null;          // sized by the first face (SFace: 128)
    this.centroid = null;
    this.members = [];
    this.frames = new Set();
    this.best = null;
    this.firstTimeS = Infinity;
  }
  _size(n) {
    if (!this.sum) { this.sum = new Float64Array(n); this.centroid = new Float32Array(n); }
  }
  add(m, frameIdx) {
    this._size(m.embedding.length);
    this.members.push(m);
    this.frames.add(frameIdx);
    for (let i = 0; i < m.embedding.length; i++) this.sum[i] += m.embedding[i];
    this._renorm();
    if (m.frameTimeS !== null && m.frameTimeS < this.firstTimeS) this.firstTimeS = m.frameTimeS;
  }
  absorb(other) {
    for (const m of other.members) this.members.push(m);
    for (const f of other.frames) this.frames.add(f);
    if (other.sum) {
      this._size(other.sum.length);
      for (let i = 0; i < this.sum.length; i++) this.sum[i] += other.sum[i];
    }
    this._renorm();
    this.firstTimeS = Math.min(this.firstTimeS, other.firstTimeS);
    if (!this.best || (other.best && other.best.q > this.best.q)) this.best = other.best;
  }
  _renorm() {
    let s = 0;
    for (let i = 0; i < this.sum.length; i++) s += this.sum[i] * this.sum[i];
    const k = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let i = 0; i < this.sum.length; i++) this.centroid[i] = this.sum[i] * k;
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
    if (!g.centroid) return;
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

/**
 * Up to EXEMPLAR_MAX diverse members, best quality first (diversity on the
 * SFace vectors). withCrop: only members whose crop is still kept (keeper mode).
 */
function pickExemplars(members, { withCrop = false } = {}) {
  const sorted = [...members].filter((m) => !withCrop || m.cropId != null).sort((a, b) => b.q - a.q);
  const out = [];
  for (const m of sorted) {
    if (out.length >= EXEMPLAR_MAX) break;
    if (out.every((e) => cosine(e.embedding, m.embedding) < EXEMPLAR_DIVERSITY)) out.push(m);
  }
  return out.map((m) => ({ embedding: m.embedding, norm: m.norm ?? null, bbox: m.bbox, frameTimeS: m.frameTimeS, detScore: m.detScore,
    ...(withCrop ? { cropId: m.cropId } : {}) }));
}

function _finishGroup(g, withCrop = false) {
  return {
    appearances: g.frames.size,
    firstTimeS: Number.isFinite(g.firstTimeS) ? g.firstTimeS : null,
    best: { bbox: g.best.bbox, frameTimeS: g.best.frameTimeS, detScore: g.best.detScore, crop: g.best.crop },
    exemplars: pickExemplars(g.members, { withCrop }),
  };
}

/** Keeper mode: keep the CROPS_PER_GROUP best crops of a group, return the rest's ids. */
function _trimCrops(g) {
  const held = g.members.filter((m) => m.cropId != null);
  if (held.length <= CROPS_PER_GROUP) return [];
  held.sort((a, b) => b.q - a.q);
  const out = [];
  for (const m of held.slice(CROPS_PER_GROUP)) { out.push(m.cropId); m.cropId = null; }
  return out;
}

/**
 * @param engine  from createEngine()
 * @param file    { filepath, kind: 'image'|'gif'|'video', durationS? }
 * @param opts    { intervalS=3.5, maxFrames=2000, signal, onProgress, minScore, minFacePx,
 *                  (onProgress gets { framesChecked, totalFrames, fraction 0..1 or null,
 *                   timeS, facesSeen, groups })
 *                  groupThreshold, maxSide, keepSingletons, decodeThreads }
 * @returns { framesChecked, facesSeen, groups:[{ appearances, firstTimeS, best:{bbox,frameTimeS,detScore,crop},
 *            exemplars:[{embedding,norm,bbox,frameTimeS,detScore}] }] }   groups sorted by appearances desc
 */
async function analyzeFile(engine, { filepath, kind, durationS }, opts = {}) {
  await engine.load();
  const frames = engine.frames;
  const { signal, onProgress } = opts;
  const keeper = keeperOf(engine);

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
        exemplars: [{ embedding: f.embedding, norm: f.norm, bbox: f.bbox, frameTimeS: null, detScore: f.detScore }],
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
  try {
    return await _analyzeVideo();
  } finally {
    // Keeper mode: nothing stays in the worker after a file (done, failed or aborted).
    if (keeper) await engine.freeCrops().catch(() => {});
  }

  async function _analyzeVideo() {
    const it = frames.sampleVideo(filepath, {
      intervalS, maxFrames,
      maxSide: opts.maxSide, durationS, signal, threads: opts.decodeThreads,
    });
    for await (const { timeS, frame, durationS: sampledDur } of it) {
      const found = await _facesIn(engine, frame, opts, { keepCrop: !!keeper });
      const members = found.map(({ face, embedding, norm, px, cropId }) => ({
        embedding, norm, bbox: face.bbox, frameTimeS: timeS, detScore: face.score, q: quality(face.score, px), px, cropId,
      }));
      const landed = assignFaces(groups, members, framesChecked, threshold, nextId);
      const free = [];
      for (let i = 0; i < members.length; i++) {
        const g = landed[i], m = members[i];
        if (!g.best || m.q > g.best.q) {
          g.best = { ...m, crop: await cropJpeg(frame, m.bbox, opts.cropSize || 128) };
        }
      }
      if (keeper) for (const g of new Set(landed)) free.push(..._trimCrops(g));
      if (free.length) await engine.freeCrops(free);
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
    const out = kept.map((g) => _finishGroup(g, !!keeper));
    if (!keeper) return { framesChecked, facesSeen, groups: out };
    // The keeper embeds only the exemplars (one round trip per file).
    const ids = out.flatMap((g) => g.exemplars.map((e) => e.cropId));
    const vecs = ids.length ? await engine.embedCrops(ids, keeper) : [];
    const byId = new Map(ids.map((id, i) => [id, vecs[i]]));
    const done = [];
    for (const g of out) {
      g.exemplars = g.exemplars.filter((e) => byId.get(e.cropId)).map(({ cropId, ...e }) => ({ ...e, embedding: byId.get(cropId) }));
      if (g.exemplars.length) done.push(g);
      else console.warn(`[Faces] a face group in ${filepath} lost its crops and was skipped`);
    }
    return { framesChecked, facesSeen, groups: done };
  }
}

module.exports = {
  analyzeFrame, analyzeFile, cropJpeg, cosine,
  // tuning constants and internals, exposed for tests and the calibration harness
  GROUP_THRESHOLD, MIN_SCORE, MIN_FACE_PX, CROPS_PER_GROUP, assignFaces, mergeGroups, pickExemplars, Group, keeperOf, quality, facePx,
};
