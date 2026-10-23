/**
 * The import queue waiting for the scan model (lib/import-queue.js with
 * lib/scan-model.js), against a stub LM Studio (/api/v0/models with `state`)
 * and a stubbed processFile, so no real model or scan is involved:
 *
 * - waiting is not failing: nothing dispatched, no processing_error, not
 *   counted as failed, and the files start by themselves when the model shows
 * - "Load it if there is room": Vault loads the scan model and the files start
 * - a model that dies mid-run is a wait (the old halt), with a cool-down, and
 *   a file that keeps killing it is still blamed after three strikes
 * - "Only scan watched folders when the GPU is free" holds only those files
 * - failures of a run are kept by id until the panel is closed
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-scanwait-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
delete process.env.VAULT_DB_PASSWORD;
delete process.env.AI_MODEL;

const db = require('../lib/database');
const slots = require('../lib/ai-slots');
const llm = require('../lib/llm-client');
const scanModel = require('../lib/scan-model');
const queue = require('../lib/import-queue');
const scan = require('../commands/scan');

const GB = 1024 ** 3;
let served = [];                 // [{ id, type }] loaded in the stub LM Studio
let server;
let base;
let up = true;                   // false: the stub refuses every request

const calls = [];                // files processFile was asked to scan
let outcome = () => ({ success: true });
const targets = [];               // where each scan's requests would go, seen from inside the scan

test.before(async () => {
  db.init();
  server = http.createServer((req, res) => {
    if (!up) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/api/v0/models')) {
      res.end(JSON.stringify({ data: [
        ...served.map(m => ({ id: m.id, type: m.type === undefined ? 'vlm' : m.type, state: 'loaded' })),
        { id: 'on-disk-only', type: 'vlm', state: 'not-loaded' },
      ] }));
    } else {
      res.end(JSON.stringify({ data: [...served.map(m => ({ id: m.id })), { id: 'on-disk-only' }] }));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  scan.processFile = async (file) => {
    calls.push(file.path);
    targets.push(llm.resolveTarget().family);
    return outcome(file);
  };
});

test.after(async () => {
  queue.cancel();
  scanModel.stop();
  llm.setSessionModel(null);
  await new Promise(r => server.close(r));
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

let seq = 0;
function addFile(extra = {}) {
  const name = `f${++seq}.mp4`;
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, 'video', 'unscanned')")
    .run(fp, name).lastInsertRowid);
  return { id, filepath: fp, filename: name, mediaType: 'video', ...extra };
}
const errorOf = (id) => db.get().prepare('SELECT processing_error FROM media WHERE id = ?').get(id).processing_error;

async function loaded(list) {
  served = list.map(m => (typeof m === 'string' ? { id: m } : m));
  await slots.refresh({ force: true });
}

/** A fresh queue and LM Studio picture, with the scan model chosen. */
async function fresh({ settings = {}, deps = {} } = {}) {
  queue.cancel();
  calls.length = 0;
  targets.length = 0;
  outcome = () => ({ success: true });
  up = true;
  served = [];
  slots._reset([base]);
  llm.setSessionModel(null);
  scanModel._reset();
  scanModel._setDeps({
    listModels: async () => [{ modelKey: 'vis', sizeBytes: GB, type: 'llm', vision: true }],
    readGpu: async () => ({ freeBytes: 20 * GB, totalBytes: 24 * GB, gpus: 1 }),
    canLoad: () => ({ ok: true }),
    psRows: async () => [],
    load: async () => ({ ok: false, error: 'no loading in this test' }),
    refresh: () => slots.refresh({ force: true }),
    loadedFamilies: () => slots.activeFamilies(),
    isLocked: () => false,
    ...deps,
  });
  scanModel.setSettings({ scanModel: 'vis', whenNotLoaded: 'wait', gpuFreeForWatch: false, ...settings });
}

/* ── Waiting is not failing ────────────────────────────────────────────── */

