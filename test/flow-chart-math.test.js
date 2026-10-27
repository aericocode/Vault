/**
 * The Flow chart's pure maths (player-lib/flow-chart-math.js): the zoomed
 * height range, a file's points (its envelope or start / middle / end), the
 * monotone curve (never overshoots between points), the Tempo lane's scale.
 */

const test = require('node:test');
const assert = require('node:assert');
const M = require('../player-lib/flow-chart-math.js');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('yRange: the list\'s own range padded about 12 %, at least 0.2 wide, inside 0..1', () => {
  let r = M.yRange([0.7, 0.9, 0.8]);
  assert.ok(near(r.lo, 0.7 - 0.024) && near(r.hi, 0.9 + 0.024), JSON.stringify(r));
  // A tight list still gets 0.2, centred.
  r = M.yRange([0.78, 0.8]);
  assert.ok(near(r.hi - r.lo, 0.2) && near((r.lo + r.hi) / 2, 0.79), JSON.stringify(r));
  // Near the top or bottom: clamped, still 0.2 wide.
  r = M.yRange([0.97, 0.99]);
  assert.ok(near(r.hi, 1) && near(r.lo, 0.8), JSON.stringify(r));
  r = M.yRange([0, 0.02]);
  assert.ok(near(r.lo, 0) && near(r.hi, 0.2), JSON.stringify(r));
  // Wide lists clamp to 0..1.
  r = M.yRange([0.01, 0.99]);
  assert.deepStrictEqual(r, { lo: 0, hi: 1 });
  // Nothing to draw (or only junk): the full scale.
  assert.deepStrictEqual(M.yRange([]), { lo: 0, hi: 1 });
  assert.deepStrictEqual(M.yRange([NaN, null, undefined]), { lo: 0, hi: 1 });
});

test('filePoints: the envelope stretched to the column, or start / middle / end without one', () => {
  assert.deepStrictEqual(M.filePoints({ es: 0.1, em: 0.2, ee: 0.3 }), [[0, 0.1], [0.5, 0.2], [1, 0.3]]);
  assert.deepStrictEqual(M.filePoints({ es: 0.1, em: 0.2, ee: 0.3, env: [[0.1, 0.5]] }), [[0, 0.1], [0.5, 0.2], [1, 0.3]]);
  const p = M.filePoints({ es: 0, em: 0, ee: 0, env: [[0.05, 0.4], [0.5, 0.6], [0.95, 0.5]] });
  assert.ok(near(p[0][0], 0) && near(p[1][0], 0.5) && near(p[2][0], 1));
  // Smoothed for display: the ends kept, the inside 0.25 / 0.5 / 0.25.
  assert.ok(near(p[0][1], 0.4) && near(p[1][1], 0.525) && near(p[2][1], 0.5), JSON.stringify(p));
  // All at one t (should not happen): spread evenly rather than divide by zero.
  assert.deepStrictEqual(M.filePoints({ env: [[0.5, 0.1], [0.5, 0.2]] }), [[0, 0.1], [1, 0.2]]);
  // The data is untouched.
  const env = [[0.1, 0.8], [0.5, 0.2], [0.9, 0.8]];
  M.filePoints({ env });
  assert.deepStrictEqual(env, [[0.1, 0.8], [0.5, 0.2], [0.9, 0.8]]);
});

test('smoothed: one pass of 0.25 / 0.5 / 0.25 inside, ends kept; a lone dip is softened, not moved', () => {
  const s = M.smoothed([0.8, 0.8, 0.4, 0.8, 0.8]);
  assert.ok(near(s[0], 0.8) && near(s[4], 0.8));
  assert.ok(near(s[1], 0.7) && near(s[2], 0.6) && near(s[3], 0.7), JSON.stringify(s));
  // Stays within the data's range (an average never overshoots).
  const data = [0.2, 0.9, 0.1, 0.95, 0.3, 0.6];
  for (const v of M.smoothed(data)) assert.ok(v >= 0.1 && v <= 0.95);
  assert.deepStrictEqual(M.smoothed([0.3, 0.7]), [0.3, 0.7]);
  assert.deepStrictEqual(M.smoothed([]), []);
});

/** Points along a cubic Bezier path made of "M x,y C ..." segments. */
function sample(d) {
  const nums = d.match(/-?[\d.]+/g).map(Number);
  let [x, y] = nums.slice(0, 2);
  const out = [[x, y]];
  for (let i = 2; i + 5 < nums.length + 1; i += 6) {
    const [x1, y1, x2, y2, x3, y3] = nums.slice(i, i + 6);
    for (let k = 1; k <= 20; k++) {
      const t = k / 20, u = 1 - t;
      out.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
        u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
    }
    x = x3; y = y3;
  }
  return out;
}

test('monotonePath: through every point, never past the points either side of a segment', () => {
  const pts = [[0, 50], [10, 10], [20, 12], [30, 80], [40, 80], [50, 0]];
  const d = M.monotonePath(pts);
  assert.match(d, /^M0,50 C/);
  assert.strictEqual((d.match(/C/g) || []).length, pts.length - 1);
  const s = sample(d);
  for (let i = 0; i < pts.length - 1; i++) {
    const lo = Math.min(pts[i][1], pts[i + 1][1]) - 0.11, hi = Math.max(pts[i][1], pts[i + 1][1]) + 0.11;
    for (const [x, y] of s) if (x >= pts[i][0] && x <= pts[i + 1][0]) assert.ok(y >= lo && y <= hi, `segment ${i}: y ${y} outside ${lo}..${hi} at x ${x}`);
  }
  for (const [x, y] of pts) assert.ok(s.some(p => near(p[0], x, 0.06) && near(p[1], y, 0.06)), `passes ${x},${y}`);
  // A flat stretch stays flat; one point is just a move; none is nothing.
  const flat = sample(M.monotonePath([[0, 5], [10, 5], [20, 5]]));
  assert.ok(flat.every(p => near(p[1], 5, 1e-6)));
  assert.strictEqual(M.monotonePath([[3, 4]]), 'M3,4');
  assert.strictEqual(M.monotonePath([]), '');
  assert.match(M.monotonePath([[1, 1], [2, 2]], { move: false }), /^L1,1 C/);
});

