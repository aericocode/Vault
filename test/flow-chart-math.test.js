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
  assert.deepStrictEqual(p.map(x => x[1]), [0.4, 0.6, 0.5]);
  // All at one t (should not happen): spread evenly rather than divide by zero.
  assert.deepStrictEqual(M.filePoints({ env: [[0.5, 0.1], [0.5, 0.2]] }), [[0, 0.1], [1, 0.2]]);
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

test('tempoShare: 70 BPM calm .. 170 fast, clamped', () => {
  assert.strictEqual(M.tempoShare(70), 0);
  assert.strictEqual(M.tempoShare(120), 0.5);
  assert.strictEqual(M.tempoShare(200), 1);
  assert.strictEqual(M.tempoShare(40), 0);
});
