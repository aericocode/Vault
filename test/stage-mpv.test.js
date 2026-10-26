/**
 * Stage on mpv (PLAYLISTS_SPEC "Stage host, final"):
 *
 *  - lib/stage/mpv-find.js    where mpv may come from, what it must be, checked
 *                             on every launch, --version only after the checks
 *  - lib/stage/mpv-args.js    the command line: hardening, no unchecked strings
 *  - lib/stage/mpv-ipc.js     JSON IPC over a pipe: requests, events, timeouts,
 *                             reconnect (a fake mpv on a real pipe)
 *  - lib/stage/mpv-host.js    the pipe name, the loadfile form, never detached
 *  - lib/stage/mpv-overlay.js the name and the black sheet, made inert
 *  - lib/stage/mpv-window.js  the window watcher's lines
 *  - lib/stage/engine.js      playback rules with a fake mpv: the next file
 *                             lined up, moving on by itself, skips, the end,
 *                             Hold, lock, resume spots and views
 *
 * No real mpv runs here.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const find = require('../lib/stage/mpv-find');
const { buildArgs, titleArg, geometryArg, FIXED } = require('../lib/stage/mpv-args');
const { MpvIpc, MpvTimeout, MpvDisconnected, MpvError } = require('../lib/stage/mpv-ipc');
const { makeIpcPath, loadfileTakesIndex, createMpvHost } = require('../lib/stage/mpv-host');
const Overlay = require('../lib/stage/mpv-overlay');
const { parseLine, watchWindow } = require('../lib/stage/mpv-window');
const { createEngine, WAIT_UPCOMING_MS, LOAD_TIMEOUT_MS } = require('../lib/stage/engine');

/* ── Finding mpv ────────────────────────────────────────────────────────── */

/** A fake file system: path -> { size, mtimeMs, real?, dir? } (Windows paths, compared case-blind). */
function fakeFs(files) {
  const get = (p) => files[Object.keys(files).find(k => k.toLowerCase() === String(p).toLowerCase())];
  const stat = (p) => {
    const f = get(p);
    if (!f) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return { isFile: () => !f.dir, size: f.size || 1, mtimeMs: f.mtimeMs || 1 };
  };
  const realpath = (p) => { const f = get(p); if (!f) throw new Error('ENOENT'); return f.real || p; };
  realpath.native = realpath;
  return { statSync: stat, realpathSync: realpath, accessSync: () => {} };
}

/** A fake process runner that answers like mpv (or not), and counts runs. */
function fakeRun(answers) {
  const runs = [];
  const run = (file, args, opts, cb) => {
    runs.push({ file, args, opts });
    const a = answers[file];
    setImmediate(() => cb(a === undefined ? new Error('not found') : null, a || ''));
  };
  return { run, runs };
}

const MPV_OUT = 'mpv v0.41.0-244-gaf9c81fa1 Copyright © 2000-2026 mpv/MPlayer/mplayer2 projects\n built on Mar  2 2026\n';

test('checkPath: only a local, absolute file named mpv.exe whose real path is named the same', () => {
  const fsx = fakeFs({
    'C:\\Program Files\\mpv\\mpv.exe': {},
    'D:\\Tools\\MPV.EXE': {},
    'C:\\Windows\\System32\\calc.exe': {},
    'C:\\x\\mpv.exe': { real: 'C:\\Windows\\System32\\calc.exe' },
    'C:\\dir\\mpv.exe': { dir: true },
  });
  const ok = (p) => find.checkPath(p, { platform: 'win32', fsx }).ok;
  assert.strictEqual(ok('C:\\Program Files\\mpv\\mpv.exe'), true);
  assert.strictEqual(ok('D:\\Tools\\MPV.EXE'), true, 'the name is case-blind on Windows');
  assert.strictEqual(ok('C:\\Windows\\System32\\calc.exe'), false, 'any other program');
  assert.strictEqual(ok('C:\\x\\mpv.exe'), false, 'a link to another program');
  assert.strictEqual(ok('C:\\dir\\mpv.exe'), false, 'a folder');
  assert.strictEqual(ok('C:\\nowhere\\mpv.exe'), false, 'a file that is not there');
  assert.strictEqual(ok('mpv.exe'), false, 'a relative path');
  assert.strictEqual(ok('.\\mpv.exe'), false);
  assert.strictEqual(ok('\\\\server\\share\\mpv.exe'), false, 'a network share');
  assert.strictEqual(ok('\\\\?\\C:\\Program Files\\mpv\\mpv.exe'), false, 'a device path');
  assert.strictEqual(ok('C:\\Program Files\\mpv\\mpv.com'), false, 'mpv.com is not mpv.exe');
  assert.strictEqual(ok('C:\\Program Files\\mpv\\mpv.exe\u0000.txt'), false, 'control characters');
  assert.strictEqual(ok(42), false);
  assert.strictEqual(find.checkPath('/usr/bin/mpv', { platform: 'linux', fsx: fakeFs({ '/usr/bin/mpv': {} }) }).ok, true);
  assert.strictEqual(find.checkPath('/usr/bin/vlc', { platform: 'linux', fsx: fakeFs({ '/usr/bin/vlc': {} }) }).ok, false);
});

