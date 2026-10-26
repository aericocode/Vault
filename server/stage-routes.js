/**
 * Stage routes (PLAYLISTS_SPEC 5): the Stage page, the Control <-> Stage hub
 * (lib/stage/hub.js), the window launcher (lib/stage/host.js) and Settings ›
 * Stage.
 *
 *   GET  /stage                     the page Stage shows (black, media only)
 *   GET  /api/stage/state           is Stage open, how it opens here, the session
 *   GET  /api/stage/events?role=    server-sent events: role=control | stage
 *   POST /api/stage/open            open Stage (or bring it to the front)
 *   POST /api/stage/cmd             a command from Control (load, play, hold...)
 *   POST /api/stage/report          a report from Stage (status, started...)
 *   GET  /api/stage/settings        Settings › Stage
 *   POST /api/stage/settings        change some of them
 *
 * Everything under /api goes through the lock gate (423 while locked) and the
 * CSRF / Host / Fetch Metadata guards in server/index.js, like every other
 * route. /stage itself is a static page and stays reachable, so a Stage
 * window open over a lock shows only black.
 *
 * Auto-lock: a Stage that is playing counts as someone being there. Its
 * status reports while it plays (and its stream requests) go through the
 * lock gate without X-Vault-Background, so the library never auto-locks and
 * blacks out a live stream. On Hold, paused or black at the end, every
 * report is marked background and the auto-lock clock runs as usual
 * (player-lib/stage.js report()).
 */

const express = require('express');
const appSettings = require('../lib/app-settings');
const vault = require('../lib/vault');
const stageSettings = require('../lib/stage/settings');
const geometry = require('../lib/stage/geometry');
const { createHub, ROLES } = require('../lib/stage/hub');
const { createHost } = require('../lib/stage/host');

/**
 * @param {object} opts
 * @param {(res: object) => void} opts.sendPage  answer GET /stage with player-lib/stage.html
 * @param {object} [opts.host]  a launcher to use instead of the real one (tests)
 */
function buildRouter({ sendPage, host: hostOverride = null, env = process.env } = {}) {
  const router = express.Router();

  const readSettings = () => stageSettings.normalize(appSettings.all().stage);
  const readWindow = () => {
    const w = appSettings.all().stageWindow;
    return w && typeof w === 'object' ? w : {};
  };
  let lastBounds = null;     // the host's latest report: { win, client, work, max, normal }

  function saveWindow(patch) {
    appSettings.set({ stageWindow: { ...readWindow(), ...patch } });
  }

  let hub = null;
  const host = hostOverride || createHost({
    env,
    onEvent: (ev) => {
      if (ev.type !== 'bounds') return;
      lastBounds = ev;
      const b = geometry.usableBounds(ev.max ? ev.normal : ev.win);
      if (b) saveWindow({ bounds: b, max: ev.max });
    },
    onExit: ({ byUser }) => { lastBounds = null; if (hub) hub.hostExited({ byUser }); },
  });

  /** A size preset from the remote's menu: the picture exactly that size, or back to the free size. */
  function applySize(preset) {
    if (!lastBounds) return;
    // Maximised: work from the size it restores to (the Stage window has no
    // frame, so that is its picture too).
    const win = lastBounds.max ? lastBounds.normal : lastBounds.win;
    const client = lastBounds.max ? lastBounds.normal : lastBounds.client;
    const now = geometry.presetOf(client, stageSettings.SIZE_PRESETS);
    if (preset === 'free') {
      const free = geometry.usableBounds(readWindow().freeBounds);
      if (free && (now !== 'free' || lastBounds.max)) host.setRect(free);
      return;
    }
    const size = stageSettings.SIZE_PRESETS[preset];
    if (!size) return;
    // Remember the free size the first time a preset replaces it.
    if (now === 'free') saveWindow({ freeBounds: win });
    host.setRect(geometry.windowRectForClient(size, win, client, lastBounds.work));
  }

  hub = createHub({
    host: {
      alive: () => host.alive(),
      close: () => host.close(),
      front: () => host.front(),
      size: (preset) => applySize(preset),
      setTitle: (t) => host.setTitle(t),
    },
    settings: {
      get: readSettings,
      sizes: stageSettings.OPEN_SIZES,
      presets: stageSettings.SIZE_PRESETS,
      // The popup reports where it is, so it can open there next time.
      saveBounds: (r) => { const b = geometry.usableBounds(r); if (b) saveWindow({ popupBounds: b }); },
    },
    forceMute: env.VAULT_STAGE_MUTE === '1',
  });

  vault.onChange((e) => {
    if (e === 'locked') hub.lock();
    else if (e === 'unlocked') hub.unlock();
  });
  if (vault.isLocked()) hub.lock();

  // Never leave a Stage window behind Vault (the helper also watches Vault's process).
  process.on('exit', () => { try { host.kill(); } catch {} });

  router.get('/stage', (req, res) => {
    res.set('Cache-Control', 'no-store');
    sendPage(res);
  });

  router.get('/api/stage/state', async (req, res) => {
    const m = await host.mode();
    res.json({
      ...hub.state(), how: m.mode, howReason: m.reason, settings: readSettings(),
      popupBounds: readWindow().popupBounds || null,
      size: lastBounds && !lastBounds.max ? geometry.presetOf(lastBounds.client, stageSettings.SIZE_PRESETS) : 'free',
    });
  });

  router.get('/api/stage/events', (req, res) => {
    const role = String(req.query.role || '');
    if (!ROLES.has(role)) return res.status(400).json({ error: 'role must be control or stage' });
    hub.attach(role, req, res);
  });

  router.post('/api/stage/open', async (req, res) => {
    const st = hub.state();
    if (st.open && host.alive()) { host.front(); return res.json({ ok: true, mode: 'webview2', reused: true }); }
    const m = await host.mode();
    if (m.mode !== 'webview2') { hub.opened('popup'); return res.json({ ok: true, mode: 'popup', reason: m.reason }); }
    const s = readSettings();
    const w = readWindow();
    const port = req.socket && req.socket.localPort;
    const preset = stageSettings.SIZE_PRESETS[s.openSize] || null;
    const bounds = geometry.usableBounds(w.bounds);
    const out = await host.launch({
      url: `http://127.0.0.1:${port}/stage?host=webview2`,
      title: s.windowName,
      bounds: bounds ? { ...bounds, max: w.max === true && !preset } : null,
      client: preset,
      mute: env.VAULT_STAGE_MUTE === '1',
    });
    if (!out.ok) { hub.opened('popup'); return res.json({ ok: true, mode: 'popup', fallback: true, reason: out.error }); }
    hub.opened('webview2');
    res.json({ ok: true, mode: 'webview2', reused: !!out.reused });
  });

  router.post('/api/stage/cmd', (req, res) => {
    const out = hub.command(req.body);
    res.status(out.status).json(out.body);
  });

  router.post('/api/stage/report', (req, res) => {
    const out = hub.report(req.body);
    res.status(out.status).json(out.body);
  });

  router.get('/api/stage/settings', (req, res) => res.json(readSettings()));

  router.post('/api/stage/settings', (req, res) => {
    const v = stageSettings.validatePatch(req.body, readSettings());
    if (!v.ok) return res.status(400).json({ error: v.error });
    appSettings.set({ stage: v.settings });
    hub.settingsChanged();
    res.json(v.settings);
  });

  router._hub = hub;
  router._host = host;
  return router;
}

module.exports = { buildRouter };
