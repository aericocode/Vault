/**
 * Fuzzy search, F3 (SERVER_SEARCH_SPEC 3.3): typo tolerance on file names and
 * tags only.
 *
 * The vocabulary is every word the word index (media_search_text) holds for
 * the filename, tags and themes columns (filepath is left out: folder names
 * would drown the real names). For a typed word the close terms are the
 * vocabulary terms within a small Damerau-Levenshtein distance of it (optimal
 * string alignment: inserting, deleting or changing a letter, or swapping two
 * adjacent letters, each costs 1), compared folded (lowercase, no accents):
 *
 *   - 4 to 6 letters: distance 1; 7 or more: distance 2.
 *   - 4 or 5 letters: the term must also start with the same letter (people
 *     rarely mistype the first one, and short words have many neighbours:
 *     tets would otherwise bring sets, pets and jets).
 *   - Best first: smaller distance, then a pure swap (the same letters, as
 *     in tets and test), then the same first letter, then more files, then
 *     A to Z. At most MAX_CLOSE_TERMS per word.
 *
 * This replaced pg_trgm trigram similarity (>= 0.4): a swap in a short word
 * shares almost no trigrams (tets/test is 0.25), so the commonest typo was
 * never caught, and edit distance covers the insertions and deletions
 * trigrams did catch (sunst/sunset). lib/library-query.js then lets each word
 * match its close terms as well as itself.
 *
 * Lengths and distances count UTF-16 code units (one per letter for all but
 * rare astral letters). The terms are bucketed by length, so a word only
 * meets terms whose length is within its allowed distance; a letter mask
 * rules most of those out cheaply, and the banded comparison stops at the
 * first row that is already past the allowed distance.
 *
 * Reading the vocabulary means walking the whole word index (about 7 s at 2M
 * files), so the build reads it in slices of tuning.vocabChunk rows with the
 * event loop free in between, the server starts one in the background once
 * search is ready (prewarm), and a stale copy keeps answering while a fresh
 * one builds: it is rebuilt once the library has changed and the copy is a
 * minute old, so a scan that bumps the version every second does not rebuild
 * it every second.
 */

const { version } = require('./library-index');

// Tunables.
const MAX_CLOSE_TERMS = 6;        // per typed word
const MIN_FUZZY_WORD = 4;         // shorter words are never expanded
const LONG_WORD = 7;              // from this many letters, distance 2 is allowed
const SAME_FIRST_BELOW = 6;       // shorter words need terms with the same first letter
const MIN_TERM_LENGTH = 3;        // vocabulary terms shorter than this are skipped
const REBUILD_AFTER_MS = 60 * 1000;
// fts5vocab rows in the first slice; later ones are sized to SLICE_TARGET_MS
// (tests turn that off and shrink the slice to exercise the boundaries).
const tuning = { vocabChunk: 1000, adaptive: true };
const SLICE_TARGET_MS = 40;

const LETTERS_ONLY = /^\p{L}+$/u;
const FAR = 0x3fff;    // "more than the allowed distance"

let cache = null;      // { db, version, builtAt, terms, termIndex, docsAll, docsMeta, masks, buckets, buildMs, bytes }
let building = null;   // { db, promise }

