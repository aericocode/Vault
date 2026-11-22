/**
 * Share privately: nothing about the library is left behind in share_temp
 * (review finding 1). Real 7-Zip when present, a real library, no network.
 *
 * Covered:
 *  - The reproduction from the review: a file in the work folder held open
 *    by another program (Windows: a PowerShell handle without delete
 *    sharing). Cancel answers removed, but the record is NOT dropped while
 *    the folder is still there: it stays hidden as 'removing', keeping the
 *    folder's name. Once the handle is gone the clean-up deletes the folder,
 *    then the record.
 *  - pack() deletes list.txt and stage/ on a failure and on a cancel, not
 *    only on success.
 *  - A live share (checked) never keeps a list.txt or stage/: the clean-up
 *    deletes them and keeps the archive.
 *  - The sweep: a work folder no record names is deleted only when its
 *    marker names this library; another library's folder, an unmarked one,
 *    and anything while locked are left alone.
 *  - Lock while packing: hidden at once, the record goes once the folder is.
 *  - Exit while packing (shutdown): 7-Zip is stopped and the folder deleted.
 *  - Outside Windows: share_temp and work folders 0700, files 0600.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-cleanup-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_SHARE_TEMP = path.join(tmp, 'share_temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const config = require('../config');
const db = require('../lib/database');
const vault = require('../lib/vault');
const store = require('../lib/share/store');
const settings = require('../lib/share/settings');
const temp = require('../lib/share/temp');
const pack = require('../lib/share/pack');
const sevenzip = require('../lib/share/sevenzip');
const service = require('../lib/share/service');

const skip7z = sevenzip.locate() ? false : 'no 7-Zip program found';
const IS_WIN = process.platform === 'win32';
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('no real request in this test'); };

const MEDIA = path.join(tmp, 'media');
let smallIds = [];
let bigId = null;

// Filler bytes, not real videos: the personal details check (every share)
// rightly calls them "could not be checked" and stops the share. These tests
// are about packing and clean-up, so their shares start with Remove off.
function addMedia(name, bytes, { sparse = false } = {}) {
  const p = path.join(MEDIA, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (sparse) { const fd = fs.openSync(p, 'w'); fs.ftruncateSync(fd, bytes); fs.closeSync(fd); }
  else fs.writeFileSync(p, Buffer.alloc(bytes, 7));
  return Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')").run(p, name).lastInsertRowid);
}

test.before(async () => {
  db.init();
  config.net.offline = true;
  // Two files with one name, so packing stages one under "clip (2).mp4".
  smallIds = [addMedia('a/clip.mp4', 3000), addMedia('b/clip.mp4', 2000)];
  bigId = addMedia('big.bin', 3 * 1024 ** 3, { sparse: true });
  await service.updateSettings({ enabled: true, rememberPasswords: false, split: 'none' }, { confirm: true });
  service.ensureRecovered();
});
test.after(async () => {
  globalThis.fetch = realFetch;
  await service._idle();
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(20);
  }
}
const workDirOf = (id) => store.getShare(id).work_dir;

/**
 * Hold `file` open the way a scanner or a preview can: another process,
 * Windows sharing that refuses delete. Resolves { release } once it holds.
 */
function holdOpen(file) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `$f = [IO.File]::Open('${file.replace(/'/g, "''")}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $f.Close()`],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    ps.stdout.on('data', (b) => {
      out += b;
      if (out.includes('held')) {
        resolve({ release: () => new Promise((r) => { ps.on('close', r); ps.stdin.end('\n'); }) });
      }
    });
    ps.on('error', reject);
    ps.on('close', (code) => { if (!out.includes('held')) reject(new Error(`could not hold the file (${code})`)); });
  });
}