test('monotoneAt: the y of the very curve monotonePath draws (the playhead rides it)', () => {
  const pts = [[0, 50], [10, 10], [20, 12], [30, 80], [40, 80], [50, 0]];
  // Points along the drawn Bezier path, against monotoneAt at their x.
  const nums = M.monotonePath(pts).match(/-?[\d.]+/g).map(Number);
  let [x, y] = nums.slice(0, 2);
  for (let i = 2; i + 6 <= nums.length; i += 6) {
    const [x1, y1, x2, y2, x3, y3] = nums.slice(i, i + 6);
    for (let k = 0; k <= 10; k++) {
      const t = k / 10, u = 1 - t;
      const bx = u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
      const by = u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
      assert.ok(Math.abs(M.monotoneAt(pts, bx) - by) < 0.15, `at x ${bx}: ${M.monotoneAt(pts, bx)} vs drawn ${by}`);
    }
    x = x3; y = y3;
  }
  // Through every point; the ends outside; a flat stretch stays flat; with kept slopes the same.
  for (const [px, py] of pts) assert.ok(Math.abs(M.monotoneAt(pts, px) - py) < 1e-9);
  assert.strictEqual(M.monotoneAt(pts, -5), 50);
  assert.strictEqual(M.monotoneAt(pts, 99), 0);
  assert.strictEqual(M.monotoneAt([[0, 5], [10, 5], [20, 5]], 13), 5);
  assert.strictEqual(M.monotoneAt(pts, 23, M.slopes(pts)), M.monotoneAt(pts, 23));
  assert.ok(Number.isNaN(M.monotoneAt([], 1)));
});

test('tempoShare: 70 BPM calm .. 170 fast, clamped', () => {
  assert.strictEqual(M.tempoShare(70), 0);
  assert.strictEqual(M.tempoShare(120), 0.5);
  assert.strictEqual(M.tempoShare(200), 1);
  assert.strictEqual(M.tempoShare(40), 0);
});

test('linearAt: the dense chart\'s straight lines; nothing where nothing is drawn', () => {
  const pts = [[10, 100], [20, 50], [30, 70]];
  assert.strictEqual(M.linearAt(pts, 10), 100);
  assert.strictEqual(M.linearAt(pts, 15), 75);
  assert.strictEqual(M.linearAt(pts, 25), 60);
  assert.strictEqual(M.linearAt(pts, 30), 70);
  assert.strictEqual(M.linearAt(pts, 5), null, 'before the first point');
  assert.strictEqual(M.linearAt(pts, 31), null, 'after the last');
  // A lone music file between files with no music draws nothing: no y.
  assert.strictEqual(M.linearAt([[10, 40]], 10), null);
  assert.strictEqual(M.linearAt([], 1), null);
  assert.strictEqual(M.linearAt(null, 1), null);
});

test('clampChartHeight: the grip keeps the plot inside 70..360 px, junk is null', () => {
  assert.strictEqual(M.CHART_H_MIN, 70);
  assert.strictEqual(M.CHART_H_MAX, 360);
  assert.strictEqual(M.clampChartHeight(150), 150);
  assert.strictEqual(M.clampChartHeight(149.6), 150);
  assert.strictEqual(M.clampChartHeight(10), 70);
  assert.strictEqual(M.clampChartHeight(-50), 70);
  assert.strictEqual(M.clampChartHeight(9999), 360);
  assert.strictEqual(M.clampChartHeight('200'), 200, 'as read back from localStorage');
  for (const junk of [null, undefined, '', 'tall', NaN, Infinity]) assert.strictEqual(M.clampChartHeight(junk), null, String(junk));
});

test('sparkPath: a path across the whole width, inside the height, nulls skipped', () => {
  const nums = (d) => (d.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  const d = M.sparkPath([0.2, 0.8, null, 0.5, 0.3], 300, 24);
  assert.match(d, /^M0,/);
  const xs = nums(d).filter((_, i) => i % 2 === 0), ys = nums(d).filter((_, i) => i % 2 === 1);
  assert.ok(Math.max(...xs) <= 300 + 1e-9 && Math.min(...xs) >= -1e-9, 'inside the width');
  assert.ok(/ 300,[\d.]+$/.test(d), 'ends at the right edge');
  for (const y of ys) assert.ok(y >= 0 && y <= 24, `y ${y} inside the height`);
  // The highest energy is drawn highest (smallest y).
  const p0 = nums(d).slice(0, 2);
  assert.ok(p0[1] > 2, 'the low first file is not at the top');
  // Too little to draw.
  assert.strictEqual(M.sparkPath([0.5], 300, 24), '');
  assert.strictEqual(M.sparkPath([null, 0.5, null], 300, 24), '');
  assert.strictEqual(M.sparkPath([], 300, 24), '');
  assert.strictEqual(M.sparkPath(null, 300, 24), '');
  assert.strictEqual(M.sparkPath([0.1, 0.9], 0, 24), '');
});

test('sparkPath: thousands of files stay a small path', () => {
  const vals = Array.from({ length: 5000 }, (_, i) => 0.5 + 0.4 * Math.sin(i / 300));
  const d = M.sparkPath(vals, 300, 24);
  const segs = (d.match(/C/g) || []).length;
  assert.ok(segs > 10 && segs <= 60, `${segs} curve segments`);
});
