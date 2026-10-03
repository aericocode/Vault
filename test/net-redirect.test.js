/**
 * lib/net.js redirect handling: credentials must not follow a redirect to a
 * different origin, same-origin hops keep them, and method/body rewriting
 * matches WHATWG fetch (303 -> GET, 301/302 POST -> GET, 307/308 preserved).
 *
 * Two loopback servers on random ports stand in for "origin A" and "origin B"
 * (different port = different origin). Loopback is never gated, so this runs
 * offline. Each server records every request it sees.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { netFetch } = require('../lib/net');

function makeServer(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const route = routes[req.url];
      if (!route) { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      res.writeHead(route.status, { Location: route.location() });
      res.end();
    });
  });
  return { server, seen, routes };
}

let A, B, baseA, baseB;

test.before(async () => {
  A = makeServer({});
  B = makeServer({});
  await new Promise(r => A.server.listen(0, '127.0.0.1', r));
  await new Promise(r => B.server.listen(0, '127.0.0.1', r));
  baseA = `http://127.0.0.1:${A.server.address().port}`;
  baseB = `http://127.0.0.1:${B.server.address().port}`;

  // A: cross-origin bounce to B, same-origin bounce within A, and method tests.
  A.routes['/to-b'] = { status: 302, location: () => `${baseB}/final` };
  A.routes['/to-b-then-back'] = { status: 302, location: () => `${baseB}/back-to-a` };
  B.routes['/back-to-a'] = { status: 302, location: () => `${baseA}/final` };
  A.routes['/same'] = { status: 302, location: () => '/final' };
  A.routes['/see-other'] = { status: 303, location: () => '/final' };
  A.routes['/found'] = { status: 302, location: () => '/final' };
  A.routes['/temp'] = { status: 307, location: () => '/final' };
});

test.after(() => {
  A.server.close();
  B.server.close();
});

test.beforeEach(() => {
  A.seen.length = 0;
  B.seen.length = 0;
});

const CREDS = {
  Authorization: 'Bearer secret-token',
  'Proxy-Authorization': 'Basic cHJveHk6cHc=',
  Cookie: 'session=abc',
  'X-Trace': 'keep-me',
};

test('cross-origin redirect strips Authorization, Proxy-Authorization and Cookie', async () => {
  const res = await netFetch(`${baseA}/to-b`, { purpose: 'tool', headers: { ...CREDS } });
  assert.strictEqual(res.status, 200);

  assert.strictEqual(A.seen.length, 1);
  assert.strictEqual(A.seen[0].headers.authorization, 'Bearer secret-token', 'first hop still authenticated');

  assert.strictEqual(B.seen.length, 1);
  const h = B.seen[0].headers;
  assert.strictEqual(h.authorization, undefined, 'bearer token leaked cross-origin');
  assert.strictEqual(h['proxy-authorization'], undefined);
  assert.strictEqual(h.cookie, undefined);
  assert.strictEqual(h['x-trace'], 'keep-me', 'non-credential headers survive');
});

test('stripping is case-insensitive and works with a Headers instance', async () => {
  const headers = new Headers({ AUTHORIZATION: 'Bearer secret-token' });
  await netFetch(`${baseA}/to-b`, { purpose: 'tool', headers });
  assert.strictEqual(B.seen[0].headers.authorization, undefined);
  assert.strictEqual(headers.get('authorization'), 'Bearer secret-token', 'caller Headers not mutated');
});

test('caller headers object is not mutated', async () => {
  const headers = { ...CREDS };
  await netFetch(`${baseA}/to-b`, { purpose: 'tool', headers });
  assert.deepStrictEqual(headers, CREDS);
});

test('credentials stay dropped after bouncing back to the original origin', async () => {
  await netFetch(`${baseA}/to-b-then-back`, { purpose: 'tool', headers: { ...CREDS } });
  assert.strictEqual(B.seen[0].headers.authorization, undefined);
  const final = A.seen.find(r => r.url === '/final');
  assert.ok(final, 'reached /final on A');
  assert.strictEqual(final.headers.authorization, undefined);
});

test('same-origin redirect keeps Authorization', async () => {
  const res = await netFetch(`${baseA}/same`, { purpose: 'tool', headers: { ...CREDS } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(B.seen.length, 0);
  assert.strictEqual(A.seen.length, 2);
  const final = A.seen[1];
  assert.strictEqual(final.url, '/final');
  assert.strictEqual(final.headers.authorization, 'Bearer secret-token');
  assert.strictEqual(final.headers.cookie, 'session=abc');
});

test('303 turns POST into GET without body or body headers', async () => {
  await netFetch(`${baseA}/see-other`, {
    purpose: 'tool', method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
    body: JSON.stringify({ x: 1 }),
  });
  assert.strictEqual(A.seen[0].method, 'POST');
  const final = A.seen[1];
  assert.strictEqual(final.method, 'GET');
  assert.strictEqual(final.body, '');
  assert.strictEqual(final.headers['content-type'], undefined);
  assert.strictEqual(final.headers.authorization, 'Bearer secret-token', 'same-origin 303 keeps auth');
});

test('303 turns PUT into GET', async () => {
  await netFetch(`${baseA}/see-other`, { purpose: 'tool', method: 'PUT', body: 'x' });
  assert.strictEqual(A.seen[1].method, 'GET');
  assert.strictEqual(A.seen[1].body, '');
});

test('302 turns POST into GET', async () => {
  await netFetch(`${baseA}/found`, { purpose: 'tool', method: 'POST', body: 'payload' });
  assert.strictEqual(A.seen[1].method, 'GET');
  assert.strictEqual(A.seen[1].body, '');
});

test('307 preserves method and body', async () => {
  await netFetch(`${baseA}/temp`, {
    purpose: 'tool', method: 'POST',
    headers: { 'Content-Type': 'text/plain' }, body: 'payload',
  });
  const final = A.seen[1];
  assert.strictEqual(final.method, 'POST');
  assert.strictEqual(final.body, 'payload');
  assert.strictEqual(final.headers['content-type'], 'text/plain');
});
