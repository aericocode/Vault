'use strict';
/**
 * Linux support, first branch (LINUX_SPEC WP1 + WP2):
 *
 *  - lib/platform.js      CASE_INSENSITIVE_PATHS, opening the browser without a shell
 *  - case-sensitive paths on Linux: two files that differ only in case stay
 *    two rows / two matches (Cove mapping, move matching, missing-sweep holds,
 *    migrate's occupied check)
 *  - "too broad" folders off Windows (/home, /mnt, /media, /run/media/<user>)
 *  - the Python lookup order (lib/python-cmd.js)
 *  - the inotify limit (ENOSPC) as its own message
 *  - missing-sweep: an unmounted disk under /media, /run/media or /mnt is
 *    offline, not missing (/proc/mounts)
 *  - Stage: mpv a killed Vault left running is ended on the next start; the
 *    socket path fits in sun_path
 *
 * Tests that need a case-sensitive file system or Linux itself skip elsewhere.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-linux-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
delete process.env.VAULT_DB_PASSWORD;

const platform = require('../lib/platform');
const { pythonCommand } = require('../lib/python-cmd');

const LINUX = process.platform === 'linux';
const CASE_SENSITIVE = !platform.CASE_INSENSITIVE_PATHS;

test.after(() => {
  try { require('../lib/database').close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/* ── lib/platform.js ────────────────────────────────────────────────────── */

test('CASE_INSENSITIVE_PATHS: Windows and macOS fold case, Linux does not', () => {
  assert.strictEqual(platform.CASE_INSENSITIVE_PATHS, process.platform === 'win32' || process.platform === 'darwin');
  assert.strictEqual(platform.BACKSLASH_SEPARATES, process.platform === 'win32');
});

test('openUrl: start on Windows (as before), open on macOS, xdg-open elsewhere, never a shell', () => {
  const url = 'http://127.0.0.1:8765';
  const execs = [];
  assert.strictEqual(platform.openUrl(url, { platform: 'win32', execFn: (c) => execs.push(c), spawnFn: () => assert.fail('no spawn on Windows') }), 'start');
  assert.deepStrictEqual(execs, ['start "" "http://127.0.0.1:8765"'], 'the Windows command line is unchanged');

  for (const [plat, opener] of [['linux', 'xdg-open'], ['darwin', 'open'], ['freebsd', 'xdg-open']]) {
    const seen = [];
    const child = new EventEmitter();
    child.unref = () => { seen.push('unref'); };
    const got = platform.openUrl(url, {
      platform: plat,
      execFn: () => assert.fail('no exec off Windows'),
      spawnFn: (file, args, opts) => { seen.push({ file, args, opts }); return child; },
    });
    assert.strictEqual(got, opener);
    assert.deepStrictEqual(seen[0], { file: opener, args: [url], opts: { detached: true, stdio: 'ignore', shell: false } });
    assert.ok(seen.includes('unref'), 'Vault does not wait for the browser');
    child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));   // headless: no crash
  }
  // A spawn that throws outright is quiet too.
  assert.strictEqual(platform.openUrl(url, { platform: 'linux', spawnFn: () => { throw new Error('EACCES'); } }), 'xdg-open');
});

/* ── Two files that differ only in case ─────────────────────────────────── */

test('Cove mapping: A.mp4 and a.mp4 are two files on Linux, one on Windows and macOS; drive-letter paths always fold', () => {
  const M = require('../lib/cove/mapping');
  const item = (id, p) => ({ kind: 'video', id, files: [{ path: p, basename: path.posix.basename(p), size: 10 }], customFields: {}, details: {}, tagIds: [] });
  const cove = [item(1, '/media/A.mp4'), item(2, '/media/a.mp4')];
  const rows = [
    { id: 11, filepath: '/media/A.mp4', media_type: 'video', filesize_bytes: 10 },
    { id: 12, filepath: '/media/a.mp4', media_type: 'video', filesize_bytes: 10 },
  ];
  const r = M.matchItems(rows, M.buildCoveIndex(cove), []);
  if (CASE_SENSITIVE) {
    assert.deepStrictEqual(r.matches.map(m => [m.row.id, m.item.id, m.how]), [[11, 1, 'path'], [12, 2, 'path']]);
    assert.strictEqual(r.ambiguous.length, 0);
    assert.notStrictEqual(M.normPath('/media/A.mp4'), M.normPath('/media/a.mp4'));
  } else {
    assert.strictEqual(M.normPath('/media/A.mp4'), M.normPath('/media/a.mp4'));
  }
  assert.strictEqual(M.normPath('D:\\Media\\A.mp4'), M.normPath('d:/media/a.mp4'), 'a Windows path ignores case on any OS');
});

