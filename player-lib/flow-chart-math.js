/* =========================================================================
   FLOW CHART MATHS - the pure part of the Flow chart (player-lib/flow.js),
   shared with the tests (test/flow-chart-math.test.js). No DOM.

   - yRange(values, o)       the chart's height range: the list's own min..max
                             padded about 12 %, at least 0.2 wide, inside 0..1
   - filePoints(f)           the points a file's line goes through, [[t, e]],
                             t stretched to 0..1: its envelope (about 10
                             points, smoothed for display) or, without one,
                             start / middle / end
   - ignoredSpan(f)          where Flow looks past a calm intro or credits
                             (f.cut, player-lib/flow-order.js), on filePoints'
                             stretched 0..1: { a, b } (ignored before a and
                             after b), or null when nothing is
   - smoothed(es)            0.25 / 0.5 / 0.25 over the inside values, once
                             (one dipping slice is not drawn as a needle);
                             the ends are kept, so hand-overs still meet them
   - monotonePath(pts, o)    an SVG path through [[x, y], ...]: a monotone
                             cubic (Fritsch-Carlson), so it never overshoots
                             between points (no bumps the music does not have)
   - monotoneAt(pts, x)      the y of that same curve at x (the Flow chart's playhead)
   - linearAt(pts, x)        the y of straight lines through pts, or null (nothing drawn)
   - tempoShare(bpm)         a BPM as 0..1 for the Tempo lane's colour
   - clampChartHeight(px)    the plot height the resize grip asks for, kept
                             inside CHART_H_MIN..CHART_H_MAX (null: junk)
   - sparkPath(values, w, h) a small path through one value a file (null =
                             not drawn), at most about 60 points, zoomed to
                             the values' own range: the order bar's sparkline
   - dragPassed(dx, dy)      has a press moved far enough to be a drag of a
                             column (DRAG_THRESHOLD px), not a click
   - dragSlot(x, g)          the gap a dragged column lands in, 0..n (0:
                             before the first column, n: after the last),
                             from the pointer's x and the chart's L / step / n
   - dragTarget(order, from, slot)  what dropping the file at index from
                             into that gap does: { to, before } (its new
                             index, and the id it goes in front of, null for
                             the end, as reorderMove takes it), or null when
                             it lands where it is
   - movedOrder(order, from, to)  the order with that file moved (the preview)

   Full screen (flow.js "Full screen"):
   - fsLayout(wrapW, n, L, R, zoom)  the chart's width and column step: Fit
                             puts the whole list in the width, Zoom gives each
                             file at least FS_COL_PX and scrolls sideways
   - fsChartHeight(vh)       the plot's height for a window vh tall: about a
                             third of it, FS_CHART_MIN..FS_CHART_MAX (a tall
                             window no longer stretches the curve)
   - fsCardHeight(step)      the preview cards row's height (16:9 in a column,
                             at most FS_CARD_MAX_W wide); fsCardWidth(step, h)
                             a card's width (in a shrunk row, 16:9 of its height)
   - fsCardsFit(ph)          does the plot keep FS_PLOT_MIN with the cards row?
                             (a short view drops the row first)
   - fsPlotHeight(wrapH, o)  what the view has left for the plot after the
                             lane rows, the names and the cards
   - fsRows(wrapH, vh, o)    full screen's rows from all of that: the plot's
                             height, readable tag rows and preview cards when
                             a column is FS_CARD_PX or wider (narrower: the
                             colour bars and no cards), smaller cards or none
                             in a short view
   - cardScrub(x, w, d)      the pointer x px across a card w wide: how far
                             across (0..1), and the frame and time there (frameAt)
   - inkOn(hex)              text colour for a tag's label on its own colour
   - chartHit(x, y, g)       what is under a point of the chart: a hand-over
                             (near the line between two columns, in the plot)
                             { kind: 'hand', i } (file i into i + 1), or a
                             column { kind: 'col', i, frac } (frac: 0..1 across
                             the file's own line, so it lines up with it)
   - frameAt(frac, duration) the time under the pointer and the nearest of a
                             file's five hover frames (as the seek bars pick
                             them, DockGeom.scrubFrameIndex)
   - followScroll(x0, x1, left, viewW)  the scroll that brings the column x0..x1
                             back into view (centred), or null when it is in view
   - scrollStep(left, speed, dtMs, max)  the next scroll while a drag sits near
                             an edge (speed from DragAutoScroll.speed)
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

  /** Display only: each inside value 0.25 / 0.5 / 0.25 with its neighbours, once; the ends kept. */
  function smoothed(es) {
    return es.map((e, i) => (i === 0 || i === es.length - 1 ? e : 0.25 * es[i - 1] + 0.5 * e + 0.25 * es[i + 1]));
  }

  /** The points of a file's line: [[t 0..1, e], ...], at least 2 (an envelope smoothed for display). */
  function filePoints(f) {
    const env = f && Array.isArray(f.env) && f.env.length >= 2 ? f.env : null;
    if (!env) return [[0, f.es], [0.5, f.em], [1, f.ee]];
    const es = smoothed(env.map(p => p[1]));
    const t0 = env[0][0], t1 = env[env.length - 1][0];
    const span = t1 - t0;
    if (!(span > 0)) return env.map((p, k) => [k / (env.length - 1), es[k]]);
    return env.map((p, k) => [(p[0] - t0) / span, es[k]]);
  }

  /**
   * The ignored parts of a file's line, on the same 0..1 as filePoints (so a
   * band ends where the line passes the cut): { a, b }, or null when the
   * file has no cut. a <= b always (a short file's bands never cross).
   */
  function ignoredSpan(f) {
    const c = f && Array.isArray(f.cut) ? f.cut : null;
    if (!c || !(c[0] > 0 || c[1] > 0)) return null;
    const env = Array.isArray(f.env) && f.env.length >= 2 ? f.env : null;
    const t0 = env ? env[0][0] : 0, t1 = env ? env[env.length - 1][0] : 1;
    const span = t1 - t0;
    const at = (t) => (span > 0 ? clamp01((t - t0) / span) : t);
    const a = c[0] > 0 ? at(clamp01(c[0])) : 0;
    const b = c[1] > 0 ? at(1 - clamp01(c[1])) : 1;
    return b >= a ? { a, b } : { a: (a + b) / 2, b: (a + b) / 2 };
  }

  const fx = (v) => (Math.round(v * 10) / 10).toString();

  /**
   * A monotone cubic through the points (x increasing).
   * @param {number[][]} pts  [[x, y], ...]
   * @param {{move?: boolean}} [o]  move: false continues a path (no M)
   * @returns {string}
   */
  /** Fritsch-Carlson tangents for the points (x increasing): the curve's slope at each one. */
  function slopes(pts) {
    const n = pts.length;
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
    return { dx, m };
  }

  function monotonePath(pts, { move = true } = {}) {
    const n = pts.length;
    if (!n) return '';
    let d = move ? `M${fx(pts[0][0])},${fx(pts[0][1])}` : `L${fx(pts[0][0])},${fx(pts[0][1])}`;
    if (n === 1) return d;
    const { dx, m } = slopes(pts);
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += ` C${fx(pts[i][0] + h)},${fx(pts[i][1] + m[i] * h)} ${fx(pts[i + 1][0] - h)},${fx(pts[i + 1][1] - m[i + 1] * h)} ${fx(pts[i + 1][0])},${fx(pts[i + 1][1])}`;
    }
    return d;
  }

  /**
   * The y of monotonePath's curve at x (the same cubic: Bezier handles at a
   * third of each step are the Hermite form of these tangents). Outside the
   * points: the nearest end. sl: slopes(pts), when the caller keeps it.
   */
  function monotoneAt(pts, x, sl = null) {
    const n = pts.length;
    if (!n) return NaN;
    if (n === 1 || x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    const { dx, m } = sl || slopes(pts);
    let i = 0;
    while (i < n - 2 && x > pts[i + 1][0]) i++;
    const h = dx[i];
    if (!h) return pts[i][1];
    const t = (x - pts[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * pts[i][1] + (t3 - 2 * t2 + t) * h * m[i]
      + (-2 * t3 + 3 * t2) * pts[i + 1][1] + (t3 - t2) * h * m[i + 1];
  }

  /**
   * The y of straight lines through pts at x (the dense chart's one simplified
   * path), or null where nothing is drawn: outside the points, or a lone
   * point (a path of one point draws nothing).
   */
  function linearAt(pts, x) {
    if (!pts || pts.length < 2) return null;
    if (x < pts[0][0] || x > pts[pts.length - 1][0]) return null;
    let i = 0;
    while (i < pts.length - 2 && x > pts[i + 1][0]) i++;
    const [xa, ya] = pts[i], [xb, yb] = pts[i + 1];
    return xb === xa ? ya : ya + (yb - ya) * (x - xa) / (xb - xa);
  }

  /** 70 BPM (calm) .. 170 BPM (fast) as 0..1. */
  const tempoShare = (bpm) => clamp01((bpm - 70) / 100);

  const CHART_H_MIN = 70;
  const CHART_H_MAX = 360;
  function clampChartHeight(px) {
    const v = Number(px);
    if (px == null || (typeof px === 'string' && !px.trim()) || !Number.isFinite(v)) return null;
    return Math.round(Math.max(CHART_H_MIN, Math.min(CHART_H_MAX, v)));
  }

  function sparkPath(values, w, h, { maxPts = 60, pad = 2 } = {}) {
    const vals = [];
    (values || []).forEach((v, i) => { if (v != null && Number.isFinite(v)) vals.push([i, v]); });
    if (vals.length < 2 || !(w > 0) || !(h > 0)) return '';
    const n = values.length;
    // Long lists: the mean of each run of files, so the path stays small.
    const per = Math.max(1, Math.ceil(vals.length / maxPts));
    const pts = [];
    for (let k = 0; k < vals.length; k += per) {
      const run = vals.slice(k, k + per);
      pts.push([run.reduce((a, r) => a + r[0], 0) / run.length, run.reduce((a, r) => a + r[1], 0) / run.length]);
    }
    if (pts.length < 2) return '';
    const { lo, hi } = yRange(pts.map(p => p[1]));
    const x = (i) => (n > 1 ? (i / (n - 1)) * w : 0);
    const y = (v) => pad + (1 - (v - lo) / (hi - lo)) * (h - 2 * pad);
    return monotonePath(pts.map(([i, v]) => [x(i), y(v)]));
  }

  /* ── Dragging a column to move its file (flow.js) ───────────────────── */

  const DRAG_THRESHOLD = 5;
  const dragPassed = (dx, dy, threshold = DRAG_THRESHOLD) => Math.hypot(dx || 0, dy || 0) >= threshold;

  function dragSlot(x, { L, step, n }) {
    if (!(n > 0) || !(step > 0) || !Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(n, Math.round((x - L) / step)));
  }

  function dragTarget(order, from, slot) {
    const n = order.length;
    if (!(from >= 0 && from < n)) return null;
    const s = Math.max(0, Math.min(n, slot));
    // The gaps either side of the file itself: it stays where it is.
    if (s === from || s === from + 1) return null;
    // Moving right, the file leaves a gap behind it: one place less.
    const to = s > from ? s - 1 : s;
    return { to, before: s < n ? order[s] : null };
  }

  function movedOrder(order, from, to) {
    const out = order.slice();
    const [id] = out.splice(from, 1);
    out.splice(to, 0, id);
    return out;
  }

  /* ── Full screen (flow.js) ───────────────────────────────────────── */

  const FS_COL_PX = 140;
  const FS_NAMES_H = 24;       // the names row and its margin
  const FS_PH_MIN = 80;

  function fsLayout(wrapW, n, L, R, zoom, colPx = FS_COL_PX) {
    const W0 = Math.max(200, Math.floor(Number(wrapW) || 0));
    const cols = Math.max(1, n || 0);
    const fit = (W0 - L - R) / cols;
    if (!zoom || fit >= colPx) return { W: W0, step: fit };
    return { W: Math.ceil(L + R + cols * colPx), step: colPx };
  }

  /** The plot's height the cards row must leave (else the row is dropped). */
  const FS_PLOT_MIN = 140;
  const fsCardsFit = (plotWithCards) => plotWithCards >= FS_PLOT_MIN;

  /* About a third of the window, kept between FS_CHART_MIN and FS_CHART_MAX. */
  const FS_CHART_SHARE = 0.34;
  const FS_CHART_MIN = 140;
  const FS_CHART_MAX = 260;
  function fsChartHeight(vh) {
    const v = Number(vh) > 0 ? Number(vh) * FS_CHART_SHARE : 0;
    return Math.round(Math.max(FS_CHART_MIN, Math.min(FS_CHART_MAX, v)));
  }

  /* A column this wide or wider gets readable tags and a preview card. */
  const FS_CARD_PX = 70;
  const FS_CARD_MAX_W = 240;
  const FS_TAG_ROW = 24;
  const FS_CARD_MIN_H = 44;    // the least a cards row shrinks to (a 36 px picture) before it goes
  /** A card's width in a column step px wide; with the row's height h, no wider than 16:9 of it. */
  function fsCardWidth(step, h = 0) {
    const w = Math.max(24, Math.min(FS_CARD_MAX_W, step - 8));
    return h > 8 ? Math.min(w, Math.round((h - 8) * 16 / 9)) : w;
  }
  const fsCardHeight = (step) => Math.round(fsCardWidth(step) * 9 / 16) + 8;

  /** o: { top, lanes (rows), laneRow (px a row), names (px), thumbs (px), bar (a sideways scrollbar, px) } */
  function fsPlotHeight(wrapH, { top = 16, lanes = 0, laneRow = 14, names = FS_NAMES_H, thumbs = 0, bar = 0 } = {}) {
    const h = Math.floor(Number(wrapH) || 0) - top - 10 - lanes * laneRow - names - thumbs - bar - 4;
    return Math.max(FS_PH_MIN, h);
  }

  /**
   * o: { step, lanes (rows), cards (thumbnails can show), bar (px), top }.
   * Returns { PH, rich, cardsOn, laneRow, cardH }: rich (FS_CARD_PX a column
   * or more) draws tags as text, a row FS_TAG_ROW tall. A short view takes
   * from the cards first: smaller cards (the plot at FS_PLOT_MIN), down to
   * FS_CARD_MIN_H, then none. The plot is never over fsChartHeight(vh).
   */
  function fsRows(wrapH, vh, { step = 0, lanes = 0, cards = true, bar = 0, top = 16 } = {}) {
    const rich = step >= FS_CARD_PX;
    const laneRow = rich ? FS_TAG_ROW : 14;
    const cap = fsChartHeight(vh);
    const want = rich && cards ? fsCardHeight(step) : 0;
    const room = (c) => fsPlotHeight(wrapH, { top, lanes, laneRow, thumbs: c, bar });
    let cardH = 0;
    if (want > 0) {
      if (fsCardsFit(Math.min(cap, room(want)))) cardH = want;
      else {
        const fit = room(0) - FS_PLOT_MIN;     // what the cards can have with the plot at its least
        if (fit >= FS_CARD_MIN_H) cardH = Math.min(want, fit);
      }
    }
    return { PH: Math.min(cap, room(cardH)), rich, cardsOn: cardH > 0, laneRow, cardH };
  }

  /** The pointer x px across a card w px wide (a file d s long): { frac, t, idx }. */
  function cardScrub(x, w, d) {
    const frac = w > 0 && Number.isFinite(x) ? clamp01(x / w) : 0;
    return { frac, ...frameAt(frac, d) };
  }

  /** Dark text on a light tag colour, light text on a dark one (#rgb or #rrggbb). */
  function inkOn(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.replace(/./g, c => c + c);
    if (!/^[0-9a-f]{6}$/i.test(h)) return '#fff';
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 >= 140 ? '#111' : '#fff';
  }

  function chartHit(x, y, g, handPx = 8) {
    if (!g || !(g.n > 0) || !(g.step > 0) || !Number.isFinite(x)) return null;
    if (x < g.L || x >= g.W - g.R) return null;
    const pos = (x - g.L) / g.step;
    const i = Math.max(0, Math.min(g.n - 1, Math.floor(pos)));
    const b = Math.round(pos);
    const tol = Math.min(handPx, g.step * 0.2);
    const inPlot = Number.isFinite(y) && y >= g.TOP && y <= g.TOP + g.PH;
    if (!g.dense && inPlot && b > 0 && b < g.n && Math.abs(x - (g.L + b * g.step)) <= tol) return { kind: 'hand', i: b - 1 };
    const gap = g.gap || 0;
    const x0 = g.L + i * g.step + gap, x1 = g.L + (i + 1) * g.step - gap;
    const frac = x1 > x0 ? clamp01((x - x0) / (x1 - x0)) : 0.5;
    return { kind: 'col', i, frac };
  }

  function frameAt(frac, duration, count = 5) {
    const f = clamp01(Number(frac) || 0);
    const d = Number(duration) > 0 ? Number(duration) : 0;
    const idx = Math.max(0, Math.min(count - 1, Math.round(f * (count + 1)) - 1));
    return { t: f * d, idx };
  }

  function followScroll(x0, x1, left, viewW, margin = 40) {
    if (!(viewW > 0)) return null;
    const m = Math.min(margin, Math.max(0, (viewW - (x1 - x0)) / 2));
    if (x0 >= left + m && x1 <= left + viewW - m) return null;
    return Math.max(0, Math.round((x0 + x1) / 2 - viewW / 2));
  }

  function scrollStep(left, speed, dtMs, max) {
    const dt = Math.max(0, Math.min(50, Number(dtMs) || 0));
    const next = (Number(left) || 0) + (Number(speed) || 0) * dt / 1000;
    return Math.max(0, Math.min(Math.max(0, max), next));
  }

  return { FS_COL_PX, FS_NAMES_H, FS_PLOT_MIN, fsCardsFit, fsLayout, fsCardHeight, fsCardWidth, fsPlotHeight,
    FS_CHART_MIN, FS_CHART_MAX, fsChartHeight, FS_CARD_PX, FS_CARD_MAX_W, FS_CARD_MIN_H, FS_TAG_ROW, fsRows, cardScrub, inkOn, chartHit, frameAt, followScroll, scrollStep,
    DRAG_THRESHOLD, dragPassed, dragSlot, dragTarget, movedOrder, yRange, filePoints, ignoredSpan, smoothed, slopes, monotonePath, monotoneAt, linearAt, tempoShare,
    CHART_H_MIN, CHART_H_MAX, clampChartHeight, sparkPath };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FlowChartMath;
if (typeof window !== 'undefined') window.FlowChartMath = FlowChartMath;
