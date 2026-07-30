/**
 * PMV Studio — persistence, living in the main vault.db.
 *
 * pmv_jobs: DB-backed job rows (survive restarts — the sample kept jobs in a
 * Map). Heavy artifacts (segments in memory) die with the process; a job
 * interrupted mid-analysis is marked error and can be re-run cheaply thanks
 * to the analysis caches.
 *
 * pmv_video_analysis / pmv_audio_analysis: per-media caches — scene/motion/
 * beat analysis is a pure function of the file, so repeat generations skip
 * straight to EDL + render (spec §7.3).
 *
 * PMV recipes live in the existing mix_presets table via a new `kind` column
 * ('mix' default | 'pmv') — spec §8.1.
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
    CREATE TABLE IF NOT EXISTS pmv_jobs (
      id           TEXT PRIMARY KEY,
      status       TEXT NOT NULL DEFAULT 'queued',
      progress     REAL DEFAULT 0,
      stage        TEXT,
      video_ids    TEXT NOT NULL,
      audio_ids    TEXT NOT NULL,
      options      TEXT NOT NULL,
      edl          TEXT,
      result       TEXT,
      error        TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pmv_video_analysis (
      media_id    INTEGER PRIMARY KEY,
      params_hash TEXT NOT NULL,
      segments    TEXT NOT NULL,
      duration    REAL,
      width       INTEGER,
      height      INTEGER,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pmv_audio_analysis (
      media_id    INTEGER PRIMARY KEY,
      params_hash TEXT NOT NULL,
      analysis    TEXT NOT NULL,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  // Recipes share mix_presets (musicid schema owns the table; it may not
  // exist yet if Music ID was never touched — create-compatible then alter)
  try {
    require('../musicid/repo').ensureSchema(d);
  } catch { /* musicid unavailable — presets disabled gracefully */ }
  try { d.exec("ALTER TABLE mix_presets ADD COLUMN kind TEXT DEFAULT 'mix'"); }
  catch { /* column already exists */ }
}

/* ── Jobs ───────────────────────────────────────────────────────────────── */

