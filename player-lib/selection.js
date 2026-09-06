/* =========================================================================
   SELECTION + TRASH - Bulk select, move-to-trash with undo, restore

   Trash is a HARD MOVE on disk (server moves files into the configured
   trash folder, default ./trash). Undo restores to the stored original
   path. The server refuses stale rows and occupied restore targets —
   per-item failures surface in a toast.
   ========================================================================= */

// Selected media ids (grid view)
let selectedIds = new Set();
let lastSelectedId = null; // anchor for shift-click range select

/* ── Selection state ───────────────────────────────────────────────────── */

function onTileSelect(event, id) {
  event.stopPropagation();

  const checked = event.target.checked;

  if (event.shiftKey && lastSelectedId !== null) {
    // Range select across the current page's visual order
    const pageIds = [...document.querySelectorAll('.media-tile')].map(t => Number(t.dataset.id));
    const from = pageIds.indexOf(lastSelectedId);
    const to = pageIds.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i++) {
        if (checked) selectedIds.add(pageIds[i]);
        else selectedIds.delete(pageIds[i]);
      }
      syncTileCheckboxes();
    }
  } else {
    if (checked) selectedIds.add(id);
    else selectedIds.delete(id);
  }

  lastSelectedId = id;
  renderSelectionBar();
}

function syncTileCheckboxes() {
  document.querySelectorAll('.media-tile').forEach(tile => {
    const cb = tile.querySelector('.tile-select');
    if (cb) cb.checked = selectedIds.has(Number(tile.dataset.id));
  });
}

/** Ids of the tiles currently rendered on the page. */
function currentPageIds() {
  return [...document.querySelectorAll('.media-tile')].map(t => Number(t.dataset.id));
}

/** Select every tile on the page, or deselect them if all are already selected. */
function toggleSelectPage() {
  const pageIds = currentPageIds();
  if (pageIds.length === 0) return;
  const allSelected = pageIds.every(id => selectedIds.has(id));
  if (allSelected) {
    pageIds.forEach(id => selectedIds.delete(id));
  } else {
    pageIds.forEach(id => selectedIds.add(id));
    lastSelectedId = pageIds[pageIds.length - 1];
  }
  syncTileCheckboxes();
  renderSelectionBar();
}

/**
 * Select the WHOLE filtered result set, not just the rendered page.
 * filteredMedia is the same array pagination slices from, so this is exactly
 * "everything the current search/filter matches" — across every page.
 */
function toggleSelectAllFiltered() {
  const all = (typeof filteredMedia !== 'undefined' ? filteredMedia : []);
  if (!all.length) return;
  // size check first: with a 100k-row library the cheap comparison short-circuits
  // the common "a handful selected" case before touching every id.
  const allSelected = selectedIds.size >= all.length && all.every(m => selectedIds.has(m.id));
  if (allSelected) all.forEach(m => selectedIds.delete(m.id));
  else all.forEach(m => selectedIds.add(m.id));
  lastSelectedId = null;                 // a cross-page range anchor is meaningless
  syncTileCheckboxes();
  renderSelectionBar();
}

/**
 * The two select controls that live up by "Showing X of Y results".
 * Rendered whether or not anything is selected — unlike the action bar, these
 * are how you START a selection.
 */
function renderResultsSelect() {
  const host = document.getElementById('resultsSelect');
  if (!host) return;
  const onLibrary = typeof currentTab === 'undefined' || currentTab === 'library';
  const all = (typeof filteredMedia !== 'undefined' ? filteredMedia : []);
  if (!onLibrary || !all.length) { host.innerHTML = ''; return; }

  const pageIds = currentPageIds();
  const pageAll = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
  const allSelected = selectedIds.size >= all.length && all.every(m => selectedIds.has(m.id));

  host.innerHTML = `
    ${pageIds.length ? `<button class="rs-btn" onclick="toggleSelectPage()"
      title="Select the ${pageIds.length} file(s) shown on this page">${pageAll ? 'Deselect page' : `Select page (${pageIds.length})`}</button>` : ''}
    ${all.length > pageIds.length ? `<button class="rs-btn" onclick="toggleSelectAllFiltered()"
      title="Select every file matching the current search &amp; filters, across all pages">${allSelected ? 'Deselect all' : `Select all ${all.length.toLocaleString()}`}</button>` : ''}`;
}

function clearSelection() {
  selectedIds.clear();
  lastSelectedId = null;
  syncTileCheckboxes();
  renderSelectionBar();
}

/**
 * The selected rows, resolved in ONE pass over allMedia.
 *
 * The obvious `[...selectedIds].map(getMediaById)` is O(selected × library) —
 * getMediaById is a linear .find() — which was harmless while the biggest
 * reachable selection was a single page of ~45 tiles. Select all removed that
 * ceiling: at 30k selected it made every subsequent click (untick one tile, turn
 * a page, flag) a ~2.6s freeze, and ~28s at 100k. Walking the library once and
 * testing Set membership is O(library) with O(1) lookups instead.
 *
 * Order follows allMedia rather than click order — every caller only counts.
 */
