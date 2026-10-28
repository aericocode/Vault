/* =========================================================================
   FILTER RAIL - the always-visible filter column (Modern library look only).

   Classic keeps today's chip row, popovers and More sheet. In Modern the user
   can open a rail on the left of the library that shows every filter at once,
   Stash style. The rail is NOT a second filter model: like the chips, every
   control here reads and writes the hidden #filterState elements and the
   filters.js globals (selectedMediaTypes, safeOnly, selectedExtensions)
   through the same helpers the chips use (fchipValue / fchipSet / fchipClear,
   fsegHtml, fchipItems), then lets applyFilters() run as it always did. So a
   change made here shows in the chip row, a saved search restored anywhere
   shows here, and the session restore needs nothing new.

   While the rail shows, the chip row, the type bar, the saved-search bar and
   the search Options button are hidden (the rail carries all of them); the
   search box stays above the grid.

   Shown only when all of these hold: Modern look, rail open (toggle button,
   persisted; until the user has chosen, open from RAIL_AUTO_OPEN_MIN wide),
   window at least RAIL_MIN_WINDOW wide, and the Library or Collections tab.
   Faces has no rail: its pages hide the library search and filters.

   On the Collections tab the rail starts with the collection list (folders
   indented under their parents); picking one opens it on the right, as a
   card click does. The filters below it still narrow an open collection.

   The Collections tab keeps its own Filters choice (settings
   collectionFiltersOpen, off by default): collections are already picked by
   hand, so with it off no filter UI shows there at all (body
   .coll-filters-hidden hides the chip row, type bar and saved-search bar)
   and the Filters button counts any filter still on. With it on, the rail
   shows where it can (Modern, wide enough), else the chip rows as in the
   Library. Classic gets the Filters button on that tab too (body .coll-tab).

   Hooks other modules call (all guarded with typeof at the call site):
   - renderFilterRail()   filter-chips.js renderFilterChipRow, saved-searches.js
                          renderSavedSearches, collections.js renderCollectionsTabBar
   - railIsShown()        is the rail on screen right now
   - railSync()           tabs.js switchTab (the tab decides which choice applies)
   - railUpdateToggle()   filter-chips.js renderFilterChipRow (the hidden-filter count)
   ========================================================================= */

const RAIL_AUTO_OPEN_MIN = 1300;  // never chosen: open from this window width up
const RAIL_MIN_WINDOW = 900;      // below this, Modern keeps the chip row
const RAIL_TAGS_SHOWN = 40;       // tags listed before "type to find more"
const RAIL_LIST_SHOWN = 30;       // other long lists (language, content, song)

let _railShown = false;
let _railRowsHidden = false;      // the Collections tab with its filters off
let _railQueued = false;
let _railBuilt = false;
let _railTagQuery = '';
let _railTagRemote = null;        // { q, items } from the server for a big library
let _railTagTimer = null;

function railIsShown() { return _railShown; }

/** The Collections tab on screen. Its filters have their own on / off choice. */
function railOnCollections() {
  return railTabFits() && typeof currentTab !== 'undefined' && currentTab === 'collections';
}

function railCollFiltersOpen() {
  return typeof window.vaultCollFiltersOpen === 'function' && window.vaultCollFiltersOpen();
}

function railOpenWanted() {
  if (railOnCollections()) return railCollFiltersOpen();
  const v = typeof window.vaultRailOpen === 'function' ? window.vaultRailOpen() : null;
  return v == null ? window.innerWidth >= RAIL_AUTO_OPEN_MIN : v;
}

/** Library or Collections on screen (Faces hides the filters, so no rail there). */
function railTabFits() {
  const main = document.getElementById('mainContainer');
  if (!main || main.style.display === 'none' || !main.classList.contains('active')) return false;
  if (main.classList.contains('faces-on')) return false;
  return typeof currentTab === 'undefined' || currentTab === 'library' || currentTab === 'collections';
}

function railShouldShow() {
  return typeof isModernLayout === 'function' && isModernLayout()
    && railOpenWanted()
    && window.innerWidth >= RAIL_MIN_WINDOW
    && railTabFits();
}

