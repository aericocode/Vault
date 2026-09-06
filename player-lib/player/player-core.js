/* =========================================================================
   PLAYER CORE - Main media player functionality with unified control bar
   
   Layout: [LEFT: media-specific] [CENTER: Prev | Info | Next] [RIGHT: media-specific]
   ========================================================================= */

// Get current media index in filteredMedia
function getCurrentMediaIndex(filepath) {
  return filteredMedia.findIndex(m => m.filepath === filepath);
}

// Play next media
function playNextMedia() {
  if (currentMediaState.currentIndex < filteredMedia.length - 1) {
    const nextMedia = filteredMedia[currentMediaState.currentIndex + 1];
    playMedia({
      filepath: nextMedia.filepath,
      filename: nextMedia.filename,
      media_type: nextMedia.media_type
    });
    refreshSidebarIfOpen();
  }
}

/**
 * Advance the queue, wrapping to the top if "Start over after the last file"
 * is on.
 *
 * Separate from playNextMedia() because the two answer different questions.
 * playNextMedia is the Next button: at the end of the list it does nothing,
 * and it should keep doing nothing. This is the automatic path — a file ended,
 * or failed to play at all — where stopping dead is what drops someone back to
 * their library mid-stream.
 *
 * @returns {boolean} true if it moved to another file.
 */
function playNextMediaOrWrap() {
  if (currentMediaState.currentIndex < filteredMedia.length - 1) {
    playNextMedia();
    return true;
  }
  const wrap = typeof window.vaultQueueLoop === 'function' ? window.vaultQueueLoop() : false;
  // A one-item list would "wrap" onto itself, which is the per-file Loop
  // button's job, not this one's.
  if (!wrap || filteredMedia.length < 2) return false;
  const first = filteredMedia[0];
  playMedia({
    filepath: first.filepath,
    filename: first.filename,
    media_type: first.media_type
  });
  refreshSidebarIfOpen();
  return true;
}

// Play previous media
function playPreviousMedia() {
  if (currentMediaState.currentIndex > 0) {
    const prevMedia = filteredMedia[currentMediaState.currentIndex - 1];
    playMedia({
      filepath: prevMedia.filepath,
      filename: prevMedia.filename,
      media_type: prevMedia.media_type
    });
    refreshSidebarIfOpen();
  }
}

// Play random media from filtered list
function playRandomMedia() {
  if (filteredMedia.length < 2) return;
  let randomIndex;
  // Avoid picking the same file
  do {
    randomIndex = Math.floor(Math.random() * filteredMedia.length);
  } while (randomIndex === currentMediaState.currentIndex && filteredMedia.length > 1);

  const media = filteredMedia[randomIndex];
  playMedia({
    filepath: media.filepath,
    filename: media.filename,
    media_type: media.media_type
  });
  refreshSidebarIfOpen();
}

/**
 * If sidebar is open, re-render it for the new media and autofocus notes.
 */
function refreshSidebarIfOpen() {
  if (!sidebarOpen) return;
  // The video is about to change — save any half-typed note before we wipe
  // the sidebar and re-render it for the new file.
  if (typeof flushPendingNotes === 'function') flushPendingNotes();
  renderSidebar();
  requestAnimationFrame(() => {
    const sidebar = document.getElementById('mediaSidebar');
    const textarea = sidebar?.querySelector('.note-input-field');
    if (textarea) textarea.focus();
    // Scroll sidebar to top
    const body = document.getElementById('mediaSidebarBody');
    if (body) body.scrollTop = 0;
  });
}

/**
 * Generate unified control bar with centered navigation
 * @param {string} leftControls - HTML for left section (media-specific)
 * @param {string} rightControls - HTML for right section (media-specific)
 * @param {boolean} hasPrev - Whether previous media exists
 * @param {boolean} hasNext - Whether next media exists
 * @returns {string} Complete control bar HTML
 */
function generateUnifiedControlBar(leftControls, rightControls, hasPrev, hasNext) {
  return `
    <div class="player-controls-wrapper" onclick="event.stopPropagation()">
      <div class="unified-control-bar">
        <div class="controls-left">
          ${leftControls}
        </div>
        <div class="controls-center">
          <button onclick="playPreviousMedia()" class="nav-btn" title="Previous (P)" ${!hasPrev ? 'disabled' : ''}>
            <span class="nav-icon">⏮</span>
            <span class="nav-label">Prev</span>
          </button>
          <button onclick="playRandomMedia()" class="nav-btn random-btn" title="Random (R)">
            <span class="nav-icon">🎲</span>
          </button>
          <button onclick="showMediaInfo()" class="info-btn" id="infoBtn" title="Show Info (I)">
            <span>ℹ️</span>
            <span>Info</span>
          </button>
          <button onclick="playNextMedia()" class="nav-btn" title="Next (N)" ${!hasNext ? 'disabled' : ''}>
            <span class="nav-label">Next</span>
            <span class="nav-icon">⏭</span>
          </button>
        </div>
        <div class="controls-right">
          ${rightControls}
        </div>
      </div>
    </div>
  `;
}

