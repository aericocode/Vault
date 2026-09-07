/* ==========================================
   Library loading — from the viewer server API

   Replaces the old sql.js/WASM path where the .db was parsed in the
   browser. All reads come from GET /api/media; writes go through the
   flag/search endpoints (see notes.js / saved-searches.js).
   ========================================== */

/**
 * Load (or reload) the media library from the server.
 */
async function loadDatabase() {
  try {
    // Before the first tile renders: vault mode decides whether the browser
    // may cache a thumbnail at all, and that changes the <img> markup.
    await initThumbMode();
    const resp = await fetch('/api/media');
    if (resp.status === 423) {
      // Vault locked — the lock screen (vault-ui.js) owns the UI; keep the
      // library empty rather than surfacing an error toast.
      allMedia = [];
      const el = document.getElementById('totalCount');
      if (el) el.textContent = '🔒 Vault locked';
      return;
    }
    if (!resp.ok) {
      throw new Error(`Server returned ${resp.status}`);
    }
    allMedia = await resp.json();

    // Populate filters
    populateFilters();

    // Invalidate fuse search index (data changed)
    if (typeof invalidateFuse === 'function') invalidateFuse();

    // Build duplicate detection index
    if (typeof buildDuplicateIndex === 'function') buildDuplicateIndex();

    // Build extension map + render the type bubbles / extension chips /
    // duration slider (sized to the library's longest item)
    buildExtensionMap();
    renderMediaTypeBar();
    renderTypeExtensionFilter();
    if (typeof initDurationSlider === 'function') initDurationSlider();

    // First load only: restore the last session's search/toggles/term so
    // the app relaunches right where it was left
    if (!window._searchStateRestored) {
      window._searchStateRestored = true;
      if (typeof restoreLastSearchState === 'function') restoreLastSearchState();
    }

    // Show WHICH database file this server is serving (catches accidentally
    // launching against a test/other DB — the count alone can't tell you)
    fetch('/api/dbinfo').then(r => r.ok ? r.json() : null).then(info => {
      if (!info) return;
      const el = document.getElementById('totalCount');
      if (el && !document.getElementById('dbFileName')) {
        el.insertAdjacentHTML('afterend',
          ` <span id="dbFileName" title="${escapeHtml(info.path)}" style="font-size:0.75rem;color:var(--text-muted);margin-left:0.5rem;">📁 ${escapeHtml(info.filename)}</span>`);
      }
    }).catch(() => {});

    // Load and render saved searches
    await loadSavedSearches();
    renderSavedSearches();

    // Count only media files (exclude document)
    const allowedMediaTypes = ['video', 'audio', 'image', 'gif'];
    const mediaCount = allMedia.filter(m => allowedMediaTypes.includes(m.media_type)).length;
    const hiddenCount = allMedia.length - mediaCount;

    // Get hidden media types for tooltip
    const hiddenTypes = [...new Set(
      allMedia
        .filter(m => !allowedMediaTypes.includes(m.media_type))
        .map(m => m.media_type)
    )].sort();

    const totalCountElement = document.getElementById('totalCount');
    if (hiddenCount > 0) {
      totalCountElement.textContent = `${mediaCount.toLocaleString()} media files loaded (${hiddenCount.toLocaleString()} hidden)`;
      totalCountElement.title = `Hidden file types: ${hiddenTypes.join(', ')}`;
    } else {
      totalCountElement.textContent = `${mediaCount.toLocaleString()} media files loaded`;
      totalCountElement.title = '';
    }

    // Initial render
    applyFilters();

    // Any ⏳ rows (scan running now, or resumed later — even a CLI scan) get
    // watched so their AI data pops in without a manual 🔄 Refresh
    watchUnscanned();

    // Signal that the library rows are loaded (settings.js listens once, to
    // restore the last session after the data it needs is available).
    window.dispatchEvent(new CustomEvent('vault:library-loaded'));
  } catch (err) {
    console.error('Failed to load library:', err);
    const totalCountElement = document.getElementById('totalCount');
    if (totalCountElement) {
      totalCountElement.textContent = '⚠ Could not load library — is the server running?';
    }
    showToast('Failed to load library: ' + err.message);
  }
}

/**
 * Find a media item by id (rows come from the server with ids).
 */
function getMediaById(id) {
  return allMedia.find(m => m.id === id) || null;
}

/* ── Auto-refresh for AI scan results ──────────────────────────────────────
   New files appear instantly with ⏳ (processing_error 'unscanned') while a
   scan — the in-app import queue OR an external CLI run — fills the AI
   fields in the background. Watch those rows and patch them in place the
   moment a scan lands (or fails: ⏳ → ⚠), so tile hovers and the open
   sidebar show the data without hitting 🔄 Refresh. Same poll-and-patch
   pattern as the importer's duration watcher, sharing POST /api/media/rows.
   Self-stopping: the interval clears itself once nothing is pending. */

