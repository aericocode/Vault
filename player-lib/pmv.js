/* =========================================================================
   PMV STUDIO — Editor sub-tab (Mix & Match | PMV Studio).

   Pick library videos + a soundtrack; the server pipeline (lib/pmv/) cuts
   the best moments to the beat and renders an mp4. Everything heavy runs
   server-side in a queue — the client only polls, so the rest of the app
   stays fully usable while a job analyzes/renders (several minutes for big
   sources). Output is added to the library manually (Add to library).

   Phases: setup → running → review (EDL strip + output player).
   ========================================================================= */

const PMV_DEFAULT_OPTIONS = {
  orderMode: 'shuffle',
  minClipDuration: 0.3,
  maxClipDuration: 4,
  cutOnBeats: true,
  preferHighAction: true,
  userCriteria: '',
  enableVL: false,
  transitions: true,
  colorEffects: false,
  speedRamping: false,
  layout: 'standard',
  resolution: '1920:1080',
  quality: 'medium',
  seed: null,               // null = server picks random
};

const pmvState = {
  phase: 'setup',           // setup | running | review
  videoIds: [],             // selected source videos (order irrelevant)
  audioIds: [],             // selected soundtrack files (ORDER MATTERS)
  options: { ...PMV_DEFAULT_OPTIONS },
  jobId: null,
  job: null,                // last polled job row
  edlDirty: false,          // EDL edited since last render
  videoQ: '',
  audioQ: '',
  videoOpts: { metadataOnly: false, fuzzy: false, semantic: false },
  audioOpts: { metadataOnly: false, fuzzy: false, semantic: false },
  pollTimer: null,
};

function pmvEl() { return document.getElementById('editorContainer'); }

/* ── Sub-tab strip (shared with editor.js's renderEditorHome) ───────────── */

function editorSubTabsHtml(active) {
  return `
    <div class="editor-subtabs">
      <button class="editor-subtab ${active === 'mix' ? 'active' : ''}" onclick="editorSwitchSubTab('mix')">🎛 Mix &amp; Match</button>
      <button class="editor-subtab ${active === 'pmv' ? 'active' : ''}" onclick="editorSwitchSubTab('pmv')">🎬 PMV Studio</button>
    </div>`;
}

function editorSwitchSubTab(tab) {
  if (typeof editorSubTab !== 'undefined') editorSubTab = tab;
  if (tab === 'pmv') renderPmvHome();
  else if (typeof renderEditorHome === 'function') { pmvStopPolling(); pmvStopAudioPreview(); renderEditorHome(); }
}

/* ── Entry / polling lifecycle ──────────────────────────────────────────── */

function renderPmvHome() {
  const root = pmvEl();
  if (!root) return;
  if (pmvState.phase === 'running' || pmvState.phase === 'review') {
    renderPmvJobView();
  } else {
    renderPmvSetup();
  }
}

/** Called from editorPauseIfActive when the user leaves the Editor tab —
 *  polling is UI-only; the server job keeps going. */
function pmvPauseIfActive() {
  pmvStopPolling();
  pmvStopAudioPreview();
}

function pmvStartPolling() {
  pmvStopPolling();
  pmvState.pollTimer = setInterval(pmvPollJob, 1200);
}

function pmvStopPolling() {
  clearInterval(pmvState.pollTimer);
  pmvState.pollTimer = null;
}

async function pmvPollJob() {
  if (!pmvState.jobId) { pmvStopPolling(); return; }
  let job;
  try {
    job = await fetch(`/api/pmv/jobs/${pmvState.jobId}`).then(r => r.json());
  } catch { return; }
  if (job?.error && !job.id) return;

  const prev = pmvState.job;
  pmvState.job = job;

  // Phase transitions
  if (['edl_ready', 'rendering', 'complete', 'error', 'canceled'].includes(job.status) && pmvState.phase === 'running') {
    pmvState.phase = 'review';
    renderPmvJobView();
    return;
  }

  if (pmvState.phase === 'running') {
    pmvUpdateProgressUi(job);
  } else if (pmvState.phase === 'review') {
    pmvUpdateReviewStatus(job, prev);
  }

  if (['complete', 'error', 'canceled'].includes(job.status)) pmvStopPolling();
}

/* ── SETUP phase ────────────────────────────────────────────────────────── */

function pmvPickableVideos() {
  const base = allMedia.filter(m => m.media_type === 'video' && !m.user_trashed);
  if (typeof pickerApplySearch !== 'function') {
    const q = pmvState.videoQ.trim().toLowerCase();
    return q ? base.filter(m => (m.filename || '').toLowerCase().includes(q)) : base;
  }
  const res = pickerApplySearch(pmvState.videoQ, base, pmvState.videoOpts, renderPmvVideoGrid);
  if (typeof pickerSetModeIndicator === 'function') pickerSetModeIndicator('pmvVid', res.mode, res.pending);
  return res.items;
}

