/**
 * Whole runs through the scan queue with requests going through the real
 * lib/llm-client.js to a stub server that answers like LM Studio: "Multiple
 * models are loaded" (400) when a request names no model, 503 while the
 * model is "dead". These pin the second verification round (cases H to Q)
 * and the flow dev already had:
 *
 * - two models loaded and none picked: a document raises the "which model?"
 *   picker as on dev (never a dying copy, a strike or a dead-model wait), and
 *   both files finish once a model is picked
 * - documents use the saved scan model when it is loaded
 * - a model that dies on a server Vault cannot see into is tried again, one
 *   file at a time, with a growing cool-down, and the wording says so
 * - a dead-model wait does not outlive its run
 * - `lms ps` failing: nothing is loaded, files go out
 * - held runs: cancel, counts, Try now (also over the GPU-free rule), what
 *   the panel is told, and when "Load anyway" can do anything
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-gateruns-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
delete process.env.VAULT_DB_PASSWORD;
delete process.env.AI_MODEL;

const db = require('../lib/database');
const slots = require('../lib/ai-slots');
const llm = require('../lib/llm-client');
const lmsCli = require('../lib/lms-cli');
const config = require('../config');
const scanModel = require('../lib/scan-model');
const queue = require('../lib/import-queue');
const modelHealth = require('../lib/model-health');
const scan = require('../commands/scan');

const MULTI = JSON.stringify({ error: 'Multiple models are loaded. Please specify a model by providing a model field.' });
let mode = 'v0';
let v0rows = [];
let v1rows = [];
let chatMode = 'ok';
const sent = [];                 // the model id each chat request carried
let server;
let base;
const calls = [];
const loads = [];
let psCalls = 0;
const realIsLocal = lmsCli.isLocalEndpoint;

/** processFile that asks the model, the way a processor does. */
const chatPF = async (file) => {
  calls.push(file.path);
  try {
    await llm.postChat([{ role: 'user', content: 'x' }]);
    return { success: true };
  } catch (err) {
    if (modelHealth.isModelUnavailable(err)) {
      return { modelUnavailable: true, needsModelChoice: !!err.needsModelChoice, error: err.modelReason || modelHealth.describe(err) };
    }
    return { error: err.message };
  }
};
const quickPF = async (file) => { calls.push(file.path); return { success: true }; };

test.before(async () => {
  db.init();
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v0/models')) {
      if (mode !== 'v0') { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: v0rows }));
      return;
    }
    if (req.url.includes('/chat/completions')) {
      let b = '';
      req.on('data', d => { b += d; });
      req.on('end', () => {
        const j = JSON.parse(b);
        sent.push(j.model || null);
        if (chatMode === 'dead') { res.writeHead(503); res.end('model unloaded'); return; }
        if (!j.model && mode === 'v0' && v0rows.filter(r => r.state === 'loaded').length > 1) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(MULTI);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: v1rows }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  await llm.setEndpoints([base]);
});

test.after(async () => {
  queue.cancel();
  scanModel.stop();
  config.lmStudio.model = null;
  llm.setSessionModel(null);
  lmsCli.isLocalEndpoint = realIsLocal;
  await new Promise(r => server.close(r));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 10));
  }
  return true;
};

let seq = 0;
function addFile(type = 'video', ext = 'mp4', extra = {}) {
  const name = `f${++seq}.${ext}`;
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, ?, 'unscanned')")
    .run(fp, name, type).lastInsertRowid);
  return { id, filepath: fp, filename: name, mediaType: type, ...extra };
}
const errorOf = (id) => db.get().prepare('SELECT processing_error FROM media WHERE id = ?').get(id).processing_error;

