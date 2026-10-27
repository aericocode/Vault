/**
 * Ignore calm intros and credits (player-lib/flow-order.js "Calm edges",
 * lib/flow/analyze.js edge pieces, lib/flow/store.js edges): how far Flow
 * looks past each edge in each mode, Off (and rows without edge pieces)
 * exactly as before, the hand-over grades it changes, how the edges are
 * stored, the chart's shading (FlowChartMath.ignoredSpan), the setting, and
 * a real file with a quiet intro measured end to end.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const FlowOrder = require('../player-lib/flow-order.js');
const FlowChartMath = require('../player-lib/flow-chart-math.js');
const analyze = require('../lib/flow/analyze');
const store = require('../lib/flow/store');
const stageSettings = require('../lib/stage/settings');

/**
 * One side's edge pieces: `calm` pieces of calm (l -40, e 0.1) from the edge,
 * then the body (l -14, e 0.6); w after each skip as the body or calm.
 * o.l / o.e / o.w override whole lists.
 */
function side(calm = 0, o = {}) {
  const l = [], e = [], w = [], b = [];
  for (let k = 0; k < 12; k++) { l.push(k < calm ? -40 : -14); e.push(k < calm ? 0.1 : 0.6); }
  for (let k = 0; k < 10; k++) { w.push(k < calm ? 0.1 + 0.15 * (k / Math.max(1, calm)) : 0.6); b.push(k < calm ? 90 : 128); }
  return { l: o.l || l, e: o.e || e, w: o.w || w, b: o.b || b };
}
/** A measured row (version 5) with music, body energy 0.6 at -14 LUFS, and these edges. */
function row(edges, extra = {}) {
  return {
    version: analyze.VERSION, lufs: -14, has_music: 1, no_audio: 0,
    e_start: 0.2, e_mid: 0.6, e_end: 0.2, bpm_start: 90, bpm_mid: 128, bpm_end: 90,
    env: JSON.stringify([[0.05, 0.1], [0.15, 0.6], [0.25, 0.6], [0.5, 0.6], [0.75, 0.6], [0.85, 0.6], [0.95, 0.1]]),
    edges: edges == null ? null : JSON.stringify(edges),
    ...extra,
  };
}
const skips = (r, mode) => FlowOrder.fromRow(1, r, mode).skip || [0, 0];

test('Auto: a calm intro and calm credits are looked past; their after is the body', () => {
  const r = row({ d: 200, start: side(4), end: side(6) });
  assert.deepStrictEqual(skips(r, 'auto'), [20, 30]);
  const f = FlowOrder.fromRow(1, r, 'auto');
  // The start and end now read the 15 s after the skips (the body), tempo too.
  assert.deepStrictEqual([f.es, f.ei, f.bs, f.ee, f.eo, f.be], [0.6, 0.6, 128, 0.6, 0.6, 128]);
  assert.deepStrictEqual(f.cut, [0.1, 0.15]);
  assert.strictEqual(f.em, 0.6, 'the middle is not touched');
});

