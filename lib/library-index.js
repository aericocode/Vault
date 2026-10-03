/**
 * Library search indexes: schema, sync triggers, library version, and the
 * background build (SERVER_SEARCH_SPEC sections 5.1 to 5.4).
 *
 * Everything lives inside the library file, next to `media`:
 *   media.ext              VIRTUAL generated column, the browser's getExtension()
 *   media_search_names     FTS5 trigram over the name fields (contains-anywhere)
 *   media_search_text      FTS5 unicode61 over every searchable field (word starts)
 *   media_search_themes    FTS5 over each file's themes, one token per theme, for
 *                          the Theme filter and its counts
 *   library_meta           version counter + build bookkeeping
 *
 * Triggers are pure SQL on purpose. They fire in EVERY connection that writes
 * the file: this server, a CLI scan in another process, an older Vault. A
 * trigger that called a JS-registered function would make those writes fail.
 * For the same reason every json_each is guarded, so a malformed themes value
 * indexes as "no themes" instead of failing the write.
 *
 * ensureSchema() runs inside db.init() and is fast (DDL only). The expensive
 * parts, the sort/filter indexes (INDEXES) and filling the search tables for
 * rows that predate them, are the background build the server starts after
 * boot (startBuild below); the triggers already cover every write made while
 * it runs, and the build itself is idempotent per row.
 */

/** Bump to force a full rebuild of the search tables on next server start. */
const SEARCH_SCHEMA = 2;

/**
 * Media ids per build batch, one transaction each, the event loop in between.
 * The spec suggested about 2,000; measured, a 2,000-row batch of long
 * descriptions takes over 200 ms on its own, so the build starts smaller and
 * sizes batches to take about BATCH_TARGET_MS each (a request waits at most
 * about one batch).
 */
const BUILD_BATCH = 500;
const BATCH_TARGET_MS = 80;
const BATCH_MIN = 50;
const BATCH_MAX = 5000;

/** FTS5 incremental merge: pages per step, and a cap on steps per table. */
const MERGE_PAGES = 200;
const MERGE_MAX_STEPS = 100000;

// ── Shared SQL fragments ───────────────────────────────────────────────────

/**
 * getExtension(filename) in pure SQL: lowercase text after the last dot, ''
 * when there is no dot or the name ends with one. rtrim() with the set of
 * every non-dot character strips back to the last dot. lower() folds ASCII
 * only (JS toLowerCase folds everything), so a non-ASCII extension keeps its
 * case here; no real extension is affected.
 */
const EXT_EXPR = `CASE WHEN instr(filename, '.') = 0 THEN ''
  ELSE lower(substr(filename, length(rtrim(filename, replace(filename, '.', ''))) + 1)) END`;

/**
 * The themes the Theme filter and facet read: the clean copy, the raw column
 * for rows `node vault.js clean` has not reached (the browser's
 * `themes_clean || themes`). Only a JSON array yields values, only its string
 * elements count, and only grid rows are indexed.
 */
/**
 * Searchable ids (round 5): 1 to 4294967295. Result id lists are Uint32 (spec
 * 2), so an id outside that range could only come back as a different, valid
 * looking id. SQLite allows any 64-bit rowid; such rows are never indexed for
 * search (triggers, build and repair skip them) and every query, facet and id
 * list leaves them out. Vault itself only ever creates ids from 1 up.
 */
const ID_MAX = 4294967295;
const validId = (x) => `${x} BETWEEN 1 AND ${ID_MAX}`;

function themesInsert(idExpr, cleanExpr, rawExpr, typeExpr) {
  return `INSERT INTO media_search_themes (rowid, themes)
    SELECT ${idExpr}, tok FROM (SELECT ${themeTokens(themesSource(cleanExpr, rawExpr))} AS tok)
    WHERE tok <> '' AND ${validId(idExpr)} AND ${typeExpr} IN ${GRID_IN};`;
}

/**
 * A file's themes as FTS tokens: each theme hex-encoded (UTF-8 bytes), so a
 * whole theme, spaces and punctuation included, is exactly one token and a
 * phrase query for it is an exact match. NULL or '' when there are none.
 */
function themeTokens(x) {
  return `(SELECT group_concat(hex(j.value), ' ') FROM json_each(${jsonArray(x)}) j WHERE j.type = 'text')`;
}

/**
 * The grid's types. Only these rows are in media_search_themes: the Theme
 * filter and its counts only ever look at the grid.
 */
const GRID_IN = "('video', 'audio', 'image', 'gif', 'mix')";

function themesSource(cleanExpr, rawExpr) {
  return `COALESCE(NULLIF(${cleanExpr}, ''), NULLIF(${rawExpr}, ''))`;
}

/** x when it is a JSON array, else '[]'. CASE is lazy, so json_type never sees bad JSON. */
function jsonArray(x) {
  return `CASE WHEN json_valid(${x}) THEN CASE WHEN json_type(${x}) = 'array' THEN ${x} ELSE '[]' END ELSE '[]' END`;
}

const NAME_COLS = ['filename', 'filepath', 'tags', 'themes'];
const TEXT_COLS = ['filename', 'filepath', 'tags', 'themes', 'description', 'media_elements',
  'transcribed_text', 'content_type', 'language', 'user_notes', 'subtitle_en'];

