/**
 * Library-wide counts for the filter popovers, the type bubbles, the
 * extension chips and the selection bar (SERVER_SEARCH_SPEC 4.4, 6.4, 6.6,
 * 6.7). Ports of fchipCountMaps() (player-lib/filter-chips.js),
 * renderMediaTypeBar(), buildExtensionMap() (player-lib/filters.js) and
 * buildDuplicateIndex() (player-lib/duplicates.js) at 13c23ec.
 *
 * Counts are over the whole library, not the current results, exactly as
 * before: the numbers stay put while you type. The popover counts cover the
 * grid's types (video, audio, image, gif, mix); the extension map and the
 * duplicate rule see every row, as the browser's did.
 *
 * Play stars need the browser's codec support, which the server cannot know,
 * so the server returns "playback groups" instead: row counts grouped by every
 * field mediaPlaybackState() and VaultPlaybackDecide.decide() read. The
 * browser decides once per group and adds the answers up per extension.
 */

const database = require('./database');
const libraryIndex = require('./library-index');
const { langName } = require('./lang');

const GRID_TYPES = ['video', 'audio', 'image', 'gif', 'mix'];
const GRID_IN = `(${GRID_TYPES.map(t => `'${t}'`).join(', ')})`;

/** The theme facet carries this many themes; the rest are found by search (6.9). */
const THEME_TOP = 1000;

/** Serve the last counts, marked stale, if they are younger than this. */
const STALE_OK_MS = 15 * 1000;

let cache = null;   // { db, version, indexState, at, data, themeList, themeLower, bodies }
let dupeCache = null;   // { db, version, groups, totalFiles }

/**
 * Every count reads an index, never the media table itself (13 GB at 2M
 * files, most of it descriptions and vectors): narrow (value, media_type)
 * indexes walked in GROUP BY order, and the flags' partial indexes. `hint`
 * falls back to the planner's choice while the build has not made the index.
 */
function hint(db, name) {
  const ok = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").pluck().get(name);
  return ok ? `INDEXED BY ${name}` : '';
}

// Only searchable ids (libraryIndex.validId, round 5) count anywhere here.
const VALID = libraryIndex.validId('+id');

function valueCounts(db, col, index) {
  const out = {};
  const rows = db.prepare(`SELECT ${col} AS v, count(*) AS n FROM media ${hint(db, index)}
    WHERE ${col} IS NOT NULL AND ${col} <> '' AND +media_type IN ${GRID_IN} AND ${VALID} GROUP BY ${col}`).raw().all();
  for (const [v, n] of rows) out[v] = (out[v] || 0) + n;
  return out;
}

