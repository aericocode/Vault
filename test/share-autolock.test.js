/**
 * Share privately and the automatic lock (lib/vault.js autolock holds,
 * lib/share/service.js isWorking).
 *
 * A beta tester saw the idle lock fire in the middle of a long pack or
 * upload and cut it short. The automatic lock now waits while a share is
 * WORKING (7-Zip packing or checking, an upload sending or waiting in line),
 * and only then; a manual lock still locks at once and cancels or pauses it.
 *
 * Covered:
 *  - the vault side: a hold puts off the autolock without counting as
 *    activity, never makes lock() refuse, and a hold that throws is no hold;
 *  - held while packing, held while uploading (and while a second upload
 *    waits in line); not held for checked, paused, not_finished or failed
 *    shares; the lock comes on the next tick once the work ends;
 *  - the bound: a pack or an upload with no sign of life for STALL_MS no
 *    longer holds, and the idle lock then cancels or pauses it;
 *  - a manual lock over HTTP, sent the way the lock button's first click
 *    sends it ({force:false}), locks at once during a pack and during an
 *    upload: packing cancelled, upload paused.
 *
 * Real encryption on a throwaway library. 7-Zip is replaced by a fake
 * pack.pack / pack.runChecks the test drives, and gofile by a fake client.
 * No request leaves the machine (the global fetch fails the test for
 * anything but this test's own server).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-autolock-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_SHARE_TEMP = path.join(tmp, 'share_temp');
delete process.env.VAULT_DB_PASSWORD;

const config = require('../config');
const db = require('../lib/database');
const vault = require('../lib/vault');
const store = require('../lib/share/store');
const settings = require('../lib/share/settings');
const temp = require('../lib/share/temp');
const names = require('../lib/share/names');
const pack = require('../lib/share/pack');
const service = require('../lib/share/service');
const { app } = require('../server/index');

const VAULT_PASS = 'vault-pass-autolock';
const TOKEN = 'TOKEN-autolock-0123456789abcdef';

const realFetch = globalThis.fetch;
let strayFetches = 0;
let server;
let base;
let cipher = true;
let savedMinutes;

/* ── A fake 7-Zip: pack.pack waits until the test lets it end ──────────── */

const realPack = pack.pack;
const realChecks = pack.runChecks;
let packing = null;   // { finish(), beat(), opts } of the pack running now
let packCalls = [];   // every pack started, in order (the pack line)

const fakePackFn = (o) => new Promise((resolve, reject) => {
  o.onProgress && o.onProgress({ phase: 'packing', percent: 0 });
  const cancelled = () => reject(Object.assign(new Error('Packing was cancelled.'), { code: 'CANCELLED' }));
  o.handle.kill = () => { o.handle.kill = null; cancelled(); };
  packing = {
    opts: o,
    done: false,
    beat: () => { o.onProgress({ phase: 'packing', percent: 50 }); o.onActivity && o.onActivity(); },
    // 7-Zip died with no output (a hang that ended): no evidence at all.
    fail: (err) => { if (entry.done) return; entry.done = true; o.handle.kill = null; reject(err); },
    finish: () => {
      if (entry.done) return;
      entry.done = true;
      o.handle.kill = null;
      if (o.handle.cancelled) { cancelled(); return; }
      const fileName = `${o.archiveName}.7z`;
      const p = path.join(o.workDir, fileName);
      fs.writeFileSync(p, Buffer.alloc(500, 3));
      const st = fs.statSync(p);
      resolve([{ partNo: 1, fileName, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) }]);
    },
  };
  const entry = packing;
  packCalls.push(entry);
});
pack.pack = fakePackFn;
const fakeChecks = async (o) => {
  o.onActivity && o.onActivity();
  return { ok: true, test: { ok: true }, listWithoutPassword: { ok: true }, contents: { ok: true }, parts: { ok: true, count: o.parts.length } };
};
pack.runChecks = fakeChecks;

/* ── A fake gofile: each part waits until the test lets it go ─────────── */

function deferred() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  return { p, resolve };
}

function fakeClient() {
  const c = {
    calls: [],
    uploads: [],   // { o, go: deferred } per part in flight
    async createAccount() { c.calls.push('account'); return { token: TOKEN }; },
    async uploadPart(o) {
      c.calls.push(`upload ${o.fileName}`);
      const go = deferred();
      const entry = { o, go };
      c.uploads.push(entry);
      const aborted = new Promise((r) => { if (o.signal.aborted) r(); else o.signal.addEventListener('abort', r, { once: true }); });
      const how = await Promise.race([go.p, aborted]);
      if (o.signal.aborted) throw Object.assign(new Error('Stopped.'), { code: 'ABORTED' });
      if (how && how.fail) throw how.fail;   // go.resolve({ fail }): the part fails that way
      o.onBytes && o.onBytes(o.size);
      return { fileId: `file-${o.fileName}`, folderId: 'folder-1', code: 'Code1', link: 'https://gofile.io/d/Code1', md5: 'x' };
    },
    async setExpiry() { c.calls.push('expiry'); },
    async deleteContent() { c.calls.push('delete'); },
  };
  service._setForTest({ client: c, sleep: () => Promise.resolve() });
  return c;
}

