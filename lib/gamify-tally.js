/**
 * Running tallies over the media table for the gamify layer's per-view and
 * per-page-load numbers, kept current by pure-SQL triggers.
 *
 * Rarity needs "how many files are viewed less than this one", the Polyglot
 * achievement "which languages has anything been watched in", the 💦 counter
 * the sum of every file's finishes. Asked of `media` directly, each walks
 * every viewed (or finished) file: fine in a library that is mostly unwatched,
 * but up to half a second at 2M files when most of them have been played,
 * on every view, and better-sqlite3 blocks the whole server while it runs.
 * The tallies answer them from a few dozen rows.
 *
 *   gamify_tally (kind, k, n)
 *     views / <view count>     files with user_trashed = 0 (as the rarity query
 *                              always had it) and that many views; a NULL count,
 *                              only writable by raw SQL, counts as 0
 *     done  / 'all' | 'kept'   sum of done_count > 0 (all files | untrashed)
 *     lang  / <language>       files with views > 0 in that language (trash too)
 *     av    / 'viewed'|'done'  untrashed video/audio files viewed | finished
 *
 * Triggers are pure SQL on purpose (as in lib/library-index.js): they fire in
 * every connection that writes the file, a CLI scan or an older Vault
 * included, and never call into JS. They are created together with the
 * initial fill in one write transaction, so the tallies start exact and stay
 * exact. The fill reads the search sort indexes and takes about a second at
 * 2M files, once, at server start (install() is only called when those
 * indexes exist). Until it has run, callers get null and ask `media` directly.
 */

const db = require('./database');

/** Bump when a trigger body or the fill changes: install() then redoes both. */
const TALLY_SCHEMA = 1;
const TRIGGERS = ['gamify_tally_ai', 'gamify_tally_ad', 'gamify_tally_au'];
const NEEDS_INDEXES = ['idx_media_sort_views', 'idx_media_sort_done'];

const KEPT = (r) => `COALESCE(${r}.user_trashed, 0) = 0`;
const AV = (r) => `${r}.media_type IN ('video', 'audio')`;
const UPSERT = 'ON CONFLICT (kind, k) DO UPDATE SET n = n + excluded.n;';

/** Add (sign '') or remove (sign '-') one row's contribution. */
function apply(r, sign) {
  const add = (kind, k, n, where) =>
    `INSERT INTO gamify_tally (kind, k, n) SELECT ${kind}, ${k}, ${sign}${n} WHERE ${where} ${UPSERT}`;
  return [
    add("'views'", `COALESCE(${r}.view_count, 0)`, '1', `${r}.user_trashed = 0`),
    add("'done'", "'all'", `COALESCE(${r}.done_count, 0)`, `COALESCE(${r}.done_count, 0) > 0`),
    add("'done'", "'kept'", `COALESCE(${r}.done_count, 0)`, `COALESCE(${r}.done_count, 0) > 0 AND ${KEPT(r)}`),
    add("'lang'", `${r}.language`, '1', `COALESCE(${r}.view_count, 0) > 0 AND ${r}.language IS NOT NULL`),
    add("'av'", "'viewed'", '1', `COALESCE(${r}.view_count, 0) > 0 AND ${AV(r)} AND ${KEPT(r)}`),
    add("'av'", "'done'", '1', `COALESCE(${r}.done_count, 0) > 0 AND ${AV(r)} AND ${KEPT(r)}`),
  ].join('\n    ');
}

const COLS = ['view_count', 'done_count', 'user_trashed', 'language', 'media_type'];

function triggerSql() {
  return `
    CREATE TRIGGER gamify_tally_ai AFTER INSERT ON media BEGIN
    ${apply('new', '')}
    END;
    CREATE TRIGGER gamify_tally_ad AFTER DELETE ON media BEGIN
    ${apply('old', '-')}
    END;
    CREATE TRIGGER gamify_tally_au AFTER UPDATE OF ${COLS.join(', ')} ON media
    WHEN ${COLS.map(c => `old.${c} IS NOT new.${c}`).join(' OR ')} BEGIN
    ${apply('old', '-')}
    ${apply('new', '')}
    END;`;
}

// The fill, phrased for the sort indexes (index-only walks; +language and
// +media_type keep SQLite off the indexes that would visit every row).
const FILL = `
  INSERT INTO gamify_tally (kind, k, n)
    SELECT 'views', COALESCE(view_count, 0), COUNT(*) FROM media WHERE user_trashed = 0 GROUP BY 2;
  INSERT INTO gamify_tally (kind, k, n)
    SELECT 'done', 'all', COALESCE(SUM(COALESCE(done_count, 0)), 0) FROM media WHERE COALESCE(done_count, 0) > 0;
  INSERT INTO gamify_tally (kind, k, n)
    SELECT 'done', 'kept', COALESCE(SUM(COALESCE(done_count, 0)), 0) FROM media
    WHERE COALESCE(done_count, 0) > 0 AND COALESCE(user_trashed, 0) = 0;
  INSERT INTO gamify_tally (kind, k, n)
    SELECT 'lang', language, COUNT(*) FROM media
    WHERE COALESCE(view_count, 0) > 0 AND +language IS NOT NULL GROUP BY +language;
  INSERT INTO gamify_tally (kind, k, n)
    SELECT 'av', 'viewed', COUNT(*) FROM media
    WHERE COALESCE(view_count, 0) > 0 AND +media_type IN ('video', 'audio') AND COALESCE(user_trashed, 0) = 0;
  INSERT INTO gamify_tally (kind, k, n)
    SELECT 'av', 'done', COUNT(*) FROM media
    WHERE COALESCE(done_count, 0) > 0 AND +media_type IN ('video', 'audio') AND COALESCE(user_trashed, 0) = 0;
`;

