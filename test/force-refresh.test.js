/**
 * Force refresh (lib/import-add.js forceRefresh, POST /api/media/force-refresh):
 * the fix for a file scanned while it was still being copied. It reads the
 * file again (ffprobe), remakes the thumbnail and hover frames, and clears a
 * stale processing error, without redoing the AI scan. A file that never got
 * analysed goes back to "not scanned" and is queued for its first scan; one
 * that still cannot be read keeps its error. ffprobe and the thumbnailer are
 * stood in for, so no real media is needed.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-forcerefresh-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const queue = require('../lib/import-queue');
const importAdd = require('../lib/import-add');
const mediaInfo = require('../lib/media-info');
const thumbnails = require('../lib/thumbnails');
const { app } = require('../server/index');

let server;
let base;
let probe = () => null;                // what "ffprobe" says per path
let probeTool = true;
const thumbCalls = [];

test.before(async () => {
  db.init();
  queue.pause();                       // a queued first scan must not run here
  mediaInfo.getStreamInfo = async (p) => probe(p);
  mediaInfo.isAvailable = () => probeTool;
  thumbnails.refreshIds = async (ids) => { thumbCalls.push([...ids]); };
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  queue.cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test.beforeEach(() => {
  thumbCalls.length = 0;
  probeTool = true;
  importAdd._resetProbeCheck();
});

let seq = 0;
function row({ error = 'Could not read media info. The file may be corrupt or an unsupported codec', description = '', type = 'video', exists = true } = {}) {
  const name = `r${++seq}.${type === 'image' ? 'jpg' : 'mp4'}`;
  const fp = path.join(tmp, 'media', name);
  if (exists) { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, 'x'); }
  return Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type, processing_error, description) VALUES (?, ?, ?, ?, ?)')
    .run(fp, name, type, error, description).lastInsertRowid);
}
const get = (id) => db.getById(id);
const INFO = { duration: 12.5, width: 1920, height: 1080, video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv420p', container: 'mp4' };

test('a file scanned mid-copy: unreadable keeps its error, readable gets fixed and its first scan queued', async () => {
  const id = row();
  queue._markFailed(id);

  probe = () => null;                  // still copying
  let out = await importAdd.forceRefresh([id]);
  assert.deepStrictEqual(out.stillBroken, [id]);
  assert.match(get(id).processing_error, /Could not read media info/, 'the error stays');
  assert.deepStrictEqual(thumbCalls, [], 'no thumbnail from a file that cannot be read');
  assert.deepStrictEqual(queue.failedIds(), [id], 'still on the Failed list');

  probe = () => INFO;                  // the copy finished
  out = await importAdd.forceRefresh([id]);
  assert.deepStrictEqual(out.refreshed, [id]);
  assert.deepStrictEqual(out.queued, [id], 'never analysed, so its first AI scan is queued');
  const r = get(id);
  assert.strictEqual(r.processing_error, 'unscanned');
  assert.strictEqual(r.duration_seconds, 12.5, 'media info read again');
  assert.strictEqual(r.width, 1920);
  assert.strictEqual(r.video_codec, 'h264');
  assert.deepStrictEqual(thumbCalls, [[id]], 'thumbnail and hover frames remade');
  assert.deepStrictEqual(queue.failedIds(), [], 'off the Failed list');
  assert.ok(queue.isQueued(r.filepath));
});

test('a file already waiting in the queue is not queued twice, and the counts do not move', async () => {
  const id = row();
  const r = get(id);
  queue.enqueue({ id, filepath: r.filepath, filename: r.filename, mediaType: 'video' });
  const before = queue.status().total;
  const pending = queue.status().pendingCount;
  probe = () => INFO;
  const out = await importAdd.forceRefresh([id]);
  assert.deepStrictEqual(out.queued, [id]);
  assert.strictEqual(queue.status().total, before);
  assert.strictEqual(queue.status().pendingCount, pending);
});

test('an analysed file with a stale error: the error goes, the AI scan is not redone', async () => {
  const id = row({ error: 'Could not read media info', description: 'A beach at sunset' });
  probe = () => INFO;
  const out = await importAdd.forceRefresh([id]);
  assert.deepStrictEqual(out.refreshed, [id]);
  assert.deepStrictEqual(out.queued, []);
  assert.strictEqual(get(id).processing_error, null);
  assert.strictEqual(get(id).description, 'A beach at sunset', 'the analysis is kept');
  assert.ok(!queue.isQueued(get(id).filepath));
});

test('pictures are read too; a missing file and no ffprobe are reported, not hidden', async () => {
  const pic = row({ type: 'image', description: 'cat' });
  const gone = row({ exists: false });
  probe = () => ({ width: 800, height: 600 });
  const out = await importAdd.forceRefresh([pic, gone]);
  assert.deepStrictEqual(out.refreshed, [pic]);
  assert.deepStrictEqual(out.missing, [gone]);
  assert.strictEqual(get(pic).processing_error, null);

  const v = row();
  probeTool = false;
  importAdd._resetProbeCheck();
  const none = await importAdd.forceRefresh([v]);
  assert.strictEqual(none.noProbe, true);
  assert.deepStrictEqual(none.stillBroken, [v]);
  assert.match(get(v).processing_error, /Could not read media info/);
});

test('the route: per file with rows back, and a selection keeps only files with an error', async () => {
  const call = async (body) => {
    const res = await fetch(`${base}/api/media/force-refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  assert.strictEqual((await call({})).status, 400);
  assert.strictEqual((await call({ ids: ['x', -1] })).status, 400);

  probe = () => INFO;
  const bad = row({ description: 'done before' });
  const fine = row({ error: null, description: 'fine' });
  const r = await call({ ids: [bad] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.refreshed, [bad]);
  assert.strictEqual(r.json.rows[0].id, bad);
  assert.strictEqual(r.json.rows[0].processing_error, null);

  const bad2 = row({ description: 'x' });
  thumbCalls.length = 0;
  const sel = await call({ ids: [fine, bad2], onlyErrored: true });
  assert.deepStrictEqual(sel.json.refreshed, [bad2], 'the fine file is left alone');
  assert.deepStrictEqual(thumbCalls, [[bad2]]);
  const none = await call({ ids: [fine], onlyErrored: true });
  assert.deepStrictEqual(none.json.refreshed, []);
});
