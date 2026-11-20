/**
 * First scans after LM Studio comes up (seen live 2026-11-20, LM Studio
 * 0.4.24): Try now sent scans naming a model LM Studio had not loaded, so
 * LM Studio loaded it just in time (JIT, at its own 64k default). Each scan's
 * embedding request then JIT-loaded the embedding model, and with LM Studio's
 * "Only keep last JIT loaded model" (on by default) that unloaded the vision
 * model under the scan still answering: 400 {"error":"terminated"}, two files
 * failed, and the model was loaded three times in a minute.
 *
 * Pinned here, against a stub LM Studio:
 * - a vision scan never names a model a local LM Studio says is not loaded
 *   when Vault can load it itself (the request is not sent at all)
 * - where Vault cannot load (no lms), the request goes out as before
 * - Try now with the model not loaded holds the file (no strike, never
 *   failed) instead of sending it, and it scans once the model is loaded
 * - 400 {"error":"terminated"} is "the model went away", not a bad file
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');

// The server code under test logs a line or more per scan (and the database
// one per migration). Node's test runner reads this file's output through
// the same pipe as its own messages, and with a lot of plain output it now
// and then misreads one ("Unable to deserialize cloned data") and fails the
// whole file in a parallel run. So the console is quiet for this file; a
// test that checks what was logged catches it itself, and assertion
// failures are reported by the runner, not the console.
const _console = { log: console.log, warn: console.warn, error: console.error, info: console.info };
console.log = console.warn = console.error = console.info = () => {};
test.after(() => { Object.assign(console, _console); });
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-jit-guard-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_CONTEXT_USE_FILE = path.join(tmp, 'context-use.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
process.env.SUB_TRANSLATE = 'llm';       // the subtitle translator goes straight to the AI server
delete process.env.VAULT_DB_PASSWORD;
delete process.env.AI_MODEL;

const db = require('../lib/database');
const slots = require('../lib/ai-slots');
const llm = require('../lib/llm-client');
const scanModel = require('../lib/scan-model');
const lmsCli = require('../lib/lms-cli');
const queue = require('../lib/import-queue');
const mode = require('../lib/ai-scan-mode');
const modelHealth = require('../lib/model-health');
const playback = require('../lib/playback-activity');
const vision = require('../lib/vision-api');
const scan = require('../commands/scan');
const translator = require('../lib/subtitles/translator');
const { app } = require('../server/index');

const GB = 1024 ** 3;
let lm, lmBase, lmPort = 0;
let visLoaded = false;
let aliasId = null;                // loaded by hand under this identifier (modelKey vis)
const chats = [];                  // bodies of every chat request the stub got
// How the stub's /api/v0/models behaves (LM Studio's own route, the one that
// says what is loaded): 'ok', '500', 'hang' (never answers, as LM Studio does
// while it loads a model), 'none' (404: a server that is not LM Studio) or
// 'other' (200 with a list that is not LM Studio's: no states).
// /v1/models always answers.
let v0Mode = 'ok';
let v0DelayMs = 0;
let v0Gets = 0;                    // GETs of /api/v0/models
let v1Ids = null;                  // what /v1/models lists (null = the usual two)

function lmHandler(req, res) {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    if (req.method === 'GET' && req.url.includes('/api/v0/')) {
      v0Gets++;
      if (v0DelayMs) await new Promise(r => setTimeout(r, v0DelayMs));
      if (v0Mode === 'hang') return;
      if (v0Mode === '500') { res.writeHead(500); res.end('busy'); return; }
      if (v0Mode === 'none') { res.writeHead(404); res.end('not found'); return; }
      if (v0Mode === 'other') {             // some other server's own /api/v0/models
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'vis' }] }));
        return;
      }
    } else if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: (v1Ids || ['vis', 'text-embedding-x', ...(aliasId ? [aliasId] : [])]).map(id => ({ id })) }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.method === 'GET') {
      res.end(JSON.stringify({ data: [
        { id: 'vis', type: 'vlm', state: visLoaded ? 'loaded' : 'not-loaded', ...(visLoaded ? { loaded_context_length: 32768 } : {}) },
        ...(aliasId ? [{ id: aliasId, type: 'vlm', state: 'loaded', loaded_context_length: 32768 }] : []),
        { id: 'text-embedding-x', type: 'embeddings', state: 'not-loaded' },
      ] }));
      return;
    }
    const b = JSON.parse(body || '{}');
    chats.push({ ...b, loadedThen: visLoaded || (!!aliasId && b.model === aliasId) });
    const translating = b.messages && b.messages[0] && b.messages[0].role === 'system';
    res.end(JSON.stringify({
      choices: [{ message: { content: translating ? '1. hello' : '{"description":"ok"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 40 },
    }));
  });
}

/** LM Studio starting and stopping, always on the same port. */
function startLm() {
  return new Promise(r => { lm = http.createServer(lmHandler); lm.listen(lmPort, '127.0.0.1', () => { lmPort = lm.address().port; r(); }); });
}
function stopLm() {
  return new Promise(r => { lm.closeAllConnections?.(); lm.close(() => r()); });
}

test.before(async () => {
  db.init();
  await startLm();
  lmBase = `http://127.0.0.1:${lmPort}/v1/chat/completions`;
  llm.setEndpoints([lmBase]);

  // A scan that asks the model, as the real pipeline would, and reports back
  // in the shape commands/scan.js gives the queue.
  scan.processFile = async (file) => {
    try {
      await llm.postChat([{ role: 'user', content: 'x' }], { forScan: true });
      db.get().prepare('UPDATE media SET processing_error = NULL, description = ? WHERE filepath = ?').run('ok', file.path);
      return { success: true };
    } catch (err) {
      if (err.modelUnavailable || modelHealth.isModelUnavailable(err)) {
        modelHealth.tag(err);
        return { error: err.modelReason || err.message, modelUnavailable: true, notLoaded: !!err.notLoaded, filename: file.name };
      }
      return { error: err.message, filename: file.name };
    }
  };
});

test.after(async () => {
  queue.cancel();
  scanModel.stop();
  slots.stop();
  lmsCli._setLmsPath(undefined);
  if (lm.listening) await stopLm();
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
  const name = `j${++seq}.mp4`;
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, 'video', 'unscanned')")
    .run(fp, name).lastInsertRowid);
  return { id, filepath: fp, filename: name, mediaType: 'video' };
}

// What stands in for lms and the vault in a test (set by fresh()).
const D = {};