/** The rail sits under the sticky header; follow its bottom edge. This runs
    on every scrolled frame, and a custom property written on :root restyles
    the whole page even when the value is the same, so it writes only when
    the edge actually moved. */
let _railTop = '';
function railUpdateTop() {
  const header = document.getElementById('appHeader');
  const bottom = header ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
  const top = `${Math.round(bottom)}px`;
  if (top === _railTop) return;
  _railTop = top;
  document.documentElement.style.setProperty('--rail-top', top);
}

/**
 * The Filters button. While the Collections tab hides its filters, it says
 * how many are on ("Filters · 2"), so a hidden filter never hides files
 * without a word. Called on every filter change (renderFilterChipRow).
 */
function railUpdateToggle() {
  const btn = document.getElementById('railToggleBtn');
  if (!btn) return;
  const onColl = railOnCollections();
  const pressed = railOpenWanted() ? 'true' : 'false';
  if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
  const n = _railRowsHidden && typeof activeFilterCount === 'function' ? activeFilterCount() : 0;
  const count = document.getElementById('railToggleN');
  if (count) {
    const text = n ? ` · ${n}` : '';
    if (count.textContent !== text) count.textContent = text;
    count.hidden = !n;
  }
  btn.classList.toggle('has-hidden', n > 0);
  const title = n ? `${n} filter${n === 1 ? '' : 's'} on. Show filters`
    : onColl ? (railOpenWanted() ? 'Hide filters' : 'Show filters')
    : 'Show or hide the filter panel';
  if (btn.title !== title) btn.title = title;   // runs every scrolled frame
}

/** Put the rail (and the Collections tab's chip rows) on or off screen to match the settings, the window and the tab. */
function railSync(opts) {
  const rail = document.getElementById('filterRail');
  const onColl = railOnCollections();
  // Classic has a Filters button on the Collections tab only (css/filter-rail.css).
  document.body.classList.toggle('coll-tab', onColl);
  const rowsHidden = onColl && !railCollFiltersOpen();
  const show = railShouldShow();
  if (show) railUpdateTop();
  const rowsChanged = rowsHidden !== _railRowsHidden;
  _railRowsHidden = rowsHidden;
  railUpdateToggle();
  if (show === _railShown && !rowsChanged) return;
  if (rowsChanged) {
    document.body.classList.toggle('coll-filters-hidden', rowsHidden);
    // The More sheet hangs off the chip row.
    if (rowsHidden && typeof filtersAreOpen === 'function' && filtersAreOpen() && typeof setFiltersOpen === 'function') {
      setFiltersOpen(false);
    }
  }
  if (show !== _railShown) {
    _railShown = show;
    document.body.classList.toggle('rail-shown', show);
    if (rail) rail.hidden = !show;
    if (show) {
      // The More sheet hangs off the chip row, which the rail replaces.
      if (typeof filtersAreOpen === 'function' && filtersAreOpen() && typeof setFiltersOpen === 'function') {
        setFiltersOpen(false);
      }
      railRenderNow();
    }
  }
  // The chip row was hidden (by the rail or the Collections tab) and is back:
  // fit it to its width again.
  if (!show && !rowsHidden && typeof renderFilterChipRow === 'function') renderFilterChipRow();
  // The grid's width and top just changed: re-lay now, not on the observer's
  // next tick, so the columns never flash at the old count. Not at boot: the
  // library has not loaded yet and its first render lays out.
  if (!(opts && opts.boot)) window.vaultRelayoutLibrary?.();
}

