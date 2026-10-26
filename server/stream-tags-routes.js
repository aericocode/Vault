/**
 * Stream tags routes (lib/stream-tags.js), mounted at /api.
 *
 *   GET  /api/stream-tags                       lanes in order, each with its tags
 *   GET  /api/stream-tags/assignments           every assignment: { rows: [[mediaId, tagId], ...] }
 *   POST /api/stream-tags/for { mediaIds }      { assignments: { mediaId: [tagId] } }
 *   GET  /api/stream-tags/collections/:id       the same for a collection's files
 *
 *   POST   /api/stream-tags/lanes { name, multi }              a new lane (last)
 *   POST   /api/stream-tags/lanes/order { ids }                lanes in this order
 *   POST   /api/stream-tags/lanes/:id { name?, multi? }        rename / One or Several per file
 *   DELETE /api/stream-tags/lanes/:id  (or POST .../delete)    the lane, its tags, their assignments
 *   POST   /api/stream-tags/lanes/:id/order { ids }            the lane's tags in this order
 *
 *   POST   /api/stream-tags/tags { laneId, name, color, hotkey?, place? }
 *   POST   /api/stream-tags/tags/:id { name?, color?, hotkey?, place? }
 *   DELETE /api/stream-tags/tags/:id  (or POST .../delete)
 *
 *   POST /api/stream-tags/assign { tagId, mediaIds, op: add | remove | toggle }
 *   POST /api/stream-tags/clear { mediaIds, laneId? }
 *
 * Everything is under /api: the vault-lock gate (423), the Host and Fetch
 * Metadata checks and the CSRF guard in server/index.js cover these routes,
 * and the JSON body is the app's 2 MB parser.
 */

const express = require('express');
const database = require('../lib/database');
const tags = require('../lib/stream-tags');

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 0xFFFFFFFF && /^\d+$/.test(String(v)) ? n : null;
}

function vaultLocked() {
  try { return require('../lib/vault').isLocked(); } catch { return false; }
}

function sendError(res, err) {
  if (err && (err.code === 'DB_ENCRYPTED' || err.code === 'VAULT_LOCKED' || (!err.status && vaultLocked()))) {
    return res.status(423).json({ error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' });
  }
  if (err && err.status) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`[stream-tags] ${err && err.stack ? err.stack : err}`);
  return res.status(500).json({ error: 'Stream tags could not do that.' });
}

const h = (fn) => (req, res) => {
  try {
    const out = fn(req, database.get());
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
};

function idParam(req, res, next) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id', code: 'BAD_ID' });
  req.sid = id;
  next();
}

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function buildRouter() {
  const router = express.Router();

  router.get('/stream-tags', h((req, db) => ({ lanes: tags.list(db), places: tags.PLACES })));
  router.get('/stream-tags/assignments', h((req, db) => ({ rows: tags.allAssignments(db) })));
  router.post('/stream-tags/for', h((req, db) => ({ assignments: tags.forMedia(db, body(req).mediaIds) })));
  router.get('/stream-tags/collections/:id', idParam, h((req, db) => ({ assignments: tags.forCollection(db, req.sid) })));

  router.post('/stream-tags/lanes', h((req, db) => tags.createLane(db, body(req))));
  // Before /lanes/:id so "order" is never read as an id.
  router.post('/stream-tags/lanes/order', h((req, db) => ({ lanes: tags.reorderLanes(db, body(req).ids) })));
  router.post('/stream-tags/lanes/:id', idParam, h((req, db) => tags.updateLane(db, req.sid, body(req))));
  router.delete('/stream-tags/lanes/:id', idParam, h((req, db) => tags.deleteLane(db, req.sid)));
  router.post('/stream-tags/lanes/:id/delete', idParam, h((req, db) => tags.deleteLane(db, req.sid)));
  router.post('/stream-tags/lanes/:id/order', idParam, h((req, db) => tags.reorderTags(db, req.sid, body(req).ids)));

  router.post('/stream-tags/tags', h((req, db) => tags.createTag(db, body(req))));
  router.post('/stream-tags/tags/:id', idParam, h((req, db) => tags.updateTag(db, req.sid, body(req))));
  router.delete('/stream-tags/tags/:id', idParam, h((req, db) => tags.deleteTag(db, req.sid)));
  router.post('/stream-tags/tags/:id/delete', idParam, h((req, db) => tags.deleteTag(db, req.sid)));

  router.post('/stream-tags/assign', h((req, db) => tags.assign(db, body(req))));
  router.post('/stream-tags/clear', h((req, db) => tags.clear(db, body(req))));

  return router;
}

module.exports = { buildRouter };
