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
const { buildArgs } = require('../lib/stage/mpv-args');
const mpvFind = require('../lib/stage/mpv-find');
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
function buildRouter({ lib = {}, pickMpv = null, onSettingsSaved = null, env = process.env, hostFactory = createMpvHost, find: findReal = mpvFind.findMpv, platform = process.platform, setlog: givenLog = null } = {}) {
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
    host.set('geometry', `${w}x${h}${pos}`).catch(() => {});
  }

  /**
   * A size preset from the remote's menu: the picture exactly that size
   * (mpv's window has no frame, so the window is the picture), or back to the
   * free size it had.
   */
  async function applySize(preset) {
    if (!alive()) return;
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
      canChoose: platform === 'win32' && env.VAULT_DISABLE_NATIVE_PICKER !== '1' && typeof pickMpv === 'function',
      // Which Stage opens: mpv, or Basic (picture-in-picture in the Vault page).
      choice: StageRules.playerChoice({ setting: readSettings().player, mpvFound: f.found === true }),
    };
  }

  async function launch() {
    if (readSettings().player === 'basic') return { status: 200, body: { ok: true, mode: 'basic' } };
    const found = await find({ chosen: readChosen() });
    if (!found.found) {
      // The page runs Basic Stage itself (picture-in-picture); nothing to start here.
      return { status: 409, body: { error: 'mpv was not found on this computer, so Stage runs as Basic (picture-in-picture).', code: 'MPV_MISSING', mode: 'basic' } };
    }
    const s = readSettings();
    const w = readWindow();
    const preset = stageSettings.SIZE_PRESETS[s.openSize] || null;
    const saved = geometry.usableBounds(w.bounds);
    let bounds = saved;
    if (preset) bounds = saved ? { x: saved.x, y: saved.y, w: preset.w, h: preset.h } : { w: preset.w, h: preset.h };
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
        if (engine) engine.onEvent(msg);
      },
      onWindow,
      onExit: ({ asked }) => {
        if (host === h) {
          if (engine) engine.stopped();
          engine = null;
          host = null;
          lastBounds = null;
        }
        hub.stageExited({ byUser: asked });
      },
    });
    host = h;
    engine = createEngine({ mpv: h, report: (r) => hub.report(r), settings: readSettings, lib, forceMute, volumeGain: volumeGainSupported(found.version) });
    const out = await h.start(found.path, (ipcPath) => buildArgs({
      ipcPath, title: s.windowName, bounds, maximized: w.max === true && !preset,
      cursorSeconds: s.cursorSeconds, volume: session.volume, muted: session.muted, forceMute, quiet,
      hwdec: s.hwDecoding !== false, mpvVersion: found.version,
    }), { mpvVersion: found.version });
    if (!out.ok) {
      if (host === h) { host = null; engine = null; }
      try { h.kill(); } catch {}
      return { status: 500, body: { error: 'Stage could not open: mpv did not start.', code: 'MPV_FAILED' } };
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
      size: lastBounds && !lastBounds.max ? geometry.presetOf(lastBounds.win, stageSettings.SIZE_PRESETS) : 'free',
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
  // the native picker this server opens. Nothing in the request is used.
  router.post('/api/stage/mpv/choose', (req, res) => {
    if (typeof pickMpv !== 'function') return res.status(501).json({ error: 'Choosing mpv works on Windows only. Install mpv so it is on PATH.' });
    pickMpv(res, async (pick, finish) => {
      try {
        if (pick.canceled) return finish(200, { canceled: true, mpv: await status() });
        const c = mpvFind.checkPath(pick.path, { platform });
        if (!c.ok) return finish(400, { error: c.error });
        const v = await mpvFind.askVersion(c.real, c.stat);
        if (!v) return finish(400, { error: 'That program did not answer as mpv. Choose mpv.exe from your mpv folder.' });
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
      if (typeof lib.inLibrary === 'function' && !lib.inLibrary(b.id)) return res.status(404).json({ error: 'That file is not in the library.' });
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
