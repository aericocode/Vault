/**
 * Import a playlist as a collection (PLAYLISTS_SPEC, build step 3).
 *
 * The playlist comes from VLC or PotPlayer (lib/playlist/parse.js reads it).
 * Each entry is matched against the library, first hit wins:
 *   1. exact      the path as written is a library row
 *   2. normalised the same path once slashes, a \\?\ prefix, "." / "..",
 *                 the drive letter's case and the NTFS case fold are evened
 *                 out (foldCase: é/É meet, ß/ẞ stay apart)
 *   3. relative   a relative entry, from the playlist file's folder, then 1-2
 *   4. disk       the file is there but not in the library (Add and scan)
 *   5. missing    not found (Find in folder can look for it by name)
 * A trashed row is not in the library as far as a collection goes: the entry
 * is left out and the review says it is in Vault's trash. A row whose file is
 * offline (missing_since set) is in the library and goes in; the review
 * counts them.
 *
 * Big libraries (2M rows) and big playlists (20,000 entries): every lookup is
 * a batch of up to BATCH paths on an index (idx_media_filepath, and
 * idx_media_filepath_nocase for case variants when it has been built), the
 * work yields to the event loop between batches, and disk checks run a few at
 * a time. Nothing walks the media table.
 *
 * State, all in memory (a restart drops it):
 *   sessions  one per playlist opened and not imported yet: the matched
 *             entries, until commit or SESSION_TTL_MS
 *   imports   one per import done: what Undo takes back, and the pending
 *             files from "Add and scan" that go into the collection at their
 *             playlist position as soon as add-paths makes their rows
 *             (onRowsAdded, called by lib/import-add.js)
 *
 * Errors carry a `code` for the route (NOT_FOUND, BAD_TARGET, NAME_TAKEN,
 * BAD_FILE, TOO_BIG, BUSY, BAD_CHOICE, LOCKED).
 *
 * Paths on another computer (\\server\share, file://server/share) are not
 * opened unless the library already has files on that server or the playlist
 * sits there: opening one would make Windows sign in to that server.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../database');
const { foldCase } = require('../watchers/rules');
const { parsePlaylist, createParser, EXTENSIONS } = require('./parse');

const WIN = process.platform === 'win32';
const BATCH = 400;                       // paths per IN (...) lookup (SQLite allows 32766 params)
const STAT_CONCURRENCY = 12;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const IMPORT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 4;
const MAX_IMPORTS = 50;                   // imports kept for Undo and pending files
const WORKER_MIN_BYTES = 512 * 1024;     // bigger playlist files are read in a worker thread
const WORKER_MAX_MS = 60 * 1000;
const WALK_MAX_ENTRIES = 2000000;        // Find in folder: stop after this many directory entries
const WALK_MAX_MS = 120 * 1000;
const WALK_SKIP_DIRS = new Set(['$RECYCLE.BIN', 'SYSTEM VOLUME INFORMATION', '$WINREAGENT', 'WINDOWS']);

function importErr(message, code) {
  return Object.assign(new Error(message), { code });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/* ── Paths ──────────────────────────────────────────────────────────────── */

/** Absolute in this OS's sense (drive or UNC on Windows, "/" elsewhere). */
function isAbsolute(p, win = WIN) {
  if (win) return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return p.startsWith('/');
}

/**
 * The normalised spelling of an absolute path, or null.
 *   \\?\C:\a\..\b.mp4  → C:\b.mp4      \\?\UNC\srv\sh\x → \\srv\sh\x
 *   c:/Media//x.mp4    → C:\Media\x.mp4
 * Windows only folds slashes and case of the drive letter here; the case of
 * the rest is compared through pathKey.
 */
function normalizePath(p, win = WIN) {
  if (typeof p !== 'string' || !p || p.includes('\u0000')) return null;
  if (!win) return p.startsWith('/') ? path.posix.normalize(p).replace(/(.)\/+$/, '$1') : null;
  let s = p;
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(s)) s = '\\\\' + s.slice(8);
  else if (/^[\\/]{2}[?.][\\/][A-Za-z]:[\\/]/.test(s)) s = s.slice(4);
  else if (/^[\\/]{2}[?.][\\/]/.test(s)) return null;        // \\?\Volume{...}, device paths
  s = s.replace(/\//g, '\\');
  if (!isAbsolute(s, true)) return null;
  s = path.win32.normalize(s);
  if (/^[a-z]:/.test(s)) s = s[0].toUpperCase() + s.slice(1);
  if (s.length > 3) s = s.replace(/\\+$/, '');
  return s;
}

/** Comparison key: NTFS case fold on Windows. */
const pathKey = (p, win = WIN) => (win ? foldCase(p) : p);

/** The same path spelled with forward slashes (some older rows are). */
const slashed = (p) => (WIN && p.includes('\\') ? p.replace(/\\/g, '/') : null);