test('Auto leaves alone: no calm edge, a quiet song, a soft start that builds, a calm run still well under the body, no music', () => {
  // No calm edge.
  assert.deepStrictEqual(skips(row({ d: 200, start: side(0), end: side(0) }), 'auto'), [0, 0]);
  // Calm all through: the body is calm too (energy 0.1 at -40 LUFS), so nothing is calmer than it.
  const quiet = { l: Array(12).fill(-40), e: Array(12).fill(0.1), w: Array(10).fill(0.1), b: Array(10).fill(100) };
  const qr = row({ d: 200, start: quiet, end: quiet }, { lufs: -40, e_mid: 0.1, env: JSON.stringify([[0.1, 0.1], [0.5, 0.1], [0.9, 0.1]]) });
  assert.deepStrictEqual(skips(qr, 'auto'), [0, 0]);
  // Starts soft with its beat (6 LU under the file, energy 0.42): not calm enough on loudness.
  const soft = side(0, { l: [-20, -20, -20, -20, -20, -14, -14, -14, -14, -14, -14, -14], e: [0.42, 0.42, 0.42, 0.42, 0.42, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6] });
  assert.deepStrictEqual(skips(row({ d: 200, start: soft, end: side(0) }), 'auto'), [0, 0]);
  // Quiet enough, but the 15 s after the calm run is still well under the body (more climb to come): nothing.
  const climb = side(3, { w: [0.1, 0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.6, 0.6] });
  assert.deepStrictEqual(skips(row({ d: 200, start: climb, end: side(0) }), 'auto'), [0, 0]);
  // A slow fade-in that reaches the body: its quiet part is looked past (6 calm pieces, then the body: 30 s).
  const fade = side(6, { e: [0.1, 0.1, 0.15, 0.2, 0.25, 0.3, 0.45, 0.55, 0.6, 0.6, 0.6, 0.6], l: [-40, -38, -36, -34, -30, -26, -20, -16, -14, -14, -14, -14], w: [0.15, 0.2, 0.25, 0.35, 0.42, 0.48, 0.55, 0.6, 0.6, 0.6] });
  assert.deepStrictEqual(skips(row({ d: 200, start: fade, end: side(0) }), 'auto'), [30, 0]);
  // No music: looked at as it is, whatever the mode.
  for (const m of FlowOrder.EDGE_MODES) assert.deepStrictEqual(skips(row({ d: 200, start: side(4), end: side(4) }, { has_music: 0 }), m), [0, 0], m);
});

test('Auto stops at 45 s; past that it must reach the body or nothing is skipped', () => {
  // 9 calm pieces (45 s) then the body: 45 s.
  assert.deepStrictEqual(skips(row({ d: 400, start: side(9), end: side(0) }), 'auto'), [45, 0]);
  // 11 calm pieces: capped at 45 s, where it is still calm: nothing.
  const long = side(11, { w: Array(10).fill(0.1) });
  assert.deepStrictEqual(skips(row({ d: 400, start: long, end: side(0) }), 'auto'), [0, 0]);
  // Silent pieces count as calm (null loudness).
  const silent = side(2, { l: [null, null, -14, -14, -14, -14, -14, -14, -14, -14, -14, -14] });
  assert.deepStrictEqual(skips(row({ d: 200, start: silent, end: side(0) }), 'auto'), [10, 0]);
});

test('15 s and 30 s: always that much, never more than a quarter of the file or past what was measured', () => {
  const r = row({ d: 200, start: side(0), end: side(0) });
  assert.deepStrictEqual(skips(r, '15'), [15, 15]);
  assert.deepStrictEqual(skips(r, '30'), [30, 30]);
  // 60 s long: a quarter is 15 s.
  assert.deepStrictEqual(skips(row({ d: 60, start: side(0), end: side(0) }), '30'), [15, 15]);
  // 42 s: a quarter is 10.5 s, so 10 s (whole pieces).
  assert.deepStrictEqual(skips(row({ d: 42, start: side(0), end: side(0) }), '15'), [10, 10]);
  // Only 3 measured afters (0, 5, 10 s): 10 s at most whatever the length.
  const few = { ...side(0), w: [0.6, 0.6, 0.6], b: [128, 128, 128] };
  assert.deepStrictEqual(skips(row({ d: 200, start: few, end: few }), '30'), [10, 10]);
  // Nothing measured after the skip (null): that edge is looked at as it is, never read as no energy.
  const holes = { ...side(0), w: [0.6, 0.6, 0.6, null, 0.6, 0.6, null, 0.6, 0.6, 0.6] };
  const fh = FlowOrder.fromRow(1, row({ d: 200, start: holes, end: side(0) }), '15');
  assert.deepStrictEqual(fh.skip, [0, 15]);
  assert.deepStrictEqual([fh.es, fh.ei, fh.bs], [0.2, 0.1, 90]);
  assert.deepStrictEqual(skips(row({ d: 200, start: holes, end: holes }), '30'), [0, 0]);
  // A fixed skip reads the energy after it, calm edge or not.
  const f = FlowOrder.fromRow(1, row({ d: 200, start: side(6), end: side(0) }), '15');
  assert.strictEqual(f.ei, side(6).w[3]);
});

