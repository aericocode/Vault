/**
 * Gamify on large libraries (lib/gamify.js, lib/quests.js, lib/achievements.js,
 * lib/gamify-tally.js, lib/gamify-library.js).
 *
 * The request-path numbers (status, rarity, finishers, top item, achievement
 * probes, quest counts, Full Stats) used to be whole-library scans. They now
 * come from trigger-kept tallies, index-friendly queries and a library
 * profile built in slices. Every test here checks the new numbers against the
 * ORIGINAL queries (copied below as oracles) on a library shaped to hit the
 * edge cases: confirmed duplicates, trash, ties, NULLs, subtitles, languages.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-gamify-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const gamify = require('../lib/gamify');
const quests = require('../lib/quests');
const tally = require('../lib/gamify-tally');
const library = require('../lib/gamify-library');
const achievements = require('../lib/achievements');

test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const raw = () => db.get();

/* ── The library ─────────────────────────────────────────────────────────── */

let seq = 0;
function save(over = {}) {
  seq++;
  const data = {
    filepath: `/lib/f${seq}.mp4`, filename: `${String.fromCharCode(65 + (seq % 26))}${seq}.mp4`,
    mediaType: 'video', duration: 600, width: 1920, height: 1080, filesize: 1000 + seq,
    language: 'en', themes: ['Beach'], tags: ['sand'], description: 'words',
    qualityFlag: 'good', contentType: 'vlog', ...over,
  };
  db.saveMedia(data);
  return db.getMediaId(data.filepath);
}
const set = (id, cols) => {
  const keys = Object.keys(cols);
  raw().prepare(`UPDATE media SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => cols[k]), id);
};

function seedLibrary() {
  const themes = [['Beach', 'Sunset'], ['Forest'], ['City', 'Night'], ['Beach'], ['Mountain', 'Snow'], ['Forest', 'Rain']];
  const tags = [['sand', 'waves'], ['trees'], ['lights'], ['sand'], ['peak', 'cold'], ['wet']];
  const langs = ['en', 'English', 'ja', 'de', 'unknown', null, 'fr', 'en'];
  for (let i = 0; i < 48; i++) {
    const type = i % 7 === 0 ? 'audio' : i % 5 === 0 ? 'image' : 'video';
    const id = save({
      mediaType: type,
      duration: [30, 90, 600, 2400, 0, 7200][i % 6],
      width: i % 9 === 0 ? 3840 : 1920, height: i % 11 === 0 ? 2160 : 1080,
      language: langs[i % langs.length] || undefined,
      themes: themes[i % themes.length], tags: tags[(i * 5) % tags.length],
    });
    if (langs[i % langs.length] === null) set(id, { language: null });
    set(id, { view_count: [0, 0, 0, 1, 2, 3, 5, 0, 2][i % 9], done_count: i % 4 === 0 ? (i % 3) + 1 : 0 });
    if (i % 13 === 0) set(id, { user_rating: (i % 5) + 1 });
    if (i % 10 === 0) set(id, { user_starred: 1 });
    if (i % 12 === 5) set(id, { user_trashed: 1 });
    if (i % 17 === 3) set(id, { view_count: null });
  }
  // Confirmed duplicate groups: members share a dupe_group (the lowest id)
  const ids = raw().prepare("SELECT id FROM media WHERE media_type = 'video' ORDER BY id").pluck().all();
  for (const [a, b, c] of [[ids[1], ids[2], ids[3]], [ids[6], ids[9], null], [ids[14], ids[15], ids[20]]]) {
    for (const x of [a, b, c]) if (x) set(x, { dupe_group: a });
  }
  // Clean copies on some rows (preferred over the raw columns)
  db.upsertClean(ids[4], { themes: ['beach', 'golden hour'], tags: ['sand'], locations: [] });
  db.upsertClean(ids[5], { themes: ['forest'], tags: ['trees', 'moss'], locations: [] });
  // Subtitle tracks
  raw().exec(`CREATE TABLE IF NOT EXISTS subtitle_tracks (
    media_id INTEGER NOT NULL, lang TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (media_id, lang))`);
  for (const id of [ids[0], ids[2], ids[3], ids[7], ids[8], ids[10], ids[11], ids[12]]) {
    raw().prepare("INSERT INTO subtitle_tracks (media_id, lang, kind, path) VALUES (?, 'en', 'original', 'x.vtt')").run(id);
  }
  raw().prepare("INSERT INTO subtitle_tracks (media_id, lang, kind, path) VALUES (?, 'de', 'translated', 'y.vtt')").run(ids[0]);
  set(ids[7], { duration_seconds: 900, audio_transcription: '' });
  set(ids[8], { duration_seconds: 900, audio_transcription: 'hi' });
}

/* ── Oracles: the original queries (dev before this change) ─────────────── */

const CONTENT_KEY = "COALESCE('g' || dupe_group, 'i' || id)";
const WATCH_TYPES = "('video', 'audio')";

const orig = {
  finishers: () => raw().prepare(
    'SELECT COALESCE(SUM(done_count), 0) AS n FROM media WHERE COALESCE(user_trashed, 0) = 0').get().n,
  topItem: () => raw().prepare(`
    SELECT id, filename, media_type, COALESCE(user_rating, 0) AS rating, COALESCE(view_count, 0) AS views
    FROM media
    WHERE COALESCE(user_trashed, 0) = 0 AND (COALESCE(user_rating, 0) > 0 OR COALESCE(view_count, 0) >= 2)
    ORDER BY rating DESC, views DESC, id DESC LIMIT 1`).get() || null,
  // One deliberate difference: a NULL view_count (raw SQL only; the column
  // defaults to 0 and every app write COALESCEs) now counts as 0 views.
  rarity: (views) => {
    const { total, below } = raw().prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(view_count, 0) < ? THEN 1 ELSE 0 END) AS below
      FROM media WHERE user_trashed = 0`).get(views);
    return total ? 3.0 - ((below || 0) / total) * 2.0 : 1.0;
  },
  achFinishers: () => raw().prepare('SELECT COALESCE(SUM(done_count),0) AS n FROM media').get().n,
  langsWatched: () => {
    const { canonLang } = require('../lib/lang');
    const codes = new Set();
    for (const r of raw().prepare('SELECT DISTINCT language FROM media WHERE view_count > 0 AND language IS NOT NULL').all()) {
      const code = canonLang(r.language);
      if (code && code !== 'none') codes.add(code);
    }
    return codes.size;
  },
  silent: () => raw().prepare(`
    SELECT COUNT(*) AS n FROM media m
    WHERE m.view_count > 0 AND m.duration_seconds > 180
      AND EXISTS (SELECT 1 FROM subtitle_tracks st WHERE st.media_id = m.id)
      AND length(COALESCE(m.audio_transcription, '')) < 60`).get().n,
  questCtx() {
    const c = raw();
    const labelsOf = library.labelsOf;
    const rows = c.prepare(`
      SELECT m.id, m.dupe_group, m.view_count, m.themes, m.tags,
             mc.themes AS themes_clean, mc.tags AS tags_clean
      FROM media m LEFT JOIN media_clean mc ON mc.media_id = m.id
      WHERE m.user_trashed = 0 AND m.media_type IN ${WATCH_TYPES}`).all();
    const agg = {};
    for (const r of rows) {
      const labels = labelsOf(r);
      const key = r.dupe_group != null ? 'g' + r.dupe_group : 'i' + r.id;
      for (const label of labels) {
        const a = agg[label] || (agg[label] = { keys: new Set(), views: 0 });
        if (!a.keys.has(key)) { a.keys.add(key); a.views += r.view_count || 0; }
      }
    }
    const labels = Object.entries(agg).filter(([, v]) => v.keys.size >= 5)
      .map(([label, v]) => ({ label, items: v.keys.size, avgViews: v.views / v.keys.size }))
      .sort((a, b) => a.avgViews - b.avgViews);
    const n = (sql) => c.prepare(sql).get().n;
    const band = (where) => n(`SELECT COUNT(DISTINCT ${CONTENT_KEY}) AS n FROM media WHERE user_trashed = 0 AND media_type IN ${WATCH_TYPES} AND ${where}`);
    return {
      labels,
      unseen: n(`SELECT COUNT(*) AS n FROM (SELECT ${CONTENT_KEY} AS k FROM media WHERE user_trashed = 0 AND media_type IN ${WATCH_TYPES} GROUP BY k HAVING MAX(COALESCE(view_count, 0)) = 0)`),
      unrated: n('SELECT COUNT(*) AS n FROM media WHERE user_trashed = 0 AND COALESCE(user_rating, 0) = 0'),
      types: c.prepare(`SELECT media_type, COUNT(DISTINCT ${CONTENT_KEY}) AS n FROM media WHERE user_trashed = 0 AND media_type IN ${WATCH_TYPES} GROUP BY media_type`).all(),
      languages: c.prepare(`SELECT language, COUNT(DISTINCT ${CONTENT_KEY}) AS n FROM media
        WHERE user_trashed = 0 AND media_type = 'video' AND language IS NOT NULL
          AND lower(language) NOT IN ('unknown', 'none', 'n/a', 'na', 'code', 'not applicable')
        GROUP BY language HAVING n >= 5`).all(),
      subtitled: n(`SELECT COUNT(DISTINCT COALESCE('g' || m.dupe_group, 'i' || m.id)) AS n FROM subtitle_tracks st JOIN media m ON m.id = st.media_id WHERE m.user_trashed = 0`),
      watchable: n(`SELECT COUNT(DISTINCT ${CONTENT_KEY}) AS n FROM media WHERE user_trashed = 0 AND media_type IN ${WATCH_TYPES}`),
      longform: band('COALESCE(duration_seconds, 0) >= 1800'),
      shorts: band('duration_seconds > 0 AND duration_seconds < 120'),
      hiRes: n(`SELECT COUNT(DISTINCT ${CONTENT_KEY}) AS n FROM media WHERE user_trashed = 0 AND media_type = 'video' AND (COALESCE(width, 0) >= 3840 OR COALESCE(height, 0) >= 2160)`),
      total: n('SELECT COUNT(*) AS n FROM media WHERE user_trashed = 0'),
      unfaved: n('SELECT COUNT(*) AS n FROM media WHERE user_trashed = 0 AND COALESCE(user_starred, 0) = 0'),
    };
  },
  analytics() {
    const c = raw();
    let cum = 0;
    const growth = c.prepare(`SELECT date(created_at) AS d, COUNT(*) AS n FROM media WHERE created_at IS NOT NULL GROUP BY d ORDER BY d`)
      .all().map(r => ({ d: r.d, total: (cum += r.n) }));
    const dist = [0, 0, 0, 0, 0];
    for (const r of c.prepare('SELECT user_rating AS r, COUNT(*) AS n FROM media WHERE COALESCE(user_rating,0) BETWEEN 1 AND 5 GROUP BY user_rating').all()) dist[r.r - 1] = r.n;
    const tagCount = {};
    for (const r of c.prepare("SELECT tags FROM media WHERE COALESCE(user_trashed,0)=0 AND tags IS NOT NULL AND tags != '' AND tags != '[]'").all()) {
      for (const t of JSON.parse(r.tags)) if (t) tagCount[t] = (tagCount[t] || 0) + 1;
    }
    const under = Object.entries(tagCount).filter(([, n]) => n <= 2);
    const av = "media_type IN ('video','audio')";
    const lib = c.prepare(`SELECT COALESCE(SUM(duration_seconds),0) AS secs, COALESCE(SUM(filesize_bytes),0) AS bytes, COUNT(*) AS items FROM media WHERE COALESCE(user_trashed,0)=0`).get();
    return {
      growth, dist, underTotal: under.length, underTags: new Set(under.map(([t]) => t)),
      watched: c.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${av} AND COALESCE(view_count,0) > 0 AND COALESCE(user_trashed,0)=0`).get().n,
      done: c.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${av} AND COALESCE(done_count,0) > 0 AND COALESCE(user_trashed,0)=0`).get().n,
      milestones: { contentDays: Math.round((lib.secs / 86400) * 10) / 10, contentHours: Math.round(lib.secs / 3600), storageBytes: lib.bytes, items: lib.items },
    };
  },
};

