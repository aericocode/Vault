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
    resumePlayback: true,   // auto-seek to stored position on open (current behavior)
    restoreSession: false,  // reopen last media (paused) on launch, Stash-style
    scanWorkers: 2,         // files the vision model scans in parallel after an import
    unlockHoldSeconds: 3,   // press-and-hold on the lock before the password box (0 = click)
    blurThumbs: false,      // blur the grid's tiles (hover reveals — unless privacy mode is on)
    gamifyHidden: false,    // hide the Obsession chip + toasts (scoring continues)
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
    // Stored JSON is user-editable — run the one numeric setting through the
    // same clamp every other surface uses. That clamp falls back to the current
    // value for anything unreadable, so seed the default first: a null or a
    // stray string then lands on 2 rather than being coerced down to 1.
    const stored = settings.scanWorkers;
    settings.scanWorkers = DEFAULTS.scanWorkers;
    settings.scanWorkers = clampWorkers(stored);
  }

  function save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {}
  }

  // Read a setting from anywhere in the app.
  window.vaultSetting = (key) => settings[key];

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

  function applyPrivacyMode(on) {
    document.body.classList.toggle('privacy-mode', !!on);
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
    if (id === 'seedpacks') wireSeedpacksSection();
    if (id === 'about') loadAbout();
  }

  function openModal() {
    buildModalShell();
    const overlay = document.getElementById('settingsOverlay');
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
    selectSection('settings');
  }

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
    { key: 'p_maskNames',   title: 'Mask filenames in privacy mode', desc: 'Replace tile names with neutral labels while privacy mode is on.' },
    { key: 'p_confirmTrash',title: 'Confirm before trash', desc: 'Ask before moving a file to the trash.' },
    { key: 'p_defaultSort', title: 'Default sort / filter on open', desc: 'Start every session with a saved sort and filter preset.' },
    { key: 'p_perPage',     title: 'Items per page', desc: 'Choose how many tiles load per page.' },
  ];

  function RENDERERS_settings() {
    return `
      <h3 class="settings-h">Preferences</h3>
      ${toggleRow({
        key: 'privacyMode',
        title: 'Privacy / streaming mode',
        desc: 'Hide personal data (paths, notes, saved searches, import folders) for screen-sharing. Shortcut: Ctrl+Shift+H.',
      })}
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
      ${numberRow({
        key: 'unlockHoldSeconds',
        title: 'Hold to unlock',
        desc: 'How long to press and hold the padlock on the lock screen before the password box appears — a guard against a stray click revealing it. <b>0 = a single click</b>.',
        min: 0, max: 10, unit: 'sec',
      })}

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
      <p class="settings-note">Short how-tos for the main features. See <code>README.md</code> / <code>SETUP.md</code> for the full docs.</p>
      ${guide('🔍 AI scanning',
        'Vault describes, tags and titles your media with a local vision model. Point it at <b>LM Studio (default)</b> or <b>Ollama</b> serving a vision model - see the Models section for picks by GPU size, then drag folders or files into the window to scan them. Nothing is uploaded - the model runs on your machine.',
        `Getting LM Studio: <a href="https://lmstudio.ai/download#lm-studio-download-heading" target="_blank" rel="noopener">lmstudio.ai/download</a> - you want the classic <b>LM Studio</b> ("Chat interface and programmable API"), <b>not the new Bionic</b> agent listed above it. Download a vision model from <b>Model Search</b> in LM Studio's left sidebar, then open the <b>Developer</b> tab and load it there. Turn on the toggle for manually choosing load parameters, set <b>context length ≈ 60k</b> (the ~4k default is too small for vision), and load. Finally, make sure the local server shows <b>Status: Running</b>. SETUP.md has the click-by-click version.`)}
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
      <p class="settings-note">Vision model = scan quality. Quantized (Q4) versions are the sweet spot. ~60k token context is required to handle vision reliably. </p>
      <div class="settings-table-wrap">
        <table class="settings-table">
          <thead>
            <tr><th>VRAM</th><th>Vision model (scanning)</th><th>Whisper (subtitles)</th></tr>
          </thead>
          <tbody>
            <tr><td>6–8 GB</td><td>MiniCPM V 4.6 Abliterated MAX</td><td><code>WHISPER_MODEL=small</code></td></tr>
            <tr><td>10–12 GB</td><td>Qwen3.5-VL-4B Q4 Uncensored HauhauCS Aggressive</td><td><code>WHISPER_MODEL=small</code></td></tr>
            <tr><td>16 GB</td><td>Qwen3.5-VL-4B Q8 Uncensored HauhauCS Aggressive + 2-4 workers</td><td>default</td></tr>
            <tr><td>24 GB+</td><td>Qwen3.5-VL-9B Q4 Uncensored HauhauCS Aggressive + 2-4 workers</td><td>default</td></tr>
          </tbody>
        </table>
      </div>
      <p class="settings-note">Semantic search embeddings are tiny - <code>nomic-embed-text</code> (~0.5 GB) runs anywhere.</p>
    `;
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
        <p class="settings-about-local">🔒 Local-first — no telemetry, no auto-updates. The network is only touched when you allow it (model downloads, manual update checks).</p>
        <div class="settings-update">
          <button class="settings-btn" id="settingsAboutUpdateBtn">Check for updates</button>
          <span class="settings-note settings-update-msg" id="settingsAboutUpdateMsg"></span>
        </div>
        <p class="settings-note">Clicking makes a single request to api.github.com to compare versions — nothing else is sent.</p>
        <p>License: <a href="https://github.com/aericocode/Vault/blob/main/LICENSE" target="_blank" rel="noopener">AGPL-3.0</a></p>
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
    } catch { /* server unreachable — leave the static fallback */ }
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
          msg.innerHTML = `v${info.latest} available — <a href="${info.url}" target="_blank" rel="noopener">View release ↗</a>`;
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
})();
