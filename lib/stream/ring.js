/**
 * In-memory segment ring — the whole segment store, and it never touches disk.
 *
 * Round 3 replaced the persistent cache (a plaintext folder plus an encrypted
 * secure_assets backend plus a stream_cache bookkeeping table) with this: while
 * a file is playing, the segments FFmpeg has just made live in RAM, and when
 * the player goes away they are gone. Nothing about a watched file survives on
 * the drive, which is the point — a persistent copy of everything anyone
 * watches is a workaround, not a feature, and on a spinning external drive it
 * is a slow one.
 *
 * A ring outlives its producer on purpose. A short file is remuxed in a couple
 * of seconds and the FFmpeg child exits, but the player is still working
 * through what it made, so the buffers have to stay until the session really
 * ends (idle timeout, close beacon, lock, delete).
 *
 * Retention, per the spec:
 *   - keep segments in [playhead - BEHIND, producer head]; "playhead" is the
 *     highest segment number the client has asked for.
 *   - at most MAX_SEGMENTS per session, and MAX_TOTAL_BYTES across all of them.
 *   - when something has to go: the oldest one below the playhead first, then
 *     the furthest ahead of the least recently requested session.
 * A request for a segment that was dropped simply restarts the producer at that
 * number, which is the same path a seek already takes.
 */

/** Segments kept behind the playhead, so a small back-seek does not re-remux. */
const BEHIND = 15;

/** Hard cap on one session's ring. */
const MAX_SEGMENTS = 48;

/** Hard cap across every ring in the process. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** mediaId -> Ring */
const rings = new Map();

let totalBytes = 0;

class Ring {
  constructor(mediaId) {
    this.mediaId = mediaId;
    this.segs = new Map();          // n -> Buffer
    this.bytes = 0;
    this.playhead = 0;              // highest n the client has asked for
    this.head = -1;                 // highest n the producer has delivered
    this.produced = 0;              // segments ingested by this ring, ever
    this.lastRequest = Date.now();
    this.createdAt = Date.now();
  }

  has(n) { return this.segs.has(n); }
  get(n) { return this.segs.get(n) || null; }

  /**
   * Record that the client asked for segment n (moves the playhead).
   *
   * Forward always moves it. Backward only moves it when the request lands
   * outside the retention window, which is the difference between "the player
   * nudged back a few seconds" (keep everything, including what is buffered
   * ahead) and "someone seeked backwards" (the window has to follow them, or
   * trim() throws every newly made segment away the instant it arrives and the
   * request that caused the restart times out waiting for it).
   */
  note(n) {
    this.lastRequest = Date.now();
    if (!Number.isInteger(n)) return;
    if (n > this.playhead || n < this.playhead - BEHIND) this.playhead = n;
  }

  set(n, buf) {
    const old = this.segs.get(n);
    if (old) { this.bytes -= old.length; totalBytes -= old.length; }
    this.segs.set(n, buf);
    this.bytes += buf.length;
    totalBytes += buf.length;
    if (n > this.head) this.head = n;
    this.produced++;
  }

  drop(n) {
    const buf = this.segs.get(n);
    if (!buf) return false;
    this.segs.delete(n);
    this.bytes -= buf.length;
    totalBytes -= buf.length;
    return true;
  }

  /**
   * The one eviction choice, shared by every cap: whatever is furthest behind
   * the playhead goes first (it has been watched), and only when nothing is
   * behind does the ring give up its furthest-ahead segment (it is the one the
   * player will need last).
   */
  evictOne() {
    let behind = null, ahead = null;
    for (const n of this.segs.keys()) {
      if (n < this.playhead) { if (behind === null || n < behind) behind = n; }
      else if (ahead === null || n > ahead) ahead = n;
    }
    const pick = behind !== null ? behind : ahead;
    if (pick === null) return false;
    return this.drop(pick);
  }

  /** Apply the retention window and this ring's own cap. */
  trim() {
    for (const n of [...this.segs.keys()]) {
      if (n < this.playhead - BEHIND) this.drop(n);
    }
    while (this.segs.size > MAX_SEGMENTS && this.evictOne());
  }

  clear() {
    for (const n of [...this.segs.keys()]) this.drop(n);
  }

  stats() {
    return {
      mediaId: this.mediaId,
      playhead: this.playhead,
      head: this.head,
      produced: this.produced,
      ringSegments: this.segs.size,
      ringBytes: this.bytes,
      idleMs: Date.now() - this.lastRequest,
    };
  }
}

/** The ring for a media id, created on first use. */
function ringFor(mediaId) {
  let r = rings.get(mediaId);
  if (!r) { r = new Ring(mediaId); rings.set(mediaId, r); }
  return r;
}

/** The ring for a media id, or null. Never creates one. */
function peek(mediaId) { return rings.get(mediaId) || null; }

function has(mediaId, n) {
  const r = rings.get(mediaId);
  return !!(r && r.has(n));
}

function get(mediaId, n) {
  const r = rings.get(mediaId);
  return r ? r.get(n) : null;
}

/** Note a client request for segment n (moves the playhead, resets the idle clock). */
function note(mediaId, n) {
  ringFor(mediaId).note(n);
}

/** Store a finished segment and apply every cap. */
function put(mediaId, n, buf) {
  const r = ringFor(mediaId);
  r.set(n, buf);
  r.trim();
  enforceTotal(mediaId);
  return true;
}

/**
 * Global cap. The session that has waited longest for a request gives up a
 * segment first; the ring that is being written to right now is spared while
 * anything else has something to give, so one player cannot starve itself
 * because another tab left a ring behind.
 */
function enforceTotal(exceptId = null) {
  let guard = 4096;
  while (totalBytes > MAX_TOTAL_BYTES && guard-- > 0) {
    let victim = null;
    for (const r of rings.values()) {
      if (!r.segs.size) continue;
      if (r.mediaId === exceptId) continue;
      if (!victim || r.lastRequest < victim.lastRequest) victim = r;
    }
    if (!victim) {
      victim = exceptId !== null ? rings.get(exceptId) : null;
      if (!victim || !victim.segs.size) break;
    }
    if (!victim.evictOne()) break;
  }
}

/** Drop one media id's ring entirely (session end, lock, delete, trash). */
function forget(mediaId) {
  const r = rings.get(mediaId);
  if (!r) return false;
  r.clear();
  rings.delete(mediaId);
  return true;
}

/** Drop every ring. */
function clearAll() {
  for (const id of [...rings.keys()]) forget(id);
  totalBytes = 0;
}

/** Rings that have had no segment request for longer than `idleMs`. */
function idleIds(idleMs) {
  const now = Date.now();
  const out = [];
  for (const r of rings.values()) if (now - r.lastRequest > idleMs) out.push(r.mediaId);
  return out;
}

function status() {
  return {
    rings: [...rings.values()].map(r => r.stats()),
    ringBytes: totalBytes,
  };
}

module.exports = {
  BEHIND, MAX_SEGMENTS, MAX_TOTAL_BYTES,
  ringFor, peek, has, get, note, put, forget, clearAll, idleIds, status,
  get totalBytes() { return totalBytes; },
  get size() { return rings.size; },
};
