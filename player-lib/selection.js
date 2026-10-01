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

// Bumped on every change to selectedIds, so the counts derived from it (the
// selection bar, "all selected") are recomputed only when they can differ.
let _selGen = 0;
function selectionChanged() { _selGen++; }

// A selection this size or smaller is counted from its rows; a bigger one
// asks the server (POST /api/library/ids-summary) instead of fetching rows.
const SMALL_SELECTION = 2000;
// Ids per request for the bulk endpoints (the server takes 2 MB of JSON).
const BULK_ID_CHUNK = 50000;

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
  selectionChanged();

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
  return [...document.querySelectorAll('#resultsGrid .media-tile[data-id]')].map(t => Number(t.dataset.id));
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
  selectionChanged();
  syncTileCheckboxes();
  renderSelectionBar();
}

/** Is every id of the current result selected? Remembered per selection. */
let _allSelMemo = { gen: -1, ids: null, value: false };
function allResultsSelected() {
  const ids = Library.ids;
  if (!ids || !ids.length) return false;
  if (_allSelMemo.gen === _selGen && _allSelMemo.ids === ids) return _allSelMemo.value;
  // size check first: with a big library the cheap comparison short-circuits
  // the common "a handful selected" case before touching every id.
  let value = selectedIds.size >= ids.length;
  if (value) for (let i = 0; i < ids.length; i++) if (!selectedIds.has(ids[i])) { value = false; break; }
  _allSelMemo = { gen: _selGen, ids, value };
  return value;
}

/**
 * Select the WHOLE result set, not just the rendered page: every id the
 * current search/filter matches, across every page (the server's ordered id
 * list, waited for if it is still on its way).
 */
async function toggleSelectAllFiltered() {
  // A filter changed a moment ago, or a search is still waiting out its
  // debounce: select what that new query returns, not the result still on
  // screen while it was on its way.
  if (typeof flushPendingSearch === 'function') await flushPendingSearch();
  await Library.settled();
  const ids = await Library.waitIds();
  if (!ids || !ids.length) return;
  if (allResultsSelected()) for (let i = 0; i < ids.length; i++) selectedIds.delete(ids[i]);
  else for (let i = 0; i < ids.length; i++) selectedIds.add(ids[i]);
  selectionChanged();
  lastSelectedId = null;                 // a cross-page range anchor is meaningless
  syncTileCheckboxes();
  renderSelectionBar();
}

/**
 * The two select controls that live in the results row.
 * Rendered whether or not anything is selected — unlike the action bar, these
 * are how you START a selection.
 */
let _resultsSelectHtml = null;   // last markup written, so a repaint that says
                                 // the same thing does not touch the DOM

/** Write the row only when its content actually changed. */
function writeResultsSelect(host, html) {
  if (html === _resultsSelectHtml) return;
  _resultsSelectHtml = html;
  host.innerHTML = html;
}

function renderResultsSelect() {
  const host = document.getElementById('resultsSelect');
  if (!host) return;
  const onLibrary = typeof currentTab === 'undefined' || currentTab === 'library';
  const total = Library.length();
  if (!onLibrary || !total) { writeResultsSelect(host, ''); return; }

  const pageIds = currentPageIds();
  const pageAll = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
  const known = Library.known();
  const allSelected = known && allResultsSelected();
  // While the count is still coming, Select all says so after 400 ms
  // ("counting…") and stays away before that, so a fast count never flashes.
  let allBtn = '';
  if (known ? total > pageIds.length : Library.counting) {
    allBtn = `<button class="rs-btn" onclick="toggleSelectAllFiltered()"
      title="Select every file matching the current search &amp; filters, across all pages">${allSelected ? 'Deselect all'
        : known ? `Select all ${total.toLocaleString()}` : 'Select all (counting…)'}</button>`;
  }

  writeResultsSelect(host, `
    ${pageIds.length ? `<button class="rs-btn" onclick="toggleSelectPage()"
      title="Select the ${pageIds.length} file(s) shown on this page">${pageAll ? 'Deselect page' : `Select page (${pageIds.length})`}</button>` : ''}
    ${allBtn}`);
}

function clearSelection() {
  selectedIds.clear();
  selectionChanged();
  lastSelectedId = null;
  syncTileCheckboxes();
  renderSelectionBar();
}

/**
 * The selected rows that are cached. Callers that need every selected row
 * use selectedRows() (small selections) or selectionCounts() (any size).
 */
function selectedMedia() {
  const out = [];
  for (const id of selectedIds) {
    const m = Library.row(id);
    if (m) out.push(m);
  }
  return out;
}

/**
 * Every selected row, fetched where missing. For small selections.
 * Rejects (Library.RowsUnavailable) when some could not be loaded: a bulk
 * action must never quietly act on part of the selection. Records that are
 * no longer in the library are left out, and the user is told.
 */
async function selectedRows() {
  const rows = await Library.fetchRows([...selectedIds], { strict: true });
  noteGoneRows(rows);
  return rows.filter(Boolean);
}

/** Say so when some asked-for records have left the library meanwhile. */
function noteGoneRows(rows) {
  if (rows && rows.gone) showToast(`${rows.gone.toLocaleString()} selected file(s) are no longer in the library and were left out`);
}

/** The message for a bulk action that could not load its rows. */
function bulkLoadFailed(err) {
  showToast('⚠ ' + ((err && err.message) || 'Could not load the selected files. Try again.'));
}

/* What the selection bar counts. A small selection is counted from its rows
   (fetched where the cache lacks them); a big one is counted by the server
   from the ids alone, so selecting a whole 2M-file library never pulls its
   rows into the tab. */

let _selCounts = { key: '', data: null, busy: false };

