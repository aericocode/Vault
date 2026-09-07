const config = require('../config');

// Use encrypted SQLite if available, otherwise fall back to regular.
// Native addons can't live inside a SEA blob, so packaged builds ship them in
// runtime/node_modules beside the exe and load via createRequire. Dev resolves
// from the repo's node_modules the same way (createRequire(__filename) is
// byte-identical to plain require here) — one code path, and esbuild never
// sees a static require it would try to bundle.
const { createRequire } = require('module');
const { ROOT: _appRoot, isSea: _isSea } = require('./approot');
const _nativeRequire = _isSea
  ? createRequire(require('path').join(_appRoot, 'runtime', 'index.js'))
  : createRequire(__filename);
let Database;
let _hasCipher = false;
try {
  Database = _nativeRequire('better-sqlite3-multiple-ciphers');
  _hasCipher = true;
  console.log('Using encrypted SQLite');
} catch {
  // Plain fallback is legitimate ONLY when no password is set. init() enforces
  // that: a password with no cipher build is a hard VAULT_NO_CIPHER failure.
  Database = _nativeRequire('better-sqlite3');
}

let dbInstance = null;

/**
 * Columns added after the original v3 schema. Applied via ALTER TABLE for
 * existing databases (single source of truth — the viewer used to add the
 * user_* columns client-side, which meant two divergent schema owners).
 */
const MIGRATION_COLUMNS = [
  // v3.2
  ['audio_transcription', 'TEXT'],
  // User columns (previously added by the viewer)
  ['user_notes', "TEXT DEFAULT ''"],
  ['user_starred', 'INTEGER DEFAULT 0'],
  ['user_rating', 'INTEGER DEFAULT 0'],
  ['user_flagged_delete', 'INTEGER DEFAULT 0'],
  // Viewer server features
  ['thumbnail_path', 'TEXT'],
  // Unix seconds of the last thumbnail generation. The viewer puts it in the
  // /thumb URL as ?v=, which is what lets the plain-mode response be cached
  // for a year: regenerate the thumbnail and the URL changes with it.
  ['thumb_version', 'INTEGER DEFAULT 0'],
  ['playback_failed', 'INTEGER DEFAULT 0'],
  // Trash / file management (phase deferred, schema ready)
  ['user_trashed', 'INTEGER DEFAULT 0'],
  ['trashed_original_path', 'TEXT'],
  ['trashed_at', 'TEXT'],
  // Duplicate detection: normalized filename + shared group id
  ['name_key', 'TEXT'],
  ['dupe_group', 'INTEGER'],
  // View tracking (≥30% watched for A/V, dwell for images/docs)
  ['view_count', 'INTEGER DEFAULT 0'],
  ['last_viewed_at', 'TEXT'],
  // Resume playback
  ['last_position', 'REAL DEFAULT 0'],
  // Semantic search (embeddings of existing text metadata — no rescan)
  ['embedding', 'BLOB'],
  ['embedding_model', 'TEXT'],
  // "Done" session-end tracking (viewer Done button)
  ['done_count', 'INTEGER DEFAULT 0'],
  ['last_done_at', 'TEXT'],
  ['last_done_position', 'REAL DEFAULT 0'],
  // "Hot" intense-moment tracking (viewer 🔥 button — same shape as Done)
  ['hot_count', 'INTEGER DEFAULT 0'],
  ['last_hot_at', 'TEXT'],
  ['last_hot_position', 'REAL DEFAULT 0'],
  // Watch-activity heatmap: JSON array of 100 buckets (seconds watched per
  // 1% of duration) powering the seek-bar activity curve
  ['watch_heatmap', 'TEXT'],
  // Hot/Done event heatmaps: JSON arrays of 100 buckets (EVENT COUNT per 1% of
  // duration) — every 🔥/💦 mark bumps its bucket, so the seek-bar tint gets
  // more vibrant where moments repeat
  ['hot_heatmap', 'TEXT'],
  ['done_heatmap', 'TEXT'],
  // Perceptual hash (visual dupe detection — catches re-encodes/resizes)
  ['phash', 'TEXT'],
  // English subtitle plain text (translation for foreign clips, original track
  // for English ones) — searchable via the library's "Subtitles" toggle
  ['subtitle_en', 'TEXT'],
  // Subtitle generation found nothing to transcribe (no audio stream, or audio
  // with no speech — music/ambience/silence). Set so the scan post-pass skips
  // the file instead of loading the whisper model only to immediately fail.
  // The explicit "generate subtitles" action ignores it, so a manual retry
  // still works if the file later gains speech.
  ['subtitle_no_speech', 'INTEGER DEFAULT 0'],
  // Codec info behind the playback decision (native vs HLS remux). Filled by
  // the scan probe, by the first play, and by `node vault.js probe`.
  ['video_codec', 'TEXT'],
  ['audio_codec', 'TEXT'],
  ['pix_fmt', 'TEXT'],
  ['codec_profile', 'TEXT'],
  ['codec_level', 'INTEGER'],
  ['container', 'TEXT'],
  // 0 = never probed by this feature. Bump PROBE_VERSION when the probe logic
  // changes; the backfill then re-runs over everything.
  ['probe_version', 'INTEGER DEFAULT 0'],
];

/** Value written to media.probe_version by the current probe logic. */
const PROBE_VERSION = 1;

/**
 * Add any missing columns to an existing database.
 */
