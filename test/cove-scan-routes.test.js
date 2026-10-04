/**
 * "Get your files into Cove" over HTTP (/api/cove/folders, /api/cove/scan)
 * against the real Express app, the stub Cove (whole-config PUT, scans, jobs)
 * and a temp Vault library: folders derived from the library, adding roots
 * keeps every other config field and the existing roots in order, covers-only
 * vs everything, a completed scan chains into a preview, Stop, a failed scan,
 * the permission fallbacks, rows Cove found nothing in, not-found reasons.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-cove-scan-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const coveJob = require('../lib/cove/job');
const { app } = require('../server/index');
const { TOKEN, fillLibrary, createStub } = require('./helpers/cove-stub');

let server;
let base;
let stub;

test.before(async () => {
  coveJob._setScanPollMs(5);
  db.init();
  fillLibrary(db.get());
  stub = await createStub();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  await call('PUT', '/api/cove/settings', { url: stub.url, token: TOKEN, maps: [{ from: 'D:\\Media', to: '/media' }] });
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await stub.close();
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function call(method, p, body) {
  const res = await fetch(base + p, {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
/** Until nothing runs (a scan that chains into a preview counts as one run). */
async function settle() {
  for (let i = 0; i < 1000; i++) {
    const s = (await call('GET', '/api/cove/status')).json;
    if (s.state !== 'running') return s;
    await sleep(10);
  }
  throw new Error('never settled');
}
const changes = () => db.get().prepare('SELECT total_changes() AS n').get().n;

test('folders: the library\'s folder, mapped, and what Cove lets Vault do', async () => {
  const r = await call('GET', '/api/cove/folders');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.rows, [{ vaultPath: 'D:\\Media', covePath: '/media', items: 5, mapped: true, state: 'add', note: null, innerRoots: [] }],
    'trashed items and documents are not counted');
  assert.deepStrictEqual(r.json.roots, ['/other']);
  assert.strictEqual(r.json.canAddFolders, true);
  assert.strictEqual(r.json.canScan, true);
});

test('add + scan (covers only): the root is appended, nothing else changes, and the preview follows', async () => {
  const before = JSON.parse(JSON.stringify(stub.config));
  const dbBefore = changes();
  const r = await call('POST', '/api/cove/scan', { addFolders: true });
  assert.strictEqual(r.status, 202, r.text);
  assert.strictEqual(r.json.mode, 'scan');
  const s = await settle();
  assert.strictEqual(s.mode, 'preview', 'the preview started by itself');
  assert.strictEqual(s.state, 'done', s.error);
  assert.strictEqual(s.canMove, true);
  assert.deepStrictEqual(s.lastScan.added, ['/media']);
  assert.strictEqual(s.lastScan.state, 'done');
  assert.strictEqual(s.lastScan.coveStatus, 'completed');

  const { covePaths, ...rest } = stub.config;
  const { covePaths: rootsBefore, ...restBefore } = before;
  assert.deepStrictEqual(rest, restBefore, 'every other config field kept');
  assert.strictEqual(stub.config.downloaderSiteCredentials[0].password, 'stored-secret', 'the stored password survived the round trip');
  assert.deepStrictEqual(covePaths, [...rootsBefore,
    { path: '/media', excludeVideo: false, excludeImage: false, excludeAudio: false, excludeText: false }]);
  const cfgCalls = stub.requests.filter(x => x.path === '/api/system/config').map(x => x.method);
  const put = cfgCalls.indexOf('PUT');
  assert.strictEqual(cfgCalls.filter(m => m === 'PUT').length, 1);
  assert.strictEqual(cfgCalls[put - 1], 'GET', 'read right before the write');

  assert.deepStrictEqual(stub.scans.at(-1), coveJob.scanOptions(['/media'], 'covers'));
  assert.strictEqual(changes(), dbBefore, 'the Vault library was never written');

  const f = (await call('GET', '/api/cove/folders')).json;
  assert.strictEqual(f.rows[0].state, 'in');
});

test('only scan, everything: no config write, scanGenerators on', async () => {
  const puts = () => stub.requests.filter(x => x.method === 'PUT' && x.path === '/api/system/config').length;
  const n = puts();
  const r = await call('POST', '/api/cove/scan', { addFolders: false, generate: 'all' });
  assert.strictEqual(r.status, 202, r.text);
  await settle();
  assert.deepStrictEqual(stub.scans.at(-1), { paths: ['/media'], scanGenerators: true });
  assert.strictEqual(puts(), n);
  assert.strictEqual((await call('POST', '/api/cove/scan', { addFolders: true })).json.code, 'NOTHING_TO_ADD');
});