/** Lowercased, diacritics removed: the form the word index stores terms in. */
function fold(word) {
  return String(word).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A word may be expanded when it is long enough and has no digits. */
function isFuzzable(word) {
  return [...word].length >= MIN_FUZZY_WORD && !/\p{N}/u.test(word);
}

/** Allowed distance for a typed word: 1, or 2 from LONG_WORD letters. */
function maxDistance(word) {
  return [...word].length >= LONG_WORD ? 2 : 1;
}

/**
 * Which letters a word holds, one bit each (a to z; other letters share the
 * last six bits). An insert or delete changes at most one bit, a change at
 * most two, a swap none, so terms whose masks differ in more than 2 * k bits
 * are more than k apart.
 */
function letterMask(word) {
  let m = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    m |= 1 << (c >= 97 && c <= 122 ? c - 97 : 26 + (c % 6));
  }
  return m >>> 0;
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Three DP rows, grown as needed.
let rowA = new Int32Array(128);
let rowB = new Int32Array(128);
let rowC = new Int32Array(128);

/**
 * Optimal string alignment distance of a and b, or FAR once it is certainly
 * more than k. Only the band |i - j| <= k is computed, and it stops at the
 * first row whose smallest cell is past k.
 */
function osa(a, b, k) {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > k) return FAR;
  if (rowA.length < m + 2) {
    rowA = new Int32Array(m + 2);
    rowB = new Int32Array(m + 2);
    rowC = new Int32Array(m + 2);
  }
  let prev2 = rowA;
  let prev = rowB;
  let cur = rowC;
  for (let j = 0; j <= m; j++) prev[j] = j <= k ? j : FAR;
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(1, i - k);
    const hi = Math.min(m, i + k);
    let rowMin = FAR;
    if (lo === 1) { cur[0] = i; rowMin = i; } else cur[lo - 1] = FAR;
    const ca = a.charCodeAt(i - 1);
    const pa = i > 1 ? a.charCodeAt(i - 2) : -1;
    for (let j = lo; j <= hi; j++) {
      const cb = b.charCodeAt(j - 1);
      let v = prev[j - 1] + (ca === cb ? 0 : 1);
      const del = prev[j] + 1;
      if (del < v) v = del;
      const ins = cur[j - 1] + 1;
      if (ins < v) v = ins;
      if (j > 1 && pa === cb && ca === b.charCodeAt(j - 2)) {
        const swap = prev2[j - 2] + 1;
        if (swap < v) v = swap;
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (hi < m) cur[hi + 1] = FAR;
    if (rowMin > k) return FAR;
    const t = prev2; prev2 = prev; prev = cur; cur = t;
  }
  return prev[m] > k ? FAR : prev[m];
}

/** Damerau-Levenshtein (optimal string alignment) distance (exported for tests). */
function distance(a, b) {
  return osa(a, b, Math.max(a.length, b.length));
}

/** The same letters in another order (with distance 1: a pure swap). */
function isAnagram(a, b) {
  return a.length === b.length && [...a].sort().join('') === [...b].sort().join('');
}

const tick = () => new Promise(resolve => setImmediate(resolve));

/**
 * Read the vocabulary slice by slice and index it. A slice ends on a term
 * boundary: its last term may continue in the next slice, so that term is
 * carried over and read again whole.
 */
async function build(db) {
  const t0 = Date.now();
  const ver = version(db);
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.media_search_vocab USING fts5vocab(main, 'media_search_text', 'col')");
  const slice = db.prepare(`SELECT term, col, doc FROM temp.media_search_vocab
    WHERE term >= ? ORDER BY term LIMIT ?`).raw();
  const index = new Map();          // term → [docsAll, docsMeta]
  const add = (term, col, doc) => {
    if (col !== 'filename' && col !== 'tags' && col !== 'themes') return;
    if (term.length < MIN_TERM_LENGTH || !LETTERS_ONLY.test(term)) return;
    let e = index.get(term);
    if (!e) index.set(term, e = [0, 0]);
    e[0] += doc;
    if (col !== 'filename') e[1] += doc;
  };
  // Slices are sized by time (round 3: fixed 20k-row slices blocked 300 to
  // 530 ms at 2M): each aims at SLICE_TARGET_MS, so the server answers
  // between them.
  let from = '';
  let chunk = tuning.vocabChunk;
  let size = chunk;
  for (;;) {
    if (!db.open) return null;
    const s0 = Date.now();
    const rows = slice.all(from, size);
    if (rows.length < size) {
      for (const [term, col, doc] of rows) add(term, col, doc);
      break;
    }
    const last = rows[rows.length - 1][0];
    // A slice holding one term only cannot advance: read that term whole.
    if (rows[0][0] === last) { size *= 2; continue; }
    for (const [term, col, doc] of rows) if (term !== last) add(term, col, doc);
    from = last;
    // Shrink at once, grow slowly, never past 2,000 rows: a run of very
    // common terms (each a doclist of up to 2M files) can sit right after a
    // fast stretch. One such term alone costs ~150 ms at 2M and cannot be
    // split; that is the floor.
    if (tuning.adaptive) {
      chunk = Math.max(100, Math.min(2000, Math.round(chunk * 1.25),
        Math.round(chunk * SLICE_TARGET_MS / Math.max(1, Date.now() - s0))));
    }
    size = chunk;
    await tick();
  }

  // Per term: file counts and letter mask; terms bucketed by length. Also in
  // time slices (at 2M: 476k terms).
  const terms = [...index.keys()];
  const termIndex = index;          // reused: term → position in terms
  const docsAll = new Uint32Array(terms.length);
  const docsMeta = new Uint32Array(terms.length);
  const masks = new Uint32Array(terms.length);
  const lists = [];                 // length → number[]
  let s0 = Date.now();
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    const [all, meta] = index.get(term);
    termIndex.set(term, i);
    docsAll[i] = all;
    docsMeta[i] = meta;
    masks[i] = letterMask(term);
    (lists[term.length] || (lists[term.length] = [])).push(i);
    if ((i & 1023) === 0 && Date.now() - s0 > SLICE_TARGET_MS) {
      await tick();
      if (!db.open) return null;
      s0 = Date.now();
    }
  }
  const buckets = Array.from(lists, l => (l ? Uint32Array.from(l) : null));

  const termBytes = terms.reduce((n, t) => n + 2 * t.length + 40, 0);
  return {
    db, version: ver, builtAt: Date.now(),
    terms, termIndex, docsAll, docsMeta, masks, buckets,
    buildMs: Date.now() - t0,
    // Rough: strings, one Map entry, three typed-array slots and a bucket slot per term.
    bytes: termBytes + terms.length * (40 + 12 + 4),
  };
}

