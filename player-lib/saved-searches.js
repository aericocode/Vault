/* =========================================================================
   SAVED SEARCHES - Persistent search presets stored in the DB
   ========================================================================= */

// In-memory cache of saved searches
let savedSearches = [];

// Currently active saved search id (null = none)
let activeSavedSearchId = null;

/**
 * Load all saved searches from the server into memory.
 */
async function loadSavedSearches() {
  savedSearches = [];
  try {
    const resp = await fetch('/api/searches');
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const rows = await resp.json();
    savedSearches = rows.map(row => ({
      ...row,
      filters: safeParseJSON(row.filters, {}),
    }));
  } catch (err) {
    console.error('[SavedSearches] Failed to load:', err);
  }
}

/**
 * Capture the current search/filter state as a serializable object.
 */
function captureCurrentFilterState() {
  return {
    searchText: document.getElementById('searchInput')?.value || '',
    metadataOnly: document.getElementById('metadataOnly')?.checked || false,
    fuzzySearch: document.getElementById('fuzzySearch')?.checked || false,
    semanticSearch: document.getElementById('semanticSearch')?.checked || false,
    mediaTypes: typeof selectedMediaTypes !== 'undefined' ? [...selectedMediaTypes] : [],
    safeOnly: typeof safeOnly !== 'undefined' ? safeOnly : false,
    filterContent: document.getElementById('filterContent')?.value || '',
    filterLanguage: document.getElementById('filterLanguage')?.value || '',
    filterCollections: typeof getTriFilterValue === 'function' ? getTriFilterValue('filterCollections') : '',
    filterStarred: typeof getTriFilterValue === 'function' ? getTriFilterValue('filterStarred') : '',
    filterHasNotes: typeof getTriFilterValue === 'function' ? getTriFilterValue('filterHasNotes') : '',
    filterDuplicates: typeof getTriFilterValue === 'function' ? getTriFilterValue('filterDuplicates') : '',
    filterFlagged: typeof getTriFilterValue === 'function' ? getTriFilterValue('filterFlagged') : '',
    filterScanStatus: typeof getTriFilterValue === 'function' ? getTriFilterValue('filterScanStatus') : '',
    filterMinRating: document.getElementById('filterMinRating')?.value || '0',
    filterTheme: document.getElementById('filterTheme')?.value || '',
    filterQuality: document.getElementById('filterQuality')?.value || '',
    durMin: typeof durMinM !== 'undefined' ? durMinM : 0,
    durMax: typeof durMaxM !== 'undefined' ? durMaxM : null,
    selectedExtensions: selectedExtensions ? [...selectedExtensions] : [],
    sortValue: currentSort || 'processed_desc',
    favesFirst: typeof favesFirst !== 'undefined' ? favesFirst : false,
  };
}

/**
 * Restore a saved filter state to the UI.
 */
function restoreFilterState(state) {
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.value = state.searchText || '';

  const metadataOnly = document.getElementById('metadataOnly');
  if (metadataOnly) metadataOnly.checked = state.metadataOnly || false;

  const fuzzySearch = document.getElementById('fuzzySearch');
  if (fuzzySearch) fuzzySearch.checked = state.fuzzySearch || false;

  const semantic = document.getElementById('semanticSearch');
  if (semantic) semantic.checked = state.semanticSearch || false;

  // Dropdown selects
  const selects = {
    filterContent: state.filterContent || '',
    filterLanguage: state.filterLanguage || '',
    filterMinRating: state.filterMinRating || '0',
    filterTheme: state.filterTheme || '',
    filterQuality: state.filterQuality || '',
  };

  Object.entries(selects).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (el) el.value = value;
  });
  if (typeof syncSearchableSelects === 'function') syncSearchableSelects();

  // Media-type bubbles + safe toggle (legacy saves stored filterType single)
  if (typeof selectedMediaTypes !== 'undefined') {
    selectedMediaTypes = Array.isArray(state.mediaTypes) ? [...state.mediaTypes]
      : (state.filterType ? [state.filterType] : []);
    safeOnly = state.safeOnly || false;
    renderMediaTypeBar();
  }

  // Tri-state filters
  if (typeof setTriFilterValue === 'function') {
    setTriFilterValue('filterCollections', state.filterCollections || '');
    setTriFilterValue('filterStarred', state.filterStarred || '');
    setTriFilterValue('filterHasNotes', state.filterHasNotes || '');
    setTriFilterValue('filterDuplicates', state.filterDuplicates || '');
    setTriFilterValue('filterFlagged', state.filterFlagged || '');
    setTriFilterValue('filterScanStatus', state.filterScanStatus || '');
  }

  // Duration range — stored in MINUTES, sliders run on the weighted 0–100
  // position scale (legacy filterDuration was seconds)
  const minEl = document.getElementById('durMinSlider');
  const maxEl = document.getElementById('durMaxSlider');
  if (minEl && maxEl && typeof minutesToPos === 'function') {
    const legacyMin = state.filterDuration ? Math.round(Number(state.filterDuration) / 60) : 0;
    const wantMin = typeof state.durMin === 'number' ? state.durMin : legacyMin;
    const wantMax = (typeof state.durMax === 'number') ? state.durMax : null;
    minEl.value = String(minutesToPos(wantMin));
    maxEl.value = wantMax == null ? '100' : String(minutesToPos(wantMax));
    if (typeof updateDurationUI === 'function') updateDurationUI();
  }

  if (typeof selectedExtensions !== 'undefined') {
    selectedExtensions = state.selectedExtensions || [];
    renderTypeExtensionFilter();
  }

  if (state.sortValue) {
    // Legacy saves: 'starred_desc' was a sort option before ❤ became a toggle
    if (state.sortValue.startsWith('starred')) {
      currentSort = 'rating_desc';
      favesFirst = true;
    } else {
      currentSort = state.sortValue;
    }
  }
  if (typeof state.favesFirst === 'boolean') favesFirst = state.favesFirst;
  if (typeof syncSortControls === 'function') syncSortControls();

  applyFilters();
}

