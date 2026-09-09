// =========================================================================
// PLAYER VIDEO - Video player rendering and controls
// =========================================================================

function renderVideoPlayer(content, controlsContainer, fileUrl, filepath, filename, hasPrev, hasNext) {
  content.innerHTML = `
    <video id="mediaVideo" onerror="handleMediaError('${filepath.replace(/'/g, "\\'")}')">
      Your browser doesn't support video playback.
    </video>
  `;
  
  // Left controls: Volume
  const leftControls = `
    <div class="volume-control">
      <button onclick="toggleMute()" id="muteBtn" class="control-btn" title="Mute (M)">🔊</button>
      <input type="range" class="volume-slider" id="volumeSlider" min="0" max="1.5" step="0.01" value="${playerIsSilent() ? 0 : savedVolume}" oninput="setVolume(this.value)">
      <span class="volume-display" id="volumeDisplay">${Math.round((playerIsSilent() ? 0 : savedVolume) * 100)}%</span>
    </div>
  `;
  
  // Right controls: Fullscreen only (speed moved down to the playback row so
  // the center Prev/Random/Info/Next stays in a fixed spot across media types)
  const rightControls = `
    ${renderFillButton()}
    <button onclick="toggleFullscreen()" class="control-btn" title="Fullscreen (F)">⛶</button>
  `;

  const speedControls = renderSpeedControls();

  controlsContainer.innerHTML = `
    <div class="player-controls-wrapper video-controls">
      <div class="video-progress-row">
        ${renderProgressTimes('start')}
        <div class="video-progress-wrapper" id="videoProgressWrapper" onmouseenter="drawActivityBar()">
          <canvas class="video-activity" id="videoActivityBar" height="26" aria-hidden="true"></canvas>
          <div class="video-progress" id="videoProgress">
            <div class="video-progress-bar" id="videoProgressBar" style="width: 0%"></div>
          </div>
        </div>
        ${renderProgressTimes('end')}
      </div>
      <div class="video-playback-row">
        <div class="playback-controls">
          ${renderSkipButton(-10, 'skipVideo(-10)', '-10s (J)')}
          ${renderSkipButton(-5, 'skipVideo(-5)', '-5s (←)')}
          <button onclick="togglePlay()" id="playPauseBtn" class="play-pause-btn" title="Play/Pause (Space)">▶</button>
          ${renderSkipButton(5, 'skipVideo(5)', '+5s (→)')}
          ${renderSkipButton(10, 'skipVideo(10)', '+10s (L)')}
        </div>
      </div>
      <div class="video-extras-row">
        <div class="pr-side pr-left">
          ${typeof renderAbLoopButton === 'function' ? renderAbLoopButton() : ''}
          ${typeof renderSubtitleButton === 'function' ? renderSubtitleButton() : ''}
        </div>
        <div class="pr-center">
          ${speedControls}
          ${typeof renderRepeatButton === 'function' ? renderRepeatButton() : ''}
        </div>
        <div class="pr-side pr-right">
          ${typeof renderHotButton === 'function' ? renderHotButton() : ''}
          ${renderDoneButton()}
        </div>
      </div>
      ${generateUnifiedControlBar(leftControls, rightControls, hasPrev, hasNext)}
    </div>
  `;
  
  const video = document.getElementById('mediaVideo');
  currentMediaState.element = video;

  // Repeat preference (A-B loop takes over while active)
  video.loop = typeof isRepeatOne === 'function' ? isRepeatOne() : false;

  // Subtitles (3-state CC toggle resolves which track, if any)
  if (typeof applySubtitlesFor === 'function' && currentMediaState.currentMediaData) {
    applySubtitlesFor(currentMediaState.currentMediaData);
  }

  // Setup Web Audio API for volume boost
  setupAudioBoost(video);
  
  // Apply saved volume (savedVolume is slider position, needs curve)
  const max = currentMediaState.gainNode ? 1.5 : 1;
  applyVolume(sliderToVolume(savedVolume, max));   // also carries the mute flag over
  updateVolumeDisplay(playerIsSilent() ? 0 : savedVolume, max);

  // Playback speed is a session preference, not a per-file one — the freshly
  // rendered chrome always says "1x", so re-apply and re-label it here.
  applySpeedTo(video);
  updateSpeedDisplay();

  video.addEventListener('loadedmetadata', () => {
    updateTotalTimeLabel();
    // Init AB loop overlay (needed if loop was somehow preserved)
    if (typeof updateAbLoopOverlay === 'function') updateAbLoopOverlay();
  });
  
  video.addEventListener('timeupdate', () => {
    const progressBar = document.getElementById('videoProgressBar');
    const currentTimeEl = document.getElementById('currentTime');
    if (progressBar) {
      const progress = (video.currentTime / video.duration) * 100;
      progressBar.style.width = progress + '%';
    }
    if (currentTimeEl) {
      // formatDuration(0/NaN) returns '' — keep the label readable while
      // the stream is still at 0:00 (or stalled)
      currentTimeEl.textContent = formatDuration(video.currentTime) || '0:00';
    }
    updateTotalTimeLabel();
    // AB loop check
    if (typeof checkAbLoop === 'function') {
      checkAbLoop(video);
    }
  });
  
  video.addEventListener('play', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '⏸';
    // Playback resuming has to re-arm the idle hide: the chrome now stays put
    // while paused, so without this a pause-then-play from the native element
    // or from autoplay would leave the bar up for good.
    if (typeof scheduleHideControls === 'function') scheduleHideControls();
  });
  
  video.addEventListener('pause', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '▶';
  });
  
  video.addEventListener('ended', () => {
    const btn = document.getElementById('playPauseBtn');
    if (btn) btn.textContent = '▶';
    if (typeof autoAdvanceOnEnded === 'function') autoAdvanceOnEnded();
  });

  video.addEventListener('click', handleVideoClick);
  video.addEventListener('dblclick', handleVideoDoubleClick);

  attachSeekScrubbing(
    document.getElementById('videoProgressWrapper'),
    document.getElementById('videoProgress'),
    () => currentMediaState.element
  );

  // Set volume slider max based on whether audio boost is available
  const volumeSlider = document.getElementById('volumeSlider');
  if (volumeSlider) {
    volumeSlider.max = currentMediaState.gainNode ? 1.5 : 1;
  }

  // The source comes from the server's playback decision (native file, or an
  // HLS playlist FFmpeg fills in on demand), so it is set asynchronously —
  // hence no src attribute above. Everything else about the element was set up
  // before this point and does not care where the bytes come from.
  attachPlaybackSource(
    video,
    currentMediaState.currentMediaData?.id || null,
    filepath,
    fileUrl,
  );
}