function railToggle() {
  if (railOnCollections()) window.vaultSetCollFiltersOpen?.(!railCollFiltersOpen());
  else window.vaultSetRailOpen?.(!railOpenWanted());
  railSync();
  // Filters asked for as chip rows (no rail here): they live in the search
  // section, so a collapsed one (the Search button) opens to show them.
  const section = document.querySelector('.search-section');
  if (railOpenWanted() && !_railShown && section?.classList.contains('collapsed')
      && typeof setSearchCollapsed === 'function') {
    setSearchCollapsed(false);
    window.vaultRelayoutLibrary?.();
  }
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

/** Coalesce: a single filter change can ask several times in one turn. */
function renderFilterRail() {
  if (!_railShown || _railQueued) return;
  _railQueued = true;
  requestAnimationFrame(() => {
    _railQueued = false;
    railRenderNow();
  });
}

function railSecHtml(key, title, open, inner) {
  return `<details class="rail-sec" data-rail-sec="${key}"${open ? ' open' : ''}>
      <summary class="rail-sec-h"><span class="rail-sec-title">${escapeHtml(title)}</span><span class="rail-sec-val" id="railVal_${key}"></span></summary>
      <div class="rail-sec-body">${inner}</div>
    </details>`;
}

/** Built once; later renders fill the parts, so the tag search box keeps focus. */
function railBuild() {
  const body = document.getElementById('filterRailBody');
  if (!body) return;
  body.innerHTML = `
    <section class="rail-active-sec" aria-label="Filters in use">
      <div class="rail-active-head">
        <span class="rail-active-title" id="railActiveTitle">No filters in use</span>
        <button type="button" class="rail-clear-all" id="railClearAll" disabled>Clear all</button>
      </div>
      <div class="rail-active" id="railActive"></div>
    </section>
    ${railSecHtml('saved', 'Saved searches', true, '<div class="rail-saved" id="railSaved"></div>')}
    ${railSecHtml('collections', 'Collections', true, '<div class="rail-colls" id="railColls"></div>')}
    ${railSecHtml('options', 'Search options', false, '<div id="railOptions"></div>')}
    ${railSecHtml('type', 'Type', true, '<div class="rail-pills" id="railTypes"></div>')}
    ${railSecHtml('rating', 'Rating', true, '<div class="rail-list" id="railRating"></div>')}
    ${railSecHtml('duration', 'Duration', true, '<div class="rail-pills" id="railDuration"></div>')}
    ${railSecHtml('theme', 'Tags', true, `
      <input type="search" class="rail-search" id="railTagSearch" placeholder="Find a tag" autocomplete="off"
             aria-label="Find a tag">
      <div class="rail-list" id="railTags"></div>`)}
    ${railSecHtml('language', 'Language', false, '<div class="rail-list" id="railLanguage"></div>')}
    ${railSecHtml('about', 'About the file', false, `
      <div class="rail-sub">Content type</div><div class="rail-list" id="railContent"></div>
      <div class="rail-sub">Song</div><div class="rail-list" id="railSong"></div>
      <div class="rail-sub">Quality</div><div class="rail-list" id="railQuality"></div>
      <div class="rail-sub">Stream tag</div><div class="rail-list" id="railStreamTag"></div>`)}
    ${railSecHtml('marks', 'Your marks', false, '<div class="fsheet-rows" id="railMarks"></div>')}
    ${railSecHtml('housekeeping', 'Housekeeping', false, '<div class="fsheet-rows" id="railHousekeeping"></div>')}
    ${railSecHtml('ext', 'File extensions', false, '<div class="rail-pills" id="railExt"></div>')}`;
  _railBuilt = true;
}

function railSet(id, html) {
  const el = document.getElementById(id);
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

function railVal(key, text) {
  const el = document.getElementById(`railVal_${key}`);
  if (el && el.textContent !== text) el.textContent = text;
}

function railCount(n) {
  return n == null ? '' : `<span class="rail-count">${Number(n).toLocaleString()}</span>`;
}

/** One pickable row of a list filter. Clicking the picked row again clears it. */
function railOptHtml(key, it, selected) {
  const on = it.value === selected;
  return `<button type="button" class="rail-opt${on ? ' is-on' : ''}" data-rail-key="${key}"
      data-rail-value="${escapeHtml(String(it.value))}" aria-pressed="${on ? 'true' : 'false'}">
      <span class="rail-opt-label">${escapeHtml(String(it.label))}</span>${railCount(it.count)}</button>`;
}

/** A list filter (language, content, quality, song) without its "Any" row. */
function railListHtml(key, limit) {
  const d = FCHIP_DEFS[key];
  const selected = fchipValue(key);
  let items = fchipItems(key).filter(it => it.value !== d.def);
  if (!items.length) return '<p class="rail-empty">Nothing in the library yet.</p>';
  // Keep the picked one in view even when it is past the cut.
  let more = 0;
  if (items.length > limit) {
    const picked = items.find(it => it.value === selected);
    more = items.length - limit;
    items = items.slice(0, limit);
    if (picked && !items.includes(picked)) items.push(picked);
  }
  return items.map(it => railOptHtml(key, it, selected)).join('')
    + (more > 0 ? `<p class="rail-note">${more.toLocaleString()} more in the ${escapeHtml(d.label)} chip list.</p>` : '');
}

function railRenderActive() {
  const host = document.getElementById('railActive');
  if (!host) return;
  const keys = Object.keys(FCHIP_DEFS).filter(fchipIsSet);
  const here = [...host.querySelectorAll('[data-fchip-wrap]')].map(el => el.dataset.fchipWrap);
  const extras = [];
  if (selectedMediaTypes.length) {
    extras.push({ kind: 'types', label: `Type: ${selectedMediaTypes.join(', ')}` });
  }
  if (safeOnly) extras.push({ kind: 'safe', label: 'Plays here only' });
  if (selectedExtensions.length) {
    extras.push({ kind: 'ext', label: `File types: ${selectedExtensions.map(e => '.' + e).join(' ')}` });
  }
  FCHIP_SEARCH_OPTIONS.forEach(o => {
    if (document.getElementById(o.id)?.checked) extras.push({ kind: `opt:${o.id}`, label: `Search: ${o.label}` });
  });
  const extrasHtml = extras.map(x => `<span class="fchip is-set rail-xchip">
      <span class="fchip-main"><span class="fchip-value">${escapeHtml(x.label)}</span></span>
      <button type="button" class="fchip-x" data-rail-clear="${escapeHtml(x.kind)}" title="Clear this filter"
              aria-label="Clear ${escapeHtml(x.label)}">×</button>
    </span>`).join('');

  const same = here.length === keys.length && here.every((k, i) => k === keys[i]);
  if (same && keys.length) {
    // Same chips with new values: repaint in place, so a chip popover opened
    // from here keeps its anchor (the chip row does the same).
    host.querySelectorAll('[data-fchip-wrap]').forEach(fchipPatch);
    const old = host.querySelector('.rail-xchips');
    if (old && old.innerHTML !== extrasHtml) old.innerHTML = extrasHtml;
  } else {
    host.innerHTML = keys.map(fchipHtml).join('') + `<span class="rail-xchips">${extrasHtml}</span>`;
  }
  const n = keys.length + extras.length;
  const title = document.getElementById('railActiveTitle');
  if (title) title.textContent = n ? `${n} filter${n === 1 ? '' : 's'} in use` : 'No filters in use';
  const clear = document.getElementById('railClearAll');
  if (clear) clear.disabled = n === 0;
}

function railRenderCollections() {
  const sec = document.querySelector('#filterRailBody [data-rail-sec="collections"]');
  const onTab = typeof currentTab !== 'undefined' && currentTab === 'collections';
  if (sec) sec.hidden = !onTab;
  if (!onTab || typeof collectionsList === 'undefined') return;
  const byParent = new Map();
  collectionsList.forEach(c => {
    const p = c.parent_id ?? null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(c);
  });
  const active = typeof activeCollectionId !== 'undefined' ? activeCollectionId : null;
  const rows = [];
  const walk = (parent, depth, seen) => {
    const kids = (byParent.get(parent) || []).slice()
      .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1) || a.name.localeCompare(b.name));
    kids.forEach(c => {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      const on = c.id === active;
      rows.push(`<button type="button" class="rail-opt rail-coll${on ? ' is-on' : ''}" data-rail-coll="${c.id}"
          style="padding-left:${0.5 + depth * 0.9}rem" aria-pressed="${on ? 'true' : 'false'}"
          title="${c.kind === 'folder' ? 'Show everything in this folder' : 'Show this collection'}">
          <span class="rail-opt-label">${c.kind === 'folder' ? vaultIconSwap('📁 ', 'folder') : ''}${escapeHtml(c.name)}</span>${railCount(c.item_count)}</button>`);
      if (c.kind === 'folder') walk(c.id, depth + 1, seen);
    });
  };
  walk(null, 0, new Set());
  const all = `<button type="button" class="rail-opt${active == null ? ' is-on' : ''}" data-rail-coll=""
      aria-pressed="${active == null ? 'true' : 'false'}"><span class="rail-opt-label">All collections</span></button>`;
  railSet('railColls', rows.length ? all + rows.join('')
    : '<p class="rail-empty">No collections yet. Select files in the Library to collect them.</p>');
  railVal('collections', active != null ? (getCollectionById?.(active)?.name || '') : '');
}