/* ── Setup ─────────────────────────────────────────────────────────────── */

const MEDIA = path.join(tmp, 'media');
let mediaId = null;

test.before(async () => {
  db.init();
  cipher = typeof db.get().pragma === 'function' && db.get().pragma('cipher', { simple: true }) != null;
  // The real interval stays out of the way; the test runs the ticks itself.
  clearInterval(vault._timer);
  savedMinutes = config.security.autolockMinutes;
  config.security.autolockMinutes = 1;
  config.net.offline = false;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    strayFetches++;
    return Promise.reject(new Error('no real request in this test'));
  };
  if (cipher) await vault.setPassword(VAULT_PASS);
  fs.mkdirSync(MEDIA, { recursive: true });
  const p = path.join(MEDIA, 'clip.mp4');
  fs.writeFileSync(p, Buffer.alloc(4000, 9));
  mediaId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')").run(p, 'clip.mp4').lastInsertRowid);
  settings.save({ ...settings.DEFAULTS, enabled: true, rememberPasswords: false, split: 'none' });
  service._setForTest({ program: 'fake-7zip' });
  service.ensureRecovered();
});

test.after(async () => {
  globalThis.fetch = realFetch;
  pack.pack = realPack;
  pack.runChecks = realChecks;
  if (vault.isLocked()) vault.unlock(VAULT_PASS);
  await service._idle();
  service._setForTest({ client: null, sleep: null, now: null, program: null });
  config.security.autolockMinutes = savedMinutes;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { require('../lib/secure-assets').close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test.afterEach(async () => {
  // Shares waiting to pack first, so finishing the pack starts nothing new.
  if (!vault.isLocked()) {
    for (const r of store.listShares()) if (r.status === 'queued') { try { await service.cancel(r.id); } catch {} }
  }
  if (packing) { try { packing.finish(); } catch {} packing = null; }
  packCalls = [];
  pack.runChecks = fakeChecks;
  config.net.offline = false;
  settings.save({ ...settings.DEFAULTS, enabled: true, rememberPasswords: false, split: 'none' });
  if (vault.isLocked()) vault.unlock(VAULT_PASS);
  await service._idle();
  service._setForTest({ now: null });
  for (const r of store.listShares()) {
    try { await temp.removeWorkDir(r.work_dir); } catch {}
    store.deleteShare(r.id);
  }
  assert.strictEqual(strayFetches, 0, 'a real request was made');
});

/* ── Helpers ───────────────────────────────────────────────────────────── */

const immediate = () => new Promise(r => setImmediate(r));
async function until(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 2));
  }
  assert.ok(cond(), `waited for: ${what}`);
}
/** The user has been away longer than the autolock time. */
function idle() { vault._lastActivity = Date.now() - 5 * 60 * 1000; }
const statusOf = (id) => store.getShare(id).status;

