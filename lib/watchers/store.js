/**
 * Folder watchers: the database side. The watched_folders table (created by
 * lib/database.js init) and every media write a watcher makes, batched: one
 * transaction per batch, never one per file.
 *
 * Nothing here touches the disk. Every function takes the open connection
 * from lib/database.js get(), so a locked library (no connection) throws
 * before anything is written; the manager checks the lock first anyway.
 */

const path = require('path');
const database = require('../database');
const rules = require('./rules');

const MODES = ['live', 'timer', 'manual'];
const NEW_FILES = ['analyse', 'add_only'];
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 24 * 60;
const MIN_SIZE_MAX = 10 * 1024 * 1024 * 1024;   // 10 GB, anything bigger is a typo

function db() { return database.get(); }

function parseJson(text, fallback) {
  try { const v = JSON.parse(text); return v == null ? fallback : v; } catch { return fallback; }
}

/** A table row as the rest of the code (and the API) sees it. */
function rowToFolder(r) {
  if (!r) return null;
  return {
    id: r.id,
    path: r.path,
    enabled: !!r.enabled,
    mode: MODES.includes(r.mode) ? r.mode : 'live',
    intervalMin: r.interval_min || 15,
    newFiles: NEW_FILES.includes(r.new_files) ? r.new_files : 'analyse',
    includeSubfolders: !!r.include_subfolders,
    types: rules.normalizeTypes(parseJson(r.types, rules.DEFAULT_TYPES)),
    skipPatterns: rules.normalizePatterns(parseJson(r.skip_patterns, rules.DEFAULT_SKIP_PATTERNS)),
    minSizeBytes: Math.max(0, r.min_size_bytes || 0),
    createdAt: r.created_at,
    lastScanAt: r.last_scan_at || null,
    lastChangeAt: r.last_change_at || null,
    lastError: r.last_error || null,
  };
}

function listFolders() {
  return db().prepare('SELECT * FROM watched_folders ORDER BY path').all().map(rowToFolder);
}

function getFolder(id) {
  return rowToFolder(db().prepare('SELECT * FROM watched_folders WHERE id = ?').get(id));
}

/**
 * Check and clean an options patch from the API. Unknown keys are ignored.
 * Throws an Error with .status 400 and a plain-words message.
 */
function cleanOptions(patch) {
  const out = {};
  const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
  if (patch == null || typeof patch !== 'object') return out;
  if (patch.mode !== undefined) {
    if (!MODES.includes(patch.mode)) bad('How to watch must be live, timer or manual.');
    out.mode = patch.mode;
  }
  if (patch.intervalMin !== undefined) {
    const n = Number(patch.intervalMin);
    if (!Number.isInteger(n) || n < INTERVAL_MIN || n > INTERVAL_MAX) bad(`Check every must be a whole number of minutes from ${INTERVAL_MIN} to ${INTERVAL_MAX}.`);
    out.intervalMin = n;
  }
  if (patch.newFiles !== undefined) {
    if (!NEW_FILES.includes(patch.newFiles)) bad('New files must be "analyse" or "add_only".');
    out.newFiles = patch.newFiles;
  }
  if (patch.includeSubfolders !== undefined) out.includeSubfolders = !!patch.includeSubfolders;
  if (patch.enabled !== undefined) out.enabled = !!patch.enabled;
  if (patch.types !== undefined) {
    if (!Array.isArray(patch.types)) bad('File types must be a list.');
    const t = rules.normalizeTypes(patch.types);
    if (!t.length) bad('Pick at least one file type.');
    out.types = t;
  }
  if (patch.skipPatterns !== undefined) {
    if (!Array.isArray(patch.skipPatterns) && typeof patch.skipPatterns !== 'string') bad('Skip these must be a list.');
    out.skipPatterns = rules.normalizePatterns(patch.skipPatterns);
  }
  if (patch.minSizeBytes !== undefined) {
    const n = Number(patch.minSizeBytes);
    if (!Number.isFinite(n) || n < 0 || n > MIN_SIZE_MAX) bad('Smaller than must be a size from 0 to 10 GB.');
    out.minSizeBytes = Math.trunc(n);
  }
  return out;
}

