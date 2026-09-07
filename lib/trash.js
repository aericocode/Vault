/**
 * Trash engine — moves files to the configured trash folder with undo.
 *
 * SAFETY RULES (do not weaken):
 * - Trash is MOVE only. The single unlink in this file is the second half of
 *   a verified cross-volume copy (fs.rename fails with EXDEV across drives).
 * - A file whose on-disk state doesn't match the DB row (missing source,
 *   occupied restore target) is refused and reported, never forced.
 * - Every item returns its own result; one failure never aborts the batch.
 *
 * Trash filenames are OPAQUE (`<id>.<ext>`): the id keeps them collision-free
 * and traceable, while the original filename lives only in the (encryptable)
 * DB — a locked vault's trash folder leaks no titles. The real extension is
 * kept so trashed files still stream/thumbnail with a correct Content-Type.
 * Files trashed before this change (`<id>_<filename>`) restore unchanged —
 * the row's filepath stores wherever the file actually is.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../config');
const db = require('./database');

function ensureTrashDir() {
  fs.mkdirSync(config.paths.trashDir, { recursive: true });
}

/**
 * Move a file, falling back to copy+verify+unlink across volumes.
 * K: media libraries and a project-drive trash dir often differ, so the
 * EXDEV path matters on this machine.
 */