/** A share that passed its checks, with real part files on disk. */
function makeChecked({ parts = 1, folderId = null } = {}) {
  const wd = temp.createWorkDir();
  const name = names.randomArchiveName();
  const list = [];
  for (let i = 1; i <= parts; i++) {
    const fileName = parts > 1 ? `${name}.7z.${String(i).padStart(3, '0')}` : `${name}.7z`;
    const p = path.join(wd.dir, fileName);
    fs.writeFileSync(p, Buffer.alloc(800, i));
    const st = fs.statSync(p);
    list.push({ partNo: i, fileName, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
  }
  const id = store.insertShare({
    archive_name: name, password: null, password_kind: 'random', size: 800 * parts,
    part_count: parts, part_size: 800, file_count: 1, status: 'checked', created_at: Date.now(),
    delete_after_days: 7, work_dir: wd.name, checks: JSON.stringify({ ok: true }),
  });
  store.setParts(id, list);
  // Later parts of an upload that already made its folder go up two at a time.
  if (folderId) store.updateShare(id, { folder_id: folderId });
  return id;
}

async function post(p, body) {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/* ── The vault side ────────────────────────────────────────────────────── */

test('vault: a hold puts off the autolock, is not activity, never blocks lock(); a throwing hold is no hold', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  let held = true;
  vault.registerAutolockHold('test-hold', () => held);
  try {
    idle();
    const before = vault._lastActivity;
    assert.strictEqual(await vault._autolockTick(), false, 'held: no lock');
    assert.strictEqual(vault.isLocked(), false);
    assert.strictEqual(vault._lastActivity, before, 'a hold is not activity');
    assert.strictEqual(vault.status().scanActive, false, 'a hold is not a scan');
    // lock() ignores holds: a non-forced lock goes through.
    await vault.lock({ force: false });
    assert.strictEqual(vault.isLocked(), true);
    vault.unlock(VAULT_PASS);
    // A hold that throws never keeps the vault open.
    vault.registerAutolockHold('test-hold', () => { throw new Error('broken'); });
    idle();
    assert.strictEqual(await vault._autolockTick(), true);
    assert.strictEqual(vault.isLocked(), true);
    vault.unlock(VAULT_PASS);
    // The hold ends: the next tick locks (the idle clock kept running).
    vault.registerAutolockHold('test-hold', () => held);
    idle();
    assert.strictEqual(await vault._autolockTick(), false);
    held = false;
    assert.strictEqual(await vault._autolockTick(), true);
  } finally {
    vault._holds.delete('test-hold');
  }
});

test('the share service registered its hold', () => {
  assert.ok(vault._holds.has('share'));
  assert.strictEqual(service.isWorking(), false, 'nothing running: no hold');
});

/* ── Packing ───────────────────────────────────────────────────────────── */

test('held while packing; once packed (checked, waiting for the user) the next tick locks', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const share = service.start({ mediaIds: [mediaId] });
  await until(() => packing, 'the pack started');
  assert.strictEqual(service.isWorking(), true);
  idle();
  assert.strictEqual(await vault._autolockTick(), false, 'packing holds the autolock');
  assert.strictEqual(vault.isLocked(), false);
  assert.strictEqual(statusOf(share.id), 'packing');
  packing.finish();
  packing = null;
  await until(() => statusOf(share.id) === 'checked', 'packed and checked');
  await service._idle();
  assert.strictEqual(service.isWorking(), false, 'checked waits for the user: no hold');
  assert.strictEqual(await vault._autolockTick(), true, 'the lock comes on the next tick');
  assert.strictEqual(vault.isLocked(), true);
});

test('a pack with no sign of life for STALL_MS no longer holds; the idle lock then cancels it', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  let clock = Date.now();
  service._setForTest({ now: () => clock });
  const share = service.start({ mediaIds: [mediaId] });
  await until(() => packing, 'the pack started');
  const workDir = store.getShare(share.id).work_dir;
  clock += service.STALL_MS - 1000;
  assert.strictEqual(service.isWorking(), true, 'still inside the window');
  packing.beat();                      // 7-Zip printed a percent
  clock += service.STALL_MS - 1000;
  assert.strictEqual(service.isWorking(), true, 'a sign of life restarts the window');
  clock += 2000;                       // nothing for STALL_MS: a hung 7-Zip
  assert.strictEqual(service.isWorking(), false, 'stalled: no hold');
  idle();
  assert.strictEqual(await vault._autolockTick(), true, 'the idle lock fires');
  assert.strictEqual(packing.opts.handle.cancelled, true, 'the pack was cancelled by the lock');
  packing = null;
  vault.unlock(VAULT_PASS);
  const row = store.getShare(share.id);
  assert.ok(!row || row.status === 'removing', 'hidden at once');
  await service._idle();
  await service._cleanupNow();
  assert.strictEqual(store.getShare(share.id), null);
  assert.ok(temp.workDirPath(workDir), 'the share had a work folder');
  assert.strictEqual(fs.existsSync(temp.workDirPath(workDir)), false, 'and it was deleted');
});

test('a manual lock (the lock button\'s first click, force:false) locks at once during a pack and cancels it', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const share = service.start({ mediaIds: [mediaId] });
  await until(() => packing, 'the pack started');
  assert.strictEqual(service.isWorking(), true);
  const r = await post('/api/vault/lock', { force: false });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.locked, true);
  assert.strictEqual(vault.isLocked(), true);
  assert.strictEqual(packing.opts.handle.cancelled, true, '7-Zip was stopped');
  packing = null;
  assert.strictEqual(service.isWorking(), false);
  vault.unlock(VAULT_PASS);
  await service._idle();
  await service._cleanupNow();
  assert.strictEqual(store.getShare(share.id), null, 'the cancelled share is gone');
});

/* ── Uploading ─────────────────────────────────────────────────────────── */

test('held while uploading and while a second upload waits in line; the lock comes once both are done', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const c = fakeClient();
  const a = makeChecked();
  const b = makeChecked();
  await service.confirmUpload(a, { confirm: true });
  await service.confirmUpload(b, { confirm: true });
  await until(() => c.uploads.length === 1, 'the first part is in flight');
  idle();
  assert.strictEqual(service.isWorking(), true);
  assert.strictEqual(await vault._autolockTick(), false, 'an upload holds the autolock');
  assert.strictEqual(vault.isLocked(), false);
  c.uploads[0].go.resolve();
  await until(() => statusOf(a) === 'uploaded', 'the first share uploaded');
  await until(() => c.uploads.length === 2, 'the second share started');
  assert.strictEqual(await vault._autolockTick(), false, 'the second upload holds it too');
  c.uploads[1].go.resolve();
  await until(() => statusOf(b) === 'uploaded', 'the second share uploaded');
  await service._idle();
  assert.strictEqual(service.isWorking(), false, 'uploaded: no hold');
  assert.strictEqual(await vault._autolockTick(), true, 'the lock comes on the next tick');
});

test('pausing the running upload: the one waiting in line takes its turn and holds; pausing it too ends the hold', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const c = fakeClient();
  const a = makeChecked();
  const b = makeChecked();
  await service.confirmUpload(a, { confirm: true });
  await service.confirmUpload(b, { confirm: true });
  await until(() => c.uploads.length === 1, 'the first part is in flight');
  assert.strictEqual(service.isWorking(), true);
  // The first share is paused: the second takes its turn.
  await service.pause(a);
  await until(() => c.uploads.length === 2, 'the queued share started');
  assert.strictEqual(service.isWorking(), true);
  await service.pause(b);
  assert.strictEqual(service.isWorking(), false);
});

