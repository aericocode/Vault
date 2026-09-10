// =========================================================================
// APP - Main application initialization and event handlers
//
// The viewer is served by the local Node server (server/index.js) and loads
// the library from /api/media on startup — no drag-and-drop, no sql.js,
// no File System Access API.
// =========================================================================

// Load external script
function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('active');
  setTimeout(() => toast.classList.remove('active'), 3000);
}

// Copy path to clipboard
function copyPath(filepath) {
  navigator.clipboard.writeText(filepath).then(() => {
    showToast('Path copied to clipboard!');
  }).catch(() => {
    showToast('Failed to copy path');
  });
}

// ── Sort controls: one option per field + a direction arrow + ❤ toggle ────
// currentSort stays a composed "field_dir" string so saved searches keep
// their existing shape.

// Natural first direction when switching fields (name reads A→Z; everything
// else starts with "most" on top)
const SORT_DEFAULT_DIR = { name: 'asc' };

function currentSortField() { return currentSort.split('_')[0]; }
function currentSortDir() { return currentSort.split('_')[1] || 'desc'; }

function syncSortControls() {
  const select = document.getElementById('sortSelect');
  const dirBtn = document.getElementById('sortDirBtn');
  const favBtn = document.getElementById('favesFirstBtn');
  if (select) select.value = currentSortField();
  if (dirBtn) {
    dirBtn.textContent = currentSortDir() === 'asc' ? '▲' : '▼';
    dirBtn.title = currentSortDir() === 'asc' ? 'Least first. Click for most first' : 'Most first. Click for least first';
  }
  if (favBtn) {
    favBtn.textContent = favesFirst ? '❤' : '🤍';
    favBtn.classList.toggle('active', favesFirst);
  }
}

document.getElementById('sortSelect').addEventListener('change', (e) => {
  currentSort = `${e.target.value}_${SORT_DEFAULT_DIR[e.target.value] || 'desc'}`;
  syncSortControls();
  sortFilteredMedia();
  renderResults();
});

document.getElementById('sortDirBtn').addEventListener('click', () => {
  currentSort = `${currentSortField()}_${currentSortDir() === 'asc' ? 'desc' : 'asc'}`;
  syncSortControls();
  sortFilteredMedia();
  renderResults();
});

document.getElementById('favesFirstBtn').addEventListener('click', () => {
  favesFirst = !favesFirst;
  syncSortControls();
  sortFilteredMedia();
  renderResults();
});

/* ── The More sheet ────────────────────────────────────────────────────────
   The sheet floats over the grid instead of pushing it down, so opening and
   closing it leaves every tile exactly where it was. While it is open a
   translucent backdrop covers the grid: it dims what the filters are about to
   change, and it means a click anywhere on the library closes the sheet.
   Round 5 built this for the filters panel; round 6 kept the mechanics and
   changed what sits inside. */

function filtersBackdrop() {
  let bd = document.getElementById('filtersBackdrop');
  if (!bd) {
    bd = document.createElement('div');
    bd.id = 'filtersBackdrop';
    bd.className = 'filters-backdrop';
    // Only a click that really was outside the sheet closes it. Asked from
    // the event's own path rather than from the node the click ended on,
    // because a control inside the sheet can be re-rendered mid-click.
    bd.addEventListener('click', (e) => {
      if (clickWasInsideTheSheet(e)) return;
      setFiltersOpen(false);
    });
    document.body.appendChild(bd);
  }
  return bd;
}

function filtersAreOpen() {
  return document.getElementById('moreFiltersSheet')?.classList.contains('active') === true;
}

/* Every rule that closes the sheet is a rule about clicking somewhere else,
   so all of them go through this one question. It reads the path the event
   travelled when it was dispatched, not the node it happens to point at now:
   pressing a filter inside the sheet re-renders the chip row underneath it,
   and a control that has been replaced in the meantime has no ancestors left
   to walk, so `closest()` would call an obviously-inside click "outside" and
   shut the sheet in the user's face. */
