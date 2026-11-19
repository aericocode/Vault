/**
 * Share privately: the library lock and the network (lib/share/service.js,
 * _gofile / _uploadPart; lib/share/gofile.js).
 *
 * The lock is simulated exactly as lib/vault.js lock() begins it: the locked
 * flag goes true, 'locking' is notified, and the database is STILL OPEN (it
 * closes only after the stream sessions stop). From then on the test counts
 * every database read (`dbTouched`) and every gofile request the fakes see
 * while locked; both must stay at zero. A request already in flight when the
 * lock lands may finish; what it did is recorded on unlock.
 *
 * Also: a part whose bytes were all sent is answered before a stop acts
 * (late abort), every gofile call is bounded in time, part records made while
 * locked survive a quit (on disk, ids only), the guest account made while
 * locking is linked to its share, and a queued action over HTTP answers 423.
 * Every fake settles when the test says so; time limits are a few ms.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-locknet-'));
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
const { GofileClient, multipartBody } = require('../lib/share/gofile');
const { app } = require('../server/index');

const TOKEN = 'TOKEN-locknet-0123456789abcdef';
const realFetch = globalThis.fetch;
let strayFetches = 0;
let server;
let base;

// The database as the lock sees it: open during 'locking', but nothing of
// the share code may read or write it from then on.
let dbWatch = false;     // the lock has begun: count every use
let dbThrow = false;     // and the handle is gone: every use throws
let dbTouched = 0;
const realGet = db.get;
db.get = function get(...args) {
  if (dbWatch) {
    dbTouched++;
    if (dbThrow) throw Object.assign(new Error('The database is closed.'), { code: 'DB_CLOSED' });
  }
  return realGet.apply(this, args);
};

/** Lock as lib/vault.js lock() begins it. close: the handle then goes too. */
function lockNow({ close = false } = {}) {
  vault._locked = true;
  vault._notify('locking');
  dbWatch = true;
  if (close) { dbThrow = true; vault._notify('locked'); }
}
function unlockNow() {
  dbWatch = false;
  dbThrow = false;
  vault._locked = false;
  vault._notify('unlocked');
}

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
  db.get = realGet;
  db.close();
  try { require('../lib/secure-assets').close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test.afterEach(async () => {
  if (vault._locked) unlockNow();
  dbWatch = false;
  dbThrow = false;
  dbTouched = 0;
  await service._idle();
  service._setForTest({ timeouts: null, sleep: () => immediate() });
  assert.strictEqual(strayFetches, 0, 'a real request was made');
});

const immediate = () => new Promise(r => setImmediate(r));
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await immediate(); };
const until = async (cond, what, n = 400) => {
  for (let i = 0; i < n && !cond(); i++) await immediate();
  assert.ok(cond(), `waited for: ${what}`);
};
function deferred() {
  let resolve; let reject;
  const p = new Promise((a, b) => { resolve = a; reject = b; });
  return { p, resolve, reject };
}
const abortedP = (signal) => new Promise(r => { if (!signal) return; if (signal.aborted) r(); else signal.addEventListener('abort', r, { once: true }); });
const ABORTED = () => Object.assign(new Error('Stopped.'), { code: 'ABORTED' });
const never = () => new Promise(() => {});
let seq = 0;

/**
 * A fake gofile that logs every request with whether the library was locked
 * when it was STARTED (`calls`). Uploads model the real wire: once the body
 * is sent (onBodySent) gofile has the part in its folder (`sent`), whether or
 * not Vault ever reads the answer; an aborted request throws and its answer
 * is lost. `beforeSent` holds a part while its bytes go out; `answer` holds
 * gofile's answer after they are all out.
 */