async function fresh({ canLoad = true, policy = 'wait' } = {}) {
  queue.cancel();
  await until(() => !queue.inFlight());
  if (!lm.listening) await startLm();
  chats.length = 0;
  visLoaded = false;
  aliasId = null;
  v0Mode = 'ok';
  v0DelayMs = 0;
  v1Ids = null;
  Object.assign(D, {
    ps: 0, psDelayMs: 0, psFail: false,       // lms ps: calls, how slow, failing
    psListsVis: false,                        // lms ps lists vis before LM Studio's own route does
    loadDelayMs: 0, loadFails: false,         // lms load
    listLagMs: 0,                             // after a load: how long until /api/v0/models lists it
    locked: false,
    now: null,                                // a clock of the test's own
  });
  playback._reset();
  scanModel._setRescanWait(null);
  // Whether the lms command is installed, whatever this PC really has.
  lmsCli._setLmsPath(canLoad ? 'lms-fake' : null);
  slots._reset([lmBase]);
  llm.setSessionModel(null);
  scanModel._reset();
  const loads = [];
  scanModel._setDeps({
    listModels: async () => [{ modelKey: 'vis', sizeBytes: GB, type: 'llm', vision: true }],
    readGpu: async () => ({ freeBytes: 20 * GB, totalBytes: 24 * GB, gpus: 1 }),
    // As the real one (lib/scan-model.js _canLoad): lms installed, and an LM
    // Studio on this PC that has spoken /api/v0/models.
    canLoad: () => (!canLoad ? { ok: false, reason: 'the lms command is not installed' }
      : slots.endpointStates().some(st => slots.speaksV0(st.url)) ? { ok: true }
        : { ok: false, reason: 'the AI server is not LM Studio on this PC' }),
    psRows: async () => {
      D.ps++;
      if (D.psDelayMs) await sleep(D.psDelayMs);
      if (D.psFail || !lm.listening) return null;
      return [...(visLoaded || D.psListsVis ? [{ identifier: 'vis', modelKey: 'vis' }] : []), ...(aliasId ? [{ identifier: aliasId, modelKey: 'vis' }] : [])];
    },
    load: async (o) => {
      loads.push(o);
      if (D.loadDelayMs) await sleep(D.loadDelayMs);
      if (D.loadFails) return { ok: false, listed: false, error: 'exit code 1 (out of memory)' };
      if (D.listLagMs) { D.psListsVis = true; setTimeout(() => { visLoaded = true; }, D.listLagMs).unref(); } else visLoaded = true;
      return { ok: true, listed: true };
    },
    refresh: () => slots.refresh({ force: true }),
    loadedFamilies: () => slots.activeFamilies(),
    isLocked: () => D.locked,
    now: () => (D.now ? D.now() : Date.now()),
  });
  scanModel.setSettings({ scanModel: 'vis', whenNotLoaded: policy, gpuFreeForWatch: false });
  await slots.refresh({ force: true });
  mode.set('on');
  return loads;
}

/** Run fn with the console caught; the lines are left in `said`. */
const said = [];
const quietly = async (fn) => {
  const { log, warn, error } = console;
  said.length = 0;
  console.log = console.warn = console.error = (...a) => said.push(a.join(' '));
  try { return await fn(); } finally { console.log = log; console.warn = warn; console.error = error; }
};

test('a vision scan is not sent to a model LM Studio has not loaded when Vault can load it', async () => {
  await fresh();
  await quietly(async () => {
    await assert.rejects(llm.postChat([{ role: 'user', content: 'x' }], { forScan: true }),
      (err) => err.notLoaded === true && err.modelUnavailable === true && /vis is not loaded/.test(err.message));
  });
  assert.strictEqual(chats.length, 0, 'nothing reached LM Studio, so nothing was loaded just in time');
});

test('loaded: the scan goes out naming it, with its loaded context', async () => {
  await fresh();
  visLoaded = true;
  await slots.refresh({ force: true });
  let caps = null;
  const r = await llm.postChat(null, { forScan: true, prepare: (c) => { caps = c; return { messages: [{ role: 'user', content: 'x' }], maxTokens: 100 }; } });
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].model, 'vis');
  assert.strictEqual(caps.contextLength, 32768);
  assert.strictEqual(r.usage.prompt_tokens, 900);
});

test('the guard looks again first: a model loaded a moment ago is used', async () => {
  await fresh();
  visLoaded = true;              // loaded, but the registry has not looked yet
  await llm.postChat([{ role: 'user', content: 'x' }], { forScan: true });
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].model, 'vis');
});

test('Vault cannot load (no lms): the request goes out as before, JIT loading is the only way', async () => {
  await fresh({ canLoad: false });
  await llm.postChat([{ role: 'user', content: 'x' }], { forScan: true });
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].model, 'vis');
});

test('text requests (not a vision scan) are never held by the guard', async () => {
  await fresh();
  await llm.postChat([{ role: 'user', content: 'x' }], { model: 'vis' });
  assert.strictEqual(chats.length, 1);
});

test('Try now with the scan model not loaded holds the file: never sent, never failed, no strike', async () => {
  const loads = await fresh({ policy: 'wait' });
  const f = addFile();
  queue.enqueue(f);
  await until(() => queue.status().waiting && queue.status().waiting.count === 1);
  assert.strictEqual(queue.status().waiting.code, 'policy-wait');

  // More presses than the strikes a file may take (3) before it is blamed.
  await quietly(async () => {
    for (let i = 0; i < 4; i++) {
      queue.resume();
      await sleep(80);
      await until(() => !queue.inFlight());
    }
  });
  const st = queue.status();
  assert.strictEqual(chats.length, 0, 'no request named the model, so LM Studio loaded nothing');
  assert.strictEqual(st.failed, 0, 'the file did not fail');
  assert.strictEqual(st.pendingCount, 1, 'it waits in the line');
  assert.strictEqual(st.waiting && st.waiting.code, 'policy-wait', 'the wait says why');
  assert.strictEqual(loads.length, 0, '"Wait until I load it" is respected');
  const row = db.get().prepare('SELECT processing_error FROM media WHERE id = ?').get(f.id);
  assert.strictEqual(row.processing_error, 'unscanned', 'the row is untouched');
  // The log line says what really happens under this setting.
  assert.ok(said.some(l => /files wait until it is loaded in LM Studio/.test(l)), said.join(' | '));
  assert.ok(!said.some(l => /Vault loads/i.test(l)), 'no line says Vault loads it under "Wait until I load it": ' + said.filter(l => /Vault loads/i.test(l)).join(' | '));
  assert.ok(said.some(l => /^\[AI scan\] not sending a scan to vis: .*The file waits until you load the model in LM Studio/.test(l)), said.join(' | '));

  // The user loads it in LM Studio: the file goes out and scans.
  visLoaded = true;
  await slots.refresh({ force: true });
  queue._recheck();
  await until(() => queue.status().done === 1);
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].model, 'vis');
});

test('with "Load it if there is room" the held file makes Vault load the model with lms, then scans', async () => {
  const loads = await fresh({ policy: 'room' });
  const f = addFile();
  queue.enqueue(f);
  await until(() => queue.status().done === 1);
  assert.deepStrictEqual(loads.map(l => l.modelKey), ['vis'], 'loaded once, by Vault');
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].model, 'vis');
  assert.strictEqual(queue.status().failed, 0);
  void f;
});

test('LM Studio 400 {"error":"terminated"} means the model went away mid-answer, not a bad file', () => {
  const err = Object.assign(new Error('API error: 400 Bad Request - {"error":"terminated"}'), { status: 400, body: '{"error":"terminated"}' });
  assert.strictEqual(modelHealth.isModelUnavailable(err), true);
  assert.match(modelHealth.describe(err), /unloaded the model while it was answering/);
  assert.doesNotMatch(modelHealth.describe(err), /—/);
  // Only the exact body: a reply that mentions the word is still an ordinary failure.
  for (const body of ['{"error":"the stream was terminated by a bad image"}', 'terminated', '{"message":"terminated"}']) {
    const e = Object.assign(new Error(`API error: 400 Bad Request - ${body}`), { status: 400, body });
    assert.strictEqual(modelHealth.isModelUnavailable(e), false, body);
  }
  // Not a 400: not this shape.
  const e500 = Object.assign(new Error('API error: 500 - {"error":"terminated"}'), { status: 500, body: '{"error":"terminated"}' });
  assert.strictEqual(modelHealth.isModelUnavailable(e500), false);
});