function pmvPickableAudio() {
  const base = allMedia.filter(m => ['audio', 'video'].includes(m.media_type) && !m.user_trashed);
  if (typeof pickerApplySearch !== 'function') {
    const q = pmvState.audioQ.trim().toLowerCase();
    return q ? base.filter(m => (m.filename || '').toLowerCase().includes(q)) : base;
  }
  const res = pickerApplySearch(pmvState.audioQ, base, pmvState.audioOpts, renderPmvAudio);
  if (typeof pickerSetModeIndicator === 'function') pickerSetModeIndicator('pmvAud', res.mode, res.pending);
  return res.items;
}

function renderPmvSetup() {
  const root = pmvEl();
  const o = pmvState.options;
  root.innerHTML = `
    ${editorSubTabsHtml('pmv')}
    <div class="pmv-home">
      <div class="pmv-main">
        <section class="editor-panel">
          <div class="editor-panel-head">
            <h2>🎬 Source videos <span class="pmv-count" id="pmvVideoCount">${pmvState.videoIds.length} selected</span></h2>
            <input type="text" class="music-input pmv-search" id="pmvVideoSearch" placeholder="Search… (AND/OR/NOT, /regex/)" value="${escapeHtml(pmvState.videoQ)}" autocomplete="off">
            ${typeof pickerSearchOptionsHtml === 'function' ? pickerSearchOptionsHtml('pmvVid', pmvState.videoOpts) : ''}
          </div>
          <div class="pmv-selected-videos" id="pmvSelectedVideos"></div>
          <div class="pmv-picker-grid" id="pmvVideoGrid"></div>
        </section>

        <section class="editor-panel">
          <div class="editor-panel-head">
            <h2>🎵 Soundtrack <span class="pmv-count">${pmvState.audioIds.length ? pmvState.audioIds.length + ' track(s)' : 'pick one'}</span></h2>
            <input type="text" class="music-input pmv-search" id="pmvAudioSearch" placeholder="Search… (AND/OR/NOT, /regex/)" value="${escapeHtml(pmvState.audioQ)}" autocomplete="off">
            ${typeof pickerSearchOptionsHtml === 'function' ? pickerSearchOptionsHtml('pmvAud', pmvState.audioOpts) : ''}
          </div>
          <div class="pmv-audio-selected" id="pmvAudioSelected"></div>
          <div class="pmv-picker-grid pmv-audio-grid" id="pmvAudioGrid"></div>
        </section>
      </div>

      <aside class="pmv-side">
        <section class="editor-panel">
          <h3>⚙️ Options</h3>
          <div class="pmv-options">
            <label class="pmv-opt">Order
              <select id="pmvOrderMode">
                <option value="shuffle" ${o.orderMode === 'shuffle' ? 'selected' : ''}>Shuffle (beat-matched)</option>
                <option value="sequential" ${o.orderMode === 'sequential' ? 'selected' : ''}>Sequential (story order)</option>
              </select>
            </label>
            <label class="pmv-opt">Clip length <span class="pmv-opt-val" id="pmvClipLbl">${o.minClipDuration}–${o.maxClipDuration}s</span>
              <div class="pmv-dual-range" id="pmvClipRange">
                <div class="pmv-dual-track"><div class="pmv-dual-fill" id="pmvClipFill"></div></div>
                <input type="range" id="pmvMinClip" min="0.1" max="10" step="0.1" value="${o.minClipDuration}">
                <input type="range" id="pmvMaxClip" min="0.1" max="10" step="0.1" value="${o.maxClipDuration}">
              </div>
            </label>
            <label class="pmv-opt-check"><input type="checkbox" id="pmvCutBeats" ${o.cutOnBeats ? 'checked' : ''}> Cut on beats</label>
            <label class="pmv-opt-check"><input type="checkbox" id="pmvEnergy" ${o.preferHighAction ? 'checked' : ''}> Energy matching</label>
            <label class="pmv-opt-check"><input type="checkbox" id="pmvTransitions" ${o.transitions ? 'checked' : ''}> Transitions</label>
            <label class="pmv-opt-check"><input type="checkbox" id="pmvColorFx" ${o.colorEffects ? 'checked' : ''}> Color effects</label>
            <label class="pmv-opt-check"><input type="checkbox" id="pmvSpeedRamp" ${o.speedRamping ? 'checked' : ''}> Speed ramp on drops</label>
            <label class="pmv-opt">Layout
              <select id="pmvLayout">
                <option value="standard" ${o.layout === 'standard' ? 'selected' : ''}>Standard</option>
                <option value="triptych" ${o.layout === 'triptych' ? 'selected' : ''}>Triptych (3-panel mirror)</option>
              </select>
            </label>
            <label class="pmv-opt">Resolution
              <select id="pmvRes">
                <option value="1280:720" ${o.resolution === '1280:720' ? 'selected' : ''}>720p</option>
                <option value="1920:1080" ${o.resolution === '1920:1080' ? 'selected' : ''}>1080p</option>
                <option value="3840:2160" ${o.resolution === '3840:2160' ? 'selected' : ''}>4K</option>
              </select>
            </label>
            <label class="pmv-opt">Quality
              <select id="pmvQuality">
                <option value="low" ${o.quality === 'low' ? 'selected' : ''}>Low (fast)</option>
                <option value="medium" ${o.quality === 'medium' ? 'selected' : ''}>Medium</option>
                <option value="high" ${o.quality === 'high' ? 'selected' : ''}>High</option>
              </select>
            </label>
            <label class="pmv-opt">AI scene filter <span class="pmv-opt-hint">(optional criteria)</span>
              <input type="text" id="pmvCriteria" class="music-input" placeholder="e.g. close-ups, outdoors…" value="${escapeHtml(o.userCriteria)}">
            </label>
            <label class="pmv-opt-check"><input type="checkbox" id="pmvVL" ${o.enableVL ? 'checked' : ''}> AI frame analysis (slower, needs LM Studio)</label>
            <label class="pmv-opt">Seed <span class="pmv-opt-hint">(blank = random)</span>
              <input type="text" id="pmvSeed" class="music-input" placeholder="random" value="${o.seed ?? ''}">
            </label>
          </div>
          <button class="pmv-generate-btn" id="pmvGenerate" ${pmvState.videoIds.length && pmvState.audioIds.length ? '' : 'disabled'}>▶ Generate PMV</button>
          <div class="pmv-hint">Runs on the server — you can keep browsing the library while it works.</div>
        </section>

        <section class="editor-panel">
          <h3>💾 Recipes</h3>
          <div class="editor-mini-list" id="pmvRecipeList"><span class="music-hint">Loading…</span></div>
        </section>

        <section class="editor-panel">
          <h3>🕘 Recent jobs</h3>
          <div class="editor-mini-list" id="pmvJobList"><span class="music-hint">Loading…</span></div>
        </section>
      </aside>
    </div>`;

  renderPmvSelectedVideos();
  renderPmvVideoGrid();
  renderPmvAudio();
  renderPmvRecipeList();
  renderPmvJobList();
  bindPmvSetup();
}