function fakeGofile() {
  const c = {
    calls: [], sent: [], deletes: [], expiries: [], accounts: [], signals: [],
    beforeSent: null, answer: null, deleteHold: null, expiryHold: null, accountHold: null,
    note(op, o) { c.calls.push({ op, locked: vault.isLocked() }); c.signals.push({ op, signal: o && o.signal }); },
    async createAccount(o = {}) {
      c.note('account', o);
      if (c.accountHold) await c.accountHold.p;        // an abort is lost: gofile made it anyway
      const token = `${TOKEN}-${++seq}`;
      c.accounts.push(token);
      return { token };
    },
    async uploadPart(o) {
      c.note('upload', o);
      await immediate();
      if (o.signal.aborted) throw ABORTED();
      if (c.beforeSent) {
        await Promise.race([c.beforeSent.p, abortedP(o.signal)]);
        if (o.signal.aborted) throw ABORTED();
      }
      o.onBytes(o.size);
      if (o.signal.aborted) throw ABORTED();
      o.onBodySent();
      const folder = o.folderId || `lf-${++seq}`;
      const fileId = `fid-${++seq}`;
      c.sent.push({ folder, fileId, fileName: o.fileName });    // gofile has it now
      if (c.answer) {
        await Promise.race([c.answer.p, abortedP(o.signal)]);
        if (o.signal.aborted) throw ABORTED();          // the answer is never read
      }
      return { fileId, folderId: folder, code: 'Code123', link: 'https://gofile.io/d/Code123', md5: 'x' };
    },
    async setExpiry(o) {
      c.note('expiry', o);
      if (c.expiryHold) await c.expiryHold.p;
      c.expiries.push(o.folderId);
    },
    async deleteContent(o) {
      c.note('delete', o);
      if (c.deleteHold) await c.deleteHold.p;
      c.deletes.push(o.folderId);
    },
  };
  service._setForTest({ client: c, sleep: () => immediate() });
  return c;
}
const lockedCalls = (c) => c.calls.filter(x => x.locked);

function assertTracked(c, what) {
  for (const s of c.sent) {
    const row = store.listShares().find(r => r.folder_id === s.folder);
    assert.ok(row || c.deletes.includes(s.folder), `${what}: ${s.fileName} is on gofile in ${s.folder}, which no share holds and nothing deleted`);
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

function makeUploaded(folder, { timerSet = 1 } = {}) {
  const s = makeChecked({ parts: 1 });
  const acc = store.insertAccount(`${TOKEN}-stored`, service.SESSION);
  store.updateShare(s.id, {
    status: 'uploaded', account_id: acc, folder_id: folder, link: 'https://gofile.io/d/Up1',
    uploaded_at: Date.now(), delete_after: Date.now() + 86400000, timer_set: timerSet,
  });
  return s;
}

function clearShares() {
  for (const r of store.listShares()) store.deleteShare(r.id);
}

const settle = (p) => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
const statusOf = (id) => (store.getShare(id) || {}).status || null;

/* ── Item 1: nothing is sent and nothing is read once the lock begins ─────── */

test('X1 Delete all: the lock lands while the first DELETE is out; no further DELETE, the first is recorded on unlock', async () => {
  const c = fakeGofile();
  on();
  clearShares();
  const a = makeUploaded('xa1');
  const b = makeUploaded('xb1');
  c.deleteHold = deferred();
  const da = settle(service.deleteAll({ confirm: true }));
  await until(() => c.calls.length === 1, 'the first DELETE');
  lockNow();
  c.deleteHold.resolve();
  const r = await da;
  await service._idle();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.e.code, 'VAULT_LOCKED');
  assert.strictEqual(c.calls.length, 1, 'one DELETE only');
  assert.deepStrictEqual(lockedCalls(c), [], 'no request started while locked');
  assert.strictEqual(dbTouched, 0, 'the database was not used while locked');
  unlockNow();
  const [done, left] = c.deletes[0] === 'xa1' ? [a, b] : [b, a];
  assert.deepStrictEqual(c.deletes.length, 1);
  assert.strictEqual(statusOf(done.id), 'deleted', 'the DELETE gofile did is on record');
  assert.strictEqual(statusOf(left.id), 'uploaded', 'the other share is left as it was');
  assert.ok(store.getShare(left.id).folder_id);
});

test('Delete all with one share: the lock lands while its DELETE is out; the answer is VAULT_LOCKED, the DELETE recorded on unlock', async () => {
  const c = fakeGofile();
  on();
  clearShares();
  const a = makeUploaded('xa-one');
  c.deleteHold = deferred();
  const da = settle(service.deleteAll({ confirm: true }));
  await until(() => c.calls.length === 1, 'the DELETE');
  lockNow();
  c.deleteHold.resolve();
  const r = await da;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.e.code, 'VAULT_LOCKED');
  assert.strictEqual(dbTouched, 0);
  unlockNow();
  assert.strictEqual(statusOf(a.id), 'deleted');
});