test('not held for paused, not_finished, failed or checked shares', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const c = fakeClient();
  const s = makeChecked();
  await service.confirmUpload(s, { confirm: true });
  await until(() => c.uploads.length === 1, 'the part is in flight');
  assert.strictEqual(service.isWorking(), true);
  await service.pause(s);
  assert.strictEqual(statusOf(s), 'paused');
  assert.strictEqual(service.isWorking(), false, 'paused: no hold');
  // Rows that wait on the user, with no work behind them.
  const rows = ['not_finished', 'failed', 'checked'].map((status) => { const id = makeChecked(); store.updateShare(id, { status }); return id; });
  assert.strictEqual(service.isWorking(), false);
  idle();
  assert.strictEqual(await vault._autolockTick(), true, 'nothing working: the idle lock fires');
  vault.unlock(VAULT_PASS);
  for (const id of rows) assert.ok(store.getShare(id));
});

test('an upload with no sign of life for STALL_MS no longer holds; the idle lock then pauses it', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  let clock = Date.now();
  service._setForTest({ now: () => clock });
  const c = fakeClient();
  const s = makeChecked();
  await service.confirmUpload(s, { confirm: true });
  await until(() => c.uploads.length === 1, 'the part is in flight');
  clock += service.STALL_MS - 1000;
  assert.strictEqual(service.isWorking(), true);
  c.uploads[0].o.onBytes(1);           // the network took a read
  clock += service.STALL_MS - 1000;
  assert.strictEqual(service.isWorking(), true, 'bytes going out restart the window');
  clock += 2000;
  assert.strictEqual(service.isWorking(), false, 'stalled: no hold');
  idle();
  assert.strictEqual(await vault._autolockTick(), true);
  vault.unlock(VAULT_PASS);
  await service._idle();
  assert.strictEqual(statusOf(s), 'paused');
  assert.strictEqual(store.getShare(s).last_error, 'Paused because the library was locked.');
});

test('a manual lock (force:false) locks at once during an upload and pauses it', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const c = fakeClient();
  const s = makeChecked();
  await service.confirmUpload(s, { confirm: true });
  await until(() => c.uploads.length === 1, 'the part is in flight');
  assert.strictEqual(service.isWorking(), true);
  const r = await post('/api/vault/lock', { force: false });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.locked, true);
  assert.strictEqual(vault.isLocked(), true);
  assert.strictEqual(service.isWorking(), false);
  vault.unlock(VAULT_PASS);
  await service._idle();
  assert.strictEqual(statusOf(s), 'paused');
  assert.strictEqual(store.getShare(s).last_error, 'Paused because the library was locked.');
  await immediate();
  assert.strictEqual(c.uploads.length, 1, 'nothing resumed by itself');
});

/* ── Only real evidence counts (verifier finding on the first version) ─── */

/**
 * An upload against a connection that is open but blackholed: every attempt
 * waits out the local time limit (the clock moves 3 minutes) and fails with
 * NETWORK, no byte taken, no answer. The retry waits run an autolock tick
 * with the user away. `answer`: the failure is an error answer gofile sent.
 */
async function blackholed({ parts, answer = false }) {
  let clock = Date.now();
  service._setForTest({ now: () => clock });
  const c = fakeClient();
  let attempts = 0;
  let lockedAt = null;
  let heldTicks = 0;
  c.uploadPart = async () => {
    attempts++;
    clock += 3 * 60 * 1000;
    throw answer
      ? Object.assign(new Error('gofile refused the request.'), { code: 'GOFILE_ERROR', answered: true })
      : Object.assign(new Error('gofile did not answer in time.'), { code: 'NETWORK', timedOut: true });
  };
  service._setForTest({
    sleep: async (ms) => {
      clock += ms;
      if (vault.isLocked()) return;
      idle();
      if (await vault._autolockTick()) lockedAt = clock;
      else heldTicks++;
    },
  });
  const s = makeChecked({ parts, folderId: 'folder-1' });
  const confirmedAt = clock;
  await service.confirmUpload(s, { confirm: true });
  await until(() => !(service.isWorking()) || vault.isLocked(), 'the upload ended or the vault locked', 20000);
  await service._idle();
  return { s, c, attempts, lockedAt, confirmedAt, heldTicks, clock: () => clock };
}

test('blackholed upload (time limits, no byte, no answer; 40 parts, retries on): the hold ends STALL_MS after the last evidence and the idle lock fires', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const r = await blackholed({ parts: 40 });
  assert.ok(vault.isLocked(), `the idle lock fired (attempts ${r.attempts}, held ticks ${r.heldTicks})`);
  const after = r.lockedAt - r.confirmedAt;   // the confirm was the last real evidence
  assert.ok(after >= service.STALL_MS, `not before STALL_MS (${after / 60000} min)`);
  assert.ok(after < service.STALL_MS + 7 * 60 * 1000, `soon after STALL_MS (${after / 60000} min)`);
  assert.ok(r.attempts < 40 * 4, `stopped long before every part had its tries (${r.attempts})`);
  vault.unlock(VAULT_PASS);
  await service._idle();
  assert.strictEqual(statusOf(r.s), 'paused');
  assert.strictEqual(store.getShare(r.s).last_error, 'Paused because the library was locked.');
});

