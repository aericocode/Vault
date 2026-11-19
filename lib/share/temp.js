/**
 * Share privately: the share_temp folder (spec 6.1).
 *
 * Where: ROOT/share_temp, beside temp_frames. VAULT_SHARE_TEMP (an absolute
 * path) moves it, for tests.
 *
 * Inside it, one folder per share, named share-<12 letters/digits> at random
 * (two libraries opened from the same Vault folder can never collide on a
 * share id). The folder name, never a full path, is what the database keeps,
 * and every name read back is checked against that exact pattern before it
 * is joined to the root.
 *
 * Each work folder carries a small marker file, LIBRARY_MARKER, holding the
 * random id of the library that made it (lib/share/service.js keeps that id
 * in share_kv). The leftover sweep (service.js) only ever deletes a folder
 * whose marker names the library that is open, so a second library opened
 * from the same Vault folder never deletes the first one's work.
 *
 * Permissions: on Linux and macOS share_temp and every work folder are 0700
 * and the files Vault writes in them 0600 (owner only). Windows folders take
 * the rights of the Vault folder.
 *
 * Deleting (spec 8.8, "never outside share_temp"): removeWorkDir() deletes
 * ONLY a folder that
 *   - has a name matching the pattern (so no "..", no separators),
 *   - is a real folder, not a link or junction (lstat),
 *   - resolves (realpath) to a direct child of the resolved share_temp root,
 *   - sits in a root that carries Vault's owned marker (lib/owned-dir.js).
 * Anything else is left alone and reported.
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../approot');
const ownedDir = require('../owned-dir');
const names = require('./names');

const WORK_DIR_RX = /^share-[A-Za-z0-9]{12}$/;
const LIBRARY_MARKER = '.vault-share-library';
const LIBRARY_ID_RX = /^[0-9a-f]{32}$/;
// What 7-Zip reads while packing; plaintext about the library (the list holds
// the original paths, stage/ holds links or copies of the files). See pack.js.
const SCRATCH = ['list.txt', 'stage'];
const IS_WIN = process.platform === 'win32';

function root() {
  const env = process.env.VAULT_SHARE_TEMP;
  return (env && path.isAbsolute(env)) ? path.resolve(env) : path.join(ROOT, 'share_temp');
}

/** Create the root if needed and make sure it is Vault's own. */
function ensureRoot() {
  const r = root();
  if (!ownedDir.ensureManaged(r, 'sharetemp')) {
    const e = new Error('The share_temp folder holds files Vault did not put there, so Vault will not use it.');
    e.code = 'TEMP_NOT_OWNED';
    throw e;
  }
  if (!IS_WIN) { try { fs.chmodSync(r, 0o700); } catch { /* best effort */ } }
  return r;
}

function isWorkDirName(name) {
  return typeof name === 'string' && WORK_DIR_RX.test(name);
}

/**
 * Make a new, empty work folder (0700 outside Windows). With `libraryId` the
 * folder gets the library marker (see header). Returns { name, dir }.
 */
function createWorkDir(libraryId = null) {
  const r = ensureRoot();
  for (let i = 0; i < 5; i++) {
    const name = `share-${names.randomString(12)}`;
    const dir = path.join(r, name);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });   // not recursive: fails if it exists
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      continue;
    }
    if (libraryId && LIBRARY_ID_RX.test(libraryId)) {
      fs.writeFileSync(path.join(dir, LIBRARY_MARKER), libraryId, { flag: 'wx', mode: 0o600 });
    }
    return { name, dir };
  }
  throw new Error('Could not make a work folder.');
}

