/**
 * Flow order (player-lib/flow-order.js): hand-over costs and grades, the
 * shapes, planOrder (shapes, ties, no music, a fixed first file,
 * determinism), Flow shuffle's lean, and the Stage bar's line.
 */

const test = require('node:test');
const assert = require('node:assert');
const F = require('../player-lib/flow-order.js');

const m = (id, es, em, ee, bpm = 120, extra = {}) => ({ id, measured: true, music: true, es, em, ee, bs: bpm, bm: bpm, be: bpm, ...extra });
const talk = (id, em = 0.4) => ({ id, measured: true, music: false, es: em, em, ee: em, bs: null, bm: null, be: null });
const unmeasured = (id) => ({ id, measured: false, music: false, es: 0, em: 0, ee: 0, bs: null, bm: null, be: null });

test('hand-over: same energy and tempo is free; energy and tempo gaps cost', () => {
  assert.strictEqual(F.handoverCost(m(1, 0.5, 0.5, 0.5), m(2, 0.5, 0.5, 0.5)), 0);
  const e = F.handoverCost(m(1, 0, 0, 0.2), m(2, 0.6, 0.6, 0.6));
  assert.ok(Math.abs(e - 0.65 * 0.4) < 1e-9);
  // 16 % apart or more is the full tempo part
  const t = F.handoverCost(m(1, 0.5, 0.5, 0.5, 100), m(2, 0.5, 0.5, 0.5, 140));
  assert.ok(Math.abs(t - 0.35) < 1e-9);
});

test('hand-over: double and half time count as the same tempo', () => {
  assert.ok(F.handoverCost(m(1, 0.5, 0.5, 0.5, 128), m(2, 0.5, 0.5, 0.5, 64)) < 1e-9);
  assert.ok(F.handoverCost(m(1, 0.5, 0.5, 0.5, 87), m(2, 0.5, 0.5, 0.5, 174)) < 1e-9);
  assert.ok(Math.abs(F.tempoRatio(120, 126) - 0.05) < 1e-9);
});

test('hand-over: the end of A meets the start of B (not the other way round)', () => {
  const a = m(1, 0.1, 0.5, 0.9);
  const b = m(2, 0.9, 0.5, 0.4);
  assert.ok(F.handoverCost(a, b) < 1e-9);
  assert.ok(Math.abs(F.handoverCost(b, a) - 0.65 * 0.3) < 1e-9);
});

test('grades: smooth under 0.12, noticeable under 0.25, then a jump; none with no music', () => {
  assert.strictEqual(F.grade(0.05), 'smooth');
  assert.strictEqual(F.grade(0.119), 'smooth');
  assert.strictEqual(F.grade(0.12), 'noticeable');
  assert.strictEqual(F.grade(0.249), 'noticeable');
  assert.strictEqual(F.grade(0.25), 'jump');
  assert.strictEqual(F.grade(F.handoverCost(talk(1), m(2, 0.5, 0.5, 0.5)), talk(1), m(2, 0.5, 0.5, 0.5)), 'none');
  assert.strictEqual(F.handoverCost(talk(1), m(2, 0.9, 0.9, 0.9)), F.NEUTRAL);
  assert.strictEqual(F.handoverCost(unmeasured(1), m(2, 0.9, 0.9, 0.9)), F.NEUTRAL);
});

const mixed = () => [
  m(1, 0.80, 0.85, 0.80, 140), m(2, 0.20, 0.25, 0.30, 96), m(3, 0.50, 0.55, 0.60, 120),
  m(4, 0.35, 0.40, 0.45, 110), m(5, 0.65, 0.70, 0.75, 128), m(6, 0.92, 0.95, 0.90, 150),
  m(7, 0.10, 0.12, 0.15, 84),
];

test('Build up climbs and Peak then cool down rises then falls', () => {
  const f = mixed();
  const by = new Map(f.map(x => [x.id, x]));
  const build = F.planOrder(f, { shape: 'build' }).order.map(id => by.get(id).em);
  for (let i = 1; i < build.length; i++) assert.ok(build[i] >= build[i - 1], `build order climbs: ${build}`);
  const peak = F.planOrder(f, { shape: 'peak' }).order.map(id => by.get(id).em);
  const top = peak.indexOf(Math.max(...peak));
  assert.ok(top > 0 && top < peak.length - 1, `peak in the middle: ${peak}`);
  assert.ok(peak[peak.length - 1] < peak[top]);
});

