/**
 * Gamification scoring engine — the "Obsession Score".
 *
 * Opt-in only (server started with --gamify). Everything here reads and
 * writes the local SQLite DB; nothing leaves the machine.
 *
 * Scoring model (fitness-app style):
 *   base view = 10 pts
 *   × type multiplier     (photos/gifs pay far less — no farming the score
 *                          by flipping through images; A/V views require a
 *                          real watch: 30% of duration or 180s, client-side)
 *   × rarity multiplier   (1.0–3.0: fewer library views = rarer = more pts)
 *   × duration multiplier (1.0–2.0: log scale on media duration)
 *   × streak multiplier   (1.0–2.0: consecutive active days)
 *   + diversity bonus     (+15 flat: first touch of a theme in 7 days)
 *
 * Decay: score shrinks 2% per fully-inactive day, applied lazily on the
 * next stats read (no background timers). Streak resets after a missed day.
 */

const db = require('./database');

const BASE_VIEW_POINTS = 10;
const DIVERSITY_BONUS = 15;
const DECAY_PER_DAY = 0.02;
const DIVERSITY_WINDOW_DAYS = 7;

// Photos take 2s to "view"; a video takes a real watch (30%/180s). Pay
// accordingly so rapid image-flipping can't farm the score.
const TYPE_MULTIPLIER = {
  video: 1.0, audio: 1.0,
  gif: 0.3, image: 0.25,
  document: 0.4,
};

/** A/V only counts once the client's watch threshold fired — a real watch. */
function isWatch(mediaType) {
  return mediaType === 'video' || mediaType === 'audio';
}

// Cosmetic themes unlocked by level. Applied to the gamify chip, modal
// accents, and the share-card PNG — free rewards that give the score a
// purpose (see PRODUCT_PLAN.md).
const THEMES = [
  { id: 'obsession', name: 'Obsession',   minLevel: 0, a: '#a855f7', b: '#ec4899' },
  { id: 'ocean',     name: 'Ocean',       minLevel: 2, a: '#38bdf8', b: '#34d399' },
  { id: 'ember',     name: 'Ember',       minLevel: 3, a: '#f97316', b: '#ef4444' },
  { id: 'forest',    name: 'Forest',      minLevel: 4, a: '#22c55e', b: '#a3e635' },
  { id: 'gold',      name: 'Gold Rush',   minLevel: 6, a: '#fbbf24', b: '#f59e0b' },
  { id: 'neon',      name: 'Neon Nights', minLevel: 8, a: '#22d3ee', b: '#e879f9' },
];

// Level thresholds + names (index = level)
const LEVELS = [
  { at: 0,     name: 'Casual Browser' },
  { at: 100,   name: 'Window Shopper' },
  { at: 300,   name: 'Regular' },
  { at: 600,   name: 'Enthusiast' },
  { at: 1000,  name: 'Collector' },
  { at: 1500,  name: 'Curator' },
  { at: 2500,  name: 'Archivist' },
  { at: 5000,  name: 'Librarian Supreme' },
  { at: 10000, name: 'Obsessed' },
];

/** Local calendar date as YYYY-MM-DD (decay + streaks work in local days). */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBetween(fromYmd, toYmd) {
  // Parse as UTC noon to dodge DST edges; we only care about whole days
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86400000);
}

function levelForScore(score) {
  let level = 0;
  for (let i = 0; i < LEVELS.length; i++) {
    if (score >= LEVELS[i].at) level = i;
  }
  return level;
}

function levelInfo(score) {
  const level = levelForScore(score);
  const cur = LEVELS[level];
  const next = LEVELS[level + 1] || null;
  return {
    level,
    name: cur.name,
    nextName: next?.name || null,
    nextAt: next?.at || null,
    // 0..1 progress toward the next level (1 when maxed)
    progress: next ? Math.min(1, (score - cur.at) / (next.at - cur.at)) : 1,
  };
}

/** The single stats row, created on first access. */
function getStatsRow() {
  const conn = db.get();
  conn.prepare(`INSERT OR IGNORE INTO gamify_stats (id) VALUES (1)`).run();
  return conn.prepare(`SELECT * FROM gamify_stats WHERE id = 1`).get();
}

/**
 * Apply pending decay + streak reset. Called lazily from every public
 * entry point, so the numbers are always current without a timer.
 *
 * Each idle day decays the score exactly ONCE: last_settled_date marks how
 * far decay has been accounted, so repeated reads on the same day (or any
 * day) never re-apply it. The current day never decays — it's still in
 * progress and may yet see activity.
 */
