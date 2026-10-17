/**
 * The stream close beacon racing the player's own requests (server/stream-routes.js,
 * lib/stream/ring.js closeClient, lib/stream/service.js segmentFor).
 *
 * A player torn down a moment after it started (the Wall swaps clips that way)
 * can have its close beacon arrive before its first segment request, or while a
 * request is still waiting on the producer. Before the fix the close removed
 * nothing and the late request started (or restarted) FFmpeg for a reader that
 * was already gone, which then ran with clients:0 until the idle sweep.
 *
 * The main player's flow must not change: its token closing after it was seen
 * and then coming back (a page restored from the back/forward cache) is served,
 * and a request without an explicit token is never remembered as closed.
 *
 * Ring segments are planted directly, so no FFmpeg is ever started.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stream-close-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const ring = require('../lib/stream/ring');
const session = require('../lib/stream/session');
const service = require('../lib/stream/service');
const streamIndex = require('../lib/stream/index');
const { app } = require('../server/index');

let server;
let base;
let nextId;

/** A remuxable row whose file exists and whose keyframe index is already stored. */
function addRow() {
  const file = path.join(tmp, `clip-${nextId++}.mkv`);
  fs.writeFileSync(file, Buffer.alloc(1024));
  const id = Number(db.get().prepare(`INSERT INTO media
    (filepath, filename, media_type, filesize_bytes, duration_seconds, probe_version, video_codec, audio_codec, container)
    VALUES (?, ?, 'video', 10, 40, 1, 'h264', 'ac3', 'matroska')`)
    .run(file, path.basename(file)).lastInsertRowid);
  db.saveStreamIndex(id, {
    keyframes: [0, 4, 8, 12], segments: [0, 4, 8, 12], containerStart: 0, duration: 40,
    indexVersion: streamIndex.INDEX_VERSION,
  });
  return id;
}

const seg = (n) => Buffer.alloc(188, n & 0xff);
const close = (id, c) => fetch(`${base}/stream/${id}/close${c ? `?c=${c}` : ''}`, { method: 'POST' });
const getSeg = (id, n, c) => fetch(`${base}/stream/${id}/seg/${n}.ts${c ? `?c=${c}` : ''}`);
const tick = () => new Promise(r => setTimeout(r, 50));   // the close route works after its 204
const clientsOf = (id) => (ring.peek(id) ? [...ring.peek(id).clients.keys()] : []);

test.before(async () => {
  db.init();
  nextId = 1;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await session.stopAll();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('a close that arrives before the first segment request: the late request is refused', async () => {
  const id = addRow();
  // Another player is watching this file, so there is a ring with a segment in it.
  ring.note(id, 0, 'mainplayer');
  ring.put(id, 0, seg(0));

  assert.strictEqual((await close(id, 'wallclip')).status, 204);
  await tick();
  assert.deepStrictEqual(clientsOf(id), ['mainplayer'], 'the close removed nothing and touched nobody else');

  const res = await getSeg(id, 0, 'wallclip');
  assert.strictEqual(res.status, 410);
  assert.deepStrictEqual(clientsOf(id), ['mainplayer'], 'the closed token never registered');
  assert.strictEqual(session.activeIds().has(id), false, 'no producer was started for it');

  // The other player is untouched and still served.
  assert.strictEqual((await getSeg(id, 0, 'mainplayer')).status, 200);
  ring.forget(id);
});

test('a close while a request waits on the producer: the request does not restart it', async () => {
  const id = addRow();
  const row = db.getById(id);
  // Segment 2 is not in the ring, so this request has to go to the producer.
  const pending = service.segmentFor(row, 2, 'wallclip2');
  // The close lands while it is still on its way there (it awaits the probe
  // and index first), and finds the token it just registered.
  const left = ring.closeClient(id, 'wallclip2');
  assert.deepStrictEqual(left, { removed: true, remaining: 0 });
  const out = await pending;
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 410);
  assert.strictEqual(session.activeIds().has(id), false, 'no producer was started');
  ring.forget(id);
});

test('the main player: a seen token closed on pagehide and then back (bfcache) is still served', async () => {
  const id = addRow();
  ring.put(id, 0, seg(0));
  assert.strictEqual((await getSeg(id, 0, 'player1')).status, 200);
  assert.deepStrictEqual(clientsOf(id), ['player1']);

  assert.strictEqual((await close(id, 'player1')).status, 204);
  await tick();
  assert.strictEqual(ring.peek(id), null, 'the last client leaving ends the session and frees the ring');

  // The page comes back from the back/forward cache with the same token.
  ring.put(id, 1, seg(1));
  assert.strictEqual((await getSeg(id, 1, 'player1')).status, 200);
  assert.deepStrictEqual(clientsOf(id), ['player1']);
  ring.forget(id);
});

test('a request without an explicit token is never remembered as closed', async () => {
  const id = addRow();
  ring.put(id, 0, seg(0));
  assert.strictEqual((await close(id)).status, 204);
  await tick();
  assert.strictEqual((await getSeg(id, 0)).status, 200);
  assert.strictEqual(ring.peek(id).clientCount(), 1);
  ring.forget(id);
});

test('closed tokens are per media id and expire', async () => {
  const t0 = Date.now();
  ring.closeClient(9001, 'x');
  assert.strictEqual(ring.closedUnseen(9001, 'x'), true);
  assert.strictEqual(ring.closedUnseen(9002, 'x'), false, 'another file is not affected');
  assert.strictEqual(ring.closedSince(9001, 'x', t0), true);
  assert.strictEqual(ring.closedSince(9001, 'x', Date.now() + 1), false, 'a request started after the close is not moot');

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + ring.CLOSED_TTL_MS + 1000;
    assert.strictEqual(ring.closedUnseen(9001, 'x'), false, 'forgotten after CLOSED_TTL_MS');
  } finally {
    Date.now = realNow;
  }
});