function renderPmvVideoGrid() {
  const grid = document.getElementById('pmvVideoGrid');
  if (!grid) return;
  const items = pmvPickableVideos().slice(0, 400);
  if (!items.length) { grid.innerHTML = '<div class="games-hint">No videos match.</div>'; return; }
  grid.innerHTML = items.map(m => {
    const sel = pmvState.videoIds.includes(m.id);
    const dur = m.duration_seconds ? formatDuration(m.duration_seconds) : '';
    return `
      <div class="games-pick-tile pmv-pick ${sel ? 'pmv-picked' : ''}" data-id="${m.id}" onclick="pmvToggleVideo(${m.id})" title="${escapeHtml(m.filename)}">
        <div class="tile-thumb">
          <img class="tile-img" loading="lazy" src="/thumb/${m.id}" alt="" onerror="this.parentElement.classList.add('thumb-fallback'); this.remove();">
          ${sel ? '<span class="pmv-pick-check">✓</span>' : ''}
          ${dur ? `<span class="tile-duration">${dur}</span>` : ''}
        </div>
        <div class="tile-name">${escapeHtml(m.filename)}</div>
      </div>`;
  }).join('');
  if (typeof attachHoverScrub === 'function') attachHoverScrub(grid);
}

/** Chosen source videos, pinned at the top of the panel for easy removal. */
function renderPmvSelectedVideos() {
  const box = document.getElementById('pmvSelectedVideos');
  if (!box) return;
  if (!pmvState.videoIds.length) { box.innerHTML = ''; box.classList.remove('has-items'); return; }
  box.classList.add('has-items');
  box.innerHTML = `
    <div class="pmv-selected-head">
      <span>Selected · ${pmvState.videoIds.length}</span>
      <button class="pmv-selected-clear" onclick="pmvClearVideos()">Clear all</button>
    </div>
    <div class="pmv-selected-strip">
      ${pmvState.videoIds.map(id => {
        const m = getMediaById(id);
        const name = m ? m.filename : `#${id}`;
        return `
          <div class="pmv-selected-vid" data-id="${id}" title="${escapeHtml(name)}">
            <img class="pmv-selected-vid-thumb" loading="lazy" src="/thumb/${id}" alt="" onerror="this.style.visibility='hidden'">
            <span class="pmv-selected-vid-name">${escapeHtml(name)}</span>
            <button class="pmv-selected-vid-x" onclick="pmvToggleVideo(${id})" title="Remove">✕</button>
          </div>`;
      }).join('')}
    </div>`;
}

function pmvClearVideos() {
  pmvState.videoIds = [];
  renderPmvSelectedVideos();
  renderPmvVideoGrid();
  const c = document.getElementById('pmvVideoCount');
  if (c) c.textContent = '0 selected';
  pmvSyncGenerateBtn();
}

function pmvToggleVideo(id) {
  const i = pmvState.videoIds.indexOf(id);
  if (i >= 0) pmvState.videoIds.splice(i, 1);
  else pmvState.videoIds.push(id);
  renderPmvSelectedVideos();
  renderPmvVideoGrid();
  const count = document.getElementById('pmvVideoCount');
  if (count) count.textContent = `${pmvState.videoIds.length} selected`;
  pmvSyncGenerateBtn();
}

function renderPmvAudio() {
  // Selected tracks (ordered — this is the concatenation order)
  const sel = document.getElementById('pmvAudioSelected');
  if (sel) {
    sel.innerHTML = pmvState.audioIds.length ? pmvState.audioIds.map((id, i) => {
      const m = getMediaById(id);
      const name = m ? m.filename : `#${id}`;
      return `
        <div class="pmv-audio-row">
          <span class="pmv-audio-order">${i + 1}</span>
          <span class="pmv-audio-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
          <button class="pmv-mini-btn" onclick="pmvMoveAudio(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button class="pmv-mini-btn" onclick="pmvMoveAudio(${i}, 1)" ${i === pmvState.audioIds.length - 1 ? 'disabled' : ''} title="Move down">↓</button>
          <button class="pmv-mini-btn pmv-mini-del" onclick="pmvRemoveAudio(${i})" title="Remove">✕</button>
        </div>`;
    }).join('') : '<div class="pmv-hint">No soundtrack picked — tracks play (and concatenate) in this order.</div>';
  }

  // Compact wide rows (no cover art) with a preview button + scrub bar
  const grid = document.getElementById('pmvAudioGrid');
  if (grid) {
    const items = pmvPickableAudio().slice(0, 200);
    grid.innerHTML = items.length ? items.map(m => {
      const picked = pmvState.audioIds.includes(m.id);
      const dur = m.duration_seconds ? formatDuration(m.duration_seconds) : '';
      const icon = m.media_type === 'audio' ? '🎵' : '🎬';
      return `
        <div class="pmv-audio-pick ${picked ? 'picked' : ''}" data-audio-id="${m.id}">
          <button class="pmv-audio-play" onclick="pmvToggleAudioPreview(${m.id})" title="Preview">▶</button>
          <div class="pmv-audio-pick-main">
            <div class="pmv-audio-pick-name" title="${escapeHtml(m.filename)}">${icon} ${escapeHtml(m.filename)}</div>
            <div class="pmv-audio-scrub" onpointerdown="pmvAudioScrub(event, ${m.id})"><div class="pmv-audio-scrub-fill"></div></div>
          </div>
          ${dur ? `<span class="pmv-audio-pick-dur">${dur}</span>` : ''}
          <button class="pmv-audio-addbtn ${picked ? 'added' : ''}" onclick="pmvAddAudio(${m.id})"
            title="${picked ? 'Remove from soundtrack' : 'Add to soundtrack'}">${picked ? '✓' : '+'}</button>
        </div>`;
    }).join('') : '<div class="games-hint">Nothing matches.</div>';
    // Re-reflect any currently-playing preview after a re-render
    if (_pmvAudio.id != null && _pmvAudio.el) {
      pmvSetPlayBtn(_pmvAudio.id, !_pmvAudio.el.paused);
      const d = _pmvAudio.el.duration;
      if (d) pmvAudioFill(_pmvAudio.id, (_pmvAudio.el.currentTime / d) * 100);
    }
  }
}

