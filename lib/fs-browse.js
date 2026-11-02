/**
 * What the in-app folder browser shows (player-lib/fs-picker.js, the route
 * in server/fs-routes.js): the folders and matching files in one folder, a
 * quick media count for each folder, and the Places rail (home and its
 * XDG folders, plugged-in drives, the library's own folders).
 *
 * The listing is read-only: it lists names and stats entries, and never
 * opens a file (only folders, to count what is in them). /proc, /sys and
 * /dev are refused, also through a symlink, since they are not places
 * anyone keeps media and reading them can hang or leak. Network shares are
 * never looked into unless the user opens one (networkMounts).
 *
 * Also here: the off-Windows checks for Save As (checkSavePath, and
 * writePlaylistFile, the one function in this file that writes) and for
 * dropped paths (dropPaths).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REFUSED_ROOTS = ['/proc', '/sys', '/dev'];

const VIDEO_EXTS = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpeg', 'mpg',
  '3gp', 'mts', 'm2ts', 'vob', 'ogv', 'rm', 'rmvb', 'asf', 'divx']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif']);

const MAX_ENTRIES = 5000;          // one folder's listing
const COUNT_MAX_CHILDREN = 300;    // a folder with more is not counted
const COUNT_BUDGET_MS = 250;       // all counts in one listing together

/** Is p (an absolute POSIX path) /proc, /sys, /dev or inside one of them? */
function isRefused(p) {
  const n = path.posix.normalize(String(p || ''));
  return REFUSED_ROOTS.some((r) => n === r || n.startsWith(`${r}/`));
}

/** The extension, lower case, without the dot. */
const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/**
 * ~/.config/user-dirs.dirs → { VIDEOS: '/home/you/Videos', ... }. Only
 * "$HOME/..." and absolute values are used, as xdg-user-dirs writes them.
 */
function parseUserDirs(text, home) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"(.*)"\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].replace(/\\(.)/g, '$1');
    if (v === '$HOME' || v === '$HOME/') continue;          // "unset" in xdg-user-dirs terms
    if (v.startsWith('$HOME/')) v = path.posix.join(home, v.slice(6));
    else if (!path.posix.isAbsolute(v)) continue;
    out[m[1]] = path.posix.normalize(v);
  }
  return out;
}

const PSEUDO_FS = /^(?:tmpfs|overlay|proc|sysfs|devtmpfs|devpts|squashfs|autofs|cgroup2?|securityfs|debugfs|tracefs|binfmt_misc|fusectl|mqueue|hugetlbfs|ramfs|nsfs|configfs|pstore|bpf|efivarfs)$/;

/** /proc/mounts escapes space, tab, newline and backslash as \040 \011 \012 \134. */
const unescapeMount = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/**
 * The drives worth showing from /proc/mounts: anything mounted under /media,
 * /run/media or /mnt (USB disks, second drives, network shares the user
 * mounted). System mounts are left out; "/" is added by places().
 */
function parseMounts(text) {
  const seen = new Set();
  const pseudo = [];              // tmpfs and the like: never a drive, nor anything mounted inside one
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const dir = unescapeMount(parts[1]);
    if (!/^\/(?:media|run\/media|mnt)\/./.test(dir) || seen.has(dir)) continue;
    const fstype = parts[2];
    if (PSEUDO_FS.test(fstype)) { pseudo.push(dir); continue; }
    if (pseudo.some((p) => dir.startsWith(`${p}/`))) continue;
    seen.add(dir);
    const network = NETWORK_FS.test(fstype);
    out.push({ path: dir, label: path.posix.basename(dir), kind: network ? 'network' : 'drive' });
  }
  return out;
}

const NETWORK_FS = /^(?:nfs4?|cifs|smb3?|smbfs|sshfs|fuse\.sshfs|davfs|fuse\.rclone)$/;

/**
 * Every network share in /proc/mounts, wherever it is mounted. A share whose
 * server has gone away can make a single stat or folder read wait for minutes,
 * and these run on the server's only thread: so the browser never looks at
 * one unless the user opens it (no Places check, no media count).
 */