/** The tallies recomputed from media, in the shape of the table. */
function expectedTally() {
  const c = raw();
  const out = {};
  const put = (kind, k, n) => { if (n) out[`${kind}|${k}`] = n; };
  put('files', 'all', c.prepare('SELECT COUNT(*) AS n FROM media').get().n);
  for (const r of c.prepare('SELECT COALESCE(view_count, 0) AS k, COUNT(*) AS n FROM media WHERE user_trashed = 0 GROUP BY 1').all()) put('views', r.k, r.n);
  put('done', 'all', c.prepare('SELECT COALESCE(SUM(done_count), 0) AS n FROM media WHERE done_count > 0').get().n);
  put('done', 'kept', c.prepare('SELECT COALESCE(SUM(done_count), 0) AS n FROM media WHERE done_count > 0 AND COALESCE(user_trashed, 0) = 0').get().n);
  for (const r of c.prepare('SELECT language AS k, COUNT(*) AS n FROM media WHERE view_count > 0 AND language IS NOT NULL GROUP BY 1').all()) put('lang', r.k, r.n);
  put('av', 'viewed', c.prepare("SELECT COUNT(*) AS n FROM media WHERE view_count > 0 AND media_type IN ('video','audio') AND COALESCE(user_trashed, 0) = 0").get().n);
  put('av', 'done', c.prepare("SELECT COUNT(*) AS n FROM media WHERE done_count > 0 AND media_type IN ('video','audio') AND COALESCE(user_trashed, 0) = 0").get().n);
  return out;
}
function actualTally() {
  const out = {};
  for (const r of raw().prepare('SELECT kind, k, n FROM gamify_tally').all()) if (r.n) out[`${r.kind}|${r.k}`] = r.n;
  return out;
}

