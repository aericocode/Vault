/* =========================================================================
   DRAG AUTO-SCROLL MATHS - how fast the page scrolls while a tile or table
   row is dragged near the top or bottom of the files (collection-reorder.js
   drives it with requestAnimationFrame). Pure, shared with the tests
   (test/drag-autoscroll.test.js). No DOM.

   - speed(y, top, bottom, o)  pixels per second to scroll for a pointer at
                               y, with the visible files between top and
                               bottom (under the sticky bars, over the Stage
                               bar): 0 outside the bands, negative (up) in
                               the top band, positive (down) in the bottom
                               one, faster the nearer the edge (and fastest
                               past it, over a bar). The band is at most a
                               third of the visible height, so a short
                               window still has a middle that does not scroll.
   ========================================================================= */

const DragAutoScroll = (() => {
  const BAND = 70;          // px from each edge where scrolling starts
  const MIN_SPEED = 120;    // px/s just inside the band
  const MAX_SPEED = 1500;   // px/s at the edge (and past it)

  function speed(y, top, bottom, o = {}) {
    const bandPx = o.band != null ? o.band : BAND;
    const min = o.min != null ? o.min : MIN_SPEED;
    const max = o.max != null ? o.max : MAX_SPEED;
    if (![y, top, bottom].every(Number.isFinite) || bottom <= top) return 0;
    const band = Math.min(bandPx, (bottom - top) / 3);
    if (band <= 0) return 0;
    // t: 0 at the band's inner side, 1 at the edge (or past it).
    let t = 0, dir = 0;
    if (y < top + band) { t = (top + band - y) / band; dir = -1; }
    else if (y > bottom - band) { t = (y - (bottom - band)) / band; dir = 1; }
    else return 0;
    t = Math.max(0, Math.min(1, t));
    if (t === 0) return 0;
    // Eased: slow and steady near the inner side, quick right at the edge.
    return dir * (min + (max - min) * t * t);
  }

  return { speed, BAND, MIN_SPEED, MAX_SPEED };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DragAutoScroll;
if (typeof window !== 'undefined') window.DragAutoScroll = DragAutoScroll;
