/**
 * Music ID — schema + queries, living in the main vault.db.
 *
 * Adapted from SAMPLES repo.js/db.js: their `videos` table maps onto our
 * `media` table, so link/fingerprint tables use media_id. Schema is created
 * lazily on first use (ensureSchema is idempotent, safe on every boot).
 */

const database = require('../database');

let _ready = false;

function db() {
  const d = database.get();
  if (!_ready) { ensureSchema(d); _ready = true; }
  return d;
}

function ensureSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      is_remix INTEGER DEFAULT 0,
      remix_label TEXT NOT NULL DEFAULT '',
      source TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(title, artist, remix_label)
    );

    -- A song appearing in a media file (time-ranged; method: manual | auto-fp | auto-cluster)
    CREATE TABLE IF NOT EXISTS media_songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      song_id INTEGER NOT NULL,
      start_sec REAL,
      end_sec REAL,
      offset_sec REAL DEFAULT 0,
      confidence REAL,
      method TEXT DEFAULT 'manual',
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Chunked fingerprints of whole files (30s windows, 15s hop, silence-gated)
    CREATE TABLE IF NOT EXISTS media_fingerprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_id INTEGER NOT NULL,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      duration REAL NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Reference fingerprints per song (built from tagged segments; scan targets)
    CREATE TABLE IF NOT EXISTS song_fingerprints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER NOT NULL,
      media_id INTEGER,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      duration REAL NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Saved editor mixes (per song when aligned, or free-form media sets)
    CREATE TABLE IF NOT EXISTS mix_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER,
      name TEXT NOT NULL,
      media_ids TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name)
    );

    -- Artist/title autocomplete corpus (imported from seed.json — names only,
    -- no audio; entries become real songs the first time they're used)
    CREATE TABLE IF NOT EXISTS metadata_seed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artist TEXT NOT NULL,
      title TEXT NOT NULL,
      usage_rank INTEGER DEFAULT 0,
      UNIQUE(artist, title)
    );

    -- Library-resident custom mixes: a media row (media_type 'mix') plays a
    -- saved multi-video mix through the Editor — no ffmpeg export needed
    CREATE TABLE IF NOT EXISTS custom_mixes (
      media_id INTEGER PRIMARY KEY,
      song_id INTEGER,
      media_ids TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Stack-mix ffmpeg export jobs
    CREATE TABLE IF NOT EXISTS music_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER,
      filename TEXT NOT NULL,
      output_path TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress REAL DEFAULT 0,
      params TEXT NOT NULL,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_seed_artist ON metadata_seed(artist);
    CREATE INDEX IF NOT EXISTS idx_seed_title ON metadata_seed(title);
    CREATE INDEX IF NOT EXISTS idx_media_songs_media ON media_songs(media_id);
    CREATE INDEX IF NOT EXISTS idx_media_songs_song ON media_songs(song_id);
    CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
    CREATE INDEX IF NOT EXISTS idx_songs_title ON songs(title);
    CREATE INDEX IF NOT EXISTS idx_media_fp_media ON media_fingerprints(media_id);
    CREATE INDEX IF NOT EXISTS idx_song_fp_song ON song_fingerprints(song_id);
    CREATE INDEX IF NOT EXISTS idx_mix_presets_song ON mix_presets(song_id);
  `);

  // origin: 'segment' (fingerprintSegment builds) | 'chunk-copy' (Section
  // Identifier tiles). Additive — guarded because ensureSchema re-runs on boot.
  try { d.exec("ALTER TABLE song_fingerprints ADD COLUMN origin TEXT DEFAULT 'segment'"); }
  catch { /* column already exists */ }

  // kind: 'mix' (stack editor presets) | 'pmv' (PMV Studio recipes share the
  // table — see lib/pmv/repo.js). Additive, guarded like origin above.
  try { d.exec("ALTER TABLE mix_presets ADD COLUMN kind TEXT DEFAULT 'mix'"); }
  catch { /* column already exists */ }
}

/* ── Songs ──────────────────────────────────────────────────────────────── */

function findOrCreateSong({ title, artist, is_remix = 0, remix_label = '', source = 'manual' }) {
  const label = remix_label || '';
  const existing = db().prepare(
    'SELECT id FROM songs WHERE title = ? AND artist = ? AND remix_label = ?'
  ).get(title, artist, label);
  if (existing) return existing.id;
  return db().prepare(`
    INSERT INTO songs (title, artist, is_remix, remix_label, source)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, artist, is_remix ? 1 : 0, label, source).lastInsertRowid;
}

