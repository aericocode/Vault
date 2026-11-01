/**
 * A collection's total length (db.collectionLength): the server adds up the
 * lengths of its videos and sound files, so the count over the grid can show
 * "640 files · 1:17:12:08" at any size. Carried by GET /api/collections, GET
 * /api/collections/:id and the answers that change its files.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-coll-length-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const { app } = require('../server/index');

let server, base, coll, folder, inner;
const ids = {};

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)');
  const add = (name, type, d) => { ids[name] = Number(ins.run(`/l/${name}`, name, type, d).lastInsertRowid); };
  add('a.mp4', 'video', 3600.4);
  add('b.mp3', 'audio', 200.3);
  add('c.mp4', 'video', null);     // not probed yet
  add('d.mp4', 'video', 0);        // no length either
  add('e.jpg', 'image', null);     // pictures have none and count in nothing
  add('f.pdf', 'document', 12);    // nor documents, whatever they say (the grid does not list them)
  add('g.mp4', 'video', 500);      // in the trash: the grid hides it by default, so it counts in nothing
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(ids['g.mp4']);
  coll = db.createCollection('Long').id;
  db.addToCollection(coll, Object.values(ids));
  folder = db.createCollection('Box', { kind: 'folder' }).id;
  inner = db.createCollection('Inner', { parentId: folder }).id;
  db.addToCollection(inner, [ids['a.mp4'], ids['b.mp3']]);
  const inner2 = db.createCollection('Inner 2', { parentId: folder }).id;
  db.addToCollection(inner2, [ids['a.mp4']]);   // the same file twice in the folder counts once
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const json = async (p, opts) => (await fetch(base + p, opts)).json();
const send = (method, p, body) => json(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('collectionLength: videos and sound files with a length added up, the rest counted as unknown', () => {
  assert.deepStrictEqual(db.collectionLength(coll), { listed_count: 5, timed_count: 4, total_seconds: 3801, unknown_seconds_count: 2 });
  assert.strictEqual(db.collectionItemCount(coll), 7, 'item_count is still every member');
  // A folder: each file across its subtree once.
  assert.deepStrictEqual(db.collectionLength(folder), { listed_count: 2, timed_count: 2, total_seconds: 3801, unknown_seconds_count: 0 });
  const empty = db.createCollection('Empty').id;
  assert.deepStrictEqual(db.collectionLength(empty), { listed_count: 0, timed_count: 0, total_seconds: 0, unknown_seconds_count: 0 });
});

test('GET /api/collections and /api/collections/:id carry it', async () => {
  const list = await json('/api/collections');
  const c = list.find(x => x.id === coll), f = list.find(x => x.id === folder);
  assert.deepStrictEqual([c.item_count, c.listed_count, c.timed_count, c.total_seconds, c.unknown_seconds_count], [7, 5, 4, 3801, 2]);
  assert.deepStrictEqual([f.timed_count, f.total_seconds, f.unknown_seconds_count], [2, 3801, 0]);
  const one = await json(`/api/collections/${coll}`);
  assert.strictEqual(one.media_ids.length, 7);
  assert.deepStrictEqual([one.listed_count, one.timed_count, one.total_seconds, one.unknown_seconds_count], [5, 4, 3801, 2]);
});

test('adding, removing and reordering answer the new length', async () => {
  const removed = await send('DELETE', `/api/collections/${coll}/items`, { ids: [ids['a.mp4'], ids['c.mp4']] });
  assert.deepStrictEqual([removed.item_count, removed.listed_count, removed.timed_count, removed.total_seconds, removed.unknown_seconds_count], [5, 3, 2, 200, 1]);
  const added = await send('POST', `/api/collections/${coll}/items`, { ids: [ids['a.mp4']] });
  assert.deepStrictEqual([added.item_count, added.listed_count, added.timed_count, added.total_seconds, added.unknown_seconds_count], [6, 4, 3, 3801, 1]);
  const order = await send('POST', `/api/collections/${coll}/order`, { move: [ids['a.mp4']], before: null });
  assert.deepStrictEqual([order.timed_count, order.total_seconds, order.unknown_seconds_count], [3, 3801, 1]);
});

test('one query, quick on a big collection', () => {
  const d = db.get();
  const big = db.createCollection('Big').id;
  const ins = d.prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, 'video', 180)");
  const add = d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)');
  d.transaction(() => { for (let i = 0; i < 5000; i++) add.run(big, Number(ins.run(`/big/${i}.mp4`, `${i}.mp4`).lastInsertRowid), i); })();
  const t0 = process.hrtime.bigint();
  const len = db.collectionLength(big);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100);
  assert.deepStrictEqual(len, { listed_count: 5000, timed_count: 5000, total_seconds: 900000, unknown_seconds_count: 0 });
  const plan = d.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM collection_items ci JOIN media m ON m.id = ci.media_id WHERE ci.collection_id = ?`).all(big);
  assert.ok(plan.every(r => !/^SCAN (ci|collection_items)\b/.test(r.detail)), JSON.stringify(plan));
});

test('the types counted as listed are the grid\'s own (lib/library-query.js GRID_TYPES)', () => {
  assert.deepStrictEqual(db.LISTED_TYPES, require('../lib/library-query').GRID_TYPES);
});

test('putting a file back from the trash counts it again', () => {
  db.get().prepare('UPDATE media SET user_trashed = 0 WHERE id = ?').run(ids['g.mp4']);
  const len = db.collectionLength(coll);
  assert.deepStrictEqual([len.listed_count, len.timed_count, len.total_seconds], [5, 4, 3801 - 3600 + 500 + 3600]);
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(ids['g.mp4']);
});
