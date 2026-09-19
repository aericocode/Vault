/**
 * Stored preferences: the string getter, and the boot-time port precedence.
 *
 * The port is resolved once, while config/index.js is being required, so it can
 * only honestly be tested from a fresh process. Each case below runs a one-line
 * child with its own prefs file and environment.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-settings-'));

process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'prefs.json');
const appSettings = require('../lib/app-settings');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test('getString trims, caps and falls back', () => {
  appSettings.set({ instanceName: '  Living room  ', notAString: 7 });
  assert.strictEqual(appSettings.getString('instanceName', '', { max: 40 }), 'Living room');
  assert.strictEqual(appSettings.getString('instanceName', '', { max: 6 }), 'Living');
  assert.strictEqual(appSettings.getString('missing', 'Vault'), 'Vault');
  assert.strictEqual(appSettings.getString('notAString', 'Vault'), 'Vault',
    'a wrong type in the file falls back rather than throwing');
});

test('getString on a corrupt file falls back', () => {
  const broken = path.join(tmp, 'broken.json');
  fs.writeFileSync(broken, '{ not json');
  const out = _resolve({ VAULT_SETTINGS_FILE: broken }, 'require("./lib/app-settings").getString("instanceName","Vault")');
  assert.strictEqual(out, 'Vault');
});

/** Run an expression in a child process with a given environment. */
function _resolve(env, expr) {
  return execFileSync(process.execPath, ['-p', expr], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, MEDIA_TAGGER_PORT: '', VAULT_SETTINGS_FILE: '', ...env },
  }).trim();
}

const PORT_EXPR = 'JSON.stringify(require("./config").server)';

test('port precedence: env beats stored beats default', () => {
  const prefs = path.join(tmp, 'port.json');

  fs.writeFileSync(prefs, JSON.stringify({}));
  let server = JSON.parse(_resolve({ VAULT_SETTINGS_FILE: prefs }, PORT_EXPR));
  assert.strictEqual(server.port, 8765);
  assert.strictEqual(server.portSource, 'default');

  fs.writeFileSync(prefs, JSON.stringify({ serverPort: 9123 }));
  server = JSON.parse(_resolve({ VAULT_SETTINGS_FILE: prefs }, PORT_EXPR));
  assert.strictEqual(server.port, 9123);
  assert.strictEqual(server.portSource, 'settings');

  server = JSON.parse(_resolve({ VAULT_SETTINGS_FILE: prefs, MEDIA_TAGGER_PORT: '8801' }, PORT_EXPR));
  assert.strictEqual(server.port, 8801);
  assert.strictEqual(server.portSource, 'env', 'the environment still wins');
});

test('an out-of-range stored port is ignored', () => {
  const prefs = path.join(tmp, 'badport.json');
  fs.writeFileSync(prefs, JSON.stringify({ serverPort: 80 }));
  const server = JSON.parse(_resolve({ VAULT_SETTINGS_FILE: prefs }, PORT_EXPR));
  assert.strictEqual(server.port, 8765);
  assert.strictEqual(server.portSource, 'default');
});

const EP_EXPR = 'JSON.stringify([require("./config").lmStudio.endpoints, require("./config").lmStudio.endpointSource])';

test('endpoint precedence: env beats stored beats default', () => {
  const prefs = path.join(tmp, 'eps.json');

  fs.writeFileSync(prefs, JSON.stringify({}));
  let [eps, source] = JSON.parse(_resolve({ VAULT_SETTINGS_FILE: prefs, LM_STUDIO_URLS: '' }, EP_EXPR));
  assert.deepStrictEqual(eps, ['http://localhost:1234/v1/chat/completions']);
  assert.strictEqual(source, 'default');

  fs.writeFileSync(prefs, JSON.stringify({ aiEndpoints: ['http://localhost:9/v1/chat/completions'] }));
  [eps, source] = JSON.parse(_resolve({ VAULT_SETTINGS_FILE: prefs, LM_STUDIO_URLS: '' }, EP_EXPR));
  assert.deepStrictEqual(eps, ['http://localhost:9/v1/chat/completions']);
  assert.strictEqual(source, 'settings');

  [eps, source] = JSON.parse(_resolve(
    { VAULT_SETTINGS_FILE: prefs, LM_STUDIO_URLS: 'http://a:1/v1/chat/completions,http://b:2/v1/chat/completions' },
    EP_EXPR));
  assert.deepStrictEqual(eps, ['http://a:1/v1/chat/completions', 'http://b:2/v1/chat/completions']);
  assert.strictEqual(source, 'env');
});
