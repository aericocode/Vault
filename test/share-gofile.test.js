/**
 * Share privately: the gofile client (lib/share/gofile.js) against a fake
 * gofile (an injected fetch), and the 'share' purpose in lib/net.js.
 *
 * Covered: guest account, upload into a folder (what the multipart body
 * holds and does not hold), timer, delete, a rate limit answer (429 and
 * error-rateLimit), an error status with HTTP 200, the md5 check, feature
 * off making zero requests for everything but the delete (which makes exactly
 * one DELETE /contents and cannot be widened to another method, host or
 * path), VAULT_OFFLINE making zero requests, deletes included (the real
 * netFetch with the global fetch replaced by a counter), the host allowlist
 * on every hop, and tokens never appearing in an error message or a URL.
 *
 * No request ever leaves this machine: the global fetch is replaced for the
 * whole file and fails the test if anything reaches it unexpectedly.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-gofile-'));
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');

const config = require('../config');
const { netFetch, isShareUrl } = require('../lib/net');
const { GofileClient, multipartBody, safeLink, _featureOffAllowsDeleteForTest } = require('../lib/share/gofile');

const TOKEN = 'TOKEN-abcdefghijklmnop0123456789';
const realFetch = globalThis.fetch;
let globalCalls = [];
globalThis.fetch = async (url) => { globalCalls.push(String(url)); throw new Error('real fetch must not be reached in this test'); };

test.after(() => {
  globalThis.fetch = realFetch;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const PART = path.join(tmp, 'Abc.7z.001');
fs.writeFileSync(PART, crypto.randomBytes(200 * 1024));
const PART_SIZE = fs.statSync(PART).size;
const PART_MD5 = crypto.createHash('md5').update(fs.readFileSync(PART)).digest('hex');

async function readBody(body) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  const chunks = [];
  for await (const c of body) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fake gofile: routes by method + URL, records every call. */
function fakeGofile(handlers = {}) {
  const calls = [];
  const fetch = async (url, opts) => {
    const buf = await readBody(opts.body);
    const call = { url, method: opts.method, headers: new Headers(opts.headers), body: buf, purpose: opts.purpose };
    calls.push(call);
    const key = `${opts.method} ${url.replace(/\/contents\/[^/]+\/update$/, '/contents/:id/update')}`;
    const fn = handlers[key];
    if (!fn) return json(404, { status: 'error-notFound', data: {} });
    return fn(call);
  };
  return { fetch, calls };
}

const okUpload = (extra = {}) => () => json(200, {
  status: 'ok',
  data: { id: 'file-1', parentFolder: 'folder-1', parentFolderCode: 'AbC123', downloadPage: 'https://gofile.io/d/AbC123', md5: PART_MD5, size: PART_SIZE, ...extra },
});

const client = (fake, o = {}) => new GofileClient({ fetch: fake.fetch, isEnabled: () => o.enabled !== false, isOffline: () => !!o.offline });

test('guest account: POST /accounts with no body, token read from data', async () => {
  const fake = fakeGofile({ 'POST https://api.gofile.io/accounts': () => json(200, { status: 'ok', data: { id: 'acc', token: TOKEN, tier: 'guest' } }) });
  const r = await client(fake).createAccount();
  assert.deepStrictEqual(r, { token: TOKEN });
  assert.strictEqual(fake.calls.length, 1);
  assert.strictEqual(fake.calls[0].body.length, 0);
  assert.strictEqual(fake.calls[0].purpose, 'share');
});

test('account and timer requests take an abort signal; an aborted one reads as ABORTED', async () => {
  const seen = [];
  const fetch = async (url, opts) => {
    seen.push(opts.signal);
    if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return json(200, { status: 'ok', data: { token: TOKEN } });
  };
  const c = new GofileClient({ fetch, isEnabled: () => true, isOffline: () => false });
  const ac = new AbortController();
  await c.createAccount({ signal: ac.signal });
  await c.setExpiry({ token: TOKEN, folderId: 'folder-1', expiresAtSec: 1, signal: ac.signal });
  assert.deepStrictEqual(seen, [ac.signal, ac.signal]);
  ac.abort();
  await assert.rejects(c.createAccount({ signal: ac.signal }), { code: 'ABORTED' });
  await assert.rejects(c.setExpiry({ token: TOKEN, folderId: 'folder-1', expiresAtSec: 1, signal: ac.signal }), { code: 'ABORTED' });
});

