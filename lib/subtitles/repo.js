/**
 * Subtitles — persistence in the main vault.db (SUBTITLES_SPEC §5.1).
 *
 * subtitle_tracks: one row per (media, lang) — VTT on disk, SRT derived.
 * subtitle_jobs:   DB-backed generation jobs (queued like music/pmv exports).
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const database = require('../database');
const secureAssets = require('../secure-assets');
const ownedDir = require('../owned-dir');
const { envVar } = require('../env-var');

const TRACKS_DIR = envVar('SUBS') || path.join(config.paths.thumbnailDir, 'subtitles');

// Where a VTT physically lives for streamed reads/writes. Vault mode writes
// working copies under the (wiped) temp dir instead of thumbnailDir, and the
// canonical bytes are kept encrypted in secure_assets.db (kind 'subtitle',
// lang = the track lang). Non-vault mode is unchanged: the VTT on disk IS the
// canonical copy.
function workDir() {
  return secureAssets.enabled()
    ? path.join(config.paths.tempDir, 'subtitles')
    : TRACKS_DIR;
}

/** mkdir the subtitles working dir AND stamp the app-owned marker on its
 *  managed ROOT so that root's sweeps stay permitted:
 *   - vault mode           → tempDir (working copies live under tempDir/subtitles),
 *   - redirected non-vault  → the redirected VAULT_SUBS root itself
 *                             (the VTTs live directly there, so IT must be marked),
 *   - default non-vault     → thumbnailDir (parent of {thumbnailDir}/subtitles). */
function ensureWorkDir() {
  fs.mkdirSync(workDir(), { recursive: true });
  if (secureAssets.enabled()) ownedDir.ensureManaged(config.paths.tempDir, 'temp');
  else if (secureAssets.subtitlesRedirected()) ownedDir.ensureManaged(secureAssets.subtitlesDir(), 'subs');
  else ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs');
}

let _ready = false;

function db() {
  const d = database.get();
  if (!_ready) { ensureSchema(d); _ready = true; }
  return d;
}

function ensureSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS subtitle_tracks (
      media_id   INTEGER NOT NULL,
      lang       TEXT NOT NULL,
      kind       TEXT NOT NULL,            -- 'original' | 'translated'
      path       TEXT NOT NULL,            -- .vtt on disk
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (media_id, lang)
    );
    CREATE TABLE IF NOT EXISTS subtitle_jobs (
      id           TEXT PRIMARY KEY,
      media_id     INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'queued',  -- queued|transcribing|translating|done|error|canceled
      progress     REAL DEFAULT 0,
      stage        TEXT,
      notice       TEXT,                            -- one-shot advisory (client toast)
      error        TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_media ON subtitle_jobs(media_id);
  `);
  // Pre-notice DBs: the CREATE above is a no-op there, so add the column.
  try { d.exec('ALTER TABLE subtitle_jobs ADD COLUMN notice TEXT'); } catch { /* already present */ }
  // The tracks a running job opened, with the rows they replaced (JSON
  // [{ lang, prev }]), so a run that never finishes, even across a restart,
  // can be undone exactly: see discardUnfinishedTracks.
  try { d.exec('ALTER TABLE subtitle_jobs ADD COLUMN opened_tracks TEXT'); } catch { /* already present */ }
}

/* ── Tracks ─────────────────────────────────────────────────────────────── */

/**
 * A track key is the language whisper reported (ISO 639-1 codes, plus its few
 * three-letter ones such as "haw" and "yue"), "en" for the translation, or
 * "unknown" when whisper never said. A region suffix ("pt-br", "zh_hant") is
 * allowed for keys that may come later. The key goes into a file name, so
 * nothing with a dot, a slash or a backslash can ever pass: a DELETE with
 * lang=../../x used to unlink any .vtt the server could reach.
 */
const TRACK_LANG_RE = /^(?:[a-z]{2,3}(?:[-_][a-z0-9]{1,8})?|unknown)$/i;

function isValidTrackLang(lang) {
  return typeof lang === 'string' && TRACK_LANG_RE.test(lang);
}

function trackPath(media_id, lang) {
  if (!isValidTrackLang(lang)) throw new Error(`not a subtitle language: ${String(lang).slice(0, 20)}`);
  return path.join(workDir(), `${media_id}.${lang}.vtt`);
}

/**
 * Read a track's VTT text. In vault mode this reads the active working copy if
 * one exists (mid-generation/patch), otherwise the bytes straight from the
 * encrypted store — WITHOUT leaving a plaintext copy on disk. Use this for
 * serving and search; use materializeTrack when a real file path is required.
 * @returns {string|null} the VTT text, or null if there is no such track.
 */
function readTrackText(media_id, lang) {
  const p = trackPath(media_id, lang);
  if (secureAssets.enabled()) {
    if (fs.existsSync(p)) { try { return fs.readFileSync(p, 'utf8'); } catch {} }
    const buf = secureAssets.get(media_id, 'subtitle', lang);
    return buf == null ? null : buf.toString('utf8');
  }
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * Ensure a real working VTT file exists on disk and return its path — for the
 * few operations that must read/rewrite the file by path (patch/merge). In
 * vault mode it exports the encrypted bytes into the (wiped) temp working dir;
 * pair with commitTrack + dropWorkingCopy to bound the plaintext window.
 * @returns {string|null} the working path, or null if there is no such track.
 */
function materializeTrack(media_id, lang) {
  const p = trackPath(media_id, lang);
  if (secureAssets.enabled() && !fs.existsSync(p)) {
    const buf = secureAssets.get(media_id, 'subtitle', lang);
    if (buf == null) return null;
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); }
    catch { return null; }
  }
  return fs.existsSync(p) ? p : null;
}

/**
 * Push the current working VTT file into the encrypted store (vault only).
 * @returns {boolean} false when there WAS a working file and the store did not
 *   take it (the vault locked: the store is sealed and refuses writes). The
 *   caller must not report the track as saved then. True otherwise (stored,
 *   vault off, or no working file to commit).
 */
function commitTrack(media_id, lang) {
  if (!secureAssets.enabled()) return true;
  let buf;
  try { buf = fs.readFileSync(trackPath(media_id, lang)); } catch { return true; }
  return secureAssets.putVerified(media_id, 'subtitle', buf, lang);
}

/** Delete the plaintext working copy in the temp dir (vault only, best-effort). */
function dropWorkingCopy(media_id, lang) {
  if (!secureAssets.enabled()) return;
  try { fs.unlinkSync(trackPath(media_id, lang)); } catch {}
}

function listTracks(media_id) {
  return db().prepare('SELECT * FROM subtitle_tracks WHERE media_id = ?').all(media_id);
}

function getTrack(media_id, lang) {
  return db().prepare('SELECT * FROM subtitle_tracks WHERE media_id = ? AND lang = ?').get(media_id, lang);
}

function putTrack(media_id, lang, kind, vttText) {
  ensureWorkDir();
  const p = trackPath(media_id, lang);
  fs.writeFileSync(p, vttText, 'utf8');
  let saved = false;
  try {
    db().prepare(`
      INSERT INTO subtitle_tracks (media_id, lang, kind, path, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(media_id, lang) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, created_at = datetime('now')
    `).run(media_id, lang, kind, p);
    saved = commitTrack(media_id, lang);   // vault: persist encrypted (true, a no-op, otherwise)
  } finally {
    dropWorkingCopy(media_id, lang);       // vault: no plaintext copy left behind, whatever happened
  }
  if (!saved) {
    const e = new Error('The library is locked, so the subtitles were not saved.');
    e.code = 'SUBS_NOT_SAVED';
    throw e;
  }
  return getTrack(media_id, lang);
}

/** Register/point a track row at its VTT path WITHOUT writing the file —
 *  the streaming service owns the file (header + appended cues). */
function registerTrack(media_id, lang, kind) {
  ensureWorkDir();
  db().prepare(`
    INSERT INTO subtitle_tracks (media_id, lang, kind, path, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(media_id, lang) DO UPDATE SET
      kind = excluded.kind, path = excluded.path, created_at = datetime('now')
  `).run(media_id, lang, kind, trackPath(media_id, lang));
  return getTrack(media_id, lang);
}

/**
 * Delete one track: its row, its file and its encrypted copy. Only a track
 * that exists is touched (null when there is none), and the file removed is
 * the one the row points at, never a path built from the caller's lang.
 */
function deleteTrack(media_id, lang) {
  const row = getTrack(media_id, lang);
  if (!row) return null;
  if (row.path && path.extname(row.path).toLowerCase() === '.vtt') { try { fs.unlinkSync(row.path); } catch {} }
  // Vault working copy (tempDir), which can differ from row.path when the row
  // was made before a password was set. trackPath refuses a bad key (caught).
  try { fs.unlinkSync(trackPath(media_id, row.lang)); } catch {}
  try { secureAssets.del(media_id, 'subtitle', lang); } catch {}
  return db().prepare('DELETE FROM subtitle_tracks WHERE media_id = ? AND lang = ?').run(media_id, lang);
}

/** Put a track row back exactly as it was (kind, path, date). */
function restoreTrackRow(prev) {
  db().prepare(`
    INSERT INTO subtitle_tracks (media_id, lang, kind, path, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(media_id, lang) DO UPDATE SET
      kind = excluded.kind, path = excluded.path, created_at = excluded.created_at
  `).run(prev.media_id, prev.lang, prev.kind, prev.path, prev.created_at);
}

/**
 * Undo the tracks a run opened but never finished (whisper crashed or stalled,
 * the server restarted mid-job), so the half-written VTT is never offered as
 * the finished track. opened: [{ lang, prev }], prev = the row before the run
 * (or null). Vault off, the working file IS the track, so it goes. Vault on,
 * an earlier finished copy stays in the encrypted store: only the half-written
 * working file goes, and the row gets its earlier kind back (a run that
 * detected another language had re-registered "en" as its translation).
 * Best-effort, per track.
 */
function discardUnfinishedTracks(media_id, opened) {
  for (const t of opened || []) {
    if (!t || !t.lang) continue;
    try {
      if (secureAssets.enabled()) {
        dropWorkingCopy(media_id, t.lang);
        if (!secureAssets.writable()) continue;            // sealed: nothing can be checked or changed
        if (!secureAssets.has(media_id, 'subtitle', t.lang)) {
          db().prepare('DELETE FROM subtitle_tracks WHERE media_id = ? AND lang = ?').run(media_id, t.lang);
        } else if (t.prev) {
          restoreTrackRow(t.prev);
        }
      } else {
        deleteTrack(media_id, t.lang);
      }
    } catch { /* best-effort: the job still records the failure */ }
  }
}

/* ── Jobs ───────────────────────────────────────────────────────────────── */

function genJobId() {
  return 'sub_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function createJob(media_id) {
  const id = genJobId();
  db().prepare('INSERT INTO subtitle_jobs (id, media_id) VALUES (?, ?)').run(id, media_id);
  return getJob(id);
}

function getJob(id) {
  return db().prepare('SELECT * FROM subtitle_jobs WHERE id = ?').get(id);
}

/** The active (non-terminal) job for a media item, if any. */
function activeJobFor(media_id) {
  return db().prepare(`
    SELECT * FROM subtitle_jobs
    WHERE media_id = ? AND status IN ('queued', 'transcribing', 'translating')
    ORDER BY created_at DESC LIMIT 1
  `).get(media_id);
}

function updateJob(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!['status', 'progress', 'stage', 'notice', 'error', 'completed_at', 'opened_tracks'].includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (!sets.length) return;
  db().prepare(`UPDATE subtitle_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

/** Jobs left running by a previous process can never finish — mark on boot. */
function failStaleJobs() {
  // Their half-written tracks go too, by the same rules as a run that fails
  // while the server is up (only what that run opened; finished vault copies stay).
  const stale = db().prepare(`
    SELECT media_id, opened_tracks FROM subtitle_jobs
    WHERE status IN ('queued', 'transcribing', 'translating') AND opened_tracks IS NOT NULL
  `).all();
  for (const j of stale) {
    let opened = [];
    try { opened = JSON.parse(j.opened_tracks); } catch {}
    if (!Array.isArray(opened)) continue;   // anything but a list touches nothing
    try { discardUnfinishedTracks(j.media_id, opened); } catch { /* still marked failed below */ }
  }
  db().prepare(`
    UPDATE subtitle_jobs SET status = 'error', error = 'interrupted by server restart'
    WHERE status IN ('queued', 'transcribing', 'translating')
  `).run();
}

/** Remove tracks/files + jobs for deleted media (called from db.deleteRecords). */
function cleanupForMedia(d, media_id) {
  try {
    const rows = d.prepare('SELECT path FROM subtitle_tracks WHERE media_id = ?').all(media_id);
    for (const r of rows) { try { fs.unlinkSync(r.path); } catch {} }
    d.prepare('DELETE FROM subtitle_tracks WHERE media_id = ?').run(media_id);
    d.prepare('DELETE FROM subtitle_jobs WHERE media_id = ?').run(media_id);
  } catch { /* subtitles schema absent — nothing to clean */ }
}

module.exports = {
  db, ensureSchema, TRACKS_DIR, trackPath, isValidTrackLang,
  readTrackText, materializeTrack, commitTrack, dropWorkingCopy,
  listTracks, getTrack, putTrack, registerTrack, deleteTrack, discardUnfinishedTracks,
  createJob, getJob, activeJobFor, updateJob, failStaleJobs,
  cleanupForMedia,
};