function clickWasInsideTheSheet(e) {
  const sheet = document.getElementById('moreFiltersSheet');
  if (!sheet) return false;
  if (typeof eventPathHasNode === 'function') return eventPathHasNode(e, sheet);
  return sheet.contains(e.target);
}

/* The panel is position: fixed, not absolute. An absolutely positioned panel
   hanging below the search box still counts towards the document's scroll
   height, so opening it grew the page, brought in a scrollbar and narrowed the
   grid by its width — which is exactly the movement this was meant to stop. */
const FILTERS_PANEL_GAP = 8;   // px of air between the sort row and the panel

function positionFiltersPanel() {
  const panel = document.getElementById('moreFiltersSheet');
  const section = document.querySelector('.search-section');
  if (!panel || !section) return;
  // Line the panel up with the grid, not with the search box: it floats over
  // the tiles, so it reads as part of that column.
  const grid = document.getElementById('resultsGrid');
  const r = (grid && grid.clientWidth ? grid : section).getBoundingClientRect();
  // Open right under the chip row the More chip lives in, so the sheet reads
  // as that row unfolding. Falls back to the search section's bottom edge if
  // the chip row is not on the page.
  const chipRow = document.getElementById('filterChipRow');
  const rowBottom = chipRow ? chipRow.getBoundingClientRect().bottom : section.getBoundingClientRect().bottom;
  const topEdge = Math.round(rowBottom) + FILTERS_PANEL_GAP;
  panel.style.left = `${Math.round(r.left)}px`;
  panel.style.width = `${Math.round(r.width)}px`;
  panel.style.top = `${topEdge}px`;
  panel.style.maxHeight = `${Math.max(120, Math.round(window.innerHeight - topEdge - 12))}px`;
  const bd = document.getElementById('filtersBackdrop');
  // Measured from the panel's own laid-out height, not its rect: while the
  // open transition is running the rect is still 4 px above where it lands.
  if (bd) bd.style.top = `${Math.max(0, topEdge + panel.offsetHeight)}px`;
}

function setFiltersOpen(open) {
  const panel = document.getElementById('moreFiltersSheet');
  const toggle = document.getElementById('moreFiltersChip');
  if (!panel) return;
  if (open && typeof renderMoreSheet === 'function') renderMoreSheet();
  panel.classList.toggle('active', open);
  toggle?.setAttribute('aria-expanded', open ? 'true' : 'false');
  const bd = filtersBackdrop();
  if (open) {
    positionFiltersPanel();
    bd.classList.add('active');
  } else {
    bd.classList.remove('active');
    if (document.activeElement && panel.contains(document.activeElement)) toggle?.focus();
  }
}

// The sheet follows the chip row when the window resizes. It deliberately does
// NOT follow page scroll: in continuous mode a filter set from inside the sheet
// can shrink the document, the browser clamps scrollY, the chip row moves, and
// a sheet that tracked it would jump under the cursor between two clicks.
// While it is open the sheet stays where it opened; a deliberate wheel outside
// it means the user is leaving the filters, so that closes it instead.
window.addEventListener('resize', () => { if (filtersAreOpen()) positionFiltersPanel(); }, { passive: true });
window.addEventListener('wheel', (e) => {
  if (!filtersAreOpen()) return;
  if (eventPathTarget(e, '#moreFiltersSheet')) return;
  if (typeof filterPopoverIsOpen === 'function' && filterPopoverIsOpen()) return;
  setFiltersOpen(false);
}, { passive: true });

// The More chip is re-rendered with the row, so the click is delegated — and
// asked of the event's path, because by the time this listener runs the chip
// row may already have been rebuilt by a listener ahead of it.
document.addEventListener('click', (e) => {
  if (eventPathTarget(e, '#moreFiltersChip')) setFiltersOpen(!filtersAreOpen());
});

// Escape closes the open popover first, then the sheet, before anything else
// gets to act on it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (typeof filterPopoverIsOpen === 'function' && filterPopoverIsOpen()) {
    closeFilterPopover();
    e.stopPropagation();
    return;
  }
  if (!filtersAreOpen()) return;
  setFiltersOpen(false);
  e.stopPropagation();
}, true);

