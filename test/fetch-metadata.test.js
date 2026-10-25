/**
 * Requests another site's page makes (lib/fetch-metadata.js), and the framing
 * and nosniff headers every response carries (server/index.js).
 *
 * Any web page can put <img src="http://127.0.0.1:port/thumb/1"> on itself.
 * That kept the vault from auto-locking (each gated request touched the idle
 * clock) and started work (thumbnails, remux sessions, outbound calls). The
 * browser says where such a request came from in Sec-Fetch-Site; cross-site
 * and same-site are refused, same-origin, none and no header at all pass, and
 * a top-level page load of / still works from a link.
 *
 * The first half tests the pure check, the second the REAL app over HTTP.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-fetchsite-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const { isRefusedCrossSite, fetchMetadataGate, makeRefusalLogger } = require('../lib/fetch-metadata');

const req = (p, h = {}, method = 'GET') => ({ method, path: p, headers: h });
const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

/* ── The pure check ───────────────────────────────────────────────────────── */

test('same-origin, none and no header pass', () => {
  for (const site of ['same-origin', 'none', undefined, '']) {
    const h = site === undefined ? {} : { 'sec-fetch-site': site };
    assert.strictEqual(isRefusedCrossSite(req('/thumb/1', h)), false, String(site));
    assert.strictEqual(isRefusedCrossSite(req('/api/library/query', h, 'POST')), false, String(site));
  }
});

test('cross-site and same-site are refused, whatever the path or method', () => {
  for (const site of ['cross-site', 'same-site', 'CROSS-SITE', ' same-site ']) {
    for (const p of ['/thumb/1', '/api/vault/status', '/media/3', '/stream/3/index.m3u8', '/css/base.css', '/player-lib/utils.js']) {
      assert.strictEqual(isRefusedCrossSite(req(p, { 'sec-fetch-site': site })), true, `${site} ${p}`);
    }
    assert.strictEqual(isRefusedCrossSite(req('/api/vault/touch', { 'sec-fetch-site': site }, 'POST')), true);
  }
});