test('X2 Set timer again twice: the lock lands while the first is out; no second timer request, the first is recorded on unlock', async () => {
  const c = fakeGofile();
  on();
  const a = makeUploaded('xt1', { timerSet: 0 });
  c.expiryHold = deferred();
  const p1 = settle(service.retryTimer(a.id));
  const p2 = settle(service.retryTimer(a.id));
  await until(() => c.calls.length === 1, 'the first timer request');
  lockNow();
  assert.ok(c.signals[0].signal.aborted, 'the timer request in flight got the abort');
  c.expiryHold.resolve();
  const [r1, r2] = await Promise.all([p1, p2]);
  await service._idle();
  assert.strictEqual(r1.e && r1.e.code, 'VAULT_LOCKED');
  assert.strictEqual(r2.e && r2.e.code, 'VAULT_LOCKED');
  assert.strictEqual(c.calls.length, 1, 'one timer request only');
  assert.deepStrictEqual(lockedCalls(c), []);
  assert.strictEqual(dbTouched, 0, 'the database was not used while locked');
  unlockNow();
  assert.strictEqual(store.getShare(a.id).timer_set, 1, 'the timer gofile set is on record');
});

test('X3 Delete twice on one share: the lock lands while the first DELETE is out; no second DELETE, the first ends deleted on unlock', async () => {
  for (const outcome of ['gofile deleted it', 'the abort won']) {
    const c = fakeGofile();
    on();
    const a = makeUploaded(`xd-${seq++}`);
    c.deleteHold = deferred();
    if (outcome === 'the abort won') {
      c.deleteContent = async (o) => { c.note('delete', o); await abortedP(o.signal); throw ABORTED(); };
    }
    const p1 = settle(service.deleteRemote(a.id));
    const p2 = settle(service.deleteRemote(a.id));
    await until(() => c.calls.length === 1, 'the first DELETE');
    lockNow();
    assert.ok(c.signals[0].signal.aborted, `${outcome}: the DELETE in flight got the abort`);
    c.deleteHold.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    await service._idle();
    assert.strictEqual(r1.e && r1.e.code, 'VAULT_LOCKED', outcome);
    assert.strictEqual(r2.e && r2.e.code, 'VAULT_LOCKED', outcome);
    assert.strictEqual(c.calls.length, 1, `${outcome}: one DELETE only`);
    assert.deepStrictEqual(lockedCalls(c), [], outcome);
    assert.strictEqual(dbTouched, 0, `${outcome}: the database was not used while locked`);
    unlockNow();
    if (outcome === 'gofile deleted it') {
      assert.strictEqual(statusOf(a.id), 'deleted');
      // Its folder goes with the clean-up after the unlock; the record keeps
      // the name until then.
      await service._cleanupNow();
      assert.strictEqual(store.getShare(a.id).work_dir, null);
    } else {
      // Not known: left as it was, Delete still offered (a second Delete
      // answers "already gone" if gofile had done it).
      assert.strictEqual(statusOf(a.id), 'uploaded');
      assert.strictEqual(store.getShare(a.id).last_error, null);
      assert.strictEqual(service.getShare(a.id).onGofile, true);
    }
  }
});

test('the request choke point: a lock that lands between the last check and the request still stops it', async () => {
  const c = fakeGofile();
  on();
  const a = makeUploaded('xc1');
  const realGetAccount = store.getAccount;
  store.getAccount = (...args) => {
    const out = realGetAccount(...args);
    lockNow();                    // right before the DELETE would be sent
    return out;
  };
  let r;
  try {
    r = await settle(service.deleteRemote(a.id));
  } finally {
    store.getAccount = realGetAccount;
  }
  assert.strictEqual(r.e && r.e.code, 'VAULT_LOCKED');
  assert.deepStrictEqual(c.calls, [], 'nothing sent');
  unlockNow();
  assert.strictEqual(statusOf(a.id), 'uploaded');
});

test('the request choke point for parts: a lock that lands as a part is about to go stops it', async () => {
  const c = fakeGofile();
  on({ deleteAfterDays: 0 });
  const s = makeChecked({ parts: 1 });
  const acc = store.insertAccount(`${TOKEN}-stored`, service.SESSION);
  store.updateShare(s.id, { account_id: acc });
  const realUpdatePart = store.updatePart;
  store.updatePart = (id, n, patch) => {
    const out = realUpdatePart(id, n, patch);
    if (id === s.id && patch && patch.status === 'uploading' && !vault._locked) lockNow();
    return out;
  };
  try {
    await service.confirmUpload(s.id, { confirm: true });
    await service._idle();
  } finally {
    store.updatePart = realUpdatePart;
  }
  assert.deepStrictEqual(c.calls, [], 'no part sent');
  unlockNow();
  assert.strictEqual(statusOf(s.id), 'paused');
  assert.match(store.getShare(s.id).last_error, /library was locked/);
});

