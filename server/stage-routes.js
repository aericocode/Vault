/**
 * Stage routes (PLAYLISTS_SPEC 5, "Stage host, final"): Stage plays in the
 * user's own mpv, driven from here; Control (the mini player as the remote)
 * talks to the hub (lib/stage/hub.js).
 *
 *   GET  /api/stage/state           is Stage open, is mpv there, the session
 *   GET  /api/stage/events?role=control   server-sent events for Control
 *   POST /api/stage/open            start mpv (or bring it to the front); with Basic
 *                                   chosen or no mpv nothing starts here: the page
 *                                   runs Basic Stage (picture-in-picture) itself
 *   POST /api/stage/cmd             a command from Control (load, play, hold...)
 *   GET  /api/stage/settings        Settings › Stage
 *   POST /api/stage/settings        change some of them
 *   GET  /api/stage/mpv             where mpv is (Settings › Stage)
 *   POST /api/stage/mpv/choose      pick mpv.exe in the native file picker
 *   POST /api/stage/mpv/forget      go back to finding mpv by itself
 *
 * Everything is under /api, so it goes through the lock gate (423 while
 * locked) and the CSRF / Host / Fetch Metadata guards in server/index.js.
 *
 * mpv's path never comes from a page: it is found in the usual install
 * folders or on PATH, or picked by the user in the native file picker this
 * server opens, and it is checked again on every launch (lib/stage/mpv-find.js).
 * Files go to mpv as paths the server reads from the library for the ids
 * Control sends, only while unlocked.
 */

const express = require('express');
const appSettings = require('../lib/app-settings');
const vault = require('../lib/vault');
const stageSettings = require('../lib/stage/settings');
const geometry = require('../lib/stage/geometry');
const { createHub, ROLES } = require('../lib/stage/hub');
const { createEngine } = require('../lib/stage/engine');
const { createMpvHost, volumeGainSupported } = require('../lib/stage/mpv-host');
const { buildArgs, displayPlan, windowPlan } = require('../lib/stage/mpv-args');
const { createWindowFit } = require('../lib/stage/window-fit');
const x11Hints = require('../lib/stage/x11-hints');
const mpvFind = require('../lib/stage/mpv-find');
const fsBrowse = require('../lib/fs-browse');
const StageRules = require('../player-lib/stage-rules.js');
const { createSetLog } = require('../lib/stage/setlog');

/**
 * @param {object} opts
 * @param {object} opts.lib   library access for the engine: pathFor, recordView, savePosition, mergeHeatmap
 * @param {(res: object, done: (pick: object, finish: Function) => void) => void} [opts.pickMpv]
 *        opens the native file picker (server/index.js spawnPicker); done gets
 *        { canceled } | { path } and the function that answers the request
 * @param {Function} [opts.hostFactory]  createMpvHost (tests)
 * @param {Function} [opts.find]         mpvFind.findMpv (tests)
 * @param {(settings: object) => void} [opts.onSettingsSaved]  after Settings › Stage saves (Flow's "Measure for Flow")
 * @param {object} [opts.setlog]  the set log (lib/stage/setlog.js); made from lib.db when not given
 */
