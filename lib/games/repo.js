/**
 * Games — save persistence, living in the main video_metadata.db.
 *
 * Multiple saves per game: one row per save_id, many per game_key, so several
 * runs of the same game can be in progress at once (home screen shows them as
 * cards). The client mirrors to localStorage for instant restore. Schema is
 * created lazily on first use (ensureSchema is idempotent, safe every boot)
 * and migrates the old one-slot-per-game table in place.
 */

const database = require('../database');

let _ready = false;

function db() {
  const d = database.get();
  if (!_ready) { ensureSchema(d); _ready = true; }
  return d;
}

/** Random, collision-safe save id (also generated client-side on new games). */
function genSaveId() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
}

function _cols(d, table) {
  try { return d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch { return []; }
}

function ensureSchema(d) {
  const cols = _cols(d, 'game_saves');
  // Old shape keyed on game_key (one slot per game) — no save_id column.
  const legacy = cols.length > 0 && !cols.includes('save_id');
  if (legacy) d.exec('ALTER TABLE game_saves RENAME TO game_saves_legacy;');

  d.exec(`
    CREATE TABLE IF NOT EXISTS game_saves (
      save_id    TEXT PRIMARY KEY,
      game_key   TEXT NOT NULL,
      media_id   INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_game_saves_key   ON game_saves(game_key);
    CREATE INDEX IF NOT EXISTS idx_game_saves_media ON game_saves(media_id);
  `);

  if (legacy) {
    // Each old slot becomes that game's first save, keeping its timestamp.
    const old = d.prepare('SELECT * FROM game_saves_legacy').all();
    const ins = d.prepare(`
      INSERT INTO game_saves (save_id, game_key, media_id, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
    `);
    const run = d.transaction((rows) => {
      for (const r of rows) ins.run(genSaveId(), r.game_key, r.media_id, r.state_json, r.updated_at, r.updated_at);
    });
    run(old);
    d.exec('DROP TABLE game_saves_legacy;');
  }
}

function _hydrate(row) {
  if (!row) return null;
  try { row.state = JSON.parse(row.state_json); } catch { row.state = null; }
  return row;
}

/** All saves grouped by game_key, newest first: { key: [ {save_id, media_id, state, created_at, updated_at}, ... ] } */
function listSaves() {
  const rows = db().prepare('SELECT * FROM game_saves ORDER BY updated_at DESC, created_at DESC').all();
  const out = {};
  for (const r of rows) (out[r.game_key] || (out[r.game_key] = [])).push(_hydrate(r));
  return out;
}

function getSave(save_id) {
  return _hydrate(db().prepare('SELECT * FROM game_saves WHERE save_id = ?').get(save_id));
}

function countForGame(game_key) {
  return db().prepare('SELECT COUNT(*) AS n FROM game_saves WHERE game_key = ?').get(game_key).n;
}

/** Upsert one save by save_id. state is a plain object (stringified here). */
function putSave(save_id, game_key, media_id, state) {
  db().prepare(`
    INSERT INTO game_saves (save_id, game_key, media_id, state_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(save_id) DO UPDATE SET
      media_id = excluded.media_id,
      state_json = excluded.state_json,
      updated_at = datetime('now')
  `).run(save_id, game_key, media_id, JSON.stringify(state ?? {}));
  return getSave(save_id);
}

function deleteSave(save_id) {
  return db().prepare('DELETE FROM game_saves WHERE save_id = ?').run(save_id);
}

/** Remove saves referencing a deleted media record (called from db.deleteRecords). */
function cleanupForMedia(d, media_id) {
  try {
    d.prepare('DELETE FROM game_saves WHERE media_id = ?').run(media_id);
  } catch { /* games schema absent — nothing to clean */ }
}

module.exports = {
  ensureSchema, genSaveId, listSaves, getSave, countForGame, putSave, deleteSave, cleanupForMedia,
};
