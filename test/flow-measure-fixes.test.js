/**
 * Flow measuring, when things go wrong (lib/flow/service.js, store.js,
 * server/flow-routes.js, lib/audio/dsp.js):
 *   - Flow's worker failing is not the file's fault: nothing saved, the file
 *     left for later (not a hot loop), Try again asks it again;
 *   - 3.10.0-beta.1's "Flow worker ..." rows are deleted when the database
 *     opens, so those files are measured again;
 *   - why a file failed: stored with a code, said in plain words to the page
 *     (features[].reason) and in the server's console (at most 20 a run);
 *   - Measure again ({ all: true }): every file again, measured ones keep
 *     their numbers until the new measurement succeeds;
 *   - ffmpeg / ffprobe that cannot be started say so (SPAWN).
 * Measuring is faked (configure({ measure })): no ffmpeg runs, except in the
 * SPAWN test, which points at a program that is not there.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-flow-fixes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const store = require('../lib/flow/store');
const analyze = require('../lib/flow/analyze');
const svc = require('../lib/flow/service');
const { app } = require('../server/index');

let server, base;
const SRC = store.srcOf({ filesize_bytes: 1000, file_mtime_ms: 5 });

// What the fake measure does per file name: 'ok' (energy 0.5), 'ok2' (0.8), or an error code.
const plan = new Map();
const calls = [];
async function fakeMeasure(filePath) {
  const name = path.basename(filePath);
  calls.push(name);
  const what = plan.get(name) || 'ok';
  if (what === 'ok' || what === 'ok2') {
    const e = what === 'ok' ? 0.5 : 0.8;
    return { version: analyze.VERSION, lufs: -20, peak_db: -3, has_music: 1, no_audio: 0, bpm_start: 120, bpm_mid: 120, bpm_end: 120, bpm_conf: 0.9, e_start: e, e_mid: e, e_end: e, env: null, ms: 1 };
  }
  const text = {
    WORKER_ERROR: "Flow worker failed: Cannot find module 'X:\\Vault\\lib\\flow\\worker.js'",
    WORKER_EXIT: 'Flow worker stopped',
    HUNG: 'Flow worker stopped answering',
    DECODE: 'Invalid data found when processing input',
    TIMEOUT: 'ffmpeg took too long',
    SPAWN: "couldn't run ffprobe (ENOENT)",
  }[what];
  throw Object.assign(new Error(text), { code: what });
}

function addFiles(n, prefix) {
  const d = db.get();
  const ins = d.prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds, filesize_bytes, file_mtime_ms) VALUES (?, ?, 'video', 60, 1000, 5)");
  const ids = [];
  for (let i = 0; i < n; i++) {
    const name = `${prefix}${i}.mp4`;
    const p = path.join(tmp, name);
    fs.writeFileSync(p, 'x');
    ids.push(Number(ins.run(p, name).lastInsertRowid));
  }
  const cid = db.createCollection(`${prefix} ${Date.now()}`).id;
  db.addToCollection(cid, ids);
  return { cid, ids, names: ids.map((_, i) => `${prefix}${i}.mp4`) };
}

const idle = async () => {
  const t0 = Date.now();
  while (svc._queue().status().state !== 'idle' && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 10));
  svc._flushQuick();
};
const counts = async (cid) => {
  await new Promise(r => setTimeout(r, 550));             // the counts cache
  return (await (await get(`/api/flow/status?collection=${cid}`)).json()).collection;
};
const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const measure = async (cid, body) => (await post(`/api/flow/collections/${cid}/measure`, body)).json();
const row = (id) => db.get().prepare('SELECT * FROM media_flow WHERE media_id = ?').get(id);

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  await new Promise(r => setImmediate(r));              // server/index.js configure()'s own setImmediate
  svc.configure({ measure: fakeMeasure });
});
test.after(async () => {
  svc.cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('beta.1 leftovers: "Flow worker ..." failures are deleted when the database opens; other rows stay', () => {
  const { ids } = addFiles(5, 'left');
  const d = db.get();
  store.save(d, ids[0], SRC, null, { error: "Flow worker failed: Cannot find module 'G:\\!Vault\\lib\\flow\\worker.js'" });
  store.save(d, ids[1], SRC, null, { error: 'Flow worker stopped' });
  store.save(d, ids[2], SRC, null, { error: 'Flow worker stopped answering' });
  store.save(d, ids[3], SRC, null, { error: 'Invalid data found when processing input', errorCode: 'DECODE' });
  store.save(d, ids[4], SRC, { lufs: -20, has_music: 1, e_start: 0.4, e_mid: 0.4, e_end: 0.4 });
  // What db.init() runs on every open.
  store.ensureSchema(d);
  assert.strictEqual(row(ids[0]), undefined);
  assert.strictEqual(row(ids[1]), undefined);
  assert.strictEqual(row(ids[2]), undefined);
  assert.strictEqual(row(ids[3]).error_code, 'DECODE');
  assert.strictEqual(row(ids[4]).lufs, -20);
  assert.strictEqual(store.purgeWorkerFailures(d), 0);
});

test('an older media_flow (no error_code) gets the column, and its rows survive', () => {
  const Database = require('better-sqlite3-multiple-ciphers');
  const old = new Database(path.join(tmp, 'old.db'));
  old.exec(`CREATE TABLE media_flow (media_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, src TEXT, lufs REAL, peak_db REAL,
    has_music INTEGER NOT NULL DEFAULT 0, no_audio INTEGER NOT NULL DEFAULT 0, bpm_start REAL, bpm_mid REAL, bpm_end REAL, bpm_conf REAL,
    e_start REAL, e_mid REAL, e_end REAL, env TEXT, measured_at INTEGER, ms INTEGER, error TEXT)`);
  old.prepare("INSERT INTO media_flow (media_id, version, src, error) VALUES (1, 4, 'a', 'Flow worker stopped'), (2, 4, 'a', 'Invalid data')").run();
  store.ensureSchema(old);
  assert.ok(old.prepare('PRAGMA table_info(media_flow)').all().some(c => c.name === 'error_code'));
  assert.deepStrictEqual(old.prepare('SELECT media_id, error FROM media_flow').all(), [{ media_id: 2, error: 'Invalid data' }]);
  old.close();
});

test("Flow's worker failing is not the file's fault: nothing saved, left for later, Try again asks again", async () => {
  const { cid, ids, names } = addFiles(3, 'wk');
  plan.set(names[0], 'ok');
  plan.set(names[1], 'WORKER_ERROR');
  plan.set(names[2], 'HUNG');
  assert.strictEqual((await measure(cid)).added, 3);
  await idle();
  assert.strictEqual(row(ids[0]).error, null);
  assert.strictEqual(row(ids[1]), undefined, 'no failure saved for the worker failing');
  assert.strictEqual(row(ids[2]), undefined, 'nor for it hanging');
  let c = await counts(cid);
  assert.strictEqual(c.measured, 1);
  assert.strictEqual(c.failed, 0);
  assert.strictEqual(c.left, 2);
  const s = await (await get('/api/flow/status')).json();
  assert.match(s.workerError, /Flow worker stopped answering/);
  // Not a hot loop: opening the collection again does not ask for them this run ...
  calls.length = 0;
  assert.strictEqual((await measure(cid)).added, 0);
  await idle();
  assert.deepStrictEqual(calls, []);
  // ... Try again (or Measure the rest) does, and they are measured once the worker works.
  plan.set(names[1], 'ok');
  plan.set(names[2], 'ok');
  assert.strictEqual((await measure(cid, { retry: true })).added, 2);
  await idle();
  c = await counts(cid);
  assert.strictEqual(c.measured, 3);
  assert.strictEqual((await (await get('/api/flow/status')).json()).workerError, null, 'cleared once a file is measured');
});

test('a measured file keeps its numbers when the worker fails on measuring it again', async () => {
  const { cid, ids, names } = addFiles(1, 'wkeep');
  await measure(cid);
  await idle();
  plan.set(names[0], 'WORKER_EXIT');
  await measure(cid, { all: true });
  await idle();
  assert.strictEqual(row(ids[0]).error, null);
  assert.strictEqual(row(ids[0]).e_mid, 0.5);
});

test('why: the code is stored, and the page gets plain words and the raw text', async () => {
  const { cid, ids, names } = addFiles(4, 'why');
  plan.set(names[0], 'DECODE');
  plan.set(names[1], 'TIMEOUT');
  plan.set(names[2], 'SPAWN');
  plan.set(names[3], 'ok');
  // And one that is not on disk.
  fs.rmSync(path.join(tmp, names[3]));
  await measure(cid);
  await idle();
  assert.strictEqual(row(ids[0]).error_code, 'DECODE');
  assert.strictEqual(row(ids[3]).error_code, 'MISSING');
  await new Promise(r => setTimeout(r, 550));             // the counts cache
  const j = await (await get(`/api/flow/collections/${cid}`)).json();
  const by = new Map(j.features.map(f => [f.id, f]));
  assert.strictEqual(by.get(ids[0]).reason, "ffmpeg couldn't read it: Invalid data found when processing input");
  assert.strictEqual(by.get(ids[0]).error, 'Invalid data found when processing input');
  assert.strictEqual(by.get(ids[1]).reason, 'it took too long to read');
  assert.strictEqual(by.get(ids[2]).reason, "Vault couldn't run ffprobe");
  assert.match(by.get(ids[3]).reason, /^the file is missing/);
  assert.strictEqual(j.counts.failed, 4);
});

test('failReason: plain words for each kind, and for older rows with no code, from their text', () => {
  const r = svc.failReason;
  assert.strictEqual(r('MISSING', 'The file is not where the library says it is.'), 'the file is missing (not where the library says it is)');
  assert.strictEqual(r(null, 'The file is not where the library says it is.'), 'the file is missing (not where the library says it is)');
  assert.strictEqual(r('SPAWN', "couldn't run ffmpeg (ENOENT)"), "Vault couldn't run ffmpeg");
  assert.strictEqual(r(null, 'spawn ffprobe ENOENT'), "Vault couldn't run ffprobe");
  assert.strictEqual(r(null, 'spawn C:\\Vault\\ffmpeg.exe EACCES'), "Vault couldn't run ffmpeg");
  assert.strictEqual(r('TIMEOUT', 'ffprobe took too long'), 'it took too long to read');
  assert.strictEqual(r(null, 'ffmpeg took too long'), 'it took too long to read');
  assert.strictEqual(r('DECODE', 'moov atom not found'), "ffmpeg couldn't read it: moov atom not found");
  assert.match(r(null, 'Flow worker stopped'), /^Flow's measuring stopped working/);
  assert.strictEqual(r(null, 'moov atom not found'), 'moov atom not found', 'an older row: its own text');
  assert.strictEqual(r(null, ''), 'unknown error');
});

test("the console: a line for each file that couldn't be measured, at most 20 a run, then one line for the rest", async () => {
  const { cid, names } = addFiles(25, 'logx');
  for (const n of names) plan.set(n, 'DECODE');
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await measure(cid);
    await idle();
  } finally { console.warn = warn; }
  const each = lines.filter(l => l.startsWith("[Flow] couldn't measure "));
  assert.strictEqual(each.length, svc.LOG_MAX);
  assert.strictEqual(each[0], "[Flow] couldn't measure logx0.mp4: ffmpeg couldn't read it: Invalid data found when processing input");
  assert.deepStrictEqual(lines.filter(l => /more files couldn't be measured/.test(l)), ["[Flow] 5 more files couldn't be measured (only the first 20 are listed)"]);
  // A new run starts counting again.
  lines.length = 0;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    await measure(cid, { retry: true });
    await idle();
  } finally { console.warn = warn; }
  assert.strictEqual(lines.filter(l => l.startsWith("[Flow] couldn't measure ")).length, svc.LOG_MAX);
});

test('Measure again: every file again; measured ones keep their numbers until the new measurement succeeds', async () => {
  const { cid, ids, names } = addFiles(4, 'again');
  plan.set(names[3], 'DECODE');
  await measure(cid);
  await idle();
  let c = await counts(cid);
  assert.strictEqual(c.measured, 3);
  assert.strictEqual(c.failed, 1);
  // Without all, nothing is asked (everything is measured or failed).
  assert.strictEqual((await measure(cid)).added, 0);

  // The new measurement: file 0 differs, file 1 fails (keeps its numbers), file 3 now works.
  plan.set(names[0], 'ok2');
  plan.set(names[1], 'DECODE');
  plan.set(names[3], 'ok');
  // Held while the page looks: counts during the run.
  let release;
  const gate = new Promise(r => { release = r; });
  svc.configure({ measure: async (p, o) => { await gate; return fakeMeasure(p, o); } });
  try {
    const r = await measure(cid, { all: true });
    assert.strictEqual(r.added, 4);
    c = await counts(cid);
    assert.strictEqual(c.queued, 4);
    assert.strictEqual(c.again, 3, 'the measured ones');
    assert.strictEqual(c.queuedFailed, 1, 'the failed one, tried again');
    assert.strictEqual(c.measured, 3, 'numbers kept meanwhile');
    release();
    await idle();
  } finally { svc.configure({ measure: fakeMeasure }); }
  assert.strictEqual(row(ids[0]).e_mid, 0.8, 'measured again');
  assert.strictEqual(row(ids[1]).error, null, 'its new measurement failed: the numbers stay');
  assert.strictEqual(row(ids[1]).e_mid, 0.5);
  assert.strictEqual(row(ids[3]).error, null);
  c = await counts(cid);
  assert.strictEqual(c.measured, 4);
  assert.strictEqual(c.failed, 0);
  assert.strictEqual(c.kept, 1, 'counted as kept its numbers');
  assert.strictEqual(c.queued, 0);
  // Try again asks the kept one once more.
  plan.set(names[1], 'ok2');
  assert.strictEqual((await measure(cid, { retry: true })).added, 1);
  await idle();
  assert.strictEqual(row(ids[1]).e_mid, 0.8);
  assert.strictEqual((await counts(cid)).kept, 0);
});

test('Try again: the files tried again show as queued (queuedFailed) while it runs', async () => {
  const { cid, names } = addFiles(2, 'retryq');
  for (const n of names) plan.set(n, 'TIMEOUT');
  await measure(cid);
  await idle();
  let release;
  const gate = new Promise(r => { release = r; });
  svc.configure({ measure: async (p, o) => { await gate; return fakeMeasure(p, o); } });
  try {
    for (const n of names) plan.set(n, 'ok');
    assert.strictEqual((await measure(cid, { retry: true })).added, 2);
    const c = await counts(cid);
    assert.strictEqual(c.failed, 2);
    assert.strictEqual(c.queuedFailed, 2);
    assert.strictEqual(c.again, 0);
    release();
    await idle();
  } finally { svc.configure({ measure: fakeMeasure }); }
  const c = await counts(cid);
  assert.strictEqual(c.measured, 2);
  assert.strictEqual(c.queued, 0);
});

test('ffmpeg or ffprobe that cannot be started: code SPAWN, said as such (not as a file ffmpeg could not read)', async () => {
  const locate = require('../lib/ffmpeg-locate');
  const dsp = require('../lib/audio/dsp');
  const real = locate.resolve;
  const f = path.join(tmp, 'spawn.wav');
  fs.writeFileSync(f, 'x');
  locate.resolve = () => path.join(tmp, 'no-such-dir', 'ffmissing.exe');
  try {
    await assert.rejects(dsp.probeAudio(f), (e) => e.code === 'SPAWN' && /^couldn't run ffprobe \(ENOENT\)$/.test(e.message));
    await assert.rejects(dsp.extractPCM(f, { duration: 1 }), (e) => e.code === 'SPAWN' && /^couldn't run ffmpeg \(ENOENT\)$/.test(e.message));
  } finally { locate.resolve = real; }
});

const haveFfprobe = require('node:child_process').spawnSync('ffprobe', ['-version']).status === 0;
test('a file ffprobe cannot read: DECODE with ffprobe\'s own last line, not a generic failure', { skip: !haveFfprobe && 'ffprobe not on PATH' }, async () => {
  const dsp = require('../lib/audio/dsp');
  const f = path.join(tmp, 'junk.mp4');
  fs.writeFileSync(f, Buffer.alloc(4096, 7));
  await assert.rejects(dsp.probeAudio(f), (e) => {
    assert.strictEqual(e.code, 'DECODE');
    assert.match(e.message, /Invalid data|could not find|moov atom/i);
    assert.doesNotMatch(e.message, /^ffprobe failed/);
    return true;
  });
});
