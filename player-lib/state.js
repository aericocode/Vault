/* ==========================================
   Application State
   ========================================== */

// Library state (loaded from the viewer server API)
let allMedia = [];
let filteredMedia = [];

// Pagination state — pageSize is dynamic: columns × TARGET_ROWS, computed
// from the viewport so every page is a complete rectangle (no ragged rows)
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

// Volume persistence
let savedVolume = 1;

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
