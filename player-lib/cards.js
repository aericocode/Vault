/* =========================================================================
   CARDS - Tile/card rendering and pagination

   Grid view renders compact thumbnail-first TILES (48/page, 6-8+ columns)
   with a hover popover for full details. List view keeps the original
   detail-rich card layout.
   ========================================================================= */

// Type icon fallbacks for tiles without thumbnails (audio, documents, 3D…)
const TILE_TYPE_ICONS = {
  video: '🎬',
  image: '🖼️',
  gif: '🎞️',
  audio: '🎵',
  document: '📄',
  mix: '🎛',
};

/**
 * Tooltip for the ⚠ tile badge. The badge used to read "Processing error" and
 * nothing else, so the one piece of information the user needed — WHICH error,
 * and therefore what to install — was reachable only by opening the details
 * modal, which nothing on the tile suggested. Truncated: a title attribute is a
 * glance, not a log; the modal shows the whole thing.
 * @param {string} msg - stored processing_error
 * @returns {string} plain text (the caller escapes it)
 */
const ERROR_TOOLTIP_MAX = 160;
function errorTooltip(msg) {
  const text = String(msg || '').trim();
  if (!text) return 'Processing error';
  const short = text.length > ERROR_TOOLTIP_MAX
    ? text.slice(0, ERROR_TOOLTIP_MAX - 1).trimEnd() + '…'
    : text;
  return `Processing error: ${short}`;
}

/* ── Adaptive grid ────────────────────────────────────────────────────────
   A page is one screenful of whole rows. The column count comes from the card
   size, the row count from the height actually left under the bars, and every
   tile is pinned to that row height, so the last row lands on the bottom edge
   instead of half off it and the document never has to scroll.

   The first tile on screen is the anchor (an index into filteredMedia), not a
   page number. Anything that changes how many tiles fit — a resize, a card-size
   change, a bar above the grid appearing — re-slices from the same anchor, so
   the tile the user was looking at stays where it was. */

const CARD_MIN_WIDTHS = { S: 130, M: 170, L: 230 };
const GRID_GAP = 12;          // px — 0.75rem, the grid's own gap
const TILE_ASPECT = 16 / 10;  // .tile-thumb aspect-ratio (css/tiles.css)
const BOTTOM_RESERVE = 16;    // .main-container bottom padding
const PAGER_MARGIN = 16;      // .pagination margin-top
const MIN_ROW_H = 90;
// A tile never shrinks below this share of its natural height. Squeezing a row
// to whatever was left over made tiles unreadable on short windows (53% of
// natural at 900x600). When even a single row at this floor does not fit, we
// keep the row at the floor and let the document scroll for the remainder --
// an explicit, rare fallback for very small windows, and the one case where
// pages mode gives up on "never scroll".
const MIN_ROW_RATIO = 0.70;

// The tile's name + meta strip. Content-sized, so it measures the same whether
// or not the tile height is pinned; read off the first rendered tile and kept.
// The constant is only the guess used before anything has rendered.
let tileChromeH = 56;
let pagerH = 44;              // likewise, measured off the rendered pager
let gridMetrics = { cols: 0, rows: 0, tileW: 0, natH: 0, rowH: 0 };

function libraryLayoutMode() {
  return typeof window.vaultLibraryLayout === 'function' ? window.vaultLibraryLayout() : 'pages';
}

function tileMinWidth() {
  const size = typeof window.vaultCardSize === 'function' ? window.vaultCardSize() : 'M';
  return CARD_MIN_WIDTHS[size] || CARD_MIN_WIDTHS.M;
}

/** Column count, tile width and natural tile height for the grid's width. */
function measureGrid() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return null;
  const width = grid.clientWidth;
  if (!width) return null;
  const min = tileMinWidth();
  const cols = Math.max(2, Math.floor((width + GRID_GAP) / (min + GRID_GAP)));
  const tileW = (width - (cols - 1) * GRID_GAP) / cols;
  return { grid, width, cols, tileW, natH: tileW / TILE_ASPECT + tileChromeH };
}

/* ── Pages, counted ───────────────────────────────────────────────────────
   The anchor is still the source of truth, but what the pager SHOWS is a page
   number: "Page 22 of 28" survives a resize in a way "449 to 469" does not.
   A resize can leave the anchor part-way into a page; the page number is then
   the page that contains it, and the next step lands on a page boundary. */

function pageCount() {
  return Math.max(1, Math.ceil(filteredMedia.length / Math.max(1, pageSize)));
}

function pageNumber() {
  return Math.min(pageCount(), Math.floor(pageAnchor / Math.max(1, pageSize)) + 1);
}

/** Index of the first tile of the last page. */
function lastPageAnchor() {
  const size = Math.max(1, pageSize);
  return Math.max(0, (Math.ceil(filteredMedia.length / size) - 1) * size);
}

/** Never strand the view past the end of a list that shrank under it. */
function clampPageAnchor() {
  const next = Math.min(Math.max(0, pageAnchor), lastPageAnchor());
  if (next === pageAnchor) return false;
  pageAnchor = next;
  return true;
}

/**
 * Pin the column count and the row height so one page is exactly one screenful
 * of whole rows. Sets pageSize; returns true if pageSize changed.
 */
function updateGridLayout() {
  const m = measureGrid();
  if (!m) return false;
  const { grid, cols, natH } = m;

  // Document offset, so it reads the same whether or not the page is scrolled
  const gridTop = grid.getBoundingClientRect().top + window.scrollY;
  // Floor at one minimum row rather than at one natural row: on a short window
  // with a lot of bars there may be less room than a tile wants, and shrinking
  // the row is the graceful answer where insisting on the natural height would
  // just hand the document a scrollbar.
  const availH = Math.max(MIN_ROW_H, window.innerHeight - gridTop - pagerH - PAGER_MARGIN - BOTTOM_RESERVE);
  const floorH = Math.max(MIN_ROW_H, natH * MIN_ROW_RATIO);
  let rows = Math.max(1, Math.round((availH + GRID_GAP) / (natH + GRID_GAP)));
  let rowH = (availH - (rows - 1) * GRID_GAP) / rows;
  // Drop a row rather than crush the tiles: fewer, readable rows beat more
  // rows of slivers. With one row left there is nothing further to drop, so
  // the floor wins and the document scrolls a little.
  while (rows > 1 && rowH < floorH) {
    rows--;
    rowH = (availH - (rows - 1) * GRID_GAP) / rows;
  }
  if (rowH < floorH) rowH = floorH;

  grid.classList.add('grid-pages');
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.setProperty('--tile-h', `${rowH.toFixed(1)}px`);
  gridMetrics = { cols, rows, tileW: m.tileW, natH, rowH };

  const newSize = cols * rows;
  if (newSize === pageSize) return false;
  pageSize = newSize;
  clampPageAnchor();
  return true;
}

