/**
 * The Library, the Collections tab's cards and each open collection keep
 * their own search text (player-lib/filters.js SearchScopes): opening a
 * collection never carries the Library's search into it, and going back
 * puts the Library's search back. Only the text; the filters stay shared.
 * The Library's text is still the one remembered for the next launch.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'filters.js'), 'utf8');

function grab(name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  let depth = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

/** The box, the tab and the open collection, with syncSearchScope run as applyFilters runs it. */
function page() {
  const box = { value: '' };
  const ctx = {
    box,
    currentTab: 'library',
    activeCollectionId: null,
    document: { getElementById: (id) => (id === 'searchInput' ? box : null) },
  };
  vm.createContext(ctx);
  vm.runInContext(`
    const SearchScopes = { key: 'library', texts: new Map() };
    ${grab('searchScopeKey')}
    ${grab('searchScopeSwitch')}
    ${grab('searchScopeLibraryText')}
    ${grab('syncSearchScope')}
    globalThis.go = (tab, coll) => { currentTab = tab; activeCollectionId = coll; syncSearchScope(); return box.value; };
    globalThis.libraryText = () => searchScopeLibraryText(SearchScopes, box.value);
  `, ctx);
  return ctx;
}

test('which view the box belongs to', () => {
  const ctx = page();
  vm.runInContext(`globalThis.k = [
    searchScopeKey('library', null), searchScopeKey('faces', null), searchScopeKey('collections', null),
    searchScopeKey('collections', 7), searchScopeKey('library', 7)]`, ctx);
  assert.deepStrictEqual([...ctx.k], ['library', 'library', 'collections', 'c:7', 'c:7']);
});

test('the owner\'s round trip: search the Library, open a collection (empty box), order it, back to the same Library search', () => {
  const ctx = page();
  ctx.box.value = 'beach';                                   // typed in the Library
  assert.strictEqual(ctx.go('collections', null), '', 'the collection cards start unsearched');
  assert.strictEqual(ctx.go('collections', 4), '', 'the collection shows all of itself');
  ctx.box.value = 'intro';                                   // searched inside the collection
  assert.strictEqual(ctx.go('collections', null), '', 'back to the cards');
  assert.strictEqual(ctx.go('library', null), 'beach', 'the Library search is back');
  assert.strictEqual(ctx.go('collections', 4), 'intro', 'and the collection keeps its own');
  assert.strictEqual(ctx.go('collections', 9), '', 'another collection starts empty');
});

test('a collection opened while on the Library tab (the rail) has its own text too', () => {
  const ctx = page();
  ctx.box.value = 'sunset';
  assert.strictEqual(ctx.go('library', 3), '');
  assert.strictEqual(ctx.go('library', null), 'sunset');
});

test('the same view again changes nothing (typing is never overwritten)', () => {
  const ctx = page();
  ctx.box.value = 'abc';
  assert.strictEqual(ctx.go('library', null), 'abc');
  ctx.box.value = 'abcd';
  assert.strictEqual(ctx.go('faces', null), 'abcd', 'Faces shares the Library text');
});

test('the Library text is what is remembered for the next launch, even from inside a collection', () => {
  const ctx = page();
  ctx.box.value = 'beach';
  assert.strictEqual(ctx.libraryText(), 'beach');
  ctx.go('collections', 4);
  ctx.box.value = 'intro';
  assert.strictEqual(ctx.libraryText(), 'beach');
  assert.match(grab('persistSearchState'), /state\.searchText = searchScopeLibraryText\(SearchScopes, state\.searchText\);/);
});

test('every search syncs the box first, and a focus set moves to the Library before it clears the box', () => {
  const apply = grab('applyFilters');
  assert.ok(apply.indexOf('syncSearchScope();') >= 0, 'applyFilters syncs');
  assert.ok(apply.indexOf('syncSearchScope();') < apply.indexOf('currentQuerySpec()'), 'before the spec is read');
  const focus = grab('setFocusIds');
  assert.ok(focus.indexOf("switchTab('library')") < focus.indexOf("getElementById('searchInput')"),
    'the focus clears (and later restores) the Library\'s own text');
});
