/**
 * Moving a library from Windows to Linux or macOS (commands/migrate.js,
 * LINUX_SPEC WP6): the rows hold Windows paths (K:\Media\Shows\Ep 1.mp4) and
 * the files now sit under a POSIX folder (/mnt/media). A prefix move writes
 * the rest of each path with "/", and the Windows prefix matches in any case
 * and with either slash, as it did on Windows. A Linux-to-Linux move keeps a
 * "\" in a name as it is. --auto reads the same rule off the files.
 *
 * Off Windows only: on Windows these paths are the other way round.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-migrate-xos-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const skip = process.platform === 'win32' ? 'a move from Windows paths to POSIX ones happens off Windows' : false;

let db;
let migrate;
const write = (p, bytes = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
const insert = (filepath, filename, size = null) => Number(db.get()
  .prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes) VALUES (?, ?, 'video', ?)")
  .run(filepath, filename, size).lastInsertRowid);
const clear = () => db.get().prepare('DELETE FROM media').run();

test.before(() => {
  if (skip) return;
  db = require('../lib/database');
  db.init();
  migrate = require('../commands/migrate');
});
test.after(() => {
  if (db) db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('prefix: K:\\Media -> /mnt/media style writes "/" in the rest, any case, either slash', { skip }, async () => {
  clear();
  const root = path.join(tmp, 'prefix');
  write(path.join(root, 'Shows', 'Ep 1.mp4'));
  write(path.join(root, 'Movies', 'Film.MKV'));
  write(path.join(root, 'fwd.mp4'));
  const ep = insert('K:\\Media\\Shows\\Ep 1.mp4', 'Ep 1.mp4');
  const film = insert('k:\\MEDIA\\Movies\\Film.MKV', 'Film.MKV');        // another case of the drive and folder
  const fwd = insert('K:/Media/fwd.mp4', 'fwd.mp4');                    // an older row with forward slashes
  const backup = insert('K:\\MediaBackup\\x.mp4', 'x.mp4');             // not under K:\Media
  const gone = insert('K:\\Media\\Shows\\Ep 9.mp4', 'Ep 9.mp4');        // no file at the new place
  const report = await migrate.planPrefix('K:\\Media', `${root}/`);
  assert.deepStrictEqual(report.rewrite.map((r) => [r.row.id, r.newPath]).sort((a, b) => a[0] - b[0]), [
    [ep, `${root}/Shows/Ep 1.mp4`],
    [film, `${root}/Movies/Film.MKV`],
    [fwd, `${root}/fwd.mp4`],
  ]);
  assert.deepStrictEqual(report.missing.map((m) => [m.row.id, m.newPath]), [[gone, `${root}/Shows/Ep 9.mp4`]]);
  assert.ok(![...report.rewrite, ...report.missing].some((r) => r.row.id === backup), 'K:\\MediaBackup is not under K:\\Media');
  assert.ok(!report.rewrite.some((r) => r.newPath.includes('\\')), 'no backslash left in a Linux path');
  // Typed with forward slashes or another case: the same move.
  const again = await migrate.planPrefix('k:/media', root);
  assert.strictEqual(again.rewrite.length, 3);
  // A whole drive.
  const drive = await migrate.planPrefix('K:\\', root);
  assert.ok(drive.rewrite.some((r) => r.row.id === ep && r.newPath === `${root}/Media/Shows/Ep 1.mp4`) || drive.missing.some((m) => m.row.id === ep && m.newPath === `${root}/Media/Shows/Ep 1.mp4`));
  // A share.
  clear();
  const share = insert('\\\\nas\\media\\Shows\\Ep 1.mp4', 'Ep 1.mp4');
  const s = await migrate.planPrefix('\\\\NAS\\Media', root);
  assert.deepStrictEqual(s.rewrite.map((r) => [r.row.id, r.newPath]), [[share, `${root}/Shows/Ep 1.mp4`]]);
});

test('prefix: a Linux-to-Linux move keeps "\\" in a name and its case exact', { skip }, async () => {
  clear();
  const oldRoot = path.join(tmp, 'linux-old');
  const newRoot = path.join(tmp, 'linux-new');
  write(path.join(newRoot, 'a\\b.mp4'));
  const odd = insert(`${oldRoot}/a\\b.mp4`, 'a\\b.mp4');
  const other = insert(`${oldRoot.toUpperCase()}/c.mp4`, 'c.mp4');    // another case: another folder on Linux
  const report = await migrate.planPrefix(oldRoot, newRoot);
  assert.deepStrictEqual(report.rewrite.map((r) => [r.row.id, r.newPath]), [[odd, `${newRoot}/a\\b.mp4`]]);
  if (process.platform === 'linux') {
    assert.ok(![...report.rewrite, ...report.missing].some((r) => r.row.id === other));
  }
});

test('auto: the rule read off the files (D:\\Lib -> a POSIX folder) is applied with "/"', { skip }, async () => {
  clear();
  const root = path.join(tmp, 'auto');
  const ids = [];
  for (let i = 0; i < 10; i++) {
    write(path.join(root, 'Set', `clip ${i}.mp4`), 'y'.repeat(100 + i));
    ids.push(insert(`D:\\Lib\\Set\\clip ${i}.mp4`, `clip ${i}.mp4`, 100 + i));
  }
  const report = await migrate.planAuto(root);
  assert.deepStrictEqual(report.rules.map((r) => [r.oldPrefix, r.newPrefix, r.rows]), [['D:\\Lib', root, 10]],
    'the rule itself rewrote the rows (not the slower per-file matcher)');
  assert.deepStrictEqual(report.rewrite.map((r) => [r.row.id, r.newPath]).sort((a, b) => a[0] - b[0]),
    ids.map((id, i) => [id, `${root}/Set/clip ${i}.mp4`]));
});
