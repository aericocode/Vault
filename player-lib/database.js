/* ==========================================
   Library loading — from the viewer server API

   The browser never downloads the library. On load it asks for the
   library-wide counts (GET /api/library/facets) and the first page of the
   current search (POST /api/library/query, player-lib/library.js) in
   parallel, and the grid paints from that first page. Writes go through the
   flag/search endpoints (see notes.js / saved-searches.js).
   ========================================== */

/**
 * Load (or reload) the library view from the server.
 */
async function loadDatabase() {
  try {
    // A reload (🔄 Refresh) re-reads every row it shows.
    Library.invalidateRows();

    // The server answers one request at a time, so the three the first page
    // needs go out before anything else on the page asks for something:
    //  - vault mode decides whether the browser may cache a thumbnail at all,
    //    and that changes the <img> markup, so the first render waits for it;
    //  - a library unlocked for the first time after the update may still be
    //    building its sort indexes ("preparing"): say so instead of a grid
    //    that never fills, and paint once it is done;
    //  - the first page itself.
    const thumbMode = initThumbMode();
    const boot = Library.boot(showPreparingScreen);
    Library.renderGate = Promise.all([thumbMode, boot]);

    // First load only: restore the last session's search/toggles/term so
    // the app relaunches right where it was left. Either way this runs the
    // first query.
    let first = null;
    if (!window._searchStateRestored) {
      window._searchStateRestored = true;
      if (typeof restoreLastSearchState === 'function') first = restoreLastSearchState() || null;
    }
    if (!first) first = applyFilters();

    const state = await boot;
    hidePreparingScreen();
    if (state === 'locked') {
      // Vault locked — the lock screen (vault-ui.js) owns the UI; keep the
      // library empty rather than surfacing an error toast.
      const el = document.getElementById('totalCount');
      if (el) el.textContent = '🔒 Vault locked';
      return;
    }

    // Then the library-wide counts and the saved searches, once the first
    // page is on screen and its id list has been asked for: the server takes
    // requests in order, and a cold count of a big library takes seconds.
    // The saved searches go first: one small read, so the rail and the panel
    // under the search box list them without waiting behind the counts.
    await first;
    const saved = loadSavedSearches().then(() => renderSavedSearches());
    const facets = Library.refreshFacets();

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

    await Promise.all([first, facets, saved]);

    // Signal that the library is ready (settings.js listens once, to
    // restore the last session after the data it needs is available).
    window.dispatchEvent(new CustomEvent('vault:library-loaded'));
    _loadFailed = false;
  } catch (err) {
    console.error('Failed to load library:', err);
    _loadFailed = true;
    const offline = err instanceof TypeError || (Library.offline && !err.status);
    if (offline) Library.noteServerLost();
    const totalCountElement = document.getElementById('totalCount');
    if (totalCountElement) totalCountElement.textContent = 'Library not loaded';
    showLoadError(offline);
  }
}

/* ── When the library cannot load, or the server goes away ────────────────
   The first load failing leaves the grid saying so with a Try again button
   (only when the grid has nothing in it: tiles already on screen stay). A
   server that stops answering at any time gets one slim notice at the top
   of the header, "Can't reach Vault", with Try again; it goes away by itself
   on the next good answer (Library's version poll every 3 s, see setOffline
   in library.js), and the search re-runs then. */

let _loadFailed = false;

function showLoadError(offline) {
  const grid = document.getElementById('resultsGrid');
  if (!grid || grid.querySelector('.media-tile:not(.tile-skel), .tv-row')) {
    if (!offline) showErrorToast(new Error(''), 'loading the library');
    return;
  }
  const icon = typeof vaultIcon === 'function' ? vaultIcon('alert', 'empty-state-ic') : '';
  grid.classList.add('results-empty');
  delete grid.dataset.gridShape;
  delete grid.dataset.tvShape;
  grid.innerHTML = `<div class="empty-state" role="alert">
      ${icon}
      <div class="empty-state-title">The library could not load</div>
      <div class="empty-state-hint">${offline
        ? 'Vault is not answering. If you closed it, start it again.'
        : 'Something went wrong while loading the library.'}</div>
      <div class="empty-state-actions">
        <button type="button" class="empty-state-btn m-btn is-primary" id="loadRetryBtn">Try again</button>
      </div>
    </div>`;
  grid.querySelector('#loadRetryBtn').addEventListener('click', (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Loading…';
    loadDatabase();
  });
}