/* ── Soundtrack preview (one shared <audio>; scrub before committing) ────── */

let _pmvAudio = { el: null, id: null };

function pmvStopAudioPreview() {
  if (_pmvAudio.el) { try { _pmvAudio.el.pause(); } catch {} _pmvAudio.el.src = ''; }
  document.querySelectorAll('.pmv-audio-play.playing').forEach(b => { b.classList.remove('playing'); b.textContent = '▶'; });
  _pmvAudio = { el: null, id: null };
}

function pmvSetPlayBtn(id, playing) {
  const btn = document.querySelector(`.pmv-audio-pick[data-audio-id="${id}"] .pmv-audio-play`);
  if (btn) { btn.classList.toggle('playing', playing); btn.textContent = playing ? '⏸' : '▶'; }
}

function pmvAudioFill(id, pct) {
  const fill = document.querySelector(`.pmv-audio-pick[data-audio-id="${id}"] .pmv-audio-scrub-fill`);
  if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/** Start (or resume/pause) preview of a soundtrack candidate. */
function pmvToggleAudioPreview(id) {
  if (_pmvAudio.id === id && _pmvAudio.el) {
    if (_pmvAudio.el.paused) { _pmvAudio.el.play().catch(() => {}); pmvSetPlayBtn(id, true); }
    else { _pmvAudio.el.pause(); pmvSetPlayBtn(id, false); }
    return _pmvAudio.el;
  }
  pmvStopAudioPreview();
  const el = new Audio(`/media/${id}`);
  el.preload = 'metadata';
  _pmvAudio = { el, id };
  el.addEventListener('timeupdate', () => {
    if (_pmvAudio.id !== id || !el.duration) return;
    pmvAudioFill(id, (el.currentTime / el.duration) * 100);
  });
  el.addEventListener('ended', () => { pmvSetPlayBtn(id, false); pmvAudioFill(id, 0); });
  el.play().then(() => pmvSetPlayBtn(id, true)).catch(() => {});
  return el;
}

/** Click/drag the scrub bar to seek within the preview (starts it if idle). */
function pmvAudioScrub(e, id) {
  e.preventDefault();
  e.stopPropagation();
  const bar = e.currentTarget;
  const el = (_pmvAudio.id === id && _pmvAudio.el) ? _pmvAudio.el : pmvToggleAudioPreview(id);

  const seek = (clientX) => {
    const r = bar.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    pmvAudioFill(id, frac * 100);
    const apply = () => { if (el.duration) el.currentTime = frac * el.duration; };
    if (el.readyState >= 1 && el.duration) apply();
    else el.addEventListener('loadedmetadata', apply, { once: true });
  };

  seek(e.clientX);
  try { bar.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => seek(ev.clientX);
  const up = () => {
    bar.removeEventListener('pointermove', move);
    bar.removeEventListener('pointerup', up);
    bar.removeEventListener('pointercancel', up);
  };
  bar.addEventListener('pointermove', move);
  bar.addEventListener('pointerup', up);
  bar.addEventListener('pointercancel', up);
}

function pmvAddAudio(id) {
  const i = pmvState.audioIds.indexOf(id);
  if (i >= 0) pmvState.audioIds.splice(i, 1);
  else pmvState.audioIds.push(id);
  renderPmvAudio();
  pmvSyncGenerateBtn();
}

function pmvRemoveAudio(i) {
  pmvState.audioIds.splice(i, 1);
  renderPmvAudio();
  pmvSyncGenerateBtn();
}

function pmvMoveAudio(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= pmvState.audioIds.length) return;
  [pmvState.audioIds[i], pmvState.audioIds[j]] = [pmvState.audioIds[j], pmvState.audioIds[i]];
  renderPmvAudio();
}

function pmvSyncGenerateBtn() {
  const btn = document.getElementById('pmvGenerate');
  if (btn) btn.disabled = !(pmvState.videoIds.length && pmvState.audioIds.length);
}

function pmvReadOptions() {
  const q = (id) => document.getElementById(id);
  const o = pmvState.options;
  o.orderMode = q('pmvOrderMode')?.value === 'sequential' ? 'sequential' : 'shuffle';
  o.minClipDuration = parseFloat(q('pmvMinClip')?.value) || 0.3;
  o.maxClipDuration = parseFloat(q('pmvMaxClip')?.value) || 4;
  o.cutOnBeats = !!q('pmvCutBeats')?.checked;
  o.preferHighAction = !!q('pmvEnergy')?.checked;
  o.transitions = !!q('pmvTransitions')?.checked;
  o.colorEffects = !!q('pmvColorFx')?.checked;
  o.speedRamping = !!q('pmvSpeedRamp')?.checked;
  o.layout = q('pmvLayout')?.value === 'triptych' ? 'triptych' : 'standard';
  o.resolution = q('pmvRes')?.value || '1920:1080';
  o.quality = q('pmvQuality')?.value || 'medium';
  o.userCriteria = (q('pmvCriteria')?.value || '').trim();
  o.enableVL = !!q('pmvVL')?.checked;
  const seedRaw = (q('pmvSeed')?.value || '').trim();
  o.seed = seedRaw === '' ? null : (Number.isFinite(Number(seedRaw)) ? Number(seedRaw) : seedRaw);
  return o;
}

function bindPmvSetup() {
  const vSearch = document.getElementById('pmvVideoSearch');
  let vt = null;
  vSearch?.addEventListener('input', () => {
    clearTimeout(vt);
    vt = setTimeout(() => { pmvState.videoQ = vSearch.value; renderPmvVideoGrid(); }, 200);
  });
  const aSearch = document.getElementById('pmvAudioSearch');
  let at = null;
  aSearch?.addEventListener('input', () => {
    clearTimeout(at);
    at = setTimeout(() => { pmvState.audioQ = aSearch.value; renderPmvAudio(); }, 200);
  });

  // Search-option toggles (Metadata / Fuzzy / Semantic) for each picker
  if (typeof bindPickerSearchOptions === 'function') {
    bindPickerSearchOptions('pmvVid', pmvState.videoOpts, renderPmvVideoGrid);
    bindPickerSearchOptions('pmvAud', pmvState.audioOpts, renderPmvAudio);
  }

  bindPmvClipRange();
  document.getElementById('pmvGenerate')?.addEventListener('click', pmvGenerate);
}

/** Dual-thumb clip-length slider (two overlaid ranges → one min–max track). */
function bindPmvClipRange() {
  const RMIN = 0.1, RMAX = 10, GAP = 0.1;
  const minEl = document.getElementById('pmvMinClip');
  const maxEl = document.getElementById('pmvMaxClip');
  const fill = document.getElementById('pmvClipFill');
  const lbl = document.getElementById('pmvClipLbl');
  if (!minEl || !maxEl) return;

  const paint = () => {
    const mn = parseFloat(minEl.value), mx = parseFloat(maxEl.value);
    const l = ((mn - RMIN) / (RMAX - RMIN)) * 100;
    const r = ((mx - RMIN) / (RMAX - RMIN)) * 100;
    if (fill) { fill.style.left = l + '%'; fill.style.width = (r - l) + '%'; }
    if (lbl) lbl.textContent = `${mn.toFixed(1).replace(/\.0$/, '')}–${mx.toFixed(1).replace(/\.0$/, '')}s`;
    // Keep whichever thumb the pointer is nearer on top so both stay grabbable
    minEl.style.zIndex = mn > RMAX - 1 ? 5 : 4;
  };
  minEl.addEventListener('input', () => {
    if (parseFloat(minEl.value) > parseFloat(maxEl.value) - GAP) {
      minEl.value = (parseFloat(maxEl.value) - GAP).toFixed(1);
    }
    paint();
  });
  maxEl.addEventListener('input', () => {
    if (parseFloat(maxEl.value) < parseFloat(minEl.value) + GAP) {
      maxEl.value = (parseFloat(minEl.value) + GAP).toFixed(1);
    }
    paint();
  });
  paint();
}

async function pmvGenerate() {
  pmvStopAudioPreview();
  const options = { ...pmvReadOptions() };
  if (options.seed == null) delete options.seed;   // server picks one
  try {
    const resp = await fetch('/api/pmv/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: pmvState.videoIds, audio_ids: pmvState.audioIds, options }),
    });
    const data = await resp.json();
    if (!resp.ok) { showToast('⚠ ' + (data.error || 'Failed to start')); return; }
    pmvState.jobId = data.jobId;
    pmvState.job = null;
    pmvState.edlDirty = false;
    pmvState.phase = 'running';
    renderPmvJobView();
  } catch (err) {
    showToast('⚠ ' + err.message);
  }
}

