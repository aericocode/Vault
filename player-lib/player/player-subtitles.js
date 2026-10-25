/* =========================================================================
   PLAYER SUBTITLES — 3-state CC toggle + cue overlay (SUBTITLES_SPEC §3/§6).

   Modes (persisted in localStorage `subtitle_mode`, cycled by the CC button
   in the video extras row — main player only, so games/editor never see it):
     off  → nothing
     on   → always show: English track if present, else the original language
     auto → show English ONLY when the video's language isn't English

   Tracks come from /api/media/:id/subtitles (VTT, parsed client-side into a
   custom overlay — full styling control, voice-tag colors, anti-overlap
   stacking). When the current video has no tracks and the mode wants them, a
   small ＋ chip offers on-request generation (server queue, polled).
   ========================================================================= */

const SUBTITLE_MODES = ['off', 'on', 'auto'];
// Classic per-speaker subtitle colours: 1st white, 2nd yellow, then the usual
// karaoke set. Only used when cues carry <v> speaker tags (needs diarization).
const SUB_VOICE_COLORS = ['#ffffff', '#fce21a', '#22d3ee', '#4ade80', '#f472b6', '#fb923c'];

let subtitleMode = (() => {
  try {
    const v = localStorage.getItem('subtitle_mode');
    return SUBTITLE_MODES.includes(v) ? v : 'off';
  } catch { return 'off'; }
})();

// User-dragged position (fraction of the content box) — null = auto (video
// bottom). A malformed stored value (e.g. NaN→null from a drag against a
// zero-size rect) falls back to auto instead of pinning cues off-screen.
let _subsPos = (() => {
  try {
    const p = JSON.parse(localStorage.getItem('subtitle_pos') || 'null');
    return (p && Number.isFinite(p.fx) && Number.isFinite(p.fy)) ? p : null;
  } catch { return null; }
})();
function _subsSavePos() {
  try {
    if (_subsPos) localStorage.setItem('subtitle_pos', JSON.stringify(_subsPos));
    else localStorage.removeItem('subtitle_pos');
  } catch {}
}

// Active attachment (one video at a time, like the beatbar)
let _subs = { mediaId: null, lang: null, cues: null, el: null, handler: null, genPoll: null, growPoll: null, sidebarPoll: null, trickle: null, notice: null };

/* ── Button (rendered into the video extras row) ────────────────────────── */

/* Modern (the dock, player-modern.js): the CC line icon, lit while on. The
   make / fix chips stay in the markup but hidden; the gear menu's Subtitles
   page offers them (it reads whether this file shows them). */
const SUB_MODERN_TITLES = {
  off: 'Subtitles: off. Click for on',
  on: 'Subtitles: on. Click for auto (English, only for other languages)',
  auto: 'Subtitles: auto. Click to turn them off',
};

function renderSubtitleButton() {
  if (typeof mpBuildingDock === 'function' && mpBuildingDock()) {
    return `<span class="subtitle-ctl mp-subctl" id="subtitleCtl">
      <button type="button" onclick="cycleSubtitleMode()" id="subtitleBtn" class="mp-ic mp-cc${subtitleMode !== 'off' ? ' on' : ''}"
        data-mode="${subtitleMode}" title="${SUB_MODERN_TITLES[subtitleMode]}" aria-label="Subtitles">${mpIcon('cc')}</button>
      <button type="button" onclick="subtitlesGenerate()" id="subtitleGenBtn" class="subtitle-gen-btn" style="display:none" tabindex="-1">＋</button>
      <button type="button" onclick="subtitlesFixHere()" id="subtitleFixBtn" class="subtitle-gen-btn" style="display:none" tabindex="-1">⟳ Fix</button>
    </span>`;
  }
  return `<span class="subtitle-ctl" id="subtitleCtl">
    <button onclick="cycleSubtitleMode()" id="subtitleBtn" class="subtitle-btn sub-mode-${subtitleMode}"
      title="Subtitles: Off → On → Auto (English only for foreign audio)">CC${subtitleMode === 'auto' ? '<sup>AUTO</sup>' : ''}</button>
    <button onclick="subtitlesGenerate()" id="subtitleGenBtn" class="subtitle-gen-btn" style="display:none"
      title="No subtitles yet. Generate them now (Whisper, runs in the background)">＋</button>
    <button onclick="subtitlesFixHere()" id="subtitleFixBtn" class="subtitle-gen-btn" style="display:none"
      title="Re-scan the subtitles around the current spot (±1 min), for gaps or wrong lines">⟳ Fix</button>
  </span>`;
}

function _syncSubtitleBtn() {
  const btn = document.getElementById('subtitleBtn');
  if (!btn) return;
  if (btn.classList.contains('mp-ic')) {
    btn.classList.toggle('on', subtitleMode !== 'off');
    btn.dataset.mode = subtitleMode;
    btn.title = SUB_MODERN_TITLES[subtitleMode];
    return;
  }
  btn.className = `subtitle-btn sub-mode-${subtitleMode}`;
  btn.innerHTML = `CC${subtitleMode === 'auto' ? '<sup>AUTO</sup>' : ''}`;
}

function cycleSubtitleMode() {
  setSubtitleMode(SUBTITLE_MODES[(SUBTITLE_MODES.indexOf(subtitleMode) + 1) % SUBTITLE_MODES.length]);
}

/** Pick a mode outright (the Modern gear menu); the CC button cycles through them. */
function setSubtitleMode(mode) {
  if (!SUBTITLE_MODES.includes(mode)) return;
  subtitleMode = mode;
  try { localStorage.setItem('subtitle_mode', subtitleMode); } catch {}
  _syncSubtitleBtn();
  const media = currentMediaState.currentMediaData;
  // userInitiated → auto-generate when this video has no subs yet (turning CC
  // on is the "make subtitles" gesture; no separate + click needed)
  if (media) applySubtitlesFor(media, { userInitiated: true });
  // The Modern dock's CC button shows the mode; Classic keeps its toast
  if (!(typeof mpQuietToast === 'function' && mpQuietToast())) showToast(`CC: ${subtitleMode === 'off' ? 'Off' : subtitleMode === 'on' ? 'On' : 'Auto (non-English only)'}`);
}

/* ── Track resolution + attachment ──────────────────────────────────────── */

/** (Re)apply subtitles for the playing video. Called on video render, on mode
 *  cycle (userInitiated), and after on-request generation completes.
 *  userInitiated=true auto-generates when the video has no subs yet. */
