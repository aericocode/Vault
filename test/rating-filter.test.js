/**
 * The Rating filter: each star is a row of its own and any number can be
 * on at once (4 and 5 on: files rated 4 or 5). There are no "and up" rows.
 * The value is the picks joined by commas ('eq4,eq5'), or '0' for any.
 * Searches saved when '1'..'5' meant "that star and up" come back as the
 * same stars picked, and the server still honours the old values as sent
 * (player-lib/filter-chips.js, db-viewer.html #filterMinRating,
 * lib/library-query.js; the query itself is in test/library-query.test.js).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const chips = read('player-lib/filter-chips.js');

function grab(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  let depth = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

const choices = /const RATING_CHOICES = \[[\s\S]*?\];/.exec(chips);
assert.ok(choices, 'RATING_CHOICES is there');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${choices[0]}
  ${grab(chips, 'ratingPicks')}
  ${grab(chips, 'ratingValue')}
  ${grab(chips, 'ratingNormalize')}
  ${grab(chips, 'ratingToggle')}
  ${grab(chips, 'ratingLabel')}
  ${grab(chips, 'fchipRatingCounts')}
  globalThis.api = { RATING_CHOICES, ratingPicks, ratingValue, ratingNormalize, ratingToggle, ratingLabel, fchipRatingCounts };`, ctx);
const api = ctx.api;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('the list is Unrated and each star on its own: no "and up" rows', () => {
  assert.deepStrictEqual(plain(api.RATING_CHOICES).map(c => c.value), ['unrated', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5']);
  assert.deepStrictEqual(plain(api.RATING_CHOICES).map(c => c.label), ['Unrated', '★ 1', '★★ 2', '★★★ 3', '★★★★ 4', '★★★★★ 5']);
  for (const src of [chips, read('db-viewer.html'), read('player-lib/filter-rail.js'), read('player-lib/filter-popover.js')]) {
    assert.ok(!/and up</.test(src) && !/'[1-5]' *: *'.* and up'/.test(src), 'no "and up" row anywhere');
    assert.ok(!src.includes('divider: true') && !src.includes('fpop-opt-divider') && !src.includes('rail-opt-divider'), 'no divider');
  }
  for (const f of ['css/filter-chips.css', 'css/filter-rail.css']) assert.ok(!read(f).includes('-divider'), `${f}: no divider`);
  // A hidden value now, not a list: several can be on.
  assert.match(read('db-viewer.html'), /<input type="hidden" id="filterMinRating" value="0"/);
  assert.ok(!/<select id="filterMinRating"/.test(read('db-viewer.html')));
});

test('clicking stars turns each on or off; several on at once; Any is none on', () => {
  let v = '0';
  v = api.ratingToggle(v, 'eq5'); assert.strictEqual(v, 'eq5');
  v = api.ratingToggle(v, 'eq4'); assert.strictEqual(v, 'eq4,eq5', '"4 and up" in two clicks');
  v = api.ratingToggle(v, 'unrated'); assert.strictEqual(v, 'unrated,eq4,eq5', 'kept in list order');
  v = api.ratingToggle(v, 'eq4'); assert.strictEqual(v, 'unrated,eq5', 'a second click turns it off');
  v = api.ratingToggle(api.ratingToggle(v, 'unrated'), 'eq5'); assert.strictEqual(v, '0', 'all off is any rating');
  // All six on is every file: the same as Any.
  let all = '0';
  for (const c of ['unrated', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5']) all = api.ratingToggle(all, c);
  assert.strictEqual(all, '0');
});

test('old "and up" values come back as the same stars picked', () => {
  assert.strictEqual(api.ratingNormalize('3'), 'eq3,eq4,eq5');
  assert.strictEqual(api.ratingNormalize('1'), 'eq1,eq2,eq3,eq4,eq5', '"1 and up" is every rated file');
  assert.strictEqual(api.ratingNormalize('4'), 'eq4,eq5');
  assert.strictEqual(api.ratingNormalize('5'), 'eq5');
  // Values from before that already mean one thing are kept.
  for (const v of ['0', 'unrated', 'eq1', 'eq3', 'eq4,eq5']) assert.strictEqual(api.ratingNormalize(v), v);
  assert.strictEqual(api.ratingNormalize(''), '0');
  assert.strictEqual(api.ratingNormalize(undefined), '0');
  assert.strictEqual(api.ratingNormalize('eq5,eq4'), 'eq4,eq5');
  assert.strictEqual(api.ratingNormalize('bogus'), '0');
  // ...and an old one can be changed star by star.
  assert.strictEqual(api.ratingToggle('3', 'eq3'), 'eq4,eq5');
});

test('the chip says what is picked, in plain words', () => {
  assert.strictEqual(api.ratingLabel('eq3'), '★★★ 3');
  assert.strictEqual(api.ratingLabel('unrated'), 'Unrated');
  assert.strictEqual(api.ratingLabel('eq4,eq5'), '4 or 5 stars');
  assert.strictEqual(api.ratingLabel('3'), '3, 4 or 5 stars', 'an old "3 and up"');
  assert.strictEqual(api.ratingLabel('unrated,eq1'), 'Unrated or 1 star');
  assert.strictEqual(api.ratingLabel('unrated,eq2,eq3'), 'Unrated, 2 or 3 stars');
  assert.strictEqual(api.ratingLabel('0'), 'Any');
  for (const v of ['eq4,eq5', 'unrated,eq1', '1']) assert.ok(!api.ratingLabel(v).includes('—'), 'no em dash');
});

test('counts: exactly N worked out from the server\'s "and up" counts', () => {
  // 2 one-star, 3 two-star, 0 three-star, 4 four-star, 1 five-star.
  const up = { unrated: 7, 1: 10, 2: 8, 3: 5, 4: 5, 5: 1 };
  const c = plain(api.fchipRatingCounts(17, up));
  assert.strictEqual(c['0'], 17);
  assert.strictEqual(c.unrated, 7);
  assert.deepStrictEqual([c.eq1, c.eq2, c.eq3, c.eq4, c.eq5], [2, 3, 0, 4, 1]);
  assert.strictEqual(plain(api.fchipRatingCounts(0, null)).eq3, 0);
});

test('saved searches: capture stores the value as it is, restore turns an old one into stars', () => {
  const ss = read('player-lib/saved-searches.js');
  assert.match(ss, /filterMinRating: document\.getElementById\('filterMinRating'\)\?\.value \|\| '0'/);
  assert.match(grab(ss, 'restoreFilterControls'), /ratingNormalize\(v\)/);
  // ...and the query sends the value as it is.
  assert.match(read('player-lib/filters.js'), /minRating: document\.getElementById\('filterMinRating'\)\?\.value \|\| '0'/);
});

test('the popover and the rail let several stars be on, and Any clears them', () => {
  const pop = read('player-lib/filter-popover.js');
  assert.match(pop, /aria-multiselectable="true"/);
  assert.match(grab(chips, 'openChipPopover'), /multi: \{ clearValue: d\.def, selected: picked \}/);
  assert.match(grab(read('player-lib/filter-rail.js'), 'railPick'), /ratingToggle\(fchipValue\(key\), value\)/);
  // The popover marks every picked row.
  const c2 = {};
  vm.createContext(c2);
  vm.runInContext(`${grab(pop, '_fpopIsSelected')} globalThis.f = _fpopIsSelected;`, c2);
  assert.strictEqual(c2.f('eq4', ['eq4', 'eq5']), true);
  assert.strictEqual(c2.f('eq3', ['eq4', 'eq5']), false);
  assert.strictEqual(c2.f('eq3', 'eq3'), true);
});