function railRenderOptions() {
  railSet('railOptions', FCHIP_SEARCH_OPTIONS.map(o => `
    <label class="rail-check">
      <input type="checkbox" data-rail-opt="${o.id}" ${document.getElementById(o.id)?.checked ? 'checked' : ''}>
      <span><span class="rail-check-label">${escapeHtml(o.label)}</span>
        <span class="rail-check-desc">${escapeHtml(o.desc)}</span></span>
    </label>`).join(''));
  const n = searchOptionsOnCount();
  railVal('options', n ? `${n} on` : '');
}

const RAIL_TYPE_LABELS = { video: '🎬 Video', image: '🖼 Image', gif: '🎞 GIF', audio: '🎵 Audio', mix: '🎛 Mix' };

/** A type pill's label: Classic's emoji, Modern's line icon (player-lib/icons.js). */
function railTypeLabelHtml(type) {
  const [emoji, ...words] = RAIL_TYPE_LABELS[type].split(' ');
  return vaultIconSwap(emoji + ' ', VAULT_TYPE_ICON_NAMES[type]) + escapeHtml(words.join(' '));
}

function railRenderTypes() {
  const counts = (typeof Library !== 'undefined' && Library.facets && Library.facets.types) || {};
  let html = `<button type="button" class="rail-pill${selectedMediaTypes.length ? '' : ' is-on'}" data-rail-type=""
      aria-pressed="${selectedMediaTypes.length ? 'false' : 'true'}">All</button>`;
  for (const type of Object.keys(RAIL_TYPE_LABELS)) {
    if (!counts[type]) continue;
    const on = selectedMediaTypes.includes(type);
    html += `<button type="button" class="rail-pill${on ? ' is-on' : ''}" data-rail-type="${type}"
        aria-pressed="${on ? 'true' : 'false'}">${railTypeLabelHtml(type)} ${railCount(counts[type])}</button>`;
  }
  html += `<button type="button" class="rail-pill${safeOnly ? ' is-on' : ''}" data-rail-safe="1"
      aria-pressed="${safeOnly ? 'true' : 'false'}" title="Only formats known to play in Vault">${vaultIconSwap('★ ', 'star')}Plays here</button>`;
  railSet('railTypes', html);
  railVal('type', selectedMediaTypes.length ? selectedMediaTypes.join(', ') : '');
}

