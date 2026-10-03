/**
 * Library query engine (SERVER_SEARCH_SPEC 3, 4 and 5.5): a query spec from
 * the viewer in, the ordered ids of every matching file out.
 *
 * This is a port of what the browser did in memory (player-lib/filters.js
 * applyFilters + sortFilteredMedia at 13c23ec), rewritten as SQL over the
 * indexes lib/library-index.js maintains. Filters and sort must match the
 * browser exactly (test/library-parity.test.js holds a copy of the browser's
 * predicates and comparator and compares ids); text search follows the A3
 * rules instead of the old joined-text substring test.
 *
 * How a query runs, fastest path first:
 *   1. Every "set" condition (a text match, a theme, a collection, a song, the
 *      duplicates, an explicit id list) is materialized once into a TEMP table
 *      and cached per library version, so the first page, the full id list,
 *      the next keystroke's query and the per-value sort walk all reuse it.
 *   2. If some condition matches few rows (a set, a flag's partial index, a
 *      narrow value index), those rows are looked up by id and sorted.
 *   3. Otherwise the sort index is walked in result order. It covers every
 *      filter column, so no row of the (large) media table is touched; the
 *      first page stops after pageSize matches.
 *
 * Safety: every value from the request is a bound parameter. The only user
 * text that reaches FTS5 syntax is wrapped as one double-quoted string with
 * its own double quotes doubled, so operators, column filters, NEAR, ^ and *
 * typed into the search box are just characters. Column names, sort keys and
 * temp table names come from fixed maps and counters, never from the request.
 */

const crypto = require('crypto');
const database = require('./database');
const libraryIndex = require('./library-index');
const nameFuzzy = require('./name-fuzzy');
const syntax = require('./search-syntax');
const { BROWSER_PLAYABLE_EXTENSIONS } = require('./playable-extensions');
const { langName } = require('./lang');

// ── Constants ──────────────────────────────────────────────────────────────

/** The grid never shows anything else (documents stay out, as in the browser). */
const GRID_TYPES = ['video', 'audio', 'image', 'gif', 'mix'];
const MEDIA_TYPES = [...GRID_TYPES, 'document'];

/** Binary id list type codes (spec 2). */
const TYPE_CODES = { video: 1, audio: 2, image: 3, gif: 4, mix: 5, document: 6 };

const SEMANTIC_MIN_SCORE = 0.4;     // player-lib/filters.js SEMANTIC_MIN_SCORE
const SEMANTIC_LIMIT = 500;
// Input caps (spec 5.5): past these a request is refused with a plain 400,
// never left to fail deep inside SQLite or the parser.
const MAX_BOOLEAN_TERMS = 200;      // keeps SQLite's expression depth far from its 1000 cap
const MAX_BOOLEAN_DEPTH = 32;       // nested parentheses / NOT
const MAX_SEARCH_WORDS = 16;        // plain and fuzzy (round 4: was 64)
const MAX_EXTENSIONS = 200;
const MAX_FUZZY_WORDS = 4;          // words expanded per fuzzy query (spec 3.3)
const MAX_ID_LIST = 4000000;        // onlyIds, rankedIds
const TOO_LONG = 'Search is too long. Use 16 words or fewer.';
const TOO_COMPLEX = 'Search is too complex.';
// Length (round 3): one 1 MB word blocked the server 28 s (plain) and 61 s
// (fuzzy) at 2M; within these caps long uncommon input costs under 50 ms.
// What still costs is many COMMON words: every occurrence is one more full
// doclist for the phrase and trigram matches, and the same word repeated is
// the worst (64 x a word in 99% of files: 13 s cold at 2M). Hence the repeat
// cap. Words are counted as the FTS tokenizer sees them (round 4): accent,
// case and width variants of one word are one word, so "huurost húurost
// hùurost ..." cannot slip past the repeat cap (64 spellings: 12 s plain,
// 36 s fuzzy at 2M before). Plain and fuzzy allow 16 words.
const MAX_SEARCH_CHARS = 2000;
const MAX_WORD_CHARS = 100;
const MAX_WORD_REPEATS = 4;
const TOO_LONG_TEXT = 'Search is too long.';

const PAGE_DEFAULT = 100;
const PAGE_MAX = 500;
const PLAN_CACHE_SIZE = 16;
const PLAN_TTL_MS = 10 * 60 * 1000;

/** Materialized id sets kept per connection (LRU), and their total size cap. */
const SET_CACHE_SIZE = 12;
const SET_CACHE_MAX_IDS = 8000000;

/**
 * Sort keys (library-index.SORT_FIELDS), the same expressions its indexes
 * are built on; unqualified column names resolve to the outer `media m`.
 * Ties fall back to filepath, which was the browser's array order.
 * Known, accepted differences from the browser's comparator: NOCASE folds
 * ASCII only (toLowerCase folds everything), and SQLite compares UTF-8 bytes
 * where JS compares UTF-16 units. Only names with non-ASCII characters can
 * come out in a different order.
 */
const SORT_FIELDS = libraryIndex.SORT_FIELDS;

/** Distinct key values the first-page walk visits before it just sorts. */
const MAX_GROUP_STEPS = 64;

// FTS column sets (fixed, never from the request).
const NAME_COLS = libraryIndex.NAME_COLS;                       // filename filepath tags themes
const META_NAME_COLS = ['tags', 'themes'];                      // Metadata only
const TEXT_ONLY_COLS = ['description', 'media_elements', 'transcribed_text',
  'content_type', 'language', 'user_notes'];

const NAMES_MATCH = 'SELECT rowid FROM media_search_names WHERE media_search_names MATCH ?';
const TEXT_MATCH = 'SELECT rowid FROM media_search_text WHERE media_search_text MATCH ?';
const THEMES_MATCH = 'SELECT rowid FROM media_search_themes WHERE media_search_themes MATCH ?';

const truthy = (col) => `COALESCE(${col}, 0) <> 0`;
const falsy = (col) => `COALESCE(${col}, 0) = 0`;
// Written exactly as library-index indexes them, so they read from the index.
const HAS_NOTES = `(${libraryIndex.NOTES_FLAG}) = 1`;
const SCAN_IS = (n) => `(${libraryIndex.SCAN_STATE}) = ${n}`;

// isDuplicate(): another row, in any state, with the same type and non-zero size.
const DUPLICATE_IDS = (hint) => `SELECT m.id FROM media m ${hint}
  WHERE COALESCE(m.filesize_bytes, 0) <> 0 AND m.media_type IS NOT NULL
    AND (m.media_type, m.filesize_bytes) IN (SELECT media_type, filesize_bytes FROM media
      WHERE COALESCE(filesize_bytes, 0) <> 0 AND COALESCE(media_type, '') <> '' AND ${libraryIndex.validId('+id')}
      GROUP BY media_type, filesize_bytes HAVING count(*) >= 2)`;
