/**
 * lib/faces/store.js: the additive schema migration, what an indexed file
 * leaves behind (groups, exemplar vectors, crops, media columns) in both crop
 * modes (plain files and the encrypted secure-assets store), re-index
 * replacing everything, and hard delete / delete-all leaving nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-store-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const config = require('../config');
const db = require('../lib/database');
const secureAssets = require('../lib/secure-assets');
const store = require('../lib/faces/store');
const { person, like, group } = require('./helpers/faces-fakes');

const MODEL = 'stub-v1';
let nextPath = 0;

function addMedia(type, name) {
  const fp = path.join(tmp, 'media', `${++nextPath}-${name}`);
  return Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)')
    .run(fp, path.basename(fp), type).lastInsertRowid);
}

const rowsFor = (table, mediaId) => db.get().prepare(`SELECT * FROM ${table} WHERE media_id = ?`).all(mediaId);
const mediaCols = (id) => db.get().prepare('SELECT faces_indexed_at, faces_model, faces_error FROM media WHERE id = ?').get(id);

test.after(() => {
  try { secureAssets.close(); } catch {}
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('schema migration adds the faces columns and tables to an existing database', () => {
  // A database from before faces: full schema minus everything faces added.
  db.init();
  const id = addMedia('image', 'old.jpg');
  const d = db.get();
  d.exec('DROP TABLE face_vectors; DROP TABLE face_groups;');
  for (const c of ['faces_indexed_at', 'faces_model', 'faces_error']) d.exec(`ALTER TABLE media DROP COLUMN ${c}`);
  db.close();

  db.init();
  const cols = new Set(db.get().prepare('PRAGMA table_info(media)').all().map(c => c.name));
  for (const c of ['faces_indexed_at', 'faces_model', 'faces_error']) assert.ok(cols.has(c), c);
  const tables = new Set(db.get().prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map(r => r.name));
  for (const t of ['face_groups', 'face_vectors', 'idx_face_groups_media', 'idx_face_vectors_group', 'idx_face_vectors_media']) {
    assert.ok(tables.has(t), t);
  }
  assert.strictEqual(db.get().prepare('SELECT filename FROM media WHERE id = ?').get(id).filename, path.basename(db.get().prepare('SELECT filepath FROM media WHERE id = ?').get(id).filepath));
  assert.deepStrictEqual(mediaCols(id), { faces_indexed_at: null, faces_model: null, faces_error: null });
});

test('kindOf maps media types, .gif files and ineligible kinds', () => {
  assert.strictEqual(store.kindOf({ media_type: 'image', filename: 'a.jpg' }), 'image');
  assert.strictEqual(store.kindOf({ media_type: 'image', filename: 'a.GIF' }), 'gif');
  assert.strictEqual(store.kindOf({ media_type: 'gif', filename: 'a.webp' }), 'gif');
  assert.strictEqual(store.kindOf({ media_type: 'video', filename: 'a.mp4' }), 'video');
  assert.strictEqual(store.kindOf({ media_type: 'audio', filename: 'a.mp3' }), null);
  assert.strictEqual(store.kindOf({ media_type: 'document', filename: 'a.pdf' }), null);
  assert.strictEqual(store.kindOf(null), null);
});

test('an indexed video persists its groups, exemplars, crops and status (plain crops)', () => {
  const id = addMedia('video', 'v.mp4');
  const v0 = store.version();
  const gids = store.saveFileResult(id, MODEL, {
    groups: [
      group([person(0), like(0, 0.9, 101), like(0, 0.8, 102), like(0, 0.7, 103)], { appearances: 7, firstTimeS: 3.5, crop: Buffer.from('A') }),
      group(person(1), { appearances: 2, firstTimeS: 10.5, crop: Buffer.from('B') }),
    ],
  }, { isVideo: true });
  assert.strictEqual(gids.length, 2);
  assert.ok(store.version() > v0, 'writes bump the version');

  const groups = rowsFor('face_groups', id);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].appearances, 7);
  assert.strictEqual(groups[0].first_time_s, 3.5);
  assert.strictEqual(groups[0].model, MODEL);
  assert.deepStrictEqual(JSON.parse(groups[0].best_bbox), [0.1, 0.1, 0.2, 0.2]);
  const vecs = rowsFor('face_vectors', id);
  assert.strictEqual(vecs.length, 4, 'at most 3 exemplars per group');
  assert.strictEqual(vecs[0].embedding.length, 128 * 4);
  const back = store.decodeEmbedding(vecs[0].embedding);
  assert.ok(Math.abs(back[0] - 1) < 1e-6);

  const cols = mediaCols(id);
  assert.ok(cols.faces_indexed_at);
  assert.strictEqual(cols.faces_model, MODEL);
  assert.strictEqual(cols.faces_error, null);

  assert.strictEqual(fs.readFileSync(store.cropPath(gids[0]), 'utf8'), 'A');
  assert.strictEqual(store.getCrop(gids[1]).toString(), 'B');

  const f = store.getFileFaces(id, MODEL);
  assert.strictEqual(f.eligible, true);
  assert.strictEqual(f.indexed, true);
  assert.deepStrictEqual(f.groups.map(g => [g.appearances, g.firstTimeS, g.cropUrl]),
    [[7, 3.5, `/api/faces/crop/${gids[0]}`], [2, 10.5, `/api/faces/crop/${gids[1]}`]]);
});

test('images store no times; a file with no faces is indexed with no groups', () => {
  const img = addMedia('image', 'p.jpg');
  store.saveFileResult(img, MODEL, { groups: [group(person(2), { firstTimeS: 4 })] }, { isVideo: false });
  const g = rowsFor('face_groups', img)[0];
  assert.strictEqual(g.first_time_s, null);
  assert.strictEqual(g.best_time_s, null);

  const empty = addMedia('image', 'empty.jpg');
  store.saveFileResult(empty, MODEL, { groups: [] });
  assert.deepStrictEqual(store.getFileFaces(empty, MODEL), { eligible: true, indexed: true, error: null, groups: [] });
});

test('another model counts as not indexed', () => {
  const id = addMedia('image', 'm.jpg');
  store.saveFileResult(id, 'old-model', { groups: [group(person(3))] });
  const f = store.getFileFaces(id, MODEL);
  assert.strictEqual(f.indexed, false);
  assert.deepStrictEqual(f.groups, []);
  assert.strictEqual(store.getFileFaces(id, 'old-model').indexed, true);
});

test('errors are recorded without marking the file indexed; success clears them', () => {
  const id = addMedia('image', 'err.jpg');
  store.markError(id, 'x'.repeat(500));
  let c = mediaCols(id);
  assert.strictEqual(c.faces_indexed_at, null);
  assert.strictEqual(c.faces_error.length, 200);
  assert.strictEqual(store.getFileFaces(id, MODEL).indexed, false);
  store.saveFileResult(id, MODEL, { groups: [] });
  c = mediaCols(id);
  assert.ok(c.faces_indexed_at);
  assert.strictEqual(c.faces_error, null);
});

test('re-index replaces groups, vectors and crops', () => {
  const id = addMedia('image', 'r.jpg');
  const first = store.saveFileResult(id, MODEL, { groups: [group(person(4)), group(person(5))] });
  const second = store.saveFileResult(id, MODEL, { groups: [group(person(6), { crop: Buffer.from('new') })] });
  assert.strictEqual(rowsFor('face_groups', id).length, 1);
  assert.strictEqual(rowsFor('face_vectors', id).length, 1);
  for (const gid of first) {
    assert.ok(!fs.existsSync(store.cropPath(gid)), 'old crop removed');
    assert.ok(second[0] > gid, 'ids only grow');
  }
  assert.strictEqual(store.getCrop(second[0]).toString(), 'new');
});

test('a file deleted while it was being analyzed leaves nothing behind', () => {
  const id = addMedia('image', 'gone.jpg');
  db.get().prepare('DELETE FROM media WHERE id = ?').run(id);
  assert.strictEqual(store.saveFileResult(id, MODEL, { groups: [group(person(7))] }), null);
  assert.strictEqual(rowsFor('face_groups', id).length, 0);
});

test('hard delete (deleteRecords) removes groups, vectors and plain crops', () => {
  const id = addMedia('video', 'del.mp4');
  const gids = store.saveFileResult(id, MODEL, { groups: [group(person(8)), group(person(9))] }, { isVideo: true });
  for (const gid of gids) assert.ok(fs.existsSync(store.cropPath(gid)));
  const v0 = store.version();
  assert.strictEqual(db.deleteRecords([id]), 1);
  assert.strictEqual(rowsFor('face_groups', id).length, 0);
  assert.strictEqual(rowsFor('face_vectors', id).length, 0);
  for (const gid of gids) assert.ok(!fs.existsSync(store.cropPath(gid)));
  assert.ok(store.version() > v0);
});

test('hide marks the group hidden and drops it from the file chips', () => {
  const id = addMedia('image', 'h.jpg');
  const [a, b] = store.saveFileResult(id, MODEL, { groups: [group(person(10)), group(person(11))] });
  assert.strictEqual(store.hideGroup(a), true);
  assert.deepStrictEqual(store.getFileFaces(id, MODEL).groups.map(g => g.id), [b]);
  assert.strictEqual(store.hideGroup(999999), false);
});

test('counts: eligible, indexed, files with faces and visible people (trash excluded)', () => {
  const before = store.counts(MODEL);
  const a = addMedia('image', 'c1.jpg');
  const t = addMedia('image', 'c2.jpg');
  addMedia('audio', 'c3.mp3');
  store.saveFileResult(a, MODEL, { groups: [group(person(12)), group(person(13))] });
  store.saveFileResult(t, MODEL, { groups: [group(person(14))] });
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(t);
  const after = store.counts(MODEL);
  assert.strictEqual(after.eligible - before.eligible, 1);
  assert.strictEqual(after.indexed - before.indexed, 1);
  assert.strictEqual(after.withFaces - before.withFaces, 1);
  assert.strictEqual(after.people - before.people, 2);
});

test('delete-all clears tables, media columns and every plain crop', () => {
  const id = addMedia('image', 'all.jpg');
  const gids = store.saveFileResult(id, MODEL, { groups: [group(person(15))] });
  store.markError(addMedia('image', 'e.jpg'), 'boom');
  store.deleteAllData();
  const d = db.get();
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM face_groups').get().n, 0);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM face_vectors').get().n, 0);
  assert.strictEqual(d.prepare(`SELECT COUNT(*) AS n FROM media WHERE faces_indexed_at IS NOT NULL
    OR faces_model IS NOT NULL OR faces_error IS NOT NULL`).get().n, 0);
  assert.ok(!fs.existsSync(store.cropPath(gids[0])));
  assert.ok(!fs.existsSync(store.cropDir()), 'crop dir removed');
  const next = store.saveFileResult(id, MODEL, { groups: [group(person(15))] });
  assert.ok(next[0] > gids[0], 'ids are not reused after delete-all');
});

test('encrypted library: crops live in secure-assets, never on disk, and every delete path removes them', () => {
  secureAssets.init('faces-test-pass');
  try {
    assert.ok(secureAssets.enabled());
    const id = addMedia('image', 'sec.jpg');
    const [gid] = store.saveFileResult(id, MODEL, { groups: [group(person(16), { crop: Buffer.from('secret') })] });
    assert.ok(!fs.existsSync(store.cropPath(gid)), 'no plaintext crop');
    assert.strictEqual(secureAssets.get(id, `face-${gid}`).toString(), 'secret');
    assert.strictEqual(store.getCrop(gid).toString(), 'secret');

    // re-index drops the old crop
    const [gid2] = store.saveFileResult(id, MODEL, { groups: [group(person(16), { crop: Buffer.from('s2') })] });
    assert.strictEqual(secureAssets.get(id, `face-${gid}`), null);
    assert.strictEqual(store.getCrop(gid2).toString(), 's2');

    // hard delete
    db.deleteRecords([id]);
    assert.strictEqual(secureAssets.get(id, `face-${gid2}`), null);

    // delete-all
    const id2 = addMedia('image', 'sec2.jpg');
    const [gid3] = store.saveFileResult(id2, MODEL, { groups: [group(person(17))] });
    assert.ok(secureAssets.get(id2, `face-${gid3}`));
    secureAssets.put(id2, 'thumb', Buffer.from('keep me'));
    store.deleteAllData();
    assert.strictEqual(secureAssets.get(id2, `face-${gid3}`), null);
    assert.strictEqual(secureAssets.get(id2, 'thumb').toString(), 'keep me', 'only face crops go');
  } finally {
    secureAssets.close();
    secureAssets.init(null);
  }
  assert.ok(!secureAssets.enabled());
});

test('turning the vault on moves plain crops into the encrypted store', () => {
  const id = addMedia('image', 'mig.jpg');
  const [gid] = store.saveFileResult(id, MODEL, { groups: [group(person(18), { crop: Buffer.from('plain') })] });
  assert.ok(fs.existsSync(store.cropPath(gid)));
  secureAssets.init('faces-test-pass');
  try {
    secureAssets.migrateFromDisk();
    assert.ok(!fs.existsSync(store.cropPath(gid)), 'plaintext deleted');
    assert.strictEqual(secureAssets.get(id, `face-${gid}`).toString(), 'plain');
    assert.strictEqual(store.getCrop(gid).toString(), 'plain');
  } finally {
    secureAssets.close();
    secureAssets.init(null);
  }
});

test('regression: an unowned thumbnails folder gets no crop files (they could never be deleted)', () => {
  const ownedDir = require('../lib/owned-dir');
  const thumbs = config.paths.thumbnailDir;
  const marker = ownedDir.markerPath(thumbs);
  const junk = path.join(thumbs, 'my-holiday-notes.txt');
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(junk, 'user data');
  try {
    assert.ok(!ownedDir.isOwned(thumbs));
    const id = addMedia('image', 'unowned.jpg');
    const [gid] = store.saveFileResult(id, MODEL, { groups: [group(person(19), { crop: Buffer.from('x') })] });
    assert.ok(!fs.existsSync(store.cropPath(gid)), 'no crop written');
    assert.strictEqual(store.getCrop(gid), null);
    const f = store.getFileFaces(id, MODEL);
    assert.strictEqual(f.groups.length, 1, 'the chip is still there');
    assert.strictEqual(f.groups[0].cropUrl, null, 'without a picture');
  } finally {
    fs.rmSync(junk, { force: true });
    ownedDir.ensureManaged(thumbs, 'thumbs');
  }
  assert.ok(ownedDir.isOwned(thumbs));
});

test('regression: a delete nested in an outer transaction unlinks crops only after it commits, never on rollback', async () => {
  const d = db.get();
  const a = addMedia('image', 'nest-a.jpg');
  const [ga] = store.saveFileResult(a, MODEL, { groups: [group(person(20))] });
  d.transaction(() => { db.deleteRecords([a]); })();
  assert.ok(fs.existsSync(store.cropPath(ga)), 'still there inside the same turn');
  await new Promise(r => setImmediate(r));
  assert.ok(!fs.existsSync(store.cropPath(ga)), 'gone once the outer transaction committed');

  const b = addMedia('image', 'nest-b.jpg');
  const [gb] = store.saveFileResult(b, MODEL, { groups: [group(person(21))] });
  assert.throws(() => d.transaction(() => { db.deleteRecords([b]); throw new Error('rollback'); })(), /rollback/);
  await new Promise(r => setImmediate(r));
  assert.ok(d.prepare('SELECT 1 FROM face_groups WHERE id = ?').get(gb), 'rolled back');
  assert.ok(fs.existsSync(store.cropPath(gb)), 'its crop survives the rollback');
});
