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

/**
 * Is the grid showing library files that can be ticked and acted on? The
 * Library tab, and a collection opened in the Collections tab (its files are
 * the same tiles there; only the collection cards themselves are not files).
 */
function selectionGridShowing() {
  if (typeof currentTab === 'undefined' || currentTab === 'library') return true;
  return currentTab === 'collections' && typeof activeCollectionId !== 'undefined' && activeCollectionId != null;
}
function selectionChanged() {
  _selGen++;
  // A tick closes the hover popover (cards.js): it would cover the next tile's
  // tick box, and it stays shut while anything is selected.
  if (typeof hideTilePopover === 'function') hideTilePopover();
}

// A selection this size or smaller is counted from its rows; a bigger one
// asks the server (POST /api/library/ids-summary) instead of fetching rows.
const SMALL_SELECTION = 2000;
// Ids per request for the bulk endpoints (the server takes 2 MB of JSON).
const BULK_ID_CHUNK = 50000;

/** "1 file", "2,345 files". */
function selFiles(n) {
  const v = Number(n) || 0;
  return `${v.toLocaleString()} ${v === 1 ? 'file' : 'files'}`;
}

/**
 * A selection-bar button's label: the count only when the button acts on part
 * of the selection ("Trash (2)" with 3 selected, 1 already in the trash). The
 * bar already says how many are selected, so a count that repeats it is noise.
 */
function selBtnLabel(label, n) {
  return n === selectedIds.size ? label : `${label} (${Number(n).toLocaleString()})`;
}

/**
 * An HTTP failure as an Error for showErrorToast / friendlyError: the server's
 * own words when it sent a sentence, otherwise a plain "something went wrong"
 * (an HttpError name keeps "Server returned 500" out of a toast).
 */
function selHttpError(status, serverText) {
  const err = new Error(serverText || `Server returned ${status}`);
  err.status = status;
  if (!serverText) err.name = 'HttpError';
  return err;
}

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
    syncTileCheckboxes();
  }
  selectionChanged();

  lastSelectedId = id;
  renderSelectionBar();
}

/**
 * Bring every rendered tile in line with selectedIds: its checkbox AND its
 * tile-selected class. (cards.js only sets the class when a tile is drawn,
 * so a tile drawn ticked kept its blue border after an untick until the
 * next full repaint.)
 */
