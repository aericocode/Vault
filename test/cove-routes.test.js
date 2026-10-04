/**
 * /api/cove/* (the Settings tab's "Move to Cove") over HTTP against the real
 * Express app (server/index.js), the stub Cove from test/helpers/cove-stub.js
 * and a temp Vault library opened through lib/database.js like the server's.
 *
 * Covered: settings saved (address, folders) while the token stays in memory;
 * the token is dropped when the address moves to another origin;
 * check; preview sends only GETs; move refused until a preview with the same
 * settings finished; one job at a time; stop; a lock mid-run ends the job
 * with the plain message; 423 while locked; the report download; the job
 * never writes to the library; the token never shows up in a response, the
 * report or the settings file.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-cove-routes-'));
const SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = SETTINGS_FILE;
process.env.VAULT_OFFLINE = '1';           // loopback must still work
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const coveJob = require('../lib/cove/job');
const { app } = require('../server/index');
const { TOKEN, fillLibrary, createStub, writesOf } = require('./helpers/cove-stub');

let server;
let base;
let stub;
const seen = [];                           // every response body, to check for the token

test.before(async () => {
  db.init();
  fillLibrary(db.get());
  stub = await createStub();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  stub.hold = null;
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
  seen.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitDone() {
  for (let i = 0; i < 500; i++) {
    const s = (await call('GET', '/api/cove/status')).json;
    if (s.state !== 'running') return s;
    await sleep(10);
  }
  throw new Error('job never finished');
}
/** Hold every stub request until release() (to catch a job mid-run). */
function holdStub() {
  let release;
  stub.hold = new Promise(r => { release = r; });
  return () => { stub.hold = null; release(); };
}
const changes = () => db.get().prepare('SELECT total_changes() AS n').get().n;

