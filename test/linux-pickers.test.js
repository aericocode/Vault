/**
 * Pickers off Windows (LINUX_SPEC WP4):
 *   lib/native-dialog-linux.js  the desktop's own dialog (zenity / kdialog)
 *   lib/fs-browse.js            what Vault's own folder browser lists, Save As
 *                               and drop path checks
 *   server/fs-routes.js         GET /api/fs/list
 *   player-lib/fs-picker.js     decodeUriList (a drop's text/uri-list)
 *   server/playlist-import-routes.js  checkPickedPath off Windows, { path } from the page
 *
 * The pure parts run everywhere. Anything that lists real folders, follows
 * symlinks or runs a fake zenity only runs on Linux.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const express = require('express');

const nd = require('../lib/native-dialog-linux');
const fsb = require('../lib/fs-browse');
const fsRoutes = require('../server/fs-routes');
const { decodeUriList } = require('../player-lib/fs-picker');
const playlistRoutes = require('../server/playlist-import-routes');

const LINUX = process.platform === 'linux' ? false : 'lists real POSIX folders: Linux only';

/* ── Which tool ────────────────────────────────────────────────────────── */

test('tool choice: needs a display, KDE and LXQt prefer kdialog, the rest zenity, either stands in for the other', () => {
  const both = (n) => `/usr/bin/${n}`;
  const only = (want) => (n) => (n === want ? `/usr/bin/${n}` : null);
  const c = (env, find = both) => nd.chooseTool({ env, platform: 'linux', find });
  assert.deepStrictEqual(c({}), { unavailable: 'no-display' });
  assert.deepStrictEqual(c({ XDG_CURRENT_DESKTOP: 'KDE' }), { unavailable: 'no-display' });
  assert.deepStrictEqual(c({ DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), { tool: 'zenity', path: '/usr/bin/zenity' });
  assert.deepStrictEqual(c({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' }), { tool: 'kdialog', path: '/usr/bin/kdialog' });
  assert.deepStrictEqual(c({ DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'LXQt' }).tool, 'kdialog');
  assert.deepStrictEqual(c({ DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'X-Cinnamon' }).tool, 'zenity');
  assert.deepStrictEqual(c({ DISPLAY: ':0' }).tool, 'zenity', 'no desktop named: zenity');
  assert.deepStrictEqual(c({ DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'KDE' }, only('zenity')).tool, 'zenity', 'KDE without kdialog');
  assert.deepStrictEqual(c({ DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'GNOME' }, only('kdialog')).tool, 'kdialog', 'GNOME without zenity');
  assert.deepStrictEqual(c({ DISPLAY: ':0' }, () => null), { unavailable: 'no-tool' });
  for (const platform of ['win32', 'darwin']) {
    assert.deepStrictEqual(nd.chooseTool({ env: { DISPLAY: ':0' }, platform, find: both }), { unavailable: 'not-linux' }, platform);
  }
});

test('tools are found on PATH without a shell, absolute PATH entries only, executables only', { skip: LINUX }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-nd-path-'));
  try {
    fs.writeFileSync(path.join(dir, 'zenity'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'kdialog'), 'not runnable', { mode: 0o644 });
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.strictEqual(nd.findOnPath('zenity', { env: { PATH: `relative:${dir}` } }), path.join(dir, 'zenity'));
    assert.strictEqual(nd.findOnPath('kdialog', { env: { PATH: dir } }), null, 'not executable');
    assert.strictEqual(nd.findOnPath('sub', { env: { PATH: dir } }), null, 'a folder');
    assert.strictEqual(nd.findOnPath('zenity', { env: { PATH: 'relative' } }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ── Command lines ─────────────────────────────────────────────────────── */

const PL = { label: 'Playlists', exts: ['m3u', 'm3u8'] };

test('zenity: every mode, a starting folder and a title', () => {
  assert.deepStrictEqual(nd.buildArgs('zenity', { mode: 'folder', title: 'Add a folder', startDir: '/home/u/Videos' }),
    ['--file-selection', '--title=Add a folder', '--directory', '--filename=/home/u/Videos/']);
  assert.deepStrictEqual(nd.buildArgs('zenity', { mode: 'file', title: 'Import', startDir: '/home/u/', filter: PL }),
    ['--file-selection', '--title=Import', '--filename=/home/u/', '--file-filter=Playlists | *.m3u *.m3u8', '--file-filter=All files | *']);
  assert.deepStrictEqual(nd.buildArgs('zenity', { mode: 'files', title: 'Add files', startDir: '/m' }),
    ['--file-selection', '--title=Add files', '--multiple', '--separator=\n', '--filename=/m/']);
  // Save: 3.x needs --confirm-overwrite; 4.x always asks and calls the flag deprecated.
  assert.deepStrictEqual(nd.buildArgs('zenity', { mode: 'save', title: 'Save playlist', startDir: '/home/u/Music', name: 'Trip.m3u8', filter: PL }, '3.44.0'),
    ['--file-selection', '--title=Save playlist', '--save', '--confirm-overwrite', '--filename=/home/u/Music/Trip.m3u8', '--file-filter=Playlists | *.m3u *.m3u8']);
  assert.deepStrictEqual(nd.buildArgs('zenity', { mode: 'save', title: 'Save playlist', startDir: '/home/u/Music', name: 'Trip.m3u8', filter: PL }, '4.0.1'),
    ['--file-selection', '--title=Save playlist', '--save', '--filename=/home/u/Music/Trip.m3u8', '--file-filter=Playlists | *.m3u *.m3u8']);
  assert.ok(nd.buildArgs('zenity', { mode: 'save', title: 'S', startDir: '/x', name: 'a' }, '').includes('--confirm-overwrite'), 'unknown version: the flag');
  // A slash in a suggested name never steers the folder; odd extensions never reach the filter.
  const a = nd.buildArgs('zenity', { mode: 'save', title: 'S', startDir: '/x', name: '../../etc/passwd', filter: { label: 'P', exts: ['m3u', 'x y', '*'] } }, '4.0');
  assert.ok(a.includes('--filename=/x/.. .. etc passwd'), a.join(' | '));
  assert.ok(a.includes('--file-filter=P | *.m3u'), a.join(' | '));
});

test('kdialog: every mode, a starting folder and a title', () => {
  assert.deepStrictEqual(nd.buildArgs('kdialog', { mode: 'folder', title: 'Add a folder', startDir: '/home/u/Videos' }),
    ['--title', 'Add a folder', '--getexistingdirectory', '/home/u/Videos']);
  assert.deepStrictEqual(nd.buildArgs('kdialog', { mode: 'file', title: 'Import', startDir: '/home/u', filter: PL }),
    ['--title', 'Import', '--getopenfilename', '/home/u', '*.m3u *.m3u8|Playlists']);
  assert.deepStrictEqual(nd.buildArgs('kdialog', { mode: 'files', title: 'Add files', startDir: '/m' }),
    ['--title', 'Add files', '--multiple', '--separate-output', '--getopenfilename', '/m']);
  assert.deepStrictEqual(nd.buildArgs('kdialog', { mode: 'save', title: 'Save playlist', startDir: '/home/u/Music', name: 'Trip.m3u8', filter: PL }),
    ['--title', 'Save playlist', '--getsavefilename', '/home/u/Music/Trip.m3u8', '*.m3u *.m3u8|Playlists']);
  assert.deepStrictEqual(nd.buildArgs('kdialog', { mode: 'file', title: 'Choose mpv', startDir: '/usr/bin' }),
    ['--title', 'Choose mpv', '--getopenfilename', '/usr/bin'], 'no filter: none passed');
  assert.throws(() => nd.buildArgs('yad', { mode: 'folder' }));
});

/* ── What a closed dialog said ─────────────────────────────────────────── */

test('exit codes: 0 picked (trailing newline off), 1 cancel, 1 with no display is a failure, others fail', () => {
  assert.deepStrictEqual(nd.interpret({ code: 0, out: '/home/u/My Videos\n' }, 'folder'), { status: 'picked', paths: ['/home/u/My Videos'] });
  assert.deepStrictEqual(nd.interpret({ code: 0, out: '/a/b.mp4\n/a/c d.mp4\n' }, 'files'), { status: 'picked', paths: ['/a/b.mp4', '/a/c d.mp4'] });
  assert.deepStrictEqual(nd.interpret({ code: 0, out: '/a/trailing space \n' }, 'file'), { status: 'picked', paths: ['/a/trailing space '] });
  assert.deepStrictEqual(nd.interpret({ code: 0, out: '' }, 'file'), { status: 'cancel' });
  assert.deepStrictEqual(nd.interpret({ code: 1, out: '', errOut: '' }, 'file'), { status: 'cancel' });
  assert.deepStrictEqual(nd.interpret({ code: 1, out: '', errOut: '(zenity:42): Gtk-WARNING **: 10:00: cannot open display: :0' }, 'file'),
    { status: 'failed', reason: 'no-window' });
  assert.deepStrictEqual(nd.interpret({ code: 1, out: '', errOut: 'qt.qpa.xcb: could not connect to display' }, 'file').status, 'failed');
  assert.deepStrictEqual(nd.interpret({ code: 255, out: '' }, 'file'), { status: 'failed', reason: 'exit 255' });
  assert.deepStrictEqual(nd.interpret({ code: null, signal: 'SIGKILL', out: '' }, 'file'), { status: 'failed', reason: 'signal SIGKILL' });
});

/** A child process that prints `out` and exits with `code`. */
function fakeChild({ out = '', errOut = '', code = 0, error = null }) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.exitCode = null;
  c.kill = () => { c.killed = true; };
  setImmediate(() => {
    if (error) { c.emit('error', error); return; }
    c.stdout.end(out);
    c.stderr.end(errOut);
    setImmediate(() => { c.exitCode = code; c.emit('close', code, null); });
  });
  return c;
}

test('openDialog: argument array and no shell; picked, cancel, would not start, nothing to run', async () => {
  const env = { DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'GNOME' };
  const seen = [];
  const spawnFn = (exe, args, opts) => { seen.push({ exe, args, opts }); return fakeChild({ out: '/home/u/Clips\n' }); };
  const d = nd.openDialog({ mode: 'folder', title: 'T', startDir: '/home/u' }, { env, platform: 'linux', find: (n) => `/usr/bin/${n}`, spawnFn });
  assert.strictEqual(d.tool, 'zenity');
  assert.deepStrictEqual(await d.result, { status: 'picked', paths: ['/home/u/Clips'] });
  assert.strictEqual(seen[0].exe, '/usr/bin/zenity');
  assert.strictEqual(seen[0].opts.shell, false);
  assert.ok(Array.isArray(seen[0].args));

  const cancel = nd.openDialog({ mode: 'file', title: 'T' }, { env, platform: 'linux', find: (n) => `/usr/bin/${n}`, spawnFn: () => fakeChild({ code: 1 }) });
  assert.deepStrictEqual(await cancel.result, { status: 'cancel' });

  const gone = nd.openDialog({ mode: 'file', title: 'T' }, { env, platform: 'linux', find: (n) => `/usr/bin/${n}`,
    spawnFn: () => fakeChild({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }) });
  assert.deepStrictEqual(await gone.result, { status: 'failed', reason: 'spawn: ENOENT' });

  const threw = nd.openDialog({ mode: 'file', title: 'T' }, { env, platform: 'linux', find: (n) => `/usr/bin/${n}`,
    spawnFn: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } });
  assert.deepStrictEqual(threw, { unavailable: 'spawn: EACCES' });

  assert.deepStrictEqual(nd.openDialog({ mode: 'file' }, { env: {}, platform: 'linux', spawnFn }), { unavailable: 'no-display' });
  assert.deepStrictEqual(nd.openDialog({ mode: 'file' }, { env, platform: 'darwin', spawnFn }), { unavailable: 'not-linux' });

  // zenity Save asks for the version once (here given) and builds the right flags.
  const saves = [];
  const s = nd.openDialog({ mode: 'save', title: 'S', startDir: '/x', name: 'a.m3u8' }, { env, platform: 'linux', find: (n) => `/usr/bin/${n}`,
    version: '4.0.1', spawnFn: (e, args) => { saves.push(args); return fakeChild({ out: '/x/a.m3u8\n' }); } });
  assert.deepStrictEqual(await s.result, { status: 'picked', paths: ['/x/a.m3u8'] });
  assert.ok(!saves[0].includes('--confirm-overwrite'));
});

test('openDialog runs a real program on PATH (a fake zenity) and reads its answer', { skip: LINUX }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-nd-run-'));
  try {
    const log = path.join(dir, 'args.txt');
    fs.writeFileSync(path.join(dir, 'zenity'),
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${log}"; done\nprintf '%s\\n' '/tmp/ünï code/a b.m3u8'\nexit 0\n`, { mode: 0o755 });
    const env = { PATH: dir, DISPLAY: ':0' };
    const d = nd.openDialog({ mode: 'file', title: "It's a title; $(rm -rf /)", startDir: '/tmp', filter: PL }, { env, platform: 'linux' });
    assert.deepStrictEqual(await d.result, { status: 'picked', paths: ['/tmp/ünï code/a b.m3u8'] });
    const args = fs.readFileSync(log, 'utf8').split('\n');
    assert.ok(args.includes("--title=It's a title; $(rm -rf /)"), 'the title went in as one argument, never through a shell');
    fs.writeFileSync(path.join(dir, 'zenity'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assert.deepStrictEqual(await nd.openDialog({ mode: 'folder', title: 'T' }, { env, platform: 'linux' }).result, { status: 'cancel' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ── Places ────────────────────────────────────────────────────────────── */

const USER_DIRS = `# This file is written by xdg-user-dirs-update
XDG_DESKTOP_DIR="$HOME/Desktop"
XDG_DOWNLOAD_DIR="$HOME/Downloads"
XDG_TEMPLATES_DIR="$HOME/"
XDG_MUSIC_DIR="$HOME/Musik"
XDG_PICTURES_DIR="/data/Bilder"
XDG_VIDEOS_DIR="$HOME/Meine \\"Videos\\""
XDG_DOCUMENTS_DIR="relative/nope"
`;

test('user-dirs.dirs: $HOME, absolute, quotes, unset and relative entries', () => {
  assert.deepStrictEqual(fsb.parseUserDirs(USER_DIRS, '/home/u'), {
    DESKTOP: '/home/u/Desktop', DOWNLOAD: '/home/u/Downloads', MUSIC: '/home/u/Musik',
    PICTURES: '/data/Bilder', VIDEOS: '/home/u/Meine "Videos"',
  });
  assert.deepStrictEqual(fsb.parseUserDirs('', '/home/u'), {});
});

const MOUNTS = `sysfs /sys sysfs rw,nosuid 0 0
proc /proc proc rw 0 0
/dev/nvme0n1p2 / ext4 rw,relatime 0 0
/dev/sdb1 /media/u/Media\\0404TB ext4 rw 0 0
/dev/sdc1 /run/media/u/USB exfat rw 0 0
//nas/share /mnt/nas cifs rw 0 0
/dev/sdb1 /media/u/Media\\0404TB ext4 rw 0 0
tmpfs /run/user/1000 tmpfs rw 0 0
/dev/loop3 /snap/core/1 squashfs ro 0 0
/dev/sdd1 /mnt ext4 rw 0 0
none /mnt/wslg tmpfs rw 0 0
/dev/sde /mnt/wslg/distro ext4 ro 0 0
none /mnt/wslg/doc overlay rw 0 0
C:\\134 /mnt/c 9p rw,aname=drvfs 0 0
`;

test('/proc/mounts: drives under /media, /run/media and /mnt, escapes decoded, once each, no tmpfs or what is inside one', () => {
  assert.deepStrictEqual(fsb.parseMounts(MOUNTS), [
    { path: '/media/u/Media 4TB', label: 'Media 4TB', kind: 'drive' },
    { path: '/run/media/u/USB', label: 'USB', kind: 'drive' },
    { path: '/mnt/nas', label: 'nas', kind: 'network' },
    { path: '/mnt/c', label: 'c', kind: 'drive' },
  ]);
});

test('places: home and its folders, drives plus the whole computer, the library, programs for Choose mpv', () => {
  const exists = new Set(['/home/u', '/home/u/Desktop', '/home/u/Downloads', '/home/u/Musik', '/data/Bilder',
    '/media/u/Media 4TB', '/mnt/nas', '/srv/lib', '/usr/bin']);
  const isDir = (p) => exists.has(p);
  const g = fsb.places({ home: '/home/u', userDirsText: USER_DIRS, mountsText: MOUNTS,
    libraryRoots: ['/srv/lib', '/gone', 'relative', '/proc/x'], isDir });
  assert.deepStrictEqual(g.map((x) => x.group), ['This computer', 'Drives', 'In your library']);
  assert.deepStrictEqual(g[0].items.map((x) => [x.label, x.path]), [
    ['Home', '/home/u'], ['Desktop', '/home/u/Desktop'], ['Bilder', '/data/Bilder'], ['Musik', '/home/u/Musik'], ['Downloads', '/home/u/Downloads'],
  ]);
  assert.deepStrictEqual(g[1].items.map((x) => x.path), ['/media/u/Media 4TB', '/mnt/nas', '/']);
  assert.strictEqual(g[1].items[1].tag, 'network');
  assert.strictEqual(g[1].items[2].label, 'This computer');
  assert.deepStrictEqual(g[2].items.map((x) => x.path), ['/srv/lib']);
  const p = fsb.places({ home: '/home/u', isDir, programs: true });
  assert.deepStrictEqual(p[0], { group: 'Programs', items: [{ path: '/usr/bin', label: '/usr/bin', icon: 'programs' }] });
  // A missing home and no user-dirs file: Drives is still there.
  assert.deepStrictEqual(fsb.places({ home: '/nope', isDir: () => false }).map((x) => x.group), ['Drives']);
});

test('refused folders: /proc, /sys, /dev and inside them, not look-alikes', () => {
  for (const p of ['/proc', '/proc/1/root', '/sys', '/sys/class', '/dev', '/dev/sda', '/proc/../proc/self']) assert.ok(fsb.isRefused(p), p);
  for (const p of ['/', '/process', '/devices', '/home/u/dev', '/system']) assert.ok(!fsb.isRefused(p), p);
});

/* ── Listing a folder ──────────────────────────────────────────────────── */

let tree = null;
function makeTree() {
  if (tree) return tree;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fsb-'));
  const mk = (rel, body = '') => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (body !== null) fs.writeFileSync(p, body);
  };
  mk('Videos/Clips/a.mp4'); mk('Videos/Clips/b.MKV'); mk('Videos/Clips/c.jpg'); mk('Videos/Clips/notes.txt');
  mk('Videos/Empty/.keep');
  mk('Videos/.hidden/x.mp4');
  mk('Videos/road trip.m3u8'); mk('Videos/gym.M3U'); mk('Videos/readme.txt'); mk('Videos/.secret.m3u8');
  for (let i = 0; i < fsb.COUNT_MAX_CHILDREN + 5; i++) mk(`Videos/Huge/f${i}.mp4`);
  mk('bin/mpv', '#!/bin/sh\n'); fs.chmodSync(path.join(root, 'bin/mpv'), 0o755);
  mk('bin/vlc', '#!/bin/sh\n'); fs.chmodSync(path.join(root, 'bin/vlc'), 0o755);
  mk('bin/data.txt', 'x');
  fs.symlinkSync('/proc', path.join(root, 'Videos/to-proc'));
  fs.symlinkSync(path.join(root, 'Videos/Clips'), path.join(root, 'Videos/Clips link'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'Videos/broken'));
  tree = root;
  return root;
}
test.after(() => { if (tree) fs.rmSync(tree, { recursive: true, force: true }); });

const names = (r) => r.entries.map((e) => e.name);

test('listDir: folders with a media count, hidden off by default, symlinks into /proc and broken links left out', { skip: LINUX }, () => {
  const root = makeTree();
  const v = path.join(root, 'Videos');
  const r = fsb.listDir(v, { mode: 'folder', inLibrary: new Set([path.join(v, 'Clips')]) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(names(r), ['Clips', 'Clips link', 'Empty', 'Huge'], 'folders only, sorted');
  const clips = r.entries.find((e) => e.name === 'Clips');
  assert.deepStrictEqual(clips, { name: 'Clips', dir: true, counted: true, count: { videos: 2, images: 1 }, inLibrary: true });
  assert.deepStrictEqual(r.entries.find((e) => e.name === 'Empty').count, { videos: 0, images: 0 });
  assert.deepStrictEqual(r.entries.find((e) => e.name === 'Huge'), { name: 'Huge', dir: true, counted: false }, 'too many children: not counted');
  assert.strictEqual(r.parent, root);
  const h = fsb.listDir(v, { mode: 'folder', hidden: true });
  assert.deepStrictEqual(names(h).sort(), ['.hidden', 'Clips', 'Clips link', 'Empty', 'Huge'].sort());
  // The time budget: past it, nothing more is counted.
  let t = 0;
  const late = fsb.listDir(v, { mode: 'folder', now: () => (t += 1000) });
  assert.ok(late.entries.every((e) => e.counted === false));
});

test('listDir: file modes filter by extension (any case), save lists the playlists, exe lists runnable files', { skip: LINUX }, () => {
  const root = makeTree();
  const v = path.join(root, 'Videos');
  assert.deepStrictEqual(names(fsb.listDir(v, { mode: 'file', exts: ['m3u', 'm3u8'] })),
    ['Clips', 'Clips link', 'Empty', 'Huge', 'gym.M3U', 'road trip.m3u8'], 'folders first');
  assert.ok(names(fsb.listDir(v, { mode: 'file', exts: ['m3u8'], hidden: true })).includes('.secret.m3u8'));
  assert.ok(!names(fsb.listDir(v, { mode: 'file', exts: ['m3u8'] })).includes('.secret.m3u8'));
  assert.ok(names(fsb.listDir(v, { mode: 'files' })).includes('readme.txt'), 'Add files: every file');
  assert.deepStrictEqual(names(fsb.listDir(path.join(root, 'bin'), { mode: 'exe' })), ['mpv', 'vlc']);
  assert.ok(fsb.listDir(v, { mode: 'file', exts: ['m3u8'] }).entries.find((e) => e.name === 'Clips').count === undefined, 'no counts outside the media modes');
});

test('listDir: refusals and errors', { skip: LINUX }, () => {
  const root = makeTree();
  for (const p of ['/proc', '/proc/self', '/sys/kernel', '/dev', path.join(root, 'Videos/to-proc'), path.join(root, 'Videos/to-proc/self')]) {
    const r = fsb.listDir(p, { mode: 'folder' });
    assert.strictEqual(r.status, 403, p);
  }
  assert.strictEqual(fsb.listDir('relative/path', {}).status, 400);
  assert.strictEqual(fsb.listDir('/a\nb', {}).status, 400);
  assert.strictEqual(fsb.listDir(path.join(root, 'nope'), {}).status, 404);
  assert.strictEqual(fsb.listDir(path.join(root, 'bin/mpv'), {}).status, 400, 'a file');
  const n = fsb.listDir(`${root}/Videos/../Videos/./Clips/`, { mode: 'folder' });
  assert.strictEqual(n.path, path.join(root, 'Videos/Clips'), 'normalized');
  assert.strictEqual(fsb.listDir('/', { mode: 'folder' }).parent, null);
});

/* ── The route ─────────────────────────────────────────────────────────── */

async function withApp(router, fn) {
  const app = express();
  app.use(router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { await new Promise((r) => srv.close(r)); }
}

test('GET /api/fs/list answers 404 on Windows (the Windows dialogs are used there)', async () => {
  await withApp(fsRoutes.buildRouter({ platform: 'win32' }), async (base) => {
    assert.strictEqual((await fetch(`${base}/api/fs/list?path=/`)).status, 404);
  });
});

test('GET /api/fs/list: a folder, the places, refusals, and nothing but GET', { skip: LINUX }, async () => {
  const root = makeTree();
  const home = path.join(root, 'Videos');
  const router = fsRoutes.buildRouter({ libraryRoots: () => [path.join(home, 'Clips')], env: { HOME: home } });
  await withApp(router, async (base) => {
    const q = (o) => fetch(`${base}/api/fs/list?${new URLSearchParams(o)}`);
    let r = await q({ path: home, mode: 'file', ext: 'm3u8,m3u' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    let j = await r.json();
    assert.strictEqual(j.path, home);
    assert.ok(j.entries.some((e) => e.name === 'road trip.m3u8'));
    assert.ok(!j.entries.some((e) => e.name === 'readme.txt'));
    assert.strictEqual(j.places[0].items[0].label, 'Home');
    assert.ok(j.places.some((g) => g.group === 'In your library'));
    j = await (await q({ path: home, hidden: '1' })).json();
    assert.ok(j.entries.some((e) => e.name === '.hidden'));
    j = await (await q({ path: home, mode: 'bogus' })).json();
    assert.ok(j.entries.every((e) => e.dir), 'an unknown mode lists folders');
    j = await (await q({ mode: 'folder' })).json();
    assert.strictEqual(j.path, home, 'no path: the mode\'s usual place (HOME has no Videos here)');
    j = await (await q({ mode: 'exe' })).json();
    assert.strictEqual(j.places[0].group, 'Programs');
    for (const p of ['/proc', '/proc/self/root', '/sys', '/dev/shm', path.join(home, 'to-proc')]) {
      r = await q({ path: p });
      assert.strictEqual(r.status, 403, p);
      assert.ok((await r.json()).places, 'the rail still comes back');
    }
    assert.strictEqual((await q({ path: 'etc' })).status, 400);
    assert.strictEqual((await q({ path: path.join(home, 'nope') })).status, 404);
    assert.strictEqual((await fetch(`${base}/api/fs/list`, { method: 'POST' })).status, 404, 'read-only: GET only');
  });
});

/* ── Save As and picked paths off Windows ──────────────────────────────── */

test('checkSavePath (POSIX): absolute, normalized, .m3u/.m3u8, folder exists, no system folders, no links', { skip: LINUX }, () => {
  const root = makeTree();
  const v = path.join(root, 'Videos');
  assert.strictEqual(fsb.checkSavePath(path.join(v, 'New list.m3u8')), path.join(v, 'New list.m3u8'));
  assert.strictEqual(fsb.checkSavePath(path.join(v, 'Old.M3U')), path.join(v, 'Old.M3U'));
  assert.strictEqual(fsb.checkSavePath(path.join(v, 'road trip.m3u8')), path.join(v, 'road trip.m3u8'), 'replacing a playlist file');
  fs.symlinkSync('/dev/null', path.join(v, 'link.m3u8'));
  try {
    for (const bad of [
      'rel.m3u8', `${v}/../Videos/x.m3u8`, `${v}//x.m3u8`, `${v}/x.m3u8/`, `${v}/x.txt`, `${v}/x.m3u8.sh`,
      `${v}/x\n.m3u8`, '/proc/x.m3u8', '/dev/x.m3u8', '/sys/x.m3u8', `${v}/to-proc/x.m3u8`, `${v}/nope/x.m3u8`,
      `${v}/link.m3u8`, `${v}/Clips.m3u8/`, '', null, 42, `/${'a'.repeat(5000)}.m3u8`,
    ]) assert.strictEqual(fsb.checkSavePath(bad), null, String(bad));
    fs.mkdirSync(path.join(v, 'dir.m3u8'));
    assert.strictEqual(fsb.checkSavePath(path.join(v, 'dir.m3u8')), null, 'a folder named like a playlist');
  } finally {
    fs.rmSync(path.join(v, 'link.m3u8'), { force: true });
    fs.rmSync(path.join(v, 'dir.m3u8'), { recursive: true, force: true });
  }
});

test('checkPickedPath: Windows paths on Windows, plain absolute POSIX paths elsewhere', () => {
  const c = playlistRoutes.checkPickedPath;
  assert.strictEqual(c('C:\\Music\\a.m3u8', 'win32'), 'C:\\Music\\a.m3u8');
  assert.strictEqual(c('/home/u/a.m3u8', 'win32'), null);
  assert.strictEqual(c('/home/u/My list.m3u8', 'linux'), '/home/u/My list.m3u8');
  assert.strictEqual(c('/home/u/ünï.pls', 'darwin'), '/home/u/ünï.pls');
  for (const bad of ['C:\\Music\\a.m3u8', 'a.m3u8', '/home/u/../x.m3u8', '/home//u.m3u8', '/proc/self/fd/0', '/dev/stdin', '/a\nb', '', null]) {
    assert.strictEqual(c(bad, 'linux'), null, String(bad));
  }
});

test('playlist import off Windows: { path } from the in-app browser gets the picker\'s checks', async () => {
  let opened = 0;
  const router = playlistRoutes.buildRouter({
    platform: 'linux',
    spawnPicker: () => { opened++; },
    pickCancel: '::CANCEL::',
    runResolver: () => {},
    normalizeSelections: () => [],
    matchSelection: () => null,
    isLocked: () => false,
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    for (const bad of ['/proc/self/environ', 'relative.m3u8', '/a/../b.m3u8', '', 7]) {
      const r = await post('/api/playlists/import/pick', { path: bad });
      assert.strictEqual(r.status, 400, String(bad));
      assert.strictEqual((await r.json()).code, 'BAD_PATH');
    }
    const r = await post('/api/playlists/import/pick', { path: '/home/u/notes.txt' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual((await r.json()).code, 'BAD_FILE');
    // A drop whose path is not the dropped file is not used.
    const d = await post('/api/playlists/import/drop', { name: 'a.m3u8', size: 3, path: '/home/u/b.m3u8' });
    assert.deepStrictEqual(await d.json(), { unresolved: 'no matching path' });
    const d2 = await post('/api/playlists/import/drop', { name: 'a.m3u8', size: 3, path: '/proc/a.m3u8' });
    assert.deepStrictEqual(await d2.json(), { unresolved: 'no matching path' });
    assert.strictEqual(opened, 0, 'no dialog opened for a path from the page');
    // No path: the picker runs (here a fake that never answers, so the request is cut short).
    const ctl = new AbortController();
    const pending = fetch(`${base}/api/playlists/import/pick`, { method: 'POST', signal: ctl.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    await pending;
    assert.strictEqual(opened, 1);
  } finally {
    await new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });
  }
});

/* ── A drop's text/uri-list ────────────────────────────────────────────── */

test('decodeUriList: file:// URIs, percent-encoding, spaces, non-ASCII, localhost, comments, other hosts and schemes', () => {
  const list = [
    '# a comment from the file manager',
    'file:///home/u/My%20Videos/clip%201.mp4',
    'file://localhost/home/u/%C3%BCn%C3%AF%20code/%E2%9C%93.mkv',
    'FILE:///home/u/caps.mp4',
    'file:///home/u/100%25%20real.mp4',
    'file:///home/u/Folder/',
    'file://othermachine/share/x.mp4',
    'smb://nas/share/x.mp4',
    'https://example.com/x.mp4',
    'file:///bad%ZZ.mp4',
    'file:///nul%00.mp4',
    'file:///home/u/My%20Videos/clip%201.mp4',
    '',
  ].join('\r\n');
  assert.deepStrictEqual(decodeUriList(list), [
    '/home/u/My Videos/clip 1.mp4',
    '/home/u/ünï code/✓.mkv',
    '/home/u/caps.mp4',
    '/home/u/100% real.mp4',
    '/home/u/Folder',
  ]);
  assert.deepStrictEqual(decodeUriList(''), []);
  assert.deepStrictEqual(decodeUriList(null), []);
  assert.deepStrictEqual(decodeUriList('file:///'), ['/']);
});

test('dropPaths: real files and folders come back in resolve-drop\'s shape; system folders and odd paths are skipped', { skip: LINUX }, () => {
  const root = makeTree();
  const v = path.join(root, 'Videos');
  const r = fsb.dropPaths([path.join(v, 'Clips'), path.join(v, 'Clips/a.mp4'), '/proc/self/environ', path.join(v, 'to-proc'),
    `${v}/../Videos/readme.txt`, 'relative.mp4', path.join(v, 'missing.mp4'), 5]);
  assert.deepStrictEqual(r, { files: [{ path: path.join(v, 'Clips/a.mp4'), size: 0 }], dirs: [path.join(v, 'Clips')] });
  assert.deepStrictEqual(fsb.dropPaths([]), { unresolved: 'unsupported' });
  assert.deepStrictEqual(fsb.dropPaths(undefined), { unresolved: 'unsupported' });
  assert.deepStrictEqual(fsb.dropPaths(['/proc/1']), { unresolved: 'no readable paths' });
});
