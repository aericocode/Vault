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

test('source checkout: a changed copy in 7-Zip/ is passed over without being run', { skip }, () => {
  const { root, dst } = appFolder('src-changed', 'changed');
  process.env.PATH = '';
  process.env.Path = '';
  sevenzip._setForTest({ packaged: false, root });
  const found = sevenzip.locate();
  assert.ok(!runs.includes(dst), 'the changed copy was started');
  assert.notStrictEqual(found, dst);
});