function syncTileCheckboxes() {
  document.querySelectorAll('.media-tile').forEach(tile => {
    const on = selectedIds.has(Number(tile.dataset.id));
    const cb = tile.querySelector('.tile-select');
    if (cb) cb.checked = on;
    tile.classList.toggle('tile-selected', on);
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
  const onLibrary = selectionGridShowing();
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
      title="Select the ${selFiles(pageIds.length)} shown on this page">${pageAll ? 'Deselect page' : `Select page (${pageIds.length})`}</button>` : ''}
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
 * Close the menus the selection bar opened (More, Add to collection, Studio):
 * they act on the selection, so they go when it does or when the bar hides.
 */
function closeSelectionPopovers() {
  if (typeof closeSelMenu === 'function') closeSelMenu(false);
  if (typeof closeBarCollectionPicker === 'function') closeBarCollectionPicker();
  // The Studio menu is studios.js's; close it only when it was opened from the
  // bar (from its own button, or from More, which then stays lit the same way).
  if (document.querySelector('#selectionBar .sel-studio.on, #selectionBar .sel-more.on') && typeof stClosePops === 'function') stClosePops();
  // The Stream tag menu acts on the selection too (player-lib/stream-tags.js).
  if (typeof StreamTags !== 'undefined') StreamTags.closeMenu();
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
  if (rows && rows.gone) {
    showToast(rows.gone === 1
      ? '1 selected file is no longer in the library and was left out.'
      : `${rows.gone.toLocaleString()} selected files are no longer in the library and were left out.`);
  }
}

/** The message for a bulk action that could not load its rows. */
function bulkLoadFailed(err) {
  // Library.RowsUnavailable carries how many rows did not arrive.
  if (err && err.count) showToast(`Could not load ${selFiles(err.count)} from Vault. Nothing was changed. Try again.`, { type: 'error' });
  else showErrorToast(err, 'loading the selected files');
}

/* What the selection bar counts. A small selection is counted from its rows
   (fetched where the cache lacks them); a big one is counted by the server
   from the ids alone, so selecting a whole 2M-file library never pulls its
   rows into the tab. */

let _selCounts = { key: '', data: null, busy: false };

function countRows(rows) {
  const c = { trashed: 0, flagged: 0, failed: 0, errored: 0, unscanned: 0, av: 0, video: 0, faceable: 0 };
  for (const m of rows) {
    if (m.user_trashed) c.trashed++;
    if (m.user_flagged_delete) c.flagged++;
    if (m.playback_failed) c.failed++;
    if (m.processing_error === 'unscanned') c.unscanned++;
    else if (m.processing_error) c.errored++;
    if (m.media_type === 'video' || m.media_type === 'audio') c.av++;
    if (m.media_type === 'video') c.video++;
    // Photos, GIFs and videos: what face search can check
    if (m.media_type === 'image' || m.media_type === 'gif' || m.media_type === 'video') c.faceable++;
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
          count: s.count, trashed: s.trashed, flagged: s.flagged, failed: s.failed || 0,
          errored: s.scan.failed, unscanned: s.scan.unscanned,
          av: (s.types.video || 0) + (s.types.audio || 0), video: s.types.video || 0,
          faceable: (s.types.image || 0) + (s.types.gif || 0) + (s.types.video || 0),
        },
      };
      renderSelectionBar();
    }, () => { _selCounts.busy = false; });
  }
  return _selCounts.data || { count: selectedIds.size, trashed: 0, flagged: 0, failed: 0, errored: 0, unscanned: 0, av: 0, video: 0, faceable: 0 };
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

/* ── What the selection can do: one list ──────────────────────────────────
   Every action the selection bar offers, in bar order. The bar shows the
   PINNED ones that apply to this selection, then More, which lists every one
   that applies, under the headings of SEL_GROUPS. The pin beside each row in
   More puts an action on the bar or takes it off (settings.js selBarPinned).

   An action:
     id       stable: the pinned list stores it
     group    its heading in More (SEL_GROUPS)
     bar      the short words on the bar ("Collect")
     menu     the full words in More ("Add to a collection"); bar when absent
     emoji    Classic's emoji; Modern shows the matching line icon (icons.js)
     icon     a line icon to use instead of the emoji's own (Play next, Up next)
     title    the tooltip: what happens, and to how many
     n        how many of the selected files it acts on: "(n)" when fewer
     visible  when it is offered
     run      what it does; an action with popover opens a menu or picker
              anchored to the element it is given (its bar button, or More)
     danger   set apart at the bottom of More
     kbd      the key that does the same (player-lib/up-next.js)
     cls      the bar button's own classes (CSS, and other scripts find
              Collect and Studio by them)
   The text fields may be functions of the selection's context (selBarContext). */

const SEL_GROUPS = [
  { id: 'play', label: 'Play' },
  { id: 'collection', label: 'Collection' },
  { id: 'label', label: 'Label' },
  { id: 'create', label: 'Create' },
  { id: 'library', label: 'Library' },
  { id: 'danger', label: 'Remove' },      // at the bottom, apart; no heading shown
];

/* On the bar until the pins say otherwise. Restore takes Trash's place for
   files in the trash (each shows only when it applies, as before). */
const SEL_DEFAULT_PINNED = ['playnext', 'collect', 'uncollect', 'skip', 'share', 'restore', 'trash'];

const SEL_ACTIONS = [
  { id: 'playnext', group: 'play', bar: 'Play next', emoji: '⤴', icon: 'play-next', cls: 'sel-upnext', kbd: 'Shift+U',
    title: 'Play the selected files after the one playing now (Shift+U)',
    visible: () => typeof UpNext !== 'undefined',
    run: () => upNextAddSelection('next') },
  { id: 'upnext', group: 'play', bar: 'Up next', menu: 'Add to Up next', emoji: '＋', icon: 'queue', cls: 'sel-upnext', kbd: 'U',
    title: 'Add the selected files to the end of Up next (U)',
    visible: () => typeof UpNext !== 'undefined',
    run: () => upNextAddSelection('end') },

  { id: 'collect', group: 'collection', bar: 'Collect', menu: 'Add to a collection', emoji: '📁', cls: 'sel-collect', popover: true,
    title: 'Add the selected files to a collection',
    visible: () => true,
    run: (c, el) => addSelectionToCollection(el) },
  // A collection is open: its ticked files can be taken out of it (collections.js).
  { id: 'uncollect', group: 'collection', bar: 'Uncollect', menu: 'Remove from this collection', emoji: '➖', cls: 'sel-uncollect',
    n: (c) => c.inColl.length,
    title: (c) => `Take ${selFiles(c.inColl.length)} out of this collection. The files themselves are not touched`,
    visible: (c) => c.inColl.length > 0,
    run: () => removeSelectedFromCollection() },
  // Skip / Unskip them (collection-skips.js): they keep their places, playback passes over them.
  { id: 'skip', group: 'collection', emoji: '⏭',
    bar: (c) => (c.allSkipped ? 'Unskip' : 'Skip'),
    menu: (c) => (c.allSkipped ? 'Unskip in this collection' : 'Skip in this collection'),
    cls: (c) => `sel-skip${c.allSkipped ? ' sel-skipped' : ''}`,
    n: (c) => c.inColl.length,
    title: (c) => {
      const n = c.inColl.length;
      return c.allSkipped ? `Play ${selFiles(n)} again` : `Keep ${selFiles(n)} in place but do not play ${n === 1 ? 'it' : 'them'}`;
    },
    visible: (c) => !!c.skipColl && c.inColl.length > 0,
    run: (c) => skipSelected(!c.allSkipped) },

  { id: 'studio', group: 'label', bar: 'Studio', emoji: '🏢', cls: 'sel-studio', popover: true, caret: true,
    title: 'Put the selected files in a studio',
    visible: () => typeof studiosSelectionPick === 'function',
    run: (c, el) => studiosSelectionPick(el) },
  { id: 'streamtag', group: 'label', bar: 'Stream tag', emoji: '🏷', cls: 'sel-stags', popover: true, haspopup: true,
    title: 'Stream tags for the selected files',
    visible: () => typeof StreamTags !== 'undefined' && StreamTags.loaded(),
    run: (c, el) => StreamTags.selectionMenu(el) },
  // Flag is one toggle rather than two buttons. A mixed selection reads as "not
  // yet flagged", so the first click flags the stragglers and the second (once
  // every item carries the flag) clears them all. bulkFlag() already skips
  // items that are already at the target value, so both directions are cheap.
  { id: 'flag', group: 'label',
    bar: (c) => (c.allFlagged ? 'Unflag' : 'Flag'),
    emoji: (c) => (c.allFlagged ? '🏳' : '🚩'),
    cls: (c) => (c.allFlagged ? 'sel-flagged' : ''),
    title: (c) => (c.allFlagged
      ? 'Clear the delete flag on all selected'
      : `Flag for deletion${c.flagged ? ` (${c.flagged} of ${c.count} already flagged)` : ''}`),
    visible: () => true,
    run: (c) => bulkFlag(c.allFlagged ? 0 : 1) },

  // Stack / Grid open videos in the Editor (no hard cap: many concurrent
  // decodes are drive-bound, the Editor warns above 4); Music ID fingerprints
  // any audio or video.
  { id: 'stack', group: 'create', bar: 'Stack', menu: 'Stack in the Editor', emoji: '▤', cls: 'sel-mix',
    n: (c) => c.video,
    title: (c) => `Open ${c.video} videos in the Editor, layered in sync${selManyVideos(c)}`,
    visible: (c) => c.musicReady && c.video >= 2,
    run: () => openEditorWithSelection('stack') },
  { id: 'grid', group: 'create', bar: 'Grid', menu: 'Grid in the Editor', emoji: '▦', cls: 'sel-mix',
    n: (c) => c.video,
    title: (c) => `Open ${c.video} videos in the Editor, side by side in sync${selManyVideos(c)}`,
    visible: (c) => c.musicReady && c.video >= 2,
    run: () => openEditorWithSelection('grid') },
  { id: 'musicid', group: 'create', bar: 'Music ID', emoji: '🎵', cls: 'sel-music',
    n: (c) => c.av,
    title: (c) => `Find the songs in ${selFiles(c.av)}. Each file is checked once, then matched across the library`,
    visible: (c) => c.musicReady && c.av > 0,
    run: () => fingerprintSelected() },
  // Only while the feature is on (player-lib/share-ui.js).
  { id: 'share', group: 'create', bar: 'Share', menu: 'Share privately', emoji: '📤', cls: 'sel-share',
    title: 'Pack the selected files into a locked archive and upload it to gofile.io, after two checks',
    visible: () => typeof shareEnabled === 'function' && shareEnabled(),
    run: () => shareOpenForSelection() },

  // Files whose AI scan never landed: a real error, or a stub that was never
  // scanned (a cancelled queue leaves these).
  { id: 'retry', group: 'library', bar: 'Retry errors', emoji: '↻', cls: 'sel-retry',
    n: (c) => c.retryable,
    title: (c) => `Queue ${selFiles(c.retryable)} for another AI scan${c.errored ? `: ${c.errored.toLocaleString()} with an error` : ''}${c.unscanned ? `${c.errored ? ',' : ':'} ${c.unscanned.toLocaleString()} never scanned` : ''}`,
    visible: (c) => c.retryable > 0,
    run: () => retryErrorsSelected() },
  // Force refresh: read the errored files again and remake their thumbnails,
  // without redoing the AI scan (the fix for files scanned mid-copy).
  { id: 'refresh', group: 'library', bar: 'Force refresh', emoji: '🔄', cls: 'sel-refresh',
    n: (c) => c.errored,
    title: (c) => `Read ${selFiles(c.errored)} with an error again and remake their thumbnails, without redoing the AI scan`,
    visible: (c) => c.errored > 0 && typeof window.vaultForceRefresh === 'function',
    run: (c, el) => forceRefreshSelected(el) },
  // Files marked as failed to play: clear the mark so playback tries them
  // again (a drive that was asleep, a server restart mid-file).
  { id: 'playable', group: 'library', bar: 'Mark as playable', emoji: '▶', cls: 'sel-playable',
    n: (c) => c.failed,
    title: (c) => `${selFiles(c.failed)} marked as unplayable. Clear the mark so playback tries ${c.failed === 1 ? 'it' : 'them'} again`,
    visible: (c) => c.failed > 0,
    run: () => markPlayableSelected() },
  // Face search on photos, GIFs and videos, while it is on (player-lib/faces.js).
  { id: 'faces', group: 'library', bar: 'Faces', menu: 'Find faces', emoji: '👤', cls: 'sel-faces',
    n: (c) => c.faceable,
    title: 'Find faces in the selected files',
    visible: (c) => c.faceable > 0 && typeof facesReady === 'function' && facesReady(),
    run: () => facesIndexSelection() },
  { id: 'restore', group: 'library', bar: 'Restore', emoji: '♻', cls: 'sel-restore',
    n: (c) => c.trashed,
    title: (c) => `Take ${selFiles(c.trashed)} out of the trash`,
    visible: (c) => c.trashed > 0,
    run: () => restoreSelected() },

  { id: 'trash', group: 'danger', bar: 'Trash', emoji: '🗑', cls: 'sel-trash', danger: true,
    n: (c) => c.active,
    title: (c) => `Move ${selFiles(c.active)} to the trash`,
    visible: (c) => c.active > 0,
    run: () => trashSelected() },
  // Irreversible, and Select all can point it at the whole library: the
  // confirm dialog names the count before anything happens.
  { id: 'remove', group: 'danger', bar: 'Remove from library', emoji: '✂', cls: 'sel-remove', danger: true,
    title: 'Take the selected files out of the library. The files on disk are not touched',
    visible: () => true,
    run: () => removeSelectedRecords() },
];
const SEL_ACTION_BY_ID = new Map(SEL_ACTIONS.map(a => [a.id, a]));

function selManyVideos(c) {
  return c.video > 4 ? ' (playback smoothness depends on drive speed)' : '';
}

/** What the actions ask of the selection, counted once per render. */
function selBarContext() {
  const counts = selectionCounts();
  const inColl = typeof selectedInOpenCollection === 'function' ? selectedInOpenCollection() : [];
  const skipColl = inColl.length && typeof skipOpenCollection === 'function' ? skipOpenCollection() : null;
  const errored = counts.errored || 0;
  const unscanned = counts.unscanned || 0;
  return {
    size: selectedIds.size,
    count: counts.count,
    trashed: counts.trashed,
    active: counts.count - counts.trashed,
    av: counts.av,
    video: counts.video,
    flagged: counts.flagged,
    allFlagged: counts.count > 0 && counts.flagged === counts.count,
    errored, unscanned, retryable: errored + unscanned,
    failed: counts.failed || 0,
    faceable: counts.faceable || 0,
    inColl,
    skipColl,
    allSkipped: !!skipColl && inColl.every(id => Skips.has(skipColl.id, id)),
    musicReady: typeof fingerprintSelected === 'function',
  };
}

const selVal = (x, c) => (typeof x === 'function' ? x(c) : x);
const selAttr = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An action's words, with "(n)" when it acts on fewer files than are selected. */
function selActionWords(a, c, where = 'bar') {
  const words = selVal(where === 'menu' ? (a.menu || a.bar) : a.bar, c);
  return a.n ? selBtnLabel(words, a.n(c)) : words;
}

/** The emoji (Classic) or line icon (Modern), then the words. */
function selActionLabelHtml(a, c, words) {
  const emoji = selVal(a.emoji, c);
  const text = selAttr(words);
  if (a.icon) return `${vaultIconSwap(`${emoji} `, a.icon)}${text}`;
  return vaultEmojiLabel(`${emoji} ${text}`);
}

/** The actions this selection offers, in bar order. */
function selVisibleActions(c) {
  return SEL_ACTIONS.filter(a => a.visible(c));
}

/* ── Pins: which actions sit on the bar ───────────────────────────────── */

// Without settings.js (a test page), the pins live here for the session.
let _selPinnedLocal = null;

/** The stored list (ids, unknown ones kept for a later version), or null for the default set. */
function selPinnedStored() {
  const v = typeof window !== 'undefined' && typeof window.vaultSelBarPinned === 'function' ? window.vaultSelBarPinned() : _selPinnedLocal;
  return Array.isArray(v) ? v.filter(id => typeof id === 'string') : null;
}

/** The pinned ids. Unknown ones match no action, so they do nothing. */
function selPinnedSet() {
  return new Set(selPinnedStored() || SEL_DEFAULT_PINNED);
}

function selStorePinned(list) {
  if (typeof window !== 'undefined' && typeof window.vaultSetSelBarPinned === 'function') window.vaultSetSelBarPinned(list);
  else _selPinnedLocal = Array.isArray(list) ? list.slice() : null;
}

/** Put an action on the bar or take it off. */
function selSetPinned(id, on) {
  if (!SEL_ACTION_BY_ID.has(id)) return;
  const list = (selPinnedStored() || SEL_DEFAULT_PINNED).filter(x => x !== id);
  if (on) list.push(id);
  selStorePinned(list);
  renderSelectionBar();
}

/** Back to the default buttons. */
function selResetPinned() {
  selStorePinned(null);
  renderSelectionBar();
}

/* ── The bar ──────────────────────────────────────────────────────────── */

// The last render: its context, the actions it offers, the pinned ones among
// them and which of those fit on the bar. More, the clicks and the fit work
// from this, so an action runs with the state its button showed.
const _selBar = { mode: '', c: null, shown: [], pinned: [], onBar: new Set() };

function renderSelectionBar() {
  const bar = ensureSelectionBar();
  // Before the early-return below: the Select page / Select all controls are how
  // a selection gets STARTED, so they have to render when nothing is selected.
  renderResultsSelect();

  // Selection actions belong to the Library grid, and to a collection open in
  // the Collections tab: hidden elsewhere (the selection itself survives tab
  // switches).
  const onLibrary = selectionGridShowing();
  // A person's files in the Faces tab are a library grid too ("Remove selected from X").
  const onPersonFiles = typeof facesPersonFilesShowing === 'function' && facesPersonFilesShowing();
  // Also hide while the full media player is open (main video / fullscreen) so
  // the bar doesn't sit over the media — the selection is preserved and the bar
  // returns when the player closes or drops to the mini player.
  const fullPlayerOpen = document.getElementById('mediaPlayerOverlay')?.classList.contains('active');
  if (selectedIds.size === 0 || !(onLibrary || onPersonFiles) || fullPlayerOpen) {
    hideSelectionBar(bar);
    return;
  }
  wireSelectionBar(bar);
  // A person's page in the Faces tab: only what concerns this person, for
  // the ticked files it shows (faces-tab.js).
  if (!onLibrary && onPersonFiles) {
    const shown = typeof ftTickedShown === 'function' ? ftTickedShown().length : 0;
    if (!shown) { hideSelectionBar(bar); return; }
    closeSelMenu(false);
    _selBar.mode = 'person';
    bar._selHtml = null;
    bar.classList.remove('sel-overflow');
    bar.innerHTML = `
      <span class="sel-count">${shown.toLocaleString()} selected</span>
      ${typeof ftRemoveSelectedButton === 'function' ? ftRemoveSelectedButton(shown) : ''}
      <button class="sel-btn sel-collect" onclick="openCollectionPicker(ftTickedShown(), this)" title="Add the selected files to a collection">${vaultEmojiLabel('📁 Add to collection')}</button>
      ${SEL_CLEAR_BTN}`;
    bar.classList.add('visible');
    return;
  }

  const c = selBarContext();
  const shown = selVisibleActions(c);
  const pins = selPinnedSet();
  _selBar.mode = 'library';
  _selBar.c = c;
  _selBar.shown = shown;
  _selBar.pinned = shown.filter(a => pins.has(a.id));
  bar.classList.add('visible');
  fitSelectionBar(bar);
  if (selMenuOpen()) renderSelMenu();
}

/** One pinned action as a bar button: its short words, the full ones in the tooltip. */
function selBarButtonHtml(a, c) {
  const cls = selVal(a.cls, c);
  const words = selActionWords(a, c, 'bar');
  const full = selActionWords(a, c, 'menu');
  const title = selVal(a.title, c);
  // The Studio button keeps the caret that says a menu opens.
  const caret = a.caret ? `<span class="vi-c"> ▾</span>${typeof vaultIcon === 'function' ? vaultIcon('caret', 'modern-only sel-caret') : ''}` : '';
  return `<button type="button" class="sel-btn${cls ? ` ${cls}` : ''}" data-sel-act="${a.id}" title="${selAttr(full === words ? title : `${full}. ${title}`)}"${a.haspopup ? ' aria-haspopup="menu"' : ''}>${selActionLabelHtml(a, c, words)}${caret}</button>`;
}

function selBarHtml(c, pinned) {
  const open = selMenuOpen();
  const more = `<button type="button" class="sel-btn sel-more${open ? ' open' : ''}" data-sel-more aria-haspopup="menu" aria-expanded="${open ? 'true' : 'false'}" aria-controls="selMoreMenu" title="Everything you can do with the selected files">More<span class="vi-c"> ▴</span>${typeof vaultIcon === 'function' ? vaultIcon('caret', 'modern-only sel-caret sel-caret-up') : ''}</button>`;
  return `<span class="sel-count">${selectedIds.size.toLocaleString()} selected</span>${pinned.map(a => selBarButtonHtml(a, c)).join('')}${more}${SEL_CLEAR_BTN}`;
}

/** Write the bar only when its markup changed: a repaint that says the same keeps focus and an open menu's anchor. */
function writeSelBar(bar, html) {
  if (bar._selHtml === html) return;
  bar._selHtml = html;
  bar.innerHTML = html;
}

/* The bar keeps to one line and never drops its words: when the pinned
   buttons do not fit (a narrow window, the rail, the dock or the pager taking
   room: the max-width rules in tiles.css, dock.css, filter-rail.css and
   stage-remote.css), they go into More from the right, one at a time; the
   count, More and the X always stay. Re-checked on every render, whenever the
   bar's size changes and when the rail or the dock opens or closes. */
function fitSelectionBar(bar) {
  if (!bar.classList.contains('visible') || _selBar.mode !== 'library' || !_selBar.c) return;
  writeSelBar(bar, selBarHtml(_selBar.c, _selBar.pinned));
  const btns = typeof bar.querySelectorAll === 'function' ? [...bar.querySelectorAll('[data-sel-act]')] : [];
  for (const b of btns) b.hidden = false;
  // Hidden from the right until the last piece (the X) is back on the first line.
  for (let i = btns.length - 1; i >= 0 && selBarWraps(bar); i--) btns[i].hidden = true;
  _selBar.onBar = new Set(btns.filter(b => !b.hidden).map(b => b.dataset.selAct));
  bar.classList.toggle('sel-overflow', _selBar.onBar.size < btns.length);
  wireSelectionBarFit(bar);
}

/** Does the bar run onto a second line? */
function selBarWraps(bar) {
  const first = bar.firstElementChild, last = bar.lastElementChild;
  return !!(first && last && last.offsetTop > first.offsetTop + 4);
}

function wireSelectionBarFit(bar) {
  if (bar._fitWired) return;
  bar._fitWired = true;
  const refit = () => {
    if (!bar.classList.contains('visible')) return;
    fitSelectionBar(bar);
    if (selMenuOpen()) placeSelMenu();
  };
  window.addEventListener('resize', refit);
  if (typeof ResizeObserver === 'function') {
    // Skip the size the last fit left behind: fitting resizes the bar itself.
    let seen = '';
    new ResizeObserver(() => {
      if (`${bar.offsetWidth}x${bar.offsetHeight}` === seen) return;
      refit();
      seen = `${bar.offsetWidth}x${bar.offsetHeight}`;
    }).observe(bar);
  }
  // The rail or the dock opening or closing changes the room the bar has
  // (a body class), and a bar that was short of room does not resize itself
  // when the room comes back.
  if (typeof MutationObserver === 'function' && document.body) {
    new MutationObserver(refit).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }
}

/* The bar's close button: the line icon in Modern, the glyph in Classic. */
const SEL_CLEAR_BTN = `<button class="sel-btn sel-clear" onclick="clearSelection()" title="Clear selection" aria-label="Clear selection">${
  typeof vaultIconSwap === 'function' ? vaultIconSwap('✕', 'close') : '✕'}</button>`;

/** Hide the bar, and the menus it opened. */
function hideSelectionBar(bar) {
  if (_selBarWasShown) closeSelectionPopovers();
  _selBarWasShown = false;
  bar.classList.remove('visible');
}
let _selBarWasShown = false;

/**
 * The bar's listeners, once: its buttons run their actions, More opens the
 * menu, and a press on any other bar button closes the collections picker
 * first, so two of the bar's menus never stack.
 */
function wireSelectionBar(bar) {
  _selBarWasShown = true;
  if (bar._selWired || typeof bar.addEventListener !== 'function') return;
  bar._selWired = true;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('button');
    // The ticked files stay for the button pressed (collections.js clears
    // them after an add only when the picker is closed some other way).
    if (btn && !btn.classList.contains('sel-collect') && typeof closeCollectionPicker === 'function') closeCollectionPicker({ keepSelection: true });
  }, true);
  bar.addEventListener('click', (e) => {
    const more = e.target.closest && e.target.closest('[data-sel-more]');
    if (more) { toggleSelMenu(); return; }
    const btn = e.target.closest && e.target.closest('[data-sel-act]');
    if (btn) selRunAction(btn.dataset.selAct, btn);
  });
  bar.addEventListener('keydown', (e) => {
    if (!e.target.closest || !e.target.closest('[data-sel-more]')) return;
    // Up or Down on More opens the menu at its first or last row.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!selMenuOpen()) openSelMenu(e.key === 'ArrowDown' ? 0 : -1);
    }
  });
}

/** Run an action with the state the last render showed. el: its bar button, or More for a menu or picker. */
function selRunAction(id, el) {
  const a = SEL_ACTION_BY_ID.get(id);
  const c = _selBar.c;
  if (!a || !c || !selectedIds.size) return undefined;
  return a.run(c, el || null);
}

/* ── More: every action for this selection ────────────────────────────────
   Modelled on the Stream tag menu the bar already opens (stream-tags.js
   openMenu): a box on <body> above the button, headings, key hints, closed by
   Esc, a click outside or the button again. Each row has a pin that puts the
   action on the bar or takes it off; a pin leaves the menu open. */

let _selMenu = null;

function selMenuOpen() {
  return !!_selMenu;
}

function selMoreButton() {
  return document.querySelector('#selectionBar [data-sel-more]');
}

function selSetMoreExpanded(open) {
  const more = selMoreButton();
  if (!more) return;
  more.setAttribute('aria-expanded', open ? 'true' : 'false');
  more.classList.toggle('open', !!open);
}

function toggleSelMenu() {
  if (selMenuOpen()) closeSelMenu(true);
  else openSelMenu(0);
}

/** focusIndex: the row to focus, -1 for the last. */
function openSelMenu(focusIndex = 0) {
  if (!_selBar.c || _selBar.mode !== 'library') return;
  // One menu at a time: the bar's pickers go, and the hover popover.
  closeSelectionPopovers();
  if (typeof hideTilePopover === 'function') hideTilePopover();
  const el = document.createElement('div');
  el.id = 'selMoreMenu';
  el.className = 'sel-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Everything you can do with the selected files');
  el.addEventListener('click', onSelMenuClick);
  el.addEventListener('keydown', onSelMenuKey);
  _selMenu = el;
  document.body.appendChild(el);
  renderSelMenu();
  selSetMoreExpanded(true);
  setTimeout(() => { if (_selMenu === el) document.addEventListener('pointerdown', selMenuOutside, true); }, 0);
  const rows = selMenuRows();
  const at = rows[focusIndex < 0 ? rows.length - 1 : Math.min(focusIndex, rows.length - 1)];
  if (at) at.focus({ preventScroll: true });
}

/** refocus: put the focus back on More (Esc, the button again). */
function closeSelMenu(refocus) {
  if (!_selMenu) return;
  const el = _selMenu;
  _selMenu = null;
  document.removeEventListener('pointerdown', selMenuOutside, true);
  el.remove();
  selSetMoreExpanded(false);
  if (refocus) {
    const more = selMoreButton();
    if (more) { try { more.focus({ preventScroll: true }); } catch {} }
  }
}

function selMenuOutside(e) {
  if (!_selMenu) return;
  if (_selMenu.contains(e.target)) return;
  // More's own click toggles it.
  if (e.target.closest && e.target.closest('[data-sel-more]')) return;
  closeSelMenu(false);
}

/** One row: the action, then its pin. */
function selMenuRowHtml(a, c, pins) {
  const words = selActionWords(a, c, 'menu');
  const pinned = pins.has(a.id);
  const onBar = _selBar.onBar.has(a.id);
  const note = onBar ? 'On the bar' : pinned ? 'Pinned, no room' : '';
  const name = selVal(a.menu || a.bar, c);
  const pinName = pinned ? `Take ${name} off the bar` : `Put ${name} on the bar`;
  const pinIcon = typeof vaultIconSwap === 'function' ? vaultIconSwap('📌', 'pin') : '📌';
  return `<div class="sel-mrow${a.danger ? ' sel-mrow-danger' : ''}" role="none">
    <button type="button" role="menuitem" class="sel-mi" data-sel-mi="${a.id}" title="${selAttr(selVal(a.title, c))}">
      <span class="sel-mi-label">${selActionLabelHtml(a, c, words)}</span>
      ${note ? `<span class="sel-mi-note${onBar ? ' on' : ''}">${note}</span>` : ''}
      ${a.kbd ? `<kbd class="sel-mi-kbd">${a.kbd}</kbd>` : ''}
    </button>
    <button type="button" role="menuitemcheckbox" class="sel-pin${pinned ? ' on' : ''}" data-sel-pin="${a.id}" aria-checked="${pinned ? 'true' : 'false'}" aria-label="${selAttr(pinName)}" title="${pinned ? 'Take off the bar' : 'Put on the bar'}">${pinIcon}</button>
  </div>`;
}

function selMenuHtml() {
  const c = _selBar.c;
  const pins = selPinnedSet();
  const groups = SEL_GROUPS.map(g => ({ g, acts: _selBar.shown.filter(a => a.group === g.id) })).filter(x => x.acts.length);
  const body = groups.filter(x => x.g.id !== 'danger').map(({ g, acts }) => `
    <div class="sel-menu-group" role="group" aria-label="${g.label}">
      <div class="sel-menu-head" aria-hidden="true">${g.label}</div>
      ${acts.map(a => selMenuRowHtml(a, c, pins)).join('')}
    </div>`).join('');
  const danger = groups.find(x => x.g.id === 'danger');
  return `<div class="sel-menu-groups">${body}</div>
    <div class="sel-menu-foot">
      ${danger ? `<div class="sel-menu-group sel-menu-danger" role="group" aria-label="${danger.g.label}">${danger.acts.map(a => selMenuRowHtml(a, c, pins)).join('')}</div>` : ''}
      <button type="button" role="menuitem" class="sel-menu-reset" data-sel-reset>Back to the default buttons</button>
    </div>`;
}

/** Draw the open menu again (the selection or the pins changed), the focus where it was. */
function renderSelMenu() {
  const el = _selMenu;
  if (!el) return;
  const was = el.contains(document.activeElement) ? document.activeElement : null;
  const key = was ? (was.dataset.selMi ? `[data-sel-mi="${was.dataset.selMi}"]` : was.dataset.selPin ? `[data-sel-pin="${was.dataset.selPin}"]` : was.hasAttribute('data-sel-reset') ? '[data-sel-reset]' : '') : '';
  const html = selMenuHtml();
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
  placeSelMenu();
  if (was && !el.contains(document.activeElement)) {
    const back = (key && el.querySelector(key)) || selMenuRows()[0];
    if (back) back.focus({ preventScroll: true });
  }
}

/** Above the bar, inside the window: as tall as the room above the bar allows (it scrolls inside). */
function placeSelMenu() {
  const el = _selMenu;
  const bar = document.getElementById('selectionBar');
  if (!el || !bar) return;
  const vw = window.innerWidth;
  // Layout numbers, not getBoundingClientRect: the bar may still be sliding in.
  const barBottom = typeof getComputedStyle === 'function' ? (parseFloat(getComputedStyle(bar).bottom) || 0) : 0;
  // Measured from the bottom, so a window made shorter keeps it inside
  // before the next placing.
  const above = barBottom + (bar.offsetHeight || 0);
  el.style.maxHeight = `max(160px, calc(100vh - ${Math.round(above + 16)}px))`;
  el.style.bottom = `${Math.max(8, Math.round(above + 8))}px`;
  const w = el.offsetWidth || 0;
  el.style.left = `${Math.max(8, Math.min(bar.offsetLeft || 0, vw - w - 8))}px`;
}

/** The rows' first buttons (and the reset link), in order: what Up and Down move through. */
function selMenuRows() {
  return _selMenu ? [..._selMenu.querySelectorAll('.sel-mi, .sel-menu-reset')] : [];
}

function onSelMenuClick(e) {
  const t = e.target;
  const pin = t.closest('[data-sel-pin]');
  if (pin) {
    // A pin changes the bar, never runs the action, and the menu stays.
    selSetPinned(pin.dataset.selPin, pin.getAttribute('aria-checked') !== 'true');
    return;
  }
  if (t.closest('[data-sel-reset]')) { selResetPinned(); return; }
  const mi = t.closest('[data-sel-mi]');
  if (!mi) return;
  const a = SEL_ACTION_BY_ID.get(mi.dataset.selMi);
  if (!a) return;
  // A menu or picker opens where More is, and takes the focus itself.
  closeSelMenu(!a.popover);
  selRunAction(a.id, a.popover ? selMoreButton() : null);
}

/**
 * Up / Down move between rows (staying on the pins when on a pin), Left /
 * Right between a row and its pin, Home / End to the first and last row.
 * Enter and Space press the button (the browser's own). Esc and Tab close it
 * and the focus goes back to More.
 */
function onSelMenuKey(e) {
  const rows = selMenuRows();
  const cur = document.activeElement;
  const onPin = !!(cur && cur.classList && cur.classList.contains('sel-pin'));
  const rowOf = (el) => (el && el.classList && el.classList.contains('sel-pin') ? el.previousElementSibling : el);
  const at = rows.indexOf(rowOf(cur));
  const go = (i) => {
    if (!rows.length) return;
    const row = rows[(i + rows.length) % rows.length];
    const pin = onPin && row.nextElementSibling && row.nextElementSibling.classList.contains('sel-pin') ? row.nextElementSibling : null;
    (pin || row).focus({ preventScroll: true });
  };
  let handled = true;
  if (e.key === 'ArrowDown') go(at + 1);
  else if (e.key === 'ArrowUp') go(at < 0 ? -1 : at - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(rows.length - 1);
  else if (e.key === 'ArrowRight' && !onPin && cur && cur.nextElementSibling && cur.nextElementSibling.classList.contains('sel-pin')) cur.nextElementSibling.focus();
  else if (e.key === 'ArrowLeft' && onPin) cur.previousElementSibling.focus();
  else if (e.key === 'Escape' || e.key === 'Tab') closeSelMenu(true);
  else handled = false;
  // The page's own keys (paging, the dock, Esc clearing things) stay out of it.
  if (handled) { e.preventDefault(); e.stopPropagation(); }
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
    if (!r.ok) { showErrorToast(selHttpError(r.status, r.error), 'queueing the files for another scan'); return; }
    // Report what actually moved. Files already in the queue, or gone from disk,
    // are named rather than folded into a number that would overstate the work.
    const notes = [];
    if (r.alreadyQueued) notes.push(`${r.alreadyQueued} already queued`);
    if (r.missing) notes.push(`${r.missing} missing from disk`);
    if (!r.queued) {
      showToast(notes.length ? `Nothing new to queue: ${notes.join(', ')}` : 'Nothing to retry');
      return;
    }
    showToast(`↻ Queued ${selFiles(r.queued)} for another scan${notes.length ? ` · ${notes.join(', ')}` : ''}`);
    // Surface the scan panel so the retry is visible; the new rows fill in as
    // they land (Library's version polling re-reads them).
    if (typeof window.vaultWatchScanQueue === 'function') window.vaultWatchScanQueue({ fresh: true });
  } catch (err) {
    showErrorToast(err, 'queueing the files for another scan');
  }
}

/** Clear the "failed to play" mark on the selected files (the bar's Mark as playable). */
async function markPlayableSelected() {
  const ids = [...selectedIds];
  if (!ids.length) return;
  try {
    const r = await postIdsChunked('/api/media/clear-playback-failed', ids);
    if (!r.ok) { showErrorToast(selHttpError(r.status, r.error), 'clearing the unplayable mark'); return; }
    // Cached rows change at once; the rest come back changed when the
    // library notices the write (its version moved), which also re-runs an
    // "Only unplayable" search so the cleared files leave it.
    for (const m of selectedMedia()) {
      if (m && m.playback_failed) { m.playback_failed = 0; Library.patchRow(m); }
    }
    selectionChanged();
    renderResults();
    renderSelectionBar();
    showToast(r.cleared ? `Marked ${selFiles(r.cleared)} as playable. ${r.cleared === 1 ? 'This file' : 'These files'} will be tried again.`
      : 'None of the selected files were marked as unplayable.');
  } catch (err) {
    showErrorToast(err, 'clearing the unplayable mark');
  }
}

/** Force refresh the errored files in the selection (player-lib/importer.js does the work). */
async function forceRefreshSelected(btn) {
  // The whole selection goes (Select all can reach rows that are not loaded
  // here); the server keeps only the ones with an error.
  const ids = [...selectedIds];
  if (!ids.length) { showToast('Nothing to refresh in this selection'); return; }
  await window.vaultForceRefresh(ids, btn, { onlyErrored: true });
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
  btn.innerHTML = `${vaultIconSwap('↻ ', 'rescan')}Rescan these (${ids.length.toLocaleString()})`;
  btn.classList.toggle('force', force);
  btn.title = force
    ? `Run the AI scan again on all ${selFiles(ids.length)} shown. ${done.toLocaleString()} of them were already scanned. Your notes, stars, ratings and flags are kept.`
    : `Queue the ${selFiles(ids.length)} whose scan failed or never ran`;
}

async function rescanFiltered() {
  const { ids, force, done } = await rescanFilteredTargets();
  if (!ids.length) { showToast('Nothing in view to rescan'); return; }

  // Only the force path costs anything the user might not want: it burns real
  // GPU time re-analyzing files that are already fine.
  if (force && !await vaultConfirm(
    `Scan ${selFiles(ids.length)} with AI again?\n\n` +
    `${done.toLocaleString()} of them were already scanned and will be tagged again ` +
    `from scratch. This can take a long time.\n\n` +
    `Your notes, stars, ratings and flags are kept.`,
    { title: 'Rescan files', okLabel: 'Rescan' })) return;

  try {
    const r = await postIdsChunked('/api/media/batch-rescan', ids, { force });
    if (!r.ok) { showErrorToast(selHttpError(r.status, r.error), 'queueing the files for scanning'); return; }
    const notes = [];
    if (r.alreadyQueued) notes.push(`${r.alreadyQueued} already queued`);
    if (r.missing) notes.push(`${r.missing} missing from disk`);
    if (!r.queued) {
      showToast(notes.length ? `Nothing new to queue: ${notes.join(', ')}` : 'Nothing to rescan');
      return;
    }
    showToast(`↻ Queued ${selFiles(r.queued)} for scanning${notes.length ? ` · ${notes.join(', ')}` : ''}`);
    if (typeof window.vaultWatchScanQueue === 'function') window.vaultWatchScanQueue({ fresh: true });
  } catch (err) {
    showErrorToast(err, 'queueing the files for scanning');
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
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw selHttpError(resp.status, body && body.error);
  }
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
  else if (_dq.ops.recycle) {
    // "Recycling" is the Windows word; Linux and macOS move files to the Trash.
    const pw = typeof vaultPlatformWords === 'function' ? vaultPlatformWords() : null;
    if (!pw || pw.recycleBin === 'Recycle Bin') { verbing = 'Recycling'; verbed = 'Recycled'; }
    else { verbing = `Moving to ${pw.recycleBinChoice}`; verbed = `Moved to ${pw.recycleBinChoice}`; }
  }
  else { verbing = 'Moving to trash'; verbed = 'Moved to trash'; }

  const ICON = _dqIconSet();
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
      ? `<button class="dq-cancel" data-seq="${it.seq}" title="Leave this file out" aria-label="Leave this file out">${ICON.x}</button>`
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
      ${allDone ? `<button class="dq-x" title="Dismiss" aria-label="Dismiss">${ICON.x}</button>` : ''}
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

/* Row states in the queue panel: Classic keeps its glyphs, Modern shows line
   icons (vaultIconSwap puts both in and the look's body class picks one). */
let _dqIcons = null;
function _dqIconSet() {
  if (_dqIcons) return _dqIcons;
  const sw = (glyph, name) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(glyph, name) : glyph);
  _dqIcons = {
    queued: `<span class="dq-dot">${sw('•', 'clock')}</span>`,
    active: '<span class="dq-spin"></span>',
    done: sw('✓', 'check'),
    skipped: sw('–', 'minus'),
    failed: sw('✗', 'alert'),
    x: sw('✕', 'close'),
  };
  return _dqIcons;
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
    const ok = await vaultConfirm(
      `Move ${n} files to the trash folder?\n\nThe files are moved on disk, not deleted, and you can restore them later.`,
      { title: 'Move to trash', okLabel: 'Move to trash' });
    if (!ok) return { okIds: [], failures: [], cancelled: true };
  }

  try {
    // Queue drives the UI (progress panel + card greying + reconcile-on-drain)
    const { okIds, skippedIds, failures } = await _dqEnqueue(toTrash, 'trash');

    if (failures.length) {
      failuresToast(failures, 'moved to the trash');
      console.warn('[Trash] failures:', failures);
    }

    if (okIds.length) {
      showUndoToast(
        `🗑 Moved ${selFiles(okIds.length)} to the trash${skippedIds.length ? ` · ${skippedIds.length.toLocaleString()} already there` : ''}`,
        () => restoreIds(okIds)
      );
    }
    if (!okIds.length && skippedIds.length) {
      showToast(skippedIds.length === 1 ? 'That file was already in the trash.' : `Those ${selFiles(skippedIds.length)} were already in the trash.`);
    }
    return { okIds, failures };
  } catch (err) {
    console.error('[Trash] failed:', err);
    showErrorToast(err, 'moving files to the trash');
    return { okIds: [], failures: [String(err.message || err)] };
  }
}

/** "2 files could not be moved to the trash: a.mp4: reason (and 1 more)". */
function failuresToast(failures, verbed) {
  const n = failures.length;
  const more = n > 1 ? ` (and ${(n - 1).toLocaleString()} more)` : '';
  showToast(`${n === 1 ? '1 file' : selFiles(n)} could not be ${verbed}: ${failures[0]}${more}`, { type: 'error' });
}

/** recycle / hard delete (no soft-trash undo). Confirms on bulk, and always
 *  for a single hard delete (irreversible) — recycle is OS-recoverable. */
async function _destructiveDelete(ids, mode) {
  const n = ids.length;
  const needConfirm = n > 1 || mode === 'hard';
  // Recycle Bin on Windows, System Trash on Linux and macOS (platform-words.js).
  // "System" because Vault's own trash folder is "the trash" in these toasts too.
  const bin = typeof vaultPlatformWords === 'function' ? vaultPlatformWords().recycleBinChoice : 'Recycle Bin';
  if (needConfirm) {
    const ok = mode === 'hard'
      ? await vaultConfirm(`Delete ${n === 1 ? 'this file' : selFiles(n)} from disk for good? This cannot be undone.`,
        { title: 'Delete permanently', okLabel: 'Delete permanently', danger: true })
      : await vaultConfirm(`Move ${n} files to the ${bin}?`,
        { title: `Move to ${bin}`, okLabel: `Move to ${bin}` });
    if (!ok) return { okIds: [], failures: [], cancelled: true };
  }
  try {
    const { okIds, skippedIds, failures } = await _dqEnqueue(ids, 'delete', { mode });
    if (failures.length) {
      failuresToast(failures, mode === 'hard' ? 'deleted' : `moved to the ${bin}`);
      console.warn('[Delete] failures:', failures);
    }
    if (okIds.length) {
      showToast((mode === 'hard'
        ? `🗑 Deleted ${selFiles(okIds.length)} for good`
        : `♻ Moved ${selFiles(okIds.length)} to the ${bin}`) +
        (skippedIds.length ? `. Kept ${skippedIds.length.toLocaleString()} that went to the trash in the meantime.` : '.'));
    } else if (skippedIds.length) {
      showToast(`Nothing deleted. ${selFiles(skippedIds.length)} went to the trash in the meantime and stayed there.`);
    }
    return { okIds, failures };
  } catch (err) {
    console.error('[Delete] failed:', err);
    showErrorToast(err, 'deleting the files');
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
      failuresToast(failures, 'restored');
      console.warn('[Restore] failures:', failures);
    }
    if (okIds.length || skippedIds.length) {
      showToast(`♻ Restored ${selFiles(okIds.length)}${skippedIds.length ? ` · ${skippedIds.length.toLocaleString()} were already out of the trash` : ''}`);
    }
    return { okIds, failures };
  } catch (err) {
    console.error('[Restore] failed:', err);
    showErrorToast(err, 'restoring the files');
    return { okIds: [], failures: [String(err.message || err)] };
  }
}

/* ── Empty trash — permanent, irreversible purge ───────────────────────────
   Deletes every trashed file from disk AND all its records/traces. Guarded by
   a size-aware confirm + a final "really?" so it can't fire by accident. */

/** What Empty trash will delete: every trashed row, documents too (6.10). */
async function fetchTrashSummary() {
  const resp = await fetch('/api/library/trash-summary');
  if (!resp.ok) throw selHttpError(resp.status);
  return resp.json();
}

async function clearTrash() {
  // Every file in the trash, whatever the filters say, counted exactly as the
  // server will delete them.
  let trash;
  try { trash = await fetchTrashSummary(); } catch (err) { showErrorToast(err, 'counting the files in the trash'); return; }
  const n = trash.count;
  if (!n) { showToast('The trash is already empty.'); return; }

  const bytes = trash.bytes || 0;
  const size = typeof formatFileSize === 'function' ? formatFileSize(bytes) : `${Math.round(bytes / 1e6)} MB`;
  if (!await vaultConfirm(`Delete ${n === 1 ? 'the 1 file' : `all ${selFiles(n)}`} in the trash (${size}) for good?\n\n` +
    `This erases the files from disk and everything Vault knows about them: tags, notes, ratings, ` +
    `subtitles and watch history. It cannot be undone.`,
    { title: 'Empty trash', okLabel: 'Empty trash', danger: true })) return;
  if (!await vaultConfirm(`Last chance. Delete ${n === 1 ? 'it' : selFiles(n)} forever?`,
    { title: 'Are you sure?', okLabel: 'Delete forever', cancelLabel: 'Keep them', danger: true })) return;

  const btn = document.getElementById('clearTrashBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Emptying…'; }
  try {
    const resp = await fetch('/api/trash/empty', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const data = await resp.json();
    if (!resp.ok) { showErrorToast(selHttpError(resp.status, data.error), 'emptying the trash'); return; }
    // Drop the purged rows from the client cache and re-render
    const ids = [];
    Library.eachCachedRow(m => { if (m.user_trashed) ids.push(m.id); });
    Library.forget(ids);
    ids.forEach(id => selectedIds.delete(id));
    Library.invalidateRows();
    selectionChanged();
    if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
    Library.refreshFacets();
    showToast(`🗑 Deleted ${selFiles(data.deleted)} for good${data.filesDeleted < data.deleted ? ` (${(data.deleted - data.filesDeleted).toLocaleString()} were already gone from disk)` : ''}`);
  } catch (err) {
    showErrorToast(err, 'emptying the trash');
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
    btn.innerHTML = `${vaultIconSwap('🗑 ', 'trash')}Empty trash (${t.count})`;
  }, () => {});
}
let _trashUiSeq = 0;
window.addEventListener('vault:facets-changed', () => updateClearTrashUi());

function trashSelected() {
  // A cancelled confirm leaves the selection as it was.
  trashIds([...selectedIds], { confirmBulk: true }).then(r => { if (!r || !r.cancelled) clearSelection(); });
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
  const goneNote = !gone ? '' : gone === 1 ? ' 1 selected file is no longer in the library.'
    : ` ${gone.toLocaleString()} selected files are no longer in the library.`;
  if (stopped) {
    showToast(`${verb} ${settled.toLocaleString()} of ${total.toLocaleString()}. ` +
      `${(total - settled).toLocaleString()} could not be saved. Try again.${goneNote}`, { type: 'error' });
  } else if (saved) {
    showToast(`${value ? '🚩 Flagged' : 'Unflagged'} ${selFiles(saved)}.${goneNote}`);
  }
}

/* ── Undo toast ────────────────────────────────────────────────────────── */

let _undoTimer = null;

/** A toast with one action button (Undo unless `label` says otherwise). `message` is HTML. */
function showUndoToast(message, onUndo, ms = 8000, label = 'Undo') {
  let el = document.getElementById('undoToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'undoToast';
    el.className = 'undo-toast';
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <span>${message}</span>
    <button class="undo-btn">${label}</button>
    <button class="undo-dismiss" title="Dismiss" aria-label="Dismiss">✕</button>
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

/**
 * Does this error say the FILE cannot play here, or only that this attempt
 * failed? The mark is kept for good (auto-advance, Up next, random play and
 * Stage pass the file over), so it is only set when the file itself is the
 * problem:
 *   'mark'   the browser got the bytes and could not decode them
 *   'probe'  "not supported", which browsers also say when the URL answered
 *            with an HTTP error or not at all: ask the server first
 *   'no'     anything else (a network drop, an aborted load, a server
 *            restart, the browser out of decoders, a converted-stream retry
 *            still to come). Playback still moves on; nothing is saved.
 */
function _playbackFailureKind(el) {
  if (el.tagName === 'IMG') return 'probe';
  // handleMediaError retries a native attempt through the converted stream
  // once (retryThroughRemux). That retry gets its chance before any mark;
  // if it fails too, player-stream.js marks it.
  if (el.dataset && el.dataset.playbackFallback === 'remux') return 'no';
  const err = el.error;
  if (!err) return 'no';
  // Firefox out of decoders / memory: the file is fine, the browser is busy.
  if (/OUT_OF_MEMORY|allocat/i.test(err.message || '')) return 'no';
  if (err.code === 3 /* MEDIA_ERR_DECODE */) return 'mark';
  if (err.code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */) return 'probe';
  return 'no';   // MEDIA_ERR_ABORTED, MEDIA_ERR_NETWORK
}

/** Did the server answer this URL with the file (2xx)? Any failure counts as no. */
async function _sourceAnswers(url) {
  if (!url || /^(blob|data):/i.test(url)) return false;
  try {
    const resp = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    try { if (resp.body) resp.body.cancel(); } catch {}
    return resp.ok;
  } catch {
    return false;
  }
}

function _markPlaybackFailed(media) {
  if (!media || media.playback_failed) return;
  media.playback_failed = 1;
  postFlags(media, { playback_failed: 1 });
  // Privacy / streaming mode handles the same failure by skipping to the next
  // file (handleMediaError in player-core.js) and says so itself. Two toasts
  // for one dead file reads as two separate problems, so only the flag is
  // set here and the message is left to the handler that acted on it.
  if (!document.body.classList.contains('privacy-mode')) {
    showToast('This file would not play in this browser, so it is marked as unplayable.', { type: 'error' });
  }
}

document.addEventListener('error', (e) => {
  const el = e.target;
  const media = _isCurrentPlayerMedia(el);
  if (!media || media.playback_failed) return;
  const kind = _playbackFailureKind(el);
  if (kind === 'mark') { _markPlaybackFailed(media); return; }
  if (kind !== 'probe') return;
  const url = el.currentSrc || el.getAttribute('src') || '';
  _sourceAnswers(url).then((ok) => { if (ok) _markPlaybackFailed(media); });
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
  showToast('This file plays now, so it is no longer marked as unplayable.', { type: 'success' });
  // Repaint so the ⚠ badge and the red tile border go without a manual refresh.
  if (typeof refreshInfoSurfaces === 'function') refreshInfoSurfaces(media);
  else if (typeof renderResults === 'function') renderResults();
}
document.addEventListener('canplay', _clearPlaybackFailed, true);
document.addEventListener('load', _clearPlaybackFailed, true);
