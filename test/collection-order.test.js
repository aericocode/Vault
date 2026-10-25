/**
 * Rearranging a collection's playlist order (PLAYLISTS_SPEC, build step 1):
 * the pure planner (lib/collection-order.js), the one-transaction write
 * (db.reorderCollection) and POST /api/collections/:id/order over HTTP,
 * including the lock gate.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-coll-order-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const { planMove, planOrder, planReorder } = require('../lib/collection-order');
const db = require('../lib/database');
const vault = require('../lib/vault');
const { app } = require('../server/index');

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

// ── The planner ────────────────────────────────────────────────────────────

const A = [1, 2, 3, 4, 5, 6];

test('move to the top, to the end and into the middle', () => {
  assert.deepStrictEqual(planMove(A, [4], 1), [4, 1, 2, 3, 5, 6]);
  assert.deepStrictEqual(planMove(A, [2], null), [1, 3, 4, 5, 6, 2]);
  assert.deepStrictEqual(planMove(A, [6], 3), [1, 2, 6, 3, 4, 5]);
  assert.deepStrictEqual(planMove(A, [1], 4), [2, 3, 1, 4, 5, 6]);
  // Already there: same order.
  assert.deepStrictEqual(planMove(A, [3], 4), A);
  assert.deepStrictEqual(planMove(A, [6], null), A);
});

test('several non-adjacent ids move as one block in their current order', () => {
  // Listed out of order: they keep the order they have in the collection.
  assert.deepStrictEqual(planMove(A, [5, 2], 4), [1, 3, 2, 5, 4, 6]);
  assert.deepStrictEqual(planMove(A, [6, 1, 3], null), [2, 4, 5, 1, 3, 6]);
  assert.deepStrictEqual(planMove(A, [3, 6], 1), [3, 6, 1, 2, 4, 5]);
  // A repeated id counts once.
  assert.deepStrictEqual(planMove(A, [2, 2], null), [1, 3, 4, 5, 6, 2]);
});

test('bad requests are refused with a code', () => {
  assert.strictEqual(code(() => planMove(A, [9], 1)), 'NOT_MEMBER');
  assert.strictEqual(code(() => planMove(A, [1, 9], null)), 'NOT_MEMBER');
  assert.strictEqual(code(() => planMove(A, [2, 3], 3)), 'BEFORE_IN_MOVE');
  assert.strictEqual(code(() => planMove(A, [2], 9)), 'BEFORE_NOT_MEMBER');
  assert.strictEqual(code(() => planMove(A, [], 1)), 'BAD_MOVE');
  assert.strictEqual(code(() => planMove(A, 'x', 1)), 'BAD_MOVE');
  assert.strictEqual(code(() => planMove(A, [1.5], 1)), 'BAD_MOVE');
  assert.strictEqual(code(() => planMove(A, ['2'], 1)), 'BAD_MOVE');
  assert.strictEqual(code(() => planMove(A, [2], '1')), 'BAD_BEFORE');
  assert.strictEqual(code(() => planReorder(A, { move: [2] })), 'BAD_BEFORE');
  assert.strictEqual(code(() => planReorder(A, null)), 'BAD_BEFORE');
});

test('a whole order must be an exact permutation', () => {
  assert.deepStrictEqual(planOrder(A, [6, 5, 4, 3, 2, 1]), [6, 5, 4, 3, 2, 1]);
  assert.deepStrictEqual(planReorder(A, { order: [2, 1, 3, 4, 5, 6] }), [2, 1, 3, 4, 5, 6]);
  for (const bad of [[1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7], [1, 1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 9], 'x', [0, 1, 2, 3, 4, 5]]) {
    assert.strictEqual(code(() => planOrder(A, bad)), 'BAD_ORDER', JSON.stringify(bad));
  }
});

// ── The database write and the route ───────────────────────────────────────

let server;
let base;
const m = [];        // media ids, m[0] .. m[5]
let coll;
let folder;

const positions = (id) => db.get().prepare(
  'SELECT media_id, position FROM collection_items WHERE collection_id = ? ORDER BY position'
).all(id);

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)');
  for (let i = 0; i < 6; i++) m.push(Number(ins.run(`/o/f${i}.mp4`, `f${i}.mp4`, 'video').lastInsertRowid));
  coll = db.createCollection('Order').id;
  folder = db.createCollection('Box', { kind: 'folder' }).id;
  db.addToCollection(coll, m);
  // Leave gaps and ties in the stored positions, as old data can have.
  const d = db.get();
  d.prepare('UPDATE collection_items SET position = position * 10 WHERE collection_id = ?').run(coll);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p, body) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

test('reorderCollection rewrites positions 0..n-1 with no gaps', () => {
  const order = db.reorderCollection(coll, { move: [m[4]], before: m[1] });
  assert.deepStrictEqual(order, [m[0], m[4], m[1], m[2], m[3], m[5]]);
  assert.deepStrictEqual(positions(coll), order.map((id, i) => ({ media_id: id, position: i })));
  assert.deepStrictEqual(db.getCollectionItems(coll), order);
  // Back to the start for the route tests.
  db.reorderCollection(coll, { order: m });
  assert.deepStrictEqual(db.getCollectionItems(coll), m);
});

test('reorderCollection refuses folders and unknown collections, and changes nothing on a bad request', () => {
  assert.strictEqual(code(() => db.reorderCollection(folder, { move: [m[0]], before: null })), 'FOLDER_TARGET');
  assert.strictEqual(code(() => db.reorderCollection(999999, { move: [m[0]], before: null })), 'NOT_FOUND');
  assert.strictEqual(code(() => db.reorderCollection(coll, { move: [m[0], 999999], before: null })), 'NOT_MEMBER');
  assert.deepStrictEqual(db.getCollectionItems(coll), m);
});

test('POST /api/collections/:id/order moves a block and answers the new order', async () => {
  let res = await post(`/api/collections/${coll}/order`, { move: [m[5], m[1]], before: m[0] });
  assert.strictEqual(res.status, 200);
  let j = await res.json();
  assert.deepStrictEqual(j.order, [m[1], m[5], m[0], m[2], m[3], m[4]]);
  assert.strictEqual(j.item_count, 6);
  assert.deepStrictEqual(j.first_ids, j.order.slice(0, 4));
  assert.deepStrictEqual(db.getCollectionItems(coll), j.order);

  res = await post(`/api/collections/${coll}/order`, { move: [m[1]], before: null });
  j = await res.json();
  assert.deepStrictEqual(j.order, [m[5], m[0], m[2], m[3], m[4], m[1]]);

  // Undo: the whole earlier order in one request.
  res = await post(`/api/collections/${coll}/order`, { order: m });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual((await res.json()).order, m);
  assert.deepStrictEqual(positions(coll).map(r => r.position), [0, 1, 2, 3, 4, 5]);
});

test('POST /api/collections/:id/order: 400 with a code, 404, and the folder refusal', async () => {
  const cases = [
    [{ move: [999999], before: null }, 400, 'NOT_MEMBER'],
    [{ move: [m[1], m[2]], before: m[2] }, 400, 'BEFORE_IN_MOVE'],
    [{ move: [m[1]], before: 999999 }, 400, 'BEFORE_NOT_MEMBER'],
    [{ move: [], before: null }, 400, 'BAD_MOVE'],
    [{ move: ['a'], before: null }, 400, 'BAD_MOVE'],
    [{ move: [m[1]] }, 400, 'BAD_BEFORE'],
    [{ order: [m[0]] }, 400, 'BAD_ORDER'],
  ];
  for (const [body, status, c] of cases) {
    const res = await post(`/api/collections/${coll}/order`, body);
    assert.strictEqual(res.status, status, JSON.stringify(body));
    assert.strictEqual((await res.json()).code, c, JSON.stringify(body));
  }
  let res = await post(`/api/collections/${folder}/order`, { move: [m[0]], before: null });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'FOLDER_TARGET');
  res = await post('/api/collections/999999/order', { move: [m[0]], before: null });
  assert.strictEqual(res.status, 404);
  assert.strictEqual((await res.json()).code, 'NOT_FOUND');
  res = await post('/api/collections/abc/order', { move: [m[0]], before: null });
  assert.strictEqual(res.status, 400);
  assert.deepStrictEqual(db.getCollectionItems(coll), m, 'nothing changed');
});

test('POST /api/collections/:id/order is 423 while the vault is locked', async () => {
  vault.bootLocked();
  try {
    const res = await post(`/api/collections/${coll}/order`, { move: [m[1]], before: m[0] });
    assert.strictEqual(res.status, 423);
  } finally {
    vault._locked = false;
  }
  assert.deepStrictEqual(db.getCollectionItems(coll), m);
});
