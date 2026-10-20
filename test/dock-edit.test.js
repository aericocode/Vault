/**
 * player-lib/dock-edit.js (editing details in the Modern dock pane) in a VM:
 * the pure pieces. Typed text to chips, adding without repeats, removing,
 * the suggestion list (match, skip what the file has, order, limit), tallying
 * a field over loaded rows, the collections picker's list, and when a
 * description edit counts as a change.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadDockEdit() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'dock-edit.js'), 'utf8');
  const ctx = { window: {}, document: {}, console, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Date };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__de = DockEdit;`, ctx);
  return ctx.__de._pure;
}

const D = loadDockEdit();
// VM arrays come from another realm: compare as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

test('chip text: split on commas, trimmed, empties dropped', () => {
  assert.deepStrictEqual(plain(D.dockParseChipText('beach')), ['beach']);
  assert.deepStrictEqual(plain(D.dockParseChipText('  beach , sunset,,  , family ')), ['beach', 'sunset', 'family']);
  assert.deepStrictEqual(plain(D.dockParseChipText('')), []);
  assert.deepStrictEqual(plain(D.dockParseChipText('   ')), []);
  assert.deepStrictEqual(plain(D.dockParseChipText(null)), []);
  assert.deepStrictEqual(plain(D.dockParseChipText(undefined)), []);
  assert.deepStrictEqual(plain(D.dockParseChipText('New York')), ['New York'], 'spaces inside a value stay');
});

test('merge chips: adds new values, skips ones already there in any case', () => {
  const r = D.dockMergeChips(['Beach', 'sunset'], ['beach', 'Family', 'family', '  ', 'night']);
  assert.deepStrictEqual(plain(r.list), ['Beach', 'sunset', 'Family', 'night']);
  assert.deepStrictEqual(plain(r.added), ['Family', 'night']);
});

test('merge chips: nothing new leaves the list as it was', () => {
  const before = ['a', 'b'];
  const r = D.dockMergeChips(before, ['A', 'b']);
  assert.deepStrictEqual(plain(r.list), ['a', 'b']);
  assert.deepStrictEqual(plain(r.added), []);
  assert.deepStrictEqual(before, ['a', 'b'], 'the input list is not changed');
});

test('merge chips: a missing list starts empty', () => {
  assert.deepStrictEqual(plain(D.dockMergeChips(null, ['x']).list), ['x']);
  assert.deepStrictEqual(plain(D.dockMergeChips(undefined, undefined).list), []);
});

test('remove chip: the first exact match only, input untouched', () => {
  const list = ['a', 'b', 'a'];
  assert.deepStrictEqual(plain(D.dockRemoveChip(list, 'a')), ['b', 'a']);
  assert.deepStrictEqual(plain(D.dockRemoveChip(list, 'A')), ['a', 'b', 'a'], 'exact match');
  assert.deepStrictEqual(plain(D.dockRemoveChip(list, 'zzz')), ['a', 'b', 'a']);
  assert.deepStrictEqual(list, ['a', 'b', 'a']);
  assert.deepStrictEqual(plain(D.dockRemoveChip(null, 'a')), []);
});

const ITEMS = [
  { value: 'summer', count: 40 },
  { value: 'sunrise', count: 14 },
  { value: 'sunflower', count: 3 },
  { value: 'Tsunami', count: 99 },
  { value: 'beach', count: 70 },
  { value: 'Sunset', count: 14 },
];

test('suggest: values containing the text, starting-with first, then most used, then A to Z', () => {
  const out = plain(D.dockSuggest(ITEMS, 'sun', []));
  assert.deepStrictEqual(out.map(o => o.value), ['sunrise', 'Sunset', 'sunflower', 'Tsunami']);
  assert.strictEqual(out[0].count, 14);
});

test('suggest: any case, trims the query, skips what the file has (any case)', () => {
  const out = plain(D.dockSuggest(ITEMS, '  SUN ', ['sunset', 'SUNRISE']));
  assert.deepStrictEqual(out.map(o => o.value), ['sunflower', 'Tsunami']);
});

test('suggest: nothing typed, nothing suggested; the limit holds', () => {
  assert.deepStrictEqual(plain(D.dockSuggest(ITEMS, '', [])), []);
  assert.deepStrictEqual(plain(D.dockSuggest(ITEMS, '   ', [])), []);
  assert.strictEqual(D.dockSuggest(ITEMS, 's', [], 2).length, 2);
  const many = Array.from({ length: 30 }, (_, i) => ({ value: `tag${i}`, count: i }));
  assert.strictEqual(D.dockSuggest(many, 'tag', []).length, 8, 'eight by default');
});

test('suggest: odd entries are skipped, missing counts read as 0', () => {
  const out = plain(D.dockSuggest([null, { value: null }, { value: 'alpha' }, { value: 'alps', count: '5' }], 'al', []));
  assert.deepStrictEqual(out, [{ value: 'alps', count: 5 }, { value: 'alpha', count: 0 }]);
});

test('tally: counts files per value from JSON strings or arrays', () => {
  const rows = [
    { tags: '["beach","sunset"]' },
    { tags: ['beach', ' beach ', 'night'] },      // one file counts once per value
    { tags: 'not json' },
    { tags: '{"a":1}' },
    { tags: null },
    {},
    null,
    { tags: '["Beach", 5, ""]' },
  ];
  const out = plain(D.dockTallyValues(rows, 'tags')).sort((a, b) => a.value.localeCompare(b.value));
  assert.deepStrictEqual(out, [
    { value: 'beach', count: 2 },
    { value: 'Beach', count: 1 },
    { value: 'night', count: 1 },
    { value: 'sunset', count: 1 },
  ].sort((a, b) => a.value.localeCompare(b.value)));
  assert.deepStrictEqual(plain(D.dockTallyValues([], 'tags')), []);
  assert.deepStrictEqual(plain(D.dockTallyValues(null, 'tags')), []);
});

const COLLS = [
  { id: 1, name: 'Summer 2019', kind: 'collection' },
  { id: 2, name: 'Trips', kind: 'folder' },
  { id: 3, name: 'beach days', kind: 'collection' },
  { id: 4, name: 'Winter', kind: 'collection' },
  { id: 5, name: 'Best of', kind: null },
];

test('collections picker: real collections the file is not in, filtered, A to Z', () => {
  assert.deepStrictEqual(plain(D.dockCollectionMatches(COLLS, '', [4])).map(c => c.id), [3, 5, 1]);
  assert.deepStrictEqual(plain(D.dockCollectionMatches(COLLS, 'BE', [])).map(c => c.id), [3, 5]);
  assert.deepStrictEqual(plain(D.dockCollectionMatches(COLLS, 'trips', [])), [], 'folders are not offered');
  assert.deepStrictEqual(plain(D.dockCollectionMatches(COLLS, 'zzz', [])), []);
  assert.strictEqual(D.dockCollectionMatches(COLLS, '', [], 2).length, 2);
  assert.deepStrictEqual(plain(D.dockCollectionMatches(null, 'x', null)), []);
});

test('description: a change is what differs once trimmed', () => {
  assert.strictEqual(D.dockDescChanged('A day at the beach', 'A day at the beach  '), false);
  assert.strictEqual(D.dockDescChanged(null, ''), false);
  assert.strictEqual(D.dockDescChanged(undefined, '   '), false);
  assert.strictEqual(D.dockDescChanged('old', 'new'), true);
  assert.strictEqual(D.dockDescChanged('old', ''), true, 'clearing it is a change');
  assert.strictEqual(D.dockDescChanged('', 'new'), true);
});
