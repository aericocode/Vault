/* =========================================================================
   MINI PLAYER - the floating picture in a corner (picture-in-picture style).

   player-core.js moves the playing element in and out (minimizePlayer,
   maximizePlayer, closeMiniPlayer) and calls the two hooks here:
   miniPlayerOpen once the element is in the box, miniPlayerTeardown before
   it leaves. This file owns everything in between:

   - the box: the picture's own shape, resting in a window corner, the corner
     and width remembered (mini-geometry.js has the arithmetic)
   - drag anywhere to move, snapping to the nearest corner on release; a
     press that barely moves is still a click (show or hide the controls) and
     a double-click still goes back to the full player
   - the grip on the corner facing into the window resizes, shape kept
   - the controls fade in on hover or focus and out after 2 s idle
   - Pop out: the browser's own picture-in-picture, where it has one

   The keys (Space, Q, N, P, R, Esc) stay in app.js, unchanged.
   ========================================================================= */

const MINI_GEOM_KEY = 'vault_mini_geom';
const MINI_HIDE_MS = 2000;
const MINI_DRAG_THRESHOLD = 5;   // px a press can wander and still be a click
const MINI_AUDIO_ASPECT = 16 / 9;
const MINI_NARROW_W = 340;       // below this the volume slider folds away (mute only)

let _miniGeom = _miniLoadGeom();
let _miniHideTimer = null;
let _miniSuppressClick = false;
let _miniSeekBound = false;

function _miniLoadGeom() {
  try {
    return MiniGeom.geomFrom(JSON.parse(localStorage.getItem(MINI_GEOM_KEY) || 'null'));
  } catch {
    return MiniGeom.geomFrom(null);
  }
}

function _miniSaveGeom() {
  try { localStorage.setItem(MINI_GEOM_KEY, JSON.stringify(_miniGeom)); } catch {}
}

function _miniBox() { return document.getElementById('miniPlayer'); }

/** The element whose clock the mini player follows (a mix: its master). */
function miniMediaEl() {
  const box = document.getElementById('miniPlayerMedia');
  return box ? box.querySelector('[data-mix-master], video, audio') : null;
}

function _miniAspect(box) {
  if (box.classList.contains('mini-audio')) return MINI_AUDIO_ASPECT;
  const v = miniMediaEl();
  return v && v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 16 / 9;
}

/**
 * The page's visible area, less any scrollbar (innerWidth counts the
 * scrollbar, so a box placed by it would sit under it).
 */
function _miniViewport() {
  const de = document.documentElement;
  return { w: de.clientWidth || window.innerWidth, h: de.clientHeight || window.innerHeight };
}

/** True for a press on something that handles its own pointer (buttons, sliders, grip). */
function _miniOnControl(target) {
  return !!(target && target.closest && target.closest('button, input, .mini-seek, .mini-resize'));
}

/* ── Where the box sits ──────────────────────────────────────────────── */

/**
 * Put the box in its corner at its width. `animate` glides it there (the
 * snap after a drag), unless the system asks for less movement.
 */
function miniLayout({ animate = false } = {}) {
  const box = _miniBox();
  if (!box || !box.classList.contains('active')) return;
  const vp = _miniViewport();
  const r = MiniGeom.liftClear(
    MiniGeom.cornerRect(_miniGeom.corner, _miniGeom.w, _miniAspect(box), vp.w, vp.h),
    _miniGeom.corner, _miniPagerRect());
  // Control sizes step down with the box (css/mini-player.css), and a small
  // box drops secondary controls rather than shrinking them past use: the
  // volume slider first, then the 10 s buttons and the title, then Pop out.
  box.classList.toggle('mini-narrow', r.width < MINI_NARROW_W);
  box.classList.toggle('mini-compact', r.width < 400);
  box.classList.toggle('mini-tiny', r.width < 300 || r.height < 170);
  box.classList.toggle('mini-micro', r.width < 200);
  const glide = animate && !(typeof prefersReducedMotion === 'function' && prefersReducedMotion());
  box.classList.toggle('mini-snapping', glide);
  if (glide) {
    clearTimeout(box._snapTimer);
    box._snapTimer = setTimeout(() => {
      box.classList.remove('mini-snapping');
      _miniPlaceNeighbours();   // again where the glide ended
    }, 260);
  }
  box.dataset.corner = _miniGeom.corner;
  box.style.left = r.left + 'px';
  box.style.top = r.top + 'px';
  box.style.width = r.width + 'px';
  box.style.height = r.height + 'px';
  _miniPlaceNeighbours();
}