test('move matching: X.jpg and x.jpg share no name on Linux', () => {
  const { suffixLen } = require('../lib/watchers/catchup');
  assert.strictEqual(suffixLen('/a/b/x.jpg', '/c/b/x.jpg'), 2);
  assert.strictEqual(suffixLen('/a/b/X.jpg', '/c/b/x.jpg'), CASE_SENSITIVE ? 0 : 2);
});

test('migrate: a.mp4 on disk next to A.mp4 does not count as A.mp4 being taken (Linux)', { skip: !CASE_SENSITIVE }, async () => {
  const db = require('../lib/database');
  db.init();
  const migrate = require('../commands/migrate');
  const oldDir = path.join(tmp, 'old');
  const newDir = path.join(tmp, 'new');
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'A.mp4'), 'big A');
  fs.writeFileSync(path.join(newDir, 'a.mp4'), 'small a');
  const ins = db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
  const moving = Number(ins.run(path.join(oldDir, 'A.mp4'), 'A.mp4').lastInsertRowid);
  const other = Number(ins.run(path.join(newDir, 'a.mp4'), 'a.mp4').lastInsertRowid);
  const report = await migrate.planPrefix(oldDir, newDir);
  assert.deepStrictEqual(report.rewrite.map(r => [r.row.id, r.newPath]), [[moving, path.join(newDir, 'A.mp4')]]);
  assert.deepStrictEqual(report.conflict, [], `a.mp4 (row ${other}) is another file, not an occupant`);
});

test('missing sweep: a held folder holds only its own spelling on Linux', { skip: !LINUX }, async () => {
  const sweep = require('../lib/missing-sweep');
  const rows = [
    { id: 1, filepath: '/media/me/Disk/Held/a.mp4', missing_since: null },
    { id: 2, filepath: '/media/me/Disk/held/b.mp4', missing_since: null },
  ];
  const marked = [];
  const out = await sweep.sweep(fakeSweepDeps(rows, {
    mounts: [{ dir: '/media/me/Disk', type: 'ext4' }],
    exist: new Set(['/media/me/Disk']),
    marked,
    holdRoots: ['/media/me/Disk/Held'],
  }));
  assert.deepStrictEqual(marked, [2], 'held/ is another folder: its missing file is marked');
  assert.strictEqual(out.count, 1);
});

/* ── Too broad to watch ─────────────────────────────────────────────────── */

test('watching /, /home, /mnt, /media or a user\'s mount folder needs a confirm off Windows', { skip: process.platform === 'win32' }, () => {
  const rules = require('../lib/watchers/rules');
  for (const p of ['/', '/home', '/home/', '/mnt', '/media', '/media/me', '/run/media', '/run/media/me', '/Users', '/Volumes']) {
    assert.ok(rules.isDriveRoot(p), p);
  }
  for (const p of ['/home/me', '/home/me/Videos', '/mnt/usb', '/media/me/Disk', '/run/media/me/Disk', '/srv']) {
    assert.ok(!rules.isDriveRoot(p), p);
  }
});

/* ── Python ─────────────────────────────────────────────────────────────── */