/* ── After the verifier's reproductions (owner's own sequence, Rescan,
      the translator, parked copies) ────────────────────────────────────── */

test('LM Studio starts after Vault saw it down: the first scan still does not load it just in time', async () => {
  await fresh();
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  assert.ok(!slots.endpointStates().some(st => st.reachable), 'Vault saw it down');
  await startLm();                       // the owner starts LM Studio; Vault has not looked yet
  await quietly(async () => {
    await assert.rejects(llm.postChat([{ role: 'user', content: 'x' }], { forScan: true }), (err) => err.notLoaded === true);
  });
  assert.strictEqual(chats.length, 0, 'nothing named the model while it was not loaded');
});

test('an lms ps that failed while LM Studio was down is asked again, not trusted for two minutes', async () => {
  await fresh({ policy: 'room' });
  await stopLm();
  await scanModel.maybeLoad({ target: 'vis' });            // lms ps fails: LM Studio is down
  await slots.refresh({ force: true }).catch(() => {});   // and Vault's probe sees it down
  assert.strictEqual(scanModel.canLoadNow(), false);
  await startLm();
  await quietly(async () => {
    await assert.rejects(llm.postChat([{ role: 'user', content: 'x' }], { forScan: true }), (err) => err.notLoaded === true);
  });
  assert.strictEqual(chats.length, 0);
  assert.strictEqual(scanModel.canLoadNow(), true);
});

test('the owner\'s run: "not running" wait, LM Studio starts, Try now: Vault loads the model once, nothing is sent before', async () => {
  const loads = await fresh({ policy: 'room' });
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  const f = addFile();
  await quietly(async () => {
    queue.enqueue(f);
    await until(() => queue.pausedBy() === 'waiting' || queue.pausedBy() === 'model');
    await startLm();                     // LM Studio comes up; the registry still says down
    queue.resume();                      // Try now, at once
    await until(() => queue.status().done === 1, 8000);
  });
  assert.strictEqual(queue.status().failed, 0);
  assert.strictEqual(loads.length, 1, 'loaded once, by Vault');
  assert.ok(chats.length >= 1 && chats.every(c => c.loadedThen), 'every scan went to a loaded model: ' + JSON.stringify(chats.map(c => c.loadedThen)));
});

async function rescan(id) {
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/media/${id}/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: res.status, body: await res.json() };
  } finally {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
}

test('Rescan with the scan model not loaded: Vault loads it the normal way, then scans', async () => {
  const loads = await fresh({ policy: 'room' });
  const f = addFile();
  const r = await quietly(() => rescan(f.id));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.ok, true);
  assert.deepStrictEqual(loads.map(l => l.modelKey), ['vis'], 'one lms load, not a just-in-time one');
  assert.strictEqual(chats.length, 1);
  assert.ok(chats[0].loadedThen, 'the scan went to the loaded model');
});

test('Rescan under "Wait until I load it": a plain message, nothing loaded, nothing sent', async () => {
  const loads = await fresh({ policy: 'wait' });
  const f = addFile();
  const r = await quietly(() => rescan(f.id));
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'SCAN_MODEL_NOT_LOADED');
  assert.strictEqual(r.body.error, 'vis is not loaded, and the setting is to wait until you load it. Load it in LM Studio, then scan again.');
  assert.doesNotMatch(r.body.error, /—/);
  assert.strictEqual(loads.length, 0);
  assert.strictEqual(chats.length, 0);
});

test('Rescan with the model loaded by hand under the user\'s own identifier: found and used, nothing loaded', async () => {
  const loads = await fresh({ policy: 'wait' });
  aliasId = 'my-vis';
  await slots.refresh({ force: true });
  const f = addFile();
  const r = await quietly(() => rescan(f.id));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(loads.length, 0);
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].model, 'my-vis');
});

test('Rescan where Vault cannot load models: it goes out as before', async () => {
  await fresh({ canLoad: false, policy: 'room' });
  const f = addFile();
  const r = await quietly(() => rescan(f.id));
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(chats.length, 1);
});

test('the subtitle translator inside a vision scan is not held by the guard: its lines are translated, as before', async () => {
  await fresh();
  const out = await quietly(() => slots.runScan({ scan: true, vision: true }, () => translator.translateLines(['hola'], 'es')));
  assert.deepStrictEqual(out, ['hello']);
  assert.strictEqual(chats.length, 1);
});

test('every copy parked in Vault while LM Studio has it loaded: Try now still sends to it, as before', async () => {
  await fresh();
  visLoaded = true;
  await slots.refresh({ force: true });
  slots.setEnabled(lmBase, 'vis', false);
  try {
    await quietly(() => llm.postChat([{ role: 'user', content: 'x' }], { forScan: true }));
    assert.strictEqual(chats.length, 1);
    assert.strictEqual(chats[0].model, 'vis');
  } finally {
    slots.setEnabled(lmBase, 'vis', true);
  }
});

/* ── After the second verifier's probes: LM Studio up but busy, bursts of
      scans, a Rescan that waits for a load, and the words ───────────────── */

const prep = { prepare: () => ({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 }) };
/** One vision scan, asked the way lib/vision-api.js asks (prepare, inside a scan). */
const visionScan = () => slots.runScan({ scan: true, vision: true }, () => llm.postChat(null, prep));
/** n of them at once: how each ended, and after how long. */
async function burst(n) {
  const t0 = Date.now();
  return Promise.all(Array.from({ length: n }, () => visionScan()
    .then(() => ({ sent: true, ms: Date.now() - t0 }), (e) => ({ sent: false, held: !!e.notLoaded, busy: !!e.lmBusy, msg: e.message, ms: Date.now() - t0 }))));
}

/** Vault saw LM Studio down, and it comes back with /api/v0/models not answering. */
async function backButBusy(mode) {
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  assert.ok(!slots.endpointStates().some(st => st.reachable), 'Vault saw it down');
  await startLm();
  v0Mode = mode;
}

test('LM Studio back up but its /api/v0/models answers 500: the scan waits, it is not sent', async () => {
  await fresh({ policy: 'room' });
  await backButBusy('500');
  let err = null;
  await quietly(async () => { try { await visionScan(); } catch (e) { err = e; } });
  assert.ok(err, 'the scan was not sent');
  assert.strictEqual(err.notLoaded, true, 'held the same way as a model that is not loaded');
  assert.strictEqual(err.modelUnavailable, true);
  assert.strictEqual(err.lmBusy, true);
  assert.strictEqual(err.message, 'LM Studio is busy and has not said which models are loaded');
  assert.strictEqual(chats.length, 0, 'nothing named the model, so nothing was loaded just in time');
  assert.strictEqual(slots.lmBusy(), true);
  assert.ok(said.some(l => /^\[AI scan\] not sending a scan to vis: LM Studio is busy .*The file waits until LM Studio answers\./.test(l)), said.join(' | '));
  assert.ok(!said.some(l => /—/.test(l)), 'no em dash');
});