function selectedMedia() {
  if (selectedIds.size === 0 || typeof allMedia === 'undefined') return [];
  const out = [];
  for (const m of allMedia) if (selectedIds.has(m.id)) out.push(m);
  return out;
}

/* ── Selection action bar ──────────────────────────────────────────────── */

function ensureSelectionBar() {
  let bar = document.getElementById('selectionBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'selectionBar';
    bar.className = 'selection-bar';
    document.body.appendChild(bar);
  }
  return bar;
}

function renderSelectionBar() {
  const bar = ensureSelectionBar();
  // Before the early-return below: the Select page / Select all controls are how
  // a selection gets STARTED, so they have to render when nothing is selected.
  renderResultsSelect();

  // Selection actions belong to the Library grid — hide elsewhere (the
  // selection itself survives tab switches).
  const onLibrary = typeof currentTab === 'undefined' || currentTab === 'library';
  // Also hide while the full media player is open (main video / fullscreen) so
  // the bar doesn't sit over the media — the selection is preserved and the bar
  // returns when the player closes or drops to the mini player.
  const fullPlayerOpen = document.getElementById('mediaPlayerOverlay')?.classList.contains('active');
  if (selectedIds.size === 0 || !onLibrary || fullPlayerOpen) {
    bar.classList.remove('visible');
    return;
  }

  const items = selectedMedia();
  const trashedCount = items.filter(m => m.user_trashed).length;
  const activeCount = items.length - trashedCount;

  // Music ID actions: fingerprint any A/V selection; stack/grid open videos
  // in the Editor (no hard cap — many concurrent decodes are drive-bound,
  // the Editor warns above 4)
  const avCount = items.filter(m => ['video', 'audio'].includes(m.media_type)).length;
  const vidCount = items.filter(m => m.media_type === 'video').length;
  const musicReady = typeof fingerprintSelected === 'function';
  const many = vidCount > 4 ? ' (playback smoothness depends on drive speed)' : '';
  const musicBtns = !musicReady ? '' : `
    ${avCount > 0 ? `<button class="sel-btn sel-music" onclick="fingerprintSelected()" title="Fingerprint audio — one-time per file; auto-matches songs across the library">🎵 Music ID (${avCount})</button>` : ''}
    ${vidCount >= 2 ? `
      <button class="sel-btn sel-mix" onclick="openEditorWithSelection('stack')"
        title="Open in the Editor, layered in sync${many}">▤ Stack ${vidCount}</button>
      <button class="sel-btn sel-mix" onclick="openEditorWithSelection('grid')"
        title="Open in the Editor, side by side in sync${many}">▦ Grid ${vidCount}</button>
    ` : ''}`;

  // Flag is one toggle rather than two buttons. A mixed selection reads as "not
  // yet flagged", so the first click flags the stragglers and the second — once
  // every item carries the flag — clears them all. bulkFlag() already skips
  // items that are already at the target value, so both directions are cheap.
  const flaggedCount = items.filter(m => m.user_flagged_delete).length;
  const allFlagged = items.length > 0 && flaggedCount === items.length;
  const flagBtn = `<button class="sel-btn${allFlagged ? ' sel-flagged' : ''}" onclick="bulkFlag(${allFlagged ? 0 : 1})"
    title="${allFlagged
      ? 'Clear the delete flag on all selected'
      : `Flag for deletion${flaggedCount ? ` — ${flaggedCount} of ${items.length} already flagged` : ''}`}"
    >${allFlagged ? '🏳 Unflag' : '🚩 Flag'}</button>`;

  // Files whose AI scan never landed: a real error, or a stub that was never
  // scanned (a cancelled queue leaves these). Only offered when the selection
  // actually contains some, which keeps the bar short the rest of the time.
  const errored = items.filter(m => m.processing_error && m.processing_error !== 'unscanned').length;
  const unscanned = items.filter(m => m.processing_error === 'unscanned').length;
  const retryable = errored + unscanned;
  const retryBtn = retryable === 0 ? '' : `<button class="sel-btn sel-retry" onclick="retryErrorsSelected()"
    title="Queue ${retryable} file(s) for another AI scan${errored ? ` — ${errored} errored` : ''}${unscanned ? `${errored ? ',' : ' —'} ${unscanned} never scanned` : ''}"
    >↻ Retry errors (${retryable})</button>`;

  bar.innerHTML = `
    <span class="sel-count">${selectedIds.size} selected</span>
    ${musicBtns}
    ${retryBtn}
    ${activeCount > 0 ? `<button class="sel-btn sel-trash" onclick="trashSelected()">🗑 Trash (${activeCount})</button>` : ''}
    ${trashedCount > 0 ? `<button class="sel-btn sel-restore" onclick="restoreSelected()">♻ Restore (${trashedCount})</button>` : ''}
    ${flagBtn}
    <button class="sel-btn" onclick="addSelectionToCollection(this)" title="Add selection to a collection">📁 Collect</button>
    <!-- irreversible, and Select all can point it at the whole library — the
         count stays so the blast radius is visible before the confirm dialog -->
    <button class="sel-btn sel-remove" onclick="removeSelectedRecords()" title="Forget these files — the records leave the library, the files on disk are NOT touched">✂ Forget (${selectedIds.size})</button>
    <button class="sel-btn sel-clear" onclick="clearSelection()" title="Clear selection">✕</button>
  `;
  bar.classList.add('visible');
}