/** "D:\a\b.mp4" → "b.mp4" (either separator). */
const fileNameOf = (p) => String(p).split(/[\\/]/).pop() || '';

/* ── Indexed lookups ────────────────────────────────────────────────────── */

const ROW_COLS = 'id, filepath, filename, media_type, filesize_bytes, user_trashed, missing_since';
const NOCASE_INDEX = 'idx_media_filepath_nocase';
const TYPE_SIZE_INDEX = 'idx_media_type_size';
const TRASH_INDEX = 'idx_media_trash_origin';
const NC = WIN ? ' COLLATE NOCASE' : '';
const SIZE_TYPES = ['video', 'image', 'gif', 'audio', 'document'];

function hasIndex(name) {
  return !!db.get().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
}

/** Prepared once per connection and size (a lock and unlock is a new connection). */
const _stmts = new WeakMap();
function stmt(sql) {
  const conn = db.get();
  let m = _stmts.get(conn);
  if (!m) { m = new Map(); _stmts.set(conn, m); }
  let s = m.get(sql);
  if (!s) { s = conn.prepare(sql); m.set(sql, s); }
  return s;
}

/** Counts queries, for the tests (each batch is one). */
let _queryCount = 0;

function inList(n) { return new Array(n).fill('?').join(','); }

/**
 * Rows at exactly these paths. @returns {Map<string, object>} path → row
 * (one IN (...) on idx_media_filepath per BATCH paths).
 */
async function rowsByPath(paths) {
  const out = new Map();
  const list = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    _queryCount++;
    for (const r of stmt(`SELECT ${ROW_COLS} FROM media WHERE filepath IN (${inList(chunk.length)})`).all(...chunk)) {
      out.set(r.filepath, r);
    }
    if (i + BATCH < list.length) await tick();
  }
  return out;
}

/**
 * Rows at these paths in any case (Windows), matched on the NTFS fold.
 * NOCASE (A-Z only) narrows on idx_media_filepath_nocase; foldCase then
 * decides. Without that index (a big library before its background build)
 * this finds nothing rather than walk the table.
 * @returns {Map<string, object[]>} pathKey → rows
 */
async function rowsByPathAnyCase(paths) {
  const out = new Map();
  if (!WIN || !hasIndex(NOCASE_INDEX)) return out;
  const list = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    _queryCount++;
    const rows = stmt(`SELECT ${ROW_COLS} FROM media WHERE filepath COLLATE NOCASE IN (${inList(chunk.length)})`).all(...chunk);
    for (const r of rows) {
      const k = pathKey(normalizePath(r.filepath) || r.filepath);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    if (i + BATCH < list.length) await tick();
  }
  return out;
}

/** Library rows of these exact sizes whose file name folds to one of `names`. */
async function rowsByNameSize(items) {
  const out = new Map();                  // `${size} ${nameKey}` → rows
  if (!items.length || !hasIndex(TYPE_SIZE_INDEX)) return out;
  const want = new Set(items.map((it) => `${it.size} ${pathKey(it.name)}`));
  const sizes = [...new Set(items.map((it) => it.size).filter((n) => Number.isSafeInteger(n) && n > 0))];
  const types = SIZE_TYPES.map(() => '?').join(',');
  for (let i = 0; i < sizes.length; i += BATCH) {
    const chunk = sizes.slice(i, i + BATCH);
    _queryCount++;
    const rows = stmt(`SELECT ${ROW_COLS} FROM media WHERE media_type IN (${types}) AND filesize_bytes IN (${inList(chunk.length)})`)
      .all(...SIZE_TYPES, ...chunk);
    for (const r of rows) {
      const k = `${r.filesize_bytes} ${pathKey(r.filename || fileNameOf(r.filepath))}`;
      if (!want.has(k)) continue;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    if (i + BATCH < sizes.length) await tick();
  }
  return out;
}

/**
 * Trashed rows at these original paths (their file now sits in the trash
 * folder under another name), in batches on idx_media_trash_origin (trashed
 * rows only, keyed by the original path, NOCASE on Windows; built with the
 * folder watchers' indexes, library-index WATCH_INDEXES). Without it (a big
 * library before its background build) this finds nothing rather than read
 * the trash. @returns {Map<string, number>} pathKey → media id
 */
async function trashedByOriginal(paths) {
  const out = new Map();
  if (!paths.length || !hasIndex(TRASH_INDEX)) return out;
  const list = [...new Set(paths.filter(Boolean))];
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    _queryCount++;
    const rows = stmt(`SELECT id, trashed_original_path FROM media
      WHERE user_trashed = 1 AND trashed_original_path${NC} IN (${inList(chunk.length)})`).all(...chunk);
    for (const r of rows) {
      const n = normalizePath(r.trashed_original_path);
      if (n && !out.has(pathKey(n))) out.set(pathKey(n), r.id);
    }
    if (i + BATCH < list.length) await tick();
  }
  return out;
}

