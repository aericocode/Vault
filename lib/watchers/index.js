/**
 * Folder watchers: the one manager the server runs, wired to the real
 * library, disk, import queue and vault lock, plus the operations behind
 * the /api/watch routes (server/watch-routes.js).
 *
 * Two install-wide switches live in vault-settings.json (lib/app-settings):
 *   watchPaused        Pause all (nothing is watched until Resume)
 *   watchCheckOnStart  "Check for changes when Vault starts" (default on)
 * The folders themselves are per library (the watched_folders table).
 */

const fs = require('fs');
const path = require('path');
const database = require('../database');
const vault = require('../vault');
const appSettings = require('../app-settings');
const rules = require('./rules');
const store = require('./store');
const { WatchManager } = require('./manager');

let _mgr = null;
let _migrating = () => false;
let _onChange = () => {};

const settings = {
  get() {
    const all = appSettings.all();
    return { paused: all.watchPaused === true, checkOnStart: all.watchCheckOnStart !== false };
  },
  set(patch) {
    const out = {};
    if (patch.paused !== undefined) out.watchPaused = !!patch.paused;
    if (patch.checkOnStart !== undefined) out.watchCheckOnStart = !!patch.checkOnStart;
    appSettings.set(out);
    return settings.get();
  },
};

function manager() {
  if (_mgr) return _mgr;
  const importAdd = require('../import-add');
  const importQueue = require('../import-queue');
  _mgr = new WatchManager({
    store,
    settings,
    isLocked: () => vault.isLocked(),
    isMigrating: () => _migrating(),
    addFiles: (paths, opts) => importAdd.addPaths(paths, opts),
    afterAdd: (added, opts) => importAdd.probeAndThumb(added, opts),
    refresh: (ids, opts) => importAdd.refreshFiles(ids, opts),
    enqueueScan: (item) => importQueue.enqueue(item),
    getRow: (id) => database.getById(id),
    version: () => require('../library-index').version(database.get()),
    onChange: () => { try { _onChange(); } catch {} },
  });
  return _mgr;
}

/**
 * Called once by the server after the library is open (or on first unlock).
 * Wires the lock: watchers stop on 'locking', start with a catch-up walk on
 * 'unlocked'.
 */
let _booted = false;
function boot({ migrateProbe, onChange } = {}) {
  if (migrateProbe) _migrating = migrateProbe;
  if (onChange) _onChange = onChange;
  if (_booted) return;
  _booted = true;
  const li = require('../library-index');
  const buildIndexes = () => li.buildWatchIndexes(() => { try { return vault.isLocked() ? null : database.get(); } catch { return null; } })
    .catch(() => {});
  vault.onChange((e) => {
    if (e === 'locking' || e === 'locked') { manager().stop(); _counts.clear(); }
    else if (e === 'unlocked') { manager().start({ catchUpAll: true }); buildIndexes(); }
  });
  if (!vault.isLocked()) {
    // The first walks wait a few seconds: the library should be usable first.
    const t = setTimeout(() => manager().start({ catchUpAll: settings.get().checkOnStart }), 3000);
    if (t.unref) t.unref();
    buildIndexes();
  }
}

/* ── File counts per folder: cached, counted in slices ─────────────────── */

const COUNT_TTL_MS = 5 * 60 * 1000;
const _counts = new Map();      // folder id -> { n, v, at, running }

/**
 * The Settings row's file count. Never counted inside the request: a cached
 * number comes back (null the first time), and a recount runs in the
 * background, in slices (store.countUnder), when the library changed and the
 * last count is a few minutes old, or the folder is new.
 */
function cachedFileCount(f) {
  let v = 0;
  try { v = require('../library-index').version(database.get()); } catch {}
  const c = _counts.get(f.id) || { n: null, v: -1, at: 0, running: false, path: f.path };
  _counts.set(f.id, c);
  const stale = c.n === null || c.path !== f.path || (c.v !== v && Date.now() - c.at >= COUNT_TTL_MS);
  if (stale && !c.running && !vault.isLocked()) {
    c.running = true;
    store.fileCount(f.path, { cancelled: () => vault.isLocked() || !_counts.has(f.id) })
      .then((n) => { if (n !== null) Object.assign(c, { n, v, at: Date.now(), path: f.path }); })
      .catch(() => {})
      .finally(() => { c.running = false; });
  }
  return c.path === f.path ? c.n : null;
}

/* ── Operations for the routes ─────────────────────────────────────────── */

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

/**
 * Check a folder path from the API. Absolute (on Windows: a drive letter or
 * a network share, not a bare \folder), a real folder, no odd characters.
 * Drive roots (C:\) need confirm: watching a whole drive is almost always a
 * mis-pick, and it walks everything on it.
 *
 * The path is stored with the case the folder really has (realpath), so its
 * rows are found however it was typed. A root that is itself a link or a
 * junction is refused, with its real place named: watching through a link
 * would quietly watch somewhere else the day the link is pointed elsewhere,
 * and every file would be recorded under a path that is not where it lives.
 * (Links further down are never followed either; see manager.js.)
 * @returns {string} the resolved path
 */