function railRenderRating() {
  const selected = fchipValue('rating');
  railSet('railRating', fchipItems('rating').map(it => railOptHtml('rating', it, selected)).join(''));
  railVal('rating', fchipIsSet('rating') ? fchipValueLabel('rating') : '');
}

function railRenderDuration() {
  const cur = fchipDurationRange();
  const preset = FCHIP_DUR_PRESETS.findIndex(p => p.min === cur.min && p.max === cur.max);
  const pills = FCHIP_DUR_PRESETS.map((p, i) => `
    <button type="button" class="rail-pill${i === preset ? ' is-on' : ''}" data-rail-dur="${i}"
            aria-pressed="${i === preset ? 'true' : 'false'}">${escapeHtml(p.label)}</button>`).join('');
  // The custom range reuses the chip's own duration picker, anchored here.
  const custom = `<button type="button" class="rail-pill${preset < 0 ? ' is-on' : ''}" data-fchip="duration"
      aria-haspopup="true" aria-expanded="false">${preset < 0 ? escapeHtml(fchipDurationLabel()) : 'Custom range'}</button>`;
  railSet('railDuration', pills + custom);
  railVal('duration', fchipIsSet('duration') ? fchipDurationLabel() : '');
}

function railRenderTags() {
  const host = document.getElementById('railTags');
  const input = document.getElementById('railTagSearch');
  if (!host) return;
  if (themeChipWaiting()) {
    if (input) input.disabled = true;
    railSet('railTags', '<p class="rail-note">Tags are available when search is ready.</p>');
    return;
  }
  if (input) input.disabled = false;
  const selected = fchipValue('theme');
  const q = _railTagQuery.trim().toLowerCase();
  let items;
  if (q && _railTagRemote && _railTagRemote.q === q) {
    items = _railTagRemote.items;
  } else {
    items = fchipItems('theme').filter(it => it.value !== '');
    if (q) items = items.filter(it => String(it.label).toLowerCase().includes(q));
  }
  items = items.slice().sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.label).localeCompare(String(b.label)));
  const total = items.length;
  let shown = items.slice(0, RAIL_TAGS_SHOWN);
  const picked = selected ? items.find(it => it.value === selected) || { value: selected, label: selected } : null;
  if (picked && !shown.some(it => it.value === picked.value)) shown = [picked, ...shown];
  let html = shown.map(it => railOptHtml('theme', it, selected)).join('');
  if (!total) html = `<p class="rail-empty">${q ? 'No tag matches that.' : 'No tags in the library yet.'}</p>`;
  else if (total > RAIL_TAGS_SHOWN) {
    html += `<p class="rail-note">Showing the ${RAIL_TAGS_SHOWN} most used of ${total.toLocaleString()}. Type to find others.</p>`;
  }
  railSet('railTags', html);
  railVal('theme', fchipIsSet('theme') ? fchipValueLabel('theme') : '');
}

