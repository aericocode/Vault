/* =========================================================================
   MODERN PLAYER - the Modern look's video controls: a top bar and a
   full-width bottom dock over the picture (.notes/MODERN_PLAYER_SPEC.md).

   Classic keeps its own control bar (player-video.js renders one or the
   other, and re-renders when the look is switched with a video open). The
   buttons keep the ids the rest of the player already drives (playPauseBtn,
   currentTime, totalTime, speedDisplay, volumeSlider, abLoopBtn, repeatBtn,
   subtitleBtn, vibeBtn, beatbarBtn, facesFrameBtn), so play, time, speed,
   repeat, the beat bar and device sync keep working without knowing which
   look drew them.

   What is here:
   - modernVideoControlsHtml()    the top bar and dock markup
   - ModernDock.mount/unmount     wire up / let go of the rendered dock
   - the timeline: song segments, a 40 px grab area, the heat ridge (only
     while the pointer is over the grab area), note and Hot pins, the A-B
     span, and the scrub preview (hover frame, time, song, nearby note)
   - the speed list and the gear menu (submenus open in place)
   - show / hide by pointer zone (DockGeom.zoneDecision) and what holds the
     chrome up (a menu, the preview, a drag, keyboard focus in the dock)
   - folding for narrow stages (DockGeom.foldLevel on a ResizeObserver)

   Pure maths lives in dock-geometry.js; this file is the DOM around it.
   ========================================================================= */

/** Is the Modern look on? (settings.js defines isModernLayout.) */
function isModernPlayer() {
  return typeof window.isModernLayout === 'function' && window.isModernLayout();
}

/** The Modern dock is up: its buttons already show what a toggle did (A-B,
 *  CC, beat bar, device sync), so those skip their toast. */
function mpQuietToast() {
  return typeof ModernDock !== 'undefined' && ModernDock.mounted();
}

/** One dock icon: the icons.js line icon, sized by the dock's CSS. */
function mpIcon(name) {
  return typeof vaultIcon === 'function' ? vaultIcon(name, 'mp-i') : '';
}