function countRows(rows) {
  const c = { trashed: 0, flagged: 0, errored: 0, unscanned: 0, av: 0, video: 0 };
  for (const m of rows) {
    if (m.user_trashed) c.trashed++;
    if (m.user_flagged_delete) c.flagged++;
    if (m.processing_error === 'unscanned') c.unscanned++;
    else if (m.processing_error) c.errored++;
    if (m.media_type === 'video' || m.media_type === 'audio') c.av++;
    if (m.media_type === 'video') c.video++;
  }
  c.count = rows.length;
  return c;
}

/** The selection's counts now, or the last ones while new ones are on the way. */
function selectionCounts() {
  if (selectedIds.size <= SMALL_SELECTION) {
    const rows = selectedMedia();
    if (rows.length === selectedIds.size) return countRows(rows);
    // Some rows are not cached: count the fetched answer, not the cache
    // (which can drop rows while a big fetch runs). Until it is in, the bar
    // keeps its last counts.
    const key = `rows:${_selGen}:${Library.version}`;
    if (_selCounts.key !== key && !_selCounts.busy) {
      _selCounts.busy = true;
      const want = key;
      Library.fetchRows([...selectedIds]).then((got) => {
        const found = got.filter(Boolean);
        // Rows that could not be loaded: try again on the next render.
        _selCounts = { key: got.failed ? '' : want, busy: false, data: { ...countRows(found), count: selectedIds.size } };
        renderSelectionBar();
      }, () => { _selCounts.busy = false; });
    }
    return _selCounts.data || { ...countRows(rows), count: selectedIds.size };
  }
  const key = `sum:${_selGen}:${Library.version}`;
  if (_selCounts.key !== key && !_selCounts.busy) {
    _selCounts.busy = true;
    const want = key;
    Library.idsSummary(Uint32Array.from(selectedIds)).then((s) => {
      _selCounts = {
        key: want,
        busy: false,
        data: {
          count: s.count, trashed: s.trashed, flagged: s.flagged,
          errored: s.scan.failed, unscanned: s.scan.unscanned,
          av: (s.types.video || 0) + (s.types.audio || 0), video: s.types.video || 0,
        },
      };
      renderSelectionBar();
    }, () => { _selCounts.busy = false; });
  }
  return _selCounts.data || { count: selectedIds.size, trashed: 0, flagged: 0, errored: 0, unscanned: 0, av: 0, video: 0 };
}

