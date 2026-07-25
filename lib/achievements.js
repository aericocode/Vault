/**
 * Achievements — public tiered milestones + hidden fun unlocks.
 * Part of the opt-in gamify layer; nothing here runs when gamify is off.
 *
 * Storage (created lazily so pre-update DBs just work):
 *   gamify_achievements (id TEXT PK, tier INT, unlocked_at TEXT)
 *   gamify_counters     (key TEXT PK, value REAL)  — client-event tallies
 *
 * Public ones show progress in Full Stats; hidden ones display as "???"
 * until earned. Unlocks award points (tier × 50, hidden 100).
 */

const db = require('./database');

function conn() {
  const c = db.get();
  c.exec(`
    CREATE TABLE IF NOT EXISTS gamify_achievements (
      id TEXT PRIMARY KEY,
      tier INTEGER DEFAULT 1,
      unlocked_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS gamify_counters (
      key TEXT PRIMARY KEY,
      value REAL DEFAULT 0
    );
  `);
  return c;
}

/* ── Value probes ──────────────────────────────────────────────────────── */

function watchEventCount(c, isWatch) {
  return c.prepare(`
    SELECT COUNT(*) AS n FROM gamify_events
    WHERE event_type = 'view' AND detail ${isWatch ? '' : 'NOT'} LIKE '%"isWatch":true%'
  `).get().n;
}

function alphabetLetters(c) {
  return c.prepare(`
    SELECT COUNT(DISTINCT UPPER(SUBSTR(m.filename, 1, 1))) AS n
    FROM gamify_events e JOIN media m ON m.id = e.media_id
    WHERE e.event_type = 'view' AND e.detail LIKE '%"isWatch":true%'
      AND UPPER(SUBSTR(m.filename, 1, 1)) BETWEEN 'A' AND 'Z'
  `).get().n;
}

function counter(c, key) {
  return c.prepare('SELECT value FROM gamify_counters WHERE key = ?').get(key)?.value || 0;
}

/** Watched languages (AI-detected), canonicalized so "en"/"EN"/"English" count
 *  once, and excluding non-language markers (none/unknown). */
function languagesWatched(c) {
  const { canonLang } = require('./lang');
  const rows = c.prepare('SELECT DISTINCT language FROM media WHERE view_count > 0 AND language IS NOT NULL').all();
  const codes = new Set();
  for (const r of rows) {
    const code = canonLang(r.language);
    if (code && code !== 'none') codes.add(code);
  }
  return codes.size;
}

/** Watched 3min+ videos that HAVE a subtitle file but barely any speech. */
function silentWatchCount(c) {
  try {
    return c.prepare(`
      SELECT COUNT(*) AS n FROM media m
      WHERE m.view_count > 0 AND m.duration_seconds > 180
        AND EXISTS (SELECT 1 FROM subtitle_tracks st WHERE st.media_id = m.id)
        AND length(COALESCE(m.audio_transcription, '')) < 60
    `).get().n;
  } catch { return 0; }   // subtitle_tracks table absent (no transcriptions yet)
}

function bumpCounter(c, key, by = 1) {
  c.prepare(`
    INSERT INTO gamify_counters (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
  `).run(key, by);
  return counter(c, key);
}

/* ── Definitions ───────────────────────────────────────────────────────── */