function compute(db, indexReady) {
  const version = libraryIndex.version(db);
  const types = Object.fromEntries(GRID_TYPES.map(t => [t, 0]));
  const c = {
    total: 0, unrated: 0, r1: 0, r2: 0, r3: 0, r4: 0, r5: 0, fave: 0, notes: 0, flagged: 0,
    trashed: 0, unplayable: 0, scan_success: 0, scan_unscanned: 0,
  };
  // Type bubbles and the total: the (media_type, size) index, grouped in order.
  for (const [type, n] of db.prepare(`SELECT media_type, count(*) FROM media ${hint(db, 'idx_media_type_size')}
      WHERE media_type IN ${GRID_IN} AND ${VALID} GROUP BY media_type`).raw().iterate()) {
    types[type] = n;
    c.total += n;
  }

  // Rating rows read "3+", so a 4-star file counts towards 1+ through 4+.
  for (const [r, n] of db.prepare(`SELECT COALESCE(user_rating, 0) AS r, count(*) FROM media
      ${hint(db, 'idx_media_sort_rating')} WHERE +media_type IN ${GRID_IN} AND ${VALID} GROUP BY r`).raw().iterate()) {
    if (r === 0) c.unrated += n;
    for (let i = 1; i <= 5; i++) if (r >= i) c[`r${i}`] += n;
  }

  // Flags: each partial index holds just its rows (usually few).
  const flagCount = (key) => {
    const [index, , cond] = libraryIndex.FLAG_INDEXES[key];
    return db.prepare(`SELECT count(*) FROM media ${hint(db, index)}
      WHERE ${cond} AND +media_type IN ${GRID_IN} AND ${VALID}`).pluck().get();
  };
  c.fave = flagCount('starred');
  c.notes = flagCount('notes');
  c.flagged = flagCount('flagged');
  c.trashed = flagCount('trashed');
  c.unplayable = flagCount('failed');
  c.scan_unscanned = flagCount('unscanned');
  const scanFailed = flagCount('scanFailed');
  c.scan_success = c.total - c.scan_unscanned - scanFailed;

  // Longest grid file: walk the duration index from the top.
  const maxDurationSeconds = db.prepare(`SELECT duration_seconds FROM media ${hint(db, 'idx_media_sort_duration')}
    WHERE +media_type IN ${GRID_IN} AND duration_seconds IS NOT NULL AND ${VALID}
    ORDER BY COALESCE(duration_seconds, 0) DESC LIMIT 1`).pluck().get() || 0;

  // buildExtensionMap: every row with a type and an extension.
  const extensions = db.prepare(`SELECT media_type AS type, ext, count(*) AS count
    FROM media ${hint(db, 'idx_media_ext_type')}
    WHERE ext <> '' AND media_type IS NOT NULL AND media_type <> '' AND ${VALID} GROUP BY ext, media_type`).all();

  // Playback groups: codec columns only matter to decide() for probed
  // video/audio (mediaPlaybackState skips the verdict otherwise), so they
  // are folded away elsewhere to keep the list short.
  const pb = new Map();
  const pbRows = db.prepare(`SELECT media_type, ext, probe_version, playback_failed,
      video_codec, audio_codec, pix_fmt, codec_profile, container, count(*) AS n
    FROM media ${hint(db, 'idx_media_playback')} WHERE ${VALID}
    GROUP BY media_type, ext, probe_version, playback_failed, video_codec, audio_codec, pix_fmt, codec_profile, container`).raw();
  for (const [type, ext, probe, failed, vc, ac, pf, prof, cont, n] of pbRows.iterate()) {
    const probed = (type === 'video' || type === 'audio') && (probe || 0) >= 1;
    const g = {
      count: 0, media_type: type, ext, probed, playback_failed: failed ? 1 : 0,
      video_codec: probed ? vc : null, audio_codec: probed ? ac : null, pix_fmt: probed ? pf : null,
      codec_profile: probed ? prof : null, container: probed ? cont : null,
    };
    const key = JSON.stringify([type, ext, probed, g.playback_failed, g.video_codec, g.audio_codec, g.pix_fmt, g.codec_profile, g.container]);
    const have = pb.get(key);
    if (have) have.count += n;
    else { g.count = n; pb.set(key, g); }
  }

  // Language by display name (the dropdown carries names).
  const language = {};
  for (const [raw, n] of db.prepare(`SELECT language, count(*) FROM media ${hint(db, 'idx_media_language_type')}
      WHERE +media_type IN ${GRID_IN} AND ${VALID} GROUP BY language`).raw().iterate()) {
    const name = langName(raw);
    language[name] = (language[name] || 0) + n;
  }

  // Themes: the themes index's own vocabulary, one hex token per theme with
  // the number of (grid) rows that carry it. The response carries the top
  // THEME_TOP; the full list stays here for the theme search route (6.9).
  let theme = null;
  let themeList = null;
  if (indexReady) {
    themeList = [];
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.media_themes_vocab USING fts5vocab(main, 'media_search_themes', 'row')");
    for (const [hex, n] of db.prepare('SELECT term, doc FROM temp.media_themes_vocab').raw().iterate()) {
      themeList.push([Buffer.from(hex, 'hex').toString('utf8'), n]);
    }
    themeList.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    theme = Object.fromEntries(themeList.slice(0, THEME_TOP));
  }

  // isDuplicate(): another row, any state, with the same type and non-zero size.
  const dupes = db.prepare(`SELECT COALESCE(sum(n), 0) FROM (
      SELECT count(*) AS n FROM media ${hint(db, 'idx_media_type_size')}
      WHERE media_type IN ${GRID_IN} AND COALESCE(filesize_bytes, 0) <> 0 AND ${VALID}
      GROUP BY media_type, filesize_bytes HAVING count(*) >= 2)`).pluck().get();

  const data = {
    version,
    stale: false,
    indexState: indexReady ? 'ready' : 'building',
    total: c.total,
    types,
    extensions,
    playbackGroups: [...pb.values()],
    content: valueCounts(db, 'content_type', 'idx_media_content_type'),
    language,
    quality: valueCounts(db, 'quality_flag', 'idx_media_quality_type'),
    theme,
    themeTotal: themeList ? themeList.length : null,
    rating: { unrated: c.unrated, 1: c.r1, 2: c.r2, 3: c.r3, 4: c.r4, 5: c.r5 },
    fave: c.fave,
    notes: c.notes,
    flagged: c.flagged,
    trashed: c.trashed,
    unplayable: c.unplayable,
    dupes,
    scan: { success: c.scan_success, failed: c.total - c.scan_success - c.scan_unscanned, unscanned: c.scan_unscanned },
    maxDurationSeconds,
  };
  return { data, themeList };
}