test('scan model not loaded: files wait, nothing fails, nothing is stamped', async () => {
  await fresh();
  await loaded([{ id: 'big-text', type: 'llm' }]);
  const f = addFile();
  queue.enqueue(f);
  await until(() => queue.status().waiting && queue.status().waiting.code === 'policy-wait');
  const s = queue.status();
  assert.strictEqual(s.pausedBy, 'waiting');
  assert.strictEqual(s.waiting.count, 1);
  assert.strictEqual(s.waiting.code, 'policy-wait');
  assert.match(s.waiting.reason, /vis is not loaded/);
  assert.strictEqual(s.failed, 0, 'waiting is not failed');
  assert.strictEqual(s.active.length, 0);
  assert.strictEqual(calls.length, 0, 'nothing was sent to a model that is not there');
  assert.strictEqual(errorOf(f.id), 'unscanned', 'no processing_error');
  assert.strictEqual(queue.isActive(), false, 'a waiting queue does not hold off the autolock');
  const w = queue.waitingInfo();
  assert.deepStrictEqual(w.sample.map(x => x.id), [f.id]);

  // The model shows up in LM Studio: the files start on their own.
  await loaded([{ id: 'big-text', type: 'llm' }, 'vis']);
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(calls, [f.filepath]);
  assert.strictEqual(queue.status().waiting, null);
  assert.strictEqual(queue.status().failed, 0);
});

test('automatic with nothing loaded waits and says how to fix it', async () => {
  await fresh({ settings: { scanModel: '' } });
  await loaded([]);
  queue.enqueue(addFile());
  const s = queue.status();
  assert.strictEqual(s.pausedBy, 'waiting');
  assert.strictEqual(s.waiting.code, 'no-model');
  assert.match(s.waiting.reason, /pick a scan model in Settings/);
});

test('Load it if there is room: Vault loads the scan model and the files start', async () => {
  const loads = [];
  await fresh({
    settings: { whenNotLoaded: 'room' },
    deps: { load: async (o) => { loads.push(o.modelKey); served.push({ id: 'vis' }); return { ok: true }; } },
  });
  await loaded([]);
  const f = addFile();
  queue.enqueue(f);
  assert.strictEqual(queue.status().pausedBy, 'waiting');
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(loads, ['vis']);
  assert.deepStrictEqual(scanModel.status().vaultLoaded, ['vis'], 'remembered as loaded by Vault');
  assert.deepStrictEqual(calls, [f.filepath]);
});

test('no room: the wait says so and nothing is loaded', async () => {
  const loads = [];
  await fresh({
    settings: { whenNotLoaded: 'room' },
    deps: {
      readGpu: async () => ({ freeBytes: 1 * GB, totalBytes: 24 * GB, gpus: 1 }),
      load: async (o) => { loads.push(o); return { ok: true }; },
    },
  });
  await loaded([{ id: 'big-text', type: 'llm' }]);
  queue.enqueue(addFile());
  await until(() => queue.status().waiting && queue.status().waiting.code === 'no-room');
  assert.match(queue.status().waiting.reason, /Not enough free GPU memory to load vis/);
  assert.strictEqual(loads.length, 0);
  assert.strictEqual(queue.status().failed, 0);
});

/* ── The old halt, folded into Waiting ─────────────────────────────────── */

test('the model dying mid-run is a wait, and the third strike blames the file', async () => {
  await fresh();
  await loaded(['vis']);
  // What lib/llm-client.js does on a model-unavailable answer: retire the copy.
  outcome = () => {
    slots.reportUnavailable(slots.pick('vis'));
    return { modelUnavailable: true, error: 'The model is not loaded (endpoint answered 404)' };
  };
  const f = addFile();
  queue.enqueue(f);
  await until(() => calls.length === 1 && queue.status().waiting && queue.status().waiting.code !== 'checking');
  const s = queue.status();
  assert.ok(['model-stopped', 'policy-wait'].includes(s.waiting.code), s.waiting.code);
  assert.strictEqual(s.waiting.count, 1, 'the file went back to wait, not to the failed list');
  assert.strictEqual(s.failed, 0);
  assert.strictEqual(errorOf(f.id), 'unscanned', 'not stamped');
  assert.strictEqual(s.halt, null, 'no halt needing Resume');

  // LM Studio still lists it, but it just failed: no instant retry (cool-down).
  await slots.refresh({ force: true });
  assert.ok(slots.activeCount('vis') > 0, 'listed as loaded again');
  queue._recheck();
  assert.strictEqual(queue.status().pausedBy, 'waiting');
  assert.strictEqual(calls.length, 1);

  // Resume always tries at once; two more strikes and the file is blamed.
  queue.resume();
  await until(() => calls.length === 2 && queue.status().pausedBy === 'waiting');
  queue.resume();
  await until(() => queue.status().failed === 1);
  assert.match(errorOf(f.id), /^Repeatedly interrupted the scan/);
  assert.deepStrictEqual(queue.failedIds(), [f.id]);
});