function checkStats(label) {
  const s = gamify.getPublicStats();
  assert.strictEqual(s.finishers, orig.finishers(), `${label}: finishers`);
  assert.deepStrictEqual(s.topItem, orig.topItem(), `${label}: topItem`);
  const a = achievements.getAchievements();
  const val = (id) => a.tiered.find(x => x.id === id).value;
  assert.strictEqual(val('finishers'), orig.achFinishers(), `${label}: achievement finishers`);
  assert.strictEqual(val('polyglot'), orig.langsWatched(), `${label}: polyglot`);
}

/* ── Tests (in order: they share one library) ───────────────────────────── */

test('before the tallies exist, every number matches the original queries', () => {
  db.init();
  seedLibrary();
  assert.strictEqual(tally.isReady(raw()), false);
  checkStats('fallback');
  // Rarity through a real scored view (the server bumps view_count first)
  for (const id of raw().prepare("SELECT id FROM media WHERE media_type = 'video' AND user_trashed = 0 LIMIT 3").pluck().all()) {
    const row = db.incrementViewCount(id);
    const want = orig.rarity(row.view_count);
    const got = gamify.recordView(id, 200);
    assert.strictEqual(got.breakdown.rarity, Math.round(want * 100) / 100);
  }
});

test('install fills the tallies exactly, once', () => {
  assert.ok(tally.install(raw()) >= 0);
  assert.strictEqual(tally.isReady(raw()), true);
  assert.deepStrictEqual(actualTally(), expectedTally());
  assert.strictEqual(tally.install(raw()), 0, 'second install is a no-op');
  checkStats('tally');
});