function listSongs({ q = '', sort = 'usage_desc', source = null } = {}) {
  const params = [];
  let sql = `
    SELECT s.*,
      (SELECT COUNT(*) FROM media_songs ms WHERE ms.song_id = s.id) AS media_count,
      (SELECT COUNT(*) FROM media_songs ms JOIN media m ON m.id = ms.media_id
        WHERE ms.song_id = s.id AND m.media_type = 'video') AS video_count,
      (SELECT COUNT(*) FROM song_fingerprints sf WHERE sf.song_id = s.id) AS ref_count
    FROM songs s
    WHERE 1=1
  `;
  if (q) {
    sql += ' AND (s.title LIKE ? OR s.artist LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (source === 'unknown') sql += " AND s.source = 'auto-cluster'";
  else if (source === 'identified') sql += " AND s.source != 'auto-cluster'";

  const sorts = {
    usage_desc: 'video_count DESC, media_count DESC, s.artist COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC',
    artist_asc: 's.artist COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC',
    title_asc: 's.title COLLATE NOCASE ASC',
    added_desc: 's.created_at DESC',
  };
  sql += ` ORDER BY ${sorts[sort] || sorts.usage_desc}`;
  const rows = db().prepare(sql).all(...params);

  // Up to 4 linked-video ids per song → 2×2 mosaic thumbnails in the Editor
  const firstVideos = db().prepare(`
    SELECT ms.media_id FROM media_songs ms JOIN media m ON m.id = ms.media_id
    WHERE ms.song_id = ? AND m.media_type = 'video'
    ORDER BY ms.id LIMIT 4
  `);
  for (const r of rows) r.first_video_ids = firstVideos.all(r.id).map(x => x.media_id);
  return rows;
}

function getSong(id) {
  return db().prepare('SELECT * FROM songs WHERE id = ?').get(id);
}

function updateSong(id, { title, artist, is_remix, remix_label, source }) {
  const cur = getSong(id);
  if (!cur) throw new Error(`Song ${id} not found`);
  return db().prepare(`
    UPDATE songs SET title = ?, artist = ?, is_remix = ?, remix_label = ?, source = ?
    WHERE id = ?
  `).run(
    title ?? cur.title,
    artist ?? cur.artist,
    is_remix != null ? (is_remix ? 1 : 0) : cur.is_remix,
    remix_label ?? cur.remix_label,
    source ?? cur.source,
    id
  );
}

function deleteSong(id) {
  const d = db();
  const tx = d.transaction((sid) => {
    d.prepare('DELETE FROM media_songs WHERE song_id = ?').run(sid);
    d.prepare('DELETE FROM song_fingerprints WHERE song_id = ?').run(sid);
    d.prepare('DELETE FROM mix_presets WHERE song_id = ?').run(sid);
    d.prepare('DELETE FROM songs WHERE id = ?').run(sid);
  });
  tx(id);
}

/* ── Media ↔ song links ─────────────────────────────────────────────────── */

function linkSongToMedia({ media_id, song_id, start_sec = null, end_sec = null, confidence = null, method = 'manual' }) {
  if (end_sec == null) {
    const m = db().prepare('SELECT duration_seconds FROM media WHERE id = ?').get(media_id);
    if (m?.duration_seconds) end_sec = m.duration_seconds;
  }
  return db().prepare(`
    INSERT INTO media_songs (media_id, song_id, start_sec, end_sec, confidence, method)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(media_id, song_id, start_sec, end_sec, confidence, method).lastInsertRowid;
}

function unlinkSong(link_id) {
  return db().prepare('DELETE FROM media_songs WHERE id = ?').run(link_id);
}

function getLink(link_id) {
  return db().prepare('SELECT * FROM media_songs WHERE id = ?').get(link_id);
}

function updateLink(link_id, { song_id, start_sec, end_sec, offset_sec, method }) {
  const cur = getLink(link_id);
  if (!cur) throw new Error(`Link ${link_id} not found`);
  return db().prepare(`
    UPDATE media_songs SET song_id = ?, start_sec = ?, end_sec = ?, offset_sec = ?, method = ?
    WHERE id = ?
  `).run(
    song_id ?? cur.song_id,
    start_sec !== undefined ? start_sec : cur.start_sec,
    end_sec !== undefined ? end_sec : cur.end_sec,
    offset_sec !== undefined ? offset_sec : cur.offset_sec,
    method ?? cur.method,
    link_id
  );
}

/** Songs in one media file, with song metadata (player sidebar). */
function songsForMedia(media_id) {
  return db().prepare(`
    SELECT ms.id AS link_id, ms.start_sec, ms.end_sec, ms.offset_sec, ms.confidence, ms.method,
           s.id AS song_id, s.title, s.artist, s.is_remix, s.remix_label, s.source
    FROM media_songs ms
    JOIN songs s ON s.id = ms.song_id
    WHERE ms.media_id = ?
    ORDER BY ms.start_sec ASC, ms.id ASC
  `).all(media_id);
}

/** All media↔link rows for one song, with media metadata (stack player, song page). */
function mediaForSong(song_id) {
  return db().prepare(`
    SELECT ms.id AS link_id, ms.start_sec, ms.end_sec, ms.offset_sec, ms.method, ms.confidence,
           m.id AS media_id, m.filename, m.filepath, m.media_type, m.duration_seconds
    FROM media_songs ms
    JOIN media m ON m.id = ms.media_id
    WHERE ms.song_id = ?
    ORDER BY m.filename COLLATE NOCASE ASC
  `).all(song_id);
}

/** media_id → [song_id,…] for every linked file (client-side filter/badges). */
function linksMap() {
  const rows = db().prepare('SELECT media_id, song_id FROM media_songs').all();
  const map = {};
  for (const r of rows) {
    (map[r.media_id] = map[r.media_id] || []).push(r.song_id);
  }
  return map;
}

/* ── Media chunk fingerprints ───────────────────────────────────────────── */

function saveMediaFingerprints(media_id, chunks) {
  const d = db();
  const insert = d.prepare(`
    INSERT INTO media_fingerprints (media_id, start_sec, end_sec, duration, fingerprint)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = d.transaction((rows) => {
    d.prepare('DELETE FROM media_fingerprints WHERE media_id = ?').run(media_id);
    for (const c of rows) insert.run(media_id, c.start_sec, c.end_sec, c.duration, c.fingerprint);
  });
  tx(chunks);
}

function getMediaFingerprints(media_id) {
  return db().prepare(
    'SELECT id, start_sec, end_sec, duration, fingerprint FROM media_fingerprints WHERE media_id = ? ORDER BY start_sec ASC'
  ).all(media_id);
}

function mediaHasFingerprints(media_id) {
  return db().prepare('SELECT COUNT(*) AS n FROM media_fingerprints WHERE media_id = ?').get(media_id).n > 0;
}

function fingerprintCounts() {
  const d = db();
  const perMedia = d.prepare(
    'SELECT media_id, COUNT(*) AS chunks FROM media_fingerprints GROUP BY media_id'
  ).all();
  return perMedia; // [{media_id, chunks}]
}

function deleteMediaFingerprints(media_id, { removeAutoLinks = true } = {}) {
  const d = db();
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM media_fingerprints WHERE media_id = ?').run(media_id);
    if (removeAutoLinks) {
      d.prepare("DELETE FROM media_songs WHERE media_id = ? AND method != 'manual'").run(media_id);
    }
  });
  tx();
}