/** The library id in a work folder's marker, or null (no marker, or not a plain small file). */
function readLibraryMarker(name) {
  const dir = workDirPath(name);
  if (!dir) return null;
  const f = path.join(dir, LIBRARY_MARKER);
  try {
    const st = fs.lstatSync(f);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 64) return null;
    const v = fs.readFileSync(f, 'utf8').trim();
    return LIBRARY_ID_RX.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Names of the work folders in share_temp (real folders with the right name
 * only). Never creates share_temp; an absent or foreign one lists nothing.
 */
function listWorkDirs() {
  const r = root();
  if (!ownedDir.isOwned(r)) return [];
  let ents;
  try { ents = fs.readdirSync(r, { withFileTypes: true }); } catch { return []; }
  return ents.filter(e => e.isDirectory() && !e.isSymbolicLink() && WORK_DIR_RX.test(e.name)).map(e => e.name);
}

/**
 * Delete what 7-Zip read while packing (SCRATCH) from one work folder, with a
 * few tries (a scanner or a preview can hold a file for a moment on Windows).
 * Returns true when none of it is left. Same guards as removeWorkDir: a link
 * is removed as a link, never followed.
 */
async function removeScratch(name, opts) {
  const dir = workDirPath(name);
  if (!dir) return false;
  return removeScratchAt(dir, opts);
}

/** removeScratch() for a work folder given by its full path (pack.js). */
async function removeScratchAt(dir, { tries = 5, waitMs = 200 } = {}) {
  try { const st = fs.lstatSync(dir); if (!st.isDirectory() || st.isSymbolicLink()) return false; } catch (err) { return err.code === 'ENOENT'; }
  for (let i = 0; i < tries; i++) {
    let left = false;
    for (const item of SCRATCH) {
      const p = path.join(dir, item);
      try {
        fs.lstatSync(p);
      } catch { continue; }   // not there
      try { await fs.promises.rm(p, { recursive: true, force: true }); } catch { left = true; }
      try { fs.lstatSync(p); left = true; } catch { /* gone */ }
    }
    if (!left) return true;
    if (i < tries - 1) await new Promise(res => setTimeout(res, waitMs * (i + 1)));
  }
  return false;
}

/** Absolute path of a work folder by name, or null when the name is not one. */
function workDirPath(name) {
  if (!isWorkDirName(name)) return null;
  return path.join(root(), name);
}

/**
 * Is `target` inside `dir` (both already resolved)? A plain prefix test is
 * not enough ("share-a" vs "share-ab"), so the separator is part of it.
 */
function isInside(dir, target) {
  const rel = path.relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Delete one work folder (see header). Returns true when it is gone (or was
 * never there), false when it was refused or could not be deleted. Callers
 * treat false as NOT FINISHED: the share record keeps the folder's name, and
 * lib/share/service.js tries again later (it never forgets a folder that is
 * still on disk).
 */
async function removeWorkDir(name, { tries = 5, waitMs = 200 } = {}) {
  if (!isWorkDirName(name)) return false;
  const r = root();
  const dir = path.join(r, name);
  let st;
  try { st = fs.lstatSync(dir); } catch (err) { return err.code === 'ENOENT'; }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  if (!ownedDir.isOwned(r)) return false;
  let realRoot; let realDir;
  try { realRoot = fs.realpathSync(r); realDir = fs.realpathSync(dir); } catch { return false; }
  if (path.dirname(realDir) !== realRoot || !isInside(realRoot, realDir)) return false;
  for (let i = 0; i < tries; i++) {
    try {
      await fs.promises.rm(realDir, { recursive: true, force: true });
    } catch { /* tried again below */ }
    // Gone only when it is really gone: on Windows a file someone holds open
    // can make rm fail part way, or leave the folder behind.
    try { fs.lstatSync(realDir); } catch (err) { if (err.code === 'ENOENT') return true; }
    // A 7-Zip that was just killed can hold a handle for a moment (Windows).
    if (i < tries - 1) await new Promise(res => setTimeout(res, waitMs * (i + 1)));
  }
  return false;
}

/**
 * Free bytes on the drive that holds share_temp, or null when unknown.
 * Measured on share_temp when it exists, else on its nearest existing parent
 * folder: measuring never creates the folder.
 */
function freeBytes() {
  try {
    let dir = root();
    for (let i = 0; i < 64 && !fs.existsSync(dir); i++) {
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

module.exports = {
  root, ensureRoot, createWorkDir, workDirPath, removeWorkDir, removeScratch, removeScratchAt, freeBytes, isWorkDirName, isInside,
  listWorkDirs, readLibraryMarker, WORK_DIR_RX, LIBRARY_MARKER, LIBRARY_ID_RX, SCRATCH,
};