/**
 * Re-queue the selected files whose scan never landed. Deliberately NOT called
 * "rescan": it doesn't force successfully-scanned files through the model again,
 * it only picks up the ones that errored or were never scanned at all.
 *
 * Work goes through the same background import queue as a fresh drop, so it
 * reports in the scan panel and inherits its pause / halt-on-dead-model
 * handling — rather than blocking on one file at a time like the per-item
 * rescan button in the sidebar.
 */
async function retryErrorsSelected() {
  const ids = selectedMedia().filter(m => m.processing_error).map(m => m.id);
  if (!ids.length) { showToast('Nothing to retry in this selection'); return; }
  try {
    const resp = await fetch('/api/media/retry-errors', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const r = await resp.json().catch(() => ({}));
    if (!resp.ok) { showToast('⚠ ' + (r.error || `HTTP ${resp.status}`)); return; }
    // Report what actually moved. Files already in the queue, or gone from disk,
    // are named rather than folded into a number that would overstate the work.
    const notes = [];
    if (r.alreadyQueued) notes.push(`${r.alreadyQueued} already queued`);
    if (r.missing) notes.push(`${r.missing} missing from disk`);
    if (!r.queued) {
      showToast(notes.length ? `Nothing new to queue — ${notes.join(', ')}` : 'Nothing to retry');
      return;
    }
    showToast(`↻ Queued ${r.queued} file(s) for another scan${notes.length ? ` · ${notes.join(', ')}` : ''}`);
    // Surface the scan panel so the retry is visible, and pick up the new rows
    // as they land.
    if (typeof window.vaultWatchScanQueue === 'function') window.vaultWatchScanQueue({ fresh: true });
    if (typeof watchUnscanned === 'function') watchUnscanned();
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

/* ── Rescan the filtered set (🔍 Scan filter) ──────────────────────────── */
//
// The bulk bar above works on a SELECTION; this one works on whatever the
// filters currently show, which is the natural follow-up to picking "Failed"
// or "Unscanned" — nobody wants to select 4,000 tiles first.

/** What the button would act on right now. */
function rescanFilteredTargets() {
  const items = (typeof filteredMedia !== 'undefined' ? filteredMedia : [])
    .filter(m => !m.user_trashed);
  const needy = items.filter(m => m.processing_error);       // failed + unscanned
  const done = items.length - needy.length;
  // With nothing broken in view the button is a deliberate force-rescan of the
  // whole filtered set; otherwise it targets just the rows that need one.
  return needy.length > 0 && done === 0
    ? { ids: needy.map(m => m.id), force: false, done: 0 }
    : { ids: items.map(m => m.id), force: done > 0, done };
}

/** Show/label the button under the 🔍 Scan filter. Called from applyFilters. */
function updateRescanFilteredButton() {
  const btn = document.getElementById('rescanFilteredBtn');
  if (!btn) return;
  const { ids, force, done } = rescanFilteredTargets();
  if (ids.length === 0) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.textContent = `↻ Rescan these (${ids.length.toLocaleString()})`;
  btn.classList.toggle('force', force);
  btn.title = force
    ? `Re-run AI analysis on all ${ids.length.toLocaleString()} filtered file(s) — ${done.toLocaleString()} of them already scanned successfully. Your notes, stars, ratings and flags are kept.`
    : `Queue ${ids.length.toLocaleString()} file(s) whose scan failed or never ran`;
}

async function rescanFiltered() {
  const { ids, force, done } = rescanFilteredTargets();
  if (!ids.length) { showToast('Nothing in view to rescan'); return; }

  // Only the force path costs anything the user might not want: it burns real
  // GPU time re-analyzing files that are already fine.
  if (force && !confirm(
    `Re-run AI analysis on ${ids.length.toLocaleString()} file(s)?\n\n` +
    `${done.toLocaleString()} of them already scanned successfully and will be tagged again ` +
    `from scratch — this can take a long time.\n\n` +
    `Your notes, stars, ratings and flags are NOT affected.`)) return;

  try {
    const resp = await fetch('/api/media/batch-rescan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, force }),
    });
    const r = await resp.json().catch(() => ({}));
    if (!resp.ok) { showToast('⚠ ' + (r.error || `HTTP ${resp.status}`)); return; }
    const notes = [];
    if (r.alreadyQueued) notes.push(`${r.alreadyQueued} already queued`);
    if (r.missing) notes.push(`${r.missing} missing from disk`);
    if (!r.queued) {
      showToast(notes.length ? `Nothing new to queue — ${notes.join(', ')}` : 'Nothing to rescan');
      return;
    }
    showToast(`↻ Queued ${r.queued} file(s) for scanning${notes.length ? ` · ${notes.join(', ')}` : ''}`);
    if (typeof window.vaultWatchScanQueue === 'function') window.vaultWatchScanQueue({ fresh: true });
    if (typeof watchUnscanned === 'function') watchUnscanned();
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

/* ── Trash / restore actions ───────────────────────────────────────────── */

/**
 * POST ids to a trash endpoint and sync returned rows into allMedia.
 * @returns {{okIds:number[], failures:string[]}}
 */
async function postTrashOp(endpoint, ids, extra = {}) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, ...extra }),
  });
  if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
  const { results } = await resp.json();

  const okIds = [];
  const failures = [];
  for (const r of results) {
    if (r.ok) {
      // trash/restore return the updated row; destructive delete has none (the
      // record is gone) — ok is still ok.
      if (r.row) { const item = getMediaById(r.id); if (item) Object.assign(item, r.row); }
      okIds.push(r.id);
    } else {
      const m = getMediaById(r.id);
      failures.push(`${m ? m.filename : '#' + r.id}: ${r.error}`);
    }
  }
  return { okIds, failures };
}