test('the triggers keep the tallies exact through every kind of write', () => {
  const c = raw();
  const ids = c.prepare('SELECT id FROM media ORDER BY id').pluck().all();
  const steps = [
    () => db.incrementViewCount(ids[0]),
    () => db.incrementViewCount(ids[4]),
    () => db.markDone(ids[5], 0),
    () => set(ids[6], { user_trashed: 1 }),
    () => set(ids[6], { user_trashed: 0 }),
    () => set(ids[11], { user_trashed: 1, view_count: 7, done_count: 2 }),
    () => set(ids[8], { language: 'pt' }),
    () => set(ids[9], { language: null }),
    () => set(ids[10], { media_type: 'image' }),
    () => set(ids[12], { view_count: null, done_count: null }),
    () => set(ids[13], { user_trashed: null }),
    () => c.prepare('DELETE FROM media WHERE id = ?').run(ids[14]),
    () => save({ mediaType: 'audio', language: 'ja' }),
    // A writer without this code (a CLI scan, an older Vault): raw SQL only
    () => c.prepare("INSERT INTO media (filepath, filename, media_type, language, view_count, done_count) VALUES ('/raw/a.mkv', 'a.mkv', 'video', 'ko', 4, 3)").run(),
    () => c.prepare("UPDATE media SET view_count = view_count + 2 WHERE filepath = '/raw/a.mkv'").run(),
    () => c.prepare("UPDATE media SET id = 99999 WHERE filepath = '/raw/a.mkv'").run(),
    () => c.prepare("UPDATE media SET description = 'only text' WHERE id = ?").run(ids[15]),
    () => c.prepare("DELETE FROM media WHERE filepath = '/raw/a.mkv'").run(),
  ];
  for (const [i, step] of steps.entries()) {
    step();
    assert.deepStrictEqual(actualTally(), expectedTally(), `after step ${i}`);
  }
  checkStats('after writes');
});

