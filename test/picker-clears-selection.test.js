/**
 * Add to collection from the selection bar: once the picker closes after an
 * add went through, the ticked files are cleared (player-lib/collections.js
 * _pickerRun). The picker stays open while it is used (several collections
 * can be ticked, a misclick unticked); a press on another selection bar
 * button closes it but keeps the ticks for that button; a picker opened for
 * one file (a tile, the details) never touches the selection.
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

/** The picker's open / toggle / close, with the page around it faked. */
function page({ fromBar = true, serverOk = true } = {}) {
  const cleared = [];
  const removed = [];
  const ctx = {
    selectedIds: new Set([11, 12]),
    clearSelection() { cleared.push(true); ctx.selectedIds.clear(); },
    collections: new Map([[1, { id: 1, name: 'A' }], [2, { id: 2, name: 'B' }]]),
    members: new Map([[1, []], [2, []]]),
    serverOk,
    pending: [],
    removed,
    console, setImmediate,
  };
  ctx.document = {
    getElementById: (id) => (id === 'collectionPicker' ? { remove: () => removed.push(id) } : null),
    removeEventListener() {},
  };
  vm.createContext(ctx);
  vm.runInContext(`
    let _pickerIds = [11, 12];
    let _pickerFromBar = ${fromBar};
    let _pickerFromBarWas = false;
    let _pickerFit = null;
    let _pickerRun = { fromBar: ${fromBar}, added: new Set(), closed: false, keep: false };
    function _pickerOutside() {}
    function _pickerEsc() {}
    const getCollectionById = (id) => collections.get(id);
    function _collectionState(c) { return members.get(c.id).length ? 'all' : 'none'; }
    // The request: resolves when the test says the server answered.
    function changeCollectionMembership(id, ids, adding) {
      return new Promise((resolve) => pending.push(() => {
        if (serverOk) members.set(id, adding ? ids.slice() : []);
        resolve(serverOk);
      }));
    }
    ${grab('pickerRunClears')}
    ${grab('pickerRunFinish')}
    ${grab('closeCollectionPicker')}
    ${grab('togglePickerCollection')}
    globalThis.toggle = (id) => togglePickerCollection(id);
    globalThis.close = (opts) => closeCollectionPicker(opts);
    globalThis.answer = async () => { const fns = pending.splice(0); fns.forEach(f => f()); await new Promise(r => setImmediate(r)); };
  `, ctx);
  return { ctx, cleared };
}

test('an add from the selection bar: the ticks stay while the picker is open, and clear when it closes', async () => {
  const { ctx, cleared } = page();
  const t = ctx.toggle(1);
  await ctx.answer(); await t;
  assert.deepStrictEqual(cleared, [], 'still open: more collections can be ticked');
  assert.strictEqual(ctx.selectedIds.size, 2);
  ctx.close();
  assert.deepStrictEqual(cleared, [true], 'closed after an add: cleared once');
  assert.strictEqual(ctx.selectedIds.size, 0);
});

test('closing with no add, or after the add was unticked again, keeps the ticks', async () => {
  let { ctx, cleared } = page();
  ctx.close();
  assert.deepStrictEqual(cleared, [], 'nothing added');

  ({ ctx, cleared } = page());
  let t = ctx.toggle(1); await ctx.answer(); await t;      // add
  t = ctx.toggle(1); await ctx.answer(); await t;          // misclick: taken out again
  ctx.close();
  assert.deepStrictEqual(cleared, [], 'the only add was undone');
});

test('a failed add does not count', async () => {
  const { ctx, cleared } = page({ serverOk: false });
  const t = ctx.toggle(2); await ctx.answer(); await t;
  ctx.close();
  assert.deepStrictEqual(cleared, []);
});

test('another selection bar button closing the picker keeps the ticks for that button', async () => {
  const { ctx, cleared } = page();
  const t = ctx.toggle(1); await ctx.answer(); await t;
  ctx.close({ keepSelection: true });
  assert.deepStrictEqual(cleared, []);
  assert.strictEqual(ctx.selectedIds.size, 2);
});

test('closed while the add was on its way: the ticks clear when it lands', async () => {
  const { ctx, cleared } = page();
  const t = ctx.toggle(1);
  ctx.close();
  assert.deepStrictEqual(cleared, [], 'not added yet');
  await ctx.answer(); await t;
  assert.deepStrictEqual(cleared, [true]);
});

test('a picker for one file (not from the selection bar) never clears the selection', async () => {
  const { ctx, cleared } = page({ fromBar: false });
  const t = ctx.toggle(1); await ctx.answer(); await t;
  ctx.close();
  assert.deepStrictEqual(cleared, []);
});

test('the selection bar keeps the ticks for its own buttons', () => {
  const sel = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'selection.js'), 'utf8');
  assert.match(sel, /closeCollectionPicker\(\{ keepSelection: true \}\)/);
  assert.match(src, /closeCollectionPicker\(\{ keepSelection: !!e\.target\.closest\('#selectionBar'\) \}\)/,
    'a press on the bar (outside the picker) keeps them too');
});