/** The better of rows that matched one entry: not trashed first, then the oldest. */
function pickRow(rows) {
  if (!rows || !rows.length) return null;
  return [...rows].sort((a, b) => (a.user_trashed ? 1 : 0) - (b.user_trashed ? 1 : 0) || a.id - b.id)[0];
}

/* ── Network paths ──────────────────────────────────────────────────────── */

/** The server of a normalised UNC path (\\server\share\...), else null. Windows only. */
function uncHost(p) {
  if (!WIN || typeof p !== 'string') return null;
  const m = /^\\\\([^\\]+)\\/.exec(p);
  return m ? m[1] : null;
}
const hostKey = (h) => foldCase(h);
const MAX_HOSTS_CHECKED = 1000;

/**
 * Which of these servers Vault may look at while reading a playlist: the
 * playlist's own server, and servers the library already has files on. Each
 * is one bounded range read on the path index (\\server\ up to \\server],
 * as ']' is the character after '\', and the forward-slash spelling), in
 * the case written and, when the NOCASE index is built, in any case.
 * @returns {Promise<Set<string>>} hostKey of the allowed servers
 */
async function allowedHosts(hosts, playlistDir) {
  const out = new Set();
  const own = playlistDir && uncHost(normalizePath(playlistDir) || '');
  if (own) out.add(hostKey(own));
  const want = [...new Map(hosts.filter(Boolean).map((h) => [hostKey(h), h])).values()]
    .filter((h) => !out.has(hostKey(h)))
    .slice(0, MAX_HOSTS_CHECKED);
  if (!want.length) return out;
  const nocase = hasIndex(NOCASE_INDEX);
  const exact = stmt('SELECT 1 FROM media WHERE filepath >= ? AND filepath < ? LIMIT 1');
  const anyCase = nocase ? stmt('SELECT 1 FROM media WHERE filepath >= ? COLLATE NOCASE AND filepath < ? COLLATE NOCASE LIMIT 1') : null;
  let n = 0;
  for (const h of want) {
    const ranges = [[`\\\\${h}\\`, `\\\\${h}]`], [`//${h}/`, `//${h}0`]];
    let hit = false;
    for (const [lo, hi] of ranges) {
      _queryCount++;
      if (exact.get(lo, hi) || (anyCase && anyCase.get(lo, hi))) { hit = true; break; }
    }
    if (hit) out.add(hostKey(h));
    if (++n % 200 === 0) await tick();
  }
  return out;
}

/* ── Disk ───────────────────────────────────────────────────────────────── */

async function mapLimit(items, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/** { size, real } for a file that is there, else null. `real`: its true spelling. */
async function statFile(p) {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return null;
    let real = p;
    try { real = await fs.promises.realpath(p); } catch {}
    return { size: st.size, real };
  } catch {
    return null;
  }
}

let _mediaTypeOf = null;
function mediaTypeOf(p) {
  if (!_mediaTypeOf) _mediaTypeOf = require('../import-add').mediaTypeOf;
  return _mediaTypeOf(p);
}

/**
 * The media type a file would be added as, when it is one a playlist plays
 * and the Add window offers (video, pictures, GIFs, audio), else null.
 */
const PLAYABLE = new Set(['video', 'image', 'gif', 'audio']);
function playableType(p) {
  const t = mediaTypeOf(p);
  return PLAYABLE.has(t) ? t : null;
}

/* ── Matching ───────────────────────────────────────────────────────────── */

/** A library result for an entry. */
function libraryHit(r, row, how) {
  if (row.user_trashed) {
    Object.assign(r, { kind: 'trashed', how, mediaId: row.id });
  } else {
    Object.assign(r, {
      kind: 'library', how, mediaId: row.id, filename: row.filename || fileNameOf(row.filepath),
      offline: row.missing_since != null,
    });
  }
}

/**
 * Match parsed entries against the library and the disk.
 * @param {Array<{index, raw, path, url, title}>} entries  from parsePlaylist
 * @param {{playlistDir: string|null}} opts
 * @returns {Promise<object[]>} one result per entry, by index:
 *   { index, raw, title, kind, how?, mediaId?, filename?, offline?, diskPath?, size?, reason? }
 *   kind: library | disk | missing | network (a server not looked at) | trashed | unsupported | skipped
 */