test('top item: rated files win, then most views, ties to the highest id; trash never counts', () => {
  const c = raw();
  c.prepare('UPDATE media SET user_rating = 0').run();
  checkStats('unrated');
  // A tie at the top view count: the higher id must win, as before
  const vmax = c.prepare('SELECT MAX(view_count) FROM media WHERE COALESCE(user_trashed, 0) = 0').pluck().get();
  const two = c.prepare('SELECT id FROM media WHERE COALESCE(user_trashed, 0) = 0 ORDER BY id LIMIT 2').pluck().all();
  for (const id of two) set(id, { view_count: vmax + 3 });
  checkStats('views tie');
  set(two[1], { user_trashed: 1 });
  checkStats('trashed top');
  set(two[1], { user_trashed: 0 });
  // Rated ties: same rating, views decide, then id
  const r = c.prepare("SELECT id FROM media WHERE COALESCE(user_trashed, 0) = 0 ORDER BY id DESC LIMIT 3").pluck().all();
  set(r[0], { user_rating: 4, view_count: 1 });
  set(r[1], { user_rating: 4, view_count: 1 });
  set(r[2], { user_rating: 3, view_count: 50 });
  checkStats('rated tie');
  set(r[2], { user_rating: 5 });
  checkStats('rated top');
  c.prepare('UPDATE media SET view_count = 0, user_rating = 0').run();
  assert.strictEqual(gamify.getPublicStats().topItem, null);
  checkStats('nothing stands out');
});

test('rarity from the tallies matches the original percentile', () => {
  const ids = raw().prepare("SELECT id FROM media WHERE media_type IN ('video','audio') AND COALESCE(user_trashed, 0) = 0 LIMIT 6").pluck().all();
  for (const [i, id] of ids.entries()) set(id, { view_count: i * 2 });
  for (const id of ids) {
    const row = db.incrementViewCount(id);
    const want = orig.rarity(row.view_count);
    const got = gamify.recordView(id, 30);
    assert.strictEqual(got.breakdown.rarity, Math.round(want * 100) / 100);
  }
});

test('silent-type achievement probe matches the original', () => {
  const c = raw();
  const subs = c.prepare('SELECT DISTINCT media_id FROM subtitle_tracks').pluck().all();
  for (const id of subs) set(id, { view_count: 1, duration_seconds: 600 });
  const a = achievements.getAchievements();
  const silent = a.hidden.find(h => h.id === 'silent_type');
  assert.match(silent.desc, new RegExp(`^${orig.silent()}/5`));
});

test('tallies are redone when their triggers went missing', () => {
  raw().exec('DROP TRIGGER gamify_tally_au');
  db.close();
  db.init();
  assert.strictEqual(tally.isReady(raw()), false);
  assert.ok(tally.install(raw()) >= 0);
  assert.deepStrictEqual(actualTally(), expectedTally());
});

/* ── Library profile (quest generation, Full Stats) ─────────────────────── */

function assertProfileMatches(p) {
  const want = orig.questCtx();
  const q = p.quests;
  for (const k of ['unseen', 'unrated', 'subtitled', 'watchable', 'longform', 'shorts', 'hiRes', 'total', 'unfaved']) {
    assert.strictEqual(q[k], want[k], k);
  }
  assert.deepStrictEqual(q.types, want.types);
  assert.deepStrictEqual(q.languages, want.languages);
  assert.deepStrictEqual(q.labels, want.labels.slice(0, q.labels.length));
  assert.strictEqual(q.labels.length, Math.min(20, want.labels.length));
}

test('library profile (small library, computed in the call) matches the original quest queries', () => {
  library.reset();
  // Variety for the views-weighted label ranking
  const c = raw();
  for (const [i, id] of c.prepare('SELECT id FROM media ORDER BY id').pluck().all().entries()) set(id, { view_count: i % 4 });
  const p = library.profile();
  assert.ok(p, 'a small library is profiled synchronously');
  assertProfileMatches(p);
  // Not cached: a change shows on the very next call
  const id = c.prepare("SELECT id FROM media WHERE media_type = 'video' AND user_trashed = 0 AND dupe_group IS NULL LIMIT 1").pluck().get();
  set(id, { user_trashed: 1 });
  assertProfileMatches(library.profile());
  set(id, { user_trashed: 0 });
});