function networkMounts(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || !NETWORK_FS.test(parts[2])) continue;
    const dir = unescapeMount(parts[1]);
    if (path.posix.isAbsolute(dir) && dir !== '/' && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/** Is p one of `mounts` or inside one? */
const onMount = (p, mounts) => mounts.some((m) => p === m || p.startsWith(`${m}/`));

const PROGRAM_DIRS = ['/usr/bin', '/usr/local/bin', '/snap/bin', '/opt/homebrew/bin'];

const XDG_PLACES = [
  ['DESKTOP', 'Desktop'], ['VIDEOS', 'Videos'], ['PICTURES', 'Pictures'], ['MUSIC', 'Music'],
  ['DOWNLOAD', 'Downloads'], ['DOCUMENTS', 'Documents'],
];

/**
 * The Places rail, in groups. Folders that do not exist are left out.
 * @param {object} o
 * @param {string} o.home
 * @param {string} [o.userDirsText]  ~/.config/user-dirs.dirs
 * @param {string} [o.mountsText]    /proc/mounts
 * @param {string[]} [o.libraryRoots]
 * @param {(p: string) => boolean} [o.isDir]
 */
function places({ home, userDirsText = '', mountsText = '', libraryRoots = [], programs = false, isDir = isDirSync }) {
  const groups = [];
  if (programs) {
    // Choose mpv: where package managers put programs.
    const items = PROGRAM_DIRS.filter((p) => isDir(p)).map((p) => ({ path: p, label: p, icon: 'programs' }));
    if (items.length) groups.push({ group: 'Programs', items });
  }
  const computer = [];
  if (home && isDir(home)) computer.push({ path: home, label: 'Home', icon: 'home' });
  const dirs = parseUserDirs(userDirsText, home || '/');
  for (const [key, fallback] of XDG_PLACES) {
    const p = dirs[key] || (home ? path.posix.join(home, fallback) : null);
    if (!p || p === home || computer.some((c) => c.path === p) || !isDir(p)) continue;
    computer.push({ path: p, label: path.posix.basename(p), icon: key.toLowerCase() });
  }
  if (computer.length) groups.push({ group: 'This computer', items: computer });
  // A network share is listed as mounted, never checked (see networkMounts).
  const remote = networkMounts(mountsText);
  const drives = parseMounts(mountsText).filter((d) => d.kind === 'network' || onMount(d.path, remote) || isDir(d.path))
    .map((d) => ({ path: d.path, label: d.label, icon: d.kind, tag: d.kind === 'network' ? 'network' : null }));
  drives.push({ path: '/', label: 'This computer', icon: 'computer' });
  groups.push({ group: 'Drives', items: drives });
  const lib = (libraryRoots || []).filter((p) => typeof p === 'string' && path.posix.isAbsolute(p) && !isRefused(p)
    && (onMount(p, remote) || isDir(p)))
    .map((p) => ({ path: p, label: path.posix.basename(p) || p, icon: 'library' }));
  if (lib.length) groups.push({ group: 'In your library', items: lib });
  return groups;
}

function isDirSync(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Read a small text file, or '' (no file, no permission). */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

/** The Places rail for this computer. */
function placesHere({ libraryRoots = [], env = process.env, programs = false } = {}) {
  const home = env.HOME || os.homedir();
  const config = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config');
  return places({
    home,
    userDirsText: readText(path.posix.join(config, 'user-dirs.dirs')),
    mountsText: readText('/proc/mounts'),
    libraryRoots,
    programs,
  });
}

/** Where the browser opens for a mode, when it was given no folder. */
function defaultStart(mode, { env = process.env } = {}) {
  const home = env.HOME || os.homedir();
  if (mode === 'exe') return isDirSync('/usr/bin') ? '/usr/bin' : home;
  const config = env.XDG_CONFIG_HOME && path.posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config');
  const dirs = parseUserDirs(readText(path.posix.join(config, 'user-dirs.dirs')), home);
  const want = mode === 'folder' || mode === 'files' ? (dirs.VIDEOS || path.posix.join(home, 'Videos'))
    : mode === 'file' || mode === 'save' ? (dirs.MUSIC || path.posix.join(home, 'Music')) : home;
  return isDirSync(want) ? want : home;
}

/**
 * Count the videos and images directly inside one folder. null when the
 * folder has more than COUNT_MAX_CHILDREN entries or cannot be read.
 */
function countMedia(dir, fsx = fs) {
  let d;
  try { d = fsx.opendirSync(dir); } catch { return null; }
  let videos = 0, images = 0, n = 0;
  try {
    for (let e = d.readSync(); e; e = d.readSync()) {
      if (++n > COUNT_MAX_CHILDREN) return null;
      if (e.isDirectory()) continue;
      const x = extOf(e.name);
      if (VIDEO_EXTS.has(x)) videos++;
      else if (IMAGE_EXTS.has(x)) images++;
    }
  } catch { return null; } finally { try { d.closeSync(); } catch {} }
  return { videos, images };
}

/**
 * One folder's listing.
 * @param {string} dir  absolute
 * @param {object} o
 * @param {'folder'|'file'|'files'|'save'|'exe'} o.mode
 * @param {string[]} [o.exts]       file modes: which extensions to list (none: every file)
 * @param {boolean} [o.hidden]      list names starting with a dot
 * @param {Set<string>} [o.inLibrary] folders that are library roots (tagged "In library")
 * @param {() => number} [o.now]
 * @param {string[]} [o.remote]     network shares (networkMounts); default: this computer's
 * @returns {{ ok: true, path: string, parent: string|null, entries: object[], truncated: boolean }
 *           | { ok: false, status: number, error: string }}
 */
function listDir(dir, { mode = 'folder', exts = [], hidden = false, inLibrary = new Set(), now = Date.now, remote } = {}) {
  if (typeof dir !== 'string' || !path.posix.isAbsolute(dir) || /[\u0000-\u001f]/.test(dir)) {
    return { ok: false, status: 400, error: 'Type a full path, starting with /.' };
  }
  let want = path.posix.normalize(dir);
  if (want.length > 1) want = want.replace(/\/+$/, '');
  if (isRefused(want)) return { ok: false, status: 403, error: 'Vault does not look inside system folders.' };
  let real;
  try { real = fs.realpathSync(want); } catch (err) { return notOpen(err); }
  if (isRefused(real)) return { ok: false, status: 403, error: 'Vault does not look inside system folders.' };
  let dirents;
  try {
    if (!fs.statSync(real).isDirectory()) return { ok: false, status: 400, error: 'That is a file, not a folder.' };
    dirents = fs.readdirSync(real, { withFileTypes: true });
  } catch (err) { return notOpen(err); }

  const extSet = new Set(exts.map((e) => String(e).toLowerCase().replace(/^\./, '')).filter(Boolean));
  const fileMode = mode !== 'folder';
  // Folders here that are network shares are listed, not looked into (no
  // count), unless the user is already inside that share.
  const shares = (Array.isArray(remote) ? remote : networkMounts(readText('/proc/mounts')))
    .filter((m) => !onMount(want, [m]));
  const entries = [];
  let truncated = false;
  const started = now();
  for (const e of dirents) {
    if (!hidden && e.name.startsWith('.')) continue;
    const full = path.posix.join(want, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      // Follow it, but never into a refused folder.
      try {
        const target = fs.realpathSync(full);
        if (isRefused(target)) continue;
        const st = fs.statSync(target);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch { continue; }                             // a broken link
    }
    if (isDir) {
      if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
      const row = { name: e.name, dir: true };
      if (mode === 'folder' || mode === 'files') {
        // A quick look at what is directly inside, within a small time budget.
        const c = now() - started < COUNT_BUDGET_MS && !onMount(full, shares) ? countMedia(full) : null;
        row.counted = !!c;
        if (c) row.count = c;
      }
      if (inLibrary.has(full)) row.inLibrary = true;
      entries.push(row);
      continue;
    }
    if (!fileMode || !isFile) continue;
    if (mode === 'exe') {
      try { fs.accessSync(full, fs.constants.X_OK); } catch { continue; }
    } else if (extSet.size && !extSet.has(extOf(e.name))) continue;
    if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
    entries.push({ name: e.name, dir: false });
  }
  entries.sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  return { ok: true, path: want, parent: want === '/' ? null : path.posix.dirname(want), entries, truncated };
}

/** One absolute, already normalized POSIX path with no control characters, outside /proc, /sys and /dev. */
function plainAbsolute(p, max = 4096) {
  return typeof p === 'string' && p.length > 0 && p.length <= max && !/[\u0000-\u001f]/.test(p)
    && p.startsWith('/') && path.posix.normalize(p) === p && !isRefused(p);
}

/**
 * Save As off Windows (the desktop's dialog, or the browser's save mode): the
 * path, if Vault will write a playlist there, else null. Absolute and
 * normalized, ending in .m3u or .m3u8, in a folder that exists and is not
 * (through a symlink) inside /proc, /sys or /dev, and, when something is
 * already there, a regular file of this user's with one name (never a
 * symlink or a hard link, so a link cannot redirect the write).
 * This is the early answer for the page; writePlaylistFile() checks again
 * on the file it actually opens, since the folder can change in between.
 */
function checkSavePath(raw, { uid = currentUid() } = {}) {
  if (!plainAbsolute(raw) || raw.endsWith('/')) return null;
  if (!['.m3u', '.m3u8'].includes(path.posix.extname(raw).toLowerCase())) return null;
  const dir = path.posix.dirname(raw);
  try {
    if (!fs.statSync(dir).isDirectory() || isRefused(fs.realpathSync(dir))) return null;
  } catch { return null; }
  let st = null;
  try { st = fs.lstatSync(raw); } catch (err) { if (err.code !== 'ENOENT') return null; }
  if (st && !replaceable(st, uid)) return null;
  return raw;
}

/** An existing file Save As may replace: a regular file, one name only, this user's. */
function replaceable(st, uid) {
  return st.isFile() && !(st.nlink > 1) && (uid == null || st.uid === uid);
}

function currentUid() {
  try { return typeof process.getuid === 'function' ? process.getuid() : null; } catch { return null; }
}

/**
 * Write a playlist off Windows, at a path checkSavePath() accepted. The checks
 * are made again on the open file itself, so nothing swapped in after the
 * check is written through:
 *  - O_NOFOLLOW: a symlink put there since fails (ELOOP) instead of being
 *    followed to some other file;
 *  - O_NONBLOCK: a FIFO put there cannot hold the open (and the server) until
 *    something reads it; it fails (ENXIO) or is refused below;
 *  - fstat of the open file: a regular file, one name, this user's, before
 *    anything in it is replaced (O_TRUNC is not used, so a refused file is
 *    left as it was).
 * Throws an Error with a code (ELOOP, ENXIO, EBADFILE, ...) when it will not write.
 */
function writePlaylistFile(target, text, { fsx = fs, uid = currentUid() } = {}) {
  const C = fs.constants;
  const flags = C.O_WRONLY | C.O_CREAT | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0);
  const fd = fsx.openSync(target, flags, 0o666);
  try {
    if (!replaceable(fsx.fstatSync(fd), uid)) {
      throw Object.assign(new Error('not a playlist file Vault may replace'), { code: 'EBADFILE' });
    }
    fsx.ftruncateSync(fd, 0);
    fsx.writeFileSync(fd, text, 'utf8');
  } finally {
    try { fsx.closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * A drop's paths off Windows: Nautilus, Dolphin and most Linux file managers
 * put the real paths on a drag as file:// URIs (text/uri-list), which the page
 * decodes (player-lib/fs-picker.js decodeUriList) and sends here. Each one is
 * checked and looked at on disk; the answer has resolve-drop's usual shape.
 * No paths (a browser or file manager that does not send them):
 * { unresolved: 'unsupported' }, and the page says to use Add folder.
 */
function dropPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) return { unresolved: 'unsupported' };
  const files = [], dirs = [];
  for (const p of paths.slice(0, 2000)) {
    if (!plainAbsolute(p)) continue;
    try {
      if (isRefused(fs.realpathSync(p))) continue;
      const st = fs.statSync(p);
      if (st.isDirectory()) dirs.push(p);
      else if (st.isFile()) files.push({ path: p, size: st.size });
    } catch { /* gone, or not readable */ }
  }
  if (!files.length && !dirs.length) return { unresolved: 'no readable paths' };
  return { files, dirs };
}

function notOpen(err) {
  const code = err && err.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, status: 404, error: 'That folder does not exist.' };
  if (code === 'EACCES' || code === 'EPERM') return { ok: false, status: 403, error: 'You do not have permission to open that folder.' };
  return { ok: false, status: 400, error: 'That folder cannot be opened.' };
}

module.exports = {
  isRefused, plainAbsolute, parseUserDirs, parseMounts, networkMounts, places, placesHere, defaultStart, countMedia, listDir,
  checkSavePath, writePlaylistFile, dropPaths, REFUSED_ROOTS, COUNT_MAX_CHILDREN,
};