// Clicking a tile is a decision about the library, so the sheet steps aside
document.getElementById('resultsGrid')?.addEventListener('click', (e) => {
  if (clickWasInsideTheSheet(e)) return;
  if (filtersAreOpen()) setFiltersOpen(false);
});

// Search input handler — adaptive debounce: the search itself is synchronous
// (it blocks typing while it runs), so wait for a real pause before running,
// scaled up for big libraries and for fuzzy mode (the heavy one). The rAF +
// setTimeout(0) hop lets the just-typed character PAINT before the search
// blocks the thread, so the input always feels instant.
const searchInput = document.getElementById('searchInput');
let _searchTimer = null;

function searchDebounceMs() {
  const n = (typeof allMedia !== 'undefined' && allMedia.length) || 0;
  const base = n > 4000 ? 350 : n > 1000 ? 250 : 150;
  const fuzzy = document.getElementById('fuzzySearch')?.checked;
  return fuzzy ? base + 150 : base;
}

searchInput.addEventListener('input', () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => {
    requestAnimationFrame(() => setTimeout(() => applyFilters(), 0));
  }, searchDebounceMs());
  // Update star button and clear button visibility immediately
  if (typeof updateSearchStarButton === 'function') {
    updateSearchStarButton();
  }
  updateSearchClearButton();
});

// Clear search input
function clearSearchInput() {
  searchInput.value = '';
  updateSearchClearButton();
  if (typeof updateSearchStarButton === 'function') {
    updateSearchStarButton();
  }
  applyFilters();
  searchInput.focus();
}

function updateSearchClearButton() {
  const btn = document.getElementById('searchClearBtn');
  if (btn) {
    btn.style.display = searchInput.value.trim() ? 'flex' : 'none';
  }
}

// Filter change handlers — dropdowns
document.querySelectorAll('#filterContent, #filterLanguage, #filterMinRating, #filterTheme, #filterQuality').forEach(select => {
  select.addEventListener('change', applyFilters);
});

// Initialize tri-state filter buttons
if (typeof initTriFilters === 'function') initTriFilters();

// Set view (grid/list)
// (List view removed — the viewer is grid-only now)

// Clear filters button
// Clear filters clears the FILTERS. The search text is a separate thing the
// user typed, and wiping it here was the round-5 behaviour people tripped on.
document.getElementById('clearFiltersBtn').addEventListener('click', () => {
  // Reset dropdowns
  document.querySelectorAll('select[id^="filter"]').forEach(select => {
    select.value = '';
  });
  const minRating = document.getElementById('filterMinRating');
  if (minRating) minRating.value = '0';
  // Reset all tri-state filters to "All"
  document.querySelectorAll('.tri-filter').forEach(filter => {
    filter.querySelectorAll('.tri-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.value === '');
    });
  });
  // …except Trashed, whose default is Hidden
  if (typeof setTriFilterValue === 'function') {
    setTriFilterValue('filterTrashed', '0');
  }
  // Reset type bubbles / safe / extensions / duration range
  if (typeof selectedExtensions !== 'undefined') {
    selectedExtensions = [];
    selectedMediaTypes = [];
    safeOnly = false;
    const minEl = document.getElementById('durMinSlider');
    const maxEl = document.getElementById('durMaxSlider');
    if (minEl && maxEl) {
      minEl.value = '0';
      maxEl.value = maxEl.max;
      if (typeof updateDurationUI === 'function') updateDurationUI();
    }
    renderMediaTypeBar();
    renderTypeExtensionFilter();
  }
  // Deactivate any active saved search
  if (typeof activeSavedSearchId !== 'undefined') {
    activeSavedSearchId = null;
  }
  // Clear an active audio-similarity ranking too
  if (typeof audioSimScores !== 'undefined' && audioSimScores) {
    audioSimAnchorId = null;
    audioSimScores = null;
    if (typeof renderAudioSimBar === 'function') renderAudioSimBar();
  }
  applyFilters();
  if (typeof updateSearchStarButton === 'function') {
    updateSearchStarButton();
  }
  updateSearchClearButton();
});

