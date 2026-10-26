/* =========================================================================
   FLOW CHART MATHS - the pure part of the Flow chart (player-lib/flow.js),
   shared with the tests (test/flow-chart-math.test.js). No DOM.

   - yRange(values, o)       the chart's height range: the list's own min..max
                             padded about 12 %, at least 0.2 wide, inside 0..1
   - filePoints(f)           the points a file's line goes through, [[t, e]],
                             t stretched to 0..1: its envelope (about 10
                             points) or, without one, start / middle / end
   - monotonePath(pts, o)    an SVG path through [[x, y], ...]: a monotone
                             cubic (Fritsch-Carlson), so it never overshoots
                             between points (no bumps the music does not have)
   - tempoShare(bpm)         a BPM as 0..1 for the Tempo lane's colour
   ========================================================================= */

const FlowChartMath = (() => {
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /**
   * @param {number[]} values  energies drawn (and the shape's targets)
   * @param {{pad?: number, minSpan?: number}} [o]
   * @returns {{lo: number, hi: number}}
   */
  function yRange(values, { pad = 0.12, minSpan = 0.2 } = {}) {
    let lo = Infinity, hi = -Infinity;
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (lo === Infinity) return { lo: 0, hi: 1 };
    const p = Math.max(0.02, (hi - lo) * pad);
    lo = Math.max(0, lo - p);
    hi = Math.min(1, hi + p);
    if (hi - lo < minSpan) {
      const m = (hi + lo) / 2;
      lo = Math.max(0, Math.min(1 - minSpan, m - minSpan / 2));
      hi = lo + minSpan;
    }
    return { lo, hi };
  }

  /** The points of a file's line: [[t 0..1, e], ...], at least 2. */
  function filePoints(f) {
    const env = f && Array.isArray(f.env) && f.env.length >= 2 ? f.env : null;
    if (!env) return [[0, f.es], [0.5, f.em], [1, f.ee]];
    const t0 = env[0][0], t1 = env[env.length - 1][0];
    const span = t1 - t0;
    if (!(span > 0)) return env.map((p, k) => [k / (env.length - 1), p[1]]);
    return env.map(p => [(p[0] - t0) / span, p[1]]);
  }

  const fx = (v) => (Math.round(v * 10) / 10).toString();

  /**
   * A monotone cubic through the points (x increasing).
   * @param {number[][]} pts  [[x, y], ...]
   * @param {{move?: boolean}} [o]  move: false continues a path (no M)
   * @returns {string}
   */
  function monotonePath(pts, { move = true } = {}) {
    const n = pts.length;
    if (!n) return '';
    let d = move ? `M${fx(pts[0][0])},${fx(pts[0][1])}` : `L${fx(pts[0][0])},${fx(pts[0][1])}`;
    if (n === 1) return d;
    const dx = [], s = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) {
      dx.push(pts[i + 1][0] - pts[i][0]);
      s.push(dx[i] ? (pts[i + 1][1] - pts[i][1]) / dx[i] : 0);
    }
    m[0] = s[0];
    m[n - 1] = s[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (s[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / s[i], b = m[i + 1] / s[i], q = a * a + b * b;
      if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * s[i]; m[i + 1] = t * b * s[i]; }
    }
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${fx(pts[i][0] + h)},${fx(pts[i][1] + m[i] * h)} ${fx(pts[i + 1][0] - h)},${fx(pts[i + 1][1] - m[i + 1] * h)} ${fx(pts[i + 1][0])},${fx(pts[i + 1][1])}`;
    }
    return d;
  }

  /** 70 BPM (calm) .. 170 BPM (fast) as 0..1. */
  const tempoShare = (bpm) => clamp01((bpm - 70) / 100);

  return { yRange, filePoints, monotonePath, tempoShare };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FlowChartMath;
if (typeof window !== 'undefined') window.FlowChartMath = FlowChartMath;
