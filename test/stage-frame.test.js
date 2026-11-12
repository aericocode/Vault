/**
 * The Stage window off Windows (mpv-args.js windowPlan, the routes' size menu).
 *
 * On X11 and XWayland a borderless window has no edges to drag: the window
 * manager's edges are its decorations, and mpv only starts moves. So on
 * Linux a Free size Stage window either is mpv's own Wayland window (no
 * frame; mpv draws its own edges), or has the desktop's frame, which
 * VAULT_STAGE_LINUX_FRAME picks (wayland, titled, border, none). A preset
 * size keeps the bare picture. mpv keeps the window to the shape it was last
 * sized to (--keepaspect-window=yes, Linux only). Windows keeps exactly the
 * command line and the behaviour it had.
 *
 * No real mpv runs here: the routes get a fake host, and the host test a
 * fake mpv on a real pipe. Runs on every OS: the platform is passed in.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stage-frame-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
delete process.env.VAULT_DB_PASSWORD;

const express = require('express');
const { buildArgs, windowPlan, windowSystemOf, actualKind, linuxFrame, fitOptions, FIXED, NEWER_OPTIONS, LINUX_FRAMES, DEFAULT_LINUX_FRAME, WAYLAND_CONTEXT } = require('../lib/stage/mpv-args');
const { createMpvHost, OBSERVED, OBSERVED_LINUX, WHEEL_BINDINGS } = require('../lib/stage/mpv-host');
const { borderOnlyArgs, setBorderOnly } = require('../lib/stage/x11-hints');
const appSettings = require('../lib/app-settings');
const { buildRouter } = require('../server/stage-routes');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const WAYLAND = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };

/* ── Which window, which frame ──────────────────────────────────────────── */

test('linuxFrame: VAULT_STAGE_LINUX_FRAME, any case, else the default (wayland)', () => {
  assert.deepStrictEqual([...LINUX_FRAMES], ['wayland', 'titled', 'border', 'none']);
  assert.strictEqual(DEFAULT_LINUX_FRAME, 'wayland');
  assert.strictEqual(linuxFrame({}), 'wayland');
  assert.strictEqual(linuxFrame({ VAULT_STAGE_LINUX_FRAME: 'Titled ' }), 'titled');
  assert.strictEqual(linuxFrame({ VAULT_STAGE_LINUX_FRAME: 'none' }), 'none');
  assert.strictEqual(linuxFrame({ VAULT_STAGE_LINUX_FRAME: 'border' }), 'border');
  assert.strictEqual(linuxFrame({ VAULT_STAGE_LINUX_FRAME: 'yes please' }), 'wayland');
  assert.strictEqual(linuxFrame(null), 'wayland');
});

test('windowPlan: Windows and macOS are as they were, whatever the environment says', () => {
  const bare = { x11: false, wayland: false, frameAtFree: false, borderOnly: false };
  for (const platform of ['win32', 'darwin']) {
    for (const f of [undefined, ...LINUX_FRAMES]) {
      for (const size of ['free', '720p']) {
        const env = { ...WAYLAND, VAULT_STAGE_XWAYLAND: '1', ...(f ? { VAULT_STAGE_LINUX_FRAME: f } : {}) };
        assert.deepStrictEqual(windowPlan({ platform, env, size }), { frame: null, keepAspect: false, first: bare, fallback: null, x11Kind: null, waylandKind: null }, `${platform} ${f} ${size}`);
      }
    }
  }
});

test('windowPlan: Wayland with XWayland, default frame: Free size is mpv\'s own Wayland window (no frame), a preset is XWayland', () => {
  const free = windowPlan({ platform: 'linux', env: WAYLAND, size: 'free' });
  assert.strictEqual(free.frame, 'wayland');
  assert.strictEqual(free.keepAspect, true);
  assert.deepStrictEqual(free.first, { x11: false, wayland: true, frameAtFree: false, borderOnly: false, pin: true });
  // If that mpv will not start: XWayland with the desktop's frame.
  assert.deepStrictEqual(free.fallback, { x11: true, wayland: false, frameAtFree: true, borderOnly: false });
  const preset = windowPlan({ platform: 'linux', env: WAYLAND, size: '1080p' });
  assert.deepStrictEqual(preset.first, { x11: true, wayland: false, frameAtFree: true, borderOnly: false });
  assert.deepStrictEqual(preset.fallback, { x11: false, wayland: true, frameAtFree: false, borderOnly: false });
  // VAULT_STAGE_XWAYLAND=1 (forced): XWayland at Free size too, with the frame.
  const forced = windowPlan({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_XWAYLAND: '1' }, size: 'free' });
  assert.deepStrictEqual(forced.first, { x11: true, wayland: false, frameAtFree: true, borderOnly: false });
});

