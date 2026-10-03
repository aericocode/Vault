/* =========================================================================
   FILTERS - Search and filter logic
   ========================================================================= */

// ── Tri-state filter helpers ────────────────────────────────────────────

/**
 * Get the current value of a tri-state filter.
 * Reads from the active button's data-value within the .tri-filter[data-filter=name].
 * Returns '' (all), '1' (only), or '0' (exclude).
 */
function getTriFilterValue(filterName) {
  const container = document.querySelector(`.tri-filter[data-filter="${filterName}"]`);
  if (!container) return '';
  const active = container.querySelector('.tri-btn.active');
  return active ? active.dataset.value : '';
}

/**
 * Set a tri-state filter to a specific value programmatically.
 */
function setTriFilterValue(filterName, value) {
  const container = document.querySelector(`.tri-filter[data-filter="${filterName}"]`);
  if (!container) return;
  container.querySelectorAll('.tri-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

/**
 * Initialize tri-state filter click handlers.
 * Call once after DOM ready.
 */
function initTriFilters() {
  document.querySelectorAll('.tri-filter').forEach(filter => {
    filter.querySelectorAll('.tri-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        // Deactivate siblings, activate this one
        filter.querySelectorAll('.tri-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyFilters();
      });
    });
  });
}

// ── Scan status ───────────────────────────────────────────────────────────

/**
 * AI-scan outcome for one row, derived from processing_error the same way the
 * server's db.getProcessingStatus() does it:
 *   'success'   analysis landed (no error recorded)
 *   'unscanned' a stub — imported and playable, never analyzed
 *   'failed'    anything else, vision errors and hard errors alike
 *
 * Derived rather than shipped as its own column: the raw error text is already
 * in the payload (the tiles show it in a tooltip) and one more field per row
 * would be dead weight on a 100k-item library.
 */
function scanStatusOf(media) {
  if (!media.processing_error) return 'success';
  if (media.processing_error === 'unscanned') return 'unscanned';
  return 'failed';
}

// ── Focus set: "show exactly these records" ───────────────────────────────
//
// A one-shot override the rest of the app can hand a list of ids to. Built for
// the migration report's "Show not migrated" button: after repointing 40,000
// records, the ones LEFT BEHIND are the interesting set, and there is no
// search term that describes them. While a focus is active it REPLACES the
// other filters rather than intersecting with them — the user asked for this
// exact list, and silently dropping half of it because a chip was still set
// would be a lie. A dismiss chip renders above the grid.

let focusIds = null;      // Set<number> | null
let focusLabel = '';

function setFocusIds(ids, label) {
  const list = Array.isArray(ids) ? ids : [...(ids || [])];
  if (!list.length) {
    if (typeof showToast === 'function') showToast('Nothing to show');
    return;
  }
  focusIds = new Set(list);
  focusLabel = label || 'selected records';
  // A leftover search term would filter the focus set down again.
  const search = document.getElementById('searchInput');
  if (search) search.value = '';
  renderFocusBar();
  applyFilters();
  if (typeof switchTab === 'function' && typeof currentTab !== 'undefined' && currentTab !== 'library') {
    switchTab('library');
  }
}

function clearFocusIds() {
  focusIds = null;
  focusLabel = '';
  renderFocusBar();
  applyFilters();
}

function renderFocusBar() {
  const bar = document.getElementById('focusFilterBar');
  if (!bar) return;
  if (!focusIds) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = '';
  bar.innerHTML = `
    <span class="focus-banner-text">Showing <b>${focusIds.size.toLocaleString()}</b> ${escapeHtml(focusLabel)}. Other filters are paused.</span>
    <button class="focus-banner-close" id="focusBarClear">Show everything</button>`;
  bar.querySelector('#focusBarClear').addEventListener('click', clearFocusIds);
}

// Handed to the settings modal, which has no other way to reach the grid.
window.vaultShowMediaIds = setFocusIds;

