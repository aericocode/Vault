/**
 * Stage off Windows (LINUX_SPEC WP5, and the macOS paths from 5b):
 *
 *  - mpv-args.js displayPlan   a Wayland desktop with XWayland draws through
 *                              X11 (placement and on-top work there); without
 *                              XWayland, or with the setting off, the desktop
 *                              places the window; VAULT_STAGE_XWAYLAND wins
 *  - mpv-args.js fitOptions    options newer than a distribution's mpv are
 *                              left out (or take their old name), nothing else
 *  - mpv-find.js               Linux and macOS install folders; a Flatpak or
 *                              Snap mpv is reported, never run; the option list
 *  - mpv-host.js               an mpv that ends before its pipe answers with
 *                              the X11 window is started once more without it
 *  - mpv-window.js             nothing to watch off Windows, quietly
 *
 * No real mpv runs here. Runs on every OS: the platform is passed in.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { buildArgs, displayPlan, fitOptions, FIXED, NEWER_OPTIONS, X11_CONTEXT } = require('../lib/stage/mpv-args');
const find = require('../lib/stage/mpv-find');
const { createMpvHost } = require('../lib/stage/mpv-host');
const { watchWindow } = require('../lib/stage/mpv-window');
const S = require('../lib/stage/settings');

// mpv-ipc's retry timers are unref'd; hold the loop as the server would (see stage-mpv.test.js).
const holdLoop = setInterval(() => {}, 60 * 60 * 1000);
test.after(() => clearInterval(holdLoop));

/* ── The window on Linux desktops ───────────────────────────────────────── */