test('windowPlan: titled, border and none keep XWayland at Free size; only border asks for no title bar; none has no frame', () => {
  const at = (f, size = 'free') => windowPlan({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: f }, size });
  assert.deepStrictEqual(at('titled').first, { x11: true, wayland: false, frameAtFree: true, borderOnly: false });
  assert.deepStrictEqual(at('border').first, { x11: true, wayland: false, frameAtFree: true, borderOnly: true });
  assert.deepStrictEqual(at('none').first, { x11: true, wayland: false, frameAtFree: false, borderOnly: false });
  for (const f of ['titled', 'border', 'none']) {
    // mpv's own Wayland window, if it comes to that, never has a frame (it would lose its own edges).
    assert.deepStrictEqual(at(f).fallback, { x11: false, wayland: true, frameAtFree: false, borderOnly: false }, f);
  }
});

test('windowPlan: an X11 session, XWayland off or missing, the quiet test window', () => {
  // An X11 session: an X11 window; the default frame there is the titled one.
  assert.deepStrictEqual(windowPlan({ platform: 'linux', env: { DISPLAY: ':0' } }).first, { x11: false, wayland: false, frameAtFree: true, borderOnly: false });
  assert.strictEqual(windowPlan({ platform: 'linux', env: { DISPLAY: ':0' } }).fallback, null);
  assert.strictEqual(windowPlan({ platform: 'linux', env: { DISPLAY: ':0', VAULT_STAGE_LINUX_FRAME: 'none' } }).first.frameAtFree, false);
  // The XWayland setting off, or no XWayland: mpv's own Wayland window, nothing to fall back to.
  for (const p of [windowPlan({ platform: 'linux', env: WAYLAND, xwayland: false, size: '720p' }), windowPlan({ platform: 'linux', env: { WAYLAND_DISPLAY: 'w' } })]) {
    assert.deepStrictEqual(p.first, { x11: false, wayland: true, frameAtFree: false, borderOnly: false });
    assert.strictEqual(p.fallback, null);
  }
  // Quiet: placed off every screen, so XWayland, and never framed.
  const q = windowPlan({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: 'border' }, quiet: true });
  assert.deepStrictEqual(q.first, { x11: true, wayland: false, frameAtFree: false, borderOnly: false });
});

/* ── The command line ───────────────────────────────────────────────────── */

// What Windows has always been given (3.10), byte for byte.
const WINDOWS_ARGS = ['--no-config', '--idle=yes', '--force-window=yes', '--keep-open=yes', '--force-media-title=Stage', '--media-controls=no', '--save-position-on-quit=no', '--resume-playback=no', '--write-filename-in-watch-later-config=no', '--terminal=no', '--msg-level=all=no', '--ytdl=no', '--load-scripts=no', '--osc=no', '--load-stats-overlay=no', '--load-console=no', '--load-select=no', '--load-commands=no', '--load-positioning=no', '--load-context-menu=no', '--load-auto-profiles=no', '--access-references=no', '--load-unsafe-playlists=no', '--autocreate-playlist=no', '--directory-mode=ignore', '--cookies=no', '--demuxer-lavf-o=protocol_whitelist=[file]', '--stream-lavf-o=protocol_whitelist=[file]', '--sub-auto=no', '--audio-file-auto=no', '--cover-art-auto=no', '--sid=no', '--audio-display=no', '--input-default-bindings=no', '--input-builtin-bindings=no', '--input-media-keys=no', '--border=no', '--window-dragging=yes', '--window-corners=donotround', '--keepaspect-window=no', '--auto-window-resize=no', '--focus-on=never', '--ontop=no', '--background-color=#000000', '--osd-level=0', '--osd-bar=no', '--cursor-autohide-fs-only=no', '--prefetch-playlist=yes', '--gapless-audio=weak', '--image-display-duration=inf', '--hwdec=auto-copy-safe', '--input-ipc-server=\\\\.\\pipe\\vault-stage-abc', '--title=Vault Stage', '--cursor-autohide=1000', '--volume=80', '--mute=no', '--geometry=1280x720+100+50'];

test('arguments: Windows gets exactly what it had, whatever VAULT_STAGE_LINUX_FRAME says', () => {
  const o = { ipcPath: '\\\\.\\pipe\\vault-stage-abc', title: 'Vault Stage', bounds: { x: 100, y: 50, w: 1280, h: 720 }, cursorSeconds: 1, volume: 0.8, muted: false, hwdec: true, mpvVersion: 'v0.41.0' };
  assert.deepStrictEqual(buildArgs(o), WINDOWS_ARGS);
  assert.deepStrictEqual(buildArgs({ ...o, framed: false, keepAspect: false }), WINDOWS_ARGS);
  for (const f of [undefined, ...LINUX_FRAMES]) {
    for (const size of ['free', '1080p']) {
      const plan = windowPlan({ platform: 'win32', env: f ? { VAULT_STAGE_LINUX_FRAME: f } : {}, size });
      const k = plan.first;
      assert.deepStrictEqual(buildArgs({ ...o, x11: k.x11, framed: size === 'free' && k.frameAtFree, keepAspect: plan.keepAspect }), WINDOWS_ARGS, `${f} ${size}`);
    }
  }
});