test('error answers gofile sent do count: the hold stays while gofile answers, and ends when the upload pauses', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const r = await blackholed({ parts: 3, answer: true });
  assert.strictEqual(r.lockedAt, null, 'never locked while gofile kept answering');
  assert.ok(r.clock() - r.confirmedAt > service.STALL_MS, 'for longer than STALL_MS in all');
  assert.strictEqual(r.attempts, 3 * 4, 'every part had its tries');
  assert.strictEqual(statusOf(r.s), 'paused', 'all parts failed: waits for the user');
  assert.strictEqual(service.isWorking(), false);
  assert.strictEqual(await vault._autolockTick(), true, 'the next tick locks');
});

test('the next share in line takes its turn without new evidence: it does not restart the window', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  let clock = Date.now();
  service._setForTest({ now: () => clock });
  const c = fakeClient();
  const a = makeChecked();
  const b = makeChecked();
  const aName = store.getShare(a).archive_name;
  await service.confirmUpload(a, { confirm: true });
  await service.confirmUpload(b, { confirm: true });   // the last real evidence: these confirms
  await until(() => c.uploads.length === 1, 'the first part of a is in flight');
  // a's part gets no byte taken and no answer; its retries fail the same way at once.
  const netErr = () => Object.assign(new Error('Could not reach gofile.'), { code: 'NETWORK' });
  const hang = c.uploadPart;
  c.uploadPart = (o) => (o.fileName.startsWith(aName) ? Promise.reject(netErr()) : hang(o));
  clock += service.STALL_MS - 60 * 1000;
  c.uploads[0].go.resolve({ fail: netErr() });
  await until(() => statusOf(a) === 'paused' && c.uploads.length === 2, 'a paused, b took its turn');
  assert.strictEqual(service.isWorking(), true, 'b is inside the window of the last evidence');
  clock += 2 * 60 * 1000;
  assert.strictEqual(service.isWorking(), false, 'taking its turn did not restart the window');
  idle();
  assert.strictEqual(await vault._autolockTick(), true, 'so the idle lock fires');
  vault.unlock(VAULT_PASS);
  await service._idle();
  assert.strictEqual(statusOf(b), 'paused');
});

/* ── The pack line: packing in the background, one 7-Zip at a time ───── */

const packState = () => service._packStateForTest();
const nameOf = (id) => store.getShare(id).archive_name;

test('pack line: a share started while another packs waits its turn, first come first served, one 7-Zip at a time', async () => {
  const a = service.start({ mediaIds: [mediaId] });
  await until(() => packCalls.length === 1, 'a packs');
  const b = service.start({ mediaIds: [mediaId] });
  const c = service.start({ mediaIds: [mediaId] });
  assert.deepStrictEqual([a.status, b.status, c.status], ['packing', 'queued', 'queued'], 'no PACK_BUSY: accepted and waiting');
  assert.strictEqual(store.getShare(b.id).work_dir, null, 'no work folder while waiting');
  const listed = (id) => service.listShares().find(s => s.id === id);
  assert.strictEqual(listed(b.id).waitingFor, `${nameOf(a.id)}.7z`, 'b starts when a is packed');
  assert.strictEqual(listed(c.id).waitingFor, `${nameOf(b.id)}.7z`, 'c starts when b is packed');
  assert.strictEqual(service.progress(b.id).waitingFor, `${nameOf(a.id)}.7z`);
  assert.strictEqual(packCalls.length, 1, 'one 7-Zip at a time');
  const tb = service.state().topBar;
  assert.strictEqual(tb.packWaiting, 2);
  assert.strictEqual(tb.packing.shareId, a.id);
  assert.strictEqual(tb.active, true);
  packCalls[0].finish();
  await until(() => packCalls.length === 2, 'b took its turn');
  assert.strictEqual(packCalls[1].opts.archiveName, nameOf(b.id), 'b, not c');
  await until(() => statusOf(a.id) === 'checked', 'a is ready to check');
  assert.strictEqual(statusOf(b.id), 'packing');
  assert.ok(store.getShare(b.id).work_dir, 'its work folder is made when its turn comes');
  assert.strictEqual(statusOf(c.id), 'queued');
  assert.strictEqual(listed(c.id).waitingFor, `${nameOf(b.id)}.7z`);
  packCalls[1].finish();
  await until(() => packCalls.length === 3, 'c took its turn');
  assert.strictEqual(packCalls[2].opts.archiveName, nameOf(c.id));
  packCalls[2].finish();
  await until(() => statusOf(c.id) === 'checked', 'c is ready to check');
  assert.strictEqual(service.state().topBar.readyToCheck, 3);
});

test('pack line: a waiting share can be cancelled; its password and file list go, and it never packs', async () => {
  const a = service.start({ mediaIds: [mediaId] });
  await until(() => packCalls.length === 1, 'a packs');
  const b = service.start({ mediaIds: [mediaId] });
  assert.deepStrictEqual({ ...packState().jobs[b.id] }, { packQueued: true, hasPassword: true, hasPlan: true, autoUpload: false },
    'until its turn it holds the password and the plan in memory, nothing more');
  assert.strictEqual(store.getShare(b.id).password, null, 'nothing extra stored ("Passwords of past shares" is off here)');
  assert.deepStrictEqual(await service.cancel(b.id), { removed: true });
  assert.strictEqual(store.getShare(b.id), null, 'gone at once (it had no work folder)');
  assert.deepStrictEqual(packState().queue, []);
  assert.strictEqual(packState().jobs[b.id], undefined, 'nothing of it left in memory');
  packing.finish();
  await until(() => statusOf(a.id) === 'checked', 'a is packed');
  await service._idle();
  assert.strictEqual(packCalls.length, 1, 'b never started');
});

