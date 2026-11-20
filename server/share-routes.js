/**
 * Share privately routes (/api/share/*). The contract the page is built
 * against is written out in .notes/SHARE_PRIVATELY_ROUTES.md.
 *
 * PROTECTION. These sit behind everything the rest of the local server has
 * (server/index.js): the Host allowlist (DNS rebinding), the Fetch Metadata
 * gate, the cross-origin Origin check on writes and the vault lock gate (423
 * while locked). Because a route here can send the user's files off the
 * computer, they add three stricter rules of their own:
 *   1. Sec-Fetch-Site, when the browser sends it, must be "same-origin". The
 *      app-wide gate also lets "none" through (a typed address or bookmark);
 *      nothing here is ever opened that way.
 *   2. Every request that is not GET must carry "X-Vault-Share: 1" and
 *      "Content-Type: application/json". A web page on another site cannot
 *      send a custom header or a JSON body to this server without a CORS
 *      preflight, which this server never answers, so a form post, an image
 *      tag or a "simple" fetch from another site cannot reach a share action
 *      even in a browser that sends no Origin or Sec-Fetch-Site.
 *   3. Everything that returns a password is a POST with the Vault password in
 *      the JSON body, never in a URL.
 * A program running on the same computer under the same user can still call
 * these routes, as it can every other Vault route; that is outside what a
 * local web server can prevent (see the build report).
 *
 * SECRETS. No response here carries a gofile token or a folder id. Passwords
 * only come back from the gated routes: /shares/:id/password,
 * /shares/:id/copy-block, /saved-password/reveal and /saved-password/change.
 * Error messages are fixed plain-language strings, never built from a
 * password or token.
 */

const express = require('express');
const service = require('../lib/share/service');
const vault = require('../lib/vault');

const LOCKED = Object.freeze({ code: 'VAULT_LOCKED', message: 'The library was locked, so Vault stopped. Unlock it and look at this share again.' });

const STATUS = {
  BAD_INPUT: 400, BAD_NAME: 400, BAD_PASSWORD: 400, BAD_PART_SIZE: 400, CONFIRM_NEEDED: 400,
  GATE_NEEDED: 401, GATE_WRONG: 401,
  SHARE_FORBIDDEN: 403,
  NOT_FOUND: 404, MEDIA_NOT_FOUND: 404, NO_PASSWORD: 404, NO_LINK: 404, NO_SAVED_PASSWORD: 409,
  FEATURE_OFF: 409, NET_OFF: 409, WRONG_STATE: 409, NOT_CHECKED: 409, PACK_BUSY: 409,
  PARTS_CHANGED: 409, PARTS_MISSING: 409, STILL_ONLINE: 409, WARNING_NEEDED: 409, NO_ACCOUNT: 409,
  FILE_MISSING: 409, SEVENZIP_MISSING: 409, TEMP_NOT_OWNED: 409,
  NO_SPACE: 507,
  VAULT_LOCKED: 423,
  GATE_LOCKED: 429,
  RATE_LIMIT: 503, NETWORK: 502, GOFILE_ERROR: 502, BAD_ANSWER: 502, SHARE_HOST: 502, UPLOAD_MISMATCH: 502,
};

/** Only these extra fields of an error may reach the page. */
const SAFE_EXTRA = ['missingBytes', 'needBytes', 'attemptsLeft', 'retryAfterMs', 'mediaId', 'gofileStatus'];

function sendError(res, err) {
  // A request that came in before a lock and ran into it (the database
  // closing under it, say) answers the lock, never "Something went wrong".
  if (vault.isLocked() && !(err && err.code && STATUS[err.code])) err = LOCKED;
  const code = err && err.code && STATUS[err.code] ? err.code : 'ERROR';
  const body = { error: code === 'ERROR' ? 'Something went wrong.' : err.message, code };
  for (const k of SAFE_EXTRA) if (err && err[k] !== undefined) body[k] = err[k];
  if (code === 'ERROR') console.warn(`[Share] unexpected error (${err && err.name ? err.name : 'error'})`);
  res.status(STATUS[code] || 500).json(body);
}

/** Wrap a handler: errors become { error, code } with the right status. */
const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out);
  } catch (err) {
    sendError(res, err);
  }
};

