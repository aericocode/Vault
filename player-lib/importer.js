/* =========================================================================
   IMPORTER — add media to the library WITHOUT ever copying files.

   Vault's model: it RECORDS file locations and leaves files where they are.
   Nothing is ever uploaded or copied onto local disk.
     • 📁 Add folder — native folder picker → server walks the tree → preview
       modal (grouped by media type) → records paths.
     • 📄 Add files  — native MULTI-FILE picker → records the picked paths.
   Both confirm instantly via /api/import/add-paths — no upload, nothing copied.

   Drag-drop: the browser never reveals a dropped item's real path (hard
   security boundary) and Vault will NOT copy bytes — but the drag SOURCE
   still knows. On drop, the server reads the source window's live selection
   (Directory Opus listers, File Explorer windows, the desktop) and matches it
   against the drop's names+sizes to recover the true paths (/api/import/
   resolve-drop). Files then add in place; folders open the usual preview
   modal. If the drop can't be traced (exotic source app, ambiguous match),
   it falls back to the native pickers, which always see real paths.
   ========================================================================= */
(function () {
  let _depth = 0;         // dragenter/dragleave nest counter (children re-fire)

  /* ── Extension → modal bucket (mirrors config/extensions + audio procs) ── */
  const BUCKET_EXTS = {
    video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg',
      '3gp', 'mts', 'm2ts', 'vob', 'ogv', 'rm', 'rmvb', 'asf', 'divx'],
    image: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a'],
  };
  const EXT_BUCKET = {};
  for (const [b, exts] of Object.entries(BUCKET_EXTS)) for (const e of exts) EXT_BUCKET[e] = b;
  const BUCKET_META = {
    video: { icon: '🎬', label: 'Video' },
    image: { icon: '🖼️', label: 'Images & GIFs' },
    audio: { icon: '🎵', label: 'Audio' },
  };

  const extOf = (name) => {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
  };

  const hasFiles = (e) =>
    e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  function showDropOverlay(show) {
    let ov = document.getElementById('vaultDropOverlay');
    if (show) {
      if (ov) return;
      ov = document.createElement('div');
      ov.id = 'vaultDropOverlay';
      ov.textContent = '⬇ Drop to add in place — nothing is copied';
      document.body.appendChild(ov);
    } else {
      ov?.remove();
    }
  }

  /* ── Progress panel (delete-queue look; hides behind the player) ──────── */
  function importPanel(total, verb = '⬆ Importing') {
    document.getElementById('importQueuePanel')?.remove();
    const el = document.createElement('div');
    el.id = 'importQueuePanel';
    el.className = 'delete-queue visible';
    queuePanelStack().appendChild(el);
    const failures = [];   // { name, error }
    let hideTimer = null;

    const failRows = () => failures.map(f =>
      `<div class="dq-row dq-failed" title="${escapeHtml(f.error)}"><span class="dq-ico">✗</span><span class="dq-name">${escapeHtml(f.name)}</span></div>`
    ).join('');

    return {
      update(done, name) {
        el.innerHTML = `
          <div class="dq-head">
            <span class="dq-spin"></span>
            <span class="dq-title">${verb} ${done}/${total}${name ? ` — <span class="dq-file">${escapeHtml(name)}</span>` : ''}</span>
          </div>
          ${failures.length ? `<div class="dq-list">${failRows()}</div>` : ''}`;
      },
      fail(name, error) { failures.push({ name, error }); },
      finish(ok, extra) {
        clearTimeout(hideTimer);
        el.innerHTML = `
          <div class="dq-head">
            <span class="dq-title">${ok ? '✓' : '⚠'} ${ok ? 'Added' : 'Import'} ${ok}/${total}${failures.length ? ` · ${failures.length} failed` : ''}${extra ? ` — ${escapeHtml(extra)}` : ''}</span>
            <button class="dq-x" title="Dismiss">✕</button>
          </div>
          ${failures.length ? `<div class="dq-list">${failRows()}</div>` : ''}`;
        el.querySelector('.dq-x')?.addEventListener('click', () => el.remove());
        if (!failures.length) hideTimer = setTimeout(() => el.remove(), 3000);
      },
    };
  }

  /* ── AI scan panel (the slow half of an import) ────────────────────────
     importPanel() above tracks path *registration*, which is instant. The
     vision scan that follows can run for hours, so it gets its own persistent
     panel fed by GET /api/import/queue — one poller for the whole app, started
     from addPaths() (covering both the modal and the loose-file drop path) and
     again at load so a reload mid-scan reattaches instead of going blind.

     Everything degrades to silence: a server without the route just never
     shows the panel. */

  const SCAN_POLL_MS = 1500;
  const SCAN_MAX_FAILS = 5;      // consecutive fetch errors → assume no route
  const SCAN_MAX_IDLE = 40;      // rounds with an empty queue → stop watching
  const CANCEL_ARM_MS = 5000;    // armed Cancel disarms itself if left alone

  let _scanTimer = null;
  let _scanBusy = false;
  let _scanFails = 0;
  let _scanIdle = 0;
  let _scanDismissed = false;    // user hid the panel; the scan keeps running
  let _scanFinishTimer = null;   // auto-dismiss of a finished panel
  let _scanLast = null;          // last readable status — what a paused poll shows
  let _scanCmdBusy = false;      // a pause/resume POST is in flight
  let _cancelArmTimer = null;    // the second half of the two-click Cancel
  let _haltNotified = 0;         // halt.at already toasted — warn once per halt

  // Same buckets as lib/work-queue.js ProgressTracker.eta, so the CLI and the
  // panel never quote different numbers for the same queue.
  function fmtEta(ms) {
    if (ms == null || !Number.isFinite(ms)) return '—';
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  function scanPanelEl() {
    // A new run inside the auto-dismiss window reuses this element — drop the
    // pending removal or it yanks the panel out from under the live run.
    clearTimeout(_scanFinishTimer);
    _scanFinishTimer = null;

    let el = document.getElementById('scanQueuePanel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'scanQueuePanel';
    el.className = 'delete-queue';
    // The bar fill, the worker stepper and the action buttons live outside the
    // re-rendered regions: rebuilding the fill every round would restart its CSS
    // transition, rebuilding the input would swallow half-typed digits (the
    // element is gone before it can fire `change`), and rebuilding the buttons
    // would wipe the armed half of the two-click Cancel every 1.5s — the poll
    // would disarm it faster than anyone can click twice.
    el.innerHTML = `
      <div class="dq-head" id="scanHead"></div>
      <div class="dq-bar"><div class="dq-bar-fill" id="scanBarFill"></div></div>
      <div class="dq-meta" id="scanMeta">
        <span class="dq-eta" id="scanEta"></span>
        <span class="dq-workers">🤖 <input type="number" min="1" max="8" step="1"
          class="dq-num" id="scanWorkersNum" data-scan-workers
          title="Parallel vision jobs — changes take effect immediately"></span>
      </div>
      <div class="dq-warn" id="scanWarn" hidden></div>
      <div class="dq-list" id="scanList"></div>
      <div class="dq-actions" id="scanActions">
        <button type="button" class="dq-btn dq-btn-quiet" id="scanHideBtn"
          title="Hide this panel — the scan keeps running in the background">Hide</button>
        <button type="button" class="dq-btn" id="scanPauseBtn"></button>
        <button type="button" class="dq-btn dq-btn-danger" id="scanCancelBtn">Cancel</button>
      </div>`;
    queuePanelStack().appendChild(el);
    el.querySelector('#scanWorkersNum').addEventListener('change', (e) => {
      if (typeof window.vaultSetScanWorkers === 'function') {
        e.target.value = window.vaultSetScanWorkers(e.target.value);
      }
    });
    el.querySelector('#scanPauseBtn').addEventListener('click', onPauseClick);
    el.querySelector('#scanCancelBtn').addEventListener('click', onCancelClick);
    // The head's ✕ became Cancel, which would leave no way to get an hours-long
    // run off the screen without killing it — so the harmless half of the old ✕
    // lives on here. Keeps polling: a halt still toasts through a hidden panel.
    el.querySelector('#scanHideBtn').addEventListener('click', () => {
      _scanDismissed = true;
      document.getElementById('scanQueuePanel')?.remove();
    });
    return el;
  }

  /* ── ⏸ Pause / ▶ Resume ─────────────────────────────────────────────────
     Pausing stops dispatch only — whatever is already mid-scan finishes, since
     a vision call can't be torn down cleanly. Resuming a model halt asks the
     server to probe the endpoint first, so "I loaded the wrong model" comes
     back as a warning instead of an instant re-pause. */
  async function onPauseClick(e) {
    if (_scanCmdBusy) return;
    const resuming = e.currentTarget.dataset.mode === 'resume';
    _scanCmdBusy = true;
    if (_scanLast) renderScanPanel(_scanLast);          // grey the button now
    try {
      const resp = await fetch(`/api/import/queue/${resuming ? 'resume' : 'pause'}`, { method: 'POST' });
      const q = await resp.json().catch(() => null);
      if (!resp.ok) { showToast('⚠ ' + ((q && q.error) || `HTTP ${resp.status}`)); return; }
      if (q?.warning) showToast('⚠ ' + q.warning);
      else showToast(resuming ? '▶ Scanning resumed' : '⏸ Scan paused — files already running will finish');
      if (q) _scanLast = q;
      // The watcher may have given up while the queue sat halted; a resume needs
      // it back to follow the run.
      if (resuming) watchScanQueue();
    } catch (err) {
      showToast('⚠ ' + err.message);
    } finally {
      _scanCmdBusy = false;
      if (_scanLast && document.getElementById('scanQueuePanel')) renderScanPanel(_scanLast);
    }
  }

  function disarmCancel() {
    clearTimeout(_cancelArmTimer);
    _cancelArmTimer = null;
    const btn = document.getElementById('scanCancelBtn');
    if (!btn) return;
    btn.classList.remove('armed');
    btn.textContent = 'Cancel';
    btn.title = 'Stop the scan and drop everything still queued';
  }

  /* ── ✕ → two-click Cancel ───────────────────────────────────────────────
     This genuinely throws work away (the queue is cleared), so one stray click
     must not be enough. First click arms and relabels; the second commits.
     Left alone it disarms itself after CANCEL_ARM_MS. */
  async function onCancelClick(e) {
    const btn = e.currentTarget;
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Click again to cancel';
      btn.title = 'This drops every file still queued';
      clearTimeout(_cancelArmTimer);
      _cancelArmTimer = setTimeout(disarmCancel, CANCEL_ARM_MS);
      return;
    }
    disarmCancel();
    let stillRunning = 0;
    try {
      const resp = await fetch('/api/import/queue/cancel', { method: 'POST' });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok) { showToast('⚠ ' + (r.error || `HTTP ${resp.status}`)); return; }
      stillRunning = r.active || 0;
      const still = stillRunning ? `, ${stillRunning} still finishing` : '';
      showToast(r.dropped
        ? `✕ Scan cancelled — ${r.dropped} queued file${r.dropped === 1 ? '' : 's'} dropped${still}`
        : '✕ Scan cancelled');
    } catch (err) {
      showToast('⚠ ' + err.message);
    } finally {
      // Cancelled means done watching: in-flight files finish on their own and
      // their rows land normally, but there is no run left to report on. Keep
      // the poller alive while any are still going, though — one of them can
      // still halt the model, and that warning has to reach the user.
      _scanDismissed = true;
      _scanLast = null;
      if (!stillRunning) stopScanWatch();
      document.getElementById('scanQueuePanel')?.remove();
    }
  }

  function renderScanPanel(q) {
    const el = scanPanelEl();
    el.classList.add('visible');

    const done = q.done || 0, failed = q.failed || 0, total = q.total || 0;
    const by = q.paused ? (q.pausedBy || 'user') : null;
    const note = { vault: ' — paused (vault locked)', user: ' — paused', model: ' — paused (model unavailable)' }[by] || '';
    el.querySelector('#scanHead').innerHTML = `
      ${q.paused ? `<span class="dq-ico">${by === 'model' ? '⚠' : '⏸'}</span>` : '<span class="dq-spin"></span>'}
      <span class="dq-title">🤖 AI scan ${done}/${total}${failed ? ` · ${failed} failed` : ''}${note}</span>`;

    const pct = total ? Math.min(100, ((done + failed) / total) * 100) : 0;
    el.querySelector('#scanBarFill').style.width = `${pct}%`;

    // Why it stopped, and what to do about it. Only the model halt needs
    // explaining — a vault lock and a deliberate pause speak for themselves.
    const warn = el.querySelector('#scanWarn');
    if (by === 'model' && q.halt) {
      warn.hidden = false;
      warn.innerHTML = `⚠ <b>Model unavailable</b> — ${escapeHtml(q.halt.reason || '')}`
        + (q.halt.filename ? `<div class="dq-warn-at">stopped at ${escapeHtml(q.halt.filename)}</div>` : '')
        + `<div class="dq-warn-at">Nothing was lost — load the model, then press ▶ Resume.</div>`;
    } else {
      warn.hidden = true;
      warn.innerHTML = '';
    }

    // Pause ↔ Resume. A vault lock isn't ours to clear, so the button steps
    // aside rather than pretending it can.
    const pauseBtn = el.querySelector('#scanPauseBtn');
    const resuming = !!q.paused;
    pauseBtn.dataset.mode = resuming ? 'resume' : 'pause';
    pauseBtn.textContent = resuming ? '▶ Resume' : '⏸ Pause';
    pauseBtn.classList.toggle('dq-btn-primary', resuming && by !== 'vault');
    pauseBtn.disabled = _scanCmdBusy || by === 'vault';
    pauseBtn.title = by === 'vault'
      ? 'The vault is locked — unlock it to carry on scanning'
      : resuming ? 'Start scanning again from where it stopped'
        : 'Stop starting new files — anything mid-scan still finishes';

    el.querySelector('#scanActions').hidden = false;
    el.querySelector('#scanMeta').style.display = '';
    el.querySelector('#scanEta').textContent = `ETA ${fmtEta(q.etaMs)}`;
    // Mid-edit is sacred: a poll landing between keystrokes must not rewrite
    // what the user is typing.
    const num = el.querySelector('#scanWorkersNum');
    const workers = String(q.concurrency || (window.vaultScanWorkers ? window.vaultScanWorkers() : 2));
    if (document.activeElement !== num && num.value !== workers) num.value = workers;

    // .dq-name is already blurred under body.privacy-mode (css/settings.css).
    el.querySelector('#scanList').innerHTML = (q.active || []).map(a =>
      `<div class="dq-row dq-active"><span class="dq-ico">⏳</span><span class="dq-name">${escapeHtml(a.filename || '')}</span></div>`
    ).join('');
  }

  function finishScanPanel(q) {
    const el = document.getElementById('scanQueuePanel');
    if (!el) return;
    const done = q.done || 0, failed = q.failed || 0, total = q.total || 0;
    el.querySelector('#scanBarFill').style.width = '100%';
    el.querySelector('#scanHead').innerHTML =
      `<span class="dq-title">${failed ? '⚠' : '✓'} AI scan ${done}/${total}${failed ? ` · ${failed} failed` : ''}</span>
       <button class="dq-x" title="Dismiss">✕</button>`;
    el.querySelector('#scanMeta').style.display = 'none';   // keeps the stepper node alive
    el.querySelector('#scanList').innerHTML = '';
    // Nothing left to pause or cancel — the head's ✕ is a plain dismiss here.
    el.querySelector('#scanActions').hidden = true;
    el.querySelector('#scanWarn').hidden = true;
    disarmCancel();
    el.querySelector('.dq-x').addEventListener('click', () => el.remove());
    clearTimeout(_scanFinishTimer);
    if (!failed) _scanFinishTimer = setTimeout(() => el.remove(), 4000);
  }

  function stopScanWatch() {
    clearInterval(_scanTimer);
    _scanTimer = null;
  }

  async function scanTick() {
    if (_scanBusy) return;                  // a slow round must not stack
    _scanBusy = true;
    try {
      const resp = await fetch('/api/import/queue');
      // 423 is the vault-lock gate (server/index.js), not a broken route: the
      // queue is paused, not gone. Keep polling — the run resumes on unlock and
      // the panel picks itself back up with no reload. status() is behind that
      // gate for privacy (it names files), so the last good payload is what the
      // paused panel keeps showing.
      if (resp.status === 423) {
        _scanFails = 0;
        if (_scanLast) {
          _scanIdle = 0;
          // etaMs is dropped: an estimate from before the lock is meaningless
          // while nothing is running. pausedBy/halt are overridden too — the
          // lock is the live reason now, whatever the last payload said.
          if (!_scanDismissed) {
            renderScanPanel({ ..._scanLast, paused: true, pausedBy: 'vault', halt: null, etaMs: null });
          }
        } else if (++_scanIdle >= SCAN_MAX_IDLE) {
          stopScanWatch();          // locked with nothing known to report
        }
        return;
      }
      if (!resp.ok) throw new Error('bad status');
      const q = await resp.json();
      _scanFails = 0;

      const total = q.total || 0;
      const working = (q.active?.length || 0) + (q.pending?.length || 0);
      if (!total && !working) {
        // Idle queue — keep a short watch in case work lands, then let go.
        _scanLast = null;
        if (++_scanIdle >= SCAN_MAX_IDLE) stopScanWatch();
        return;
      }
      _scanIdle = 0;
      _scanLast = q;

      // Warn once per halt whether the panel is up or not: the queue has stopped
      // and needs a person, and the whole stack hides behind the full player.
      if (q.pausedBy === 'model' && q.halt && q.halt.at !== _haltNotified) {
        _haltNotified = q.halt.at;
        _scanDismissed = false;                 // a halt is worth un-hiding for
        showToast(`⚠ AI scan paused — ${q.halt.reason}`);
      }

      const complete = total > 0 && (q.done || 0) + (q.failed || 0) >= total && !working;
      if (complete) {
        _scanLast = null;
        if (document.getElementById('scanQueuePanel')) { renderScanPanel(q); finishScanPanel(q); }
        stopScanWatch();
        return;
      }
      if (!_scanDismissed) renderScanPanel(q);
    } catch {
      // Missing route or a dead server: bail quietly rather than retrying
      // forever against something that will never answer.
      if (++_scanFails >= SCAN_MAX_FAILS) stopScanWatch();
    } finally {
      _scanBusy = false;
    }
  }

  // Exposed so other modules can raise the panel for work they queued
  // themselves (selection.js's ↻ Retry errors).
  window.vaultWatchScanQueue = (opts) => watchScanQueue(opts || {});

  function watchScanQueue({ fresh = false } = {}) {
    if (fresh) { _scanDismissed = false; _scanIdle = 0; _scanFails = 0; }
    if (_scanTimer) { scanTick(); return; }
    _scanTimer = setInterval(() => { if (!document.hidden) scanTick(); }, SCAN_POLL_MS);
    scanTick();
  }

  // Back from another tab → catch up now instead of waiting out the interval.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _scanTimer) scanTick();
  });

  /* ── Shared live-grid refresh (throttled — big adds shouldn't repaint 60×) */
  function makeGridRefresher() {
    let last = 0;
    return (force = false) => {
      const now = Date.now();
      if (!force && now - last < 500) return;    // final flush catches stragglers
      last = now;
      try {
        if (typeof invalidateFuse === 'function') invalidateFuse();
        if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
      } catch {}
    };
  }

  /* ── Post-add duration watcher ─────────────────────────────────────────
     add-paths returns rows BEFORE ffprobe fills duration/width/height, and
     hover-scrub (cards.js) is gated on duration_seconds — so freshly added
     videos wouldn't scrub until a full page reload. Poll the new ids and
     patch the live allMedia rows in place (getMediaById hands back the same
     object the grid reads) until every duration lands, progress stalls for
     ~30s, or the overall cap hits. Cosmetic-only: on any failure the tiles
     simply stay scrub-less until the next reload. */
  async function watchDurationProbe(ids) {
    const pending = new Set(ids);
    const refreshGrid = makeGridRefresher();
    const started = Date.now();
    let stalled = 0;                       // consecutive rounds with no progress
    while (pending.size && stalled < 20 && Date.now() - started < 10 * 60 * 1000) {
      await new Promise(r => setTimeout(r, 1500));
      let rows;
      try {
        const resp = await fetch('/api/media/rows', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [...pending] }),
        });
        if (!resp.ok) return;
        rows = (await resp.json()).rows || [];
      } catch { return; }
      let progressed = false;
      for (const row of rows) {
        if (row.duration_seconds == null) continue;
        pending.delete(row.id);
        progressed = true;
        const local = typeof getMediaById === 'function' ? getMediaById(row.id) : null;
        if (local) Object.assign(local, row);
      }
      stalled = progressed ? 0 : stalled + 1;
      if (progressed) refreshGrid(!pending.size);   // forced flush on the last row
    }
  }

  /* ── Path mode (folders + files): record locations, copy nothing ──────── */
  async function addPaths(entries) {
    const panel = importPanel(entries.length, '📁 Adding');
    const refreshGrid = makeGridRefresher();
    const imported = [];
    const skipped = { unsupported: 0, existing: 0, missing: 0 };
    let queued = false;

    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      panel.update(Math.min(i + CHUNK, entries.length), chunk[chunk.length - 1]?.name);
      try {
        const resp = await fetch('/api/import/add-paths', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paths: chunk.map(e => e.path) }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) { panel.fail(`${chunk.length} files`, data.error || `HTTP ${resp.status}`); continue; }
        queued = queued || data.queued;
        for (const k of Object.keys(skipped)) skipped[k] += data.skipped?.[k] || 0;
        for (const a of (data.added || [])) {
          imported.push({ id: a.id, mediaType: a.mediaType });
          if (a.row && typeof allMedia !== 'undefined' && !allMedia.some(m => m.id === a.row.id)) {
            allMedia.push(a.row);
          }
        }
        refreshGrid();
      } catch (err) {
        panel.fail(`${chunk.length} files`, err.message);
      }
    }

    refreshGrid(true);
    const skips = [];
    if (skipped.existing) skips.push(`${skipped.existing} already in library`);
    if (skipped.unsupported) skips.push(`${skipped.unsupported} unsupported`);
    if (skipped.missing) skips.push(`${skipped.missing} missing`);
    panel.finish(imported.length,
      (imported.length ? (queued ? 'referenced in place, AI scan queued' : 'referenced in place — no AI scan (is an endpoint configured?)') : '')
      + (skips.length ? ` · ${skips.join(', ')}` : ''));
    // Durations arrive from the background probe after this response — watch
    // for them so fresh video tiles hover-scrub without a reload.
    watchDurationProbe(imported
      .filter(r => ['video', 'audio', 'gif'].includes(r.mediaType))
      .map(r => r.id));
    // …and the AI scan results land later still — watch the new ⏳ rows so
    // descriptions/themes appear on hover + sidebar without 🔄 Refresh
    if (typeof watchUnscanned === 'function') watchUnscanned();
    // …and the scan itself now has a queue to report on. Called here rather
    // than in the modal so loose-file drops (which skip the modal) are covered.
    watchScanQueue({ fresh: true });
    return { imported };
  }

  /* ── Native picker → scan → preview modal ─────────────────────────────── */
  async function pickAndAddFolder() {
    // The picker is modal per-server (one at a time) — reflect that on the
    // button so double clicks can't race it, and the user sees it's open.
    const btn = document.getElementById('addFolderBtn');
    if (btn?.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = '📁 Picker open…'; }
    try {
      let picked;
      try {
        const resp = await fetch('/api/import/pick-folder', { method: 'POST' });
        picked = await resp.json().catch(() => ({}));
        if (!resp.ok) { showToast('⚠ ' + (picked.error || 'folder picker failed')); return; }
      } catch (err) { showToast('⚠ ' + err.message); return; }
      if (picked.canceled || !picked.path) return;
      await openFolderImport(picked.path);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📁 Add folder'; }
    }
  }
  window.pickAndAddFolder = pickAndAddFolder;

  // Scan a folder path and open the preview modal — shared by the folder
  // picker and resolved folder drops.
  async function openFolderImport(folderPath) {
    showToast('🔍 Scanning folder…');
    try {
      const resp = await fetch('/api/import/scan-folder', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      });
      const scan = await resp.json().catch(() => ({}));
      if (!resp.ok) { showToast('⚠ ' + (scan.error || 'could not read folder')); return; }
      if (!scan.files.length) { showToast('⚠ Folder appears to be empty'); return; }
      if (scan.truncated) showToast(`⚠ Huge folder — preview capped at ${scan.files.length.toLocaleString()} files`);
      openImportModal({
        mode: 'paths',
        roots: [scan.name],
        path: scan.path,
        subdirs: scan.subdirs,
        files: scan.files,          // already { path, name, ext, size, depth }
      });
    } catch (err) {
      showToast('⚠ ' + err.message);
    }
  }

  /* ── Native multi-file picker → record paths in place (no copy) ────────── */
  async function pickAndAddFiles() {
    const btn = document.getElementById('addFilesBtn');
    if (btn?.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = '📄 Picker open…'; }
    try {
      let picked;
      try {
        const resp = await fetch('/api/import/pick-files', { method: 'POST' });
        picked = await resp.json().catch(() => ({}));
        if (!resp.ok) { showToast('⚠ ' + (picked.error || 'file picker failed')); return; }
      } catch (err) { showToast('⚠ ' + err.message); return; }
      if (picked.canceled) return;                 // real cancel — stay quiet
      if (!picked.paths?.length) {                 // OK'd but nothing usable came back
        showToast('⚠ The file picker returned no files — nothing was added');
        return;
      }

      // Real on-disk paths — hand straight to add-paths (in place, no copy).
      const entries = picked.paths.map(p => ({ path: p, name: p.split(/[\\/]/).pop() || p }));
      await addPaths(entries);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📄 Add files'; }
    }
  }
  window.pickAndAddFiles = pickAndAddFiles;

  /* ── Preview computation for the modal ─────────────────────────────────── */
  function computePreview(collected, includeSubs) {
    const files = collected.files.filter(f => includeSubs || f.depth === 0);
    const buckets = { video: { n: 0, exts: {}, files: [] }, image: { n: 0, exts: {}, files: [] }, audio: { n: 0, exts: {}, files: [] } };
    const ignored = { n: 0, exts: {} };
    for (const f of files) {
      const b = EXT_BUCKET[f.ext];
      if (b) {
        buckets[b].n++;
        buckets[b].exts[f.ext] = (buckets[b].exts[f.ext] || 0) + 1;
        buckets[b].files.push(f);
      } else {
        ignored.n++;
        const key = f.ext || '(none)';
        ignored.exts[key] = (ignored.exts[key] || 0) + 1;
      }
    }
    return { buckets, ignored };
  }

  // "mp4 (92) · wmv (30) · webm (20)" — top 3 by count, "+N more" beyond
  function extLine(exts) {
    const sorted = Object.entries(exts).sort((a, b) => b[1] - a[1]);
    const shown = sorted.slice(0, 3).map(([e, n]) => `${e} (${n})`).join(' · ');
    return sorted.length > 3 ? `${shown} · +${sorted.length - 3} more` : (shown || '—');
  }

  const fmtSize = (b) => b >= 1e9 ? `~${(b / 1e9).toFixed(1)} GB`
    : b >= 1e6 ? `~${Math.round(b / 1e6)} MB` : `~${Math.max(1, Math.round(b / 1e3))} KB`;

  /* ── The import-preview modal (approved GUI; serves both modes) ────────── */
  function openImportModal(collected) {
    document.getElementById('importModal')?.remove();
    const pathMode = collected.mode === 'paths';

    const state = {
      includeSubs: true,
      types: { video: true, image: true, audio: true },   // default: all selected
      subtitles: false,                                   // post-add jobs default OFF
      fingerprint: false,
    };

    const headPath = pathMode
      ? collected.path
      : (collected.roots?.length > 1 ? `${collected.roots.length} folders — ${collected.roots.join(', ')}` : (collected.roots?.[0] || 'Dropped files'));

    const ov = document.createElement('div');
    ov.id = 'importModal';
    ov.className = 'import-overlay';
    ov.innerHTML = `
      <div class="import-modal" role="dialog" aria-label="Import folder">
        <div class="imp-head">
          <span class="imp-ic">📥</span>
          <div class="imp-titles">
            <div class="imp-t1">Add folder</div>
            <div class="imp-t2" title="${escapeHtml(headPath)}">${escapeHtml(headPath)}</div>
          </div>
          <button class="imp-x" title="Cancel">✕</button>
        </div>
        <div class="imp-body">
          <div>
            <div class="imp-sect">What's inside · pick what to add</div>
            <div class="imp-types" id="impTypes"></div>
            <div class="imp-note" id="impIgnored"></div>
          </div>
          <div>
            <div class="imp-sect">Options</div>
            <div class="imp-pills">
              <span class="imp-pill on" id="impSubdirs">📂 Include subfolders <span class="imp-sub">(${collected.subdirs} found)</span></span>
              <span class="imp-pill imp-pill-num">🤖 AI scan workers
                <input type="number" min="1" max="8" step="1" class="imp-num" id="impWorkers"
                       data-scan-workers value="${window.vaultScanWorkers ? window.vaultScanWorkers() : 2}"
                       title="How many files the vision model scans at once">
                <span class="imp-sub">parallel vision jobs</span>
              </span>
            </div>
          </div>
          <div>
            <div class="imp-sect">After adding</div>
            <div class="imp-pills">
              <span class="imp-pill" id="impSubsJob">💬 Generate subtitles</span>
              <span class="imp-pill" id="impFpJob">🎵 Fingerprint audio <span class="imp-sub">(Music ID)</span></span>
            </div>
            <div class="imp-note">Runs in the background — the library stays usable. New files are AI-scanned automatically.</div>
          </div>
          <div class="imp-note">🔒 Files are referenced in place — nothing is copied or moved.</div>
        </div>
        <div class="imp-foot">
          <span class="imp-sum" id="impSummary"></span>
          <button class="vault-btn" id="impCancel">Cancel</button>
          <button class="vault-btn vault-btn-primary" id="impGo">Add</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const q = (sel) => ov.querySelector(sel);

    let preview = null;
    function selectedEntries() {
      const sel = Object.keys(state.types).filter(k => state.types[k]);
      return sel.flatMap(k => preview.buckets[k].files);
    }
    function render() {
      preview = computePreview(collected, state.includeSubs);
      q('#impTypes').innerHTML = Object.entries(BUCKET_META).map(([key, meta]) => {
        const b = preview.buckets[key];
        if (!b.n) return '';                       // don't show empty buckets
        const on = state.types[key];
        return `
          <div class="imp-type ${on ? 'on' : 'off'}" data-type="${key}">
            <span class="imp-em">${meta.icon}</span>
            <div class="imp-tinfo"><div class="imp-tname">${meta.label}</div><div class="imp-texts">${extLine(b.exts)}</div></div>
            <div class="imp-count"><div class="imp-n">${b.n}</div><div class="imp-files">files</div></div>
            <span class="imp-tick">✓</span>
          </div>`;
      }).join('') || '<div class="imp-note">No supported media in this folder.</div>';
      q('#impTypes').querySelectorAll('.imp-type').forEach(el =>
        el.addEventListener('click', () => { state.types[el.dataset.type] = !state.types[el.dataset.type]; render(); }));
      q('#impIgnored').textContent = preview.ignored.n
        ? `Ignored: ${extLine(preview.ignored.exts)} — ${preview.ignored.n} file${preview.ignored.n === 1 ? '' : 's'}`
        : '';
      const files = selectedEntries();
      const bytes = files.reduce((a, f) => a + (f.size || f.file?.size || 0), 0);
      q('#impSummary').innerHTML = `<b>${files.length} file${files.length === 1 ? '' : 's'}</b> selected${bytes ? ` · ${fmtSize(bytes)}` : ''}`;
      q('#impGo').textContent = files.length ? `Add ${files.length} file${files.length === 1 ? '' : 's'}` : 'Add';
      q('#impGo').disabled = !files.length;
    }

    q('#impSubdirs').addEventListener('click', () => {
      state.includeSubs = !state.includeSubs;
      q('#impSubdirs').classList.toggle('on', state.includeSubs);
      render();
    });
    // Shares its store with the ⚙ Settings row and the live scan panel — the
    // setter is what clamps and persists, so echo its return value back.
    q('#impWorkers')?.addEventListener('change', (e) => {
      if (typeof window.vaultSetScanWorkers === 'function') {
        e.target.value = window.vaultSetScanWorkers(e.target.value);
      }
    });
    q('#impSubsJob')?.addEventListener('click', () => {
      state.subtitles = !state.subtitles;
      q('#impSubsJob').classList.toggle('on', state.subtitles);
    });
    q('#impFpJob')?.addEventListener('click', () => {
      state.fingerprint = !state.fingerprint;
      q('#impFpJob').classList.toggle('on', state.fingerprint);
    });

    const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    q('.imp-x').addEventListener('click', close);
    q('#impCancel').addEventListener('click', close);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

    q('#impGo').addEventListener('click', async () => {
      const entries = selectedEntries();
      const jobs = { subtitles: state.subtitles, fingerprint: state.fingerprint };
      close();
      const { imported } = await addPaths(entries);   // always in place (no copy)
      if (!imported.length) return;

      // Opt-in post-jobs — both are server-side queues; fire and let them drain.
      if (jobs.subtitles) {
        const av = imported.filter(r => ['video', 'audio'].includes(r.mediaType));
        if (av.length) {
          // Ask once before firing N requests: if Python/faster-whisper is
          // missing every one of them fails identically, and the user deserves
          // the explainer rather than a toast claiming work was queued.
          let ready = true;
          try {
            const pre = await (await fetch('/api/subtitles/preflight')).json();
            ready = !!pre.ok;
            if (!ready && typeof subtitlesShowPrereqModal === 'function') subtitlesShowPrereqModal(pre);
            // …and the model download needs consent before N jobs start
            // fetching 1.5 GB between them.
            // The transcription model is the one this batch definitely needs;
            // translation packs are asked for later, per language, if it turns
            // out any of these files aren't English.
            if (ready) {
              const md = await (await fetch('/api/settings/model-downloads')).json();
              const whisperKey = Object.keys(md.consents || {}).find(k => k.startsWith('whisper:'));
              const approved = md.explicit || (whisperKey && md.consents[whisperKey] === true);
              if (!approved) {
                ready = false;
                if (md.envAllows && typeof subtitlesShowModelConsent === 'function') {
                  subtitlesShowModelConsent(md.pending?.find(p => p.kind === 'whisper') || {});
                } else if (!md.envAllows) {
                  showToast('⚠ Model downloads are off — subtitles skipped');
                }
              }
            }
          } catch { /* no route (older server) — fall through and try anyway */ }
          if (ready) {
            showToast(`💬 Queueing subtitles for ${av.length} file${av.length === 1 ? '' : 's'}…`);
            await Promise.allSettled(av.map(r =>
              fetch(`/api/media/${r.id}/subtitles/generate`, { method: 'POST' })));
          }
        }
      }
      if (jobs.fingerprint) {
        const av = imported.filter(r => ['video', 'audio'].includes(r.mediaType)).map(r => r.id);
        if (av.length) {
          showToast(`🎵 Fingerprinting ${av.length} file${av.length === 1 ? '' : 's'} in the background…`);
          await fetch('/api/music/fingerprint', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: av }),
          }).catch(() => {});
        }
      }
    });

    render();
  }
  // Programmatic entry point (header button, drops, tests).
  window.openImportModal = openImportModal;

  /* ── Header buttons: 📄 Add files · 📁 Add folder ──────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    const btns = document.querySelector('.header-buttons');
    if (!btns || document.getElementById('addFolderBtn')) return;

    const folderBtn = document.createElement('button');
    folderBtn.id = 'addFolderBtn';
    folderBtn.className = 'header-btn';
    folderBtn.textContent = '📁 Add folder';
    folderBtn.title = 'Add a folder to the library — files are referenced in place, never copied';
    folderBtn.addEventListener('click', pickAndAddFolder);
    btns.insertBefore(folderBtn, btns.firstChild);

    const filesBtn = document.createElement('button');
    filesBtn.id = 'addFilesBtn';
    filesBtn.className = 'header-btn';
    filesBtn.textContent = '📄 Add files';
    filesBtn.title = 'Add individual files to the library — referenced in place, never copied';
    filesBtn.addEventListener('click', pickAndAddFiles);
    btns.insertBefore(filesBtn, btns.firstChild);
  });

  // A reload during a long scan should pick the panel back up rather than
  // leaving the run invisible until the next import.
  document.addEventListener('DOMContentLoaded', () => watchScanQueue());

  /* ── Resolved drops → add in place ─────────────────────────────────────
     resolve-drop traced the dropped items back to real on-disk paths. Loose
     files go straight to add-paths (same as the file picker); anything with
     folders opens the preview modal — each folder is scanned and loose files
     ride along at depth 0. */
  async function addResolvedDrop({ files = [], dirs = [] }) {
    if (!dirs.length) {
      await addPaths(files.map(f => ({ path: f.path, name: f.path.split(/[\\/]/).pop() || f.path })));
      return;
    }
    if (dirs.length === 1 && !files.length) { await openFolderImport(dirs[0]); return; }

    showToast('🔍 Scanning dropped folders…');
    const scans = [];
    for (const d of dirs) {
      try {
        const resp = await fetch('/api/import/scan-folder', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: d }),
        });
        const scan = await resp.json().catch(() => ({}));
        if (resp.ok) scans.push(scan);
      } catch {}
    }
    const loose = files.map(f => {
      const name = f.path.split(/[\\/]/).pop() || f.path;
      return { path: f.path, name, ext: extOf(name), size: f.size || 0, depth: 0 };
    });
    const merged = [...scans.flatMap(s => s.files), ...loose];
    if (!merged.length) { showToast('⚠ Nothing readable in the dropped items'); return; }
    openImportModal({
      mode: 'paths',
      roots: scans.map(s => s.name),
      path: `${dirs.length} folder${dirs.length === 1 ? '' : 's'} + ${loose.length} loose file${loose.length === 1 ? '' : 's'} (dropped)`,
      subdirs: scans.reduce((a, s) => a + (s.subdirs || 0), 0),
      files: merged,
    });
  }

  /* ── Drop handling ───────────────────────────────────────────────────── */
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    _depth++;
    showDropOverlay(true);
  });
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();                        // required to allow the drop
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    _depth = Math.max(0, _depth - 1);
    if (_depth === 0) showDropOverlay(false);
  });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    _depth = 0;
    showDropOverlay(false);

    // Snapshot names/sizes NOW — the DataTransfer is neutered after this tick.
    // The browser hides real paths, but the drag source's window still has the
    // dragged items selected: resolve-drop matches this payload against
    // DOpus/Explorer/desktop selections and returns the true paths.
    const files = [], dirs = [];
    for (const it of Array.from(e.dataTransfer.items || [])) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry?.();
      if (entry?.isDirectory) { dirs.push(entry.name); continue; }
      const f = it.getAsFile?.();
      if (f) files.push({ name: f.name, size: f.size });
      else if (entry?.name) files.push({ name: entry.name, size: null });
    }
    if (!files.length && !dirs.length) return;

    showToast('🔍 Tracing dropped items to their real location…');
    let r = null;
    try {
      const resp = await fetch('/api/import/resolve-drop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files, dirs }),
      });
      if (resp.ok) r = await resp.json().catch(() => null);
    } catch {}
    if (r && (r.files?.length || r.dirs?.length)) {
      await addResolvedDrop(r);
      return;
    }

    // Couldn't trace the drop (exotic source app, ambiguous match…) — fall
    // back to the native pickers, which always see real paths.
    if (dirs.length) {
      showToast('📁 Couldn\'t trace the dropped folder — confirm it in the picker');
      pickAndAddFolder();
      return;
    }
    showToast('📄 Couldn\'t trace the dropped files — pick them in the file picker');
    pickAndAddFiles();
  });
})();