/* ── Watch-activity curve (YouTube "most replayed" style) ──────────────────
   Drawn over the seek bar on hover from the item's 100-bucket watch heatmap
   (real watch-seconds per 1% of duration), plus 🔥/💦 marker heatmaps tinted
   on top — denser clusters of marks glow more vibrantly. Re-drawn on each hover
   so the current session's flushed activity shows up live. */
function _activityHeat(str) {
  try { const a = JSON.parse(str || 'null'); return Array.isArray(a) && a.length ? a : null; }
  catch { return null; }
}

function drawActivityBar() {
  const canvas = document.getElementById('videoActivityBar');
  const media = currentMediaState.currentMediaData;
  if (!canvas || !media) return;

  const watch = _activityHeat(media.watch_heatmap);
  const hot = _activityHeat(media.hot_heatmap);
  const done = _activityHeat(media.done_heatmap);
  const watchMax = watch ? Math.max(...watch) : 0;
  const hotMax = hot ? Math.max(...hot) : 0;
  const doneMax = done ? Math.max(...done) : 0;

  const el = currentMediaState.element;
  const dur = (el && ['VIDEO', 'AUDIO'].includes(el.tagName) && isFinite(el.duration) && el.duration > 0)
    ? el.duration : (media.duration_seconds || 0);

  // Fall back to the single last position when no per-event heatmap exists yet
  // (pre-migration data), so those tints don't vanish.
  const hasHot = hotMax > 0 || media.last_hot_position > 0;
  const hasDone = doneMax > 0 || media.last_done_position > 0;
  if (watchMax <= 0 && !hasHot && !hasDone) { canvas.style.display = 'none'; return; }
  canvas.style.display = '';

  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = canvas.height;
  if (canvas.width !== w) canvas.width = w;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // Watch curve (only when there's real watch activity). Kept as a Path2D of the
  // area UNDER the line so the marker tints below can be clipped to it — coloring
  // then only appears where activity exists, and re-follows the curve on every
  // redraw as the activity line updates.
  let curvePath = null;
  if (watchMax > 0) {
    const n = watch.length;
    const smooth = watch.map((v, i) =>
      ((watch[i - 1] || 0) + v + (watch[i + 1] || 0)) / ((i > 0 ? 1 : 0) + 1 + (i < n - 1 ? 1 : 0)));
    const smax = Math.max(...smooth);
    curvePath = new Path2D();
    curvePath.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - (smooth[i] / smax) * (h - 3);
      curvePath.lineTo(x, y);
    }
    curvePath.lineTo(w, h);
    curvePath.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
    ctx.fill(curvePath);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke(curvePath);
  }

  // 🔥 Hot (orange) / 💦 Done (blue) marker heatmaps — one soft band per bucket,
  // alpha scaled by that bucket's event count vs. the item's peak. Clipped to the
  // area under the activity line, so a marker where little was watched only tints
  // the thin sliver beneath the curve (full height only when there's no curve).
  if (curvePath) { ctx.save(); ctx.clip(curvePath); }
  _drawMarkerHeat(ctx, done, doneMax, w, h, '80,150,255', dur, media.last_done_position);
  _drawMarkerHeat(ctx, hot, hotMax, w, h, '255,140,0', dur, media.last_hot_position);
  if (curvePath) ctx.restore();
}

