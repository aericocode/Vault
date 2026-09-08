/* =========================================================================
   FILTER CHIPS — the row under the type bubbles, and the More sheet
   =========================================================================
   Round 6 (option B2). What the user sees is a chip per filter; what the app
   READS is unchanged. Every control that applyFilters() and the saved-search
   format depend on still lives in #filterState (db-viewer.html), hidden. The
   chips set those elements' values and dispatch the same events the old
   panel dispatched, so nothing downstream knows the panel is gone.

   Row order: Rating, Duration, Language, Theme (always), then one chip for
   every other filter that is set, then More. The row keeps its height whether
   or not chips are set, so the grid never moves. */

const FCHIP_TRI = [
  { value: '',  label: 'All' },
  { value: '1', label: 'Only' },
  { value: '0', label: 'Hide' },
];

const FCHIP_SCAN = [
  { value: '',          label: 'All' },
  { value: 'success',   label: 'Done' },
  { value: 'failed',    label: 'Failed' },
  { value: 'unscanned', label: 'Unscanned' },
];

/* One entry per filter the chips expose.
     select   reads/writes a <select> in #filterState, options come from it
     tri      reads/writes a .tri-filter group ('' / '1' / '0', or the scan
              four-way), through the same helpers the old buttons used
     duration reads/writes the two range inputs
   `def` is the value that counts as "not set" — Trashed is the odd one out,
   because hiding the trash is the default, not showing everything. */
const FCHIP_DEFS = {
  rating:      { label: 'Rating',       type: 'select',   el: 'filterMinRating', def: '0', search: false, anyLabel: 'Any' },
  duration:    { label: 'Duration',     type: 'duration', def: null },
  language:    { label: 'Language',     type: 'select',   el: 'filterLanguage',  def: '',  search: true },
  theme:       { label: 'Theme',        type: 'select',   el: 'filterTheme',     def: '',  search: true },
  content:     { label: 'Content type', type: 'select',   el: 'filterContent',   def: '',  search: true },
  quality:     { label: 'Quality',      type: 'select',   el: 'filterQuality',   def: '',  search: false },
  song:        { label: 'Song',         type: 'select',   el: 'filterSong',      def: '',  search: true },
  fave:        { label: 'Fave',         type: 'tri', name: 'filterStarred',     def: '',  options: FCHIP_TRI },
  notes:       { label: 'Notes',        type: 'tri', name: 'filterHasNotes',    def: '',  options: FCHIP_TRI },
  flagged:     { label: 'Flagged',      type: 'tri', name: 'filterFlagged',     def: '',  options: FCHIP_TRI },
  collections: { label: 'Collections',  type: 'tri', name: 'filterCollections', def: '',  options: FCHIP_TRI },
  trashed:     { label: 'Trashed',      type: 'tri', name: 'filterTrashed',     def: '0', options: FCHIP_TRI },
  dupes:       { label: 'Dupes',        type: 'tri', name: 'filterDuplicates',  def: '',  options: FCHIP_TRI },
  unplayable:  { label: 'Unplayable',   type: 'tri', name: 'filterFailed',      def: '',  options: FCHIP_TRI },
  scan:        { label: 'Scan',         type: 'tri', name: 'filterScanStatus',  def: '',  options: FCHIP_SCAN },
};

const FCHIP_FIXED = ['rating', 'duration', 'language', 'theme'];
const FCHIP_EXTRA = ['content', 'quality', 'song', 'fave', 'notes', 'flagged',
  'collections', 'trashed', 'dupes', 'unplayable', 'scan'];

/* ── Duration ─────────────────────────────────────────────────────────── */
// null max = no cap. The minute scale and the weighted slider positions are
// the old ones (posToMinutes / minutesToPos in filters.js) — only the picker
// around them is new.
const FCHIP_DUR_PRESETS = [
  { label: 'Any',          min: 0,  max: null },
  { label: 'under 1 min',  min: 0,  max: 1 },
  { label: '1 to 10 min',  min: 1,  max: 10 },
  { label: 'over 10 min',  min: 10, max: null },
];