test('the gofile client itself refuses every request while locked, the feature-off delete included', async () => {
  let fetches = 0;
  const fetch = async () => { fetches++; throw new Error('must not be called'); };
  for (const enabled of [true, false]) {
    const c = new GofileClient({ fetch, isEnabled: () => enabled, isOffline: () => false, isLocked: () => true });
    await assert.rejects(c.createAccount({}), { code: 'VAULT_LOCKED' });
    await assert.rejects(c.setExpiry({ token: TOKEN, folderId: 'f1', expiresAtSec: 1 }), { code: 'VAULT_LOCKED' });
    await assert.rejects(c.deleteContent({ token: TOKEN, folderId: 'f1' }), { code: 'VAULT_LOCKED' });
    const f = path.join(tmp, 'part.bin');
    fs.writeFileSync(f, Buffer.alloc(10, 1));
    await assert.rejects(c.uploadPart({ token: TOKEN, filePath: f, fileName: 'a.7z', size: 10 }), { code: 'VAULT_LOCKED' });
  }
  assert.strictEqual(fetches, 0);
});

/* ── Item 2: a queued action meets the lock: 423, never 500 ─────────────── */

async function post(p, body) {
  const res = await realFetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Vault-Share': '1' }, body: JSON.stringify(body || {}),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('over HTTP: every action queued behind one the lock caught answers 423 VAULT_LOCKED, the database closed under them', async () => {
  const c = fakeGofile();
  on();
  const a = makeUploaded('xh1', { timerSet: 0 });
  c.deleteHold = deferred();
  const queued = ['deleteRemote', 'retryTimer', 'markGone', 'remove', 'stop', 'resume', 'pause', 'confirmUpload', 'cancel', 'retryPart'];
  const reached = new Map();
  const saved = {};
  for (const name of queued) {
    saved[name] = service[name];
    service[name] = (...args) => { reached.set(name, (reached.get(name) || 0) + 1); return saved[name](...args); };
  }
  let answers;
  try {
    const first = post(`/api/share/shares/${a.id}/delete-remote`);
    await until(() => c.calls.length === 1, 'the first DELETE');
    const rest = [
      post(`/api/share/shares/${a.id}/delete-remote`),
      post(`/api/share/shares/${a.id}/retry-timer`),
      post(`/api/share/shares/${a.id}/mark-gone`),
      post(`/api/share/shares/${a.id}/remove`, { confirm: true }),
      post(`/api/share/shares/${a.id}/stop`, { confirm: true }),
      post(`/api/share/shares/${a.id}/resume`),
      post(`/api/share/shares/${a.id}/pause`),
      post(`/api/share/shares/${a.id}/upload`, { confirm: true }),
      post(`/api/share/shares/${a.id}/cancel`),
      post(`/api/share/shares/${a.id}/parts/1/retry`),
    ];
    // Every one of them is in the share's queue before the lock.
    for (let i = 0; i < 200 && [...reached.values()].reduce((n, x) => n + x, 0) < 11; i++) await new Promise(r => setTimeout(r, 5));
    assert.strictEqual([...reached.values()].reduce((n, x) => n + x, 0), 11, 'all queued');
    lockNow({ close: true });
    c.deleteHold.resolve();
    answers = await Promise.all([first, ...rest]);
  } finally {
    for (const name of queued) service[name] = saved[name];
  }
  for (const r of answers) {
    assert.strictEqual(r.status, 423, JSON.stringify(r.json));
    assert.strictEqual(r.json.code, 'VAULT_LOCKED');
  }
  assert.strictEqual(dbTouched, 0, 'none of them used the closed database');
  assert.strictEqual(c.calls.length, 1);
  unlockNow();
  await service._idle();
  assert.strictEqual(statusOf(a.id), 'deleted', 'the DELETE gofile did is on record');
});