/**
 * Re-read the two heights the layout can only learn from rendered DOM.
 * Returns true if either moved, i.e. the layout should be redone.
 */
function remeasureGridChrome() {
  let changed = false;
  const tile = document.querySelector('#resultsGrid .media-tile');
  const thumb = tile && tile.querySelector('.tile-thumb');
  if (thumb && thumb.offsetHeight > 0) {
    const chrome = tile.offsetHeight - thumb.offsetHeight;
    if (chrome > 8 && Math.abs(chrome - tileChromeH) > 1) { tileChromeH = chrome; changed = true; }
  }
  const pager = document.getElementById('pagination');
  if (pager && pager.offsetHeight > 0 && Math.abs(pager.offsetHeight - pagerH) > 1) {
    pagerH = pager.offsetHeight;
    changed = true;
  }
  return changed;
}

/**
 * Belt and braces. If anything above the grid measured a pixel or two off, the
 * document would scroll — and a page that scrolls is not a page. Shave the row
 * height by the overflow rather than leave a scrollbar.
 */
function fitRowHeight() {
  if (!gridMetrics.rows) return;
  const over = document.documentElement.scrollHeight - window.innerHeight;
  if (over <= 1) return;
  // Shave only down to the floor -- past it we accept the scrollbar.
  const floorH = Math.max(MIN_ROW_H, gridMetrics.natH * MIN_ROW_RATIO);
  const rowH = Math.max(floorH, gridMetrics.rowH - over / gridMetrics.rows);
  gridMetrics.rowH = rowH;
  document.getElementById('resultsGrid')?.style.setProperty('--tile-h', `${rowH.toFixed(1)}px`);
}

let _inRenderCorrection = false;

function renderResults() {
  if (libraryLayoutMode() === 'continuous') return renderContinuous();

  const grid = document.getElementById('resultsGrid');
  if (grid) grid.classList.remove('grid-continuous');
  updateGridLayout();
  clampPageAnchor();

  const pageItems = filteredMedia.slice(pageAnchor, pageAnchor + pageSize);
  currentPage = Math.floor(pageAnchor / Math.max(1, pageSize)) + 1;

  const resultsGrid = document.getElementById('resultsGrid');
  const collCards = typeof renderCollectionCards === 'function' ? renderCollectionCards() : '';
  resultsGrid.innerHTML = collCards + pageItems.map(m => renderTile(m)).join('');
  hydrateThumbs(resultsGrid);
  renderPagination();

  // Keep the selection bar's "Select page" count/state in sync after paging
  if (typeof renderSelectionBar === 'function') renderSelectionBar();

  // One correction pass: this render is the only chance to measure the real
  // name-strip and pager heights, and being wrong about them is the difference
  // between the last row fitting and the document scrolling.
  if (!_inRenderCorrection) {
    _inRenderCorrection = true;
    try {
      if (remeasureGridChrome()) renderResults();
      fitRowHeight();
    } finally {
      _inRenderCorrection = false;
    }
    prefetchAdjacentPages();
  }
}

/* ── Prefetch ─────────────────────────────────────────────────────────────
   Whatever the user asks for next is almost always a page away, so warm the
   pages either side of this one, nearest first. The depths live in thumbs.js
   (PREFETCH_PAGES_AHEAD / _BEHIND) next to the code that spends them. After a
   new search there is no previous page worth having, so it takes the pages
   ahead and nothing else. */

let _prefetchWide = false;

function prefetchAdjacentPages() {
  if (typeof scheduleThumbPrefetch !== 'function') return;
  const size = Math.max(1, pageSize);
  const behind = _prefetchWide ? 0 : PREFETCH_PAGES_BEHIND;
  _prefetchWide = false;

  const batches = [];
  for (let i = 1; i <= PREFETCH_PAGES_AHEAD; i++) {
    batches.push(filteredMedia.slice(pageAnchor + i * size, pageAnchor + (i + 1) * size));
  }
  for (let i = 1; i <= behind; i++) {
    const from = Math.max(0, pageAnchor - i * size);
    const to = Math.max(0, pageAnchor - (i - 1) * size);
    batches.push(filteredMedia.slice(from, to));
  }
  scheduleThumbPrefetch(batches);
}

function prefetchContinuousRows() {
  if (typeof scheduleThumbPrefetch !== 'function') return;
  const { cols, first, last } = contState;
  if (!cols || last < 0) return;
  const above = (_prefetchWide || first <= 0)
    ? []
    : filteredMedia.slice(Math.max(0, first - PREFETCH_ROWS_BEHIND) * cols, first * cols);
  _prefetchWide = false;
  const below = filteredMedia.slice((last + 1) * cols, (last + 1 + PREFETCH_ROWS_AHEAD) * cols);
  scheduleThumbPrefetch([below, above]);
}

/* ── Where the page starts ────────────────────────────────────────────────
   Every jump goes through here so the anchor stays the single source of
   truth; goToPage() survives as a thin wrapper for older callers. */

function setPageAnchor(index) {
  const next = Math.min(Math.max(0, Math.round(index)), lastPageAnchor());
  if (next === pageAnchor) return false;
  pageAnchor = next;
  renderResults();
  return true;
}