test('settings: the address and folders are saved, the token is not', async () => {
  let r = await call('GET', '/api/cove/settings');
  assert.deepStrictEqual(r.json, { url: 'http://127.0.0.1:5073', maps: [], hasToken: false, encrypted: false });

  r = await call('GET', '/api/cove/report');
  assert.strictEqual(r.status, 404, 'no report before any run');

  r = await call('PUT', '/api/cove/settings', { url: 'ftp://x', maps: [] });
  assert.strictEqual(r.status, 400);
  r = await call('PUT', '/api/cove/settings', { maps: [{ from: 'D:\\Media', to: '' }] });
  assert.strictEqual(r.status, 400);

  r = await call('PUT', '/api/cove/settings', {
    url: stub.url, token: TOKEN,
    maps: [{ from: ' D:\\Media ', to: '/media' }, { from: '', to: '' }],
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { url: stub.url, maps: [{ from: 'D:\\Media', to: '/media' }], hasToken: true, encrypted: false });
  const onDisk = fs.readFileSync(SETTINGS_FILE, 'utf8');
  assert.deepStrictEqual(JSON.parse(onDisk).coveMaps, [{ from: 'D:\\Media', to: '/media' }]);
  assert.strictEqual(JSON.parse(onDisk).coveUrl, stub.url);
  assert.ok(!onDisk.includes(TOKEN), 'the token is never written to disk');

  // The global CSRF guard covers these routes too.
  const x = await fetch(`${base}/api/cove/preview`, { method: 'POST', headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(x.status, 403);
});

test('check: version, counts and login state; a wrong or missing token is explained', async () => {
  let r = await call('POST', '/api/cove/check');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json, { ok: true, version: '1.5.0-test', counts: { videos: 303, images: 1, audios: 1 }, authEnabled: true });

  await call('PUT', '/api/cove/settings', { token: 'wrong' });
  r = await call('POST', '/api/cove/check');
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.json.code, 'TOKEN_REJECTED');
  assert.doesNotMatch(r.json.error, /COVE_TOKEN/, 'Settings wording, not the command line\'s');

  await call('PUT', '/api/cove/settings', { token: '' });
  r = await call('POST', '/api/cove/check');
  assert.strictEqual(r.json.code, 'NO_TOKEN');
  assert.strictEqual(r.json.authEnabled, true);
  assert.match(r.json.error, /login turned on/);

  await call('PUT', '/api/cove/settings', { url: 'http://127.0.0.1:9' });
  r = await call('POST', '/api/cove/check');
  assert.strictEqual(r.json.code, 'UNREACHABLE');
  assert.match(r.json.error, /Could not reach Cove at http:\/\/127\.0\.0\.1:9\. Is Cove running\?/);

  await call('PUT', '/api/cove/settings', { url: stub.url, token: TOKEN });
  assert.deepStrictEqual(writesOf(stub), []);
});

test('preview reads only, then move is allowed; a settings change asks for a new preview', async () => {
  const before = changes();
  let r = await call('POST', '/api/cove/move');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'NEEDS_PREVIEW');

  stub.requests.length = 0;
  r = await call('POST', '/api/cove/preview');
  assert.strictEqual(r.status, 202, r.text);
  assert.strictEqual(r.json.state, 'running');
  assert.strictEqual(r.json.mode, 'preview');
  let s = await waitDone();
  assert.strictEqual(s.state, 'done', s.error);
  assert.deepStrictEqual(writesOf(stub), [], 'a preview sends nothing but GET');
  assert.strictEqual(s.summary.mode, 'dry run');
  assert.deepStrictEqual(s.summary.matched.byKind, { video: 2, image: 1, audio: 1 });
  assert.deepStrictEqual(s.notFound, ['D:\\Media\\missing.mp4']);
  assert.strictEqual(s.notFoundTotal, 1);
  assert.strictEqual(s.canMove, true);
  assert.strictEqual(s.inputsCurrent, true);
  assert.strictEqual(s.report, undefined, 'the status carries no report body');
  assert.deepStrictEqual(s.inputs, { url: stub.url, maps: ['D:\\Media=/media'], hasToken: true });

  // Changing the folders (even back again) needs a new preview.
  await call('PUT', '/api/cove/settings', { maps: [] });
  await call('PUT', '/api/cove/settings', { maps: [{ from: 'D:\\Media', to: '/media' }] });
  r = await call('POST', '/api/cove/move');
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await call('GET', '/api/cove/status')).json.canMove, false);
  // Saving the same values again is not a change.
  r = await call('POST', '/api/cove/preview');
  s = await waitDone();
  await call('PUT', '/api/cove/settings', { url: stub.url, maps: [{ from: 'D:\\Media', to: '/media' }] });
  assert.strictEqual((await call('GET', '/api/cove/status')).json.canMove, true);

  r = await call('POST', '/api/cove/move');
  assert.strictEqual(r.status, 202, r.text);
  s = await waitDone();
  assert.strictEqual(s.state, 'done', s.error);
  assert.strictEqual(s.summary.mode, 'apply');
  assert.strictEqual(s.summary.errors, 0, JSON.stringify(s.problems));
  assert.strictEqual(stub.media.video.get(101).customFields.vault_id, 1);
  assert.ok(stub.requests.every(r2 => r2.auth === `Bearer ${TOKEN}`), 'the token went to Cove');

  // Again: everything is already up to date.
  stub.requests.length = 0;
  await call('POST', '/api/cove/preview');
  s = await waitDone();
  assert.strictEqual(s.summary.items.changed, 0);
  await call('POST', '/api/cove/move');
  s = await waitDone();
  assert.strictEqual(s.summary.items.changed, 0);
  assert.strictEqual(s.summary.items.upToDate, 4);
  assert.deepStrictEqual(writesOf(stub), [], 'a second move sends no writes');

  assert.strictEqual(changes(), before, 'the Vault library was never written');
});

test('report download: the last run\'s report as an attachment, without the token', async () => {
  const r = await call('GET', '/api/cove/report');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="cove-report-\d{8}-\d{6}\.json"$/);
  assert.strictEqual(r.json.mode, 'apply');
  assert.ok(Array.isArray(r.json.unmatched));
  assert.ok(!r.text.includes(TOKEN));
});

