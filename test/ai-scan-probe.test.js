/**
 * The vault's scan probe (server/index.js _vaultScanProbe) against the real
 * import queue in every AI scan mode. The probe guards the lock, the autolock
 * and the password rekey (lib/vault.js _rekey / changePassword), so a scan
 * that is actually running must always count:
 *
 * - switching Off with files in flight: the probe stays true (and a password
 *   set or change is refused) until they have finished, then false
 * - Auto held for playback with nothing in flight: false
 * - Auto cutting a scan off for playback: true until the scan's pipeline has
 *   really returned (here, until the stubbed ffmpeg / whisper stop is let go),
 *   for the import line and for a one-file rescan alike
 *
 * processFile is stubbed with a scan the test holds open, and that, once cut,
 * keeps unwinding until the test lets it.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-aiscan-probe-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;
delete process.env.AI_MODEL;

const db = require('../lib/database');
const vault = require('../lib/vault');
const slots = require('../lib/ai-slots');
const llm = require('../lib/llm-client');
const scanModel = require('../lib/scan-model');
const queue = require('../lib/import-queue');
const mode = require('../lib/ai-scan-mode');
const playback = require('../lib/playback-activity');
const scan = require('../commands/scan');
const { app, _vaultScanProbe } = require('../server/index');

const GB = 1024 ** 3;
let lm;            // stub LM Studio: the queue's model check must find a model
let lmBase;
let server;        // the Vault app, for the one-file rescan route
let base;

/* Every scan processFile was asked for: { path, aborted, finish(), unwind() }.
   finish() lets a scan complete; once its signal aborts, the scan keeps
   "unwinding" (an ffmpeg child or the whisper sidecar being stopped) until
   unwind() lets it throw the cut-off error. */
const scans = [];

test.before(async () => {
  db.init();
  lm = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'vis', type: 'vlm', state: 'loaded' }] }));
  });
  await new Promise(r => lm.listen(0, '127.0.0.1', r));
  lmBase = `http://127.0.0.1:${lm.address().port}/v1/chat/completions`;
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // What server start does (server/index.js start).
  vault.registerScanProbe(_vaultScanProbe);

  scan.processFile = (file) => {
    const signal = slots.scanSignal();
    const rec = { path: file.path, aborted: false, settled: false };
    scans.push(rec);
    return new Promise((resolve, reject) => {
      rec.finish = () => {
        if (rec.settled) return;
        rec.settled = true;
        db.get().prepare('UPDATE media SET processing_error = NULL, description = ? WHERE filepath = ?').run('ok', file.path);
        resolve({ success: true });
      };
      rec.unwind = () => {
        if (rec.settled) return;
        rec.settled = true;
        reject(slots.cutError());
      };
      if (signal) signal.addEventListener('abort', () => { rec.aborted = true; }, { once: true });
    });
  };
});

test.after(async () => {
  await drain();
  scanModel.stop();
  slots.stop();
  playback._reset();
  await new Promise(r => server.close(r));
  await new Promise(r => lm.close(r));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let seq = 0;
function addFile() {
  const name = `p${++seq}.mp4`;
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, 'video', 'unscanned')")
    .run(fp, name).lastInsertRowid);
  return { id, filepath: fp, filename: name, mediaType: 'video' };
}

async function drain() {
  mode.set('on');
  playback._reset();
  queue.cancel();
  for (const s of scans) { if (s.aborted) s.unwind(); else s.finish(); }
  await until(() => !queue.inFlight(), 5000);
  queue.cancel();
}

async function fresh(m) {
  await drain();
  scans.length = 0;
  playback._setTimings({ staleMs: playback.STALE_MS, pauseGraceMs: playback.PAUSE_GRACE_MS });
  queue._setTimings({ settleMs: 15_000 });
  slots._reset([lmBase]);
  llm.setSessionModel(null);
  scanModel._reset();
  scanModel._setDeps({
    listModels: async () => [{ modelKey: 'vis', sizeBytes: GB, type: 'llm', vision: true }],
    readGpu: async () => ({ freeBytes: 20 * GB, totalBytes: 24 * GB, gpus: 1 }),
    canLoad: () => ({ ok: true }),
    psRows: async () => [],
    load: async () => ({ ok: true }),
    refresh: () => slots.refresh({ force: true }),
    loadedFamilies: () => slots.activeFamilies(),
    isLocked: () => false,
  });
  scanModel.setSettings({ scanModel: 'vis', whenNotLoaded: 'room', gpuFreeForWatch: false });
  await slots.refresh({ force: true });
  mode.set(m);
}

/** setPassword (plaintext library) and changePassword (as if encrypted) are both refused. */
async function assertRekeyRefused(why) {
  await assert.rejects(vault.setPassword('probe-test-pass'), { code: 'VAULT_SCAN_ACTIVE' }, `set password: ${why}`);
  const orig = vault.isEncrypted;
  vault.isEncrypted = () => true;
  try {
    await assert.rejects(vault.changePassword('whatever', 'probe-test-pass-2'), { code: 'VAULT_SCAN_ACTIVE' }, `change password: ${why}`);
  } finally {
    vault.isEncrypted = orig;
  }
  assert.strictEqual(vault.isEncrypted(), false, 'the library was not encrypted');
}

