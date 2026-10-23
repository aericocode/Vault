/* =========================================================================
   BEAT BAR GEOMETRY - the Modern beat bar's pure maths (no DOM).

   - clampWidthFrac(v)            saved width made safe (30%..96%, default 56%)
   - widthAfterGripDrag(f, dx, W) width after dragging the left grip by dx px:
                                  away from the centre (left) = wider, both
                                  sides move at once so the bar stays centred
   - laneTiming(o)                playhead x, seconds ahead / behind and px per
                                  second. Px per second come from Speed alone,
                                  so a wider lane shows more time, not faster
                                  beats. At the default width the lane shows
                                  exactly the Speed's lookahead (like Classic).
   - laneBox(o)                   where the lane sits over the video: centred
                                  horizontally, posFrac (centre / video height)
                                  or the default spot above the dock
   - posFracFromPointer(y, rect)  vertical drag -> posFrac (0..1)
   - panelPlace(o)                where the settings panel opens: above its
                                  anchor (bottom fixed, so it grows upward),
                                  or below it when there is no room above

   - effectExtent(cfg) / laneHeight(cfg)  how far a beat and its effects
                                  reach from the lane's centre line at the
                                  config's Size, shape and effects, and the
                                  lane height that holds all of it (min 80)
   - displayedVideoRect(...)      where the picture sits inside a <video>
                                  box (object-fit contain / cover / fill), for
                                  the lane's blurred backdrop
   - storedConfig / fillColorFromStored   the saved config's shape, kept
                                  readable by older builds (see below)

   Loaded before player-lib/beatbar.js; tested in test/beatbar-geometry.test.js.
   ========================================================================= */

