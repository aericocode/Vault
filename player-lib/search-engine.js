/* =========================================================================
   SEARCH ENGINE - the picker search, and the search options

   Search itself runs on the server now (POST /api/library/query, see
   player-lib/library.js and SERVER_SEARCH_SPEC section 3): plain, boolean
   (uppercase AND/OR/NOT, quotes, parentheses), fuzzy (file names and tags
   spelled almost the same) and semantic. The browser no longer holds the
   library, so Fuse and the browser's own boolean parser are gone.
   ========================================================================= */

/** The library's "💬 Subtitles" toggle — when on, English subtitle text
 *  (subtitle_en: translations of foreign clips + English transcripts) joins the
 *  search corpus. Original foreign-language transcripts stay out by design. */
function subtitleSearchOn() {
  const el = document.getElementById('subtitleSearch');
  return !!(el && el.checked);
}

/* =========================================================================
   REUSABLE PICKER SEARCH — the library search bar's power (boolean / quoted
   phrases / all-field matching + Metadata-only, Fuzzy, Semantic) for the
   games and PMV media pickers. Each picker asks the server for its own list:
   the media types it accepts, minus the trash, filtered by what is typed.
   It shows the first PICKER_LIMIT matches; typing narrows.
   ========================================================================= */

const PICKER_LIMIT = 200;

/**
 * One picker search.
 * @param {string} query   what is typed
 * @param {string[]} types media types the picker accepts
 * @param {{metadataOnly?, fuzzy?, semantic?}} opts the picker's toggles
 * @param {{limit?: number}} [more]
 * @returns {Promise<{items: object[], mode: string, more: boolean}>}
 */
async function pickerQuery(query, types, opts = {}, { limit = PICKER_LIMIT } = {}) {
  const q = (query || '').trim();
  const spec = {
    search: {
      text: q,
      metadataOnly: !!opts.metadataOnly,
      fuzzy: !!opts.fuzzy,
      semantic: !!opts.semantic,
      subtitles: false,
    },
    filters: { mediaTypes: types, trashed: '0' },
    // The pickers listed files in library (path) order; name order is the
    // nearest the server sorts by, and reads the same way.
    sort: { field: 'name', dir: 'asc', favesFirst: false },
  };
  let out;
  try {
    out = await Library.queryOnce(spec, { pageSize: limit });
  } catch (err) {
    if (err && err.code === 'SEMANTIC_UNAVAILABLE') {
      if (typeof showToast === 'function') showToast('🧠 ' + (err.message || 'Semantic search unavailable'));
      out = await Library.queryOnce({ ...spec, search: { ...spec.search, semantic: false } }, { pageSize: limit });
    } else {
      throw err;
    }
  }
  const mode = out.search && out.search.mode !== 'none'
    ? (out.search.mode === 'plain' ? 'default' : out.search.mode)
    : 'default';
  return { items: out.rows, mode, more: !out.complete };
}

/** Options row markup (Metadata-only / Fuzzy / Semantic toggles + indicator). */
function pickerSearchOptionsHtml(prefix, opts = {}) {
  return `
    <div class="picker-search-options" data-picker="${prefix}">
      <label class="picker-opt" title="Search only metadata (exclude filename & path)"><input type="checkbox" id="${prefix}MetaOnly" ${opts.metadataOnly ? 'checked' : ''}> Metadata</label>
      <label class="picker-opt" title="Approximate (fuzzy) matching"><input type="checkbox" id="${prefix}Fuzzy" ${opts.fuzzy ? 'checked' : ''}> Fuzzy</label>
      <label class="picker-opt" title="Semantic search. Find by meaning (local embeddings)"><input type="checkbox" id="${prefix}Semantic" ${opts.semantic ? 'checked' : ''}> 🧠</label>
      <span class="picker-mode-indicator" id="${prefix}Mode" style="display:none"></span>
    </div>`;
}

/** Reflect the active mode in a picker's little indicator chip. */
function pickerSetModeIndicator(prefix, mode, pending) {
  const el = document.getElementById(prefix + 'Mode');
  if (!el) return;
  const labels = { default: '', fuzzy: '~ fuzzy', boolean: 'AND/OR', semantic: pending ? '🧠 …' : '🧠' };
  const t = labels[mode] || '';
  el.textContent = t;
  el.style.display = t ? 'inline-flex' : 'none';
  el.className = 'picker-mode-indicator' + (mode && mode !== 'default' ? ' mode-' + mode : '');
}

/** Wire the option checkboxes for a picker to an onChange callback. */
function bindPickerSearchOptions(prefix, state, onChange) {
  const meta = document.getElementById(prefix + 'MetaOnly');
  const fuzzy = document.getElementById(prefix + 'Fuzzy');
  const sem = document.getElementById(prefix + 'Semantic');
  meta?.addEventListener('change', () => { state.metadataOnly = meta.checked; onChange(); });
  fuzzy?.addEventListener('change', () => {
    state.fuzzy = fuzzy.checked;
    if (state.fuzzy && sem) { sem.checked = false; state.semantic = false; } // fuzzy & semantic are mutually exclusive
    onChange();
  });
  sem?.addEventListener('change', () => {
    state.semantic = sem.checked;
    if (state.semantic && fuzzy) { fuzzy.checked = false; state.fuzzy = false; }
    onChange();
  });
}