// Extensions that browsers can natively play/render (no plugin needed)
const BROWSER_PLAYABLE_EXTENSIONS = new Set([
  // Video
  'mp4', 'webm', 'ogg', 'ogv', 'mov',
  // Audio
  'mp3', 'wav', 'ogg', 'oga', 'webm', 'aac', 'flac', 'm4a', 'opus',
  // Image
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'jfif',
  // Document
  'pdf', 'txt', 'html', 'htm', 'json', 'xml', 'csv', 'md',
]);

/* ── Can this file play? ───────────────────────────────────────────────────
   The same question the server answers on /api/playback, asked here so the
   grid and the extension chips can say it without a request per file.
   player-lib/playback-decide.js is literally the server's own matrix, and
   codecCaps() (player-lib/player/player-stream.js) is the same capability
   string the player sends. Three answers:

     play     native or remux, this browser will get pixels
     no       no decoder and no remux, or a play that already failed
     unknown  never probed, and the extension is not a safe bet

   Rows scanned before this feature have probe_version 0. For those the old
   extension list is used as a hint: a .mp4 plays, a .mkv is a real unknown
   until the codec check in Settings has run. */

// Only these two carry codec columns worth deciding on. A gif renders as an
// image and a document is not decoded at all, so their probe rows (gifs get
// one) must not be read as "no decoder".
const PLAYBACK_CODEC_TYPES = new Set(['video', 'audio']);

let _playbackCaps = null;

/** The codec tags this browser reports, as a Set, computed once. */
function playbackCapsSet() {
  if (_playbackCaps) return _playbackCaps;
  let tags = [];
  try {
    if (typeof codecCaps === 'function') tags = codecCaps().split(',').filter(Boolean);
  } catch { /* probe unavailable — fall through to the server default */ }
  if (!tags.length && window.VaultPlaybackDecide) tags = window.VaultPlaybackDecide.DEFAULT_CAPS;
  _playbackCaps = new Set(tags);
  return _playbackCaps;
}

/**
 * @returns {{state:'play'|'no'|'unknown', reason:?string}}
 */
function mediaPlaybackState(m) {
  if (!m) return { state: 'unknown', reason: null };
  const api = window.VaultPlaybackDecide;
  const probed = !!api && PLAYBACK_CODEC_TYPES.has(m.media_type) && (m.probe_version || 0) >= 1;
  const verdict = probed ? api.decide(m, playbackCapsSet()) : null;

  if (verdict && verdict.mode === 'unsupported') return { state: 'no', reason: verdict.reason };
  // A play that failed for a reason the codec columns cannot explain: a
  // corrupt file, a missing track. The old message is still the true one.
  if (m.playback_failed) return { state: 'no', reason: 'Failed to play' };
  if (verdict) return { state: 'play', reason: null };

  return BROWSER_PLAYABLE_EXTENSIONS.has(getExtension(m.filename))
    ? { state: 'play', reason: null }
    : { state: 'unknown', reason: null };
}

// State for extension filter
// { mediaType: { ext: {total, play, no, unknown}, ... }, ... }
let extensionMap = {};
let selectedExtensions = []; // currently selected extensions (empty = all)

// Media-type bubbles (replaces the old Media Type dropdown; empty = all)
let selectedMediaTypes = [];
// (safe) toggle — only formats known to play in this tool (browser-native)
let safeOnly = false;
// Extension chips are less commonly used — collapsed behind an expander
let extBarOpen = false;
// Duration range in MINUTES (max === slider ceiling means "no max" / ∞)
let durMinM = 0;
let durMaxM = null;

/**
 * Build the extension map from the library-wide counts (Library.facets).
 * Groups extensions under their media_type with counts.
 *
 * Whether a file plays depends on this browser's decoders, which the server
 * cannot know, so the facets carry "playback groups": row counts grouped by
 * every field mediaPlaybackState() reads. One decision per group, added up
 * per extension, gives the same stars the per-row pass used to.
 */
function buildExtensionMap() {
  extensionMap = {};
  const groups = (typeof Library !== 'undefined' && Library.facets && Library.facets.playbackGroups) || [];
  for (const g of groups) {
    const type = g.media_type;
    if (!type) continue;
    const ext = g.ext;
    if (!ext) continue;
    if (!extensionMap[type]) extensionMap[type] = {};
    const bucket = extensionMap[type][ext]
      || (extensionMap[type][ext] = { total: 0, play: 0, no: 0, unknown: 0 });
    bucket.total += g.count;
    bucket[mediaPlaybackState(playbackGroupRow(g)).state] += g.count;
  }
}

