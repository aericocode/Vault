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

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('hand-over cost: each part as a share of its jump step, the larger counts fully, the smaller 0.3', () => {
  assert.strictEqual(F.handoverCost(m(1, 0.5, 0.5, 0.5), m(2, 0.5, 0.5, 0.5)), 0);
  // Energy 0.14 apart, same tempo: 1.4 jump steps.
  assert.ok(near(F.handoverCost(m(1, 0.5, 0.5, 0.64), m(2, 0.5, 0.5, 0.5)), 0.25 * 1.4));
  // Tempo 5 % apart, same energy: half a jump step.
  assert.ok(near(F.handoverCost(m(1, 0.5, 0.5, 0.5, 120), m(2, 0.5, 0.5, 0.5, 126)), 0.25 * 0.5));
  // Both: the larger plus 0.3 x the smaller.
  assert.ok(near(F.handoverCost(m(1, 0.5, 0.5, 0.7), m(2, 0.5, 0.5, 0.5, 126)), 0.25 * (2 + 0.3 * 0.5)));
  // A part counts up to 4 jump steps.
  assert.ok(near(F.handoverCost(m(1, 0, 0, 0), m(2, 1, 1, 1)), 0.25 * 4));
  // A big energy step now costs more than a small tempo change (it used to be the other way round).
  assert.ok(F.handoverCost(m(1, 0.5, 0.5, 0.64), m(2, 0.5, 0.5, 0.5)) > F.handoverCost(m(1, 0.5, 0.5, 0.5, 120), m(2, 0.5, 0.5, 0.5, 128)));
  // Unknown tempo with music both sides: half a jump step for tempo.
  assert.ok(near(F.handoverCost(m(1, 0.5, 0.5, 0.5, null), m(2, 0.5, 0.5, 0.5)), 0.25 * 0.5));
});

test('hand-over: double and half time count as the same tempo', () => {
  assert.ok(F.handoverCost(m(1, 0.5, 0.5, 0.5, 128), m(2, 0.5, 0.5, 0.5, 64)) < 1e-9);
  assert.ok(F.handoverCost(m(1, 0.5, 0.5, 0.5, 87), m(2, 0.5, 0.5, 0.5, 174)) < 1e-9);
  assert.ok(Math.abs(F.tempoRatio(120, 126) - 0.05) < 1e-9);
});

test('hand-over: the end of A meets the start of B (not the other way round), the envelope ends first', () => {
  const a = m(1, 0.1, 0.5, 0.9);
  const b = m(2, 0.9, 0.5, 0.4);
  assert.ok(F.handoverCost(a, b) < 1e-9);
  assert.ok(near(F.handoverCost(b, a), 0.25 * 3));
  // With an envelope, its first and last points (ei / eo, as the chart's line ends) are used.
  const ea = { ...m(3, 0.5, 0.5, 0.5), ei: 0.5, eo: 0.8 };
  const eb = { ...m(4, 0.5, 0.5, 0.5), ei: 0.8, eo: 0.5 };
  assert.strictEqual(F.handover(ea, eb).dE, 0);
  assert.strictEqual(F.handover(m(5, 0.5, 0.5, 0.5), eb).dE, 0.3);
  const row = F.fromRow(6, { has_music: 1, lufs: -10, e_start: 0.5, e_mid: 0.5, e_end: 0.5, env: '[[0.05,0.61],[0.5,0.5],[0.95,0.42]]' });
  assert.strictEqual(row.ei, 0.61);
  assert.strictEqual(row.eo, 0.42);
});

