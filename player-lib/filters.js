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
 * Build the extension map from allMedia.
 * Groups extensions under their media_type with counts.
 */
function buildExtensionMap() {
  extensionMap = {};
  allMedia.forEach(m => {
    const type = m.media_type;
    if (!type) return;
    const ext = getExtension(m.filename);
    if (!ext) return;
    if (!extensionMap[type]) extensionMap[type] = {};
    const bucket = extensionMap[type][ext]
      || (extensionMap[type][ext] = { total: 0, play: 0, no: 0, unknown: 0 });
    bucket.total++;
    bucket[mediaPlaybackState(m).state]++;
  });
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

  const typeCounts = {};
  allMedia.forEach(m => {
    if (['video', 'image', 'gif', 'audio', 'mix'].includes(m.media_type)) {
      typeCounts[m.media_type] = (typeCounts[m.media_type] || 0) + 1;
    }
  });

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

// ── Searchable dropdowns (theme / content type / language) ────────────────
// The native <select> stays in the DOM (hidden) as the value store, so all
// existing `#filterTheme.value` reads and 'change' listeners keep working.
// A text input + filtered option panel renders in its place.

function makeSearchable(select) {
  if (!select || select._searchable) return;
  select._searchable = true;
  select.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.className = 'combo';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combo-input';
  input.autocomplete = 'off';
  const panel = document.createElement('div');
  panel.className = 'combo-panel';
  panel.hidden = true;
  wrap.append(input, panel);
  select.after(wrap);

  const labelFor = (v) => [...select.options].find(o => o.value === v)?.textContent || '';
  const syncLabel = () => {
    input.value = select.value ? labelFor(select.value) : '';
    input.placeholder = select.options[0]?.textContent || 'All';
  };
  select._syncCombo = syncLabel;
  syncLabel();

  const renderPanel = (query) => {
    const q = (query || '').toLowerCase();
    const opts = [...select.options].filter(o =>
      !q || o.textContent.toLowerCase().includes(q));
    panel.innerHTML = opts.map(o =>
      `<div class="combo-option ${o.value === select.value ? 'selected' : ''}" data-value="${escapeHtml(o.value)}">${escapeHtml(o.textContent)}</div>`
    ).join('') || '<div class="combo-empty">No matches</div>';
  };

  const open = () => { panel.hidden = false; renderPanel(''); input.select(); };
  const close = () => { panel.hidden = true; syncLabel(); };

  input.addEventListener('focus', open);
  input.addEventListener('input', () => { panel.hidden = false; renderPanel(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); }
    if (e.key === 'Enter') {
      const first = panel.querySelector('.combo-option');
      if (first) {
        select.value = first.dataset.value;
        select.dispatchEvent(new Event('change'));
      }
      close();
      input.blur();
    }
  });
  panel.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.combo-option');
    if (!opt) return;
    e.preventDefault();
    select.value = opt.dataset.value;
    select.dispatchEvent(new Event('change'));
    close();
    input.blur();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  select.addEventListener('change', syncLabel);
}

function initSearchableSelects() {
  document.querySelectorAll('select[data-searchable]').forEach(makeSearchable);
}

/** Refresh combo labels after programmatic select.value changes (restore). */
function syncSearchableSelects() {
  document.querySelectorAll('select[data-searchable]').forEach(s => s._syncCombo?.());
}

// ── Semantic search (embeddings) ────────────────────────────────────────

// Cache of the last semantic query → Map(id → score)
let semanticCache = { query: null, scores: null };
let semanticPending = null;
let semanticOrdered = false; // when true, skip sortFilteredMedia (relevance order)
const SEMANTIC_MIN_SCORE = 0.4;

function semanticEnabled() {
  return document.getElementById('semanticSearch')?.checked || false;
}

