/**
 * Share privately: the 7-Zip program, found and run.
 *
 * FINDING IT:
 *   1. VAULT_7ZIP, an absolute path to the program. For tests and for a
 *      developer who has 7-Zip installed somewhere else. Must be an existing
 *      file; a relative or missing path is ignored (never resolved against the
 *      current folder). An explicit choice, so it is not hash checked.
 *   2. The copy SHIPPED with Vault (7-Zip 26.06, vendor/7zip/README.md):
 *        built app:        ROOT/7-Zip/7za.exe (Windows), ROOT/7-Zip/7zzs (Linux)
 *        source checkout:  ROOT/vendor/7zip/win-x64/7za.exe, .../linux-x64/7zzs
 *      tools/sea/build-app.js copies vendor/7zip/<platform>/ to 7-Zip/.
 *      Its SHA-256 must be the one in SHIPPED below (the same value as
 *      vendor/7zip/SHA256SUMS; the build and test/share-vendor.test.js check
 *      that). It is checked BEFORE the program is first run, and again
 *      whenever the file's size or time changes; a copy that does not match
 *      is never run. In the built app the value is inside the program itself,
 *      so swapping the 7-Zip file alone is caught.
 *   THE BUILT APP STOPS HERE: it uses only 1 or 2, never a copy found
 *   anywhere else, so a program dropped into a folder on PATH is never run.
 *   A source checkout goes on:
 *   3. ROOT/<name>, a copy put next to Vault by hand. Windows: 7za.exe,
 *      7zz.exe, 7z.exe. Linux and others: 7zz, 7zzs ONLY. The names 7z, 7za
 *      and 7zr there usually mean the old p7zip 16.02, whose stdin password
 *      handling has not been proven, so they are never used.
 *   4. Windows only: 7-Zip installed in its usual folder (Program Files\7-Zip,
 *      which the installer does not add to PATH).
 *   5. Each ABSOLUTE folder on PATH, same names as 3. Relative PATH entries
 *      are skipped, and the result is always an absolute path: spawning a bare
 *      name lets Windows look in the current folder first.
 * On Linux a file without the run permission is passed over. A hit is cached;
 * a miss is not, so a copy dropped in later is picked up.
 *
 * WHEN: lib/share/service.js looks only once the feature is on (the state
 * answer with the feature off runs nothing).
 *
 * VERSION FLOOR: whatever is found (VAULT_7ZIP included) is run once with no
 * arguments and its banner ("7-Zip (a) 26.06 (x64) : ...") is read. A program
 * older than MIN_VERSION, or one whose banner cannot be read, is passed over
 * as if it were not there, so the page shows "7-Zip not found". The floor is
 * the lowest version the stdin password behaviour below was proven on; it is
 * not lowered on the strength of release notes alone. The answer is cached
 * per path and checked again when the file's size or time changes.
 *
 * THE PASSWORD NEVER GOES ON A COMMAND LINE. Other programs on the computer
 * can read any process's command line. 7-Zip asks for the password on its
 * standard input when the switch is given without a value (`-p` for adding)
 * or left out (testing and listing ask by themselves when an archive needs
 * one). Proven with 7-Zip 26.01 x64 (7z.exe) and the shipped 26.06 7za.exe on
 * Windows 11, and the shipped 26.06 7zzs (and 7zz) on Ubuntu 24.04 (see
 * test/share-pack.test.js, which runs on the shipped copy by default):
 *   - `a ... -p` with stdin not a console prompts ONCE ("Enter password (will
 *     not be echoed)" on Windows, "Enter password:" on Linux), reads one line
 *     from the pipe, does not echo it and does not ask to verify it.
 *   - The line ends at LF; a CR before it is dropped. Leading and trailing
 *     spaces are kept exactly. A password containing CR or LF would be cut
 *     there, so such passwords are refused before 7-Zip is started.
 *   - Without -sccUTF-8, non-ASCII characters are converted through the
 *     console code page and the archive gets a DIFFERENT password from the
 *     one shown to the user. With -sccUTF-8 the UTF-8 bytes written here are
 *     the password. -sccUTF-8 is therefore always passed (and Vault's own
 *     random passwords are ASCII anyway). On Linux the result is the same
 *     under any locale (C, POSIX, C.UTF-8, none).
 *   - When stdin is closed and 7-Zip still wants a password it prints "Break
 *     signaled" and exits 255: it fails, it never goes on without one.
 * runSevenZip() also refuses outright if any argument contains the password.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ROOT, isSea } = require('../approot');

// Names looked for next to Vault and on PATH (see header, step 3).
const NAMES = ['7za', '7zz', '7z'];               // Windows, with ".exe"
const NAMES_POSIX = ['7zz', '7zzs'];              // Linux and others: never 7z, 7za, 7zr
// Lowest 7-Zip version accepted: the lowest one the stdin password, -sccUTF-8
// and "Break signaled" behaviour was proven on (26.01 on Windows; 26.06 on
// Linux and Windows). [major, minor].
const MIN_VERSION = [26, 1];
let _cache = null;
const _versions = new Map();   // path -> { sig, ok, version, reason }
const _warned = new Set();

// The program shipped with Vault, per platform: the folder under vendor/7zip/
// in the repo and the file name. The build copies that folder's program and
// License.txt to SHIPPED_APP_DIR next to the Vault program.
// sha256: of that file, as in vendor/7zip/SHA256SUMS (see header, step 2).
const SHIPPED = {
  'win32-x64': { vendorDir: 'win-x64', file: '7za.exe', sha256: 'dd3757f31c97e33776f2590317d4fb12f2da075db3dbb1e3f94d0f2a01d84ffa' },
  'linux-x64': { vendorDir: 'linux-x64', file: '7zzs', sha256: '0b58a64e71ebdf53751cd954cad1cc552c6a11ef51336bee6acafbdc54c28c1f' },
};
let _packaged = isSea;          // tests may act as the built app
let _root = ROOT;               // tests may use another app folder
const _hashes = new Map();      // path -> { sig, sha256 }
const SHIPPED_APP_DIR = '7-Zip';

function _isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** An existing file this process may run (on Linux: with the run permission). */
function _isRunnable(p) {
  if (!_isFile(p)) return false;
  if (process.platform === 'win32') return true;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

/** The program names looked for next to Vault and on PATH, per platform. */
function candidateNames(platform = process.platform) {
  return platform === 'win32' ? NAMES.map(n => n + '.exe') : [...NAMES_POSIX];
}

/**
 * The version in 7-Zip's banner, as [major, minor], or null. Matches the
 * first line that starts with "7-Zip", e.g. "7-Zip (a) 26.06 (x64) : ...",
 * "7-Zip 26.01 (x64) : ...", "7-Zip [64] 16.02 : ..." (p7zip).
 */
function parseVersion(banner) {
  const m = /^[ \t]*7-Zip(?:[ \t]+\[[^\]\r\n]*\])?(?:[ \t]+\([A-Za-z]\))?[ \t]+(\d{1,3})\.(\d{1,3})(?=[ \t]|\r?$)/m.exec(String(banner || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** True when version [major, minor] is at least MIN_VERSION. */
function versionAccepted(v) {
  if (!Array.isArray(v)) return false;
  if (v[0] !== MIN_VERSION[0]) return v[0] > MIN_VERSION[0];
  return v[1] >= MIN_VERSION[1];
}

function _fmt(v) { return `${v[0]}.${String(v[1]).padStart(2, '0')}`; }

/**
 * Run the program once with no arguments and check its version (see header).
 * Cached per path; checked again when the file changes.
 * @returns {{ok:boolean, version:string|null, reason:string|null}}
 */
function checkVersion(p) {
  let sig;
  try { const st = fs.statSync(p); sig = `${st.size}:${st.mtimeMs}`; }
  catch { return { ok: false, version: null, reason: 'The 7-Zip program is missing.' }; }
  const hit = _versions.get(p);
  if (hit && hit.sig === sig) return { ok: hit.ok, version: hit.version, reason: hit.reason };
  let out = '';
  let ran = false;
  try {
    // 7-Zip prints its banner and help at once; a program that hangs is
    // stopped, refused and (being cached) never waited on again.
    const r = spawnSync(p, [], { windowsHide: true, shell: false, timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1024 * 1024 });
    ran = !r.error && r.status === 0;
    out = String(r.stdout || '');
  } catch { ran = false; }
  const v = ran ? parseVersion(out) : null;
  const want = _fmt(MIN_VERSION);
  let res;
  if (!ran) res = { ok: false, version: null, reason: 'The 7-Zip program did not start.' };
  else if (!v) res = { ok: false, version: null, reason: 'The 7-Zip program did not say its version.' };
  else if (!versionAccepted(v)) res = { ok: false, version: _fmt(v), reason: `The 7-Zip program is version ${_fmt(v)}. Vault needs ${want} or newer.` };
  else res = { ok: true, version: _fmt(v), reason: null };
  _versions.set(p, { sig, ...res });
  if (!res.ok && !_warned.has(p)) {
    _warned.add(p);
    console.warn(`[share] Not using 7-Zip at ${p}: ${res.reason}`);
  }
  return res;
}

/** A runnable program of a version Vault accepts. */
function _usable(p) {
  return _isRunnable(p) && checkVersion(p).ok;
}

/** SHA-256 of a file, cached per path until its size or time changes. */
function _sha256(p) {
  let sig;
  try { const st = fs.statSync(p); sig = `${st.size}:${st.mtimeMs}`; } catch { return null; }
  const hit = _hashes.get(p);
  if (hit && hit.sig === sig) return hit.sha256;
  let sha256 = null;
  try { sha256 = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { sha256 = null; }
  _hashes.set(p, { sig, sha256 });
  return sha256;
}

/**
 * The shipped copy at `p`: runnable, the exact file Vault was built with
 * (checked before it is ever run), and of a version Vault accepts.
 */
function _usableShipped(p) {
  const s = shippedFor();
  if (!s || !_isRunnable(p)) return false;
  if (_sha256(p) !== s.sha256) {
    if (!_warned.has(`hash:${p}`)) {
      _warned.add(`hash:${p}`);
      console.warn(`[share] Not using 7-Zip at ${p}: it is not the copy Vault was built with.`);
    }
    return false;
  }
  return checkVersion(p).ok;
}

/** The shipped program for this platform, or null when none is shipped for it. */
function shippedFor(platform = process.platform, arch = process.arch) {
  return SHIPPED[`${platform}-${arch}`] || null;
}

/**
 * Where the shipped program sits: in the built app, then in a source
 * checkout. The built app never looks for a vendor/ folder.
 */
function _shippedPaths(root = _root) {
  const s = shippedFor();
  if (!s) return [];
  const appCopy = path.join(root, SHIPPED_APP_DIR, s.file);
  if (_packaged) return [appCopy];
  return [appCopy, path.join(root, 'vendor', '7zip', s.vendorDir, s.file)];
}

/** 7-Zip's own install folders on Windows (absolute environment values only). */
function _windowsInstallPaths() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const v of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const dir = process.env[v];
    if (dir && path.isAbsolute(dir)) out.push(path.join(dir, '7-Zip', '7z.exe'));
  }
  return out;
}

/** Absolute path of the 7-Zip program, or null when there is none. */
function locate() {
  const env = process.env.VAULT_7ZIP;
  if (env) {
    // The override is the whole answer when set: tests point it at a missing
    // file to prove "not found" is handled. Its version is checked too.
    return (path.isAbsolute(env) && _isFile(env) && checkVersion(env).ok) ? env : null;
  }
  const shipped = _shippedPaths();
  const check = (p) => (shipped.includes(p) ? _usableShipped(p) : _usable(p));
  if (_cache && check(_cache)) return _cache;
  _cache = null;
  for (const p of shipped) {
    if (_usableShipped(p)) { _cache = p; return p; }
  }
  // The built app uses only its own copy (see header).
  if (_packaged) return null;
  const fixed = [
    ...candidateNames().map(name => path.join(_root, name)),
    ..._windowsInstallPaths(),
  ];
  for (const p of fixed) {
    if (_usable(p)) { _cache = p; return p; }
  }
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of candidateNames()) {
      const p = path.join(dir, name);
      if (_usable(p)) { _cache = p; return p; }
    }
  }
  return null;
}

