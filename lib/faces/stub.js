/**
 * Stub face engine: no models, no ffmpeg, fully deterministic. For tests.
 *
 * HOW TESTS CONTROL IT
 *
 * 1. Frames carry their faces in their first bytes (stubFrame() builds them):
 *      data[0..1] = 0xFA 0xCE          magic
 *      data[2]    = n                  number of faces (0..20)
 *      data[3+2i] = person id (0..255) for face i
 *      data[4+2i] = variant  (0..255)  0 = the person's canonical look
 *    A frame without the magic has no faces.
 *    Face i sits in the i-th of n equal vertical strips, so boxes never overlap.
 *    Default frame is 320x240, so up to 6 faces stay above analyze's 40px floor.
 *
 * 2. Embeddings depend only on (person, variant):
 *      same person, same variant      cosine 1.0 (identical vector)
 *      same person, variant v vs 0    cosine ~0.89
 *      same person, two variants >0   cosine ~0.80
 *      different people               cosine ~0 (|cos| < ~0.3)
 *    So "same person in another pose" = same id, different variant.
 *
 * 3. Files never touch the disk: engine.frames decodes the FILENAME.
 *    Tokens in the basename (separated by anything non-alphanumeric):
 *      p<id>                 person <id> in every frame          e.g. party_p3_p7.jpg
 *      p<id>v<k>             ... with variant k                  e.g. p3v2
 *      p<id>@<a>-<b>         videos: only for a <= t < b seconds e.g. clip_p1@0-30_p2@40-60.mp4
 *      p<id>v<k>@<a>-<b>     both
 *      d<seconds>            video duration if not passed in opts (default 60)
 *    Videos sample on the same time grid as the real sampleVideo, so
 *    framesChecked = ceil(duration / interval) (bounded by maxFrames).
 *    A token "bad" makes decodeImage / sampleVideo throw (FRAME_DECODE_FAILED).
 *
 *    Use createEngine({ backend: 'stub', frames: 'ffmpeg' }) to read real files
 *    with ffmpeg instead (then only frames carrying the magic have faces).
 *
 * Detection score is 0.99 - 0.02 * min(variant, 9): variant 0 is the clearest
 * face (0.99), variant 9 sits at 0.81 (above analyze's 0.75 floor, below its
 * 0.9 "keep a one-off face" bar).
 *
 * engine.calls counts detect/embed calls so tests can assert work was done.
 */

const path = require('path');
const { TEMPLATE_112 } = require('./align');

const MAGIC0 = 0xfa, MAGIC1 = 0xce;
const DIM = 128;

/** Build a stub frame. faces: [{ person, variant? }] or plain person ids. */
function stubFrame(faces = [], { width = 320, height = 240 } = {}) {
  const list = faces.map((f) => (typeof f === 'number' ? { person: f, variant: 0 } : { variant: 0, ...f }));
  if (list.length > 20) throw new Error('stubFrame: at most 20 faces');
  const data = new Uint8Array(width * height * 3);
  data.fill(128);
  data[0] = MAGIC0; data[1] = MAGIC1; data[2] = list.length;
  list.forEach((f, i) => { data[3 + 2 * i] = f.person & 255; data[4 + 2 * i] = f.variant & 255; });
  return { width, height, data };
}

/** Read the faces encoded in a stub frame ([] when there is no magic). */
function readStubFaces(frame) {
  const d = frame?.data;
  if (!d || d.length < 3 || d[0] !== MAGIC0 || d[1] !== MAGIC1) return [];
  const n = Math.min(d[2], 20);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ person: d[3 + 2 * i], variant: d[4 + 2 * i] });
  return out;
}

// mulberry32 + Box-Muller: a small seeded Gaussian stream
function rng(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

function unitVector(seed) {
  const g = rng(seed);
  const v = new Float32Array(DIM);
  let s = 0;
  for (let i = 0; i < DIM; i++) { v[i] = g(); s += v[i] * v[i]; }
  const k = 1 / Math.sqrt(s);
  for (let i = 0; i < DIM; i++) v[i] *= k;
  return v;
}

/** The stub embedding for (person, variant). */
function stubEmbedding(person, variant = 0) {
  const base = unitVector(1000003 * (person + 1));
  if (!variant) return base;
  const noise = unitVector(7919 * (person + 1) + 104729 * variant);
  const v = new Float32Array(DIM);
  let s = 0;
  for (let i = 0; i < DIM; i++) { v[i] = base[i] + 0.5 * noise[i]; s += v[i] * v[i]; }
  const k = 1 / Math.sqrt(s);
  for (let i = 0; i < DIM; i++) v[i] *= k;
  return v;
}

function faceBoxes(n) {
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const w = 0.8 / n, x = (i + 0.1) / n, h = 0.6, y = 0.2;
    // landmarks: the 112 template squeezed into the box
    const landmarks = TEMPLATE_112.map(([lx, ly]) => [x + (lx / 112) * w, y + (ly / 112) * h]);
    boxes.push({ bbox: [x, y, w, h], landmarks });
  }
  return boxes;
}