function renderServerNotice(offline) {
  let el = document.getElementById('serverNotice');
  if (!offline) {
    if (el) el.remove();
    return;
  }
  if (el) return;
  const header = document.getElementById('appHeader');
  if (!header) return;
  el = document.createElement('div');
  el.id = 'serverNotice';
  el.className = 'server-notice';
  el.setAttribute('role', 'alert');
  const icon = typeof vaultIconSwap === 'function' ? vaultIconSwap('⚠', 'alert') : '⚠';
  el.innerHTML = `
    <span class="server-notice-ic" aria-hidden="true">${icon}</span>
    <span class="server-notice-text"><strong>Can't reach Vault.</strong>
      It may have been closed or restarted. What you see may be out of date.</span>
    <span class="server-notice-status" aria-live="polite"></span>
    <button type="button" class="server-notice-btn">Try again</button>`;
  header.insertBefore(el, header.firstChild);
  const btn = el.querySelector('.server-notice-btn');
  const status = el.querySelector('.server-notice-status');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Checking…';
    const ok = await Library.checkServer();
    if (!btn.isConnected) return;
    btn.disabled = false;
    status.textContent = ok ? '' : 'Still not answering. Start Vault again, then try again.';
  });
}

// vault-ui.js's fetch wrapper sees every request fail: the notice comes up on
// the first one, and the version poll takes it down once the server answers.
window.addEventListener('vault:offline', () => Library.noteServerLost());

window.addEventListener('vault:server-state', (e) => {
  const offline = !!(e.detail && e.detail.offline);
  renderServerNotice(offline);
  // Back after a failed first load: load it properly now.
  if (!offline && _loadFailed) loadDatabase();
});

/* ── After an unlock: the one-time "preparing" step ───────────────────────
   Only an encrypted library unlocked for the first time after the update
   gets here (the server builds its sort indexes after the unlock, not before
   it listens). Each step can hold the server for half a minute at 2M files,
   so Library.boot() polls with no timeout and the screen just says where it
   is. */

function showPreparingScreen(index) {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return;
  let box = document.getElementById('preparingScreen');
  if (!box) {
    grid.innerHTML = `
      <div class="preparing-screen" id="preparingScreen" role="status" aria-live="polite">
        <svg class="preparing-lock" viewBox="0 0 100 100" aria-hidden="true">
          <path d="M32 48 V38 C32 22 68 22 68 38 V48" fill="none" style="stroke: var(--brand);" stroke-width="8" stroke-linecap="round"/>
          <rect x="24" y="46" width="52" height="42" rx="8" style="fill: var(--brand);"/>
          <path d="M44 58 L56 67 L44 76 Z" fill="#1e1f22"/>
        </svg>
        <div class="preparing-title">Getting the library ready for faster search.</div>
        <p class="preparing-hint">This happens once and can take a few minutes on very large libraries.</p>
        <div class="preparing-bar"><span id="preparingFill"></span></div>
        <div class="preparing-step" id="preparingStep"></div>
      </div>`;
    box = document.getElementById('preparingScreen');
    const el = document.getElementById('totalCount');
    if (el) el.textContent = 'Loading…';
  }
  const steps = Number(index && index.steps) || 0;
  const step = Math.min(steps, Number(index && index.step) || 0);
  const fill = document.getElementById('preparingFill');
  const label = document.getElementById('preparingStep');
  if (fill) fill.style.width = steps ? `${Math.round((step / steps) * 100)}%` : '0%';
  if (label) label.textContent = steps ? `Step ${Math.max(1, step)} of ${steps}` : '';
}

function hidePreparingScreen() {
  document.getElementById('preparingScreen')?.remove();
}

/**
 * Find a media row by id. Rows live in Library's cache: anything on screen,
 * playing, or fetched for a picker is there. A miss returns null; callers
 * that may ask about ids nothing has shown yet await Library.fetchRows first.
 */
function getMediaById(id) {
  return Library.row(id);
}

/* ── Library-wide counts → the header, the dropdowns, the type bubbles ─── */

function onFacetsChanged() {
  populateFilters();
  buildExtensionMap();
  renderMediaTypeBar();
  renderTypeExtensionFilter();
  if (typeof initDurationSlider === 'function') initDurationSlider();
  renderLibraryCount();
}
window.addEventListener('vault:facets-changed', onFacetsChanged);
// A new result (or its exact count) changes "N of M".
window.addEventListener('vault:results-changed', () => renderLibraryCount());
window.addEventListener('vault:results-counted', () => renderLibraryCount());