// Metadata search toggle
document.getElementById('metadataOnly').addEventListener('change', () => {
  if (typeof invalidateFuse === 'function') invalidateFuse();
  applyFilters();
});

// Fuzzy search toggle
document.getElementById('fuzzySearch').addEventListener('change', () => {
  if (typeof invalidateFuse === 'function') invalidateFuse();
  applyFilters();
});

// Semantic search toggle
document.getElementById('semanticSearch')?.addEventListener('change', () => {
  applyFilters();
});

// Subtitle-text search toggle (English subtitles/translations into the corpus)
document.getElementById('subtitleSearch')?.addEventListener('change', () => {
  if (typeof invalidateFuse === 'function') invalidateFuse();
  applyFilters();
});

// Refresh button — re-fetch the library from the server
let isRefreshing = false;
const refreshBtn = document.getElementById('refreshBtn');
refreshBtn.addEventListener('click', async () => {
  if (isRefreshing) return;

  isRefreshing = true;
  refreshBtn.disabled = true;
  refreshBtn.textContent = '⏳ Loading...';

  try {
    await loadDatabase();
    showToast('Library refreshed!');
  } catch (err) {
    console.error('Refresh failed:', err);
    showToast('Refresh failed!');
  } finally {
    setTimeout(() => {
      isRefreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = '🔄 Refresh';
    }, 1000);
  }
});

// Media info overlay click handler (close on background click)
document.getElementById('mediaInfoOverlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    closeMediaInfo();
  }
});

// Re-fit the grid on window resize (columns + complete-row page size)
// The grid watches its own size (cards.js initGridObservers), which covers
// window resizes and any bar above it showing or hiding.

// ── Collapsible search section ──────────────────────────────────────────
function setSearchCollapsed(collapsed) {
  const section = document.querySelector('.search-section');
  const btn = document.getElementById('searchCollapseBtn');
  if (!section || !btn) return;
  section.classList.toggle('collapsed', collapsed);
  btn.textContent = collapsed ? '▼ Search' : '▲ Search';
  btn.title = collapsed ? 'Show search & filters' : 'Hide search & filters';
  try { localStorage.setItem('searchCollapsed', collapsed ? '1' : '0'); } catch {}
}

document.getElementById('searchCollapseBtn')?.addEventListener('click', () => {
  const section = document.querySelector('.search-section');
  setSearchCollapsed(!section.classList.contains('collapsed'));
});

// Initialize page — load the library immediately
document.addEventListener('DOMContentLoaded', () => {
  console.log('DB Viewer initialized (server mode)');
  // Restore collapsed state before first render
  try {
    if (localStorage.getItem('searchCollapsed') === '1') setSearchCollapsed(true);
  } catch {}
  loadDatabase();
});

// Global keyboard shortcuts (when not in media player)
document.addEventListener('keydown', (e) => {
  // Don't capture when focused on inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

  // Mini player shortcuts (active when mini player is showing)
  const miniPlayer = document.getElementById('miniPlayer');
  if (miniPlayer && miniPlayer.classList.contains('active')) {
    if (e.key === 'Escape') {
      closeMiniPlayer();
      return;
    }
    if (e.key === 'q' || e.key === 'Q') {
      maximizePlayer();
      return;
    }
    if (e.key === ' ') {
      e.preventDefault();
      miniTogglePlay();
      return;
    }
    // The same queue keys as the full player. Minimizing changes the size of
    // the window, not the queue, and the file these land on now opens in the
    // mini player rather than throwing the full overlay back up.
    if (e.key === 'n' || e.key === 'N') {
      playNextMedia();
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      playPreviousMedia();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      playRandomMedia();
      return;
    }
    return;
  }

  // Don't capture when full media player is open (handled by player-controls.js)
  const overlay = document.getElementById('mediaPlayerOverlay');
  if (overlay.classList.contains('active')) return;

  // Close modal on Escape
  if (e.key === 'Escape') {
    closeModal();
    hideTilePopover();
  }
});
