/**
 * The fourth verification round (A to G), as whole runs through the queue
 * and the real lib/llm-client.js against a stub LM Studio: full speed after
 * a trial file, no file ever failed by a dead-model wait, a fresh look at
 * the registry before a run's first picture, "which model?" per kind of
 * file, a model loaded again carrying on at once, the counts, and no second
 * copy of a model LM Studio still lists.
 */
require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-gater4-'));
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

/* ── A: after a trial file works, the run is back at full speed ────────── */

test('A: once the trial file answers, the rest of the run uses every worker again', async () => {
  await fresh();
  mode = 'v1';
  v1rows = [{ id: 'llava:latest' }];
  await slots.refresh({ force: true });
  let dead = true;
  let answered = 0;
  let release;
  const hold = new Promise(r => { release = r; });
  scan.processFile = async (file) => {
    calls.push(file.path);
    if (dead) {
      const s = slots.pick('llava:latest');
      if (s) slots.reportUnavailable(s);
      return { modelUnavailable: true, error: 'The LLM backend is unavailable (HTTP 503)' };
    }
    if (answered++ === 0) return { success: true };      // the trial file
    await hold;
    return { success: true };
  };
  for (let i = 0; i < 6; i++) queue.enqueue(addFile());
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'model-stopped'));
  dead = false;
  await slots.refresh({ force: true });
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000;
  try { queue._recheck(); } finally { Date.now = realNow; }
  const want = queue.getConcurrency();
  assert.ok(want >= 2);
  assert.ok(await until(() => queue.status().active.length === want), `active ${queue.status().active.length} of ${want}`);
  release();
  assert.ok(await until(() => queue.status().done === 6));
});

/* ── B: a dead model that LM Studio still lists never fails files ──────── */

test('B: a listed model answering 404 for ten minutes of re-checks fails nothing', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' });
  await lmStudio([['vis', 'vlm']]);
  scan.processFile = async (file) => {
    calls.push(file.path);
    const s = slots.pick('vis');
    if (s) slots.reportUnavailable(s);                   // what llm-client does on a 404
    return { modelUnavailable: true, error: 'The model is not loaded (endpoint answered 404)' };
  };
  for (let i = 0; i < 3; i++) queue.enqueue(addFile());
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'model-stopped'
    && queue.status().active.length === 0));
  const first = calls.length;
  const realNow = Date.now;
  let shift = 0;
  for (let i = 0; i < 10; i++) {
    await slots.refresh({ force: true });                // LM Studio still lists it
    shift += 20 * 60_000;                                // past any cool-down
    Date.now = () => realNow() + shift;
    try { queue._recheck(); } finally { Date.now = realNow; }
    await until(() => queue.status().active.length === 0 && queue.status().waiting);
  }
  const s = queue.status();
  assert.strictEqual(s.failed, 0, 'the dead-model wait never fails files on its own');
  assert.strictEqual(s.pendingCount, 3);
  assert.strictEqual(calls.length - first, 10, 'one trial file per re-check');
  assert.strictEqual(s.waiting.loadable, false, 'G: a model LM Studio still lists is not loaded again');
});

test('G: Load anyway refuses a model LM Studio lists under its own name', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'room' }, { canLoad: true, ps: [{ identifier: 'vis', modelKey: 'vis' }] });
  await lmStudio([['other', 'vlm']]);
  const w = await scanModel.maybeLoad({ force: true });
  assert.strictEqual(w.code, 'listed-dead');
  assert.match(w.reason, /Unload it and load it again in LM Studio/);
  assert.deepStrictEqual(loads, []);
});

/* ── C: a stale registry at the start of a run ─────────────────────────── */

test('C: the registry is looked at again before the first picture of a run goes out', async () => {
  await fresh();
  await lmStudio([['vis', 'vlm']]);                       // what Vault remembers
  v0rows = [{ id: 'txt', type: 'llm', state: 'loaded' }]; // what LM Studio has now
  v1rows = [{ id: 'txt' }];
  scan.processFile = chatPF;
  // What Vault remembers is more than 10 s old by the time the run starts.
  const realNow = Date.now;
  Date.now = () => realNow() + 11_000;
  try { queue.enqueue(addFile('video')); } finally { Date.now = realNow; }
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'not-vision'));
  assert.deepStrictEqual(sent, [], 'no picture went to the text model');
  assert.deepStrictEqual(calls, []);
});

/* ── D: "which model?" per kind of file ────────────────────────────────── */