/** All other media's chunks (for incremental cross-media matching). */
function allChunksExcept(media_id) {
  return db().prepare(`
    SELECT mf.id, mf.media_id, mf.start_sec, mf.end_sec, mf.duration, mf.fingerprint
    FROM media_fingerprints mf
    WHERE mf.media_id != ?
    ORDER BY mf.media_id ASC, mf.start_sec ASC
  `).all(media_id);
}

/* ── Song reference fingerprints ────────────────────────────────────────── */

function saveSongFingerprint({ song_id, media_id = null, start_sec, end_sec, duration, fingerprint, origin = 'segment' }) {
  return db().prepare(`
    INSERT INTO song_fingerprints (song_id, media_id, start_sec, end_sec, duration, fingerprint, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(song_id, media_id, start_sec, end_sec, duration, fingerprint, origin).lastInsertRowid;
}

function listSongFingerprints(song_id = null) {
  if (song_id != null) {
    return db().prepare('SELECT id, song_id, fingerprint, duration FROM song_fingerprints WHERE song_id = ?').all(song_id);
  }
  return db().prepare('SELECT id, song_id, fingerprint, duration FROM song_fingerprints').all();
}

function hasSongReference(song_id, media_id, start_sec) {
  return !!db().prepare(`
    SELECT 1 FROM song_fingerprints
    WHERE song_id = ? AND media_id = ? AND ABS(start_sec - ?) < 1
  `).get(song_id, media_id, start_sec);
}

/* ── Mix presets ────────────────────────────────────────────────────────── */

function listPresets(song_id = null) {
  // PMV Studio recipes share this table (kind='pmv') — exclude them here
  if (song_id != null) {
    return db().prepare(`
      SELECT p.*, s.title AS song_title, s.artist AS song_artist
      FROM mix_presets p LEFT JOIN songs s ON s.id = p.song_id
      WHERE p.song_id = ? AND COALESCE(p.kind, 'mix') = 'mix'
      ORDER BY p.name COLLATE NOCASE ASC
    `).all(song_id);
  }
  return db().prepare(`
    SELECT p.*, s.title AS song_title, s.artist AS song_artist
    FROM mix_presets p LEFT JOIN songs s ON s.id = p.song_id
    WHERE COALESCE(p.kind, 'mix') = 'mix'
    ORDER BY p.created_at DESC
  `).all();
}

function getPreset(id) {
  return db().prepare('SELECT * FROM mix_presets WHERE id = ?').get(id);
}

function savePreset({ song_id = null, name, media_ids, config_json }) {
  return db().prepare(`
    INSERT INTO mix_presets (song_id, name, media_ids, config_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      song_id = excluded.song_id,
      media_ids = excluded.media_ids,
      config_json = excluded.config_json,
      created_at = datetime('now')
    RETURNING id
  `).get(song_id, name, media_ids, config_json).id;
}

function deletePreset(id) {
  return db().prepare('DELETE FROM mix_presets WHERE id = ?').run(id);
}

/* ── Metadata seed (artist/title autocomplete corpus) ───────────────────── */

function seedCount() {
  return db().prepare('SELECT COUNT(*) AS n FROM metadata_seed').get().n;
}

/**
 * Import { artists: [{ name, songs: [{ name, usageCount }] }] } (the
 * samples' seed.json shape). BOM-aware. Upserts, keeping the higher rank.
 * Returns { imported, skipped } or null when the file is missing/invalid.
 */
function importSeedFile(filePath) {
  const fs = require('fs');
  if (!fs.existsSync(filePath)) return null;

  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return null; }
  let text;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) text = buf.slice(3).toString('utf8');
  else if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) text = buf.slice(2).toString('utf16le');
  else text = buf.toString('utf8');

  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(raw?.artists)) return null;

  const rows = [];
  let skipped = 0;
  for (const a of raw.artists) {
    const artist = (a?.name ?? '').trim();
    if (!artist) { skipped++; continue; }
    for (const s of (Array.isArray(a.songs) ? a.songs : [])) {
      const title = (s?.name ?? '').trim();
      if (!title) { skipped++; continue; }
      rows.push({ artist, title, usage_rank: Number.isFinite(s?.usageCount) ? s.usageCount : 0 });
    }
  }

  const d = db();
  const upsert = d.prepare(`
    INSERT INTO metadata_seed (artist, title, usage_rank)
    VALUES (?, ?, ?)
    ON CONFLICT(artist, title) DO UPDATE SET
      usage_rank = MAX(metadata_seed.usage_rank, excluded.usage_rank)
  `);
  d.transaction((items) => {
    for (const r of items) upsert.run(r.artist, r.title, r.usage_rank);
  })(rows);

  return { imported: rows.length, skipped };
}

/** Seed entries matching q (or top-ranked when q is empty). */
function searchSeed(q = '', limit = 20) {
  if (!q) {
    return db().prepare(
      'SELECT artist, title, usage_rank FROM metadata_seed ORDER BY usage_rank DESC LIMIT ?'
    ).all(limit);
  }
  const like = `%${q}%`;
  const prefix = `${q}%`;
  return db().prepare(`
    SELECT artist, title, usage_rank,
      (CASE WHEN artist LIKE ? OR title LIKE ? THEN 1000000 ELSE 0 END) + usage_rank AS score
    FROM metadata_seed
    WHERE artist LIKE ? OR title LIKE ?
    ORDER BY score DESC
    LIMIT ?
  `).all(prefix, prefix, like, like, limit);
}

/* ── Custom mixes (library-resident, played through the Editor) ─────────── */

/**
 * Create the media row + mix config in one transaction. The media row is a
 * virtual file (filepath mix://…): visible, rateable and notable like any
 * tile, but never scanned by AI (processed_at set, model 'custom-mix') and
 * never dupe-grouped (name_key = its own unique path).
 */
function createCustomMix({ title, description = '', song_id = null, media_ids, config }) {
  const d = db();
  const crypto = require('crypto');
  const filepath = `mix://${crypto.randomUUID()}`;

  // Duration: the shortest source runtime from each track's start offset
  let duration = null;
  const lens = [];
  const tcfg = Array.isArray(config?.t) ? config.t : [];
  for (let i = 0; i < media_ids.length; i++) {
    const m = d.prepare('SELECT duration_seconds FROM media WHERE id = ?').get(media_ids[i]);
    if (m?.duration_seconds) lens.push(Math.max(0, m.duration_seconds - (tcfg[i]?.s || 0)));
  }
  if (lens.length) duration = Math.min(...lens);

  const tx = d.transaction(() => {
    const info = d.prepare(`
      INSERT INTO media (filepath, filename, media_type, duration_seconds,
        description, name_key, processed_at, model_used, frames_analyzed)
      VALUES (?, ?, 'mix', ?, ?, ?, datetime('now'), 'custom-mix', 0)
    `).run(filepath, title, duration, description, filepath);
    const media_id = info.lastInsertRowid;
    d.prepare(`
      INSERT INTO custom_mixes (media_id, song_id, media_ids, config_json)
      VALUES (?, ?, ?, ?)
    `).run(media_id, song_id, JSON.stringify(media_ids), JSON.stringify(config || {}));
    return media_id;
  });
  return tx();
}

function getCustomMix(media_id) {
  const row = db().prepare('SELECT * FROM custom_mixes WHERE media_id = ?').get(media_id);
  if (!row) return null;
  try { row.media_ids = JSON.parse(row.media_ids); } catch { row.media_ids = []; }
  try { row.config = JSON.parse(row.config_json); } catch { row.config = {}; }
  return row;
}

function updateCustomMix(media_id, { title, description, config, media_ids, song_id }) {
  const d = db();
  const sets = [];
  const vals = [];
  if (typeof title === 'string' && title.trim()) { sets.push('filename = ?'); vals.push(title.trim()); }
  if (typeof description === 'string') { sets.push('description = ?'); vals.push(description); }
  if (sets.length) d.prepare(`UPDATE media SET ${sets.join(', ')} WHERE id = ?`).run(...vals, media_id);

  if (config !== undefined || media_ids !== undefined || song_id !== undefined) {
    const cur = getCustomMix(media_id);
    if (cur) {
      d.prepare('UPDATE custom_mixes SET song_id = ?, media_ids = ?, config_json = ? WHERE media_id = ?').run(
        song_id !== undefined ? song_id : cur.song_id,
        JSON.stringify(media_ids !== undefined ? media_ids : cur.media_ids),
        JSON.stringify(config !== undefined ? config : cur.config),
        media_id
      );
    }
  }
  return db().prepare('SELECT * FROM media WHERE id = ?').get(media_id);
}

/* ── Cleanup + stats ────────────────────────────────────────────────────── */

/** Remove music rows for deleted media records (called from db.deleteRecords). */
function cleanupForMedia(d, media_id) {
  // Called with the raw db handle mid-transaction — table may not exist yet
  // on DBs that never used Music ID.
  try {
    d.prepare('DELETE FROM media_songs WHERE media_id = ?').run(media_id);
    d.prepare('DELETE FROM media_fingerprints WHERE media_id = ?').run(media_id);
    d.prepare('UPDATE song_fingerprints SET media_id = NULL WHERE media_id = ?').run(media_id);
    d.prepare('DELETE FROM custom_mixes WHERE media_id = ?').run(media_id);
  } catch { /* music schema absent — nothing to clean */ }
}

function getStats() {
  const d = db();
  const n = (sql) => d.prepare(sql).get().n;
  return {
    songs: n('SELECT COUNT(*) AS n FROM songs'),
    unknown_songs: n("SELECT COUNT(*) AS n FROM songs WHERE source = 'auto-cluster'"),
    links: n('SELECT COUNT(*) AS n FROM media_songs'),
    fingerprinted_media: n('SELECT COUNT(DISTINCT media_id) AS n FROM media_fingerprints'),
    chunks: n('SELECT COUNT(*) AS n FROM media_fingerprints'),
    references: n('SELECT COUNT(*) AS n FROM song_fingerprints'),
  };
}

module.exports = {
  ensureSchema, db,
  findOrCreateSong, listSongs, getSong, updateSong, deleteSong,
  linkSongToMedia, unlinkSong, getLink, updateLink, songsForMedia, mediaForSong, linksMap,
  saveMediaFingerprints, getMediaFingerprints, mediaHasFingerprints, fingerprintCounts,
  deleteMediaFingerprints, allChunksExcept,
  saveSongFingerprint, listSongFingerprints, hasSongReference,
  listPresets, getPreset, savePreset, deletePreset,
  seedCount, importSeedFile, searchSeed,
  createCustomMix, getCustomMix, updateCustomMix,
  cleanupForMedia, getStats,
};
