/**
 * Settings > General > AI scan (lib/ai-scan-mode.js) and what each mode does
 * to the import queue (lib/import-queue.js), against a stub LM Studio whose
 * chat answers slowly, so a scan can be caught in flight:
 *
 * - the setting: default On, only off / on / auto, stored, heard live
 * - Off: nothing is queued (import, watcher "Add and analyse", retry), no
 *   look at LM Studio, no model load, face search fires right after import,
 *   switching Off mid-queue lets the file in flight finish and drops the rest
 * - Auto: playback cuts the file in flight off at once (its model request is
 *   aborted, nothing is written, it goes back to the front), nothing starts
 *   while something plays, scanning resumes after the settle delay, a pause
 *   held too long stops counting, and the held queue is idle for the vault
 * - On: playback changes nothing
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-aiscan-'));
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
const importAdd = require('../lib/import-add');
const mode = require('../lib/ai-scan-mode');
const playback = require('../lib/playback-activity');
const appSettings = require('../lib/app-settings');
const scan = require('../commands/scan');

const GB = 1024 ** 3;
let server;
let base;
let chatDelayMs = 0;
let modelPolls = 0;              // GETs of the model lists: "looking at LM Studio"
const chats = [];                // { aborted } per chat request the stub saw
const calls = [];                // files processFile was asked to scan
const loads = [];
const skipped = [];              // done-listener items that were never scanned

test.before(async () => {
  db.init();
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      modelPolls++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const data = [{ id: 'vis', type: 'vlm', state: 'loaded' }];
      res.end(JSON.stringify({ data }));
      return;
    }
    // Chat: answer after chatDelayMs, unless the caller hangs up first.
    const rec = { aborted: false };
    chats.push(rec);
    req.on('data', () => {});
    res.on('close', () => { if (!res.writableEnded) rec.aborted = true; });
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"description":"ok"}' } }] }));
    }, chatDelayMs);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  // processFile as the processors behave: one model call; a "model
  // unavailable" error comes back as a result, never written to the row.
  scan.processFile = async (file) => {
    calls.push(file.path);
    try {
      await llm.postChat([{ role: 'user', content: 'describe' }]);
      db.get().prepare('UPDATE media SET processing_error = NULL, description = ? WHERE filepath = ?').run('ok', file.path);
      return { success: true };
    } catch (err) {
      if (err.modelUnavailable) return { error: err.message, modelUnavailable: true };
      db.get().prepare('UPDATE media SET processing_error = ? WHERE filepath = ?').run(err.message, file.path);
      return { error: err.message };
    }
  };
  queue.onItemDone((item) => { if (item.scanSkipped) skipped.push(item); });
});

test.after(async () => {
  await drain();
  scanModel.stop();
  slots.stop();
  playback._reset();
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let seq = 0;
function addFile() {
  const name = `f${++seq}.mp4`;
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, 'video', 'unscanned')")
    .run(fp, name).lastInsertRowid);
  return { id, filepath: fp, filename: name, mediaType: 'video' };
}
const rowOf = (id) => db.get().prepare('SELECT processing_error, description FROM media WHERE id = ?').get(id);

/** Nothing queued, nothing in flight (a file cut off in one test must not run into the next). */
async function drain() {
  mode.set('on');
  playback._reset();
  queue.cancel();
  chatDelayMs = 0;
  await until(() => queue.status().active.length === 0, 5000);
  queue.cancel();
}

