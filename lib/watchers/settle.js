/**
 * Folder watchers: wait for a file to finish arriving before it is added.
 *
 * A copy or download in progress keeps growing; adding it mid-copy is what
 * left the power user's file with "Could not read media info" and a blank
 * thumbnail. So a file is only handed on once its size and modified time
 * have held steady for CHECKS looks INTERVAL_MS apart (3 looks 2 s apart by
 * default: about 4 s after it stops changing), it is not empty, and it can
 * be opened for reading (a writer that holds the file without sharing it,
 * like Explorer's copy, makes that open fail; the file waits).
 *
 * One ticker for every waiting file rather than a timer each, so a
 * 10,000-file copy is one map and a few stats per tick, with at most
 * CONCURRENCY stats in flight. Clock, stat and open are injected so the
 * tests run on fake time (test/watchers.test.js).
 */

const fsp = require('fs').promises;

const CHECKS = 3;
const INTERVAL_MS = 2000;
const CONCURRENCY = 16;
const EMPTY_GIVE_UP = 30;          // looks at a 0-byte file before it is dropped

async function canOpen(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    return true;
  } catch (err) {
    // Busy or locked by the writer: try again later. Anything else (gone)
    // is the next stat's business.
    return !['EBUSY', 'EPERM', 'EACCES'].includes(err.code);
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

class Settler {
  /**
   * @param {object} o
   * @param {Function} o.onSettled  (entry, { size, mtimeMs }) a file is ready
   * @param {Function} [o.onGone]   (entry) it disappeared while waiting
   * @param {Function} [o.stat]     path -> Promise<Stats>
   * @param {Function} [o.canOpen]  path -> Promise<boolean>
   * @param {Function} [o.now]      () -> ms
   * @param {Function} [o.keyOf]    path -> map key (case-insensitive on Windows,
   *   so a file renamed a.jpg -> A.JPG while it settles is still one entry)
   */
  constructor(o) {
    this.keyOf = o.keyOf || ((p) => p);
    this.onSettled = o.onSettled;
    this.onGone = o.onGone || (() => {});
    this.stat = o.stat || ((p) => fsp.stat(p));
    this.canOpen = o.canOpen || canOpen;
    this.now = o.now || Date.now;
    this.checks = o.checks || CHECKS;
    this.intervalMs = o.intervalMs || INTERVAL_MS;
    this.concurrency = o.concurrency || CONCURRENCY;
    this.waiting = new Map();      // path -> entry
    this._ticking = false;
  }

  get size() { return this.waiting.size; }

  /**
   * Start (or keep) waiting on a file. `meta` rides along to onSettled
   * (folder id, kind). A new event on a file already waiting just resets
   * its count: it changed again.
   */
  observe(file, meta = {}) {
    const now = this.now();
    const e = this.waiting.get(this.keyOf(file));
    if (e) {
      e.path = file;                 // the latest spelling seen
      e.meta = { ...e.meta, ...meta };
      e.stable = 0;
      e.dueAt = now + this.intervalMs;
      return e;
    }
    const entry = { key: this.keyOf(file), path: file, meta, last: null, stable: 0, empty: 0, firstAt: now, dueAt: now };
    this.waiting.set(entry.key, entry);
    return entry;
  }

  has(file) { return this.waiting.has(this.keyOf(file)); }

  forget(file) { this.waiting.delete(this.keyOf(file)); }

  clear() { this.waiting.clear(); }

  /** Waiting entries for one folder (the "Adding N files" count). */
  countFor(folderId) {
    let n = 0;
    for (const e of this.waiting.values()) if (e.meta.folderId === folderId) n++;
    return n;
  }

  /** Look at every file that is due. Safe to call often; one pass at a time. */
  async tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const now = this.now();
      const due = [];
      for (const e of this.waiting.values()) if (e.dueAt <= now) due.push(e);
      for (let i = 0; i < due.length; i += this.concurrency) {
        await Promise.all(due.slice(i, i + this.concurrency).map(e => this._look(e)));
      }
    } finally {
      this._ticking = false;
    }
  }

  async _look(e) {
    if (this.waiting.get(e.key) !== e) return;           // forgotten meanwhile
    let st;
    try {
      st = await this.stat(e.path);
    } catch {
      this.waiting.delete(e.key);
      this.onGone(e);
      return;
    }
    if (this.waiting.get(e.key) !== e) return;
    const cur = { size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
    e.dueAt = this.now() + this.intervalMs;
    if (typeof st.isFile === 'function' && !st.isFile()) {
      this.waiting.delete(e.key);
      return;
    }
    if (cur.size === 0) {
      e.stable = 0;
      e.last = cur;
      if (++e.empty >= EMPTY_GIVE_UP) this.waiting.delete(e.key);
      return;
    }
    if (e.last && e.last.size === cur.size && e.last.mtimeMs === cur.mtimeMs) e.stable++;
    else e.stable = 1;
    e.last = cur;
    if (e.stable < this.checks) return;
    if (!(await this.canOpen(e.path))) {
      e.stable = this.checks - 1;                         // still held by the writer
      return;
    }
    if (this.waiting.get(e.key) !== e) return;
    this.waiting.delete(e.key);
    this.onSettled(e, cur);
  }
}

module.exports = { Settler, canOpen, CHECKS, INTERVAL_MS };
