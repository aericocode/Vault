/**
 * Failed scans grouped by reason (lib/scan-failures.js) and the scan panel's
 * routes for them (server/index.js): every processing_error lands in one of
 * a small set of plain reasons, groups come biggest first with Other last and
 * a capped sample of files each; GET /api/import/failures answers for 100k
 * failures without sending them; Retry per reason, Copy list, closing the
 * panel; and the lock gate and the CSRF guard cover the new routes.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-scanfail-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const queue = require('../lib/import-queue');
const sf = require('../lib/scan-failures');
const { FFPROBE_MISSING, WHISPER_MISSING } = require('../lib/processing-errors');
const { app } = require('../server/index');

let server;
let base;

test.before(async () => {
  db.init();
  queue.pause();                       // nothing here should reach a model
  require('../lib/scan-model')._setDeps({ listModels: async () => [] });   // no real lms
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  vault._locked = false;
  queue.cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/* ── Reasons ───────────────────────────────────────────────────────────── */

test('every real processing_error lands in a plain reason', () => {
  const cases = [
    ['Could not read media info. The file may be corrupt or an unsupported codec', 'media-info'],
    ['no frames could be extracted. The file may be corrupt, truncated or an unsupported codec', 'no-frames'],
    ['no frames to analyze', 'no-frames'],
    [FFPROBE_MISSING, 'tool-missing'],
    [WHISPER_MISSING, 'tool-missing'],
    ['the AI reply could not be parsed as JSON (see bad_json_responses.log)', 'no-answer'],
    ['Empty response from model', 'no-answer'],
    ['The operation was aborted due to timeout', 'no-answer'],
    ['API error: 400 Bad Request - {"error":"context length exceeded"}', 'model-rejected'],
    ['API error: 500 Internal Server Error - boom', 'model-error'],
    ['Repeatedly interrupted the scan: That copy of the model was unloaded', 'interrupted'],
    ['No processor for file type', 'unsupported'],
    ["ENOENT: no such file or directory, open 'D:\\x.mp4'", 'missing-file'],
    ['source file missing on disk', 'missing-file'],
    ['Multiple models are loaded in LM Studio. Pick one in the scan panel or set AI_MODEL', 'model-unavailable'],
    ['something nobody has seen before', 'other'],
    ['', 'other'],
  ];
  for (const [err, key] of cases) assert.strictEqual(sf.classify(err), key, err);
  for (const r of [...sf.REASONS, sf.OTHER]) {
    for (const text of [r.label, r.explain]) assert.ok(!/[–—]/.test(text), `${r.key}: no dashes`);
  }
});

test('groups: biggest first, Other last, a capped sample with the folder; fixed rows ignored', () => {
  const rows = [];
  for (let i = 0; i < 9; i++) rows.push({ id: i, filepath: `D:\\Media\\Clips\\c${i}.mkv`, filename: `c${i}.mkv`, processing_error: 'Could not read media info' });
  for (let i = 9; i < 12; i++) rows.push({ id: i, filepath: `D:\\Cam\\m${i}.mts`, filename: `m${i}.mts`, processing_error: 'Empty response from model' });
  rows.push({ id: 50, filepath: 'D:\\x.mp4', filename: 'x.mp4', processing_error: 'weird' });
  for (let i = 0; i < 20; i++) rows.push({ id: 100 + i, filepath: 'D:\\y.mp4', filename: 'y.mp4', processing_error: 'API error: 500 oops' });
  rows.push({ id: 200, filepath: 'D:\\z.mp4', filename: 'z.mp4', processing_error: 'unscanned' });
  rows.push({ id: 201, filepath: 'D:\\z2.mp4', filename: 'z2.mp4', processing_error: null });
  const out = sf.groupRows(rows, { sample: 3 });
  assert.strictEqual(out.total, 33, 'unscanned and fixed rows are not failures');
  assert.deepStrictEqual(out.groups.map(g => g.key), ['model-error', 'media-info', 'no-answer', 'other']);
  assert.deepStrictEqual(out.groups.map(g => g.count), [20, 9, 3, 1]);
  assert.strictEqual(out.groups[1].sample.length, 3);
  assert.deepStrictEqual(out.groups[1].sample[0], { id: 0, filename: 'c0.mkv', folder: 'D:\\Media\\Clips', error: 'Could not read media info' });
  assert.match(out.groups[1].explain, /still being copied/);
});

/* ── 100k failures over HTTP ───────────────────────────────────────────── */