test('upload: multipart holds only the file and folderId, bearer token in the header, streamed with a length', async () => {
  const fake = fakeGofile({ 'POST https://upload.gofile.io/uploadfile': okUpload() });
  let seen = 0;
  const r = await client(fake).uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE, folderId: 'folder-1', onBytes: (n) => { seen += n; } });
  assert.deepStrictEqual(r, { fileId: 'file-1', folderId: 'folder-1', code: 'AbC123', link: 'https://gofile.io/d/AbC123', md5: PART_MD5 });
  assert.strictEqual(seen, PART_SIZE);
  const c = fake.calls[0];
  assert.strictEqual(c.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.strictEqual(Number(c.headers.get('content-length')), c.body.length);
  assert.ok(!c.url.includes(TOKEN));
  const boundary = /boundary=(.+)$/.exec(c.headers.get('content-type'))[1];
  // The boundary is random hex only: it does not name Vault (or anything).
  assert.match(boundary, /^[0-9a-f]{48}$/);
  assert.ok(!/vault/i.test(c.body.toString('latin1')), 'nothing in the body names Vault');
  const text = c.body.toString('latin1');
  const fields = [...text.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(fields, ['folderId', 'file']);
  assert.ok(text.includes('filename="Abc.7z.001"'));
  // The file bytes are there, exactly once, between the head and the tail.
  const fileStart = c.body.indexOf('\r\n\r\n', text.indexOf('name="file"')) + 4;
  const fileEnd = c.body.lastIndexOf(Buffer.from(`\r\n--${boundary}--\r\n`));
  assert.ok(c.body.subarray(fileStart, fileEnd).equals(fs.readFileSync(PART)));
});

test('first part goes without folderId', async () => {
  const fake = fakeGofile({ 'POST https://upload.gofile.io/uploadfile': okUpload() });
  await client(fake).uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE });
  assert.ok(!fake.calls[0].body.toString('latin1').includes('name="folderId"'));
});

test('md5 or size from gofile that does not match fails the part', async () => {
  const fake = fakeGofile({ 'POST https://upload.gofile.io/uploadfile': okUpload({ md5: '0'.repeat(32) }) });
  await assert.rejects(client(fake).uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE }), { code: 'UPLOAD_MISMATCH' });
  const fake2 = fakeGofile({ 'POST https://upload.gofile.io/uploadfile': okUpload({ size: 1 }) });
  await assert.rejects(client(fake2).uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE }), { code: 'UPLOAD_MISMATCH' });
});

test('a part that is not the size the checks saw is never sent whole', async () => {
  const fake = fakeGofile({ 'POST https://upload.gofile.io/uploadfile': okUpload() });
  await assert.rejects(client(fake).uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE - 10 }), { code: 'PART_CHANGED' });
});

test('an odd link or ids in the answer are not trusted', async () => {
  assert.strictEqual(safeLink('javascript:alert(1)', 'AbC'), 'https://gofile.io/d/AbC');
  assert.strictEqual(safeLink('https://evil.example/d/AbC', 'AbC'), 'https://gofile.io/d/AbC');
  assert.strictEqual(safeLink('https://gofile.io/d/AbC?x=1', 'bad code!'), null);
  const fake = fakeGofile({ 'POST https://upload.gofile.io/uploadfile': okUpload({ parentFolder: '../../accounts' }) });
  await assert.rejects(client(fake).uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE }), { code: 'BAD_ANSWER' });
});

test('timer: PUT contents/{id}/update with expiry; delete: DELETE contents with the id', async () => {
  const fake = fakeGofile({
    'PUT https://api.gofile.io/contents/:id/update': () => json(200, { status: 'ok', data: {} }),
    'DELETE https://api.gofile.io/contents': () => json(200, { status: 'ok', data: {} }),
  });
  const c = client(fake);
  await c.setExpiry({ token: TOKEN, folderId: 'folder-1', expiresAtSec: 1800000000 });
  await c.deleteContent({ token: TOKEN, folderId: 'folder-1' });
  assert.strictEqual(fake.calls[0].url, 'https://api.gofile.io/contents/folder-1/update');
  assert.deepStrictEqual(JSON.parse(fake.calls[0].body), { attribute: 'expiry', attributeValue: 1800000000 });
  assert.deepStrictEqual(JSON.parse(fake.calls[1].body), { contentsId: 'folder-1' });
  for (const call of fake.calls) assert.strictEqual(call.headers.get('authorization'), `Bearer ${TOKEN}`);
});