/** POST ids to a bulk endpoint in chunks the body limit takes; sum the answers. */
async function postIdsChunked(url, ids, extra = {}) {
  const total = {};
  for (let i = 0; i < ids.length; i += BULK_ID_CHUNK) {
    const resp = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids.slice(i, i + BULK_ID_CHUNK), ...extra }),
    });
    const r = await resp.json().catch(() => ({}));
    if (!resp.ok) return { ok: false, status: resp.status, error: r.error };
    for (const [k, v] of Object.entries(r)) {
      if (typeof v === 'number') total[k] = (total[k] || 0) + v;
    }
  }
  return { ok: true, ...total };
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

  const counts = selectionCounts();
  const trashedCount = counts.trashed;
  const activeCount = counts.count - trashedCount;

  // Music ID actions: fingerprint any A/V selection; stack/grid open videos
  // in the Editor (no hard cap — many concurrent decodes are drive-bound,
  // the Editor warns above 4)
  const avCount = counts.av;
  const vidCount = counts.video;
  const musicReady = typeof fingerprintSelected === 'function';
  const many = vidCount > 4 ? ' (playback smoothness depends on drive speed)' : '';
  const musicBtns = !musicReady ? '' : `
    ${avCount > 0 ? `<button class="sel-btn sel-music" onclick="fingerprintSelected()" title="Fingerprint audio, one-time per file. Auto-matches songs across the library">🎵 Music ID (${avCount})</button>` : ''}
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
  const flaggedCount = counts.flagged;
  const allFlagged = counts.count > 0 && flaggedCount === counts.count;
  const flagBtn = `<button class="sel-btn${allFlagged ? ' sel-flagged' : ''}" onclick="bulkFlag(${allFlagged ? 0 : 1})"
    title="${allFlagged
      ? 'Clear the delete flag on all selected'
      : `Flag for deletion${flaggedCount ? ` (${flaggedCount} of ${counts.count} already flagged)` : ''}`}"
    >${allFlagged ? '🏳 Unflag' : '🚩 Flag'}</button>`;

  // Files whose AI scan never landed: a real error, or a stub that was never
  // scanned (a cancelled queue leaves these). Only offered when the selection
  // actually contains some, which keeps the bar short the rest of the time.
  const errored = counts.errored;
  const unscanned = counts.unscanned;
  const retryable = errored + unscanned;
  const retryBtn = retryable === 0 ? '' : `<button class="sel-btn sel-retry" onclick="retryErrorsSelected()"
    title="Queue ${retryable} file(s) for another AI scan${errored ? `: ${errored} errored` : ''}${unscanned ? `${errored ? ',' : ':'} ${unscanned} never scanned` : ''}"
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
    <button class="sel-btn sel-remove" onclick="removeSelectedRecords()" title="Forget these files. The records leave the library, the files on disk are NOT touched">✂ Forget (${selectedIds.size})</button>
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
  const counts = selectionCounts();
  if (!(counts.errored + counts.unscanned)) { showToast('Nothing to retry in this selection'); return; }
  // The server picks the ones that need it (errored or never scanned, not in
  // the trash), so the whole selection goes, in chunks.
  const ids = [...selectedIds];
  try {
    const r = await postIdsChunked('/api/media/retry-errors', ids);
    if (!r.ok) { showToast('⚠ ' + (r.error || `HTTP ${r.status}`)); return; }
    // Report what actually moved. Files already in the queue, or gone from disk,
    // are named rather than folded into a number that would overstate the work.
    const notes = [];
    if (r.alreadyQueued) notes.push(`${r.alreadyQueued} already queued`);
    if (r.missing) notes.push(`${r.missing} missing from disk`);
    if (!r.queued) {
      showToast(notes.length ? `Nothing new to queue: ${notes.join(', ')}` : 'Nothing to retry');
      return;
    }
    showToast(`↻ Queued ${r.queued} file(s) for another scan${notes.length ? ` · ${notes.join(', ')}` : ''}`);
    // Surface the scan panel so the retry is visible; the new rows fill in as
    // they land (Library's version polling re-reads them).
    if (typeof window.vaultWatchScanQueue === 'function') window.vaultWatchScanQueue({ fresh: true });
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

/* ── Rescan the filtered set (🔍 Scan filter) ──────────────────────────── */
//
// The bulk bar above works on a SELECTION; this one works on whatever the
// filters currently show, which is the natural follow-up to picking "Failed"
// or "Unscanned" — nobody wants to select 4,000 tiles first.

/**
 * What the button would act on right now: every result outside the trash.
 * The button only shows while the Scan filter says Failed or Unscanned, so
 * every one of those needs a scan (none is a forced rescan of a good one).
 * With the trash hidden (the default) that is the result itself; otherwise
 * the server is asked again with the trash left out.
 */
async function rescanFilteredTargets() {
  const spec = Library.spec;
  if (!spec) return { ids: [], force: false, done: 0 };
  let ids;
  if (spec.filters.trashed === '0' || spec.onlyIds) {
    ids = await Library.waitIds();
  } else {
    const out = await Library.queryOnce({ ...spec, filters: { ...spec.filters, trashed: '0' } },
      { pageSize: 1, allIds: true });
    ids = out.ids;
  }
  return { ids: ids ? Array.from(ids) : [], force: false, done: 0 };
}

let _rescanBtnSeq = 0;

/** Show/label the Rescan button in the results row. Called from applyFilters.
    It belongs to the Scan filter, so it only appears while that filter is
    asking about broken rows: Failed or Unscanned. */
async function updateRescanFilteredButton() {
  const btn = document.getElementById('rescanFilteredBtn');
  if (!btn) return;
  const seq = ++_rescanBtnSeq;
  const scan = typeof getTriFilterValue === 'function' ? getTriFilterValue('filterScanStatus') : '';
  if (scan !== 'failed' && scan !== 'unscanned') { btn.style.display = 'none'; return; }
  let targets;
  try { targets = await rescanFilteredTargets(); } catch { return; }
  if (seq !== _rescanBtnSeq) return;
  const { ids, force, done } = targets;
  if (ids.length === 0) { btn.style.display = 'none'; return; }
  btn.style.display = '';
  btn.textContent = `↻ Rescan these (${ids.length.toLocaleString()})`;
  btn.classList.toggle('force', force);
  btn.title = force
    ? `Re-run AI analysis on all ${ids.length.toLocaleString()} filtered file(s). ${done.toLocaleString()} of them already scanned successfully. Your notes, stars, ratings and flags are kept.`
    : `Queue ${ids.length.toLocaleString()} file(s) whose scan failed or never ran`;
}

async function rescanFiltered() {
  const { ids, force, done } = await rescanFilteredTargets();
  if (!ids.length) { showToast('Nothing in view to rescan'); return; }

  // Only the force path costs anything the user might not want: it burns real
  // GPU time re-analyzing files that are already fine.
  if (force && !confirm(
    `Re-run AI analysis on ${ids.length.toLocaleString()} file(s)?\n\n` +
    `${done.toLocaleString()} of them already scanned successfully and will be tagged again ` +
    `from scratch, which can take a long time.\n\n` +
    `Your notes, stars, ratings and flags are NOT affected.`)) return;

  try {
    const r = await postIdsChunked('/api/media/batch-rescan', ids, { force });
    if (!r.ok) { showToast('⚠ ' + (r.error || `HTTP ${r.status}`)); return; }
    const notes = [];
    if (r.alreadyQueued) notes.push(`${r.alreadyQueued} already queued`);
    if (r.missing) notes.push(`${r.missing} missing from disk`);
    if (!r.queued) {
      showToast(notes.length ? `Nothing new to queue: ${notes.join(', ')}` : 'Nothing to rescan');
      return;
    }
    showToast(`↻ Queued ${r.queued} file(s) for scanning${notes.length ? ` · ${notes.join(', ')}` : ''}`);
    if (typeof window.vaultWatchScanQueue === 'function') window.vaultWatchScanQueue({ fresh: true });
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

/* ── Trash / restore actions ───────────────────────────────────────────── */

/**
 * POST ids to a trash endpoint and sync returned rows into the row cache.
 * @returns {{okIds:number[], failures:string[]}}
 */
async function postTrashOp(endpoint, ids, extra = {}, { retried = false } = {}) {
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, ...extra }),
    });
  } catch (err) {
    // No answer at all: the caller may not know whether it happened.
    err.noResponse = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
  const { results } = await resp.json();

  const okIds = [];
  const skippedIds = [];
  const failures = [];
  for (const r of results) {
    if (r.ok) {
      // trash/restore return the updated row; destructive delete has none (the
      // record is gone) — ok is still ok.
      if (r.row) Library.patchRow(r.row);
      okIds.push(r.id);
    } else if (r.skipped) {
      // Already where the op would put it, or (delete) moved to the trash
      // since the confirm: the server left it alone. Not a failure.
      if (r.row) Library.patchRow(r.row);
      skippedIds.push(r.id);
    } else if (retried && endpoint === '/api/delete' && r.error === 'row not found') {
      // Asked again after an earlier request got no answer: that request
      // reached the server and deleted the record, only its reply was lost.
      okIds.push(r.id);
    } else {
      const m = getMediaById(r.id);
      failures.push(`${m ? m.filename : '#' + r.id}: ${r.error}`);
    }
  }
  return { okIds, skippedIds, failures };
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
  // The control lives in Settings > Library now; keep its segments in step
  // whether the change came from there or from anywhere else.
  document.querySelectorAll('[data-delete-mode]').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.deleteMode === mode ? 'true' : 'false'));
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
/* Built to hold a whole library (Select all at 2M): items are processed in
   order from a cursor, settled ones are never searched again, and every
   count the panel shows is kept as it changes rather than recounted.
   Canceled items stay in place (state 'canceled') so the cursor stays valid. */
