/**
 * The Library, the Collections tab's cards and each open collection keep
 * their own search text AND their own filters (player-lib/filters.js
 * SearchScopes): opening a collection never carries the Library's search or
 * filters into it, and going back puts the Library's back, exactly. The
 * search options, the sort and the saved searches themselves stay shared.
 * The Library's state is still the one remembered for the next launch.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'player-lib', 'filters.js'), 'utf8');
const savedSrc = fs.readFileSync(path.join(ROOT, 'player-lib', 'saved-searches.js'), 'utf8');

function grab(name, from = src) {
  const at = from.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  let depth = 0;
  for (let i = from.indexOf(') {', at) + 2; i < from.length; i++) {
    if (from[i] === '{') depth++;
    else if (from[i] === '}' && --depth === 0) return from.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

/** A const declaration from filters.js, as it is there. */
function grabConst(name) {
  const m = new RegExp(`const ${name} = [^;]*;`).exec(src);
  assert.ok(m, `${name} is there`);
  return m[0];
}

/**
 * A page: the search box, the filter controls (selects as plain values, the
 * tri filters as a map, the media types) and the saved search lit, with
 * syncSearchScope run as applyFilters runs it. captureFilterControls and
 * restoreFilterControls are the real ones from saved-searches.js.
 */
function page() {
  const els = {
    searchInput: { value: '' },
    filterContent: { value: '' }, filterLanguage: { value: '' }, filterMinRating: { value: '0' },
    filterTheme: { value: '' }, filterQuality: { value: '' }, filterSong: { value: '' }, filterStreamTag: { value: '' },
  };
  const tris = { filterTrashed: '0' };
  const ctx = {
    els, tris,
    currentTab: 'library',
    activeCollectionId: null,
    focusBarRenders: 0,
    document: { getElementById: (id) => els[id] || null },
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let selectedMediaTypes = [];
    let safeOnly = false;
    let selectedExtensions = [];
    let durMinM = 0;
    let durMaxM = null;
    let activeSavedSearchId = null;
    function getTriFilterValue(n) { return tris[n] || ''; }
    function setTriFilterValue(n, v) { tris[n] = v; }
    function renderMediaTypeBar() {}
    function renderTypeExtensionFilter() {}
    function renderFocusBar() { globalThis.focusBarRenders++; }
    ${grab('captureFilterControls', savedSrc)}
    ${grab('restoreFilterControls', savedSrc)}
    ${grabConst('SearchScopes')}
    ${grabConst('SEARCH_SCOPE_EMPTY')}
    ${grabConst('VIEW_FILTER_SELECTS')}
    ${grabConst('VIEW_FILTER_TRIS')}
    ${grab('searchScopeKey')}
    ${grab('searchScopeSwitch')}
    ${grab('searchScopeLibraryText')}
    ${grab('searchScopePersisted')}
    ${grab('captureViewFilters')}
    ${grab('applyViewFilters')}
    ${grab('syncSearchScope')}
    ${grab('libraryOverridesOff')}
    ${grab('searchScopeForget')}
    ${grabConst('QUERY_SORT_FIELDS')}
    let focusIds = null;
    let focusRanked = null;
    let audioSimScores = null;
    let audioSimAnchorId = null;
    let currentSort = 'processed_desc';
    let favesFirst = false;
    let libSort = 'processed_desc';
    function librarySortValue() { return libSort; }
    function semanticEnabled() { return false; }
    ${grab('viewFiltersSpec')}
    ${grab('currentQuerySpec')}
    ${grab('libraryNarrowed')}
    globalThis.specStr = (opts) => JSON.stringify(currentQuerySpec(opts));
    globalThis.setFocus = (ids) => { focusIds = ids ? new Set(ids) : null; };
    globalThis.setSim = (anchor, pairs) => { audioSimAnchorId = anchor; audioSimScores = pairs ? new Map(pairs) : null; };
    globalThis.sorts = (cur, lib) => { currentSort = cur; libSort = lib; };
    globalThis.narrowed = () => libraryNarrowed();
    globalThis.overridesOff = () => libraryOverridesOff();
    globalThis.forget = (id) => searchScopeForget(id);
    globalThis.go = (tab, coll) => { currentTab = tab; activeCollectionId = coll; syncSearchScope(); return els.searchInput.value; };
    globalThis.types = (t) => { if (t) selectedMediaTypes = t; return [...selectedMediaTypes]; };
    globalThis.saved = (id) => { if (id !== undefined) activeSavedSearchId = id; return activeSavedSearchId; };
    globalThis.libraryText = () => searchScopeLibraryText(SearchScopes, els.searchInput.value);
    globalThis.persisted = (state) => JSON.parse(JSON.stringify(
      searchScopePersisted(SearchScopes, state, Object.keys(captureFilterControls()))));
  `, ctx);
  ctx.spec = (opts) => JSON.parse(ctx.specStr(opts));
  return ctx;
}

test('which view the box and the filters belong to', () => {
  const ctx = page();
  vm.runInContext(`globalThis.k = [
    searchScopeKey('library', null), searchScopeKey('faces', null), searchScopeKey('collections', null),
    searchScopeKey('collections', 7), searchScopeKey('library', 7)]`, ctx);
  assert.deepStrictEqual([...ctx.k], ['library', 'library', 'collections', 'c:7', 'c:7']);
});

test('the owner\'s round trip: search the Library, open a collection (empty box), order it, back to the same Library search', () => {
  const ctx = page();
  ctx.els.searchInput.value = 'beach';                       // typed in the Library
  assert.strictEqual(ctx.go('collections', null), '', 'the collection cards start unsearched');
  assert.strictEqual(ctx.go('collections', 4), '', 'the collection shows all of itself');
  ctx.els.searchInput.value = 'intro';                       // searched inside the collection
  assert.strictEqual(ctx.go('collections', null), '', 'back to the cards');
  assert.strictEqual(ctx.go('library', null), 'beach', 'the Library search is back');
  assert.strictEqual(ctx.go('collections', 4), 'intro', 'and the collection keeps its own');
  assert.strictEqual(ctx.go('collections', 9), '', 'another collection starts empty');
});

test('filters are per view too: a collection opens unfiltered, keeps its own, and the Library gets its own back', () => {
  const ctx = page();
  const { els, tris } = ctx;
  // The Library: videos, a language, the Song filter, Favorites only, the trash shown.
  ctx.types(['video']);
  els.filterLanguage.value = 'English';
  els.filterSong.value = '12';
  tris.filterStarred = '1';
  tris.filterTrashed = '';

  ctx.go('collections', 4);
  assert.deepStrictEqual(Array.from(ctx.types()), [], 'no type picked in the collection');
  assert.strictEqual(els.filterLanguage.value, '');
  assert.strictEqual(els.filterSong.value, '');
  assert.strictEqual(tris.filterStarred, '');
  assert.strictEqual(tris.filterTrashed, '0', 'the trash is hidden, its "not set" value');

  // Different filters inside the collection.
  els.filterQuality.value = 'low';
  tris.filterFlagged = '1';

  ctx.go('library', null);
  assert.deepStrictEqual(Array.from(ctx.types()), ['video']);
  assert.strictEqual(els.filterLanguage.value, 'English');
  assert.strictEqual(els.filterSong.value, '12');
  assert.strictEqual(tris.filterStarred, '1');
  assert.strictEqual(tris.filterTrashed, '');
  assert.strictEqual(els.filterQuality.value, '', 'nothing set in the collection reaches the Library');
  assert.strictEqual(tris.filterFlagged, '');

  ctx.go('collections', 4);
  assert.strictEqual(els.filterQuality.value, 'low', 'the collection keeps its own');
  assert.strictEqual(tris.filterFlagged, '1');
  assert.deepStrictEqual(Array.from(ctx.types()), []);

  ctx.go('collections', 9);
  assert.strictEqual(els.filterQuality.value, '', 'another collection starts unfiltered');
  assert.strictEqual(tris.filterFlagged, '');
});

test('the saved search that is lit belongs to the view', () => {
  const ctx = page();
  ctx.saved(3);
  ctx.go('collections', 4);
  assert.strictEqual(ctx.saved(), null, 'not lit in the collection');
  ctx.saved(5);
  ctx.go('library', null);
  assert.strictEqual(ctx.saved(), 3);
  ctx.go('collections', 4);
  assert.strictEqual(ctx.saved(), 5);
});

test('a switch redraws the focus bar (it hides inside a collection), the same view again does nothing', () => {
  const ctx = page();
  ctx.go('collections', 4);
  assert.strictEqual(ctx.focusBarRenders, 1);
  ctx.els.searchInput.value = 'abcd';
  ctx.els.filterTheme.value = 'sea';
  assert.strictEqual(ctx.go('collections', 4), 'abcd', 'typing is never overwritten');
  assert.strictEqual(ctx.els.filterTheme.value, 'sea');
  assert.strictEqual(ctx.focusBarRenders, 1);
});

test('a collection opened while on the Library tab (the rail) has its own state too', () => {
  const ctx = page();
  ctx.els.searchInput.value = 'sunset';
  ctx.els.filterContent.value = 'vlog';
  assert.strictEqual(ctx.go('library', 3), '');
  assert.strictEqual(ctx.els.filterContent.value, '');
  assert.strictEqual(ctx.go('library', null), 'sunset');
  assert.strictEqual(ctx.els.filterContent.value, 'vlog');
});

test('Faces shares the Library\'s search and filters', () => {
  const ctx = page();
  ctx.els.searchInput.value = 'abc';
  ctx.els.filterContent.value = 'vlog';
  assert.strictEqual(ctx.go('faces', null), 'abc');
  assert.strictEqual(ctx.els.filterContent.value, 'vlog');
});

test('the Library\'s state is what is remembered for the next launch, even from inside a collection', () => {
  const ctx = page();
  const { els } = ctx;
  els.searchInput.value = 'beach';
  els.filterLanguage.value = 'English';
  assert.strictEqual(ctx.libraryText(), 'beach');
  ctx.go('collections', 4);
  els.searchInput.value = 'intro';
  els.filterQuality.value = 'low';
  assert.strictEqual(ctx.libraryText(), 'beach');
  // What persistSearchState writes: the controls hold the collection now.
  const now = { searchText: 'intro', fuzzySearch: true, filterLanguage: '', filterQuality: 'low', filterMinRating: '0', sortValue: 'name_asc' };
  const out = ctx.persisted(now);
  assert.strictEqual(out.searchText, 'beach');
  assert.strictEqual(out.filterLanguage, 'English', 'the Library\'s filters');
  assert.strictEqual(out.filterQuality, '', 'not the collection\'s');
  assert.strictEqual(out.fuzzySearch, true, 'search options are shared');
  assert.strictEqual(out.sortValue, 'name_asc', 'the sort is shared');
  ctx.go('library', null);
  assert.deepStrictEqual({ ...ctx.persisted(now) }, now, 'on the Library, the controls are the Library');
  assert.match(grab('persistSearchState'), /searchScopePersisted\(SearchScopes, captureCurrentFilterState\(\),/);
});

test('every search syncs first, and things that go to the Library go there before they set anything', () => {
  const apply = grab('applyFilters');
  assert.ok(apply.indexOf('syncSearchScope();') >= 0, 'applyFilters syncs');
  assert.ok(apply.indexOf('syncSearchScope();') < apply.indexOf('currentQuerySpec()'), 'before the spec is read');
  const focus = grab('setFocusIds');
  assert.ok(focus.indexOf('goToLibraryView();') >= 0 && focus.indexOf('goToLibraryView();') < focus.indexOf("getElementById('searchInput')"),
    'the focus clears (and later restores) the Library\'s own text');
  // ...the Library view: its tab, or the rail's open collection closed.
  const go = grab('goToLibraryView');
  assert.match(go, /switchTab\('library'\)/);
  assert.match(go, /closeCollection\(\)/);
  const music = fs.readFileSync(path.join(ROOT, 'player-lib', 'music.js'), 'utf8');
  assert.match(grab('startAudioSimilarity', music), /goToLibraryView\(\)/);
  const editor = fs.readFileSync(path.join(ROOT, 'player-lib', 'editor.js'), 'utf8');
  const song = grab('editorShowSongInLibrary', editor);
  assert.ok(song.indexOf("switchTab('library')") < song.indexOf("getElementById('filterSong')"),
    'Show in library sets the Library\'s own Song filter');
});

test('the Library\'s focus and audio similarity: only in the Library view, not a collection or the cards', () => {
  const ctx = page();
  ctx.setFocus([1, 2, 3]);
  ctx.setSim(1, [[1, 1], [5, 0.5]]);
  assert.deepStrictEqual(ctx.spec().onlyIds, [1, 2, 3], 'the Library on screen');
  assert.ok(ctx.spec().rankedIds, 'ranked');
  assert.strictEqual(ctx.overridesOff(), false);
  for (const [tab, coll] of [['collections', null], ['collections', 4], ['library', 4]]) {
    ctx.go(tab, coll);
    const s = ctx.spec();
    assert.strictEqual(s.onlyIds, null, `${tab} ${coll}: no focus`);
    assert.strictEqual(s.rankedIds, null, `${tab} ${coll}: no audio similarity`);
    assert.strictEqual(ctx.overridesOff(), true, `${tab} ${coll}: the bars hide`);
    // ...but the Library's own spec (the Wall) still has them.
    assert.deepStrictEqual(ctx.spec({ library: true }).onlyIds, [1, 2, 3]);
    assert.ok(ctx.spec({ library: true }).rankedIds);
  }
  assert.match(grab('renderFocusBar'), /libraryOverridesOff\(\)/);
  const music = fs.readFileSync(path.join(ROOT, 'player-lib', 'music.js'), 'utf8');
  assert.match(grab('renderAudioSimBar', music), /libraryOverridesOff\(\)/);
});

test('the Library\'s own query (the Wall\'s "Current library filter"), whatever view holds the controls', () => {
  const ctx = page();
  const { els } = ctx;
  ctx.sorts('name_asc', 'name_asc');
  els.searchInput.value = 'beach';
  els.filterMinRating.value = 'eq4,eq5';
  const here = ctx.spec({ library: true });
  assert.strictEqual(here.search.text, 'beach');
  assert.strictEqual(here.filters.minRating, 'eq4,eq5');
  assert.deepStrictEqual(here, ctx.spec(), 'on the Library: the same as the grid\'s');
  assert.strictEqual(ctx.narrowed(), true);

  // The Collections cards (the reported case), then an open collection with its own.
  for (const coll of [null, 4]) {
    ctx.go('collections', coll);
    if (coll) { els.searchInput.value = 'intro'; els.filterMinRating.value = 'eq1'; ctx.sorts('playlist_asc', 'name_asc'); }
    const s = ctx.spec({ library: true });
    assert.strictEqual(s.search.text, 'beach', 'the Library\'s text');
    assert.strictEqual(s.filters.minRating, 'eq4,eq5', 'the Library\'s filters, not "0"');
    assert.strictEqual(s.filters.trashed, '0', 'the trash hidden, as the Library had it');
    assert.strictEqual(s.collectionId, null, 'never a collection');
    assert.deepStrictEqual(s.sort, { field: 'name', dir: 'asc', favesFirst: false }, 'the Library\'s sort');
    assert.strictEqual(ctx.narrowed(), true);
  }
  // The grid's own spec is still the collection's.
  const grid = ctx.spec();
  assert.strictEqual(grid.collectionId, 4);
  assert.strictEqual(grid.filters.minRating, 'eq1');

  // A Library with nothing set is not narrowed, from anywhere.
  ctx.go('library', null);
  els.searchInput.value = '';
  els.filterMinRating.value = '0';
  ctx.go('collections', null);
  assert.strictEqual(ctx.narrowed(), false);
  assert.strictEqual(ctx.spec({ library: true }).filters.minRating, '0');

  const wall = fs.readFileSync(path.join(ROOT, 'player-lib', 'wall.js'), 'utf8');
  assert.match(wall, /currentQuerySpec\(\{ library: true \}\)/);
  assert.match(wall, /narrowed: typeof libraryNarrowed === 'function' && libraryNarrowed\(\)/);
});

test('a deleted collection\'s view is forgotten', () => {
  const ctx = page();
  ctx.go('collections', 4);
  ctx.els.filterQuality.value = 'low';
  ctx.go('collections', null);
  ctx.forget(4);
  ctx.go('collections', 4);
  assert.strictEqual(ctx.els.filterQuality.value, '', 'a collection with the same id starts unfiltered');
  const coll = fs.readFileSync(path.join(ROOT, 'player-lib', 'collections.js'), 'utf8');
  for (const fn of ['cardDelete', 'deleteCollectionTwoStep']) {

    const body = grab(fn, coll);
    assert.ok(body.indexOf('applyFilters()') < body.indexOf('searchScopeForget(id)'), `${fn}: forgets after leaving the view`);
  }
  assert.match(grab('cardDelete', coll), /searchScopeForget\(id\)/);
});

test('the launch restore puts the remembered state in the Library, even when Collections came back first', () => {
  const restore = grab('restoreLastSearchState');
  assert.ok(restore.indexOf('syncSearchScope();') < restore.indexOf('restoreFilterState(state)'));
  assert.match(restore, /SearchScopes\.views\.set\('library'/);
});
