/**
 * The vault lock gate (server/index.js) against the real Express app.
 *
 * Express routes case-insensitively and ignores a trailing slash, so
 * GET /API/settings/app runs the /api/settings/app handler. The gate used a
 * case-sensitive startsWith('/api/') and let every upper- or mixed-case data
 * request straight through a locked vault. These tests pin every spelling of a
 * data route to 423 while locked, prove the same spellings still work (or still
 * 404, for the ones Express never routed) once unlocked, and keep the lock
 * screen itself loadable while locked.
 *
 * Requests go over raw http.request, not fetch: fetch/URL normalise the path
 * ("//api" even becomes a host), which would hide the exact bytes under test.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-lockgate-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const { app, isLockGatedPath } = require('../server/index');

let server;
let port;

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
test.after(async () => {
  vault._locked = false;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** Raw request: `target` goes on the request line byte for byte. */
function raw(method, target, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
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

async function whileLocked(fn) {
  vault.bootLocked();
  try { return await fn(); } finally { vault._locked = false; }
}

// Spellings Express DOES route to GET /api/settings/app (a route that never
// touches the DB, so it would answer even with the database closed).
const ROUTED_VARIANTS = [
  '/api/settings/app',
  '/API/settings/app',
  '/Api/Settings/App',
  '/aPI/sEtTiNgS/aPp',
  '/api/settings/app/',
  '/API/SETTINGS/APP/',
  '/API/settings/app?x=1',
];

// Spellings Express does NOT route today (404 when unlocked). The gate still
// closes them, so a future router/proxy that normalises them cannot open a hole.
const UNROUTED_VARIANTS = [
  '//api/settings/app',
  '///API/settings/app',
  '/%61pi/settings/app',
  '/%41PI/settings/app',
  '/api%2Fsettings/app',
  '/%2Fapi/settings/app',
  '/%2F%2FAPI/settings/app',
];

test('locked: every spelling of a data route answers 423', async () => {
  await whileLocked(async () => {
    for (const p of [...ROUTED_VARIANTS, ...UNROUTED_VARIANTS]) {
      const res = await raw('GET', p);
      assert.strictEqual(res.status, 423, `GET ${p}`);
      assert.strictEqual(res.json?.code, 'VAULT_LOCKED', `GET ${p}`);
    }
    // absolute-form request target (the proxy form of the request line)
    const abs = await raw('GET', `http://127.0.0.1:${port}/API/settings/app`);
    assert.strictEqual(abs.status, 423, 'absolute-form /API/settings/app');
  });
});

test('locked: case variants of every gated prefix, writes included, answer 423', async () => {
  await whileLocked(async () => {
    for (const [method, p] of [
      ['POST', '/API/trash/empty'], ['POST', '/Api/Trash/Empty/'], ['POST', '//api/trash/empty'],
      ['GET', '/API/library/version'], ['GET', '/Api/Library/Version/'],
      ['GET', '/MEDIA/1'], ['GET', '/Media/by-path?p=x'], ['GET', '/THUMB/1'], ['GET', '/Thumb/1/'],
      ['GET', '/STREAM/1/index.m3u8'], ['GET', '/FRAME/1'],
      // hover-scrub frames were never on the gate's list at all
      ['GET', '/scrub/1/0'], ['GET', '/SCRUB/1/0'],
    ]) {
      const res = await raw(method, p, method === 'POST'
        ? { body: '{}', headers: { 'Content-Type': 'application/json' } } : {});
      assert.strictEqual(res.status, 423, `${method} ${p}`);
      assert.strictEqual(res.json?.code, 'VAULT_LOCKED', `${method} ${p}`);
    }
  });
});

test('unlocked: the routed spellings still reach the handler', async () => {
  vault._locked = false;
  const canonical = await raw('GET', '/api/settings/app');
  assert.strictEqual(canonical.status, 200);
  for (const p of ROUTED_VARIANTS) {
    const res = await raw('GET', p);
    assert.strictEqual(res.status, 200, `GET ${p}`);
    assert.deepStrictEqual(res.json, canonical.json, `GET ${p}`);
  }
  const lib = await raw('GET', '/Api/Library/Version/');
  assert.strictEqual(lib.status, 200);
  assert.strictEqual(typeof lib.json.version, 'number');
});

test('unlocked: the unrouted spellings are still plain 404s, not 423', async () => {
  vault._locked = false;
  for (const p of UNROUTED_VARIANTS) {
    const res = await raw('GET', p);
    assert.strictEqual(res.status, 404, `GET ${p}`);
  }
});

test('locked: the lock screen and its assets still load', async () => {
  await whileLocked(async () => {
    const root = await raw('GET', '/');
    assert.strictEqual(root.status, 200);
    assert.match(root.headers['content-type'], /text\/html/);

    for (const p of ['/css/base.css', '/images/favicon.svg']) {
      const res = await raw('GET', p);
      assert.strictEqual(res.status, 200, `GET ${p}`);
    }

    for (const p of ['/api/vault/status', '/API/Vault/Status']) {
      const res = await raw('GET', p);
      assert.strictEqual(res.status, 200, `GET ${p}`);
      assert.strictEqual(res.json.locked, true, `GET ${p}`);
    }

    const touch = await raw('POST', '/api/vault/touch');
    assert.strictEqual(touch.status, 200);
    assert.deepStrictEqual(touch.json, { ok: true });
  });
});

test('isLockGatedPath: data prefixes in any form, nothing else', () => {
  for (const p of ['/api', '/API', '/api/', '/Api/x', '//api/x', '/%61pi/x', '/api%2Fx', '/MEDIA/1',
    '/thumb/1', '/Frame/1', '/stream/1/seg/a', '/Scrub/1/0', '/%2Fscrub/1/0']) {
    assert.strictEqual(isLockGatedPath(p), true, p);
  }
  for (const p of ['/', '/css/base.css', '/CSS/base.css', '/images/favicon.svg', '/player-lib/x.js',
    '/apix', '/api-docs', '/mediafile', '/thumbs', '/images/api/x.png', '/%E0%A4%A']) {
    assert.strictEqual(isLockGatedPath(p), false, p);
  }
});