async function fresh(settings = {}, { canLoad = false, ps = [], psDelay = 0 } = {}) {
  queue.cancel();
  queue.clearFailures();
  calls.length = 0;
  loads.length = 0;
  sent.length = 0;
  psCalls = 0;
  chatMode = 'ok';
  scan.processFile = quickPF;
  lmsCli.isLocalEndpoint = realIsLocal;
  await llm.setEndpoints([base]);
  slots._reset([base]);
  llm.setSessionModel(null);
  config.lmStudio.model = null;
  scanModel._reset();
  scanModel._setDeps({
    listModels: async () => [],
    readGpu: async () => null,
    canLoad: () => (canLoad ? { ok: true } : { ok: false, reason: 'test' }),
    psRows: async () => {
      psCalls++;
      if (psDelay) await new Promise(r => setTimeout(r, psDelay));
      if (ps instanceof Error) throw ps;
      return ps;
    },
    load: async (o) => { loads.push(o); return { ok: false }; },
    refresh: () => slots.refresh({ force: true }),
    loadedFamilies: () => slots.activeFamilies(),
    isLocked: () => false,
  });
  scanModel.setSettings({ scanModel: '', whenNotLoaded: 'room', gpuFreeForWatch: false, ...settings });
}

async function lmStudio(rows) {
  mode = 'v0';
  v0rows = rows.map(([id, type, state = 'loaded']) => ({ id, type, state }));
  v1rows = rows.map(([id]) => ({ id }));
  await slots.refresh({ force: true });
}

/* ── Two models loaded, none picked: dev's picker flow ─────────────────── */

test('two models, none picked: a document asks which model, as on dev, and both files finish once picked', async () => {
  await fresh();
  await lmStudio([['vis', 'vlm'], ['txt', 'llm']]);
  scan.processFile = chatPF;
  const doc = addFile('document', 'pdf');
  const vid = addFile('video');
  queue.enqueue(doc);
  queue.enqueue(vid);
  assert.ok(await until(() => queue.pausedBy() === 'model-choice'), 'the picker question');
  await until(() => queue.status().active.length === 0);
  const s = queue.status();
  assert.strictEqual(s.failed, 0, 'nothing failed');
  assert.strictEqual(s.notice, null, 'no false "a copy was unloaded"');
  assert.strictEqual(s.halt.needsModelChoice, true);
  assert.strictEqual(errorOf(doc.id), 'unscanned', 'no strike was written');
  assert.ok(sent.includes('vis'), 'the video went to the vision model by itself');

  llm.setSessionModel('vis');            // what POST /api/ai/model-choice does
  queue.resume();
  assert.ok(await until(() => queue.status().done === 2), `done ${queue.status().done}`);
  assert.strictEqual(queue.status().failed, 0);
});

test('"Multiple models" from a vision file is the picker too, never a strike', async () => {
  await fresh();
  await lmStudio([['alpha', 'vlm'], ['beta', 'vlm']]);
  scan.processFile = chatPF;
  const f = addFile('video');
  queue.enqueue(f);
  assert.ok(await until(() => queue.pausedBy() === 'model-choice'));
  for (let i = 0; i < 3; i++) {
    queue.resume();
    await until(() => queue.pausedBy() === 'model-choice' && queue.status().active.length === 0);
  }
  assert.strictEqual(queue.status().failed, 0, 'three answers of "which model?" do not blame the file');
  assert.strictEqual(errorOf(f.id), 'unscanned');
});

test('documents use the saved scan model when it is loaded; nothing fails', async () => {
  await fresh({ scanModel: 'vis' });
  await lmStudio([['vis', 'vlm'], ['txt', 'llm']]);
  scan.processFile = chatPF;
  queue.enqueue(addFile('video'));
  queue.enqueue(addFile('document', 'pdf'));
  queue.enqueue(addFile('video'));
  assert.ok(await until(() => queue.status().done === 3));
  assert.deepStrictEqual([...new Set(sent)], ['vis']);
  assert.strictEqual(queue.status().failed, 0);
  assert.strictEqual(queue.status().notice, null);
});

test('documents: AI_MODEL first (env always wins), then the session pick, then the saved scan model', async () => {
  await fresh({ scanModel: 'vis' });
  await lmStudio([['vis', 'vlm'], ['txt', 'llm']]);
  let inside;
  const doc = async () => { await slots.runScan({ mediaId: 1, scan: true, vision: false }, async () => { inside = llm.resolveModel(); }); return inside; };
  llm.setSessionModel('txt');
  config.lmStudio.model = 'other';
  assert.strictEqual(await doc(), 'other', 'AI_MODEL outranks the session pick');
  config.lmStudio.model = null;
  assert.strictEqual(await doc(), 'txt', 'then the session pick');
  llm.setSessionModel(null);
  assert.strictEqual(await doc(), 'vis', 'then the saved scan model, being loaded');
});