async function matchEntries(entries, { playlistDir = null } = {}) {
  const results = entries.map((e) => ({ index: e.index, raw: e.raw, title: e.title || null }));
  const open = [];                        // entries still looking: { r, want, how }
  for (const e of entries) {
    const r = results[e.index];
    if (!e.path) { Object.assign(r, { kind: 'skipped', reason: e.url ? (/^https?:/i.test(e.url) ? 'web' : 'link') : 'bad' }); continue; }
    r.path = e.path;
    if (isAbsolute(e.path) || (WIN && /^[\\/]{2}[?.][\\/]/.test(e.path))) {
      open.push({ r, raw: e.path, want: normalizePath(e.path), how: 'normalised' });
    } else {
      const base = playlistDir ? (WIN ? path.win32.join(playlistDir, e.path.replace(/\//g, '\\')) : path.posix.join(playlistDir, e.path)) : null;
      open.push({ r, raw: null, want: base ? normalizePath(base) : null, how: 'relative' });
    }
  }

  // 1. Exact.
  const exact = await rowsByPath(open.filter((o) => o.raw).map((o) => o.raw));
  for (const o of open) if (o.raw && exact.has(o.raw)) libraryHit(o.r, exact.get(o.raw), 'exact');

  // 2 and 3. The normalised spelling (and its forward-slash form), then any case.
  let left = open.filter((o) => !o.r.kind && o.want);
  const spellings = left.flatMap((o) => [o.want, slashed(o.want)]);
  const same = await rowsByPath(spellings);
  for (const o of left) {
    const row = same.get(o.want) || same.get(slashed(o.want));
    if (row) libraryHit(o.r, row, o.how);
  }
  left = left.filter((o) => !o.r.kind);
  const anyCase = await rowsByPathAnyCase(left.flatMap((o) => [o.want, slashed(o.want)]));
  for (const o of left) {
    const row = pickRow(anyCase.get(pathKey(o.want)));
    if (row) libraryHit(o.r, row, o.how);
  }

  // A file Vault moved to its trash no longer sits at the playlist's path.
  left = left.filter((o) => !o.r.kind);
  const trash = await trashedByOriginal(left.flatMap((o) => [o.want, slashed(o.want)]));
  for (const o of left) {
    const id = trash.get(pathKey(o.want));
    if (id) Object.assign(o.r, { kind: 'trashed', how: o.how, mediaId: id });
  }

  // A path on another computer (\\server\share\..., file://server/...) is
  // never opened while reading a playlist: looking at it would make Windows
  // connect to that server and offer it the user's sign-in (NTLM). Only
  // servers the library already has files on, or the one the playlist itself
  // is on, are looked at. The rest are listed as not checked; Find in folder
  // can still find them by name in a folder the user picks.
  left = left.filter((o) => !o.r.kind);
  const allowed = await allowedHosts(left.map((o) => uncHost(o.want)), playlistDir);
  for (const o of left) {
    const host = uncHost(o.want);
    if (host && !allowed.has(hostKey(host))) Object.assign(o.r, { kind: 'network', host });
  }

  // 4. On disk? Its true spelling (realpath) can still name a library row:
  // a case difference outside A-Z (é / É) that NOCASE does not see.
  left = left.filter((o) => !o.r.kind);
  const onDisk = [];
  await mapLimit(left, STAT_CONCURRENCY, async (o) => {
    const st = await statFile(o.want);
    if (st) onDisk.push({ o, st });
  });
  const reals = await rowsByPath(onDisk.map(({ st }) => st.real).filter((p, i) => p !== onDisk[i].o.want));
  for (const { o, st } of onDisk) {
    const row = reals.get(st.real);
    if (row) { libraryHit(o.r, row, o.how); continue; }
    // Add the file with its true spelling when only the case differs.
    const real = normalizePath(st.real) || o.want;
    const addPath = pathKey(real) === pathKey(o.want) ? real : o.want;
    const type = playableType(addPath);
    if (!type) { Object.assign(o.r, { kind: 'unsupported', diskPath: addPath }); continue; }
    Object.assign(o.r, { kind: 'disk', how: o.how, diskPath: addPath, size: st.size, mediaType: type });
  }

  // 5. Not found.
  for (const o of open) if (!o.r.kind) Object.assign(o.r, { kind: 'missing', resolved: o.want || null });
  return results;
}

/* ── Find in folder ─────────────────────────────────────────────────────── */

/**
 * Walk `root` for files whose names fold to one of `wanted` (pathKey of the
 * name). Async (one directory read at a time), bounded by WALK_MAX_ENTRIES
 * and WALK_MAX_MS. @returns {{ found: Map<string, string[]>, truncated }}
 */
async function walkForNames(root, wanted, { maxEntries = WALK_MAX_ENTRIES, maxMs = WALK_MAX_MS } = {}) {
  const found = new Map();
  const started = Date.now();
  let seen = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length) {
    if (seen >= maxEntries || Date.now() - started > maxMs) { truncated = true; break; }
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      seen++;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(ent.name.toUpperCase())) stack.push(full);
      } else if (ent.isFile()) {
        const k = pathKey(ent.name);
        if (wanted.has(k)) {
          if (!found.has(k)) found.set(k, []);
          found.get(k).push(full);
        }
      }
    }
  }
  return { found, truncated };
}

