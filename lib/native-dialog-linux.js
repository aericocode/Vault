/**
 * The desktop's own file and folder dialogs on Linux: zenity (GNOME, Xfce,
 * Cinnamon, MATE and most others) or kdialog (KDE Plasma, LXQt). Windows has
 * its own PowerShell dialogs in server/index.js and never comes here.
 *
 * No display (DISPLAY / WAYLAND_DISPLAY unset), no tool on PATH, or a tool
 * that fails to start: the caller gets { unavailable } or a 'failed' result
 * and opens Vault's in-app folder browser instead (player-lib/fs-picker.js).
 *
 * Tools are found by walking PATH here, and run with an argument array and
 * shell: false, so nothing in a title, a folder or a file name is ever read
 * by a shell.
 *
 * Later option, not in V1: xdg-desktop-portal's FileChooser over D-Bus
 * (works inside Flatpak and picks the right dialog on every desktop).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

/** Desktops whose own dialog is kdialog's (Qt). Everything else prefers zenity. */
function prefersKdialog(desktop) {
  return String(desktop || '').split(':').some((d) => /^(kde|plasma|lxqt)$/i.test(d.trim()));
}

/** An executable named `name` on PATH, or null. No shell, no `which`. */
function findOnPath(name, { env = process.env, fsx = fs } = {}) {
  for (const dir of String(env.PATH || '').split(':')) {
    if (!dir || !path.posix.isAbsolute(dir)) continue;     // never a relative PATH entry
    const full = path.posix.join(dir, name);
    try {
      const st = fsx.statSync(full);
      if (!st.isFile()) continue;
      fsx.accessSync(full, fs.constants.X_OK);
      return full;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * Which dialog tool to use.
 * @returns {{ tool: 'zenity'|'kdialog', path: string } | { unavailable: 'not-linux'|'no-display'|'no-tool' }}
 */
function chooseTool({ env = process.env, platform = process.platform, find = (n) => findOnPath(n, { env }) } = {}) {
  if (platform !== 'linux') return { unavailable: 'not-linux' };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { unavailable: 'no-display' };
  const order = prefersKdialog(env.XDG_CURRENT_DESKTOP) ? ['kdialog', 'zenity'] : ['zenity', 'kdialog'];
  for (const tool of order) {
    const p = find(tool);
    if (p) return { tool, path: p };
  }
  return { unavailable: 'no-tool' };
}

/** "Playlists | *.m3u *.m3u8" for zenity; "*.m3u *.m3u8|Playlists" for kdialog. */
function globs(filter) {
  return (filter && Array.isArray(filter.exts) ? filter.exts : [])
    .map((e) => String(e).replace(/^\./, ''))
    .filter((e) => /^[A-Za-z0-9]+$/.test(e))
    .map((e) => `*.${e}`);
}

/** zenity 4 always asks before replacing a file and calls --confirm-overwrite deprecated; 3.x needs it. */
function zenityNeedsConfirmFlag(version) {
  const m = /^(\d+)\./.exec(String(version || '').trim());
  return !m || Number(m[1]) < 4;
}

const withSlash = (d) => (d.endsWith('/') ? d : `${d}/`);

/**
 * The command line for one dialog.
 * @param {'zenity'|'kdialog'} tool
 * @param {object} spec
 * @param {'folder'|'file'|'files'|'save'} spec.mode
 * @param {string} spec.title
 * @param {string} [spec.startDir]  an absolute folder to open in
 * @param {string} [spec.name]      save: the suggested file name
 * @param {{label: string, exts: string[]}} [spec.filter]
 * @param {string} [zenityVersion]  "3.44.0", "4.0.1"; unknown counts as old
 * @returns {string[]}
 */
function buildArgs(tool, spec, zenityVersion) {
  const mode = spec.mode;
  const title = String(spec.title || 'Vault');
  const start = spec.startDir && path.posix.isAbsolute(spec.startDir) ? spec.startDir : null;
  const g = globs(spec.filter);
  const label = String((spec.filter && spec.filter.label) || 'Files').replace(/[|]/g, ' ');
  const name = String(spec.name || '').replace(/\//g, ' ');
  if (tool === 'zenity') {
    const a = ['--file-selection', `--title=${title}`];
    if (mode === 'folder') a.push('--directory');
    if (mode === 'files') a.push('--multiple', '--separator=\n');
    if (mode === 'save') {
      a.push('--save');
      if (zenityNeedsConfirmFlag(zenityVersion)) a.push('--confirm-overwrite');
    }
    if (mode === 'save') a.push(`--filename=${start ? withSlash(start) : ''}${name}`);
    else if (start) a.push(`--filename=${withSlash(start)}`);
    if (mode !== 'folder' && g.length) {
      a.push(`--file-filter=${label} | ${g.join(' ')}`);
      if (mode !== 'save') a.push('--file-filter=All files | *');
    }
    return a;
  }
  if (tool === 'kdialog') {
    const a = ['--title', title];
    const filter = g.length ? `${g.join(' ')}|${label}` : '';
    const dir = start || (process.env.HOME || '/');
    if (mode === 'folder') a.push('--getexistingdirectory', dir);
    else if (mode === 'save') a.push('--getsavefilename', path.posix.join(dir, name || ''));
    else {
      if (mode === 'files') a.push('--multiple', '--separate-output');
      a.push('--getopenfilename', dir);
    }
    if (mode !== 'folder' && filter) a.push(filter);
    return a;
  }
  throw new Error(`unknown dialog tool ${tool}`);
}

/** stderr of a tool that never showed a window (no X server or Wayland compositor to talk to). */
const NO_WINDOW = /cannot open display|could not connect to display|failed to connect to|could not load the qt platform plugin|unable to init server|gtk-warning \*\*: .*cannot open/i;

/**
 * What a finished dialog said.
 * @returns {{ status: 'picked', paths: string[] } | { status: 'cancel' } | { status: 'failed', reason: string }}
 */
function interpret({ code, signal, out, errOut }, mode) {
  const text = String(out || '').replace(/\r?\n$/, '');
  if (code === 0) {
    const paths = (mode === 'files' ? text.split('\n') : [text]).map((s) => s.replace(/\r$/, '')).filter(Boolean);
    if (!paths.length) return { status: 'cancel' };
    return { status: 'picked', paths };
  }
  if (code === 1 && !text) {
    // Exit 1 is Cancel for both tools, and also what GTK exits with when it
    // has no display to open: stderr tells the two apart.
    if (NO_WINDOW.test(String(errOut || ''))) return { status: 'failed', reason: 'no-window' };
    return { status: 'cancel' };
  }
  return { status: 'failed', reason: signal ? `signal ${signal}` : `exit ${code}` };
}

const _zenityVersions = new Map();
/** `zenity --version`, once per program path (a couple of milliseconds; capped at 3 s). */
function zenityVersion(exe, { spawnSyncFn = spawnSync } = {}) {
  if (_zenityVersions.has(exe)) return _zenityVersions.get(exe);
  let v = '';
  try {
    const r = spawnSyncFn(exe, ['--version'], { encoding: 'utf8', timeout: 3000, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    v = String((r && r.stdout) || '').trim();
  } catch { /* old counts as safe: the flag still works on 4.x, with a warning */ }
  _zenityVersions.set(exe, v);
  return v;
}

/**
 * Open a dialog.
 * @param {object} spec  see buildArgs
 * @param {object} [o]   env / platform / find / spawnFn / version (tests)
 * @returns {{ unavailable: string } | { child: import('child_process').ChildProcess, tool: string, result: Promise<object> }}
 *   result resolves to interpret()'s answer, or { status: 'failed', reason } when the tool would not start.
 */
function openDialog(spec, { env = process.env, platform = process.platform, find, spawnFn = spawn, version } = {}) {
  const pick = chooseTool({ env, platform, ...(find ? { find } : {}) });
  if (pick.unavailable) return { unavailable: pick.unavailable };
  const ver = pick.tool === 'zenity' && spec.mode === 'save'
    ? (version !== undefined ? version : zenityVersion(pick.path)) : '';
  const args = buildArgs(pick.tool, spec, ver);
  let child;
  try {
    child = spawnFn(pick.path, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { unavailable: `spawn: ${err && err.code ? err.code : 'failed'}` };
  }
  const result = new Promise((resolve) => {
    let out = '', errOut = '', settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    if (child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { out += d; }); }
    if (child.stderr) { child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { if (errOut.length < 8192) errOut += d; }); }
    child.on('error', (err) => done({ status: 'failed', reason: `spawn: ${err && err.code ? err.code : 'failed'}` }));
    child.on('close', (code, signal) => done(interpret({ code, signal, out, errOut }, spec.mode)));
  });
  return { child, tool: pick.tool, result };
}

module.exports = {
  prefersKdialog, findOnPath, chooseTool, buildArgs, interpret, openDialog,
  zenityNeedsConfirmFlag,
};
