/**
 * Saved orders as variations of the playlist (lib/flow/saved.js,
 * server/flow-routes.js): one saved from Playlist order (shape 'playlist'),
 * a saved order's own skips (skips, NULL for none of its own) and the length
 * that comes with them, Duplicate keeping them, and a library from before
 * (no skip_json column) migrating with its saved orders as they were.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-flow-variation-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const saved = require('../lib/flow/saved');
const FlowOrder = require('../player-lib/flow-order.js');
const { app } = require('../server/index');

let server, base, coll;
const ids = [];

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 4; i++) ids.push(Number(ins.run(path.join(tmp, `f${i}.mp4`), `f${i}.mp4`, 'video', 60 * (i + 1)).lastInsertRowid));
  coll = db.createCollection('Mix').id;
  db.addToCollection(coll, ids);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  require('../lib/flow/service').cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const send = (method, p, body) => fetch(base + p, {
  method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});

test('saved from Playlist order: shape "playlist" kept; its own skips saved, changed and cleared, with the length they give', async () => {
  const order = [ids[2], ids[0], ids[3], ids[1]];
  let r = await send('POST', `/api/flow/collections/${coll}/saved`, { name: 'My mix', shape: 'playlist', order, skips: [ids[1]] });
  assert.strictEqual(r.status, 200);
  const a = await r.json();
  assert.deepStrictEqual({ shape: a.shape, order: a.order, skips: a.skips }, { shape: 'playlist', order, skips: [ids[1]] });
  // The length with its skips: 60+120+180+240 = 600 in all, file 2 (120 s) skipped.
  assert.strictEqual(a.length.total_seconds, 600);
  assert.deepStrictEqual([a.length.skipped_count, a.length.skipped_seconds], [1, 120]);

  // The playlist's own skips are not touched.
  assert.deepStrictEqual(db.getCollectionSkips(coll), []);

  r = await send('PUT', `/api/flow/saved/${a.id}`, { skips: [ids[0], ids[3]] });
  const b = await r.json();
  assert.deepStrictEqual(b.skips, [ids[0], ids[3]]);
  assert.deepStrictEqual([b.length.skipped_count, b.length.skipped_seconds], [2, 300]);
  assert.deepStrictEqual(b.order, order, 'the order stays');

  // null: none of its own again (it plays with the playlist's), and no length then.
  b.skips = null;
  r = await send('PUT', `/api/flow/saved/${a.id}`, { skips: null });
  const c = await r.json();
  assert.strictEqual(c.skips, null);
  assert.strictEqual(c.length, undefined);

  // The list says the same.
  const listed = await (await send('GET', `/api/flow/collections/${coll}/saved`)).json();
  assert.deepStrictEqual(listed.map(s => [s.name, s.shape, s.skips]), [['My mix', 'playlist', null]]);
});

test('a saved order with a shape and no skips given has none of its own', async () => {
  const r = await send('POST', `/api/flow/collections/${coll}/saved`, { name: 'Waves', shape: 'waves', waves: 3, order: ids });
  const a = await r.json();
  assert.strictEqual(a.shape, 'waves');
  assert.strictEqual(a.skips, null);
});

test('bad skips and shapes are refused', async () => {
  for (const body of [
    { name: 'x1', shape: 'playlist', order: ids, skips: 'all' },
    { name: 'x2', shape: 'playlist', order: ids, skips: [0] },
    { name: 'x3', shape: 'nope', order: ids },
  ]) {
    const r = await send('POST', `/api/flow/collections/${coll}/saved`, body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
});

test('Duplicate keeps each saved order\'s shape and own skips', async () => {
  const r = await send('POST', `/api/flow/collections/${coll}/saved`, { name: 'Dup me', shape: 'playlist', order: ids, skips: [ids[2]] });
  assert.strictEqual(r.status, 200);
  const copy = db.duplicateCollection(coll);
  const rows = saved.list(db.get(), copy.id);
  const d = rows.find(s => s.name === 'Dup me');
  assert.deepStrictEqual([d.shape, d.skips], ['playlist', [ids[2]]]);
});

test('an older Vault reading a "playlist" one sees Smooth with the same order (its toJson maps a shape it does not know)', () => {
  // What 3.10's toJson did: FlowOrder.isShape(r.shape) ? r.shape : 'smooth'.
  assert.strictEqual(FlowOrder.isShape('playlist'), false);
  assert.strictEqual(FlowOrder.isShape('playlist') ? 'playlist' : 'smooth', 'smooth');
});

test('a library from before: flow_saved_orders without skip_json gets the column, rows kept with no skips of their own', () => {
  const Database = require('better-sqlite3');
  const file = path.join(tmp, 'old.db');
  const old = new Database(file);
  old.exec('CREATE TABLE collection_items (collection_id INTEGER, media_id INTEGER, position INTEGER)');
  old.exec(`CREATE TABLE flow_saved_orders (id INTEGER PRIMARY KEY, collection_id INTEGER NOT NULL, name TEXT NOT NULL, shape TEXT NOT NULL,
    waves INTEGER, places INTEGER NOT NULL DEFAULT 0, order_json TEXT NOT NULL, created_at INTEGER, updated_at INTEGER)`);
  old.prepare('INSERT INTO flow_saved_orders (collection_id, name, shape, waves, places, order_json, created_at, updated_at) VALUES (1, ?, ?, 2, 0, ?, 1, 1)')
    .run('Old one', 'peak', JSON.stringify([3, 1, 2]));
  saved.ensureSchema(old);
  saved.ensureSchema(old);   // twice is fine
  const cols = old.prepare('PRAGMA table_info(flow_saved_orders)').all().map(c => c.name);
  assert.ok(cols.includes('skip_json'));
  const [row] = saved.list(old, 1);
  assert.deepStrictEqual([row.name, row.shape, row.order, row.skips], ['Old one', 'peak', [3, 1, 2], null]);
  // And what an older Vault writes (its INSERT names its own columns) still works.
  old.prepare('INSERT INTO flow_saved_orders (collection_id, name, shape, waves, places, order_json, created_at, updated_at) VALUES (1, ?, ?, 2, 0, ?, 2, 2)')
    .run('From 3.10', 'smooth', '[1]');
  assert.strictEqual(saved.list(old, 1)[1].skips, null);
  old.close();
});

test('own skips are kept to the collection\'s files: other files are not stored, a file taken out or deleted is pruned, an old row with a gone file reads without it', async () => {
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)');
  const a = Number(ins.run(path.join(tmp, 'p1.mp4'), 'p1.mp4', 'video', 30).lastInsertRowid);
  const b = Number(ins.run(path.join(tmp, 'p2.mp4'), 'p2.mp4', 'video', 30).lastInsertRowid);
  const c = Number(ins.run(path.join(tmp, 'p3.mp4'), 'p3.mp4', 'video', 30).lastInsertRowid);
  const outsider = Number(ins.run(path.join(tmp, 'p4.mp4'), 'p4.mp4', 'video', 30).lastInsertRowid);
  const pc = db.createCollection('Prune').id;
  db.addToCollection(pc, [a, b, c]);
  // A file of another collection is not stored (create and update).
  let r = await send('POST', `/api/flow/collections/${pc}/saved`, { name: 'P', shape: 'playlist', order: [a, b, c], skips: [a, outsider] });
  const row = await r.json();
  assert.deepStrictEqual(row.skips, [a]);
  r = await send('PUT', `/api/flow/saved/${row.id}`, { skips: [b, c, outsider] });
  assert.deepStrictEqual((await r.json()).skips, [b, c]);
  assert.deepStrictEqual(JSON.parse(db.get().prepare('SELECT skip_json FROM flow_saved_orders WHERE id = ?').get(row.id).skip_json), [b, c]);

  // Taken out of the collection: gone from its skips, and the length says so.
  db.removeFromCollection(pc, [b]);
  assert.deepStrictEqual(JSON.parse(db.get().prepare('SELECT skip_json FROM flow_saved_orders WHERE id = ?').get(row.id).skip_json), [c]);
  // Added back later: not skipped again.
  db.addToCollection(pc, [b]);
  let listed = await (await send('GET', `/api/flow/collections/${pc}/saved`)).json();
  assert.deepStrictEqual(listed[0].skips, [c]);
  assert.deepStrictEqual([listed[0].length.skipped_count, listed[0].length.skipped_seconds], [1, 30]);

  // Deleted from the library: pruned too.
  db.deleteRecords([c]);
  listed = await (await send('GET', `/api/flow/collections/${pc}/saved`)).json();
  assert.deepStrictEqual(listed[0].skips, []);
  assert.strictEqual(listed[0].length.skipped_count, 0);

  // A row from before still holding a file gone since: read without it.
  db.get().prepare('UPDATE flow_saved_orders SET skip_json = ? WHERE id = ?').run(JSON.stringify([outsider, a, 999999]), row.id);
  listed = await (await send('GET', `/api/flow/collections/${pc}/saved`)).json();
  assert.deepStrictEqual(listed[0].skips, [a]);
  assert.strictEqual(listed[0].length.skipped_count, 1);
});