async function fetchSemantic(query) {
  if (semanticPending === query) return;
  semanticPending = query;
  try {
    const resp = await fetch('/api/search/semantic?q=' + encodeURIComponent(query));
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      showToast('🧠 ' + (err.error || 'Semantic search unavailable'));
      return;
    }
    const { results } = await resp.json();
    semanticCache = {
      query,
      scores: new Map(results.filter(r => r.score >= SEMANTIC_MIN_SCORE).map(r => [r.id, r.score])),
    };
    // Re-render if the user hasn't typed something else meanwhile
    if (document.getElementById('searchInput').value.trim() === query) {
      applyFilters();
    }
  } catch (err) {
    console.warn('[Semantic] failed:', err);
  } finally {
    if (semanticPending === query) semanticPending = null;
  }
}

function applyFilters(opts) {
  // keepPage: stay on the current page instead of jumping to page 1. Passed
  // by post-mutation reconciles (trash/restore/remove) so deleting a file
  // doesn't yank the grid back to the start. Guarded so the common case of
  // applyFilters being wired directly as an event handler (first arg is an
  // Event, not an options object) still resets to page 1 as before.
  const keepPage = !!(opts && opts.keepPage === true);
  const search = document.getElementById('searchInput').value.trim();
  const contentType = document.getElementById('filterContent').value;
  const language = document.getElementById('filterLanguage').value;
  const theme = document.getElementById('filterTheme').value;
  const quality = document.getElementById('filterQuality').value;
  const songFilter = Number(document.getElementById('filterSong')?.value || 0);
  const metadataOnly = document.getElementById('metadataOnly')?.checked || false;
  const minRatingValue = document.getElementById('filterMinRating')?.value || '0';

  // Tri-state filters ('' = all, '1' = only yes, '0' = only no)
  const triCollections = getTriFilterValue('filterCollections');
  const triStarred = getTriFilterValue('filterStarred');
  const triHasNotes = getTriFilterValue('filterHasNotes');
  const triDuplicates = getTriFilterValue('filterDuplicates');
  const triFlagged = getTriFilterValue('filterFlagged');
  const triTrashed = getTriFilterValue('filterTrashed');   // default '0' = hidden
  const triFailed = getTriFilterValue('filterFailed');
  // '' = all, else one of 'success' | 'failed' | 'unscanned'
  const scanStatus = getTriFilterValue('filterScanStatus');

  // First pass: apply all non-search filters
  let candidates = allMedia.filter(m => {
    // An active focus set answers for the whole chain — see setFocusIds.
    if (focusIds) return focusIds.has(m.id);

    // Only show media files: video, audio, image, gif + custom mixes
    // (exclude document)
    const allowedMediaTypes = ['video', 'audio', 'image', 'gif', 'mix'];
    if (!allowedMediaTypes.includes(m.media_type)) return false;

    // Active collection filters the whole grid to its members
    if (typeof inActiveCollection === 'function' && !inActiveCollection(m)) return false;

    // 📁 Collections tri-filter: files that belong to any collection
    // (collection CARDS live on their own tab now)
    if (triCollections && typeof mediaInAnyCollection === 'function' &&
        (typeof activeCollectionId === 'undefined' || activeCollectionId == null)) {
      if (triCollections === '1' && !mediaInAnyCollection(m.id)) return false;
      if (triCollections === '0' && mediaInAnyCollection(m.id)) return false;
    }

    // 🎵 Song filter: only files containing the selected song
    if (songFilter && typeof mediaSongIds === 'function' &&
        !mediaSongIds(m.id).includes(songFilter)) return false;

    // Media-type bubbles (multi-select; empty = all)
    if (selectedMediaTypes.length > 0 && !selectedMediaTypes.includes(m.media_type)) return false;

    // (safe) toggle — only formats known to play in this tool
    if (safeOnly && !BROWSER_PLAYABLE_EXTENSIONS.has(getExtension(m.filename))) return false;

    // Extension filter
    if (selectedExtensions.length > 0) {
      const ext = getExtension(m.filename);
      if (!selectedExtensions.includes(ext)) return false;
    }

    // Other filters
    if (contentType && m.content_type !== contentType) return false;
    // Language matches on the canonical display name (dropdown carries names),
    // so selecting "English" catches rows stored as "en"/"EN"/"English".
    if (language && (m.language_name || 'Unknown') !== language) return false;
    if (quality && m.quality_flag !== quality) return false;

    // Tri-state filters
    if (triStarred === '1' && !m.user_starred) return false;
    if (triStarred === '0' && m.user_starred) return false;

    if (triHasNotes) {
      const hasNotes = m.user_notes && m.user_notes !== '[]' && m.user_notes !== '';
      if (triHasNotes === '1' && !hasNotes) return false;
      if (triHasNotes === '0' && hasNotes) return false;
    }

    if (triFlagged === '1' && !m.user_flagged_delete) return false;
    if (triFlagged === '0' && m.user_flagged_delete) return false;

    if (triTrashed === '1' && !m.user_trashed) return false;
    if (triTrashed === '0' && m.user_trashed) return false;

    if (triFailed === '1' && !m.playback_failed) return false;
    if (triFailed === '0' && m.playback_failed) return false;

    if (scanStatus && scanStatusOf(m) !== scanStatus) return false;

    if (triDuplicates === '1' && typeof isDuplicate === 'function' && !isDuplicate(m.filepath)) return false;
    if (triDuplicates === '0' && typeof isDuplicate === 'function' && isDuplicate(m.filepath)) return false;

    // Min rating filter
    if (minRatingValue === 'unrated' && (m.user_rating || 0) > 0) return false;
    if (minRatingValue !== '0' && minRatingValue !== 'unrated') {
      const minRating = parseInt(minRatingValue) || 0;
      if (minRating > 0 && (m.user_rating || 0) < minRating) return false;
    }

    // Duration range (minutes; null max = no cap)
    const duration = m.duration_seconds || 0;
    if (durMinM > 0 && duration < durMinM * 60) return false;
    if (durMaxM != null && duration > durMaxM * 60) return false;

    // Theme — matches the CLEAN copy (dropdown carries cleaned values); falls
    // back to raw for rows not yet normalized
    if (theme) {
      try {
        const themes = JSON.parse(m.themes_clean || m.themes || '[]');
        if (!themes.includes(theme)) return false;
      } catch {
        return false;
      }
    }

    return true;
  });

  // Second pass: apply text search (fuzzy/boolean/regex — or semantic)
  semanticOrdered = false;
  if (search) {
    if (semanticEnabled()) {
      if (semanticCache.query === search && semanticCache.scores) {
        // Semantic hit: keep matches, ordered by relevance
        const scores = semanticCache.scores;
        candidates = candidates.filter(m => scores.has(m.id));
        candidates.sort((a, b) => scores.get(b.id) - scores.get(a.id));
        semanticOrdered = true;
      } else {
        // Not cached yet — fire the async query, show text results meanwhile
        fetchSemantic(search);
        if (typeof executeSearch === 'function') {
          candidates = executeSearch(search, candidates, metadataOnly);
        }
      }
    } else if (typeof executeSearch === 'function') {
      candidates = executeSearch(search, candidates, metadataOnly);
    } else {
      // Fallback: simple substring
      const q = search.toLowerCase();
      candidates = candidates.filter(m => {
        const text = getSearchText ? getSearchText(m, metadataOnly) : '';
        return text.toLowerCase().includes(q);
      });
    }
  }

  // ≈ Audio-similarity mode: keep only files sharing songs with the anchor
  // (plus the anchor itself), ranked most-similar first. Reuses the
  // relevance-order flag so sortFilteredMedia doesn't re-sort.
  if (typeof audioSimScores !== 'undefined' && audioSimScores) {
    candidates = candidates.filter(m => m.id === audioSimAnchorId || audioSimScores.has(m.id));
    const score = (m) => m.id === audioSimAnchorId ? 2 : (audioSimScores.get(m.id) || 0);
    candidates.sort((a, b) => score(b) - score(a));
    semanticOrdered = true;
  }

  // Publish which media matched (BEFORE the only-collections suppression) —
  // collection cards only list collections with ≥1 matching member
  if (typeof setMatchedMediaIds === 'function') setMatchedMediaIds(candidates);

  // Collections tab home shows ONLY collection cards — loose media hides
  // until a collection is opened (then its members fill the grid)
  if (typeof currentTab !== 'undefined' && currentTab === 'collections' &&
      (typeof activeCollectionId === 'undefined' || activeCollectionId == null)) {
    candidates = [];
  }

  filteredMedia = candidates;

  // Apply sorting
  sortFilteredMedia();

  // A new search or filter has no place to hold, so it starts at the top.
  if (!keepPage && typeof resetPageAnchor === 'function') resetPageAnchor();
  // Clamp: a mutation (trash/remove) can shrink the list under the anchor —
  // never strand the view past the end
  if (typeof clampPageAnchor === 'function') clampPageAnchor();
  renderResults();

  // Update saved searches bar (show/hide save button based on active filters)
  if (typeof renderSavedSearches === 'function') {
    renderSavedSearches();
  }

  // Keep the "Empty trash" button's count/visibility in sync with the library
  if (typeof updateClearTrashUi === 'function') updateClearTrashUi();

  // …and the 🔍 Scan filter's "Rescan these (N)" button, which acts on
  // whatever the filters just produced
  if (typeof updateRescanFilteredButton === 'function') updateRescanFilteredButton();

  // Remember the full search state so the next launch restores it
  persistSearchState();
}