function settleDay() {
  const conn = db.get();
  const row = getStatsRow();
  const now = today();

  if (row.last_settled_date === now) return row;
  if (!row.last_active_date) {
    conn.prepare(`UPDATE gamify_stats SET last_settled_date = ? WHERE id = 1`).run(now);
    return getStatsRow();
  }

  const gap = daysBetween(row.last_active_date, now);

  // Unaccounted idle days: everything after the later of (last activity,
  // last settle), through yesterday
  const settled = row.last_settled_date;
  const idleDays = Math.max(0,
    settled && settled > row.last_active_date
      ? daysBetween(settled, now)
      : gap - 1
  );

  let score = row.score;
  if (idleDays > 0 && score > 0) {
    const decayed = score * Math.pow(1 - DECAY_PER_DAY, idleDays);
    const lost = score - decayed;
    score = decayed;
    conn.prepare(`
      INSERT INTO gamify_events (event_type, points, detail)
      VALUES ('decay', ?, ?)
    `).run(-lost, `${idleDays} idle day(s)`);
  }

  // Streak survives a 1-day gap (active yesterday), dies otherwise
  const streak = gap <= 1 ? row.streak_days : 0;

  conn.prepare(`
    UPDATE gamify_stats SET score = ?, streak_days = ?, level = ?, last_settled_date = ?
    WHERE id = 1
  `).run(score, streak, levelForScore(score), now);

  return getStatsRow();
}

/** Streak multiplier: day 2 = 1.1x, ramps to 2.0x at day 30+. */
function streakMultiplier(streakDays) {
  if (streakDays >= 30) return 2.0;
  if (streakDays >= 7) return 1.5 + ((streakDays - 7) / 23) * 0.5;
  if (streakDays >= 2) return 1.1 + ((streakDays - 2) / 5) * 0.4;
  return 1.0;
}

/**
 * Rarity: percentile of this item's view count among non-trashed items.
 * Never-viewed items are the rarest (3.0x); library faves give 1.0x.
 */
