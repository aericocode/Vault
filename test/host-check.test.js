/**
 * The Host allowlist (lib/host-check.js) that stops DNS rebinding.
 *
 * A page on evil.example can re-point its own name at 127.0.0.1 and then read
 * this server same-origin. The Host header still names evil.example, so every
 * request must carry 127.0.0.1, localhost or [::1] with the listening port.
 *
 * The first half tests the pure check and the middleware on their own. The
 * second runs the REAL app (server/index.js) over HTTP and proves a static file,
 * the page itself, /media, an HLS playlist and the API all answer 403 for a
 * foreign Host, ahead of the lock gate and the CSRF guard.
 *
 * Requests go over raw http.request: fetch will not let a caller set Host.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-hostcheck-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const { isAllowedHost, hostCheck, makeRefusalLogger } = require('../lib/host-check');

/* ── The pure check ───────────────────────────────────────────────────────── */

test('the three loopback names with the right port pass', () => {
  for (const h of ['127.0.0.1:8765', 'localhost:8765', '[::1]:8765']) {
    assert.strictEqual(isAllowedHost(h, 8765), true, h);
  }
  assert.strictEqual(isAllowedHost('127.0.0.1:8765', '8765'), true, 'port given as a string');
});

test('localhost compares case-insensitively', () => {
  for (const h of ['LOCALHOST:8765', 'LocalHost:8765', 'localHOST:8765']) {
    assert.strictEqual(isAllowedHost(h, 8765), true, h);
  }
});

test('foreign and look-alike hosts are refused', () => {
  for (const h of [
    'evil.example:8765',
    '127.0.0.1.evil.example:8765',
    'localhost.evil.example:8765',
    'evil.example:8765@127.0.0.1:8765',
    'localhost.:8765',              // trailing dot: a different origin, refused
    '127.0.0.2:8765',
    '0.0.0.0:8765',
    '127.1:8765',
    '::1:8765',                     // unbracketed IPv6 is not a valid Host
    '[::ffff:127.0.0.1]:8765',
    ' 127.0.0.1:8765',
    '127.0.0.1:8765 ',
    '127.0.0.1:8765,evil.example:8765',
  ]) {
    assert.strictEqual(isAllowedHost(h, 8765), false, h);
  }
});

test('a wrong port, an odd port spelling or no port is refused', () => {
  for (const h of ['127.0.0.1:9999', 'localhost:8766', '[::1]:80', '127.0.0.1:08765',
    '127.0.0.1:8765:8765', '127.0.0.1', 'localhost', '[::1]', '127.0.0.1:']) {
    assert.strictEqual(isAllowedHost(h, 8765), false, h);
  }
});

test('a missing or empty Host, or no usable port, is refused', () => {
  assert.strictEqual(isAllowedHost(undefined, 8765), false);
  assert.strictEqual(isAllowedHost('', 8765), false);
  assert.strictEqual(isAllowedHost(['127.0.0.1:8765'], 8765), false, 'not a string');
  for (const p of [undefined, null, 0, NaN, 70000, 'abc', '']) {
    assert.strictEqual(isAllowedHost('127.0.0.1:8765', p), false, String(p));
  }
});

/* ── The middleware alone ─────────────────────────────────────────────────── */