function ensureColumns(db) {
  const existing = new Set(
    db.prepare('PRAGMA table_info(media)').all().map(c => c.name)
  );
  for (const [name, type] of MIGRATION_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE media ADD COLUMN ${name} ${type}`);
      console.log(`  DB migration: added media.${name}`);
    }
  }
}

/**
 * Initialize and return the database connection
 * @param {string} dbPath - Path to database file
 * @param {string|null} password - Optional encryption password
 * @returns {Database} SQLite database instance
 */
function init(dbPath = config.paths.database, password = config.getDbPassword()) {
  if (dbInstance) return dbInstance;

  // HARD FAIL when a password IS set but the cipher module is unavailable —
  // BEFORE opening/creating the file, so it is never touched as plaintext.
  // Plain better-sqlite3 ignores PRAGMA key and the readability check below
  // would pass, leaving the MAIN METADATA DATABASE unencrypted while the user
  // believes the vault is on. Mirrors lib/secure-assets.js init(). No password
  // + no cipher stays the legitimate plaintext path.
  if (password && !_hasCipher) {
    const e = new Error(
      'VAULT_DB_PASSWORD is set but the encrypted-SQLite module ' +
      '"better-sqlite3-multiple-ciphers" is unavailable — the MAIN METADATA ' +
      'DATABASE would be opened/created as PLAINTEXT while you believe the ' +
      'vault is on. Refusing to start. Install the module (dev: `npm install`; ' +
      'packaged exe: the build must bundle it into runtime/node_modules beside ' +
      'the exe).');
    e.code = 'VAULT_NO_CIPHER';
    throw e;
  }

  const db = new Database(dbPath);

  // If password provided and using encrypted SQLite, set up encryption.
  // Single quotes in the passphrase are doubled — the pragma is a SQL string.
  if (password && db.pragma) {
    try {
      db.pragma(`key='${String(password).replace(/'/g, "''")}'`);
    } catch (err) {
      // Might already be keyed
    }
  }

  // Verify the file is actually readable with (or without) the key BEFORE
  // running schema DDL — an encrypted DB opened with a missing/wrong key
  // fails here with SQLITE_NOTADB. Surface a typed error so the server can
  // boot into the locked state instead of crashing.
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    try { db.close(); } catch {}
    const e = new Error(password
      ? 'database is encrypted and the password is wrong'
      : 'database is encrypted — password required');
    e.code = 'DB_ENCRYPTED';
    throw e;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filepath TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      duration_seconds REAL,
      width INTEGER,
      height INTEGER,
      filesize_bytes INTEGER,

      -- AI extracted metadata
      language TEXT,
      themes TEXT,
      explicit INTEGER DEFAULT 0,
      locations TEXT,
      quality_flag TEXT,
      description TEXT,
      tags TEXT,
      content_type TEXT,

      -- Extended metadata (v3.1)
      media_elements TEXT,      -- JSON: positioning, action, objects, expression, camera, lighting
      transcribed_text TEXT,    -- JSON: array of {text, location}
      audio_transcription TEXT, -- Full audio transcription from Whisper (v3.2)

      -- Processing info
      frames_analyzed INTEGER,
      processed_at TEXT,
      model_used TEXT,
      processing_error TEXT,

      -- User columns (owned here; the viewer reads/writes via the server API)
      user_notes TEXT DEFAULT '',
      user_starred INTEGER DEFAULT 0,
      user_rating INTEGER DEFAULT 0,
      user_flagged_delete INTEGER DEFAULT 0,

      -- Viewer server features
      thumbnail_path TEXT,
      playback_failed INTEGER DEFAULT 0,

      -- Trash / file management (phase deferred, schema ready)
      user_trashed INTEGER DEFAULT 0,
      trashed_original_path TEXT,
      trashed_at TEXT,

      -- Duplicate detection
      name_key TEXT,            -- normalized filename (see lib/dupes.js)
      dupe_group INTEGER,       -- shared group id (min member id); NULL = no dupes

      -- View tracking
      view_count INTEGER DEFAULT 0,
      last_viewed_at TEXT,

      -- Resume playback
      last_position REAL DEFAULT 0,

      -- Semantic search (embeddings of existing text metadata)
      embedding BLOB,
      embedding_model TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_path TEXT,
      command TEXT NOT NULL,
      executed INTEGER DEFAULT 0,
      executed_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (media_id) REFERENCES media(id)
    );

    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      search_text TEXT DEFAULT '',
      filters TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      sort_order INTEGER DEFAULT 0
    );

    -- Reusable note snippets (quick notes — like saved searches, for notes)
    CREATE TABLE IF NOT EXISTS saved_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL UNIQUE,
      color TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Collections (a collection IS a playlist when played — see COLLECTIONS_SPEC.md)
    -- kind 'folder' rows hold OTHER collections/folders (via parent_id); only
    -- kind 'collection' rows hold media items. parent_id NULL = root level.
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      parent_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'collection',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS collection_items (
      collection_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (collection_id, media_id)
    );
    CREATE INDEX IF NOT EXISTS idx_collitems_media ON collection_items(media_id);

    CREATE INDEX IF NOT EXISTS idx_media_filepath ON media(filepath);
    CREATE INDEX IF NOT EXISTS idx_media_themes ON media(themes);
    CREATE INDEX IF NOT EXISTS idx_pending_executed ON pending_operations(executed);

    -- Gamification (opt-in via --gamify; all data local, see lib/gamify.js)
    CREATE TABLE IF NOT EXISTS gamify_stats (
      id INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row table
      score REAL DEFAULT 0,
      streak_days INTEGER DEFAULT 0,
      last_active_date TEXT,                  -- YYYY-MM-DD local date
      last_settled_date TEXT,                 -- decay applied through this date
      total_watch_time_s REAL DEFAULT 0,
      total_views INTEGER DEFAULT 0,
      quests_completed INTEGER DEFAULT 0,
      level INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS gamify_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,               -- view | quest_complete | streak_bonus | decay
      points REAL NOT NULL,
      media_id INTEGER,
      detail TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS gamify_quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quest_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      target INTEGER NOT NULL,
      progress INTEGER DEFAULT 0,
      reward_points INTEGER NOT NULL,
      params TEXT DEFAULT '{}',               -- JSON: theme/tag/media_type the quest matches on
      status TEXT DEFAULT 'active',           -- active | completed | expired
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      completed_at TEXT
    );

    -- One row per local day; powers the 30-day history chart
    CREATE TABLE IF NOT EXISTS gamify_daily (
      day TEXT PRIMARY KEY,                   -- YYYY-MM-DD local date
      score REAL NOT NULL,
      points_earned REAL DEFAULT 0,
      views INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_gamify_events_created ON gamify_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_gamify_quests_status ON gamify_quests(status);

    -- Canonicalized ("clean") copies of the free-form array metadata. The raw
    -- media.themes/tags/locations columns keep the AI's exact words untouched;
    -- these hold a normalized version (lowercased, trimmed, de-duped) so filters
    -- and search stop treating "Romance"/"romance "/"ROMANCE" as three things.
    -- Derived, disposable: rebuild any time via: node vault.js clean
    CREATE TABLE IF NOT EXISTS media_clean (
      media_id   INTEGER PRIMARY KEY,
      themes     TEXT,
      tags       TEXT,
      locations  TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- HLS remux streaming (see lib/stream/). The keyframe index lives in the
    -- MAIN database, so in vault mode it is encrypted like everything else and
    -- unreadable while the vault is locked.

    -- Where the keyframes are, so the VOD playlist can be written before a
    -- single segment exists. Derived and disposable: delete a row and it is
    -- rebuilt on the next play.
    CREATE TABLE IF NOT EXISTS stream_index (
      media_id        INTEGER PRIMARY KEY,
      keyframes       TEXT NOT NULL,      -- JSON array of keyframe times, media-relative
      segments        TEXT NOT NULL,      -- JSON array of segment start times
      container_start REAL NOT NULL,      -- first video packet timestamp of the source
      duration        REAL NOT NULL,
      built_at        INTEGER NOT NULL,
      index_version   INTEGER NOT NULL
    );

    -- stream_cache is GONE (round 3). Segments are never kept: they live in
    -- memory while a file plays and are dropped when it stops. Dropping the
    -- table costs nothing, because everything it described was derived data
    -- that regenerates, and leaving it would leave rows pointing at segments
    -- no longer anywhere on the machine.
    DROP TABLE IF EXISTS stream_cache;
  `);

  // Gamify migrations — the table may predate these columns in early DBs
  const gamifyCols = new Set(
    db.prepare('PRAGMA table_info(gamify_stats)').all().map(c => c.name)
  );
  for (const [name, type] of [['last_settled_date', 'TEXT'], ['selected_theme', 'TEXT']]) {
    if (!gamifyCols.has(name)) {
      db.exec(`ALTER TABLE gamify_stats ADD COLUMN ${name} ${type}`);
      console.log(`  DB migration: added gamify_stats.${name}`);
    }
  }

  // saved_notes migrations — colored, reorderable snippet chips
  const noteCols = new Set(
    db.prepare('PRAGMA table_info(saved_notes)').all().map(c => c.name)
  );
  for (const [name, type] of [['color', 'TEXT'], ['sort_order', 'INTEGER DEFAULT 0']]) {
    if (!noteCols.has(name)) {
      db.exec(`ALTER TABLE saved_notes ADD COLUMN ${name} ${type}`);
      console.log(`  DB migration: added saved_notes.${name}`);
    }
  }
  // Seed sort_order for pre-existing rows so their current (creation) order is kept
  if (!noteCols.has('sort_order')) {
    const rows = db.prepare('SELECT id FROM saved_notes ORDER BY created_at ASC, id ASC').all();
    const upd = db.prepare('UPDATE saved_notes SET sort_order = ? WHERE id = ?');
    rows.forEach((r, i) => upd.run(i, r.id));
  }

  // collections migrations — hierarchical folders (parent_id + kind)
  const collCols = new Set(
    db.prepare('PRAGMA table_info(collections)').all().map(c => c.name)
  );
  for (const [name, type] of [['parent_id', 'INTEGER'], ['kind', "TEXT NOT NULL DEFAULT 'collection'"]]) {
    if (!collCols.has(name)) {
      db.exec(`ALTER TABLE collections ADD COLUMN ${name} ${type}`);
      console.log(`  DB migration: added collections.${name}`);
    }
  }

  // Migrate older databases created before the columns above existed
  ensureColumns(db);

  // Indexes on migrated columns — must come AFTER ensureColumns, otherwise
  // they'd fail on a legacy DB that doesn't have the columns yet
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_media_name_key ON media(name_key);
    CREATE INDEX IF NOT EXISTS idx_media_dupe_group ON media(dupe_group);
  `);

  dbInstance = db;
  return db;
}