/** The Up next list (up-next.js) and the toasts (utils.js) follow the box, once it has moved. */
function _miniPlaceNeighbours() {
  if (typeof UpNext !== 'undefined') UpNext.positionPopover();
  if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
}

/**
 * The library's page buttons as one rect, while they are on screen, else
 * null: a box in a bottom corner sits above them instead of over Next.
 * Measured from the buttons, not the row, which is as wide as the grid.
 */
function _miniPagerRect() {
  const pager = document.getElementById('pagination');
  if (!pager || !pager.getClientRects().length || getComputedStyle(pager).visibility === 'hidden') return null;
  let o = null;
  for (const el of pager.children) {
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) continue;
    o = o ? { left: Math.min(o.left, b.left), top: Math.min(o.top, b.top), right: Math.max(o.right, b.right), bottom: Math.max(o.bottom, b.bottom) }
      : { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }
  return o;
}

// The page buttons come and go (a tab without the grid, a single page, the
// table view): the box follows. Watched once #pagination exists.
(function watchPagerForMini() {
  const relayout = () => { if (_miniBox()?.classList.contains('active')) miniLayout(); };
  const hook = () => {
    const pager = document.getElementById('pagination');
    if (!pager) return;
    if (typeof ResizeObserver === 'function') new ResizeObserver(relayout).observe(pager);
    new MutationObserver(relayout).observe(pager, { attributes: true, attributeFilter: ['class', 'style'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
  else hook();
})();

// The window changed size: back into a corner, still fitting. The remembered
// width is the user's choice and is left alone; only what is shown is clamped.
let _miniResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_miniResizeTimer);
  _miniResizeTimer = setTimeout(miniLayout, 100);
});

/* ── Controls: fade in on hover or focus, out after 2 s idle ─────────── */

function miniShowControls() {
  const box = _miniBox();
  if (!box) return;
  box.classList.add('mini-controls-on');
  clearTimeout(_miniHideTimer);
  _miniHideTimer = setTimeout(miniHideControls, MINI_HIDE_MS);
}

function miniHideControls() {
  const box = _miniBox();
  if (!box) return;
  clearTimeout(_miniHideTimer);
  // Not while the user is holding the seek bar or the volume slider.
  if (box.querySelector('.mini-seek.scrubbing') || box._sliderHeld) {
    _miniHideTimer = setTimeout(miniHideControls, MINI_HIDE_MS);
    return;
  }
  box.classList.remove('mini-controls-on');
}

/* ── What the controls show ─────────────────────────────────────────── */

function updateMiniPlayPause() {
  const btn = document.getElementById('miniPlayPause');
  const el = miniMediaEl();
  if (!btn || !el) return;
  const paused = el.paused;
  btn.innerHTML = vaultIconSwap(paused ? '▶︎' : '⏸︎', paused ? 'play' : 'pause');
  btn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  btn.classList.toggle('is-paused', paused);
}

function miniUpdateTimeline() {
  const el = miniMediaEl();
  if (!el) return;
  const dur = (isFinite(el.duration) && el.duration > 0) ? el.duration : 0;
  const fill = document.getElementById('miniSeekFill');
  const seek = document.getElementById('miniSeek');
  if (fill && !(seek && seek.classList.contains('scrubbing'))) {
    fill.style.width = dur ? ((el.currentTime / dur) * 100) + '%' : '0%';
  }
  const time = document.getElementById('miniTime');
  if (time) {
    const rate = Math.round((el.playbackRate || 1) * 100) / 100;
    time.textContent = `${formatDuration(el.currentTime) || '0:00'} / ${formatDuration(dur) || '0:00'}`
      + (rate !== 1 ? ` · ${rate}x` : '');
  }
}

function _miniVolumeMax() {
  return currentMediaState.gainNode ? 1.5 : 1;
}

function updateMiniVolume() {
  const btn = document.getElementById('miniMuteBtn');
  const slider = document.getElementById('miniVolSlider');
  const silent = playerIsSilent();
  if (btn) {
    btn.innerHTML = vaultIconSwap(silent ? '🔇' : '🔊', silent ? 'mute' : 'volume');
    btn.title = silent ? 'Unmute' : 'Mute';
    btn.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    btn.setAttribute('aria-pressed', silent ? 'true' : 'false');
  }
  if (slider && !slider.matches(':active')) {
    slider.max = String(_miniVolumeMax());
    slider.value = String(silent ? 0 : savedVolume);
  }
}

/* ── Control actions (onclick in db-viewer.html) ────────────────────── */

function miniSkip(seconds) {
  const el = miniMediaEl();
  if (!el || !isFinite(el.duration)) return;
  el.currentTime = Math.max(0, Math.min(el.duration, el.currentTime + seconds));
  miniUpdateTimeline();
}

/** The volume slider. Same store and curve as the full player's slider. */
function miniSetVolume(value) {
  const v = parseFloat(value);
  if (!isFinite(v)) return;
  savedVolume = v;
  // Reaching for the slider is how you unmute without finding the button.
  if (v > 0) {
    currentMediaState.previousVolume = v;
    savedMuted = false;
  }
  saveVolumePrefs();
  if (typeof applyVolume === 'function') applyVolume(sliderToVolume(v, _miniVolumeMax()));
  updateMiniVolume();
}

function miniToggleMute() {
  togglePlayerMute();
  if (typeof applyVolume === 'function') applyVolume(sliderToVolume(savedVolume, _miniVolumeMax()));
  updateMiniVolume();
}

/* ── Pop out (the browser's own picture-in-picture) ─────────────────── */

function _miniPipSupported(el) {
  return !!(document.pictureInPictureEnabled && el && el.tagName === 'VIDEO'
    && typeof el.requestPictureInPicture === 'function' && !el.disablePictureInPicture);
}

function _miniSetPipState(on) {
  const box = _miniBox();
  const btn = document.getElementById('miniPipBtn');
  const note = document.getElementById('miniPipNote');
  if (box) box.classList.toggle('mini-in-pip', on);
  if (note) note.hidden = !on;
  if (btn) {
    const label = on ? 'Bring the video back' : 'Pop out over other windows';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
}

function miniTogglePip() {
  const el = miniMediaEl();
  if (!_miniPipSupported(el)) return;
  if (document.pictureInPictureElement === el) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }
  el.requestPictureInPicture().catch((err) => {
    console.warn('[Mini] picture-in-picture failed:', err);
    if (typeof showToast === 'function') showToast('Could not pop out this video');
  });
}

/** Leave picture-in-picture if the mini player's element (or one being handed on) is in it. */
function _miniExitPip() {
  _miniPipCarryDone(true);
  const pipEl = document.pictureInPictureElement;
  const box = document.getElementById('miniPlayerMedia');
  if (pipEl && box && box.contains(pipEl)) document.exitPictureInPicture().catch(() => {});
  _miniSetPipState(false);
}

/* Next, Previous, Random or auto-advance while popped out. The next file is
   a new element, and asking for picture-in-picture normally needs a click.
   But while a picture-in-picture window is open the browser lets a page move
   it to another video without one, and it keeps the window open while the
   old element is torn down. So the old element stays in picture-in-picture
   (stopMediaElement leaves it there, see _pipCarry) until the new one knows
   its size, and then the window moves over. If that cannot happen (the next
   file is audio, it fails to load, the browser says no) the window closes,
   as it did before. */
const MINI_PIP_CARRY_MS = 15000;
let _miniPipCarryFrom = null;
let _miniPipCarryTimer = null;

/**
 * playMedia: is the mini player popped out? If so, keep the window for the
 * next file. The window's owner is whatever element holds it now: the
 * outgoing element, or, when the files change again before the last new one
 * had loaded (N pressed twice quickly), the element still being carried from.
 */
function miniPipCarry(oldEl) {
  const pipEl = document.pictureInPictureElement;
  if (!pipEl || (pipEl !== oldEl && pipEl !== _miniPipCarryFrom)) return false;
  if (_miniPipCarryFrom && _miniPipCarryFrom !== pipEl) _miniPipCarryDone(false);
  pipEl._pipCarry = true;
  _miniPipCarryFrom = pipEl;
  return true;
}

function _miniPipCarryDone(exit) {
  clearTimeout(_miniPipCarryTimer);
  const old = _miniPipCarryFrom;
  _miniPipCarryFrom = null;
  if (!old) return;
  delete old._pipCarry;
  if (exit && document.pictureInPictureElement === old) document.exitPictureInPicture().catch(() => {});
}

/** miniPlayerOpen: move a carried picture-in-picture window to the new element. */
function _miniPipCarryTo(el) {
  if (!_miniPipCarryFrom) return;
  if (!_miniPipSupported(el)) { _miniPipCarryDone(true); return; }
  const go = () => {
    if (!_miniPipCarryFrom || miniMediaEl() !== el) return;
    el.requestPictureInPicture()
      .then(() => _miniPipCarryDone(false))
      .catch((err) => {
        console.warn('[Mini] could not keep picture-in-picture for the next file:', err);
        _miniPipCarryDone(true);
      });
  };
  clearTimeout(_miniPipCarryTimer);
  _miniPipCarryTimer = setTimeout(() => _miniPipCarryDone(true), MINI_PIP_CARRY_MS);
  if (el.readyState >= 1) go();
  else el.addEventListener('loadedmetadata', go, { once: true });
}

/* ── Audio: its art, or the type icon ───────────────────────────────── */

function _miniShowArt(show) {
  const art = document.getElementById('miniAudioArt');
  const img = document.getElementById('miniAudioImg');
  if (!art || !img) return;
  art.hidden = !show;
  img.hidden = true;
  img.onload = img.onerror = null;
  img.removeAttribute('src');
  if (!show) return;
  const row = currentMediaState.currentMediaData;
  if (!row || typeof canShowThumb !== 'function' || !canShowThumb(row) || typeof staticThumbSrc !== 'function') return;
  img.onload = () => { img.hidden = false; };
  img.onerror = () => { img.hidden = true; };
  img.src = staticThumbSrc(row.id);
}

/* ── Open and teardown (player-core.js) ─────────────────────────────── */

/**
 * The element is in the box: wire its listeners and lay the box out.
 * `type` is the player's media type (video, mix or audio).
 */
function miniPlayerOpen(element, type) {
  const box = _miniBox();
  if (!box || !element) return;
  const el = miniMediaEl() || element;
  // Opened again without a teardown in between: never stack listeners.
  _miniUnbind(el);

  const handlers = {
    timeupdate: miniUpdateTimeline,
    durationchange: miniUpdateTimeline,
    ratechange: miniUpdateTimeline,
    loadedmetadata: () => { miniUpdateTimeline(); miniLayout(); },
    resize: () => miniLayout(),            // the picture's size became known or changed
    play: updateMiniPlayPause,
    pause: updateMiniPlayPause,
    ended: updateMiniPlayPause,
    volumechange: updateMiniVolume,
    enterpictureinpicture: () => _miniSetPipState(true),
    leavepictureinpicture: () => _miniSetPipState(false),
  };
  for (const [ev, fn] of Object.entries(handlers)) el.addEventListener(ev, fn);
  el._miniHandlers = handlers;

  _miniShowArt(type === 'audio');
  const pipBtn = document.getElementById('miniPipBtn');
  if (pipBtn) pipBtn.hidden = !(type === 'video' && _miniPipSupported(el));
  _miniSetPipState(document.pictureInPictureElement === el || !!_miniPipCarryFrom);
  _miniPipCarryTo(el);

  // attachSeekScrubbing lives in player-video.js, loaded after this file.
  if (!_miniSeekBound && typeof attachSeekScrubbing === 'function') {
    _miniSeekBound = true;
    attachSeekScrubbing(document.getElementById('miniSeek'), document.getElementById('miniSeekTrack'),
      miniMediaEl, { hideLabelOnRelease: true });
  }

  updateMiniPlayPause();
  miniUpdateTimeline();
  updateMiniVolume();
  miniLayout();
}

function _miniUnbind(el) {
  if (!el || !el._miniHandlers) return;
  for (const [ev, fn] of Object.entries(el._miniHandlers)) el.removeEventListener(ev, fn);
  delete el._miniHandlers;
}

/**
 * The element is about to leave the box (maximize, close, the next file).
 * keepPip: the next file takes over the picture-in-picture window
 * (miniPipCarry), so do not close it.
 */
function miniPlayerTeardown({ keepPip = false } = {}) {
  const el = miniMediaEl();
  if (!keepPip) _miniExitPip();
  _miniUnbind(el);
  _miniShowArt(false);
  const box = _miniBox();
  if (box) box.classList.remove('mini-controls-on', 'mini-dragging');
  clearTimeout(_miniHideTimer);
}

/* ── Pointer: drag, snap, click, double-click, resize, hover ────────── */

(function initMiniPlayerPointer() {
  const box = _miniBox();
  const grip = document.getElementById('miniResize');
  if (!box || !grip) return;

  let drag = null;
  let size = null;            // the resize grip's press (below)

  /* The browser's own drag-and-drop must never start from here: a fast
     flick could otherwise begin a native drag of whatever is under the
     pointer when it leaves the box (a library thumbnail). preventDefault on
     mousedown (not pointerdown) stops that and text selection while still
     letting mousedown reach the page's outside-click handlers; dragstart is
     cancelled too, for the box and for anything while a drag or resize of
     the box is under way. The volume slider and the seek bar keep their own
     mousedown. */
  box.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('button, input, .mini-seek')) return;
    e.preventDefault();
  });
  box.addEventListener('dragstart', (e) => e.preventDefault());
  document.addEventListener('dragstart', (e) => {
    if (drag || size) e.preventDefault();
  }, true);

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || _miniOnControl(e.target)) return;
    const rect = box.getBoundingClientRect();
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, left: rect.left, top: rect.top, w: rect.width, h: rect.height, moved: false };
    // Captured from the start: a quick flick's first move can already be
    // outside the box, and the release must come back here wherever it lands.
    try { box.setPointerCapture(e.pointerId); } catch {}
    // No preventDefault: mousedown must still reach the page's outside-click
    // handlers (popovers, tooltips). touch-action and user-select in the CSS,
    // and the picture taking no pointer events, keep the browser's own drag
    // and selection out of it. Taking focus here hands the keys back to the
    // mini player after the volume slider (or anything else) had it.
    try { box.focus({ preventScroll: true }); } catch {}
  });

  box.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && !drag) {
      miniShowControls();
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < MINI_DRAG_THRESHOLD) return;
      drag.moved = true;
      box.classList.add('mini-dragging');
      box.classList.remove('mini-snapping', 'mini-controls-on');
    }
    const vp = _miniViewport();
    const left = Math.max(0, Math.min(vp.w - drag.w, drag.left + dx));
    const top = Math.max(0, Math.min(vp.h - drag.h, drag.top + dy));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    try { box.releasePointerCapture(e.pointerId); } catch {}
    if (!moved) return;
    box.classList.remove('mini-dragging');
    const r = box.getBoundingClientRect();
    const vp = _miniViewport();
    _miniGeom = { ..._miniGeom, corner: MiniGeom.nearestCorner(r.left + r.width / 2, r.top + r.height / 2, vp.w, vp.h) };
    _miniSaveGeom();
    miniLayout({ animate: true });
    // The click that follows a drag is not a click.
    _miniSuppressClick = true;
    setTimeout(() => { _miniSuppressClick = false; }, 0);
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);

  box.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !drag) miniHideControls();
  });

  /* Clicks. A double-click on the picture or on play / pause goes back to the
     full player; the back and forward 10 s buttons are plain buttons (two
     quick clicks skip twice). What counts as a double is the system's own
     setting: the browser's click count (e.detail), not a fixed time here.
     The browser's dblclick event is not used because it needs both clicks on
     one element, and the first click of a double often lands on the picture
     (bringing the controls up) with the second on the play button under it.

     Play / pause acts at once, with no delay. If that click turns out to be
     the first of a double, the second one puts play / pause back the way it
     was before expanding, so the full player opens in the state the user had
     (maximizePlayer carries the paused state across). Keyboard presses
     (detail 0) are always single. */
  let playUndo = null;      // { el, paused } from the last single click on play
  const undoPlay = () => {
    const u = playUndo;
    playUndo = null;
    if (!u || u.el !== miniMediaEl() || u.el.paused === u.paused) return;
    if (u.paused) u.el.pause();
    else u.el.play().catch(() => {});
  };

  box.addEventListener('click', (e) => {
    if (_miniSuppressClick) return;
    const act = e.target.closest && e.target.closest('.mini-center [data-mini-act]');
    const kind = act ? act.dataset.miniAct : null;

    if (kind === 'back' || kind === 'fwd') {
      miniSkip(kind === 'back' ? -10 : 10);
      return;
    }
    // Previous and next file: the same queue moves as P and N (Up next first).
    if (kind === 'prev' || kind === 'next') {
      if (kind === 'prev') playPreviousMedia(); else playNextMedia();
      return;
    }

    if (kind === 'play') {
      if (e.detail >= 2) { undoPlay(); maximizePlayer(); return; }
      const el = miniMediaEl();
      playUndo = el ? { el, paused: el.paused } : null;
      miniTogglePlay();
      return;
    }

    // Top row, seek bar, grip: their own business.
    if (_miniOnControl(e.target)) return;

    // The picture.
    if (e.detail >= 2) { undoPlay(); maximizePlayer(); return; }
    playUndo = null;
    // A click (or a tap) shows or hides the controls.
    if (box.classList.contains('mini-controls-on')) miniHideControls();
    else miniShowControls();
  });

  // Keyboard users: focus on a control brings the controls up (the CSS keeps
  // them up while a control has visible focus). The box itself taking focus
  // on a press is not that.
  box.addEventListener('focusin', (e) => { if (e.target !== box) miniShowControls(); });

  // Hold the controls up while the volume slider is being dragged.
  const slider = document.getElementById('miniVolSlider');
  if (slider) {
    slider.addEventListener('pointerdown', () => { box._sliderHeld = true; });
    const release = () => { box._sliderHeld = false; };
    // Done with the slider by pointer: give focus back to the box, or app.js
    // (which ignores keys typed into inputs) would skip Space, Q and Esc.
    slider.addEventListener('pointerup', () => {
      release();
      try { box.focus({ preventScroll: true }); } catch {}
    });
    slider.addEventListener('pointercancel', release);
    slider.addEventListener('change', release);
  }

  // The resize grip, on the corner facing into the window. The snapped
  // corner stays where it is; the shape stays the picture's.
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    size = { id: e.pointerId, x: e.clientX, y: e.clientY, w: box.getBoundingClientRect().width };
    try { grip.setPointerCapture(e.pointerId); } catch {}
    box.classList.add('mini-resizing');
    box.classList.remove('mini-snapping');
    e.stopPropagation();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!size || e.pointerId !== size.id) return;
    const aspect = _miniAspect(box);
    const w = MiniGeom.aspectResize(size.w, e.clientX - size.x, e.clientY - size.y, _miniGeom.corner, aspect);
    const vp = _miniViewport();
    _miniGeom = { ..._miniGeom, w: MiniGeom.clampWidth(w, aspect, vp.w, vp.h) };
    miniLayout();
  });
  const endSize = (e) => {
    if (!size || e.pointerId !== size.id) return;
    size = null;
    try { grip.releasePointerCapture(e.pointerId); } catch {}
    box.classList.remove('mini-resizing');
    _miniSaveGeom();
  };
  grip.addEventListener('pointerup', endSize);
  grip.addEventListener('pointercancel', endSize);
  grip.addEventListener('click', (e) => e.stopPropagation());
})();
