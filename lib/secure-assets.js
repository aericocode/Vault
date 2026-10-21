/**
 * Secure assets store — encrypted SQLite home for DERIVED artifacts.
 *
 * When vault mode is on (a VAULT_DB_PASSWORD is set and the encrypted
 * SQLite module is available), every derived artifact the app used to write as
 * a plaintext file under thumbnailDir — thumbnails, hover-scrub frames, beat-
 * detection audio, subtitle VTTs — is stored as a BLOB in `secure_assets.db`
 * instead. Same cipher (better-sqlite3-multiple-ciphers, ChaCha20-Poly1305 by
 * default) and same passphrase as the main metadata DB, kept in lock-step by
 * lib/vault.js (rekey/lock/unlock apply to both files together).
 *
 * When NO password is set the store reports enabled() === false and every
 * caller falls back to today's on-disk filesystem behavior, byte-for-byte.
 *
 * The plaintext derived files leak content from removable/encrypted source
 * drives onto the local disk; routing them here keeps a locked vault's local
 * footprint free of viewable content.
 *
 * NOTE: crypto is SQLite-level only (no hand-rolled crypto, no new deps). A
 * `data BLOB` row is only as protected as the DB key — the same guarantee the
 * main metadata DB already provides.
 */

const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');
const config = require('../config');
const ownedDir = require('./owned-dir');
const { envVar } = require('./env-var');
const openGuard = require('./db-open-guard');
const { ROOT: _appRoot, isSea: _isSea } = require('./approot');

// Same native-module resolution as lib/database.js: packaged builds load the
// native addon from runtime/node_modules beside the exe; dev resolves from the
// repo's node_modules. We REQUIRE the multi-cipher build here — the store only
// exists to hold encrypted data, so without it the store stays disabled.
const _nativeRequire = _isSea
  ? createRequire(path.join(_appRoot, 'runtime', 'index.js'))
  : createRequire(__filename);

let Database = null;
let _hasCipher = false;
try {
  Database = _nativeRequire('better-sqlite3-multiple-ciphers');
  _hasCipher = true;
} catch {
  // No cipher build → vault mode itself can't encrypt (vault.setPassword throws
  // VAULT_NO_CIPHER), so the store simply never turns on.
}