/**
 * Media columns whose change can alter a result, a facet, a sort order other
 * than Views / Session ends, or what a tile shows. Playback telemetry (views,
 * done, hot, positions, heatmaps) and embeddings are deliberately absent, so
 * watching something never re-runs the viewer's query.
 */
const VERSION_COLUMNS = [
  'filepath', 'filename', 'media_type', 'duration_seconds', 'filesize_bytes', 'language',
  'themes', 'explicit', 'locations', 'quality_flag', 'description', 'tags', 'content_type',
  'media_elements', 'transcribed_text', 'processing_error', 'processed_at', 'user_notes',
  'user_starred', 'user_rating', 'user_flagged_delete', 'user_trashed', 'playback_failed',
  'dupe_group', 'subtitle_en', 'probe_version', 'video_codec', 'audio_codec', 'container',
  'pix_fmt', 'codec_profile', 'codec_level', 'thumbnail_path', 'thumb_version',
];

const BUMP = `UPDATE library_meta SET value = value + 1 WHERE key = 'version';`;

const changed = (cols) => cols.map(c => `old.${c} IS NOT new.${c}`).join(' OR ');

function insertSearchRows(prefix) {
  const v = (cols) => cols.map(c => `${prefix}.${c}`).join(', ');
  return `
    INSERT INTO media_search_names (rowid, ${NAME_COLS.join(', ')}) SELECT ${prefix}.id, ${v(NAME_COLS)} WHERE ${validId(prefix + '.id')};
    INSERT INTO media_search_text (rowid, ${TEXT_COLS.join(', ')}) SELECT ${prefix}.id, ${v(TEXT_COLS)} WHERE ${validId(prefix + '.id')};`;
}

/**
 * Sort keys (spec 4.3): the browser's comparator values as SQL, and the
 * direction each key's index serves without sorting ("native"). Ties always
 * fall back to filepath ASC, the browser's array order. lib/library-query.js
 * builds its ORDER BY from these same strings, which is what lets the
 * planner match them to the expression indexes below.
 */
const SORT_FIELDS = {
  processed: { expr: "COALESCE(processed_at, '')", native: 'desc' },
  name: { expr: 'filename COLLATE NOCASE', native: 'asc' },
  size: { expr: 'COALESCE(filesize_bytes, 0)', native: 'desc' },
  duration: { expr: 'COALESCE(duration_seconds, 0)', native: 'desc' },
  rating: { expr: 'COALESCE(user_rating, 0)', native: 'desc' },
  views: { expr: 'COALESCE(view_count, 0)', native: 'desc' },
  done: { expr: 'COALESCE(done_count, 0)', native: 'desc' },
};

/**
 * Two filter values as indexable expressions. CASE (not a bare AND/OR) so
 * the planner matches them whole against the index column; lib/library-query.js
 * writes its WHERE terms with these exact strings.
 *   NOTES_FLAG  1 when user_notes holds something (not NULL, '', '[]')
 *   SCAN_STATE  0 success, 1 unscanned, 2 failed (the browser's scanStatusOf)
 */
const NOTES_FLAG = "CASE WHEN user_notes IS NOT NULL AND user_notes <> '' AND user_notes <> '[]' THEN 1 ELSE 0 END";
const SCAN_STATE = "CASE WHEN processing_error IS NULL OR processing_error = '' THEN 0 WHEN processing_error = 'unscanned' THEN 1 ELSE 2 END";

/**
 * Sort indexes. Each is (key, filepath) with filepath stored opposite to the
 * key's native direction, so one walk yields "key <native>, filepath ASC"
 * with no sort step: backwards for the DESC-native keys, forwards for Name.
 *
 * Every column a filter reads rides along (COVER), so any filter combination
 * is answered by walking one index in result order without touching the
 * media table. At 2M files the table is 13 GB and a lookup per row costs
 * seconds for a full id list; the index walk costs a fraction of one. The
 * price is disk: each sort index is about the size of the path column again
 * plus the filter columns (1.75 GB for all seven at 2M files, measured).
 */
const COVER = ['media_type', 'user_trashed', 'user_starred', 'user_rating', 'user_flagged_delete',
  'playback_failed', NOTES_FLAG, SCAN_STATE, 'duration_seconds', 'filesize_bytes', 'ext',
  'content_type', 'quality_flag', 'language'].join(', ');

/**
 * Partial indexes holding only the rows a flag filter asks for. These are
 * usually few (a handful of starred or flagged files in two million), and a
 * walk of a sort index finds few matches only after reading all of it, so
 * lib/library-query.js reads a small set from here instead. Their WHERE
 * text must match the query's exactly.
 */
const FLAG_INDEXES = {
  starred: ['idx_media_flag_starred', 'media_type', 'COALESCE(user_starred, 0) <> 0'],
  flagged: ['idx_media_flag_flagged', 'media_type', 'COALESCE(user_flagged_delete, 0) <> 0'],
  failed: ['idx_media_flag_failed', 'media_type', 'COALESCE(playback_failed, 0) <> 0'],
  trashed: ['idx_media_flag_trashed', 'media_type', 'COALESCE(user_trashed, 0) <> 0'],
  notes: ['idx_media_flag_notes', 'media_type', `(${NOTES_FLAG}) = 1`],
  unscanned: ['idx_media_flag_unscanned', 'media_type', `(${SCAN_STATE}) = 1`],
  scanFailed: ['idx_media_flag_scanfailed', 'media_type', `(${SCAN_STATE}) = 2`],
};