/**
 * Get existing database instance or initialize new one
 */
function get() {
  return dbInstance || init();
}

/**
 * Close the database connection
 */
function close() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

/**
 * Test a candidate passphrase against the on-disk DB WITHOUT touching the live
 * connection — opens a throwaway connection, keys it, and attempts one read.
 * A wrong key fails with SQLITE_NOTADB before any write, so this never mutates
 * the file. Used by vault.changePassword() to re-confirm the current pass.
 * @returns {boolean} true iff `candidate` decrypts the database
 */
function verifyPassword(candidate, dbPath = config.paths.database) {
  if (!_hasCipher) return false;          // can't verify without the cipher build
  let probe = null;
  try {
    probe = new Database(dbPath);
    if (candidate) probe.pragma(`key='${String(candidate).replace(/'/g, "''")}'`);
    probe.prepare('SELECT count(*) FROM sqlite_master').get();
    return true;
  } catch {
    return false;                          // wrong key → NOTADB, or file missing
  } finally {
    if (probe) { try { probe.close(); } catch {} }
  }
}

/**
 * Check if media file is already processed (successfully)
 */
function isProcessed(filepath) {
  const db = get();
  const row = db.prepare('SELECT id, processing_error FROM media WHERE filepath = ?').get(filepath);
  return row && !row.processing_error;
}

// Vision API errors are transient (JSON parse errors, etc.) and may succeed on retry
const VISION_ERROR_TERMS = ['vision', 'api', 'json', 'parse', 'expected'];

function isVisionError(errorText) {
  const error = errorText.toLowerCase();
  return VISION_ERROR_TERMS.some(term => error.includes(term));
}

/**
 * Check if media file has a Vision API error (JSON parse errors, etc.)
 */
function hasVisionApiError(filepath) {
  const db = get();
  const row = db.prepare('SELECT processing_error FROM media WHERE filepath = ?').get(filepath);
  if (!row || !row.processing_error) return false;
  return isVisionError(row.processing_error);
}

// Marker for stub rows inserted at scan start (visible in the viewer
// immediately, AI analysis backfills). Treated like 'new' — any later scan
// picks them up without --reprocess/--retry-errors.
const UNSCANNED_MARKER = 'unscanned';

/**
 * Check processing status for a file
 * Returns: 'new' | 'success' | 'vision_error' | 'other_error'
 */
function getProcessingStatus(filepath) {
  const db = get();
  const row = db.prepare('SELECT id, processing_error FROM media WHERE filepath = ?').get(filepath);

  if (!row) return 'new';
  if (!row.processing_error) return 'success';
  if (row.processing_error === UNSCANNED_MARKER) return 'new';
  return isVisionError(row.processing_error) ? 'vision_error' : 'other_error';
}

/**
 * Insert lightweight stub rows for files about to be scanned, so they show
 * up in the viewer (playable, taggable) before the AI analysis finishes.
 * Existing rows are left alone. @returns {number} stubs inserted
 */
function insertStubs(files) {
  const db = get();
  const fs = require('fs');
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO media (filepath, filename, media_type, filesize_bytes, processing_error)
    VALUES (?, ?, ?, ?, '${UNSCANNED_MARKER}')
  `);
  const run = db.transaction((list) => {
    let n = 0;
    for (const f of list) {
      let size = null;
      try { size = fs.statSync(f.path).size; } catch {}
      n += stmt.run(f.path, f.name, f.mediaType, size).changes;
    }
    return n;
  });
  return run(files);
}

/**
 * Get count of files with Vision API errors
 */
function getVisionErrorCount() {
  const db = get();
  const row = db.prepare(`
    SELECT COUNT(*) as count FROM media
    WHERE processing_error IS NOT NULL
    AND (
      LOWER(processing_error) LIKE '%vision%' OR
      LOWER(processing_error) LIKE '%api%' OR
      LOWER(processing_error) LIKE '%json%' OR
      LOWER(processing_error) LIKE '%parse%' OR
      LOWER(processing_error) LIKE '%expected%'
    )
  `).get();
  return row?.count || 0;
}

/* ── Clean (canonicalized) array metadata ──────────────────────────────────
   Cheap, deterministic normalization — NO AI. lowercase + trim + collapse
   internal whitespace + drop empties + de-dupe (case-insensitive, since we've
   lowercased). Non-destructive: writes to media_clean, never touches the raw
   media columns, so it can be re-run any time the rules improve. */

/** Normalize one raw JSON array string (or array) → cleaned JSON array string. */
function cleanArrayJson(raw) {
  let arr;
  try { arr = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); }
  catch { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (v == null) continue;
    const s = String(v).trim().replace(/\s+/g, ' ').toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return JSON.stringify(out);
}

const _cleanUpsert = () => get().prepare(`
  INSERT INTO media_clean (media_id, themes, tags, locations, updated_at)
  VALUES (?, ?, ?, ?, datetime('now'))
  ON CONFLICT(media_id) DO UPDATE SET
    themes = excluded.themes, tags = excluded.tags,
    locations = excluded.locations, updated_at = excluded.updated_at
`);

/** Derive + store the clean row for one media id from raw values. */
function upsertClean(mediaId, { themes, tags, locations } = {}) {
  try {
    _cleanUpsert().run(mediaId, cleanArrayJson(themes), cleanArrayJson(tags), cleanArrayJson(locations));
  } catch { /* media_clean absent on an ancient DB — non-fatal */ }
}

/** Rebuild the entire media_clean table from current raw metadata (CLI: clean). */
function backfillClean() {
  const db = get();
  const rows = db.prepare('SELECT id, themes, tags, locations FROM media').all();
  const up = _cleanUpsert();
  const run = db.transaction((list) => {
    for (const r of list) up.run(r.id, cleanArrayJson(r.themes), cleanArrayJson(r.tags), cleanArrayJson(r.locations));
  });
  run(rows);
  return rows.length;
}

/** Distinct cleaned theme values across the library, most-frequent first —
 *  fed back to the scan prompt as soft vocabulary (see config/prompts.js). */
function distinctCleanThemes(limit = 60) {
  try {
    const rows = get().prepare('SELECT themes FROM media_clean').all();
    const freq = new Map();
    for (const r of rows) {
      let arr = [];
      try { arr = JSON.parse(r.themes || '[]'); } catch {}
      for (const t of arr) freq.set(t, (freq.get(t) || 0) + 1);
    }
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(e => e[0]);
  } catch { return []; }
}

/**
 * Save media metadata to database.
 *
 * Uses UPSERT (not INSERT OR REPLACE) so reprocessing a file updates the
 * AI-extracted fields while PRESERVING user columns (stars, ratings, notes,
 * flags) and the thumbnail path. INSERT OR REPLACE would wipe them.
 */
function saveMedia(data) {
  const db = get();
  const { nameKey } = require('./dupes');
  const stmt = db.prepare(`
    INSERT INTO media (
      filepath, filename, media_type, duration_seconds, width, height, filesize_bytes,
      language, themes, explicit, locations, quality_flag, description, tags, content_type,
      media_elements, transcribed_text, audio_transcription,
      frames_analyzed, processed_at, model_used, processing_error, name_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)
    ON CONFLICT(filepath) DO UPDATE SET
      filename = excluded.filename,
      media_type = excluded.media_type,
      duration_seconds = excluded.duration_seconds,
      width = excluded.width,
      height = excluded.height,
      filesize_bytes = excluded.filesize_bytes,
      language = excluded.language,
      themes = excluded.themes,
      explicit = excluded.explicit,
      locations = excluded.locations,
      quality_flag = excluded.quality_flag,
      description = excluded.description,
      tags = excluded.tags,
      content_type = excluded.content_type,
      media_elements = excluded.media_elements,
      transcribed_text = excluded.transcribed_text,
      audio_transcription = excluded.audio_transcription,
      frames_analyzed = excluded.frames_analyzed,
      processed_at = excluded.processed_at,
      model_used = excluded.model_used,
      processing_error = excluded.processing_error,
      name_key = excluded.name_key
  `);

  const res = stmt.run(
    data.filepath,
    data.filename,
    data.mediaType,
    data.duration,
    data.width,
    data.height,
    data.filesize,
    data.language || 'unknown',
    JSON.stringify(data.themes || []),
    data.explicit ? 1 : 0,
    JSON.stringify(data.locations || []),
    data.qualityFlag,
    data.description || '',
    JSON.stringify(data.tags || []),
    data.contentType || 'unknown',
    JSON.stringify(data.mediaElements || []),
    JSON.stringify(data.transcribedText || []),
    data.audioTranscription || null,
    data.framesAnalyzed,
    data.model || 'unknown',
    data.error || null,
    nameKey(data.filename)
  );

  // Keep the clean copy in step (UPSERT means lastInsertRowid is unset on an
  // update — look the id up by filepath either way).
  const id = getMediaId(data.filepath);
  if (id) upsertClean(id, { themes: data.themes, tags: data.tags, locations: data.locations });
  // The scan already ran ffprobe; store the codec columns from that same call
  // so the first play does not have to probe again.
  if (id && data.streamInfo) {
    try { saveStreamInfo(id, data.streamInfo); } catch { /* codec columns are best-effort */ }
  }

  return res;
}

/**
 * Save a pending file operation
 */
function savePendingOperation(mediaId, operation, sourcePath, targetPath, command) {
  const db = get();

  // Delete existing operation for this media
  db.prepare('DELETE FROM pending_operations WHERE media_id = ?').run(mediaId);

  const stmt = db.prepare(`
    INSERT INTO pending_operations (media_id, operation, source_path, target_path, command)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(mediaId, operation, sourcePath, targetPath, command);
}