async function applySubtitlesFor(media, { userInitiated = false } = {}) {
  subtitlesDetach();
  if (!media) return;
  if (currentMediaState.type !== 'video') return;

  if (subtitleMode === 'off') return;

  let info;
  try {
    info = await fetch(`/api/media/${media.id}/subtitles/info`).then(r => r.json());
  } catch { return; }
  // Stale response guard — user may have advanced to the next video
  if (currentMediaState.currentMediaData?.id !== media.id) return;

  const genBtn = document.getElementById('subtitleGenBtn');
  const jobRunning = ['queued', 'transcribing', 'translating'].includes(info.status);

  if (!info.tracks?.length) {
    if (jobRunning) {
      // Generating but no cues on disk yet — show progress, poll for the track
      if (genBtn) { genBtn.style.display = ''; genBtn.textContent = '⏳'; }
      _subsShowProgress(info);
      _subsStartGrowthPoll(media);
    } else if (userInitiated || _subsLooksNonEnglish(media)) {
      // CC already on (mode 'on' OR 'auto' — 'off' returned above) and a
      // sub-less NON-English video arrives → start generating right away,
      // same as the explicit "turn CC on" gesture. English/unknown clips
      // just get the ＋ chip (wrong metadata? the user triggers it there or
      // by re-toggling CC).
      subtitlesGenerate();
    } else if (genBtn) {
      genBtn.style.display = '';       // passive open — offer the chip
      genBtn.textContent = '＋';
    }
    return;
  }
  if (genBtn) genBtn.style.display = 'none';

  const pick = _subsResolvePick(info);
  if (!pick) {
    // e.g. mode wants English but the translated track hasn't appeared yet
    if (jobRunning) { _subsShowProgress(info); _subsStartGrowthPoll(media); }
    else _subsHideProgress();
    return;
  }

  await _subsLoadTrack(media, pick.lang);
  if (jobRunning) { _subsShowProgress(info); _subsStartGrowthPoll(media); }
  else _subsHideProgress();
}

/** Which track the current mode wants, given what exists. */
function _subsResolvePick(info) {
  const en = info.tracks.find(t => t.lang === 'en');
  const original = info.tracks.find(t => t.kind === 'original');
  if (subtitleMode === 'on') return en || original || null;
  if (subtitleMode === 'auto') return info.source_lang !== 'en' ? (en || null) : null;
  return null;
}

/** Best pre-transcription guess at "is this a foreign-language clip?" — the
 *  only language signal we have before Whisper runs. Decides whether CC on/auto
 *  auto-generates on arrival. Errs toward NO for English/unknown/silent (don't
 *  spend a Whisper pass unasked); any other detected language counts. */
function _subsLooksNonEnglish(media) {
  // Prefer the server-canonicalized code (lib/lang.js, attached on every read):
  // a real code that isn't English is a confident YES; 'en'/'none' a clear NO.
  const code = media?.language_code;
  if (code === 'en' || code === 'none') return false;
  if (code) return true;
  // Unmappable raw value — fall back to the string heuristic
  const l = String(media?.language || '').trim().toLowerCase();
  if (!l) return false;
  if (['none', 'n/a', 'na', 'unknown', 'code', 'not applicable', 'silent', 'no audio'].includes(l)) return false;
  return !l.includes('english') && !/^en\b/.test(l);
}

/** Fetch + (re)mount a track's cues. Reuses the overlay if already attached. */
async function _subsLoadTrack(media, lang) {
  let vtt;
  try {
    vtt = await fetch(`/api/media/${media.id}/subtitles?lang=${encodeURIComponent(lang)}`).then(r => r.ok ? r.text() : null);
  } catch { return; }
  if (!vtt || currentMediaState.currentMediaData?.id !== media.id) return;
  const cues = subtitlesParseVTT(vtt);

  const video = currentMediaState.element;
  const content = document.getElementById('mediaPlayerContent');
  if (!video || !content || video.tagName !== 'VIDEO') return;

  if (_subs.el && _subs.mediaId === media.id && _subs.lang === lang) {
    _subs.cues = cues;                // same track, just grew — swap the array
    _subsTick(video, cues, _subs.el);
    return;
  }
  // New attachment (first load, or track changed)
  _subsDetachOverlayOnly();
  const el = document.createElement('div');
  el.id = 'subtitleOverlay';
  el.className = 'subtitle-overlay';
  content.appendChild(el);
  const handler = () => _subsTick(video, _subs.cues, el);   // reads the latest array
  video.addEventListener('timeupdate', handler);

  // Keep the overlay pinned to the video image bottom (letterbox-aware) and
  // reflowed on resize / fullscreen / controls show-hide.
  const reposition = () => _subsReposition();
  window.addEventListener('resize', reposition);
  document.addEventListener('fullscreenchange', reposition);
  const ov = document.getElementById('mediaPlayerOverlay');
  const classObserver = new MutationObserver(reposition);
  if (ov) classObserver.observe(ov, { attributes: true, attributeFilter: ['class'] });

  _subs = { ..._subs, mediaId: media.id, lang, cues, el, handler, video, reposition, classObserver };
  _subsBindDrag(el);
  _subsTick(video, cues, el);
  _subsReposition();
  requestAnimationFrame(_subsReposition);   // once layout has settled
  const fix = document.getElementById('subtitleFixBtn');
  if (fix) fix.style.display = '';           // subtitles present → allow "Fix here"
}

/* ── Positioning (video-image bottom, letterbox-aware) + drag ───────────── */

function _subsReposition() {
  const el = _subs.el, video = _subs.video;
  const content = document.getElementById('mediaPlayerContent');
  if (!el || !content) return;

  if (_subsPos) {
    // User-dragged: place the overlay centre at the stored fraction
    el.style.left = (_subsPos.fx * 100) + '%';
    el.style.top = (_subsPos.fy * 100) + '%';
    el.style.bottom = 'auto';
    el.style.transform = 'translate(-50%, -50%)';
    el.style.maxWidth = 'min(82%, 900px)';
    return;
  }

  // Auto: sit at the bottom of the actual rendered video image. The <video> is
  // sized to the image and flex-centred, so its bounding box IS the image box.
  const cRect = content.getBoundingClientRect();
  const vRect = (video && video.getBoundingClientRect) ? video.getBoundingClientRect() : cRect;
  const controls = document.getElementById('mediaPlayerOverlay')?.classList.contains('controls-visible');
  // Offset from the content bottom = the bottom letterbox bar + a small margin,
  // but never inside the control-bar zone when the bar is up (so fill-height
  // videos still clear it). max(), not sum — summing double-counts the bar.
  const atVideoBottom = (cRect.bottom - vRect.bottom) + 16;
  const gap = Math.max(atVideoBottom, controls ? 96 : 8);
  el.style.left = (vRect.left - cRect.left + vRect.width / 2) + 'px';
  el.style.top = 'auto';
  el.style.transform = 'translateX(-50%)';
  el.style.bottom = gap + 'px';
  el.style.maxWidth = Math.min(vRect.width * 0.92, 900) + 'px';
}