// ── Session persistence: relaunch with the last search/toggles intact ─────

const LS_SEARCH_STATE = 'viewer_last_search_state';

function persistSearchState() {
  if (typeof captureCurrentFilterState !== 'function') return;
  try {
    localStorage.setItem(LS_SEARCH_STATE, JSON.stringify(captureCurrentFilterState()));
  } catch {}
}

/** Called once at startup (after filters/sliders/combos are initialized). */
function restoreLastSearchState() {
  let state;
  try { state = JSON.parse(localStorage.getItem(LS_SEARCH_STATE)); } catch {}
  if (!state || typeof restoreFilterState !== 'function') return false;
  restoreFilterState(state); // sets every control + calls applyFilters
  if (typeof updateSearchStarButton === 'function') updateSearchStarButton();
  if (typeof updateSearchClearButton === 'function') updateSearchClearButton();
  return true;
}

function sortFilteredMedia() {
  // Semantic results are already relevance-ordered — don't re-sort them
  if (semanticOrdered) return;

  // An active collection plays in its manual (playlist) order
  if (typeof applyCollectionOrder === 'function' && applyCollectionOrder(filteredMedia)) return;

  const [field, direction] = currentSort.split('_');
  const asc = direction === 'asc';

  filteredMedia.sort((a, b) => {
    let valA, valB;

    switch (field) {
      case 'processed':
        valA = a.processed_at || '';
        valB = b.processed_at || '';
        break;
      case 'name':
        valA = (a.filename || '').toLowerCase();
        valB = (b.filename || '').toLowerCase();
        break;
      case 'size':
        valA = a.filesize_bytes || 0;
        valB = b.filesize_bytes || 0;
        break;
      case 'duration':
        valA = a.duration_seconds || 0;
        valB = b.duration_seconds || 0;
        break;
      case 'rating':
        valA = a.user_rating || 0;
        valB = b.user_rating || 0;
        break;
      case 'views':
        valA = a.view_count || 0;
        valB = b.view_count || 0;
        break;
      case 'done':
        // Times a viewing session ended on this item (🏁 Done button)
        valA = a.done_count || 0;
        valB = b.done_count || 0;
        break;
      default:
        return 0;
    }

    if (valA < valB) return asc ? -1 : 1;
    if (valA > valB) return asc ? 1 : -1;
    return 0;
  });

  // ❤ Faves-first toggle: a second STABLE sort floats faves to the
  // top while preserving the primary order inside each group
  if (typeof favesFirst !== 'undefined' && favesFirst) {
    filteredMedia.sort((a, b) => (b.user_starred ? 1 : 0) - (a.user_starred ? 1 : 0));
  }
}