test('arguments: framed swaps --border, keepAspect swaps --keepaspect-window, each in its place, nothing else', () => {
  const bare = buildArgs({ ipcPath: 'p', x11: true });
  const diff = (a) => a.map((x, i) => (x === bare[i] ? null : [bare[i], x])).filter(Boolean);
  const framed = buildArgs({ ipcPath: 'p', x11: true, framed: true });
  assert.strictEqual(framed.length, bare.length);
  assert.deepStrictEqual(diff(framed), [['--border=no', '--border=yes']]);
  const keep = buildArgs({ ipcPath: 'p', x11: true, keepAspect: true });
  assert.deepStrictEqual(diff(keep), [['--keepaspect-window=no', '--keepaspect-window=yes']]);
  const both = buildArgs({ ipcPath: 'p', x11: true, framed: true, keepAspect: true });
  assert.deepStrictEqual(diff(both), [['--border=no', '--border=yes'], ['--keepaspect-window=no', '--keepaspect-window=yes']]);
  // Moving by the picture stays; the window still never takes focus or stays on top; the size never follows the video by itself.
  for (const a of ['--window-dragging=yes', '--focus-on=never', '--ontop=no', '--auto-window-resize=no', '--gpu-context=x11egl']) assert.ok(both.includes(a), a);
  // The quiet test window: a title bar would be kept on screen by the window manager.
  const quiet = buildArgs({ ipcPath: 'p', framed: true, quiet: true });
  assert.ok(quiet.includes('--border=no') && !quiet.includes('--border=yes'));
  // FIXED itself is never changed.
  assert.ok(FIXED.includes('--border=no') && FIXED.includes('--keepaspect-window=no'));
});

test('arguments: the window title is only the Window name, never a file name, in every Linux variant', () => {
  for (const f of LINUX_FRAMES) {
    const plan = windowPlan({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: f } });
    for (const k of [plan.first, plan.fallback]) {
      const args = buildArgs({ ipcPath: 'p', title: 'My $show', x11: k.x11, framed: k.frameAtFree, keepAspect: plan.keepAspect });
      assert.deepStrictEqual(args.filter((a) => a.startsWith('--title=')), ['--title=My $$show'], f);
      assert.ok(args.includes('--force-media-title=Stage'), f);
    }
  }
});

test('arguments: --border and --keepaspect-window are in every mpv Vault runs (0.35 on), so an older mpv keeps them', () => {
  for (const n of ['border', 'keepaspect-window']) assert.ok(!Object.prototype.hasOwnProperty.call(NEWER_OPTIONS, n), n);
  // An mpv 0.35 option list: none of the newer options.
  const known = new Set(FIXED.map((a) => /^--(?:no-)?([a-z0-9-]+)/.exec(a)[1]).filter((n) => !(n in NEWER_OPTIONS)));
  const args = buildArgs({ ipcPath: 'p', framed: true, keepAspect: true, mpvOptions: known });
  assert.ok(args.includes('--border=yes') && args.includes('--keepaspect-window=yes'));
  assert.ok(fitOptions(args, known).includes('--keepaspect-window=yes'));
});

/* ── xprop: a frame without a title bar ─────────────────────────────────── */

test('x11-hints: xprop gets fixed arguments and mpv\'s window id; no xprop or no window is said, never thrown', async () => {
  assert.deepStrictEqual(borderOnlyArgs(0x3a00007), ['-id', String(0x3a00007), '-f', '_MOTIF_WM_HINTS', '32c', '-set', '_MOTIF_WM_HINTS', '2, 0, 2, 0, 0']);
  const calls = [];
  const ok = await setBorderOnly({ wid: 42, env: { DISPLAY: ':0' }, run: (file, args, opts, cb) => { calls.push([file, args, opts.env.DISPLAY]); cb(null); } });
  assert.strictEqual(ok, 'ok');
  assert.deepStrictEqual(calls, [['xprop', borderOnlyArgs(42), ':0']]);
  const missing = await setBorderOnly({ wid: 42, run: (f, a, o, cb) => cb(Object.assign(new Error('nope'), { code: 'ENOENT' })) });
  assert.strictEqual(missing, 'no-xprop');
  assert.strictEqual(await setBorderOnly({ wid: 42, run: (f, a, o, cb) => cb(new Error('BadWindow')) }), 'failed');
  assert.strictEqual(await setBorderOnly({ wid: 42, run: () => { throw new Error('spawn'); } }), 'failed');
  for (const wid of [null, 0, -1, 1.5, '42', NaN]) {
    assert.strictEqual(await setBorderOnly({ wid, run: () => { throw new Error('must not run'); } }), 'no-window', String(wid));
  }
});

