/**
 * The scan queue's check before sending a file (lib/import-queue.js _gate),
 * for the setups a fresh verifier found it broke (cases A to G), against a
 * stub server that answers like LM Studio (/api/v0/models with state and
 * type) or like Ollama (no /api/v0):
 *
 * A  a server that is not LM Studio, listing `llava:latest` for AI_MODEL=llava
 * B  a server that lists no models at all
 * C  documents and audio with only a text model loaded (and next to videos)
 * D  a chosen model LM Studio has not loaded, where its just-in-time loading
 *    used to load it on the first request (local without lms, and remote)
 * E  Try now sticks for the rest of the run
 * F  a timer left behind by a scan does not inherit the scan
 * G  the scan model already loaded under the user's own identifier
 *
 * Plus the stale-reason fixes: a dead model's reason is not overwritten by
 * the loader, and the cool-down is looked at again when it ends.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-gate-'));
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
const scan = require('../commands/scan');

let mode = 'v0';                 // 'v0' = LM Studio, 'v1' = no /api/v0 (Ollama and friends)
let v0rows = [];
let v1rows = [];
let server;
let base;
const calls = [];
const targets = [];
const realIsLocal = lmsCli.isLocalEndpoint;
const defaultPF = async (file) => { calls.push(file.path); targets.push(llm.resolveTarget().family); return { success: true }; };

test.before(async () => {
  db.init();
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/v0/models')) {
      if (mode !== 'v0') { res.writeHead(404); res.end('nope'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: v0rows }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: v1rows }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
});

test.after(async () => {
  queue.cancel();
  scanModel.stop();
  config.lmStudio.model = null;
  lmsCli.isLocalEndpoint = realIsLocal;
  await new Promise(r => server.close(r));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) return false;
    await new Promise(r => setTimeout(r, 10));
  }
  return true;
};

let seq = 0;
function addFile(type = 'video', ext = 'mp4') {
  const name = `f${++seq}.${ext}`;
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, ?, 'unscanned')")
    .run(fp, name, type).lastInsertRowid);
  return { id, filepath: fp, filename: name, mediaType: type };
}

const loads = [];
async function fresh(settings = {}, { canLoad = false, ps = [] } = {}) {
  queue.cancel();
  calls.length = 0;
  targets.length = 0;
  loads.length = 0;
  scan.processFile = defaultPF;
  lmsCli.isLocalEndpoint = realIsLocal;
  slots._reset([base]);
  llm.setSessionModel(null);
  config.lmStudio.model = null;
  scanModel._reset();
  scanModel._setDeps({
    listModels: async () => [],
    readGpu: async () => null,
    canLoad: () => (canLoad ? { ok: true } : { ok: false, reason: 'test' }),
    psRows: async () => ps,
    load: async (o) => { loads.push(o); return { ok: false }; },
    refresh: () => slots.refresh({ force: true }),
    loadedFamilies: () => slots.activeFamilies(),
    isLocked: () => false,
  });
  scanModel.setSettings({ scanModel: '', whenNotLoaded: 'room', ...settings });
}

/* ── A, B: servers we cannot see into ──────────────────────────────────── */

test('A: not LM Studio, and the listed id differs from AI_MODEL: files go out as before', async () => {
  await fresh();
  mode = 'v1';
  v1rows = [{ id: 'llava:latest' }];
  config.lmStudio.model = 'llava';
  await slots.refresh({ force: true });
  assert.strictEqual(queue._gate().state, 'unknown');
  queue.enqueue(addFile());
  assert.ok(await until(() => calls.length === 1), 'dispatched');
  assert.strictEqual(queue.status().waiting, null);
});

test('B: a server that lists no models: files go out as before', async () => {
  await fresh();
  mode = 'v1';
  v1rows = [];
  await slots.refresh({ force: true });
  assert.strictEqual(queue._gate().state, 'unknown');
  queue.enqueue(addFile());
  assert.ok(await until(() => calls.length === 1));
});

/* ── C: documents and audio need no vision ─────────────────────────────── */

test('C: documents and audio go to a text model; videos next to them wait', async () => {
  await fresh();
  mode = 'v0';
  v0rows = [{ id: 'textonly', type: 'llm', state: 'loaded' }];
  v1rows = [{ id: 'textonly' }];
  await slots.refresh({ force: true });
  const vid = addFile('video', 'mp4');
  queue.enqueue(vid);
  queue.enqueue(addFile('document', 'pdf'));
  queue.enqueue(addFile('audio', 'mp3'));
  assert.ok(await until(() => calls.length === 2), 'the document and the audio file ran');
  assert.ok(!calls.includes(vid.filepath), 'the video did not go to the text model');
  assert.deepStrictEqual(targets, ['textonly', 'textonly'], 'they used the plain resolution');
  const w = queue.waitingInfo();
  assert.strictEqual(w.count, 1);
  assert.strictEqual(w.code, 'not-vision');
  assert.deepStrictEqual(w.sample.map(s => s.id), [vid.id]);
  assert.ok(await until(() => queue.status().pausedBy === 'waiting'), 'all that is left is held');
});

/* ── D: just-in-time loading ───────────────────────────────────────────── */

