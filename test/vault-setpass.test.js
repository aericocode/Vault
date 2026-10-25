/**
 * First password vs change password, and the AI's bad-JSON log in vault mode.
 *
 * /api/vault/setpass used to re-key an already encrypted library with no
 * proof of the current password, side-stepping changepass's check and its
 * three-strike lockout. It now only creates the FIRST password (409
 * VAULT_ALREADY_SET after that); changepass still re-keys, through the
 * internal _rekey.
 *
 * lib/llm-client.js logBadJson redacted only when the env var password was
 * set, so a password set on the lock screen still left raw AI descriptions
 * and file names in plain text. It now writes a content-free line whenever the
 * library has a password, and setting the first password deletes the old log.
 *
 * Real encryption on a throwaway library in a temp folder.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-setpass-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_DEBUG_LOG = path.join(tmp, 'bad_json_responses.log');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const llm = require('../lib/llm-client');
const { app } = require('../server/index');

const LOG = process.env.VAULT_DEBUG_LOG;
const SECRET_NAME = 'Secret Holiday Beach.jpg';
const SECRET_TEXT = 'A woman on a beach holding a sign that reads PRIVATE';

let server;
let port;
let cipher = true;

test.before(async () => {
  db.init();
  cipher = typeof db.get().pragma === 'function' && db.get().pragma('cipher', { simple: true }) != null;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
});
test.after(async () => {
  vault._locked = false;
  await new Promise((resolve) => server.close(resolve));
  try { require('../lib/secure-assets').close(); } catch {}
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const badJson = () => {
  assert.throws(() => llm.parseJsonResponse(`${SECRET_TEXT} {not json`, SECRET_NAME));
};

test('first password, then setpass refuses, changepass works, and the log stays content-free', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }

  // Before any password: the full entry, as before (useful for debugging).
  badJson();
  const plain = fs.readFileSync(LOG, 'utf8');
  assert.ok(plain.includes(SECRET_NAME) && plain.includes(SECRET_TEXT), 'plaintext library: full entry');

  // First password: encrypts, and the old plaintext log is deleted.
  let r = await post('/api/vault/setpass', { pass: 'first-pass' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.encrypted, true);
  assert.strictEqual(vault.isEncrypted(), true);
  assert.ok(!fs.existsSync(LOG), 'the plaintext log went with the first password');

  // Vault mode now, with no env var: a breadcrumb only.
  assert.strictEqual(process.env.VAULT_DB_PASSWORD, undefined);
  badJson();
  const crumb = fs.readFileSync(LOG, 'utf8');
  assert.ok(!crumb.includes(SECRET_NAME), 'no file name');
  assert.ok(!crumb.includes('Holiday') && !crumb.includes('beach') && !crumb.includes('PRIVATE'), 'no content');
  assert.ok(!/Unexpected token|is not valid JSON/.test(crumb), 'no parser message (V8 quotes the input in it)');
  assert.match(crumb, /could not be read/);
  assert.ok(!crumb.includes('—'), 'no em dashes');
  llm.logBadJson(SECRET_NAME, SECRET_TEXT, new Error('x'), { mediaId: 42 });
  assert.match(fs.readFileSync(LOG, 'utf8'), /media id 42/);

  // setpass again: refused, and the password is unchanged.
  r = await post('/api/vault/setpass', { pass: 'attacker-pass' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.code, 'VAULT_ALREADY_SET');
  assert.match(r.json.error, /Change password/);
  assert.strictEqual(db.verifyPassword('first-pass'), true, 'old password still opens it');
  assert.strictEqual(db.verifyPassword('attacker-pass'), false);
  await assert.rejects(vault.setPassword('attacker-pass'), { code: 'VAULT_ALREADY_SET' });

  // changepass: a wrong current is a strike, the right one re-keys.
  r = await post('/api/vault/changepass', { current: 'nope', next: 'second-pass' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.code, 'VAULT_WRONG_CURRENT');
  r = await post('/api/vault/changepass', { current: 'first-pass', next: 'second-pass' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.locked, false);
  assert.strictEqual(db.verifyPassword('second-pass'), true);
  assert.strictEqual(db.verifyPassword('first-pass'), false);
  assert.ok(fs.existsSync(LOG), 'a change keeps the (content-free) log');
});
