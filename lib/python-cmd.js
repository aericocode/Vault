/**
 * Which Python runs the sidecars (transcription, translation, diarization).
 *
 *   1. PYTHON_PATH, when set: the user said which one.
 *   2. Windows: `python`, as always (the python.org installer and winget put
 *      it on PATH).
 *   3. Elsewhere: a venv next to Vault (venv/bin/python), then python3, then
 *      python off PATH. Most Linux distros ship only `python3`; a bare
 *      `python` there is often not installed at all.
 *
 * Windows deliberately does not look for a venv next to Vault: a source
 * checkout may hold an old venv whose interpreter is gone, and picking it up
 * would quietly break transcription that works today.
 */

const fs = require('fs');
const path = require('path');

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/**
 * @param {object} [o]  env / platform / root / exists (tests)
 * @returns {string} a command name or an absolute path
 */
function pythonCommand({ env = process.env, platform = process.platform, root = null, exists = isFile } = {}) {
  if (env.PYTHON_PATH) return env.PYTHON_PATH;
  if (platform === 'win32') return 'python';
  const P = path.posix;
  const base = root || require('./approot').ROOT;
  const venv = P.join(base, 'venv', 'bin', 'python');
  if (exists(venv)) return venv;
  const dirs = String(env.PATH || '').split(P.delimiter).filter(Boolean);
  for (const name of ['python3', 'python']) {
    if (dirs.some(dir => exists(P.join(dir, name)))) return name;
  }
  return 'python3';
}

module.exports = { pythonCommand };