function rarityMultiplier(mediaRow) {
  const conn = db.get();
  const { total, below } = conn.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN view_count < ? THEN 1 ELSE 0 END) AS below
    FROM media WHERE user_trashed = 0
  `).get(mediaRow.view_count || 0);
  if (!total) return 1.0;
  const percentile = (below || 0) / total;   // 0 = rarest, 1 = most viewed
  return 3.0 - percentile * 2.0;
}

/** Duration: log scale, 1.0x under a minute, capped at 2.0x (~1hr). */
function durationMultiplier(mediaRow) {
  const s = mediaRow.duration_seconds || 0;
  if (s <= 60) return 1.0;
  return Math.min(2.0, 1.0 + Math.log10(s / 60) * 0.56);
}

/** Themes touched in the diversity window, from the events log. */
function recentThemes() {
  const conn = db.get();
  const rows = conn.prepare(`
    SELECT detail FROM gamify_events
    WHERE event_type = 'view'
      AND created_at >= datetime('now', 'localtime', ?)
  `).all(`-${DIVERSITY_WINDOW_DAYS} days`);
  const seen = new Set();
  for (const r of rows) {
    try {
      for (const t of JSON.parse(r.detail || '{}').themes || []) seen.add(t);
    } catch {}
  }
  return seen;
}

function parseThemes(mediaRow) {
  try {
    const arr = JSON.parse(mediaRow.themes || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Record a qualifying view (called by the server when the client posts a
 * counted view). Awards points, bumps streak, updates the daily snapshot,
 * and advances quest progress.
 *
 * @returns {object} { earned, breakdown, stats, questEvents, levelUp }
 */
function recordView(mediaId, watchSeconds = 0) {
  const conn = db.get();
  const media = db.getById(mediaId);
  if (!media) return null;

  const before = settleDay();
  const now = today();

  // Streak: first activity today extends it
  let streak = before.streak_days;
  if (before.last_active_date !== now) streak += 1;

  const typeMult = TYPE_MULTIPLIER[media.media_type] ?? 0.5;
  const watched = isWatch(media.media_type);
  const rarity = rarityMultiplier(media);
  const duration = durationMultiplier(media);
  const streakMult = streakMultiplier(streak);

  const themes = parseThemes(media);
  const recent = recentThemes();
  const newThemes = themes.filter(t => !recent.has(t));
  const diversity = newThemes.length > 0 ? DIVERSITY_BONUS : 0;

  const earned = BASE_VIEW_POINTS * typeMult * rarity * duration * streakMult + diversity;
  const score = before.score + earned;
  const prevLevel = levelForScore(before.score);
  const newLevel = levelForScore(score);

  conn.prepare(`
    INSERT INTO gamify_events (event_type, points, media_id, detail)
    VALUES ('view', ?, ?, ?)
  `).run(earned, mediaId, JSON.stringify({ themes, newThemes, typeMult, rarity, duration, streakMult, isWatch: watched }));

  conn.prepare(`
    UPDATE gamify_stats SET
      score = ?, streak_days = ?, last_active_date = ?,
      total_watch_time_s = total_watch_time_s + ?,
      total_views = total_views + 1, level = ?
    WHERE id = 1
  `).run(score, streak, now, watchSeconds, newLevel);

  conn.prepare(`
    INSERT INTO gamify_daily (day, score, points_earned, views)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(day) DO UPDATE SET
      score = excluded.score,
      points_earned = points_earned + excluded.points_earned,
      views = views + 1
  `).run(now, score, earned);

  const quests = require('./quests');
  const questEvents = quests.onView(media, watched);

  let achievements = [];
  try {
    achievements = require('./achievements').checkAchievements({
      watch_s: watchSeconds,
      hour: new Date().getHours(),
      isWatch: watched,
    });
  } catch {}

  return {
    achievements,
    earned: Math.round(earned * 10) / 10,
    breakdown: {
      base: BASE_VIEW_POINTS,
      type: typeMult,
      rarity: Math.round(rarity * 100) / 100,
      duration: Math.round(duration * 100) / 100,
      streak: Math.round(streakMult * 100) / 100,
      diversity,
    },
    stats: getPublicStats(),
    questEvents,
    levelUp: newLevel > prevLevel ? levelInfo(score) : null,
  };
}

/**
 * Award flat points (quest rewards etc.) and refresh streak/daily rows.
 */
function awardPoints(points, eventType, detail) {
  const conn = db.get();
  const before = settleDay();
  const now = today();
  let streak = before.streak_days;
  if (before.last_active_date !== now) streak += 1;
  const score = before.score + points;

  conn.prepare(`
    INSERT INTO gamify_events (event_type, points, detail) VALUES (?, ?, ?)
  `).run(eventType, points, detail || null);

  conn.prepare(`
    UPDATE gamify_stats SET score = ?, streak_days = ?, last_active_date = ?, level = ?
    WHERE id = 1
  `).run(score, streak, now, levelForScore(score));

  conn.prepare(`
    INSERT INTO gamify_daily (day, score, points_earned, views)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(day) DO UPDATE SET
      score = excluded.score,
      points_earned = points_earned + excluded.points_earned
  `).run(now, score, points);
}

/* ── Cosmetic themes ────────────────────────────────────────────────────── */

/** The selected theme, falling back to default if locked or unknown. */
function currentTheme(row) {
  row = row || getStatsRow();
  const level = levelForScore(row.score);
  const t = THEMES.find(x => x.id === row.selected_theme);
  return (t && level >= t.minLevel) ? t : THEMES[0];
}

/** Select a theme (must be unlocked). @returns {object|null} the theme */
function setSelectedTheme(id) {
  const conn = db.get();
  const row = settleDay();
  const level = levelForScore(row.score);
  const t = THEMES.find(x => x.id === id);
  if (!t || level < t.minLevel) return null;
  conn.prepare(`UPDATE gamify_stats SET selected_theme = ? WHERE id = 1`).run(id);
  return t;
}

/* ── Analytics (charting data for the full-stats page) ─────────────────── */

function getAnalytics() {
  const conn = db.get();
  settleDay();

  // Watch heatmap: hour-of-day × day-of-week counts (localtime timestamps)
  const hourDow = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const r of conn.prepare(`
    SELECT strftime('%w', created_at) AS dow, strftime('%H', created_at) AS hr, COUNT(*) AS n
    FROM gamify_events WHERE event_type = 'view'
    GROUP BY dow, hr
  `).all()) {
    hourDow[Number(r.dow)][Number(r.hr)] = r.n;
  }

  // Daily activity, last 90 days
  const daily = conn.prepare(`
    SELECT day, score, points_earned, views FROM gamify_daily
    WHERE day >= date('now', 'localtime', '-89 days')
    ORDER BY day
  `).all();

  // Theme drift: weekly counts of watched themes over the last 12 weeks
  const rows = conn.prepare(`
    SELECT created_at, detail FROM gamify_events
    WHERE event_type = 'view' AND created_at >= datetime('now', 'localtime', '-84 days')
  `).all();
  const weekOf = (iso) => {
    const d = new Date(iso.replace(' ', 'T'));
    d.setDate(d.getDate() - d.getDay()); // week starts Sunday
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const byWeek = {};
  const totals = {};
  for (const r of rows) {
    let themes = [];
    try { themes = JSON.parse(r.detail || '{}').themes || []; } catch {}
    const wk = weekOf(r.created_at);
    byWeek[wk] = byWeek[wk] || {};
    for (const t of themes) {
      byWeek[wk][t] = (byWeek[wk][t] || 0) + 1;
      totals[t] = (totals[t] || 0) + 1;
    }
  }
  const topThemes = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  const weeks = Object.keys(byWeek).sort();
  const themeDrift = {
    weeks,
    themes: topThemes.map(t => ({ theme: t, counts: weeks.map(w => byWeek[w][t] || 0) })),
  };

  // Library growth: cumulative item count by day added
  const growthRows = conn.prepare(`
    SELECT date(created_at) AS d, COUNT(*) AS n FROM media
    WHERE created_at IS NOT NULL
    GROUP BY d ORDER BY d
  `).all();
  let cum = 0;
  const growth = growthRows.map(r => ({ d: r.d, total: (cum += r.n) }));

  /* ── Ratings ── (overall avg is complete; the trend builds from logged
     'rate' events since we don't keep per-rating history) */
  const dist = [0, 0, 0, 0, 0];
  for (const r of conn.prepare(
    'SELECT user_rating AS r, COUNT(*) AS n FROM media WHERE COALESCE(user_rating,0) BETWEEN 1 AND 5 GROUP BY user_rating'
  ).all()) dist[r.r - 1] = r.n;
  const ratedCount = dist.reduce((a, b) => a + b, 0);
  const ratingAvg = ratedCount ? dist.reduce((a, n, i) => a + n * (i + 1), 0) / ratedCount : 0;
  const rateWindow = (from, to) => conn.prepare(`
    SELECT AVG(CAST(json_extract(detail,'$.rating') AS REAL)) AS a FROM gamify_events
    WHERE event_type = 'rate' AND created_at > datetime('now','localtime',?) AND created_at <= datetime('now','localtime',?)
  `).get(from, to).a;
  let ratingTrend = null;
  try {
    // '+0 days' == now (a bare 'now' is NOT a valid datetime modifier)
    const recent = rateWindow('-30 days', '+0 days'), prior = rateWindow('-60 days', '-30 days');
    if (recent != null && prior != null) ratingTrend = Math.round((recent - prior) * 100) / 100;
  } catch { /* json_extract missing on ancient sqlite — skip trend */ }
  const ratings = { avg: Math.round(ratingAvg * 100) / 100, count: ratedCount, distribution: dist, trend: ratingTrend };

  /* ── Underexplored tags: appear in only 1–2 items ── */
  const tagCount = {};
  for (const r of conn.prepare(
    "SELECT tags FROM media WHERE COALESCE(user_trashed,0)=0 AND tags IS NOT NULL AND tags != '' AND tags != '[]'"
  ).all()) {
    let tags = [];
    try { tags = JSON.parse(r.tags); } catch {}
    for (const t of tags) if (t) tagCount[t] = (tagCount[t] || 0) + 1;
  }
  const under = Object.entries(tagCount).filter(([, n]) => n <= 2).map(([t, n]) => ({ tag: t, n }));
  const underTags = { total: under.length, sample: under.sort(() => Math.random() - 0.5).slice(0, 12) };

  /* ── Notes ── */
  const notes = {
    itemsWithNotes: conn.prepare("SELECT COUNT(*) AS n FROM media WHERE COALESCE(user_notes,'') != ''").get().n,
    snippets: conn.prepare('SELECT COUNT(*) AS n FROM saved_notes').get().n,
  };

  /* ── Finishers ── (rate + a forward-built over-time series) */
  const av = "media_type IN ('video','audio')";
  const watchedVideos = conn.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${av} AND COALESCE(view_count,0) > 0 AND COALESCE(user_trashed,0)=0`).get().n;
  const doneVideos = conn.prepare(`SELECT COUNT(*) AS n FROM media WHERE ${av} AND COALESCE(done_count,0) > 0 AND COALESCE(user_trashed,0)=0`).get().n;
  const finisherDaily = conn.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS n FROM gamify_events
    WHERE event_type = 'finisher' AND created_at >= datetime('now','localtime','-89 days')
    GROUP BY day ORDER BY day
  `).all();
  const finishers = {
    rate: { done: doneVideos, watched: watchedVideos, pct: watchedVideos ? Math.round((doneVideos / watchedVideos) * 100) : 0 },
    daily: finisherDaily,
  };

  /* ── Milestones ── */
  const lib = conn.prepare(`
    SELECT COALESCE(SUM(duration_seconds),0) AS secs, COALESCE(SUM(filesize_bytes),0) AS bytes,
           COUNT(*) AS items FROM media WHERE COALESCE(user_trashed,0)=0
  `).get();
  const milestones = {
    contentDays: Math.round((lib.secs / 86400) * 10) / 10,
    contentHours: Math.round(lib.secs / 3600),
    storageBytes: lib.bytes,
    items: lib.items,
  };

  return { hourDow, daily, themeDrift, growth, ratings, underTags, notes, finishers, milestones };
}

/** Full stats object for the UI. */
function getPublicStats() {
  const row = settleDay();
  const conn = db.get();

  const faveThemes = conn.prepare(`
    SELECT detail FROM gamify_events
    WHERE event_type = 'view' AND created_at >= datetime('now', 'localtime', '-30 days')
  `).all();
  const themeCounts = {};
  for (const r of faveThemes) {
    try {
      for (const t of JSON.parse(r.detail || '{}').themes || []) {
        themeCounts[t] = (themeCounts[t] || 0) + 1;
      }
    } catch {}
  }
  const topThemes = Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));

  // Activity heatmap: which of the last 30 local days had any points
  const activeDays = conn.prepare(`
    SELECT day FROM gamify_daily
    WHERE day >= date('now', 'localtime', '-29 days') AND points_earned > 0
  `).all().map(r => r.day);

  const level = levelForScore(row.score);

  // 💦 total finishers across the library
  const finishers = conn.prepare(
    'SELECT COALESCE(SUM(done_count), 0) AS n FROM media WHERE COALESCE(user_trashed, 0) = 0'
  ).get().n;

  // "Currently obsessed with": the standout item — highest rating, then most
  // rewatched. Only surfaces once something is rated or watched twice.
  const topItem = conn.prepare(`
    SELECT id, filename, media_type, COALESCE(user_rating, 0) AS rating, COALESCE(view_count, 0) AS views
    FROM media
    WHERE COALESCE(user_trashed, 0) = 0 AND (COALESCE(user_rating, 0) > 0 OR COALESCE(view_count, 0) >= 2)
    ORDER BY rating DESC, views DESC, id DESC LIMIT 1
  `).get() || null;

  // Points earned this local week vs the prior week (momentum under the score)
  const weekPoints = (offsetDays) => conn.prepare(`
    SELECT COALESCE(SUM(points_earned), 0) AS n FROM gamify_daily
    WHERE day > date('now', 'localtime', ?) AND day <= date('now', 'localtime', ?)
  `).get(`-${offsetDays + 7} days`, `-${offsetDays} days`).n;
  const thisWeek = weekPoints(0), lastWeek = weekPoints(7);

  return {
    score: Math.round(row.score * 10) / 10,
    ...levelInfo(row.score),
    streakDays: row.streak_days,
    lastActiveDate: row.last_active_date,
    totalWatchTimeS: Math.round(row.total_watch_time_s),
    totalViews: row.total_views,
    questsCompleted: row.quests_completed,
    finishers,
    topItem,
    weekDelta: { thisWeek: Math.round(thisWeek), lastWeek: Math.round(lastWeek), delta: Math.round(thisWeek - lastWeek) },
    topThemes,
    activeDays,
    theme: currentTheme(row),
    themes: THEMES.map(t => ({ ...t, unlocked: level >= t.minLevel })),
  };
}

/** Daily score snapshots for the history chart (fills gaps with carry-over). */
function getHistory(days = 30) {
  const conn = db.get();
  settleDay();
  const rows = conn.prepare(`
    SELECT day, score, points_earned, views FROM gamify_daily
    WHERE day >= date('now', 'localtime', ?)
    ORDER BY day
  `).all(`-${Math.max(1, Math.min(365, days)) - 1} days`);
  return rows;
}

/**
 * Log a zero-point activity event (finishers, ratings) so the Full-Stats
 * time charts have history to draw. Points/score are untouched — this is a
 * local-only activity log: the row stays in the local DB and never leaves
 * the machine, like everything else here.
 */
function logEvent(event_type, media_id = null, detail = null) {
  try {
    db.get().prepare(
      'INSERT INTO gamify_events (event_type, points, media_id, detail) VALUES (?, 0, ?, ?)'
    ).run(event_type, media_id, detail == null ? null : JSON.stringify(detail));
  } catch { /* gamify schema absent — nothing to log */ }
}

module.exports = {
  recordView,
  awardPoints,
  logEvent,
  getPublicStats,
  getHistory,
  getAnalytics,
  currentTheme,
  setSelectedTheme,
  settleDay,
  levelInfo,
  LEVELS,
  THEMES,
  today,
};
