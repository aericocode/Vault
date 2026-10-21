/* =========================================================================
   DOCK EDIT - editing a file's details in place in the docked preview pane
   (Modern look only; LIBRARY_LAYOUT_SPEC "Round 5", mockup option 3A).

   dock.js paints the pane out of named parts (data-dock-part). This file
   owns the editable ones: Description, Tags, Themes, Places, Collections and
   Notes. Each part carries the id of the file it was painted for
   (data-id), and every save reads that id from the part, never the pane's
   current pick, so an edit always lands on the file it was started on even
   when the pick moves while it saves.

   Saving goes through the same calls as the player's Info panel:
   saveMetaFields (POST /api/media/:id/metadata), addNoteTextSaved / postFlags
   (notes) and changeCollectionMembership (collections), so the grid, table,
   dock and player stay in step through Library.patchRow.

   Repaints: dock.js repaints a part only when its HTML changed, and a part
   being edited (focus inside, or an editor open) keeps its editor: only its
   label, chips and notes list are refreshed (dockEditPatchBusy).

   Loaded before dock.js. Top level declares functions and constants only,
   so the pure helpers can be tested in a VM (test/dock-edit.test.js).
   ========================================================================= */

const DOCK_CHIP_FIELDS = {
  tags:      { label: 'Tags',   empty: 'Add tags' },
  themes:    { label: 'Themes', empty: 'Add themes' },
  locations: { label: 'Places', empty: 'Add places' },
};
const DOCK_EDIT_PARTS = ['description', 'tags', 'themes', 'locations', 'collections', 'notes'];
const DOCK_SUGGEST_MAX = 8;
const DOCK_COLL_MAX = 50;
const DOCK_TICK_MS = 1500;

/* ── Pure helpers (tested) ─────────────────────────────────────────────── */

/** Typed text to chip values: split on commas, trimmed, empties dropped. */
function dockParseChipText(text) {
  return String(text == null ? '' : text).split(',').map(s => s.trim()).filter(Boolean);
}

/** Add values to a chip list, skipping any already there (any case) and
 *  repeats within the values. Returns { list, added }. */
function dockMergeChips(list, values) {
  const out = Array.isArray(list) ? list.slice() : [];
  const seen = new Set(out.map(v => String(v).toLowerCase()));
  const added = [];
  for (const v of values || []) {
    const t = String(v).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    added.push(t);
  }
  return { list: out, added };
}

/** The list without the first chip equal to value (exact match). */
function dockRemoveChip(list, value) {
  const out = Array.isArray(list) ? list.slice() : [];
  const i = out.indexOf(value);
  if (i >= 0) out.splice(i, 1);
  return out;
}

/** Suggestions for typed text: values containing it (any case), minus the
 *  ones the file already has. Values that start with it come first, then the
 *  most used, then A to Z. items: [{ value, count }]. */
function dockSuggest(items, query, exclude, limit = DOCK_SUGGEST_MAX) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const skip = new Set((exclude || []).map(v => String(v).toLowerCase()));
  const hits = [];
  for (const it of items || []) {
    if (!it || it.value == null) continue;
    const v = String(it.value);
    const low = v.toLowerCase();
    if (skip.has(low) || !low.includes(q)) continue;
    hits.push({ value: v, count: Number(it.count) || 0, starts: low.startsWith(q) });
  }
  hits.sort((a, b) => (b.starts - a.starts) || (b.count - a.count) || a.value.localeCompare(b.value));
  return hits.slice(0, limit).map(({ value, count }) => ({ value, count }));
}

/** How many of these rows have each value of a JSON-array field. */
function dockTallyValues(rows, field) {
  const counts = new Map();
  for (const r of rows || []) {
    let arr = r && r[field];
    if (typeof arr === 'string') {
      try { arr = JSON.parse(arr); } catch { arr = null; }
    }
    if (!Array.isArray(arr)) continue;
    const once = new Set();
    for (const v of arr) {
      if (typeof v !== 'string') continue;
      const t = v.trim();
      if (!t || once.has(t)) continue;
      once.add(t);
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts].map(([value, count]) => ({ value, count }));
}

/** Collections the picker offers: real collections (not folders) the file is
 *  not in, whose name contains the typed text, A to Z. */
function dockCollectionMatches(colls, query, memberIds, limit = DOCK_COLL_MAX) {
  const q = String(query || '').trim().toLowerCase();
  const inSet = new Set(memberIds || []);
  return (colls || [])
    .filter(c => c && c.kind !== 'folder' && !inSet.has(c.id)
      && (!q || String(c.name || '').toLowerCase().includes(q)))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, limit);
}

