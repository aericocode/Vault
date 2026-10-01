/**
 * A write that dies mid-transaction leaves a hot rollback journal. The next
 * read-write connection that reads the file plays it back, and for an
 * encrypted library only a connection holding the key the journal was written
 * with can do that correctly: a keyless one truncates the file and deletes the
 * journal (permanent corruption), a wrong-key one truncates before the cipher
 * stops it. lib/db-open-guard.js makes every open path confirm the key first.
 *
 * Each case starts from a byte copy of a real hot journal: a child process
 * opens the database with the key, starts a write big enough to spill pages
 * into the file, and is killed. Every path that runs without the confirmed key
 * must leave the database AND the journal byte-identical; the correct key must
 * then roll back to exactly the pre-transaction contents with quick_check ok.
 * App code runs in child processes so each case gets fresh module state.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
let Cipher = null;
try { Cipher = require('better-sqlite3-multiple-ciphers'); } catch { /* skipped below */ }
const SKIP = Cipher ? false : 'better-sqlite3-multiple-ciphers is not installed';

// A quote in the passphrase exercises the PRAGMA key escaping on every path.
const KEY = "jt-pass'quote";
const WRONG = 'not-the-password';
const JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
const sqlKey = (k) => `key='${k.replace(/'/g, "''")}'`;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-journal-test-'));
test.after(() => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} });

function childEnv(extra = {}) {
  const env = { ...process.env, VAULT_SETTINGS_FILE: path.join(WORK, 'settings.json'), VAULT_OFFLINE: '1', ...extra };
  for (const k of ['VAULT_DB_PASSWORD', 'VIDEO_TAGGER_DB_PASSWORD', 'MEDIA_TAGGER_DB_PASSWORD']) delete env[k];
  return env;
}

/** Run app code in a fresh node process; it reports through one "@@" JSON line. */
function inChild(body, env) {
  const code = `const out = {}; try { ${body} } catch (e) { out.code = e.code; out.message = e.message; }
    console.log('@@' + JSON.stringify(out));`;
  const r = cp.spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: childEnv(env), encoding: 'utf8', timeout: 120000 });
  const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('@@'));
  assert.ok(line, `child produced no result (exit ${r.status}): ${r.stderr}`);
  return JSON.parse(line.slice(2));
}