function fchipDurationRange() {
  const min = document.getElementById('durMinSlider');
  const max = document.getElementById('durMaxSlider');
  if (!min || !max) return { min: 0, max: null };
  return {
    min: posToMinutes(Number(min.value)),
    max: Number(max.value) >= 100 ? null : posToMinutes(Number(max.value)),
  };
}

function fchipSetDuration(minM, maxM) {
  const min = document.getElementById('durMinSlider');
  const max = document.getElementById('durMaxSlider');
  if (!min || !max) return;
  min.value = String(minutesToPos(minM || 0));
  max.value = maxM == null ? '100' : String(minutesToPos(maxM));
  if (typeof updateDurationUI === 'function') updateDurationUI();
  applyFilters();
}

function fchipDurationText(min, max) {
  if (!min && max == null) return 'Any';
  if (!min) return `under ${max}m`;
  if (max == null) return `over ${min}m`;
  return `${min}m to ${max}m`;
}

function fchipDurationLabel() {
  const { min, max } = fchipDurationRange();
  const preset = FCHIP_DUR_PRESETS.find(p => p.min === min && p.max === max);
  return preset ? preset.label : fchipDurationText(min, max);
}

/* ── Reading and writing one filter ───────────────────────────────────── */

function fchipValue(key) {
  const d = FCHIP_DEFS[key];
  if (!d) return null;
  if (d.type === 'select') return document.getElementById(d.el)?.value ?? d.def;
  if (d.type === 'tri') return getTriFilterValue(d.name);
  if (d.type === 'duration') {
    const { min, max } = fchipDurationRange();
    return (min === 0 && max == null) ? null : `${min}|${max}`;
  }
  return null;
}

function fchipIsSet(key) {
  return fchipValue(key) !== FCHIP_DEFS[key].def;
}

/** The words on a set chip, after "Language:". */
function fchipValueLabel(key) {
  const d = FCHIP_DEFS[key];
  if (d.type === 'duration') return fchipDurationLabel();
  const v = fchipValue(key);
  if (d.type === 'tri') return (d.options.find(o => o.value === v)?.label) || v;
  const sel = document.getElementById(d.el);
  if (!sel) return v;
  const opt = [...sel.options].find(o => o.value === v);
  return opt ? opt.textContent.trim() : v;
}

/** The list a chip's popover offers. "Any" is always first. */
function fchipItems(key) {
  const d = FCHIP_DEFS[key];
  if (d.type === 'tri') return d.options.slice();
  const sel = document.getElementById(d.el);
  if (!sel) return [];
  const opts = [...sel.options];
  if (key === 'rating') {
    // This select's own labels are already the ones the mock asks for.
    return opts.map(o => ({ value: o.value, label: o.textContent.trim() }));
  }
  // Option 0 is the "All Languages" placeholder — it becomes plain "Any".
  return [{ value: d.def, label: d.anyLabel || 'Any' }]
    .concat(opts.slice(1).map(o => ({ value: o.value, label: o.textContent.trim() })));
}

/** Write one filter, then let the existing plumbing re-run the filters. */
function fchipSet(key, value) {
  const d = FCHIP_DEFS[key];
  if (!d) return;
  if (d.type === 'select') {
    const sel = document.getElementById(d.el);
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change'));   // the same event the panel fired
  } else if (d.type === 'tri') {
    setTriFilterValue(d.name, value);
    applyFilters();
  }
}

function fchipClear(key) {
  const d = FCHIP_DEFS[key];
  if (d.type === 'duration') fchipSetDuration(0, null);
  else fchipSet(key, d.def);
}

/* ── Chip markup ──────────────────────────────────────────────────────── */

/* The chip is a <span> holding a button, not a single <button>, because the ×
   is a control of its own and a button inside a button is not valid HTML (the
   browser unnests it and the × stops working). It still reads and behaves as
   one pill. */