function shareGuard(req, res, next) {
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (site && site !== 'same-origin') {
    return res.status(403).json({ error: 'This request is only allowed from Vault itself.', code: 'SHARE_FORBIDDEN' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (req.get('X-Vault-Share') !== '1' || !type.startsWith('application/json')) {
      return res.status(403).json({ error: 'This request is only allowed from Vault itself.', code: 'SHARE_FORBIDDEN' });
    }
  }
  // Answers here can hold passwords: never cached.
  res.set('Cache-Control', 'no-store');
  next();
}

/**
 * A body that is not valid JSON (or too big) answers a plain 400 here, before
 * Express's default handler, which would log the parser's message, and that
 * message can quote part of the body (a password, for one).
 */
function bodyErrorHandler(err, req, res, next) {
  if (!err) return next();
  res.status(err.status === 413 ? 413 : 400).json({ error: 'The request was not valid.', code: 'BAD_INPUT' });
}

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function buildRouter() {
  const r = express.Router();
  r.use(shareGuard);

  // Feature state, settings, top bar.
  r.get('/state', h(() => service.state()));
  r.post('/settings', h((req) => {
    const b = body(req);
    const { confirm, ...patch } = b;
    return service.updateSettings(patch, { confirm });
  }));
  r.post('/settings/reset', h((req) => {
    if (body(req).confirm !== true) throw Object.assign(new Error('Confirm that every choice goes back to its default.'), { code: 'CONFIRM_NEEDED' });
    return { settings: require('../lib/share/settings').reset() };
  }));
  r.post('/copy-format/preview', h((req) => service.previewFormat(body(req).format)));

  // Step 1.
  r.post('/preview', h((req) => service.preview({ mediaIds: body(req).mediaIds })));
  // "Check files for personal details": start, then ask where it is. The
  // answer holds what was found (in memory only on the server, never cached).
  r.post('/meta-check', h((req) => service.metaCheck({ mediaIds: body(req).mediaIds })));
  r.get('/meta-check/:id', h((req) => service.metaCheckStatus(req.params.id)));
  r.post('/shares', h((req, res) => {
    const b = body(req);
    const share = service.start({
      mediaIds: b.mediaIds, name: b.name, passwordChoice: b.passwordChoice, deleteAfterDays: b.deleteAfterDays,
      acknowledgeNoVaultPassword: b.acknowledgeNoVaultPassword,
      // The step 1 tick box for "Upload on its own"; only exactly true counts (service.js).
      confirmUpload: b.confirmUpload,
      // Personal details: only the choice. Which files are cleaned is the
      // server's own check at the pack's turn; no file list is read here.
      removePersonal: b.removePersonal,
    });
    res.status(202).json({ share });
  }));

  // Shares.
  r.get('/shares', h(() => ({ shares: service.listShares() })));
  r.get('/shares/:id', h((req) => ({ share: service.getShare(req.params.id) })));
  r.get('/shares/:id/progress', h((req) => service.progress(req.params.id)));
  r.post('/shares/:id/cancel', h((req) => service.cancel(req.params.id)));
  r.post('/shares/:id/upload', h((req) => service.confirmUpload(req.params.id, { confirm: body(req).confirm })));
  r.post('/shares/:id/pause', h((req) => service.pause(req.params.id)));
  r.post('/shares/:id/resume', h((req) => service.resume(req.params.id)));
  r.post('/shares/:id/parts/:n/retry', h((req) => service.retryPart(req.params.id, req.params.n)));
  r.post('/shares/:id/stop', h((req) => service.stop(req.params.id, { confirm: body(req).confirm }).then(share => ({ share }))));
  r.post('/shares/:id/password', h((req) => service.revealPassword(req.params.id, { vaultPassword: body(req).vaultPassword })));
  r.post('/shares/:id/copy-block', h((req) => {
    const b = body(req);
    return service.copyBlock(req.params.id, { vaultPassword: b.vaultPassword, format: b.format });
  }));
  // Delete, Delete all and Stop work with the feature off (spec section 1,
  // promise 4). What they delete on gofile is only ever the folder stored on
  // the share row picked by :id (or every stored row, for delete-all): no
  // folder id or token is read from the body.
  r.post('/shares/:id/mark-gone', h((req) => service.markGone(req.params.id).then(share => ({ share }))));
  r.post('/shares/:id/remove', h((req) => service.remove(req.params.id, { confirm: body(req).confirm })));
  r.post('/shares/:id/delete-remote', h((req) => service.deleteRemote(req.params.id).then(share => ({ share }))));
  r.post('/shares/:id/retry-timer', h((req) => service.retryTimer(req.params.id).then(share => ({ share }))));
  r.post('/delete-all', h((req) => service.deleteAll({ confirm: body(req).confirm })));

  // Saved default password.
  r.get('/saved-password', h(() => service.savedPasswordStatus()));
  r.post('/saved-password/reveal', h((req) => service.revealSavedPassword({ vaultPassword: body(req).vaultPassword })));
  r.post('/saved-password/change', h((req) => {
    const b = body(req);
    return service.changeSavedPassword({
      vaultPassword: b.vaultPassword, password: b.password, random: b.random, clear: b.clear,
      acknowledgeNoVaultPassword: b.acknowledgeNoVaultPassword,
    });
  }));

  // Anything else under /api/share: a plain 404 in the same shape.
  r.use((req, res) => res.status(404).json({ error: 'Not found.', code: 'NOT_FOUND' }));
  return r;
}

module.exports = { buildRouter, shareGuard, bodyErrorHandler, STATUS };