/** Drag a subtitle line to reposition; double-click to snap back to auto. */
function _subsBindDrag(el) {
  el.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.subtitle-line')) return;
    e.preventDefault();
    e.stopPropagation();                 // don't let the down reach the video-click handler
    const content = document.getElementById('mediaPlayerContent');
    if (!content) return;
    const cRect = content.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    let moved = false;
    el.classList.add('dragging');

    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;  // ignore jitter
      if (!(cRect.width > 0 && cRect.height > 0)) return;   // no NaN positions, ever
      moved = true;
      _subsPos = {
        fx: Math.max(0.03, Math.min(0.97, (ev.clientX - cRect.left) / cRect.width)),
        fy: Math.max(0.06, Math.min(0.97, (ev.clientY - cRect.top) / cRect.height)),
      };
      _subsReposition();
    };
    const up = () => {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        _subsSavePos();
        // A real drag ends over the video/gutter — swallow the synthesized
        // click so it doesn't reach handleContentClick and minimize the player.
        const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        document.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', eat, { capture: true }), 350);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  el.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.subtitle-line')) return;
    e.stopPropagation();
    _subsPos = null;
    _subsSavePos();
    _subsReposition();
    if (!(typeof mpQuietToast === 'function' && mpQuietToast())) showToast('Subtitles reset to bottom');   // the line moving says it
  });
}

/** Poll while a job runs: grow the shown track + update the progress pill. */
function _subsStartGrowthPoll(media) {
  clearTimeout(_subs.growPoll);
  _subs.notice = null;
  const tick = async () => {
    if (currentMediaState.currentMediaData?.id !== media.id) return;
    let info;
    try { info = await fetch(`/api/media/${media.id}/subtitles/info`).then(r => r.json()); } catch { _subs.growPoll = setTimeout(tick, 2000); return; }
    if (currentMediaState.currentMediaData?.id !== media.id) return;

    // One-shot job advisory (e.g. "no model to download — AI fallback") → toast
    if (info.notice && info.notice !== _subs.notice) {
      _subs.notice = info.notice;
      showToast('⚠ ' + info.notice, { type: 'error' });
    }

    const running = ['queued', 'transcribing', 'translating'].includes(info.status);
    const pick = _subsResolvePick(info);
    if (pick) await _subsLoadTrack(media, pick.lang);

    if (running) {
      _subsShowProgress(info);
      _subs.growPoll = setTimeout(tick, 1500);
    } else {
      _subsHideProgress();
      const genBtn = document.getElementById('subtitleGenBtn');
      if (genBtn) genBtn.style.display = 'none';
      if (info.status === 'error') showToast('Could not make the subtitles. Try again.', { type: 'error' });
      // The job may have wanted the speaker-detection models or a translation
      // pack and gone without for lack of permission. Ask now, same as the
      // sidebar does: the CC button is the usual way in, and before this the
      // question only came up after a page refresh and a sidebar regenerate.
      subtitlesOfferPendingConsent();
    }
  };
  _subs.growPoll = setTimeout(tick, 1500);
}

/* ── Progress pill (so it's clearly working, not stuck) ─────────────────── */

function _subsShowProgress(info) {
  const content = document.getElementById('mediaPlayerContent');
  if (!content) return;
  let pill = document.getElementById('subtitleProgress');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'subtitleProgress';
    pill.className = 'subtitle-progress';
    content.appendChild(pill);
  }
  const pct = Math.round(info.progress || 0);
  pill.innerHTML = `<span class="sub-prog-spin"></span> ${escapeHtml(info.stage || 'Generating subtitles…')} <b>${pct}%</b>`;
}

function _subsHideProgress() {
  document.getElementById('subtitleProgress')?.remove();
}

/** Indeterminate "trickle" for operations with no server-side progress feed —
 *  the Fix patch is one blocking request, so there's no job to poll. The pill
 *  climbs toward ~92% and eases as it rises (so it visibly advances instead of
 *  sitting still); the caller snaps it away on completion. */
function _subsTrickle(stage) {
  _subsCancelTrickle();
  let pct = 6;
  _subsShowProgress({ progress: pct, stage });
  _subs.trickle = setInterval(() => {
    pct += Math.max(0.5, (92 - pct) * 0.09);
    if (pct >= 92) pct = 92;
    _subsShowProgress({ progress: pct, stage });
  }, 400);
}
function _subsCancelTrickle() {
  if (_subs.trickle) { clearInterval(_subs.trickle); _subs.trickle = null; }
}

function _subsDetachOverlayOnly() {
  if (_subs.video && _subs.handler) _subs.video.removeEventListener('timeupdate', _subs.handler);
  if (_subs.reposition) {
    window.removeEventListener('resize', _subs.reposition);
    document.removeEventListener('fullscreenchange', _subs.reposition);
  }
  _subs.classObserver?.disconnect();
  _subs.el?.remove();
  _subs.el = null; _subs.handler = null; _subs.cues = null; _subs.lang = null;
  _subs.reposition = null; _subs.classObserver = null;
  const fix = document.getElementById('subtitleFixBtn');
  if (fix) fix.style.display = 'none';
}

function subtitlesDetach() {
  _subsDetachOverlayOnly();
  _subsCancelTrickle();
  clearTimeout(_subs.genPoll);
  clearTimeout(_subs.growPoll);
  // Note: sidebarPoll is intentionally NOT cleared here — it self-terminates
  // when its panel leaves the DOM, and rescan detaches the overlay while the
  // sidebar keeps polling for the fresh tracks.
  _subsHideProgress();
  _subs = { mediaId: null, lang: null, cues: null, el: null, handler: null, genPoll: null, growPoll: null, sidebarPoll: _subs.sidebarPoll, trickle: null, video: null, notice: null };
}

/* ── Cue rendering (voice colors + anti-overlap stacking) ───────────────── */

function _subsTick(video, cues, el) {
  const t = video.currentTime;
  // All active cues (usually 1; overlapping voice-tagged cues stack)
  const active = [];
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].start <= t && t < cues[i].end) active.push(cues[i]);
    else if (cues[i].start > t) break;
  }

  const key = active.map(c => c.start).join(',');
  if (key === el._lastKey) return;
  el._lastKey = key;

  if (!active.length) { el.innerHTML = ''; el.classList.remove('visible'); return; }
  el.innerHTML = active.map(c => {
    const color = c.voice ? SUB_VOICE_COLORS[_subsVoiceIdx(c.voice) % SUB_VOICE_COLORS.length] : '';
    const style = color && c.voice ? ` style="color:${color}"` : '';
    return `<div class="subtitle-line"${style}>${escapeHtml(_subsClean(c.text)).replace(/\n/g, '<br>')}</div>`;
  }).join('');
  el.classList.add('visible');
}

