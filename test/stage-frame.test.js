/**
 * The Stage window's frame off Windows (mpv-args.js framedWindow).
 *
 * On X11 and XWayland a borderless window has no edges to drag: the window
 * manager's edges are its decorations, and mpv only starts moves. So on
 * Linux a Free size Stage window has the desktop's frame, and a preset size
 * keeps the bare picture. Windows keeps exactly the command line it had.
 *
 * No real mpv runs here: the routes get a fake host. Runs on every OS: the
 * platform is passed in.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stage-frame-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
delete process.env.VAULT_DB_PASSWORD;

const express = require('express');
const { buildArgs, framedWindow, fitOptions, FIXED, NEWER_OPTIONS } = require('../lib/stage/mpv-args');
const appSettings = require('../lib/app-settings');
const { buildRouter } = require('../server/stage-routes');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

/* ── Which windows get the frame ────────────────────────────────────────── */

test('framedWindow: Linux and other X11/Wayland systems at Free size only; never Windows or macOS', () => {
  for (const p of ['linux', 'freebsd', 'openbsd']) {
    assert.strictEqual(framedWindow({ platform: p, size: 'free' }), true, p);
    for (const s of ['720p', '1080p', '1440p']) assert.strictEqual(framedWindow({ platform: p, size: s }), false, `${p} ${s}`);
  }
  for (const p of ['win32', 'darwin']) {
    for (const s of ['free', '720p', '1080p', '1440p']) assert.strictEqual(framedWindow({ platform: p, size: s }), false, `${p} ${s}`);
  }
});

/* ── The command line ───────────────────────────────────────────────────── */

// What Windows has always been given (3.10), byte for byte.
const WINDOWS_ARGS = ['--no-config', '--idle=yes', '--force-window=yes', '--keep-open=yes', '--force-media-title=Stage', '--media-controls=no', '--save-position-on-quit=no', '--resume-playback=no', '--write-filename-in-watch-later-config=no', '--terminal=no', '--msg-level=all=no', '--ytdl=no', '--load-scripts=no', '--osc=no', '--load-stats-overlay=no', '--load-console=no', '--load-select=no', '--load-commands=no', '--load-positioning=no', '--load-context-menu=no', '--load-auto-profiles=no', '--access-references=no', '--load-unsafe-playlists=no', '--autocreate-playlist=no', '--directory-mode=ignore', '--cookies=no', '--demuxer-lavf-o=protocol_whitelist=[file]', '--stream-lavf-o=protocol_whitelist=[file]', '--sub-auto=no', '--audio-file-auto=no', '--cover-art-auto=no', '--sid=no', '--audio-display=no', '--input-default-bindings=no', '--input-builtin-bindings=no', '--input-media-keys=no', '--border=no', '--window-dragging=yes', '--window-corners=donotround', '--keepaspect-window=no', '--auto-window-resize=no', '--focus-on=never', '--ontop=no', '--background-color=#000000', '--osd-level=0', '--osd-bar=no', '--cursor-autohide-fs-only=no', '--prefetch-playlist=yes', '--gapless-audio=weak', '--image-display-duration=inf', '--hwdec=auto-copy-safe', '--input-ipc-server=\\\\.\\pipe\\vault-stage-abc', '--title=Vault Stage', '--cursor-autohide=1000', '--volume=80', '--mute=no', '--geometry=1280x720+100+50'];

test('arguments: Windows gets exactly what it had (no frame option, or framed: false)', () => {
  const o = { ipcPath: '\\\\.\\pipe\\vault-stage-abc', title: 'Vault Stage', bounds: { x: 100, y: 50, w: 1280, h: 720 }, cursorSeconds: 1, volume: 0.8, muted: false, hwdec: true, mpvVersion: 'v0.41.0' };
  assert.deepStrictEqual(buildArgs(o), WINDOWS_ARGS);
  assert.deepStrictEqual(buildArgs({ ...o, framed: framedWindow({ platform: 'win32', size: 'free' }) }), WINDOWS_ARGS);
  assert.deepStrictEqual(buildArgs({ ...o, framed: false }), WINDOWS_ARGS);
});

test('arguments: framed swaps --border=no for --border=yes in its place, nothing else; a quiet window stays bare', () => {
  const bare = buildArgs({ ipcPath: 'p', x11: true });
  const framed = buildArgs({ ipcPath: 'p', x11: true, framed: true });
  assert.strictEqual(framed.length, bare.length);
  const diff = framed.map((a, i) => (a === bare[i] ? null : [bare[i], a])).filter(Boolean);
  assert.deepStrictEqual(diff, [['--border=no', '--border=yes']]);
  // Moving by the picture stays; the window still never takes focus or stays on top.
  for (const a of ['--window-dragging=yes', '--focus-on=never', '--ontop=no', '--gpu-context=x11egl']) assert.ok(framed.includes(a), a);
  // The quiet test window: a title bar would be kept on screen by the window manager.
  const quiet = buildArgs({ ipcPath: 'p', framed: true, quiet: true });
  assert.ok(quiet.includes('--border=no') && !quiet.includes('--border=yes'));
  // FIXED itself is never changed.
  assert.ok(FIXED.includes('--border=no') && !FIXED.includes('--border=yes'));
});