/**
 * One step is one page, and it lands on a page start: from a part-way anchor
 * (left behind by a resize) Next goes to the top of the following page rather
 * than a screenful further into the middle of nowhere.
 */
function movePage(delta) {
  return setPageAnchor((pageNumber() - 1 + delta) * Math.max(1, pageSize));
}

/** Back to the first tile — a new search or filter has no place to hold. */
function resetPageAnchor() {
  pageAnchor = 0;
  _prefetchWide = true;   // nothing behind us: warm what is ahead instead
  if (libraryLayoutMode() === 'continuous') scrollLibraryToTop();
}

/** Bring the top of the grid back into view without disturbing a short page. */
function scrollLibraryToTop() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return;
  const top = grid.getBoundingClientRect().top + window.scrollY;
  if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top) });
}

/** Put the tile at this index on screen. Used at boot only. */
function revealMediaIndex(index) {
  if (index < 0 || index >= filteredMedia.length) return;
  if (libraryLayoutMode() === 'continuous') {
    const cols = Math.max(1, contState.cols);
    const virt = document.querySelector('#resultsGrid .grid-virt');
    if (!virt || !contState.stride) return;
    const virtTop = virt.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, virtTop + Math.floor(index / cols) * contState.stride) });
    renderContinuousWindow();
    return;
  }
  const size = Math.max(1, pageSize);
  setPageAnchor(Math.floor(index / size) * size);
}

/* ── Continuous mode ──────────────────────────────────────────────────────
   The document scrolls as it always did; what changes is that only the rows
   near the viewport exist. The grid becomes a plain block holding one spacer
   the height of the whole list, with a handful of absolutely positioned rows
   inside it. Tiles keep their natural height and nothing snaps — the scroll
   position is whatever the user left it at, to the pixel. */

let contState = { cols: 0, stride: 0, totalRows: 0, first: -1, last: -1 };

/** Which rows to keep in the DOM: the visible ones plus a small buffer. */
function continuousRange(stride, totalRows) {
  const virt = document.querySelector('#resultsGrid .grid-virt');
  if (!virt || !stride) return { first: 0, last: Math.min(totalRows - 1, 5), y: 0 };
  const virtTop = virt.getBoundingClientRect().top + window.scrollY;
  const y = window.scrollY - virtTop;
  const first = Math.max(0, Math.floor(y / stride) - 2);
  const last = Math.min(totalRows - 1, Math.floor((y + window.innerHeight) / stride) + 3);
  return { first, last, y };
}

function renderContinuous() {
  const m = measureGrid();
  if (!m) return;
  const { grid, cols, natH } = m;
  const stride = natH + GRID_GAP;
  const total = filteredMedia.length;
  const totalRows = Math.ceil(total / cols);

  grid.classList.remove('grid-pages');
  grid.classList.add('grid-continuous');
  grid.style.removeProperty('--tile-h');
  grid.style.removeProperty('grid-template-columns');

  const collCards = typeof renderCollectionCards === 'function' ? renderCollectionCards() : '';

  // Rebuild the skeleton only when its shape changed; scrolling replaces the
  // rows inside it and nothing else, which is the whole point of the spacer.
  const shape = `${cols}|${totalRows}|${Math.round(stride)}|${collCards.length}`;
  let virt = grid.querySelector('.grid-virt');
  if (!virt || grid.dataset.gridShape !== shape) {
    grid.innerHTML =
      (collCards ? `<div class="grid-colls" style="grid-template-columns:repeat(${cols},1fr)">${collCards}</div>` : '') +
      '<div class="grid-virt"></div>';
    grid.dataset.gridShape = shape;
    virt = grid.querySelector('.grid-virt');
  }
  virt.style.height = `${Math.max(0, totalRows * stride - GRID_GAP)}px`;

  contState = { cols, stride, totalRows, first: -1, last: -1 };
  renderContinuousWindow();

  renderPagination();

  // The name strip is the one height only rendered DOM can tell us; a wrong
  // guess would put every row's top a few pixels out.
  if (!_inRenderCorrection) {
    _inRenderCorrection = true;
    try { if (remeasureGridChrome()) renderContinuous(); } finally { _inRenderCorrection = false; }
  }
}

/** Swap in the rows for the current scroll position. */
function renderContinuousWindow() {
  const virt = document.querySelector('#resultsGrid .grid-virt');
  if (!virt) return;
  const { cols, stride, totalRows } = contState;
  const r = continuousRange(stride, totalRows);
  contState.first = r.first;
  contState.last = r.last;

  let html = '';
  for (let row = r.first; row <= r.last; row++) {
    const items = filteredMedia.slice(row * cols, row * cols + cols);
    if (!items.length) continue;
    html += `<div class="grid-row" style="top:${(row * stride).toFixed(1)}px;grid-template-columns:repeat(${cols},1fr)">`
      + items.map(item => renderTile(item)).join('') + '</div>';
  }
  virt.innerHTML = html;
  hydrateThumbs(virt);
  prefetchContinuousRows();

  // The anchor still means "first tile on screen", which here is the first
  // tile of the first row the viewport actually shows.
  pageAnchor = Math.max(0, Math.min(
    Math.max(0, filteredMedia.length - 1),
    Math.max(0, Math.floor(Math.max(0, r.y) / (stride || 1))) * cols));
  currentPage = Math.floor(pageAnchor / Math.max(1, pageSize)) + 1;

  if (typeof renderSelectionBar === 'function') renderSelectionBar();
}

/** Where the viewport sits, expressed as a tile plus a pixel offset. */
function continuousAnchorOffset() {
  const virt = document.querySelector('#resultsGrid .grid-virt');
  if (!virt || !contState.stride) return null;
  const virtTop = virt.getBoundingClientRect().top + window.scrollY;
  const y = window.scrollY - virtTop;
  if (y < 0) return null;                     // still above the grid: nothing to hold
  const row = Math.floor(y / contState.stride);
  return { index: row * contState.cols, offset: y - row * contState.stride };
}

