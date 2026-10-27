/**
 * Duplicating a collection: db.duplicateCollection (one transaction) and
 * POST /api/collections/:id/duplicate over HTTP.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-coll-dup-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const { app } = require('../server/index');

const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const rows = (id) => db.get().prepare(
  'SELECT media_id, position FROM collection_items WHERE collection_id = ? ORDER BY position'
).all(id);
const names = (parent) => db.getCollections().filter(c => c.parent_id === parent).map(c => c.name);

let server, base;
const m = [];

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)');
  for (let i = 0; i < 6; i++) m.push(Number(ins.run(`/d/f${i}.mp4`, `f${i}.mp4`, 'video').lastInsertRowid));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p) => fetch(base + p, { method: 'POST' });

test('copies the items at the same positions and leaves the original alone', () => {
  const a = db.createCollection('Mix', { description: 'late night' }).id;
  db.addToCollection(a, m);
  db.reorderCollection(a, { order: [m[3], m[0], m[5], m[1], m[4], m[2]] });
  const before = rows(a);
  const copy = db.duplicateCollection(a);
  assert.strictEqual(copy.name, 'Mix copy');
  assert.strictEqual(copy.kind, 'collection');
  assert.strictEqual(copy.description, 'late night');
  assert.notStrictEqual(copy.id, a);
  assert.deepStrictEqual(rows(copy.id), before);
  assert.deepStrictEqual(db.getCollectionItems(copy.id), db.getCollectionItems(a));
  assert.deepStrictEqual(rows(a), before, 'original items untouched');
  const orig = db.getCollections().find(c => c.id === a);
  assert.strictEqual(orig.name, 'Mix');
  assert.strictEqual(orig.description, 'late night');
  // Changing the copy does not touch the original.
  db.removeFromCollection(copy.id, [m[3]]);
  assert.deepStrictEqual(rows(a), before);
});

test('names the copy "copy", then "copy 2", "copy 3" when taken', () => {
  const a = db.createCollection('Name me').id;
  assert.strictEqual(db.duplicateCollection(a).name, 'Name me copy');
  assert.strictEqual(db.duplicateCollection(a).name, 'Name me copy 2');
  assert.strictEqual(db.duplicateCollection(a).name, 'Name me copy 3');
  // The check ignores case, like the rest of the names.
  db.createCollection('Case copy 2');
  const c = db.createCollection('case').id;
  db.createCollection('CASE COPY');
  assert.strictEqual(db.duplicateCollection(c).name, 'case copy 3');
});

test('the copy goes right after the original in the same folder', () => {
  const f = db.createCollection('Shelf', { kind: 'folder' }).id;
  const g = db.createCollection('Other shelf', { kind: 'folder' }).id;
  const a = db.createCollection('One', { parentId: f }).id;
  db.createCollection('Two', { parentId: f });
  db.createCollection('Three', { parentId: f });
  db.createCollection('One', { parentId: g });
  const copy = db.duplicateCollection(a);
  assert.strictEqual(copy.parent_id, f);
  assert.deepStrictEqual(names(f), ['One', 'One copy', 'Two', 'Three']);
  assert.deepStrictEqual(names(g), ['One'], 'other folders unchanged');
  // A copy of a middle one lands in the middle, not at the end.
  const two = db.getCollections().find(c => c.parent_id === f && c.name === 'Two').id;
  db.duplicateCollection(two);
  assert.deepStrictEqual(names(f), ['One', 'One copy', 'Two', 'Two copy', 'Three']);
  // The same name in another folder does not count as taken.
  assert.strictEqual(db.duplicateCollection(db.getCollections().find(c => c.parent_id === g).id).name, 'One copy');
});

test('top-level collections keep their place too', () => {
  const x = db.createCollection('Top A').id;
  db.createCollection('Top B');
  const copy = db.duplicateCollection(x);
  assert.strictEqual(copy.parent_id, null);
  const top = names(null);
  assert.strictEqual(top.indexOf('Top A copy'), top.indexOf('Top A') + 1);
});

test('folders are refused and a missing id says not found', () => {
  const f = db.createCollection('A folder', { kind: 'folder' }).id;
  const before = db.getCollections().length;
  assert.strictEqual(code(() => db.duplicateCollection(f)), 'FOLDER_TARGET');
  assert.strictEqual(code(() => db.duplicateCollection(987654)), 'NOT_FOUND');
  assert.strictEqual(db.getCollections().length, before, 'nothing created');
});

test('a big collection copies in one go', () => {
  const conn = db.get();
  const ins = conn.prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)');
  const ids = conn.transaction(() => Array.from({ length: 5000 }, (_, i) =>
    Number(ins.run(`/big/f${i}.mp4`, `f${i}.mp4`, 'video').lastInsertRowid)))();
  const big = db.createCollection('Big').id;
  db.addToCollection(big, ids);
  db.reorderCollection(big, { order: ids.slice().reverse() });
  const t0 = Date.now();
  const copy = db.duplicateCollection(big);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `took ${ms} ms`);
  assert.strictEqual(db.collectionItemCount(copy.id), 5000);
  assert.deepStrictEqual(db.getCollectionItems(copy.id), ids.slice().reverse());
  assert.deepStrictEqual(rows(copy.id), rows(big));
});

test('a failure part way leaves nothing behind', () => {
  const a = db.createCollection('Rollback').id;
  db.addToCollection(a, [m[0]]);
  const conn = db.get();
  conn.exec(`CREATE TRIGGER dup_boom BEFORE INSERT ON collection_items
    WHEN NEW.collection_id > ${a} BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  const n = db.getCollections().length;
  try {
    assert.throws(() => db.duplicateCollection(a), /boom/);
  } finally { conn.exec('DROP TRIGGER dup_boom'); }
  assert.strictEqual(db.getCollections().length, n);
});

test('POST /api/collections/:id/duplicate answers the new collection', async () => {
  const a = db.createCollection('Route').id;
  db.addToCollection(a, m.slice(0, 3));
  let res = await post(`/api/collections/${a}/duplicate`);
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.strictEqual(j.name, 'Route copy');
  assert.deepStrictEqual(db.getCollectionItems(j.id), m.slice(0, 3));
  res = await post(`/api/collections/${a}/duplicate`);
  assert.strictEqual((await res.json()).name, 'Route copy 2');
});

test('the route refuses folders (400), unknown ids (404) and bad ids (400)', async () => {
  const f = db.createCollection('Route folder', { kind: 'folder' }).id;
  let res = await post(`/api/collections/${f}/duplicate`);
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'FOLDER_TARGET');
  res = await post('/api/collections/987654/duplicate');
  assert.strictEqual(res.status, 404);
  res = await post('/api/collections/abc/duplicate');
  assert.strictEqual(res.status, 400);
});