test('rate limit: HTTP 429 and status error-rateLimit both read as RATE_LIMIT', async () => {
  const a = fakeGofile({ 'POST https://api.gofile.io/accounts': () => json(429, {}) });
  await assert.rejects(client(a).createAccount(), { code: 'RATE_LIMIT' });
  const b = fakeGofile({ 'POST https://api.gofile.io/accounts': () => json(200, { status: 'error-rateLimit', data: {} }) });
  await assert.rejects(client(b).createAccount(), { code: 'RATE_LIMIT' });
});

test('an error status with HTTP 200 is an error; messages never hold the token', async () => {
  const fake = fakeGofile({ 'PUT https://api.gofile.io/contents/:id/update': () => json(200, { status: 'error-notPremium', data: {} }) });
  const err = await client(fake).setExpiry({ token: TOKEN, folderId: 'folder-1', expiresAtSec: 1 }).catch(e => e);
  assert.strictEqual(err.code, 'GOFILE_ERROR');
  assert.strictEqual(err.gofileStatus, 'error-notPremium');
  assert.ok(!JSON.stringify({ m: err.message, s: err.stack }).includes(TOKEN));
  const nf = fakeGofile({});
  await assert.rejects(client(nf).deleteContent({ token: TOKEN, folderId: 'x' }), { code: 'NOT_FOUND' });
  const broken = new GofileClient({ fetch: async () => { throw new Error(`boom ${TOKEN}`); }, isEnabled: () => true, isOffline: () => false });
  const e2 = await broken.createAccount().catch(e => e);
  assert.strictEqual(e2.code, 'NETWORK');
  assert.ok(!e2.message.includes(TOKEN));
});

test('an error made from an answer gofile sent is marked answered; no connection, an abort or a check before sending is not', async () => {
  const up = (handler, o = {}) => client(fakeGofile({ 'POST https://upload.gofile.io/uploadfile': handler }))
    .uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE, ...o }).catch(e => e);
  // Answers: rate limit (both kinds), an error status, not found, an answer that does not check out.
  for (const [handler, code] of [
    [() => json(429, {}), 'RATE_LIMIT'],
    [() => json(200, { status: 'error-rateLimit', data: {} }), 'RATE_LIMIT'],
    [() => json(200, { status: 'error-notPremium', data: {} }), 'GOFILE_ERROR'],
    [() => json(500, { status: 'ok', data: {} }), 'GOFILE_ERROR'],
    [() => json(404, {}), 'NOT_FOUND'],
    [okUpload({ md5: '0'.repeat(32) }), 'UPLOAD_MISMATCH'],
    [okUpload({ parentFolder: '../../x' }), 'BAD_ANSWER'],
  ]) {
    const err = await up(handler);
    assert.strictEqual(err.code, code);
    assert.strictEqual(err.answered, true, `${code} is an answer`);
  }
  // No answer: the connection failed, the request was aborted, or nothing was sent.
  const noNet = new GofileClient({ fetch: async () => { throw new Error('connect ETIMEDOUT'); }, isEnabled: () => true, isOffline: () => false });
  const e1 = await noNet.uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE }).catch(e => e);
  assert.strictEqual(e1.code, 'NETWORK');
  assert.strictEqual(e1.answered, undefined);
  const ac = new AbortController();
  ac.abort();
  const aborted = new GofileClient({ fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, isEnabled: () => true, isOffline: () => false });
  const e2 = await aborted.uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE, signal: ac.signal }).catch(e => e);
  assert.strictEqual(e2.code, 'ABORTED');
  assert.strictEqual(e2.answered, undefined);
  const e3 = await up(okUpload(), { folderId: 'bad folder!' });
  assert.strictEqual(e3.code, 'BAD_ANSWER');
  assert.strictEqual(e3.answered, undefined, 'refused before sending: not an answer');
});

test('feature off: account, upload (first part or later) and timer make zero requests', async () => {
  const fake = fakeGofile({
    'POST https://api.gofile.io/accounts': () => json(200, { status: 'ok', data: { token: TOKEN } }),
    'POST https://upload.gofile.io/uploadfile': okUpload(),
    'PUT https://api.gofile.io/contents/:id/update': () => json(200, { status: 'ok', data: {} }),
  });
  const c = client(fake, { enabled: false });
  await assert.rejects(c.createAccount(), { code: 'FEATURE_OFF' });
  await assert.rejects(c.uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE }), { code: 'FEATURE_OFF' });
  await assert.rejects(c.uploadPart({ token: TOKEN, filePath: PART, fileName: 'Abc.7z.001', size: PART_SIZE, folderId: 'folder-1' }), { code: 'FEATURE_OFF' });
  await assert.rejects(c.setExpiry({ token: TOKEN, folderId: 'f', expiresAtSec: 1 }), { code: 'FEATURE_OFF' });
  assert.strictEqual(fake.calls.length, 0);
});