test('pack line: a lock (any kind) cancels every waiting share like the running pack and wipes what they held', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  const a = service.start({ mediaIds: [mediaId] });
  await until(() => packCalls.length === 1, 'a packs');
  const b = service.start({ mediaIds: [mediaId] });
  const c = service.start({ mediaIds: [mediaId] });
  await vault.lock({ force: false });
  assert.strictEqual(vault.isLocked(), true);
  assert.strictEqual(packCalls[0].opts.handle.cancelled, true, 'the running pack was stopped');
  const st = packState();
  assert.deepStrictEqual(st.queue, [], 'the line is empty');
  for (const id of [a.id, b.id, c.id]) {
    const j = st.jobs[id];
    assert.ok(!j || (!j.hasPassword && !j.hasPlan && !j.packQueued), `share ${id}: password and plan wiped`);
  }
  assert.strictEqual(service.isWorking(), false);
  packing = null;
  vault.unlock(VAULT_PASS);
  await service._idle();
  await service._cleanupNow();
  for (const id of [a.id, b.id, c.id]) assert.strictEqual(store.getShare(id), null, `share ${id} is gone`);
  assert.strictEqual(packCalls.length, 1, 'nothing started after the unlock');
});

test('pack line: free space is measured again when the turn comes; too little fails that share cleanly', async () => {
  const realFree = temp.freeBytes;
  try {
    const a = service.start({ mediaIds: [mediaId] });
    await until(() => packCalls.length === 1, 'a packs');
    const b = service.start({ mediaIds: [mediaId] });
    const c = service.start({ mediaIds: [mediaId] });
    temp.freeBytes = () => 10;   // the drive filled up meanwhile
    packing.finish();
    await until(() => statusOf(b.id) === 'failed' && statusOf(c.id) === 'failed', 'b and c failed at their turn');
    for (const id of [b.id, c.id]) {
      assert.match(store.getShare(id).last_error, /not enough free space left to pack this share, so it was not packed\. Nothing was uploaded\./);
      assert.strictEqual(packState().jobs[id], undefined, 'its password and plan are gone');
    }
    assert.strictEqual(packCalls.length, 1, '7-Zip never ran for them');
    await until(() => statusOf(a.id) === 'checked', 'a is fine');
  } finally {
    temp.freeBytes = realFree;
  }
});

test('pack line: a picked file that changed while the share waited fails it at its turn', async () => {
  const extra = path.join(MEDIA, 'grows.mp4');
  fs.writeFileSync(extra, Buffer.alloc(1000, 1));
  const extraId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')").run(extra, 'grows.mp4').lastInsertRowid);
  try {
    service.start({ mediaIds: [mediaId] });
    await until(() => packCalls.length === 1, 'a packs');
    const b = service.start({ mediaIds: [mediaId, extraId] });
    fs.appendFileSync(extra, 'more');
    packing.finish();
    await until(() => statusOf(b.id) === 'failed', 'b failed at its turn');
    assert.match(store.getShare(b.id).last_error, /^A picked file changed or is no longer there since this share was started/);
    assert.strictEqual(packCalls.length, 1);
  } finally {
    db.get().prepare('DELETE FROM media WHERE id = ?').run(extraId);
  }
});

test('pack line: a picked file whose modified time changed (same size) while the share waited fails it at its turn', async () => {
  const extra = path.join(MEDIA, 'touched.mp4');
  fs.writeFileSync(extra, Buffer.alloc(1000, 1));
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(extra, old, old);
  const extraId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')").run(extra, 'touched.mp4').lastInsertRowid);
  try {
    service.start({ mediaIds: [mediaId] });
    await until(() => packCalls.length === 1, 'a packs');
    const b = service.start({ mediaIds: [mediaId, extraId] });
    // Rewritten in place with the same size: only its modified time tells.
    fs.writeFileSync(extra, Buffer.alloc(1000, 2));
    assert.strictEqual(fs.statSync(extra).size, 1000);
    packing.finish();
    await until(() => statusOf(b.id) === 'failed', 'b failed at its turn');
    assert.match(store.getShare(b.id).last_error, /^A picked file changed or is no longer there since this share was started/);
    assert.strictEqual(packCalls.length, 1, 'b never packed');
  } finally {
    db.get().prepare('DELETE FROM media WHERE id = ?').run(extraId);
  }
});