// Main playMedia function
function playMedia(mediaData) {
  const { filepath, filename, media_type } = mediaData;

  // Close mini player if active (stop its playback)
  const miniPlayer = document.getElementById('miniPlayer');
  if (miniPlayer && miniPlayer.classList.contains('active')) {
    const miniMedia = document.getElementById('miniPlayerMedia');
    const miniEl = miniMedia?.querySelector('video, audio');
    teardownMiniAudioCard();
    stopMediaElement(miniEl);
    miniMedia.innerHTML = '';
    miniPlayer.classList.remove('active', 'mini-audio');
    resetMiniPlayerPosition();
    currentMediaState.miniMode = false;
  }

  // ABORT the previous media element's download before replacing it.
  // Removing a <video> from the DOM does NOT stop its stream — the zombie
  // connections pile up against the browser's ~6-per-host limit and after
  // enough video-to-video jumps the NEXT video black-screens for minutes
  // waiting for a free connection.
  if (currentMediaState.element) stopMediaElement(currentMediaState.element);
  if (typeof stopMixPlayer === 'function') stopMixPlayer(); // all mix tracks, not just master

  const fileUrl = pathToFileUrl(filepath);

  // Clear AB loop from previous media
  if (typeof clearAbLoop === 'function') clearAbLoop();
  // Playback speed is deliberately NOT reset here — it's a session setting, so
  // Next/Prev/Random/maximize keep whatever you set. Each renderer re-applies it
  // to its new element.

  // Find current index and store full media data
  currentMediaState.currentIndex = getCurrentMediaIndex(filepath);
  currentMediaState.currentMediaData = filteredMedia[currentMediaState.currentIndex] || null;
  // Remember it so the library can mark this tile on close (keeps the user's place)
  if (currentMediaState.currentMediaData) lastOpenedMediaId = currentMediaState.currentMediaData.id;
  // Settings: record the last-opened media for the "Restore last session" option
  if (typeof vaultRecordLastOpened === 'function' && currentMediaState.currentMediaData) {
    vaultRecordLastOpened(currentMediaState.currentMediaData.id);
  }
  
  document.getElementById('mediaPlayerTitle').textContent = filename;
  const overlay = document.getElementById('mediaPlayerOverlay');
  const content = document.getElementById('mediaPlayerContent');
  const controls = document.getElementById('mediaPlayerControls');
  
  // Clean up previous audio context (may already be closed — don't throw)
  if (currentMediaState.audioContext) {
    try { currentMediaState.audioContext.close().catch(() => {}); } catch {}
  }

  // Reset state but preserve currentIndex and currentMediaData
  const preservedIndex = currentMediaState.currentIndex;
  const preservedMediaData = currentMediaState.currentMediaData;
  
  currentMediaState = {
    type: media_type,
    element: null,
    zoom: 1,
    rotation: 0,
    panX: 0,
    panY: 0,
    isPanning: false,
    startX: 0,
    startY: 0,
    hideControlsTimeout: null,
    clickTimeout: null,
    isDoubleClick: false,
    currentIndex: preservedIndex,
    audioContext: null,
    gainNode: null,
    mediaSource: null,
    currentMediaData: preservedMediaData,
    previousVolume: currentMediaState.previousVolume || 1,
    fontSize: 14,
    wordWrap: true,
    loopA: null,
    loopB: null
  };

  const hasPrev = currentMediaState.currentIndex > 0;
  const hasNext = currentMediaState.currentIndex < filteredMedia.length - 1;

  // Render based on media type
  if (media_type === 'video') {
    renderVideoPlayer(content, controls, fileUrl, filepath, filename, hasPrev, hasNext);
  } else if (media_type === 'image') {
    renderImagePlayer(content, controls, fileUrl, filepath, hasPrev, hasNext);
  } else if (media_type === 'gif') {
    renderGifPlayer(content, controls, fileUrl, filepath, hasPrev, hasNext);
  } else if (media_type === 'audio') {
    renderAudioPlayer(content, controls, fileUrl, filepath, filename, hasPrev, hasNext);
  } else if (media_type === 'document') {
    renderDocumentPlayer(content, controls, fileUrl, filepath, filename, hasPrev, hasNext);
  } else if (media_type === 'mix' && typeof renderMixPlayer === 'function') {
    renderMixPlayer(content, controls, filepath, filename, hasPrev, hasNext);
  } else {
    // Unknown type
    content.innerHTML = `
      <div class="unsupported-media">
        <div class="unsupported-icon">❓</div>
        <div class="unsupported-text">Unsupported media type: ${media_type}</div>
        <div class="unsupported-filename">${filename}</div>
      </div>
    `;
    controls.innerHTML = generateUnifiedControlBar('', '', hasPrev, hasNext);
  }
  
  overlay.classList.add('active');
  applyFillMode();
  document.body.style.overflow = 'hidden';
  // Full player open → tuck the selection bar away (selection is preserved)
  if (typeof renderSelectionBar === 'function') renderSelectionBar();

  // Setup control visibility
  showMediaControls();

  // Wake the controls only for movement over the video area (bound to
  // .media-player-main, so the sidebar is excluded; the handler further
  // filters out the side/top gutter). Stable ref → addEventListener dedups.
  const main = document.querySelector('.media-player-main');
  if (main) main.addEventListener('mousemove', handlePlayerPointerMove);

  // Setup click handler on media player content
  content.addEventListener('click', handleContentClick);
}

/* ── Loop / auto-advance ────────────────────────────────────────────────────
   Loop ON (default): the current video/audio repeats when it ends.
   Loop OFF: playback auto-advances to the next item in the queue.
   The last manually-chosen state is remembered across sessions; playing a
   collection turns loop off for that session without overwriting it. */

let loopEnabled = localStorage.getItem('player_loop') !== '0';

function isLoopEnabled() {
  return loopEnabled;
}

function setLoopEnabled(on, { persist = true } = {}) {
  loopEnabled = !!on;
  if (persist) {
    try { localStorage.setItem('player_loop', loopEnabled ? '1' : '0'); } catch {}
  }
  // Apply to whatever is playing right now (unless an A-B loop owns it)
  const el = currentMediaState.element;
  if (el && ['VIDEO', 'AUDIO'].includes(el.tagName) &&
      !(typeof abLoopA !== 'undefined' && abLoopA !== null && abLoopB !== null)) {
    el.loop = loopEnabled;
  }
  updateLoopButton();
}

function toggleLoop() {
  setLoopEnabled(!loopEnabled); // manual toggle persists
  showMediaControls();
}