/** Strip model/subtitle markup + decode entities at render time — so tracks
 *  generated before the server-side cleanup still display cleanly. */
const _SUB_ENT = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
function _subsClean(s) {
  if (!s) return '';
  s = s.replace(/&lt;\/?(?:i|b|u|font[^&]*?)&gt;/gi, '').replace(/<\/?(?:i|b|u|font[^>]*?)>/gi, '');
  s = s.replace(/\{\\?[^}]*\}/g, '');
  s = s.replace(/&(?:lt|gt|amp|quot|apos|nbsp|#39);/gi, m => _SUB_ENT[m.toLowerCase()] || m);
  return s.replace(/[ \t]+/g, ' ').trim();
}

const _voiceIdxMap = new Map();
function _subsVoiceIdx(voice) {
  // 0-based → first speaker seen = white, second = yellow, … (classic order)
  if (!_voiceIdxMap.has(voice)) _voiceIdxMap.set(voice, _voiceIdxMap.size);
  return _voiceIdxMap.get(voice);
}

/* ── Client VTT parser (subset we emit: numbered cues, optional <v> tags) ── */

function subtitlesParseVTT(vtt) {
  const cues = [];
  const blocks = String(vtt).replace(/\r/g, '').split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    const timeIdx = lines.findIndex(l => l.includes('-->'));
    if (timeIdx === -1) continue;
    const m = lines[timeIdx].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!m) continue;
    let text = lines.slice(timeIdx + 1).join('\n');
    let voice = null;
    const vm = text.match(/^<v\s+([^>]+)>([\s\S]*?)(<\/v>)?$/);
    if (vm) { voice = vm[1].trim(); text = vm[2].replace(/<\/v>\s*$/, ''); }
    const toSec = (s) => s.split(':').map(Number).reduce((a, p) => a * 60 + p, 0);
    cues.push({ start: toSec(m[1]), end: toSec(m[2]), text: text.trim(), voice });
  }
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/* ── On-request generation ──────────────────────────────────────────────── */

async function subtitlesGenerate() {
  const media = currentMediaState.currentMediaData;
  if (!media) return;
  const genBtn = document.getElementById('subtitleGenBtn');
  try {
    const resp = await fetch(`/api/media/${media.id}/subtitles/generate`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      if (!subtitlesHandleGenerateError(resp, data, subtitlesGenerate)) {
        showErrorToast(data, 'starting the subtitles');
      }
      return;
    }
    showToast('📝 Making subtitles. The first lines appear in a few seconds.');
    if (genBtn) genBtn.style.display = 'none';   // the progress pill takes over
    // Streaming: cues stream into the VTT; the growth poll shows them + progress
    _subsShowProgress({ progress: 0, stage: 'Starting…', status: 'queued' });
    _subsStartGrowthPoll(media);
  } catch (err) {
    showErrorToast(err, 'starting the subtitles');
  }
}

/** Re-scan subtitles around the current playhead (±1 min) and reload. */
async function subtitlesFixHere() {
  const media = currentMediaState.currentMediaData;
  const video = currentMediaState.element;
  if (!media || !video) return;
  const at = Math.max(0, Math.floor(video.currentTime || 0));
  const mmss = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}`;
  const btn = document.getElementById('subtitleFixBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⟳ …'; }
  showToast('⟳ Fixing the subtitles around here…');
  // The patch is one blocking request (no job to poll) — trickle the pill so
  // it's clearly working while the re-scan runs.
  _subsTrickle(`Re-scanning subtitles around ${mmss}…`);
  try {
    const resp = await fetch(`/api/media/${media.id}/subtitles/patch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at, window: 60 }),
    });
    const data = await resp.json();
    if (!resp.ok) { _subsCancelTrickle(); _subsHideProgress(); showErrorToast(data, 'fixing the subtitles'); return; }
    _subsCancelTrickle();
    showToast(`✓ Fixed: ${data.patched} line${data.patched === 1 ? '' : 's'} updated${data.speakers ? ', speakers labelled again' : ''}`, { type: 'success' });
    if (currentMediaState.currentMediaData?.id === media.id) {
      _subs.lang = null;                 // force a re-fetch of the rewritten VTT
      await applySubtitlesFor(media);    // detaches → clears the pill, reloads cues
    } else {
      _subsHideProgress();
    }
    if (typeof subtitlesLoadSidebar === 'function') subtitlesLoadSidebar(media.id);   // refresh sidebar counts
  } catch (err) {
    _subsCancelTrickle(); _subsHideProgress();
    showErrorToast(err, 'fixing the subtitles');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⟳ Fix'; }
  }
}

/* ── Sidebar section: view / edit tracks + rescan (SUBTITLES_SPEC §6) ────────
   Mirrors renderMusicSidebarSection (player-lib/music.js): a synchronous shell
   whose track list fills in async. Lets the user open the raw VTT to hand-edit
   it, download SRT, delete a track, or re-generate the whole thing. */

const SUB_LANG_NAMES = {
  en: 'English', ja: 'Japanese', zh: 'Chinese', ko: 'Korean', es: 'Spanish',
  fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', ru: 'Russian',
  ar: 'Arabic', hi: 'Hindi', nl: 'Dutch', pl: 'Polish', tr: 'Turkish',
  th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', sv: 'Swedish', cs: 'Czech',
  uk: 'Ukrainian', el: 'Greek', he: 'Hebrew', fi: 'Finnish', da: 'Danish',
  hu: 'Hungarian', ro: 'Romanian', no: 'Norwegian',
};
/** A glyph the Modern Info panel shows as a line icon; Classic keeps it (icons.js). */
function subsGlyph(emoji, icon) {
  return typeof vaultPanelIconSwap === 'function' ? vaultPanelIconSwap(emoji, icon) : escapeHtml(emoji);
}
/** A glyph shown as a line icon in Modern (any surface), kept in Classic (icons.js). */
function subsSwap(emoji, icon) {
  return typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, icon) : escapeHtml(emoji);
}
const subLangName = (l) => SUB_LANG_NAMES[l] || (l || '').toUpperCase();

function renderSubtitlesSidebarSection(media) {
  if (!media || !['video', 'audio'].includes(media.media_type)) return '';
  setTimeout(() => subtitlesLoadSidebar(media.id), 0);   // fill once the HTML lands
  return `
    <div class="detail-section subtitles-section" data-media-id="${media.id}">
      <h3>💬 Subtitles</h3>
      <div class="field-content subtitles-sidebar-body" data-subs-box="${media.id}">
        <span class="subs-hint">Loading…</span>
      </div>
    </div>`;
}

/** Every open copy of this section — see musicBoxes() in music.js for why. */
function subsBoxes(mediaId) {
  return document.querySelectorAll(`[data-subs-box="${mediaId}"]`);
}

