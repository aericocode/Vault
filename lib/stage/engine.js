/**
 * The Stage engine (PLAYLISTS_SPEC 5, "Stage decisions", "Stage host,
 * final"): plays what Control sends in mpv, on the server.
 *
 * It does what the old Stage page did, with mpv underneath:
 *
 * - Files go to mpv as local paths (Vault reads the path from the library
 *   for the id Control sent, only while unlocked); nothing goes over the
 *   network. mpv's playlist is kept at the file playing plus the next one
 *   (appended as soon as it is known, prefetched by mpv), so files follow on
 *   with no black gap. At the end of a file with nothing lined up yet the
 *   last picture stays (keep-open) while Control catches up; then black.
 * - It moves on by itself (mpv does, to the appended file) and tells
 *   Control (started, auto), which then sends what comes after. Control
 *   hands over a long list (the rest of the list and Up next, up to the
 *   hub's MAX_UPCOMING files), so Stage keeps playing for hours on its own
 *   while the Vault tab sits in the background, throttled or frozen; the
 *   tab's answers only keep that list fresh.
 * - The name over the first seconds of a file, lower left (osd-overlay),
 *   unless privacy mode hides file names. Pictures for N seconds and GIFs
 *   for at least one full loop, timed here (a paused picture waits). A file
 *   that cannot play is skipped and reported. The end of the list (Repeat
 *   off) is black. Hold is black, silent and paused, and comes back where it
 *   was.
 * - Even out loudness (Settings › Stage, on by default): each video or
 *   audio file Flow has measured plays at about -16 LUFS, a per-file gain
 *   handed to mpv with the file (lib/flow/loudness.js, clamped to +-12 dB):
 *   mpv's volume-gain where it has it (0.38 and later), an lavfi volume
 *   filter before that. Files not measured play as they are. Basic Stage
 *   (picture-in-picture) cannot do this.
 * - A lock stops playback at once and leaves only black: the file is
 *   unloaded (mpv idles on its black background), nothing is read or
 *   written while locked, and after the unlock the file comes back paused
 *   under Hold.
 * - Resume spot, view counts and the watch heatmap are recorded from mpv's
 *   time-pos with the player's own rules (player-lib/stage-rules.js), and a
 *   playing Stage counts as someone being there for the auto-lock.
 *
 * Nothing here talks to the network or the page: the hub (lib/stage/hub.js)
 * hands it commands and takes its reports; the library access, the watch
 * records and the clock come in as functions, so the tests drive it with a
 * fake mpv.
 */

const fs = require('fs');
const StageRules = require('../../player-lib/stage-rules.js');
const Overlay = require('./mpv-overlay');
const { titleArg } = require('./mpv-args');

const STATUS_MS = 250;              // reports to Control, about 4 a second
const WAIT_UPCOMING_MS = 3000;      // end of a file with nothing next: wait this long for Control
const SAVE_EVERY_S = 5;
const TOUCH_EVERY_MS = 10000;       // a playing Stage keeps the auto-lock clock from running
const LOAD_TIMEOUT_MS = 20000;      // a file mpv never starts is skipped
const GIF_MAX_BYTES = 64 * 1024 * 1024;

const isPicture = (item) => !!item && (item.media_type === 'image' || item.media_type === 'gif');
const isTimed = (item) => !!item && (item.media_type === 'video' || item.media_type === 'audio');

/**
 * @param {object} o
 * @param {object} o.mpv        the mpv host (mpv-host.js): command, set, loadfile, alive
 * @param {(rep: object) => void} o.report   to the hub
 * @param {() => object} o.settings          Stage settings (lib/stage/settings.js)
 * @param {object} o.lib
 * @param {(id: number) => ({ok: true, path: string} | {ok: false, reason: string})} o.lib.pathFor
 * @param {(id: number, watchS: number) => void} o.lib.recordView
 * @param {(id: number, pos: number) => void} o.lib.savePosition
 * @param {(id: number, buckets: object) => void} o.lib.mergeHeatmap
 * @param {() => void} o.lib.touch        the auto-lock clock: someone is here
 * @param {() => boolean} o.lib.isLocked
 * @param {(id: number) => (number|null)} [o.lib.loudnessGain]  dB for Even out loudness, or null
 * @param {boolean} [o.forceMute]
 * @param {boolean} [o.volumeGain=true]  this mpv has volume-gain (0.38+); else a volume filter
 */