/* ── Delete mode (soft = trash folder · recycle = OS bin · hard = gone) ──────
   A global viewer preference read by every delete entry point (card 🗑,
   sidebar, details, selection bar). Persisted in localStorage. */
function getDeleteMode() {
  const m = (() => { try { return localStorage.getItem('vault_delete_mode'); } catch { return null; } })();
  return (m === 'recycle' || m === 'hard') ? m : 'soft';
}
function setDeleteMode(mode) {
  try { localStorage.setItem('vault_delete_mode', mode); } catch {}
  const sel = document.getElementById('deleteModeSelect');
  if (sel) sel.value = mode;
  if (typeof renderResults === 'function') renderResults();   // card 🗑 tooltips reflect the mode
}

/* ── Delete / restore queue ───────────────────────────────────────────────
   A SINGLE serialized worker drains a global queue. Enqueuing more while it
   runs just appends — no concurrent loops (which used to collide on one shared
   progress bar and throw on re-delete). A bottom-right panel shows the live
   queue with per-file state + a rolling-average ETA; queued/in-flight cards
   grey out so they can't be opened or re-deleted mid-flight. The panel hides
   itself behind the full player (see CSS) so it's a Library-view affordance. */

const _dqBusyIds = new Set();   // ids queued/deleting → greyed + non-interactive
const _dq = { items: [], running: false, durations: [] };
let _dqSeq = 0;
let _dqHideTimer = null;
let _dqPurged = false;          // a destructive delete removed rows this drain → refresh fuse

/** True while an id is queued or being processed (renderTile greys these so
 *  the state survives grid re-renders). */
function isCardBusy(id) { return _dqBusyIds.has(id); }

function _setTileBusy(id, busy) {
  document.querySelector(`.media-tile[data-id="${id}"]`)?.classList.toggle('tile-busy', busy);
}

/**
 * Queue a batch of ids for an op ('trash' | 'restore'). Returns a promise that
 * resolves { okIds, failures } once THIS batch's items are all processed —
 * callers await their own batch while the worker keeps draining everything.
 */
function _dqEnqueue(ids, op, { mode = null } = {}) {
  const batch = { remaining: ids.length, okIds: [], failures: [], resolve: null };
  const done = new Promise(res => { batch.resolve = res; });
  if (!ids.length) { batch.resolve({ okIds: [], failures: [] }); return done; }
  clearTimeout(_dqHideTimer);
  for (const id of ids) {
    _dq.items.push({ seq: ++_dqSeq, id, op, mode, state: 'queued', batch, error: null });
    _dqBusyIds.add(id);
    _setTileBusy(id, true);
  }
  _dqRender();
  _dqPump();
  return done;
}

