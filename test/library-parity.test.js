/**
 * Parity: the server's filters and sort must return exactly what the browser
 * computed before (SERVER_SEARCH_SPEC section 9).
 *
 * The reference below is the browser's own code, copied from
 * player-lib/filters.js (applyFilters first pass, sortFilteredMedia),
 * player-lib/duplicates.js (buildDuplicateIndex / isDuplicate) and
 * player-lib/collections.js (mediaInAnyCollection, inActiveCollection,
 * applyCollectionOrder) at 13c23ec, with DOM reads replaced by a state
 * object. It runs over every viewer row in filepath order (what the old
 * viewer downloaded from GET /api/media, since removed), on a generated
 * library of a few thousand rows full of ties,
 * NULLs, empty strings and malformed values. No text search here: that
 * follows the new A3 rules on purpose (test/library-query.test.js).
 *
 * Known, documented differences are kept out of the generated data: non-ASCII
 * file names (NOCASE vs toLowerCase), and themes that are valid JSON but not
 * an array (the browser's String.includes did a substring test on those).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-parity-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const q = require('../lib/library-query');

// ── Generated library ─────────────────────────────────────────────────────

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260930);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;

const ROWS = 3000;
const TYPES = ['video', 'video', 'video', 'image', 'image', 'audio', 'gif', 'mix', 'document', 'other'];
const EXTS = ['mp4', 'MP4', 'mkv', 'webm', 'mov', 'jpg', 'JPEG', 'png', 'gif', 'mp3', 'flac', 'pdf', 'txt', 'avi', ''];
const WORDS = ['alpha', 'Beta', 'gamma', 'delta', 'Echo', 'fox', 'golf', 'hotel', 'india', 'a', 'Z', '_x', '0', '9lives'];
const THEMES = ['romance', 'Romance', 'sea', 'city', 'night', 'forest', 'rain', 5, null];
const LANGS = [null, '', 'en', 'EN', 'English', 'ja', 'Japanese', 'klingon', 'none', 'zh-TW', 'pt_BR'];
const DATES = [null, '', '2024-01-01 10:00:00', '2024-01-01 10:00:00', '2023-05-05 00:00:00', '2025-12-31 23:59:59',
  '2024-06-15 12:00:00', '2022-02-02 02:02:02'];
const NOTES = [null, '', '[]', '[{"text":"hi"}]', 'plain note'];
const ERRORS = [null, null, null, '', 'unscanned', 'vision api failed', 'ffprobe crashed'];
const SIZES = [null, 0, 1000, 1000, 2000, 3000];
const CONTENT = [null, '', 'vlog', 'meme', 'music video', 'photo'];
const QUALITY = [null, '', 'good', 'low', 'blurry'];
const nullish = (v) => (chance(0.1) ? null : v);

function genRow(i) {
  const type = pick(TYPES);
  const base = `${pick(WORDS)}${pick(['_', ' ', '-', '.', ''])}${pick(WORDS)}${i % 7 === 0 ? '' : i}`;
  const ext = pick(EXTS);
  const filename = ext ? `${base}.${ext}` : (chance(0.3) ? `${base}.` : base);
  const folder = pick(['D:\\Media', 'D:\\media', 'E:\\Stuff', 'D:\\Media\\Sub', 'd:\\Media\\sub']);
  const themes = chance(0.05) ? pick(['not json', '[unclosed', '']) : JSON.stringify(
    Array.from({ length: Math.floor(rnd() * 4) }, () => pick(THEMES)));
  return {
    filepath: `${folder}\\${String(i).padStart(5, '0')}_${filename}`,
    filename,
    media_type: type,
    duration_seconds: chance(0.2) ? null : pick([0, 0, 30, 30, 59.5, 120, 600, 3600, 7200, 12000, Math.round(rnd() * 5000)]),
    filesize_bytes: chance(0.5) ? pick(SIZES) : Math.floor(rnd() * 1e9),
    language: pick(LANGS),
    themes,
    clean: chance(0.6) ? (chance(0.1) ? '' : JSON.stringify(
      Array.from({ length: Math.floor(rnd() * 3) }, () => pick(['romance', 'sea', 'city', 'night'])))) : undefined,
    content_type: pick(CONTENT),
    quality_flag: pick(QUALITY),
    processed_at: pick(DATES),
    processing_error: pick(ERRORS),
    user_notes: pick(NOTES),
    user_starred: nullish(chance(0.15) ? 1 : 0),
    user_rating: nullish(chance(0.5) ? 0 : Math.floor(rnd() * 6)),
    user_flagged_delete: nullish(chance(0.1) ? 1 : 0),
    user_trashed: nullish(chance(0.15) ? 1 : 0),
    playback_failed: nullish(chance(0.1) ? 1 : 0),
    view_count: nullish(Math.floor(rnd() * 4)),
    done_count: nullish(chance(0.7) ? 0 : Math.floor(rnd() * 3)),
  };
}

let collectionIds = [];
let folderId = null;
let songIds = [];

test.before(() => {
  db.init();
  const d = db.get();
  d.pragma('synchronous = OFF');
  const rows = Array.from({ length: ROWS }, (_, i) => genRow(i));
  const cols = Object.keys(rows[0]).filter(c => c !== 'clean');
  const ins = d.prepare(`INSERT INTO media (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  const clean = d.prepare('INSERT INTO media_clean (media_id, themes) VALUES (?, ?)');
  d.transaction(() => {
    for (const r of rows) {
      const id = Number(ins.run(...cols.map(c => r[c])).lastInsertRowid);
      if (r.clean !== undefined) clean.run(id, r.clean);
    }
  })();
  const ids = d.prepare('SELECT id FROM media').pluck().all();
  const folder = db.createCollection('F', { kind: 'folder' });
  folderId = folder.id;
  const c1 = db.createCollection('C1');
  const c2 = db.createCollection('C2', { parentId: folder.id });
  const c3 = db.createCollection('C3', { parentId: folder.id });
  collectionIds = [c1.id, c2.id, c3.id];
  for (const c of collectionIds) {
    const members = ids.filter(() => chance(0.08));
    // add in a shuffled order so playlist order differs from id order
    members.sort(() => rnd() - 0.5);
    db.addToCollection(c, members);
  }
  const repo = require('../lib/musicid/repo');
  for (const t of ['S1', 'S2']) {
    const s = repo.findOrCreateSong({ title: t, artist: 'A' });
    songIds.push(s.id ?? s);
  }
  const link = d.prepare('INSERT INTO media_songs (media_id, song_id) VALUES (?, ?)');
  for (const id of ids) if (chance(0.05)) link.run(id, pick(songIds));
});
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ── The browser reference (13c23ec) ───────────────────────────────────────

const BROWSER_PLAYABLE_EXTENSIONS = new Set([
  'mp4', 'webm', 'ogg', 'ogv', 'mov',
  'mp3', 'wav', 'ogg', 'oga', 'webm', 'aac', 'flac', 'm4a', 'opus',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'jfif',
  'pdf', 'txt', 'html', 'htm', 'json', 'xml', 'csv', 'md',
]);

function getExtension(filename) {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return '';
  return filename.substring(dot + 1).toLowerCase();
}

function scanStatusOf(media) {
  if (!media.processing_error) return 'success';
  if (media.processing_error === 'unscanned') return 'unscanned';
  return 'failed';
}

function browserContext() {
  // Every viewer row in filepath order: what GET /api/media sent the old
  // viewer (that route and getAllForViewer are gone now).
  const order = db.get().prepare('SELECT id FROM media ORDER BY filepath').pluck().all();
  const allMedia = db.getManyForViewer(order);
  // duplicates.js buildDuplicateIndex
  const duplicateFilepaths = new Set();
  const sizeMap = {};
  allMedia.forEach(m => {
    if (!m.filesize_bytes || !m.media_type) return;
    const key = `${m.media_type}:${m.filesize_bytes}`;
    if (!sizeMap[key]) sizeMap[key] = [];
    sizeMap[key].push(m);
  });
  Object.entries(sizeMap).forEach(([, items]) => {
    if (items.length < 2) return;
    items.forEach(m => duplicateFilepaths.add(m.filepath));
  });
  // collections.js caches
  const collectionsList = db.getCollections();
  const collectionMembers = new Map();
  for (const c of collectionsList) collectionMembers.set(c.id, db.getCollectionItems(c.id));
  // music.js musicLinksMap
  const musicLinksMap = require('../lib/musicid/repo').linksMap();
  return { allMedia, duplicateFilepaths, collectionsList, collectionMembers, musicLinksMap };
}

function browserResult(ctx, st) {
  const { allMedia, duplicateFilepaths, collectionsList, collectionMembers, musicLinksMap } = ctx;
  const isDuplicate = (fp) => duplicateFilepaths.has(fp);
  const mediaInAnyCollection = (id) => {
    for (const c of collectionsList) {
      if (c.kind === 'folder') continue;
      const ids = collectionMembers.get(c.id);
      if (ids && ids.includes(id)) return true;
    }
    return false;
  };
  const activeCollectionId = st.collectionId;
  // openCollection() always fetched the members first (an unknown id answers [])
  if (activeCollectionId != null && !collectionMembers.has(activeCollectionId)) {
    collectionMembers.set(activeCollectionId, db.getCollectionItems(activeCollectionId));
  }
  const inActiveCollection = (m) => {
    if (activeCollectionId == null) return true;
    const ids = collectionMembers.get(activeCollectionId);
    return ids ? ids.includes(m.id) : true;
  };
  const mediaSongIds = (id) => musicLinksMap[id] || [];
  const focusIds = st.onlyIds ? new Set(st.onlyIds) : null;
  const f = st.filters;
  const { selectedMediaTypes, safeOnly, selectedExtensions } = { selectedMediaTypes: f.mediaTypes, safeOnly: f.safeOnly, selectedExtensions: f.extensions };
  const contentType = f.content; const language = f.language; const theme = f.theme; const quality = f.quality;
  const songFilter = f.song; const minRatingValue = f.minRating;
  const triCollections = f.collections; const triStarred = f.starred; const triHasNotes = f.hasNotes;
  const triDuplicates = f.duplicates; const triFlagged = f.flagged; const triTrashed = f.trashed;
  const triFailed = f.failed; const scanStatus = f.scanStatus;
  const durMinM = f.durMin; const durMaxM = f.durMax;

  // player-lib/filters.js applyFilters, first pass
  let candidates = allMedia.filter(m => {
    if (focusIds) return focusIds.has(m.id);
    const allowedMediaTypes = ['video', 'audio', 'image', 'gif', 'mix'];
    if (!allowedMediaTypes.includes(m.media_type)) return false;
    if (!inActiveCollection(m)) return false;
    if (triCollections && (activeCollectionId == null)) {
      if (triCollections === '1' && !mediaInAnyCollection(m.id)) return false;
      if (triCollections === '0' && mediaInAnyCollection(m.id)) return false;
    }
    if (songFilter && !mediaSongIds(m.id).includes(songFilter)) return false;
    if (selectedMediaTypes.length > 0 && !selectedMediaTypes.includes(m.media_type)) return false;
    if (safeOnly && !BROWSER_PLAYABLE_EXTENSIONS.has(getExtension(m.filename))) return false;
    if (selectedExtensions.length > 0) {
      const ext = getExtension(m.filename);
      if (!selectedExtensions.includes(ext)) return false;
    }
    if (contentType && m.content_type !== contentType) return false;
    if (language && (m.language_name || 'Unknown') !== language) return false;
    if (quality && m.quality_flag !== quality) return false;
    if (triStarred === '1' && !m.user_starred) return false;
    if (triStarred === '0' && m.user_starred) return false;
    if (triHasNotes) {
      const hasNotes = m.user_notes && m.user_notes !== '[]' && m.user_notes !== '';
      if (triHasNotes === '1' && !hasNotes) return false;
      if (triHasNotes === '0' && hasNotes) return false;
    }
    if (triFlagged === '1' && !m.user_flagged_delete) return false;
    if (triFlagged === '0' && m.user_flagged_delete) return false;
    if (triTrashed === '1' && !m.user_trashed) return false;
    if (triTrashed === '0' && m.user_trashed) return false;
    if (triFailed === '1' && !m.playback_failed) return false;
    if (triFailed === '0' && m.playback_failed) return false;
    if (scanStatus && scanStatusOf(m) !== scanStatus) return false;
    if (triDuplicates === '1' && !isDuplicate(m.filepath)) return false;
    if (triDuplicates === '0' && isDuplicate(m.filepath)) return false;
    if (minRatingValue === 'unrated' && (m.user_rating || 0) > 0) return false;
    if (minRatingValue !== '0' && minRatingValue !== 'unrated') {
      const minRating = parseInt(minRatingValue) || 0;
      if (minRating > 0 && (m.user_rating || 0) < minRating) return false;
    }
    const duration = m.duration_seconds || 0;
    if (durMinM > 0 && duration < durMinM * 60) return false;
    if (durMaxM != null && duration > durMaxM * 60) return false;
    if (theme) {
      try {
        const themes = JSON.parse(m.themes_clean || m.themes || '[]');
        if (!themes.includes(theme)) return false;
      } catch {
        return false;
      }
    }
    return true;
  });

  // audio-sim
  let semanticOrdered = false;
  if (st.rankedIds) {
    const audioSimScores = new Map(st.rankedIds.map(r => [r.id, r.score]));
    candidates = candidates.filter(m => audioSimScores.has(m.id));
    const score = (m) => (audioSimScores.get(m.id) || 0);
    candidates.sort((a, b) => score(b) - score(a));
    semanticOrdered = true;
  }
  const filteredMedia = candidates;

  // sortFilteredMedia
  if (semanticOrdered) return filteredMedia.map(m => m.id);
  const applyCollectionOrder = (list) => {
    if (activeCollectionId == null) return false;
    const ids = collectionMembers.get(activeCollectionId);
    if (!ids) return false;
    const pos = new Map(ids.map((id, i) => [id, i]));
    list.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
    return true;
  };
  if (applyCollectionOrder(filteredMedia)) return filteredMedia.map(m => m.id);
  const field = st.sort.field;
  const asc = st.sort.dir === 'asc';
  filteredMedia.sort((a, b) => {
    let valA, valB;
    switch (field) {
      case 'processed': valA = a.processed_at || ''; valB = b.processed_at || ''; break;
      case 'name': valA = (a.filename || '').toLowerCase(); valB = (b.filename || '').toLowerCase(); break;
      case 'size': valA = a.filesize_bytes || 0; valB = b.filesize_bytes || 0; break;
      case 'duration': valA = a.duration_seconds || 0; valB = b.duration_seconds || 0; break;
      case 'rating': valA = a.user_rating || 0; valB = b.user_rating || 0; break;
      case 'views': valA = a.view_count || 0; valB = b.view_count || 0; break;
      case 'done': valA = a.done_count || 0; valB = b.done_count || 0; break;
      default: return 0;
    }
    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return 0;
  });
  if (st.sort.favesFirst) {
    filteredMedia.sort((a, b) => (b.user_starred ? 1 : 0) - (a.user_starred ? 1 : 0));
  }
  return filteredMedia.map(m => m.id);
}

// ── The matrix ────────────────────────────────────────────────────────────

const FILTER_VARIANTS = [
  {},
  { trashed: '' }, { trashed: '1' },
  { mediaTypes: ['video'] }, { mediaTypes: ['image', 'gif'] }, { mediaTypes: ['document'] }, { mediaTypes: ['mix', 'audio'] },
  { safeOnly: true }, { extensions: ['mp4'] }, { extensions: ['jpeg', 'mkv', ''] },
  { content: 'vlog' }, { content: 'music video' },
  { language: 'English' }, { language: 'Unknown' }, { language: 'None' }, { language: 'Japanese' },
  { language: 'Chinese' }, { language: 'Portuguese' }, { language: 'Martian' },
  { quality: 'low' }, { theme: 'romance' }, { theme: 'Romance' }, { theme: 'sea' }, { theme: '5' },
  { minRating: 'unrated' }, { minRating: '1' }, { minRating: '3' }, { minRating: '5' },
  { durMin: 1 }, { durMin: 2 }, { durMax: 0 }, { durMax: 1 }, { durMin: 1, durMax: 60 }, { durMax: 200 },
  { collections: '1' }, { collections: '0' },
  { starred: '1' }, { starred: '0' }, { hasNotes: '1' }, { hasNotes: '0' },
  { flagged: '1' }, { flagged: '0' }, { failed: '1' }, { failed: '0' },
  { duplicates: '1' }, { duplicates: '0' },
  { scanStatus: 'success' }, { scanStatus: 'failed' }, { scanStatus: 'unscanned' },
];
const SORTS = [];
for (const field of ['processed', 'name', 'size', 'duration', 'rating', 'views', 'done']) {
  for (const dir of ['desc', 'asc']) for (const favesFirst of [false, true]) SORTS.push({ field, dir, favesFirst });
}

function fullSpec(body) {
  return q.normalizeSpec({ pageSize: 50, ...body });
}

// Every query path must agree with the browser: the small-set lookup, the
// index walk, and whatever the size-based choice picks.
const PATHS = [['small set', 1e9], ['index walk', -1], ['automatic', null]];

async function check(ctx, body, label) {
  const spec = fullSpec(body);
  const expected = browserResult(ctx, spec);
  for (const [path, smallSet] of PATHS) {
    q._tuning.smallSet = smallSet;
    try {
      const got = await q.allIds(spec);
      assert.deepStrictEqual([...got.ids], expected, `${label} (${path}): ${JSON.stringify(body)}`);
      // The first page is the head of the same list.
      const page = await q.firstPage(spec, 50);
      assert.deepStrictEqual(page.ids, expected.slice(0, 50), `${label} first page (${path}): ${JSON.stringify(body)}`);
    } finally {
      q._tuning.smallSet = null;
    }
  }
  return expected.length;
}

test('every filter value, default sort', async () => {
  const ctx = browserContext();
  for (const filters of FILTER_VARIANTS) await check(ctx, { filters }, 'filter');
  // song needs the generated ids
  for (const song of songIds) await check(ctx, { filters: { song } }, 'song');
});

test('every sort, both directions, with and without faves first', async () => {
  const ctx = browserContext();
  for (const sort of SORTS) {
    await check(ctx, { sort }, 'sort');
    await check(ctx, { sort, filters: { trashed: '' } }, 'sort, all rows');
    await check(ctx, { sort, filters: { mediaTypes: ['image'], starred: '0' } }, 'sort, filtered');
  }
});

test('open collections and folders, focus sets and ranked ids', async () => {
  const ctx = browserContext();
  const ids = ctx.allMedia.map(m => m.id);
  for (const collectionId of [...collectionIds, folderId, 999999]) {
    for (const sort of [SORTS[0], SORTS[5], SORTS[3]]) {
      await check(ctx, { collectionId, sort }, 'collection');
      await check(ctx, { collectionId, sort, filters: { collections: '0', mediaTypes: ['video'] } }, 'collection filtered');
    }
  }
  const focus = ids.filter(() => chance(0.1));
  for (const sort of SORTS.slice(0, 8)) {
    await check(ctx, { onlyIds: focus, sort, filters: { mediaTypes: ['video'], trashed: '1' } }, 'focus');
  }
  await check(ctx, { onlyIds: focus, collectionId: collectionIds[0] }, 'focus in a collection');
  const ranked = ids.filter(() => chance(0.1)).map(id => ({ id, score: Math.floor(rnd() * 5) / 4 }));
  for (const filters of [{}, { mediaTypes: ['image'] }, { trashed: '' }]) {
    await check(ctx, { rankedIds: ranked, filters, sort: { field: 'name', dir: 'asc', favesFirst: true } }, 'ranked');
  }
});

test('random combinations of filters and sorts', async () => {
  const ctx = browserContext();
  let nonEmpty = 0;
  for (let i = 0; i < 250; i++) {
    const filters = {};
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) Object.assign(filters, pick(FILTER_VARIANTS));
    if (chance(0.2)) filters.song = pick(songIds);
    const body = { filters, sort: pick(SORTS) };
    if (chance(0.15)) body.collectionId = pick([...collectionIds, folderId]);
    if ((await check(ctx, body, `combo ${i}`)) > 0) nonEmpty++;
  }
  assert.ok(nonEmpty > 100, `most combinations should match something (${nonEmpty})`);
});

// ── Facets: fchipCountMaps(), renderMediaTypeBar(), buildExtensionMap() ────

test('facet counts equal the browser\'s counts on the same rows', async () => {
  const ctx = browserContext();
  const isDuplicate = (fp) => ctx.duplicateFilepaths.has(fp);
  const FCHIP_COUNT_TYPES = new Set(['video', 'audio', 'image', 'gif', 'mix']);
  const bump = (map, key) => { if (key == null || key === '') return; map[key] = (map[key] || 0) + 1; };
  const maps = {
    total: 0, content: {}, language: {}, quality: {}, theme: {},
    rating: { unrated: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    fave: 0, notes: 0, flagged: 0, trashed: 0, unplayable: 0, dupes: 0,
    scan: { success: 0, failed: 0, unscanned: 0 },
  };
  const types = { video: 0, audio: 0, image: 0, gif: 0, mix: 0 };
  for (const m of ctx.allMedia) {
    if (!FCHIP_COUNT_TYPES.has(m.media_type)) continue;
    types[m.media_type]++;
    maps.total++;
    bump(maps.content, m.content_type);
    bump(maps.language, m.language_name);
    bump(maps.quality, m.quality_flag);
    try {
      // Known difference: the browser also counted non-string array items
      // (a stray number), which its own Theme filter could never match.
      for (const t of new Set(JSON.parse(m.themes_clean || m.themes || '[]'))) if (typeof t === 'string') bump(maps.theme, t);
    } catch {}
    const r = m.user_rating || 0;
    if (r === 0) maps.rating.unrated++;
    for (let i = 1; i <= r && i <= 5; i++) maps.rating[i]++;
    if (m.user_starred) maps.fave++;
    if (m.user_notes && m.user_notes !== '' && m.user_notes !== '[]') maps.notes++;
    if (m.user_flagged_delete) maps.flagged++;
    if (m.user_trashed) maps.trashed++;
    if (m.playback_failed) maps.unplayable++;
    if (isDuplicate(m.filepath)) maps.dupes++;
    maps.scan[scanStatusOf(m)]++;
  }
  // buildExtensionMap (every row with a type and an extension)
  const extensionMap = {};
  for (const m of ctx.allMedia) {
    if (!m.media_type) continue;
    const ext = getExtension(m.filename);
    if (!ext) continue;
    const key = `${m.media_type}\u0000${ext}`;
    extensionMap[key] = (extensionMap[key] || 0) + 1;
  }

  require('../lib/library-facets').reset();
  const f = await require('../lib/library-facets').facets();
  assert.strictEqual(f.total, maps.total);
  assert.deepStrictEqual(f.types, types);
  assert.deepStrictEqual(f.content, maps.content);
  assert.deepStrictEqual(f.language, maps.language);
  assert.deepStrictEqual(f.quality, maps.quality);
  assert.deepStrictEqual(f.theme, maps.theme);
  assert.deepStrictEqual(f.rating, maps.rating);
  for (const k of ['fave', 'notes', 'flagged', 'trashed', 'unplayable', 'dupes']) assert.strictEqual(f[k], maps[k], k);
  assert.deepStrictEqual(f.scan, maps.scan);
  const serverExt = Object.fromEntries(f.extensions.map(e => [`${e.type}\u0000${e.ext}`, e.count]));
  assert.deepStrictEqual(serverExt, extensionMap);
  // Playback groups cover every row and add up to the extension counts.
  assert.strictEqual(f.playbackGroups.reduce((n, g) => n + g.count, 0), ctx.allMedia.length);
  const byExt = {};
  for (const g of f.playbackGroups) {
    if (!g.media_type || !g.ext) continue;
    const key = `${g.media_type}\u0000${g.ext}`;
    byExt[key] = (byExt[key] || 0) + g.count;
  }
  assert.deepStrictEqual(byExt, extensionMap);
  const durations = ctx.allMedia.filter(m => FCHIP_COUNT_TYPES.has(m.media_type) && m.duration_seconds != null)
    .map(m => m.duration_seconds);
  assert.strictEqual(f.maxDurationSeconds, Math.max(0, ...durations));
});