let _scanWatchTimer = null;
let _scanWatchBusy = false;
const SCAN_WATCH_MS = 5000;

/** One poll round: fetch fresh rows for the ⏳ ids, patch the ones whose scan
 *  finished, repaint. Self-clears the interval when nothing is pending. */
async function _scanWatchTick() {
  if (_scanWatchBusy) return;                          // a slow round is still in flight
  const pending = allMedia
    .filter(m => m.processing_error === 'unscanned')
    .map(m => m.id);
  if (!pending.length) {
    if (_scanWatchTimer) { clearInterval(_scanWatchTimer); _scanWatchTimer = null; }
    return;
  }

  _scanWatchBusy = true;
  try {
    let rows = [];
    try {
      const resp = await fetch('/api/media/rows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: pending.slice(0, 2000) }),
      });
      if (!resp.ok) return;                            // locked/busy — next round
      rows = (await resp.json()).rows || [];
    } catch { return; }

    const done = rows.filter(r => r && r.processing_error !== 'unscanned');
    if (!done.length) return;

    let sidebarItem = null;
    for (const row of done) {
      const local = getMediaById(row.id);
      if (!local) continue;
      Object.assign(local, row);                       // grid/popovers read this object
      if (typeof currentMediaState !== 'undefined' &&
          currentMediaState?.currentMediaData?.id === row.id) {
        sidebarItem = local;
      }
    }

    // One repaint per batch; fresh themes/languages join the filter dropdowns
    try {
      populateFilters();
      if (typeof invalidateFuse === 'function') invalidateFuse();
      if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
      else if (typeof renderResults === 'function') renderResults();
      if (sidebarItem && typeof sidebarOpen !== 'undefined' && sidebarOpen &&
          typeof renderSidebar === 'function') {
        currentMediaState.currentMediaData = sidebarItem;
        renderSidebar();                               // live update mid-watch
      }
    } catch { /* a repaint hiccup never kills the watcher */ }
  } finally {
    _scanWatchBusy = false;
  }
}

function watchUnscanned() {
  if (_scanWatchTimer) return;   // already watching — pending set is re-read each round
  if (!allMedia.some(m => m.processing_error === 'unscanned')) return;
  // Rounds are skipped while the tab is hidden (no point painting a page
  // nobody sees); the visibilitychange listener below catches up instantly.
  _scanWatchTimer = setInterval(() => { if (!document.hidden) _scanWatchTick(); }, SCAN_WATCH_MS);
}

// Returning to the tab after the scan worked in the background → immediate
// round instead of waiting out the interval.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && _scanWatchTimer) _scanWatchTick();
});

// Populate filter dropdowns
function populateFilters() {
  const contentTypes = [...new Set(allMedia.map(m => m.content_type).filter(Boolean))].sort();
  // Languages: canonical display names (server-provided language_name), so
  // "en"/"EN"/"English" collapse to one "English" option. English pinned first,
  // "Unknown" pushed last, the rest alphabetical.
  let languages = [...new Set(allMedia.map(m => m.language_name).filter(Boolean))].sort();
  const en = languages.filter(l => l === 'English');
  const rest = languages.filter(l => l !== 'English' && l !== 'Unknown');
  const unk = languages.filter(l => l === 'Unknown');
  languages = [...en, ...rest, ...unk];
  const qualities = [...new Set(allMedia.map(m => m.quality_flag).filter(Boolean))].sort();

  // Collect all themes from the CLEAN copy (falls back to raw when a row hasn't
  // been normalized yet — e.g. before the first `clean` backfill)
  const themes = new Set();
  allMedia.forEach(m => {
    try {
      const t = JSON.parse(m.themes_clean || m.themes || '[]');
      t.forEach(theme => themes.add(theme));
    } catch {}
  });

  populateSelect('filterContent', contentTypes);
  populateSelect('filterLanguage', languages);
  populateSelect('filterQuality', qualities);
  populateSelect('filterTheme', [...themes].sort());

  // Theme / content / language get a type-to-search combo over the select
  if (typeof initSearchableSelects === 'function') initSearchableSelects();
  if (typeof syncSearchableSelects === 'function') syncSearchableSelects();
}

function populateSelect(id, options) {
  const select = document.getElementById(id);
  const currentValue = select.value;
  while (select.options.length > 1) select.remove(1);
  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt;
    option.textContent = opt;
    select.appendChild(option);
  });
  select.value = currentValue;
}