test('grades: energy and tempo apart, the worse wins', () => {
  const g = (a, b) => { const h = F.handover(a, b); return [h.grade, h.energyGrade, h.tempoGrade]; };
  // Energy: smooth under 0.05, noticeable under 0.10, a jump from 0.10.
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5), m(2, 0.54, 0.5, 0.5)), ['smooth', 'smooth', 'smooth']);
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5), m(2, 0.55, 0.5, 0.5)), ['noticeable', 'noticeable', 'smooth']);
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5), m(2, 0.59, 0.5, 0.5)), ['noticeable', 'noticeable', 'smooth']);
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5), m(2, 0.6, 0.5, 0.5)), ['jump', 'jump', 'smooth']);
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.64), m(2, 0.5, 0.5, 0.5)), ['jump', 'jump', 'smooth'], 'a 14-point drop at the same tempo is a jump');
  // Tempo: smooth under 4 %, noticeable under 10 %, a jump from 10 %.
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5, 120), m(2, 0.5, 0.5, 0.5, 124)), ['smooth', 'smooth', 'smooth']);
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5, 120), m(2, 0.5, 0.5, 0.5, 126)), ['noticeable', 'smooth', 'noticeable']);
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5, 120), m(2, 0.5, 0.5, 0.5, 133)), ['jump', 'smooth', 'jump']);
  // The real hand-overs from the user's list.
  assert.strictEqual(F.handover(m(1, 0.8, 0.8, 0.8, 115), m(2, 0.77, 0.77, 0.77, 137)).grade, 'jump');
  assert.strictEqual(F.handover(m(1, 0.8, 0.8, 0.8, 126), m(2, 0.67, 0.67, 0.67, 139)).energyGrade, 'jump');
  // A missing BPM on one side: no tempo grade.
  assert.deepStrictEqual(g(m(1, 0.5, 0.5, 0.5, null), m(2, 0.57, 0.5, 0.5)), ['noticeable', 'noticeable', null]);
  // Music on one side only: the energy alone. Neither, or not measured: none.
  assert.deepStrictEqual(g(talk(1, 0.4), m(2, 0.55, 0.5, 0.5)), ['jump', 'jump', null]);
  assert.deepStrictEqual(g(m(1, 0.42, 0.42, 0.42), talk(2, 0.4)), ['smooth', 'smooth', null]);
  assert.strictEqual(F.grade(talk(1), talk(2)), 'none');
  // A file with no music meets its neighbours at its middle energy (drawn flat there).
  assert.strictEqual(F.handover({ ...talk(1, 0.5), es: 0.1, ee: 0.9, ei: 0.1, eo: 0.9 }, m(2, 0.5, 0.5, 0.5)).dE, 0);
  assert.strictEqual(F.grade(unmeasured(1), m(2, 0.5, 0.5, 0.5)), 'none');
  assert.strictEqual(F.handoverCost(talk(1), talk(2)), F.NEUTRAL);
  assert.strictEqual(F.handoverCost(unmeasured(1), m(2, 0.9, 0.9, 0.9)), F.NEUTRAL);
  // One side only costs by energy, like its grade.
  assert.ok(near(F.handoverCost(talk(1, 0.4), m(2, 0.55, 0.5, 0.5)), 0.25 * 1.5));
  // The summary carries the parts.
  const s = F.summary([m(1, 0.5, 0.5, 0.64, 120), m(2, 0.5, 0.5, 0.5, 132)], [1, 2]);
  assert.deepStrictEqual(Object.keys(s.handovers[0]).sort(), ['cost', 'dE', 'energyGrade', 'grade', 'tempoGrade', 'tempoPct']);
  assert.strictEqual(s.handovers[0].dE, -0.14);
  assert.strictEqual(s.handovers[0].tempoPct, 10);
  assert.strictEqual(s.jumps, 1);
});

test('tempo grades at exactly 4 % and 10 % apart (no floating-point noise), cost to match', () => {
  const tg = (x, y) => F.handover(m(1, 0.5, 0.5, 0.5, x), m(2, 0.5, 0.5, 0.5, y)).tempoGrade;
  // Every whole BPM from 50 to 200 into exactly 10 % more (a 1-decimal BPM),
  // and every fifth into exactly 4 % more.
  for (let b = 50; b <= 200; b++) {
    const up10 = Math.round(b * 11) / 10;
    assert.strictEqual(tg(b, up10), 'jump', `${b} into ${up10}`);
    if (b % 5 === 0) {
      const up4 = Math.round(b * 10.4) / 10;
      assert.strictEqual(tg(b, up4), 'noticeable', `${b} into ${up4}`);
    }
  }
  assert.strictEqual(tg(58, 63.8), 'jump');
  assert.strictEqual(tg(53, 58.3), 'jump');
  assert.strictEqual(tg(100, 104), 'noticeable');
  assert.strictEqual(tg(100, 103.9), 'smooth');
  assert.strictEqual(F.tempoRatio(58, 63.8), 0.1);
  // The cost uses the same rounded ratio: exactly one jump step.
  assert.ok(Math.abs(F.handoverCost(m(1, 0.5, 0.5, 0.5, 58), m(2, 0.5, 0.5, 0.5, 63.8)) - 0.25) < 1e-9);
});

test('a BPM that is not a finite number above 0 is no tempo', () => {
  for (const bad of [0, -120, Infinity, NaN, '120']) {
    const h = F.handover(m(1, 0.5, 0.5, 0.5, bad), m(2, 0.5, 0.5, 0.5, 120));
    assert.strictEqual(h.tempoGrade, null, String(bad));
    assert.strictEqual(h.tempoPct, null);
    const t = F.handoverText(m(1, 0.5, 0.5, 0.5, bad), m(2, 0.5, 0.5, 0.5, 120));
    assert.ok(!/NaN|Infinity/.test(t), t);
    assert.ok(Number.isFinite(F.handoverCost(m(1, 0.5, 0.5, 0.5, bad), m(2, 0.5, 0.5, 0.5, 120))));
  }
});