test('Off, and rows without edge pieces (older versions), are exactly as before', () => {
  const r = row({ d: 200, start: side(4), end: side(6) });
  const before = FlowOrder.fromRow(1, r);
  assert.deepStrictEqual(FlowOrder.fromRow(1, r, 'off'), before);
  assert.strictEqual(before.skip, undefined);
  assert.deepStrictEqual([before.ei, before.eo, before.bs, before.be], [0.1, 0.1, 90, 90]);
  // A version 4 row (no edges column value): every mode is Off.
  const old = row(null, { version: 4 });
  for (const m of FlowOrder.EDGE_MODES) assert.deepStrictEqual(FlowOrder.fromRow(1, old, m), FlowOrder.fromRow(1, old), m);
  // Junk in the column, or an unknown mode: Off too.
  for (const junk of ['nope', '{"d":0,"start":{},"end":{}}', '{"d":100}', '[1,2]']) {
    assert.deepStrictEqual(FlowOrder.fromRow(1, { ...r, edges: junk }, 'auto'), before, junk);
  }
  assert.deepStrictEqual(FlowOrder.fromRow(1, r, 'sometimes'), before);
  // A failed row is not measured, whatever the mode.
  assert.strictEqual(FlowOrder.fromRow(1, { ...r, error: 'x' }, 'auto').measured, false);
});

test('hand-overs: a calm intro is a jump with Off, smooth with Auto; the order and the shuffle see the same', () => {
  const plain = row({ d: 200, start: side(0), end: side(0) }, { e_start: 0.6, e_end: 0.6, bpm_start: 128, bpm_end: 128,
    env: JSON.stringify([[0.1, 0.6], [0.5, 0.6], [0.9, 0.6]]) });
  const intro = row({ d: 200, start: side(4), end: side(0) }, { e_end: 0.6, bpm_end: 128,
    env: JSON.stringify([[0.05, 0.1], [0.5, 0.6], [0.95, 0.6]]) });
  const feats = (m) => [FlowOrder.fromRow(1, plain, m), FlowOrder.fromRow(2, intro, m)];
  const [a0, b0] = feats('off');
  assert.strictEqual(FlowOrder.grade(a0, b0), 'jump');
  const [a1, b1] = feats('auto');
  assert.strictEqual(FlowOrder.grade(a1, b1), 'smooth');
  assert.ok(FlowOrder.handoverCost(a1, b1) < FlowOrder.handoverCost(a0, b0));
  assert.strictEqual(FlowOrder.summary(feats('auto'), [1, 2]).jumps, 0);
  assert.strictEqual(FlowOrder.summary(feats('off'), [1, 2]).jumps, 1);
});

test('the analysis: edge pieces as stored (12 a side, 10 afters), short files fewer, under 20 s none', async () => {
  const sr = 22050;
  // A click track whose first 20 s are near silence: the whole file is decoded (90 s).
  const make = (seconds, quietTo) => {
    const n = Math.round(seconds * sr);
    const s = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const t = i / sr, ph = t % 0.5;
      const v = (t < quietTo ? 0.002 * Math.sin(2 * Math.PI * 220 * t) : 0.5 * Math.sin(2 * Math.PI * 70 * t) * Math.exp(-ph * 25));
      s[2 * i] = v; s[2 * i + 1] = v;
    }
    return s;
  };
  const run = (seconds, quietTo) => analyze.measureFile('x.mkv', {
    extract: async (f, o) => ({ samples: make(Math.min(seconds, o.duration), quietTo), sampleRate: sr, channels: 2, truePeakDb: -6 }),
    probe: async () => ({ channels: 2, layout: 'stereo', duration: seconds }),
  });
  const r = await run(90, 20);
  assert.strictEqual(r.edges.d, 90);
  assert.strictEqual(r.edges.start.l.length, 12);
  assert.strictEqual(r.edges.start.w.length, 10);
  assert.ok(r.edges.start.l.slice(0, 4).every(l => l == null || l < -40), 'the quiet pieces');
  assert.ok(r.edges.start.l.slice(4).every(l => l > -25), 'the beat');
  const enc = store.encodeEdges(r.edges);
  assert.ok(enc && enc.length < 700, `compact: ${enc && enc.length} bytes`);
  const f = FlowOrder.fromRow(1, { ...r, env: store.encodeEnv(r.env), edges: enc }, 'auto');
  assert.deepStrictEqual(f.skip, [20, 0]);
  // 40 s: 8 pieces a side, 6 afters; 15 s: none.
  const short = await run(40, 0);
  assert.strictEqual(short.edges.start.l.length, 8);
  assert.strictEqual(short.edges.start.w.length, 6);
  assert.strictEqual((await run(15, 0)).edges, null);
});