function startBuild(db) {
  if (building && building.db === db) return building.promise;
  const promise = build(db).then((v) => {
    if (v && v.db.open) cache = v;
    return cache && cache.db === db ? cache : null;
  }).finally(() => { if (building && building.promise === promise) building = null; });
  building = { db, promise };
  return promise;
}

/**
 * The vocabulary for `db`, building it on first use. A copy that is out of
 * date (library changed, copy a minute old) is returned as is while a fresh
 * one builds in the background.
 */
async function ensure(db) {
  if (cache && cache.db === db) {
    if (cache.version !== version(db) && Date.now() - cache.builtAt > REBUILD_AFTER_MS) {
      startBuild(db).catch(() => {});
    }
    return cache;
  }
  return startBuild(db);
}

/** Build in the background now, so the first fuzzy search does not wait. */
function prewarm(db) {
  ensure(db).catch(err => console.warn(`[fuzzy] vocabulary build failed: ${err.message}`));
}

/**
 * Is the word itself a vocabulary term (names files, or with metadataOnly,
 * tags or themes)? Such a word is not a typo and is never expanded.
 */
function isTerm(db, word, { metadataOnly = false } = {}) {
  const v = cache && cache.db === db ? cache : null;
  if (!v) return false;
  const i = v.termIndex.get(fold(word));
  if (i === undefined) return false;
  return (metadataOnly ? v.docsMeta : v.docsAll)[i] > 0;
}

/**
 * Close vocabulary terms for one typed word, best first (rules in the header),
 * from the copy ensure() loaded. Empty for words that are not fuzzable or when
 * no copy is loaded. With metadataOnly, only terms that occur in tags or
 * themes count (file names are out of the search).
 */
function closeTerms(db, word, { metadataOnly = false } = {}) {
  const w = fold(word);
  if (!isFuzzable(w)) return [];
  const v = cache && cache.db === db ? cache : null;
  if (!v) return [];
  const docs = metadataOnly ? v.docsMeta : v.docsAll;
  const k = maxDistance(w);
  const first = w.charCodeAt(0);
  const sameFirst = [...w].length < SAME_FIRST_BELOW;
  const wMask = letterMask(w);
  const hits = [];
  for (let len = Math.max(MIN_TERM_LENGTH, w.length - k); len <= w.length + k; len++) {
    const bucket = v.buckets[len];
    if (!bucket) continue;
    for (let x = 0; x < bucket.length; x++) {
      const i = bucket[x];
      if (docs[i] === 0 || popcount(wMask ^ v.masks[i]) > 2 * k) continue;
      const t = v.terms[i];
      if (sameFirst && t.charCodeAt(0) !== first) continue;
      const d = osa(w, t, k);
      if (d === FAR || t === w) continue;
      hits.push([d, isAnagram(w, t) ? 0 : 1, t.charCodeAt(0) === first ? 0 : 1, docs[i], t]);
    }
  }
  hits.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]) || (b[3] - a[3])
    || (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0));
  return hits.slice(0, MAX_CLOSE_TERMS).map(h => h[4]);
}

/** Build stats for the benchmark and the report. */
function stats() {
  if (!cache) return null;
  return { terms: cache.terms.length, buckets: cache.buckets.filter(Boolean).length, buildMs: cache.buildMs, approxBytes: cache.bytes };
}

function reset() { cache = null; building = null; }

module.exports = {
  MAX_CLOSE_TERMS, MIN_FUZZY_WORD, REBUILD_AFTER_MS,
  closeTerms, isTerm, ensure, prewarm, isFuzzable, maxDistance, distance, fold, stats, reset,
  _tuning: tuning,
};