function renderLoopButton() {
  return `<button onclick="toggleLoop()" id="loopBtn" class="control-btn loop-btn ${loopEnabled ? 'active' : ''}" title="Loop this file when it ends — off auto-plays the next item">Loop: ${loopEnabled ? 'On' : 'Off'}</button>`;
}

function updateLoopButton() {
  const btn = document.getElementById('loopBtn');
  if (!btn) return;
  btn.textContent = `Loop: ${loopEnabled ? 'On' : 'Off'}`;
  btn.classList.toggle('active', loopEnabled);
}

/* ── Fill mode ───────────────────────────────────────────────────────────
   Fill ON: media cover-crops to fill the player content area, eliminating
   the letterbox bars — without entering OS fullscreen (distinct from the
   ⛶ fullscreen button). Applies to every media type. Sticky across sessions,
   and composes with fullscreen (fill while fullscreen crops in fullscreen). */

let fillMode = localStorage.getItem('player_fill') === '1';

function isFillMode() {
  return fillMode;
}

/** Sync the fill-mode class onto the overlay to match the current pref. */
function applyFillMode() {
  const overlay = document.getElementById('mediaPlayerOverlay');
  if (overlay) overlay.classList.toggle('fill-mode', fillMode);
}

function toggleFillMode() {
  fillMode = !fillMode;
  try { localStorage.setItem('player_fill', fillMode ? '1' : '0'); } catch {}
  applyFillMode();
  updateFillButton();
}

function renderFillButton() {
  return `<button onclick="toggleFillMode()" class="control-btn fill-btn ${fillMode ? 'active' : ''}" title="Fill window (crop to fit)">⤢</button>`;
}

function updateFillButton() {
  document.querySelectorAll('.fill-btn').forEach(btn => {
    btn.classList.toggle('active', fillMode);
  });
}

/** 'ended' fired with loop off → advance the queue (or start over, if set). */
function autoAdvanceOnEnded() {
  if (loopEnabled) return;
  playNextMediaOrWrap();
}

/**
 * The 💦 Done button — placed on the video/audio playback row mirroring the
 * AB-loop button (opposite corner) so it isn't clicked by accident from the
 * center nav.
 */
function renderDoneButton() {
  return `<button onclick="markSessionDone()" class="done-btn" title="Done — end the viewing session here (💦 tracked per item)">💦 Done</button>`;
}

/**
 * The 🔥 Hot button — same mechanic as Done but a separate counter/metric,
 * used to mark intense moments. Rendered to the LEFT of Done.
 */
function renderHotButton() {
  return `<button onclick="markSessionHot()" class="hot-btn" title="Hot — mark an intense moment here (🔥 tracked per item)">🔥 Hot</button>`;
}

/**
 * "Hot" — mark an intense moment on this item (count + timestamp, heatmap
 * bonus at the spot). Mirrors markSessionDone; playback continues.
 */
async function markSessionHot() {
  const media = currentMediaState.currentMediaData;
  if (!media || !media.id) return;

  const el = currentMediaState.element;
  const position = (el && ['VIDEO', 'AUDIO'].includes(el.tagName) && isFinite(el.currentTime))
    ? el.currentTime : 0;

  // Flush pending watch-activity first so the server's Hot bonus lands on
  // an up-to-date heatmap
  if (typeof flushWatchHeat === 'function') flushWatchHeat();

  try {
    const resp = await fetch(`/api/media/${media.id}/hot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position }),
    });
    if (resp.ok) {
      const updated = await resp.json();
      const item = getMediaById(media.id);
      if (item) {
        item.hot_count = updated.hot_count;
        item.last_hot_at = updated.last_hot_at;
        item.last_hot_position = updated.last_hot_position;
        item.hot_heatmap = updated.hot_heatmap;
        item.watch_heatmap = updated.watch_heatmap;
      }
    }
  } catch {}

  showToast(`🔥 Hot — marked on ${media.filename}`);
  if (typeof drawActivityBar === 'function') drawActivityBar(); // tint the spot live
  renderResults(); // refresh 🔥 badges on the grid behind the player
}

/**
 * "Done" — mark that a viewing session ended on this item (count + timestamp
 * for audio/video, heatmap bonus at the spot). Just the stat + a toast — the
 * video keeps playing. Sortable via "Session ends".
 */
async function markSessionDone() {
  const media = currentMediaState.currentMediaData;
  if (!media || !media.id) return;

  const el = currentMediaState.element;
  const position = (el && ['VIDEO', 'AUDIO'].includes(el.tagName) && isFinite(el.currentTime))
    ? el.currentTime : 0;

  // Flush pending watch-activity first so the server's Done bonus lands on
  // an up-to-date heatmap
  if (typeof flushWatchHeat === 'function') flushWatchHeat();

  try {
    const resp = await fetch(`/api/media/${media.id}/done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position }),
    });
    if (resp.ok) {
      const updated = await resp.json();
      const item = getMediaById(media.id);
      if (item) {
        item.done_count = updated.done_count;
        item.last_done_at = updated.last_done_at;
        item.last_done_position = updated.last_done_position;
        item.done_heatmap = updated.done_heatmap;
        item.watch_heatmap = updated.watch_heatmap;
      }
    }
  } catch {}

  showToast(`💦 Done — marked on ${media.filename}`);
  if (typeof drawActivityBar === 'function') drawActivityBar(); // tint the spot live
  renderResults(); // refresh 💦 badges on the grid behind the player
}