test('feature off: delete makes exactly one DELETE /contents with the folder id and the bearer token', async () => {
  const fake = fakeGofile({ 'DELETE https://api.gofile.io/contents': () => json(200, { status: 'ok', data: {} }) });
  await client(fake, { enabled: false }).deleteContent({ token: TOKEN, folderId: 'folder-1' });
  assert.strictEqual(fake.calls.length, 1);
  const c = fake.calls[0];
  assert.strictEqual(c.method, 'DELETE');
  assert.strictEqual(c.url, 'https://api.gofile.io/contents');
  assert.strictEqual(c.purpose, 'share');
  assert.strictEqual(c.headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.deepStrictEqual(JSON.parse(c.body), { contentsId: 'folder-1' });
  assert.ok(!c.url.includes(TOKEN));
});

test('feature off and VAULT_OFFLINE: delete makes zero requests, also through the real netFetch', async () => {
  const fake = fakeGofile({ 'DELETE https://api.gofile.io/contents': () => json(200, { status: 'ok', data: {} }) });
  await assert.rejects(client(fake, { enabled: false, offline: true }).deleteContent({ token: TOKEN, folderId: 'folder-1' }), { code: 'NET_OFF' });
  await assert.rejects(client(fake, { enabled: true, offline: true }).deleteContent({ token: TOKEN, folderId: 'folder-1' }),
    { code: 'NET_OFF', message: 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be deleted from gofile.' });
  assert.strictEqual(fake.calls.length, 0);

  const prev = config.net.offline;
  config.net.offline = true;
  globalCalls = [];
  try {
    const real = new GofileClient({ isEnabled: () => false });
    await assert.rejects(real.deleteContent({ token: TOKEN, folderId: 'folder-1' }), { code: 'NET_OFF' });
  } finally {
    config.net.offline = prev;
  }
  assert.strictEqual(globalCalls.length, 0);
});

test('the feature-off allowance is the delete call only: no other method, host or path, and no way to ask for it', async () => {
  // The rule, against the delete's own operation token.
  assert.strictEqual(_featureOffAllowsDeleteForTest('DELETE', 'https://api.gofile.io/contents'), true);
  for (const [method, url] of [
    ['POST', 'https://api.gofile.io/contents'], ['PUT', 'https://api.gofile.io/contents'],
    ['GET', 'https://api.gofile.io/contents'], ['delete', 'https://api.gofile.io/contents'],
    ['DELETE', 'https://upload.gofile.io/contents'], ['DELETE', 'https://upload.gofile.io/uploadfile'],
    ['DELETE', 'https://api.gofile.io/accounts'], ['DELETE', 'https://api.gofile.io/contents/'],
    ['DELETE', 'https://api.gofile.io/contents/folder-1'], ['DELETE', 'https://api.gofile.io/contents/folder-1/update'],
    ['DELETE', 'https://api.gofile.io/contents?x=1'], ['DELETE', 'https://api.gofile.io/contents#x'],
    ['DELETE', 'https://API.gofile.io/contents'], ['DELETE', 'http://api.gofile.io/contents'],
    ['DELETE', 'https://api.gofile.io:443/contents'], ['DELETE', 'https://evil.example/contents'],
    ['DELETE', 'https://api.gofile.io.evil.com/contents'], [undefined, 'https://api.gofile.io/contents'],
  ]) {
    assert.strictEqual(_featureOffAllowsDeleteForTest(method, url), false, `${method} ${url}`);
  }

  // _request is the path every other call takes: it never lifts the switch,
  // whatever is passed after the options, the delete's exact request included.
  const fake = fakeGofile({ 'DELETE https://api.gofile.io/contents': () => json(200, { status: 'ok', data: {} }) });
  const c = client(fake, { enabled: false });
  const del = { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ contentsId: 'folder-1' }) };
  for (const extra of [undefined, null, true, 'deleteContent', 'gofile.deleteContent', Symbol('gofile.deleteContent'), Symbol.for('gofile.deleteContent'), { op: 'delete' }]) {
    await assert.rejects(c._request('https://api.gofile.io/contents', del, extra), { code: 'FEATURE_OFF' });
    await assert.rejects(c._request('https://api.gofile.io/accounts', { method: 'POST' }, extra), { code: 'FEATURE_OFF' });
  }
  // The delete call sends one folder id only: a list or a path is refused before anything is sent.
  for (const folderId of ['a,b', 'folder-1,folder-2', '../accounts', 'f/x', '', 'x'.repeat(65)]) {
    await assert.rejects(c.deleteContent({ token: TOKEN, folderId }), { code: 'BAD_ANSWER' }, folderId);
  }
  assert.strictEqual(fake.calls.length, 0);
});

test('feature off: the delete still goes through the host list on every hop', async () => {
  const prev = config.net.offline;
  config.net.offline = false;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(`${opts && opts.method} ${String(url)}`);
    return new Response(null, { status: 307, headers: { Location: 'https://evil.example/contents' } });
  };
  try {
    const real = new GofileClient({ isEnabled: () => false });
    await assert.rejects(real.deleteContent({ token: TOKEN, folderId: 'folder-1' }), { code: 'SHARE_HOST' });
  } finally {
    config.net.offline = prev;
    globalThis.fetch = async (url) => { globalCalls.push(String(url)); throw new Error('real fetch must not be reached in this test'); };
  }
  assert.deepStrictEqual(seen, ['DELETE https://api.gofile.io/contents']);
});

