/* =========================================================================
   COLLECTION REORDER - rearrange an open collection's playlist order
   (PLAYLISTS_SPEC, build step 1; Modern UI review items 1 and 11)

   While a collection (not a folder) is open and the grid is in playlist
   order, tiles (and table rows) can be dragged to a new spot, and the
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
     inPlaceDragOver(e)         importer.js, each dragover of files from outside
     inPlaceFinish()            importer.js, on their drop or dragleave

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
  if (reason === null) {
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

/** An order kept to the files there are: gone ones dropped, files added since at the end. */
function _fitOrder(order, members) {
  const inMembers = new Set(members), put = new Set(), out = [];
  for (const id of order) if (inMembers.has(id) && !put.has(id)) { put.add(id); out.push(id); }
  for (const id of members) if (!put.has(id)) { put.add(id); out.push(id); }
  return out;
}

/** In the page's turn for order writes (collections.js collectionOrderTurn), or at once without one. */
const _inOrderTurn = (fn) => (typeof collectionOrderTurn === 'function' ? collectionOrderTurn(fn) : fn());

/** Another window changed the order first (409 STALE): plain words, nothing moved here, the page reads it again. */
async function _staleAction(collId) {
  showToast(typeof STALE_ACTION_TEXT === 'string' ? STALE_ACTION_TEXT : 'This playlist was changed in another window. It is up to date now, so try that again.');
  await _readAgain(collId);
}

/** Whatever the server holds now is what the grid and Flow show. */
async function _readAgain(collId) {
  if (typeof collectionResync === 'function') { await collectionResync(collId); return; }
  if (typeof fetchCollectionMembers === 'function') {
    try { await fetchCollectionMembers(collId, true); } catch { return; }
    if (typeof flowMembersChanged === 'function') flowMembersChanged(collId);
    if (activeCollectionId === collId) await applyFilters({ keepPage: true });
  }
}

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
    if (typeof takeCollectionAnswer === 'function') takeCollectionAnswer(collId, data);
    else if (typeof takeCollectionLength === 'function') takeCollectionLength(c, data);
  }
  // The open Flow panel's chart and counts follow the new order, and which of Custom and the shapes is lit (flow.js).
  if (typeof flowCustomAnswer === 'function') flowCustomAnswer(collId, data);
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
  const moving = new Set(ids);
  if (!ids.length || (before != null && moving.has(before))) return false;
  if (_sameOrder(_plannedOrder(_members(), moving, before), _members())) return false;
  _reorderBusy = true;
  try {
    return await _inOrderTurn(() => _moveNow(collId, ids, before));
  } finally {
    _reorderBusy = false;
  }
}

/**
 * The move itself, in the page's turn: prev is the order the page shows
 * now (its copy, after its own writes before this one). It goes as seen,
 * so the server refuses the move when another window changed the order
 * (409 STALE), and the same list is what the Undo puts back.
 */
async function _moveNow(collId, ids, before) {
  const prev = _members().slice();
  const moving = new Set(ids);
  if (_sameOrder(_plannedOrder(prev, moving, before), prev)) return false;
  try {
    // A hand reorder: over a shape nothing is lit then (flow.js, lib/flow/custom.js).
    const data = await Library.ownWrite(_postOrder(collId, { move: ids, before, flow: { manual: true }, seen: prev }));
    await _installOrder(collId, data);
    const first = data.order.findIndex(id => moving.has(id));
    const n = first + 1;
    // selection.js showUndoToast takes HTML: the file name is escaped.
    const msg = ids.length === 1
      ? `Moved “${escapeHtml(_fileName(ids[0]))}” to position ${n}`
      : `Moved ${ids.length} files to position ${n}`;
    // The Undo puts back what Flow kept before the move too (a shape lit comes
    // back lit), or checks the row is still as the move left it (flow.js
    // flowGuardOf): refused when another window changed it since.
    const flow = typeof flowGuardOf === 'function' ? flowGuardOf(data) : undefined;
    showUndoToast(msg, () => reorderUndo(collId, prev, flow));
    return true;
  } catch (err) {
    if (err && err.code === 'STALE') { await _staleAction(collId); return false; }
    collErrorToast(err, 'moving that');
    // Whatever the server holds now is what the grid should show.
    if (typeof fetchCollectionMembers === 'function') {
      fetchCollectionMembers(collId, true).then(() => {
        if (typeof flowMembersChanged === 'function') flowMembersChanged(collId);
        if (activeCollectionId === collId) applyFilters({ keepPage: true });
      }).catch(() => {});
    }
    return false;
  }
}