/**
 * Look for the session's missing entries under `folder`, by file name. Each
 * file found is checked against the library: its own path first, then a row
 * with the same name and size elsewhere. One outcome resolves the entry;
 * several (two copies on disk, or two library rows) leave it for the user to
 * pick (choose()).
 */
async function findInFolder(sessionId, folder) {
  const s = useSession(sessionId);
  if (s.busy) throw importErr('This playlist is still being read.', 'BUSY');
  s.busy = true;
  try {
    const epoch = lockEpoch;
    const missing = s.results.filter((r) => r.kind === 'missing' || r.kind === 'network' || (r.kind === 'ambiguous' && !r.chosen));
    const wanted = new Map();             // name key → results
    for (const r of missing) {
      const name = fileNameOf(r.path || '');
      if (!name) continue;
      const k = pathKey(name);
      if (!wanted.has(k)) wanted.set(k, []);
      wanted.get(k).push(r);
    }
    const { found, truncated } = await walkForNames(folder, new Set(wanted.keys()));
    if (epoch !== lockEpoch) throw lockedErr();
    const files = [];
    for (const list of found.values()) for (const p of list) files.push(p);
    const stats = new Map();
    await mapLimit(files, STAT_CONCURRENCY, async (p) => {
      const st = await statFile(p);
      if (st) stats.set(p, st.size);
    });
    const present = files.filter((p) => stats.has(p));
    const byPath = await rowsByPath(present.flatMap((p) => [p, slashed(p)]));
    const unseen = present.filter((p) => !byPath.has(p) && !byPath.has(slashed(p)));
    const byCase = await rowsByPathAnyCase(unseen);
    const byNameSize = await rowsByNameSize(present.map((p) => ({ name: fileNameOf(p), size: stats.get(p) })));

    let resolved = 0, ambiguous = 0;
    for (const [k, results] of wanted) {
      const paths = (found.get(k) || []).filter((p) => stats.has(p));
      if (!paths.length) continue;
      const options = [];
      const seenIds = new Set();
      for (const p of paths) {
        const size = stats.get(p);
        const own = byPath.get(p) || byPath.get(slashed(p)) || pickRow(byCase.get(pathKey(p)));
        const rows = own ? [own] : (byNameSize.get(`${size} ${pathKey(fileNameOf(p))}`) || []);
        const live = rows.filter((r) => !r.user_trashed);
        if (live.length) {
          for (const row of live) {
            if (seenIds.has(row.id)) continue;
            seenIds.add(row.id);
            options.push({ kind: 'library', mediaId: row.id, filename: row.filename || fileNameOf(row.filepath),
              path: row.filepath, foundPath: p, size, offline: row.missing_since != null });
          }
        } else if (playableType(p)) {
          options.push({ kind: 'disk', path: p, size, mediaType: playableType(p) });
        }
      }
      if (!options.length) continue;
      for (const r of results) {
        if (options.length === 1) { applyOption(r, options[0]); resolved++; }
        else { Object.assign(r, { kind: 'ambiguous', options, chosen: null }); ambiguous++; }
      }
    }
    s.lastFind = { folder, resolved, ambiguous, truncated };
    return { resolved, ambiguous, truncated };
  } finally {
    s.busy = false;
  }
}

function applyOption(r, opt) {
  delete r.options;
  r.how = 'folder';
  if (opt.kind === 'library') {
    Object.assign(r, { kind: 'library', mediaId: opt.mediaId, filename: opt.filename, offline: !!opt.offline });
  } else {
    Object.assign(r, { kind: 'disk', diskPath: opt.path, size: opt.size, mediaType: opt.mediaType });
  }
}

/** Settle an ambiguous entry: `pick` is an option's number, or null to leave it out. */
function choose(sessionId, index, pick) {
  const s = useSession(sessionId);
  if (s.busy) throw importErr('Vault is still looking in the folder. Try again when it is done.', 'BUSY');
  const r = s.results[index];
  if (!r || r.kind !== 'ambiguous') throw importErr('That entry has nothing to choose.', 'BAD_CHOICE');
  if (pick === null) {
    Object.assign(r, { kind: 'missing', chosen: 'skip' });
    delete r.options;
    return;
  }
  if (!Number.isInteger(pick) || pick < 0 || pick >= r.options.length) throw importErr('Pick one of the files offered.', 'BAD_CHOICE');
  applyOption(r, r.options[pick]);
  r.chosen = 'picked';
}

/* ── Sessions ───────────────────────────────────────────────────────────── */

const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touchedAt > SESSION_TTL_MS) sessions.delete(id);
  for (const [id, im] of imports) if (now > im.expiresAt) imports.delete(id);
}

function useSession(id) {
  sweep();
  const s = typeof id === 'string' ? sessions.get(id) : null;
  if (!s) throw importErr('This playlist is no longer open. Open it again.', 'NOT_FOUND');
  s.touchedAt = Date.now();
  return s;
}