const _dq = {
  items: [], next: 0, running: false, paused: false, noAnswer: 0,
  counts: { queued: 0, active: 0, done: 0, skipped: 0, failed: 0 },
  ops: { restore: 0, hard: 0, recycle: 0 },
  recent: [],                     // last durations (ms), for the ETA
};
const DQ_RECENT = 50;             // rolling-average window for the ETA
const DQ_FULL_LIST_MAX = 200;     // up to this many items the panel lists them all
const DQ_WINDOW_BEFORE = 20;      // past that, a window around the active item
const DQ_WINDOW_AFTER = 80;
const DQ_RENDER_MS = 250;         // a big queue repaints at most 4 times a second
let _dqSeq = 0;
let _dqHideTimer = null;
let _dqRenderTimer = null;
let _dqLastRender = 0;

// After this many requests in a row get no answer, the queue pauses: it never
// carries on (or picks destructive work back up) by itself.
const DQ_PAUSE_AFTER = 3;

function _dqReset() {
  _dq.items = []; _dq.next = 0; _dq.recent = [];
  _dq.paused = false; _dq.noAnswer = 0;
  _dq.counts = { queued: 0, active: 0, done: 0, skipped: 0, failed: 0 };
  _dq.ops = { restore: 0, hard: 0, recycle: 0 };
}

/** Resume a paused queue (the user's choice, never automatic). */
function _dqResume() {
  if (!_dq.paused) return;
  _dq.paused = false;
  _dq.noAnswer = 0;
  _dqRender(true);
  _dqPump();
}

/** Cancel everything still waiting in the queue. */
function _dqCancelAll() {
  for (let i = _dq.next; i < _dq.items.length; i++) {
    const it = _dq.items[i];
    if (it.state !== 'queued') continue;
    _dqSettle(it, 'canceled');
    _dqBusyIds.delete(it.id);
    _setTileBusy(it.id, false);
    if (--it.batch.remaining === 0) it.batch.resolve({ okIds: it.batch.okIds, skippedIds: it.batch.skippedIds, failures: it.batch.failures });
  }
  _dq.paused = false;
  _dq.noAnswer = 0;
  if (!_dq.counts.active) _dqFinish();
  else _dqRender(true);
}

/** True while an id is queued or being processed (renderTile greys these so
 *  the state survives grid re-renders). */
function isCardBusy(id) { return _dqBusyIds.has(id); }

function _setTileBusy(id, busy) {
  document.querySelector(`.media-tile[data-id="${id}"]`)?.classList.toggle('tile-busy', busy);
}

/**
 * Queue a batch of ids for an op ('trash' | 'restore' | 'delete'). Returns a
 * promise that resolves { okIds, failures } once THIS batch's items are all
 * processed — callers await their own batch while the worker keeps draining.
 */
function _dqEnqueue(ids, op, { mode = null } = {}) {
  const batch = { remaining: ids.length, okIds: [], skippedIds: [], failures: [], resolve: null };
  const done = new Promise(res => { batch.resolve = res; });
  if (!ids.length) { batch.resolve({ okIds: [], skippedIds: [], failures: [] }); return done; }
  clearTimeout(_dqHideTimer);
  for (const id of ids) {
    _dq.items.push({ seq: ++_dqSeq, id, op, mode, state: 'queued', batch, error: null });
    _dqBusyIds.add(id);
  }
  _dq.counts.queued += ids.length;
  if (op === 'restore') _dq.ops.restore += ids.length;
  else if (mode === 'hard') _dq.ops.hard += ids.length;
  else if (mode === 'recycle') _dq.ops.recycle += ids.length;
  // Grey the tiles on screen (one pass over the page, not one lookup per id).
  document.querySelectorAll('#resultsGrid .media-tile[data-id]').forEach(t => {
    if (_dqBusyIds.has(Number(t.dataset.id))) t.classList.add('tile-busy');
  });
  _dqRender(true);
  _dqPump();
  return done;
}

function _dqSettle(item, state) {
  _dq.counts[item.state]--;
  item.state = state;
  _dq.counts[state] = (_dq.counts[state] || 0) + 1;
}