function _paintBand(ctx, x, halfW, h, rgb, alpha) {
  const g = ctx.createLinearGradient(x - halfW, 0, x + halfW, 0);
  g.addColorStop(0, `rgba(${rgb},0)`);
  g.addColorStop(0.5, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - halfW, 0, halfW * 2, h);
}

function _drawMarkerHeat(ctx, heat, max, w, h, rgb, dur, lastPos) {
  if (heat && max > 0) {
    const n = heat.length;
    const halfW = Math.max(4, (w / n) * 1.3);
    for (let i = 0; i < n; i++) {
      const c = heat[i];
      if (!(c > 0)) continue;
      const x = ((i + 0.5) / n) * w;
      _paintBand(ctx, x, halfW, h, rgb, 0.2 + 0.6 * (c / max));  // vibrancy ∝ event count
    }
  } else if (lastPos > 0 && dur > 0) {
    // Pre-migration item (only a single last position stored) — one band there
    _paintBand(ctx, (Math.min(lastPos, dur) / dur) * w, Math.max(6, w * 0.02), h, rgb, 0.6);
  }
}

// Video control functions
function togglePlay() {
  const video = currentMediaState.element;
  if (!video) return;
  
  if (currentMediaState.audioContext && currentMediaState.audioContext.state === 'suspended') {
    currentMediaState.audioContext.resume();
  }
  
  if (video.paused) {
    video.play().catch(() => {}); // rejected when a teardown aborts the load
    scheduleHideControls();
  } else {
    video.pause();
    showMediaControls();
  }
}

function skipVideo(seconds) {
  const video = currentMediaState.element;
  // duration is NaN until metadata loads — assigning NaN to currentTime throws
  if (!video || !isFinite(video.duration) || video.duration <= 0) return;

  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
  showMediaControls();
}

