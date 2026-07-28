/* =========================================================================
   GAMIFY UI — opt-in "Obsession Score" tracker (fitness-app style)

   Renders NOTHING unless GET /api/gamify/status says enabled (server was
   started with --gamify). All data is local; the share card is generated
   as a PNG in-browser from a server-rendered SVG.

   Pieces:
   - Header chip: 🔥 score, pulses on points/level-up
   - Phone-style modal: score + level bar, streak heatmap, quests,
     30-day score chart, stats, share button
   - Listens for 'gamify:update' events dispatched by viewtracker.js
   ========================================================================= */

(function () {
  let _enabled = false;
  let _stats = null;
  let _theme = { a: '#a855f7', b: '#ec4899' };

  /* ── Bootstrap ──────────────────────────────────────────────────────────── */

  /**
   * "Hide Obsession Score" (Settings) is presentational ONLY — the chip and the
   * point toasts go away, scoring carries on. That's deliberate: tracking lives
   * server-side in /api/media/:id/viewed, so a user who unhides later finds
   * their real history rather than a gap. `--no-gamify` is the actual off
   * switch; see resolveGamifyEnabled in server/index.js.
   */
  const isHidden = () =>
    typeof window.vaultSetting === 'function' && !!window.vaultSetting('gamifyHidden');

  async function init() {
    try {
      const resp = await fetch('/api/gamify/status');
      const status = await resp.json();
      if (!status.enabled) return; // hard off (--no-gamify) — zero UI
      _enabled = true;
      _stats = status.stats;
      applyTheme(_stats?.theme);
      // Built either way so the Settings toggle can show/hide instantly instead
      // of demanding a reload; applyHidden() decides what's on screen.
      buildHeaderChip();
      buildModalShell();
      applyHidden(isHidden());
      installAchievementHooks();
      window.addEventListener('gamify:update', onGamifyUpdate);
    } catch {
      /* server unreachable or old server — stay silent */
    }
  }

  /** Show/hide the chip. Called at boot and by the Settings toggle. */
  function applyHidden(hidden) {
    const chip = document.getElementById('gamifyChip');
    if (chip) chip.style.display = hidden ? 'none' : '';
    if (hidden) closeModal?.();          // don't strand an open modal behind a hide
  }
  window.vaultApplyGamifyHidden = applyHidden;

  /** Level-unlocked cosmetic theme → CSS vars used by all gamify gradients. */
  function applyTheme(theme) {
    if (!theme) return;
    _theme = theme;
    document.documentElement.style.setProperty('--gamify-a', theme.a);
    document.documentElement.style.setProperty('--gamify-b', theme.b);
  }

  /* ── Header chip ────────────────────────────────────────────────────────── */

  function buildHeaderChip() {
    const btns = document.querySelector('.header-buttons');
    if (!btns) return;
    const chip = document.createElement('button');
    chip.className = 'header-btn gamify-chip';
    chip.id = 'gamifyChip';
    chip.title = 'Obsession Score — click for your stats';
    chip.onclick = openModal;
    btns.insertBefore(chip, btns.firstChild);
    renderChip();
  }

  function renderChip() {
    const chip = document.getElementById('gamifyChip');
    if (!chip || !_stats) return;
    chip.innerHTML =
      `<span class="gamify-chip-flame">🔥</span>` +
      `<span class="gamify-chip-score">${Math.round(_stats.score).toLocaleString()}</span>` +
      (_stats.streakDays > 1 ? `<span class="gamify-chip-streak">${_stats.streakDays}d</span>` : '');
  }

  function pulseChip() {
    const chip = document.getElementById('gamifyChip');
    if (!chip) return;
    chip.classList.remove('gamify-pulse');
    void chip.offsetWidth; // restart animation
    chip.classList.add('gamify-pulse');
  }

  /* ── Live updates from viewtracker ──────────────────────────────────────── */

  function onGamifyUpdate(e) {
    const result = e.detail;
    if (!result) return;
    // Stats still update while hidden — unhiding must show the real score, not
    // whatever it was when the user hid it. Only the visible reactions stop.
    _stats = result.stats;
    renderChip();
    if (isHidden()) return;
    pulseChip();

    showToast(`🔥 +${result.earned} pts`);
    for (const q of result.questEvents || []) {
      if (q.completed) {
        setTimeout(() => showToast(`🏆 Quest complete: ${q.title} (+${q.reward} pts)`), 1200);
      }
    }
    if (result.levelUp) {
      setTimeout(() => showToast(`⬆️ Level up! You are now: ${result.levelUp.name}`), 2400);
    }
    (result.achievements || []).forEach((a, i) => {
      setTimeout(() => showToast(`🏅 Achievement: ${a.icon} ${a.name}${a.tier > 1 ? ` (tier ${a.tier})` : ''} +${a.points} pts`), 3200 + i * 1400);
    });

    // If the modal is open, refresh it live
    if (document.getElementById('gamifyModal')?.classList.contains('active')) {
      renderModal();
    }
  }

  /* ── Modal ──────────────────────────────────────────────────────────────── */

  function buildModalShell() {
    const overlay = document.createElement('div');
    overlay.className = 'gamify-overlay';
    overlay.id = 'gamifyModal';
    overlay.innerHTML = `<div class="gamify-phone" role="dialog" aria-label="Obsession Score stats">
      <div class="gamify-phone-notch"></div>
      <button class="gamify-close" title="Close">✕</button>
      <div class="gamify-body" id="gamifyBody"></div>
    </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.gamify-close')) closeModal();
    });
    document.body.appendChild(overlay);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('active')) closeModal();
    });
  }

  async function openModal() {
    document.getElementById('gamifyModal').classList.add('active');
    await renderModal();
  }

  function closeModal() {
    document.getElementById('gamifyModal').classList.remove('active');
  }

  async function renderModal() {
    const body = document.getElementById('gamifyBody');
    body.innerHTML = `<div class="gamify-loading">Loading…</div>`;
    try {
      const [stats, questsResp, history, ach] = await Promise.all([
        fetch('/api/gamify/stats').then(r => r.json()),
        fetch('/api/gamify/quests').then(r => r.json()),
        fetch('/api/gamify/history?days=30').then(r => r.ok ? r.json() : []).catch(() => []),
        fetch('/api/gamify/achievements').then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      // { quests, refreshesLeft } (tolerate the old bare-array shape too)
      const quests = Array.isArray(questsResp) ? questsResp : (questsResp.quests || []);
      const refreshesLeft = Array.isArray(questsResp) ? 0 : (questsResp.refreshesLeft || 0);
      _stats = stats;
      applyTheme(stats.theme);
      renderChip();
      body.innerHTML =
        sectionScore(stats) +
        sectionStreak(stats) +
        sectionObsessed(stats) +
        sectionAchievements(ach) +
        sectionQuests(quests, refreshesLeft) +
        sectionChart(history) +
        sectionStats(stats) +
        sectionThemes(stats) +
        sectionShare();
      body.querySelector('#gamifyShareBtn')?.addEventListener('click', shareCard);
      body.querySelector('#gamifyAnalyticsBtn')?.addEventListener('click', () => openAnalytics('stats'));
      body.querySelector('#gamifyAchCard')?.addEventListener('click', () => openAnalytics('achievements'));
      body.querySelectorAll('.gamify-theme-pick').forEach(el =>
        el.addEventListener('click', () => selectTheme(el.dataset.theme)));
      body.querySelectorAll('.gamify-quest-reroll').forEach(btn =>
        btn.addEventListener('click', () => rerollQuest(Number(btn.dataset.quest))));
    } catch (err) {
      body.innerHTML = `<div class="gamify-loading">Couldn't load stats: ${err.message}</div>`;
    }
  }

  /* ── Sections ───────────────────────────────────────────────────────────── */

  function sectionScore(s) {
    const pct = Math.round(s.progress * 100);
    const nextLabel = s.nextAt
      ? `${Math.round(s.score).toLocaleString()} / ${s.nextAt.toLocaleString()} → ${s.nextName}`
      : 'MAX LEVEL';
    const wd = s.weekDelta;
    const deltaHtml = wd && (wd.thisWeek || wd.lastWeek)
      ? `<div class="gamify-week-delta ${wd.delta >= 0 ? 'up' : 'down'}">${wd.delta >= 0 ? '▲' : '▼'} ${wd.delta >= 0 ? '+' : ''}${wd.delta.toLocaleString()} pts vs last week</div>`
      : '';
    return `<div class="gamify-score-section">
      <div class="gamify-score-label">OBSESSION SCORE</div>
      <div class="gamify-score-value">${Math.round(s.score).toLocaleString()}</div>
      ${deltaHtml}
      <div class="gamify-level-name">Lv ${s.level} — ${escapeHtml(s.name)}</div>
      <div class="gamify-progressbar"><div class="gamify-progressbar-fill" style="width:${pct}%"></div></div>
      <div class="gamify-level-next">${nextLabel}</div>
    </div>`;
  }

  const MEDIA_ICON = { video: '🎬', audio: '🎵', image: '🖼', gif: '🎞', document: '📄', mix: '🎛' };

  function sectionObsessed(s) {
    const it = s.topItem;
    if (!it) return '';
    const stars = it.rating > 0 ? '★'.repeat(it.rating) + '☆'.repeat(5 - it.rating) : '';
    const meta = it.rating > 0
      ? `<span class="gamify-obsessed-stars">${stars}</span>`
      : `<span class="gamify-obsessed-sub">watched ${it.views}×</span>`;
    return `<div class="gamify-card gamify-obsessed" title="${escapeHtml(it.filename)}">
      <div class="gamify-card-title">🔥 Obsessed with</div>
      <div class="gamify-obsessed-name">${MEDIA_ICON[it.media_type] || '📦'} ${escapeHtml(it.filename)}</div>
      ${meta}
    </div>`;
  }

  function sectionStreak(s) {
    // 30-day heatmap, oldest → newest, today rightmost
    const active = new Set(s.activeDays || []);
    let cells = '';
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      cells += `<div class="gamify-heat-cell${active.has(ymd) ? ' on' : ''}${i === 0 ? ' today' : ''}" title="${ymd}"></div>`;
    }
    return `<div class="gamify-card">
      <div class="gamify-card-title">🔥 ${s.streakDays}-day streak</div>
      <div class="gamify-heatmap">${cells}</div>
    </div>`;
  }

  function sectionQuests(quests, refreshesLeft = 0) {
    if (!quests.length) {
      return `<div class="gamify-card"><div class="gamify-card-title">🗺️ Quests</div>
        <div class="gamify-empty">New quests arriving soon…</div></div>`;
    }
    const items = quests.map(q => {
      const pct = Math.min(100, Math.round((q.progress / q.target) * 100));
      const reroll = refreshesLeft > 0
        ? `<button class="gamify-quest-reroll" data-quest="${q.id}" title="Swap for a different quest (1 reroll per day; progress is lost)">🔄</button>`
        : `<button class="gamify-quest-reroll" disabled title="Daily reroll used — next one at midnight">🔄</button>`;
      return `<div class="gamify-quest">
        <div class="gamify-quest-head">
          <span class="gamify-quest-title">${escapeHtml(q.title)}</span>
          <span class="gamify-quest-reward">+${q.reward_points}</span>
          ${reroll}
        </div>
        <div class="gamify-quest-desc">${escapeHtml(q.description)}</div>
        <div class="gamify-progressbar small"><div class="gamify-progressbar-fill" style="width:${pct}%"></div></div>
        <div class="gamify-quest-progress">${q.progress} / ${q.target}</div>
      </div>`;
    }).join('');
    const hint = refreshesLeft > 0 ? ` <span class="gamify-ach-count" title="Daily quest reroll available">1×🔄</span>` : '';
    return `<div class="gamify-card"><div class="gamify-card-title">🗺️ Active Quests${hint}</div>${items}</div>`;
  }

  async function rerollQuest(questId) {
    try {
      const resp = await fetch(`/api/gamify/quests/${questId}/refresh`, { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) { showToast('⚠ ' + (data.error || 'reroll failed')); return; }
      showToast('🔄 Quest rerolled');
      renderModal();
    } catch (err) {
      showToast('⚠ ' + err.message);
    }
  }

  function sectionChart(history) {
    if (history.length < 2) {
      return `<div class="gamify-card"><div class="gamify-card-title">📈 Score — 30 days</div>
        <div class="gamify-empty">Chart unlocks after two active days.</div></div>`;
    }
    const W = 300, H = 80, PAD = 4;
    const scores = history.map(r => r.score);
    const min = Math.min(...scores), max = Math.max(...scores);
    const range = max - min || 1;
    const pts = history.map((r, i) => {
      const x = PAD + (i / (history.length - 1)) * (W - PAD * 2);
      const y = PAD + (H - PAD * 2) * (1 - (r.score - min) / range);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<div class="gamify-card"><div class="gamify-card-title">📈 Score — 30 days</div>
      <svg class="gamify-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <polyline points="${pts}" fill="none" stroke="url(#gamifyGrad)" stroke-width="2.5"
          stroke-linejoin="round" stroke-linecap="round"/>
        <defs><linearGradient id="gamifyGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="${_theme.a}"/><stop offset="1" stop-color="${_theme.b}"/>
        </linearGradient></defs>
      </svg></div>`;
  }

  function sectionStats(s) {
    const themes = (s.topThemes || []).map(t =>
      `<span class="gamify-theme-tag">${escapeHtml(t.theme)} <em>${t.count}</em></span>`).join('') || '<span class="gamify-empty">none yet</span>';
    return `<div class="gamify-card"><div class="gamify-card-title">📊 Totals</div>
      <div class="gamify-totals">
        <div><b>${s.totalViews.toLocaleString()}</b><span>views</span></div>
        <div><b>${formatWatch(s.totalWatchTimeS)}</b><span>watched</span></div>
        <div><b>${s.questsCompleted}</b><span>quests</span></div>
        <div><b>💦 ${(s.finishers || 0).toLocaleString()}</b><span>finishers</span></div>
      </div>
      <div class="gamify-card-title" style="margin-top:10px">🎭 Top themes (30d)</div>
      <div class="gamify-themes">${themes}</div>
    </div>`;
  }

  function sectionThemes(s) {
    const chips = (s.themes || []).map(t => {
      const selected = s.theme?.id === t.id;
      if (!t.unlocked) {
        return `<div class="gamify-theme-pick locked" title="Unlocks at level ${t.minLevel}">
          <span class="gamify-theme-dot" style="background:linear-gradient(135deg,${t.a},${t.b})"></span>
          <span class="gamify-theme-name">🔒 Lv ${t.minLevel}</span></div>`;
      }
      return `<div class="gamify-theme-pick ${selected ? 'selected' : ''}" data-theme="${t.id}" title="${escapeHtml(t.name)}">
        <span class="gamify-theme-dot" style="background:linear-gradient(135deg,${t.a},${t.b})"></span>
        <span class="gamify-theme-name">${escapeHtml(t.name)}</span></div>`;
    }).join('');
    return `<div class="gamify-card"><div class="gamify-card-title">🎨 Theme <small style="font-weight:400;color:var(--text-muted)">(level up to unlock)</small></div>
      <div class="gamify-theme-grid">${chips}</div></div>`;
  }

  async function selectTheme(id) {
    if (!id) return;
    try {
      const resp = await fetch('/api/gamify/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!resp.ok) throw new Error('locked');
      _stats = await resp.json();
      applyTheme(_stats.theme);
      renderChip();
      renderModal();
      showToast(`🎨 Theme: ${_stats.theme.name}`);
    } catch {
      showToast('That theme is still locked');
    }
  }

  /** Compact achievements card in the modal — click for the full tab. */
  function sectionAchievements(ach) {
    if (!ach) return '';
    const recent = [...ach.tiered.filter(a => a.tier > 0), ...ach.hidden.filter(a => a.tier > 0)]
      .sort((a, b) => (b.unlocked_at || '').localeCompare(a.unlocked_at || ''))
      .slice(0, 5)
      .map(a => `<span title="${escapeHtml(a.name)}">${a.icon}</span>`).join(' ');
    const n = ach.next;
    const teaser = n ? `
      <div class="gamify-ach-next">
        <div class="gamify-ach-next-head"><span>${n.icon} ${escapeHtml(n.name)}</span><span class="gamify-ach-next-val">${n.value ?? ''}${n.tiers ? ` / ${n.tiers[n.tier]}` : ''}</span></div>
        <div class="gamify-ach-next-desc">Next: ${escapeHtml(n.desc)}</div>
        <div class="gamify-progressbar small"><div class="gamify-progressbar-fill" style="width:${Math.round(n.progress * 100)}%"></div></div>
      </div>` : '';
    return `<div class="gamify-card gamify-ach-card" id="gamifyAchCard" title="Open all achievements" style="cursor:pointer">
      <div class="gamify-card-title">🏅 Achievements <span class="gamify-ach-count">${ach.earned}/${ach.total}</span></div>
      <div class="gamify-ach-recent">${recent || '<span class="gamify-empty">None yet — go watch something!</span>'}</div>
      ${teaser}
    </div>`;
  }

  function sectionShare() {
    return `<div class="gamify-share-row">
      <button class="gamify-analytics-btn" id="gamifyAnalyticsBtn">📈 Full stats</button>
      <button class="gamify-share-btn" id="gamifyShareBtn">📸 Share card</button>
    </div>`;
  }

  /* ── Full-stats analytics overlay ───────────────────────────────────────── */

  async function openAnalytics(tab = 'stats') {
    let overlay = document.getElementById('gamifyAnalytics');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'gamifyAnalytics';
      overlay.className = 'gamify-overlay';
      overlay.innerHTML = `<div class="gamify-analytics-panel" role="dialog" aria-label="Full stats">
        <button class="gamify-close" title="Close">✕</button>
        <div class="gamify-tabs">
          <button class="gamify-tab" data-tab="stats">📈 Stats</button>
          <button class="gamify-tab" data-tab="achievements">🏅 Achievements</button>
        </div>
        <div class="gamify-analytics-body" id="gamifyAnalyticsBody"></div>
      </div>`;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay || e.target.closest('.gamify-close')) overlay.classList.remove('active');
        const tabBtn = e.target.closest('.gamify-tab');
        if (tabBtn) showAnalyticsTab(tabBtn.dataset.tab);
      });
      document.body.appendChild(overlay);
    }
    overlay.classList.add('active');
    showAnalyticsTab(tab);
  }

  async function showAnalyticsTab(tab) {
    document.querySelectorAll('#gamifyAnalytics .gamify-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    const body = document.getElementById('gamifyAnalyticsBody');
    body.innerHTML = '<div class="gamify-loading">Crunching your history…</div>';
    try {
      if (tab === 'achievements') {
        const resp = await fetch('/api/gamify/achievements');
        if (!resp.ok) throw new Error(`server error ${resp.status} — restart the server if it's an older build`);
        body.innerHTML = renderAchievementsTab(await resp.json());
        return;
      }
      const resp = await fetch('/api/gamify/analytics');
      if (resp.status === 404) {
        // Old server process without the analytics route — the UI files are
        // served fresh on reload but server routes need a restart
        throw new Error('the server is running an older build — restart it (close the window / re-run start.bat) to enable Full Stats');
      }
      if (!resp.ok) {
        let msg = `server error ${resp.status}`;
        try { msg = (await resp.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const a = await resp.json();
      body.innerHTML =
        `<div class="gamify-analytics-title">📈 Full Stats</div>` +
        (a.milestones ? analyticsMilestones(a.milestones) : '') +
        analyticsHeatmap(a.hourDow) +
        analyticsDaily(a.daily) +
        (a.ratings ? analyticsRatings(a.ratings) : '') +
        (a.finishers ? analyticsFinishers(a.finishers) : '') +
        analyticsThemeDrift(a.themeDrift) +
        (a.underTags ? analyticsUnderTags(a.underTags) : '') +
        (a.notes ? analyticsNotes(a.notes) : '') +
        analyticsGrowth(a.growth);
    } catch (err) {
      body.innerHTML = `<div class="gamify-loading">Couldn't load: ${escapeHtml(err.message)}</div>`;
    }
  }

  /** Achievements tab: tiered with progress bars, hidden masked as ??? */
  function renderAchievementsTab(ach) {
    const tierPips = (a) => Array.from({ length: a.maxTier }, (_, i) =>
      `<span class="ach-pip ${i < a.tier ? 'on' : ''}"></span>`).join('');
    const row = (a) => `
      <div class="ach-row ${a.tier > 0 ? 'unlocked' : ''}">
        <span class="ach-icon">${a.icon}</span>
        <div class="ach-main">
          <div class="ach-head">
            <span class="ach-name">${escapeHtml(a.name)}</span>
            <span class="ach-pips">${a.maxTier > 1 ? tierPips(a) : (a.tier ? '🏅' : '')}</span>
          </div>
          <div class="ach-desc">${escapeHtml(a.desc)}${a.value != null && a.tier < a.maxTier ? ` · <em>${a.value}</em>` : ''}</div>
          <div class="gamify-progressbar small"><div class="gamify-progressbar-fill" style="width:${Math.round(a.progress * 100)}%"></div></div>
        </div>
      </div>`;
    return `
      <div class="gamify-analytics-title">🏅 Achievements <span class="gamify-ach-count">${ach.earned}/${ach.total}</span></div>
      <div class="gamify-card"><div class="gamify-card-title">Milestones</div>${ach.tiered.map(row).join('')}</div>
      <div class="gamify-card"><div class="gamify-card-title">Hidden</div>${ach.hidden.map(row).join('')}</div>`;
  }

  /* ── Client-side achievement events (only when gamify is on) ────────────── */

  function gamifyEvent(type) {
    if (!_enabled) return;
    fetch('/api/gamify/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    }).then(r => r.ok ? r.json() : null).then(data => {
      (data?.unlocked || []).forEach((a, i) =>
        setTimeout(() => showToast(`🏅 Achievement: ${a.icon} ${a.name} +${a.points} pts`), i * 1400));
    }).catch(() => {});
  }
  window.gamifyEvent = gamifyEvent;

  /** Hook fun actions for hidden achievements — all in one place. */
  function installAchievementHooks() {
    // 🎧 Eavesdropper: first search with the 💬 Subtitles corpus enabled
    if (typeof executeSearch === 'function') {
      const origSearch = executeSearch;
      let eavesdropped = false;
      executeSearch = function (query, ...rest) {
        if (!eavesdropped && query && typeof subtitleSearchOn === 'function' && subtitleSearchOn()) {
          eavesdropped = true;                    // once per session is plenty
          gamifyEvent('transcript_search');
        }
        return origSearch.apply(this, arguments);
      };
    }
    if (typeof playRandomMedia === 'function') {
      const orig = playRandomMedia;
      playRandomMedia = function (...a) { gamifyEvent('random_uses'); return orig.apply(this, a); };
    }
    if (typeof toggleAbLoop === 'function') {
      const orig = toggleAbLoop;
      toggleAbLoop = function (...a) {
        const r = orig.apply(this, a);
        if (typeof abLoopA === 'number' && typeof abLoopB === 'number') gamifyEvent('abloop');
        return r;
      };
    }
    if (typeof cycleSpeed === 'function') {
      const orig = cycleSpeed;
      cycleSpeed = function (...a) {
        const r = orig.apply(this, a);
        if ((currentMediaState?.element?.playbackRate || 1) >= 3) gamifyEvent('speed3x');
        return r;
      };
    }
    if (typeof toggleBeatBar === 'function') {
      const orig = window.toggleBeatBar;
      window.toggleBeatBar = function (...a) {
        const r = orig.apply(this, a);
        if (localStorage.getItem('beatbar_enabled') === '1') gamifyEvent('beatbar');
        return r;
      };
    }
    if (typeof rotateImage === 'function') {
      const orig = rotateImage;
      let spun = 0;
      rotateImage = function (deg, ...a) {
        spun += Math.abs(deg || 0);
        if (spun >= 1080) { spun = 0; gamifyEvent('spin_cycle'); }
        return orig.call(this, deg, ...a);
      };
    }
  }

  /** Hour-of-day × day-of-week watch heatmap. */
  function analyticsHeatmap(hourDow) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const max = Math.max(1, ...hourDow.flat());
    const rgb = _hexRgb(_theme.a);
    let rows = '';
    for (let d = 0; d < 7; d++) {
      const cells = hourDow[d].map((n, h) =>
        `<div class="ga-heat-cell" title="${days[d]} ${String(h).padStart(2, '0')}:00 — ${n} view${n === 1 ? '' : 's'}"
          style="background:rgba(${rgb},${n === 0 ? 0.06 : 0.15 + 0.85 * (n / max)})"></div>`).join('');
      rows += `<div class="ga-heat-row"><span class="ga-heat-day">${days[d]}</span>${cells}</div>`;
    }
    const hourLabels = [0, 6, 12, 18].map(h =>
      `<span style="left:${(h / 24) * 100}%">${h}:00</span>`).join('');
    return `<div class="gamify-card"><div class="gamify-card-title">🕒 When you watch</div>
      <div class="ga-heatmap">${rows}</div>
      <div class="ga-heat-hours">${hourLabels}</div></div>`;
  }

  /** 90-day activity bars (points earned per day). */
  function analyticsDaily(daily) {
    if (!daily.length) return _emptyCard('📊 Daily activity', 'No activity recorded yet.');
    const W = 600, H = 90;
    const max = Math.max(1, ...daily.map(r => r.points_earned));
    const bw = W / Math.max(daily.length, 30);
    const bars = daily.map((r, i) => {
      const bh = Math.max(1.5, (r.points_earned / max) * (H - 14));
      return `<rect x="${(i * bw).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="url(#gaGrad)"><title>${r.day}: ${Math.round(r.points_earned)} pts, ${r.views} views</title></rect>`;
    }).join('');
    return `<div class="gamify-card"><div class="gamify-card-title">📊 Daily points — last ${daily.length} active day${daily.length === 1 ? '' : 's'}</div>
      <svg class="ga-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${_gaGradDef()}${bars}</svg></div>`;
  }

  /** Weekly theme mix over 12 weeks — one line per top theme. */
  function analyticsThemeDrift(drift) {
    if (!drift.weeks.length || !drift.themes.length) {
      return _emptyCard('🎭 Theme drift', 'Watch more — theme trends appear after a few days.');
    }
    const W = 600, H = 110, PAD = 6;
    const palette = [_theme.a, _theme.b, '#38bdf8', '#4ade80', '#fbbf24'];
    const max = Math.max(1, ...drift.themes.flatMap(t => t.counts));
    const xs = (i) => drift.weeks.length === 1 ? W / 2 : PAD + (i / (drift.weeks.length - 1)) * (W - PAD * 2);
    const ys = (v) => H - PAD - (v / max) * (H - PAD * 2);
    const lines = drift.themes.map((t, ti) => {
      const pts = t.counts.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ');
      return `<polyline points="${pts}" fill="none" stroke="${palette[ti % palette.length]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }).join('');
    const legend = drift.themes.map((t, ti) =>
      `<span class="ga-legend-item"><span class="ga-legend-dot" style="background:${palette[ti % palette.length]}"></span>${escapeHtml(t.theme)}</span>`).join('');
    return `<div class="gamify-card"><div class="gamify-card-title">🎭 Theme drift — 12 weeks</div>
      <svg class="ga-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${lines}</svg>
      <div class="ga-legend">${legend}</div></div>`;
  }

  /** Cumulative library size over time. */
  function analyticsGrowth(growth) {
    if (growth.length < 2) return _emptyCard('📚 Library growth', 'Not enough history yet.');
    const W = 600, H = 90, PAD = 4;
    const max = growth[growth.length - 1].total;
    const xs = (i) => PAD + (i / (growth.length - 1)) * (W - PAD * 2);
    const ys = (v) => H - PAD - (v / max) * (H - PAD * 2);
    const pts = growth.map((r, i) => `${xs(i).toFixed(1)},${ys(r.total).toFixed(1)}`).join(' ');
    const area = `${PAD},${H - PAD} ${pts} ${W - PAD},${H - PAD}`;
    return `<div class="gamify-card"><div class="gamify-card-title">📚 Library growth — ${max.toLocaleString()} items</div>
      <svg class="ga-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${_gaGradDef()}
        <polygon points="${area}" fill="url(#gaGrad)" opacity="0.25"/>
        <polyline points="${pts}" fill="none" stroke="url(#gaGrad)" stroke-width="2.5" stroke-linejoin="round"/>
      </svg></div>`;
  }

  function _gaGradDef() {
    return `<defs><linearGradient id="gaGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${_theme.a}"/><stop offset="1" stop-color="${_theme.b}"/>
    </linearGradient></defs>`;
  }

  function _emptyCard(title, msg) {
    return `<div class="gamify-card"><div class="gamify-card-title">${title}</div>
      <div class="gamify-empty">${msg}</div></div>`;
  }

  /* ── New Full-Stats cards ─────────────────────────────────────────────── */

  function _fmtBytes(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`;
  }

  /** Milestone tiles: total content time, storage scanned, item count. */
  function analyticsMilestones(m) {
    const contentLabel = m.contentDays >= 1
      ? `${m.contentDays.toLocaleString()} days`
      : `${m.contentHours.toLocaleString()} hrs`;
    return `<div class="gamify-card"><div class="gamify-card-title">🏆 Milestones</div>
      <div class="gamify-milestones">
        <div><b>${contentLabel}</b><span>of content, back to back</span></div>
        <div><b>${_fmtBytes(m.storageBytes)}</b><span>scanned</span></div>
        <div><b>${m.items.toLocaleString()}</b><span>items in the vault</span></div>
      </div></div>`;
  }

  /** Average rating + 1–5 distribution bars + a trend arrow. */
  function analyticsRatings(r) {
    if (!r.count) return _emptyCard('⭐ Ratings', 'Rate some items to see the breakdown.');
    const max = Math.max(1, ...r.distribution);
    const bars = r.distribution.map((n, i) => `
      <div class="gamify-rating-row">
        <span class="gamify-rating-star">${i + 1}★</span>
        <div class="gamify-rating-track"><div class="gamify-rating-fill" style="width:${Math.round((n / max) * 100)}%"></div></div>
        <span class="gamify-rating-n">${n}</span>
      </div>`).reverse().join('');
    const trend = r.trend == null ? ''
      : ` <span class="gamify-week-delta ${r.trend >= 0 ? 'up' : 'down'}" style="display:inline-block;font-size:0.7em">${r.trend >= 0 ? '▲' : '▼'} ${r.trend >= 0 ? '+' : ''}${r.trend} (30d)</span>`;
    return `<div class="gamify-card"><div class="gamify-card-title">⭐ Ratings</div>
      <div class="gamify-rating-hero"><b>${r.avg.toFixed(2)}</b><span>avg over ${r.count.toLocaleString()} rated${trend}</span></div>
      <div class="gamify-rating-dist">${bars}</div></div>`;
  }

  /** Finisher rate % + a finishers-over-time bar chart (Daily-points style). */
  function analyticsFinishers(f) {
    const rate = f.rate;
    let chart = '';
    if (f.daily && f.daily.length) {
      const W = 600, H = 70;
      const max = Math.max(1, ...f.daily.map(r => r.n));
      const bw = W / Math.max(f.daily.length, 30);
      const bars = f.daily.map((r, i) => {
        const bh = Math.max(1.5, (r.n / max) * (H - 8));
        return `<rect x="${(i * bw).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${Math.max(1, bw - 1.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="url(#gaGrad)"><title>${r.day}: ${r.n} finisher${r.n === 1 ? '' : 's'}</title></rect>`;
      }).join('');
      chart = `<svg class="ga-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${_gaGradDef()}${bars}</svg>`;
    } else {
      chart = `<div class="gamify-empty" style="padding:8px 0">Finishers you mark from now on chart here.</div>`;
    }
    return `<div class="gamify-card"><div class="gamify-card-title">💦 Finishers</div>
      <div class="gamify-finisher-rate">
        <div class="gamify-finisher-pct">${rate.pct}%</div>
        <div class="gamify-finisher-sub">of watched videos finished<br><em>${rate.done.toLocaleString()} of ${rate.watched.toLocaleString()}</em></div>
      </div>
      ${chart}</div>`;
  }

  /** Tags with only 1–2 items — "haven't really explored these". */
  function analyticsUnderTags(u) {
    if (!u.total) return _emptyCard('🏷️ Underexplored tags', 'Every tag is well-explored — nice.');
    const chips = u.sample.map(t =>
      `<span class="gamify-theme-tag">${escapeHtml(t.tag)} <em>${t.n}</em></span>`).join('');
    return `<div class="gamify-card"><div class="gamify-card-title">🏷️ Underexplored tags <span class="gamify-ach-count">${u.total}</span></div>
      <div class="gamify-under-hint">Only 1–2 items each — barely touched:</div>
      <div class="gamify-themes">${chips}</div></div>`;
  }

  function analyticsNotes(n) {
    return `<div class="gamify-card"><div class="gamify-card-title">📝 Notes</div>
      <div class="gamify-totals">
        <div><b>${n.itemsWithNotes.toLocaleString()}</b><span>items annotated</span></div>
        <div><b>${n.snippets.toLocaleString()}</b><span>saved snippets</span></div>
      </div></div>`;
  }

  function _hexRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}` : '168,85,247';
  }

  /* ── Share card: server SVG → canvas → PNG (download + clipboard) ───────── */

  async function shareCard() {
    try {
      const svgText = await fetch('/api/gamify/share-card.svg').then(r => r.text());
      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = url; });

      const canvas = document.createElement('canvas');
      canvas.width = 1200; canvas.height = 800; // 2x for crispness
      canvas.getContext('2d').drawImage(img, 0, 0, 1200, 800);
      URL.revokeObjectURL(url);

      const png = await new Promise(ok => canvas.toBlob(ok, 'image/png'));

      // Clipboard copy is a direct user-click action (owner rule: clipboard
      // writes only on click). Fall back to download if unsupported.
      let copied = false;
      if (navigator.clipboard?.write && window.ClipboardItem) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
          copied = true;
        } catch {}
      }

      const a = document.createElement('a');
      a.href = URL.createObjectURL(png);
      a.download = `obsession-score-${new Date().toISOString().slice(0, 10)}.png`;
      a.click();
      URL.revokeObjectURL(a.href);

      showToast(copied ? '📸 Card downloaded + copied to clipboard' : '📸 Card downloaded');
    } catch (err) {
      showToast(`Share failed: ${err.message}`);
    }
  }

  /* ── Utils ──────────────────────────────────────────────────────────────── */

  function formatWatch(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = String(s);
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
