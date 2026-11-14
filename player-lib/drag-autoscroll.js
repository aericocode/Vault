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
   - nearestDrop(x, y, rects)  where a drop lands when the pointer is in a
                               gap between tiles rather than on one: the
                               nearest tile and the side of it.
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

  /**
   * The drop place for a pointer that is not over a tile (the gap between
   * two tiles or rows, the space after the last one, the grid's edge): the
   * nearest tile, and which side of it. Nearest means the nearest ROW first,
   * then the nearest tile in it, so the empty cells after the last tile land
   * after the last tile and not after the one above. Left / right half in
   * the grid, top / bottom half for table rows (rows: true). Either side of a
   * gap means the same place in the order, so a tie does not matter.
   *
   * o.skip: indexes of the tiles being dragged. They still count for the
   * rows and the nearest tile (so the geometry is what the user sees: the
   * empty cells after a dragged last tile are on ITS row, not the one above),
   * but the answer is never one of them: a place next to a dragged tile is
   * moved to the same place in the order beside the nearest tile that is not
   * dragged (after the one before it, else before the one after it).
   * @param {number} x @param {number} y pointer, viewport pixels
   * @param {{left:number, top:number, right:number, bottom:number}[]} rects in order
   * @returns {{index:number, side:'before'|'after'}|null} null for no rects,
   *   or when every tile is being dragged
   */
  function nearestDrop(x, y, rects, o = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !rects || !rects.length) return null;
    let best = -1, bestDy = Infinity, bestDx = Infinity;
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (!r) continue;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (dy < bestDy - 0.5 || (Math.abs(dy - bestDy) <= 0.5 && dx < bestDx)) { bestDy = dy; bestDx = dx; best = i; }
    }
    if (best < 0) return null;
    const r = rects[best];
    const side = o.rows
      ? (y < (r.top + r.bottom) / 2 ? 'before' : 'after')
      : (x < (r.left + r.right) / 2 ? 'before' : 'after');
    const skip = o.skip ? (o.skip instanceof Set ? o.skip : new Set(o.skip)) : null;
    if (!skip || !skip.has(best)) return { index: best, side };
    // The place in the order: between slot - 1 and slot.
    const slot = side === 'before' ? best : best + 1;
    for (let i = slot - 1; i >= 0; i--) if (rects[i] && !skip.has(i)) return { index: i, side: 'after' };
    for (let i = slot; i < rects.length; i++) if (rects[i] && !skip.has(i)) return { index: i, side: 'before' };
    return null;
  }

  return { speed, nearestDrop, BAND, MIN_SPEED, MAX_SPEED };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DragAutoScroll;
if (typeof window !== 'undefined') window.DragAutoScroll = DragAutoScroll;