test('library profile in the background: same numbers, persisted, served while stale', async () => {
  library.reset();
  library.setSyncBudget(0);   // behave like a library too big to profile inline
  try {
    assert.strictEqual(library.profile(), null, 'nothing yet: built in the background');
    const p = await library.whenReady();
    assertProfileMatches(p);
    const saved = JSON.parse(raw().prepare("SELECT value FROM gamify_cache WHERE key = 'library_profile'").pluck().get());
    assert.deepStrictEqual(saved.data, p);
    // A restart reads the persisted profile instead of scanning again
    library.forgetMemory();
    assert.deepStrictEqual(library.profile(), p);
    // A change does not show until the next refresh (library-wide numbers only)
    save({ mediaType: 'video' });
    assert.strictEqual(library.profile().quests.total, p.quests.total);
    const fresh = await (async () => { library.forgetMemory(); library.reset(); library.profile(); return library.whenReady(); })();
    assert.strictEqual(fresh.quests.total, p.quests.total + 1);
  } finally {
    library.setSyncBudget(80);
  }
});

test('analytics: library charts from the profile match the original queries', async () => {
  library.reset();
  const c = raw();
  const ids = c.prepare('SELECT id FROM media ORDER BY id').pluck().all();
  set(ids[1], { user_rating: 5 }); set(ids[2], { user_rating: 2 }); set(ids[3], { user_rating: 2 });
  set(ids[4], { user_notes: '[{"t":"x"}]' }); set(ids[5], { user_notes: '[]' });
  const a = gamify.getAnalytics(await library.whenReady());
  const want = orig.analytics();
  assert.deepStrictEqual(a.growth, want.growth);
  assert.deepStrictEqual(a.ratings.distribution, want.dist);
  assert.strictEqual(a.underTags.total, want.underTotal);
  for (const t of a.underTags.sample) assert.ok(want.underTags.has(t.tag), t.tag);
  assert.strictEqual(a.underTags.sample.length, Math.min(12, want.underTotal));
  assert.strictEqual(a.finishers.rate.watched, want.watched);
  assert.strictEqual(a.finishers.rate.done, want.done);
  assert.deepStrictEqual(a.milestones, want.milestones);
  // '[]' is "no notes" here, as everywhere else in the viewer
  assert.strictEqual(a.notes.itemsWithNotes, 1);
});

/* ── Quests: generation and progress ─────────────────────────────────────── */

const insertQuest = (type, target, params, reward = 100) => raw().prepare(`
  INSERT INTO gamify_quests (quest_type, title, description, target, reward_points, params)
  VALUES (?, ?, 'd', ?, ?, ?)`).run(type, `Q ${type}`, target, reward, JSON.stringify(params)).lastInsertRowid;

test('quests: a board waiting on a background profile fills when it is ready', async () => {
  const c = raw();
  c.prepare("UPDATE gamify_quests SET status = 'expired'").run();
  library.reset();
  library.setSyncBudget(0);
  try {
    assert.strictEqual(quests.ensureQuests().length, 0, 'no profile yet: board left as is');
    await library.whenReady();
    await new Promise(r => setImmediate(r));
    assert.strictEqual(quests.activeQuests().length, 3, 'topped up once the profile landed');
  } finally {
    library.setSyncBudget(80);
  }
  library.reset();
  c.prepare("UPDATE gamify_quests SET status = 'expired'").run();
  assert.strictEqual(quests.ensureQuests().length, 3, 'small library: filled in the call');
});

