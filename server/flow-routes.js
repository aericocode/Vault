/**
 * Flow routes (lib/flow/service.js): measure a collection's music and put it
 * in Flow order.
 *
 *   GET  /api/flow/status[?collection=ID]   the queue (and that collection's counts,
 *        with queued / queuedFailed / again: its files still to do), workerError
 *   GET  /api/flow/collections/:id?shape=build&first=ID&places=1&waves=3
 *        (waves: Waves' peaks, 1..6, 2 when missing or not one of those)
 *        Flow order: { shape, waves, order, playlistOrder, features (a file that
 *        could not be measured has reason, in plain words, and error, as
 *        ffmpeg said it), targets,
 *        handovers, jumps, playlistJumps, counts, places, placesOn }.
 *        places=1: files with a placed stream tag go where it says (First,
 *        Last, At a peak... lib/stream-tags.js); the answer's places is every
 *        file's place ({ id: place }) either way. Computed (in Flow's worker
 *        thread, cached until something changes) from what is measured so far;
 *        files not measured yet are placed by the shape alone. 413 TOO_MANY
 *        over 5,000 files (status says so too: counts.tooMany).
 *   POST /api/flow/collections/:id/measure  { retry?, all? }  queue what is not
 *        measured; retry: the ones that failed too (Try again); all: every
 *        file again, measured or not (Measure again: measured ones keep their
 *        numbers until the new measurement succeeds)
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
const FlowOrder = require('../player-lib/flow-order.js');

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
    if (!FlowOrder.isShape(shape)) return res.status(400).json({ error: 'shape must be smooth, build, waves, peak or steady' });
    let first = null;
    if (req.query.first != null && req.query.first !== '') {
      first = parseId(req.query.first);
      if (!first) return res.status(400).json({ error: 'bad first id' });
    }
    // Waves: how many peaks, 1..6 (2 when missing or anything else).
    const waves = FlowOrder.wavesCount(req.query.waves == null ? null : String(req.query.waves));
    const places = req.query.places == null || req.query.places === '' ? '0' : String(req.query.places);
    if (places !== '0' && places !== '1') return res.status(400).json({ error: 'places must be 0 or 1' });
    try {
      res.json(await flow.collectionFlow(id, { shape, waves, firstId: first, places: places === '1' }));
    } catch (err) { fail(res, err); }
  });

  router.post('/api/flow/collections/:id/measure', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const b = req.body || {};
      res.json(flow.requestCollection(id, { retry: b.retry === true, all: b.all === true }));
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