async function _dqPump() {
  if (_dq.running) return;
  const item = _dq.items.find(it => it.state === 'queued');
  if (!item) return;
  _dq.running = true;
  item.state = 'active';
  item.startedAt = Date.now();
  _dqRender();

  const endpoint = item.op === 'trash' ? '/api/trash'
    : item.op === 'restore' ? '/api/untrash' : '/api/delete';
  const extra = item.op === 'delete' ? { mode: item.mode } : {};
  const m = getMediaById(item.id);
  let ok = false;
  try {
    const { okIds, failures } = await postTrashOp(endpoint, [item.id], extra);
    if (okIds.length) { ok = true; item.batch.okIds.push(...okIds); }
    if (failures.length) { item.error = failures[0]; item.batch.failures.push(...failures); }
  } catch (err) {
    item.error = `${m ? m.filename : '#' + item.id}: ${err.message}`;
    item.batch.failures.push(item.error);
  }
  _dq.durations.push(Date.now() - item.startedAt);
  item.state = ok ? 'done' : 'failed';

  // Card: a destructive delete removes the row entirely (drop from cache +
  // collapse tile); a soft-trashed file leaving the hidden filter collapses
  // too; everything else just un-greys.
  _dqBusyIds.delete(item.id);
  if (ok && item.op === 'delete') {
    _dqPurged = true;
    if (typeof allMedia !== 'undefined') {
      const ix = allMedia.findIndex(x => x.id === item.id);
      if (ix >= 0) allMedia.splice(ix, 1);
    }
    removeTileFromGrid(item.id);
  } else if (ok && item.op === 'trash' && getTriFilterValue('filterTrashed') === '0') {
    removeTileFromGrid(item.id);
  } else {
    _setTileBusy(item.id, false);
  }

  if (--item.batch.remaining === 0) {
    item.batch.resolve({ okIds: item.batch.okIds, failures: item.batch.failures });
  }

  _dq.running = false;
  _dqRender();
  if (_dq.items.some(it => it.state === 'queued')) _dqPump();
  else _dqFinish();
}

function _dqFinish() {
  // Reconcile counts/pagination once, when the whole queue drains, then fade
  // the panel (keep it if anything failed so the error stays readable).
  if (_dqPurged) { _dqPurged = false; if (typeof invalidateFuse === 'function') invalidateFuse(); }
  if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
  const anyFail = _dq.items.some(it => it.state === 'failed');
  if (!anyFail) {
    _dqHideTimer = setTimeout(() => {
      _dq.items = []; _dq.durations = [];
      document.getElementById('deleteQueue')?.classList.remove('visible');
    }, 2500);
  }
  _dqRender();
}

/** Rolling-average ETA across still-pending items (server gives no sub-file
 *  progress, so this is the honest signal for a multi-file queue). */
function _dqEtaText() {
  const pending = _dq.items.filter(it => it.state === 'queued' || it.state === 'active').length;
  if (!pending || !_dq.durations.length) return '';
  const avg = _dq.durations.reduce((a, b) => a + b, 0) / _dq.durations.length;
  const sec = Math.round((avg * pending) / 1000);
  if (sec < 1) return '';
  return ` · ~${sec >= 90 ? `${Math.round(sec / 60)} min` : `${sec}s`} left`;
}