test('over HTTP: an unexpected error after the lock (a closed database) answers 423, not "Something went wrong"', async () => {
  fakeGofile();
  on();
  const gate = deferred();
  const saved = service.retryTimer;
  service.retryTimer = async () => { await gate.p; return db.get().prepare('SELECT 1').get(); };
  let r;
  try {
    const p = post('/api/share/shares/1/retry-timer');
    await new Promise(res => setTimeout(res, 50));
    lockNow({ close: true });
    gate.resolve();
    r = await p;
  } finally {
    service.retryTimer = saved;
  }
  assert.strictEqual(r.status, 423);
  assert.strictEqual(r.json.code, 'VAULT_LOCKED');
  unlockNow();
});

/* ── Item 3: a part whose bytes are all sent is answered before a stop acts ─ */

test('late abort: Stop after a first part was sent in full waits for gofile, records the folder and deletes it', async () => {
  const c = fakeGofile();
  on({ deleteAfterDays: 0 });
  const s = makeChecked({ parts: 2 });
  c.answer = deferred();
  await service.confirmUpload(s.id, { confirm: true });
  await until(() => c.sent.length === 1, 'the body sent');
  const stopP = settle(service.stop(s.id, { confirm: true }));
  await ticks(10);
  assert.strictEqual(statusOf(s.id), 'stopping');
  const up = c.signals.find(x => x.op === 'upload').signal;
  assert.strictEqual(up.aborted, false, 'a part whose bytes are all out is not aborted');
  c.answer.resolve();
  const r = await stopP;
  assert.ok(r.ok, r.e && r.e.code);
  assert.strictEqual(r.v.status, 'cancelled');
  assert.deepStrictEqual(c.deletes, [c.sent[0].folder], 'the folder gofile made is deleted');
  assert.strictEqual(store.getShare(s.id).last_error, null, 'a clean cancel');
  assert.strictEqual(c.calls.filter(x => x.op === 'upload').length, 1, 'the second part is never sent');
  assertTracked(c, 'stop after body sent');
});

test('late abort: Pause and the lock after a part was sent in full: the answer is waited for and the folder recorded', async () => {
  for (const how of ['pause', 'lock']) {
    const c = fakeGofile();
    on({ deleteAfterDays: 0 });
    const s = makeChecked({ parts: 2 });
    c.answer = deferred();
    await service.confirmUpload(s.id, { confirm: true });
    await until(() => c.sent.length === 1, 'the body sent');
    const pauseP = how === 'pause' ? settle(service.pause(s.id)) : null;
    if (how === 'lock') lockNow();
    await ticks(10);
    assert.strictEqual(c.signals.find(x => x.op === 'upload').signal.aborted, false, `${how}: not aborted`);
    c.answer.resolve();
    if (pauseP) assert.ok((await pauseP).ok);
    await service._idle();
    if (how === 'lock') {
      assert.strictEqual(dbTouched, 0, 'nothing read or written while locked');
      assert.deepStrictEqual(lockedCalls(c), []);
      unlockNow();
    }
    const row = store.getShare(s.id);
    assert.strictEqual(row.status, 'paused', how);
    assert.strictEqual(row.folder_id, c.sent[0].folder, `${how}: the folder is on record`);
    assert.strictEqual(store.getParts(s.id)[0].status, 'done', how);
    assert.strictEqual(c.calls.filter(x => x.op === 'upload').length, 1, `${how}: nothing more sent`);
    assertTracked(c, how);
  }
});

test('Stop while a part is still being sent aborts it at once: a clean cancel, nothing on gofile', async () => {
  const c = fakeGofile();
  on({ deleteAfterDays: 0 });
  const s = makeChecked({ parts: 2 });
  c.beforeSent = deferred();
  await service.confirmUpload(s.id, { confirm: true });
  await until(() => c.calls.some(x => x.op === 'upload'), 'the part on its way');
  const r = await service.stop(s.id, { confirm: true });
  assert.ok(c.signals.find(x => x.op === 'upload').signal.aborted, 'aborted at once');
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(store.getShare(s.id).last_error, null);
  assert.deepStrictEqual(c.sent, []);
  assert.deepStrictEqual(c.deletes, []);
});

