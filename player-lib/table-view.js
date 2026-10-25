/* =========================================================================
   TABLE VIEW - the library as rows (Modern library look only).

   A switch in the library toolbar (Grid / Table) picks how the results show.
   Table rows carry a small picture, Title, Duration, Rating, Size, Added and
   Tags; a Columns menu hides and shows columns (persisted); clicking a header
   sorts through the SAME sort setting as the Sort control (the server sorts,
   as it does for the grid), so the two always agree.

   It is the grid's machinery with rows for tiles, not a second list:
     - pages mode: one page = as many whole rows as fit under the bars, and
       the anchor, pager, wheel and Page Up / Down all work as for tiles
       (gridMetrics.cols is 1, pageSize is the row count);
     - continuous mode: the grid's own virtualization. contState and the
       .grid-virt spacer have the shape cards.js and dock.js already read
       (cols 1, stride = row height), so the scroll handler, the dock's arrow
       keys and the anchor restore need nothing new.
   Rows are .media-tile elements with a .tile-select checkbox, so selection
   (shift ranges too), the dock's click-to-preview and double-click-to-play,
   the busy and selected marks and privacy blurs apply as they do to tiles.

   The grid stays for: Classic, the Faces tab (its tiles carry face extras),
   and the Collections home (collection cards, not files).

   Hooks cards.js calls (guarded with typeof at the call site):
   - tableViewRender()    top of renderResults / renderContinuous; true = drawn here
   - tableViewActive()    top of renderContinuousWindow
   - tvRenderWindow()     the continuous scroll pass while the table shows
   ========================================================================= */

const TV_ROW_H = 48;             // px, one row including its 1px divider

/* `sort` is the sortSelect value the header click picks. Title cannot be
   hidden: a row needs something to read. `min` is the narrowest the column
   gets; when the table is too narrow for every chosen column (rail and dock
   both open on a small screen), columns step aside in `drop` order, lowest
   first, rather than run off the edge. */
const TV_COLUMNS = [
  { key: 'thumb',    label: 'Picture',  head: '',         width: '72px',  min: 72,  drop: 6 },
  { key: 'title',    label: 'Title',    head: 'Title',    width: 'minmax(160px, 3fr)', min: 160, sort: 'name', fixed: true },
  { key: 'duration', label: 'Duration', head: 'Duration', width: '80px',  min: 80,  drop: 5, sort: 'duration', align: 'end' },
  { key: 'rating',   label: 'Rating',   head: 'Rating',   width: '92px',  min: 92,  drop: 4, sort: 'rating' },
  { key: 'size',     label: 'Size',     head: 'Size',     width: '80px',  min: 80,  drop: 3, sort: 'size', align: 'end' },
  { key: 'added',    label: 'Added',    head: 'Added',    width: '100px', min: 100, drop: 2, sort: 'processed' },
  { key: 'tags',     label: 'Tags',     head: 'Tags',     width: 'minmax(140px, 2fr)', min: 140, drop: 1 },
];
const TV_SEL_W = 32;             // the checkbox column
const TV_GAP = 12;               // column-gap (css/table-view.css)
const TV_PAD = 16;               // row side padding, both sides together

let _tvHeadH = 34;               // measured off the rendered header
let _tvCorrecting = false;
let _tvShown = null;             // the columns this render draws (chosen, then fitted)

/** The columns the user chose in the Columns menu. */
function tvChosenColumns() {
  const stored = typeof window.vaultTableColumns === 'function' ? window.vaultTableColumns() : null;
  return TV_COLUMNS.filter(c => c.fixed || !stored || stored.includes(c.key));
}

/** The chosen columns that fit this width, dropping the least needed first. */
function tvFitColumns(width) {
  let cols = tvChosenColumns();
  const need = (list) => TV_SEL_W + TV_PAD + list.reduce((n, c) => n + c.min + TV_GAP, 0);
  while (width > 0 && need(cols) > width) {
    const next = cols.filter(c => c.drop).sort((a, b) => a.drop - b.drop)[0];
    if (!next) break;
    cols = cols.filter(c => c !== next);
  }
  return cols;
}

function tvVisibleColumns() {
  return _tvShown || tvChosenColumns();
}

