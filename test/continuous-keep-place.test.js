/**
 * A re-run of the same query that keeps the place (applyFilters keepPage:
 * after a collection rearrange, a trash, a library change) waits for the
 * full id list before it draws when the view holds rows past the first
 * answer (player-lib/filters.js, cards.js libraryHeldEnd).
 *
 * The bug: in continuous mode only the FIRST tile on screen was checked.
 * With it inside the first answer (100 results) but rows below it past
 * that, the grid was drawn 100 results tall, the browser pulled the scroll
 * position up to that shorter end, and when the full list arrived the view
 * stayed there: a drop near the bottom of a 120-file collection left the
 * view in the middle of the list (Firefox; Chrome's scroll anchoring
 * happened to put it back).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'player-lib', f), 'utf8');
const between = (src, a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `markers not found: ${a} / ${b}`);
  return src.slice(i, j);
};
const FILTERS = read('filters.js');
const CARDS = read('cards.js');

function setup({ layout, pageAnchor, contState, firstIds = 100, total = 120 }) {
  const drawn = [];
  let releaseIds;
  const idsPromise = new Promise(r => { releaseIds = r; });
  const lib = {
    known: false,
    firstPageIds: Array.from({ length: firstIds }, (_, i) => i + 1),
    query: () => Promise.resolve(true),
    waitIds: () => idsPromise.then(() => { lib.known = true; return new Uint32Array(total); }),
  };
  const ctx = {
    Promise, Math, Uint32Array,
    Library: { ...lib, known: () => lib.known, query: lib.query, waitIds: lib.waitIds, firstPageIds: lib.firstPageIds },
    pageAnchor, contState,
    libraryLayoutMode: () => layout,
    syncSearchScope() {}, currentQuerySpec: () => ({ search: { text: '' } }),
    persistSearchState() {}, collectionsHomeShowing: () => false,
    afterResults: (keep) => drawn.push({ keep, known: lib.known }),
    showToast() {}, console,
  };
  vm.createContext(ctx);
  vm.runInContext(between(CARDS, 'function libraryHeldEnd()', '/** Where the viewport sits'), ctx);
  vm.runInContext(between(FILTERS, 'let _applySeq = 0;', '/** The UI work that follows a new result. */')
    + '\nvar _searchLock = null;', ctx);
  return { ctx, drawn, releaseIds };
}

const tick = () => new Promise(r => setTimeout(r, 0));

test('continuous: rows on screen past the first answer wait for the id list', async () => {
  // The owner's case: first tile 84, rows drawn to 17 (7 columns: up to 126).
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 } });
  const done = s.ctx.applyFilters({ keepPage: true });
  await tick();
  assert.deepStrictEqual(s.drawn, [], 'drawn before the full list was in');
  s.releaseIds();
  await done;
  await tick();
  assert.deepStrictEqual(s.drawn, [{ keep: true, known: true }]);
});

test('continuous: a view inside the first answer draws at once', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 0, contState: { cols: 7, last: 6 } });
  await s.ctx.applyFilters({ keepPage: true });
  assert.deepStrictEqual(s.drawn, [{ keep: true, known: false }]);
});

test('pages mode: only the page start counts, as before', async () => {
  // A page that starts inside the first answer draws now (placeholders fill in).
  const s = setup({ layout: 'pages', pageAnchor: 84, contState: { cols: 7, last: 17 } });
  await s.ctx.applyFilters({ keepPage: true });
  assert.deepStrictEqual(s.drawn, [{ keep: true, known: false }]);
  // One that starts past it waits.
  const t = setup({ layout: 'pages', pageAnchor: 100, contState: { cols: 7, last: -1 } });
  const done = t.ctx.applyFilters({ keepPage: true });
  await tick();
  assert.deepStrictEqual(t.drawn, []);
  t.releaseIds();
  await done;
  await tick();
  assert.deepStrictEqual(t.drawn, [{ keep: true, known: true }]);
});

test('a new search never waits (keepPage off)', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 } });
  await s.ctx.applyFilters();
  assert.deepStrictEqual(s.drawn, [{ keep: false, known: false }]);
});

test('libraryHeldEnd: continuous rows drawn, the table (one column) too', () => {
  const s = setup({ layout: 'continuous', pageAnchor: 93, contState: { cols: 1, last: 117 } });
  assert.strictEqual(s.ctx.libraryHeldEnd(), 118);
  const t = setup({ layout: 'continuous', pageAnchor: 5, contState: { cols: 4, last: -1 } });
  assert.strictEqual(t.ctx.libraryHeldEnd(), 6, 'nothing drawn yet: the first tile');
});