/**
 * Get media ID by filepath
 */
function getMediaId(filepath) {
  const db = get();
  const row = db.prepare('SELECT id FROM media WHERE filepath = ?').get(filepath);
  return row?.id;
}

/* Attach derived, read-only fields the UI wants but that aren't stored raw:
   language_name (full display name) + language_code (canonical ISO code, for
   the compact card badge) + *_clean (normalized arrays). Non-destructive —
   computed on read, raw columns untouched. */
const { langName, canonLang } = require('./lang');
function _withDerived(row) {
  if (!row) return row;
  row.language_name = langName(row.language);
  row.language_code = canonLang(row.language);   // 'en' | 'none' | null
  return row;
}

/**
 * Get a media row by id
 */
function getById(id) {
  const db = get();
  const row = db.prepare(`
    SELECT m.*, mc.themes AS themes_clean, mc.tags AS tags_clean, mc.locations AS locations_clean
    FROM media m LEFT JOIN media_clean mc ON mc.media_id = m.id
    WHERE m.id = ?
  `).get(id);
  return _withDerived(row);
}

/**
 * Get a media row by filepath
 */
function getByPath(filepath) {
  const db = get();
  return db.prepare('SELECT * FROM media WHERE filepath = ?').get(filepath);
}

// Columns the viewer is allowed to write via the server API
const USER_WRITABLE_COLUMNS = new Set([
  'user_notes', 'user_starred', 'user_rating', 'user_flagged_delete',
  'playback_failed', 'last_position',
]);

/**
 * Update user-editable fields on a media row (by id).
 * @param {number} id
 * @param {object} fields - subset of USER_WRITABLE_COLUMNS
 * @returns {boolean} true if a row was updated
 */
function setUserFields(id, fields) {
  const db = get();
  const cols = Object.keys(fields).filter(k => USER_WRITABLE_COLUMNS.has(k));
  if (cols.length === 0) return false;

  const sets = cols.map(c => `${c} = ?`).join(', ');
  const values = cols.map(c => fields[c]);
  const result = db.prepare(`UPDATE media SET ${sets} WHERE id = ?`).run(...values, id);
  return result.changes > 0;
}

// AI-extracted columns the viewer may correct by hand (✏️ edit in sidebar).
// Array-valued fields arrive as arrays and are stored as JSON strings —
// same shape saveMedia writes, so scans and edits stay interchangeable.
const AI_EDITABLE_COLUMNS = new Set([
  'description', 'language', 'content_type', 'quality_flag',
  'themes', 'tags', 'locations', 'explicit', 'media_elements',
]);
const AI_ARRAY_COLUMNS = new Set(['themes', 'tags', 'locations', 'media_elements']);

function setAiFields(id, fields) {
  const db = get();
  const cols = Object.keys(fields).filter(k => AI_EDITABLE_COLUMNS.has(k));
  if (cols.length === 0) return false;

  const sets = cols.map(c => `${c} = ?`).join(', ');
  const values = cols.map(c => {
    if (AI_ARRAY_COLUMNS.has(c)) return JSON.stringify(Array.isArray(fields[c]) ? fields[c] : []);
    if (c === 'explicit') return fields[c] ? 1 : 0;
    return fields[c] == null ? null : String(fields[c]);
  });
  const result = db.prepare(`UPDATE media SET ${sets} WHERE id = ?`).run(...values, id);

  // A hand-edit to themes/tags/locations must refresh the clean copy too
  if (result.changes > 0 && ['themes', 'tags', 'locations'].some(k => cols.includes(k))) {
    const row = getById(id);
    upsertClean(id, { themes: row.themes, tags: row.tags, locations: row.locations });
  }
  return result.changes > 0;
}

/**
 * Permanently delete media ROWS (records only — files on disk untouched).
 * Cleans up per-row references in other tables. Caller handles thumbnail
 * files + embedding cache.
 * @returns {number} rows deleted
 */
function deleteRecords(ids) {
  const db = get();
  const del = db.prepare('DELETE FROM media WHERE id = ?');
  const delOps = db.prepare('DELETE FROM pending_operations WHERE media_id = ?');
  const delColl = db.prepare('DELETE FROM collection_items WHERE media_id = ?');
  const delClean = db.prepare('DELETE FROM media_clean WHERE media_id = ?');
  const delStreamIdx = db.prepare('DELETE FROM stream_index WHERE media_id = ?');
  const musicCleanup = require('./musicid/repo').cleanupForMedia;
  const gameCleanup = require('./games/repo').cleanupForMedia;
  const pmvCleanup = require('./pmv/repo').cleanupForMedia;
  const subsCleanup = require('./subtitles/repo').cleanupForMedia;
  const secureAssets = require('./secure-assets');
  const killStream = require('./stream/session').killNow;
  // Stop every remux producer BEFORE the transaction opens: it holds the source
  // file open, which on Windows is enough to make the delete itself fail, and it
  // would go on making segments for a record that is about to stop existing.
  // killNow() is synchronous on purpose: this transaction cannot await anything.
  for (const id of ids) {
    try { killStream(id); } catch {}
  }
  const run = db.transaction((idList) => {
    let n = 0;
    for (const id of idList) {
      delOps.run(id);
      delColl.run(id);
      delClean.run(id);
      musicCleanup(db, id);
      gameCleanup(db, id);
      pmvCleanup(db, id);
      subsCleanup(db, id);
      // Purge the encrypted derived-artifact store too (thumbs/scrub/beat/subs).
      // Separate DB connection — safe to call inside the main-DB transaction.
      try { secureAssets.deleteAll(id); } catch {}
      // The keyframe index follows the record out; a stale stream_index row
      // would otherwise outlive every other trace of the file. (The producer
      // and its in-memory segments went with the killNow() sweep above.)
      try { delStreamIdx.run(id); } catch {}
      n += del.run(id).changes;
    }
    return n;
  });
  return run(ids);
}

// ── Streaming: codec columns and the keyframe index ─────────────────────────

