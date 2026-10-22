/* =========================================================================
   FOLDER WATCHERS - the screens for lib/watchers/ (WATCHERS_SPEC week 1).

   - Settings > Library > "Watched folders": one row per folder with its
     live status, Pause all, Watch a folder (the Add folder picker), and
     "Check for changes when Vault starts". settings.js calls
     vaultWatchSettingsHtml() inside RENDERERS_library and
     vaultWireWatchSettings() from wireLibrarySection, in both looks.
   - One folder's options (the row's ... button): how to watch, new files,
     subfolders, file types, skip these, smaller than, missing files,
     Check now, Stop watching (asks once), Save.
   - The header activity pill (an eye) with its popover: new files per
     folder (Show = "Added since you last looked"), moves, missing files
     (Show = Missing), adding progress with Pause, and a Settings link.
   - New tags clear once their tile has been on screen (POST /api/watch/seen),
     except while the "Added since you last looked" filter is on, where they
     would vanish from under the user; they clear when it is turned off.
   - vaultWatchFolderAfterAdd(): the Add folder dialog's "Keep watching this
     folder" switch (player-lib/importer.js).

   Classic keeps emoji, Modern shows line icons (player-lib/icons.js
   vaultIconSwap); css/watchers.css styles both.
   ========================================================================= */