const md5 = (p) => (fs.existsSync(p) ? crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex') : 'absent');
const bytes = (db) => `${md5(db)} / ${md5(db + '-journal')}`;

function snapshot(db, key) {
  const c = new Cipher(db, { readonly: true });
  try {
    if (key) c.pragma(sqlKey(key));
    return c.prepare(`SELECT
        (SELECT count(*) FROM sqlite_master) AS objects,
        (SELECT group_concat(name) FROM (SELECT name FROM sqlite_master ORDER BY name)) AS names,
        (SELECT count(*) FROM ${db.endsWith('secure_assets.db') ? 'assets' : 'media'}) AS n_rows,
        (SELECT total(length(${db.endsWith('secure_assets.db') ? 'data' : 'user_notes'})) FROM ${db.endsWith('secure_assets.db') ? 'assets' : 'media'}) AS payload`).get();
  } finally { c.close(); }
}

/** Kill a child mid-write: returns once the database has a hot journal. */
async function makeHot(db, key, writeSql) {
  const body = `
    const D = require('better-sqlite3-multiple-ciphers');
    const db = new D(${JSON.stringify(db)});
    ${key ? `db.pragma(${JSON.stringify(sqlKey(key))});` : ''}
    db.pragma('cache_size=20');                 // force pages to spill into the file
    db.exec('BEGIN');
    ${writeSql}
    db.exec('CREATE TABLE hot_tx(id INTEGER PRIMARY KEY, b BLOB)');
    const ins = db.prepare('INSERT INTO hot_tx(b) VALUES (randomblob(3000))');
    for (let i = 0; i < 800; i++) ins.run();
    process.send('spilled');
    setInterval(() => {}, 1000);`;
  const sizeBefore = fs.statSync(db).size;
  const child = cp.spawn(process.execPath, ['-e', body], { cwd: ROOT, env: childEnv(), stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', c => reject(new Error('writer exited early ' + c))); });
  const exited = new Promise(r => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
  const j = db + '-journal';
  assert.ok(fs.existsSync(j) && fs.statSync(j).size > 0, 'a journal was left behind');
  assert.ok(fs.readFileSync(j).subarray(0, 8).equals(JOURNAL_MAGIC), 'the journal is hot (synced header)');
  assert.ok(fs.statSync(db).size > sizeBefore, 'the dead transaction had already written pages into the file');
}

/** Build a library (real schema, via the app's own init) and leave a hot journal on it. */
async function hotLibrary(name, key) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir);
  const db = path.join(dir, 'lib.db');
  const r = inChild(`require('./lib/database').init(${JSON.stringify(db)}, ${key ? JSON.stringify(key) : 'null'}); out.ok = true;`);
  assert.ok(r.ok, JSON.stringify(r));
  const c = new Cipher(db);
  if (key) c.pragma(sqlKey(key));
  const ins = c.prepare('INSERT INTO media(filepath, filename, media_type, user_notes) VALUES (?, ?, ?, ?)');
  c.transaction(() => { for (let i = 0; i < 4000; i++) ins.run(`/m/${i}.mp4`, `${i}.mp4`, 'video', `note ${i}`); })();
  c.close();
  const pre = snapshot(db, key);
  await makeHot(db, key, `db.exec("UPDATE media SET user_notes = hex(randomblob(150)) WHERE id % 2 = 0");`);
  return { db, pre };
}

/** Same for the derived-artifact store (its own file and its own journal). */
async function hotStore(name, key) {
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir);
  const db = path.join(dir, 'secure_assets.db');
  const r = inChild(`const sa = require('./lib/secure-assets'); sa.init(${JSON.stringify(key)});
    for (let i = 1; i <= 1500; i++) sa.put(i, 'thumb', Buffer.alloc(600, i % 251));
    sa.close(); out.ok = true;`, { VAULT_SECURE_ASSETS: db, VAULT_DB: path.join(dir, 'lib.db') });
  assert.ok(r.ok, JSON.stringify(r));
  const pre = snapshot(db, key);
  await makeHot(db, key, `db.exec("UPDATE assets SET data = randomblob(900) WHERE media_id % 2 = 0");`);
  return { db, pre };
}

let caseNo = 0;
/** Byte copy of a hot master into its own directory. */
function fresh(master) {
  const dir = path.join(WORK, `case-${++caseNo}`);
  fs.mkdirSync(dir);
  const db = path.join(dir, path.basename(master.db));
  fs.copyFileSync(master.db, db);
  fs.copyFileSync(master.db + '-journal', db + '-journal');
  return db;
}

/** The right key (or none, for plaintext) rolls the journal back to the pre-transaction state. */
function assertRecovers(db, key, pre) {
  const c = new Cipher(db);
  try {
    if (key) c.pragma(sqlKey(key));
    assert.strictEqual(c.pragma('quick_check', { simple: true }), 'ok');
  } finally { c.close(); }
  assert.ok(!fs.existsSync(db + '-journal'), 'journal consumed by the rollback');
  assert.deepStrictEqual(snapshot(db, key), pre, 'contents equal the pre-transaction state');
}

function probeDirs() {
  return fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('vault-keyprobe-')).length;
}