/** Write the codec columns for one row (see lib/media-info.getStreamInfo). */
function saveStreamInfo(id, info) {
  const db = get();
  db.prepare(`
    UPDATE media SET
      duration_seconds = COALESCE(?, duration_seconds),
      width = COALESCE(NULLIF(?, 0), width),
      height = COALESCE(NULLIF(?, 0), height),
      video_codec = ?, audio_codec = ?, pix_fmt = ?,
      codec_profile = ?, codec_level = ?, container = ?,
      probe_version = ?
    WHERE id = ?
  `).run(
    info.duration || null, info.width || 0, info.height || 0,
    info.video_codec, info.audio_codec, info.pix_fmt,
    info.codec_profile, info.codec_level, info.container,
    PROBE_VERSION, id
  );
}

/** Rows still needing a codec probe (the backfill job's work list). */
function rowsNeedingProbe(all = false) {
  return get().prepare(`
    SELECT id, filepath, filename, media_type, duration_seconds
    FROM media
    WHERE media_type IN ('video', 'audio', 'gif')
      AND (user_trashed IS NULL OR user_trashed = 0)
      ${all ? '' : 'AND (probe_version IS NULL OR probe_version < ' + PROBE_VERSION + ')'}
    ORDER BY id
  `).all();
}

/** Stored keyframe index, parsed, or null when absent/stale. */
function getStreamIndex(mediaId, indexVersion) {
  const row = get().prepare('SELECT * FROM stream_index WHERE media_id = ?').get(mediaId);
  if (!row) return null;
  if (indexVersion != null && row.index_version !== indexVersion) return null;
  try {
    return {
      keyframes: JSON.parse(row.keyframes),
      segments: JSON.parse(row.segments),
      containerStart: row.container_start,
      duration: row.duration,
      indexVersion: row.index_version,
    };
  } catch { return null; }
}

function saveStreamIndex(mediaId, idx) {
  get().prepare(`
    INSERT INTO stream_index (media_id, keyframes, segments, container_start, duration, built_at, index_version)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(media_id) DO UPDATE SET
      keyframes = excluded.keyframes, segments = excluded.segments,
      container_start = excluded.container_start, duration = excluded.duration,
      built_at = excluded.built_at, index_version = excluded.index_version
  `).run(mediaId, JSON.stringify(idx.keyframes), JSON.stringify(idx.segments),
    idx.containerStart, idx.duration, Date.now(), idx.indexVersion);
}

function deleteStreamIndex(mediaId) {
  return get().prepare('DELETE FROM stream_index WHERE media_id = ?').run(mediaId).changes;
}

// ── Collections ─────────────────────────────────────────────────────────────

const COLLECTION_KINDS = new Set(['collection', 'folder']);

/** typed error helper — matches the Object.assign(new Error, {code}) convention */
function _collErr(message, code) {
  return Object.assign(new Error(message), { code });
}

/** Ordered collection ids under a folder (depth-first, tree order), folders
 *  skipped — only leaf collections that actually hold media. */
function _orderedDescendantCollections(db, folderId) {
  const childrenStmt = db.prepare(
    'SELECT id, kind FROM collections WHERE parent_id = ? ORDER BY sort_order, created_at, id'
  );
  const out = [];
  const walk = (pid) => {
    for (const ch of childrenStmt.all(pid)) {
      if (ch.kind === 'folder') walk(ch.id);
      else out.push(ch.id);
    }
  };
  walk(folderId);
  return out;
}

/** DISTINCT media across a folder's whole subtree (recursive CTE). */
const _folderItemCountSql = `
  WITH RECURSIVE sub(id) AS (
    SELECT id FROM collections WHERE id = ?
    UNION
    SELECT c.id FROM collections c JOIN sub ON c.parent_id = sub.id
  )
  SELECT COUNT(DISTINCT ci.media_id) AS n
  FROM collection_items ci JOIN sub ON ci.collection_id = sub.id
`;

function getCollections() {
  const db = get();
  const rows = db.prepare(
    'SELECT * FROM collections ORDER BY sort_order, created_at, id'
  ).all();
  const collCount = db.prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?');
  const firstIds = db.prepare(`
    SELECT media_id FROM collection_items
    WHERE collection_id = ? ORDER BY position, added_at LIMIT 4
  `);
  const childCount = db.prepare('SELECT COUNT(*) AS n FROM collections WHERE parent_id = ?');
  const folderCount = db.prepare(_folderItemCountSql);
  for (const c of rows) {
    if (c.kind === 'folder') {
      c.child_count = childCount.get(c.id).n;
      c.item_count = folderCount.get(c.id).n;   // DISTINCT media across subtree
      c.first_ids = [];
    } else {
      c.child_count = 0;
      c.item_count = collCount.get(c.id).n;
      c.first_ids = firstIds.all(c.id).map(r => r.media_id);
    }
  }
  return rows;
}

/**
 * Create a collection or folder.
 * @param {string} name
 * @param {{description?:string, parentId?:number|null, kind?:string}} opts
 * @throws {code:'BAD_KIND'|'BAD_PARENT'|'NAME_TAKEN'}
 */
function createCollection(name, opts = {}) {
  const db = get();
  const kind = opts.kind || 'collection';
  if (!COLLECTION_KINDS.has(kind)) throw _collErr(`invalid kind "${kind}"`, 'BAD_KIND');
  const parentId = opts.parentId == null ? null : Number(opts.parentId);
  if (parentId != null) {
    const parent = db.prepare('SELECT kind FROM collections WHERE id = ?').get(parentId);
    if (!parent) throw _collErr('parent not found', 'BAD_PARENT');
    if (parent.kind !== 'folder') throw _collErr('parent must be a folder', 'BAD_PARENT');
  }
  _assertNameFree(db, name, parentId, null);
  const info = db.prepare(
    'INSERT INTO collections (name, description, parent_id, kind) VALUES (?, ?, ?, ?)'
  ).run(name, (opts.description || '').toString(), parentId, kind);
  return db.prepare('SELECT * FROM collections WHERE id = ?').get(info.lastInsertRowid);
}

/** Case-insensitive name uniqueness within a parent scope. */
function _assertNameFree(db, name, parentId, excludeId) {
  const clash = db.prepare(`
    SELECT id FROM collections
    WHERE LOWER(name) = LOWER(?)
      AND parent_id IS ?
      AND id IS NOT ?
    LIMIT 1
  `).get(name.trim(), parentId, excludeId);
  if (clash) throw _collErr('a collection with that name already exists here', 'NAME_TAKEN');
}

/** Delete a collection (removes its items) or a folder (re-parents children
 *  up to the folder's own parent — never loses collections or media). */
