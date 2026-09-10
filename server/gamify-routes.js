/**
 * Gamification API routes — mounted at /api/gamify ONLY when the server is
 * started with --gamify (see server/index.js). All data is local SQLite.
 *
 * The share card is generated as SVG here; the client rasterizes it to PNG
 * via canvas for download/clipboard (no image library needed server-side).
 */

const express = require('express');
const gamify = require('../lib/gamify');
const quests = require('../lib/quests');

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function formatWatchTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** 30-day score sparkline as an SVG polyline points string. */
function sparklinePoints(history, x, y, w, h) {
  if (history.length < 2) return null;
  const scores = history.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return history.map((r, i) => {
    const px = x + (i / (history.length - 1)) * w;
    const py = y + h - ((r.score - min) / range) * h;
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(' ');
}

function buildShareCardSvg() {
  const s = gamify.getPublicStats();
  const theme = s.theme || { a: '#a855f7', b: '#ec4899' };
  const history = gamify.getHistory(30);
  const points = sparklinePoints(history, 40, 250, 520, 90);

  // EXP bar toward the next level (full when max level)
  const expW = 520;
  const expFill = Math.max(6, Math.round(expW * s.progress));
  const expLabel = s.nextAt
    ? `${Math.round(s.score).toLocaleString()} / ${s.nextAt.toLocaleString()} EXP → ${s.nextName}`
    : 'MAX LEVEL';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12141c"/>
      <stop offset="1" stop-color="#1c1030"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${theme.a}"/>
      <stop offset="1" stop-color="${theme.b}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="400" rx="20" fill="url(#bg)"/>
  <rect x="1" y="1" width="598" height="398" rx="19" fill="none" stroke="#3b2b57" stroke-width="2"/>

  <text x="40" y="52" font-family="Segoe UI, Arial, sans-serif" font-size="17" fill="#8b87a0">OBSESSION SCORE</text>
  <text x="40" y="118" font-family="Segoe UI, Arial, sans-serif" font-size="58" font-weight="bold" fill="#f5f3ff">${esc(Math.round(s.score).toLocaleString())}</text>
  <text x="40" y="150" font-family="Segoe UI, Arial, sans-serif" font-size="19" fill="url(#accent)" font-weight="600">Lv ${s.level}: ${esc(s.name)}</text>

  <text x="560" y="52" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="30" fill="#fbbf24">🔥 ${s.streakDays}</text>
  <text x="560" y="74" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="13" fill="#8b87a0">day streak</text>

  <!-- EXP bar toward next level -->
  <rect x="40" y="164" width="${expW}" height="12" rx="6" fill="#2a2438"/>
  <rect x="40" y="164" width="${expFill}" height="12" rx="6" fill="url(#accent)"/>
  <text x="40" y="194" font-family="Segoe UI, Arial, sans-serif" font-size="12" fill="#8b87a0">${esc(expLabel)}</text>

  <g font-family="Segoe UI, Arial, sans-serif">
    <text x="40" y="222" font-size="13" fill="#8b87a0">VIEWS</text>
    <text x="40" y="246" font-size="21" fill="#e8e6f0" font-weight="600">${s.totalViews.toLocaleString()}</text>
    <text x="185" y="222" font-size="13" fill="#8b87a0">WATCH TIME</text>
    <text x="185" y="246" font-size="21" fill="#e8e6f0" font-weight="600">${esc(formatWatchTime(s.totalWatchTimeS))}</text>
    <text x="350" y="222" font-size="13" fill="#8b87a0">QUESTS DONE</text>
    <text x="350" y="246" font-size="21" fill="#e8e6f0" font-weight="600">${s.questsCompleted}</text>
  </g>

  ${points ? `<polyline points="${points}" fill="none" stroke="url(#accent)" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
</svg>`;
}

function buildRouter() {
  const router = express.Router();

  // Full stats for the modal
  router.get('/stats', (req, res) => {
    res.json(gamify.getPublicStats());
  });

  // Active quests (tops up to the level-scaled slot count, rotates daily)
  router.get('/quests', (req, res) => {
    res.json({ quests: quests.ensureQuests(), refreshesLeft: quests.refreshesLeftToday() });
  });

  // Swap one quest for a fresh roll (1/day)
  router.post('/quests/:id/refresh', (req, res) => {
    try {
      res.json(quests.refreshQuest(Number(req.params.id)));
    } catch (err) {
      res.status(err.code === 'LIMIT' ? 429 : err.code === 'NOT_FOUND' ? 404 : 500)
        .json({ error: err.message });
    }
  });

  // Daily score history for the Full Stats chart
  router.get('/history', (req, res) => {
    res.json(gamify.getHistory(Number(req.query.days) || 30));
  });

  // Achievements: full list for the Full Stats tab
  router.get('/achievements', (req, res) => {
    try {
      res.json(require('../lib/achievements').getAchievements());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Client-side achievement events (random uses, AB loop, beat bar, …)
  router.post('/event', (req, res) => {
    try {
      const type = (req.body?.type || '').toString();
      if (!type) return res.status(400).json({ error: 'type required' });
      res.json({ unlocked: require('../lib/achievements').recordEvent(type) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Full-stats analytics (heatmap, theme drift, library growth).
  // Always answer JSON — a thrown error must not fall through to Express's
  // HTML error page (the client JSON.parses the response).
  // Computed entirely from the local DB — nothing is uploaded or phoned home.
  router.get('/analytics', (req, res) => {
    try {
      res.json(gamify.getAnalytics());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cosmetic theme selection (level-gated server-side)
  router.post('/theme', (req, res) => {
    const t = gamify.setSelectedTheme((req.body?.id || '').toString());
    if (!t) return res.status(400).json({ error: 'theme locked or unknown' });
    res.json(gamify.getPublicStats());
  });

  // Share card (SVG — client rasterizes to PNG for download/copy)
  router.get('/share-card.svg', (req, res) => {
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'no-store');
    res.send(buildShareCardSvg());
  });

  return router;
}

module.exports = { buildRouter };