async function fresh(m = 'on') {
  await drain();
  playback._reset();
  playback._setTimings({ staleMs: playback.STALE_MS, pauseGraceMs: playback.PAUSE_GRACE_MS });
  queue._setTimings({ settleMs: 15_000 });
  calls.length = 0;
  chats.length = 0;
  loads.length = 0;
  skipped.length = 0;
  chatDelayMs = 0;
  slots._reset([base]);
  llm.setSessionModel(null);
  scanModel._reset();
  scanModel._setDeps({
    listModels: async () => [{ modelKey: 'vis', sizeBytes: GB, type: 'llm', vision: true }],
    readGpu: async () => ({ freeBytes: 20 * GB, totalBytes: 24 * GB, gpus: 1 }),
    canLoad: () => ({ ok: true }),
    psRows: async () => [],
    load: async (o) => { loads.push(o.modelKey); return { ok: true }; },
    refresh: () => slots.refresh({ force: true }),
    loadedFamilies: () => slots.activeFamilies(),
    isLocked: () => false,
  });
  scanModel.setSettings({ scanModel: 'vis', whenNotLoaded: 'room', gpuFreeForWatch: false });
  await slots.refresh({ force: true });
  mode.set(m);
  modelPolls = 0;
}

/* ── The setting ───────────────────────────────────────────────────────── */

test('the setting: On by default, only off / on / auto, stored and heard live', () => {
  // A fresh settings file: nothing stored, the default applies.
  const child = require('node:child_process').execFileSync(process.execPath,
    ['-p', 'require("./lib/ai-scan-mode").get()'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, VAULT_SETTINGS_FILE: path.join(tmp, 'none.json') } }).trim();
  assert.strictEqual(child, 'on');
  assert.strictEqual(mode.DEFAULT, 'on');
  assert.deepStrictEqual(mode.MODES, ['off', 'on', 'auto']);

  const heard = [];
  mode.onChange((m, prev) => heard.push(`${prev}>${m}`));
  for (const bad of ['OFF', '', null, true, 1, 'sometimes']) {
    assert.throws(() => mode.set(bad), (e) => e.code === 'BAD_MODE');
  }
  mode.set('on');
  mode.set('auto');
  assert.strictEqual(appSettings.all().aiScan, 'auto', 'stored with the other server settings');
  mode.set('auto');
  mode.set('on');
  assert.deepStrictEqual(heard, ['on>auto', 'auto>on'], 'listeners hear each real change once');

  // A stored value that is not a mode falls back to On.
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ aiScan: 'maybe' }));
  const out = require('node:child_process').execFileSync(process.execPath,
    ['-p', 'require("./lib/ai-scan-mode").get()'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', env: { ...process.env, VAULT_SETTINGS_FILE: bad } }).trim();
  assert.strictEqual(out, 'on');
});

/* ── Off ───────────────────────────────────────────────────────────────── */

test('Off: an import queues nothing and face search hears about the new files at once', async () => {
  await fresh('off');
  const dir = path.join(tmp, 'drop');
  fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'new-a.mp4');
  const b = path.join(dir, 'new-b.jpg');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const out = importAdd.addPaths([a, b]);
  assert.strictEqual(out.added.length, 2, 'the files are added');
  assert.strictEqual(out.queued, false);
  assert.strictEqual(queue.status().pendingCount, 0);
  assert.strictEqual(queue.status().total, 0);
  assert.deepStrictEqual(skipped.map(s => s.filepath).sort(), [a, b].sort());
  assert.ok(skipped.every(s => s.fresh), 'fresh, so the face auto-index hook acts on them');
  for (const x of out.added) assert.strictEqual(rowOf(x.id).processing_error, 'unscanned', 'a plain never-scanned row');
  await sleep(50);
  assert.strictEqual(calls.length, 0);
});

test('Off: a watched folder set to Add and analyse adds only, and retries are refused by the queue', async () => {
  await fresh('off');
  const dir = path.join(tmp, 'watch');
  fs.mkdirSync(dir, { recursive: true });
  const w = path.join(dir, 'watched.mp4');
  fs.writeFileSync(w, 'w');
  // What lib/watchers/manager.js does for an "Add and analyse" folder.
  const out = importAdd.addPaths([w], { analyse: true, watchNew: true, source: 'watch', folder: dir });
  assert.strictEqual(out.added.length, 1);
  assert.strictEqual(out.queued, false);
  // ...and for a changed file never analysed (manager.js enqueueScan).
  const f = addFile();
  const r = queue.enqueue({ ...f, source: 'watch', folder: dir });
  assert.strictEqual(r.added, false);
  assert.strictEqual(r.off, true);
  assert.strictEqual(queue.status().pendingCount, 0);
  assert.strictEqual(queue.isActive(), false, 'nothing for the vault scan probe');
  assert.strictEqual(calls.length, 0);
});

