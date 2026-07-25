/**
 * Games routes (/api/games/*) — per-game save management.
 *
 * Many saves per game_key in the game_saves table (see lib/games/repo.js), each
 * keyed by a client-generated save_id; the client mirrors to localStorage for
 * instant restore. Writes validate the media id and enforce each game's
 * accepted media types, plus a generous per-game cap.
 */

const express = require('express');
const db = require('../lib/database');
const repo = require('../lib/games/repo');

// Which media types each game accepts (server-side allowlist; mirrors the
// client registry). Add a key here when a new game ships.
const GAME_ACCEPT_TYPES = {
  reelorder: ['video'],
  framefit: ['video', 'gif', 'image'],
};

// Cap concurrent saves per game — generous, just guards against unbounded
// clutter/storage. Mirrored client-side (player-lib/games/games.js).
const GAMES_MAX_SAVES = 24;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function buildRouter() {
  const router = express.Router();

  // All saves grouped by game_key, newest first (home screen cards)
  router.get('/saves', (req, res) => {
    res.json(repo.listSaves());
  });

  // Upsert a specific save: { media_id, state }
  router.put('/saves/:key/:saveId', (req, res) => {
    const key = String(req.params.key || '');
    const saveId = String(req.params.saveId || '');
    const accept = GAME_ACCEPT_TYPES[key];
    if (!accept) return res.status(400).json({ error: 'unknown game' });
    if (!saveId) return res.status(400).json({ error: 'save id required' });

    const mediaId = parseId(req.body?.media_id);
    if (!mediaId) return res.status(400).json({ error: 'media_id required' });

    const row = db.getById(mediaId);
    if (!row) return res.status(404).json({ error: 'media not found' });
    if (!accept.includes(row.media_type)) {
      return res.status(400).json({ error: `${key} does not accept ${row.media_type}` });
    }

    // Enforce the per-game cap only when this would be a brand-new save
    if (!repo.getSave(saveId) && repo.countForGame(key) >= GAMES_MAX_SAVES) {
      return res.status(409).json({ error: `save limit reached (${GAMES_MAX_SAVES})`, limit: GAMES_MAX_SAVES });
    }

    const save = repo.putSave(saveId, key, mediaId, req.body?.state ?? {});
    res.json({ save });
  });

  router.delete('/saves/:key/:saveId', (req, res) => {
    const key = String(req.params.key || '');
    const saveId = String(req.params.saveId || '');
    if (!GAME_ACCEPT_TYPES[key]) return res.status(400).json({ error: 'unknown game' });
    if (!saveId) return res.status(400).json({ error: 'save id required' });
    repo.deleteSave(saveId);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { buildRouter, GAME_ACCEPT_TYPES, GAMES_MAX_SAVES };