/** Put that tile back at the same place in the viewport after a re-lay. */
function restoreContinuousAnchor(keep) {
  const virt = document.querySelector('#resultsGrid .grid-virt');
  if (!keep || !virt || !contState.stride) return;
  const virtTop = virt.getBoundingClientRect().top + window.scrollY;
  const row = Math.floor(keep.index / Math.max(1, contState.cols));
  window.scrollTo({ top: Math.max(0, virtTop + row * contState.stride + keep.offset) });
  renderContinuousWindow();
}

/* ── Re-layout triggers ───────────────────────────────────────────────────
   The grid is re-laid only when something that feeds the maths actually
   moved: its width, its distance from the top of the document (a bar above it
   appearing or disappearing), the window height, or the card size. Gating on
   that key matters — fitRowHeight() changes the grid's HEIGHT, which the
   observer would otherwise read as a reason to lay out again, forever. */

let _lastLayoutKey = '';

function libraryLayoutKey() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return '';
  const top = Math.round(grid.getBoundingClientRect().top + window.scrollY);
  return [grid.clientWidth, top, window.innerHeight, tileMinWidth(), libraryLayoutMode()].join('|');
}

function relayoutLibrary(force) {
  const key = libraryLayoutKey();
  if (!key) return;
  if (!force && key === _lastLayoutKey) return;
  _lastLayoutKey = key;
  // A bar above the grid changing height moves every row; hold the tile the
  // user was looking at rather than let the list slide under them.
  const keep = libraryLayoutMode() === 'continuous' ? continuousAnchorOffset() : null;
  renderResults();
  if (keep) restoreContinuousAnchor(keep);
  _lastLayoutKey = libraryLayoutKey();
}

// Settings calls this when the layout mode or card size changes.
window.vaultRelayoutLibrary = () => relayoutLibrary(true);

function initGridObservers() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return;
  let timer = null;
  const nudge = () => {
    clearTimeout(timer);
    timer = setTimeout(() => relayoutLibrary(false), 80);
  };
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(nudge);
    ro.observe(grid);
    // The bars above the grid: showing or hiding one moves the grid's top edge
    ['.search-section', '.results-info', '#missingFilesBanner', '#focusFilterBar']
      .forEach(sel => { const el = document.querySelector(sel); if (el) ro.observe(el); });
  }
  window.addEventListener('resize', nudge);

  // Continuous mode: rows come and go as the page scrolls, one pass per frame.
  let scrollQueued = false;
  window.addEventListener('scroll', () => {
    if (libraryLayoutMode() !== 'continuous' || scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      const r = continuousRange(contState.stride, contState.totalRows);
      if (r.first === contState.first && r.last === contState.last) return;
      renderContinuousWindow();
    });
  }, { passive: true });

  // One wheel notch is one page. Debounced, because a trackpad fling arrives
  // as a burst of small deltas and would otherwise flip through several.
  // The whole results region answers to it, not only the tiles: a wheel over
  // the sort row or over the pager is still a wheel over the library.
  let wheelBlockedUntil = 0;
  const onWheel = (e) => {
    if (libraryLayoutMode() !== 'pages') return;
    if (!e.deltaY) return;
    // Anything floating over the grid owns the wheel while it is open: the
    // More sheet, and any chip or Options popover (they share one component).
    if (document.getElementById('moreFiltersSheet')?.classList.contains('active')) return;
    if (typeof filterPopoverIsOpen === 'function' && filterPopoverIsOpen()) return;
    if (ownsItsScroll(e.target, e.currentTarget)) return;
    const now = Date.now();
    if (now < wheelBlockedUntil) return;
    wheelBlockedUntil = now + 250;
    movePage(e.deltaY > 0 ? 1 : -1);
  };
  ['.results-info', '#resultsGrid', '#pagination'].forEach((sel) => {
    document.querySelector(sel)?.addEventListener('wheel', onWheel, { passive: true });
  });
}

/**
 * True if the wheel belongs to something inside the region rather than to the
 * page: a select, a text field, or any box with its own scrollbar. Paging the
 * library out from under one of those would be the wrong answer.
 */
function ownsItsScroll(target, root) {
  for (let n = target; n && n !== root; n = n.parentElement) {
    if (!(n instanceof Element)) break;
    // The pager's own slider is an input, but it is also the middle of the
    // pager: a wheel there means the same thing as a wheel next to it, and a
    // range slider does nothing with the wheel of its own accord.
    if (n.tagName === 'INPUT' && n.type === 'range') continue;
    if (isTypingTarget(n)) return true;
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1) return true;
  }
  return false;
}

/** Typing somewhere? Then Page Down belongs to that field, not to the grid. */
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  if (libraryLayoutMode() !== 'pages') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (isTypingTarget(e.target)) return;
  // The player, the mini player and any open modal own these keys first
  if (document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) return;
  if (document.getElementById('miniPlayer')?.classList.contains('active')) return;
  if (document.querySelector('.modal-overlay.active, .settings-overlay.active')) return;
  if (document.getElementById('mainContainer')?.classList.contains('active') !== true) return;

  if (e.key === 'PageDown') { movePage(1); }
  else if (e.key === 'PageUp') { movePage(-1); }
  else if (e.key === 'Home') { setPageAnchor(0); }
  else if (e.key === 'End') { setPageAnchor(lastPageAnchor()); }
  else return;
  e.preventDefault();
});

// player-lib scripts are loaded after the document is parsed, so waiting on
// DOMContentLoaded here would wait for an event that already fired.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGridObservers);
} else {
  initGridObservers();
}

/* ── Compact tile (grid view) ──────────────────────────────────────────────
   The filename `title=` tooltip below is written conditionally: a native
   tooltip cannot be blurred by CSS, so the only way to stop a hover printing
   the name in the clear is to not write the attribute at all. It is dropped
   when privacy mode is hiding FILE NAMES specifically (body.pm-names) rather
   than for privacy mode as a whole — with names left visible the tooltip leaks
   nothing the tile is not already showing. settings.js repaints the grid when
   either the mode or that choice changes. */