/**
 * Undo of a move: the order from before it (kept to the files there are
 * now: files added since at the end), with seen (the order the page shows
 * now) and flow (what Flow kept), both checked by the server.
 */
async function reorderUndo(collId, order, flow) {
  // One change at a time: wait out a move still on its way, then hold off
  // drags and keys until the order is back.
  while (_reorderBusy) await new Promise(r => setTimeout(r, 50));
  _reorderBusy = true;
  try {
    await _inOrderTurn(() => _undoNow(collId, order, flow));
  } finally {
    _reorderBusy = false;
  }
}

async function _undoNow(collId, order, flow) {
  try {
    const seen = _members().slice();
    const body = { order: _fitOrder(order, seen), seen };
    if (flow !== undefined) body.flow = flow;
    const data = await Library.ownWrite(_postOrder(collId, body));
    await _installOrder(collId, data);
    showToast('Order put back');
  } catch (err) {
    // Another window changed the order since (409 STALE): nothing was written; the page reads it again.
    if (err && err.code === 'STALE') {
      showToast(typeof STALE_UNDO_TEXT === 'string' ? STALE_UNDO_TEXT : err.message);
      await _readAgain(collId);
    } else collErrorToast(err, 'putting the order back');
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
  if ((!_reorderDrag && !_fileDrop) || now - e.at > EDGE_STALE_MS) { _stopEdgeScroll(); return; }
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

// How far outside the grid's own box a drop still counts (its edges, the
// space under the last row before the pager).
const REORDER_DROP_PAD = 24;

/**
 * Where a drop at this pointer lands: { tile, side }, or null for no drop.
 * On a tile: that tile (none when it is one being dragged, or when the drop
 * would leave the order as it is, as on the near half of the tile next to
 * the dragged one). In a gap between tiles or rows, after the last one, or
 * just outside the grid's edge: the nearest place in the order, so there is
 * no dead space in the grid. The dragged tiles count for where the rows and
 * the nearest tile are (what the user sees), but the mark goes on a tile not
 * being dragged; a gap drop that would leave the SHOWN files in the order
 * they are (next to the dragged file's own tile) is no drop, so no mark
 * shows there and nothing is saved. Shown, not all: with a search or filter
 * on, such a drop would only carry the file past hidden ones, a move the
 * user cannot see. A drop right on a tile still may (it says where).
 */
function _dropAt(e) {
  const drag = _reorderDrag;
  if (!drag) return null;
  const tile = _gridTile(e.target);
  if (tile) {
    if (drag.set.has(Number(tile.dataset.id))) return null;
    const at = { tile, side: _dropSide(tile, e) };
    const order = _members();
    return _sameOrder(_plannedOrder(order, drag.set, _dropBefore(at, drag)), order) ? null : at;
  }
  const at = _gapSpot(e, drag.set);
  if (!at) return null;
  const order = _members();
  const planned = _plannedOrder(order, drag.set, _dropBefore(at, drag));
  const shown = (id) => drag.set.has(id) || _shown(id);
  return DragAutoScroll.sameShownOrder(planned, order, shown) ? null : at;
}

/**
 * A pointer in a gap between tiles or rows, after the last one, or just
 * outside the grid's edge: the nearest { tile, side }, null for no drop
 * there (the pager, the bars). `dragged`: ids being dragged (never the answer).
 */
function _gapSpot(e, dragged) {
  const grid = document.getElementById('resultsGrid');
  const main = document.getElementById('mainContainer');
  const t = e.target;
  if (!grid || !t || !t.closest) return null;
  // The pager, the bars and anything else outside the files take no drop.
  if (!grid.contains(t) && (!main || !main.contains(t) || t.closest('#pagination'))) return null;
  const g = grid.getBoundingClientRect();
  if (e.clientX < g.left - REORDER_DROP_PAD || e.clientX > g.right + REORDER_DROP_PAD
      || e.clientY < g.top - REORDER_DROP_PAD || e.clientY > g.bottom + REORDER_DROP_PAD) return null;
  const tiles = [...grid.querySelectorAll('.media-tile[data-id]')];
  const skip = new Set();
  tiles.forEach((el, i) => { if (dragged.has(Number(el.dataset.id))) skip.add(i); });
  const hit = typeof DragAutoScroll !== 'undefined' && DragAutoScroll.nearestDrop
    ? DragAutoScroll.nearestDrop(e.clientX, e.clientY, tiles.map(el => el.getBoundingClientRect()), { rows: _isTableView(), skip })
    : null;
  return hit ? { tile: tiles[hit.index], side: hit.side } : null;
}

/** The file a drop at { tile, side } goes in front of (null: the end). */
function _dropBefore(at, drag) {
  const targetId = Number(at.tile.dataset.id);
  return at.side === 'before' ? targetId : _beforeForAfter(_members(), drag.set, targetId);
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
  const at = _dropAt(e);
  if (!at) { _clearDropMark(); return; }
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch {}
  const { tile, side } = at;
  if (_reorderDropEl !== tile) _clearDropMark();
  _reorderDropEl = tile;
  tile.classList.toggle('reorder-drop-before', side === 'before');
  tile.classList.toggle('reorder-drop-after', side === 'after');
});

document.addEventListener('drop', (e) => {
  if (!_reorderDrag) return;
  const drag = _reorderDrag;
  const at = _dropAt(e);
  if (!at) { _endReorderDrag(); return; }
  e.preventDefault();
  const before = _dropBefore(at, drag);
  _endReorderDrag();
  reorderMove(drag.ids, before);
});

document.addEventListener('dragend', () => { if (_reorderDrag) _endReorderDrag(); });

/* ── Files dragged in from outside: drop them in place ────────────────
   Files dragged in from the file manager over an open collection in
   playlist order normally land at its end (importer.js addPaths). Holding
   the pointer still over a spot for DragAutoScroll.DWELL_MS starts drop
   mode: from then until the drag ends the same drop mark a reorder shows
   follows the pointer to the nearest place among the tiles ON SCREEN,
   wherever the pointer is (over the header, a bar, a panel, an edge band
   it sits on the nearest visible row; below the last tile it is after it),
   so a mark always shows, and a drop adds the files at the mark's place in
   the full order (add-paths `before`). Moving or scrolling (edge, wheel)
   does not leave drop mode; the mark follows the content as it scrolls.
   A drop before drop mode adds at the end as before. The page scrolls near the
   edges as in a reorder, before drop mode too (to reach the place first).
   Only while nothing hides any of the collection's files (a search or
   filter, another sort, a shuffle): then "here" means the same in the full
   order as on screen. importer.js calls inPlaceDragOver on each file
   dragover and inPlaceFinish when the drag drops or leaves the window. */

let _fileDrop = null;   // { dwell, placing, at, before, x, y } while files from outside are over the page
const FILE_DROP_STALE_MS = 1500;
let _fileDropStale = 0;

/** Can files dropped from outside go to a chosen spot right now? */
function inPlaceReady() {
  if (!reorderReady() || _reorderBusy || _reorderDrag) return false;
  if (typeof Library === 'undefined' || !Library.known()) return false;
  // The grid is covered (the player, a dialog): no spot to pick.
  if (document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) return false;
  if (typeof dockModalLayerOpen === 'function' && dockModalLayerOpen()) return false;
  const members = _members();
  return members.length > 0 && Library.total === members.length;
}

/** Where a file drop at this pointer would go: { tile, side, before }, or null. */
function _fileSpotAt(e) {
  const tile = _gridTile(e.target);
  const at = tile ? { tile, side: _dropSide(tile, e) } : _gapSpot(e, new Set());
  if (!at) return null;
  const before = DragAutoScroll.insertBefore(_members(), Number(at.tile.dataset.id), at.side);
  return before === undefined ? null : { ...at, before };
}

function _showFileMark(at) {
  if (_reorderDropEl !== at.tile) _clearDropMark();
  _reorderDropEl = at.tile;
  at.tile.classList.toggle('reorder-drop-before', at.side === 'before');
  at.tile.classList.toggle('reorder-drop-after', at.side === 'after');
}

/** Drop mode's place for a pointer at (x, y): the nearest spot among the tiles on screen, or null (none on screen). */
function _fileVisibleSpot(x, y) {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return null;
  const tiles = [...grid.querySelectorAll('.media-tile[data-id]')];
  const hit = DragAutoScroll.visibleDrop(x, y, tiles.map(el => el.getBoundingClientRect()), _edgeBounds(), { rows: _isTableView() });
  if (!hit) return null;
  const tile = tiles[hit.index];
  const before = DragAutoScroll.insertBefore(_members(), Number(tile.dataset.id), hit.side);
  return before === undefined ? null : { tile, side: hit.side, before };
}

/** Is the marked tile drawn and on screen (its middle in the visible files area), with its mark? */
function _fileMarkShown(at) {
  if (!at || !at.tile.isConnected || !at.tile.classList.contains(`reorder-drop-${at.side}`)) return false;
  return DragAutoScroll.onScreen(at.tile.getBoundingClientRect(), _edgeBounds(), _isTableView());
}

/** The file drag is still on the page: restart the "ended unseen" timer. */
function _fileDropAlive() {
  const f = _fileDrop;
  clearTimeout(_fileDropStale);
  if (!f) return;
  _fileDropStale = setTimeout(() => {
    if (_fileDrop !== f) return;
    inPlaceFinish();
    // The drop overlay goes too (importer.js), so its words do not stay up.
    try { document.dispatchEvent(new CustomEvent('vault:file-drag-quiet')); } catch {}
  }, FILE_DROP_STALE_MS);
}
// While rows scroll under a still pointer some browsers send dragenter and
// dragleave but no dragover: a dragenter also shows the drag is alive.
document.addEventListener('dragenter', () => { if (_fileDrop) _fileDropAlive(); }, true);

/** Drop mode: the mark goes to the place for the last pointer position (no tile on screen: no mark, the drop adds at the end). */
function _fileMarkFollow() {
  const f = _fileDrop;
  if (!f || !f.placing || f.x == null) return;
  const at = _fileVisibleSpot(f.x, f.y);
  if (!at) { _clearDropMark(); f.at = null; f.before = undefined; return; }
  f.before = at.before;
  if (!f.at || at.tile !== f.at.tile || at.side !== f.at.side || !at.tile.classList.contains(`reorder-drop-${at.side}`)) {
    f.at = at;
    _showFileMark(at);
  }
}

// Drop mode while the page scrolls (edge scroll, the wheel, the browser's
// own drag scroll): the mark follows the content under the pointer, now and
// once the grid has drawn the rows for the new position.
document.addEventListener('scroll', () => {
  if (!_fileDrop) return;
  _fileDropAlive();   // the page scrolling under the drag: it has not ended
  if (!_fileDrop.placing) return;
  _fileMarkFollow();
  requestAnimationFrame(() => _fileMarkFollow());
}, { capture: true, passive: true });

/**
 * A file dragover (importer.js). Steers the edge scroll, the hold-still
 * timer and, in drop mode, the mark. @returns {'off'|'waiting'|'placing'}
 * off: no in-place drop here (the drop adds at the end as always), waiting:
 * hold still to start drop mode (a drop now adds at the end), placing: drop
 * mode, a drop now goes at the mark.
 */
function inPlaceDragOver(e) {
  if (!inPlaceReady()) { if (_fileDrop) inPlaceFinish(); return 'off'; }
  if (!_fileDrop) _fileDrop = { dwell: null, placing: false, at: null, before: undefined, x: null, y: null };
  const f = _fileDrop;
  f.x = e.clientX; f.y = e.clientY;
  // dragover keeps coming while the files are over the page, even held
  // still: none for a while means the drag ended unseen (no dragleave), so
  // the mark is not left behind for the next drag.
  _fileDropAlive();
  _edgeScrollAt(e.clientY);
  if (f.placing) {
    // Drop mode lasts until the drag ends: the mark follows the pointer.
    _fileMarkFollow();
  } else {
    f.dwell = DragAutoScroll.dwellStep(f.dwell, e.clientX, e.clientY, window.scrollY, performance.now());
    // Rested over a place in the order: drop mode starts there.
    if (f.dwell.settled) {
      const at = _fileSpotAt(e);
      if (at) { f.placing = true; f.at = at; f.before = at.before; _showFileMark(at); }
    }
  }
  // The grid can draw the marked tile again (continuous view, the table as it scrolls).
  if (f.at && !f.at.tile.isConnected) {
    const again = document.querySelector(`#resultsGrid .media-tile[data-id="${Number(f.at.tile.dataset.id)}"]`);
    if (again) { f.at = { ...f.at, tile: again }; _showFileMark(f.at); }
  }
  return f.placing ? 'placing' : 'waiting';
}

/**
 * The file drag dropped or left: clear the mark and the scrolling.
 * @returns {{ collectionId:number, before:number|null }|null} the marked
 *   place (before null: the end) when there was one, else null
 */
function inPlaceFinish() {
  const f = _fileDrop;
  // The drop goes where a mark shows: a marked tile the grid drew away or
  // scrolled off screen is looked up again for the last pointer position.
  if (f && f.placing && !_fileMarkShown(f.at)) _fileMarkFollow();
  _fileDrop = null;
  clearTimeout(_fileDropStale);
  _clearDropMark();
  _stopEdgeScroll();
  if (!f || !f.at || f.before === undefined || !collectionIsOpen()) return null;
  return { collectionId: activeCollectionId, before: f.before };
}

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

