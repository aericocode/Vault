/**
 * lib/faces/index-mem.js: Int8 brute-force search over stored exemplars.
 * Match widths, best-of-exemplars scoring, hidden / trash / other-model
 * exclusion, rebuild after writes, and the 5,000 cap with an honest total.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-index-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const store = require('../lib/faces/store');
const { createIndex, quantize } = require('../lib/faces/index-mem');
const { THRESHOLDS, thresholdFor } = require('../lib/faces/thresholds');
const { person, like, group } = require('./helpers/faces-fakes');

const MODEL = 'stub-v1';
let n = 0;
function addMedia(type = 'image') {
  return Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)')
    .run(path.join(tmp, `${++n}.jpg`), `${n}.jpg`, type).lastInsertRowid);
}
function indexFile(groups, model = MODEL) {
  const id = addMedia();
  const gids = store.saveFileResult(id, model, { groups: groups.map(g => group(g, { crop: Buffer.from('c') })) });
  return { id, gids };
}

test.before(() => db.init());
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('thresholds table: close > normal > wide, unknown width means normal', () => {
  assert.ok(THRESHOLDS.close > THRESHOLDS.normal && THRESHOLDS.normal > THRESHOLDS.wide);
  assert.strictEqual(thresholdFor('wide'), THRESHOLDS.wide);
  assert.strictEqual(thresholdFor('bogus'), THRESHOLDS.normal);
});

test('quantize rounds to Int8 and clamps', () => {
  const q = quantize(Float32Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : i === 1 ? -1 : i === 2 ? 0.5 : 0)));
  assert.deepStrictEqual([q[0], q[1], q[2], q[3]], [127, -127, 64, 0]);
});

test('widths, ranking, best-of-exemplars, hidden, trash and model exclusion', () => {
  const idx = createIndex();
  const query = [person(0)];
  const exact = indexFile([person(0)]);                 // same person, 1.0
  const close = indexFile([like(0, 0.60, 101)]);        // >= close
  const normal = indexFile([like(0, 0.44, 102)]);       // normal only
  const wide = indexFile([like(0, 0.36, 103)]);         // wide only
  const none = indexFile([like(0, 0.20, 104)]);         // never
  const other = indexFile([person(1)]);                 // someone else
  // Best exemplar of a group counts: one weak, one strong
  const multi = indexFile([[like(0, 0.10, 105), like(0, 0.55, 106)]]);

  const r = (w) => idx.query(query, thresholdFor(w), MODEL);
  assert.deepStrictEqual(r('close').ids, [exact.id, close.id, multi.id]);
  assert.deepStrictEqual(r('normal').ids, [exact.id, close.id, multi.id, normal.id]);
  const w = r('wide');
  assert.deepStrictEqual(w.ids, [exact.id, close.id, multi.id, normal.id, wide.id]);
  assert.ok(!w.ids.includes(none.id) && !w.ids.includes(other.id));
  assert.strictEqual(w.total, 5);
  assert.strictEqual(w.capped, false);
  assert.ok(Math.abs(w.scores[0] - 1) < 0.01);
  assert.ok(Math.abs(w.scores[1] - 0.60) < 0.01, `int8 score close to the float cosine (${w.scores[1]})`);
  for (let i = 1; i < w.scores.length; i++) assert.ok(w.scores[i - 1] >= w.scores[i]);

  // Several query vectors: a media scores its best match against any of them
  const two = idx.query([person(1), like(0, 0.6, 107)], THRESHOLDS.close, MODEL);
  assert.ok(two.ids.includes(other.id) && two.ids.includes(exact.id));

  // Hidden groups leave search (after the write the index rebuilds itself)
  const before = idx.stats();
  store.hideGroup(close.gids[0]);
  assert.ok(!r('wide').ids.includes(close.id));
  assert.strictEqual(idx.stats().vectors, before.vectors - 1, 'rebuilt without the hidden vector');

  // Trashed media drop out at query time, and come back on restore
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(normal.id);
  assert.ok(!r('wide').ids.includes(normal.id));
  db.get().prepare('UPDATE media SET user_trashed = 0 WHERE id = ?').run(normal.id);
  assert.ok(r('wide').ids.includes(normal.id));

  // Vectors from another model are never searched
  const old = indexFile([person(0)], 'old-model');
  assert.ok(!r('wide').ids.includes(old.id));

  // Hard delete removes the media from results
  db.deleteRecords([exact.id]);
  assert.ok(!r('wide').ids.includes(exact.id));
});

test('cap at 5,000 with the true total', () => {
  const d = db.get();
  const insM = d.prepare('INSERT INTO media (filepath, filename, media_type, faces_indexed_at, faces_model) VALUES (?, ?, ?, ?, ?)');
  const insG = d.prepare(`INSERT INTO face_groups (media_id, appearances, best_bbox, model, created_at) VALUES (?, 1, '[0,0,0,0]', ?, 'now')`);
  const insV = d.prepare('INSERT INTO face_vectors (group_id, media_id, embedding) VALUES (?, ?, ?)');
  const N = 5200;
  d.transaction(() => {
    for (let i = 0; i < N; i++) {
      const mid = Number(insM.run(path.join(tmp, 'cap', `${i}.jpg`), `${i}.jpg`, 'image', 'now', MODEL).lastInsertRowid);
      const gid = Number(insG.run(mid, MODEL).lastInsertRowid);
      insV.run(gid, mid, store.encodeEmbedding(like(50, 0.5 + (i % 400) / 1000, 120)));
    }
  })();
  const idx = createIndex();
  const r = idx.query([person(50)], THRESHOLDS.wide, MODEL);
  assert.strictEqual(r.total, N);
  assert.strictEqual(r.capped, true);
  assert.strictEqual(r.ids.length, 5000);
  assert.strictEqual(r.scores.length, 5000);
  assert.ok(r.scores[0] >= r.scores[4999]);
});