test('LM Studio not answering: the first file finds out, then everything waits', async () => {
  await fresh();
  up = false;
  await slots.refresh({ force: true });
  outcome = () => ({ modelUnavailable: true, error: 'Nothing is listening on the LLM endpoint. Is LM Studio running?' });
  const a = addFile();
  const b = addFile();
  queue.enqueue(a);
  queue.enqueue(b);
  await until(() => queue.status().pausedBy === 'waiting');
  const s = queue.status();
  assert.strictEqual(s.waiting.code, 'not-running');
  assert.match(s.waiting.reason, /The AI server is not answering/);
  assert.match(s.waiting.reason, /press Try now/, 'honest: Vault cannot see this server, so it says how to go on');
  assert.strictEqual(s.waiting.count, 2);
  assert.strictEqual(s.failed, 0);
});

test('"which model?" stays a halt with its picker', async () => {
  await fresh({ settings: { scanModel: '' } });
  await loaded(['alpha', 'beta']);
  outcome = () => ({ modelUnavailable: true, needsModelChoice: true, error: 'Multiple models are loaded' });
  queue.enqueue(addFile());
  // Two families and no choice: dispatch goes ahead so LM Studio can ask.
  await until(() => queue.pausedBy() === 'model-choice');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(queue.status().pendingCount, 1, 'the file is kept');
  assert.strictEqual(queue.status().failed, 0);
});

/* ── Only scan watched folders when the GPU is free ────────────────────── */

test('GPU-free: watched-folder files wait while another model is loaded; imports go ahead', async () => {
  await fresh({ settings: { gpuFreeForWatch: true } });
  await loaded(['vis', { id: 'big-text', type: 'llm' }]);
  const imp = addFile();
  const watched = addFile({ source: 'watch', folder: 'D:\\Downloads' });
  queue.enqueue(watched);
  queue.enqueue(imp);
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(calls, [imp.filepath], 'only the import ran');
  const w = queue.waitingInfo();
  assert.strictEqual(w.count, 1);
  assert.strictEqual(w.gpuBusy, true);
  assert.strictEqual(w.code, 'gpu-busy');
  assert.match(w.reason, /big-text/);
  assert.strictEqual(w.sample[0].watchFolder, 'D:\\Downloads');
  assert.strictEqual(queue.status().waiting.count, 1);
  assert.strictEqual(queue.isActive(), false);

  // The other model goes: the held file starts.
  await loaded(['vis']);
  await until(() => queue.status().done === 2);
  assert.deepStrictEqual(calls, [imp.filepath, watched.filepath]);
});

/* ── Failures of a run ─────────────────────────────────────────────────── */

test('failures are kept by id, a new batch joins the run, closing the panel clears them', async () => {
  await fresh();
  await loaded(['vis']);
  outcome = () => ({ error: 'Could not read media info. The file may be corrupt or an unsupported codec' });
  const bad = addFile();
  queue.enqueue(bad);
  await until(() => queue.status().failed === 1);
  assert.deepStrictEqual(queue.failedIds(), [bad.id]);
  assert.strictEqual(queue.status().total, 1);

  outcome = () => ({ success: true });
  queue.enqueue(addFile());
  await until(() => queue.status().done === 1);
  const s = queue.status();
  assert.strictEqual(s.total, 2, 'the new file joined the run instead of resetting it');
  assert.strictEqual(s.failed, 1, 'the unread failure is still there');

  assert.strictEqual(queue.clearFailures(), 1);
  assert.deepStrictEqual(queue.failedIds(), []);
  assert.strictEqual(queue.status().total, 0, 'an idle run resets once its failures are closed');
});

test('status names a sample of the queue, not all of it', async () => {
  await fresh();
  await loaded([{ id: 'big-text', type: 'llm' }]);
  for (let i = 0; i < 60; i++) queue.enqueue({ id: 100000 + i, filepath: path.join(tmp, `q${i}.mp4`), filename: `q${i}.mp4`, mediaType: 'video' });
  const s = queue.status();
  assert.strictEqual(s.pendingCount, 60);
  assert.ok(s.pending.length <= 20);
  assert.strictEqual(s.waiting.count, 60);
});

/* ── Text-only models never get a scan ─────────────────────────────────── */

