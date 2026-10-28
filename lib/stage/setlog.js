/**
 * Stage set log: what Stage played, so the streamer can answer "what video
 * was that?" an hour later. Kept on the server, so it records whether the
 * Vault tab is in front or not, for mpv Stage (the hub tells it,
 * lib/stage/hub.js) and Basic Stage (the page tells it, POST
 * /api/stage/setlog/basic in server/stage-routes.js).
 *
 * A set starts when Stage starts playing and ends when Stage is closed, or
 * once nothing has played for IDLE_MS. Each entry is one file played: its
 * media id, its title at the time, the clock time it started, its offset
 * from the set's start and how long it actually played (pauses don't count
 * and don't make a new entry; the same file played again later is a new
 * entry). A file played for less than SKIP_S counts as skipped.
 *
 * Two small tables in Vault's database, the last KEEP_SETS sets kept:
 *   stage_sets         id, started_at (ms), ended_at (ms, NULL while open)
 *   stage_set_entries  id, set_id, media_id, title, started_at (ms),
 *                      played_s, ended_at (ms, NULL while it plays),
 *                      seen_at (ms: when played_s was last written)
 *
 * Writing: what is playing is written every FLUSH_MS (tick(), and on each
 * report), so a quit or crash loses at most that much; the next start
 * ends such a set where its file was last seen. While Vault is locked
 * nothing is written: each write waits, in order, and is done after the
 * unlock (flush(), or the next write or read).
 *
 * Basic Stage plays in a page, which can go away without a word (a reload,
 * a closed tab, a crash): it reports at least every BASIC_BEAT_MS, and a
 * Basic file with no report for BASIC_STALE_MS has stopped where it was
 * last heard of.
 *
 * The names are for the streamer only: nothing here is ever shown on Stage.
 */