// Handle clicks on media player content area — minimize instead of close
function handleContentClick(event) {
  const target = event.target;
  const mediaElements = ['mediaVideo', 'mediaImage', 'mediaGif', 'mediaAudio', 'mediaDocument', 'audioCanvas'];
  if (mediaElements.includes(target.id) || target.closest('.document-viewer') || target.closest('.audio-visualization')) {
    return;
  }
  
  if (document.fullscreenElement) {
    return;
  }

  // Sidebar open → this click only dismisses it. Minimizing to the library on
  // the same click meant "just close the sidebar" clicks lost the player; the
  // second click (sidebar now closed) does the normal minimize/close.
  if (sidebarOpen) {
    toggleSidebar();
    return;
  }

  // Only minimize for the types that benefit from continued playback. Mixes
  // count: they used to fall through to closeMediaPlayer(), so a stray click
  // anywhere off the master layer threw the viewer back to the library.
  const type = currentMediaState.type;
  if (isVideoLike(type) || type === 'audio') {
    minimizePlayer();
  } else {
    closeMediaPlayer();
  }
}

// ── Sidebar (replaces info overlay when in player) ──────────────────────

// Track sidebar state
let sidebarOpen = false;

/**
 * Toggle the sidebar. Called by I key or info button.
 */
function showMediaInfo() {
  toggleSidebar();
}

function toggleSidebar() {
  const sidebar = document.getElementById('mediaSidebar');
  if (!sidebar) return;

  // Closing the sidebar shouldn't drop a half-typed note — save it first.
  if (sidebarOpen && typeof flushPendingNotes === 'function') flushPendingNotes();

  sidebarOpen = !sidebarOpen;

  // Mark the overlay so the header (minimize/close) can shrink to the video
  // area instead of sitting on top of the sidebar's own close button.
  document.getElementById('mediaPlayerOverlay')?.classList.toggle('sidebar-open', sidebarOpen);

  if (sidebarOpen) {
    renderSidebar();
    sidebar.classList.add('active');
    // Autofocus notes textarea after render
    requestAnimationFrame(() => {
      const textarea = sidebar.querySelector('.note-input-field');
      if (textarea) textarea.focus();
    });
  } else {
    sidebar.classList.remove('active');
    clearSidebarBody();
  }
}

/**
 * Empty the closed sidebar. The Subtitles/Music sections fill themselves in
 * async via getElementById, and the library modal now renders those same ids —
 * leaving stale markup behind would give the modal's box an invisible twin and
 * whichever one lost the id race would sit on "Loading…" forever.
 */
function clearSidebarBody() {
  const body = document.getElementById('mediaSidebarBody');
  if (!body) return;
  // Flush HERE, not at the call sites. Escape runs closeMediaInfo() before
  // closeMediaPlayer(), so by the time the player's own flush ran the
  // .notes-section it looks for had already been wiped — a typed note went in
  // the bin. Anything that empties this body has to save first, so the one
  // function that empties it is the one that saves.
  if (typeof flushPendingNotes === 'function') flushPendingNotes();
  body.innerHTML = '';
}

/**
 * Render sidebar content for the current media.
 * Reusable — called on toggle and on next/prev navigation.
 */
function renderSidebar() {
  const media = currentMediaState.currentMediaData;
  const body = document.getElementById('mediaSidebarBody');
  if (!media || !body) return;

  body.innerHTML = renderDetailBody(media, { context: 'player' });
}


function closeMediaInfo() {
  // Close the old info overlay (if it was open)
  document.getElementById('mediaInfoOverlay').classList.remove('active');
  // Close sidebar
  const sidebar = document.getElementById('mediaSidebar');
  if (sidebar) {
    sidebar.classList.remove('active');
    sidebarOpen = false;
    clearSidebarBody();
  }
  document.getElementById('mediaPlayerOverlay')?.classList.remove('sidebar-open');
}

// VLC-style: hide the controls AND the cursor this long after the pointer
// last moved over the video (only while a video is actively playing).
const CONTROLS_HIDE_MS = 2500;

/**
 * Types that behave like a video player: real videos and mixes.
 *
 * A mix is a stack/grid of <video> layers driven by one master, so every
 * video-shaped behaviour — auto-hiding chrome, click-to-minimize, the mini
 * player — should treat it the same. Each of those had its own
 * `type === 'video'` test, and a mix passed none of them.
 */
function isVideoLike(type) {
  return type === 'video' || type === 'mix';
}
// A quick flick over the beat bar (to grab/drag it) shouldn't wake the
// controls — treat a padded region around the beat bar as dead space.
const BEATBAR_DEADZONE_PAD = 24;