// mediaInAnyCollection(): a member of a collection (folders hold no files).
const COLLECTED_IDS = `SELECT ci.media_id FROM collection_items ci
  JOIN collections c ON c.id = ci.collection_id WHERE c.kind IS NOT 'folder'`;

// ── Errors ─────────────────────────────────────────────────────────────────

class QueryError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}
const bad = (message) => new QueryError(400, message);

// ── Spec validation (spec 6.1) ─────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const TRI = ['', '1', '0'];

function optBool(obj, key, where) {
  const v = obj[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') throw bad(`${where}.${key} must be true or false`);
  return v;
}
function optString(obj, key, where) {
  const v = obj[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw bad(`${where}.${key} must be a string`);
  return v;
}
function optEnum(obj, key, where, allowed, dflt) {
  const v = obj[key];
  if (v === undefined || v === null) return dflt;
  if (!allowed.includes(v)) throw bad(`${where}.${key} must be one of ${allowed.map(a => `'${a}'`).join(', ')}`);
  return v;
}
function optStrings(obj, key, where, allowed) {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some(s => typeof s !== 'string')) throw bad(`${where}.${key} must be a list of strings`);
  if (allowed && v.some(s => !allowed.includes(s))) throw bad(`${where}.${key} has an unknown value`);
  return [...new Set(v)];
}
function optNumber(obj, key, where, dflt, { nullable = false } = {}) {
  const v = obj[key];
  if (v === undefined) return dflt;
  if (v === null) {
    if (nullable) return null;
    return dflt;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad(`${where}.${key} must be a number, 0 or more`);
  return v;
}
const isId = (v) => Number.isInteger(v) && v > 0 && v <= 0xFFFFFFFF;

/**
 * search.text, NULs removed. A text longer than 2 x MAX_SEARCH_CHARS UTF-16
 * units has more than MAX_SEARCH_CHARS code points whatever it holds, so it
 * is refused here, before any per-character work (a 60 MB text cost ~2 s and
 * ~2 GB when it was first copied into code points).
 */
function searchText(s) {
  const raw = optString(s, 'text', 'search');
  if (raw.length > 2 * MAX_SEARCH_CHARS) throw bad(TOO_LONG_TEXT);
  return raw.replace(/\u0000/g, '');
}

/** Request body → a complete, defaulted spec. Throws QueryError(400). */
function normalizeSpec(body) {
  if (!isObj(body)) throw bad('body must be a JSON object');

  const s = body.search === undefined || body.search === null ? {} : body.search;
  if (!isObj(s)) throw bad('search must be an object');
  const search = {
    // NUL never belongs in a search and SQLite treats it as end of string.
    text: searchText(s),
    metadataOnly: optBool(s, 'metadataOnly', 'search'),
    fuzzy: optBool(s, 'fuzzy', 'search'),
    semantic: optBool(s, 'semantic', 'search'),
    subtitles: optBool(s, 'subtitles', 'search'),
  };

  const f = body.filters === undefined || body.filters === null ? {} : body.filters;
  if (!isObj(f)) throw bad('filters must be an object');
  const song = f.song === undefined || f.song === null ? 0 : f.song;
  if (!(song === 0 || isId(song))) throw bad('filters.song must be 0 or a song id');
  const filters = {
    mediaTypes: optStrings(f, 'mediaTypes', 'filters', MEDIA_TYPES),
    safeOnly: optBool(f, 'safeOnly', 'filters'),
    extensions: optStrings(f, 'extensions', 'filters'),
    content: optString(f, 'content', 'filters'),
    language: optString(f, 'language', 'filters'),
    quality: optString(f, 'quality', 'filters'),
    theme: optString(f, 'theme', 'filters'),
    minRating: optEnum(f, 'minRating', 'filters', ['0', 'unrated', '1', '2', '3', '4', '5'], '0'),
    durMin: optNumber(f, 'durMin', 'filters', 0),
    durMax: optNumber(f, 'durMax', 'filters', null, { nullable: true }),
    collections: optEnum(f, 'collections', 'filters', TRI, ''),
    song,
    starred: optEnum(f, 'starred', 'filters', TRI, ''),
    hasNotes: optEnum(f, 'hasNotes', 'filters', TRI, ''),
    flagged: optEnum(f, 'flagged', 'filters', TRI, ''),
    trashed: optEnum(f, 'trashed', 'filters', TRI, '0'),
    failed: optEnum(f, 'failed', 'filters', TRI, ''),
    duplicates: optEnum(f, 'duplicates', 'filters', TRI, ''),
    scanStatus: optEnum(f, 'scanStatus', 'filters', ['', 'success', 'failed', 'unscanned'], ''),
  };

  const collectionId = body.collectionId === undefined ? null : body.collectionId;
  if (collectionId !== null && !isId(collectionId)) throw bad('collectionId must be null or a collection id');

  const so = body.sort === undefined || body.sort === null ? {} : body.sort;
  if (!isObj(so)) throw bad('sort must be an object');
  const sort = {
    field: optEnum(so, 'field', 'sort', Object.keys(SORT_FIELDS), 'processed'),
    dir: optEnum(so, 'dir', 'sort', ['asc', 'desc'], 'desc'),
    favesFirst: optBool(so, 'favesFirst', 'sort'),
  };

  if (filters.extensions.length > MAX_EXTENSIONS) throw bad(`filters.extensions has more than ${MAX_EXTENSIONS} values`);
  const nTokens = checkSearchLength(search.text.trim());
  if (!search.semantic) checkSearchSize(search.text.trim(), search.fuzzy, nTokens);

  const onlyIds = body.onlyIds === undefined ? null : body.onlyIds;
  if (onlyIds !== null) {
    if (!Array.isArray(onlyIds)) throw bad('onlyIds must be null or a list of media ids');
    if (onlyIds.length > MAX_ID_LIST) throw bad('onlyIds has more than 4,000,000 ids');
    if (!onlyIds.every(isId)) throw bad('onlyIds must be null or a list of media ids');
  }

  const rankedIds = body.rankedIds === undefined ? null : body.rankedIds;
  if (rankedIds !== null) {
    if (Array.isArray(rankedIds) && rankedIds.length > MAX_ID_LIST) throw bad('rankedIds has more than 4,000,000 ids');
    if (!Array.isArray(rankedIds) || !rankedIds.every(r => isObj(r) && isId(r.id)
      && typeof r.score === 'number' && Number.isFinite(r.score))) {
      throw bad('rankedIds must be null or a list of {id, score}');
    }
  }

  const pageSize = body.pageSize === undefined || body.pageSize === null ? PAGE_DEFAULT : body.pageSize;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_MAX) {
    throw bad(`pageSize must be a whole number from 1 to ${PAGE_MAX}`);
  }

  return { search, filters, collectionId, sort, onlyIds, rankedIds, pageSize };
}

// ── Materialized id sets ───────────────────────────────────────────────────

/**
 * An id set as a TEMP table (one INTEGER PRIMARY KEY column), built once per
 * library version and reused. Membership is then one b-tree probe per row,
 * and the size is known up front. A common word matches nearly every file at
 * 2M; building that set costs a few hundred ms once instead of on every
 * statement that mentions it.
 */
const setCache = new Map();   // key → { db, version, table, size }
const tempCacheSet = new WeakSet();
const TEMP_CACHE_KB = -131072;   // 128 MB, negative = KiB (pages are allocated as used)
let setSeq = 0;

function idSet(ctx, sql, params) {
  const { db, version } = ctx;
  const key = sql.length + ':' + crypto.createHash('sha1').update(sql).update('\0').update(JSON.stringify(params)).digest('hex');
  let s = setCache.get(key);
  if (s && s.db === db && s.version === version) {
    setCache.delete(key);
    setCache.set(key, s);       // LRU: most recent last
    ctx.used.add(key);
    return s;
  }
  if (s) dropSet(key, s);
  if (!tempCacheSet.has(db)) {
    // Sets live in the temp schema; give it room so probing a 2M-id set is
    // a memory lookup (the default 2 MB cache made it disk-bound).
    db.pragma(`temp.cache_size = ${TEMP_CACHE_KB}`);
    tempCacheSet.add(db);
  }
  const table = `lq_set_${++setSeq}`;
  db.exec(`CREATE TEMP TABLE ${table} (id INTEGER PRIMARY KEY)`);
  const size = db.prepare(`INSERT OR IGNORE INTO temp.${table} (id) ${sql}`).run(...params).changes;
  s = { db, version, table: `temp.${table}`, size };
  setCache.set(key, s);
  ctx.used.add(key);
  // Evict the oldest sets, never one this query is using.
  let total = 0;
  for (const v of setCache.values()) total += v.size;
  for (const [k, v] of setCache) {
    if (setCache.size <= SET_CACHE_SIZE && total <= SET_CACHE_MAX_IDS) break;
    if (ctx.used.has(k)) continue;
    total -= v.size;
    dropSet(k, v);
  }
  return s;
}

function dropSet(key, s) {
  setCache.delete(key);
  try { if (s.db.open) s.db.exec(`DROP TABLE IF EXISTS ${s.table}`); } catch { /* connection gone */ }
}

/** An explicit id list (focus set, collection, semantic hits) as a set. */
function listSet(ctx, ids) {
  return idSet(ctx, 'SELECT value FROM json_each(?)', [JSON.stringify(ids)]);
}

// ── Text search → SQL (spec 3) ─────────────────────────────────────────────

/** One FTS5 string: the whole text, quotes doubled. Never raw syntax. */
function ftsString(text) {
  return `"${String(text).replace(/"/g, '""')}"`;
}
const colFilter = (cols) => `{${cols.join(' ')}}`;
const charLength = (s) => [...s].length;

/**
 * match(U) (spec 3.1). Names contain U anywhere (trigram, U of 3+ characters);
 * text fields hold U's words consecutively with the last one as a prefix
 * (word index). Short queries use the word rule on names too. A U with no
 * letters or digits only has the names rule.
 * Returns { sql, set }: the condition, and its id set (a driver candidate).
 */
function matchSql(text, ctx) {
  const u = String(text).trim().toLowerCase();
  if (!u) return { sql: '1', set: null };
  const names = ctx.search.metadataOnly ? META_NAME_COLS : NAME_COLS;
  const long = charLength(u) >= 3;
  const parts = [];
  const params = [];
  if (long) {
    parts.push(NAMES_MATCH);
    params.push(`${colFilter(names)} : ${ftsString(u)}`);
  }
  if (syntax.words(u).length) {
    const cols = [...TEXT_ONLY_COLS, ...(ctx.search.subtitles ? ['subtitle_en'] : []), ...(long ? [] : names)];
    parts.push(TEXT_MATCH);
    params.push(`${colFilter(cols)} : ${ftsString(u)} *`);
  }
  if (!parts.length) return { sql: '0', set: null };
  const set = idSet(ctx, parts.join(' UNION ALL '), params);
  return { sql: `m.id IN ${set.table}`, set };
}

/**
 * Boolean tree → SQL; each leaf is match(leaf), whose id set is exact.
 * Where a node's result can be computed cheaply from its children's exact
 * sets it becomes a set of its own: an intersection or a difference when the
 * smaller side has at most DERIVE_MAX ids, a union when both together do.
 * So "rare AND NOT common" is a handful of ids (one probe per rare id), which
 * the small-set path then answers without walking the library. Otherwise the
 * smallest set an AND requires is still offered as a driver (a superset).
 * Returns { sql, set, exact, neg } (neg: a NOT over an exact set).
 *
 * Accepted limitation (spec 15): a NOT over a large union, e.g.
 * "rare AND NOT (common OR common)", has no derived set (the union is over
 * DERIVE_MAX), so it is answered as a NOT IN over the materialized sets:
 * about 0.8 s warm at 2M, and a cold NOT costs 1 to 1.6 s once per library
 * version while its sets are materialized.
 */
const DERIVE_MAX = 200000;
function booleanSql(node, ctx) {
  const asSet = (set) => ({ sql: `m.id IN ${set.table}`, set, exact: true });
  switch (node.op) {
    case 'term': {
      const m = matchSql(node.value, ctx);
      return { ...m, exact: !!m.set };
    }
    case 'and': {
      const l = booleanSql(node.left, ctx);
      const r = booleanSql(node.right, ctx);
      if (l.exact && r.exact) {
        const [small, big] = l.set.size <= r.set.size ? [l.set, r.set] : [r.set, l.set];
        if (small.size <= DERIVE_MAX) return asSet(idSet(ctx, `SELECT id FROM ${small.table} WHERE id IN ${big.table}`, []));
      }
      for (const [pos, neg] of [[l, r], [r, l]]) {
        if (pos.exact && neg.neg && pos.set.size <= DERIVE_MAX) {
          return asSet(idSet(ctx, `SELECT id FROM ${pos.set.table} WHERE id NOT IN ${neg.neg.table}`, []));
        }
      }
      const sets = [l.set, r.set].filter(Boolean);
      const set = sets.length ? sets.reduce((x, y) => (x.size <= y.size ? x : y)) : null;
      return { sql: `(${l.sql} AND ${r.sql})`, set, exact: false };
    }
    case 'or': {
      const l = booleanSql(node.left, ctx);
      const r = booleanSql(node.right, ctx);
      if (l.exact && r.exact && l.set.size + r.set.size <= DERIVE_MAX) {
        return asSet(idSet(ctx, `SELECT id FROM ${l.set.table} UNION SELECT id FROM ${r.set.table}`, []));
      }
      return { sql: `(${l.sql} OR ${r.sql})`, set: null, exact: false };
    }
    case 'not': {
      const x = booleanSql(node.operand, ctx);
      return { sql: `(NOT ${x.sql})`, set: null, exact: false, neg: x.exact ? x.set : null };
    }
    default: return { sql: '1', set: null, exact: false };
  }
}

/**
 * The text's words exactly as the word index's unicode61 tokenizer
 * (remove_diacritics 2) sees them, from that tokenizer itself in a private
 * in-memory database: { term: count }, and the total. A JS imitation is not
 * exact: SQLite folds final sigma to sigma, which toLowerCase keeps apart,
 * and it splits words at combining marks that are not diacritics (U+0305),
 * so one regex word can be many tokens. The names table is different again
 * (trigram, remove_diacritics 1): it keeps those marks as characters, so
 * "huurost" and "huurost" + U+0305 are one word here and two there; see
 * trigramForm().
 */
const tok = {};
function tokDb() {
  if (!tok.db) {
    tok.db = database.memoryDb();
    tok.db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize="unicode61 remove_diacritics 2");
      CREATE VIRTUAL TABLE v USING fts5vocab(t, row);
      CREATE VIRTUAL TABLE g USING fts5(x, tokenize="trigram case_sensitive 0 remove_diacritics 1");
      CREATE VIRTUAL TABLE gi USING fts5vocab(g, instance);`);
    tok.del = tok.db.prepare('DELETE FROM t');
    tok.ins = tok.db.prepare('INSERT INTO t(rowid, x) VALUES (1, ?)');
    tok.sel = tok.db.prepare('SELECT term, cnt FROM v');
    tok.gdel = tok.db.prepare('DELETE FROM g');
    tok.gins = tok.db.prepare('INSERT INTO g(rowid, x) VALUES (1, ?)');
    tok.gsel = tok.db.prepare('SELECT term FROM gi ORDER BY "offset"').pluck();
  }
  return tok;
}
function ftsTokens(text) {
  tokDb();
  tok.del.run();
  tok.ins.run(text);
  const counts = new Map();
  let total = 0;
  for (const r of tok.sel.iterate()) { counts.set(r.term, r.cnt); total += r.cnt; }
  return { counts, total };
}
/** One word as the names table sees it: its trigrams in order (the folded word, case and remove_diacritics 1). */
function trigramForm(w) {
  tokDb();
  tok.gdel.run();
  tok.gins.run(w);
  return tok.gsel.all().join('|');
}
/**
 * Two words of a fuzzy search give the same clause, so one can be dropped,
 * exactly when this key matches (round 5): a long word's clause is its names
 * match (the trigram form) OR its close terms (a function of nameFuzzy.fold);
 * a short word's is a prefix in the word index (its unicode61 tokens).
 */
function fuzzyWordKey(w) {
  if (charLength(w) >= 3) return `L${trigramForm(w)}\u0000${nameFuzzy.fold(w)}`;
  return `S${[...ftsTokens(w).counts.keys()].join(' ')}`;
}
// Uppercase whole-word AND / OR / NOT: boolean operators, which repeat by nature.
const OPERATOR_RE = /(?<![\p{L}\p{N}\p{M}\p{Co}])(?:AND|OR|NOT)(?![\p{L}\p{N}\p{M}\p{Co}])/gu;

/**
 * Total and per-word length caps and the repeat cap, every mode (spec 15,
 * R3-2, round 4). Returns the number of tokens, operators left out.
 */
function checkSearchLength(text) {
  if (charLength(text) > MAX_SEARCH_CHARS) throw bad(TOO_LONG_TEXT);
  for (const w of syntax.words(text)) {
    if (charLength(w) > MAX_WORD_CHARS) throw bad(TOO_LONG_TEXT);
  }
  if (!text) return 0;
  const { counts, total } = ftsTokens(text.replace(OPERATOR_RE, ' '));
  for (const n of counts.values()) if (n > MAX_WORD_REPEATS) throw bad(TOO_LONG_TEXT);
  return total;
}

/** The search-size caps (spec 5.5); throws QueryError(400). */
function checkSearchSize(text, fuzzy, nTokens = 0) {
  const mode = syntax.detectSearchMode(text, fuzzy);
  if (mode === 'boolean') {
    // Parenthesis depth first: the parser recurses on it.
    let depth = 0;
    for (const t of syntax.tokenizeBoolean(text)) {
      if (t.type === 'lparen' && ++depth > MAX_BOOLEAN_DEPTH) throw bad(TOO_COMPLEX);
      if (t.type === 'rparen' && depth > 0) depth--;
    }
    const tree = syntax.parseBoolean(text);
    if (tree && (countLeaves(tree) > MAX_BOOLEAN_TERMS || treeDepth(tree) > MAX_BOOLEAN_DEPTH)) throw bad(TOO_COMPLEX);
    if (tree) return;
  }
  if (Math.max(syntax.words(text).length, nTokens) > MAX_SEARCH_WORDS) throw bad(TOO_LONG);
}

/**
 * Nesting as the user wrote it: each NOT and each switch between AND and OR
 * is a level; a long a OR b OR c chain is one level, however long.
 */
function treeDepth(node, parentOp = null) {
  if (!node || node.op === 'term') return 0;
  if (node.op === 'not') return 1 + treeDepth(node.operand, 'not');
  const inner = Math.max(treeDepth(node.left, node.op), treeDepth(node.right, node.op));
  return inner + (node.op === parentOp ? 0 : 1);
}

function countLeaves(node) {
  if (!node) return 0;
  if (node.op === 'term') return 1;
  if (node.op === 'not') return countLeaves(node.operand);
  return countLeaves(node.left) + countLeaves(node.right);
}

/**
 * Fuzzy (spec 3.3): match(U), OR every word of U found in names, where a
 * word is found by its literal form or (4+ letters, no digits) by one of its
 * close vocabulary terms.
 *
 * Accepted limitation (round 5, verifier D1): within the caps, long words
 * built from very common name trigrams can still block 10 to 16 s at 2M (each
 * trigram is a near-whole-library doclist). Local single-user app; never
 * seen in real searches.
 */
function fuzzySql(text, ctx) {
  const u = String(text).trim().toLowerCase();
  const base = matchSql(u, ctx);
  const ws = syntax.words(u);
  if (!ws.length) return { ...base, closeTerms: [] };
  const names = ctx.search.metadataOnly ? META_NAME_COLS : NAME_COLS;
  const used = [];
  const nameTerms = [];   // one FTS clause per word of 3+ characters
  const shortTerms = [];  // one per shorter word (a prefix in the word index)
  const conds = [];
  let expanded = 0;
  // A repeated word adds nothing to "every word matches": each counts once.
  // "Repeated" means the same clause (fuzzyWordKey), so dropping it never
  // changes the result and word order does not matter: húurost and huurost
  // are one word to the names table, huurost + U+0305 is not.
  const seen = new Set();
  for (const w of ws) {
    const key = fuzzyWordKey(w);
    if (seen.has(key)) continue;
    seen.add(key);
    // Only typos are expanded: a word that already names files or tags stays
    // literal, and at most MAX_FUZZY_WORDS words per query are expanded.
    let close = [];
    if (expanded < MAX_FUZZY_WORDS && nameFuzzy.isFuzzable(w)
      && !nameFuzzy.isTerm(ctx.db, w, { metadataOnly: ctx.search.metadataOnly })) {
      close = nameFuzzy.closeTerms(ctx.db, w, { metadataOnly: ctx.search.metadataOnly });
      expanded++;
    }
    for (const t of close) if (!used.includes(t)) used.push(t);
    if (charLength(w) >= 3) {
      nameTerms.push(`${colFilter(names)} : (${[w, ...close].map(ftsString).join(' OR ')})`);
    } else {
      shortTerms.push(`${colFilter(names)} : ${ftsString(w)} *`);
    }
  }
  // Short words: one FTS query for all of them, one set (16 one-letter words
  // were 16 sets of nearly the whole library: 6 s cold at 2M).
  if (shortTerms.length) conds.push(`m.id IN ${idSet(ctx, TEXT_MATCH, [shortTerms.join(' AND ')]).table}`);
  // All the name words in one FTS query: FTS5 intersects the doclists itself,
  // one set instead of one per word.
  let wordsSet = null;
  if (nameTerms.length) {
    wordsSet = idSet(ctx, NAMES_MATCH, [nameTerms.join(' AND ')]);
    conds.push(`m.id IN ${wordsSet.table}`);
  }
  // Both halves are exact sets: their union is the whole result, and when it
  // is small it drives the query (a long phrase that matches little).
  if (base.set && wordsSet && conds.length === 1 && base.set.size + wordsSet.size <= DERIVE_MAX) {
    const set = idSet(ctx, `SELECT id FROM ${base.set.table} UNION SELECT id FROM ${wordsSet.table}`, []);
    return { sql: `m.id IN ${set.table}`, set, closeTerms: used };
  }
  return { sql: `(${base.sql} OR (${conds.join(' AND ')}))`, set: null, closeTerms: used };
}

// ── Filters → SQL (spec 4.2) ───────────────────────────────────────────────

const placeholders = (n) => new Array(n).fill('?').join(', ');

/** Raw `media.language` values whose display name is `name`, cached per version. */
let _langCache = null;   // { db, version, byName: Map(name → raw[]) }
function rawLanguagesFor(db, name, ver) {
  if (!_langCache || _langCache.db !== db || _langCache.version !== ver) {
    const byName = new Map();
    for (const raw of db.prepare('SELECT DISTINCT language FROM media').pluck().iterate()) {
      const n = langName(raw);
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(raw);
    }
    _langCache = { db, version: ver, byName };
  }
  return _langCache.byName.get(name) || [];
}

/** Index names in the file (the build adds them while the server runs). */
function indexNames(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").pluck().all());
}

/**
 * WHERE clauses for everything but text search, plus driver candidates (see
 * pickDriver). Mirrors the first pass of applyFilters(): an onlyIds focus set
 * replaces every other filter (and the grid's type restriction) outright, as
 * focusIds did.
 */
function filterSql(spec, ctx) {
  const { db, version } = ctx;
  const where = [];
  const params = [];
  const drivers = [];
  const add = (sql, ...p) => { where.push(sql); params.push(...p); };
  const have = indexNames(db);
  // A set condition: membership in a materialized set, which can also drive.
  const inSet = (set) => { add(`m.id IN ${set.table}`); drivers.push({ sql: `SELECT id FROM ${set.table}`, params: [], size: set.size }); };
  // An indexed condition: a subquery over a narrow or partial index, counted
  // on demand (bounded). Only when the build has made that index.
  const drive = (index, sql, ...p) => { if (have.has(index)) drivers.push({ sql, params: p }); };

  // Only searchable ids (libraryIndex.validId): results travel as Uint32.
  // Unary + keeps it a plain check, never a rowid range the planner walks.
  add(libraryIndex.validId('+m.id'));
  if (spec.onlyIds) {
    inSet(listSet(ctx, spec.onlyIds));
    return { where, params, drivers };
  }
  const f = spec.filters;

  // Unary + keeps the planner off idx_media_type_size for this near-universal
  // condition (only matters where no index is forced, e.g. mid-build).
  add(`+m.media_type IN (${GRID_TYPES.map(t => `'${t}'`).join(', ')})`);

  if (spec.collectionId != null) {
    inSet(listSet(ctx, collectionOrder(db, spec.collectionId)));
  } else if (f.collections === '1') {
    inSet(idSet(ctx, COLLECTED_IDS, []));
  } else if (f.collections === '0') {
    add(`m.id NOT IN ${idSet(ctx, COLLECTED_IDS, []).table}`);
  }

  if (f.song) inSet(idSet(ctx, 'SELECT media_id FROM media_songs WHERE song_id = ?', [f.song]));

  if (f.mediaTypes.length) {
    add(`m.media_type IN (${placeholders(f.mediaTypes.length)})`, ...f.mediaTypes);
    drive('idx_media_type_size', `SELECT id FROM media INDEXED BY idx_media_type_size
      WHERE media_type IN (${placeholders(f.mediaTypes.length)})`, ...f.mediaTypes);
  }
  const extIn = (exts) => {
    add(`m.ext IN (${placeholders(exts.length)})`, ...exts);
    drive('idx_media_ext_type', `SELECT id FROM media INDEXED BY idx_media_ext_type WHERE ext IN (${placeholders(exts.length)})`, ...exts);
  };
  if (f.safeOnly) extIn([...BROWSER_PLAYABLE_EXTENSIONS]);
  if (f.extensions.length) extIn(f.extensions);

  if (f.content) {
    add('m.content_type = ?', f.content);
    drive('idx_media_content_type', 'SELECT id FROM media INDEXED BY idx_media_content_type WHERE content_type = ?', f.content);
  }
  if (f.language) {
    // The browser compared display names, so "English" catches en/EN/English.
    // langName() of NULL is 'Unknown' too, and NULL never matches IN (...).
    const raws = rawLanguagesFor(db, f.language, version).filter(r => r !== null);
    const nullToo = f.language === langName(null);
    const inList = raws.length ? `language IN (${placeholders(raws.length)})` : '0';
    const cond = nullToo ? `(${inList} OR language IS NULL)` : inList;
    add(cond.replace(/\blanguage\b/g, 'm.language'), ...raws);
    drive('idx_media_language_type', `SELECT id FROM media INDEXED BY idx_media_language_type WHERE ${cond}`, ...raws);
  }
  if (f.quality) {
    add('m.quality_flag = ?', f.quality);
    drive('idx_media_quality_type', 'SELECT id FROM media INDEXED BY idx_media_quality_type WHERE quality_flag = ?', f.quality);
  }

  // Flags: the "yes" side can read its partial index (usually a few rows).
  const flag = (key) => {
    const [index, , cond] = libraryIndex.FLAG_INDEXES[key];
    drive(index, `SELECT id FROM media INDEXED BY ${index} WHERE ${cond}`);
  };
  const tri = (value, yes, key) => {
    if (value === '1') { add(yes); flag(key); }
    else if (value === '0') add(`NOT ${yes}`);
  };
  tri(f.starred, truthy('m.user_starred'), 'starred');
  tri(f.hasNotes, HAS_NOTES, 'notes');
  tri(f.flagged, truthy('m.user_flagged_delete'), 'flagged');
  tri(f.trashed, truthy('m.user_trashed'), 'trashed');
  tri(f.failed, truthy('m.playback_failed'), 'failed');
  if (f.scanStatus === 'success') add(SCAN_IS(0));
  else if (f.scanStatus === 'unscanned') { add(SCAN_IS(1)); flag('unscanned'); }
  else if (f.scanStatus === 'failed') { add(SCAN_IS(2)); flag('scanFailed'); }

  if (f.duplicates) {
    const dupes = idSet(ctx, DUPLICATE_IDS(have.has('idx_media_type_size') ? 'INDEXED BY idx_media_type_size' : ''), []);
    if (f.duplicates === '1') inSet(dupes);
    else add(`m.id NOT IN ${dupes.table}`);
  }

  // "Unrated" kept rows whose (rating || 0) > 0 is false.
  if (f.minRating === 'unrated') add('COALESCE(m.user_rating, 0) <= 0');
  else if (f.minRating !== '0') {
    add('COALESCE(m.user_rating, 0) >= ?', Number(f.minRating));
    drive('idx_media_sort_rating', 'SELECT id FROM media INDEXED BY idx_media_sort_rating WHERE COALESCE(user_rating, 0) >= ?', Number(f.minRating));
  }

  if (f.durMin > 0) add('COALESCE(m.duration_seconds, 0) >= ?', f.durMin * 60);
  if (f.durMax != null) add('COALESCE(m.duration_seconds, 0) <= ?', f.durMax * 60);
  if (f.durMin > 0 || f.durMax != null) {
    drive('idx_media_sort_duration', `SELECT id FROM media INDEXED BY idx_media_sort_duration
      WHERE COALESCE(duration_seconds, 0) >= ? AND COALESCE(duration_seconds, 0) <= ?`,
    f.durMin > 0 ? f.durMin * 60 : -Infinity, f.durMax != null ? f.durMax * 60 : Infinity);
  }

  // A theme is one hex token in media_search_themes (library-index themeTokens).
  if (f.theme) inSet(idSet(ctx, THEMES_MATCH, [ftsString(Buffer.from(f.theme, 'utf8').toString('hex'))]));

  return { where, params, drivers };
}

/** Ordered member ids of a collection, or a folder's deduped subtree union. */
function collectionOrder(db, collectionId) {
  return database.getCollectionItems(collectionId);
}

// ── Plan ───────────────────────────────────────────────────────────────────

/**
 * Everything a spec resolves to against the current data: the WHERE clause,
 * the driver candidates, how the result is ordered, and what the response
 * says about the search. `semanticScores` is carried over from an earlier
 * plan so a recompute (6.2, library changed) does not call the embedding
 * model again. The awaits (the embedding model, the fuzzy vocabulary) come
 * first: from then on the plan is built and run synchronously, so no other
 * request can evict a set it is about to use.
 */
async function buildPlan(spec, db, { semanticScores = null } = {}) {
  const text = spec.search.text.trim();
  const index = libraryIndex.status(db);
  const ready = index.state === 'ready';
  let scores = null;           // semantic: Map(id → score)
  if (text && spec.search.semantic) scores = semanticScores || await semanticSearch(text);
  else if (text && ready && syntax.detectSearchMode(text, spec.search.fuzzy) === 'fuzzy') await nameFuzzy.ensure(db);

  const version = libraryIndex.version(db);
  const ctx = { db, version, search: spec.search, used: new Set() };
  const { where, params, drivers } = filterSql(spec, ctx);
  const search = {
    mode: 'none',
    closeTerms: [],
    indexState: ready ? 'ready' : 'building',
    indexProgress: ready ? null : (index.progress ?? 0),
  };
  let order = 'sort';
  let empty = false;
  const addSet = (set) => {
    where.push(`m.id IN ${set.table}`);
    drivers.push({ sql: `SELECT id FROM ${set.table}`, params: [], size: set.size });
  };

  if (scores) {
    search.mode = 'semantic';
    addSet(listSet(ctx, [...scores.keys()]));
    order = 'rank';
  } else if (text && !ready) {
    // Text search waits for the index (spec 5.3): an empty page, and a mode.
    search.mode = syntax.detectSearchMode(text, spec.search.fuzzy);
    empty = true;
  } else if (text) {
    let mode = syntax.detectSearchMode(text, spec.search.fuzzy);
    let cond;
    if (mode === 'boolean') {
      const tree = syntax.parseBoolean(text);
      if (!tree) {
        mode = 'plain';
        cond = matchSql(text, ctx);
      } else {
        cond = booleanSql(tree, ctx);
      }
    } else if (mode === 'fuzzy') {
      cond = fuzzySql(text, ctx);
      search.closeTerms = cond.closeTerms;
    } else {
      cond = matchSql(text, ctx);
    }
    search.mode = mode;
    where.push(cond.sql);
    if (cond.set) drivers.push({ sql: `SELECT id FROM ${cond.set.table}`, params: [], size: cond.set.size });
  }
  // The Theme filter reads media_search_themes, which the build fills.
  if (spec.filters.theme && !spec.onlyIds && !ready) empty = true;

  if (spec.rankedIds) {
    addSet(listSet(ctx, spec.rankedIds.map(r => r.id)));
    order = 'rank';
  }
  if (order === 'sort' && spec.collectionId != null) order = 'collection';

  return { version, where, params, drivers, order, scores, search, empty };
}

async function semanticSearch(text) {
  const embeddings = require('./embeddings');
  let results;
  try {
    results = await embeddings.search(text, SEMANTIC_LIMIT);
  } catch (err) {
    // Same wording as GET /api/search/semantic.
    throw new QueryError(503, `embedding model unavailable: ${err.message}`, 'SEMANTIC_UNAVAILABLE');
  }
  if (!results.length) {
    throw new QueryError(503, 'no embeddings yet. Run: node vault.js embed', 'SEMANTIC_UNAVAILABLE');
  }
  return new Map(results.filter(r => r.score >= SEMANTIC_MIN_SCORE).map(r => [r.id, r.score]));
}

const whereSql = (where) => (where.length ? `WHERE ${where.join(' AND ')}` : '');

const DIR = { asc: 'ASC', desc: 'DESC' };

/**
 * Each result row leaves SQLite as one number, id * 8 + type code (spec 2):
 * a plucked integer per row is about three times faster to collect than a
 * two-column row, which is most of the cost of a 2M-id list.
 */
const TYPE_CODE_SQL = `CASE m.media_type ${Object.entries(TYPE_CODES).map(([t, c]) => `WHEN '${t}' THEN ${c}`).join(' ')} ELSE 0 END`;
const PACKED = `m.id * 8 + ${TYPE_CODE_SQL}`;
const unpackId = (v) => Math.floor(v / 8);

/**
 * Faves first was a second stable sort that floated starred rows up. Run it
 * as two queries, starred then not, each ordered by the index-friendly key:
 * same order, and each half can still walk its sort index. The starred half
 * can also start from the starred partial index (usually a few rows).
 */
function segments(spec, plan, have) {
  if (!spec.sort.favesFirst) return [{ where: plan.where, params: plan.params, drivers: plan.drivers }];
  const [index, , cond] = libraryIndex.FLAG_INDEXES.starred;
  const starredDriver = have.has(index) ? [{ sql: `SELECT id FROM media INDEXED BY ${index} WHERE ${cond}`, params: [] }] : [];
  return [
    { where: [...plan.where, truthy('m.user_starred')], params: plan.params, drivers: [...plan.drivers, ...starredDriver] },
    { where: [...plan.where, falsy('m.user_starred')], params: plan.params, drivers: plan.drivers },
  ];
}

/**
 * 'sort' order: packed ids from SQL, at most `limit` (null = all).
 *
 * Every sort index serves "key <native>, filepath ASC" without a sort step.
 * The other direction ("key ASC, filepath ASC" for the DESC-native keys)
 * would make SQLite sort each run of equal keys, and a run can be the whole
 * library (nobody has rated anything: every rating is 0). So:
 *   first page  walk the distinct key values in the wanted direction and
 *               read each value's rows in filepath order off the index;
 *   all ids     let SQLite sort the runs (the whole list is read anyway).
 * Name is exempt: its runs (same file name in two folders) are tiny.
 */
function sortedIds(db, spec, plan, limit) {
  const { field, dir } = spec.sort;
  const { expr, native } = SORT_FIELDS[field];
  const flip = dir !== native && field !== 'name';
  const have = indexNames(db);
  const sortIndex = `idx_media_sort_${field}`;
  const parts = [];
  let got = 0;
  for (const seg of segments(spec, plan, have)) {
    const need = limit == null ? null : limit - got;
    if (need !== null && need <= 0) break;
    const driver = pickDriver(db, seg.drivers, need);
    let ids;
    if (driver) {
      // A small set: look its rows up by id and sort them.
      const small = { where: [`m.id IN (${driver.sql})`, ...seg.where], params: [...driver.params, ...seg.params] };
      ids = plainSorted(db, 'FROM media m NOT INDEXED', small, expr, dir, need);
    } else {
      // The planner's choice while the build has not made the sort index yet.
      const from = `FROM media m ${have.has(sortIndex) ? `INDEXED BY ${sortIndex}` : ''}`;
      // The full list against the index direction: SQLite walks the index
      // and sorts each run of equal keys by filepath (measured under 1 s at
      // 2M even when one run is the whole library); the first page walks
      // key values instead, so it never waits for a big run to sort.
      if (!flip || need === null) ids = plainSorted(db, from, seg, expr, dir, need);
      else ids = groupWalk(db, from, seg, expr, dir, need);
    }
    parts.push(ids);
    got += ids.length;
  }
  return parts.length === 1 ? parts[0] : [].concat(...parts);
}

/**
 * The walk's weak spot is a filter few rows pass (a few starred files, a
 * rare theme): it reads far into the index to find them, up to about 0.3 s
 * at 2M files. When some condition's own id set is small enough, start from
 * that set instead: look its rows up by id and sort them.
 *
 * "Small enough" weighs one lookup in the media table (a few µs) against
 * reading index entries (a fraction of a µs each), for a library of n rows:
 *   all ids     the walk reads all n entries        set < n / 25
 *   first page  it reads about need * n / set       set < sqrt(need * n / 25)
 * (2M files: about 80,000 for the list, 2,800 for a page of 100.) Counting
 * is bounded by the threshold, so asking is cheap; n is max(id), near enough.
 */
const tuning = { smallSet: null };   // tests force a path: -1 never drives, a huge number always does
function pickDriver(db, drivers, need) {
  if (!drivers || !drivers.length) return null;
  let threshold = tuning.smallSet;
  if (threshold == null) {
    const n = db.prepare('SELECT max(id) FROM media').pluck().get() || 0;
    threshold = Math.round(need == null ? n / 25 : Math.sqrt(need * n / 25));
    threshold = Math.max(500, threshold);
  }
  let best = null;
  const limit = Math.max(0, threshold + 1);
  for (const d of drivers) {
    const n = d.size ?? db.prepare(`SELECT count(*) FROM (${d.sql} LIMIT ${limit})`).pluck().get(...d.params);
    if (n <= threshold && (!best || n < best.n)) best = { ...d, n };
  }
  return best;
}

function plainSorted(db, from, seg, expr, dir, need) {
  const sql = `SELECT ${PACKED} ${from} ${whereSql(seg.where)}
    ORDER BY ${expr} ${DIR[dir]}, m.filepath ASC${need === null ? '' : ' LIMIT ?'}`;
  return db.prepare(sql).pluck().all(...(need === null ? seg.params : [...seg.params, need]));
}

function groupWalk(db, from, seg, expr, dir, need) {
  const agg = dir === 'asc' ? 'min' : 'max';
  const beyond = dir === 'asc' ? '>' : '<';
  const first = db.prepare(`SELECT ${agg}(${expr}) FROM media`).pluck();
  const next = db.prepare(`SELECT ${agg}(${expr}) FROM media WHERE ${expr} ${beyond} ?`).pluck();
  const group = db.prepare(`SELECT ${PACKED} ${from} ${whereSql([...seg.where, `${expr} = ?`])}
    ORDER BY m.filepath ASC LIMIT ?`).pluck();
  const out = [];
  let key = first.get();
  let steps = 0;
  while (key !== null && out.length < need && steps < MAX_GROUP_STEPS) {
    for (const v of group.all(...seg.params, key, need - out.length)) out.push(v);
    steps++;
    if (out.length < need) key = next.get(key);
  }
  // Many sparse values (a selective filter): sort what is left in one go.
  if (key !== null && out.length < need) {
    const sql = `SELECT ${PACKED} ${from} ${whereSql([...seg.where, `${expr} ${dir === 'asc' ? '>=' : '<='} ?`])}
      ORDER BY ${expr} ${DIR[dir]}, m.filepath ASC LIMIT ?`;
    for (const v of db.prepare(sql).pluck().all(...seg.params, key, need - out.length)) out.push(v);
  }
  return out;
}

/**
 * 'rank' and 'collection' orders: the matching set is bounded (500 semantic
 * hits, the audio-sim list, one collection), so fetch it whole and order it
 * here exactly as the browser's stable sorts did.
 */
function rankedOrCollectionIds(db, spec, plan) {
  // In filepath order: the browser's array order before its stable sorts.
  const rows = db.prepare(`SELECT ${PACKED} FROM media m ${whereSql(plan.where)} ORDER BY m.filepath`)
    .pluck().all(...plan.params);
  const pos = new Map(rows.map((v, i) => [v, i]));
  let cmp;
  if (plan.order === 'rank') {
    const sem = plan.scores;
    const audio = spec.rankedIds ? new Map(spec.rankedIds.map(r => [r.id, r.score])) : null;
    cmp = (a, b) => {
      if (audio) {
        const d = (audio.get(unpackId(b)) || 0) - (audio.get(unpackId(a)) || 0);
        if (d) return d;
      }
      if (sem) {
        const d = (sem.get(unpackId(b)) || 0) - (sem.get(unpackId(a)) || 0);
        if (d) return d;
      }
      return pos.get(a) - pos.get(b);
    };
  } else {
    const order = collectionOrder(db, spec.collectionId);
    const at = new Map(order.map((id, i) => [id, i]));
    cmp = (a, b) => ((at.get(unpackId(a)) ?? 1e9) - (at.get(unpackId(b)) ?? 1e9)) || (pos.get(a) - pos.get(b));
  }
  return rows.sort(cmp);
}

/** Ordered packed ids (see PACKED), at most `limit` (null = all). */
function resultIds(db, spec, plan, limit) {
  if (plan.empty) return [];
  if (plan.order === 'sort') return sortedIds(db, spec, plan, limit);
  const all = rankedOrCollectionIds(db, spec, plan);
  return limit == null ? all : all.slice(0, limit);
}

// ── Plan cache (qid → spec) ────────────────────────────────────────────────

const plans = new Map();   // qid → { spec, version, createdAt, scores }
let qidSeq = 0;

function remember(spec, plan) {
  const qid = `${Date.now().toString(36)}${(++qidSeq).toString(36)}${crypto.randomBytes(4).toString('hex')}`;
  plans.set(qid, { spec, version: plan.version, createdAt: Date.now(), scores: plan.scores });
  while (plans.size > PLAN_CACHE_SIZE) plans.delete(plans.keys().next().value);
  return qid;
}

function recall(qid) {
  const p = plans.get(qid);
  if (!p) return null;
  if (Date.now() - p.createdAt > PLAN_TTL_MS) { plans.delete(qid); return null; }
  // Refresh its LRU position.
  plans.delete(qid);
  plans.set(qid, p);
  return p;
}

/** Forget every plan and set (the vault lock clears the library from memory). */
function clearPlans() {
  plans.clear();
  for (const [k, s] of setCache) dropSet(k, s);
  _langCache = null;
}

// ── Runners (async on purpose: another engine or a worker can sit behind them) ──

/** { ids, rows, complete } for the first `pageSize` results of a spec. */
async function firstPage(spec, pageSize = spec.pageSize) {
  const db = database.get();
  const plan = await buildPlan(spec, db);
  const packed = resultIds(db, spec, plan, pageSize + 1);
  const complete = packed.length <= pageSize;
  const pageIds = packed.slice(0, pageSize).map(unpackId);
  const rows = database.getManyForViewer(pageIds);
  return { ids: pageIds, rows, complete, plan };
}

/** POST /api/library/query: first page plus a qid for the full id list. */
async function query(spec) {
  const page = await firstPage(spec);
  const qid = remember(spec, page.plan);
  return {
    qid,
    version: page.plan.version,
    page: { ids: page.ids, rows: page.rows },
    complete: page.complete,
    total: page.complete ? page.ids.length : null,
    search: page.plan.search,
  };
}

/** Every id of a spec, in order, with type codes. */
async function allIds(spec, { semanticScores = null } = {}) {
  const db = database.get();
  const plan = await buildPlan(spec, db, { semanticScores });
  const packed = resultIds(db, spec, plan, null);
  const ids = new Uint32Array(packed.length);
  const types = new Uint8Array(packed.length);
  for (let i = 0; i < packed.length; i++) {
    const id = Math.floor(packed[i] / 8);
    ids[i] = id;
    types[i] = packed[i] - id * 8;
  }
  return { ids, types, version: plan.version };
}

/** GET /api/library/query/:qid/ids. null when the qid is unknown or expired. */
async function idsForQid(qid) {
  const p = recall(qid);
  if (!p) return null;
  // Always computed against current data; the version says which data.
  const out = await allIds(p.spec, { semanticScores: p.scores });
  p.version = out.version;
  return out;
}

/** Little-endian: u32 count, u32 version, count × u32 id, count × u8 type. */
function encodeIds({ ids, types, version }) {
  const n = ids.length;
  const buf = Buffer.allocUnsafe(8 + n * 5);
  buf.writeUInt32LE(n, 0);
  buf.writeUInt32LE(version >>> 0, 4);
  const idBytes = Buffer.from(ids.buffer, ids.byteOffset, n * 4);
  if (require('os').endianness() === 'LE') idBytes.copy(buf, 8);
  else for (let i = 0; i < n; i++) buf.writeUInt32LE(ids[i], 8 + i * 4);
  Buffer.from(types.buffer, types.byteOffset, n).copy(buf, 8 + n * 4);
  return buf;
}

module.exports = {
  GRID_TYPES, TYPE_CODES, SORT_FIELDS, PAGE_MAX,
  QueryError, normalizeSpec,
  ftsString, buildPlan,
  firstPage, query, allIds, idsForQid, encodeIds, clearPlans,
  _tuning: tuning,
};