// Public tiered: value(c, stats) returns the current metric
const TIERED = [
  { id: 'watch_time', icon: '⏱', name: 'Marathoner', desc: 'Watch {n} hours total',
    tiers: [1, 5, 25, 100], value: (c, s) => (s.total_watch_time_s || 0) / 3600 },
  { id: 'videos', icon: '🎬', name: 'Cinephile', desc: 'Watch {n} videos',
    tiers: [10, 100, 500, 1000], value: (c) => watchEventCount(c, true) },
  { id: 'pics', icon: '🖼', name: 'Gallery Ghost', desc: 'View {n} pictures',
    tiers: [50, 250, 1000, 5000], value: (c) => watchEventCount(c, false) },
  { id: 'collected', icon: '📁', name: 'Curator', desc: 'Collect {n} items',
    tiers: [10, 50, 200], value: () => db.totalCollectedCount() },
  { id: 'streak', icon: '🔥', name: 'Creature of Habit', desc: 'Hit a {n}-day streak',
    tiers: [3, 7, 30], value: (c, s) => s.streak_days || 0 },
  { id: 'finishers', icon: '💦', name: 'The Closer', desc: 'Mark {n} finishers',
    tiers: [5, 25, 100],
    value: (c) => c.prepare('SELECT COALESCE(SUM(done_count),0) AS n FROM media').get().n },
  // Subtitle/transcript-era achievements (LICENSING-era metadata pays off)
  { id: 'polyglot', icon: '🌍', name: 'Polyglot', desc: 'Watch content in {n} languages',
    tiers: [2, 4, 7], value: (c) => languagesWatched(c) },
  { id: 'quotes', icon: '📌', name: 'Quote Collector', desc: 'Pin {n} spoken lines as note snippets',
    tiers: [3, 10, 25], value: (c) => counter(c, 'quote_saved') },
  { id: 'rewinds', icon: '⏪', name: 'Rewind That', desc: 'Jump to {n} transcript timestamps',
    tiers: [5, 25, 100], value: (c) => counter(c, 'transcript_seek') },
];

// Hidden: unlocked by a condition or a client event/counter
const HIDDEN = [
  { id: 'alphabet', icon: '🔤', name: 'Alphabet Soup',
    desc: 'Watch a video starting with every letter A–Z',
    check: (c) => alphabetLetters(c) >= 26,
    progress: (c) => `${alphabetLetters(c)}/26 letters` },
  { id: 'spin_cycle', icon: '🌀', name: 'You Spin Me Round',
    desc: 'Rotate an image three full turns', event: 'spin_cycle' },
  { id: 'night_owl', icon: '🦉', name: 'Night Owl',
    desc: 'Watch something between 2 and 5 AM',
    ctx: (x) => x.hour >= 2 && x.hour < 5 && x.isWatch },
  { id: 'deep_diver', icon: '🤿', name: 'Deep Diver',
    desc: 'Watch 30+ minutes in a single sitting',
    ctx: (x) => (x.watch_s || 0) >= 1800 },
  { id: 'dice_roller', icon: '🎲', name: 'Feeling Lucky',
    desc: 'Roll the Random button 20 times', counterKey: 'random_uses', at: 20 },
  { id: 'loop_fan', icon: '🔁', name: 'Loop-de-Loop',
    desc: 'Set an A↔B loop', event: 'abloop' },
  { id: 'speed_demon', icon: '⚡', name: 'Speed Demon',
    desc: 'Watch at 3× speed', event: 'speed3x' },
  { id: 'beat_dropper', icon: '🥁', name: 'Beat Dropper',
    desc: 'Turn on the beat bar', event: 'beatbar' },
  { id: 'eavesdropper', icon: '🎧', name: 'Eavesdropper',
    desc: 'Search by transcript text', event: 'transcript_search' },
  { id: 'silent_type', icon: '🤫', name: 'Silent Type',
    desc: 'Watch 5 long videos with barely a spoken word',
    check: (c) => silentWatchCount(c) >= 5,
    progress: (c) => `${silentWatchCount(c)}/5 silent films` },
];

// Tiered achievements that grow from client-posted events — recordEvent bumps
// these tallies, checkAchievements() then evaluates the tiers.
const COUNTER_EVENTS = new Set(['quote_saved', 'transcript_seek']);

/* ── Core ──────────────────────────────────────────────────────────────── */

function unlockedMap(c) {
  const map = new Map();
  for (const r of c.prepare('SELECT * FROM gamify_achievements').all()) map.set(r.id, r);
  return map;
}

function award(id, name, tier) {
  const gamify = require('./gamify');
  const pts = tier > 0 ? tier * 50 : 100;
  gamify.awardPoints(pts, 'achievement', `${name}${tier > 1 ? ` (tier ${tier})` : ''}`);
  return pts;
}

/**
 * Evaluate everything; unlock what's newly earned.
 * @param {object} ctx - { watch_s, hour, isWatch } from the triggering view (optional)
 * @returns newly unlocked [{id, name, icon, tier, points}]
 */
