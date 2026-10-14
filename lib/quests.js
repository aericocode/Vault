/**
 * Quest engine — template-based dynamic quests from existing AI metadata.
 *
 * No LLM calls: templates are filled from cheap GROUP-BY queries over the
 * media table, biased toward the user's gaps (unseen items, unexplored
 * themes). 3 quests active at a time; each expires after 7 days.
 *
 * Anti-farming: every view-based quest only advances on a real WATCH —
 * a video/audio view, which the client only posts after 30% of duration or
 * 180s of cumulative watch time. Photo dwells never advance view quests.
 *
 * Attainability: count quests are only offered with CHOICE_SLACK spare items
 * beyond the target (dupe groups collapse to one, trash excluded), so the
 * user always has options in what to watch. "Explore" quests draw from the
 * theme ∪ tag pool and a watch matching either field advances them.
 */

const db = require('./database');

const ACTIVE_QUEST_COUNT = 3;
const QUEST_TTL_DAYS = 7;

/* ── Attainability ────────────────────────────────────────────────────────
   A count quest must leave real CHOICE: "watch X of Y" is only offered when
   at least X+3 qualifying items exist (counted per unique content — confirmed
   duplicates collapse to one, trash excluded). A user with exactly 5 romance
   videos gets "watch 2", never "watch 5 of your 5". */
const CHOICE_SLACK = 3;

/** Largest target ≤ cap that keeps CHOICE_SLACK spare items; null = don't offer. */
function attainableTarget(available, cap, min = 2) {
  const t = Math.min(cap, (available || 0) - CHOICE_SLACK);
  return t >= min ? t : null;
}

/* ── Library reads ─────────────────────────────────────────────────────────
   The counts and label rankings the templates draw from come from the
   library profile (lib/gamify-library.js): each needs a pass over the whole
   media table, which at 2M files would block the server for over a minute.
   What stays here is per-watch and small. */

// Watch quests can only be satisfied by A/V — build them from A/V metadata
const WATCH_TYPES = "('video', 'audio')";

const { labelsOf } = require('./gamify-library');

/** Qualifying watches recorded today (from the events log). */
function todayWatchCount() {
  const conn = db.get();
  return conn.prepare(`
    SELECT COUNT(*) AS n FROM gamify_events
    WHERE event_type = 'view'
      AND detail LIKE '%"isWatch":true%'
      AND date(created_at) = date('now', 'localtime')
  `).get().n;
}

/** Does this item have any subtitle track? (subtitled_views progress) */
function hasSubtitleTrack(conn, media_id) {
  try {
    return !!conn.prepare('SELECT 1 FROM subtitle_tracks WHERE media_id = ? LIMIT 1').get(media_id);
  } catch { return false; }
}

/** Named songs linked to enough distinct videos for a B-Side quest (Music ID
 *  tables appear on first use — absent means no music data yet). Driven from
 *  the song links (CROSS JOIN fixes the order: never every video first). */
function sharedSongPicks(minVideos = 4) {
  try {
    return db.get().prepare(`
      SELECT ms.song_id, s.artist, s.title,
             COUNT(DISTINCT COALESCE('g' || m.dupe_group, 'i' || m.id)) AS n
      FROM media_songs ms
      CROSS JOIN media m ON m.id = ms.media_id
      JOIN songs s ON s.id = ms.song_id
      WHERE m.user_trashed = 0 AND m.media_type = 'video' AND s.artist != 'Unknown'
      GROUP BY ms.song_id HAVING n >= ?
    `).all(minVideos);
  } catch { return []; }
}

/** Is this watch inside the 20 oldest never-watched files? (Time Capsule.)
 *  view_count was already bumped server-side, so "was unwatched" = <= 1; the
 *  cutoff is the 20th-oldest STILL-unwatched row (fewer than 20 left → any
 *  unwatched qualifies). Walks the processed-date sort index from the oldest
 *  end (lib/library-index.js idx_media_sort_processed, the same expression);
 *  the unary + keeps SQLite off the indexes that would match nearly every row.
 *
 *  Same answers as the original `ORDER BY processed_at`, which sorts NULL
 *  (never-scanned files) before '': when the 20th falls among the empty
 *  dates it was NULL if at least 20 of them are NULL, and a NULL cutoff
 *  compared as the string 'null', which every real date is below. */