function genJobId() {
  return 'pmv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

// Job ids are server-generated (genJobId). Any request-supplied id that reaches
// the filesystem MUST match this shape first — a raw id in path.join() would
// otherwise allow ../ traversal out of the previews/work dirs.
const JOB_ID_RE = /^pmv_[a-z0-9]+_[a-z0-9]+$/;
function isValidJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

function _hydrateJob(row) {
  if (!row) return null;
  for (const k of ['video_ids', 'audio_ids', 'options', 'edl', 'result']) {
    try { row[k] = row[k] == null ? null : JSON.parse(row[k]); } catch { row[k] = null; }
  }
  return row;
}

function createJob({ video_ids, audio_ids, options }) {
  const id = genJobId();
  db().prepare(`
    INSERT INTO pmv_jobs (id, video_ids, audio_ids, options)
    VALUES (?, ?, ?, ?)
  `).run(id, JSON.stringify(video_ids), JSON.stringify(audio_ids), JSON.stringify(options || {}));
  return getJob(id);
}

function getJob(id) {
  return _hydrateJob(db().prepare('SELECT * FROM pmv_jobs WHERE id = ?').get(id));
}

function listJobs({ limit = 20 } = {}) {
  return db().prepare('SELECT * FROM pmv_jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(_hydrateJob);
}

function updateJob(id, fields) {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!['status', 'progress', 'stage', 'edl', 'result', 'error', 'completed_at'].includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push((k === 'edl' || k === 'result') && v != null ? JSON.stringify(v) : v);
  }
  if (!sets.length) return;
  db().prepare(`UPDATE pmv_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

function deleteJob(id) {
  return db().prepare('DELETE FROM pmv_jobs WHERE id = ?').run(id);
}

/** Mark any job left running by a previous process as interrupted (boot). */
function failStaleJobs() {
  db().prepare(`
    UPDATE pmv_jobs SET status = 'error', error = 'interrupted by server restart'
    WHERE status IN ('queued', 'analyzing', 'rendering')
  `).run();
}

/* ── Analysis caches ────────────────────────────────────────────────────── */

function getVideoAnalysis(media_id, params_hash) {
  const row = db().prepare('SELECT * FROM pmv_video_analysis WHERE media_id = ?').get(media_id);
  if (!row || row.params_hash !== params_hash) return null;
  try { row.segments = JSON.parse(row.segments); } catch { return null; }
  return row;
}

function putVideoAnalysis(media_id, params_hash, { segments, duration, width, height }) {
  db().prepare(`
    INSERT INTO pmv_video_analysis (media_id, params_hash, segments, duration, width, height, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(media_id) DO UPDATE SET
      params_hash = excluded.params_hash, segments = excluded.segments,
      duration = excluded.duration, width = excluded.width, height = excluded.height,
      created_at = datetime('now')
  `).run(media_id, params_hash, JSON.stringify(segments), duration, width, height);
}

function getAudioAnalysis(media_id, params_hash) {
  const row = db().prepare('SELECT * FROM pmv_audio_analysis WHERE media_id = ?').get(media_id);
  if (!row || row.params_hash !== params_hash) return null;
  try { return JSON.parse(row.analysis); } catch { return null; }
}

function putAudioAnalysis(media_id, params_hash, analysis) {
  db().prepare(`
    INSERT INTO pmv_audio_analysis (media_id, params_hash, analysis, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(media_id) DO UPDATE SET
      params_hash = excluded.params_hash, analysis = excluded.analysis, created_at = datetime('now')
  `).run(media_id, params_hash, JSON.stringify(analysis));
}

/* ── Recipes (mix_presets rows with kind='pmv') ─────────────────────────── */

function listRecipes() {
  try {
    return db().prepare(`
      SELECT id, name, media_ids, config_json, song_id, created_at
      FROM mix_presets WHERE kind = 'pmv' ORDER BY created_at DESC
    `).all().map(r => {
      try { r.media_ids = JSON.parse(r.media_ids); } catch { r.media_ids = []; }
      try { r.config = JSON.parse(r.config_json); } catch { r.config = {}; }
      delete r.config_json;
      return r;
    });
  } catch { return []; }
}

function saveRecipe({ name, media_ids, config, song_id = null }) {
  // Names are UNIQUE table-wide — never hijack a same-named MIX preset
  const existing = db().prepare('SELECT id, kind FROM mix_presets WHERE name = ?').get(name);
  if (existing && (existing.kind || 'mix') !== 'pmv') {
    const err = new Error(`a stack-mix preset named "${name}" already exists`);
    err.code = 'NAME_TAKEN';
    throw err;
  }
  db().prepare(`
    INSERT INTO mix_presets (song_id, name, media_ids, config_json, kind)
    VALUES (?, ?, ?, ?, 'pmv')
    ON CONFLICT(name) DO UPDATE SET
      media_ids = excluded.media_ids, config_json = excluded.config_json,
      song_id = excluded.song_id, kind = 'pmv'
  `).run(song_id, name, JSON.stringify(media_ids), JSON.stringify(config || {}));
  return listRecipes().find(r => r.name === name);
}

function deleteRecipe(id) {
  return db().prepare("DELETE FROM mix_presets WHERE id = ? AND kind = 'pmv'").run(id);
}

/** Remove analysis caches for deleted media (called from db.deleteRecords). */
function cleanupForMedia(d, media_id) {
  try {
    d.prepare('DELETE FROM pmv_video_analysis WHERE media_id = ?').run(media_id);
    d.prepare('DELETE FROM pmv_audio_analysis WHERE media_id = ?').run(media_id);
  } catch { /* pmv schema absent — nothing to clean */ }
}

module.exports = {
  db, ensureSchema, genJobId, isValidJobId,
  createJob, getJob, listJobs, updateJob, deleteJob, failStaleJobs,
  getVideoAnalysis, putVideoAnalysis, getAudioAnalysis, putAudioAnalysis,
  listRecipes, saveRecipe, deleteRecipe,
  cleanupForMedia,
};