/* ── Recipes + recent jobs (setup side panels) ──────────────────────────── */

async function renderPmvRecipeList() {
  const el = document.getElementById('pmvRecipeList');
  if (!el) return;
  let recipes = [];
  try { recipes = await fetch('/api/pmv/recipes').then(r => r.json()); } catch {}
  el.innerHTML = recipes.length ? recipes.map(r => `
    <div class="editor-mini-row">
      <span class="editor-mini-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
      <button class="pmv-mini-btn" onclick="pmvLoadRecipe(${r.id})" title="Load this recipe">↻</button>
      <button class="pmv-mini-btn pmv-mini-del" onclick="pmvDeleteRecipe(${r.id})" title="Delete">✕</button>
    </div>`).join('') : '<span class="music-hint">None saved yet.</span>';
  el._recipes = recipes;
}

async function pmvLoadRecipe(id) {
  const el = document.getElementById('pmvRecipeList');
  const recipe = (el?._recipes || []).find(r => r.id === id);
  if (!recipe) return;
  pmvState.videoIds = (recipe.media_ids || []).filter(mid => getMediaById(mid));
  pmvState.audioIds = (recipe.config?.audio_ids || []).filter(mid => getMediaById(mid));
  pmvState.options = { ...PMV_DEFAULT_OPTIONS, ...(recipe.config?.options || {}) };
  renderPmvSetup();
  showToast(`↻ Loaded recipe: ${recipe.name}`);
}