test('late abort with no answer in time: Stop does not claim a clean cancel; the share says a part may be on gofile', async () => {
  for (const restartFirst of [false, true]) {
    const c = fakeGofile();
    on({ deleteAfterDays: 0 });
    service._setForTest({ timeouts: { uploadAnswer: 30 } });
    const s = makeChecked({ parts: 2 });
    c.answer = { p: never() };
    await service.confirmUpload(s.id, { confirm: true });
    await until(() => c.sent.length === 1, 'the body sent');
    if (!restartFirst) {
      const r = await service.stop(s.id, { confirm: true });
      assert.strictEqual(r.status, 'cancelled');
      assert.match(r.error, /may be on gofile in a folder Vault does not know/);
      assert.ok(c.signals.find(x => x.op === 'upload').signal.aborted, 'the request is ended at the time limit');
    } else {
      // The note is on the row: a stop after a restart keeps it.
      await service._idle();
      assert.match(store.getShare(s.id).last_error, /may be on gofile/);
      assert.strictEqual(statusOf(s.id), 'paused');
      service._simulateRestart();
      service.ensureRecovered();
      const r = await service.stop(s.id, { confirm: true });
      assert.strictEqual(r.status, 'cancelled');
      assert.match(r.error, /may be on gofile/);
    }
    assert.strictEqual(c.calls.filter(x => x.op === 'upload').length, 1);
  }
});

test('the real client: onBodySent comes once every file byte was taken, before the closing boundary, and never for a body cut short', async () => {
  const f = path.join(tmp, 'body.bin');
  fs.writeFileSync(f, Buffer.alloc(3 * 1024 * 1024 + 17, 7));
  const size = fs.statSync(f).size;
  // Read to the end.
  {
    const events = [];
    let taken = 0;
    let sentAt = null;
    const mp = multipartBody({
      filePath: f, fileName: 'a.7z', size,
      onBytes: (n) => events.push(['bytes', n]),
      onBodySent: () => { events.push(['sent']); sentAt = taken; },
    });
    for await (const chunk of mp.body) taken += chunk.length;
    assert.strictEqual(events.filter(e => e[0] === 'sent').length, 1);
    const bytes = events.filter(e => e[0] === 'bytes').reduce((n, e) => n + e[1], 0);
    assert.strictEqual(bytes, size, 'every file byte before it');
    assert.strictEqual(events[events.length - 1][0], 'sent', 'after the last file read');
    assert.ok(sentAt >= size && sentAt < mp.length, `when the consumer had every file byte but not the closing boundary (${sentAt} of ${mp.length})`);
    assert.strictEqual(taken, mp.length);
  }
  // Cut short (an abort or a fetch that stops reading): never sent.
  {
    let sent = 0;
    const ac = new AbortController();
    const mp = multipartBody({ filePath: f, fileName: 'a.7z', size, signal: ac.signal, onBodySent: () => { sent++; } });
    let n = 0;
    await assert.rejects((async () => { for await (const chunk of mp.body) { if (++n === 2) ac.abort(); void chunk; } })(), { code: 'ABORTED' });
    assert.strictEqual(sent, 0);
  }
  // Through uploadPart and a fetch that reads the body as undici does.
  {
    let sent = 0;
    const fetch = async (url, o) => {
      for await (const chunk of o.body) void chunk;
      return new Response(JSON.stringify({ status: 'ok', data: { id: 'file-1', parentFolder: 'fold-1', parentFolderCode: 'Abc' } }), { status: 200 });
    };
    const c = new GofileClient({ fetch, isEnabled: () => true, isOffline: () => false, isLocked: () => false });
    const r = await c.uploadPart({ token: TOKEN, filePath: f, fileName: 'a.7z', size, onBodySent: () => { sent++; } });
    assert.strictEqual(sent, 1);
    assert.strictEqual(r.folderId, 'fold-1');
  }
});

/* ── Item 4: every gofile call is bounded in time ───────────────────────── */

test('a DELETE that never answers fails with a plain error after the time limit, and the share queue goes on', { timeout: 10000 }, async () => {
  const c = fakeGofile();
  on();
  service._setForTest({ timeouts: { call: 30 } });
  const a = makeUploaded('xto1');
  c.deleteContent = async (o) => { c.note('delete', o); return never(); };   // ignores even the abort
  const p = settle(service.deleteRemote(a.id));
  const q = settle(service.markGone(a.id));
  const r = await p;
  assert.strictEqual(r.e.code, 'NETWORK');
  assert.match(r.e.message, /did not answer in time/);
  assert.ok(c.signals[0].signal && c.signals[0].signal.aborted, 'the request got the abort at the time limit');
  assert.match(store.getShare(a.id).last_error, /did not answer in time/);
  const g = await q;
  assert.ok(g.ok, 'the next action of that share ran');
  assert.strictEqual(g.v.status, 'gone');
});