async function subtitlesLoadSidebar(mediaId) {
  const boxes = subsBoxes(mediaId);
  if (!boxes.length) return;
  let info;
  try { info = await fetch(`/api/media/${mediaId}/subtitles/info`).then(r => r.json()); }
  catch {
    boxes.forEach(b => { b.innerHTML = '<span class="subs-hint">Could not load the subtitles.</span>'; });
    return;
  }
  const html = subtitlesSidebarHtml(mediaId, info);
  subsBoxes(mediaId).forEach(b => { b.innerHTML = html; });
}

function subtitlesSidebarHtml(mediaId, info) {
  const running = ['queued', 'transcribing', 'translating'].includes(info.status);
  const tracks = info.tracks || [];

  if (running) {
    return `
      <div class="subs-status"><span class="sub-prog-spin"></span> ${escapeHtml(info.stage || 'Generating…')} <b>${Math.round(info.progress || 0)}%</b></div>
      <div class="subs-hint">Lines stream in as they're transcribed. This panel updates when done.</div>
      <div class="subs-actions"><button class="subs-btn" onclick="subtitlesLoadSidebar(${mediaId})">${subsGlyph('↻ ', 'refresh')}Refresh</button></div>`;
  }

  const rows = tracks.length ? tracks.map(t => {
    const kindLabel = t.kind === 'translated' ? 'translated' : 'original';
    return `
      <div class="subs-track">
        <span class="subs-track-label">${escapeHtml(subLangName(t.lang))} <span class="subs-track-kind">${kindLabel}</span></span>
        <span class="subs-track-btns">
          <button class="subs-btn" title="Transcript. Click a line to jump there, ${typeof vaultIsModern === 'function' && vaultIsModern() ? 'the pin' : '📌'} to save it as a note snippet" onclick="subtitlesToggleTranscript(${mediaId}, '${escapeHtml(t.lang)}')">${subsGlyph('≡', 'table')}</button>
          <button class="subs-btn" title="Edit the subtitle lines" onclick="subtitlesOpenEditor(${mediaId}, '${escapeHtml(t.lang)}')">${subsGlyph('✎ ', 'edit')}Edit</button>
          <a class="subs-btn" title="Download as SRT" href="/api/media/${mediaId}/subtitles?lang=${encodeURIComponent(t.lang)}&format=srt">${subsGlyph('⤓ ', 'download')}SRT</a>
          <button class="subs-btn subs-btn-danger" title="Delete this track" onclick="subtitlesDeleteTrack(${mediaId}, '${escapeHtml(t.lang)}')">${subsGlyph('✕', 'close')}</button>
        </span>
      </div>`;
  }).join('') : '<div class="subs-hint">No subtitles yet.</div>';

  const rescan = tracks.length
    ? `<button class="subs-btn" title="Make the subtitles again from the start (replaces every track)" onclick="subtitlesRescanAll(${mediaId})">${subsGlyph('🔄 ', 'refresh')}Rescan all</button>`
    : `<button class="subs-btn subs-btn-primary" title="Transcribe this file now" onclick="subtitlesGenerateFor(${mediaId})">${subsGlyph('＋ ', 'plus')}Generate</button>`;

  return `<div class="subs-tracks">${rows}</div>
    <div class="subs-transcript" id="subsTranscript-${mediaId}" style="display:none"></div>
    <div class="subs-actions">${rescan}</div>`;
}

/* ── Transcript view: timestamped lines — click to seek, 📌 to save ──────── */

async function subtitlesToggleTranscript(mediaId, lang) {
  const box = document.getElementById(`subsTranscript-${mediaId}`);
  if (!box) return;
  if (box.style.display !== 'none' && box.dataset.lang === lang) {
    box.style.display = 'none';                   // same track again → collapse
    return;
  }
  box.dataset.lang = lang;
  box.style.display = '';
  box.innerHTML = '<span class="subs-hint">Loading transcript…</span>';

  let vtt;
  try {
    vtt = await fetch(`/api/media/${mediaId}/subtitles?lang=${encodeURIComponent(lang)}`).then(r => r.ok ? r.text() : null);
  } catch { vtt = null; }
  if (vtt == null) { box.innerHTML = '<span class="subs-hint">Could not load this track.</span>'; return; }

  const cues = subtitlesParseVTT(vtt);
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  box.innerHTML = cues.length ? cues.map(c => `
    <div class="subs-tr-line" data-start="${c.start}" title="Jump to ${fmt(c.start)}">
      <span class="subs-tr-time">${fmt(c.start)}</span>
      <span class="subs-tr-text">${escapeHtml(_subsClean(c.text))}</span>
      <button class="subs-tr-pin" title="Save this line as a note snippet">${subsGlyph('📌', 'pin')}</button>
    </div>`).join('') : '<span class="subs-hint">No cues in this track.</span>';

  box.onclick = async (e) => {
    const line = e.target.closest('.subs-tr-line');
    if (!line) return;

    // 📌 pin the spoken line as a reusable note snippet
    if (e.target.closest('.subs-tr-pin')) {
      const text = line.querySelector('.subs-tr-text').textContent.trim();
      if (!text) return;
      try {
        const resp = await fetch('/api/note-snippets', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!resp.ok) { showErrorToast(await resp.json().catch(() => ({ status: resp.status })), 'saving the line as a snippet'); return; }
        showToast('📌 Line saved as a note snippet');
        if (typeof loadNoteSnippets === 'function') loadNoteSnippets();   // refresh chip cache
        if (typeof gamifyEvent === 'function') gamifyEvent('quote_saved');
      } catch (err) { showErrorToast(err, 'saving the line as a snippet'); }
      return;
    }

    // Timestamp/line click → seek the playing media to just before the cue
    const start = Number(line.dataset.start);
    const el = currentMediaState.element;
    if (currentMediaState.currentMediaData?.id === mediaId && el && ['VIDEO', 'AUDIO'].includes(el.tagName)) {
      el.currentTime = Math.max(0, start - 0.3);
      if (!(typeof mpQuietToast === 'function' && mpQuietToast())) showToast(`⏪ Jumped to ${fmt(start)}`);   // the dock's playhead says it
      if (typeof gamifyEvent === 'function') gamifyEvent('transcript_seek');
    } else if (typeof detailSeekTo === 'function' && detailSeekTo(mediaId, start - 0.3)) {
      // Clicked from the library modal — open the file, then land on the line
      showToast(`⏪ Jumped to ${fmt(start)}`);
      if (typeof gamifyEvent === 'function') gamifyEvent('transcript_seek');
    } else {
      showToast('Play this file first to jump to the line');
    }
  };
}