async function _dqPump() {
  if (_dq.running || _dq.paused) return;
  while (_dq.next < _dq.items.length && _dq.items[_dq.next].state !== 'queued') _dq.next++;
  const item = _dq.items[_dq.next];
  if (!item) return;
  _dq.running = true;
  _dqSettle(item, 'active');
  item.startedAt = Date.now();
  _dqRender();

  const endpoint = item.op === 'trash' ? '/api/trash'
    : item.op === 'restore' ? '/api/untrash' : '/api/delete';
  // The server decides, against the database at the moment it acts, whether
  // the file is still in the state the confirm counted: a delete refuses a
  // file in the trash (skipTrashed), trash and restore skip a file that is
  // already where they would put it (skipUnchanged). No cached row can be
  // wrong about it.
  const extra = item.op === 'delete' ? { mode: item.mode, skipTrashed: true } : { skipUnchanged: true };
  // A big selection is queued without its rows: fetch them a stretch ahead,
  // so the panel can name the files.
  if (!getMediaById(item.id)) {
    const ahead = [];
    for (let i = _dq.next; i < _dq.items.length && ahead.length < 500; i++) {
      const it = _dq.items[i];
      if ((it.state === 'queued' || it.state === 'active') && !getMediaById(it.id)) ahead.push(it.id);
    }
    await Library.fetchRows(ahead);
  }
  const m = getMediaById(item.id);
  let ok = false;
  let skipped = false;
  try {
    const out = await postTrashOp(endpoint, [item.id], extra, { retried: !!item.retried });
    if (out.okIds.length) { ok = true; item.batch.okIds.push(...out.okIds); }
    if (out.skippedIds.length) { skipped = true; item.batch.skippedIds.push(...out.skippedIds); }
    if (out.failures.length) { item.error = out.failures[0]; item.batch.failures.push(...out.failures); }
    _dq.noAnswer = 0;
  } catch (err) {
    if (err.noResponse) {
      // The server did not answer: put the file back at the head of the
      // queue (the server's skip checks make asking again safe), and after a
      // few of these in a row pause and say so.
      item.retried = true;
      _dqSettle(item, 'queued');
      _dq.running = false;
      if (++_dq.noAnswer >= DQ_PAUSE_AFTER) {
        _dq.paused = true;
        _dqRender(true);
        return;
      }
      _dqRender();
      setTimeout(_dqPump, 1000 * _dq.noAnswer);
      return;
    }
    item.error = `${m ? m.filename : '#' + item.id}: ${err.message}`;
    item.batch.failures.push(item.error);
    _dq.noAnswer = 0;                    // an HTTP error is still an answer
  }
  _dq.recent.push(Date.now() - item.startedAt);
  if (_dq.recent.length > DQ_RECENT) _dq.recent.shift();
  _dqSettle(item, ok ? 'done' : skipped ? 'skipped' : 'failed');
  _dq.next++;

  // Card: a destructive delete removes the row entirely (drop from cache +
  // collapse tile); a soft-trashed file leaving the hidden filter collapses
  // too; everything else just un-greys.
  _dqBusyIds.delete(item.id);
  if (ok && item.op === 'delete') {
    Library.forget([item.id]);
    removeTileFromGrid(item.id);
  } else if (ok && item.op === 'trash' && getTriFilterValue('filterTrashed') === '0') {
    removeTileFromGrid(item.id);
  } else {
    _setTileBusy(item.id, false);
  }

  if (--item.batch.remaining === 0) {
    item.batch.resolve({ okIds: item.batch.okIds, skippedIds: item.batch.skippedIds, failures: item.batch.failures });
  }

  _dq.running = false;
  if (_dq.counts.queued) { _dqRender(); _dqPump(); }
  else _dqFinish();
}

function _dqFinish() {
  // Reconcile counts/pagination once, when the whole queue drains, then fade
  // the panel (keep it if anything failed so the error stays readable).
  _dqSettled = typeof applyFilters === 'function' ? applyFilters({ keepPage: true }) : null;
  if (!_dq.counts.failed) {
    _dqHideTimer = setTimeout(() => {
      _dqReset();
      document.getElementById('deleteQueue')?.classList.remove('visible');
    }, 2500);
  }
  _dqRender(true);
}

// The re-query the last drain started: a caller that must see its result
// (the player's trash-and-move-on) waits for it.
let _dqSettled = null;

/** Rolling-average ETA across still-pending items (server gives no sub-file
 *  progress, so this is the honest signal for a multi-file queue). */
function _dqEtaText() {
  const pending = _dq.counts.queued + _dq.counts.active;
  if (!pending || !_dq.recent.length) return '';
  const avg = _dq.recent.reduce((a, b) => a + b, 0) / _dq.recent.length;
  const sec = Math.round((avg * pending) / 1000);
  if (sec < 1) return '';
  return ` · ~${sec >= 90 ? `${Math.round(sec / 60)} min` : `${sec}s`} left`;
}

/**
 * Repaint the panel. A small queue lists every item, as it always did; a big
 * one lists a window around the file in flight (the list shows about five
 * rows at a time anyway) and repaints at most every DQ_RENDER_MS.
 * @param {boolean} [now] skip the throttle (start, finish, cancel)
 */
