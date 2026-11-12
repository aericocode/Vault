/**
 * The mpv process behind Stage: start it, talk to it, end it.
 *
 * - The JSON IPC pipe has a random, unguessable name made here
 *   (\\.\pipe\vault-stage-<32 hex>; on Linux a socket in a fresh private
 *   folder), so no other program can sit on it first or guess it.
 * - mpv is started without a shell, with arguments from mpv-args.js only.
 * - mpv never outlives Vault. Node (libuv) puts every child it spawns on
 *   Windows into one job object marked kill-on-close and holds the only
 *   handle to it, unless the child is spawned detached (never here). When
 *   Vault's process ends, however it ends (closed, crashed, killed from Task
 *   Manager), Windows closes that handle and kills mpv with it. Checked with
 *   a hard kill (TerminateProcess) of the parent: mpv went with it. On top
 *   of that Vault quits mpv itself on the way out (process 'exit').
 *   Elsewhere the child is killed on exit (no job objects there), and a
 *   Vault that was killed outright leaves mpv running. So off Windows mpv's
 *   pid is written next to its socket, and the next Stage start ends an mpv
 *   whose Vault is gone (reapStale).
 * - What mpv does is reported as events (start-file, end-file, property
 *   changes, client-message), and its exit with whether Vault asked for it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { MpvIpc } = require('./mpv-ipc');
const { watchWindow } = require('./mpv-window');

/** The properties Stage follows. */
const OBSERVED = ['time-pos', 'duration', 'pause', 'eof-reached', 'idle-active', 'osd-width', 'osd-height', 'window-maximized'];
/** Also followed off Windows and macOS: the video's shape and full screen, for window-fit.js. */
const OBSERVED_LINUX = ['video-out-params', 'fullscreen'];
/**
 * Bindings off Windows and macOS: the mouse wheel over the picture makes a
 * Free size window bigger or smaller, in the video's shape (window-fit.js).
 * The one way to size it with no frame on X11; nothing else uses the wheel.
 */
const WHEEL_BINDINGS = Object.freeze([
  ['WHEEL_UP', 'script-message vault-stage grow'],
  ['WHEEL_DOWN', 'script-message vault-stage shrink'],
]);
const linuxLike = (platform) => platform !== 'win32' && platform !== 'darwin';

/*
 * A unix socket path has to fit in sun_path: 108 bytes on Linux, 104 on
 * macOS, the closing NUL included. <tmp>/vault-stage-XXXXXX/mpv.sock adds 28,
 * so a long TMPDIR (a sandbox, a deep home folder) falls back to /tmp.
 */
const SUN_PATH_MAX = 103;
function socketBase(tmp = os.tmpdir()) {
  return Buffer.byteLength(path.join(tmp, 'vault-stage-XXXXXX', 'mpv.sock')) <= SUN_PATH_MAX ? tmp : '/tmp';
}

