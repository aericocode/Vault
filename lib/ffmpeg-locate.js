/**
 * Where is ffmpeg (and friends)? — next to the exe first, then PATH.
 * The Stash model.
 *
 * External tools have always been spawned by bare name, which works only when
 * the user has put them on PATH. Stash solved the same onboarding problem by
 * also checking beside its own config and offering to download the binaries
 * there — so "download and run" needs no terminal, ever. Vault's equivalent of
 * "beside the config" is ROOT: the repo in dev, the folder next to Vault.exe
 * when packaged, which is already the promise ("everything lives HERE").
 *
 * Resolution order (for the known tools — anything else passes through):
 *   1. ROOT/<tool>.exe — dropped there by the in-app downloader
 *      (server/index.js) or by hand, per the setup banner
 *   2. the bare name, i.e. whatever PATH provides
 *
 * ROOT wins over PATH so the copy Vault fetched is the copy Vault runs — a
 * stale system install can't shadow it. The positive hit is cached (an
 * existsSync per spawn adds up across a scan); finding NOTHING is not cached,
 * so the moment a download drops the binaries in place every later spawn picks
 * them up — no restart, unlike a PATH change, which a running process can
 * never see.
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./approot');

const KNOWN = new Set(['ffmpeg', 'ffprobe', 'fpcalc']);

const _cache = new Map();   // tool name -> absolute path (hits only)

function resolve(cmd) {
  if (!KNOWN.has(cmd)) return cmd;
  const hit = _cache.get(cmd);
  if (hit) return hit;
  const local = path.join(ROOT, process.platform === 'win32' ? `${cmd}.exe` : cmd);
  if (fs.existsSync(local)) {
    _cache.set(cmd, local);
    return local;
  }
  return cmd;               // PATH lookup — never cached, see header
}

/** The downloader replaced the binaries — forget the cached paths. */
function invalidate() {
  _cache.clear();
}

module.exports = { resolve, invalidate };