function _dqRender(now = false) {
  const total = _dq.items.length - (_dq.counts.canceled || 0);
  if (!now && total > DQ_FULL_LIST_MAX) {
    const wait = DQ_RENDER_MS - (Date.now() - _dqLastRender);
    if (wait > 0) {
      if (!_dqRenderTimer) _dqRenderTimer = setTimeout(() => { _dqRenderTimer = null; _dqRender(true); }, wait);
      return;
    }
  }
  clearTimeout(_dqRenderTimer);
  _dqRenderTimer = null;
  _dqLastRender = Date.now();

  let el = document.getElementById('deleteQueue');
  if (!total) { el?.classList.remove('visible'); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'deleteQueue';
    el.className = 'delete-queue';
    queuePanelStack().appendChild(el);
  }

  const succeeded = _dq.counts.done;
  const skippedN = _dq.counts.skipped;
  const failed = _dq.counts.failed;
  const settled = succeeded + skippedN + failed;
  const allDone = settled === total;
  // Verb reflects the actual op/mode: restore, trash, or delete-flavored.
  let verbing, verbed;
  if (_dq.ops.restore) { verbing = 'Restoring'; verbed = 'Restored'; }
  else if (_dq.ops.hard) { verbing = 'Deleting (permanent)'; verbed = 'Deleted'; }
  else if (_dq.ops.recycle) { verbing = 'Recycling'; verbed = 'Recycled'; }
  else { verbing = 'Moving to trash'; verbed = 'Moved to trash'; }

  const ICON = { queued: '<span class="dq-dot">•</span>', active: '<span class="dq-spin"></span>', done: '✓', skipped: '–', failed: '✗' };
  // The list scrolls (CSS caps it at ~5 rows) and the active row is scrolled
  // into view, so the file actually being deleted is always visible.
  let from = 0;
  let to = _dq.items.length;
  if (total > DQ_FULL_LIST_MAX) {
    const at = Math.min(_dq.next, _dq.items.length - 1);
    from = Math.max(0, at - DQ_WINDOW_BEFORE);
    to = Math.min(_dq.items.length, at + DQ_WINDOW_AFTER);
  }
  let rowHtml = '';
  for (let i = from; i < to; i++) {
    const it = _dq.items[i];
    if (it.state === 'canceled') continue;
    const m = getMediaById(it.id);
    const name = m ? m.filename : `#${it.id}`;
    // Only QUEUED items are cleanly cancelable — an active one is already
    // mid-flight on the server; done/failed are settled.
    const cancel = it.state === 'queued'
      ? `<button class="dq-cancel" data-seq="${it.seq}" title="Cancel this delete" aria-label="Cancel">✕</button>`
      : '';
    rowHtml += `<div class="dq-row dq-${it.state}" data-id="${it.id}" title="${escapeHtml(it.error || name)}">
      <span class="dq-ico">${ICON[it.state]}</span>
      <span class="dq-name">${escapeHtml(name)}</span>
      ${cancel}
    </div>`;
  }

  // "Deleted 416 of 433 · 17 failed": the first number is what happened,
  // never what was merely attempted.
  const tail = `${skippedN ? ` · ${skippedN} skipped` : ''}${failed ? ` · ${failed} failed` : ''}`;
  const headText = allDone
    ? `${verbed} ${succeeded} of ${total}${tail}`
    : _dq.paused
      ? `Paused at ${settled} of ${total}: the server is not answering`
      : `${verbing} ${Math.min(settled + 1, total)}/${total}${_dqEtaText()}`;

  el.innerHTML = `
    <div class="dq-head">
      ${allDone || _dq.paused ? '' : '<span class="dq-spin"></span>'}
      <span class="dq-title">${escapeHtml(headText)}</span>
      ${allDone ? '<button class="dq-x" title="Dismiss">✕</button>' : ''}
    </div>
    ${_dq.paused ? `<div class="dq-paused">
      <span>Nothing more happens until you choose.</span>
      <button class="dq-act" data-dq="resume">Resume</button>
      <button class="dq-act" data-dq="cancel">Cancel the rest</button>
    </div>` : ''}
    <div class="dq-list">${rowHtml}</div>`;
  el.classList.add('visible');
  el.querySelector('.dq-x')?.addEventListener('click', () => {
    _dqReset();
    el.classList.remove('visible');
  });
  el.querySelector('[data-dq="resume"]')?.addEventListener('click', _dqResume);
  el.querySelector('[data-dq="cancel"]')?.addEventListener('click', _dqCancelAll);
  el.querySelectorAll('.dq-cancel').forEach(b =>
    b.addEventListener('click', () => _dqCancel(Number(b.dataset.seq))));
  // Keep the in-flight file visible in the scroll region
  const active = _dq.items[_dq.next];
  if (active && active.state === 'active') el.querySelector(`.dq-row[data-id="${active.id}"]`)?.scrollIntoView({ block: 'nearest' });
}

/** Cancel a still-queued item: drop it, un-grey its card, and settle its batch
 *  if it was the last member. Active/done/failed items are left alone. */
function _dqCancel(seq) {
  // Items are in seq order: a binary search finds it in a queue of millions.
  let lo = 0, hi = _dq.items.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = _dq.items[mid].seq;
    if (s === seq) { idx = mid; break; }
    if (s < seq) lo = mid + 1; else hi = mid - 1;
  }
  if (idx < 0) return;
  const item = _dq.items[idx];
  if (item.state !== 'queued') return;   // can't cancel one already running/settled

  _dqSettle(item, 'canceled');
  _dqBusyIds.delete(item.id);
  _setTileBusy(item.id, false);          // restore the card immediately

  // A canceled item contributes nothing to okIds/failures; if it was the batch's
  // last outstanding member, resolve the awaiting caller with what's done so far.
  if (--item.batch.remaining === 0) {
    item.batch.resolve({ okIds: item.batch.okIds, skippedIds: item.batch.skippedIds, failures: item.batch.failures });
  }

  // Nothing left running/queued → wrap up (reconcile + fade); else just repaint.
  if (!_dq.counts.queued && !_dq.counts.active) _dqFinish();
  else _dqRender(true);
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
/**
 * Exactly the ids an op applies to, resolved BEFORE its confirm, at every
 * selection size: the confirm counts this list and the queue gets this list,
 * nothing else. Trash and every delete mode take files outside the trash;
 * Restore takes files in it (as the old row filter did at every size).
 *
 * A small list is filtered on its rows. A big one (Select all) asks the
 * server for every id in the wanted state and in the other one (two id
 * lists, no rows) and keeps the selected ones; anything in neither list
 * (types the grid does not show) is decided from its rows.
 * @returns {Promise<{ids: number[]}>} rejects with RowsUnavailable
 */