/** A process's command line, or '' (gone, or not ours to read). */
function cmdlineOf(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch {}
  try {
    return require('child_process').execFileSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/**
 * End the mpv a killed Vault left behind (off Windows). Every socket folder
 * holds mpv.pid ({ vault, mpv }). A folder whose Vault is gone is stale: its
 * mpv is ended, but only if that pid is still an mpv on THIS socket (a pid can
 * be reused by any program), and the folder is removed. A folder whose Vault
 * still runs (a second Vault) is left alone, and so is one without a pid file.
 * Only this user's own folders are looked in: /tmp is shared, so a folder
 * that belongs to someone else, or a link, is skipped before its pid file is
 * read (another user could otherwise name any pid, or a link could point
 * Vault at a folder to remove).
 * @param {string} base  where the socket folders are
 * @param {object} [o]   isAlive / cmdline / kill / uid / lstat (tests)
 * @returns {number} how many mpv processes were ended
 */
function reapStale(base, {
  isAlive = pidAlive, cmdline = cmdlineOf, kill = (pid) => process.kill(pid, 'SIGTERM'),
  uid = typeof process.getuid === 'function' ? process.getuid() : null, lstat = fs.lstatSync,
} = {}) {
  let ended = 0;
  let names = [];
  try { names = fs.readdirSync(base).filter(n => n.startsWith('vault-stage-')); } catch { return 0; }
  for (const name of names) {
    const dir = path.join(base, name);
    let st;
    try { st = lstat(dir); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    if (uid !== null && st.uid !== uid) continue;
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, 'mpv.pid'), 'utf8')); } catch { continue; }
    if (!rec || !Number.isSafeInteger(rec.vault) || !Number.isSafeInteger(rec.mpv)) continue;
    if (rec.vault === process.pid || isAlive(rec.vault)) continue;
    if (isAlive(rec.mpv) && cmdline(rec.mpv).includes(path.join(dir, 'mpv.sock'))) {
      try { kill(rec.mpv); ended++; } catch {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return ended;
}

/**
 * A fresh pipe (or socket) path nobody can guess. cleanup() removes a socket
 * folder; recordPid(pid) writes mpv's pid next to the socket (off Windows).
 * Off Windows it first ends any mpv a killed Vault left running.
 */
function makeIpcPath(platform = process.platform) {
  const id = crypto.randomBytes(16).toString('hex');
  if (platform === 'win32') return { path: `\\\\.\\pipe\\vault-stage-${id}`, cleanup: () => {} };
  const base = socketBase();
  reapStale(base);
  const dir = fs.mkdtempSync(path.join(base, 'vault-stage-'));   // 0700
  return {
    path: path.join(dir, 'mpv.sock'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
    recordPid: (pid) => {
      try { fs.writeFileSync(path.join(dir, 'mpv.pid'), JSON.stringify({ vault: process.pid, mpv: pid }), { mode: 0o600 }); } catch {}
    },
  };
}

/** mpv 0.38 added the playlist index to loadfile, before the per-file options. */
function loadfileTakesIndex(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return true;     // a git build: new enough
  const major = Number(m[1]), minor = Number(m[2]);
  return major > 0 || minor >= 38;
}

/** mpv 0.38 also added volume-gain (Even out loudness uses it; older ones get a volume filter). */
function volumeGainSupported(version) {
  return loadfileTakesIndex(version);
}

/**
 * @param {object} o
 * @param {(ev: object) => void} o.onEvent     mpv's events (and 'property-change')
 * @param {(info: {code: number|null, asked: boolean}) => void} o.onExit
 * @param {(ev: object) => void} [o.onWindow]  the window watcher's lines (bounds, styles)
 */
function createMpvHost({ onEvent = () => {}, onExit = () => {}, onWindow = () => {}, platform = process.platform, spawnFn = spawn, makeIpc = makeIpcPath, ipcOptions = {}, watch = watchWindow } = {}) {
  let child = null;
  let ipc = null;
  let asked = false;          // Vault asked mpv to quit
  let watcher = null;
  let version = null;
  let hwnd = null;

  function alive() { return !!child && child.exitCode === null && child.signalCode === null; }

  /**
   * Start mpv and connect to it. Resolves { ok: true } once the IPC answers
   * and the bindings are in, or { ok: false, error }.
   *
   * fallbackArgsFor: a second command line, tried once when mpv ends before
   * its pipe answers with the first (Linux: the XWayland window, when this
   * machine cannot draw through X11). That first mpv's exit is not reported;
   * the result then has fellBack: true.
   * @param {string} exe        a path findMpv() accepted just now
   * @param {(ipcPath: string) => string[]} argsFor  mpv-args.js buildArgs with the pipe filled in
   * @param {object} [o]
   * @param {(ipcPath: string) => string[]} [o.fallbackArgsFor]
   */
  async function start(exe, argsFor, { mpvVersion = null, fallbackArgsFor = null } = {}) {
    if (alive()) return { ok: true, reused: true };
    version = mpvVersion;
    const first = await attempt(exe, argsFor, !!fallbackArgsFor);
    if (first.ok || !first.earlyExit || !fallbackArgsFor) return result(first);
    const second = await attempt(exe, fallbackArgsFor, false);
    return second.ok ? { ...result(second), fellBack: true } : result(second);
  }

  const result = (r) => (r.ok ? { ok: true } : { ok: false, error: r.error });

  /** One mpv. quietEarly: an exit before the pipe answers is not reported (earlyExit: true). */
  async function attempt(exe, argsFor, quietEarly) {
    asked = false;
    const ipcp = makeIpc(platform);
    let settled = false;
    let earlyExit = false;
    let conn = null;
    let proc;
    try {
      proc = spawnFn(exe, argsFor(ipcp.path), { stdio: 'ignore', windowsHide: true, shell: false, detached: false });
    } catch (err) {
      ipcp.cleanup();
      return { ok: false, error: 'mpv could not be started.' };
    }
    child = proc;
    if (ipcp.recordPid && proc.pid) ipcp.recordPid(proc.pid);
    let exited = false;
    proc.on('error', () => {});
    proc.on('exit', (code) => {
      exited = true;
      if (child === proc) child = null;
      if (quietEarly && !settled) {
        earlyExit = true;
        try { if (conn) conn.close(); } catch {}      // the connect() wait ends now, not at its timeout
        ipcp.cleanup();
        return;
      }
      try { if (ipc) ipc.close(); } catch {}
      ipc = null;
      if (watcher) { watcher.stop(); watcher = null; }
      hwnd = null;
      ipcp.cleanup();
      onExit({ code, asked });
    });
    conn = new MpvIpc(ipcp.path, { shouldReconnect: () => child === proc && !exited, ...ipcOptions });
    try {
      await conn.connect();
    } catch {
      settled = true;
      if (earlyExit) return { ok: false, earlyExit, error: 'mpv closed as it opened.' };
      try { proc.kill(); } catch {}
      return { ok: false, error: 'mpv did not answer.' };
    }
    settled = true;
    if (child !== proc) { conn.close(); return { ok: false, earlyExit, error: 'mpv closed as it opened.' }; }
    // The pipe must be the mpv Vault just started, not something else that
    // answered on it: mpv says its own process id, and it has to match.
    let pid = null;
    try { pid = await conn.get('pid'); } catch {}
    if (pid !== proc.pid) {
      conn.close();
      try { proc.kill(); } catch {}
      return { ok: false, error: 'Something other than the mpv Vault started answered on its pipe.' };
    }
    ipc = conn;
    conn.on('event', (msg) => { try { onEvent(msg); } catch (err) { console.warn('[Stage] event:', err && err.message); } });
    try {
      for (const p of linuxLike(platform) ? [...OBSERVED, ...OBSERVED_LINUX] : OBSERVED) await conn.observe(p);
      // The only bindings there are: the window's close button (and Alt+F4,
      // the taskbar's Close) asks Vault, which hands back to the mini player;
      // a double-click maximises or restores.
      await conn.command(['keybind', 'CLOSE_WIN', 'script-message vault-stage close']);
      await conn.command(['keybind', 'MBTN_LEFT_DBL', 'cycle window-maximized']);
      if (linuxLike(platform)) for (const [key, cmd] of WHEEL_BINDINGS) await conn.command(['keybind', key, cmd]);
    } catch {
      try { proc.kill(); } catch {}
      return { ok: false, error: 'mpv did not answer.' };
    }
    // Where the window is (Windows): mpv's window-id is its window handle there.
    // On X11 it is the X window (x11-hints.js); mpv's Wayland window has none.
    try {
      const id = await conn.get('window-id');
      if (Number.isSafeInteger(id) && id > 0) {
        hwnd = id;
        watcher = watch({ hwnd: id, mpvPid: proc.pid, onEvent: (ev) => onWindow(ev), platform });
      }
    } catch { /* no window id: nothing watched */ }
    return { ok: true };
  }

  function command(cmd, opts) {
    if (!ipc) return Promise.reject(Object.assign(new Error('mpv is not running'), { code: 'MPV_DISCONNECTED' }));
    return ipc.command(cmd, opts);
  }
  const set = (name, value) => command(['set_property', name, value]);
  const get = (name) => command(['get_property', name]);

  /** loadfile with per-file options, in the form this mpv takes. */
  function loadfile(file, mode, options = {}) {
    const opts = Object.entries(options).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${v}`).join(',');
    const cmd = loadfileTakesIndex(version) ? ['loadfile', file, mode, -1, opts] : ['loadfile', file, mode, opts];
    return command(cmd);
  }

  /** Ask mpv to quit; kill it if it has not gone after a moment. */
  function quit({ waitMs = 2000 } = {}) {
    const p = child;
    if (!p) return;
    asked = true;
    command(['quit'], { timeoutMs: 1000 }).catch(() => {});
    const t = setTimeout(() => { if (p.exitCode === null) { try { p.kill(); } catch {} } }, waitMs);
    if (t.unref) t.unref();
  }

  function kill() {
    const p = child;
    if (!p) return;
    asked = true;
    try { p.kill(); } catch {}
  }

  return {
    start, alive, command, set, get, loadfile, quit, kill,
    get pid() { return child ? child.pid : null; },
    get hwnd() { return hwnd; },
    get watcherPid() { return watcher ? watcher.pid : null; },
  };
}

module.exports = { createMpvHost, makeIpcPath, reapStale, socketBase, loadfileTakesIndex, volumeGainSupported, OBSERVED, OBSERVED_LINUX, WHEEL_BINDINGS };