/* ── A dead model where Vault cannot see what is loaded ────────────────── */

test('a model dies on a server Vault cannot see into: one file tries again after the cool-down', async () => {
  await fresh();
  mode = 'v1';
  v1rows = [{ id: 'llava:latest' }];
  await slots.refresh({ force: true });
  scan.processFile = chatPF;
  chatMode = 'dead';
  for (let i = 0; i < 3; i++) queue.enqueue(addFile());
  assert.ok(await until(() => queue.status().pausedBy === 'waiting'));
  const w = queue.status().waiting;
  assert.strictEqual(w.code, 'model-stopped');
  assert.match(w.reason, /cannot see what this AI server has loaded/);
  assert.match(w.reason, /Press Try now when the model is back/);

  // Ten minutes on, the model is back: the cool-down ends and ONE file goes.
  chatMode = 'ok';
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try { queue._recheck(); } finally { Date.now = realNow; }
  assert.ok(await until(() => queue.status().done === 3), `done ${queue.status().done}`);
  assert.strictEqual(queue.status().waiting, null);
});

test('the trial file failing waits again, for longer', async () => {
  await fresh();
  mode = 'v1';
  v1rows = [{ id: 'llava:latest' }];
  await slots.refresh({ force: true });
  scan.processFile = chatPF;
  chatMode = 'dead';
  queue.enqueue(addFile());
  queue.enqueue(addFile());
  assert.ok(await until(() => queue.status().pausedBy === 'waiting'));
  const before = sent.length;
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try { queue._recheck(); } finally { Date.now = realNow; }
  assert.ok(await until(() => queue.status().pausedBy === 'waiting' && sent.length > before));
  assert.strictEqual(sent.length - before, 1, 'one file, not the whole queue');
  queue._recheck();                    // straight away: still cooling down
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(sent.length - before, 1);
});

/* ── A dead-model wait does not outlive its run ────────────────────────── */

test('after the third strike empties the queue, the next run starts at once', async () => {
  await fresh();
  await lmStudio([['vis', 'vlm']]);
  let dead = true;
  scan.processFile = async (file) => {
    calls.push(file.path);
    if (!dead) return { success: true };
    const s = slots.pick('vis');
    if (s) slots.reportUnavailable(s);
    return { modelUnavailable: true, error: 'HTTP 503' };
  };
  queue.enqueue(addFile());
  for (let i = 0; i < 3; i++) {
    await until(() => queue.status().pausedBy === 'waiting' || queue.status().failed === 1);
    await slots.refresh({ force: true });
    queue.resume();
    await until(() => queue.status().active.length === 0);
  }
  assert.ok(await until(() => queue.status().failed === 1));
  const s = queue.status();
  assert.strictEqual(s.pausedBy, null, 'nothing is left to wait');
  assert.strictEqual(s.waiting, null);
  dead = false;
  await slots.refresh({ force: true });
  queue.enqueue(addFile());
  assert.ok(await until(() => queue.status().done === 1), 'the new file did not inherit the old wait');
});

/* ── lms ps failing ────────────────────────────────────────────────────── */

test('lms ps throwing: nothing is loaded and files go out', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'room' }, { canLoad: true, ps: new Error('boom') });
  await lmStudio([['my-vis', 'vlm']]);
  queue.enqueue(addFile());
  assert.ok(await until(() => calls.length === 1), 'dispatched');
  assert.deepStrictEqual(loads, [], 'no load that could be a duplicate');
});

test('a slow lms ps never holds up adding files, and is asked once', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'room' }, { canLoad: true, ps: [{ identifier: 'my-vis', modelKey: 'vis' }], psDelay: 300 });
  await lmStudio([['my-vis', 'vlm']]);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) queue.enqueue(addFile());
  assert.ok(Date.now() - t0 < 1000, 'enqueue does not wait for lms');
  assert.ok(await until(() => queue.status().done === 20));
  assert.strictEqual(psCalls, 1);
});

/* ── Held runs ─────────────────────────────────────────────────────────── */