function mpEsc(s) {
  return typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** A plain icon button. `attrs` is extra markup (id, onclick, hidden...). */
function mpButton(icon, title, attrs = '', cls = '') {
  return `<button type="button" class="mp-ic${cls ? ' ' + cls : ''}" title="${mpEsc(title)}" aria-label="${mpEsc(title.replace(/\s*\(.*\)$/, ''))}" ${attrs}>${mpIcon(icon)}</button>`;
}

/** Is a device set up (an address saved, or sync already on)? */
function mpDeviceSetUp() {
  try {
    if (window.LovenseSync && window.LovenseSync.enabled) return true;
    return !!(window.LovenseApi && window.LovenseApi.savedIP && window.LovenseApi.savedIP());
  } catch { return false; }
}

/* True only while the dock's markup is being built. The shared button
   renderers (Hot, Done, A-B, repeat, CC, faces, device sync) check it to
   hand back their Modern form here, and stay Classic everywhere else (the
   audio player keeps Classic's bar in both looks). */
let _mpBuilding = false;
function mpBuildingDock() { return _mpBuilding; }

/**
 * The Modern controls for a video: the top bar and the dock.
 * @param {{filepath:string, filename:string, hasPrev:boolean, hasNext:boolean}} ctl
 */
function modernVideoControlsHtml(ctl) {
  _mpBuilding = true;
  try { return buildModernControls(ctl); } finally { _mpBuilding = false; }
}

function buildModernControls(ctl) {
  const silent = typeof playerIsSilent === 'function' && playerIsSilent();
  const vol = silent ? 0 : (typeof savedVolume === 'number' ? savedVolume : 1);
  const opt = (fn, ...args) => (typeof window[fn] === 'function' ? window[fn](...args) : '');

  const top = `
    <div class="mp-top" id="mpTop">
      ${mpButton('chev-left', 'Back to the library (Esc)', 'onclick="closeMediaPlayer()"')}
      <span class="mp-title" id="mpTitle">${mpEsc(ctl.filename || '')}</span>
      <span class="mp-sp"></span>
      <button type="button" class="mp-devchip" id="mpDevChip" hidden
        onclick="document.getElementById('lovenseChip')?.click()" title="Device connection and strength"></button>
      ${mpButton('panel', 'Info panel (I)', 'id="mpPanelBtn" onclick="toggleSidebar()"')}
      ${mpButton('pip', 'Mini player (Q)', 'onclick="minimizePlayer()"')}
      ${mpButton('close', 'Close (Esc)', 'onclick="closeMediaPlayer()"')}
    </div>`;

  const timeline = `
    <div class="mp-tl" id="mpTl">
      <canvas class="mp-ridge" id="mpRidge" aria-hidden="true"></canvas>
      <div class="mp-segs" id="mpSegs"></div>
      <div class="mp-abl" id="mpAbl"></div>
      <div class="mp-pins" id="mpPins"></div>
      <span class="mp-hovline" id="mpHovline"></span>
      <span class="mp-knob" id="mpKnob"></span>
      <div class="mp-scrub" id="mpScrub" aria-hidden="true">
        <span class="mp-scrub-th"><img alt="" id="mpScrubImg"></span>
        <span class="mp-scrub-lb"><b id="mpScrubTime">0:00</b><span class="mp-scrub-song" id="mpScrubSong"></span><span class="mp-scrub-note" id="mpScrubNote"></span></span>
      </div>
      <div class="mp-hint" id="mpHint" aria-hidden="true"></div>
      <div class="mp-hit" id="mpHit"></div>
    </div>`;

  const left = `
    <div class="mp-l">
      <span class="mp-time" onclick="toggleTotalTimeMode()" title="Click to switch between total and remaining"
        ><span id="currentTime">0:00</span> <span class="mp-time-tot">/ <span id="totalTime">0:00</span></span></span>
      <span class="mp-vsep"></span>
      ${opt('renderHotButton')}
      ${opt('renderDoneButton')}
      ${opt('renderFacesFrameButton', ctl.filepath)}
      ${opt('renderVibeButton')}
      ${mpBeatButton()}
      <button type="button" class="mp-ic mp-pill" id="speedDisplay" onclick="ModernDock.toggleSpeedList(event)"
        title="Speed (&lt; and &gt;)" aria-label="Speed" aria-haspopup="menu">1x</button>
    </div>`;

  const center = `
    <div class="mp-c">
      ${mpButton('prev-file', 'Previous file (P)', `id="mpPrev" onclick="playPreviousMedia()" ${ctl.hasPrev ? '' : 'disabled'}`)}
      ${mpButton('back-ten', 'Back 10 seconds (J)', 'id="mpBack10" onclick="skipVideo(-10)"')}
      <button type="button" class="mp-ic mp-play" id="playPauseBtn" onclick="togglePlay()" title="Play or pause (Space)" aria-label="Play">${mpIcon('play-fill')}</button>
      ${mpButton('fwd-ten', 'Forward 10 seconds (L)', 'id="mpFwd10" onclick="skipVideo(10)"')}
      ${mpButton('next-file', 'Next file (N)', `id="mpNext" onclick="playNextMedia()" ${ctl.hasNext ? '' : 'disabled'}`)}
    </div>`;

  const right = `
    <div class="mp-r">
      ${opt('renderAbLoopButton')}
      ${opt('renderRepeatButton')}
      ${opt('renderSubtitleButton')}
      <span class="mp-vol" id="mpVol">
        <button type="button" class="mp-ic" id="mpMuteBtn" onclick="toggleMute()" title="Mute (M)" aria-label="Mute">${mpIcon(silent ? 'mute' : 'volume')}</button>
        <input type="range" class="mp-vol-slider" id="volumeSlider" min="0" max="1.5" step="0.01" value="${vol}"
          oninput="setVolume(this.value)" aria-label="Volume" title="Volume (Up and Down)">
        <span id="volumeDisplay" hidden>${Math.round(vol * 100)}%</span>
      </span>
      ${mpButton('gear', 'Settings', 'id="mpGearBtn" onclick="ModernDock.toggleGear(event)" aria-haspopup="menu"')}
      ${mpButton('fullscreen', 'Full screen (F)', 'id="mpFullBtn" onclick="toggleFullscreen()"')}
    </div>`;

  return `${top}
    <div class="mp-dock" id="mpDock" data-fold="0" onclick="event.stopPropagation()">
      ${timeline}
      <div class="mp-row">${left}${center}${right}</div>
    </div>`;
}

/** The beat bar button (beats on a track), lit while the bar is on.
 *  beatbar.js keeps `beatbar-btn-on` and the title in step (syncButton). */
function mpBeatButton() {
  if (typeof window.toggleBeatBar !== 'function') return '';
  const on = !!(window.BeatBar && window.BeatBar.isEnabled && window.BeatBar.isEnabled());
  return `<button type="button" id="beatbarBtn" class="mp-ic mp-beat${on ? ' beatbar-btn-on' : ''}"
    onclick="toggleBeatBar()" title="${on ? 'Beat bar is on. Click to turn it off' : 'Beat bar is off. Click to turn it on'}"
    aria-label="Beat bar">${mpIcon('beat')}</button>`;
}

const ModernDock = (() => {
  const G = DockGeom;
  const SEG_GAP = 3;
  const PREVIEW_HALF = 110;      // half the 220 px scrub preview
  const NOTE_WINDOW = 2;         // seconds: a note this close shows in the preview

  let st = null;                 // per mounted dock; null when none is up
  let ro = null;                 // one ResizeObserver on the stage, kept for good

  const $ = (id) => document.getElementById(id);
  const overlay = () => $('mediaPlayerOverlay');
  const stage = () => document.querySelector('.media-player-main');

  function mounted() { return !!(st && st.dock && st.dock.isConnected); }

  function media() { return currentMediaState && currentMediaState.currentMediaData; }

  function videoEl() {
    const el = currentMediaState && currentMediaState.element;
    return el && el.tagName === 'VIDEO' ? el : null;
  }

  function duration() {
    const el = videoEl();
    if (el && isFinite(el.duration) && el.duration > 0) return el.duration;
    const m = media();
    return (m && Number(m.duration_seconds)) || 0;
  }

  const fmt = (t) => (typeof formatDuration === 'function' ? formatDuration(t) : '') || '0:00';
  // A-B points to the hundredth, decimals only when there is a fraction
  const fmtAb = (t) => G.formatPrecise(t);

  /* ── Mount / unmount ──────────────────────────────────────────────── */

  function mount() {
    unmount();
    const dock = $('mpDock');
    if (!dock) return;
    st = {
      dock,
      tl: $('mpTl'), segsEl: $('mpSegs'), hit: $('mpHit'), ridge: $('mpRidge'),
      knob: $('mpKnob'), hovline: $('mpHovline'), pins: $('mpPins'), abl: $('mpAbl'),
      scrub: $('mpScrub'), scrubImg: $('mpScrubImg'), hint: $('mpHint'),
      mediaId: media() ? media().id : null,
      songs: [], segs: [], lay: [], width: 0, dur: 0,
      notes: [], hots: [], heat: [],
      hover: false, hoverX: 0, hoverT: 0, dragging: false, litSeg: -1,
      menu: null, fold: -1, frameIdx: -1,
    };
    overlay()?.classList.add('mp-modern');

    bindTimeline();
    const el = videoEl();
    if (el) {
      st.onMeta = () => { rebuild(); syncAll(); applyFold(true); };
      el.addEventListener('loadedmetadata', st.onMeta);
      st.boundEl = el;
    }
    refreshMarks();
    rebuild();
    loadSongs();
    observeStage();
    applyFold();
    syncAll();
  }

  function unmount() {
    closeMenu();
    if (st) {
      if (st.boundEl && st.onMeta) st.boundEl.removeEventListener('loadedmetadata', st.onMeta);
      if (st.drag) cancelAnimationFrame(st.drag);
    }
    st = null;
    const ov = overlay();
    if (ov) ov.classList.remove('mp-modern', 'mp-previewing');
    placeToast();
  }

  /** Every button whose look follows state the dock does not own. */
  function syncAll() {
    if (!mounted()) return;
    if (typeof syncPlayPauseButton === 'function') syncPlayPauseButton();
    syncVolume();
    syncDevice();
    syncFullscreen();
    update();
  }

  /* ── Songs, marks, segments ───────────────────────────────────────── */

  async function loadSongs() {
    const id = st && st.mediaId;
    if (!id) return;
    let info = null;
    try {
      const r = await fetch(`/api/music/media/${id}`);
      if (r.ok) info = await r.json();
    } catch { info = null; }
    if (!mounted() || st.mediaId !== id) return;
    st.songs = info && Array.isArray(info.songs) ? info.songs : [];
    rebuild();
  }

  function parseJson(s, fallback) {
    if (typeof safeParseJSON === 'function') return safeParseJSON(s || '', fallback);
    try { return JSON.parse(s); } catch { return fallback; }
  }

  /** Notes, Hot marks and the heat ridge's curve, from the media row.
   *  Cheap, so it runs again whenever the pointer comes onto the bar (a
   *  note typed in the panel, a Hot just pressed). */
  function refreshMarks() {
    if (!st) return;
    const m = media();
    const dur = duration();
    const heat = (s) => { const a = parseJson(s, null); return Array.isArray(a) && a.length ? a : null; };
    st.notes = m ? G.noteMarks(parseJson(m.user_notes, [])) : [];
    st.hots = m ? G.hotMarks(heat(m.hot_heatmap), dur, m.last_hot_position) : [];
    st.heat = m ? G.smoothHeat(heat(m.watch_heatmap)) : [];
    drawPins();
    if (st.hover) drawRidge();
  }

  /** Segments from the songs and duration, then their px layout. */
  function rebuild() {
    if (!mounted()) return;
    st.dur = duration();
    st.segs = G.segments(st.dur, st.songs);
    st.segsEl.innerHTML = st.segs.map(s =>
      `<span class="mp-seg${s.song >= 0 ? ' song' : ''}"><i></i></span>`).join('');
    st.litSeg = -1;
    relayout(true);
    refreshMarks();
  }

  /** Re-place everything measured in px (segments, pins, knob, A-B). */
  function relayout(force) {
    if (!mounted()) return;
    const w = st.segsEl.clientWidth;
    if (!force && w === st.width) return;
    st.width = w;
    st.lay = G.layout(st.segs, w, SEG_GAP);
    const spans = st.segsEl.children;
    st.lay.forEach((b, i) => {
      if (!spans[i]) return;
      spans[i].style.left = b.x + 'px';
      spans[i].style.width = b.w + 'px';
    });
    drawPins();
    drawAb();
    update();
    if (st.hover) drawRidge();
  }

  const xOf = (t) => G.timeToX(t, st.segs, st.lay);

  function drawPins() {
    if (!mounted() || !st.dur) { if (st && st.pins) st.pins.innerHTML = ''; return; }
    const pins = [];
    for (const n of st.notes) if (n.t <= st.dur) pins.push(`<span class="mp-pin note" style="left:${xOf(n.t)}px"></span>`);
    for (const t of st.hots) pins.push(`<span class="mp-pin hot" style="left:${xOf(t)}px"></span>`);
    st.pins.innerHTML = pins.join('');
  }

  /** Played part, knob, ridge: on every timeupdate and after a seek. */
  function update() {
    if (!mounted() || !st.segs.length) return;
    const el = videoEl();
    const t = el ? el.currentTime || 0 : 0;
    const spans = st.segsEl.children;
    st.segs.forEach((s, i) => {
      const f = s.end > s.start ? Math.max(0, Math.min(1, (t - s.start) / (s.end - s.start))) : 0;
      const bar = spans[i] && spans[i].firstElementChild;
      if (bar) bar.style.width = (f * 100) + '%';
    });
    st.knob.style.left = xOf(t) + 'px';
    if (st.hover) drawRidge();
  }

  /* ── The heat ridge ───────────────────────────────────────────────── */

  function drawRidge() {
    const c = st && st.ridge;
    if (!c) return;
    const w = c.clientWidth, h = c.clientHeight;
    const curve = st.heat;
    if (!w || !h || !curve.length || !st.dur) { c.classList.add('empty'); return; }
    c.classList.remove('empty');
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const n = curve.length;
    const path = new Path2D();
    path.moveTo(0, h);
    path.lineTo(0, h - curve[0] * (h - 2));
    for (let i = 0; i < n; i++) path.lineTo(xOf(((i + 0.5) / n) * st.dur), h - curve[i] * (h - 2));
    path.lineTo(w, h - curve[n - 1] * (h - 2));
    path.lineTo(w, h);
    path.closePath();
    ctx.fillStyle = 'rgba(165, 180, 252, 0.30)';
    ctx.fill(path);
    const el = videoEl();
    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = 'rgba(199, 210, 254, 0.75)';
    ctx.fillRect(0, 0, el ? xOf(el.currentTime || 0) : 0, h);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.fillRect(st.hoverX - 3, 0, 6, h);
    ctx.restore();
  }

  /* ── Timeline pointer handling ────────────────────────────────────── */

  /** Px along the bar and the time there, for a pointer event. */
  function pointAt(e) {
    const r = st.segsEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    return { x, t: G.xToTime(x, st.segs, st.lay) };
  }

  function playable() {
    const el = videoEl();
    return el && isFinite(el.duration) && el.duration > 0 ? el : null;
  }

  function seekTo(t) {
    const el = playable();
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration, t));
    update();
    if (typeof showMediaControls === 'function') showMediaControls();
  }

  function abPending() {
    return typeof abLoopA !== 'undefined' && abLoopA !== null && abLoopB === null;
  }

  function bindTimeline() {
    const hit = st.hit;
    hit.addEventListener('pointerenter', (e) => {
      if (!st) return;
      st.hover = true;
      st.tl.classList.add('hover');
      refreshMarks();
      hoverAt(e);
    });
    hit.addEventListener('pointermove', (e) => {
      if (!st) return;
      if (!st.hover) { st.hover = true; st.tl.classList.add('hover'); }
      hoverAt(e);
      if (!st.dragging) return;
      st.pendingT = st.hoverT;
      if (st.drag) return;
      st.drag = requestAnimationFrame(() => {
        if (!st) return;
        st.drag = 0;
        if (st.dragging) seekTo(st.pendingT);
      });
    });
    hit.addEventListener('pointerleave', () => {
      if (!st || st.dragging) return;
      endHover();
    });
    hit.addEventListener('pointerdown', (e) => {
      if (!st || e.button !== 0) return;
      e.preventDefault();
      const p = pointAt(e);
      // Waiting for B: a click on the bar sets it there instead of seeking.
      if (abPending() && typeof setAbLoopEnd === 'function') {
        setAbLoopEnd(p.t);
        hoverAt(e);
        return;
      }
      st.dragging = true;
      st.tl.classList.add('dragging');
      try { hit.setPointerCapture(e.pointerId); } catch {}
      seekTo(p.t);
    });
    const end = (e) => {
      if (!st || !st.dragging) return;
      st.dragging = false;
      st.tl.classList.remove('dragging');
      try { hit.releasePointerCapture(e.pointerId); } catch {}
      // Released off the grab area: the hover ends now.
      const r = hit.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) endHover();
    };
    hit.addEventListener('pointerup', end);
    hit.addEventListener('pointercancel', end);
  }

  function endHover() {
    st.hover = false;
    st.tl.classList.remove('hover');
    if (st.litSeg >= 0) st.segsEl.children[st.litSeg]?.classList.remove('lit');
    st.litSeg = -1;
    st.scrub.classList.remove('on');
    st.hint.classList.remove('on');
    overlay()?.classList.remove('mp-previewing');
    drawAb();
  }

  function hoverAt(e) {
    if (!st.segs.length) return;
    const p = pointAt(e);
    st.hoverX = p.x;
    st.hoverT = p.t;
    st.hovline.style.left = p.x + 'px';

    // The segment under the pointer grows (and is outlined if it is a song)
    const i = G.segmentIndexAt(st.segs, p.t);
    if (i !== st.litSeg) {
      const spans = st.segsEl.children;
      if (st.litSeg >= 0) spans[st.litSeg]?.classList.remove('lit');
      spans[i]?.classList.add('lit');
      st.litSeg = i;
    }
    drawRidge();

    if (abPending()) {
      // Choosing B: a dashed span follows the pointer and the hint says where
      // B lands and how long the loop will be.
      st.scrub.classList.remove('on');
      overlay()?.classList.remove('mp-previewing');
      // A click lands B here, kept to the hundredth (setAbLoopEnd)
      const b = Math.round(p.t * 100) / 100;
      const len = Math.abs(b - abLoopA);
      st.hint.innerHTML = `Click to set B at <b>${mpEsc(fmtAb(b))}</b><small>Loop ${mpEsc(fmtAb(len))} · Esc to cancel</small>`;
      st.hint.classList.add('on');
      placeFloat(st.hint, p.x);
      drawAb();
      return;
    }
    st.hint.classList.remove('on');
    showPreview(p);
  }

  /** Keep a floating box (preview, hint) inside the bar's width. */
  function placeFloat(el, x) {
    const half = Math.min((el.offsetWidth || PREVIEW_HALF * 2) / 2, st.width / 2);
    el.style.left = Math.max(half, Math.min(st.width - half, x)) + 'px';
  }

  function showPreview(p) {
    const m = media();
    // The nearest of the five hover frames, when the file has them
    const img = st.scrubImg;
    if (m && m.id && st.dur) {
      const idx = G.scrubFrameIndex(p.t, st.dur);
      if (idx !== st.frameIdx) {
        st.frameIdx = idx;
        st.scrub.classList.remove('no-img');
        img.onerror = () => st && st.scrub.classList.add('no-img');
        img.src = typeof scrubUrl === 'function' ? scrubUrl(m.id, idx) : `/scrub/${m.id}/${idx}`;
      }
    } else {
      st.scrub.classList.add('no-img');
    }
    $('mpScrubTime').textContent = fmt(p.t);
    const seg = st.segs[G.segmentIndexAt(st.segs, p.t)];
    const song = seg && seg.song >= 0 ? st.songs[seg.song] : null;
    const songEl = $('mpScrubSong');
    if (song && (song.title || song.artist)) {
      songEl.innerHTML = `${mpIcon('audio')}${mpEsc(song.title || 'Unknown song')}${song.artist ? ` <small>· ${mpEsc(song.artist)}</small>` : ''}`;
      songEl.hidden = false;
    } else {
      songEl.hidden = true;
    }
    const note = G.noteNear(st.notes, p.t, NOTE_WINDOW);
    const noteEl = $('mpScrubNote');
    noteEl.hidden = !note;
    if (note) noteEl.textContent = note.text.length > 60 ? note.text.slice(0, 57) + '...' : note.text;
    st.scrub.classList.add('on');
    placeFloat(st.scrub, p.x);
    overlay()?.classList.add('mp-previewing');
  }

  /* ── A-B on the bar ───────────────────────────────────────────────── */

  /** The A marker, the pending span to the pointer, or the set loop. */
  function drawAb() {
    if (!mounted()) return;
    const parts = [];
    const a = typeof abLoopA !== 'undefined' ? abLoopA : null;
    const b = typeof abLoopB !== 'undefined' ? abLoopB : null;
    if (a !== null && st.dur) {
      const ax = xOf(a);
      if (b !== null) {
        const bx = xOf(b);
        parts.push(`<span class="mp-ab-span" style="left:${ax}px;width:${Math.max(2, bx - ax)}px"></span>`);
      } else {
        parts.push(`<span class="mp-amark" style="left:${ax}px"><b>A ${mpEsc(fmtAb(a))}</b><i></i></span>`);
        if (st.hover) {
          const lo = Math.min(ax, st.hoverX), hi = Math.max(ax, st.hoverX);
          parts.push(`<span class="mp-ab-go${st.hoverX < ax ? ' rev' : ''}" style="left:${lo}px;width:${hi - lo}px"></span>`);
        }
      }
    }
    st.abl.innerHTML = parts.join('');
  }

  /* ── Volume, device chip ──────────────────────────────────────────── */

  function syncVolume() {
    const btn = $('mpMuteBtn');
    if (!btn) return;
    const silent = typeof playerIsSilent === 'function' && playerIsSilent();
    btn.innerHTML = mpIcon(silent ? 'mute' : 'volume');
    btn.title = silent ? 'Unmute (M)' : 'Mute (M)';
    btn.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    btn.setAttribute('aria-pressed', silent ? 'true' : 'false');
    const slider = $('volumeSlider');
    if (slider) {
      const max = parseFloat(slider.max) || 1;
      const v = parseFloat(slider.value) || 0;
      slider.style.setProperty('--mp-vol', `${(v / max) * 100}%`);
    }
  }

  function syncDevice() {
    const chip = $('mpDevChip');
    if (!chip) return;
    const api = window.LovenseApi;
    const d = api && api.isConnected && api.getActiveDevice ? api.getActiveDevice() : null;
    chip.hidden = !d;
    if (d) chip.innerHTML = `<i></i>${mpEsc(d.nickname || d.name || 'Device')}${d.battery ? ` · ${d.battery}%` : ''}`;
    const vibe = $('vibeBtn');
    if (vibe && vibe.classList.contains('mp-ic')) vibe.hidden = !mpDeviceSetUp();
    if (st) applyFold(true);
  }

  /* ── Folding for narrow stages ────────────────────────────────────── */

  function present() {
    const shown = (id) => { const el = $(id); return !!(el && !el.hidden); };
    // An hour or more makes the time label longer ("1:01:40 / 1:02:36")
    const tot = $('totalTime');
    const hours = duration() >= 3600 || !!(tot && /\d:\d\d:\d\d/.test(tot.textContent));
    return { faces: shown('facesFrameBtn'), vibe: shown('vibeBtn'), beat: shown('beatbarBtn'), hours };
  }

  function applyFold(force) {
    if (!mounted()) return;
    const s = stage();
    const w = s ? s.clientWidth : window.innerWidth;
    const level = G.foldLevel(w, present());
    if (!force && level === st.fold) return;
    st.fold = level;
    st.dock.dataset.fold = String(level);
    // f1 .. fN: every level up to this one, so the CSS reads "at least N"
    for (let i = 1; i <= G.MAX_LEVEL; i++) st.dock.classList.toggle('f' + i, i <= level);
    if (st.menu && st.menu.kind === 'gear') renderGear(st.menu.view);
  }

  function observeStage() {
    const s = stage();
    if (!s || typeof ResizeObserver !== 'function') return;
    if (!ro) {
      ro = new ResizeObserver(() => {
        if (!mounted()) return;
        applyFold();
        relayout();
      });
    }
    ro.observe(s);
  }
  window.addEventListener('resize', () => { if (mounted()) { applyFold(); relayout(); } });

  /* ── Menus: the speed list and the gear menu ──────────────────────── */

  function menuOpen() { return !!(st && st.menu); }

  function closeMenu() {
    if (!st || !st.menu) return;
    st.menu.el.remove();
    st.menu.anchor?.classList.remove('open');
    st.menu = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onMenuKey, true);
  }

  function onOutside(e) {
    if (!st || !st.menu || e === st.menu.openEvent) return;
    if (st.menu.el.contains(e.target) || st.menu.anchor?.contains(e.target)) return;
    closeMenu();
  }

  /* Keys while a menu is open: Esc steps back or closes, Up / Down / Home /
     End move between rows, Enter / Space pick the row in focus. None of
     them reach the player (no volume change, no play / pause). */
  const MENU_KEYS = ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '];

  function onMenuKey(e) {
    if (!st || !st.menu || e === st.menu.openEvent || !MENU_KEYS.includes(e.key)) return;
    e.stopPropagation();
    e.preventDefault();
    const m = st.menu;
    if (e.key === 'Escape') {
      if (m.kind === 'gear' && m.view !== 'root') { renderGear('root'); return; }
      const anchor = m.anchor;
      const byKey = m.byKey;
      closeMenu();
      // Back to the button only for someone working from the keyboard; after
      // a mouse open, focus there would hold the controls up for good.
      if (byKey) anchor?.focus({ preventScroll: true });
      return;
    }
    const items = [...m.el.querySelectorAll('.mp-it:not([disabled])')];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Enter' || e.key === ' ') {
      if (at >= 0) items[at].click();
      return;
    }
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
    else next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  /** Open a menu box above `anchor`, its edge lined up with the anchor's. */
  function openMenu(kind, anchor, cls, ev) {
    closeMenu();
    if (!mounted() || !anchor) return null;
    const el = document.createElement('div');
    el.className = `mp-menu ${cls || ''}`;
    el.setAttribute('role', 'menu');
    st.dock.appendChild(el);
    // byKey: opened with Enter / Space (a click with no pointer behind it)
    const openEvent = ev || window.event || null;
    const byKey = !!(openEvent && openEvent.type === 'click' && openEvent.detail === 0) || keyNav;
    st.menu = { kind, el, anchor, view: 'root', acts: [], openEvent, byKey };
    anchor.classList.add('open');
    el.addEventListener('click', onMenuClick);
    // At once, so an Esc right after opening closes the menu rather than the
    // player; the event that opened the menu is skipped by both handlers.
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onMenuKey, true);
    return el;
  }

  /** Place the open menu over its anchor (after its contents are in). */
  function placeMenu(alignRight) {
    const { el, anchor } = st.menu;
    const d = st.dock.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    el.style.bottom = (d.bottom - a.top + 10) + 'px';
    const w = el.offsetWidth;
    let left = alignRight ? a.right - d.left - w : a.left - d.left + a.width / 2 - w / 2;
    left = Math.max(8, Math.min(d.width - w - 8, left));
    el.style.left = left + 'px';
  }

  function onMenuClick(e) {
    const it = e.target.closest('[data-act]');
    if (!it || it.disabled || !st || !st.menu) return;
    const fn = st.menu.acts[Number(it.dataset.act)];
    if (typeof fn === 'function') fn();
  }

  /* Speed list: every step the player has, Normal in words. */
  function toggleSpeedList(ev) {
    if (st && st.menu && st.menu.kind === 'speed') { closeMenu(); return; }
    const anchor = $('speedDisplay');
    const el = openMenu('speed', anchor, 'mp-menu-narrow', ev);
    if (!el) return;
    el.innerHTML = speedRows(true);
    placeMenu(false);
    if (st.menu.byKey) el.querySelector('.sel')?.focus({ preventScroll: true });
  }

  /** The speed rows (and the head and note when it is its own list). */
  function speedRows(own) {
    const acts = st.menu.acts = [];
    const back = own ? '' : backRow('Speed');
    const rows = SPEED_STEPS.map((s, i) => {
      acts[i] = () => { setSpeedIndex(i); closeMenu(); };
      const sel = i === currentSpeedIndex;
      return `<button type="button" class="mp-it${sel ? ' sel' : ''}" role="menuitemradio" aria-checked="${sel}" data-act="${i}"
        ><span class="mp-ck">${sel ? mpIcon('check') : ''}</span>${s === 1 ? 'Normal' : s + 'x'}</button>`;
    }).join('');
    return `${own ? '<div class="mp-mh">Speed</div>' : back}${rows}
      <div class="mp-sep"></div>
      <div class="mp-note">&lt; and &gt; go one step slower or faster. Scrolling on the label does the same.</div>`;
  }

  /* Gear menu: the set-once choices, plus whatever the row has folded away. */
  function toggleGear(ev) {
    if (st && st.menu && st.menu.kind === 'gear') { closeMenu(); return; }
    const el = openMenu('gear', $('mpGearBtn'), '', ev);
    if (!el) return;
    renderGear('root');
  }

  function backRow(title) {
    const i = st.menu.acts.length;
    st.menu.acts[i] = () => renderGear('root');
    return `<button type="button" class="mp-it mp-back" data-act="${i}">${mpIcon('chev-left')}${mpEsc(title)}</button>`;
  }

  /** One row. o: {icon, label, value, key, sub (a view to open), chev, act, disabled, radio} */
  function row(o) {
    const i = st.menu.acts.length;
    st.menu.acts[i] = o.sub ? () => renderGear(o.sub) : o.act;
    const right = o.key ? `<kbd>${mpEsc(o.key)}</kbd>` : '';
    const val = (o.value != null || o.sub || o.chev)
      ? `<span class="mp-v">${o.value != null ? mpEsc(o.value) : ''}${o.sub || o.chev ? mpIcon('chev-right') : ''}</span>` : '';
    const lead = o.radio !== undefined
      ? `<span class="mp-ck">${o.radio ? mpIcon('check') : ''}</span>`
      : (o.icon ? mpIcon(o.icon) : '');
    const role = o.radio !== undefined ? `role="menuitemradio" aria-checked="${!!o.radio}"` : 'role="menuitem"';
    return `<button type="button" class="mp-it${o.radio ? ' sel' : ''}" ${role} data-act="${i}" ${o.disabled ? 'disabled' : ''}
      >${lead}<span class="mp-l-txt">${mpEsc(o.label)}</span>${val || ''}${right}</button>`;
  }

  const SEP = '<div class="mp-sep"></div>';

  const SUB_LABELS = { off: 'Off', on: 'On', auto: 'Auto' };
  const END_LABELS = { off: 'Play next', all: 'Start over', one: 'Repeat file' };

  function deviceMode() {
    const cfg = window.LovenseSync && window.LovenseSync.cfg;
    return cfg && cfg.mode === 'pulse' ? 'pulse' : 'energy';
  }

  function renderGear(view) {
    if (!st || !st.menu) return;
    st.menu.view = view;
    st.menu.acts = [];
    const fold = st.fold;
    const ctl = currentMediaState.videoCtl || {};
    const after = (fn) => () => { closeMenu(); fn(); };
    let html = '';

    if (view === 'root') {
      const extra = [];
      if (fold >= 2) {
        extra.push(row({ icon: 'prev-file', label: 'Previous file', key: 'P', disabled: !ctl.hasPrev, act: after(() => playPreviousMedia()) }));
        extra.push(row({ icon: 'next-file', label: 'Next file', key: 'N', disabled: !ctl.hasNext, act: after(() => playNextMedia()) }));
      }
      if (fold >= 3) {
        const faces = $('facesFrameBtn');
        if (faces && !faces.hidden) extra.push(row({ icon: 'face-scan', label: 'Find faces', act: after(() => facesFindInFrame()) }));
        if (typeof window.toggleBeatBar === 'function') {
          const on = !!(window.BeatBar && window.BeatBar.isEnabled());
          extra.push(row({ icon: 'beat', label: 'Beat bar', value: on ? 'On' : 'Off', act: () => { window.toggleBeatBar(); renderGear('root'); } }));
        }
      }
      if (fold >= 5) {
        extra.push(row({ icon: 'back-ten', label: 'Back 10 seconds', key: 'J', act: () => skipVideo(-10) }));
        extra.push(row({ icon: 'fwd-ten', label: 'Forward 10 seconds', key: 'L', act: () => skipVideo(10) }));
      }
      if (fold >= 7) {
        const silent = typeof playerIsSilent === 'function' && playerIsSilent();
        extra.push(row({ icon: silent ? 'mute' : 'volume', label: silent ? 'Unmute' : 'Mute', key: 'M', act: () => { toggleMute(); renderGear('root'); } }));
        extra.push(row({ icon: document.fullscreenElement ? 'fullscreen-exit' : 'fullscreen', label: document.fullscreenElement ? 'Exit full screen' : 'Full screen', key: 'F', act: after(() => toggleFullscreen()) }));
      }
      if (fold >= 4) {
        if (mpDeviceSetUp() && typeof window.toggleVibe === 'function') {
          const on = !!(window.LovenseSync && window.LovenseSync.enabled);
          extra.push(row({ icon: 'vibe', label: 'Device sync', value: on ? 'On' : 'Off', act: after(() => window.toggleVibe()) }));
        }
        extra.push(row({ icon: 'timer', label: 'Speed', value: currentSpeed() === 1 ? 'Normal' : currentSpeed() + 'x', sub: 'speed' }));
      }
      if (extra.length) html += extra.join('') + SEP;

      if (typeof subtitleMode !== 'undefined') {
        html += row({ icon: 'cc', label: 'Subtitles', value: SUB_LABELS[subtitleMode] || 'Off', sub: 'subs' });
      }
      html += row({ icon: 'fit', label: 'Picture', value: isFillMode() ? 'Fit to window' : 'Actual size', sub: 'picture' });
      html += SEP;
      if (typeof window.openBeatBarSettings === 'function') {
        // Opens above the gear; its back arrow brings this menu back (beatbar.js)
        html += row({ icon: 'beat', label: 'Beat bar settings', chev: true, act: after(() => window.openBeatBarSettings({ anchor: $('mpGearBtn'), onBack: () => toggleGear() })) });
      }
      if (window.LovenseSync) {
        const on = !!window.LovenseSync.enabled;
        html += row({ icon: 'vibe', label: 'Device sync', value: on ? (deviceMode() === 'pulse' ? 'Beat pulses' : 'Follow energy') : 'Off', sub: 'device' });
      }
      html += row({ icon: 'repeat', label: 'When the file ends', value: END_LABELS[repeatMode()] || '', sub: 'end' });
      html += SEP;
      html += row({ icon: 'shuffle', label: 'Random file', key: 'R', act: after(() => playRandomMedia()) });
      if (typeof shortcutsOpen === 'function') html += row({ icon: 'keyboard', label: 'Keyboard shortcuts', key: '?', act: after(() => shortcutsOpen()) });
    } else if (view === 'speed') {
      html = speedRows(false).replace('<div class="mp-sep"></div>', SEP);
    } else if (view === 'subs') {
      html += backRow('Subtitles');
      const pick = (mode) => () => { if (typeof setSubtitleMode === 'function') setSubtitleMode(mode); renderGear('subs'); };
      html += row({ label: 'Off', radio: subtitleMode === 'off', act: pick('off') });
      html += row({ label: 'On', radio: subtitleMode === 'on', act: pick('on') });
      html += row({ label: 'Auto (English, only for other languages)', radio: subtitleMode === 'auto', act: pick('auto') });
      // The "make" and "fix" chips Classic shows by the CC button live here.
      const gen = $('subtitleGenBtn'), fix = $('subtitleFixBtn');
      const genShown = gen && gen.style.display !== 'none';
      const fixShown = fix && fix.style.display !== 'none';
      if (genShown || fixShown) html += SEP;
      if (genShown) {
        const busy = gen.textContent.trim() === '⏳';
        html += row({ icon: 'plus', label: busy ? 'Making subtitles...' : 'Make subtitles now', disabled: busy, act: after(() => subtitlesGenerate()) });
      }
      if (fixShown) html += row({ icon: 'refresh', label: 'Fix the lines around here', act: after(() => subtitlesFixHere()) });
    } else if (view === 'picture') {
      html += backRow('Picture');
      const set = (fill) => () => { if (isFillMode() !== fill) toggleFillMode(); renderGear('picture'); };
      html += row({ label: 'Actual size', radio: !isFillMode(), act: set(false) });
      html += row({ label: 'Fit to window', radio: isFillMode(), act: set(true) });
      html += `<div class="mp-note">Fit to window grows the picture to the edges without cropping.</div>`;
    } else if (view === 'device') {
      html += backRow('Device sync');
      const S = window.LovenseSync;
      if (typeof window.toggleVibe === 'function') {
        html += row({ icon: 'vibe', label: S.enabled ? 'Turn sync off' : 'Turn sync on', act: after(() => window.toggleVibe()) });
        html += SEP;
      }
      const mode = (m) => () => { S.saveCfg({ mode: m }); renderGear('device'); };
      html += row({ label: 'Follow energy', radio: deviceMode() === 'energy', act: mode('energy') });
      html += row({ label: 'Beat pulses', radio: deviceMode() === 'pulse', act: mode('pulse') });
      if ($('lovenseChip')) {
        html += SEP;
        html += row({ icon: 'gear', label: 'Connection and strength', act: after(() => $('lovenseChip').click()) });
      }
    } else if (view === 'end') {
      html += backRow('When the file ends');
      const set = (m) => () => { setRepeatMode(m); renderGear('end'); };
      html += row({ label: 'Play the next file', radio: repeatMode() === 'off', act: set('off') });
      html += row({ label: 'Play the next, start over at the end', radio: repeatMode() === 'all', act: set('all') });
      html += row({ label: 'Repeat this file', radio: repeatMode() === 'one', act: set('one') });
    }

    st.menu.el.innerHTML = html;
    placeMenu(true);
    const first = st.menu.el.querySelector('.mp-it:not([disabled])');
    if (first && (view !== 'root' || st.menu.byKey)) first.focus({ preventScroll: true });
  }

  /* ── Show / hide ──────────────────────────────────────────────────── */

  /** Anything that must keep the chrome up while the video plays. */
  function hold() {
    if (!mounted()) return false;
    if (st.menu || st.dragging || st.hover) return true;
    // The beat bar's settings panel, open over the video
    const bb = document.querySelector('.beatbar-overlay .beatbar-settings:not([hidden]), .beatbar-overlay .bbm-settings:not([hidden])');
    if (bb) return true;
    const ov = overlay();
    // Keyboard focus in the dock holds it only while someone is tabbing
    // through it: a button focused by a click, followed by shortcut keys,
    // must not keep the controls up (Chrome shows :focus-visible after any key).
    const active = document.activeElement;
    if (keyNav && ov && active && ov.contains(active) && active.closest('.mp-dock, .mp-top')) return true;
    const tip = document.getElementById('vaultTooltip');
    if (tip && tip.classList.contains('is-on') && !tip.hidden) {
      const target = ov && ov.querySelector('[aria-describedby="vaultTooltip"]');
      if (target) return true;
    }
    return false;
  }

  /**
   * Pointer moved over the stage: show, keep or hide by zone
   * (DockGeom.zoneDecision). Hiding past the hide line is immediate; the
   * cursor itself still follows the idle timer, so it never vanishes from
   * under a pointer that is moving.
   */
  function pointerMove(e) {
    const ov = overlay();
    const s = stage();
    if (!ov || !s) return;
    const r = s.getBoundingClientRect();
    const y = e.clientY - r.top;
    const decision = G.zoneDecision(y, r.height, ov.classList.contains('controls-visible'));
    if (decision === 'show') { showMediaControls(); return; }
    if (decision === 'keep') {
      if (ov.classList.contains('controls-visible')) showMediaControls();
      else revealCursorOnly();
      return;
    }
    const el = videoEl();
    if (!el || el.paused || hold()) { showMediaControls(); return; }
    ov.classList.remove('controls-visible');
    revealCursorOnly();
  }

  /* ── Toasts: in the stage, above the dock, clear of the beat bar ──── */

  const TOAST_GAP = 12;      // between the toast and what it sits above
  const TOAST_H = 48;        // a one-line toast with its padding, for the lane check

  /**
   * Where the shared #toast goes while the dock is up: centred on the stage
   * (the video area, so not under an open panel), its bottom above the dock
   * when the controls show (clear of the A marker and the hint), lower when
   * they are hidden, and moved above the beat bar lane if it would land on
   * it. The CSS reads --toast-x / --toast-bottom (css/player/player-modern.css);
   * without them it sits at the bottom centre of the window (the library).
   */
  function placeToast() {
    const root = document.documentElement;
    if (!mounted()) {
      root.style.removeProperty('--toast-x');
      root.style.removeProperty('--toast-bottom');
      return;
    }
    const s = stage();
    const r = s ? s.getBoundingClientRect() : { left: 0, width: innerWidth, bottom: innerHeight };
    const shown = overlay()?.classList.contains('controls-visible');
    // The dock's box starts at the timeline; the A marker and the hint ride
    // up to ~50 px above it.
    let y = shown ? st.dock.getBoundingClientRect().top - 50 : r.bottom - 24;
    const lane = document.querySelector('.beatbar-overlay .bbm-lane') || document.querySelector('.beatbar-overlay');
    if (lane && lane.getClientRects().length) {   // not display: none (fixed boxes have no offsetParent)
      const l = lane.getBoundingClientRect();
      if (l.height && l.bottom > y - TOAST_H && l.top < y) y = Math.min(y, l.top - TOAST_GAP);
    }
    root.style.setProperty('--toast-x', Math.round(r.left + r.width / 2) + 'px');
    root.style.setProperty('--toast-bottom', Math.max(TOAST_GAP, Math.round(innerHeight - y)) + 'px');
  }

  // Re-placed whenever a toast comes up, the controls show or hide, or the
  // window changes size.
  const toastWatch = new MutationObserver(() => placeToast());
  function watchToast() {
    const t = document.getElementById('toast');
    const ov = overlay();
    if (t) toastWatch.observe(t, { attributes: true, attributeFilter: ['class'] });
    if (ov) toastWatch.observe(ov, { attributes: true, attributeFilter: ['class'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchToast);
  else watchToast();
  window.addEventListener('resize', placeToast);

  /* ── Keyboard navigation vs. the mouse ────────────────────────────── */

  /* True from a Tab (or Shift+Tab) until the next pointer press. Shortcut
     keys leave it alone, so a click on a dock button followed by Space or an
     arrow does not count as keyboard navigation. */
  let keyNav = false;
  document.addEventListener('keydown', (e) => { if (e.key === 'Tab') keyNav = true; }, true);
  document.addEventListener('pointerdown', () => { keyNav = false; }, true);

  /* ── Full screen button follows the state ──────────────────────────── */

  function syncFullscreen() {
    const btn = $('mpFullBtn');
    if (!btn) return;
    const on = !!document.fullscreenElement;
    btn.innerHTML = mpIcon(on ? 'fullscreen-exit' : 'fullscreen');
    btn.title = on ? 'Exit full screen (F)' : 'Full screen (F)';
    btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  }
  document.addEventListener('fullscreenchange', syncFullscreen);

  /* ── The look switched with the player open ───────────────────────── */

  window.addEventListener('vault:layout-style', () => {
    const ov = overlay();
    if (!ov || !ov.classList.contains('active')) return;
    if (currentMediaState.miniMode || currentMediaState.type !== 'video') return;
    if (typeof rerenderVideoControls === 'function') rerenderVideoControls();
  });

  /* Scrolling on the speed label steps the speed, like < and >. */
  document.addEventListener('wheel', (e) => {
    if (!mounted() || !(e.target instanceof Element) || !e.target.closest('#speedDisplay.mp-pill')) return;
    e.preventDefault();
    cycleSpeed(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  return {
    mounted, mount, unmount, update, refreshMarks, rebuild, drawAb,
    syncVolume, syncDevice, toggleSpeedList, toggleGear, closeMenu, menuOpen,
    hold, pointerMove, applyFold,
  };
})();