/* ── Missing prerequisites explainer ──────────────────────────────────────
   Subtitles are the one feature Vault can't install for you: not a single
   binary to drop next to the exe like ffmpeg and fpcalc, but a Python
   interpreter plus a pip package. Asking for it on the setup banner would nag
   every user about something most never touch, so the explanation arrives at
   the moment someone actually presses Generate — the same shape as the
   first-launch password modal.

   Returns true when it handled a failed response, so callers can bail. */
function subtitlesHandleGenerateError(resp, data, retry) {
  if (data?.code === 'WHISPER_MISSING') { subtitlesShowPrereqModal(data); return true; }
  if (data?.code === 'MODEL_DOWNLOAD_CONSENT') { subtitlesShowModelConsent(data, retry); return true; }
  if (data?.code === 'DOWNLOADS_OFF_BY_ENV') {
    // The variable names stay: only whoever set them can turn downloads back on.
    showToast('Model downloads are turned off for this copy of Vault (SUB_ALLOW_DOWNLOADS=0 or VAULT_OFFLINE=1).', { type: 'error' });
    return true;
  }
  return false;
}

/* ── Consent before the model download ───────────────────────────────────
   The transcription model is a ~1.5 GB fetch from HuggingFace on first use.
   It used to start on its own and announce itself afterwards in a console
   line no exe user sees — which isn't consent. Asked once here; the answer
   persists server-side and covers the translation and diarization models too,
   since they're the same class of one-time fetch. */
// Keys whose dialog was closed without an answer (backdrop click or Esc):
// "not now" for this page load only. Nothing is saved, so a reload asks again,
// but the end of every job does not.
const _subsConsentDismissed = new Set();

/**
 * Plain words for one model consent: { title, what, decline, them }, plain
 * text (them: the model is plural, so "download them").
 * The consent keys keep their codenames ("whisper:large-v3-turbo", "opus:ja");
 * people see what the model is for and its size ("~1.5 GB" -> "about 1.5 GB").
 * One decision per model: the copy says what happens on a no, because two of
 * the three have a working fallback.
 */
function subtitlesConsentCopy(kind, detail, sizeHint) {
  const size = String(sizeHint || '').trim().replace(/^~\s*/, 'about ');
  const sized = (s) => (size ? `${s} (${size})` : s);
  if (kind === 'whisper') {
    return {
      title: `${sized('Download the subtitles model')}?`,
      what: 'This is the speech-to-text model that makes subtitles.',
      decline: 'Without it, Vault cannot make subtitles. Everything else keeps working.',
    };
  }
  if (kind === 'opus') {
    const lang = detail ? subLangName(detail) : '';
    const pack = lang && lang !== 'English' ? `${lang} to English translation pack` : 'translation pack';
    return {
      title: `${sized(`Download the ${pack}`)}?`,
      what: lang && lang !== 'English' ? `It translates ${lang} subtitles to English.` : 'It translates subtitles to English.',
      decline: 'If you say no, Vault keeps translating with your LM Studio model. That is slower, but nothing is downloaded.',
    };
  }
  if (kind === 'diarize') {
    return {
      title: `${sized('Download the speaker detection models')}?`,
      what: 'They tell speakers apart, so each line can say who is talking.',
      them: true,
      decline: 'If you say no, subtitles are still made, just without speaker labels.',
    };
  }
  return {
    title: `${sized('Download a model')}?`,
    what: detail ? `The model is called "${detail}".` : '',
    decline: 'Nothing is downloaded if you say no.',
  };
}

function subtitlesShowModelConsent(info = {}, retry) {
  document.getElementById('subsModelConsent')?.remove();
  const key = info.key || 'whisper:large-v3-turbo';
  const kind = info.kind || (key.split(':')[0]);
  const detail = info.detail || key.split(':')[1] || '';
  const c = subtitlesConsentCopy(kind, detail, info.sizeHint);

  const ov = document.createElement('div');
  ov.id = 'subsModelConsent';
  ov.className = 'vault-modal-overlay';
  ov.innerHTML = `
    <div class="vault-modal" role="dialog" aria-modal="true" aria-labelledby="subsModelTitle">
      <h3 id="subsModelTitle">${escapeHtml(c.title)}</h3>
      <p class="vault-modal-hint">
        ${escapeHtml(c.what)} Vault downloads ${c.them ? 'them' : 'it'} once from Hugging Face
        and runs ${c.them ? 'them' : 'it'} on this computer. Your files are never uploaded.
      </p>
      <p class="vault-modal-hint">${escapeHtml(c.decline)}</p>
      <p class="vault-modal-hint">
        Vault asks about each model on its own. You can change your answer any
        time in Settings &gt; Privacy and security.
      </p>
      <div class="vault-modal-actions">
        <button class="vault-btn" id="subsModelNo">Not now</button>
        <button class="vault-btn vault-btn-primary" id="subsModelYes">Download</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  // Esc is "not now" for this page load, and stops here (not the player too)
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };
  const dismiss = () => {
    _subsConsentDismissed.add(key);
    ov.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  window.addEventListener('keydown', onKey, true);
  const answer = async (allow) => {
    ov.remove();
    window.removeEventListener('keydown', onKey, true);
    try {
      const r = await fetch('/api/settings/model-downloads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, allow }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { showErrorToast({ error: d.error, status: r.status }, 'saving your answer'); return; }
    } catch (err) { showErrorToast(err, 'saving your answer'); return; }
    if (!allow) { showToast('Nothing was downloaded. Vault will ask again when it needs this model.'); return; }
    showToast('Download approved. It starts the next time the model is needed.', { type: 'success' });
    if (typeof retry === 'function') retry();      // resume what they clicked
  };
  ov.querySelector('#subsModelYes').addEventListener('click', () => answer(true));
  ov.querySelector('#subsModelNo').addEventListener('click', () => answer(false));
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) dismiss(); });
  ov.querySelector('#subsModelYes').focus();
}

/**
 * Offer anything a running job wanted but wasn't allowed to fetch.
 *
 * Translation packs and the diarization models are needed MID-job, long after
 * the button press — whisper has to run before we know the language. Both fall
 * back gracefully (LLM translation, unlabelled cues), so nothing is blocked;
 * this just surfaces the choice at the point it became relevant, one artifact
 * at a time.
 */
async function subtitlesOfferPendingConsent() {
  if (document.getElementById('subsModelConsent')) return;   // one ask at a time
  let st;
  try { st = await (await fetch('/api/settings/model-downloads')).json(); }
  catch { return; }
  if (!st.envAllows) return;
  // A model the user already said "Not now" to is not asked about again after
  // every job (it stays changeable in Settings). Whisper itself is different:
  // Generate asks each time, since nothing works without it.
  const ask = (st.pending || []).find(p => st.consents?.[p.key] !== false && !_subsConsentDismissed.has(p.key));
  if (ask) subtitlesShowModelConsent(ask);
}

function subtitlesShowPrereqModal(info = {}) {
  document.getElementById('subsPrereqModal')?.remove();
  const noPython = !info.python;
  const pyCmd = info.pythonCmd || 'python';

  // Two different problems, two different fixes — saying "subtitles
  // unavailable" for both sends half the users to the wrong place.
  const cmd = (text) => `<div class="subs-prereq-cmd"><code>${escapeHtml(text)}</code>
           <button class="vault-btn subs-prereq-copy" data-copy="${escapeHtml(text)}">Copy</button></div>`;
  const steps = noPython
    ? `<li>Install Python 3.9 or newer. In its installer, tick <b>Add python.exe to PATH</b>.
         ${cmd('winget install Python.Python.3.12')}
         Or download it from <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">python.org</a>.</li>
       <li>Then add the speech-to-text package:
         ${cmd('pip install faster-whisper')}</li>
       <li>Restart Vault, so it can find the new Python.</li>`
    : `<li>Add it to the Python Vault uses:
         ${cmd(`${pyCmd} -m pip install faster-whisper`)}</li>
       <li>Press <b>Generate</b> again. No restart needed.</li>`;

  const ov = document.createElement('div');
  ov.id = 'subsPrereqModal';
  ov.className = 'vault-modal-overlay';
  ov.innerHTML = `
    <div class="vault-modal subs-prereq" role="dialog" aria-modal="true" aria-labelledby="subsPrereqTitle">
      <h3 id="subsPrereqTitle">${noPython ? 'Subtitles need Python' : 'Subtitles need one more package'}</h3>
      <p class="vault-modal-hint">
        ${noPython
          ? 'Subtitles need Python, which Vault cannot install for you. Everything else, Vault sets up itself.'
          : 'Python is installed, but the speech-to-text package that makes subtitles is not.'}
      </p>
      <ol class="vault-modal-hint subs-prereq-steps">${steps}</ol>
      <details class="vault-modal-hint subs-prereq-more">
        <summary>For advanced setups</summary>
        <p>Using a virtual environment? Set <code>PYTHON_PATH</code> to that
        environment's python.exe, then restart Vault. SETUP.md has the details.</p>
      </details>
      <div class="vault-modal-actions">
        <button class="vault-btn vault-btn-primary" id="subsPrereqClose">Got it</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  ov.querySelectorAll('.subs-prereq-copy').forEach(btn => btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
      setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1500);
    } catch { /* clipboard blocked — the text is selectable anyway */ }
  }));
  // Esc closes this and stops there (not the player behind it as well)
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const close = () => { ov.remove(); window.removeEventListener('keydown', onKey, true); };
  window.addEventListener('keydown', onKey, true);
  ov.querySelector('#subsPrereqClose').addEventListener('click', close);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#subsPrereqClose').focus();
}