test('D: the question is asked per kind, and answering one never holds the other', async () => {
  await fresh();
  await lmStudio([['vis', 'vlm'], ['vis2', 'vlm'], ['txt', 'llm']]);
  scan.processFile = chatPF;
  llm.setSessionModel('txt', { kind: 'text' });          // documents already have a model
  const vid = addFile('video');
  queue.enqueue(vid);
  queue.enqueue(addFile('document', 'pdf'));
  queue.enqueue(addFile('document', 'pdf'));
  assert.ok(await until(() => queue.status().done === 2), 'the documents went on');
  const s = queue.status();
  assert.strictEqual(s.halt.kind, 'vision', 'a question about pictures');
  assert.strictEqual(s.pausedBy, 'model-choice');
  assert.strictEqual(s.failed, 0);

  llm.setSessionModel('vis', { kind: 'vision' });
  assert.strictEqual(queue.answerChoice('vision'), true);
  assert.ok(await until(() => queue.status().done === 3));
  assert.strictEqual(llm.getSessionModel({ kind: 'text' }), 'txt', 'the text pick is untouched');
  assert.ok(sent.filter(m => m === 'txt').length === 2 && sent.includes('vis'));
});

test('D: a text model picked for pictures says so, and offers to pick again', async () => {
  await fresh();
  await lmStudio([['vis', 'vlm'], ['txt', 'llm']]);
  llm.setSessionModel('txt', { kind: 'vision' });
  queue.enqueue(addFile('video'));
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'not-vision'));
  const w = queue.status().waiting;
  assert.match(w.reason, /^txt, picked in the scan panel or on the Backend page, cannot read pictures\. Pick a model that can read pictures\.$/);
  assert.strictEqual(w.pickAgain, true);
  llm.setSessionModel(null, { kind: 'vision' });          // what "Pick a model that can read pictures" sends
  assert.ok(await until(() => queue.status().done === 1), 'the only vision model takes it');
});

/* ── E: the user loading the model again need not wait out the cool-down ─ */

test('E: on LM Studio, the model loaded again carries the run on at once', async (t) => {
  queue._setTimings({ fastPollMs: 50 });
  t.after(() => queue._setTimings({ fastPollMs: 12_000 }));
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' });
  await lmStudio([['vis', 'vlm']]);
  let dead = true;
  scan.processFile = async (file) => {
    calls.push(file.path);
    if (!dead) return { success: true };
    const s = slots.pick('vis');
    if (s) slots.reportUnavailable(s);
    return { modelUnavailable: true, error: 'Model unloaded' };
  };
  queue.enqueue(addFile());
  queue.enqueue(addFile());
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'model-stopped'
    && queue.status().active.length === 0));
  // LM Studio unloaded it (JIT): it is not listed any more. Nothing here asks
  // LM Studio again: the queue's own look (every FAST_POLL_MS while files are
  // held on an LM Studio on this PC, shortened for the test) notices.
  v0rows = [{ id: 'vis', type: 'vlm', state: 'not-loaded' }];
  await until(() => queue.waitingInfo().code === 'model-stopped' && slots.activeFamilies().length === 0);
  await new Promise(r => setTimeout(r, 200));
  // The user loads it again, well inside the 60 s cool-down.
  dead = false;
  v0rows = [{ id: 'vis', type: 'vlm', state: 'loaded' }];
  assert.ok(await until(() => queue.status().done === 2, 3000), `done ${queue.status().done}`);
});

/* ── F: counts, time left, order, notices ──────────────────────────────── */

test('F: cancel takes its share off the total; held files are not in the time left', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' }, { canLoad: true });
  await lmStudio([['txt', 'llm']]);
  let release;
  const hold = new Promise(r => { release = r; });
  scan.processFile = async (file) => { calls.push(file.path); await hold; return { success: true }; };
  for (let i = 0; i < 4; i++) queue.enqueue(addFile('video'));
  queue.enqueue(addFile('document', 'pdf'));
  queue.enqueue(addFile('document', 'pdf'));
  queue.enqueue(addFile('document', 'pdf'));
  assert.ok(await until(() => queue.status().active.length === 2));
  const st = queue.status();
  assert.strictEqual(st.waiting.count, 4);
  queue.cancel();
  assert.strictEqual(queue.status().total, 2, 'only the two still finishing');
  release();
  assert.ok(await until(() => queue.status().done === 2));
});

test('F: the pending sample is in the order files will go out, and a new run drops the old notice', async () => {
  await fresh();
  queue.pause();
  const w1 = addFile('video', 'mp4', { source: 'watch', folder: 'W' });
  const a = addFile('video');
  const b = addFile('document', 'pdf');
  queue.enqueue(w1);
  queue.enqueue(a);
  queue.enqueue(b);
  assert.deepStrictEqual(queue.status().pending.map(p => p.id), [a.id, b.id, w1.id], 'the user\'s files first');
  queue.cancel();

  await fresh();
  await lmStudio([['vis', 'vlm'], ['vis:2', 'vlm']]);
  slots.reportUnavailable(slots.pick('vis:2'));
  queue._retryOnSurvivingInstance({ id: 1, filepath: 'x', filename: 'x', mediaType: 'video' }, 'gone');
  assert.ok(queue.notice());
  queue.cancel();
  queue.enqueue(addFile('document', 'pdf'));
  assert.strictEqual(queue.status().notice, null, 'the old run\'s notice is gone');
});