const BeatBarGeom = (function () {
  const WIDTH_MIN = 0.30;
  const WIDTH_MAX = 0.96;
  const WIDTH_DEFAULT = 0.56;
  const LANE_H = 80;            // the glass pill's height at the default look (laneHeight)
  const DOCK_GAP = 150;         // default spot: lane bottom this far above the video bottom
  const EDGE = 4;               // keep the lane this far inside the video

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);

  function clampWidthFrac(v) {
    return finite(v) ? clamp(v, WIDTH_MIN, WIDTH_MAX) : WIDTH_DEFAULT;
  }

  function widthAfterGripDrag(startFrac, dxPx, videoW) {
    const start = clampWidthFrac(startFrac);
    if (!finite(dxPx) || !finite(videoW) || videoW <= 0) return start;
    return clampWidthFrac(start - (2 * dxPx) / videoW);
  }

  /**
   * @param {{laneW:number, refW:number, playheadFrac:number, baseLookahead:number}} o
   *   laneW = lane width in px, refW = the video width it is measured against,
   *   baseLookahead = seconds ahead the Speed gives at the default width.
   */
  function laneTiming({ laneW, refW, playheadFrac, baseLookahead }) {
    const ph = finite(playheadFrac) && playheadFrac > 0 && playheadFrac < 1 ? playheadFrac : 0.5;
    const base = finite(baseLookahead) && baseLookahead > 0 ? baseLookahead : 5;
    const w = finite(laneW) && laneW > 0 ? laneW : 0;
    const ref = finite(refW) && refW > 0 ? refW : (w / WIDTH_DEFAULT || 1);
    const playheadX = w * ph;
    const lookahead = base * (w / ref) / WIDTH_DEFAULT;
    const lookbehind = lookahead * (ph / (1 - ph));
    const pxPerSec = lookahead > 0 ? (w - playheadX) / lookahead : 0;
    return { playheadX, lookahead, lookbehind, pxPerSec };
  }

  /**
   * @param {{rect:{left:number,top:number,width:number,height:number},
   *          widthFrac:number|null, posFrac:number|null, laneH?:number, dockGap?:number}} o
   * @returns {{left:number, top:number, width:number, height:number}}
   */
  function laneBox({ rect, widthFrac, posFrac, laneH = LANE_H, dockGap = DOCK_GAP }) {
    const width = Math.round(clampWidthFrac(widthFrac) * rect.width);
    const left = Math.round(rect.left + (rect.width - width) / 2);
    const bottom = rect.top + rect.height;
    let top = finite(posFrac)
      ? rect.top + clamp(posFrac, 0, 1) * rect.height - laneH / 2
      : bottom - laneH - dockGap;
    const lo = rect.top + EDGE, hi = bottom - laneH - EDGE;
    top = hi < lo ? rect.top + (rect.height - laneH) / 2 : clamp(top, lo, hi);
    return { left, top: Math.round(top), width, height: laneH };
  }

  function posFracFromPointer(clientY, rect) {
    if (!rect || !(rect.height > 0)) return null;
    return clamp((clientY - rect.top) / rect.height, 0, 1);
  }

  /**
   * @param {{anchor:{top:number,bottom:number,right:number}, vw:number, vh:number,
   *          panelW:number, panelH?:number, gap?:number, margin?:number, minAbove?:number}} o
 *   panelH = the panel's full height (it scrolls inside whatever is left).
   * @returns {{right:number, bottom:number|null, top:number|null, maxHeight:number}}
   *   CSS right / bottom / top in px from the viewport edges.
   */
  function panelPlace({ anchor, vw, vh, panelW, panelH = 0, gap = 10, margin = 8, minAbove = 260 }) {
    const right = clamp(vw - anchor.right, margin, Math.max(margin, vw - panelW - margin));
    const above = anchor.top - gap - margin;
    const below = vh - anchor.bottom - gap - margin;
    // Above when it fits there (or fits nowhere and above is the bigger side)
    const need = Math.max(minAbove, panelH || 0);
    if (above >= need || (below < need && above >= below)) {
      return { right, bottom: vh - anchor.top + gap, top: null, maxHeight: Math.max(120, above) };
    }
    return { right, bottom: null, top: anchor.bottom + gap, maxHeight: Math.max(120, below) };
  }

  /* How far the drawing reaches above / below the centre line. Mirrors the
     painters in beatbar.js (renderGlassFrame + drawEffects): keep in step.
     Sweeps the hit envelope k (1 = peak) and counts only what is drawn at
     an alpha above EXTENT_ALPHA, so invisible tails do not inflate the lane. */
  const EXTENT_ALPHA = 0.06;
  // Half height of each shape at radius 1 (traceShape): star and heart reach
  // furthest up, the diamond's point sits at 1.06.
  const SHAPE_EXTENT = { circle: 1, heart: 1.12, square: 0.92, diamond: 1.06, star: 1.12 };

  function effectExtent(cfg) {
    const c = cfg || {};
    const fx = c.effects || { pulse: true };
    const baseR = Math.max(3, finite(c.fillSize) && c.fillSize > 0 ? c.fillSize : 9);
    const pulseR = baseR + Math.max(8, baseR * 1.2);
    const sf = SHAPE_EXTENT[c.shape] || 1;
    const border = finite(c.borderWidth) && c.borderWidth > 0 ? c.borderWidth / 2 : 0.5;
    const seen = (alpha, reach) => (alpha > EXTENT_ALPHA ? reach : 0);
    let ext = baseR * sf + border;
    for (let s = 1; s <= 100; s++) {
      const k = s / 100;
      const r = fx.pulse ? baseR + k * (pulseR - baseR) : baseR;
      ext = Math.max(ext, r * sf + border);
      // Glow: Pulse's own (radius r + 18, alpha .55k, linear fade) or the
      // lane's soft hit glow (radius 2.8r, alpha .45k)
      const [gR, gA] = fx.pulse ? [r + 18, 0.55 * k] : [r * 2.8, 0.45 * k];
      ext = Math.max(ext, seen(gA, gR * (1 - EXTENT_ALPHA / gA)));
      if (fx.ripple) {
        for (const delay of [0, 0.3]) {
          const kk = clamp((1 - k) / (1 - delay) - delay, 0, 1);
          if (kk <= 0) continue;
          ext = Math.max(ext, seen(k * 0.55 * (1 - kk * 0.5), r * (1 + kk * 1.9) * sf + 1));
        }
      }
      if (fx.spark) {
        const dist = r + (1 - k) * r * 3.0;                       // fastest spark
        const size = Math.max(1, r * 0.28 * (0.4 + k * 0.6) + 0.8);  // biggest spark
        ext = Math.max(ext, seen(k * 0.85, dist + size));
      }
    }
    return ext;
  }

  // Lane height: room for the full reach on both sides plus a little air,
  // never under the default 80.
  function laneHeight(cfg) {
    return Math.max(LANE_H, Math.ceil(2 * effectExtent(cfg) + 12));
  }

  /** The picture's box inside a <video> element box (CSS px, same frame). */
  function displayedVideoRect(rect, videoW, videoH, fit) {
    if (!rect || !(videoW > 0) || !(videoH > 0) || !(rect.width > 0) || !(rect.height > 0)) return null;
    let sx, sy;
    if (fit === 'fill') { sx = rect.width / videoW; sy = rect.height / videoH; }
    else {
      const s = fit === 'cover'
        ? Math.max(rect.width / videoW, rect.height / videoH)
        : Math.min(rect.width / videoW, rect.height / videoH);   // contain (the default)
      sx = sy = s;
    }
    const width = videoW * sx, height = videoH * sy;
    return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
  }

  /* Stored config shape (localStorage beatbar_config). Released builds read
     it as { ...defaults, ...raw } and call fillColor.toLowerCase(), so every
     key they know must keep its old type. A never-picked colour (null in
     memory: "follow the look's default") is stored as the classic colour
     plus fillColorAuto: true. New keys (widthFrac) are ignored by old builds. */
  function storedConfig(cfg, classicFill) {
    const out = { ...cfg, effects: { ...(cfg.effects || {}) } };
    if (typeof out.fillColor === 'string' && out.fillColor) delete out.fillColorAuto;
    else { out.fillColor = classicFill; out.fillColorAuto = true; }
    out.widthFrac = finite(out.widthFrac) ? out.widthFrac : null;
    return out;
  }

  // null = follow the look's default. The flag only counts while the colour
  // is still the classic one: an older build that let you pick another colour
  // keeps the flag it does not know about, and the pick must win.
  function fillColorFromStored(raw, classicFill) {
    const c = raw && typeof raw.fillColor === 'string' && raw.fillColor ? raw.fillColor : null;
    if (!c) return null;
    if (raw.fillColorAuto === true && c.toLowerCase() === String(classicFill).toLowerCase()) return null;
    return c;
  }

  return {
    WIDTH_MIN, WIDTH_MAX, WIDTH_DEFAULT, LANE_H, DOCK_GAP,
    clampWidthFrac, widthAfterGripDrag, laneTiming, laneBox, posFracFromPointer, panelPlace,
    effectExtent, laneHeight, displayedVideoRect,
    storedConfig, fillColorFromStored,
  };
})();

if (typeof window !== 'undefined') window.BeatBarGeom = BeatBarGeom;
