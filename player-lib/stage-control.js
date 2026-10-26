/* =========================================================================
   STAGE CONTROL - the Vault window's side of Stage (PLAYLISTS_SPEC 5).

   Stage is the window shared in Discord (player-lib/stage.html). Everything
   is run from here: while Stage is open the mini player is its remote, with a
   dimmed still of the file on Stage, and every way of playing a file (a tile,
   Next, Up next, Play all, the Wall) plays it on Stage instead (playMedia
   asks intercept() first, player-core.js).

   The link goes through the server (lib/stage/hub.js): commands out
   (/api/stage/cmd), Stage's reports in over an event stream. Stage moves on
   by itself when a file ends, because this tab is often in the background
   (the streamer is in Discord) where the browser slows its timers: every
   file sent goes with the upcoming files (Up next first, then the list,
   player-lib/stage-rules.js upcoming()), and when Stage reports that one of
   them started, the queue here catches up (Up next, the list's anchor) and
   sends the next ones.

   Closing Stage (the remote, its menu, the window's own close) hands the
   file back to the mini player at the same spot, with sound. Stage vanishing
   (a crash, sleep) leaves the remote saying "Stage was closed", paused.

   Hooks elsewhere: playMedia (intercept), maximizePlayer and closeMiniPlayer
   (on, hideRemote), mini-player.js (miniMediaEl returns the proxy below, the
   volume), app.js (key), up-next.js render (upNextChanged), the repeat
   button (repeatChanged).
   ========================================================================= */

