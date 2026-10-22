/**
 * Folder watchers: the manager (WATCHERS_SPEC week 1).
 *
 * One live watch per watched folder tree (Node's built-in recursive fs.watch,
 * which on Windows is ReadDirectoryChangesW: no extra install), a timer walk
 * for "Every N min" folders, and nothing for "Only when I ask". Everything a
 * watch reports goes through the same steps:
 *
 *   1. Coalesce. Raw events land in a map keyed by path; a short debounce
 *      (FLUSH_MS, never longer than FLUSH_MAX_MS) turns a burst into one pass.
 *      A 10,000-file copy is a few passes, not 10,000.
 *   2. Look. Each path is stat'd once per pass (lstat: links and junctions are
 *      never followed, nor are paths under one) and sorted into gone, file or
 *      new folder. An event the OS dropped (buffer overflow, null filename)
 *      queues a catch-up walk of that folder instead. A folder that appeared
 *      (created, or renamed into place) is walked at once, not queued behind
 *      a long walk, so its files pair with the rows that just went.
 *   3. Settle. New and changed files wait in the Settler until their size and
 *      modified time hold steady and the writer lets go (settle.js). The
 *      Settler is keyed without case on Windows, and a new file is added
 *      under the case it really has on disk.
 *   4. Match. A file that disappears waits MOVE_WINDOW_MS (longer while a
 *      walk of a folder that appeared in the same tree is still running). A
 *      file that appears with the same size (and modified time, when the row
 *      has one) in that window is that file, moved or renamed, when it is
 *      provably the same: its quick fingerprint (fingerprint.js) matches the
 *      row's, or, for a row with no fingerprint yet, it kept its file name.
 *      The row is repointed (tags, notes, faces, collections stay); a move
 *      between two watched folders inside the window keeps its row too.
 *      Unmatched, the row is marked Missing: every field is kept. A file that
 *      turns up later in the SAME watched folder takes a Missing row back on
 *      the same proof (fingerprint, or same name when the row has none).
 *      Missing rows are never taken across watched folders.
 *   5. Apply. Writes are batched (APPLY_BATCH per kind per tick, one
 *      transaction each; ROW_BATCH for inserts and moves, whose search-index
 *      triggers cost about 0.2 ms a row). Every write names the path it was
 *      decided for and lands only while the row is still there (a relink in
 *      between makes it a no-op). New files go through lib/import-add.js,
 *      exactly like Add folder, with their fingerprint; "Add only" folders
 *      skip the AI scan queue. Changed files are probed again and get new
 *      thumbnails (lib/import-add.js refreshFiles); their processing error is
 *      cleared.
 *
 * Folder health: every HEALTH_MS each live folder's root is looked at. Gone
 * (deleted, drive pulled; ENOENT or ENOTDIR only): the row says "Folder not
 * found", the dead watch is closed, nothing is marked missing for it, and it
 * is looked for again with growing pauses. Back, or replaced by a new folder
 * of the same name: watched again and walked. A watch that fails for any
 * other reason (EPERM, EBUSY, EMFILE: usually passing) is started again with
 * growing pauses, and walked only once it has stayed up for CONFIRM_MS.
 * Missing marks also wait for one last look at the root, so a whole folder
 * that vanished is never marked missing file by file.
 *
 * Catch-up walks (catchup.js) find what changed while Vault was closed,
 * locked or paused: on start (when "Check for changes when Vault starts" is
 * on), on unlock, on resume, on Check now, and on the timer. One full walk
 * runs at a time, yielding as it goes. Walks also queue fingerprints for rows
 * that have none yet; those are taken a few per tick.
 *
 * Locked library: on 'locking' every watch closes, every timer stops, every
 * queue is dropped and running walks stop at their next yield, so nothing
 * touches the disk or the database while locked. 'unlocked' starts it all
 * again with a catch-up walk, which finds whatever happened meanwhile.
 *
 * A migrate (relink) rewrites paths, so every watcher write waits while one
 * runs (the queued work stays queued).
 *
 * Known limit: a file edited in the second after its folder was renamed no
 * longer matches its old row by size and time; it reads as new, and the old
 * row as Missing (kept). Week 2's content matcher narrows this.
 *
 * Every dependency is injectable; test/watchers.test.js drives the whole
 * thing on fake events and fake time.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const rules = require('./rules');
const { Settler } = require('./settle');
const { catchUp, matchMoves, pickBest } = require('./catchup');
const fingerprint = require('./fingerprint');

/** 'C:' or '\\SERVER\SHARE' for a path (the unit network I/O is limited by). */
function volumeKey(p) {
  const s = String(p).replace(/\//g, '\\');
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(s);
  if (unc) return unc[0].toUpperCase();
  const d = /^[A-Za-z]:/.exec(s);
  return d ? d[0].toUpperCase() : '';
}

const FLUSH_MS = 300;
const FLUSH_MAX_MS = 1500;
const TICK_MS = 500;
const MOVE_WINDOW_MS = 10000;
const HEALTH_MS = 12000;
const CONFIRM_MS = 5000;               // a restarted watch must stay up this long before a walk
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const APPLY_BATCH = 500;
const ROW_BATCH = 25;
const HASH_PER_TICK = 8;
const HASH_QUEUE_MAX = 20000;
const BELOW_MAX = 300000;              // rows below one vanished folder held for matching
const ACTIVITY_MAX = 300;
const COUNTS_TTL_MS = 15000;
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR']);
const yieldNow = () => new Promise(resolve => setImmediate(resolve));
const baseKey = (p) => rules.foldCase(path.basename(String(p)));

/** An error code as words for the Settings row. */
function plainError(code) {
  switch (code) {
    case 'ENOENT': return 'Folder not found. Is the drive connected?';
    case 'EACCES': case 'EPERM': return 'No permission to read this folder.';
    case 'ENOTDIR': return 'This is not a folder.';
    case 'EBUSY': return 'The folder is busy. Vault will try again.';
    case 'EMFILE': return 'Too many files are open right now. Vault will try again.';
    default: return 'Could not read this folder. Vault will try again.';
  }
}

/** A folder's identity: a new folder with the same name is a different one. */
function identity(st) {
  return `${st.dev}:${st.ino}:${Math.trunc(st.birthtimeMs || 0)}`;
}

class WatchManager {
  /**
   * @param {object} d
   * @param {object} d.store        lib/watchers/store.js shape
   * @param {Function} d.isLocked   () -> boolean
   * @param {Function} [d.isMigrating]
   * @param {Function} [d.addFiles]   (paths, {analyse, watchNew, stats}) -> {added}
   * @param {Function} [d.afterAdd]   (added) background probe + thumbnails
   * @param {Function} [d.refresh]    (ids) re-probe + thumbnails for changed files
   * @param {Function} [d.enqueueScan] ({id, filepath, filename, mediaType}) AI scan
   * @param {Function} [d.getRow]     (id) -> media row
   * @param {Function} [d.watch]      fs.watch shape
   * @param {object}   [d.fs]         { lstat, stat, opendir, realpath, open } promises shape
   * @param {Function} [d.hash]       (path, size) -> Promise<hash|null> (fingerprint.quickHash)
   * @param {Function} [d.now]
   * @param {object}   [d.settings]   { get(): {paused, checkOnStart}, set(patch) }
   * @param {Function} [d.version]    () -> library version (caches the counts)
   * @param {Function} [d.onChange]   () called after writes (missing-count cache)
   * @param {object}   [d.settleOpts] Settler options (tests)
   * @param {boolean}  [d.manualTimers] tests drive tick()/flush() themselves
   */
  constructor(d) {
    this.d = d;
    this.store = d.store;
    this.fs = d.fs || fsp;
    this.now = d.now || Date.now;
    this.hashFn = d.hash || ((p, size) => fingerprint.quickHash(p, { size, fs: d.fs && d.fs.open ? d.fs : fsp }));
    // Backfill reads also need the size and time of the copy they read (store.setQuickHash).
    this.hashStatFn = d.hashStat || ((p) => fingerprint.quickHashStat(p, { fs: d.fs && d.fs.open ? d.fs : fsp }));
    this.driveTypes = new Map();   // 'C:' -> Win32_LogicalDisk DriveType (4 = network)
    this._locks = new Map();       // network volume -> tail of its one-at-a-time queue
    this._ticking = false;
    this._backfilling = false;
    this.watchFn = d.watch || ((p, o, cb) => fs.watch(p, o, cb));
    this.settings = d.settings || { get: () => ({ paused: false, checkOnStart: true }), set: () => {} };
    this.folders = new Map();      // id -> folder
    this.live = new Map();         // id -> fs.FSWatcher
    this.timers = new Map();       // id -> interval
    this.retries = new Map();      // id -> timeout (re-arm after a passing error)
    this.errors = new Map();       // id -> plain message
    this.offline = new Set();      // folder ids whose root is not there right now
    this.idents = new Map();       // folder id -> root identity (health check)
    this.backoff = new Map();      // folder id -> { n, until }
    this.confirming = new Map();   // folder id -> { w, at } restarted watch on probation
    this.pending = new Map();      // path -> { folderId, rename }
    this.goneWait = new Map();     // media id -> { id, path, size, mtimeMs, hash, folderId, at }
    this.ops = { add: [], changed: [], back: [], missing: [], moves: [] };
    this.resolveQ = [];            // settled new files waiting for a match / fingerprint
    this.hashQ = [];               // rows waiting for a fingerprint (backfill)
    this.bursts = new Map();       // folderId -> { done, total }
    this.activityLog = [];         // { kind, folderId, n, at }
    this.catchQueue = [];          // { folderId }
    this.scanning = null;          // { folderId, seen }
    this.subWalks = new Map();     // folderId -> walks of appeared subfolders in flight
    this.after = [];               // background work: { kind, ... }
    this.afterRunning = false;
    this.gen = 0;
    this.running = false;
    this._flushTimer = null;
    this._flushFirstAt = 0;
    this._tick = null;
    this._applying = false;
    this._resolving = false;
    this._counts = null;
    this._countsRunning = false;
    this._lastHealth = -Infinity;
    this._healthRunning = false;
    const so = d.settleOpts || {};
    const settleStat = so.stat || ((p) => fsp.stat(p));
    const settleOpen = so.canOpen || require('./settle').canOpen;
    this.settler = new Settler({
      ...so,
      // On a network share, one file operation at a time (see _io).
      stat: (p) => this._io(p, () => settleStat(p)),
      canOpen: (p) => this._io(p, () => settleOpen(p)),
      now: this.now,
      keyOf: (p) => rules.pathKey(p),
      onSettled: (e, st) => this._settled(e, st),
      onGone: (e) => this._burstDrop(e.meta.folderId),
    });
  }

  /**
   * A path on a network share (a UNC path, or a mapped network drive): reads
   * there can hang for a long time when the server goes away.
   */
  _isNetwork(p) {
    const v = volumeKey(p);
    if (v.startsWith('\\')) return true;
    return this.driveTypes.get(v) === 4;
  }

  /**
   * Run one file operation. On a network volume, one at a time per volume: a
   * share that stops answering then holds at most one libuv thread, and every
   * other file operation in the server keeps going (verifier round 3).
   */
  _io(p, fn) {
    if (!this._isNetwork(p)) return fn();
    const k = volumeKey(p);
    const prev = this._locks.get(k) || Promise.resolve();
    const run = prev.then(() => fn());
    this._locks.set(k, run.catch(() => {}));
    return run;
  }

  /** The fs calls a catch-up walk makes, one at a time on a network folder. */
  _walkFs(f) {
    const base = this.d.fs || fsp;
    if (!this._isNetwork(f.path)) return this.d.fs;
    return { stat: (p) => this._io(p, () => base.stat(p)), opendir: (p) => this._io(p, () => base.opendir(p)) };
  }

  isLocked() { try { return !!this.d.isLocked(); } catch { return true; } }
  isMigrating() { try { return !!(this.d.isMigrating && this.d.isMigrating()); } catch { return false; } }
  paused() { return !!this.settings.get().paused; }
  /** Writes wait while locked or while a migrate rewrites paths. */
  _canWrite() { return this.running && !this.isLocked() && !this.isMigrating(); }
  _note(id, fields) { if (this._canWrite()) { try { this.store.noteFolder(id, fields); } catch {} } }

  /* ── Start and stop ─────────────────────────────────────────────────── */

  /**
   * Start every enabled folder. `catchUpAll` queues a walk of each (boot with
   * "check when Vault starts" on, unlock, resume).
   */
  start({ catchUpAll = false } = {}) {
    if (this.running || this.isLocked() || this.paused()) return false;
    let folders;
    try { folders = this.store.listFolders(); } catch (err) {
      console.warn(`[Watch] could not read watched folders: ${err.message}`);
      return false;
    }
    this.running = true;
    this.folders = new Map(folders.map(f => [f.id, f]));
    // Which drive letters are network drives (once, in the background).
    const dt = this.d.driveTypes || (this.d.manualTimers ? null : () => require('../missing-sweep').driveTypes());
    if (dt) Promise.resolve().then(dt).then((m) => { if (m) this.driveTypes = m; }).catch(() => {});
    for (const f of folders) {
      if (!f.enabled) continue;
      this._arm(f);
      if (catchUpAll) this.queueCatchUp(f.id);
    }
    if (!this.d.manualTimers) {
      this._tick = setInterval(() => { this.tick().catch(() => {}); }, TICK_MS);
      if (this._tick.unref) this._tick.unref();
    }
    return true;
  }

  /** Stop everything and drop every queue. Nothing is written after this. */
  stop() {
    this.gen++;
    for (const w of this.live.values()) { try { w.close(); } catch {} }
    this.live.clear();
    for (const t of this.timers.values()) clearInterval(t);
    this.timers.clear();
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
    if (this._tick) clearInterval(this._tick);
    this._tick = null;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this.pending.clear();
    this.goneWait.clear();
    this.settler.clear();
    this.ops = { add: [], changed: [], back: [], missing: [], moves: [] };
    this.resolveQ = [];
    this.hashQ = [];
    this.after = [];
    this.catchQueue = [];
    this.scanning = null;
    this.subWalks.clear();
    this.bursts.clear();
    this.offline.clear();
    this.idents.clear();
    this.backoff.clear();
    this.confirming.clear();
    this.running = false;
  }

  /** The folder list changed (added, edited, removed): re-arm from the table. */
  reload({ catchUpIds = [] } = {}) {
    if (!this.running) {
      this.start();
      if (!this.running) return;
    }
    let folders;
    try { folders = this.store.listFolders(); } catch { return; }
    const next = new Map(folders.map(f => [f.id, f]));
    for (const id of [...this.folders.keys()]) {
      const before = this.folders.get(id);
      const after = next.get(id);
      if (!after || !after.enabled || JSON.stringify(before) !== JSON.stringify(after)) this._disarm(id);
      if (!after || !after.enabled) {
        this.errors.delete(id); this.offline.delete(id); this.idents.delete(id); this.backoff.delete(id);
      }
    }
    const old = this.folders;
    this.folders = next;
    this._counts = null;
    for (const f of folders) {
      if (!f.enabled) continue;
      const prev = old.get(f.id);
      const armed = this.live.has(f.id) || this.timers.has(f.id);
      if (!prev || !armed || JSON.stringify(prev) !== JSON.stringify(f)) this._arm(f);
    }
    for (const id of catchUpIds) this.queueCatchUp(id);
  }

  _arm(f) {
    this._disarm(f.id);
    this.errors.delete(f.id);
    this.offline.delete(f.id);
    if (f.mode === 'live') this._watchLive(f);
    else if (f.mode === 'timer') {
      const t = setInterval(() => this.queueCatchUp(f.id), Math.max(1, f.intervalMin) * 60000);
      if (t.unref) t.unref();
      this.timers.set(f.id, t);
    }
  }

  _disarm(id) {
    const w = this.live.get(id);
    if (w) { try { w.close(); } catch {} this.live.delete(id); }
    const t = this.timers.get(id);
    if (t) { clearInterval(t); this.timers.delete(id); }
    const r = this.retries.get(id);
    if (r) { clearTimeout(r); this.retries.delete(id); }
    this.confirming.delete(id);
  }

  _watchLive(f) {
    const gen = this.gen;
    let w;
    try {
      w = this.watchFn(f.path, { recursive: f.includeSubfolders, persistent: false }, (type, name) => {
        if (gen !== this.gen) return;
        this.onEvent(f.id, type, name);
      });
    } catch (err) {
      this._fail(f, err.code);
      return;
    }
    w.on('error', (err) => {
      if (gen !== this.gen) return;
      try { w.close(); } catch {}
      if (this.live.get(f.id) === w) this.live.delete(f.id);
      this._fail(f, err.code);
    });
    this.live.set(f.id, w);
  }

  /** The next pause before trying a folder again (2 s, 4 s, ... 5 min). */
  _nextBackoff(id) {
    const b = this.backoff.get(id) || { n: 0, until: 0 };
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** b.n);
    b.n++;
    b.until = this.now() + wait;
    this.backoff.set(id, b);
    return wait;
  }

  /**
   * A watch could not start or broke. Gone (ENOENT, ENOTDIR): the folder is
   * offline; the health check looks for it again with growing pauses and
   * nothing is marked missing meanwhile. Anything else is taken as passing:
   * the same folder is watched again after a growing pause, and only walked
   * once the new watch has stayed up (CONFIRM_MS), so a watch that keeps
   * failing never turns into a walk every few seconds.
   */
  _fail(f, code) {
    const msg = plainError(code);
    this.errors.set(f.id, msg);
    this.confirming.delete(f.id);
    this._note(f.id, { lastError: msg });
    const wait = this._nextBackoff(f.id);
    if (GONE_CODES.has(code)) {
      this.offline.add(f.id);
      this._dropGone(f.id);
      return;
    }
    if (this.d.manualTimers) return;            // tests call _retryArm themselves
    const gen = this.gen;
    const old = this.retries.get(f.id);
    if (old) clearTimeout(old);
    const t = setTimeout(() => { this.retries.delete(f.id); if (gen === this.gen) this._retryArm(f.id); }, wait);
    if (t.unref) t.unref();
    this.retries.set(f.id, t);
  }

  /** Start a folder's watch again; walk it once the watch has stayed up. */
  _retryArm(id) {
    if (!this.running) return;
    const cur = this.folders.get(id);
    if (!cur || !cur.enabled) return;
    this._arm(cur);
    const w = this.live.get(id);
    if (w) this.confirming.set(id, { w, at: this.now() });
    else if (cur.mode !== 'live') this.queueCatchUp(id);
  }

  /** A restarted watch that stayed up: clear the error and the pauses, then walk. */
  _confirmArms() {
    const now = this.now();
    for (const [id, c] of [...this.confirming]) {
      if (now - c.at < CONFIRM_MS) continue;
      this.confirming.delete(id);
      if (this.live.get(id) !== c.w) continue;
      this.errors.delete(id);
      this.offline.delete(id);
      this.backoff.delete(id);
      this._note(id, { lastError: null });
      this.queueCatchUp(id);
    }
  }

  /** Forget files waiting to be called missing in a folder that is itself gone. */
  _dropGone(folderId) {
    for (const g of [...this.goneWait.values()]) if (g.folderId === folderId) this.goneWait.delete(g.id);
    this.ops.missing = this.ops.missing.filter(m => m.folderId !== folderId);
  }

  /**
   * Folder health: is each live root still there, and still the same folder?
   * A root that went away is reported and its watch closed; one that came
   * back, or was replaced by a new folder of the same name (whose old watch
   * handle is dead), is watched again (and walked once the watch holds).
   * Offline folders are looked at again on the backoff schedule.
   */
  async _health() {
    if (this._healthRunning) return;
    this._healthRunning = true;
    const gen = this.gen;
    try {
      for (const f of this.folders.values()) {
        if (!f.enabled || f.mode !== 'live') continue;
        const off = this.offline.has(f.id);
        if (off && this.now() < (this.backoff.get(f.id)?.until || 0)) continue;
        if (!off && this.errors.has(f.id)) continue;    // a passing error: its own retry timer
        let st = null;
        try { st = await this._io(f.path, () => this.fs.stat(f.path)); } catch { st = null; }
        if (gen !== this.gen || !this.running || this.isLocked()) return;
        if (!st || (typeof st.isDirectory === 'function' && !st.isDirectory())) {
          if (!off) { this._disarm(f.id); this._fail(f, st ? 'ENOTDIR' : 'ENOENT'); }
          else this._nextBackoff(f.id);
          continue;
        }
        const id = identity(st);
        const known = this.idents.get(f.id);
        if (off || (known && known !== id) || !this.live.has(f.id)) {
          // Back, or a different folder now: a new watch and a walk at once
          // (the folder is there; the walk is what finds what changed).
          this.idents.set(f.id, id);
          this._arm(f);
          if (this.live.has(f.id)) {
            this.backoff.delete(f.id);
            this._note(f.id, { lastError: null });
            this.queueCatchUp(f.id);
          }
          continue;
        }
        if (!known) this.idents.set(f.id, id);
      }
    } finally {
      this._healthRunning = false;
    }
  }

  /* ── 1. Coalesce ────────────────────────────────────────────────────── */

  onEvent(folderId, type, name) {
    if (!this.running || this.isLocked()) return;
    const f = this.folders.get(folderId);
    if (!f) return;
    if (name == null) {               // the OS dropped events: walk instead
      this.queueCatchUp(folderId);
      return;
    }
    const full = path.join(f.path, String(name));
    const prev = this.pending.get(full);
    this.pending.set(full, { folderId, rename: (prev && prev.rename) || type === 'rename' });
    if (this.d.manualTimers) return;
    const now = this.now();
    if (!this._flushTimer) this._flushFirstAt = now;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    const wait = Math.max(0, Math.min(FLUSH_MS, this._flushFirstAt + FLUSH_MAX_MS - now));
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this.flush().catch(() => {}); }, wait);
  }

  /* ── 2. Look ────────────────────────────────────────────────────────── */

  async _lstat(p) {
    try { return await this._io(p, () => this.fs.lstat(p)); } catch { return null; }
  }

  /** The path with the case the file really has (Windows). */
  async _realCase(p) {
    if (typeof this.fs.realpath !== 'function') return p;
    try {
      const real = await this._io(p, () => this.fs.realpath(p));
      // Only a case fix is taken: a different path means a link on the way.
      return rules.pathKey(real) === rules.pathKey(p) ? real : p;
    } catch { return p; }
  }

  /** True when a folder between the watched root and this path is a link or junction. */
  async _underLink(root, p, cache) {
    let dir = path.dirname(p);
    const stop = rules.pathKey(root);
    while (rules.pathKey(dir) !== stop && rules.isInside(dir, root)) {
      let v = cache.get(dir);
      if (v === undefined) {
        const st = await this._lstat(dir);
        v = !!(st && st.isSymbolicLink());
        cache.set(dir, v);
      }
      if (v) return true;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    return false;
  }

  /** Rows below a folder that vanished, a page at a time with the server free between. */
  async _rowsBelow(dir, gen) {
    const out = [];
    let after = null;
    for (;;) {
      const page = this.store.rowsUnder(dir, after, 2000);
      out.push(...page);
      if (page.length < 2000 || out.length >= BELOW_MAX) break;
      after = page[page.length - 1];
      await yieldNow();
      if (gen !== this.gen || this.isLocked()) return null;
    }
    return out;
  }

  async flush() {
    if (!this.pending.size || !this.running) return;
    const gen = this.gen;
    const batch = [...this.pending];
    this.pending.clear();
    const linkCache = new Map();
    const gone = [];
    const files = [];
    const dirs = [];
    for (const [p, info] of batch) {
      const f = this.folders.get(info.folderId);
      if (!f) continue;
      const rel = path.relative(f.path, p);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (!f.includeSubfolders && rel.includes(path.sep)) continue;
      if (await this._underLink(f.path, p, linkCache)) continue;
      const st = await this._lstat(p);
      if (gen !== this.gen || this.isLocked()) return;
      if (!st) gone.push({ p, f });
      else if (st.isSymbolicLink()) continue;
      else if (st.isDirectory()) { if (info.rename && f.includeSubfolders) dirs.push({ p, f }); }
      else if (st.isFile()) files.push({ p, f, st, rel });
    }
    if (gen !== this.gen || this.isLocked()) return;

    // Gone first, so a rename seen in the same pass pairs up below.
    for (const { p, f } of gone) {
      this.settler.forget(p);
      const row = this.store.rowAt(p);
      const rows = row ? [row] : await this._rowsBelow(p, gen);
      if (!rows) return;
      for (const r of rows) {
        if (r.user_trashed || r.missing_since != null) continue;
        this.goneWait.set(r.id, {
          id: r.id, path: r.filepath, size: r.filesize_bytes, mtimeMs: r.file_mtime_ms, hash: r.quick_hash || null,
          folderId: f.id, at: this.now(),
        });
      }
    }
    // Folders that appeared are walked now (their files pair with rows that
    // just went) and hold the move window open until they are done.
    for (const { p, f } of dirs) this._walkSubtree(f.id, p);
    // A few database reads per file: let the server answer between slices
    // (an await on a resolved promise does not yield to the event loop).
    let n = 0;
    for (const { p, f, st, rel } of files) {
      await this._sawFile(f, p, rel, st.size, Math.trunc(st.mtimeMs));
      if (++n % 64 === 0) await yieldNow();
      if (gen !== this.gen || this.isLocked()) return;
    }
  }

  /** A file is there: back, changed, renamed (case too), moved, or new. */
  async _sawFile(f, p, rel, size, mtimeMs) {
    const row = this.store.rowAt(p);
    if (row) {
      if (row.user_trashed) return;
      this.goneWait.delete(row.id);          // deleted and re-created (a safe-save)
      let real = p;
      // Non-ASCII names too: the database cannot find ÉTÉ.jpg for a row spelled
      // été.jpg (NOCASE folds A-Z only), but the event for the OLD spelling
      // still finds the row, and the file system says what the name is now.
      if (row.filepath !== p || (process.platform === 'win32' && rules.hasNonAscii(row.filepath))) {
        // Same file, another case: a.jpg renamed to A.jpg, or an event that
        // named it the old way. The row follows the disk's case. (A row spelled
        // with forward slashes keeps its spelling: separators are not rewritten.)
        real = await this._realCase(p);
        if (real !== row.filepath && rules.foldCase(real) === rules.foldCase(row.filepath)) {
          this.ops.moves.push({ id: row.id, oldPath: row.filepath, newPath: real, size, mtimeMs, folderId: f.id });
          return;
        }
      }
      if (row.missing_since != null) this.ops.back.push({ id: row.id, path: row.filepath, folderId: f.id });
      const same = row.filesize_bytes === size && row.file_mtime_ms === mtimeMs;
      if (!same) this.settler.observe(real, { folderId: f.id, kind: 'changed', id: row.id, dbPath: row.filepath });
      return;
    }
    const ok = rules.accepts(f, rel, size);
    if (!ok.ok) return;
    const cache = new Map();
    if (await this._takeMove(p, size, mtimeMs, f.id, cache)) return;
    if (await this._takeMissing(f, p, size, mtimeMs, cache)) return;
    if (!this.settler.has(p)) this._burstAdd(f.id);
    this.settler.observe(p, { folderId: f.id, kind: 'new', type: ok.type });
  }

  /** The new file's fingerprint, taken at most once per decision. */
  async _hashOf(p, size, cache) {
    if (cache && cache.has(p)) return cache.get(p);
    let h = null;
    try { h = await this._io(p, () => this.hashFn(p, size)); } catch { h = null; }
    if (cache) cache.set(p, h);
    return h;
  }

  /**
   * Is the file at `p` the one a row described? With the row's fingerprint:
   * only when the file's fingerprint matches. Without one (a row from before
   * fingerprints, not backfilled yet): only when the file kept its name.
   */
  async _sameFile(row, p, size, cache) {
    if (row.hash) return (await this._hashOf(p, size, cache)) === row.hash;
    return baseKey(row.path) === baseKey(p);
  }

  /**
   * Pair a new file with one that just disappeared: same size, same mtime
   * (or none recorded), and provably the same file (_sameFile); ties go to
   * the one sharing the most of the path.
   */
  async _takeMove(p, size, mtimeMs, folderId, cache) {
    if (!(size > 0)) return false;
    const hits = [];
    for (const g of this.goneWait.values()) {
      if (g.size === size && (g.mtimeMs === mtimeMs || g.mtimeMs == null)) hits.push(g);
    }
    if (!hits.length) return false;
    const proven = [];
    for (const g of hits) if (await this._sameFile(g, p, size, cache)) proven.push(g);
    if (!proven.length) return false;
    const g = pickBest(proven, p);
    if (!g || !this.goneWait.has(g.id)) return false;
    this.goneWait.delete(g.id);
    this.ops.moves.push({ id: g.id, oldPath: g.path, newPath: p, size, mtimeMs, hash: cache?.get(p) || null, folderId });
    return true;
  }

  /**
   * Re-pair: a file that turns up in a watched folder and is provably a
   * file already marked Missing in that SAME folder (_sameFile: matching
   * fingerprint, or same name when the row has none) takes the row back.
   * Ties go by path; an unresolved tie takes nothing.
   */
  async _takeMissing(f, p, size, mtimeMs, cache) {
    let cands;
    try { cands = this.store.missingCandidates ? this.store.missingCandidates(size, mtimeMs) : []; } catch { return false; }
    cands = cands.filter(c => rules.isInside(c.filepath, f.path));
    if (!cands.length) return false;
    const proven = [];
    for (const c of cands) {
      if (await this._sameFile({ path: c.filepath, hash: c.quick_hash || null }, p, size, cache)) proven.push(c);
    }
    if (!proven.length) return false;
    const c = pickBest(proven, p, (x) => x.filepath);
    if (!c || this.ops.moves.some(mv => mv.id === c.id)) return false;
    this.ops.moves.push({ id: c.id, oldPath: c.filepath, newPath: p, size, mtimeMs, hash: cache?.get(p) || null, folderId: f.id, repair: true });
    return true;
  }

  /* ── 3. Settle ──────────────────────────────────────────────────────── */

  _settled(e, st) {
    if (!this.running) return;
    const m = e.meta;
    if (m.kind === 'changed') {
      this.ops.changed.push({ id: m.id, path: m.dbPath || null, file: e.path, size: st.size, mtimeMs: st.mtimeMs, folderId: m.folderId });
      return;
    }
    this.resolveQ.push({ path: e.path, size: st.size, mtimeMs: st.mtimeMs, folderId: m.folderId });
  }

  /**
   * Settled new files: the real case on disk, one more look for a row (a
   * walk or Add folder may have recorded it), a match with a file that went,
   * a Missing row that comes back, else an add with its fingerprint.
   */
  async _resolveNew() {
    if (this._resolving || !this.resolveQ.length) return;
    this._resolving = true;
    const gen = this.gen;
    try {
      const batch = this.resolveQ.splice(0, 64);
      for (const it of batch) {
        if (gen !== this.gen || this.isLocked()) return;
        const f = this.folders.get(it.folderId);
        if (!f) continue;
        const p = await this._realCase(it.path);
        if (this.store.rowAt(p)) { this._burstDone(it.folderId); continue; }
        const cache = new Map();
        if (await this._takeMove(p, it.size, it.mtimeMs, f.id, cache)
          || await this._takeMissing(f, p, it.size, it.mtimeMs, cache)) {
          this._burstDone(it.folderId);
          continue;
        }
        // On a network share a new file's fingerprint is taken only when a
        // match needs it (above); a plain add does not read the file.
        const hash = this._isNetwork(p) ? null : await this._hashOf(p, it.size, cache);
        this.ops.add.push({ path: p, size: it.size, mtimeMs: it.mtimeMs, hash, folderId: it.folderId });
      }
    } finally {
      this._resolving = false;
    }
  }

  _burstAdd(id) { const b = this.bursts.get(id) || { done: 0, total: 0 }; b.total++; this.bursts.set(id, b); }
  _burstDone(id, n = 1) { const b = this.bursts.get(id); if (b) b.done = Math.min(b.total, b.done + n); }
  _burstDrop(id) { const b = this.bursts.get(id); if (b) b.total = Math.max(b.done, b.total - 1); }

  /* ── Catch-up walks ─────────────────────────────────────────────────── */

  /**
   * Queue a full walk of a folder. A subfolder that just appeared (`root`)
   * is walked at once instead (see _walkSubtree).
   */
  queueCatchUp(folderId, root = null) {
    if (!this.running || this.isLocked()) return false;
    if (!this.folders.has(folderId)) return false;
    if (root) { this._walkSubtree(folderId, root); return true; }
    if (!this.catchQueue.some(q => q.folderId === folderId)) this.catchQueue.push({ folderId });
    if (!this.d.manualTimers) this.runCatchUps().catch(() => {});
    return true;
  }

  /**
   * Walk a subfolder that just appeared, now, alongside any full walk. While
   * it runs, files of that folder waiting to be called missing keep waiting:
   * a renamed folder's files must pair with its old rows, however busy the
   * queue is. Resolves when done (tests await it).
   */
  _walkSubtree(folderId, root) {
    const f = this.folders.get(folderId);
    if (!f || !this.running) return Promise.resolve();
    const gen = this.gen;
    this.subWalks.set(folderId, (this.subWalks.get(folderId) || 0) + 1);
    const done = (async () => {
      try {
        const res = await catchUp(f, {
          fs: this._walkFs(f),
          rowsUnder: (r, after, limit, sep) => this.store.rowsUnder(r, after, limit, sep),
          root,
          cancelled: () => gen !== this.gen || this.isLocked() || !this.folders.has(f.id),
        });
        if (gen !== this.gen || this.isLocked() || res.cancelled || res.error) return;
        await this._caughtUp(f, root, res, gen);
      } catch { /* the full walk will see it */ } finally {
        if (gen === this.gen) {
          const n = (this.subWalks.get(folderId) || 1) - 1;
          if (n > 0) this.subWalks.set(folderId, n); else this.subWalks.delete(folderId);
          // The window starts again from now for what is still waiting.
          const now = this.now();
          for (const g of this.goneWait.values()) if (g.folderId === folderId) g.at = Math.max(g.at, now);
        }
      }
    })();
    this._subWalkDone = done;
    return done;
  }

  /** Run queued walks one after another. Resolves when the queue is empty. */
  async runCatchUps() {
    if (this.scanning) return;
    const gen = this.gen;
    while (this.catchQueue.length && gen === this.gen && !this.isLocked()) {
      const job = this.catchQueue.shift();
      const f = this.folders.get(job.folderId);
      if (!f) continue;
      this.scanning = { folderId: f.id, seen: 0 };
      let res;
      try {
        res = await catchUp(f, {
          fs: this._walkFs(f),
          rowsUnder: (root, after, limit, sep) => this.store.rowsUnder(root, after, limit, sep),
          cancelled: () => gen !== this.gen || this.isLocked() || !this.folders.has(f.id),
          progress: ({ seen }) => { if (this.scanning) this.scanning.seen = seen; },
        });
      } catch (err) {
        res = { error: err.code || 'EIO' };
      }
      this.scanning = null;
      if (gen !== this.gen || this.isLocked() || res.cancelled) return;
      await this._caughtUp(f, null, res, gen);
    }
  }

  async _caughtUp(f, root, res, gen = this.gen) {
    if (res.error) {
      // The folder itself cannot be read: say so, mark nothing missing.
      if (!root) {
        const msg = plainError(res.error);
        this.errors.set(f.id, msg);
        if (GONE_CODES.has(res.error)) { this.offline.add(f.id); this._dropGone(f.id); }
        this._note(f.id, { lastError: msg, lastScanAt: this.now() });
      }
      return;
    }
    // The folder read fine: an old error clears, unless its live watch is still down.
    if (!root && (f.mode !== 'live' || this.live.has(f.id))) {
      this.errors.delete(f.id); this.offline.delete(f.id); this.backoff.delete(f.id);
    }
    // Rows from before modified times were recorded: note them, a slice at a
    // time, path-checked, and not while a migrate rewrites paths (the next walk does it).
    for (let i = 0; i < res.backfill.length; i += APPLY_BATCH) {
      if (gen !== this.gen || !this._canWrite()) break;
      this.store.backfillStats(res.backfill.slice(i, i + APPLY_BATCH).map(b => ({ ...b, path: b.dbPath })));
      if (i + APPLY_BATCH < res.backfill.length) await yieldNow();
    }
    if (gen !== this.gen || this.isLocked()) return;
    for (const h of res.needHash || []) if (this.hashQ.length < HASH_QUEUE_MAX) this.hashQ.push(h);
    for (const r of res.recase || []) this.ops.moves.push({ ...r, folderId: f.id });
    for (const b of res.back) { this.goneWait.delete(b.id); this.ops.back.push({ id: b.id, path: b.dbPath, folderId: f.id }); }
    for (const c of res.changed) this.settler.observe(c.path, { folderId: f.id, kind: 'changed', id: c.id, dbPath: c.dbPath });
    // Moves: what this walk found gone, plus anything the live watch saw go.
    // Each pair has to be proven (fingerprint, or same name) like a live one.
    const waiting = [...this.goneWait.values()];
    const allGone = [...res.gone, ...waiting];
    const m = matchMoves(allGone, res.newFiles);
    const goneLeft = m.gone;
    const foundLeft = m.found;
    const goneById = new Map(allGone.map(g => [g.id, g]));
    const foundByPath = new Map(res.newFiles.map(n => [n.path, n]));
    let i = 0;
    for (const mv of m.moves) {
      if (++i % 128 === 0) { await yieldNow(); if (gen !== this.gen || this.isLocked()) return; }
      const g = goneById.get(mv.id);
      const cache = new Map();
      if (g && !(await this._sameFile(g, mv.newPath, mv.size, cache))) {
        goneLeft.push(g);
        foundLeft.push(foundByPath.get(mv.newPath));
        continue;
      }
      this.goneWait.delete(mv.id);
      this.ops.moves.push({ ...mv, hash: cache.get(mv.newPath) || null, folderId: f.id });
    }
    const waitingIds = new Set(waiting.map(w => w.id));
    for (const g of goneLeft) if (!waitingIds.has(g.id)) this.ops.missing.push({ id: g.id, path: g.path, folderId: f.id, checked: true });
    i = 0;
    for (const n of foundLeft) {
      if (!n) continue;
      if (++i % 128 === 0) {               // a walk can find thousands: stay responsive
        await yieldNow();
        if (gen !== this.gen || this.isLocked()) return;
      }
      // A file that was already Missing and turned up again takes its row back.
      if (await this._takeMissing(f, n.path, n.size, n.mtimeMs, new Map())) continue;
      if (!this.settler.has(n.path)) this._burstAdd(f.id);
      this.settler.observe(n.path, { folderId: f.id, kind: 'new', type: n.type });
    }
    if (!root) this._note(f.id, { lastScanAt: this.now(), lastError: this.errors.get(f.id) || null });
  }

  /* ── 4 + 5. Tick: settle, expire, apply ─────────────────────────────── */

  /** One tick at a time: the 500 ms timer never starts a second one beside a slow first. */
  async tick() {
    if (this._ticking || !this.running || this.isLocked()) return;
    this._ticking = true;
    try { await this._tickBody(); } finally { this._ticking = false; }
  }

  async _tickBody() {
    if (this.pending.size && this.d.manualTimers) await this.flush();
    const now = this.now();
    if (now - this._lastHealth >= HEALTH_MS) {
      this._lastHealth = now;
      await this._health();
    }
    this._confirmArms();
    await this.settler.tick();
    await this._resolveNew();
    for (const g of [...this.goneWait.values()]) {
      if (this.subWalks.get(g.folderId)) continue;     // a renamed folder is still being walked
      if (now - g.at >= MOVE_WINDOW_MS) {
        this.goneWait.delete(g.id);
        this.ops.missing.push({ id: g.id, path: g.path, folderId: g.folderId });
      }
    }
    // A few batches per tick, the event loop free in between: a big copy
    // lands at a few hundred files a second without one long write.
    for (let i = 0; i < 12; i++) {
      await this.apply();
      const left = this.ops.add.length + this.ops.moves.length + this.ops.missing.length + this.ops.changed.length + this.ops.back.length;
      if (!left || !this.running || this.isLocked() || this.isMigrating()) break;
      // setTimeout, not setImmediate: requests AND timers get a turn between batches.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await this._backfillHashes();
  }

  /**
   * Fingerprints for rows that have none yet: a few per tick, one read at a
   * time, never two batches at once, never on a network share (week 3). Each
   * is stored only next to the size and time of the copy it was read from,
   * and only into a row still without one (store.setQuickHash).
   */
  async _backfillHashes() {
    if (this._backfilling || !this.hashQ.length || !this._canWrite()) return;
    this._backfilling = true;
    const gen = this.gen;
    try {
      const batch = this.hashQ.splice(0, HASH_PER_TICK).filter(it => !this._isNetwork(it.path));
      const out = [];
      for (const it of batch) {
        if (gen !== this.gen || !this._canWrite()) return;
        let r = null;
        try { r = await this.hashStatFn(it.path); } catch { r = null; }
        if (r && r.hash) out.push({ id: it.id, path: it.path, hash: r.hash, size: r.size, mtimeMs: r.mtimeMs });
      }
      if (gen !== this.gen || !this._canWrite()) return;
      try { this.store.setQuickHash(out); } catch {}
    } finally {
      this._backfilling = false;
    }
  }

  async apply() {
    if (this._applying || !this.running) return;
    if (this.isLocked()) { this.stop(); return; }
    if (this.isMigrating()) return;               // paths are being rewritten: wait
    this._applying = true;
    const gen = this.gen;
    const touched = new Set();
    let wrote = false;
    try {
      const take = (k) => this.ops[k].splice(0, k === 'add' || k === 'moves' ? ROW_BATCH : APPLY_BATCH);

      const moves = take('moves');
      if (moves.length) {
        const n = this.store.applyMoves(moves);
        if (n) {
          wrote = true;
          const back = moves.filter(m => m.repair);
          if (back.length) this._log('back', back, back.length);
          if (n - back.length > 0) this._log('moved', moves.filter(m => !m.repair), n - back.length);
        }
        moves.forEach(m => touched.add(m.folderId));
      }

      // Missing: one last look at the file, and at its folder: a folder that
      // is itself gone (deleted, drive pulled) marks nothing.
      const missing = take('missing');
      if (missing.length) {
        const rootOk = new Map();
        const really = [];
        for (const m of missing) {
          const f = this.folders.get(m.folderId);
          if (!f) continue;
          if (!rootOk.has(f.id)) {
            const st = await this._lstat(f.path);
            rootOk.set(f.id, !!st);
            if (!st && !this.offline.has(f.id)) { this._disarm(f.id); this._fail(f, 'ENOENT'); }
          }
          if (!rootOk.get(f.id)) continue;
          if (m.checked || !(await this._lstat(m.path))) really.push(m);
        }
        if (gen !== this.gen || !this._canWrite()) return;
        const n = this.store.markMissing(really.map(m => ({ id: m.id, path: m.path })), this.now());
        if (n) { wrote = true; this._log('missing', really, n); }
        really.forEach(m => touched.add(m.folderId));
      }

      const back = take('back');
      if (back.length) {
        const n = this.store.clearMissing(back.map(b => ({ id: b.id, path: b.path || null })));
        if (n) { wrote = true; this._log('back', back, n); }
        back.forEach(b => touched.add(b.folderId));
      }

      const adds = take('add');
      if (adds.length) {
        const byFolder = new Map();
        for (const a of adds) byFolder.set(a.folderId, (byFolder.get(a.folderId) || []).concat([a]));
        for (const [fid, list] of byFolder) {
          const f = this.folders.get(fid);
          if (!f) continue;
          // Someone (Add folder, a walk) may have recorded it meanwhile, in any case.
          const fresh = list.filter(a => !this.store.rowAt(a.path));
          const stats = new Map(fresh.map(a => [a.path, { size: a.size, mtimeMs: a.mtimeMs, hash: a.hash || null }]));
          const res = fresh.length
            ? this.d.addFiles(fresh.map(a => a.path), { analyse: f.newFiles === 'analyse', watchNew: true, stats })
            : { added: [] };
          this._burstDone(fid, list.length);
          if (res.added.length) {
            wrote = true;
            touched.add(fid);
            this._log('added', res.added.map(() => ({ folderId: fid })), res.added.length);
            this._later({ kind: 'probe', added: res.added });
          }
        }
      }

      const changed = take('changed');
      if (changed.length) {
        // The new content's fingerprint replaces the old one.
        for (const c of changed) c.hash = await this._hashOf(c.file || c.path, c.size, null);
        if (gen !== this.gen || !this._canWrite()) { this.ops.changed.unshift(...changed); return; }
        const res = this.store.markChanged(changed);
        if (res.length) wrote = true;
        const byId = new Map(changed.map(c => [c.id, c]));
        for (const r of res) {
          const c = byId.get(r.id);
          const f = c && this.folders.get(c.folderId);
          touched.add(c.folderId);
          // AI only for a file never analysed, in an "Add and analyse" folder.
          if (f && f.newFiles === 'analyse' && !r.analysed && this.d.enqueueScan && this.d.getRow) {
            const row = this.d.getRow(r.id);
            if (row) this.d.enqueueScan({ id: row.id, filepath: row.filepath, filename: row.filename, mediaType: row.media_type });
          }
        }
        if (res.length) {
          this._log('changed', res.map(r => byId.get(r.id)), res.length);
          this._later({ kind: 'refresh', ids: res.map(r => r.id) });
        }
      }

      if (touched.size) {
        const at = this.now();
        for (const id of touched) this._note(id, { lastChangeAt: at });
      }
    } catch (err) {
      if (!this.isLocked()) console.warn(`[Watch] could not save changes: ${err.message}`);
    } finally {
      this._applying = false;
    }
    if (wrote) {
      this._counts = this._counts ? { ...this._counts, stale: true } : null;
      try { this.d.onChange && this.d.onChange(); } catch {}
    }
    // Bursts end when nothing for the folder is waiting.
    for (const [id, b] of this.bursts) {
      if (b.done >= b.total && !this.settler.countFor(id) && !this.resolveQ.some(r => r.folderId === id)) this.bursts.delete(id);
    }
  }

  /** Background work after a write: probes and thumbnails, one item at a time. */
  _later(job) {
    this.after.push(job);
    if (this.afterRunning) return;
    this.afterRunning = true;
    const gen = this.gen;
    (async () => {
      while (this.after.length && gen === this.gen && !this.isLocked()) {
        const j = this.after.shift();
        const isLocked = () => gen !== this.gen || this.isLocked();
        try {
          if (j.kind === 'probe' && this.d.afterAdd) await this.d.afterAdd(j.added, { isLocked });
          else if (j.kind === 'refresh' && this.d.refresh) await this.d.refresh(j.ids, { isLocked });
        } catch { /* best effort */ }
      }
    })().finally(() => { this.afterRunning = false; });
  }

  _log(kind, items, n) {
    const by = new Map();
    for (const it of items) by.set(it.folderId, (by.get(it.folderId) || 0) + 1);
    const at = this.now();
    for (const [folderId, count] of by) this.activityLog.push({ kind, folderId, n: Math.min(count, n), at });
    if (this.activityLog.length > ACTIVITY_MAX) this.activityLog.splice(0, this.activityLog.length - ACTIVITY_MAX);
  }

  /* ── Pause, resume, check now ───────────────────────────────────────── */

  pauseAll() {
    this.settings.set({ paused: true });
    this.stop();
  }

  resumeAll() {
    this.settings.set({ paused: false });
    this.start({ catchUpAll: true });
  }

  checkNow(id) {
    if (!this.running) this.start();
    return this.queueCatchUp(id);
  }

  /* ── What the UI shows ──────────────────────────────────────────────── */

  /** One folder's live status for its Settings row. */
  statusOf(f) {
    const pausedAll = this.paused();
    const adding = this.settler.countFor(f.id) + this.ops.add.filter(a => a.folderId === f.id).length
      + this.resolveQ.filter(a => a.folderId === f.id).length;
    const b = this.bursts.get(f.id);
    const out = { state: 'live', adding, progress: null, error: null, seen: null };
    if (b && b.total) out.progress = Math.round((b.done / b.total) * 100);
    if (this.isLocked()) out.state = 'locked';
    else if (pausedAll) out.state = 'paused';
    else if (!f.enabled) out.state = 'off';
    else if (this.errors.has(f.id)) { out.state = 'error'; out.error = this.errors.get(f.id); }
    else if (this.scanning && this.scanning.folderId === f.id) { out.state = 'scanning'; out.seen = this.scanning.seen; }
    else if (adding > 0) out.state = 'adding';
    else out.state = f.mode;
    return out;
  }

  /**
   * Per-folder new and missing counts for the pill: computed in slices in the
   * background (store.activityCounts) and served from cache, refreshed when
   * the library changed and the last count is older than COUNTS_TTL_MS.
   */
  _countsNow() {
    const v = this.d.version ? this.d.version() : 0;
    const now = this.now();
    const c = this._counts;
    const fresh = c && !c.stale && c.v === v;
    const due = !c || (!fresh && now - c.at >= COUNTS_TTL_MS);
    if (due && !this._countsRunning && this.store.activityCounts) {
      this._countsRunning = true;
      const gen = this.gen;
      Promise.resolve(this.store.activityCounts([...this.folders.values()], { cancelled: () => gen !== this.gen || this.isLocked() }))
        .then((r) => { if (r && gen === this.gen) this._counts = { v, at: this.now(), ...r }; })
        .catch(() => {})
        .finally(() => { this._countsRunning = false; });
    }
    return c || { newBy: new Map(), missingBy: new Map(), newTotal: 0 };
  }

  /** The header pill and its popover. */
  activity() {
    const list = [...this.folders.values()];
    const pausedAll = this.paused();
    const out = {
      watching: list.some(f => f.enabled), paused: pausedAll, locked: this.isLocked(),
      state: 'idle', newTotal: 0, lastChangeAt: null, folders: [], adding: { pending: 0, progress: null },
    };
    if (out.locked) return out;
    let counts = { newBy: new Map(), missingBy: new Map(), newTotal: 0 };
    try { counts = this._countsNow(); } catch {}
    out.newTotal = counts.newTotal || 0;
    const dayAgo = this.now() - 24 * 3600 * 1000;
    let done = 0, total = 0;
    for (const f of list) {
      const st = this.statusOf(f);
      const moved = this.activityLog.filter(a => a.kind === 'moved' && a.folderId === f.id && a.at >= dayAgo).reduce((n, a) => n + a.n, 0);
      out.folders.push({
        id: f.id, path: f.path, name: path.basename(f.path) || f.path,
        new: counts.newBy.get(f.id) || 0, missing: counts.missingBy.get(f.id) || 0, moved,
        state: st.state, adding: st.adding, error: st.error,
      });
      out.adding.pending += st.adding;
      const b = this.bursts.get(f.id);
      if (b) { done += b.done; total += b.total; }
      if (f.lastChangeAt && (!out.lastChangeAt || f.lastChangeAt > out.lastChangeAt)) out.lastChangeAt = f.lastChangeAt;
    }
    const lastLog = this.activityLog.length ? this.activityLog[this.activityLog.length - 1].at : null;
    if (lastLog && (!out.lastChangeAt || lastLog > out.lastChangeAt)) out.lastChangeAt = lastLog;
    if (total) out.adding.progress = Math.round((done / total) * 100);
    if (out.folders.some(f => f.state === 'error')) out.state = 'error';
    else if (out.adding.pending > 0) out.state = 'adding';
    else if (this.scanning) out.state = 'scanning';
    return out;
  }
}

module.exports = { WatchManager, plainError, MOVE_WINDOW_MS, HEALTH_MS, CONFIRM_MS, APPLY_BATCH };