function fchipHtml(key) {
  const d = FCHIP_DEFS[key];
  const set = fchipIsSet(key);
  const value = set ? fchipValueLabel(key) : '';
  return `<span class="fchip${set ? ' is-set' : ''}" data-fchip-wrap="${key}">
    <button type="button" class="fchip-main" data-fchip="${key}"
            aria-haspopup="true" aria-expanded="false">
      <span class="fchip-name">${escapeHtml(d.label)}${set ? ':' : ''}</span>
      ${set ? `<span class="fchip-value">${escapeHtml(String(value))}</span>`
            : '<span class="fchip-caret" aria-hidden="true">▾</span>'}
    </button>
    ${set ? `<button type="button" class="fchip-x" data-fchip-clear="${key}"
        title="Clear this filter" aria-label="Clear the ${escapeHtml(d.label)} filter">×</button>` : ''}
  </span>`;
}

/** Every chip the row shows right now, in order. */
function fchipRowKeys() {
  return FCHIP_FIXED.concat(FCHIP_EXTRA.filter(fchipIsSet));
}

function renderFilterChipRow() {
  const host = document.getElementById('filterChipRow');
  if (!host) return;

  // Keep keyboard focus where it was: a chip that is re-rendered because its
  // own value changed should not drop the user back to the top of the page.
  const focused = document.activeElement?.closest?.('[data-fchip-wrap]')?.dataset.fchipWrap;
  const focusedX = document.activeElement?.hasAttribute?.('data-fchip-clear');

  host.innerHTML = fchipRowKeys().map(fchipHtml).join('') +
    `<button type="button" class="fchip fchip-more" id="moreFiltersChip"
       aria-haspopup="true" aria-expanded="false"
       title="Every other filter, in one sheet">More ▾</button>`;

  if (focused) {
    const wrap = host.querySelector(`[data-fchip-wrap="${focused}"]`);
    const target = (focusedX && wrap?.querySelector('.fchip-x')) || wrap?.querySelector('.fchip-main');
    target?.focus();
  }

  // The More chip is part of the markup above, so it comes back with
  // aria-expanded="false" every time. Put the truth back.
  if (moreSheetIsOpen()) {
    host.querySelector('#moreFiltersChip')?.setAttribute('aria-expanded', 'true');
    syncMoreSheet();
    // A chip appearing or leaving changes the row's wrap, and the sheet hangs
    // off the bottom of that row.
    if (typeof positionFiltersPanel === 'function') positionFiltersPanel();
  }

  updateClearFiltersButton();
  updateSearchOptionsButton();
}

/* ── Popovers ─────────────────────────────────────────────────────────── */

function openChipPopover(key, anchor) {
  const d = FCHIP_DEFS[key];
  if (!d) return;
  if (d.type === 'duration') return openDurationPopover(anchor);
  openFilterPopover(anchor, {
    title: d.label,
    items: fchipItems(key),
    selected: fchipValue(key),
    searchable: !!d.search,
    onPick: (v) => fchipSet(key, v),
  });
}

function openDurationPopover(anchor) {
  const cur = fchipDurationRange();
  openFilterPopover(anchor, {
    title: 'Duration',
    items: [],
    body: `
      <div class="fpop-pills" role="group" aria-label="Duration presets">
        ${FCHIP_DUR_PRESETS.map((p, i) => `
          <button type="button" class="fpop-pill${p.min === cur.min && p.max === cur.max ? ' is-on' : ''}"
                  data-dur-preset="${i}"${i === 0 ? ' data-fpop-focus="1"' : ''}>${p.label}</button>`).join('')}
      </div>
      <div class="fpop-range">
        <div class="fpop-range-label" id="fpopDurLabel"></div>
        <div class="duration-slider">
          <div class="duration-track"><div class="duration-fill" id="fpopDurFill"></div></div>
          <input type="range" id="fpopDurMin" min="0" max="100" step="1" value="${minutesToPos(cur.min)}"
                 aria-label="Shortest">
          <input type="range" id="fpopDurMax" min="0" max="100" step="1" value="${cur.max == null ? 100 : minutesToPos(cur.max)}"
                 aria-label="Longest">
        </div>
        <button type="button" class="fpop-use" id="fpopDurUse"></button>
      </div>`,
    wireBody: (el, api) => {
      const min = el.querySelector('#fpopDurMin');
      const max = el.querySelector('#fpopDurMax');
      const label = el.querySelector('#fpopDurLabel');
      const fill = el.querySelector('#fpopDurFill');
      const use = el.querySelector('#fpopDurUse');
      const read = () => ({
        min: posToMinutes(Number(min.value)),
        max: Number(max.value) >= 100 ? null : posToMinutes(Number(max.value)),
      });
      const paint = () => {
        if (Number(min.value) > Number(max.value)) min.value = max.value;
        const r = read();
        label.textContent = fchipDurationText(r.min, r.max);
        fill.style.left = `${min.value}%`;
        fill.style.width = `${Math.max(0, Number(max.value) - Number(min.value))}%`;
        use.textContent = `Use ${fchipDurationText(r.min, r.max)}`;
      };
      paint();
      [min, max].forEach(s => s.addEventListener('input', paint));
      use.addEventListener('click', () => {
        const r = read();
        api.close();
        fchipSetDuration(r.min, r.max);
      });
      el.querySelectorAll('[data-dur-preset]').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = FCHIP_DUR_PRESETS[Number(btn.dataset.durPreset)];
          api.close();
          fchipSetDuration(p.min, p.max);
        });
      });
      // Arrow keys belong to the sliders and pills here, not to a list.
      el.querySelector('.fpop-pill')?.classList.add('fpop-focusable');
    },
  });
}