function tableViewActive() {
  if (!(typeof isModernLayout === 'function' && isModernLayout())) return false;
  if (!(typeof window.vaultLibraryView === 'function' && window.vaultLibraryView() === 'table')) return false;
  const main = document.getElementById('mainContainer');
  if (!main || main.classList.contains('faces-on')) return false;
  if (typeof collectionsHomeShowing === 'function' && collectionsHomeShowing()) return false;
  return true;
}

/** Draw the table if it is the view; otherwise undo its marks and say no. */
function tableViewRender() {
  const grid = document.getElementById('resultsGrid');
  const main = document.getElementById('mainContainer');
  const colsBtn = document.getElementById('tableColumnsBtn');
  const on = !!grid && tableViewActive();
  if (main) main.classList.toggle('tv-on', on);
  if (colsBtn) colsBtn.hidden = !on;
  if (!on) {
    if (grid && grid.classList.contains('grid-table')) {
      grid.classList.remove('grid-table', 'tv-continuous');
      grid.style.removeProperty('--tv-cols');
      delete grid.dataset.tvShape;
    }
    return false;
  }
  const cont = libraryLayoutMode() === 'continuous';
  grid.classList.remove('grid-pages', 'grid-continuous');
  grid.classList.add('grid-table');
  grid.classList.toggle('tv-continuous', cont);
  grid.style.removeProperty('--tile-h');
  grid.style.removeProperty('grid-template-columns');
  // The grid's continuous skeleton is not ours: make it rebuild when it is back.
  delete grid.dataset.gridShape;
  _tvShown = tvFitColumns(grid.clientWidth);
  grid.style.setProperty('--tv-cols',['32px', ...tvVisibleColumns().map(c => c.width)].join(' '));
  const header = document.getElementById('appHeader');
  grid.style.setProperty('--tv-sticky-top', `${Math.round(header ? header.getBoundingClientRect().height : 0)}px`);
  if (cont) tvRenderContinuous(grid);
  else tvRenderPages(grid);
  return true;
}

/* ── Markup ────────────────────────────────────────────────────────────── */

function tvHeadHtml() {
  const field = typeof currentSortField === 'function' ? currentSortField() : '';
  const dir = typeof currentSortDir === 'function' ? currentSortDir() : 'desc';
  const cells = tvVisibleColumns().map(c => {
    const align = c.align === 'end' ? ' tv-end' : '';
    if (!c.sort) return `<div class="tv-hcell tv-c-${c.key}${align}" role="columnheader">${escapeHtml(c.head)}</div>`;
    const on = field === c.sort;
    const sortWord = dir === 'asc' ? 'ascending' : 'descending';
    return `<button type="button" class="tv-hcell tv-sortable tv-c-${c.key}${align}${on ? ' is-sorted' : ''}"
        role="columnheader" data-tv-sort="${c.sort}" aria-sort="${on ? sortWord : 'none'}"
        title="Sort by ${escapeHtml(c.label.toLowerCase())}">${escapeHtml(c.head)}${on ? `<span class="tv-sort-ind">${vaultIcon(dir === 'asc' ? 'arrow-up' : 'arrow-down') || (dir === 'asc' ? '▲' : '▼')}</span>` : ''}</button>`;
  }).join('');
  return `<div class="tv-head" role="row"><div class="tv-hcell tv-c-sel"></div>${cells}</div>`;
}

function tvStars(n) {
  n = Math.max(0, Math.min(5, Number(n) || 0));
  if (!n) return '<span class="tv-muted">Not rated</span>';
  return `<span class="tv-stars" title="Rated ${n} of 5">${'★'.repeat(n)}<span class="tv-stars-off">${'★'.repeat(5 - n)}</span></span>`;
}