/** A stand-in row carrying exactly the fields mediaPlaybackState() reads. */
function playbackGroupRow(g) {
  return {
    media_type: g.media_type,
    filename: `x.${g.ext || ''}`,
    probe_version: g.probed ? 1 : 0,
    playback_failed: g.playback_failed,
    video_codec: g.video_codec,
    audio_codec: g.audio_codec,
    pix_fmt: g.pix_fmt,
    codec_profile: g.codec_profile,
    container: g.container,
  };
}

/**
 * Extract lowercase extension from a filename.
 */
function getExtension(filename) {
  if (!filename) return '';
  const dot = filename.lastIndexOf('.');
  if (dot === -1 || dot === filename.length - 1) return '';
  return filename.substring(dot + 1).toLowerCase();
}

/**
 * Render the always-visible media-type bubbles + (safe) toggle + the
 * "extensions" expander. Replaces the old Media Type dropdown.
 */
function renderMediaTypeBar() {
  const bar = document.getElementById('mediaTypeBar');
  if (!bar) return;

  const typeCounts = (typeof Library !== 'undefined' && Library.facets && Library.facets.types) || {};

  const labels = { video: '🎬 Video', image: '🖼 Image', gif: '🎞 GIF', audio: '🎵 Audio', mix: '🎛 Mix' };
  const allActive = selectedMediaTypes.length === 0;

  let html = `<button class="ext-chip type-chip ${allActive ? 'active' : ''}" data-type="">All</button>`;
  for (const type of ['video', 'image', 'gif', 'audio', 'mix']) {
    if (!typeCounts[type]) continue;
    const active = selectedMediaTypes.includes(type);
    html += `<button class="ext-chip type-chip ${active ? 'active' : ''}" data-type="${type}">${labels[type]} <span class="ext-count">${typeCounts[type].toLocaleString()}</span></button>`;
  }
  html += `<button class="ext-chip safe-chip ${safeOnly ? 'active' : ''}" id="safeChip" title="Only formats known to play in this tool">★ safe</button>`;
  html += `<button class="ext-chip ext-expander ${extBarOpen ? 'open' : ''}" id="extExpander" title="Filter by exact file extension">${extBarOpen ? 'extensions ▾' : 'extensions ▸'}${selectedExtensions.length ? ` <span class="ext-count">${selectedExtensions.length}</span>` : ''}</button>`;

  bar.innerHTML = html;

  bar.querySelectorAll('.type-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const type = chip.dataset.type;
      if (type === '') {
        selectedMediaTypes = [];
      } else {
        const idx = selectedMediaTypes.indexOf(type);
        if (idx === -1) selectedMediaTypes.push(type);
        else selectedMediaTypes.splice(idx, 1);
      }
      renderMediaTypeBar();
      applyFilters();
    });
  });

  document.getElementById('safeChip')?.addEventListener('click', () => {
    safeOnly = !safeOnly;
    renderMediaTypeBar();
    applyFilters();
  });

  document.getElementById('extExpander')?.addEventListener('click', () => {
    extBarOpen = !extBarOpen;
    renderMediaTypeBar();
    renderTypeExtensionFilter();
  });
}

/**
 * Render the extension chip bar (collapsed by default — opened via the
 * "extensions ▸" expander in the media-type bar).
 */