test('parseVersion: only mpv’s own first line counts', () => {
  assert.strictEqual(find.parseVersion(MPV_OUT).version, 'v0.41.0-244-gaf9c81fa1');
  assert.strictEqual(find.parseVersion('mpv 0.35.1 Copyright').version, '0.35.1');
  assert.strictEqual(find.parseVersion('VLC media player 3.0'), null);
  assert.strictEqual(find.parseVersion(''), null);
  assert.strictEqual(find.parseVersion('mpvx v1.0'), null);
});

test('findMpv: the chosen path, then the usual folders, then absolute PATH folders; --version only after the checks; again on every launch', async () => {
  find._clearVersionCache();
  const chosen = 'E:\\Apps\\mpv\\mpv.exe';
  const fsx = fakeFs({ [chosen]: {}, 'C:\\Program Files\\MPV Player\\mpv.exe': {}, 'C:\\Windows\\System32\\calc.exe': {} });
  const { run, runs } = fakeRun({ [chosen]: MPV_OUT, 'C:\\Program Files\\MPV Player\\mpv.exe': MPV_OUT });
  const env = { PATH: '.;relative\\bin;C:\\Windows\\System32' };
  const a = await find.findMpv({ chosen, platform: 'win32', env, fsx, run });
  assert.deepStrictEqual([a.found, a.path, a.source], [true, chosen, 'chosen']);
  assert.deepStrictEqual(runs[0].args, ['--no-config', '--version']);
  assert.strictEqual(runs[0].opts.shell, false);
  // A chosen path that is gone: the usual folders, and the problem said.
  const b = await find.findMpv({ chosen: 'E:\\Gone\\mpv.exe', platform: 'win32', env, fsx, run });
  assert.deepStrictEqual([b.found, b.source], [true, 'default']);
  assert.ok(b.chosenProblem);
  // Never ran anything that failed the checks (calc.exe, relative PATH entries).
  assert.ok(runs.every(r => /mpv\.exe$/i.test(r.file)), runs.map(r => r.file).join(','));
  // A file that changed since the last launch is asked again; one that did not is remembered.
  const before = runs.length;
  await find.findMpv({ chosen, platform: 'win32', env, fsx, run });
  assert.strictEqual(runs.length, before, 'same file: the --version answer is reused, the checks are not');
  const fsx2 = fakeFs({ [chosen]: { mtimeMs: 99 } });
  await find.findMpv({ chosen, platform: 'win32', env, fsx: fsx2, run });
  assert.strictEqual(runs.length, before + 1);
  // A program named mpv.exe that does not answer as mpv is refused.
  find._clearVersionCache();
  const fake = fakeRun({ [chosen]: 'Hello from something else' });
  const c = await find.findMpv({ chosen, platform: 'win32', env: { PATH: '' }, fsx: fakeFs({ [chosen]: {} }), run: fake.run });
  assert.strictEqual(c.found, false);
  assert.match(c.chosenProblem, /did not answer as mpv/);
});

test('findMpv: PATH entries that are relative, "." or network shares are never used', () => {
  const c = find.pathCandidates({ platform: 'win32', env: { PATH: '.;bin;\\\\srv\\share;"C:\\Tools";D:\\mpv\\' } });
  assert.deepStrictEqual(c, ['C:\\Tools\\mpv.exe', 'D:\\mpv\\mpv.exe']);
  assert.deepStrictEqual(find.pathCandidates({ platform: 'linux', env: { PATH: '.:bin:/usr/bin' } }), ['/usr/bin/mpv']);
  assert.deepStrictEqual(find.defaultLocations('win32', {}).slice(0, 3), [
    'C:\\Program Files\\MPV Player\\mpv.exe', 'C:\\Program Files\\mpv\\mpv.exe', 'C:\\Program Files (x86)\\mpv\\mpv.exe',
  ]);
});

/* ── mpv's command line ─────────────────────────────────────────────────── */

test('arguments: the hardening is all there', () => {
  const args = buildArgs({ ipcPath: '\\\\.\\pipe\\vault-stage-abc', title: 'Vault Stage' });
  for (const a of [
    '--no-config', '--idle=yes', '--force-window=yes', '--keep-open=yes', '--border=no', '--window-dragging=yes',
    '--osc=no', '--osd-level=0', '--hwdec=auto-safe', '--prefetch-playlist=yes', '--background-color=#000000',
    '--keepaspect-window=no', '--auto-window-resize=no', '--focus-on=never', '--ontop=no', '--media-controls=no',
    '--terminal=no', '--msg-level=all=no', '--load-scripts=no', '--ytdl=no', '--input-default-bindings=no',
    '--input-builtin-bindings=no', '--access-references=no', '--demuxer-lavf-o=protocol_whitelist=[file]',
    '--stream-lavf-o=protocol_whitelist=[file]', '--force-media-title=Stage', '--save-position-on-quit=no',
    '--input-ipc-server=\\\\.\\pipe\\vault-stage-abc', '--title=Vault Stage', '--cursor-autohide=1000', '--image-display-duration=inf',
  ]) assert.ok(args.includes(a), a);
  assert.ok(!args.some(a => /input-conf|script=|--include|--wid|--ytdl=yes|--load-scripts=yes/.test(a)));
  assert.throws(() => buildArgs({}), /ipcPath/);
});

