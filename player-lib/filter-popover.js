/* =========================================================================
   FILTER POPOVER — one small card, shared by every filter chip
   =========================================================================
   Round 6 replaced the filters panel with a row of chips. Every chip opens
   the same thing: a fixed-position card anchored under it, holding either a
   list of values (optionally with a "type to filter" box when the list is
   long) or a custom body (the duration picker). Fixed rather than absolute
   for the same reason the round-5 panel is: an absolutely positioned card
   hanging off the search box counts towards the page's scroll height, and the
   scrollbar that brings in narrows the grid.

   One popover is open at a time. Escape, an outside click, or choosing a
   value closes it, and focus goes back to the chip that opened it. */

const FPOP_GAP = 6;          // px between the chip and the card
const FPOP_SEARCH_MIN = 8;   // list this long or longer gets a search box

let _fpop = null;            // { el, anchor, opts, items, active, onKey }

function filterPopoverIsOpen() {
  return _fpop !== null;
}

/** Which chip (or button) the open popover belongs to, or null. */
function filterPopoverAnchor() {
  return _fpop ? _fpop.anchor : null;
}

function closeFilterPopover({ restoreFocus = true } = {}) {
  if (!_fpop) return;
  const { el, anchor } = _fpop;
  const hadFocus = el.contains(document.activeElement);
  anchor?.setAttribute('aria-expanded', 'false');
  el.remove();
  _fpop = null;
  document.removeEventListener('mousedown', _fpopOutside, true);
  window.removeEventListener('resize', _fpopReposition, true);
  window.removeEventListener('scroll', _fpopReposition, true);
  if (restoreFocus && hadFocus && anchor && document.contains(anchor)) anchor.focus();
}

function _fpopOutside(e) {
  if (!_fpop) return;
  if (_fpop.el.contains(e.target)) return;
  if (_fpop.anchor && _fpop.anchor.contains(e.target)) return;   // the chip toggles itself
  closeFilterPopover({ restoreFocus: false });
}

function _fpopReposition() {
  if (!_fpop) return;
  const { el, anchor } = _fpop;
  if (!document.contains(anchor)) { closeFilterPopover({ restoreFocus: false }); return; }
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - w - 8));
  const top = Math.round(r.bottom) + FPOP_GAP;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.maxHeight = `${Math.max(140, Math.round(window.innerHeight - top - 12))}px`;
}

/* ── Option order ────────────────────────────────────────────────────────
   A long list answers two different questions: "where is the value I have in
   mind" (alphabetical) and "what does this library actually have a lot of"
   (count). The popover offers both and the caller remembers which one the
   user picked for that filter.

   "Any" is not a value, it is the way out of the filter, so it stays at the
   top in either order. It is always items[0] as the caller builds the list. */

const FPOP_SORTS = [
  { mode: 'az',    label: 'A to Z' },
  { mode: 'count', label: 'Count' },
];

/** Numbers inside a name sort the way a person reads them: 2 before 10. */
function _fpopByName(a, b) {
  return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
}

/* Song labels carry their tally in the text ("Title (12)") rather than in a
   count field, because music.js has always written them that way. Reading it
   back out is what lets Count mean something on that list too. */
function _fpopCount(it) {
  if (it.count != null) return it.count;
  const m = /\((\d+)\)\s*$/.exec(it.label || '');
  return m ? Number(m[1]) : 0;
}

function _fpopSortItems(items, mode) {
  if (items.length < 2) return items.slice();
  const [any, ...rest] = items;
  rest.sort(mode === 'count'
    ? (a, b) => (_fpopCount(b) - _fpopCount(a)) || _fpopByName(a, b)
    : _fpopByName);
  return [any, ...rest];
}

/* ── Options list ────────────────────────────────────────────────────────
   role="listbox" over role="option" rows. The rows are divs rather than
   buttons so arrow-key navigation can move a single "active" marker without
   moving DOM focus away from the search box the user is typing in. */

function _fpopRenderList(host, items, query, selectedValue) {
  const q = (query || '').trim().toLowerCase();
  const shown = q ? items.filter(i => i.label.toLowerCase().includes(q)) : items;
  if (!shown.length) {
    host.innerHTML = '<div class="fpop-empty">No matches</div>';
    return [];
  }
  host.innerHTML = shown.map((it, i) => `
    <div class="fpop-opt" role="option" id="fpopOpt${i}" data-idx="${i}"
         aria-selected="${it.value === selectedValue ? 'true' : 'false'}">
      <span class="fpop-opt-label">${escapeHtml(it.label)}</span>
      ${it.count != null ? `<span class="fpop-opt-count">${escapeHtml(String(it.count))}</span>` : ''}
    </div>`).join('');
  return shown;
}

/**
 * Open the popover under `anchor`.
 *
 * opts:
 *   title          heading text (the filter's name)
 *   items          [{ value, label, count }] — rendered as a listbox
 *   selected       the currently set value, marked aria-selected
 *   searchable     force the "type to filter" box on/off (default: by length)
 *   sort           { mode, onChange(mode) } — adds the A to Z / Count toggle
 *   onPick(value)  called when a row is chosen; the popover closes first
 *   body           extra HTML appended under the list (the duration picker)
 *   wireBody(el)   called with the popover element once it is in the DOM
 */
