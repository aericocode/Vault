/**
 * Share privately: the gofile client (spec 6.3). THE ONLY CODE ALLOWED TO
 * TALK TO GOFILE.
 *
 * Every request, before anything else, in this order:
 *   1. the feature switch (lib/share/settings.js) must be on   FEATURE_OFF
 *      (one exception, below)
 *   2. VAULT_OFFLINE must be off                               NET_OFF
 *   3. the URL must be https://api.gofile.io or upload.gofile.io SHARE_HOST
 * and then it goes through lib/net.js netFetch with purpose 'share', which
 * checks 2 and 3 again on the first hop and on every redirect hop.
 *
 * THE ONE EXCEPTION TO 1 (spec section 1, promise 4, owner decision
 * 2026-11-19): deleting an upload Vault already made works with the feature
 * off, because a delete only removes data from gofile. It is tied to the
 * delete call itself, not to a flag: deleteContent() passes a private
 * operation token (a Symbol that never leaves this file) to send(), and
 * FEATURE_OFF_ALLOWED pins that token to exactly DELETE
 * https://api.gofile.io/contents. Every other call, and _request(), passes no
 * token, so with the feature off they are refused before anything is sent.
 * Checks 2 and 3 are never skipped, for the delete either. Which folder is
 * deleted, with which token, is the caller's (lib/share/service.js): only a
 * folder id and account from Vault's own share records.
 *
 * The calls (guest accounts, as documented at https://gofile.io/api; the
 * exact shapes used here are listed in ASSUMED below):
 *   POST   https://api.gofile.io/accounts                    new guest account
 *   POST   https://upload.gofile.io/uploadfile               one part, multipart
 *   PUT    https://api.gofile.io/contents/{id}/update        the auto delete time
 *   DELETE https://api.gofile.io/contents                    delete a share
 * `resettoken` is never called (gofile warns a guest account is then lost).
 *
 * ASSUMED (the API page is rendered by script and could not be read while
 * building; these follow the spec and need the manual end to end run):
 *   - every answer is JSON { status: 'ok' | 'error-...', data: {...} };
 *   - accounts -> data.token (also data.id, data.rootFolder);
 *   - uploadfile takes multipart fields "file" and optional "folderId", with
 *     "Authorization: Bearer <token>", and answers data.id (file id),
 *     data.parentFolder, data.parentFolderCode, data.downloadPage, and
 *     possibly data.md5 / data.size, which are compared when present;
 *   - update takes JSON { attribute: 'expiry', attributeValue: <unix seconds> };
 *   - delete takes JSON { contentsId: '<id>' };
 *   - "too many requests" is HTTP 429 or status 'error-rateLimit';
 *   - a Content-Length upload (not chunked) is accepted.
 *
 * What is sent: the part file's bytes, its file name (the archive name plus
 * .7z or .7z.NNN, which the user was told is visible), the folder id gofile
 * gave, the token gofile gave. Nothing else: no tags, no paths, no password.
 *
 * Tokens: only ever in the Authorization header. Never in a URL, a log line,
 * an error message, or anything returned to the page.
 *
 * Uploads are streamed from disk in 1 MB reads and never held whole in
 * memory; the MD5 is worked out on the way.
 */

const fs = require('fs');
const crypto = require('crypto');
const config = require('../../config');
const { netFetch, isShareUrl } = require('../net');
const shareSettings = require('./settings');

const API = 'https://api.gofile.io';
const UPLOAD = 'https://upload.gofile.io/uploadfile';

const ID_RX = /^[A-Za-z0-9-]{1,64}$/;
const CODE_RX = /^[A-Za-z0-9]{1,32}$/;
const TOKEN_RX = /^[\x21-\x7e]{8,256}$/;   // printable, no spaces: safe in a header
const PART_NAME_RX = /^[A-Za-z0-9 _.\-]{1,100}$/;