test('pack line: taking its turn is no sign of life, not even the start of its real pack (percent 0 is not work)', async () => {
  let clock = Date.now();
  service._setForTest({ now: () => clock });
  const seen = [];
  try {
    service.start({ mediaIds: [mediaId] });
    await until(() => packCalls.length === 1, 'a packs');
    const b = service.start({ mediaIds: [mediaId] });
    // A goes quiet for longer than STALL_MS: the share waiting behind it no longer holds.
    clock += service.STALL_MS + 1000;
    assert.strictEqual(service.isWorking(), false);
    // B's turn runs the real pack.pack (its 7-Zip is not found, so it fails later on).
    pack.pack = (o) => {
      seen.push(['before', service.isWorking()]);
      const p = realPack(o);
      seen.push(['right after the real pack started', service.isWorking()]);
      Promise.resolve().then(() => seen.push(['a moment later, no 7-Zip output', service.isWorking()]));
      return p;
    };
    // A's 7-Zip dies after hanging, with no output: no new evidence.
    packCalls[0].fail(Object.assign(new Error('7-Zip stopped.'), { code: 'PACK_FAILED' }));
    await until(() => seen.length >= 3, 'b took its turn');
    assert.deepStrictEqual(seen.map(x => x[1]), [false, false, false], JSON.stringify(seen));
    await until(() => statusOf(b.id) === 'failed', 'b ends (no 7-Zip here)');
    assert.strictEqual(service.isWorking(), false);
  } finally {
    pack.pack = fakePackFn;
  }
});

test('pack line: the space check at start counts the shares waiting ahead and what the running pack still has to write', async () => {
  const realFree = temp.freeBytes;
  try {
    const need = service.preview({ mediaIds: [mediaId] }).needBytes;
    service.start({ mediaIds: [mediaId] });
    await until(() => packCalls.length === 1, 'a packs (at 0 percent)');
    temp.freeBytes = () => need + Math.floor(need / 2);
    assert.strictEqual(service.preview({ mediaIds: [mediaId] }).enoughSpace, false);
    assert.strictEqual(service.preview({ mediaIds: [mediaId] }).packBusy, true);
    assert.throws(() => service.start({ mediaIds: [mediaId] }),
      (e) => e.code === 'NO_SPACE' && /as well as the shares already waiting to be packed/.test(e.message) && e.missingBytes > 0);
    temp.freeBytes = () => need * 3;
    const b = service.start({ mediaIds: [mediaId] });
    assert.strictEqual(b.status, 'queued');
    temp.freeBytes = () => need * 3 - 1;   // a's rest, b and one more do not fit
    assert.throws(() => service.start({ mediaIds: [mediaId] }), { code: 'NO_SPACE' });
  } finally {
    temp.freeBytes = realFree;
  }
});

test('pack line: a share waiting behind a live pack holds the automatic lock; behind a stalled one it does not; Ready to check never does', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  let clock = Date.now();
  service._setForTest({ now: () => clock });
  const a = service.start({ mediaIds: [mediaId] });
  await until(() => packCalls.length === 1, 'a packs');
  const b = service.start({ mediaIds: [mediaId] });
  assert.strictEqual(service.isWorking(), true);
  clock += service.STALL_MS - 1000;
  assert.strictEqual(service.isWorking(), true, 'inside the window');
  clock += 2000;
  assert.strictEqual(service.isWorking(), false, 'the pack ahead stalled: waiting behind it holds nothing');
  packing.beat();   // 7-Zip printed a percent: real evidence of the line
  assert.strictEqual(service.isWorking(), true, 'the line is alive again, so is the wait');
  packCalls[0].finish();
  await until(() => packCalls.length === 2, 'b took its turn');
  packCalls[1].finish();
  await until(() => statusOf(a.id) === 'checked' && statusOf(b.id) === 'checked', 'both ready to check');
  await service._idle();
  assert.strictEqual(service.isWorking(), false, 'Ready to check waits for the user: no hold');
  idle();
  assert.strictEqual(await vault._autolockTick(), true, 'the idle lock fires');
});

/* ── When packing is done: Wait for me to check / Upload on its own ──── */

/** Start one share and let it pack and pass its checks. */
async function packOne(opts = {}) {
  const before = packCalls.length;
  const s = service.start({ mediaIds: [mediaId], ...opts });
  await until(() => packCalls.length === before + 1, 'it packs');
  packCalls[before].finish();
  await until(() => statusOf(s.id) !== 'packing', 'packed and checked');
  // Upload on its own has had its turn (an upload it started is left running).
  await until(() => !packState().jobs[s.id] || !packState().jobs[s.id].autoUpload, 'the upload decision');
  await immediate();
  return s;
}

test('When packing is done: Wait for me to check (the default) stops at Ready to check and sends nothing', async () => {
  const c = fakeClient();
  assert.strictEqual(settings.get().afterPack, 'wait');
  const s = await packOne({ confirmUpload: true });   // a tick sent anyway does not make it an upload
  assert.strictEqual(statusOf(s.id), 'checked');
  assert.strictEqual(store.getShare(s.id).last_error, null);
  assert.deepStrictEqual(c.calls, []);
});

