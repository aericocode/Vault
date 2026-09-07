/* =========================================================================
   SETTINGS — the app's info + preferences hub (replaces the old license UI)

   A dim ⚙ button at the end of .header-buttons opens a house-style modal with
   left-nav sections: Settings · Guides · Models · Seed packs · About.

   All preferences persist to localStorage under one JSON blob (vault_settings)
   and are applied at boot (the privacy-mode body class is applied the moment
   this script parses, before first render). Everything is local; nothing here
   talks to the network except GET /api/about (app name + version).

   Public globals used by other modules (all guarded at their call sites):
   - window.vaultSetting(key)          → current value of a setting
   - window.vaultRecordLastOpened(id)  → remember last-opened media (restore session)
   - window.vaultScanWorkers()         → AI scan concurrency (int)
   - window.vaultSetScanWorkers(n)     → clamp + persist + push it to the server
   ========================================================================= */

(function () {
  const LS_KEY = 'vault_settings';

  const DEFAULTS = {
    privacyMode: false,     // hide personal data on screen for screen-sharing
    // Which categories privacy mode actually hides. Each key maps to a body
    // class (PRIVACY_CLASS below) that css/settings.css hangs its rules on.
    privacyHide: {
      paths: true,
      notes: true,
      savedSearches: true,
      importFolders: true,
      thumbnails: false,
      fileNames: false,
    },
    resumePlayback: true,   // auto-seek to stored position on open (current behavior)
    restoreSession: false,  // reopen last media (paused) on launch, Stash-style
    queueLoop: false,       // after the last file in the list, start over at the first
    scanWorkers: 2,         // files the vision model scans in parallel after an import
    unlockHoldSeconds: 0,   // press-and-hold on the lock before the password box (0 = single click)
    blurThumbs: false,      // blur the grid's tiles (hover reveals — unless privacy mode is on)
    gamifyHidden: false,    // hide the Obsession chip + toasts (scoring continues)
    libraryDeepOpen: false, // Settings > Library: is the deep-search section expanded
    _lastMediaId: null,     // internal: id for restoreSession
  };

  let settings = { ...DEFAULTS };

  /* ── Settings the SERVER owns ────────────────────────────────────────────
     Two settings can't live in localStorage, because the server acts on them
     with no browser involved: the Obsession tracker decides which routes exist,
     and the autolock clock has to be right from process start. They persist
     server-side (gamify-config.json / vault-settings.json) — which is also the
     only way a Vault.exe user, who has nowhere to set an env var, can reach
     them at all. Cached here so the modal can render synchronously. */

  let server = { gamify: false, autolockMinutes: 30, encrypted: false, reachable: false };
  // Consent for the one-time AI model fetches (whisper / translation /
  // diarization). Separate endpoint because the env vars are a hard ceiling
  // over it — see server/index.js applyModelDownloadConsent().
  let modelDl = { envAllows: true, explicit: false, consents: {}, pending: [] };

  /* One row per model Vault has actually needed — approved ones so they can be
     revoked, plus anything still waiting. Nothing is listed speculatively: a
     user who never touches subtitles never sees a translation-pack row. */
  function modelConsentRows() {
    const seen = new Map();
    for (const [key, allowed] of Object.entries(modelDl.consents || {})) {
      seen.set(key, { key, allowed: allowed === true });
    }
    for (const p of modelDl.pending || []) {
      if (!seen.has(p.key)) seen.set(p.key, { key: p.key, allowed: false, ...p });
    }
    if (!seen.size) {
      return '<p class="settings-note">Nothing needed yet — Vault will ask the first time a feature wants one.</p>';
    }
    const label = (k) => k.startsWith('whisper:') ? `Transcription model (${k.slice(8)})`
      : k.startsWith('opus:') ? `Translation pack (${k.slice(5)}→en)`
      : k === 'diarize' ? 'Speaker-detection models' : k;
    return [...seen.values()].map(r => toggleRow({
      key: `modelConsent:${r.key}`,
      value: r.allowed,
      disabled: !modelDl.envAllows || modelDl.explicit,
      title: label(r.key),
      desc: r.allowed
        ? 'Approved — downloaded on first use, then loaded from disk.'
        : `Not approved${r.sizeHint ? ` · ${r.sizeHint}` : ''} — Vault will ask again when it needs this.`,
    })).join('');
  }

  async function loadServerSettings() {
    try {
      const resp = await fetch('/api/settings/app');
      if (!resp.ok) return false;      // 423 while locked, or an older server
      server = { ...server, ...(await resp.json()), reachable: true };
      try {
        const md = await fetch('/api/settings/model-downloads');
        if (md.ok) modelDl = { ...modelDl, ...(await md.json()) };
      } catch {}
      return true;
    } catch { return false; }
  }

  async function pushServerSetting(patch) {
    const resp = await fetch('/api/settings/app', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    server = { ...server, ...data };
    return data;
  }

  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      settings = { ...DEFAULTS };
    }
    // privacyHide is a nested object, so the spread above replaces it wholesale
    // rather than merging it. Merge the stored keys OVER the defaults, so a
    // profile saved before this setting existed (or one saved before a new
    // category was added) still gets every default it never chose.
    const storedHide = settings.privacyHide;
    settings.privacyHide = {
      ...DEFAULTS.privacyHide,
      ...(storedHide && typeof storedHide === 'object' ? storedHide : {}),
    };
    // Stored JSON is user-editable — run the one numeric setting through the
    // same clamp every other surface uses. That clamp falls back to the current
    // value for anything unreadable, so seed the default first: a null or a
    // stray string then lands on 2 rather than being coerced down to 1.
    const stored = settings.scanWorkers;
    settings.scanWorkers = DEFAULTS.scanWorkers;
    settings.scanWorkers = clampWorkers(stored);
    // One-time migration: profiles from before unlock-became-a-click carry the
    // old default of 3, which would silently keep hold-to-unlock with no UI
    // left to change it. Exactly 3 → 0, once; any other value was set by hand
    // (editing the stored JSON) and is honored as-is.
    if (!settings._unlockHoldMigrated) {
      if (settings.unlockHoldSeconds === 3) settings.unlockHoldSeconds = 0;
      settings._unlockHoldMigrated = true;
      save();
    }
  }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {}
  }

  // Read a setting from anywhere in the app.
  window.vaultSetting = (key) => settings[key];

  // The player asks this when a file ends (or fails) on the last item in the
  // list: start over at the first, or stop here?
  window.vaultQueueLoop = () => !!settings.queueLoop;

  /* ── AI scan workers ─────────────────────────────────────────────────────
     One number, three surfaces (this modal, the import modal, the live scan
     panel) — so everything routes through this pair instead of re-deriving the
     clamp. The server owns the actual queue, but the browser owns the *memory*
     of the value: the server forgets on restart, localStorage doesn't, which is
     why boot re-pushes it below. The POST is best-effort — an older server
     without the route (or none at all) must not lose the stored preference. */

  const WORKERS_MIN = 1, WORKERS_MAX = 8;

  // A number input hands back '' for anything it can't parse (letters, blank),
  // so garbage snaps back to the stored value rather than to the minimum.
  function clampWorkers(n) {
    if (n === '' || n == null) return settings.scanWorkers;
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) return settings.scanWorkers;
    return Math.min(WORKERS_MAX, Math.max(WORKERS_MIN, n));
  }

  function pushWorkers(n) {
    fetch('/api/import/queue/concurrency', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ n }),
    }).catch(() => {});
  }

  window.vaultScanWorkers = () => clampWorkers(settings.scanWorkers);

  window.vaultSetScanWorkers = function (n) {
    const v = clampWorkers(n);
    settings.scanWorkers = v;
    save();
    pushWorkers(v);
    syncScanWorkersUI(v);
    return v;
  };

  // Keep every visible stepper agreeing — whichever surface was used to change
  // it, the others are re-read from the same stored value.
  function syncScanWorkersUI(v) {
    document.querySelectorAll('[data-scan-workers], [data-setting-num="scanWorkers"]').forEach(el => {
      if (el.value !== String(v)) el.value = String(v);
    });
  }

  /* ── Privacy / streaming mode ────────────────────────────────────────────
     Toggles the `privacy-mode` class on <body>; settings.css does the hiding
     (display:none for path rows, blur for text that must keep its layout).
     No hover-to-reveal anywhere — accidental hovers on stream are the threat. */

  /* One category per body class. `privacy-mode` stays the master switch for
     anything generic; these say WHICH kinds of data go, so someone streaming a
     tagging session can keep their thumbnails and still lose their paths. */
  const PRIVACY_CLASS = {
    paths:         'pm-paths',
    notes:         'pm-notes',
    savedSearches: 'pm-searches',
    importFolders: 'pm-imports',
    thumbnails:    'pm-thumbs',
    fileNames:     'pm-names',
  };

  // Order is the order they appear in the dropdown and in its summary line.
  const PRIVACY_HIDE_ITEMS = [
    { key: 'paths',         label: 'File paths',                            short: 'Paths' },
    { key: 'notes',         label: 'Notes',                                 short: 'Notes' },
    { key: 'savedSearches', label: 'Saved searches',                        short: 'Saved searches' },
    { key: 'importFolders', label: 'Import folders',                        short: 'Import folders' },
    { key: 'thumbnails',    label: 'Thumbnails (blurred, no hover reveal)', short: 'Thumbnails' },
    { key: 'fileNames',     label: 'File names',                            short: 'File names' },
  ];

  // A category class is on only when privacy mode is on AND that box is ticked,
  // so turning privacy mode off clears all six in one go.
  function applyPrivacyHideClasses(on) {
    const hide = settings.privacyHide || {};
    for (const key of Object.keys(PRIVACY_CLASS)) {
      document.body.classList.toggle(PRIVACY_CLASS[key], !!on && !!hide[key]);
    }
  }

  function applyPrivacyMode(on) {
    document.body.classList.toggle('privacy-mode', !!on);
    applyPrivacyHideClasses(!!on);
    updateGearBadge();
    // Repaint tiles so the filename `title=` tooltip (unstylable by CSS) is
    // added/removed — cards.js reads the body class when it builds each tile.
    if (typeof renderResults === 'function') {
      try { renderResults(); } catch {}
    }
  }

  function setPrivacyMode(on, { toast = true } = {}) {
    settings.privacyMode = !!on;
    save();
    applyPrivacyMode(settings.privacyMode);
    syncPrivacyToggleUI();
    if (toast && typeof showToast === 'function') {
      showToast(settings.privacyMode ? '🔒 Privacy mode on' : 'Privacy mode off');
    }
  }

  /* ── Blurred grid ────────────────────────────────────────────────────────
     Independent of privacy mode, because they answer different questions:
     privacy mode hides YOUR data (paths, notes, searches) while thumbnails are
     deliberately left alone; this hides the imagery and nothing else. Wanting a
     library screenshot that is safe to publish means wanting both.

     Hover reveals a tile — that is the point of a blur rather than a hide, and
     it keeps the grid usable. But privacy mode's rule is that nothing reveals
     on hover, so with both on the blur stays put and the grid can be
     screenshotted without a stray cursor uncovering a frame. css/settings.css
     holds that combination. */

  function applyBlurThumbs(on) {
    document.body.classList.toggle('blur-thumbs', !!on);
  }

  // Apply the body classes the instant this script runs (before first render),
  // so a reload with privacy or blur on never flashes the real thing.
  load();
  if (settings.privacyMode) document.body.classList.add('privacy-mode');
  applyPrivacyHideClasses(settings.privacyMode);
  if (settings.blurThumbs) document.body.classList.add('blur-thumbs');

  /* ── Header gear button ──────────────────────────────────────────────────
     Appended to the END of .header-buttons (gamify prepends its chip; we
     append). Dim/low-key; a colored dot badge appears when privacy is on. */

  function buildGearButton() {
    const btns = document.querySelector('.header-buttons');
    if (!btns || document.getElementById('settingsGear')) return;
    const gear = document.createElement('button');
    gear.className = 'settings-gear';
    gear.id = 'settingsGear';
    gear.title = 'Settings';
    gear.setAttribute('aria-label', 'Settings');
    gear.innerHTML = `⚙<span class="settings-gear-badge" aria-hidden="true"></span>`;
    gear.addEventListener('click', openModal);
    btns.appendChild(gear);
    updateGearBadge();
  }

  function updateGearBadge() {
    const gear = document.getElementById('settingsGear');
    if (gear) gear.classList.toggle('privacy-on', !!settings.privacyMode);
  }

  /* ── Modal shell ─────────────────────────────────────────────────────────
     House modal pattern (overlay > modal > header/body). Own classes so it can
     diverge from the detail modal. Overlay-click + Escape close. */

  const SECTIONS = [
    { id: 'settings',  label: '⚙ Settings' },
    { id: 'library',   label: '🗂 Library' },
    { id: 'guides',    label: '📖 Guides' },
    { id: 'models',    label: '🧠 Models' },
    { id: 'seedpacks', label: '📦 Seed packs' },
    { id: 'about',     label: 'ℹ About' },
  ];

  function buildModalShell() {
    if (document.getElementById('settingsOverlay')) return;
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.id = 'settingsOverlay';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    overlay.innerHTML = `
      <div class="settings-modal" role="dialog" aria-label="Settings" onclick="event.stopPropagation()">
        <div class="settings-header">
          <h2>Settings</h2>
          <a class="settings-support" href="https://ko-fi.com/aericode" target="_blank" rel="noopener"
             title="Free forever — donations keep updates coming. Suggested $10, anything helps.">🌿 Support Vault</a>
          <button class="settings-close" id="settingsCloseBtn" title="Close" aria-label="Close">&times;</button>
        </div>
        <div class="settings-layout">
          <nav class="settings-nav" id="settingsNav">
            ${SECTIONS.map((s, i) => `
              <button class="settings-nav-item ${i === 0 ? 'active' : ''}" data-section="${s.id}">${s.label}</button>
            `).join('')}
          </nav>
          <div class="settings-body" id="settingsBody"></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector('#settingsCloseBtn').addEventListener('click', closeModal);
    overlay.querySelectorAll('.settings-nav-item').forEach(btn => {
      btn.addEventListener('click', () => selectSection(btn.dataset.section));
    });
  }

  function selectSection(id) {
    document.querySelectorAll('.settings-nav-item').forEach(b =>
      b.classList.toggle('active', b.dataset.section === id));
    const body = document.getElementById('settingsBody');
    if (!body) return;
    body.scrollTop = 0;
    body.innerHTML = RENDERERS[id] ? RENDERERS[id]() : '';
    if (id === 'settings') {
      wireSettingsSection();
      // The rows render from the cached server state so the modal opens
      // instantly; refresh them once the server answers, in case it restarted
      // or the vault was locked when we last asked.
      loadServerSettings().then(ok => { if (ok) syncServerRows(); });
    }
    if (id === 'library') wireLibrarySection();
    if (id === 'seedpacks') wireSeedpacksSection();
    if (id === 'about') loadAbout();
  }

  function openModal(section) {
    buildModalShell();
    const overlay = document.getElementById('settingsOverlay');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    selectSection(SECTIONS.some(s => s.id === section) ? section : 'settings');
  }

  // Deep link for anything outside this module that needs a specific section —
  // today the "files missing from disk" banner, which is only useful if it
  // lands the user on the panel that fixes it.
  window.vaultOpenSettings = openModal;

  function closeModal() {
    const overlay = document.getElementById('settingsOverlay');
    if (!overlay || !overlay.classList.contains('active')) return false;
    overlay.classList.remove('active');
    // Only release the scroll lock if no other overlay still needs it.
    if (!document.querySelector('.modal-overlay.active, .media-player-overlay.active')) {
      document.body.style.overflow = '';
    }
    return true;
  }

  function isOpen() {
    const overlay = document.getElementById('settingsOverlay');
    return !!(overlay && overlay.classList.contains('active'));
  }

  /* ── Section: Settings (working toggles) ─────────────────────────────────── */

  // `value` overrides the localStorage lookup — that's how the server-owned
  // rows render from the cached server state instead.
  function toggleRow({ key, title, desc, planned = false, disabled = false, value }) {
    const on = planned ? false : (value !== undefined ? !!value : !!settings[key]);
    return `
      <label class="settings-toggle ${disabled || planned ? 'is-disabled' : ''}">
        <span class="settings-toggle-text">
          <span class="settings-toggle-title">${title}${planned ? ` <span class="settings-tag">planned</span>` : ''}</span>
          <span class="settings-toggle-desc">${desc}</span>
        </span>
        <input type="checkbox" data-setting="${key}" ${on ? 'checked' : ''} ${disabled || planned ? 'disabled' : ''}>
        <span class="settings-switch" aria-hidden="true"></span>
      </label>`;
  }

  // Same skeleton as toggleRow, with a number input where the switch sits, so
  // the title/desc column keeps its alignment down the whole list.
  function numberRow({ key, title, desc, min, max, value, unit = '' }) {
    const v = value !== undefined ? value : settings[key];
    return `
      <label class="settings-toggle">
        <span class="settings-toggle-text">
          <span class="settings-toggle-title">${title}</span>
          <span class="settings-toggle-desc">${desc}</span>
        </span>
        <span class="settings-num-wrap">
          <input class="settings-num" type="number" min="${min}" max="${max}" step="1"
                 data-setting-num="${key}" value="${v}">
          ${unit ? `<span class="settings-num-unit">${unit}</span>` : ''}
        </span>
      </label>`;
  }

  const PLANNED = [
    { key: 'p_confirmTrash',title: 'Confirm before trash', desc: 'Ask before moving a file to the trash.' },
    { key: 'p_defaultSort', title: 'Default sort / filter on open', desc: 'Start every session with a saved sort and filter preset.' },
    { key: 'p_perPage',     title: 'Items per page', desc: 'Choose how many tiles load per page.' },
  ];

  /* The "Hide while on" dropdown that sits under the privacy toggle. A
     <details> rather than a stack of six more toggle rows: the list is only
     interesting while you are setting streaming up, and six extra rows would
     bury everything else in Preferences. The summary carries the answer, so it
     never has to be opened just to check what is covered. */

  function privacyHideSummary() {
    const on = PRIVACY_HIDE_ITEMS.filter(i => settings.privacyHide?.[i.key]).map(i => i.short);
    return on.length ? on.join(', ') : 'Nothing';
  }

  function privacyHideRow() {
    return `
      <details class="settings-dd">
        <summary>
          <span class="settings-dd-caret" aria-hidden="true">▾</span>
          <span>Hide while on: <b id="privacyHideSummary">${esc(privacyHideSummary())}</b></span>
        </summary>
        <div class="settings-dd-body">
          ${PRIVACY_HIDE_ITEMS.map(i => `
            <label class="settings-dd-item">
              <input type="checkbox" data-privacy-hide="${i.key}" ${settings.privacyHide?.[i.key] ? 'checked' : ''}>
              <span>${i.label}</span>
            </label>`).join('')}
        </div>
      </details>`;
  }

  function RENDERERS_settings() {
    return `
      <h3 class="settings-h">Preferences</h3>
      ${toggleRow({
        key: 'privacyMode',
        title: 'Privacy / streaming mode',
        desc: 'Hide personal data for screen-sharing. Pick what to hide below. Shortcut: Ctrl+Shift+H.',
      })}
      ${privacyHideRow()}
      ${toggleRow({
        key: 'blurThumbs',
        title: 'Blur thumbnails in the library',
        desc: 'Blur every tile in the grid. Point at one to see it — unless privacy mode is also on, in which case nothing reveals on hover and the grid is safe to screenshot.',
      })}
      ${toggleRow({
        key: 'resumePlayback',
        title: 'Resume playback positions',
        desc: 'Seek back to where you left off when reopening a video or audio file. Positions are always saved; this only controls the auto-seek.',
      })}
      ${toggleRow({
        key: 'restoreSession',
        title: 'Restore last session on open',
        desc: 'When the app launches, reopen the last media you played — paused.',
      })}
      ${toggleRow({
        key: 'queueLoop',
        title: 'Start over after the last file',
        desc: 'When the last file in the list ends, go back to the first one instead of stopping. Applies when the per-file Loop button is off.',
      })}
      ${numberRow({
        key: 'scanWorkers',
        title: 'AI scan workers',
        desc: 'How many files the local vision model scans at once after an import. Higher is faster but needs more VRAM — 1–8, default 2.',
        min: 1, max: 8,
      })}
      ${toggleRow({
        key: 'gamifyHidden',
        title: 'Hide 🏆 Obsession Score',
        desc: 'Removes the score chip and its point/level toasts from the library. Scoring carries on in the background, so unhiding shows your real history rather than a gap — nothing is deleted. Entirely offline either way.',
      })}

      <h3 class="settings-h">AI model downloads</h3>
      <p class="settings-note">${modelDl.envAllows
        ? (modelDl.explicit
          ? 'Pre-approved by <code>SUB_ALLOW_DOWNLOADS=1</code> in your environment — unset it to be asked per model instead.'
          : 'Subtitles, translation and speaker detection each need a model fetched once from Hugging Face. Vault asks before <b>each one</b> — approving the transcription model doesn\'t approve a translation pack. Nothing about your media is ever uploaded.')
        : 'Turned off by <code>SUB_ALLOW_DOWNLOADS=0</code> or <code>VAULT_OFFLINE=1</code> — the environment overrides anything set here.'}</p>
      ${modelConsentRows()}

      <h3 class="settings-h">Vault security</h3>
      <p class="settings-note" id="settingsSecNote">${server.encrypted
        ? 'Your library is encrypted. These control how it locks itself and how you get back in.'
        : 'No database password set yet — click the padlock in the header to create one. Auto-lock does nothing until then.'}</p>
      ${numberRow({
        key: 'autolockMinutes',
        value: server.autolockMinutes,
        title: 'Auto-lock after',
        desc: 'Lock the vault after this many minutes with no activity. <b>0 = never</b>. A running AI scan keeps it awake rather than locking mid-file.',
        min: 0, max: 1440, unit: 'min',
      })}
      <!-- "Hold to unlock" row removed deliberately (unlock is a single click now); the unlockHoldSeconds logic and its handler below stay, so a stored value still applies. -->

      <h3 class="settings-h settings-h-planned">Planned</h3>
      <p class="settings-note">A visible roadmap — these are not wired up yet.</p>
      ${PLANNED.map(p => toggleRow({ ...p, planned: true })).join('')}
    `;
  }

  function wireSettingsSection() {
    const body = document.getElementById('settingsBody');
    if (!body) return;
    body.querySelectorAll('input[data-setting]').forEach(input => {
      if (input.disabled) return;
      input.addEventListener('change', async () => {
        const key = input.dataset.setting;
        if (key === 'privacyMode') {
          setPrivacyMode(input.checked);
        } else if (key === 'blurThumbs') {
          settings.blurThumbs = input.checked;
          save();
          applyBlurThumbs(settings.blurThumbs);
          showToast?.(settings.blurThumbs ? '🫥 Library blurred' : 'Library blur off');
        } else if (key === 'queueLoop') {
          settings.queueLoop = input.checked;
          save();
          showToast?.(settings.queueLoop
            ? '🔁 The list starts over after the last file'
            : 'The list stops after the last file');
        } else if (key.startsWith('modelConsent:')) {
          const modelKey = key.slice('modelConsent:'.length);
          const allow = input.checked;
          input.disabled = true;
          try {
            const r = await fetch('/api/settings/model-downloads', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ key: modelKey, allow }),
            });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
            modelDl = { ...modelDl, ...d };
            showToast?.(allow ? '⬇ Approved for download' : 'Not approved — nothing will be fetched');
          } catch (err) {
            input.checked = !allow;
            showToast?.('⚠ ' + err.message);
          } finally {
            input.disabled = !modelDl.envAllows || modelDl.explicit;
          }
        } else if (key === 'gamifyHidden') {
          // Purely presentational, so no server round-trip and no reload — the
          // chip goes immediately and scoring never notices.
          settings.gamifyHidden = input.checked;
          save();
          window.vaultApplyGamifyHidden?.(settings.gamifyHidden);
          showToast?.(settings.gamifyHidden
            ? 'Obsession Score hidden — still tracking'
            : '🏆 Obsession Score shown');
        } else {
          settings[key] = input.checked;
          save();
        }
      });
    });
    // The "Hide while on" checkboxes. Re-applying the body classes on every
    // change means a tick lands live on the page behind the modal — which is
    // the whole point: you are setting this up while looking at what leaks.
    body.querySelectorAll('input[data-privacy-hide]').forEach(input => {
      input.addEventListener('change', () => {
        settings.privacyHide = {
          ...settings.privacyHide,
          [input.dataset.privacyHide]: input.checked,
        };
        save();
        applyPrivacyMode(settings.privacyMode);
        const sum = document.getElementById('privacyHideSummary');
        if (sum) sum.textContent = privacyHideSummary();
      });
    });
    // Number rows: the input is free-typed, so re-read the clamped value back
    // into the field — a typed "99" or "" must visibly settle on what was saved.
    body.querySelectorAll('input[data-setting-num]').forEach(input => {
      input.addEventListener('change', async () => {
        const key = input.dataset.settingNum;
        if (key === 'scanWorkers') {
          input.value = window.vaultSetScanWorkers(input.value);
        } else if (key === 'autolockMinutes') {
          const n = clampInt(input.value, 0, 1440, server.autolockMinutes);
          try {
            const r = await pushServerSetting({ autolockMinutes: n });
            input.value = r.autolockMinutes;
            showToast?.(r.autolockMinutes > 0
              ? `🔒 Auto-lock after ${r.autolockMinutes} min`
              : '🔓 Auto-lock off');
          } catch (err) {
            input.value = server.autolockMinutes;     // snap back to what's live
            showToast?.('⚠ ' + err.message);
          }
        } else if (key === 'unlockHoldSeconds') {
          const n = clampInt(input.value, 0, 10, settings.unlockHoldSeconds);
          settings.unlockHoldSeconds = n;
          save();
          input.value = n;
          showToast?.(n === 0 ? 'Unlock is now a single click' : `Hold the padlock for ${n}s to unlock`);
        }
      });
    });
  }

  // Shared clamp for the free-typed number rows: anything unreadable ('' from a
  // blank field, letters) settles back on the value that's actually in force.
  function clampInt(raw, min, max, fallback) {
    if (raw === '' || raw == null) return fallback;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // Patch the server-owned rows in place rather than re-rendering the section —
  // a re-render mid-edit would yank the field out from under the cursor.
  function syncServerRows() {
    const body = document.getElementById('settingsBody');
    if (!body) return;
    // (Obsession Score is no longer here — its toggle only hides the UI now,
    // which is a browser preference, so it needs no server sync.)
    const a = body.querySelector('input[data-setting-num="autolockMinutes"]');
    if (a && document.activeElement !== a) a.value = String(server.autolockMinutes);
    const note = document.getElementById('settingsSecNote');
    if (note) {
      note.innerHTML = server.encrypted
        ? 'Your library is encrypted. These control how it locks itself and how you get back in.'
        : 'No database password set yet — click the padlock in the header to create one. Auto-lock does nothing until then.';
    }
  }

  // Keep the in-modal privacy checkbox + gear badge in sync when the toggle is
  // flipped from the keyboard shortcut while the modal is open.
  function syncPrivacyToggleUI() {
    const cb = document.querySelector('#settingsBody input[data-setting="privacyMode"]');
    if (cb) cb.checked = !!settings.privacyMode;
  }

  /* ── Section: Guides ─────────────────────────────────────────────────────── */

  function guide(summary, ...paras) {
    return `<details class="settings-acc"><summary>${summary}</summary>${paras.map(p => `<p>${p}</p>`).join('')}</details>`;
  }

  function RENDERERS_guides() {
    return `
      <h3 class="settings-h">Guides</h3>
      <p class="settings-note">Short how-tos for the main features. See <code>SETUP.md</code> (next to the app, and on GitHub) for the full docs.</p>
      ${guide('🔍 AI scanning',
        'Vault describes, tags and titles your media with a local vision model. Point it at <b>LM Studio (default)</b> or <b>Ollama</b> serving a vision model - see the Models section for picks by GPU size, then drag folders or files into the window to scan them. Nothing is uploaded - the model runs on your machine.',
        `Getting LM Studio: <a href="https://lmstudio.ai/download#lm-studio-download-heading" target="_blank" rel="noopener">lmstudio.ai/download</a> - you want the classic <b>LM Studio</b> ("Chat interface and programmable API"), <b>not the new Bionic</b> agent listed above it. Download a vision model from <b>Model Search</b> in LM Studio's left sidebar, then open the <b>Developer</b> tab and load it there. Turn on the toggle for manually choosing load parameters, set <b>context length ≈ 64k</b> (the ~4k default is too small for vision), and load. Finally, make sure the local server shows <b>Status: Running</b>. SETUP.md has the click-by-click version.`)}
      ${guide('🧠 Semantic search',
        'Tick <b>🧠 Semantic</b> next to the search box to find media by meaning instead of keywords ("crimson" finds red images). It uses a local embedding model. New scans embed automatically.')}
      ${guide('🎵 Music ID',
        'Fingerprint files (Chromaprint) to identify the songs inside them - select files in the Library then <b>🎵 Music ID</b>, or use the info sidebar. Right after fingerprinting, a file is auto-matched against every known song and every other fingerprinted file. You can teach it songs by tagging a segment, and import Seed packs to name tracks without needing the audio. Seed packs are planned for future release to pre-load song databases.')}
      ${guide('🥁 Beat bar',
        'A live beat-detection overlay for videos: the 🥁 control analyzes the audio track in-browser and renders a scrolling beat visualizer synced to playback. Sensitivity, playhead and icon styling are all adjustable, and its position is remembered per video.')}
      ${guide('💬 Subtitles',
        'Generate subtitles/transcripts with a local transcription tool. Works across scan modes, including foreign-clip translation. Tick <b>💬 Subtitles</b> in search to also match subtitle text. Non-English languages are auto-detected and translated. First time translations of non-English languages will ask to download translation models. Falls back to AI translation.')}
      ${guide('🎮 Games',
        'The Games tab turns library videos into games. <b>Reel Order</b> - test your memory of your videos and reassemble randomized clips on a timeline. <b>Frame Fit</b> - turn and video into a jigsaw puzzle(<800 pieces).')}
      ${guide('🏆 Obsession Score',
        'A local gamification tracker - points, streaks, levels, quests and achievements, all scored from what you actually watch. Fully offline; it needs no AI model and no setup, so it works from the first launch.',
        'Not keen on it? <b>Settings → Hide 🏆 Obsession Score</b> removes the chip and its toasts. Scoring keeps running underneath, so unhiding later shows your real history instead of a gap - nothing is deleted either way. To stop it entirely, start Vault with <code>--no-gamify</code>.')}
      ${guide('🔒 Encryption',
        'Click the vault in the top left to set a database password and encrypt the library. Vault auto-locks after an idle timeout(default 30min) and requires the password to resume.')}
    `;
  }

  /* ── Section: Models ─────────────────────────────────────────────────────── */

  function RENDERERS_models() {
    return `
      <h3 class="settings-h">Model recommendations by GPU size</h3>
      <p class="settings-note">Vision model = scan quality. Quantized (Q4) versions are the sweet spot. ~64k token context is required to handle vision reliably. </p>
      <div class="settings-table-wrap">
        <table class="settings-table">
          <thead>
            <tr><th>VRAM</th><th>Vision model (scanning)</th><th>Whisper (subtitles)</th></tr>
          </thead>
          <tbody>
            <tr><td>6–8 GB</td><td>minicpm-v-4.6-abliterated-max</td><td><code>WHISPER_MODEL=small</code></td></tr>
            <tr><td>10–12 GB</td><td>qwen3.5-4b-uncensored-hauhaucs-aggressive@q4_k_m</td><td><code>WHISPER_MODEL=small</code></td></tr>
            <tr><td>16 GB</td><td>qwen3.5-9b-uncensored-hauhaucs-aggressive@q8_0 + 2-4 workers</td><td>default</td></tr>
            <tr><td>24 GB+</td><td>qwen3.5-9b-uncensored-hauhaucs-aggressive@q4_k_m + 2-4 workers</td><td>default</td></tr>
          </tbody>
        </table>
      </div>
      <p class="settings-note">Semantic search embeddings are tiny - <code>nomic-embed-text</code> (~0.5 GB) runs anywhere.</p>
    `;
  };

  /* ── Section: Library (move / relink) ─────────────────────────────────────
     The viewer's front end for `node vault.js migrate`. A library's file
     identity is its path, so moving it to another drive makes every record
     point at nothing — and a rescan to rebuild metadata that already exists
     can cost days of GPU time. This repoints the paths instead.

     Two-step on purpose. Nothing here is destructive in the "files are gone"
     sense, but absorbing a stub DELETES a row, and a mis-typed prefix over a
     100k library is not something to discover after the fact. So: Preview
     runs the planner and shows exactly what would happen, Apply re-runs it
     server-side and writes it, and editing an input invalidates the preview
     so you can never apply a plan you did not look at. */

  const esc = (s) => (typeof escapeHtml === 'function'
    ? escapeHtml(String(s ?? ''))
    : String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

  // Per-card: the inputs a report was produced from, so a later edit can
  // disable Apply. null = no valid preview. The panel shows one card ('auto');
  // the other two keys are the modes the planner still exposes, kept so
  // restoring the two-card layout (see MIGRATE-TWO-CARD-SPEC.md) is a UI edit
  // and nothing more.
  const migState = { auto: null, prefix: null, relink: null };

  function migInputs(mode) {
    return (mode === 'relink' || mode === 'auto')
      ? { mode, newRoot: (document.getElementById('migNewRoot')?.value || '').trim() }
      : {
          mode,
          oldPrefix: (document.getElementById('migOldPrefix')?.value || '').trim(),
          newPrefix: (document.getElementById('migNewPrefix')?.value || '').trim(),
        };
  }

  function RENDERERS_library() {
    return `
      <h3 class="settings-h">Move / relink library</h3>
      <p>Moved your collection? Don't re-scan it. Tell Vault where the files
      went and it updates its records to match. Every tag, note, star and view
      count carries over untouched.</p>
      <p class="settings-note">Nothing is moved, copied or deleted on your
      drives. Only Vault's own records change. A record updates only when the
      file is verified at its new home, and anything Vault isn't sure about is
      left as-is for you to review. Already dragged the new folder in? The empty
      ⏳ placeholder entries are merged away automatically.</p>

      ${migCard({
        mode: 'prefix',
        title: 'Quick move',
        blurb: 'Same folders, new place. Use this when only the start of the path changed. Instant.',
        fields: `
          ${migField('migOldPrefix', 'Old path prefix', 'C:\\Media')}
          ${migField('migNewPrefix', 'New path prefix', 'D:\\Media')}`,
      })}

      <button class="mig-expander" id="migDeepToggle" type="button" aria-expanded="false"
              aria-controls="migDeepSection">
        <span class="mig-chev" aria-hidden="true">&#9656;</span>
        <span>Can't use quick move? Deep search finds renamed and shuffled files</span>
      </button>
      <div class="mig-deep" id="migDeepSection" hidden>
        ${migCard({
          mode: 'auto',
          title: 'Deep search',
          blurb: 'Point this at your new main folder. Vault scans every file in it (subfolders included) and matches your records to what it finds, even renamed files. Every match is checked against the file contents. Slow on big drives.',
          fields: migField('migNewRoot', 'Search this folder', 'D:\\Media'),
        })}
      </div>

      <h3 class="settings-h">Playback support</h3>
      <div class="mig-card" id="pbCard">
        <div class="mig-card-title">Check playback support for all files</div>
        <p class="settings-note">Reads the video and audio format of files
        scanned before this version, so Vault knows which ones play directly,
        which need converting, and which cannot play.</p>
        <div class="mig-actions">
          <button class="settings-btn" id="pbCheckBtn" type="button">Check now</button>
          <span class="mig-status"></span>
        </div>
        <div class="mig-progress" style="display:none">
          <div class="mig-bar"><div class="mig-bar-fill"></div></div>
          <div class="mig-bar-stats"></div>
        </div>
        <div class="mig-report" id="pbResult"></div>
      </div>
    `;
  }

  /* ── The playback check ─────────────────────────────────────────────────
     One button over POST /api/playback/backfill, which reads each old file's
     video and audio format with ffprobe. Same job shape as the migrate job,
     so the same progress bar reads it. Two things happen when it finishes:
     the three counts go on screen, and the library is reloaded, so every
     extension chip and every tile answers from the codecs instead of from the
     file extension without the user reaching for F5. */

  let pbPollTimer = null;
  let pbRateWindow = [];

  function pbCardEl() { return document.getElementById('pbCard'); }

  async function pbFetchJob() {
    try {
      const resp = await fetch('/api/playback/backfill');
      if (!resp.ok) return null;
      return await resp.json();
    } catch { return null; }
  }

  function pbStopPolling() {
    if (pbPollTimer) { clearInterval(pbPollTimer); pbPollTimer = null; }
  }

  function pbStartPolling() {
    if (pbPollTimer) return;
    pbPollTimer = setInterval(pbPollOnce, 1000);
  }

  /** Files per second over a short window, or null until it means something. */
  function pbRate(s) {
    const last = pbRateWindow[pbRateWindow.length - 1];
    if (!last || last.processed !== s.processed) {
      pbRateWindow.push({ processed: s.processed, at: Date.now() });
      if (pbRateWindow.length > MIG_RATE_SAMPLES) pbRateWindow.shift();
    }
    if (pbRateWindow.length < 2) return null;
    const a = pbRateWindow[0];
    const b = pbRateWindow[pbRateWindow.length - 1];
    const dt = (b.at - a.at) / 1000;
    const dp = b.processed - a.processed;
    if (dt <= 0 || dp <= 0) return null;
    return Math.round(dp / dt);
  }

  function pbRenderProgress(card, s) {
    migSetStatus(card, 'Checking files');
    const box = card.querySelector('.mig-progress');
    const fill = card.querySelector('.mig-bar-fill');
    const stats = card.querySelector('.mig-bar-stats');
    if (!box || !fill || !stats) return;
    box.style.display = '';

    // The row count is only known once the job has asked the database for it,
    // so the first tick gets a moving bar rather than a fraction of nothing.
    const determinate = s.total > 0;
    box.classList.toggle('is-indeterminate', !determinate);
    fill.style.width = determinate
      ? `${Math.max(0, Math.min(100, (s.processed / s.total) * 100)).toFixed(1)}%`
      : '';

    const rate = pbRate(s);
    const bits = [];
    if (determinate) bits.push(`${s.processed.toLocaleString()} / ${s.total.toLocaleString()}`);
    if (rate != null) bits.push(`${rate.toLocaleString()} files/s`);
    bits.push(`${migHuman(s.elapsedMs)} elapsed`);
    if (s.etaMs != null) bits.push(`about ${migHuman(s.etaMs)} left`);
    stats.textContent = bits.join(' · ');
  }

  function pbLock(card, busy) {
    const btn = card.querySelector('#pbCheckBtn');
    if (btn) btn.disabled = !!busy;
  }

  function pbRenderResult(card, s) {
    pbLock(card, false);
    migSetStatus(card, s.error ? 'Check failed' : 'Done', s.error ? 'mig-bad' : 'mig-good');
    const box = card.querySelector('.mig-progress');
    if (box) { box.style.display = 'none'; box.classList.remove('is-indeterminate'); }

    const out = card.querySelector('#pbResult');
    if (!out) return;
    if (s.error) {
      out.innerHTML = `<p class="settings-note">${esc(s.error)}</p>`;
      return;
    }
    if (!s.checked) {
      out.innerHTML = '<p class="settings-note">Every file had already been checked.</p>';
      return;
    }
    const line = `${s.checked.toLocaleString()} checked: `
      + `${s.plays.toLocaleString()} play directly, `
      + `${s.converts.toLocaleString()} play via conversion, `
      + `${s.cannot.toLocaleString()} cannot play.`;
    // The library grid can already focus an arbitrary set of ids, so this is a
    // real filter rather than a search box guess.
    const showThem = s.cannot > 0
      ? ' <button class="settings-link" id="pbShowFailed" type="button">Show them</button>'
      : '';
    out.innerHTML = `<p class="settings-note">${esc(line)}${showThem}</p>`;
    out.querySelector('#pbShowFailed')?.addEventListener('click', pbShowUnplayable);
  }

  /** Focus the library grid on the files this browser cannot play. */
  function pbShowUnplayable() {
    if (typeof allMedia === 'undefined' || typeof mediaPlaybackState !== 'function') return;
    const ids = allMedia.filter(m => mediaPlaybackState(m).state === 'no').map(m => m.id);
    if (!ids.length) {
      if (typeof showToast === 'function') showToast('Nothing to show');
      return;
    }
    closeModal();
    window.vaultShowMediaIds(ids, 'files that cannot play');
  }

  async function pbPollOnce() {
    const s = await pbFetchJob();
    const card = pbCardEl();
    // Panel closed or re-rendered: the job keeps going, and the next render of
    // this section re-attaches to it.
    if (!card) { pbStopPolling(); return; }
    if (!s || s.idle) { pbStopPolling(); return; }
    if (s.running) { pbLock(card, true); pbRenderProgress(card, s); return; }
    pbStopPolling();
    pbRenderResult(card, s);
    // The codec columns just changed for potentially every row, and the chips
    // and the tiles are computed from them.
    if (typeof loadDatabase === 'function') {
      loadDatabase().then(() => { if (typeof applyFilters === 'function') applyFilters(); });
    }
  }

  function wirePlaybackCheck() {
    pbStopPolling();
    pbRateWindow = [];
    const card = pbCardEl();
    if (!card) return;
    card.querySelector('#pbCheckBtn')?.addEventListener('click', async () => {
      pbLock(card, true);
      pbRateWindow = [];
      const out = card.querySelector('#pbResult');
      if (out) out.innerHTML = '';
      migSetStatus(card, 'Starting');
      try {
        const resp = await fetch('/api/playback/backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!resp.ok && resp.status !== 409) throw new Error(`Server returned ${resp.status}`);
      } catch {
        pbLock(card, false);
        migSetStatus(card, 'Could not start the check', 'mig-bad');
        return;
      }
      pbStartPolling();
      pbPollOnce();
    });

    // A check started before this panel was opened, or from another tab, is
    // still the same one-slot job: pick it up rather than pretend it is idle.
    pbFetchJob().then(s => {
      if (!s || s.idle) return;
      const c = pbCardEl();
      if (!c) return;
      if (s.running) { pbLock(c, true); pbRenderProgress(c, s); pbStartPolling(); }
      else pbRenderResult(c, s);
    });
  }

  /* ── The deep-search expander ─────────────────────────────────────────────
     Quick move is first and always visible because it is the common case and
     it is instant: it rewrites paths by string surgery and never reads a byte.
     Deep search walks the whole drive, which on a 60k library over a slow disk
     is minutes of work, so it does not get to be the thing you reach for by
     default. It stays one click away, and remembers whether you left it open. */

  function migDeepIsOpen() {
    const sec = document.getElementById('migDeepSection');
    return !!(sec && !sec.hidden);
  }

  function migSetDeepOpen(open, { persist = true } = {}) {
    const sec = document.getElementById('migDeepSection');
    const btn = document.getElementById('migDeepToggle');
    if (!sec || !btn) return;
    sec.hidden = !open;
    btn.setAttribute('aria-expanded', String(!!open));
    btn.classList.toggle('is-open', !!open);
    const chev = btn.querySelector('.mig-chev');
    if (chev) chev.innerHTML = open ? '&#9662;' : '&#9656;';
    if (persist) { settings.libraryDeepOpen = !!open; save(); }
  }

  function migField(id, label, placeholder) {
    return `
      <label class="mig-field">
        <span class="mig-field-label">${label}</span>
        <input type="text" id="${id}" class="mig-input" spellcheck="false"
               autocomplete="off" placeholder="${esc(placeholder)}">
      </label>`;
  }

  function migCard({ mode, title, blurb, fields }) {
    return `
      <div class="mig-card" data-mig-mode="${mode}">
        <div class="mig-card-title">${title}</div>
        <p class="settings-note">${blurb}</p>
        ${fields}
        <div class="mig-actions">
          <button class="settings-btn" data-mig-act="preview">Preview</button>
          <button class="settings-btn mig-apply" data-mig-act="apply" disabled>Apply</button>
          <span class="mig-status"></span>
        </div>
        <div class="mig-progress" style="display:none">
          <div class="mig-bar"><div class="mig-bar-fill"></div></div>
          <div class="mig-bar-stats"></div>
        </div>
        <div class="mig-confirm" style="display:none"></div>
        <div class="mig-report"></div>
      </div>`;
  }

  function wireLibrarySection() {
    // Fresh render means the report area is empty again — drop any saved
    // preview so retyping the same paths can't re-arm Apply against a report
    // that is no longer on screen. migAttach() below then puts back whatever
    // the SERVER says is true, report and all, so the invariant holds: Apply
    // is only ever armed alongside the report it was armed against.
    Object.keys(migState).forEach(k => { migState[k] = null; });
    migStopPolling();
    wirePlaybackCheck();
    document.querySelectorAll('.mig-card').forEach(card => {
      const mode = card.dataset.migMode;
      // Any edit locks Apply again — it must never write a plan the user has
      // not seen. The report is KEPT rather than dropped: typing a character
      // and deleting it should not cost a re-preview, and Apply re-checks the
      // signature (and the server re-plans) before anything is written.
      card.querySelectorAll('.mig-input').forEach(inp => {
        inp.addEventListener('input', () => {
          const saved = migState[mode];
          if (!saved) return;
          const matches = JSON.stringify(migInputs(mode)) === saved.signature;
          // An open confirm bar describes the OLD inputs — retract it.
          if (!matches && card.querySelector('.mig-confirm').style.display !== 'none') {
            migHideConfirmBar(card, mode);
          }
          card.querySelector('.mig-apply').disabled = !matches;
          migSetStatus(card, matches ? saved.status : 'Inputs changed. Preview again.');
        });
      });
      card.querySelector('[data-mig-act="preview"]')
        .addEventListener('click', () => migRun(card, mode, false));
      card.querySelector('[data-mig-act="apply"]')
        .addEventListener('click', () => migRequestApply(card, mode));
      migHideProgress(card);
    });

    // Restore the expander to however it was left, then wire it.
    migSetDeepOpen(!!settings.libraryDeepOpen, { persist: false });
    const toggle = document.getElementById('migDeepToggle');
    if (toggle) toggle.addEventListener('click', () => migSetDeepOpen(!migDeepIsOpen()));

    migResetRate();
    migAttach();
  }

  /* ── Jobs: progress that survives you closing the panel ───────────────────
     A migrate runs server-side as a single-slot job, so this panel is a VIEW
     of it rather than its owner. Closing the modal, switching sections, or
     reloading the page cannot cancel anything — and a run that finished while
     nobody was looking still has its report waiting. On every render of this
     section we ask the server what is true and rebuild from that. */

  let migPollTimer = null;

  function migCardFor(mode) {
    return document.querySelector(`.mig-card[data-mig-mode="${mode}"]`);
  }

  /** "1m 12s" / "3h 04m" / "8s" — mirrors migrate.js humanDuration. */
  function migHuman(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 1) return '<1s';
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  }

  const MIG_PHASES = {
    starting: 'Starting', walking: 'Indexing folder',
    matching: 'Matching records', writing: 'Moving records', done: 'Finishing up',
  };

  /**
   * Freeze a card while its job runs.
   *
   * The INPUTS are frozen too, not just the buttons. Leaving them editable let
   * you retype the path mid-run, and since the finished report is armed
   * against whatever the boxes say when it lands, Apply could end up pointing
   * at a plan that was computed for somewhere else entirely.
   */
  function migLock(card, locked) {
    card.querySelectorAll('.mig-actions .settings-btn').forEach(b => { b.disabled = locked; });
    card.querySelectorAll('.mig-input').forEach(i => { i.disabled = locked; });
  }

  /** Re-derive Apply from the saved preview + the inputs as they stand now. */
  function migSyncApply(card, mode) {
    card.querySelector('.mig-apply').disabled =
      !migState[mode] || migState[mode].signature !== JSON.stringify(migInputs(mode));
  }

  /**
   * First sighting of this finished job? Claims it if so.
   * A job with no id (shouldn't happen) is treated as new but never latched,
   * so a missing id can't wedge the notification off permanently.
   */
  const SS_MIG_NOTIFIED = 'vault_migrate_notified_job';
  function migClaimNotify(jobId) {
    if (!jobId) return true;
    try {
      if (sessionStorage.getItem(SS_MIG_NOTIFIED) === jobId) return false;
      sessionStorage.setItem(SS_MIG_NOTIFIED, jobId);
    } catch { /* private mode — notify every time rather than never */ }
    return true;
  }

  /* ── Throughput ───────────────────────────────────────────────────────────
     Rate is computed here rather than server-side: the server would have to
     keep a window per client for no benefit, and the poll interval already
     gives a natural sampling rate.

     A rolling window rather than processed/elapsed: the instant rate swings
     wildly (a run of cached files then a run of cold ones), and a number that
     jumps between 200 and 4,000 every second reads as broken. Averaging the
     whole run instead would be stable but wrong, still quoting the fast start
     long after the run has slowed down. Five samples is about five seconds of
     history, which settles the jitter without lying about the present.

     The window resets on a phase change because `processed` counts different
     things in each phase (files while walking, records while matching), so
     carrying samples across the boundary would produce a garbage delta. */

  const MIG_RATE_SAMPLES = 5;
  let migRateWindow = [];
  let migRatePhase = null;

  function migResetRate() { migRateWindow = []; migRatePhase = null; }

  /** @returns {number|null} files per second, or null until it means something */
  function migRate(s) {
    if (s.phase !== migRatePhase) { migRateWindow = []; migRatePhase = s.phase; }
    const now = Date.now();
    const last = migRateWindow[migRateWindow.length - 1];
    if (!last || last.processed !== s.processed) {
      migRateWindow.push({ processed: s.processed, at: now });
      if (migRateWindow.length > MIG_RATE_SAMPLES) migRateWindow.shift();
    }
    if (migRateWindow.length < 2) return null;      // one sample is not a rate
    const a = migRateWindow[0];
    const b = migRateWindow[migRateWindow.length - 1];
    const dt = (b.at - a.at) / 1000;
    const dp = b.processed - a.processed;
    if (dt <= 0 || dp <= 0) return null;
    return Math.round(dp / dt);
  }

  function migRenderProgress(card, s) {
    // An APPLY re-verifies the whole plan server-side before writing, and that
    // re-check walks every candidate again. Showing its count as the move
    // ("checking 600" when only 25 records will change) reads as the wrong
    // thing happening, so before the writing phase an apply shows a quiet
    // preparing state with no counts. The writing phase then counts only the
    // records actually changing.
    const preparing = s.kind === 'apply' && s.phase !== 'writing' && s.phase !== 'done';
    migSetStatus(card, preparing ? 'Preparing the move' : (MIG_PHASES[s.phase] || s.phase));

    const box = card.querySelector('.mig-progress');
    const fill = card.querySelector('.mig-bar-fill');
    const stats = card.querySelector('.mig-bar-stats');
    if (!box || !fill || !stats) return;
    box.style.display = '';

    if (preparing) {
      box.classList.add('is-indeterminate');
      fill.style.width = '';
      stats.textContent = `${migHuman(s.elapsedMs)} elapsed`;
      return;
    }

    const rate = migRate(s);
    const determinate = s.total > 0;
    // The folder walk cannot know its own size until it ends, so it gets a
    // moving bar rather than a fraction of an unknown.
    box.classList.toggle('is-indeterminate', !determinate);
    fill.style.width = determinate
      ? `${Math.max(0, Math.min(100, (s.processed / s.total) * 100)).toFixed(1)}%`
      : '';

    const bits = [];
    if (determinate) bits.push(`${s.processed.toLocaleString()} / ${s.total.toLocaleString()}`);
    else if (s.processed > 0) bits.push(`${s.processed.toLocaleString()} files found`);
    if (rate != null) bits.push(`${rate.toLocaleString()} files/s`);
    bits.push(`${migHuman(s.elapsedMs)} elapsed`);
    // ETA stays hidden until the server has enough of a sample to mean it.
    if (s.etaMs != null) bits.push(`about ${migHuman(s.etaMs)} left`);
    stats.textContent = bits.join(' · ');
  }

  function migHideProgress(card) {
    const box = card.querySelector('.mig-progress');
    if (!box) return;
    box.style.display = 'none';
    box.classList.remove('is-indeterminate');
    const stats = card.querySelector('.mig-bar-stats');
    if (stats) stats.textContent = '';
  }

  /** Put the job's own inputs back into the card — this tab may never have typed them. */
  function migRestoreInputs(s) {
    const set = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.value = v; };
    if (s.mode === 'relink' || s.mode === 'auto') set('migNewRoot', s.inputs.newRoot);
    else { set('migOldPrefix', s.inputs.oldPrefix); set('migNewPrefix', s.inputs.newPrefix); }
  }

  function migStartPolling() {
    if (migPollTimer) return;
    migPollTimer = setInterval(migPollOnce, 1000);
  }

  function migStopPolling() {
    if (migPollTimer) { clearInterval(migPollTimer); migPollTimer = null; }
  }

  async function migFetchJob() {
    try {
      const resp = await fetch('/api/migrate/job');
      if (!resp.ok) return null;
      return await resp.json();
    } catch { return null; }
  }

  async function migPollOnce() {
    const s = await migFetchJob();
    if (!s || s.idle) { migStopPolling(); return; }
    const card = migCardFor(s.mode);
    // Panel closed or re-rendered — stop polling; the job keeps going and the
    // next render re-attaches to it.
    if (!card) { migStopPolling(); return; }
    if (s.running) { migLock(card, true); migRenderProgress(card, s); return; }
    migStopPolling();
    migFinish(card, s.mode, s);
  }

  /** Rebuild this card from whatever the server currently holds. */
  async function migAttach() {
    const s = await migFetchJob();
    if (!s || s.idle) return;
    const card = migCardFor(s.mode);
    if (!card) return;
    // A deep-search job has to be visible to be watched. Expanding is not a
    // preference the user expressed, so it is not persisted: collapsing again
    // is one click, and a hidden running job would be worse than an open panel.
    if (s.mode === 'auto') migSetDeepOpen(true, { persist: false });
    migRestoreInputs(s);
    if (s.running) {
      migLock(card, true);
      migRenderProgress(card, s);
      migStartPolling();
    } else {
      migFinish(card, s.mode, s);
    }
  }

  /**
   * A job has landed — render its outcome. Shared by the inline fast path,
   * the poller, and re-attach, so all three produce the identical UI.
   */
  function migFinish(card, mode, s) {
    // Re-assert the inputs the job actually ran with BEFORE anything reads
    // them. The signature below is computed from these boxes, so if they and
    // the plan ever disagreed, Apply would be armed against the wrong report.
    // Locking the inputs during the run makes that hard; this makes it
    // impossible, and costs one assignment.
    if (s.inputs) migRestoreInputs({ mode, inputs: s.inputs });
    migLock(card, false);
    migHideProgress(card);
    migResetRate();

    if (s.error) {
      migSetStatus(card, s.error, 'mig-bad');
      migState[mode] = null;
      card.querySelector('.mig-apply').disabled = true;
      return;
    }

    card.querySelector('.mig-report').innerHTML = migReportHtml(s.report, s.kind === 'apply');
    migWireReport(card);

    if (s.kind === 'apply') {
      migState[mode] = null;
      const n = (s.applied || 0).toLocaleString();
      migSetStatus(card, `Done: ${n} record(s) repointed in ${migHuman(s.elapsedMs)}.`, 'mig-good');
      card.querySelector('.mig-apply').disabled = true;

      // The finished summary stays parked server-side for an hour, and this
      // function runs on EVERY render of the section — so without a latch,
      // revisiting the panel re-toasted and re-reloaded the whole library each
      // time. Reloading 16k rows to celebrate a migration that finished twenty
      // minutes ago is pure waste. Latch on the job id (sessionStorage, so it
      // survives the reload the apply itself triggers); the report below still
      // renders every visit, because that is the part worth seeing again.
      if (migClaimNotify(s.jobId)) {
        if (typeof showToast === 'function') showToast(`🗂 ${n} record(s) repointed`);
        // Every path in memory is now wrong — reload rather than patch.
        if (typeof loadDatabase === 'function') loadDatabase();
        if (typeof window.vaultRefreshMissingBanner === 'function') window.vaultRefreshMissingBanner();
      }
      return;
    }

    const willChange = s.report.counts.rewrite + s.report.counts.absorb;
    const status = willChange > 0
      ? `Preview only, nothing written. ${willChange.toLocaleString()} record(s) would move (took ${migHuman(s.elapsedMs)}).`
      : 'Nothing would change.';
    // The signature is taken from the inputs as they now stand, which
    // migRestoreInputs has just set to the ones the job actually ran with.
    migState[mode] = willChange > 0
      ? { signature: JSON.stringify(migInputs(mode)), report: s.report, status } : null;
    migSyncApply(card, mode);
    migSetStatus(card, status, willChange > 0 ? '' : 'mig-bad');
  }

  /* ── The confirm step ─────────────────────────────────────────────────────
     EVERY mode confirms with the inline bar, never the browser's native
     confirm() (which looks foreign, appears under the cursor, and is one
     keypress from accepted). The deep modes earn the full treatment because
     their destinations are GUESSED — from a filename, or in the rename-rescue
     tier from a byte count and nothing else — and applying forgets the old
     paths: the bar's button sits on the OPPOSITE side of the card and is dead
     for a second and a half, so it cannot be reached by accident. Quick move's
     mapping is mechanical (the user typed both halves and every destination
     must already hold the file), so its bar arms instantly. */

  const CONFIRM_DELAY_MS = 1500;

  function migRequestApply(card, mode) {
    const saved = migState[mode];
    if (!saved || saved.signature !== JSON.stringify(migInputs(mode))) {
      migSetStatus(card, 'Preview first.', 'mig-bad');
      return;
    }
    migShowConfirmBar(card, mode, saved.report);
  }

  function migShowConfirmBar(card, mode, report) {
    const bar = card.querySelector('.mig-confirm');
    const c = report.counts;
    const moving = c.rewrite + c.absorb;
    const asides = [];
    const rules = report.rules || [];
    if (rules.length) {
      asides.push(`${rules.length} whole-folder move(s) detected, covering ` +
        `${rules.reduce((n, r) => n + r.rows, 0).toLocaleString()} record(s)`);
    }
    if (c.absorb) asides.push(`${c.absorb.toLocaleString()} placeholder row(s) deleted`);
    if (c.mismatch) asides.push(`${c.mismatch.toLocaleString()} rejected, content differs`);
    if (c.dupesLinked) asides.push(`${c.dupesLinked.toLocaleString()} look-alike(s) grouped as dupes`);
    if (c.ambiguous) asides.push(`${c.ambiguous.toLocaleString()} ambiguous, left alone`);
    if (c.unmatched) asides.push(`${c.unmatched.toLocaleString()} unmatched, left alone`);

    const dest = mode === 'prefix'
      ? `<code>${esc(report.oldPrefix)}</code> to <code>${esc(report.newPrefix)}</code>`
      : `<code>${esc(report.newRoot)}</code>`;
    bar.innerHTML = `
      <div class="mig-confirm-text">
        <b>Repoint ${moving.toLocaleString()} record(s)</b> ${mode === 'prefix' ? 'from' : 'to'}
        ${dest}. Their old paths will be forgotten.
        ${asides.length ? `<span class="mig-confirm-aside">${asides.join(' · ')}</span>` : ''}
      </div>
      <div class="mig-confirm-btns">
        <button class="settings-btn mig-confirm-cancel" type="button">Cancel</button>
        <button class="settings-btn mig-confirm-go" type="button" disabled></button>
      </div>`;
    bar.style.display = 'flex';

    // Apply is dead while the bar is up, so a second click on it lands on a
    // disabled control instead of re-opening (or accepting) anything.
    card.querySelector('.mig-apply').disabled = true;

    const go = bar.querySelector('.mig-confirm-go');
    // Quick move's destinations were typed, not guessed, so its bar arms
    // immediately; the guessing modes keep the accident-proof delay.
    const delayMs = mode === 'prefix' ? 0 : CONFIRM_DELAY_MS;
    // Enablement runs off a wall-clock deadline and its OWN timeout, not off
    // counting interval ticks: a browser that has throttled this tab (any
    // background tab does) would otherwise stretch 1.5 seconds into fifteen.
    // The interval only paints the countdown, so throttling it is harmless.
    const deadline = Date.now() + delayMs;
    const label = () => {
      const left = Math.max(0, deadline - Date.now());
      go.textContent = left > 0 ? `Confirm (${(left / 1000).toFixed(1)}s)` : 'Confirm, repoint them';
    };
    label();
    const tick = setInterval(() => {
      label();
      if (Date.now() >= deadline) { clearInterval(tick); bar._migTick = null; }
    }, 100);
    bar._migTick = tick;
    bar._migArm = setTimeout(() => { go.disabled = false; label(); }, delayMs);

    bar.querySelector('.mig-confirm-cancel').addEventListener('click', () => {
      migHideConfirmBar(card, mode);
      migSetStatus(card, migState[mode] ? migState[mode].status : '');
    });
    go.addEventListener('click', () => {
      if (go.disabled) return;
      migHideConfirmBar(card, mode);
      migRun(card, mode, true);
    });
  }

  function migHideConfirmBar(card, mode) {
    const bar = card.querySelector('.mig-confirm');
    if (!bar) return;
    if (bar._migTick) { clearInterval(bar._migTick); bar._migTick = null; }
    if (bar._migArm) { clearTimeout(bar._migArm); bar._migArm = null; }
    bar.style.display = 'none';
    bar.innerHTML = '';
    // Re-derive rather than blanket-enabling: the inputs may have changed.
    card.querySelector('.mig-apply').disabled =
      !migState[mode] || migState[mode].signature !== JSON.stringify(migInputs(mode));
  }

  function migSetStatus(card, text, kind = '') {
    const el = card.querySelector('.mig-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = `mig-status${kind ? ' ' + kind : ''}`;
  }

  async function migRun(card, mode, isApply) {
    const inputs = migInputs(mode);
    const signature = JSON.stringify(inputs);

    // The confirm step happens in migRequestApply; this is the last line of
    // defence in case anything reaches here without one.
    if (isApply) {
      const saved = migState[mode];
      if (!saved || saved.signature !== signature) {
        migSetStatus(card, 'Preview first.', 'mig-bad');
        return;
      }
    } else {
      migHideConfirmBar(card, mode);
    }

    migLock(card, true);
    migSetStatus(card, isApply ? 'Applying…' : 'Scanning…');

    try {
      const resp = await fetch(isApply ? '/api/migrate/apply' : '/api/migrate/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inputs),
      });
      const data = await resp.json().catch(() => ({}));

      // Another tab (or an earlier click) already owns the slot. Refusing and
      // stopping there would leave this tab blind to a run it can perfectly
      // well watch — so say so, then attach to it.
      if (resp.status === 409 && data.jobId) {
        migSetStatus(card, `${data.error || 'A migrate is already running'}. Progress is shown here.`);
        migAttach();
        return;
      }

      if (!resp.ok) {
        migSetStatus(card, data.error || `HTTP ${resp.status}`, 'mig-bad');
        migState[mode] = null;
        migLock(card, false);
        card.querySelector('.mig-apply').disabled = true;
        return;
      }

      // Small library: the server finished inside its grace window and handed
      // back the report directly. Same rendering path as everything else.
      if (data.done) {
        migFinish(card, mode, {
          kind: isApply ? 'apply' : 'preview', inputs, jobId: data.jobId,
          report: data.report, applied: data.applied,
          elapsedMs: data.elapsedMs || 0, error: null,
        });
        return;
      }

      // Still going — the poller owns the card from here.
      migResetRate();
      migRenderProgress(card, { kind: isApply ? 'apply' : 'preview', phase: 'starting', processed: 0, total: 0, elapsedMs: 0, etaMs: null });
      migStartPolling();
    } catch (err) {
      migSetStatus(card, err.message, 'mig-bad');
      migLock(card, false);
      migSyncApply(card, mode);
    }
  }

  /** "Show in library" — hand the leftover ids to the grid and get out of the way. */
  function migWireReport(card) {
    const btn = card.querySelector('.mig-show-left');
    if (!btn) return;
    btn.addEventListener('click', () => {
      let ids = [];
      try { ids = JSON.parse(btn.dataset.ids || '[]'); } catch {}
      if (typeof window.vaultShowMediaIds !== 'function') {
        if (typeof showToast === 'function') showToast('⚠ Library view unavailable');
        return;
      }
      closeModal();
      window.vaultShowMediaIds(ids, btn.dataset.label);
    });
  }

  function migReportHtml(report, applied) {
    const c = report.counts;
    const tile = (label, n, cls = '') =>
      `<div class="mig-stat ${cls}${n ? '' : ' is-zero'}">
         <span class="mig-stat-n">${n.toLocaleString()}</span>
         <span class="mig-stat-l">${label}</span>
       </div>`;

    const stats = [
      tile(applied ? 'repointed' : 'would repoint', c.rewrite, 'mig-good-stat'),
      tile('stubs absorbed', c.absorb, 'mig-good-stat'),
      tile(report.mode === 'relink' ? 'vanished' : 'missing at destination', c.missing, 'mig-warn-stat'),
      tile('conflicts', c.conflict, 'mig-warn-stat'),
      ...(report.mode !== 'prefix' ? [
        tile('content mismatch', c.mismatch || 0, 'mig-warn-stat'),
        tile('ambiguous', c.ambiguous, 'mig-warn-stat'),
        tile('no match', c.unmatched, 'mig-warn-stat'),
        tile(applied ? 'look-alikes grouped' : 'look-alikes to group', c.dupesLinked || 0, 'mig-good-stat'),
      ] : []),
    ].join('');

    // Auto mode works out whole-folder moves for itself. Showing them is the
    // difference between "trust me, 40,000 things happened" and "this folder
    // is now that folder, here is how many records that covers".
    const rules = report.rules || [];
    const moves = rules.length ? `
      <div class="mig-moves">
        <div class="mig-moves-title">${applied ? 'Moves applied' : 'Moves discovered'}</div>
        ${rules.map(r => `
          <div class="mig-move">
            <code>${esc(r.oldPrefix)}</code>
            <span class="mig-arrow">-&gt;</span>
            <code>${esc(r.newPrefix)}</code>
            <span class="mig-why">${r.rows.toLocaleString()} record(s), ${r.verified.toLocaleString()} of ${r.sampled.toLocaleString()} sampled files checked against their contents</span>
          </div>`).join('')}
      </div>` : '';

    // The set that did NOT move is the one the user has to deal with by hand,
    // and no search term describes it, so hand the grid the ids directly.
    const left = report.notMigrated;
    const notMigrated = (left && left.total) ? `
      <div class="mig-leftovers">
        <span>${left.total.toLocaleString()} record(s) ${applied ? 'did not migrate' : 'would not migrate'}. They keep everything and were not touched.</span>
        <button class="settings-btn mig-show-left" type="button"
          data-ids="${esc(JSON.stringify(left.ids))}"
          data-label="record(s) that did not migrate">Show in library</button>
        ${left.capped ? `<span class="settings-note">Only the first ${left.ids.length.toLocaleString()} can be listed.</span>` : ''}
      </div>` : '';

    // Only the problem buckets get a detail list — "here are 40,000 paths that
    // worked" is noise, and the ones left behind are what needs a decision.
    const detail = (title, bucket, fmt) => {
      if (!bucket || !bucket.total) return '';
      return `
        <details class="mig-details">
          <summary>${title} (${bucket.total.toLocaleString()})</summary>
          <ul class="mig-list">
            ${bucket.shown.map(fmt).join('')}
            ${bucket.more ? `<li class="mig-more">… and ${bucket.more.toLocaleString()} more</li>` : ''}
          </ul>
        </details>`;
    };

    const arrow = (it) => `<li><code>${esc(it.from)}</code><span class="mig-arrow">→</span><code>${esc(it.to)}</code></li>`;

    return `
      <div class="mig-stats">${stats}</div>
      ${moves}
      ${notMigrated}
      ${detail('Rejected: same name or size, different content', report.mismatch, (it) => `
        <li><code>${esc(it.from)}</code><span class="mig-arrow">≠</span><code>${esc(it.to)}</code>
          <span class="mig-why">${esc(it.reason)}</span></li>`)}
      ${detail(report.mode === 'relink' ? 'Vanished between scan and check' : 'No file at the destination',
        report.missing, arrow)}
      ${detail('Conflicts: another record already owns that path', report.conflict, (it) => `
        <li><code>${esc(it.from)}</code><span class="mig-arrow">→</span><code>${esc(it.to)}</code>
          <span class="mig-why">held by record #${esc(it.occupantId ?? '?')}, ${esc(it.reason)}</span></li>`)}
      ${detail('Ambiguous: more than one file matches', report.ambiguous, (it) => `
        <li><code>${esc(it.from)}</code>
          <span class="mig-why">${it.candidateCount} candidates: ${it.candidates.map(p => `<code>${esc(p)}</code>`).join(', ')}</span></li>`)}
      ${detail('No match found under that folder', report.unmatched, (it) => `<li><code>${esc(it.from)}</code></li>`)}
      ${detail(applied ? 'Repointed' : 'Would be repointed', report.rewrite, arrow)}
      ${detail(applied ? 'Placeholders absorbed' : 'Placeholders that would be absorbed', report.absorb, arrow)}
    `;
  }

  /* ── "N files missing from disk" banner ───────────────────────────────────
     Lives here rather than with the library loader because everything it does
     is point at the panel above. The count comes from a cached, chunked
     server-side check (GET /api/library/missing-count) so a big library never
     stalls the viewer for it; the first answer usually says "computing", hence
     the short poll. Dismissal is per-session — a user who moved their library
     and hasn't fixed it yet should be reminded next launch. */

  const MISSING_THRESHOLD = 10;
  const SS_DISMISSED = 'vault_missing_banner_dismissed';

  function missingBannerDismissed() {
    try { return sessionStorage.getItem(SS_DISMISSED) === '1'; } catch { return false; }
  }

  function renderMissingBanner(count, total) {
    const host = document.getElementById('missingFilesBanner');
    if (!host) return;
    if (count < MISSING_THRESHOLD || missingBannerDismissed()) {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    host.style.display = '';
    host.innerHTML = `
      <span class="missing-banner-text">
        <b>${count.toLocaleString()}</b> of ${total.toLocaleString()} files are missing from disk. Did your library move?
      </span>
      <button class="missing-banner-fix" id="missingBannerFix">Fix paths…</button>
      <button class="missing-banner-close" id="missingBannerClose" title="Dismiss for this session" aria-label="Dismiss">&times;</button>`;
    host.querySelector('#missingBannerFix').addEventListener('click', () => openModal('library'));
    host.querySelector('#missingBannerClose').addEventListener('click', () => {
      try { sessionStorage.setItem(SS_DISMISSED, '1'); } catch {}
      host.style.display = 'none';
      host.innerHTML = '';
    });
  }

  let _missingPolls = 0;
  async function checkMissingFiles(refresh) {
    if (missingBannerDismissed()) return;
    try {
      const resp = await fetch('/api/library/missing-count' + (refresh ? '?refresh=1' : ''));
      if (!resp.ok) return;                       // 423 locked, or an older server
      const info = await resp.json();
      // A stale count is one taken before something just moved the files —
      // wait for the fresh walk instead of flashing a wrong number.
      if (info.count !== null && !info.stale) renderMissingBanner(info.count, info.total);
      // The first request only kicks the walk off; give it a few seconds to
      // land rather than making the user reload. Bounded so a huge library
      // that is still counting doesn't poll forever.
      if (info.computing && _missingPolls < 20) {
        _missingPolls++;
        setTimeout(() => checkMissingFiles(false), 1500);
      }
    } catch { /* server unreachable — no banner, no noise */ }
  }

  window.vaultRefreshMissingBanner = function () {
    _missingPolls = 0;
    checkMissingFiles(true);
  };

  /* ── Section: Seed packs ─────────────────────────────────────────────────── */

  function RENDERERS_seedpacks() {
    return `
      <h3 class="settings-h">Song seed packs</h3>
      <p>A seed pack (eg <code>vault-songseed.json</code>) is a portable bundle of song <b>reference fingerprints</b> — no audio inside. Importing one lands the songs and their fingerprints straight in your database without needing the MP3s on disk, and every already-fingerprinted file is rescanned against just the new references.</p>
      <p>It's strictly a manual pull: you download and pick the pack yourself, nothing auto-fetches. Re-importing is idempotent, so updated packs only add what's new.</p>
      <button class="settings-btn" id="settingsOpenSeedpacks">Open seed packs in Editor</button>
    `;
  }

  function wireSeedpacksSection() {
    const btn = document.getElementById('settingsOpenSeedpacks');
    if (!btn) return;
    btn.addEventListener('click', () => {
      closeModal();
      if (typeof switchTab === 'function') switchTab('editor');
      if (typeof editorOpenSeedPacks === 'function') editorOpenSeedPacks();
    });
  }

  /* ── Section: About ──────────────────────────────────────────────────────── */

  function RENDERERS_about() {
    return `
      <h3 class="settings-h">About</h3>
      <div class="settings-about">
        <div class="settings-about-name" id="settingsAboutName">Vault</div>
        <div class="settings-about-ver" id="settingsAboutVer"></div>
        <p class="settings-about-local">🔒 Local-first - no telemetry, no auto-updates. The network is only touched when you allow it (model downloads, manual update checks).</p>
        <div class="settings-update">
          <button class="settings-btn" id="settingsAboutUpdateBtn">Check for updates</button>
          <span class="settings-note settings-update-msg" id="settingsAboutUpdateMsg"></span>
        </div>
        <p class="settings-note">Clicking makes a single request to api.github.com to compare versions - nothing else is sent.</p>
        <p>Free for personal use - proprietary, source-available. See the LICENSE file next to the app.</p>
        <div class="settings-links">
          <a href="https://github.com/aericocode/Vault" target="_blank" rel="noopener">GitHub repo ↗</a>
          <a href="https://ko-fi.com/aericode" target="_blank" rel="noopener">Ko-fi 🌿 ↗</a>
        </div>
      </div>
    `;
  }

  async function loadAbout() {
    try {
      const resp = await fetch('/api/about');
      if (!resp.ok) return;
      const info = await resp.json();
      const nameEl = document.getElementById('settingsAboutName');
      const verEl = document.getElementById('settingsAboutVer');
      if (nameEl && info.name) nameEl.textContent = info.name;
      if (verEl && info.version) verEl.textContent = `v${info.version}`;
    } catch { /* server unreachable - leave the static fallback */ }
    wireUpdateCheck();
  }

  // Manual update check — fires ONLY on click; nothing polls in the background.
  // One request to /api/update-check (which in turn makes one call to GitHub).
  function wireUpdateCheck() {
    const btn = document.getElementById('settingsAboutUpdateBtn');
    const msg = document.getElementById('settingsAboutUpdateMsg');
    if (!btn || !msg || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      msg.textContent = 'Checking…';
      try {
        const resp = await fetch('/api/update-check');
        const info = await resp.json();
        if (info.error) {
          msg.textContent = info.error;
        } else if (info.updateAvailable) {
          // Updates ship free; the only nudge is this one line, next to the link.
          msg.innerHTML = `v${info.latest} available - <a href="${info.url}" target="_blank" rel="noopener">View release ↗</a>`
            + `<span class="settings-update-kofi">Updates are free - if Vault earns it,`
            + ` <a href="https://ko-fi.com/aericode" target="_blank" rel="noopener">$10 says thanks</a>.</span>`;
        } else {
          msg.textContent = `Up to date (v${info.current})`;
        }
      } catch {
        msg.textContent = 'Could not reach the local server.';
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Renderer table (assigned above as bare globals to keep each section near
  // its wiring; collect them here).
  const RENDERERS = {
    settings:  RENDERERS_settings,
    library:   RENDERERS_library,
    guides:    RENDERERS_guides,
    models:    RENDERERS_models,
    seedpacks: RENDERERS_seedpacks,
    about:     RENDERERS_about,
  };

  /* ── Restore last session ────────────────────────────────────────────────── */

  // Called from player-core.js playMedia() whenever a file opens.
  window.vaultRecordLastOpened = function (id) {
    if (!settings.restoreSession) return;
    if (!id || settings._lastMediaId === id) return;
    settings._lastMediaId = id;
    save();
  };

  let _sessionRestored = false;
  function maybeRestoreSession() {
    if (_sessionRestored) return;
    _sessionRestored = true;
    if (!settings.restoreSession) return;
    const id = settings._lastMediaId;
    if (!id) return;
    const media = typeof getMediaById === 'function' ? getMediaById(id) : null;
    if (!media) {
      // Row is gone — clear silently so we don't keep trying.
      settings._lastMediaId = null;
      save();
      return;
    }
    if (typeof playMedia !== 'function') return;
    playMedia({ filepath: media.filepath, filename: media.filename, media_type: media.media_type });
    // Open paused: playMedia's setup ends with a synchronous play() call, so
    // pausing here supersedes it (the superseded play() promise rejection is
    // already caught at the call site). The only other play() paths are
    // user-initiated (togglePlay), which must win.
    const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');
    if (el) el.pause();
  }

  /* ── Keyboard shortcut: Ctrl+Shift+H toggles privacy mode ─────────────────── */

  // This listener is registered before app.js's global keydown (settings.js is
  // loaded first), so when the settings modal owns the Escape we stop app.js's
  // handler from also running (its Escape closes the detail modal / popover).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) {
      closeModal();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'H' || e.key === 'h')) {
      e.preventDefault();
      setPrivacyMode(!settings.privacyMode);
    }
  });

  /* ── Boot ────────────────────────────────────────────────────────────────── */

  function init() {
    buildGearButton();
    buildModalShell();
    updateGearBadge();
    // The server's queue concurrency resets with the process; the stored value
    // is the source of truth, so hand it over on every page load. Fire-and-
    // forget: nothing in the UI depends on the answer.
    pushWorkers(clampWorkers(settings.scanWorkers));
    // Warm the server-owned cache so the first modal open shows real values
    // rather than the defaults. Best-effort — a locked vault answers 423.
    loadServerSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // The library finishes its first load asynchronously; database.js fires this
  // once. Restore the last session only after the rows are available.
  window.addEventListener('vault:library-loaded', maybeRestoreSession, { once: true });

  // Same signal, different job: only ask about missing files once there IS a
  // library, so a locked vault or a failed load never shows the banner.
  window.addEventListener('vault:library-loaded', () => checkMissingFiles(false), { once: true });
})();
