/* =========================================================================
   GAMES — host / tab controller.

   Owns #gamesContainer and mounts 0 or 1 game at a time behind a uniform
   interface: mount(container, {mediaId, savedState, onProgress}) → pause() →
   resume() → getState() → destroy(). Games never touch the server; they emit
   onProgress() at checkpoints and the host debounce-persists to /api/games
   (durable) + localStorage (instant restore).

   Video selection is library-only and in-tab: the home is a searchable video
   picker; an in-game "Change video" opens an overlay picker. Nothing leaves
   the Games tab.
   ========================================================================= */

/* ── Game registry (each game file calls gamesRegister on load) ─────────── */

const GAMES = {};
function gamesRegister(key, def) { GAMES[key] = { key, ...def }; }
window.gamesRegister = gamesRegister;

/* ── Host state ─────────────────────────────────────────────────────────── */

const GAMES_MAX_SAVES = 24;                 // per game (mirrors server cap)
const GAMES_LS_KEY = 'game_saves_v2';       // localStorage mirror of the grouped saves

const gamesState = {
  activeKey: null,       // 'reelorder' | 'framefit' | null
  activeSaveId: null,    // save_id of the running game (new game → fresh id; resume → existing id)
  instance: null,        // mounted game object
  mounted: false,        // is a game (vs the home) in #gamesContainer
  saveTimer: null,       // debounce handle
  saves: {},             // { key: [ {save_id, media_id, state, updated_at}, ... ] } newest-first
  savesLoaded: false,
};

function gamesContainer() { return document.getElementById('gamesContainer'); }

/** Client-side save id — matches the server's shape (repo.genSaveId). */
function gamesNewSaveId() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

/* ── Loading veil (dim + spinner while a picker/library opens) ──────────── */

let _gamesLoadingEl = null;

function gamesShowLoading(host, text) {
  gamesRemoveLoading();
  if (!host) return;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const el = document.createElement('div');
  el.className = 'game-loading-overlay games-loading';
  el.innerHTML = `<div class="game-spinner"></div><div>${escapeHtml(text || 'Loading…')}</div>`;
  host.appendChild(el);
  _gamesLoadingEl = el;
}

function gamesRemoveLoading() {
  if (_gamesLoadingEl) { _gamesLoadingEl.remove(); _gamesLoadingEl = null; }
}

/** Show the veil over a host, then lift it once its visible thumbnails settle. */
function gamesLoadingUntilReady(host, text) {
  gamesShowLoading(host, text);
  const start = performance.now();
  const MIN = 300, CAP = 1200;             // keep a perceptible flash; never hang
  let done = false;
  const finish = () => {
    if (done) return; done = true;
    setTimeout(gamesRemoveLoading, Math.max(0, MIN - (performance.now() - start)));
  };
  // Only wait on thumbnails near the viewport — off-screen lazy images never
  // fire their load event, so counting them would hang until the cap.
  const vh = window.innerHeight;
  const imgs = [...host.querySelectorAll('img')].filter(i => {
    if (i.complete) return false;
    const r = i.getBoundingClientRect();
    return r.top < vh + 120 && r.bottom > -120;
  });
  if (!imgs.length) { finish(); return; }
  let pending = imgs.length;
  const tick = () => { if (--pending <= 0) finish(); };
  imgs.forEach(i => { i.addEventListener('load', tick, { once: true }); i.addEventListener('error', tick, { once: true }); });
  setTimeout(finish, CAP);                  // safety cap
}

/* ── Saves (server + localStorage mirror) ───────────────────────────────── */

function gamesReadLocalSaves() {
  try { return JSON.parse(localStorage.getItem(GAMES_LS_KEY) || '{}') || {}; } catch { return {}; }
}
function gamesWriteLocalSaves() {
  try { localStorage.setItem(GAMES_LS_KEY, JSON.stringify(gamesState.saves)); } catch {}
}

/** All saves for a game, newest first. */
function gamesSavesFor(key) { return gamesState.saves[key] || []; }

/** Load saves: instant paint from localStorage, then reconcile with the server. */
async function gamesLoadSaves() {
  gamesState.saves = gamesReadLocalSaves();
  try {
    gamesState.saves = await fetch('/api/games/saves').then(r => r.json()) || {};
    gamesWriteLocalSaves();
  } catch { /* keep the localStorage copy */ }
  gamesState.savesLoaded = true;
  return gamesState.saves;
}