function deleteCollection(id) {
  const db = get();
  const row = db.prepare('SELECT id, kind, parent_id FROM collections WHERE id = ?').get(id);
  if (!row) return false;
  const run = db.transaction(() => {
    if (row.kind === 'folder') {
      db.prepare('UPDATE collections SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, id);
    } else {
      db.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(id);
    }
    return db.prepare('DELETE FROM collections WHERE id = ?').run(id).changes > 0;
  });
  return run();
}

/** True if `ancestorId` is `id` or one of its ancestors (walks parent_id). */
function _isAncestor(db, ancestorId, id) {
  let cur = id;
  const seen = new Set();
  while (cur != null) {
    if (cur === ancestorId) return true;
    if (seen.has(cur)) break;           // paranoia against a pre-existing cycle
    seen.add(cur);
    cur = db.prepare('SELECT parent_id FROM collections WHERE id = ?').get(cur)?.parent_id ?? null;
  }
  return false;
}

/**
 * Update name/description and/or move (parent_id).
 * @throws {code:'NAME_TAKEN'|'BAD_PARENT'|'CYCLE'}
 * @returns {boolean} true if the row existed and something changed
 */
function updateCollection(id, fields) {
  const db = get();
  const row = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!row) return false;

  const sets = [];
  const vals = [];

  // Resolve the destination parent (may be unchanged) for the name check below
  let destParent = row.parent_id;
  const moving = Object.prototype.hasOwnProperty.call(fields, 'parent_id');
  if (moving) {
    const newParent = fields.parent_id == null ? null : Number(fields.parent_id);
    if (newParent != null) {
      const parent = db.prepare('SELECT kind FROM collections WHERE id = ?').get(newParent);
      if (!parent) throw _collErr('parent not found', 'BAD_PARENT');
      if (parent.kind !== 'folder') throw _collErr('parent must be a folder', 'BAD_PARENT');
      // Reject moving a folder into itself or one of its own descendants
      if (row.kind === 'folder' && _isAncestor(db, id, newParent)) {
        throw _collErr('cannot move a folder into its own subtree', 'CYCLE');
      }
    }
    destParent = newParent;
    sets.push('parent_id = ?');
    vals.push(newParent);
  }

  const newName = typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : null;
  if (newName || moving) {
    // A rename OR a move can collide with a sibling in the destination scope
    _assertNameFree(db, newName || row.name, destParent, id);
  }
  if (newName) { sets.push('name = ?'); vals.push(newName); }
  if (typeof fields.description === 'string') {
    sets.push('description = ?');
    vals.push(fields.description.trim());
  }
  if (sets.length === 0) return false;
  return db.prepare(`UPDATE collections SET ${sets.join(', ')} WHERE id = ?`)
    .run(...vals, id).changes > 0;
}

/** Ordered media ids for a collection (playlist order); for a folder, the
 *  deduped union of its subtree's collections in tree order. */
function getCollectionItems(collectionId) {
  const db = get();
  const row = db.prepare('SELECT kind FROM collections WHERE id = ?').get(collectionId);
  const itemsStmt = db.prepare(
    'SELECT media_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at'
  );
  if (row && row.kind === 'folder') {
    const seen = new Set();
    const out = [];
    for (const cid of _orderedDescendantCollections(db, collectionId)) {
      for (const r of itemsStmt.all(cid)) {
        if (!seen.has(r.media_id)) { seen.add(r.media_id); out.push(r.media_id); }
      }
    }
    return out;
  }
  return itemsStmt.all(collectionId).map(r => r.media_id);
}

/** Cheap item count (COUNT(*), no row materialization). Folders → subtree DISTINCT. */
function collectionItemCount(collectionId) {
  const db = get();
  const row = db.prepare('SELECT kind FROM collections WHERE id = ?').get(collectionId);
  if (row && row.kind === 'folder') return db.prepare(_folderItemCountSql).get(collectionId).n;
  return db.prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?').get(collectionId).n;
}

/** First up-to-4 member ids for a collection's mosaic (fresh, no full fetch). */
function collectionFirstIds(collectionId) {
  const db = get();
  return db.prepare(
    'SELECT media_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at LIMIT 4'
  ).all(collectionId).map(r => r.media_id);
}

/**
 * Per-collection count of how many of the given media ids are members — one
 * query. Powers the picker's all/some/none tri-state without N fetches.
 * @returns {{id:number, member_count:number}[]}
 */
function getMembershipCounts(mediaIds) {
  const db = get();
  const ids = (mediaIds || []).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return [];
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT collection_id AS id, COUNT(*) AS member_count
    FROM collection_items
    WHERE media_id IN (${ph})
    GROUP BY collection_id
  `).all(...ids);
}

/** Append media ids (dedup; positions after current max). @returns added count
 *  @throws {code:'FOLDER_TARGET'} folders can't hold media directly */
function addToCollection(collectionId, mediaIds) {
  const db = get();
  const row = db.prepare('SELECT kind FROM collections WHERE id = ?').get(collectionId);
  if (!row) throw _collErr('collection not found', 'BAD_PARENT');
  if (row.kind === 'folder') throw _collErr('folders hold collections, not media', 'FOLDER_TARGET');
  const max = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS p FROM collection_items WHERE collection_id = ?'
  ).get(collectionId).p;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO collection_items (collection_id, media_id, position)
    VALUES (?, ?, ?)
  `);
  const run = db.transaction((ids) => {
    let n = 0, pos = max;
    for (const id of ids) n += ins.run(collectionId, id, ++pos).changes;
    return n;
  });
  return run(mediaIds);
}

function removeFromCollection(collectionId, mediaIds) {
  const db = get();
  const del = db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND media_id = ?');
  const run = db.transaction((ids) => {
    let n = 0;
    for (const id of ids) n += del.run(collectionId, id).changes;
    return n;
  });
  return run(mediaIds);
}

/** Collection membership for one media item (powers picker checkmarks). */
function collectionsForMedia(mediaId) {
  const db = get();
  const member = new Set(db.prepare(
    'SELECT collection_id FROM collection_items WHERE media_id = ?'
  ).all(mediaId).map(r => r.collection_id));
  return getCollections()
    .filter(c => c.kind !== 'folder')
    .map(c => ({ id: c.id, name: c.name, has: member.has(c.id) }));
}

/** Total items across all collections (achievements: "collected"). */
function totalCollectedCount() {
  const db = get();
  return db.prepare('SELECT COUNT(*) AS n FROM collection_items').get().n;
}

// ── Saved note snippets ─────────────────────────────────────────────────────

// Auto-assign palette so new tags aren't all grey; the user can recolor.
const SAVED_NOTE_PALETTE = ['#7aa8ff', '#4ade80', '#fbbf24', '#f472b6', '#a855f7', '#22d3ee', '#fb7185', '#94a3b8'];

function getSavedNotes() {
  const db = get();
  // sort_order first (manual grouping via drag), id as the stable tiebreak
  // so newly-added snippets land at the END of the list
  return db.prepare('SELECT * FROM saved_notes ORDER BY sort_order ASC, id ASC').all();
}

function addSavedNote(text, color = null) {
  const db = get();
  const existing = db.prepare('SELECT id FROM saved_notes WHERE text = ?').get(text);
  if (existing) {
    if (color) db.prepare('UPDATE saved_notes SET color = ? WHERE id = ?').run(color, existing.id);
    return getSavedNotes();
  }
  const nextOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM saved_notes').get().n;
  const count = db.prepare('SELECT COUNT(*) AS c FROM saved_notes').get().c;
  const c = color || SAVED_NOTE_PALETTE[count % SAVED_NOTE_PALETTE.length];
  db.prepare('INSERT INTO saved_notes (text, color, sort_order) VALUES (?, ?, ?)').run(text, c, nextOrder);
  return getSavedNotes();
}

function setSavedNoteColor(id, color) {
  get().prepare('UPDATE saved_notes SET color = ? WHERE id = ?').run(color || null, id);
  return getSavedNotes();
}

/** Persist a new left-to-right order. ids omitted keep their existing slot after the listed ones. */
function reorderSavedNotes(ids) {
  const db = get();
  const upd = db.prepare('UPDATE saved_notes SET sort_order = ? WHERE id = ?');
  db.transaction((list) => { list.forEach((id, i) => upd.run(i, id)); })(ids);
  return getSavedNotes();
}

function deleteSavedNote(id) {
  const db = get();
  db.prepare('DELETE FROM saved_notes WHERE id = ?').run(id);
  return getSavedNotes();
}

/**
 * Store the generated thumbnail path for a media row, and stamp the version
 * the viewer uses to cache-bust the /thumb URL.
 */
function setThumbnailPath(id, thumbPath) {
  const db = get();
  db.prepare("UPDATE media SET thumbnail_path = ?, thumb_version = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?")
    .run(thumbPath, id);
}

/**
 * Stamp a new thumbnail version without touching thumbnail_path — vault mode,
 * where the bytes live in the secure store and there is no path to record.
 */
function bumpThumbVersion(id, seconds) {
  const db = get();
  if (seconds) {
    db.prepare('UPDATE media SET thumb_version = ? WHERE id = ?').run(Math.floor(seconds), id);
    return;
  }
  db.prepare("UPDATE media SET thumb_version = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?").run(id);
}