/**
 * Narrow indexes for the facet counts (each GROUP BY walks one in order), the
 * duplicate rule, and the small-set lookups of lib/library-query.js.
 */
const INDEXES = [
  ...Object.entries(SORT_FIELDS).map(([field, { expr, native }]) => [
    `idx_media_sort_${field}`,
    `media(${expr}, filepath ${native === 'desc' ? 'DESC' : 'ASC'}, ${COVER})`,
  ]),
  ['idx_media_type_size', 'media(media_type, filesize_bytes)'],
  ['idx_media_ext_type', 'media(ext, media_type)'],
  ['idx_media_language_type', 'media(language, media_type)'],
  ['idx_media_content_type', 'media(content_type, media_type)'],
  ['idx_media_quality_type', 'media(quality_flag, media_type)'],
  ['idx_media_playback', 'media(media_type, ext, probe_version, playback_failed, video_codec, audio_codec, pix_fmt, codec_profile, container)'],
  ...Object.values(FLAG_INDEXES).map(([name, col, where]) => [name, `media(${col}) WHERE ${where}`]),
];

// ── Schema ─────────────────────────────────────────────────────────────────

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

/**
 * Create the search tables, triggers and meta rows (idempotent, DDL only).
 * Called from db.init() after the media migrations. Returns true when the
 * search tables were created just now (the caller does not need it; the
 * build decides for itself from library_meta).
 */
function ensureSchema(db) {
  const hasExt = db.prepare('PRAGMA table_xinfo(media)').all().some(c => c.name === 'ext');
  if (!hasExt) {
    db.exec(`ALTER TABLE media ADD COLUMN ext TEXT GENERATED ALWAYS AS (${EXT_EXPR}) VIRTUAL`);
  }

  // media_songs is owned by the music module, which creates it lazily. The
  // version trigger below needs it to exist, so make sure it does.
  if (!tableExists(db, 'media_songs')) require('./musicid/repo').ensureSchema(db);

  const created = !tableExists(db, 'media_search_names');

  db.exec(`
    CREATE TABLE IF NOT EXISTS library_meta (key TEXT PRIMARY KEY, value);
    INSERT OR IGNORE INTO library_meta (key, value) VALUES ('version', 1);
    INSERT OR IGNORE INTO library_meta (key, value) VALUES ('search_schema', 0);
    INSERT OR IGNORE INTO library_meta (key, value) VALUES ('search_built', 0);

    CREATE VIRTUAL TABLE IF NOT EXISTS media_search_names USING fts5(
      ${NAME_COLS.join(', ')},
      content='', contentless_delete=1,
      tokenize='trigram case_sensitive 0 remove_diacritics 1');
    CREATE VIRTUAL TABLE IF NOT EXISTS media_search_text USING fts5(
      ${TEXT_COLS.join(', ')},
      content='', contentless_delete=1,
      tokenize='unicode61 remove_diacritics 2');

    -- Themes as tokens (see themeTokens). An FTS table rather than a
    -- (term, media) b-tree: filling a b-tree in id order writes its pages at
    -- random, which made the first build 2.5x slower at 2M files, where FTS
    -- writes sequential segments. detail=none: only "which rows", no positions.
    CREATE VIRTUAL TABLE IF NOT EXISTS media_search_themes USING fts5(
      themes, content='', contentless_delete=1, detail=none,
      tokenize='unicode61 remove_diacritics 0');
  `);

  // Triggers are versioned: a changed body replaces the old one (CREATE
  // TRIGGER IF NOT EXISTS alone would keep a stale copy forever).
  if (Number(getMeta(db, 'trigger_schema')) !== TRIGGER_SCHEMA) {
    db.transaction(() => {
      for (const name of db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (" +
        TRIGGER_NAMES.map(() => '?').join(', ') + ')').pluck().all(...TRIGGER_NAMES)) {
        db.exec(`DROP TRIGGER ${name}`);
      }
      db.exec(triggerSql());
      setMeta(db, 'trigger_schema', TRIGGER_SCHEMA);
    })();
  }

  if (created) {
    if (db.prepare('SELECT 1 FROM media LIMIT 1').get()) {
      // A library that already had rows when the tables appeared needs a build.
      setMeta(db, 'search_built', 0);
    } else {
      // A new, empty library: the triggers index every row from the first
      // one, and the sort indexes cost nothing to create now.
      for (const ix of INDEXES) createIndex(db, ix);
      setMeta(db, 'search_schema', SEARCH_SCHEMA);
      setMeta(db, 'search_built', 1);
    }
  }
  return created;
}

/** Bump when a trigger body changes; ensureSchema() then replaces them all. */
const TRIGGER_SCHEMA = 4;   // 4: ids outside 1..4294967295 are not indexed (round 5)