async function pmvDeleteRecipe(id) {
  try { await fetch(`/api/pmv/recipes/${id}`, { method: 'DELETE' }); } catch {}
  renderPmvRecipeList();
}

async function pmvSaveRecipe() {
  const job = pmvState.job;
  const name = prompt('Recipe name:', job ? `PMV ${new Date().toLocaleDateString()}` : '');
  if (!name || !name.trim()) return;
  const body = {
    name: name.trim(),
    media_ids: job ? job.video_ids : pmvState.videoIds,
    config: {
      audio_ids: job ? job.audio_ids : pmvState.audioIds,
      options: { ...(job ? job.options : pmvReadOptions()), seed: job?.edl?.seed ?? pmvState.options.seed },
    },
  };
  try {
    const resp = await fetch('/api/pmv/recipes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) { showToast('⚠ ' + (data.error || 'Save failed')); return; }
    showToast('💾 Recipe saved');
  } catch (err) { showToast('⚠ ' + err.message); }
}

async function renderPmvJobList() {
  const el = document.getElementById('pmvJobList');
  if (!el) return;
  let jobs = [];
  try { jobs = await fetch('/api/pmv/jobs').then(r => r.json()); } catch {}
  const ICON = { complete: '✅', error: '⚠', canceled: '✕', rendering: '⏳', analyzing: '⏳', edl_ready: '🎞', queued: '·' };
  el.innerHTML = jobs.length ? jobs.slice(0, 8).map(j => {
    const when = (j.created_at || '').slice(5, 16).replace('T', ' ');
    const openable = ['complete', 'edl_ready', 'rendering', 'analyzing', 'queued'].includes(j.status);
    return `
      <div class="editor-mini-row">
        <span class="editor-mini-name" title="${j.id}">${ICON[j.status] || '·'} ${when} · ${j.video_ids.length}v</span>
        ${openable ? `<button class="pmv-mini-btn" onclick="pmvOpenJob('${j.id}')" title="Open">▶</button>` : ''}
        <button class="pmv-mini-btn pmv-mini-del" onclick="pmvDeleteJob('${j.id}')" title="Delete job + files">✕</button>
      </div>`;
  }).join('') : '<span class="music-hint">No jobs yet.</span>';
}

function pmvOpenJob(jobId) {
  pmvState.jobId = jobId;
  pmvState.job = null;
  pmvState.edlDirty = false;
  pmvState.phase = 'running';   // poll transition sorts out the real phase
  renderPmvJobView();
}

async function pmvDeleteJob(jobId) {
  if (!confirm('Delete this job? Un-imported renders only exist in memory and are dropped; files already added to the library are kept.')) return;
  try { await fetch(`/api/pmv/jobs/${jobId}`, { method: 'DELETE' }); } catch {}
  if (pmvState.jobId === jobId) { pmvState.jobId = null; pmvState.job = null; pmvState.phase = 'setup'; renderPmvHome(); }
  else renderPmvJobList();
}

/* ── RUNNING / REVIEW phases ────────────────────────────────────────────── */

function renderPmvJobView() {
  pmvStopAudioPreview();
  const root = pmvEl();
  const job = pmvState.job;
  root.innerHTML = `
    ${editorSubTabsHtml('pmv')}
    <div class="pmv-job">
      <div class="pmv-job-head">
        <button class="games-btn" onclick="pmvBackToSetup()">⬅ Setup</button>
        <span class="pmv-job-title">🎬 PMV ${pmvState.jobId ? `<span class="pmv-job-id">${pmvState.jobId.slice(-7)}</span>` : ''}</span>
        <span class="pmv-job-status" id="pmvJobStatus"></span>
        <span class="pmv-flex"></span>
        <button class="games-btn" id="pmvCancelBtn" onclick="pmvCancelJob()" style="display:none">✕ Cancel</button>
      </div>
      <div class="pmv-progress-wrap" id="pmvProgressWrap">
        <div class="pmv-progress-bar"><div class="pmv-progress-fill" id="pmvProgressFill"></div></div>
        <div class="pmv-progress-stage" id="pmvProgressStage">Starting…</div>
        <div class="pmv-hint">Runs server-side — feel free to browse the library; come back any time.</div>
      </div>
      <div id="pmvReviewBody"></div>
    </div>`;

  if (job) {
    if (pmvState.phase === 'review') renderPmvReview(job);
    else pmvUpdateProgressUi(job);
  }
  pmvStartPolling();
  pmvPollJob();
}

function pmvBackToSetup() {
  pmvStopPolling();
  pmvState.phase = 'setup';
  renderPmvSetup();
}

async function pmvCancelJob() {
  if (!pmvState.jobId) return;
  try { await fetch(`/api/pmv/jobs/${pmvState.jobId}/cancel`, { method: 'POST' }); } catch {}
  showToast('✕ Canceling…');
}

function pmvUpdateProgressUi(job) {
  const fill = document.getElementById('pmvProgressFill');
  const stage = document.getElementById('pmvProgressStage');
  const status = document.getElementById('pmvJobStatus');
  const cancel = document.getElementById('pmvCancelBtn');
  if (fill) fill.style.width = `${job.progress || 0}%`;
  if (stage) stage.textContent = `${job.stage || job.status} (${Math.round(job.progress || 0)}%)`;
  if (status) status.textContent = job.status;
  if (cancel) cancel.style.display = ['queued', 'analyzing', 'rendering'].includes(job.status) ? '' : 'none';
}

/** Light-touch updates while reviewing (render progress, completion). */
function pmvUpdateReviewStatus(job, prev) {
  pmvUpdateProgressUi(job);
  // First arrival of the EDL, or render completing → full redraw
  const edlArrived = job.edl && !prev?.edl;
  const finished = job.status === 'complete' && prev?.status !== 'complete';
  const failed = ['error', 'canceled'].includes(job.status) && prev?.status !== job.status;
  if (edlArrived || finished || failed) renderPmvReview(job);
}

/* ── Review body: EDL strip + output ────────────────────────────────────── */

function renderPmvReview(job) {
  const body = document.getElementById('pmvReviewBody');
  if (!body) return;
  pmvUpdateProgressUi(job);

  if (!job.edl) {
    body.innerHTML = job.error ? `<div class="pmv-error">⚠ ${escapeHtml(job.error)}</div>` : '';
    return;
  }

  const e = job.edl;
  const vidName = (idx) => {
    const info = (e.videoInfos || []).find(v => v.index === idx);
    const m = info && getMediaById(info.media_id);
    return m ? m.filename : `V${idx + 1}`;
  };

  const entriesHtml = (e.entries || []).map((entry, i) => `
    <div class="pmv-cut" data-i="${i}" title="${escapeHtml(vidName(entry.sourceVideo))} @ ${entry.sourceIn.toFixed(1)}s · ${entry.duration.toFixed(2)}s${entry.onBeat ? ' · on beat' : ''}">
      ${entry.preview ? `<img class="pmv-cut-img" src="${entry.preview}">` : '<div class="pmv-cut-img pmv-cut-noimg">🎞</div>'}
      <span class="pmv-cut-vid">V${(entry.sourceVideo ?? 0) + 1}</span>
      <span class="pmv-cut-dur">${entry.duration.toFixed(1)}s${entry.onBeat ? ' ●' : ''}</span>
      <button class="pmv-cut-del" onclick="pmvRemoveCut(${i})" title="Remove this cut">✕</button>
    </div>`).join('');

  const done = job.status === 'complete';
  const failed = ['error', 'canceled'].includes(job.status);
  // Fresh renders live in memory only — a restart or vault lock drops them
  // (the EDL survives, so Re-render regenerates the same cut).
  const expired = done && job.available === false;
  const imported = !!job.result?.imported_media_id;

  body.innerHTML = `
    <div class="pmv-review-stats">
      <span>♪ ${e.bpm} BPM</span><span>${(e.entries || []).length} cuts</span>
      <span>${Math.round((e.coverage || 0) * 100)}% coverage</span>
      <span>${e.uniqueSegments}/${e.totalSegments} segments</span>
      <span>🎲 seed ${e.seed}</span>
      ${pmvState.edlDirty ? '<span class="pmv-dirty">edited — re-render to apply</span>' : ''}
    </div>
    <div class="pmv-edl-strip" id="pmvEdlStrip">${entriesHtml}</div>
    <div class="pmv-review-actions">
      <button class="games-btn" onclick="pmvReroll()" title="Same sources + options, new seed">🎲 Re-roll</button>
      <button class="games-btn ${pmvState.edlDirty || failed || expired ? 'games-btn-primary' : ''}" onclick="pmvRerender()" ${['analyzing', 'queued'].includes(job.status) ? 'disabled' : ''}>🎬 Re-render</button>
      <button class="games-btn" onclick="pmvSaveRecipe()">💾 Save recipe</button>
      <span class="pmv-flex"></span>
      ${done && !expired ? `
        <a class="games-btn" href="/api/pmv/jobs/${job.id}/download" download title="Held in memory — download to save it anywhere">⬇ Download</a>
        <button class="games-btn games-btn-primary" onclick="pmvImport()" ${imported ? 'disabled title="Already in the library"' : ''}>
          ${imported ? '✓ In library' : '➕ Add to library'}
        </button>` : ''}
    </div>
    ${done && !expired ? `
      <div class="pmv-output">
        <video class="pmv-output-video" src="/api/pmv/jobs/${job.id}/output" controls preload="metadata"></video>
        <div class="pmv-output-meta">
          ${escapeHtml(job.result.filename)} · ${(job.result.fileSize / 1e6).toFixed(1)} MB · ${job.result.clips} clips · ${escapeHtml(job.result.encoder)}${imported ? '' : ' · in memory until you ⬇ save or ➕ add it'}
        </div>
      </div>` : ''}
    ${expired ? `<div class="pmv-error">⏳ Render expired — finished PMVs are held in memory only, and a restart or vault lock drops them. Hit 🎬 Re-render to regenerate, then ⬇ Download or ➕ Add to library.</div>` : ''}
    ${failed ? `<div class="pmv-error">⚠ ${escapeHtml(job.error || job.status)}</div>` : ''}
  `;
}

async function pmvRemoveCut(i) {
  const job = pmvState.job;
  if (!job?.edl?.entries) return;
  job.edl.entries.splice(i, 1);
  pmvState.edlDirty = true;
  try {
    await fetch(`/api/pmv/jobs/${job.id}/edl`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: job.edl.entries }),
    });
  } catch {}
  renderPmvReview(job);
}

