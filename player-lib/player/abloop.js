/* =========================================================================
   AB LOOP - Set A/B points for looped playback
   ========================================================================= */

// AB loop state
let abLoopA = null;  // seconds (null = not set)
let abLoopB = null;  // seconds (null = not set)

/**
 * Cycle the AB loop state:
 *   null/null → set A at current time
 *   A/null   → set B at current time (activates loop)
 *   A/B      → clear both
 */
function toggleAbLoop() {
  const element = currentMediaState.element;
  if (!element) return;

  if (abLoopA === null) {
    // Set point A
    abLoopA = element.currentTime;
    abLoopB = null;
    // Modern says what happens next (the bar also shows an "A" marker)
    if (_abModern()) showToast(`A set at ${formatDuration(abLoopA) || '0:00'}. Press ] or click the bar to set B`);
  } else if (abLoopB === null) {
    // Set point B
    _abSetB(element, element.currentTime);
  } else {
    // Clear both
    clearAbLoop();
    return;
  }

  updateAbLoopButton();
  updateAbLoopOverlay();
}

/** Is the Modern dock drawing the controls? */
function _abModern() {
  return typeof ModernDock !== 'undefined' && ModernDock.mounted();
}

/** B at `b` seconds: order the two points, take over looping, jump to A. */
function _abSetB(element, b) {
  // Ensure B > A, swap if needed
  if (b <= abLoopA) {
    abLoopB = abLoopA;
    abLoopA = b;
  } else {
    abLoopB = b;
  }
  // Remove native loop — we handle it now
  element.removeAttribute('loop');
  element.loop = false;
  // Seek to A to start the loop
  element.currentTime = abLoopA;
}

/**
 * Set B at a time picked on the bar (the Modern dock: A is set and the next
 * click on the bar lands B there instead of seeking).
 */
function setAbLoopEnd(seconds) {
  const element = currentMediaState.element;
  if (!element || abLoopA === null || abLoopB !== null) return;
  const t = Number(seconds);
  if (!isFinite(t)) return;
  _abSetB(element, t);
  updateAbLoopButton();
  updateAbLoopOverlay();
}

/**
 * Set the AB loop directly to a start/end (seconds) and start looping.
 * Used by note range links (e.g. "0:11-1:23"). Points are ordered + clamped
 * to the media duration; playback jumps to A and begins.
 */
function setAbLoop(aSecs, bSecs) {
  const element = currentMediaState.element;
  if (!element) return;

  let a = Math.max(0, Number(aSecs) || 0);
  let b = Math.max(0, Number(bSecs) || 0);
  if (b < a) [a, b] = [b, a];
  const dur = element.duration;
  if (isFinite(dur) && dur > 0) {
    a = Math.min(a, dur - 0.2);
    b = Math.min(b, dur);
  }
  if (b - a < 0.1) b = a + 0.1; // guarantee a loopable span

  abLoopA = a;
  abLoopB = b;
  // Native loop would fight our A→B seek — we own looping now
  element.removeAttribute('loop');
  element.loop = false;
  element.currentTime = a;
  element.play?.().catch(() => {});

  updateAbLoopButton();
  updateAbLoopOverlay();
}

/**
 * Clear AB loop state. Called on next/prev/random or third button click.
 */
function clearAbLoop() {
  abLoopA = null;
  abLoopB = null;
  // Restore the user's Loop preference (video AND audio)
  const element = currentMediaState.element;
  if (element && ['VIDEO', 'AUDIO'].includes(element.tagName)) {
    element.loop = typeof isRepeatOne === 'function' ? isRepeatOne() : false;
  }
  updateAbLoopButton();
  updateAbLoopOverlay();
}

/**
 * Check if current playback has reached or passed point B — seek to A.
 * Called every timeupdate from player-video.js / player-audio.js.
 * Uses a small tolerance to ensure we always catch the boundary.
 */
function checkAbLoop(mediaElement) {
  if (abLoopA === null || abLoopB === null) return;
  // Check with a tiny tolerance — timeupdate fires ~4 times/sec at 250ms intervals
  // so we check if we're within 0.3s of B or past it
  if (mediaElement.currentTime >= abLoopB - 0.05) {
    mediaElement.currentTime = abLoopA;
  }
}

// ── Button Rendering ────────────────────────────────────────────────────

/**
 * Render the AB loop button HTML.
 * Called from renderVideoPlayer / renderAudioPlayer.
 */
