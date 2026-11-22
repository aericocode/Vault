/**
 * Share privately: the personal details check, from step 1 to the packed
 * copies (lib/share/service.js, server/share-routes.js, lib/share/pack.js).
 *
 * Covered:
 *  - there is no setting: every share is checked, an old stored checkPersonal
 *    (true or false) and one sent by the page are ignored; Remove is the
 *    default (only exactly removePersonal: false turns it off), also for a
 *    share that uploads on its own;
 *  - step 1 over HTTP: what was found, per file, the files whose check failed
 *    (a type Vault checks) apart from those of a type Vault does not read,
 *    the extra free space; an unknown or forgotten check id is NOT_FOUND;
 *  - a check that fails (ffprobe exits with an error, prints junk, prints
 *    too much) is never taken as clean: with Remove the share fails naming
 *    the file, also when step 1 had flagged it and the cache was forgotten
 *    (what a lock does); with Remove off it is packed as it is;
 *  - a file changed after its check and before 7-Zip read it fails the share;
 *  - Remove: only the files the SERVER's own check flagged get a cleaned copy,
 *    whatever file list the page sends; the others are packed as they are;
 *    the originals stay byte for byte;
 *  - Remove off: nothing cleaned;
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
let sevenzipHook = null;   // (lines) => void, run as the fake 7-Zip starts reading
sevenzip.runSevenZip = async (args, o) => {
  if (args[0] !== 'a') return { code: 0, stdout: '', stderr: '', killed: false };
  const list = args.find(a => a.startsWith('-i@')).slice(3);
  const lines = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean);
  const rec = { lines, bytes: {} };
  in7z = true;
  try {
    if (sevenzipHook) sevenzipHook(lines);
    for (const l of lines) rec.bytes[path.basename(l)] = fs.readFileSync(l);
  } finally { in7z = false; }
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
  const probeMode = process.env.FAKE_PROBE || '';
  if (probeMode === 'fail') process.exit(1);
  if (probeMode === 'junk') { process.stdout.write('{"format": nope'); process.exit(0); }
  if (probeMode === 'flood') { const chunk = 'x'.repeat(1 << 20); let n = 0; const go = () => { while (n < 12) { n++; if (!process.stdout.write(chunk)) { process.stdout.once('drain', go); return; } } }; go(); return; }
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
const ON = () => ({ ...settings.DEFAULTS, enabled: true, rememberPasswords: false, split: 'none' });

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
  addMedia('sticker.webp', Buffer.concat([Buffer.from('NOTMEDIA'), crypto.randomBytes(2000)]));
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
  delete process.env.FAKE_PROBE;
  // A test that hid ffprobe or ffmpeg gives them back.
  meta._setForTest({ probe: { exe: process.execPath, pre: [FAKE] }, ffmpeg: { exe: process.execPath, pre: [FAKE] } });
  sevenzipHook = null;
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

/* ── Always checked: there is no setting ──────────────────────────────── */

const cleanedHoliday = () => !packed[packed.length - 1].bytes['holiday.jpg'].includes(Buffer.from('Sam'));

test('no setting: an old stored checkPersonal, true or false, is ignored; step 1 always checks; a page that sends it changes nothing', async () => {
  const appSettings = require('../lib/app-settings');
  assert.ok(!('checkPersonal' in settings.DEFAULTS), 'no such setting');
  const all = ids('holiday.jpg', 'plain.jpg');
  for (const stored of [false, true]) {
    // A settings file from before, written straight to disk.
    appSettings.set({ share: { ...ON(), checkPersonal: stored } });
    assert.strictEqual(appSettings.all().share.checkPersonal, stored, 'the old value is on disk');
    assert.ok(!('checkPersonal' in settings.get()), `stored ${stored}: not read`);
    assert.ok(!('checkPersonal' in service.preview({ mediaIds: all })), 'the page is told nothing about it');
    const st = await check(all);
    assert.strictEqual(st.personalCount, 1, `stored ${stored}: step 1 checked`);
    assert.ok(!('off' in st));
    // The page sends nothing about it, or the old flag off: removed all the same.
    const s = await call('POST', '/shares', { mediaIds: all, checkPersonal: false });
    assert.strictEqual(s.status, 202, JSON.stringify(s.json));
    await until(() => statusOf(s.json.share.id) === 'checked', 'packed');
    assert.ok(cleanedHoliday(), `stored ${stored}: cleaned`);
  }
  // A page left open from before sends the old switch: accepted, changes nothing, and the key leaves the file.
  const r = await call('POST', '/settings', { checkPersonal: false });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.ok(!('checkPersonal' in r.json.settings));
  assert.ok(!('checkPersonal' in appSettings.all().share), 'gone from the file on the next save');
  assert.deepStrictEqual(settings.validatePatch({ checkPersonal: true }), {});
  assert.ok(!dumpDb().includes('Sam'), 'no found value in the database or the settings file');
});

