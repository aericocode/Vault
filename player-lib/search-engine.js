/* =========================================================================
   SEARCH ENGINE - Fuzzy and boolean search support
   ========================================================================= */

// Fuse.js instance (lazy-initialized)
let fuseInstance = null;
let fuseDataStale = true;

// Search mode: 'default' | 'fuzzy' | 'boolean'
let searchMode = 'default';

/**
 * Detect search mode from the query string.
 *   contains AND/OR/NOT → boolean
 *   fuzzy toggle on  → fuzzy
 *   otherwise        → default (substring)
 *
 * Round 6 dropped regex mode. A query like /foo/i is now searched literally:
 * a search box that silently reinterprets slashes is a trap for anyone who
 * has a slash in a filename, and boolean already covers the real need.
 */
function detectSearchMode(query) {
  if (!query) return 'default';

  // Boolean: contains AND, OR, NOT as whole words (uppercase only to avoid false positives)
  if (/\b(AND|OR|NOT)\b/.test(query)) return 'boolean';

  // Fuzzy: check the toggle
  const fuzzyToggle = document.getElementById('fuzzySearch');
  if (fuzzyToggle && fuzzyToggle.checked) return 'fuzzy';

  return 'default';
}

/** The library's "💬 Subtitles" toggle — when on, English subtitle text
 *  (subtitle_en: translations of foreign clips + English transcripts) joins the
 *  search corpus. Original foreign-language transcripts stay out by design. */
function subtitleSearchOn() {
  const el = document.getElementById('subtitleSearch');
  return !!(el && el.checked);
}

/**
 * Get the searchable text for a media item (uncached raw form — kept for
 * external callers; the search paths below use the cached entries).
 */
function getSearchText(m, metadataOnly) {
  return _searchEntry(m, metadataOnly).raw;
}

/* Per-row search-text cache. Joining ~10 metadata fields (incl. transcripts
   and subtitle text) and lowercasing them for EVERY row on EVERY keystroke
   is the bulk of a large library's search cost — cache both forms per row,
   keyed by the toggle config. invalidateFuse() clears it whenever rows
   change (library load, scan results landing, notes/metadata edits). */
let _stCache = new Map();   // media id → { raw, low }
let _stCfg = '';

function _searchEntry(m, metadataOnly) {
  const cfg = (metadataOnly ? 'm' : 'a') + (subtitleSearchOn() ? 's' : '');
  if (cfg !== _stCfg) { _stCache = new Map(); _stCfg = cfg; }
  let e = _stCache.get(m.id);
  if (e) return e;

  const subs = subtitleSearchOn() ? m.subtitle_en : null;
  const parts = metadataOnly
    ? [m.description, m.media_elements, m.tags, m.themes, m.transcribed_text,
       m.content_type, m.language, m.user_notes, subs]
    : [m.filename, m.filepath, m.description, m.media_elements, m.tags, m.themes,
       m.transcribed_text, m.content_type, m.language, m.user_notes, subs];
  const raw = parts.filter(Boolean).join(' ');
  e = { raw, low: raw.toLowerCase() };
  _stCache.set(m.id, e);
  return e;
}

// ── Default (substring) search ──────────────────────────────────────────

function searchDefault(query, media, metadataOnly) {
  const q = query.toLowerCase();
  return media.filter(m => _searchEntry(m, metadataOnly).low.includes(q));
}

// ── Boolean search ──────────────────────────────────────────────────────

/**
 * Parse a boolean query into a tree.
 * Supports: AND, OR, NOT, quotes for exact phrases, parentheses for grouping.
 * Examples:
 *   cat AND dog
 *   "blue sky" OR sunset
 *   cat AND NOT dog
 *   (cat OR dog) AND NOT fish
 */
function searchBoolean(query, media, metadataOnly) {
  try {
    const tokens = tokenizeBoolean(query);
    const tree = parseBooleanExpr(tokens);
    return media.filter(m => evalBooleanTree(tree, _searchEntry(m, metadataOnly).low));
  } catch (e) {
    console.warn('[Search] Boolean parse error:', e.message);
    // Fall back to default search
    return searchDefault(query, media, metadataOnly);
  }
}

