/**
 * Flow measurements, one row per file, in the main library database (so an
 * encrypted library keeps them encrypted with everything else).
 *
 *   media_flow(media_id PK, version, src, lufs, peak_db, has_music, no_audio,
 *              bpm_start, bpm_mid, bpm_end, bpm_conf, e_start, e_mid, e_end,
 *              measured_at, ms, error)
 *
 * src is the file's size and modification time when it was measured; a row
 * whose src or version no longer matches counts as not measured (the file
 * changed, or the method did), and is measured again when asked.
 * error: why it could not be measured (the row's numbers are then null).
 */

const { VERSION } = require('./analyze');

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_flow (
      media_id    INTEGER PRIMARY KEY,
      version     INTEGER NOT NULL,
      src         TEXT,
      lufs        REAL,
      peak_db     REAL,
      has_music   INTEGER NOT NULL DEFAULT 0,
      no_audio    INTEGER NOT NULL DEFAULT 0,
      bpm_start   REAL,
      bpm_mid     REAL,
      bpm_end     REAL,
      bpm_conf    REAL,
      e_start     REAL,
      e_mid       REAL,
      e_end       REAL,
      measured_at INTEGER,
      ms          INTEGER,
      error       TEXT
    );
  `);
}

/** The file's identity for a measurement: size and modification time. */
function srcOf(row) {
  if (!row) return null;
  return `${row.filesize_bytes ?? ''}:${row.file_mtime_ms ?? ''}`;
}

const COLS = ['version', 'src', 'lufs', 'peak_db', 'has_music', 'no_audio', 'bpm_start', 'bpm_mid', 'bpm_end',
  'bpm_conf', 'e_start', 'e_mid', 'e_end', 'measured_at', 'ms', 'error'];

function save(db, mediaId, src, f, { error = null, now = Date.now() } = {}) {
  const v = { version: VERSION, src, measured_at: now, error, ...(f || {}) };
  if (error) for (const k of ['lufs', 'peak_db', 'bpm_start', 'bpm_mid', 'bpm_end', 'bpm_conf', 'e_start', 'e_mid', 'e_end']) v[k] = null;
  v.version = VERSION;
  v.has_music = v.has_music ? 1 : 0;
  v.no_audio = v.no_audio ? 1 : 0;
  db.prepare(`INSERT OR REPLACE INTO media_flow (media_id, ${COLS.join(', ')}) VALUES (?, ${COLS.map(() => '?').join(', ')})`)
    .run(mediaId, ...COLS.map(k => (v[k] === undefined ? null : v[k])));
}

/**
 * Rows for these ids that are current (version and src match the media row).
 * @returns {Map<number, object>} id -> row (with the media's duration)
 */
function currentFor(db, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const CHUNK = 900;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const rows = db.prepare(`SELECT f.*, m.filesize_bytes, m.file_mtime_ms FROM media_flow f JOIN media m ON m.id = f.media_id
      WHERE f.media_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(part));
    for (const r of rows) {
      if (r.version !== VERSION || r.src !== srcOf(r)) continue;
      delete r.filesize_bytes; delete r.file_mtime_ms;
      out.set(r.media_id, r);
    }
  }
  return out;
}

function get(db, id) {
  return currentFor(db, [id]).get(id) || null;
}

function remove(db, id) {
  db.prepare('DELETE FROM media_flow WHERE media_id = ?').run(id);
}

/**
 * For "Whole library now": the files after `afterId` (in id order) that can
 * be measured and are not, or are out of date (the file's size or time, or
 * the method, changed). A keyset walk on the primary key, `limit` rows a
 * step, at most `maxRows` rows a call, so each call is a few ms whatever the
 * library's size; the caller keeps the cursor.
 * @returns {{ids: number[], cursor: number, done: boolean}}
 */
const SWEEP_SQL = `SELECT m.id, m.media_type, m.user_trashed, m.filesize_bytes, m.file_mtime_ms, f.version, f.src
  FROM media m LEFT JOIN media_flow f ON f.media_id = m.id
  WHERE m.id > ? ORDER BY m.id LIMIT ?`;
function sweepBatch(db, afterId, { limit = 500, maxRows = 2000 } = {}) {
  const stmt = db.prepare(SWEEP_SQL);
  const ids = [];
  let cursor = afterId || 0;
  let seen = 0;
  while (seen < maxRows) {
    const rows = stmt.all(cursor, limit);
    for (const r of rows) {
      if ((r.media_type === 'video' || r.media_type === 'audio') && !r.user_trashed
        && (r.version == null || r.version !== VERSION || r.src !== srcOf(r))) ids.push(r.id);
    }
    if (rows.length) cursor = rows[rows.length - 1].id;
    seen += rows.length;
    if (rows.length < limit) return { ids, cursor, done: true };
    if (ids.length) break;
  }
  return { ids, cursor, done: false };
}

module.exports = { ensureSchema, save, currentFor, get, remove, srcOf, sweepBatch, SWEEP_SQL };
