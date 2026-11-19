/**
 * The library grid's hover popover (player-lib/cards.js) stays out of the way
 * of selecting: it sits beside the hovered tile, over the next tile's tick
 * box, so it does not open while files are ticked, while Shift or Ctrl/Cmd is
 * held, or over the tick box itself; a selection change closes it
 * (selection.js selectionChanged). Hover-scrub keeps running in every case.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'player-lib', f), 'utf8');

/** cards.js in a sandbox with a fake #resultsGrid that records its listeners. */
function loadCards() {
  const noop = () => {};
  const listeners = {};
  const grid = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  const timers = [];
  const ctx = {
    console,
    document: {
      getElementById: (id) => (id === 'resultsGrid' ? grid : null),
      addEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
      createElement: () => ({}),
    },
    addEventListener: noop,
    localStorage: { getItem: () => null, setItem: noop },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: noop,
    setInterval: () => 1,
    clearInterval: noop,
    staticThumbSrc: () => 'static.jpg',
    scrubUrl: () => 'scrub.jpg',
    getMediaById: (id) => ({ id, media_type: 'video', duration_seconds: 60, filename: 'a.mp4' }),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('cards.js'), ctx);
  return { ctx, listeners, timers };
}

/** A tile with a tick box; `onCheckbox` makes the event's target the tick box. */
function hover(listeners, { id = 7, onCheckbox = false, shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
  const img = { isConnected: true };
  const tile = {
    dataset: { id: String(id) },
    classList: { contains: () => false },
    querySelector: (sel) => (sel === '.tile-img' ? img : null),
    isConnected: true,
  };
  const target = {
    closest: (sel) => (sel === '.media-tile' ? tile : sel === '.tile-select' ? (onCheckbox ? {} : null) : null),
  };
  listeners.mouseover({ target, shiftKey, ctrlKey, metaKey });
}

test('shouldShowTilePopover: only a plain hover with nothing selected opens it', () => {
  const { ctx } = loadCards();
  const show = (o) => vm.runInContext(`shouldShowTilePopover(${JSON.stringify(o)})`, ctx);
  assert.strictEqual(show({}), true);
  assert.strictEqual(show({ selectedCount: 0 }), true);
  assert.strictEqual(show({ selectedCount: 1 }), false);
  assert.strictEqual(show({ shiftKey: true }), false);
  assert.strictEqual(show({ ctrlKey: true }), false);
  assert.strictEqual(show({ metaKey: true }), false);
  assert.strictEqual(show({ overCheckbox: true }), false);
});

test('grid hover: popover timer only for a plain hover, scrub in every case', () => {
  const { ctx, listeners, timers } = loadCards();
  const scrubId = () => vm.runInContext('_scrub.id', ctx);
  const reset = () => { timers.length = 0; vm.runInContext('stopScrub(); _popoverForId = null;', ctx); };

  // Plain hover, nothing selected: the popover is on its way.
  reset();
  hover(listeners);
  assert.strictEqual(timers.length, 1, 'popover timer started');
  assert.strictEqual(scrubId(), 7, 'scrub started');

  for (const mod of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { onCheckbox: true }]) {
    reset();
    hover(listeners, mod);
    assert.strictEqual(timers.length, 0, `no popover timer with ${JSON.stringify(mod)}`);
    assert.strictEqual(scrubId(), 7, `scrub still starts with ${JSON.stringify(mod)}`);
  }

  // Files ticked (selection.js's selectedIds): no popover until cleared.
  vm.runInContext('var selectedIds = new Set([3]);', ctx);
  reset();
  hover(listeners);
  assert.strictEqual(timers.length, 0, 'no popover while files are selected');
  assert.strictEqual(scrubId(), 7, 'scrub still starts while files are selected');

  vm.runInContext('selectedIds.clear();', ctx);
  reset();
  hover(listeners);
  assert.strictEqual(timers.length, 1, 'popover works again once the selection is cleared');
});

test('a selection change closes the popover (selection.js)', () => {
  const src = read('selection.js');
  const fn = src.slice(src.indexOf('function selectionChanged()'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.match(body, /hideTilePopover\(\)/, 'selectionChanged hides the popover');
  // Every selection path goes through selectionChanged.
  for (const name of ['onTileSelect', 'toggleSelectPage', 'toggleSelectAllFiltered', 'clearSelection']) {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} exists`);
    const rest = src.slice(at);
    const end = rest.indexOf('\n}');
    assert.match(rest.slice(0, end), /selectionChanged\(\)/, `${name} calls selectionChanged`);
  }
});