test('handoverText: the reason in plain words, the worse part first', () => {
  // Matched against double or half time: said in every grade.
  assert.strictEqual(F.handoverText(m(1, 0.5, 0.5, 0.5, 120), m(2, 0.5, 0.5, 0.5, 250)), 'Tempo 120 → 250 BPM (double time, 4% apart) · energy steady');
  assert.strictEqual(F.handoverText(m(1, 0.5, 0.5, 0.5, 280), m(2, 0.5, 0.5, 0.5, 120)), 'Tempo 280 → 120 BPM (half time, 17% apart) · energy steady');
  const t = (a, b) => F.handoverText(a, b);
  assert.strictEqual(t(m(1, 0.5, 0.5, 0.64), m(2, 0.5, 0.5, 0.5)), 'Energy drops 14 · same tempo');
  assert.strictEqual(t(m(1, 0.8, 0.8, 0.8, 115), m(2, 0.8, 0.8, 0.8, 137)), 'Tempo 115 → 137 BPM (19% apart) · energy steady');
  assert.strictEqual(t(m(1, 0.5, 0.5, 0.5, 120), m(2, 0.58, 0.5, 0.5, 122)), 'Energy rises 8 · tempo close, 120 → 122 BPM');
  assert.strictEqual(t(m(1, 0.5, 0.5, 0.5, 128), m(2, 0.5, 0.5, 0.5, 64)), 'Energy steady · tempo close, 128 → 64 BPM (half time)');
  assert.strictEqual(t(m(1, 0.7, 0.7, 0.7), talk(2, 0.4)), 'Energy drops 30 · no music in the next file');
  assert.strictEqual(t(talk(1, 0.4), talk(2, 0.4)), '');
  for (const s of [t(m(1, 0.5, 0.5, 0.64), m(2, 0.5, 0.5, 0.5)), t(m(1, 0.7, 0.7, 0.7), talk(2, 0.4))]) assert.ok(!s.includes('—'), 'no em dashes');
});

const mixed = () => [
  m(1, 0.80, 0.85, 0.80, 140), m(2, 0.20, 0.25, 0.30, 96), m(3, 0.50, 0.55, 0.60, 120),
  m(4, 0.35, 0.40, 0.45, 110), m(5, 0.65, 0.70, 0.75, 128), m(6, 0.92, 0.95, 0.90, 150),
  m(7, 0.10, 0.12, 0.15, 84),
];

