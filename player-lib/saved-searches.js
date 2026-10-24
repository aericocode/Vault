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
    if (!resp.ok) throw Object.assign(new Error(`Server returned ${resp.status}`), { name: 'HttpError', status: resp.status });
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
    // The lists fill from the library-wide counts, which may not be here yet
    // (or, for themes, carry only the most used): keep the saved value.
    if (el && typeof ensureSelectOption === 'function') ensureSelectOption(el, value);
    if (el) el.value = value;
  });

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

  return applyFilters();
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
    showToast('This search is already saved.');
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
    if (!resp.ok) throw Object.assign(new Error(`Server returned ${resp.status}`), { name: 'HttpError', status: resp.status });

    await loadSavedSearches();
    renderSavedSearches();
    updateSearchStarButton();
    showToast('Search saved.', { type: 'success' });
  } catch (err) {
    console.error('[SavedSearches] Failed to save:', err);
    showErrorToast(err, 'saving the search');
  }
}

/**
 * Delete a saved search by id.
 */
async function deleteSavedSearch(id) {
  try {
    const resp = await fetch(`/api/searches/${id}`, { method: 'DELETE' });
    if (!resp.ok) throw Object.assign(new Error(`Server returned ${resp.status}`), { name: 'HttpError', status: resp.status });

    if (activeSavedSearchId === id) {
      activeSavedSearchId = null;
    }

    await loadSavedSearches();
    renderSavedSearches();
    updateSearchStarButton();
    showToast('Saved search removed.');
  } catch (err) {
    console.error('[SavedSearches] Failed to delete:', err);
    showErrorToast(err, 'removing the saved search');
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
  // The Modern look's left rail lists them too (player-lib/filter-rail.js).
  if (typeof renderFilterRail === 'function') renderFilterRail();
  // ...and the panel under the search box, while it is open (a remove from its x).
  if (_ssd.open) ssdRender();

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
        <button class="saved-search-delete" onclick="event.stopPropagation(); deleteSavedSearch(${s.id})"
          title="Remove this saved search" aria-label="Remove the saved search ${label}">${typeof vaultIconSwap === 'function' ? vaultIconSwap('✕', 'close') : '✕'}</button>
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
  // Classic keeps the star glyph; Modern draws the line star, filled once saved.
  btn.innerHTML = typeof vaultIconSwap === 'function' ? vaultIconSwap(isSaved ? '★' : '☆', 'star') : (isSaved ? '★' : '☆');
  btn.classList.toggle('saved', isSaved);
  btn.disabled = isSaved;
  btn.title = isSaved ? 'Already saved' : 'Save this search';
}

// ── Modern: the saved searches panel under the search box ──────────────
//
// Clicking or focusing the empty library search box opens a small panel under
// the left of the box: each saved search is a compact pill (name only).
// Clicking a pill runs it (activateSavedSearch, the same as the rail). Typing
// narrows the pills (by name or query, any case); typed text that matches
// nothing hides the panel so normal typing is unaffected. Arrows move pill to
// pill, Enter picks; nothing is highlighted on open, so Enter alone is the
// normal search. The pencil turns on edit mode: every pill shows an x that
// removes it (deleteSavedSearch, no confirm), as do Delete / Backspace on the
// highlighted pill, and pill bodies stop running. Esc leaves edit mode first,
// then closes the panel; the focus stays in the box. A click outside or Tab
// closes it (and ends edit mode). There is no recent-searches store, so there
// is no Recent section. Classic keeps its chip row only.

/** The saved searches whose name or query contains `query` (any case). An
 *  empty query lists them all, in their saved order. */
function savedSearchMatches(list, query) {
  const all = Array.isArray(list) ? list : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return all.slice();
  return all.filter(s => {
    if (!s) return false;
    const text = s.search_text != null ? s.search_text : (s.filters && s.filters.searchText);
    return String(s.name || '').toLowerCase().includes(q) || String(text || '').toLowerCase().includes(q);
  });
}

/** The highlighted pill after moving back (delta -1) or on (+1) through
 *  `count` pills; -1 is "nothing highlighted". On from nothing is the first,
 *  back from nothing or the first is the last, on from the last wraps. */
function savedSearchMoveIndex(index, delta, count) {
  if (!(count > 0)) return -1;
  const i = Number.isInteger(index) && index >= 0 && index < count ? index : -1;
  if (delta > 0) return (i + 1) % count;
  return i <= 0 ? count - 1 : i - 1;
}

/** Whether the panel shows, and with which pills: hidden when the box has
 *  text that no saved search matches; an empty box always shows it (with no
 *  saved searches it says how to add one). */
function savedSearchDropdownState(list, query) {
  const rows = savedSearchMatches(list, query);
  const typed = !!String(query || '').trim();
  return { rows, show: !typed || rows.length > 0, empty: !(Array.isArray(list) && list.length) };
}

/**
 * What a key does while the panel is open. `st` is { index, count, editing,
 * typed } (typed: the box has text, so Left / Right move the caret until a
 * pill is highlighted). Returns null (the key is the box's), or
 * { type: 'move', index } | { type: 'pick', index } | { type: 'remove', index }
 * | { type: 'search' } | { type: 'leave-edit' } | { type: 'close' } | { type: 'none' }.
 */
function savedSearchKeyAction(key, st) {
  const { index = -1, count = 0, editing = false, typed = false } = st || {};
  const hl = Number.isInteger(index) && index >= 0 && index < count;
  if (key === 'ArrowDown' || key === 'ArrowUp' || ((key === 'ArrowRight' || key === 'ArrowLeft') && (!typed || hl))) {
    if (!count) return null;
    return { type: 'move', index: savedSearchMoveIndex(index, key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1, count) };
  }
  if (key === 'Enter') {
    if (!hl) return { type: 'search' };
    return editing ? { type: 'none' } : { type: 'pick', index };
  }
  if ((key === 'Delete' || key === 'Backspace') && editing && hl) return { type: 'remove', index };
  if (key === 'Escape') return editing ? { type: 'leave-edit' } : { type: 'close' };
  return null;
}

/** The pill to highlight after the one at `index` is removed from `count`:
 *  the next one moves into its place, or the new last one; -1 when none left. */
function savedSearchIndexAfterRemove(index, count) {
  const left = count - 1;
  if (!(left > 0) || !(index >= 0)) return -1;
  return Math.min(index, left - 1);
}

const _ssd = { open: false, dismissed: false, editing: false, index: -1, rows: [], afterRemove: null };

function ssdEls() {
  return { input: document.getElementById('searchInput'), box: document.getElementById('savedSearchDropdown') };
}

function ssdIsModern() {
  return typeof window !== 'undefined' && typeof window.isModernLayout === 'function' && window.isModernLayout();
}

function ssdClose(opts) {
  const { input, box } = ssdEls();
  _ssd.open = false;
  _ssd.editing = false;
  _ssd.index = -1;
  if (opts && opts.dismiss) _ssd.dismissed = true;
  if (box) { box.hidden = true; box.classList.remove('is-editing'); }
  if (input) {
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
}

/** Draw the panel for what is in the box now, or hide it. */
function ssdRender() {
  const { input, box } = ssdEls();
  if (!input || !box) return;
  if (!ssdIsModern() || _ssd.dismissed || document.activeElement !== input || input.disabled) { ssdClose(); return; }
  const st = savedSearchDropdownState(savedSearches, input.value);
  if (!st.show) { ssdClose(); return; }
  const prev = _ssd.rows[_ssd.index];
  let index = prev ? st.rows.findIndex(s => s.id === prev.id) : -1;
  if (index < 0 && _ssd.afterRemove != null) index = Math.min(_ssd.afterRemove, st.rows.length - 1);
  _ssd.afterRemove = null;
  _ssd.rows = st.rows;
  _ssd.index = index;
  if (st.empty) _ssd.editing = false;
  const icon = (n) => (typeof vaultIcon === 'function' ? vaultIcon(n) : '');
  const edit = _ssd.editing;
  box.classList.toggle('is-editing', edit);
  box.innerHTML = st.empty
    ? `<div class="ssd-head"><span class="ssd-h">Saved searches</span></div>
       <p class="ssd-empty">No saved searches yet.</p>
       <div class="ssd-foot">Star a search to keep it here</div>`
    : `<div class="ssd-head"><span class="ssd-h" id="ssdHead">Saved searches</span>
         <button type="button" class="ssd-edit" data-ssd-edit tabindex="-1" aria-pressed="${edit ? 'true' : 'false'}">${icon('edit')}<span>${edit ? 'Done' : 'Edit'}</span></button></div>
       <div class="ssd-pills" role="listbox" aria-labelledby="ssdHead">${st.rows.map(s => {
         const name = escapeHtml(s.name);
         return `<div class="ssd-pill" role="option" id="ssdOpt${s.id}" data-ssd-id="${s.id}" aria-selected="false">
           <span class="ssd-name">${name}</span>${edit ? `<button type="button" class="ssd-x" data-ssd-del="${s.id}" tabindex="-1"
                   title="Remove this saved search" aria-label="Remove the saved search ${name}">${icon('close')}</button>` : ''}
         </div>`;
       }).join('')}</div>
       <div class="ssd-foot">${edit ? 'Editing: click an x to remove. Press Done to finish.' : 'Arrows to move, Enter to search'}</div>`;
  box.hidden = false;
  _ssd.open = true;
  input.setAttribute('aria-expanded', 'true');
  ssdSyncHighlight();
}

function ssdSyncHighlight() {
  const { input, box } = ssdEls();
  if (!box) return;
  box.querySelectorAll('.ssd-pill').forEach((el, i) => {
    const on = i === _ssd.index;
    el.classList.toggle('is-hl', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  });
  const cur = _ssd.rows[_ssd.index];
  if (!input) return;
  if (cur) input.setAttribute('aria-activedescendant', `ssdOpt${cur.id}`);
  else input.removeAttribute('aria-activedescendant');
}

function ssdSetEditing(on) {
  _ssd.editing = !!on;
  ssdRender();
}

function ssdRemove(id) {
  const i = _ssd.rows.findIndex(s => s.id === id);
  _ssd.afterRemove = i === _ssd.index ? savedSearchIndexAfterRemove(i, _ssd.rows.length) : null;
  return deleteSavedSearch(id);
}

function ssdPick(id) {
  ssdClose({ dismiss: true });
  activateSavedSearch(id);
  if (typeof updateSearchStarButton === 'function') updateSearchStarButton();
  if (typeof updateSearchClearButton === 'function') updateSearchClearButton();
}

function ssdOnKeydown(e) {
  if (!ssdIsModern() || e.isComposing) return;
  const { input } = ssdEls();
  if (!_ssd.open) {
    // After Esc or a pick, Down opens the panel again; Enter is the normal search.
    if (e.key === 'ArrowDown') {
      _ssd.dismissed = false;
      ssdRender();
      if (_ssd.open) e.preventDefault();
    } else if (e.key === 'Enter' && typeof flushPendingSearch === 'function') {
      flushPendingSearch();
    }
    return;
  }
  const act = savedSearchKeyAction(e.key, {
    index: _ssd.index, count: _ssd.rows.length, editing: _ssd.editing, typed: !!(input && input.value),
  });
  if (!act) return;
  if (act.type === 'search') {
    ssdClose({ dismiss: true });
    if (typeof flushPendingSearch === 'function') flushPendingSearch();
    return;
  }
  e.preventDefault();
  if (act.type === 'move') { _ssd.index = act.index; ssdSyncHighlight(); }
  else if (act.type === 'pick') ssdPick(_ssd.rows[act.index].id);
  else if (act.type === 'remove') ssdRemove(_ssd.rows[act.index].id);
  else if (act.type === 'leave-edit') ssdSetEditing(false);
  else if (act.type === 'close') ssdClose({ dismiss: true });
}

function ssdInit() {
  const { input } = ssdEls();
  if (!input || document.getElementById('savedSearchDropdown')) return;
  const box = document.createElement('div');
  box.id = 'savedSearchDropdown';
  box.className = 'ssd';
  box.hidden = true;
  input.insertAdjacentElement('afterend', box);
  input.setAttribute('aria-controls', 'savedSearchDropdown');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('autocomplete', 'off');

  input.addEventListener('focus', () => { _ssd.dismissed = false; ssdRender(); });
  // A click into a box that already has focus (after Esc or a pick) opens it again.
  input.addEventListener('mousedown', () => {
    if (document.activeElement !== input || _ssd.open) return;
    _ssd.dismissed = false;
    setTimeout(ssdRender, 0);
  });
  input.addEventListener('input', () => { _ssd.dismissed = false; _ssd.index = -1; _ssd.rows = []; ssdRender(); });
  input.addEventListener('keydown', ssdOnKeydown);
  // Tab or a click elsewhere: the panel goes with the focus (and edit mode ends).
  input.addEventListener('blur', () => ssdClose());

  // Keep the focus in the box while the panel is used with the mouse.
  box.addEventListener('mousedown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-ssd-edit]')) { ssdSetEditing(!_ssd.editing); return; }
    const del = e.target.closest('[data-ssd-del]');
    if (del) { e.stopPropagation(); ssdRemove(Number(del.dataset.ssdDel)); return; }
    const pill = e.target.closest('[data-ssd-id]');
    if (pill && !_ssd.editing) ssdPick(Number(pill.dataset.ssdId));
  });

  // Esc is the panel's while it is open (edit mode first, then the panel), not
  // the filter sheet's or anything behind it: this runs ahead of the
  // document's own Esc handlers.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !_ssd.open || e.target !== input) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (_ssd.editing) ssdSetEditing(false);
    else ssdClose({ dismiss: true });
  }, true);
}

if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ssdInit);
  else ssdInit();
}