// Per connection (a lock closes it; an unlock opens a new one)
const _ready = new WeakMap();

function schemaValue(conn) {
  try {
    const row = conn.prepare("SELECT value FROM gamify_cache WHERE key = 'tally_schema'").get();
    return row ? Number(row.value) : 0;
  } catch { return 0; }
}

function triggersPresent(conn) {
  return conn.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => '?').join(', ')})`)
    .get(...TRIGGERS).n === TRIGGERS.length;
}

/** Are the tallies installed and current on this connection? */
function isReady(conn) {
  let r = _ready.get(conn);
  if (r === undefined) {
    r = schemaValue(conn) === TALLY_SCHEMA && triggersPresent(conn);
    _ready.set(conn, r);
  }
  return r;
}

/** True when the fill can read the sort indexes instead of the whole table. */
function canInstallCheaply(conn) {
  const have = new Set(conn.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").pluck().all());
  return NEEDS_INDEXES.every(n => have.has(n));
}

/**
 * Create (or redo) the triggers and fill the tallies, in one transaction.
 * No-op when they are current. Returns the fill time in ms, 0 when nothing
 * was needed, or null when the sort indexes are not there yet (the fill
 * would scan the whole table; try again once they are).
 */
function install(conn = db.get(), { force = false } = {}) {
  if (!force && isReady(conn)) return 0;
  if (!force && !canInstallCheaply(conn)) return null;
  const t0 = Date.now();
  conn.transaction(() => {
    for (const name of TRIGGERS) conn.exec(`DROP TRIGGER IF EXISTS ${name}`);
    conn.exec(`
      CREATE TABLE IF NOT EXISTS gamify_tally (
        kind TEXT NOT NULL,
        k NOT NULL,
        n INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (kind, k)
      ) WITHOUT ROWID;
      DELETE FROM gamify_tally;
    `);
    conn.exec(triggerSql());
    conn.exec(FILL);
    conn.prepare(`
      INSERT INTO gamify_cache (key, value, updated_at) VALUES ('tally_schema', ?, datetime('now', 'localtime'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(TALLY_SCHEMA));
  }).immediate();
  _ready.set(conn, true);
  return Date.now() - t0;
}

/**
 * install() once the sort indexes exist: now when they do, else polled
 * (a library that booted locked creates them after its unlock). Stops when
 * the connection closes; the next unlock calls this again.
 */
function installWhenIndexed(conn, { log = console.log, pollMs = 5000 } = {}) {
  const attempt = () => {
    if (!conn || !conn.open) return;
    try {
      const ms = install(conn);
      if (ms === null) return void setTimeout(attempt, pollMs).unref?.();
      if (ms > 0) log(`  Gamify tallies ready (${ms} ms, one time).`);
    } catch (err) {
      log(`[Gamify] tallies not installed: ${err.message}`);
    }
  };
  attempt();
}

/* ── Reads (null when not installed: the caller asks media itself) ───────── */

/** Run a tally read; a missing table (dropped under us) means "not installed". */
function read(conn, fn) {
  if (!isReady(conn)) return null;
  try { return fn(); } catch { _ready.set(conn, false); return null; }
}

function get(conn, kind, k) {
  return read(conn, () => {
    const row = conn.prepare('SELECT n FROM gamify_tally WHERE kind = ? AND k = ?').get(kind, k);
    return row ? row.n : 0;
  });
}

/** Files with user_trashed = 0, and how many of them have fewer than `views` views. */
function viewsBelow(conn, views) {
  return read(conn, () => conn.prepare(`
    SELECT COALESCE(SUM(n), 0) AS total,
           COALESCE(SUM(CASE WHEN k < ? THEN n ELSE 0 END), 0) AS below
    FROM gamify_tally WHERE kind = 'views'
  `).get(views));
}

/** Sum of done_count over all files (kept=false) or untrashed ones. */
const doneSum = (conn, kept) => get(conn, 'done', kept ? 'kept' : 'all');

/** Distinct raw languages of viewed files. */
function viewedLanguages(conn) {
  return read(conn, () => conn.prepare("SELECT k FROM gamify_tally WHERE kind = 'lang' AND n > 0").pluck().all());
}

/** Untrashed video/audio files viewed (what='viewed') or finished ('done'). */
const avCount = (conn, what) => get(conn, 'av', what);

module.exports = {
  install, installWhenIndexed, isReady,
  viewsBelow, doneSum, viewedLanguages, avCount,
  TALLY_SCHEMA, TRIGGERS,
};