/* ── The More sheet ───────────────────────────────────────────────────── */
/* One sheet, three groups. Language, Theme, Duration and Rating are not
   repeated here — they are always in the row above. Setting anything updates
   the state and the row immediately, and the sheet stays open. */

const FCHIP_SHEET = [
  { title: 'About the file', chips: ['content', 'song', 'quality'] },
  { title: 'Your marks',     segs: ['fave', 'notes', 'flagged', 'collections'] },
  { title: 'Housekeeping',   segs: ['trashed', 'dupes', 'unplayable', 'scan'] },
];

function fsegHtml(key) {
  const d = FCHIP_DEFS[key];
  const v = fchipValue(key);
  return `<div class="fseg-row" data-fseg-row="${key}">
    <span class="fseg-label" id="fsegLabel_${key}">${escapeHtml(d.label)}</span>
    <span class="fseg" role="group" aria-labelledby="fsegLabel_${key}">
      ${d.options.map(o => `
        <button type="button" class="fseg-btn" data-fseg="${key}" data-fseg-value="${escapeHtml(o.value)}"
                aria-pressed="${o.value === v ? 'true' : 'false'}">${escapeHtml(o.label)}</button>`).join('')}
    </span>
  </div>`;
}

function renderMoreSheet() {
  const sheet = document.getElementById('moreFiltersSheet');
  if (!sheet) return;
  sheet.innerHTML = FCHIP_SHEET.map(g => `
    <div class="fsheet-group">
      <h4 class="fsheet-h">${escapeHtml(g.title)}</h4>
      ${g.chips ? `<div class="fsheet-chips">${g.chips.map(fchipHtml).join('')}</div>` : ''}
      ${g.segs ? g.segs.map(fsegHtml).join('') : ''}
    </div>`).join('');
}

/** Repaint the sheet's pressed states and chip labels without rebuilding it. */
function syncMoreSheet() {
  const sheet = document.getElementById('moreFiltersSheet');
  if (!sheet) return;
  sheet.querySelectorAll('[data-fseg-row]').forEach(row => {
    const v = fchipValue(row.dataset.fsegRow);
    row.querySelectorAll('.fseg-btn').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.fsegValue === v ? 'true' : 'false'));
  });
  sheet.querySelectorAll('[data-fchip-wrap]').forEach(wrap => {
    const key = wrap.dataset.fchipWrap;
    const html = fchipHtml(key);
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    if (tmp.firstElementChild.outerHTML !== wrap.outerHTML) {
      const hadFocus = wrap.contains(document.activeElement);
      wrap.replaceWith(tmp.firstElementChild);
      if (hadFocus) tmp.firstElementChild.querySelector('.fchip-main')?.focus();
    }
  });
}

function moreSheetIsOpen() {
  return document.getElementById('moreFiltersSheet')?.classList.contains('active') === true;
}

/* ── Options menu (the four search modifiers) ─────────────────────────── */