/** Is this a playlist file by its name? */
const playlistExt = (p) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(p));
  return m && EXTENSIONS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
};

/**
 * parsePlaylist in a worker thread, for big files: reading stays off the
 * server's event loop. The worker's source is the parser itself
 * (createParser needs no require), so it runs the same in the single-file
 * app build. Stopped after WORKER_MAX_MS.
 */
function parseInWorker(bytes, fileName) {
  const { Worker } = require('worker_threads');
  const src = `const { parentPort, workerData } = require('worker_threads');
const parser = (${createParser.toString()})();
parentPort.postMessage(parser.parsePlaylist(Buffer.from(workerData.bytes), { fileName: workerData.fileName }));`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const w = new Worker(src, { eval: true, workerData: { bytes, fileName } });
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      w.terminate().catch(() => {});
      finish(reject, importErr('That playlist file took too long to read.', 'TOO_BIG'));
    }, WORKER_MAX_MS);
    w.once('message', (out) => { finish(resolve, out); w.terminate().catch(() => {}); });
    w.once('error', (err) => finish(reject, importErr(`The playlist file could not be read (${err.message}).`, 'BAD_FILE')));
    w.once('exit', () => finish(reject, importErr('The playlist file could not be read.', 'BAD_FILE')));
  });
}

/**
 * Read, parse and match one playlist file the user picked (or dropped).
 * @returns {Promise<object>} the review (review())
 */
async function openPlaylist(filePath) {
  if (!playlistExt(filePath)) throw importErr('That is not a playlist file Vault can read (.m3u, .m3u8, .xspf, .pls, .dpl).', 'BAD_FILE');
  let st;
  try { st = await fs.promises.stat(filePath); } catch { throw importErr('The playlist file could not be found.', 'BAD_FILE'); }
  if (!st.isFile()) throw importErr('That is not a file.', 'BAD_FILE');
  if (st.size > MAX_FILE_BYTES) throw importErr('That playlist file is too big to read (over 32 MB).', 'TOO_BIG');
  let bytes;
  try { bytes = await fs.promises.readFile(filePath); } catch (err) {
    throw importErr(`The playlist file could not be read (${err.code || 'error'}).`, 'BAD_FILE');
  }
  const epoch = lockEpoch;
  const fileName = path.basename(filePath);
  const parsed = bytes.length > WORKER_MIN_BYTES
    ? await parseInWorker(bytes, fileName)
    : parsePlaylist(bytes, { fileName });
  const playlistDir = path.dirname(filePath);
  const results = await matchEntries(parsed.entries, { playlistDir });
  // Locked while this ran: the review would list paths, and the lock has
  // already dropped every open playlist.
  if (epoch !== lockEpoch) throw lockedErr();
  sweep();
  while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  const s = {
    id: crypto.randomUUID(),
    touchedAt: Date.now(),
    playlistPath: filePath,
    fileName,
    name: parsed.name,
    format: parsed.format,
    encoding: parsed.encoding,
    truncated: parsed.truncated,
    results,
    busy: false,
  };
  sessions.set(s.id, s);
  return review(s.id);
}

/** Library results in playlist order, each media id once (the first wins). */
function orderedIds(s) {
  const ids = [];
  const seen = new Set();
  let duplicates = 0;
  for (const r of s.results) {
    if (r.kind !== 'library') continue;
    if (seen.has(r.mediaId)) { duplicates++; continue; }
    seen.add(r.mediaId);
    ids.push(r.mediaId);
  }
  return { ids, duplicates, seen };
}

/** Disk results in playlist order, each file once. */
function diskFiles(s) {
  const out = [];
  const seen = new Set();
  let duplicates = 0;
  for (const r of s.results) {
    if (r.kind !== 'disk') continue;
    const k = pathKey(r.diskPath);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    out.push(r);
  }
  return { files: out, duplicates };
}