async function pmvRerender() {
  const job = pmvState.job;
  if (!job) return;
  try {
    const resp = await fetch(`/api/pmv/jobs/${job.id}/render`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) { showToast('⚠ ' + (data.error || 'render failed to start')); return; }
    pmvState.edlDirty = false;
    showToast('🎬 Re-render queued');
    pmvStartPolling();
  } catch (err) { showToast('⚠ ' + err.message); }
}

/** Same sources + options, fresh seed — a new job (analysis comes from cache). */
async function pmvReroll() {
  const job = pmvState.job;
  if (!job) return;
  const options = { ...(job.options || {}) };
  options.seed = Math.floor(Math.random() * 1e9);
  try {
    const resp = await fetch('/api/pmv/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_ids: job.video_ids, audio_ids: job.audio_ids, options }),
    });
    const data = await resp.json();
    if (!resp.ok) { showToast('⚠ ' + (data.error || 'failed')); return; }
    pmvState.jobId = data.jobId;
    pmvState.job = null;
    pmvState.edlDirty = false;
    pmvState.phase = 'running';
    renderPmvJobView();
  } catch (err) { showToast('⚠ ' + err.message); }
}

async function pmvImport() {
  const job = pmvState.job;
  if (!job) return;
  try {
    const resp = await fetch(`/api/pmv/jobs/${job.id}/import`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) { showToast('⚠ ' + (data.error || 'import failed')); return; }
    showToast('➕ Added to library (unscanned — rescan for AI metadata)');
    if (typeof loadDatabase === 'function') loadDatabase();
    pmvPollJob();
  } catch (err) { showToast('⚠ ' + err.message); }
}
