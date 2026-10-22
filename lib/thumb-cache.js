/**
 * The two bookkeeping structures behind the thumbnail settings. Pure logic, no
 * I/O, so they can be tested on their own (lib/thumbnails.js does the reading,
 * writing and deleting).
 *
 * ByteLru: the "Only while Vault is running" cache. Pictures held in server
 * memory, keyed by id + kind, capped by total bytes. Least recently used goes
 * first. Also holds pictures read out of files (album / cover art) in every
 * mode, since those are never stored.
 *
 * DiskUse: the "Keep up to N" ledger. Bytes on disk (or in the encrypted store)
 * per media id, with the last time each was shown. Picks which ids to remove,
 * least recently shown first, never one shown in the last few minutes (that is
 * what is on screen right now).
 */

class ByteLru {
  constructor(maxBytes) {
    this.maxBytes = Math.max(0, Math.floor(Number(maxBytes) || 0));
    this.map = new Map();   // key -> Buffer; Map order is the LRU order (front = coldest)
    this.bytes = 0;
  }

  get size() { return this.map.size; }

  get(key) {
    const buf = this.map.get(key);
    if (!buf) return null;
    this.map.delete(key);
    this.map.set(key, buf);
    return buf;
  }

  has(key) { return this.map.has(key); }

  /** Store bytes. A single item bigger than the whole cap is not kept. */
  set(key, buf) {
    if (!Buffer.isBuffer(buf)) return false;
    this.delete(key);
    if (buf.length > this.maxBytes) return false;
    this.map.set(key, buf);
    this.bytes += buf.length;
    this._trim();
    return true;
  }

  delete(key) {
    const old = this.map.get(key);
    if (!old) return false;
    this.map.delete(key);
    this.bytes -= old.length;
    return true;
  }

  /** Remove every key the predicate accepts. @returns {number} removed */
  deleteWhere(pred) {
    let n = 0;
    for (const k of [...this.map.keys()]) {
      if (pred(k)) { this.delete(k); n++; }
    }
    return n;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  setMax(maxBytes) {
    this.maxBytes = Math.max(0, Math.floor(Number(maxBytes) || 0));
    this._trim();
  }

  /** { bytes, count } for the keys a predicate accepts (all when omitted). */
  stats(pred) {
    let bytes = 0;
    let count = 0;
    for (const [k, b] of this.map) {
      if (pred && !pred(k)) continue;
      bytes += b.length;
      count++;
    }
    return { bytes, count };
  }

  _trim() {
    while (this.bytes > this.maxBytes && this.map.size) {
      const coldest = this.map.keys().next().value;
      this.delete(coldest);
    }
  }
}

class DiskUse {
  /**
   * @param {{protectMs?: number, now?: () => number}} [opts] protectMs: an id
   *   shown more recently than this is never picked (it is on screen now).
   */
  constructor({ protectMs = 5 * 60 * 1000, now = Date.now } = {}) {
    this.protectMs = protectMs;
    this.now = now;
    this.items = new Map();   // id -> { bytes, seen }
    this.total = 0;
  }

  get size() { return this.items.size; }

  /** Add bytes for an id (a new cover or scrub frame). */
  add(id, bytes, seen = this.now()) {
    const e = this.items.get(id);
    if (e) {
      e.bytes += bytes;
      if (seen > e.seen) e.seen = seen;
    } else {
      this.items.set(id, { bytes, seen });
    }
    this.total += bytes;
  }

  /** Replace an id's entry with measured values (bytes 0 removes it). */
  set(id, bytes, seen) {
    this.remove(id);
    if (bytes > 0) this.add(id, bytes, seen);
  }

  /** The id was just shown. */
  touch(id, t = this.now()) {
    const e = this.items.get(id);
    if (e && t > e.seen) e.seen = t;
    return !!e;
  }

  remove(id) {
    const e = this.items.get(id);
    if (!e) return 0;
    this.items.delete(id);
    this.total -= e.bytes;
    return e.bytes;
  }

  /** Remove only `bytes` from an id (one kind deleted, e.g. its hover frames). */
  shrink(id, bytes) {
    const e = this.items.get(id);
    if (!e) return;
    const take = Math.min(bytes, e.bytes);
    e.bytes -= take;
    this.total -= take;
    if (e.bytes <= 0) this.items.delete(id);
  }

  clear() {
    this.items.clear();
    this.total = 0;
  }

  /**
   * Ids to remove to get down to `targetBytes`, least recently shown first.
   * Ids shown within protectMs are skipped, so the result may fall short.
   * @param {number} targetBytes
   * @param {number} [max] stop after this many ids (trimming happens in steps)
   */
  victims(targetBytes, max = Infinity) {
    if (this.total <= targetBytes) return [];
    const cutoff = this.now() - this.protectMs;
    const cands = [];
    for (const [id, e] of this.items) {
      if (e.seen < cutoff) cands.push([id, e]);
    }
    cands.sort((a, b) => a[1].seen - b[1].seen || a[0] - b[0]);
    const out = [];
    let total = this.total;
    for (const [id, e] of cands) {
      if (total <= targetBytes || out.length >= max) break;
      out.push(id);
      total -= e.bytes;
    }
    return out;
  }
}

module.exports = { ByteLru, DiskUse };