function createEngine({ mpv, report = () => {}, settings = () => ({}), lib = {}, forceMute = false, volumeGain = true, now = () => Date.now(), timers = { setTimeout, clearTimeout, setInterval, clearInterval }, readFile = fs.promises.readFile } = {}) {
  const T = timers;
  let cur = null;          // { item, entry, loaded, startedSent, auto, watch, pic, loadTimer }
  let next = null;         // { item, entry }: appended to mpv's playlist
  let upcoming = [];       // what Control lined up after the current file (Control's items)
  let repeat = 'off';
  let paused = false;      // what Control wants
  let hold = false;
  let holdWasPlaying = false;
  let finished = false;
  let waiting = false;     // at the end of a file, waiting for Control to line something up
  let locked = false;
  let closing = false;
  let volume = 1;
  let muted = false;
  let hideNames = false;
  let gen = 0;
  let waitTimer = null;
  let statusTimer = null;
  let lastStatus = '';
  let lastTouch = 0;
  let nameGen = 0;
  const mp = { t: 0, d: 0, pause: false, eof: false, idle: true };

  const cfg = () => ({ showName: true, nameSeconds: 3, imageSeconds: 8, ...(settings() || {}) });
  const lockedNow = () => locked || (typeof lib.isLocked === 'function' && lib.isLocked());
  const quietly = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); return p; };

  /* ── Library access (only unlocked) ─────────────────────────────── */

  function pathFor(item) {
    if (lockedNow()) return { ok: false, reason: 'Vault is locked' };
    try {
      const r = lib.pathFor(item.id);
      return r && r.ok ? r : { ok: false, reason: (r && r.reason) || 'it can’t be played' };
    } catch { return { ok: false, reason: 'it can’t be played' }; }
  }
  function libCall(name, ...args) {
    if (lockedNow() || typeof lib[name] !== 'function') return;
    try { lib[name](...args); } catch (err) { console.warn(`[Stage] ${name}:`, err && err.message); }
  }

  /* ── Watching: resume spot, views, heatmap (viewtracker.js rules) ── */

  const newWatch = () => ({ acc: 0, lastT: null, counted: false, lastSaved: 0, heat: {}, dwell: null });

  function trackWatch(c) {
    if (!c || !isTimed(c.item) || !c.loaded) return;
    const w = c.watch;
    const t = mp.t, d = mp.d;
    if (w.lastT === null) { w.lastT = t; w.lastSaved = t; return; }
    const delta = t - w.lastT;
    w.lastT = t;
    if (delta > 0 && delta < 2 && !mp.pause && !hold) {
      w.acc += delta;
      if (d > 0) {
        const b = Math.max(0, Math.min(99, Math.floor((t / d) * 100)));
        w.heat[b] = (w.heat[b] || 0) + delta;
      }
    }
    if (!w.counted && StageRules.viewCounts(w.acc, d)) {
      w.counted = true;
      libCall('recordView', c.item.id, Math.round(w.acc));
    }
    if (d > 0 && Math.abs(t - w.lastSaved) >= SAVE_EVERY_S) {
      w.lastSaved = t;
      const pos = StageRules.positionToSave(t, d);
      if (pos !== null) libCall('savePosition', c.item.id, pos);
    }
  }

  /** The spot and the heatmap of a file that is going (or pausing). */
  function saveWatch(c, { ended = false } = {}) {
    if (!c || !isTimed(c.item) || !c.loaded || c.done) return;
    if (ended) c.done = true;      // played to the end: saved once
    const w = c.watch;
    const total = Object.values(w.heat).reduce((s, x) => s + x, 0);
    if (total >= 1) {
      const buckets = {};
      for (const [k, x] of Object.entries(w.heat)) buckets[k] = Math.round(x * 10) / 10;
      libCall('mergeHeatmap', c.item.id, buckets);
    }
    w.heat = {};
    const t = ended ? mp.d : mp.t;
    const pos = StageRules.positionToSave(t, mp.d);
    if (pos !== null) libCall('savePosition', c.item.id, pos);
  }

  /* ── On screen: the name and the black sheet ─────────────────────── */

  function overlay(id, data, z) { if (mpv.alive()) quietly(mpv.command(Overlay.overlayCommand(id, data, z))); }

  function clearName() { nameGen++; overlay(Overlay.NAME_ID, ''); }

  function showName(item) {
    clearName();
    const s = cfg();
    if (!s.showName || hideNames || hold || lockedNow() || !item) return;
    const text = StageRules.nameText(item.filename);
    if (!text) return;
    const my = nameGen;
    const steps = Overlay.FADE_STEPS;
    const stepMs = Overlay.FADE_MS / steps;
    const draw = (f) => { if (my === nameGen) overlay(Overlay.NAME_ID, Overlay.nameEvent(text, f), 0); };
    Overlay.fadeSteps('in').forEach((f, i) => T.setTimeout(() => draw(f), i * stepMs));
    const outAt = Overlay.FADE_MS + Math.max(1, Number(s.nameSeconds) || 3) * 1000;
    Overlay.fadeSteps('out').forEach((f, i) => T.setTimeout(() => {
      if (my !== nameGen) return;
      if (f <= 0) overlay(Overlay.NAME_ID, ''); else draw(f);
    }, outAt + i * stepMs));
  }

  let blackOn = false;
  function setBlack(on) {
    if (on) clearName();
    if (on === blackOn) return;
    blackOn = on;
    overlay(Overlay.BLACK_ID, on ? Overlay.blackEvent() : '', 10);
  }

  function applySound() {
    if (!mpv.alive()) return;
    quietly(mpv.set('volume', Math.round(Math.max(0, Math.min(1, volume)) * 100)));
    quietly(mpv.set('mute', !!(muted || hold || locked || forceMute)));
  }

  /* ── Pictures: their own timer ───────────────────────────────────── */

  function picStart(c) {
    if (!c || !c.pic) return;
    T.clearTimeout(c.pic.timer);
    if (repeat === 'one' || hold || paused || lockedNow()) return;
    c.pic.start = now();
    c.pic.timer = T.setTimeout(() => { if (cur === c) pictureDone(c); }, c.pic.left);
  }
  function picPause(c) {
    if (!c || !c.pic || !c.pic.start) return;
    T.clearTimeout(c.pic.timer);
    c.pic.left = Math.max(0, c.pic.left - (now() - c.pic.start));
    c.pic.start = 0;
  }
  function picTimes(c) {
    const d = c.pic.ms / 1000;
    const left = c.pic.start ? Math.max(0, c.pic.left - (now() - c.pic.start)) : c.pic.left;
    return { t: (c.pic.ms - left) / 1000, d, running: !!c.pic.start };
  }

  /** A picture's time is up: on to the file mpv has next, or wait for one. */
  function pictureDone(c) {
    if (cur !== c || lockedNow()) return;
    if (repeat === 'one') { c.pic.left = c.pic.ms; picStart(c); return; }
    if (next) { quietly(mpv.command(['playlist-next', 'force'])); return; }
    endOfFile();
  }

  async function gifLoop(path, item) {
    try {
      const st = await fs.promises.stat(path);
      if (st.size > GIF_MAX_BYTES) return Number(item.duration) || 0;
      const buf = await readFile(path);
      return StageRules.gifLoopSeconds(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)) || Number(item.duration) || 0;
    } catch { return Number(item.duration) || 0; }
  }

  /* ── Loading ─────────────────────────────────────────────────────── */

  let loudOn = null;       // Even out loudness as the files in mpv were given it (null: none yet)

  /** Even out loudness: the gain for this file in dB (0 when off or not measured). */
  function gainOf(item) {
    if (!isTimed(item) || cfg().evenLoudness === false || typeof lib.loudnessGain !== 'function' || lockedNow()) return 0;
    try {
      const g = lib.loudnessGain(item.id);
      return Number.isFinite(g) ? g : 0;
    } catch { return 0; }
  }
  function gainOptions(g) {
    if (!g) return {};
    return volumeGain ? { 'volume-gain': g.toFixed(1) } : { af: `lavfi=[volume=${g.toFixed(1)}dB]` };
  }

  function fileOptions(item, { startAt = 0 } = {}) {
    loudOn = cfg().evenLoudness !== false;           // what the files in mpv were given
    const o = gainOptions(gainOf(item));
    if (isTimed(item) && startAt > 0.5) o.start = startAt.toFixed(2);
    if (repeat === 'one' && !isPicture(item)) o['loop-file'] = 'inf';
    if (item.media_type === 'gif') o['loop-file'] = 'inf';
    return o;
  }

  function armLoadTimeout(c) {
    T.clearTimeout(c.loadTimer);
    c.loadTimer = T.setTimeout(() => {
      if (cur !== c || c.loaded || lockedNow()) return;
      report({ type: 'skipped', key: c.item.key, reason: 'it took too long to start' });
      cur = null;
      quietly(mpv.command(['stop']));
      advance();
    }, LOAD_TIMEOUT_MS);
  }

  /**
   * Put `item` on screen now (mpv replaces what it plays). auto: Stage moved
   * on by itself (Control is told so). false when its path cannot be read.
   */
  async function play(item, { auto = false, startPaused = false } = {}) {
    const p = pathFor(item);
    if (!p.ok) return false;
    const my = ++gen;
    finished = false;
    waiting = false;
    T.clearTimeout(waitTimer);
    if (cur) { saveWatch(cur); dropCurrent(); }
    next = null;
    const c = { item, entry: null, loaded: false, startedSent: false, auto, watch: newWatch(), pic: null, loadTimer: null, path: p.path };
    cur = c;
    if (isPicture(item)) {
      const loop = item.media_type === 'gif' ? await gifLoop(p.path, item) : 0;
      if (my !== gen) return true;
      const ms = StageRules.pictureMs(item, cfg().imageSeconds, loop);
      c.pic = { ms, left: ms, start: 0, timer: null };
    }
    paused = !!startPaused;
    try {
      await mpv.set('pause', paused || hold);
      const r = await mpv.loadfile(p.path, 'replace', fileOptions(item, { startAt: item.startAt || 0 }));
      if (my !== gen) return true;
      if (c.entry === null) c.entry = r && Number.isInteger(r.playlist_entry_id) ? r.playlist_entry_id : null;
    } catch {
      if (my !== gen) return true;
      cur = null;
      return false;
    }
    armLoadTimeout(c);
    appendNext();
    return true;
  }

  function dropCurrent() {
    if (!cur) return;
    T.clearTimeout(cur.loadTimer);
    if (cur.pic) T.clearTimeout(cur.pic.timer);
    if (cur.watch.dwell) T.clearTimeout(cur.watch.dwell);
    cur = null;
  }

  /**
   * Line up the first upcoming file that can be read as mpv's next entry.
   * Control may send a new list while mpv is still answering the append (an
   * Up next edit just as a file ends): the answer is then checked against
   * the list as it is now, and an entry for a file that is no longer first is
   * taken out again and the new first file lined up instead, so mpv never
   * moves on to a file the list has dropped. (Before, the edit was lost: the
   * append in flight won, and the stale file played.)
   */
  let appending = false;
  let appendAgain = false;
  async function appendNext() {
    if (appending) { appendAgain = true; return; }
    if (!cur || lockedNow() || repeat === 'one' || next) return;
    appending = true;
    const my = gen;
    try {
      do {
        appendAgain = false;
        while (upcoming.length && !next && repeat !== 'one') {
          const item = upcoming[0];
          const p = pathFor(item);
          if (!p.ok) {
            upcoming.shift();
            report({ type: 'skipped', key: item.key, reason: p.reason || 'it can’t be played' });
            continue;
          }
          const r = await mpv.loadfile(p.path, 'append', fileOptions(item));
          const entry = r && Number.isInteger(r.playlist_entry_id) ? r.playlist_entry_id : null;
          if (my !== gen || !cur) { if (entry !== null) removeEntry(entry); return; }
          // The list as it is now: still this file first (maybe under Control's newer key)?
          const head = upcoming[0];
          if (!head || head.id !== item.id || repeat === 'one' || next) {
            if (entry !== null) await removeEntry(entry);
            if (my !== gen || !cur) return;
            continue;
          }
          next = { item: head, entry };
        }
      } while (appendAgain && !next && my === gen && cur);
    } catch { /* mpv gone: its exit is handled elsewhere */ } finally { appending = false; appendAgain = false; }
  }

  async function removeEntry(entry) {
    try {
      const list = await mpv.command(['get_property', 'playlist']);
      const i = Array.isArray(list) ? list.findIndex(e => e && e.id === entry) : -1;
      if (i >= 0 && !(list[i].current || list[i].playing)) await mpv.command(['playlist-remove', i]);
    } catch {}
  }

  /** Control lined up something new: the appended entry follows it. */
  async function reconcileNext() {
    if (repeat === 'one') {
      if (next) { const e = next.entry; next = null; await removeEntry(e); }
      return;
    }
    if (next) {
      const head = upcoming[0];
      if (head && head.id === next.item.id) { next.item = head; return; }   // the same file, Control's newest key
      const e = next.entry;
      next = null;
      await removeEntry(e);
    }
    appendNext();
  }

  /* ── Moving on ───────────────────────────────────────────────────── */

  /** The file on screen is done and mpv has nothing next: Control may be a moment behind. */
  function endOfFile() {
    if (lockedNow() || closing) return;
    if (upcoming.length) { advance(); return; }
    if (waiting || finished) return;
    waiting = true;
    sendStatus(true);
    const my = gen;
    T.clearTimeout(waitTimer);
    waitTimer = T.setTimeout(() => {
      if (my !== gen || !waiting || upcoming.length) return;
      finish();
    }, WAIT_UPCOMING_MS);
  }

  function finish() {
    waiting = false;
    finished = true;
    if (cur) { saveWatch(cur, { ended: true }); dropCurrent(); }
    next = null;
    clearName();
    quietly(mpv.command(['stop']));
    report({ type: 'finished' });
    sendStatus(true);
  }

  /** Play the first upcoming file that can play; the end when there is none. */
  async function advance() {
    if (lockedNow() || closing) return;
    T.clearTimeout(waitTimer);
    waiting = false;
    while (upcoming.length) {
      const item = upcoming.shift();
      if (await play(item, { auto: true })) return;
      report({ type: 'skipped', key: item.key, reason: 'it can’t be played' });
    }
    endOfFile();
  }

  /* ── mpv's events ────────────────────────────────────────────────── */

  function onEvent(msg) {
    if (!msg || typeof msg.event !== 'string') return;
    switch (msg.event) {
      case 'property-change': onProperty(msg.name, msg.data); break;
      case 'start-file': onStartFile(msg.playlist_entry_id); break;
      case 'file-loaded': onFileLoaded(); break;
      case 'end-file': onEndFile(msg); break;
      default: break;
    }
  }

  function onProperty(name, v) {
    switch (name) {
      case 'time-pos': mp.t = Number.isFinite(v) ? v : 0; trackWatch(cur); break;
      case 'duration': mp.d = Number.isFinite(v) ? v : 0; break;
      case 'pause': mp.pause = v === true; break;
      case 'idle-active': mp.idle = v === true; break;
      case 'eof-reached':
        mp.eof = v === true;
        // keep-open: the last frame stays up, paused, and nothing is next.
        // (With a file lined up mpv moves on by itself and this never comes.)
        if (mp.eof && cur && cur.loaded && isTimed(cur.item) && repeat !== 'one' && !next && !lockedNow()) {
          saveWatch(cur, { ended: true });
          endOfFile();
        }
        break;
      default: break;
    }
  }

  function onStartFile(entry) {
    if (lockedNow()) return;
    if (cur && entry === cur.entry) return;               // the file Vault just loaded
    // Its start can come before mpv's answer to the loadfile that asked for it.
    if (cur && cur.entry === null && !cur.loaded && !(next && entry === next.entry)) { cur.entry = entry; return; }
    if (next && entry === next.entry) {
      // mpv moved on by itself to the file lined up.
      if (cur) { saveWatch(cur, { ended: true }); dropCurrent(); }
      const item = next.item;
      next = null;
      const i = upcoming.findIndex(u => u.key === item.key);
      upcoming = i >= 0 ? upcoming.slice(i + 1) : upcoming.filter(u => u.key !== item.key);
      finished = false;
      waiting = false;
      T.clearTimeout(waitTimer);
      gen++;
      const c = { item, entry, loaded: false, startedSent: false, auto: true, watch: newWatch(), pic: null, loadTimer: null };
      cur = c;
      if (isPicture(item)) {
        const ms = StageRules.pictureMs(item, cfg().imageSeconds, 0);
        c.pic = { ms, left: ms, start: 0, timer: null };
        // A GIF's real loop length, read once it is on (it rarely changes the time).
        if (item.media_type === 'gif') {
          const p = pathFor(item);
          if (p.ok) gifLoop(p.path, item).then((loop) => {
            if (cur !== c || !c.pic || !loop) return;
            const ms2 = StageRules.pictureMs(item, cfg().imageSeconds, loop);
            const used = c.pic.ms - (c.pic.start ? Math.max(0, c.pic.left - (now() - c.pic.start)) : c.pic.left);
            c.pic.ms = ms2;
            c.pic.left = Math.max(0, ms2 - used);
            if (c.pic.start) { picPause(c); picStart(c); }
          });
        }
      }
      armLoadTimeout(c);
      // Said at once, not when the file has loaded: from this moment Stage is
      // playing this file, and Control's next upcoming list must be for it
      // (the hub then drops an answer still meant for the file before).
      c.startedSent = true;
      report({ type: 'started', key: item.key, auto: true });
      appendNext();
    }
  }

  function onFileLoaded() {
    const c = cur;
    if (!c || c.loaded || lockedNow()) return;
    c.loaded = true;
    T.clearTimeout(c.loadTimer);
    mp.eof = false;
    if (!hold) { setBlack(false); showName(c.item); }
    if (c.pic) picStart(c);
    if (isPicture(c.item)) {
      // A picture counts as seen after a short look, as in the player.
      c.watch.dwell = T.setTimeout(() => { if (cur === c && !hold) libCall('recordView', c.item.id, 0); }, StageRules.DWELL_MS);
    }
    if (!c.startedSent) {
      c.startedSent = true;
      report({ type: 'started', key: c.item.key, auto: c.auto });
    }
    sendStatus(true);
  }

  function onEndFile(msg) {
    const entry = msg.playlist_entry_id;
    if (lockedNow()) return;
    if (!cur || entry !== cur.entry) return;
    const reason = msg.reason;
    if (reason === 'error' || (reason === 'eof' && !cur.loaded)) {
      report({ type: 'skipped', key: cur.item.key, reason: cur.loaded ? 'it stopped playing' : 'it can’t be played' });
      const hadNext = !!next;
      dropCurrent();
      if (!hadNext) advance();        // with a next entry mpv starts it by itself
      return;
    }
    if (reason === 'eof') {
      saveWatch(cur, { ended: true });
      if (!next) endOfFile();
    }
  }

  /* ── Status reports ──────────────────────────────────────────────── */

  function stateNow() {
    if (finished || !cur) return 'black';
    if (waiting) return 'waiting';
    if (!cur.loaded) return 'loading';
    if (cur.pic) return 'picture';
    return mp.pause ? 'paused' : 'playing';
  }

  function sendStatus(force = false) {
    if (lockedNow() || closing) return;
    let t = 0, d = 0, p = true;
    const c = cur;
    if (c && c.pic) { const pt = picTimes(c); t = pt.t; d = pt.d; p = !pt.running; }
    else if (c) { t = mp.t; d = mp.d || Number(c.item.duration) || 0; p = mp.pause; }
    const state = stateNow();
    const body = {
      type: 'status', key: c ? c.item.key : null, state,
      t: Math.round(t * 10) / 10, d: Math.round(d * 10) / 10, paused: p || hold, hold,
    };
    const sig = JSON.stringify(body);
    if (!force && sig === lastStatus) return;
    lastStatus = sig;
    report(body);
    // Auto-lock: a playing Stage (not paused, not on Hold, not black) is someone being there.
    if (!body.paused && (state === 'playing' || state === 'picture') && now() - lastTouch > TOUCH_EVERY_MS) {
      lastTouch = now();
      libCall('touch');
    }
  }

  function startStatus() {
    if (statusTimer) return;
    statusTimer = T.setInterval(() => sendStatus(false), STATUS_MS);
    if (statusTimer && statusTimer.unref) statusTimer.unref();
  }
  function stopStatus() { if (statusTimer) { T.clearInterval(statusTimer); statusTimer = null; } }

  /* ── Commands from Control (through the hub) ─────────────────────── */

  async function load(c) {
    upcoming = (c.upcoming || []).slice();
    repeat = c.repeat || 'off';
    const startPaused = c.paused === true;
    if (hold) holdWasPlaying = !startPaused;
    if (await play(c.item, { auto: false, startPaused })) return;
    report({ type: 'skipped', key: c.item.key, reason: 'it can’t be played' });
    cur = null;
    advance();
  }

  function setUpcoming(c) {
    upcoming = (c.upcoming || []).slice();
    const was = repeat;
    repeat = c.repeat || repeat;
    if (was !== repeat && cur && isTimed(cur.item)) quietly(mpv.set('loop-file', repeat === 'one' ? 'inf' : 'no'));
    if ((waiting || finished) && upcoming.length && !lockedNow()) {
      if (finished && !hold) setBlack(false);
      advance();
      return;
    }
    if (was === 'one' && repeat !== 'one' && cur && cur.pic && !cur.pic.start) picStart(cur);
    reconcileNext();
  }

  function doPlay() {
    if (!cur) return;
    paused = false;
    if (hold) { holdWasPlaying = true; return; }
    if (cur.pic) picStart(cur);
    else {
      if (mp.eof) quietly(mpv.command(['seek', 0, 'absolute+exact']));
      quietly(mpv.set('pause', false));
    }
    sendStatus(true);
  }

  function doPause() {
    if (!cur) return;
    paused = true;
    if (hold) { holdWasPlaying = false; return; }
    if (cur.pic) picPause(cur);
    else { quietly(mpv.set('pause', true)); saveWatch(cur); }
    sendStatus(true);
  }

  function seek(t) {
    if (!cur || !isTimed(cur.item)) return;
    const d = mp.d;
    const at = Math.max(0, d > 0 ? Math.min(d - 0.05, t) : t);
    quietly(mpv.command(['seek', at, 'absolute+exact']));
    waiting = false;
    sendStatus(true);
  }

  function setHold(on) {
    if (on === hold) return;
    hold = on;
    if (on) {
      holdWasPlaying = !!cur && (cur.pic ? !!cur.pic.start : !mp.pause);
      if (cur && cur.pic) picPause(cur);
      if (mpv.alive()) quietly(mpv.set('pause', true));
      if (cur) saveWatch(cur);
      setBlack(true);
    } else {
      setBlack(false);
      if (cur && !finished) {
        if (holdWasPlaying) {
          paused = false;
          if (cur.pic) picStart(cur); else quietly(mpv.set('pause', false));
        }
      }
    }
    applySound();
    sendStatus(true);
  }

  function setVolume(c) {
    volume = c.volume;
    muted = c.muted === true;
    applySound();
  }

  function setPrivacy(on) {
    hideNames = !!on;
    if (!hideNames) return;
    clearName();
    const blank = (it) => { if (it) it.filename = ''; };
    if (cur) blank(cur.item);
    if (next) blank(next.item);
    upcoming.forEach(blank);
  }

  function settingsChanged(s) {
    if (!mpv.alive() || !s) return;
    if (s.windowName) quietly(mpv.set('title', titleArg(s.windowName)));
    if (Number.isFinite(s.cursorSeconds)) quietly(mpv.set('cursor-autohide', Math.max(1, Math.min(60, Math.round(s.cursorSeconds))) * 1000));
    if (s.showName === false) clearName();
    loudnessChanged(s.evenLoudness !== false);
  }

  /**
   * Even out loudness switched while Stage is open. The file playing gets its
   * new gain as a file-local option (so it never carries into the files
   * after it), and the file already lined up in mpv's playlist is put there
   * again with the right per-file option.
   */
  async function loudnessChanged(on) {
    if (loudOn === null) { loudOn = on; return; }     // nothing handed to mpv yet
    if (on === loudOn) return;
    loudOn = on;
    if (cur && isTimed(cur.item)) {
      const g = gainOf(cur.item);
      if (volumeGain) quietly(mpv.set('file-local-options/volume-gain', g));
      else quietly(mpv.set('file-local-options/af', g ? `lavfi=[volume=${g.toFixed(1)}dB]` : ''));
    }
    if (next && isTimed(next.item)) {
      const e = next.entry;
      next = null;
      await removeEntry(e);
      appendNext();
    }
  }

  /** One command from the hub (already checked there). */
  function command(c) {
    if (!c || lockedNow()) return;
    switch (c.type) {
      case 'load': load(c); break;
      case 'upcoming': setUpcoming(c); break;
      case 'play': doPlay(); break;
      case 'pause': doPause(); break;
      case 'seek': seek(c.t); break;
      case 'hold': setHold(!!c.on); break;
      case 'volume': setVolume(c); break;
      case 'privacy': setPrivacy(c.hideNames === true); break;
      default: break;
    }
  }

  /* ── Lifecycle ───────────────────────────────────────────────────── */

  /** mpv is up: sound and session from the hub. */
  function started(session = {}) {
    closing = false;
    locked = false;
    volume = Number.isFinite(session.volume) ? session.volume : 1;
    muted = session.muted === true;
    hold = session.hold === true;
    hideNames = session.hideNames === true;
    finished = false;
    blackOn = false;
    if (hold) setBlack(true);
    applySound();
    startStatus();
  }

  /** Vault locked: black at once, the file unloaded, nothing read or written. */
  function lock() {
    locked = true;
    gen++;
    T.clearTimeout(waitTimer);
    waiting = false;
    if (cur) dropCurrent();
    next = null;
    upcoming = [];
    hold = true;
    nameGen++;
    if (mpv.alive()) {
      blackOn = false;
      setBlack(true);
      quietly(mpv.command(['stop']));
      quietly(mpv.set('mute', true));
      overlay(Overlay.NAME_ID, '');
    }
  }

  /**
   * Unlocked: the file that was on comes back paused under Hold (Hold off
   * plays it again if it was playing: the hub keeps that as session.resume).
   */
  function unlock(session = {}) {
    locked = false;
    hold = true;
    holdWasPlaying = session.resume === true;
    applySound();
    if (session.current) {
      const at = session.status && session.status.key === session.current.key ? session.status.t : session.current.startAt;
      upcoming = (session.upcoming || []).slice();
      repeat = session.repeat || 'off';
      play({ ...session.current, startAt: at || 0 }, { auto: false, startPaused: true }).then((ok) => {
        if (!ok) { cur = null; finished = true; sendStatus(true); }
      });
    } else {
      finished = true;
      sendStatus(true);
    }
  }

  /** Before mpv is asked to quit: the spot is saved, nothing more is reported. */
  function closingNow() {
    if (cur) saveWatch(cur);
    closing = true;
    stopStatus();
    nameGen++;
  }

  /** mpv went away (closed or crashed): forget everything. */
  function stopped() {
    stopStatus();
    T.clearTimeout(waitTimer);
    if (cur) dropCurrent();
    next = null;
    upcoming = [];
    waiting = false;
    finished = false;
    nameGen++;
  }

  /** Where Stage is, for the hand-back to the mini player. */
  function position() {
    if (!cur) return { key: null, t: 0, paused: true };
    if (cur.pic) return { key: cur.item.key, t: 0, paused: !cur.pic.start };
    return { key: cur.item.key, t: mp.t, paused: mp.pause || hold };
  }

  return {
    onEvent, command, started, lock, unlock, closingNow, stopped, position, settingsChanged, sendStatus,
    _state: () => ({
      cur: cur && { key: cur.item.key, id: cur.item.id, entry: cur.entry, loaded: cur.loaded, pic: cur.pic && { ...cur.pic, timer: undefined } },
      next: next && { key: next.item.key, id: next.item.id, entry: next.entry },
      upcoming: upcoming.map(u => u.key), repeat, paused, hold, holdWasPlaying, finished, waiting, locked, volume, muted, hideNames, blackOn, mp: { ...mp },
    }),
  };
}

module.exports = { createEngine, STATUS_MS, WAIT_UPCOMING_MS, LOAD_TIMEOUT_MS, SAVE_EVERY_S };