async function idsForOp(ids, wantTrashed) {
  if (ids.length <= SMALL_SELECTION) {
    // strict: rows that could not be loaded stop the action (RowsUnavailable).
    const rows = await Library.fetchRows(ids, { strict: true });
    noteGoneRows(rows);
    return { ids: rows.filter(m => m && !!m.user_trashed === wantTrashed).map(m => m.id) };
  }
  const listOf = async (trashed) => {
    const out = await Library.queryOnce({ filters: { trashed } }, { pageSize: 1, allIds: true });
    if (!out.complete && out.total == null) throw new Error('Could not count the selection. Nothing was changed. Try again.');
    return out.ids;
  };
  const [want, other] = await Promise.all([listOf(wantTrashed ? '1' : '0'), listOf(wantTrashed ? '0' : '1')]);
  const unknown = new Set(ids);
  const picked = [];
  for (let i = 0; i < want.length; i++) {
    if (unknown.delete(want[i])) picked.push(want[i]);
  }
  for (let i = 0; i < other.length; i++) unknown.delete(other[i]);
  if (unknown.size) {
    const rest = [...unknown];
    let gone = 0;
    for (let i = 0; i < rest.length; i += SMALL_SELECTION) {
      const rows = await Library.fetchRows(rest.slice(i, i + SMALL_SELECTION), { strict: true });
      gone += rows.gone || 0;
      for (const m of rows) if (m && !!m.user_trashed === wantTrashed) picked.push(m.id);
    }
    if (gone) noteGoneRows({ gone });
  }
  return { ids: picked };
}

async function trashIds(ids, { confirmBulk = false } = {}) {
  let picked;
  try { picked = await idsForOp(ids, false); } catch (err) {
    bulkLoadFailed(err);
    return { okIds: [], failures: [String(err.message || err)] };
  }
  const toTrash = picked.ids;
  const n = toTrash.length;
  if (n === 0) return { okIds: [], failures: [] };

  const mode = getDeleteMode();
  if (mode !== 'soft') return _destructiveDelete(toTrash, mode);

  if (confirmBulk && n > 1) {
    const ok = confirm(`Move ${n} file(s) to the trash folder?\n\nFiles are moved on disk (not deleted) and can be restored.`);
    if (!ok) return { okIds: [], failures: [] };
  }

  try {
    // Queue drives the UI (progress panel + card greying + reconcile-on-drain)
    const { okIds, skippedIds, failures } = await _dqEnqueue(toTrash, 'trash');

    if (failures.length) {
      showToast(`⚠ ${failures.length} failed: ${failures[0]}${failures.length > 1 ? ' (+' + (failures.length - 1) + ' more)' : ''}`);
      console.warn('[Trash] failures:', failures);
    }

    if (okIds.length) {
      showUndoToast(
        `🗑 ${okIds.length} file(s) moved to trash${skippedIds.length ? ` · ${skippedIds.length} already in the trash` : ''}`,
        () => restoreIds(okIds)
      );
    }
    if (!okIds.length && skippedIds.length) showToast(`${skippedIds.length} file(s) were already in the trash`);
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
    const { okIds, skippedIds, failures } = await _dqEnqueue(ids, 'delete', { mode });
    if (failures.length) {
      showToast(`⚠ ${failures.length} failed: ${failures[0]}${failures.length > 1 ? ' (+' + (failures.length - 1) + ' more)' : ''}`);
      console.warn('[Delete] failures:', failures);
    }
    if (okIds.length) {
      showToast((mode === 'hard'
        ? `🗑 Permanently deleted ${okIds.length} file(s)`
        : `♻ Sent ${okIds.length} file(s) to the Recycle Bin`) +
        (skippedIds.length ? `. Kept ${skippedIds.length} that went to the trash in the meantime` : ''));
    } else if (skippedIds.length) {
      showToast(`Nothing deleted. ${skippedIds.length} file(s) went to the trash in the meantime and were kept there`);
    }
    return { okIds, failures };
  } catch (err) {
    console.error('[Delete] failed:', err);
    showToast('⚠ Delete failed: ' + err.message);
    return { okIds: [], failures: [String(err.message || err)] };
  }
}