/** Is a description edit a change worth saving? (Trimmed, as saved.) */
function dockDescChanged(before, typed) {
  return String(before || '').trim() !== String(typed || '').trim();
}

/* ── State ─────────────────────────────────────────────────────────────── */

// "id:field" -> { list, n }: chips shown before their save lands, and how
// many saves for that field are still queued.
const _dockChipQueue = new Map();
// "id:field" -> time the small "Saved" tick goes away.
const _dockTicks = new Map();

function _dockKey(id, field) { return `${id}:${field}`; }

/* ── Data ──────────────────────────────────────────────────────────────── */

/** The chips a field shows: the queued list while saves are in flight. */
function dockChipList(m, field) {
  const q = m ? _dockChipQueue.get(_dockKey(m.id, field)) : null;
  if (q) return q.list.slice();
  return m ? safeParseJSON(m[field], []).filter(v => typeof v === 'string') : [];
}

/** The collections (not folders) this file is in, from collections.js's cache. */
function dockCollectionsOf(id) {
  if (typeof collectionsList === 'undefined' || typeof collectionMembers === 'undefined') return [];
  return collectionsList.filter(c => c.kind !== 'folder' && (collectionMembers.get(c.id) || []).includes(id));
}

/** For dockFieldSig: what the Collections part depends on. */
function dockCollectionsSig(id) {
  return dockCollectionsOf(id).map(c => `${c.id}=${c.name}`).join(',');
}

/* ── Rendering ─────────────────────────────────────────────────────────── */

function dockLabelHtml(id, field, text) {
  const on = (_dockTicks.get(_dockKey(id, field)) || 0) > Date.now();
  return `<div class="dock-label"><span>${text}</span>`
    + `<span class="dock-saved${on ? ' is-on' : ''}" aria-live="polite">${on ? '✓ Saved' : ''}</span></div>`;
}

function dockChipHtml(value, act, extra) {
  const v = escapeHtml(value);
  return `<span class="dock-chip"><span class="dock-chip-text">${v}</span>`
    + `<button type="button" class="dock-chip-x" tabindex="-1" data-dock-act="${act}" ${extra}`
    + ` aria-label="Remove ${v}" title="Remove">✕</button></span>`;
}

function dockChipsHtml(m, field) {
  return dockChipList(m, field).map(v => dockChipHtml(v, 'chip-remove', `data-value="${escapeHtml(v)}"`)).join('');
}

function dockCollChipsHtml(m) {
  return dockCollectionsOf(m.id).map(c => dockChipHtml(c.name, 'coll-remove', `data-coll="${Number(c.id)}"`)).join('');
}

function dockNotesListHtml(m) {
  const notes = safeParseJSON(m.user_notes || '', []);
  if (!Array.isArray(notes) || !notes.length) return '';
  return notes.map(n => `<div class="dock-note">
      <div class="dock-note-text">${escapeHtml(String(n && n.text != null ? n.text : ''))}</div>
      <div class="dock-note-time">${escapeHtml(String(n && n.timestamp != null ? n.timestamp : ''))}</div>
    </div>`).join('');
}