test('quests: watches advance and complete quests and award their points', () => {
  const c = raw();
  c.prepare("UPDATE gamify_quests SET status = 'expired'").run();
  const video = c.prepare("SELECT id FROM media WHERE media_type = 'video' AND COALESCE(user_trashed, 0) = 0 ORDER BY id DESC LIMIT 2").pluck().all();
  const q1 = insertQuest('type_views', 2, { media_type: 'video' }, 70);
  const q2 = insertQuest('unseen_views', 1, { unseenOnly: true }, 50);
  const q3 = insertQuest('rate_items', 1, { rate: true }, 40);
  for (const id of video) set(id, { view_count: 0 });
  const before = c.prepare('SELECT score, quests_completed FROM gamify_stats WHERE id = 1').get();

  db.incrementViewCount(video[0]);
  const r1 = gamify.recordView(video[0], 200);
  const ev = Object.fromEntries(r1.questEvents.map(e => [e.id, e]));
  assert.strictEqual(ev[q1].progress, 1);
  assert.strictEqual(ev[q2].completed, true);

  db.incrementViewCount(video[1]);
  const r2 = gamify.recordView(video[1], 200);
  assert.ok(r2.questEvents.some(e => e.id === Number(q1) && e.completed));

  quests.onRate({ user_rating: 4 }, 0);
  const st = (id) => c.prepare('SELECT status FROM gamify_quests WHERE id = ?').pluck().get(id);
  assert.strictEqual(st(q1), 'completed');
  assert.strictEqual(st(q2), 'completed');
  assert.strictEqual(st(q3), 'completed');

  // A completed slot is topped up with a random template, and a later watch in
  // this test may complete that one too: count only the three seeded quests.
  const after = c.prepare('SELECT score, quests_completed FROM gamify_stats WHERE id = 1').get();
  assert.ok(after.quests_completed >= before.quests_completed + 3);
  const seeded = c.prepare("SELECT COUNT(*) FROM gamify_quests WHERE id IN (?, ?, ?) AND status = 'completed' AND progress = target").pluck().get(q1, q2, q3);
  assert.strictEqual(seeded, 3);
  const rewards = c.prepare("SELECT COALESCE(SUM(points), 0) FROM gamify_events WHERE event_type = 'quest_complete' AND detail IN ('Q type_views', 'Q unseen_views', 'Q rate_items')").pluck().get();
  assert.strictEqual(rewards, 160);
  assert.ok(after.score >= before.score + 160);
  // Completed slots were topped back up
  assert.ok(quests.activeQuests().length >= 3);
});

test('quests: time capsule keeps the original NULL-date behaviour', () => {
  const c = raw();
  const q = () => { c.prepare("UPDATE gamify_quests SET status = 'expired'").run(); return insertQuest('time_capsule', 1, { timeCapsule: true }, 70); };
  const st = (id) => c.prepare('SELECT status FROM gamify_quests WHERE id = ?').pluck().get(id);
  const av = c.prepare("SELECT id FROM media WHERE media_type IN ('video','audio') AND user_trashed = 0 ORDER BY id").pluck().all();
  assert.ok(av.length >= 22);
  for (const id of av) set(id, { view_count: 0, processed_at: '2024-06-01 00:00:00' });
  // 20+ never-scanned (NULL date) unwatched files: the old cutoff was NULL,
  // compared as 'null', so ANY unwatched file qualified
  for (const id of av.slice(0, 20)) set(id, { processed_at: null });
  const late = av[av.length - 1];
  set(late, { processed_at: '2026-01-01 00:00:00' });
  let id = q();
  db.incrementViewCount(late); gamify.recordView(late, 200);
  assert.strictEqual(st(id), 'completed');
  // 19 NULL + one '' at the 20th: the cutoff is '', a dated file does not qualify
  set(av[0], { processed_at: '' });
  set(late, { view_count: 0 });
  id = q();
  db.incrementViewCount(late); gamify.recordView(late, 200);
  assert.strictEqual(st(id), 'active');
});

test('quests: time capsule only for the 20 oldest still-unwatched files', () => {
  const c = raw();
  c.prepare("UPDATE gamify_quests SET status = 'expired'").run();
  const q = insertQuest('time_capsule', 1, { timeCapsule: true }, 70);
  const av = c.prepare("SELECT id FROM media WHERE media_type IN ('video','audio') AND user_trashed = 0 ORDER BY id").pluck().all();
  for (const [i, id] of av.entries()) set(id, { view_count: 0, processed_at: `2020-01-${String(1 + (i % 28)).padStart(2, '0')} 00:00:${String(i % 60).padStart(2, '0')}` });
  // The newest unwatched file is not among the 20 oldest
  const newest = c.prepare("SELECT id FROM media WHERE media_type IN ('video','audio') AND user_trashed = 0 ORDER BY processed_at DESC LIMIT 1").pluck().get();
  db.incrementViewCount(newest);
  gamify.recordView(newest, 200);
  assert.strictEqual(c.prepare('SELECT status FROM gamify_quests WHERE id = ?').pluck().get(q), 'active');
  const oldest = c.prepare("SELECT id FROM media WHERE media_type IN ('video','audio') AND user_trashed = 0 AND view_count = 0 ORDER BY processed_at LIMIT 1").pluck().get();
  db.incrementViewCount(oldest);
  gamify.recordView(oldest, 200);
  assert.strictEqual(c.prepare('SELECT status FROM gamify_quests WHERE id = ?').pluck().get(q), 'completed');
});

