/**
 * "Failed to play" marks (playback_failed):
 *  - only an error that says the FILE cannot play in this browser is saved
 *    (player-lib/selection.js _playbackFailureKind / _sourceAnswers): a decode
 *    error, or "not supported" when the server did answer with the file. A
 *    network drop, an aborted load, a missing file (404), a server that is
 *    down, or a converted-stream retry still to come saves nothing;
 *  - the bulk bar's Mark as playable clears the mark
 *    (POST /api/media/clear-playback-failed), and the selection summary
 *    counts the marked files so the button knows when to show.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** One top-level function of a browser script, by its name. */
function grab(src, name) {
  let at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let depth = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

const sel = read('player-lib/selection.js');

function kindOf(el) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${grab(sel, '_playbackFailureKind')}\nglobalThis.__f = _playbackFailureKind;`, ctx);
  return ctx.__f(el);
}
const video = (error, dataset = {}) => ({ tagName: 'VIDEO', error, dataset });

test('only decode errors are marked at once; "not supported" asks the server first', () => {
  assert.strictEqual(kindOf(video({ code: 3, message: '' })), 'mark', 'MEDIA_ERR_DECODE');
  assert.strictEqual(kindOf(video({ code: 4, message: '' })), 'probe', 'MEDIA_ERR_SRC_NOT_SUPPORTED');
  assert.strictEqual(kindOf(video({ code: 2, message: '' })), 'no', 'MEDIA_ERR_NETWORK');
  assert.strictEqual(kindOf(video({ code: 1, message: '' })), 'no', 'MEDIA_ERR_ABORTED');
  assert.strictEqual(kindOf(video(null)), 'no', 'no error object');
  assert.strictEqual(kindOf({ tagName: 'IMG', dataset: {} }), 'probe', 'a picture: was it the server or the file?');
});

test('a converted-stream retry still to come, or a browser out of decoders, marks nothing', () => {
  assert.strictEqual(kindOf(video({ code: 4, message: '' }, { playbackFallback: 'remux' })), 'no');
  assert.strictEqual(kindOf(video({ code: 3, message: '' }, { playbackFallback: 'remux' })), 'no');
  assert.strictEqual(kindOf(video({ code: 3, message: 'NS_ERROR_OUT_OF_MEMORY' })), 'no');
  assert.strictEqual(kindOf(video({ code: 4, message: 'Failed to allocate a decoder' })), 'no');
  assert.strictEqual(kindOf(video({ code: 3, message: '' }, { playbackFallback: '' })), 'mark', 'after the retry was used');
});

async function answers(url, fetchImpl) {
  const calls = [];
  const ctx = {
    fetch: async (u, opts) => { calls.push([u, opts]); return fetchImpl(u, opts); },
    AbortSignal,
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab(sel, '_sourceAnswers')}\nglobalThis.__f = _sourceAnswers;`, ctx);
  return { ok: await ctx.__f(url), calls };
}

test('the server check: only an answer with the file counts', async () => {
  const resp = (status) => ({ ok: status >= 200 && status < 300, status, body: { cancel() {} } });
  let r = await answers('/media/1', () => resp(206));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.calls[0][1].headers.Range, 'bytes=0-0', 'one byte, not the whole file');
  assert.strictEqual((await answers('/media/1', () => resp(200))).ok, true);
  assert.strictEqual((await answers('/media/1', () => resp(404))).ok, false, 'the source file is missing');
  assert.strictEqual((await answers('/media/1', () => resp(500))).ok, false);
  assert.strictEqual((await answers('/media/1', () => resp(503))).ok, false);
  assert.strictEqual((await answers('/media/1', () => { throw new TypeError('Failed to fetch'); })).ok, false, 'server down');
  r = await answers('blob:http://x/abc', () => resp(200));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.calls.length, 0, 'a converted stream (blob:) is not probed');
  assert.strictEqual((await answers('', () => resp(200))).ok, false);
});

test('the error listener marks through the check, and the converted stream marks only a decode failure', () => {
  const at = sel.indexOf("document.addEventListener('error'");
  const listener = sel.slice(at, sel.indexOf('}, true);', at));
  assert.match(listener, /_playbackFailureKind\(el\)/);
  assert.match(listener, /_sourceAnswers\(url\)\.then\(\(ok\) => \{ if \(ok\) _markPlaybackFailed\(media\)/);
  assert.ok(!/postFlags/.test(listener), 'no unconditional save left');
  const stream = read('player-lib/player/player-stream.js');
  assert.match(stream, /if \(data\.type === Hls\.ErrorTypes\.MEDIA_ERROR\) \{[\s\S]{0,200}_markPlaybackFailed\(media\)/);
  const core = read('player-lib/player/player-core.js');
  assert.ok(!/Cannot play this file, marked as unplayable/.test(core), 'the close message does not claim a mark');
});

/* ── The route and the selection count ────────────────────────────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-pbfailed-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const { app } = require('../server/index');
let server;
let base;

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function row(failed) {
  const name = `f${++seq}.mp4`;
  return Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type, playback_failed) VALUES (?, ?, ?, ?)')
    .run(path.join(tmp, name), name, 'video', failed).lastInsertRowid);
}
const post = async (url, body) => {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

test('Mark as playable clears the mark on the selected files only', async () => {
  assert.strictEqual((await post('/api/media/clear-playback-failed', {})).status, 400);
  assert.strictEqual((await post('/api/media/clear-playback-failed', { ids: [] })).status, 400);
  assert.strictEqual((await post('/api/media/clear-playback-failed', { ids: ['x', -1, 1.5] })).status, 400);

  const a = row(1), b = row(1), fine = row(0), other = row(1);
  const u32 = Buffer.from(Uint32Array.from([a, b, fine]).buffer);
  const sum = await (await fetch(base + '/api/library/ids-summary', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: u32 })).json();
  assert.strictEqual(sum.failed, 2, 'the bar knows how many are marked');

  const r = await post('/api/media/clear-playback-failed', { ids: [a, String(b), fine, 999999] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.cleared, 2);
  assert.strictEqual(db.getById(a).playback_failed, 0);
  assert.strictEqual(db.getById(b).playback_failed, 0);
  assert.strictEqual(db.getById(other).playback_failed, 1, 'a file not selected keeps its mark');
  assert.strictEqual((await post('/api/media/clear-playback-failed', { ids: [a] })).json.cleared, 0);
});
