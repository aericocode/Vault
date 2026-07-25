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

function clearSelection() {
  selectedIds.clear();
  lastSelectedId = null;
  syncTileCheckboxes();
  renderSelectionBar();
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

  const items = [...selectedIds].map(getMediaById).filter(Boolean);
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
    ${avCount > 0 ? `<button class="sel-btn sel-music" onclick="fingerprintSelected()" title="Fingerprint audio — one-time per file; auto-matches songs across the library">🎵 Fingerprint (${avCount})</button>` : ''}
    ${vidCount >= 2 ? `
      <button class="sel-btn sel-mix" onclick="openEditorWithSelection('stack')"
        title="Open in the Editor, layered in sync${many}">▤ Stack ${vidCount}</button>
      <button class="sel-btn sel-mix" onclick="openEditorWithSelection('grid')"
        title="Open in the Editor, side by side in sync${many}">▦ Grid ${vidCount}</button>
    ` : ''}`;

  // "Select all on page" toggle — label reflects whether the page is fully selected
  const pageIds = currentPageIds();
  const pageAllSelected = pageIds.length > 0 && pageIds.every(id => selectedIds.has(id));
  const pageBtn = pageIds.length > 0
    ? `<button class="sel-btn sel-page" onclick="toggleSelectPage()">${pageAllSelected ? 'Deselect page' : `Select page (${pageIds.length})`}</button>`
    : '';

  bar.innerHTML = `
    <span class="sel-count">${selectedIds.size} selected</span>
    ${pageBtn}
    ${musicBtns}
    ${activeCount > 0 ? `<button class="sel-btn sel-trash" onclick="trashSelected()">🗑 Trash (${activeCount})</button>` : ''}
    ${trashedCount > 0 ? `<button class="sel-btn sel-restore" onclick="restoreSelected()">♻ Restore (${trashedCount})</button>` : ''}
    <button class="sel-btn" onclick="bulkFlag(1)">🚩 Flag</button>
    <button class="sel-btn" onclick="bulkFlag(0)">Unflag</button>
    <button class="sel-btn" onclick="addSelectionToCollection(this)" title="Add selection to a collection">📁 Collect (${selectedIds.size})</button>
    <button class="sel-btn sel-remove" onclick="removeSelectedRecords()" title="Delete records from the library — files on disk are NOT touched">✂ Remove records</button>
    <button class="sel-btn sel-clear" onclick="clearSelection()">✕ Clear</button>
  `;
  bar.classList.add('visible');
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
  const items = [...selectedIds].map(getMediaById).filter(m => m && (m.user_flagged_delete ? 1 : 0) !== value);
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
document.addEventListener('error', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (!['VIDEO', 'AUDIO', 'IMG'].includes(el.tagName)) return;
  if (!el.closest('#mediaPlayerContent') && !el.closest('#miniPlayerMedia')) return;

  const media = (typeof currentMediaState !== 'undefined' && currentMediaState.currentMediaData) || null;
  if (media && media.id && !media.playback_failed) {
    media.playback_failed = 1;
    postFlags(media, { playback_failed: 1 });
    showToast('⚠ File failed to play — marked as unplayable');
  }
}, true);