test('switching Off with scans in flight: the probe stays true until they finish, then false', async () => {
  await fresh('on');
  queue.setConcurrency(2);
  const files = [addFile(), addFile(), addFile()];
  for (const f of files) queue.enqueue(f);
  await until(() => scans.length === 2);
  assert.strictEqual(_vaultScanProbe(), true);

  mode.set('off');
  assert.strictEqual(queue.status().pendingCount, 0, 'the waiting file is dropped');
  assert.strictEqual(queue.inFlight(), true, 'two files are still running');
  assert.strictEqual(_vaultScanProbe(), true, 'a file let finish after Off still counts');
  assert.strictEqual(vault.scanActive(), true);
  await assertRekeyRefused('two scans still running after Off');

  scans[0].finish();
  await until(() => queue.status().active.length === 1);
  assert.strictEqual(_vaultScanProbe(), true, 'one still running');
  await assertRekeyRefused('one scan still running after Off');

  scans[1].finish();
  await until(() => !queue.inFlight());
  assert.strictEqual(_vaultScanProbe(), false, 'nothing running: Off holds nothing');
  assert.strictEqual(vault.scanActive(), false);
  assert.strictEqual(scans.length, 2, 'nothing new started');
  queue.setWorkersPerInstance(2);
});

test('Auto held for playback with nothing in flight: the probe reports idle', async () => {
  await fresh('auto');
  playback.report('tab:probe01', 'playing');
  const f = addFile();
  queue.enqueue(f);
  await sleep(50);
  assert.strictEqual(scans.length, 0, 'nothing starts while something plays');
  assert.strictEqual(queue.status().pendingCount, 1, 'the file waits in the line');
  assert.strictEqual(queue.inFlight(), false);
  assert.strictEqual(_vaultScanProbe(), false, 'a held line neither refuses a lock nor keeps the autolock open');
  assert.strictEqual(vault.scanActive(), false);
});

test('Auto cut-off still unwinding: the probe stays true until the scan has returned', async () => {
  await fresh('auto');
  queue.setConcurrency(1);
  const [a, b] = [addFile(), addFile()];
  queue.enqueue(a);
  queue.enqueue(b);
  await until(() => scans.length === 1);
  playback.report('tab:probe02', 'playing');
  assert.strictEqual(scans[0].aborted, true, 'the scan was told to stop at once');

  // The abort has landed but the pipeline is still stopping its children.
  await sleep(50);
  assert.strictEqual(queue.inFlight(), true, 'still unwinding');
  assert.strictEqual(_vaultScanProbe(), true, 'a cut that has not settled still counts');
  assert.strictEqual(vault.scanActive(), true);
  await assertRekeyRefused('a cut-off scan still unwinding');

  scans[0].unwind();
  await until(() => !queue.inFlight());
  assert.deepStrictEqual(queue.status().pending.map(p => p.id), [a.id, b.id], 'back at the front of the line');
  assert.strictEqual(_vaultScanProbe(), false, 'settled and held: idle');
  assert.strictEqual(vault.scanActive(), false);
  assert.strictEqual(scans.length, 1, 'nothing new started while playing');
  queue.setWorkersPerInstance(2);
});

test('Auto cut-off of a one-file rescan: the probe stays true until the rescan has returned', async () => {
  await fresh('auto');
  const f = addFile();
  const pending = fetch(`${base}/api/media/${f.id}/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await until(() => scans.length === 1);
  assert.strictEqual(_vaultScanProbe(), true, 'a rescan counts');
  playback.report('tab:probe03', 'playing');
  assert.strictEqual(scans[0].aborted, true);
  await sleep(50);
  assert.strictEqual(_vaultScanProbe(), true, 'the cut rescan is still unwinding');
  await assertRekeyRefused('a cut-off rescan still unwinding');

  scans[0].unwind();
  const res = await pending;
  assert.strictEqual(res.status, 409);
  assert.strictEqual((await res.json()).code, 'AI_SCAN_CUT_FOR_PLAYBACK');
  assert.strictEqual(_vaultScanProbe(), false, 'returned: nothing left scanning');
  assert.strictEqual(vault.scanActive(), false);
});

test('switching Off with a one-file rescan running: it counts until it finishes', async () => {
  await fresh('on');
  const f = addFile();
  const pending = fetch(`${base}/api/media/${f.id}/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await until(() => scans.length === 1);
  mode.set('off');
  assert.strictEqual(_vaultScanProbe(), true, 'the rescan is still running');
  await assertRekeyRefused('a rescan still running after Off');
  scans[0].finish();
  const res = await pending;
  assert.strictEqual(res.status, 200);
  assert.strictEqual(_vaultScanProbe(), false);
});