function _err(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

// VAULT_OFFLINE blocks every gofile request; the message says what was
// blocked. Keyed by the action a request belongs to.
const NET_OFF_MESSAGES = Object.freeze({
  upload: 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be uploaded.',
  delete: 'Vault is set to stay offline (VAULT_OFFLINE=1), so nothing can be deleted from gofile.',
  timer: 'Vault is set to stay offline (VAULT_OFFLINE=1), so the timer cannot be set on gofile.',
});

/** The NET_OFF message for an action: 'upload' (the default), 'delete' or 'timer'. */
function netOffMessage(action) {
  return NET_OFF_MESSAGES[action] || NET_OFF_MESSAGES.upload;
}

const MESSAGES = {
  FEATURE_OFF: 'Share privately is turned off.',
  NET_OFF: NET_OFF_MESSAGES.upload,
  SHARE_HOST: 'Vault refused to contact a site other than gofile.',
  RATE_LIMIT: 'gofile says too many requests. Vault will wait and try again.',
  GOFILE_ERROR: 'gofile refused the request.',
  NETWORK: 'Could not reach gofile. Check the internet connection.',
  BAD_ANSWER: 'gofile sent an answer Vault did not understand.',
  NOT_FOUND: 'gofile says this upload is no longer there.',
};

/** A safe link to show: the downloadPage when it is a plain gofile.io/d/ link. */
function safeLink(downloadPage, code) {
  try {
    const u = new URL(downloadPage);
    const m = /^\/d\/([A-Za-z0-9]{1,32})$/.exec(u.pathname);
    if (u.protocol === 'https:' && u.hostname === 'gofile.io' && u.port === '' && !u.username && !u.search && !u.hash && m) {
      return `https://gofile.io/d/${m[1]}`;
    }
  } catch { /* fall through */ }
  return CODE_RX.test(code || '') ? `https://gofile.io/d/${code}` : null;
}

/**
 * The multipart body for one part, as an async iterable that reads the file
 * as it is sent. Returns { body, length, contentType, md5 } where md5() gives
 * the hex digest once the body has been read to the end.
 */
function multipartBody({ filePath, fileName, size, folderId, onBytes, signal }) {
  if (!PART_NAME_RX.test(fileName)) throw _err('BAD_NAME', 'The part name cannot be sent.');
  if (folderId != null && !ID_RX.test(folderId)) throw _err('BAD_ANSWER', MESSAGES.BAD_ANSWER);
  const boundary = `----VaultShare${crypto.randomBytes(16).toString('hex')}`;
  let head = '';
  if (folderId != null) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="folderId"\r\n\r\n${folderId}\r\n`;
  }
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n';
  const tail = `\r\n--${boundary}--\r\n`;
  const headBuf = Buffer.from(head, 'utf8');
  const tailBuf = Buffer.from(tail, 'utf8');
  const hash = crypto.createHash('md5');
  let digest = null;
  async function* gen() {
    yield headBuf;
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    let sent = 0;
    try {
      for await (const chunk of stream) {
        if (signal && signal.aborted) throw _err('ABORTED', 'Stopped.');
        sent += chunk.length;
        if (sent > size) throw _err('PART_CHANGED', 'A packed part changed on disk.');
        hash.update(chunk);
        if (onBytes) onBytes(chunk.length);
        yield chunk;
      }
    } finally {
      stream.destroy();
    }
    if (sent !== size) throw _err('PART_CHANGED', 'A packed part changed on disk.');
    digest = hash.digest('hex');
    yield tailBuf;
  }
  return {
    body: gen(),
    length: headBuf.length + size + tailBuf.length,
    contentType: `multipart/form-data; boundary=${boundary}`,
    md5: () => digest,
  };
}

/*
 * Requests allowed while the feature switch is off. The key is a private
 * operation token; only deleteContent() below holds it. Each entry pins the
 * exact method and the exact URL (host and path, no query). Do not add to this
 * list: spec section 1, promise 4 allows deletes only.
 */
const OP_DELETE_CONTENT = Symbol('gofile.deleteContent');
const FEATURE_OFF_ALLOWED = new Map([
  [OP_DELETE_CONTENT, Object.freeze({ method: 'DELETE', url: `${API}/contents` })],
]);

function featureOffAllows(op, method, url) {
  if (typeof op !== 'symbol') return false;
  const rule = FEATURE_OFF_ALLOWED.get(op);
  return !!rule && method === rule.method && url === rule.url;
}

/**
 * Every request goes through here. `op` is only ever passed from inside this
 * file (deleteContent); it lifts check 1 alone, and only for its pinned
 * method and URL.
 */
async function send(client, url, { method, headers = {}, body, signal, duplex, action = 'upload' } = {}, op = null) {
  if (!client._isEnabled() && !featureOffAllows(op, method, url)) throw _err('FEATURE_OFF', MESSAGES.FEATURE_OFF);
  if (client._isOffline()) throw _err('NET_OFF', netOffMessage(action));
  if (!isShareUrl(url)) throw _err('SHARE_HOST', MESSAGES.SHARE_HOST);
  let res;
  try {
    res = await client._fetch(url, { method, headers, body, signal, duplex, purpose: 'share' });
  } catch (err) {
    // fetch may wrap an error thrown by the body stream in .cause.
    const code = (err && err.code) || (err && err.cause && err.cause.code);
    if (code === 'NET_OFF') throw _err(code, netOffMessage(action));
    if (['SHARE_HOST', 'PART_CHANGED', 'ABORTED'].includes(code)) {
      throw _err(code, MESSAGES[code] || (code === 'PART_CHANGED' ? 'A packed part changed on disk.' : 'Stopped.'));
    }
    if (signal && signal.aborted) throw _err('ABORTED', 'Stopped.');
    // The cause is dropped on purpose: it can quote request details.
    throw _err('NETWORK', MESSAGES.NETWORK);
  }
  let json = null;
  try {
    const text = await res.text();
    json = JSON.parse(text.slice(0, 1024 * 1024));
  } catch { json = null; }
  const status = json && typeof json.status === 'string' ? json.status : '';
  if (res.status === 429 || status === 'error-rateLimit') {
    throw _err('RATE_LIMIT', MESSAGES.RATE_LIMIT, { httpStatus: res.status });
  }
  if (status === 'error-notFound' || (res.status === 404 && status !== 'ok')) {
    throw _err('NOT_FOUND', MESSAGES.NOT_FOUND, { httpStatus: res.status });
  }
  // The status field decides, not only the HTTP code (spec 6.3): an error
  // status with HTTP 200 is an error.
  if (status !== 'ok') {
    const gofileStatus = /^error-[A-Za-z]{1,40}$/.test(status) ? status : 'unknown';
    throw _err('GOFILE_ERROR', MESSAGES.GOFILE_ERROR, { httpStatus: res.status, gofileStatus });
  }
  if (!res.ok) throw _err('GOFILE_ERROR', MESSAGES.GOFILE_ERROR, { httpStatus: res.status, gofileStatus: 'ok' });
  return (json.data && typeof json.data === 'object') ? json.data : {};
}

class GofileClient {
  /**
   * @param {object} [o]
   * @param {Function} [o.fetch]      netFetch-compatible (url, opts) => Response.
   *                                  Tests inject a fake; the default is netFetch.
   * @param {Function} [o.isEnabled]  defaults to the feature switch
   * @param {Function} [o.isOffline]  defaults to config.net.offline
   */
  constructor({ fetch, isEnabled, isOffline } = {}) {
    this._fetch = fetch || netFetch;
    this._isEnabled = isEnabled || (() => shareSettings.isEnabled());
    this._isOffline = isOffline || (() => !!(config.net && config.net.offline));
  }

  /**
   * A request with every check, the feature switch included. Takes no
   * operation token: nothing that calls this can skip the switch.
   */
  async _request(url, opts = {}) {
    return send(this, url, opts, null);
  }

  /** New guest account. Returns { token }. `signal` aborts the request. */
  async createAccount({ signal } = {}) {
    const data = await this._request(`${API}/accounts`, { method: 'POST', signal });
    if (typeof data.token !== 'string' || !TOKEN_RX.test(data.token)) throw _err('BAD_ANSWER', MESSAGES.BAD_ANSWER);
    return { token: data.token };
  }

  /**
   * Upload one part. Without folderId gofile makes a new folder.
   * @returns {Promise<{fileId, folderId, code, link, md5}>}
   */
  async uploadPart({ token, filePath, fileName, size, folderId = null, signal, onBytes }) {
    if (!TOKEN_RX.test(token || '')) throw _err('BAD_ANSWER', MESSAGES.BAD_ANSWER);
    const mp = multipartBody({ filePath, fileName, size, folderId, onBytes, signal });
    const data = await this._request(UPLOAD, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': mp.contentType, 'Content-Length': String(mp.length) },
      body: mp.body,
      duplex: 'half',
      signal,
    });
    const fileId = data.id;
    const parent = data.parentFolder;
    const code = data.parentFolderCode;
    if (!ID_RX.test(fileId || '') || !ID_RX.test(parent || '')) throw _err('BAD_ANSWER', MESSAGES.BAD_ANSWER);
    if (folderId != null && parent !== folderId) throw _err('BAD_ANSWER', MESSAGES.BAD_ANSWER);
    const sent = mp.md5();
    if (typeof data.md5 === 'string' && sent && data.md5.toLowerCase() !== sent) {
      throw _err('UPLOAD_MISMATCH', 'gofile received a different file than Vault sent.');
    }
    if (data.size !== undefined && Number(data.size) !== size) {
      throw _err('UPLOAD_MISMATCH', 'gofile received a different file than Vault sent.');
    }
    return {
      fileId,
      folderId: parent,
      code: CODE_RX.test(code || '') ? code : null,
      link: safeLink(data.downloadPage, code),
      md5: sent,
    };
  }

  /** Set the folder's auto delete time (unix seconds). `signal` aborts the request. */
  async setExpiry({ token, folderId, expiresAtSec, signal }) {
    if (!TOKEN_RX.test(token || '') || !ID_RX.test(folderId || '')) throw _err('BAD_ANSWER', MESSAGES.BAD_ANSWER);
    await this._request(`${API}/contents/${encodeURIComponent(folderId)}/update`, {
      action: 'timer',
      method: 'PUT',
      signal,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attribute: 'expiry', attributeValue: Math.trunc(expiresAtSec) }),
    });
  }

  /**
   * Delete a share's folder (and so every part in it). The one call that
   * works with the feature off (see the top of this file); VAULT_OFFLINE and
   * the host list still apply. One folder id per call: ID_RX allows no comma,
   * so a list of ids cannot be slipped in.
   */
  async deleteContent({ token, folderId }) {
    if (!TOKEN_RX.test(token || '') || !ID_RX.test(folderId || '')) throw _err('BAD_ANSWER', MESSAGES.BAD_ANSWER);
    await send(this, `${API}/contents`, {
      action: 'delete',
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentsId: folderId }),
    }, OP_DELETE_CONTENT);
  }
}

/**
 * Tests only: would the delete call's feature-off allowance accept this
 * method and URL? A yes/no answer; it cannot send anything and does not hand
 * out the operation token.
 */
function _featureOffAllowsDeleteForTest(method, url) {
  return featureOffAllows(OP_DELETE_CONTENT, method, url);
}

module.exports = { GofileClient, multipartBody, safeLink, MESSAGES, netOffMessage, ID_RX, CODE_RX, TOKEN_RX, _featureOffAllowsDeleteForTest };