function tvCellHtml(c, m) {
  const id = m.id;
  switch (c.key) {
    case 'thumb': {
      const icon = vaultTypeIcon(m.media_type);
      const canThumb = canShowThumb(m);
      const img = canThumb
        ? `<img class="tile-img" loading="lazy" ${thumbImgAttrs(m)} alt=""
             onerror="this.parentElement.classList.add('thumb-fallback'); this.remove();">`
        : '';
      return `<div class="tv-cell tv-c-thumb ${canThumb ? '' : 'thumb-fallback'}" onclick="tileThumbClick(${id})"
          ondblclick="tileThumbDblClick(${id})">${img}<span class="tv-type-icon">${icon}</span></div>`;
    }
    case 'title': {
      const pmNames = document.body.classList.contains('pm-names');
      return `<div class="tv-cell tv-c-title">
          <span class="tile-name tv-name" onclick="tileThumbClick(${id})" ondblclick="tileThumbDblClick(${id})"
                ${pmNames ? '' : `title="${escapeHtml(m.filename)}"`}>${escapeHtml(m.filename)}</span>
          ${typeof watchTagHtml === 'function' ? watchTagHtml(m) : ''}
          ${m.user_starred ? `<span class="tv-fave" title="Favorite">${vaultIconSwap('❤', 'heart')}</span>` : ''}
          ${m.user_flagged_delete ? `<span class="tv-flag" title="Flagged for deletion">${vaultIconSwap('🚩', 'flag')}</span>` : ''}
          <span class="tv-actions" onclick="event.stopPropagation()">
            <button type="button" class="tile-btn ${m.user_starred ? 'active-star' : ''}" onclick="toggleStar(mediaPathById(${id}))"
                    title="${m.user_starred ? 'Remove from favorites' : 'Add to favorites'}" aria-label="${m.user_starred ? 'Remove from favorites' : 'Add to favorites'}">${vaultIconSwap(m.user_starred ? '❤' : '🤍', 'heart')}</button>
            <button type="button" class="tile-btn" onclick="showDetailsById(${id})" title="Details" aria-label="Details">${vaultIconSwap('ⓘ', 'info')}</button>
          </span>
        </div>`;
    }
    case 'duration':
      return `<div class="tv-cell tv-c-duration tv-end">${m.duration_seconds ? formatDuration(m.duration_seconds) : '<span class="tv-muted">-</span>'}</div>`;
    case 'rating':
      return `<div class="tv-cell tv-c-rating">${tvStars(m.user_rating)}</div>`;
    case 'size':
      return `<div class="tv-cell tv-c-size tv-end">${m.filesize_bytes ? formatFileSize(m.filesize_bytes) : '<span class="tv-muted">-</span>'}</div>`;
    case 'added':
      return `<div class="tv-cell tv-c-added">${m.processed_at ? escapeHtml(String(m.processed_at).slice(0, 10)) : '<span class="tv-muted">-</span>'}</div>`;
    case 'tags': {
      const tags = [...new Set([...safeParseJSON(m.themes, []), ...safeParseJSON(m.tags, [])])].slice(0, 8);
      return `<div class="tv-cell tv-c-tags">${tags.map(t => `<span class="tag">${escapeHtml(String(t))}</span>`).join('')}</div>`;
    }
    default:
      return '<div class="tv-cell"></div>';
  }
}

function tvRowHtml(m, style) {
  const isSelected = typeof selectedIds !== 'undefined' && selectedIds.has(m.id);
  const cls = [
    'media-tile', 'tv-row',
    m.missing_since ? 'tile-missing' : '',
    m.user_flagged_delete ? 'tile-flagged' : '',
    m.user_trashed ? 'tile-trashed' : '',
    isSelected ? 'tile-selected' : '',
    m.id === lastOpenedMediaId ? 'tile-last-opened' : '',
    (typeof isCardBusy === 'function' && isCardBusy(m.id)) ? 'tile-busy' : '',
  ].filter(Boolean).join(' ') + (typeof dockTileClass === 'function' ? dockTileClass(m.id) : '');
  return `<div class="${cls}" data-id="${m.id}" role="row"${style ? ` style="${style}"` : ''}>
      <div class="tv-cell tv-c-sel"><input type="checkbox" class="tile-select" ${isSelected ? 'checked' : ''}
        onclick="onTileSelect(event, ${m.id})" title="Select (shift-click for range)" aria-label="Select"></div>
      ${tvVisibleColumns().map(c => tvCellHtml(c, m)).join('')}
    </div>`;
}

function tvSkeletonHtml(style) {
  return `<div class="media-tile tv-row tile-skel" aria-hidden="true"${style ? ` style="${style}"` : ''}></div>`;
}