test('VAULT_OFFLINE: zero requests through the real netFetch too', async () => {
  const fake = fakeGofile({});
  await assert.rejects(client(fake, { offline: true }).createAccount(),
    { code: 'NET_OFF', message: 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be uploaded.' });
  // The message names what was blocked.
  await assert.rejects(client(fake, { offline: true }).setExpiry({ token: TOKEN, folderId: 'folder-1', expiresAtSec: 2000000000 }),
    { code: 'NET_OFF', message: 'Vault is set to stay offline (VAULT_OFFLINE=1), so the timer cannot be set on gofile.' });
  assert.strictEqual(fake.calls.length, 0);

  // Default client: real netFetch, real config switch, global fetch counted.
  const prev = config.net.offline;
  config.net.offline = true;
  globalCalls = [];
  try {
    const real = new GofileClient({ isEnabled: () => true });
    await assert.rejects(real.createAccount(), { code: 'NET_OFF' });
    await assert.rejects(netFetch('https://api.gofile.io/accounts', { method: 'POST', purpose: 'share' }), { code: 'NET_OFF' });
  } finally {
    config.net.offline = prev;
  }
  assert.strictEqual(globalCalls.length, 0);
});

test('the share purpose reaches only the two gofile hosts, on every hop', async () => {
  assert.ok(isShareUrl('https://api.gofile.io/accounts'));
  assert.ok(isShareUrl('https://upload.gofile.io/uploadfile'));
  for (const bad of ['http://api.gofile.io/accounts', 'https://gofile.io/x', 'https://store1.gofile.io/uploadfile',
    'https://api.gofile.io:8443/x', 'https://user:pw@api.gofile.io/x', 'https://api.gofile.io.evil.com/x',
    'http://127.0.0.1:1234/x', 'https://localhost/x']) {
    assert.ok(!isShareUrl(bad), bad);
    globalCalls = [];
    await assert.rejects(netFetch(bad, { purpose: 'share' }), { code: 'SHARE_HOST' }, bad);
    assert.strictEqual(globalCalls.length, 0, bad);
  }
  // A redirect off the list is refused before the second request is made.
  const prev = config.net.offline;
  config.net.offline = false;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(null, { status: 307, headers: { Location: 'https://evil.example/steal' } });
  };
  try {
    await assert.rejects(netFetch('https://api.gofile.io/accounts', { method: 'POST', purpose: 'share' }), { code: 'SHARE_HOST' });
  } finally {
    config.net.offline = prev;
    globalThis.fetch = async (url) => { globalCalls.push(String(url)); throw new Error('real fetch must not be reached in this test'); };
  }
  assert.deepStrictEqual(seen, ['https://api.gofile.io/accounts']);
});

test('the client refuses a non-gofile URL before calling fetch', async () => {
  const fake = fakeGofile({});
  const c = client(fake);
  await assert.rejects(c._request('https://evil.example/x', { method: 'GET' }), { code: 'SHARE_HOST' });
  assert.strictEqual(fake.calls.length, 0);
});

test('part names that could break the multipart header are refused', () => {
  assert.throws(() => multipartBody({ filePath: PART, fileName: 'a"b.7z', size: 1 }), { code: 'BAD_NAME' });
  assert.throws(() => multipartBody({ filePath: PART, fileName: 'a\r\nX: y', size: 1 }), { code: 'BAD_NAME' });
});