test('arguments: the window name is shown as typed, never expanded (no ${path})', () => {
  assert.strictEqual(titleArg('Show ${path} $$'), 'Show $${path} $$$$');
  assert.strictEqual(titleArg('a\nb'), 'a b');
  const args = buildArgs({ ipcPath: 'p', title: '${filename}' });
  assert.ok(args.includes('--title=$${filename}'));
  // Every argument is one of the fixed ones or built from a checked value.
  const dyn = buildArgs({ ipcPath: 'p', title: 'T', bounds: { x: -1900.4, y: 20, w: 1280, h: 720 }, cursorSeconds: 3, volume: 0.5, muted: true });
  for (const a of dyn) {
    if (FIXED.includes(a)) continue;
    assert.match(a, /^--(input-ipc-server=p|title=T|cursor-autohide=3000|volume=50|mute=yes|geometry=1280x720\+-1900\+20)$/, a);
  }
});

test('arguments: test switches (silent, off every screen) and sizes', () => {
  const quiet = buildArgs({ ipcPath: 'p', quiet: true, forceMute: true, bounds: { x: 10, y: 10, w: 640, h: 360 }, maximized: true });
  assert.ok(quiet.includes('--geometry=640x360+-20000+0'));
  assert.ok(quiet.includes('--ao=null') && quiet.includes('--mute=yes'));
  assert.ok(!quiet.includes('--window-maximized=yes'), 'a quiet window never fills a screen');
  assert.ok(buildArgs({ ipcPath: 'p' }).includes('--geometry=960x540'));
  assert.ok(buildArgs({ ipcPath: 'p', bounds: { x: 0, y: 0, w: 800, h: 600 }, maximized: true }).includes('--window-maximized=yes'));
  assert.strictEqual(geometryArg({ w: 'x', h: 3 }), null);
  assert.strictEqual(geometryArg({ w: 1920, h: 1080 }), '1920x1080');
  assert.strictEqual(buildArgs({ ipcPath: 'p', cursorSeconds: 999 }).find(a => a.startsWith('--cursor-autohide=')), '--cursor-autohide=60000');
});

/* ── The pipe and the process ───────────────────────────────────────────── */

test('the IPC pipe name is random and unguessable; on Linux a socket in a private folder', () => {
  const a = makeIpcPath('win32').path;
  const b = makeIpcPath('win32').path;
  assert.match(a, /^\\\\\.\\pipe\\vault-stage-[0-9a-f]{32}$/);
  assert.notStrictEqual(a, b);
  if (process.platform !== 'win32') {
    const s = makeIpcPath('linux');
    assert.strictEqual((fs.statSync(path.dirname(s.path)).mode & 0o077), 0, 'only the user can reach the socket folder');
    s.cleanup();
  }
});

test('loadfile: the index form from mpv 0.38 on, the old form before', () => {
  assert.strictEqual(loadfileTakesIndex('v0.41.0-244-gaf9c81fa1'), true);
  assert.strictEqual(loadfileTakesIndex('0.38.0'), true);
  assert.strictEqual(loadfileTakesIndex('v0.37.0'), false);
  assert.strictEqual(loadfileTakesIndex('af9c81fa1'), true);
});

test('mpv is spawned without a shell and never detached (Windows ends it with Vault through Node’s kill-on-close job)', async () => {
  const seen = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  child.kill = () => { child.exitCode = 1; child.emit('exit', 1); };
  const host = createMpvHost({
    platform: 'win32',
    spawnFn: (file, args, opts) => { seen.push({ file, args, opts }); setImmediate(() => child.kill()); return child; },
    makeIpc: () => ({ path: '\\\\.\\pipe\\vault-stage-none', cleanup: () => {} }),
    ipcOptions: { connectTimeoutMs: 100 },
  });
  const r = await host.start('C:\\mpv\\mpv.exe', (p) => ['--input-ipc-server=' + p]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(seen[0].opts.shell, false);
  assert.strictEqual(seen[0].opts.detached, false);
  assert.strictEqual(seen[0].opts.stdio, 'ignore');
});

/** A fake mpv on a real pipe (or socket): answers commands, can send events, can hang. */
function fakeMpvServer(pipePath, { onCommand } = {}) {
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
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        const ans = onCommand ? onCommand(msg.command) : { error: 'success', data: null };
        if (ans === 'hang') continue;
        sock.write(`${JSON.stringify({ request_id: msg.request_id, ...ans })}\n`);
      }
    });
  });
  return new Promise((resolve) => server.listen(pipePath, () => resolve({
    server,
    emit: (ev) => { for (const s of socks) s.write(`${JSON.stringify(ev)}\n`); },
    dropAll: () => { for (const s of socks) s.destroy(); },
    close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }),
  })));
}