/**
 * Record a view: increments the counter and stamps last_viewed_at.
 * @returns {object|null} the updated row
 */
function incrementViewCount(id) {
  const db = get();
  const result = db.prepare(`
    UPDATE media SET view_count = COALESCE(view_count, 0) + 1,
                     last_viewed_at = datetime('now')
    WHERE id = ?
  `).run(id);
  return result.changes > 0 ? getById(id) : null;
}

const HEATMAP_BUCKETS = 100;

/**
 * Increment the EVENT COUNT at the bucket for `position` in a marker heatmap
 * (`hot_heatmap` / `done_heatmap`) — one bump per 🔥/💦 mark, so repeated
 * moments accumulate into a more vibrant tint. Builds the 100-bucket array on
 * first use. `column` is an internal literal, never user input.
 * @param {string} column - 'hot_heatmap' | 'done_heatmap'
 */
function bumpMarkerBucket(id, column, position, duration) {
  if (!(position > 0) || !(duration > 0)) return;
  const db = get();
  const row = db.prepare(`SELECT ${column} AS h FROM media WHERE id = ?`).get(id);
  if (!row) return;

  let heat;
  try { heat = JSON.parse(row.h) || []; } catch { heat = []; }
  if (!Array.isArray(heat) || heat.length !== HEATMAP_BUCKETS) {
    heat = new Array(HEATMAP_BUCKETS).fill(0);
  }
  const bucket = Math.max(0, Math.min(HEATMAP_BUCKETS - 1,
    Math.floor((position / duration) * HEATMAP_BUCKETS)));
  heat[bucket] = (heat[bucket] || 0) + 1;

  db.prepare(`UPDATE media SET ${column} = ? WHERE id = ?`).run(JSON.stringify(heat), id);
}

/**
 * Record a "Done" — the user ended their viewing session on this item.
 * Bumps done_count, stamps time + position, and (for A/V with a known
 * duration) adds a bonus to the activity heatmap at that spot.
 * @returns {object|null} the updated row
 */
function markDone(id, position = 0) {
  const db = get();
  const row = getById(id);
  if (!row) return null;

  db.prepare(`
    UPDATE media SET done_count = COALESCE(done_count, 0) + 1,
                     last_done_at = datetime('now', 'localtime'),
                     last_done_position = ?
    WHERE id = ?
  `).run(Math.round(position * 10) / 10, id);

  bumpMarkerBucket(id, 'done_heatmap', position, row.duration_seconds);

  return getById(id);
}

/**
 * Record a "Hot" — the user flagged an intense moment on this item. Mirrors
 * markDone: bumps hot_count, stamps time + position, and adds a heatmap bonus
 * at that spot (for A/V with a known duration).
 * @returns {object|null} the updated row
 */
function markHot(id, position = 0) {
  const db = get();
  const row = getById(id);
  if (!row) return null;

  db.prepare(`
    UPDATE media SET hot_count = COALESCE(hot_count, 0) + 1,
                     last_hot_at = datetime('now', 'localtime'),
                     last_hot_position = ?
    WHERE id = ?
  `).run(Math.round(position * 10) / 10, id);

  bumpMarkerBucket(id, 'hot_heatmap', position, row.duration_seconds);

  return getById(id);
}

/**
 * Merge sparse watch-seconds into the item's 100-bucket activity heatmap.
 * @param {object} buckets - { bucketIndex: seconds, ... }
 * @returns {number[]} the updated heatmap
 */
function mergeHeatmap(id, buckets) {
  const db = get();
  const row = db.prepare('SELECT watch_heatmap FROM media WHERE id = ?').get(id);
  if (!row) return null;

  let heat;
  try { heat = JSON.parse(row.watch_heatmap) || []; } catch { heat = []; }
  if (!Array.isArray(heat) || heat.length !== HEATMAP_BUCKETS) {
    heat = new Array(HEATMAP_BUCKETS).fill(0);
  }

  for (const [idx, secs] of Object.entries(buckets || {})) {
    const i = Number(idx);
    const s = Number(secs);
    if (Number.isInteger(i) && i >= 0 && i < HEATMAP_BUCKETS && isFinite(s) && s > 0) {
      // Round to 0.1s so the JSON stays compact
      heat[i] = Math.round((heat[i] + Math.min(s, 3600)) * 10) / 10;
    }
  }

  db.prepare('UPDATE media SET watch_heatmap = ? WHERE id = ?')
    .run(JSON.stringify(heat), id);
  return heat;
}

// ── Duplicate detection ────────────────────────────────────────────────────

/**
 * Find a successfully-processed row that matches the given file by
 * normalized name + size within tolerance. Used at scan time to skip
 * re-analyzing rehosted copies. Pure index lookup — no file I/O.
 *
 * @returns {object|null} the best matching row (prefers exact size)
 */
function findDupeCandidate(nameKeyValue, mediaType, filesize, opts = {}) {
  const db = get();
  const tolerance = opts.tolerance ?? config.dupes.sizeTolerance;
  const lo = Math.floor(filesize * (1 - tolerance));
  const hi = Math.ceil(filesize * (1 + tolerance));

  const rows = db.prepare(`
    SELECT * FROM media
    WHERE name_key = ?
      AND media_type = ?
      AND processing_error IS NULL
      AND user_trashed = 0
      AND filesize_bytes BETWEEN ? AND ?
    ORDER BY ABS(filesize_bytes - ?) ASC
    LIMIT 1
  `).all(nameKeyValue, mediaType, lo, hi, filesize);

  return rows[0] || null;
}

/**
 * Assign a dupe group id to a set of rows.
 */
function setDupeGroup(ids, groupId) {
  const db = get();
  const stmt = db.prepare('UPDATE media SET dupe_group = ? WHERE id = ?');
  for (const id of ids) stmt.run(groupId, id);
}

/**
 * Get all members of a dupe group.
 */
function getDupeGroupMembers(groupId) {
  const db = get();
  return db.prepare('SELECT * FROM media WHERE dupe_group = ?').all(groupId);
}

/**
 * Write the same notes JSON to every member of a dupe group.
 * Notes are SHARED across confirmed dupes so deleting one copy never
 * loses them.
 */
function setGroupNotes(groupId, notesJson) {
  const db = get();
  return db.prepare('UPDATE media SET user_notes = ? WHERE dupe_group = ?')
    .run(notesJson, groupId);
}

// ── Trash bookkeeping (files are moved by lib/trash.js) ───────────────────

/**
 * Record that a file was moved to the trash folder.
 * filepath is updated to the trash location so playback keeps working.
 */
function markTrashed(id, trashPath, originalPath) {
  const db = get();
  db.prepare(`
    UPDATE media SET
      user_trashed = 1,
      trashed_original_path = ?,
      trashed_at = datetime('now'),
      filepath = ?
    WHERE id = ?
  `).run(originalPath, trashPath, id);
}

/**
 * Record that a file was restored from trash to its original path.
 */
function markUntrashed(id, originalPath) {
  const db = get();
  db.prepare(`
    UPDATE media SET
      user_trashed = 0,
      trashed_original_path = NULL,
      trashed_at = NULL,
      filepath = ?
    WHERE id = ?
  `).run(originalPath, id);
}

// ── Path migration (moved drives / renamed folders) ───────────────────────
//
// filepath is the library's only file identity, so a drive letter change makes
// every file look brand new and would cost a full rescan. These three helpers
// are what `node vault.js migrate` uses to repoint records instead.

/**
 * Every live (non-trashed) row, with just the columns needed to match a record
 * to a file on disk. One statement rather than a per-row lookup loop — the
 * migrate command touches the whole library and a 100k-row query is cheap
 * next to 100k prepared-statement round trips.
 */
function getMigrationRows() {
  const db = get();
  return db.prepare(`
    SELECT id, filepath, filename, media_type, filesize_bytes, name_key, phash, processing_error
    FROM media
    WHERE user_trashed = 0
    ORDER BY id
  `).all();
}