test('stop scan cancels Cove\'s job and no preview follows; a failed scan says so', async () => {
  stub.scanPolls = 100000;
  let r = await call('POST', '/api/cove/scan', { addFolders: false });
  assert.strictEqual(r.status, 202);
  assert.strictEqual((await call('POST', '/api/cove/preview')).status, 409, 'one job at a time');
  await sleep(30);
  assert.deepStrictEqual((await call('POST', '/api/cove/stop')).json, { stopping: true });
  let s = await settle();
  assert.strictEqual(s.mode, 'scan');
  assert.strictEqual(s.state, 'stopped');
  assert.strictEqual(s.error, coveJob.SCAN_STOPPED_MSG);
  assert.strictEqual([...stub.jobs.values()].at(-1).status, 'cancelled');
  assert.ok(stub.requests.some(x => x.method === 'DELETE' && x.path.startsWith('/api/jobs/')));

  stub.scanPolls = 2;
  stub.scanOutcome = 'failed';
  r = await call('POST', '/api/cove/scan', { addFolders: false });
  s = await settle();
  stub.scanOutcome = 'completed';
  assert.strictEqual(s.mode, 'scan');
  assert.strictEqual(s.state, 'error');
  assert.strictEqual(s.error, 'Cove\'s scan failed: disk on fire');
});

test('without settings or scan permission: plain messages, and Only scan still works', async () => {
  stub.permissions = ['files.read', 'system.read', 'tags.read', 'groups.read', 'videos.read', 'images.read', 'audios.read', 'library.scan'];
  let f = (await call('GET', '/api/cove/folders')).json;
  assert.strictEqual(f.canAddFolders, false);
  assert.strictEqual(f.canScan, true);
  let r = await call('POST', '/api/cove/scan', { addFolders: true });
  assert.strictEqual(r.status, 403);
  assert.match(r.json.error, /Add the folders in Cove's Settings yourself/);
  r = await call('POST', '/api/cove/scan', { addFolders: false });
  assert.strictEqual(r.status, 202);
  assert.strictEqual((await settle()).state, 'done');

  stub.permissions = stub.permissions.filter(p => p !== 'library.scan');
  f = (await call('GET', '/api/cove/folders')).json;
  assert.strictEqual(f.canScan, false);
  r = await call('POST', '/api/cove/scan', { addFolders: false });
  assert.strictEqual(r.status, 403);
  assert.match(r.json.error, /Tasks page/);
  stub.permissions = null;
});

test('a scanned folder Cove found nothing in turns amber; not-found items carry a reason', async () => {
  // Point the mapping somewhere Cove's library has no files (and Cove holds none of them).
  const saved = stub.media;
  stub.media = { video: new Map(), image: new Map(), audio: new Map() };
  stub.config.covePaths.push({ path: '/nowhere', excludeVideo: false, excludeImage: false, excludeAudio: false, excludeText: false });
  await call('PUT', '/api/cove/settings', { maps: [{ from: 'D:\\Media', to: '/nowhere' }] });
  const r = await call('POST', '/api/cove/scan', { addFolders: false });
  assert.strictEqual(r.status, 202, r.text);
  const s = await settle();
  stub.media = saved;
  assert.strictEqual(s.mode, 'preview');
  assert.strictEqual(s.notFoundTotal, 5);
  assert.deepStrictEqual(s.notFoundDetail.find(x => x.path === 'D:\\Media\\missing.mp4'),
    { path: 'D:\\Media\\missing.mp4', reason: 'File no longer exists' });
  const f = (await call('GET', '/api/cove/folders')).json;
  assert.strictEqual(f.rows[0].state, 'empty');
  assert.strictEqual(f.rows[0].note, 'Cove found no files here. Check the folder mapping.');
  await call('PUT', '/api/cove/settings', { maps: [{ from: 'D:\\Media', to: '/media' }] });
});

test('POST /scan holds the slot: settings, check, preview and move get 409 while it prepares, and only its own token is used', async () => {
  let release;
  stub.hold = new Promise(r => { release = r; });
  const scanP = call('POST', '/api/cove/scan', { addFolders: false });
  await sleep(50);
  const put = await call('PUT', '/api/cove/settings', { url: 'http://127.0.0.1:5999', token: 'TOKEN-B' });
  assert.strictEqual(put.status, 409, 'settings are frozen while the scan is being prepared');
  for (const p of ['/api/cove/check', '/api/cove/preview', '/api/cove/move', '/api/cove/scan']) {
    assert.strictEqual((await call('POST', p, {})).status, 409, p);
  }
  const from = stub.requests.length;
  stub.hold = null;
  release();
  assert.strictEqual((await scanP).status, 202);
  const s = await settle();
  assert.strictEqual(s.mode, 'preview');
  assert.ok(stub.requests.slice(from).every(r => r.auth === `Bearer ${TOKEN}`), 'never TOKEN-B, never without a token');
  assert.strictEqual((await call('GET', '/api/cove/settings')).json.url, stub.url, 'the refused change did not land');
});

test('a Cove that stops answering while a scan is prepared: status says so, and Stop lets go of the slot', async () => {
  let release;
  stub.hold = new Promise(r => { release = r; });
  const writesBefore = stub.requests.filter(x => x.method !== 'GET').length;
  const scanP = call('POST', '/api/cove/scan', { addFolders: true });
  await sleep(50);
  assert.strictEqual((await call('GET', '/api/cove/status')).json.starting, true, 'the page can tell something is going on');
  assert.deepStrictEqual((await call('POST', '/api/cove/stop')).json, { stopping: true });
  const r = await scanP;
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'STOPPED');
  assert.strictEqual((await call('GET', '/api/cove/status')).json.starting, false);
  const put = await call('PUT', '/api/cove/settings', { maps: [{ from: 'D:\\Media', to: '/media' }] });
  assert.strictEqual(put.status, 200, 'settings can be changed again: the slot is free');
  stub.hold = null;
  release();
  await sleep(30);
  assert.strictEqual(stub.requests.filter(x => x.method !== 'GET').length, writesBefore, 'nothing was written to Cove');
});

