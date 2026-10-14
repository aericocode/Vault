/**
 * Studios routes (STUDIOS_SPEC section 2), mounted at /api.
 *
 * Everything is under /api/, so the vault-lock gate (423) and the CSRF guard
 * in server/index.js cover these routes. The writes that move files between
 * studios are in MIGRATE_BLOCKED_ROUTES there.
 *
 * Studios work with face search off; the people parts then come back empty
 * and adding a member answers 409 FACES_OFF.
 */

const express = require('express');
const studios = require('../lib/studios');

const COVER_LIMIT = '15mb';

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 0xFFFFFFFF && /^\d+$/.test(String(v)) ? n : null;
}

function vaultLocked() {
  try { return require('../lib/vault').isLocked(); } catch { return false; }
}

function sendError(res, err) {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'That photo is too big (15 MB at most).', code: 'TOO_LARGE' });
  }
  if (err && err.type) {   // other body-parser failures (bad JSON, bad encoding)
    return res.status(err.status || 400).json({ error: err.message, code: 'BAD_BODY' });
  }
  // The vault locked while this request waited on ffmpeg: the DB closed under it.
  if (err && (err.code === 'DB_ENCRYPTED' || err.code === 'VAULT_LOCKED' || (!err.status && vaultLocked()))) {
    return res.status(423).json({ error: 'vault is locked', code: 'VAULT_LOCKED' });
  }
  if (err && err.status) {
    const body = { error: err.message, code: err.code };
    if (err.otherId !== undefined) { body.otherId = err.otherId; body.other = err.other; }
    return res.status(err.status).json(body);
  }
  console.error(`[studios] ${err && err.stack ? err.stack : err}`);
  return res.status(500).json({ error: err && err.message ? err.message : String(err) });
}

const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
  }
};

function idParam(name) {
  return (req, res, next) => {
    const id = parseId(req.params[name]);
    if (!id) return res.status(400).json({ error: `bad ${name}`, code: 'BAD_ID' });
    req.ids = { ...(req.ids || {}), [name]: id };
    next();
  };
}

function buildRouter() {
  const router = express.Router();
  const sid = idParam('id');

  router.get('/studios', h((req) => studios.list(req.query || {})));
  router.post('/studios', h((req) => studios.create(req.body)));

  // Before /studios/:id so "auto" is never read as an id.
  router.post('/studios/auto/preview', h(() => studios.autoPreview()));
  router.post('/studios/auto/apply', h((req) => studios.autoApply(req.body)));

  router.get('/studios/:id', sid, h((req) => studios.get(req.ids.id)));
  router.post('/studios/:id', sid, h((req) => studios.update(req.ids.id, req.body)));
  router.delete('/studios/:id', sid, h((req) => studios.remove(req.ids.id)));
  router.post('/studios/:id/delete', sid, h((req) => studios.remove(req.ids.id)));
  router.post('/studios/:id/merge', sid, h((req) => studios.merge(req.ids.id, req.body)));
  router.get('/studios/:id/files', sid, h((req) => studios.files(req.ids.id, req.query.kind)));

  // Raw image body (image/*, 15 MB max) | JSON { mediaId, timeS } | JSON { clear: true }.
  // The global JSON parser has already read the JSON forms.
  router.post('/studios/:id/cover', sid, express.raw({ type: 'image/*', limit: COVER_LIMIT }), h((req) => {
    const id = req.ids.id;
    if (Buffer.isBuffer(req.body)) return studios.setCoverUpload(id, req.body, req.get('Content-Type'));
    const b = req.body;
    if (b && typeof b === 'object' && b.clear === true) return studios.clearCover(id);
    if (b && typeof b === 'object' && b.mediaId !== undefined) return studios.setCoverFrame(id, b);
    const e = new Error('send an image (Content-Type image/*), JSON { mediaId, timeS } or JSON { clear: true }');
    e.status = 400; e.code = 'BAD_REQUEST';
    throw e;
  }));
  router.get('/studios/:id/cover', sid, h((req, res) => {
    const out = studios.coverImage(req.ids.id);
    if (out.redirect) return res.redirect(302, out.redirect);
    const secure = require('../lib/secure-assets').enabled();
    res.set('Content-Type', 'image/jpeg');
    // The URL carries ?v=<last change>, so a plain library can cache it.
    res.set('Cache-Control', secure ? 'no-store' : (req.query.v ? 'private, max-age=31536000, immutable' : 'no-cache'));
    res.end(out.buf);
  }));

  router.post('/studios/:id/people', sid, h((req) => studios.setMember(req.ids.id, req.body)));
  router.post('/studios/:id/people/:personId/remove', sid, idParam('personId'),
    h((req) => studios.removeMember(req.ids.id, req.ids.personId)));

  router.post('/media/studio', h((req) => studios.assign(req.body)));

  // Body-parser failures on these routes (413 from the raw parser) as JSON.
  router.use((err, req, res, next) => {
    if (!/^\/studios(\/|$)/.test(req.path) && req.path !== '/media/studio') return next(err);
    sendError(res, err);
  });

  return router;
}

module.exports = { buildRouter };
