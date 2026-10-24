/**
 * The saved searches list under the Modern search box (player-lib/
 * saved-searches.js): which pills it lists for what is typed, when it hides,
 * how the arrows move the highlight, and what each key does in and out of
 * edit mode. Run in a VM with no DOM.
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
  vm.runInContext(`${src}\n;globalThis.__s = { savedSearchMatches, savedSearchMoveIndex, savedSearchDropdownState, savedSearchKeyAction, savedSearchIndexAfterRemove };`, ctx);
  return ctx.__s;
}

const { savedSearchMatches, savedSearchMoveIndex, savedSearchDropdownState, savedSearchKeyAction, savedSearchIndexAfterRemove } = load();

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

const act = (key, st) => JSON.parse(JSON.stringify(savedSearchKeyAction(key, st)));

test('all four arrows move pill to pill; Left / Right leave the caret alone only while typing with nothing highlighted', () => {
  assert.deepStrictEqual(act('ArrowRight', { index: -1, count: 3 }), { type: 'move', index: 0 });
  assert.deepStrictEqual(act('ArrowDown', { index: 0, count: 3 }), { type: 'move', index: 1 });
  assert.deepStrictEqual(act('ArrowLeft', { index: 0, count: 3 }), { type: 'move', index: 2 });
  assert.deepStrictEqual(act('ArrowUp', { index: 2, count: 3 }), { type: 'move', index: 1 });
  assert.strictEqual(savedSearchKeyAction('ArrowLeft', { index: -1, count: 3, typed: true }), null, 'caret');
  assert.strictEqual(savedSearchKeyAction('ArrowRight', { index: -1, count: 3, typed: true }), null, 'caret');
  assert.deepStrictEqual(act('ArrowRight', { index: 1, count: 3, typed: true }), { type: 'move', index: 2 });
  assert.deepStrictEqual(act('ArrowDown', { index: -1, count: 3, typed: true }), { type: 'move', index: 0 });
  assert.strictEqual(savedSearchKeyAction('ArrowDown', { index: -1, count: 0 }), null);
});

test('Enter picks the highlighted pill, and with nothing highlighted is the normal search', () => {
  assert.deepStrictEqual(act('Enter', { index: 1, count: 3 }), { type: 'pick', index: 1 });
  assert.deepStrictEqual(act('Enter', { index: -1, count: 3 }), { type: 'search' });
  assert.deepStrictEqual(act('Enter', { index: 5, count: 3 }), { type: 'search' }, 'a stale index is nothing');
});

test('edit mode: Enter does not run a pill, Delete / Backspace remove the highlighted one', () => {
  assert.deepStrictEqual(act('Enter', { index: 1, count: 3, editing: true }), { type: 'none' });
  assert.deepStrictEqual(act('Enter', { index: -1, count: 3, editing: true }), { type: 'search' });
  assert.deepStrictEqual(act('Delete', { index: 2, count: 3, editing: true }), { type: 'remove', index: 2 });
  assert.deepStrictEqual(act('Backspace', { index: 0, count: 3, editing: true }), { type: 'remove', index: 0 });
  assert.strictEqual(savedSearchKeyAction('Backspace', { index: -1, count: 3, editing: true }), null, 'edits the text');
  assert.strictEqual(savedSearchKeyAction('Delete', { index: 1, count: 3, editing: false }), null, 'only in edit mode');
  assert.strictEqual(savedSearchKeyAction('a', { index: 1, count: 3 }), null);
});

test('Esc leaves edit mode first, then closes the panel', () => {
  assert.deepStrictEqual(act('Escape', { index: 1, count: 3, editing: true }), { type: 'leave-edit' });
  assert.deepStrictEqual(act('Escape', { index: 1, count: 3, editing: false }), { type: 'close' });
});

test('after a remove the next pill takes the highlight, or the new last one', () => {
  assert.strictEqual(savedSearchIndexAfterRemove(1, 4), 1);
  assert.strictEqual(savedSearchIndexAfterRemove(3, 4), 2);
  assert.strictEqual(savedSearchIndexAfterRemove(0, 1), -1, 'none left');
  assert.strictEqual(savedSearchIndexAfterRemove(-1, 3), -1);
});