/** A big library carries only its most used tags; ask the server for the rest. */
function railTagSearchInput(value) {
  _railTagQuery = value;
  railRenderTags();
  clearTimeout(_railTagTimer);
  const q = value.trim().toLowerCase();
  if (!q || !themeSearchIsRemote()) return;
  _railTagTimer = setTimeout(async () => {
    try {
      const items = await fetchThemeMatches(q);
      if (items && _railTagQuery.trim().toLowerCase() === q) {
        _railTagRemote = { q, items };
        railRenderTags();
      }
    } catch { /* the local list stays */ }
  }, 200);
}

function railRenderSaved() {
  const list = typeof savedSearches !== 'undefined' ? savedSearches : [];
  railSet('railSaved', list.length ? list.map(s => {
    const on = typeof activeSavedSearchId !== 'undefined' && activeSavedSearchId === s.id;
    return `<div class="rail-saved-row${on ? ' is-on' : ''}">
        <button type="button" class="rail-opt" data-rail-saved="${s.id}" aria-pressed="${on ? 'true' : 'false'}">
          <span class="rail-opt-label">${escapeHtml(s.name)}</span></button>
        <button type="button" class="rail-saved-x" data-rail-saved-del="${s.id}" title="Remove this saved search"
                aria-label="Remove the saved search ${escapeHtml(s.name)}">×</button>
      </div>`;
  }).join('') : '<p class="rail-empty">None yet. Type a search and choose Save in the list under the search box.</p>');
}