function insertFolder(folderPath, opts = {}) {
  const now = Date.now();
  const info = db().prepare(`INSERT INTO watched_folders
      (path, enabled, mode, interval_min, new_files, include_subfolders, types, skip_patterns, min_size_bytes, created_at)
      VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    folderPath,
    opts.mode || 'live',
    opts.intervalMin || 15,
    opts.newFiles || 'analyse',
    opts.includeSubfolders === false ? 0 : 1,
    JSON.stringify(opts.types || rules.DEFAULT_TYPES),
    JSON.stringify(opts.skipPatterns || rules.DEFAULT_SKIP_PATTERNS),
    opts.minSizeBytes || 0,
    now,
  );
  return getFolder(Number(info.lastInsertRowid));
}

const COLS = {
  mode: 'mode', intervalMin: 'interval_min', newFiles: 'new_files', includeSubfolders: 'include_subfolders',
  enabled: 'enabled', types: 'types', skipPatterns: 'skip_patterns', minSizeBytes: 'min_size_bytes',
};

function updateFolder(id, clean) {
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(COLS)) {
    if (clean[k] === undefined) continue;
    let v = clean[k];
    if (k === 'types' || k === 'skipPatterns') v = JSON.stringify(v);
    if (typeof v === 'boolean') v = v ? 1 : 0;
    sets.push(`${col} = ?`);
    vals.push(v);
  }
  if (sets.length) db().prepare(`UPDATE watched_folders SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getFolder(id);
}

function deleteFolder(id) {
  return db().prepare('DELETE FROM watched_folders WHERE id = ?').run(id).changes > 0;
}

function noteFolder(id, fields) {
  const map = { lastScanAt: 'last_scan_at', lastChangeAt: 'last_change_at', lastError: 'last_error' };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(map)) {
    if (fields[k] === undefined) continue;
    sets.push(`${col} = ?`);
    vals.push(fields[k]);
  }
  if (sets.length) db().prepare(`UPDATE watched_folders SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

/* ── Media rows under a folder ──────────────────────────────────────────── */

/**
 * Windows paths are case-insensitive: K:\Media\a.jpg and k:\media\A.JPG are
 * one file. So on Windows every lookup here compares with NOCASE, which the
 * idx_media_filepath_nocase index serves once it is built (library-index
 * WATCH_INDEXES; until then the same queries scan, slower but right). The
 * stored path keeps the case the file really has.
 *
 * Some older rows were recorded with forward slashes (C:/Media/a.jpg). Every
 * lookup here also tries that spelling, so the watcher never takes one of
 * those for a new file. (Nothing rewrites them; see the week 1 report.)
 */
const WIN = process.platform === 'win32';
const NC = WIN ? ' COLLATE NOCASE' : '';
const slashed = (p) => (WIN && p.includes('\\') ? p.replace(/\\/g, '/') : null);

/**
 * Statements used once per file are prepared once per connection (a lock and
 * unlock is a new connection, so they are keyed by it).
 */
const _stmts = new WeakMap();
function stmt(sql) {
  const conn = db();
  let m = _stmts.get(conn);
  if (!m) { m = new Map(); _stmts.set(conn, m); }
  let s = m.get(sql);
  if (!s) { s = conn.prepare(sql); m.set(sql, s); }
  return s;
}

/**
 * The filepath range holding everything below `root`: [root\, root]),
 * because ']' is the character after '\' (in binary and in NOCASE order).
 * `sep` '/' gives the range of rows spelled with forward slashes.
 */
function prefixRange(root, sep = path.sep) {
  let base = root.replace(/[\\/]+$/, '');
  if (sep === '/') base = base.replace(/\\/g, '/');
  const next = String.fromCharCode(sep.charCodeAt(0) + 1);
  return [base + sep, base + next];
}

const UNDER_COLS = 'id, filepath, filesize_bytes, file_mtime_ms, missing_since, processing_error, quick_hash';

/**
 * Page through the rows below `root`, `limit` at a time, in (path NOCASE, id)
 * order: keyset paging, each page one bounded index range read (both range
 * bounds stay on the index; checked with EXPLAIN). `after` is the last row of
 * the previous page, or null. Trashed rows are left out: their file sits in
 * the trash on purpose. `sep` '/' pages the forward-slash spellings instead.
 * @returns {Array<{id, filepath, filesize_bytes, file_mtime_ms, missing_since, processing_error, quick_hash}>}
 */
function rowsUnder(root, after, limit, sep = path.sep) {
  const [lo, hi] = prefixRange(root, sep);
  if (after) {
    return stmt(`SELECT ${UNDER_COLS} FROM media
        WHERE filepath >= ?${NC} AND filepath < ?${NC} AND (filepath > ?${NC} OR id > ?)
          AND COALESCE(user_trashed, 0) = 0
        ORDER BY filepath${NC}, id LIMIT ?`).all(after.filepath, hi, after.filepath, after.id, limit);
  }
  return stmt(`SELECT ${UNDER_COLS} FROM media
      WHERE filepath >= ?${NC} AND filepath < ?${NC} AND COALESCE(user_trashed, 0) = 0
      ORDER BY filepath${NC}, id LIMIT ?`).all(lo, hi, limit);
}

const ROW_COLS = 'id, filepath, filesize_bytes, file_mtime_ms, missing_since, processing_error, user_trashed, quick_hash';

/** One row by path: exact first, then the forward-slash spelling, then (Windows) any case. */
function rowAt(filepath) {
  const exact = stmt(`SELECT ${ROW_COLS} FROM media WHERE filepath = ?`);
  let r = exact.get(filepath);
  const alt = slashed(filepath);
  if (!r && alt) r = exact.get(alt);
  if (r || !WIN) return r || null;
  const nc = stmt(`SELECT ${ROW_COLS} FROM media WHERE filepath = ? COLLATE NOCASE ORDER BY id LIMIT 1`);
  // NOCASE only (A-Z). A case variant outside A-Z (é / É) is not looked for
  // here: scanning a folder in JS per lookup was far too slow (week 1 known
  // limit; week 2 adds an indexed fold-key column). manager.js covers the live
  // rename through the file system instead (realpath).
  return nc.get(filepath) || (alt ? nc.get(alt) : null) || null;
}

/**
 * Missing rows of this size whose modified time is this one or was never
 * recorded (rows from before this build): candidates for a file that went
 * missing and has turned up again. The caller decides with the quick
 * fingerprint or the file name (manager.js). idx_media_missing_size holds only
 * missing rows.
 */
function missingCandidates(size, mtimeMs, limit = 50) {
  if (!(size > 0)) return [];
  return stmt(`SELECT id, filepath, filesize_bytes, file_mtime_ms, quick_hash FROM media
      WHERE missing_since IS NOT NULL AND filesize_bytes = ?
        AND (file_mtime_ms = ? OR file_mtime_ms IS NULL) AND COALESCE(user_trashed, 0) = 0
      LIMIT ?`).all(size, Number.isFinite(mtimeMs) ? Math.trunc(mtimeMs) : -1, limit);
}

/* ── Batched writes ─────────────────────────────────────────────────────── */

/*
 * Every write below takes { id, path } items (a bare id is allowed for
 * callers that have no path) and only touches a row whose filepath is still
 * the path the decision was made for. A relink (migrate) or another write
 * that moved the row in between makes the write a no-op instead of marking
 * the wrong file.
 */
const asItem = (x) => (typeof x === 'object' && x ? x : { id: x, path: null });
const PATH_OK = 'AND (? IS NULL OR filepath = ?)';

/** Mark rows missing (every other field kept). @returns {number} changed */
function markMissing(items, at = Date.now()) {
  if (!items.length) return 0;
  const st = stmt(`UPDATE media SET missing_since = ? WHERE id = ? AND missing_since IS NULL ${PATH_OK}`);
  return db().transaction((list) => list.reduce((n, x) => {
    const it = asItem(x);
    return n + st.run(at, it.id, it.path || null, it.path || null).changes;
  }, 0))(items);
}

/** Clear missing for rows whose file is back. @returns {number} changed */
function clearMissing(items) {
  if (!items.length) return 0;
  const st = stmt(`UPDATE media SET missing_since = NULL WHERE id = ? AND missing_since IS NOT NULL ${PATH_OK}`);
  return db().transaction((list) => list.reduce((n, x) => {
    const it = asItem(x);
    return n + st.run(it.id, it.path || null, it.path || null).changes;
  }, 0))(items);
}

/**
 * Record size + mtime without calling it a change (rows from before
 * file_mtime_ms). Path-checked like every other write; an item with no path
 * is skipped rather than written blind.
 */
function backfillStats(list) {
  const items = list.filter(it => it.path);
  if (!items.length) return 0;
  const st = stmt('UPDATE media SET file_mtime_ms = ?, filesize_bytes = COALESCE(filesize_bytes, ?) WHERE id = ? AND filepath = ?');
  return db().transaction((xs) => xs.reduce((n, it) => n + st.run(Math.trunc(it.mtimeMs), it.size, it.id, it.path).changes, 0))(items);
}

/**
 * Store a backfilled quick fingerprint (fingerprint.quickHashStat). Only into
 * a row that has none yet, at the same path, whose recorded size and modified
 * time are the very ones of the copy the fingerprint was read from: a
 * fingerprint read before an edit can never overwrite (or fill in for) the
 * file as it is now.
 */
function setQuickHash(list) {
  const items = list.filter(it => it.path && it.hash && Number.isFinite(it.size) && Number.isFinite(it.mtimeMs));
  if (!items.length) return 0;
  const st = stmt(`UPDATE media SET quick_hash = ? WHERE id = ? AND filepath = ? AND quick_hash IS NULL
      AND filesize_bytes = ? AND file_mtime_ms = ?`);
  return db().transaction((xs) => xs.reduce((n, it) => n + st.run(it.hash, it.id, it.path, it.size, Math.trunc(it.mtimeMs)).changes, 0))(items);
}

/**
 * A file changed in place: new size and mtime, and a processing error from
 * the old copy is cleared (WATCHERS_SPEC: the reported bug was a file probed
 * mid-copy keeping "Could not read media info"). A row that was analysed
 * keeps its analysis; a row that never was goes back to 'unscanned'. The old
 * fingerprint no longer describes the file and is dropped (or replaced).
 * @returns {Array<{id, analysed: boolean}>} only the rows actually written
 */
function markChanged(list) {
  if (!list.length) return [];
  const sel = stmt('SELECT processing_error FROM media WHERE id = ?');
  const upd = stmt(`UPDATE media SET filesize_bytes = ?, file_mtime_ms = ?, missing_since = NULL, quick_hash = ?,
      processing_error = CASE WHEN processing_error IS NULL OR processing_error = '' THEN processing_error ELSE 'unscanned' END
      WHERE id = ? ${PATH_OK}`);
  return db().transaction((items) => {
    const out = [];
    for (const it of items) {
      const r = sel.get(it.id);
      if (upd.run(it.size, Math.trunc(it.mtimeMs), it.hash || null, it.id, it.path || null, it.path || null).changes) {
        out.push({ id: it.id, analysed: !!r && !r.processing_error });
      }
    }
    return out;
  })(list);
}

/**
 * Moved or renamed: repoint the row (id, tags, notes, everything stays).
 * Only when the row is still at oldPath, and only when nothing else sits at
 * the new path (a case-only rename finds the row itself there, which is fine).
 * @returns {number} rows repointed
 */
function applyMoves(list) {
  if (!list.length) return 0;
  const cur = stmt('SELECT filepath FROM media WHERE id = ?');
  const upd = stmt('UPDATE media SET file_mtime_ms = ?, filesize_bytes = ?, quick_hash = COALESCE(?, quick_hash) WHERE id = ?');
  return db().transaction((items) => {
    let n = 0;
    for (const it of items) {
      const now = cur.get(it.id);
      if (!now || (it.oldPath && now.filepath !== it.oldPath)) continue;
      const occ = rowAt(it.newPath);
      if (occ && occ.id !== it.id) continue;
      database.repointPath(it.id, it.newPath);
      upd.run(Math.trunc(it.mtimeMs), it.size, it.hash || null, it.id);
      n++;
    }
    return n;
  })(list);
}

/** Clear the New mark for rows the user has now seen. */
function markSeen(ids) {
  if (!ids.length) return 0;
  const st = stmt('UPDATE media SET watch_new = 0 WHERE id = ? AND watch_new <> 0');
  return db().transaction((list) => list.reduce((n, id) => n + st.run(id).changes, 0))(ids);
}

function markAllSeen() {
  return db().prepare('UPDATE media SET watch_new = 0 WHERE COALESCE(watch_new, 0) <> 0').run().changes;
}

/* ── Counts, in slices ──────────────────────────────────────────────────── */

const yieldNow = () => new Promise(resolve => setImmediate(resolve));
const COUNT_STEP = 20000;

/**
 * Count the rows below `root` (optionally only those matching `where`, a
 * fixed SQL condition), a slice at a time: each step jumps COUNT_STEP rows
 * ahead along the (path NOCASE, id) order with OFFSET, which reads index
 * entries only, and the event loop runs between steps. A plain count(*) over
 * a 2M-row root holds the server for seconds. `cancelled()` stops it (null).
 */
async function countUnder(root, { where = '', index = null, step = COUNT_STEP, cancelled = () => false } = {}) {
  const [lo, hi] = prefixRange(root);
  const cond = where ? ` AND ${where}` : '';
  const from = index ? `media INDEXED BY ${index}` : 'media';
  const first = stmt(`SELECT filepath, id FROM ${from} WHERE filepath >= ?${NC} AND filepath < ?${NC}${cond}
      ORDER BY filepath${NC}, id LIMIT 1 OFFSET ?`);
  const next = stmt(`SELECT filepath, id FROM ${from} WHERE filepath >= ?${NC} AND filepath < ?${NC}
      AND (filepath > ?${NC} OR id > ?)${cond} ORDER BY filepath${NC}, id LIMIT 1 OFFSET ?`);
  const tail = stmt(`SELECT count(*) FROM (SELECT 1 FROM ${from} WHERE filepath >= ?${NC} AND filepath < ?${NC}
      AND (? IS NULL OR filepath > ?${NC} OR id > ?)${cond} LIMIT ?)`);
  let n = 0;
  let at = null;
  for (;;) {
    if (cancelled()) return null;
    const mark = at ? next.get(at.filepath, hi, at.filepath, at.id, step - 1) : first.get(lo, hi, step - 1);
    if (!mark) {
      const p = at ? at.filepath : null;
      return n + tail.pluck().get(at ? at.filepath : lo, hi, p, p, at ? at.id : 0, step);
    }
    n += step;
    at = mark;
    await yieldNow();
  }
}

/**
 * Counts for the activity pill, per folder: new (not seen yet) and missing,
 * in slices (countUnder). Until the watchers' indexes exist (library-index
 * buildWatchIndexes) these would scan the library, so they wait and report
 * zero instead.
 */
async function activityCounts(folders, { cancelled = () => false } = {}) {
  const li = require('../library-index');
  const newBy = new Map();
  const missingBy = new Map();
  let newTotal = 0;
  const NEWX = li.FLAG_INDEXES.watchNew[0];
  const MISSX = li.FLAG_INDEXES.missing[0];
  const ready = li.hasIndex(db(), NEWX) && li.hasIndex(db(), MISSX);
  if (!ready) return { newBy, missingBy, newTotal, pending: true };
  newTotal = db().prepare(`SELECT count(*) FROM media INDEXED BY ${NEWX} WHERE COALESCE(watch_new, 0) <> 0`).pluck().get();
  for (const f of folders) {
    // Each reads only its own partial index (new rows / missing rows), by path.
    const nw = newTotal ? await countUnder(f.path, { where: 'COALESCE(watch_new, 0) <> 0', index: NEWX, cancelled }) : 0;
    const ms = await countUnder(f.path, { where: 'missing_since IS NOT NULL', index: MISSX, cancelled });
    if (nw === null || ms === null) return null;
    newBy.set(f.id, nw);
    missingBy.set(f.id, ms);
  }
  return { newBy, missingBy, newTotal };
}

/** How many library rows sit below a folder (the Settings row's file count), in slices. */
function fileCount(root, opts = {}) {
  return countUnder(root, opts);
}

module.exports = {
  MODES, NEW_FILES, rowToFolder, listFolders, getFolder, cleanOptions, insertFolder, updateFolder,
  deleteFolder, noteFolder, prefixRange, rowsUnder, rowAt, missingCandidates,
  markMissing, clearMissing, backfillStats, setQuickHash, markChanged, applyMoves, markSeen, markAllSeen,
  activityCounts, fileCount, countUnder,
};