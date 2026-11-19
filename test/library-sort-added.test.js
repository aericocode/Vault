/**
 * Date added (sort field 'added'): when the file came into the library
 * (media.created_at), not when its AI scan finished (processed_at, the
 * 'processed' field, which was what "Date added" sorted by up to 3.11).
 *
 * New files are stub rows with no processed_at until the scan ends, so under
 * the old order they sank to the bottom and, with no AI server, stayed there.
 * Here: they come first under the default sort, the order is stable across
 * pages when a whole import chunk shares one created_at second, the sort has
 * its own index (built like the others on an existing library, and the query
 * still answers before it exists), and a state saved with 'processed' by the
 * viewer (last session, saved searches, Wall sources) now asks for 'added'.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-sort-added-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const libraryIndex = require('../lib/library-index');
const q = require('../lib/library-query');

const raw = () => db.get();
const CHUNK = 600;          // one import chunk: every row the same created_at second
const STUBS = ['/lib/new/c.mp4', '/lib/new/a.mp4', '/lib/new/b.mp4'];
let stubIds = [];
let nullCreatedId = null;

test.before(() => {
  db.init();
  raw().pragma('synchronous = OFF');
  const ins = raw().prepare(`INSERT INTO media (filepath, filename, media_type, processed_at, created_at, user_starred)
    VALUES (?, ?, 'video', ?, ?, ?)`);
  raw().transaction(() => {
    // Added long ago, scanned (again) recently: the old order put these first.
    for (let i = 0; i < 30; i++) {
      ins.run(`/lib/old/o${String(i).padStart(2, '0')}.mp4`, `o${i}.mp4`, `2026-11-${String(1 + (i % 9)).padStart(2, '0')} 10:00:00`,
        `2024-0${1 + (i % 9)}-15 08:00:00`, i % 7 === 0 ? 1 : 0);
    }
    // One import chunk, inserted in one transaction: one created_at for all.
    // Filepaths go in shuffled so id order is not filepath order.
    const names = Array.from({ length: CHUNK }, (_, i) => `/lib/chunk/${String((i * 337) % CHUNK).padStart(4, '0')}.mp4`);
    for (const [i, p] of names.entries()) {
      ins.run(p, path.basename(p), i % 3 ? null : '2025-07-01 00:00:00', '2025-06-01 12:00:00', i % 11 === 0 ? 1 : 0);
    }
  })();
  // A row without created_at (none of Vault's writers leave one, but an
  // outside tool could): it sorts by its scan time instead.
  nullCreatedId = Number(ins.run('/lib/odd/nocreated.mp4', 'nocreated.mp4', '2025-06-01 13:00:00', null, 0).lastInsertRowid);
  // New files the way an import adds them: stubs, unscanned, no processed_at.
  db.insertStubs(STUBS.map(p => ({ path: p, name: path.basename(p), mediaType: 'video', size: 1, mtimeMs: 1 })));
  stubIds = raw().prepare(`SELECT id FROM media WHERE filepath IN (${STUBS.map(() => '?').join(', ')}) ORDER BY filepath`).pluck().all(...STUBS);
});
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** The order SQL must give: created_at (else processed_at, else '') then filepath ASC. */
function expected({ field = 'added', dir = 'desc', favesFirst = false } = {}) {
  const rows = raw().prepare('SELECT id, filepath, created_at, processed_at, user_starred FROM media').all();
  const key = (r) => (field === 'added' ? (r.created_at ?? r.processed_at ?? '') : (r.processed_at ?? ''));
  rows.sort((a, b) => {
    if (favesFirst && (b.user_starred ? 1 : 0) !== (a.user_starred ? 1 : 0)) return (b.user_starred ? 1 : 0) - (a.user_starred ? 1 : 0);
    const ka = key(a), kb = key(b);
    if (ka !== kb) return (ka < kb ? -1 : 1) * (dir === 'asc' ? 1 : -1);
    return a.filepath < b.filepath ? -1 : a.filepath > b.filepath ? 1 : 0;
  });
  return rows.map(r => r.id);
}