test('python: PYTHON_PATH, then (off Windows) venv/bin/python, python3, python; Windows stays `python`', () => {
  const root = '/opt/vault';
  const has = (...files) => (p) => files.includes(p);
  assert.strictEqual(pythonCommand({ env: { PYTHON_PATH: '/x/py' }, platform: 'linux', root, exists: has() }), '/x/py');
  assert.strictEqual(pythonCommand({ env: { PYTHON_PATH: 'C:\\py\\python.exe' }, platform: 'win32', root, exists: has() }), 'C:\\py\\python.exe');
  assert.strictEqual(pythonCommand({ env: { PATH: '/usr/bin' }, platform: 'linux', root,
    exists: has('/opt/vault/venv/bin/python', '/usr/bin/python3') }), '/opt/vault/venv/bin/python');
  assert.strictEqual(pythonCommand({ env: { PATH: '/usr/local/bin:/usr/bin' }, platform: 'linux', root,
    exists: has('/usr/bin/python3', '/usr/local/bin/python') }), 'python3', 'python3 first, wherever python is');
  assert.strictEqual(pythonCommand({ env: { PATH: '/usr/bin' }, platform: 'darwin', root, exists: has('/usr/bin/python') }), 'python');
  assert.strictEqual(pythonCommand({ env: { PATH: '/usr/bin' }, platform: 'linux', root, exists: has() }), 'python3', 'nothing found: python3, so the error names it');
  // Windows: unchanged, even with a venv next to Vault (a dev checkout can hold a stale one).
  assert.strictEqual(pythonCommand({ env: { PATH: 'C:\\Python' }, platform: 'win32', root: 'C:\\Vault',
    exists: () => true }), 'python');
});

/* ── Watching: the inotify limit ────────────────────────────────────────── */

test('ENOSPC from a watch says how to raise the Linux limit; elsewhere the general message', () => {
  const { plainError } = require('../lib/watchers/manager');
  const msg = plainError('ENOSPC');
  if (LINUX) {
    assert.match(msg, /sudo sysctl fs\.inotify\.max_user_watches=524288/);
    assert.match(msg, /\/etc\/sysctl\.conf/);
  } else {
    assert.strictEqual(msg, 'Could not read this folder. Vault will try again.');
  }
  assert.ok(!/[–—]/.test(msg), 'no em dash');
  assert.strictEqual(plainError('EMFILE'), 'Too many files are open right now. Vault will try again.');
});

/* ── Missing sweep: unmounted disks are offline ─────────────────────────── */

test('/proc/mounts is read with its escapes; volumes are mount points under /media, /run/media, /mnt', () => {
  const sweep = require('../lib/missing-sweep');
  const mounts = sweep.readMounts([
    '/dev/sda2 / ext4 rw 0 0',
    '/dev/sdb1 /media/me/My\\040Disk vfat rw 0 0',
    '/dev/sdc1 /run/media/me/USB exfat rw 0 0',
    '//nas/share /mnt/nas cifs rw 0 0',
    'proc /proc proc rw 0 0',
  ].join('\n'));
  assert.deepStrictEqual(mounts.map(m => m.dir), ['/', '/media/me/My Disk', '/run/media/me/USB', '/mnt/nas', '/proc']);
  const vol = (p) => sweep.linuxVolumeOf(p, mounts);
  assert.strictEqual(vol('/media/me/My Disk/clips/a.mp4'), '/media/me/My Disk');
  assert.strictEqual(vol('/run/media/me/USB/a.mp4'), '/run/media/me/USB');
  assert.strictEqual(vol('/mnt/nas/x/a.mp4'), '/mnt/nas');
  assert.strictEqual(vol('/media/me/Gone/a.mp4'), '/media/me/Gone', 'not mounted: still its own volume');
  assert.strictEqual(vol('/mnt/usb/a.mp4'), '/mnt/usb');
  assert.strictEqual(vol('/home/me/Videos/a.mp4'), '/');
  assert.strictEqual(vol('/media/a.mp4'), '/', 'a file right in /media is on the root disk');
  assert.strictEqual(vol('/proc/x'), '/proc', 'any mount is a volume, not only removable ones');
});