test('Delete all: a DELETE that never answers fails alone; the next share is deleted', { timeout: 10000 }, async () => {
  const c = fakeGofile();
  on();
  service._setForTest({ timeouts: { call: 30 } });
  clearShares();
  const a = makeUploaded('xto-a');
  const b = makeUploaded('xto-b');
  const real = c.deleteContent;
  c.deleteContent = (o) => (o.folderId === 'xto-a' ? (c.note('delete', o), never()) : real(o));
  const r = await service.deleteAll({ confirm: true });
  const byId = (x, y) => x[0] - y[0];
  assert.deepStrictEqual(r.results.map(x => [x.id, x.ok, x.code || null]).sort(byId), [[a.id, false, 'NETWORK'], [b.id, true, null]]);
  assert.strictEqual(statusOf(b.id), 'deleted');
});

test('Set timer again and a guest account that never answer: plain errors, nothing waits on them', { timeout: 10000 }, async () => {
  const c = fakeGofile();
  on({ accountMode: 'perShare', deleteAfterDays: 0 });
  service._setForTest({ timeouts: { call: 30 } });
  const a = makeUploaded('xto-t', { timerSet: 0 });
  c.setExpiry = async (o) => { c.note('expiry', o); return never(); };
  const r = await settle(service.retryTimer(a.id));
  assert.strictEqual(r.e.code, 'NETWORK');
  assert.strictEqual(store.getShare(a.id).timer_set, 0);
  // The account: the upload pauses with the account message, and Stop works.
  c.createAccount = async (o) => { c.note('account', o); return never(); };
  const s = makeChecked({ parts: 1 });
  await service.confirmUpload(s.id, { confirm: true });
  await service._idle();
  assert.strictEqual(statusOf(s.id), 'paused');
  assert.match(store.getShare(s.id).last_error, /guest account/);
  const st = await service.stop(s.id, { confirm: true });
  assert.strictEqual(st.status, 'cancelled');
});

test('the timer at the end of an upload, never answering: three tries, each bounded, then uploaded with the timer note', { timeout: 10000 }, async () => {
  const c = fakeGofile();
  on({ deleteAfterDays: 7 });
  service._setForTest({ timeouts: { call: 20 } });
  c.setExpiry = async (o) => { c.note('expiry', o); return never(); };
  const s = makeChecked({ parts: 1 });
  await service.confirmUpload(s.id, { confirm: true });
  await service._idle();
  assert.strictEqual(c.calls.filter(x => x.op === 'expiry').length, 3);
  assert.strictEqual(statusOf(s.id), 'uploaded');
  assert.match(store.getShare(s.id).last_error, /timer could not be set/);
});

test('a part with no progress fails after the idle limit; one that keeps moving is not cut off by it', { timeout: 10000 }, async () => {
  const c = fakeGofile();
  on({ onPartFail: 'ask', deleteAfterDays: 0 });
  service._setForTest({ timeouts: { uploadIdle: 40 } });
  // Stalled: no byte taken, no answer.
  c.uploadPart = async (o) => { c.note('upload', o); return never(); };
  const s = makeChecked({ parts: 1 });
  await service.confirmUpload(s.id, { confirm: true });
  await service._idle();
  assert.strictEqual(statusOf(s.id), 'paused');
  assert.match(store.getShare(s.id).last_error, /first part could not be uploaded/);
  assert.strictEqual(store.getParts(s.id)[0].error, 'Could not reach gofile.');
  assert.ok(c.signals[0].signal.aborted, 'the stalled request was ended');
  assert.doesNotMatch(store.getShare(s.id).last_error, /may be on gofile/, 'its body was never sent');
  // Moving: a read every 10 ms for 150 ms, well past the 40 ms idle limit.
  c.uploadPart = async (o) => {
    c.note('upload', o);
    for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 10)); o.onBytes(1); }
    o.onBodySent();
    return { fileId: 'file-m', folderId: 'fold-moving', code: 'Mv1', link: 'https://gofile.io/d/Mv1', md5: 'x' };
  };
  const m = makeChecked({ parts: 1 });
  await service.confirmUpload(m.id, { confirm: true });
  await service._idle();
  assert.strictEqual(statusOf(m.id), 'uploaded');
  assert.strictEqual(store.getShare(m.id).folder_id, 'fold-moving');
  // Released: the stalled share can be stopped.
  assert.strictEqual((await service.stop(s.id, { confirm: true })).status, 'cancelled');
});

