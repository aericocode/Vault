/* =========================================================================
   DOCK - the docked preview pane (Modern library look only).

   In Classic a tile click plays the file and the details live in the modal
   and the player's slide-over sidebar. In Modern the user can dock a preview
   column on the right of the library: the grid shrinks to make room (nothing
   is covered), a single click on a tile shows it here, a double click or
   Enter plays it, and the arrow keys walk the grid with the pane following.

   The pane is deliberately a PREVIEW, not a third copy of the full detail
   view: renderDetailBody's Subtitles / Music / Faces sections and inline
   editors find their markup by element id and repaint the modal or the
   player sidebar, so a live second copy would fight them. Everything editable
   that does not use ids (fave, rating, flag) works here, and description,
   tags, themes, places, collections and notes have their own in-place
   editors (dock-edit.js) that save through the same calls; "Details" opens
   the full view.

   The pane is painted as named parts (data-dock-part). For the same file a
   repaint replaces only the parts whose HTML changed, and a part being
   edited keeps its editor and the focus (dockPatchParts).

   Shown only when all of these hold: Modern look, pane open (toggle button,
   persisted), window at least DOCK_MIN_WINDOW wide (narrower windows keep
   today's behaviour), and a tab whose content is the media grid.

   Hooks other modules call (all guarded with typeof at the call site):
   - dockIsShown()             is the pane on screen right now
   - dockSelectFromClick(id)   cards.js tile click; true = handled here
   - dockTileClass(id)         cards.js renderTile: the selected-tile class
   - dockAfterGridRender()     cards.js after each grid render
   ========================================================================= */

const DOCK_MIN_WINDOW = 1100;   // below this, Modern falls back to no dock
const DOCK_MIN_WIDTH = 300;
const DOCK_MAX_SHARE = 0.5;     // of the window width

let _dockShown = false;
let _dockSelectedId = null;
let _dockSig = '';              // what the pane last painted, to skip no-op repaints
let _dockPaintedId = null;      // the file the pane's parts were painted for

function dockIsShown() { return _dockShown; }

function dockClampWidth(px) {
  const max = Math.max(DOCK_MIN_WIDTH, Math.floor(window.innerWidth * DOCK_MAX_SHARE));
  return Math.min(max, Math.max(DOCK_MIN_WIDTH, Math.round(Number(px) || 0)));
}

/** Is the media grid the thing on screen (Library, Collections, a person on Faces)? */
function dockGridTabVisible() {
  const main = document.getElementById('mainContainer');
  if (!main || main.style.display === 'none') return false;
  if (!main.classList.contains('active')) return false;
  // The Faces home is a page of people, not files: nothing to preview.
  if (main.classList.contains('faces-home')) return false;
  return true;
}

function dockShouldShow() {
  return typeof isModernLayout === 'function' && isModernLayout()
    && typeof window.vaultDockOpen === 'function' && window.vaultDockOpen()
    && window.innerWidth >= DOCK_MIN_WINDOW
    && dockGridTabVisible();
}

function dockApplyWidth(px) {
  const w = dockClampWidth(px);
  document.documentElement.style.setProperty('--dock-w', `${w}px`);
  return w;
}

/** The pane sits under the sticky header; follow its bottom edge. */
function dockUpdateTop() {
  const header = document.getElementById('appHeader');
  const bottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  document.documentElement.style.setProperty('--dock-top', `${Math.round(bottom)}px`);
}

/** Put the pane on or off screen to match the settings, the window and the tab. */
function dockSync(opts) {
  const dock = document.getElementById('libraryDock');
  const btn = document.getElementById('dockToggleBtn');
  const open = typeof window.vaultDockOpen === 'function' && window.vaultDockOpen();
  if (btn) btn.setAttribute('aria-pressed', open ? 'true' : 'false');
  const show = dockShouldShow();
  if (show) {
    dockApplyWidth(window.vaultDockWidth?.());
    dockUpdateTop();
  }
  if (show === _dockShown) return;
  _dockShown = show;
  document.body.classList.toggle('dock-shown', show);
  if (dock) dock.hidden = !show;
  if (show) {
    // Opening with nothing picked: start from the file the user last played,
    // if it is in the results, so the pane has something to say straight away.
    if (_dockSelectedId == null && typeof lastOpenedMediaId !== 'undefined' && lastOpenedMediaId != null
        && Library.indexOf(lastOpenedMediaId) >= 0) {
      _dockSelectedId = lastOpenedMediaId;
    }
    _dockSig = '';
    dockRender();
  } else {
    Library.pin('dock', null);
  }
  dockPaintSelection();
  // The grid's width just changed: re-lay it now rather than wait for the
  // resize observer, so the columns never flash at the old count. (Not at
  // boot: the library has not loaded yet, and its first render lays out.)
  if (!(opts && opts.boot)) window.vaultRelayoutLibrary?.();
}