/** Row markup for result positions [start, end), placeholders where rows are missing. */
function tvRowsHtml(start, end, positioned) {
  let html = '';
  let missing = 0;
  const ids = [];
  for (let i = start; i < end; i++) {
    const id = Library.idAt(i);
    const row = id ? Library.row(id) : null;
    const style = positioned ? `top:${i * TV_ROW_H}px` : '';
    if (id) ids.push(id);
    if (row) {
      html += tvRowHtml(row, style);
      if (Library.needsFetch(id)) missing++;
    } else {
      html += tvSkeletonHtml(style);
      if (!id || Library.needsFetch(id)) missing++;
    }
  }
  return { html, missing, ids };
}

function tvEmptyHtml() {
  return Library.known() && Library.length() === 0 ? '<div class="tv-empty">No files match.</div>' : '';
}

/* ── Pages mode ────────────────────────────────────────────────────────── */

function tvRenderPages(grid) {
  // Whole rows under the bars, the same budget updateGridLayout() uses.
  const gridTop = grid.getBoundingClientRect().top + window.scrollY;
  const avail = window.innerHeight - gridTop - _tvHeadH - pagerH - PAGER_MARGIN - BOTTOM_RESERVE;
  const rows = Math.max(1, Math.floor(avail / TV_ROW_H));
  gridMetrics = { cols: 1, rows, tileW: 0, natH: TV_ROW_H, rowH: TV_ROW_H };
  if (rows !== pageSize) pageSize = rows;
  clampPageAnchor();

  const end = Math.min(pageAnchor + pageSize, Library.length());
  currentPage = Math.floor(pageAnchor / Math.max(1, pageSize)) + 1;
  const r = tvRowsHtml(pageAnchor, end, false);
  grid.innerHTML = tvHeadHtml() + `<div class="tv-body" role="rowgroup">${r.html}</div>` + tvEmptyHtml();
  hydrateThumbs(grid);
  renderPagination();
  Library.pin('grid', r.ids);
  const pastFirst = !Library.known() && pageAnchor + pageSize > Library.firstPageIds.length;
  if (r.missing || pastFirst) fillRowsThen(pageAnchor, pageAnchor + pageSize, renderResults);
  else {
    markFirstTiles(r.ids.length);
    Library.firstPageShown();
  }
  if (typeof renderSelectionBar === 'function') renderSelectionBar();
  if (typeof dockAfterGridRender === 'function') dockAfterGridRender();

  // One correction pass: the header and pager heights are only known once drawn.
  if (!_tvCorrecting) {
    _tvCorrecting = true;
    try {
      const head = grid.querySelector('.tv-head');
      let changed = false;
      if (head && head.offsetHeight > 0 && Math.abs(head.offsetHeight - _tvHeadH) > 1) {
        _tvHeadH = head.offsetHeight;
        changed = true;
      }
      if (remeasureGridChrome() || changed) tvRenderPages(grid);
    } finally {
      _tvCorrecting = false;
    }
    if (!r.missing) prefetchAdjacentPages();
  }
}

/* ── Continuous mode ───────────────────────────────────────────────────── */

function tvRenderContinuous(grid) {
  const total = Library.length();
  const shape = `${total}|${tvVisibleColumns().map(c => c.key).join(',')}`;
  let virt = grid.querySelector('.grid-virt');
  const head = grid.querySelector('.tv-head');
  if (!virt || !head || grid.dataset.tvShape !== shape) {
    grid.innerHTML = tvHeadHtml() + '<div class="grid-virt" role="rowgroup"></div>' + tvEmptyHtml();
    grid.dataset.tvShape = shape;
    virt = grid.querySelector('.grid-virt');
  } else {
    // Same rows, maybe a new sort: the header's arrow moves.
    head.outerHTML = tvHeadHtml();
  }
  virt.style.height = `${Math.max(0, total * TV_ROW_H)}px`;
  contState = { cols: 1, stride: TV_ROW_H, totalRows: total, first: -1, last: -1 };
  pageSize = Math.max(1, Math.floor(window.innerHeight / TV_ROW_H));
  gridMetrics = { cols: 1, rows: pageSize, tileW: 0, natH: TV_ROW_H, rowH: TV_ROW_H };
  tvRenderWindow();
  renderPagination();
}

