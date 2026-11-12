'use strict';
/**
 * Move a file to the desktop Trash on Linux, the way GNOME Files, Dolphin and
 * `gio trash` do it (the freedesktop.org Trash specification 1.0), so the
 * user can restore it from their file manager.
 *
 * Why Vault has its own: the `trash` npm package works from source, but not
 * inside the packaged app. Its Linux code reads /proc/self/mountinfo through
 * @stroncium/procfs, which loads its parsers with a computed require(); the
 * esbuild bundle in the single-file app cannot follow that, so every delete
 * failed with "Module not found in bundle: ./parsers/processMountinfo". This
 * file is plain Node with no dependencies, so it behaves the same in both.
 *
 * Where a file goes:
 *  - on the same disk as the home Trash ($XDG_DATA_HOME/Trash, by default
 *    ~/.local/share/Trash): there, with an absolute Path=
 *  - on another disk (a USB drive, a second partition): that disk's own
 *    Trash at its top folder, `$topdir/.Trash/$uid` when the admin made a
 *    shared .Trash (a real folder with the sticky bit), else
 *    `$topdir/.Trash-$uid`, with Path= relative to $topdir. Never copied
 *    across disks: moving a big video to another disk is a slow copy the user
 *    did not ask for, and the file managers do not do it either.
 *
 * Order (spec): the .trashinfo is created first, with O_EXCL so two deletes
 * never take the same name, then the file is renamed into files/. A failed
 * rename removes the .trashinfo again.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** The home Trash folder: $XDG_DATA_HOME/Trash, or ~/.local/share/Trash. */
function homeTrashDir(env = process.env, home = os.homedir()) {
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME
    : path.join(home, '.local', 'share');
  return path.join(data, 'Trash');
}

/** Percent-encode a path for Path= (RFC 2396 escaping, slashes kept). */
function encodeTrashPath(p) {
  return String(p).split('/').map(seg => encodeURIComponent(seg)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

/** Local time, YYYY-MM-DDThh:mm:ss (the spec's DeletionDate). */
function deletionDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The top folder of the disk `p` is on: the highest ancestor still on the same device. */
function mountTop(p, { fsx = fs } = {}) {
  let dir = path.isAbsolute(p) ? p : path.resolve(p);
  const dev = fsx.statSync(dir).dev;
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    let pdev;
    try { pdev = fsx.statSync(parent).dev; } catch { return dir; }
    if (pdev !== dev) return dir;
    dir = parent;
  }
}

/**
 * Which Trash folder a file goes to, creating it when needed.
 * @returns {{ dir: string, topdir: string|null }}  topdir null: the home Trash (absolute Path=)
 */
function trashDirFor(filePath, { env = process.env, home = os.homedir(), uid = process.getuid(), fsx = fs } = {}) {
  const fileDev = fsx.lstatSync(filePath).dev;
  const homeTrash = homeTrashDir(env, home);
  // The home Trash counts as "this disk" when the nearest existing folder on
  // its way (itself, ~/.local/share, ~) is on the file's device.
  let probe = homeTrash;
  for (;;) {
    try { if (fsx.statSync(probe).dev === fileDev) return { dir: homeTrash, topdir: null }; break; }
    catch { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  }

  const topdir = mountTop(path.dirname(filePath), { fsx });
  // A shared $topdir/.Trash is only trusted as the spec says: a real folder
  // (not a symlink) with the sticky bit set. Then each user has a subfolder.
  const shared = path.join(topdir, '.Trash');
  try {
    const st = fsx.lstatSync(shared);
    if (st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o1000)) {
      const mine = path.join(shared, String(uid));
      fsx.mkdirSync(mine, { recursive: true, mode: 0o700 });
      return { dir: mine, topdir };
    }
  } catch { /* none, or not usable: the per-user one below */ }
  const own = path.join(topdir, `.Trash-${uid}`);
  try {
    fsx.mkdirSync(own, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new Error(`this drive has no Trash Vault can use (${err.code || err.message}). Choose another delete mode in Settings`);
  }
  return { dir: own, topdir };
}

/**
 * Move one file to the Trash.
 * @returns {{ trashedAs: string, info: string }} where it went (for tests)
 */
function trashFile(filePath, opts = {}) {
  const fsx = opts.fsx || fs;
  const abs = path.resolve(filePath);
  const { dir, topdir } = trashDirFor(abs, opts);
  const filesDir = path.join(dir, 'files');
  const infoDir = path.join(dir, 'info');
  fsx.mkdirSync(filesDir, { recursive: true, mode: 0o700 });
  fsx.mkdirSync(infoDir, { recursive: true, mode: 0o700 });

  const shownPath = topdir ? path.relative(topdir, abs) : abs;
  const body = `[Trash Info]\nPath=${encodeTrashPath(shownPath)}\nDeletionDate=${deletionDate(opts.now ? opts.now() : new Date())}\n`;

  const ext = path.extname(abs);
  const stem = path.basename(abs, ext);
  for (let n = 1; n < 10000; n++) {
    const name = n === 1 ? path.basename(abs) : `${stem}.${n}${ext}`;
    const infoPath = path.join(infoDir, `${name}.trashinfo`);
    const dest = path.join(filesDir, name);
    let fd;
    try { fd = fsx.openSync(infoPath, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') continue; throw err; }
    try { fsx.writeSync(fd, body); } finally { fsx.closeSync(fd); }
    // A leftover in files/ with no .trashinfo (a crash mid-delete) is not ours to overwrite.
    if (fsx.existsSync(dest)) { try { fsx.unlinkSync(infoPath); } catch {} continue; }
    try {
      fsx.renameSync(abs, dest);
    } catch (err) {
      try { fsx.unlinkSync(infoPath); } catch {}
      if (err.code === 'EXDEV') throw new Error('the Trash for this file is on another drive, so it was not moved');
      throw err;
    }
    return { trashedAs: dest, info: infoPath };
  }
  throw new Error('the Trash has too many files with this name');
}

module.exports = { trashFile, trashDirFor, homeTrashDir, mountTop, encodeTrashPath, deletionDate };