/** Insert-or-update one save in the in-memory + localStorage mirror (newest-first). */
function gamesUpsertLocal(key, saveObj) {
  const list = gamesState.saves[key] || (gamesState.saves[key] = []);
  const i = list.findIndex(s => s.save_id === saveObj.save_id);
  if (i >= 0) list[i] = { ...list[i], ...saveObj };
  else list.unshift(saveObj);
  list.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  gamesWriteLocalSaves();
}

function gamesRemoveLocal(key, saveId) {
  const list = gamesState.saves[key];
  if (!list) return;
  gamesState.saves[key] = list.filter(s => s.save_id !== saveId);
  gamesWriteLocalSaves();
}

async function gamesPersist(key, saveId, mediaId, state) {
  if (!key || !saveId || !mediaId || !state) return;
  // Instant mirror (optimistic)
  gamesUpsertLocal(key, { save_id: saveId, media_id: mediaId, state, updated_at: new Date().toISOString() });
  // Durable
  try {
    const r = await fetch(`/api/games/saves/${key}/${saveId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_id: mediaId, state }),
    });
    if (r.ok) {
      const { save } = await r.json();
      if (save) gamesUpsertLocal(key, save);
    } else if (r.status === 409) {
      // Over the per-game cap — undo the optimistic mirror entry
      gamesRemoveLocal(key, saveId);
    }
  } catch { /* localStorage covers the gap; next boot reconciles */ }
}

async function gamesDeleteSave(key, saveId) {
  gamesRemoveLocal(key, saveId);
  if (gamesState.activeSaveId === saveId) gamesState.activeSaveId = null; // don't re-save it
  try { await fetch(`/api/games/saves/${key}/${saveId}`, { method: 'DELETE' }); } catch {}
  renderGamesHome();
}

/** Snapshot the active game's state and persist it (immediate). */
function gamesPersistActive() {
  const { activeKey, activeSaveId, instance } = gamesState;
  if (!activeKey || !activeSaveId || !instance) return;
  const state = instance.getState?.();
  if (!state || !state.media_id) return;
  gamesPersist(activeKey, activeSaveId, state.media_id, state);
}

/** Debounced autosave, driven by a game's onProgress() at checkpoints. */
function gamesScheduleSave() {
  clearTimeout(gamesState.saveTimer);
  gamesState.saveTimer = setTimeout(gamesPersistActive, 800);
}

/* ── Tab entry / lifecycle ──────────────────────────────────────────────── */

function renderGames() {
  // Returning to an in-progress game: resume (DOM persists, like the editor mix)
  if (gamesState.mounted && gamesState.instance) {
    gamesState.instance.resume?.();
    return;
  }
  renderGamesHome();
}

/** Called from tabs.js when leaving the Games tab — freeze + save, keep DOM. */
function gamesPauseIfActive() {
  if (gamesState.mounted && gamesState.instance) {
    gamesState.instance.pause?.();
    gamesPersistActive();
  }
}

async function teardownActive() {
  const { instance } = gamesState;
  if (instance) {
    gamesPersistActive();            // capture before destroying
    try { instance.destroy?.(); } catch {}
  }
  clearTimeout(gamesState.saveTimer);
  gamesState.activeKey = null;
  gamesState.activeSaveId = null;
  gamesState.instance = null;
  gamesState.mounted = false;
}

/**
 * Launch a game on a media id. savedState + saveId (optional) restore an
 * in-progress save; otherwise a fresh save id is minted and the game shows its
 * own pre-game setup. New games are blocked once a game hits its save cap.
 */
async function gamesLaunch(key, mediaId, { savedState = null, saveId = null } = {}) {
  const def = GAMES[key];
  if (!def) { showToast('Unknown game'); return; }
  const media = getMediaById(mediaId);
  if (!media) { showToast('Video not found'); return; }
  if (!def.acceptTypes.includes(media.media_type)) {
    showToast(`${def.label} needs: ${def.acceptTypes.join(', ')}`);
    return;
  }
  // A brand-new game (no saveId) needs room under the per-game cap
  if (!saveId && gamesSavesFor(key).length >= GAMES_MAX_SAVES) {
    showToast(`Max ${GAMES_MAX_SAVES} saved ${def.label} games — delete one first`);
    return;
  }

  if (gamesState.instance) await teardownActive();
  gamesState.activeSaveId = saveId || gamesNewSaveId();

  const container = gamesContainer();
  container.classList.add('games-playing');   // full-bleed layout while in a game
  container.innerHTML = `
    <div class="games-view">
      <div class="games-topbar">
        <button class="games-btn" id="gamesBackBtn" title="Back to games">⬅ Library</button>
        <span class="games-topbar-title">${def.icon} ${escapeHtml(def.label)}
          <span class="games-topbar-media" title="${escapeHtml(media.filename)}">— ${escapeHtml(media.filename)}</span></span>
        <button class="games-btn" id="gamesChangeBtn" title="Pick a different video (stays in the Games tab)">🔀 Change video</button>
      </div>
      <div class="game-root" id="gameRoot"></div>
    </div>`;

  document.getElementById('gamesBackBtn').addEventListener('click', async () => {
    await teardownActive();
    renderGamesHome();
  });
  document.getElementById('gamesChangeBtn').addEventListener('click', () => openGamePickerOverlay(key));

  const inst = def.factory();
  gamesState.activeKey = key;
  gamesState.instance = inst;
  gamesState.mounted = true;

  try {
    await inst.mount(document.getElementById('gameRoot'), {
      mediaId, media, savedState,
      onProgress: () => gamesScheduleSave(),
    });
  } catch (e) {
    console.error('[Games] mount failed:', e);
    showToast('⚠ Game failed to start: ' + e.message);
    await teardownActive();
    renderGamesHome();
  }
}

/* ── Home (per-game rows of save cards) ─────────────────────────────────── */

async function renderGamesHome() {
  const container = gamesContainer();
  if (!container) return;
  container.classList.remove('games-playing');
  if (!gamesState.savesLoaded) await gamesLoadSaves();

  const rows = Object.values(GAMES).map(renderGameRow).join('');
  container.innerHTML = `
    <div class="games-view games-home">
      <h2 class="games-home-title">🎮 Games</h2>
      <div class="games-rows">${rows || '<div class="games-hint">No games installed.</div>'}</div>
    </div>`;
}

/** One game = one row: header + New-game button, then a grid of its save cards. */
function renderGameRow(def) {
  const saves = gamesSavesFor(def.key);
  const atMax = saves.length >= GAMES_MAX_SAVES;
  const cards = saves.map(s => renderSaveCard(def, s)).join('');
  return `
    <div class="games-row" data-game="${def.key}">
      <div class="games-row-head">
        <span class="games-card-icon">${def.icon}</span>
        <div class="games-row-meta">
          <div class="games-card-title">${escapeHtml(def.label)}
            ${saves.length ? `<span class="games-row-count">${saves.length}${atMax ? `/${GAMES_MAX_SAVES}` : ''}</span>` : ''}</div>
          <div class="games-card-desc">${escapeHtml(def.desc || '')}</div>
        </div>
        <button class="games-btn games-btn-primary games-new-btn"
          onclick="renderGamePicker('${def.key}')"
          ${atMax ? 'disabled title="Delete a saved game to start a new one"' : ''}>＋ New game</button>
      </div>
      <div class="games-saves-grid">
        ${cards || '<div class="games-hint games-saves-empty">No saved games yet — start one with “＋ New game”.</div>'}
      </div>
    </div>`;
}

/** A single saved game — laid out like a library media card: preview on top,
 *  details underneath (% badge + progress sliver on the thumb, time + actions
 *  below). */
function renderSaveCard(def, save) {
  const media = getMediaById(save.media_id);
  const name = media ? media.filename : `#${save.media_id} · file missing`;
  const st = save.state || {};
  const solved = st.phase === 'solved';
  const pct = Math.max(0, Math.min(100, Math.round((typeof st.progress === 'number' ? st.progress : 0) * 100)));
  const barPct = solved ? 100 : pct;
  const time = st.elapsedMs ? formatDuration(Math.round(st.elapsedMs / 1000)) : '0:00';
  const img = media
    ? `<img class="games-save-img" loading="lazy" src="/thumb/${media.id}" alt=""
         onerror="this.parentElement.classList.add('games-save-thumb--missing'); this.remove();">`
    : '';
  return `
    <div class="games-save-card" data-save="${save.save_id}">
      <div class="games-save-thumb ${media ? '' : 'games-save-thumb--missing'}">
        ${img}
        <span class="games-save-badge ${solved ? 'solved' : ''}">${solved ? '✓ Solved' : pct + '%'}</span>
        <div class="games-save-progress" style="width:${barPct}%"></div>
      </div>
      <div class="games-save-info">
        <div class="games-save-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="games-save-stats">
          <span class="games-save-time" title="Time spent in this saved game">⏱ ${time}</span>
        </div>
        <div class="games-save-actions">
          <button class="games-btn games-btn-primary" onclick="gamesResumeSave('${def.key}','${save.save_id}')">▶ Resume</button>
          <button class="games-btn games-save-del" onclick="gamesDeleteSave('${def.key}','${save.save_id}')" title="Delete this saved game">🗑</button>
        </div>
      </div>
    </div>`;
}

async function gamesResumeSave(key, saveId) {
  const save = gamesSavesFor(key).find(s => s.save_id === saveId);
  if (!save) { showToast('Saved game not found'); return; }
  await gamesLaunch(key, save.media_id, { savedState: save.state, saveId });
}

/* ── Video picker (home grid + in-game overlay share this) ──────────────── */

function _gamesPickerState(key) { return { key, q: '', metadataOnly: false, fuzzy: false, semantic: false }; }
let _pickerState = _gamesPickerState(null);

function gamesPickableMedia(key) {
  const def = GAMES[key];
  const base = allMedia.filter(m => def.acceptTypes.includes(m.media_type) && !m.user_trashed);
  if (typeof pickerApplySearch !== 'function') {   // search engine not loaded — fall back
    const q = _pickerState.q.trim().toLowerCase();
    return q ? base.filter(m => (m.filename || '').toLowerCase().includes(q)) : base;
  }
  const res = pickerApplySearch(_pickerState.q, base, _pickerState, gamesRefreshPickerBody);
  if (typeof pickerSetModeIndicator === 'function') pickerSetModeIndicator('gamesPick', res.mode, res.pending);
  return res.items;
}

/** Re-render whichever games picker body is currently open (semantic callback). */
function gamesRefreshPickerBody() {
  const overlay = document.getElementById('gamesOverlayBody');
  const home = document.getElementById('gamesPickerBody');
  if (overlay) overlay.innerHTML = gamesPickerGridHtml(_pickerState.key, 'gamesOverlayPick');
  else if (home) home.innerHTML = gamesPickerGridHtml(_pickerState.key, 'gamesPickAndLaunch');
}

/** Wire a picker's search input + option toggles to re-render its body. */
function gamesWirePickerSearch(searchId, bodyId, onClickFn) {
  const search = document.getElementById(searchId);
  const rerender = () => { const b = document.getElementById(bodyId); if (b) b.innerHTML = gamesPickerGridHtml(_pickerState.key, onClickFn); };
  let t = null;
  search?.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { _pickerState.q = search.value; rerender(); }, 200);
  });
  if (typeof bindPickerSearchOptions === 'function') bindPickerSearchOptions('gamesPick', _pickerState, rerender);
}