function renderTile(media) {
  const isFlagged = !!media.user_flagged_delete;
  const isTrashed = !!media.user_trashed;
  const hasNotes = media.user_notes && media.user_notes !== '[]' && media.user_notes !== '';
  const isUnscanned = media.processing_error === 'unscanned';
  const hasError = !!media.processing_error && !isUnscanned;
  const rating = media.user_rating || 0;
  const duration = media.duration_seconds ? formatDuration(media.duration_seconds) : '';
  const icon = TILE_TYPE_ICONS[media.media_type] || '📁';
  // A file we already know has no picture (its source is gone, or the render
  // failed) renders as the type icon straight away. Otherwise every re-render
  // would ask the server again for something it has already said is not there.
  const canThumb = ['image', 'gif', 'video', 'mix'].includes(media.media_type)
    && !thumbKnownMissing(media.id);
  const isMix = media.media_type === 'mix';
  const isSelected = typeof selectedIds !== 'undefined' && selectedIds.has(media.id);

  // Can this file play at all? The chips ask the same question (filters.js);
  // here the answer only ever adds the ⚠ that playback_failed used to add on
  // its own, now also for files whose codecs this browser has no decoder for
  // and no remux path to.
  const playState = typeof mediaPlaybackState === 'function'
    ? mediaPlaybackState(media)
    : { state: media.playback_failed ? 'no' : 'unknown', reason: 'Failed to play' };
  const cannotPlay = playState.state === 'no';
  const cannotPlayWhy = playState.reason || 'Failed to play';

  // Small indicator row: only what matters at a glance
  const views = media.view_count || 0;
  const doneCount = media.done_count || 0;
  const hotCount = media.hot_count || 0;
  const indicators = [
    views > 0 ? `<span class="tile-ind ind-views" title="Viewed ${views}×">👁${views > 1 ? views : ''}</span>` : '',
    media.user_starred ? '<span class="tile-ind ind-star" title="Fave">❤</span>' : '',
    rating > 0 ? `<span class="tile-ind ind-rating" title="Rated ${rating}/5">${rating}</span>` : '',
    isFlagged ? '<span class="tile-ind ind-flag" title="Flagged">🚩</span>' : '',
    media.dupe_group ? '<span class="tile-ind ind-dupe" title="Confirmed duplicate — notes shared">⧉</span>' : '',
    isTrashed ? '<span class="tile-ind ind-trashed" title="In trash">🗑</span>' : '',
    cannotPlay ? `<span class="tile-ind ind-error" title="${escapeHtml(cannotPlayWhy)}">⚠</span>` : '',
    hasNotes ? '<span class="tile-ind ind-notes" title="Has notes">📝</span>' : '',
    hasError ? `<span class="tile-ind ind-error" title="${escapeHtml(errorTooltip(media.processing_error))}">⚠</span>` : '',
    isUnscanned ? '<span class="tile-ind ind-unscanned" title="Not scanned yet — AI analysis pending">⏳</span>' : '',
    (typeof mediaSongIds === 'function' && mediaSongIds(media.id).length > 0)
      ? `<span class="tile-ind ind-music" title="${mediaSongIds(media.id).length} song(s) identified">🎵</span>` : '',
  ].filter(Boolean).join('');

  // Hot 🔥 / Done 💦 markers live at the thumb's bottom-LEFT (opposite the
  // duration, which sits bottom-right) to save room on the indicator bar.
  const hotDone = [
    hotCount > 0 ? `<span class="hd-hot" title="Intense moments marked ${hotCount}×">🔥${hotCount > 1 ? hotCount : ''}</span>` : '',
    doneCount > 0 ? `<span class="hd-done" title="Finishers: sessions ended here ${doneCount}×">💦${doneCount > 1 ? doneCount : ''}</span>` : '',
  ].filter(Boolean).join('');

  // thumbImgAttrs() decides between a plain src and the vault's blob cache;
  // the onerror is the last resort, after thumbs.js has run out of retries.
  const thumb = canThumb
    ? `<img class="tile-img" loading="lazy" ${thumbImgAttrs(media)} alt=""
         onerror="this.parentElement.classList.add('thumb-fallback'); this.remove();">`
    : '';

  // Custom mixes are virtual files — nothing on disk to trash
  const dMode = typeof getDeleteMode === 'function' ? getDeleteMode() : 'soft';
  const delTitle = dMode === 'hard' ? 'Delete permanently (no undo)'
    : dMode === 'recycle' ? 'Delete to Recycle Bin' : 'Move to trash';
  const trashBtn = isMix ? '' : (isTrashed
    ? `<button class="tile-btn" onclick="restoreSingle(${media.id})" title="Restore from trash">♻</button>`
    : `<button class="tile-btn ${dMode !== 'soft' ? 'tile-btn-danger' : ''}" onclick="trashSingle(${media.id})" title="${delTitle}">🗑</button>`);

  // Resume progress sliver (video/audio with a stored position)
  const resumePct = (['video', 'audio'].includes(media.media_type) &&
    media.last_position > 0 && media.duration_seconds > 0)
    ? Math.min(100, (media.last_position / media.duration_seconds) * 100)
    : 0;

  // Audio-similarity mode: show each tile's % match to the anchor file
  let simChip = '';
  if (typeof audioSimScores !== 'undefined' && audioSimScores) {
    if (media.id === audioSimAnchorId) {
      simChip = '<span class="tile-badge sim-badge sim-anchor" title="Similarity anchor — other files are ranked against this one">≈ anchor</span>';
    } else if (audioSimScores.has(media.id)) {
      simChip = `<span class="tile-badge sim-badge" title="Audio similarity: rarity-weighted share of songs in common with the anchor">≈${Math.round(audioSimScores.get(media.id) * 100)}%</span>`;
    }
  }

  return `
    <div class="media-tile ${isFlagged ? 'tile-flagged' : ''} ${isTrashed ? 'tile-trashed' : ''} ${isSelected ? 'tile-selected' : ''} ${cannotPlay ? 'tile-failed' : ''} ${media.id === lastOpenedMediaId ? 'tile-last-opened' : ''} ${(typeof isCardBusy === 'function' && isCardBusy(media.id)) ? 'tile-busy' : ''}" data-id="${media.id}">
      <div class="tile-thumb ${canThumb ? '' : 'thumb-fallback'}" onclick="playMediaById(${media.id})">
        ${thumb}
        <span class="tile-type-icon">${icon}</span>
        ${duration ? `<span class="tile-duration">${duration}</span>` : ''}
        ${hotDone ? `<span class="tile-hotdone">${hotDone}</span>` : ''}
        ${resumePct > 2 ? `<div class="tile-resume" style="width:${resumePct.toFixed(1)}%" title="Resume at ${formatDuration(media.last_position)}"></div>` : ''}
        <input type="checkbox" class="tile-select" ${isSelected ? 'checked' : ''}
          onclick="onTileSelect(event, ${media.id})" title="Select (shift-click for range)">
        <div class="tile-actions" onclick="event.stopPropagation()">
          <button class="tile-btn ${media.user_starred ? 'active-star' : ''}" onclick="toggleStar(mediaPathById(${media.id}))" title="${media.user_starred ? 'Remove Fave' : 'Fave'}">${media.user_starred ? '❤' : '🤍'}</button>
          <button class="tile-btn ${isFlagged ? 'active-flag' : ''}" onclick="toggleFlagDelete(mediaPathById(${media.id}))" title="${isFlagged ? 'Unflag' : 'Flag'}">🚩</button>
          ${trashBtn}
          <button class="tile-btn" onclick="showDetailsById(${media.id})" title="Details">ⓘ</button>
        </div>
      </div>
      <div class="tile-name"${document.body.classList.contains('pm-names') ? '' : ` title="${escapeHtml(media.filename)}"`}>${escapeHtml(media.filename)}</div>
      <div class="tile-meta">
        <span class="tile-badge type-${media.media_type}">${media.media_type}</span>
        ${simChip}
        ${media.language_code && media.language_code !== 'none' ? `<span class="tile-badge lang" title="${escapeHtml(media.language_name || '')}">${escapeHtml(media.language_code.toUpperCase())}</span>` : ''}
        <span class="tile-indicators">${indicators}</span>
      </div>
    </div>
  `;
}