test('tally drift (a REPLACE that skipped the delete trigger) is caught and repaired', () => {
  const c = raw();
  assert.ok(tally.install(c) >= 0);
  assert.strictEqual(tally.verify(c, { log() {} }), true);
  const row = c.prepare("SELECT filepath FROM media WHERE media_type = 'video' LIMIT 1").get();
  c.prepare("INSERT OR REPLACE INTO media (filepath, filename, media_type, view_count) VALUES (?, 'r.mp4', 'video', 9)").run(row.filepath);
  assert.notDeepStrictEqual(actualTally(), expectedTally(), 'the replaced row is still counted');
  const logs = [];
  assert.strictEqual(tally.verify(c, { log: (m) => logs.push(m) }), false);
  assert.match(logs[0], /drifted/);
  assert.strictEqual(tally.isReady(c), false);
  checkStats('drift fallback');   // readers answer from media meanwhile
  tally.installWhenIndexed(c, { log() {} });   // what the next start / unlock does
  assert.strictEqual(tally.isReady(c), true);
  assert.deepStrictEqual(actualTally(), expectedTally());
});

test('tally install retries after a failure (e.g. the file is busy)', async () => {
  const c = raw();
  c.exec("DROP TRIGGER gamify_tally_au; UPDATE gamify_cache SET value = '0' WHERE key = 'tally_schema'");
  db.close(); db.init();
  const conn = raw();
  const realTx = conn.transaction.bind(conn);
  let fail = 2;
  conn.transaction = (fn) => (fail-- > 0 ? Object.assign(() => { throw new Error('database is locked'); }, { immediate() { throw new Error('database is locked'); } }) : realTx(fn));
  const logs = [];
  tally.installWhenIndexed(conn, { log: (m) => logs.push(m), pollMs: 5 });
  await new Promise(r => setTimeout(r, 100));
  conn.transaction = realTx;
  assert.strictEqual(tally.isReady(conn), true, logs.join(' | '));
  assert.strictEqual(logs.filter(m => /will retry/.test(m)).length, 2);
  assert.deepStrictEqual(actualTally(), expectedTally());
});

test('a failed library pass is reported, and the next call starts a fresh one', async () => {
  const c = raw();
  library.reset();
  library.setSyncBudget(0);
  try {
    c.exec('ALTER TABLE media_clean RENAME TO media_clean_away');
    await assert.rejects(Promise.resolve().then(() => library.whenReady()));
    c.exec('ALTER TABLE media_clean_away RENAME TO media_clean');
    assert.ok(await library.whenReady(), 'retried');
  } finally {
    try { c.exec('ALTER TABLE media_clean_away RENAME TO media_clean'); } catch {}
    library.setSyncBudget(80);
  }
});

test('status reads stay cheap: no statement scans media', () => {
  // The planner must answer each status / per-view read from an index or the tallies.
  const c = raw();
  const id = c.prepare("SELECT id FROM media WHERE media_type = 'video' LIMIT 1").pluck().get();
  const plans = [];
  const prepare = c.prepare.bind(c);
  c.prepare = (sql) => {
    if (/\bFROM media\b/.test(sql) && !/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) {
      plans.push([sql.replace(/\s+/g, ' ').trim(), prepare('EXPLAIN QUERY PLAN ' + sql).all(...Array((sql.match(/\?/g) || []).length).fill(1)).map(r => r.detail).join(' | ')]);
    }
    return prepare(sql);
  };
  try {
    gamify.getPublicStats();
    db.incrementViewCount(id);
    gamify.recordView(id, 10);
    achievements.getAchievements();
  } finally {
    c.prepare = prepare;
  }
  assert.ok(plans.length >= 5, `the reads were seen (${plans.length})`);
  const scans = plans.filter(([, p]) => /SCAN media(?! USING (COVERING )?INDEX idx_media_(sort_processed|trashed|dupe_group))/.test(p));
  assert.deepStrictEqual(scans, []);
});