test('reproduction: a file held open in the work folder; Cancel keeps the hidden record until the folder is really gone', { skip: skip7z || (IS_WIN ? false : 'needs Windows file sharing rules') }, async () => {
  const share = service.start({ mediaIds: smallIds, removePersonal: false });
  await waitFor(() => ['checked', 'failed'].includes(service.progress(share.id).status));
  assert.strictEqual(service.progress(share.id).status, 'checked');
  const name = workDirOf(share.id);
  const dir = temp.workDirPath(name);
  // What a pack cut short leaves: the list of original paths.
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, path.join(MEDIA, 'a', 'clip.mp4') + '\n');
  const h = await holdOpen(list);
  let released = false;
  try {
    const r = await service.cancel(share.id);
    assert.deepStrictEqual(r, { removed: true });
    // Gone for the page...
    assert.ok(!service.listShares().some(s => s.id === share.id));
    assert.throws(() => service.getShare(share.id), { code: 'NOT_FOUND' });
    // ...but the folder is still there, so the record is too, with its name.
    assert.ok(fs.existsSync(list), 'the held file is still there');
    const row = store.getShare(share.id);
    assert.ok(row, 'the record was dropped while its folder still exists');
    assert.strictEqual(row.status, 'removing');
    assert.strictEqual(row.work_dir, name);
    // A clean-up while it is still held changes nothing.
    await service._cleanupNow();
    assert.ok(store.getShare(share.id));
    await h.release();
    released = true;
    await service._cleanupNow();
    assert.ok(!fs.existsSync(dir), 'the folder was deleted once released');
    assert.strictEqual(store.getShare(share.id), null, 'and then the record');
  } finally {
    if (!released) await h.release();
  }
});

test('pack deletes list.txt and stage/ when 7-Zip fails, and when packing is cancelled', async () => {
  const files = smallIds.map(id => db.get().prepare('SELECT filepath FROM media WHERE id = ?').get(id).filepath)
    .map((fp, i) => ({ mediaId: smallIds[i], filepath: fp, size: fs.statSync(fp).size }));
  const p = pack.plan(files, { partBytes: null });
  assert.ok(p.entries.some(e => e.stage), 'one file is staged');
  // A "7-Zip" that fails at once: the Node program, which cannot run a script named "a".
  const wd = temp.createWorkDir();
  await assert.rejects(pack.pack({ entries: p.entries, workDir: wd.dir, archiveName: 'Fails', password: 'Pass-Word-1234', program: process.execPath }), { code: 'PACK_FAILED' });
  assert.deepStrictEqual(fs.readdirSync(wd.dir).filter(n => n === 'list.txt' || n === 'stage'), []);
  // Cancelled while staging.
  const wd2 = temp.createWorkDir();
  const handle = { cancelled: false };
  const run = pack.pack({ entries: p.entries, workDir: wd2.dir, archiveName: 'Cancel', password: 'Pass-Word-1234', handle, program: process.execPath,
    onProgress: ({ phase }) => { if (phase === 'staging') handle.cancelled = true; } });
  await assert.rejects(run, { code: 'CANCELLED' });
  assert.deepStrictEqual(fs.readdirSync(wd2.dir).filter(n => n === 'list.txt' || n === 'stage'), []);
});