async function moveFile(from, to) {
  try {
    await fs.promises.rename(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }

  // Cross-volume: copy, verify size, then (and only then) delete the source
  await fs.promises.copyFile(from, to);
  const [srcStat, dstStat] = await Promise.all([
    fs.promises.stat(from),
    fs.promises.stat(to),
  ]);
  if (srcStat.size !== dstStat.size) {
    // Copy is bad — remove the partial copy, keep the original untouched
    await fs.promises.unlink(to).catch(() => {});
    throw new Error(`copy verification failed (${srcStat.size} vs ${dstStat.size} bytes)`);
  }
  await fs.promises.unlink(from);
}

/**
 * Move media items to the trash folder.
 * @param {number[]} ids
 * @returns {Promise<Array<{id:number, ok:boolean, error?:string, row?:object}>>}
 */
async function trashItems(ids) {
  ensureTrashDir();
  const results = [];

  for (const id of ids) {
    const row = db.getById(id);

    if (!row) {
      results.push({ id, ok: false, error: 'row not found' });
      continue;
    }
    if (row.user_trashed) {
      results.push({ id, ok: false, error: 'already trashed' });
      continue;
    }
    if (!fs.existsSync(row.filepath)) {
      // Stale row: the file is already gone from disk. Treat as trashed
      // anyway (owner-confirmed) so the listing disappears like the rest.
      // Sentinel: filepath === trashed_original_path marks "nothing moved",
      // so restore just clears the flags instead of looking for a file.
      db.markTrashed(id, row.filepath, row.filepath);
      results.push({ id, ok: true, stale: true, row: db.getById(id) });
      continue;
    }

    // Opaque on-disk name — only the id and media extension are visible
    const trashPath = path.resolve(config.paths.trashDir, `${row.id}${path.extname(row.filename).toLowerCase()}`);

    try {
      await moveFile(row.filepath, trashPath);
      db.markTrashed(id, trashPath, row.filepath);
      // The cached HLS segments go with it: a file on its way out has no
      // business leaving a playable copy of itself behind in the cache.
      try { await require('./stream/service').forget(id); } catch {}
      results.push({ id, ok: true, row: db.getById(id) });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }

  return results;
}

/**
 * Restore trashed items to their original paths.
 * @param {number[]} ids
 * @returns {Promise<Array<{id:number, ok:boolean, error?:string, row?:object}>>}
 */
async function untrashItems(ids) {
  const results = [];

  for (const id of ids) {
    const row = db.getById(id);

    if (!row) {
      results.push({ id, ok: false, error: 'row not found' });
      continue;
    }
    if (!row.user_trashed || !row.trashed_original_path) {
      results.push({ id, ok: false, error: 'not in trash' });
      continue;
    }
    if (row.filepath === row.trashed_original_path) {
      // Stale-trash sentinel: no file was ever moved — just clear the flags
      db.markUntrashed(id, row.trashed_original_path);
      results.push({ id, ok: true, stale: true, row: db.getById(id) });
      continue;
    }
    if (!fs.existsSync(row.filepath)) {
      results.push({ id, ok: false, error: 'trashed file missing on disk' });
      continue;
    }
    if (fs.existsSync(row.trashed_original_path)) {
      results.push({ id, ok: false, error: 'a file already exists at the original path' });
      continue;
    }

    try {
      // Recreate the original directory if it was removed since
      await fs.promises.mkdir(path.dirname(row.trashed_original_path), { recursive: true });
      await moveFile(row.filepath, row.trashed_original_path);
      db.markUntrashed(id, row.trashed_original_path);
      results.push({ id, ok: true, row: db.getById(id) });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }

  return results;
}

/**
 * Send a file to the OS Recycle Bin / Trash. Recoverable by the user outside
 * the app.
 * - Windows: the shell's VisualBasic FileSystem helper — no npm dep, and this
 *   is the well-tested primary path on this machine.
 * - macOS / Linux, AND as a fallback if the Windows helper itself fails (e.g.
 *   PowerShell missing/blocked): the `trash` package (optionalDependency —
 *   see package.json), which shells out to the native Finder/gio/kioclient/
 *   trash-cli mechanism per platform.
 */
async function recycleFile(filePath) {
  if (process.platform === 'win32') {
    try {
      recycleFileWindows(filePath);
      return;
    } catch (err) {
      if (!_trashPkg()) throw err;   // no cross-platform fallback installed — surface the original error
      // fall through to the npm package below
    }
  }
  const pkg = _trashPkg();
  if (!pkg) {
    throw new Error(
      'Recycle Bin needs the "trash" package on this platform (optionalDependency) — ' +
      'run: npm install trash'
    );
  }
  try {
    // glob:false — filenames can contain *, [, ], etc.; treat the path literally
    await pkg([filePath], { glob: false });
  } catch (err) {
    throw new Error('recycle failed: ' + String(err.message || err).split('\n')[0]);
  }
}

function recycleFileWindows(filePath) {
  // Single-quote → doubled for a PowerShell literal (no interpolation)
  const lit = `'${String(filePath).replace(/'/g, "''")}'`;
  const psCmd =
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${lit}, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  const r = spawnSync('powershell',
    ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) {
    throw new Error('recycle failed: ' + ((r.stderr || r.error?.message || '').trim().split('\n')[0] || 'unknown'));
  }
}

// Lazy + cached — an optionalDependency can be absent (failed to build on an
// exotic platform); module load must not crash because of it.
let _trashPkgCache;
function _trashPkg() {
  if (_trashPkgCache === undefined) {
    try { _trashPkgCache = require('trash'); }
    catch { _trashPkgCache = null; }
  }
  return _trashPkgCache;
}

/**
 * Destructive delete of live library files (NOT the trash folder — that's
 * emptyTrash's job). Only removes the file on disk; the caller purges the DB
 * record for whichever ids succeeded.
 * @param {number[]} ids
 * @param {'recycle'|'hard'} mode
 * @returns {Promise<Array<{id:number, ok:boolean, error?:string}>>}
 */
async function deleteItems(ids, mode) {
  const results = [];
  for (const id of ids) {
    const row = db.getById(id);
    if (!row) { results.push({ id, ok: false, error: 'row not found' }); continue; }
    try {
      if (row.filepath && fs.existsSync(row.filepath)) {
        if (mode === 'recycle') await recycleFile(row.filepath);
        else await fs.promises.unlink(row.filepath);      // hard
      }
      // Missing file → still OK: purge the stale record so it leaves the library
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { trashItems, untrashItems, ensureTrashDir, recycleFile, deleteItems };