const TRIGGER_NAMES = [
  'media_search_ai', 'media_search_ad', 'media_search_au', 'media_search_aid', 'media_themes_au', 'media_terms_au',
  'media_clean_terms_ai', 'media_clean_terms_au', 'media_clean_version_au', 'media_clean_terms_ad',
  'media_version_ai', 'media_version_ad', 'media_version_au',
  'collection_items_version_ai', 'collection_items_version_ad', 'collection_items_version_au',
  'collections_version_au', 'collections_version_ad',
  'media_songs_version_ai', 'media_songs_version_ad', 'media_songs_version_au',
];

function triggerSql() {
  const cleanOf = (id) => `(SELECT themes FROM media_clean WHERE media_id = ${id})`;
  const rawOf = (id) => `(SELECT themes FROM media WHERE id = ${id})`;
  const typeOf = (id) => `(SELECT media_type FROM media WHERE id = ${id})`;
  return `
    -- Search tables follow every insert, delete and text change.
    CREATE TRIGGER media_search_ai AFTER INSERT ON media BEGIN
      ${insertSearchRows('new')}
      DELETE FROM media_search_themes WHERE rowid = new.id;
      ${themesInsert('new.id', cleanOf('new.id'), 'new.themes', 'new.media_type')}
    END;
    CREATE TRIGGER media_search_ad AFTER DELETE ON media BEGIN
      DELETE FROM media_search_names WHERE rowid = old.id;
      DELETE FROM media_search_text WHERE rowid = old.id;
      DELETE FROM media_search_themes WHERE rowid = old.id;
    END;
    -- Every UPDATE trigger has a WHEN: an update that changes nothing (a
    -- re-run of vault clean, a re-save) must cost nothing. An id change is
    -- handled whole by media_search_aid, so the others skip it.
    CREATE TRIGGER media_search_au AFTER UPDATE OF ${TEXT_COLS.join(', ')} ON media
    WHEN old.id = new.id AND (${changed(TEXT_COLS)}) BEGIN
      DELETE FROM media_search_names WHERE rowid = old.id;
      DELETE FROM media_search_text WHERE rowid = old.id;
      ${insertSearchRows('new')}
    END;
    CREATE TRIGGER media_search_aid AFTER UPDATE OF id ON media
    WHEN old.id IS NOT new.id BEGIN
      DELETE FROM media_search_names WHERE rowid = old.id;
      DELETE FROM media_search_text WHERE rowid = old.id;
      DELETE FROM media_search_themes WHERE rowid = old.id;
      DELETE FROM media_search_names WHERE rowid = new.id;
      DELETE FROM media_search_text WHERE rowid = new.id;
      DELETE FROM media_search_themes WHERE rowid = new.id;
      ${insertSearchRows('new')}
      ${themesInsert('new.id', cleanOf('new.id'), 'new.themes', 'new.media_type')}
    END;
    CREATE TRIGGER media_themes_au AFTER UPDATE OF themes, media_type ON media
    WHEN old.id = new.id AND (old.themes IS NOT new.themes OR old.media_type IS NOT new.media_type) BEGIN
      DELETE FROM media_search_themes WHERE rowid = new.id;
      ${themesInsert('new.id', cleanOf('new.id'), 'new.themes', 'new.media_type')}
    END;

    -- The clean copy wins over the raw column, so its changes rebuild terms.
    -- (A media_clean row without a media row gets none: its type is NULL.)
    CREATE TRIGGER media_clean_terms_ai AFTER INSERT ON media_clean BEGIN
      DELETE FROM media_search_themes WHERE rowid = new.media_id;
      ${themesInsert('new.media_id', 'new.themes', rawOf('new.media_id'), typeOf('new.media_id'))}
      ${BUMP}
    END;
    CREATE TRIGGER media_clean_terms_au AFTER UPDATE ON media_clean
    WHEN old.themes IS NOT new.themes OR old.media_id IS NOT new.media_id BEGIN
      DELETE FROM media_search_themes WHERE rowid = old.media_id;
      DELETE FROM media_search_themes WHERE rowid = new.media_id;
      ${themesInsert('new.media_id', 'new.themes', rawOf('new.media_id'), typeOf('new.media_id'))}
    END;
    -- The clean tags and locations show on tiles, so they change the version too.
    CREATE TRIGGER media_clean_version_au AFTER UPDATE ON media_clean
    WHEN old.themes IS NOT new.themes OR old.tags IS NOT new.tags
      OR old.locations IS NOT new.locations OR old.media_id IS NOT new.media_id BEGIN
      ${BUMP}
    END;
    CREATE TRIGGER media_clean_terms_ad AFTER DELETE ON media_clean BEGIN
      DELETE FROM media_search_themes WHERE rowid = old.media_id;
      ${themesInsert('old.media_id', 'NULL', rawOf('old.media_id'), typeOf('old.media_id'))}
      ${BUMP}
    END;

    -- Library version (spec 5.4): anything that can change a result.
    CREATE TRIGGER media_version_ai AFTER INSERT ON media BEGIN ${BUMP} END;
    CREATE TRIGGER media_version_ad AFTER DELETE ON media BEGIN ${BUMP} END;
    CREATE TRIGGER media_version_au AFTER UPDATE OF id, ${VERSION_COLUMNS.join(', ')} ON media
    WHEN old.id IS NOT new.id OR ${changed(VERSION_COLUMNS)} BEGIN ${BUMP} END;
    CREATE TRIGGER collection_items_version_ai AFTER INSERT ON collection_items BEGIN ${BUMP} END;
    CREATE TRIGGER collection_items_version_ad AFTER DELETE ON collection_items BEGIN ${BUMP} END;
    CREATE TRIGGER collection_items_version_au AFTER UPDATE ON collection_items
    WHEN old.position IS NOT new.position OR old.collection_id IS NOT new.collection_id
      OR old.media_id IS NOT new.media_id BEGIN ${BUMP} END;
    CREATE TRIGGER collections_version_au AFTER UPDATE OF parent_id, kind ON collections
    WHEN old.parent_id IS NOT new.parent_id OR old.kind IS NOT new.kind BEGIN ${BUMP} END;
    CREATE TRIGGER collections_version_ad AFTER DELETE ON collections BEGIN ${BUMP} END;
    CREATE TRIGGER media_songs_version_ai AFTER INSERT ON media_songs BEGIN ${BUMP} END;
    CREATE TRIGGER media_songs_version_ad AFTER DELETE ON media_songs BEGIN ${BUMP} END;
    CREATE TRIGGER media_songs_version_au AFTER UPDATE OF media_id, song_id ON media_songs
    WHEN old.media_id IS NOT new.media_id OR old.song_id IS NOT new.song_id BEGIN ${BUMP} END;
  `;
}