// Auto-hide the player chrome after the idle timeout. Only the video player
// hides (images/docs/3D keep their controls). Nothing hides while the video is
// paused — a paused video means the user is about to click something, so the
// bar and the cursor both stay put until playback resumes.
function hidePlayerChrome() {
  const overlay = document.getElementById('mediaPlayerOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;

  const el = currentMediaState.element;
  // A mix is a video as far as the chrome is concerned — its master layer IS a
  // <video>. Excluding it left mixes with the control bar permanently on screen
  // and, because .media-player-content video carries cursor:pointer, a pointer
  // cursor that never went away either.
  if (!isVideoLike(currentMediaState.type) || !el) return;
  if (el.paused) return;

  overlay.classList.remove('controls-visible');
  overlay.classList.add('cursor-hidden');
}

// Show controls and schedule the hide
function showMediaControls() {
  const overlay = document.getElementById('mediaPlayerOverlay');

  if (overlay.classList.contains('active')) {
    overlay.classList.add('controls-visible');
    overlay.classList.remove('cursor-hidden');

    clearTimeout(currentMediaState.hideControlsTimeout);
    currentMediaState.hideControlsTimeout = setTimeout(hidePlayerChrome, CONTROLS_HIDE_MS);
  }
}

function scheduleHideControls() {
  clearTimeout(currentMediaState.hideControlsTimeout);
  currentMediaState.hideControlsTimeout = setTimeout(hidePlayerChrome, CONTROLS_HIDE_MS);
}

// Reveal the cursor WITHOUT popping the playback controls, and re-arm the
// idle hide. Used for the beat bar dead space and the letterbox gutter — the
// user should see their cursor there, just not the control bar.
function revealCursorOnly() {
  const overlay = document.getElementById('mediaPlayerOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;
  overlay.classList.remove('cursor-hidden');
  clearTimeout(currentMediaState.hideControlsTimeout);
  currentMediaState.hideControlsTimeout = setTimeout(hidePlayerChrome, CONTROLS_HIDE_MS);
}

/**
 * Passive pointer-move over the player.
 * - Over the video or the bottom control strip → wake the controls (+ cursor).
 * - Over the beat bar dead space or the side/top letterbox gutter → reveal the
 *   CURSOR only, never the controls (VLC-style: you can see where you're
 *   pointing without the bar flashing).
 * The sidebar isn't handled here at all (listener is bound to .media-player-main).
 */
function handlePlayerPointerMove(e) {
  const overlay = document.getElementById('mediaPlayerOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;

  const x = e.clientX, y = e.clientY;
  const inside = (rect, pad = 0) => rect &&
    x >= rect.left - pad && x <= rect.right + pad &&
    y >= rect.top - pad && y <= rect.bottom + pad;

  // Beat-bar dead space — cursor is revealed below, but never the controls here
  const beatbar = document.querySelector('.beatbar-overlay');
  const overBeatbar = beatbar && beatbar.style.display !== 'none' &&
    inside(beatbar.getBoundingClientRect(), BEATBAR_DEADZONE_PAD);

  const el = currentMediaState.element;
  const videoRect = (el && el.tagName === 'VIDEO') ? el.getBoundingClientRect() : null;
  // The control bar keeps its layout box even while faded out (opacity 0),
  // so hovering where it sits — including where it overhangs a small video —
  // still counts as the "bottom area".
  const controlBar = document.getElementById('mediaPlayerControls')?.firstElementChild;
  const controlRect = controlBar ? controlBar.getBoundingClientRect() : null;

  if (!overBeatbar && (inside(videoRect) || inside(controlRect, 14))) {
    showMediaControls();
  } else {
    revealCursorOnly();
  }
}

/* ── Unplayable files while streaming ───────────────────────────────────────
   Closing the player is the right answer when someone is sitting in front of
   it: they see the toast and go fix the file. It is the wrong answer while
   privacy / streaming mode is on, because that person is usually away from the
   keyboard and the player closing puts their whole library on screen — the one
   thing privacy mode exists to prevent. So in that mode a dead file is skipped
   instead.

   The counter stops a list where nothing plays (an unplugged drive) from
   spinning through every file forever. Any file that actually starts resets it,
   so a scattering of bad files never adds up to a false stop. */

let consecutivePlayFailures = 0;

// canplay/loadeddata fire on the media element and do not bubble, hence the
// capture phase — same reason as the listeners in selection.js. Scoped to the
// player's own element so a hover-scrub preview loading in the grid behind it
// cannot quietly reset the count.
function _noteMediaPlayable(e) {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (!el.closest('#mediaPlayerContent') && !el.closest('#miniPlayerMedia')) return;
  consecutivePlayFailures = 0;
}
document.addEventListener('canplay', _noteMediaPlayable, true);
document.addEventListener('loadeddata', _noteMediaPlayable, true);

function handleMediaError(filepath) {
  // Do NOT auto-copy the path to the clipboard (privacy). The capture-phase
  // error listener flags the item as ⚠ unplayable so it's still findable;
  // users can copy the path themselves from the details panel.
  consecutivePlayFailures++;
  const queueLength = (typeof filteredMedia !== 'undefined' && filteredMedia.length) || 1;
  if (document.body.classList.contains('privacy-mode')
      && consecutivePlayFailures < queueLength
      && playNextMediaOrWrap()) {
    showToast('Skipped a file that cannot play');
    return;
  }
  consecutivePlayFailures = 0;
  closeMediaPlayer();
  showToast('Cannot play this file — marked as unplayable. Use “Copy Path” to locate it.');
}

/**
 * Highlight a card by its index in filteredMedia.
 * Scrolls it into view and applies a brief highlight animation.
 */
function highlightCard(filteredIndex) {
  // Grid tiles carry data-id; match on it (robust to collection cards that
  // get prepended, which would throw off a positional index).
  const media = filteredMedia[filteredIndex];
  const card = media
    ? document.querySelector(`.media-tile[data-id="${media.id}"]`)
    : document.querySelectorAll('.media-tile')[filteredIndex % pageSize];
  if (!card) return;

  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('card-highlight');
  setTimeout(() => {
    card.classList.remove('card-highlight');
  }, 2000);
}

// ── Mini Player ─────────────────────────────────────────────────────────

/**
 * Stop a media element for teardown WITHOUT triggering its error handler.
 *
 * The player markup gives every <video>/<audio> an inline
 * onerror="handleMediaError(...)". Setting `.src = ''` asks the browser to
 * load the empty URL, which fires an async `error` event — that used to run
 * handleMediaError → closeMediaPlayer on a stale path, killing the file the
 * user was actually trying to open next (the "play twice" miniplayer bug).
 *
 * Null the handler first, then detach the source via removeAttribute+load()
 * (which sets networkState to EMPTY without firing error).
 */
function stopMediaElement(el) {
  if (!el) return;
  try { el.onerror = null; el.removeAttribute('onerror'); } catch {}
  try { el.pause(); } catch {}
  try { el.removeAttribute('src'); el.load(); } catch {}
}

/**
 * Minimize the full player to a floating mini player.
 * Moves the media element (video/audio) without reloading it.
 */
function minimizePlayer() {
  // Leaving fullscreen must be explicit — the mini player lives in the normal
  // page, and skipping this strands the browser in an empty fullscreen state.
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  // Minimizing hides the sidebar/notes — save a half-typed note first.
  if (typeof flushPendingNotes === 'function') flushPendingNotes();
  // The overlay stays behind in the (hidden) main player — drop it
  if (typeof subtitlesDetach === 'function') subtitlesDetach();

  const type = currentMediaState.type;
  if (!isVideoLike(type) && type !== 'audio') {
    closeMediaPlayer();
    return;
  }

  const element = currentMediaState.element;
  if (!element) {
    closeMediaPlayer();
    return;
  }

  const overlay = document.getElementById('mediaPlayerOverlay');
  const miniPlayer = document.getElementById('miniPlayer');
  const miniMedia = document.getElementById('miniPlayerMedia');
  const miniTitle = document.getElementById('miniPlayerTitle');

  // Set title
  miniTitle.textContent = currentMediaState.currentMediaData?.filename || 'Playing...';
  // Audio gets the compact card layout; everything else the plain video box
  miniPlayer.classList.remove('mini-audio');

  // The inline onerror carries this file's path and calls closeMediaPlayer;
  // it's meaningless once the media is loaded and only causes stale-path
  // toasts if the element errors while minimized. Drop it — genuine errors
  // are still caught by the capture-phase listener in selection.js.
  element.onerror = null;
  element.removeAttribute('onerror');

  // Move the media element to the mini player (preserves playback state)
  if (type === 'mix') {
    // Move the whole stage, not just the master: a mix IS its layers, and the
    // sync engine holds direct references to them, so relocating the subtree
    // keeps it running. Tag the master first — minimize strips ids to avoid
    // duplicates, and maximize needs to know whose currentTime to restore.
    const stage = document.querySelector('.mix-player-stage');
    if (!stage) { closeMediaPlayer(); return; }
    stage.removeEventListener('click', handleVideoClick);
    stage.removeEventListener('dblclick', handleVideoDoubleClick);
    element.dataset.mixMaster = '1';
    element.removeAttribute('id');
    miniMedia.innerHTML = '';
    miniMedia.appendChild(stage);
  } else if (type === 'video') {
    // Remove video click handlers to avoid conflicts
    element.removeEventListener('click', handleVideoClick);
    element.removeEventListener('dblclick', handleVideoDoubleClick);
    element.style.width = '100%';
    element.removeAttribute('id'); // avoid duplicate ID conflicts
    miniMedia.innerHTML = '';
    miniMedia.appendChild(element);
  } else if (type === 'audio') {
    // Audio has nothing to show, so the mini player becomes a compact card:
    // art tile + title/time + controls on one row, hairline progress under it.
    // The <audio> itself just rides along, hidden.
    element.removeAttribute('id');
    miniMedia.innerHTML = '';
    miniMedia.appendChild(element);
    miniPlayer.classList.add('mini-audio');
    setupMiniAudioCard(element);
  }

  // Give this mode its own box before the card is shown, so the first paint is
  // already the right shape.
  applyMiniPlayerSize(miniPlayer, type === 'audio');

  // Update mini play/pause button
  updateMiniPlayPause();

  // Close the full overlay without destroying the element
  clearTimeout(currentMediaState.hideControlsTimeout);
  clearTimeout(currentMediaState.clickTimeout);
  overlay.removeEventListener('mousemove', showMediaControls);

  // Don't close media info — just the overlay
  closeMediaInfo();

  overlay.classList.remove('active', 'controls-visible', 'cursor-hidden');
  document.getElementById('mediaPlayerContent').innerHTML = '';
  document.getElementById('mediaPlayerControls').innerHTML = '';
  document.body.style.overflow = '';

  // Show mini player
  currentMediaState.miniMode = true;
  miniPlayer.classList.add('active');
  // Now that it has a layout, pull it back on-screen if a previous drag left
  // it somewhere that only fit the old (bigger) box.
  clampMiniPlayerToViewport(miniPlayer);
  // Mini player doesn't cover the grid → bring the selection bar back
  if (typeof renderSelectionBar === 'function') renderSelectionBar();

  // Initialize drag
  initMiniPlayerDrag();
}

/**
 * Maximize from mini player back to full player.
 */
function maximizePlayer() {
  const miniPlayer = document.getElementById('miniPlayer');
  const miniMedia = document.getElementById('miniPlayerMedia');

  // Get the media element back. For a mix the box holds the whole stage, so
  // prefer the tagged master — its clock is the one the mix is synced to, and
  // querySelector would otherwise grab whichever layer is first in the DOM.
  const element = miniMedia.querySelector('[data-mix-master], video, audio');
  if (!element) {
    closeMiniPlayer();
    return;
  }

  // Hide mini player
  teardownMiniAudioCard();
  miniPlayer.classList.remove('active', 'mini-audio');
  currentMediaState.miniMode = false;

  // Re-play in full mode using the current media data
  const mediaData = currentMediaState.currentMediaData;
  if (mediaData) {
    // Store the current playback position and playing state
    const wasPlaying = !element.paused;
    const currentTime = element.currentTime;
    const volume = element.volume;

    // Clean up the moved element
    miniMedia.innerHTML = '';

    // Re-open the full player (this creates a fresh element)
    playMedia({
      filepath: mediaData.filepath,
      filename: mediaData.filename,
      media_type: mediaData.media_type
    });

    // Restore playback position after the new element loads
    const newElement = currentMediaState.element;
    if (newElement) {
      newElement.currentTime = currentTime;
      if (!wasPlaying) {
        newElement.pause();
      }
    }
  }
}

/**
 * Fully close the mini player — stop playback and clean up.
 */
function closeMiniPlayer() {
  const miniPlayer = document.getElementById('miniPlayer');
  const miniMedia = document.getElementById('miniPlayerMedia');

  // Stop any playing media (without tripping the inline error handler). A mix
  // has several layers plus a drift-correction interval, so hand it to its own
  // teardown or the followers keep decoding behind a closed mini player.
  teardownMiniAudioCard();
  if (currentMediaState.type === 'mix' && typeof stopMixPlayer === 'function') {
    stopMixPlayer();
  } else {
    stopMediaElement(miniMedia.querySelector('video, audio'));
  }

  // Clean up audio context if still around
  if (currentMediaState.audioContext) {
    currentMediaState.audioContext.close().catch(() => {});
    currentMediaState.audioContext = null;
  }

  miniMedia.innerHTML = '';
  miniPlayer.classList.remove('active', 'mini-audio');
  currentMediaState.miniMode = false;

  // Jump to page, re-render (applies the "last opened" tile border), highlight
  const lastIndex = currentMediaState.currentIndex;
  if (lastIndex >= 0 && lastIndex < filteredMedia.length) {
    currentPage = Math.floor(lastIndex / pageSize) + 1;
    renderResults();
    requestAnimationFrame(() => {
      highlightCard(lastIndex);
    });
  }
}

/**
 * Toggle play/pause in the mini player.
 */
function miniTogglePlay() {
  const miniMedia = document.getElementById('miniPlayerMedia');
  const element = miniMedia?.querySelector('video, audio');
  if (!element) return;

  if (element.paused) {
    element.play().catch(() => {});
  } else {
    element.pause();
  }
  updateMiniPlayPause();
}

/**
 * Update the mini player play/pause button icon.
 */
function updateMiniPlayPause() {
  const miniMedia = document.getElementById('miniPlayerMedia');
  const btn = document.getElementById('miniPlayPause');
  const element = miniMedia?.querySelector('video, audio');
  if (!btn || !element) return;

  // Update immediately and on state changes
  const update = () => {
    btn.textContent = element.paused ? '▶' : '⏸';
  };
  update();
  element.addEventListener('play', update);
  element.addEventListener('pause', update);
  element.addEventListener('ended', update);
}

/**
 * Wire the compact audio card: the "0:14 / 0:40 · 1x" line and the hairline
 * progress strip. The listener is parked on the element itself so maximize and
 * close can take it back off again.
 */
function setupMiniAudioCard(element) {
  const timeEl = document.getElementById('miniAudioTime');
  const speedEl = document.getElementById('miniAudioSpeed');
  const fill = document.getElementById('miniAudioProgressFill');
  const strip = document.getElementById('miniAudioProgress');

  const update = () => {
    const dur = (isFinite(element.duration) && element.duration > 0) ? element.duration : 0;
    if (fill) fill.style.width = dur ? ((element.currentTime / dur) * 100) + '%' : '0%';
    if (timeEl) {
      timeEl.textContent = `${formatDuration(element.currentTime) || '0:00'} / ${formatDuration(dur) || '0:00'}`;
    }
    if (speedEl) speedEl.textContent = (element.playbackRate || 1) + 'x';
  };

  update();
  element.addEventListener('timeupdate', update);
  element.addEventListener('loadedmetadata', update);
  element._miniAudioUpdate = update;

  // Click/drag the strip to seek. Bound once — the card markup lives in the
  // page, so re-binding on every minimize would stack handlers.
  if (strip && !strip._seekBound && typeof attachSeekScrubbing === 'function') {
    strip._seekBound = true;
    attachSeekScrubbing(strip, strip, () => {
      const box = document.getElementById('miniPlayerMedia');
      return box ? box.querySelector('audio, video') : null;
    // The strip is a 4px hairline inside a card with overflow:hidden — a pill
    // left hanging after a click reads as a glitch, so hide it on release.
    }, { hideLabelOnRelease: true });
  }
}

/** Drop the mini audio card's timeupdate listener (maximize / close / replace). */
function teardownMiniAudioCard() {
  const miniMedia = document.getElementById('miniPlayerMedia');
  const element = miniMedia ? miniMedia.querySelector('video, audio') : null;
  if (element && element._miniAudioUpdate) {
    element.removeEventListener('timeupdate', element._miniAudioUpdate);
    element.removeEventListener('loadedmetadata', element._miniAudioUpdate);
    delete element._miniAudioUpdate;
  }
}

/**
 * Size the mini player for the mode it is about to show.
 *
 * The mini player is user-resizable (CSS `resize: both`), and the browser
 * records a resize as INLINE width/height on #miniPlayer. Inline styles beat
 * every stylesheet rule, so once a video mini had been dragged out to, say,
 * 770x900, minimizing an audio file handed the compact card that same box —
 * art/title/controls floating in the middle of a huge empty rectangle with the
 * seek strip stranded at the bottom.
 *
 * So: park the inline size while audio is showing (audio sizes itself from
 * CSS, 380px wide and only as tall as its one row), and give the video box
 * back the size the user chose the next time a video or mix is minimized.
 */
function applyMiniPlayerSize(miniPlayer, isAudio) {
  if (!miniPlayer) return;
  if (isAudio) {
    if (miniPlayer.style.width) miniPlayer.dataset.savedW = miniPlayer.style.width;
    if (miniPlayer.style.height) miniPlayer.dataset.savedH = miniPlayer.style.height;
    miniPlayer.style.width = '';
    miniPlayer.style.height = '';
  } else {
    if (miniPlayer.dataset.savedW) miniPlayer.style.width = miniPlayer.dataset.savedW;
    if (miniPlayer.dataset.savedH) miniPlayer.style.height = miniPlayer.dataset.savedH;
  }
}

/**
 * Snap the card back inside the viewport.
 *
 * Dragging switches the mini player to inline left/top, and that position
 * sticks across minimizes. A spot that fit a 640x400 video box can push a
 * different-sized card (or the same card after the window shrank) off the
 * right or bottom edge. Untouched, it is still anchored bottom/right by CSS
 * and there is nothing to clamp.
 */
function clampMiniPlayerToViewport(miniPlayer) {
  if (!miniPlayer || !miniPlayer.style.left) return;
  const w = miniPlayer.offsetWidth;
  const h = miniPlayer.offsetHeight;
  const left = parseFloat(miniPlayer.style.left) || 0;
  const top = parseFloat(miniPlayer.style.top) || 0;
  miniPlayer.style.left = Math.max(0, Math.min(Math.max(0, window.innerWidth - w), left)) + 'px';
  miniPlayer.style.top = Math.max(0, Math.min(Math.max(0, window.innerHeight - h), top)) + 'px';
}

// ── Mini Player Drag ────────────────────────────────────────────────────

function initMiniPlayerDrag() {
  const miniPlayer = document.getElementById('miniPlayer');
  const dragHandle = document.getElementById('miniPlayerDrag');
  
  let isDragging = false;
  let startX, startY, startLeft, startTop;

  const onMouseDown = (e) => {
    isDragging = true;
    const rect = miniPlayer.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;

    // Switch from bottom/right positioning to top/left for drag
    miniPlayer.style.left = rect.left + 'px';
    miniPlayer.style.top = rect.top + 'px';
    miniPlayer.style.right = 'auto';
    miniPlayer.style.bottom = 'auto';

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    const newLeft = Math.max(0, Math.min(window.innerWidth - miniPlayer.offsetWidth, startLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - miniPlayer.offsetHeight, startTop + dy));
    
    miniPlayer.style.left = newLeft + 'px';
    miniPlayer.style.top = newTop + 'px';
  };

  const onMouseUp = () => {
    isDragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };

  // Remove old listeners if re-initializing
  dragHandle._onMouseDown && dragHandle.removeEventListener('mousedown', dragHandle._onMouseDown);
  dragHandle._onMouseDown = onMouseDown;
  dragHandle.addEventListener('mousedown', onMouseDown);
}

/**
 * Reset mini player position (for next use).
 */
function resetMiniPlayerPosition() {
  const miniPlayer = document.getElementById('miniPlayer');
  if (!miniPlayer) return;
  miniPlayer.style.left = '';
  miniPlayer.style.top = '';
  miniPlayer.style.right = '1.5rem';
  miniPlayer.style.bottom = '1.5rem';
}

function closeMediaPlayer(event) {
  if (event && event.target !== event.currentTarget) return;
  
  // Also close mini player if active
  const miniPlayer = document.getElementById('miniPlayer');
  if (miniPlayer && miniPlayer.classList.contains('active')) {
    closeMiniPlayer();
    return;
  }

  const overlay = document.getElementById('mediaPlayerOverlay');
  const content = document.getElementById('mediaPlayerContent');
  
  // Exit fullscreen if active
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
      document.getElementById('mediaVideo').style.width = 'auto';
  }
  
  // Stop video/audio AND abort its download (pause alone keeps the
  // connection alive and starves the per-host connection limit)
  if (currentMediaState.element) {
    if (currentMediaState.type === 'video' || currentMediaState.type === 'audio') {
      stopMediaElement(currentMediaState.element);
      currentMediaState.element = null;
    }
  }

  // Custom mix: stop EVERY track's stream, not just the master
  if (currentMediaState.type === 'mix' && typeof stopMixPlayer === 'function') {
    stopMixPlayer();
    currentMediaState.element = null;
  }

  // Clean up audio context
  if (currentMediaState.audioContext) {
    currentMediaState.audioContext.close();
    currentMediaState.audioContext = null;
  }
  
  // Clear timeouts
  clearTimeout(currentMediaState.hideControlsTimeout);
  clearTimeout(currentMediaState.clickTimeout);
  
  // Remove event listeners
  const main = document.querySelector('.media-player-main');
  if (main) main.removeEventListener('mousemove', handlePlayerPointerMove);
  content.removeEventListener('click', handleContentClick);
  
  // Save any half-typed note before the sidebar is torn down
  if (typeof flushPendingNotes === 'function') flushPendingNotes();

  // Drop the subtitle overlay + its timeupdate listener
  if (typeof subtitlesDetach === 'function') subtitlesDetach();

  // Close media info if open
  closeMediaInfo();
  
  overlay.classList.remove('active', 'controls-visible', 'cursor-hidden');
  document.getElementById('mediaPlayerContent').innerHTML = '';
  document.getElementById('mediaPlayerControls').innerHTML = '';
  document.body.style.overflow = '';
  // Player closed → restore the selection bar if a selection is still active
  if (typeof renderSelectionBar === 'function') renderSelectionBar();

  // Reset mini player position for next use
  resetMiniPlayerPosition();

  // Jump to the page containing the last-played media and mark/highlight it.
  // Always re-render so the persistent "last opened" tile border is applied
  // even when the page didn't change.
  const lastIndex = currentMediaState.currentIndex;
  if (lastIndex >= 0 && lastIndex < filteredMedia.length) {
    currentPage = Math.floor(lastIndex / pageSize) + 1;
    renderResults();
    requestAnimationFrame(() => {
      highlightCard(lastIndex);
    });
  }
}

function toggleFullscreen() {
  const overlay = document.getElementById('mediaPlayerOverlay');
  
  const video = document.getElementById('mediaVideo');

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
      if (video) video.style.width = 'auto';
  } else {
    if (video) video.style.width = '100%';

    overlay.requestFullscreen().catch(() => {
      if (overlay.webkitRequestFullscreen) {
        overlay.webkitRequestFullscreen();
      } else if (overlay.mozRequestFullScreen) {
        overlay.mozRequestFullScreen();
        overlay.mozRequestFullScreen();
      }
    });
  }
}

// Listen for fullscreen changes
document.addEventListener('fullscreenchange', () => {
  showMediaControls();
});
