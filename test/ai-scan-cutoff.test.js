/**
 * AI scan Auto: when playback starts, the import line's scan of the file in
 * flight stops at once, wherever it is in the real pipeline (commands/scan.js
 * processFile and the processors under it), on the one AbortController the
 * queue gives each file (lib/ai-slots.js scanSignal):
 *
 * - frame extraction: the ffmpeg children are killed, no new one starts
 * - the vision request to the AI server is aborted
 * - the embedding request is aborted (it is asked for before the row is saved)
 * - transcription (audio files): the whisper sidecar is stopped
 *
 * Each time: the row is exactly as it was, the file is back at the front of
 * the line, no temp folder is left and no child process is still running.
 * Media is made here with ffmpeg; the AI server is a stub that answers slowly.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-aiscan-cut-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_TEMP_AUDIO = path.join(tmp, 'temp-audio');
process.env.EMBEDDINGS = 'true';
delete process.env.VAULT_DB_PASSWORD;
delete process.env.AI_MODEL;

// Every child the pipeline starts, recorded before any module grabs these.
const kids = [];
let onChild = null;
for (const name of ['execFile', 'spawn']) {
  const orig = cp[name];
  cp[name] = function (...args) {
    const child = orig.apply(this, args);
    kids.push({ child, cmd: args[0], args: Array.isArray(args[1]) ? args[1] : [] });
    if (onChild) onChild(args);
    return child;
  };
}
const running = () => kids.filter(k => k.child.exitCode === null && k.child.signalCode === null);

const haveFfmpeg = cp.spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const python = process.env.PYTHON_PATH || 'python';
const havePython = cp.spawnSync(python, ['--version'], { windowsHide: true }).status === 0;

const db = require('../lib/database');
const slots = require('../lib/ai-slots');
const llm = require('../lib/llm-client');
const scanModel = require('../lib/scan-model');
const queue = require('../lib/import-queue');
const mode = require('../lib/ai-scan-mode');
const playback = require('../lib/playback-activity');
const transcriber = require('../lib/video-transcriber');

const GB = 1024 ** 3;
let server, base;
let chatDelayMs = 0;
let embedDelayMs = 0;
const reqs = [];                 // { kind: 'chat' | 'embed', aborted, answered }
let onRequest = null;

test.before(async () => {
  db.init();
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'vis', type: 'vlm', state: 'loaded' }] }));
      return;
    }
    const kind = req.url.includes('/embeddings') ? 'embed' : 'chat';
    const rec = { kind, aborted: false, answered: false };
    reqs.push(rec);
    req.on('data', () => {});
    res.on('close', () => { if (!res.writableEnded) rec.aborted = true; });
    if (onRequest) onRequest(rec);
    setTimeout(() => {
      if (res.destroyed) return;
      rec.answered = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (kind === 'embed') {
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }));
      } else {
        const answer = { description: 'a test card', tags: ['test'], themes: [], content_type: 'other', language: 'none' };
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
      }
    }, kind === 'embed' ? embedDelayMs : chatDelayMs);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  llm.setEndpoints([base]);
});

test.after(async () => {
  await drain();
  transcriber.shutdownServer();
  scanModel.stop();
  slots.stop();
  playback._reset();
  await new Promise(r => server.close(r));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const until = async (fn, ms = 5000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
};

async function drain() {
  onChild = null;
  onRequest = null;
  playback._reset();
  queue.cancel();
  chatDelayMs = 0;
  embedDelayMs = 0;
  await until(() => queue.status().active.length === 0, 15000, 'the queue to empty');
  queue.cancel();
}

async function fresh() {
  await drain();
  queue._setTimings({ settleMs: 15_000 });
  queue.setConcurrency(1);
  reqs.length = 0;
  kids.length = 0;
  slots._reset([base]);
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
  mode.set('auto');
}

/** Media made with ffmpeg, as a never-scanned row. */
let seq = 0;
function makeFile(kind) {
  const name = `${kind}-${++seq}.${kind === 'audio' ? 'wav' : 'mp4'}`;
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const args = kind === 'audio'
    ? ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', fp]
    : ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=90', '-c:v', 'libx264', '-preset', 'ultrafast', fp];
  const r = cp.spawnSync('ffmpeg', args, { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(r.stderr);
  kids.length = 0;
  const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, ?, 'unscanned')")
    .run(fp, name, kind).lastInsertRowid);
  return { id, filepath: fp, filename: name, mediaType: kind };
}
const rowOf = (id) => db.get().prepare('SELECT * FROM media WHERE id = ?').get(id);
const tempLeft = () => {
  try {
    return fs.readdirSync(process.env.VAULT_TEMP, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return []; }
};

/** Start playback; resolve once the queue has nothing in flight. */
async function playAndWait() {
  const t0 = Date.now();
  playback.report('tab:cutoff', 'playing');
  await until(() => queue.status().active.length === 0, 3000, 'the scan to stop');
  return Date.now() - t0;
}

function assertCleanCut(file, other, before, label) {
  assert.deepStrictEqual(rowOf(file.id), before, `${label}: the row is exactly as it was`);
  const s = queue.status();
  assert.deepStrictEqual(s.pending.map(p => p.id), [file.id, other.id], `${label}: back at the front of the line`);
  assert.strictEqual(s.failed, 0, `${label}: not a failure`);
  assert.strictEqual(s.waiting && s.waiting.code, 'playback');
  assert.deepStrictEqual(tempLeft(), [], `${label}: no temp folder left`);
}

const ffOpt = { skip: haveFfmpeg ? false : 'ffmpeg is not installed' };

test('frames: playback during frame extraction kills the ffmpeg children and starts no more', ffOpt, async () => {
  await fresh();
  const file = makeFile('video');
  const other = makeFile('video');
  const before = rowOf(file.id);
  let frameChildren = 0;
  let cutAt = null;
  onChild = (args) => {
    const a = Array.isArray(args[1]) ? args[1] : [];
    if (!a.includes('-vframes')) return;
    frameChildren++;
    if (frameChildren === 1) setImmediate(() => { cutAt = frameChildren; playback.report('tab:cutoff', 'playing'); });
  };
  queue.enqueue(file);
  queue.enqueue(other);
  await until(() => cutAt !== null, 10000, 'frame extraction to start');
  await until(() => queue.status().active.length === 0, 3000, 'the scan to stop');
  onChild = null;
  await until(() => running().length === 0, 3000, 'every child to exit');
  const config = require('../config');
  assert.ok(frameChildren <= cutAt + config.performance.maxFrameWorkers,
    `no ffmpeg started after the cut (${frameChildren} started, cut at ${cutAt})`);
  assert.ok(frameChildren < 10, `extraction stopped early (${frameChildren} frame children)`);
  assert.strictEqual(reqs.length, 0, 'nothing was sent to the AI server');
  assertCleanCut(file, other, before, 'frames');
});

test('vision request: playback aborts the request to the AI server', ffOpt, async () => {
  await fresh();
  const file = makeFile('video');
  const other = makeFile('video');
  const before = rowOf(file.id);
  chatDelayMs = 5000;
  queue.enqueue(file);
  queue.enqueue(other);
  await until(() => reqs.some(r => r.kind === 'chat'), 15000, 'the vision request');
  const ms = await playAndWait();
  assert.ok(ms < 1500, `cut at once (${ms} ms)`);
  await until(() => reqs[0].aborted, 2000, 'the request to be aborted');
  assert.strictEqual(reqs[0].answered, false);
  await until(() => running().length === 0, 3000, 'every child to exit');
  assert.ok(!reqs.some(r => r.kind === 'embed'), 'no embedding asked for');
  assertCleanCut(file, other, before, 'vision');
});

test('embedding: playback aborts the embedding request, and the scan is not saved', ffOpt, async () => {
  await fresh();
  const file = makeFile('video');
  const other = makeFile('video');
  const before = rowOf(file.id);
  embedDelayMs = 5000;
  queue.enqueue(file);
  queue.enqueue(other);
  await until(() => reqs.some(r => r.kind === 'embed'), 15000, 'the embedding request');
  const ms = await playAndWait();
  assert.ok(ms < 1500, `cut at once (${ms} ms)`);
  const embed = reqs.find(r => r.kind === 'embed');
  await until(() => embed.aborted, 2000, 'the embedding request to be aborted');
  await until(() => running().length === 0, 3000, 'every child to exit');
  assertCleanCut(file, other, before, 'embedding');
  assert.strictEqual(rowOf(file.id).description, null, 'the vision answer was thrown away');
  assert.strictEqual(rowOf(file.id).embedding, null);
});

test('On is unchanged: the same file scans through, embedding and all', ffOpt, async () => {
  await fresh();
  mode.set('on');
  const file = makeFile('video');
  queue.enqueue(file);
  await until(() => rowOf(file.id).processing_error === null, 20000, 'the scan to finish');
  const row = rowOf(file.id);
  assert.strictEqual(row.description, 'a test card');
  assert.ok(row.embedding, 'the vector is saved with the row');
  assert.ok(reqs.some(r => r.kind === 'embed' && r.answered));
});

// A stand-in faster_whisper whose transcription takes half a minute.
const WHISPER_STUB = `
import os, time
class _I:
    language = "en"; language_probability = 0.9; duration = 5.0
class WhisperModel:
    def __init__(self, *a, **k): pass
    def transcribe(self, path, **kw):
        open(os.environ["FW_STUB_MARK"], "w").write("started")
        time.sleep(30)
        return iter([]), _I()
`;

test('transcription: playback stops the whisper sidecar mid-file', { skip: !haveFfmpeg ? 'ffmpeg is not installed' : !havePython ? 'python not found' : false }, async () => {
  await fresh();
  const stubDir = path.join(tmp, 'pystub', 'faster_whisper');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, '__init__.py'), WHISPER_STUB);
  const mark = path.join(tmp, 'fw-started');
  const env = { PYTHONPATH: process.env.PYTHONPATH, FW_STUB_MARK: process.env.FW_STUB_MARK };
  process.env.PYTHONPATH = path.join(tmp, 'pystub');
  process.env.FW_STUB_MARK = mark;
  const check = transcriber.checkTranscriber;
  transcriber.checkTranscriber = () => ({ ok: true });
  try {
    const file = makeFile('audio');
    const other = makeFile('audio');
    const before = rowOf(file.id);
    queue.enqueue(file);
    queue.enqueue(other);
    await until(() => fs.existsSync(mark), 30000, 'transcription to start');
    assert.strictEqual(transcriber.isServerRunning(), true);
    const ms = await playAndWait();
    assert.ok(ms < 1500, `cut at once (${ms} ms)`);
    await until(() => running().length === 0, 5000, 'the whisper sidecar to exit');
    assert.strictEqual(transcriber.isServerRunning(), false, 'the sidecar is stopped');
    assert.strictEqual(reqs.length, 0, 'nothing was sent to the AI server');
    assertCleanCut(file, other, before, 'transcription');
  } finally {
    transcriber.checkTranscriber = check;
    transcriber.shutdownServer();
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
