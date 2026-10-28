/* =========================================================================
   STAGE CONTROL - the Vault window's side of Stage (PLAYLISTS_SPEC 5).

   Stage is the window shared in Discord: the user's own mpv, started and
   driven by the server (lib/stage/engine.js, PLAYLISTS_SPEC "Stage host,
   final"). Everything is run from here: while Stage is open the Stage bar
   along the bottom of the window is its remote (player-lib/stage-bar.js;
   the mini player is hidden under it, its clock Stage's), and every way of
   playing a file (a tile, Next, Up next, Play all, a Wall block) plays it on
   Stage instead (playMedia asks intercept() first, player-core.js).

   The link goes through the server (lib/stage/hub.js): commands out
   (/api/stage/cmd), Stage's reports in over an event stream. Stage moves on
   by itself when a file ends, because this tab is often in the background
   (the streamer is in Discord) where the browser slows its timers or
   freezes the page: every file sent goes with a long list of what comes
   after (Up next first, then the rest of the list, round again with Repeat
   all, player-lib/stage-rules.js upcoming(), UPCOMING_COUNT), the server
   lines the next one up in mpv, and when Stage reports that one of them
   started, the queue here catches up (Up next, the list's anchor) and
   sends a fresh list. A list that cannot be worked out is never sent short
   or empty: Stage keeps the one it has.

   Basic Stage, when mpv is not there (or Settings › Stage says Basic): the
   browser's own picture-in-picture of the mini player's video, in this
   page. No extra program; the mini player keeps playing (its own element,
   volume, Up next, Next and Previous), hidden under the Stage bar, which
   runs it with the Stage pill, Repeat, Hold and the Stage menu. The queue
   moves on with player-core's own logic, each video loaded into the same
   element (player-core.js playMedia reuseEl), so the picture-in-picture
   window never has to move or be asked for again. If the browser closes
   it anyway, Stage stays open and the bar offers to reopen it (pipLeft).
   Videos only: anything else the queue reaches is passed over and said.
   Hold pauses and mutes (it cannot go black). A lock leaves
   picture-in-picture at once.

   The bar's X closes Stage and stops: nothing plays on, in this Vault tab
   or any other (the server's "closed" report says stop). Closing Stage
   any other way (Close Stage in its menu, the window's own close) hands the
   file back to the mini player at the same spot, with sound, and the bar
   goes. Stage vanishing (a crash, sleep) says "Stage was closed", paused.

   Hooks elsewhere: playMedia (intercept), maximizePlayer and closeMiniPlayer
   (on, hideRemote), mini-player.js (miniMediaEl returns the proxy below, the
   volume), app.js (key), up-next.js render (upNextChanged) and its list's
   place (StageBar.anchorRect), the repeat button (repeatChanged).
   ========================================================================= */

