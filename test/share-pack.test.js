/**
 * Share privately: packing and the archive checks with the REAL 7-Zip
 * program (lib/share/pack.js, lib/share/sevenzip.js). Skipped cleanly when no
 * 7-Zip is found (VAULT_7ZIP, the app folder, PATH, or the usual Windows
 * install folder).
 *
 * Covered: the password goes to 7-Zip on stdin and never into its arguments
 * (every spawn is recorded), header encryption (listing without the password
 * fails and shows no name), the test passes, the contents are exactly the
 * picked files under their base names, split sizes, same-name files, names
 * that look like switches or list-file syntax, a non-ASCII password, cancel
 * deleting what was written, and the temp-folder delete guard.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-pack-'));
process.env.VAULT_SHARE_TEMP = path.join(tmp, 'share_temp');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
const WIN_7Z = 'C:\\Program Files\\7-Zip\\7z.exe';
if (!process.env.VAULT_7ZIP && process.platform === 'win32' && fs.existsSync(WIN_7Z)) process.env.VAULT_7ZIP = WIN_7Z;

// Record every spawn: the password must never be in an argument.
const spawns = [];
const realSpawn = childProcess.spawn;
childProcess.spawn = function recordingSpawn(cmd, args, opts) {
  spawns.push({ cmd, args: [...(args || [])] });
  return realSpawn.call(this, cmd, args, opts);
};

const sevenzip = require('../lib/share/sevenzip');
const pack = require('../lib/share/pack');
const temp = require('../lib/share/temp');

const PROGRAM = sevenzip.locate();
const skip = PROGRAM ? false : 'no 7-Zip program found';

test.after(() => {
  childProcess.spawn = realSpawn;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const src = path.join(tmp, 'library');
function mk(rel, bytes) {
  const p = path.join(src, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof bytes === 'number' ? crypto.randomBytes(bytes) : bytes);
  return { mediaId: null, filepath: p, size: fs.statSync(p).size };
}

function passwordNeverInArgs(password) {
  for (const s of spawns) {
    for (const a of s.args) assert.ok(!String(a).includes(password), `password found in 7-Zip arguments: ${s.args.join(' ')}`);
  }
}

async function packAndCheck(files, { password, partBytes = null, name = 'Test share' } = {}) {
  const p = pack.plan(files, { partBytes });
  const wd = temp.createWorkDir();
  const parts = await pack.pack({ entries: p.entries, workDir: wd.dir, archiveName: name, password, partBytes: p.partBytes, split: p.split });
  const checks = await pack.runChecks({ workDir: wd.dir, archiveName: name, password, expected: p.entries, parts, split: p.split });
  return { p, wd, parts, checks };
}

test('pack: encrypted headers, test passes, listing without the password fails, password only on stdin', { skip }, async () => {
  const password = 'Abcd-Efgh-Ijkl-Mnop-Qrst-Uvwx';
  const files = [mk('a/clip one.mp4', 40000), mk('b/photo.jpg', 1000), mk('b/empty.txt', 0)];
  const { p, wd, parts, checks } = await packAndCheck(files, { password });
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0].fileName, 'Test share.7z');
  assert.deepStrictEqual({ t: checks.test.ok, l: checks.listWithoutPassword.ok, c: checks.contents.ok, p: checks.parts.ok, ok: checks.ok },
    { t: true, l: true, c: true, p: true, ok: true });
  assert.deepStrictEqual(p.entries.map(e => e.archiveName), ['clip one.mp4', 'photo.jpg', 'empty.txt']);
  // The archive bytes do not hold the names in the clear.
  const raw = fs.readFileSync(path.join(wd.dir, parts[0].fileName));
  for (const n of ['clip one.mp4', 'photo.jpg', 'library']) assert.ok(!raw.includes(Buffer.from(n)), n);
  // Wrong password: the test fails.
  const bad = await pack.runChecks({ workDir: wd.dir, archiveName: 'Test share', password: 'wrong-password', expected: p.entries, parts, split: false });
  assert.strictEqual(bad.test.ok, false);
  assert.strictEqual(bad.ok, false);
  passwordNeverInArgs(password);
  assert.ok(spawns.some(s => s.args.includes('-p') && s.args.includes('-mhe=on') && s.args.includes('-mx=0')));
  assert.ok(await temp.removeWorkDir(wd.name));
  assert.ok(!fs.existsSync(wd.dir));
});

test('an archive made without header encryption fails the "listing without password" check', { skip }, async () => {
  const files = [mk('c/visible.mp4', 2000)];
  const wd = temp.createWorkDir();
  const archive = path.join(wd.dir, 'Leaky.7z');
  // Made directly with -mhe=off, as a broken build would.
  await sevenzip.runSevenZip(['a', '-t7z', '-mx=0', '-mhe=off', '-sccUTF-8', '-p', '--', archive, files[0].filepath], { password: 'some-pass-1234' });
  const parts = pack.listParts(wd.dir, 'Leaky', false);
  const checks = await pack.runChecks({ workDir: wd.dir, archiveName: 'Leaky', password: 'some-pass-1234',
    expected: [{ archiveName: 'visible.mp4', size: 2000 }], parts, split: false });
  assert.strictEqual(checks.listWithoutPassword.ok, false);
  assert.strictEqual(checks.listWithoutPassword.leaked, true);
  assert.strictEqual(checks.ok, false);
  await temp.removeWorkDir(wd.name);
});

test('split: parts named .7z.001 on, sizes match the part size, all checks pass', { skip }, async () => {
  const files = [mk('d/big1.bin', 300000), mk('d/big2.bin', 250000)];
  const { p, wd, parts, checks } = await packAndCheck(files, { password: 'Split-Pass-1234', partBytes: 200000, name: 'Parts' });
  assert.strictEqual(p.split, true);
  assert.deepStrictEqual(parts.map(x => x.fileName), ['Parts.7z.001', 'Parts.7z.002', 'Parts.7z.003']);
  assert.ok(parts.slice(0, -1).every(x => x.size === 200000));
  assert.ok(parts[parts.length - 1].size < 200000);
  assert.strictEqual(checks.ok, true, JSON.stringify(checks));
  // A part changed after the checks is noticed.
  assert.ok(pack.partsUnchanged(wd.dir, parts));
  fs.appendFileSync(path.join(wd.dir, parts[1].fileName), 'x');
  assert.strictEqual(pack.partsUnchanged(wd.dir, parts), false);
  await temp.removeWorkDir(wd.name);
});

test('no split when the total fits in one part', () => {
  const p = pack.plan([{ filepath: path.join(src, 'x.mp4'), size: 10 }], { partBytes: 100 });
  assert.strictEqual(p.split, false);
  assert.strictEqual(p.partBytes, null);
  assert.strictEqual(p.needBytes, Math.ceil(10 * 1.05));
});

test('same-name files and names that look like switches or list syntax', { skip }, async () => {
  const files = [
    mk('e1/same.mp4', 1000), mk('e2/same.mp4', 1100), mk('e3/SAME.mp4', 1200),
    mk('f/-rf.txt', 10), mk('f/@list.txt', 11), mk('f/x;y&z %PATH%.txt', 12), mk('f/ lead.txt', 13),
    mk('f/漢字 ä.txt', 14),
  ];
  const { p, wd, checks } = await packAndCheck(files, { password: 'Names-Pass-1234', name: 'Names' });
  assert.deepStrictEqual(p.entries.map(e => e.archiveName),
    ['same.mp4', 'same (2).mp4', 'SAME (3).mp4', '-rf.txt', '@list.txt', 'x;y&z %PATH%.txt', ' lead.txt', '漢字 ä.txt']);
  assert.deepStrictEqual(p.entries.map(e => e.stage), [false, true, true, false, false, false, false, false]);
  assert.strictEqual(checks.ok, true, JSON.stringify(checks));
  // Staging left nothing behind, and the library files are untouched.
  assert.deepStrictEqual(fs.readdirSync(wd.dir), ['Names.7z']);
  assert.ok(fs.existsSync(files[1].filepath));
  await temp.removeWorkDir(wd.name);
});

test('wildcard and control characters in a path never reach the list file', () => {
  const p = pack.plan([
    { filepath: path.join(src, 'a*b.mp4'), size: 1 },
    { filepath: path.join(src, 'q?.mp4'), size: 1 },
    { filepath: path.join(src, 'line\nbreak.mp4'), size: 1 },
  ]);
  assert.deepStrictEqual(p.entries.map(e => e.archiveName), ['a_b.mp4', 'q_.mp4', 'line_break.mp4']);
  assert.ok(p.entries.every(e => e.stage));
});

test('a non-ASCII password reaches 7-Zip intact (stdin is read as UTF-8)', { skip }, async () => {
  const password = 'pässwörd € 漢字 x';
  const files = [mk('g/u.txt', 100)];
  const { wd, parts, checks } = await packAndCheck(files, { password, name: 'Uni' });
  assert.strictEqual(checks.ok, true);
  // Proof from outside the stdin route: the archive opens with the same
  // password given on 7-Zip's command line (test only; Vault never does this).
  const r = childProcess.spawnSync(PROGRAM, ['t', `-p${password}`, '--', path.join(wd.dir, parts[0].fileName)], { windowsHide: true });
  assert.strictEqual(r.status, 0);
  await temp.removeWorkDir(wd.name);
});

test('passwords 7-Zip would cut short are refused before 7-Zip starts', async () => {
  for (const bad of ['', 'a\nb', 'a\rb', 'a\0b']) {
    assert.strictEqual(sevenzip.passwordFitsStdin(bad), false);
    await assert.rejects(sevenzip.runSevenZip(['i'], { password: bad, program: PROGRAM || 'x' }), { code: 'BAD_PASSWORD' });
  }
  await assert.rejects(sevenzip.runSevenZip(['a', '-pSecret123'], { password: 'Secret123', program: PROGRAM || 'x' }), { code: 'PASSWORD_IN_ARGS' });
});

test('cancel stops 7-Zip and the work folder is deleted', { skip }, async () => {
  const files = [mk('h/large.bin', 30 * 1024 * 1024)];
  const p = pack.plan(files);
  const wd = temp.createWorkDir();
  const handle = { cancelled: false, kill: null };
  const run = pack.pack({ entries: p.entries, workDir: wd.dir, archiveName: 'Cancel', password: 'Cancel-Pass-1234', handle,
    onProgress: ({ phase }) => { if (phase === 'packing' && !handle.cancelled) setTimeout(() => { handle.cancelled = true; if (handle.kill) handle.kill(); }, 30); } });
  await assert.rejects(run, { code: 'CANCELLED' });
  assert.ok(await temp.removeWorkDir(wd.name));
  assert.ok(!fs.existsSync(wd.dir));
});

test('7-Zip not found is a clear error', async () => {
  const prev = process.env.VAULT_7ZIP;
  process.env.VAULT_7ZIP = path.join(tmp, 'nope', '7za.exe');
  try {
    assert.strictEqual(sevenzip.locate(), null);
    await assert.rejects(sevenzip.runSevenZip(['i'], {}), { code: 'SEVENZIP_MISSING' });
    process.env.VAULT_7ZIP = 'relative\\7za.exe';
    assert.strictEqual(sevenzip.locate(), null);
  } finally {
    if (prev === undefined) delete process.env.VAULT_7ZIP; else process.env.VAULT_7ZIP = prev;
  }
});

test('temp delete guard: never outside share_temp, never a link, never a bad name', async () => {
  const root = temp.ensureRoot();
  assert.ok(fs.existsSync(path.join(root, '.vault-owned')));
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  for (const bad of ['..', '../outside', 'share-..', 'share-abc', '', null, 'share-AAAAAAAAAAAA/..', path.join(outside)]) {
    assert.strictEqual(await temp.removeWorkDir(bad), false, String(bad));
  }
  // A junction/link named like a work folder, pointing outside, is refused.
  const linkName = 'share-LinkLinkLink';
  try {
    fs.symlinkSync(outside, path.join(root, linkName), 'junction');
    assert.strictEqual(await temp.removeWorkDir(linkName), false);
    fs.unlinkSync(path.join(root, linkName));
  } catch (err) {
    if (err.code !== 'EPERM') throw err;   // no right to make links here: nothing to test
  }
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
  // A share_temp without Vault's marker is not swept.
  const wd = temp.createWorkDir();
  fs.unlinkSync(path.join(root, '.vault-owned'));
  assert.strictEqual(await temp.removeWorkDir(wd.name), false);
  assert.ok(fs.existsSync(wd.dir));
  temp.ensureRoot();
  assert.strictEqual(await temp.removeWorkDir(wd.name), true);
});
