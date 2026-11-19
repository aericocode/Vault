/**
 * Share privately: the 7-Zip programs shipped with Vault (vendor/7zip/).
 *
 * Covered: every shipped program matches vendor/7zip/SHA256SUMS; the README
 * states the version, the source archives with their SHA-256 and the
 * programs' SHA-256 (the same values as SHA256SUMS); each folder has its
 * License.txt and the third-party notices name 7-Zip; the Linux program has
 * the run permission in git (and on disk on Linux); a source checkout finds
 * the shipped copy first; the shipped copy for this platform starts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const vendor7z = require('../tools/sea/vendor-7zip');
const sevenzip = require('../lib/share/sevenzip');

const DIR = path.join(ROOT, 'vendor', '7zip');
const ARCHIVE_SUMS = {
  '7z2606-extra.7z': '396c180f12d2247c24b0b1fcd482c6fc2a2700f61211ffede1061dd971f5e104',
  '7z2606-linux-x64.tar.xz': '2b539cf067b2ad48e1baa5093dbaa8818b73542d1222a0ffde9dc5f2922ea62e',
};

test('every shipped program is listed in SHA256SUMS and matches it', () => {
  const sums = vendor7z.readSums();
  const shipped = Object.values(sevenzip.SHIPPED).map(s => `${s.vendorDir}/${s.file}`);
  assert.deepStrictEqual(Object.keys(sums).sort(), [...shipped].sort());
  for (const r of vendor7z.verify()) {
    assert.ok(r.ok, `${r.rel}: expected ${r.expected}, got ${r.actual}`);
  }
});

test('a changed program is caught', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vault-test-vendor-'));
  try {
    fs.mkdirSync(path.join(tmp, 'linux-x64'));
    fs.writeFileSync(path.join(tmp, 'SHA256SUMS'), `${'0'.repeat(64)}  linux-x64/7zzs\n`);
    fs.writeFileSync(path.join(tmp, 'linux-x64', '7zzs'), 'not it');
    const [r] = vendor7z.verify(null, tmp);
    assert.strictEqual(r.ok, false);
    fs.writeFileSync(path.join(tmp, 'SHA256SUMS'), `${'0'.repeat(64)}  ../outside\n`);
    assert.throws(() => vendor7z.readSums(tmp), /bad/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('README states the version, the source archives and every SHA-256', () => {
  const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
  assert.match(readme, /26\.06/);
  for (const [name, sum] of Object.entries(ARCHIVE_SUMS)) {
    assert.ok(readme.includes(`https://github.com/ip7z/7zip/releases/download/26.06/${name}`), name);
    assert.ok(readme.includes(sum), `${name} sha256`);
  }
  assert.ok(readme.includes('https://www.7-zip.org/download.html'));
  for (const [rel, sum] of Object.entries(vendor7z.readSums())) {
    assert.ok(readme.includes(sum), `${rel} sha256 in README`);
  }
});

test('licenses ship with the programs and the notices name 7-Zip', () => {
  for (const s of Object.values(sevenzip.SHIPPED)) {
    const lic = fs.readFileSync(path.join(DIR, s.vendorDir, 'License.txt'), 'utf8');
    assert.match(lic, /GNU LGPL/);
    assert.match(lic, /Igor Pavlov/);
  }
  const notices = fs.readFileSync(path.join(ROOT, 'player-lib', 'THIRD-PARTY.txt'), 'utf8');
  assert.match(notices, /7-Zip 26\.06/);
  assert.match(notices, /GNU Lesser General Public/);
  assert.match(notices, /unRAR license restriction/);
  assert.match(notices, /BSD 3-clause/);
  assert.match(notices, /BSD 2-clause/);
});

test('the Linux program keeps its run permission in git', (t) => {
  const r = spawnSync('git', ['ls-files', '-s', '--', 'vendor/7zip/linux-x64/7zzs'], { cwd: ROOT, windowsHide: true });
  const out = r.status === 0 ? String(r.stdout).trim() : '';
  if (!out) return t.skip('not a git checkout (or git missing)');
  assert.match(out, /^100755 /, out);
  if (process.platform !== 'win32') {
    fs.accessSync(path.join(DIR, 'linux-x64', '7zzs'), fs.constants.X_OK);
  }
});

test('a source checkout finds the shipped copy first, and it starts', (t) => {
  const s = sevenzip.shippedFor();
  if (!s) return t.skip(`no 7-Zip shipped for ${process.platform}-${process.arch}`);
  const prev = process.env.VAULT_7ZIP;
  delete process.env.VAULT_7ZIP;
  sevenzip.invalidate();
  try {
    const p = sevenzip.locate();
    assert.strictEqual(path.resolve(p), path.resolve(DIR, s.vendorDir, s.file));
    assert.ok(sevenzip.isShipped(p));
    const r = spawnSync(p, [], { windowsHide: true, timeout: 30000 });
    assert.strictEqual(r.status, 0);
    assert.match(String(r.stdout), /7-Zip \([az]\) 26\.06 \(x64\)/);
  } finally {
    if (prev !== undefined) process.env.VAULT_7ZIP = prev;
    sevenzip.invalidate();
  }
});