(function () {
  const h = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const ic = (emoji, name) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, name) : h(emoji));
  const toast = (msg) => { if (typeof showToast === 'function') showToast(msg); };

  async function api(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    if (method === 'GET') opts.headers['X-Vault-Background'] = '1';
    const resp = await fetch(url, opts);
    let data = null;
    try { data = await resp.json(); } catch {}
    return { ok: resp.ok, status: resp.status, data: data || {} };
  }

  /* ── Words ──────────────────────────────────────────────────────────── */

  function ago(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 48) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
    return `${Math.round(hrs / 24)} days ago`;
  }

  const plural = (n, one, many = one + 's') => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

  /** "100 KB", "1.5 MB" from bytes; '' for 0. */
  function fmtSize(b) {
    if (!b) return '';
    if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
    if (b < 1024 * 1024 * 1024) return `${+(b / 1048576).toFixed(1)} MB`;
    return `${+(b / 1073741824).toFixed(2)} GB`;
  }

  /** "100 KB", "2mb", "500" (KB) -> bytes; '' or 0 -> 0; null when not a size. */
  function parseSize(text) {
    const t = String(text || '').trim();
    if (!t || t === '0') return 0;
    const m = /^(\d+(?:[.,]\d+)?)\s*(k|kb|kib|m|mb|mib|g|gb|gib|b)?$/i.exec(t);
    if (!m) return null;
    const n = Number(m[1].replace(',', '.'));
    const u = (m[2] || 'kb').toLowerCase()[0];
    const mult = u === 'g' ? 1073741824 : u === 'm' ? 1048576 : u === 'b' ? 1 : 1024;
    return Math.round(n * mult);
  }

  /** Status pill words and dot colour for a folder row. */
  function statusWords(f) {
    const s = f.status || {};
    switch (s.state) {
      case 'live': return { dot: 'ok', text: 'Watching live' };
      case 'timer': return { dot: 'idle', text: `Checks every ${f.intervalMin} min` };
      case 'manual': return { dot: 'idle', text: 'Only when you ask' };
      case 'adding': return { dot: 'amber', text: `Adding ${plural(s.adding, 'file')}` };
      case 'scanning': return { dot: 'amber', text: s.seen ? `Scanning, ${Number(s.seen).toLocaleString()} looked at` : 'Scanning' };
      case 'paused': return { dot: 'idle', text: 'Paused' };
      case 'off': return { dot: 'idle', text: 'Off' };
      case 'locked': return { dot: 'idle', text: 'Locked' };
      case 'error': return { dot: 'bad', text: s.error || 'Problem reading this folder' };
      default: return { dot: 'idle', text: '' };
    }
  }

  /* ── Settings > Library > Watched folders ───────────────────────────── */

  let state = null;           // last GET /api/watch/folders
  let pollTimer = null;

  function html() {
    return `
      <h3 class="settings-h" data-sfind="watchFolders">Watched folders</h3>
      <div class="wf-group" id="wfGroup">
        <div class="wf-topbar">
          <p class="settings-note wf-intro">Vault keeps an eye on these folders and adds new files on its own.
          Files that disappear are marked Missing, with everything about them kept.</p>
          <span class="wf-topbtns">
            <button type="button" class="settings-btn settings-btn-quiet wf-btn" id="wfPauseAll" data-sfind="watchPauseAll">${ic('⏸ ', 'pause')}<span class="wf-pause-label">Pause all</span></button>
            <button type="button" class="settings-btn wf-btn" id="wfAddBtn">${ic('＋ ', 'plus')}Watch a folder</button>
          </span>
        </div>
        <div class="wf-list" id="wfList"><p class="settings-note">Asking the server…</p></div>
        <label class="settings-toggle" data-sfind="watchCheckOnStart">
          <span class="settings-toggle-text">
            <span class="settings-toggle-title">Check for changes when Vault starts</span>
            <span class="settings-toggle-desc">A quiet walk of every folder to catch what changed while Vault was closed.</span>
          </span>
          <input type="checkbox" id="wfCheckOnStart" checked>
          <span class="settings-switch" aria-hidden="true"></span>
        </label>
      </div>`;
  }

  function rowHtml(f) {
    const st = statusWords(f);
    const s = f.status || {};
    const net = /^\\\\/.test(f.path);
    const meta = [];
    if (s.state === 'error') meta.push('Files are kept. Nothing is marked missing.');
    else {
      if (f.files != null) meta.push(plural(f.files, 'file'));
      meta.push(f.newFiles === 'add_only' ? 'Add only' : 'Add and analyse');
      if (!f.includeSubfolders) meta.push('this folder only');
      if (f.lastChangeAt) meta.push(`last change ${ago(f.lastChangeAt)}`);
    }
    const bar = s.state === 'adding' && s.progress != null
      ? `<span class="wf-bar"><b style="width:${Math.max(2, Math.min(100, s.progress))}%"></b></span>` : '';
    return `
      <div class="wf-row" data-wf-id="${f.id}">
        <span class="wf-ic">${net ? ic('🖧', 'server') : ic('📁', 'folder')}</span>
        <span class="wf-path" title="${h(f.path)}">${h(f.path)}</span>
        <span class="wf-acts">
          <span class="wf-st"><span class="wf-dot wf-dot-${st.dot}"></span><span class="wf-st-text">${h(st.text)}</span></span>
          <button type="button" class="wf-more" data-wf-more="${f.id}" title="Options" aria-label="Options for ${h(f.path)}">${ic('⋯', 'more')}</button>
        </span>
        <span class="wf-meta">${h(meta.join(' · '))}</span>
        ${bar}
      </div>`;
  }

  function renderList() {
    const list = document.getElementById('wfList');
    if (!list || !state) return;
    list.innerHTML = state.folders.length
      ? state.folders.map(rowHtml).join('')
      : '<p class="settings-note wf-empty">No folders yet. Watch a folder and new files that land in it are added on their own.</p>';
    const pause = document.getElementById('wfPauseAll');
    if (pause) {
      pause.hidden = !state.folders.length;
      const label = pause.querySelector('.wf-pause-label');
      if (label) label.textContent = state.paused ? 'Resume' : 'Pause all';
      pause.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
    }
    const cos = document.getElementById('wfCheckOnStart');
    if (cos) cos.checked = state.checkOnStart !== false;
  }

  async function refreshList() {
    if (!document.getElementById('wfList')) { stopPoll(); return; }
    try {
      const r = await api('GET', '/api/watch/folders');
      if (!r.ok) {
        const list = document.getElementById('wfList');
        if (list && !state) list.innerHTML = '<p class="settings-note">Could not ask the server.</p>';
        return;
      }
      state = r.data;
      renderList();
    } catch { /* offline: keep what is shown */ }
  }

  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  /** Quick while something is moving (adding, scanning, counting), slow when all is quiet. */
  function busy() {
    return !!state && state.folders.some(f => f.files == null
      || ['adding', 'scanning'].includes(f.status && f.status.state));
  }
  function schedulePoll() {
    stopPoll();
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!document.getElementById('wfList')) return;
      if (!document.hidden) await refreshList();
      schedulePoll();
    }, busy() ? 3000 : 15000);
  }

  function wire() {
    const group = document.getElementById('wfGroup');
    if (!group) return;
    refreshList().then(schedulePoll);

    document.getElementById('wfAddBtn')?.addEventListener('click', watchAFolder);
    document.getElementById('wfPauseAll')?.addEventListener('click', togglePauseAll);
    document.getElementById('wfCheckOnStart')?.addEventListener('change', async (e) => {
      const r = await api('POST', '/api/watch/settings', { checkOnStart: e.target.checked });
      if (!r.ok) { e.target.checked = !e.target.checked; toast('⚠ ' + (r.data.error || 'Could not save')); }
    });
    document.getElementById('wfList')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-wf-more]');
      if (!btn || !state) return;
      const f = state.folders.find(x => String(x.id) === btn.dataset.wfMore);
      if (f) openOptions(f);
    });
  }

  async function togglePauseAll() {
    const resume = state && state.paused;
    const r = await api('POST', resume ? '/api/watch/resume' : '/api/watch/pause');
    if (!r.ok) { toast('⚠ ' + (r.data.error || 'Could not change that')); return; }
    toast(resume ? '👁 Watching again. Checking for changes.' : '⏸ Watching paused');
    refreshList();
    refreshPill();
  }

  /** Small in-app question. Resolves true for the main button. */
  function ask(message, okLabel, { danger = false } = {}) {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'wf-overlay wf-ask-overlay';
      ov.innerHTML = `<div class="wf-dialog wf-ask" role="alertdialog" aria-modal="true" aria-label="Confirm">
          <p class="wf-ask-text">${h(message)}</p>
          <div class="wf-foot"><span class="wf-grow"></span>
            <button type="button" class="settings-btn settings-btn-quiet" data-ask="no">Cancel</button>
            <button type="button" class="settings-btn${danger ? ' wf-danger' : ''}" data-ask="yes">${h(okLabel)}</button>
          </div></div>`;
      const done = (v) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
      document.addEventListener('keydown', onKey, true);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
      ov.querySelector('[data-ask="no"]').addEventListener('click', () => done(false));
      ov.querySelector('[data-ask="yes"]').addEventListener('click', () => done(true));
      document.body.appendChild(ov);
      ov.querySelector('[data-ask="yes"]').focus();
    });
  }

  /** POST /api/watch/folders, with the drive-root confirm. @returns {object|null} reply */
  async function addWatch(body) {
    let r = await api('POST', '/api/watch/folders', body);
    if (r.status === 409 && r.data.code === 'WATCH_CONFIRM_ROOT') {
      if (!(await ask(r.data.error, 'Watch the whole drive'))) return null;
      r = await api('POST', '/api/watch/folders', { ...body, confirm: true });
    }
    if (!r.ok) { toast('⚠ ' + (r.data.error || 'Could not watch that folder')); return null; }
    const name = r.data.folder.path;
    toast(`👁 Watching ${name}` + (r.data.merged?.length ? `. It now covers ${r.data.merged.length === 1 ? r.data.merged[0] : plural(r.data.merged.length, 'folder')} too.` : ''));
    refreshList();
    refreshPill();
    return r.data;
  }

  async function watchAFolder() {
    const btn = document.getElementById('wfAddBtn');
    if (btn?.disabled) return;
    if (btn) btn.disabled = true;
    try {
      const r = await api('POST', '/api/import/pick-folder');
      if (!r.ok) { toast('⚠ ' + (r.data.error || 'folder picker failed')); return; }
      if (r.data.canceled || !r.data.path) return;
      await addWatch({ path: r.data.path });
    } catch (err) {
      toast('⚠ ' + err.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── One folder's options ───────────────────────────────────────────── */

  function seg(name, options, current, label) {
    return `<span class="wf-seg" role="group" aria-label="${h(label)}">${options.map(o => `
      <button type="button" class="wf-seg-btn" data-wf-seg="${name}" data-value="${h(o.value)}"
              aria-pressed="${o.value === current ? 'true' : 'false'}"${o.disabled ? ' disabled' : ''}${o.title ? ` title="${h(o.title)}"` : ''}>${o.html || h(o.label)}</button>`).join('')}</span>`;
  }

  function optRow(title, desc, control, extraCls = '') {
    return `<div class="wf-orow${extraCls ? ' ' + extraCls : ''}">
        <div class="wf-olabel">${h(title)}${desc ? `<small>${h(desc)}</small>` : ''}</div>
        <div class="wf-octl">${control}</div>
      </div>`;
  }

  function openOptions(f) {
    document.getElementById('wfOptions')?.remove();
    const types = (state && state.types || []).filter(t => t.offered);
    const draft = {
      mode: f.mode, intervalMin: f.intervalMin, newFiles: f.newFiles, includeSubfolders: f.includeSubfolders,
      types: f.types.slice(),
    };
    const ov = document.createElement('div');
    ov.className = 'wf-overlay';
    ov.id = 'wfOptions';
    ov.innerHTML = `
      <div class="wf-dialog" role="dialog" aria-modal="true" aria-labelledby="wfOptTitle">
        <div class="wf-dhead">
          <span class="wf-ic">${ic('📁', 'folder')}</span>
          <b class="wf-dtitle" id="wfOptTitle" title="${h(f.path)}">${h(f.path)}</b>
          <button type="button" class="wf-x" aria-label="Close">✕</button>
        </div>
        <div class="wf-dbody">
          ${optRow('How to watch', 'Live is instant on local drives. Use a timer for network or USB drives.',
            seg('mode', [
              { value: 'live', label: 'Live' },
              { value: 'timer', html: `Every <span id="wfIntervalLabel">${h(draft.intervalMin)}</span> min` },
              { value: 'manual', label: 'Only when I ask' },
            ], draft.mode, 'How to watch')
            + `<label class="wf-interval" id="wfIntervalRow"${draft.mode === 'timer' ? '' : ' hidden'}>Check every
                <input type="number" class="wf-num" id="wfInterval" min="1" max="1440" value="${h(draft.intervalMin)}"> min</label>`)}
          ${optRow('New files', 'Add only: playable and searchable by name right away. You can analyse them later.',
            seg('newFiles', [{ value: 'analyse', label: 'Add and analyse' }, { value: 'add_only', label: 'Add only' }], draft.newFiles, 'New files'))}
          ${optRow('Include subfolders', '', `<label class="wf-switch"><input type="checkbox" id="wfSubs" ${draft.includeSubfolders ? 'checked' : ''}><span aria-hidden="true"></span><span class="wf-sr">Include subfolders</span></label>`)}
          ${optRow('File types', '', `<span class="wf-chips" role="group" aria-label="File types">${types.map(t => `
            <button type="button" class="wf-chip" data-wf-type="${t.id}" aria-pressed="${draft.types.includes(t.id) ? 'true' : 'false'}">${h(t.label)}</button>`).join('')}</span>`)}
          ${optRow('Skip these', 'Names or folders to ignore. One per line; * matches anything; end with \\ for a folder.',
            `<textarea class="wf-text" id="wfSkip" rows="5" spellcheck="false" aria-label="Skip these">${h(f.skipPatterns.join('\n'))}</textarea>`, 'wf-orow-top')}
          ${optRow('Smaller than', 'Ignore tiny videos and pictures, like previews and samples. Audio and documents are never skipped for size. Empty means off.',
            `<input type="text" class="wf-field" id="wfMin" inputmode="decimal" spellcheck="false" placeholder="Off" value="${h(fmtSize(f.minSizeBytes))}" aria-label="Smaller than">`)}
          ${optRow('Missing files', 'Kept and marked Missing. They come back on their own when the file does.',
            seg('missing', [{ value: 'keep', label: 'Keep' }, { value: 'forget', label: 'Forget after 30 days', disabled: true, title: 'Coming in a later update' }], 'keep', 'Missing files'))}
          <p class="wf-err" id="wfErr" hidden></p>
        </div>
        <div class="wf-foot" id="wfFoot">
          <button type="button" class="settings-btn settings-btn-quiet" id="wfCheck">${ic('🔄 ', 'refresh')}Check now</button>
          <span class="wf-grow"></span>
          <button type="button" class="settings-btn settings-btn-quiet" id="wfStop">Stop watching</button>
          <button type="button" class="settings-btn" id="wfSave">Save</button>
        </div>
        <div class="wf-foot wf-confirm" id="wfConfirm" hidden>
          <span class="wf-confirm-text">Stop watching this folder? Files already added stay in your library.</span>
          <span class="wf-grow"></span>
          <button type="button" class="settings-btn settings-btn-quiet" id="wfStopNo">Cancel</button>
          <button type="button" class="settings-btn wf-danger" id="wfStopYes">Stop watching</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const q = (sel) => ov.querySelector(sel);
    const err = (msg) => { const e = q('#wfErr'); e.textContent = msg || ''; e.hidden = !msg; };

    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    q('.wf-x').addEventListener('click', close);

    ov.addEventListener('click', (e) => {
      const b = e.target.closest('[data-wf-seg]');
      if (b && !b.disabled) {
        const name = b.dataset.wfSeg;
        if (name === 'missing') return;
        draft[name] = b.dataset.value;
        ov.querySelectorAll(`[data-wf-seg="${name}"]`).forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        if (name === 'mode') q('#wfIntervalRow').hidden = draft.mode !== 'timer';
      }
      const chip = e.target.closest('[data-wf-type]');
      if (chip) {
        const t = chip.dataset.wfType;
        draft.types = draft.types.includes(t) ? draft.types.filter(x => x !== t) : draft.types.concat([t]);
        chip.setAttribute('aria-pressed', draft.types.includes(t) ? 'true' : 'false');
      }
    });
    q('#wfInterval').addEventListener('input', () => { q('#wfIntervalLabel').textContent = q('#wfInterval').value || '?'; });

    q('#wfSave').addEventListener('click', async () => {
      err('');
      const min = parseSize(q('#wfMin').value);
      if (min === null) { err('Smaller than needs a size, like 100 KB or 2 MB.'); return; }
      if (!draft.types.length) { err('Pick at least one file type.'); return; }
      const interval = Number(q('#wfInterval').value);
      const body = {
        mode: draft.mode, newFiles: draft.newFiles, includeSubfolders: q('#wfSubs').checked,
        types: draft.types, skipPatterns: q('#wfSkip').value, minSizeBytes: min,
      };
      if (Number.isInteger(interval) && interval >= 1 && interval <= 1440) body.intervalMin = interval;
      else if (draft.mode === 'timer') { err('Check every needs a whole number of minutes from 1 to 1440.'); return; }
      const r = await api('POST', `/api/watch/folders/${f.id}`, body);
      if (!r.ok) { err(r.data.error || 'Could not save.'); return; }
      toast('💾 Saved');
      close();
      refreshList();
    });

    q('#wfCheck').addEventListener('click', async () => {
      const r = await api('POST', `/api/watch/folders/${f.id}/check`);
      if (!r.ok) { err(r.data.error || 'Could not check now.'); return; }
      toast('🔄 Checking for changes');
      refreshList();
    });

    q('#wfStop').addEventListener('click', () => { q('#wfFoot').hidden = true; q('#wfConfirm').hidden = false; q('#wfStopYes').focus(); });
    q('#wfStopNo').addEventListener('click', () => { q('#wfFoot').hidden = false; q('#wfConfirm').hidden = true; });
    q('#wfStopYes').addEventListener('click', async () => {
      const r = await api('DELETE', `/api/watch/folders/${f.id}`);
      if (!r.ok) { err(r.data.error || 'Could not stop watching.'); return; }
      toast('Stopped watching. Files already added stay in your library.');
      close();
      refreshList();
      refreshPill();
    });
    q('#wfSave').focus();
  }

  /* ── The header pill ────────────────────────────────────────────────── */

  let act = null;            // last GET /api/watch/activity
  let pillTimer = null;

  function ensurePill() {
    let wrap = document.getElementById('watchPillWrap');
    if (wrap) return wrap;
    const btns = document.querySelector('.header-buttons');
    if (!btns) return null;
    wrap = document.createElement('div');
    wrap.className = 'watch-pill-wrap';
    wrap.id = 'watchPillWrap';
    wrap.hidden = true;
    wrap.innerHTML = `
      <button type="button" class="header-btn watch-pill" id="watchPill" aria-haspopup="dialog" aria-expanded="false"
              aria-controls="watchPop" title="Watched folders"><span class="watch-pill-ic">${ic('👁', 'eye')}</span><span class="watch-pill-text" id="watchPillText"></span></button>
      <div class="watch-pop" id="watchPop" role="dialog" aria-label="Watched folders" hidden></div>`;
    const refresh = document.getElementById('refreshBtn');
    btns.insertBefore(wrap, refresh || null);
    wrap.querySelector('#watchPill').addEventListener('click', (e) => { e.stopPropagation(); togglePop(); });
    wrap.querySelector('#watchPop').addEventListener('click', onPopClick);
    document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) togglePop(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popOpen()) togglePop(false); });
    return wrap;
  }

  const popOpen = () => !document.getElementById('watchPop')?.hidden;

  function togglePop(open) {
    const pop = document.getElementById('watchPop');
    const btn = document.getElementById('watchPill');
    if (!pop || !btn) return;
    const next = open === undefined ? pop.hidden : open;
    pop.hidden = !next;
    btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) { renderPop(); refreshPill(); }
  }

  function renderPill() {
    const wrap = ensurePill();
    if (!wrap) return;
    if (!act || !act.watching) { wrap.hidden = true; togglePop(false); return; }
    wrap.hidden = false;
    const state = act.paused ? 'paused' : act.state;
    wrap.dataset.state = state;
    const text = document.getElementById('watchPillText');
    const words = act.newTotal ? `${act.newTotal.toLocaleString()} new`
      : state === 'adding' ? 'Adding' : '';
    if (text) { text.textContent = words; text.hidden = !words; }
    const btn = document.getElementById('watchPill');
    const label = act.paused ? 'Watched folders: paused'
      : state === 'error' ? 'Watched folders: a folder has a problem'
        : `Watched folders${act.newTotal ? `: ${act.newTotal} new` : ''}`;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    if (popOpen()) renderPop();
  }

  function renderPop() {
    const pop = document.getElementById('watchPop');
    if (!pop || !act) return;
    const rows = [];
    const head = act.paused ? 'paused' : act.state === 'error' ? 'a folder has a problem'
      : act.state === 'adding' ? 'adding files' : act.state === 'scanning' ? 'checking for changes' : 'all watching';
    rows.push(`<div class="watch-pop-r watch-pop-head"><b>Watched folders</b><span class="watch-pop-mut">${h(head)}</span></div>`);
    for (const f of act.folders) {
      if (f.new) rows.push(`<div class="watch-pop-r"><span>${h(plural(f.new, 'new file'))} from ${h(f.name)}</span><button type="button" class="watch-pop-btn" data-watch-show="new">Show</button></div>`);
      if (f.moved) rows.push(`<div class="watch-pop-r"><span>${h(plural(f.moved, 'file'))} moved in ${h(f.name)}</span><span class="watch-pop-mut">tags kept</span></div>`);
      if (f.missing) rows.push(`<div class="watch-pop-r"><span>${h(plural(f.missing, 'file'))} missing in ${h(f.name)}</span><button type="button" class="watch-pop-btn" data-watch-show="missing">Show</button></div>`);
      if (f.state === 'error' && f.error) rows.push(`<div class="watch-pop-r watch-pop-bad"><span>${h(f.name)}: ${h(f.error)}</span></div>`);
    }
    if (act.adding.pending) {
      rows.push(`<div class="watch-pop-r"><span class="watch-pop-mut">Adding ${h(plural(act.adding.pending, 'file'))}${act.adding.progress != null ? `, ${act.adding.progress}%` : ''}</span>
        <button type="button" class="watch-pop-btn watch-pop-ghost" data-watch-pause="1">${ic('⏸ ', 'pause')}Pause</button></div>`);
    } else if (act.paused) {
      rows.push(`<div class="watch-pop-r"><span class="watch-pop-mut">Watching is paused.</span>
        <button type="button" class="watch-pop-btn" data-watch-resume="1">Resume</button></div>`);
    } else if (rows.length === 1) {
      rows.push('<div class="watch-pop-r"><span class="watch-pop-mut">Nothing new since you last looked.</span></div>');
    }
    rows.push(`<div class="watch-pop-r"><button type="button" class="watch-pop-btn watch-pop-ghost" data-watch-settings="1">${ic('⚙ ', 'gear')}Settings</button>
      <span class="watch-pop-mut">${act.lastChangeAt ? `last change ${h(ago(act.lastChangeAt))}` : ''}</span></div>`);
    pop.innerHTML = rows.join('');
  }

  /** Show = the matching library filter, on the Library tab. */
  function showFilter(which) {
    togglePop(false);
    if (typeof switchTab === 'function' && typeof currentTab !== 'undefined' && currentTab !== 'library') switchTab('library');
    if (typeof setTriFilterValue !== 'function' || typeof applyFilters !== 'function') return;
    if (which === 'new') { setTriFilterValue('filterWatchNew', '1'); setTriFilterValue('filterMissing', ''); }
    else { setTriFilterValue('filterMissing', '1'); setTriFilterValue('filterWatchNew', ''); }
    applyFilters();
  }

  async function onPopClick(e) {
    const show = e.target.closest('[data-watch-show]');
    if (show) { showFilter(show.dataset.watchShow); return; }
    if (e.target.closest('[data-watch-pause]')) {
      await api('POST', '/api/watch/pause');
      toast('⏸ Watching paused');
      refreshPill();
      refreshList();
      return;
    }
    if (e.target.closest('[data-watch-resume]')) {
      await api('POST', '/api/watch/resume');
      toast('👁 Watching again. Checking for changes.');
      refreshPill();
      refreshList();
      return;
    }
    if (e.target.closest('[data-watch-settings]')) {
      togglePop(false);
      if (typeof window.vaultOpenSettings === 'function') window.vaultOpenSettings('library');
    }
  }

  async function refreshPill() {
    // New tags held while "Added since you last looked" was on can go now.
    if (seenPending.size && !seenTimer && !newFilterOn()) seenTimer = setTimeout(flushSeen, 200);
    try {
      const r = await api('GET', '/api/watch/activity');
      if (!r.ok) { if (r.status === 423) { act = null; renderPill(); } return; }
      act = r.data;
      renderPill();
    } catch { /* server away */ }
  }

  function startPill() {
    ensurePill();
    refreshPill();
    if (pillTimer) clearInterval(pillTimer);
    pillTimer = setInterval(() => { if (!document.hidden) refreshPill(); }, 5000);
  }

  /* ── New tags clear once seen ───────────────────────────────────────── */

  const seenPending = new Set();
  const seenSent = new Set();
  let seenTimer = null;
  let io = null;

  const newFilterOn = () => typeof getTriFilterValue === 'function' && getTriFilterValue('filterWatchNew') === '1';

  async function flushSeen() {
    seenTimer = null;
    if (!seenPending.size || newFilterOn()) return;
    const ids = [...seenPending].slice(0, 2000);
    ids.forEach(id => { seenPending.delete(id); seenSent.add(id); });
    const r = await api('POST', '/api/watch/seen', { ids }).catch(() => null);
    if (!r || !r.ok) ids.forEach(id => { seenSent.delete(id); seenPending.add(id); });
    else refreshPill();
  }

  function noteSeen(id) {
    if (!Number.isInteger(id) || seenSent.has(id)) return;
    seenPending.add(id);
    if (!seenTimer) seenTimer = setTimeout(flushSeen, 2500);
  }

  function watchTags(root) {
    if (!io) return;
    root.querySelectorAll('[data-watch-new]:not([data-watch-obs])').forEach((el) => {
      el.setAttribute('data-watch-obs', '');
      io.observe(el.closest('.media-tile') || el);
    });
  }

  function startSeen() {
    if (typeof IntersectionObserver !== 'function' || typeof MutationObserver !== 'function') return;
    const timers = new Map();
    io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const tag = en.target.querySelector?.('[data-watch-new]') || en.target;
        const id = Number(tag.getAttribute('data-watch-new'));
        if (en.isIntersecting && en.intersectionRatio >= 0.5) {
          // On screen for a moment, not just scrolled past.
          if (!timers.has(en.target)) timers.set(en.target, setTimeout(() => { timers.delete(en.target); noteSeen(id); io.unobserve(en.target); }, 1200));
        } else if (timers.has(en.target)) {
          clearTimeout(timers.get(en.target));
          timers.delete(en.target);
        }
      }
    }, { threshold: [0, 0.5] });
    const grid = document.getElementById('mainContainer') || document.body;
    new MutationObserver(() => watchTags(grid)).observe(grid, { childList: true, subtree: true });
    watchTags(grid);
  }

  /* ── The Add folder dialog's "Keep watching this folder" ────────────── */

  /**
   * Called by importer.js after an Add folder run with the switch on.
   * types: the dialog's buckets (video, image, audio).
   */
  async function watchFolderAfterAdd({ path, includeSubfolders = true, types = null }) {
    const body = { path, includeSubfolders };
    if (Array.isArray(types) && types.length) body.types = types;
    return addWatch(body);
  }

  window.vaultWatchSettingsHtml = html;
  window.vaultWireWatchSettings = wire;
  window.vaultWatchFolderAfterAdd = watchFolderAfterAdd;
  window.vaultWatchRefresh = () => { refreshPill(); refreshList(); };
  // Tests
  window.__watchUi = { parseSize, fmtSize, statusWords, ago };

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', () => { startPill(); startSeen(); });
  }
})();
