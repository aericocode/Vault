/* ==========================================
   Application State
   ========================================== */

// Library state (loaded from the viewer server API)
let allMedia = [];
let filteredMedia = [];

// Pagination state. pageAnchor is the source of truth: the index in
// filteredMedia of the first tile on screen. pageSize is dynamic (columns ×
// rows, both computed from the window in cards.js), so a page NUMBER changes
// meaning whenever the window does, while the anchor keeps the tile the user
// was looking at exactly where it was. currentPage is derived from the two and
// kept only for the code that still asks for a number.
let pageAnchor = 0;
let currentPage = 1;
let pageSize = 45;

// Last file the user opened in the player. On close the library jumps to its
// page and marks its tile (soft theme-colour border) so the user keeps their
// place in a long list.
let lastOpenedMediaId = null;

// View state (grid-only — list view was removed)
let currentView = 'grid';
let currentSort = 'processed_desc';
let favesFirst = false; // ❤ toggle: faves float to the top of any sort

/* Volume persistence. The level and the mute flag are one preference in one
   store: both answer "how loud is the app", neither belongs to a single file,
   and keeping them apart is why mute used to fall off at the next file while
   the level rode across. savedVolume is the SLIDER position (0 to 1.5), not
   the curved value the element gets. */
const VOLUME_STORE_KEY = 'vault_volume';
let savedVolume = 1;
let savedMuted = false;

(function loadVolumePrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(VOLUME_STORE_KEY) || 'null');
    if (!stored || typeof stored !== 'object') return;
    const v = Number(stored.volume);
    if (isFinite(v) && v >= 0 && v <= 1.5) savedVolume = v;
    savedMuted = !!stored.muted;
  } catch {}
})();

function saveVolumePrefs() {
  try {
    localStorage.setItem(VOLUME_STORE_KEY,
      JSON.stringify({ volume: savedVolume, muted: savedMuted }));
  } catch {}
}

/**
 * Is the player silent right now? Mute is the button; a zero level is the
 * slider dragged all the way down. Both mean no sound. Everything that sets
 * element.muted or draws the mute button asks this one question, so the
 * element and the button cannot end up disagreeing.
 */
function playerIsSilent() {
  return savedMuted || !(Number(savedVolume) > 0);
}

/** Paint every mute button in the app from that one answer. */
function updateMuteButton() {
  const silent = playerIsSilent();
  const icon = silent ? '🔇' : (savedVolume < 0.5 ? '🔉' : '🔊');
  document.querySelectorAll('#muteBtn').forEach(btn => {
    btn.textContent = icon;
    btn.title = silent ? 'Unmute (M)' : 'Mute (M)';
    btn.setAttribute('aria-label', silent ? 'Unmute' : 'Mute');
    btn.setAttribute('aria-pressed', silent ? 'true' : 'false');
  });
}

/** Give a freshly built media element the remembered mute state. */
function applySavedMute(el) {
  if (el) el.muted = playerIsSilent();
  updateMuteButton();
}

/**
 * The mute button, for every player. Unmuting a track whose level is zero
 * gives back the last level that could actually be heard.
 */
function togglePlayerMute() {
  if (playerIsSilent()) {
    savedMuted = false;
    if (!(Number(savedVolume) > 0)) {
      const prev = Number(currentMediaState.previousVolume);
      savedVolume = prev > 0 ? prev : 1;
    }
  } else {
    currentMediaState.previousVolume = savedVolume;
    savedMuted = true;
  }
  saveVolumePrefs();
}

// Media player state
let currentMediaState = {
  type: null,
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
  currentIndex: -1,
  audioContext: null,
  gainNode: null,
  mediaSource: null,
  currentMediaData: null,
  previousVolume: 1,
  fontSize: 14,
  wordWrap: true
};

// Reset media state (preserves index and media data)
function resetMediaState(mediaType) {
  const preservedIndex = currentMediaState.currentIndex;
  const preservedMediaData = currentMediaState.currentMediaData;
  
  // Clean up audio context
  if (currentMediaState.audioContext) {
    currentMediaState.audioContext.close().catch(() => {});
  }
  
  currentMediaState = {
    type: mediaType,
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
    wordWrap: true
  };
}