const testPipe = () => (process.platform === 'win32'
  ? `\\\\.\\pipe\\vault-stage-test-${process.pid}-${Math.random().toString(16).slice(2)}`
  : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vst-')), 's.sock'));

test('IPC: requests get their own answers, errors are errors, events come as events', async () => {
  const p = testPipe();
  const srv = await fakeMpvServer(p, {
    onCommand: (cmd) => (cmd[0] === 'get_property' && cmd[1] === 'volume' ? { error: 'success', data: 80 }
      : cmd[0] === 'bad' ? { error: 'invalid parameter' } : { error: 'success', data: null }),
  });
  const ipc = new MpvIpc(p, { connectTimeoutMs: 2000 });
  await ipc.connect();
  const [v, n] = await Promise.all([ipc.get('volume'), ipc.command(['set_property', 'pause', true])]);
  assert.strictEqual(v, 80);
  assert.strictEqual(n, null);
  await assert.rejects(ipc.command(['bad']), (e) => e instanceof MpvError && /invalid parameter/.test(e.message));
  const got = new Promise((resolve) => ipc.once('event', resolve));
  const prop = new Promise((resolve) => ipc.once('property', (name, data) => resolve([name, data])));
  srv.emit({ event: 'property-change', id: 1, name: 'time-pos', data: 3.5 });
  assert.strictEqual((await got).event, 'property-change');
  assert.deepStrictEqual(await prop, ['time-pos', 3.5]);
  ipc.close();
  await srv.close();
});

test('IPC: a request mpv never answers times out; the pipe not there yet is waited for', async () => {
  const p = testPipe();
  const ipc = new MpvIpc(p, { connectTimeoutMs: 3000, requestTimeoutMs: 150 });
  const connecting = ipc.connect();
  await new Promise(r => setTimeout(r, 200));      // mpv opens its pipe a moment later
  const srv = await fakeMpvServer(p, { onCommand: () => 'hang' });
  await connecting;
  await assert.rejects(ipc.command(['get_property', 'pause']), (e) => e instanceof MpvTimeout);
  assert.strictEqual(ipc.pending.size, 0);
  ipc.close();
  await srv.close();
  await assert.rejects(new MpvIpc(testPipe(), { connectTimeoutMs: 100 }).connect(), (e) => e instanceof MpvDisconnected);
});

test('IPC: a dropped connection fails what was waiting, reconnects while mpv lives, and watches its properties again', async () => {
  const p = testPipe();
  const commands = [];
  const srv = await fakeMpvServer(p, { onCommand: (cmd) => { commands.push(cmd); return cmd[0] === 'get_property' ? 'hang' : { error: 'success', data: null }; } });
  const ipc = new MpvIpc(p, { connectTimeoutMs: 2000, requestTimeoutMs: 5000, shouldReconnect: () => true });
  await ipc.connect();
  await ipc.observe('time-pos');
  const waiting = ipc.command(['get_property', 'pause']);
  const back = new Promise((resolve) => ipc.once('reconnect', resolve));
  srv.dropAll();
  await assert.rejects(waiting, (e) => e instanceof MpvDisconnected);
  await back;
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(commands.filter(c => c[0] === 'observe_property' && c[2] === 'time-pos').length, 2);
  ipc.close();
  await srv.close();
});

test('IPC: no reconnect once mpv is gone; close() ends it for good', async () => {
  const p = testPipe();
  const srv = await fakeMpvServer(p);
  const ipc = new MpvIpc(p, { connectTimeoutMs: 2000, shouldReconnect: () => false });
  await ipc.connect();
  await ipc.command(['get_property', 'pause']);   // the fake has the connection now
  const closed = new Promise((resolve) => ipc.once('close', resolve));
  srv.dropAll();
  await closed;
  assert.strictEqual(ipc.connected, false);
  await assert.rejects(ipc.command(['get_property', 'pause']), (e) => e instanceof MpvDisconnected);
  ipc.close();
  await srv.close();
});

/* ── What is drawn over the picture ─────────────────────────────────────── */

test('overlay: the name is inert text (no override blocks, no line breaks), lower left, faded in steps', () => {
  assert.strictEqual(Overlay.assEscape('a{\\b1}b\nc\\Nd'), 'a\\{\\\u2060b1\\}b c\\\u2060Nd');
  const ev = Overlay.nameEvent('My {\\pos(0,0)} clip', 1);
  assert.match(ev, /^\{\\an1\\pos\(41,688\)/);
  assert.ok(ev.endsWith('My \\{\\\u2060pos(0,0)\\} clip'));
  assert.strictEqual(Overlay.nameEvent('   ', 1), '');
  assert.strictEqual(Overlay.alpha(0, 1), '&H00&');
  assert.strictEqual(Overlay.alpha(0, 0), '&HFF&');
  assert.deepStrictEqual(Overlay.fadeSteps('out', 4), [0.75, 0.5, 0.25, 0]);
  assert.strictEqual(Array.from(Overlay.truncate('x'.repeat(200))).length, 80);
  assert.deepStrictEqual(Overlay.overlayCommand(1, ''), { name: 'osd-overlay', id: 1, format: 'none', data: '' });
  assert.strictEqual(Overlay.overlayCommand(2, Overlay.blackEvent(), 10).res_x, 0);
});

test('window watcher: its lines parse strictly; nothing runs off Windows or for a bad handle', () => {
  assert.deepStrictEqual(parseLine('bounds -2700 200 640 360 0 0 -2880 -165 2880 2488'), {
    type: 'bounds', win: { x: -2700, y: 200, w: 640, h: 360 }, max: false, min: false, work: { x: -2880, y: -165, w: 2880, h: 2488 },
  });
  assert.strictEqual(parseLine('bounds 1 2 3'), null);
  assert.strictEqual(parseLine('bounds a b c d 0 0 1 1 1 1'), null);
  assert.deepStrictEqual(parseLine('styles 140E0000 00000100'), { type: 'styles', style: 0x140E0000, ex: 0x100 });
  assert.strictEqual(parseLine('hello'), null);
  assert.strictEqual(watchWindow({ hwnd: 5, mpvPid: 5, platform: 'linux' }), null);
  let spawned = 0;
  assert.strictEqual(watchWindow({ hwnd: -1, mpvPid: 5, platform: 'win32', spawnFn: () => { spawned++; } }), null);
  assert.strictEqual(watchWindow({ hwnd: 1.5, mpvPid: 5, platform: 'win32', spawnFn: () => { spawned++; } }), null);
  assert.strictEqual(spawned, 0);
});

/* ── The engine, with a fake mpv ────────────────────────────────────────── */

/** Timers and a clock the test moves by hand. */
function fakeClock() {
  let t = 1e6;
  let id = 0;
  const q = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const k = ++id; q.set(k, { fn, at: t + (ms || 0) }); return k; },
      clearTimeout: (k) => { q.delete(k); },
      setInterval: () => 0,
      clearInterval: () => {},
    },
    async tick(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [k, v] of q) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        if (!next) break;
        q.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await new Promise(r => setImmediate(r));
      }
      t = end;
      await new Promise(r => setImmediate(r));
    },
  };
}