/**
 * Sort/filter indexes that do not exist yet. Kept out of ensureSchema (so no
 * CLI command pays for them): the server creates them at startup, before it
 * listens (createMissingIndexes). Each is one statement that blocks for 2 to
 * 12 s at 2M files and cannot be split; done in the background they froze a
 * listening server for about two minutes.
 */
function missingIndexes(db) {
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(r => r.name));
  return INDEXES.filter(([name]) => !have.has(name));
}

function createIndex(db, [name, on]) {
  db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${on}`);
}

/**
 * The plain-index step run after an unlock (spec 6.5, round 3): the same
 * indexes, one statement per event-loop turn, so the unlock response goes out
 * first and requests are answered between statements. Each statement still
 * blocks while it runs (25 to 36 s at 2M on an encrypted file, nothing to be
 * done about one CREATE INDEX), which is why the viewer polls /version with
 * no timeout and retries. Status reads 'preparing', step N of steps.
 * Stops (returns null) when getDb() goes away (a lock).
 */
// run: whose state this is (round 5). A newer markPreparing or run takes it
// over; an older run then stops and never touches the shared state again.
const prep = { step: 0, steps: 0, run: 0 };
let prepRuns = 0;
/**
 * Report 'preparing' (step 0 of N) from the moment the step is scheduled,
 * not only once it starts (round 4); prepareIndexesAsync clears it however
 * it ends.
 */
function markPreparing(db) {
  const n = db && db.open ? missingIndexes(db).length : 0;
  prep.run = ++prepRuns;
  prep.step = 0;
  prep.steps = n;
  return n;
}
async function prepareIndexesAsync(getDb, { log = console.log } = {}) {
  const run = ++prepRuns;
  prep.run = run;
  const mine = () => prep.run === run;
  try {
    const db0 = getDb();
    if (!db0 || !db0.open) return null;
    const todo = missingIndexes(db0);
    if (!todo.length) return [];
    const done = [];
    prep.steps = todo.length;
    for (const [i, ix] of todo.entries()) {
      prep.step = i + 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      if (!mine() || getDb() !== db0 || !db0.open) return null;
      log(`  Preparing the library for search (one time): ${i + 1} of ${todo.length}`);
      const t0 = Date.now();
      createIndex(db0, ix);
      done.push([ix[0], Date.now() - t0]);
    }
    return done;
  } finally {
    if (mine()) {
      prep.step = 0;
      prep.steps = 0;
    }
  }
}

/**
 * Create every missing sort/filter index now, synchronously, with one
 * progress line per index. Returns [[name, ms], ...].
 */
function createMissingIndexes(db, { log = console.log } = {}) {
  const todo = missingIndexes(db);
  const done = [];
  todo.forEach((ix, i) => {
    log(`  Preparing the library for search (one time): ${i + 1} of ${todo.length}`);
    const t0 = Date.now();
    createIndex(db, ix);
    done.push([ix[0], Date.now() - t0]);
  });
  return done;
}

// ── Meta ───────────────────────────────────────────────────────────────────

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM library_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare('INSERT INTO library_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** The library version (spec 5.4): one indexed read. */
function version(db) {
  return Number(getMeta(db, 'version')) || 0;
}

// ── Background build (spec 5.3) ───────────────────────────────────────────

/**
 * Why the search tables need a full build now, or null when they are built.
 * A schema bump starts over; a build cut short (lock, restart) resumes. Drift
 * in a built library (writes that bypassed the triggers) is not a reason to
 * rebuild: repair() fixes just those rows.
 */
function buildReason(db) {
  if (Number(getMeta(db, 'search_schema')) < SEARCH_SCHEMA) return 'schema';
  if (Number(getMeta(db, 'search_built')) !== 1) return 'resume';
  return null;
}

/** Index one id range (lo, hi]: drop whatever is there, then insert. */
function indexRange(db, lo, hi) {
  lo = Math.max(lo, 0);
  hi = Math.min(hi, ID_MAX);
  if (hi <= lo) return;
  const stale = db.prepare('SELECT id FROM media_search_names_docsize WHERE id > ? AND id <= ?').pluck().all(lo, hi);
  const staleText = db.prepare('SELECT id FROM media_search_text_docsize WHERE id > ? AND id <= ?').pluck().all(lo, hi);
  const delNames = db.prepare('DELETE FROM media_search_names WHERE rowid = ?');
  const delText = db.prepare('DELETE FROM media_search_text WHERE rowid = ?');
  for (const id of stale) delNames.run(id);
  for (const id of staleText) delText.run(id);
  const staleThemes = db.prepare('SELECT id FROM media_search_themes_docsize WHERE id > ? AND id <= ?').pluck().all(lo, hi);
  const delThemes = db.prepare('DELETE FROM media_search_themes WHERE rowid = ?');
  for (const id of staleThemes) delThemes.run(id);
  db.prepare(`INSERT INTO media_search_names (rowid, ${NAME_COLS.join(', ')})
    SELECT id, ${NAME_COLS.join(', ')} FROM media WHERE id > ? AND id <= ?`).run(lo, hi);
  db.prepare(`INSERT INTO media_search_text (rowid, ${TEXT_COLS.join(', ')})
    SELECT id, ${TEXT_COLS.join(', ')} FROM media WHERE id > ? AND id <= ?`).run(lo, hi);
  // Unary + on media_type: with the type index present, the planner would
  // otherwise walk every grid row of the library for each batch.
  db.prepare(`INSERT INTO media_search_themes (rowid, themes)
    SELECT id, tok FROM (
      SELECT m.id, ${themeTokens(themesSource('mc.themes', 'm.themes'))} AS tok
      FROM media m LEFT JOIN media_clean mc ON mc.media_id = m.id
      WHERE m.id > ? AND m.id <= ? AND +m.media_type IN ${GRID_IN})
    WHERE tok <> ''`).run(lo, hi);
}

/**
 * The one build in flight (per process). Progress is processed / count at
 * start; `phase` says what the build is doing ('search', 'optimize',
 * 'repair') so a stall can be told apart from progress.
 */
const state = {
  running: false,
  stopRequested: false,
  progress: null,
  phase: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  stats: null,
};

function status(db) {
  let built = false;
  try { built = db && Number(getMeta(db, 'search_built')) === 1; } catch { built = false; }
  let exists = false;
  try { exists = !!db && tableExists(db, 'media_search_names'); } catch { exists = false; }
  // Search is usable as soon as the batches are done (built = 1); the segment
  // merge after them and a repair pass change speed or a few rows, not
  // availability. A schema-bump rebuild clears built before anything else.
  const building = (exists && !built && !state.error) || (state.running && state.phase === 'search');
  // The plain-index step after an unlock comes before everything else.
  const stateName = prep.steps ? 'preparing' : building ? 'building' : built ? 'ready' : 'missing';
  return {
    state: stateName,
    progress: stateName === 'building' ? (state.progress ?? 0) : null,
    step: prep.steps ? prep.step : null,
    steps: prep.steps || null,
    phase: state.running ? state.phase : null,
    error: state.error,
    stats: state.stats,
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * Build whatever is missing, in the background. `getDb` returns the live
 * connection (it changes across a lock/unlock); a closed or swapped
 * connection, or stop(), ends the run cleanly, and the next startBuild()
 * resumes from the start (the build is idempotent per row). Resolves with the
 * run's stats, or null when nothing needed doing or the run was stopped.
 */
async function startBuild(getDb, { log = console.log, batch = null } = {}) {
  if (state.running) return null;
  const db0 = getDb();
  if (!db0 || !db0.open) return null;
  const reason = buildReason(db0);
  // A schema bump makes search unavailable from this moment, not just once
  // the old tables are wiped (status reads search_built).
  if (reason === 'schema') setMeta(db0, 'search_built', 0);

  Object.assign(state, {
    running: true, stopRequested: false, progress: 0, phase: reason ? 'search' : 'repair',
    startedAt: Date.now(), finishedAt: null, error: null, stats: null,
  });
  const stats = { reason, searchMs: 0, optimizeMs: 0, batches: 0, rows: 0, repair: null };
  let bulkSettings = false;
  const alive = () => !state.stopRequested && getDb() === db0 && db0.open;

  try {
    if (!reason) {
      // Built: only check for and fix drift.
      stats.repair = await repair(db0, alive);
      if (!stats.repair) return null;
      const r = stats.repair;
      if (r.orphans || r.missing) log(`[search-index] repaired ${r.orphans} stale and ${r.missing} missing entries in ${(r.ms / 1000).toFixed(1)} s`);
      stats.totalMs = Date.now() - state.startedAt;
      state.stats = stats;
      return stats;
    }

    {
      // Search tables. A schema bump starts over; a build cut short by a
      // lock or a restart just runs again (idempotent).
      const t0 = Date.now();
      if (reason === 'schema') {
        db0.exec(`
          INSERT INTO media_search_names (media_search_names) VALUES ('delete-all');
          INSERT INTO media_search_text (media_search_text) VALUES ('delete-all');
          INSERT INTO media_search_themes (media_search_themes) VALUES ('delete-all');`);
      }
      // Rows added from here on are indexed by the triggers, so the build
      // stops at today's last id instead of chasing a running scan's tail.
      const total = db0.prepare('SELECT count(*) AS n FROM media').get().n;
      const lastId = db0.prepare(`SELECT max(id) AS n FROM media WHERE id <= ${ID_MAX}`).get().n || 0;
      const nextHi = db0.prepare('SELECT max(id) AS hi, count(*) AS n FROM (SELECT id FROM media WHERE id > ? AND id <= ? ORDER BY id LIMIT ?)');
      const runBatch = db0.transaction((lo, hi) => indexRange(db0, lo, hi));
      // Merge segments less eagerly while bulk loading (about a fifth faster
      // at 2M files); the merge step below tidies up, and the defaults return.
      mergeSettings(db0, BULK_MERGE);
      bulkSettings = true;
      let size = batch || BUILD_BATCH;
      let lo = 0;   // searchable ids start at 1 (validId)
      let done = 0;
      for (;;) {
        if (!alive()) return null;
        const next = nextHi.get(lo, lastId, size);
        if (next.hi == null) break;
        const b0 = Date.now();
        runBatch(lo, next.hi);
        // Without a fixed size, aim each batch at BATCH_TARGET_MS so a request
        // never waits long behind one (the loop-delay target, spec 5.3).
        // Shrink at once, grow slowly: FTS5 merges segments inside some inserts,
        // so batch times spike and a fast batch says little about the next.
        if (!batch) size = Math.max(BATCH_MIN, Math.min(BATCH_MAX, Math.round(size * 1.25),
          Math.round(size * BATCH_TARGET_MS / Math.max(1, Date.now() - b0))));
        done += next.n;
        stats.batches++;
        lo = next.hi;
        state.progress = total ? Math.min(0.99, done / total) : 0;
        await tick();
      }
      stats.rows = total;
      stats.searchMs = Date.now() - t0;
      mergeSettings(db0, DEFAULT_MERGE);
      bulkSettings = false;

      // Searchable from here on.
      setMeta(db0, 'search_schema', SEARCH_SCHEMA);
      setMeta(db0, 'search_built', 1);

      // 3. Merge the segments the batches left behind. 'optimize' does it in
      //    one statement (15+ s at 2M, the whole server frozen); 'merge' with
      //    a negative page budget does the same work in ~20 ms slices.
      state.phase = 'optimize';
      const t1 = Date.now();
      const changes = db0.prepare('SELECT total_changes()').pluck();
      for (const t of ['media_search_names', 'media_search_text']) {
        const merge = db0.prepare(`INSERT INTO ${t} (${t}, rank) VALUES ('merge', ?)`);
        // Writes during the merge (a running scan) add segments of their own,
        // so bound the work: about two rewrites of the table is plenty.
        const pages = db0.prepare(`SELECT count(*) FROM ${t}_data`).pluck().get();
        const maxSteps = Math.min(MERGE_MAX_STEPS, 10 + Math.ceil((2 * pages) / MERGE_PAGES));
        for (let step = 0; step < maxSteps; step++) {
          if (!alive()) return null;
          const before = changes.get();
          merge.run(-MERGE_PAGES);
          if (changes.get() - before <= 1) break;
          await tick();
        }
      }
      stats.optimizeMs = Date.now() - t1;
    }

    state.progress = 1;
    state.stats = stats;
    stats.totalMs = Date.now() - state.startedAt;
    log(`[search-index] built in ${(stats.totalMs / 1000).toFixed(1)} s (${stats.rows} rows)`);
    return stats;
  } catch (err) {
    // A connection closed under us (vault lock) is a normal stop, not an error.
    if (!alive()) return null;
    state.error = err.message;
    log(`[search-index] build failed: ${err.message}`);
    return null;
  } finally {
    if (bulkSettings && db0.open) { try { mergeSettings(db0, DEFAULT_MERGE); } catch { /* best effort */ } }
    state.running = false;
    state.finishedAt = Date.now();
  }
}

/**
 * Repair drift in a built library (spec 5.3): anti-join each search table's
 * rowids against media, in id ranges with the event loop free in between.
 * Orphan rowids (a deleted or re-numbered row whose trigger never ran) are
 * deleted; ids missing from a table (INSERT OR REPLACE, raw writes with the
 * triggers absent) are indexed again. Themes only hold grid rows with
 * themes. Returns { ms, orphans, missing }, or null when stopped.
 *
 * Accepted limitation (spec 15): this is rowid-level only. A row UPDATEd
 * while the search triggers were absent keeps its old text in the search
 * tables; comparing content would mean re-tokenizing the whole library on
 * every start. No Vault version drops the triggers.
 */
const REPAIR_CHUNK = 10000;
async function repair(db, alive) {
  const t0 = Date.now();
  const orphanSql = (t) => db.prepare(`SELECT d.id FROM ${t}_docsize d WHERE d.id > ? AND d.id <= ?
    AND NOT EXISTS (SELECT 1 FROM media m WHERE m.id = d.id)`).pluck();
  const missingSql = (t) => db.prepare(`SELECT m.id FROM media m WHERE m.id > ? AND m.id <= ?
    AND NOT EXISTS (SELECT 1 FROM ${t}_docsize d WHERE d.id = m.id)`).pluck();
  const tables = ['media_search_names', 'media_search_text'];
  const orphans = tables.map(orphanSql);
  const missing = tables.map(missingSql);
  const themeOrphans = db.prepare(`SELECT d.id FROM media_search_themes_docsize d LEFT JOIN media m ON m.id = d.id
    WHERE d.id > ? AND d.id <= ? AND (m.id IS NULL OR +m.media_type NOT IN ${GRID_IN})`).pluck();
  const themeMissing = db.prepare(`SELECT id FROM (
      SELECT m.id, ${themeTokens(themesSource('mc.themes', 'm.themes'))} AS tok
      FROM media m LEFT JOIN media_clean mc ON mc.media_id = m.id
      WHERE m.id > ? AND m.id <= ? AND +m.media_type IN ${GRID_IN}
        AND NOT EXISTS (SELECT 1 FROM media_search_themes_docsize d WHERE d.id = m.id))
    WHERE tok <> ''`).pluck();
  const del = [...tables, 'media_search_themes'].map(t => db.prepare(`DELETE FROM ${t} WHERE rowid = ?`));
  // Keyset walk over the ids that exist (round 3): each step ends at the
  // smallest "REPAIR_CHUNK-th next id" among media and the three docsize
  // tables, so one row at id 2,000,000,000 costs one step, not 200,000.
  const nextEnd = ['media', 'media_search_names_docsize', 'media_search_text_docsize', 'media_search_themes_docsize']
    .map(t => db.prepare(`SELECT max(id) AS hi, count(*) AS n FROM (SELECT id FROM ${t} WHERE id > ? AND id <= ${ID_MAX} ORDER BY id LIMIT ${REPAIR_CHUNK})`));
  const total = Math.max(1, db.prepare('SELECT count(*) FROM media').pluck().get());
  let nOrphans = 0;
  let nMissing = 0;
  // Entries outside the searchable ids (validId), e.g. from an older
  // trigger version, are stale whatever media holds; ids in range are walked.
  for (const t of ['media_search_names', 'media_search_text', 'media_search_themes']) {
    const out = db.prepare(`SELECT id FROM ${t}_docsize WHERE id < 1 OR id > ${ID_MAX}`).pluck().all();
    const del = db.prepare(`DELETE FROM ${t} WHERE rowid = ?`);
    if (out.length) db.transaction(() => { for (const id of out) del.run(id); })();
    nOrphans += out.length;
  }
  let lo = 0;
  let seen = 0;
  for (;;) {
    if (!alive()) return null;
    let hi = null;
    for (const st of nextEnd) {
      const r = st.get(lo);
      if (r.hi == null) continue;
      // A table with fewer than a full chunk left: everything up to its last id.
      if (hi === null || r.hi < hi) hi = r.hi;
    }
    if (hi === null) break;
    const gone = [orphans[0].all(lo, hi), orphans[1].all(lo, hi), themeOrphans.all(lo, hi)];
    const need = new Set([...missing[0].all(lo, hi), ...missing[1].all(lo, hi), ...themeMissing.all(lo, hi)]);
    if (gone.some(g => g.length) || need.size) {
      db.transaction(() => {
        gone.forEach((ids, i) => { for (const id of ids) del[i].run(id); });
        for (const id of need) indexRange(db, id - 1, id);
      })();
      nOrphans += gone.reduce((n, g) => n + g.length, 0);
      nMissing += need.size;
    }
    seen += REPAIR_CHUNK;
    state.progress = Math.min(0.99, seen / total);
    lo = hi;
    await tick();
  }
  return { ms: Date.now() - t0, orphans: nOrphans, missing: nMissing };
}

/** FTS5 merge settings for the two big search tables (integer literals only). */
const BULK_MERGE = { automerge: 16, crisismerge: 64 };
const DEFAULT_MERGE = { automerge: 4, crisismerge: 16 };
function mergeSettings(db, values) {
  for (const t of ['media_search_names', 'media_search_text']) {
    for (const [k, v] of Object.entries(values)) db.exec(`INSERT INTO ${t} (${t}, rank) VALUES ('${k}', ${Number(v) | 0})`);
  }
}

/** Ask a running build to stop at the next batch boundary. */
function stopBuild() {
  if (state.running) state.stopRequested = true;
}

module.exports = {
  SEARCH_SCHEMA, TRIGGER_SCHEMA, ID_MAX, validId, GRID_IN, EXT_EXPR, NAME_COLS, TEXT_COLS, VERSION_COLUMNS, INDEXES, SORT_FIELDS, NOTES_FLAG, SCAN_STATE,
  FLAG_INDEXES,
  ensureSchema, missingIndexes, createMissingIndexes, markPreparing, prepareIndexesAsync, version, getMeta, setMeta,
  buildReason, startBuild, stopBuild, status,
  _state: state,
};
