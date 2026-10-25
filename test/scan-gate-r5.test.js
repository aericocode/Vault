/**
 * The fifth verification round (1 to 4), against the real lib/llm-client.js
 * and a stub LM Studio that can be slow, and can refuse pictures:
 *
 * 1 the quick look at a run's start counts as busy and "starting", never as
 *   idle or waiting, and is skipped when the registry is fresh
 * 2 a "which model?" question is not shown as a wait
 * 3 the end of a dead model's cool-down asks LM Studio itself
 * 4 pictures never land on a text-only model: no model-less request, and a
 *   "does not support images" answer holds them (Try now too) without
 *   failing anything
 */
require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-gater5-'));
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
let v0Delay = 0;                 // ms LM Studio takes to answer /api/v0/models
let v0Hits = 0;
let rejectImages = false;        // answer 400 "does not support images"
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
      v0Hits++;
      if (mode !== 'v0') { res.writeHead(404); res.end('nope'); return; }
      const rows = JSON.stringify({ data: v0rows });
      const answer = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(rows); };
      if (v0Delay) setTimeout(answer, v0Delay); else answer();
      return;
    }
    if (req.url.includes('/chat/completions')) {
      let b = '';
      req.on('data', d => { b += d; });
      req.on('end', () => {
        const j = JSON.parse(b);
        sent.push(j.model || null);
        if (chatMode === 'dead') { res.writeHead(503); res.end('model unloaded'); return; }
        if (rejectImages) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Model does not support images' }));
          return;
        }
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
  v0Delay = 0;
  rejectImages = false;
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

/* ── 1: the look at a run's start is "starting", not waiting ───────────── */

test('1: while the first look runs the queue is busy and starting, never idle or waiting', async () => {
  await fresh();
  await lmStudio([['vis', 'vlm']]);
  v0Delay = 400;                                           // a slow LM Studio
  const realNow = Date.now;
  Date.now = () => realNow() + 11_000;                     // the registry is older than 10 s
  try { queue.enqueue(addFile('video')); } finally { Date.now = realNow; }
  const s = queue.status();
  assert.strictEqual(queue.isActive(), true, 'busy: autolock and idle unload must leave it alone');
  assert.strictEqual(s.paused, false);
  assert.strictEqual(s.pausedBy, null);
  assert.strictEqual(s.starting, true);
  assert.strictEqual(s.waiting, null, 'not a wait');
  assert.ok(await until(() => queue.status().done === 1));
  v0Delay = 0;
});

test('1: a registry looked at in the last few seconds means no delay at all', async () => {
  await fresh();
  await lmStudio([['vis', 'vlm']]);
  queue.enqueue(addFile('video'));
  assert.strictEqual(queue.status().active.length, 1, 'started at once');
  assert.strictEqual(queue.status().starting, false);
  assert.ok(await until(() => queue.status().done === 1));
});

/* ── 2: a "which model?" question is not a wait ────────────────────────── */

test('2: during a "which model?" question there is no wait text, and no GPU text', async () => {
  await fresh();
  await lmStudio([['alpha', 'vlm'], ['beta', 'vlm']]);
  scan.processFile = chatPF;
  queue.enqueue(addFile('video'));
  assert.ok(await until(() => queue.pausedBy() === 'model-choice'));
  const s = queue.status();
  assert.ok(s.halt && s.halt.needsModelChoice, 'the question is there');
  assert.strictEqual(s.waiting, null, 'no Waiting tab, no "Waiting for the scan model" line');
  assert.strictEqual(queue.waitingInfo().count, 0);
  assert.strictEqual(s.paused, true, 'a stop: the panel shows Resume, not Pause');
  assert.strictEqual(s.etaMs, null);
});

/* ── 3: a model loaded again is noticed by the queue's own looks ───────── */

test('3: the end of the cool-down looks at LM Studio itself before deciding', async (t) => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' });
  await lmStudio([['vis', 'vlm']]);
  let dead = true;
  scan.processFile = async (file) => {
    calls.push(file.path);
    if (!dead) return { success: true };
    const s = slots.pick('vis');
    if (s) slots.reportUnavailable(s);
    return { modelUnavailable: true, error: 'HTTP 503' };
  };
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const spin = async (fn) => { for (let i = 0; i < 300 && !fn(); i++) await new Promise(r => setImmediate(r)); return fn(); };
  queue.enqueue(addFile());
  assert.ok(await spin(() => queue.status().waiting && queue.status().waiting.code === 'model-stopped'));
  dead = false;
  const before = v0Hits;
  t.mock.timers.tick(61_000);
  assert.ok(await spin(() => v0Hits > before), 'it asked LM Studio');
  assert.ok(await spin(() => queue.status().done === 1), 'and carried on');
  t.mock.timers.reset();
});

/* ── 4: pictures never land on a text-only model ───────────────────────── */

test('4: with only text-only models loaded a picture request is never sent, not even without a model id', async () => {
  await fresh();
  await lmStudio([['txt', 'llm']]);
  assert.strictEqual(llm.resolveTarget({ forScan: true }).noVision, true);
  await assert.rejects(
    slots.runScan({ mediaId: 1, scan: true, vision: true }, () => llm.postChat([{ role: 'user', content: 'x' }])),
    /cannot read pictures/);
  assert.deepStrictEqual(sent, [], 'nothing went out');
  // Documents still go to the text model.
  await slots.runScan({ mediaId: 2, scan: true, vision: false }, () => llm.postChat([{ role: 'user', content: 'x' }]));
  assert.deepStrictEqual(sent, ['txt']);
});

test('4: "does not support images" holds pictures without failing them, and Try now does not override it', async () => {
  await fresh();
  mode = 'v1';                                             // a server that does not type its models
  v1rows = [{ id: 'txt' }];
  await slots.refresh({ force: true });
  rejectImages = true;
  scan.processFile = chatPF;
  const f = addFile('video');
  queue.enqueue(f);
  queue.enqueue(addFile('video'));
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'not-vision'
    && queue.status().active.length === 0));
  let s = queue.status();
  assert.match(s.waiting.reason, /^txt refused to read pictures./, 'it said no, so not "lists it as text only"');
  assert.strictEqual(s.failed, 0, 'not failed');
  assert.strictEqual(s.pendingCount, 2, 'both still queued');
  assert.strictEqual(errorOf(f.id), 'unscanned', 'no error left on the row');
  const sentBefore = sent.length;
  queue.resume();                                          // Try now
  await new Promise(r => setTimeout(r, 100));
  assert.strictEqual(sent.length, sentBefore, 'Try now does not send pictures to a model that cannot read them');
  // LM Studio's picture changes (a vision model now answers): they go.
  rejectImages = false;
  v1rows = [{ id: 'vis' }];
  await slots.refresh({ force: true });
  assert.ok(await until(() => queue.status().done === 2), `done ${queue.status().done}`);
  assert.strictEqual(queue.status().failed, 0);
});

test('4: AI_MODEL naming a text-only model says the environment decides', async () => {
  await fresh();
  await lmStudio([['txt', 'llm'], ['vis', 'vlm']]);
  config.lmStudio.model = 'txt';
  queue.enqueue(addFile('video'));
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'not-vision'));
  assert.match(queue.status().waiting.reason, /^AI_MODEL in the environment picks txt, which cannot read pictures./);
  assert.deepStrictEqual(sent, []);
  config.lmStudio.model = null;
});