test('volumes come from the mount table at any depth: /mnt/disks/usb1, /media/Disk; autofs alone is not mounted', () => {
  const sweep = require('../lib/missing-sweep');
  const vol = (p, more = []) => sweep.linuxVolumeOf(p, [{ dir: '/', type: 'ext4' }, { dir: '/run', type: 'tmpfs' }, ...more]);
  assert.strictEqual(vol('/mnt/disks/usb1/a.mp4', [{ dir: '/mnt/disks/usb1', type: 'ext4' }]), '/mnt/disks/usb1');
  assert.strictEqual(vol('/mnt/disks/usb1/a.mp4'), '/mnt/disks', 'unplugged: not a mount point, so offline');
  assert.strictEqual(vol('/media/Disk/a.mp4', [{ dir: '/media/Disk', type: 'ext4' }]), '/media/Disk');
  assert.strictEqual(vol('/media/Disk/a.mp4'), '/media/Disk');
  assert.strictEqual(vol('/run/media/me/USB/a.mp4'), '/run/media/me/USB', 'only /run holds it: unplugged');
  assert.strictEqual(vol('/mnt/usb/a.mp4', [{ dir: '/mnt/usb', type: 'autofs' }]), '/mnt/usb');
  assert.strictEqual(vol('/mnt/usb/a.mp4', [{ dir: '/mnt', type: 'ext4' }]), '/mnt', 'a disk mounted on /mnt itself');
  assert.strictEqual(sweep.linuxVolumeOf('/mnt/usb/a.mp4', []), '/mnt/usb', '/proc/mounts unread: under /mnt counts as unplugged');
});

test('a disk mounted deeper than one level and unplugged (its empty folder left behind): nothing on it is marked', { skip: !LINUX }, async () => {
  const sweep = require('../lib/missing-sweep');
  const rows = [
    { id: 1, filepath: '/mnt/disks/usb1/a.mp4', missing_since: null },
    { id: 2, filepath: '/mnt/disks/usb1/sub/b.mp4', missing_since: null },
    { id: 3, filepath: '/home/me/c.mp4', missing_since: null },
  ];
  const marked = [];
  const out = await sweep.sweep(fakeSweepDeps(rows, {
    mounts: [{ dir: '/', type: 'ext4' }],
    exist: new Set(['/', '/mnt/disks', '/mnt/disks/usb1']),    // the folders are there, the files are not
    marked,
  }));
  assert.deepStrictEqual(marked, [3], 'only the file on / is marked');
  assert.ok(out.skipped.includes('/mnt/disks'));
});

test('a disk mounted one level under /media (fstab, usbmount): a deleted file is marked while it is mounted, nothing when it is not', { skip: !LINUX }, async () => {
  const sweep = require('../lib/missing-sweep');
  const rows = [
    { id: 1, filepath: '/media/Disk/a.mp4', missing_since: null },
    { id: 2, filepath: '/media/Disk/clips/b.mp4', missing_since: null },
  ];
  const mounted = [];
  await sweep.sweep(fakeSweepDeps(rows, {
    mounts: [{ dir: '/', type: 'ext4' }, { dir: '/media/Disk', type: 'ext4' }],
    exist: new Set(['/', '/media/Disk', '/media/Disk/clips/b.mp4']),
    marked: mounted,
  }));
  assert.deepStrictEqual(mounted, [1], 'mounted: the deleted file is marked, the other is not');
  const absent = [];
  const out = await sweep.sweep(fakeSweepDeps(rows, {
    mounts: [{ dir: '/', type: 'ext4' }],
    exist: new Set(['/', '/media/Disk']),
    marked: absent,
  }));
  assert.deepStrictEqual(absent, [], 'not mounted: nothing marked');
  assert.ok(out.skipped.includes('/media/Disk'));
});

/** Deps for sweep(): rows in a fake DB, a fake checker, marks recorded. */
function fakeSweepDeps(rows, { mounts, exist, marked, cleared = [], auto = false, types, holdRoots }) {
  const db = {
    prepare: () => ({ all: (after) => rows.filter(r => r.id > after) }),
  };
  return {
    getDb: () => db,
    stopped: () => false,
    store: {
      markMissing: (list) => { for (const x of list) marked.push(x.id); },
      clearMissing: (list) => { for (const x of list) cleared.push(x.id); },
    },
    checker: { check: async (paths) => paths.map(p => exist.has(p)) },
    mounts, auto, types, holdRoots,
  };
}

