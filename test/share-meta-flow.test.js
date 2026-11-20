/**
 * Share privately: "Check files for personal details" from step 1 to the
 * packed copies (lib/share/service.js, server/share-routes.js, lib/share/pack.js).
 *
 * Covered:
 *  - the setting off (the default): no check at all, no file opened for it,
 *    a removePersonal sent anyway changes nothing;
 *  - step 1 over HTTP: what was found, per file, "could not be checked", the
 *    extra free space; an unknown or forgotten check id is NOT_FOUND;
 *  - Remove: only the files the SERVER's own check flagged get a cleaned copy,
 *    whatever file list the page sends; the others are packed as they are;
 *    the originals stay byte for byte;
 *  - Share as they are: nothing cleaned;
 *  - free space: the cleaned copies count at start and again at the turn;
 *  - fail-safe: a copy that cannot be cleaned fails the share with its name,
 *    never packs the original, and nothing found is stored anywhere;
 *  - cancel and lock while cleaning stop ffmpeg and leave nothing behind;
 *  - only real cleaning output keeps the automatic lock waiting.
 *
 * 7-Zip is a fake that records what it was given; ffprobe and ffmpeg are a
 * node script. No request leaves the machine.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-metaflow-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_SHARE_TEMP = path.join(tmp, 'share_temp');
delete process.env.VAULT_DB_PASSWORD;

const config = require('../config');
const db = require('../lib/database');
const vault = require('../lib/vault');
const store = require('../lib/share/store');
const settings = require('../lib/share/settings');
const temp = require('../lib/share/temp');
const pack = require('../lib/share/pack');
const sevenzip = require('../lib/share/sevenzip');
const meta = require('../lib/share/meta');
const service = require('../lib/share/service');
const { app } = require('../server/index');
const { BASE_JPEG, jpegWithComment, pngWithText } = require('./helpers/share-meta-fixtures');

const VAULT_PASS = 'vault-pass-metaflow';
const FOUND = 'Sam Example';   // the personal value in every flagged file

const realFetch = globalThis.fetch;
let strayFetches = 0;
let server;
let base;
let cipher = true;

/* ── A fake 7-Zip: records the files it was given ─────────────────────── */

const realRun = sevenzip.runSevenZip;
const realChecks = pack.runChecks;
let in7z = false;   // the fake 7-Zip reading the files (as the real one would)
let packed = [];   // per pack: { names: [...], bytes: { name: Buffer }, lines: [...] }
sevenzip.runSevenZip = async (args, o) => {
  if (args[0] !== 'a') return { code: 0, stdout: '', stderr: '', killed: false };
  const list = args.find(a => a.startsWith('-i@')).slice(3);
  const lines = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean);
  const rec = { lines, bytes: {} };
  in7z = true;
  try { for (const l of lines) rec.bytes[path.basename(l)] = fs.readFileSync(l); } finally { in7z = false; }
  packed.push(rec);
  o.onOutput && o.onOutput();
  fs.writeFileSync(args[args.length - 1], Buffer.alloc(500, 3));
  return { code: 0, stdout: '', stderr: '', killed: false };
};
let checksSeen = [];
pack.runChecks = async (o) => {
  checksSeen.push(o.expected.map(e => ({ archiveName: e.archiveName, size: e.size })));
  return { ok: true, test: { ok: true }, listWithoutPassword: { ok: true }, contents: { ok: true }, parts: { ok: true, count: o.parts.length } };
};

/* ── A fake ffprobe and ffmpeg ─────────────────────────────────────────── */