function gamesPickerGridHtml(key, onClickFn) {
  const items = gamesPickableMedia(key);
  if (!items.length) {
    return `<div class="games-hint games-picker-empty">${_pickerState.q ? 'No videos match.' : 'No compatible videos in the library.'}</div>`;
  }
  return `<div class="games-picker-grid">${items.map(m => {
    const dur = m.duration_seconds ? formatDuration(m.duration_seconds) : '';
    return `
      <div class="games-pick-tile" data-id="${m.id}" onclick="${onClickFn}(${m.id})" title="${escapeHtml(m.filename)}">
        <div class="tile-thumb">
          <img class="tile-img" loading="lazy" src="/thumb/${m.id}" alt=""
            onerror="this.parentElement.classList.add('thumb-fallback'); this.remove();">
          <span class="tile-type-icon">🎬</span>
          ${dur ? `<span class="tile-duration">${dur}</span>` : ''}
        </div>
        <div class="tile-name">${escapeHtml(m.filename)}</div>
      </div>`;
  }).join('')}</div>`;
}

function renderGamePicker(key) {
  const def = GAMES[key];
  _pickerState = _gamesPickerState(key);
  const container = gamesContainer();
  container.classList.remove('games-playing');
  container.innerHTML = `
    <div class="games-view games-home">
      <div class="games-picker-head">
        <button class="games-btn" onclick="renderGamesHome()">⬅ Games</button>
        <h2 class="games-home-title">${def.icon} ${escapeHtml(def.label)} — pick a video</h2>
        <input type="text" class="games-search" id="gamesPickerSearch" placeholder="Search… (AND/OR/NOT, /regex/)" autocomplete="off">
        ${typeof pickerSearchOptionsHtml === 'function' ? pickerSearchOptionsHtml('gamesPick', _pickerState) : ''}
      </div>
      <div id="gamesPickerBody">${gamesPickerGridHtml(key, 'gamesPickAndLaunch')}</div>
    </div>`;
  const pickerBody = document.getElementById('gamesPickerBody');
  gamesLoadingUntilReady(pickerBody, 'Loading library…');
  if (typeof attachHoverScrub === 'function') attachHoverScrub(pickerBody);
  gamesWirePickerSearch('gamesPickerSearch', 'gamesPickerBody', 'gamesPickAndLaunch');
}

