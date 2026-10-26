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

test('handoverText: the reason in plain words, the worse part first', () => {
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