test('Remove is the default: missing, null, a string or a number all mean remove; only exactly false turns it off', async () => {
  const all = ids('holiday.jpg', 'plain.jpg');
  for (const v of [undefined, null, 'false', 0, true, 'no']) {
    const body = { mediaIds: all };
    if (v !== undefined) body.removePersonal = v;
    const s = await call('POST', '/shares', body);
    assert.strictEqual(s.status, 202, JSON.stringify(s.json));
    await until(() => statusOf(s.json.share.id) === 'checked', `packed (${JSON.stringify(v)})`);
    assert.ok(cleanedHoliday(), `removePersonal ${JSON.stringify(v)}: cleaned`);
  }
  const off = await call('POST', '/shares', { mediaIds: all, removePersonal: false });
  await until(() => statusOf(off.json.share.id) === 'checked', 'packed with Remove off');
  assert.ok(packed[packed.length - 1].bytes['holiday.jpg'].includes(Buffer.from(FOUND)), 'Remove off: the details go as they are');
  assert.strictEqual(sha(packed[packed.length - 1].bytes['holiday.jpg']), files['holiday.jpg'].sha);
});

test('a share that uploads on its own is checked and cleaned like any other', async () => {
  settings.save({ ...ON(), afterPack: 'upload' });
  // Offline: the upload gate stops it once packed, which is after the cleaning.
  const s = await call('POST', '/shares', { mediaIds: ids('holiday.jpg', 'drawing.png'), confirmUpload: true });
  assert.strictEqual(s.status, 202, JSON.stringify(s.json));
  await until(() => statusOf(s.json.share.id) === 'checked' && packed.length === 1, 'packed');
  assert.ok(cleanedHoliday());
  assert.ok(!packed[0].bytes['drawing.png'].includes(Buffer.from('Sam')));
});

/* ── Step 1 ────────────────────────────────────────────────────────────── */

