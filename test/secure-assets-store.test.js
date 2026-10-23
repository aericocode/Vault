/**
 * The encrypted derived-artifact store (lib/secure-assets.js):
 *  - moving plaintext files in never deletes a file whose encrypted copy was
 *    not stored: a sealed store (vault locked) defers the whole sweep and
 *    touches nothing, a failed write leaves that file in place, and the next
 *    run with the store open moves everything;
 *  - the seal holds across a failed unlock;
 *  - size and "last shown" queries are answered from the size index, never by
 *    reading the blobs (EXPLAIN QUERY PLAN), including on a store made before
 *    the index existed;
 *  - the bounded delete step and the batched touch still do all their work.
 * Throwaway DBs and folders only.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-secureassets-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;
delete process.env.VAULT_SUBS;

const config = require('../config');
const db = require('../lib/database');
const secureAssets = require('../lib/secure-assets');
const ownedDir = require('../lib/owned-dir');
const studios = require('../lib/studios');        // registers the studio cover migrator
const faces = require('../lib/faces/store');      // registers the face crop migrator

const PASS = 'store-test-pass';
const td = config.paths.thumbnailDir;
const rows = () => secureAssets.conn().prepare('SELECT media_id, kind, lang FROM assets ORDER BY media_id, kind, lang').all()
  .map(r => `${r.media_id}:${r.kind}${r.lang ? ':' + r.lang : ''}`);

let mediaId;
let groupId;

/** The plaintext files an older (or vault-off) version left behind, by path. */
function writePlainFiles() {
  fs.mkdirSync(td, { recursive: true });
  ownedDir.ensureManaged(td, 'thumbs');
  const files = {
    [path.join(td, `${mediaId}.jpg`)]: 'cover bytes',
    [path.join(td, `${mediaId}_s0.jpg`)]: 'scrub bytes',
    [path.join(td, `${mediaId}_beataudio.aac`)]: 'beat bytes',
    [path.join(td, 'subtitles', `${mediaId}.en.vtt`)]: 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello',
    [studios.coverPath(3)]: 'a photo the user uploaded',
    [faces.cropPath(groupId)]: 'face crop bytes',
  };
  for (const [p, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return files;
}

test.before(() => {
  db.init();
  const g = db.get();
  mediaId = Number(g.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'm.mp4', 'video')")
    .run(path.join(tmp, 'm.mp4')).lastInsertRowid);
  groupId = Number(g.prepare("INSERT INTO face_groups (media_id, best_bbox, model, created_at) VALUES (?, '[0,0,1,1]', 'test', datetime('now'))")
    .run(mediaId).lastInsertRowid);
  secureAssets.init(PASS);
});

test.after(() => {
  try { secureAssets.close(); } catch {}
  try { db.close(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('migration while the store is sealed deletes nothing, and runs in full after unlock', () => {
  const files = writePlainFiles();

  // The vault locks (lib/vault.js lock): main DB closed, store sealed.
  db.close();
  secureAssets.close();
  assert.ok(secureAssets.enabled() && secureAssets.sealed());

  const out = secureAssets.migrateFromDisk();
  assert.strictEqual(out.deferred, true, 'reported as deferred');
  assert.strictEqual(out.thumbs + out.scrubs + out.beat + out.subtitles, 0, 'nothing counted as migrated');
  for (const [p, body] of Object.entries(files)) {
    assert.ok(fs.existsSync(p), `still on disk: ${path.relative(tmp, p)}`);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), body, `unchanged: ${path.relative(tmp, p)}`);
  }
  // The studio migrator on its own is just as careful.
  assert.strictEqual(studios.migratePlainCovers(), 0);
  assert.ok(fs.existsSync(studios.coverPath(3)));

  // Unlock: nothing was stored while sealed, then one run moves everything.
  db.init();
  secureAssets.unlock(PASS);
  assert.deepStrictEqual(rows(), [], 'nothing reached the store while sealed');

  const out2 = secureAssets.migrateFromDisk();
  assert.strictEqual(out2.deferred, false);
  assert.deepStrictEqual(
    { thumbs: out2.thumbs, scrubs: out2.scrubs, beat: out2.beat, subtitles: out2.subtitles, kept: out2.kept },
    { thumbs: 1, scrubs: 1, beat: 1, subtitles: 1, kept: 0 });
  for (const p of Object.keys(files)) assert.ok(!fs.existsSync(p), `plaintext deleted: ${path.relative(tmp, p)}`);
  assert.strictEqual(secureAssets.get(mediaId, 'thumb').toString(), 'cover bytes');
  assert.strictEqual(secureAssets.get(mediaId, 'scrub0').toString(), 'scrub bytes');
  assert.strictEqual(secureAssets.get(mediaId, 'beataudio_adts').toString(), 'beat bytes');
  assert.match(secureAssets.get(mediaId, 'subtitle', 'en').toString(), /hello/);
  assert.strictEqual(secureAssets.get(0, 'studio-3').toString(), 'a photo the user uploaded');
  assert.strictEqual(secureAssets.get(mediaId, `face-${groupId}`).toString(), 'face crop bytes');

  // Idempotent: a second run finds nothing.
  const out3 = secureAssets.migrateFromDisk();
  assert.strictEqual(out3.thumbs + out3.scrubs + out3.beat + out3.subtitles + out3.kept, 0);
  secureAssets.conn().exec('DELETE FROM assets');
});

test('a file whose encrypted copy could not be written stays on disk', () => {
  const files = writePlainFiles();
  const c = secureAssets.conn();
  // The store refuses these two writes (as a full disk would).
  c.exec(`CREATE TEMP TRIGGER fail_cover BEFORE INSERT ON assets
            WHEN NEW.kind = 'thumb' OR NEW.kind = 'studio-3'
            BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
  try {
    const out = secureAssets.migrateFromDisk();
    assert.strictEqual(out.thumbs, 0);
    assert.strictEqual(out.kept, 1, 'the cover is counted as kept');
    assert.strictEqual(out.scrubs, 1, 'the others still move');
    assert.strictEqual(fs.readFileSync(path.join(td, `${mediaId}.jpg`), 'utf8'), 'cover bytes', 'cover left in place');
    assert.strictEqual(fs.readFileSync(studios.coverPath(3), 'utf8'), 'a photo the user uploaded', 'studio photo left in place');
    assert.ok(!fs.existsSync(path.join(td, `${mediaId}_s0.jpg`)), 'stored scrub frame deleted');
    assert.strictEqual(secureAssets.get(mediaId, 'thumb'), null);
    assert.strictEqual(secureAssets.get(0, 'studio-3'), null);
  } finally {
    c.exec('DROP TRIGGER temp.fail_cover');
  }
  // The next run picks up what was left.
  const again = secureAssets.migrateFromDisk();
  assert.strictEqual(again.thumbs, 1);
  assert.strictEqual(again.kept, 0);
  assert.ok(!fs.existsSync(path.join(td, `${mediaId}.jpg`)));
  assert.ok(!fs.existsSync(studios.coverPath(3)));
  assert.strictEqual(secureAssets.get(0, 'studio-3').toString(), 'a photo the user uploaded');
  for (const p of Object.keys(files)) assert.ok(!fs.existsSync(p));
  secureAssets.conn().exec('DELETE FROM assets');
});

test('putVerified: false while sealed, true only for a stored copy', () => {
  assert.strictEqual(secureAssets.putVerified(1, 'thumb', Buffer.from('x')), true);
  assert.strictEqual(secureAssets.get(1, 'thumb').toString(), 'x');
  secureAssets.close();
  assert.strictEqual(secureAssets.writable(), false);
  assert.strictEqual(secureAssets.putVerified(1, 'thumb', Buffer.from('y')), false);
  secureAssets.unlock(PASS);
  assert.strictEqual(secureAssets.writable(), true);
  assert.strictEqual(secureAssets.get(1, 'thumb').toString(), 'x', 'the sealed write never landed');
  secureAssets.conn().exec('DELETE FROM assets');
});

test('a failed unlock leaves the store sealed', () => {
  secureAssets.close();
  assert.throws(() => secureAssets.unlock('not-the-password'), (e) => e.code === 'DB_ENCRYPTED');
  assert.ok(secureAssets.sealed(), 'still sealed');
  assert.strictEqual(secureAssets.conn(), null, 'no connection, no retry with the wrong key');
  assert.strictEqual(secureAssets.put(1, 'thumb', Buffer.from('z')), false);
  secureAssets.unlock(PASS);
  assert.ok(!secureAssets.sealed());
});

function plan(sql) {
  const params = Array((sql.match(/\?/g) || []).length).fill(1);
  return secureAssets.conn().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail).join(' | ');
}

/** The SELECTs the store itself prepares while running fn (the real queries, not copies). */
function selectsDuring(fn) {
  const c = secureAssets.conn();
  const seen = [];
  const orig = c.prepare;
  c.prepare = function (sql) { seen.push(sql); return orig.call(this, sql); };
  try { fn(); } finally { delete c.prepare; }
  return seen.filter(s => /^\s*SELECT/i.test(s) && /\bassets\b/.test(s));
}

test('size queries are answered from the covering size index, also on a store made before it existed', () => {
  const c = secureAssets.conn();
  // A store as an older version left it: no size index.
  c.exec('DROP INDEX IF EXISTS assets_kind_media_size');
  const big = Buffer.alloc(20000, 7);       // spills to overflow pages, like a real thumbnail
  const ins = c.prepare("INSERT INTO assets (media_id, kind, lang, data, size) VALUES (?, ?, '', ?, ?)");
  c.transaction(() => {
    for (let i = 1; i <= 40; i++) {
      ins.run(i, 'thumb', big, big.length);
      ins.run(i, 'scrub0', big.subarray(0, 5000), 5000);
    }
    ins.run(1, 'face-9', big.subarray(0, 100), 100);
  })();
  assert.doesNotMatch(plan('SELECT kind, SUM(size) FROM assets GROUP BY kind'), /COVERING INDEX/,
    'old store: the sum reads the table');
  // Without the index the queries still work (slowly): a failed build never breaks them.
  assert.strictEqual(secureAssets.sizesByKind().length, 3);
  assert.strictEqual(secureAssets.mediaSizes(['thumb'], 7)[0].bytes, 20000);

  // Reopening (an unlock) adds the index, and again is a no-op.
  secureAssets.close();
  secureAssets.unlock(PASS);
  secureAssets.close();
  secureAssets.unlock(PASS);
  const idx = secureAssets.conn().prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'assets_kind_media_size'").all();
  assert.strictEqual(idx.length, 1);
  assert.match(idx[0].sql, /\(kind, media_id, size, updated_at\)/);

  const sqls = selectsDuring(() => {
    secureAssets.sizesByKind();
    secureAssets.mediaSizes(['thumb', 'scrub0']);
    secureAssets.mediaSizes(['thumb', 'scrub0'], 7);
    secureAssets.deleteKindsStep(['no-such-kind']);
  });
  assert.strictEqual(sqls.length, 4, sqls.join('\n'));
  for (const sql of sqls) {
    const p = plan(sql);
    assert.match(p, /USING COVERING INDEX assets_kind_media_size/, `${sql}\n  -> ${p}`);
    assert.doesNotMatch(p, /sqlite_autoindex|SCAN assets(?! USING COVERING)/, `no table read: ${p}`);
  }

  // And the numbers are right.
  const byKind = Object.fromEntries(secureAssets.sizesByKind().map(r => [r.kind, [r.bytes, r.count]]));
  assert.deepStrictEqual(byKind, { thumb: [800000, 40], scrub0: [200000, 40], 'face-9': [100, 1] });
  const one = secureAssets.mediaSizes(['thumb', 'scrub0'], 7);
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].bytes, 25000);
  assert.ok(one[0].seen > 0);
  assert.strictEqual(secureAssets.mediaSizes(['thumb', 'scrub0']).length, 40);
});

test('deleteKindsStep: bounded steps that remove only the given kinds, until done', () => {
  const n1 = secureAssets.deleteKindsStep(['scrub0'], 5);
  assert.ok(n1 >= 1 && n1 <= 5, `at most the limit (${n1})`);
  let total = n1;
  let steps = 1;
  for (;;) {
    const n = secureAssets.deleteKindsStep(['scrub0', 'scrub1']);
    if (!n) break;
    total += n;
    if (++steps > 1000) throw new Error('never finished');
  }
  assert.strictEqual(total, 40);
  const left = Object.fromEntries(secureAssets.sizesByKind().map(r => [r.kind, r.count]));
  assert.deepStrictEqual(left, { thumb: 40, 'face-9': 1 }, 'covers and face crops untouched');
});

test('touchMany stamps every row (a long batch finishes on later ticks)', async () => {
  const c = secureAssets.conn();
  const big = Buffer.alloc(20000, 5);
  const ins = c.prepare("INSERT INTO assets (media_id, kind, lang, data, size) VALUES (?, 'thumb', '', ?, ?)");
  c.transaction(() => { for (let i = 41; i <= 400; i++) ins.run(i, big, big.length); })();
  c.exec("UPDATE assets SET updated_at = '2000-01-01 00:00:00'");
  const ids = [];
  for (let i = 1; i <= 400; i++) ids.push(i);
  secureAssets.touchMany(ids, 'thumb');
  for (let i = 0; i < 200; i++) await new Promise(r => setImmediate(r));
  const stale = c.prepare("SELECT COUNT(*) AS n FROM assets WHERE kind = 'thumb' AND updated_at = '2000-01-01 00:00:00'").get().n;
  assert.strictEqual(stale, 0, 'every cover stamped');
  assert.strictEqual(c.prepare("SELECT updated_at FROM assets WHERE kind = 'face-9'").get().updated_at,
    '2000-01-01 00:00:00', 'other kinds untouched');

  // Sealed: nothing, and no throw from a queued remainder.
  secureAssets.close();
  assert.strictEqual(secureAssets.touchMany(ids, 'thumb'), 0);
  secureAssets.unlock(PASS);
});