function renderAbLoopButton() {
  if (typeof mpBuildingDock === 'function' && mpBuildingDock()) {
    const m = getAbLoopModernState();
    return `<button type="button" class="mp-ic mp-ab-btn ${m.cls}" id="abLoopBtn" onclick="toggleAbLoop()" title="${m.title}" aria-label="A-B loop"
      >${mpIcon('ab-loop')}<span class="mp-badge" aria-hidden="true">A</span></button>`;
  }
  const { label, stateClass, title } = getAbLoopButtonState();
  return `<button class="ab-loop-btn ${stateClass}" id="abLoopBtn" onclick="toggleAbLoop()" title="${title}">${label}</button>`;
}

/** The Modern button: lit once the loop is set, filled with an A badge while waiting for B. */
function getAbLoopModernState() {
  if (abLoopA === null) return { cls: '', title: 'A-B loop: set the start ([)' };
  if (abLoopB === null) return { cls: 'pending', title: `A is at ${formatDuration(abLoopA) || '0:00'}. Click or press ] to set B, Esc to cancel` };
  return { cls: 'on', title: `Looping ${formatDuration(abLoopA) || '0:00'} to ${formatDuration(abLoopB) || '0:00'}. Click to clear (\\)` };
}

/**
 * Get current button label, class, and title based on state.
 */
function getAbLoopButtonState() {
  if (abLoopA === null) {
    return {
      label: 'A↔B',
      stateClass: '',
      title: 'Set loop start point ([ or click)'
    };
  } else if (abLoopB === null) {
    return {
      label: `A: ${formatDuration(abLoopA)} → ?`,
      stateClass: 'has-a',
      title: 'Set loop end point (] or click)'
    };
  } else {
    return {
      label: `🔁 ${formatDuration(abLoopA)} → ${formatDuration(abLoopB)}`,
      stateClass: 'has-ab',
      title: 'Clear loop (\\ or click)'
    };
  }
}

/**
 * Update the AB loop button in-place without full re-render.
 */
function updateAbLoopButton() {
  const btn = document.getElementById('abLoopBtn');
  if (!btn) return;
  if (btn.classList.contains('mp-ic')) {
    const m = getAbLoopModernState();
    btn.classList.toggle('pending', m.cls === 'pending');
    btn.classList.toggle('on', m.cls === 'on');
    btn.title = m.title;
    btn.removeAttribute('data-tip');   // tooltip.js re-reads the title on the next hover
    return;
  }
  const { label, stateClass, title } = getAbLoopButtonState();
  btn.className = `ab-loop-btn ${stateClass}`;
  btn.textContent = label;
  btn.title = title;
}

// ── Progress Bar Overlay ────────────────────────────────────────────────

/**
 * Render/update the visual overlay on the progress bar showing the A-B region.
 */
function updateAbLoopOverlay() {
  // Modern draws the A marker and the loop span on its own timeline
  if (_abModern()) { ModernDock.drawAb(); return; }
  // Find the progress bar container (works for both video and audio)
  const progressBar = document.getElementById('videoProgress') || document.getElementById('audioProgress');
  if (!progressBar) return;

  // Remove existing overlay elements
  progressBar.querySelectorAll('.ab-loop-region, .ab-loop-marker').forEach(el => el.remove());

  const element = currentMediaState.element;
  if (!element || !element.duration) return;

  const duration = element.duration;

  // Show marker A
  if (abLoopA !== null) {
    const aPercent = (abLoopA / duration) * 100;
    const markerA = document.createElement('div');
    markerA.className = 'ab-loop-marker marker-a';
    markerA.style.left = `calc(${aPercent}% - 1px)`;
    markerA.dataset.label = 'A';
    progressBar.appendChild(markerA);
  }

  // Show marker B and the highlighted region
  if (abLoopA !== null && abLoopB !== null) {
    const aPercent = (abLoopA / duration) * 100;
    const bPercent = (abLoopB / duration) * 100;

    // Region highlight
    const region = document.createElement('div');
    region.className = 'ab-loop-region';
    region.style.left = aPercent + '%';
    region.style.width = (bPercent - aPercent) + '%';
    progressBar.appendChild(region);

    // Marker B
    const markerB = document.createElement('div');
    markerB.className = 'ab-loop-marker marker-b';
    markerB.style.left = `calc(${bPercent}% - 1px)`;
    markerB.dataset.label = 'B';
    progressBar.appendChild(markerB);
  }
}