async function restoreIds(ids) {
  let picked;
  try { picked = await idsForOp(ids, true); } catch (err) {
    bulkLoadFailed(err);
    return { okIds: [], failures: [String(err.message || err)] };
  }
  const toRestore = picked.ids;
  if (toRestore.length === 0) return { okIds: [], failures: [] };

  try {
    const { okIds, skippedIds, failures } = await _dqEnqueue(toRestore, 'restore');

    if (failures.length) {
      showToast(`⚠ ${failures.length} failed: ${failures[0]}${failures.length > 1 ? ' (+' + (failures.length - 1) + ' more)' : ''}`);
      console.warn('[Restore] failures:', failures);
    }
    if (okIds.length || skippedIds.length) {
      showToast(`♻ ${okIds.length} file(s) restored${skippedIds.length ? ` · ${skippedIds.length} were already out of the trash` : ''}`);
    }
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

/** What Empty trash will delete: every trashed row, documents too (6.10). */
async function fetchTrashSummary() {
  const resp = await fetch('/api/library/trash-summary');
  if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
  return resp.json();
}

async function clearTrash() {
  // Every file in the trash, whatever the filters say, counted exactly as the
  // server will delete them.
  let trash;
  try { trash = await fetchTrashSummary(); } catch (err) { showToast('⚠ ' + err.message); return; }
  const n = trash.count;
  if (!n) { showToast('Trash is already empty'); return; }

  const bytes = trash.bytes || 0;
  const size = typeof formatFileSize === 'function' ? formatFileSize(bytes) : `${Math.round(bytes / 1e6)} MB`;
  if (!confirm(`⚠ PERMANENTLY delete ${n} file(s) in the trash (${size})?\n\n` +
    `This erases the files from disk AND every record, note, rating, subtitle and view-history trace. It CANNOT be undone.`)) return;
  if (!confirm(`Last chance. Really delete ${n} file(s) forever?`)) return;

  const btn = document.getElementById('clearTrashBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Emptying…'; }
  try {
    const resp = await fetch('/api/trash/empty', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await resp.json();
    if (!resp.ok) { showToast('⚠ ' + (data.error || 'empty trash failed')); return; }
    // Drop the purged rows from the client cache and re-render
    const ids = [];
    Library.eachCachedRow(m => { if (m.user_trashed) ids.push(m.id); });
    Library.forget(ids);
    ids.forEach(id => selectedIds.delete(id));
    Library.invalidateRows();
    selectionChanged();
    if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
    Library.refreshFacets();
    showToast(`🗑 Permanently deleted ${data.deleted} file(s)${data.filesDeleted < data.deleted ? ` (${data.deleted - data.filesDeleted} already gone from disk)` : ''}`);
  } catch (err) {
    showToast('⚠ ' + err.message);
  } finally {
    if (btn) btn.disabled = false;
    updateClearTrashUi();
  }
}

/** Show/label the Empty-trash button from the current trashed count. It sits
    in the results row and belongs to the Trashed filter, so it only appears
    while that filter is set to Only: emptying the trash is a decision you make
    while looking at the trash. */
function updateClearTrashUi() {
  const btn = document.getElementById('clearTrashBtn');
  if (!btn) return;
  const trashOnly = typeof getTriFilterValue === 'function' && getTriFilterValue('filterTrashed') === '1';
  if (!trashOnly) { btn.style.display = 'none'; return; }
  // The button says what it will delete, documents included, like the
  // confirm (the facets' count covers the grid's types only).
  const seq = ++_trashUiSeq;
  fetchTrashSummary().then((t) => {
    if (seq !== _trashUiSeq) return;
    btn.style.display = t.count ? '' : 'none';
    btn.textContent = `🗑 Empty trash (${t.count})`;
  }, () => {});
}
let _trashUiSeq = 0;
window.addEventListener('vault:facets-changed', () => updateClearTrashUi());

function trashSelected() {
  trashIds([...selectedIds], { confirmBulk: true }).then(() => clearSelection());
}
// (Both clear the selection when their queue batch settles, as before.)

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

  // Pick the neighbour to land on BEFORE the trash reshuffles the results:
  // prefer the next file, fall back to the previous one.
  const idx = Library.indexOf(id);
  let target = null;
  if (idx !== -1) {
    const [next] = await Library.rowsForRange(idx + 1, idx + 2);
    const [prev] = idx > 0 ? await Library.rowsForRange(idx - 1, idx) : [null];
    const cand = next || prev || null;
    if (cand && cand.id !== id) {
      target = { id: cand.id, filepath: cand.filepath, filename: cand.filename, media_type: cand.media_type };
    }
  }

  await trashIds([id]);
  if (_dqSettled) await _dqSettled;

  // Navigate if the neighbour survived the reconcile; otherwise nothing's left.
  if (target && Library.indexOf(target.id) !== -1) {
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
  // A row at a time, as before, fetched a chunk at a time (a big selection
  // never sits in the cache all at once). Only a write the server confirmed
  // counts, and only then does the cached row change (postFlags patches it
  // from the answer). The first failure stops the run, and one message says
  // how far it got: the server is not answering, and asking it thousands
  // more times would only bury that under a toast per file.
  const ids = [...selectedIds];
  const verb = value ? 'Flagged' : 'Unflagged';
  let settled = 0;     // selected files now at the asked value (saved here or already so)
  let saved = 0;
  let gone = 0;
  let stopped = null;
  let stopAt = ids.length;   // first selected id not yet looked at
  outer:
  for (let i = 0; i < ids.length; i += SMALL_SELECTION) {
    let rows;
    try {
      rows = await Library.fetchRows(ids.slice(i, i + SMALL_SELECTION), { strict: true });
    } catch (err) {
      stopped = err.message;
      stopAt = i;
      break;
    }
    gone += rows.gone || 0;
    for (let j = 0; j < rows.length; j++) {
      const item = rows[j];
      if (!item) continue;
      if ((item.user_flagged_delete ? 1 : 0) === value) { settled++; continue; }
      if (!(await postFlags(item, { user_flagged_delete: value }, { quiet: true }))) {
        stopped = 'the server did not save it';
        stopAt = i + j + 1;
        break outer;
      }
      saved++;
      settled++;
    }
  }
  if (stopped) {
    // Files after the stop that already carry the value are done, not
    // "could not be saved". Counted from whatever rows can still be read;
    // the ones that cannot be read are the ones that stay uncounted.
    for (let i = stopAt; i < ids.length; i += SMALL_SELECTION) {
      let rows;
      try { rows = await Library.fetchRows(ids.slice(i, i + SMALL_SELECTION)); } catch { break; }
      gone += rows.gone || 0;
      for (const item of rows) if (item && (item.user_flagged_delete ? 1 : 0) === value) settled++;
      if (rows.failed) break;
    }
  }
  selectionChanged();
  renderResults();
  renderSelectionBar();
  const total = ids.length - gone;
  const goneNote = gone ? ` ${gone.toLocaleString()} selected file(s) are no longer in the library.` : '';
  if (stopped) {
    showToast(`⚠ ${verb} ${settled.toLocaleString()} of ${total.toLocaleString()}. ` +
      `${(total - settled).toLocaleString()} could not be saved.${goneNote}`);
  } else if (saved) {
    showToast(`${value ? '🚩 Flagged' : 'Unflagged'} ${saved} file(s)` +
      (gone ? `. ${gone} selected file(s) are no longer in the library` : ''));
  }
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
      showToast('⚠ File failed to play, marked as unplayable');
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
  showToast('✓ Plays fine now, unplayable flag cleared');
  // Repaint so the ⚠ badge and the red tile border go without a manual refresh.
  if (typeof refreshInfoSurfaces === 'function') refreshInfoSurfaces(media);
  else if (typeof renderResults === 'function') renderResults();
}
document.addEventListener('canplay', _clearPlaybackFailed, true);
document.addEventListener('load', _clearPlaybackFailed, true);
