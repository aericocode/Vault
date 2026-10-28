/**
 * Files dropped while a collection is open go into it (beta report):
 * POST /api/import/add-paths with an optional collectionId adds the files to
 * the library as before and appends every one of them to the collection's
 * playlist order, in the order given: new files and files already in the
 * library alike (one already in the collection stays where it is). A bad,
 * missing or folder collection id is refused before anything is added.
 * Without collectionId nothing changes. Also lib/import-add.js addPaths'
 * `ids` (the row of each path taken, in order).
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-import-coll-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const scan = require('../commands/scan');
const importQueue = require('../lib/import-queue');
const importAdd = require('../lib/import-add');
const thumbs = require('../lib/thumbnails');
const mediaInfo = require('../lib/media-info');
const { app } = require('../server/index');

const disk = path.join(tmp, 'disk');
fs.mkdirSync(disk, { recursive: true });
const mk = (name) => { const p = path.join(disk, name); fs.writeFileSync(p, 'x'); return p; };

let server, base;
const orig = { processFile: scan.processFile, enqueueThumbnail: thumbs.enqueueThumbnail, isAvailable: mediaInfo.isAvailable };
test.before(async () => {
  // The AI scan "succeeds" at once; the fixtures are not real media, so no ffmpeg.
  scan.processFile = async () => ({});
  thumbs.enqueueThumbnail = () => null;
  mediaInfo.isAvailable = () => false;
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 25)); };
  await until(() => !importQueue.isActive());
  scan.processFile = orig.processFile;
  thumbs.enqueueThumbnail = orig.enqueueThumbnail;
  mediaInfo.isAvailable = orig.isAvailable;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const members = (id) => db.getCollectionItems(id);
const idOf = (p) => db.getByPath(p).id;

test('addPaths: ids are every path taken, new or already there, in order, each once', () => {
  const a = mk('ids-a.mp3'), b = mk('ids-b.mp3'), c = mk('ids-c.mp3');
  importAdd.addPaths([b], { analyse: false });
  const r = importAdd.addPaths([a, path.join(disk, 'nope.mp3'), b, path.join(disk, 'x.unknownext'), c, a], { analyse: false });
  assert.deepStrictEqual(r.ids, [idOf(a), idOf(b), idOf(c)]);
  assert.strictEqual(r.added.length, 2);
  assert.deepStrictEqual(r.skipped, { unsupported: 1, existing: 2, missing: 1 });
});

test('dropped into an open collection: new files and ones already in the library, appended in drop order', async () => {
  const coll = db.createCollection('Chill mix').id;
  const before = mk('before.mp3');
  const known = mk('known.mp3');
  const fresh1 = mk('fresh1.mp3');
  const fresh2 = mk('fresh2.jpg');
  importAdd.addPaths([before, known], { analyse: false });
  db.addToCollection(coll, [idOf(before)]);

  const r = await post('/api/import/add-paths', { paths: [fresh2, known, fresh1], collectionId: coll });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.added.length, 2, 'two new rows');
  assert.strictEqual(r.body.skipped.existing, 1, 'one already in the library');
  assert.strictEqual(r.body.queued, true);
  const want = [idOf(before), idOf(fresh2), idOf(known), idOf(fresh1)];
  assert.deepStrictEqual(members(coll), want, 'appended after what was there, in the order dropped');
  assert.strictEqual(r.body.collection.id, coll);
  assert.strictEqual(r.body.collection.added, 3);
  assert.deepStrictEqual(r.body.collection.ids, [idOf(fresh2), idOf(known), idOf(fresh1)]);
  assert.strictEqual(r.body.collection.item_count, 4);
  assert.deepStrictEqual(r.body.collection.first_ids, want);

  // Dropped again, with a file already in the collection: it stays where it is.
  const fresh3 = mk('fresh3.mp3');
  const again = await post('/api/import/add-paths', { paths: [before, fresh3], collectionId: coll });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.collection.added, 1);
  assert.deepStrictEqual(members(coll), [...want, idOf(fresh3)]);
});

test('a bad, missing or folder collection id is refused, and nothing is added', async () => {
  const p = mk('refused.mp3');
  const folder = db.createCollection('A folder', { kind: 'folder' }).id;
  for (const [collectionId, status, code] of [['x', 400, 'BAD_COLLECTION'], [0, 400, 'BAD_COLLECTION'], [-2, 400, 'BAD_COLLECTION'],
    [1.5, 400, 'BAD_COLLECTION'], [999999, 404, 'NOT_FOUND'], [folder, 400, 'FOLDER_TARGET']]) {
    const r = await post('/api/import/add-paths', { paths: [p], collectionId });
    assert.strictEqual(r.status, status, String(collectionId));
    assert.strictEqual(r.body.code, code, String(collectionId));
  }
  assert.ok(!db.getByPath(p), 'no row was made');
});

test('without a collection id: added to the library only, as before', async () => {
  const coll = db.createCollection('Untouched').id;
  const p = mk('plain.mp3');
  const r = await post('/api/import/add-paths', { paths: [p] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.collection, undefined);
  assert.strictEqual(r.body.added.length, 1);
  assert.deepStrictEqual(members(coll), []);
  // null counts as none too.
  const q = mk('plain2.mp3');
  const r2 = await post('/api/import/add-paths', { paths: [q], collectionId: null });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.collection, undefined);
});
