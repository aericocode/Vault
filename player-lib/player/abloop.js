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
  } else if (abLoopB === null) {
    // Set point B
    let b = element.currentTime;
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
  } else {
    // Clear both
    clearAbLoop();
    return;
  }

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
  const { label, stateClass, title } = getAbLoopButtonState();
  return `<button class="ab-loop-btn ${stateClass}" id="abLoopBtn" onclick="toggleAbLoop()" title="${title}">${label}</button>`;
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