test('store: edges are kept compact, junk is NULL, an error clears them; a version 4 row is used until measured again', () => {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE media (id INTEGER PRIMARY KEY, media_type TEXT, user_trashed INTEGER DEFAULT 0, filesize_bytes INTEGER, file_mtime_ms INTEGER);
    CREATE TABLE media_flow (media_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, src TEXT, lufs REAL, peak_db REAL,
      has_music INTEGER NOT NULL DEFAULT 0, no_audio INTEGER NOT NULL DEFAULT 0, bpm_start REAL, bpm_mid REAL, bpm_end REAL,
      bpm_conf REAL, e_start REAL, e_mid REAL, e_end REAL, env TEXT, measured_at INTEGER, ms INTEGER, error TEXT, error_code TEXT);`);
  d.prepare("INSERT INTO media (id, media_type, filesize_bytes, file_mtime_ms) VALUES (1, 'video', 1, 1), (2, 'video', 1, 1)").run();
  d.prepare("INSERT INTO media_flow (media_id, version, src, lufs, has_music, e_start, e_mid, e_end, env) VALUES (2, 4, '1:1', -14, 1, 0.1, 0.6, 0.6, NULL)").run();
  store.ensureSchema(d);
  assert.ok(d.prepare('PRAGMA table_info(media_flow)').all().some(c => c.name === 'edges'), 'the column is added');
  const edges = { d: 200, start: side(4), end: side(0) };
  store.save(d, 1, '1:1', { lufs: -14, has_music: 1, e_mid: 0.6, edges });
  assert.deepStrictEqual(JSON.parse(d.prepare('SELECT edges FROM media_flow WHERE media_id = 1').get().edges), edges);
  for (const junk of [null, 'nope', { d: 200 }, { d: 200, start: side(), end: { l: [], e: [], w: [1], b: [] } }, { d: -1, start: side(), end: side() }, { d: 9, start: { ...side(), l: ['x'] }, end: side() }]) {
    store.save(d, 1, '1:1', { lufs: -14, edges: junk });
    assert.strictEqual(d.prepare('SELECT edges FROM media_flow WHERE media_id = 1').get().edges, null, JSON.stringify(junk));
  }
  store.save(d, 1, '1:1', { edges }, { error: 'gone' });
  assert.strictEqual(d.prepare('SELECT edges FROM media_flow WHERE media_id = 1').get().edges, null);
  // The version 4 row: used meanwhile (stale), as Off; measured again by the library pass.
  const old = store.get(d, 2);
  assert.strictEqual(old.stale, 1);
  assert.strictEqual(old.edges, null);
  assert.deepStrictEqual(FlowOrder.fromRow(2, old, 'auto'), FlowOrder.fromRow(2, old, 'off'));
  assert.ok(store.sweepBatch(d, 0).ids.includes(2));
});

test('the chart: ignored parts on the line\'s own stretched 0..1, none without a cut', () => {
  assert.strictEqual(FlowChartMath.ignoredSpan({ es: 0.1, em: 0.5, ee: 0.5 }), null);
  assert.strictEqual(FlowChartMath.ignoredSpan({ cut: [0, 0] }), null);
  // No envelope: start / middle / end at 0, 0.5, 1, so the cut is as it is.
  assert.deepStrictEqual(FlowChartMath.ignoredSpan({ cut: [0.1, 0.2] }), { a: 0.1, b: 0.8 });
  assert.deepStrictEqual(FlowChartMath.ignoredSpan({ cut: [0.1, 0] }), { a: 0.1, b: 1 });
  // An envelope from 0.05 to 0.95 is drawn stretched to 0..1: the cut is stretched with it.
  const env = [[0.05, 0.1], [0.5, 0.6], [0.95, 0.6]];
  const s = FlowChartMath.ignoredSpan({ env, cut: [0.14, 0.14] });
  assert.ok(Math.abs(s.a - 0.1) < 1e-9 && Math.abs(s.b - 0.9) < 1e-9, JSON.stringify(s));
  // A cut inside the first point's own half-slice: the band starts and ends at the line's start.
  assert.deepStrictEqual(FlowChartMath.ignoredSpan({ env, cut: [0.02, 0] }), { a: 0, b: 1 });
  // Never crossing: a short file whose cuts would overlap meet in the middle.
  const x = FlowChartMath.ignoredSpan({ cut: [0.6, 0.6] });
  assert.ok(x.a === x.b && x.a === 0.5);
  // What the server sends: fromRow's cut.
  const f = FlowOrder.fromRow(1, row({ d: 200, start: side(4), end: side(0) }), 'auto');
  const sp = FlowChartMath.ignoredSpan(f);
  assert.ok(sp.a > 0 && sp.b === 1);
});

test('the setting: Auto by default; off, 15 and 30 accepted, anything else refused', () => {
  assert.strictEqual(stageSettings.DEFAULTS.flowEdges, 'auto');
  assert.deepStrictEqual(stageSettings.FLOW_EDGES, FlowOrder.EDGE_MODES);
  for (const v of ['off', '15', '30', 'auto']) assert.strictEqual(stageSettings.validatePatch({ flowEdges: v }, {}).settings.flowEdges, v);
  for (const v of ['45', 15, 'never', null]) assert.strictEqual(stageSettings.validatePatch({ flowEdges: v }, {}).ok, false, String(v));
  assert.strictEqual(stageSettings.normalize({ flowEdges: 'x' }, { flowEdges: '30' }).flowEdges, '30');
});

const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
const opt = { skip: ff.status === 0 ? false : 'ffmpeg is not installed' };

test('a real file with a quiet 20 s intro: Auto looks past 20 s, a plain one is untouched', opt, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-flow-edges-'));
  try {
    const beat = '0.6*(0.9*sin(2*PI*70*t)*exp(-mod(t\\,0.46875)*25)+0.35*sin(2*PI*1800*t)*exp(-mod(t\\,0.46875)*180)+0.12*sin(2*PI*220*t))';
    const pad = '0.02*sin(2*PI*220*t)';
    const make = (name, expr) => {
      const out = path.join(tmp, name);
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${expr}:s=44100:d=90`, '-c:a', 'aac', '-b:a', '128k', '-ac', '2', out], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(r.stderr);
      return out;
    };
    const toRow = (r) => ({ ...r, env: store.encodeEnv(r.env), edges: store.encodeEdges(r.edges) });
    const intro = toRow(await analyze.measureFile(make('intro.m4a', `if(lt(t\\,20)\\,${pad}\\,${beat})`)));
    const plain = toRow(await analyze.measureFile(make('plain.m4a', beat)));
    assert.deepStrictEqual(FlowOrder.fromRow(1, intro, 'auto').skip, [20, 0]);
    assert.strictEqual(FlowOrder.fromRow(2, plain, 'auto').skip, undefined);
    const g = (m) => FlowOrder.grade(FlowOrder.fromRow(2, plain, m), FlowOrder.fromRow(1, intro, m));
    assert.strictEqual(g('off'), 'jump');
    assert.strictEqual(g('auto'), 'smooth');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
