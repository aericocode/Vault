/**
 * Search index plumbing (lib/library-index.js): the ext column, the pure-SQL
 * sync triggers, the library version, and the background build.
 *
 * The triggers are what keep the FTS tables right when something other than
 * this server writes the file (a CLI scan, an older Vault), so they are
 * exercised both through the app's own writers and through raw SQL.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-index-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const idx = require('../lib/library-index');

test.before(() => { db.init(); });
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const raw = () => db.get();
const version = () => idx.version(raw());
const namesHit = (q) => raw().prepare('SELECT rowid FROM media_search_names WHERE media_search_names MATCH ? ORDER BY rowid').pluck().all(q);
const textHit = (q) => raw().prepare('SELECT rowid FROM media_search_text WHERE media_search_text MATCH ? ORDER BY rowid').pluck().all(q);
// A row's indexed themes, decoded from media_search_themes' hex tokens.
function terms(id) {
  raw().exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.themes_inst USING fts5vocab(main, 'media_search_themes', 'instance')");
  return raw().prepare('SELECT DISTINCT term FROM temp.themes_inst WHERE doc = ?').pluck().all(id)
    .map(h => Buffer.from(h, 'hex').toString('utf8')).sort();
}
const docs = (t) => raw().prepare(`SELECT count(*) FROM ${t}_docsize`).pluck().get();

let seq = 0;
function save(over = {}) {
  seq++;
  const data = {
    filepath: `/lib/f${seq}.mp4`, filename: `f${seq}.mp4`, mediaType: 'video',
    duration: 10, width: 1, height: 1, filesize: 1000 + seq,
    language: 'en', themes: ['Beach'], tags: ['sand'], description: 'plain words',
    qualityFlag: 'good', contentType: 'vlog', ...over,
  };
  db.saveMedia(data);
  return db.getMediaId(data.filepath);
}

// ── ext column ────────────────────────────────────────────────────────────

// The browser's getExtension(), verbatim from player-lib/filters.js.
function getExtension(filename) {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return '';
  return filename.substring(dot + 1).toLowerCase();
}

test('media.ext equals getExtension() on tricky names', () => {
  const names = ['clip.mp4', 'CLIP.MP4', 'Photo.JpEg', 'archive.tar.gz', 'no_extension', 'ends.with.dot.',
    '.bashrc', '.', '..', 'a.b.c.D', 'x..y', 'spaces in name .Mkv', 'dir.v2/file', 'weird.éXT', '', 'a'];
  const q = raw().prepare(`SELECT ${idx.EXT_EXPR} AS ext FROM (SELECT ? AS filename)`).pluck();
  for (const n of names) {
    // SQLite lower() folds ASCII only (documented); compare on ASCII names.
    const expected = /[^\x00-\x7f]/.test(n) ? getExtension(n).replace(/[^\x00-\x7f]/g, c => c) : getExtension(n);
    const got = q.get(n);
    if (/[^\x00-\x7f]/.test(n)) assert.strictEqual(got.toLowerCase(), expected, n);
    else assert.strictEqual(got, expected, JSON.stringify(n));
  }
  // And through the real generated column.
  const id = save({ filename: 'Movie.Final.MKV', filepath: '/lib/Movie.Final.MKV' });
  assert.strictEqual(raw().prepare('SELECT ext FROM media WHERE id = ?').pluck().get(id), 'mkv');
  // The viewer projection (PRAGMA table_info) does not ship it.
  assert.ok(!('ext' in db.getByIdForViewer(id)));
});

// ── Triggers ──────────────────────────────────────────────────────────────

test('saveMedia indexes the FTS tables and themes, and bumps the version', () => {
  const v0 = version();
  const id = save({ filename: 'beach_sunset_2019.mp4', filepath: '/lib/beach_sunset_2019.mp4',
    themes: ['Golden Hour', 'golden hour', 'Sea'], description: 'waves at dusk' });
  assert.ok(version() > v0);
  assert.ok(namesHit('"unse"').includes(id));
  assert.ok(textHit('"dusk"').includes(id));
  // saveMedia wrote media_clean too: terms come from the clean copy (deduped).
  assert.deepStrictEqual(terms(id), ['golden hour', 'sea']);
});

test('setAiFields / setUserFields / trash / repointPath keep the index right', () => {
  const id = save({ filename: 'old_name.mp4', filepath: '/lib/old_name.mp4', description: 'first text' });

  db.setAiFields(id, { description: 'second text', themes: ['Forest'] });
  assert.ok(!textHit('"first"').includes(id));
  assert.ok(textHit('"second"').includes(id));
  assert.deepStrictEqual(terms(id), ['forest']);

  const v1 = version();
  db.setUserFields(id, { user_notes: '[{"text":"remember this"}]' });
  assert.ok(textHit('{user_notes} : "remember"').includes(id));
  assert.ok(version() > v1, 'notes change results (hasNotes filter): version bumps');

  db.markTrashed(id, '/trash/old_name.mp4', '/lib/old_name.mp4');
  assert.ok(namesHit('"trash/old"').includes(id));
  db.markUntrashed(id, '/lib/old_name.mp4');
  assert.ok(!namesHit('"trash/old"').includes(id));

  db.repointPath(id, '/moved/new_name.mp4');
  assert.ok(namesHit('"new_name"').includes(id));
  assert.ok(!namesHit('"old_name"').includes(id));
});

test('deleteRecords removes the row from every search table', () => {
  const id = save({ filename: 'doomed_file.mp4', filepath: '/lib/doomed_file.mp4', description: 'doomedword' });
  assert.ok(namesHit('"doomed_file"').includes(id));
  const v0 = version();
  db.deleteRecords([id]);
  assert.deepStrictEqual(namesHit('"doomed_file"'), []);
  assert.deepStrictEqual(textHit('"doomedword"'), []);
  assert.deepStrictEqual(terms(id), []);
  assert.ok(version() > v0);
  assert.strictEqual(docs('media_search_names'), raw().prepare('SELECT count(*) FROM media').pluck().get());
});

test('upsertClean and raw media_clean writes rebuild terms; the clean copy wins', () => {
  const id = save({ themes: ['Alpha'] });
  assert.deepStrictEqual(terms(id), ['alpha']);
  db.upsertClean(id, { themes: ['Beta', 'Gamma'] });
  assert.deepStrictEqual(terms(id), ['beta', 'gamma']);
  // Clean row gone: the raw column is the fallback, as themes_clean || themes.
  raw().prepare('DELETE FROM media_clean WHERE media_id = ?').run(id);
  assert.deepStrictEqual(terms(id), ['Alpha']);
  // Empty clean themes also fall back to raw.
  raw().prepare("INSERT INTO media_clean (media_id, themes) VALUES (?, '')").run(id);
  assert.deepStrictEqual(terms(id), ['Alpha']);
  raw().prepare("UPDATE media_clean SET themes = '[\"delta\"]' WHERE media_id = ?").run(id);
  assert.deepStrictEqual(terms(id), ['delta']);
});

test('raw SQL writes (an older Vault, a CLI in another process) stay indexed', () => {
  const r = raw();
  const info = r.prepare(`INSERT INTO media (filepath, filename, media_type, themes, description)
    VALUES ('/raw/raw_insert.png', 'raw_insert.png', 'image', '["Raw Theme", "Raw Theme", 7, null]', 'rawdesc words')`).run();
  const id = Number(info.lastInsertRowid);
  assert.ok(namesHit('"raw_insert"').includes(id));
  assert.ok(textHit('"rawdesc"').includes(id));
  // No clean row: raw values, text only, once each.
  assert.deepStrictEqual(terms(id), ['Raw Theme']);

  r.prepare("UPDATE media SET themes = '[\"Other\"]', filename = 'renamed_raw.png' WHERE id = ?").run(id);
  assert.deepStrictEqual(terms(id), ['Other']);
  assert.ok(namesHit('"renamed_raw"').includes(id));
  assert.ok(!namesHit('{filename} : "raw_insert"').includes(id), 'the old file name is gone');

  r.prepare('DELETE FROM media WHERE id = ?').run(id);
  assert.ok(!namesHit('"renamed_raw"').includes(id));
  assert.deepStrictEqual(terms(id), []);
});

test('only grid rows get theme terms; a type change adds or removes them', () => {
  const r = raw();
  const id = Number(r.prepare(`INSERT INTO media (filepath, filename, media_type, themes)
    VALUES ('/doc/notes.pdf', 'notes.pdf', 'document', '["paper"]')`).run().lastInsertRowid);
  assert.deepStrictEqual(terms(id), [], 'documents never reach the grid');
  r.prepare("UPDATE media SET media_type = 'image' WHERE id = ?").run(id);
  assert.deepStrictEqual(terms(id), ['paper']);
  db.upsertClean(id, { themes: ['Clean Paper'] });
  assert.deepStrictEqual(terms(id), ['clean paper']);
  r.prepare("UPDATE media SET media_type = 'document' WHERE id = ?").run(id);
  assert.deepStrictEqual(terms(id), []);
});

test('changed trigger bodies replace the stored ones (trigger_schema)', () => {
  const r = raw();
  r.exec('DROP TRIGGER media_version_ai');
  r.exec('CREATE TRIGGER media_version_ai AFTER INSERT ON media BEGIN SELECT 1; END');
  idx.setMeta(r, 'trigger_schema', 0);
  idx.ensureSchema(r);
  assert.match(r.prepare("SELECT sql FROM sqlite_master WHERE name = 'media_version_ai'").pluck().get(), /library_meta/);
  assert.strictEqual(idx.getMeta(r, 'trigger_schema'), idx.TRIGGER_SCHEMA);
});

test('invalid or non-array JSON in themes never makes a write fail', () => {
  const r = raw();
  for (const bad of ['not json', '{"a":1}', '"just a string"', '[unclosed', '', null, '42']) {
    const info = r.prepare(`INSERT INTO media (filepath, filename, media_type, themes)
      VALUES (?, 'bad.mp4', 'video', ?)`).run(`/bad/${Math.random()}`, bad);
    const id = Number(info.lastInsertRowid);
    assert.deepStrictEqual(terms(id), [], String(bad));
    r.prepare('UPDATE media SET themes = ? WHERE id = ?').run('{broken', id);
    r.prepare("INSERT INTO media_clean (media_id, themes) VALUES (?, 'also broken')").run(id);
    assert.deepStrictEqual(terms(id), []);
  }
});

test('playback telemetry does not bump the version; filter-relevant writes do', () => {
  const id = save();
  let v = version();
  db.incrementViewCount(id);
  db.markDone(id, 12);
  db.markHot(id, 3);
  db.mergeHeatmap(id, new Array(100).fill(1));
  db.setUserFields(id, { last_position: 42 });
  raw().prepare("UPDATE media SET embedding = x'00', embedding_model = 'm' WHERE id = ?").run(id);
  assert.strictEqual(version(), v, 'views, done, hot, heatmaps, position, embedding: no bump');

  db.setUserFields(id, { user_rating: 4 });
  assert.ok(version() > v); v = version();
  db.setUserFields(id, { user_rating: 4 });
  assert.strictEqual(version(), v, 'a write that changes nothing does not bump');
  raw().prepare('UPDATE media SET thumb_version = thumb_version + 1 WHERE id = ?').run(id);
  assert.ok(version() > v); v = version();

  const coll = db.createCollection(`c${Math.random()}`);
  db.addToCollection(coll.id, [id]);
  assert.ok(version() > v); v = version();
  db.removeFromCollection(coll.id, [id]);
  assert.ok(version() > v); v = version();

  const repo = require('../lib/musicid/repo');
  const song = repo.findOrCreateSong({ title: 'T', artist: 'A' });
  raw().prepare('INSERT INTO media_songs (media_id, song_id) VALUES (?, ?)').run(id, song.id ?? song);
  assert.ok(version() > v);
});

// ── Build ─────────────────────────────────────────────────────────────────

const mediaCount = () => raw().prepare('SELECT count(*) FROM media').pluck().get();
const snapshot = () => ({
  names: raw().prepare('SELECT id FROM media_search_names_docsize ORDER BY id').pluck().all(),
  text: raw().prepare('SELECT id FROM media_search_text_docsize ORDER BY id').pluck().all(),
  themes: raw().prepare('SELECT id FROM media_search_themes_docsize ORDER BY id').pluck().all()
    .map(id => [id, terms(id)]),
});

// An interrupted first build: tables emptied, not marked built.
function wipeSearch() {
  idx.setMeta(raw(), 'search_built', 0);
  raw().exec(`
    INSERT INTO media_search_names (media_search_names) VALUES ('delete-all');
    INSERT INTO media_search_text (media_search_text) VALUES ('delete-all');
    INSERT INTO media_search_themes (media_search_themes) VALUES ('delete-all');`);
}

test('a new empty library starts ready; an unfinished build resumes', () => {
  // This file's DB was created empty by init(), so it started ready, with
  // every sort/filter index already there.
  assert.strictEqual(idx.getMeta(raw(), 'search_schema'), idx.SEARCH_SCHEMA);
  assert.deepStrictEqual(idx.missingIndexes(raw()), []);
  for (let i = 0; i < 30; i++) save();
  assert.strictEqual(idx.buildReason(raw()), null, 'triggers kept it current');
  wipeSearch();
  assert.strictEqual(idx.buildReason(raw()), 'resume');
});

test('build: fills everything, is idempotent, and survives writes between batches', async () => {
  const before = mediaCount();
  // Writes land between batches (setImmediate), including rows the build
  // has already passed and rows it has not reached yet.
  let writes = 0;
  const iv = setInterval(() => {
    writes++;
    save({ description: `during build ${writes}` });
    const victim = raw().prepare('SELECT id FROM media ORDER BY random() LIMIT 1').pluck().get();
    db.setAiFields(victim, { description: `edited ${writes}`, themes: [`t${writes}`] });
  }, 0);
  const stats = await idx.startBuild(() => db.get(), { batch: 7, log: () => {} });
  clearInterval(iv);
  assert.ok(stats && stats.batches > 3, 'ran in several batches');
  assert.ok(mediaCount() > before, 'writes happened during the build');
  assert.strictEqual(idx.buildReason(raw()), null);
  assert.strictEqual(idx.status(raw()).state, 'ready');
  const a = snapshot();
  assert.strictEqual(a.names.length, mediaCount());
  assert.strictEqual(a.text.length, mediaCount());

  // Idempotent: the same rows index to the same state, run again.
  idx.setMeta(raw(), 'search_built', 0);
  await idx.startBuild(() => db.get(), { batch: 5, log: () => {} });
  assert.deepStrictEqual(snapshot(), a);

  // And it equals what the triggers alone would produce: compare against a
  // fresh per-row derivation of the terms.
  const expected = raw().prepare(`SELECT m.id, j.value FROM media m LEFT JOIN media_clean mc ON mc.media_id = m.id,
      json_each(CASE WHEN json_valid(COALESCE(NULLIF(mc.themes, ''), NULLIF(m.themes, '')))
        AND json_type(COALESCE(NULLIF(mc.themes, ''), NULLIF(m.themes, ''))) = 'array'
        THEN COALESCE(NULLIF(mc.themes, ''), NULLIF(m.themes, '')) ELSE '[]' END) j
      WHERE j.type = 'text' AND j.value <> '' AND m.media_type IN ('video', 'audio', 'image', 'gif', 'mix')
      GROUP BY m.id, j.value ORDER BY m.id`).raw().all();
  const byId = new Map();
  for (const [id, t] of expected) byId.set(id, [...(byId.get(id) || []), t]);
  assert.deepStrictEqual(a.themes, [...byId].map(([id, t]) => [id, t.sort()]));
});

test('build: a schema bump rebuilds from scratch', async () => {
  idx.setMeta(raw(), 'search_schema', 0);
  assert.strictEqual(idx.buildReason(raw()), 'schema');
  const stats = await idx.startBuild(() => db.get(), { log: () => {} });
  assert.strictEqual(stats.reason, 'schema');
  assert.strictEqual(idx.buildReason(raw()), null);
  assert.strictEqual(idx.getMeta(raw(), 'search_schema'), idx.SEARCH_SCHEMA);
});

test('build: stops cleanly when the database closes, and resumes after reopen', async () => {
  wipeSearch();
  const p = idx.startBuild(() => db.get(), { batch: 3, log: () => {} });
  assert.strictEqual(idx.status(raw()).state, 'building');
  await new Promise(r => setImmediate(r));
  db.close();                     // what the vault lock does
  assert.strictEqual(await p, null, 'stopped, not failed');
  assert.strictEqual(idx._state.error, null);
  db.init();
  assert.notStrictEqual(idx.buildReason(raw()), null);
  await idx.startBuild(() => db.get(), { log: () => {} });
  assert.strictEqual(idx.buildReason(raw()), null);
  assert.strictEqual(snapshot().names.length, mediaCount());
});

test('build: stopBuild() ends a run at the next batch', async () => {
  wipeSearch();
  const p = idx.startBuild(() => db.get(), { batch: 2, log: () => {} });
  idx.stopBuild();
  assert.strictEqual(await p, null);
  assert.strictEqual(idx.status(raw()).state, 'building', 'not built yet: search still reports building');
  await idx.startBuild(() => db.get(), { log: () => {} });
  assert.strictEqual(idx.status(raw()).state, 'ready');
});

// ── Drift repair (round 2) ────────────────────────────────────────────────

const docIds = (t) => raw().prepare(`SELECT id FROM ${t}_docsize ORDER BY id`).pluck().all();
function assertConsistent() {
  // Searchable ids only (idx.validId): others are never indexed.
  const ids = raw().prepare(`SELECT id FROM media WHERE ${idx.validId('id')} ORDER BY id`).pluck().all();
  assert.deepStrictEqual(docIds('media_search_names'), ids);
  assert.deepStrictEqual(docIds('media_search_text'), ids);
  // Themes: exactly the grid rows with at least one string theme.
  const want = [];
  for (const r of raw().prepare(`SELECT m.id, m.media_type, mc.themes AS tc, m.themes FROM media m
      LEFT JOIN media_clean mc ON mc.media_id = m.id WHERE ${idx.validId('m.id')} ORDER BY m.id`).all()) {
    if (!['video', 'audio', 'image', 'gif', 'mix'].includes(r.media_type)) continue;
    let arr;
    try { arr = JSON.parse(r.tc || r.themes || '[]'); } catch { continue; }
    if (Array.isArray(arr) && arr.some(x => typeof x === 'string' && x !== '')) want.push(r.id);
  }
  assert.deepStrictEqual(docIds('media_search_themes'), want);
}

test('changing a row id moves its search entries (UPDATE OF id trigger)', () => {
  const id = save({ filename: 'renumber_me.mp4', filepath: '/lib/renumber_me.mp4', themes: ['Moved'] });
  const v0 = version();
  const newId = 900000 + id;
  raw().prepare('UPDATE media SET id = ? WHERE id = ?').run(newId, id);
  assert.ok(version() > v0);
  assert.deepStrictEqual(namesHit('"renumber_me"'), [newId]);
  assert.deepStrictEqual(textHit('"renumber_me"'), [newId]);
  assert.ok(!docIds('media_search_names').includes(id));
  // Themes: the clean row still points at the old id, so the raw value applies.
  assert.deepStrictEqual(terms(newId), ['Moved']);
  assert.deepStrictEqual(terms(id), []);
  // Id and text changed together: one entry, not two.
  raw().prepare("UPDATE media SET id = ?, description = 'both at once' WHERE id = ?").run(newId + 1, newId);
  assert.deepStrictEqual(textHit('"both at once"'), [newId + 1]);
  assert.strictEqual(docIds('media_search_text').filter(x => x === newId + 1).length, 1);
});

test('repair fixes INSERT OR REPLACE and writes made without the triggers', async () => {
  const r = raw();
  const keep = save({ filename: 'replaced.mp4', filepath: '/lib/replaced.mp4', description: 'before replace' });
  // REPLACE deletes the old row without firing its DELETE trigger
  // (recursive_triggers is off): the old rowid stays behind in every table.
  r.prepare(`INSERT OR REPLACE INTO media (filepath, filename, media_type, description, themes)
    VALUES ('/lib/replaced.mp4', 'replaced.mp4', 'video', 'after replace', '["Fresh"]')`).run();
  assert.ok(docIds('media_search_names').includes(keep), 'stale rowid left behind');
  // A row written while the triggers were missing (an old tool, a restore).
  const trig = r.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name = 'media_search_ai'").get();
  r.exec('DROP TRIGGER media_search_ai');
  const ghost = Number(r.prepare(`INSERT INTO media (filepath, filename, media_type, themes)
    VALUES ('/lib/untracked.mp4', 'untracked.mp4', 'image', '["Untracked"]')`).run().lastInsertRowid);
  r.exec(trig.sql);
  assert.ok(!docIds('media_search_names').includes(ghost));
  // Counts can even match (one extra, one missing): only an anti-join sees it.
  const v = idx.version(r);
  const stats = await idx.startBuild(() => db.get(), { log: () => {} });
  assert.strictEqual(stats.reason, null);
  assert.ok(stats.repair.orphans >= 3 && stats.repair.missing >= 1, JSON.stringify(stats.repair));
  assert.deepStrictEqual(namesHit('{filename} : "untracked"'), [ghost]);
  assert.deepStrictEqual(terms(ghost), ['Untracked']);
  assert.deepStrictEqual(textHit('"before replace"'), []);
  assertConsistent();
  // Nothing wrong: the next pass finds nothing and changes nothing.
  const again = await idx.startBuild(() => db.get(), { log: () => {} });
  assert.deepStrictEqual([again.repair.orphans, again.repair.missing], [0, 0]);
  assert.ok(idx.version(r) >= v);
});

test('a schema bump reports building from the very start (D7)', async () => {
  idx.setMeta(raw(), 'search_schema', 0);
  assert.strictEqual(idx.status(raw()).state, 'ready', 'nothing has started yet');
  const p = idx.startBuild(() => db.get(), { batch: 3, log: () => {} });
  assert.strictEqual(idx.status(raw()).state, 'building');
  await p;
  assert.strictEqual(idx.status(raw()).state, 'ready');
});

test('no-op writes to media_clean and collections cost no version bump (D6)', () => {
  const id = save({ themes: ['Same'], tags: ['t'] });
  db.backfillClean();             // bring every clean row in line first
  const v = version();
  db.upsertClean(id, { themes: ['Same'], tags: ['t'], locations: [] });
  db.backfillClean();             // a second `vault clean`: nothing changes
  assert.strictEqual(version(), v, 'vault clean on unchanged rows bumps nothing');
  db.upsertClean(id, { themes: ['Same'], tags: ['other'], locations: [] });
  assert.ok(version() > v, 'a clean tag change shows on tiles: bump');
});

test('db.init never creates sort indexes on an existing library; the server step does (D1)', () => {
  raw().exec('DROP INDEX idx_media_sort_views; DROP INDEX idx_media_flag_starred');
  db.close();
  db.init();                      // what every CLI command does
  assert.deepStrictEqual(idx.missingIndexes(raw()).map(i => i[0]).sort(), ['idx_media_flag_starred', 'idx_media_sort_views']);
  const lines = [];
  const done = idx.createMissingIndexes(raw(), { log: (l) => lines.push(l) });
  assert.deepStrictEqual(done.map(d => d[0]).sort(), ['idx_media_flag_starred', 'idx_media_sort_views']);
  assert.deepStrictEqual(lines.map(l => l.trim()), [
    'Preparing the library for search (one time): 1 of 2',
    'Preparing the library for search (one time): 2 of 2',
  ]);
  assert.deepStrictEqual(idx.missingIndexes(raw()), []);
});

// ── Round 3 ───────────────────────────────────────────────────────────────

test('repair walks the ids that exist: a row at id 2,000,000,000 costs one step (R3-3)', async () => {
  raw().prepare(`INSERT INTO media (id, filepath, filename, media_type, themes)
    VALUES (2000000000, '/far/away.mp4', 'far_away.mp4', 'video', '["Far"]')`).run();
  // and one missing from the index, out there too
  raw().prepare('DELETE FROM media_search_text WHERE rowid = 2000000000').run();
  const t0 = Date.now();
  const stats = await idx.startBuild(() => db.get(), { log: () => {} });
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.strictEqual(stats.repair.missing, 1);
  assert.deepStrictEqual(textHit('"far_away"'), [2000000000]);
  assertConsistent();
});

test('ids outside 1..4294967295 are never indexed and never break build or repair (round 5)', async () => {
  // (Not the largest rowid here: later inserts in this file need a free one.)
  const OUT = [0, -7, -9e15, 4294967296, -9223372036854775808n];
  const ins = raw().prepare(`INSERT INTO media (id, filepath, filename, media_type, themes)
    VALUES (?, ?, ?, 'video', '["Outside"]')`);
  OUT.forEach((id, i) => ins.run(id, `/out/zz_out_${i}.mp4`, `zz_out_${i}.mp4`));
  const anyOut = (t) => raw().prepare(`SELECT count(*) FROM ${t}_docsize WHERE NOT (${idx.validId('id')})`).pluck().get();
  const tables = ['media_search_names', 'media_search_text', 'media_search_themes'];
  // The triggers skip them,
  for (const t of tables) assert.strictEqual(anyOut(t), 0, t);
  assert.deepStrictEqual(textHit('"zz_out_1"'), []);
  // a full build skips them,
  wipeSearch();
  await idx.startBuild(() => db.get(), { log: () => {} });
  for (const t of tables) assert.strictEqual(anyOut(t), 0, t);
  assertConsistent();
  // and repair neither indexes them nor counts them missing, but removes
  // entries an older version left for them.
  const first = await idx.startBuild(() => db.get(), { log: () => {} });
  assert.deepStrictEqual([first.repair.missing, first.repair.orphans], [0, 0]);
  raw().prepare("INSERT INTO media_search_text (rowid, filename) VALUES (-7, 'zz_out_1.mp4')").run();
  raw().prepare("INSERT INTO media_search_names (rowid, filename) VALUES (4294967296, 'zz_out_3.mp4')").run();
  const second = await idx.startBuild(() => db.get(), { log: () => {} });
  assert.deepStrictEqual([second.repair.missing, second.repair.orphans], [0, 2]);
  for (const t of tables) assert.strictEqual(anyOut(t), 0, t);
  assertConsistent();
  // Id changes in and out of the range follow the same rule.
  // (An explicit id: with a row at 4294967296, SQLite numbers new rows above it, out of range too.)
  const id = 777777;
  raw().prepare("INSERT INTO media (id, filepath, filename, media_type) VALUES (?, '/out/zz_moves.mp4', 'zz_moves.mp4', 'video')").run(id);
  raw().prepare('UPDATE media SET id = -100 WHERE id = ?').run(id);
  assert.deepStrictEqual(textHit('"zz_moves"'), []);
  raw().prepare('UPDATE media SET id = ? WHERE id = -100').run(id);
  assert.deepStrictEqual(textHit('"zz_moves"'), [id]);
  raw().prepare(`DELETE FROM media WHERE NOT (${idx.validId('id')}) OR id = ?`).run(id);
  assertConsistent();
});

test('a stale index-step run never resets the state of a newer one (round 5)', async () => {
  raw().exec('DROP INDEX idx_media_sort_done; DROP INDEX idx_media_sort_size');
  const a = idx.prepareIndexesAsync(() => db.get(), { log: () => {} });   // waiting before its first index
  assert.strictEqual(idx.markPreparing(raw()), 2);                       // a new unlock takes over
  assert.strictEqual(await a, null, 'the older run stops');
  const s = idx.status(raw());
  assert.deepStrictEqual([s.state, s.step, s.steps], ['preparing', 0, 2], 'and leaves the newer state alone');
  const b = await idx.prepareIndexesAsync(() => db.get(), { log: () => {} });
  assert.strictEqual(b.length, 2);
  assert.notStrictEqual(idx.status(raw()).state, 'preparing');
});

test('the unlock-time index step reports preparing, step by step (R3-1)', async () => {
  raw().exec('DROP INDEX idx_media_sort_done; DROP INDEX idx_media_sort_size');
  const seen = [];
  const p = idx.prepareIndexesAsync(() => db.get(), { log: () => {} });
  for (let i = 0; i < 200; i++) {
    const s = idx.status(raw());
    seen.push(`${s.state} ${s.step}/${s.steps}`);
    if (s.state !== 'preparing' && i > 0) break;
    await new Promise(r => setTimeout(r, 5));
  }
  const done = await p;
  assert.deepStrictEqual(done.map(d => d[0]), ['idx_media_sort_size', 'idx_media_sort_done']);
  assert.ok(seen.includes('preparing 1/2') && seen.includes('preparing 2/2'), seen.join(', '));
  const after = idx.status(raw());
  assert.deepStrictEqual([after.state, after.step, after.steps], ['ready', null, null]);
  // A lock (the connection going away) stops it between statements.
  raw().exec('DROP INDEX idx_media_sort_done');
  let live = db.get();
  const q = idx.prepareIndexesAsync(() => live, { log: () => {} });
  live = null;
  assert.strictEqual(await q, null);
  assert.strictEqual(idx.status(raw()).state, 'ready');
  idx.createMissingIndexes(raw(), { log: () => {} });
});
