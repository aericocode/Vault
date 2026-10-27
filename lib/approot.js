/** Single source of truth for the app's on-disk root.
 *  Dev: the repo root. Packaged (Node SEA exe): the exe's directory —
 *  which is what makes the whole Vault folder portable. */
const path = require('path');
let isSea = false;
try { isSea = require('node:sea').isSea(); } catch {}
// A worker thread started from embedded source (lib/flow/pool.js) is told
// the root by the thread that started it.
let fromParent = null;
try {
  const wt = require('worker_threads');
  if (!wt.isMainThread && wt.workerData && typeof wt.workerData.vaultAppRoot === 'string') fromParent = wt.workerData.vaultAppRoot;
} catch {}
const ROOT = fromParent || (isSea ? path.dirname(process.execPath) : path.join(__dirname, '..'));
module.exports = { ROOT, isSea };
