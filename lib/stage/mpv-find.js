/**
 * Finding mpv for Stage (PLAYLISTS_SPEC "Stage host, final").
 *
 * Stage plays in the user's own mpv. Vault runs that program, so what it runs
 * is checked hard:
 *
 *   - where the path comes from: only the native file picker (the server
 *     opens it, POST /api/stage/mpv/choose; no page can send a path), one of
 *     the usual install folders, or an absolute folder on PATH;
 *   - the file: an absolute local path (no \\server\share or \\?\ device
 *     path), named mpv.exe (mpv on Linux), a regular file that exists, and
 *     its real path (symlinks followed) is named the same;
 *   - then, and only then, `mpv --version` must say it is mpv.
 *
 * All of it again on every launch (find() is called for each open; only the
 * --version answer is remembered, keyed by the file's real path, size and
 * modification time, so a changed file is asked again).
 *
 * The functions take their file system and process runner as arguments so the
 * tests can drive them without a real mpv.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const VERSION_TIMEOUT_MS = 8000;

/** The usual install folders, first match wins (the order the user's machine has it). */
function defaultLocations(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const out = [
      'C:\\Program Files\\MPV Player\\mpv.exe',
      'C:\\Program Files\\mpv\\mpv.exe',
      'C:\\Program Files (x86)\\mpv\\mpv.exe',
    ];
    // The same folders where Windows is not on C: (absolute values only).
    for (const k of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
      const base = env[k];
      if (typeof base !== 'string' || !/^[A-Za-z]:\\/.test(base)) continue;
      for (const sub of k === 'ProgramFiles(x86)' ? ['mpv'] : ['MPV Player', 'mpv']) {
        const p = path.win32.join(base, sub, 'mpv.exe');
        if (!out.some(o => o.toLowerCase() === p.toLowerCase())) out.push(p);
      }
    }
    return out;
  }
  return ['/usr/bin/mpv', '/usr/local/bin/mpv', '/snap/bin/mpv'];
}

const exeName = (platform = process.platform) => (platform === 'win32' ? 'mpv.exe' : 'mpv');

/**
 * Is this string a path Vault may run as mpv? Checks the text and the file.
 * @returns {{ok: true, path: string, real: string, stat: object} | {ok: false, error: string}}
 */