function seekVideo(event) {
  const video = currentMediaState.element;
  if (!video || !isFinite(video.duration) || video.duration <= 0) return;

  const bar = event.currentTarget;
  const rect = bar.getBoundingClientRect();
  const percent = (event.clientX - rect.left) / rect.width;
  video.currentTime = percent * video.duration;
}

/* ── Seek bar scrubbing + hover time ──────────────────────────────────────
   Shared by the video and audio players (this file loads first, so audio can
   call it). Click-only seeking made you guess and re-click; here the bar
   follows the pointer while the button is held, and hovering shows the time
   under the cursor before you commit to it.

   Everything is bound to the WRAPPER, not the bar, so the activity canvas on
   top of it and the wrapper's own padding all seek too. Pointer capture keeps
   the drag alive when the pointer wanders off the bar mid-scrub.

   @param {HTMLElement} wrapper - .video-progress-wrapper
   @param {HTMLElement} progress - the .video-progress bar (defines the geometry)
   @param {Function} getMediaEl - returns the <video>/<audio> to drive
   @param {Object} [opts] - { hideLabelOnRelease } drops the time pill as soon
     as the button comes back up instead of waiting for the pointer to leave.
     For a bar only a few pixels tall the pointer often never leaves, so the
     pill would just sit there after a click. */
function attachSeekScrubbing(wrapper, progress, getMediaEl, opts) {
  if (!wrapper || !progress) return;

  const label = document.createElement('div');
  label.className = 'seek-hover-time';
  wrapper.appendChild(label);

  let scrubbing = false;
  let pendingX = null;
  let frame = null;

  // Fraction 0..1 of the way along the bar for a client x
  const fractionAt = (clientX) => {
    const rect = progress.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  // Same guard as the click-seek had: duration is NaN until metadata lands,
  // and assigning NaN to currentTime throws.
  const playable = () => {
    const el = getMediaEl();
    return (el && isFinite(el.duration) && el.duration > 0) ? el : null;
  };

  const showLabel = (clientX) => {
    const el = playable();
    if (!el) { label.classList.remove('visible'); return; }
    const rect = progress.getBoundingClientRect();
    const f = fractionAt(clientX);
    label.textContent = formatDuration(f * el.duration) || '0:00';
    // Clamp so the pill never hangs off either end of the bar
    const half = label.offsetWidth / 2;
    const x = Math.max(half, Math.min(rect.width - half, f * rect.width));
    label.style.left = x + 'px';
    label.classList.add('visible');
  };

  const seekTo = (clientX) => {
    const el = playable();
    if (!el) return;
    const f = fractionAt(clientX);
    el.currentTime = f * el.duration;
    // Paint the bar from the pointer straight away — waiting for timeupdate
    // makes the bar lag a fast drag by a visible amount.
    const bar = progress.firstElementChild;
    if (bar) bar.style.width = (f * 100) + '%';
    if (typeof showMediaControls === 'function') showMediaControls();
  };

  wrapper.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    scrubbing = true;
    wrapper.classList.add('scrubbing');
    try { wrapper.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
    seekTo(e.clientX);
    showLabel(e.clientX);
  });

  wrapper.addEventListener('pointermove', (e) => {
    showLabel(e.clientX);
    if (!scrubbing) return;
    // Coalesce moves onto animation frames — a drag fires far more pointermove
    // events than the media element can usefully seek to.
    pendingX = e.clientX;
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (scrubbing && pendingX !== null) seekTo(pendingX);
    });
  });

  const endScrub = (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    pendingX = null;
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    wrapper.classList.remove('scrubbing');
    try { wrapper.releasePointerCapture(e.pointerId); } catch {}
    if (opts && opts.hideLabelOnRelease) label.classList.remove('visible');
  };

  wrapper.addEventListener('pointerup', endScrub);
  wrapper.addEventListener('pointercancel', endScrub);

  wrapper.addEventListener('pointerleave', () => {
    label.classList.remove('visible');
  });
}

