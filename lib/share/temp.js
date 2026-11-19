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
  return r;
}

function isWorkDirName(name) {
  return typeof name === 'string' && WORK_DIR_RX.test(name);
}

/** Make a new, empty work folder. Returns { name, dir }. */
function createWorkDir() {
  const r = ensureRoot();
  for (let i = 0; i < 5; i++) {
    const name = `share-${names.randomString(12)}`;
    const dir = path.join(r, name);
    try {
      fs.mkdirSync(dir);          // not recursive: fails if it exists
      return { name, dir };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not make a work folder.');
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
 * never there), false when it was refused or could not be deleted.
 */
async function removeWorkDir(name) {
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
  for (let i = 0; i < 5; i++) {
    try {
      await fs.promises.rm(realDir, { recursive: true, force: true });
      return true;
    } catch {
      // A 7-Zip that was just killed can hold a handle for a moment (Windows).
      await new Promise(res => setTimeout(res, 200 * (i + 1)));
    }
  }
  return false;
}

/** Free bytes on the drive that holds share_temp, or null when unknown. */
function freeBytes() {
  try {
    const r = ensureRoot();
    const s = fs.statfsSync(r);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

module.exports = { root, ensureRoot, createWorkDir, workDirPath, removeWorkDir, freeBytes, isWorkDirName, isInside, WORK_DIR_RX };