/** Generate for a specific media id from the sidebar (player may not be on it). */
async function subtitlesGenerateFor(mediaId) {
  try {
    const resp = await fetch(`/api/media/${mediaId}/subtitles/generate`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      if (!subtitlesHandleGenerateError(resp, data, () => subtitlesGenerateFor(mediaId))) {
        showErrorToast(data, 'starting the subtitles');
      }
      return;
    }
    showToast('📝 Making subtitles…');
    subtitlesLoadSidebar(mediaId);
    // If we're watching this item, let the player's poller pick up the cues too
    if (currentMediaState.currentMediaData?.id === mediaId && subtitleMode !== 'off') {
      _subsShowProgress({ progress: 0, stage: 'Starting…', status: 'queued' });
      _subsStartGrowthPoll(currentMediaState.currentMediaData);
    }
    _subsPollSidebarUntilDone(mediaId);
  } catch (err) { showErrorToast(err, 'starting the subtitles'); }
}

/* ── Rescan confirm modal: replaces the native confirm() so the user can
   force the spoken language when auto-detect got it wrong (e.g. Japanese
   read as English from a misleading opening). Languages with an OPUS-MT
   translation pack already installed are listed first. */

async function subtitlesRescanAll(mediaId) {
  // Installed translation packs — best-effort; the modal works without them
  let installed = [];
  try {
    const data = await fetch('/api/subtitles/langs').then(r => r.json());
    installed = (data.installed || []).map(p => p.lang);
  } catch { /* offline pack list — show the plain language list */ }

  const byName = (a, b) => subLangName(a).localeCompare(subLangName(b));
  const packLangs = installed.filter(l => SUB_LANG_NAMES[l] || l).sort(byName);
  const otherLangs = Object.keys(SUB_LANG_NAMES).filter(l => !packLangs.includes(l)).sort(byName);
  const opt = (l, note) => `<option value="${escapeHtml(l)}">${escapeHtml(subLangName(l))}${note ? ` (${note})` : ''}</option>`;

  document.getElementById('subsRescanOverlay')?.remove();
  const ov = document.createElement('div');
  ov.id = 'subsRescanOverlay';
  ov.className = 'subs-editor-overlay';
  ov.innerHTML = `
    <div class="subs-editor subs-rescan" role="dialog" aria-label="Rescan subtitles">
      <div class="subs-editor-head">
        <span>Rescan subtitles</span>
        <button class="subs-editor-x" title="Close (Esc)" aria-label="Close" onclick="subtitlesCloseRescan()">${subsSwap('✕', 'close')}</button>
      </div>
      <div class="subs-rescan-body">
        <p class="subs-rescan-warn">${subsSwap('⚠ ', 'alert')}This makes the subtitles again from the start and replaces every track for this file, including your edits.</p>
        <label class="subs-rescan-label" for="subsRescanLang">Spoken language</label>
        <select id="subsRescanLang" class="subs-rescan-select">
          <option value="">Auto-detect (default)</option>
          ${packLangs.length ? `<optgroup label="Translation pack installed">${packLangs.map(l => opt(l, 'pack installed')).join('')}</optgroup>` : ''}
          <optgroup label="${packLangs.length ? 'Other languages' : 'Languages'}">${otherLangs.map(l => opt(l)).join('')}</optgroup>
        </select>
        <p class="subs-hint">Force a language when auto-detect gets it wrong. Non-English audio is translated to English after transcription.</p>
      </div>
      <div class="subs-editor-foot">
        <span class="subs-editor-hint"></span>
        <span class="subs-editor-actions">
          <button class="subs-btn" onclick="subtitlesCloseRescan()">Cancel</button>
          <button class="subs-btn subs-btn-primary" id="subsRescanGo" onclick="subtitlesConfirmRescan(${mediaId})">Rescan</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) subtitlesCloseRescan(); });
  document.addEventListener('keydown', _subsRescanKey);
  document.getElementById('subsRescanLang')?.focus();
}

function _subsRescanKey(e) {
  if (e.key === 'Escape') subtitlesCloseRescan();
}
function subtitlesCloseRescan() {
  document.removeEventListener('keydown', _subsRescanKey);
  document.getElementById('subsRescanOverlay')?.remove();
}

async function subtitlesConfirmRescan(mediaId) {
  const lang = document.getElementById('subsRescanLang')?.value || '';
  const btn = document.getElementById('subsRescanGo');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    const resp = await fetch(`/api/media/${mediaId}/subtitles/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fresh: true, ...(lang ? { lang } : {}) }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (subtitlesHandleGenerateError(resp, data, () => subtitlesConfirmRescan(mediaId))) subtitlesCloseRescan();
      else showErrorToast(data, 'starting the subtitles');
      return;
    }
    subtitlesCloseRescan();
    showToast(lang ? `🔄 Rescanning as ${subLangName(lang)}…` : '🔄 Rescanning from scratch…');
    // Drop what's on screen now — the old cues are being deleted
    if (currentMediaState.currentMediaData?.id === mediaId) {
      subtitlesDetach();
      if (subtitleMode !== 'off') {
        _subsShowProgress({ progress: 0, stage: 'Starting…', status: 'queued' });
        _subsStartGrowthPoll(currentMediaState.currentMediaData);
      }
    }
    subtitlesLoadSidebar(mediaId);
    _subsPollSidebarUntilDone(mediaId);
  } catch (err) {
    showErrorToast(err, 'starting the rescan');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Rescan'; }
  }
}

