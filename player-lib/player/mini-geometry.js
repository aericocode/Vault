/* =========================================================================
   MINI PLAYER GEOMETRY - where the floating mini player sits and how big.

   Pure functions, no DOM: player-lib/player/mini-player.js measures the page
   and hands the numbers in. The box always rests in one of the four corners
   of the window, so what is remembered is just the corner and the width; the
   height follows from the picture's shape.

   - geomFrom(raw)                        a saved {corner, w} made safe
   - nearestCorner(cx, cy, vw, vh)        the corner a dropped box snaps to
   - clampWidth(w, aspect, vw, vh)        a width that fits (half the window
                                          each way, longer side >= 240 px)
   - cornerRect(corner, w, aspect, vw, vh)  the box's left/top/width/height
   - aspectResize(startW, dx, dy, corner, aspect)  width after a grip drag
   ========================================================================= */

const MiniGeom = (() => {
  const CORNERS = ['tl', 'tr', 'bl', 'br'];
  const MARGIN = 16;          // gap between the box and the window edge
  const MIN_W = 240;
  // A very wide picture (21:9, 32:9) at a small width would make a box too
  // short for its controls; it gets this height instead, letterboxed (the
  // video is object-fit: contain on black).
  const MIN_H = 150;
  const MAX_FRACTION = 0.5;   // of the window's width
  const DEFAULT = Object.freeze({ corner: 'br', w: 480 });

  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

  /** A saved {corner, w}, or the default for anything missing or broken. */
  function geomFrom(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const corner = CORNERS.includes(o.corner) ? o.corner : DEFAULT.corner;
    const w = num(o.w, NaN);
    return { corner, w: w >= 100 && w <= 10000 ? Math.round(w) : DEFAULT.w };
  }

  /** The corner nearest a point (the dropped box's centre). */
  function nearestCorner(cx, cy, vw, vh) {
    return (cy < vh / 2 ? 't' : 'b') + (cx < vw / 2 ? 'l' : 'r');
  }

  /**
   * A width for a box of this shape (width / height) that fits: its longer
   * side at least 240 px, at most half the window's width wide and half its
   * height tall, and never taller or wider than the window less its margins.
   * A window too small for the minimum gets whatever fits.
   */
  function clampWidth(w, aspect, vw, vh) {
    const a = num(aspect, 0) > 0 ? aspect : 16 / 9;
    const W = num(vw, 0), H = num(vh, 0);
    const fit = Math.max(0, Math.min(W - 2 * MARGIN, (H - 2 * MARGIN) * a));
    // The minimum is for the longer side: a portrait box is 240 tall, not wide.
    const minW = a >= 1 ? MIN_W : MIN_W * a;
    const lo = Math.min(minW, fit);
    const hi = Math.max(lo, Math.min(W * MAX_FRACTION, H * MAX_FRACTION * a, fit));
    return Math.round(Math.max(lo, Math.min(hi, num(w, DEFAULT.w))));
  }

  /**
   * The box resting in a corner: {left, top, width, height}, all whole
   * pixels. Never shorter than MIN_H (or the window less its margins).
   */
  function cornerRect(corner, w, aspect, vw, vh) {
    const a = num(aspect, 0) > 0 ? aspect : 16 / 9;
    const c = CORNERS.includes(corner) ? corner : DEFAULT.corner;
    const width = clampWidth(w, a, vw, vh);
    const height = Math.max(Math.round(width / a), Math.min(MIN_H, Math.max(0, vh - 2 * MARGIN)));
    const left = c[1] === 'l' ? MARGIN : vw - width - MARGIN;
    const top = c[0] === 't' ? MARGIN : vh - height - MARGIN;
    return { left: Math.max(0, Math.round(left)), top: Math.max(0, Math.round(top)), width, height };
  }

  /**
   * The width after the resize grip moved (dx, dy) from where it was grabbed.
   * The grip sits on the corner facing into the window, so the snapped corner
   * stays put: moving away from it grows the box. Whichever direction moved
   * further decides, so a diagonal or a straight pull both feel right and the
   * shape never changes. Not clamped: clampWidth does that.
   */
  function aspectResize(startW, dx, dy, corner, aspect) {
    const a = num(aspect, 0) > 0 ? aspect : 16 / 9;
    const c = CORNERS.includes(corner) ? corner : DEFAULT.corner;
    const gx = c[1] === 'r' ? -num(dx, 0) : num(dx, 0);
    const gy = (c[0] === 'b' ? -num(dy, 0) : num(dy, 0)) * a;
    return num(startW, DEFAULT.w) + (Math.abs(gx) >= Math.abs(gy) ? gx : gy);
  }

  return { CORNERS, MARGIN, MIN_W, MIN_H, MAX_FRACTION, DEFAULT, geomFrom, nearestCorner, clampWidth, cornerRect, aspectResize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MiniGeom;