test('arguments: --border is in every mpv Vault runs (0.35 on), so an older mpv keeps it', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(NEWER_OPTIONS, 'border'));
  // An mpv 0.35 option list: none of the newer options, border there.
  const known = new Set(FIXED.map((a) => /^--(?:no-)?([a-z0-9-]+)/.exec(a)[1]).filter((n) => !(n in NEWER_OPTIONS)));
  const framed = FIXED.map((a) => (a === '--border=no' ? '--border=yes' : a));
  assert.ok(fitOptions(framed, known).includes('--border=yes'));
  assert.ok(buildArgs({ ipcPath: 'p', framed: true, mpvOptions: known }).includes('--border=yes'));
});

/* ── The routes: opening and the size menu ──────────────────────────────── */

function fakeHostFactory(log) {
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
      get: async () => null,
      loadfile: async () => ({ playlist_entry_id: 1 }),
      quit: () => { alive = false; setImmediate(() => opts.onExit({ code: 0, asked: true })); },
      kill: () => { alive = false; },
      get pid() { return 1; },
    };
    log.host = host;
    return host;
  };
}

async function withRouter({ platform, env = {} }, fn) {
  const log = [];
  const router = buildRouter({
    hostFactory: fakeHostFactory(log), platform, env: { VAULT_STAGE_MUTE: '1', ...env },
    find: async () => ({ found: true, path: platform === 'win32' ? 'C:\\mpv\\mpv.exe' : '/usr/bin/mpv', version: 'v0.41.0', source: 'default' }),
    lib: { isLocked: () => false },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const at = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, body) => fetch(at + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await fn({ log, post, state: async () => (await fetch(at + '/api/stage/state')).json() });
  } finally {
    try { router._runner.close(); } catch {}
    await new Promise((resolve) => srv.close(resolve));
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30));
const borderSets = (log) => log.filter((l) => l.set && l.set[0] === 'border').map((l) => l.set[1]);

test('Linux: Free size opens with the frame; a preset takes it off before sizing; Free puts it back', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  // A Wayland desktop with XWayland: both command lines (X11, and mpv's own Wayland window) framed.
  await withRouter({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }, async ({ log, post, state }) => {
    assert.strictEqual((await post('/api/stage/open', {})).status, 200);
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=yes') && start.args.includes('--gpu-context=x11egl'));
    assert.ok(start.fallback.includes('--border=yes') && !start.fallback.includes('--gpu-context=x11egl'));
    assert.strictEqual((await state()).size, 'free');

    assert.strictEqual((await post('/api/stage/cmd', { type: 'size', preset: '1080p' })).status, 200);
    await tick();
    const i = log.findIndex((l) => l.set && l.set[0] === 'border');
    const g = log.findIndex((l) => l.set && l.set[0] === 'geometry');
    assert.deepStrictEqual(log[i].set, ['border', false]);
    assert.deepStrictEqual(log[g].set, ['geometry', '1920x1080']);
    assert.ok(i < g, 'the frame goes before the picture is sized');
    assert.strictEqual((await state()).size, '1080p', 'the menu ticks the size chosen last');

    await post('/api/stage/cmd', { type: 'size', preset: 'free' });
    await tick();
    assert.deepStrictEqual(borderSets(log), [false, true]);
    assert.strictEqual((await state()).size, 'free');
  });
});

test('Linux: a preset as the open size starts bare; an X11 session the same', async () => {
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

test('Linux quiet test window: bare, and the size menu never frames it', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'linux', env: { DISPLAY: ':0', VAULT_STAGE_TEST_QUIET: '1' } }, async ({ log, post }) => {
    await post('/api/stage/open', {});
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=no'));
    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await post('/api/stage/cmd', { type: 'size', preset: 'free' });
    await tick();
    assert.deepStrictEqual(borderSets(log), []);
  });
});

test('Windows: bare as before, the size menu never touches border, the size comes from the window watcher only', async () => {
  appSettings.set({ stage: { openSize: 'free' }, stageWindow: null });
  await withRouter({ platform: 'win32' }, async ({ log, post, state }) => {
    await post('/api/stage/open', {});
    const start = log.find((l) => l.start);
    assert.ok(start.args.includes('--border=no') && !start.args.includes('--border=yes'));
    await post('/api/stage/cmd', { type: 'size', preset: '1080p' });
    await tick();
    assert.deepStrictEqual(borderSets(log), []);
    // No watcher line yet: 'free', as it always said.
    assert.strictEqual((await state()).size, 'free');
  });
});