test('displayPlan: Wayland with XWayland draws through X11; without it, or turned off, the desktop places the window', () => {
  const plan = (platform, env, xwayland) => displayPlan({ platform, env, xwayland });
  // GNOME or KDE on Wayland (XWayland is there unless turned off): X11, placed, on top.
  assert.deepStrictEqual(plan('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }),
    { wayland: true, xwayland: true, x11: true, placement: true, forced: false });
  // The setting off: mpv's own Wayland window.
  assert.deepStrictEqual(plan('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, false),
    { wayland: true, xwayland: true, x11: false, placement: false, forced: false });
  // No XWayland: Wayland, and placement is up to the desktop.
  assert.deepStrictEqual(plan('linux', { WAYLAND_DISPLAY: 'wayland-0' }),
    { wayland: true, xwayland: false, x11: false, placement: false, forced: false });
  // An X11 session: nothing changes.
  assert.deepStrictEqual(plan('linux', { DISPLAY: ':0' }),
    { wayland: false, xwayland: false, x11: false, placement: true, forced: false });
  // Windows and macOS: nothing changes, whatever the environment says.
  for (const p of ['win32', 'darwin']) {
    assert.strictEqual(plan(p, { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).x11, false, p);
    assert.strictEqual(plan(p, { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).placement, true, p);
  }
  // VAULT_STAGE_XWAYLAND overrides the setting both ways; anything else is ignored.
  const env = (v) => ({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0', VAULT_STAGE_XWAYLAND: v });
  assert.deepStrictEqual([plan('linux', env('0'), true).x11, plan('linux', env('0'), true).forced], [false, true]);
  assert.deepStrictEqual([plan('linux', env('1'), false).x11, plan('linux', env('1'), false).forced], [true, true]);
  assert.strictEqual(plan('linux', env('yes'), false).x11, false);
  assert.strictEqual(plan('linux', env('yes'), false).forced, false);
  // Forced on without XWayland: still Wayland (there is no X server to draw on).
  assert.strictEqual(plan('linux', { WAYLAND_DISPLAY: 'w', VAULT_STAGE_XWAYLAND: '1' }).x11, false);
});

test('arguments: the X11 context only when asked, once, after the fixed options', () => {
  const args = buildArgs({ ipcPath: '/tmp/vault-stage-x/mpv.sock', x11: true });
  assert.strictEqual(X11_CONTEXT, '--gpu-context=x11egl');
  assert.strictEqual(args.filter((a) => a.startsWith('--gpu-context=')).length, 1);
  assert.ok(args.includes('--gpu-context=x11egl'));
  assert.ok(!buildArgs({ ipcPath: 'p' }).some((a) => a.startsWith('--gpu-context=')));
  assert.ok(!buildArgs({ ipcPath: 'p', x11: false }).some((a) => a.startsWith('--gpu-context=')));
  // Placement and on-top stay as they are: XWayland honours them.
  for (const a of ['--border=no', '--focus-on=never', '--ontop=no', '--geometry=960x540']) assert.ok(args.includes(a), a);
});

test('settings: Use XWayland for the Stage window is on by default, a boolean', () => {
  assert.strictEqual(S.DEFAULTS.xwayland, true);
  assert.strictEqual(S.normalize({ xwayland: false }).xwayland, false);
  assert.strictEqual(S.normalize({ xwayland: 'no' }, { xwayland: false }).xwayland, false, 'a bad value keeps what was there');
  assert.strictEqual(S.validatePatch({ xwayland: 'off' }).ok, false);
  assert.strictEqual(S.validatePatch({ xwayland: false }).settings.xwayland, false);
  // The page knows the same default.
  const ui = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'stage-settings-ui.js'), 'utf8');
  assert.match(ui, /xwayland: true,/);
});

/* ── Older mpv (distribution packages) ──────────────────────────────────── */

/** A --list-options answer naming every FIXED option except `missing` (plus `extra`). */
function optionList(missing = [], extra = []) {
  const names = new Set(FIXED.map((a) => /^--(?:no-)?([a-z0-9-]+)/.exec(a)[1]));
  for (const n of ['hwdec', 'input-ipc-server', 'title', 'cursor-autohide', 'volume', 'mute', 'ao', 'geometry', 'window-maximized', 'gpu-context', ...extra]) names.add(n);
  for (const m of missing) names.delete(m);
  for (let i = 0; names.size < 150; i++) names.add(`filler-${i}`);
  return `Options:\n\n${[...names].map((n) => ` --${n.padEnd(32)} Flag (default: no)`).join('\n')}\n\nTotal: ${names.size} options\n`;
}

test('fitOptions: an mpv without the newer options gets the rest unchanged; renamed ones take their old name', () => {
  // Like Ubuntu 24.04's mpv 0.37: before focus-on, background-color, load-console, media-controls...
  const old = ['focus-on', 'background-color', 'load-console', 'media-controls', 'autocreate-playlist', 'load-select', 'load-commands', 'load-positioning', 'load-context-menu'];
  const known = find.parseOptions(optionList(old, ['focus-on-open', 'load-osd-console']));
  assert.ok(known instanceof Set);
  const args = buildArgs({ ipcPath: 'p', mpvOptions: known });
  for (const n of old) assert.ok(!args.some((a) => a.startsWith(`--${n}=`)), n);
  assert.ok(args.includes('--focus-on-open=no'), 'the window still does not take the focus');
  assert.ok(args.includes('--load-osd-console=no'), 'the console script is still off');
  // Everything that is not a newer option is untouched: the privacy and no-code options above all.
  const kept = FIXED.filter((a) => !old.some((n) => a.startsWith(`--${n}=`)));
  for (const a of kept) assert.ok(args.includes(a), a);
  for (const a of ['--ytdl=no', '--load-scripts=no', '--osc=no', '--demuxer-lavf-o=protocol_whitelist=[file]', '--input-default-bindings=no']) assert.ok(args.includes(a), a);
  // A current mpv: nothing changes.
  assert.deepStrictEqual(buildArgs({ ipcPath: 'p', mpvOptions: find.parseOptions(optionList()) }), buildArgs({ ipcPath: 'p' }));
  // Could not tell (null, empty): nothing changes.
  assert.deepStrictEqual(fitOptions(FIXED, null), [...FIXED]);
  assert.deepStrictEqual(fitOptions(FIXED, new Set()), [...FIXED]);
  // Only the listed newer options can ever be dropped.
  const none = new Set(['nothing']);
  const fitted = fitOptions(FIXED, none);
  for (const a of FIXED) {
    const n = /^--([a-z0-9-]+)=/.exec(a);
    if (!n || !Object.prototype.hasOwnProperty.call(NEWER_OPTIONS, n[1])) assert.ok(fitted.includes(a), a);
  }
});

test('parseOptions: mpv’s list, or null for anything else', () => {
  assert.ok(find.parseOptions(optionList()).has('ytdl'));
  assert.strictEqual(find.parseOptions(''), null);
  assert.strictEqual(find.parseOptions('mpv 0.37.0 Copyright\n --help\n'), null, 'a few lines are not the list');
  assert.strictEqual(find.parseOptions(null), null);
});

/* ── Finding mpv on Linux and macOS ─────────────────────────────────────── */

/**
 * A fake POSIX file system: path -> { real?, dir? }. Every folder above a
 * listed path is there too. All of it is root's and 0755, like a package's
 * files, so checkPath's ownership check (untrustedPosix) lets it through.
 */
function fakeFs(files) {
  const above = new Set();
  for (const p of Object.keys(files)) {
    if (!p.startsWith('/')) continue;
    for (let d = path.posix.dirname(p); !above.has(d); d = path.posix.dirname(d)) {
      above.add(d);
      if (d === '/') break;
    }
  }
  const stat = (p) => {
    const f = files[p] || (above.has(p) ? { dir: true } : null);
    if (!f) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => !f.dir, isDirectory: () => !!f.dir, size: 1, mtimeMs: 1,
      uid: 0, gid: 0, mode: f.dir ? 0o40755 : 0o100755 };
  };
  const realpath = (p) => { const f = files[p]; if (!f) throw new Error('ENOENT'); return f.real || p; };
  return { statSync: stat, realpathSync: realpath, accessSync: () => {} };
}

const MPV_OUT = 'mpv 0.37.0 Copyright © 2000-2023 mpv/MPlayer/mplayer2 projects\n';
const fakeRun = (answers) => {
  const runs = [];
  return {
    runs,
    run: (file, args, opts, cb) => {
      runs.push({ file, args, opts });
      const a = answers[file];
      const out = a === undefined ? '' : (args.includes('--list-options') ? optionList(['focus-on']) : a);
      setImmediate(() => cb(a === undefined ? new Error('not found') : null, out));
    },
  };
};

test('defaultLocations: the distribution package on Linux, Homebrew and the app on macOS', () => {
  assert.deepStrictEqual(find.defaultLocations('linux', {}), ['/usr/bin/mpv', '/usr/local/bin/mpv']);
  assert.deepStrictEqual(find.defaultLocations('darwin', {}), ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv', '/Applications/mpv.app/Contents/MacOS/mpv']);
  assert.strictEqual(find.exeName('darwin'), 'mpv');
  // A Snap's /snap/bin/mpv is a link to /usr/bin/snap: never accepted as mpv.
  const snapFs = fakeFs({ '/snap/bin/mpv': { real: '/usr/bin/snap' } });
  assert.strictEqual(find.checkPath('/snap/bin/mpv', { platform: 'linux', fsx: snapFs }).ok, false);
  // The mpv.io app bundle on macOS is named mpv inside.
  const app = '/Applications/mpv.app/Contents/MacOS/mpv';
  assert.strictEqual(find.checkPath(app, { platform: 'darwin', fsx: fakeFs({ [app]: {} }) }).ok, true);
});

test('findMpv on Linux: /usr/bin first, then PATH; the option list only for a launch', async () => {
  find._clearVersionCache();
  const { run, runs } = fakeRun({ '/usr/bin/mpv': MPV_OUT, '/opt/mpv/bin/mpv': MPV_OUT });
  const fsx = fakeFs({ '/usr/bin/mpv': {}, '/opt/mpv/bin/mpv': {} });
  const a = await find.findMpv({ platform: 'linux', env: { PATH: '/opt/mpv/bin:/usr/bin' }, fsx, run });
  assert.deepStrictEqual([a.found, a.path, a.source, a.version], [true, '/usr/bin/mpv', 'default', '0.37.0']);
  assert.ok(!('options' in a), 'a status check does not ask for the options');
  assert.ok(runs.every((r) => !r.args.includes('--list-options')));
  const b = await find.findMpv({ platform: 'linux', env: { PATH: '' }, fsx, run, withOptions: true });
  assert.ok(b.options instanceof Set && !b.options.has('focus-on') && b.options.has('ytdl'));
  const listed = runs.filter((r) => r.args.includes('--list-options'));
  assert.deepStrictEqual(listed.map((r) => [r.file, r.args, r.opts.shell]), [['/usr/bin/mpv', ['--no-config', '--list-options'], false]]);
  // Remembered like the version.
  await find.findMpv({ platform: 'linux', env: { PATH: '' }, fsx, run, withOptions: true });
  assert.strictEqual(runs.filter((r) => r.args.includes('--list-options')).length, 1);
  // Only on PATH.
  const c = await find.findMpv({ platform: 'linux', env: { PATH: '/opt/mpv/bin' }, fsx: fakeFs({ '/opt/mpv/bin/mpv': {} }), run });
  assert.deepStrictEqual([c.found, c.path, c.source], [true, '/opt/mpv/bin/mpv', 'path']);
});

test('findMpv on Linux: a Flatpak or Snap mpv is reported, never run', async () => {
  find._clearVersionCache();
  const { run, runs } = fakeRun({});
  const flatpak = fakeFs({ '/var/lib/flatpak/app/io.mpv.Mpv': { dir: true } });
  const r1 = await find.findMpv({ platform: 'linux', env: { PATH: '/usr/bin', HOME: '/home/me' }, fsx: flatpak, run });
  assert.deepStrictEqual(r1, { found: false, sandboxed: 'flatpak' });
  const user = fakeFs({ '/home/me/.local/share/flatpak/app/io.mpv.Mpv': { dir: true } });
  assert.strictEqual((await find.findMpv({ platform: 'linux', env: { HOME: '/home/me' }, fsx: user, run })).sandboxed, 'flatpak');
  const snap = fakeFs({ '/snap/bin/mpv': { real: '/usr/bin/snap' }, '/snap/mpv': { dir: true } });
  assert.strictEqual((await find.findMpv({ platform: 'linux', env: { PATH: '/snap/bin' }, fsx: snap, run })).sandboxed, 'snap');
  assert.strictEqual(runs.length, 0, 'nothing in a sandbox is ever run');
  // A usable mpv wins; nothing is said about a sandboxed one.
  const both = fakeFs({ '/usr/bin/mpv': {}, '/var/lib/flatpak/app/io.mpv.Mpv': { dir: true } });
  const r2 = await find.findMpv({ platform: 'linux', env: {}, fsx: both, run: fakeRun({ '/usr/bin/mpv': MPV_OUT }).run });
  assert.deepStrictEqual([r2.found, r2.sandboxed], [true, undefined]);
  // Not looked for on Windows or macOS; a relative HOME is never used.
  assert.strictEqual(find.sandboxedMpv({ platform: 'win32', env: {}, fsx: flatpak }), null);
  assert.strictEqual(find.sandboxedMpv({ platform: 'darwin', env: {}, fsx: flatpak }), null);
  assert.strictEqual(find.sandboxedMpv({ platform: 'linux', env: { HOME: 'me' }, fsx: fakeFs({ 'me/.local/share/flatpak/app/io.mpv.Mpv': {} }) }), null);
});

/* ── Window position memory: nothing to run off Windows ─────────────────── */

test('watchWindow off Windows: nothing started, nothing said', () => {
  let spawned = 0;
  const warn = console.warn, error = console.error;
  const said = [];
  console.warn = (...a) => said.push(a); console.error = (...a) => said.push(a);
  try {
    for (const platform of ['linux', 'darwin']) {
      assert.strictEqual(watchWindow({ hwnd: 0x3a00007, mpvPid: 1234, platform, spawnFn: () => { spawned++; } }), null);
    }
  } finally { console.warn = warn; console.error = error; }
  assert.strictEqual(spawned, 0);
  assert.deepStrictEqual(said, []);
});

/* ── Starting again without X11 ─────────────────────────────────────────── */

/** A fake mpv on a real pipe (or socket) that answers like mpv. */
function fakeMpvServer(pipePath, pid) {
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
        const c = msg.command;
        let ans = { error: 'success', data: null };
        if (c[0] === 'get_property' && c[1] === 'pid') ans = { error: 'success', data: pid };
        else if (c[0] === 'get_property') ans = { error: 'property unavailable' };   // window-id on Wayland
        sock.write(`${JSON.stringify({ request_id: msg.request_id, ...ans })}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(pipePath, () => resolve({
    close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
  })));
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.exitCode = null; child.signalCode = null; child.pid = pid;
  child.kill = () => { if (child.exitCode !== null) return; child.exitCode = 1; child.emit('exit', 1); };
  return child;
}

function pipePathFor(tag) {
  const id = `${process.pid}-${tag}-${Date.now()}`;
  if (process.platform === 'win32') return { path: `\\\\.\\pipe\\vault-test-${id}`, cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vst-'));
  return { path: path.join(dir, 's'), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

test('host: an mpv that ends at once with the X11 window starts again without it; only the second is reported', async () => {
  const ipc = pipePathFor('fallback');
  let srv = null;             // the second mpv's pipe, there only once it starts
  const exits = [];
  const spawned = [];
  const children = [fakeChild(5001), fakeChild(5002)];
  const host = createMpvHost({
    platform: 'linux',
    spawnFn: (file, args) => {
      const c = children[spawned.length];
      spawned.push(args);
      if (c.pid === 5001) setImmediate(() => c.kill());     // no X11 drawing here: mpv ends at once
      else srv = fakeMpvServer(ipc.path, 5002);
      return c;
    },
    makeIpc: () => ({ path: ipc.path, cleanup: () => {} }),
    ipcOptions: { connectTimeoutMs: 5000 },
    watch: () => null,
    onExit: (e) => exits.push(e),
  });
  const started = Date.now();
  try {
    const r = await host.start('/usr/bin/mpv', (p) => ['--x11', p], { fallbackArgsFor: (p) => ['--wayland', p] });
    assert.deepStrictEqual(r, { ok: true, fellBack: true });
    assert.deepStrictEqual(spawned.map((a) => a[0]), ['--x11', '--wayland']);
    assert.ok(Date.now() - started < 4000, 'the first mpv’s end is seen at once, not after the pipe wait');
    assert.deepStrictEqual(exits, [], 'the first mpv’s end is not reported as Stage closing');
    assert.strictEqual(host.pid, 5002);
    host.kill();
    assert.deepStrictEqual(exits, [{ code: 1, asked: true }]);
  } finally {
    if (srv) await (await srv).close();
    ipc.cleanup();
  }
});

test('host: no fallback given, or a first mpv that keeps running: no second start', async () => {
  // No fallback: one start, its end reported as before.
  const exits = [];
  let spawns = 0;
  const host = createMpvHost({
    platform: 'linux',
    spawnFn: () => { spawns++; const c = fakeChild(6001); setImmediate(() => c.kill()); return c; },
    makeIpc: () => ({ path: process.platform === 'win32' ? '\\\\.\\pipe\\vault-stage-none' : '/nonexistent/vst/s', cleanup: () => {} }),
    ipcOptions: { connectTimeoutMs: 100 },
    watch: () => null,
    onExit: (e) => exits.push(e),
  });
  const r = await host.start('/usr/bin/mpv', () => []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(spawns, 1);
  assert.strictEqual(exits.length, 1);
  // A first mpv that stays up but never answers: killed, not started again.
  let spawns2 = 0;
  const kids = [];
  const host2 = createMpvHost({
    platform: 'linux',
    spawnFn: () => { spawns2++; const c = fakeChild(7000 + spawns2); kids.push(c); return c; },
    makeIpc: () => ({ path: process.platform === 'win32' ? '\\\\.\\pipe\\vault-stage-none2' : '/nonexistent/vst/s2', cleanup: () => {} }),
    ipcOptions: { connectTimeoutMs: 100 },
    watch: () => null,
  });
  const r2 = await host2.start('/usr/bin/mpv', () => ['--x11'], { fallbackArgsFor: () => ['--wayland'] });
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(spawns2, 1);
  assert.strictEqual(kids[0].exitCode, 1, 'the silent mpv was ended');
});
