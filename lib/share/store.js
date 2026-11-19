/**
 * Share privately: what Vault remembers about shares (spec 6.5).
 *
 * Everything lives in the LIBRARY DATABASE, never in vault-settings.json.
 * With a Vault password set the database is encrypted, so the passwords and
 * gofile tokens below are encrypted at rest with it. With no Vault password
 * they are stored in the clear; that is what the one-time warning says.
 *
 *   share_accounts  id, token, created_at, session
 *   shares          one row per share (see the CREATE below)
 *   share_parts     share_id, part_no, file_name, size, mtime_ms, status,
 *                   file_id, md5, tries, error
 *   share_files     share_id, file_name, size, media_id (only while "Which
 *                   files were in each share" is on)
 *   share_kv        key, value: the saved default password and the
 *                   "warning shown" flag
 *
 * Times are ms since the epoch. Reads that go to the page never include
 * shares.password or share_accounts.token (publicShare()).
 */

const database = require('../database');

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS share_accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      session     TEXT
    );
    CREATE TABLE IF NOT EXISTS shares (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      archive_name      TEXT NOT NULL,
      name_typed        INTEGER NOT NULL DEFAULT 0,
      link              TEXT,
      code              TEXT,
      folder_id         TEXT,
      account_id        INTEGER,
      password          TEXT,
      password_kind     TEXT NOT NULL DEFAULT 'random',
      size              INTEGER NOT NULL DEFAULT 0,
      part_count        INTEGER NOT NULL DEFAULT 0,
      part_size         INTEGER,
      file_count        INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      uploaded_at       INTEGER,
      delete_after_days INTEGER NOT NULL DEFAULT 7,
      delete_after      INTEGER,
      timer_set         INTEGER NOT NULL DEFAULT 0,
      deleted_at        INTEGER,
      last_error        TEXT,
      work_dir          TEXT,
      checks            TEXT,
      keep_local        INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS share_parts (
      share_id   INTEGER NOT NULL,
      part_no    INTEGER NOT NULL,
      file_name  TEXT NOT NULL,
      size       INTEGER NOT NULL,
      mtime_ms   INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'waiting',
      file_id    TEXT,
      md5        TEXT,
      tries      INTEGER NOT NULL DEFAULT 0,
      error      TEXT,
      PRIMARY KEY (share_id, part_no)
    );
    CREATE TABLE IF NOT EXISTS share_files (
      share_id   INTEGER NOT NULL,
      file_name  TEXT NOT NULL,
      size       INTEGER NOT NULL,
      media_id   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_share_files_share ON share_files(share_id);
    CREATE TABLE IF NOT EXISTS share_kv (key TEXT PRIMARY KEY, value TEXT);
  `);
  // Later columns go here, each guarded by a PRAGMA table_info check (the
  // pattern in lib/database.js).
  const cols = new Set(db.prepare('PRAGMA table_info(shares)').all().map(c => c.name));
  for (const [name, type] of [['keep_local', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE shares ADD COLUMN ${name} ${type}`);
  }
}

const db = () => database.get();

/*
 * SECURE DELETE. Passwords, links and gofile tokens live in these tables. With
 * no Vault password the library file is not encrypted, and SQLite normally
 * leaves a deleted or replaced value in the file's free space, where a byte
 * search finds it. So every write here runs with PRAGMA secure_delete on
 * (zeros over what it frees), and the connection's own setting is put back
 * afterwards (the rest of Vault keeps its speed). The library uses the
 * rollback journal (journal_mode DELETE): the journal file is removed at each
 * commit, so no copy of a cleared value stays in a file Vault keeps.
 */
function _secure(fn) {
  const d = db();
  let prev = null;
  try { prev = Number(d.pragma('secure_delete', { simple: true })) ? 1 : 0; } catch { prev = null; }
  if (prev !== 1) { try { d.pragma('secure_delete = 1'); } catch { /* old SQLite: best effort */ } }
  try {
    return fn(d);
  } finally {
    if (prev === 0) { try { d.pragma('secure_delete = 0'); } catch {} }
  }
}

/* ── shares ─────────────────────────────────────────────────────────────── */

const SHARE_COLS = new Set(['archive_name', 'name_typed', 'link', 'code', 'folder_id', 'account_id', 'password',
  'password_kind', 'size', 'part_count', 'part_size', 'file_count', 'status', 'created_at', 'uploaded_at',
  'delete_after_days', 'delete_after', 'timer_set', 'deleted_at', 'last_error', 'work_dir', 'checks', 'keep_local']);

function insertShare(row) {
  const keys = Object.keys(row).filter(k => SHARE_COLS.has(k));
  const r = db().prepare(`INSERT INTO shares (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(k => row[k]));
  return Number(r.lastInsertRowid);
}

function updateShare(id, patch) {
  const keys = Object.keys(patch).filter(k => SHARE_COLS.has(k));
  if (!keys.length) return;
  db().prepare(`UPDATE shares SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(k => patch[k]), id);
}

