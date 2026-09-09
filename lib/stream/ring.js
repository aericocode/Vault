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
 * Retention:
 *   - every CLIENT of a media id has its own playhead (the highest segment
 *     number that client has asked for), and the ring keeps the UNION of their
 *     windows: a segment survives while it is inside [playhead - BEHIND, head]
 *     for at least one client that is still asking for segments.
 *   - a segment somebody is currently WAITING for is never evicted, by any cap.
 *   - at most MAX_SEGMENTS per session, and MAX_TOTAL_BYTES across all of them,
 *     and at most MAX_CLIENTS playheads per ring (past that the client that
 *     asked longest ago gives up its slot), so a flood of one-shot tokens
 *     cannot grow the bookkeeping without bound.
 *   - when something has to go: the oldest one below every playhead first, then
 *     whatever is furthest from the nearest playhead.
 * A request for a segment that was dropped simply restarts the producer at that
 * number, which is the same path a seek already takes.
 *
 * Round 3 follow-up (two clients on one file). With a single playhead, two
 * players on the same media id starved each other: a seek by one pulled the
 * window away from the segment the other had just restarted the producer for,
 * so trim() threw it away the instant FFmpeg made it and the waiting request
 * timed out with a 503. Per-client playheads fix the window, and the waiter
 * pins fix the race between "the segment arrived" and "a cap wanted it gone".
 */

/** Segments kept behind the playhead, so a small back-seek does not re-remux. */
const BEHIND = 15;

/** Hard cap on one session's ring. */
const MAX_SEGMENTS = 48;

/** Hard cap across every ring in the process. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * A client that has not asked for a segment in this long stops holding a
 * window open. Long enough that a paused player keeps its buffers (segments
 * are 4 s and hls.js buffers 60 s ahead, so a playing client can legitimately
 * go quiet for a while), short enough that a tab whose close beacon never
 * arrived does not pin RAM until the idle sweeper fires.
 */
const CLIENT_TTL_MS = 20000;

/**
 * Hard cap on how many clients one ring tracks. Without it the map is bounded
 * only by request rate times CLIENT_TTL_MS: a caller that mints a fresh `?c=`
 * token per request grew it to 28,772 entries in a 20 s flood, and note(),
 * playheads() and evictOne() all walk it once per segment. Nothing real needs
 * more than a handful of players on one file, so past the cap the client that
 * asked longest ago gives up its slot to the new one.
 */
const MAX_CLIENTS = 32;

/** Requests that carry no client token share this one. */
const DEFAULT_CLIENT = '-';

/** mediaId -> Ring */
const rings = new Map();

let totalBytes = 0;

class Ring {
  constructor(mediaId) {
    this.mediaId = mediaId;
    this.segs = new Map();          // n -> Buffer
    this.waiters = new Map();       // n -> how many requests are blocked on it
    this.clients = new Map();       // token -> { playhead, lastRequest }
    this.bytes = 0;
    this.playhead = 0;              // highest live client playhead (status + fallback)
    this.head = -1;                 // highest n the producer has delivered
    this.produced = 0;              // segments ingested by this ring, ever
    this.lastRequest = Date.now();
    this.createdAt = Date.now();
  }

  has(n) { return this.segs.has(n); }
  get(n) { return this.segs.get(n) || null; }

  /* -- Clients ----------------------------------------------------------- */

  /** Forget clients that have gone quiet, so their windows stop being kept. */
  _prune() {
    const cut = Date.now() - CLIENT_TTL_MS;
    for (const [token, c] of this.clients) if (c.lastRequest < cut) this.clients.delete(token);
  }

  /**
   * Make room for one new client: prune the quiet ones first, and if the map is
   * still at MAX_CLIENTS drop whoever asked longest ago. Age, not arrival order,
   * so a real player that keeps requesting is never the one thrown out.
   */
  _makeRoom() {
    if (this.clients.size < MAX_CLIENTS) return;
    this._prune();
    while (this.clients.size >= MAX_CLIENTS) {
      let oldest = null, oldestAt = Infinity;
      for (const [token, c] of this.clients) {
        if (c.lastRequest < oldestAt) { oldest = token; oldestAt = c.lastRequest; }
      }
      if (oldest === null) return;
      this.clients.delete(oldest);
    }
  }

  /**
   * Every live client's playhead, ascending. Falls back to the last known one
   * when they have all gone quiet, so a ring whose readers vanished still trims
   * around where they were rather than around zero.
   */
  playheads() {
    this._prune();
    const out = [];
    for (const c of this.clients.values()) out.push(c.playhead);
    if (!out.length) return [this.playhead];
    return out.sort((a, b) => a - b);
  }

  /** How many clients are still asking for segments. */
  clientCount() {
    this._prune();
    return this.clients.size;
  }

  /** Stop keeping a window for one client (its player closed). */
  dropClient(token) {
    this._prune();
    const had = this.clients.delete(token || DEFAULT_CLIENT);
    return { removed: had, remaining: this.clients.size };
  }

