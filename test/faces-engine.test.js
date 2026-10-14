/**
 * Face engine layer (lib/faces): stub engine determinism, within-file
 * grouping, alignment maths, cosine, the JPEG encoder, model registry, and
 * frames.js against tiny clips generated with ffmpeg (skipped when ffmpeg
 * isn't installed). Real-model tests run only when the ONNX files are present
 * (FACE_MODEL_DIR, ROOT/models/faces, or the dev box's scratch models dir) and
 * the photo checks only when the LFW scratch set is there (FACES_TEST_DIR).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-'));
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');

const { createEngine } = require('../lib/faces/engine');
const { stubFrame, readStubFaces, stubEmbedding, parseName } = require('../lib/faces/stub');
const analyze = require('../lib/faces/analyze');
const { similarityTransform, applyTransform, warpSimilarity, alignFace, TEMPLATE_112 } = require('../lib/faces/align');
const { encodeJpeg } = require('../lib/faces/jpeg');
const frames = require('../lib/faces/frames');
const models = require('../lib/faces/models');
const locate = require('../lib/ffmpeg-locate');

const { cosine, analyzeFile, analyzeFrame, cropJpeg } = analyze;

const FFMPEG = spawnSync(locate.resolve('ffmpeg'), ['-version'], { windowsHide: true }).status === 0;
const FFPROBE = spawnSync(locate.resolve('ffprobe'), ['-version'], { windowsHide: true }).status === 0;
const noFfmpeg = !(FFMPEG && FFPROBE) && 'ffmpeg/ffprobe not available';

function ff(args) {
  const r = spawnSync(locate.resolve('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// ---------------------------------------------------------------------------
// cosine + alignment maths

test('cosine: identical, orthogonal, opposite, scale-invariant, zero-safe', () => {
  assert.strictEqual(cosine([1, 0], [1, 0]), 1);
  assert.strictEqual(cosine([1, 0], [0, 1]), 0);
  assert.strictEqual(cosine([1, 2], [-1, -2]), -1);
  assert.ok(Math.abs(cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-12);
  assert.strictEqual(cosine([0, 0], [1, 1]), 0);
});

test('similarityTransform recovers a known rotation + scale + translation', () => {
  const M = [1.7 * Math.cos(0.35), 1.7 * Math.sin(0.35), 31.5, -12.25];
  const src = [[10, 20], [60, 18], [35, 45], [15, 70], [55, 72]];
  const dst = src.map((p) => applyTransform(M, p));
  const got = similarityTransform(src, dst);
  got.forEach((v, i) => assert.ok(Math.abs(v - M[i]) < 1e-9, `param ${i}: ${v} vs ${M[i]}`));
  // template onto itself is the identity
  const id = similarityTransform(TEMPLATE_112, TEMPLATE_112);
  [1, 0, 0, 0].forEach((v, i) => assert.ok(Math.abs(id[i] - v) < 1e-9));
});

test('warpSimilarity: identity copies pixels, integer translation shifts them', () => {
  const W = 112, data = new Uint8Array(W * W * 3);
  for (let i = 0; i < W * W; i++) { data[i * 3] = i % 251; data[i * 3 + 1] = (i * 7) % 256; data[i * 3 + 2] = (i >> 4) % 256; }
  const frame = { width: W, height: W, data };
  assert.deepStrictEqual(warpSimilarity(frame, [1, 0, 0, 0]).data, data);
  const shifted = warpSimilarity(frame, [1, 0, 5, 3]);         // dst(u,v) = src(u-5, v-3)
  const px = (img, x, y) => Array.from(img.data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3));
  assert.deepStrictEqual(px(shifted, 20, 30), px(frame, 15, 27));
  assert.deepStrictEqual(px(shifted, 2, 1), [0, 0, 0]);       // outside the source -> black border
});

test('alignFace maps the landmarks onto the 112 template', () => {
  // a 400x300 frame whose "face" is the template scaled 2x, rotated 10 deg, moved
  const M = [2 * Math.cos(0.17), 2 * Math.sin(0.17), 120, 40];
  const lm = TEMPLATE_112.map((p) => applyTransform(M, p));
  const W = 400, H = 300, data = new Uint8Array(W * H * 3);
  for (const [x, y] of lm) {                                     // paint a bright dot at each landmark
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const p = ((Math.round(y) + dy) * W + Math.round(x) + dx) * 3;
      data[p] = data[p + 1] = data[p + 2] = 255;
    }
  }
  const aligned = alignFace({ width: W, height: H, data }, lm);
  assert.strictEqual(aligned.width, 112);
  for (const [x, y] of TEMPLATE_112) {
    const p = (Math.round(y) * 112 + Math.round(x)) * 3;
    assert.ok(aligned.data[p] > 200, `landmark (${x},${y}) should land on a dot, got ${aligned.data[p]}`);
  }
});

// ---------------------------------------------------------------------------
// stub engine

test('stub frames encode faces in their first bytes', () => {
  const f = stubFrame([3, { person: 7, variant: 2 }]);
  assert.deepStrictEqual(readStubFaces(f), [{ person: 3, variant: 0 }, { person: 7, variant: 2 }]);
  assert.deepStrictEqual(readStubFaces({ width: 2, height: 2, data: new Uint8Array(12) }), []);
});

test('stub engine is deterministic and scripts same vs different people', async () => {
  const e = createEngine({ backend: 'stub' });
  await e.load();
  assert.strictEqual(e.modelId, 'stub-v1');
  const frame = stubFrame([1, { person: 1, variant: 1 }, 2]);
  const a = await e.detect(frame), b = await e.detect(frame);
  assert.strictEqual(a.length, 3);
  assert.deepStrictEqual(a.map((f) => f.bbox), b.map((f) => f.bbox));
  for (const f of a) {
    assert.strictEqual(f.landmarks.length, 5);
    f.bbox.forEach((v) => assert.ok(v >= 0 && v <= 1));
  }
  const [e0, e1, e2] = await Promise.all(a.map((f) => e.embed(frame, f)));
  assert.strictEqual(e0.length, 128);
  assert.ok(Math.abs(cosine(e0, e0) - 1) < 1e-6);
  const same = cosine(e0, e1), diff = cosine(e0, e2);
  assert.ok(same > 0.8 && same < 0.95, `variant cosine ${same}`);
  assert.ok(Math.abs(diff) < 0.35, `different-person cosine ${diff}`);
  assert.deepStrictEqual(Array.from(await e.embed(frame, a[0])), Array.from(e0));
  // a face that lost its _stub tag (e.g. round-tripped through JSON) is found by position
  const plain = JSON.parse(JSON.stringify(a[2]));
  assert.deepStrictEqual(Array.from(await e.embed(frame, plain)), Array.from(e2));
  // filters
  assert.strictEqual((await e.detect(stubFrame([{ person: 1, variant: 9 }]), { minScore: 0.9 })).length, 0);
  assert.strictEqual((await e.detect(stubFrame([1]), { minFacePx: 1000 })).length, 0);
  assert.strictEqual(e.calls.detect, 4);
});

test('stub embeddings: different people stay apart across many ids', () => {
  let worst = -1;
  for (let i = 0; i < 40; i++) for (let j = i + 1; j < 40; j++) worst = Math.max(worst, cosine(stubEmbedding(i), stubEmbedding(j)));
  assert.ok(worst < analyze.GROUP_THRESHOLD, `max cross-person cosine ${worst}`);
});

test('stub filename tokens', () => {
  const p = parseName('/x/clip_p1@0-30_p2v3@40-60.5_d90.mp4');
  assert.strictEqual(p.durationS, 90);
  assert.deepStrictEqual(p.people.map((x) => [x.person, x.variant, x.from, x.to]), [[1, 0, 0, 30], [2, 3, 40, 60.5]]);
  assert.strictEqual(parseName('bad_p1.jpg').bad, true);
});

// ---------------------------------------------------------------------------
// analyze (stub-backed: no models, no ffmpeg)

const stubEngine = () => createEngine({ backend: 'stub' });

test('analyzeFile image: one group per face, JPEG crops', async () => {
  const r = await analyzeFile(stubEngine(), { filepath: '/lib/party_p3_p7.jpg', kind: 'image' });
  assert.strictEqual(r.framesChecked, 1);
  assert.strictEqual(r.groups.length, 2);
  for (const g of r.groups) {
    assert.strictEqual(g.appearances, 1);
    assert.strictEqual(g.firstTimeS, null);
    assert.strictEqual(g.best.frameTimeS, null);
    assert.ok(Buffer.isBuffer(g.best.crop) && g.best.crop[0] === 0xff && g.best.crop[1] === 0xd8);
    assert.strictEqual(g.exemplars.length, 1);
    assert.strictEqual(g.exemplars[0].embedding.length, 128);
  }
  const none = await analyzeFile(stubEngine(), { filepath: '/lib/landscape.png', kind: 'image' });
  assert.deepStrictEqual(none.groups, []);
});

test('analyzeFile video: groups people across time, poses merge, co-present people never do', async () => {
  // p1 for the first 30 s; p1 in another pose 30-50 s; p2 alongside p1 from 20 s on
  const r = await analyzeFile(stubEngine(), { filepath: '/v/talk_p1@0-30_p1v2@30-50_p2@20-60.mp4', kind: 'video', durationS: 60 }, { intervalS: 3.5 });
  assert.strictEqual(r.framesChecked, Math.ceil(60 / 3.5));
  assert.strictEqual(r.groups.length, 2);
  const [g1, g2] = r.groups;                       // sorted by appearances
  // p1: t = 0..28 (9 frames) + 31.5..49 (6 frames)
  assert.strictEqual(g1.appearances, 15);
  assert.strictEqual(g1.firstTimeS, 0);
  assert.strictEqual(g1.best.detScore, 0.99);      // canonical pose beats variant 2
  assert.ok(g1.exemplars.length >= 1 && g1.exemplars.length <= 3);
  // p2: t = 21..59.5 (12 frames)
  assert.strictEqual(g2.appearances, 12);
  assert.strictEqual(g2.firstTimeS, 21);
  assert.ok(cosine(g1.exemplars[0].embedding, g2.exemplars[0].embedding) < 0.5);
});

test('analyzeFile video: one-off faces are dropped unless clear, kept on short clips', async () => {
  const long = await analyzeFile(stubEngine(),
    { filepath: '/v/x_p1_p5@20-22_p6v9@30-32.mp4', kind: 'video', durationS: 60 });
  // p5: clear (0.99) and large -> kept; p6: variant 9 (score 0.81) -> dropped
  const firsts = long.groups.map((g) => g.firstTimeS).sort((a, b) => a - b);
  assert.deepStrictEqual(firsts, [0, 21]);
  const kept = await analyzeFile(stubEngine(),
    { filepath: '/v/x_p1_p5@20-22_p6v9@30-32.mp4', kind: 'video', durationS: 60 }, { keepSingletons: true });
  assert.strictEqual(kept.groups.length, 3);
  const short = await analyzeFile(stubEngine(), { filepath: '/v/s_p1_p6v9@3-4.mp4', kind: 'video', durationS: 10 });
  assert.strictEqual(short.framesChecked, 3);
  assert.strictEqual(short.groups.length, 2);
});

test('analyzeFile video: maxFrames stretches the interval; progress and abort', async () => {
  const progress = [];
  const r = await analyzeFile(stubEngine(), { filepath: '/v/long_p1.mp4', kind: 'video', durationS: 7200 },
    { maxFrames: 100, onProgress: (p) => progress.push(p) });
  assert.strictEqual(r.framesChecked, 100);
  assert.strictEqual(progress.length, 100);
  assert.strictEqual(progress[99].framesChecked, 100);
  assert.strictEqual(r.groups[0].appearances, 100);

  const ac = new AbortController();
  await assert.rejects(
    analyzeFile(stubEngine(), { filepath: '/v/long_p1.mp4', kind: 'video', durationS: 600 },
      { signal: ac.signal, onProgress: (p) => { if (p.framesChecked === 3) ac.abort(); } }),
    (e) => e.name === 'AbortError');
  await assert.rejects(analyzeFile(stubEngine(), { filepath: '/v/bad_p1.mp4', kind: 'video' }),
    (e) => e.code === 'FRAME_DECODE_FAILED');
});

test('assignFaces: two faces in one frame never share a group', () => {
  const { assignFaces, mergeGroups } = analyze;
  const v = stubEmbedding(1);
  const groups = [];
  let id = 0;
  const landed = assignFaces(groups, [
    { embedding: v, frameTimeS: 0, q: 1 }, { embedding: v, frameTimeS: 0, q: 1 },
  ], 0, 0.45, () => id++);
  assert.strictEqual(groups.length, 2);
  assert.notStrictEqual(landed[0], landed[1]);
  // they co-occur, so the merge pass must keep them apart too
  mergeGroups(groups, 0.45);
  assert.strictEqual(groups.length, 2);
  // a third look-alike in a later frame joins one of them; then two groups with
  // disjoint frames and the same face DO merge
  const g = [];
  assignFaces(g, [{ embedding: v, frameTimeS: 0, q: 1 }], 0, 0.99, () => id++);
  assignFaces(g, [{ embedding: stubEmbedding(1, 1), frameTimeS: 5, q: 1 }], 1, 0.99, () => id++);
  assert.strictEqual(g.length, 2);              // 0.89 < 0.99: separate during the pass
  mergeGroups(g, 0.8);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].frames.size, 2);
});

test('pickExemplars: best first, at most 3, mutually diverse', () => {
  const ms = [];
  for (let v = 0; v < 8; v++) ms.push({ embedding: stubEmbedding(4, v), q: 1 - v * 0.05, bbox: [0, 0, 1, 1], frameTimeS: v, detScore: 0.9 });
  ms.push({ embedding: stubEmbedding(4, 0), q: 0.1, bbox: [0, 0, 1, 1], frameTimeS: 99, detScore: 0.9 }); // duplicate of best
  const ex = analyze.pickExemplars(ms);
  assert.ok(ex.length >= 1 && ex.length <= 3);
  assert.strictEqual(ex[0].frameTimeS, 0);
  for (let i = 0; i < ex.length; i++) for (let j = i + 1; j < ex.length; j++) {
    assert.ok(cosine(ex[i].embedding, ex[j].embedding) < 0.8);
  }
  assert.ok(!ex.some((e) => e.frameTimeS === 99));
});

test('analyzeFrame returns embedding, bbox, landmarks, score and crop per face', async () => {
  const faces = await analyzeFrame(stubEngine(), stubFrame([{ person: 2, variant: 3 }, 5]));
  assert.strictEqual(faces.length, 2);
  assert.strictEqual(faces[0].detScore, 0.99);   // best first
  for (const f of faces) {
    assert.strictEqual(f.embedding.length, 128);
    assert.strictEqual(f.landmarks.length, 5);
    assert.strictEqual(f.bbox.length, 4);
    assert.ok(f.crop.length > 100);
  }
});

// ---------------------------------------------------------------------------
// JPEG encoder + crops

test('encodeJpeg writes a well-formed baseline JFIF', () => {
  const img = { width: 37, height: 21, data: new Uint8Array(37 * 21 * 3).map((_, i) => (i * 13) % 256) };
  const j = encodeJpeg(img, 85);
  assert.deepStrictEqual([j[0], j[1], j[2], j[3]], [0xff, 0xd8, 0xff, 0xe0]);
  assert.deepStrictEqual([j[j.length - 2], j[j.length - 1]], [0xff, 0xd9]);
  const sof = j.indexOf(Buffer.from([0xff, 0xc0]));
  assert.strictEqual(j.readUInt16BE(sof + 5), 21);
  assert.strictEqual(j.readUInt16BE(sof + 7), 37);
});

test('cropJpeg makes a square crop of the requested size', { skip: noFfmpeg }, async () => {
  const W = 300, H = 200, data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = (y * W + x) * 3; data[p] = x < 150 ? 220 : 20; data[p + 1] = 60; data[p + 2] = y < 100 ? 200 : 30; }
  const buf = await cropJpeg({ width: W, height: H, data }, [0.4, 0.3, 0.2, 0.4], 96);
  const p = path.join(tmp, 'crop.jpg');
  fs.writeFileSync(p, buf);
  const back = await frames.decodeImage(p);
  assert.strictEqual(back.width, 96);
  assert.strictEqual(back.height, 96);
  // left half red-ish, right half not; top blue-ish, bottom not
  const at = (x, y) => back.data.subarray((y * 96 + x) * 3, (y * 96 + x) * 3 + 3);
  assert.ok(at(10, 48)[0] > 150 && at(86, 48)[0] < 80);
  assert.ok(at(48, 10)[2] > 150 && at(48, 86)[2] < 80);
});

test('encodeJpeg round-trips through ffmpeg with high fidelity', { skip: noFfmpeg }, async () => {
  const W = 64, H = 48, data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = (y * W + x) * 3; data[p] = x * 4; data[p + 1] = y * 5; data[p + 2] = 128; }
  const p = path.join(tmp, 'rt.jpg');
  fs.writeFileSync(p, encodeJpeg({ width: W, height: H, data }, 90));
  const back = await frames.decodeImage(p);
  let se = 0;
  for (let i = 0; i < data.length; i++) se += (data[i] - back.data[i]) ** 2;
  const psnr = 10 * Math.log10(255 * 255 / (se / data.length));
  assert.ok(psnr > 35, `PSNR ${psnr}`);
});

// ---------------------------------------------------------------------------
// frames.js

test('PpmReader reassembles frames split across arbitrary chunks', () => {
  const mk = (w, h, v) => Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), Buffer.alloc(w * h * 3, v)]);
  const all = Buffer.concat([mk(3, 2, 7), mk(1, 1, 9), mk(2, 2, 1)]);
  const r = new frames.PpmReader();
  const got = [];
  for (let i = 0; i < all.length; i += 5) got.push(...r.push(all.subarray(i, i + 5)));
  assert.deepStrictEqual(got.map((f) => [f.width, f.height, f.data[0], f.data.length]), [[3, 2, 7, 18], [1, 1, 9, 3], [2, 2, 1, 12]]);
});

function jpegWithOrientation(jpeg, orient) {
  // APP1 Exif, big-endian TIFF, IFD0 with one Orientation entry
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orient, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

test('exifOrientationFromBuffer reads the tag and defaults to 1', () => {
  const base = encodeJpeg({ width: 8, height: 8, data: new Uint8Array(192) });
  assert.strictEqual(frames.exifOrientationFromBuffer(base), 1);
  for (const o of [3, 6, 8]) assert.strictEqual(frames.exifOrientationFromBuffer(jpegWithOrientation(base, o)), o);
  assert.strictEqual(frames.exifOrientationFromBuffer(Buffer.from('not a jpeg')), 1);
});

test('decodeImage: RGB order, maxSide, EXIF rotation, GIF first frame', { skip: noFfmpeg }, async () => {
  const red = path.join(tmp, 'red.png');
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=400x300', '-frames:v', '1', red]);
  const f = await frames.decodeImage(red, { maxSide: 200 });
  assert.deepStrictEqual([f.width, f.height, f.data.length], [200, 150, 200 * 150 * 3]);
  assert.ok(f.data[0] > 240 && f.data[1] < 15 && f.data[2] < 15, `RGB order: ${f.data.slice(0, 3)}`);
  const small = await frames.decodeImage(red, { maxSide: 4000 });   // never upscales
  assert.deepStrictEqual([small.width, small.height], [400, 300]);

  // left half white, right half black; EXIF 6 = rotate 90 cw for display
  const W = 64, H = 32, data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) data.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const rot = path.join(tmp, 'rot.jpg');
  fs.writeFileSync(rot, jpegWithOrientation(encodeJpeg({ width: W, height: H, data }, 95), 6));
  const r = await frames.decodeImage(rot);
  assert.deepStrictEqual([r.width, r.height], [32, 64]);
  // after a clockwise turn the white half is on top
  assert.ok(r.data[(5 * 32 + 16) * 3] > 200 && r.data[(58 * 32 + 16) * 3] < 50);

  const gif = path.join(tmp, 'anim.gif');
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=40x30:d=0.5,format=rgb24', '-f', 'lavfi', '-i', 'color=c=yellow:s=40x30:d=0.5',
    '-filter_complex', '[0][1]concat=n=2:v=1', '-r', '10', gif]);
  const g = await frames.decodeImage(gif);
  assert.deepStrictEqual([g.width, g.height], [40, 30]);
  assert.ok(g.data[2] > 200 && g.data[0] < 60, `first GIF frame should be blue: ${g.data.slice(0, 3)}`);

  await assert.rejects(frames.decodeImage(path.join(tmp, 'missing.jpg')), (e) => e.code === 'FRAME_DECODE_FAILED');
});

let clip = null;
function makeClip() {
  if (clip) return clip;
  clip = path.join(tmp, 'clip.mp4');
  // 10 s, 320x240, 10 fps, a keyframe every second (mpeg4 is in every ffmpeg build)
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=10:d=10', '-c:v', 'mpeg4', '-g', '10', '-q:v', '5', clip]);
  return clip;
}

test('sampleVideo: frames on the interval grid, both decode paths', { skip: noFfmpeg }, async () => {
  const c = makeClip();
  const p = await frames.probeVideo(c);
  assert.ok(Math.abs(p.durationS - 10) < 0.2);
  assert.ok(p.medianKeyGapS <= 1.01);
  for (const mode of ['auto', 'keyframes', 'full']) {
    const got = [];
    for await (const { timeS, frame } of frames.sampleVideo(c, { intervalS: 2, mode, maxSide: 160 })) {
      assert.deepStrictEqual([frame.width, frame.height, frame.data.length], [160, 120, 160 * 120 * 3]);
      got.push(timeS);
    }
    assert.deepStrictEqual(got.map((t) => Math.round(t * 10) / 10), [0, 2, 4, 6, 8], `mode ${mode}`);
  }
});

test('sampleVideo: maxFrames stretches the spacing', { skip: noFfmpeg }, async () => {
  const got = [];
  for await (const { timeS } of frames.sampleVideo(makeClip(), { intervalS: 1, maxFrames: 3, durationS: 10 })) got.push(timeS);
  assert.ok(got.length <= 3 && got.length >= 2, `${got}`);
  assert.ok(got[1] - got[0] >= 3, `spacing ${got}`);
});

test('sampleVideo: break and abort stop ffmpeg promptly', { skip: noFfmpeg }, async () => {
  const t0 = Date.now();
  for await (const _ of frames.sampleVideo(makeClip(), { intervalS: 0.1, mode: 'full' })) break; // eslint-disable-line no-unused-vars
  const ac = new AbortController();
  let n = 0;
  await assert.rejects((async () => {
    for await (const _ of frames.sampleVideo(makeClip(), { intervalS: 0.1, mode: 'full', signal: ac.signal })) { // eslint-disable-line no-unused-vars
      if (++n === 2) ac.abort();
    }
  })(), (e) => e.name === 'AbortError');
  assert.strictEqual(n, 2);
  assert.ok(Date.now() - t0 < 10000);
});

test('grabFrame returns the frame at a timestamp', { skip: noFfmpeg }, async () => {
  const f = await frames.grabFrame(makeClip(), 5.2, { maxSide: 100 });
  assert.deepStrictEqual([f.width, f.height], [100, 75]);
});

// ---------------------------------------------------------------------------
// model registry

test('model registry: keys, hashes, consent metadata, presence check', () => {
  assert.deepStrictEqual(models.FACE_MODEL_KEYS, ['face:detect', 'face:embed']);
  for (const key of models.FACE_MODEL_KEYS) {
    const m = models.FACE_MODELS[key];
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.match(m.url, /^https:\/\/huggingface\.co\/opencv\/.+\/resolve\/[0-9a-f]{40}\//);
    assert.ok(['MIT', 'Apache-2.0'].includes(m.license));
  }
  // Keepers: pinned to a revision, one url constant each, consent metadata.
  assert.deepStrictEqual(models.KEEPER_KEYS, ['face:keeper-ir50', 'face:keeper-ir101']);
  for (const key of models.KEEPER_KEYS) {
    const m = models.FACE_MODELS[key];
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.match(m.url, /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/.+\.onnx$/);
    assert.ok(m.bytes > 1e8);
    assert.strictEqual(require('../lib/model-consent').describe(key).kind, 'face');
  }
  assert.strictEqual(models.FACE_MODELS['face:keeper-ir50'].url, models.IR50_URL);
  assert.strictEqual(models.FACE_MODELS['face:keeper-ir101'].url, models.IR101_URL);
  const t = models.matchThresholds('sface-2021dec');
  assert.ok(t.close > t.normal && t.normal > t.wide);
  assert.deepStrictEqual(models.matchThresholds('stub-v1'), t);
  assert.throws(() => models.matchThresholds('arcface'), /no match thresholds/);
  const consent = require('../lib/model-consent');
  assert.strictEqual(consent.describe('face:embed').sizeHint, '~37 MB');
  assert.strictEqual(consent.describe('face:detect').kind, 'face');

  const dir = path.join(tmp, 'models');
  fs.mkdirSync(dir);
  let r = models.resolveFaceModelPaths({ dir });
  assert.deepStrictEqual([r.ok, r.missing], [false, ['face:detect', 'face:embed']]);
  fs.writeFileSync(r.paths['face:detect'], Buffer.alloc(models.FACE_MODELS['face:detect'].bytes));
  fs.writeFileSync(r.paths['face:embed'], Buffer.alloc(10));      // truncated download
  r = models.resolveFaceModelPaths({ dir });
  assert.deepStrictEqual([r.present, r.missing], [['face:detect'], ['face:embed']]);
  assert.strictEqual(models.verifyFaceModel('face:detect', r.paths['face:detect']).ok, false);  // zeros != model
});

test('onnx engine: load() reports exactly which models are missing', async () => {
  const dir = path.join(tmp, 'empty-models');
  fs.mkdirSync(dir);
  const e = createEngine({ backend: 'onnx', modelPaths: { 'face:detect': path.join(dir, 'a.onnx') } });
  await assert.rejects(e.load(), (err) => err.code === 'FACE_MODELS_MISSING' &&
    err.missing.join() === 'face:detect,face:embed');
  const prev = process.env.FACE_MODEL_DIR;
  process.env.FACE_MODEL_DIR = dir;
  try {
    await assert.rejects(createEngine().load(), (err) => err.code === 'FACE_MODELS_MISSING' && err.missing.length === 2);
  } finally {
    if (prev === undefined) delete process.env.FACE_MODEL_DIR; else process.env.FACE_MODEL_DIR = prev;
  }
});

// ---------------------------------------------------------------------------
// real models (skipped unless the ONNX files are on this box)

const DEV_SCRATCH = path.resolve(__dirname, '..', '..', '..', 'Vault-scratch');
function findModels() {
  for (const dir of [process.env.FACE_MODEL_DIR, models.faceModelDir(), path.join(DEV_SCRATCH, 'models', 'faces')]) {
    if (!dir) continue;
    const r = models.resolveFaceModelPaths({ dir });
    if (r.ok) return r.paths;
  }
  return null;
}
const realPaths = findModels();
const noModels = !realPaths && 'face models not present';
const LFW_DIR = path.join(process.env.FACES_TEST_DIR || path.join(DEV_SCRATCH, 'faces-test'), 'lfw', 'lfw');
const noLfw = (noModels || noFfmpeg || (!fs.existsSync(LFW_DIR) && 'LFW test set not present'));

test('real engine: blank frame has no faces; embeddings are unit 128-d', { skip: noModels }, async () => {
  const e = createEngine({ backend: 'onnx', modelPaths: realPaths, threads: 2 });
  await e.load();
  assert.strictEqual(e.modelId, 'sface-2021dec');
  const blank = { width: 320, height: 240, data: new Uint8Array(320 * 240 * 3).fill(90) };
  assert.deepStrictEqual(await e.detect(blank), []);
  const v = await e.embed(blank, { bbox: [0.3, 0.2, 0.4, 0.6], landmarks: TEMPLATE_112.map(([x, y]) => [(x + 100) / 320, (y + 60) / 240]) });
  assert.strictEqual(v.length, 128);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-4);
  e.close();
});

test('real engine: frontal faces detect > 0.9 with sane landmarks; same person scores higher', { skip: noLfw }, async () => {
  const e = createEngine({ backend: 'onnx', modelPaths: realPaths, threads: 2 });
  const img = (n, i) => path.join(LFW_DIR, n, `${n}_${String(i).padStart(4, '0')}.jpg`);
  const embs = [];
  for (const p of [img('George_W_Bush', 1), img('George_W_Bush', 2), img('Colin_Powell', 1)]) {
    const frame = await frames.decodeImage(p);
    const faces = await e.detect(frame);
    const f = faces.sort((a, b) => Math.hypot(a.bbox[0] + a.bbox[2] / 2 - 0.5, a.bbox[1] + a.bbox[3] / 2 - 0.5) -
      Math.hypot(b.bbox[0] + b.bbox[2] / 2 - 0.5, b.bbox[1] + b.bbox[3] / 2 - 0.5))[0];
    assert.ok(f && f.score > 0.9, `${p}: score ${f && f.score}`);
    const [re, le, nose, rm, lm] = f.landmarks;
    const [x, y, w, h] = f.bbox;
    for (const [px, py] of f.landmarks) assert.ok(px > x && px < x + w && py > y && py < y + h, 'landmark inside box');
    assert.ok(re[0] < le[0] && rm[0] < lm[0], 'eyes and mouth corners left-to-right');
    assert.ok(nose[1] > re[1] && nose[1] > le[1] && rm[1] > nose[1] && lm[1] > nose[1], 'eyes above nose above mouth');
    assert.ok(nose[0] > re[0] && nose[0] < le[0], 'nose between the eyes');
    embs.push(await e.embed(frame, f));
  }
  const same = cosine(embs[0], embs[1]), diff = cosine(embs[0], embs[2]);
  assert.ok(same > 0.363 && same > diff + 0.15, `same ${same} diff ${diff}`);
  assert.ok(diff < 0.363, `different people ${diff}`);
  e.close();
});

test('real engine: worker and in-process backends agree; frames switch correctly', { skip: noLfw }, async () => {
  const w = createEngine({ backend: 'onnx', modelPaths: realPaths, threads: 1 });
  const ip = createEngine({ backend: 'onnx', modelPaths: realPaths, threads: 1, inProcess: true });
  const a = await frames.decodeImage(path.join(LFW_DIR, 'George_W_Bush', 'George_W_Bush_0003.jpg'));
  const b = await frames.decodeImage(path.join(LFW_DIR, 'Colin_Powell', 'Colin_Powell_0002.jpg'));
  const [fa, fb] = await Promise.all([w.detect(a), w.detect(b)]);       // interleaved frames on one engine
  assert.deepStrictEqual(fa, await ip.detect(a));
  assert.deepStrictEqual(fb, await ip.detect(b));
  // embed A's face with frame B in between: the worker must not reuse the wrong frame
  const [eb, ea] = await Promise.all([w.embed(b, fb[0]), w.embed(a, fa[0])]);
  assert.deepStrictEqual(Array.from(ea), Array.from(await ip.embed(a, fa[0])));
  assert.deepStrictEqual(Array.from(eb), Array.from(await ip.embed(b, fb[0])));
  w.close(); ip.close();
  assert.deepStrictEqual(await w.detect(a), fa);   // a closed engine reloads lazily on next use
  w.close();
});

test('real engine: close() is safe mid-request and mid-analysis', { skip: noModels || noFfmpeg }, async () => {
  const e = createEngine({ backend: 'onnx', modelPaths: realPaths, threads: 1 });
  const blank = { width: 640, height: 480, data: new Uint8Array(640 * 480 * 3) };
  await e.load();
  assert.deepStrictEqual(await (() => { const q = e.detect(blank); e.close(); return q; })(), [],
    'closed before the call was sent: it reloads and answers');
  const inflight = e.detect(blank);
  while (e._pending.size === 0) await new Promise((r) => setImmediate(r));   // message posted to the worker
  e.close();                                            // worker terminated under a running call
  await assert.rejects(inflight, /closed/);
  // between calls (as the pool's idle close would be): the analysis carries on, reloading lazily
  let n = 0;
  const r = await analyzeFile(e, { filepath: makeClip(), kind: 'video' }, {
    intervalS: 1, onProgress: () => { if (++n === 2) e.close(); },
  });
  assert.strictEqual(r.framesChecked, 10);
  e.close();
});

test('decodeImage finds JPEGs by magic bytes: EXIF applied whatever the file is called', { skip: noFfmpeg }, async () => {
  const W = 64, H = 32, data = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) data.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3);
  const odd = path.join(tmp, 'upload-from-browser.img');           // what an image/pjpeg upload is saved as
  fs.writeFileSync(odd, jpegWithOrientation(encodeJpeg({ width: W, height: H, data }, 95), 6));
  assert.deepStrictEqual(frames.sniffJpeg(odd), { isJpeg: true, orientation: 6 });
  const r = await frames.decodeImage(odd);
  assert.deepStrictEqual([r.width, r.height], [32, 64]);
  assert.ok(r.data[(5 * 32 + 16) * 3] > 200 && r.data[(58 * 32 + 16) * 3] < 50);
  // a PNG is not sniffed as JPEG (ffmpeg keeps its own orientation handling)
  const png = path.join(tmp, 'blue.png');
  ff(['-f', 'lavfi', '-i', 'color=c=blue:s=20x10', '-frames:v', '1', png]);
  assert.deepStrictEqual(frames.sniffJpeg(png), { isJpeg: false, orientation: 1 });
  assert.deepStrictEqual(await frames.decodeImage(png).then((f) => [f.width, f.height]), [20, 10]);
});

test('real engine: a rotated JPEG uploaded as image/pjpeg (saved as .img) still finds its face', { skip: noLfw }, async () => {
  const src = await frames.decodeImage(path.join(LFW_DIR, 'George_W_Bush', 'George_W_Bush_0001.jpg'));
  // store the pixels turned 90 degrees counter-clockwise, tagged EXIF 6 (display: turn clockwise)
  const { width: W, height: H } = src;
  const rot = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const nx = y, ny = W - 1 - x;                                  // CCW: (x,y) -> (y, W-1-x) in an H-wide image
    rot.set(src.data.subarray((y * W + x) * 3, (y * W + x) * 3 + 3), (ny * H + nx) * 3);
  }
  const file = path.join(tmp, 'query.img');
  fs.writeFileSync(file, jpegWithOrientation(encodeJpeg({ width: H, height: W, data: rot }, 92), 6));
  const e = createEngine({ backend: 'onnx', modelPaths: realPaths, threads: 1 });
  const faces = await e.detect(await frames.decodeImage(file));
  assert.ok(faces.length >= 1 && faces[0].score > 0.9, `faces ${faces.length}`);
  e.close();
});