test('one job at a time, Stop, and settings are frozen while a job runs', async () => {
  const release = holdStub();
  let r = await call('POST', '/api/cove/preview');
  assert.strictEqual(r.status, 202);
  r = await call('POST', '/api/cove/move');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'JOB_BUSY');
  r = await call('POST', '/api/cove/preview');
  assert.strictEqual(r.status, 409);
  r = await call('PUT', '/api/cove/settings', { maps: [] });
  assert.strictEqual(r.status, 409);

  r = await call('POST', '/api/cove/stop');
  assert.deepStrictEqual(r.json, { stopping: true });
  release();
  const s = await waitDone();
  assert.strictEqual(s.state, 'stopped');
  assert.match(s.error, /^Stopped\./);
  assert.strictEqual(s.canMove, false, 'a stopped preview does not count');
  assert.strictEqual((await call('POST', '/api/cove/stop')).json.stopping, false);
});

test('a lock mid-run ends the job with the plain message; every route is 423 while locked', async () => {
  const release = holdStub();
  let r = await call('POST', '/api/cove/preview');
  assert.strictEqual(r.status, 202);
  // What vault.lock() does, without needing an encrypted library.
  vault._locked = true;
  vault._notify('locked');
  try {
    for (const [method, p] of [['GET', '/api/cove/status'], ['GET', '/api/cove/settings'], ['POST', '/api/cove/preview'],
      ['POST', '/api/cove/move'], ['POST', '/api/cove/check'], ['GET', '/api/cove/report']]) {
      r = await call(method, p);
      assert.strictEqual(r.status, 423, `${method} ${p}`);
    }
  } finally {
    vault._locked = false;
    release();
  }
  const s = await waitDone();
  assert.strictEqual(s.state, 'stopped');
  assert.strictEqual(s.error, coveJob.LOCKED_MSG);
  assert.strictEqual(s.error, 'Vault locked during the move. Unlock and run it again; it picks up where it left off.');
});

test('a new Cove address on another host drops the token; the same host keeps it', async () => {
  const other = await createStub();
  try {
    let r = await call('PUT', '/api/cove/settings', { url: stub.url, token: TOKEN });
    assert.strictEqual(r.json.hasToken, true);

    // Same origin, written differently (trailing slash, a path, upper case): kept.
    for (const same of [`${stub.url}/`, `${stub.url}/some/path`, stub.url.replace('http://', 'HTTP://')]) {
      r = await call('PUT', '/api/cove/settings', { url: same });
      assert.strictEqual(r.status, 200, r.text);
      assert.strictEqual(r.json.hasToken, true, same);
    }
    r = await call('PUT', '/api/cove/settings', { url: `${stub.url}/` });
    stub.requests.length = 0;
    r = await call('POST', '/api/cove/check');
    assert.strictEqual(r.json.ok, true, r.text);
    assert.ok(stub.requests.length > 0 && stub.requests.every(q => q.auth === `Bearer ${TOKEN}`));

    // Another host (another port is another origin): the token is dropped
    // and the new host never sees it.
    r = await call('PUT', '/api/cove/settings', { url: other.url });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.hasToken, false);
    assert.strictEqual((await call('GET', '/api/cove/settings')).json.hasToken, false);
    r = await call('POST', '/api/cove/check');
    assert.strictEqual(r.json.code, 'NO_TOKEN');
    assert.ok(other.requests.length > 0, 'the check reached the new host');
    assert.ok(other.requests.every(q => q.auth === undefined), 'no Authorization header to the new host');

    // Moving back does not bring the old token back.
    r = await call('PUT', '/api/cove/settings', { url: stub.url });
    assert.strictEqual(r.json.hasToken, false);

    // A token sent together with the new address is kept.
    r = await call('PUT', '/api/cove/settings', { url: other.url, token: TOKEN });
    assert.strictEqual(r.json.hasToken, true);
  } finally {
    await call('PUT', '/api/cove/settings', { url: stub.url, token: TOKEN });
    await other.close();
  }
});

test('the token never appears in any response', () => {
  assert.ok(seen.length > 20);
  for (const body of seen) assert.ok(!body.includes(TOKEN), body.slice(0, 200));
});
