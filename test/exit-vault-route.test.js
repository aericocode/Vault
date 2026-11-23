/**
 * Exit Vault (Settings > General): POST /api/exit in server/index.js.
 *
 * The route stops the whole server, so it is guarded more tightly than an
 * ordinary write: the general guards (Host allowlist, Fetch Metadata, the
 * Origin check, the lock gate) plus its own (an Origin naming this server is
 * required, Sec-Fetch-Site must be same-origin when sent, and the body must be
 * JSON {"exit": true}). These tests stub the shutdown (_setExitForTest) and
 * check it is reached exactly once, only by a request that passes all of them,
 * and only after the answer went out.
 *
 * The last test runs the real shutdown in a child process: the request is
 * answered, the process ends with code 0, and the library file opens cleanly.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-exit-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const config = require('../config');
const server = require('../server/index');

let srv;
let port;
let calls = 0;
let answeredBeforeExit = null;

test.before(async () => {
  db.init();
  await new Promise((resolve) => { srv = server.app.listen(0, '127.0.0.1', resolve); });
  port = srv.address().port;
});
test.after(async () => {
  server._setExitForTest(null);
  vault._locked = false;
  await new Promise((resolve) => srv.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** The CSRF guard allows the configured port's origin (this server listens on a random one). */
const OWN = `http://127.0.0.1:${config.server.port}`;
const OWN_LOCALHOST = `http://localhost:${config.server.port}`;

function raw(method, target, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host) h.Host = host;
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: h }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_YES = JSON.stringify({ exit: true });
const pageHeaders = (extra = {}) => ({
  'Content-Type': 'application/json', Origin: OWN, 'Sec-Fetch-Site': 'same-origin', ...extra,
});
const press = (headers = pageHeaders(), body = JSON_YES, opts = {}) => raw('POST', '/api/exit', { headers, body, ...opts });

function stubExit() {
  calls = 0;
  answeredBeforeExit = null;
  server._setExitForTest(() => { calls++; });
}

/** Let the setImmediate that starts the shutdown run. */
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

test('GET /api/exit says what would stop: nothing here', async () => {
  const r = await raw('GET', '/api/exit', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { share: null, aiScan: false });
});

test('refused without the guards: no Origin, wrong body, wrong content type', async () => {
  stubExit();
  const cases = [
    ['no Origin', { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' }, JSON_YES, 403, 'EXIT_ORIGIN'],
    ['no headers at all (curl)', { 'Content-Type': 'application/json' }, JSON_YES, 403, 'EXIT_ORIGIN'],
    ['form-style text/plain body', pageHeaders({ 'Content-Type': 'text/plain' }), JSON_YES, 400, 'EXIT_BODY'],
    ['form-urlencoded', pageHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }), 'exit=true', 400, 'EXIT_BODY'],
    ['empty JSON', pageHeaders(), '{}', 400, 'EXIT_BODY'],
    ['exit as a string', pageHeaders(), JSON.stringify({ exit: 'true' }), 400, 'EXIT_BODY'],
    ['no body', pageHeaders(), '', 400, 'EXIT_BODY'],
    ['Sec-Fetch-Site none', pageHeaders({ 'Sec-Fetch-Site': 'none' }), JSON_YES, 403, 'EXIT_SITE'],
  ];
  for (const [name, headers, body, status, code] of cases) {
    const r = await press(headers, body);
    assert.strictEqual(r.status, status, name);
    assert.strictEqual(r.json && r.json.code, code, name);
  }
  await settle();
  assert.strictEqual(calls, 0, 'nothing refused reached the shutdown');
});