  /**
   * Record that a client asked for segment n (moves THAT client's playhead).
   *
   * Forward always moves it. Backward only moves it when the request lands
   * outside the retention window, which is the difference between "the player
   * nudged back a few seconds" (keep everything, including what is buffered
   * ahead) and "someone seeked backwards" (the window has to follow them, or
   * trim() throws every newly made segment away the instant it arrives and the
   * request that caused the restart times out waiting for it).
   *
   * Per client, not per ring: a second player seeking elsewhere in the same
   * file must not drag the first player's window off the segments it is about
   * to need, which is exactly how the two-client starvation happened.
   */
  note(n, token = DEFAULT_CLIENT) {
    this.lastRequest = Date.now();
    if (!Number.isInteger(n)) return;
    const key = token || DEFAULT_CLIENT;
    let c = this.clients.get(key);
    if (!c) { this._makeRoom(); c = { playhead: n, lastRequest: 0 }; this.clients.set(key, c); }
    c.lastRequest = Date.now();
    if (n > c.playhead || n < c.playhead - BEHIND) c.playhead = n;
    const heads = this.playheads();
    this.playhead = heads[heads.length - 1];
  }

  /* -- Waiter pins ------------------------------------------------------- */

  /**
   * "A request is blocked on segment n." Between the pin and its release no cap
   * may drop n, so a segment cannot be produced for a waiter and thrown away
   * before that waiter gets to read it. Pinned segments still count towards
   * MAX_SEGMENTS; they are simply not eligible to be the one that goes, which
   * is the deliberate trade: serve the waiter, then shrink.
   */
  hold(n) {
    if (!Number.isInteger(n)) return;
    this.waiters.set(n, (this.waiters.get(n) || 0) + 1);
  }

  release(n) {
    const c = this.waiters.get(n);
    if (!c) return;
    if (c <= 1) this.waiters.delete(n);
    else this.waiters.set(n, c - 1);
  }

  pinned(n) { return this.waiters.has(n); }

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
   * The one eviction choice, shared by every cap: whatever is behind EVERY
   * client goes first (they have all watched it), lowest number first, and only
   * when nothing is behind everyone does the ring give up the segment furthest
   * from the nearest playhead. With two clients far apart that is the middle of
   * the gap, which is the part neither of them is about to play.
   *
   * Segments with a waiter are never picked. With one client this is exactly
   * the old rule: everything below the playhead first, then the furthest ahead.
   */
  evictOne() {
    const heads = this.playheads();
    const lowest = heads[0];
    let behind = null, other = null, otherDist = -1;
    for (const n of this.segs.keys()) {
      if (this.pinned(n)) continue;
      if (n < lowest) {
        if (behind === null || n < behind) behind = n;
        continue;
      }
      let d = Infinity;
      for (const h of heads) { const x = Math.abs(n - h); if (x < d) d = x; }
      if (d > otherDist || (d === otherDist && n < other)) { other = n; otherDist = d; }
    }
    const pick = behind !== null ? behind : other;
    if (pick === null) return false;
    return this.drop(pick);
  }

  /** Apply the retention window (the union of every client's) and this ring's cap. */
  trim() {
    const floor = this.playheads()[0] - BEHIND;
    for (const n of [...this.segs.keys()]) {
      if (n < floor && !this.pinned(n)) this.drop(n);
    }
    while (this.segs.size > MAX_SEGMENTS && this.evictOne());
  }

  clear() {
    for (const n of [...this.segs.keys()]) this.drop(n);
    this.waiters.clear();
    this.clients.clear();
  }

  stats() {
    return {
      mediaId: this.mediaId,
      playhead: this.playhead,
      playheads: this.playheads(),
      clients: this.clientCount(),
      waiting: this.waiters.size,
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

/** Note a client request for segment n (moves that client's playhead, resets the idle clock). */
function note(mediaId, n, token) {
  ringFor(mediaId).note(n, token);
}

/** Pin segment n for a request that is about to block on it. */
function hold(mediaId, n) {
  ringFor(mediaId).hold(n);
}

/**
 * Release a pin, and re-apply the caps the pin was holding off. Doing it here
 * rather than waiting for the next put() is what keeps the over-cap window as
 * short as the request that caused it.
 */
function release(mediaId, n) {
  const r = rings.get(mediaId);
  if (!r) return;
  r.release(n);
  r.trim();
  enforceTotal();
}

/**
 * One client is done with this media id. Returns how many other clients are
 * still watching it, which is what tells the close beacon whether the whole
 * session may go or only this tab's window.
 */
function dropClient(mediaId, token) {
  const r = rings.get(mediaId);
  if (!r) return { removed: false, remaining: 0 };
  return r.dropClient(token);
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
  CLIENT_TTL_MS, MAX_CLIENTS, DEFAULT_CLIENT,
  ringFor, peek, has, get, note, put, forget, clearAll, idleIds, status,
  hold, release, dropClient,
  get totalBytes() { return totalBytes; },
  get size() { return rings.size; },
};