function gamesPickAndLaunch(mediaId) {
  gamesLaunch(_pickerState.key, mediaId);
}

/* In-game overlay: change the video without leaving the tab */
function openGamePickerOverlay(key) {
  closeGamePickerOverlay();
  _pickerState = _gamesPickerState(key);
  const ov = document.createElement('div');
  ov.id = 'gamesPickerOverlay';
  ov.className = 'games-picker-overlay';
  ov.innerHTML = `
    <div class="games-picker-panel">
      <div class="games-picker-head">
        <h3>Change video</h3>
        <input type="text" class="games-search" id="gamesOverlaySearch" placeholder="Search… (AND/OR/NOT, /regex/)" autocomplete="off">
        ${typeof pickerSearchOptionsHtml === 'function' ? pickerSearchOptionsHtml('gamesPick', _pickerState) : ''}
        <button class="games-btn" onclick="closeGamePickerOverlay()">✕</button>
      </div>
      <div id="gamesOverlayBody">${gamesPickerGridHtml(key, 'gamesOverlayPick')}</div>
    </div>`;
  ov.addEventListener('click', (e) => { if (e.target === ov) closeGamePickerOverlay(); });
  document.body.appendChild(ov);
  const overlayBody = document.getElementById('gamesOverlayBody');
  gamesLoadingUntilReady(overlayBody, 'Loading library…');
  if (typeof attachHoverScrub === 'function') attachHoverScrub(overlayBody);
  gamesWirePickerSearch('gamesOverlaySearch', 'gamesOverlayBody', 'gamesOverlayPick');
}