test('refused cross-origin, cross-site and under another Host name', async () => {
  stubExit();
  const cases = [
    ['another site', pageHeaders({ Origin: 'https://evil.example' }), 'CSRF_ORIGIN'],
    ['Origin null', pageHeaders({ Origin: 'null' }), 'CSRF_ORIGIN'],
    ['another port on this computer', pageHeaders({ Origin: `http://127.0.0.1:${config.server.port + 1}` }), 'CSRF_ORIGIN'],
    ['cross-site fetch metadata', pageHeaders({ 'Sec-Fetch-Site': 'cross-site' }), 'CROSS_SITE'],
    ['same-site (another port)', pageHeaders({ 'Sec-Fetch-Site': 'same-site' }), 'CROSS_SITE'],
  ];
  for (const [name, headers, code] of cases) {
    const r = await press(headers);
    assert.strictEqual(r.status, 403, name);
    assert.strictEqual(r.json && r.json.code, code, name);
  }
  // DNS rebinding: the page's own name for the server is not 127.0.0.1.
  const rebound = await press(pageHeaders({ Origin: `http://evil.example:${port}` }), JSON_YES, { host: `evil.example:${port}` });
  assert.strictEqual(rebound.status, 403);
  assert.strictEqual(rebound.json.code, 'HOST_NOT_ALLOWED');
  // A plain cross-site GET of the activity is refused as well.
  const peek = await raw('GET', '/api/exit', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(peek.status, 403);
  await settle();
  assert.strictEqual(calls, 0);
});

test('refused while the library is locked', async () => {
  stubExit();
  vault.bootLocked();
  try {
    const r = await press();
    assert.strictEqual(r.status, 423);
    assert.strictEqual(r.json.code, 'VAULT_LOCKED');
    const g = await raw('GET', '/api/exit', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.strictEqual(g.status, 423);
  } finally { vault._locked = false; }
  await settle();
  assert.strictEqual(calls, 0);
});

test('only POST stops it: other methods do nothing', async () => {
  stubExit();
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    const r = await raw(m, '/api/exit', { headers: pageHeaders(), body: JSON_YES });
    assert.ok(r.status >= 400, `${m}: ${r.status}`);
  }
  await settle();
  assert.strictEqual(calls, 0);
});

test('accepted from Vault\'s own page: answers first, then shuts down exactly once', async () => {
  calls = 0;
  let answered = false;
  server._setExitForTest(() => { calls++; answeredBeforeExit = answered; });
  const r = await press();
  answered = true;
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { ok: true });
  assert.strictEqual(r.headers.connection, 'close', 'the browser does not reuse the socket');
  await settle();
  assert.strictEqual(calls, 1, 'the shutdown ran once');
  // The stub ran after the client had the whole answer, or on the same turn:
  // never before the answer was sent.
  assert.notStrictEqual(answeredBeforeExit, null);

  // A second press while shutting down: answered, and nothing runs again.
  const again = await press();
  assert.strictEqual(again.status, 200);
  assert.deepStrictEqual(again.json, { ok: true, stopping: true });
  const third = await press(pageHeaders({ Origin: OWN_LOCALHOST }));
  assert.strictEqual(third.status, 200);
  await settle();
  assert.strictEqual(calls, 1, 'still once');
});

test('localhost is Vault\'s own origin too; no Sec-Fetch-Site (older browser) is fine', async () => {
  stubExit();
  const r = await press({ 'Content-Type': 'application/json; charset=utf-8', Origin: OWN_LOCALHOST });
  assert.strictEqual(r.status, 200);
  await settle();
  assert.strictEqual(calls, 1);
});

/* ── The real shutdown, in a child process ─────────────────────────────────
   A whole Vault app (server/index.js) runs in a child with its own library,
   Stage open on test/fixtures/fake-mpv.js (a real child process on a real
   pipe). It is then stopped one of four ways: Exit Vault, or SIGINT (Ctrl+C),
   SIGTERM, SIGHUP (closed terminal) through the handlers start() installs.
   Off Windows the signal is a real one; Windows cannot send those to another
   process, so the child raises it on itself (process.emit) and the same
   handler runs. Each way: the process ends with its code, mpv was asked to
   quit and ended by itself, no mpv is left, and the library opens cleanly. */

