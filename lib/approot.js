/** Single source of truth for the app's on-disk root.
 *  Dev: the repo root. Packaged (Node SEA exe): the exe's directory —
 *  which is what makes the whole Vault folder portable. */
const path = require('path');
let isSea = false;
try { isSea = require('node:sea').isSea(); } catch {}
const ROOT = isSea ? path.dirname(process.execPath) : path.join(__dirname, '..');
module.exports = { ROOT, isSea };