const FCHIP_SEARCH_OPTIONS = [
  { id: 'metadataOnly',   label: 'Metadata only', desc: 'Search tags, notes and descriptions only, not the file name or path.' },
  { id: 'fuzzySearch',    label: 'Fuzzy',         desc: 'Match near-misses and typos as well as exact words.' },
  { id: 'semanticSearch', label: 'Semantic',      desc: 'Find by meaning rather than keywords, using a local model.' },
  { id: 'subtitleSearch', label: 'Subtitles',     desc: 'Also search English subtitle text and transcripts.' },
];

function searchOptionsOnCount() {
  return FCHIP_SEARCH_OPTIONS.filter(o => document.getElementById(o.id)?.checked).length;
}

function updateSearchOptionsButton() {
  const btn = document.getElementById('searchOptionsBtn');
  if (!btn) return;
  const n = searchOptionsOnCount();
  btn.textContent = n ? `Options (${n}) ▾` : 'Options ▾';
  btn.classList.toggle('is-set', n > 0);
}

function openSearchOptionsPopover(anchor) {
  openFilterPopover(anchor, {
    title: 'Search options',
    items: [],
    body: `<div class="fpop-checks" role="group" aria-label="Search options">
      ${FCHIP_SEARCH_OPTIONS.map(o => `
        <label class="fpop-check">
          <input type="checkbox" data-search-opt="${o.id}" ${document.getElementById(o.id)?.checked ? 'checked' : ''}>
          <span class="fpop-check-text">
            <span class="fpop-check-label">${escapeHtml(o.label)}</span>
            <span class="fpop-check-desc">${escapeHtml(o.desc)}</span>
          </span>
        </label>`).join('')}
    </div>`,
    wireBody: (el) => {
      el.querySelectorAll('[data-search-opt]').forEach(box => {
        box.addEventListener('change', () => {
          const target = document.getElementById(box.dataset.searchOpt);
          if (!target) return;
          target.checked = box.checked;
          target.dispatchEvent(new Event('change'));  // the same event as before
          updateSearchOptionsButton();
        });
      });
      el.querySelector('input')?.classList.add('fpop-focusable');
    },
  });
}

/* ── Clear filters ────────────────────────────────────────────────────── */

/** Is anything at all narrowing the grid (search text aside)? */
function anyFilterIsSet() {
  if (Object.keys(FCHIP_DEFS).some(fchipIsSet)) return true;
  if (typeof selectedMediaTypes !== 'undefined' && selectedMediaTypes.length) return true;
  if (typeof selectedExtensions !== 'undefined' && selectedExtensions.length) return true;
  if (typeof safeOnly !== 'undefined' && safeOnly) return true;
  return false;
}

function updateClearFiltersButton() {
  const btn = document.getElementById('clearFiltersBtn');
  if (!btn) return;
  const on = anyFilterIsSet();
  btn.disabled = !on;
  btn.title = on ? 'Clear every filter. The search text stays.' : 'No filters set';
}

/* ── Wiring ───────────────────────────────────────────────────────────── */

document.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-fchip]');
  if (chip) { openChipPopover(chip.dataset.fchip, chip); return; }

  const x = e.target.closest('[data-fchip-clear]');
  if (x) { e.stopPropagation(); fchipClear(x.dataset.fchipClear); return; }

  const seg = e.target.closest('[data-fseg]');
  if (seg) { fchipSet(seg.dataset.fseg, seg.dataset.fsegValue); return; }

  const opts = e.target.closest('#searchOptionsBtn');
  if (opts) { openSearchOptionsPopover(opts); return; }
});

/* Enter and Space open a chip. A native <button> does that on its own, but
   spelling it out keeps Space from scrolling the page underneath and gives
   the sheet's segments the same behaviour as the row. preventDefault stops
   the browser's own synthesized click, so nothing fires twice. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  const t = e.target.closest?.('[data-fchip], [data-fchip-clear], [data-fseg], #searchOptionsBtn, #moreFiltersChip');
  if (!t) return;
  e.preventDefault();
  t.click();
});

document.addEventListener('DOMContentLoaded', () => {
  renderFilterChipRow();
  updateSearchOptionsButton();
});