test('LM Studio back up but its /api/v0/models does not answer at all: the scan waits, it is not sent', async () => {
  await fresh({ policy: 'room' });
  await backButBusy('hang');
  const r = await quietly(() => burst(3));          // three at once: one 4 s probe between them
  assert.deepStrictEqual(r.map(x => [x.sent, x.held, x.busy]), [[false, true, true], [false, true, true], [false, true, true]]);
  assert.strictEqual(chats.length, 0);
  assert.ok(Math.max(...r.map(x => x.ms)) < 6500, 'they shared one look: ' + r.map(x => x.ms).join(', '));
});

test('busy even while lms ps fails too (LM Studio is still starting): the scan waits', async () => {
  await fresh({ policy: 'room' });
  await stopLm();
  await scanModel.maybeLoad({ target: 'vis' });        // lms ps fails: LM Studio is down
  await slots.refresh({ force: true }).catch(() => {});
  await startLm();
  v0Mode = '500';
  D.psFail = true;
  const r = await quietly(() => burst(1));
  assert.deepStrictEqual([r[0].sent, r[0].held, r[0].busy], [false, true, true]);
  assert.strictEqual(chats.length, 0);
});

test('a server that never spoke /api/v0/models (not LM Studio) gets its scans as before', async () => {
  await fresh({ policy: 'room' });
  v0Mode = 'none';
  v1Ids = ['some-other-model'];           // it does not even list the scan model
  slots._reset([lmBase]);
  await slots.refresh({ force: true });
  assert.strictEqual(slots.speaksV0(lmBase), false);
  await quietly(() => visionScan());
  assert.strictEqual(chats.length, 1, 'sent, as it always was');
  assert.strictEqual(chats[0].model, 'vis');
  // The same after Vault saw it down and it came back.
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  await startLm();
  await quietly(() => visionScan());
  assert.strictEqual(chats.length, 2);
  assert.strictEqual(slots.lmBusy(), false, 'never "busy": it has no /api/v0/models to be quiet on');
});

test('where Vault cannot load (no lms), a busy LM Studio gets the scan as before', async () => {
  await fresh({ canLoad: false, policy: 'room' });
  await backButBusy('500');
  await quietly(() => visionScan());
  assert.strictEqual(chats.length, 1);
});

test('busy, in the queue: Try now holds the file with a plain reason, and it scans once LM Studio answers', async () => {
  const loads = await fresh({ policy: 'room' });
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  const f = addFile();
  await quietly(async () => {
    queue.enqueue(f);
    await until(() => queue.pausedBy() === 'waiting' || queue.pausedBy() === 'model');
    await startLm();
    v0Mode = '500';                      // up, but not saying what is loaded
    queue.resume();                      // Try now
    await until(() => queue.status().waiting && queue.status().waiting.code === 'lm-busy');
    await until(() => !queue.inFlight());
  });
  let st = queue.status();
  assert.strictEqual(chats.length, 0, 'no request named the model');
  assert.strictEqual(loads.length, 0, 'and Vault loaded nothing on top of a busy LM Studio');
  assert.strictEqual(st.failed, 0);
  assert.strictEqual(st.pendingCount, 1, 'the file waits in the line');
  assert.strictEqual(st.waiting.reason, 'LM Studio is busy and has not said which models are loaded. Files wait until it answers.');
  assert.doesNotMatch(st.waiting.reason, /—/);
  assert.strictEqual(st.waiting.loadable, false, 'no Load anyway while it is busy');
  assert.strictEqual(db.get().prepare('SELECT processing_error FROM media WHERE id = ?').get(f.id).processing_error, 'unscanned', 'no strike, the row is untouched');
  assert.ok(said.some(l => /files wait until LM Studio answers/.test(l)), said.join(' | '));

  // LM Studio answers again: the queue's own look picks the file up, Vault
  // loads the model the normal way and the file scans.
  await quietly(async () => {
    v0Mode = 'ok';
    await slots.refresh({ force: true });
    queue._recheck();
    await until(() => queue.status().done === 1, 8000);
  });
  assert.strictEqual(loads.length, 1, 'one lms load');
  assert.ok(chats.length >= 1 && chats.every(c => c.loadedThen), 'every scan went to a loaded model');
  assert.strictEqual(queue.status().failed, 0);
});

test('busy, with the "not answering" wait still up: the queue sends no trial file and says LM Studio is busy', async () => {
  await fresh({ policy: 'room' });
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  const f = addFile();
  await quietly(async () => {
    queue.enqueue(f);
    await until(() => queue.pausedBy() === 'waiting' && queue.status().waiting && queue.status().waiting.code === 'not-running');
    await startLm();
    v0Mode = '500';
    await slots.refresh({ force: true });
    queue._recheck();
    await sleep(50);
  });
  assert.strictEqual(queue.status().waiting.code, 'lm-busy');
  assert.strictEqual(chats.length, 0);
  // It turns out not to be busy after all (it went down again): the first reason is back.
  await quietly(async () => {
    await stopLm();
    await slots.refresh({ force: true }).catch(() => {});
    queue._recheck();
  });
  assert.strictEqual(queue.status().waiting.code, 'not-running');
  assert.strictEqual(queue.status().failed, 0);
  void f;
});

/* The third verifier's probes: the hold used to last four LOOKS, and anything
   that looks used them up (a Rescan polling: 2 s; Try now four times: 1.6 s;
   the queue's own poll: 94 s), after which Vault read /v1/models, believed
   the model loaded and named it. The patience is a stretch of time now, and a
   vision scan is held past it too. */

test('Rescan while LM Studio is busy (v0 answers 500): however often it looks, it never names the model', async () => {
  const loads = await fresh({ policy: 'room' });
  await backButBusy('500');
  const g0 = v0Gets;
  // Looking ten times a second for a while: more looks than the old four.
  const direct = await quietly(() => scanModel.loadForScan({ busyPollMs: 100, pollMs: 50, busyWaitMs: 1500 }));
  assert.ok(v0Gets - g0 >= 8, `it looked ${v0Gets - g0} times`);
  assert.deepStrictEqual(direct, { ok: false, code: 'lm-busy', reason: 'LM Studio is busy and has not answered yet. Scan again in a moment.' });
  assert.strictEqual(slots.lmBusy(), true, 'still busy: looking did not use anything up');
  // And through the route.
  scanModel._setRescanWait(null, 1200);
  const f = addFile();
  const r = await quietly(() => rescan(f.id));
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'SCAN_MODEL_NOT_LOADED');
  assert.strictEqual(r.body.error, 'LM Studio is busy and has not answered yet. Scan again in a moment.');
  assert.strictEqual(chats.length, 0, 'no request named the model');
  assert.strictEqual(loads.length, 0);
});

test('Rescan while LM Studio is busy (v0 does not answer at all): it never names the model', async () => {
  const loads = await fresh({ policy: 'room' });
  await backButBusy('hang');
  const r = await quietly(() => scanModel.loadForScan({ waitMs: 5000 }));      // two 4 s looks
  assert.deepStrictEqual(r, { ok: false, code: 'lm-busy', reason: 'LM Studio is busy and has not answered yet. Scan again in a moment.' });
  assert.strictEqual(chats.length, 0);
  assert.strictEqual(loads.length, 0);
});

