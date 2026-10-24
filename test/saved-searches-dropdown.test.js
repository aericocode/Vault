/**
 * The saved searches list under the Modern search box (player-lib/
 * saved-searches.js): which rows it lists for what is typed, when it hides,
 * and how Up / Down move the highlight. Run in a VM with no DOM.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const ctx = { console, Math, JSON, Array, Object, String, Number, Boolean };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'saved-searches.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__s = { savedSearchMatches, savedSearchMoveIndex, savedSearchDropdownState };`, ctx);
  return ctx.__s;
}

const { savedSearchMatches, savedSearchMoveIndex, savedSearchDropdownState } = load();

const LIST = [
  { id: 1, name: 'Blonde dance', search_text: 'blonde dance', filters: { searchText: 'blonde dance' } },
  { id: 2, name: 'Beach outdoor', search_text: 'beach', filters: { searchText: 'beach' } },
  { id: 3, name: 'Four stars', search_text: '', filters: { searchText: 'rating:4' } },
];
const ids = (rows) => Array.from(rows, r => r.id);   // out of the VM's realm

test('an empty box lists every saved search in order', () => {
  assert.deepStrictEqual(ids(savedSearchMatches(LIST, '')), [1, 2, 3]);
  assert.deepStrictEqual(ids(savedSearchMatches(LIST, '   ')), [1, 2, 3]);
  assert.notStrictEqual(savedSearchMatches(LIST, ''), LIST, 'a copy, not the cache itself');
});

test('typing narrows by name or query, any case', () => {
  assert.deepStrictEqual(ids(savedSearchMatches(LIST, 'DANCE')), [1]);
  assert.deepStrictEqual(ids(savedSearchMatches(LIST, 'b')), [1, 2]);
  assert.deepStrictEqual(ids(savedSearchMatches(LIST, 'outdoor')), [2], 'by name');
  assert.deepStrictEqual(ids(savedSearchMatches(LIST, ' beach ')), [2], 'trimmed');
  assert.deepStrictEqual(ids(savedSearchMatches(LIST, 'zzz')), []);
});

test('the query falls back to the saved filters when the row has no search_text column', () => {
  const rows = [{ id: 9, name: 'Mine', filters: { searchText: 'rating:5' } }];
  assert.deepStrictEqual(ids(savedSearchMatches(rows, 'rating')), [9]);
});

test('bad input is an empty list, not a throw', () => {
  assert.strictEqual(savedSearchMatches(null, 'a').length, 0);
  assert.deepStrictEqual(ids(savedSearchMatches([null, { id: 4, name: 'Ok' }], 'ok')), [4]);
});

test('the list hides when typed text matches nothing, and always shows for an empty box', () => {
  assert.strictEqual(savedSearchDropdownState(LIST, '').show, true);
  assert.strictEqual(savedSearchDropdownState(LIST, 'beach').show, true);
  assert.strictEqual(savedSearchDropdownState(LIST, 'nothing like it').show, false);
  const none = savedSearchDropdownState([], '');
  assert.strictEqual(none.show, true, 'an empty box with nothing saved says how to save one');
  assert.strictEqual(none.empty, true);
  assert.strictEqual(savedSearchDropdownState([], 'cats').show, false, 'typing with nothing saved: normal search only');
  assert.strictEqual(savedSearchDropdownState(LIST, '').empty, false);
});

test('Down from nothing is the first row, Up from nothing is the last, and both wrap', () => {
  assert.strictEqual(savedSearchMoveIndex(-1, 1, 3), 0);
  assert.strictEqual(savedSearchMoveIndex(0, 1, 3), 1);
  assert.strictEqual(savedSearchMoveIndex(2, 1, 3), 0);
  assert.strictEqual(savedSearchMoveIndex(-1, -1, 3), 2);
  assert.strictEqual(savedSearchMoveIndex(0, -1, 3), 2);
  assert.strictEqual(savedSearchMoveIndex(2, -1, 3), 1);
});

test('an empty list never highlights, and a stale index starts over', () => {
  assert.strictEqual(savedSearchMoveIndex(-1, 1, 0), -1);
  assert.strictEqual(savedSearchMoveIndex(4, -1, 0), -1);
  assert.strictEqual(savedSearchMoveIndex(7, 1, 3), 0, 'past the end (after a remove)');
  assert.strictEqual(savedSearchMoveIndex(undefined, 1, 2), 0);
});