function _dqRender() {
  let el = document.getElementById('deleteQueue');
  if (!_dq.items.length) { el?.classList.remove('visible'); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'deleteQueue';
    el.className = 'delete-queue';
    queuePanelStack().appendChild(el);
  }

  const total = _dq.items.length;
  const done = _dq.items.filter(it => it.state === 'done' || it.state === 'failed').length;
  const failed = _dq.items.filter(it => it.state === 'failed').length;
  const allDone = done === total;
  // Verb reflects the actual op/mode: restore, or delete-flavored.
  let verbing, verbed;
  if (_dq.items.some(it => it.op === 'restore')) { verbing = 'Restoring'; verbed = 'Restored'; }
  else if (_dq.items.some(it => it.mode === 'hard')) { verbing = 'Deleting (permanent)'; verbed = 'Deleted'; }
  else if (_dq.items.some(it => it.mode === 'recycle')) { verbing = 'Recycling'; verbed = 'Recycled'; }
  else { verbing = 'Deleting'; verbed = 'Deleted'; }

  const ICON = { queued: '<span class="dq-dot">•</span>', active: '<span class="dq-spin"></span>', done: '✓', failed: '✗' };
  // Show EVERY item — the list scrolls (CSS caps it at ~5 rows) and we scroll
  // the active row into view, so the file actually being deleted is always
  // visible instead of getting pushed off by the queued ones.
  const rowHtml = _dq.items.map(it => {
    const m = getMediaById(it.id);
    const name = m ? m.filename : `#${it.id}`;
    // Only QUEUED items are cleanly cancelable — an active one is already
    // mid-flight on the server; done/failed are settled.
    const cancel = it.state === 'queued'
      ? `<button class="dq-cancel" data-seq="${it.seq}" title="Cancel this delete" aria-label="Cancel">✕</button>`
      : '';
    return `<div class="dq-row dq-${it.state}" data-id="${it.id}" title="${escapeHtml(it.error || name)}">
      <span class="dq-ico">${ICON[it.state]}</span>
      <span class="dq-name">${escapeHtml(name)}</span>
      ${cancel}
    </div>`;
  }).join('');

  const headText = allDone
    ? `${verbed} ${done}/${total}${failed ? ` · ${failed} failed` : ''}`
    : `${verbing} ${Math.min(done + 1, total)}/${total}${_dqEtaText()}`;

  el.innerHTML = `
    <div class="dq-head">
      ${allDone ? '' : '<span class="dq-spin"></span>'}
      <span class="dq-title">${escapeHtml(headText)}</span>
      ${allDone ? '<button class="dq-x" title="Dismiss">✕</button>' : ''}
    </div>
    <div class="dq-list">${rowHtml}</div>`;
  el.classList.add('visible');
  el.querySelector('.dq-x')?.addEventListener('click', () => {
    _dq.items = []; _dq.durations = [];
    el.classList.remove('visible');
  });
  el.querySelectorAll('.dq-cancel').forEach(b =>
    b.addEventListener('click', () => _dqCancel(Number(b.dataset.seq))));
  // Keep the in-flight file visible in the scroll region
  const active = _dq.items.find(it => it.state === 'active');
  if (active) el.querySelector(`.dq-row[data-id="${active.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** Cancel a still-queued item: drop it, un-grey its card, and settle its batch
 *  if it was the last member. Active/done/failed items are left alone. */
function _dqCancel(seq) {
  const idx = _dq.items.findIndex(it => it.seq === seq);
  if (idx < 0) return;
  const item = _dq.items[idx];
  if (item.state !== 'queued') return;   // can't cancel one already running/settled

  _dq.items.splice(idx, 1);
  _dqBusyIds.delete(item.id);
  _setTileBusy(item.id, false);          // restore the card immediately

  // A canceled item contributes nothing to okIds/failures; if it was the batch's
  // last outstanding member, resolve the awaiting caller with what's done so far.
  if (--item.batch.remaining === 0) {
    item.batch.resolve({ okIds: item.batch.okIds, failures: item.batch.failures });
  }

  // Nothing left running/queued → wrap up (reconcile + fade); else just repaint.
  if (!_dq.items.some(it => it.state === 'queued' || it.state === 'active')) _dqFinish();
  else _dqRender();
}

/**
 * Remove a tile from the grid immediately (with a quick collapse) so
 * progress is visible file-by-file instead of the grid updating at the end.
 */
function removeTileFromGrid(id) {
  const tile = document.querySelector(`.media-tile[data-id="${id}"]`);
  if (!tile) return;
  tile.classList.add('tile-leaving');
  setTimeout(() => tile.remove(), 180);
}

/**
 * The single "delete" entry point (card 🗑, sidebar, details, bulk). Branches
 * on the user's delete mode: soft → trash folder (undoable), recycle → OS bin,
 * hard → permanent. All three funnel through the same serialized queue.
 */
async function trashIds(ids, { confirmBulk = false } = {}) {
  const toTrash = ids.filter(id => {
    const m = getMediaById(id);
    return m && !m.user_trashed;
  });
  if (toTrash.length === 0) return { okIds: [], failures: [] };

  const mode = getDeleteMode();
  if (mode !== 'soft') return _destructiveDelete(toTrash, mode);

  if (confirmBulk && toTrash.length > 1) {
    const ok = confirm(`Move ${toTrash.length} file(s) to the trash folder?\n\nFiles are moved on disk (not deleted) and can be restored.`);
    if (!ok) return { okIds: [], failures: [] };
  }

  try {
    // Queue drives the UI (progress panel + card greying + reconcile-on-drain)
    const { okIds, failures } = await _dqEnqueue(toTrash, 'trash');

    if (failures.length) {
      showToast(`⚠ ${failures.length} failed: ${failures[0]}${failures.length > 1 ? ' (+' + (failures.length - 1) + ' more)' : ''}`);
      console.warn('[Trash] failures:', failures);
    }

    if (okIds.length) {
      showUndoToast(
        `🗑 ${okIds.length} file(s) moved to trash`,
        () => restoreIds(okIds)
      );
    }
    return { okIds, failures };
  } catch (err) {
    console.error('[Trash] failed:', err);
    showToast('⚠ Trash failed: ' + err.message);
    return { okIds: [], failures: [String(err.message || err)] };
  }
}

/** recycle / hard delete (no soft-trash undo). Confirms on bulk, and always
 *  for a single hard delete (irreversible) — recycle is OS-recoverable. */
async function _destructiveDelete(ids, mode) {
  const n = ids.length;
  const needConfirm = n > 1 || mode === 'hard';
  if (needConfirm) {
    const msg = mode === 'hard'
      ? `⚠ PERMANENTLY delete ${n} file(s) from disk? This CANNOT be undone.`
      : `Delete ${n} file(s) to the Recycle Bin?`;
    if (!confirm(msg)) return { okIds: [], failures: [] };
  }
  try {
    const { okIds, failures } = await _dqEnqueue(ids, 'delete', { mode });
    if (failures.length) {
      showToast(`⚠ ${failures.length} failed: ${failures[0]}${failures.length > 1 ? ' (+' + (failures.length - 1) + ' more)' : ''}`);
      console.warn('[Delete] failures:', failures);
    }
    if (okIds.length) {
      showToast(mode === 'hard'
        ? `🗑 Permanently deleted ${okIds.length} file(s)`
        : `♻ Sent ${okIds.length} file(s) to the Recycle Bin`);
    }
    return { okIds, failures };
  } catch (err) {
    console.error('[Delete] failed:', err);
    showToast('⚠ Delete failed: ' + err.message);
    return { okIds: [], failures: [String(err.message || err)] };
  }
}

async function restoreIds(ids) {
  const toRestore = ids.filter(id => {
    const m = getMediaById(id);
    return m && m.user_trashed;
  });
  if (toRestore.length === 0) return { okIds: [], failures: [] };

  try {
    const { okIds, failures } = await _dqEnqueue(toRestore, 'restore');

    if (failures.length) {
      showToast(`⚠ ${failures.length} failed: ${failures[0]}${failures.length > 1 ? ' (+' + (failures.length - 1) + ' more)' : ''}`);
      console.warn('[Restore] failures:', failures);
    }
    if (okIds.length) showToast(`♻ ${okIds.length} file(s) restored`);
    return { okIds, failures };
  } catch (err) {
    console.error('[Restore] failed:', err);
    showToast('⚠ Restore failed: ' + err.message);
    return { okIds: [], failures: [String(err.message || err)] };
  }
}

/* ── Empty trash — permanent, irreversible purge ───────────────────────────
   Deletes every trashed file from disk AND all its records/traces. Guarded by
   a size-aware confirm + a final "really?" so it can't fire by accident. */
async function clearTrash() {
  const trashed = (typeof allMedia !== 'undefined' ? allMedia : []).filter(m => m.user_trashed);
  if (!trashed.length) { showToast('Trash is already empty'); return; }

  const bytes = trashed.reduce((a, m) => a + (m.filesize_bytes || 0), 0);
  const size = typeof formatFileSize === 'function' ? formatFileSize(bytes) : `${Math.round(bytes / 1e6)} MB`;
  if (!confirm(`⚠ PERMANENTLY delete ${trashed.length} file(s) in the trash (${size})?\n\n` +
    `This erases the files from disk AND every record, note, rating, subtitle and view-history trace. It CANNOT be undone.`)) return;
  if (!confirm(`Last chance — really delete ${trashed.length} file(s) forever?`)) return;

  const btn = document.getElementById('clearTrashBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Emptying…'; }
  try {
    const resp = await fetch('/api/trash/empty', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await resp.json();
    if (!resp.ok) { showToast('⚠ ' + (data.error || 'empty trash failed')); return; }
    // Drop the purged rows from the client cache and re-render
    const gone = new Set(trashed.map(m => m.id));
    if (typeof allMedia !== 'undefined') allMedia = allMedia.filter(m => !gone.has(m.id));
    if (typeof invalidateFuse === 'function') invalidateFuse();
    if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
    showToast(`🗑 Permanently deleted ${data.deleted} file(s)${data.filesDeleted < data.deleted ? ` (${data.deleted - data.filesDeleted} already gone from disk)` : ''}`);
  } catch (err) {
    showToast('⚠ ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
    updateClearTrashUi();
  }
}

/** Show/label the Empty-trash button from the current trashed count. */
function updateClearTrashUi() {
  const btn = document.getElementById('clearTrashBtn');
  if (!btn) return;
  const n = (typeof allMedia !== 'undefined' ? allMedia : []).filter(m => m.user_trashed).length;
  btn.style.display = n ? '' : 'none';
  btn.textContent = `🗑 Empty trash (${n})`;
}

function trashSelected() {
  trashIds([...selectedIds], { confirmBulk: true }).then(() => clearSelection());
}

function restoreSelected() {
  restoreIds([...selectedIds]).then(() => clearSelection());
}

function trashSingle(id) {
  trashIds([id]);
}

function restoreSingle(id) {
  restoreIds([id]);
}

/** Trash/restore the CURRENT file from the player sidebar.
 *  Trashing advances the player to the next queued file (or the previous one
 *  if this was the last, or closes if the queue is now empty) instead of
 *  dumping you back to the grid — so a trash-spree keeps flowing. */
async function trashOrRestoreFromSidebar(id) {
  const m = getMediaById(id);
  if (!m) return;

  // Restore keeps the item visible in most filters — no navigation needed.
  if (m.user_trashed) {
    if (typeof closeMediaPlayer === 'function') closeMediaPlayer();
    restoreIds([id]);
    return;
  }

  const playerOpen = document.getElementById('mediaPlayerOverlay')?.classList.contains('active');
  if (!playerOpen) { trashIds([id]); return; }

  // Pick the neighbour to land on BEFORE the trash reshuffles filteredMedia:
  // prefer the next file, fall back to the previous one.
  const idx = typeof getCurrentMediaIndex === 'function'
    ? getCurrentMediaIndex(m.filepath)
    : filteredMedia.findIndex(x => x.id === id);
  let target = null;
  if (idx !== -1) {
    const cand = filteredMedia[idx + 1] || filteredMedia[idx - 1] || null;
    if (cand && cand.id !== id) {
      target = { filepath: cand.filepath, filename: cand.filename, media_type: cand.media_type };
    }
  }

  await trashIds([id]);

  // Navigate if the neighbour survived the reconcile; otherwise nothing's left.
  if (target && filteredMedia.some(x => x.filepath === target.filepath)) {
    playMedia(target);
    if (typeof refreshSidebarIfOpen === 'function') refreshSidebarIfOpen();
  } else if (typeof closeMediaPlayer === 'function') {
    closeMediaPlayer();
  }
}

/** Trash/restore from the details sidebar — closes it first. */
function trashOrRestoreFromDetails(id) {
  const m = getMediaById(id);
  if (!m) return;
  closeModal();
  if (m.user_trashed) restoreIds([id]);
  else trashIds([id]);
}

/**
 * Trash/restore a DUPLICATE listed in the details panel, then re-render the
 * panel (it stays open on the current item, with the dupe's state updated).
 */
async function trashDupeFromDetails(dupeId, currentId) {
  const m = getMediaById(dupeId);
  if (!m) return;
  if (m.user_trashed) await restoreIds([dupeId]);
  else await trashIds([dupeId]);
  // Refresh the open panel so the button/state update in place
  const current = getMediaById(currentId);
  if (current) showDetails(current);
}

/* ── Bulk flag ─────────────────────────────────────────────────────────── */

async function bulkFlag(value) {
  const items = selectedMedia().filter(m => (m.user_flagged_delete ? 1 : 0) !== value);
  for (const item of items) {
    item.user_flagged_delete = value;
    await postFlags(item, { user_flagged_delete: value });
  }
  renderResults();
  renderSelectionBar();
  if (items.length) showToast(`${value ? '🚩 Flagged' : 'Unflagged'} ${items.length} file(s)`);
}

/* ── Undo toast ────────────────────────────────────────────────────────── */

let _undoTimer = null;

function showUndoToast(message, onUndo, ms = 8000) {
  let el = document.getElementById('undoToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'undoToast';
    el.className = 'undo-toast';
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <span>${message}</span>
    <button class="undo-btn">Undo</button>
    <button class="undo-dismiss" title="Dismiss">✕</button>
  `;
  el.querySelector('.undo-btn').addEventListener('click', () => {
    hideUndoToast();
    onUndo();
  });
  el.querySelector('.undo-dismiss').addEventListener('click', hideUndoToast);

  el.classList.add('visible');
  clearTimeout(_undoTimer);
  _undoTimer = setTimeout(hideUndoToast, ms);
}

function hideUndoToast() {
  clearTimeout(_undoTimer);
  const el = document.getElementById('undoToast');
  if (el) el.classList.remove('visible');
}

/* ── Playback-failure auto-detection (P4) ──────────────────────────────── */

/**
 * Media element errors inside the player bubble nowhere — catch them in the
 * capture phase and persist playback_failed so the item can be filtered.
 */
/** Is this the media element the player is currently showing? */
function _isCurrentPlayerMedia(el) {
  if (!(el instanceof HTMLElement)) return null;
  if (!['VIDEO', 'AUDIO', 'IMG'].includes(el.tagName)) return null;
  if (!el.closest('#mediaPlayerContent') && !el.closest('#miniPlayerMedia')) return null;
  const media = (typeof currentMediaState !== 'undefined' && currentMediaState.currentMediaData) || null;
  return media && media.id ? media : null;
}

document.addEventListener('error', (e) => {
  const media = _isCurrentPlayerMedia(e.target);
  if (media && !media.playback_failed) {
    media.playback_failed = 1;
    postFlags(media, { playback_failed: 1 });
    // Privacy / streaming mode handles the same failure by skipping to the next
    // file (handleMediaError in player-core.js) and says so itself. Two toasts
    // for one dead file reads as two separate problems, so only the flag is
    // set here and the message is left to the handler that acted on it.
    if (!document.body.classList.contains('privacy-mode')) {
      showToast('⚠ File failed to play — marked as unplayable');
    }
  }
}, true);

/**
 * ...and the mirror image, which was missing: a file that plays is not a
 * failed file.
 *
 * The usual way this flag gets set is an unplugged/offline drive — the file is
 * fine, the path just isn't there right now. Reconnect the drive, play it, and
 * the ⚠ and the red border used to stay forever, because nothing ever cleared
 * the flag. Marking on failure without unmarking on success turns a transient
 * condition into a permanent one.
 *
 * canplay (video/audio) and load (img) both mean the server served real bytes
 * and the browser decoded them, which is exactly the condition that was false
 * when the flag went on. Neither event bubbles, hence the capture phase — same
 * as the error listener above.
 */
function _clearPlaybackFailed(e) {
  const media = _isCurrentPlayerMedia(e.target);
  if (!media || !media.playback_failed) return;
  media.playback_failed = 0;
  postFlags(media, { playback_failed: 0 });
  showToast('✓ Plays fine now — unplayable flag cleared');
  // Repaint so the ⚠ badge and the red tile border go without a manual refresh.
  if (typeof refreshInfoSurfaces === 'function') refreshInfoSurfaces(media);
  else if (typeof renderResults === 'function') renderResults();
}
document.addEventListener('canplay', _clearPlaybackFailed, true);
document.addEventListener('load', _clearPlaybackFailed, true);
