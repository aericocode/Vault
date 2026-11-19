/**
 * Share privately: a cleared or replaced password, link or gofile token does
 * not stay readable in an unencrypted library file (lib/share/store.js,
 * secure delete). The library file and anything beside it are searched byte
 * by byte after the writes, as an attacker with a copy of the file would.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-store-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const store = require('../lib/share/store');

test.after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** Which of `marks` are anywhere in the files of the library's folder. */
function found(marks) {
  const hits = new Set();
  for (const f of fs.readdirSync(tmp)) {
    const p = path.join(tmp, f);
    if (!fs.statSync(p).isFile()) continue;
    const b = fs.readFileSync(p);
    for (const m of marks) if (b.indexOf(m) >= 0) hits.add(`${m} in ${f}`);
  }
  return [...hits];
}

test('cleared, replaced and deleted secrets leave no bytes in the library file', () => {
  db.init();
  const d = db.get();
  assert.strictEqual(Number(d.pragma('secure_delete', { simple: true })), 0, 'the library starts without secure delete');

  // Saved password: set, replaced, cleared.
  store.kvSet('saved_password', 'MARKsavedOLD-aaaa-bbbb');
  store.kvSet('saved_password', 'MARKsavedNEW-cccc-dddd');
  store.kvSet('saved_password', null);
  // Share passwords forgotten ("Passwords of past shares" off).
  store.insertShare({ archive_name: 'a1', password: 'MARKshareA-1111', status: 'uploaded', created_at: 1, link: 'https://gofile.io/d/MARKlinkA' });
  store.clearSharePasswords();
  // A share removed from the list, with its link and password.
  const gone = store.insertShare({ archive_name: 'a2', password: 'MARKshareB-2222', status: 'deleted', created_at: 2, link: 'https://gofile.io/d/MARKlinkB' });
  store.deleteShare(gone);
  // A gofile token no share needs any more.
  store.insertAccount('MARKtoken-0123456789', 'session');
  store.pruneAccounts(null);

  // The connection's own setting is back as it was.
  assert.strictEqual(Number(d.pragma('secure_delete', { simple: true })), 0);
  db.close();

  assert.deepStrictEqual(found(['MARKsavedOLD', 'MARKsavedNEW', 'MARKshareA', 'MARKshareB', 'MARKlinkB', 'MARKtoken']), []);
});

test('the byte search itself finds a value that is still stored', () => {
  db.init();
  store.kvSet('saved_password', 'MARKkept-eeee-ffff');
  db.close();
  assert.strictEqual(found(['MARKkept']).length, 1);
});