/** Is a search, a filter or a focus narrowing what the library shows? */
function libraryCountNarrowed() {
  if (typeof currentTab !== 'undefined' && currentTab !== 'library' && currentTab !== 'collections') return false;
  if (typeof collectionsHomeShowing === 'function' && collectionsHomeShowing()) return false;
  if (typeof libraryNarrowing !== 'function') return false;
  const n = libraryNarrowing();
  return !!(n.text || n.filters || n.focus || n.similar || n.collection);
}

/** "N media files loaded (M hidden)": the same sentence, from the counts.
    While a search or filter narrows the grid it reads "12 of 353 media files"
    (data-short "12 of 353 files" for the Modern header), so the header never
    says 353 over an empty result. */
function renderLibraryCount() {
  const f = Library.facets;
  const el = document.getElementById('totalCount');
  // The 👤 Faces tab counts people instead (player-lib/faces-tab.js).
  if (typeof facesHeaderCount === 'function' && facesHeaderCount()) return;
  if (!f || !el) return;
  // Count only media files (exclude document)
  const allowedMediaTypes = ['video', 'audio', 'image', 'gif'];
  const mediaCount = allowedMediaTypes.reduce((n, t) => n + ((f.types && f.types[t]) || 0), 0);
  let all = 0;
  const hiddenTypes = new Set();
  for (const g of f.playbackGroups || []) {
    all += g.count;
    if (!allowedMediaTypes.includes(g.media_type) && g.count > 0) hiddenTypes.add(g.media_type);
  }
  const hiddenCount = Math.max(0, all - mediaCount);
  if (libraryCountNarrowed() && Library.known() && !Library.isEmptyResult) {
    const shown = Library.length().toLocaleString();
    el.textContent = `${shown} of ${mediaCount.toLocaleString()} media files`;
    el.dataset.short = `${shown} of ${mediaCount.toLocaleString()} files`;
    el.title = 'Files that match the search and filters, of all the files in the library';
    return;
  }
  delete el.dataset.short;
  if (hiddenCount > 0) {
    el.textContent = `${mediaCount.toLocaleString()} media files loaded (${hiddenCount.toLocaleString()} hidden)`;
    el.title = `Hidden file types: ${[...hiddenTypes].sort().join(', ')}`;
  } else {
    el.textContent = `${mediaCount.toLocaleString()} media files loaded`;
    el.title = '';
  }
}

// Populate filter dropdowns
function populateFilters() {
  const f = Library.facets;
  if (!f) return;
  const keys = (map) => Object.keys(map || {}).filter(Boolean);
  const contentTypes = keys(f.content).sort();
  // Languages: canonical display names (server-provided language_name), so
  // "en"/"EN"/"English" collapse to one "English" option. English pinned first,
  // "Unknown" pushed last, the rest alphabetical.
  let languages = keys(f.language).sort();
  const en = languages.filter(l => l === 'English');
  const rest = languages.filter(l => l !== 'English' && l !== 'Unknown');
  const unk = languages.filter(l => l === 'Unknown');
  languages = [...en, ...rest, ...unk];
  const qualities = keys(f.quality).sort();

  populateSelect('filterContent', contentTypes);
  populateSelect('filterLanguage', languages);
  populateSelect('filterQuality', qualities);
  // Themes: the most used 1,000 (a 2M library has hundreds of thousands);
  // the Theme popover's search box asks the server for the rest. Null while
  // the search index builds: keep whatever list is there.
  if (f.theme) populateSelect('filterTheme', keys(f.theme).sort());

  // The chip popovers read their lists straight off these selects.
  if (typeof renderFilterChipRow === 'function') renderFilterChipRow();
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
  // A value set from a saved search, or picked from the theme search, can be
  // one this list does not carry: keep it rather than silently dropping it.
  ensureSelectOption(select, currentValue);
  select.value = currentValue;
}

/** Give a select an option for this value if it has none, so .value sticks. */
function ensureSelectOption(select, value) {
  if (!select || value == null || value === '') return;
  if ([...select.options].some(o => o.value === value)) return;
  const option = document.createElement('option');
  option.value = value;
  option.textContent = value;
  select.appendChild(option);
}