function openFilterPopover(anchor, opts) {
  const reopeningSame = _fpop && _fpop.anchor === anchor;
  closeFilterPopover({ restoreFocus: false });
  if (reopeningSame) return;                       // clicking the chip again closes it

  const el = document.createElement('div');
  el.className = 'fpop';
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', opts.title || 'Filter');

  const rawItems = opts.items || [];
  const searchable = opts.searchable != null ? opts.searchable : rawItems.length >= FPOP_SEARCH_MIN;
  const sortable = !!opts.sort;
  let sortMode = sortable && opts.sort.mode === 'count' ? 'count' : 'az';
  let items = sortable ? _fpopSortItems(rawItems, sortMode) : rawItems;

  // The search box and the order toggle share one row above the list, so the
  // card stays as short as it was. With no search box the toggle sits alone.
  const topRow = (searchable || sortable) ? `
    <div class="fpop-toprow">
      ${searchable ? '<input type="text" class="fpop-search" placeholder="Type to filter" autocomplete="off" aria-label="Type to filter the list">' : ''}
      ${sortable ? `<div class="fpop-sort" role="group" aria-label="Order the list">
        ${FPOP_SORTS.map(s => `
          <button type="button" class="fpop-sort-btn" data-fpop-sort="${s.mode}"
                  aria-pressed="${s.mode === sortMode ? 'true' : 'false'}">${s.label}</button>`).join('')}
      </div>` : ''}
    </div>` : '';

  el.innerHTML = `
    <div class="fpop-title">${escapeHtml(opts.title || '')}</div>
    ${topRow}
    ${rawItems.length ? `<div class="fpop-list" role="listbox" aria-label="${escapeHtml(opts.title || 'Options')}"></div>` : ''}
    ${opts.body || ''}`;
  document.body.appendChild(el);

  const list = el.querySelector('.fpop-list');
  const search = el.querySelector('.fpop-search');
  let shown = items;
  let active = -1;

  const setActive = (i) => {
    if (!list) return;
    const rows = [...list.querySelectorAll('.fpop-opt')];
    rows.forEach(r => r.classList.remove('active'));
    active = Math.max(-1, Math.min(i, rows.length - 1));
    if (active < 0) { list.removeAttribute('aria-activedescendant'); return; }
    const row = rows[active];
    row.classList.add('active');
    list.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  };

  const pick = (i) => {
    const it = shown[i];
    if (!it) return;
    closeFilterPopover();
    opts.onPick?.(it.value, it);
  };

  if (list) {
    shown = _fpopRenderList(list, items, '', opts.selected);
    // The set value starts active, so Enter on an untouched popover repeats it
    // rather than jumping to the top of the list.
    setActive(Math.max(0, shown.findIndex(i => i.value === opts.selected)));
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.fpop-opt');
      if (row) pick(Number(row.dataset.idx));
    });
    list.addEventListener('mousemove', (e) => {
      const row = e.target.closest('.fpop-opt');
      if (row) setActive(Number(row.dataset.idx));
    });
  }

  if (search && list) {
    search.addEventListener('input', () => {
      shown = _fpopRenderList(list, items, search.value, opts.selected);
      setActive(0);                                   // first match is the Enter target
    });
  }

  // Re-sorting reuses the list already in hand: the popover stays open, and
  // whatever is typed in the search box keeps filtering the new order.
  if (sortable && list) {
    el.querySelectorAll('[data-fpop-sort]').forEach(btn => {
      btn.addEventListener('click', () => {
        sortMode = btn.dataset.fpopSort;
        el.querySelectorAll('[data-fpop-sort]').forEach(b =>
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
        items = _fpopSortItems(rawItems, sortMode);
        shown = _fpopRenderList(list, items, search ? search.value : '', opts.selected);
        setActive(Math.max(0, shown.findIndex(i => i.value === opts.selected)));
        list.scrollTop = 0;
        opts.sort.onChange?.(sortMode);
      });
    });
  }

  _fpop = { el, anchor, opts };
  anchor.setAttribute('aria-expanded', 'true');

  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeFilterPopover(); return; }
    if (!list) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(shown.length - 1); }
    // Enter on the order toggle presses that button; it does not choose the
    // active row out from under the user.
    else if (e.key === 'Enter' && e.target.closest?.('[data-fpop-sort]')) { /* the button's own */ }
    else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
  });

  opts.wireBody?.(el, { close: () => closeFilterPopover() });

  _fpopReposition();
  document.addEventListener('mousedown', _fpopOutside, true);
  window.addEventListener('resize', _fpopReposition, true);
  window.addEventListener('scroll', _fpopReposition, true);

  // Focus lands inside so Escape, arrows and typing all reach the card.
  (search || el.querySelector('.fpop-focusable') || el).focus();
}