test('a live share never keeps list.txt or stage/: the clean-up deletes them and keeps the archive', { skip: skip7z }, async () => {
  const share = service.start({ mediaIds: smallIds, removePersonal: false });
  await waitFor(() => service.progress(share.id).status === 'checked');
  const dir = temp.workDirPath(workDirOf(share.id));
  const archive = path.join(dir, `${share.archiveName}.7z`);
  assert.ok(fs.existsSync(archive));
  assert.ok(!fs.existsSync(path.join(dir, 'list.txt')), 'packing left its list');
  // As if a held file had kept them after packing.
  fs.writeFileSync(path.join(dir, 'list.txt'), 'C:\\library\\clip.mp4\n');
  fs.mkdirSync(path.join(dir, 'stage'));
  fs.writeFileSync(path.join(dir, 'stage', 'clip (2).mp4'), 'x');
  await service._cleanupNow();
  assert.ok(!fs.existsSync(path.join(dir, 'list.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'stage')));
  assert.ok(fs.existsSync(archive), 'the archive stays for the upload');
  assert.strictEqual(service.progress(share.id).status, 'checked');
  await service.cancel(share.id);
  assert.ok(!fs.existsSync(dir));
});

test('sweep: only this library\'s unnamed folders go, only while unlocked', async () => {
  const lib = store.kvGet('library_id');
  assert.match(lib, /^[0-9a-f]{32}$/, 'a share made the library id');
  const mine = temp.createWorkDir(lib);
  fs.writeFileSync(path.join(mine.dir, 'list.txt'), 'C:\\library\\secret.mp4\n');
  const other = temp.createWorkDir('0'.repeat(32));
  const unmarked = temp.createWorkDir();
  // Locked: nothing is swept.
  vault._locked = true;
  try {
    await service._cleanupNow();
    assert.ok(fs.existsSync(mine.dir));
  } finally {
    vault._locked = false;
  }
  await service._cleanupNow();
  assert.ok(!fs.existsSync(mine.dir), 'this library\'s leftover was swept');
  assert.ok(fs.existsSync(other.dir), 'another library\'s folder is left alone');
  assert.ok(fs.existsSync(unmarked.dir), 'a folder without a marker is left alone');
  // A folder a record names is never swept.
  const named = temp.createWorkDir(lib);
  const id = store.insertShare({ archive_name: 'Named', status: 'checked', created_at: Date.now(), work_dir: named.name });
  await service._cleanupNow();
  assert.ok(fs.existsSync(named.dir));
  store.updateShare(id, { status: 'removing' });
  await service._cleanupNow();
  assert.ok(!fs.existsSync(named.dir));
  assert.strictEqual(store.getShare(id), null);
  fs.rmSync(other.dir, { recursive: true, force: true });
  fs.rmSync(unmarked.dir, { recursive: true, force: true });
});

test('lock while packing: hidden at once; after the unlock the folder and then the record go', { skip: skip7z }, async () => {
  const share = service.start({ mediaIds: [bigId], removePersonal: false });
  await waitFor(() => { const p = service.progress(share.id); return p.status !== 'packing' || p.packing.phase === 'packing'; });
  const name = workDirOf(share.id);
  vault._locked = true;
  vault._notify('locking');
  assert.strictEqual(store.getShare(share.id).status, 'removing');
  assert.strictEqual(store.getShare(share.id).work_dir, name, 'the record keeps the folder name');
  vault._notify('locked');
  // The killed 7-Zip ends and its folder is deleted, still locked.
  await waitFor(() => !fs.existsSync(temp.workDirPath(name)), 20000);
  vault._locked = false;
  vault._notify('unlocked');
  service.ensureRecovered();
  await service._idle();
  assert.strictEqual(store.getShare(share.id), null);
});

test('exit while packing: 7-Zip is stopped and the work folder deleted', { skip: skip7z }, async () => {
  const share = service.start({ mediaIds: [bigId], removePersonal: false });
  await waitFor(() => { const p = service.progress(share.id); return p.status !== 'packing' || p.packing.phase === 'packing'; });
  assert.strictEqual(service.progress(share.id).status, 'packing', 'still packing when Vault exits');
  const dir = temp.workDirPath(workDirOf(share.id));
  const t0 = Date.now();
  await service.shutdown();
  assert.ok(!fs.existsSync(dir), 'the work folder was deleted');
  assert.ok(Date.now() - t0 < 15000);
  // The next start finds the record and drops it.
  service._simulateRestart();
  service.ensureRecovered();
  await service._idle();
  assert.strictEqual(store.getShare(share.id), null);
});

test('outside Windows: share_temp and work folders are 0700, the marker 0600', { skip: IS_WIN ? 'Windows folders take the rights of the Vault folder' : false }, () => {
  const wd = temp.createWorkDir('1'.repeat(32));
  assert.strictEqual(fs.statSync(temp.root()).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(wd.dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(wd.dir, temp.LIBRARY_MARKER)).mode & 0o777, 0o600);
  fs.rmSync(wd.dir, { recursive: true, force: true });
});