function tokenizeBoolean(query) {
  const tokens = [];
  let i = 0;
  while (i < query.length) {
    // Skip whitespace
    if (query[i] === ' ') { i++; continue; }

    // Quoted phrase
    if (query[i] === '"') {
      const end = query.indexOf('"', i + 1);
      if (end === -1) {
        tokens.push({ type: 'term', value: query.substring(i + 1).toLowerCase() });
        break;
      }
      tokens.push({ type: 'term', value: query.substring(i + 1, end).toLowerCase() });
      i = end + 1;
      continue;
    }

    // Parentheses
    if (query[i] === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (query[i] === ')') { tokens.push({ type: 'rparen' }); i++; continue; }

    // Read a word
    let word = '';
    while (i < query.length && query[i] !== ' ' && query[i] !== '(' && query[i] !== ')') {
      word += query[i]; i++;
    }

    if (word === 'AND') tokens.push({ type: 'and' });
    else if (word === 'OR') tokens.push({ type: 'or' });
    else if (word === 'NOT') tokens.push({ type: 'not' });
    else tokens.push({ type: 'term', value: word.toLowerCase() });
  }
  return tokens;
}

// Recursive descent parser: expr = andExpr (OR andExpr)*
function parseBooleanExpr(tokens, pos) {
  if (!pos) pos = { i: 0 };
  let left = parseBooleanAnd(tokens, pos);
  while (pos.i < tokens.length && tokens[pos.i]?.type === 'or') {
    pos.i++; // consume OR
    const right = parseBooleanAnd(tokens, pos);
    left = { op: 'or', left, right };
  }
  return left;
}

function parseBooleanAnd(tokens, pos) {
  let left = parseBooleanNot(tokens, pos);
  while (pos.i < tokens.length && tokens[pos.i]?.type === 'and') {
    pos.i++; // consume AND
    const right = parseBooleanNot(tokens, pos);
    left = { op: 'and', left, right };
  }
  return left;
}

function parseBooleanNot(tokens, pos) {
  if (pos.i < tokens.length && tokens[pos.i]?.type === 'not') {
    pos.i++; // consume NOT
    const operand = parseBooleanAtom(tokens, pos);
    return { op: 'not', operand };
  }
  return parseBooleanAtom(tokens, pos);
}

function parseBooleanAtom(tokens, pos) {
  if (pos.i >= tokens.length) return { op: 'term', value: '' };

  if (tokens[pos.i].type === 'lparen') {
    pos.i++; // consume (
    const expr = parseBooleanExpr(tokens, pos);
    if (pos.i < tokens.length && tokens[pos.i]?.type === 'rparen') {
      pos.i++; // consume )
    }
    return expr;
  }

  if (tokens[pos.i].type === 'term') {
    const term = tokens[pos.i].value;
    pos.i++;
    return { op: 'term', value: term };
  }

  // Skip unexpected tokens
  pos.i++;
  return { op: 'term', value: '' };
}

function evalBooleanTree(node, text) {
  switch (node.op) {
    case 'term': return node.value === '' || text.includes(node.value);
    case 'and': return evalBooleanTree(node.left, text) && evalBooleanTree(node.right, text);
    case 'or': return evalBooleanTree(node.left, text) || evalBooleanTree(node.right, text);
    case 'not': return !evalBooleanTree(node.operand, text);
    default: return true;
  }
}

// ── Fuzzy search (Fuse.js) ──────────────────────────────────────────────

/**
 * Initialize or update the Fuse.js instance. Indexed over the FULL library
 * (not the current filter candidates) so the expensive build happens once
 * per data/toggle change instead of every keystroke — searchFuzzy then
 * intersects results with whatever candidate set the filters produced.
 */
function initFuse(media, metadataOnly) {
  const keys = metadataOnly
    ? ['description', 'media_elements', 'tags', 'themes', 'transcribed_text', 'content_type', 'language', 'user_notes']
    : ['filename', 'filepath', 'description', 'media_elements', 'tags', 'themes', 'transcribed_text', 'content_type', 'language', 'user_notes'];
  if (subtitleSearchOn()) keys.push('subtitle_en');

  fuseInstance = new Fuse(media, {
    keys: keys,
    threshold: 0.35,        // 0 = exact, 1 = match anything
    distance: 200,           // how far from expected position a match can be
    ignoreLocation: true,    // search entire string, not just beginning
    minMatchCharLength: 2,
    includeScore: true,
    useExtendedSearch: false,
  });

  fuseDataStale = false;
}

// Which toggle combo the current index was built for — flipping metadata-only
// or subtitle search changes the indexed keys, so the index must rebuild.
let fuseConfig = '';

function searchFuzzy(query, media, metadataOnly) {
  if (typeof Fuse === 'undefined') {
    console.warn('[Search] Fuse.js not loaded, falling back to default search');
    return searchDefault(query, media, metadataOnly);
  }

  const cfg = (metadataOnly ? 'm' : 'a') + (subtitleSearchOn() ? 's' : '');
  if (!fuseInstance || fuseDataStale || fuseConfig !== cfg) {
    // Index the whole library (stable across filter changes); fall back to
    // the passed set if the global isn't available for some reason.
    initFuse(typeof allMedia !== 'undefined' && allMedia.length ? allMedia : media, metadataOnly);
    fuseConfig = cfg;
  }

  // Intersect with the CURRENT candidates — fuzzy results must respect the
  // active filters (the old per-first-call index quietly ignored them).
  const inSet = new Set(media.map(m => m.id));
  return fuseInstance.search(query).map(r => r.item).filter(m => inSet.has(m.id));
}

/**
 * Mark fuse data as stale (call after DB load/reload, scan results landing,
 * or notes/metadata edits — anything that changes searchable text). Also
 * drops the per-row search-text cache used by the non-fuzzy modes.
 */
function invalidateFuse() {
  fuseDataStale = true;
  fuseInstance = null;
  _stCache = new Map();
}

// ── Main search dispatcher ──────────────────────────────────────────────

/**
 * Run the appropriate search based on detected mode.
 * @param {string} query - Raw search input
 * @param {Array} media - Media items to search (already filtered by type etc.)
 * @param {boolean} metadataOnly
 * @returns {Array} Matching media items
 */
function executeSearch(query, media, metadataOnly) {
  if (!query) return media;

  const mode = detectSearchMode(query);
  searchMode = mode;
  // Optional UI hook — no such indicator is defined right now, and an
  // unguarded call here threw during library load whenever a persisted
  // search query was restored ("Failed to load library: … not defined").
  if (typeof updateSearchModeIndicator === 'function') updateSearchModeIndicator(mode);

  switch (mode) {
    case 'boolean': return searchBoolean(query, media, metadataOnly);
    case 'fuzzy': return searchFuzzy(query, media, metadataOnly);
    default: return searchDefault(query, media, metadataOnly);
  }
}

/* =========================================================================
   REUSABLE PICKER SEARCH — the library search bar's power (boolean / quoted
   phrases / all-field matching + Metadata-only, Fuzzy, Semantic) for
   the editor / games / PMV media pickers. Side-effect-free: it never touches
   the main library's shared Fuse instance, mode indicator, or globals.
   ========================================================================= */

/** Fuzzy over an arbitrary subset via a throwaway Fuse (won't disturb the
    library's shared instance). Picker subsets are small, so this is cheap. */
function _pickerFuzzy(query, media, metadataOnly) {
  if (typeof Fuse === 'undefined') return searchDefault(query, media, metadataOnly);
  const keys = metadataOnly
    ? ['description', 'media_elements', 'tags', 'themes', 'transcribed_text', 'content_type', 'language', 'user_notes']
    : ['filename', 'filepath', 'description', 'media_elements', 'tags', 'themes', 'transcribed_text', 'content_type', 'language', 'user_notes'];
  const f = new Fuse(media, { keys, threshold: 0.35, distance: 200, ignoreLocation: true, minMatchCharLength: 2 });
  return f.search(query).map(r => r.item);
}

/** Detect mode from the query + an explicit fuzzy flag (no DOM reads). */
function pickerSearchMode(query, fuzzy) {
  if (!query) return 'default';
  if (/\b(AND|OR|NOT)\b/.test(query)) return 'boolean';
  if (fuzzy) return 'fuzzy';
  return 'default';
}

/** Synchronous text search (default/boolean/fuzzy). → { items, mode } */
function pickerSearchSync(query, media, { metadataOnly = false, fuzzy = false } = {}) {
  const q = (query || '').trim();
  if (!q) return { items: media, mode: 'default' };
  const mode = pickerSearchMode(q, fuzzy);
  let items;
  switch (mode) {
    case 'boolean': items = searchBoolean(q, media, metadataOnly); break;
    case 'fuzzy': items = _pickerFuzzy(q, media, metadataOnly); break;
    default: items = searchDefault(q, media, metadataOnly);
  }
  return { items, mode };
}

/* ── Semantic (async, cached, shared across pickers) ── */

const PICKER_SEMANTIC_MIN = 0.4;
let _pickerSem = { query: null, scores: null };
let _pickerSemPending = null;

/**
 * Semantic scores for a query (cached). Returns a Map(id→score) synchronously
 * when ready, else null and kicks off the fetch — calling onReady(scores) once
 * it resolves for THIS query so the caller can re-render.
 */
function pickerSemanticScores(query, onReady) {
  const q = (query || '').trim();
  if (!q) return null;
  if (_pickerSem.query === q) return _pickerSem.scores;
  if (_pickerSemPending !== q) {
    _pickerSemPending = q;
    fetch('/api/search/semantic?q=' + encodeURIComponent(q))
      .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e)))
      .then(({ results }) => {
        const scores = new Map((results || []).filter(r => r.score >= PICKER_SEMANTIC_MIN).map(r => [r.id, r.score]));
        _pickerSem = { query: q, scores };
        if (_pickerSemPending === q) { _pickerSemPending = null; onReady?.(scores); }
      })
      .catch(err => {
        if (_pickerSemPending === q) _pickerSemPending = null;
        if (typeof showToast === 'function') showToast('🧠 ' + (err?.error || 'Semantic search unavailable'));
      });
  }
  return null;
}

/**
 * Full picker filter. Text modes are synchronous; semantic is async (returns
 * pending=true until scores arrive, then re-renders via onSemanticReady).
 * @returns { items, mode, pending }
 */
function pickerApplySearch(query, base, opts = {}, onSemanticReady) {
  const q = (query || '').trim();
  if (!q) return { items: base, mode: 'default', pending: false };
  if (opts.semantic) {
    const scores = pickerSemanticScores(q, onSemanticReady);
    if (!scores) return { items: base, mode: 'semantic', pending: true };
    const items = base.filter(m => scores.has(m.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id));
    return { items, mode: 'semantic', pending: false };
  }
  const { items, mode } = pickerSearchSync(q, base, opts);
  return { items, mode, pending: false };
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