const StageControl = (() => {
  const STAGEABLE = new Set(['video', 'image', 'gif', 'audio']);
  const UPCOMING_COUNT = 2;
  const LOADING_NOTE_MS = 700;        // "Getting ... ready" only for a file that takes a moment
  const NOTE_MS = 7000;               // how long "Skipped ..." stays

  let open = false;                   // Stage is open (the remote is on)
  let remoteShown = false;
  let how = null;                     // how Stage opens on this machine (server says): 'webview2' | 'popup'
  let howReason = null;
  let settings = { showName: true, nameSeconds: 3, windowName: 'Vault Stage', imageSeconds: 8, cursorSeconds: 1, openSize: 'free', muteVault: true, tips: true };
  let es = null;
  let popup = null;
  let popupBounds = null;             // where the pop-up was last (it reports it)

  // What is on Stage
  let cur = null;                     // { key, row, item }
  let t = 0, d = 0, paused = false, hold = false, state = null, finished = false, locked = false;
  let volume = 1, muted = false;
  let statusKey = null;
  let loadingSince = 0;
  let note = null;                    // { text, until }
  let noteTimer = null;
  let upGen = 0;
  let upTimer = null;
  const sent = new Map();             // key -> { row, via, index } of every file handed to Stage

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const $ = (id) => document.getElementById(id);
  const isModern = () => typeof vaultIsModern === 'function' ? vaultIsModern() : document.body.classList.contains('layout-modern');
  const glyph = (emoji, icon) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, icon) : esc(emoji));
  const fmt = (s) => (typeof formatDuration === 'function' ? (formatDuration(s) || '0:00') : `${Math.round(s)}s`);
  const nameOf = (row) => (document.body.classList.contains('pm-names') ? 'this file' : ((row && row.filename) || 'this file'));

  let keySeq = 0;
  const newKey = () => `k${Date.now().toString(36)}${(++keySeq).toString(36)}`;

  /* ── The remote's media element: Stage's clock, as the mini player reads it ── */

  class StageMediaProxy extends EventTarget {
    get tagName() { return 'STAGE'; }
    get duration() { return d > 0 ? d : NaN; }
    get currentTime() { return t; }
    set currentTime(v) {
      if (!cur || !(d > 0) || isPicture(cur.row)) return;
      t = Math.max(0, Math.min(d, Number(v) || 0));
      cmd({ type: 'seek', t });
      this.dispatchEvent(new Event('timeupdate'));
    }
    get paused() { return paused || hold || finished; }
    get ended() { return finished; }
    get readyState() { return 4; }
    get playbackRate() { return 1; }
    get videoWidth() { return (cur && cur.row && cur.row.width) || 16; }
    get videoHeight() { return (cur && cur.row && cur.row.height) || 9; }
    get muted() { return muted; }
    get volume() { return volume; }
    play() { togglePlay(true); return Promise.resolve(); }
    pause() { togglePlay(false); }
    removeAttribute() {}
  }
  const proxy = new StageMediaProxy();
  const fire = (name) => proxy.dispatchEvent(new Event(name));

  const isPicture = (row) => !!row && (row.media_type === 'image' || row.media_type === 'gif');

  /* ── Server ───────────────────────────────────────────────────────── */

  async function api(path, body) {
    const r = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `Server returned ${r.status}`); e.status = r.status; e.code = data.code; throw e; }
    return data;
  }

  function cmd(body) {
    return api('/api/stage/cmd', body).catch((err) => {
      if (err.status === 423) return null;
      if (err.code === 'STAGE_CLOSED') { if (open) stageGone({ how: 'gone' }); return null; }
      console.warn('[Stage] command failed:', body.type, err.message);
      return null;
    });
  }

  async function refreshState() {
    try {
      const s = await api('/api/stage/state');
      how = s.how || 'popup';
      howReason = s.howReason || null;
      if (s.settings) settings = { ...settings, ...s.settings };
      popupBounds = s.popupBounds || null;
      locked = s.locked === true;   // the state route only answers unlocked
      return s;
    } catch { return null; }
  }

  function connect() {
    if (es) return;
    es = new EventSource('/api/stage/events?role=control');
    const on = (name, fn) => es.addEventListener(name, (e) => {
      let data = {};
      try { data = JSON.parse(e.data || '{}'); } catch {}
      try { fn(data); } catch (err) { console.warn('[Stage]', name, err); }
    });
    on('sync', onSync);
    on('opened', () => { open = true; locked = false; });
    on('status', onStatus);
    on('started', onStarted);
    on('skipped', onSkipped);
    on('finished', onFinished);
    on('closed', (last) => stageGone({ how: 'closed', last }));
    on('gone', (last) => stageGone({ how: 'gone', last }));
    on('settings', (s) => { settings = { ...settings, ...s }; applyMute(); });
    on('locked', () => { locked = true; });
    on('cmd', onOtherControl);
    es.onerror = () => {
      if (!es || es.readyState !== EventSource.CLOSED) return;
      es = null;
      // Refused (locked) or the server restarted: try again in a moment.
      setTimeout(() => { if (open || remoteShown) connect(); }, 3000);
    };
  }

  function disconnect() {
    if (es) { try { es.close(); } catch {} es = null; }
  }

  /* ── Opening Stage ────────────────────────────────────────────────── */

  function openPopup() {
    const w = popupBounds;
    const size = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440] }[settings.openSize] || [960, 540];
    const feat = w ? `popup,left=${w.x},top=${w.y},width=${w.w},height=${w.h}` : `popup,width=${size[0]},height=${size[1]}`;
    try { return window.open('/stage', 'vault-stage', feat); } catch { return null; }
  }

  function blocked(retry) {
    const msg = 'Your browser blocked the Stage window. Allow pop-ups for 127.0.0.1 in the address bar, then press Open Stage again.';
    if (typeof vaultChoose === 'function') {
      vaultChoose(msg, { title: 'Stage could not open', buttons: [{ label: 'Try again', value: 'retry', primary: true }, { label: 'Close', value: null }], cancelValue: null })
        .then((v) => { if (v === 'retry') retry(); });
    } else showToast(msg, { type: 'error' });
  }

  /**
   * Open Stage (or bring it to the front). then(): what to play once it is
   * open; without it, the file playing here moves there.
   * Called from a click: a pop-up has to be opened before anything is awaited.
   */
  async function openStage({ then = null } = {}) {
    if (open) { front(); if (then) then(); return; }
    if (!how) await refreshState();
    let win = null;
    if (how === 'popup') {
      win = openPopup();
      if (!win) { blocked(() => openStage({ then })); return; }
    }
    // What plays here now, taken before anything is torn down.
    const local = then ? null : localPlayback();
    let r;
    try {
      r = await api('/api/stage/open', {});
    } catch (err) {
      if (win) { try { win.close(); } catch {} }
      if (err.status !== 423) showErrorToast ? showErrorToast(err, 'opening Stage') : showToast('Stage could not open.', { type: 'error' });
      return;
    }
    if (r.mode === 'webview2' && win) { try { win.close(); } catch {} win = null; }
    if (r.mode === 'popup' && !win) {
      // The Stage window could not start here: a pop-up instead.
      win = openPopup();
      if (!win) { blocked(() => openStage({ then })); return; }
    }
    popup = win;
    open = true;
    connect();
    if (local) {
      stopLocal(local);
      startOnStage(local.mediaData, { startAt: local.t, paused: local.paused, keepAnchor: true });
    } else if (then) {
      then();
    } else {
      showRemote();
      setNote('Stage is open. Play a file to show it there.');
    }
    if (settings.tips) showTips();
  }

  /** The file playing here (full player or mini player), with its spot, or null. */
  function localPlayback() {
    const overlayOn = !!$('mediaPlayerOverlay')?.classList.contains('active');
    const miniOn = !!$('miniPlayer')?.classList.contains('active') && !remoteShown;
    if (!overlayOn && !miniOn) return null;
    const type = currentMediaState.type;
    if (!STAGEABLE.has(type)) return null;
    const el = miniOn ? document.querySelector('#miniPlayerMedia video, #miniPlayerMedia audio') : currentMediaState.element;
    const data = currentMediaState.currentMediaData || (typeof playingMedia !== 'undefined' ? playingMedia : null);
    if (!data) return null;
    const id = currentMediaState.playbackMediaId || data.id;
    const timed = el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO');
    return {
      mediaData: { id, filepath: data.filepath, filename: data.filename, media_type: data.media_type || type },
      t: timed && isFinite(el.currentTime) ? el.currentTime : 0,
      paused: timed ? el.paused : false,
      overlayOn, miniOn,
    };
  }

  /** Stop the player here (it saves its spot as it goes, viewtracker.js). */
  function stopLocal(local) {
    if (local.miniOn) closeMiniPlayer();
    else if (local.overlayOn) closeMediaPlayer();
  }

  /* ── Sending files ────────────────────────────────────────────────── */

  function rowFor(mediaData) {
    const id = Number(mediaData && mediaData.id) || currentMediaState.playbackMediaId;
    const fromLib = (id && typeof Library !== 'undefined' && Library.row(id)) || (id && typeof getMediaById === 'function' && getMediaById(id)) || null;
    return fromLib || (mediaData && mediaData.filepath && Library.rowByPath(mediaData.filepath)) || null;
  }

  function itemFor(row, { key = newKey(), startAt = null, via = 'user', index = -1 } = {}) {
    const resume = typeof vaultSetting !== 'function' || vaultSetting('resumePlayback') !== false;
    const item = {
      // Privacy mode with file names hidden: Stage gets no name to show.
      key, id: row.id, media_type: row.media_type, filename: document.body.classList.contains('pm-names') ? '' : String(row.filename || ''),
      duration: Number(row.duration_seconds) > 0 ? Number(row.duration_seconds) : undefined,
      width: Number.isInteger(row.width) && row.width > 0 ? row.width : undefined,
      height: Number.isInteger(row.height) && row.height > 0 ? row.height : undefined,
      startAt: startAt != null ? Math.max(0, startAt) : StageRules.resumeAt(row, { resume }),
      via, index,
    };
    sent.set(key, { row, via, index });
    if (sent.size > 200) sent.delete(sent.keys().next().value);
    return item;
  }

  /**
   * playMedia, while Stage is open: the queue moves here as always (Up next,
   * the list's anchor), the file plays there. True when Stage took it.
   */
  function intercept(mediaData, opts) {
    if (!open) return false;
    const type = mediaData && mediaData.media_type;
    if (!STAGEABLE.has(type)) {
      showToast('Stage shows videos, pictures and sound. Close Stage to open this here.');
      return true;
    }
    startOnStage(mediaData, opts || {});
    return true;
  }

  function startOnStage(mediaData, { startAt = null, paused: startPaused = false, source = 'user', fromUpNext = false, keepAnchor = false } = {}) {
    noteFileOpened(mediaData, { source, fromUpNext, keepAnchor });
    currentMediaState.type = mediaData.media_type;
    currentMediaState.element = null;
    const row = rowFor(mediaData);
    if (!row || !row.id) { showToast('That file is not in the library, so Stage cannot show it.'); return; }
    const via = fromUpNext ? 'upnext' : (currentMediaState.currentIndex >= 0 ? 'list' : 'user');
    const item = itemFor(row, { startAt, via, index: currentMediaState.currentIndex });
    note = null;
    setCurrent(item.key, row);
    t = item.startAt; d = item.duration || 0; paused = startPaused; finished = false;
    loadingSince = Date.now();
    showRemote();
    paint();
    // The upcoming files go with it when they are quick to work out (a file
    // that cannot play moves straight on to them); else they follow.
    const my = ++upGen;
    const quick = new Promise((resolve) => setTimeout(() => resolve(null), 400));
    Promise.race([computeUpcoming().catch(() => null), quick]).then((upcoming) => {
      if (!open || !cur || cur.key !== item.key) return;
      const list = my === upGen && Array.isArray(upcoming) ? upcoming : [];
      syncPrivacy();
      cmd({ type: 'load', item, paused: startPaused, upcoming: list, repeat: currentRepeat() })
        .then(() => { if (!list.length || my !== upGen) sendUpcoming(); });
    });
    if (typeof UpNext !== 'undefined') UpNext.playerChanged();
  }

  function setCurrent(key, row) {
    cur = { key, row };
    statusKey = null;
    paintStill();
  }

  function currentRepeat() { return typeof repeatMode === 'function' ? repeatMode() : 'off'; }

  /** What Stage moves on to by itself, worked out from Up next and the list as they are now. */
  async function computeUpcoming() {
    const repeat = currentRepeat();
    if (repeat === 'one') return [];
    const unItems = typeof UpNext !== 'undefined' && UpNext.items ? UpNext.items().slice(0, 6) : [];
    const unRows = unItems.length ? await Library.fetchRows(unItems.map(i => i.id)).catch(() => []) : [];
    const byId = new Map((unRows || []).filter(Boolean).map(r => [r.id, r]));
    const okRow = (r) => !!r && STAGEABLE.has(r.media_type) && !(typeof isKnownBadMedia === 'function' && isKnownBadMedia(r));
    const upNext = unItems.map(i => ({ id: i.id, ok: okRow(byId.get(i.id)) }));
    if (!Library.known()) await Library.waitIds().catch(() => {});
    const length = Library.length();
    const anchor = typeof listAnchorIndex === 'function' ? listAnchorIndex() : -1;
    // The rows just after the anchor, and the top of the list for a wrap.
    const want = 24;
    if (length) {
      await Library.rowsForRange(Math.max(0, anchor + 1), Math.min(length, anchor + 1 + want)).catch(() => {});
      if (repeat === 'all') await Library.rowsForRange(0, Math.min(length, want)).catch(() => {});
    }
    const okAt = (i) => {
      const type = Library.typeAt(i);
      if (type === 'document') return false;
      const r = Library.rowAt(i);
      return okRow(r);
    };
    const plan = StageRules.upcoming({ upNext, anchor, length, okAt, repeat, count: UPCOMING_COUNT });
    const out = [];
    for (const p of plan) {
      const row = p.via === 'upnext' ? byId.get(p.id) : Library.rowAt(p.index);
      if (row) out.push(itemFor(row, { via: p.via, index: p.via === 'list' ? p.index : -1 }));
    }
    return out;
  }

  /** Tell Stage what comes next (soon after any change; one answer at a time). */
  function sendUpcoming() {
    clearTimeout(upTimer);
    upTimer = setTimeout(async () => {
      if (!open || !cur) return;
      const my = ++upGen;
      const forKey = cur.key;
      let list = [];
      try { list = await computeUpcoming(); } catch (err) { console.warn('[Stage] upcoming:', err); }
      if (my !== upGen || !open || !cur || cur.key !== forKey) return;
      await cmd({ type: 'upcoming', upcoming: list, repeat: currentRepeat(), forKey });
      // Finished, and now there is something to play: carry on.
      if (finished && list.length) finished = false;
      paint();
    }, 60);
  }

  /* ── What Stage reports ───────────────────────────────────────────── */

  function onSync(s) {
    if (s.settings) settings = { ...settings, ...s.settings };
    // The server says whether it is locked now: an earlier lock is over once it says not.
    locked = s.locked === true;
    volume = Number.isFinite(s.volume) ? s.volume : volume;
    muted = s.muted === true;
    hold = s.hold === true;
    if (!s.open) {
      if (open && remoteShown) stageGone({ how: 'gone', last: { current: cur && cur.row ? { key: cur.key, id: cur.row.id } : null, t, paused: true } });
      return;
    }
    open = true;
    // This page reloaded (or unlocked) while Stage played: pick up what is on Stage.
    if (s.current && (!cur || cur.key !== s.current.key)) adoptCurrent(s.current, s);
    else if (s.status) onStatus(s.status);
    showRemote();
    paint();
  }

  async function adoptCurrent(item, s) {
    let row = null;
    try { [row] = await Library.fetchRows([item.id]); } catch {}
    row = row || { id: item.id, filename: item.filename, media_type: item.media_type, duration_seconds: item.duration, width: item.width, height: item.height };
    if (row.filepath) noteFileOpened({ id: row.id, filepath: row.filepath, filename: row.filename, media_type: row.media_type }, {});
    currentMediaState.type = row.media_type;
    currentMediaState.element = null;
    sent.set(item.key, { row, via: item.via, index: item.index });
    setCurrent(item.key, row);
    if (s && s.status) onStatus(s.status);
    if (s && s.locked) setNote('Stage went black. Unlock to carry on.', { sticky: true });
    showRemote();
    paint();
    sendUpcoming();
  }

  function onStatus(r) {
    if (!cur) return;
    if (r.key !== cur.key) {
      // Still the file before: the new one is getting ready.
      if (r.state !== 'loading' && Date.now() - loadingSince > LOADING_NOTE_MS) paintMeta();
      return;
    }
    const wasPaused = proxy.paused;
    const oldD = d;
    statusKey = r.key;
    t = r.t; d = r.d || d; paused = r.paused; hold = r.hold; state = r.state;
    if (state !== 'loading') loadingSince = 0;
    if (state === 'black') finished = true;
    else if (state === 'playing' || state === 'picture') finished = false;
    // The spot Stage saved, so the next resume here starts right.
    const row = cur.row;
    if (row && !isPicture(row) && d > 0) {
      const pos = StageRules.positionToSave(t, d);
      if (pos !== null) row.last_position = pos;
    }
    if (oldD !== d) fire('durationchange');
    fire('timeupdate');
    if (wasPaused !== proxy.paused) fire(proxy.paused ? 'pause' : 'play');
    paintMeta();
    paintHold();
  }

  /** Stage started a file: one Control sent (confirmation), or the next one on its own. */
  function onStarted({ item, auto }) {
    if (!item) return;
    if (!auto) {
      if (cur && cur.key === item.key) { loadingSince = 0; finished = false; paint(); }
      return;
    }
    // Moved on by itself: the queue here catches up, in turn with any Next pressed.
    queueNav(async () => {
      const meta = sent.get(item.key);
      let row = meta && meta.row;
      if (!row) { try { [row] = await Library.fetchRows([item.id]); } catch {} }
      if (!row) return;
      const fromUpNext = item.via === 'upnext';
      if (fromUpNext && typeof UpNext !== 'undefined') UpNext.take(item.id);
      noteFileOpened({ id: row.id, filepath: row.filepath, filename: row.filename, media_type: row.media_type },
        { source: 'auto', fromUpNext });
      currentMediaState.type = row.media_type;
      currentMediaState.element = null;
      if (note && note.sticky) note = null;
      setCurrent(item.key, row);
      t = item.startAt || 0; d = item.duration || 0; paused = false; finished = false; loadingSince = 0;
      paint();
      if (typeof UpNext !== 'undefined') UpNext.playerChanged();
      if (typeof refreshSidebarIfOpen === 'function') refreshSidebarIfOpen();
      sendUpcoming();
    });
  }

  function onSkipped({ item, key }) {
    const meta = sent.get(key);
    const row = (meta && meta.row) || item;
    setNote(`Skipped “${nameOf(row)}”: it can’t be played.`);
    // A file from Up next that cannot play is used up, as the player does.
    if (item && item.via === 'upnext' && typeof UpNext !== 'undefined') UpNext.take(item.id);
    if (cur && key === cur.key) sendUpcoming();
  }

  function onFinished() {
    finished = true;
    paused = true;
    fire('pause');
    const listName = typeof getCollectionById === 'function' && typeof activeCollectionId !== 'undefined' && getCollectionById(activeCollectionId)
      ? getCollectionById(activeCollectionId).name : 'the list';
    setNote(`End of ${listName}.`, { sticky: true });
    paint();
  }

  /** Another Vault tab sent a command: show what it did. */
  function onOtherControl(c) {
    if (c.type === 'hold') { hold = c.on; paintHold(); }
    if (c.type === 'volume') { volume = c.volume; muted = c.muted; paintVolume(); }
  }

  /* ── Remote controls ──────────────────────────────────────────────── */

  function togglePlay(want) {
    if (!open || !cur) return;
    const play = want === undefined ? proxy.paused : want;
    if (hold && play) { setHold(false); return; }
    if (finished && play) {
      // The end: Next if anything is lined up, else the list again from the top.
      finished = false;
      if (typeof playerHasNext === 'function' && playerHasNext()) playNextMedia();
      else if (Library.length()) queueNav(async () => { const i = await nextPlayableIndex(-1, 1); if (i !== -1) await playIndexHandsFree(i); });
      return;
    }
    paused = !play;
    cmd({ type: play ? 'play' : 'pause' });
    fire(play ? 'play' : 'pause');
  }

  function setHold(on) {
    hold = !!on;
    cmd({ type: 'hold', on: hold });
    paintHold();
    paintMeta();
    fire(hold ? 'pause' : 'play');
  }
  function toggleHold() { if (open) setHold(!hold); }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (volume > 0) muted = false;
    cmd({ type: 'volume', volume, muted });
    paintVolume();
  }
  function toggleMute() {
    muted = !muted;
    cmd({ type: 'volume', volume, muted });
    paintVolume();
  }

  function front() { cmd({ type: 'front' }); if (popup && !popup.closed) { try { popup.focus(); } catch {} } }

  function setSize(preset) { cmd({ type: 'size', preset }); }

  /** Close Stage from here: the file carries on in the mini player at the same spot. */
  async function closeStage() {
    if (!open) return;
    const r = await cmd({ type: 'close' });
    const last = r && r.last ? r.last : { t, paused: proxy.paused };
    handBack({ t: last.t != null ? last.t : t, paused: hold || finished || !!last.paused, how: 'closed' });
  }

  /** Stage closed (its own window) or vanished. */
  function stageGone({ how: kind, last }) {
    if (!open && !remoteShown) return;
    const at = last && last.t != null ? last.t : t;
    if (kind === 'closed') handBack({ t: at, paused: !!(last && last.paused), how: 'closed' });
    else handBack({ t: at, paused: true, how: 'gone' });
  }

  /** Back to the mini player: the same file at the same spot (maximizeAt, player-core.js). */
  function handBack({ t: at, paused: wasPaused, how: kind }) {
    const row = cur && cur.row;
    open = false;
    sentHideNames = null;
    hideTips();
    closeMenu();
    leaveRemote();
    disconnect();
    popup = null;
    cur = null;
    applyMute();
    const words = kind === 'gone' ? 'Stage was closed' : 'Stage closed';
    if (row && row.filepath && (row.media_type === 'video' || row.media_type === 'audio')) {
      playMedia({ id: row.id, filepath: row.filepath, filename: row.filename, media_type: row.media_type }, { keepAnchor: true });
      const el = currentMediaState.element;
      if (el) {
        el.dataset.maximizeAt = String(at || 0);
        if (wasPaused) el.dataset.maximizePaused = '1';
      }
      minimizePlayer();
      showToast(wasPaused ? `${words}. Paused here at ${fmt(at || 0)}.` : `${words}. Playing here from ${fmt(at || 0)}.`);
    } else {
      showToast(`${words}.`);
    }
    // A connection kept for a Stage opened again later.
    refreshState();
  }

  function stageButton(e) {
    if (e && e.button === 2) return;
    if (open) closeStage();
    else openStage();
  }

  /** The full player's Stage button: the file moves there, this shrinks to the remote. */
  function openFromPlayer() { openStage(); }

  /** Play on Stage, in the collection bar. */
  function playCollectionOnStage(id) {
    openStage({ then: () => { if (typeof playCollection === 'function') playCollection(id, false); } });
  }

  function key(e) {
    if (e.key === 'Escape') {
      if (menuOpen()) { closeMenu(); return true; }
      if (tipsOpen()) { hideTips(); return true; }
      return true;                    // Esc never closes Stage by accident
    }
    if (e.key === 'q' || e.key === 'Q') return true;
    if (/^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (cur && d > 0 && !isPicture(cur.row)) proxy.currentTime = (Number(e.key) / 10) * d;
      return true;
    }
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.altKey && !e.metaKey) { toggleHold(); return true; }
    return false;
  }

  /* ── The remote (the mini player box, dressed for Stage) ──────────── */

  function showRemote() {
    const box = $('miniPlayer');
    if (!box) return;
    // The full player is never up while Stage is open.
    if ($('mediaPlayerOverlay')?.classList.contains('active') && !remoteShown) closeMediaPlayer();
    if (!remoteShown) {
      remoteShown = true;
      document.body.classList.add('stage-open');
      box.classList.add('active', 'mini-stage');
      $('miniPlayerMedia').innerHTML = '<img class="mini-stage-still" id="miniStageStill" alt="" draggable="false" hidden>';
      currentMediaState.miniMode = false;
      if (typeof miniPlayerOpen === 'function') miniPlayerOpen(proxy, (cur && cur.row && cur.row.media_type) === 'audio' ? 'audio' : 'video');
      applyMute();
      if (typeof renderSelectionBar === 'function') renderSelectionBar();
    }
    paint();
  }

  function leaveRemote() {
    const box = $('miniPlayer');
    if (!remoteShown || !box) { remoteShown = false; return; }
    remoteShown = false;
    document.body.classList.remove('stage-open');
    if (typeof miniPlayerTeardown === 'function') miniPlayerTeardown();
    box.classList.remove('mini-stage', 'active', 'mini-audio');
    $('miniPlayerMedia').innerHTML = '';
    if (typeof UpNext !== 'undefined') UpNext.closePopover();
    if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
  }

  /** A lock hides the remote (Stage stays black); this page reloads on unlock and picks it up again. */
  function hideRemote() {
    hideTips();
    closeMenu();
    leaveRemote();
  }

  function paint() {
    if (!remoteShown) return;
    paintStill();
    paintHold();
    paintVolume();
    paintRepeat();
    paintMeta();
    const btn = $('miniStageBtn');
    if (btn) {
      btn.title = open ? 'Close Stage and keep playing here (right-click for more)' : 'Open Stage, the window you share in Discord';
      btn.setAttribute('aria-label', open ? 'Close Stage' : 'Open Stage');
      btn.classList.toggle('on', open);
    }
    if (typeof miniUpdateTimeline === 'function') miniUpdateTimeline();
    if (typeof updateMiniPlayPause === 'function') updateMiniPlayPause();
    if (typeof miniLayout === 'function') miniLayout();
  }

  function paintStill() {
    const img = $('miniStageStill');
    const row = cur && cur.row;
    const box = $('miniPlayer');
    if (box) box.classList.toggle('mini-audio', !!row && row.media_type === 'audio');
    if (!img) return;
    const can = row && typeof canShowThumb === 'function' && canShowThumb(row) && typeof staticThumbSrc === 'function';
    const src = can ? staticThumbSrc(row.id) : '';
    if (!src) { img.hidden = true; img.removeAttribute('src'); return; }
    if (img.dataset.forId === String(row.id)) return;
    img.dataset.forId = String(row.id);
    img.onload = () => { img.hidden = false; };
    img.onerror = () => { img.hidden = true; };
    img.src = src;
  }

  function paintHold() {
    const pill = $('miniStagePill');
    if (pill) {
      const word = locked ? 'Black' : hold ? 'Holding' : finished ? 'Finished' : 'On Stage';
      pill.classList.toggle('hold', hold || finished || locked);
      const w = pill.querySelector('.msp-word');
      if (w) w.textContent = word;
    }
    const btn = $('miniHoldBtn');
    if (btn) {
      btn.setAttribute('aria-pressed', hold ? 'true' : 'false');
      btn.title = hold ? 'Holding: Stage is black and silent. Press to come back (H)' : 'Hold: Stage goes black and silent (H)';
      btn.classList.toggle('on', hold);
    }
  }

  function paintVolume() {
    const btn = $('miniMuteBtn');
    const slider = $('miniVolSlider');
    const silent = muted || volume === 0;
    if (btn) {
      btn.innerHTML = glyph(silent ? '🔇' : '🔊', silent ? 'mute' : 'volume');
      btn.title = silent ? 'Unmute Stage' : 'Stage volume';
      btn.setAttribute('aria-label', silent ? 'Unmute Stage' : 'Mute Stage');
      btn.setAttribute('aria-pressed', silent ? 'true' : 'false');
    }
    if (slider && !slider.matches(':active')) { slider.max = '1'; slider.value = String(silent ? 0 : volume); }
  }

  function paintRepeat() {
    const btn = $('miniRepeatBtn');
    if (!btn) return;
    const mode = currentRepeat();
    const titles = { off: 'Repeat: off. Click to repeat the list', all: 'Repeat all. Click to repeat this file', one: 'Repeat this file. Click to turn repeat off' };
    btn.innerHTML = glyph(mode === 'one' ? '🔂' : '🔁', mode === 'one' ? 'repeat-one' : 'repeat');
    btn.title = titles[mode];
    btn.setAttribute('aria-label', mode === 'off' ? 'Repeat: off' : mode === 'all' ? 'Repeat all' : 'Repeat this file');
    btn.classList.toggle('on', mode !== 'off');
    btn.dataset.mode = mode;
  }

  /** The line under the seek bar: the file and its time, or what just happened. */
  function paintMeta() {
    const title = $('miniPlayerTitle');
    const time = $('miniTime');
    if (!title || !remoteShown) return;
    const row = cur && cur.row;
    let line = row ? nameOf(row) : 'Stage is open';
    let right = null;
    const n = note && (note.sticky || Date.now() < note.until) ? note.text : null;
    if (locked) line = 'Stage went black. Unlock to carry on.';
    else if (hold) line = `Holding. ${cur && !isPicture(cur.row) ? `Paused at ${fmt(t)}. ` : ''}Press Hold again to come back.`;
    else if (n) line = n;
    else if (cur && statusKey !== cur.key && loadingSince && Date.now() - loadingSince > LOADING_NOTE_MS) line = `Getting “${nameOf(row)}” ready…`;
    if (row && isPicture(row) && statusKey === cur.key && !hold && !finished) {
      const left = Math.max(0, Math.ceil(d - t));
      right = paused ? `paused · ${left} s left` : `next in ${left} s`;
    }
    title.textContent = line;
    title.title = line;
    if (time && right !== null) time.textContent = right;
  }

  function setNote(text, { sticky = false } = {}) {
    note = { text, until: Date.now() + NOTE_MS, sticky };
    clearTimeout(noteTimer);
    if (!sticky) noteTimer = setTimeout(() => { note = null; paintMeta(); }, NOTE_MS + 50);
    paintMeta();
  }

  /* ── Vault's own sound while Stage is open ────────────────────────── */

  const mutedByStage = new WeakSet();
  function applyMute() {
    const on = open && settings.muteVault !== false;
    document.querySelectorAll('video, audio').forEach((el) => {
      if (on && !el.muted) { el.muted = true; mutedByStage.add(el); }
      else if (!on && mutedByStage.has(el)) { el.muted = false; mutedByStage.delete(el); }
    });
  }
  // Anything that starts making sound here while Stage is open (a preview, the Wall).
  document.addEventListener('play', (e) => {
    const el = e.target;
    if (!open || settings.muteVault === false || !(el instanceof HTMLMediaElement) || el.muted) return;
    el.muted = true;
    mutedByStage.add(el);
  }, true);

  /* ── Right-click menu on the Stage button ─────────────────────────── */

  function menuOpen() { return !!$('stageMenu') && !$('stageMenu').hidden; }

  async function menu(e) {
    if (e) e.preventDefault();
    if (!open) return;
    let size = 'free';
    try { const s = await api('/api/stage/state'); size = s.size || 'free'; } catch {}
    let el = $('stageMenu');
    if (!el) {
      el = document.createElement('div');
      el.id = 'stageMenu';
      el.className = 'stage-menu';
      el.setAttribute('role', 'menu');
      document.body.appendChild(el);
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-stage-act]');
        if (!b) return;
        const act = b.dataset.stageAct;
        closeMenu();
        if (act === 'front') front();
        else if (act === 'close') closeStage();
        else setSize(act);
      });
    }
    const check = (p) => (p === size ? '<span class="sm-check" aria-hidden="true">✓</span>' : '<span class="sm-check" aria-hidden="true"></span>');
    const item = (act, label, sub) => `<button type="button" role="menuitemradio" aria-checked="${act === size}" data-stage-act="${act}">${check(act)}<span class="sm-l">${esc(label)}</span>${sub ? `<span class="sm-s">${esc(sub)}</span>` : ''}</button>`;
    el.innerHTML = `
      <div class="sm-h">Stage</div>
      <button type="button" role="menuitem" data-stage-act="front"><span class="sm-check"></span><span class="sm-l">Bring Stage to the front</span></button>
      <div class="sm-h">Size</div>
      ${item('free', 'Free size', 'drag and snap')}
      ${item('720p', '720p', '1280 × 720')}
      ${item('1080p', '1080p', '1920 × 1080')}
      ${item('1440p', '1440p', '2560 × 1440')}
      <div class="sm-sep"></div>
      <button type="button" role="menuitem" data-stage-act="close" class="sm-close"><span class="sm-check"></span><span class="sm-l">Close Stage</span><span class="sm-s">plays on here</span></button>`;
    el.hidden = false;
    placeNear(el);
    setTimeout(() => document.addEventListener('pointerdown', menuOutside, true), 0);
    el.querySelector('button')?.focus({ preventScroll: true });
  }

  function menuOutside(e) {
    const el = $('stageMenu');
    if (el && el.contains(e.target)) return;
    closeMenu();
  }

  function closeMenu() {
    const el = $('stageMenu');
    if (el) el.hidden = true;
    document.removeEventListener('pointerdown', menuOutside, true);
  }

  /** Above the mini player (below it when it sits at the top), lined up with its outer edge. */
  function placeNear(el) {
    const mini = $('miniPlayer');
    if (!mini) return;
    const r = mini.getBoundingClientRect();
    const de = document.documentElement;
    const vw = de.clientWidth || window.innerWidth;
    const vh = de.clientHeight || window.innerHeight;
    const gap = 8;
    const w = Math.min(el.offsetWidth || 300, vw - 2 * gap);
    const right = r.left + r.width / 2 > vw / 2;
    el.style.left = `${Math.max(gap, Math.min(vw - w - gap, right ? r.right - w : r.left))}px`;
    const h = el.offsetHeight;
    const up = r.top - gap - h >= gap || r.top > vh - r.bottom;
    el.style.top = `${up ? Math.max(gap, r.top - gap - h) : Math.min(vh - h - gap, r.bottom + gap)}px`;
  }

  /* ── First-time tips ──────────────────────────────────────────────── */

  function tipsOpen() { return !!$('stageTips') && !$('stageTips').hidden; }

  function showTips() {
    let el = $('stageTips');
    if (!el) {
      el = document.createElement('div');
      el.id = 'stageTips';
      el.className = 'stage-tips';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Stage is open');
      document.body.appendChild(el);
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-tips]');
        if (!b) return;
        if (b.dataset.tips === 'never') {
          settings.tips = false;
          api('/api/stage/settings', { tips: false }).catch(() => {});
        }
        hideTips();
      });
    }
    const name = esc(settings.windowName || 'Vault Stage');
    el.innerHTML = `
      <div class="st-head"><b>Stage is open</b><button type="button" class="st-x" data-tips="close" aria-label="Close">${glyph('✕', 'close')}</button></div>
      <ol class="st-list">
        <li>In Discord, start a screen share and pick the window named <b>${name}</b>.</li>
        <li>Turn on sound in Discord's share options.</li>
        <li>Stage runs as its own window, so Discord picks up Stage's sound, not your other browser tabs.</li>
        <li>Run everything from here. ${settings.muteVault !== false ? 'Vault’s own sound is muted while Stage is open.' : 'Vault’s own sound stays on (Settings › Stage).'}</li>
      </ol>
      <div class="st-acts"><button type="button" class="st-btn" data-tips="never">Don't show again</button><button type="button" class="st-btn st-pri" data-tips="ok">Got it</button></div>`;
    el.hidden = false;
    requestAnimationFrame(() => placeNear(el));
  }

  function hideTips() { const el = $('stageTips'); if (el) el.hidden = true; }

  window.addEventListener('resize', () => {
    if (menuOpen()) placeNear($('stageMenu'));
    if (tipsOpen()) placeNear($('stageTips'));
  });

  /* ── Privacy mode: file names hidden ──────────────────────────────── */

  // Files are sent without a name while Vault hides file names (itemFor).
  // Turning that on or off while Stage plays tells Stage at once (it drops
  // the names it holds, and a name on screen goes), and the files lined up
  // there are sent again, with or without their names.
  let sentHideNames = null;
  const namesHidden = () => document.body.classList.contains('pm-names');
  function syncPrivacy() {
    const on = namesHidden();
    if (on === sentHideNames) return;
    sentHideNames = on;
    cmd({ type: 'privacy', hideNames: on });
  }
  function privacyChanged() {
    if (!open) return;
    syncPrivacy();
    if (cur) sendUpcoming();
    paintMeta();
  }
  if (typeof MutationObserver === 'function') {
    let was = null;
    new MutationObserver(() => {
      const now = namesHidden();
      if (now === was) return;
      was = now;
      privacyChanged();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── Changes here that change what comes next ─────────────────────── */

  function upNextChanged() { if (open && cur) sendUpcoming(); }
  function repeatChanged() { if (open && cur) { paintRepeat(); sendUpcoming(); } }

  // Keep the loading note and the picture countdown moving even with no reports.
  setInterval(() => { if (remoteShown) paintMeta(); }, 1000);

  /* ── Boot: Stage may already be open (this page reloaded, or unlocked) ── */

  async function boot() {
    const s = await refreshState();
    if (s && s.open) { open = true; connect(); }
  }
  window.addEventListener('vault:library-loaded', () => { if (!es) boot(); }, { once: false });
  boot();

  return {
    proxy, intercept, on: () => open && remoteShown, isOpen: () => open,
    openStage, openFromPlayer, playCollectionOnStage, stageButton, closeStage, menu, front, setSize,
    toggleHold, setVolume, toggleMute, paintVolume, key, hideRemote,
    upNextChanged, repeatChanged, showTips,
    _state: () => ({ open, remoteShown, how, cur: cur && { key: cur.key, id: cur.row && cur.row.id }, t, d, paused, hold, finished, volume, muted, note: note && note.text }),
  };
})();