/** Look up helpers used by inline tile handlers */
function mediaPathById(id) {
  const m = getMediaById(id);
  return m ? m.filepath : '';
}

function playMediaById(id) {
  const m = getMediaById(id);
  if (!m) return;
  hideTilePopover();
  // Mixes play in the main player too (renderMixPlayer); the sidebar's
  // "🎛 Open in Editor" button covers tweaking
  playMedia({ filepath: m.filepath, filename: m.filename, media_type: m.media_type });
}

function showDetailsById(id) {
  const m = getMediaById(id);
  if (!m) return;
  hideTilePopover();
  showDetails(m);
}

/* ── Hover popover (grid view) ─────────────────────────────────────────── */

let _popoverTimer = null;
let _popoverForId = null;

function ensureTilePopover() {
  let el = document.getElementById('tilePopover');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tilePopover';
    el.className = 'tile-popover';
    document.body.appendChild(el);
    // Keep the popover open while the pointer is over it
    el.addEventListener('mouseleave', hideTilePopover);
  }
  return el;
}

function buildPopoverHtml(media) {
  const themes = safeParseJSON(media.themes, []);
  const tags = safeParseJSON(media.tags, []);
  const allTags = [...themes, ...tags].slice(0, 12);
  const duration = media.duration_seconds ? formatDuration(media.duration_seconds) : '';
  const fileSize = media.filesize_bytes ? formatFileSize(media.filesize_bytes) : '';
  const rating = media.user_rating || 0;

  const flags = [
    media.user_starred ? '❤ Fave' : '',
    rating > 0 ? `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}` : '',
    media.user_flagged_delete ? '🚩 Flagged' : '',
    media.dupe_group ? '⧉ Dupe (notes shared)' : '',
    media.user_trashed ? '🗑 In trash' : '',
    media.playback_failed ? '⚠ Failed to play' : '',
  ].filter(Boolean);

  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const songCount = typeof mediaSongIds === 'function' ? mediaSongIds(media.id).length : 0;

  return `
    <div class="pop-title">${escapeHtml(media.filename)}</div>
    ${media.description ? `<div class="pop-desc">${escapeHtml(media.description)}</div>` : ''}
    ${allTags.length ? `<div class="pop-tags">${allTags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    <div class="pop-meta">${[duration, fileSize, media.quality_flag, media.content_type, `👁 ${media.view_count || 0} views`].filter(Boolean).join(' • ')}</div>
    <div class="pop-path" title="${escapeHtml(media.filepath)}">
      <span class="pop-path-text">📁 ${escapeHtml(media.filepath)}</span>
      <button class="pop-path-copy" onclick="copyPath('${escapedPath}')" title="Copy full path">⧉</button>
    </div>
    ${flags.length ? `<div class="pop-flags">${flags.join(' &nbsp; ')}</div>` : ''}
    ${songCount > 0 && typeof startAudioSimilarity === 'function' ? `
      <div class="pop-actions">
        <button class="pop-action-btn" onclick="startAudioSimilarity(${media.id})"
          title="Rank the library by shared songs with this file">≈ Similar audio (${songCount} song${songCount === 1 ? '' : 's'})</button>
      </div>` : ''}
  `;
}

function showTilePopover(tileEl, media) {
  const pop = ensureTilePopover();
  pop.innerHTML = buildPopoverHtml(media);
  pop.classList.add('visible');
  _popoverForId = media.id;

  // Position beside the tile, clamped to the viewport
  const rect = tileEl.getBoundingClientRect();
  pop.style.left = '0px';
  pop.style.top = '0px';
  const popW = Math.min(340, window.innerWidth - 24);
  pop.style.width = popW + 'px';

  let left = rect.right + 8;
  if (left + popW > window.innerWidth - 12) {
    left = rect.left - popW - 8;           // flip to the left side
  }
  if (left < 12) left = 12;                 // clamp

  const popH = pop.offsetHeight;
  let top = rect.top;
  if (top + popH > window.innerHeight - 12) {
    top = window.innerHeight - popH - 12;
  }
  if (top < 12) top = 12;

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hideTilePopover() {
  clearTimeout(_popoverTimer);
  _popoverTimer = null;
  _popoverForId = null;
  const pop = document.getElementById('tilePopover');
  if (pop) pop.classList.remove('visible');
}

/* ── Hover-scrub: cycle preview frames on video tiles (YouTube-style) ──── */

const SCRUB_FRAMES = 5;
const SCRUB_INTERVAL_MS = 450;

let _scrub = { id: null, timer: null, idx: 0, img: null };

function startScrub(tile, media) {
  if (media.media_type !== 'video' || !media.duration_seconds || media.duration_seconds < 3) return;
  const img = tile.querySelector('.tile-img');
  if (!img) return; // no thumbnail rendered (fallback icon)

  stopScrub();
  _scrub = { id: media.id, timer: null, idx: 0, img };

  _scrub.timer = setInterval(() => {
    if (!img.isConnected) { stopScrub(); return; }
    // onerror: fall back to the static thumb (e.g. scrub frame unavailable)
    img.onerror = () => { img.onerror = null; img.src = staticThumbSrc(media.id); };
    img.src = scrubUrl(media.id, _scrub.idx);
    _scrub.idx = (_scrub.idx + 1) % SCRUB_FRAMES;
  }, SCRUB_INTERVAL_MS);
}

function stopScrub() {
  if (_scrub.timer) clearInterval(_scrub.timer);
  if (_scrub.img && _scrub.img.isConnected && _scrub.id != null) {
    _scrub.img.onerror = null;
    _scrub.img.src = staticThumbSrc(_scrub.id); // restore the static thumb
  }
  _scrub = { id: null, timer: null, idx: 0, img: null };
}

/**
 * Reusable hover-scrub for any tile grid whose tiles carry a data-id and a
 * .tile-img (games picker, PMV picker, …). Same YouTube-style frame cycling
 * as the main library grid. Bound once per container element — safe to call
 * again after the container is re-created by an innerHTML swap.
 */
function attachHoverScrub(container) {
  if (!container || container._scrubBound) return;
  container._scrubBound = true;

  container.addEventListener('mouseover', (e) => {
    const tile = e.target.closest('[data-id]');
    if (!tile || !container.contains(tile)) return;
    const id = Number(tile.dataset.id);
    if (!id || id === _scrub.id) return;
    const media = getMediaById(id);
    if (media) startScrub(tile, media);
  });

  container.addEventListener('mouseout', (e) => {
    const tile = e.target.closest('[data-id]');
    if (!tile) return;
    const to = e.relatedTarget;
    if (to && tile.contains(to)) return;   // moving within the same tile
    stopScrub();
  });
}

// Delegated hover handling on the results grid
(function initTilePopover() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return;

  grid.addEventListener('mouseover', (e) => {
    const tile = e.target.closest('.media-tile');
    if (!tile) return;
    const id = Number(tile.dataset.id);

    // Hover-scrub for videos (independent of the popover delay)
    if (id !== _scrub.id) {
      const media = getMediaById(id);
      if (media) startScrub(tile, media);
    }

    if (id === _popoverForId) return;

    clearTimeout(_popoverTimer);
    _popoverTimer = setTimeout(() => {
      const media = getMediaById(id);
      if (media && tile.isConnected) showTilePopover(tile, media);
    }, 150);
  });

  grid.addEventListener('mouseout', (e) => {
    const tile = e.target.closest('.media-tile');
    if (!tile) return;
    // Ignore moves within the same tile or into the popover itself
    const to = e.relatedTarget;
    if (to && (tile.contains(to) || to.closest?.('#tilePopover'))) return;
    stopScrub();
    clearTimeout(_popoverTimer);
    _popoverTimer = null;
    // Small grace period so the pointer can travel into the popover
    setTimeout(() => {
      const pop = document.getElementById('tilePopover');
      if (pop && !pop.matches(':hover') && !document.querySelector('.media-tile:hover')) {
        hideTilePopover();
      }
    }, 80);
  });

  // Hide on scroll — stale positioning looks broken
  window.addEventListener('scroll', () => { hideTilePopover(); stopScrub(); }, { passive: true });
})();

/* ── Detail-rich card (list view) ──────────────────────────────────────── */

function renderCard(media) {
  const themes = safeParseJSON(media.themes, []);
  const tags = safeParseJSON(media.tags, []);
  const allTags = [...themes, ...tags].slice(0, 6);

  const duration = media.duration_seconds
    ? formatDuration(media.duration_seconds)
    : '';

  const fileSize = media.filesize_bytes
    ? formatFileSize(media.filesize_bytes)
    : '';

  const cardUnscanned = media.processing_error === 'unscanned';
  const hasError = media.processing_error && !cardUnscanned;
  const hasNotes = media.user_notes && media.user_notes !== '[]' && media.user_notes !== '';
  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const isFlagged = media.user_flagged_delete ? true : false;

  return `
    <div class="media-card ${isFlagged ? 'card-flagged' : ''}">
      <div class="card-header">
        <div class="card-title">${escapeHtml(media.filename)}</div>
        <div class="card-path">
          <span>${escapeHtml(truncatePath(media.filepath))}</span>
          <button onclick="copyPath('${escapedPath}')">Copy Path</button>
        </div>
      </div>
      <div class="card-body">
        <div class="card-meta">
          <span class="meta-badge type-${media.media_type}">${media.media_type}</span>
          ${media.language_code && media.language_code !== 'none' ? `<span class="meta-badge language" title="${escapeHtml(media.language_name || '')}">${escapeHtml(media.language_code.toUpperCase())}</span>` : ''}
          ${media.content_type ? `<span class="meta-badge">${media.content_type}</span>` : ''}
          ${hasError ? `<span class="meta-badge error" title="${escapeHtml(errorTooltip(media.processing_error))}" data-error="${escapeHtml(media.processing_error)}">⚠ Error</span>` : ''}
          ${cardUnscanned ? '<span class="meta-badge unscanned-badge" title="AI analysis pending">⏳ Not scanned</span>' : ''}
          ${hasNotes ? '<span class="meta-badge has-notes">📝 Notes</span>' : ''}
          ${isFlagged ? '<span class="meta-badge flagged-badge">🚩 Flagged</span>' : ''}
          ${typeof renderDuplicateBadge === 'function' ? renderDuplicateBadge(media) : ''}
          ${typeof renderCardStarRating === 'function' ? renderCardStarRating(media) : ''}
        </div>
        ${media.description ? `<div class="card-description">${escapeHtml(media.description)}</div>` : ''}
        <div class="card-tags">
          ${allTags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
      <div class="card-footer">
        <span>${[duration, fileSize, media.quality_flag].filter(Boolean).join(' • ')}</span>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button class="expand-btn" onclick="showDetailsById(${media.id})">Details</button>
          <button class="play-btn" onclick="playMediaById(${media.id})">▶ Play</button>
        </div>
      </div>
      <div class="card-quick-actions">
        <button class="card-star-btn ${media.user_starred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleStar('${escapedPath}');" title="${media.user_starred ? 'Remove Fave' : 'Fave'}">${media.user_starred ? '❤' : '🤍'}</button>
        <div class="card-rating-inline">${renderCardInlineRating(media, escapedPath)}</div>
        <button class="card-flag-btn ${isFlagged ? 'flagged' : ''}" onclick="event.stopPropagation(); toggleFlagDelete('${escapedPath}');" title="${isFlagged ? 'Unflag' : 'Flag'}">🚩</button>
      </div>
    </div>
  `;
}

/**
 * Render inline clickable rating stars for a card.
 */
function renderCardInlineRating(media, escapedPath) {
  const rating = media.user_rating || 0;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= rating;
    html += `<button class="card-rating-star ${filled ? 'filled' : ''}" onclick="event.stopPropagation(); quickRate('${escapedPath}', ${i === rating ? 0 : i}, this)" title="${i === rating ? 'Clear' : i + '/5'}">${filled ? '★' : '☆'}</button>`;
  }
  return html;
}

/**
 * Quick-rate from card — updates DB and re-renders just the star row.
 */
function quickRate(filepath, rating, btnEl) {
  if (typeof setRating !== 'function') return;
  setRating(filepath, rating);
  // Re-render the rating stars in this card
  const container = btnEl.closest('.card-rating-inline');
  if (container) {
    const media = allMedia.find(m => m.filepath === filepath);
    if (media) {
      const escapedPath = escapeHtml(filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      container.innerHTML = renderCardInlineRating(media, escapedPath);
    }
  }
}

/* ── Pagination ───────────────────────────────────────────────────────────
   Prev, where you are, a slider for long jumps, Next. The numbered buttons and
   the "..." jump box are gone: with the page size following the window, a page
   number is a moving target, and the slider covers the one thing the numbers
   were really for, which is getting a long way in one gesture.

   The bar renders even on a single page so its height never changes under the
   grid — the row maths reserves that height, and a bar that came and went
   would re-lay the grid every time a filter narrowed the list to one page. */

let _pagerPages = -1;   // page count the bar was last built for

function renderPagination() {
  const pager = document.getElementById('pagination');
  if (!pager) return;

  // Continuous mode has no pages to step through, and the header already says
  // how many files matched, so the bar goes away entirely.
  if (libraryLayoutMode() === 'continuous') {
    if (pager.firstChild) { pager.innerHTML = ''; _pagerPages = -1; }
    return;
  }

  const count = pageCount();
  // Rebuilding the bar on every page flip made the row blink and dropped the
  // focus and the slider's drag with it. The markup only depends on the page
  // COUNT, so build it when that changes and otherwise just move the label
  // and the slider.
  if (_pagerPages !== count || !pager.querySelector('#pagerRange')) {
    buildPager(count);
    _pagerPages = count;
  }
  updatePagerState();
}

function buildPager(count) {
  const pager = document.getElementById('pagination');
  pager.innerHTML = `
    <button class="pager-btn" id="pagerPrev" title="Previous page (Page Up)">← Prev</button>
    <span class="pager-pos" id="pagerPos" aria-live="polite"></span>
    <input type="range" class="pager-range" id="pagerRange" min="1" max="${count}" step="1"
      value="1" aria-label="Jump to a page" title="Drag to jump">
    <button class="pager-btn" id="pagerNext" title="Next page (Page Down)">Next →</button>`;

  pager.querySelector('#pagerPrev').addEventListener('click', () => movePage(-1));
  pager.querySelector('#pagerNext').addEventListener('click', () => movePage(1));

  const range = pager.querySelector('#pagerRange');
  // While dragging, only the label moves: re-rendering the grid mid-drag would
  // replace the slider under the pointer and drop the drag.
  range.addEventListener('input', () => {
    setPagerLabel(Number(range.value), pageCount());
  });
  range.addEventListener('change', () => {
    setPageAnchor((Number(range.value) - 1) * Math.max(1, pageSize));
  });
}

function setPagerLabel(page, count) {
  const pos = document.getElementById('pagerPos');
  if (pos) pos.textContent = `Page ${page.toLocaleString()} of ${count.toLocaleString()}`;
}

/** Everything about the bar that changes when the page does. */
function updatePagerState() {
  const count = pageCount();
  const page = pageNumber();
  setPagerLabel(page, count);
  const range = document.getElementById('pagerRange');
  if (range) {
    if (String(range.value) !== String(page)) range.value = String(page);
    range.disabled = count <= 1;
  }
  const prev = document.getElementById('pagerPrev');
  const next = document.getElementById('pagerNext');
  if (prev) prev.disabled = page <= 1;
  if (next) next.disabled = page >= count;
}

/** Kept for callers that still think in page numbers. */
function goToPage(page) {
  setPageAnchor((Math.max(1, page) - 1) * Math.max(1, pageSize));
}
