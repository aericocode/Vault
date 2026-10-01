/**
 * Fuzzy search, F3 (SERVER_SEARCH_SPEC 3.3): typo tolerance on file names and
 * tags only.
 *
 * The vocabulary is every word the word index (media_search_text) holds for
 * the filename, tags and themes columns (filepath is left out: folder names
 * would drown the real names). For a typed word we find the vocabulary terms
 * that share enough trigrams with it, using pg_trgm's similarity: trigrams of
 * the word padded with two spaces in front and one behind, |A ∩ B| / |A ∪ B|.
 * lib/library-query.js then lets each word match its close terms as well as
 * itself.
 *
 * The trigram inverted index lives in memory. Reading the vocabulary means
 * walking the whole word index (about 7 s at 2M files), so the build reads it
 * in slices of tuning.vocabChunk rows with the event loop free in between, the
 * server starts one in the background once search is ready (prewarm), and a
 * stale copy keeps answering while a fresh one builds: it is rebuilt once the
 * library has changed and the copy is a minute old, so a scan that bumps the
 * version every second does not rebuild it every second.
 */

const { version } = require('./library-index');

// Tunables.
const SIMILARITY_MIN = 0.4;       // pg_trgm's default threshold
const MAX_CLOSE_TERMS = 6;        // per typed word
const MIN_FUZZY_WORD = 4;         // shorter words are never expanded
const MIN_TERM_LENGTH = 3;        // vocabulary terms shorter than this are skipped
const REBUILD_AFTER_MS = 60 * 1000;
// fts5vocab rows in the first slice; later ones are sized to SLICE_TARGET_MS
// (tests turn that off and shrink the slice to exercise the boundaries).
const tuning = { vocabChunk: 1000, adaptive: true };
const SLICE_TARGET_MS = 40;

const LETTERS_ONLY = /^\p{L}+$/u;

let cache = null;      // { db, version, builtAt, terms, docsAll, docsMeta, ntri, postings, counts, buildMs, bytes }
let building = null;   // { db, promise }

/** Lowercased, diacritics removed: the form the word index stores terms in. */
function fold(word) {
  return String(word).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** A word may be expanded when it is long enough and has no digits. */
function isFuzzable(word) {
  return [...word].length >= MIN_FUZZY_WORD && !/\p{N}/u.test(word);
}

/** pg_trgm trigrams of one word (distinct). */
function trigrams(word) {
  const chars = [' ', ' ', ...word, ' '];
  const out = new Set();
  for (let i = 0; i + 3 <= chars.length; i++) out.add(chars[i] + chars[i + 1] + chars[i + 2]);
  return out;
}

/** pg_trgm similarity of two words (exported for tests). */
function similarity(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
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

  // The trigram index, also in time slices (at 2M: 476k terms).
  const terms = [...index.keys()];
  const termIndex = new Map();
  const docsAll = new Uint32Array(terms.length);
  const docsMeta = new Uint32Array(terms.length);
  const ntri = new Uint16Array(terms.length);
  const lists = new Map();          // trigram → number[]
  let s0 = Date.now();
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    termIndex.set(term, i);
    const [all, meta] = index.get(term);
    docsAll[i] = all;
    docsMeta[i] = meta;
    const tri = trigrams(term);
    ntri[i] = Math.min(tri.size, 65535);
    for (const t of tri) {
      let l = lists.get(t);
      if (!l) lists.set(t, l = []);
      l.push(i);
    }
    if ((i & 1023) === 0 && Date.now() - s0 > SLICE_TARGET_MS) {
      await tick();
      if (!db.open) return null;
      s0 = Date.now();
    }
  }
  index.clear();
  const postings = new Map();
  let entries = 0;
  for (const [t, l] of lists) {
    postings.set(t, Uint32Array.from(l));
    entries += l.length;
    if (Date.now() - s0 > SLICE_TARGET_MS) { await tick(); s0 = Date.now(); }
  }

  const termBytes = terms.reduce((n, t) => n + 2 * t.length + 40, 0);
  return {
    db, version: ver, builtAt: Date.now(),
    terms, termIndex, docsAll, docsMeta, ntri, postings,
    counts: new Uint16Array(terms.length),
    buildMs: Date.now() - t0,
    // Rough: strings + typed arrays + one Map entry per trigram.
    bytes: termBytes + terms.length * 52 + entries * 4 + postings.size * 80,
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
 * Close vocabulary terms for one typed word, best first, from the copy
 * ensure() loaded. Empty for words that are not fuzzable or when no copy is
 * loaded. With metadataOnly, only terms that occur in tags or themes count
 * (file names are out of the search).
 */
function closeTerms(db, word, { metadataOnly = false } = {}) {
  const w = fold(word);
  if (!isFuzzable(w)) return [];
  const v = cache && cache.db === db ? cache : null;
  if (!v) return [];
  const docs = metadataOnly ? v.docsMeta : v.docsAll;
  const A = trigrams(w);
  const counts = v.counts;
  const touched = [];
  for (const t of A) {
    const list = v.postings.get(t);
    if (!list) continue;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      if (counts[i] === 0) touched.push(i);
      counts[i]++;
    }
  }
  const hits = [];
  for (const i of touched) {
    const shared = counts[i];
    counts[i] = 0;
    if (docs[i] === 0) continue;
    const sim = shared / (A.size + v.ntri[i] - shared);
    if (sim >= SIMILARITY_MIN && v.terms[i] !== w) hits.push([sim, docs[i], v.terms[i]]);
  }
  hits.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0));
  return hits.slice(0, MAX_CLOSE_TERMS).map(h => h[2]);
}

/** Build stats for the benchmark and the report. */
function stats() {
  if (!cache) return null;
  return { terms: cache.terms.length, trigrams: cache.postings.size, buildMs: cache.buildMs, approxBytes: cache.bytes };
}

function reset() { cache = null; building = null; }

module.exports = {
  SIMILARITY_MIN, MAX_CLOSE_TERMS, MIN_FUZZY_WORD, REBUILD_AFTER_MS,
  closeTerms, isTerm, ensure, prewarm, isFuzzable, similarity, trigrams, fold, stats, reset,
  _tuning: tuning,
};