/** Poll the sidebar panel while a job runs so track rows appear on completion. */
function _subsPollSidebarUntilDone(mediaId) {
  clearTimeout(_subs.sidebarPoll);
  const tick = async () => {
    if (!subsBoxes(mediaId).length) return;   // every surface closed/navigated away
    let info;
    try { info = await fetch(`/api/media/${mediaId}/subtitles/info`).then(r => r.json()); }
    catch { _subs.sidebarPoll = setTimeout(tick, 2500); return; }
    subtitlesLoadSidebar(mediaId);
    if (['queued', 'transcribing', 'translating'].includes(info.status)) {
      _subs.sidebarPoll = setTimeout(tick, 2000);
    } else {
      // Job settled — a translation pack or the diarization models may have
      // been wanted along the way and skipped for lack of permission. Offer
      // them now, when the user can see what it was for.
      subtitlesOfferPendingConsent();
    }
  };
  _subs.sidebarPoll = setTimeout(tick, 2000);
}

async function subtitlesDeleteTrack(mediaId, lang) {
  if (!await vaultConfirm(`Delete the ${subLangName(lang)} subtitle track? This cannot be undone.`, {
    title: 'Delete subtitles', okLabel: 'Delete', danger: true,
  })) return;
  try {
    const resp = await fetch(`/api/media/${mediaId}/subtitles?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' });
    if (!resp.ok) { showErrorToast(await resp.json().catch(() => ({ status: resp.status })), 'deleting the track'); return; }
    showToast(`✓ ${subLangName(lang)} subtitles deleted`, { type: 'success' });
    if (currentMediaState.currentMediaData?.id === mediaId && _subs.lang === lang) {
      _subs.lang = null;
      await applySubtitlesFor(currentMediaState.currentMediaData);
    }
    subtitlesLoadSidebar(mediaId);
  } catch (err) { showErrorToast(err, 'deleting the track'); }
}

/* ── VTT editor (raw cue text, hand-editable) ───────────────────────────── */

async function subtitlesOpenEditor(mediaId, lang) {
  let vtt;
  try {
    vtt = await fetch(`/api/media/${mediaId}/subtitles?lang=${encodeURIComponent(lang)}`).then(r => r.ok ? r.text() : null);
  } catch { vtt = null; }
  if (vtt == null) { showToast('Could not open the subtitles. Try again.', { type: 'error' }); return; }

  document.getElementById('subsEditorOverlay')?.remove();
  const ov = document.createElement('div');
  ov.id = 'subsEditorOverlay';
  ov.className = 'subs-editor-overlay';
  ov.innerHTML = `
    <div class="subs-editor" role="dialog" aria-label="Edit subtitles">
      <div class="subs-editor-head">
        <span>Edit subtitles: <b>${escapeHtml(subLangName(lang))}</b></span>
        <button class="subs-editor-x" title="Close (Esc)" aria-label="Close" onclick="subtitlesCloseEditor()">${subsSwap('✕', 'close')}</button>
      </div>
      <textarea class="subs-editor-ta" spellcheck="false" wrap="off">${escapeHtml(vtt)}</textarea>
      <div class="subs-editor-foot">
        <span class="subs-editor-hint">WebVTT: <code>00:00:01.000 --&gt; 00:00:03.000</code>, then the line. Speaker tags: <code>&lt;v Speaker 1&gt;…&lt;/v&gt;</code>.</span>
        <span class="subs-editor-actions">
          <button class="subs-btn" onclick="subtitlesCloseEditor()">Cancel</button>
          <button class="subs-btn subs-btn-primary" id="subsEditorSave" onclick="subtitlesSaveEditor(${mediaId}, '${escapeHtml(lang)}')">Save</button>
        </span>
      </div>
    </div>`;
  document.body.appendChild(ov);
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) subtitlesCloseEditor(); });
  document.addEventListener('keydown', _subsEditorKey);
  ov.querySelector('.subs-editor-ta')?.focus();
}

function _subsEditorKey(e) {
  if (e.key === 'Escape') subtitlesCloseEditor();
}
function subtitlesCloseEditor() {
  document.removeEventListener('keydown', _subsEditorKey);
  document.getElementById('subsEditorOverlay')?.remove();
}

async function subtitlesSaveEditor(mediaId, lang) {
  const ta = document.querySelector('#subsEditorOverlay .subs-editor-ta');
  const btn = document.getElementById('subsEditorSave');
  if (!ta) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    const resp = await fetch(`/api/media/${mediaId}/subtitles?lang=${encodeURIComponent(lang)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vtt: ta.value }),
    });
    const data = await resp.json();
    if (!resp.ok) { showErrorToast(data, 'saving the subtitles'); return; }
    showToast(`✓ Saved: ${data.cues} line${data.cues === 1 ? '' : 's'}`, { type: 'success' });
    subtitlesCloseEditor();
    // Reload the on-screen cues if this track is showing
    if (currentMediaState.currentMediaData?.id === mediaId && _subs.lang === lang) {
      _subs.lang = null;
      await applySubtitlesFor(currentMediaState.currentMediaData);
    }
  } catch (err) {
    showErrorToast(err, 'saving the subtitles');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}