const FAKE = path.join(tmp, 'fake-ff.js');
const PROBE_LOG = path.join(tmp, 'probe.log');
const FF_PID = path.join(tmp, 'ff.pid');
fs.writeFileSync(FAKE, `
const fs = require('fs');
const args = process.argv.slice(2);
const strip = (s) => s.replace(/^file:/, '');
if (args.includes('-show_format')) {
  const f = strip(args[args.length - 1]);
  fs.appendFileSync(${JSON.stringify(PROBE_LOG)}, f + '\\n');
  let b; try { b = fs.readFileSync(f); } catch { process.exit(1); }
  if (b.includes('NOTMEDIA')) process.exit(1);
  const tags = b.includes('PERSONAL') ? { artist: ${JSON.stringify(FOUND)} } : { encoder: 'Lavf' };
  process.stdout.write(JSON.stringify({ format: { format_name: 'mov,mp4', tags }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }));
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(FF_PID)}, String(process.pid));
const input = strip(args[args.indexOf('-i') + 1]);
const output = strip(args[args.length - 1]);
const mode = process.env.FAKE_FF_MODE || 'clean';
const src = fs.readFileSync(input);
if (mode === 'fail') process.exit(1);
if (mode === 'copy') { fs.writeFileSync(output, src, { flag: 'wx' }); process.exit(0); }
if (mode === 'hang' || mode === 'talk') {
  fs.writeFileSync(output, src.subarray(0, 1000), { flag: 'wx' });
  if (mode === 'talk') setInterval(() => process.stdout.write('progress=continue\\n'), 20);
  setInterval(() => {}, 1000);
} else {
  fs.writeFileSync(output, Buffer.from(src.toString('latin1').replace(/PERSONAL/g, 'scrubbed'), 'latin1'), { flag: 'wx' });
  process.stdout.write('progress=end\\n');
}
`);

/* ── Setup ─────────────────────────────────────────────────────────────── */

const MEDIA = path.join(tmp, 'media');
const files = {};   // name -> { id, path, sha }
function addMedia(name, buf, type = 'image') {
  const p = path.join(MEDIA, name);
  fs.writeFileSync(p, buf);
  const old = new Date(Date.now() - 86400000 * 400);
  fs.utimesSync(p, old, old);
  const id = Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)').run(p, name, type).lastInsertRowid);
  files[name] = { id, path: p, sha: sha(buf) };
  return id;
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ON = () => ({ ...settings.DEFAULTS, enabled: true, rememberPasswords: false, split: 'none', checkPersonal: true });

test.before(async () => {
  db.init();
  cipher = typeof db.get().pragma === 'function' && db.get().pragma('cipher', { simple: true }) != null;
  clearInterval(vault._timer);
  config.net.offline = true;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  globalThis.fetch = (url, opts) => {
    if (String(url).startsWith(base)) return realFetch(url, opts);
    strayFetches++;
    return Promise.reject(new Error('no real request in this test'));
  };
  if (cipher) await vault.setPassword(VAULT_PASS);
  fs.mkdirSync(MEDIA, { recursive: true });
  addMedia('holiday.jpg', jpegWithComment(`Holiday with ${FOUND}`));
  addMedia('drawing.png', pngWithText([['Author', FOUND]]));
  addMedia('plain.jpg', BASE_JPEG);
  addMedia('broken.mp4', Buffer.concat([Buffer.from('NOTMEDIA'), crypto.randomBytes(2000)]), 'video');
  addMedia('clip.mp4', Buffer.concat([Buffer.from('xx PERSONAL xx'), crypto.randomBytes(100 * 1024)]), 'video');
  meta._setForTest({ probe: { exe: process.execPath, pre: [FAKE] }, ffmpeg: { exe: process.execPath, pre: [FAKE] } });
  settings.save(ON());
  service._setForTest({ program: 'fake-7zip' });
  service.ensureRecovered();
});