function checkPath(p, { platform = process.platform, fsx = fs } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (typeof p !== 'string' || !p || p.length > 4096) return { ok: false, error: 'No path.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return { ok: false, error: 'The path has control characters.' };
  if (!P.isAbsolute(p)) return { ok: false, error: 'The path must be a full path.' };
  if (platform === 'win32') {
    // A drive letter only: never a network share (\\server\share) or a device path (\\?\, \\.\).
    if (!/^[A-Za-z]:\\/.test(p.replace(/\//g, '\\'))) return { ok: false, error: 'mpv must be on a drive of this computer.' };
  }
  const name = P.basename(p);
  const want = exeName(platform);
  const sameName = (n) => (platform === 'win32' ? n.toLowerCase() === want : n === want);
  if (!sameName(name)) return { ok: false, error: `The program must be named ${want}.` };
  let st;
  try { st = fsx.statSync(p); } catch { return { ok: false, error: 'That file does not exist.' }; }
  if (!st.isFile()) return { ok: false, error: 'That is not a file.' };
  let real = p;
  try { real = platform === 'win32' && fsx.realpathSync.native ? fsx.realpathSync.native(p) : fsx.realpathSync(p); } catch { return { ok: false, error: 'That file cannot be read.' }; }
  if (!sameName(P.basename(real))) return { ok: false, error: `The program must be named ${want}.` };
  if (platform === 'win32' && !/^[A-Za-z]:\\/.test(real)) return { ok: false, error: 'mpv must be on a drive of this computer.' };
  if (platform !== 'win32') {
    try { fsx.accessSync(real, fs.constants.X_OK); } catch { return { ok: false, error: 'That file cannot be run.' }; }
  }
  let rst = st;
  try { rst = fsx.statSync(real); } catch {}
  return { ok: true, path: p, real, stat: rst };
}

/** The first line of `mpv --version`, if it is mpv's: { version } or null. */
function parseVersion(out) {
  const first = String(out || '').split(/\r?\n/).find(l => l.trim()) || '';
  const m = /^mpv\s+(v?\d+\.\d+[\w.+~-]*|[0-9a-f]{7,}[\w.+~-]*)/i.exec(first.trim());
  return m ? { version: m[1] } : null;
}

const _versions = new Map();    // "real|size|mtime" -> { version } | null

/**
 * Ask the file whether it is mpv (`--no-config --version`, no shell, a short
 * timeout). Only ever called on a path checkPath() accepted.
 */
function askVersion(real, stat, { run = execFile } = {}) {
  const key = `${real}|${stat && stat.size}|${stat && stat.mtimeMs}`;
  if (_versions.has(key)) return Promise.resolve(_versions.get(key));
  return new Promise((resolve) => {
    run(real, ['--no-config', '--version'], { windowsHide: true, timeout: VERSION_TIMEOUT_MS, maxBuffer: 256 * 1024, shell: false }, (err, stdout) => {
      const v = parseVersion(stdout);
      // A version answer counts even with a non-zero exit (some builds exit 1 after --version).
      const result = v || null;
      // A run that timed out (a slow disk, antivirus) is asked again next time.
      if (result || !(err && err.killed)) _versions.set(key, result);
      if (_versions.size > 32) _versions.delete(_versions.keys().next().value);
      resolve(result);
    });
  });
}

/** Absolute folders on PATH that hold mpv, in order. */
function pathCandidates({ platform = process.platform, env = process.env } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const raw = env.PATH || env.Path || '';
  const out = [];
  for (let entry of String(raw).split(platform === 'win32' ? ';' : ':')) {
    entry = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!entry || !P.isAbsolute(entry)) continue;          // never ".", never a relative folder
    if (platform === 'win32' && !/^[A-Za-z]:\\/.test(entry.replace(/\//g, '\\'))) continue;
    out.push(P.join(entry, exeName(platform)));
  }
  return out;
}

/**
 * Where mpv is, checked from scratch.
 * @param {object} o
 * @param {string|null} o.chosen  the path the user picked (Settings › Stage), or null
 * @returns {Promise<{found: true, path: string, version: string, source: 'chosen'|'default'|'path', chosenProblem?: string}
 *                  | {found: false, chosenProblem?: string}>}
 */
async function findMpv({ chosen = null, platform = process.platform, env = process.env, fsx = fs, run = execFile } = {}) {
  let chosenProblem;
  const tryOne = async (p) => {
    const c = checkPath(p, { platform, fsx });
    if (!c.ok) return { ok: false, error: c.error };
    const v = await askVersion(c.real, c.stat, { run });
    if (!v) return { ok: false, error: 'That program did not answer as mpv.' };
    return { ok: true, path: c.real, version: v.version };
  };
  if (chosen) {
    const r = await tryOne(chosen);
    if (r.ok) return { found: true, path: r.path, version: r.version, source: 'chosen' };
    chosenProblem = r.error;
  }
  for (const p of defaultLocations(platform, env)) {
    const r = await tryOne(p);
    if (r.ok) return { found: true, path: r.path, version: r.version, source: 'default', ...(chosenProblem ? { chosenProblem } : {}) };
  }
  for (const p of pathCandidates({ platform, env })) {
    const r = await tryOne(p);
    if (r.ok) return { found: true, path: r.path, version: r.version, source: 'path', ...(chosenProblem ? { chosenProblem } : {}) };
  }
  return { found: false, ...(chosenProblem ? { chosenProblem } : {}) };
}

function _clearVersionCache() { _versions.clear(); }

module.exports = { defaultLocations, exeName, checkPath, parseVersion, askVersion, pathCandidates, findMpv, _clearVersionCache, VERSION_TIMEOUT_MS };
