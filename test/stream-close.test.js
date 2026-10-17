/**
 * The stream close beacon racing the player's own requests (server/stream-routes.js,
 * lib/stream/ring.js closeWallClient, lib/stream/service.js segmentFor).
 *
 * A Wall clip torn down a moment after it started (the Wall swaps clips that
 * way) can have its close beacon arrive before its first segment request, or
 * while a request is still waiting on the producer. Before the fix the close
 * removed nothing and the late request started (or restarted) FFmpeg for a
 * reader that was already gone, which then ran with clients:0 until the idle
 * sweep.
 *
 * Only tokens the Wall mints ("wall-" + UUID) take that path. Every other token
 * (the main player, the mini player, a tokenless request's derived token) must
 * behave exactly as before: never remembered as closed, never refused.
 *
 * Ring segments are planted directly, so no FFmpeg is ever started.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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
/** Make a client look quiet for longer than CLIENT_TTL_MS, as a paused player does. */
const age = (id, c) => { ring.peek(id).clients.get(c).lastRequest -= ring.CLIENT_TTL_MS + 2000; };
/** A token in the shape player-lib/wall.js mints. */
const W = () => `wall-${crypto.randomUUID()}`;
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

/* -- Wall tokens ---------------------------------------------------------- */

test('a Wall close that arrives before the first segment request: the late request is refused', async () => {
  const id = addRow();
  const wall = W();
  // Another player is watching this file, so there is a ring with a segment in it.
  ring.note(id, 0, 'mainplayer');
  ring.put(id, 0, seg(0));

  assert.strictEqual((await close(id, wall)).status, 204);
  await tick();
  assert.deepStrictEqual(clientsOf(id), ['mainplayer'], 'the close removed nothing and touched nobody else');

  const res = await getSeg(id, 0, wall);
  assert.strictEqual(res.status, 410);
  assert.deepStrictEqual(clientsOf(id), ['mainplayer'], 'the closed token never registered');
  assert.strictEqual(session.activeIds().has(id), false, 'no producer was started for it');

  // The other player is untouched and still served.
  assert.strictEqual((await getSeg(id, 0, 'mainplayer')).status, 200);
  ring.forget(id);
});

test('a Wall close while a request waits on the producer: the request does not restart it', async () => {
  const id = addRow();
  const row = db.getById(id);
  const wall = W();
  // Segment 2 is not in the ring, so this request has to go to the producer.
  const pending = service.segmentFor(row, 2, wall);
  // The close lands while it is still on its way there (it awaits the probe
  // and index first), and finds the token it just registered.
  const left = ring.closeWallClient(id, wall);
  assert.deepStrictEqual(left, { removed: true, remaining: 0, known: true });
  const out = await pending;
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.status, 410);
  assert.strictEqual(session.activeIds().has(id), false, 'no producer was started');
  ring.forget(id);
});

test('a Wall token the ring pruned is still known: its close is not "unseen" and ends the emptied session', async () => {
  const id = addRow();
  const wall = W();
  ring.put(id, 0, seg(0));
  assert.strictEqual((await getSeg(id, 0, wall)).status, 200);
  age(id, wall);
  assert.strictEqual(ring.peek(id).clientCount(), 0, 'the ring pruned the quiet clip');

  assert.strictEqual((await close(id, wall)).status, 204);
  await tick();
  assert.strictEqual(ring.peek(id), null, 'the close still ended the session and freed the ring');
  assert.strictEqual(ring.closedUnseen(id, wall), false);

  ring.put(id, 1, seg(1));
  assert.strictEqual((await getSeg(id, 1, wall)).status, 200, 'a seen token is never refused outright');
  ring.forget(id);
});

test('Wall closed tokens are per media id and expire', async () => {
  const t0 = Date.now();
  const wall = W();
  ring.closeWallClient(9001, wall);
  assert.strictEqual(ring.closedUnseen(9001, wall), true);
  assert.strictEqual(ring.closedUnseen(9002, wall), false, 'another file is not affected');
  assert.strictEqual(ring.closedSince(9001, wall, t0), true);
  assert.strictEqual(ring.closedSince(9001, wall, Date.now() + 1), false, 'a request started after the close is not moot');

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + ring.CLOSED_TTL_MS + 1000;
    assert.strictEqual(ring.closedUnseen(9001, wall), false, 'forgotten after CLOSED_TTL_MS');
  } finally {
    Date.now = realNow;
  }
});

test('only the exact Wall shape counts as a Wall token', () => {
  assert.strictEqual(ring.isWallToken(W()), true);
  const others = ['wallclip', 'wall-', 'wall-xyz', W().toUpperCase(), `${W()}0`, crypto.randomUUID(),
    crypto.randomUUID().replace(/-/g, ''), 'a0123456789abcdef', '-', '', undefined];
  for (const t of others) assert.strictEqual(ring.isWallToken(t), false, String(t));
});

/* -- Every other token: exactly the old behaviour ------------------------- */

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

test('the main player: paused past CLIENT_TTL_MS, closed, then back (bfcache) is still served', async () => {
  const id = addRow();
  ring.put(id, 0, seg(0));
  ring.put(id, 3, seg(3));
  assert.strictEqual((await getSeg(id, 0, 'probeidle1')).status, 200);
  age(id, 'probeidle1');

  assert.strictEqual((await close(id, 'probeidle1')).status, 204);
  await tick();
  assert.strictEqual((await getSeg(id, 3, 'probeidle1')).status, 200);
  assert.deepStrictEqual(clientsOf(id), ['probeidle1']);
  ring.forget(id);
});

test('a non-Wall token closed before it was ever seen is still served', async () => {
  const id = addRow();
  ring.put(id, 0, seg(0));
  const tokens = ['player2', crypto.randomUUID().replace(/-/g, ''), 'wall-notauuid'];
  for (const t of tokens) {
    assert.strictEqual((await close(id, t)).status, 204);
    await tick();
    assert.strictEqual((await getSeg(id, 0, t)).status, 200, t);
  }
  assert.strictEqual(ring.peek(id).clientCount(), tokens.length);
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

test('closing a tokenless client\'s derived token by name does not lock that client out', async () => {
  const id = addRow();
  ring.put(id, 0, seg(0));
  ring.put(id, 1, seg(1));
  ring.note(id, 0, 'otherplayer');     // keeps the session alive across the close
  assert.strictEqual((await getSeg(id, 0)).status, 200);
  const derived = clientsOf(id).find(t => t !== 'otherplayer');
  assert.match(derived, /^a[0-9a-f]{16}$/);
  // Quiet long enough to be pruned, so the ring no longer knows it when someone
  // else names its derived token in a close.
  age(id, derived);

  assert.strictEqual((await close(id, derived)).status, 204);
  await tick();
  assert.deepStrictEqual(clientsOf(id), ['otherplayer']);
  assert.strictEqual((await getSeg(id, 1)).status, 200, 'the tokenless client is still served');
  assert.strictEqual(ring.peek(id).clientCount(), 2);
  ring.forget(id);
});
