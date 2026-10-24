/**
 * VAULT_DISABLE_NATIVE_PICKER=1 (server/index.js spawnPicker): the native
 * file and folder pickers answer 409 with a plain message instead of opening
 * a dialog on the desktop. Test and scratch servers set it. The variable is
 * set before the app loads, so this file can never open a real picker.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-picker-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const { app } = require('../server/index');

let server;
let base;

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// Checked before any request: without the switch in the server, a request
// below would open a real dialog on the desktop, so the HTTP tests refuse to
// run at all.
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
const guarded = /function spawnPicker[^{]*\{\s*(?:\/\/[^\n]*\n\s*)*if \(process\.env\.VAULT_DISABLE_NATIVE_PICKER === '1'\)/.test(src);

test('spawnPicker checks VAULT_DISABLE_NATIVE_PICKER before anything else', () => {
  assert.ok(guarded, 'the switch must be the first thing spawnPicker does');
});

for (const route of ['/api/import/pick-files', '/api/import/pick-folder']) {
  test(`${route} answers 409 while pickers are off`, { skip: !guarded && 'switch missing: not risking a real picker' }, async () => {
    assert.strictEqual(process.env.VAULT_DISABLE_NATIVE_PICKER, '1', 'never run this without the switch');
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 409);
    const j = await res.json();
    assert.strictEqual(j.error, 'This copy of Vault cannot open the Windows file picker.');
  });
}