function buildRouter({ lib = {}, pickMpv = null, onSettingsSaved = null, env = process.env, hostFactory = createMpvHost, find: findReal = mpvFind.findMpv, platform = process.platform, setlog: givenLog = null, borderOnly = x11Hints.setBorderOnly, fitTiming = {} } = {}) {
  const router = express.Router();
  // What Stage played (Log on the Stage bar, Settings › Stage). Kept in Vault's database.
  const setlog = givenLog || (typeof lib.db === 'function'
    ? createSetLog({ db: lib.db, titleFor: lib.titleFor, isLocked: typeof lib.isLocked === 'function' ? lib.isLocked : () => false })
    : null);
  // VAULT_STAGE_NO_MPV=1 (checks only): mpv is never found, so Stage runs Basic.
  const find = (o) => (env.VAULT_STAGE_NO_MPV === '1' ? Promise.resolve({ found: false }) : findReal(o));

  const readSettings = () => stageSettings.normalize(appSettings.all().stage);
  const readWindow = () => {
    const w = appSettings.all().stageWindow;
    return w && typeof w === 'object' ? w : {};
  };
  const saveWindow = (patch) => appSettings.set({ stageWindow: { ...readWindow(), ...patch } });
  // The mpv the user picked. Its own key: the Settings POST cannot reach it.
  const readChosen = () => {
    const m = appSettings.all().stageMpv;
    return m && typeof m.path === 'string' ? m.path : null;
  };

  const quiet = env.VAULT_STAGE_TEST_QUIET === '1';
  const forceMute = env.VAULT_STAGE_MUTE === '1';

  let host = null;
  let engine = null;
  let hub = null;
  let lastBounds = null;     // the window watcher's latest line: { win, max, min, work }
  let fixedOnce = false;     // a window opened off every screen was brought back once
  let opening = null;        // a launch in progress (one at a time)
  // The size chosen last ('free' or a preset). Off Windows nothing reports
  // the window's size, so this is what Stage knows there, and it says
  // whether the window has the desktop's frame (windowPlan).
  let sizeMode = 'free';
  // Linux and other X11/Wayland systems: frame, shape and wheel handled here
  // (windowPlan, window-fit.js). Windows and macOS: as they always were.
  const framable = platform !== 'win32' && platform !== 'darwin';
  let kind = null;           // the window mpv made (windowPlan first or fallback)
  let fit = null;            // window-fit.js for that window

  const alive = () => !!host && host.alive();

  /* ── The window: where it is, sizes, front ───────────────────────── */

  function onWindow(ev) {
    if (ev.type !== 'bounds') return;
    lastBounds = ev;
    // A spot remembered on a monitor that has since gone: back onto the nearest one, once.
    if (!quiet && !fixedOnce && !ev.max && !ev.min && !geometry.usableBounds(ev.win, [ev.work])) {
      fixedOnce = true;
      const r = geometry.windowRectForClient(ev.win, ev.win, ev.win, ev.work);
      setGeometry(r);
      return;
    }
    fixedOnce = true;
    if (ev.min) return;
    if (ev.max) { saveWindow({ max: true }); return; }
    const b = geometry.usableBounds(ev.win, [ev.work]);
    if (b) saveWindow({ bounds: b, max: false });
  }

  function setGeometry(r) {
    if (!alive()) return;
    const w = Math.round(r.w), h = Math.round(r.h);
    if (!(w > 0) || !(h > 0)) return;
    const pos = Number.isFinite(r.x) && Number.isFinite(r.y) ? `+${Math.round(r.x)}+${Math.round(r.y)}` : '';
    if (fit) fit.noteGeometry({ w, h });
    host.set('geometry', `${w}x${h}${pos}`).catch(() => {});
  }

  /**
   * A size preset from the remote's menu: the picture exactly that size
   * (mpv's window has no frame, so the window is the picture), or back to the
   * free size it had.
   */
  async function applySize(preset) {
    if (!alive()) return;
    if (stageSettings.OPEN_SIZES.includes(preset)) sizeMode = preset;
    if (framable) { await applySizeLinux(preset); return; }
    if (lastBounds && lastBounds.max) {
      await host.set('window-maximized', false).catch(() => {});
    }
    const win = lastBounds && !lastBounds.max ? lastBounds.win : null;
    const now = win ? geometry.presetOf(win, stageSettings.SIZE_PRESETS) : 'free';
    if (preset === 'free') {
      const free = geometry.usableBounds(readWindow().freeBounds);
      if (free && now !== 'free') setGeometry(free);
      return;
    }
    const size = stageSettings.SIZE_PRESETS[preset];
    if (!size) return;
    if (!win) { setGeometry({ w: size.w, h: size.h }); return; }
    // Remember the free size the first time a preset replaces it.
    if (now === 'free') saveWindow({ freeBounds: win });
    setGeometry(geometry.windowRectForClient(size, win, win, lastBounds.work));
  }

  /**
   * The same off Windows, where nothing reports the window's spot: the
   * desktop's frame on (Free size) or off (a preset) where this window has
   * one, out of maximised first, then the preset's size, or back to the size
   * Free size had (this session, or the last one).
   */
  async function applySizeLinux(preset) {
    const free = sizeMode === 'free';
    const freeBefore = fit ? fit.freeSize() : null;
    if (fit) fit.setEnabled(false);
    if (kind && kind.frameAtFree) await host.set('border', free).catch(() => {});
    if (fit && fit.isMaximized()) await host.set('window-maximized', false).catch(() => {});
    if (free) {
      const back = freeBefore || savedFreeSize();
      if (back) setGeometry(back);
      if (kind && kind.borderOnly) borderOnlySoon();
      if (fit) fit.setEnabled(!quiet);
      return;
    }
    const size = stageSettings.SIZE_PRESETS[preset];
    if (size) setGeometry({ w: size.w, h: size.h });
  }

  /** The size Free size had when Stage was last open (Linux), or null. */
  function savedFreeSize() {
    const f = readWindow().linuxFreeSize;
    if (!f || !Number.isInteger(f.w) || !Number.isInteger(f.h)) return null;
    if (f.w < geometry.MIN_CLIENT.w || f.h < geometry.MIN_CLIENT.h || f.w > 16384 || f.h > 16384) return null;
    return { w: f.w, h: f.h };
  }

  /**
   * VAULT_STAGE_LINUX_FRAME=border: ask for a frame without a title bar,
   * after mpv has put its own frame up (mpv writes the same property).
   */
  let saidNoXprop = false;
  function borderOnlySoon() {
    const h = host;
    const t = setTimeout(() => {
      if (host !== h || !alive() || sizeMode !== 'free') return;
      borderOnly({ wid: h.hwnd, env }).then((res) => {
        if (res === 'no-xprop' && !saidNoXprop) {
          saidNoXprop = true;
          console.warn('[Stage] VAULT_STAGE_LINUX_FRAME=border needs xprop (package x11-utils); the window keeps its title bar.');
        }
      }).catch(() => {});
    }, 250);
    if (t.unref) t.unref();
  }

  /** Bring Stage above other windows (without taking the focus from Vault). */
  function front() {
    if (!alive()) return;
    host.set('ontop', true).then(() => new Promise(r => setTimeout(r, 120)))
      .then(() => host.set('ontop', false)).catch(() => {});
  }

  /* ── mpv and the engine ─────────────────────────────────────────── */

  const runner = {
    alive,
    command: (c) => { if (engine) engine.command(c); },
    front,
    size: (preset) => { applySize(preset); },
    close: () => {
      if (engine) engine.closingNow();
      if (host) host.quit();
    },
    position: () => (engine ? engine.position() : null),
    lock: () => { if (engine) engine.lock(); },
    unlock: (session) => { if (engine) engine.unlock(session); },
    settingsChanged: (st) => { if (engine) engine.settingsChanged(st); },
  };

  hub = createHub({
    stage: runner,
    settings: { get: readSettings, sizes: stageSettings.OPEN_SIZES },
    forceMute,
    log: setlog,
  });

  async function status() {
    const chosen = readChosen();
    const f = await find({ chosen });
    return {
      found: f.found === true,
      path: f.found ? f.path : null,
      version: f.found ? f.version : null,
      source: f.found ? f.source : null,
      chosen,
      chosenProblem: f.chosenProblem || null,
      // Linux: an mpv in a sandbox Vault cannot use (Flatpak, Snap), and how the window meets the desktop.
      sandboxed: f.sandboxed || null,
      platform,
      display: displayPlan({ platform, env, xwayland: readSettings().xwayland }),
      // Off Windows there is always a way: the desktop's dialog, or Vault's own folder browser.
      canChoose: typeof pickMpv === 'function' && (platform !== 'win32' || env.VAULT_DISABLE_NATIVE_PICKER !== '1'),
      // Which Stage opens: mpv, or Basic (picture-in-picture in the Vault page).
      choice: StageRules.playerChoice({ setting: readSettings().player, mpvFound: f.found === true }),
    };
  }

  async function launch() {
    if (readSettings().player === 'basic') return { status: 200, body: { ok: true, mode: 'basic' } };
    const found = await find({ chosen: readChosen(), withOptions: true });
    if (!found.found) {
      // The page runs Basic Stage itself (picture-in-picture); nothing to start here.
      return { status: 409, body: { error: 'mpv was not found on this computer, so Stage runs as Basic (picture-in-picture).', code: 'MPV_MISSING', mode: 'basic' } };
    }
    const s = readSettings();
    const w = readWindow();
    const preset = stageSettings.SIZE_PRESETS[s.openSize] || null;
    sizeMode = preset ? s.openSize : 'free';
    const saved = geometry.usableBounds(w.bounds);
    let bounds = saved;
    if (preset) bounds = saved ? { x: saved.x, y: saved.y, w: preset.w, h: preset.h } : { w: preset.w, h: preset.h };
    // Linux never learns the window's spot; Free size opens at the size it had last.
    else if (!saved && framable && !quiet) bounds = savedFreeSize();
    const session = hub.state();
    lastBounds = null;
    fixedOnce = false;
    const h = hostFactory({
      platform,
      onEvent: (msg) => {
        if (msg && msg.event === 'client-message' && Array.isArray(msg.args) && msg.args[0] === 'vault-stage' && msg.args[1] === 'close') {
          hub.closeRequested();
          return;
        }
        // Linux: the mouse wheel over the picture (mpv-host.js WHEEL_BINDINGS).
        if (msg && msg.event === 'client-message' && Array.isArray(msg.args) && msg.args[0] === 'vault-stage' && (msg.args[1] === 'grow' || msg.args[1] === 'shrink')) {
          if (fit && host === h) fit.step(msg.args[1] === 'grow' ? 1 : -1).catch(() => {});
          return;
        }
        if (fit && host === h && msg && msg.event === 'property-change') fit.onProperty(msg.name, msg.data);
        if (engine) engine.onEvent(msg);
      },
      onWindow,
      onExit: ({ asked }) => {
        if (host === h) {
          if (engine) engine.stopped();
          engine = null;
          host = null;
          lastBounds = null;
          if (fit) fit.stop();
          fit = null;
          kind = null;
        }
        hub.stageExited({ byUser: asked });
      },
    });
    host = h;
    if (fit) fit.stop();
    kind = null;
    // Linux: the window kept to the video's shape (made now: mpv reports sizes as soon as it is up).
    fit = framable ? createWindowFit({
      ...fitTiming,
      setGeometry: (size) => { if (host === h) h.set('geometry', `${size.w}x${size.h}`).catch(() => {}); },
      getScreen: async () => {
        const [dw, dh] = await Promise.all([h.get('display-width'), h.get('display-height')]);
        return Number.isFinite(dw) && Number.isFinite(dh) && dw > 0 && dh > 0 ? { w: dw, h: dh } : null;
      },
      onSettled: (size) => { if (sizeMode === 'free' && host === h) saveWindow({ linuxFreeSize: size }); },
    }) : null;
    engine = createEngine({ mpv: h, report: (r) => hub.report(r), settings: readSettings, lib, forceMute, volumeGain: volumeGainSupported(found.version) });
    // A Wayland desktop: mpv on XWayland (placed, kept in front), or mpv's own
    // Wayland window (Linux Free size, mpv-args.js windowPlan); the other one if
    // the first will not start.
    const plan = windowPlan({ platform, env, xwayland: s.xwayland, size: sizeMode, quiet });
    const argsFor = (k) => (ipcPath) => buildArgs({
      ipcPath, title: s.windowName, bounds, maximized: w.max === true && !preset,
      cursorSeconds: s.cursorSeconds, volume: session.volume, muted: session.muted, forceMute, quiet,
      hwdec: s.hwDecoding !== false, mpvVersion: found.version, mpvOptions: found.options, x11: k.x11,
      framed: sizeMode === 'free' && k.frameAtFree, keepAspect: plan.keepAspect,
    });
    const out = await h.start(found.path, argsFor(plan.first), { mpvVersion: found.version, fallbackArgsFor: plan.fallback ? argsFor(plan.fallback) : null });
    if (!out.ok) {
      if (host === h) { host = null; engine = null; if (fit) fit.stop(); fit = null; }
      try { h.kill(); } catch {}
      return { status: 500, body: { error: 'Stage could not open: mpv did not start.', code: 'MPV_FAILED' } };
    }
    if (fit && host === h) {
      kind = out.fellBack && plan.fallback ? plan.fallback : plan.first;
      fit.setEnabled(sizeMode === 'free' && !quiet);
      if (sizeMode === 'free' && kind.borderOnly) borderOnlySoon();
    }
    engine.started(session);
    hub.opened('mpv');
    return { status: 200, body: { ok: true, mode: 'mpv' } };
  }

  vault.onChange((e) => {
    if (e === 'locked') hub.lock();
    else if (e === 'unlocked') {
      // What the set log could not write while locked, written now.
      if (setlog && typeof setlog.flush === 'function') { try { setlog.flush(); } catch {} }
      hub.unlock();
    }
  });
  if (vault.isLocked()) hub.lock();

  // Never leave mpv behind (Windows also ends it with Vault's process, mpv-host.js).
  process.on('exit', () => { try { if (host) host.kill(); } catch {} });

  /* ── Routes ──────────────────────────────────────────────────────── */

  router.get('/api/stage/state', async (req, res) => {
    let mpv = null;
    try { mpv = await status(); } catch { mpv = { found: false }; }
    res.json({
      ...hub.state(), mpv, settings: readSettings(),
      size: lastBounds && !lastBounds.max ? geometry.presetOf(lastBounds.win, stageSettings.SIZE_PRESETS)
        // Off Windows nothing reports the window: the size chosen last.
        : (framable && alive() ? sizeMode : 'free'),
    });
  });

  router.get('/api/stage/events', (req, res) => {
    const role = String(req.query.role || '');
    if (!ROLES.has(role)) return res.status(400).json({ error: 'role must be control' });
    hub.attach(role, req, res);
  });

  router.post('/api/stage/open', async (req, res) => {
    if (alive()) { front(); hub.opened('mpv'); return res.json({ ok: true, mode: 'mpv', reused: true }); }
    if (!opening) opening = launch().finally(() => { opening = null; });
    const out = await opening;
    res.status(out.status).json(out.body);
  });

  router.post('/api/stage/cmd', (req, res) => {
    const out = hub.command(req.body);
    res.status(out.status).json(out.body);
  });

  router.get('/api/stage/settings', (req, res) => res.json(readSettings()));

  router.post('/api/stage/settings', (req, res) => {
    const v = stageSettings.validatePatch(req.body, readSettings());
    if (!v.ok) return res.status(400).json({ error: v.error });
    appSettings.set({ stage: v.settings });
    hub.settingsChanged();
    if (typeof onSettingsSaved === 'function') { try { onSettingsSaved(v.settings); } catch {} }
    res.json(v.settings);
  });

  router.get('/api/stage/mpv', async (req, res) => {
    try { res.json(await status()); } catch { res.status(500).json({ error: 'Could not look for mpv.' }); }
  });

  // The only way a path reaches the mpv setting: the user picks the file in
  // the native picker this server opens. On Windows nothing in the request
  // is used. Off Windows, when there is no desktop dialog, the picker answers
  // { fallback: true } and the page asks again with the file chosen in
  // Vault's own folder browser ({ path }); it gets the same checks
  // (mpvFind.checkPath: named mpv, a file, runnable, and off Windows owned
  // by root or this user in folders nobody else can write to; then it must
  // answer --version as mpv). Only a same-origin page can send that path:
  // the Host allowlist, Fetch Metadata and CSRF guards in server/index.js
  // run before this router.
  router.post('/api/stage/mpv/choose', (req, res) => {
    if (typeof pickMpv !== 'function') return res.status(501).json({ error: 'Choosing mpv works on Windows only. Install mpv so it is on PATH.' });
    const given = platform !== 'win32' && req.body && typeof req.body === 'object' ? req.body.path : undefined;
    // One plain absolute path (normalized, not in /proc, /sys or /dev) before anything looks at it.
    if (given !== undefined && !fsBrowse.plainAbsolute(given)) return res.status(400).json({ error: 'Choose the mpv program by its full path.' });
    const open = given !== undefined
      ? (r, done) => done({ path: typeof given === 'string' ? given : '' }, (status, body) => r.status(status).json(body))
      : pickMpv;
    // The picker can stay open for minutes: nothing is run or saved once the vault has locked.
    const locked = () => typeof lib.isLocked === 'function' && lib.isLocked();
    const LOCKED = { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' };
    open(res, async (pick, finish) => {
      try {
        if (locked()) return finish(423, LOCKED);
        if (pick.canceled) return finish(200, { canceled: true, mpv: await status() });
        const c = mpvFind.checkPath(pick.path, { platform });
        if (!c.ok) return finish(400, { error: c.error });
        const v = await mpvFind.askVersion(c.real, c.stat);
        if (!v) return finish(400, { error: `That program did not answer as mpv. Choose ${platform === 'win32' ? 'mpv.exe from your mpv folder' : 'the mpv program, usually /usr/bin/mpv'}.` });
        if (locked()) return finish(423, LOCKED);
        appSettings.set({ stageMpv: { path: c.real } });
        finish(200, { ok: true, mpv: await status() });
      } catch {
        finish(500, { error: 'Could not use that file.' });
      }
    });
  });

  router.post('/api/stage/mpv/forget', async (req, res) => {
    appSettings.set({ stageMpv: null });
    try { res.json({ ok: true, mpv: await status() }); } catch { res.json({ ok: true }); }
  });

  /* ── The set log ─────────────────────────────────────────────────── */

  const noLog = (res) => res.status(503).json({ error: 'The set log is not available.' });

  router.get('/api/stage/setlog', (req, res) => {
    if (!setlog) return noLog(res);
    try { res.json({ sets: setlog.sets() }); } catch { res.status(500).json({ error: 'Could not read the set log.' }); }
  });

  router.get('/api/stage/setlog/:id', (req, res) => {
    if (!setlog) return noLog(res);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Not a set.' });
    let out;
    try { out = setlog.setById(id); } catch { return res.status(500).json({ error: 'Could not read the set log.' }); }
    if (!out) return res.status(404).json({ error: 'That set is no longer kept.' });
    // A file since removed from the library shows its stored name, not clickable.
    const has = typeof lib.inLibrary === 'function' ? lib.inLibrary : () => true;
    for (const e of out.entries) { try { e.inLibrary = !!has(e.mediaId); } catch { e.inLibrary = false; } }
    res.json(out);
  });

  // Basic Stage plays in the page, so the page says what it plays:
  // start (a file began playing), playing, paused, beat (still there, every
  // 20 s), stopped, closed (Stage closed). Only ever about Basic's own file
  // (lib/stage/setlog.js basic): the page cannot change what mpv Stage logs.
  const BASIC_STATES = new Set(['start', 'playing', 'paused', 'beat', 'stopped', 'closed']);
  router.post('/api/stage/setlog/basic', (req, res) => {
    if (!setlog) return noLog(res);
    const b = req.body || {};
    if (!BASIC_STATES.has(b.state)) return res.status(400).json({ error: 'state must be start, playing, paused, beat, stopped or closed.' });
    if (b.state === 'start') {
      if (!Number.isSafeInteger(b.id) || b.id <= 0) return res.status(400).json({ error: 'start needs the file id.' });
      if (b.title !== undefined && (typeof b.title !== 'string' || b.title.length > 1024)) return res.status(400).json({ error: 'title must be text.' });
      // Only files in the library; their names come from the library, not the page.
      // A file the library doesn't know still means the one before has stopped:
      // its time must not run on under this one.
      if (typeof lib.inLibrary === 'function' && !lib.inLibrary(b.id)) {
        setlog.basic('stopped');
        return res.status(404).json({ error: 'That file is not in the library.' });
      }
      setlog.basic('start', { id: b.id, title: typeof lib.titleFor === 'function' ? '' : (b.title || '') });
    } else setlog.basic(b.state);
    res.json({ ok: true });
  });

  // Every 15 s: a Basic page gone quiet has stopped, a set idle 30 minutes
  // has ended, and the file playing has its time written down.
  if (setlog && typeof setlog.tick === 'function') {
    const timer = setInterval(() => { try { setlog.tick(); } catch {} }, 15000);
    if (timer.unref) timer.unref();
  }

  /** mpv Stage is open and playing (not paused, not on Hold, not locked): Flow waits. */
  router.isPlaying = () => {
    const s = hub._session();
    return !!(s.open && s.mode === 'mpv' && alive() && !s.paused && !s.hold && !s.locked);
  };
  router._hub = hub;
  router._setlog = setlog;
  router._runner = runner;
  router._engine = () => engine;
  router._host = () => host;
  return router;
}

module.exports = { buildRouter };
