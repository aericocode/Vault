/**
 * Face search routes (FACES_BUILD_SPEC section 7), mounted at /api.
 *
 * Everything is under /api/, so the vault-lock gate and the CSRF guard in
 * server/index.js cover these routes. The indexing starts (/api/faces/index,
 * /api/faces/queue/resume, /api/media/:id/find-faces) are also in
 * MIGRATE_BLOCKED_ROUTES there.
 *
 * Feature off -> every route except status, settings (the enable switch),
 * models/download (part of turning it on) and delete-all answers
 * 409 { code: 'FACES_OFF' }. Routes that need the engine or the current model
 * answer 409 { code: 'FACE_MODELS_MISSING', missing } until the models exist.
 */

const express = require('express');
const faces = require('../lib/faces/service');

const SEARCH_IMAGE_LIMIT = '25mb';

const svc = () => faces.instance();

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 0xFFFFFFFF && /^\d+$/.test(String(v)) ? n : null;
}

function vaultLocked() {
  try { return require('../lib/vault').isLocked(); } catch { return false; }
}

function sendError(res, err) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That photo is too big (25 MB at most).', code: 'TOO_LARGE' });
  }
  if (err && err.type) {   // other body-parser failures (bad JSON, bad encoding)
    return res.status(err.status || 400).json({ error: err.message, code: 'BAD_BODY' });
  }
  // The vault locked while this request was awaiting work (indexing, ffmpeg,
  // inference): the DB closed under it. Answer like the lock gate does, not
  // with a 500 and a stack.
  if (err && (err.code === 'DB_ENCRYPTED' || err.code === 'VAULT_LOCKED' || (!err.status && vaultLocked()))) {
    return res.status(423).json({ error: 'vault is locked', code: 'VAULT_LOCKED' });
  }
  if (err && err.status) {
    const body = { error: err.message, code: err.code };
    if (err.missing) body.missing = err.missing;
    if (err.keys) body.keys = err.keys;
    if (err.otherId !== undefined) { body.otherId = err.otherId; body.other = err.other; }
    if (err.skipped) body.skipped = err.skipped;
    return res.status(err.status).json(body);
  }
  console.error(`[faces] ${err && err.stack ? err.stack : err}`);
  return res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

/** Wrap a handler so thrown/rejected errors land in sendError. */
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
};

function requireEnabled(req, res, next) {
  if (svc().getSettings().enabled) return next();
  res.status(409).json({ error: 'Face search is turned off.', code: 'FACES_OFF' });
}

function requireModels(req, res, next) {
  const m = svc().models();
  if (m.ready) return next();
  res.status(409).json({ error: 'Face search models are not downloaded yet.', code: 'FACE_MODELS_MISSING', missing: m.missing });
}

function idParam(name) {
  return (req, res, next) => {
    const id = parseId(req.params[name]);
    if (!id) return res.status(400).json({ error: `bad ${name}`, code: 'BAD_ID' });
    req.faceId = id;
    next();
  };
}

function sendJpeg(res, buf, cacheControl) {
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', cacheControl);
  res.end(buf);
}

