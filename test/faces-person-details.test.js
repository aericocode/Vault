/**
 * Person page sidebar (player-lib/faces-tab.js), pure helpers run in a VM:
 * the fold order for short windows (the photo keeps its size; seen-with
 * folds, then Details, then the photo moves beside the name, and only then
 * the column scrolls), the Born check the in-place field and Edit details
 * share, and the "N of 7 filled" count (Studio counts too).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(names) {
  const noop = () => {};
  const el = () => ({ addEventListener: noop, classList: { contains: () => false, add: noop, remove: noop, toggle: noop }, querySelectorAll: () => [], remove: noop });
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Date, Error, Number, String, Array, Object, Boolean, URLSearchParams,
    document: { readyState: 'complete', addEventListener: noop, body: el(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener: noop },
    addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    debounce: (f) => f,
    // studios.js helpers the count reads
    stAliasList: (x) => (x && Array.isArray(x.aliasList) ? x.aliasList : []),
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'faces-tab.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__x = { ${names.join(', ')} };`, ctx);
  return ctx.__x;
}

const { ftFoldLevel, ftBornError, ftDetailCount, ftDetailFilled } = load(['ftFoldLevel', 'ftBornError', 'ftDetailCount', 'ftDetailFilled']);

test('fold: everything fits, nothing folds', () => {
  assert.strictEqual(ftFoldLevel(1100, [1013, 787, 590, 380]), 0);
  assert.strictEqual(ftFoldLevel(1013, [1013, 787, 590, 380]), 0, 'an exact fit is a fit');
});

test('fold: seen-with folds first, then Details, then the photo', () => {
  const h = [1013, 787, 590, 380];
  assert.strictEqual(ftFoldLevel(1000, h), 1);
  assert.strictEqual(ftFoldLevel(787, h), 1);
  assert.strictEqual(ftFoldLevel(743, h), 2);
  assert.strictEqual(ftFoldLevel(589, h), 3);
});

test('fold: nothing fits, the last fold stays (the column scrolls)', () => {
  assert.strictEqual(ftFoldLevel(240, [1013, 787, 590, 380]), 3);
});

test('fold: a level that does not save height is skipped past only when it does not fit', () => {
  // Details opened by hand: level 2 is as tall as level 1.
  assert.strictEqual(ftFoldLevel(700, [900, 760, 760, 560]), 3);
  assert.strictEqual(ftFoldLevel(800, [900, 760, 760, 560]), 1);
  assert.strictEqual(ftFoldLevel(100, []), 0);
});

test('Born: year, year-month or a real date', () => {
  for (const ok of ['', '  ', '1961', '1961-08', '1961-08-04', '2000-02-29', ' 1996-05-14 ']) assert.strictEqual(ftBornError(ok), '', ok);
  for (const bad of ['61', '1961-8', '1961-13', '1961-00', '1961-02-30', '1999-02-29', '1799', '2101', '1961/08/04', 'May 1961']) {
    assert.strictEqual(ftBornError(bad), 'Born needs to look like 1961, 1961-08 or 1961-08-04.', bad);
  }
});

test('Details count: seven rows, empty ones do not count', () => {
  assert.strictEqual(ftDetailCount({}), '· 0 of 7 filled');
  const p = { aliasList: ['Poki'], yearStart: 2013, yearEnd: null, born: '1996', urls: 'https://a.example\n', description: 'x', notes: '' };
  assert.strictEqual(ftDetailCount(p), '· 5 of 7 filled');
  assert.strictEqual(ftDetailCount({ ...p, studios: [{ id: 3, name: 'S' }] }), '· 6 of 7 filled');
  assert.strictEqual(ftDetailFilled({ studios: [] }, 'studio'), false);
  assert.strictEqual(ftDetailFilled(p, 'notes'), false);
  assert.strictEqual(ftDetailFilled({ yearEnd: 2017 }, 'years'), true);
  assert.strictEqual(ftDetailFilled({ urls: '\n' }, 'links'), false);
});

test('Other names: commas or line breaks, trimmed, no blanks or repeats (any case)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'studios.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = /function stReadAliases\(text\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(m, 'stReadAliases in studios.js');
  const ctx = { String, Set };
  vm.createContext(ctx);
  vm.runInContext(`${m[0]}\n;globalThis.__f = stReadAliases;`, ctx);
  const read = (t) => JSON.parse(JSON.stringify(ctx.__f(t)));
  assert.deepStrictEqual(read('Poki, Imane'), ['Poki', 'Imane']);
  assert.deepStrictEqual(read(' Poki ,, imane\nIMANE\r\nPoki Chan , '), ['Poki', 'imane', 'Poki Chan']);
  assert.deepStrictEqual(read(''), []);
  assert.deepStrictEqual(read(null), []);
});