test('On: Add only (analyse false) also tells face search straight after the import', async () => {
  await fresh('on');
  const p = path.join(tmp, 'drop', 'addonly.mp4');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
  importAdd.addPaths([p], { analyse: false });
  assert.deepStrictEqual(skipped.map(s => s.filepath), [p]);
  assert.strictEqual(queue.status().pendingCount, 0);
});

test('Off: no look at LM Studio and no model load, even with files that were waiting', async () => {
  await fresh('on');
  slots.stop();
  modelPolls = 0;
  mode.set('off');
  // boot() does its one first look only when AI scan is not Off.
  slots.boot({ activeProbe: () => true });
  await sleep(50);
  slots.stop();
  assert.strictEqual(modelPolls, 0, 'boot did not look at LM Studio');
  const w = await scanModel.maybeLoad({ force: true, target: 'vis' });
  assert.strictEqual(w.code, 'locked', 'nothing is loaded for a scan that will not run');
  assert.deepStrictEqual(loads, []);
  scanModel._markVaultLoaded('vis');
  scanModel._setLastBusy(0);
  scanModel.setSettings({ unloadIdleMin: 1 });
  assert.deepStrictEqual(await scanModel.unloadIfIdle(), [], 'nor unloaded');
});

test('switching Off mid-queue: the file in flight finishes, the rest are dropped and stay unscanned', async () => {
  await fresh('on');
  queue.setConcurrency(1);
  chatDelayMs = 300;
  const files = [addFile(), addFile(), addFile()];
  for (const f of files) queue.enqueue({ ...f, fresh: true });
  await until(() => queue.status().active.length === 1);
  const inFlight = queue.status().active[0].id;
  mode.set('off');
  assert.strictEqual(queue.status().pendingCount, 0, 'the queue is empty at once');
  await until(() => queue.status().active.length === 0);
  assert.strictEqual(calls.length, 1, 'nothing new started');
  assert.strictEqual(rowOf(inFlight).description, 'ok', 'the file in flight finished');
  for (const f of files.filter(x => x.id !== inFlight)) {
    assert.strictEqual(rowOf(f.id).processing_error, 'unscanned', 'dropped files simply stay never scanned');
  }
  assert.strictEqual(skipped.length, 2, 'the dropped fresh files go on to face search');
  // Back On: nothing is rescanned by itself.
  mode.set('on');
  await sleep(50);
  assert.strictEqual(calls.length, 1);
  queue.setWorkersPerInstance(2);
});

/* ── Auto ──────────────────────────────────────────────────────────────── */

test('Auto: playback cuts the scan in flight off at once and puts it back first', async () => {
  await fresh('auto');
  queue.setConcurrency(1);
  chatDelayMs = 2000;
  const [a, b] = [addFile(), addFile()];
  queue.enqueue(a);
  queue.enqueue(b);
  await until(() => chats.length === 1);
  const t0 = Date.now();
  playback.report('tab:abcdef', 'playing');
  await until(() => queue.status().active.length === 0, 1500);
  assert.ok(Date.now() - t0 < 1000, 'cut off at once, not when the model answered');
  await until(() => chats[0].aborted, 1000);
  assert.strictEqual(rowOf(a.id).processing_error, 'unscanned', 'nothing written: the partial result is thrown away');
  assert.strictEqual(rowOf(a.id).description, null);
  const s = queue.status();
  assert.deepStrictEqual(s.pending.map(p => p.id), [a.id, b.id], 'back at the front of the queue');
  assert.strictEqual(s.failed, 0, 'not a failure');
  assert.strictEqual(s.waiting.code, 'playback');
  assert.match(s.waiting.reason, /set to Auto, so files wait while something plays/);
  assert.strictEqual(s.pausedBy, 'waiting');
  assert.strictEqual(queue.isActive(), false, 'held for playback: no hold on the autolock');
  queue.setWorkersPerInstance(2);
});

