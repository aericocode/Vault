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

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'player-lib', f), 'utf8').replace(/\r\n/g, '\n');
const between = (src, a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  assert.ok(i >= 0 && j > i, `markers not found: ${a} / ${b}`);
  return src.slice(i, j);
};
const FILTERS = read('filters.js');
const CARDS = read('cards.js');

function setup({ layout, pageAnchor, contState, firstIds = 100, total = 120, realAfter = false }) {
  const drawn = [];
  let releaseIds;
  const idsPromise = new Promise(r => { releaseIds = r; });
  // Timers by hand: a test fires the bounded wait's timeout when it wants.
  const timers = new Map();
  let timerSeq = 0;
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
    setTimeout: (fn) => { timers.set(++timerSeq, fn); return timerSeq; },
    clearTimeout: (t) => { timers.delete(t); },
  };
  vm.createContext(ctx);
  vm.runInContext(between(CARDS, 'function libraryHeldEnd()', '/** Where the viewport sits'), ctx);
  // realAfter: the real afterResults (it lets go of the hold), drawing through renderResults.
  const filtersEnd = realAfter ? '/* ── First-launch index build' : '/** The UI work that follows a new result. */';
  if (realAfter) {
    delete ctx.afterResults;
    ctx.renderSearchNote = () => {};
    ctx.renderResults = () => drawn.push({ known: lib.known });
  }
  vm.runInContext(between(FILTERS, 'let _applySeq = 0;', filtersEnd) + '\nvar _searchLock = null;', ctx);
  const fireTimers = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); };
  return { ctx, drawn, releaseIds, timers, fireTimers };
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

/* While a keep-place re-run waits, nothing else may draw the continuous list
   from the first answer: a sort change grows the collection header, the
   grid's resize observer re-laid the list 100 results tall in the meantime,
   and Firefox pulled the view up (2571 to 2393 with the id list 400 ms late). */

test('continuous: the view is held while the re-run waits, and let go when it draws', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 } });
  assert.strictEqual(s.ctx.libraryDrawHeld(), false);
  const done = s.ctx.applyFilters({ keepPage: true });
  await tick();
  assert.strictEqual(s.ctx.libraryDrawHeld(), true, 'other redraws must wait too');
  s.releaseIds();
  await done;
  assert.strictEqual(s.ctx.libraryDrawHeld(), false);
  assert.deepStrictEqual(s.drawn, [{ keep: true, known: true }]);
  assert.strictEqual(s.timers.size, 0, 'the timeout is cleared');
});

test('pages mode: a wait does not hold other redraws (placeholders fill in, as before)', async () => {
  const s = setup({ layout: 'pages', pageAnchor: 100, contState: { cols: 7, last: -1 } });
  const done = s.ctx.applyFilters({ keepPage: true });
  await tick();
  assert.strictEqual(s.ctx.libraryDrawHeld(), false);
  s.releaseIds();
  await done;
});

test('an id list that never comes: after the bounded wait the view draws and is let go', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 } });
  const done = s.ctx.applyFilters({ keepPage: true });
  await tick();
  assert.strictEqual(s.ctx.libraryDrawHeld(), true);
  assert.deepStrictEqual(s.drawn, []);
  s.fireTimers();
  await done;   // a collection drag awaiting this is free again
  assert.strictEqual(s.ctx.libraryDrawHeld(), false);
  assert.deepStrictEqual(s.drawn, [{ keep: true, known: false }]);
});

test('a newer search that draws lets go of an older wait', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 }, realAfter: true });
  const older = s.ctx.applyFilters({ keepPage: true });
  await tick();
  assert.strictEqual(s.ctx.libraryDrawHeld(), true);
  await s.ctx.applyFilters();   // a new search: draws at once
  assert.strictEqual(s.ctx.libraryDrawHeld(), false);
  assert.strictEqual(s.drawn.length, 1);
  s.releaseIds();
  await older;
  assert.strictEqual(s.drawn.length, 1, 'the superseded run does not draw');
});

/* A newer re-run that fails (a 500) draws nothing. The count arriving for the
   held run was skipped while held, and the held run, superseded, does not
   draw either: the old rows stayed up in the old order until a scroll. The
   skipped draw is made up once, when the hold lets go. */
function failingRerun(s) {
  s.ctx.showErrorToast = () => {};
  s.ctx.console = { warn() {} };
  s.ctx.Library.query = () => Promise.reject({ status: 500, message: 'boom' });
}
// What the results-counted handler does: renderContinuous, which skips while held.
const countArrives = (s) => { if (!s.ctx.libraryDrawHeld()) s.drawn.push({ counted: true }); };

test('superseded by a run that fails: the skipped redraw is made up once on release', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 }, realAfter: true });
  const older = s.ctx.applyFilters({ keepPage: true });
  await tick();
  assert.strictEqual(s.ctx.libraryDrawHeld(), true);
  failingRerun(s);
  await s.ctx.applyFilters({ keepPage: true });   // the 500
  assert.deepStrictEqual(s.drawn, [], 'still held: nothing draws yet');
  countArrives(s);                                 // skipped: held
  s.releaseIds();
  await older;
  assert.strictEqual(s.ctx.libraryDrawHeld(), false);
  assert.deepStrictEqual(s.drawn, [{ known: true }], 'redrawn once from the full list');
});