test('targets span the collection\'s own range; Steady holds the median; Smooth has none', () => {
  const f = mixed();
  const t = F.targetsFor('build', f);
  assert.strictEqual(t.length, f.length);
  assert.ok(Math.abs(t[0] - 0.12) < 1e-9 && Math.abs(t[t.length - 1] - 0.95) < 1e-9);
  const s = F.targetsFor('steady', f);
  assert.ok(s.every(x => Math.abs(x - 0.55) < 1e-9));
  assert.strictEqual(F.targetsFor('smooth', f), null);
  // A narrow range is widened to 0.15 so the shape still means something.
  const flat = [m(1, 0.5, 0.5, 0.5), m(2, 0.5, 0.52, 0.5), m(3, 0.5, 0.51, 0.5)];
  const ft = F.targetsFor('build', flat);
  assert.ok(Math.abs((ft[2] - ft[0]) - 0.15) < 1e-9);
});

test('Smooth only: every hand-over in a chain that can be smooth is', () => {
  // A chain: each file ends where the next one starts.
  const f = [m(1, 0.7, 0.75, 0.8), m(2, 0.1, 0.2, 0.3), m(3, 0.5, 0.6, 0.7), m(4, 0.3, 0.4, 0.5)];
  const { order } = F.planOrder(f, { shape: 'smooth' });
  assert.deepStrictEqual(order, [2, 4, 3, 1]);
  assert.strictEqual(F.summary(f, order).jumps, 0);
});

test('a fixed first file stays first', () => {
  const f = mixed();
  for (const first of [6, 2, 4]) {
    assert.strictEqual(F.planOrder(f, { shape: 'build', firstId: first }).order[0], first);
  }
  // Unknown id: ignored
  assert.strictEqual(F.planOrder(f, { shape: 'build', firstId: 999 }).order.length, f.length);
});

test('deterministic: the same files and shape give the same order, ties keep the playlist order', () => {
  const f = mixed();
  for (const shape of F.SHAPE_KEYS) {
    const a = F.planOrder(f, { shape }).order;
    const b = F.planOrder(f.map(x => ({ ...x })), { shape }).order;
    assert.deepStrictEqual(a, b, shape);
    assert.deepStrictEqual([...a].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7]);
  }
  // Identical files: the playlist order wins every tie.
  const same = [m(5, 0.5, 0.5, 0.5), m(3, 0.5, 0.5, 0.5), m(9, 0.5, 0.5, 0.5)];
  assert.deepStrictEqual(F.planOrder(same, { shape: 'smooth' }).order, [5, 3, 9]);
  assert.deepStrictEqual(F.planOrder(same, { shape: 'steady' }).order, [5, 3, 9]);
});

test('no music and unmeasured files are placed by the shape alone, with a neutral hand-over', () => {
  const f = [m(1, 0.2, 0.2, 0.2), m(2, 0.5, 0.5, 0.5), m(3, 0.8, 0.8, 0.8), talk(4, 0.21), unmeasured(5)];
  const { order } = F.planOrder(f, { shape: 'build' });
  assert.strictEqual(order.length, 5);
  // The talk (energy 0.21) sits with the calm end of the build.
  assert.ok(order.indexOf(4) <= 1, `talk near the start: ${order}`);
  const s = F.summary(f, order);
  assert.strictEqual(s.handovers.length, 4);
  for (let i = 1; i < order.length; i++) {
    if ([4, 5].includes(order[i]) || [4, 5].includes(order[i - 1])) assert.strictEqual(s.handovers[i - 1].grade, 'none');
  }
});

test('one or no files', () => {
  assert.deepStrictEqual(F.planOrder([], { shape: 'build' }).order, []);
  assert.deepStrictEqual(F.planOrder([m(7, 0.5, 0.5, 0.5)], { shape: 'waves' }).order, [7]);
  assert.deepStrictEqual(F.planOrder([m(1, 0.5, 0.5, 0.5)], { shape: 'nope' }).order, [1]);
});

test('planOrder improves on the greedy pass and stays quick on a big collection', () => {
  const rng = F.seeded(42);
  const f = [];
  for (let i = 1; i <= 300; i++) {
    const e = rng();
    f.push(m(i, Math.max(0, e - 0.1 * rng()), e, Math.min(1, e + 0.1 * rng()), 80 + Math.round(rng() * 90)));
  }
  const t0 = Date.now();
  const a = F.planOrder(f, { shape: 'build' });
  assert.ok(Date.now() - t0 < 2000, 'under two seconds');
  assert.deepStrictEqual(F.planOrder(f, { shape: 'build' }).order, a.order, 'the same order again');
  assert.strictEqual(new Set(a.order).size, 300);
  // Better than the playlist order by a long way.
  const targets = F.targetsFor('build', f);
  const idx = new Map(f.map((x, i) => [x.id, i]));
  assert.ok(a.cost < F.totalCost(f.map((_, i) => i), f, targets) / 3);
  assert.ok(Math.abs(a.cost - F.totalCost(a.order.map(id => idx.get(id)), f, targets)) < 1e-9);
});

