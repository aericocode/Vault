/**
 * Share privately: which 7-Zip program Vault runs (lib/share/sevenzip.js,
 * review finding 5).
 *
 *  - The built app uses only its own copy, ROOT/7-Zip/<file>, or an explicit
 *    VAULT_7ZIP. It never looks in vendor/, next to itself, in Program Files
 *    or on PATH, even when a program sits there.
 *  - The shipped copy is checked against its SHA-256 BEFORE it is first run:
 *    a changed copy is never started (counted at child_process), and is
 *    refused in the built app and in a source checkout alike.
 *  - The exact shipped copy is found and used.
 *  - SHIPPED's hashes are the ones in vendor/7zip/SHA256SUMS.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const runs = [];
for (const name of ['spawn', 'spawnSync']) {
  const orig = cp[name];
  cp[name] = function counted(...args) { runs.push(String(args[0])); return orig.apply(this, args); };
}

const sevenzip = require('../lib/share/sevenzip');
const vendor7z = require('../tools/sea/vendor-7zip');

const REPO = path.join(__dirname, '..');
const s = sevenzip.shippedFor();
const vendorCopy = s ? path.join(REPO, 'vendor', '7zip', s.vendorDir, s.file) : null;
const skip = s && fs.existsSync(vendorCopy) ? false : 'no shipped 7-Zip for this platform';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-7zip-locate-'));
const savedEnv = { VAULT_7ZIP: process.env.VAULT_7ZIP, PATH: process.env.PATH, Path: process.env.Path };

test.beforeEach(() => {
  delete process.env.VAULT_7ZIP;
  runs.length = 0;
});
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  sevenzip._setForTest({ packaged: null, root: null });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** A fresh app folder; `copy`: 'exact' | 'changed' | null for ROOT/7-Zip/<file>. */
function appFolder(name, copy) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, sevenzip.SHIPPED_APP_DIR), { recursive: true });
  if (copy) {
    const dst = path.join(root, sevenzip.SHIPPED_APP_DIR, s.file);
    fs.copyFileSync(vendorCopy, dst);
    if (copy === 'changed') fs.appendFileSync(dst, Buffer.from('changed'));
    if (process.platform !== 'win32') fs.chmodSync(dst, 0o755);
    return { root, dst };
  }
  return { root, dst: null };
}

test('SHIPPED carries the same SHA-256 as vendor/7zip/SHA256SUMS', () => {
  const sums = vendor7z.readSums();
  for (const entry of Object.values(sevenzip.SHIPPED)) {
    assert.strictEqual(entry.sha256, sums[`${entry.vendorDir}/${entry.file}`], entry.file);
  }
});

test('built app: the exact shipped copy is found and used', { skip }, () => {
  const { root, dst } = appFolder('exact', 'exact');
  sevenzip._setForTest({ packaged: true, root });
  assert.strictEqual(sevenzip.locate(), dst);
  assert.deepStrictEqual(runs, [dst], 'only the shipped copy ran (its version check)');
});

test('built app: a changed shipped copy is never run, and nothing else is looked for', { skip }, () => {
  const { root, dst } = appFolder('changed', 'changed');
  // A usable program next to Vault and on PATH: the built app must ignore both.
  const planted = path.join(root, s.file === '7za.exe' ? '7za.exe' : '7zz');
  fs.copyFileSync(vendorCopy, planted);
  if (process.platform !== 'win32') fs.chmodSync(planted, 0o755);
  const pathDir = path.join(tmp, 'on-path');
  fs.mkdirSync(pathDir, { recursive: true });
  const onPath = path.join(pathDir, s.file === '7za.exe' ? '7z.exe' : '7zz');
  fs.copyFileSync(vendorCopy, onPath);
  if (process.platform !== 'win32') fs.chmodSync(onPath, 0o755);
  process.env.PATH = pathDir;
  process.env.Path = pathDir;
  sevenzip._setForTest({ packaged: true, root });
  assert.strictEqual(sevenzip.locate(), null);
  assert.deepStrictEqual(runs, [], 'a program was started');
  assert.ok(fs.existsSync(dst));
});