test('Stop while folders are being added: Cove\'s settings are not written and no scan starts', async () => {
  const savedRoots = stub.config.covePaths;
  stub.config.covePaths = savedRoots.filter(p => p.path !== '/media');
  const rootsBefore = JSON.stringify(stub.config.covePaths);
  let release;
  let mes = 0;
  // Hold Cove's answers from the job's own permission check on (the second /me):
  // the job is then inside "adding folders", before its config write.
  stub.beforeRequest = (method, p) => {
    if (method === 'GET' && p === '/api/auth/me' && ++mes === 2) stub.hold = new Promise(r => { release = r; });
  };
  const r = await call('POST', '/api/cove/scan', { addFolders: true });
  assert.strictEqual(r.status, 202, r.text);
  await sleep(50);
  assert.deepStrictEqual((await call('POST', '/api/cove/stop')).json, { stopping: true });
  const s = await settle();
  stub.beforeRequest = null;
  stub.hold = null;
  release();
  await sleep(30);
  assert.strictEqual(s.mode, 'scan');
  assert.strictEqual(s.state, 'stopped');
  assert.strictEqual(JSON.stringify(stub.config.covePaths), rootsBefore, 'no folder was added after Stop');
  const scansBefore = stub.scans.length;
  await sleep(30);
  assert.strictEqual(stub.scans.length, scansBefore, 'no scan was started');
  stub.config.covePaths = savedRoots;
});

test('a scan Cove forgets is a failure, not a completion; a scan stuck in Cove\'s queue ends with a plain message', async () => {
  stub.scanPolls = 100000;
  stub.jobsForgotten = true;
  let r = await call('POST', '/api/cove/scan', { addFolders: false });
  assert.strictEqual(r.status, 202, r.text);
  let s = await settle();
  stub.jobsForgotten = false;
  assert.deepStrictEqual([s.mode, s.state, s.error], ['scan', 'error', coveJob.SCAN_LOST_MSG], 'no preview chained');

  coveJob._setScanPendingLimitMs(30);
  stub.scanStaysPending = true;
  r = await call('POST', '/api/cove/scan', { addFolders: false });
  s = await settle();
  stub.scanStaysPending = false;
  coveJob._setScanPendingLimitMs(10 * 60 * 1000);
  assert.deepStrictEqual([s.mode, s.state, s.error], ['scan', 'error', coveJob.SCAN_PENDING_MSG]);
});

test('Stop never claims a scan stopped that Cove kept running', async () => {
  // DELETE refused by Cove.
  stub.cancelFails = true;
  let r = await call('POST', '/api/cove/scan', { addFolders: false });
  await sleep(30);
  assert.deepStrictEqual((await call('POST', '/api/cove/stop')).json, { stopping: true });
  let s = await settle();
  stub.cancelFails = false;
  assert.deepStrictEqual([s.mode, s.state, s.error], ['scan', 'error', coveJob.SCAN_CANT_STOP_MSG]);

  // No jobs.cancel: Stop is refused, the scan is followed to the end and the preview still comes.
  stub.permissions = ['files.read', 'system.read', 'tags.read', 'groups.read', 'videos.read', 'images.read', 'audios.read', 'library.scan'];
  r = await call('POST', '/api/cove/scan', { addFolders: false });
  assert.strictEqual(r.status, 202);
  assert.strictEqual(r.json.scan.canStop, false);
  assert.deepStrictEqual((await call('POST', '/api/cove/stop')).json, { stopping: false, error: coveJob.SCAN_CANT_STOP_MSG });
  stub.scanPolls = 0;
  s = await settle();
  stub.permissions = null;
  stub.scanPolls = 2;
  assert.deepStrictEqual([s.mode, s.state], ['preview', 'done']);
});
