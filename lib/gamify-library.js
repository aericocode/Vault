/**
 * Library profile for the gamify layer: the library-wide numbers that quest
 * generation and the Full Stats page draw from (underexplored labels, how
 * many unseen / unrated / 4K / subtitled... files there are, library growth,
 * rare tags, total content time).
 *
 * Every one of these needs a pass over the whole media table, and
 * better-sqlite3 blocks the server while a statement runs: at 2M files that
 * pass is over a minute, during which no request is answered. So the pass is
 * done in slices by id (each one transaction-free read of about
 * SLICE_TARGET_MS, the event loop in between) and its result is kept:
 *
 *   - A small library finishes the pass inside SYNC_BUDGET_MS, right in the
 *     call, and is recomputed on every call. Nothing is cached, so the numbers
 *     are always current, exactly as before this module existed.
 *   - A larger library continues the pass in the background. Callers get the
 *     last profile (in memory, or persisted in gamify_cache so a restart does
 *     not redo it), or null when there has never been one. The profile is
 *     refreshed in the background once it is older than its caller allows
 *     (REFRESH_MS for quests), or sooner (REFRESH_ON_CHANGE_MS) when the file
 *     count has changed since: an import or a delete.
 *
 * These numbers only steer which quests are offered and draw library-shape
 * charts, so a profile a few hours old is fine. Nothing that scores the
 * user (points, streak, quest progress) reads from here.
 */

const db = require('./database');

/** Bump when the profile's shape changes; an older persisted one is ignored. */
const PROFILE_SCHEMA = 1;
const CACHE_KEY = 'library_profile';

let SYNC_BUDGET_MS = 80;
const SLICE_TARGET_MS = 50;
const SLICE_ROWS = 50000;   // per statement; a slice normally stops on time first

const REFRESH_MS = 12 * 3600 * 1000;
const REFRESH_ON_CHANGE_MS = 10 * 60 * 1000;

// Quest attainability: a count quest needs 2 + CHOICE_SLACK distinct items (lib/quests.js)
const LABEL_MIN_ITEMS = 5;
const LANGUAGE_MIN_ITEMS = 5;
const TOP_LABELS = 20;
const UNDER_TAGS_KEPT = 500;

const WATCH_TYPES = new Set(['video', 'audio']);
const NON_LANGUAGES = new Set(['unknown', 'none', 'n/a', 'na', 'code', 'not applicable']);

/** SQLite lower(): ASCII only. */
const asciiLower = (s) => s.replace(/[A-Z]/g, c => c.toLowerCase());

/** Normalized theme ∪ tag labels (clean columns preferred), as lib/quests.js. */
function labelsOf(row) {
  const out = new Set();
  for (const col of [row.themes_clean ?? row.themes, row.tags_clean ?? row.tags]) {
    try {
      const arr = JSON.parse(col || '[]');
      if (Array.isArray(arr)) for (const v of arr) {
        const s = String(v).trim().toLowerCase();
        if (s) out.add(s);
      }
    } catch { /* unparseable column — contributes nothing */ }
  }
  return out;
}

/** Distinct-content counter: confirmed duplicates count once per group. */
function distinct() {
  const groups = new Set();
  let n = 0;
  return {
    add(r) { if (r.dupe_group == null) n++; else groups.add(r.dupe_group); },
    get value() { return n + groups.size; },
  };
}

/* ── The pass ──────────────────────────────────────────────────────────── */

