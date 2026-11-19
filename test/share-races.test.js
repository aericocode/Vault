/**
 * Share privately: actions racing each other and the upload worker
 * (lib/share/service.js, "ONE SHARE, ONE STATE MACHINE").
 *
 * Deterministic: every await that matters (the local folder delete, the
 * gofile requests, the retry wait) is a fake whose promise the test settles
 * when it chooses, so each interleaving is run on purpose, not by timing luck:
 *   - Cancel / Remove against Upload, both orders, the same tick or while the
 *     first one waits on its folder delete;
 *   - Stop against Resume, both orders, with the part in flight aborted or
 *     reaching gofile anyway (with and without a folder yet);
 *   - the library locked while the timer is being set and while a guest
 *     account is being made; the feature turned off while the timer is set;
 *   - Delete all with an unexpected error; a stop or remove cut short by a
 *     restart.
 * The invariant checked everywhere: bytes that reached the fake gofile mean
 * a share row holds that folder id, or a DELETE for that folder was sent.
 * Then the same pairs fired concurrently over HTTP many times.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-races-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
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
const service = require('../lib/share/service');
const { app } = require('../server/index');

const TOKEN = 'TOKEN-race-0123456789abcdef';
const realFetch = globalThis.fetch;
let strayFetches = 0;
let server;
let base;

test.before(async () => {
  db.init();
  config.net.offline = false;
  service.ensureRecovered();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    strayFetches++;
    return Promise.reject(new Error('no real request in this test'));
  };
});
test.after(async () => {
  globalThis.fetch = realFetch;
  await service._idle();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { require('../lib/secure-assets').close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const realRemoveWorkDir = temp.removeWorkDir;
let rmGate = null;   // when set, every local folder delete waits for it
temp.removeWorkDir = async (name) => {
  if (rmGate) await rmGate.p;
  return realRemoveWorkDir(name);
};

test.afterEach(async () => {
  rmGate = null;
  vault._locked = false;
  await service._idle();
  assert.strictEqual(strayFetches, 0, 'a real request was made');
});

const immediate = () => new Promise(r => setImmediate(r));
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await immediate(); };
function deferred() {
  let resolve; let reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
}
const abortedP = (signal) => new Promise(r => (!signal || signal.aborted ? (signal ? r() : null) : signal.addEventListener('abort', r, { once: true })));
const ABORTED = () => Object.assign(new Error('Stopped.'), { code: 'ABORTED' });
let accountSeq = 0;   // every account the fakes make has its own token

/**
 * A fake gofile. `hold` (a deferred) makes uploads wait for it; with
 * honorAbort an aborted upload throws and sends nothing, without it the part
 * reaches gofile anyway (the abort lost the race). `sent` lists every part
 * that reached gofile, with its folder.
 */
function raceClient({ honorAbort = true } = {}) {
  const c = {
    sent: [], deletes: [], expiries: [], accounts: [], folderSeq: 0,
    hold: null, deleteHold: null, expiryHold: null, accountHold: null, expiryFail: 0,
    async createAccount(o = {}) {
      c.accountCalls = (c.accountCalls || 0) + 1;
      c.accountSignal = o.signal;
      if (c.accountHold) {
        await (honorAbort ? Promise.race([c.accountHold.p, abortedP(o.signal)]) : c.accountHold.p);
        if (honorAbort && o.signal && o.signal.aborted) throw ABORTED();
      }
      const token = `${TOKEN}-${++accountSeq}`;
      c.accounts.push(token);
      return { token };
    },
    async uploadPart(o) {
      await immediate();
      if (c.hold) await (honorAbort ? Promise.race([c.hold.p, abortedP(o.signal)]) : c.hold.p);
      if (honorAbort && o.signal && o.signal.aborted) throw ABORTED();
      o.onBytes && o.onBytes(o.size);
      const folder = o.folderId || `rf-${++c.folderSeq}`;
      c.sent.push({ folder, fileName: o.fileName });
      return { fileId: `file-${o.fileName}`, folderId: folder, code: 'Code123', link: 'https://gofile.io/d/Code123', md5: 'x' };
    },
    async setExpiry(o) {
      c.expiries.push({ folderId: o.folderId, signal: o.signal });
      if (c.expiryHold) {
        await Promise.race([c.expiryHold.p, abortedP(o.signal)]);
        if (o.signal && o.signal.aborted) throw ABORTED();
      }
      if (c.expiryFail > 0) { c.expiryFail--; throw Object.assign(new Error('x'), { code: 'GOFILE_ERROR' }); }
    },
    async deleteContent(o) {
      if (c.deleteHold) await c.deleteHold.p;
      c.deletes.push(o.folderId);
    },
  };
  service._setForTest({ client: c, sleep: () => immediate() });
  return c;
}