/**
 * Look a row up by path, ignoring case.
 *
 * getByPath() is exact, but Windows paths are not: the same file can be stored
 * as "K:\Media\x.mp4" by one walk and "k:\media\x.mp4" by another. Migration
 * has to see those as the SAME occupied path, or an "unoccupied" rewrite blows
 * up on filepath's UNIQUE index halfway through the run.
 */
function findByPathInsensitive(filepath) {
  const db = get();
  return db.prepare('SELECT * FROM media WHERE filepath = ? COLLATE NOCASE').get(filepath);
}

/**
 * Point an existing record at a new path, optionally deleting an unscanned
 * stub that already sits there (the row a drag-and-drop import created at the
 * new location before anyone realised the metadata already existed elsewhere).
 *
 * One transaction, because the order matters and half of it is worse than
 * neither half: the stub must be gone BEFORE the UPDATE or the UNIQUE index on
 * filepath rejects it, and a stub deleted without the update landing would lose
 * the row entirely. Nests as a savepoint inside deleteRecords' own transaction.
 *
 * Everything else on the record — id, AI metadata, notes, stars, ratings, view
 * counts, collections — is untouched. That is the entire point.
 */
function repointPath(id, newPath, absorbId = null) {
  const db = get();
  const { nameKey } = require('./dupes');
  const filename = require('path').basename(newPath);
  const run = db.transaction(() => {
    if (absorbId) deleteRecords([absorbId]);
    db.prepare('UPDATE media SET filepath = ?, filename = ?, name_key = ? WHERE id = ?')
      .run(newPath, filename, nameKey(filename), id);
  });
  run();
}

/**
 * Put a set of records into one shared dupe group.
 *
 * Relink uses it for the look-alikes it rejected: when several files under the
 * new root match one record and the tiebreak picks a winner, the losers are
 * very likely copies of the same content. Silently dropping them would hide
 * that, so they join the winner's group and the viewer's ⚠ Dupes filter
 * surfaces the lot.
 *
 * Group id follows the convention the rest of the codebase already uses (see
 * commands/scan.js tryDupeSkip and lib/dupes.js backfillDupes): keep the
 * lowest group any member already belongs to, otherwise the lowest id. Ids
 * that no longer exist — a stub deleted earlier in the same transaction —
 * simply update nothing.
 *
 * @returns {number|null} the group id used, or null if there was nothing to do
 */
function linkDupeGroup(ids) {
  const db = get();
  const unique = [...new Set(ids)].filter(Number.isInteger);
  if (unique.length < 2) return null;
  const rows = db.prepare(
    `SELECT id, dupe_group FROM media WHERE id IN (${unique.map(() => '?').join(',')})`
  ).all(...unique);
  if (rows.length < 2) return null;
  const existing = rows.map(r => r.dupe_group).filter(g => g != null);
  const groupId = existing.length ? Math.min(...existing) : Math.min(...rows.map(r => r.id));
  setDupeGroup(rows.map(r => r.id), groupId);
  return groupId;
}

// ── Saved searches (used by the viewer via the server API) ────────────────

function getSavedSearches() {
  const db = get();
  return db.prepare('SELECT * FROM saved_searches ORDER BY sort_order ASC, created_at DESC').all();
}

function addSavedSearch(name, searchText, filters, sortOrder = 0) {
  const db = get();
  return db.prepare(
    'INSERT INTO saved_searches (name, search_text, filters, sort_order) VALUES (?, ?, ?, ?)'
  ).run(name, searchText, JSON.stringify(filters || {}), sortOrder);
}

function deleteSavedSearch(id) {
  const db = get();
  return db.prepare('DELETE FROM saved_searches WHERE id = ?').run(id);
}

/**
 * Get database statistics
 */
function getStats() {
  const db = get();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN processing_error IS NULL THEN 1 ELSE 0 END) as success,
      SUM(CASE WHEN processing_error IS NOT NULL THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN explicit = 1 THEN 1 ELSE 0 END) as explicit_count
    FROM media
  `).get();

  const pending = db.prepare(`
    SELECT COUNT(*) as count FROM pending_operations WHERE executed = 0
  `).get();

  const byContentType = db.prepare(`
    SELECT content_type, COUNT(*) as count FROM media GROUP BY content_type ORDER BY count DESC
  `).all();

  const byLanguage = db.prepare(`
    SELECT language, COUNT(*) as count FROM media GROUP BY language ORDER BY count DESC
  `).all();

  const byMediaType = db.prepare(`
    SELECT media_type, COUNT(*) as count FROM media GROUP BY media_type ORDER BY count DESC
  `).all();

  return { stats, pending, byContentType, byLanguage, byMediaType };
}

/**
 * Get pending operations
 */
function getPendingOperations() {
  const db = get();
  return db.prepare('SELECT * FROM pending_operations WHERE executed = 0 ORDER BY id').all();
}

/**
 * Mark all pending operations as executed
 */
function markAllExecuted() {
  const db = get();
  return db.prepare(`
    UPDATE pending_operations SET executed = 1, executed_at = datetime('now') WHERE executed = 0
  `).run();
}

/**
 * Query media with filters
 */
function query(filters = {}, limit = 50) {
  const db = get();

  let sql = 'SELECT * FROM media WHERE 1=1';
  const params = [];

  if (filters.language) {
    sql += ' AND language LIKE ?';
    params.push(`%${filters.language}%`);
  }
  if (filters.theme) {
    sql += ' AND themes LIKE ?';
    params.push(`%${filters.theme}%`);
  }
  if (filters.content) {
    sql += ' AND content_type LIKE ?';
    params.push(`%${filters.content}%`);
  }
  if (filters.mediaType) {
    sql += ' AND media_type = ?';
    params.push(filters.mediaType);
  }
  if (filters.explicit === 'true') {
    sql += ' AND explicit = 1';
  } else if (filters.explicit === 'false') {
    sql += ' AND explicit = 0';
  }

  sql += ' ORDER BY processed_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Get all media records
 */
function getAll() {
  const db = get();
  const rows = db.prepare(`
    SELECT m.*, mc.themes AS themes_clean, mc.tags AS tags_clean, mc.locations AS locations_clean
    FROM media m LEFT JOIN media_clean mc ON mc.media_id = m.id
    ORDER BY m.filepath
  `).all();
  for (const r of rows) _withDerived(r);
  return rows;
}

module.exports = {
  PROBE_VERSION,
  saveStreamInfo,
  rowsNeedingProbe,
  getStreamIndex,
  saveStreamIndex,
  deleteStreamIndex,
  init,
  get,
  close,
  verifyPassword,
  isProcessed,
  hasVisionApiError,
  getProcessingStatus,
  insertStubs,
  UNSCANNED_MARKER,
  getVisionErrorCount,
  saveMedia,
  savePendingOperation,
  getMediaId,
  getById,
  getByPath,
  setUserFields,
  setAiFields,
  upsertClean,
  backfillClean,
  distinctCleanThemes,
  cleanArrayJson,
  deleteRecords,
  getSavedNotes,
  addSavedNote,
  setSavedNoteColor,
  reorderSavedNotes,
  deleteSavedNote,
  getCollections,
  createCollection,
  deleteCollection,
  updateCollection,
  getCollectionItems,
  collectionItemCount,
  collectionFirstIds,
  getMembershipCounts,
  addToCollection,
  removeFromCollection,
  collectionsForMedia,
  totalCollectedCount,
  setThumbnailPath,
  bumpThumbVersion,
  incrementViewCount,
  markDone,
  markHot,
  mergeHeatmap,
  markTrashed,
  markUntrashed,
  findDupeCandidate,
  linkDupeGroup,
  getMigrationRows,
  findByPathInsensitive,
  repointPath,
  setDupeGroup,
  getDupeGroupMembers,
  setGroupNotes,
  getSavedSearches,
  addSavedSearch,
  deleteSavedSearch,
  getStats,
  getPendingOperations,
  markAllExecuted,
  query,
  getAll,
};