function checkAchievements(ctx = {}) {
  const c = conn();
  const stats = c.prepare('SELECT * FROM gamify_stats WHERE id = 1').get() || {};
  const have = unlockedMap(c);
  const fresh = [];
  const upsert = c.prepare(`
    INSERT INTO gamify_achievements (id, tier) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET tier = excluded.tier,
      unlocked_at = datetime('now', 'localtime')
  `);

  for (const a of TIERED) {
    const v = a.value(c, stats);
    let tier = 0;
    for (let i = 0; i < a.tiers.length; i++) if (v >= a.tiers[i]) tier = i + 1;
    const cur = have.get(a.id)?.tier || 0;
    if (tier > cur) {
      upsert.run(a.id, tier);
      fresh.push({ id: a.id, name: a.name, icon: a.icon, tier, points: award(a.id, a.name, tier) });
    }
  }

  for (const a of HIDDEN) {
    if (have.has(a.id)) continue;
    let hit = false;
    if (a.check) hit = a.check(c);
    else if (a.ctx) hit = !!a.ctx(ctx);
    else if (a.counterKey) hit = counter(c, a.counterKey) >= a.at;
    if (hit) {
      upsert.run(a.id, 1);
      fresh.push({ id: a.id, name: a.name, icon: a.icon, tier: 0, points: award(a.id, a.name, 0) });
    }
  }

  return fresh;
}

/**
 * A client-side event happened (random click, AB loop set, beat bar on, …).
 * @returns newly unlocked achievements
 */
function recordEvent(type) {
  const c = conn();
  const have = unlockedMap(c);

  // Counter-based events accumulate (hidden counterKeys + tiered tallies)
  const counterAch = HIDDEN.find(a => a.counterKey && (a.counterKey === type || a.id === type));
  if (counterAch) bumpCounter(c, counterAch.counterKey, 1);
  if (COUNTER_EVENTS.has(type)) bumpCounter(c, type, 1);

  // Direct events unlock immediately
  const direct = HIDDEN.find(a => a.event === type);
  if (direct && !have.has(direct.id)) {
    c.prepare(`INSERT OR IGNORE INTO gamify_achievements (id, tier) VALUES (?, 1)`).run(direct.id);
    return [{ id: direct.id, name: direct.name, icon: direct.icon, tier: 0, points: award(direct.id, direct.name, 0) }];
  }

  return checkAchievements();
}

/** Everything, for the Full Stats achievements tab. Hidden stay masked. */
function getAchievements() {
  const c = conn();
  const stats = c.prepare('SELECT * FROM gamify_stats WHERE id = 1').get() || {};
  const have = unlockedMap(c);

  const tiered = TIERED.map(a => {
    const v = a.value(c, stats);
    const cur = have.get(a.id)?.tier || 0;
    const nextAt = a.tiers[Math.min(cur, a.tiers.length - 1)];
    return {
      id: a.id, icon: a.icon, name: a.name, hidden: false,
      tier: cur, maxTier: a.tiers.length, tiers: a.tiers,
      desc: a.desc.replace('{n}', String(cur < a.tiers.length ? a.tiers[cur] : a.tiers[a.tiers.length - 1])),
      value: Math.round(v * 10) / 10,
      progress: cur >= a.tiers.length ? 1 : Math.min(1, v / nextAt),
      unlocked_at: have.get(a.id)?.unlocked_at || null,
    };
  });

  const hidden = HIDDEN.map(a => {
    const got = have.get(a.id);
    return got ? {
      id: a.id, icon: a.icon, name: a.name, desc: a.desc, hidden: true,
      tier: 1, maxTier: 1, progress: 1, unlocked_at: got.unlocked_at,
    } : {
      id: a.id, icon: '❓', name: '???', hidden: true,
      desc: a.progress ? a.progress(c) : 'Hidden achievement — keep exploring',
      tier: 0, maxTier: 1, progress: 0, unlocked_at: null,
    };
  });

  const total = tiered.reduce((s, a) => s + a.maxTier, 0) + hidden.length;
  const earned = tiered.reduce((s, a) => s + a.tier, 0) + hidden.filter(h => h.tier).length;

  // "Closest to unlocking" teaser for the main panel — the highest-progress
  // achievement that isn't finished (hidden ??? excluded: no spoilers).
  const next = tiered
    .filter(a => a.progress < 1)
    .sort((a, b) => b.progress - a.progress)[0] || null;

  return { tiered, hidden, earned, total, next };
}

module.exports = { checkAchievements, recordEvent, getAchievements };