test('Build up climbs and Peak rises then falls', () => {
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

test('no music and unmeasured files: placed by the shape (talk by its energy too), graded on energy or not at all', () => {
  const f = [m(1, 0.2, 0.2, 0.2), m(2, 0.5, 0.5, 0.5), m(3, 0.8, 0.8, 0.8), talk(4, 0.21), unmeasured(5)];
  const { order } = F.planOrder(f, { shape: 'build' });
  assert.strictEqual(order.length, 5);
  // The talk (energy 0.21) sits with the calm end of the build.
  assert.ok(order.indexOf(4) <= 1, `talk near the start: ${order}`);
  const s = F.summary(f, order);
  assert.strictEqual(s.handovers.length, 4);
  for (let i = 1; i < order.length; i++) {
    // Not measured: nothing to grade. The talk (no music): graded on its energy alone.
    if (order[i] === 5 || order[i - 1] === 5) assert.strictEqual(s.handovers[i - 1].grade, 'none');
    else if (order[i] === 4 || order[i - 1] === 4) assert.strictEqual(s.handovers[i - 1].tempoGrade, null);
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
  // (Tempos 80..170: the off-tempo files as planOrder plans them.)
  const targets = F.targetsFor('build', f);
  const g = F.markOffTempo(f, 'build').feats;
  const idx = new Map(f.map((x, i) => [x.id, i]));
  assert.ok(a.cost < F.totalCost(f.map((_, i) => i), g, targets) / 3);
  assert.ok(Math.abs(a.cost - F.totalCost(a.order.map(id => idx.get(id)), g, targets)) < 1e-9);
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

/* ── Places (stream tags, lib/stream-tags.js) ──────────────────────────── */

const twelve = () => {
  const rng = F.seeded(7);
  const out = [];
  for (let i = 1; i <= 12; i++) { const e = 0.15 + 0.7 * rng(); out.push(m(i, e, e, e, 100 + Math.round(rng() * 40))); }
  return out;
};

test('places: First goes to the start and Last to the end, with any shape (Smooth only too)', () => {
  const f = twelve();
  for (const shape of F.SHAPE_KEYS) {
    const { order } = F.planOrder(f, { shape, places: { 7: 'first', 3: 'last', 9: 'first' } });
    assert.deepStrictEqual([...order.slice(0, 2)].sort((a, b) => a - b), [7, 9], shape);
    assert.strictEqual(order[order.length - 1], 3, shape);
    assert.strictEqual(new Set(order).size, 12);
  }
  // A Map works the same, and a fixed first file still comes before the Firsts.
  const { order } = F.planOrder(f, { shape: 'build', firstId: 5, places: new Map([[7, 'first']]) });
  assert.deepStrictEqual(order.slice(0, 2), [5, 7]);
});

test('places: At a peak takes the highest targets, At a low point the lowest', () => {
  const f = twelve();
  const by = new Map(f.map(x => [x.id, x]));
  const calmest = [...f].sort((a, b) => a.em - b.em)[0].id;
  const wildest = [...f].sort((a, b) => b.em - a.em)[0].id;
  // Put the peak on the calmest file and the low on the wildest: the places win over the energy.
  const plan = F.planOrder(f, { shape: 'build', places: { [calmest]: 'peak', [wildest]: 'low' } });
  const t = plan.targets;
  const top = t.indexOf(Math.max(...t)), bottom = t.indexOf(Math.min(...t));
  assert.strictEqual(plan.order[top], calmest);
  assert.strictEqual(plan.order[bottom], wildest);
  // Waves: two peaks land one on each crest, not side by side.
  const w = F.planOrder(f, { shape: 'waves', places: { 1: 'peak', 2: 'peak' } });
  const p1 = w.order.indexOf(1), p2 = w.order.indexOf(2);
  assert.ok(Math.abs(p1 - p2) > 1, `peaks apart: ${p1}, ${p2}`);
  for (const p of [p1, p2]) assert.ok(w.targets[p] > 0.8 * Math.max(...w.targets), `on a crest: ${p}`);
  assert.ok(by.size === 12);
});

test('places: After a peak follows a peak-placed file', () => {
  const f = twelve();
  for (const shape of ['build', 'waves', 'peak']) {
    const { order } = F.planOrder(f, { shape, places: { 4: 'peak', 8: 'after_peak' } });
    assert.strictEqual(order.indexOf(8), order.indexOf(4) + 1, `${shape}: ${order}`);
  }
});

test('places: Smooth only and Steady use First and Last only; Anywhere is ignored', () => {
  const f = twelve();
  for (const shape of ['smooth', 'steady']) {
    const plain = F.planOrder(f, { shape }).order;
    assert.deepStrictEqual(F.planOrder(f, { shape, places: { 4: 'peak', 5: 'low', 6: 'after_peak', 7: 'anywhere' } }).order, plain, shape);
  }
  assert.deepStrictEqual(F.planOrder(f, { shape: 'build', places: { 7: 'anywhere' } }).order, F.planOrder(f, { shape: 'build' }).order);
});

test('places: precedence First > Last > At a peak > After a peak > At a low point', () => {
  assert.strictEqual(F.resolvePlace(['low', 'peak', 'last']), 'last');
  assert.strictEqual(F.resolvePlace(['after_peak', 'first', 'last']), 'first');
  assert.strictEqual(F.resolvePlace(['low', 'after_peak']), 'after_peak');
  assert.strictEqual(F.resolvePlace(['anywhere']), null);
  const f = twelve();
  const { order } = F.planOrder(f, { shape: 'build', places: { 6: ['peak', 'last'], 2: ['low', 'first'] } });
  assert.strictEqual(order[0], 2);
  assert.strictEqual(order[11], 6);
});

test('places: unmeasured files keep their spot but never take the start or end from a First or Last', () => {
  const f = [unmeasured(1), m(2, 0.3, 0.3, 0.3), m(3, 0.6, 0.6, 0.6), m(4, 0.5, 0.5, 0.5), unmeasured(5), m(6, 0.8, 0.8, 0.8)];
  const { order } = F.planOrder(f, { shape: 'build', places: { 3: 'first', 4: 'last' } });
  assert.strictEqual(order[0], 3);
  assert.strictEqual(order[5], 4);
  assert.strictEqual(new Set(order).size, 6);
  // A placed file is ordered even when it is not measured.
  const g = F.planOrder(f, { shape: 'build', places: { 5: 'first' } }).order;
  assert.strictEqual(g[0], 5);
});

test('places: deterministic, and a big collection stays quick', () => {
  const rng = F.seeded(11);
  const f = [];
  const places = {};
  const kinds = ['first', 'last', 'peak', 'after_peak', 'low'];
  for (let i = 1; i <= 800; i++) {
    const e = rng();
    f.push(m(i, e, e, e, 80 + Math.round(rng() * 90)));
    if (rng() < 0.05) places[i] = kinds[Math.floor(rng() * kinds.length)];
  }
  const t0 = Date.now();
  const a = F.planOrder(f, { shape: 'waves', places });
  assert.ok(Date.now() - t0 < 5000, 'quick');
  assert.deepStrictEqual(F.planOrder(f, { shape: 'waves', places }).order, a.order);
  assert.strictEqual(new Set(a.order).size, 800);
  const firsts = Object.keys(places).filter(k => places[k] === 'first').map(Number);
  assert.deepStrictEqual(a.order.slice(0, firsts.length).sort((x, y) => x - y), firsts.sort((x, y) => x - y));
  assert.strictEqual(a.placed, Object.keys(places).length);
});

test('places with unmeasured files: worked out on the whole order (a peak is never put on a low target)', () => {
  // The repro: file 2 unmeasured keeps its spot, so the peak takes the highest target left.
  const r = F.planOrder([m(1, 0.5, 0.5, 0.5), unmeasured(2), m(3, 0.6, 0.6, 0.6)], { shape: 'build', places: { 1: 'peak', 3: 'after_peak' } });
  assert.deepStrictEqual(r.order, [3, 2, 1]);
  assert.strictEqual(r.targets[r.order.indexOf(1)], Math.max(...r.targets));
  // Room for both: the After a peak follows its peak.
  const s = F.planOrder([m(1, 0.5, 0.5, 0.5), unmeasured(2), m(3, 0.6, 0.6, 0.6), m(4, 0.4, 0.4, 0.4)], { shape: 'build', places: { 1: 'peak', 3: 'after_peak' } });
  assert.strictEqual(s.order.indexOf(3), s.order.indexOf(1) + 1, String(s.order));
});

test('places with unmeasured files: peaks sit at or above the mean target, and After a peak follows a peak where it can', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rng = F.seeded(seed);
    const n = 8 + Math.floor(rng() * 20);
    const feats = [];
    for (let i = 1; i <= n; i++) {
      const e = rng();
      feats.push(rng() < 0.25 ? unmeasured(i) : m(i, e, e, e, 90 + Math.round(rng() * 60)));
    }
    const measured = feats.filter(f => f.measured).map(f => f.id);
    const places = {};
    const nPeak = 1 + Math.floor(rng() * 3);
    const nAfter = Math.floor(rng() * (nPeak + 1));
    const pick = measured.slice().sort((a, b) => (rng() - 0.5) || a - b);
    const peaks = pick.slice(0, nPeak), afters = pick.slice(nPeak, nPeak + nAfter);
    for (const id of peaks) places[id] = 'peak';
    for (const id of afters) places[id] = 'after_peak';
    for (const shape of ['build', 'waves', 'peak']) {
      const r = F.planOrder(feats, { shape, places });
      assert.strictEqual(new Set(r.order).size, n);
      const mean = r.targets.reduce((x, y) => x + y, 0) / n;
      for (const id of peaks) assert.ok(r.targets[r.order.indexOf(id)] >= mean - 1e-9, `seed ${seed} ${shape}: peak ${id} at ${r.order.indexOf(id)}`);
      // A peak can be followed when the slot after it is not an unmeasured file's or another peak's.
      const aside = new Set(feats.filter(f => !f.measured).map(f => f.id));
      const roomy = peaks.filter(id => { const p = r.order.indexOf(id); return p < n - 1 && !aside.has(r.order[p + 1]) && !peaks.includes(r.order[p + 1]); }).length;
      const followed = afters.filter(id => { const p = r.order.indexOf(id); return p > 0 && peaks.includes(r.order[p - 1]); }).length;
      assert.ok(followed >= Math.min(afters.length, roomy), `seed ${seed} ${shape}: ${followed} of ${afters.length} follow a peak (${roomy} could): ${r.order}`);
    }
  }
});

test('reconcileOrder: gone files dropped, new ones at the end, repeats once', () => {
  assert.deepStrictEqual(F.reconcileOrder([3, 1, 2], [1, 2, 3]), [3, 1, 2]);
  // A file removed from the collection (2) is dropped; a new one (9) goes at the end.
  assert.deepStrictEqual(F.reconcileOrder([3, 2, 1], [1, 3, 9]), [3, 1, 9]);
  assert.deepStrictEqual(F.reconcileOrder([3, 3, 1], [1, 3]), [3, 1]);
  assert.deepStrictEqual(F.reconcileOrder(null, [5, 4]), [5, 4]);
  assert.deepStrictEqual(F.reconcileOrder([1, 2], []), []);
});

test('moveBlock: a drag in Flow order (a block, before a file or at the end), null when nothing moves', () => {
  assert.deepStrictEqual(F.moveBlock([1, 2, 3, 4, 5], [5], 2), [1, 5, 2, 3, 4]);
  assert.deepStrictEqual(F.moveBlock([1, 2, 3, 4, 5], [4, 2], 1), [2, 4, 1, 3, 5], 'kept in the order they had');
  assert.deepStrictEqual(F.moveBlock([1, 2, 3], [1], null), [2, 3, 1]);
  assert.strictEqual(F.moveBlock([1, 2, 3], [2], 3), null, 'already there');
  assert.strictEqual(F.moveBlock([1, 2, 3], [2], 2), null, 'before itself');
  assert.strictEqual(F.moveBlock([1, 2, 3], [7], 1), null, 'not in the order');
  assert.strictEqual(F.moveBlock([1, 2, 3], [1], 99), null, 'before a file that is not there');
});

test('parseRemembered: only a plain object with a known shape, places true / false / null, whole ids', () => {
  assert.deepStrictEqual(F.parseRemembered('{"shape":"waves","places":null,"edited":[3,1,3]}'), { shape: 'waves', places: null, edited: [3, 1], waves: 2 });
  assert.deepStrictEqual(F.parseRemembered('{"shape":"build","places":true}'), { shape: 'build', places: true, edited: null, waves: 2 });
  assert.deepStrictEqual(F.parseRemembered('{"shape":"peak","edited":[]}'), { shape: 'peak', places: null, edited: null, waves: 2 });
  // Waves' peaks: kept when 1..6; an entry from before (none) or a bad count reads as 2, the entry kept.
  assert.strictEqual(F.parseRemembered('{"shape":"waves","waves":5}').waves, 5);
  for (const w of ['0', '7', '2.5', 'null', '[]', '"many"']) assert.strictEqual(F.parseRemembered(`{"shape":"waves","waves":${w}}`).waves, 2, w);
  for (const bad of [null, '', 'nope', '[]', '[{"shape":"waves"}]', '"waves"', '42', '{"shape":"wobbly"}', '{}',
    '{"shape":"waves","places":"yes"}', '{"shape":"waves","edited":"1,2"}', '{"shape":"waves","edited":[1,-2]}',
    '{"shape":"waves","edited":[1.5]}', '{"shape":"waves","edited":[null]}']) {
    assert.strictEqual(F.parseRemembered(bad), null, String(bad));
  }
});

test('nextAfter: Up next first, else the next file in the list, else none', () => {
  const list = [10, 20, 30];
  const o = { indexOf: (id) => list.indexOf(id), idAt: (i) => list[i] };
  assert.deepStrictEqual(F.nextAfter(10, o), { id: 20, upNext: false });
  assert.strictEqual(F.nextAfter(30, o), null, 'the last file');
  assert.strictEqual(F.nextAfter(99, o), null, 'not in the list');
  assert.strictEqual(F.nextAfter(null, o), null);
  assert.deepStrictEqual(F.nextAfter(10, { ...o, upNext: [30, 20] }), { id: 30, upNext: true });
  assert.deepStrictEqual(F.nextAfter(null, { ...o, upNext: [30] }), { id: 30, upNext: true });
});

test('guideTargets: the picked shape\'s guide, from the answer when it is for that shape, else worked out the same way', () => {
  const f = [m(1, 0.2, 0.2, 0.2), m(2, 0.5, 0.5, 0.5), m(3, 0.9, 0.9, 0.9), talk(4), unmeasured(5)];
  const served = { shape: 'waves', targets: F.targetsFor('waves', f).map(t => Math.round(t * 1000) / 1000), features: f };
  // The server's own targets for the shape picked.
  assert.strictEqual(F.guideTargets('waves', served), served.targets);
  // An answer for another shape (or with no targets: Smooth only) still gives the picked shape's guide.
  assert.deepStrictEqual(F.guideTargets('waves', { shape: 'smooth', targets: null, features: f }), F.targetsFor('waves', f));
  assert.deepStrictEqual(F.guideTargets('build', served), F.targetsFor('build', f));
  // Worked out here, it matches the server's to its rounding.
  F.guideTargets('waves', { shape: 'build', targets: null, features: f }).forEach((t, i) => assert.ok(Math.abs(t - served.targets[i]) < 0.001));
  // Smooth only has no guide; no answer yet, or no shape, none either.
  assert.strictEqual(F.guideTargets('smooth', served), null);
  assert.strictEqual(F.guideTargets('waves', null), null);
  assert.strictEqual(F.guideTargets('nope', served), null);
});

test('Waves: N peaks for 1..6, 2 by default and exactly the curve it always had', () => {
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    assert.strictEqual(F.curve('waves', t), 0.5 + 0.5 * Math.sin(t * Math.PI * 3), `t ${t}`);
    assert.strictEqual(F.curve('waves', t, 2), F.curve('waves', t));
  }
  const crests = (w) => {
    let k = 0;
    const y = (i) => F.curve('waves', i / 1000, w);
    for (let i = 1; i < 1000; i++) if (y(i) > y(i - 1) && y(i) >= y(i + 1) && y(i) > 0.99) k++;
    return k;
  };
  for (let w = 1; w <= 6; w++) assert.strictEqual(crests(w), w, `${w} waves`);
  // A bad count is the default.
  for (const bad of [0, 7, 2.5, null, undefined, 'x', '', NaN]) assert.strictEqual(F.wavesCount(bad), 2, String(bad));
  assert.strictEqual(F.wavesCount('4'), 4, 'a query string number');
  assert.strictEqual(F.wavesCount(6), 6);
  // The targets and the order follow the count; other shapes ignore it.
  const f = [];
  for (let i = 1; i <= 30; i++) f.push(m(i, i / 31, i / 31, i / 31));
  const t2 = F.targetsFor('waves', f), t5 = F.targetsFor('waves', f, { waves: 5 });
  assert.deepStrictEqual(F.targetsFor('waves', f, { waves: 2 }), t2);
  assert.notDeepStrictEqual(t5, t2);
  assert.notDeepStrictEqual(F.planOrder(f, { shape: 'waves', waves: 5 }).order, F.planOrder(f, { shape: 'waves' }).order);
  assert.deepStrictEqual(F.planOrder(f, { shape: 'waves', waves: 5 }).targets, t5);
  assert.deepStrictEqual(F.targetsFor('build', f, { waves: 5 }), F.targetsFor('build', f));
});

test('guideTargets: an answer for Waves with another count of peaks is worked out again', () => {
  const f = [];
  for (let i = 1; i <= 20; i++) f.push(m(i, i / 21, i / 21, i / 21));
  const served = { shape: 'waves', waves: 3, targets: F.targetsFor('waves', f, { waves: 3 }), features: f };
  assert.strictEqual(F.guideTargets('waves', served, 3), served.targets);
  assert.deepStrictEqual(F.guideTargets('waves', served, 4), F.targetsFor('waves', f, { waves: 4 }));
  // An answer from before counts (no waves) is for 2.
  const old = { shape: 'waves', targets: F.targetsFor('waves', f), features: f };
  assert.strictEqual(F.guideTargets('waves', old), old.targets);
  assert.deepStrictEqual(F.guideTargets('waves', old, 6), F.targetsFor('waves', f, { waves: 6 }));
});

/** 57 files near 120 BPM with middle energies 0.4..0.8, and three far off that tempo with energies far out. */
function offTempo() {
  const f = [];
  for (let i = 1; i <= 57; i++) {
    const e = 0.4 + 0.4 * ((i * 7) % 57) / 56;
    f.push(m(i, e, e, e, 114 + (i % 13)));
  }
  // 88 and 84 BPM: more than 1.35 under 120; 170: more than 1.35 over it.
  f.push(m(58, 0.05, 0.05, 0.05, 88), m(59, 0.1, 0.1, 0.1, 84), m(60, 0.98, 0.98, 0.98, 170));
  return f;
}

test('off tempo: more than 1.35 off the median tempo as it is (not folded), and only from 12 files with a tempo', () => {
  const f = offTempo();
  assert.deepStrictEqual([...F.shapeOutliers(f)].sort((a, b) => a - b), [58, 59, 60]);
  // Half and double time are off tempo too now; just inside 1.35 is not; no tempo or no music never is.
  const g = f.concat([m(61, 0.5, 0.5, 0.5, 60), m(62, 0.5, 0.5, 0.5, 240), m(63, 0.5, 0.5, 0.5, 92), m(64, 0.5, 0.5, 0.5, 160), talk(65), m(66, 0.5, 0.5, 0.5, null)]);
  assert.deepStrictEqual([...F.shapeOutliers(g)].sort((a, b) => a - b), [58, 59, 60, 61, 62]);
  // Under 12 music files with a tempo: none.
  assert.strictEqual(F.shapeOutliers(f.slice(0, 8).concat(f.slice(57))).size, 0);
});

test('off tempo: three outliers among 60 leave the range to the other 57 (5th to 95th percentile)', () => {
  const f = offTempo();
  const rest = f.slice(0, 57);
  const ems = rest.map(x => x.em).sort((a, b) => a - b);
  const q = (p) => { const x = (ems.length - 1) * p, i = Math.floor(x); return ems[i] + (ems[Math.min(i + 1, ems.length - 1)] - ems[i]) * (x - i); };
  // Every shape keeps inside it and reaches its top (Waves and Peak: within a step of the crest),
  // and the outliers' energies do not move it.
  const moved = f.map(x => (x.id >= 58 ? { ...x, em: 1 - x.em } : x));
  for (const shape of ['build', 'waves', 'peak']) {
    const t = F.targetsFor(shape, f);
    assert.ok(t.every(v => v >= q(0.05) - 1e-9 && v <= q(0.95) + 1e-9), shape);
    assert.ok(Math.max(...t) > q(0.95) - 0.02, shape);
    assert.deepStrictEqual(F.targetsFor(shape, moved), t, shape);
  }
  // Build up's ends: exactly the percentiles, the same as for the 57 alone.
  const b = F.targetsFor('build', f), alone = F.targetsFor('build', rest);
  assert.ok(near(b[0], q(0.05)) && near(b[59], q(0.95)));
  assert.ok(near(alone[0], b[0]) && near(alone[56], b[59]));
  // Without leaving them out, the range would run 0.05..0.98.
  assert.ok(b[0] > 0.4 && b[59] < 0.8);
  // Steady: the 57's median.
  assert.ok(near(F.targetsFor('steady', f)[0], ems[28]));
});

test('off tempo: the shape reads an outlier\'s energy clamped into the range, at the usual weight; a Place still wins', () => {
  const f = offTempo();
  const plan = F.planOrder(f, { shape: 'build' });
  assert.strictEqual(new Set(plan.order).size, 60);
  const lo = plan.targets[0], hi = plan.targets[59];
  // planOrder plans 58 and 59 at lo and 60 at hi: the shape, and the hand-overs (by energy alone).
  const marked = F.markOffTempo(f, 'build').feats;
  assert.deepStrictEqual(marked.slice(57).map(x => [x.offTempo, x.emShape, x.es, x.ee]), [[true, lo, lo, lo], [true, lo, lo, lo], [true, hi, hi, hi]]);
  assert.ok(near(F.handoverCost(marked[0], marked[57]), 0.25 * Math.abs(marked[0].ee - lo) / 0.1), 'energy alone, no tempo part');
  const idx = new Map(f.map((x, i) => [x.id, i]));
  assert.ok(near(F.totalCost(plan.order.map(id => idx.get(id)), marked, plan.targets), plan.cost));
  // 58 (energy 0.05) at a target: 1.5 x its distance from lo, not from 0.05; 60 (0.98) the same from hi.
  for (const t of [lo, 0.6, hi]) {
    assert.ok(near(F.totalCost([57], marked, [t]), 1.5 * Math.abs(lo - t)), `58 at ${t}`);
    assert.ok(near(F.totalCost([59], marked, [t]), 1.5 * Math.abs(hi - t)), `60 at ${t}`);
  }
  // The caller's files are not changed.
  assert.ok(f.every(x => !('emShape' in x)));
  // A Last tag on a calm outlier still puts it last.
  const placed = F.planOrder(f, { shape: 'build', places: { 58: 'last' } });
  assert.strictEqual(placed.order[59], 58);
  // A small playlist (under 12 with a tempo) keeps its lowest to highest range.
  const small = [m(1, 0.1, 0.1, 0.1, 120), m(2, 0.5, 0.5, 0.5, 60), m(3, 0.9, 0.9, 0.9, 200)];
  const st = F.targetsFor('build', small);
  assert.ok(near(st[0], 0.1) && near(st[2], 0.9));
});

test('off tempo: Build up starts on the calm outliers and ends on the hot one, never on the calmest', () => {
  const f = offTempo();
  const order = F.planOrder(f, { shape: 'build' }).order;
  const at = (id) => order.indexOf(id);
  assert.ok(at(58) < 6 && at(59) < 6, `calm outliers near the start: ${at(58)}, ${at(59)}`);
  assert.ok(at(60) >= 54, `the hot outlier near the end: ${at(60)}`);
  assert.ok(!order.slice(-5).some(id => id === 58 || id === 59), 'no calm outlier in the last places');
  // The same in a bigger playlist with the outliers scattered through it.
  const g = offTempo().map((x, i) => ({ ...x, id: 1000 + ((i * 37) % 60) }));
  const calm = g.filter(x => x.em < 0.2).map(x => x.id), hot = g.find(x => x.em > 0.9).id;
  const o2 = F.planOrder(g, { shape: 'build' }).order;
  assert.ok(calm.every(id => o2.indexOf(id) < 6) && o2.indexOf(hot) >= 54, o2.join());
});

test('off tempo: Peak and Waves put the hot outlier on a high part of the curve and the calm ones on a low part, not at the ends', () => {
  const f = offTempo();
  for (const o of [{ shape: 'peak' }, { shape: 'waves', waves: 2 }]) {
    const plan = F.planOrder(f, o);
    const t = plan.targets, lo = Math.min(...t), hi = Math.max(...t);
    const at = (id) => plan.order.indexOf(id);
    const name = `${o.shape} ${o.waves || ''}`;
    assert.ok(t[at(60)] >= lo + 0.8 * (hi - lo), `${name}: the hot one at ${at(60)}, target ${t[at(60)]}`);
    for (const id of [58, 59]) assert.ok(t[at(id)] <= lo + 0.2 * (hi - lo), `${name}: calm ${id} at ${at(id)}, target ${t[at(id)]}`);
    for (const id of [58, 59, 60]) assert.ok(at(id) > 0 && at(id) < 59, `${name}: ${id} not at an end (${at(id)})`);
    // The grades still say the tempo jump into and out of an outlier (the caller's files, unchanged).
    const s = F.summary(f, plan.order);
    assert.strictEqual(s.handovers[at(60) - 1].tempoGrade, 'jump', name);
    assert.match(F.handoverText(f.find(x => x.id === plan.order[at(60) - 1]), f[59]), /% apart/);
  }
  // A place tag still wins over the curve.
  assert.strictEqual(F.planOrder(f, { shape: 'peak', places: { 60: 'first' } }).order[0], 60);
});
