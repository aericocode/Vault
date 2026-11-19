/**
 * Share privately with the feature off: nothing is started and nothing is
 * created (review findings 3 and 4).
 *
 *  - GET /state (which the page asks for at load and every 30 seconds) does
 *    not look for 7-Zip: no program is run, sevenZipFound is null.
 *  - /preview answers FEATURE_OFF and does not create share_temp.
 *  - Measuring free space never creates share_temp.
 *  - Turning the feature on does look (and the counter below sees the
 *    version check run), so the page can still say 7-Zip is missing.
 *
 * Every child process start is counted by wrapping child_process before the
 * share code loads it.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const spawned = [];
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const orig = cp[name];
  cp[name] = function counted(...args) { spawned.push([name, String(args[0])]); return orig.apply(this, args); };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-off-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_SHARE_TEMP = path.join(tmp, 'share_temp');
delete process.env.VAULT_DB_PASSWORD;
const ROOT = path.join(__dirname, '..');
const shipped = process.platform === 'win32'
  ? path.join(ROOT, 'vendor', '7zip', 'win-x64', '7za.exe')
  : path.join(ROOT, 'vendor', '7zip', 'linux-x64', '7zzs');
const have7z = fs.existsSync(shipped) && ((process.platform === 'win32' && process.arch === 'x64') || (process.platform === 'linux' && process.arch === 'x64'));
// A real program, so a version check would really run it and be counted.
process.env.VAULT_7ZIP = have7z ? shipped : path.join(tmp, 'no-such-7z');

const db = require('../lib/database');
const sevenzip = require('../lib/share/sevenzip');
const settings = require('../lib/share/settings');
const temp = require('../lib/share/temp');
const service = require('../lib/share/service');

let locateCalls = 0;
const realLocate = sevenzip.locate;
sevenzip.locate = (...a) => { locateCalls++; return realLocate(...a); };

const MEDIA = path.join(tmp, 'clip.mp4');

test.before(() => {
  db.init();
  fs.writeFileSync(MEDIA, Buffer.alloc(100, 1));
  db.get().prepare("INSERT INTO media (id, filepath, filename, media_type) VALUES (1, ?, 'clip.mp4', 'video')").run(MEDIA);
});
test.after(async () => {
  await service._idle();
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('feature off: state runs no program, does not look for 7-Zip and creates nothing', () => {
  assert.strictEqual(settings.isEnabled(), false);
  spawned.length = 0;
  locateCalls = 0;
  for (let i = 0; i < 3; i++) {
    const st = service.state();
    assert.strictEqual(st.enabled, false);
    assert.strictEqual(st.sevenZipFound, null);
  }
  assert.deepStrictEqual(spawned, []);
  assert.strictEqual(locateCalls, 0);
  assert.strictEqual(fs.existsSync(temp.root()), false, 'share_temp was created');
});

test('feature off: preview answers FEATURE_OFF and creates nothing', () => {
  spawned.length = 0;
  assert.throws(() => service.preview({ mediaIds: [1] }), { code: 'FEATURE_OFF' });
  assert.deepStrictEqual(spawned, []);
  assert.strictEqual(fs.existsSync(temp.root()), false);
});

test('measuring free space does not create share_temp', () => {
  const free = temp.freeBytes();
  assert.ok(free === null || free > 0);
  assert.strictEqual(fs.existsSync(temp.root()), false);
});

test('feature on: state looks for 7-Zip (the version check runs once) and preview works without creating share_temp', { skip: have7z ? false : 'no shipped 7-Zip for this platform' }, async () => {
  spawned.length = 0;
  sevenzip.invalidate();
  await service.updateSettings({ enabled: true });
  const st = service.state();
  assert.strictEqual(st.sevenZipFound, true);
  assert.ok(locateCalls >= 1);
  assert.ok(spawned.some(([, exe]) => exe === shipped), 'the version check ran the program');
  const n = spawned.length;
  service.state();
  assert.strictEqual(spawned.length, n, 'cached: not run again');
  const p = service.preview({ mediaIds: [1] });
  assert.strictEqual(p.files.length, 1);
  assert.strictEqual(fs.existsSync(temp.root()), false, 'preview created share_temp');
  await service.updateSettings({ enabled: false });
});