/**
 * The current facets entry: { data, stale, themeList, body() }. Cached per
 * library version; if the version moved less than 15 s after the last count,
 * the old counts are served marked stale (a scan bumps the version every
 * second). The JSON body is serialized once per entry and kept as a Buffer:
 * at 2M files re-serializing it cost hundreds of ms per request.
 */
function current({ now = Date.now() } = {}) {
  const db = database.get();
  const version = libraryIndex.version(db);
  const indexState = libraryIndex.status(db).state === 'ready' ? 'ready' : 'building';
  if (cache && cache.db === db && cache.indexState === indexState) {
    if (cache.version === version) return { entry: cache, stale: false };
    if (now - cache.at < STALE_OK_MS) return { entry: cache, stale: true };
  }
  const { data, themeList } = compute(db, indexState === 'ready');
  cache = { db, version, indexState, at: now, data, themeList, bodies: {} };
  return { entry: cache, stale: false };
}

/** GET /api/library/facets (spec 6.4) as an object. */
async function facets(opts) {
  const { entry, stale } = current(opts);
  return stale ? { ...entry.data, stale: true } : entry.data;
}

/** The same, serialized: { body: Buffer, etag }. */
async function facetsBody(opts) {
  const { entry, stale } = current(opts);
  const key = stale ? 'stale' : 'fresh';
  if (!entry.bodies[key]) {
    const data = stale ? { ...entry.data, stale: true } : entry.data;
    entry.bodies[key] = {
      body: Buffer.from(JSON.stringify(data)),
      etag: `"facets-${entry.version}-${entry.indexState}-${key}"`,
    };
  }
  return entry.bodies[key];
}

/**
 * GET /api/library/themes (spec 6.9): themes whose value contains q (any
 * case), most used first, then A to Z. Null while the index builds.
 */
async function themes({ q = '', limit = 50 } = {}) {
  const { entry } = current();
  if (!entry.themeList) return { themes: null, indexState: 'building' };
  if (!entry.themeLower) entry.themeLower = entry.themeList.map(([v]) => v.toLowerCase());
  const needle = String(q).toLowerCase();
  const out = [];
  for (let i = 0; i < entry.themeList.length && out.length < limit; i++) {
    if (!needle || entry.themeLower[i].includes(needle)) out.push({ value: entry.themeList[i][0], count: entry.themeList[i][1] });
  }
  return { version: entry.version, themes: out };
}

/**
 * POST /api/library/ids-summary (spec 6.6): counts for a big selection.
 * The ids go into a TEMP table first. A big selection (select all at 2M)
 * is then counted by walking the processed sort index, which carries every
 * column needed, instead of looking each row up in the media table.
 */