function railRenderLists() {
  railSet('railLanguage', railListHtml('language', RAIL_LIST_SHOWN));
  railVal('language', fchipIsSet('language') ? fchipValueLabel('language') : '');
  railSet('railContent', railListHtml('content', RAIL_LIST_SHOWN));
  railSet('railSong', railListHtml('song', RAIL_LIST_SHOWN));
  railSet('railQuality', railListHtml('quality', RAIL_LIST_SHOWN));
  railSet('railStreamTag', railListHtml('streamTag', RAIL_LIST_SHOWN));
  const about = ['content', 'song', 'quality', 'streamTag'].filter(fchipIsSet).length;
  railVal('about', about ? `${about} set` : '');
}

function railRenderSegs() {
  // fsegHtml is the More sheet's own row; filter-chips.js's document click
  // handler already writes it back, so these need no wiring of their own.
  const groups = { marks: FCHIP_SHEET[1].segs, housekeeping: FCHIP_SHEET[2].segs };
  for (const [key, segs] of Object.entries(groups)) {
    railSet(key === 'marks' ? 'railMarks' : 'railHousekeeping', segs.map(fsegHtml).join(''));
    const n = segs.filter(fchipIsSet).length;
    railVal(key, n ? `${n} set` : '');
  }
}

function railRenderExtensions() {
  const exts = [];
  Object.keys(extensionMap || {}).sort().forEach(type => {
    Object.entries(extensionMap[type]).forEach(([ext, c]) => exts.push({ ext, total: c.total }));
  });
  exts.sort((a, b) => a.ext.localeCompare(b.ext));
  railSet('railExt', exts.length ? exts.map(({ ext, total }) => {
    const on = selectedExtensions.includes(ext);
    return `<button type="button" class="rail-pill${on ? ' is-on' : ''}" data-rail-ext="${escapeHtml(ext)}"
        aria-pressed="${on ? 'true' : 'false'}">.${escapeHtml(ext)} ${railCount(total)}</button>`;
  }).join('') : '<p class="rail-empty">Nothing in the library yet.</p>');
  railVal('ext', selectedExtensions.length ? `${selectedExtensions.length} set` : '');
}

function railRenderNow() {
  if (!_railShown) return;
  if (!_railBuilt) railBuild();
  railRenderActive();
  railRenderCollections();
  railRenderOptions();
  railRenderTypes();
  railRenderRating();
  railRenderDuration();
  railRenderTags();
  railRenderSaved();
  railRenderLists();
  railRenderSegs();
  railRenderExtensions();
}

/* ── Writing back: the same steps the chip row and type bar take ─────────── */

function railPick(key, value) {
  const d = FCHIP_DEFS[key];
  if (!d) return;
  // Picking the row that is already on clears it, which a list with no
  // visible "Any" row needs.
  if (fchipValue(key) === value && value !== d.def) { fchipClear(key); return; }
  if (key === 'theme' && typeof ensureSelectOption === 'function') {
    ensureSelectOption(document.getElementById(d.el), value);
  }
  fchipSet(key, value);
}

function railToggleType(type) {
  if (type === '') selectedMediaTypes = [];
  else {
    const i = selectedMediaTypes.indexOf(type);
    if (i === -1) selectedMediaTypes.push(type);
    else selectedMediaTypes.splice(i, 1);
  }
  renderMediaTypeBar();
  applyFilters();
}

function railToggleExt(ext) {
  const i = selectedExtensions.indexOf(ext);
  if (i === -1) selectedExtensions.push(ext);
  else selectedExtensions.splice(i, 1);
  renderMediaTypeBar();
  renderTypeExtensionFilter();
  applyFilters();
}

function railSetSearchOption(id, on) {
  const target = document.getElementById(id);
  if (!target || target.checked === on) return;
  target.checked = on;
  target.dispatchEvent(new Event('change'));   // the same event the Options popover fires
  updateSearchOptionsButton();
  renderFilterRail();
}

function railClearExtra(kind) {
  if (kind === 'types') { selectedMediaTypes = []; renderMediaTypeBar(); applyFilters(); }
  else if (kind === 'safe') { safeOnly = false; renderMediaTypeBar(); applyFilters(); }
  else if (kind === 'ext') {
    selectedExtensions = [];
    renderMediaTypeBar();
    renderTypeExtensionFilter();
    applyFilters();
  } else if (kind.startsWith('opt:')) railSetSearchOption(kind.slice(4), false);
}

