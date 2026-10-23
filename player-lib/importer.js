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
      ov.textContent = '⬇ Drop to add in place. Nothing is copied';
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

    // Classic keeps its emoji, Modern gets line icons (player-lib/icons.js).
    const sw = (emoji, name) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, name) : escapeHtml(emoji));
    const verbHtml = typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel(escapeHtml(verb)) : escapeHtml(verb);
    const failRows = () => failures.map(f =>
      `<div class="dq-row dq-failed" title="${escapeHtml(f.error)}"><span class="dq-ico">${sw('✗', 'close')}</span><span class="dq-name">${escapeHtml(f.name)}</span></div>`
    ).join('');

    return {
      update(done, name) {
        el.innerHTML = `
          <div class="dq-head">
            <span class="dq-spin"></span>
            <span class="dq-title">${verbHtml} ${done}/${total}${name ? ` · <span class="dq-file">${escapeHtml(name)}</span>` : ''}</span>
          </div>
          ${failures.length ? `<div class="dq-list">${failRows()}</div>` : ''}`;
      },
      fail(name, error) { failures.push({ name, error }); },
      finish(ok, extra) {
        clearTimeout(hideTimer);
        el.innerHTML = `
          <div class="dq-head">
            <span class="dq-title">${ok ? sw('✓', 'check') : sw('⚠', 'alert')} ${ok ? 'Added' : 'Import'} ${ok}/${total}${failures.length ? ` · ${failures.length} failed` : ''}${extra ? ` · ${escapeHtml(extra)}` : ''}</span>
            <button class="dq-x" title="Dismiss" aria-label="Dismiss">${sw('✕', 'close')}</button>
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
     panel fed by GET /api/import/queue.

     It shows for ANY scan the server is doing, whoever queued it: an import
     from this page, a watched folder, a retry, another tab. While a run is on
     screen the panel polls every 1.5 s; once the queue goes quiet it drops to
     a light count every few seconds (/api/import/queue/summary) and comes
     back the moment work appears. (It used to start only from this page's own
     imports, so files a watched folder added scanned with no panel at all.)

     Three tabs, shown once there is something on the second or third:
       Progress  the bar (done + failed), what is working, the time left
       Failed    failures grouped by reason, Retry, Show in library, Copy list
       Waiting   files held for the scan model, and why

     Classic keeps its emoji; Modern draws the same spots with line icons
     (vaultIconSwap, player-lib/icons.js). Everything degrades to silence: a
     server without the routes just never shows the panel. */

  const SCAN_POLL_MS = 1500;
  const SCAN_IDLE_POLL_MS = 4000;  // the light count while nothing is on screen
  const SCAN_MAX_FAILS = 5;        // consecutive fetch errors → assume no route
  const SCAN_MAX_IDLE = 40;        // rounds with an empty queue → back to the light count
  const CANCEL_ARM_MS = 5000;      // armed Cancel disarms itself if left alone
  const FAIL_POLL_MS = 3000;       // the Failed / Waiting lists, while one is open

  let _scanTimer = null;
  let _scanIdleTimer = null;
  let _scanBusy = false;
  let _scanFails = 0;
  let _scanIdle = 0;
  let _scanDismissed = false;    // user hid the panel; the scan keeps running
  let _scanFinishTimer = null;   // auto-dismiss of a finished panel
  let _scanLast = null;          // last readable status — what a paused poll shows
  let _scanCmdBusy = false;      // a pause/resume POST is in flight
  let _cancelArmTimer = null;    // the second half of the two-click Cancel
  let _haltNotified = 0;         // halt.at already toasted — warn once per halt
  let _waitNotified = 0;         // waiting.since already toasted
  let _scanTab = 'progress';     // which tab of the AI pane is showing
  let _scanTabPicked = false;    // the user chose it (a finish does not move them)
  let _failData = null;          // last /api/import/failures answer
  let _failAt = 0;
  let _failBusy = false;
  const _grpOpen = new Set();    // reason keys whose file list is expanded
  let _grpTouched = false;       // the user opened or closed one (stop auto-opening the first)

  /* Icons: the emoji for Classic, a line icon for Modern, side by side. */
  const ico = (emoji, name) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, name) : escapeHtml(emoji));
  const modernLook = () => (typeof vaultIsModern === 'function' && vaultIsModern());
  const AI_TAB = () => (modernLook() ? 'AI scan' : '🤖 AI scan');
  const n0 = (v) => Number(v) || 0;
  const fmtN = (v) => n0(v).toLocaleString();
  const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : (many || one + 's')}`;
  const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

  /* ── Instances in the scan panel ─────────────────────────────────────────
     Several copies of one model can be loaded in LM Studio, and the server
     spreads scans over all of them. The panel says how many are actually
     pulling, because the answer to "why is this slow" is usually a copy that
     quietly unloaded, not the worker count. The strip only appears when there
     is something to say: two or more instances. */

  // Same sentence as the Backend tab's stepper (player-lib/settings.js), for
  // the same reason: more workers is the wrong instinct.
  const WORKERS_TIP = 'A second worker removes the idle gap between files. '
    + 'More than 2 adds little; extra instances are what multiply throughput.';

  /** "about 6 min left", or '' with nothing honest to say. */
  function fmtLeft(ms) {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
    if (ms < 60000) return 'under a minute left';
    if (ms < 3600000) return `about ${Math.round(ms / 60000)} min left`;
    return `about ${(ms / 3600000).toFixed(1)} h left`;
  }

  /* ── One panel, two jobs ────────────────────────────────────────────────
     #scanQueuePanel also carries the face checks (player-lib/faces.js). Each
     job owns a pane; with both running a tab row picks which one shows, with
     one the tab row goes away and that pane is the whole panel. The panel
     itself goes when its last pane does. faces.js reaches this through
     window.vaultScanPane. */
  const PANES = { ai: 'scanAiPane', faces: 'scanFacesPane' };
  const _panes = new Map();      // name -> { tab, sub }
  let _paneOn = null;

  function scanShell() {
    let el = document.getElementById('scanQueuePanel');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'scanQueuePanel';
    el.className = 'delete-queue';
    el.innerHTML = `
      <div class="dq-tabs" role="tablist" aria-label="Running scans" hidden></div>
      <div class="dq-pane" id="scanAiPane" role="tabpanel" hidden></div>
      <div class="dq-pane" id="scanFacesPane" role="tabpanel" hidden></div>`;
    el.querySelector('.dq-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pane]');
      if (!b) return;
      _paneOn = b.dataset.pane;
      paintShell();
    });
    queuePanelStack().appendChild(el);
    return el;
  }

  /** Tabs and pane visibility. The tab buttons are rebuilt only when the set of panes changes. */
  function paintShell() {
    const el = document.getElementById('scanQueuePanel');
    if (!el) return;
    const names = Object.keys(PANES).filter(n => _panes.has(n));
    if (!_panes.has(_paneOn)) _paneOn = names[0] || null;
    const tabs = el.querySelector('.dq-tabs');
    const many = names.length > 1;
    tabs.hidden = !many;
    if (!many) { tabs.innerHTML = ''; delete tabs.dataset.names; }
    else {
      if (tabs.dataset.names !== names.join()) {
        tabs.dataset.names = names.join();
        tabs.innerHTML = names.map(n => `<button type="button" class="dq-tab" role="tab" data-pane="${n}">`
          + '<span class="dq-tab-name"></span><span class="dq-tab-sub"></span></button>').join('');
      }
      tabs.querySelectorAll('[data-pane]').forEach(b => {
        const p = _panes.get(b.dataset.pane);
        const on = b.dataset.pane === _paneOn;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
        b.querySelector('.dq-tab-name').textContent = p.tab || '';
        b.querySelector('.dq-tab-sub').textContent = p.sub || '';
      });
    }
    for (const [n, id] of Object.entries(PANES)) {
      const pane = document.getElementById(id);
      if (pane) pane.hidden = !_panes.has(n) || n !== _paneOn;
    }
    el.classList.toggle('dq-has-tabs', many);
  }

  /**
   * Show a pane (creating the panel if needed) and set its tab label.
   * `focus` brings it to the front: a job the user just started.
   * @returns the pane element
   */
  function openPane(name, { tab = '', sub = '', focus = false } = {}) {
    const el = scanShell();
    _panes.set(name, { tab, sub });
    if (focus) _paneOn = name;
    paintShell();
    el.classList.add('visible');
    return document.getElementById(PANES[name]);
  }

  /** Take a pane away; the panel goes with its last pane. */
  function dropPane(name) {
    _panes.delete(name);
    const pane = document.getElementById(PANES[name]);
    if (pane) { pane.innerHTML = ''; pane.hidden = true; }
    if (!_panes.size) {
      document.getElementById('scanQueuePanel')?.remove();
      _paneOn = null;
      return;
    }
    paintShell();
  }

  window.vaultScanPane = {
    open: openPane,
    drop: dropPane,
    has: (name) => _panes.has(name),
    count: () => _panes.size,
  };

  /** The AI scan's pane while it is showing, else null. */
  function scanAiPane() {
    return _panes.has('ai') ? document.getElementById('scanAiPane') : null;
  }

  function scanPanelEl() {
    // A new run inside the auto-dismiss window reuses this element — drop the
    // pending removal or it yanks the panel out from under the live run.
    clearTimeout(_scanFinishTimer);
    _scanFinishTimer = null;

    let el = scanAiPane();
    if (el && el.querySelector('#scanHead')) return el;
    el = openPane('ai', { tab: AI_TAB() });
    _scanTab = 'progress';
    _scanTabPicked = false;
    // The bar fill, the worker stepper and the action buttons live outside the
    // re-rendered regions: rebuilding the fill every round would restart its CSS
    // transition, rebuilding the input would swallow half-typed digits (the
    // element is gone before it can fire `change`), and rebuilding the buttons
    // would wipe the armed half of the two-click Cancel every 1.5s — the poll
    // would disarm it faster than anyone can click twice.
    el.innerHTML = `
      <div class="dq-head sp-head" id="scanHead">
        <span class="sp-head-ico" id="scanHeadIco"></span>
        <b class="sp-head-title">AI scan</b>
        <span class="sp-head-sub" id="scanHeadSub"></span>
        <span class="sp-grow"></span>
        <button type="button" class="dq-x sp-close" id="scanCloseBtn" title="Close" aria-label="Close" hidden>${ico('✕', 'close')}</button>
      </div>
      <div class="sp-tabs" id="scanTabs" role="tablist" aria-label="AI scan" hidden>
        <button type="button" class="sp-tab" role="tab" data-scan-tab="progress">Progress</button>
        <button type="button" class="sp-tab" role="tab" data-scan-tab="failed">Failed <span class="sp-tab-n" id="scanTabFailedN"></span></button>
        <button type="button" class="sp-tab" role="tab" data-scan-tab="waiting">Waiting <span class="sp-tab-n" id="scanTabWaitingN"></span></button>
      </div>
      <div class="sp-view" id="scanViewProgress" role="tabpanel">
        <div class="dq-bar sp-bar"><div class="dq-bar-fill" id="scanBarFill"></div><div class="sp-bar-fail" id="scanBarFail"></div></div>
        <div class="dq-meta" id="scanMeta">
          <span class="dq-eta sp-line" id="scanEta"></span>
          <span class="dq-workers" title="${WORKERS_TIP}">${ico('🤖', 'spark')} <input type="number" min="1" max="4" step="1"
            class="dq-num" id="scanWorkersNum" data-scan-workers aria-label="Workers per instance"
            title="${WORKERS_TIP}"></span>
        </div>
        <div class="sp-waitline" id="scanWaitLine" hidden></div>
        <div class="dq-inst" id="scanInst" hidden></div>
        <div class="dq-notice" id="scanNotice" hidden></div>
        <div class="dq-warn" id="scanWarn" hidden></div>
        <div class="dq-list sp-now-list" id="scanList"></div>
      </div>
      <div class="sp-view" id="scanViewFailed" role="tabpanel" hidden>
        <div class="sp-groups" id="scanGroups"></div>
        <div class="sp-foot" id="scanFailFoot">
          <button type="button" class="dq-btn dq-btn-primary" id="scanRetryAll">${ico('↻ ', 'rescan')}<span class="sp-retry-label">Retry all</span></button>
          <button type="button" class="dq-btn" id="scanShowFailed" title="Show every file whose scan failed in the library (the Scan: Failed filter)">${ico('🔍 ', 'filter')}Show in library</button>
          <button type="button" class="dq-btn dq-btn-ghost" id="scanCopyList" title="Copy each failed file's path and reason as text">${ico('📋 ', 'copy')}Copy list</button>
        </div>
      </div>
      <div class="sp-view" id="scanViewWaiting" role="tabpanel" hidden>
        <div class="sp-wait" id="scanWaitBox"></div>
        <div class="sp-foot">
          <button type="button" class="dq-btn dq-btn-primary" id="scanPickAgain" hidden>Pick a model that can read pictures</button>
          <button type="button" class="dq-btn" id="scanLoadAnyway" title="Load the scan model in LM Studio now, even if Vault thinks there is not enough room">Load anyway</button>
          <button type="button" class="dq-btn dq-btn-ghost" id="scanOpenLms">Open LM Studio</button>
          <button type="button" class="dq-btn dq-btn-ghost" id="scanOpenSettings">${ico('⚙ ', 'gear')}Settings</button>
        </div>
        <div class="dq-list sp-wait-list" id="scanWaitList"></div>
      </div>
      <div class="dq-actions" id="scanActions">
        <button type="button" class="dq-btn dq-btn-quiet" id="scanHideBtn"
          title="Hide this panel. The scan keeps running in the background">Hide</button>
        <button type="button" class="dq-btn" id="scanPauseBtn"></button>
        <button type="button" class="dq-btn dq-btn-danger" id="scanCancelBtn">Cancel</button>
      </div>`;
    el.querySelector('#scanWorkersNum').addEventListener('change', (e) => {
      if (typeof window.vaultSetScanWorkers === 'function') {
        e.target.value = window.vaultSetScanWorkers(e.target.value);
      }
    });
    el.querySelector('#scanPauseBtn').addEventListener('click', onPauseClick);
    el.querySelector('#scanCancelBtn').addEventListener('click', onCancelClick);
    // Hide keeps polling: a halt still toasts through a hidden panel.
    el.querySelector('#scanHideBtn').addEventListener('click', () => {
      _scanDismissed = true;
      dropPane('ai');
    });
    el.querySelector('#scanCloseBtn').addEventListener('click', closeFinished);
    el.querySelector('#scanTabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-scan-tab]');
      if (!b) return;
      _scanTabPicked = true;
      setScanTab(b.dataset.scanTab);
    });
    el.querySelector('#scanGroups').addEventListener('click', onGroupsClick);
    el.querySelector('#scanRetryAll').addEventListener('click', () => retryFailed(null));
    el.querySelector('#scanShowFailed').addEventListener('click', showFailedInLibrary);
    el.querySelector('#scanCopyList').addEventListener('click', copyFailedList);
    el.querySelector('#scanLoadAnyway').addEventListener('click', loadAnyway);
    el.querySelector('#scanPickAgain').addEventListener('click', async () => {
      try {
        await fetch('/api/ai/model-choice', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: null, kind: 'vision' }),
        });
        watchScanQueue();
      } catch (err) { showToast('⚠ ' + err.message); }
    });
    el.querySelector('#scanOpenLms').addEventListener('click', openLmStudio);
    el.querySelector('#scanOpenSettings').addEventListener('click', () => {
      if (typeof window.vaultOpenSettings === 'function') window.vaultOpenSettings('models');
    });
    return el;
  }

  /** Switch the AI pane's tab, and fetch the lists it needs. */
  function setScanTab(tab) {
    const el = scanAiPane();
    if (!el) return;
    _scanTab = tab;
    el.querySelectorAll('[data-scan-tab]').forEach(b => {
      const on = b.dataset.scanTab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    el.querySelector('#scanViewProgress').hidden = tab !== 'progress';
    el.querySelector('#scanViewFailed').hidden = tab !== 'failed';
    el.querySelector('#scanViewWaiting').hidden = tab !== 'waiting';
    if (tab !== 'progress') loadFailures(true);
  }

  /* ── Failed and Waiting lists ───────────────────────────────────────────
     One request feeds both (GET /api/import/failures): the failure groups,
     a few files each, and the files waiting for the model. Fetched while one
     of those tabs is open, at most every FAIL_POLL_MS. */
  async function loadFailures(force = false) {
    if (_failBusy) return;
    if (!force && Date.now() - _failAt < FAIL_POLL_MS) return;
    _failBusy = true;
    try {
      const resp = await fetch('/api/import/failures?sample=5', { headers: { 'X-Vault-Background': '1' } });
      if (!resp.ok) return;
      _failData = await resp.json();
      _failAt = Date.now();
      renderFailed();
      renderWaiting(_scanLast);
    } catch { /* the next tick tries again */ } finally {
      _failBusy = false;
    }
  }

  function renderFailed() {
    const el = scanAiPane();
    if (!el) return;
    const box = el.querySelector('#scanGroups');
    const f = _failData && _failData.failed;
    const groups = (f && f.groups) || [];
    const total = n0(f && f.total);
    el.querySelector('#scanRetryAll .sp-retry-label').textContent = total ? `Retry all ${fmtN(total)}` : 'Retry all';
    el.querySelector('#scanRetryAll').disabled = !total;
    el.querySelector('#scanCopyList').disabled = !total;
    if (!_grpTouched && groups.length && !_grpOpen.size) _grpOpen.add(groups[0].key);
    // Rebuilt only when the answer changes: buttons under the cursor survive the poll.
    const sig = JSON.stringify([groups, [..._grpOpen]]);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (!groups.length) {
      box.innerHTML = '<div class="sp-empty">Nothing failed in this run.</div>';
      return;
    }
    box.innerHTML = groups.map(g => {
      const open = _grpOpen.has(g.key);
      const more = g.count - g.sample.length;
      return `<div class="sp-grp${open ? ' open' : ''}" data-grp="${escapeHtml(g.key)}">
        <div class="sp-grp-head">
          <button type="button" class="sp-grp-toggle" data-grp-toggle aria-expanded="${open}">
            <span class="sp-grp-label">${escapeHtml(g.label)}</span> <span class="sp-grp-n">(${fmtN(g.count)})</span>
            <span class="sp-chev">${ico('▾', 'chevron')}</span>
          </button>
          <button type="button" class="dq-btn sp-mini" data-grp-retry title="Queue these ${fmtN(g.count)} files for another scan">${ico('↻ ', 'rescan')}Retry</button>
        </div>
        <div class="sp-grp-explain">${escapeHtml(g.explain)}</div>
        <div class="sp-files"${open ? '' : ' hidden'}>
          ${g.sample.map(s => `<div class="sp-file" title="${escapeHtml(s.error)}">
              <span class="dq-name">${escapeHtml(s.filename)}</span>
              <span class="sp-folder" title="${escapeHtml(s.folder)}">${escapeHtml(s.folder)}</span>
              <button type="button" class="dq-x sp-file-btn" data-force-refresh="${n0(s.id)}"
                title="Force refresh: read this file again and remake its thumbnail, without redoing the AI scan"
                aria-label="Force refresh ${escapeHtml(s.filename)}">${ico('🔄', 'refresh')}</button>
            </div>`).join('')}
          ${more > 0 ? `<div class="sp-more">and ${fmtN(more)} more</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function onGroupsClick(e) {
    const grp = e.target.closest('[data-grp]');
    if (!grp) return;
    const key = grp.dataset.grp;
    if (e.target.closest('[data-grp-toggle]')) {
      _grpTouched = true;
      if (_grpOpen.has(key)) _grpOpen.delete(key); else _grpOpen.add(key);
      renderFailed();
      return;
    }
    if (e.target.closest('[data-grp-retry]')) { retryFailed(key); return; }
    const fr = e.target.closest('[data-force-refresh]');
    if (fr) forceRefreshIds([Number(fr.dataset.forceRefresh)], fr);
  }

  async function retryFailed(key) {
    try {
      const resp = await fetch('/api/import/failures/retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key ? { reason: key } : {}),
      });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok) { showToast('⚠ ' + (r.error || `HTTP ${resp.status}`)); return; }
      const notes = [];
      if (r.alreadyQueued) notes.push(`${fmtN(r.alreadyQueued)} already queued`);
      if (r.missing) notes.push(`${fmtN(r.missing)} missing from disk`);
      showToast(r.queued
        ? `↻ Queued ${plural(r.queued, 'file')} for another scan${notes.length ? ` · ${notes.join(', ')}` : ''}`
        : (notes.length ? `Nothing new to queue: ${notes.join(', ')}` : 'Nothing to retry'));
      _scanTabPicked = false;
      _failAt = 0;
      if (r.queued) { setScanTab('progress'); watchScanQueue(); }
      else loadFailures(true);
    } catch (err) {
      showToast('⚠ ' + err.message);
    }
  }

  /** The library's Scan: Failed filter: every failed file, not only this run's. */
  function showFailedInLibrary() {
    if (typeof switchTab === 'function' && typeof currentTab !== 'undefined' && currentTab !== 'library') switchTab('library');
    if (typeof setTriFilterValue !== 'function' || typeof applyFilters !== 'function') return;
    setTriFilterValue('filterScanStatus', 'failed');
    applyFilters();
    showToast('🔍 Showing files whose scan failed');
  }

  async function copyFailedList() {
    try {
      const resp = await fetch('/api/import/failures/text');
      if (!resp.ok) { showToast(`⚠ HTTP ${resp.status}`); return; }
      const text = await resp.text();
      if (!text) { showToast('Nothing to copy'); return; }
      const n = text.split(/\r?\n/).length;
      if (await copyText(text)) {
        showToast(`📋 Copied ${plural(n, 'file')} with their reasons`);
        return;
      }
      // The clipboard said no (no permission, or the page lost focus while the
      // list was fetched): hand the list over as a text file instead.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = 'vault-failed-scans.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      showToast(`📋 The clipboard was not available, so the list of ${plural(n, 'file')} was saved as a text file`);
    } catch (err) {
      showToast('⚠ Could not copy: ' + err.message);
    }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* try the old way */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch { return false; }
  }

  /**
   * Force refresh (also from the sidebar and the selection bar, through
   * window.vaultForceRefresh): read the files again and remake their
   * thumbnails, without redoing the AI scan.
   */
  async function forceRefreshIds(ids, btn, { onlyErrored = false } = {}) {
    const list = (ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!list.length) return null;
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch('/api/media/force-refresh', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(onlyErrored ? { ids: list, onlyErrored: true } : { ids: list }),
      });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok) { showToast('⚠ ' + (r.error || `HTTP ${resp.status}`)); return null; }
      if (r.started) {
        showToast(`🔄 Reading ${plural(r.count, 'file')} again in the background`);
        return r;
      }
      for (const row of (r.rows || [])) {
        try { if (typeof getMediaById === 'function' && getMediaById(row.id)) Library.patchRow(row); } catch {}
      }
      const ok = (r.refreshed || []).length, bad = (r.stillBroken || []).length, gone = (r.missing || []).length;
      const parts = [];
      if (ok) parts.push(`${plural(ok, 'file')} read again`);
      if (r.queued && r.queued.length) parts.push(`${fmtN(r.queued.length)} queued for their first AI scan`);
      if (bad) parts.push(r.noProbe ? `${fmtN(bad)} not checked (ffmpeg is not installed)` : `${fmtN(bad)} still cannot be read`);
      if (gone) parts.push(`${fmtN(gone)} missing from disk`);
      showToast(`${bad || gone ? '⚠' : '🔄'} ${parts.join(' · ') || 'Nothing to refresh'}`);
      _failAt = 0;
      if (scanAiPane()) loadFailures(true);
      if (r.queued && r.queued.length) watchScanQueue();
      if (typeof refreshInfoSurfaces === 'function' && list.length === 1 && typeof getMediaById === 'function') {
        const m = getMediaById(list[0]);
        if (m) refreshInfoSurfaces(m);
      }
      return r;
    } catch (err) {
      showToast('⚠ ' + err.message);
      return null;
    } finally {
      if (btn && btn.isConnected) btn.disabled = false;
    }
  }
  window.vaultForceRefresh = forceRefreshIds;

  async function loadAnyway(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const resp = await fetch('/api/ai/scan-model/load', { method: 'POST' });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok) { showToast('⚠ ' + (r.error || `HTTP ${resp.status}`)); return; }
      showToast(r.ok ? '⬆ Loading the scan model in LM Studio' : `⚠ ${(r.wait && r.wait.reason) || 'Could not load the scan model'}`);
      watchScanQueue();
    } catch (err) {
      showToast('⚠ ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function openLmStudio() {
    try {
      const resp = await fetch('/api/ai/open-lmstudio', { method: 'POST' });
      const r = await resp.json().catch(() => ({}));
      showToast(resp.ok ? 'Opening LM Studio' : '⚠ ' + (r.error || `HTTP ${resp.status}`));
    } catch (err) {
      showToast('⚠ ' + err.message);
    }
  }

  /** The Waiting tab and the one-line wait note on Progress. */
  function renderWaiting(q) {
    const el = scanAiPane();
    if (!el) return;
    const w = (q && q.waiting) || null;
    const detail = _failData && _failData.waiting;
    const box = el.querySelector('#scanWaitBox');
    const line = el.querySelector('#scanWaitLine');
    if (!w) {
      box.innerHTML = '<div class="sp-empty">Nothing is waiting.</div>';
      el.querySelector('#scanWaitList').innerHTML = '';
      line.hidden = true;
      line.innerHTML = '';
      el.querySelector('#scanLoadAnyway').hidden = true;
      return;
    }
    // "Load anyway" only where it can do something (a scan model to load, and
    // Vault able to load models here).
    el.querySelector('#scanLoadAnyway').hidden = !w.loadable;
    // A text model picked for pictures: offer to pick again (it clears the pick,
    // and the next picture asks "which model?" with only vision models listed).
    el.querySelector('#scanPickAgain').hidden = !w.pickAgain;
    const pill = `<span class="sp-pill"><span class="sp-dot sp-dot-amber"></span>${w.gpuBusy ? 'Waiting for the GPU to be free' : (w.code === 'loading' ? 'Loading the scan model' : 'Waiting for the scan model')}</span>`;
    const html = `${pill}<div class="sp-reason">${escapeHtml(w.reason || '')}</div>`;
    if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
    line.hidden = false;
    // Some files still running: say how many are held, and why on the tab.
    const heldBit = q && !q.paused ? `<span class="sp-held">${plural(n0(w.count), 'file')} held</span> ` : '';
    const lineHtml = `${heldBit}${pill} <button type="button" class="sp-link" data-scan-tab-go="waiting">Why?</button>`;
    if (line.dataset.sig !== lineHtml) {
      line.dataset.sig = lineHtml;
      line.innerHTML = lineHtml;
      line.querySelector('[data-scan-tab-go]').addEventListener('click', () => { _scanTabPicked = true; setScanTab('waiting'); });
    }
    const sample = (detail && detail.sample) || [];
    const more = n0(w.count) - sample.length;
    const list = sample.map(s => `<div class="dq-row"><span class="dq-ico">${ico('⏳', 'clock')}</span>`
      + `<span class="dq-name">${escapeHtml(s.filename || '')}</span>`
      + `<span class="sp-folder" title="${escapeHtml(s.folder || '')}">${escapeHtml(s.watchFolder ? `from ${baseName(s.watchFolder)}` : baseName(s.folder))}</span></div>`).join('')
      + (more > 0 && sample.length ? `<div class="sp-more">and ${fmtN(more)} more</div>` : '');
    const wl = el.querySelector('#scanWaitList');
    if (wl.dataset.sig !== list) { wl.dataset.sig = list; wl.innerHTML = list; }
  }

  /* ── ⏸ Pause / ▶ Resume ─────────────────────────────────────────────────
     Pausing stops dispatch only — whatever is already mid-scan finishes, since
     a vision call can't be torn down cleanly. Resuming asks the server to
     probe the endpoint first, so "I loaded the wrong model" comes back as a
     warning instead of an instant re-pause. On a wait, Resume reads "Try now":
     it sends the next file whatever the check says. */
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
      else if (resuming && q && q.pausedBy === 'waiting' && q.waiting) showToast('⚠ Nothing could start: ' + q.waiting.reason);
      else showToast(resuming ? '▶ Scanning resumed' : '⏸ Scan paused. Files already running will finish');
      if (q) _scanLast = q;
      // The watcher may have given up while the queue sat halted; a resume needs
      // it back to follow the run.
      if (resuming) watchScanQueue();
    } catch (err) {
      showToast('⚠ ' + err.message);
    } finally {
      _scanCmdBusy = false;
      if (_scanLast && scanAiPane()) renderScanPanel(_scanLast);
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

  /* ── Two-click Cancel ───────────────────────────────────────────────────
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
        ? `✕ Scan cancelled: ${r.dropped} queued file${r.dropped === 1 ? '' : 's'} dropped${still}`
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
      dropPane('ai');
    }
  }

  /** The close button on a finished panel: the failure list goes with it. */
  function closeFinished() {
    fetch('/api/import/failures/clear', { method: 'POST' }).catch(() => {});
    _failData = null;
    _grpOpen.clear();
    _grpTouched = false;
    dropPane('ai');
  }

  /* ── "Which model?" halt → inline picker ────────────────────────────────
     LM Studio only ignores the `model` field while ONE model is loaded; load a
     second (the setup guide's embedding model does it) and every scan request
     comes back 400 until one is named. The queue halts with pausedBy ===
     'model-choice' — a question, not a breakage — so instead of "load the model
     and press Resume" the panel asks it directly.

     Built ONCE per halt (keyed on halt.at): the 1.5s poll re-renders this panel
     constantly, and rebuilding a <select> under the user's cursor would reset
     their choice every round — the same reason the worker stepper lives outside
     the re-rendered regions. */
  function renderModelChoice(warn, q) {
    const at = String(q.halt?.at || 0) + (q.halt?.kind || '');
    if (warn.dataset.pickerAt === at) return;
    warn.dataset.pickerAt = at;
    warn.hidden = false;
    // Asked per kind of file: pictures and videos only get models that can
    // read pictures; documents and audio may use any model.
    const vision = q.halt?.kind !== 'plain';
    const kind = vision ? 'vision' : 'text';
    warn.innerHTML = `<b>${vision ? 'Which model should scan pictures and videos?' : 'Which model should read documents?'}</b> LM Studio has several models loaded.
      <div class="dq-pick">
        <select class="dq-pick-sel" id="scanModelSelect" disabled><option>Loading…</option></select>
        <button type="button" class="dq-btn dq-btn-primary" id="scanModelGo" disabled>Use this model</button>
      </div>`
      + `<div class="dq-warn-at">Copies of the same model are one choice. Vault uses all of them.</div>`
      + (q.halt.filename ? `<div class="dq-warn-at">stopped at ${escapeHtml(q.halt.filename)}</div>` : '')
      + `<div class="dq-warn-at">Nothing was lost. The scan carries on from here. Pick a scan model in Settings to skip this next time.</div>`;

    const sel = warn.querySelector('#scanModelSelect');
    const go = warn.querySelector('#scanModelGo');

    (async () => {
      let data = null;
      try {
        const resp = await fetch('/api/ai/models');
        if (resp.ok) data = await resp.json();
      } catch {}
      // The panel may have been rebuilt (or the halt cleared) while this was in
      // flight — bail rather than writing into a detached node.
      if (!sel.isConnected) return;
      // Families, not raw ids: three loaded copies of one model are ONE
      // choice, and listing them separately would show three near-identical
      // rows for what is really a single decision. Older servers send no
      // `families`, so the flat model list stays the fallback.
      const families = ((data && data.families) || []).filter(f => !vision || f.vision !== false);
      const models = vision && (data && data.families || []).length ? [] : ((data && data.models) || []);
      if (!families.length && !models.length) {
        sel.innerHTML = `<option>${escapeHtml(data?.error || (vision ? 'No model that can read pictures is loaded' : 'No models reported'))}</option>`;
        return;
      }
      // Never pre-select something that is not on the list (a text model for
      // a pictures question).
      const listed = new Set(families.map(f => f.family).concat(models.map(m => m.id)));
      const current = listed.has(data.current) ? data.current : null;
      sel.innerHTML = families.length
        ? families.map(f => {
          const n = Number(f.count) || 1;
          return `<option value="${escapeHtml(f.family)}"${f.family === current ? ' selected' : ''}>`
            + `${escapeHtml(f.family)} · ${n} instance${n === 1 ? '' : 's'}</option>`;
        }).join('')
        : models.map(m =>
          `<option value="${escapeHtml(m.id)}"${m.id === current ? ' selected' : ''}>${escapeHtml(m.id)}</option>`
        ).join('');
      sel.disabled = false;
      go.disabled = false;
    })();

    go.addEventListener('click', async () => {
      const model = sel.value;
      if (!model) return;
      go.disabled = true;
      sel.disabled = true;
      try {
        const resp = await fetch('/api/ai/model-choice', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, kind }),
        });
        const r = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          showToast('⚠ ' + (r.error || `HTTP ${resp.status}`));
          go.disabled = false; sel.disabled = false;
          return;
        }
        showToast(`▶ Scanning with ${model}`);
        delete warn.dataset.pickerAt;      // next halt gets a fresh picker
        watchScanQueue();                  // the watcher may have given up while halted
      } catch (err) {
        showToast('⚠ ' + err.message);
        go.disabled = false; sel.disabled = false;
      }
    });
  }

  /* Notices the user has closed, by id. In memory only: it is about one run in
     one tab, and a dismissal worth remembering past a reload would be a
     dismissal worth not showing at all. */
  const _noticeClosed = new Set();

  /**
   * A copy went away and the run carried on. Not a halt and no picker, but it
   * explains why the strip is one line shorter and the time left just moved,
   * so it gets a line of its own, with a close button because the same panel
   * repaints every 1.5 s and a line you cannot get rid of wears out fast.
   *
   * Rebuilt only when the id changes: re-running innerHTML every tick would
   * throw away the button the user is reaching for.
   */
  function renderScanNotice(el, notice) {
    const line = el.querySelector('#scanNotice');
    if (!line) return;
    const id = notice && notice.id ? String(notice.id) : '';
    const text = notice && notice.text ? String(notice.text) : '';
    if (!text || (id && _noticeClosed.has(id))) {
      line.hidden = true;
      line.innerHTML = '';
      delete line.dataset.noticeId;
      return;
    }
    if (line.dataset.noticeId === id && !line.hidden) return;
    line.dataset.noticeId = id;
    line.hidden = false;
    line.innerHTML = `<span class="dq-notice-text">${escapeHtml(text)}</span>`
      + `<button type="button" class="dq-x dq-notice-x" title="Dismiss" aria-label="Dismiss">${ico('✕', 'close')}</button>`;
    line.querySelector('.dq-notice-x').addEventListener('click', () => {
      if (id) _noticeClosed.add(id);
      line.hidden = true;
      line.innerHTML = '';
    });
  }

  /** The tab row: shown once Failed or Waiting has something in it. */
  function paintScanTabs(el, failed, waiting) {
    const tabs = el.querySelector('#scanTabs');
    const show = failed > 0 || waiting > 0;
    tabs.hidden = !show;
    el.querySelector('#scanTabFailedN').textContent = `(${fmtN(failed)})`;
    el.querySelector('#scanTabWaitingN').textContent = `(${fmtN(waiting)})`;
    // A tab that has just emptied (the wait cleared, the failures were
    // retried) gives way to one that still has something to say.
    if (!show && _scanTab !== 'progress') setScanTab('progress');
    else if (_scanTab === 'waiting' && !waiting) setScanTab(failed ? 'failed' : 'progress');
    else if (_scanTab === 'failed' && !failed) setScanTab(waiting ? 'waiting' : 'progress');
    else el.querySelectorAll('[data-scan-tab]').forEach(b => b.classList.toggle('on', b.dataset.scanTab === _scanTab));
  }

  function renderScanPanel(q) {
    const el = scanPanelEl();

    const done = n0(q.done), failed = n0(q.failed), total = n0(q.total);
    const waiting = q.waiting ? n0(q.waiting.count) : 0;
    const left = Math.max(0, total - done - failed);
    openPane('ai', { tab: AI_TAB(), sub: waiting ? `${fmtN(waiting)} waiting` : `${fmtN(left)} left` });
    const by = q.paused ? (q.pausedBy || 'user') : null;
    // Instance counts, if the server reports them. The server only reports
    // copies that are loaded; a copy that goes simply leaves the strip, and
    // the notice line says it happened.
    const insts = Array.isArray(q.instances) ? q.instances : [];
    const liveInsts = insts.filter(i => i.enabled);

    // Head: what is going on, in a few words.
    const sub = {
      vault: 'paused (vault locked)',
      user: 'paused',
      model: 'paused (model unavailable)',
      'model-choice': 'pick a model',
      waiting: `${fmtN(waiting)} waiting`,
    }[by] || `${fmtN(done + failed)} of ${fmtN(total)}`;
    el.querySelector('#scanHeadSub').textContent = `· ${sub}`;
    const icoEl = el.querySelector('#scanHeadIco');
    const icoKey = by ? (by === 'waiting' || by === 'model' || by === 'model-choice' ? 'wait' : 'pause') : 'run';
    if (icoEl.dataset.k !== icoKey) {
      icoEl.dataset.k = icoKey;
      icoEl.innerHTML = icoKey === 'run' ? `<span class="dq-spin"></span>`
        : icoKey === 'wait' ? `<span class="sp-dot sp-dot-amber"></span>` : ico('⏸', 'pause');
    }
    el.querySelector('#scanCloseBtn').hidden = true;

    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    const fpct = total ? Math.min(100 - pct, (failed / total) * 100) : 0;
    el.querySelector('#scanBarFill').style.width = `${pct}%`;
    el.querySelector('#scanBarFail').style.width = `${fpct}%`;

    paintScanTabs(el, failed, waiting);

    // "Which model?" is the one stop that still needs a person.
    const warn = el.querySelector('#scanWarn');
    // The question shows even while the other kind of file is running.
    if (q.halt && q.halt.needsModelChoice) {
      renderModelChoice(warn, q);
    } else if (by === 'model' && q.halt) {
      delete warn.dataset.pickerAt;
      warn.hidden = false;
      warn.innerHTML = `<b>Model unavailable</b>: ${escapeHtml(q.halt.reason || '')}`
        + `<div class="dq-warn-at">Nothing was lost. Load the model, then press Resume.</div>`;
    } else {
      delete warn.dataset.pickerAt;
      warn.hidden = true;
      warn.innerHTML = '';
    }

    // Pause / Resume. A vault lock isn't ours to clear, so the button steps
    // aside rather than pretending it can. On a wait it reads "Try now".
    const pauseBtn = el.querySelector('#scanPauseBtn');
    const resuming = !!q.paused;
    const mode = resuming ? 'resume' : 'pause';
    const label = !resuming ? 'pause' : (by === 'waiting' ? 'try' : 'resume');
    pauseBtn.dataset.mode = mode;
    if (pauseBtn.dataset.label !== label) {
      pauseBtn.dataset.label = label;
      pauseBtn.innerHTML = label === 'pause' ? `${ico('⏸ ', 'pause')}Pause`
        : label === 'try' ? `${ico('▶ ', 'play')}Try now` : `${ico('▶ ', 'play')}Resume`;
    }
    pauseBtn.classList.toggle('dq-btn-primary', resuming && by !== 'vault' && by !== 'waiting');
    pauseBtn.disabled = _scanCmdBusy || by === 'vault';
    // Nothing can start while the only model cannot read pictures: Try now
    // would only say "resumed" and do nothing.
    pauseBtn.hidden = by === 'waiting' && q.waiting && q.waiting.code === 'not-vision';
    pauseBtn.title = by === 'vault'
      ? 'The vault is locked. Unlock it to carry on scanning'
      : by === 'waiting' ? 'Send the next file now, even though the scan model does not look ready'
        : resuming ? 'Start scanning again from where it stopped'
          : 'Stop starting new files. Anything mid-scan still finishes';

    el.querySelector('#scanActions').hidden = false;
    el.querySelector('#scanMeta').hidden = false;
    // "2 working · about 6 min left · minicpm-v-4.6 (2 copies)"
    const working = (q.active || []).length;
    const bits = [];
    if (by === 'waiting') bits.push('Nothing is scanning');
    else if (by) bits.push('Paused');
    else if (q.starting && !working) bits.push('Starting');
    else bits.push(`${fmtN(working)} working`);
    const leftText = fmtLeft(q.etaMs);
    if (!by && leftText) bits.push(leftText);
    const copies = n0(q.model && q.model.copies) || liveInsts.length;
    if (q.model && q.model.name) bits.push(`${q.model.name}${copies > 1 ? ` (${copies} copies)` : ''}`);
    el.querySelector('#scanEta').textContent = bits.join(' · ');

    renderWaiting(q);

    // The per-instance strip: one line each, only when it earns its space.
    const strip = el.querySelector('#scanInst');
    const showStrip = liveInsts.length >= 2;
    strip.hidden = !showStrip;
    strip.innerHTML = !showStrip ? '' : insts.map(i => {
      const text = i.enabled
        ? `${Number(i.inFlight) || 0} in flight · ${Number(i.done) || 0} done`
        : 'parked';
      return `<div class="dq-inst-row">`
        + `<span class="sp-dot ${i.enabled ? 'sp-dot-ok' : 'sp-dot-off'}"></span>`
        + `<span class="dq-inst-id">${escapeHtml(i.suffix || ':1')}</span>`
        + `<span>${text}</span></div>`;
    }).join('');

    renderScanNotice(el, q.notice);
    // Mid-edit is sacred: a poll landing between keystrokes must not rewrite
    // what the user is typing. Workers PER INSTANCE, which is what this
    // stepper sets.
    const num = el.querySelector('#scanWorkersNum');
    const workers = String(q.workersPerInstance
      || (window.vaultScanWorkers ? window.vaultScanWorkers() : 2));
    if (document.activeElement !== num && num.value !== workers) num.value = workers;

    // .dq-name is already blurred under body.privacy-mode (css/settings.css).
    // "Now: file" and, for a watched folder, which one. The slot suffix says
    // WHICH copy of the model has this file.
    el.querySelector('#scanList').innerHTML = (q.active || []).map((a, i) => {
      const slot = a.suffix || a.slot || '';
      return `<div class="dq-row dq-active">`
        + `<span class="sp-now">${i === 0 ? 'Now' : ''}</span>`
        + `<span class="dq-name">${escapeHtml(a.filename || '')}</span>`
        + (a.watchFolder ? `<span class="sp-folder" title="${escapeHtml(a.watchFolder)}">from ${escapeHtml(baseName(a.watchFolder))}</span>` : '')
        + (slot ? `<span class="dq-slot">${escapeHtml(slot)}</span>` : '')
        + `</div>`;
    }).join('');

    if (_scanTab !== 'progress') loadFailures();
  }

  function finishScanPanel(q) {
    const el = scanAiPane();
    if (!el) return;
    const done = n0(q.done), failed = n0(q.failed);
    openPane('ai', { tab: AI_TAB(), sub: failed ? `${fmtN(failed)} failed` : 'done' });
    el.querySelector('#scanHeadSub').textContent = failed ? `· done, ${fmtN(failed)} failed` : `· done, ${plural(done, 'file')} scanned`;
    const icoEl = el.querySelector('#scanHeadIco');
    icoEl.dataset.k = failed ? 'warn' : 'ok';
    icoEl.innerHTML = failed ? `<span class="sp-dot sp-dot-bad"></span>` : ico('✓', 'check');
    const pct = n0(q.total) ? Math.min(100, (done / n0(q.total)) * 100) : 100;
    el.querySelector('#scanBarFill').style.width = `${failed ? pct : 100}%`;
    el.querySelector('#scanBarFail').style.width = `${failed ? 100 - pct : 0}%`;
    el.querySelector('#scanMeta').hidden = true;   // keeps the stepper node alive
    el.querySelector('#scanList').innerHTML = '';
    // Nothing left to pause or cancel: the head's close is a plain dismiss here.
    el.querySelector('#scanActions').hidden = true;
    el.querySelector('#scanWarn').hidden = true;
    el.querySelector('#scanNotice').hidden = true;
    el.querySelector('#scanInst').hidden = true;
    el.querySelector('#scanWaitLine').hidden = true;
    el.querySelector('#scanCloseBtn').hidden = false;
    disarmCancel();
    paintScanTabs(el, failed, 0);
    clearTimeout(_scanFinishTimer);
    if (failed) {
      // The panel stays with its failure list until it is closed.
      if (!_scanTabPicked) setScanTab('failed');
      else loadFailures(true);
    } else {
      _scanFinishTimer = setTimeout(() => {
        if (_scanLast) return;                // a new run started meanwhile
        fetch('/api/import/failures/clear', { method: 'POST' }).catch(() => {});
        dropPane('ai');
      }, 4000);
    }
  }

  function stopScanWatch() {
    clearInterval(_scanTimer);
    _scanTimer = null;
    startIdleWatch();
  }

  /* ── The light watch while no run is on screen ──────────────────────────
     Every few seconds, counts only. Work appearing from anywhere (a watched
     folder, another tab) brings the full panel back. Marked as background so
     it never keeps the vault from locking itself. */
  function startIdleWatch() {
    if (_scanIdleTimer || _scanTimer) return;
    _scanIdleTimer = setInterval(idleTick, SCAN_IDLE_POLL_MS);
  }

  function stopIdleWatch() {
    clearInterval(_scanIdleTimer);
    _scanIdleTimer = null;
  }

  let _idleBusy = false;
  async function idleTick() {
    if (_idleBusy || _scanTimer || document.hidden) return;
    _idleBusy = true;
    try {
      const resp = await fetch('/api/import/queue/summary', { headers: { 'X-Vault-Background': '1' } });
      if (!resp.ok) return;                  // locked (423) or an older server: keep quiet
      const s = await resp.json();
      if (n0(s.active) + n0(s.queued) + n0(s.waiting) > 0) watchScanQueue({ fresh: true });
    } catch { /* the server may be restarting */ } finally {
      _idleBusy = false;
    }
  }

  /* ── One-time Ko-fi thank-you after a big first scan ────────────────────
     Vault is free; this is the only unprompted mention of donations in the
     library UI. It fires at most ONCE ever (localStorage flag), only after a
     batch of ≥50 files finishes, and it is a dismissible panel in the usual
     bottom-right queue stack — nothing modal, nothing that steals focus. */
  const LS_KOFI_NUDGED = 'vault_kofi_nudged';
  const KOFI_MIN_FILES = 50;

  function kofiNudged() {
    try { return localStorage.getItem(LS_KOFI_NUDGED) === '1'; } catch { return true; }
  }

  function maybeKofiNudge(total) {
    if (total < KOFI_MIN_FILES || kofiNudged()) return;
    // Write the flag FIRST: if storage is unavailable the nudge is skipped
    // entirely rather than repeating on every big scan.
    try { localStorage.setItem(LS_KOFI_NUDGED, '1'); } catch { return; }
    const el = document.createElement('div');
    el.id = 'kofiThanksPanel';
    el.className = 'delete-queue visible';
    el.innerHTML = `
      <div class="dq-head">
        <span class="dq-title">☕ Thanks for using Vault</span>
        <button class="dq-x" title="Dismiss">✕</button>
      </div>
      <div class="kofi-note">Vault just tagged ${total} files for you. If it saved you a
        weekend, <a href="https://ko-fi.com/aericocode" target="_blank" rel="noopener">☕ $10 on
        Ko-fi</a> says thanks, never required.</div>`;
    queuePanelStack().appendChild(el);
    el.querySelector('.dq-x').addEventListener('click', () => el.remove());
  }

  async function scanTick() {
    if (_scanBusy) return;                  // a slow round must not stack
    _scanBusy = true;
    try {
      const resp = await fetch('/api/import/queue', { headers: { 'X-Vault-Background': '1' } });
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

      const total = n0(q.total);
      const queued = q.pendingCount != null ? n0(q.pendingCount) : (q.pending?.length || 0);
      const working = (q.active?.length || 0) + queued;
      if (!total && !working) {
        // Idle queue — keep a short watch in case work lands, then let go.
        _scanLast = null;
        if (++_scanIdle >= SCAN_MAX_IDLE) stopScanWatch();
        return;
      }
      _scanIdle = 0;

      // Warn once per halt whether the panel is up or not: the queue has stopped
      // and needs a person, and the whole stack hides behind the full player.
      if (q.halt && q.halt.at !== _haltNotified) {
        _haltNotified = q.halt.at;
        _scanDismissed = false;                 // a halt is worth un-hiding for
        showToast(`⚠ AI scan paused: ${q.halt.reason}`);
      }
      // A wait is said once too, but it does not un-hide the panel: it clears
      // itself, and the user may well have hidden the panel on purpose.
      if (q.waiting && q.waiting.since && q.waiting.since !== _waitNotified && !q.waiting.gpuBusy) {
        _waitNotified = q.waiting.since;
        showToast('⏳ AI scan is waiting for the scan model');
      }

      // Done: nothing running, nothing queued or waiting.
      if (total > 0 && !working) {
        _scanLast = null;
        if (scanAiPane() || (n0(q.failed) && !_scanDismissed)) {
          // A run that ended with failures shows them even after a reload:
          // they are kept on the server until the panel is closed.
          renderScanPanel(q);
          finishScanPanel(q);
        }
        stopScanWatch();
        if (!n0(q.failed)) maybeKofiNudge(total);
        return;
      }
      _scanLast = q;
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
  // themselves (selection.js's Retry errors).
  window.vaultWatchScanQueue = (opts) => watchScanQueue(opts || {});

  function watchScanQueue({ fresh = false } = {}) {
    if (fresh) { _scanDismissed = false; _scanIdle = 0; _scanFails = 0; }
    stopIdleWatch();
    if (_scanTimer) { scanTick(); return; }
    _scanTimer = setInterval(() => { if (!document.hidden) scanTick(); }, SCAN_POLL_MS);
    scanTick();
  }

  // Back from another tab → catch up now instead of waiting out the interval.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (_scanTimer) scanTick(); else if (_scanIdleTimer) idleTick();
  });

  /* ── Shared live-grid refresh (throttled — big adds shouldn't repaint 60×) */
  function makeGridRefresher() {
    let last = 0;
    return (force = false) => {
      const now = Date.now();
      if (!force && now - last < 500) return;    // final flush catches stragglers
      last = now;
      try {
        if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
      } catch {}
    };
  }

  /* ── Post-add duration watcher ─────────────────────────────────────────
     add-paths returns rows BEFORE ffprobe fills duration/width/height, and
     hover-scrub (cards.js) is gated on duration_seconds — so freshly added
     videos wouldn't scrub until a full page reload. Poll the new ids and
     patch the cached rows in place (Library.patchRow merges into the same
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
        if (getMediaById(row.id)) Library.patchRow(row);
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
          if (a.row) Library.putRow(a.row);
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
      (imported.length ? (queued ? 'referenced in place, AI scan queued' : 'referenced in place, no AI scan (is an endpoint configured?)') : '')
      + (skips.length ? ` · ${skips.join(', ')}` : ''));
    // Durations arrive from the background probe after this response — watch
    // for them so fresh video tiles hover-scrub without a reload.
    watchDurationProbe(imported
      .filter(r => ['video', 'audio', 'gif'].includes(r.mediaType))
      .map(r => r.id));
    // …and the AI scan results land later still: each one changes the
    // library version, and Library's polling re-reads the rows on screen, so
    // descriptions/themes appear on hover + sidebar without 🔄 Refresh.
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
      if (scan.truncated) showToast(`⚠ Huge folder, preview capped at ${scan.files.length.toLocaleString()} files`);
      openImportModal({
        mode: 'paths',
        roots: [scan.name],
        path: scan.path,
        subdirs: scan.subdirs,
        files: scan.files,          // already { path, name, ext, size, depth }
        watchable: true,            // one real folder: it can be watched afterwards
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
        showToast('⚠ The file picker returned no files. Nothing was added');
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
    return sorted.length > 3 ? `${shown} · +${sorted.length - 3} more` : (shown || '–');
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
      watch: false,                                       // "Keep watching this folder", off by default
    };

    const headPath = pathMode
      ? collected.path
      : (collected.roots?.length > 1 ? `${collected.roots.length} folders: ${collected.roots.join(', ')}` : (collected.roots?.[0] || 'Dropped files'));

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
              <span class="imp-pill imp-pill-num">🤖 Workers per instance
                <input type="number" min="1" max="4" step="1" class="imp-num" id="impWorkers"
                       data-scan-workers value="${window.vaultScanWorkers ? window.vaultScanWorkers() : 2}"
                       title="${WORKERS_TIP}">
                <span class="imp-sub">files in flight per loaded model</span>
              </span>
            </div>
          </div>
          <div>
            <div class="imp-sect">After adding</div>
            <div class="imp-pills">
              <span class="imp-pill" id="impSubsJob">💬 Generate subtitles</span>
              <span class="imp-pill" id="impFpJob">🎵 Fingerprint audio <span class="imp-sub">(Music ID)</span></span>
            </div>
            <div class="imp-note">Runs in the background. The library stays usable. New files are AI-scanned automatically.</div>
          </div>
          ${pathMode && collected.watchable ? `
          <label class="imp-watch" id="impWatchRow">
            <span class="imp-watch-text"><span class="imp-watch-title">Keep watching this folder</span>
              <span class="imp-watch-desc">New files that land here later are added on their own.</span></span>
            <span class="wf-switch"><input type="checkbox" id="impWatch"><span aria-hidden="true"></span><span class="wf-sr">Keep watching this folder</span></span>
          </label>` : ''}
          <div class="imp-note">🔒 Files are referenced in place. Nothing is copied or moved.</div>
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
        ? `Ignored: ${preview.ignored.n} file${preview.ignored.n === 1 ? '' : 's'} (${extLine(preview.ignored.exts)})`
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
    q('#impWatch')?.addEventListener('change', (e) => { state.watch = e.target.checked; });
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
      const watch = state.watch && collected.watchable
        ? { path: collected.path, includeSubfolders: state.includeSubs,
            types: Object.keys(state.types).filter(k => state.types[k]) }
        : null;
      close();
      const { imported } = await addPaths(entries);   // always in place (no copy)
      // Keep watching: remember the folder (player-lib/watchers-ui.js) once
      // its files are in, so the watcher's first walk finds them already there.
      if (watch && typeof window.vaultWatchFolderAfterAdd === 'function') {
        window.vaultWatchFolderAfterAdd(watch).catch(() => {});
      }
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
                  showToast('⚠ Model downloads are off, subtitles skipped');
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
    folderBtn.title = 'Add a folder to the library. Files are referenced in place, never copied';
    folderBtn.addEventListener('click', pickAndAddFolder);
    btns.insertBefore(folderBtn, btns.firstChild);

    const filesBtn = document.createElement('button');
    filesBtn.id = 'addFilesBtn';
    filesBtn.className = 'header-btn';
    filesBtn.textContent = '📄 Add files';
    filesBtn.title = 'Add individual files to the library. They are referenced in place, never copied';
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
    // A drop target of its own (face search's photo box) already took it.
    if (e.target instanceof Element && e.target.closest('[data-no-import-drop]')) return;

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
      showToast('📁 Couldn\'t trace the dropped folder. Confirm it in the picker');
      pickAndAddFolder();
      return;
    }
    showToast('📄 Couldn\'t trace the dropped files. Pick them in the file picker');
    pickAndAddFiles();
  });
})();