/** A fake mpv host: a playlist of entries, commands recorded, events sent by the test. */
function fakeMpv() {
  let entry = 0;
  const m = {
    log: [], playlist: [], props: {}, aliveFlag: true,
    alive: () => m.aliveFlag,
    async set(name, value) { m.log.push(['set', name, value]); m.props[name] = value; return null; },
    async get(name) { return m.props[name]; },
    async command(cmd) {
      m.log.push(Array.isArray(cmd) ? cmd : ['named', cmd.name, cmd.id, cmd.data ? 'data' : 'none']);
      if (Array.isArray(cmd) && cmd[0] === 'get_property' && cmd[1] === 'playlist') return m.playlist.map(e => ({ id: e.id, filename: e.file }));
      if (Array.isArray(cmd) && cmd[0] === 'playlist-remove') m.playlist.splice(cmd[1], 1);
      if (Array.isArray(cmd) && cmd[0] === 'stop') m.playlist = [];
      return null;
    },
    async loadfile(file, mode, opts) {
      entry += 1;
      if (mode === 'replace') m.playlist = [];
      m.playlist.push({ id: entry, file, opts });
      m.log.push(['loadfile', file, mode, opts]);
      return { playlist_entry_id: entry };
    },
    entryOf: (file) => (m.playlist.find(e => e.file === file) || {}).id,
  };
  return m;
}

const PATHS = { 1: 'D:\\m\\one.mp4', 2: 'D:\\m\\two.mp4', 3: 'D:\\m\\three.mp4', 4: 'D:\\m\\pic.jpg', 5: 'D:\\m\\anim.gif' };
const it = (key, id, extra = {}) => ({ key, id, media_type: 'video', filename: `${key}.mp4`, duration: 30, startAt: 0, via: 'list', index: id, ...extra });

function engineFor({ locked = () => false, settings = {} } = {}) {
  const mpv = fakeMpv();
  const clock = fakeClock();
  const reports = [];
  const rec = { views: [], positions: [], heat: [], touches: 0 };
  const engine = createEngine({
    mpv, report: (r) => reports.push(r), now: clock.now, timers: clock.timers,
    settings: () => ({ showName: true, nameSeconds: 3, imageSeconds: 8, windowName: 'Vault Stage', ...settings }),
    readFile: async () => Buffer.alloc(0),
    lib: {
      pathFor: (id) => (PATHS[id] ? { ok: true, path: PATHS[id] } : { ok: false, reason: 'it is not in the library' }),
      recordView: (id, s) => rec.views.push([id, s]),
      savePosition: (id, p) => rec.positions.push([id, p]),
      mergeHeatmap: (id, b) => rec.heat.push([id, b]),
      touch: () => { rec.touches++; },
      isLocked: locked,
    },
  });
  engine.started({ volume: 1 });
  const settle = () => new Promise(r => setImmediate(r));
  const ev = async (e) => { engine.onEvent(e); await settle(); };
  const prop = (name, data) => ev({ event: 'property-change', name, data });
  return { mpv, clock, reports, rec, engine, settle, ev, prop };
}