test('step 1: flagged files with what was found, failed checks and types Vault does not read counted apart, the extra space; ids are checked', async () => {
  const all = ids('holiday.jpg', 'drawing.png', 'plain.jpg', 'broken.mp4', 'clip.mp4', 'sticker.webp');
  const r = await check(all);
  assert.strictEqual(r.total, 6);
  assert.strictEqual(r.personalCount, 3);
  assert.strictEqual(r.failedCount, 1, 'broken.mp4: a video ffprobe could not read is a failed check');
  assert.deepStrictEqual(r.failedFiles, [{ mediaId: files['broken.mp4'].id }]);
  assert.strictEqual(r.uncheckedCount, 1, 'sticker.webp: a type Vault does not read');
  assert.strictEqual(meta.cached({ path: files['broken.mp4'].path, size: fs.statSync(files['broken.mp4'].path).size, mtimeMs: fs.statSync(files['broken.mp4'].path).mtimeMs }), null, 'a failed check is never kept');
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

/* ── Remove on / off ───────────────────────────────────────────────────── */

test('Remove: only the files the server flagged are cleaned, whatever list the page sends; the others go as they are', async () => {
  const all = ids('holiday.jpg', 'drawing.png', 'plain.jpg', 'sticker.webp');
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
  assert.strictEqual(sha(rec.bytes['sticker.webp']), files['sticker.webp'].sha, 'a type Vault does not read goes as it is');
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

test('Remove off (exactly false): nothing cleaned, nothing copied for it, the details go as they are', async () => {
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

const CHECK_FAILED = (what) => `Vault could not check ${what} for personal details, so this share was not packed. Nothing was uploaded. To pack it without the check, start the share again and turn off Remove under Personal details.`;

test('a check that fails at the turn is never taken as clean: flagged at step 1, the cache forgotten (a lock), ffprobe failing; the share fails naming the file', async () => {
  settings.save({ ...ON(), rememberFiles: true });
  const st = await check(ids('clip.mp4', 'holiday.jpg'));
  assert.strictEqual(st.personalCount, 2);
  for (const mode of ['fail', 'junk', 'flood']) {
    meta.forget();
    process.env.FAKE_PROBE = mode;
    const s = service.start({ mediaIds: ids('clip.mp4', 'holiday.jpg'), removePersonal: true });
    await until(() => statusOf(s.id) === 'failed', `failed (${mode})`);
    const row = store.getShare(s.id);
    assert.strictEqual(row.last_error, CHECK_FAILED('clip.mp4'), mode);
    assert.strictEqual(packed.length, 0, `${mode}: 7-Zip never ran, the original was never packed`);
    assert.strictEqual(row.work_dir, null, 'the work folder is gone');
    assert.strictEqual(meta.cached({ path: files['clip.mp4'].path, size: fs.statSync(files['clip.mp4'].path).size, mtimeMs: fs.statSync(files['clip.mp4'].path).mtimeMs }), null, 'never kept as clean');
  }
  // Remove off: nothing changes, the file is packed as it is.
  process.env.FAKE_PROBE = 'fail';
  const k = service.start({ mediaIds: ids('clip.mp4'), removePersonal: false });
  await until(() => statusOf(k.id) === 'checked', 'packed as it is');
  assert.strictEqual(sha(packed[0].bytes['clip.mp4']), files['clip.mp4'].sha);
  assert.ok(!dumpDb().includes(FOUND), 'no found value in the database');
});

test('Remove with files whose check failed: the first is named and the others counted; with no file names stored the row says how many; a type Vault does not read is no failure', async () => {
  settings.save({ ...ON(), rememberFiles: true });
  const one = service.start({ mediaIds: ids('plain.jpg', 'broken.mp4'), removePersonal: true });
  await until(() => statusOf(one.id) === 'failed', 'failed');
  assert.strictEqual(store.getShare(one.id).last_error, CHECK_FAILED('broken.mp4'));
  process.env.FAKE_PROBE = 'fail';
  const two = service.start({ mediaIds: ids('broken.mp4', 'clip.mp4', 'plain.jpg'), removePersonal: true });
  await until(() => statusOf(two.id) === 'failed', 'failed');
  assert.strictEqual(store.getShare(two.id).last_error, CHECK_FAILED('broken.mp4 and 1 more file'));
  settings.save({ ...ON(), rememberFiles: false });
  const three = service.start({ mediaIds: ids('broken.mp4', 'clip.mp4'), removePersonal: true });
  await until(() => statusOf(three.id) === 'failed', 'failed');
  assert.strictEqual(store.getShare(three.id).last_error, CHECK_FAILED('2 of the files'));
  assert.ok(!JSON.stringify([store.getShare(three.id), store.getFiles(three.id)]).includes('broken'), 'no file name stored for it');
  assert.strictEqual(service.progress(three.id).error, CHECK_FAILED('broken.mp4 and 1 more file'), 'the page still sees the name while Vault runs');
  assert.strictEqual(packed.length, 0, '7-Zip never ran');
  // Not a failure: a type Vault does not read goes in as it is, as step 1 said.
  delete process.env.FAKE_PROBE;
  const four = service.start({ mediaIds: ids('sticker.webp', 'plain.jpg'), removePersonal: true });
  await until(() => statusOf(four.id) === 'checked', 'packed');
  assert.strictEqual(sha(packed[0].bytes['sticker.webp']), files['sticker.webp'].sha);
});

test('Remove: a file that changes after its check and before 7-Zip has read it fails the share', async () => {
  const p = path.join(MEDIA, 'later.jpg');
  fs.writeFileSync(p, BASE_JPEG);
  const mid = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'later.jpg', 'image')").run(p).lastInsertRowid);
  try {
    sevenzipHook = () => { fs.appendFileSync(p, Buffer.from(`added by someone: ${FOUND}`)); };
    const s = service.start({ mediaIds: [mid, files['plain.jpg'].id], removePersonal: true });
    await until(() => statusOf(s.id) === 'failed', 'failed');
    assert.strictEqual(store.getShare(s.id).last_error, 'A picked file changed while this share was being packed, so it was not kept. Nothing was uploaded. Start the share again.');
    assert.strictEqual(store.getShare(s.id).work_dir, null);
    // Remove off does no check at the turn, so there is nothing to compare with.
    sevenzipHook = null;
    const k = service.start({ mediaIds: [mid], removePersonal: false });
    await until(() => statusOf(k.id) === 'checked', 'packed');
  } finally {
    db.get().prepare('DELETE FROM media WHERE id = ?').run(mid);
    fs.rmSync(p, { force: true });
  }
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

/* ── Without ffprobe or ffmpeg ─────────────────────────────────────────── */

// Programs that are not there (meta.js's own seam: no PATH is touched).
const GONE_DIR = path.join(tmp, 'no-tools');
const exeName = (n) => (process.platform === 'win32' ? `${n}.exe` : n);
const MISSING = { probe: path.join(GONE_DIR, exeName('ffprobe')), ffmpeg: path.join(GONE_DIR, exeName('ffmpeg')) };
const FAKE_CMD = { exe: process.execPath, pre: [FAKE] };
const NO_FFMPEG_START = 'Vault can no longer find ffmpeg, which it needs for videos and sound files. Nothing was packed. Look at Personal details again, then press Pack files.';
const NO_FFMPEG_PACK = 'Vault could not find ffmpeg, so it could not remove personal details and this share was not packed. Nothing was uploaded. Start the share again to pack the files as they are.';
const ranFfmpeg = () => fs.existsSync(PROBE_LOG) || fs.existsSync(FF_PID);
const ALL6 = ['holiday.jpg', 'drawing.png', 'plain.jpg', 'broken.mp4', 'clip.mp4', 'sticker.webp'];
/** Packed bytes as a file, checked again the way the share checks (no tools needed for JPEG and PNG). */
async function recheck(bytes, name) {
  const p = path.join(tmp, `again-${crypto.randomBytes(4).toString('hex')}-${name}`);
  fs.writeFileSync(p, bytes);
  try { return await meta.detect(p, { tools: false }); } finally { fs.unlinkSync(p); }
}

test('without ffmpeg: step 1 checks the pictures and leaves every other file as needs-tools; either program missing is enough', async () => {
  const all = ids(...ALL6);
  try { fs.unlinkSync(FF_PID); } catch {}
  assert.strictEqual(service.preview({ mediaIds: all }).personalCheckReady, true, 'both there');
  for (const [what, set] of [['ffprobe', { probe: MISSING.probe }], ['ffmpeg', { ffmpeg: MISSING.ffmpeg }], ['both', MISSING]]) {
    meta._setForTest({ probe: FAKE_CMD, ffmpeg: FAKE_CMD, ...set });
    meta.forget();
    assert.strictEqual(meta.toolsReady(), false, what);
    const p = await call('POST', '/preview', { mediaIds: all });
    assert.strictEqual(p.json.personalCheckReady, false, `${what} missing`);
    const r = await check(all);
    assert.strictEqual(r.tools, false, what);
    assert.strictEqual(r.total, 6);
    assert.deepStrictEqual(r.files.map(f => f.mediaId).sort(), ids('holiday.jpg', 'drawing.png').sort(), 'the pictures with details, found');
    assert.strictEqual(r.personalCount, 2);
    assert.strictEqual(r.failedCount, 0, 'a video left alone is no failed check');
    assert.strictEqual(r.uncheckedCount, 0);
    assert.strictEqual(r.toolsNeededCount, 3, 'broken.mp4, clip.mp4, sticker.webp');
    assert.strictEqual(r.toolsNeededAvCount, 2, 'the two .mp4');
    const flagged = ['holiday.jpg', 'drawing.png'].reduce((n, k) => n + fs.statSync(files[k].path).size, 0);
    assert.strictEqual(r.extraBytes, flagged, 'copies for the pictures only');
  }
  assert.ok(!ranFfmpeg(), 'ffprobe and ffmpeg never ran');
  // With the tools: the full check, as always.
  meta._setForTest({ probe: FAKE_CMD, ffmpeg: FAKE_CMD });
  const full = await check(all);
  assert.deepStrictEqual([full.tools, full.personalCount, full.failedCount, full.uncheckedCount, full.toolsNeededCount], [true, 3, 1, 1, 0]);
  assert.strictEqual((await call('POST', '/preview', { mediaIds: all })).json.personalCheckReady, true, 'read afresh');
});

test('without ffmpeg: the session cache never gives an answer from before the tools came or went', async () => {
  const f = (n) => ({ path: files[n].path, size: fs.statSync(files[n].path).size, mtimeMs: fs.statSync(files[n].path).mtimeMs });
  const probes = () => (fs.existsSync(PROBE_LOG) ? fs.readFileSync(PROBE_LOG, 'utf8').split('\n').filter(Boolean).length : 0);
  // With the tools: the video is read by ffprobe and kept.
  assert.strictEqual((await meta.checkFile(f('clip.mp4'), { tools: true })).status, 'personal');
  assert.strictEqual(probes(), 1);
  assert.strictEqual(meta.cached(f('clip.mp4')).status, 'personal');
  // Without: that answer is not given; the video needs the tools.
  assert.strictEqual(meta.cached(f('clip.mp4'), { tools: false }), null);
  const without = await meta.checkFile(f('clip.mp4'), { tools: false });
  assert.deepStrictEqual([without.status, without.kind, without.findings], ['needs-tools', 'av', []]);
  assert.strictEqual(meta.cached(f('clip.mp4'), { tools: false }).status, 'needs-tools');
  // Back with the tools: 'needs-tools' is never served, ffprobe reads it again.
  assert.strictEqual(meta.cached(f('clip.mp4'), { tools: true }), null);
  assert.strictEqual((await meta.checkFile(f('clip.mp4'), { tools: true })).status, 'personal');
  assert.strictEqual(probes(), 2);
  // A picture's answer does not depend on the tools: kept for both.
  assert.strictEqual((await meta.checkFile(f('holiday.jpg'), { tools: true })).status, 'personal');
  assert.strictEqual(meta.cached(f('holiday.jpg'), { tools: false }).status, 'personal');
  assert.strictEqual(meta.cached(f('holiday.jpg'), { tools: true }).status, 'personal');
  // A non-picture that only ffprobe reads: unchecked with the tools, needs-tools without.
  assert.strictEqual((await meta.checkFile(f('sticker.webp'), { tools: true })).status, 'unchecked');
  assert.strictEqual(meta.cached(f('sticker.webp'), { tools: false }), null);
  assert.deepStrictEqual(await meta.checkFile(f('sticker.webp'), { tools: false }), { status: 'needs-tools', kind: null, findings: [] });
  assert.strictEqual(probes(), 3, 'without the tools nothing was probed');
});

test('without ffmpeg: a program that turns up counts at the next look, with no restart; one that goes stops counting', () => {
  const later = path.join(tmp, 'later');
  fs.mkdirSync(later, { recursive: true });
  const probe = path.join(later, exeName('ffprobe'));
  meta._setForTest({ probe, ffmpeg: FAKE_CMD });
  assert.strictEqual(meta.toolsReady(), false);
  fs.writeFileSync(probe, 'x');
  fs.chmodSync(probe, 0o755);
  assert.strictEqual(meta.toolsReady(), true, 'downloaded: counts at once');
  assert.strictEqual(service.preview({ mediaIds: ids('plain.jpg') }).personalCheckReady, true);
  fs.unlinkSync(probe);
  assert.strictEqual(meta.toolsReady(), false, 'gone: no longer counts');
  fs.mkdirSync(probe);
  assert.strictEqual(meta.toolsReady(), false, 'a folder by that name is no program');
  fs.rmdirSync(probe);
});

test('without ffmpeg: a bare name is looked for where spawn looks, a path as it is', () => {
  const dir = path.join(tmp, 'pathdir');
  const empty = path.join(tmp, 'emptydir');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(empty, { recursive: true });
  const win = process.platform === 'win32';
  const p = path.join(dir, win ? 'ffprobe.exe' : 'ffprobe');
  fs.writeFileSync(p, 'x');
  fs.chmodSync(p, 0o755);
  const there = (exe, PATH, cwd = empty) => meta._programThere(exe, { env: { PATH }, cwd });
  assert.strictEqual(there('ffprobe', [empty, dir].join(path.delimiter)), true, 'on PATH');
  assert.strictEqual(there('ffprobe', `"${dir}"`), true, 'a quoted PATH entry');
  assert.strictEqual(there('ffprobe', `"${dir}`), true, 'a stray leading quote');
  assert.strictEqual(there('ffprobe', `${dir}"`), true, 'a stray trailing quote');
  assert.strictEqual(there('ffprobe', [empty, `"${dir}`].join(path.delimiter)), true, 'a stray quote on a later entry');
  assert.strictEqual(there('ffprobe', empty), false, 'not on PATH');
  assert.strictEqual(there('ffprobe', ''), false, 'no PATH');
  assert.strictEqual(there(p, ''), true, 'a full path');
  assert.strictEqual(there(path.join(empty, 'ffprobe.exe'), dir), false, 'a full path is only looked for there');
  for (const bad of ['', null, undefined, 3, {}, 'ff\0probe']) assert.strictEqual(there(bad, dir), false, String(bad));
  if (win) {
    // spawn runs .com and .exe by a bare name, never .cmd or .bat.
    const cmdOnly = path.join(tmp, 'cmddir');
    fs.mkdirSync(cmdOnly, { recursive: true });
    fs.writeFileSync(path.join(cmdOnly, 'ffmpeg.cmd'), '@echo off');
    fs.writeFileSync(path.join(cmdOnly, 'ffmpeg.bat'), '@echo off');
    assert.strictEqual(there('ffmpeg', cmdOnly), false, '.cmd and .bat do not count');
  } else {
    fs.chmodSync(p, 0o644);
    assert.strictEqual(there('ffprobe', dir), false, 'not executable');
    fs.chmodSync(p, 0o755);
  }
  // A bare name is never looked for in the current folder: spawn does not look there.
  assert.strictEqual(there('ffprobe', empty, dir), false, 'only in the current folder: missing');
  assert.strictEqual(there('ffprobe', '', dir), false);
  // A path with a folder in it is still taken from the current folder, as spawn does.
  assert.strictEqual(there(`.${path.sep}${path.basename(p)}`, '', dir), true);
  // An entry that is there but may not be looked at (an App Execution Alias
  // stub, say) counts; only "no such file" is missing.
  const realStat = fs.statSync;
  const fail = (code) => { fs.statSync = (q, ...a) => { if (path.resolve(String(q)).startsWith(path.resolve(empty))) { const e = new Error(code); e.code = code; throw e; } return realStat(q, ...a); }; };
  try {
    for (const code of ['EACCES', 'EPERM']) {
      fail(code);
      assert.strictEqual(there('ffprobe', empty), true, `${code}: there`);
    }
    for (const code of ['ENOENT', 'ENOTDIR', 'ELOOP']) {
      fail(code);
      assert.strictEqual(there('ffprobe', empty), false, `${code}: missing`);
    }
  } finally {
    fs.statSync = realStat;
  }
});

test('without ffmpeg: Pack files with Remove off packs every file as it is and the share completes; nothing is checked, cleaned or said removed', async () => {
  try { fs.unlinkSync(FF_PID); } catch {}
  meta._setForTest(MISSING);
  const all = ids('holiday.jpg', 'drawing.png', 'clip.mp4', 'broken.mp4', 'sticker.webp');
  const s = await call('POST', '/shares', { mediaIds: all, removePersonal: false });
  assert.strictEqual(s.status, 202, JSON.stringify(s.json));
  const phases = new Set();
  await until(() => {
    const pr = service.progress(s.json.share.id);
    if (pr && pr.packing) phases.add(pr.packing.phase);
    return statusOf(s.json.share.id) === 'checked';
  }, 'packed and checked');
  assert.ok(!phases.has('cleaning'), 'no "Removing personal details" step');
  const rec = packed[0];
  for (const n of ['holiday.jpg', 'drawing.png', 'clip.mp4', 'broken.mp4', 'sticker.webp']) {
    assert.strictEqual(sha(rec.bytes[n]), files[n].sha, `${n}: as it is`);
    assert.ok(rec.lines.includes(files[n].path), `${n}: the original itself, no copy`);
  }
  assert.ok(rec.bytes['holiday.jpg'].includes(Buffer.from(FOUND)), 'the details went with it, as the box said');
  assert.ok(!ranFfmpeg(), 'ffprobe and ffmpeg never ran');
  const row = store.getShare(s.json.share.id);
  assert.strictEqual(row.last_error, null);
  const said = JSON.stringify([service.getShare(s.json.share.id), service.progress(s.json.share.id), row]);
  assert.ok(!/remov|clean|personal/i.test(said), `nothing says removed: ${said}`);
});

test('without ffmpeg, Remove on: the pictures are cleaned for real and every other file goes as it is; the share completes', async () => {
  try { fs.unlinkSync(FF_PID); } catch {}
  meta._setForTest(MISSING);
  await check(ids(...ALL6));
  const s = await call('POST', '/shares', { mediaIds: ids(...ALL6), removePersonal: true, checkedWithoutTools: true });
  assert.strictEqual(s.status, 202, JSON.stringify(s.json));
  await until(() => statusOf(s.json.share.id) === 'checked', 'packed and checked');
  const rec = packed[0];
  const stage = (n) => rec.lines.find(l => path.basename(l) === n);
  for (const n of ['holiday.jpg', 'drawing.png']) {
    assert.notStrictEqual(sha(rec.bytes[n]), files[n].sha, `${n}: its bytes changed`);
    assert.ok(!rec.bytes[n].includes(Buffer.from('Sam')), `${n}: the details are gone`);
    assert.notStrictEqual(path.resolve(stage(n)), path.resolve(files[n].path), `${n}: a cleaned copy`);
    assert.strictEqual((await recheck(rec.bytes[n], n)).status, 'clean', `${n}: checked again, clean`);
  }
  for (const n of ['clip.mp4', 'broken.mp4', 'sticker.webp', 'plain.jpg']) {
    assert.strictEqual(sha(rec.bytes[n]), files[n].sha, `${n}: byte for byte as it is`);
    assert.strictEqual(path.resolve(stage(n)), path.resolve(files[n].path), `${n}: the original itself`);
  }
  assert.ok(rec.bytes['clip.mp4'].includes(Buffer.from('PERSONAL')), 'the video went as it is, as step 1 said');
  assert.ok(!ranFfmpeg(), 'ffprobe and ffmpeg never ran');
  assert.strictEqual(store.getShare(s.json.share.id).last_error, null);
});

test('without ffmpeg, Remove on: a picture whose check or clean fails still stops the share, nothing uploaded', async () => {
  meta._setForTest(MISSING);
  // A JPEG cut short: its check fails.
  addMedia('cut.jpg', jpegWithComment(`Holiday with ${FOUND}`).subarray(0, 30));
  const one = service.start({ mediaIds: ids('cut.jpg', 'clip.mp4'), checkedWithoutTools: true });
  await until(() => statusOf(one.id) === 'failed', 'stopped');
  assert.strictEqual(store.getShare(one.id).last_error, CHECK_FAILED('cut.jpg'));
  assert.strictEqual(packed.length, 0);
  // A picture whose cleaned copy cannot be made.
  const real = meta.cleanCopy;
  meta.cleanCopy = async () => { throw Object.assign(new Error('x'), { code: 'CLEAN_FAILED' }); };
  try {
    const two = service.start({ mediaIds: ids('holiday.jpg', 'clip.mp4'), checkedWithoutTools: true });
    await until(() => statusOf(two.id) === 'failed', 'stopped');
    assert.strictEqual(store.getShare(two.id).last_error, 'Vault could not remove personal details from holiday.jpg, so this share was not packed. Nothing was uploaded. Your own file was not changed.');
  } finally {
    meta.cleanCopy = real;
  }
  assert.strictEqual(packed.length, 0, '7-Zip never ran');
});

test('stale page or odd body: with ffmpeg missing, Remove on is refused unless step 1 says exactly that it was checked without it', async () => {
  try { fs.unlinkSync(FF_PID); } catch {}
  for (const set of [MISSING, { probe: MISSING.probe }, { ffmpeg: MISSING.ffmpeg }]) {
    meta._setForTest({ probe: FAKE_CMD, ffmpeg: FAKE_CMD, ...set });
    for (const v of [undefined, false, null, 'true', 1, {}]) {
      for (const remove of [undefined, true, null, 'false', 0]) {
        const body = { mediaIds: ids('holiday.jpg', 'clip.mp4') };
        if (v !== undefined) body.checkedWithoutTools = v;
        if (remove !== undefined) body.removePersonal = remove;
        const s = await call('POST', '/shares', body);
        assert.strictEqual(s.status, 409, JSON.stringify(body));
        assert.deepStrictEqual(s.json, { error: NO_FFMPEG_START, code: 'PERSONAL_CHECK_OFF' });
      }
    }
    assert.throws(() => service.start({ mediaIds: ids('holiday.jpg') }), (e) => e.code === 'PERSONAL_CHECK_OFF');
  }
  assert.strictEqual(store.listShares().length, 0, 'no share stored');
  assert.strictEqual(packed.length, 0);
  assert.ok(!ranFfmpeg());
  // Remove off goes through whatever else is said; exactly true goes through with Remove on.
  meta._setForTest(MISSING);
  for (const body of [{ removePersonal: false }, { removePersonal: false, checkedWithoutTools: 'yes' }, { checkedWithoutTools: true }]) {
    const s = await call('POST', '/shares', { mediaIds: ids('plain.jpg'), ...body });
    assert.strictEqual(s.status, 202, JSON.stringify(body));
    await until(() => statusOf(s.json.share.id) === 'checked', 'packed');
  }
});

test('the pin: checked without ffmpeg and it turns up before the turn (waiting or not): pictures cleaned, every other file as step 1 said', async () => {
  // Not waiting: the tools are there at start, step 1 was checked without them.
  try { fs.unlinkSync(PROBE_LOG); } catch {}
  const now = service.start({ mediaIds: ids('holiday.jpg', 'clip.mp4'), checkedWithoutTools: true });
  await until(() => statusOf(now.id) === 'checked', 'packed');
  assert.ok(!packed[0].bytes['holiday.jpg'].includes(Buffer.from('Sam')), 'the picture cleaned');
  assert.strictEqual(sha(packed[0].bytes['clip.mp4']), files['clip.mp4'].sha, 'the video as it is');
  assert.ok(!fs.existsSync(PROBE_LOG), 'never probed');
  // Waiting its turn: missing at start, there at the turn.
  const a = await startCleaning('hang');   // packing: the next share waits its turn
  try { fs.unlinkSync(PROBE_LOG); } catch {}
  meta._setForTest(MISSING);
  const b = service.start({ mediaIds: ids('holiday.jpg', 'clip.mp4'), checkedWithoutTools: true });
  assert.strictEqual(b.status, 'queued');
  meta._setForTest({ probe: FAKE_CMD, ffmpeg: FAKE_CMD });   // downloaded meanwhile
  await service.cancel(a.s.id);
  await until(() => !alive(a.pid), 'the first share\'s ffmpeg stopped');
  await until(() => statusOf(b.id) === 'checked', 'the waiting share packed');
  const rec = packed[packed.length - 1];
  assert.ok(!rec.bytes['holiday.jpg'].includes(Buffer.from('Sam')), 'the picture cleaned');
  assert.strictEqual(sha(rec.bytes['clip.mp4']), files['clip.mp4'].sha, 'the video as it is, as step 1 showed');
  assert.ok(!fs.existsSync(PROBE_LOG), 'not probed at its turn');
});

test('with ffmpeg there and nothing said about it, everything is checked and cleaned as before', async () => {
  const s = await call('POST', '/shares', { mediaIds: ids('holiday.jpg', 'clip.mp4') });
  assert.strictEqual(s.status, 202);
  await until(() => statusOf(s.json.share.id) === 'checked', 'packed');
  assert.ok(!packed[0].bytes['holiday.jpg'].includes(Buffer.from('Sam')));
  assert.ok(!packed[0].bytes['clip.mp4'].includes(Buffer.from('PERSONAL')), 'the video cleaned too');
  // The step 1 answer carries the new fields, at their "with the tools" values.
  const r = await check(ids('holiday.jpg', 'clip.mp4'));
  assert.deepStrictEqual([r.tools, r.toolsNeededCount, r.toolsNeededAvCount], [true, 0, 0]);
});

test('ffmpeg gone before the turn of a share that was to be cleaned: it stops with nothing packed or uploaded, never packed as is', async () => {
  const a = await startCleaning('hang');
  const b = service.start({ mediaIds: ids('holiday.jpg', 'plain.jpg'), removePersonal: true });
  assert.strictEqual(b.status, 'queued');
  meta._setForTest(MISSING);
  await service.cancel(a.s.id);
  await until(() => !alive(a.pid), 'the first share\'s ffmpeg stopped');
  await until(() => statusOf(b.id) === 'failed', 'the waiting share stopped');
  const row = store.getShare(b.id);
  assert.strictEqual(row.last_error, NO_FFMPEG_PACK);
  assert.strictEqual(row.work_dir, null, 'its work folder is gone');
  assert.strictEqual(packed.length, 0, '7-Zip never ran');
  assert.deepStrictEqual(store.getParts(b.id), []);
});