test('Auto: nothing starts while playing; scanning resumes after the settle delay', async () => {
  await fresh('auto');
  queue._setTimings({ settleMs: 300 });
  playback.report('tab:abcdef', 'playing');
  const f = addFile();
  queue.enqueue(f);
  await sleep(100);
  assert.strictEqual(calls.length, 0, 'nothing starts while something plays');
  assert.strictEqual(queue.isActive(), false);
  assert.strictEqual(modelPolls, 0, 'and LM Studio is not even looked at');
  playback.report('tab:abcdef', 'idle');
  const stopped = Date.now();
  await sleep(150);
  assert.strictEqual(calls.length, 0, 'still settling');
  assert.strictEqual(queue.status().waiting.code, 'playback');
  await until(() => rowOf(f.id).description === 'ok', 3000);
  assert.ok(Date.now() - stopped >= 290, 'not before the settle delay');
  // A next track inside the settle window keeps it held: no flapping.
  queue._setTimings({ settleMs: 300 });
});

test('Auto: a pause held too long stops counting, and a tab that goes quiet stops counting', async () => {
  await fresh('auto');
  queue._setTimings({ settleMs: 50 });
  playback._setTimings({ pauseGraceMs: 200, staleMs: 400 });
  playback.report('tab:paused1', 'paused');
  assert.strictEqual(playback.isPlaying(), true, 'just paused still counts');
  const f = addFile();
  queue.enqueue(f);
  await sleep(100);
  assert.strictEqual(calls.length, 0);
  await until(() => rowOf(f.id).description === 'ok', 3000);   // grace 200 + settle 50, no report needed

  playback.report('tab:quiet01', 'playing');
  assert.strictEqual(playback.isPlaying(), true);
  await until(() => !playback.isPlaying(), 2000);       // stale after 400 ms without a beat
});

test('Auto: Stage-style reports never go stale; a pause still runs out', async () => {
  playback._reset();
  playback._setTimings({ pauseGraceMs: 150, staleMs: 100 });
  playback.report('stage', 'playing', { stale: false });
  await sleep(200);
  assert.strictEqual(playback.isPlaying(), true, 'Stage says itself when it stops');
  playback.report('stage', 'paused', { stale: false });
  await until(() => !playback.isPlaying(), 1000);
  playback.report('stage', 'idle');
  playback._setTimings({ staleMs: playback.STALE_MS, pauseGraceMs: playback.PAUSE_GRACE_MS });
});

test('On: playback changes nothing', async () => {
  await fresh('on');
  playback.report('tab:abcdef', 'playing');
  const f = addFile();
  queue.enqueue(f);
  await until(() => rowOf(f.id).description === 'ok');
  assert.strictEqual(queue.status().waiting, null);
});

test('switching to Auto while something plays cuts the file in flight off', async () => {
  await fresh('on');
  queue.setConcurrency(1);
  chatDelayMs = 2000;
  playback.report('tab:abcdef', 'playing');
  const f = addFile();
  queue.enqueue(f);
  await until(() => chats.length === 1);
  mode.set('auto');
  await until(() => queue.status().active.length === 0, 1500);
  assert.deepStrictEqual(queue.status().pending.map(p => p.id), [f.id]);
  assert.strictEqual(rowOf(f.id).processing_error, 'unscanned');
  queue.setWorkersPerInstance(2);
});