function railOnClick(e) {
  const t = (sel) => e.target.closest(sel);
  let el;
  if ((el = t('[data-rail-key]'))) return railPick(el.dataset.railKey, el.dataset.railValue);
  if ((el = t('[data-rail-type]'))) return railToggleType(el.dataset.railType);
  if ((el = t('[data-rail-safe]'))) { safeOnly = !safeOnly; renderMediaTypeBar(); applyFilters(); return; }
  if ((el = t('[data-rail-ext]'))) return railToggleExt(el.dataset.railExt);
  if ((el = t('[data-rail-dur]'))) {
    const p = FCHIP_DUR_PRESETS[Number(el.dataset.railDur)];
    if (p) fchipSetDuration(p.min, p.max);
    return;
  }
  if ((el = t('[data-rail-clear]'))) { e.stopPropagation(); return railClearExtra(el.dataset.railClear); }
  if ((el = t('[data-rail-saved-del]'))) return deleteSavedSearch(Number(el.dataset.railSavedDel));
  if ((el = t('[data-rail-saved]'))) return activateSavedSearch(Number(el.dataset.railSaved));
  if ((el = t('[data-rail-coll]'))) {
    const id = el.dataset.railColl;
    if (id === '') {
      if (activeCollectionId != null) closeCollection();
      if (currentFolderId != null) drillIntoFolder(null);
      return;
    }
    if (Number(id) !== activeCollectionId) openCollection(Number(id));
    return;
  }
  if (t('#railClearAll')) {
    // "Clear filters" leaves the search options alone; the rail lists them as
    // in use too, so its Clear all turns them off as well.
    FCHIP_SEARCH_OPTIONS.forEach(o => railSetSearchOption(o.id, false));
    // With no filter set the button means "Clear search": not this one's job.
    const cf = document.getElementById('clearFiltersBtn');
    if (cf && cf.dataset.mode !== 'search') cf.click();
  }
}

/* ── Wiring ────────────────────────────────────────────────────────────── */

function railInit() {
  document.getElementById('railToggleBtn')?.addEventListener('click', railToggle);
  document.getElementById('railCloseBtn')?.addEventListener('click', () => {
    if (railOnCollections()) window.vaultSetCollFiltersOpen?.(false);
    else window.vaultSetRailOpen?.(false);
    railSync();
  });
  const body = document.getElementById('filterRailBody');
  if (body) {
    body.addEventListener('click', railOnClick);
    body.addEventListener('change', (e) => {
      const box = e.target.closest('[data-rail-opt]');
      if (box) railSetSearchOption(box.dataset.railOpt, box.checked);
    });
    body.addEventListener('input', (e) => {
      if (e.target.id === 'railTagSearch') railTagSearchInput(e.target.value);
    });
  }

  // Tab switches show and hide #mainContainer; Faces toggles its classes.
  const main = document.getElementById('mainContainer');
  if (main && typeof MutationObserver === 'function') {
    new MutationObserver(() => railSync()).observe(main, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  window.addEventListener('vault:layout-style', () => railSync());
  window.addEventListener('vault:facets-changed', () => renderFilterRail());

  let queued = false;
  const onResizeOrScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      railSync();   // follows the header's edge too while the rail shows
    });
  };
  window.addEventListener('resize', onResizeOrScroll);
  window.addEventListener('scroll', () => { if (_railShown) onResizeOrScroll(); }, { passive: true });
  // A banner above the sticky header (setup-check.js) moves the header down
  // without changing its size, so the header's own observer never hears of it.
  window.addEventListener('vault:top-chrome', onResizeOrScroll);
  const header = document.getElementById('appHeader');
  if (header && typeof ResizeObserver === 'function') new ResizeObserver(onResizeOrScroll).observe(header);

  railSync({ boot: true });
}

// Runs before app.js starts the library, so a reload with the rail open lays
// the grid out at its narrower width from the first render.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', railInit);
} else {
  railInit();
}
