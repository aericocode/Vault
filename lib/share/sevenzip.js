/**
 * Share privately: the 7-Zip program, found and run.
 *
 * FINDING IT (like lib/ffmpeg-locate.js, app folder first, then PATH):
 *   1. VAULT_7ZIP, an absolute path to the program. For tests and for a
 *      developer who has 7-Zip installed somewhere else. Must be an existing
 *      file; a relative or missing path is ignored (never resolved against the
 *      current folder).
 *   2. The copy SHIPPED with Vault (7-Zip 26.06, vendor/7zip/README.md):
 *        built app:        ROOT/7-Zip/7za.exe (Windows), ROOT/7-Zip/7zzs (Linux)
 *        source checkout:  ROOT/vendor/7zip/win-x64/7za.exe, .../linux-x64/7zzs
 *      tools/sea/build-app.js copies vendor/7zip/<platform>/ to 7-Zip/.
 *   3. ROOT/<name> for 7za, 7zz, 7z (".exe" on Windows): a copy put next to
 *      Vault by hand.
 *   4. Windows only: 7-Zip installed in its usual folder (Program Files\7-Zip,
 *      which the installer does not add to PATH).
 *   5. Each ABSOLUTE folder on PATH, same names. Relative PATH entries are
 *      skipped, and the result is always an absolute path: spawning a bare
 *      name lets Windows look in the current folder first.
 * On Linux a file without the run permission is passed over. A hit is cached;
 * a miss is not, so a copy dropped in later is picked up.
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
const { spawn } = require('child_process');
const { ROOT } = require('../approot');

const NAMES = ['7za', '7zz', '7z'];
let _cache = null;

// The program shipped with Vault, per platform: the folder under vendor/7zip/
// in the repo and the file name. The build copies that folder's program and
// License.txt to SHIPPED_APP_DIR next to the Vault program.
const SHIPPED = {
  'win32-x64': { vendorDir: 'win-x64', file: '7za.exe' },
  'linux-x64': { vendorDir: 'linux-x64', file: '7zzs' },
};
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

function _candidates() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  return NAMES.map(n => n + exe);
}

/** The shipped program for this platform, or null when none is shipped for it. */
function shippedFor(platform = process.platform, arch = process.arch) {
  return SHIPPED[`${platform}-${arch}`] || null;
}

/** Where the shipped program sits: in the built app, then in a source checkout. */
function _shippedPaths(root = ROOT) {
  const s = shippedFor();
  if (!s) return [];
  return [
    path.join(root, SHIPPED_APP_DIR, s.file),
    path.join(root, 'vendor', '7zip', s.vendorDir, s.file),
  ];
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
    // file to prove "not found" is handled.
    return (path.isAbsolute(env) && _isFile(env)) ? env : null;
  }
  if (_cache && _isRunnable(_cache)) return _cache;
  _cache = null;
  const fixed = [
    ..._shippedPaths(),
    ..._candidates().map(name => path.join(ROOT, name)),
    ..._windowsInstallPaths(),
  ];
  for (const p of fixed) {
    if (_isRunnable(p)) { _cache = p; return p; }
  }
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of _candidates()) {
      const p = path.join(dir, name);
      if (_isRunnable(p)) { _cache = p; return p; }
    }
  }
  return null;
}

/** True when `p` is the copy shipped with Vault (for display and tests). */
function isShipped(p) {
  return !!p && _shippedPaths().some(s => path.resolve(s) === path.resolve(p));
}

function invalidate() { _cache = null; }

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
  locate, invalidate, runSevenZip, parsePercent, passwordFitsStdin, NAMES,
  SHIPPED, SHIPPED_APP_DIR, shippedFor, isShipped,
};
