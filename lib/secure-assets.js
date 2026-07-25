/**
 * Secure assets store — encrypted SQLite home for DERIVED artifacts.
 *
 * When vault mode is on (a VIDEO_TAGGER_DB_PASSWORD is set and the encrypted
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
}

/**
 * Open (or return) the store connection, keyed with the session password.
 * Returns null when the store is disabled. Throws DB_ENCRYPTED (typed, like
 * database.init) when the file exists but the key is wrong.
 */
function conn() {
  if (_db) return _db;
  if (!enabled()) return null;

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
  if (password && !_hasCipher) {
    const e = new Error(
      'VIDEO_TAGGER_DB_PASSWORD is set but the encrypted-SQLite module ' +
      '"better-sqlite3-multiple-ciphers" is unavailable — derived artifacts ' +
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
}

/**
 * Reopen with the given passphrase (vault unlock). A wrong key throws
 * DB_ENCRYPTED — but since it's the SAME passphrase that just opened the main
 * DB, that should never happen in practice.
 */
function unlock(password) {
  _password = password;
  close();
  conn();
}

/**
 * Encrypt-in-place / change the key (vault setPassword → PRAGMA rekey), mirror
 * of database rekey. Handles first-time enable: if the store file was created
 * before a password existed (plaintext), it opens plaintext then rekeys, so the
 * two DBs never diverge.
 */
function rekey(newPass) {
  if (!_hasCipher) return;

  // Ensure a connection exists under the CURRENT key (which may be none, for a
  // never-encrypted store, or the old key for a password change).
  let db = _db;
  if (!db) {
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
  return process.env.VIDEO_TAGGER_SUBS
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
 * @returns {{thumbs:number, scrubs:number, beat:number, subtitles:number}}
 */
function migrateFromDisk() {
  const out = { thumbs: 0, scrubs: 0, beat: 0, subtitles: 0, pmvFiles: 0, pmvRows: 0 };
  if (!enabled()) return out;

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

  const importFile = (fp, media_id, kind, lang = '') => {
    try {
      put(Number(media_id), kind, fs.readFileSync(fp), lang);
      fs.unlinkSync(fp);
      return true;
    } catch { return false; }
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
  // marker governs — no extra gate. But VIDEO_TAGGER_SUBS can redirect it to an
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
    console.log(`[SecureAssets] migrated ${total} plaintext artifact(s) into secure_assets.db ` +
      `(${out.thumbs} thumb, ${out.scrubs} scrub, ${out.beat} beat-audio, ${out.subtitles} subtitle) — plaintext deleted`);
  }
  if (out.pmvFiles > 0 || out.pmvRows > 0) {
    console.log(`[SecureAssets] purged ${out.pmvFiles} plaintext PMV preview file(s) and ` +
      `${out.pmvRows} stale preview row(s) — regenerable session artifacts`);
  }
  return out;
}

module.exports = {
  enabled, init, conn, storePath,
  get, has, put, del, deleteAll,
  getPmvPreview, putPmvPreview, deletePmvPreviews, clearAllPmvPreviews,
  close, unlock, rekey, migrateFromDisk,
  subtitlesDir, subtitlesRedirected,
};