/** What the review window shows. */
function review(sessionId) {
  const s = useSession(sessionId);
  const by = (kind) => s.results.filter((r) => r.kind === kind);
  const lib = orderedIds(s);
  const disk = diskFiles(s);
  const libraryRows = [];
  const firstSeen = new Set();
  for (const r of by('library')) {
    if (firstSeen.has(r.mediaId)) continue;
    firstSeen.add(r.mediaId);
    libraryRows.push({ index: r.index, id: r.mediaId, name: r.filename, title: r.title, how: r.how, offline: !!r.offline });
  }
  return {
    session: s.id,
    name: s.name,
    fileName: s.fileName,
    playlistPath: s.playlistPath,
    format: s.format,
    truncated: s.truncated,
    total: s.results.length,
    duplicates: lib.duplicates + disk.duplicates,
    library: libraryRows,
    offline: libraryRows.filter((r) => r.offline).length,
    disk: disk.files.map((r) => ({ index: r.index, path: r.diskPath, name: fileNameOf(r.diskPath), size: r.size, mediaType: r.mediaType })),
    missing: by('missing').map((r) => ({ index: r.index, raw: r.raw, path: r.path || null, skippedByUser: r.chosen === 'skip' })),
    ambiguous: by('ambiguous').map((r) => ({
      index: r.index, raw: r.raw,
      options: r.options.map((o) => (o.kind === 'library'
        ? { kind: 'library', id: o.mediaId, name: o.filename, path: o.path, foundPath: o.foundPath }
        : { kind: 'disk', path: o.path, size: o.size })),
    })),
    trashed: by('trashed').map((r) => ({ index: r.index, raw: r.raw })),
    network: by('network').map((r) => ({ index: r.index, raw: r.raw, host: r.host })),
    unsupported: by('unsupported').map((r) => ({ index: r.index, raw: r.raw })),
    skipped: by('skipped').map((r) => ({ index: r.index, raw: r.raw, reason: r.reason })),
    lastFind: s.lastFind || null,
  };
}

/* ── Commit, pending files, Undo ────────────────────────────────────────── */

const imports = new Map();

function collectionRow(id) {
  return db.get().prepare('SELECT id, name, kind, parent_id FROM collections WHERE id = ?').get(id);
}

/** Append ids not in the collection yet, after its last item. @returns {number[]} the ids added */
function appendIds(collectionId, ids) {
  const conn = db.get();
  const max = conn.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM collection_items WHERE collection_id = ?');
  const ins = conn.prepare('INSERT OR IGNORE INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)');
  return conn.transaction(() => {
    let pos = max.get(collectionId).p;
    const added = [];
    for (const id of ids) if (ins.run(collectionId, id, pos + 1).changes) { pos++; added.push(id); }
    return added;
  })();
}

/**
 * Make the collection (or add to one) from the session.
 * @param {string} sessionId
 * @param {{target: 'new'|'existing', name?: string, collectionId?: number, addAndScan?: boolean}} opts
 *   addAndScan: the files on disk are being added through the Add window, so
 *   they go into the collection at their playlist position as their rows are
 *   made (onRowsAdded)
 * @returns {Promise<object>} what the toast and Undo need, and the files for the Add window
 */
async function commit(sessionId, { target, name, collectionId, addAndScan = false } = {}) {
  const s = useSession(sessionId);
  if (s.busy) throw importErr('This playlist is still being read.', 'BUSY');
  s.busy = true;
  try {
    // Files on disk may have been added to the library since the review.
    const diskNow = s.results.filter((r) => r.kind === 'disk');
    if (diskNow.length) {
      const rows = await rowsByPath(diskNow.flatMap((r) => [r.diskPath, slashed(r.diskPath)]));
      const nocase = await rowsByPathAnyCase(diskNow.filter((r) => !rows.has(r.diskPath)).map((r) => r.diskPath));
      for (const r of diskNow) {
        const row = rows.get(r.diskPath) || rows.get(slashed(r.diskPath)) || pickRow(nocase.get(pathKey(r.diskPath)));
        if (row && !row.user_trashed) libraryHit(r, row, r.how);
      }
    }
    const { ids, duplicates } = orderedIds(s);
    const disk = diskFiles(s);

    let coll;
    let created = false;
    if (target === 'new') {
      const nm = typeof name === 'string' ? name.trim() : '';
      if (!nm) throw importErr('Give the collection a name.', 'BAD_TARGET');
      if (nm.length > 200) throw importErr('That name is too long.', 'BAD_TARGET');
      coll = db.createCollection(nm, {});
      created = true;
    } else if (target === 'existing') {
      const id = Number(collectionId);
      coll = Number.isSafeInteger(id) && id > 0 ? collectionRow(id) : null;
      if (!coll) throw importErr('That collection is no longer there.', 'BAD_TARGET');
      if (coll.kind === 'folder') throw importErr('Folders hold collections, not files. Pick a collection.', 'BAD_TARGET');
    } else {
      throw importErr("target must be 'new' or 'existing'", 'BAD_TARGET');
    }

    const added = appendIds(coll.id, ids);
    const tags = new Map();                       // media id → playlist index, for this import's files
    const indexOf = new Map();
    for (const r of s.results) if (r.kind === 'library' && !indexOf.has(r.mediaId)) indexOf.set(r.mediaId, r.index);
    for (const id of added) tags.set(id, indexOf.get(id));

    const pending = new Map();
    if (addAndScan) for (const r of disk.files) pending.set(pathKey(r.diskPath), { index: r.index, path: r.diskPath });

    const im = {
      id: crypto.randomUUID(),
      collectionId: coll.id,
      created,
      addedIds: new Set(added),
      tags,
      pending,
      expiresAt: Date.now() + IMPORT_TTL_MS,
    };
    imports.set(im.id, im);
    while (imports.size > MAX_IMPORTS) imports.delete(imports.keys().next().value);
    sessions.delete(s.id);
    const missing = s.results.filter((r) => r.kind === 'missing' || r.kind === 'ambiguous' || r.kind === 'network').length;
    return {
      importId: im.id,
      collectionId: coll.id,
      name: coll.name,
      created,
      added: added.length,
      alreadyThere: ids.length - added.length,
      duplicates: duplicates + disk.duplicates,
      pending: pending.size,
      missing,
      trashed: s.results.filter((r) => r.kind === 'trashed').length,
      skipped: s.results.filter((r) => r.kind === 'skipped' || r.kind === 'unsupported').length,
      disk: disk.files.map((r) => ({ path: r.diskPath, name: fileNameOf(r.diskPath), size: r.size })),
    };
  } finally {
    s.busy = false;
  }
}