const StageControl = (() => {
  const STAGEABLE = new Set(['video', 'image', 'gif', 'audio']);
  // How much Stage is handed to play on its own (lib/stage/hub.js
  // MAX_UPCOMING): the rest of the list and Up next, so it keeps going for
  // hours while this tab is in the background, throttled or frozen.
  const UPCOMING_COUNT = 500;
  const SENT_MAX = 3 * UPCOMING_COUNT;
  const LOADING_NOTE_MS = 700;        // "Getting ... ready" only for a file that takes a moment
  const NOTE_MS = 7000;               // how long "Skipped ..." stays

  let open = false;                   // Stage is open (the remote is on)
  let remoteShown = false;
  let mpv = null;                     // is mpv there (server says): { found, path, version, ... }
  let settings = { showName: true, nameSeconds: 3, windowName: 'Vault Stage', imageSeconds: 8, cursorSeconds: 1, openSize: 'free', muteVault: true, tips: true };
  let es = null;

  // What is on Stage
  let cur = null;                     // { key, row, item }
  let t = 0, d = 0, paused = false, hold = false, state = null, finished = false, locked = false;
  let volume = 1, muted = false;
  let statusKey = null;
  let closeGen = 0;                   // bumped when Stage closes here: a reply still on its way is dropped
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

  /**
   * One command to Stage. Resolves its answer, or null when it did not get
   * there. tries: waits (ms) before each further try after a network or
   * server error (a busy or restarting server); load and upcoming use them,
   * since a lost one leaves Stage without its next files. A refusal (4xx)
   * is never tried again.
   */
  const CMD_RETRY_MS = [500, 1500, 4000];
  async function cmd(body, { tries = [] } = {}) {
    const gen = closeGen;
    for (let k = 0; ; k++) {
      try {
        return await api('/api/stage/cmd', body);
      } catch (err) {
        if (err.status === 423) return null;
        if (err.code === 'STAGE_CLOSED') { if (open && !basic) stageGone({ how: 'gone' }); return null; }
        const again = k < tries.length && !(err.status >= 400 && err.status < 500) && gen === closeGen && open;
        if (!again) {
          console.warn('[Stage] command failed:', body.type, err.message);
          return null;
        }
        await new Promise(r => setTimeout(r, tries[k]));
        if (gen !== closeGen || !open) return null;
      }
    }
  }

  async function refreshState() {
    try {
      const s = await api('/api/stage/state');
      mpv = s.mpv || null;
      if (s.settings) settings = { ...settings, ...s.settings };
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

  let opening = null;                 // the open in progress (a promise)

  /**
   * Open Stage (or bring it to the front). then(): what to play once it is
   * open; without it, the file playing here moves there. A second call while
   * Stage is opening waits for that open, then does its own part (its then).
   */
  async function openStage({ then = null } = {}) {
    if (open) {
      front();
      if (then) { if (basic) markListStart(); then(); }
      return;
    }
    if (opening) {
      await opening;
      if (open && then) then();
      return;
    }
    // Basic Stage needs the click that opened it (picture-in-picture asks for
    // one), so it starts from here, after one quick look at what is set.
    opening = (async () => {
      await refreshState();
      if (wantBasic()) { startBasic({ then }); return; }
      await doOpen({ then });
    })();
    try { await opening; } finally { opening = null; }
  }

  async function doOpen({ then }) {
    // What plays here now, taken before anything is torn down.
    const local = then ? null : localPlayback();
    try {
      const r = await api('/api/stage/open', {});
      if (r && r.mode === 'basic') { startBasic({ then }); return; }
    } catch (err) {
      if (err.code === 'MPV_MISSING') { startBasic({ then }); return; }
      if (err.status !== 423) {
        if (typeof showErrorToast === 'function') showErrorToast(err, 'opening Stage');
        else showToast('Stage could not open.', { type: 'error' });
      }
      return;
    }
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
    if (sent.size > SENT_MAX) sent.delete(sent.keys().next().value);
    return item;
  }

  /**
   * playMedia, while Stage is open: the queue moves here as always (Up next,
   * the list's anchor), the file plays there. True when Stage took it.
   */
  function intercept(mediaData, opts) {
    if (!open) return false;
    if (basic) return basicIntercept(mediaData, opts);
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
    // that cannot play moves straight on to them); else they follow as soon
    // as they are worked out, straight from that answer: no timer, which a
    // background tab would slow down. A list worked out before a change
    // still goes (never an empty one in its place); the change's own answer
    // (sendUpcoming) replaces it.
    const my = ++upGen;
    loadingKey = item.key;
    upAfterLoad = false;
    const computing = computeUpcoming();
    computing.catch(() => {});
    const quick = new Promise((resolve) => setTimeout(() => resolve(null), 400));
    Promise.race([computing.catch(() => null), quick]).then((upcoming) => {
      if (!open || !cur || cur.key !== item.key) return;
      const list = Array.isArray(upcoming) ? upcoming : [];
      syncPrivacy();
      cmd({ type: 'load', item, paused: startPaused, upcoming: list, repeat: currentRepeat() }, { tries: CMD_RETRY_MS })
        .then((r) => {
          if (loadingKey === item.key) loadingKey = null;
          // A newer list (an Up next edit) waited for this load: it goes now.
          const waiting = upAfterLoad;
          upAfterLoad = false;
          if (!r || !open || !cur || cur.key !== item.key) return;
          if (waiting || my !== upGen) { sendUpcoming(); return; }
          if (Array.isArray(upcoming)) return;
          computing.then((later) => {
            if (my === upGen && open && cur && cur.key === item.key) sendList(later, item.key);
          }, () => sendUpcoming());
        });
    });
    if (typeof UpNext !== 'undefined') UpNext.playerChanged();
  }

  function setCurrent(key, row) {
    cur = { key, row };
    statusKey = null;
    paint();
    if (typeof flowStageCurrent === 'function') flowStageCurrent(row);   // the Stage bar's tempo and energy (flow.js)
  }

  function currentRepeat() { return typeof repeatMode === 'function' ? repeatMode() : 'off'; }

  /* ── The list Stage plays from ────────────────────────────────────────
     Stage keeps playing the list it was started from while the user looks
     around (another collection, the Library tab, the Wall): the queue
     (player-core.js queueList: Next, Previous, Basic Stage moving on) and
     what mpv is handed (computeUpcoming) walk that list's order as it was
     last on screen, until the user is back on it; then the grid's own list
     is used again (a reorder there included). Back to Stage on the bar goes
     back to it. A file opened from outside any list (a person's page in
     Faces, the Wall) leaves no list: the queue goes on with what is on
     screen, as it always did, and there is nowhere to go back to. */

  let source = null;                  // { kind: 'collection' | 'library' | null, tab, cid, ids, types }
  let sourceList = null;              // the list object made from source.ids (snapshotList)

  const stageOn = () => open || basic;

  function viewNow() {
    const tab = typeof currentTab !== 'undefined' ? currentTab : 'library';
    const cid = typeof activeCollectionId !== 'undefined' && activeCollectionId != null ? activeCollectionId : null;
    return { tab, cid };
  }
  const sameView = (a, b) => !!a && !!b && a.tab === b.tab && a.cid === b.cid;
  /** The grid holds the view's own result (not the one before it, in the middle of a switch). */
  function libraryIsView(v) {
    const spec = typeof Library !== 'undefined' ? Library.spec : null;
    return !spec || (spec.collectionId == null ? null : spec.collectionId) === v.cid;
  }

  function takeSource(v) {
    const kind = v.cid != null ? (v.tab === 'collections' ? 'collection' : null) : (v.tab === 'library' ? 'library' : null);
    if (!source || !sameView(source, v)) { upPlayed = 0; lastListIndex = -1; }
    source = { kind, tab: v.tab, cid: v.cid, ids: Library.ids || null, types: Library.types || null };
    if (source.ids) return;
    const s = source;
    Library.waitIds().then((ids) => {
      if (source === s && ids && sameView(viewNow(), s) && libraryIsView(s)) { s.ids = ids; s.types = Library.types; }
    }).catch(() => {});
  }

  /** The list's order as kept, walked the way player-core.js walks Library. */
  function snapshotList(s) {
    if (sourceList && sourceList.ids === s.ids) return sourceList;
    const ids = s.ids, types = s.types;
    const names = Library.TYPE_NAMES || [];
    sourceList = {
      ids, types,
      known: () => true,
      get firstPageIds() { return ids; },
      waitIds: () => Promise.resolve(ids),
      length: () => ids.length,
      idAt: (i) => (i >= 0 ? ids[i] : undefined),
      indexOf: (id) => (id ? ids.indexOf(Number(id)) : -1),
      typeAt: (i) => (types ? names[types[i]] || '' : ((Library.row(ids[i]) || {}).media_type || '')),
      rowAt: (i) => Library.row(ids[i]),
      rowsForRange: (a, b, opts) => {
        const from = Math.max(0, a), to = Math.min(ids.length, b);
        return Library.fetchRows(Array.from(ids.subarray ? ids.subarray(from, Math.max(from, to)) : ids.slice(from, to)), opts);
      },
    };
    return sourceList;
  }

  /**
   * player-core.js queueList: the list the queue walks while Stage plays
   * one the user has browsed away from, or null (the grid's own, Library).
   */
  function queueList() {
    if (!stageOn() || !source) return null;
    const v = viewNow();
    if (sameView(source, v) && libraryIsView(v)) {
      // On it: the grid's own list, kept for when the user looks elsewhere.
      if (Library.ids) { source.ids = Library.ids; source.types = Library.types; }
      return null;
    }
    return source.ids ? snapshotList(source) : null;
  }
  const listNow = () => queueList() || Library;

  /**
   * player-core.js noteFileOpened, after the list's anchor moved: which list
   * Stage plays now. inStageList: the file was found in the kept list (the
   * queue moved on in it while the user was elsewhere); keep: the same file
   * opened again.
   */
  function fileOpened({ inStageList = false, fromUpNext = false, keep = false, auto = false } = {}) {
    if (!stageOn()) return;
    // An Up next file plays between list files: it never changes the list,
    // even when it is also in what is on screen (the Library tab, say).
    if (!inStageList && !(keep && source) && !(fromUpNext && source)) {
      const v = viewNow();
      if (currentMediaState.currentIndex >= 0 && libraryIsView(v)) takeSource(v);
      else if (!fromUpNext) { source = null; upPlayed = 0; lastListIndex = -1; }
    }
    if (keep) return;
    // The track count: Up next files played so far (StageCount.nextUpPlayed).
    if (typeof StageCount === 'undefined' || !source) return;
    const index = typeof listAnchorIndex === 'function' ? listAnchorIndex() : -1;
    const via = fromUpNext ? 'upnext' : (index >= 0 ? 'list' : 'user');
    upPlayed = StageCount.nextUpPlayed(upPlayed, { via, index, lastIndex: lastListIndex, auto });
    if (via === 'list') lastListIndex = index;
  }

  function forgetSource() { source = null; sourceList = null; upPlayed = 0; lastListIndex = -1; }

  /** Back to Stage shows: Stage plays a collection, or the Library tab, that is not on screen. */
  function canGoBack() {
    if (!stageOn() || !source || !source.kind) return false;
    if (source.kind === 'collection' && typeof getCollectionById === 'function' && !getCollectionById(source.cid)) return false;
    return !sameView(source, viewNow());
  }

  function backTitle() {
    if (!source) return '';
    if (source.kind === 'collection') {
      const c = typeof getCollectionById === 'function' ? getCollectionById(source.cid) : null;
      return c && c.name ? `Back to “${c.name}”, where Stage is playing from` : 'Back to the collection Stage is playing from';
    }
    return 'Back to the Library, where Stage is playing from';
  }

  /** The id of the file on Stage (either Stage), or null. */
  /**
   * The file Basic Stage plays: its row in the results, or (a file from Up
   * next that is not in them, which has none there) the library's row for it.
   */
  function basicRow() {
    if (currentMediaState.currentMediaData) return currentMediaState.currentMediaData;
    const p = typeof playingMedia !== 'undefined' && playingMedia ? playingMedia : null;
    const id = currentMediaState.playbackMediaId;
    if (typeof Library === 'undefined') return null;
    return (id && Library.row && Library.row(id)) || (p && p.filepath && Library.rowByPath && Library.rowByPath(p.filepath)) || null;
  }

  function stageFileId() {
    if (basic) { const r = basicRow(); return (r && r.id) || null; }
    return cur && cur.row ? cur.row.id : null;
  }

  /** Back to Stage: the collection (or the Library tab) Stage plays from, its file on screen and lit up. */
  async function backToStage() {
    if (!canGoBack()) return;
    const s = source;
    const id = stageFileId();
    try {
      if (s.kind === 'collection') {
        if (typeof currentTab !== 'undefined' && currentTab !== 'collections' && typeof switchTab === 'function') switchTab('collections');
        if (activeCollectionId !== s.cid && typeof openCollection === 'function') await openCollection(s.cid);
      } else if (typeof switchTab === 'function') {
        switchTab('library');
      }
    } catch (err) {
      console.warn('[Stage] back to Stage:', err && err.message);
    }
    paint();
    if (!id) return;
    await Library.waitIds().catch(() => null);
    const i = Library.indexOf(id);
    if (i < 0) return;
    if (typeof revealMediaIndex === 'function') revealMediaIndex(i);
    setTimeout(() => { if (typeof highlightCard === 'function') highlightCard(i); }, 150);
  }

  /* ── Track count and time left (player-lib/stage-count.js) ──────────── */

  let upPlayed = 0;                   // Up next files played on Stage since the list started
  let lastListIndex = -1;             // the list file played last
  let countMemo = null;               // { key, before, all } the list's counted files
  let countFetchKey = '';

  /** "Track 12 of 40" and "2:14:30 left" for the file on Stage now ({ track: '', time: '' }: nothing to count). */
  function countText() {
    const none = { track: '', time: '' };
    if (typeof StageCount === 'undefined' || !stageOn() || !source) return none;
    const L = listNow();
    if (!L.known || !L.known()) return none;
    const n = L.length();
    const anchor = typeof listAnchorIndex === 'function' ? listAnchorIndex() : -1;
    const ids = L === Library ? Library.ids : L.ids;
    const types = L === Library ? Library.types : L.types;
    const names = Library.TYPE_NAMES || [];
    const typeAt = types ? (i) => names[types[i]] || '' : (i) => L.typeAt(i);
    // Counting the list's files is a walk over all of it: once per list, place and Stage.
    if (!countMemo || countMemo.ids !== ids || countMemo.anchor !== anchor || countMemo.basic !== basic || countMemo.n !== n) {
      let before = 0, all = 0;
      for (let i = 0; i < n; i++) {
        if (!StageCount.plays(typeAt(i), basic)) continue;
        all++;
        if (i <= anchor) before++;
      }
      countMemo = { ids, anchor, basic, n, before, all };
    }
    // The lengths: the rest of the list (up to TIME_CAP) and Up next, from the rows Vault has.
    const rest = [];
    const restTotal = Math.max(0, countMemo.all - countMemo.before);
    const missing = [];
    const upItems = typeof UpNext !== 'undefined' && UpNext.items ? UpNext.items() : [];
    // Past TIME_CAP files there is no time to show: their rows are not looked at.
    if (restTotal + upItems.length <= StageCount.TIME_CAP) {
      for (let i = Math.max(0, anchor + 1); i < n && rest.length < restTotal; i++) {
        if (!StageCount.plays(typeAt(i), basic)) continue;
        const r = L.rowAt(i);
        if (!r) missing.push(L.idAt(i));
        rest.push(r ? { type: r.media_type, duration: r.duration_seconds } : null);
      }
    }
    const upNext = upItems.map((u) => {
      const r = Library.row(u.id);
      if (!r) missing.push(u.id);
      return r ? { type: r.media_type, duration: r.duration_seconds } : { type: u.media_type || 'video', duration: null };
    });
    if (missing.length && restTotal + upNext.length <= StageCount.TIME_CAP) {
      const key = `${anchor}|${missing.length}|${missing[0]}`;
      if (key !== countFetchKey) {
        countFetchKey = key;
        Library.fetchRows(missing).then(() => paint(), () => {});
      }
    }
    let ct = 0, cd = 0;
    if (basic) {
      const el = basicEl();
      ct = el ? el.currentTime : 0;
      cd = el && isFinite(el.duration) ? el.duration : 0;
    } else { ct = t; cd = d; }
    const sum = StageCount.summary({
      types: typeAt, length: n, anchor, counts: countMemo, upPlayed, upNext, rest, restTotal,
      current: { t: ct, d: cd }, repeat: currentRepeat(), basic,
      imageSeconds: settings.imageSeconds,
    });
    return StageCount.text(sum);
  }

  /** The Flow order bar (flow.js): Stage's count while it plays this collection, else null. */
  function countFor(cid) {
    if (!stageOn() || !source || source.kind !== 'collection' || source.cid !== cid) return null;
    const c = countText();
    if (!c.track) return null;
    return c.time ? `${c.track} · ${c.time}` : c.track;
  }

  /**
   * What Stage moves on to by itself, worked out from Up next and the list
   * as they are now: the rest of the list (round again with Repeat all) and
   * Up next, up to UPCOMING_COUNT files. It fails, rather than answer with a
   * shorter list, when the rows it needs cannot be loaded (the server busy
   * or restarting): Stage then keeps the list it has. A list file whose row
   * is still unknown ends the answer there; it is never passed over unseen.
   */
  async function computeUpcoming() {
    const repeat = currentRepeat();
    if (repeat === 'one') return [];
    const L = listNow();
    const unItems = typeof UpNext !== 'undefined' && UpNext.items ? UpNext.items().slice(0, UPCOMING_COUNT) : [];
    const unRows = unItems.length ? await Library.fetchRows(unItems.map(i => i.id), { strict: true }) : [];
    const byId = new Map((unRows || []).filter(Boolean).map(r => [r.id, r]));
    const okRow = (r) => !!r && STAGEABLE.has(r.media_type) && !(typeof isKnownBadMedia === 'function' && isKnownBadMedia(r));
    const upNext = unItems.map(i => ({ id: i.id, ok: okRow(byId.get(i.id)) }));
    if (!L.known()) {
      const ids = await L.waitIds();
      if (!ids) throw new Error('The list changed while Stage was working out what comes next');
    }
    const length = L.length();
    const anchor = typeof listAnchorIndex === 'function' ? listAnchorIndex() : -1;
    // The rows after the anchor (with some to spare for files passed over),
    // and the top of the list for Repeat all.
    const want = Math.max(0, UPCOMING_COUNT - upNext.length) + 50;
    if (length && want) {
      await L.rowsForRange(Math.max(0, anchor + 1), Math.min(length, anchor + 1 + want), { strict: true });
      if (repeat === 'all') await L.rowsForRange(0, Math.min(length, Math.max(0, anchor + 1), want), { strict: true });
    }
    const okAt = (i) => {
      const type = L.typeAt(i);
      if (type === 'document') return false;
      const r = L.rowAt(i);
      if (r) return okRow(r);
      // No row: gone from the library (the server said so) is passed over;
      // not loaded yet is unknown, and the answer ends there.
      const id = L.idAt(i);
      return id && typeof Library.needsFetch === 'function' && !Library.needsFetch(id) ? false : null;
    };
    const plan = StageRules.upcoming({ upNext, anchor, length, okAt, repeat, count: UPCOMING_COUNT });
    const out = [];
    for (const p of plan) {
      const row = p.via === 'upnext' ? byId.get(p.id) : L.rowAt(p.index);
      if (row) out.push(itemFor(row, { via: p.via, index: p.via === 'list' ? p.index : -1 }));
    }
    return out;
  }

  /** Hand Stage a worked-out list for the file on it (forKey), with tries. */
  async function sendList(list, forKey) {
    const r = await cmd({ type: 'upcoming', upcoming: list, repeat: currentRepeat(), forKey }, { tries: CMD_RETRY_MS });
    // The server is not on that file yet (its load still on the way, or Stage
    // moved on and its report is coming): worked out again shortly, a few times.
    if (r && r.stale && open && cur && cur.key === forKey && staleTries < 3) {
      staleTries++;
      setTimeout(() => { if (cur && cur.key === forKey) sendUpcoming(); }, 500);
      return r;
    }
    if (r && !r.stale) staleTries = 0;
    // Finished, and now there is something to play: carry on.
    if (r && finished && list.length) finished = false;
    paint();
    return r;
  }

  /**
   * Tell Stage what comes next (soon after any change; one answer at a
   * time). When it cannot be worked out, nothing is sent (Stage keeps the
   * list it has: an empty or cut-short one would end the stream early) and
   * it is tried again a little later.
   */
  let upFails = 0;
  let loadingKey = null;              // the file whose load is on its way to Stage
  let upAfterLoad = false;            // a list for it waits for that load
  let staleTries = 0;
  function sendUpcoming() {
    clearTimeout(upTimer);
    upTimer = setTimeout(async () => {
      if (!open || !cur) return;
      const my = ++upGen;
      const forKey = cur.key;
      let list;
      try {
        list = await computeUpcoming();
      } catch (err) {
        console.warn('[Stage] upcoming:', err && err.message);
        if (my === upGen && open && cur && cur.key === forKey) {
          upFails++;
          setTimeout(() => { if (my === upGen) sendUpcoming(); }, Math.min(30000, 2000 * upFails));
        }
        return;
      }
      upFails = 0;
      if (my !== upGen || !open || !cur || cur.key !== forKey) return;
      // Its file's load is still on the way: this list goes right after it
      // (sent first, the server would drop it as being for a file it is not on).
      if (loadingKey === forKey) { upAfterLoad = true; return; }
      await sendList(list, forKey);
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

  /**
   * Stage reports a file this page never sent (another tab sent it, or a
   * start this page missed): take what is on Stage from the server, so the
   * remote never stays on the file before.
   */
  let catchUpAt = 0;
  async function catchUp(key) {
    if (Date.now() - catchUpAt < 2000) return;
    catchUpAt = Date.now();
    let s = null;
    try { s = await api('/api/stage/state'); } catch { return; }
    if (!open || !s || !s.current || s.current.key !== key || (cur && cur.key === key)) return;
    adoptCurrent(s.current, s);
  }

  async function adoptCurrent(item, s) {
    const gen = closeGen;
    let row = null;
    try { [row] = await Library.fetchRows([item.id]); } catch {}
    // Stage closed while the row was on its way: nothing to show any more.
    if (gen !== closeGen || !open) return;
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
      if (r.state !== 'loading' && Date.now() - loadingSince > LOADING_NOTE_MS) paint();
      if (r.key && !sent.has(r.key)) catchUp(r.key);
      return;
    }
    const wasPaused = proxy.paused;
    const oldD = d;
    statusKey = r.key;
    // Stage reports the file: its load got there (even if the answer to it has not).
    if (loadingKey === r.key) { loadingKey = null; if (upAfterLoad) { upAfterLoad = false; sendUpcoming(); } }
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
    fire('timeupdate');                 // draws the bar (the proxy listener below), once per report
    if (wasPaused !== proxy.paused) fire(proxy.paused ? 'pause' : 'play');
  }

  /** Stage started a file: one Control sent (confirmation), or the next one on its own. */
  function onStarted({ item, auto }) {
    if (!item) return;
    if (!auto) {
      if (cur && cur.key === item.key) { loadingSince = 0; finished = false; paint(); }
      return;
    }
    // Moved on by itself: the queue here catches up, in turn with any Next pressed.
    const gen = closeGen;
    queueNav(async () => {
      const meta = sent.get(item.key);
      let row = meta && meta.row;
      if (!row) { try { [row] = await Library.fetchRows([item.id]); } catch {} }
      if (!row || gen !== closeGen || !open) return;
      const fromUpNext = item.via === 'upnext';
      // Up next gives the file up first (the server's Up next is what the
      // next list is worked out from): a list worked out before that would
      // still have it, and Stage would play it again.
      const took = fromUpNext && typeof UpNext !== 'undefined' ? UpNext.take(item.id) : null;
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
      // Stage already has what comes after (its long list): no hurry, so the
      // new list waits for the take, outside the queue's turn.
      Promise.resolve(took).catch(() => {}).then(() => sendUpcoming());
    });
  }

  function onSkipped({ item, key }) {
    const meta = sent.get(key);
    const row = (meta && meta.row) || item;
    setNote(`Skipped “${nameOf(row)}”: it can’t be played.`);
    // A file from Up next that cannot play is used up, as the player does.
    const took = item && item.via === 'upnext' && typeof UpNext !== 'undefined' ? UpNext.take(item.id) : null;
    if (cur && key === cur.key) Promise.resolve(took).catch(() => {}).then(() => sendUpcoming());
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

  /** Another Vault tab sent a command (or this one's came back): show what it did. */
  function onOtherControl(c) {
    if (c.type === 'hold') { hold = c.on; paint(); }
    if (c.type === 'volume') { volume = c.volume; muted = c.muted; paint(); }
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
    paint();
  }

  function setHold(on) {
    hold = !!on;
    cmd({ type: 'hold', on: hold });
    paint();
    fire(hold ? 'pause' : 'play');
  }
  function toggleHold() {
    if (basic) { basicToggleHold(); return; }
    if (open) setHold(!hold);
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, Number(v) || 0));
    if (volume > 0) muted = false;
    cmd({ type: 'volume', volume, muted });
    paint();
  }
  function toggleMute() {
    muted = !muted;
    cmd({ type: 'volume', volume, muted });
    paint();
  }

  function front() {
    if (basic) { pipWhenReady(); return; }
    cmd({ type: 'front' });
  }

  function setSize(preset) { cmd({ type: 'size', preset }); }

  /** Close Stage from here: the file carries on in the mini player at the same spot. */
  async function closeStage() {
    if (basic) { closeBasic({ how: 'closed' }); return; }
    if (!open) return;
    const r = await cmd({ type: 'close' });
    const last = r && r.last ? r.last : { t, paused: proxy.paused };
    // After the end of the list there is no file to carry on with here.
    if (finished) cur = null;
    handBack({ t: last.t != null ? last.t : t, paused: hold || finished || !!last.paused, how: 'closed' });
  }

  /**
   * The Stage bar's X: Stage closes and playback stops, nothing carries on
   * in the mini player (Close Stage in the Stage menu still plays on here).
   */
  async function closeStageAndStop() {
    if (basic) {
      // Basic Stage is the mini player's picture-in-picture: closing the
      // mini player stops the video and closes Stage with it (miniClosing).
      if (typeof closeMiniPlayer === 'function') closeMiniPlayer();
      if (basic) closeBasic({ how: 'mini' });
      return;
    }
    if (!open && !remoteShown) return;
    // The close says it stops, so the server's "closed" report tells every
    // Vault tab to stop too (stageGone), this one included. Nothing here is
    // torn down until Stage has taken the close: a close that never got
    // there would leave mpv playing with nothing to control it.
    if (!(await sendStopClose())) {
      showToast('Stage could not be closed. Check that Vault is still running, then try again.', { type: 'error' });
      return;
    }
    stopHere();
  }

  /** POST the stopping close, tried again on a network or server error. True once Stage has it (or is closed already). */
  async function sendStopClose() {
    const waits = [0, 400, 1200];
    for (const ms of waits) {
      if (ms) await new Promise(r => setTimeout(r, ms));
      try {
        await api('/api/stage/cmd', { type: 'close', stop: true });
        return true;
      } catch (err) {
        if (err.code === 'STAGE_CLOSED') return true;
        if (err.status === 423 || (err.status >= 400 && err.status < 500)) return false;
      }
    }
    return false;
  }

  /** Stage closed with a stop: the remote goes and nothing plays here. */
  function stopHere() {
    if (!open && !remoteShown) return;
    closeGen++;
    open = false;
    forgetSource();
    sentHideNames = null;
    hideTips();
    closeMenu();
    leaveRemote();
    disconnect();
    cur = null;
    applyMute();
    if (typeof closeMiniPlayer === 'function') closeMiniPlayer();
    showToast('Stage closed.');
    // A connection kept for a Stage opened again later.
    refreshState();
  }

  /** Stage closed (its own window) or vanished. */
  function stageGone({ how: kind, last }) {
    if (basic) { closeBasic({ how: kind === 'closed' ? 'closed' : 'pip' }); return; }
    if (!open && !remoteShown) return;
    // The Stage bar's X (in this tab or another): playback stops everywhere.
    if (kind === 'closed' && last && last.stop === true) { stopHere(); return; }
    const at = last && last.t != null ? last.t : t;
    // After the end of the list there is no file to carry on with here.
    if (finished) cur = null;
    if (kind === 'closed') handBack({ t: at, paused: !!(last && last.paused), how: 'closed' });
    else handBack({ t: at, paused: true, how: 'gone' });
  }

  /** Back to the mini player: the same file at the same spot (maximizeAt, player-core.js). */
  function handBack({ t: at, paused: wasPaused, how: kind }) {
    if (basic) { closeBasic({ how: kind === 'closed' ? 'closed' : 'pip' }); return; }
    const row = cur && cur.row;
    closeGen++;
    open = false;
    forgetSource();
    sentHideNames = null;
    hideTips();
    closeMenu();
    leaveRemote();
    disconnect();
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
    if (basic) return basicKey(e);
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

  /* ── The remote: the Stage bar (player-lib/stage-bar.js) ──────────── */

  const bar = () => (typeof StageBar !== 'undefined' && StageBar ? StageBar : null);

  /**
   * The full Stage: the mini player box is kept open underneath (its clock is
   * Stage's, through the proxy, so the keys, Up next and the seek helpers
   * work as before) but hidden, and the bar shows.
   */
  function showRemote() {
    const box = $('miniPlayer');
    if (!box) return;
    // The full player is never up while Stage is open.
    if ($('mediaPlayerOverlay')?.classList.contains('active') && !remoteShown) closeMediaPlayer();
    if (!remoteShown) {
      remoteShown = true;
      document.body.classList.add('stage-open');
      box.classList.add('active');
      $('miniPlayerMedia').innerHTML = '';
      currentMediaState.miniMode = false;
      if (typeof miniPlayerOpen === 'function') miniPlayerOpen(proxy, (cur && cur.row && cur.row.media_type) === 'audio' ? 'audio' : 'video');
      applyMute();
      if (typeof renderSelectionBar === 'function') renderSelectionBar();
    }
    syncBar();
  }

  function leaveRemote() {
    const box = $('miniPlayer');
    if (!remoteShown || !box) { remoteShown = false; syncBar(); return; }
    remoteShown = false;
    document.body.classList.remove('stage-open');
    if (typeof miniPlayerTeardown === 'function') miniPlayerTeardown();
    box.classList.remove('active', 'mini-audio');
    $('miniPlayerMedia').innerHTML = '';
    if (typeof UpNext !== 'undefined') UpNext.closePopover();
    syncBar();
  }

  /** A lock hides the remote (Stage stays black); this page reloads on unlock and picks it up again. */
  function hideRemote() {
    hideTips();
    closeMenu();
    leaveRemote();
  }

  /** The bar shows while Stage is open: the full Stage's remote, or Basic Stage. */
  function syncBar() {
    const b = bar();
    if (!b) return;
    if (remoteShown || basic) { b.show(); paint(); } else b.hide();
  }

  /** The bar's view of what is on Stage (StageBarRules.view), for either Stage. */
  function barState() {
    const repeat = currentRepeat();
    const upNext = typeof UpNext !== 'undefined' && UpNext.count ? UpNext.count() : 0;
    const count = countText();
    const base = {
      namesHidden: namesHidden(), repeat, upNext, fmt: typeof formatDuration === 'function' ? formatDuration : null,
      back: canGoBack(), backTitle: backTitle(), countTrack: count.track, countTime: count.time,
    };
    if (basic) {
      const el = basicEl();
      const miniOn = !!$('miniPlayer')?.classList.contains('active');
      const data = miniOn && el ? basicRow() : null;
      const silent = typeof playerIsSilent === 'function' ? playerIsSilent() : !!(el && el.muted);
      return {
        ...base, basic: true, hasFile: !!data, id: data && data.id, filename: data && data.filename, mediaType: data ? 'video' : null,
        t: el ? el.currentTime : 0, d: el && isFinite(el.duration) ? el.duration : 0, paused: !el || el.paused,
        hold: !!basicHold, finished: false, locked: false, loading: false, note: null, pipClosed: !!data && pipClosed,
        volume: typeof savedVolume !== 'undefined' ? savedVolume : 1, muted: silent,
        volumeMax: typeof _miniVolumeMax === 'function' ? _miniVolumeMax() : 1,
        thumbRow: data,
      };
    }
    const row = cur && cur.row;
    const n = note && (note.sticky || Date.now() < note.until) ? note.text : null;
    return {
      ...base, basic: false, hasFile: !!row, id: row && row.id, filename: row && row.filename, mediaType: row && row.media_type,
      t, d, paused, hold, finished, locked, note: n,
      loading: !!(cur && statusKey !== cur.key && loadingSince && Date.now() - loadingSince > LOADING_NOTE_MS),
      pictureLive: !!(cur && statusKey === cur.key),
      volume, muted, volumeMax: 1,
      thumbRow: row,
    };
  }

  /** The bar's still: the file's grid thumbnail, at the grid's own URL (StageBarRules.thumbSrc). */
  function thumbFor(row) {
    if (!row || !row.id || typeof canShowThumb !== 'function' || typeof thumbUrl !== 'function') return '';
    const libRow = (typeof Library !== 'undefined' && Library.row && Library.row(row.id))
      || (typeof getMediaById === 'function' && getMediaById(row.id)) || null;
    const blob = typeof thumbsEncrypted === 'function' && thumbsEncrypted() && typeof getThumbBlob === 'function' ? getThumbBlob(row.id) : null;
    return StageBarRules.thumbSrc(row, { libRow, canShow: canShowThumb, url: thumbUrl, blob });
  }

  /** Draw the bar from what is on Stage now. */
  function paint() {
    const b = bar();
    if (!b || !(remoteShown || basic)) return;
    const s = barState();
    if (typeof StageBarRules === 'undefined') return;
    b.paint(StageBarRules.view(s), { thumb: thumbFor(s.thumbRow) });
    if (remoteShown && typeof miniUpdateTimeline === 'function') miniUpdateTimeline();
    // The Flow order bar's track count follows Stage's (flow.js).
    if (typeof Flow !== 'undefined' && typeof Flow.paintCount === 'function') Flow.paintCount();
  }

  function setNote(text, { sticky = false } = {}) {
    note = { text, until: Date.now() + NOTE_MS, sticky };
    clearTimeout(noteTimer);
    if (!sticky) noteTimer = setTimeout(() => { note = null; paint(); }, NOTE_MS + 50);
    paint();
  }

  /* ── Vault's own sound while Stage is open ────────────────────────── */

  const mutedByStage = new WeakSet();
  function applyMute() {
    // Basic Stage's sound is this page's own: never muted for it.
    const on = open && !basic && settings.muteVault !== false;
    document.querySelectorAll('video, audio').forEach((el) => {
      if (on && !el.muted) { el.muted = true; mutedByStage.add(el); }
      else if (!on && mutedByStage.has(el)) { el.muted = false; mutedByStage.delete(el); }
    });
  }
  // Anything that starts making sound here while Stage is open (a preview, the Wall).
  document.addEventListener('play', (e) => {
    const el = e.target;
    if (!open || basic || settings.muteVault === false || !(el instanceof HTMLMediaElement) || el.muted) return;
    el.muted = true;
    mutedByStage.add(el);
  }, true);

  /* ── Right-click menu on the Stage button ─────────────────────────── */

  function menuOpen() { return !!$('stageMenu') && !$('stageMenu').hidden; }

  async function menu(e) {
    if (e) e.preventDefault();
    if (!open) return;
    // The bar's Stage button opens and closes it with a click too.
    if (e && e.type === 'click' && menuOpen()) { closeMenu(); return; }
    let size = 'free';
    if (!basic) { try { const s = await api('/api/stage/state'); size = s.size || 'free'; } catch {} }
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
        else if (act === 'repeat') { if (typeof cycleRepeatMode === 'function') cycleRepeatMode(); }
        else if (act === 'hold') toggleHold();
        else if (act === 'return') backToStage();
        else setSize(act);
      });
    }
    const check = (p) => (p === size ? '<span class="sm-check" aria-hidden="true">✓</span>' : '<span class="sm-check" aria-hidden="true"></span>');
    const item = (act, label, sub) => `<button type="button" role="menuitemradio" aria-checked="${act === size}" data-stage-act="${act}">${check(act)}<span class="sm-l">${esc(label)}</span>${sub ? `<span class="sm-s">${esc(sub)}</span>` : ''}</button>`;
    // A bar too narrow for Repeat and Hold has them here instead (StageBarRules.layout).
    const v = typeof StageBarRules !== 'undefined' ? StageBarRules.view(barState()) : null;
    const dropped = bar() && bar().dropped ? bar().dropped() : {};
    const backItem = dropped.back && canGoBack() ? `<button type="button" role="menuitem" data-stage-act="return"><span class="sm-check" aria-hidden="true">↩</span><span class="sm-l">Back to Stage</span><span class="sm-s">where it is playing from</span></button>` : '';
    const extra = !v ? '' : `${backItem}${dropped.repeat ? `<button type="button" role="menuitem" data-stage-act="repeat"><span class="sm-check"></span><span class="sm-l">${esc(v.repeat.label)}</span><span class="sm-s">click to change</span></button>` : ''}${dropped.hold ? `<button type="button" role="menuitem" data-stage-act="hold"><span class="sm-check" aria-hidden="true">${v.hold.on ? '✓' : ''}</span><span class="sm-l">Hold</span><span class="sm-s">${basic ? 'pause and mute' : 'black and silent'} (H)</span></button>` : ''}`;
    el.innerHTML = basic ? `
      <div class="sm-h">Basic Stage</div>
      <button type="button" role="menuitem" data-stage-act="front"><span class="sm-check"></span><span class="sm-l">Show the picture-in-picture window</span></button>
      <div class="sm-h">Size</div>
      <div class="sm-note">Drag the picture-in-picture window's edge to size it. Sizes need the full Stage (mpv).</div>
      <div class="sm-sep"></div>
      <button type="button" role="menuitem" data-stage-act="close" class="sm-close"><span class="sm-check"></span><span class="sm-l">Close Stage</span><span class="sm-s">plays on here</span></button>` : `
      <div class="sm-h">Stage</div>
      <button type="button" role="menuitem" data-stage-act="front"><span class="sm-check"></span><span class="sm-l">Bring Stage to the front</span></button>
      <div class="sm-h">Size</div>
      ${item('free', 'Free size', 'drag and snap')}
      ${item('720p', '720p', '1280 × 720')}
      ${item('1080p', '1080p', '1920 × 1080')}
      ${item('1440p', '1440p', '2560 × 1440')}
      <div class="sm-sep"></div>
      <button type="button" role="menuitem" data-stage-act="close" class="sm-close"><span class="sm-check"></span><span class="sm-l">Close Stage</span><span class="sm-s">plays on here</span></button>`;
    if (extra) el.insertAdjacentHTML('afterbegin', extra);
    el.hidden = false;
    placeNear(el, 'menu');
    $('stageBarMenu')?.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', menuOutside, true), 0);
    el.querySelector('button')?.focus({ preventScroll: true });
  }

  function menuOutside(e) {
    const el = $('stageMenu');
    if (el && el.contains(e.target)) return;
    // A press on the bar's Stage button: its click closes the menu.
    if ($('stageBarMenu')?.contains(e.target)) return;
    closeMenu();
  }

  function closeMenu() {
    const el = $('stageMenu');
    if (el) el.hidden = true;
    $('stageBarMenu')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', menuOutside, true);
  }

  /**
   * Above the Stage bar, lined up with the right end of its button (the menu)
   * or of the bar (the tips). Without the bar: above the mini player (below
   * it when it sits at the top), lined up with its outer edge.
   */
  function placeNear(el, kind) {
    const de = document.documentElement;
    const vw = de.clientWidth || window.innerWidth;
    const vh = de.clientHeight || window.innerHeight;
    const gap = 8;
    const w = Math.min(el.offsetWidth || 300, vw - 2 * gap);
    const a = bar() && bar().anchorRect(kind);
    if (a) {
      el.style.left = `${Math.max(gap, Math.min(vw - w - gap, a.right - w))}px`;
      el.style.top = `${Math.max(gap, a.top - gap - el.offsetHeight)}px`;
      return;
    }
    const mini = $('miniPlayer');
    if (!mini) return;
    const r = mini.getBoundingClientRect();
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
    el.innerHTML = basic ? `
      <div class="st-head"><b>Stage is open (Basic)</b><button type="button" class="st-x" data-tips="close" aria-label="Close">${glyph('✕', 'close')}</button></div>
      <ol class="st-list">
        <li>In Discord, start a screen share and pick the browser's window named <b>Picture in picture</b>.</li>
        <li>It shows the address and its controls while the mouse is over it, so keep the mouse away from it.</li>
        <li>Basic Stage plays videos only, and Hold pauses and mutes (it can't go black). Run everything from the Stage bar.</li>
        <li>For the full Stage (its own window, pictures, a black Hold, sizes), install mpv, the free player from mpv.io.</li>
      </ol>
      <div class="st-acts"><button type="button" class="st-btn" data-tips="never">Don't show again</button><button type="button" class="st-btn st-pri" data-tips="ok">Got it</button></div>` : `
      <div class="st-head"><b>Stage is open</b><button type="button" class="st-x" data-tips="close" aria-label="Close">${glyph('✕', 'close')}</button></div>
      <ol class="st-list">
        <li>In Discord, start a screen share and pick the window named <b>${name}</b>.</li>
        <li>Turn on sound in Discord's share options.</li>
        <li>Stage plays in mpv, its own window, so Discord picks up Stage's sound, not your browser's.</li>
        <li>Run everything from the Stage bar. ${settings.muteVault !== false ? 'Vault’s own sound is muted while Stage is open.' : 'Vault’s own sound stays on (Settings › Stage).'}</li>
      </ol>
      <div class="st-acts"><button type="button" class="st-btn" data-tips="never">Don't show again</button><button type="button" class="st-btn st-pri" data-tips="ok">Got it</button></div>`;
    el.hidden = false;
    requestAnimationFrame(() => placeNear(el, 'tips'));
  }

  function hideTips() { const el = $('stageTips'); if (el) el.hidden = true; }

  window.addEventListener('resize', () => {
    if (menuOpen()) placeNear($('stageMenu'), 'menu');
    if (tipsOpen()) placeNear($('stageTips'), 'tips');
  });

  /* ── Basic Stage: the browser's picture-in-picture (no mpv) ────────── */

  let basic = false;
  let basicHold = null;               // while held: { wasPlaying, muted }
  let basicListStart = false;         // Play on Stage started a list: its first file may be passed over too
  let listStartTimer = null;
  function markListStart() {
    basicListStart = true;
    clearTimeout(listStartTimer);
    listStartTimer = setTimeout(() => { basicListStart = false; }, 5000);
  }
  const BASIC_LOCK_KEY = 'vault-stage-basic-locked';

  /**
   * Basic when Settings › Stage says so, or mpv is not found: the server's
   * answer from just now (refreshState). If the server could not be asked,
   * what this page last heard decides (Basic if it never heard), and an mpv
   * open then fails with "Could not reach Vault".
   */
  function wantBasic() {
    if (mpv && mpv.choice) return mpv.choice === 'basic';
    return StageRules.playerChoice({ setting: settings.player, mpvFound: !!(mpv && mpv.found) }) === 'basic';
  }

  const basicEl = () => document.querySelector('#miniPlayerMedia video');
  const pipCarrying = () => typeof miniPipCarrying === 'function' && miniPipCarrying();

  function startBasic({ then = null } = {}) {
    const local = then ? null : localPlayback();
    // Sound or a picture in the mini player would go on playing under the
    // Stage bar, out of reach: it stops (before Basic is on, so it is not
    // a close of Stage).
    if (local && local.mediaData.media_type !== 'video' && local.miniOn) stopLocal(local);
    basic = true;
    open = true;
    basicHold = null;
    pipClosed = false;
    document.body.classList.add('stage-basic');
    // A video already playing goes on in Stage: the set log's first file.
    const playingEl = basicEl();
    logFresh = false;
    if (playingEl && !playingEl.paused && local && local.mediaData.media_type === 'video') {
      logSrc = playingEl.currentSrc || '';
      logBasicStart();
    }
    if (local && local.mediaData.media_type !== 'video') {
      showToast('Basic Stage plays videos only. Play a video to show it there.');
    } else if (local && local.overlayOn) {
      minimizePlayer();
    }
    if (then) { markListStart(); then(); }
    basicSettle();
    if (settings.tips) showTips();
    else if (!local && !then) showToast('Stage is open (Basic). Play a video to show it there.');
  }

  /** The video is in the mini player (hidden under the Stage bar) and in picture-in-picture. */
  function basicSettle() {
    if (!basic) return;
    const overlay = $('mediaPlayerOverlay');
    if (overlay && overlay.classList.contains('active') && currentMediaState.type === 'video') minimizePlayer();
    paintBasic();
    pipWhenReady();
  }

  function paintBasic() {
    if (!basic) return;
    syncBar();
  }

  // Basic Stage's clock is the mini player's own video: the bar follows it.
  for (const ev of ['timeupdate', 'durationchange', 'play', 'pause', 'ended', 'volumechange', 'loadedmetadata', 'emptied']) {
    document.addEventListener(ev, (e) => { if (basic && e.target === basicEl()) paint(); }, true);
  }

  /** Into picture-in-picture once the video knows its size (the browser asks for that). */
  function pipWhenReady() {
    const el = basicEl();
    if (!basic || !el || document.pictureInPictureElement === el || pipCarrying()) return;
    if (!document.pictureInPictureEnabled || typeof el.requestPictureInPicture !== 'function') {
      showToast('This browser has no picture-in-picture, so Basic Stage cannot show. The full Stage needs mpv (Settings › Stage).');
      return;
    }
    const go = () => {
      if (!basic || basicEl() !== el || document.pictureInPictureElement === el) return;
      el.requestPictureInPicture().catch(() => {
        // Asked without a click (the next file, this tab in the background):
        // the bar's Picture-in-picture closed button is the way back then.
        if (pipClosed) { paintBasic(); return; }
        showToast('Press the picture on the Stage bar to show Stage.');
      });
    };
    if (el.readyState >= 1) go();
    else el.addEventListener('loadedmetadata', go, { once: true });
  }

  /**
   * The queue asks (player-core.js nextPlayableIndex): does Basic Stage pass
   * over a file of this type? Pure apart from basic.
   */
  function passOver(mediaType) {
    return basic && !StageRules.basicPlays(mediaType);
  }

  /** The queue walked past these on Basic Stage (names said, nothing opened); end: nothing playable was left. */
  function notePassed(rows, { end = false } = {}) {
    if (!basic) return;
    const list = (rows || []).filter(Boolean);
    if (list.length === 1) showToast(`Skipped “${nameOf(list[0])}”: Basic Stage plays videos only.`);
    else if (list.length > 1) showToast(`Skipped ${list.length} files: Basic Stage plays videos only.`);
    if (end) showToast('Nothing more that Basic Stage can play.');
  }

  /** playMedia while Basic Stage is open: videos play in the mini player (and its window). */
  function basicIntercept(mediaData, opts) {
    const o = opts || {};
    const type = mediaData && mediaData.media_type;
    const listStart = basicListStart;
    basicListStart = false;
    // This file's own row (by id, else by path): never the file playing now.
    const lib = typeof Library !== 'undefined' ? Library : null;
    const known = (mediaData && mediaData.id && lib && lib.row && lib.row(Number(mediaData.id)))
      || (mediaData && mediaData.filepath && lib && lib.rowByPath && lib.rowByPath(mediaData.filepath)) || mediaData;
    const dead = type === 'video' && typeof isKnownBadMedia === 'function' && isKnownBadMedia(known);
    if (dead && !(listStart || o.source === 'auto' || o.fromUpNext)) {
      showToast(`Skipped “${nameOf(mediaData)}”: it can’t be played here.`);
      return true;
    }
    if (!StageRules.basicPlays(type) || dead) {
      if (listStart && typeof getCurrentMediaIndex === 'function' && typeof queueNav === 'function') {
        // Play on Stage's list starts with something Basic cannot show: on to its first video.
        const from = getCurrentMediaIndex(mediaData.filepath);
        // A video that cannot play here is named for what it is, not as "videos only".
        if (dead) showToast(`Skipped “${nameOf(mediaData)}”: it can’t be played here.`);
        const passed = dead ? [] : [mediaData];
        queueNav(async () => {
          const i = await nextPlayableIndex(from, 1, passed);
          notePassed(passed, { end: i === -1 });
          if (i !== -1) await playIndexHandsFree(i);
        });
        return true;
      }
      showToast(dead ? `Skipped “${nameOf(mediaData)}”: it can’t be played here.`
        : o.source === 'auto' || o.fromUpNext
        ? `Skipped “${nameOf(mediaData)}”: Basic Stage plays videos only.`
        : 'Basic Stage plays videos only. Close Stage to open this here.');
      return true;
    }
    if (basicHold) {
      const el = basicEl();
      if (el) el.muted = basicHold.muted;
      basicHold = null;
    }
    // Stays in the mini player (and so in its picture-in-picture window), even when picked from the library.
    if (opts) opts.stayMini = true;
    setTimeout(basicSettle, 0);
    return false;
  }

  /**
   * A video failed while Basic Stage is open (player-core.js
   * handleMediaError): step over it the way the queue was going (Previous
   * goes back past it), say so, and keep the picture-in-picture window,
   * which stays on the file before until the next one loads. Nothing left
   * to play: Stage closes as the mini player does. True when handled.
   */
  function basicMediaFailed(dead) {
    if (!basic) return false;
    // Known now: the queue walks past it from here on (Previous included).
    const row = dead && dead.id && typeof Library !== 'undefined' && Library.row ? Library.row(dead.id) : null;
    if (row) row.playback_failed = 1;
    if (dead) dead.playback_failed = 1;
    const back = typeof lastQueueDir !== 'undefined' && lastQueueDir === 'prev' && typeof lastPlaySource !== 'undefined' && lastPlaySource === 'auto';
    const said = `Skipped “${nameOf(dead)}”: it can’t be played here.`;
    const move = back && typeof queueNav === 'function' && typeof queueMove === 'function'
      ? queueNav(() => queueMove('prev', false))
      : (typeof playNextMediaOrWrap === 'function' ? playNextMediaOrWrap() : Promise.resolve(false));
    // The next file not loading (or the move hanging) is not the end: it is
    // tried again shortly (player-core.js autoAdvance), Stage stays open.
    const later = () => { if (basic && typeof autoAdvance === 'function') autoAdvance(1); };
    Promise.resolve(move).then((moved) => {
      if (moved === 'stopped') { later(); return; }
      if (moved) {
        if (typeof noteSkippedThisSession === 'function') noteSkippedThisSession(dead, 'it can’t be played here');
        showToast(said);
      } else {
        showToast(`${said} Nothing more that Basic Stage can play.`);
        if (typeof closeMediaPlayer === 'function') closeMediaPlayer();
      }
    }, later);
    return true;
  }

  function basicToggleHold() {
    const el = basicEl();
    if (basicHold) {
      const h = basicHold;
      basicHold = null;
      if (el) {
        el.muted = h.muted;
        if (h.wasPlaying) el.play().catch(() => {});
      }
    } else {
      basicHold = { wasPlaying: !!el && !el.paused, muted: !!el && el.muted };
      if (el) { try { el.pause(); el.muted = true; } catch {} }
    }
    paintBasic();
  }

  function basicKey(e) {
    if (e.key === 'Escape') {
      if (menuOpen()) { closeMenu(); return true; }
      if (tipsOpen()) { hideTips(); return true; }
      return true;                    // Esc never closes Stage by accident
    }
    if (e.key === 'q' || e.key === 'Q') return true;
    if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey && !e.altKey && !e.metaKey) { basicToggleHold(); return true; }
    return false;
  }

  /** Close Basic Stage: picture-in-picture goes, the mini player plays on at the same spot. */
  function closeBasic({ how = 'closed' } = {}) {
    if (!basic) return;
    // Stage closed: the set ends (locked: the server pauses it by itself).
    if (how !== 'lock') logBasic('closed');
    logFresh = false;
    logSrc = '';
    basic = false;
    open = false;
    pipClosed = false;
    forgetSource();
    const el = basicEl();
    if (basicHold && el) el.muted = basicHold.muted;
    basicHold = null;
    document.body.classList.remove('stage-basic');
    hideTips();
    closeMenu();
    if (typeof UpNext !== 'undefined' && UpNext.closePopover) UpNext.closePopover();
    try { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); } catch {}
    // The bar goes and the mini player is back where it was.
    syncBar();
    if (how === 'lock') return;
    if (how === 'mini') { showToast('Stage closed.'); return; }
    const words = how === 'pip' ? 'Stage closed (its window was closed)' : 'Stage closed';
    if (el && !el.paused) showToast(`${words}. Playing here from ${fmt(el.currentTime || 0)}.`);
    else if (el) showToast(`${words}. Paused here at ${fmt(el.currentTime || 0)}.`);
    else showToast(`${words}.`);
  }

  // The picture-in-picture window closed (its own close button, the browser
  // dropping it): Stage stays open and the video plays on in the page, so the
  // bar says so ("Not showing") with a button that opens the window again
  // (the browser wants a click for that). It never just closes: with one
  // element for every file (playMedia reuseEl) the window has no reason to
  // go, and when it does, closing Stage under a stream would be worse.
  // leavepictureinpicture fires on the element, which may already be out of
  // the page then, so each element that enters picture-in-picture is
  // watched itself.
  let pipClosed = false;
  function pipLeft() {
    setTimeout(() => {
      if (!basic || document.pictureInPictureElement || pipCarrying()) return;
      if (!pipClosed) {
        pipClosed = true;
        showToast('The picture-in-picture window closed, so Stage is not showing. Press “Picture-in-picture closed” on the Stage bar to show it again.');
      }
      paintBasic();
    }, 400);
  }
  document.addEventListener('enterpictureinpicture', (e) => {
    const el = e.target;
    if (basic && el === basicEl()) { pipClosed = false; paintBasic(); }
    if (!el || el._stageWatched) return;
    el._stageWatched = true;
    el.addEventListener('leavepictureinpicture', () => { el._stageWatched = false; pipLeft(); }, { once: true });
  }, true);

  /* ── The set log (lib/stage/setlog.js): Basic Stage plays in this page,
        so the page tells the server what plays. mpv Stage needs none of
        this: the server hears it from mpv. ─────────────────────────────── */

  let logFresh = false;       // a new file went into the video: its first 'playing' starts a log entry
  let logBeatAt = 0;
  // background: a timed report (the beat), not the user being there, so it
  // never holds off auto-lock. keepalive: still sent as the page goes.
  function logBasic(state, extra, { background = false, keepalive = false } = {}) {
    logBeatAt = Date.now();
    const headers = { 'Content-Type': 'application/json' };
    if (background) headers['X-Vault-Background'] = '1';
    try {
      fetch('/api/stage/setlog/basic', { method: 'POST', headers, keepalive, body: JSON.stringify({ state, ...(extra || {}) }) }).catch(() => {});
    } catch {}
  }
  // The server takes a Basic file as stopped when the page goes quiet
  // (closed, reloaded, crashed), so the page says it is still there:
  // while playing on the video's own clock (it runs in a background tab),
  // and a slower timer for a paused file.
  const LOG_BEAT_MS = 20000;
  const logBeat = () => { if (basic && Date.now() - logBeatAt >= LOG_BEAT_MS) logBasic('beat', null, { background: true }); };
  const logBeatTimer = setInterval(logBeat, LOG_BEAT_MS);
  if (logBeatTimer && logBeatTimer.unref) logBeatTimer.unref();
  document.addEventListener('timeupdate', (e) => { if (isBasicEl(e)) logBeat(); }, true);
  // The page going away (a reload, the tab closed): Basic's file has stopped.
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', () => { if (basic) logBasic('stopped', null, { background: true, keepalive: true }); });
  }
  function logBasicStart() {
    const r = basicRow();
    // What the video plays says which file it is (its row may still be on
    // its way, for a file this page has not loaded yet); else the row.
    const el = basicEl();
    const m = el && /\/(?:media|stream)\/(\d+)(?:[/?#]|$)/.exec(el.currentSrc || '');
    let id = m ? Number(m[1]) : (r && Number(r.id));
    if (!(Number.isInteger(id) && id > 0)) id = Number(currentMediaState.playbackMediaId);
    // The server names it from the library; the page's name is the fallback.
    if (Number.isInteger(id) && id > 0) logBasic('start', { id, title: r && Number(r.id) === id && typeof r.filename === 'string' ? r.filename.slice(0, 1024) : '' });
  }
  const isBasicEl = (e) => basic && e.target === basicEl();
  let logSrc = '';            // the source of the file logged last: another one is a new file
  // A new element may load before it is in the mini player, so any media
  // element loading counts, and a different source counts too.
  document.addEventListener('loadstart', (e) => {
    const t = e.target;
    if (!basic || !t || typeof t.play !== 'function') return;
    if (t === basicEl() || !t.isConnected || (t.closest && t.closest('#miniPlayerMedia'))) logFresh = true;
  }, true);
  document.addEventListener('playing', (e) => {
    if (!isBasicEl(e)) return;
    const src = e.target.currentSrc || '';
    if (logFresh || src !== logSrc) { logFresh = false; logSrc = src; logBasicStart(); } else logBasic('playing');
  }, true);
  document.addEventListener('pause', (e) => { if (isBasicEl(e) && !e.target.ended) logBasic('paused'); }, true);
  // Ended: the entry ends, and playing it again (same video, same file) is a new one.
  document.addEventListener('ended', (e) => { if (isBasicEl(e)) { logFresh = true; logBasic('stopped'); } }, true);

  // Play pressed while Held: Hold ends and the sound comes back.
  document.addEventListener('play', (e) => {
    if (!basic || !basicHold || e.target !== basicEl()) return;
    e.target.muted = basicHold.muted;
    basicHold = null;
    paintBasic();
  }, true);

  /** The mini player is closing under Basic Stage (closed, a file that failed for good, the playing file trashed): Stage closes. */
  function miniClosing() {
    if (!basic) return;
    closeBasic({ how: 'mini' });
  }

  /**
   * Vault is locking (vault-ui.js haltAllPlayback): out of picture-in-picture
   * and paused at once, so no picture is left on screen. Nothing reopens by
   * itself after the unlock (picture-in-picture needs a click).
   */
  function lockStop() {
    if (!basic) return;
    const el = basicEl();
    if (el) { try { el.pause(); } catch {} }
    try { sessionStorage.setItem(BASIC_LOCK_KEY, '1'); } catch {}
    closeBasic({ how: 'lock' });
  }

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
    // Basic Stage has no server session: nothing to send, its names are this
    // page's. The bar shows the name either way, so it is drawn again.
    if (!basic) {
      syncPrivacy();
      if (cur) sendUpcoming();
    }
    paint();
  }
  if (typeof MutationObserver === 'function') {
    // From the state at load: a class change that is not about privacy (Basic
    // Stage dressing the page, say) is not a privacy change.
    let was = namesHidden();
    new MutationObserver(() => {
      const now = namesHidden();
      if (now === was) return;
      was = now;
      privacyChanged();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  /* ── Changes here that change what comes next ─────────────────────── */

  function upNextChanged() {
    paint();                          // the bar's Up next count
    if (open && cur && !basic) sendUpcoming();
  }
  function repeatChanged() {
    if (basic) { paint(); return; }
    if (open && cur) { paint(); sendUpcoming(); }
  }

  // Keep the loading note and the picture countdown moving even with no reports.
  setInterval(() => { if (remoteShown || basic) paint(); }, 1000);
  // A seek from the bar (the proxy's clock moves at once).
  proxy.addEventListener('timeupdate', () => paint());

  /* ── Boot: Stage may already be open (this page reloaded, or unlocked) ── */

  async function boot() {
    let lockedOut = false;
    try { lockedOut = sessionStorage.getItem(BASIC_LOCK_KEY) === '1'; sessionStorage.removeItem(BASIC_LOCK_KEY); } catch {}
    if (lockedOut) showToast('Basic Stage closed when Vault locked. Press the Stage button to show it again.');
    const s = await refreshState();
    if (s && s.open) { open = true; connect(); }
  }
  window.addEventListener('vault:library-loaded', () => { if (!es) boot(); }, { once: false });
  boot();

  return {
    proxy, intercept, on: () => open && remoteShown, isOpen: () => open, basicOn: () => basic, lockStop, passOver, notePassed, miniClosing, basicMediaFailed,
    openStage, openFromPlayer, playCollectionOnStage, stageButton, closeStage, closeStageAndStop, menu, front, setSize,
    toggleHold, setVolume, toggleMute, paintVolume: paint, key, hideRemote,
    upNextChanged, repeatChanged, showTips,
    queueList, fileOpened, backToStage, countFor, countText,
    /** The id of the file on Stage now, or null (the Flow chart's playhead reads proxy for its time). */
    currentId: () => (cur && cur.row ? cur.row.id : null),
    _state: () => ({ open, basic, basicHold: !!basicHold, remoteShown, mpv, cur: cur && { key: cur.key, id: cur.row && cur.row.id }, t, d, paused, hold, finished, volume, muted, note: note && note.text }),
  };
})();