test('a top-level page load of / from a link still opens the app', () => {
  assert.strictEqual(isRefusedCrossSite(req('/', { 'sec-fetch-site': 'cross-site', ...nav })), false);
  assert.strictEqual(isRefusedCrossSite(req('/', { 'sec-fetch-site': 'same-site', ...nav })), false);
  assert.strictEqual(isRefusedCrossSite(req('/', { 'sec-fetch-site': 'cross-site', ...nav }, 'HEAD')), false);
  // ...but only the page itself, only as a top-level document, only GET/HEAD
  assert.strictEqual(isRefusedCrossSite(req('/media/1', { 'sec-fetch-site': 'cross-site', ...nav })), true, 'other paths');
  assert.strictEqual(isRefusedCrossSite(req('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })), true, 'framed');
  assert.strictEqual(isRefusedCrossSite(req('/', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' })), true, '<img src=/>');
  assert.strictEqual(isRefusedCrossSite(req('/', { 'sec-fetch-site': 'cross-site', ...nav }, 'POST')), true, 'a form post');
});

test('middleware: 403 with the code, one log line, next never called', () => {
  const warned = [];
  const mw = fetchMetadataGate({ log: makeRefusalLogger({ warn: m => warned.push(m) }) });
  let nexted = 0;
  const res = {
    statusCode: 200, body: undefined,
    status(n) { this.statusCode = n; return this; },
    json(b) { this.body = b; return this; },
  };
  mw(req('/thumb/1', { 'sec-fetch-site': 'cross-site' }), res, () => { nexted++; });
  assert.strictEqual(nexted, 0);
  assert.strictEqual(res.statusCode, 403);
  assert.deepStrictEqual(res.body, { error: 'request from another site refused', code: 'CROSS_SITE' });
  assert.strictEqual(warned.length, 1);
  assert.match(warned[0], /\/thumb\/1.*cross-site/);
  mw(req('/thumb/1', { 'sec-fetch-site': 'same-origin' }), res, () => { nexted++; });
  assert.strictEqual(nexted, 1);
});

test('refusal log is capped per window and opens again later', () => {
  const warned = [];
  let t = 1000;
  const log = makeRefusalLogger({ warn: m => warned.push(m), now: () => t });
  for (let i = 0; i < 100; i++) log(req(`/thumb/${i}`, { 'sec-fetch-site': 'cross-site' }));
  assert.strictEqual(warned.length, 21, '20 lines plus one "not logging" line');
  assert.match(warned[20], /not logging each one/);
  t += 10 * 60 * 1000;
  log(req('/thumb/x', { 'sec-fetch-site': 'cross-site' }));
  assert.strictEqual(warned.length, 22);
  assert.ok(warned.every(m => !m.includes('—')), 'no em dashes');
});

/* ── The real app over HTTP ───────────────────────────────────────────────── */

const db = require('../lib/database');
const vault = require('../lib/vault');

let server;
let port;
let mediaId;

test.before(async () => {
  db.init();
  const { app } = require('../server/index');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const file = path.join(tmp, 'pic.jpg');
  fs.writeFileSync(file, Buffer.alloc(64, 1));
  mediaId = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes) VALUES (?, 'pic.jpg', 'image', 64)")
    .run(file).lastInsertRowid);
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function raw(method, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

const targets = () => ({
  page: '/', css: '/css/base.css', js: '/player-lib/utils.js',
  media: `/media/${mediaId}`, api: '/api/vault/status',
});

test('app: another site\'s requests are refused before the lock gate touches the idle clock', async () => {
  for (const site of ['cross-site', 'same-site']) {
    for (const [name, target] of Object.entries(targets())) {
      vault._lastActivity = 0;
      const r = await raw('GET', target, { 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image' });
      assert.strictEqual(r.status, 403, `${site} ${name}`);
      assert.strictEqual(r.json?.code, 'CROSS_SITE', `${site} ${name}`);
      assert.strictEqual(vault._lastActivity, 0, `${site} ${name}: the idle clock was not reset`);
    }
  }
  vault._lastActivity = Date.now();
});

test('app: the viewer itself, typed addresses and tools without the header all work', async () => {
  for (const h of [{ 'Sec-Fetch-Site': 'same-origin' }, { 'Sec-Fetch-Site': 'none' }, {}]) {
    for (const [name, target] of Object.entries(targets())) {
      const r = await raw('GET', target, h);
      assert.strictEqual(r.status, 200, `${JSON.stringify(h)} ${name}`);
    }
  }
  // A gated request from the viewer still counts as the user being present
  vault._lastActivity = 0;
  await raw('GET', '/api/media/' + mediaId, { 'Sec-Fetch-Site': 'same-origin' });
  assert.ok(vault._lastActivity > 0, 'same-origin still touches');
  vault._lastActivity = Date.now();
});

test('app: a link from another site still opens the page', async () => {
  const r = await raw('GET', '/', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /<html/i);
  const q = await raw('GET', '/?tab=faces', { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' });
  assert.strictEqual(q.status, 200, 'with a query string');
});

test('app: framing and nosniff headers on every response, refusals included', async () => {
  const check = (r, what, csp = "frame-ancestors 'self'") => {
    assert.strictEqual(r.headers['x-frame-options'], 'SAMEORIGIN', what);
    assert.strictEqual(r.headers['content-security-policy'], csp, what);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff', what);
  };
  for (const [name, target] of Object.entries(targets())) check(await raw('GET', target), name);
  check(await raw('GET', '/thumb/1', { 'Sec-Fetch-Site': 'cross-site' }), 'a Fetch Metadata refusal');
  check(await raw('GET', '/api/vault/status', { Host: `evil.example:${port}` }), 'a Host refusal');
  // Express's 404 page sets its own CSP: kept, with frame-ancestors appended
  check(await raw('GET', '/no/such/path'), 'a 404', "default-src 'none'; frame-ancestors 'self'");
  // A range request (206) goes out the same way
  check(await raw('GET', `/media/${mediaId}`, { Range: 'bytes=0-9' }), 'a 206');
  // nosniff only matters for scripts and styles, and those carry real types
  assert.match((await raw('GET', '/player-lib/utils.js')).headers['content-type'], /^(text|application)\/javascript/);
  assert.match((await raw('GET', '/css/base.css')).headers['content-type'], /^text\/css/);
});