/** Every part that reached gofile is on record, or its folder was deleted. */
function assertTracked(c, what) {
  for (const s of c.sent) {
    const row = store.listShares().find(r => r.folder_id === s.folder);
    assert.ok(row || c.deletes.includes(s.folder),
      `${what}: ${s.fileName} reached gofile in folder ${s.folder}, which no share holds and nothing deleted`);
  }
}

function on(patch = {}) {
  settings.save({ ...settings.DEFAULTS, enabled: true, ...patch });
}

function makeChecked({ parts = 2, size = 500 } = {}) {
  const wd = temp.createWorkDir();
  const name = names.randomArchiveName();
  const list = [];
  for (let i = 1; i <= parts; i++) {
    const fileName = parts > 1 ? `${name}.7z.${String(i).padStart(3, '0')}` : `${name}.7z`;
    const p = path.join(wd.dir, fileName);
    fs.writeFileSync(p, Buffer.alloc(size, i));
    const st = fs.statSync(p);
    list.push({ partNo: i, fileName, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
  }
  const id = store.insertShare({
    archive_name: name, password: 'Pass-Word-0001', password_kind: 'random', size: parts * size,
    part_count: parts, part_size: size, file_count: 1, status: 'checked', created_at: Date.now(),
    delete_after_days: settings.get().deleteAfterDays, work_dir: wd.name, checks: JSON.stringify({ ok: true }),
  });
  store.setParts(id, list);
  return { id, wd, name, list };
}

/** A paused upload: part 1 on gofile in `folder` (or nothing yet), the rest waiting. */
function makePaused({ parts = 2, folder = null } = {}) {
  const s = makeChecked({ parts });
  const acc = store.insertAccount(`${TOKEN}-stored`, service.SESSION);
  store.updateShare(s.id, { status: 'paused', account_id: acc, folder_id: folder });
  if (folder) store.updatePart(s.id, 1, { status: 'done', file_id: 'f1' });
  else store.updatePart(s.id, 1, { status: 'failed', tries: 1 });
  return s;
}

const settle = (p) => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
const statusOf = (id) => (store.getShare(id) || {}).status || null;

/* ── Cancel / Remove against Upload ─────────────────────────────────────── */

test('cancel or remove against upload, every order: either nothing is sent, or the upload is on record', async () => {
  on({ deleteAfterDays: 0 });
  for (const op of ['cancel', 'remove']) {
    for (const order of ['op-first-waiting', 'op-first-same-tick', 'upload-first', 'upload-first-same-tick']) {
      const c = raceClient();
      const s = makeChecked();
      rmGate = deferred();
      const doOp = () => (op === 'cancel' ? service.cancel(s.id) : service.remove(s.id, {}));
      const doUp = () => service.confirmUpload(s.id, { confirm: true });
      let a; let b;
      if (order.startsWith('op-first')) {
        a = settle(doOp());
        if (order === 'op-first-waiting') await ticks();   // the op now waits on its folder delete
        b = settle(doUp());
      } else {
        b = settle(doUp());
        if (order === 'upload-first') await ticks();
        a = settle(doOp());
      }
      await ticks();
      rmGate.resolve();
      const [opR, upR] = await Promise.all([a, b]);
      await service._idle();
      const label = `${op} ${order}`;
      if (order.startsWith('op-first')) {
        assert.ok(opR.ok, `${label}: ${opR.e && opR.e.code}`);
        assert.strictEqual(upR.ok, false, `${label}: upload must be refused`);
        assert.strictEqual(upR.e.code, 'NOT_FOUND', label);
        assert.deepStrictEqual(c.sent, [], `${label}: nothing sent`);
        assert.strictEqual(store.getShare(s.id), null, label);
      } else {
        assert.ok(upR.ok, label);
        assert.strictEqual(opR.ok, false, `${label}: the ${op} must be refused once the upload started`);
        assert.strictEqual(opR.e.code, 'WRONG_STATE', label);
        assert.strictEqual(statusOf(s.id), 'uploaded', label);
        assert.ok(store.getShare(s.id).folder_id, label);
      }
      assertTracked(c, label);
    }
  }
});

test('while cancel waits on its folder delete, the share is gone for Upload, Resume and the list', async () => {
  const c = raceClient();
  on();
  const s = makeChecked();
  rmGate = deferred();
  const p = service.cancel(s.id);
  await ticks();
  assert.strictEqual(statusOf(s.id), 'removing', 'written before the await');
  assert.ok(!service.listShares().some(x => x.id === s.id));
  assert.throws(() => service.getShare(s.id), { code: 'NOT_FOUND' });
  rmGate.resolve();
  assert.deepStrictEqual(await p, { removed: true });
  await assert.rejects(service.confirmUpload(s.id, { confirm: true }), { code: 'NOT_FOUND' });
  assert.deepStrictEqual(c.sent, []);
});

/* ── Stop against Resume ────────────────────────────────────────────────── */

test('stop against resume, every order, abort honoured or lost: what reached gofile is deleted, nothing is left untracked', async () => {
  on({ onPartFail: 'ask', deleteAfterDays: 0 });
  for (const honorAbort of [true, false]) {
    for (const folder of ['pre-folder', null]) {
      for (const order of ['stop-first-waiting', 'stop-first-same-tick', 'resume-first', 'resume-first-same-tick']) {
        const c = raceClient({ honorAbort });
        const s = makePaused({ folder: folder && `${folder}-${Math.random().toString(36).slice(2, 8)}` });
        const pre = store.getShare(s.id).folder_id;
        c.deleteHold = deferred();
        c.hold = deferred();
        const doStop = () => service.stop(s.id, { confirm: true });
        const doResume = () => service.resume(s.id);
        let a; let b;
        if (order.startsWith('stop-first')) {
          a = settle(doStop());
          if (order === 'stop-first-waiting') await ticks();
          b = settle(doResume());
        } else {
          b = settle(doResume());
          if (order === 'resume-first') await ticks(10);   // the part is now on its way
          a = settle(doStop());
        }
        await ticks(10);
        c.hold.resolve();       // a part that was not aborted reaches gofile now
        await ticks(10);
        c.deleteHold.resolve();
        const [stopR, resR] = await Promise.all([a, b]);
        await service._idle();
        const label = `abort ${honorAbort ? 'honoured' : 'lost'}, ${folder ? 'with' : 'without'} folder, ${order}`;
        assert.ok(stopR.ok, `${label}: stop ${stopR.e && stopR.e.code}`);
        assert.strictEqual(stopR.v.status, 'cancelled', label);
        assert.strictEqual(statusOf(s.id), 'cancelled', label);
        if (order.startsWith('stop-first')) {
          assert.strictEqual(resR.ok, false, `${label}: resume must be refused`);
          assert.strictEqual(resR.e.code, 'WRONG_STATE', label);
          assert.deepStrictEqual(c.sent, [], `${label}: nothing sent after stop`);
        } else {
          assert.ok(resR.ok, label);
        }
        // Stop deleted every folder this share has on gofile.
        const folders = new Set([pre, ...c.sent.map(x => x.folder)].filter(Boolean));
        for (const f of folders) assert.ok(c.deletes.includes(f), `${label}: folder ${f} not deleted`);
        assertTracked(c, label);
        // Nothing is sent once stop has answered.
        const n = c.sent.length;
        await ticks(10);
        assert.strictEqual(c.sent.length, n, label);
      }
    }
  }
});

test('while stop waits on gofile, the row says stopping: Resume, Upload and Delete all wait, then find it stopped', async () => {
  const c = raceClient();
  on();
  const s = makePaused({ folder: 'fo-stop-wait' });
  c.deleteHold = deferred();
  const p = service.stop(s.id, { confirm: true });
  await ticks();
  assert.strictEqual(statusOf(s.id), 'stopping', 'written before the await');
  assert.strictEqual(service.listShares().find(x => x.id === s.id).onGofile, true);
  assert.strictEqual(service.listShares().find(x => x.id === s.id).canResume, false);
  const r = settle(service.resume(s.id));
  const d = settle(service.deleteRemote(s.id));
  c.deleteHold.resolve();
  assert.strictEqual((await p).status, 'cancelled');
  assert.strictEqual((await r).e.code, 'WRONG_STATE');
  assert.strictEqual((await d).e.code, 'WRONG_STATE');
  assert.deepStrictEqual(c.deletes, ['fo-stop-wait'], 'one delete');
  assert.deepStrictEqual(c.sent, []);
});

/* ── The lock and the feature switch ────────────────────────────────────── */

test('library locked while the timer is set: no request and no local delete after the lock; the upload stays on record', async () => {
  for (const when of ['in the retry wait', 'request in flight']) {
    const c = raceClient();
    on({ deleteAfterDays: 7 });
    const s = makeChecked({ parts: 1 });
    let lockNow = null;
    if (when === 'in the retry wait') {
      c.expiryFail = 1;
      const waitGate = deferred();
      service._setForTest({ sleep: (ms, signal) => { lockNow = waitGate; return Promise.race([waitGate.p, abortedP(signal)]); } });
    } else {
      c.expiryHold = deferred();
    }
    await service.confirmUpload(s.id, { confirm: true });
    for (let i = 0; i < 200 && c.expiries.length === 0; i++) await immediate();
    await ticks(5);
    assert.strictEqual(c.expiries.length, 1, when);
    // Lock, as lib/vault.js does it: closed first, then 'locking' with the database still open.
    vault._locked = true;
    vault._notify('locking');
    if (lockNow) lockNow.resolve();
    if (c.expiryHold) c.expiryHold.resolve();
    await ticks(10);
    assert.ok(c.expiries[0].signal && c.expiries[0].signal.aborted, `${when}: the timer request was aborted`);
    vault._locked = false;
    await service._idle();
    assert.strictEqual(c.expiries.length, 1, `${when}: no timer request after the lock`);
    assert.ok(fs.existsSync(s.wd.dir), `${when}: no local delete after the lock`);
    const row = store.getShare(s.id);
    assert.strictEqual(row.status, 'paused', when);
    assert.match(row.last_error, /library was locked/);
    assert.strictEqual(row.folder_id, 'rf-1', `${when}: the folder is on record`);
    // Resume finishes it: the timer, then 'uploaded'.
    vault._notify('unlocked');
    await service.resume(s.id);
    await service._idle();
    assert.strictEqual(statusOf(s.id), 'uploaded', when);
    assert.strictEqual(c.expiries.length, 2, when);
    assert.deepStrictEqual(c.sent.length, 1, `${when}: the part was not sent again`);
    service._setForTest({ sleep: () => immediate() });
  }
});

test('library locked while a guest account is made: the request is aborted; an account made anyway is stored on unlock', async () => {
  on({ accountMode: 'perShare' });
  // Abort honoured: no account made, nothing sent.
  {
    const c = raceClient({ honorAbort: true });
    c.accountHold = deferred();
    const s = makeChecked({ parts: 1 });
    const before = db.get().prepare('SELECT COUNT(*) n FROM share_accounts').get().n;
    await service.confirmUpload(s.id, { confirm: true });
    for (let i = 0; i < 100 && !c.accountSignal; i++) await immediate();
    vault._locked = true;
    vault._notify('locking');
    await ticks(10);
    assert.ok(c.accountSignal && c.accountSignal.aborted, 'createAccount got the abort');
    vault._locked = false;
    vault._notify('unlocked');
    await service._idle();
    assert.deepStrictEqual(c.accounts, [], 'no account made');
    assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM share_accounts').get().n, before);
    assert.deepStrictEqual(c.sent, []);
    assert.strictEqual(statusOf(s.id), 'paused');
  }
  // Abort lost: gofile made it and answered after the lock. Kept in memory,
  // written once the library is unlocked; still nothing sent.
  {
    const c = raceClient({ honorAbort: false });
    c.accountHold = deferred();
    const s = makeChecked({ parts: 1 });
    await service.confirmUpload(s.id, { confirm: true });
    for (let i = 0; i < 100 && !c.accountSignal; i++) await immediate();
    vault._locked = true;
    vault._notify('locking');
    c.accountHold.resolve();
    await ticks(10);
    const token = c.accounts[0];
    assert.ok(token, 'gofile made the account');
    assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM share_accounts WHERE token = ?').get(token).n, 0, 'nothing written while locked');
    vault._locked = false;
    vault._notify('unlocked');
    await service._idle();
    assert.strictEqual(db.get().prepare('SELECT COUNT(*) n FROM share_accounts WHERE token = ?').get(token).n, 1, 'stored on unlock');
    assert.deepStrictEqual(c.sent, []);
    assert.strictEqual(statusOf(s.id), 'paused');
  }
});

test('a part that reaches gofile after the lock is recorded on unlock (its folder is never lost)', async () => {
  const c = raceClient({ honorAbort: false });
  on({ deleteAfterDays: 0 });
  const s = makeChecked({ parts: 2 });
  c.hold = deferred();
  await service.confirmUpload(s.id, { confirm: true });
  for (let i = 0; i < 100 && store.getParts(s.id)[0].status !== 'uploading'; i++) await immediate();
  vault._locked = true;
  vault._notify('locking');
  c.hold.resolve();
  await ticks(10);
  assert.strictEqual(c.sent.length, 1, 'the first part reached gofile');
  assert.strictEqual(store.getShare(s.id).folder_id, null, 'not written while locked');
  vault._locked = false;
  vault._notify('unlocked');
  await service._idle();
  assert.strictEqual(store.getShare(s.id).folder_id, 'rf-1');
  assert.strictEqual(store.getParts(s.id)[0].status, 'done');
  assert.strictEqual(statusOf(s.id), 'paused');
  assert.strictEqual(c.sent.length, 1, 'the second part was not sent after the lock');
  assertTracked(c, 'lock during first part');
});

test('feature turned off while the timer is set: the share stays uploaded (no timer), never written over with paused', async () => {
  const c = raceClient();
  on({ deleteAfterDays: 7 });
  const s = makeChecked({ parts: 1 });
  c.expiryHold = deferred();
  await service.confirmUpload(s.id, { confirm: true });
  for (let i = 0; i < 200 && c.expiries.length === 0; i++) await immediate();
  await service.updateSettings({ enabled: false });
  const row = store.getShare(s.id);
  assert.strictEqual(row.status, 'uploaded');
  assert.strictEqual(row.timer_set, 0);
  assert.match(row.last_error, /timer could not be set/);
  assert.strictEqual(c.expiries.length, 1, 'no timer request after the switch went off');
  await ticks(10);
  assert.strictEqual(statusOf(s.id), 'uploaded');
  on();
});

test('feature turned off while parts are sent: paused at once, nothing more sent', async () => {
  const c = raceClient();
  on({ deleteAfterDays: 0 });
  const s = makeChecked({ parts: 3 });
  c.hold = deferred();
  await service.confirmUpload(s.id, { confirm: true });
  for (let i = 0; i < 100 && store.getParts(s.id)[0].status !== 'uploading'; i++) await immediate();
  await service.updateSettings({ enabled: false });
  assert.strictEqual(statusOf(s.id), 'paused');
  assert.match(store.getShare(s.id).last_error, /turned off/);
  c.hold.resolve();
  await service._idle();
  assert.deepStrictEqual(c.sent, []);
  on();
});

/* ── Delete all, and actions cut short ──────────────────────────────────── */

test('delete all: an unexpected error gives the generic message, never its own text', async () => {
  const c = raceClient();
  c.deleteContent = async () => { throw new Error('EACCES: open C:\\Users\\someone\\secret-path'); };
  on();
  for (const r of store.listShares()) store.deleteShare(r.id);
  const acc = store.insertAccount(TOKEN, 'x');
  const a = makeChecked({ parts: 1 });
  store.updateShare(a.id, { status: 'uploaded', folder_id: 'fo-odd', account_id: acc, link: 'https://gofile.io/d/A' });
  const r = await service.deleteAll({ confirm: true });
  assert.deepStrictEqual(r.results.map(x => [x.ok, x.code, x.error]), [[false, 'ERROR', 'Something went wrong.']]);
  assert.ok(!JSON.stringify(r).includes('secret-path'));
  assert.ok(!String(store.getShare(a.id).last_error).includes('secret-path'), 'not in the row either');
  assert.strictEqual(statusOf(a.id), 'uploaded');
  void c;
});

test('a stop or remove cut short by a restart is finished on the next start', async () => {
  raceClient();
  on();
  const stopped = makePaused({ folder: 'fo-cut' });
  store.updateShare(stopped.id, { status: 'stopping' });
  const nothing = makePaused();
  store.updateShare(nothing.id, { status: 'stopping' });
  const removing = makeChecked();
  store.updateShare(removing.id, { status: 'removing' });
  service._simulateRestart();
  service.ensureRecovered();
  const a = store.getShare(stopped.id);
  assert.strictEqual(a.status, 'failed');
  assert.match(a.last_error, /Stop and delete did not finish/);
  assert.strictEqual(service.getShare(stopped.id).onGofile, true, 'Delete is offered');
  assert.strictEqual(statusOf(nothing.id), 'cancelled');
  assert.strictEqual(store.getShare(removing.id), null);
  await service._idle();
  for (const s of [stopped, nothing, removing]) {
    for (let i = 0; i < 50 && fs.existsSync(s.wd.dir); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(!fs.existsSync(s.wd.dir), 'local parts deleted');
  }
});

test('a stop cut short by a lock ends failed with Delete offered after the unlock', async () => {
  const c = raceClient();
  on();
  const s = makePaused({ folder: 'fo-locked-stop' });
  c.deleteHold = deferred();
  const p = settle(service.stop(s.id, { confirm: true }));
  await ticks();
  vault._locked = true;
  vault._notify('locking');
  assert.strictEqual(statusOf(s.id), 'stopping', 'the lock handler leaves a stopping share alone');
  c.deleteHold.resolve();
  const r = await p;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.e.code, 'VAULT_LOCKED');
  assert.deepStrictEqual(c.deletes, ['fo-locked-stop']);
  vault._locked = false;
  vault._notify('unlocked');
  await ticks();
  service.ensureRecovered();
  assert.strictEqual(statusOf(s.id), 'failed');
  assert.strictEqual(service.getShare(s.id).onGofile, true);
});

/* ── Over HTTP, many times ──────────────────────────────────────────────── */

async function post(p, body) {
  const res = await fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vault-Share': '1' }, body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('over HTTP the queued actions answer their result, not an empty object', async () => {
  raceClient();
  on();
  const s = makeChecked({ parts: 1 });
  store.updateShare(s.id, { status: 'uploaded', folder_id: 'fo-http-gone', link: 'https://gofile.io/d/G1' });
  const r = await post(`/api/share/shares/${s.id}/mark-gone`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.share.status, 'gone');
  const again = await post(`/api/share/shares/${s.id}/mark-gone`);
  assert.strictEqual(again.status, 409);
  assert.strictEqual(again.json.code, 'WRONG_STATE');
  const missing = await post('/api/share/shares/999999/resume');
  assert.strictEqual(missing.status, 404);
});

test('stress over HTTP: cancel vs upload and stop vs resume fired together many times; nothing reaches gofile untracked', async () => {
  on({ onPartFail: 'ask', deleteAfterDays: 1 });
  let seq = 0;
  const c = {
    sent: [], deletes: [],
    async createAccount() { return { token: `${TOKEN}-http` }; },
    async uploadPart(o) {
      for (let i = Math.floor(Math.random() * 4); i > 0; i--) await immediate();
      // Half the time the abort loses the race and the part reaches gofile anyway.
      if (o.signal && o.signal.aborted && Math.random() < 0.5) throw ABORTED();
      const folder = o.folderId || `hf-${++seq}`;
      c.sent.push({ folder, fileName: o.fileName });
      return { fileId: `f-${o.fileName}`, folderId: folder, code: 'Hc1', link: 'https://gofile.io/d/Hc1', md5: 'x' };
    },
    async setExpiry() { await immediate(); },
    async deleteContent(o) { await immediate(); c.deletes.push(o.folderId); },
  };
  service._setForTest({ client: c, sleep: () => immediate() });
  const outcomes = { cancelWon: 0, uploadWon: 0, stopFirst: 0, resumeFirst: 0 };
  const N = 40;
  for (let i = 0; i < N; i++) {
    // Cancel vs Upload.
    const s = makeChecked({ parts: 2 });
    const reqs = [() => post(`/api/share/shares/${s.id}/cancel`), () => post(`/api/share/shares/${s.id}/upload`, { confirm: true })];
    if (i % 2) reqs.reverse();
    const pa = reqs[0]();
    if (i % 3 === 0) await immediate();
    const pb = reqs[1]();
    const [x, y] = await Promise.all([pa, pb]);
    const [cancel, upload] = i % 2 ? [y, x] : [x, y];
    assert.ok(!(cancel.status === 200 && upload.status === 200), `round ${i}: cancel and upload both answered 200`);
    if (cancel.status === 200) {
      outcomes.cancelWon++;
      assert.strictEqual(upload.json.code, 'NOT_FOUND');
    } else {
      outcomes.uploadWon++;
      assert.strictEqual(upload.status, 200);
      assert.strictEqual(cancel.json.code, 'WRONG_STATE');
    }

    // Stop vs Resume, on a paused upload with or without a folder yet.
    const p = makePaused({ folder: i % 2 ? `hp-${i}` : null });
    const pr = [() => post(`/api/share/shares/${p.id}/stop`, { confirm: true }), () => post(`/api/share/shares/${p.id}/resume`)];
    if (i % 2) pr.reverse();
    const qa = pr[0]();
    if (i % 3 === 1) await immediate();
    const qb = pr[1]();
    const [u, v] = await Promise.all([qa, qb]);
    const [stopA, resumeA] = i % 2 ? [v, u] : [u, v];
    if (resumeA.status === 200) outcomes.resumeFirst++;
    else { outcomes.stopFirst++; assert.strictEqual(resumeA.json.code, 'WRONG_STATE'); }
    await service._idle();
    if (stopA.status === 200) {
      assert.strictEqual(stopA.json.share.status, 'cancelled');
      // Stop deleted every folder of that share that reached gofile.
      for (const f of c.sent.filter(z => z.fileName.startsWith(p.name)).map(z => z.folder)) {
        assert.ok(c.deletes.includes(f), `round ${i}: stopped share's folder ${f} not deleted`);
      }
    } else {
      // Only when the resumed upload had already finished: it is on record.
      assert.strictEqual(stopA.json.code, 'WRONG_STATE', `round ${i}: stop ${JSON.stringify(stopA.json)}`);
      assert.strictEqual(resumeA.status, 200);
      assert.strictEqual(statusOf(p.id), 'uploaded');
    }
    // A cancelled share sent nothing.
    if (cancel.status === 200) assert.ok(!c.sent.some(z => z.fileName.startsWith(s.name)), `round ${i}: a cancelled share sent bytes`);
  }
  await service._idle();
  assertTracked(c, 'stress');
  // Both orders really happened, for both pairs.
  assert.ok(outcomes.cancelWon > 0 && outcomes.uploadWon > 0, JSON.stringify(outcomes));
  assert.ok(outcomes.stopFirst > 0 && outcomes.resumeFirst > 0, JSON.stringify(outcomes));
});