test('hot journal on an encrypted library', { skip: SKIP, timeout: 300000 }, async (t) => {
  const master = await hotLibrary('enc', KEY);
  const libEnv = (db) => ({ VAULT_DB: db, VAULT_SECURE_ASSETS: path.join(path.dirname(db), 'secure_assets.db') });

  // Every path below runs without the confirmed key and must not change a byte.
  const untouched = [
    ['locked boot: database.init with no password', `require('./lib/database').init(process.env.VAULT_DB, null)`,
      { code: 'DB_ENCRYPTED', message: 'database is encrypted: password required' }],
    ['database.get() while locked (route mounts, background jobs)', `require('./lib/database').get()`,
      { code: 'DB_ENCRYPTED', message: 'database is encrypted: password required' }],
    ['VAULT_DB_PASSWORD set but wrong', `require('./lib/database').init(process.env.VAULT_DB, ${JSON.stringify(WRONG)})`,
      { code: 'DB_ENCRYPTED', message: 'database is encrypted and the password is wrong' }],
    ['lock screen: wrong password', `const v = require('./lib/vault'); v.bootLocked(); v.unlock(${JSON.stringify(WRONG)})`,
      { code: 'VAULT_WRONG_PASS', message: 'wrong password' }],
    ['change password: wrong current password', `out.result = require('./lib/database').verifyPassword(${JSON.stringify(WRONG)}, process.env.VAULT_DB)`,
      { result: false }],
    ['change password: RIGHT current password is checked read-only too', `out.result = require('./lib/database').verifyPassword(${JSON.stringify(KEY)}, process.env.VAULT_DB)`,
      { result: true }],
  ];
  for (const [name, body, expected] of untouched) {
    await t.test(name, () => {
      const db = fresh(master);
      const before = bytes(db);
      const out = inChild(body, libEnv(db));
      for (const [k, v] of Object.entries(expected)) assert.strictEqual(out[k], v, `${k}: ${JSON.stringify(out)}`);
      assert.strictEqual(bytes(db), before, 'database and journal bytes unchanged');
      assertRecovers(db, KEY, master.pre);
    });
  }

  await t.test('CLI without VAULT_DB_PASSWORD (node vault.js status)', () => {
    const db = fresh(master);
    const before = bytes(db);
    const r = cp.spawnSync(process.execPath, ['vault.js', 'status'], { cwd: ROOT, env: childEnv(libEnv(db)), encoding: 'utf8', timeout: 120000 });
    assert.notStrictEqual(r.status, 0, 'the CLI refuses an encrypted library without the password');
    assert.match(r.stdout + r.stderr, /password required/);
    assert.strictEqual(bytes(db), before, 'database and journal bytes unchanged');
    assertRecovers(db, KEY, master.pre);
  });

  await t.test('correct key: unlock rolls the journal back to the pre-transaction state', () => {
    const db = fresh(master);
    const tmpBefore = probeDirs();
    const out = inChild(`const v = require('./lib/vault'); v.bootLocked();
      try { v.unlock(${JSON.stringify(WRONG)}); } catch (e) { out.first = e.code; }
      out.status = v.unlock(${JSON.stringify(KEY)});
      require('./lib/database').close(); require('./lib/secure-assets').close();`, libEnv(db));
    assert.strictEqual(out.first, 'VAULT_WRONG_PASS');
    assert.strictEqual(out.status && out.status.locked, false, JSON.stringify(out));
    assertRecovers(db, KEY, master.pre);
    assert.strictEqual(probeDirs(), tmpBefore, 'the key probe cleans up its temp copy');
  });
});