function validatePath(raw, { confirm = false } = {}) {
  if (typeof raw !== 'string') throw httpError(400, 'Choose a folder.', 'WATCH_BAD_PATH');
  const s = raw.trim();
  if (!s || s.length > 1024 || /[\u0000-\u001f]/.test(s)) throw httpError(400, 'That folder path is not valid.', 'WATCH_BAD_PATH');
  const full = process.platform === 'win32'
    ? /^[A-Za-z]:[\\/]/.test(s) || rules.isNetworkPath(s.replace(/\//g, '\\'))
    : path.isAbsolute(s);
  if (!full) throw httpError(400, 'Use a full folder path with its drive, like D:\\Media.', 'WATCH_BAD_PATH');
  let p = path.resolve(s);
  let lst;
  try { lst = fs.lstatSync(p); } catch { throw httpError(404, 'That folder was not found.', 'WATCH_NOT_FOUND'); }
  if (lst.isSymbolicLink()) {
    let real = '';
    try { real = fs.realpathSync.native(p); } catch {}
    throw httpError(400, real
      ? `That folder is a shortcut (link) to ${real}. Watch ${real} itself instead.`
      : 'That folder is a shortcut (link) to a place that is not there.', 'WATCH_LINK');
  }
  if (!lst.isDirectory()) throw httpError(400, 'That is a file, not a folder.', 'WATCH_NOT_DIR');
  // The real case (D:\media typed, D:\Media on disk). Only a case fix: a
  // different path means a link or a mapped drive above it, which is kept as
  // the user gave it, since that is how their files are recorded.
  try {
    const real = fs.realpathSync.native(p);
    if (rules.pathKey(real) === rules.pathKey(p)) p = real;
  } catch {}
  if (rules.isDriveRoot(p) && !confirm) {
    throw httpError(409, `Watch all of ${p}? Vault would look at every file on the drive.`, 'WATCH_CONFIRM_ROOT');
  }
  return p;
}

/** Every folder with its live status and file count (Settings > Library). */
function listWithStatus() {
  const m = manager();
  const folders = store.listFolders();
  return {
    folders: folders.map((f) => {
      let files = null;
      try { files = cachedFileCount(f); } catch {}
      // A stopped manager (paused, locked, never started) still knows the table.
      const live = m.folders.get(f.id) || f;
      return { ...f, files, status: m.statusOf(live) };
    }),
    ...settings.get(),
    types: Object.entries(rules.TYPES).map(([id, t]) => ({ id, label: t.label, offered: t.offered, sized: t.sized })),
    defaultSkipPatterns: rules.DEFAULT_SKIP_PATTERNS,
  };
}

/**
 * Watch a folder. A folder inside one already watched (with subfolders) is
 * refused with the parent named; a folder above ones already watched takes
 * them over (they are removed, their files stay), and the reply lists them.
 */
function addFolder(body = {}) {
  const p = validatePath(body.path, { confirm: body.confirm === true });
  const opts = store.cleanOptions(body);
  const includeSubfolders = opts.includeSubfolders !== false;
  const existing = store.listFolders();
  const n = rules.nesting(p, existing, includeSubfolders);
  if (n.duplicate) throw httpError(409, 'This folder is already watched.', 'WATCH_DUPLICATE');
  if (n.coveredBy) {
    throw httpError(409, `Already watched as part of ${n.coveredBy.path}, which includes its subfolders.`, 'WATCH_COVERED');
  }
  if (!opts.mode) opts.mode = rules.isNetworkPath(p) ? 'timer' : 'live';
  const merged = [];
  database.get().transaction(() => {
    for (const child of n.absorbs) { store.deleteFolder(child.id); merged.push(child.path); }
  })();
  const folder = store.insertFolder(p, opts);
  manager().reload({ catchUpIds: [folder.id] });
  return { folder, merged };
}

function updateFolder(id, body = {}) {
  const f = store.getFolder(id);
  if (!f) throw httpError(404, 'That folder is not watched.', 'WATCH_NO_FOLDER');
  const clean = store.cleanOptions(body);
  if (clean.includeSubfolders === true && !f.includeSubfolders) {
    // Turning subfolders on can swallow other watched folders below it.
    const others = store.listFolders().filter(o => o.id !== id);
    const n = rules.nesting(f.path, others, true);
    if (n.absorbs.length) database.get().transaction(() => { for (const c of n.absorbs) store.deleteFolder(c.id); })();
  }
  const folder = store.updateFolder(id, clean);
  // Rules that let more in, or a new mode, deserve a fresh look.
  manager().reload({ catchUpIds: folder.enabled ? [id] : [] });
  return { folder };
}

function removeFolder(id) {
  if (!store.deleteFolder(id)) throw httpError(404, 'That folder is not watched.', 'WATCH_NO_FOLDER');
  _counts.delete(id);
  manager().reload();
  return { ok: true };
}

function checkNow(id) {
  const f = store.getFolder(id);
  if (!f) throw httpError(404, 'That folder is not watched.', 'WATCH_NO_FOLDER');
  manager().checkNow(id);
  return { ok: true };
}

module.exports = {
  manager, boot, settings, validatePath, listWithStatus, addFolder, updateFolder, removeFolder, checkNow,
  _resetForTest: () => { if (_mgr) _mgr.stop(); _mgr = null; },
};