test('built app: no shipped copy means no 7-Zip, whatever is on PATH', { skip }, () => {
  const { root } = appFolder('none', null);
  const pathDir = path.join(tmp, 'on-path');
  process.env.PATH = pathDir;
  process.env.Path = pathDir;
  sevenzip._setForTest({ packaged: true, root });
  assert.strictEqual(sevenzip.locate(), null);
  assert.deepStrictEqual(runs, []);
});

test('built app: an explicit VAULT_7ZIP is still honoured', { skip }, () => {
  const { root } = appFolder('env', null);
  sevenzip._setForTest({ packaged: true, root });
  process.env.VAULT_7ZIP = vendorCopy;
  assert.strictEqual(sevenzip.locate(), vendorCopy);
});

test('built app: a byte changed AFTER the copy was accepted, size and time put back, is refused and never run', { skip }, async () => {
  const { root, dst } = appFolder('flip', 'exact');
  // A whole-second time, so putting it back gives the very same stat values.
  const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600 * 1000);
  fs.utimesSync(dst, t, t);
  sevenzip._setForTest({ packaged: true, root });
  assert.strictEqual(sevenzip.locate(), dst, 'the good copy is accepted first');
  assert.deepStrictEqual(runs, [dst], 'its version check ran');
  const before = fs.statSync(dst);

  // The verifier's counterexample: flip one byte, put the time back.
  const fd = fs.openSync(dst, 'r+');
  const at = before.size - 4096;
  const b = Buffer.alloc(1);
  fs.readSync(fd, b, 0, 1, at);
  b[0] ^= 0xff;
  fs.writeSync(fd, b, 0, 1, at);
  fs.closeSync(fd);
  fs.utimesSync(dst, t, t);
  const after = fs.statSync(dst);
  assert.strictEqual(after.size, before.size);
  assert.strictEqual(after.mtimeMs, before.mtimeMs, 'size and time look unchanged');

  runs.length = 0;
  assert.strictEqual(sevenzip.locate(), null, 'refused when looked for again');
  // Run it the way packing does (found by locate) and by an explicit path.
  await assert.rejects(sevenzip.runSevenZip(['i'], { password: null }), { code: 'SEVENZIP_MISSING' });
  await assert.rejects(sevenzip.runSevenZip(['i'], { password: null, program: dst }), { code: 'SEVENZIP_CHANGED' });
  assert.strictEqual(sevenzip.checkVersion(dst).ok, false);
  assert.deepStrictEqual(runs, [], 'the changed copy was never started');

  // Put the byte back: accepted again (nothing about the bad copy was cached).
  const fd2 = fs.openSync(dst, 'r+');
  b[0] ^= 0xff;
  fs.writeSync(fd2, b, 0, 1, at);
  fs.closeSync(fd2);
  assert.strictEqual(sevenzip.locate(), dst);
});

test('built app: the changed byte is caught right before a run, even with locate() not asked again', { skip }, async () => {
  const { root, dst } = appFolder('flip-run', 'exact');
  sevenzip._setForTest({ packaged: true, root });
  assert.strictEqual(sevenzip.locate(), dst);
  const st = fs.statSync(dst);
  const fd = fs.openSync(dst, 'r+');
  fs.writeSync(fd, Buffer.from([0x5a]), 0, 1, st.size - 100);
  fs.closeSync(fd);
  fs.utimesSync(dst, st.atime, st.mtime);
  runs.length = 0;
  await assert.rejects(sevenzip.runSevenZip(['i'], { password: null, program: dst }), { code: 'SEVENZIP_CHANGED' });
  assert.deepStrictEqual(runs, []);
});

test('built app: a program that is neither the shipped copy nor VAULT_7ZIP is not started', { skip }, async () => {
  const { root } = appFolder('other-prog', 'exact');
  sevenzip._setForTest({ packaged: true, root });
  runs.length = 0;
  await assert.rejects(sevenzip.runSevenZip(['i'], { password: null, program: vendorCopy }), { code: 'SEVENZIP_MISSING' });
  assert.deepStrictEqual(runs, []);
});

test('source checkout: a changed copy in 7-Zip/ is passed over without being run', { skip }, () => {
  const { root, dst } = appFolder('src-changed', 'changed');
  process.env.PATH = '';
  process.env.Path = '';
  sevenzip._setForTest({ packaged: false, root });
  const found = sevenzip.locate();
  assert.ok(!runs.includes(dst), 'the changed copy was started');
  assert.notStrictEqual(found, dst);
});