test.after(async () => {
  globalThis.fetch = realFetch;
  sevenzip.runSevenZip = realRun;
  pack.runChecks = realChecks;
  meta._setForTest({ probe: null, ffmpeg: null });
  if (vault.isLocked()) vault.unlock(VAULT_PASS);
  await service._idle();
  service._setForTest({ client: null, sleep: null, now: null, program: null });
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { require('../lib/secure-assets').close(); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test.afterEach(async () => {
  if (vault.isLocked()) vault.unlock(VAULT_PASS);
  for (const r of store.listShares()) { if (['packing', 'queued'].includes(r.status)) { try { await service.cancel(r.id); } catch {} } }
  await service._idle();
  service._setForTest({ now: null });
  delete process.env.FAKE_FF_MODE;
  for (const r of store.listShares()) {
    try { await temp.removeWorkDir(r.work_dir); } catch {}
    store.deleteShare(r.id);
  }
  packed = [];
  checksSeen = [];
  settings.save(ON());
  meta.forget();
  try { fs.unlinkSync(PROBE_LOG); } catch {}
  for (const f of Object.values(files)) assert.strictEqual(sha(fs.readFileSync(f.path)), f.sha, `${path.basename(f.path)} was never changed`);
  assert.strictEqual(strayFetches, 0, 'a real request was made');
});

/* ── Helpers ───────────────────────────────────────────────────────────── */

async function until(cond, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise(r => setTimeout(r, 3));
  }
  assert.ok(cond(), `waited for: ${what}`);
}
const statusOf = (id) => (store.getShare(id) || {}).status;
const ids = (...names) => names.map(n => files[n].id);

async function call(method, p, body) {
  const res = await fetch(base + '/api/share' + p, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Vault-Share': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/** Step 1's check over HTTP, polled until done. */
async function check(mediaIds) {
  let r = await call('POST', '/meta-check', { mediaIds });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const id = r.json.id;
  for (let i = 0; i < 2000 && !r.json.done; i++) {
    await new Promise(res => setTimeout(res, 5));
    r = await call('GET', `/meta-check/${id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  }
  assert.strictEqual(r.json.done, true);
  return r.json;
}

/** Every value in every Share privately table, and the settings file, as one string. */
function dumpDb() {
  const d = db.get();
  const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'share%'").all().map(t => t.name);
  assert.ok(tables.includes('shares') && tables.includes('share_files'));
  return tables.map(t => JSON.stringify(d.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
    + fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8');
}

/* ── The setting off ───────────────────────────────────────────────────── */

test('setting off (the default): no check, no file opened for it, removePersonal changes nothing', async () => {
  assert.strictEqual(settings.DEFAULTS.checkPersonal, false, 'off by default');
  settings.save({ ...ON(), checkPersonal: false });
  const opened = [];
  const realOpen = fs.promises.open;
  const realOpenSync = fs.openSync;
  const mediaPaths = new Set(Object.values(files).map(f => path.resolve(f.path)));
  fs.promises.open = (p, ...rest) => { if (!in7z && mediaPaths.has(path.resolve(String(p)))) opened.push(p); return realOpen.call(fs.promises, p, ...rest); };
  fs.openSync = (p, ...rest) => { if (!in7z && mediaPaths.has(path.resolve(String(p)))) opened.push(p); return realOpenSync.call(fs, p, ...rest); };
  try {
    const all = ids('holiday.jpg', 'drawing.png', 'clip.mp4');
    assert.strictEqual(service.preview({ mediaIds: all }).checkPersonal, false);
    const r = await call('POST', '/meta-check', { mediaIds: all });
    assert.deepStrictEqual(r.json, { off: true });
    const s = await call('POST', '/shares', { mediaIds: all, removePersonal: true });
    assert.strictEqual(s.status, 202, JSON.stringify(s.json));
    await until(() => statusOf(s.json.share.id) === 'checked', 'packed');
    assert.deepStrictEqual(opened, [], 'no picked file was opened by Vault itself');
    assert.ok(!fs.existsSync(PROBE_LOG), 'ffprobe never ran');
    assert.strictEqual(meta._stateForTest().cache, 0);
    assert.ok(packed[0].bytes['holiday.jpg'].includes(Buffer.from(FOUND)), 'packed as it is');
    assert.ok(packed[0].lines.includes(files['clip.mp4'].path), 'the original itself, no copy');
  } finally {
    fs.promises.open = realOpen;
    fs.openSync = realOpenSync;
  }
});

/* ── Step 1 ────────────────────────────────────────────────────────────── */

test('step 1: flagged files with what was found, could-not-check counted, the extra space; ids are checked', async () => {
  const all = ids('holiday.jpg', 'drawing.png', 'plain.jpg', 'broken.mp4', 'clip.mp4');
  assert.strictEqual(service.preview({ mediaIds: all }).checkPersonal, true);
  const r = await check(all);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.personalCount, 3);
  assert.strictEqual(r.uncheckedCount, 1, 'broken.mp4 could not be checked');
  const byId = Object.fromEntries(r.files.map(f => [f.mediaId, f.findings]));
  assert.deepStrictEqual(Object.keys(byId).map(Number).sort(), ids('holiday.jpg', 'drawing.png', 'clip.mp4').sort());
  assert.deepStrictEqual(byId[files['drawing.png'].id], [{ label: 'Name', value: FOUND }]);
  assert.match(byId[files['holiday.jpg'].id][0].value, /Holiday with Sam/);
  const flaggedBytes = ['holiday.jpg', 'drawing.png', 'clip.mp4'].reduce((n, k) => n + fs.statSync(files[k].path).size, 0);
  assert.strictEqual(r.extraBytes, flaggedBytes, 'the copies take their own size');
  assert.strictEqual(r.needBytes, service.preview({ mediaIds: all }).needBytes + flaggedBytes);
  assert.strictEqual(typeof r.enoughSpace, 'boolean');
  for (const bad of ['nope', '0'.repeat(24), '../../x', 'A'.repeat(24)]) {
    const x = await call('GET', `/meta-check/${encodeURIComponent(bad)}`);
    assert.strictEqual(x.status, 404, bad);
  }
  // Forgotten (a lock does the same): NOT_FOUND.
  meta.forget();
  const gone = await call('GET', `/meta-check/${r.id}`);
  assert.strictEqual(gone.status, 404);
  assert.strictEqual(gone.json.code, 'NOT_FOUND');
  // Nothing found is ever written to the database.
  assert.ok(!dumpDb().includes('Sam'), 'no found value in the database');
});

/* ── Remove / Share as they are ───────────────────────────────────────── */

test('Remove: only the files the server flagged are cleaned, whatever list the page sends; the others go as they are', async () => {
  const all = ids('holiday.jpg', 'drawing.png', 'plain.jpg', 'broken.mp4');
  await check(all);
  // A page that tries to steer it: names a clean file, leaves out a flagged one.
  const s = await call('POST', '/shares', {
    mediaIds: all, removePersonal: true,
    files: [files['plain.jpg'].id], cleanIds: [files['plain.jpg'].id], personal: { [files['holiday.jpg'].id]: false },
  });
  assert.strictEqual(s.status, 202, JSON.stringify(s.json));
  await until(() => statusOf(s.json.share.id) === 'checked', 'packed and checked');
  const rec = packed[0];
  const stage = (n) => rec.lines.find(l => path.basename(l) === n);
  for (const n of ['holiday.jpg', 'drawing.png']) {
    assert.ok(!rec.bytes[n].includes(Buffer.from('Sam')), `${n}: cleaned`);
    assert.notStrictEqual(path.resolve(stage(n)), path.resolve(files[n].path), `${n}: a copy, not the original`);
    assert.ok(rec.bytes[n].length > 0);
  }
  assert.strictEqual(sha(rec.bytes['plain.jpg']), files['plain.jpg'].sha, 'a clean file goes as it is');
  assert.strictEqual(sha(rec.bytes['broken.mp4']), files['broken.mp4'].sha, 'a file that could not be checked goes as it is');
  // The archive check expects the cleaned sizes.
  const exp = Object.fromEntries(checksSeen[0].map(e => [e.archiveName, e.size]));
  assert.strictEqual(exp['holiday.jpg'], rec.bytes['holiday.jpg'].length);
  assert.strictEqual(exp['plain.jpg'], fs.statSync(files['plain.jpg'].path).size);
  assert.ok(!dumpDb().includes('Sam'), 'no found value in the database');
});

test('Remove is decided at the turn by the server\'s own check, even with no step 1 check at all; a missing choice means Remove', async () => {
  const s = service.start({ mediaIds: ids('holiday.jpg', 'plain.jpg') });
  await until(() => statusOf(s.id) === 'checked', 'packed');
  assert.ok(!packed[0].bytes['holiday.jpg'].includes(Buffer.from('Sam')));
  assert.strictEqual(sha(packed[0].bytes['plain.jpg']), files['plain.jpg'].sha);
});

test('Share as they are: nothing cleaned, nothing copied for it', async () => {
  await check(ids('holiday.jpg', 'drawing.png'));
  const s = await call('POST', '/shares', { mediaIds: ids('holiday.jpg', 'drawing.png'), removePersonal: false });
  assert.strictEqual(s.status, 202, JSON.stringify(s.json));
  await until(() => statusOf(s.json.share.id) === 'checked', 'packed');
  assert.ok(packed[0].bytes['holiday.jpg'].includes(Buffer.from(FOUND)));
  assert.ok(packed[0].lines.includes(files['drawing.png'].path), 'the original itself');
});

/* ── Free space ────────────────────────────────────────────────────────── */

test('free space: the cleaned copies count at start, and are measured again at the turn', async () => {
  const realFree = temp.freeBytes;
  try {
    const all = ids('holiday.jpg', 'plain.jpg');
    const baseNeed = service.preview({ mediaIds: all }).needBytes;
    const st = await check(all);
    assert.ok(st.needBytes > baseNeed);
    // Enough for the archive, not for the copies.
    temp.freeBytes = () => baseNeed + 1;
    assert.throws(() => service.start({ mediaIds: all, removePersonal: true }), { code: 'NO_SPACE' });
    // As they are, it fits.
    const asIs = service.start({ mediaIds: all, removePersonal: false });
    await until(() => statusOf(asIs.id) === 'checked', 'packed as they are');
    // Enough at start, the drive fills before the copies are made: fails cleanly.
    let full = false;
    temp.freeBytes = () => (full ? baseNeed + 1 : st.needBytes * 10);
    const s = service.start({ mediaIds: all, removePersonal: true });
    full = true;
    await until(() => statusOf(s.id) === 'failed', 'failed at the turn');
    assert.match(store.getShare(s.id).last_error, /^There was not enough free space for the cleaned copies/);
    assert.strictEqual(packed.length, 1, '7-Zip never ran for it');
  } finally {
    temp.freeBytes = realFree;
  }
});

/* ── Fail-safe ─────────────────────────────────────────────────────────── */

test('a copy that cannot be cleaned fails the share with the file\'s name; the original is never packed; nothing found is stored', async () => {
  for (const mode of ['fail', 'copy']) {
    process.env.FAKE_FF_MODE = mode;
    settings.save({ ...ON(), rememberFiles: true });
    const s = service.start({ mediaIds: ids('clip.mp4', 'plain.jpg'), removePersonal: true });
    await until(() => statusOf(s.id) === 'failed', `failed (${mode})`);
    const row = store.getShare(s.id);
    assert.strictEqual(row.last_error, 'Vault could not remove personal details from clip.mp4, so this share was not packed. Nothing was uploaded. Your own file was not changed.');
    assert.strictEqual(packed.length, 0, `${mode}: 7-Zip never ran`);
    assert.strictEqual(row.work_dir, null, 'the work folder (and any partial copy) is gone');
    assert.ok(!dumpDb().includes(FOUND), 'no found value in the database');
  }
  // "Which files were in each share" off: the row keeps no name, the page still sees it while Vault runs.
  process.env.FAKE_FF_MODE = 'fail';
  settings.save({ ...ON(), rememberFiles: false });
  const s = service.start({ mediaIds: ids('clip.mp4'), removePersonal: true });
  await until(() => statusOf(s.id) === 'failed', 'failed');
  assert.strictEqual(store.getShare(s.id).last_error, 'Vault could not remove personal details from one of the files, so this share was not packed. Nothing was uploaded. Your own file was not changed.');
  assert.ok(!JSON.stringify([store.getShare(s.id), store.getFiles(s.id)]).includes('clip'), 'no file name stored for it');
  assert.match(service.progress(s.id).error, /from clip\.mp4,/);
});

/* ── Cancel, lock, and the automatic lock while cleaning ──────────────── */

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function startCleaning(mode) {
  process.env.FAKE_FF_MODE = mode;
  try { fs.unlinkSync(FF_PID); } catch {}
  const s = service.start({ mediaIds: ids('clip.mp4'), removePersonal: true });
  await until(() => fs.existsSync(FF_PID) && fs.readFileSync(FF_PID, 'utf8'), 'ffmpeg is running');
  const pid = Number(fs.readFileSync(FF_PID, 'utf8'));
  const wd = temp.workDirPath(store.getShare(s.id).work_dir);
  await until(() => fs.existsSync(path.join(wd, 'stage')) && fs.readdirSync(path.join(wd, 'stage')).some(n => n.startsWith('.vclean-')), 'a partial copy exists');
  assert.strictEqual(service.progress(s.id).packing.phase, 'cleaning');
  return { s, pid, wd };
}

test('cancel while cleaning stops ffmpeg and removes the partial copy and the work folder', async () => {
  const { s, pid, wd } = await startCleaning('hang');
  assert.ok(alive(pid));
  await service.cancel(s.id);
  await until(() => !alive(pid), 'ffmpeg stopped');
  await service._idle();
  await service._cleanupNow();
  assert.strictEqual(fs.existsSync(wd), false, 'the work folder and the partial copy are gone');
  assert.strictEqual(store.getShare(s.id), null);
  assert.strictEqual(packed.length, 0);
});

test('a lock while cleaning stops ffmpeg, removes the partial copy, and forgets every check', async (t) => {
  if (!cipher) { t.skip('this build has no SQLite cipher'); return; }
  await check(ids('holiday.jpg'));
  const { s, pid, wd } = await startCleaning('hang');
  assert.ok(meta._stateForTest().cache > 0);
  await vault.lock({ force: false });
  assert.strictEqual(vault.isLocked(), true);
  await until(() => !alive(pid), 'ffmpeg stopped');
  assert.strictEqual(meta._stateForTest().cache, 0, 'found values gone from memory');
  assert.strictEqual(meta._stateForTest().checks, 0);
  vault.unlock(VAULT_PASS);
  await service._idle();
  await service._cleanupNow();
  assert.strictEqual(fs.existsSync(wd), false);
  assert.strictEqual(store.getShare(s.id), null);
});

test('the automatic lock: ffmpeg output while cleaning is a sign of life; a silent ffmpeg is not', async () => {
  let clock = Date.now();
  service._setForTest({ now: () => clock });
  const quiet = await startCleaning('hang');
  assert.strictEqual(service.isWorking(), true);
  clock += service.STALL_MS + 1000;
  await new Promise(r => setTimeout(r, 150));   // a silent ffmpeg says nothing meanwhile
  assert.strictEqual(service.isWorking(), false, 'no sign of life for STALL_MS: no hold');
  await service.cancel(quiet.s.id);
  await until(() => !alive(quiet.pid), 'stopped');
  await service._idle();
  const talk = await startCleaning('talk');
  clock += service.STALL_MS - 1000;
  assert.strictEqual(service.isWorking(), true);
  await new Promise(r => setTimeout(r, 150));   // ffmpeg prints its progress
  clock += 2000;
  assert.strictEqual(service.isWorking(), true, 'its output restarted the window');
  await service.cancel(talk.s.id);
  await until(() => !alive(talk.pid), 'stopped');
});

test('shutdown while cleaning stops ffmpeg', async () => {
  const { pid } = await startCleaning('hang');
  await service.shutdown({ waitMs: 3000 });
  await until(() => !alive(pid), 'ffmpeg stopped');
});