function tableExists(conn, name) {
  return !!conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** A fresh accumulator; step() feeds it slices until done. */
function newPass(conn) {
  const hasSubs = tableExists(conn, 'subtitle_tracks');
  // Label text is only read for rows that can feed a label (untrashed A/V);
  // raw tags for the rare-tags chart only for untrashed rows that have some.
  const stmt = conn.prepare(`
    SELECT m.id, m.dupe_group, m.media_type, m.user_trashed, m.view_count, m.done_count,
           m.user_rating, m.user_starred, m.language, m.duration_seconds, m.filesize_bytes,
           m.width, m.height, m.created_at IS NOT NULL AS has_created, date(m.created_at) AS created_day,
           CASE WHEN m.user_trashed = 0 AND m.media_type IN ('video', 'audio') THEN m.themes END AS themes,
           CASE WHEN COALESCE(m.user_trashed, 0) = 0 THEN m.tags END AS tags,
           CASE WHEN m.user_trashed = 0 AND m.media_type IN ('video', 'audio') THEN mc.themes END AS themes_clean,
           CASE WHEN m.user_trashed = 0 AND m.media_type IN ('video', 'audio') THEN mc.tags END AS tags_clean,
           ${hasSubs ? 'EXISTS (SELECT 1 FROM subtitle_tracks st WHERE st.media_id = m.id)' : '0'} AS has_sub
    FROM media m LEFT JOIN media_clean mc ON mc.media_id = m.id
    WHERE m.id > ? ORDER BY m.id LIMIT ?
  `);
  return {
    stmt, lastId: -Infinity, done: false, rows: 0,
    labels: new Map(),   // label → { items, views, groups:Set }
    unseenSingles: 0, unseenGroups: new Map(),   // dupe group → max views
    watchable: distinct(), video: distinct(), audio: distinct(),
    subtitled: distinct(), longform: distinct(), shorts: distinct(), hiRes: distinct(),
    languages: new Map(),   // language → distinct()
    unrated: 0, total: 0, unfaved: 0,
    growth: new Map(),   // day → count (rows with a created_at, trash included)
    tagCount: new Map(),   // raw tag (as text) → files
    milestones: { secs: 0, bytes: 0, items: 0 },
  };
}

function addRow(p, r) {
  if (r.has_created) p.growth.set(r.created_day, (p.growth.get(r.created_day) || 0) + 1);

  // Full Stats: rare tags and library totals (untrashed, NULL counts as kept)
  if (!r.user_trashed) {
    p.milestones.items++;
    p.milestones.secs += r.duration_seconds || 0;
    p.milestones.bytes += r.filesize_bytes || 0;
    if (r.tags && r.tags !== '[]') {
      let tags = [];
      try { tags = JSON.parse(r.tags); } catch {}
      if (Array.isArray(tags)) for (const t of tags) if (t) p.tagCount.set(String(t), (p.tagCount.get(String(t)) || 0) + 1);
    }
  }

  // Quest pool: same filters as the SQL it replaces (user_trashed = 0 exactly)
  if (r.user_trashed !== 0) return;
  p.total++;
  if (!(r.user_rating || 0)) p.unrated++;
  if (!(r.user_starred || 0)) p.unfaved++;
  if (r.has_sub) p.subtitled.add(r);
  if (!WATCH_TYPES.has(r.media_type)) return;

  const views = r.view_count || 0;
  p.watchable.add(r);
  p[r.media_type].add(r);
  if ((r.duration_seconds || 0) >= 1800) p.longform.add(r);
  if (r.duration_seconds > 0 && r.duration_seconds < 120) p.shorts.add(r);
  if (r.media_type === 'video') {
    if ((r.width || 0) >= 3840 || (r.height || 0) >= 2160) p.hiRes.add(r);
    if (r.language != null && !NON_LANGUAGES.has(asciiLower(String(r.language)))) {
      let d = p.languages.get(r.language);
      if (!d) p.languages.set(r.language, d = distinct());
      d.add(r);
    }
  }
  if (r.dupe_group == null) { if (views === 0) p.unseenSingles++; }
  else p.unseenGroups.set(r.dupe_group, Math.max(p.unseenGroups.get(r.dupe_group) ?? 0, views));

  const labels = labelsOf(r);
  if (!labels.size) return;
  for (const label of labels) {
    let a = p.labels.get(label);
    if (!a) p.labels.set(label, a = { items: 0, views: 0, groups: null });
    if (r.dupe_group != null) {
      if (!a.groups) a.groups = new Set();
      if (a.groups.has(r.dupe_group)) continue;
      a.groups.add(r.dupe_group);
    }
    a.items++;
    a.views += views;
  }
}

/** Read one slice: rows in id order until SLICE_TARGET_MS has passed (checked
 *  every few rows, so a cold disk shortens the slice instead of stretching it). */
function step(p, budgetMs = SLICE_TARGET_MS) {
  const t0 = Date.now();
  let got = 0, stopped = false;
  for (const r of p.stmt.iterate(p.lastId, SLICE_ROWS)) {
    addRow(p, r);
    p.lastId = r.id;
    got++;
    if ((got & 31) === 0 && Date.now() - t0 >= budgetMs) { stopped = true; break; }
  }
  p.rows += got;
  if (!stopped && got < SLICE_ROWS) p.done = true;
}

/**
 * Turn the accumulator into the profile. A generator: a large library has
 * millions of distinct labels and tags, so this walks them in steps too
 * (finishWithin drives it against a time budget).
 */
function* finish(p) {
  let i = 0;
  const pause = () => (++i & 4095) === 0;

  let unseen = p.unseenSingles;
  for (const max of p.unseenGroups.values()) {
    if (max === 0) unseen++;
    if (pause()) yield;
  }

  // The TOP_LABELS least-viewed labels with enough items, kept sorted as they
  // come (ties stay in first-seen order, as a stable sort of all would)
  const labels = [];
  for (const [label, v] of p.labels) {
    if (v.items >= LABEL_MIN_ITEMS) {
      const avgViews = v.views / v.items;
      if (labels.length < TOP_LABELS || avgViews < labels[labels.length - 1].avgViews) {
        let j = labels.length;
        while (j > 0 && labels[j - 1].avgViews > avgViews) j--;
        labels.splice(j, 0, { label, items: v.items, avgViews });
        if (labels.length > TOP_LABELS) labels.pop();
      }
    }
    if (pause()) yield;
  }

  // Rare tags (1 or 2 files): the exact count, and a uniform random sample
  // for the chart to draw from (reservoir)
  let rare = 0;
  const pool = [];
  for (const [tag, n] of p.tagCount) {
    if (n <= 2) {
      rare++;
      if (pool.length < UNDER_TAGS_KEPT) pool.push({ tag, n });
      else {
        const j = Math.floor(Math.random() * rare);
        if (j < UNDER_TAGS_KEPT) pool[j] = { tag, n };
      }
    }
    if (pause()) yield;
  }

  const languages = [...p.languages.entries()]
    .map(([language, d]) => ({ language, n: d.value }))
    .filter(x => x.n >= LANGUAGE_MIN_ITEMS)
    .sort((a, b) => (a.language < b.language ? -1 : a.language > b.language ? 1 : 0));
  const types = [['audio', p.audio], ['video', p.video]]
    .filter(([, d]) => d.value > 0).map(([media_type, d]) => ({ media_type, n: d.value }));
  let cum = 0;
  // ORDER BY d: an unparseable created_at (date() NULL) sorts first
  const growth = [...p.growth.entries()].sort((a, b) => (a[0] === b[0] ? 0 : a[0] === null ? -1 : b[0] === null ? 1 : a[0] < b[0] ? -1 : 1))
    .map(([d, n]) => ({ d, total: (cum += n) }));
  return {
    quests: {
      labels, unseen, unrated: p.unrated, types, languages,
      subtitled: p.subtitled.value, watchable: p.watchable.value,
      longform: p.longform.value, shorts: p.shorts.value, hiRes: p.hiRes.value,
      total: p.total, unfaved: p.unfaved,
    },
    growth,
    underTags: { total: rare, pool },
    milestones: p.milestones,
    rows: p.rows,
  };
}

/** Advance the finish for up to budgetMs; the profile once complete, else undefined. */
function finishWithin(p, budgetMs) {
  if (!p.fin) p.fin = finish(p);
  const t0 = Date.now();
  for (;;) {
    const r = p.fin.next();
    if (r.done) return r.value;
    if (Date.now() - t0 >= budgetMs) return undefined;
  }
}

/** One unit of background work: a slice of rows, or a slice of the finish. */
function work(p, budgetMs) {
  if (!p.done) { step(p, budgetMs); return undefined; }
  return finishWithin(p, budgetMs);
}

/* ── Cache + scheduling ─────────────────────────────────────────────────── */

// Per connection: a lock closes it, an unlock opens a new one.
let state = { conn: null, snap: null, job: null, loaded: false };

function stateFor(conn) {
  if (state.conn !== conn) state = { conn, snap: null, job: null, loaded: false };
  return state;
}

function fileCount(conn) {
  return conn.prepare('SELECT COUNT(*) AS n FROM media').get().n;
}

function loadPersisted(st) {
  st.loaded = true;
  try {
    const row = st.conn.prepare('SELECT value FROM gamify_cache WHERE key = ?').get(CACHE_KEY);
    const v = row && JSON.parse(row.value);
    if (v && v.schema === PROFILE_SCHEMA && v.data) st.snap = { data: v.data, at: v.at, files: v.files, sync: false };
  } catch { /* table absent or junk: compute fresh */ }
}

function persist(st) {
  try {
    st.conn.prepare(`
      INSERT INTO gamify_cache (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(CACHE_KEY, JSON.stringify({ schema: PROFILE_SCHEMA, at: st.snap.at, files: st.snap.files, data: st.snap.data }));
  } catch { /* read-only or table absent: memory only */ }
}

function store(st, p, data, sync) {
  st.snap = { data, at: Date.now(), files: p.files, sync };
  if (!sync) persist(st);
  return st.snap.data;
}

/** Continue (or start) the pass in the background. Resolves to the profile,
 *  or null when the connection closed under it (a lock). */
function runInBackground(st, p) {
  if (st.job) return st.job;
  const conn = st.conn;
  st.job = new Promise((resolve) => {
    const tick = () => {
      if (state !== st || !conn.open) return resolve(null);
      let data;
      try {
        if (!p) { p = newPass(conn); p.files = fileCount(conn); }
        data = work(p, SLICE_TARGET_MS);
      } catch (err) {
        console.warn(`[gamify] library profile failed: ${err.message}`);
        st.job = null;
        return resolve(null);
      }
      if (data === undefined) return void setImmediate(tick);
      store(st, p, data, false);
      st.job = null;
      resolve(data);
    };
    setImmediate(tick);
  });
  return st.job;
}

/**
 * The library profile, or null while the first one for a large library is
 * still being built (whenReady() resolves once it is).
 * @param {object} [opts]
 * @param {number} [opts.refreshAfterMs] - refresh in the background when older
 */
function profile({ refreshAfterMs = REFRESH_MS } = {}) {
  const st = stateFor(db.get());
  if (!st.loaded) loadPersisted(st);

  if (st.snap && !st.snap.sync) {
    const age = Date.now() - st.snap.at;
    if (!st.job && (age > refreshAfterMs
      || (age > REFRESH_ON_CHANGE_MS && fileCount(st.conn) !== st.snap.files))) {
      runInBackground(st, null);
    }
    return st.snap.data;
  }
  if (st.job) return st.snap ? st.snap.data : null;

  // Small library (or none measured yet): try the whole pass right here.
  const p = newPass(st.conn);
  p.files = fileCount(st.conn);
  const deadline = Date.now() + SYNC_BUDGET_MS;
  let data;
  while (data === undefined && Date.now() < deadline) data = work(p, deadline - Date.now());
  if (data !== undefined) return store(st, p, data, true);
  runInBackground(st, p);
  return st.snap ? st.snap.data : null;
}

/** Resolves to a profile, waiting for the background pass when there is none. */
function whenReady(opts) {
  const data = profile(opts);
  if (data) return Promise.resolve(data);
  return state.job || Promise.resolve(null);
}

/** Forget everything (tests; the persisted copy too). */
function reset() {
  try { db.get().prepare('DELETE FROM gamify_cache WHERE key = ?').run(CACHE_KEY); } catch {}
  state = { conn: null, snap: null, job: null, loaded: false };
}

/** Tests: drop the in-memory profile only (as a restart would). */
function forgetMemory() { state = { conn: null, snap: null, job: null, loaded: false }; }

/** Tests: force the background path on a tiny library (0 = never inline). */
function setSyncBudget(ms) { SYNC_BUDGET_MS = ms; }

module.exports = { profile, whenReady, reset, labelsOf, setSyncBudget, forgetMemory, REFRESH_MS };
