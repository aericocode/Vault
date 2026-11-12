/**
 * The Rating filter: picking a star means exactly that star (eq1..eq5), with
 * "N and up" under a line in the same list. The old values '1'..'5' keep
 * meaning "and up", so a saved search made before still returns what it did
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

const ctx = {};
vm.createContext(ctx);
vm.runInContext(`${grab(chips, 'fchipRatingCounts')}\n${grab(chips, 'fchipRatingItems')}
  globalThis.counts = fchipRatingCounts; globalThis.items = fchipRatingItems;`, ctx);

/** The select's options, as db-viewer.html has them. */
function selectOptions() {
  const html = read('db-viewer.html');
  const m = /<select id="filterMinRating">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(m, 'the Rating select is there');
  return [...m[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map(x => ({ value: x[1], label: x[2].trim() }));
}

test('the select offers each star on its own first, then "and up", and keeps every old value', () => {
  const opts = selectOptions();
  const values = opts.map(o => o.value);
  assert.deepStrictEqual(values, ['0', 'unrated', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5', '1', '2', '3', '4', '5']);
  const label = (v) => opts.find(o => o.value === v).label;
  assert.strictEqual(label('eq3'), '★★★ 3');
  assert.strictEqual(label('3'), '★★★ 3 and up', 'an old saved "3" now says what it does');
  assert.strictEqual(label('5'), '★★★★★ 5');
  for (const o of opts) assert.ok(!o.label.includes('—'), 'no em dash');
});

test('the list leaves out the old "5" (the same files as exactly 5) unless it is the one set, and draws a line over "and up"', () => {
  const opts = selectOptions();
  const list = items(opts, 'eq2');
  assert.deepStrictEqual(list.map(o => o.value), ['0', 'unrated', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5', '1', '2', '3', '4']);
  assert.deepStrictEqual(list.filter(o => o.divider).map(o => o.value), ['1']);
  assert.ok(items(opts, '5').some(o => o.value === '5'), 'a saved search on the old 5 still shows as picked');
});

function items(opts, selected) { return JSON.parse(JSON.stringify(ctx.items(opts, selected))); }

test('counts: "and up" as the server sends them, exactly N worked out from them', () => {
  // 2 one-star, 3 two-star, 0 three-star, 4 four-star, 1 five-star.
  const up = { unrated: 7, 1: 10, 2: 8, 3: 5, 4: 5, 5: 1 };
  const c = JSON.parse(JSON.stringify(ctx.counts(17, up)));
  assert.strictEqual(c['0'], 17);
  assert.strictEqual(c.unrated, 7);
  assert.deepStrictEqual([c.eq1, c.eq2, c.eq3, c.eq4, c.eq5], [2, 3, 0, 4, 1]);
  assert.deepStrictEqual([c[1], c[2], c[3], c[4], c[5]], [10, 8, 5, 5, 1]);
  const none = JSON.parse(JSON.stringify(ctx.counts(0, null)));
  assert.strictEqual(none.eq3, 0);
});

test('a saved search keeps the value it stored: capture and restore pass it through untouched', () => {
  const ss = read('player-lib/saved-searches.js');
  assert.match(ss, /filterMinRating: document\.getElementById\('filterMinRating'\)\?\.value \|\| '0'/);
  assert.match(ss, /filterMinRating: state\.filterMinRating \|\| '0'/);
  // ...and the query sends the select's value as it is.
  assert.match(read('player-lib/filters.js'), /minRating: document\.getElementById\('filterMinRating'\)\?\.value \|\| '0'/);
  // The server takes both kinds.
  const q = read('lib/library-query.js');
  assert.match(q, /\['0', 'unrated', '1', '2', '3', '4', '5', 'eq1', 'eq2', 'eq3', 'eq4', 'eq5'\]/);
});

test('the popover and the rail draw the line', () => {
  assert.match(read('player-lib/filter-popover.js'), /it\.divider && !q \? ' fpop-opt-divider' : ''/);
  assert.match(read('player-lib/filter-rail.js'), /it\.divider \? ' rail-opt-divider' : ''/);
});
