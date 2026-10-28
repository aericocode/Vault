/* =========================================================================
   COLLECTION REORDER - rearrange an open collection's playlist order
   (PLAYLISTS_SPEC, build step 1; Modern UI review items 1 and 11)

   While a collection (not a folder) is open and the grid is in playlist
   order (or Flow order: then a move edits Flow's working order in memory,
   player-lib/flow.js, and the note line is Flow's order bar), tiles (and table rows) can be dragged to a new spot, and the
   selected file moves one place with Alt+arrows. Each move is one call to
   POST /api/collections/:id/order, then the grid re-runs its query in place
   and a toast offers Undo (selection.js showUndoToast; Undo sends the whole
   earlier order back).

   Moves are relative to what is on screen: a search or filter can hide some
   of the collection's files, and "before this tile" still means the same
   thing in the full order. A drag only drops on tiles on the current page;
   Alt+arrows walk across pages.

   Also here: the sort the library had before a collection opened (opening
   one switches to playlist order, closing it puts the old sort back) and the
   note line under the collection bar.

   Hooks other files call (guarded with typeof):
     reorderTileAttr()          cards.js renderTile, table-view.js tvRowHtml
     collectionSortEnter()      collections.js openCollection
     collectionSortLeave()      collections.js, wherever a collection closes
     librarySortValue()         saved-searches.js (the sort to remember)
     renderReorderNote()        collections.js renderCollectionHeader, shuffle

   Calls out: flowMembersChanged(id) (flow.js) after every order change
   here, so the open Flow panel follows. Edge auto-scroll while dragging:
   player-lib/drag-autoscroll.js (the maths).
   ========================================================================= */

const PLAYLIST_SORT_VALUE = 'playlist_asc';

/* ── Sort: playlist order while a collection is open ──────────────────── */

let _sortBeforeCollection = null;   // the library's sort, kept while a collection is open

function collectionIsOpen() {
  return typeof activeCollectionId !== 'undefined' && activeCollectionId != null;
}

/** A collection or folder just opened: show it in playlist order. */
function collectionSortEnter() {
  if (_sortBeforeCollection == null) _sortBeforeCollection = currentSort;
  currentSort = PLAYLIST_SORT_VALUE;
  if (typeof syncSortControls === 'function') syncSortControls();
}

/** The collection closed: the library gets its own sort back. */
function collectionSortLeave() {
  if (_sortBeforeCollection != null) {
    currentSort = _sortBeforeCollection;
    _sortBeforeCollection = null;
  }
  if (typeof syncSortControls === 'function') syncSortControls();
  renderReorderNote();
}

/**
 * A saved search was loaded while a collection is open: its sort shows now,
 * and it is also the library sort that closing the collection puts back.
 */
function collectionSortAdopt() {
  if (!collectionIsOpen()) return;
  if (typeof currentSortField === 'function' && currentSortField() === 'playlist') return;
  _sortBeforeCollection = currentSort;
}

/** The sort to remember for next launch / a saved search: never playlist order. */
function librarySortValue() {
  if (collectionIsOpen() && _sortBeforeCollection != null) return _sortBeforeCollection;
  return currentSort || 'processed_desc';
}

function switchToPlaylistOrder() {
  // Flow order (player-lib/flow.js) is left too.
  if (typeof flowLeaveOrder === 'function') flowLeaveOrder();
  currentSort = PLAYLIST_SORT_VALUE;
  if (typeof syncSortControls === 'function') syncSortControls();
  // A shuffled grid is put back too: a fresh query is never shuffled.
  return applyFilters({ keepPage: true });
}

/* ── When can the order be changed? ───────────────────────────────────── */

function _openReorderable() {
  if (!collectionIsOpen()) return null;
  const c = typeof getCollectionById === 'function' ? getCollectionById(activeCollectionId) : null;
  return c && c.kind !== 'folder' ? c : null;
}

/**
 * Why rearranging is off right now: null when it is on, 'none' when there is
 * nothing to say (no collection, or a folder), otherwise a reason.
 */
function reorderBlockedReason() {
  if (!_openReorderable()) return 'none';
  if (typeof currentSortField !== 'function' || currentSortField() !== 'playlist') return 'sort';
  if (Library.shuffled) return 'shuffled';
  const spec = Library.spec;
  if (!spec || spec.collectionId !== activeCollectionId) return 'none';   // the grid has not caught up yet
  // Flow order: drags edit its working order (flow.js), not the playlist order.
  if (typeof flowOrderOn === 'function' && flowOrderOn()) return Library.search && Library.search.mode === 'semantic' ? 'ranked' : null;
  if (spec.rankedIds || (Library.search && Library.search.mode === 'semantic')) return 'ranked';
  return null;
}