/** One editable part's outer HTML (dock.js puts them in order). */
function dockEditPartHtml(m, key) {
  const id = Number(m.id);
  const open = (cls) => `<section class="dock-field ${cls}" data-dock-part="${key}" data-id="${id}">`;
  if (key === 'description') {
    const d = String(m.description || '').trim();
    return `${open('dock-field-desc')}
      ${dockLabelHtml(id, key, 'Description')}
      <button type="button" class="dock-desc-view${d ? '' : ' is-empty'}" data-dock-act="desc-edit"
              title="Click to edit">${d ? escapeHtml(d) : 'Add a description'}</button>
    </section>`;
  }
  if (DOCK_CHIP_FIELDS[key]) {
    const f = DOCK_CHIP_FIELDS[key];
    return `${open('dock-field-chips')}
      ${dockLabelHtml(id, key, f.label)}
      <div class="dock-chipbox">
        <span class="dock-chips">${dockChipsHtml(m, key)}</span>
        <input type="text" class="dock-chip-input" placeholder="${f.empty}" aria-label="${f.empty}"
               autocomplete="off" spellcheck="false">
      </div>
      <div class="dock-suggest" role="listbox" hidden></div>
    </section>`;
  }
  if (key === 'collections') {
    const has = dockCollectionsOf(id).length > 0;
    return `${open('dock-field-coll')}
      ${dockLabelHtml(id, key, 'Collections')}
      <div class="dock-chipbox dock-chipbox-plain">
        <span class="dock-chips">${dockCollChipsHtml(m)}</span>
        <button type="button" class="dock-add-btn${has ? '' : ' is-empty'}" data-dock-act="coll-open"
                title="Add to a collection">${has ? '+' : '+ Add to a collection'}</button>
      </div>
      <div class="dock-coll-picker" hidden>
        <input type="text" class="dock-coll-filter" placeholder="Find a collection" aria-label="Find a collection"
               autocomplete="off" spellcheck="false">
        <div class="dock-coll-list" role="listbox"></div>
      </div>
    </section>`;
  }
  if (key === 'notes') {
    return `${open('dock-field-notes')}
      ${dockLabelHtml(id, key, 'Notes')}
      <div class="dock-notes-list">${dockNotesListHtml(m)}</div>
      <textarea class="dock-note-input" rows="1" placeholder="Add a note" aria-label="Add a note"></textarea>
    </section>`;
  }
  return '';
}

/** Is this part in the middle of an edit (its editor must survive a repaint)? */
function dockEditPartBusy(el) {
  if (!el || !el.matches || !el.matches('.dock-field')) return false;
  if (el.classList.contains('is-editing')) return true;
  const a = document.activeElement;
  return !!(a && a !== document.body && el.contains(a));
}

/** Repaint the display bits of a part that is being edited, leaving its
 *  input, textarea or picker (and the focus) alone. */
function dockEditPatchBusy(el, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  const fresh = tpl.content.firstElementChild;
  if (!fresh) return;
  for (const sel of ['.dock-label', '.dock-chips', '.dock-notes-list', '.dock-add-btn']) {
    const now = el.querySelector(sel);
    const next = fresh.querySelector(sel);
    if (now && next && now.outerHTML !== next.outerHTML) now.replaceWith(next);
  }
  if (el.matches('[data-dock-part="collections"]')) dockCollRenderList(el);
}

/* ── Saved tick ────────────────────────────────────────────────────────── */

function dockTick(id, field) {
  const key = _dockKey(id, field);
  _dockTicks.set(key, Date.now() + DOCK_TICK_MS);
  dockEditRefresh();
  setTimeout(() => {
    if ((_dockTicks.get(key) || 0) <= Date.now()) {
      _dockTicks.delete(key);
      dockEditRefresh();
    }
  }, DOCK_TICK_MS + 30);
}

/** Ask dock.js for a repaint of the pane (no-op when it is not shown). */
function dockEditRefresh() {
  if (typeof dockRefresh === 'function') dockRefresh();
}

/* ── Description ───────────────────────────────────────────────────────── */