test('Try now pressed six times while LM Studio is busy: the file is still held, nothing is sent', async () => {
  const loads = await fresh({ policy: 'room' });
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  const f = addFile();
  const g0 = v0Gets;
  await quietly(async () => {
    queue.enqueue(f);
    await until(() => queue.pausedBy() === 'waiting' || queue.pausedBy() === 'model');
    await startLm();
    v0Mode = '500';
    for (let i = 0; i < 6; i++) {
      queue.resume();
      await sleep(120);
      await until(() => !queue.inFlight());
      // Past the few seconds a look is shared for, so the next press looks again.
      await slots.refresh({ force: true });
    }
  });
  const st = queue.status();
  assert.ok(v0Gets - g0 >= 6, `looked ${v0Gets - g0} times`);
  assert.strictEqual(chats.length, 0, 'no request named the model');
  assert.strictEqual(loads.length, 0);
  assert.strictEqual(st.failed, 0);
  assert.strictEqual(st.pendingCount, 1);
  assert.strictEqual(st.waiting.code, 'lm-busy');
  assert.strictEqual(db.get().prepare('SELECT processing_error FROM media WHERE id = ?').get(f.id).processing_error, 'unscanned', 'more presses than strikes, and no strike');
});

test('LM Studio quiet for ten minutes: pictures still wait, Try now and Rescan still do not name the model, text requests go on', async () => {
  const loads = await fresh({ policy: 'room' });
  let t = Date.now();
  slots._setClock(() => t);
  await stopLm();
  await slots.refresh({ force: true }).catch(() => {});
  const f = addFile();
  await quietly(async () => {
    queue.enqueue(f);
    await until(() => queue.pausedBy() === 'waiting' || queue.pausedBy() === 'model');
    await startLm();
    v0Mode = '500';
    await slots.refresh({ force: true });
    queue._recheck();
    // The queue's own poll, every 12 s, for ten minutes.
    for (let i = 0; i < 50; i++) {
      t += 12_000;
      await slots.refresh({ force: true });
      queue._recheck();
    }
    await until(() => !queue.inFlight());
  });
  // Past the patience the registry holds LM Studio's /v1/models list (every
  // model on disk), as it does for the pickers. A vision scan does not trust it.
  const state = slots.endpointStates()[0];
  assert.strictEqual(state.reachable, true);
  assert.strictEqual(state.unverified, true);
  assert.ok(slots.pick('vis'), 'the list makes vis look loaded');
  assert.strictEqual(slots.lmBusy(), true);
  assert.strictEqual(chats.length, 0, 'the queue sent nothing in those ten minutes');
  assert.strictEqual(queue.status().pendingCount, 1);
  assert.strictEqual(queue.status().failed, 0);
  assert.strictEqual(queue.status().waiting.reason, 'LM Studio is busy and has not said which models are loaded. Files wait until it answers.');

  // Try now: looks again, holds again.
  await quietly(async () => { queue.resume(); await sleep(120); await until(() => !queue.inFlight()); });
  assert.strictEqual(chats.length, 0);
  assert.strictEqual(queue.status().pendingCount, 1);
  assert.strictEqual(queue.status().waiting.code, 'lm-busy');

  // A scan asked directly, and a Rescan: held, with the busy words.
  const r = await quietly(() => burst(2));
  assert.deepStrictEqual(r.map(x => [x.sent, x.held, x.busy]), [[false, true, true], [false, true, true]]);
  scanModel._setRescanWait(700);
  const rs = await quietly(() => rescan(f.id));
  assert.strictEqual(rs.status, 409);
  assert.strictEqual(rs.body.error, 'LM Studio is busy and has not answered yet. Scan again in a moment.');
  assert.strictEqual(chats.length, 0);
  assert.strictEqual(loads.length, 0);

  // Not a vision scan: goes out as it did before (the registry's list is used).
  await quietly(() => llm.postChat([{ role: 'user', content: 'x' }], { model: 'vis' }));
  assert.strictEqual(chats.length, 1);
  chats.length = 0;

  // LM Studio answers again: Vault loads the model the normal way and the file scans.
  await quietly(async () => {
    v0Mode = 'ok';
    await slots.refresh({ force: true });
    queue._recheck();
    await until(() => queue.status().done === 1, 8000);
  });
  assert.strictEqual(slots.endpointStates()[0].unverified, false);
  assert.strictEqual(loads.length, 1);
  assert.ok(chats.length >= 1 && chats.every(c => c.loadedThen));
});

test('six scans at once whose model is not loaded share one look at LM Studio', async () => {
  await fresh({ policy: 'room' });
  v0DelayMs = 300;
  const g0 = v0Gets;
  const r = await quietly(() => burst(6));
  assert.ok(r.every(x => !x.sent && x.held), JSON.stringify(r));
  assert.strictEqual(v0Gets - g0, 1, 'one probe for the six');
  assert.ok(Math.max(...r.map(x => x.ms)) < 900, 'none waited for another\'s probe: ' + r.map(x => x.ms).join(', '));
  assert.strictEqual(chats.length, 0);
  // A run of them, one after another, inside a few seconds: still that one look.
  await quietly(async () => { for (let i = 0; i < 3; i++) await visionScan().catch(() => {}); });
  assert.strictEqual(v0Gets - g0, 1);
  assert.strictEqual(chats.length, 0);
});

test('a look that found LM Studio down is never reused: the next scan looks again', async () => {
  await fresh({ policy: 'room' });
  await stopLm();
  await quietly(() => visionScan().catch(() => {}));     // looked, found it down, sent, failed
  await startLm();                                       // it starts a moment later
  const g0 = v0Gets;
  const r = await quietly(() => burst(1));
  assert.strictEqual(v0Gets - g0, 1, 'looked again');
  assert.deepStrictEqual([r[0].sent, r[0].held], [false, true]);
  assert.strictEqual(chats.length, 0, 'not loaded just in time');
});

test('six scans at once after a failed lms ps share one lms ps', async () => {
  await fresh({ policy: 'room' });
  D.psFail = true;
  await scanModel.maybeLoad({ target: 'vis' });
  assert.strictEqual(scanModel.canLoadNow(), false);
  D.psFail = false;
  D.psDelayMs = 200;
  const p0 = D.ps;
  const r = await quietly(() => burst(6));
  assert.strictEqual(D.ps - p0, 1, 'one lms ps for the six');
  assert.ok(r.every(x => !x.sent && x.held), JSON.stringify(r));
  assert.strictEqual(chats.length, 0);
});

test('an lms ps that keeps failing is asked once per burst, not once per scan, and again a few seconds later', async () => {
  await fresh({ policy: 'room' });
  let t = Date.now();
  D.now = () => t;
  D.psFail = true;
  await scanModel.maybeLoad({ target: 'vis' });
  const p0 = D.ps;
  const r = (await quietly(() => burst(4))).concat(await quietly(() => burst(4)));
  assert.strictEqual(D.ps - p0, 1, 'eight scans, one lms ps');
  assert.ok(r.every(x => x.sent), 'Vault cannot tell what is loaded, so they go out as before');
  assert.strictEqual(chats.length, 8);
  // LM Studio's lms answers again: seconds later it is believed, not two minutes later.
  D.psFail = false;
  t += 4000;
  const r2 = await quietly(() => burst(2));
  assert.strictEqual(D.ps - p0, 2);
  assert.ok(r2.every(x => !x.sent && x.held), JSON.stringify(r2));
  assert.strictEqual(chats.length, 8);
});

