/**
 * Flow routes (lib/flow/service.js): measure a collection's music and put it
 * in Flow order.
 *
 *   GET  /api/flow/status[?collection=ID]   the queue (and that collection's counts)
 *   GET  /api/flow/collections/:id?shape=build&first=ID
 *        Flow order: { shape, order, playlistOrder, features, targets,
 *        handovers, jumps, playlistJumps, counts }. Computed (in Flow's worker
 *        thread, cached until something changes) from what is measured so far;
 *        files not measured yet are placed by the shape alone. 413 TOO_MANY
 *        over 5,000 files (status says so too: counts.tooMany).
 *   POST /api/flow/collections/:id/measure  { retry? }  queue what is not measured
 *   POST /api/flow/pause | /api/flow/resume | /api/flow/cancel
 *   GET  /api/flow/media/:id                one file (the Stage bar's line)
 *
 * Saving Flow order as the playlist order is the existing
 * POST /api/collections/:id/order { order } (and Undo the same, with the old
 * order), so nothing here writes a collection.
 *
 * Everything is under /api: the lock gate (423 while locked) and the CSRF /
 * Host / Fetch Metadata guards in server/index.js cover it.
 */

const express = require('express');
const flow = require('../lib/flow/service');

const ERR = { NOT_FOUND: 404, FOLDER: 400, TOO_MANY: 413, VAULT_LOCKED: 423 };

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && String(v).trim() === String(n) ? n : null;
}

function buildRouter() {
  const router = express.Router();

  const fail = (res, err) => {
    const status = ERR[err && err.code];
    if (status) return res.status(status).json({ error: err.message, code: err.code });
    console.warn('[Flow]', err && err.message);
    return res.status(500).json({ error: 'Flow could not do that.' });
  };

  router.get('/api/flow/status', (req, res) => {
    try {
      const cid = req.query.collection == null ? null : parseId(req.query.collection);
      if (req.query.collection != null && !cid) return res.status(400).json({ error: 'bad collection id' });
      res.json(flow.status(cid));
    } catch (err) { fail(res, err); }
  });

  router.get('/api/flow/collections/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const shape = String(req.query.shape || 'smooth');
    if (!require('../player-lib/flow-order.js').isShape(shape)) return res.status(400).json({ error: 'shape must be smooth, build, waves, peak or steady' });
    let first = null;
    if (req.query.first != null && req.query.first !== '') {
      first = parseId(req.query.first);
      if (!first) return res.status(400).json({ error: 'bad first id' });
    }
    try {
      res.json(await flow.collectionFlow(id, { shape, firstId: first }));
    } catch (err) { fail(res, err); }
  });

  router.post('/api/flow/collections/:id/measure', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      res.json(flow.requestCollection(id, { retry: !!(req.body && req.body.retry === true) }));
    } catch (err) { fail(res, err); }
  });

  router.post('/api/flow/pause', (req, res) => res.json(flow.pause()));
  router.post('/api/flow/resume', (req, res) => res.json(flow.resume()));
  router.post('/api/flow/cancel', (req, res) => res.json(flow.cancel()));

  router.get('/api/flow/media/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const f = flow.mediaFeatures(id);
      if (!f) return res.status(404).json({ error: 'not in the library' });
      res.json(f);
    } catch (err) { fail(res, err); }
  });

  return router;
}

module.exports = { buildRouter };