function renderTypeExtensionFilter() {
  const extBar = document.getElementById('extensionBar');
  if (!extBar) return;

  if (!extBarOpen) {
    extBar.style.display = 'none';
    const legend = document.getElementById('extensionLegend');
    if (legend) legend.style.display = 'none';
    return;
  }

  // Group by media type with separators — video first, then the rest
  const typeOrder = ['video', 'audio', 'image', 'gif', 'document'];
  const grouped = [];

  typeOrder.forEach(type => {
    if (!extensionMap[type]) return;
    const exts = Object.entries(extensionMap[type]).sort((a, b) => a[0].localeCompare(b[0]));
    if (exts.length > 0) {
      grouped.push({ type, exts });
    }
  });

  Object.keys(extensionMap).forEach(type => {
    if (!typeOrder.includes(type) && extensionMap[type]) {
      const exts = Object.entries(extensionMap[type]).sort((a, b) => a[0].localeCompare(b[0]));
      if (exts.length > 0) {
        grouped.push({ type, exts });
      }
    }
  });

  if (grouped.length === 0) {
    extBar.innerHTML = '';
    extBar.style.display = 'none';
    return;
  }

  const allExts = [];
  grouped.forEach((group, i) => {
    if (i > 0) allExts.push({ separator: true });
    group.exts.forEach(([ext, counts]) => allExts.push({ ext, counts }));
  });

  renderExtChips(extBar, null, allExts);
}

/* ── The three-state star ──────────────────────────────────────────────────
   One glance per extension: green means every file behind this chip plays,
   amber means some do, red means none can. No star at all is the honest
   answer for an extension nothing has ever been checked for, which is what
   .mkv looks like on a library scanned before the codec check existed. In the
   amber case the count turns into "play/total", because "84" next to an amber
   star raises exactly the question the fraction answers. */

function extStar(c) {
  if (!c || !c.total) return null;
  if (c.no === 0 && c.unknown === 0) {
    return {
      kind: 'all', cls: '',
      title: c.total === 1 ? 'This file plays' : `All ${c.total.toLocaleString()} files play`,
    };
  }
  if (c.play > 0) {
    const tail = [];
    if (c.no > 0) tail.push(`${c.no.toLocaleString()} cannot play`);
    if (c.unknown > 0) tail.push(`${c.unknown.toLocaleString()} not checked yet`);
    return {
      kind: 'part', cls: ' part',
      title: `${c.play.toLocaleString()} of ${c.total.toLocaleString()} play. ${tail.join(', ')}`,
    };
  }
  if (c.no === c.total) {
    return {
      kind: 'none', cls: ' none',
      title: c.total === 1 ? 'This file cannot play' : 'None of these files can play',
    };
  }
  // Nothing plays and nothing is certain: say nothing rather than guess.
  return null;
}

/**
 * Render extension chips.
 * @param {HTMLElement} extBar
 * @param {Array|null} simpleList - [[ext, counts], ...] for single-type mode
 * @param {Array|null} groupedList - [{ext, counts} | {separator}] for all-types mode
 */
function renderExtChips(extBar, simpleList, groupedList) {
  const items = simpleList
    ? simpleList.map(([ext, counts]) => ({ ext, counts }))
    : groupedList || [];

  if (items.filter(i => !i.separator).length === 0) {
    extBar.innerHTML = '';
    extBar.style.display = 'none';
    return;
  }

  extBar.style.display = 'flex';

  // The legend only earns its space once a chip is something other than a
  // plain green star.
  const legend = document.getElementById('extensionLegend');
  const mixed = items.some(i => {
    if (!i.ext) return false;
    const star = extStar(i.counts);
    return !star || star.kind !== 'all';
  });
  if (legend) legend.style.display = mixed ? 'flex' : 'none';

  const allActive = selectedExtensions.length === 0;

  let html = `<button class="ext-chip ${allActive ? 'active' : ''}" data-ext="">All</button>`;

  items.forEach(item => {
    if (item.separator) {
      html += '<span class="ext-separator">|</span>';
      return;
    }
    const { ext, counts } = item;
    const isActive = selectedExtensions.includes(ext);
    const star = extStar(counts);
    const marker = star
      ? `<span class="ext-playable${star.cls}" title="${escapeHtml(star.title)}">★</span>`
      : '';
    // No star means no hover target, so the chip itself carries the sentence.
    const chipTitle = star ? '' :
      ' title="Not checked yet. Run Check playback support in Settings"';
    const countText = (star && star.kind === 'part')
      ? `${counts.play.toLocaleString()}/${counts.total.toLocaleString()}`
      : counts.total.toLocaleString();
    html += `<button class="ext-chip ${isActive ? 'active' : ''}" data-ext="${escapeHtml(ext)}"${chipTitle}>.${escapeHtml(ext)}${marker} <span class="ext-count">${countText}</span></button>`;
  });

  extBar.innerHTML = html;

  // Attach click handlers
  extBar.querySelectorAll('.ext-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const ext = chip.dataset.ext;
      if (ext === '') {
        selectedExtensions = [];
      } else {
        const idx = selectedExtensions.indexOf(ext);
        if (idx === -1) {
          selectedExtensions.push(ext);
        } else {
          selectedExtensions.splice(idx, 1);
        }
      }
      renderMediaTypeBar(); // keep the expander's selection count fresh
      renderTypeExtensionFilter();
      applyFilters();
    });
  });
}