function fakeRes() {
  return {
    statusCode: 200, body: undefined,
    status(n) { this.statusCode = n; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('middleware: good Host calls next, bad Host gets 403 with the code', () => {
  const warned = [];
  const mw = hostCheck({ port: 8765, log: makeRefusalLogger({ warn: m => warned.push(m) }) });

  let nexted = 0;
  const ok = fakeRes();
  mw({ headers: { host: 'localhost:8765' }, method: 'GET', path: '/' }, ok, () => { nexted++; });
  assert.strictEqual(nexted, 1);
  assert.strictEqual(ok.body, undefined);

  const bad = fakeRes();
  mw({ headers: { host: 'evil.example:8765' }, method: 'GET', path: '/api/x' }, bad, () => { nexted++; });
  assert.strictEqual(nexted, 1, 'next was not called');
  assert.strictEqual(bad.statusCode, 403);
  assert.deepStrictEqual(bad.body, { error: 'host not allowed', code: 'HOST_NOT_ALLOWED' });
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /evil\.example:8765/);
});

test('middleware: a port function is asked per request', () => {
  const mw = hostCheck({ port: (req) => req.socket.localPort, log: () => {} });
  let nexted = 0;
  mw({ headers: { host: '127.0.0.1:4000' }, socket: { localPort: 4000 } }, fakeRes(), () => { nexted++; });
  const bad = fakeRes();
  mw({ headers: { host: '127.0.0.1:4000' }, socket: { localPort: 4001 } }, bad, () => { nexted++; });
  assert.strictEqual(nexted, 1);
  assert.strictEqual(bad.statusCode, 403);
});

test('refusal log: one line per distinct Host, capped, and it opens again later', () => {
  const warned = [];
  let t = 1000;
  const log = makeRefusalLogger({ warn: m => warned.push(m), now: () => t });
  const req = { method: 'GET', path: '/' };
  for (let i = 0; i < 5; i++) log('evil.example:1', req);
  assert.strictEqual(warned.length, 1, 'the same Host is logged once');
  for (let i = 0; i < 100; i++) log(`h${i}.example:1`, req);
  assert.strictEqual(warned.length, 21, '20 distinct lines plus one "not logging" line');
  assert.match(warned[20], /not logging each one/);
  log(undefined, req);
  assert.strictEqual(warned.length, 21, 'still capped');
  t += 10 * 60 * 1000;
  log('evil.example:1', req);
  assert.strictEqual(warned.length, 22, 'a new window logs again');
  assert.ok(warned.every(m => !m.includes('—')), 'no em dashes');
});

/* ── The real app over HTTP ───────────────────────────────────────────────── */

const db = require('../lib/database');
const vault = require('../lib/vault');
const streamIndex = require('../lib/stream/index');

let server;
let port;
let mediaId;
let app;

test.before(async () => {
  db.init();
  ({ app } = require('../server/index'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;

  const file = path.join(tmp, 'clip.mkv');
  fs.writeFileSync(file, Buffer.alloc(4096, 1));
  mediaId = Number(db.get().prepare(`INSERT INTO media
    (filepath, filename, media_type, filesize_bytes, duration_seconds, probe_version, video_codec, audio_codec, container)
    VALUES (?, ?, 'video', 4096, 40, 1, 'h264', 'ac3', 'matroska')`)
    .run(file, path.basename(file)).lastInsertRowid);
  db.saveStreamIndex(mediaId, {
    keyframes: [0, 4, 8, 12], segments: [0, 4, 8, 12], containerStart: 0, duration: 40,
    indexVersion: streamIndex.INDEX_VERSION,
  });
});
test.after(async () => {
  vault._locked = false;
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/**
 * Raw request with an exact Host. `host: null` sends no Host header at all
 * (setHost: false), which fetch and the default http.request never do.
 */
function raw(method, target, { host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (host !== null) h.Host = host === undefined ? `127.0.0.1:${port}` : host;
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers: h, setHost: false }, (res) => {
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

const paths = () => ({
  page: '/',
  css: '/css/base.css',
  playerLib: '/player-lib/utils.js',
  media: `/media/${mediaId}`,
  hls: `/stream/${mediaId}/index.m3u8`,
  api: '/api/vault/status',
});

test('app: each allowed Host form reaches static files, the page, /media, HLS and the API', async () => {
  const p = paths();
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LocalHost:${port}`]) {
    for (const [name, target] of Object.entries(p)) {
      const res = await raw('GET', target, { host });
      assert.strictEqual(res.status, 200, `${name} ${target} with Host ${host}`);
    }
    const ranged = await raw('GET', p.media, { host, headers: { Range: 'bytes=0-99' } });
    assert.strictEqual(ranged.status, 206, `ranged /media with Host ${host}`);
    assert.strictEqual(ranged.text.length, 100);
  }
});

/** HTTP/1.0 over a bare socket: the one way a request with no Host reaches Express. */
function rawHttp10(target) {
  return new Promise((resolve, reject) => {
    const sock = require('node:net').connect(port, '127.0.0.1', () => {
      sock.write(`GET ${target} HTTP/1.0\r\n\r\n`);
    });
    const chunks = [];
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const [head, ...rest] = text.split('\r\n\r\n');
      let json = null;
      try { json = JSON.parse(rest.join('\r\n\r\n')); } catch {}
      resolve({ status: Number(head.split(' ')[1]), text, json });
    });
    sock.on('error', reject);
  });
}

test('app: a missing Host never reaches a route', async () => {
  // HTTP/1.1 without Host: Node itself answers 400 before Express runs.
  for (const target of Object.values(paths())) {
    const res = await raw('GET', target, { host: null });
    assert.strictEqual(res.status, 400, `HTTP/1.1 ${target} with no Host`);
  }
  // HTTP/1.0 may leave Host out, so that one is the middleware's to refuse.
  for (const target of Object.values(paths())) {
    const res = await rawHttp10(target);
    assert.strictEqual(res.status, 403, `HTTP/1.0 ${target} with no Host`);
    assert.strictEqual(res.json?.code, 'HOST_NOT_ALLOWED', `HTTP/1.0 ${target}`);
  }
  const good = await new Promise((resolve, reject) => {
    const sock = require('node:net').connect(port, '127.0.0.1', () => {
      sock.write(`GET /api/vault/status HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    });
    const chunks = [];
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('error', reject);
  });
  assert.match(good, /^HTTP\/1\.[01] 200 /, 'HTTP/1.0 with a good Host still works');
});

test('app: a foreign, wrong-port or port-less Host gets 403 on every route', async () => {
  const p = paths();
  for (const host of [`evil.example:${port}`, `127.0.0.1.evil.example:${port}`, '127.0.0.1:9999',
    '127.0.0.1', 'localhost', `localhost.:${port}`, `0.0.0.0:${port}`]) {
    for (const [name, target] of Object.entries(p)) {
      const res = await raw('GET', target, { host });
      assert.strictEqual(res.status, 403, `${name} ${target} with Host ${host}`);
      assert.strictEqual(res.json?.code, 'HOST_NOT_ALLOWED', `${name} ${target} with Host ${host}`);
      assert.ok(!res.text.includes('<html') && !res.text.includes('#EXTM3U'), 'nothing of the route leaks');
    }
  }
  // HEAD, a segment, a thumbnail and a write: all refused before any handler
  for (const [method, target] of [['HEAD', p.media], ['GET', `/stream/${mediaId}/seg/0.ts`],
    ['GET', `/thumb/${mediaId}`], ['GET', '/images/does-not-exist.png'], ['GET', '/no/such/route'],
    ['POST', '/api/trash/empty']]) {
    const res = await raw(method, target, { host: `evil.example:${port}` });
    assert.strictEqual(res.status, 403, `${method} ${target}`);
  }
});

test('app: the Host check runs before the lock gate and the CSRF guard', async () => {
  vault.bootLocked();
  try {
    const bad = await raw('GET', paths().api.replace('vault/status', 'settings/app'), { host: `evil.example:${port}` });
    assert.strictEqual(bad.status, 403, 'not 423: the lock gate never saw it');
    assert.strictEqual(bad.json?.code, 'HOST_NOT_ALLOWED');
    const good = await raw('GET', '/api/settings/app');
    assert.strictEqual(good.status, 423, 'a good Host still meets the lock gate');
  } finally { vault._locked = false; }

  const csrf = await raw('POST', '/api/trash/empty', { host: `evil.example:${port}`, headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(csrf.json?.code, 'HOST_NOT_ALLOWED', 'not CSRF_ORIGIN: the CSRF guard never saw it');
  const csrfGood = await raw('POST', '/api/trash/empty', { headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(csrfGood.json?.code, 'CSRF_ORIGIN', 'the CSRF guard is unchanged behind it');
});