test('Upload on its own: uploads once every check passed; the mode is the one in force at start', async () => {
  const c = fakeClient();
  settings.save({ ...settings.get(), afterPack: 'upload', rememberPasswords: true });
  const before = packCalls.length;
  const s = service.start({ mediaIds: [mediaId], confirmUpload: true });
  assert.strictEqual(s.uploadsOnItsOwn, true);
  await until(() => packCalls.length === before + 1, 'it packs');
  // Changing the setting now does not change this share.
  settings.save({ ...settings.get(), afterPack: 'wait' });
  packCalls[before].finish();
  await until(() => c.uploads.length === 1, 'the upload started by itself');
  assert.strictEqual(statusOf(s.id), 'uploading');
  c.uploads[0].go.resolve();
  await until(() => statusOf(s.id) === 'uploaded', 'uploaded');
  // The password and link can be had afterwards.
  assert.ok(service.revealPassword(s.id).password);
  assert.ok(service.getShare(s.id).link);
  // The other way round: started under Wait, the setting turned to Upload afterwards: it waits.
  const w = service.start({ mediaIds: [mediaId], confirmUpload: true });
  await until(() => packCalls.length === before + 2, 'it packs');
  settings.save({ ...settings.get(), afterPack: 'upload' });
  packCalls[before + 1].finish();
  await until(() => statusOf(w.id) === 'checked', 'ready to check');
  await service._idle();
  assert.strictEqual(c.uploads.length, 1, 'nothing more sent');
});

test('Upload on its own needs the tick at start: without confirmUpload exactly true it waits for the user', async () => {
  const c = fakeClient();
  settings.save({ ...settings.get(), afterPack: 'upload', rememberPasswords: true });
  for (const confirmUpload of [undefined, false, 'true', 1]) {
    const s = await packOne(confirmUpload === undefined ? {} : { confirmUpload });
    assert.strictEqual(statusOf(s.id), 'checked', String(confirmUpload));
  }
  assert.deepStrictEqual(c.calls, []);
});

test('Upload on its own never uploads with a password only this Vault process knows: it waits, saying so', async () => {
  const c = fakeClient();
  settings.save({ ...settings.get(), afterPack: 'upload', rememberPasswords: false });
  const s = await packOne({ confirmUpload: true });
  assert.strictEqual(statusOf(s.id), 'checked');
  assert.match(store.getShare(s.id).last_error, /^Packed and checked, but not uploaded on its own\. Vault is not keeping the password of this share/);
  assert.deepStrictEqual(c.calls, []);
  // The saved password, still the same one: the user has it, so it goes.
  store.kvSet('saved_password', 'my-saved-password-1');
  try {
    const ok = await packOne({ confirmUpload: true, passwordChoice: 'saved' });
    await until(() => c.uploads.length === 1, 'uploaded on its own');
    c.uploads[0].go.resolve();
    await until(() => statusOf(ok.id) === 'uploaded', 'uploaded');
    // The saved password changed while it packed: the old one would live in memory only.
    const before = packCalls.length;
    const changed = service.start({ mediaIds: [mediaId], confirmUpload: true, passwordChoice: 'saved' });
    await until(() => packCalls.length === before + 1, 'it packs');
    store.kvSet('saved_password', 'a-new-saved-password-2');
    packCalls[before].finish();
    await until(() => statusOf(changed.id) === 'checked', 'checked');
    await service._idle();
    assert.match(store.getShare(changed.id).last_error, /not keeping the password/);
    assert.strictEqual(c.uploads.length, 1);
  } finally {
    store.kvSet('saved_password', null);
  }
});

test('Upload on its own meets every gate of the Upload button: offline and feature off leave it waiting, a failed check never uploads', async () => {
  const c = fakeClient();
  settings.save({ ...settings.get(), afterPack: 'upload', rememberPasswords: true });
  config.net.offline = true;
  const off = await packOne({ confirmUpload: true });
  assert.strictEqual(statusOf(off.id), 'checked');
  assert.match(store.getShare(off.id).last_error, /^Packed and checked, but not uploaded on its own\. Vault is set to stay offline/);
  config.net.offline = false;
  // The feature turned off while it packed.
  const before = packCalls.length;
  const f = service.start({ mediaIds: [mediaId], confirmUpload: true });
  await until(() => packCalls.length === before + 1, 'it packs');
  settings.save({ ...settings.get(), enabled: false });
  packCalls[before].finish();
  await until(() => statusOf(f.id) === 'checked', 'checked');
  await service._idle();
  assert.match(store.getShare(f.id).last_error, /Share privately is turned off/);
  settings.save({ ...settings.get(), enabled: true });
  // A failed check: failed, nothing sent.
  pack.runChecks = async (o) => ({ ok: false, test: { ok: false }, listWithoutPassword: { ok: true }, contents: { ok: true }, parts: { ok: true, count: o.parts.length } });
  const bad = await packOne({ confirmUpload: true });
  assert.strictEqual(statusOf(bad.id), 'failed');
  const j = packState().jobs[bad.id];
  assert.ok(!j || (!j.hasPassword && !j.autoUpload), 'its password went from memory');
  assert.deepStrictEqual(c.calls, [], 'no request at all');
  assert.strictEqual(strayFetches, 0);
  // The user can still upload a waiting one by hand, which clears the note.
  await service.confirmUpload(off.id, { confirm: true });
  assert.strictEqual(store.getShare(off.id).last_error, null);
  await until(() => c.uploads.length === 1, 'the hand upload started');
  c.uploads[0].go.resolve();
  await until(() => statusOf(off.id) === 'uploaded', 'uploaded');
});