function getShare(id) {
  return db().prepare('SELECT * FROM shares WHERE id = ?').get(id) || null;
}

function listShares() {
  return db().prepare('SELECT * FROM shares ORDER BY created_at DESC, id DESC').all();
}

function sharesWithStatus(statuses) {
  return db().prepare(`SELECT * FROM shares WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`).all(...statuses);
}

function deleteShare(id) {
  const d = db();
  d.transaction(() => {
    d.prepare('DELETE FROM share_parts WHERE share_id = ?').run(id);
    d.prepare('DELETE FROM share_files WHERE share_id = ?').run(id);
    d.prepare('DELETE FROM shares WHERE id = ?').run(id);
  })();
}

/** Turning "Passwords of past shares" off: forget every stored share password. */
function clearSharePasswords() {
  return db().prepare('UPDATE shares SET password = NULL WHERE password IS NOT NULL').run().changes;
}

/** Turning "Which files were in each share" off: forget every file list. */
function clearFileLists() {
  return db().prepare('DELETE FROM share_files').run().changes;
}

/* ── parts and files ────────────────────────────────────────────────────── */

function setParts(shareId, parts) {
  const d = db();
  d.transaction(() => {
    d.prepare('DELETE FROM share_parts WHERE share_id = ?').run(shareId);
    const ins = d.prepare('INSERT INTO share_parts (share_id, part_no, file_name, size, mtime_ms, status) VALUES (?,?,?,?,?,?)');
    for (const p of parts) ins.run(shareId, p.partNo, p.fileName, p.size, p.mtimeMs, 'waiting');
  })();
}

function getParts(shareId) {
  return db().prepare('SELECT * FROM share_parts WHERE share_id = ? ORDER BY part_no').all(shareId);
}

const PART_COLS = new Set(['status', 'file_id', 'md5', 'tries', 'error']);
function updatePart(shareId, partNo, patch) {
  const keys = Object.keys(patch).filter(k => PART_COLS.has(k));
  if (!keys.length) return;
  db().prepare(`UPDATE share_parts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE share_id = ? AND part_no = ?`)
    .run(...keys.map(k => patch[k]), shareId, partNo);
}

function setFiles(shareId, files) {
  const d = db();
  d.transaction(() => {
    d.prepare('DELETE FROM share_files WHERE share_id = ?').run(shareId);
    const ins = d.prepare('INSERT INTO share_files (share_id, file_name, size, media_id) VALUES (?,?,?,?)');
    for (const f of files) ins.run(shareId, f.fileName, f.size, f.mediaId ?? null);
  })();
}

function getFiles(shareId) {
  return db().prepare('SELECT file_name, size, media_id FROM share_files WHERE share_id = ? ORDER BY rowid').all(shareId);
}

/* ── accounts ───────────────────────────────────────────────────────────── */

function insertAccount(token, session) {
  return Number(db().prepare('INSERT INTO share_accounts (token, created_at, session) VALUES (?,?,?)')
    .run(token, Date.now(), session).lastInsertRowid);
}

function getAccount(id) {
  return db().prepare('SELECT * FROM share_accounts WHERE id = ?').get(id) || null;
}

function latestAccount(session = undefined) {
  if (session === undefined) return db().prepare('SELECT * FROM share_accounts ORDER BY id DESC LIMIT 1').get() || null;
  return db().prepare('SELECT * FROM share_accounts WHERE session = ? ORDER BY id DESC LIMIT 1').get(session) || null;
}

/**
 * Forget accounts no share needs any more: no row points at them with a
 * gofile folder that may still exist, and they are not `keepId`.
 */
function pruneAccounts(keepId = null) {
  return db().prepare(`DELETE FROM share_accounts WHERE id IS NOT ?
    AND id NOT IN (SELECT account_id FROM shares WHERE account_id IS NOT NULL
      AND status NOT IN ('deleted','gone','cancelled'))`).run(keepId).changes;
}

/* ── key / value ────────────────────────────────────────────────────────── */

function kvGet(key) {
  const r = db().prepare('SELECT value FROM share_kv WHERE key = ?').get(key);
  return r ? r.value : null;
}
function kvSet(key, value) {
  if (value === null || value === undefined) db().prepare('DELETE FROM share_kv WHERE key = ?').run(key);
  else db().prepare('INSERT INTO share_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Every write runs with secure delete on (see _secure above).
const WRITES = {
  insertShare, updateShare, deleteShare, clearSharePasswords, clearFileLists,
  setParts, updatePart, setFiles, insertAccount, pruneAccounts, kvSet,
};
const secured = {};
for (const [name, fn] of Object.entries(WRITES)) secured[name] = (...args) => _secure(() => fn(...args));

module.exports = {
  ensureSchema,
  ...secured,
  getShare, listShares, sharesWithStatus,
  getParts, getFiles,
  getAccount, latestAccount,
  kvGet,
};