test('the gofile client passes the abort signal to the DELETE request, with the feature off too', async () => {
  for (const enabled of [true, false]) {
    let seen = null;
    const fetch = async (url, o) => {
      seen = o.signal;
      return new Response(JSON.stringify({ status: 'ok', data: {} }), { status: 200 });
    };
    const c = new GofileClient({ fetch, isEnabled: () => enabled, isOffline: () => false, isLocked: () => false });
    const ac = new AbortController();
    await c.deleteContent({ token: TOKEN, folderId: 'folder-1', signal: ac.signal });
    assert.strictEqual(seen, ac.signal);
  }
});

/* ── Item 5: a part record made while locked survives a quit ───────────── */

test('a part answered while locked is kept on disk (ids only) and recorded on the next start if Vault quits while locked', async () => {
  for (const quit of [false, true]) {
    const c = fakeGofile();
    on({ deleteAfterDays: 0 });
    const s = makeChecked({ parts: 2 });
    c.answer = deferred();
    await service.confirmUpload(s.id, { confirm: true });
    await until(() => c.sent.length === 1, 'the body sent');
    lockNow();
    c.answer.resolve();
    await service._idle();
    assert.strictEqual(dbTouched, 0);
    const file = path.join(s.wd.dir, '.vault-pending-parts.json');
    assert.ok(fs.existsSync(file), 'kept on disk while locked');
    const text = fs.readFileSync(file, 'utf8');
    assert.deepStrictEqual(JSON.parse(text), [{ shareId: s.id, partNo: 1, folderId: c.sent[0].folder, fileId: c.sent[0].fileId }]);
    for (const secret of [TOKEN, 'Code123', 'gofile.io', s.name, 'Pass-Word']) assert.ok(!text.includes(secret), `no ${secret} on disk`);
    if (quit) service._simulateRestart();
    unlockNow();
    if (quit) assert.strictEqual(store.getShare(s.id).folder_id, null, 'memory lost with the quit');
    service.listShares();
    const row = store.getShare(s.id);
    assert.strictEqual(row.folder_id, c.sent[0].folder, `quit ${quit}: the folder is on record`);
    assert.strictEqual(store.getParts(s.id)[0].status, 'done');
    assert.strictEqual(row.status, quit ? 'not_finished' : 'paused');
    assert.ok(!fs.existsSync(file), `quit ${quit}: the file is gone once written`);
    assertTracked(c, `quit ${quit}`);
    // Stop deletes that folder.
    await service.stop(s.id, { confirm: true });
    assert.ok(c.deletes.includes(c.sent[0].folder));
  }
});

test('a pending-part file with bad content is ignored and removed', async () => {
  fakeGofile();
  on();
  const s = makeChecked({ parts: 2 });
  store.updateShare(s.id, { status: 'paused' });
  const file = path.join(s.wd.dir, '.vault-pending-parts.json');
  fs.writeFileSync(file, JSON.stringify([
    { shareId: s.id, partNo: 1, folderId: 'bad,id', fileId: 'f1' },
    { shareId: s.id + 1000, partNo: 1, folderId: 'other', fileId: 'f1' },
    { shareId: s.id, partNo: 9, folderId: 'nopart', fileId: 'f1' },
  ]));
  service._simulateRestart();
  service.ensureRecovered();
  assert.strictEqual(store.getShare(s.id).folder_id, null);
  assert.ok(!fs.existsSync(file));
});

/* ── The guest account made while locking ───────────────────────────────── */

test('a guest account gofile made after the lock is stored and linked to its share on unlock; Resume uses it', async () => {
  const c = fakeGofile();
  on({ accountMode: 'perShare', deleteAfterDays: 0 });
  const s = makeChecked({ parts: 1 });
  c.accountHold = deferred();
  await service.confirmUpload(s.id, { confirm: true });
  await until(() => c.calls.some(x => x.op === 'account'), 'the account request');
  lockNow();
  c.accountHold.resolve();
  await service._idle();
  assert.strictEqual(dbTouched, 0);
  unlockNow();
  const accId = store.getShare(s.id).account_id;
  assert.ok(accId, 'linked to the share');
  assert.strictEqual(store.getAccount(accId).token, c.accounts[0]);
  c.accountHold = null;
  await service.resume(s.id);
  await service._idle();
  assert.strictEqual(c.calls.filter(x => x.op === 'account').length, 1, 'no second account');
  assert.strictEqual(statusOf(s.id), 'uploaded');
});