// ── Save / Delete / Activate ────────────────────────────────────────────

/**
 * Save the current search from the input star button.
 * Uses the search text as the label.
 */
async function saveSearchFromInput() {
  const state = captureCurrentFilterState();
  const name = state.searchText.trim();
  if (!name) return;

  // Check for duplicate name
  const exists = savedSearches.find(s => s.name === name);
  if (exists) {
    showToast('Already saved');
    return;
  }

  try {
    const maxOrder = savedSearches.length > 0
      ? Math.max(...savedSearches.map(s => s.sort_order || 0)) + 1
      : 0;

    const resp = await fetch('/api/searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        search_text: state.searchText,
        filters: state,
        sort_order: maxOrder,
      }),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

    await loadSavedSearches();
    renderSavedSearches();
    updateSearchStarButton();
    showToast('Search saved');
  } catch (err) {
    console.error('[SavedSearches] Failed to save:', err);
    showToast('⚠ Failed to save search');
  }
}

/**
 * Delete a saved search by id.
 */
async function deleteSavedSearch(id) {
  try {
    const resp = await fetch(`/api/searches/${id}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);

    if (activeSavedSearchId === id) {
      activeSavedSearchId = null;
    }

    await loadSavedSearches();
    renderSavedSearches();
    updateSearchStarButton();
    showToast('Search removed');
  } catch (err) {
    console.error('[SavedSearches] Failed to delete:', err);
    showToast('⚠ Failed to delete search');
  }
}

/**
 * Activate a saved search — restore its filter state.
 */
function activateSavedSearch(id) {
  const search = savedSearches.find(s => s.id === id);
  if (!search) return;

  // Toggle off if already active
  if (activeSavedSearchId === id) {
    activeSavedSearchId = null;
    renderSavedSearches();
    return;
  }

  activeSavedSearchId = id;
  restoreFilterState(search.filters);
  renderSavedSearches();
}

// ── UI Rendering ────────────────────────────────────────────────────────

/**
 * Render the saved searches chip bar.
 */
function renderSavedSearches() {
  const container = document.getElementById('savedSearchesBar');
  if (!container) return;

  if (savedSearches.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'flex';

  let html = '';
  savedSearches.forEach(s => {
    const isActive = activeSavedSearchId === s.id;
    const label = escapeHtml(s.name);

    html += `
      <div class="saved-search-chip ${isActive ? 'active' : ''}" data-search-id="${s.id}">
        <button class="saved-search-activate" onclick="activateSavedSearch(${s.id})" title="${label}">
          ${label}
        </button>
        <button class="saved-search-delete" onclick="event.stopPropagation(); deleteSavedSearch(${s.id})" title="Remove">✕</button>
      </div>
    `;
  });

  container.innerHTML = html;
}

/**
 * Update the star button in the search box.
 * Shows when there's text, filled star if already saved.
 */
function updateSearchStarButton() {
  const btn = document.getElementById('searchSaveStar');
  const input = document.getElementById('searchInput');
  if (!btn || !input) return;

  const text = input.value.trim();
  if (!text) {
    btn.style.display = 'none';
    return;
  }

  btn.style.display = 'flex';

  const isSaved = savedSearches.some(s => s.name === text);
  btn.textContent = isSaved ? '★' : '☆';
  btn.classList.toggle('saved', isSaved);
  btn.disabled = isSaved;
  btn.title = isSaved ? 'Already saved' : 'Save this search';
}