const FAKE_MPV = path.join(__dirname, 'fixtures', 'fake-mpv.js');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function httpJson(portN, method, p, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: portN, method, path: p, headers }, (res) => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function runRealVault(how) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-exit-real-'));
  const dbFile = path.join(dir, 'library.db');
  const mpvLog = path.join(dir, 'mpv.log');
  const R = (...p) => JSON.stringify(path.join(__dirname, ...p));
  const child = `
    require(${R('helpers', 'no-real-lm.js')});
    // Stage's mpv is the fake one: found at once, started as "node fake-mpv.js <args>".
    const { spawn } = require('child_process');
    const mpvFind = require(${R('..', 'lib', 'stage', 'mpv-find.js')});
    mpvFind.findMpv = async () => ({ found: true, path: process.execPath, version: 'v0.41.0', source: 'default' });
    const mpvHost = require(${R('..', 'lib', 'stage', 'mpv-host.js')});
    const realHost = mpvHost.createMpvHost;
    mpvHost.createMpvHost = (o) => realHost({ ...o, spawnFn: (exe, args, opts) => spawn(process.execPath, [${JSON.stringify(FAKE_MPV)}, ...args], opts) });
    const db = require(${R('..', 'lib', 'database.js')});
    const config = require(${R('..', 'config')});
    const server = require(${R('..', 'server', 'index.js')});
    db.init();
    db.get().prepare("CREATE TABLE IF NOT EXISTS exit_probe (v TEXT)").run();
    db.get().prepare("INSERT INTO exit_probe (v) VALUES ('kept')").run();
    server._installShutdownHooks();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { const m = /emit (SIG[A-Z]+)/.exec(d); if (m) process.emit(m[1], m[1]); });
    const s = server.app.listen(0, '127.0.0.1', () => {
      process.stdout.write('VAULT-READY ' + JSON.stringify({ port: s.address().port, own: config.server.port }) + '\\n');
    });
  `;
  const env = {
    ...process.env,
    VAULT_DB: dbFile,
    VAULT_SETTINGS_FILE: path.join(dir, 'settings.json'),
    VAULT_THUMBS: path.join(dir, 'thumbs'),
    VAULT_TRASH: path.join(dir, 'trash'),
    VAULT_SUBS: path.join(dir, 'subs'),
    VAULT_SECURE_ASSETS: path.join(dir, 'secure_assets.db'),
    VAULT_TEMP: path.join(dir, 'temp'),
    VAULT_OFFLINE: '1',
    VAULT_DISABLE_NATIVE_PICKER: '1',
    VAULT_STAGE_MUTE: '1',
    FAKE_MPV_LOG: mpvLog,
  };
  delete env.VAULT_DB_PASSWORD;
  delete env.NODE_TEST_CONTEXT;
  const p = spawn(process.execPath, ['-e', child], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  let err = '';
  p.stderr.on('data', d => { err += d; });
  const exited = new Promise((resolve) => p.on('exit', (code, signal) => resolve({ code, signal })));
  const result = {};
  try {
    const info = await new Promise((resolve, reject) => {
      p.stdout.on('data', (d) => {
        out += d;
        const m = /^VAULT-READY (.*)$/m.exec(out);
        if (m) { try { resolve(JSON.parse(m[1])); } catch (e) { reject(e); } }
      });
      p.on('exit', () => reject(new Error(`child ended early: ${err}`)));
    });
    const own = { Origin: `http://127.0.0.1:${info.own}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const opened = await httpJson(info.port, 'POST', '/api/stage/open', own, '{}');
    assert.strictEqual(opened.status, 200, `Stage opened (${opened.text})`);
    assert.strictEqual(opened.json.mode, 'mpv');
    const started = /^start (\d+)$/m.exec(fs.readFileSync(mpvLog, 'utf8'));
    assert.ok(started, 'the fake mpv started');
    result.mpvPid = Number(started[1]);
    assert.ok(pidAlive(result.mpvPid), 'mpv is running before the exit');

    if (how === 'exit') {
      result.answer = await httpJson(info.port, 'POST', '/api/exit', own, JSON_YES);
    } else if (process.platform === 'win32') {
      p.stdin.write(`emit ${how}\n`);
    } else {
      p.kill(how);
    }
    result.end = await exited;
    result.err = err;
    result.mpvLog = fs.readFileSync(mpvLog, 'utf8');
    // Give an mpv that is going a moment to be gone (counted, not timed by the clock).
    for (let i = 0; i < 40 && pidAlive(result.mpvPid); i++) await new Promise(r => setTimeout(r, 50));
    result.mpvAlive = pidAlive(result.mpvPid);
    result.journal = fs.existsSync(dbFile + '-journal');
    const Database = require('better-sqlite3-multiple-ciphers');
    const check = new Database(dbFile, { readonly: true });
    try {
      result.quickCheck = check.pragma('quick_check', { simple: true });
      result.probe = check.prepare('SELECT v FROM exit_probe').get().v;
    } finally { check.close(); }
    return result;
  } finally {
    try { p.kill('SIGKILL'); } catch {}
    try { if (result.mpvPid && pidAlive(result.mpvPid)) process.kill(result.mpvPid, 'SIGKILL'); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

for (const [how, code] of [['exit', 0], ['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`the real shutdown (${how === 'exit' ? 'Exit Vault' : how}): ends with ${code}, mpv Stage quits, the library opens cleanly`, { timeout: 60000 }, async () => {
    const r = await runRealVault(how);
    if (how === 'exit') {
      assert.strictEqual(r.answer.status, 200, 'the page got its answer');
      assert.deepStrictEqual(r.answer.json, { ok: true });
    }
    assert.strictEqual(r.end.code, code, `exit code (stderr: ${r.err})`);
    assert.strictEqual(r.end.signal, null);
    assert.match(r.mpvLog, /^cmd quit$/m, 'mpv was asked to quit');
    assert.match(r.mpvLog, /^exit 0$/m, 'mpv ended by itself');
    assert.strictEqual(r.mpvAlive, false, 'no mpv left behind');
    assert.strictEqual(r.journal, false, 'no hot journal left behind');
    assert.strictEqual(r.quickCheck, 'ok');
    assert.strictEqual(r.probe, 'kept');
  });
}