test('an unplugged USB disk (Linux): its rows are left alone, like an offline Windows drive', { skip: !LINUX }, async () => {
  const sweep = require('../lib/missing-sweep');
  const rows = [
    { id: 1, filepath: '/media/me/USB/a.mp4', missing_since: null },
    { id: 2, filepath: '/media/me/USB/b.mp4', missing_since: 123 },
    { id: 3, filepath: '/media/me/Disk/c.mp4', missing_since: null },
    { id: 4, filepath: '/home/me/d.mp4', missing_since: null },
  ];
  const marked = [];
  const out = await sweep.sweep(fakeSweepDeps(rows, {
    mounts: [{ dir: '/', type: 'ext4' }, { dir: '/media/me/Disk', type: 'ext4' }],
    exist: new Set(['/', '/media/me/Disk']),
    marked,
  }));
  assert.deepStrictEqual(marked.sort(), [3, 4], 'missing on a mounted disk and on / are marked');
  assert.ok(out.skipped.includes('/media/me/USB'), 'the unplugged disk is skipped');
  assert.strictEqual(out.count, 3, 'two marked now + the USB row that was already marked');
  // The automatic sweep leaves removable disks (/media) alone even when mounted, as on Windows.
  const marked2 = [];
  await sweep.sweep(fakeSweepDeps(rows, {
    mounts: [{ dir: '/', type: 'ext4' }, { dir: '/media/me/Disk', type: 'ext4' }],
    exist: new Set(['/', '/media/me/Disk']), marked: marked2,
    auto: true, types: new Map([['/media/me/Disk', 2]]),
  }));
  assert.deepStrictEqual(marked2, [4]);
});

/* ── Stage: mpv left behind by a killed Vault ───────────────────────────── */

test('reapStale: ends an mpv whose Vault is gone, only if it is that mpv; leaves a live Vault\'s alone', () => {
  const { reapStale } = require('../lib/stage/mpv-host');
  const base = fs.mkdtempSync(path.join(tmp, 'stage-'));
  const mk = (name, rec) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir);
    if (rec) fs.writeFileSync(path.join(dir, 'mpv.pid'), JSON.stringify(rec));
    return dir;
  };
  const stale = mk('vault-stage-aaaaaa', { vault: 101, mpv: 201 });
  const reused = mk('vault-stage-bbbbbb', { vault: 102, mpv: 202 });     // pid 202 is something else now
  const live = mk('vault-stage-cccccc', { vault: 103, mpv: 203 });       // a second Vault, still running
  const nopid = mk('vault-stage-dddddd', null);
  const other = mk('not-vault', { vault: 104, mpv: 204 });
  const alive = new Set([201, 202, 103, 203, 204]);
  const killed = [];
  const n = reapStale(base, {
    isAlive: (pid) => alive.has(pid),
    cmdline: (pid) => (pid === 201 ? `mpv --input-ipc-server=${path.join(stale, 'mpv.sock')} --idle` : pid === 202 ? 'bash' : ''),
    kill: (pid) => killed.push(pid),
  });
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(killed, [201]);
  assert.ok(!fs.existsSync(stale) && !fs.existsSync(reused), 'stale folders removed');
  assert.ok(fs.existsSync(live) && fs.existsSync(nopid) && fs.existsSync(other), 'the rest left alone');
});

test('the mpv socket path fits sun_path: a long TMPDIR falls back to /tmp', () => {
  const { socketBase } = require('../lib/stage/mpv-host');
  assert.strictEqual(socketBase('/tmp'), '/tmp');
  assert.strictEqual(socketBase('/run/user/1000'), '/run/user/1000');
  const long = '/home/someone/' + 'x'.repeat(80);
  assert.strictEqual(socketBase(long), '/tmp');
});

test('off Windows, Stage writes mpv\'s pid next to its socket', { skip: process.platform === 'win32' }, async () => {
  const { makeIpcPath } = require('../lib/stage/mpv-host');
  const ipc = makeIpcPath('linux');
  try {
    assert.ok(Buffer.byteLength(ipc.path) <= 103, ipc.path);
    ipc.recordPid(4242);
    const rec = JSON.parse(fs.readFileSync(path.join(path.dirname(ipc.path), 'mpv.pid'), 'utf8'));
    assert.deepStrictEqual(rec, { vault: process.pid, mpv: 4242 });
  } finally { ipc.cleanup(); }
});