// ── Duration range slider (weighted dual-thumb, minutes, ∞ at the top) ────
//
// Most media is short, so the scale is non-linear: the first HALF of the
// slider covers 0–20 min, up to 70% covers 0–60 min, and the last stretch
// runs out to 3 h. The very top = no max (∞).
//   position 0–50   → 0–20 min
//   position 50–70  → 20–60 min
//   position 70–100 → 60–180 min

const DUR_STOPS = [[0, 0], [50, 20], [70, 60], [100, 180]];

function posToMinutes(p) {
  p = Math.max(0, Math.min(100, p));
  for (let i = 1; i < DUR_STOPS.length; i++) {
    const [p0, m0] = DUR_STOPS[i - 1];
    const [p1, m1] = DUR_STOPS[i];
    if (p <= p1) return Math.round(m0 + ((p - p0) / (p1 - p0)) * (m1 - m0));
  }
  return DUR_STOPS[DUR_STOPS.length - 1][1];
}

function minutesToPos(m) {
  const top = DUR_STOPS[DUR_STOPS.length - 1][1];
  m = Math.max(0, Math.min(top, m));
  for (let i = 1; i < DUR_STOPS.length; i++) {
    const [p0, m0] = DUR_STOPS[i - 1];
    const [p1, m1] = DUR_STOPS[i];
    if (m <= m1) return Math.round(p0 + ((m - m0) / (m1 - m0)) * (p1 - p0));
  }
  return 100;
}

function formatMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function updateDurationUI() {
  const minEl = document.getElementById('durMinSlider');
  const maxEl = document.getElementById('durMaxSlider');
  const label = document.getElementById('durationLabel');
  const fill = document.getElementById('durationFill');
  if (!minEl || !maxEl) return;

  const minPos = Number(minEl.value);
  const maxPos = Number(maxEl.value);
  durMinM = posToMinutes(minPos);
  durMaxM = maxPos >= 100 ? null : posToMinutes(maxPos); // top = no max (3h+ included)

  if (label) {
    label.textContent = `${formatMinutes(durMinM)} – ${durMaxM == null ? '∞' : formatMinutes(durMaxM)}`;
  }
  if (fill) {
    fill.style.left = `${minPos}%`;
    fill.style.width = `${Math.max(0, maxPos - minPos)}%`;
  }
}

/** Wire the weighted slider (fixed 0–100 position scale). */
function initDurationSlider() {
  const minEl = document.getElementById('durMinSlider');
  const maxEl = document.getElementById('durMaxSlider');
  if (!minEl || !maxEl) return;

  minEl.max = '100';
  maxEl.max = '100';
  // Preserve current selection across library reloads
  minEl.value = String(minutesToPos(durMinM || 0));
  maxEl.value = durMaxM == null ? '100' : String(minutesToPos(durMaxM));

  const onInput = () => {
    // Keep thumbs ordered
    if (Number(minEl.value) > Number(maxEl.value)) {
      minEl.value = maxEl.value;
    }
    updateDurationUI();
  };
  if (!minEl._wired) {
    minEl._wired = maxEl._wired = true;
    const apply = debounce(applyFilters, 250);
    [minEl, maxEl].forEach(el => {
      el.addEventListener('input', () => { onInput(); apply(); });
    });
  }
  updateDurationUI();
}