function toggleMute() {
  const video = currentMediaState.element;
  if (!video) return;

  togglePlayerMute();   // owns savedMuted/savedVolume and the store

  const max = currentMediaState.gainNode ? 1.5 : 1;
  applyVolume(sliderToVolume(savedVolume, max));   // sets .muted and the button

  // While muted the slider reads zero, which is what the ear is getting.
  const shown = playerIsSilent() ? 0 : savedVolume;
  const slider = document.getElementById('volumeSlider');
  if (slider) slider.value = shown;
  updateVolumeDisplay(shown, max);
}

function setVolume(value) {
  const video = currentMediaState.element;
  if (!video) return;

  value = parseFloat(value);
  const max = currentMediaState.gainNode ? 1.5 : 1;
  const actualVolume = sliderToVolume(value, max);

  savedVolume = value; // save the slider position, not the curved value
  // Reaching for the slider is how you unmute without finding the button.
  if (value > 0) {
    currentMediaState.previousVolume = value;
    savedMuted = false;
  }
  saveVolumePrefs();
  applyVolume(actualVolume);
  updateVolumeDisplay(value, max);
}

function applyVolume(value) {
  const video = currentMediaState.element;
  if (!video) return;

  if (currentMediaState.gainNode) {
    currentMediaState.gainNode.gain.value = value;
    video.volume = 1;
  } else {
    video.volume = Math.min(1, value);
  }

  video.muted = playerIsSilent();
  updateMuteButton();
}

function updateVolumeDisplay(sliderValue, max) {
  const display = document.getElementById('volumeDisplay');
  const slider = document.getElementById('volumeSlider');
  
  if (display) {
    const percent = Math.round(sliderValue * 100);
    display.textContent = percent + '%';
    
    if (sliderValue > 1) {
      display.classList.add('boosted');
      if (slider) slider.classList.add('boosted');
    } else {
      display.classList.remove('boosted');
      if (slider) slider.classList.remove('boosted');
    }
  }
}

// Handle single click on video
function handleVideoClick(e) {
  e.stopPropagation();
  clearTimeout(currentMediaState.clickTimeout);
  
  currentMediaState.clickTimeout = setTimeout(() => {
    if (!currentMediaState.isDoubleClick) {
      togglePlay();
    }
    currentMediaState.isDoubleClick = false;
  }, 250);
}

// Handle double-click on video
function handleVideoDoubleClick(e) {
  e.stopPropagation();
  currentMediaState.isDoubleClick = true;
  clearTimeout(currentMediaState.clickTimeout);
  toggleFullscreen();
}

// Setup Web Audio API for volume boost beyond 100%
function setupAudioBoost(video) {
  if (window.location.protocol === 'file:' || video.src.startsWith('file://')) {
    console.log('Using native audio (file:// protocol)');
    currentMediaState.audioContext = null;
    currentMediaState.gainNode = null;
    currentMediaState.mediaSource = null;
    return;
  }
  
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    const resumeAudio = () => {
      if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
          console.log('AudioContext resumed');
        });
      }
    };
    
    resumeAudio();
    video.addEventListener('play', resumeAudio, { once: true });
    
    const source = audioContext.createMediaElementSource(video);
    const gainNode = audioContext.createGain();
    
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    currentMediaState.audioContext = audioContext;
    currentMediaState.gainNode = gainNode;
    currentMediaState.mediaSource = source;
    
  } catch (e) {
    console.warn('Web Audio API not available for volume boost:', e);
    currentMediaState.audioContext = null;
    currentMediaState.gainNode = null;
    currentMediaState.mediaSource = null;
  }
}

// =========================================================================
// SKIP BUTTONS - Shared markup for video / audio / mix players
// =========================================================================