function reorderReady() {
  return reorderBlockedReason() === null;
}

/** Tiles and table rows are draggable only while a move can happen. */
function reorderTileAttr() {
  return reorderReady() ? ' draggable="true"' : '';
}

/* ── The note line under the collection bar ───────────────────────────── */

let _reorderNoteHtml = null;

function renderReorderNote() {
  // The bar's count line says the order too ("· sorted by name"), collections.js
  if (typeof renderCollectionCount === 'function') renderCollectionCount();
  const el = document.getElementById('collReorderNote');
  if (!el) return;
  const reason = reorderBlockedReason();
  let html = '';
  // Flow order shows: the order bar (flow.js) instead of the note.
  // A shuffle on screen wins: its note shows (a shuffle leaves Flow order anyway).
  const flowBar = !Library.shuffled && typeof flowOrderOn === 'function' && flowOrderOn() && typeof flowOrderBarHtml === 'function' ? flowOrderBarHtml() : '';
  el.classList.toggle('flow-orderbar', !!flowBar);
  if (flowBar) {
    html = flowBar;
  } else if (reason === null) {
    html = 'Drag tiles to rearrange, or select one and press Alt+arrows. Saves as you go.';
  } else if (reason === 'sort') {
    html = 'Switch to playlist order to rearrange. '
      + '<button type="button" class="coll-note-btn" onclick="switchToPlaylistOrder()">Use playlist order</button>';
  } else if (reason === 'shuffled') {
    html = 'Showing a shuffled order. Switch to playlist order to rearrange. '
      + '<button type="button" class="coll-note-btn" onclick="switchToPlaylistOrder()">Use playlist order</button>';
  } else if (reason === 'ranked') {
    html = 'Your search is ranking these files, so rearranging is off until it is cleared.';
  }
  if (html === _reorderNoteHtml) return;
  _reorderNoteHtml = html;
  el.innerHTML = html;
  el.hidden = !html;
}

window.addEventListener('vault:results-changed', () => renderReorderNote());

/* ── Making a move ─────────────────────────────────────────────────────── */

let _reorderBusy = false;

function _members() {
  // Flow order: the order it shows (a move edits that, flow.js).
  const flow = typeof flowWorkingOrder === 'function' ? flowWorkingOrder() : null;
  if (flow) return flow;
  return (typeof collectionMembers !== 'undefined' && collectionMembers.get(activeCollectionId)) || [];
}

/** The id the block goes in front of when it lands right after `afterId`. */
function _beforeForAfter(order, moving, afterId) {
  const rest = order.filter(id => !moving.has(id));
  const i = rest.indexOf(afterId);
  return i >= 0 && i + 1 < rest.length ? rest[i + 1] : null;
}