function buildRouter() {
  const router = express.Router();
  const on = requireEnabled;
  const ready = [requireEnabled, requireModels];

  router.get('/faces/status', h(() => svc().status()));

  router.post('/faces/settings', h((req) => svc().updateSettings(req.body || {})));

  // { model?: 'ir50' | 'ir101' }: the grunt models plus that keeper (default: the chosen one).
  router.post('/faces/models/download', h((req) => svc().startDownload(req.body || {})));

  // The background face model switch (status: GET /faces/status -> modelSwitch).
  router.post('/faces/model-switch/pause', on, h(() => svc().pauseModelSwitch()));
  router.post('/faces/model-switch/resume', ...ready, h(() => svc().resumeModelSwitch()));

  router.post('/faces/index', ...ready, h((req) => {
    const b = req.body || {};
    return svc().enqueue({ ids: b.ids, all: b.all === true, force: b.force === true, reason: b.all === true ? 'all' : 'user' });
  }));

  router.post('/faces/queue/pause', on, h(() => svc().pause()));
  router.post('/faces/queue/resume', ...ready, h(() => svc().resume()));
  router.post('/faces/queue/cancel', on, h(() => svc().cancel()));

  router.get('/media/:id/faces', on, idParam('id'), h((req) => svc().fileFaces(req.faceId)));

  router.post('/media/:id/find-faces', on, idParam('id'),
    h((req) => svc().findFacesNow(req.faceId, { force: req.body?.force === true })));

  // Plain library: ids are never reused (AUTOINCREMENT), so the bytes behind a
  // crop URL never change. Vault mode: never cached, like thumbnails.
  router.get('/faces/crop/:groupId', on, idParam('groupId'), h((req, res) => {
    const buf = svc().groupCrop(req.faceId);
    const secure = require('../lib/secure-assets').enabled();
    sendJpeg(res, buf, secure ? 'no-store' : 'private, max-age=31536000, immutable');
  }));

  router.post('/faces/groups/:groupId/similar', ...ready, idParam('groupId'),
    h((req) => svc().similarToGroup(req.faceId, req.body?.width)));

  router.post('/faces/groups/:groupId/hide', on, idParam('groupId'), h((req) => svc().hideGroup(req.faceId)));
  router.post('/faces/groups/:groupId/unhide', on, idParam('groupId'), h((req) => svc().unhideGroup(req.faceId)));
  router.post('/faces/groups/:groupId/not-a-face', on, idParam('groupId'), h((req) => svc().notFaceGroup(req.faceId)));

  // Raw image body (Content-Type image/*, 25 MB max) or JSON { mediaId, timeS }.
  // The global JSON parser has already handled the JSON form; the raw parser
  // only claims image/* bodies and only on this route.
  router.post('/faces/search-image', ...ready,
    // Snapshot the vault-lock generation BEFORE the body is read: an upload
    // still arriving when the vault locks must not be searched (or cached).
    (req, res, next) => { req.faceLockGen = svc().lockGeneration(); next(); },
    express.raw({ type: 'image/*', limit: SEARCH_IMAGE_LIMIT }),
    h((req) => {
      if (Buffer.isBuffer(req.body)) {
        return svc().searchImage({ buffer: req.body, contentType: req.get('Content-Type'), lockGen: req.faceLockGen });
      }
      if (req.body && typeof req.body === 'object' && req.body.mediaId !== undefined) {
        return svc().searchImage({ mediaId: req.body.mediaId, timeS: req.body.timeS, lockGen: req.faceLockGen });
      }
      const e = new Error('send an image (Content-Type image/*) or JSON { mediaId, timeS }');
      e.status = 400; e.code = 'BAD_REQUEST';
      throw e;
    }));

  router.get('/faces/query/:queryId/crop', on, h((req, res) => {
    sendJpeg(res, svc().queryCrop(String(req.params.queryId)), 'no-store');
  }));

  router.post('/faces/query/:queryId/similar', ...ready,
    h((req) => svc().similarToQuery(String(req.params.queryId), req.body?.width)));

  // People across the library (FACES_PEOPLE_SPEC section 3). Pure database
  // work: the feature must be on, the models need not be present.
  router.get('/faces/people', on, h((req) => svc().listPeople(req.query || {})));
  router.post('/faces/people', on, h((req) => svc().createPerson(req.body || {})));
  router.post('/faces/people/merge', on, h((req) => svc().mergePeople(req.body || {})));
  router.get('/faces/people/:id', on, idParam('id'), h((req) => svc().getPerson(req.faceId)));
  router.get('/faces/people/:id/files', on, idParam('id'), h((req) => svc().personFiles(req.faceId, req.query.kind)));
  router.get('/faces/people/:id/faces', on, idParam('id'), h((req) => svc().personFaces(req.faceId, req.query.limit)));
  router.post('/faces/people/:id', on, idParam('id'), h((req) => svc().updatePerson(req.faceId, req.body || {})));
  router.post('/faces/people/:id/not-in', on, idParam('id'), h((req) => svc().notInPerson(req.faceId, req.body || {})));
  router.post('/faces/people/:id/restore', on, idParam('id'), h((req) => svc().restorePerson(req.faceId, req.body || {})));
  // Round 3 (FACES_FEEDBACK_SPEC E2, E4, E6).
  router.post('/faces/people/:id/add', on, idParam('id'), h((req) => svc().addToPerson(req.faceId, req.body || {})));
  router.get('/faces/people/:id/candidates', on, idParam('id'), h((req) => svc().personCandidates(req.faceId, req.query || {})));
  router.post('/faces/people/:id/candidates', on, idParam('id'), h((req) => svc().answerCandidates(req.faceId, req.body || {})));
  router.post('/faces/people/:id/not-a-face', on, idParam('id'), h((req) => svc().notFacePerson(req.faceId)));
  router.get('/faces/review', on, h((req) => svc().reviewPairs(req.query || {})));
  router.post('/faces/review', on, h((req) => svc().answerReview(req.body || {})));

  router.post('/faces/delete-all', h(() => svc().deleteAll()));

  // Body-parser failures on these routes (413 from the raw parser) as JSON.
  // Mounted at /api, so anything else's errors pass straight through.
  router.use((err, req, res, next) => {
    if (!/^\/faces\//.test(req.path) && !/^\/media\/\d+\/(faces|find-faces)$/.test(req.path)) return next(err);
    sendError(res, err);
  });

  return router;
}

module.exports = { buildRouter };