/** True when `p` is the copy shipped with Vault (for display and tests). */
function isShipped(p) {
  return !!p && _shippedPaths().some(s => path.resolve(s) === path.resolve(p));
}

function invalidate() { _cache = null; _versions.clear(); _hashes.clear(); }

/** Tests only: act as the built app (packaged: true) or a source checkout (null: as started), and/or use another app folder. */
function _setForTest({ packaged, root } = {}) {
  if (packaged !== undefined) _packaged = packaged === null ? isSea : !!packaged;
  if (root !== undefined) _root = root || ROOT;
  invalidate();
}

/** Largest percent value 7-Zip printed in a chunk of -bsp1 output, or null. */
function parsePercent(text) {
  let last = null;
  const re = /(\d{1,3})%/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1]);
    if (n >= 0 && n <= 100) last = n;
  }
  return last;
}

/** A password 7-Zip's stdin prompt reads back exactly (see header). */
function passwordFitsStdin(pass) {
  return typeof pass === 'string' && pass.length > 0 && !/[\r\n\0]/.test(pass);
}

/**
 * Run 7-Zip once.
 * @param {string[]} args            never contains the password
 * @param {object} o
 * @param {string|null} o.password   written to stdin, then stdin is closed.
 *                                   null: stdin is closed with nothing on it.
 * @param {string} [o.cwd]
 * @param {(pct:number)=>void} [o.onPercent]
 * @param {{cancelled:boolean, kill?:Function}} [o.handle]  set .kill so the
 *                                   caller can stop the run
 * @param {string} [o.program]       defaults to locate()
 * @returns {Promise<{code:number, stdout:string, stderr:string, killed:boolean}>}
 */