function isOldestUnwatched(conn, media) {
  if ((media.view_count || 0) > 1) return false;
  const unwatched = `user_trashed = 0 AND +media_type IN ${WATCH_TYPES} AND +COALESCE(view_count, 0) = 0`;
  const cut = conn.prepare(`
    SELECT COALESCE(processed_at, '') AS k FROM media WHERE ${unwatched}
    ORDER BY COALESCE(processed_at, '') ASC LIMIT 1 OFFSET 19
  `).get();
  if (!cut) return true;
  let cutoff = String(cut.k);
  if (cutoff === '') {
    // Only the empty-date group is walked (index range on ''), stopping at 20
    const nulls = conn.prepare(`
      SELECT COUNT(*) FROM (SELECT 1 FROM media
        WHERE COALESCE(processed_at, '') = '' AND processed_at IS NULL AND ${unwatched} LIMIT 20)
    `).pluck().get();
    if (nulls >= 20) cutoff = String(null);
  }
  return String(media.processed_at || '') <= cutoff;
}

/** Does this media contain the quest's song? (B-Side progress.) */
function mediaHasSong(conn, media_id, song_id) {
  try {
    return !!conn.prepare('SELECT 1 FROM media_songs WHERE media_id = ? AND song_id = ? LIMIT 1')
      .get(media_id, song_id);
  } catch { return false; }
}

/* ── Quest templates ─────────────────────────────────────────────────────────
   Each returns null when it can't build a sensible quest for this library,
   or { quest_type, title, description, target, reward_points, params }.
   `params` drives progress matching in onView/onRate. */