// ── Running the search (on the server) ──────────────────────────────────
//
// Search, filters, sort and counts run on the server against SQLite indexes
// (SERVER_SEARCH_SPEC 3 and 4). applyFilters() reads the same controls it
// always did, describes them as a query spec, and lets Library fetch the
// first page; the grid paints from that and fills in as rows arrive.

function semanticEnabled() {
  return document.getElementById('semanticSearch')?.checked || false;
}

const QUERY_SORT_FIELDS = ['processed', 'name', 'size', 'duration', 'rating', 'views', 'done'];

/** The 6.1 query spec for what the controls say right now. */
function currentQuerySpec() {
  const [field, dir] = String(currentSort || 'processed_desc').split('_');
  const collectionOpen = typeof activeCollectionId !== 'undefined' && activeCollectionId != null;
  const spec = {
    search: {
      text: document.getElementById('searchInput').value.trim(),
      metadataOnly: document.getElementById('metadataOnly')?.checked || false,
      fuzzy: document.getElementById('fuzzySearch')?.checked || false,
      semantic: semanticEnabled(),
      subtitles: typeof subtitleSearchOn === 'function' ? subtitleSearchOn() : false,
    },
    filters: {
      mediaTypes: [...selectedMediaTypes],
      safeOnly: !!safeOnly,
      extensions: [...selectedExtensions],
      content: document.getElementById('filterContent').value,
      language: document.getElementById('filterLanguage').value,
      quality: document.getElementById('filterQuality').value,
      theme: document.getElementById('filterTheme').value,
      minRating: document.getElementById('filterMinRating')?.value || '0',
      durMin: durMinM || 0,
      durMax: durMaxM == null ? null : durMaxM,
      // The 📁 tri-filter only applies with no collection open (as before).
      collections: collectionOpen ? '' : getTriFilterValue('filterCollections'),
      song: Number(document.getElementById('filterSong')?.value || 0),
      starred: getTriFilterValue('filterStarred'),
      hasNotes: getTriFilterValue('filterHasNotes'),
      flagged: getTriFilterValue('filterFlagged'),
      trashed: getTriFilterValue('filterTrashed'),
      failed: getTriFilterValue('filterFailed'),
      duplicates: getTriFilterValue('filterDuplicates'),
      scanStatus: getTriFilterValue('filterScanStatus'),
    },
    collectionId: collectionOpen ? activeCollectionId : null,
    sort: {
      field: QUERY_SORT_FIELDS.includes(field) ? field : 'processed',
      dir: dir === 'asc' ? 'asc' : 'desc',
      favesFirst: typeof favesFirst !== 'undefined' && !!favesFirst,
    },
    // An active focus set answers for the whole chain (see setFocusIds).
    onlyIds: focusIds ? [...focusIds] : null,
    // ≈ Audio-similarity: files sharing songs with the anchor (plus the
    // anchor itself), ranked most-similar first; filters still apply.
    rankedIds: null,
  };
  if (typeof audioSimScores !== 'undefined' && audioSimScores) {
    spec.rankedIds = [{ id: audioSimAnchorId, score: 2 }];
    for (const [id, score] of audioSimScores) if (id !== audioSimAnchorId) spec.rankedIds.push({ id, score });
  }
  return spec;
}

/** True on the Collections tab with no collection open: cards only, no media. */
function collectionsHomeShowing() {
  return typeof currentTab !== 'undefined' && currentTab === 'collections' &&
    (typeof activeCollectionId === 'undefined' || activeCollectionId == null);
}

let _applySeq = 0;
let _searchError = null;   // a 400 from the server, said under the search box