/** The order the server will make, to skip a move that changes nothing. */
function _plannedOrder(order, moving, before) {
  const block = order.filter(id => moving.has(id));
  const rest = order.filter(id => !moving.has(id));
  const at = before == null ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

const _sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

async function _postOrder(collId, body) {
  const resp = await fetch(`/api/collections/${collId}/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await collResponseError(resp);
  return resp.json();
}

/** The server's answer is the truth: cache it and refresh the grid in place. */
async function _installOrder(collId, data) {
  if (typeof collectionMembers !== 'undefined') collectionMembers.set(collId, data.order);
  const c = typeof getCollectionById === 'function' ? getCollectionById(collId) : null;
  if (c) {
    c.item_count = data.item_count;
    if (Array.isArray(data.first_ids)) c.first_ids = data.first_ids;
  }
  // The open Flow panel's chart and counts follow the new order (flow.js).
  if (typeof flowMembersChanged === 'function') flowMembersChanged(collId);
  if (activeCollectionId === collId) await applyFilters({ keepPage: true });
}

function _fileName(id) {
  const row = Library.row(id);
  return row ? row.filename : 'file';
}

/**
 * Move `ids` (members of the open collection) to sit right before `before`
 * (an id, or null for the end). One request; the grid follows; Undo toast.
 * @returns {Promise<boolean>} whether the order changed
 */
async function reorderMove(ids, before) {
  const collId = activeCollectionId;
  const prev = _members().slice();
  const moving = new Set(ids);
  if (!ids.length || (before != null && moving.has(before))) return false;
  if (_sameOrder(_plannedOrder(prev, moving, before), prev)) return false;
  // Flow order: the working order changes, in memory, until Save as playlist order.
  if (typeof flowOrderOn === 'function' && flowOrderOn() && typeof flowMoveInOrder === 'function') return flowMoveInOrder(ids, before);
  _reorderBusy = true;
  try {
    const data = await Library.ownWrite(_postOrder(collId, { move: ids, before }));
    await _installOrder(collId, data);
    const first = data.order.findIndex(id => moving.has(id));
    const n = first + 1;
    // selection.js showUndoToast takes HTML: the file name is escaped.
    const msg = ids.length === 1
      ? `Moved “${escapeHtml(_fileName(ids[0]))}” to position ${n}`
      : `Moved ${ids.length} files to position ${n}`;
    showUndoToast(msg, () => reorderUndo(collId, prev));
    return true;
  } catch (err) {
    collErrorToast(err, 'moving that');
    // Whatever the server holds now is what the grid should show.
    if (typeof fetchCollectionMembers === 'function') {
      fetchCollectionMembers(collId, true).then(() => {
        if (typeof flowMembersChanged === 'function') flowMembersChanged(collId);
        if (activeCollectionId === collId) applyFilters({ keepPage: true });
      }).catch(() => {});
    }
    return false;
  } finally {
    _reorderBusy = false;
  }
}

async function reorderUndo(collId, order) {
  // One change at a time: wait out a move still on its way, then hold off
  // drags and keys until the order is back.
  while (_reorderBusy) await new Promise(r => setTimeout(r, 50));
  _reorderBusy = true;
  try {
    const data = await Library.ownWrite(_postOrder(collId, { order }));
    await _installOrder(collId, data);
    showToast('Order put back');
  } catch (err) {
    collErrorToast(err, 'putting the order back');
  } finally {
    _reorderBusy = false;
  }
}

/* ── Drag and drop ────────────────────────────────────────────────────── */

let _reorderDrag = null;   // { ids, set } while a tile drag is on
let _reorderDropEl = null;

function _gridTile(el) {
  const tile = el && el.closest ? el.closest('.media-tile[data-id]') : null;
  return tile && tile.closest('#resultsGrid') ? tile : null;
}

function _isTableView() {
  return typeof tableViewActive === 'function' && tableViewActive();
}

/** Is this file in the current results (what the grid has of them)? A
 *  search or filter can hide selected files: those stay where they are. */
function _shown(id) {
  return Library.indexOf(id) >= 0;
}

/** The ids a drag carries: the shown part of the selection when the file is in it. */
function _idsFor(id) {
  const members = new Set(_members());
  if (typeof selectedIds !== 'undefined' && selectedIds.has(id) && selectedIds.size > 1) {
    const sel = _members().filter(m => selectedIds.has(m) && (m === id || _shown(m)));
    if (sel.length) return sel;
  }
  return members.has(id) ? [id] : [];
}

function _clearDropMark() {
  if (_reorderDropEl) _reorderDropEl.classList.remove('reorder-drop-before', 'reorder-drop-after');
  _reorderDropEl = null;
}

function _endReorderDrag() {
  document.querySelectorAll('#resultsGrid .reorder-dragging').forEach(t => t.classList.remove('reorder-dragging'));
  _clearDropMark();
  _stopEdgeScroll();
  _reorderDrag = null;
}

/** Fade the dragged files' tiles, including rows the table draws as the page scrolls. */
function _markDragging() {
  if (!_reorderDrag) return;
  document.querySelectorAll('#resultsGrid .media-tile[data-id]').forEach(t => {
    if (_reorderDrag.set.has(Number(t.dataset.id))) t.classList.add('reorder-dragging');
  });
}

/* ── Edge auto-scroll while dragging ──────────────────────────────────
   Near the top or bottom of the files (under the sticky header and the
   table's header row, over the Stage bar) the page scrolls, faster the
   nearer the edge (DragAutoScroll.speed, player-lib/drag-autoscroll.js).
   Each dragover says where the pointer is; a frame loop scrolls the window
   and stops on drop, dragend, leaving the band, or when no dragover has
   come for EDGE_STALE_MS (the pointer left the window). Tiles and rows the
   grid draws as it scrolls take the drop like any other (the listeners are
   on the document). The mouse wheel scrolls as usual meanwhile. */

const EDGE_STALE_MS = 150;
let _edge = null;   // { y, at, raf, last } while scrolling

/** The visible files' top and bottom edges, in viewport pixels. */
function _edgeBounds() {
  let top = 0;
  const header = document.getElementById('appHeader');
  if (header) top = Math.max(top, header.getBoundingClientRect().bottom);
  // The table's header row while it sticks under the app header (continuous table).
  const head = _isTableView() ? document.querySelector('#resultsGrid .tv-head') : null;
  if (head) {
    const r = head.getBoundingClientRect();
    if (r.height > 0 && r.top <= top + 1) top = Math.max(top, r.bottom);
  }
  let bottom = window.innerHeight;
  const bar = document.body.classList.contains('stage-bar-on') ? document.querySelector('.stage-bar') : null;
  if (bar) {
    const r = bar.getBoundingClientRect();
    if (r.height > 0 && r.top < bottom) bottom = Math.max(0, r.top);
  }
  top = Math.max(0, Math.min(top, window.innerHeight / 2));
  return { top, bottom: Math.max(top, bottom) };
}

function _edgeSpeed(y) {
  if (typeof DragAutoScroll === 'undefined') return 0;
  const b = _edgeBounds();
  return DragAutoScroll.speed(y, b.top, b.bottom);
}

/** A dragover at clientY: start, steer or stop the scrolling. */
function _edgeScrollAt(y) {
  const now = performance.now();
  if (!_edgeSpeed(y)) { _stopEdgeScroll(); return; }
  if (_edge) { _edge.y = y; _edge.at = now; return; }
  _edge = { y, at: now, last: now, raf: 0 };
  _edge.raf = requestAnimationFrame(_edgeTick);
}

function _edgeTick(now) {
  const e = _edge;
  if (!e) return;
  if (!_reorderDrag || now - e.at > EDGE_STALE_MS) { _stopEdgeScroll(); return; }
  const dt = Math.min(50, Math.max(0, now - e.last));
  e.last = now;
  const v = _edgeSpeed(e.y);
  if (!v) { _stopEdgeScroll(); return; }
  const before = window.scrollY;
  window.scrollBy(0, (v * dt) / 1000);
  // Rows and tiles drawn for the new scroll position get the faded mark too.
  if (window.scrollY !== before) _markDragging();
  e.raf = requestAnimationFrame(_edgeTick);
}

function _stopEdgeScroll() {
  if (_edge && _edge.raf) cancelAnimationFrame(_edge.raf);
  _edge = null;
}

/** Before or after the tile under the pointer: its left / right half (rows: top / bottom). */
function _dropSide(tile, e) {
  const r = tile.getBoundingClientRect();
  if (_isTableView()) return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
  return e.clientX < r.left + r.width / 2 ? 'before' : 'after';
}

// Where the press that may become a drag began. A press on a tile's tick box
// or one of its buttons is a click, even when the mouse moves a few pixels
// before it is let go: the tile is not dragged then (the browser would take
// the drag and the click would be lost, so the tick box did nothing).
let _reorderPressOn = null;
document.addEventListener('pointerdown', (e) => { _reorderPressOn = e.target; }, true);
const REORDER_NO_DRAG_FROM = 'input, button, select, textarea, a, label, .tile-actions';

document.addEventListener('dragstart', (e) => {
  const tile = _gridTile(e.target);
  if (!tile || !tile.hasAttribute('draggable') || !reorderReady() || _reorderBusy) return;
  const from = _reorderPressOn && _reorderPressOn.closest ? _reorderPressOn.closest(REORDER_NO_DRAG_FROM) : null;
  if (from && tile.contains(from)) { e.preventDefault(); return; }
  const ids = _idsFor(Number(tile.dataset.id));
  if (!ids.length) { e.preventDefault(); return; }
  _reorderDrag = { ids, set: new Set(ids) };
  try {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ids.map(_fileName).join('\n'));
  } catch {}
  if (typeof hideTilePopover === 'function') hideTilePopover();
  if (typeof stopScrub === 'function') stopScrub();
  // The grid can redraw the dragged tile away (the table's rows as it
  // scrolls): dragend then never reaches the document, so listen on it too.
  const drag = _reorderDrag;
  tile.addEventListener('dragend', () => { if (_reorderDrag === drag) _endReorderDrag(); }, { once: true });
  // Mark after the browser has taken its drag picture, so the picture is not faded.
  setTimeout(_markDragging, 0);
});

document.addEventListener('dragover', (e) => {
  if (!_reorderDrag) return;
  _edgeScrollAt(e.clientY);
  const tile = _gridTile(e.target);
  if (!tile || _reorderDrag.set.has(Number(tile.dataset.id))) { _clearDropMark(); return; }
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch {}
  const side = _dropSide(tile, e);
  if (_reorderDropEl !== tile) _clearDropMark();
  _reorderDropEl = tile;
  tile.classList.toggle('reorder-drop-before', side === 'before');
  tile.classList.toggle('reorder-drop-after', side === 'after');
});

document.addEventListener('drop', (e) => {
  if (!_reorderDrag) return;
  const drag = _reorderDrag;
  const tile = _gridTile(e.target);
  if (!tile || drag.set.has(Number(tile.dataset.id))) { _endReorderDrag(); return; }
  e.preventDefault();
  const targetId = Number(tile.dataset.id);
  const side = _dropSide(tile, e);
  _endReorderDrag();
  const before = side === 'before' ? targetId : _beforeForAfter(_members(), drag.set, targetId);
  reorderMove(drag.ids, before);
});

document.addEventListener('dragend', () => { if (_reorderDrag) _endReorderDrag(); });

/* ── Keyboard: Alt+arrows move the selected file one place ────────────── */

/** What Alt+arrows move: Modern's docked pick, else the ticked files. */
function _keyTargetIds() {
  const members = new Set(_members());
  if (typeof dockIsShown === 'function' && dockIsShown()
      && typeof _dockSelectedId !== 'undefined' && _dockSelectedId != null) {
    return members.has(_dockSelectedId) ? [_dockSelectedId] : [];
  }
  if (typeof selectedIds !== 'undefined' && selectedIds.size) {
    return _members().filter(m => selectedIds.has(m));
  }
  return [];
}

function _reorderKeyBlocked(e) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return true;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return true;
  if (typeof isTypingTarget === 'function' && isTypingTarget(e.target)) return true;
  // The player owns Alt+Left / Right (previous / next file).
  if (document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) return true;
  if (document.querySelector('.modal-overlay.active, .settings-overlay.active, .media-info-overlay.active, .filters-panel.active')) return true;
  if (typeof dockModalLayerOpen === 'function' && dockModalLayerOpen()) return true;
  const main = document.getElementById('mainContainer');
  if (!main || main.style.display === 'none' || !main.classList.contains('active')) return true;
  return !reorderReady();
}

document.addEventListener('keydown', async (e) => {
  if (_reorderKeyBlocked(e)) return;
  // Alt+Left is also the browser's Back: in a collection it moves files instead.
  e.preventDefault();
  if (_reorderBusy) return;
  let ids = _keyTargetIds();
  if (!ids.length) { showToast('Select a file first, then press Alt+arrows to move it'); return; }
  const cols = _isTableView() || typeof dockGridCols !== 'function' ? 1 : dockGridCols();
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: _isTableView() ? -1 : -cols, ArrowDown: _isTableView() ? 1 : cols }[e.key];

  _reorderBusy = true;
  let before;
  try {
    const all = await Library.waitIds();
    if (!all) return;
    // Selected files a search or filter hides stay where they are.
    const inResults = new Set(all);
    ids = ids.filter(id => inResults.has(id));
    if (!ids.length) { showToast('Select a file first, then press Alt+arrows to move it'); return; }
    const moving = new Set(ids);
    const shown = [];
    let slot = -1;
    for (let i = 0; i < all.length; i++) {
      const id = all[i];
      if (moving.has(id)) { if (slot < 0) slot = shown.length; continue; }
      shown.push(id);
    }
    if (slot < 0) return;
    const to = Math.max(0, Math.min(shown.length, slot + step));
    before = to < shown.length ? shown[to] : _beforeForAfter(_members(), moving, shown[shown.length - 1]);
  } finally {
    _reorderBusy = false;
  }
  if (before === undefined) return;
  const moved = await reorderMove(ids, before);
  if (!moved) return;
  // Keep the moved file in sight (a move can carry it onto another page).
  const at = Library.indexOf(ids[0]);
  if (at >= 0 && typeof dockReveal === 'function') dockReveal(at);
  if (typeof dockPaintSelection === 'function') dockPaintSelection();
});