const N = 100_000;
const BIG = { mediaInfo: 0, noAnswer: 0 };

test('100k failures: grouped counts and a capped sample, without sending them all', async () => {
  // One statement: a row-by-row insert spends most of its time in the
  // library's search triggers (about 20 s here, against 2 s for this).
  db.get().exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${N - 1})
    INSERT INTO media (filepath, filename, media_type, processing_error)
    SELECT 'D:\\Big\\sub' || (i % 7) || '\\f' || i || '.mp4', 'f' || i || '.mp4', 'video',
      CASE WHEN i % 10 = 0 THEN 'Empty response from model' ELSE 'Could not read media info. The file may be corrupt' END
    FROM n`);
  BIG.noAnswer = N / 10;
  BIG.mediaInfo = N - BIG.noAnswer;
  const ids = db.get().prepare("SELECT id FROM media WHERE filepath LIKE 'D:\\Big\\%' ORDER BY id").all().map(r => r.id);
  assert.strictEqual(ids.length, N);
  for (const id of ids) queue._markFailed(id);

  const t0 = Date.now();
  const r = await call('GET', '/api/import/failures?sample=5');
  const ms = Date.now() - t0;
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.failed.total, N);
  const byKey = Object.fromEntries(r.json.failed.groups.map(g => [g.key, g]));
  assert.strictEqual(byKey['media-info'].count, BIG.mediaInfo);
  assert.strictEqual(byKey['no-answer'].count, BIG.noAnswer);
  for (const g of r.json.failed.groups) assert.ok(g.sample.length <= 5);
  assert.ok(r.text.length < 20_000, `small answer (${r.text.length} bytes)`);
  assert.ok(ms < 15_000, `answered in ${ms} ms`);
  assert.strictEqual(r.json.waiting.count, 0);

  // The sample size is capped too.
  const big = await call('GET', '/api/import/failures?sample=500');
  for (const g of big.json.failed.groups) assert.ok(g.sample.length <= 20);
  // And the queue status stays small: it carries the count, not the ids.
  const s = await call('GET', '/api/import/queue');
  assert.strictEqual(s.json.failed, N);
  assert.ok(s.text.length < 20_000);
  const sum = await call('GET', '/api/import/queue/summary');
  assert.strictEqual(sum.json.failed, N);
});

test('Copy list: one line per failed file, path then reason', async () => {
  const res = await fetch(base + '/api/import/failures/text');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const r = { status: res.status, text: await res.text() };
  assert.strictEqual(r.status, 200);
  const lines = r.text.split(/\r\n/);
  assert.strictEqual(lines.length, N);
  assert.match(lines[0], /^D:\\Big\\sub0\\f0\.mp4\tThe model returned no usable answer: Empty response from model$/);
});

test('rows fixed since drop out of the list', async () => {
  const some = queue.failedIds().slice(0, 3);
  db.get().prepare(`UPDATE media SET processing_error = NULL WHERE id IN (${some.join(',')})`).run();
  const out = await sf.collect(db.get(), queue.failedIds().slice(0, 10), { sample: 2 });
  assert.strictEqual(out.total, 7);
  assert.deepStrictEqual(out.cleared.sort((a, b) => a - b), some.sort((a, b) => a - b));
});

test('closing the panel forgets the list', async () => {
  const r = await call('POST', '/api/import/failures/clear');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.cleared >= N - 3);
  assert.deepStrictEqual(queue.failedIds(), []);
  const g = await call('GET', '/api/import/failures');
  assert.strictEqual(g.json.failed.total, 0);
});

/* ── Retry ─────────────────────────────────────────────────────────────── */

test('Retry this group: only that reason, only files still on disk', async () => {
  const mk = (name, err, exists) => {
    const fp = path.join(tmp, 'media', name);
    if (exists) { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, name); }
    const id = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type, processing_error) VALUES (?, ?, 'video', ?)")
      .run(fp, name, err).lastInsertRowid);
    queue._markFailed(id);
    return id;
  };
  const a = mk('a.mp4', 'Empty response from model', true);
  const b = mk('b.mp4', 'Empty response from model', true);
  const gone = mk('gone.mp4', 'Empty response from model', false);
  const other = mk('c.mp4', 'Could not read media info', true);

  assert.strictEqual((await call('POST', '/api/import/failures/retry', { reason: 'Not A Key!' })).status, 400);

  const r = await call('POST', '/api/import/failures/retry', { reason: 'no-answer' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { matched: 3, queued: 2, alreadyQueued: 0, missing: 1 });
  const left = queue.failedIds().sort((x, y) => x - y);
  assert.deepStrictEqual(left, [gone, other].sort((x, y) => x - y), 'retried files leave the failed list');
  assert.ok(queue.isQueued(path.join(tmp, 'media', 'a.mp4')) && queue.isQueued(path.join(tmp, 'media', 'b.mp4')));
  assert.ok(a && b);

  const all = await call('POST', '/api/import/failures/retry', {});
  assert.strictEqual(all.json.queued, 1, 'Retry all takes the rest that still exist');
  queue.cancel();
  queue.pause();
});

/* ── Gates ─────────────────────────────────────────────────────────────── */

test('the new routes answer 423 while the library is locked', async () => {
  vault._locked = true;
  try {
    for (const [m, p] of [['GET', '/api/import/failures'], ['GET', '/api/import/failures/text'],
      ['GET', '/api/import/queue/summary'], ['POST', '/api/import/failures/retry'],
      ['POST', '/api/import/failures/clear'], ['GET', '/api/ai/scan-settings'], ['POST', '/api/ai/scan-settings'],
      ['POST', '/api/ai/scan-model/load'], ['POST', '/api/media/force-refresh']]) {
      const r = await call(m, p, m === 'POST' ? {} : undefined);
      assert.strictEqual(r.status, 423, `${m} ${p}`);
    }
  } finally {
    vault._locked = false;
  }
});

test('the CSRF guard covers them', async () => {
  for (const p of ['/api/import/failures/retry', '/api/import/failures/clear', '/api/ai/scan-settings',
    '/api/ai/scan-model/load', '/api/ai/open-lmstudio', '/api/media/force-refresh']) {
    const r = await call('POST', p, {}, { Origin: 'http://evil.example' });
    assert.strictEqual(r.status, 403, p);
  }
});

test('scan settings: saved through the route, bad values refused', async () => {
  const bad = await call('POST', '/api/ai/scan-settings', { whenNotLoaded: 'maybe' });
  assert.strictEqual(bad.status, 400);
  const ok = await call('POST', '/api/ai/scan-settings', { whenNotLoaded: 'wait', unloadIdleMin: 5, gpuFreeForWatch: true });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json.settings, { scanModel: '', whenNotLoaded: 'wait', gpuFreeForWatch: true, unloadIdleMin: 5 });
  assert.ok(Array.isArray(ok.json.models));
  const back = await call('POST', '/api/ai/scan-settings', { whenNotLoaded: 'room', unloadIdleMin: 10, gpuFreeForWatch: false });
  assert.strictEqual(back.json.settings.whenNotLoaded, 'room');
});

test('scan settings: a model LM Studio lists as text only is refused as the scan model', async () => {
  const sm = require('../lib/scan-model');
  sm._reset();
  sm._setDeps({ listModels: async () => [
    { modelKey: 'big-text', sizeBytes: 1, type: 'llm', vision: false },
    { modelKey: 'vis', sizeBytes: 1, type: 'llm', vision: true },
  ] });
  const bad = await call('POST', '/api/ai/scan-settings', { scanModel: 'big-text' });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.json.error, /big-text cannot read pictures/);
  const ok = await call('POST', '/api/ai/scan-settings', { scanModel: 'vis' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.settings.scanModel, 'vis');
  await call('POST', '/api/ai/scan-settings', { scanModel: '' });
  sm._setDeps({ listModels: async () => [] });
  sm._reset();
});

test('/api/ai/models says what decides each kind, by the scan rules', async () => {
  const config = require('../config');
  const llm = require('../lib/llm-client');
  let r = await call('GET', '/api/ai/models');
  assert.deepStrictEqual(r.json.decides, { vision: { model: null, by: 'auto' }, text: { model: null, by: 'auto' } });
  llm.setSessionModel('pick-v', { kind: 'vision' });
  r = await call('GET', '/api/ai/models');
  assert.deepStrictEqual(r.json.decides.vision, { model: 'pick-v', by: 'pick' });
  assert.deepStrictEqual(r.json.decides.text, { model: null, by: 'auto' }, 'the text kind is not touched');
  config.lmStudio.model = 'env-model';
  r = await call('GET', '/api/ai/models');
  assert.deepStrictEqual(r.json.decides.vision, { model: 'env-model', by: 'env' }, 'AI_MODEL first');
  assert.deepStrictEqual(r.json.decides.text, { model: 'env-model', by: 'env' });
  config.lmStudio.model = null;
  llm.setSessionModel(null);
});