function applyFilters(opts) {
  // keepPage: stay on the current page instead of jumping to page 1. Passed
  // by post-mutation reconciles (trash/restore/remove) so deleting a file
  // doesn't yank the grid back to the start. Guarded so the common case of
  // applyFilters being wired directly as an event handler (first arg is an
  // Event, not an options object) still resets to page 1 as before.
  const keepPage = !!(opts && opts.keepPage === true);
  const seq = ++_applySeq;
  // Search bar locked for the first-launch index build: text set meanwhile
  // (a saved search clicked) waits in the hold instead of searching.
  if (_searchLock) _holdLockedSearchText(document.getElementById('searchInput'));
  const spec = currentQuerySpec();

  if (spec.search.text) {
    window.dispatchEvent(new CustomEvent('vault:search-run', {
      detail: { text: spec.search.text, subtitles: spec.search.subtitles },
    }));
  }

  // Keep the chip row telling the truth about what is narrowing the grid
  if (typeof renderFilterChipRow === 'function') renderFilterChipRow();
  // Update saved searches bar (show/hide save button based on active filters)
  if (typeof renderSavedSearches === 'function') renderSavedSearches();
  // Remember the full search state so the next launch restores it
  persistSearchState();

  // Collections tab home shows ONLY collection cards — loose media hides
  // until a collection is opened (then its members fill the grid)
  if (collectionsHomeShowing()) {
    _searchError = null;
    Library.setEmpty();
    afterResults(keepPage);
    return Promise.resolve();
  }

  const needIds = keepPage && pageAnchor > 0;
  const install = (ok) => {
    if (!ok || seq !== _applySeq) return null;
    _searchError = null;
    _rerunFromTop = false;
    // Holding a place past the first page needs the id list first.
    if (keepPage && pageAnchor >= Library.firstPageIds.length && !Library.known()) {
      return Library.waitIds().then(() => { if (seq === _applySeq) afterResults(keepPage); });
    }
    afterResults(keepPage);
    return null;
  };
  return Library.query(spec, { needIds }).then(install, (err) => {
    if (seq !== _applySeq) return null;
    if (err && err.code === 'SEMANTIC_UNAVAILABLE') {
      // As before: say why, and show the text results instead.
      showToast('🧠 ' + (err.message || 'Semantic search unavailable'));
      const textOnly = { ...spec, search: { ...spec.search, semantic: false } };
      return Library.query(textOnly, { needIds }).then(install, (e2) => failed(e2));
    }
    return failed(err);
  });

  function failed(err) {
    if (seq !== _applySeq) return null;
    if (err && err.status === 400) {
      // The server's sentence is meant for people ("Search is too long. Use
      // 16 words or fewer."): it goes under the search box, not in a toast.
      _searchError = err.message;
      Library.setEmpty();
      afterResults(false);
      return null;
    }
    console.warn('[Search] failed:', err);
    if (err && err.status) {
      // The server answered with an error (a 500): asking again every few
      // seconds would only repeat it. Say so once; the next change the user
      // makes tries again.
      showToast('Search failed: ' + (err.message || `Server returned ${err.status}`));
      return null;
    }
    showToast('Search failed: ' + ((err && err.message) || 'server unreachable'));
    // No answer at all (restarting, offline): the box now says something the
    // grid does not show, so run it again as soon as the server answers
    // (Library's polling). A new search lands on page 1 when it does; only a
    // re-run of the same search holds the place.
    if (!keepPage) _rerunFromTop = true;
    Library.noteServerLost();
    return null;
  }
}

// A new search that could not reach the server: its re-run starts at the top.
let _rerunFromTop = false;

/** The UI work that follows a new result. */
function afterResults(keepPage) {
  // A new search or filter has no place to hold, so it starts at the top.
  if (!keepPage && typeof resetPageAnchor === 'function') resetPageAnchor();
  // Clamp: a mutation (trash/remove) can shrink the list under the anchor —
  // never strand the view past the end
  if (typeof clampPageAnchor === 'function') clampPageAnchor();
  renderSearchNote();
  renderResults();

  // Keep the "Empty trash" button's count/visibility in sync with the library
  if (typeof updateClearTrashUi === 'function') updateClearTrashUi();

  // …and the 🔍 Scan filter's "Rescan these (N)" button, which acts on
  // whatever the filters just produced
  if (typeof updateRescanFilteredButton === 'function') updateRescanFilteredButton();
}

/* ── First-launch index build: the search bar says so and waits ──────────
   The server builds the search index once per library. Until it is done a
   search cannot run, so the bar is locked and carries the progress as its
   placeholder instead of taking typing that would go nowhere. A search that
   was already there (restored from last time, or a saved search clicked
   meanwhile) is held, kept in the saved session, and runs as soon as the
   index is ready. */