/* ── mpv's host: what it follows and binds, per platform ────────────────── */

function recordingMpv(pipePath, pid) {
  const cmds = [];
  const socks = new Set();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        cmds.push(msg.command);
        const c = msg.command;
        let ans = { error: 'success', data: null };
        if (c[0] === 'get_property' && c[1] === 'pid') ans = { error: 'success', data: pid };
        else if (c[0] === 'get_property') ans = { error: 'property unavailable' };
        sock.write(`${JSON.stringify({ request_id: msg.request_id, ...ans })}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(pipePath, () => resolve({
    cmds,
    close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
  })));
}

function pipePathFor(tag) {
  const id = `${process.pid}-${tag}-${Date.now()}`;
  if (process.platform === 'win32') return { path: `\\\\.\\pipe\\vault-test-${id}`, cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsf-'));
  return { path: path.join(dir, 's'), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

async function hostCommands(platform) {
  const ipc = pipePathFor(platform);
  const srv = await recordingMpv(ipc.path, 7001);
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.pid = 7001;
  child.kill = () => { if (child.exitCode !== null) return; child.exitCode = 0; child.emit('exit', 0); };
  const host = createMpvHost({ platform, spawnFn: () => child, makeIpc: () => ({ path: ipc.path, cleanup: () => {} }), watch: () => null });
  try {
    assert.deepStrictEqual(await host.start('mpv', () => []), { ok: true });
    return srv.cmds.slice();
  } finally {
    host.kill();
    await srv.close();
    ipc.cleanup();
  }
}

test('host: Windows follows and binds exactly what it did; Linux adds the video shape, full screen and the wheel', async () => {
  const observed = (cmds) => cmds.filter((c) => c[0] === 'observe_property').map((c) => c[2]);
  const binds = (cmds) => cmds.filter((c) => c[0] === 'keybind').map((c) => [c[1], c[2]]);
  const win = await hostCommands('win32');
  assert.deepStrictEqual(observed(win), ['time-pos', 'duration', 'pause', 'eof-reached', 'idle-active', 'osd-width', 'osd-height', 'window-maximized']);
  assert.deepStrictEqual(observed(win), OBSERVED);
  assert.deepStrictEqual(binds(win), [['CLOSE_WIN', 'script-message vault-stage close'], ['MBTN_LEFT_DBL', 'cycle window-maximized']]);
  const lin = await hostCommands('linux');
  assert.deepStrictEqual(observed(lin), [...OBSERVED, ...OBSERVED_LINUX]);
  assert.deepStrictEqual(OBSERVED_LINUX, ['video-out-params', 'fullscreen']);
  assert.deepStrictEqual(binds(lin), [['CLOSE_WIN', 'script-message vault-stage close'], ['MBTN_LEFT_DBL', 'cycle window-maximized'], ...WHEEL_BINDINGS]);
  const mac = await hostCommands('darwin');
  assert.deepStrictEqual(observed(mac), OBSERVED);
  assert.deepStrictEqual(binds(mac), binds(win));
});

/* ── The routes: opening and the size menu ──────────────────────────────── */

function fakeHostFactory(log, { hwnd = 0x3a00007, props = {} } = {}) {
  return (opts) => {
    let alive = false;
    const host = {
      opts,
      async start(exe, argsFor, o = {}) {
        log.push({ start: exe, args: argsFor('/tmp/vault-stage-test/mpv.sock'), fallback: o.fallbackArgsFor ? o.fallbackArgsFor('/tmp/vault-stage-test/mpv.sock') : null });
        alive = true;
        return { ok: true };
      },
      alive: () => alive,
      command: async (cmd) => { log.push({ cmd }); return null; },
      set: async (name, value) => { log.push({ set: [name, value] }); return null; },
      get: async (name) => {
        if (Object.prototype.hasOwnProperty.call(props, name)) return props[name];
        return name === 'display-width' ? 1920 : name === 'display-height' ? 1080 : null;
      },
      loadfile: async () => ({ playlist_entry_id: 1 }),
      quit: () => { alive = false; setImmediate(() => opts.onExit({ code: 0, asked: true })); },
      kill: () => { alive = false; },
      get pid() { return 1; },
      get hwnd() { return hwnd; },
    };
    log.host = host;
    return host;
  };
}

async function withRouter({ platform, env = {}, props = {}, hwnd = 0x3a00007 }, fn) {
  const log = [];
  const borderOnlyCalls = [];
  const router = buildRouter({
    hostFactory: fakeHostFactory(log, { hwnd, props }), platform, checkWindowMs: 300, env: { VAULT_STAGE_MUTE: '1', ...env },
    find: async () => ({ found: true, path: platform === 'win32' ? 'C:\\mpv\\mpv.exe' : '/usr/bin/mpv', version: 'v0.41.0', source: 'default' }),
    lib: { isLocked: () => false },
    borderOnly: async (o) => { borderOnlyCalls.push(o.wid); return 'ok'; },
    fitTiming: { settleMs: 5 },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const at = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(at + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  // mpv's events, as the host would pass them on.
  const emit = (msg) => log.host.opts.onEvent(msg);
  const prop = (name, data) => emit({ event: 'property-change', name, data });
  try {
    await fn({ log, post, emit, prop, borderOnlyCalls, state: async () => (await fetch(at + '/api/stage/state')).json() });
  } finally {
    try { router._runner.close(); } catch {}
    await new Promise((resolve) => srv.close(resolve));
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const borderSets = (log) => log.filter((l) => l.set && l.set[0] === 'border').map((l) => l.set[1]);
const geometrySets = (log) => log.filter((l) => l.set && l.set[0] === 'geometry').map((l) => l.set[1]);

test('Linux, Wayland, default: Free size opens as mpv\'s own Wayland window, bare and shape-kept; XWayland with the frame as the fallback', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: WAYLAND }, async ({ log, post, state }) => {
    assert.strictEqual((await post('/api/stage/open', {})).status, 200);
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=no') && start.args.includes('--gpu-context=wayland') && !start.args.includes('--gpu-context=x11egl'));
    assert.ok(start.args.includes('--keepaspect-window=yes'));
    assert.ok(start.fallback.includes('--border=yes') && start.fallback.includes('--gpu-context=x11egl') && start.fallback.includes('--keepaspect-window=yes'));
    assert.strictEqual((await state()).size, 'free');
    // A preset: mpv's own Wayland window has no frame to take off; just the size.
    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await tick();
    assert.deepStrictEqual(borderSets(log), []);
    assert.deepStrictEqual(geometrySets(log), ['1920x1080']);
    assert.strictEqual((await state()).size, '1080p');
  });
});

test('Linux, titled: Free size opens framed on XWayland; a preset takes the frame off before sizing; Free puts it back at the free size', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: 'titled' } }, async ({ log, post, state, prop, borderOnlyCalls }) => {
    assert.strictEqual((await post('/api/stage/open', {})).status, 200);
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=yes') && start.args.includes('--gpu-context=x11egl') && start.args.includes('--keepaspect-window=yes'));
    assert.ok(start.fallback.includes('--border=no') && !start.fallback.includes('--gpu-context=x11egl'));
    // mpv reports its window and a 16:9 video; it is in shape.
    prop('osd-width', 1280); prop('osd-height', 720);
    prop('video-out-params', { dw: 1920, dh: 1080, rotate: 0 });
    await tick();
    assert.deepStrictEqual(geometrySets(log), ['1280x720'], 'in shape: only mpv geometry kept in step');

    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await tick();
    const i = log.findIndex((l) => l.set && l.set[0] === 'border');
    const g = log.findIndex((l) => l.set && l.set[0] === 'geometry' && l.set[1] === '1920x1080');
    assert.deepStrictEqual(log[i].set, ['border', false]);
    assert.ok(i >= 0 && g > i, 'the frame goes before the picture is sized');
    assert.strictEqual((await state()).size, '1080p', 'the menu ticks the size chosen last');

    await post('/api/stage/cmd', { type: 'size', preset: 'free' });
    await tick();
    assert.deepStrictEqual(borderSets(log), [false, true]);
    assert.deepStrictEqual(geometrySets(log).slice(-1), ['1280x720'], 'back to the size Free size had');
    assert.strictEqual((await state()).size, 'free');
    assert.deepStrictEqual(borderOnlyCalls, [], 'titled never asks for border only');
  });
});

test('Linux, Free size: a window in the wrong shape is put right, the size is remembered for the next open', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: WAYLAND }, async ({ log, post, prop }) => {
    await post('/api/stage/open', {});
    prop('osd-width', 960); prop('osd-height', 540);
    prop('video-out-params', { dw: 1080, dh: 1080, rotate: 0 });     // a square video
    await tick(60);
    const g = geometrySets(log);
    assert.strictEqual(g.length, 1);
    const [w, h] = g[0].split('x').map(Number);
    assert.ok(Math.abs(w - h) <= 1 && Math.abs(w * h - 960 * 540) / (960 * 540) < 0.02, g[0]);
    prop('osd-width', w); prop('osd-height', h);
    await tick(60);
    assert.deepStrictEqual(appSettings.all().stageWindow.linuxFreeSize, { w, h });
  });
  // The next open starts at that size.
  await withRouter({ platform: 'linux', env: WAYLAND }, async ({ log, post }) => {
    await post('/api/stage/open', {});
    const { w, h } = appSettings.all().stageWindow.linuxFreeSize;
    assert.ok(log.find((l) => l.start).args.includes(`--geometry=${w}x${h}`));
  });
});

test('Linux: a maximised window comes out of it before a preset size is set', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: WAYLAND }, async ({ log, post, prop }) => {
    await post('/api/stage/open', {});
    prop('window-maximized', true);
    await post('/api/stage/cmd', { type: 'size', preset: '720p' });
    await tick();
    const m = log.findIndex((l) => l.set && l.set[0] === 'window-maximized');
    const g = log.findIndex((l) => l.set && l.set[0] === 'geometry');
    assert.deepStrictEqual(log[m].set, ['window-maximized', false]);
    assert.ok(g > m);
    assert.deepStrictEqual(geometrySets(log), ['1280x720']);
  });
});

test('Linux: the wheel over the picture steps the size at Free size, not at a preset', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: WAYLAND }, async ({ log, post, emit, prop }) => {
    await post('/api/stage/open', {});
    prop('osd-width', 1280); prop('osd-height', 720);
    prop('video-out-params', { dw: 1920, dh: 1080 });
    await tick();
    emit({ event: 'client-message', args: ['vault-stage', 'grow'] });
    await tick();
    assert.deepStrictEqual(geometrySets(log), ['1280x720', '1408x792']);
    await post('/api/stage/cmd', { type: 'size', preset: '720p' });
    await tick();
    const n = geometrySets(log).length;
    emit({ event: 'client-message', args: ['vault-stage', 'shrink'] });
    await tick();
    assert.strictEqual(geometrySets(log).length, n);
  });
});

test('Linux, border: asks for a frame without a title bar with mpv\'s window id, at Free size only', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: 'border' } }, async ({ log, post, borderOnlyCalls }) => {
    await post('/api/stage/open', {});
    assert.ok(log.find((l) => l.start).args.includes('--border=yes'));
    await tick(400);
    assert.deepStrictEqual(borderOnlyCalls, [0x3a00007]);
    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await tick(400);
    assert.deepStrictEqual(borderOnlyCalls, [0x3a00007]);
    await post('/api/stage/cmd', { type: 'size', preset: 'free' });
    await tick(400);
    assert.deepStrictEqual(borderOnlyCalls, [0x3a00007, 0x3a00007], 'again after mpv puts its frame back');
  });
});

test('Linux, none: bare at Free size too, the size menu never touches border', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: 'none' } }, async ({ log, post }) => {
    await post('/api/stage/open', {});
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=no') && start.args.includes('--gpu-context=x11egl') && start.args.includes('--keepaspect-window=yes'));
    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await post('/api/stage/cmd', { type: 'size', preset: 'free' });
    await tick();
    assert.deepStrictEqual(borderSets(log), []);
  });
});

test('Linux: a preset as the open size starts bare; Free then frames it (an X11 session)', async () => {
  appSettings.set({ stage: { openSize: '720p' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: { DISPLAY: ':0' } }, async ({ log, post, state }) => {
    await post('/api/stage/open', {});
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=no') && !start.args.includes('--border=yes'));
    assert.ok(start.args.includes('--geometry=1280x720'));
    assert.strictEqual(start.fallback, null, 'an X11 session has no second command line');
    assert.strictEqual((await state()).size, '720p');
    await post('/api/stage/cmd', { type: 'size', preset: 'free' });
    await tick();
    assert.deepStrictEqual(borderSets(log), [true]);
  });
  appSettings.set({ stage: { openSize: 'free' } });
});

test('Linux quiet test window: XWayland, bare, the size menu never frames it, nothing fitted', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_TEST_QUIET: '1' } }, async ({ log, post, prop }) => {
    await post('/api/stage/open', {});
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=no') && start.args.includes('--gpu-context=x11egl'));
    prop('osd-width', 1000); prop('osd-height', 1000);
    prop('video-out-params', { dw: 1920, dh: 1080 });
    await tick();
    assert.deepStrictEqual(geometrySets(log), []);
    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await post('/api/stage/cmd', { type: 'size', preset: 'free' });
    await tick();
    assert.deepStrictEqual(borderSets(log), []);
  });
});

test('Windows: bare as before, never shape-fitted, the size menu never touches border, the size comes from the window watcher only', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'win32', env: { VAULT_STAGE_LINUX_FRAME: 'titled' } }, async ({ log, post, state, prop, emit }) => {
    await post('/api/stage/open', {});
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=no') && !start.args.includes('--border=yes'));
    assert.ok(start.args.includes('--keepaspect-window=no'));
    assert.strictEqual(start.fallback, null);
    prop('osd-width', 1000); prop('osd-height', 1000);
    prop('video-out-params', { dw: 1920, dh: 1080 });
    emit({ event: 'client-message', args: ['vault-stage', 'grow'] });
    await tick();
    assert.deepStrictEqual(geometrySets(log), []);
    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await tick();
    assert.deepStrictEqual(borderSets(log), []);
    // No watcher line yet: 'free', as it always said.
    assert.strictEqual((await state()).size, 'free');
  });
});

/* ── The window mpv really made ─────────────────────────────────────────── */

test('arguments: mpv\'s own Wayland window pins the Wayland drawing context; X11 pins x11egl; Windows neither', () => {
  assert.strictEqual(WAYLAND_CONTEXT, '--gpu-context=wayland');
  const plan = windowPlan({ platform: 'linux', env: WAYLAND });
  const own = buildArgs({ ipcPath: 'p', x11: plan.first.x11, wayland: plan.first.wayland, pinWayland: plan.first.pin === true });
  // Only the Free size window chosen over XWayland is pinned. With no XWayland to fall to, as the
  // fallback of an XWayland launch, or with the switch off, mpv picks its own context (Vulkan included).
  const unpinned = [
    windowPlan({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } }).first,
    windowPlan({ platform: 'linux', env: WAYLAND, size: '1080p' }).fallback,
    windowPlan({ platform: 'linux', env: WAYLAND, xwayland: false }).first,
  ];
  for (const k of unpinned) {
    assert.strictEqual(k.wayland, true);
    const a = buildArgs({ ipcPath: 'p', x11: k.x11, wayland: k.wayland, pinWayland: k.pin === true });
    assert.deepStrictEqual(a.filter((x) => x.startsWith('--gpu-context=')), [], JSON.stringify(k));
  }
  assert.deepStrictEqual(own.filter((a) => a.startsWith('--gpu-context=')), ['--gpu-context=wayland']);
  const x = buildArgs({ ipcPath: 'p', x11: plan.fallback.x11, wayland: plan.fallback.wayland });
  assert.deepStrictEqual(x.filter((a) => a.startsWith('--gpu-context=')), ['--gpu-context=x11egl']);
  assert.ok(!buildArgs({ ipcPath: 'p' }).some((a) => a.startsWith('--gpu-context=')));
  assert.ok(!own.some((a) => a.startsWith('--vo=')), 'the video output stays mpv\'s choice');
});

test('windowSystemOf: the drawing context first, then the video output, then a window id; else unknown', () => {
  assert.strictEqual(windowSystemOf({ context: 'wayland', vo: 'gpu-next' }), 'wayland');
  assert.strictEqual(windowSystemOf({ context: 'waylandvk' }), 'wayland');
  assert.strictEqual(windowSystemOf({ context: 'x11egl', vo: 'gpu', windowId: 5 }), 'x11');
  assert.strictEqual(windowSystemOf({ context: 'x11vk' }), 'x11');
  assert.strictEqual(windowSystemOf({ context: 'glx' }), 'x11');
  assert.strictEqual(windowSystemOf({ vo: 'wlshm' }), 'wayland');
  assert.strictEqual(windowSystemOf({ vo: 'dmabuf-wayland' }), 'wayland');
  for (const vo of ['x11', 'xv', 'vdpau', 'vaapi']) assert.strictEqual(windowSystemOf({ vo }), 'x11', vo);
  // mpv 0.36/0.37 (no current-gpu-context): only X11 windows have a window id.
  assert.strictEqual(windowSystemOf({ vo: 'gpu', windowId: 0x3a00007 }), 'x11');
  assert.strictEqual(windowSystemOf({ vo: 'gpu' }), null);
  assert.strictEqual(windowSystemOf({ vo: 'sdl' }), null);
  assert.strictEqual(windowSystemOf({}), null);
  assert.strictEqual(windowSystemOf({ vo: 'gpu', windowId: -1 }), null);
});

test('actualKind: the other kind than asked gets that kind\'s frame; the same kind or unknown keeps the plan', () => {
  for (const f of LINUX_FRAMES) {
    const plan = windowPlan({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: f } });
    const own = plan.first.wayland ? plan.first : plan.fallback;
    const x = plan.first.wayland ? plan.fallback : plan.first;
    // Asked for mpv's own Wayland window, got XWayland: framed (unless none), so it can be sized.
    assert.deepStrictEqual(actualKind(plan, own, 'x11'), { x11: true, wayland: false, frameAtFree: f !== 'none', borderOnly: f === 'border' }, f);
    // Asked for XWayland, got Wayland: never framed.
    assert.deepStrictEqual(actualKind(plan, x, 'wayland'), { x11: false, wayland: true, frameAtFree: false, borderOnly: false }, f);
    assert.strictEqual(actualKind(plan, own, 'wayland'), own);
    assert.strictEqual(actualKind(plan, own, null), own);
    assert.strictEqual(actualKind(plan, x, 'x11'), x);
  }
  // An X11 session never turns into Wayland.
  const x11only = windowPlan({ platform: 'linux', env: { DISPLAY: ':0' } });
  assert.strictEqual(actualKind(x11only, x11only.first, 'wayland'), x11only.first);
});

test('Linux, default: mpv drew its own Wayland window through XWayland after all: the frame goes on so it can be sized', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  const warn = console.warn; const said = [];
  console.warn = (...a) => said.push(a.join(' '));
  try {
    await withRouter({ platform: 'linux', env: WAYLAND, props: { 'current-vo': 'gpu-next', 'current-gpu-context': 'x11egl' } }, async ({ log, post, state }) => {
      await post('/api/stage/open', {});
      await tick(80);
      assert.deepStrictEqual(borderSets(log), [true]);
      assert.ok(said.some((l) => /an X11 window \(gpu-next, x11egl\)/.test(l)), said.join('|'));
      // The size menu now treats it as the framed XWayland window.
      await post('/api/stage/cmd', { type: 'size', preset: '720p' });
      await tick();
      assert.deepStrictEqual(borderSets(log), [true, false]);
      const st = await state();
      assert.strictEqual(st.mpv.display.placement, true);
    });
  } finally { console.warn = warn; }
});

test('Linux, default: an older mpv (no context property) that made an X11 window is found by its window id', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  const warn = console.warn; console.warn = () => {};
  try {
    await withRouter({ platform: 'linux', env: WAYLAND, props: { 'current-vo': 'gpu', 'window-id': 0x3a00007 } }, async ({ log, post }) => {
      await post('/api/stage/open', {});
      await tick(80);
      assert.deepStrictEqual(borderSets(log), [true]);
    });
  } finally { console.warn = warn; }
});

test('Linux, default: a real Wayland window, or one that cannot be told, is left as planned', async () => {
  for (const props of [{ 'current-vo': 'gpu-next', 'current-gpu-context': 'wayland' }, { 'current-vo': 'wlshm' }, { 'current-vo': 'sdl' }, {}]) {
    appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
    await withRouter({ platform: 'linux', env: WAYLAND, props, hwnd: null }, async ({ log, post }) => {
      await post('/api/stage/open', {});
      await tick(props['current-vo'] ? 80 : 400);
      assert.deepStrictEqual(borderSets(log), [], JSON.stringify(props));
    });
  }
});

test('Linux, titled: an XWayland window that came out as Wayland loses the frame (mpv\'s own edges need none)', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  const warn = console.warn; console.warn = () => {};
  try {
    await withRouter({ platform: 'linux', env: { ...WAYLAND, VAULT_STAGE_LINUX_FRAME: 'titled' }, props: { 'current-vo': 'wlshm' } }, async ({ log, post }) => {
      await post('/api/stage/open', {});
      assert.ok(log.find((l) => l.start).args.includes('--border=yes'));
      await tick(80);
      assert.deepStrictEqual(borderSets(log), [false]);
    });
  } finally { console.warn = warn; }
});

/* ── What Settings › Stage is told ──────────────────────────────────────── */

test('status: on Wayland, the plan shown is the window that opens at the size Stage opens at', async () => {
  const display = async (env, stage) => {
    appSettings.set({ stage: { openSize: 'free', xwayland: true, ...stage }, stageWindow: null });
    let d = null;
    await withRouter({ platform: 'linux', env }, async ({ state }) => { d = (await state()).mpv.display; });
    return d;
  };
  // Default, Free size: mpv's own Wayland window, so not placed (the warning in Settings shows).
  let d = await display(WAYLAND, {});
  assert.deepStrictEqual([d.wayland, d.xwayland, d.x11, d.placement, d.freeOwnWindow, d.frame], [true, true, false, false, true, 'wayland']);
  // A fixed open size: XWayland, placed.
  d = await display(WAYLAND, { openSize: '1080p' });
  assert.deepStrictEqual([d.x11, d.placement, d.freeOwnWindow], [true, true, true]);
  // titled: XWayland at Free size too.
  d = await display({ ...WAYLAND, VAULT_STAGE_LINUX_FRAME: 'titled' }, {});
  assert.deepStrictEqual([d.x11, d.placement, d.freeOwnWindow, d.frame], [true, true, false, 'titled']);
  // XWayland off: own window everywhere; the switch is not what moves Free size.
  d = await display(WAYLAND, { xwayland: false, openSize: '720p' });
  assert.deepStrictEqual([d.x11, d.placement, d.freeOwnWindow], [false, false, false]);
  // An X11 session: placed.
  d = await display({ DISPLAY: ':0' }, {});
  assert.deepStrictEqual([d.wayland, d.placement], [false, true]);
  appSettings.set({ stage: { openSize: 'free', xwayland: true } });
});

test('status: Windows reports the display plan exactly as before', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'win32', env: WAYLAND }, async ({ state }) => {
    assert.deepStrictEqual((await state()).mpv.display, { wayland: false, xwayland: false, x11: false, placement: true, forced: false });
  });
});