/**
 * One skip button: a rotate arrow with the seconds printed inside it.
 * Negative seconds draw the counter-clockwise (rewind) arrow.
 *
 * @param {number} seconds - signed skip amount, e.g. -10 or 5
 * @param {string} onclickExpr - inline handler body, e.g. "skipVideo(-10)"
 * @param {string} title - tooltip, e.g. "-10s (J)"
 */
function renderSkipButton(seconds, onclickExpr, title) {
  const back = seconds < 0;
  const arrow = back
    ? '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v5h5"/>'
    : '<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v5h-5"/>';
  return `<button onclick="${onclickExpr}" class="control-btn skip-btn" title="${title}">
            <span class="skip-icon">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor"
                   stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${arrow}</svg>
              <span class="skip-num">${Math.abs(seconds)}</span>
            </span>
          </button>`;
}

// =========================================================================
// PROGRESS TIMES - elapsed on the left of the bar, total/remaining on the right
// =========================================================================

/* Persisted per browser, not per file: whichever way you last read the right
   hand number is the way you want to read the next one too. */
let showRemainingTime = (() => {
  try { return localStorage.getItem('vault.player.showRemaining') === '1'; } catch { return false; }
})();

/**
 * The time label that sits at one end of the seek bar.
 * @param {'start'|'end'} side
 */
function renderProgressTimes(side) {
  if (side === 'start') {
    return '<span class="progress-time" id="currentTime">0:00</span>';
  }
  return `<span class="progress-time progress-time-total" id="totalTime"
                onclick="toggleTotalTimeMode()"
                title="Click to switch between total and remaining">0:00</span>`;
}

/** Flip the right hand label between total duration and time remaining. */
function toggleTotalTimeMode() {
  showRemainingTime = !showRemainingTime;
  try { localStorage.setItem('vault.player.showRemaining', showRemainingTime ? '1' : '0'); } catch {}
  updateTotalTimeLabel();
}

/**
 * Repaint the right hand time label. Called from loadedmetadata and from every
 * timeupdate (remaining has to tick down), shared by video, audio and mix.
 */
function updateTotalTimeLabel(el) {
  el = el || document.getElementById('totalTime');
  if (!el) return;
  const media = currentMediaState.element;
  const dur = (media && isFinite(media.duration) && media.duration > 0) ? media.duration : 0;
  if (!dur) { el.textContent = '0:00'; return; }
  if (showRemainingTime) {
    const remaining = Math.max(0, dur - (media.currentTime || 0));
    el.textContent = '-' + (formatDuration(remaining) || '0:00');
  } else {
    el.textContent = formatDuration(dur) || '0:00';
  }
}

// =========================================================================
// PLAYBACK SPEED - Shared between video and audio players
// =========================================================================

const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3];
let currentSpeedIndex = 3; // default 1x

/** The stepper plus the readout, identical in every player. */
function renderSpeedControls() {
  return `
    <div class="speed-control">
      <button onclick="cycleSpeed(-1)" class="control-btn speed-btn" title="Slower (<)">−</button>
      <span class="speed-display" id="speedDisplay"
            onclick="resetSpeed()"
            oncontextmenu="openSpeedMenu(event); return false;"
            title="Click to reset to 1x. Right-click for all speeds">1x</span>
      <button onclick="cycleSpeed(1)" class="control-btn speed-btn" title="Faster (>)">+</button>
    </div>
  `;
}

/** The speed the session is set to right now. */
function currentSpeed() {
  return SPEED_STEPS[currentSpeedIndex];
}

/**
 * Put the session speed on a media element, and make it stick.
 *
 * playbackRate alone does not survive a source change: the HTML media load
 * algorithm resets playbackRate to defaultPlaybackRate every time a source is
 * loaded, and that covers both `el.src = ...` and hls.js attaching MSE. So a
 * rate applied while the player renders (which happens before the server has
 * even said whether the file is native or remuxed) was thrown away a moment
 * later, leaving the file at 1x while the readout still said 2x.
 *
 * Setting defaultPlaybackRate as well makes that reset land on the chosen speed
 * instead of 1x, and the loadedmetadata re-apply covers any path that reaches a
 * fresh source another way.
 */