const PATHS = [['small set', 1e9], ['index walk', -1], ['automatic', null]];

test('the stubs got a created_at and no processed_at', () => {
  const rows = raw().prepare(`SELECT created_at, processed_at, processing_error FROM media WHERE id IN (${stubIds.join(', ')})`).all();
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    assert.match(r.created_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    assert.strictEqual(r.processed_at, null);
    assert.strictEqual(r.processing_error, 'unscanned');
  }
});

test('the default sort is Date added, newest first, and new unscanned files lead it', async () => {
  const spec = q.normalizeSpec({});
  assert.deepStrictEqual(spec.sort, { field: 'added', dir: 'desc', favesFirst: false });
  const page = await q.firstPage(spec, 10);
  assert.deepStrictEqual(page.ids.slice(0, 3), stubIds, 'the three new files, in filepath order');
  // Date scanned is still there for the API: there they are last.
  const scanned = [...(await q.allIds(q.normalizeSpec({ sort: { field: 'processed' } }))).ids];
  assert.deepStrictEqual(new Set(scanned.slice(-3)), new Set(stubIds));
  assert.deepStrictEqual(scanned, expected({ field: 'processed' }));
  // A spec naming playlist with no collection open falls back to Date added too.
  assert.strictEqual(q.normalizeSpec({ sort: { field: 'playlist' } }).sort.field, 'added');
});

test('one created_at for a whole chunk: every path, page and direction agree, ties by filepath', async () => {
  for (const sort of [{}, { dir: 'asc' }, { favesFirst: true }, { dir: 'asc', favesFirst: true }]) {
    const spec = q.normalizeSpec({ sort });
    const want = expected(spec.sort);
    for (const [label, smallSet] of PATHS) {
      q._tuning.smallSet = smallSet;
      try {
        const all = [...(await q.allIds(spec)).ids];
        assert.deepStrictEqual(all, want, `${label} ${JSON.stringify(sort)}`);
        // The first page is the head of that same list, even when it ends
        // inside the chunk (100, 250) or right at its edge.
        for (const n of [1, 33, 100, 250, 633]) {
          assert.deepStrictEqual((await q.firstPage(spec, n)).ids, want.slice(0, n), `${label} first ${n} ${JSON.stringify(sort)}`);
        }
        // Asking again gives the same list (the viewer pages through it).
        assert.deepStrictEqual([...(await q.allIds(spec)).ids], all);
      } finally {
        q._tuning.smallSet = null;
      }
    }
  }
  // The row with no created_at sits by its scan time, between the chunk and the stubs.
  const desc = expected();
  assert.ok(desc.indexOf(nullCreatedId) < desc.indexOf(raw().prepare("SELECT id FROM media WHERE filepath = '/lib/chunk/0000.mp4'").pluck().get()));
  assert.ok(desc.indexOf(nullCreatedId) > desc.indexOf(stubIds[2]));
});

test('Date added has its own sort index, and SQLite walks it for the plain ORDER BY', () => {
  assert.ok(libraryIndex.hasIndex(raw(), 'idx_media_sort_added'), 'a new library gets it with the schema');
  assert.ok(libraryIndex.INDEXES.some(([n]) => n === 'idx_media_sort_added'));
  const plan = raw().prepare(`EXPLAIN QUERY PLAN SELECT id FROM media
    ORDER BY ${q.SORT_FIELDS.added.expr} DESC, filepath ASC LIMIT 5`).all().map(r => r.detail).join(' | ');
  assert.match(plan, /idx_media_sort_added/, plan);
  assert.doesNotMatch(plan, /TEMP B-TREE/, `no sort step: ${plan}`);
  // The old Date added index stays (Date scanned still uses it).
  assert.ok(libraryIndex.hasIndex(raw(), 'idx_media_sort_processed'));
});