/** Swap in the rows for the current scroll position (cards.js calls this on scroll). */
function tvRenderWindow() {
  const virt = document.querySelector('#resultsGrid .grid-virt');
  if (!virt) return;
  const { stride, totalRows } = contState;
  const r = continuousRange(stride, totalRows);
  contState.first = r.first;
  contState.last = r.last;
  const rows = tvRowsHtml(Math.max(0, r.first), Math.min(totalRows, r.last + 1), true);
  virt.innerHTML = rows.html;
  hydrateThumbs(virt);
  Library.pin('grid', rows.ids);
  if (rows.missing) fillRowsThen(Math.max(0, r.first), r.last + 1, tvRenderWindow);
  else {
    markFirstTiles(rows.ids.length);
    Library.firstPageShown();
    prefetchContinuousRows();
  }
  updateScrollTopPill();
  pageAnchor = Math.max(0, Math.min(Math.max(0, Library.length() - 1), Math.floor(Math.max(0, r.y) / (stride || 1))));
  currentPage = Math.floor(pageAnchor / Math.max(1, pageSize)) + 1;
  if (typeof renderSelectionBar === 'function') renderSelectionBar();
  if (typeof dockAfterGridRender === 'function') dockAfterGridRender();
}

/* ── Toolbar: Grid / Table, header sort, columns ─────────────────────────── */

function tvSyncControls() {
  const view = typeof window.vaultLibraryView === 'function' ? window.vaultLibraryView() : 'grid';
  document.querySelectorAll('#viewSwitch .view-switch-btn').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.view === view ? 'true' : 'false'));
}

function tvSetView(view) {
  window.vaultSetLibraryView?.(view);
  tvSyncControls();
  window.vaultRelayoutLibrary?.();
}

/** A header click drives the toolbar's own sort controls, so both agree. */
function tvSortBy(field) {
  const select = document.getElementById('sortSelect');
  if (!select) return;
  if (typeof currentSortField === 'function' && currentSortField() === field) {
    document.getElementById('sortDirBtn')?.click();
  } else {
    select.value = field;
    select.dispatchEvent(new Event('change'));
  }
}

function tvOpenColumnsPopover(anchor) {
  const shown = new Set(tvChosenColumns().map(c => c.key));
  openFilterPopover(anchor, {
    title: 'Columns',
    items: [],
    body: `<div class="fpop-checks" role="group" aria-label="Columns">
      ${TV_COLUMNS.filter(c => !c.fixed).map(c => `
        <label class="fpop-check">
          <input type="checkbox" data-tv-col="${c.key}" ${shown.has(c.key) ? 'checked' : ''}>
          <span class="fpop-check-text"><span class="fpop-check-label">${escapeHtml(c.label)}</span></span>
        </label>`).join('')}
    </div>${tvVisibleColumns().length < tvChosenColumns().length
      ? '<p class="tv-cols-note">Some columns are hidden because the table is narrow. Close the side panels or widen the window to see them.</p>'
      : ''}`,
    wireBody: (el) => {
      el.querySelectorAll('[data-tv-col]').forEach(box => {
        box.addEventListener('change', () => {
          const keys = [...el.querySelectorAll('[data-tv-col]')].filter(b => b.checked).map(b => b.dataset.tvCol);
          window.vaultSetTableColumns?.(keys);
          window.vaultRelayoutLibrary?.();
        });
      });
      el.querySelector('input')?.classList.add('fpop-focusable');
    },
  });
}

function tvInit() {
  document.getElementById('viewSwitch')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) tvSetView(btn.dataset.view);
  });
  document.getElementById('tableColumnsBtn')?.addEventListener('click', (e) => tvOpenColumnsPopover(e.currentTarget));
  document.getElementById('resultsGrid')?.addEventListener('click', (e) => {
    const h = e.target.closest('[data-tv-sort]');
    if (h) tvSortBy(h.dataset.tvSort);
  });
  window.addEventListener('vault:layout-style', () => {
    tvSyncControls();
    // Classic has no table: the grid comes back (layout-modern.js re-lays).
  });
  tvSyncControls();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tvInit);
} else {
  tvInit();
}
