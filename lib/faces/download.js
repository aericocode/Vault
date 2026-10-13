/**
 * Face model downloads (FACES_BUILD_SPEC section 7, POST /api/faces/models/download).
 *
 * Takes registry entries [{ key, url, sha256, size, dest }] and fetches the
 * ones whose dest is missing. Every byte goes through lib/net.js (purpose
 * 'model'), so VAULT_OFFLINE / SUB_ALLOW_DOWNLOADS=0 block it there as well as
 * in preflight(). Each key needs its own consent (lib/model-consent.js);
 * without it nothing is fetched and the error is CONSENT_NEEDED with .keys.
 *
 * Files are written to "<dest>.part-<pid>-<rand>", sha256-checked (required:
 * an entry without a hash is refused), then renamed into place. A failed or
 * aborted download leaves nothing behind.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { netFetch, isLoopback } = require('../net');

function _err(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

// Missing = absent, or (when the entry has a size) the wrong size, e.g. a
// truncated copy dropped in by hand. Same test as models.resolveFaceModelPaths.
function presentOk(e) {
  try {
    const st = fs.statSync(e.dest);
    return st.isFile() && (!e.size || st.size === Number(e.size));
  } catch { return false; }
}
const missingOf = (entries) => entries.filter(e => !presentOk(e));

/**
 * Throws the error a download would hit before any byte moves: DOWNLOADS_OFF,
 * CONSENT_NEEDED (with .keys), NET_OFF, or BAD_ENTRY. Returns the entries
 * still to fetch.
 */
function preflight(entries, { consent = require('../model-consent') } = {}) {
  const todo = missingOf(entries);
  if (!todo.length) return todo;
  if (config.net?.offline && todo.some(e => !isLoopback(e.url))) {
    throw _err('NET_OFF', 'Network is off (VAULT_OFFLINE=1), so the models cannot be downloaded.');
  }
  if (consent.ENV_ALLOWS === false || config.subtitles?.allowModelDownload === false) {
    throw _err('DOWNLOADS_OFF', 'Model downloads are turned off on this computer (SUB_ALLOW_DOWNLOADS=0 or VAULT_OFFLINE=1).');
  }
  const keys = [...new Set(todo.map(e => e.key))].filter(k => !consent.isAllowed(k));
  if (keys.length) throw _err('CONSENT_NEEDED', 'Downloading these models needs your permission first.', { keys });
  for (const e of todo) {
    if (!e.url || !e.dest || !/^[0-9a-f]{64}$/i.test(String(e.sha256 || ''))) {
      throw _err('BAD_ENTRY', `model entry ${e.key} needs url, dest and a sha256`);
    }
  }
  return todo;
}

/**
 * Download every missing entry, one after another.
 * @param {object} opts
 * @param {(p:{received:number,total:number,key:string})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.consent]   lib/model-consent.js (injectable)
 * @param {Function} [opts.fetchImpl] netFetch (injectable for tests)
 * @returns {Promise<{downloaded:string[]}>}
 */
async function downloadModels(entries, { onProgress, signal, consent, fetchImpl = netFetch } = {}) {
  const todo = preflight(entries, consent ? { consent } : {});
  const total = todo.reduce((s, e) => s + (Number(e.size) || 0), 0);
  let received = 0;
  const downloaded = [];
  for (const e of todo) {
    if (signal?.aborted) throw _err('ABORTED', 'download cancelled');
    await fetchOne(e, {
      signal, fetchImpl,
      onBytes: (n) => { received += n; onProgress?.({ received, total, key: e.key }); },
    });
    downloaded.push(e.key);
  }
  return { downloaded };
}

async function fetchOne(e, { signal, fetchImpl, onBytes }) {
  const res = await fetchImpl(e.url, { purpose: 'model', signal });
  if (!res.ok || !res.body) throw _err('DOWNLOAD_FAILED', `download of ${e.key} failed (HTTP ${res.status})`);
  fs.mkdirSync(path.dirname(e.dest), { recursive: true });
  const tmp = `${e.dest}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const hash = crypto.createHash('sha256');
  let n = 0;
  const fd = fs.openSync(tmp, 'w');
  try {
    for await (const chunk of res.body) {
      if (signal?.aborted) throw _err('ABORTED', 'download cancelled');
      const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      hash.update(buf);
      fs.writeSync(fd, buf);
      n += buf.length;
      onBytes(buf.length);
    }
    fs.closeSync(fd);
    if (e.size && n !== Number(e.size)) {
      throw _err('SIZE_MISMATCH', `download of ${e.key} has the wrong size (${n} bytes, expected ${e.size})`);
    }
    const got = hash.digest('hex');
    if (got !== String(e.sha256).toLowerCase()) {
      throw _err('CHECKSUM_MISMATCH', `download of ${e.key} failed its checksum`);
    }
    fs.renameSync(tmp, e.dest);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

/**
 * A model store over registry entries: ready when every dest exists with its
 * registered size. Computed on every call, so a finished download flips it to
 * ready without a restart.
 * status() -> { ready, missing: [keys], paths: { key: dest } }
 */
function createFileModelStore(entriesFn) {
  return {
    entries: () => entriesFn(),
    status() {
      const entries = entriesFn();
      const missing = [...new Set(missingOf(entries).map(e => e.key))];
      const paths = {};
      for (const e of entries) paths[e.key] = e.dest;
      return { ready: entries.length > 0 && missing.length === 0, missing, paths };
    },
  };
}

module.exports = { preflight, downloadModels, createFileModelStore, missingOf };