test('D: a chosen model not loaded, where Vault cannot load it: LM Studio JIT gets the file', async () => {
  await fresh();
  mode = 'v0';
  v0rows = [{ id: 'vis', type: 'vlm', state: 'not-loaded' }];
  v1rows = [{ id: 'vis' }];
  config.lmStudio.model = 'vis';
  await slots.refresh({ force: true });
  assert.strictEqual(queue._gate().state, 'unknown');
  queue.enqueue(addFile());
  assert.ok(await until(() => calls.length === 1));
});

test('D: a remote LM Studio never makes files wait', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' }, { canLoad: true });
  mode = 'v0';
  v0rows = [{ id: 'vis', type: 'vlm', state: 'not-loaded' }];
  v1rows = [{ id: 'vis' }];
  lmsCli.isLocalEndpoint = () => false;          // the same answers, from another PC
  await slots.refresh({ force: true });
  assert.strictEqual(queue._gate().state, 'unknown');
  queue.enqueue(addFile());
  assert.ok(await until(() => calls.length === 1));
});

test('D: a local LM Studio with "Wait until I load it" waits, as asked', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' }, { canLoad: true });
  mode = 'v0';
  v0rows = [{ id: 'vis', type: 'vlm', state: 'not-loaded' }];
  v1rows = [{ id: 'vis' }];
  await slots.refresh({ force: true });
  queue.enqueue(addFile());
  assert.ok(await until(() => queue.status().waiting && queue.status().waiting.code === 'policy-wait'));
  assert.strictEqual(calls.length, 0);
});

/* ── E: Try now sticks ─────────────────────────────────────────────────── */

test('E: Try now covers the rest of the run, files added during it included', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'wait' });
  mode = 'v0';
  v0rows = [{ id: 'other', type: 'vlm', state: 'loaded' }];
  v1rows = [{ id: 'other' }];
  await slots.refresh({ force: true });
  let release;
  const gate = new Promise(r => { release = r; });
  scan.processFile = async (file) => { calls.push(file.path); await gate; return { success: true }; };
  for (let i = 0; i < 6; i++) queue.enqueue(addFile());
  assert.strictEqual(queue.status().pausedBy, 'waiting');
  queue.resume();
  assert.ok(await until(() => calls.length >= 1));
  queue.enqueue(addFile());
  assert.strictEqual(queue.status().waiting, null, 'not back to waiting mid-run');
  release();
  assert.ok(await until(() => queue.status().done === 7), `done ${queue.status().done}`);
});

/* ── F: the scan context ends with the scan ────────────────────────────── */

test('F: a timer a scan leaves behind resolves like any other request', async () => {
  await fresh({ scanModel: 'vis' });
  let during = 'unset';
  let leaked = 'unset';
  await slots.runScan({ mediaId: 1, scan: true, vision: true }, async () => {
    during = llm.resolveModel();
    setTimeout(() => { leaked = llm.resolveModel(); }, 5);
  });
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(during, 'vis', 'inside the scan: the saved scan model');
  assert.strictEqual(leaked, null, 'after it: the plain resolution');
});

/* ── G: the user's own copy of the scan model ──────────────────────────── */

test('G: the scan model loaded under the user\'s own identifier is used, not loaded again', async () => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'room' }, { canLoad: true, ps: [{ identifier: 'my-vis', modelKey: 'vis' }] });
  mode = 'v0';
  v0rows = [{ id: 'my-vis', type: 'vlm', state: 'loaded' }];
  v1rows = [{ id: 'my-vis' }];
  await slots.refresh({ force: true });
  queue.enqueue(addFile());
  assert.ok(await until(() => calls.length === 1), 'dispatched to the user\'s copy');
  assert.deepStrictEqual(targets, ['my-vis']);
  assert.deepStrictEqual(loads, [], 'no duplicate load');
  assert.strictEqual(scanModel.scanTargetId(), 'my-vis');
  assert.deepStrictEqual(scanModel.status().vaultLoaded, [], 'and it is never Vault\'s to unload');
});

/* ── Stale reasons ─────────────────────────────────────────────────────── */

test('a dead model keeps its reason, and the cool-down is looked at again when it ends', async (t) => {
  await fresh({ scanModel: 'vis', whenNotLoaded: 'room' }, { canLoad: true });
  mode = 'v0';
  v0rows = [{ id: 'vis', type: 'vlm', state: 'loaded' }];
  v1rows = [{ id: 'vis' }];
  await slots.refresh({ force: true });
  let dead = true;
  scan.processFile = async (file) => {
    calls.push(file.path);
    if (!dead) return { success: true };
    slots.reportUnavailable(slots.pick('vis'));        // what lib/llm-client.js does
    return { modelUnavailable: true, error: 'The LLM backend is unavailable (HTTP 503)' };
  };
  // Fake clocks from the start: the end of the cool-down is scheduled the
  // moment the model dies.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const spin = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setImmediate(r)); return fn(); };
  queue.enqueue(addFile());
  assert.ok(await spin(() => calls.length === 1 && queue.status().waiting && queue.status().waiting.code === 'model-stopped'));
  // LM Studio lists it again, but it just failed: not trusted at once, and
  // the loader does not overwrite the reason.
  await slots.refresh({ force: true });
  dead = false;
  queue._recheck();
  await spin(() => false);
  assert.strictEqual(queue.status().pausedBy, 'waiting', 'not trusted at once');
  assert.strictEqual(queue.status().waiting.code, 'model-stopped', 'and the reason is not overwritten');
  t.mock.timers.tick(61_000);
  assert.ok(await spin(() => queue.status().done === 1), 'carried on when the cool-down ended');
  t.mock.timers.reset();
});