const tuning = { summaryWalkMin: 50000 };   // tests set 0 to exercise the walk
let summarySeq = 0;
async function idsSummary(ids) {
  const db = database.get();
  const out = { count: 0, trashed: 0, flagged: 0, scan: { success: 0, failed: 0, unscanned: 0 }, types: {} };
  const table = `temp.lq_summary_${++summarySeq}`;
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
  try {
    const fill = db.prepare(`INSERT OR IGNORE INTO ${table} (id) SELECT value FROM json_each(?)`);
    const CHUNK = 50000;
    for (let i = 0; i < ids.length; i += CHUNK) {
      fill.run(JSON.stringify(Array.from(ids.subarray ? ids.subarray(i, i + CHUNK) : ids.slice(i, i + CHUNK))));
    }
    const walk = ids.length >= tuning.summaryWalkMin ? hint(db, 'idx_media_sort_processed') : '';
    const rows = db.prepare(`SELECT media_type, count(*) AS n,
        sum(COALESCE(user_trashed, 0) <> 0) AS trashed,
        sum(COALESCE(user_flagged_delete, 0) <> 0) AS flagged,
        sum((${libraryIndex.SCAN_STATE}) = 0) AS ok, sum((${libraryIndex.SCAN_STATE}) = 1) AS unscanned
      FROM media ${walk} WHERE id IN ${table} AND ${VALID} GROUP BY media_type`).all();
    for (const r of rows) {
      out.count += r.n;
      out.trashed += r.trashed;
      out.flagged += r.flagged;
      out.scan.success += r.ok;
      out.scan.unscanned += r.unscanned;
      out.scan.failed += r.n - r.ok - r.unscanned;
      const t = r.media_type ?? '';
      out.types[t] = (out.types[t] || 0) + r.n;
    }
  } finally {
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  return out;
}

/**
 * GET /api/library/duplicates (spec 6.7). Groups in the order the browser's
 * duplicate index built them: by the first member's filepath, members in
 * filepath order.
 */
async function duplicates({ offset = 0, limit = 100 } = {}) {
  const db = database.get();
  const version = libraryIndex.version(db);
  if (!dupeCache || dupeCache.db !== db || dupeCache.version !== version) {
    const byKey = new Map();
    let totalFiles = 0;
    const rows = db.prepare(`SELECT m.id, m.media_type, m.filesize_bytes FROM media m
      JOIN (SELECT media_type, filesize_bytes FROM media
            WHERE COALESCE(filesize_bytes, 0) <> 0 AND COALESCE(media_type, '') <> '' AND ${VALID}
            GROUP BY media_type, filesize_bytes HAVING count(*) >= 2) g
        ON g.media_type = m.media_type AND g.filesize_bytes = m.filesize_bytes
      WHERE ${libraryIndex.validId('+m.id')}
      ORDER BY m.filepath`).raw().iterate();
    for (const [id, type, size] of rows) {
      const key = `${type}:${size}`;
      let g = byKey.get(key);
      if (!g) byKey.set(key, g = { media_type: type, filesize_bytes: size, ids: [] });
      g.ids.push(id);
      totalFiles++;
    }
    dupeCache = { db, version, groups: [...byKey.values()], totalFiles };
  }
  const { groups, totalFiles } = dupeCache;
  return { totalGroups: groups.length, totalFiles, groups: groups.slice(offset, offset + limit) };
}

/**
 * GET /api/library/trash-summary (spec 6.10): what Empty trash will delete.
 * Every trashed row, documents included (the facets count only the grid's
 * types), with exactly the condition POST /api/trash/empty selects by (no
 * valid-id filter here: the confirm must equal what is deleted).
 */
async function trashSummary() {
  const db = database.get();
  const r = db.prepare(`SELECT count(*) AS count, COALESCE(sum(COALESCE(filesize_bytes, 0)), 0) AS bytes
    FROM media WHERE user_trashed = 1`).get();
  return { count: r.count, bytes: r.bytes };
}

function reset() { cache = null; dupeCache = null; }

module.exports = { facets, facetsBody, themes, idsSummary, duplicates, trashSummary, reset, STALE_OK_MS, THEME_TOP, _tuning: tuning };
