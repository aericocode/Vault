/**
 * The server-side query engine (lib/library-query.js) on a small crafted
 * library: the A3 search rules and their examples (SERVER_SEARCH_SPEC 3.1),
 * boolean, fuzzy (F3), metadata only, subtitles, semantic, focus set, ranked
 * ids, collections, faves first, sort ties, the index-building state, spec
 * validation, and FTS syntax typed into the search box.
 *
 * test/library-parity.test.js covers filters and sorts in bulk against a copy
 * of the browser's own code.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-query-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const libraryIndex = require('../lib/library-index');
const q = require('../lib/library-query');
const embeddings = require('../lib/embeddings');

const ID = {};   // fixture key → media id

const DEFAULTS = {
  media_type: 'video', duration_seconds: 60, filesize_bytes: null, language: 'en', themes: '[]', tags: '[]',
  description: '', content_type: 'vlog', quality_flag: 'good', processed_at: '2024-01-01 00:00:00',
  processing_error: null, user_notes: '', user_starred: 0, user_rating: 0, user_flagged_delete: 0,
  user_trashed: 0, playback_failed: 0, view_count: 0, done_count: 0, subtitle_en: null,
};

const FIXTURE = [
  // 3.1 examples
  ['beach', { filepath: '/lib/one/beach_sunset_2019.mp4', filename: 'beach_sunset_2019.mp4', description: 'waves rolling in' }],
  ['dusk', { filepath: '/lib/one/clip_dusk.mp4', filename: 'clip_dusk.mp4', description: 'we arrived at sunset' }],
  ['vacTag', { filepath: '/lib/two/tagged.jpg', filename: 'tagged.jpg', media_type: 'image', tags: '["vacation"]' }],
  ['vacDesc', { filepath: '/lib/two/described.jpg', filename: 'described.jpg', media_type: 'image', description: 'our vacation photo' }],
  ['img', { filepath: '/lib/three/IMG_2019_0714.jpg', filename: 'IMG_2019_0714.jpg', media_type: 'image' }],
  ['apple', { filepath: '/lib/three/apple.png', filename: 'apple.png', media_type: 'image' }],
  ['party', { filepath: '/lib/four/party.mp4', filename: 'party.mp4', description: 'she wore a red dress' }],
  ['foreign', { filepath: '/lib/four/foreign.mp4', filename: 'foreign.mp4', subtitle_en: 'the treasure is buried here' }],
  ['doc', { filepath: '/lib/five/sunset_notes.pdf', filename: 'sunset_notes.pdf', media_type: 'document' }],
  ['noted', { filepath: '/lib/five/noted.mp4', filename: 'noted.mp4', user_notes: '[{"text":"quokka sighting"}]' }],
  ['trashed', { filepath: '/trash/sunset_trashed.mp4', filename: 'sunset_trashed.mp4', user_trashed: 1 }],
  // Filters and sort
  ['klingon', { filepath: '/lib/six/k1.mp4', filename: 'k1.mp4', language: 'klingon' }],
  ['nolang', { filepath: '/lib/six/k2.mp4', filename: 'k2.mp4', language: null }],
  ['english', { filepath: '/lib/six/k3.mp4', filename: 'k3.mp4', language: 'English' }],
  ['cleanTheme', { filepath: '/lib/seven/t1.mp4', filename: 't1.mp4', themes: '["Romance"]', clean: '["romance"]' }],
  ['rawTheme', { filepath: '/lib/seven/t2.mp4', filename: 't2.mp4', themes: '["romance", "sea"]' }],
  ['badTheme', { filepath: '/lib/seven/t3.mp4', filename: 't3.mp4', themes: 'not json' }],
  ['dupA', { filepath: '/lib/eight/d1.mp4', filename: 'd1.mp4', filesize_bytes: 777 }],
  ['dupB', { filepath: '/lib/eight/d2.mp4', filename: 'd2.mp4', filesize_bytes: 777 }],
  ['dupImg', { filepath: '/lib/eight/d3.jpg', filename: 'd3.jpg', media_type: 'image', filesize_bytes: 777 }],
  ['failedScan', { filepath: '/lib/nine/f1.mp4', filename: 'f1.mp4', processing_error: 'vision api broke' }],
  ['unscanned', { filepath: '/lib/nine/f2.mp4', filename: 'f2.mp4', processing_error: 'unscanned', processed_at: null }],
  ['star1', { filepath: '/lib/ten/s_b.mp4', filename: 's_b.mp4', user_starred: 1, user_rating: 3, view_count: 5 }],
  ['star2', { filepath: '/lib/ten/s_a.mp4', filename: 's_a.mp4', user_starred: 1, user_rating: 3, view_count: 5 }],
  ['rated5', { filepath: '/lib/ten/r5.mp4', filename: 'r5.mp4', user_rating: 5, view_count: 5 }],
  ['gif', { filepath: '/lib/ten/anim.GIF', filename: 'anim.GIF', media_type: 'gif' }],
  ['mkv', { filepath: '/lib/ten/movie.mkv', filename: 'movie.mkv' }],
  // 3.3 fuzzy: a swapped-letter typo (tets) must still find test
  ['testName', { filepath: '/lib/eleven/speed_test.mp4', filename: 'speed_test.mp4' }],
  ['testTag', { filepath: '/lib/eleven/run.jpg', filename: 'run.jpg', media_type: 'image', tags: '["Test"]' }],
  ['testDesc', { filepath: '/lib/eleven/walk.jpg', filename: 'walk.jpg', media_type: 'image', description: 'a test shot' }],
];

function insert(row) {
  const r = { ...DEFAULTS, ...row };
  const cols = Object.keys(r).filter(k => k !== 'clean');
  const info = db.get().prepare(`INSERT INTO media (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => r[c]));
  const id = Number(info.lastInsertRowid);
  if (row.clean) db.get().prepare('INSERT INTO media_clean (media_id, themes) VALUES (?, ?)').run(id, row.clean);
  return id;
}

test.before(() => {
  db.init();
  db.get().pragma('synchronous = OFF');
  for (const [key, row] of FIXTURE) ID[key] = insert(row);
  // Collections: one playlist, one in a folder, and songs.
  const folder = db.createCollection('Folder', { kind: 'folder' });
  const c1 = db.createCollection('Playlist');
  const c2 = db.createCollection('Inner', { parentId: folder.id });
  db.addToCollection(c1.id, [ID.party, ID.beach, ID.apple, ID.doc]);
  db.addToCollection(c2.id, [ID.dusk, ID.beach]);
  ID.c1 = c1.id; ID.c2 = c2.id; ID.folder = folder.id;
  const repo = require('../lib/musicid/repo');
  const song = repo.findOrCreateSong({ title: 'Song', artist: 'Artist' });
  ID.song = song.id ?? song;
  db.get().prepare('INSERT INTO media_songs (media_id, song_id) VALUES (?, ?)').run(ID.foreign, ID.song);
});
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// Every result is computed three ways, by the small-set lookup, by the
// index walk, and by the automatic choice between them, and all must agree.
async function ids(body) {
  const spec = q.normalizeSpec(body);
  const auto = (await q.allIds(spec)).ids;
  try {
    for (const [path, smallSet] of [['small set', 1e9], ['index walk', -1]]) {
      q._tuning.smallSet = smallSet;
      const other = (await q.allIds(spec)).ids;
      assert.deepStrictEqual([...other], [...auto], `${path} vs automatic: ${JSON.stringify(body)}`);
    }
  } finally {
    q._tuning.smallSet = null;
  }
  return auto;
}
async function has(body, ...keys) {
  const got = new Set(await ids(body));
  return keys.map(k => got.has(ID[k]));
}
const search = (text, opts = {}) => ({ search: { text, ...opts } });

// ── 3.1 plain search (A3) ─────────────────────────────────────────────────

test('sunset finds the name and the description word', async () => {
  assert.deepStrictEqual(await has(search('sunset'), 'beach', 'dusk'), [true, true]);
});

test('unse finds the name substring but not a description word', async () => {
  assert.deepStrictEqual(await has(search('unse'), 'beach', 'dusk'), [true, false]);
});

test('cat matches inside a tag but not inside a description word', async () => {
  assert.deepStrictEqual(await has(search('cat'), 'vacTag', 'vacDesc'), [true, false]);
});

test('img_2019 and 0714 find IMG_2019_0714.jpg (underscore kept, case folded)', async () => {
  assert.deepStrictEqual(await has(search('img_2019'), 'img'), [true]);
  assert.deepStrictEqual(await has(search('0714'), 'img'), [true]);
  assert.deepStrictEqual(await has(search('IMG_2019'), 'img'), [true]);
});

test('a one-letter search matches word starts in names and text', async () => {
  const [apple, dusk, img] = await has(search('a'), 'apple', 'dusk', 'img');
  assert.strictEqual(apple, true, 'name word apple');
  assert.strictEqual(dusk, true, 'text word arrived / at');
  assert.strictEqual(img, false);
});

test('words of the query must appear together, the last one as a prefix', async () => {
  assert.deepStrictEqual(await has(search('red dre'), 'party'), [true]);
  assert.deepStrictEqual(await has(search('dress red'), 'party'), [false]);
  assert.deepStrictEqual(await has(search('wore dress'), 'party'), [false]);
});

test('the grid rules still apply to search: no documents, no trashed rows', async () => {
  assert.deepStrictEqual(await has(search('sunset'), 'doc', 'trashed'), [false, false]);
  assert.deepStrictEqual(await has({ ...search('sunset'), filters: { trashed: '' } }, 'trashed'), [true]);
});

test('notes are searchable', async () => {
  assert.deepStrictEqual(await has(search('quokka'), 'noted'), [true]);
});

// ── 3.2 boolean ───────────────────────────────────────────────────────────

test('boolean: AND / NOT / OR / quoted phrases, each leaf is match()', async () => {
  const r = await q.query(q.normalizeSpec(search('sunset AND NOT beach')));
  assert.strictEqual(r.search.mode, 'boolean');
  assert.deepStrictEqual(await has(search('sunset AND NOT beach'), 'beach', 'dusk'), [false, true]);
  assert.deepStrictEqual(await has(search('"red dress" OR vacation'), 'party', 'vacTag', 'vacDesc', 'beach'),
    [true, true, true, false]);
  assert.deepStrictEqual(await has(search('(cat OR quokka) AND NOT vacation'), 'vacTag', 'noted'), [false, true]);
  // lowercase operators are plain words
  const plain = await q.query(q.normalizeSpec(search('sunset and beach')));
  assert.strictEqual(plain.search.mode, 'plain');
  // fuzzy never applies to a boolean search
  const b = await q.query(q.normalizeSpec(search('sunsat OR quokka', { fuzzy: true })));
  assert.strictEqual(b.search.mode, 'boolean');
  assert.deepStrictEqual(b.search.closeTerms, []);
});

// ── 3.3 fuzzy (F3) ────────────────────────────────────────────────────────

test('fuzzy: a typo finds names and tags spelled almost the same, and says which', async () => {
  const r = await q.query(q.normalizeSpec(search('sunsat', { fuzzy: true })));
  assert.strictEqual(r.search.mode, 'fuzzy');
  assert.ok(r.search.closeTerms.includes('sunset'), JSON.stringify(r.search.closeTerms));
  assert.deepStrictEqual(await has(search('sunsat', { fuzzy: true }), 'beach', 'dusk'), [true, false],
    'names only: the description-only sunset stays out');
  assert.deepStrictEqual(await has(search('vacasion', { fuzzy: true }), 'vacTag', 'vacDesc'), [true, false]);
});

test('fuzzy: a swapped-letter typo finds the names and tags it was meant for', async () => {
  const r = await q.query(q.normalizeSpec(search('tets', { fuzzy: true })));
  assert.strictEqual(r.search.closeTerms[0], 'test', JSON.stringify(r.search.closeTerms));
  assert.deepStrictEqual(await has(search('tets', { fuzzy: true }), 'testName', 'testTag', 'testDesc'), [true, true, false]);
  assert.deepStrictEqual(await has(search('tets'), 'testName', 'testTag'), [false, false], 'only with Fuzzy on');
  assert.deepStrictEqual(await has(search('tets', { fuzzy: true, metadataOnly: true }), 'testName', 'testTag'), [false, true]);
});

test('fuzzy: words with digits and short words are never expanded', async () => {
  const r = await q.query(q.normalizeSpec(search('img_2018', { fuzzy: true })));
  assert.deepStrictEqual(r.search.closeTerms, []);
  assert.deepStrictEqual(await has(search('img_2018', { fuzzy: true }), 'img'), [false]);
  const short = await q.query(q.normalizeSpec(search('apx', { fuzzy: true })));
  assert.deepStrictEqual(short.search.closeTerms, []);
  assert.deepStrictEqual(await has(search('apx', { fuzzy: true }), 'apple'), [false]);
});

test('fuzzy with Metadata only ignores file names entirely', async () => {
  const r = await q.query(q.normalizeSpec(search('sunsat', { fuzzy: true, metadataOnly: true })));
  assert.ok(!r.search.closeTerms.includes('sunset'), 'sunset only occurs in file names');
  assert.deepStrictEqual(await has(search('vacasion', { fuzzy: true, metadataOnly: true }), 'vacTag'), [true]);
});

// ── 3.4 subtitles, metadata only ──────────────────────────────────────────

test('subtitle text is searched only with the Subtitles option', async () => {
  assert.deepStrictEqual(await has(search('treasure'), 'foreign'), [false]);
  assert.deepStrictEqual(await has(search('treasure', { subtitles: true }), 'foreign'), [true]);
});

test('Metadata only leaves file names and paths out', async () => {
  assert.deepStrictEqual(await has(search('beach', { metadataOnly: true }), 'beach'), [false]);
  assert.deepStrictEqual(await has(search('waves', { metadataOnly: true }), 'beach'), [true]);
  assert.deepStrictEqual(await has(search('cat', { metadataOnly: true }), 'vacTag'), [true], 'tags stay in');
  assert.deepStrictEqual(await has(search('ta', { metadataOnly: true }), 'vacTag'), [false], 'short query: no file name words');
  assert.deepStrictEqual(await has(search('ta'), 'vacTag'), [true]);
});

// ── 3.5 semantic ──────────────────────────────────────────────────────────

test('semantic: scores >= 0.4, filters applied, best first; 503 when unavailable', async () => {
  const orig = embeddings.search;
  try {
    embeddings.search = async () => [
      { id: ID.apple, score: 0.9 }, { id: ID.doc, score: 0.8 }, { id: ID.party, score: 0.7 },
      { id: ID.beach, score: 0.7 }, { id: ID.dusk, score: 0.39 },
    ];
    const r = await q.query(q.normalizeSpec(search('anything', { semantic: true, fuzzy: true })));
    assert.strictEqual(r.search.mode, 'semantic');
    // doc: filtered out (grid types); dusk: under 0.4; party/beach tie: filepath order
    assert.deepStrictEqual(r.page.ids, [ID.apple, ID.party, ID.beach]);
    const vids = await ids({ ...search('anything', { semantic: true }), filters: { mediaTypes: ['video'] } });
    assert.deepStrictEqual([...vids], [ID.party, ID.beach]);

    embeddings.search = async () => { throw new Error('connect ECONNREFUSED'); };
    await assert.rejects(q.query(q.normalizeSpec(search('x', { semantic: true }))),
      (e) => e.status === 503 && e.code === 'SEMANTIC_UNAVAILABLE' && e.message === 'embedding model unavailable: connect ECONNREFUSED');
    embeddings.search = async () => [];
    await assert.rejects(q.query(q.normalizeSpec(search('x', { semantic: true }))),
      (e) => e.status === 503 && e.message === 'no embeddings yet. Run: node vault.js embed');
  } finally {
    embeddings.search = orig;
  }
});

// ── 3.6 focus set and ranked ids ──────────────────────────────────────────

test('onlyIds replaces every other filter, including the grid types and trash', async () => {
  const got = await ids({ onlyIds: [ID.doc, ID.trashed, ID.apple], filters: { mediaTypes: ['video'], starred: '1' } });
  assert.deepStrictEqual(new Set(got), new Set([ID.doc, ID.trashed, ID.apple]));
  // sorted by the chosen sort (processed desc, then filepath)
  const byName = await ids({ onlyIds: [ID.doc, ID.trashed, ID.apple], sort: { field: 'name', dir: 'asc' } });
  assert.deepStrictEqual([...byName], [ID.apple, ID.doc, ID.trashed]);
});

test('rankedIds: filters still apply, best score first, ties by filepath', async () => {
  const body = {
    rankedIds: [{ id: ID.apple, score: 0.2 }, { id: ID.party, score: 2 }, { id: ID.beach, score: 0.2 }, { id: ID.doc, score: 1 }],
  };
  assert.deepStrictEqual([...await ids(body)], [ID.party, ID.beach, ID.apple]);
  assert.deepStrictEqual([...await ids({ ...body, filters: { mediaTypes: ['image'] } })], [ID.apple]);
});

// ── Collections, songs ────────────────────────────────────────────────────

test('an open collection shows its members in playlist order, no faves-first', async () => {
  assert.deepStrictEqual([...await ids({ collectionId: ID.c1, sort: { favesFirst: true } })],
    [ID.party, ID.beach, ID.apple], 'doc is a member but not a grid type');
  // A folder is the union of its subtree, in tree order.
  assert.deepStrictEqual([...await ids({ collectionId: ID.folder })], [ID.dusk, ID.beach]);
  // The Collections tri-filter is ignored while a collection is open.
  assert.deepStrictEqual([...await ids({ collectionId: ID.c1, filters: { collections: '0' } })],
    [ID.party, ID.beach, ID.apple]);
});

test('the Collections tri-filter and the song filter', async () => {
  const inAny = new Set(await ids({ filters: { collections: '1' } }));
  assert.deepStrictEqual(inAny, new Set([ID.party, ID.beach, ID.apple, ID.dusk]));
  const notIn = new Set(await ids({ filters: { collections: '0' } }));
  assert.ok(!notIn.has(ID.beach) && notIn.has(ID.img));
  assert.deepStrictEqual([...await ids({ filters: { song: ID.song } })], [ID.foreign]);
});

// ── Filters with special rules ────────────────────────────────────────────

test('language matches display names; Unknown includes NULL and unmapped values', async () => {
  const unknown = new Set(await ids({ filters: { language: 'Unknown' } }));
  assert.ok(unknown.has(ID.klingon) && unknown.has(ID.nolang) && !unknown.has(ID.english));
  const english = new Set(await ids({ filters: { language: 'English' } }));
  assert.ok(english.has(ID.english) && english.has(ID.beach), 'en and English are the same language');
  assert.deepStrictEqual([...await ids({ filters: { language: 'Martian' } })], []);
});

test('theme: the clean copy, then the raw column; bad JSON matches nothing', async () => {
  assert.deepStrictEqual(new Set(await ids({ filters: { theme: 'romance' } })), new Set([ID.cleanTheme, ID.rawTheme]));
  assert.deepStrictEqual([...await ids({ filters: { theme: 'Romance' } })], [], 'the clean copy is what counts');
  assert.deepStrictEqual([...await ids({ filters: { theme: 'sea' } })], [ID.rawTheme]);
});

test('duplicates: same type and non-zero size', async () => {
  assert.deepStrictEqual(new Set(await ids({ filters: { duplicates: '1' } })), new Set([ID.dupA, ID.dupB]));
  const not = new Set(await ids({ filters: { duplicates: '0' } }));
  assert.ok(not.has(ID.dupImg) && !not.has(ID.dupA));
});

test('scan status, notes, safe and extension filters', async () => {
  assert.deepStrictEqual([...await ids({ filters: { scanStatus: 'failed' } })], [ID.failedScan]);
  assert.deepStrictEqual([...await ids({ filters: { scanStatus: 'unscanned' } })], [ID.unscanned]);
  assert.deepStrictEqual([...await ids({ filters: { hasNotes: '1' } })], [ID.noted]);
  const safe = new Set(await ids({ filters: { safeOnly: true } }));
  assert.ok(safe.has(ID.gif) && safe.has(ID.beach) && !safe.has(ID.mkv), '.GIF counts as gif');
  assert.deepStrictEqual([...await ids({ filters: { extensions: ['mkv'] } })], [ID.mkv]);
});

// ── Sort ──────────────────────────────────────────────────────────────────

test('sort ties keep filepath order; faves first floats starred rows', async () => {
  const rating = [...await ids({ sort: { field: 'rating', dir: 'desc' } })];
  assert.deepStrictEqual(rating.slice(0, 3), [ID.rated5, ID.star2, ID.star1], 'ties (3) in filepath order: s_a before s_b');
  const faves = [...await ids({ sort: { field: 'rating', dir: 'desc', favesFirst: true } })];
  assert.deepStrictEqual(faves.slice(0, 3), [ID.star2, ID.star1, ID.rated5]);
  const views = [...await ids({ sort: { field: 'views', dir: 'asc' } })];
  assert.deepStrictEqual(views.slice(-3), [ID.rated5, ID.star2, ID.star1], 'ascending: ties still filepath ASC');
  const processed = [...await ids({ sort: { field: 'processed', dir: 'desc' } })];
  assert.strictEqual(processed[processed.length - 1], ID.unscanned, 'NULL processed_at sorts as the empty string');
});

// ── Pages, versions, building ─────────────────────────────────────────────

test('first page, complete and total', async () => {
  const all = await ids({});
  const small = await q.query(q.normalizeSpec({ pageSize: 3 }));
  assert.deepStrictEqual(small.page.ids, [...all].slice(0, 3));
  assert.strictEqual(small.page.rows.length, 3);
  assert.deepStrictEqual(small.page.rows, small.page.ids.map(id => db.getByIdForViewer(id)),
    'the same rows /api/media/rows would return, in page order');
  assert.ok(!('embedding' in small.page.rows[0]));
  assert.strictEqual(small.complete, false);
  assert.strictEqual(small.total, null);
  const big = await q.query(q.normalizeSpec({ pageSize: 500 }));
  assert.strictEqual(big.complete, true);
  assert.strictEqual(big.total, all.length);
  assert.strictEqual(big.version, libraryIndex.version(db.get()));
});

test('ids for a qid are recomputed against current data after a change', async () => {
  const r = await q.query(q.normalizeSpec({ filters: { starred: '1' } }));
  const before = await q.idsForQid(r.qid);
  assert.strictEqual(before.ids.length, 2);
  db.setUserFields(ID.apple, { user_starred: 1 });
  const after = await q.idsForQid(r.qid);
  assert.strictEqual(after.ids.length, 3);
  assert.ok(after.version > before.version);
  db.setUserFields(ID.apple, { user_starred: 0 });
  assert.strictEqual(await q.idsForQid('nope'), null);
});

test('cached id sets follow library changes (theme, text, duplicates)', async () => {
  const theme = { filters: { theme: 'sea' } };
  assert.deepStrictEqual([...await ids(theme)], [ID.rawTheme]);
  assert.deepStrictEqual(await has(search('zanzibar'), 'apple'), [false]);
  assert.deepStrictEqual(await has({ filters: { duplicates: '1' } }, 'apple'), [false]);
  db.setAiFields(ID.apple, { themes: ['sea'], description: 'a zanzibar holiday' });
  db.get().prepare('UPDATE media SET filesize_bytes = 777 WHERE id = ?').run(ID.apple);
  try {
    assert.deepStrictEqual(new Set(await ids(theme)), new Set([ID.rawTheme, ID.apple]));
    assert.deepStrictEqual(await has(search('zanzibar'), 'apple'), [true]);
    assert.deepStrictEqual(await has({ filters: { duplicates: '1' } }, 'apple', 'dupImg'), [true, true]);
  } finally {
    db.setAiFields(ID.apple, { themes: [], description: '' });
    db.get().prepare('UPDATE media SET filesize_bytes = NULL WHERE id = ?').run(ID.apple);
  }
  assert.deepStrictEqual([...await ids(theme)], [ID.rawTheme]);
});

test('while the search index builds: text search and Theme wait, the rest works', async () => {
  libraryIndex.setMeta(db.get(), 'search_built', 0);
  try {
    const r = await q.query(q.normalizeSpec(search('sunset')));
    assert.deepStrictEqual(r.page.ids, []);
    assert.strictEqual(r.search.indexState, 'building');
    assert.strictEqual(typeof r.search.indexProgress, 'number');
    assert.deepStrictEqual([...await ids({ filters: { theme: 'romance' } })], []);
    assert.ok((await ids({ filters: { mediaTypes: ['image'] } })).length > 0);
  } finally {
    libraryIndex.setMeta(db.get(), 'search_built', 1);
  }
});

test('binary id list layout', async () => {
  const out = await q.allIds(q.normalizeSpec({ filters: { mediaTypes: ['gif', 'image'] } }));
  const buf = q.encodeIds(out);
  const n = buf.readUInt32LE(0);
  assert.strictEqual(n, out.ids.length);
  assert.strictEqual(buf.readUInt32LE(4), out.version);
  assert.strictEqual(buf.length, 8 + n * 5);
  for (let i = 0; i < n; i++) {
    assert.strictEqual(buf.readUInt32LE(8 + i * 4), out.ids[i]);
    assert.strictEqual(buf[8 + n * 4 + i], out.ids[i] === ID.gif ? 4 : 3);
  }
});

// ── Validation ────────────────────────────────────────────────────────────

test('invalid specs are rejected with the field named', () => {
  const bad = (body, field) => assert.throws(() => q.normalizeSpec(body),
    (e) => e.status === 400 && e.message.includes(field), JSON.stringify(body));
  bad(null, 'body');
  bad([], 'body');
  bad({ search: 'x' }, 'search');
  bad({ search: { text: 5 } }, 'search.text');
  bad({ search: { fuzzy: 'yes' } }, 'search.fuzzy');
  bad({ filters: { mediaTypes: ['video', 'sound'] } }, 'filters.mediaTypes');
  bad({ filters: { minRating: 3 } }, 'filters.minRating');
  bad({ filters: { durMin: -1 } }, 'filters.durMin');
  bad({ filters: { starred: 'yes' } }, 'filters.starred');
  bad({ filters: { song: 'x' } }, 'filters.song');
  bad({ collectionId: 'abc' }, 'collectionId');
  bad({ sort: { field: 'random' } }, 'sort.field');
  bad({ sort: { dir: 'up' } }, 'sort.dir');
  bad({ onlyIds: [1, -2] }, 'onlyIds');
  bad({ rankedIds: [{ id: 1 }] }, 'rankedIds');
  bad({ pageSize: 0 }, 'pageSize');
  bad({ pageSize: 501 }, 'pageSize');
  const d = q.normalizeSpec({});
  assert.strictEqual(d.filters.trashed, '0');
  assert.strictEqual(d.pageSize, 100);
  assert.deepStrictEqual(d.sort, { field: 'processed', dir: 'desc', favesFirst: false });
});

// ── FTS injection ─────────────────────────────────────────────────────────

test('FTS5 syntax typed into the search box is just text', async () => {
  const everything = (await ids({})).length;
  const attempts = [
    '"', '""', '"sunset', 'sun"set', 'NEAR(beach sunset)', 'NEAR', '*', 'sun*', '^beach', 'beach^',
    '{filename}:beach', 'filename:beach', 'filename : beach', '(unbalanced', 'unbalanced)', 'a OR', 'OR',
    '-beach', '+beach', 'beach NOT', "'; DROP TABLE media; --", '\\', '%', '_', '\u0000', '{', '}', ':', '(',
    'AND AND', 'NOT NOT NOT', '"a" AND "b', 'x'.repeat(100),
  ];
  for (const text of attempts) {
    for (const opts of [{}, { fuzzy: true }, { metadataOnly: true, subtitles: true }]) {
      const r = await q.query(q.normalizeSpec(search(text, opts)));
      assert.ok(r.page.ids.length <= everything, text);
    }
  }
  // Column filters and operators do not work as syntax: "filename:beach"
  // is a literal string no row contains.
  assert.deepStrictEqual([...await ids(search('filename:beach'))], []);
  assert.deepStrictEqual([...await ids(search('NEAR(beach sunset)'))], []);
  // A quote inside the text is a literal quote, never a phrase break.
  assert.deepStrictEqual([...await ids(search('beach" "apple'))], []);
  assert.ok(db.get().prepare('SELECT count(*) FROM media').pluck().get() > 0, 'the library is intact');
});


// ── Input caps (spec 5.5, round 2) ─────────────────────────────────────────

test('input caps answer 400 with a plain message instead of failing deep down', () => {
  const refused = (body, message) => assert.throws(() => q.normalizeSpec(body),
    (e) => e.status === 400 && e.message === message, JSON.stringify(body).slice(0, 80));
  const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  // 16 words is fine, 17 is not; fuzzy the same; semantic is not capped here.
  q.normalizeSpec(search(words(16)));
  q.normalizeSpec(search(words(16), { fuzzy: true }));
  refused(search(words(17)), 'Search is too long. Use 16 words or fewer.');
  refused(search(words(17), { fuzzy: true }), 'Search is too long. Use 16 words or fewer.');
  q.normalizeSpec(search(words(300), { semantic: true }));
  // Boolean: more than 200 terms, or nesting deeper than 32.
  refused(search(Array.from({ length: 201 }, (_, i) => `w${i}`).join(' OR ')), 'Search is too complex.');
  q.normalizeSpec(search(Array.from({ length: 200 }, (_, i) => `w${i}`).join(' OR ')));
  refused(search('('.repeat(33) + 'a AND b'), 'Search is too complex.');
  refused(search('('.repeat(1900) + 'x AND y'), 'Search is too complex.');
  refused(search('('.repeat(200000) + 'x AND y'), 'Search is too long.');
  q.normalizeSpec(search('('.repeat(32) + 'a AND b'));
  refused(search('a AND ' + 'NOT ('.repeat(33) + 'b'), 'Search is too complex.');
  // Extensions and id lists.
  refused({ filters: { extensions: Array.from({ length: 201 }, (_, i) => `e${i}`) } }, 'filters.extensions has more than 200 values');
  q.normalizeSpec({ filters: { extensions: Array.from({ length: 200 }, (_, i) => `e${i}`) } });
  const big = new Array(4000001).fill(1);
  refused({ onlyIds: big }, 'onlyIds has more than 4,000,000 ids');
  refused({ rankedIds: big }, 'rankedIds has more than 4,000,000 ids');
});

test('NUL characters are stripped from search text', async () => {
  const spec = q.normalizeSpec(search('sun\u0000set'));
  assert.strictEqual(spec.search.text, 'sunset');
  assert.deepStrictEqual(await has(search('sun\u0000set'), 'beach'), [true]);
});

test('fuzzy leaves real words alone and expands at most four typos', async () => {
  const close = async (text) => (await q.query(q.normalizeSpec(search(text, { fuzzy: true })))).search.closeTerms;
  // Words that already name files are not typos: nothing to expand.
  assert.deepStrictEqual(await close('sunset beach'), []);
  const typos = ['sunsat', 'vacasion', 'partty', 'foriegn', 'tagget'];
  const singles = [];
  for (const t of typos) singles.push(await close(t));
  const first4 = [...new Set(singles.slice(0, 4).flat())];
  assert.ok(singles[4].length > 0, 'the fifth typo has close terms of its own');
  assert.deepStrictEqual((await close(typos.join(' '))).sort(), first4.sort());
});

test('search length caps: 2,000 characters, 100 per word, 4 of the same word (R3-2)', async () => {
  const refused = (text, opts) => assert.throws(() => q.normalizeSpec(search(text, opts)),
    (e) => e.status === 400 && e.message === 'Search is too long.', `${text.length} chars`);
  // Total length, at the cap and one over, plain, fuzzy and semantic alike.
  // 16 words of 100 letters and punctuation up to 2,000 (16 words at most).
  const total = Array.from({ length: 16 }, (_, i) => String.fromCharCode(97 + i).repeat(100)).join(' ') + '!'.repeat(385);
  assert.strictEqual(total.length, 2000);
  q.normalizeSpec(search(total));
  q.normalizeSpec(search(total, { fuzzy: true }));
  refused(total + 'y');
  refused(total + 'y', { fuzzy: true });
  refused(total + 'y', { semantic: true });
  refused('!'.repeat(2001));
  // One word: 100 letters is fine, 101 is not.
  await ids(search('q'.repeat(100)));
  refused('q'.repeat(101));
  refused('q'.repeat(101), { fuzzy: true });
  // The same word four times is fine, five is not (any case).
  q.normalizeSpec(search('na na na NA batman'));
  refused('na na na na Na batman');
});

test('the repeat and word caps count words as the search tables do (round 4)', () => {
  const tooLong = (text, opts, message = 'Search is too long.') => assert.throws(() => q.normalizeSpec(search(text, opts)),
    (e) => e.status === 400 && e.message === message, text.slice(0, 60));
  // Accent, case and width variants of one word are one word to FTS.
  q.normalizeSpec(search('huurost húurost hùurost HÛUROST'));
  tooLong('huurost húurost hùurost HÛUROST hüurost');
  tooLong('huurost húurost hùurost HÛUROST hüurost', { fuzzy: true });
  // Combining marks (NFD) fold the same way.
  tooLong('cafe café cafe\u0301 CAFE\u0300 cafe\u0302');
  // Final sigma folds to sigma in SQLite, not in toLowerCase.
  tooLong('σοσ σοσ σος ΣΟΣ σοσ');
  // A mark that is not a diacritic splits words: one regex word, many tokens.
  const split = Array.from({ length: 17 }, (_, i) => 'w' + i).join('\u0305');
  assert.strictEqual(split.match(/[\p{L}\p{N}\p{M}\p{Co}]+/gu).length, 1);
  tooLong(split, {}, 'Search is too long. Use 16 words or fewer.');
  // Boolean operators are not words; lowercase "and" is.
  q.normalizeSpec(search('a AND a AND a AND a OR b OR b OR b OR b'));
  tooLong('and and and and and');
});

test('a huge search text is refused before any per-character work (round 4)', () => {
  const huge = 'a'.repeat(60e6);
  const t0 = Date.now();
  assert.throws(() => q.normalizeSpec(search(huge)), (e) => e.status === 400 && e.message === 'Search is too long.');
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
  // The UTF-16 precheck never refuses what the code-point count allows: 2,000 emoji are 4,000 units.
  q.normalizeSpec(search('\u{1F600}'.repeat(2000), { semantic: true }));
  assert.throws(() => q.normalizeSpec(search('\u{1F600}'.repeat(2001), { semantic: true })), (e) => e.status === 400);
});

// ── Round 5 ───────────────────────────────────────────────────────────────

test('fuzzy drops a repeated word only when its clause is the same, in either order (round 5)', async () => {
  // U+0305 is a separator to the word index but a character to the names
  // table, so "sunset" and "sunset" + U+0305 are two different name words.
  const names = (w) => new Set(db.get().prepare(`SELECT rowid FROM media_search_names
    WHERE media_search_names MATCH ?`).pluck().all(`{filename filepath tags themes} : "${w}"`));
  const all = new Set(await ids({}));
  const mark = 'sunset\u0305';
  const want = (u) => {
    // match(U) OR every word found in names (spec 3.3, per word; no typos here).
    const out = new Set();
    return ids(search(u)).then((plain) => {
      for (const id of plain) out.add(id);
      const a = names('sunset'); const b = names(mark);
      for (const id of a) if (b.has(id) && all.has(id)) out.add(id);
      return [...out].sort((x, y) => x - y);
    });
  };
  const got = async (u) => [...await ids(search(u, { fuzzy: true }))].sort((x, y) => x - y);
  const w1 = await want(`sunset ${mark}`);
  assert.deepStrictEqual(await got(`sunset ${mark}`), w1);
  assert.deepStrictEqual(await got(`${mark} sunset`), await want(`${mark} sunset`));
  assert.deepStrictEqual(await got(`sunset ${mark}`), await got(`${mark} sunset`));
  // Spellings the names table folds together are still one word.
  assert.deepStrictEqual(await got('sunset SÚNSET'), await got('sunset sunset'));
  assert.deepStrictEqual(await got('SÚNSET sunset'), await got('sunset sunset'));
});

test('ids outside 1..4294967295 never appear in any result, id list or count (round 5)', async () => {
  const facets = require('../lib/library-facets');
  const before = {
    all: [...await ids({})], text: [...await ids(search('zz_out'))], dup: [...await ids({ filters: { duplicates: '1' } })],
    theme: [...await ids({ filters: { theme: 'romance' } })], facets: (facets.reset(), await facets.facets()),
  };
  const OUT = [0, -7, -9e15, 4294967296, -9223372036854775808n, 9223372036854775807n];
  const ins = db.get().prepare(`INSERT INTO media (id, filepath, filename, media_type, themes, filesize_bytes, user_starred)
    VALUES (?, ?, ?, 'video', '["romance"]', 777, 1)`);
  OUT.forEach((id, i) => ins.run(id, `/out/zz_out_${i}.mp4`, `zz_out_${i}.mp4`));
  try {
    const isOut = (id) => !(id >= 1 && id <= 4294967295);
    const lists = {
      all: await ids({}), text: await ids(search('zz_out')), fuzzy: await ids(search('zz_out', { fuzzy: true })),
      dup: await ids({ filters: { duplicates: '1' } }), theme: await ids({ filters: { theme: 'romance' } }),
      faves: await ids({ sort: { favesFirst: true } }),
    };
    for (const [k, l] of Object.entries(lists)) assert.ok(![...l].some(isOut), k);
    assert.deepStrictEqual([...lists.all], before.all);
    assert.deepStrictEqual([...lists.text], before.text);
    assert.deepStrictEqual([...lists.dup], before.dup);
    assert.deepStrictEqual([...lists.theme], before.theme);
    const page = await q.query(q.normalizeSpec(search('zz_out')));
    assert.deepStrictEqual(page.page.ids, []);
    // Facets, ids-summary and duplicates.
    facets.reset();
    const f = await facets.facets();
    for (const k of ['total', 'types', 'extensions', 'content', 'language', 'quality', 'theme', 'themeTotal', 'rating', 'fave', 'dupes', 'playbackGroups']) {
      assert.deepStrictEqual(f[k], before.facets[k], k);
    }
    const sum = await facets.idsSummary([0, 4294967296, ID.beach]);
    assert.strictEqual(sum.count, 1);
    const d = await facets.duplicates({ limit: 1000 });
    assert.ok(!d.groups.some(g => g.ids.some(isOut)));
  } finally {
    db.get().prepare('DELETE FROM media WHERE NOT (id BETWEEN 1 AND 4294967295)').run();
  }
});
