/**
 * The "Same person?" strip shows exactly one row of pair cards
 * (player-lib/faces-tab.js ftStripFit, run in a VM): as many as fit the
 * strip's width, never a partial card, and when there are more pairs than
 * fit, the last slot is "N more · Review all".
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
    escapeHtml: (s) => String(s),
    debounce: (f) => f,
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'faces-tab.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__x = { ${names.join(', ')} };`, ctx);
  return ctx.__x;
}

const { ftStripFit } = load(['ftStripFit']);
const fit = (o) => ({ ...ftStripFit(o) });   // a plain object of this realm

// A compact card is 214 px wide (two 96 px faces, a 4 px gap, 8 px padding, borders), 12 px apart; the slot is 104 px.
const CARD = 214, GAP = 12, MORE = 104;
const used = (r) => r.show * CARD + Math.max(0, r.show - 1) * GAP + (r.more ? GAP + MORE : 0);

test('more pairs than fit: the cards that fit plus the "N more" slot, never past the width', () => {
  for (const width of [900, 1000, 1180, 1340, 1820, 2460, 3000]) {
    const r = fit({ width, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 });
    assert.strictEqual(r.more, true, `${width}: N more`);
    assert.ok(used(r) <= width, `${width}: ${used(r)} px fits`);
    assert.ok(used({ show: r.show + 1, more: true }) > width || r.show === 16, `${width}: one more card would not fit`);
  }
});

test('the counts at common window widths', () => {
  // The strip's inner width at a 1280 / 1440 / 1920 / 2560 px window is about 1180 / 1340 / 1820 / 2460 px.
  assert.deepStrictEqual(fit({ width: 1180, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 }), { show: 4, more: true });
  assert.deepStrictEqual(fit({ width: 1340, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 }), { show: 5, more: true });
  assert.deepStrictEqual(fit({ width: 1820, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 }), { show: 7, more: true });
  assert.deepStrictEqual(fit({ width: 2460, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 }), { show: 10, more: true });
});

test('every pair fits: all of them and no slot, even when the slot would not have fitted beside them', () => {
  assert.deepStrictEqual(fit({ width: 1180, card: CARD, gap: GAP, more: MORE, count: 3, total: 3 }), { show: 3, more: false });
  // 5 cards take exactly 1118 px: they fit; 5 cards and the slot would not.
  assert.deepStrictEqual(fit({ width: 1118, card: CARD, gap: GAP, more: MORE, count: 5, total: 5 }), { show: 5, more: false });
  assert.deepStrictEqual(fit({ width: 1117, card: CARD, gap: GAP, more: MORE, count: 5, total: 5 }), { show: 4, more: true });
});

test('fewer loaded than fit but more in all: every loaded card, then the slot', () => {
  assert.deepStrictEqual(fit({ width: 3000, card: CARD, gap: GAP, more: MORE, count: 8, total: 40 }), { show: 8, more: true });
});

test('narrow: at least one card; alone when the slot has no room beside it', () => {
  assert.deepStrictEqual(fit({ width: 329, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 }), { show: 1, more: false });
  assert.deepStrictEqual(fit({ width: 340, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 }), { show: 1, more: true });
  assert.deepStrictEqual(fit({ width: 200, card: CARD, gap: GAP, more: MORE, count: 16, total: 34 }), { show: 1, more: false });
});

test('nothing to show, or nothing measured yet', () => {
  assert.deepStrictEqual(fit({ width: 1200, card: CARD, gap: GAP, more: MORE, count: 0, total: 0 }), { show: 0, more: false });
  assert.deepStrictEqual(fit({ width: 0, card: CARD, gap: GAP, more: MORE, count: 4, total: 9 }), { show: 1, more: false });
  assert.deepStrictEqual(fit({ width: 1200, card: 0, gap: GAP, more: MORE, count: 4, total: 9 }), { show: 1, more: false });
});