function dockDescOpen(section) {
  const id = Number(section.dataset.id);
  const m = getMediaById(id);
  const view = section.querySelector('.dock-desc-view');
  if (!m || !view || section._dockDesc) return;
  const ta = document.createElement('textarea');
  ta.className = 'dock-desc-input';
  ta.setAttribute('aria-label', 'Description');
  ta.placeholder = 'Add a description';
  ta.value = m.description || '';
  ta.rows = Math.min(10, Math.max(3, Math.ceil(ta.value.length / 40) + 1));
  // `opened` is what the editor started from: leaving it untouched must not
  // write that back over a description that arrived meanwhile (a scan, the
  // AI, the player panel).
  section._dockDesc = { ta, saving: false, opened: ta.value };
  section.classList.add('is-editing');
  view.replaceWith(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

/** Close the editor and show the saved text again. */
function dockDescClose(section) {
  section._dockDesc = null;
  section.classList.remove('is-editing');
  const m = getMediaById(Number(section.dataset.id));
  if (!section.isConnected || !m) return;
  const tpl = document.createElement('template');
  tpl.innerHTML = dockEditPartHtml(m, 'description').trim();
  const fresh = tpl.content.firstElementChild;
  if (fresh) section.replaceWith(fresh);
}

function dockDescCommit(section) {
  const st = section._dockDesc;
  if (!st || st.saving) return;
  const id = Number(section.dataset.id);
  const m = getMediaById(id);
  const typed = st.ta.value.trim();
  if (!m || !dockDescChanged(st.opened, typed)) { dockDescClose(section); return; }
  st.saving = true;
  saveMetaFields(id, { description: typed }, null).then((ok) => {
    st.saving = false;
    if (section._dockDesc !== st) return;
    if (ok) {
      dockDescClose(section);
      dockTick(id, 'description');
    }
    // Failed: the editor stays open with the text (saveMetaFields showed
    // "Save failed").
  });
}

/* ── Tags, Themes, Places ──────────────────────────────────────────────── */

/** Save a new chip list for one file's field. Saves for the same field run
 *  in order, each with the list as it stood when it was asked for, and the
 *  chips show the newest list straight away. */
function dockChipSave(id, field, list, onFail) {
  const key = _dockKey(id, field);
  let q = _dockChipQueue.get(key);
  if (!q) { q = { list, n: 0, chain: Promise.resolve() }; _dockChipQueue.set(key, q); }
  q.list = list.slice();
  q.n++;
  dockEditRefresh();
  const run = q.chain.then(() => saveMetaFields(id, { [field]: list }, null)).catch(() => false);
  q.chain = run;
  return run.then((ok) => {
    q.n--;
    if (q.n === 0 && _dockChipQueue.get(key) === q) _dockChipQueue.delete(key);
    if (ok) dockTick(id, field);
    else {
      if (q.n === 0 && onFail) onFail();
      dockEditRefresh();
    }
    return ok;
  });
}

function dockChipAdd(section, values, input) {
  const id = Number(section.dataset.id);
  const field = section.dataset.dockPart;
  const m = getMediaById(id);
  if (!m || !DOCK_CHIP_FIELDS[field]) return;
  const { list, added } = dockMergeChips(dockChipList(m, field), values);
  if (!added.length) return;
  const typed = added.join(', ');
  dockChipSave(id, field, list, () => {
    // Keep the edit: hand the text back if the box is still there and empty.
    if (input && input.isConnected && !input.value) input.value = typed;
  });
}

function dockChipRemove(section, value) {
  const id = Number(section.dataset.id);
  const field = section.dataset.dockPart;
  const m = getMediaById(id);
  if (!m || !DOCK_CHIP_FIELDS[field]) return;
  const cur = dockChipList(m, field);
  if (!cur.includes(value)) return;
  dockChipSave(id, field, dockRemoveChip(cur, value));
}

/** Whatever is typed in the box becomes chips (Enter, comma, leaving it). */
function dockChipCommitText(section, input) {
  const values = dockParseChipText(input.value);
  input.value = '';
  dockSuggestHide(section);
  if (values.length) dockChipAdd(section, values, input);
}

/* Suggestions: the Themes row uses the library-wide theme counts the filter
   chips and rail use (Library.facets.theme, plus the server's theme search
   when the facets carry only the top themes). Tags and Places have no
   library-wide count source, so they count the rows this viewer has loaded. */

function dockSuggestSource(section) {
  if (section._dockSrc) return section._dockSrc;
  const field = section.dataset.dockPart;
  let items = null;
  const facets = typeof Library !== 'undefined' ? Library.facets : null;
  if (field === 'themes' && facets && facets.theme) {
    items = Object.entries(facets.theme).map(([value, count]) => ({ value, count }));
  }
  if (!items) {
    const rows = [];
    if (typeof Library !== 'undefined' && Library.eachCachedRow) Library.eachCachedRow(r => rows.push(r));
    items = dockTallyValues(rows, field);
  }
  section._dockSrc = items;
  return items;
}

function dockSuggestHide(section) {
  const box = section.querySelector('.dock-suggest');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  section._dockSugg = null;
  clearTimeout(section._dockRemoteTimer);
}

function dockSuggestPaint(section, items) {
  const box = section.querySelector('.dock-suggest');
  if (!box) return;
  section._dockSugg = { items, active: -1 };
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = items.map((it, i) => `<div class="dock-suggest-item" role="option" data-i="${i}">`
    + `<span class="dock-suggest-text">${escapeHtml(it.value)}</span>`
    + `<span class="dock-suggest-count">${Number(it.count) || 0}</span></div>`).join('');
  box.hidden = false;
}

function dockSuggestMove(section, step) {
  const s = section._dockSugg;
  if (!s || !s.items.length) return false;
  // -1 is "none picked": the typed text is what Enter adds.
  const n = s.items.length;
  s.active = step > 0 ? (s.active + 1 >= n ? -1 : s.active + 1) : (s.active - 1 < -1 ? n - 1 : s.active - 1);
  section.querySelectorAll('.dock-suggest-item').forEach((el, i) => {
    el.classList.toggle('is-active', i === s.active);
    el.setAttribute('aria-selected', i === s.active ? 'true' : 'false');
  });
  return true;
}

function dockSuggestUpdate(section, input) {
  const field = section.dataset.dockPart;
  const m = getMediaById(Number(section.dataset.id));
  const q = input.value;
  if (!q.trim() || q.includes(',')) { dockSuggestHide(section); return; }
  const have = dockChipList(m, field);
  dockSuggestPaint(section, dockSuggest(dockSuggestSource(section), q, have));
  // Themes beyond the facets' top list: ask the server, as the rail does.
  clearTimeout(section._dockRemoteTimer);
  if (field === 'themes' && typeof themeSearchIsRemote === 'function' && themeSearchIsRemote()
      && typeof fetchThemeMatches === 'function') {
    const want = q.trim().toLowerCase();
    section._dockRemoteTimer = setTimeout(async () => {
      try {
        const items = await fetchThemeMatches(want);
        if (items && input.isConnected && input.value.trim().toLowerCase() === want) {
          dockSuggestPaint(section, dockSuggest(items, want, dockChipList(getMediaById(Number(section.dataset.id)), field)));
        }
      } catch { /* the local list stays */ }
    }, 200);
  }
}

function dockChipKeydown(e, section, input) {
  if (e.isComposing) return;
  const sugg = section._dockSugg;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (sugg && sugg.active >= 0 && sugg.items[sugg.active]) {
      const v = sugg.items[sugg.active].value;
      input.value = '';
      dockSuggestHide(section);
      dockChipAdd(section, [v], input);
      return;
    }
    dockChipCommitText(section, input);
    return;
  }
  if (e.key === ',') {
    e.preventDefault();
    dockChipCommitText(section, input);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (dockSuggestMove(section, e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    return;
  }
  if (e.key === 'Backspace' && !input.value) {
    const m = getMediaById(Number(section.dataset.id));
    const cur = dockChipList(m, section.dataset.dockPart);
    if (cur.length) { e.preventDefault(); dockChipRemove(section, cur[cur.length - 1]); }
    return;
  }
  if (e.key === 'Escape') {
    // Cancels the typed text; with nothing typed, leaves the box so the
    // arrow keys walk the grid again.
    if (input.value || section._dockSugg) { input.value = ''; dockSuggestHide(section); }
    else input.blur();
  }
}

/* ── Collections ───────────────────────────────────────────────────────── */

function dockCollOpen(section) {
  const picker = section.querySelector('.dock-coll-picker');
  const filter = section.querySelector('.dock-coll-filter');
  if (!picker || !filter) return;
  section.classList.add('is-editing');
  picker.hidden = false;
  section._dockColl = { active: 0 };
  dockCollRenderList(section);
  filter.focus();
}

function dockCollClose(section) {
  const picker = section.querySelector('.dock-coll-picker');
  if (picker) picker.hidden = true;
  const filter = section.querySelector('.dock-coll-filter');
  if (filter) filter.value = '';
  section._dockColl = null;
  section.classList.remove('is-editing');
  dockEditRefresh();
}

function dockCollMatches(section) {
  const filter = section.querySelector('.dock-coll-filter');
  const id = Number(section.dataset.id);
  return dockCollectionMatches(typeof collectionsList !== 'undefined' ? collectionsList : [],
    filter ? filter.value : '', dockCollectionsOf(id).map(c => c.id));
}

function dockCollRenderList(section) {
  const list = section.querySelector('.dock-coll-list');
  const st = section._dockColl;
  if (!list || !st) return;
  const hits = dockCollMatches(section);
  if (st.active >= hits.length) st.active = hits.length - 1;
  if (st.active < 0 && hits.length) st.active = 0;
  const anyColl = typeof collectionsList !== 'undefined' && collectionsList.some(c => c.kind !== 'folder');
  list.innerHTML = hits.length
    ? hits.map((c, i) => `<div class="dock-coll-item${i === st.active ? ' is-active' : ''}" role="option"
        data-coll="${Number(c.id)}" aria-selected="${i === st.active}">${escapeHtml(c.name)}</div>`).join('')
    : `<div class="dock-coll-none">${anyColl ? 'No other collections match.' : 'No collections yet. Make one in the Collections tab.'}</div>`;
}

function dockCollChange(section, collId, adding) {
  const id = Number(section.dataset.id);
  if (!collId || typeof changeCollectionMembership !== 'function') return;
  changeCollectionMembership(collId, [id], adding).then((ok) => {
    if (ok) dockTick(id, 'collections');
    else dockEditRefresh();
  });
  // The cache changed optimistically: show it now.
  dockEditRefresh();
}

function dockCollKeydown(e, section) {
  const st = section._dockColl;
  if (!st) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = dockCollMatches(section).length;
    if (!n) return;
    st.active = (st.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    dockCollRenderList(section);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const hit = dockCollMatches(section)[st.active];
    if (hit) dockCollChange(section, hit.id, true);
    return;
  }
  if (e.key === 'Escape') {
    dockCollClose(section);
    section.querySelector('.dock-add-btn')?.focus();
  }
}

/* ── Notes ─────────────────────────────────────────────────────────────── */

function dockNoteCommit(section, ta) {
  const text = ta.value.trim();
  if (!text || typeof addNoteTextSaved !== 'function') return;
  const id = Number(section.dataset.id);
  const m = getMediaById(id);
  if (!m) return;
  const before = m.user_notes;
  ta.value = '';                     // cleared first, so a second commit cannot add it twice
  addNoteTextSaved(m.filepath, text).then((ok) => {
    if (ok) { dockTick(id, 'notes'); return; }
    // Not saved: take the note back out of the loaded rows (it was added
    // there before the request) and keep the text in the box.
    const added = m.user_notes;
    m.user_notes = before;
    if (m.dupe_group && Library.eachCachedRow) {
      Library.eachCachedRow(r => { if (r.dupe_group === m.dupe_group && r.user_notes === added) r.user_notes = before; });
    }
    if (ta.isConnected && !ta.value) ta.value = text;
    dockEditRefresh();
  });
}

function dockNoteKeydown(e, section, ta) {
  if (e.isComposing) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    dockNoteCommit(section, ta);
    return;
  }
  if (e.key === 'Escape') {
    if (ta.value) ta.value = '';
    else ta.blur();
  }
}

/* ── Committing everything (the pane is about to show another file) ────── */

/** Save every edit still open in the pane to the file it belongs to. The
 *  usual path is the field losing focus when another tile is clicked; this
 *  covers a repaint for another file that happens without a blur. */
function dockEditCommitAll(body) {
  if (!body) return;
  body.querySelectorAll('.dock-field').forEach((section) => {
    const key = section.dataset.dockPart;
    if (key === 'description' && section._dockDesc) dockDescCommit(section);
    else if (DOCK_CHIP_FIELDS[key]) {
      const input = section.querySelector('.dock-chip-input');
      if (input && input.value.trim()) dockChipCommitText(section, input);
    } else if (key === 'notes') {
      const ta = section.querySelector('.dock-note-input');
      if (ta && ta.value.trim()) dockNoteCommit(section, ta);
    }
  });
}

/* ── Wiring (called once by dock.js dockInit) ──────────────────────────── */

function dockEditInit(body) {
  if (!body) return;

  // Keep the focus in the box while a suggestion, a picker row or a chip's
  // ✕ is clicked: leaving the box would commit the typed text first.
  body.addEventListener('mousedown', (e) => {
    if (e.target.closest('.dock-suggest-item, .dock-coll-item, .dock-chip-x')) e.preventDefault();
  });

  body.addEventListener('click', (e) => {
    const section = e.target.closest('.dock-field');
    if (!section) return;
    const sugg = e.target.closest('.dock-suggest-item');
    if (sugg) {
      const s = section._dockSugg;
      const it = s && s.items[Number(sugg.dataset.i)];
      const input = section.querySelector('.dock-chip-input');
      if (it && input) {
        input.value = '';
        dockSuggestHide(section);
        dockChipAdd(section, [it.value], input);
        input.focus();
      }
      return;
    }
    const collItem = e.target.closest('.dock-coll-item');
    if (collItem) {
      dockCollChange(section, Number(collItem.dataset.coll), true);
      return;
    }
    const act = e.target.closest('[data-dock-act]');
    if (act) {
      const a = act.dataset.dockAct;
      if (a === 'desc-edit') dockDescOpen(section);
      else if (a === 'chip-remove') dockChipRemove(section, act.dataset.value);
      else if (a === 'coll-remove') dockCollChange(section, Number(act.dataset.coll), false);
      else if (a === 'coll-open') {
        if (section._dockColl) dockCollClose(section); else dockCollOpen(section);
      }
      return;
    }
    // A click on the empty part of a chip box puts the caret in its input.
    if (e.target.matches('.dock-chipbox')) section.querySelector('.dock-chip-input')?.focus();
  });

  body.addEventListener('keydown', (e) => {
    const t = e.target;
    const section = t.closest && t.closest('.dock-field');
    if (!section) return;
    if (t.matches('.dock-desc-input')) {
      if (e.isComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dockDescCommit(section); }
      else if (e.key === 'Escape') dockDescClose(section);
    } else if (t.matches('.dock-chip-input')) {
      dockChipKeydown(e, section, t);
    } else if (t.matches('.dock-coll-filter')) {
      dockCollKeydown(e, section);
    } else if (t.matches('.dock-note-input')) {
      dockNoteKeydown(e, section, t);
    } else {
      return;
    }
    // Esc in a field cancels that edit only: nothing else (the player, a
    // selection, the pane) hears it.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
  });

  body.addEventListener('input', (e) => {
    const t = e.target;
    const section = t.closest && t.closest('.dock-field');
    if (!section) return;
    if (t.matches('.dock-chip-input')) dockSuggestUpdate(section, t);
    else if (t.matches('.dock-coll-filter') && section._dockColl) {
      section._dockColl.active = 0;
      dockCollRenderList(section);
    }
  });

  body.addEventListener('focusin', (e) => {
    const section = e.target.closest && e.target.closest('.dock-field');
    // A fresh look at the library's values each time a box is entered.
    if (section && e.target.matches('.dock-chip-input')) section._dockSrc = null;
  });

  // Leaving a field saves it, to the file it was opened on. A window that
  // loses focus keeps the element focused (activeElement stays): not a leave.
  body.addEventListener('focusout', (e) => {
    const t = e.target;
    if (document.activeElement === t) return;
    const section = t.closest && t.closest('.dock-field');
    if (!section) return;
    if (t.matches('.dock-desc-input')) dockDescCommit(section);
    else if (t.matches('.dock-chip-input')) dockChipCommitText(section, t);
    else if (t.matches('.dock-note-input')) dockNoteCommit(section, t);
    else if (t.matches('.dock-coll-filter') && section._dockColl) {
      const to = e.relatedTarget;
      if (!(to && section.contains(to) && to.closest('.dock-coll-picker, .dock-add-btn'))) dockCollClose(section);
    }
  });
}

/* For tests: the pure pieces. */
const DockEdit = {
  _pure: { dockParseChipText, dockMergeChips, dockRemoveChip, dockSuggest, dockTallyValues, dockCollectionMatches, dockDescChanged },
};