function runSevenZip(args, { password = null, cwd, onPercent, handle, program } = {}) {
  const exe = program || locate();
  if (!exe) {
    const e = new Error('7-Zip was not found.');
    e.code = 'SEVENZIP_MISSING';
    return Promise.reject(e);
  }
  if (password !== null) {
    if (!passwordFitsStdin(password)) {
      return Promise.reject(Object.assign(new Error('That password cannot be used.'), { code: 'BAD_PASSWORD' }));
    }
    if (args.some(a => String(a).includes(password))) {
      // Never reachable from Vault's own callers; a hard stop if it ever is.
      return Promise.reject(Object.assign(new Error('Refused to start 7-Zip.'), { code: 'PASSWORD_IN_ARGS' }));
    }
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      return reject(Object.assign(new Error('7-Zip could not be started.'), { code: 'SEVENZIP_START' }));
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    const MAX = 256 * 1024;   // keep the tail only: a big archive lists a lot
    child.stdout.on('data', (b) => {
      const s = b.toString('utf8');
      stdout = (stdout + s).slice(-MAX);
      if (onPercent) { const p = parsePercent(s); if (p !== null) onPercent(p); }
    });
    child.stderr.on('data', (b) => { stderr = (stderr + b.toString('utf8')).slice(-MAX); });
    child.stdin.on('error', () => {});   // 7-Zip may exit before reading
    if (handle) {
      handle.kill = () => { killed = true; try { child.kill(); } catch {} };
      if (handle.cancelled) handle.kill();
    }
    child.on('error', () => reject(Object.assign(new Error('7-Zip could not be started.'), { code: 'SEVENZIP_START' })));
    child.on('close', (code) => {
      if (handle) handle.kill = null;
      resolve({ code: code === null ? -1 : code, stdout, stderr, killed });
    });
    if (password !== null) child.stdin.write(Buffer.from(password + '\n', 'utf8'));
    child.stdin.end();
  });
}

module.exports = {
  locate, invalidate, runSevenZip, parsePercent, passwordFitsStdin, NAMES, NAMES_POSIX,
  SHIPPED, SHIPPED_APP_DIR, shippedFor, isShipped,
  MIN_VERSION, candidateNames, parseVersion, versionAccepted, checkVersion,
  _setForTest,
};