test('superseded while the newer run is in flight: no make-up, the newer run draws', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 }, realAfter: true });
  const older = s.ctx.applyFilters({ keepPage: true });
  await tick();
  let answer;
  s.ctx.Library.query = () => new Promise(r => { answer = r; });
  const newer = s.ctx.applyFilters({ keepPage: true });
  countArrives(s);
  s.releaseIds();
  await older;
  assert.deepStrictEqual(s.drawn, [], 'the newer run, still asking, draws for itself');
  answer(true);
  await newer;
  assert.deepStrictEqual(s.drawn, [{ known: true }], 'drawn once, by the newer run');
});

test('superseded while in flight, then the newer run fails: made up once then', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 }, realAfter: true });
  const older = s.ctx.applyFilters({ keepPage: true });
  await tick();
  let reject;
  s.ctx.showErrorToast = () => {};
  s.ctx.console = { warn() {} };
  s.ctx.Library.query = () => new Promise((_, r) => { reject = r; });
  const newer = s.ctx.applyFilters({ keepPage: true });
  countArrives(s);
  s.releaseIds();
  await older;
  assert.deepStrictEqual(s.drawn, []);
  reject({ status: 500 });
  await newer;
  assert.deepStrictEqual(s.drawn, [{ known: true }]);
});

test('nothing skipped while held: a failed newer run does not redraw', async () => {
  const s = setup({ layout: 'continuous', pageAnchor: 84, contState: { cols: 7, last: 17 }, realAfter: true });
  const older = s.ctx.applyFilters({ keepPage: true });
  await tick();
  failingRerun(s);
  await s.ctx.applyFilters({ keepPage: true });
  s.releaseIds();
  await older;
  assert.deepStrictEqual(s.drawn, []);
});

/* The drawing side (cards.js, table-view.js): every way into a continuous
   draw stops while held, so no redraw path is missed. */
test('held: renderResults, renderContinuous and the window passes draw nothing', () => {
  const TABLE = read('table-view.js');
  const calls = [];
  const ctx = {
    held: true,
    libraryDrawHeld() { return ctx.held; },
    renderEmptyState() { calls.push('drew'); return true; },
    tableViewActive() { return false; },
    document: { querySelector() { calls.push('drew'); return null; } },
  };
  vm.createContext(ctx);
  vm.runInContext(between(CARDS, 'function renderResults()', '/* ── Rows on demand'), ctx);
  vm.runInContext(between(CARDS, 'function renderContinuous()', '/** Swap in the rows for the current scroll position. */'), ctx);
  vm.runInContext(between(CARDS, 'function renderContinuousWindow()', '/* ── Keeping rows across a scroll'), ctx);
  vm.runInContext(between(TABLE, 'function tvRenderWindow()', '\n}\n') + '\n}', ctx);
  for (const fn of ['renderResults', 'renderContinuous', 'renderContinuousWindow', 'tvRenderWindow']) {
    ctx[fn]();
  }
  assert.deepStrictEqual(calls, [], 'something drew while held');
  ctx.held = false;
  for (const fn of ['renderResults', 'renderContinuous', 'renderContinuousWindow', 'tvRenderWindow']) {
    calls.length = 0;
    ctx[fn]();
    assert.ok(calls.length > 0, `${fn} did not draw once let go`);
  }
});

/* Files in or out of the collection on screen keep the place, like a
   reorder (collections.js _applyToggleSideEffects; every add and remove goes
   through changeCollectionMembership, which calls it). */
test('membership change: the open collection keeps its place, other views as before', () => {
  const COLLS = read('collections.js');
  const runs = [];
  const ctx = {
    activeCollectionId: 5, currentTab: 'collections',
    collectionMembers: new Map(),
    _isAncestorFolder: (folder, id) => folder === 9 && id === 5,
    _folderAggregateIds: () => [],
    renderCollectionHeader() {},
    collectionsFilterValue: () => '',
    applyFilters: (opts) => runs.push(opts === undefined ? "top" : JSON.stringify(opts)),
    renderResults: () => runs.push('cards'),
  };
  vm.createContext(ctx);
  vm.runInContext(between(COLLS, 'function _applyToggleSideEffects(id)', 'async function togglePickerCollection'), ctx);

  ctx._applyToggleSideEffects(5);                       // the collection on screen
  ctx.activeCollectionId = 9; ctx._applyToggleSideEffects(5);   // a folder holding it
  assert.deepStrictEqual(runs, ['{"keepPage":true}', '{"keepPage":true}']);

  runs.length = 0;
  ctx.activeCollectionId = 7; ctx._applyToggleSideEffects(5);   // another collection open: nothing to redo
  assert.deepStrictEqual(runs, []);
  ctx.activeCollectionId = null; ctx.currentTab = 'library';
  ctx.collectionsFilterValue = () => 'in';
  ctx._applyToggleSideEffects(5);                       // the library's collection filter: as before
  assert.deepStrictEqual(runs, ['top']);
});