function closeGamePickerOverlay() {
  document.getElementById('gamesPickerOverlay')?.remove();
}

function gamesOverlayPick(mediaId) {
  const key = _pickerState.key;
  closeGamePickerOverlay();
  gamesLaunch(key, mediaId); // fresh game (new save) on the new video
}

/* ── Sidebar "Send to game" entry point ─────────────────────────────────── */

function gamesSendToGame(key, mediaId) {
  // The "Send to game" button lives in the player sidebar — close the player
  // overlay (it's a fixed full-screen layer) before showing the Games tab.
  if (typeof closeMediaPlayer === 'function' &&
      document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) {
    closeMediaPlayer();
  }
  switchTab('games');
  gamesLaunch(key, mediaId);
}

/* ── Boot: flush active game on unload (server PUT may not finish) ───────── */

document.addEventListener('DOMContentLoaded', () => {
  gamesLoadSaves();
  window.addEventListener('beforeunload', () => {
    const { activeKey, activeSaveId, instance } = gamesState;
    if (!activeKey || !activeSaveId || !instance) return;
    const state = instance.getState?.();
    if (state && state.media_id) {
      gamesUpsertLocal(activeKey, {
        save_id: activeSaveId, media_id: state.media_id, state, updated_at: new Date().toISOString(),
      });
    }
  });
});