const TEMPLATES = [
  {
    weight: 3,
    build(ctx) {
      const pick = ctx.labels[Math.floor(Math.random() * Math.min(5, ctx.labels.length))];
      if (!pick) return null;
      const target = attainableTarget(pick.items, 5);
      if (!target) return null;
      return {
        quest_type: 'theme_views',
        title: `Explore: ${pick.label}`,
        description: `Watch ${target} videos tagged "${pick.label}" (theme or tag). One of your least-explored corners.`,
        target,
        reward_points: 60 + target * 10,
        params: { label: pick.label },
      };
    },
  },
  {
    weight: 3,
    build(ctx) {
      const target = attainableTarget(ctx.unseen, 8);
      if (!target) return null;
      return {
        quest_type: 'unseen_views',
        title: 'Fresh Eyes',
        description: `Watch ${target} videos you've never opened before.`,
        target,
        reward_points: 50 + target * 8,
        params: { unseenOnly: true },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const pick = ctx.types[Math.floor(Math.random() * ctx.types.length)];
      if (!pick) return null;
      const target = attainableTarget(pick.n, 6);
      if (!target) return null;
      return {
        quest_type: 'type_views',
        title: `${pick.media_type[0].toUpperCase() + pick.media_type.slice(1)} Marathon`,
        description: `Watch ${target} ${pick.media_type} files (30% or 3 minutes each).`,
        target,
        reward_points: 40 + target * 6,
        params: { media_type: pick.media_type },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const target = attainableTarget(ctx.unrated, 10);
      if (!target) return null;
      return {
        quest_type: 'rate_items',
        title: 'Critic Mode',
        description: `Rate ${target} unrated items (any star rating counts).`,
        target,
        reward_points: 45 + target * 5,
        params: { rate: true },
      };
    },
  },
  {
    weight: 1,
    build(ctx) {
      const target = 3 + Math.floor(Math.random() * 3);   // 3–5 days
      if (ctx.streakDays >= target) return null;          // already past it
      return {
        quest_type: 'streak',
        title: `${target} Days Strong`,
        description: `Reach a ${target}-day activity streak.`,
        target,
        // Streaks are the slowest quests to earn — pay accordingly (~80/day)
        reward_points: 60 + target * 60,
        params: { streak: true },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      // Only worth offering when the library gives real choice for a 5-in-a-day
      if (ctx.watchable < 5 + CHOICE_SLACK) return null;
      return {
        quest_type: 'daily_views',
        title: 'Daily Five',
        description: 'Watch 5 videos in a single day.',
        target: 5,
        reward_points: 80,
        params: { daily: true },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const pick = ctx.languages[Math.floor(Math.random() * ctx.languages.length)];
      if (!pick) return null;
      const target = attainableTarget(pick.n, 5);
      if (!target) return null;
      return {
        quest_type: 'lang_views',
        title: `Linguist: ${pick.language}`,
        description: `Watch ${target} ${pick.language} videos (30% or 3 minutes each).`,
        target,
        reward_points: 50 + target * 10,
        params: { language: pick.language },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const target = attainableTarget(ctx.subtitled, 5);
      if (!target) return null;
      return {
        quest_type: 'subtitled_views',
        title: 'Read Along',
        description: `Watch ${target} videos that have subtitles.`,
        target,
        reward_points: 45 + target * 10,
        params: { subtitled: true },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      // Needs a real pool of unwatched files for the "20 oldest" to mean anything
      if (!attainableTarget(ctx.unseen, 1, 1)) return null;
      return {
        quest_type: 'time_capsule',
        title: 'Time Capsule',
        description: 'Watch one of your 20 oldest never-watched files.',
        target: 1,
        reward_points: 70,
        params: { timeCapsule: true },
      };
    },
  },
  {
    weight: 1,
    build(ctx) {
      if (!attainableTarget(ctx.longform, 1, 1)) return null;
      return {
        quest_type: 'feature_views',
        title: 'Feature Presentation',
        description: 'Watch something over 30 minutes long.',
        target: 1,
        reward_points: 90,   // the watch threshold alone is 10+ minutes
        params: { minDuration: 1800 },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const target = attainableTarget(ctx.shorts, 6);
      if (!target) return null;
      return {
        quest_type: 'short_views',
        title: 'Short Stack',
        description: `Watch ${target} clips under 2 minutes.`,
        target,
        reward_points: 35 + target * 6,
        params: { maxDuration: 120 },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const pick = ctx.songs[Math.floor(Math.random() * ctx.songs.length)];
      if (!pick) return null;   // gated in sharedSongPicks: 4+ distinct videos
      return {
        quest_type: 'song_views',
        title: 'B-Side',
        description: `Watch 2 different videos containing "${pick.artist} - ${pick.title}".`,
        target: 2,
        reward_points: 100,
        params: { song_id: pick.song_id, seen: [] },
      };
    },
  },
  {
    weight: 1,
    build(ctx) {
      if (!attainableTarget(ctx.unrated, 1, 1)) return null;
      return {
        quest_type: 'low_rate',
        title: 'Tough Crowd',
        description: 'Rate something 1 or 2 stars. Honest curation beats a wall of fives.',
        target: 1,
        reward_points: 50,
        params: { lowRate: true },
      };
    },
  },
  {
    weight: 1,
    build(ctx) {
      const target = attainableTarget(ctx.hiRes, 4);
      if (!target) return null;
      return {
        quest_type: 'hires_views',
        title: 'Pixel Peeper',
        description: `Watch ${target} videos in 4K or larger.`,
        target,
        reward_points: 50 + target * 12,
        params: { hiRes: true },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const target = attainableTarget(ctx.total, 5);
      if (!target) return null;
      return {
        quest_type: 'collect_items',
        title: 'Curator',
        description: `Add ${target} files to your collections.`,
        target,
        reward_points: 40 + target * 6,
        params: { collect: true },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const target = attainableTarget(ctx.total, 3);
      if (!target) return null;
      return {
        quest_type: 'note_items',
        title: 'Scrapbook',
        description: `Leave notes on ${target} files. Tip: "2:35" in a note becomes a link that seeks.`,
        target,
        reward_points: 45 + target * 8,
        params: { note: true },
      };
    },
  },
  {
    weight: 2,
    build(ctx) {
      const target = attainableTarget(ctx.unfaved, 5);
      if (!target) return null;
      return {
        quest_type: 'fave_items',
        title: 'Heart Collector',
        description: `Fave ${target} files you haven't faved before.`,
        target,
        reward_points: 40 + target * 6,
        params: { fave: true },
      };
    },
  },
];

/* ── Generation ──────────────────────────────────────────────────────────── */

function activeQuests() {
  const conn = db.get();
  return conn.prepare(`SELECT * FROM gamify_quests WHERE status = 'active' ORDER BY created_at`).all();
}

function expireStale() {
  const conn = db.get();
  // Hard TTL: nothing lingers past a week, progress or not
  conn.prepare(`
    UPDATE gamify_quests SET status = 'expired'
    WHERE status = 'active' AND created_at < datetime('now', 'localtime', ?)
  `).run(`-${QUEST_TTL_DAYS} days`);
  // Daily rotation: untouched quests (zero progress) reroll each day so the
  // board stays fresh; anything IN PROGRESS stays until done or the TTL.
  conn.prepare(`
    UPDATE gamify_quests SET status = 'expired'
    WHERE status = 'active' AND COALESCE(progress, 0) = 0
      AND date(created_at) < date('now', 'localtime')
  `).run();
}

/** Quest board size grows with level: 3 base, +1 at level 4, +1 at level 7. */
function questSlots() {
  let level = 0;
  try {
    const gamify = require('./gamify');
    level = gamify.levelInfo(gamify.settleDay().score).level || 0;
  } catch {}
  return ACTIVE_QUEST_COUNT + (level >= 4 ? 1 : 0) + (level >= 7 ? 1 : 0);
}

// One top-up per finished background profile, however many calls waited on it
let _refillPending = false;

/** True while the board waits on a library profile still being built. */
function awaitingLibrary() {
  return _refillPending;
}

/**
 * Top up to the level-scaled slot count, avoiding duplicate quest types.
 * On a large library seen for the first time the library profile is still
 * being built in the background: the board is left as it is and topped up
 * as soon as the profile is ready.
 */
function ensureQuests() {
  expireStale();
  const conn = db.get();
  const slots = questSlots();
  let active = activeQuests();
  if (active.length >= slots) return active;

  const library = require('./gamify-library');
  const lib = library.profile();
  if (!lib) {
    if (!_refillPending) {
      _refillPending = true;
      library.whenReady().then((ready) => {
        _refillPending = false;
        // null: the library was locked meanwhile; the next call tries again
        if (ready) { try { module.exports.ensureQuests(); } catch (err) { console.warn(`[gamify] quest top-up failed: ${err.message}`); } }
      }, () => { _refillPending = false; });   // pass failed (logged): the next call starts another
    }
    return active;
  }

  const gamify = require('./gamify');
  const ctx = {
    ...lib.quests,
    songs: sharedSongPicks(),
    streakDays: gamify.settleDay().streak_days,
  };

  const insert = conn.prepare(`
    INSERT INTO gamify_quests (quest_type, title, description, target, reward_points, params)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let attempts = 0;
  while (active.length < slots && attempts < 30) {
    attempts++;
    const activeTypes = new Set(active.map(q => q.quest_type));
    // Weighted random pick; duplicates filtered after build (types are cheap)
    const totalWeight = TEMPLATES.reduce((s, t) => s + t.weight, 0);
    let roll = Math.random() * totalWeight;
    let tmpl = TEMPLATES[0];
    for (const t of TEMPLATES) {
      roll -= t.weight;
      if (roll <= 0) { tmpl = t; break; }
    }
    const q = tmpl.build(ctx);
    if (!q || activeTypes.has(q.quest_type)) continue;
    insert.run(q.quest_type, q.title, q.description, q.target, q.reward_points, JSON.stringify(q.params));
    active = activeQuests();
  }
  return active;
}

/* ── Progress tracking ───────────────────────────────────────────────────── */

function completeQuest(quest) {
  const conn = db.get();
  conn.prepare(`
    UPDATE gamify_quests SET status = 'completed', progress = target,
      completed_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(quest.id);
  conn.prepare(`UPDATE gamify_stats SET quests_completed = quests_completed + 1 WHERE id = 1`).run();

  const gamify = require('./gamify');
  gamify.awardPoints(quest.reward_points, 'quest_complete', quest.title);
}

function bumpQuest(quest) {
  const conn = db.get();
  const progress = quest.progress + 1;
  if (progress >= quest.target) {
    completeQuest(quest);
    return { id: quest.id, title: quest.title, completed: true, reward: quest.reward_points };
  }
  conn.prepare(`UPDATE gamify_quests SET progress = ? WHERE id = ?`).run(progress, quest.id);
  return { id: quest.id, title: quest.title, progress, target: quest.target, completed: false };
}

function parseParams(quest) {
  try { return JSON.parse(quest.params || '{}'); } catch { return {}; }
}

/**
 * Advance any matching quests when a view is recorded.
 *
 * `isWatch` is true only for video/audio views (the client posts those only
 * after the 30%/180s watch threshold) — ALL view quests require it, so
 * flipping through photos never advances a quest.
 *
 * view_count has already been bumped server-side by incrementViewCount,
 * so "unseen" means view_count <= 1 (this view was the first).
 */
function onView(media, isWatch = false) {
  const events = [];
  const conn = db.get();
  const gamify = require('./gamify');

  // Theme ∪ tag, normalized — a watch matching EITHER advances a label quest
  const mediaLabels = labelsOf(media);
  let themes = [];
  try { themes = JSON.parse(media.themes || '[]'); } catch {}

  for (const quest of activeQuests()) {
    const p = parseParams(quest);
    let matches = false;

    if (p.label) matches = isWatch && mediaLabels.has(p.label);
    else if (p.theme) matches = isWatch && themes.includes(p.theme);   // pre-label quests, until they expire
    else if (p.unseenOnly) matches = isWatch && (media.view_count || 0) <= 1;
    else if (p.media_type) matches = isWatch && media.media_type === p.media_type;
    else if (p.language) matches = isWatch && (media.language || '') === p.language;
    else if (p.subtitled) matches = isWatch && hasSubtitleTrack(conn, media.id);
    else if (p.timeCapsule) matches = isWatch && isOldestUnwatched(conn, media);
    else if (p.minDuration) matches = isWatch && (media.duration_seconds || 0) >= p.minDuration;
    else if (p.maxDuration) matches = isWatch && media.duration_seconds > 0 && media.duration_seconds < p.maxDuration;
    else if (p.hiRes) matches = isWatch && ((media.width || 0) >= 3840 || (media.height || 0) >= 2160);
    else if (p.song_id) {
      // B-Side needs 2 DIFFERENT videos — remember which ids already counted
      if (isWatch && mediaHasSong(conn, media.id, p.song_id)) {
        const seen = Array.isArray(p.seen) ? p.seen : [];
        if (!seen.includes(media.id)) {
          seen.push(media.id);
          conn.prepare('UPDATE gamify_quests SET params = ? WHERE id = ?')
            .run(JSON.stringify({ ...p, seen }), quest.id);
          events.push(bumpQuest(quest));
        }
      }
      continue;
    }
    else if (p.daily) {
      const progress = Math.min(todayWatchCount(), quest.target);
      if (progress > quest.progress) {
        if (progress >= quest.target) {
          completeQuest(quest);
          events.push({ id: quest.id, title: quest.title, completed: true, reward: quest.reward_points });
        } else {
          conn.prepare(`UPDATE gamify_quests SET progress = ? WHERE id = ?`).run(progress, quest.id);
          events.push({ id: quest.id, title: quest.title, progress, target: quest.target, completed: false });
        }
      }
      continue;
    } else if (p.streak) {
      const streak = gamify.settleDay().streak_days;
      const progress = Math.min(streak, quest.target);
      if (progress > quest.progress) {
        if (progress >= quest.target) {
          completeQuest(quest);
          events.push({ id: quest.id, title: quest.title, completed: true, reward: quest.reward_points });
        } else {
          conn.prepare(`UPDATE gamify_quests SET progress = ? WHERE id = ?`).run(progress, quest.id);
          events.push({ id: quest.id, title: quest.title, progress, target: quest.target, completed: false });
        }
      }
      continue;
    }

    if (matches) events.push(bumpQuest(quest));
  }

  ensureQuests(); // top back up if something completed
  return events;
}

/** Advance rate-quests when the user rates a previously-unrated item.
 *  Tough Crowd additionally needs the new rating to be 1–2 stars. */
function onRate(media, previousRating) {
  if (previousRating > 0) return [];
  const events = [];
  for (const quest of activeQuests()) {
    const p = parseParams(quest);
    if (p.rate) events.push(bumpQuest(quest));
    else if (p.lowRate && media.user_rating >= 1 && media.user_rating <= 2) events.push(bumpQuest(quest));
  }
  ensureQuests();
  return events;
}

/** Curation quests (fave / note / collection adds). `times` covers bulk adds —
 *  a 3-file collection drop advances Curator by 3 in one call. */
function onAction(paramKey, times = 1) {
  const events = [];
  for (const quest of activeQuests()) {
    if (!parseParams(quest)[paramKey]) continue;
    for (let i = 0; i < times; i++) {
      const ev = bumpQuest({ ...quest, progress: quest.progress + i });
      events.push(ev);
      if (ev.completed) break;
    }
  }
  ensureQuests();
  return events;
}

const onFave = () => onAction('fave');
const onNote = () => onAction('note');
const onCollect = (added = 1) => onAction('collect', added);

/* ── Manual reroll (one per local day) ──────────────────────────────────── */

const REFRESHES_PER_DAY = 1;

function refreshesUsedToday() {
  const conn = db.get();
  return conn.prepare(`
    SELECT COUNT(*) AS n FROM gamify_events
    WHERE event_type = 'quest_refresh' AND date(created_at) = date('now', 'localtime')
  `).get().n;
}

function refreshesLeftToday() {
  return Math.max(0, REFRESHES_PER_DAY - refreshesUsedToday());
}

/**
 * Swap one active quest for a fresh one (any progress on it is forfeit).
 * Limited to REFRESHES_PER_DAY, tracked as zero-point gamify_events rows so
 * no schema changes are needed and stats/streaks are unaffected
 * (last_active_date only moves on real views).
 */
function refreshQuest(questId) {
  const conn = db.get();
  const quest = conn.prepare(`SELECT * FROM gamify_quests WHERE id = ? AND status = 'active'`).get(questId);
  if (!quest) { const e = new Error('quest not found'); e.code = 'NOT_FOUND'; throw e; }
  if (refreshesLeftToday() <= 0) {
    const e = new Error('quest refresh already used today. Next one at midnight'); e.code = 'LIMIT'; throw e;
  }
  conn.prepare(`UPDATE gamify_quests SET status = 'expired' WHERE id = ?`).run(questId);
  conn.prepare(`INSERT INTO gamify_events (event_type, points, detail) VALUES ('quest_refresh', 0, ?)`)
    .run(JSON.stringify({ quest_id: questId, quest_type: quest.quest_type }));
  return { quests: ensureQuests(), refreshesLeft: refreshesLeftToday() };
}

/** One transaction per call: each separate commit syncs the file to disk
 *  (about 20 ms apiece), and a top-up or a rating writes several rows. */
const inTransaction = (fn) => (...args) => db.get().transaction(fn)(...args);

module.exports = {
  ensureQuests: inTransaction(ensureQuests),
  activeQuests,
  awaitingLibrary,
  onView,
  onRate: inTransaction(onRate),
  onFave: inTransaction(onFave),
  onNote: inTransaction(onNote),
  onCollect: inTransaction(onCollect),
  refreshQuest: inTransaction(refreshQuest),
  refreshesLeftToday,
};
