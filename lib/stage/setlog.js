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
 *                      played_s, ended_at (ms, NULL while it plays)
 *
 * The names are for the streamer only: nothing here is ever shown on Stage.
 */

const IDLE_MS = 30 * 60 * 1000;
const SKIP_S = 30;
const KEEP_SETS = 20;

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
      ended_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_stage_set_entries_set ON stage_set_entries(set_id, started_at);
  `);
}

/**
 * @param {object} o
 * @param {() => object} o.db         the database (better-sqlite3 style), asked for on each use
 * @param {() => number} [o.now]      clock in ms
 * @param {(id: number) => string|null} [o.titleFor]  the file's name in the library now
 * @param {() => boolean} [o.isLocked]  no writes while Vault is locked (kept in memory, written after)
 */
function createSetLog({ db, now = Date.now, titleFor = null, isLocked = () => false } = {}) {
  // The set being recorded, in memory: { id, startedAt, entry, idleSince }.
  // entry: { rowId, mediaId, title, key, startedAt, playedMs, segStart } (segStart: playing since, or null).
  let cur = null;
  let last = null;            // the file on Stage now: { id, title, key }, so a resume after an idle end can start a new set
  let tidied = false;

  const D = () => db();
  const canWrite = () => !isLocked();

  /** Sets left open by an earlier run (Vault quit with Stage playing) end where their last file did. */
  function tidy() {
    if (tidied || !canWrite()) return;
    tidied = true;
    try {
      const d = D();
      const open = d.prepare('SELECT id, started_at FROM stage_sets WHERE ended_at IS NULL').all();
      for (const s of open) {
        if (cur && cur.id === s.id) continue;
        const rows = d.prepare('SELECT id, started_at, played_s FROM stage_set_entries WHERE set_id = ?').all(s.id);
        let end = s.started_at;
        for (const r of rows) {
          const e = r.started_at + Math.round(r.played_s * 1000);
          if (e > end) end = e;
          d.prepare('UPDATE stage_set_entries SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(e, r.id);
        }
        d.prepare('UPDATE stage_sets SET ended_at = ? WHERE id = ?').run(end, s.id);
      }
    } catch { tidied = false; }
  }

  function playedMs(e, t = now()) {
    return e.playedMs + (e.segStart != null ? Math.max(0, t - e.segStart) : 0);
  }

  function saveEntry(e, ended = null) {
    if (!canWrite() || !e.rowId) return;
    try {
      D().prepare('UPDATE stage_set_entries SET played_s = ?, ended_at = COALESCE(?, ended_at) WHERE id = ?')
        .run(Math.round(playedMs(e)) / 1000, ended, e.rowId);
    } catch {}
  }

  function prune() {
    try {
      const d = D();
      const old = d.prepare('SELECT id FROM stage_sets ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?').all(KEEP_SETS);
      for (const s of old) {
        d.prepare('DELETE FROM stage_set_entries WHERE set_id = ?').run(s.id);
        d.prepare('DELETE FROM stage_sets WHERE id = ?').run(s.id);
      }
    } catch {}
  }

  /** The file playing now stops being played (its entry ends). */
  function endEntry(t = now()) {
    if (!cur || !cur.entry) return;
    const e = cur.entry;
    if (e.segStart != null) { e.playedMs += Math.max(0, t - e.segStart); e.segStart = null; }
    saveEntry(e, t);
    cur.entry = null;
    if (cur.idleSince == null) cur.idleSince = t;
  }

  /** The set ends at t (Stage closed, or idle since t). */
  function endSet(t = now()) {
    if (!cur) return;
    endEntry(t);
    if (canWrite()) {
      try { D().prepare('UPDATE stage_sets SET ended_at = ? WHERE id = ?').run(t, cur.id); } catch {}
    }
    cur = null;
  }

  /** An open set with nothing played for IDLE_MS has ended (when playing stopped). */
  function checkIdle(t = now()) {
    if (cur && !playingNow() && cur.idleSince != null && t - cur.idleSince >= IDLE_MS) endSet(cur.idleSince);
  }

  const playingNow = () => !!(cur && cur.entry && cur.entry.segStart != null);

  function newSet(t) {
    tidy();
    cur = { id: null, startedAt: t, entry: null, idleSince: null };
    if (canWrite()) {
      try {
        cur.id = Number(D().prepare('INSERT INTO stage_sets (started_at) VALUES (?)').run(t).lastInsertRowid);
        prune();
      } catch {}
    }
  }

  function titleOf(id, given) {
    let t = '';
    if (typeof titleFor === 'function') { try { t = titleFor(id) || ''; } catch {} }
    return String(t || given || '').slice(0, 1024);
  }

  /**
   * A file starts on Stage: a new entry (in a new set when none is open).
   * playing: it is playing at once (Basic says so; mpv's next status does).
   */
  function start({ id, title = '', key = null, playing = false } = {}) {
    if (!Number.isInteger(id) || id <= 0) return;
    // The same play told again (mpv picking its file up after an unlock): still one entry.
    if (key != null && cur && cur.entry && cur.entry.key === key) return;
    const t = now();
    checkIdle(t);
    if (cur && cur.entry) endEntry(t);
    if (!cur) newSet(t);
    const name = titleOf(id, title);
    last = { id, title: name, key };
    const e = { rowId: null, mediaId: id, title: name, key, startedAt: t, playedMs: 0, segStart: playing ? t : null };
    cur.entry = e;
    cur.idleSince = playing ? null : (cur.idleSince != null ? cur.idleSince : t);
    if (canWrite() && cur.id) {
      try {
        e.rowId = Number(D().prepare('INSERT INTO stage_set_entries (set_id, media_id, title, started_at, played_s) VALUES (?, ?, ?, ?, 0)')
          .run(cur.id, id, name, t).lastInsertRowid);
      } catch {}
    }
  }

  /**
   * Playing or not (paused, held, loading, locked). key: the file the report
   * is about; one that is not the current entry's is ignored.
   */
  function playing(on, key) {
    const t = now();
    if (on) {
      // Nothing playing for 30 minutes and then a resume: a new set, this file first.
      checkIdle(t);
      if (!cur || !cur.entry) {
        if (last && (key == null || key === last.key)) start({ ...last, playing: true });
        return;
      }
      const e = cur.entry;
      if (key != null && e.key != null && key !== e.key) return;
      if (e.segStart == null) { e.segStart = t; cur.idleSince = null; }
      return;
    }
    if (!cur || !cur.entry) return;
    const e = cur.entry;
    if (key != null && e.key != null && key !== e.key) return;
    if (e.segStart != null) {
      e.playedMs += Math.max(0, t - e.segStart);
      e.segStart = null;
      cur.idleSince = t;
      saveEntry(e);
    }
  }

  /** Nothing is on Stage any more (the list finished, the file could not play, mpv went away). */
  function stop() { endEntry(); last = null; }

  /** Stage closed: the set ends. */
  function close() { endSet(); last = null; }

  /* ── Reading ─────────────────────────────────────────────────────── */

  /** The last sets, newest first: { id, startedAt, endedAt, open, played, duration }. */
  function sets() {
    checkIdle();
    tidy();
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
      const ended = !live;
      return {
        id: r.id, mediaId: r.media_id, title: r.title, startedAt: r.started_at,
        offset: Math.max(0, Math.round((r.started_at - base) / 1000)),
        played: Math.round(played * 10) / 10,
        now: live,
        skipped: ended && played < SKIP_S,
      };
    });
  }

  /** One set and its entries (newest first), or null. */
  function setById(id) {
    checkIdle();
    const d = D();
    const r = d.prepare('SELECT id, started_at, ended_at FROM stage_sets WHERE id = ?').get(id);
    if (!r) return null;
    const entries = entriesOf(id);
    return {
      set: { id: r.id, startedAt: r.started_at, endedAt: r.ended_at, open: !!(cur && cur.id === r.id), played: entries.filter(e => !e.skipped).length },
      entries,
    };
  }

  return { start, playing, stop, close, sets, setById, _cur: () => cur };
}

module.exports = { ensureSchema, createSetLog, IDLE_MS, SKIP_S, KEEP_SETS };