function applySpeedTo(element) {
  if (!element || typeof element.playbackRate !== 'number') return;
  const rate = currentSpeed();
  try { element.defaultPlaybackRate = rate; } catch {}
  try { element.playbackRate = rate; } catch {}
  if (!element._speedBound) {
    element._speedBound = true;
    element.addEventListener('loadedmetadata', () => applySpeedTo(element));
  }
}

/**
 * Apply the speed at currentSpeedIndex to the playing element and relabel.
 */
function applyCurrentSpeed() {
  applySpeedTo(currentMediaState.element);
  updateSpeedDisplay();
}

/**
 * Cycle playback speed up (+1) or down (-1).
 */
function cycleSpeed(direction) {
  if (!currentMediaState.element) return;
  currentSpeedIndex = Math.max(0, Math.min(SPEED_STEPS.length - 1, currentSpeedIndex + direction));
  applyCurrentSpeed();
}

/**
 * Jump straight to one of the SPEED_STEPS (the right-click menu).
 */
function setSpeedIndex(index) {
  if (index < 0 || index >= SPEED_STEPS.length) return;
  currentSpeedIndex = index;
  applyCurrentSpeed();
  closeSpeedMenu();
}

/**
 * Reset speed to 1x.
 */
function resetSpeed() {
  currentSpeedIndex = SPEED_STEPS.indexOf(1);
  applyCurrentSpeed();
  closeSpeedMenu();
}

/**
 * Update the speed display element.
 */
function updateSpeedDisplay() {
  const display = document.getElementById('speedDisplay');
  if (!display) return;
  // The element's own rate is the truth: if anything ever resets it behind our
  // back the readout says so instead of quietly lying about the speed.
  const el = currentMediaState.element;
  const live = (el && typeof el.playbackRate === 'number' && el.playbackRate > 0)
    ? Math.round(el.playbackRate * 100) / 100 : null;
  const speed = live === null ? currentSpeed() : live;
  display.textContent = speed + 'x';
  display.classList.toggle('speed-modified', speed !== 1);
  // Mini player carries the same readout when it shows an audio card
  const mini = document.getElementById('miniAudioSpeed');
  if (mini) mini.textContent = speed + 'x';
}

/* ── Speed menu (right-click the readout) ────────────────────────────────
   Built on demand rather than once at startup: the control bar is thrown away
   and re-rendered on every media change, so a cached node would end up
   orphaned. */
function _speedMenuOutside(e) {
  const menu = document.getElementById('speedMenu');
  if (menu && !menu.contains(e.target)) closeSpeedMenu();
}

function _speedMenuKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeSpeedMenu(); }
}

function closeSpeedMenu() {
  const menu = document.getElementById('speedMenu');
  if (menu) menu.remove();
  document.removeEventListener('mousedown', _speedMenuOutside, true);
  document.removeEventListener('keydown', _speedMenuKey, true);
}

function openSpeedMenu(event) {
  if (event) event.preventDefault();
  const display = document.getElementById('speedDisplay');
  if (!display || !display.parentElement) return;
  closeSpeedMenu();

  const menu = document.createElement('div');
  menu.className = 'speed-menu';
  menu.id = 'speedMenu';
  menu.innerHTML = SPEED_STEPS.map((s, i) =>
    `<button type="button" class="speed-menu-item${i === currentSpeedIndex ? ' selected' : ''}"
             onclick="setSpeedIndex(${i})">${s}x</button>`).join('');
  display.parentElement.appendChild(menu);

  // Deferred so the click/contextmenu that opened it doesn't immediately close it
  setTimeout(() => {
    document.addEventListener('mousedown', _speedMenuOutside, true);
    document.addEventListener('keydown', _speedMenuKey, true);
  }, 0);
}
