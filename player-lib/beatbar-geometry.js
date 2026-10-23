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

   - storedConfig / fillColorFromStored   the saved config's shape, kept
                                  readable by older builds (see below)

   Loaded before player-lib/beatbar.js; tested in test/beatbar-geometry.test.js.
   ========================================================================= */

const BeatBarGeom = (function () {
  const WIDTH_MIN = 0.30;
  const WIDTH_MAX = 0.96;
  const WIDTH_DEFAULT = 0.56;
  const LANE_H = 64;            // the glass pill's height
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
    storedConfig, fillColorFromStored,
  };
})();

if (typeof window !== 'undefined') window.BeatBarGeom = BeatBarGeom;