const IDLE_MS = 30 * 60 * 1000;
const SKIP_S = 30;
const KEEP_SETS = 20;
const FLUSH_MS = 20 * 1000;
const BASIC_STALE_MS = 90 * 1000;
const MAX_PENDING = 2000;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_sets (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS stage_set_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      set_id     INTEGER NOT NULL,
      media_id   INTEGER NOT NULL,
      title      TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      played_s   REAL NOT NULL DEFAULT 0,
      ended_at   INTEGER,
      seen_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_stage_set_entries_set ON stage_set_entries(set_id, started_at);
  `);
  // Tables made before seen_at existed.
  const cols = db.prepare('PRAGMA table_info(stage_set_entries)').all().map(c => c.name);
  if (!cols.includes('seen_at')) db.exec('ALTER TABLE stage_set_entries ADD COLUMN seen_at INTEGER');
}

/**
 * @param {object} o
 * @param {() => object} o.db         the database (better-sqlite3 style), asked for on each use
 * @param {() => number} [o.now]      clock in ms
 * @param {(id: number) => string|null} [o.titleFor]  the file's name in the library now
 * @param {() => boolean} [o.isLocked]  while true, writes wait (done after the unlock)
 */
function createSetLog({ db, now = Date.now, titleFor = null, isLocked = () => false } = {}) {
  // The set being recorded, in memory: { id, startedAt, entry, idleSince }.
  // entry: { rowId, mediaId, title, key, basic, startedAt, playedMs, segStart, flushedAt, heardAt }
  //   segStart: playing since, or null; heardAt: Basic's last report.
  let cur = null;
  let last = null;            // the file on Stage now: { id, title, key, basic }, so a resume after an idle end can start a new set
  let tidied = false;
  const pending = [];         // writes waiting for the unlock, in order

  const D = () => db();

  /** Do a write now, or after the unlock (in order). Each write keeps the values of its own moment. */
  function write(fn) {
    if (pending.length < MAX_PENDING) pending.push(fn);
    flush();
  }

  /** The writes that waited (for the unlock, or after a failed try), in order. */
  function flush() {
    if (isLocked()) return;
    while (pending.length) {
      const fn = pending[0];
      try {
        fn(D());
      } catch {
        // The database not ready yet: tried again later, a few times at most.
        fn.tries = (fn.tries || 0) + 1;
        if (fn.tries < 3) return;
      }
      pending.shift();
    }
  }

  /**
   * Sets left open by an earlier run (Vault quit or crashed with Stage
   * playing): each open file ends where it was last written, the set at the
   * last of them.
   */
  function tidy() {
    if (tidied || isLocked() || pending.length) return;
    tidied = true;
    try {
      const d = D();
      const open = d.prepare('SELECT id, started_at FROM stage_sets WHERE ended_at IS NULL').all();
      for (const s of open) {
        if (cur && cur.id === s.id) continue;
        const rows = d.prepare('SELECT id, started_at, played_s, ended_at, seen_at FROM stage_set_entries WHERE set_id = ?').all(s.id);
        let end = s.started_at;
        for (const r of rows) {
          let e = r.ended_at;
          if (e == null) {
            e = Math.max(r.seen_at || 0, r.started_at + Math.round(r.played_s * 1000));
            d.prepare('UPDATE stage_set_entries SET ended_at = ? WHERE id = ?').run(e, r.id);
          }
          if (e > end) end = e;
        }
        d.prepare('UPDATE stage_sets SET ended_at = ? WHERE id = ?').run(end, s.id);
      }
    } catch { tidied = false; }
  }

  function playedMs(e, t = now()) {
    return e.playedMs + (e.segStart != null ? Math.max(0, t - e.segStart) : 0);
  }

  /** Write an entry's played time as of t (and its end, when it ended). */
  function saveEntry(e, t = now(), ended = null) {
    const played = Math.round(playedMs(e, t)) / 1000;
    e.flushedAt = t;
    write((d) => {
      if (!e.rowId) return;
      d.prepare('UPDATE stage_set_entries SET played_s = ?, seen_at = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?')
        .run(played, t, ended, e.rowId);
    });
  }

  function prune(d) {
    const old = d.prepare('SELECT id FROM stage_sets ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?').all(KEEP_SETS);
    for (const s of old) {
      d.prepare('DELETE FROM stage_set_entries WHERE set_id = ?').run(s.id);
      d.prepare('DELETE FROM stage_sets WHERE id = ?').run(s.id);
    }
  }

  /** The file playing now stops being played at t (its entry ends). */
  function endEntry(t = now()) {
    if (!cur || !cur.entry) return;
    const e = cur.entry;
    if (e.segStart != null) { e.playedMs += Math.max(0, t - e.segStart); e.segStart = null; }
    saveEntry(e, t, t);
    cur.entry = null;
    if (cur.idleSince == null || cur.idleSince > t) cur.idleSince = t;
  }

  /** The set ends at t (Stage closed, or idle since t). */
  function endSet(t = now()) {
    if (!cur) return;
    endEntry(t);
    const s = cur;
    write((d) => { if (s.id) d.prepare('UPDATE stage_sets SET ended_at = ? WHERE id = ?').run(t, s.id); });
    cur = null;
  }

  const playingNow = () => !!(cur && cur.entry && cur.entry.segStart != null);

  /**
   * Time passing: a Basic page not heard from has stopped where it was last
   * heard of; nothing played for IDLE_MS ends the set (when playing stopped).
   */
  function checkIdle(t = now()) {
    const e = cur && cur.entry;
    if (e && e.basic && t - e.heardAt >= BASIC_STALE_MS) {
      const at = Math.max(e.startedAt, e.heardAt);
      if (e.segStart != null && e.segStart > at) e.segStart = at;
      // last stays: a page that was only asleep and plays on starts a new entry for it.
      endEntry(at);
    }
    if (cur && !playingNow() && cur.idleSince != null && t - cur.idleSince >= IDLE_MS) endSet(cur.idleSince);
  }

  function newSet(t) {
    tidy();
    const s = { id: null, startedAt: t, entry: null, idleSince: null };
    cur = s;
    write((d) => {
      s.id = Number(d.prepare('INSERT INTO stage_sets (started_at) VALUES (?)').run(t).lastInsertRowid);
      prune(d);
    });
  }

  function titleOf(id, given) {
    let t = '';
    if (typeof titleFor === 'function') { try { t = titleFor(id) || ''; } catch {} }
    return String(t || given || '').slice(0, 1024);
  }

  /**
   * A file starts on Stage: a new entry (in a new set when none is open).
   * playing: it is playing at once (Basic says so; mpv's next status does).
   * basic: Basic Stage's, kept alive by the page's reports.
   */
  function start({ id, title = '', key = null, playing = false, basic = false } = {}) {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    // The same play told again (mpv picking its file up after an unlock): still one entry.
    if (key != null && cur && cur.entry && cur.entry.key === key) return;
    const t = now();
    checkIdle(t);
    if (cur && cur.entry) endEntry(t);
    if (!cur) newSet(t);
    const name = titleOf(id, title);
    last = { id, title: name, key, basic };
    const e = { rowId: null, mediaId: id, title: name, key, basic, startedAt: t, playedMs: 0, segStart: playing ? t : null, flushedAt: t, heardAt: t };
    cur.entry = e;
    cur.idleSince = playing ? null : (cur.idleSince != null ? cur.idleSince : t);
    const s = cur;
    write((d) => {
      if (!s.id) return;
      e.rowId = Number(d.prepare('INSERT INTO stage_set_entries (set_id, media_id, title, started_at, played_s, seen_at) VALUES (?, ?, ?, ?, 0, ?)')
        .run(s.id, id, name, t, t).lastInsertRowid);
    });
  }

  /**
   * Playing or not (paused, held, loading, locked). key: the file the report
   * is about; one that is not the current entry's is ignored.
   */
  function playing(on, key) {
    const t = now();
    checkIdle(t);
    if (on) {
      // Nothing playing for 30 minutes and then a resume: a new set, this file first.
      if (!cur || !cur.entry) {
        if (last && (key == null || key === last.key)) start({ ...last, playing: true });
        return;
      }
      const e = cur.entry;
      if (key != null && e.key != null && key !== e.key) return;
      if (e.segStart == null) { e.segStart = t; cur.idleSince = null; }
      else if (t - e.flushedAt >= FLUSH_MS) saveEntry(e, t);
      return;
    }
    if (!cur || !cur.entry) return;
    const e = cur.entry;
    if (key != null && e.key != null && key !== e.key) return;
    if (e.segStart != null) {
      e.playedMs += Math.max(0, t - e.segStart);
      e.segStart = null;
      cur.idleSince = t;
      saveEntry(e, t);
    }
  }

  /** Nothing is on Stage any more (the list finished, the file could not play, mpv went away). */
  function stop() { checkIdle(); endEntry(); last = null; }

  /** Stage closed: the set ends. */
  function close() { checkIdle(); endSet(); last = null; }

  /** Every so often (server/stage-routes.js): stale Basic pages, the idle end, what plays written. */
  function tick() {
    const t = now();
    flush();
    checkIdle(t);
    const e = cur && cur.entry;
    if (e && e.segStart != null && t - e.flushedAt >= FLUSH_MS) saveEntry(e, t);
  }

  /* ── Basic Stage's reports ───────────────────────────────────────── */

  let basicPlay = 0;
  const basicOwns = () => !cur || !cur.entry || cur.entry.basic;

  /**
   * One report from the Basic Stage page: start (with id), playing, paused,
   * beat (still there), stopped, closed. Only ever about Basic's own file:
   * one from a page while mpv Stage plays changes nothing.
   */
  function basic(state, { id, title = '' } = {}) {
    const t = now();
    checkIdle(t);
    if (state === 'start') {
      if (!basicOwns() && playingNow()) return;
      basicPlay += 1;
      start({ id, title, key: `basic-${basicPlay}`, playing: true, basic: true });
      return;
    }
    if (!basicOwns()) return;
    const e = cur && cur.entry;
    if (e) e.heardAt = t;
    if (state === 'playing') playing(true, e ? e.key : (last && last.basic ? last.key : '-'));
    else if (state === 'paused') playing(false, e ? e.key : '-');
    else if (state === 'beat') { if (e && e.segStart != null && t - e.flushedAt >= FLUSH_MS) saveEntry(e, t); }
    else if (state === 'stopped') { if (e) endEntry(t); last = null; }
    else if (state === 'closed') { if (cur) endSet(t); last = null; }
  }

  /* ── Reading ─────────────────────────────────────────────────────── */

  function readable() { flush(); checkIdle(); tidy(); }

  /** The last sets, newest first: { id, startedAt, endedAt, open, played, duration }. */
  function sets() {
    readable();
    const d = D();
    const rows = d.prepare('SELECT id, started_at, ended_at FROM stage_sets ORDER BY started_at DESC, id DESC LIMIT ?').all(KEEP_SETS);
    const t = now();
    return rows.map((r) => {
      const ents = entriesOf(r.id);
      const open = cur && cur.id === r.id;
      const end = r.ended_at != null ? r.ended_at : (open ? t : Math.max(r.started_at, ...ents.map(e => e.startedAt + e.played * 1000)));
      return {
        id: r.id, startedAt: r.started_at, endedAt: r.ended_at, open: !!open,
        played: ents.filter(e => !e.skipped).length,
        duration: Math.max(0, Math.round((end - r.started_at) / 1000)),
      };
    });
  }

  function entriesOf(setId) {
    const d = D();
    const rows = d.prepare('SELECT id, media_id, title, started_at, played_s, ended_at FROM stage_set_entries WHERE set_id = ? ORDER BY started_at DESC, id DESC').all(setId);
    const set = d.prepare('SELECT started_at FROM stage_sets WHERE id = ?').get(setId);
    const base = set ? set.started_at : 0;
    const t = now();
    return rows.map((r) => {
      const live = !!(cur && cur.entry && cur.entry.rowId === r.id);
      const played = live ? playedMs(cur.entry, t) / 1000 : r.played_s;
      return {
        id: r.id, mediaId: r.media_id, title: r.title, startedAt: r.started_at,
        offset: Math.max(0, Math.round((r.started_at - base) / 1000)),
        played: Math.round(played * 10) / 10,
        now: live,
        paused: live && cur.entry.segStart == null,
        skipped: !live && played < SKIP_S,
      };
    });
  }

  /** One set and its entries (newest first), or null. */
  function setById(id) {
    readable();
    const d = D();
    const r = d.prepare('SELECT id, started_at, ended_at FROM stage_sets WHERE id = ?').get(id);
    if (!r) return null;
    const entries = entriesOf(id);
    return {
      set: { id: r.id, startedAt: r.started_at, endedAt: r.ended_at, open: !!(cur && cur.id === r.id), played: entries.filter(e => !e.skipped).length },
      entries,
    };
  }

  return { start, playing, stop, close, basic, tick, flush, sets, setById, _cur: () => cur, _pending: () => pending.length };
}

module.exports = { ensureSchema, createSetLog, IDLE_MS, SKIP_S, KEEP_SETS, FLUSH_MS, BASIC_STALE_MS };
