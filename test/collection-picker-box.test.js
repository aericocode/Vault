/**
 * Add to collection: one box at the top finds a collection or names a new
 * one (player-lib/collections.js). Typed text that is no collection's name
 * is offered as "New collection" in the list; New collection / New folder
 * turn the same box into the name, starting from what was typed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'collections.js'), 'utf8');

/** One top-level function of a browser script, by its name. */
function grab(name) {
  let at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let depth = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

function picker(filter, naming = null) {
  const calls = [];
  const ctx = {
    collectionsList: [
      { id: 1, name: 'Waves', kind: 'collection' },
      { id: 2, name: 'Wave mix', kind: 'collection' },
      { id: 3, name: 'Night', kind: 'collection' },
      { id: 4, name: 'Wavy', kind: 'folder' },
    ],
    ICON: { plus: '+' },
    escapeHtml: (s) => String(s).replace(/</g, '&lt;'),
    pickerCollRow: (c) => `[${c.name}]`,
    togglePickerCollection: (id) => calls.push(['toggle', id]),
    pickerCreateNamed: (kind) => calls.push(['create', kind]),
    _pickerSetNaming: (kind) => calls.push(['naming', kind]),
    calls,
  };
  vm.createContext(ctx);
  vm.runInContext(`let _pickerFilter = ${JSON.stringify(filter)}; let _pickerNaming = ${JSON.stringify(naming)};
    ${grab('_pickerMatches')}\n${grab('_pickerExact')}\n${grab('buildPickerRows')}\n${grab('onPickerFilterKey')}
    globalThis.rows = buildPickerRows;
    globalThis.key = (k) => { const e = { key: k, preventDefault() {}, stopPropagation() {} }; onPickerFilterKey(e); };`, ctx);
  return ctx;
}

test('typed text that is no collection yet shows the matches, then New collection with that text', () => {
  const p = picker('wav');
  const html = p.rows();
  assert.ok(html.startsWith('[Waves][Wave mix]'), 'matches first, folders left out');
  assert.match(html, /New collection “wav”/);
  assert.ok(!picker('waves').rows().includes('New collection'), 'an exact name (any case) is not offered again');
  assert.match(picker('Neon').rows(), /^<div class="coll-picker-row coll-picker-newrow"/, 'no match: only the new one');
});

test('Enter: an exact name or the only match is ticked, no match makes the collection, several do nothing', () => {
  let p = picker('WAVES'); p.key('Enter');
  assert.deepStrictEqual(p.calls, [['toggle', 1]]);
  p = picker('nig'); p.key('Enter');
  assert.deepStrictEqual(p.calls, [['toggle', 3]]);
  p = picker('Neon'); p.key('Enter');
  assert.deepStrictEqual(p.calls, [['create', 'collection']]);
  p = picker('wav'); p.key('Enter');
  assert.deepStrictEqual(p.calls, []);
  p = picker(''); p.key('Enter');
  assert.deepStrictEqual(p.calls, []);
});

test('naming in the same box: Enter makes it with the typed text, Esc goes back to finding', () => {
  let p = picker('wav', 'collection');
  assert.match(p.rows(), /Enter makes the collection “wav” with these files\. Esc goes back\./);
  p.key('Enter');
  assert.deepStrictEqual(p.calls, [['create', 'collection']]);
  p = picker('', 'folder');
  assert.match(p.rows(), /Type a name for the new folder\./);
  p.key('Escape');
  assert.deepStrictEqual(p.calls, [['naming', null]]);
});

test('the picker has one text box: New collection / New folder no longer open a second one', () => {
  const html = grab('buildPickerHtml');
  assert.strictEqual((html.match(/<input/g) || []).length, 1);
  assert.ok(!/createElement\('input'\)/.test(grab('pickerCreate')));
  assert.ok(!src.includes('Filter collections'));
  assert.ok(!grab('buildPickerRows').includes('—') && !grab('_pickerSetNaming').includes('—'), 'no em dashes');
});