/**
 * Where a file at playlist position `index` goes in `order` (media ids, as
 * the collection is now): before the first file of this import that comes
 * later in the playlist, else right after the last one of this import, else
 * at the end. Files the user moved keep the place they were moved to.
 * @returns {number} the position to insert at
 */
function insertAt(order, tags, index) {
  let lastEarlier = -1;
  for (let i = 0; i < order.length; i++) {
    const t = tags.get(order[i]);
    if (t === undefined) continue;
    if (t > index) return i;
    lastEarlier = i;
  }
  return lastEarlier >= 0 ? lastEarlier + 1 : order.length;
}

/**
 * add-paths (lib/import-add.js) made library rows: any that an import is
 * waiting for go into its collection at their playlist position, positions
 * rewritten 0..n-1 in one transaction per collection.
 * @param {Array<{id:number, row:{filepath:string}}>} added
 * @returns {number} files placed
 */
function onRowsAdded(added) {
  if (!imports.size || !Array.isArray(added) || !added.length) return 0;
  sweep();
  let placed = 0;
  for (const im of imports.values()) {
    if (!im.pending.size) continue;
    const hits = [];
    for (const a of added) {
      const p = a && a.row && a.row.filepath;
      const n = p && normalizePath(p);
      const k = n && pathKey(n);
      const want = k && im.pending.get(k);
      if (want) hits.push({ id: a.id, key: k, index: want.index });
    }
    if (!hits.length) continue;
    hits.sort((x, y) => x.index - y.index);
    const conn = db.get();
    const run = conn.transaction(() => {
      const coll = collectionRow(im.collectionId);
      if (!coll || coll.kind !== 'collection') { im.pending.clear(); return 0; }
      const order = conn.prepare('SELECT media_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at')
        .pluck().all(im.collectionId);
      const members = new Set(order);
      let n = 0;
      for (const h of hits) {
        im.pending.delete(h.key);
        if (members.has(h.id)) continue;
        order.splice(insertAt(order, im.tags, h.index), 0, h.id);
        members.add(h.id);
        im.tags.set(h.id, h.index);
        im.addedIds.add(h.id);
        conn.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)').run(im.collectionId, h.id, -1);
        n++;
      }
      if (n) {
        const setPos = conn.prepare('UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_id = ? AND position IS NOT ?');
        order.forEach((id, i) => setPos.run(i, im.collectionId, id, i));
      }
      return n;
    });
    placed += run();
  }
  return placed;
}

/** Undo an import: the collection it made goes, or the files it added come out. Library rows stay. */
function undo(importId) {
  const im = typeof importId === 'string' ? imports.get(importId) : null;
  if (!im) throw importErr('This import can no longer be undone.', 'NOT_FOUND');
  imports.delete(importId);
  const coll = collectionRow(im.collectionId);
  if (!coll) return { removed: 0, deleted: false };
  if (im.created) {
    const n = db.collectionItemCount(im.collectionId);
    db.deleteCollection(im.collectionId);
    return { removed: n, deleted: true };
  }
  return { removed: db.removeFromCollection(im.collectionId, [...im.addedIds]), deleted: false };
}

/** The review window closed without importing. */
function close(sessionId) { sessions.delete(sessionId); }

/** The vault locked: open playlists are dropped (their review shows paths). */
let lockEpoch = 0;
function clearSessions() { sessions.clear(); lockEpoch++; }
const lockedErr = () => importErr('Vault is locked. Unlock it first.', 'LOCKED');

module.exports = {
  openPlaylist, review, findInFolder, choose, commit, undo, close, onRowsAdded, clearSessions,
  matchEntries, normalizePath, pathKey, insertAt, walkForNames, playlistExt, isAbsolute, parseInWorker,
  MAX_FILE_BYTES,
  _queryCount: () => _queryCount,
  _reset: () => { sessions.clear(); imports.clear(); _queryCount = 0; },
  _imports: imports,
};
