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
   - sameShownOrder(a, b, shown)  whether two orders of the same files put
                               the SHOWN ones (a search or filter can hide
                               some) in the same order: a gap drop that would
                               only carry the file past hidden ones changes
                               nothing the user sees, so it is no drop.
   - dwellStep(s, x, y, scroll, t)  hold-still timer for files dragged in
                               from outside (drop mode starts after
                               DWELL_MS of resting).
   - visibleDrop(x, y, rects, view)  drop mode's place: the nearest spot
                               among the tiles on screen, wherever the
                               pointer is (header, bars, panels, edges).
   - insertBefore(order, id, side)  the member a drop beside a tile goes in
                               front of, in the full order.
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

  /**
   * Do orders a and b list the files shown(id) is true for in the same order?
   * The common start and end are skipped first (the same in both), so a move
   * only looks at the stretch it changes, and it stops at the first shown
   * file that differs.
   * @param {number[]} a @param {number[]} b @param {(id:number)=>boolean} shown
   */
  function sameShownOrder(a, b, shown) {
    let lo = 0, hiA = a.length, hiB = b.length;
    while (lo < hiA && lo < hiB && a[lo] === b[lo]) lo++;
    while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }
    let i = lo, j = lo;
    for (;;) {
      while (i < hiA && !shown(a[i])) i++;
      while (j < hiB && !shown(b[j])) j++;
      if (i >= hiA || j >= hiB) return i >= hiA && j >= hiB;
      if (a[i] !== b[j]) return false;
      i++; j++;
    }
  }

  /* ── Files dragged in from outside: hold still to pick a spot ──────────
     A file drag from the file manager says nothing about its files until the
     drop, and dragover keeps firing while the pointer rests (Firefox about
     every 50 ms, and the spec asks for it too), so "resting" is worked out
     from where each dragover is: the pointer staying within DWELL_TOL px of
     where it stopped, with the page not scrolled, for DWELL_MS. */
  const DWELL_MS = 2000;    // how long to hold still before drop mode starts
  const DWELL_TOL = 8;      // px the pointer may wander and still count as still

  /**
   * One dragover's step of the hold-still timer.
   * @param {{x,y,scroll,since}|null} s the state from the last step (null: none yet)
   * @param {number} x @param {number} y pointer, viewport px
   * @param {number} scroll the page's scrollY (a scroll moves what is under a still pointer)
   * @param {number} t now, ms
   * @returns {{x,y,scroll,since,settled:boolean,moved:boolean}} moved: the
   *   pointer left the spot it was resting on (the timer started again)
   */
  function dwellStep(s, x, y, scroll, t, o = {}) {
    const ms = o.ms != null ? o.ms : DWELL_MS;
    const tol = o.tol != null ? o.tol : DWELL_TOL;
    const still = s && Number.isFinite(s.since)
      && Math.abs(x - s.x) <= tol && Math.abs(y - s.y) <= tol && Math.abs(scroll - s.scroll) < 1;
    if (!still) return { x, y, scroll, since: t, settled: false, moved: true };
    return { x: s.x, y: s.y, scroll: s.scroll, since: s.since, settled: t - s.since >= ms, moved: false };
  }

  /**
   * Does a tile count as on screen for drop mode? A grid tile when its middle
   * is in the visible files area (its mark is a side edge, seen on the half
   * that shows). A table row only when all of it is: its mark is a line on
   * its top or bottom border, which a sticky header or the window edge hides
   * on a row that is cut off.
   * @param {{top:number,bottom:number}} r @param {{top:number,bottom:number}} view @param {boolean} [rows]
   */
  function onScreen(r, view, rows) {
    if (!r || !view || r.bottom <= r.top) return false;
    if (rows) return r.top >= view.top && r.bottom <= view.bottom;
    const mid = (r.top + r.bottom) / 2;
    return mid >= view.top && mid <= view.bottom;
  }

  /**
   * Drop mode's place for a pointer anywhere on the page, from the tiles'
   * boxes alone (not what is under the pointer): only tiles on screen count
   * (their middle between view.top and view.bottom, the visible files area),
   * the pointer is pulled into that area (over the header, a bar, a panel,
   * an edge band it lands on the nearest visible row), and below the last
   * tile, when it is on screen, means after it.
   * @param {number} x @param {number} y pointer, viewport px
   * @param {{left,top,right,bottom}[]} rects every rendered tile, in order
   * @param {{top:number, bottom:number}} view the visible files area
   * @returns {{index:number, side:'before'|'after'}|null} null: no tile on screen
   */
  function visibleDrop(x, y, rects, view, o = {}) {
    if (!rects || !rects.length || !view || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    const shown = [];
    rects.forEach((r, i) => { if (onScreen(r, view, o.rows)) shown.push(i); });
    if (!shown.length) return null;
    const cy = Math.max(view.top, Math.min(view.bottom, y));
    const last = rects.length - 1;
    if (shown[shown.length - 1] === last && cy > rects[last].bottom) return { index: last, side: 'after' };
    const hit = nearestDrop(x, cy, shown.map(i => rects[i]), { rows: o.rows });
    return hit ? { index: shown[hit.index], side: hit.side } : null;
  }

  /**
   * The member a drop at { id, side } of a tile goes in front of, in the
   * collection's FULL order (not only the tiles loaded): the tile itself for
   * its near side, the member after it for its far side, null for the end.
   * undefined when the tile is not a member (no drop place).
   * @param {number[]} order @param {number} id @param {'before'|'after'} side
   */
  function insertBefore(order, id, side) {
    const i = order.indexOf(id);
    if (i < 0) return undefined;
    if (side === 'before') return id;
    return i + 1 < order.length ? order[i + 1] : null;
  }

  return { speed, nearestDrop, sameShownOrder, dwellStep, visibleDrop, onScreen, insertBefore, BAND, MIN_SPEED, MAX_SPEED, DWELL_MS, DWELL_TOL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DragAutoScroll;
if (typeof window !== 'undefined') window.DragAutoScroll = DragAutoScroll;