let _searchLock = null;   // { text, placeholder } while the bar is locked

function _searchLockPlaceholder() {
  const idx = Library.index;
  const pct = idx.state === 'building' && idx.progress != null
    ? ` (${Math.max(0, Math.min(99, Math.round(idx.progress * 100)))}%)` : '';
  return `Setting up search, one time only${pct}. Filters and sorting work now.`;
}

/** Move any text in the locked bar into the hold (it would only return an empty page). */
function _holdLockedSearchText(input) {
  if (!_searchLock || !input || !input.value) return;
  _searchLock.text = input.value;
  input.value = '';
  if (typeof updateSearchClearButton === 'function') updateSearchClearButton();
  if (typeof updateSearchStarButton === 'function') updateSearchStarButton();
}

function syncSearchLock() {
  const input = document.getElementById('searchInput');
  if (!input) return;
  const st = Library.index.state;
  if (st === 'building' || st === 'preparing') {
    if (!_searchLock) {
      _searchLock = { text: '', placeholder: input.placeholder };
      input.disabled = true;
      const had = !!input.value;
      _holdLockedSearchText(input);
      // Show the library without the held search until the index is ready.
      if (had) applyFilters({ keepPage: true });
    }
    input.placeholder = _searchLockPlaceholder();
  } else if (_searchLock) {
    const { text, placeholder } = _searchLock;
    _searchLock = null;
    input.disabled = false;
    input.placeholder = placeholder;
    if (text && !input.value) {
      input.value = text;
      if (typeof updateSearchClearButton === 'function') updateSearchClearButton();
      if (typeof updateSearchStarButton === 'function') updateSearchStarButton();
      applyFilters();
    }
  }
}

/* ── The line under the search box ───────────────────────────────────────
   One line, two jobs, most important first: a search the server refused
   (its own plain sentence), and the close names and tags a fuzzy search
   also matched. Hidden when there is nothing to say. (The first-launch
   index build is shown in the search bar itself: syncSearchLock above.) */

function renderSearchNote() {
  const el = document.getElementById('searchNote');
  if (!el) return;
  let html = '';
  let cls = '';
  const idx = Library.index;
  const terms = (Library.search && Library.search.mode === 'fuzzy' && Library.search.closeTerms) || [];
  if (_searchError) {
    cls = 'err';
    html = escapeHtml(_searchError);
  } else if (terms.length) {
    html = '<span>Close names and tags:</span>' +
      terms.map(t => `<span class="search-note-tag">${escapeHtml(t)}</span>`).join('');
  }
  el.className = `search-note${cls ? ' ' + cls : ''}`;
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

window.addEventListener('vault:index-progress', () => {
  syncSearchLock();
  renderSearchNote();
});
window.addEventListener('vault:index-state', () => {
  syncSearchLock();
  renderSearchNote();
  if (typeof renderFilterChipRow === 'function') renderFilterChipRow();
});

// Something changed the library elsewhere (a scan, another window, the CLI):
// run the same query again and keep the user's place.
Library.onLibraryChanged = () => applyFilters({ keepPage: !_rerunFromTop });

// ── Session persistence: relaunch with the last search/toggles intact ─────

const LS_SEARCH_STATE = 'viewer_last_search_state';

function persistSearchState() {
  if (typeof captureCurrentFilterState !== 'function') return;
  try {
    const state = captureCurrentFilterState();
    // Closing during the index build must not forget the held search
    if (_searchLock && _searchLock.text && !state.searchText) state.searchText = _searchLock.text;
    localStorage.setItem(LS_SEARCH_STATE, JSON.stringify(state));
  } catch {}
}

/** Called once at startup (after the filters and sliders are initialized). */
function restoreLastSearchState() {
  let state;
  try { state = JSON.parse(localStorage.getItem(LS_SEARCH_STATE)); } catch {}
  if (!state || typeof restoreFilterState !== 'function') return false;
  const run = restoreFilterState(state); // sets every control + calls applyFilters
  if (typeof updateSearchStarButton === 'function') updateSearchStarButton();
  if (typeof updateSearchClearButton === 'function') updateSearchClearButton();
  return run || true;
}