test('Flow shuffle: every file once, leaning toward good hand-overs, never a hard filter', () => {
  const f = [];
  for (let i = 1; i <= 20; i++) f.push(m(i, i / 20, i / 20, i / 20, 120));
  const rng = F.seeded(7);
  let flowCost = 0, randCost = 0;
  const cost = (order) => F.summary(f, order).handovers.reduce((s, h) => s + h.cost, 0);
  for (let k = 0; k < 40; k++) {
    const o = F.flowShuffle(f, { rng });
    assert.deepStrictEqual([...o].sort((a, b) => a - b), f.map(x => x.id));
    flowCost += cost(o);
    const r = f.map(x => x.id);
    for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
    randCost += cost(r);
  }
  assert.ok(flowCost < randCost * 0.6, `flow ${flowCost.toFixed(2)} vs random ${randCost.toFixed(2)}`);
  // The start is kept, and a poor hand-over can still be drawn.
  assert.strictEqual(F.flowShuffle(f, { startId: 5, rng })[0], 5);
  const far = [m(1, 0, 0, 0), m(2, 1, 1, 1)];
  let seen = 0;
  for (let k = 0; k < 400; k++) if (F.pickFrom(far[0], [far[1], m(3, 0, 0, 0)], rng) === 0) seen++;
  assert.ok(seen > 0 && seen < 100, `the far one comes up sometimes (${seen} of 400)`);
});

test('the Stage bar line', () => {
  assert.strictEqual(F.flowText(m(1, 0.4, 0.81, 0.77, 128)), '128 BPM · energy high');
  assert.strictEqual(F.flowText({ ...m(1, 0.4, 0.5, 0.5), bs: 124, bm: 128, be: 128 }), '124→128 BPM · energy medium');
  assert.strictEqual(F.flowText(m(1, 0.1, 0.2, 0.1, 90)), '90 BPM · energy low');
  assert.strictEqual(F.flowText(talk(1)), 'no music');
  assert.strictEqual(F.flowText(unmeasured(1)), '');
  assert.strictEqual(F.flowText(null), '');
});

test('fromRow: stored rows to features', () => {
  const f = F.fromRow(3, { has_music: 1, e_start: 0.1, e_mid: 0.2, e_end: 0.3, bpm_start: 100, bpm_mid: 101, bpm_end: 102, lufs: -14 });
  assert.deepStrictEqual([f.measured, f.music, f.es, f.em, f.ee, f.bs, f.be], [true, true, 0.1, 0.2, 0.3, 100, 102]);
  assert.strictEqual(F.fromRow(3, null).measured, false);
  const bad = F.fromRow(3, { error: 'nope' });
  assert.strictEqual(bad.failed, true);
});

test('failed, no-audio and silent files are not "the calmest": they are placed by the shape alone', () => {
  const failed = F.fromRow(10, { error: 'unreadable' });
  const noAudio = F.fromRow(11, { no_audio: 1, has_music: 0, lufs: null, e_start: 0, e_mid: 0, e_end: 0 });
  const silent = F.fromRow(12, { has_music: 0, lufs: null, e_start: 0, e_mid: 0, e_end: 0 });
  assert.strictEqual(failed.measured, false);
  assert.strictEqual(noAudio.noSound, true);
  assert.strictEqual(silent.noSound, true);
  // They do not set the range the shape spans.
  const f = [m(1, 0.4, 0.4, 0.4), m(2, 0.6, 0.6, 0.6), m(3, 0.8, 0.8, 0.8), failed, noAudio, silent];
  const t = F.targetsFor('build', f);
  assert.ok(Math.abs(t[0] - 0.4) < 1e-9);
  // Same cost wherever they go: the music files decide, and they are not pushed to the start.
  const { order } = F.planOrder(f, { shape: 'build' });
  const music = order.filter(id => id <= 3);
  assert.deepStrictEqual(music, [1, 2, 3]);
  assert.notDeepStrictEqual(order.slice(0, 3).sort(), [10, 11, 12]);
  assert.strictEqual(F.handoverCost(noAudio, m(1, 0.4, 0.4, 0.4)), F.NEUTRAL);
});

test('no cliff past 600 files: the improvement pass scales instead of stopping', () => {
  const rng = F.seeded(3);
  const make = (n) => { const out = []; for (let i = 1; i <= n; i++) { const e = rng(); out.push(m(i, e, e, e, 80 + Math.round(rng() * 90))); } return out; };
  const a = make(600), b = a.concat([m(601, 0.5, 0.5, 0.5, 120)]);
  const ca = F.planOrder(a, { shape: 'build' }).cost, cb = F.planOrder(b, { shape: 'build' }).cost;
  assert.ok(cb < ca * 1.1, `600: ${ca.toFixed(1)}, 601: ${cb.toFixed(1)}`);
});