test('hot journal on the encrypted secure-assets store', { skip: SKIP, timeout: 300000 }, async (t) => {
  const master = await hotStore('store', KEY);
  const env = (db) => ({ VAULT_SECURE_ASSETS: db, VAULT_DB: path.join(path.dirname(db), 'lib.db') });

  await t.test('wrong password: store refused, bytes unchanged', () => {
    const db = fresh(master);
    const before = bytes(db);
    const out = inChild(`require('./lib/secure-assets').init(${JSON.stringify(WRONG)})`, env(db));
    assert.strictEqual(out.code, 'DB_ENCRYPTED');
    assert.strictEqual(out.message, 'secure_assets.db is encrypted and the password is wrong');
    assert.strictEqual(bytes(db), before);
    assertRecovers(db, KEY, master.pre);
  });

  await t.test('setPassword path with no session key (rekey under the current key)', () => {
    const db = fresh(master);
    const before = bytes(db);
    const out = inChild(`require('./lib/secure-assets').rekey('another-pass')`, env(db));
    assert.strictEqual(out.code, 'DB_ENCRYPTED');
    assert.strictEqual(bytes(db), before);
    assertRecovers(db, KEY, master.pre);
  });

  await t.test('correct key rolls the store back', () => {
    const db = fresh(master);
    const out = inChild(`require('./lib/secure-assets').init(${JSON.stringify(KEY)}); require('./lib/secure-assets').close(); out.ok = true;`, env(db));
    assert.ok(out.ok, JSON.stringify(out));
    assertRecovers(db, KEY, master.pre);
  });
});

test('control: hot journal on an unencrypted library', { skip: SKIP, timeout: 300000 }, async (t) => {
  const master = await hotLibrary('plain', null);
  const env = (db) => ({ VAULT_DB: db });

  await t.test('keyless open rolls back exactly as before', () => {
    const db = fresh(master);
    const out = inChild(`require('./lib/database').init(process.env.VAULT_DB, null); require('./lib/database').close(); out.ok = true;`, env(db));
    assert.ok(out.ok, JSON.stringify(out));
    assertRecovers(db, null, master.pre);
  });

  await t.test('a password on a plaintext library is refused without touching it', () => {
    const db = fresh(master);
    const before = bytes(db);
    const out = inChild(`require('./lib/database').init(process.env.VAULT_DB, ${JSON.stringify(WRONG)})`, env(db));
    assert.strictEqual(out.code, 'DB_ENCRYPTED');
    assert.strictEqual(bytes(db), before);
    assertRecovers(db, null, master.pre);
  });

  await t.test('crash while first encrypting: plaintext journal, encrypted-looking header', () => {
    // The dead transaction may already have rewritten page 1 with the new key.
    // Its journal holds the PLAINTEXT original, so the only correct rollback is
    // keyless: the guard reads that from the journal, not the header.
    const db = fresh(master);
    const fd = fs.openSync(db, 'r+');
    fs.writeSync(fd, crypto.randomBytes(16), 0, 16, 0);
    fs.closeSync(fd);
    const out = inChild(`require('./lib/database').init(process.env.VAULT_DB, null); require('./lib/database').close(); out.ok = true;`, env(db));
    assert.ok(out.ok, JSON.stringify(out));
    assertRecovers(db, null, master.pre);
  });
});

test('no hot journal: open paths behave as before', { skip: SKIP, timeout: 120000 }, () => {
  const dir = path.join(WORK, 'clean');
  fs.mkdirSync(dir);
  const db = path.join(dir, 'lib.db');
  const env = { VAULT_DB: db };
  assert.ok(inChild(`require('./lib/database').init(process.env.VAULT_DB, ${JSON.stringify(KEY)}); out.ok = true;`, env).ok);
  assert.strictEqual(inChild(`require('./lib/database').init(process.env.VAULT_DB, null)`, env).message, 'database is encrypted: password required');
  assert.strictEqual(inChild(`require('./lib/database').init(process.env.VAULT_DB, 'nope')`, env).message, 'database is encrypted and the password is wrong');
  assert.ok(inChild(`require('./lib/database').init(process.env.VAULT_DB, ${JSON.stringify(KEY)}); out.ok = true;`, env).ok);
  assert.strictEqual(inChild(`out.r = require('./lib/database').verifyPassword(${JSON.stringify(KEY)}, process.env.VAULT_DB)`, env).r, true);
  assert.strictEqual(inChild(`out.r = require('./lib/database').verifyPassword('nope', process.env.VAULT_DB)`, env).r, false);
  assert.ok(!fs.existsSync(db + '-journal'));
});
