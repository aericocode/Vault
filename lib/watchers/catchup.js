/**
 * Folder watchers: the catch-up walk. One quiet pass over a watched folder
 * that compares what is on disk (size + modified time) with what the library
 * knows, so changes made while Vault was closed, locked or paused are found.
 *
 * A merge-join, so a 2-million-row root never sits in memory: the library
 * side is read in PAGE-row pages in (path NOCASE, id) order (store.rowsUnder),
 * and the disk side is walked depth-first with each folder's entries sorted
 * into that same order (keyOf: ASCII case folded, UTF-8 bytes, which is
 * exactly SQLite's NOCASE order on Windows). The two streams then meet like
 * two sorted lists: a row before the next file is not on disk, a file before
 * the next row is new, equal keys are the same file. Only one page of rows
 * and the open folders' entry lists are held at a time, with a yield every
 * YIELD_EVERY entries and between pages.
 *
 * Symbolic links and junctions are never followed (Dirent.isDirectory() is
 * false for them), the same as the Add folder scan (server/index.js
 * scan-folder); rows at or below one are left as they are. A folder that
 * cannot be read at all comes back as an error and marks nothing missing: a
 * drive that is not there is not a deleted file. An unreadable subfolder's
 * rows are left alone the same way.
 *
 * Presence is judged on every file, whatever the folder's rules say: a file
 * already in the library that a skip pattern now matches is still there, and
 * must not be called missing. The rules only decide what is NEW.
 *
 * Rows recorded with forward slashes (C:/Media/a.jpg) live outside the
 * backslash range; a second, short pass looks each of those up on disk.
 */

const fsp = require('fs').promises;
const path = require('path');
const rules = require('./rules');

const PAGE = 2000;
const YIELD_EVERY = 400;
const HASH_BACKFILL_MAX = 2000;       // rows per walk queued for a fingerprint
const yieldNow = () => new Promise(resolve => setImmediate(resolve));
const WIN = process.platform === 'win32';

/** The sort key SQLite's ORDER BY filepath (COLLATE NOCASE on Windows) uses. */
function keyOf(p) {
  return Buffer.from(WIN ? String(p).replace(/[A-Z]/g, c => c.toLowerCase()) : String(p), 'utf8');
}
const startsWith = (buf, prefix) => buf.length >= prefix.length && buf.compare(prefix, 0, prefix.length, 0, prefix.length) === 0;

/**
 * Walk `start` depth-first in key order, yielding:
 *   { kind: 'file', path }        a regular file
 *   { kind: 'keep', path }        something there that is not followed (a link)
 *   { kind: 'skip', prefix }      a folder whose contents are not looked at
 *                                 (no subfolders, unreadable, or a link)
 */
async function* walkSorted(start, { fs, includeSubfolders, cancelled }) {
  const sep = path.sep;
  let sinceYield = 0;
  const readDir = async (dir) => {
    const handle = await fs.opendir(dir);
    const items = [];
    for await (const ent of handle) {
      if (++sinceYield >= YIELD_EVERY) { sinceYield = 0; await yieldNow(); if (cancelled()) return null; }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) items.push({ k: keyOf(ent.name + sep), kind: 'dir', path: full });
      else if (ent.isFile()) items.push({ k: keyOf(ent.name), kind: 'file', path: full });
      else {
        items.push({ k: keyOf(ent.name), kind: 'keep', path: full });
        items.push({ k: keyOf(ent.name + sep), kind: 'skip', prefix: full + sep });
      }
    }
    items.sort((a, b) => a.k.compare(b.k));
    return items;
  };
  const top = await readDir(start);       // throws: the caller reports it
  if (!top) return;
  const stack = [{ items: top, i: 0 }];
  while (stack.length) {
    const fr = stack[stack.length - 1];
    if (fr.i >= fr.items.length) { stack.pop(); continue; }
    const it = fr.items[fr.i++];
    if (it.kind !== 'dir') { yield it; continue; }
    if (!includeSubfolders) { yield { kind: 'skip', prefix: it.path + sep }; continue; }
    let items;
    try { items = await readDir(it.path); } catch { yield { kind: 'skip', prefix: it.path + sep }; continue; }
    if (!items) return;
    stack.push({ items, i: 0 });
  }
}