test('an existing library without the index: queries still answer, then the index step builds it', async () => {
  const spec = q.normalizeSpec({});
  const want = expected();
  raw().exec('DROP INDEX idx_media_sort_added');
  try {
    assert.deepStrictEqual(libraryIndex.missingIndexes(raw()).map(([n]) => n), ['idx_media_sort_added']);
    for (const [label, smallSet] of PATHS) {
      q._tuning.smallSet = smallSet;
      try {
        assert.deepStrictEqual([...(await q.allIds(spec)).ids], want, `${label}, no index`);
        assert.deepStrictEqual((await q.firstPage(spec, 50)).ids, want.slice(0, 50), `${label}, no index, first page`);
        const asc = q.normalizeSpec({ sort: { dir: 'asc' } });
        assert.deepStrictEqual((await q.firstPage(asc, 50)).ids, expected({ dir: 'asc' }).slice(0, 50), `${label}, no index, ascending`);
      } finally {
        q._tuning.smallSet = null;
      }
    }
  } finally {
    // What the server does before it listens (or step by step after an unlock).
    const done = libraryIndex.createMissingIndexes(raw(), { log: () => {} });
    assert.deepStrictEqual(done.map(([n]) => n), ['idx_media_sort_added']);
  }
  assert.ok(libraryIndex.hasIndex(raw(), 'idx_media_sort_added'));
  assert.deepStrictEqual([...(await q.allIds(spec)).ids], want);
});

// ── The viewer: what it stored as 'processed' now asks for 'added' ────────

const ROOT = path.join(__dirname, '..');
function grab(name, from) {
  const at = from.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  let depth = 0;
  for (let i = from.indexOf(') {', at) + 2; i < from.length; i++) {
    if (from[i] === '{') depth++;
    else if (from[i] === '}' && --depth === 0) return from.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

test('a last session or saved search from 3.11 with processed_* restores as Date added', () => {
  const savedSrc = fs.readFileSync(path.join(ROOT, 'player-lib', 'saved-searches.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'db-viewer.html'), 'utf8');
  assert.match(html, /<option value="added">Date added<\/option>/);
  assert.doesNotMatch(html, /<option value="processed">/);
  const ctx = { document: { getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(`
    let currentSort = 'name_asc';
    let favesFirst = false;
    function restoreFilterControls() {}
    function syncSortControls() {}
    function applyFilters() { return null; }
    ${grab('restoreFilterState', savedSrc)}
    globalThis.restored = (sortValue) => { restoreFilterState({ sortValue }); return currentSort; };
  `, ctx);
  assert.strictEqual(ctx.restored('processed_desc'), 'added_desc');
  assert.strictEqual(ctx.restored('processed_asc'), 'added_asc');
  assert.strictEqual(ctx.restored('size_desc'), 'size_desc', 'other sorts unchanged');
  assert.strictEqual(ctx.restored('added_asc'), 'added_asc');
});

test('Wall sources made from a saved search with processed_* ask for Date added', () => {
  const wallSrc = fs.readFileSync(path.join(ROOT, 'player-lib', 'wall.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${grab('savedSearchSpec', wallSrc)}
    globalThis.sortOf = (sortValue) => JSON.stringify(savedSearchSpec({ filters: sortValue === undefined ? {} : { sortValue } }).sort);`, ctx);
  const sortOf = (v) => JSON.parse(ctx.sortOf(v));
  assert.deepStrictEqual(sortOf('processed_desc'), { field: 'added', dir: 'desc', favesFirst: false });
  assert.deepStrictEqual(sortOf('processed_asc'), { field: 'added', dir: 'asc', favesFirst: false });
  assert.deepStrictEqual(sortOf(undefined), { field: 'added', dir: 'desc', favesFirst: false });
  assert.deepStrictEqual(sortOf('views_desc'), { field: 'views', dir: 'desc', favesFirst: false });
  // Whatever the Wall sends is a sort the server takes.
  for (const v of ['processed_desc', 'added_asc', undefined]) assert.ok(q.SORT_FIELDS[sortOf(v).field]);
});