// Single quotes in a passphrase are doubled — the pragma is a SQL string.
const esc = (p) => String(p).replace(/'/g, "''");

let _db = null;
// Set by close() (the vault locking, or shutdown): the store stays shut until
// unlock() / init() / rekey() open it on purpose. Without it, a late caller
// (a timer, a job finishing after the lock) would silently reopen the store
// with the remembered key while the vault reports itself locked.
let _sealed = false;
// The session key held in memory (mirrors the main DB connection staying open
// with its key). Seeded from the env password at load; vault lifecycle updates
// it on unlock / password change.
let _password = config.getDbPassword();

function storePath() {
  return config.paths.secureAssets;
}

/** True when derived artifacts should be routed through the encrypted store. */
function enabled() {
  return _hasCipher && !!_password;
}

function _applyKey(db) {
  if (_password && db.pragma) {
    try { db.pragma(`key='${esc(_password)}'`); } catch { /* may already be keyed */ }
  }
}

function _ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      media_id   INTEGER NOT NULL,
      kind       TEXT NOT NULL,              -- thumb | scrub0..scrub4 | beataudio | subtitle
      lang       TEXT NOT NULL DEFAULT '',   -- only meaningful for subtitle; '' otherwise
      data       BLOB NOT NULL,
      size       INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (media_id, kind, lang)
    );

    -- PMV preview stills are keyed by (job_id, idx), NOT (media_id, kind, lang):
    -- they belong to a transient render JOB, not a library media record, so they
    -- get their own table rather than being forced into the assets PK. Same
    -- encrypted DB, same key. Regenerable session artifacts (see migrateFromDisk
    -- for the startup purge).
    CREATE TABLE IF NOT EXISTS pmv_previews (
      job_id     TEXT NOT NULL,
      idx        INTEGER NOT NULL,
      data       BLOB NOT NULL,
      size       INTEGER NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (job_id, idx)
    );
  `);
  _ensureSizeIndex(db);
}

// Bookkeeping index for the size / "last shown" / delete-step queries.
//
// Why: `size` and `updated_at` sit AFTER the `data` BLOB in every assets row,
// and a 30 KB blob spills over a chain of overflow pages. SQLite can only reach
// the columns behind it by walking that chain, so a plain SUM(size) read the
// whole store (40k thumbnails = 1.2 GB decrypted, ~3.5 s with the event loop
// blocked). This index carries every column those queries read, so SQLite
// answers them from the index alone and never opens a blob page.
//
// Safe on existing stores: a plain CREATE INDEX works on an encrypted store
// under the key the connection already holds, rewrites no blob, and runs as
// one statement (a crash mid-build rolls back through the journal and the next
// open simply builds it again). IF NOT EXISTS makes every later open a no-op.
// The first build on a big store reads every row once (the same cost one old
// SUM(size) paid). A failed build (disk full, read-only volume) is logged and
// the store keeps working, only slower: it must never stop the store opening.
const SIZE_INDEX = 'assets_kind_media_size';

// A big store (an existing library unlocked for the first time on this
// version) builds the index just AFTER the open, not inside it: the open runs
// inside the unlock request, and at 900k rows the build takes ~20 s, which the
// unlock answer must not wait for. The build still holds the server while it
// runs, once. The sliced size readers below wait for it.
let _indexDeferRows = 50000;
let _indexPending = null;

function _buildSizeIndex(db) {
  try {
    const t0 = Date.now();
    db.exec(`CREATE INDEX IF NOT EXISTS ${SIZE_INDEX} ON assets (kind, media_id, size, updated_at)`);
    const ms = Date.now() - t0;
    if (ms >= 250) console.log(`[SecureAssets] built the size index in ${ms} ms (one time)`);
  } catch (err) {
    console.warn(`[SecureAssets] could not build the size index, size totals will be slow: ${err.message}`);
  }
}

function _ensureSizeIndex(db) {
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(SIZE_INDEX)) return;
    const rows = db.prepare('SELECT MAX(rowid) AS n FROM assets').get().n || 0;
    if (rows < _indexDeferRows) { _buildSizeIndex(db); return; }
    if (_indexPending) return;
    console.log(`[SecureAssets] building the size index for about ${rows} rows (one time, just after unlock)`);
    _indexPending = new Promise((resolve) => {
      setTimeout(() => {
        try { if (_db === db) _buildSizeIndex(db); } finally { _indexPending = null; resolve(); }
      }, 50);
    });
  } catch (err) {
    console.warn(`[SecureAssets] could not check the size index: ${err.message}`);
  }
}

/** Tests: the store size above which the index build waits until after the open. */
function _setIndexDeferRows(n) { _indexDeferRows = n; }

/**
 * Open (or return) the store connection, keyed with the session password.
 * Returns null when the store is disabled. Throws DB_ENCRYPTED (typed, like
 * database.init) when the file exists but the key is wrong.
 */
function conn() {
  if (_db) return _db;
  if (_sealed) return null;   // locked: reads find nothing, writes are refused
  if (!enabled()) return null;

  // Confirm the key before any read-write open: this store has its own hot
  // journal, and a wrong key would start rolling it back (see
  // lib/db-open-guard.js).
  if (!openGuard.keyFits(Database, storePath(), _password || null)) {
    const e = new Error('secure_assets.db is encrypted and the password is wrong');
    e.code = 'DB_ENCRYPTED';
    throw e;
  }

  const db = new Database(storePath());
  _applyKey(db);

  // Verify readability BEFORE any DDL — a wrong/missing key fails here with
  // SQLITE_NOTADB. Surface a typed error so vault lifecycle code can react.
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    try { db.close(); } catch {}
    const e = new Error('secure_assets.db is encrypted and the password is wrong');
    e.code = 'DB_ENCRYPTED';
    throw e;
  }

  _ensureSchema(db);
  _db = db;
  return _db;
}

/**
 * Explicit startup init. Sets the session password and opens the store when
 * enabled. No-op (returns false) when NO password is set (plaintext mode).
 *
 * HARD FAIL when a password IS set but the cipher module is unavailable: that
 * combination would silently write derived artifacts as PLAINTEXT while the
 * user believes vault mode is on. We refuse instead (typed VAULT_NO_CIPHER),
 * mirroring vault.setPassword's runtime guard — the main DB's own init does not
 * catch this at startup, so the store must. Other errors propagate.
 */
function init(password = config.getDbPassword()) {
  _password = password;
  _sealed = false;
  if (password && !_hasCipher) {
    const e = new Error(
      'VAULT_DB_PASSWORD is set but the encrypted-SQLite module ' +
      '"better-sqlite3-multiple-ciphers" is unavailable. Derived artifacts ' +
      '(thumbnails, scrub frames, beat-audio, subtitles) would be written as ' +
      'PLAINTEXT while you believe the vault is on. Refusing to start. Install ' +
      'the module (dev: `npm install`; packaged exe: the build must bundle it ' +
      'into runtime/node_modules beside the exe).');
    e.code = 'VAULT_NO_CIPHER';
    throw e;
  }
  if (!enabled()) return false;
  conn();
  return true;
}

/* ── CRUD ─────────────────────────────────────────────────────────────────── */

/** @returns {Buffer|null} the stored bytes, or null if absent/disabled. */
function get(media_id, kind, lang = '') {
  const db = conn();
  if (!db) return null;
  const row = db.prepare('SELECT data FROM assets WHERE media_id = ? AND kind = ? AND lang = ?')
    .get(media_id, kind, lang);
  return row ? row.data : null;
}

/** @returns {boolean} whether a row exists (false when disabled). */
function has(media_id, kind, lang = '') {
  const db = conn();
  if (!db) return false;
  return !!db.prepare('SELECT 1 FROM assets WHERE media_id = ? AND kind = ? AND lang = ?')
    .get(media_id, kind, lang);
}

/** Upsert bytes. @returns {boolean} true when written (false when disabled). */
function put(media_id, kind, data, lang = '') {
  const db = conn();
  if (!db) return false;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  db.prepare(`
    INSERT INTO assets (media_id, kind, lang, data, size, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(media_id, kind, lang) DO UPDATE SET
      data = excluded.data, size = excluded.size, updated_at = excluded.updated_at
  `).run(media_id, kind, lang, buf, buf.length);
  return true;
}

/**
 * put(), then read the row back and compare it byte for byte. The ONLY test a
 * caller may use before deleting the source of what it stored (a plaintext
 * file being migrated in): put() returns false while the store is sealed, and
 * a write that "succeeded" but cannot be read back is not a copy either.
 * Never throws. @returns {boolean} true only when the stored bytes equal `data`.
 */
function putVerified(media_id, kind, data, lang = '') {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!put(media_id, kind, buf, lang)) return false;
    const back = get(media_id, kind, lang);
    return !!back && Buffer.compare(back, buf) === 0;
  } catch {
    return false;
  }
}

/** True while the store is open and can take writes (not sealed, not disabled). */
function writable() {
  try { return !!conn(); } catch { return false; }
}

/** Delete one asset. @returns {number} rows removed. */
function del(media_id, kind, lang = '') {
  const db = conn();
  if (!db) return 0;
  return db.prepare('DELETE FROM assets WHERE media_id = ? AND kind = ? AND lang = ?')
    .run(media_id, kind, lang).changes;
}

/** Delete EVERY asset for a media id (called when a record is purged). */
function deleteAll(media_id) {
  const db = conn();
  if (!db) return 0;
  return db.prepare('DELETE FROM assets WHERE media_id = ?').run(media_id).changes;
}

/**
 * Delete every asset whose kind starts with `prefix`, across all media (face
 * crops are kind `face-<groupId>`: "Delete all face data" drops them in one go).
 * @returns {number} rows removed
 */
function deleteKindPrefix(prefix) {
  const db = conn();
  if (!db) return 0;
  const like = String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
  return db.prepare("DELETE FROM assets WHERE kind LIKE ? ESCAPE '\\'").run(like).changes;
}

/* ── Thumbnail bookkeeping (Settings > Library > Thumbnails) ──────────────── */

/**
 * Prepare `sql` with `{from}` replaced by the assets table pinned to the size
 * index, so the planner can't pick the primary key and then read the row (and
 * its blob) for `size`. Falls back to the bare table if the index is missing
 * (its build failed): slower, never wrong.
 */
function _prepSized(db, sql) {
  try {
    return db.prepare(sql.replace('{from}', `assets INDEXED BY ${SIZE_INDEX}`));
  } catch (err) {
    if (!/no such index/i.test(String(err && err.message))) throw err;
    return db.prepare(sql.replace('{from}', 'assets'));
  }
}

/** Bytes and row count per kind across the whole store. @returns {Array<{kind, bytes, count}>} */
function sizesByKind() {
  const db = conn();
  if (!db) return [];
  return _prepSized(db, 'SELECT kind, SUM(size) AS bytes, COUNT(*) AS count FROM {from} GROUP BY kind').all();
}

/* ── The same totals without holding the server still ──────────────────────
   sizesByKind() / mediaSizes() are one statement each: fine for a few
   thousand rows, but at 900k rows they hold the event loop for most of a
   second. These walk the size index a slice at a time (one kind, the next
   SIZE_CHUNK media ids after the last one seen), yielding between slices, so
   no single step takes more than a few milliseconds. A lock part way through
   (the store closes) ends the walk with null. */

const SIZE_CHUNK = 4000;
const _yieldTick = () => new Promise(r => setImmediate(r));

/** Every distinct kind, by seeking the index (no scan). */
function _kindsPresent(db) {
  const kinds = [];
  const st = _prepSized(db, 'SELECT kind FROM {from} WHERE kind > ? ORDER BY kind LIMIT 1');
  let last = '';
  for (;;) {
    const r = st.get(last);
    if (!r) break;
    kinds.push(r.kind);
    last = r.kind;
  }
  return kinds;
}

/**
 * Walk one kind's rows in media-id slices. fn(rows) gets
 * [{media_id, bytes, count, seen}] per slice. @returns {Promise<boolean>}
 * false when the store closed part way.
 */
async function _walkKind(kind, fn) {
  let after = Number.MIN_SAFE_INTEGER;
  for (;;) {
    const db = conn();
    if (!db) return false;
    const rows = _prepSized(db, `
      SELECT media_id, SUM(size) AS bytes, COUNT(*) AS count,
             CAST(strftime('%s', MAX(updated_at)) AS INTEGER) * 1000 AS seen
      FROM {from} WHERE kind = ? AND media_id > ?
      GROUP BY media_id ORDER BY media_id LIMIT ?`).all(kind, after, SIZE_CHUNK);
    if (!rows.length) return true;
    fn(rows);
    after = rows[rows.length - 1].media_id;
    if (rows.length < SIZE_CHUNK) return true;
    await _yieldTick();
  }
}

/** sizesByKind, in slices. @returns {Promise<Array<{kind, bytes, count}>|null>} */
async function sizesByKindAsync() {
  if (_indexPending) await _indexPending;
  const db = conn();
  if (!db) return null;
  const out = [];
  for (const kind of _kindsPresent(db)) {
    const t = { kind, bytes: 0, count: 0 };
    const ok = await _walkKind(kind, (rows) => {
      for (const r of rows) { t.bytes += r.bytes || 0; t.count += r.count || 0; }
    });
    if (!ok) return null;
    out.push(t);
    await _yieldTick();
  }
  return out;
}

/** mediaSizes(kinds) for every media id, in slices. @returns {Promise<Array|null>} */
async function mediaSizesAsync(kinds) {
  if (_indexPending) await _indexPending;
  const list = _kindList(kinds);
  if (!conn() || !list) return conn() ? [] : null;
  const per = new Map();
  for (const kind of list) {
    const ok = await _walkKind(kind, (rows) => {
      for (const r of rows) {
        const e = per.get(r.media_id);
        if (e) { e.bytes += r.bytes || 0; e.seen = Math.max(e.seen, r.seen || 0); }
        else per.set(r.media_id, { media_id: r.media_id, bytes: r.bytes || 0, seen: r.seen || 0 });
      }
    });
    if (!ok) return null;
  }
  return [...per.values()];
}

function _kindList(kinds) {
  const list = (kinds || []).filter(k => typeof k === 'string' && k);
  return list.length ? list : null;
}

/**
 * Bytes per media id over the given kinds, with the newest updated_at as a
 * millisecond timestamp (the "last shown" time the disk limit trims by).
 * @returns {Array<{media_id:number, bytes:number, seen:number}>}
 */
function mediaSizes(kinds, mediaId) {
  const db = conn();
  const list = _kindList(kinds);
  if (!db || !list) return [];
  const one = Number.isInteger(mediaId);
  return _prepSized(db, `
    SELECT media_id, SUM(size) AS bytes,
           CAST(strftime('%s', MAX(updated_at)) AS INTEGER) * 1000 AS seen
    FROM {from} WHERE kind IN (${list.map(() => '?').join(',')})${one ? ' AND media_id = ?' : ''}
    GROUP BY media_id
  `).all(...list, ...(one ? [mediaId] : []));
}

/**
 * Delete rows of the given kinds, for one media id or (mediaId omitted) all.
 * The caller passes literal kind names; nothing here matches by pattern.
 * @returns {number} rows removed
 */
function deleteKinds(kinds, mediaId) {
  const db = conn();
  const list = _kindList(kinds);
  if (!db || !list) return 0;
  const inList = list.map(() => '?').join(',');
  if (mediaId === undefined) {
    return db.prepare(`DELETE FROM assets WHERE kind IN (${inList})`).run(...list).changes;
  }
  if (!Number.isInteger(mediaId)) return 0;
  return db.prepare(`DELETE FROM assets WHERE media_id = ? AND kind IN (${inList})`).run(mediaId, ...list).changes;
}

// Wall-clock budget for one deleteKindsStep. Deleting a row is not cheap here:
// the cipher build runs with secure_delete on, so every freed blob page is read,
// journaled and overwritten with zeros (~0.8 ms per 30 KB row). A fixed row
// count (the old 2000 = 1.6 s) can't bound that, a time budget can.
// The commit (journal + fsync) comes on top, ~10-20 ms on an SSD.
const STEP_BUDGET_MS = 15;
const STEP_CHUNK = 8;

/**
 * One bounded step of deleting the given kinds across all media, so a huge
 * store is cleared in many short steps instead of one long one that would hold
 * the server still. Stops at `limit` rows or ~STEP_BUDGET_MS, whichever comes
 * first, in one transaction (one commit per step). Rows are found through the
 * size index (kind first), never by scanning the table. Call until it returns 0.
 * @returns {number} rows removed in this step
 */
function deleteKindsStep(kinds, limit = 500) {
  const db = conn();
  const list = _kindList(kinds);
  if (!db || !list) return 0;
  const max = Math.max(1, limit | 0);
  const inList = list.map(() => '?').join(',');
  const pick = _prepSized(db, `SELECT rowid AS r FROM {from} WHERE kind IN (${inList}) LIMIT ?`).pluck();
  const delRow = db.prepare('DELETE FROM assets WHERE rowid = ?');
  const t0 = Date.now();
  let n = 0;
  db.transaction(() => {
    while (n < max) {
      const ids = pick.all(...list, Math.min(STEP_CHUNK, max - n));
      if (!ids.length) break;
      for (const r of ids) n += delRow.run(r).changes;
      if (Date.now() - t0 >= STEP_BUDGET_MS) break;
    }
  })();
  return n;
}

/**
 * Delete the given kinds for a run of media ids: one transaction (one commit)
 * for the whole run instead of one per id, and at most ~STEP_BUDGET_MS of work.
 * Works from the front of the list and always finishes at least one id.
 * @returns {number} how many ids from the front of `mediaIds` were done; the
 *   caller continues from there. 0 only when the store is sealed or disabled.
 */
function deleteKindsMany(kinds, mediaIds) {
  const db = conn();
  const list = _kindList(kinds);
  if (!db || !list || !mediaIds || !mediaIds.length) return 0;
  const st = db.prepare(`DELETE FROM assets WHERE media_id = ? AND kind IN (${list.map(() => '?').join(',')})`);
  const t0 = Date.now();
  let i = 0;
  db.transaction(() => {
    while (i < mediaIds.length) {
      const id = mediaIds[i++];
      if (Number.isInteger(id)) st.run(id, ...list);
      if (Date.now() - t0 >= STEP_BUDGET_MS) break;
    }
  })();
  return i;
}

// An UPDATE rebuilds the whole row, so stamping one 30 KB row reads its blob
// (~0.2 ms). A big flush is split into budgeted slices, the rest on later ticks.
const TOUCH_BUDGET_MS = 20;

/**
 * Stamp rows as just used (the disk limit keeps the most recently shown).
 * Works for ~TOUCH_BUDGET_MS, then carries on with the rest on the next tick
 * (dropped if the store has been sealed by then: a missed stamp only makes a
 * picture look older than it is).
 * @returns {number} rows stamped in this call
 */
function touchMany(mediaIds, kind) {
  const db = conn();
  if (!db || !mediaIds.length) return 0;
  const st = db.prepare("UPDATE assets SET updated_at = datetime('now') WHERE media_id = ? AND kind = ?");
  const t0 = Date.now();
  let n = 0;
  let i = 0;
  db.transaction(() => {
    while (i < mediaIds.length) {
      n += st.run(mediaIds[i++], kind).changes;
      if (Date.now() - t0 >= TOUCH_BUDGET_MS) break;
    }
  })();
  if (i < mediaIds.length) {
    const rest = mediaIds.slice(i);
    setImmediate(() => { try { touchMany(rest, kind); } catch { /* store closed or gone */ } });
  }
  return n;
}

/* ── PMV preview stills (job-scoped) ──────────────────────────────────────── */

/** Get preview-still bytes for (job_id, idx), or null if absent/disabled. */
function getPmvPreview(job_id, idx) {
  const db = conn();
  if (!db) return null;
  const row = db.prepare('SELECT data FROM pmv_previews WHERE job_id = ? AND idx = ?')
    .get(String(job_id), idx);
  return row ? row.data : null;
}

/** Upsert one preview still. @returns {boolean} true when written. */
function putPmvPreview(job_id, idx, data) {
  const db = conn();
  if (!db) return false;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  db.prepare(`
    INSERT INTO pmv_previews (job_id, idx, data, size, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(job_id, idx) DO UPDATE SET
      data = excluded.data, size = excluded.size, updated_at = excluded.updated_at
  `).run(String(job_id), idx, buf, buf.length);
  return true;
}

/** Delete every preview still for a job (job discarded). @returns {number} rows. */
function deletePmvPreviews(job_id) {
  const db = conn();
  if (!db) return 0;
  return db.prepare('DELETE FROM pmv_previews WHERE job_id = ?').run(String(job_id)).changes;
}

/** Drop ALL preview stills (startup sweep — jobs don't resume across restarts). */
function clearAllPmvPreviews() {
  const db = conn();
  if (!db) return 0;
  return db.prepare('DELETE FROM pmv_previews').run().changes;
}

/* ── Vault lifecycle (kept in step with lib/vault.js) ─────────────────────── */

/** Close the connection — the store is sealed alongside the main DB on lock. */
function close() {
  if (_db) { try { _db.close(); } catch {} _db = null; }
  _sealed = true;
}

/** True between close() and the next unlock() / init(). */
function sealed() { return _sealed; }

/**
 * Reopen with the given passphrase (vault unlock). A wrong key throws
 * DB_ENCRYPTED — but since it's the SAME passphrase that just opened the main
 * DB, that should never happen in practice.
 */
function unlock(password) {
  _password = password;
  close();
  _sealed = false;
  try {
    conn();
  } catch (err) {
    // The vault stays locked when this throws (lib/vault.js), so the store must
    // stay sealed too: otherwise any later conn() would keep retrying the open.
    _sealed = true;
    throw err;
  }
}

/**
 * Encrypt-in-place / change the key (vault setPassword → PRAGMA rekey), mirror
 * of database rekey. Handles first-time enable: if the store file was created
 * before a password existed (plaintext), it opens plaintext then rekeys, so the
 * two DBs never diverge.
 */
function rekey(newPass) {
  if (!_hasCipher) return;
  _sealed = false;            // an explicit open, while unlocked

  // Ensure a connection exists under the CURRENT key (which may be none, for a
  // never-encrypted store, or the old key for a password change).
  let db = _db;
  if (!db) {
    if (!openGuard.keyFits(Database, storePath(), _password || null)) {
      const e = new Error('secure_assets.db is encrypted and the current password is wrong');
      e.code = 'DB_ENCRYPTED';
      throw e;
    }
    db = new Database(storePath());
    _applyKey(db);
    try {
      db.prepare('SELECT count(*) FROM sqlite_master').get();
    } catch (err) {
      try { db.close(); } catch {}
      const e = new Error('secure_assets.db is encrypted and the current password is wrong');
      e.code = 'DB_ENCRYPTED';
      throw e;
    }
    _ensureSchema(db);
    _db = db;
  }

  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  db.pragma(`rekey='${esc(newPass)}'`);
  _password = newPass;
}

/* ── First-time / startup migration ───────────────────────────────────────── */

// Plaintext derived-artifact filenames written by the pre-store code path.
const _RX_THUMB = /^(\d+)\.jpg$/;
const _RX_SCRUB = /^(\d+)_s([0-4])\.jpg$/;
const _RX_BEAT = /^(\d+)_beataudio\.m4a$/;          // legacy m4a beat cache
const _RX_BEAT_ADTS = /^(\d+)_beataudio\.aac$/;     // streaming ADTS beat cache
const _RX_VTT = /^(\d+)\.([A-Za-z_]{1,12})\.vtt$/;

/** True when `child` resolves at or inside `parent` (case/relativity aware). */
function _isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Effective subtitles source dir for migration — mirror of
 * lib/subtitles/repo.js TRACKS_DIR (the NON-vault canonical VTT location, hence
 * the pre-store plaintext the sweep imports). Kept as its own resolver so the
 * startup adoption pass and the sweep agree on exactly one path.
 */
function subtitlesDir() {
  return envVar('SUBS')
    || path.join(config.paths.thumbnailDir, 'subtitles');
}

/**
 * True when subtitlesDir() is a REDIRECTED root living outside thumbnailDir. In
 * that case the parent thumbnailDir marker does NOT govern it and its VTT sweep
 * needs the redirected root's OWN app-owned marker (adopted at startup / stamped
 * on app-created write). The default {thumbnailDir}/subtitles is inside the
 * already-guarded thumbnailDir, so it needs no separate marker.
 */
function subtitlesRedirected() {
  return !_isInside(subtitlesDir(), config.paths.thumbnailDir);
}

/**
 * Sweep thumbnailDir (and its subtitles/ subdir) for plaintext derived
 * artifacts, import them into the store, and delete the plaintext originals.
 * Idempotent — a second run finds nothing. Safe no-op when disabled.
 *
 * NOTE: a plain unlink is NOT forensic erasure — the plaintext bytes may
 * survive in unallocated disk space until overwritten. Acceptable per the
 * design (full at-rest protection needs volume-level encryption), but callers
 * relying on this for hard secrecy should wipe the volume, not just the files.
 *
 * A plaintext file is deleted ONLY after its encrypted copy was written and
 * read back identical (putVerified). Anything that could not be stored stays
 * on disk, is counted in `kept`, and the next run retries it. While the store
 * is sealed (vault locked) nothing at all is touched: `deferred` comes back
 * true and the caller runs the sweep again on the next unlock.
 *
 * @returns {{thumbs:number, scrubs:number, beat:number, subtitles:number,
 *   kept:number, undeleted:number, pmvFiles:number, pmvRows:number, deferred:boolean}}
 */
function migrateFromDisk() {
  const out = {
    thumbs: 0, scrubs: 0, beat: 0, subtitles: 0,
    kept: 0,          // could not be stored: plaintext left in place, retried next run
    undeleted: 0,     // stored, but the plaintext file could not be deleted (retried next run)
    pmvFiles: 0, pmvRows: 0,
    deferred: false,  // store sealed: nothing was done, run again after unlock
  };
  if (!enabled()) return out;

  // Locked vault: the store is sealed and refuses every write. Deleting a
  // plaintext file now would destroy it without a copy, so touch NOTHING on
  // disk. (conn() can throw DB_ENCRYPTED; that propagates, also with nothing
  // touched.)
  if (_sealed || !conn()) {
    out.deferred = true;
    console.log('[SecureAssets] plaintext migration deferred: the vault is locked. ' +
      'Files left in place until the next unlock');
    return out;
  }

  const thumbDir = config.paths.thumbnailDir;

  // This sweep DELETES plaintext files under thumbnailDir (and recursively rm's
  // pmv_previews subdirs). Gate the whole thing on the app-owned marker: if
  // thumbnailDir was pointed at user data (no marker), delete NOTHING. Startup
  // adoption (server) marks a legit pre-existing app cache dir before we get
  // here; a dir with unrecognized files stays unmarked and is skipped.
  if (!ownedDir.guardSweep(thumbDir, 'secure-assets migration/purge')) {
    // Still drop stale in-DB preview rows — that's not a filesystem delete.
    try { out.pmvRows = clearAllPmvPreviews(); } catch {}
    return out;
  }

  const subsDir = subtitlesDir();

  // Store, verify, and only then delete the plaintext source.
  const importFile = (fp, media_id, kind, lang = '') => {
    let buf;
    try { buf = fs.readFileSync(fp); } catch { return false; }   // vanished or unreadable: nothing to do
    if (!putVerified(Number(media_id), kind, buf, lang)) { out.kept++; return false; }
    try { fs.unlinkSync(fp); } catch { out.undeleted++; }
    return true;
  };

  let names = [];
  try { names = fs.readdirSync(thumbDir); } catch { names = []; }
  for (const name of names) {
    let m;
    if ((m = name.match(_RX_THUMB))) {
      if (importFile(path.join(thumbDir, name), m[1], 'thumb')) out.thumbs++;
    } else if ((m = name.match(_RX_SCRUB))) {
      if (importFile(path.join(thumbDir, name), m[1], `scrub${m[2]}`)) out.scrubs++;
    } else if ((m = name.match(_RX_BEAT))) {
      if (importFile(path.join(thumbDir, name), m[1], 'beataudio')) out.beat++;
    } else if ((m = name.match(_RX_BEAT_ADTS))) {
      // The streaming beat cache (server beatAudioAdts) — stored under its own
      // kind so cache reads keep hitting after migration.
      if (importFile(path.join(thumbDir, name), m[1], 'beataudio_adts')) out.beat++;
    }
  }

  // The subtitles sweep DELETES VTTs from subsDir. When subsDir lives inside the
  // already-guarded thumbnailDir (default {thumbnailDir}/subtitles), the parent
  // marker governs — no extra gate. But VAULT_SUBS can redirect it to an
  // INDEPENDENT root; without its own marker an unmarked user folder full of
  // VTT-pattern files would get absorbed+deleted under thumbnailDir's marker.
  // Require the redirected root's OWN marker, same refusal semantics as above.
  if (!subtitlesRedirected() || ownedDir.guardSweep(subsDir, 'secure-assets subtitle migration')) {
    let subNames = [];
    try { subNames = fs.readdirSync(subsDir); } catch { subNames = []; }
    for (const name of subNames) {
      const m = name.match(_RX_VTT);
      if (m && importFile(path.join(subsDir, name), m[1], 'subtitle', m[2])) out.subtitles++;
    }
  }

  // PMV preview stills are per-JOB, regenerable session artifacts — never
  // imported (they don't map to a media record and are worthless once the job
  // is gone). PURGE any plaintext residue under {thumbnailDir}/pmv_previews and
  // drop stale preview rows from the store (jobs don't resume across restarts).
  const pmvDir = path.join(thumbDir, 'pmv_previews');
  try {
    for (const jobDir of fs.readdirSync(pmvDir)) {
      const full = path.join(pmvDir, jobDir);
      let inner = [];
      try { inner = fs.readdirSync(full); } catch { inner = []; }
      out.pmvFiles += inner.filter(n => /^p_\d+\.jpg$/.test(n)).length;
      try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmdirSync(pmvDir); } catch {}
  } catch { /* no pmv_previews dir — nothing to purge */ }
  try { out.pmvRows = clearAllPmvPreviews(); } catch {}

  const total = out.thumbs + out.scrubs + out.beat + out.subtitles;
  if (total > 0) {
    const deleted = total - out.undeleted;
    console.log(`[SecureAssets] migrated ${total} plaintext artifact(s) into secure_assets.db ` +
      `(${out.thumbs} thumb, ${out.scrubs} scrub, ${out.beat} beat-audio, ${out.subtitles} subtitle). ` +
      (out.undeleted
        ? `${deleted} plaintext file(s) deleted, ${out.undeleted} could not be deleted and will be retried`
        : 'Plaintext deleted'));
  }
  if (out.kept > 0) {
    console.warn(`[SecureAssets] ${out.kept} plaintext artifact(s) could not be stored and were left in place ` +
      'untouched. The next start or unlock tries again');
  }
  if (out.pmvFiles > 0 || out.pmvRows > 0) {
    console.log(`[SecureAssets] purged ${out.pmvFiles} plaintext PMV preview file(s) and ` +
      `${out.pmvRows} stale preview row(s), regenerable session artifacts`);
  }
  // Feature-owned plaintext caches outside the patterns above (face crops,
  // lib/faces/store.js) sweep themselves in through registered migrators.
  // They only ever run while the store is open (checked above, and again here
  // in case one of them closed it), and must store with putVerified before
  // deleting anything.
  for (const fn of _diskMigrators) {
    if (_sealed || !_db) break;
    try { fn(); } catch (err) { console.warn(`[SecureAssets] extra migration skipped: ${err.message}`); }
  }
  return out;
}

const _diskMigrators = [];
/**
 * Register an extra plaintext-to-store sweep run at the end of migrateFromDisk
 * (only while the store is open). A migrator deletes a plaintext file only
 * after putVerified() returned true for it.
 */
function addDiskMigrator(fn) {
  if (!_diskMigrators.includes(fn)) _diskMigrators.push(fn);
}

module.exports = {
  enabled, init, conn, storePath,
  get, has, put, putVerified, writable, del, deleteAll, deleteKindPrefix, addDiskMigrator,
  sizesByKind, mediaSizes, sizesByKindAsync, mediaSizesAsync, _setIndexDeferRows, deleteKinds, deleteKindsMany, deleteKindsStep, touchMany,
  getPmvPreview, putPmvPreview, deletePmvPreviews, clearAllPmvPreviews,
  close, sealed, unlock, rekey, migrateFromDisk,
  subtitlesDir, subtitlesRedirected,
};