function dockSetOpen(open) {
  window.vaultSetDockOpen?.(open);
  dockSync();
}

function dockToggle() {
  dockSetOpen(!(typeof window.vaultDockOpen === 'function' && window.vaultDockOpen()));
}

/* ── Selection ─────────────────────────────────────────────────────────── */

function dockTileClass(id) {
  return _dockShown && id === _dockSelectedId ? ' tile-docked' : '';
}

/** Mark the selected tile without re-rendering the grid. */
function dockPaintSelection() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return;
  grid.querySelectorAll('.media-tile.tile-docked').forEach(t => {
    if (!_dockShown || Number(t.dataset.id) !== _dockSelectedId) t.classList.remove('tile-docked');
  });
  if (_dockShown && _dockSelectedId != null) {
    grid.querySelector(`.media-tile[data-id="${_dockSelectedId}"]`)?.classList.add('tile-docked');
  }
}

function dockSelect(id) {
  _dockSelectedId = id;
  Library.pin('dock', [id]);
  dockPaintSelection();
  dockRender();
}

function dockSelectFromClick(id) {
  if (!_dockShown) return false;
  if (typeof hideTilePopover === 'function') hideTilePopover();
  dockSelect(id);
  return true;
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

function dockFieldSig(m) {
  return m ? [m.id, m.filename, m.filepath, m.user_rating, m.user_starred, m.user_flagged_delete,
    m.user_trashed, m.view_count, m.description, m.tags, m.themes, m.locations, m.user_notes,
    typeof dockCollectionsSig === 'function' ? dockCollectionsSig(m.id) : '',
    m.duration_seconds, m.width, m.height, m.filesize_bytes, m.processed_at].join('\u0001') : 'none';
}

function dockEmptyHtml() {
  return `<div class="dock-empty">
      <div class="dock-empty-icon" aria-hidden="true">${vaultIconSwap('🖼️', 'image')}</div>
      <p>Click a tile to preview it here.</p>
      <p class="dock-empty-hint">Double click or press Enter to play. Arrow keys move between tiles.</p>
    </div>`;
}

/** The pane for one file as [part name, outer HTML] in order, top to bottom. */
function dockPartsHtml(m) {
  // Classic's emoji, Modern's line icons (player-lib/icons.js)
  const icon = vaultTypeIcon(m.media_type);
  const canThumb = typeof canShowThumb === 'function'
    ? canShowThumb(m)
    : ['image', 'gif', 'video', 'mix'].includes(m.media_type);
  const thumb = canThumb
    ? `<img class="tile-img dock-img" ${thumbImgAttrs(m)} alt=""
         onerror="this.parentElement.classList.add('thumb-fallback'); this.remove();">`
    : '';
  const facts = [
    ['Type', m.media_type || ''],
    ['Length', m.duration_seconds ? formatDuration(m.duration_seconds) : ''],
    ['Size', m.width && m.height ? `${m.width}×${m.height}` : ''],
    ['File', m.filesize_bytes ? formatFileSize(m.filesize_bytes) : ''],
    ['Views', String(m.view_count || 0)],
    ['Added', m.processed_at ? String(m.processed_at).slice(0, 10) : ''],
  ].filter(([, v]) => v);
  const escapedPath = escapeHtml(m.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const flagged = !!m.user_flagged_delete;

  const parts = [
    ['thumb', `<div class="dock-thumb tile-thumb ${canThumb ? '' : 'thumb-fallback'}" data-dock-part="thumb"
         ondblclick="dockPlayPick(${m.id})" title="Double click to play">
      ${thumb}
      <span class="tile-type-icon">${icon}</span>
    </div>`],
    ['name', `<div class="dock-name" data-dock-part="name">${escapeHtml(m.filename)}</div>`],
    ['actions', `<div class="dock-actions" data-dock-part="actions">
      <button class="dock-btn dock-btn-primary" onclick="dockPlayPick(${m.id})">${vaultIconSwap('▶ ', 'play')}Play</button>
      ${typeof UpNext === 'undefined' ? '' : `<button class="dock-btn" onclick="upNextAddFrom(${m.id}, 'next', 'dock')" title="Play this file after the one playing now (Shift+U)">Play next</button>
      <button class="dock-btn" onclick="upNextAddFrom(${m.id}, 'end', 'dock')" title="Add this file to the end of Up next (U)">+ Up next</button>`}
      <button class="dock-btn" onclick="showDetailsById(${m.id})">Details</button>
      <button class="dock-btn ${flagged ? 'is-on' : ''}" onclick="toggleFlagDelete(mediaPathById(${m.id}))"
              title="${flagged ? 'Unflag' : 'Flag this file'}" aria-label="${flagged ? 'Unflag' : 'Flag this file'}">${vaultIconSwap('🚩', 'flag')}</button>
      <button class="dock-btn" onclick="copyPath('${escapedPath}')" title="Copy the full path">${vaultIcon('copy', 'modern-only vi-gap')}Copy path</button>
    </div>`],
    ['rating', `<div class="dock-rating" data-dock-part="rating">${typeof renderStarRatingSection === 'function' ? renderStarRatingSection(m) : ''}</div>`],
  ];
  if (typeof dockEditPartHtml === 'function') {
    for (const key of DOCK_EDIT_PARTS) parts.push([key, dockEditPartHtml(m, key)]);
  }
  parts.push(['facts', `<dl class="dock-facts" data-dock-part="facts">
      ${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join('')}
    </dl>`]);
  parts.push(['path', `<div class="detail-path dock-path" data-dock-part="path">${escapeHtml(m.filepath)}</div>`]);
  return parts;
}

function dockBodyHtml(m) {
  return dockPartsHtml(m).map(([, html]) => html).join('\n');
}

/** Remember what each painted part was made from, to skip unchanged ones. */
function dockStampParts(root, parts) {
  const byKey = new Map(parts);
  root.querySelectorAll('[data-dock-part]').forEach((el) => { el._dockHtml = byKey.get(el.dataset.dockPart); });
}

/** Same file, new data: replace the parts that changed. A part being edited
 *  keeps its editor and the focus; only its label, chips and notes follow. */
function dockPatchParts(body, m) {
  const parts = dockPartsHtml(m);
  for (const [key, html] of parts) {
    const el = body.querySelector(`[data-dock-part="${key}"]`);
    if (!el || el._dockHtml === html) continue;
    if (typeof dockEditPartBusy === 'function' && dockEditPartBusy(el)) {
      dockEditPatchBusy(el, html);
      el._dockHtml = null;            // compare afresh once the edit is over
      continue;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const fresh = tpl.content.firstElementChild;
    if (!fresh) continue;
    fresh._dockHtml = html;
    el.replaceWith(fresh);
    if (key === 'thumb' && typeof hydrateThumbs === 'function') hydrateThumbs(fresh.parentElement || body);
  }
}

function dockRender() {
  const body = document.getElementById('dockBody');
  if (!body || !_dockShown) return;
  const m = _dockSelectedId != null ? Library.row(_dockSelectedId) : null;
  if (_dockSelectedId != null && !m) {
    // Not cached yet (arrowed onto a tile whose row has not arrived): fetch it.
    const want = _dockSelectedId;
    Library.fetchRows?.([want])?.then?.(() => { if (want === _dockSelectedId) dockRender(); }).catch?.(() => {});
  }
  const sig = dockFieldSig(m);
  if (sig === _dockSig) return;
  _dockSig = sig;
  if (m && m.id === _dockPaintedId && body.querySelector('[data-dock-part]')) {
    dockPatchParts(body, m);
    return;
  }
  // Another file (or none): anything still being typed is saved to the file
  // it was typed for before its fields go.
  if (typeof dockEditCommitAll === 'function') dockEditCommitAll(body);
  _dockPaintedId = m ? m.id : null;
  if (m) {
    const parts = dockPartsHtml(m);
    body.innerHTML = parts.map(([, html]) => html).join('\n');
    dockStampParts(body, parts);
  } else {
    body.innerHTML = dockEmptyHtml();
  }
  body.scrollTop = 0;
  if (typeof hydrateThumbs === 'function') hydrateThumbs(body);
}

/** Repaint now even though the row looks unchanged (an edit's own state:
 *  chips waiting on their save, the "Saved" tick, a picker list). */
function dockRefresh() {
  _dockSig = '';
  dockRender();
}

/** cards.js calls this after every grid render: a fave, rating or flag set
 *  anywhere repaints the grid, and the pane follows when its file changed. */
function dockAfterGridRender() {
  if (!_dockShown) return;
  dockDropIfGone();
  dockRender();
}

/* A new search or filter can take the picked file out of the results. Then
   the pane lets it go (and says "click a tile"), so the arrow keys start
   again from the first tile on screen instead of from a file not listed. */
function dockForget() {
  _dockSelectedId = null;
  Library.pin('dock', null);
  dockPaintSelection();
  dockRender();
}

/** Is the pick one of the current results? Only a yes/no once the answer is
 *  certain: null while just the first page's ids are here and it is not
 *  among them (the full id list will tell). */
function dockPickInResults(id) {
  if (id == null) return false;
  if (Library.indexOf(id) >= 0) return true;
  // indexOf searched the full list, or the first page is the whole result.
  if (Library.ids || (Library.known() && Library.length() <= Library.firstPageIds.length)) return false;
  return null;
}

function dockDropIfGone() {
  const id = _dockSelectedId;
  const inResults = dockPickInResults(id);
  if (id == null || inResults === true) return;
  if (inResults === false) { dockForget(); return; }
  // Only the first page's ids are here yet: decide once the list is in.
  // (vault:results-counted below asks again too, as a second chance.)
  Library.waitIds().then((ids) => {
    if (ids && id === _dockSelectedId && !ids.includes(id)) dockForget();
  }).catch(() => {});
}

/** Play the pick, but never a file a search or filter has taken out of the
 *  results: the pane may not have caught up yet. */
function dockPlayPick(id) {
  if (id == null) return;
  const inResults = dockPickInResults(id);
  if (inResults === true) { playMediaById(id); return; }
  if (inResults === false) { dockDropIfGone(); return; }
  // Past the first page with the full list still coming: ask it first.
  Library.waitIds().then((ids) => {
    if (!ids || id !== _dockSelectedId) return;
    if (ids.includes(id)) playMediaById(id); else dockForget();
  }).catch(() => {});
}

/* ── Keyboard: arrows walk the grid, Enter plays ─────────────────────────── */

function dockGridCols() {
  if (typeof libraryLayoutMode === 'function' && libraryLayoutMode() === 'continuous') {
    return Math.max(1, contState.cols || 1);
  }
  return Math.max(1, gridMetrics.cols || 1);
}

/** Bring the tile at this result index on screen. */
function dockReveal(index) {
  if (libraryLayoutMode() === 'continuous') {
    const virt = document.querySelector('#resultsGrid .grid-virt');
    if (!virt || !contState.stride) return;
    const cols = Math.max(1, contState.cols);
    const virtTop = virt.getBoundingClientRect().top + window.scrollY;
    const top = virtTop + Math.floor(index / cols) * contState.stride;
    // Table rows (table-view.js) have no gap, and a sticky column header
    // sits under the app header.
    const table = typeof tableViewActive === 'function' && tableViewActive();
    const bottom = top + contState.stride - (table ? 0 : GRID_GAP);
    const header = document.getElementById('appHeader');
    const stickyHead = table ? (document.querySelector('#resultsGrid .tv-head')?.offsetHeight || 0) : 0;
    const viewTop = window.scrollY + (header ? header.getBoundingClientRect().bottom : 0) + stickyHead + 8;
    const viewBottom = window.scrollY + window.innerHeight - 8;
    if (top < viewTop) window.scrollTo({ top: Math.max(0, top - (viewTop - window.scrollY)) });
    else if (bottom > viewBottom) window.scrollTo({ top: bottom - window.innerHeight + 8 });
    return;
  }
  const size = Math.max(1, pageSize);
  if (index < pageAnchor || index >= pageAnchor + size) {
    setPageAnchor(Math.floor(index / size) * size);
  }
}

/** On screen and not faded out (display:none anywhere above it has no rects). */
function dockLayerVisible(el) {
  if (!el.getClientRects().length) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
}

/* Is anything modal over the library? Asked generically rather than from a
   list: any visible layer with a class ending in "-overlay" (the player, the
   detail modal, gamify, the vault password and "Protect your library?"
   dialogs, import, faces, music, subtitles, games...) or any visible dialog
   (role=dialog, aria-modal, an open <dialog>). A dialog added later is
   covered without anyone remembering to list it here. */
function dockModalLayerOpen() {
  const els = document.querySelectorAll('[class*="-overlay"], [role="dialog"], [aria-modal="true"], dialog[open]');
  for (const el of els) {
    const dialog = el.matches('[role="dialog"], [aria-modal="true"], dialog');
    if (!dialog && ![...el.classList].some(c => c.endsWith('-overlay'))) continue;
    if (dockLayerVisible(el)) return true;
  }
  return false;
}

const DOCK_CONTROL_SEL = 'button, a, input, select, textarea, summary, [contenteditable]:not([contenteditable="false"]), '
  + '[role="button"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="separator"]';

/** The focused interactive element the key belongs to, if any (not a tile). */
function dockFocusedControl(el) {
  if (!el || !el.closest || el === document.body) return null;
  const ctl = el.closest(DOCK_CONTROL_SEL);
  if (!ctl || ctl.matches('.media-tile')) return null;
  return ctl;
}

function dockKeyBlocked(e) {
  if (!_dockShown) return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  // Shift+Enter is "new line" in the dock's text boxes; once a box closes
  // and focus falls to the page, it must not start playback.
  if (e.key === 'Enter' && e.shiftKey) return true;
  if (typeof isTypingTarget === 'function' && isTypingTarget(e.target)) return true;
  // Enter on a focused control keeps that control's own meaning (a rail
  // section header opens and closes, a button presses). The resize handle
  // (role=separator) has none for Enter, but must not play either. A tile
  // itself is not such a control.
  if (e.key === 'Enter' && dockFocusedControl(e.target)) return true;
  if (document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) return true;
  if (document.getElementById('miniPlayer')?.classList.contains('active')) return true;
  if (document.querySelector('.modal-overlay.active, .settings-overlay.active, .media-info-overlay.active, .filters-panel.active')) return true;
  if (typeof filterPopoverIsOpen === 'function' && filterPopoverIsOpen()) return true;
  if (dockModalLayerOpen()) return true;
  return false;
}

const DOCK_STEPS = { ArrowLeft: -1, ArrowRight: 1 };

document.addEventListener('keydown', (e) => {
  if (dockKeyBlocked(e)) return;
  if (e.key === 'Enter') {
    if (_dockSelectedId == null) return;
    e.preventDefault();
    dockPlayPick(_dockSelectedId);
    return;
  }
  let step = DOCK_STEPS[e.key];
  if (e.key === 'ArrowUp') step = -dockGridCols();
  if (e.key === 'ArrowDown') step = dockGridCols();
  if (!step) return;
  e.preventDefault();
  const total = Library.length();
  if (!total) return;
  const cur = _dockSelectedId != null ? Library.indexOf(_dockSelectedId) : -1;
  // Nothing picked (or the pick left the results): start at the first tile on screen.
  let next = cur < 0 ? pageAnchor : cur + step;
  if (next < 0 || next >= total) {
    // Up from the top row / down from the last row: stay put.
    if (cur >= 0) return;
    next = Math.min(Math.max(0, next), total - 1);
  }
  const id = Library.idAt(next);
  if (!id) return;
  dockReveal(next);
  dockSelect(id);
});

/* ── Resizing: drag the pane's left edge ────────────────────────────────── */

function dockInitResizer() {
  const handle = document.getElementById('dockResizer');
  if (!handle) return;
  let dragging = false;
  let width = 0;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    document.body.classList.add('dock-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    width = dockApplyWidth(window.innerWidth - e.clientX);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dock-resizing');
    if (width) window.vaultSetDockWidth?.(width);
    window.vaultRelayoutLibrary?.();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  // Keyboard: the handle is focusable, arrows widen / narrow it.
  handle.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? 20 : e.key === 'ArrowRight' ? -20 : 0;
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    const w = dockApplyWidth((window.vaultDockWidth?.() || 380) + d);
    window.vaultSetDockWidth?.(w);
  });
}

/* ── Wiring ────────────────────────────────────────────────────────────── */

function dockInit() {
  document.getElementById('dockToggleBtn')?.addEventListener('click', dockToggle);
  document.getElementById('dockCloseBtn')?.addEventListener('click', () => dockSetOpen(false));
  dockInitResizer();
  if (typeof dockEditInit === 'function') dockEditInit(document.getElementById('dockBody'));

  // A mouse click on the Preview toggle or a button in the pane (fave, flag,
  // stars...) leaves focus on that button, and Enter would then press it
  // again instead of playing the picked tile. Hand focus back after a pointer
  // click (detail > 0); a keyboard press keeps focus where the user put it.
  const giveFocusBack = (e) => {
    if (!e.detail) return;
    const ctl = e.target.closest?.('button, [role="button"]');
    if (ctl && typeof ctl.blur === 'function') ctl.blur();
  };
  document.getElementById('dockToggleBtn')?.addEventListener('click', giveFocusBack);
  document.getElementById('libraryDock')?.addEventListener('click', giveFocusBack);

  // A click on the name / meta strip of a tile selects it too (the picture's
  // own click goes through cards.js tileThumbClick).
  document.getElementById('resultsGrid')?.addEventListener('click', (e) => {
    if (!_dockShown) return;
    const tile = e.target.closest('.media-tile:not(.tile-skel)');
    if (!tile || e.target.closest('button, input, a, .tile-thumb')) return;
    const id = Number(tile.dataset.id);
    if (id) dockSelect(id);
  });
  // A mouse click on a tile's select box leaves focus in it, where the arrows
  // and Enter belong to the box, not the grid: hand focus back, as above.
  // Capture phase: the box's own handler stops the click from bubbling.
  document.getElementById('resultsGrid')?.addEventListener('click', (e) => {
    if (!_dockShown || !e.detail || !e.target.matches?.('input.tile-select')) return;
    const box = e.target;
    queueMicrotask(() => box.blur());
  }, true);
  document.getElementById('resultsGrid')?.addEventListener('dblclick', (e) => {
    if (!_dockShown) return;
    const tile = e.target.closest('.media-tile:not(.tile-skel)');
    // Anything with its own double click (a tile's picture, a table row's
    // picture and title) already played it.
    if (!tile || e.target.closest('button, input, a, .tile-thumb, [ondblclick]')) return;
    const id = Number(tile.dataset.id);
    if (id) playMediaById(id);
  });

  // Tab switches show and hide #mainContainer; Faces toggles its classes.
  const main = document.getElementById('mainContainer');
  if (main && typeof MutationObserver === 'function') {
    new MutationObserver(() => dockSync()).observe(main, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  window.addEventListener('vault:layout-style', () => dockSync());
  // The full id list arrived: a pick that only looked possibly-gone against
  // the first page can be decided now.
  window.addEventListener('vault:results-counted', () => { if (_dockShown) dockDropIfGone(); });
  window.addEventListener('vault:row-updated', (e) => {
    if (_dockShown && e.detail && e.detail.id === _dockSelectedId) dockRender();
  });

  let queued = false;
  const onResizeOrScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      dockSync();
      if (_dockShown) { dockUpdateTop(); dockApplyWidth(window.vaultDockWidth?.()); }
    });
  };
  window.addEventListener('resize', onResizeOrScroll);
  window.addEventListener('scroll', () => { if (_dockShown) onResizeOrScroll(); }, { passive: true });
  const header = document.getElementById('appHeader');
  if (header && typeof ResizeObserver === 'function') new ResizeObserver(onResizeOrScroll).observe(header);

  dockSync({ boot: true });
}

// Runs before app.js starts the library, so a reload with the pane open lays
// the grid out at its docked width from the first render.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', dockInit);
} else {
  dockInit();
}