test('automatic with only a text model loaded: files wait, nothing is sent to it', async () => {
  await fresh({ settings: { scanModel: '' } });
  await loaded([{ id: 'qwen3.5-27b', type: 'llm' }]);
  const f = addFile();
  queue.enqueue(f);
  const s = queue.status();
  assert.strictEqual(s.pausedBy, 'waiting');
  assert.strictEqual(s.waiting.code, 'not-vision');
  assert.strictEqual(s.waiting.reason,
    'No model that can read pictures is loaded (qwen3.5-27b is text only). Pick a scan model in Settings or load one.');
  assert.strictEqual(calls.length, 0, 'nothing went to the text model');
  assert.strictEqual(s.failed, 0);
  assert.strictEqual(errorOf(f.id), 'unscanned');

  // A vision model is loaded next to it: the files start, and go to that one.
  await loaded([{ id: 'qwen3.5-27b', type: 'llm' }, 'vis']);
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(targets, ['vis'], 'the scan went to the vision model');
});

test('automatic with a text model and a vision model: scans go to the vision one; other features are unchanged', async () => {
  await fresh({ settings: { scanModel: '' } });
  await loaded([{ id: 'big-text', type: 'llm' }, 'vis']);
  queue.enqueue(addFile());
  queue.enqueue(addFile());
  await until(() => queue.status().done === 2);
  assert.deepStrictEqual(targets, ['vis', 'vis']);
  assert.strictEqual(queue.status().model.name, 'vis');
  // Outside a scan, the plain rule: two models loaded and none picked.
  assert.strictEqual(llm.resolveTarget().family, null, 'text features still see both, as before');
  assert.strictEqual(llm.resolveTarget({ forScan: true }).family, 'vis');
});

test('a chosen scan model that is text only waits with a reason instead of failing files', async () => {
  await fresh({ settings: { scanModel: 'big-text' } });
  await loaded([{ id: 'big-text', type: 'llm' }]);
  const f = addFile();
  queue.enqueue(f);
  const s = queue.status();
  assert.strictEqual(s.waiting.code, 'not-vision');
  assert.strictEqual(s.waiting.reason,
    'big-text cannot read pictures (LM Studio lists it as text only). Pick a vision model as the scan model in Settings.');
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(s.failed, 0);
  assert.strictEqual(errorOf(f.id), 'unscanned');
});

test('a server that does not say which models read pictures keeps the old behaviour', async () => {
  await fresh({ settings: { scanModel: '' } });
  await loaded([{ id: 'untyped', type: null }]);
  assert.strictEqual(slots.familyVision('untyped'), null, 'not known');
  queue.enqueue(addFile());
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(targets, ['untyped'], 'the one loaded model is used, as before');

  // One untyped and one text-only: the untyped one is still a candidate.
  await fresh({ settings: { scanModel: '' } });
  await loaded([{ id: 'untyped', type: null }, { id: 'big-text', type: 'llm' }]);
  queue.enqueue(addFile());
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(targets, ['untyped']);
});

/* ── The saved scan model is for scans only ─────────────────────────────── */

test('a scan uses the saved scan model; text features resolve as before', async () => {
  await fresh({ settings: { scanModel: 'vis' } });
  await loaded(['vis', 'other']);
  queue.enqueue(addFile());
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(targets, ['vis'], 'the queue scan went to the saved scan model');
  // The sidebar's Rescan runs in the same scan context (server/index.js).
  let inside = null;
  await slots.runScan({ mediaId: 1, scan: true, vision: true }, async () => { inside = llm.resolveModel(); });
  assert.strictEqual(inside, 'vis');
  // A document or audio file: the saved scan model too, because it is loaded
  // (a vision model reads text fine); not when it is not loaded.
  await slots.runScan({ mediaId: 2, scan: true, vision: false }, async () => { inside = llm.resolveModel(); });
  assert.strictEqual(inside, 'vis', 'a loaded saved scan model takes documents too');

  // Text features: AI_MODEL, then the session pick, then whatever is loaded.
  assert.strictEqual(llm.resolveModel(), null, 'never the saved scan model');
  assert.strictEqual(llm.resolveTarget().family, null, 'two loaded, none picked: as today');
  await loaded(['other']);
  assert.strictEqual(llm.resolveTarget().family, 'other', 'one loaded: that one, not the saved scan model');
  llm.setSessionModel('other');
  assert.strictEqual(llm.resolveModel(), 'other', 'a session pick still applies to everything');
  assert.strictEqual(llm.resolveModel({ forScan: true }), 'other', 'and outranks the saved scan model');
  llm.setSessionModel(null);
});