// --- filename-driven frame source ------------------------------------------

function parseName(filepath) {
  const base = path.basename(String(filepath)).replace(/\.[^.]+$/, '');
  const people = [];
  let durationS = null, bad = false;
  for (const tok of base.split(/[^A-Za-z0-9@.\-]+/)) {
    let m;
    if ((m = /^p(\d+)(?:v(\d+))?(?:@(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?))?$/i.exec(tok))) {
      people.push({
        person: +m[1], variant: m[2] ? +m[2] : 0,
        from: m[3] !== undefined ? +m[3] : -Infinity, to: m[4] !== undefined ? +m[4] : Infinity,
      });
    } else if ((m = /^d(\d+(?:\.\d+)?)$/i.exec(tok))) {
      durationS = +m[1];
    } else if (tok.toLowerCase() === 'bad') {
      bad = true;
    }
  }
  return { people, durationS, bad };
}

function badFile(filepath) {
  const e = new Error(`stub: cannot decode ${filepath}`);
  e.code = 'FRAME_DECODE_FAILED';
  return e;
}

const nameFrames = {
  async decodeImage(filepath) {
    const p = parseName(filepath);
    if (p.bad) throw badFile(filepath);
    return stubFrame(p.people.map(({ person, variant }) => ({ person, variant })));
  },
  async grabFrame(filepath, timeS) {
    const p = parseName(filepath);
    if (p.bad) throw badFile(filepath);
    const t = Number(timeS) || 0;
    return stubFrame(p.people.filter((x) => t >= x.from && t < x.to));
  },
  async* sampleVideo(filepath, { intervalS = 3.5, maxFrames = 2000, durationS, signal } = {}) {
    const p = parseName(filepath);
    if (p.bad) throw badFile(filepath);
    const dur = durationS > 0 ? durationS : (p.durationS || 60);
    let step = Math.max(0.05, intervalS);
    if (dur / step > maxFrames) step = dur / maxFrames;
    for (let i = 0; i < maxFrames && i * step < dur; i++) {
      if (signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const t = i * step;
      yield { timeS: t, durationS: dur, frame: stubFrame(p.people.filter((x) => t >= x.from && t < x.to)) };
    }
  },
};

function createStubEngine({ frames = 'filename' } = {}) {
  const engine = {
    backend: 'stub',
    modelId: 'stub-v1',
    detectorId: 'stub-v1',
    frames: frames === 'ffmpeg' ? require('./frames') : nameFrames,
    calls: { detect: 0, embed: 0 },
    loaded: false,
    async load() { engine.loaded = true; },
    async detect(frame, { minScore = 0, minFacePx = 0 } = {}) {
      engine.calls.detect++;
      const faces = readStubFaces(frame);
      const boxes = faceBoxes(faces.length);
      return faces.map((f, i) => ({
        bbox: boxes[i].bbox,
        // score varies a little with the variant so "best" is deterministic
        score: 0.99 - Math.min(f.variant, 9) * 0.02,
        landmarks: boxes[i].landmarks,
        _stub: f,
      })).filter((f) => f.score >= minScore &&
        Math.min(f.bbox[2] * frame.width, f.bbox[3] * frame.height) >= minFacePx);
    },
    async embed(frame, face) {
      engine.calls.embed++;
      let who = face?._stub;
      if (!who) {                       // face came back without its tag: find it by position
        const faces = readStubFaces(frame);
        const cx = face.bbox[0] + face.bbox[2] / 2;
        who = faces[Math.min(faces.length - 1, Math.floor(cx * faces.length))];
      }
      if (!who) throw new Error('stub: no face at that position');
      return stubEmbedding(who.person, who.variant);
    },
    close() { engine.loaded = false; },
  };
  return engine;
}

module.exports = { createStubEngine, stubFrame, readStubFaces, stubEmbedding, parseName };