test('engine: a file goes to mpv as its library path with the next one appended; mpv moving on tells Control (started, auto)', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [it('b', 2), it('c', 3)], repeat: 'off', paused: false });
  await e.settle(); await e.settle();
  const loads = e.mpv.log.filter(l => l[0] === 'loadfile');
  assert.deepStrictEqual(loads.map(l => [l[1], l[2]]), [[PATHS[1], 'replace'], [PATHS[2], 'append']], 'current + next only');
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  assert.deepStrictEqual(e.reports.find(r => r.type === 'started'), { type: 'started', key: 'a', auto: false });
  // The file ends; mpv starts the appended one by itself.
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  await e.ev({ event: 'file-loaded' });
  assert.deepStrictEqual(e.reports.filter(r => r.type === 'started').pop(), { type: 'started', key: 'b', auto: true });
  // ...and the one after is lined up at once (Control may be asleep in a background tab).
  assert.deepStrictEqual(e.mpv.log.filter(l => l[0] === 'loadfile').pop().slice(1, 3), [PATHS[3], 'append']);
  assert.deepStrictEqual(e.engine._state().upcoming, ['c']);
});

test('engine: Control’s new upcoming list keeps a lined-up file that is the same, replaces one that is not', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [it('b', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  e.engine.command({ type: 'upcoming', upcoming: [it('b2', 2), it('c', 3)], repeat: 'off' });
  await e.settle();
  assert.strictEqual(e.engine._state().next.key, 'b2', 'the same file, Control’s newest key');
  assert.strictEqual(e.mpv.log.filter(l => l[0] === 'loadfile').length, 2, 'nothing reloaded');
  e.engine.command({ type: 'upcoming', upcoming: [it('c', 3)], repeat: 'off' });
  await e.settle(); await e.settle(); await e.settle();
  assert.ok(e.mpv.log.some(l => l[0] === 'playlist-remove'));
  assert.strictEqual(e.engine._state().next.key, 'c');
  // Repeat one: nothing lined up, the file loops.
  e.engine.command({ type: 'upcoming', upcoming: [], repeat: 'one' });
  await e.settle(); await e.settle();
  assert.strictEqual(e.engine._state().next, null);
  assert.ok(e.mpv.log.some(l => l[0] === 'set' && l[1] === 'loop-file' && l[2] === 'inf'));
});

test('engine: a file that cannot be read or played is skipped and reported; the end of the list waits for Control, then black', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [it('gone', 99), it('b', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  assert.deepStrictEqual(e.reports.find(r => r.type === 'skipped'), { type: 'skipped', key: 'gone', reason: 'it is not in the library' });
  assert.strictEqual(e.engine._state().next.key, 'b');
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  // b fails as it starts: skipped, and with nothing after it the end comes.
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  await e.ev({ event: 'end-file', reason: 'error', playlist_entry_id: 2 });
  assert.ok(e.reports.some(r => r.type === 'skipped' && r.key === 'b'));
  assert.ok(!e.reports.some(r => r.type === 'finished'), 'not yet: Control may line something up');
  await e.clock.tick(WAIT_UPCOMING_MS + 10);
  assert.ok(e.reports.some(r => r.type === 'finished'));
  assert.ok(e.mpv.log.some(l => l[0] === 'stop'), 'black: mpv idles on its black background');
});

test('engine: the last frame stays at the end (keep-open) and the next file from Control follows without black', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  await e.prop('eof-reached', true);
  assert.strictEqual(e.engine._state().waiting, true);
  e.engine.command({ type: 'upcoming', upcoming: [it('b', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  assert.deepStrictEqual(e.mpv.log.filter(l => l[0] === 'loadfile').pop().slice(1, 3), [PATHS[2], 'replace']);
  assert.ok(!e.mpv.log.some(l => l[0] === 'stop'));
  await e.clock.tick(WAIT_UPCOMING_MS + 10);
  assert.ok(!e.reports.some(r => r.type === 'finished'));
});

test('engine: pictures are timed here (a paused picture waits); GIFs at least one loop', async () => {
  const e = engineFor({ settings: { imageSeconds: 8 } });
  e.engine.command({ type: 'load', item: it('p', 4, { media_type: 'image' }), upcoming: [it('b', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  await e.clock.tick(3000);
  e.engine.command({ type: 'pause' });
  await e.clock.tick(20000);
  assert.ok(!e.mpv.log.some(l => l[0] === 'playlist-next'), 'paused: still on the picture');
  e.engine.command({ type: 'play' });
  await e.clock.tick(4900);
  assert.ok(!e.mpv.log.some(l => l[0] === 'playlist-next'));
  await e.clock.tick(200);
  assert.ok(e.mpv.log.some(l => l[0] === 'playlist-next'), '8 s of showing, then the next file');
  assert.ok(e.rec.views.some(v => v[0] === 4), 'a picture counts as seen after a short look');
});

test('engine: Hold is black, silent and paused, and comes back as it was', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  await e.prop('pause', false);
  e.engine.command({ type: 'hold', on: true });
  await e.settle();
  const st = e.engine._state();
  assert.strictEqual(st.blackOn, true);
  assert.ok(e.mpv.log.some(l => l[0] === 'set' && l[1] === 'pause' && l[2] === true));
  assert.ok(e.mpv.log.some(l => l[0] === 'set' && l[1] === 'mute' && l[2] === true));
  assert.ok(e.mpv.log.some(l => l[0] === 'named' && l[1] === 'osd-overlay' && l[2] === Overlay.BLACK_ID && l[3] === 'data'));
  e.engine.command({ type: 'hold', on: false });
  await e.settle();
  assert.strictEqual(e.engine._state().blackOn, false);
  assert.deepStrictEqual(e.mpv.log.filter(l => l[0] === 'set' && l[1] === 'pause').pop(), ['set', 'pause', false]);
});

test('engine: a lock stops playback at once (black, unloaded, nothing read or written); the unlock brings the file back paused under Hold', async () => {
  let locked = false;
  const e = engineFor({ locked: () => locked });
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [it('b', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  locked = true;
  e.engine.lock();
  await e.settle();
  const last = e.mpv.log.slice(-4).map(l => l[0] === 'named' ? `overlay:${l[2]}:${l[3]}` : l[0] === 'set' ? `set:${l[1]}` : l[0]);
  assert.ok(e.mpv.log.some(l => l[0] === 'stop'), 'unloaded');
  assert.ok(e.mpv.log.some(l => l[0] === 'named' && l[2] === Overlay.BLACK_ID && l[3] === 'data'), 'black sheet first');
  assert.ok(last.length);
  const before = e.mpv.log.length;
  const reportsBefore = e.reports.length;
  // Nothing while locked: no file loaded, no report, no record.
  e.engine.command({ type: 'load', item: it('b', 2), upcoming: [] });
  await e.prop('time-pos', 20);
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  e.engine.sendStatus(true);
  assert.ok(!e.mpv.log.slice(before).some(l => l[0] === 'loadfile'));
  assert.strictEqual(e.reports.length, reportsBefore);
  assert.strictEqual(e.rec.positions.length, 0);
  locked = false;
  e.engine.unlock({ current: it('a', 1), status: { key: 'a', t: 12.5 }, upcoming: [it('b', 2)], resume: true, hold: true });
  await e.settle(); await e.settle();
  const reload = e.mpv.log.filter(l => l[0] === 'loadfile').find(l => l[2] === 'replace' && e.mpv.log.indexOf(l) > before);
  assert.ok(reload, 'the file comes back');
  assert.strictEqual(reload[3].start, '12.50');
  assert.deepStrictEqual(e.mpv.log.filter(l => l[0] === 'set' && l[1] === 'pause').pop(), ['set', 'pause', true]);
  assert.strictEqual(e.engine._state().hold, true);
  assert.strictEqual(e.engine._state().holdWasPlaying, true, 'Hold off plays it again');
});

test('engine: resume spots, views and the heatmap from mpv’s time-pos, with the player’s rules', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  await e.prop('duration', 20);
  await e.prop('pause', false);
  for (let t = 0; t <= 16; t += 0.5) await e.prop('time-pos', t);
  // 75 % of 20 s watched: one view, with the seconds watched.
  assert.strictEqual(e.rec.views.length, 1);
  assert.strictEqual(e.rec.views[0][0], 1);
  assert.ok(e.rec.views[0][1] >= 15);
  assert.ok(e.rec.positions.some(p => p[0] === 1 && p[1] === 5), 'the spot every 5 s');
  // A jump is not watching.
  await e.prop('time-pos', 2);
  await e.prop('time-pos', 2.5);
  e.engine.command({ type: 'pause' });
  await e.settle();
  assert.deepStrictEqual(e.rec.positions.pop(), [1, 2.5], 'pausing saves the spot');
  assert.ok(e.rec.heat.length >= 1 && Object.keys(e.rec.heat[0][1]).length > 10);
  // Played to the end: the spot goes back to the start.
  await e.prop('time-pos', 19.9);
  e.engine.command({ type: 'play' });
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  assert.deepStrictEqual(e.rec.positions.pop(), [1, 0]);
});

test('engine: privacy mode drops every name it holds and the name on screen; a playing Stage keeps the auto-lock away', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1, { filename: 'secret.mp4' }), upcoming: [it('b', 2, { filename: 'other.mp4' })], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  await e.clock.tick(200);
  assert.ok(e.mpv.log.some(l => l[0] === 'named' && l[2] === Overlay.NAME_ID && l[3] === 'data'), 'the name is drawn');
  e.engine.command({ type: 'privacy', hideNames: true });
  await e.settle();
  assert.deepStrictEqual(e.mpv.log.filter(l => l[0] === 'named' && l[2] === Overlay.NAME_ID).pop(), ['named', 'osd-overlay', Overlay.NAME_ID, 'none']);
  await e.prop('pause', false);
  e.engine.sendStatus(true);
  assert.strictEqual(e.rec.touches, 1);
  e.engine.command({ type: 'hold', on: true });
  e.engine.sendStatus(true);
  assert.strictEqual(e.rec.touches, 1, 'on Hold the auto-lock clock runs');
});

test('engine: a file mpv never starts is skipped after a while', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('a', 1), upcoming: [it('b', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.clock.tick(LOAD_TIMEOUT_MS + 10);
  assert.ok(e.reports.some(r => r.type === 'skipped' && r.key === 'a'));
});

/* ── Verifier follow-ups ────────────────────────────────────────────────── */

test('race: Up next changes just as a file ends and mpv starts the lined-up one: hub, engine and remote agree on what plays', async () => {
  const { createHub } = require('../lib/stage/hub');
  const e = engineFor();
  const sentToControl = [];
  let hubReplies = [];
  const hub = createHub({
    heartbeatMs: 0,
    settings: { get: () => ({}), sizes: ['free'] },
    stage: { alive: () => true, command: (c) => e.engine.command(c), position: () => e.engine.position(), close() {}, lock() {}, unlock() {} },
  });
  // The engine's reports go to this hub (as stage-routes.js wires them).
  e.reports.push = (r) => { hubReplies.push(hub.report(r)); return 0; };
  const { req, res } = (() => {
    const rq = new EventEmitter(); const rs = new EventEmitter();
    rs.writeHead = () => {}; rs.write = (s) => { const m = /^event: (\w+)\ndata: (.*)$/m.exec(s); if (m) sentToControl.push([m[1], JSON.parse(m[2])]); return true; }; rs.end = () => {};
    return { req: rq, res: rs };
  })();
  hub.opened('mpv');
  hub.attach('control', req, res);
  hub.command({ type: 'load', item: it('A', 1, { startAt: 28.8 }), upcoming: [it('B', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  assert.strictEqual(e.engine._state().next.key, 'B');
  // A ends and mpv starts B at once. Control, which has not heard yet, sends
  // a new list for A (the user removed B from Up next): processed by the hub
  // after mpv started B but before the engine said so would have frozen the
  // remote on A. Now the engine says so at start-file...
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  assert.strictEqual(hub.state().current.key, 'B', 'the hub knows at once');
  // ...so Control's late answer for A is stale and dropped.
  assert.strictEqual(hub.command({ type: 'upcoming', upcoming: [it('C', 3)], repeat: 'off', forKey: 'A' }).body.stale, true);
  assert.ok(sentToControl.some(([ev, d]) => ev === 'started' && d.item.key === 'B' && d.auto === true), 'the remote is told B started');
  assert.ok(hubReplies.every(r => r.status === 200), JSON.stringify(hubReplies.filter(r => r.status !== 200)));
});

test('race, the other order: Control’s new list reaches the hub first, then mpv starts the file it had lined up; the hub still takes it and C stays next', async () => {
  const { createHub } = require('../lib/stage/hub');
  const e = engineFor();
  const replies = [];
  const hub = createHub({
    heartbeatMs: 0, settings: { get: () => ({}), sizes: ['free'] },
    stage: { alive: () => true, command: (c) => { /* the engine has not seen it yet */ e.later = c; }, position: () => e.engine.position() },
  });
  e.reports.push = (r) => { replies.push(hub.report(r)); return 0; };
  hub.opened('mpv');
  hub.command({ type: 'load', item: it('A', 1), upcoming: [it('B', 2)], repeat: 'off' });
  e.engine.command(e.later);
  await e.settle(); await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  // The user removes B: the hub takes the new list for A (A is still current there)...
  assert.strictEqual(hub.command({ type: 'upcoming', upcoming: [it('C', 3)], repeat: 'off', forKey: 'A' }).status, 200);
  // ...but mpv has already moved on to B before the engine got the list.
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  assert.deepStrictEqual(replies.map(r => r.status), replies.map(() => 200), 'never "a file it was not given"');
  assert.strictEqual(hub.state().current.key, 'B', 'what mpv plays is current');
  assert.deepStrictEqual(hub.state().upcoming.map(u => u.key), ['C'], 'Control’s list stays next');
  // The engine now gets the list: C is lined up after B.
  e.engine.command(e.later);
  await e.settle(); await e.settle();
  assert.strictEqual(e.engine._state().cur.key, 'B');
  assert.strictEqual(e.engine._state().next.key, 'C');
});

test('race: when the new list arrives before mpv starts the lined-up file, that file is taken out of mpv’s playlist', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: it('A', 1), upcoming: [it('B', 2)], repeat: 'off' });
  await e.settle(); await e.settle();
  e.engine.command({ type: 'upcoming', upcoming: [it('C', 3)], repeat: 'off' });
  await e.settle(); await e.settle(); await e.settle();
  assert.ok(!e.mpv.playlist.some(x => x.file === PATHS[2]), 'B is gone from mpv');
  assert.ok(e.mpv.playlist.some(x => x.file === PATHS[3]), 'C is lined up');
});

test('the pipe must answer with the pid of the mpv Vault started, or Vault refuses to drive it', async () => {
  for (const [answer, ok] of [[4242, true], [999, false], [null, false]]) {
    const p = testPipe();
    const srv = await fakeMpvServer(p, { onCommand: (cmd) => (cmd[0] === 'get_property' && cmd[1] === 'pid' ? { error: 'success', data: answer } : { error: 'success', data: null }) });
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null; child.pid = 4242;
    let killed = false;
    child.kill = () => { killed = true; child.exitCode = 1; child.emit('exit', 1); };
    const host = createMpvHost({ platform: 'linux', spawnFn: () => child, makeIpc: () => ({ path: p, cleanup: () => {} }), watch: () => null });
    const r = await host.start('/usr/bin/mpv', () => []);
    assert.strictEqual(r.ok, ok, `pid ${answer}`);
    assert.strictEqual(killed, !ok);
    if (ok) host.kill();
    await srv.close();
  }
});