/**
 * @param {object} folder        normalized folder (store.rowToFolder)
 * @param {object} deps
 * @param {Function} deps.rowsUnder   (root, after, limit, sep?) -> rows (store.rowsUnder)
 * @param {object}  [deps.fs]         { opendir, stat } (fs.promises shape), for tests
 * @param {Function}[deps.cancelled]  () -> true to stop at the next yield
 * @param {Function}[deps.progress]   ({ seen, phase }) progress callback
 * @param {string}  [deps.root]       walk only this subtree (a folder that appeared)
 * @returns {Promise<{error?, cancelled?, seen, newFiles, changed, back, gone, backfill, recase, needHash}>}
 */
async function catchUp(folder, deps) {
  const fs = deps.fs || fsp;
  const cancelled = deps.cancelled || (() => false);
  const progress = deps.progress || (() => {});
  const top = folder.path;
  const start = deps.root || top;
  const skip = rules.compileSkip(folder.skipPatterns);
  const out = { seen: 0, newFiles: [], changed: [], back: [], gone: [], backfill: [], recase: [], needHash: [] };

  // The root has to be readable, or nothing below it can be judged.
  try {
    const st = await fs.stat(start);
    if (!st.isDirectory()) return { ...out, error: 'ENOTDIR' };
  } catch (err) {
    return { ...out, error: err.code || 'EIO' };
  }

  // Library side: a paged, sorted stream.
  let page = [];
  let pi = 0;
  let after = null;
  let exhausted = false;
  const peek = async () => {
    if (pi < page.length) return page[pi];
    if (exhausted) return null;
    if (after) await yieldNow();
    if (cancelled()) return null;
    page = deps.rowsUnder(start, after, PAGE);
    pi = 0;
    if (page.length < PAGE) exhausted = true;
    if (!page.length) return null;
    after = page[page.length - 1];
    for (const r of page) r._k = keyOf(r.filepath);
    return page[0];
  };
  const take = () => page[pi++];
  // Rows deeper down are nobody's when the folder does not watch subfolders.
  const ownRow = (r) => folder.includeSubfolders || !path.relative(top, r.filepath).includes(path.sep);
  const gone = (r) => {
    if (r.missing_since == null && ownRow(r)) {
      out.gone.push({ id: r.id, path: r.filepath, size: r.filesize_bytes, mtimeMs: r.file_mtime_ms, hash: r.quick_hash || null });
    }
  };

  let sinceYield = 0;
  try {
    for await (const ev of walkSorted(start, { fs, includeSubfolders: folder.includeSubfolders, cancelled })) {
      if (++sinceYield >= YIELD_EVERY) {
        sinceYield = 0;
        progress({ seen: out.seen, phase: 'walk' });
        await yieldNow();
      }
      if (cancelled()) return { ...out, cancelled: true };
      if (ev.kind === 'skip') {
        const p = keyOf(ev.prefix);
        for (let r = await peek(); r && r._k.compare(p) < 0; r = await peek()) gone(take());
        for (let r = await peek(); r && startsWith(r._k, p); r = await peek()) take();   // left as they are
        continue;
      }
      const k = keyOf(ev.path);
      for (let r = await peek(); r && r._k.compare(k) < 0; r = await peek()) gone(take());
      const matched = [];
      for (let r = await peek(); r && r._k.compare(k) === 0; r = await peek()) matched.push(take());
      if (ev.kind === 'keep') continue;
      out.seen++;
      let st = null;
      try { st = await fs.stat(ev.path); } catch { continue; }   // vanished mid-walk: next time
      const mtimeMs = Math.trunc(st.mtimeMs);
      const row = matched[0];
      if (row) {
        const sizeSame = row.filesize_bytes == null || row.filesize_bytes === st.size;
        // path: where the file is on disk; dbPath: where the row says it is
        // (writes only land while the row still says so; see store.js).
        const item = { id: row.id, path: ev.path, dbPath: row.filepath, size: st.size, mtimeMs, row };
        // Same file, other case below the watched folder (renamed a.jpg ->
        // A.jpg while Vault was closed): the row takes the real case. The
        // folder's own part keeps the row's spelling.
        const tail = ev.path.slice(top.length);
        if (row.filepath.length === ev.path.length && row.filepath.slice(top.length) !== tail) {
          out.recase.push({ id: row.id, oldPath: row.filepath, newPath: row.filepath.slice(0, top.length) + tail, size: st.size, mtimeMs });
          item.dbPath = null;
        }
        if (row.missing_since != null) out.back.push(item);
        if (row.file_mtime_ms == null) {
          // From before Vault recorded modified times: record it, and only
          // call it changed when the size says so.
          if (sizeSame) out.backfill.push(item);
          else out.changed.push(item);
        } else if (!sizeSame || row.file_mtime_ms !== mtimeMs) {
          out.changed.push(item);
        } else if (!row.quick_hash && item.dbPath && out.needHash.length < HASH_BACKFILL_MAX) {
          out.needHash.push({ id: row.id, path: row.filepath, size: st.size });
        }
        continue;
      }
      const ok = rules.accepts(folder, path.relative(top, ev.path), st.size, skip);
      if (ok.ok) out.newFiles.push({ path: ev.path, size: st.size, mtimeMs, type: ok.type });
    }
  } catch (err) {
    // The walk root itself could not be read (or vanished): judge nothing.
    return { ...out, gone: [], error: err.code || 'EIO' };
  }
  if (cancelled()) return { ...out, cancelled: true };
  // What the library knows below the root and the disk no longer has.
  for (let r = await peek(); r; r = await peek()) gone(take());

  // Names that differ only in the case of a letter outside A-Z (ça.jpg in the
  // library, Ça.jpg on disk): NTFS calls them one file, the merge order (SQLite
  // NOCASE) does not meet them. Pair them here, the NTFS way (rules.foldCase).
  if (WIN && out.newFiles.length && out.gone.length) {
    const byFold = new Map();
    for (const n of out.newFiles) if (rules.hasNonAscii(n.path)) byFold.set(rules.foldCase(n.path), n);
    if (byFold.size) {
      const paired = new Set();
      out.gone = out.gone.filter((g) => {
        if (!rules.hasNonAscii(g.path)) return true;
        const n = byFold.get(rules.foldCase(g.path));
        if (!n || paired.has(n)) return true;
        paired.add(n);
        out.recase.push({ id: g.id, oldPath: g.path, newPath: g.path.slice(0, top.length) + n.path.slice(top.length), size: n.size, mtimeMs: n.mtimeMs });
        if (g.size !== n.size || (g.mtimeMs != null && g.mtimeMs !== n.mtimeMs)) {
          out.changed.push({ id: g.id, path: n.path, dbPath: null, size: n.size, mtimeMs: n.mtimeMs });
        }
        return false;
      });
      out.newFiles = out.newFiles.filter(n => !paired.has(n));
    }
  }

  // Rows recorded with forward slashes: look each one up.
  if (WIN) {
    let a = null;
    for (;;) {
      const rows = deps.rowsUnder(start, a, PAGE, '/');
      for (const r of rows) {
        if (r.missing_since != null) continue;
        try { await fs.stat(r.filepath.replace(/\//g, '\\')); } catch { gone(r); }
      }
      if (rows.length < PAGE) break;
      a = rows[rows.length - 1];
      await yieldNow();
      if (cancelled()) return { ...out, cancelled: true };
    }
  }
  progress({ seen: out.seen, phase: 'done' });
  return out;
}

/**
 * How many trailing path parts two paths share, ignoring case:
 * D\a\x.jpg and D2\a\x.jpg share 2 (a\x.jpg), c1.jpg and c2.jpg share 0.
 */
function suffixLen(a, b) {
  const pa = String(a).toLowerCase().split(/[\\/]+/);
  const pb = String(b).toLowerCase().split(/[\\/]+/);
  let n = 0;
  while (n < pa.length && n < pb.length && pa[pa.length - 1 - n] === pb[pb.length - 1 - n]) n++;
  return n;
}

/**
 * Which one of several candidates is `target`'s file? One candidate: that
 * one. Several: the one sharing the most trailing path parts with `target`
 * (same name, then same folder name, ...), only when that best is unique
 * and shares at least the file name. Otherwise null: never a guess.
 */
function pickBest(cands, target, pathOf = (c) => c.path) {
  if (cands.length === 1) return cands[0];
  let best = null;
  let bestLen = 0;
  let tie = false;
  for (const c of cands) {
    const n = suffixLen(pathOf(c), target);
    if (n > bestLen) { best = c; bestLen = n; tie = false; } else if (n === bestLen) tie = true;
  }
  return bestLen >= 1 && !tie ? best : null;
}

/**
 * The move matcher: a file that appears with the same size and modified
 * time as one that disappeared is the same file, moved or renamed. Within a
 * group of identical size + mtime (copies of one file), pairs are made by
 * path: a renamed folder's D\c1.jpg pairs with D2\c1.jpg, and a\x.jpg with
 * a\x.jpg before b\x.jpg. Only unambiguous pairs count (each the other's
 * unique best); the rest stay a delete plus an add, so nothing is ever
 * attached to the wrong file. Week 2 adds a content fingerprint.
 * @param {Array<{id, path, size, mtimeMs}>} gone  rows that disappeared
 * @param {Array<{path, size, mtimeMs}>} found      files that appeared
 * @returns {{moves: Array<{id, oldPath, newPath, size, mtimeMs}>, gone: Array, found: Array}}
 */
function matchMoves(gone, found) {
  const key = (size, mtime) => `${size}:${Math.trunc(mtime)}`;
  const goneBy = new Map();
  for (const g of gone) {
    if (!(g.size > 0) || g.mtimeMs == null) continue;
    const k = key(g.size, g.mtimeMs);
    if (!goneBy.has(k)) goneBy.set(k, []);
    goneBy.get(k).push(g);
  }
  const foundBy = new Map();
  for (const f of found) {
    const k = key(f.size, f.mtimeMs);
    if (!foundBy.has(k)) foundBy.set(k, []);
    foundBy.get(k).push(f);
  }
  const moves = [];
  const usedGone = new Set();
  const usedFound = new Set();
  const pair = (g, f) => {
    moves.push({ id: g.id, oldPath: g.path, newPath: f.path, size: f.size, mtimeMs: f.mtimeMs });
    usedGone.add(g);
    usedFound.add(f);
  };
  for (const [k, gsAll] of goneBy) {
    const fsAll = foundBy.get(k);
    if (!fsAll) continue;
    let gs = gsAll.slice();
    let fs = fsAll.slice();
    for (;;) {
      if (gs.length === 1 && fs.length === 1) { pair(gs[0], fs[0]); break; }
      let progress = false;
      for (const g of gs) {
        const f = pickBest(fs, g.path);
        if (!f || pickBest(gs, f.path) !== g) continue;   // must be mutual
        pair(g, f);
        progress = true;
      }
      gs = gs.filter(g => !usedGone.has(g));
      fs = fs.filter(f => !usedFound.has(f));
      if (!progress || !gs.length || !fs.length) break;
    }
  }
  return {
    moves,
    gone: gone.filter(g => !usedGone.has(g)),
    found: found.filter(f => !usedFound.has(f)),
  };
}

module.exports = { catchUp, walkSorted, keyOf, matchMoves, pickBest, suffixLen, PAGE, YIELD_EVERY };
