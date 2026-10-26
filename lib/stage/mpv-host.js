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
 *   Elsewhere the child is killed on exit (no job objects there).
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

/** A fresh pipe (or socket) path nobody can guess. cleanup() removes a socket folder. */
function makeIpcPath(platform = process.platform) {
  const id = crypto.randomBytes(16).toString('hex');
  if (platform === 'win32') return { path: `\\\\.\\pipe\\vault-stage-${id}`, cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-stage-'));   // 0700
  return {
    path: path.join(dir, 'mpv.sock'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** mpv 0.38 added the playlist index to loadfile, before the per-file options. */
function loadfileTakesIndex(version) {
  const m = /^v?(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) return true;     // a git build: new enough
  const major = Number(m[1]), minor = Number(m[2]);
  return major > 0 || minor >= 38;
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
  let ipcCleanup = () => {};
  let asked = false;          // Vault asked mpv to quit
  let watcher = null;
  let version = null;
  let hwnd = null;

  function alive() { return !!child && child.exitCode === null && child.signalCode === null; }

  /**
   * Start mpv and connect to it. Resolves { ok: true } once the IPC answers
   * and the bindings are in, or { ok: false, error }.
   * @param {string} exe        a path findMpv() accepted just now
   * @param {(ipcPath: string) => string[]} argsFor  mpv-args.js buildArgs with the pipe filled in
   */
  async function start(exe, argsFor, { mpvVersion = null } = {}) {
    if (alive()) return { ok: true, reused: true };
    version = mpvVersion;
    asked = false;
    const ipcp = makeIpc(platform);
    ipcCleanup = ipcp.cleanup;
    let proc;
    try {
      proc = spawnFn(exe, argsFor(ipcp.path), { stdio: 'ignore', windowsHide: true, shell: false, detached: false });
    } catch (err) {
      ipcCleanup();
      return { ok: false, error: 'mpv could not be started.' };
    }
    child = proc;
    let exited = false;
    proc.on('error', () => {});
    proc.on('exit', (code) => {
      exited = true;
      if (child === proc) child = null;
      try { if (ipc) ipc.close(); } catch {}
      ipc = null;
      if (watcher) { watcher.stop(); watcher = null; }
      hwnd = null;
      ipcCleanup();
      onExit({ code, asked });
    });
    const conn = new MpvIpc(ipcp.path, { shouldReconnect: () => child === proc && !exited, ...ipcOptions });
    try {
      await conn.connect();
    } catch {
      try { proc.kill(); } catch {}
      return { ok: false, error: 'mpv did not answer.' };
    }
    if (child !== proc) { conn.close(); return { ok: false, error: 'mpv closed as it opened.' }; }
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
      for (const p of OBSERVED) await conn.observe(p);
      // The only bindings there are: the window's close button (and Alt+F4,
      // the taskbar's Close) asks Vault, which hands back to the mini player;
      // a double-click maximises or restores.
      await conn.command(['keybind', 'CLOSE_WIN', 'script-message vault-stage close']);
      await conn.command(['keybind', 'MBTN_LEFT_DBL', 'cycle window-maximized']);
    } catch {
      try { proc.kill(); } catch {}
      return { ok: false, error: 'mpv did not answer.' };
    }
    // Where the window is (Windows): mpv's window-id is its window handle there.
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

module.exports = { createMpvHost, makeIpcPath, loadfileTakesIndex, OBSERVED };