test('every copy parked in Vault: a run of scans looks at LM Studio once, not once per file', async () => {
  await fresh({ policy: 'room' });
  visLoaded = true;
  await slots.refresh({ force: true });
  slots.setEnabled(lmBase, 'vis', false);
  try {
    const g0 = v0Gets, p0 = D.ps;
    await quietly(async () => { for (let i = 0; i < 5; i++) await visionScan(); });
    assert.strictEqual(chats.length, 5, 'all sent, as before');
    assert.strictEqual(v0Gets - g0, 1, 'one look for the run');
    assert.strictEqual(D.ps - p0, 0);
  } finally {
    slots.setEnabled(lmBase, 'vis', true);
  }
});

test('with the model loaded, scans look at LM Studio zero times', async () => {
  await fresh({ policy: 'room' });
  visLoaded = true;
  await slots.refresh({ force: true });
  const g0 = v0Gets, p0 = D.ps;
  await quietly(() => burst(4));
  assert.strictEqual(chats.length, 4);
  assert.strictEqual(v0Gets - g0, 0);
  assert.strictEqual(D.ps - p0, 0);
});

/* Rescan: the wait for a load is watched. */

let web = null;
async function webBase() {
  if (!web) web = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return `http://127.0.0.1:${web.address().port}`;
}
test.after(async () => { if (web) { web.closeAllConnections?.(); await new Promise(r => web.close(r)); } });
async function timedRescan(id, opts = {}) {
  const base = await webBase();
  const t0 = Date.now();
  const res = await fetch(`${base}/api/media/${id}/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', ...opts });
  return { status: res.status, body: await res.json(), ms: Date.now() - t0 };
}

test('Rescan waiting for a load stops at once when playback starts under Auto', async () => {
  const loads = await fresh({ policy: 'room' });
  D.loadDelayMs = 2500;
  mode.set('auto');
  const f = addFile();
  try {
    const p = quietly(() => timedRescan(f.id));
    await until(() => loads.length === 1);
    playback.report('test-player', 'playing', { stale: false });
    const r = await p;
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'AI_SCAN_CUT_FOR_PLAYBACK');
    assert.match(r.body.error, /^Scan stopped because something started playing\./);
    assert.ok(r.ms < 1500, `answered while the load was still running (${r.ms} ms)`);
    assert.strictEqual(chats.length, 0, 'nothing was scanned');
  } finally {
    playback.report('test-player', 'idle');
    playback._reset();
    mode.set('on');
    await until(() => visLoaded);        // let the stub's load finish
  }
});

test('Rescan waiting for a load stops at once when AI scan is switched Off, and nothing is scanned or saved', async () => {
  const loads = await fresh({ policy: 'room' });
  D.loadDelayMs = 2500;
  const f = addFile();
  try {
    const p = quietly(() => timedRescan(f.id));
    await until(() => loads.length === 1);
    mode.set('off');
    const r = await p;
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, mode.OFF_CODE);
    assert.strictEqual(r.body.error, mode.OFF_ERROR);
    assert.ok(r.ms < 1500, `answered while the load was still running (${r.ms} ms)`);
    await until(() => visLoaded);        // the load ends, and still nothing goes out
    await sleep(700);
    assert.strictEqual(chats.length, 0, 'no scan was sent');
    assert.strictEqual(db.get().prepare('SELECT processing_error, description FROM media WHERE id = ?').get(f.id).processing_error, 'unscanned', 'nothing saved');
  } finally {
    mode.set('on');
  }
});

test('Rescan waiting for a load stops at once when the vault locks', async () => {
  const loads = await fresh({ policy: 'room' });
  D.loadDelayMs = 2500;
  const f = addFile();
  const p = quietly(() => timedRescan(f.id));
  await until(() => loads.length === 1);
  D.locked = true;
  const r = await p;
  D.locked = false;
  assert.strictEqual(r.status, 423);
  assert.strictEqual(r.body.code, 'VAULT_LOCKED');
  assert.strictEqual(r.body.error, 'Vault is locked. Unlock it first.');
  assert.ok(r.ms < 1500, `answered while the load was still running (${r.ms} ms)`);
  await until(() => visLoaded);
  await sleep(700);
  assert.strictEqual(chats.length, 0);
});

test('Rescan waiting for a load stops when the person who asked goes away: nothing is scanned', async () => {
  const loads = await fresh({ policy: 'room' });
  D.loadDelayMs = 2500;
  const f = addFile();
  const ac = new AbortController();
  const p = quietly(() => timedRescan(f.id, { signal: ac.signal }).catch((e) => ({ aborted: e.name })));
  await until(() => loads.length === 1);
  ac.abort();
  assert.deepStrictEqual(await p, { aborted: 'AbortError' });
  // The wait ended within a poll: the file is free to be rescanned again
  // (it would answer "already being rescanned" otherwise).
  await sleep(900);
  assert.ok(!visLoaded, 'the load is still running');
  const again = await quietly(() => timedRescan(f.id));
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.strictEqual(loads.length, 1, 'still one lms load');
  assert.strictEqual(chats.length, 1, 'one scan: the second request\'s, not the abandoned one\'s');
  assert.ok(chats[0].loadedThen);
});

/* Rescan: the words. A clock of the test's own, 100 times faster, so "20
   seconds" passes in 200 ms. */
function fastClock() {
  const real0 = Date.now();
  D.now = () => real0 + (Date.now() - real0) * 100;
}

test('Rescan: LM Studio lists the model 20 s after the load finished: it waits for that and scans', async () => {
  const loads = await fresh({ policy: 'room' });
  fastClock();
  D.listLagMs = 200;                     // 20 s on the test's clock
  const r = await quietly(() => scanModel.loadForScan({ pollMs: 10 }));
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(loads.length, 1);
  assert.ok(slots.pick('vis'), 'the registry has it');
});

test('Rescan: loaded but never listed within the wait says it is still loading, not that it is not answering', async () => {
  const loads = await fresh({ policy: 'room' });
  fastClock();
  D.listLagMs = 60_000;                  // not inside this test
  const r = await quietly(() => scanModel.loadForScan({ pollMs: 10, waitMs: 40_000 }));   // 400 ms
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'loading');
  assert.strictEqual(r.reason, 'vis is still loading in LM Studio. Scan again in a moment.');
  assert.strictEqual(loads.length, 1);
});

test('Rescan: a model lms lists that nobody just loaded and LM Studio never shows is "loaded but not answering", after a while', async () => {
  const loads = await fresh({ policy: 'room' });
  fastClock();
  D.psListsVis = true;
  const t0 = Date.now();
  const r = await quietly(() => scanModel.loadForScan({ pollMs: 10 }));      // grace 30 s = 300 ms
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'listed-dead');
  assert.match(r.reason, /^vis is loaded in LM Studio but is not answering\./);
  assert.ok(Date.now() - t0 >= 250, 'only after the grace');
  assert.strictEqual(loads.length, 0, 'never a second copy');
});

test('Rescan after a failed load says so in its own words, the second time too', async () => {
  const loads = await fresh({ policy: 'room' });
  D.loadFails = true;
  const f = addFile();
  const want = 'LM Studio could not load vis: exit code 1 (out of memory). Load it in LM Studio, then scan again.';
  for (const n of [1, 2]) {
    const r = await quietly(() => rescan(f.id));
    assert.strictEqual(r.status, 409, `rescan ${n}`);
    assert.strictEqual(r.body.code, 'SCAN_MODEL_NOT_LOADED');
    assert.strictEqual(r.body.error, want, `rescan ${n}`);
    assert.doesNotMatch(r.body.error, /tries again|—/);
  }
  assert.strictEqual(loads.length, 1, 'the failed load is not repeated by the second Rescan');
  assert.strictEqual(chats.length, 0);
});

test('Rescan while LM Studio is busy waits for it, and says so plainly when it stays busy', async () => {
  const loads = await fresh({ policy: 'room' });
  await backButBusy('500');
  await slots.refresh({ force: true });
  assert.strictEqual(slots.lmBusy(), true);
  // Asked of the wait directly, with a slow poll, so it is still inside the
  // four quiet looks (the test before last) when the wait runs out.
  const r = await quietly(() => scanModel.loadForScan({ pollMs: 200, waitMs: 300 }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'lm-busy');
  assert.strictEqual(r.reason, 'LM Studio is busy and has not answered yet. Scan again in a moment.');
  assert.strictEqual(loads.length, 0);
  assert.strictEqual(chats.length, 0);
});

/* The log lines. */

test('the "not sending" line follows the setting: Vault loads it only where it may', async () => {
  await fresh({ policy: 'room' });
  await quietly(() => visionScan().catch(() => {}));
  assert.ok(said.some(l => /^\[AI scan\] not sending a scan to vis: .*Vault loads the model itself when the setting and the free GPU memory allow\./.test(l)), said.join(' | '));
  await fresh({ policy: 'wait' });
  await quietly(() => visionScan().catch(() => {}));
  assert.ok(said.some(l => /^\[AI scan\] not sending a scan to vis: /.test(l)));
  assert.ok(!said.some(l => /Vault loads/i.test(l)), said.join(' | '));
});

test('a scan that was not sent names its model in the failure line, not "model -"', async () => {
  await fresh({ policy: 'room' });
  const jpg = path.join(tmp, 'frame.jpg');
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, 338 >> 8, 338 & 255, 600 >> 8, 600 & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  fs.writeFileSync(jpg, Buffer.concat([Buffer.from([0xFF, 0xD8]), sof, Buffer.from([0xFF, 0xD9])]));
  await quietly(() => assert.rejects(
    slots.runScan({ scan: true, vision: true }, () => vision.analyze([jpg], 'p.jpg', 'image')),
    (err) => err.notLoaded === true));
  const line = said.find(l => /\[HTTP /.test(l));
  assert.ok(line, said.join(' | '));
  assert.match(line, /\[HTTP -, model vis, .*not sent\]/);
  assert.doesNotMatch(line, /model -/);
  assert.strictEqual(chats.length, 0);
});

test('a scan sent where Vault has no copy in its list still names its model when it fails', async () => {
  await fresh({ canLoad: false, policy: 'room' });
  await stopLm();                          // nothing is listening: the request fails
  let err = null;
  await quietly(async () => { try { await visionScan(); } catch (e) { err = e; } });
  assert.ok(err);
  assert.strictEqual(err.modelId, 'vis');
});

/* ── After the fourth verifier: what Vault knows about a server it has not
      seen answer /api/v0/models in this run, quiet that is not continuous,
      and a busy Rescan's patience ─────────────────────────────────────── */

const SEEN_FILE = process.env.VAULT_LM_SEEN_FILE;
const seenInFile = () => { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')).v0; } catch { return null; } };

/** A queue file, and how it stands once the queue has settled. */
async function queued(f) {
  queue.enqueue(f);
  await sleep(150);
  await until(() => !queue.inFlight());
  return queue.status();
}

test('Vault restarted while LM Studio is busy: it remembers the server is LM Studio and holds the scans', async () => {
  const loads = await fresh({ policy: 'room' });         // v0 answered: written down
  assert.deepStrictEqual(seenInFile(), [lmBase], 'URLs only, beside the settings file (a temp file here)');
  v0Mode = '500';
  slots._restart([lmBase]);                               // a new run of Vault
  assert.strictEqual(slots.speaksV0(lmBase), true, 'known before it has answered anything');
  await slots.refresh({ force: true });
  assert.strictEqual(slots.lmBusy(), true);
  const r = await quietly(() => burst(2));
  assert.deepStrictEqual(r.map(x => [x.sent, x.held, x.busy]), [[false, true, true], [false, true, true]]);
  const st = await quietly(() => queued(addFile()));
  assert.strictEqual(st.waiting && st.waiting.code, 'lm-busy');
  assert.strictEqual(st.failed, 0);
  scanModel._setRescanWait(null, 600);
  const rs = await quietly(() => rescan(addFile().id));
  assert.strictEqual(rs.status, 409);
  assert.strictEqual(rs.body.error, 'LM Studio is busy and has not answered yet. Scan again in a moment.');
  assert.strictEqual(chats.length, 0, 'nothing named the model');
  assert.strictEqual(loads.length, 0);
});

for (const mode of ['500', 'hang']) {
  test(`Vault started while LM Studio was closed, never seen before; LM Studio starts with v0 ${mode === 'hang' ? 'not answering' : 'answering 500'}: the waiting file is held, then scanned`, async () => {
    const loads = await fresh({ policy: 'room' });
    await stopLm();
    slots._reset([lmBase]);                               // no memory of this server at all
    await slots.refresh({ force: true }).catch(() => {});
    assert.strictEqual(slots.speaksV0(lmBase), false);
    const f = addFile();
    await quietly(async () => {
      queue.enqueue(f);
      await until(() => queue.pausedBy() === 'waiting' || queue.pausedBy() === 'model');
      await startLm();
      v0Mode = mode;
      queue.resume();                                     // Try now, as LM Studio comes up
      await until(() => queue.status().waiting && queue.status().waiting.code === 'lm-busy', 12000);
      await until(() => !queue.inFlight());
    });
    assert.strictEqual(chats.length, 0, 'the file was not sent naming a model that is not loaded');
    assert.strictEqual(loads.length, 0);
    assert.strictEqual(queue.status().failed, 0);
    assert.strictEqual(slots.speaksV0(lmBase), true, 'taken for LM Studio: on this PC, lms installed, v0 quiet');
    const r = await quietly(() => burst(1));
    assert.deepStrictEqual([r[0].sent, r[0].held, r[0].busy], [false, true, true]);
    await quietly(async () => {
      v0Mode = 'ok';
      await slots.refresh({ force: true });
      queue._recheck();
      await until(() => queue.status().done === 1, 8000);
    });
    assert.strictEqual(loads.length, 1, 'Vault loaded the model the normal way');
    assert.ok(chats.length >= 1 && chats.every(c => c.loadedThen));
  });
}

test('never seen before, LM Studio starts answering normally: Vault loads the model and scans, no hold (control)', async () => {
  const loads = await fresh({ policy: 'room' });
  await stopLm();
  slots._reset([lmBase]);
  await slots.refresh({ force: true }).catch(() => {});
  const f = addFile();
  await quietly(async () => {
    queue.enqueue(f);
    await until(() => queue.pausedBy() === 'waiting' || queue.pausedBy() === 'model');
    await startLm();
    queue.resume();
    await until(() => queue.status().done === 1, 8000);
  });
  assert.strictEqual(loads.length, 1);
  assert.ok(chats.length >= 1 && chats.every(c => c.loadedThen));
  assert.strictEqual(queue.status().failed, 0);
});

/* Servers that are not LM Studio go out as before, with lms installed or not. */
for (const lmsThere of [true, false]) {
  for (const [mode, what] of [['none', 'answers 404 on /api/v0/models (Ollama, llama.cpp)'], ['other', 'answers /api/v0/models with a list of its own']]) {
    test(`a local server that ${what}, lms ${lmsThere ? 'installed' : 'not installed'}: scans, the queue and Rescan go out as before`, async () => {
      const loads = await fresh({ canLoad: lmsThere, policy: 'room' });
      v0Mode = mode;
      slots._reset([lmBase]);
      await slots.refresh({ force: true });
      assert.strictEqual(slots.speaksV0(lmBase), false, 'it said it is not LM Studio');
      assert.strictEqual(slots.lmBusy(), false);
      await quietly(() => visionScan());
      assert.strictEqual(chats.length, 1);
      const st = await quietly(async () => { queue.enqueue(addFile()); await until(() => queue.status().done === 1); return queue.status(); });
      assert.strictEqual(st.failed, 0);
      assert.strictEqual(chats.length, 2);
      const rs = await quietly(() => rescan(addFile().id));
      assert.strictEqual(rs.status, 200, JSON.stringify(rs.body));
      assert.strictEqual(chats.length, 3);
      assert.strictEqual(loads.length, 0);
      // The same when Vault first meets it after seeing it down.
      await stopLm();
      await slots.refresh({ force: true }).catch(() => {});
      await startLm();
      await quietly(() => visionScan());
      assert.strictEqual(chats.length, 4);
    });
  }
}

test('a local server whose /api/v0/models only ever errors: held as a guess with lms installed, for three minutes at most, then as before', async () => {
  await fresh({ policy: 'room' });
  let t = Date.now();
  slots._setClock(() => t);
  v0Mode = '500';
  slots._reset([lmBase]);
  slots._setClock(() => t);
  try { fs.unlinkSync(SEEN_FILE); } catch {}
  await slots.refresh({ force: true });
  assert.strictEqual(slots.lmBusy(), true, 'could be LM Studio starting');
  let r = await quietly(() => burst(1));
  assert.deepStrictEqual([r[0].sent, r[0].held, r[0].busy], [false, true, true]);
  for (let i = 0; i < 20; i++) { t += 10_000; await slots.refresh({ force: true }); }   // 3 min 20 s, looked at all along
  assert.strictEqual(slots.lmBusy(), false, 'it never confirmed it: a plain server from now on');
  assert.strictEqual(slots.speaksV0(lmBase), false);
  r = await quietly(() => burst(1));
  assert.strictEqual(r[0].sent, true);
  assert.strictEqual(chats.length, 1);
  await slots.refresh({ force: true });
  assert.strictEqual(slots.lmBusy(), false, 'and it is not guessed again');
  assert.strictEqual(seenInFile(), null, 'a guess is never written down');
});

test('the same server with lms not installed is never held', async () => {
  await fresh({ canLoad: false, policy: 'room' });
  v0Mode = '500';
  slots._reset([lmBase]);
  await slots.refresh({ force: true });
  assert.strictEqual(slots.lmBusy(), false);
  await quietly(() => visionScan());
  assert.strictEqual(chats.length, 1);
});

test('an address LM Studio once answered on, now another server (404 on v0 all along): forgotten after three minutes, then as before', async () => {
  await fresh({ policy: 'room' });
  let t = Date.now();
  slots._setClock(() => t);
  assert.ok(seenInFile().includes(lmBase));
  v0Mode = 'none';
  await slots.refresh({ force: true });
  assert.strictEqual(slots.speaksV0(lmBase), true, 'one 404 is not enough to forget it');
  for (let i = 0; i < 20; i++) { t += 10_000; await slots.refresh({ force: true }); }
  assert.strictEqual(slots.speaksV0(lmBase), false);
  assert.ok(!seenInFile().includes(lmBase), 'and no longer written down');
  await quietly(() => visionScan());
  assert.strictEqual(chats.length, 1, 'sent, as to any server that is not LM Studio');
});

test('the memory file missing, corrupt or not writable is harmless', async () => {
  await fresh({ policy: 'room' });
  fs.writeFileSync(SEEN_FILE, '{ this is not json');
  slots._restart([lmBase]);
  assert.strictEqual(slots.speaksV0(lmBase), false, 'nothing remembered, nothing thrown');
  await slots.refresh({ force: true });
  assert.strictEqual(slots.speaksV0(lmBase), true);
  assert.deepStrictEqual(seenInFile(), [lmBase], 'written again');
  fs.writeFileSync(SEEN_FILE, JSON.stringify({ v0: [42, null, 'ftp://x', lmBase, { a: 1 }] }));
  slots._restart([lmBase]);
  assert.strictEqual(slots.speaksV0(lmBase), true, 'only the URLs are read');
  // A place that cannot be written (a folder): this run still knows, nothing throws.
  process.env.VAULT_LM_SEEN_FILE = tmp;
  try {
    slots._restart([lmBase]);
    assert.strictEqual(slots.speaksV0(lmBase), false);
    await slots.refresh({ force: true });
    assert.strictEqual(slots.speaksV0(lmBase), true);
  } finally {
    process.env.VAULT_LM_SEEN_FILE = SEEN_FILE;
  }
});

test('two quiet looks four minutes apart with the model loaded are two blips: scans carry on', async () => {
  await fresh({ policy: 'room' });
  let t = Date.now();
  slots._setClock(() => t);
  visLoaded = true;
  await slots.refresh({ force: true });
  v0Mode = '500';
  await slots.refresh({ force: true });        // one failed look
  t += 240_000;                                // nobody looks for four minutes
  await slots.refresh({ force: true });        // and another
  assert.strictEqual(slots.endpointStates()[0].unverified, false);
  assert.strictEqual(slots.lmBusy(), false);
  const r = await quietly(() => burst(3));
  assert.ok(r.every(x => x.sent), JSON.stringify(r));
  assert.strictEqual(chats.length, 3);
  // Quiet that IS watched all along still runs out after three minutes.
  for (let i = 0; i < 20; i++) { t += 10_000; await slots.refresh({ force: true }); }
  assert.strictEqual(slots.endpointStates()[0].unverified, true);
});

test('Rescan while LM Studio is busy looks every two seconds and gives its answer after a minute, not five', async () => {
  const loads = await fresh({ policy: 'room' });
  await backButBusy('500');
  fastClock();                                 // a minute in 600 ms
  const t0 = D.now();
  const g0 = v0Gets;
  const r = await quietly(() => scanModel.loadForScan({ pollMs: 5 }));
  const took = D.now() - t0;
  assert.deepStrictEqual(r, { ok: false, code: 'lm-busy', reason: 'LM Studio is busy and has not answered yet. Scan again in a moment.' });
  assert.ok(took >= 58_000 && took < 80_000, `answered after ${Math.round(took / 1000)} s on the test's clock`);
  assert.ok(v0Gets - g0 <= 34, `${v0Gets - g0} looks, about one every two seconds`);
  assert.strictEqual(chats.length, 0);
  assert.strictEqual(loads.length, 0);
});

test('Rescan: a load of Vault\'s own that takes longer than a minute is still waited for, with LM Studio quiet meanwhile', async () => {
  const loads = await fresh({ policy: 'room' });
  fastClock();
  D.loadDelayMs = 900;                         // a minute and a half on the test's clock
  setTimeout(() => { v0Mode = '500'; }, 50).unref();
  setTimeout(() => { v0Mode = 'ok'; }, 880).unref();
  const r = await quietly(() => scanModel.loadForScan({ pollMs: 10 }));
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(loads.length, 1);
});