test('cancel with files held: the counts stay right, and the next run is fresh', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' }, { canLoad: true });
  await lmStudio([['txt', 'llm']]);
  let release;
  const gate = new Promise(r => { release = r; });
  scan.processFile = async (file) => { calls.push(file.path); await gate; return { success: true }; };
  for (let i = 0; i < 3; i++) queue.enqueue(addFile('video'));
  for (let i = 0; i < 3; i++) queue.enqueue(addFile('document', 'pdf'));
  await until(() => queue.status().active.length === 2);
  let s = queue.status();
  assert.strictEqual(s.waiting.count, 3, 'the three videos are held');
  assert.strictEqual(s.paused, false, 'documents are running');
  const c = queue.cancel();
  assert.deepStrictEqual(c, { dropped: 4, active: 2 });
  release();
  await until(() => queue.status().active.length === 0);
  s = queue.status();
  assert.strictEqual(s.done, 2);
  assert.strictEqual(s.total, 2);
  assert.strictEqual(s.waiting, null);
  queue.enqueue(addFile('video'));
  s = queue.status();
  assert.strictEqual(s.total, 1, 'a fresh run');
  assert.strictEqual(s.waiting.count, 1);
});

test('the panel is told the truth: fully held is stopped, partly held is running with a count', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' }, { canLoad: true });
  await lmStudio([['vis', 'vlm', 'not-loaded']]);
  queue.enqueue(addFile('video'));
  queue.enqueue(addFile('video'));
  let s = queue.status();
  assert.strictEqual(s.paused, true, 'nothing is scanning');
  assert.strictEqual(s.pausedBy, 'waiting');
  assert.strictEqual(s.waiting.count, 2);
  assert.strictEqual(s.waiting.loadable, true, 'Load anyway can load vis');

  await fresh({}, { canLoad: true });
  await lmStudio([['txt', 'llm']]);
  let release;
  const gate = new Promise(r => { release = r; });
  scan.processFile = async (file) => { calls.push(file.path); await gate; return { success: true }; };
  queue.enqueue(addFile('video'));
  queue.enqueue(addFile('document', 'pdf'));
  await until(() => queue.status().active.length === 1);
  s = queue.status();
  assert.strictEqual(s.paused, false, 'the document is running');
  assert.strictEqual(s.waiting.count, 1, 'one file held');
  assert.strictEqual(s.waiting.code, 'not-vision');
  assert.strictEqual(s.waiting.loadable, false, 'no scan model chosen: Load anyway would do nothing');
  release();
  await until(() => queue.status().active.length === 0);
});

test('a held run counts what failed, what is held and what is left', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' }, { canLoad: true });
  await lmStudio([['txt', 'llm']]);
  scan.processFile = async (file) => { calls.push(file.path); return { error: 'bad doc' }; };
  for (let i = 0; i < 2; i++) queue.enqueue(addFile('video'));
  for (let i = 0; i < 2; i++) queue.enqueue(addFile('document', 'pdf'));
  queue.enqueue(addFile('audio', 'mp3'));
  assert.ok(await until(() => queue.status().failed === 3 && queue.status().active.length === 0));
  const s = queue.status();
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.pendingCount, 2);
  assert.strictEqual(s.waiting.count, 2);
  assert.strictEqual(s.pausedBy, 'waiting');
});

test('held videos start once the model is loaded; Try now also covers the GPU-free rule', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' }, { canLoad: true });
  await lmStudio([['vis', 'vlm', 'not-loaded']]);
  for (let i = 0; i < 3; i++) queue.enqueue(addFile('video'));
  queue.enqueue(addFile('document', 'pdf'));
  assert.strictEqual(queue.isActive(), false);
  await lmStudio([['vis', 'vlm']]);
  assert.ok(await until(() => queue.status().done === 4));

  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait', gpuFreeForWatch: true }, { canLoad: true });
  await lmStudio([['vis', 'vlm'], ['txt', 'llm']]);
  queue.enqueue(addFile('video', 'mp4', { source: 'watch', folder: 'W' }));
  queue.enqueue(addFile('document', 'pdf', { source: 'watch', folder: 'W' }));
  queue.enqueue(addFile('video'));
  assert.ok(await until(() => queue.status().done === 1));
  const w = queue.waitingInfo();
  assert.strictEqual(w.count, 2);
  assert.strictEqual(w.gpuBusy, true);
  assert.strictEqual(w.code, 'gpu-busy');
  queue.resume();                        // Try now: the user wants them now
  assert.ok(await until(() => queue.status().done === 3), 'Try now let the watched files go');
});
