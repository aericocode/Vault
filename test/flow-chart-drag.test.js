/**
 * Dragging a file's column in the Flow chart to move it:
 *  - the pure parts (player-lib/flow-chart-math.js): the movement threshold
 *    that keeps a click a click, the gap under the pointer, and what a drop
 *    there does (its new place and the id it goes before), moving right and
 *    left, and the preview order;
 *  - flow.js in a vm with a permissive fake page: a drag only starts past
 *    the threshold and only when the grid would take a move (reorderReady),
 *    and the drop goes through the grid's own reorderMove with the same
 *    arguments a grid drag would send; Escape (cancel) moves nothing.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../player-lib/flow-chart-math.js');
const FlowOrder = require('../player-lib/flow-order.js');

/* ── The pure parts ───────────────────────────────────────────────────── */

test('threshold: a few pixels is still a click, past it a drag', () => {
  assert.strictEqual(M.dragPassed(0, 0), false);
  assert.strictEqual(M.dragPassed(3, 3), false, 'about 4.2 px');
  assert.strictEqual(M.dragPassed(M.DRAG_THRESHOLD, 0), true);
  assert.strictEqual(M.dragPassed(0, -6), true, 'any direction');
  assert.strictEqual(M.dragPassed(2, 0, 2), true, 'a threshold of its own');
});

test('slot: the gap nearest the pointer, 0..n, kept inside the chart', () => {
  const g = { L: 40, step: 100, n: 5 };
  assert.strictEqual(M.dragSlot(40, g), 0);
  assert.strictEqual(M.dragSlot(80, g), 0, 'left half of the first column');
  assert.strictEqual(M.dragSlot(95, g), 1, 'right half of the first column');
  assert.strictEqual(M.dragSlot(240, g), 2);
  assert.strictEqual(M.dragSlot(539, g), 5);
  assert.strictEqual(M.dragSlot(-100, g), 0);
  assert.strictEqual(M.dragSlot(5000, g), 5);
  assert.strictEqual(M.dragSlot(NaN, g), 0);
  assert.strictEqual(M.dragSlot(100, { L: 0, step: 10, n: 0 }), 0);
});

test('target: moving right, moving left, to either end, and staying put', () => {
  const order = [10, 20, 30, 40, 50];
  // Right: file 20 (index 1) into the gap before 40 (slot 3) lands at index 2, before 40.
  assert.deepStrictEqual(M.dragTarget(order, 1, 3), { to: 2, before: 40 });
  // Right to the end.
  assert.deepStrictEqual(M.dragTarget(order, 1, 5), { to: 4, before: null });
  // Left: file 40 (index 3) into slot 1 lands at index 1, before 20.
  assert.deepStrictEqual(M.dragTarget(order, 3, 1), { to: 1, before: 20 });
  // Left to the start.
  assert.deepStrictEqual(M.dragTarget(order, 4, 0), { to: 0, before: 10 });
  // The gaps either side of the file itself: no move.
  assert.strictEqual(M.dragTarget(order, 2, 2), null);
  assert.strictEqual(M.dragTarget(order, 2, 3), null);
  // Out-of-range slots are clamped; a bad from is no move.
  assert.deepStrictEqual(M.dragTarget(order, 0, 99), { to: 4, before: null });
  assert.strictEqual(M.dragTarget(order, 9, 0), null);
});

test('the preview order agrees with what reorderMove makes from { before }', () => {
  const order = [1, 2, 3, 4, 5, 6];
  const viaBefore = (id, before) => {
    const rest = order.filter(x => x !== id);
    const at = before == null ? rest.length : rest.indexOf(before);
    return [...rest.slice(0, at), id, ...rest.slice(at)];
  };
  for (let from = 0; from < order.length; from++) {
    for (let slot = 0; slot <= order.length; slot++) {
      const t = M.dragTarget(order, from, slot);
      if (!t) continue;
      const preview = M.movedOrder(order, from, t.to);
      assert.deepStrictEqual(preview, viaBefore(order[from], t.before), `from ${from} slot ${slot}`);
      assert.strictEqual(preview.indexOf(order[from]), t.to);
    }
  }
  assert.deepStrictEqual(order, [1, 2, 3, 4, 5, 6], 'the order itself is untouched');
});

/* ── flow.js: the drag, start to drop ─────────────────────────────────── */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');

/** An element that answers everything flow.js asks of the chart's DOM. */
function fakeEl(over = {}) {
  const el = {
    style: { setProperty() {}, removeProperty() {} }, dataset: {}, hidden: false, innerHTML: '', textContent: '',
    clientWidth: 800, offsetWidth: 200, offsetHeight: 20, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, append() {}, remove() {}, replaceWith() {}, insertAdjacentHTML() {}, focus() {},
    setPointerCapture() {}, releasePointerCapture() {},
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 300, width: 800, height: 300 }),
    matches: () => false,
    ...over,
  };
  return el;
}

function page({ ready = true, flowOrder = false, views = null } = {}) {
  const ids = [11, 12, 13, 14, 15];
  const feats = ids.map((id, i) => ({ id, measured: true, music: true, es: 0.2 + 0.1 * i, em: 0.2 + 0.1 * i, ee: 0.2 + 0.1 * i, bs: 120, bm: 120, be: 120 }));
  const answer = () => ({ shape: 'smooth', edges: 'off', order: ids.slice().reverse(), playlistOrder: ids.slice(), features: feats, targets: null,
    handovers: [], jumps: 0, playlistJumps: 0, counts: { measured: 5, failed: 0, music: 5 }, places: {}, placesOn: false });
  const moves = [];
  const svg = fakeEl();
  const wrap = fakeEl({ querySelector: (q) => (q === 'svg' ? svg : fakeEl()) });
  const panelEl = fakeEl();
  const body = fakeEl();
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  const ctx = {
    console, FlowOrder, FlowChartMath: M,
    activeCollectionId: 3,
    collectionMembers: new Map([[3, ids.slice()]]),
    document: {
      readyState: 'complete', body, activeElement: null,
      getElementById: (id) => (id === 'flowPanel' ? panelEl : id === 'flowChartWrap' ? wrap : null),
      querySelector: (q) => (q === '#flowChartWrap svg' ? svg : views && q.startsWith('#resultsGrid') ? views.tile : null),
      querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    applyFilters: async () => {},
    Library: { indexOf: () => (views ? 2 : -1) },
    revealMediaIndex: (i) => { if (views) views.log.push(`revealMediaIndex ${i}`); },
    dockReveal: (i) => { if (views) views.log.push(`dockReveal ${i}`); },
    reorderReady: () => ready,
    reorderMove: async (moveIds, before) => { moves.push({ ids: moveIds, before }); return true; },
    fetch: async (url) => {
      if (/\/api\/flow\/collections\/\d+\?/.test(url)) return ok(answer());
      return ok({ collection: { total: 5, measurable: 5, measured: 5, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } });
    },
  };
  ctx.window = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  if (views) {
    for (const fn of ['scrollTo', 'scrollBy', 'scroll']) ctx.window[fn] = () => views.log.push(`window.${fn}`);
    ctx.scrollTo = ctx.window.scrollTo; ctx.scrollBy = ctx.window.scrollBy;
  }
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const Flow = ctx.window.Flow;
  const target = { closest: (q) => (q === '#flowChartWrap' ? wrap : null) };
  const geom = () => Flow._state().geom;
  /** clientX at the middle of column i, and at gap s. */
  const colX = (i) => geom().L + (i + 0.5) * geom().step;
  const gapX = (s) => geom().L + s * geom().step;
  const D = Flow._drag;
  const press = (x) => D.down({ button: 0, target, clientX: x, clientY: 100, pointerId: 1 });
  const moveTo = (x, y = 100) => D.move({ pointerId: 1, buttons: 1, clientX: x, clientY: y, preventDefault() {} });
  return { ctx, Flow, D, moves, press, moveTo, colX, gapX, geom, flowOrder };
}

test('a drag right drops through reorderMove with the id it lands before', async () => {
  const p = page();
  await p.Flow.toggle(3);
  assert.ok(p.geom() && p.geom().n === 5, 'the chart was drawn');
  assert.strictEqual(p.D.allowed(), true);
  p.press(p.colX(1));                    // file 12
  p.moveTo(p.colX(1) + 2);               // under the threshold: still a click
  assert.strictEqual(p.D.state().on, false);
  p.moveTo(p.gapX(4) + 3);               // gap 4: before 15
  assert.strictEqual(p.D.state().on, true);
  assert.deepStrictEqual([...p.D.state().preview], [11, 13, 14, 12, 15], 'the chart previews the new order');
  assert.strictEqual(await p.D.drop(), true);
  assert.deepStrictEqual(p.moves.map(m => ({ ids: [...m.ids], before: m.before })), [{ ids: [12], before: 15 }]);
  assert.strictEqual(p.D.state(), null);
});

test('a drag left, and a drag to the very end', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.press(p.colX(3));                    // file 14
  p.moveTo(p.gapX(0) + 2);
  await p.D.drop();
  p.press(p.colX(0));                    // file 11
  p.moveTo(p.gapX(5) - 2);
  await p.D.drop();
  assert.deepStrictEqual(p.moves.map(m => [[...m.ids], m.before]), [[[14], 11], [[11], null]]);
});

test('let go where it already is, under the threshold, or after Escape: nothing moves', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.press(p.colX(2));
  p.moveTo(p.colX(2) + 12);              // past the threshold, still in its own column
  assert.strictEqual(p.D.state().on, true);
  assert.strictEqual(await p.D.drop(), false);
  p.press(p.colX(2));
  p.moveTo(p.colX(2) + 3);
  assert.strictEqual(await p.D.drop(), false, 'a click');
  p.press(p.colX(2));
  p.moveTo(p.gapX(0));
  p.D.cancel();                          // Escape / pointercancel
  assert.strictEqual(p.D.state(), null);
  assert.strictEqual(await p.D.drop(), false);
  assert.deepStrictEqual(p.moves, []);
});

test('a press let go outside the panel never turns a later hover into a drag', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.press(p.colX(1));                    // the pointerup lands outside the panel, unheard
  p.D.move({ pointerId: 1, buttons: 0, clientX: p.gapX(4), clientY: 100, preventDefault() {} });
  assert.strictEqual(p.D.state(), null, 'a hover with no button ends the press');
  assert.strictEqual(await p.D.drop(), false);
  assert.deepStrictEqual(p.moves, []);
});

test('no drag while the grid would not take a move (another sort, a shuffle, a ranked search)', async () => {
  const p = page({ ready: false });
  await p.Flow.toggle(3);
  assert.strictEqual(p.D.allowed(), false);
  p.press(p.colX(1));
  assert.strictEqual(p.D.state(), null);
  p.moveTo(p.gapX(4));
  assert.strictEqual(await p.D.drop(), false);
  assert.deepStrictEqual(p.moves, []);
});

test('Flow order shown: the drag moves in that order through the same reorderMove', async () => {
  const p = page();
  await p.Flow.toggle(3);
  await p.Flow.useFlowOrder();           // the chart shows Flow order: 15 14 13 12 11
  assert.strictEqual(p.D.allowed(), true);
  p.press(p.colX(0));                    // file 15
  p.moveTo(p.gapX(2) + 1);
  await p.D.drop();
  assert.deepStrictEqual(p.moves.map(m => [[...m.ids], m.before]), [[[15], 13]]);
});

test('a drop leaves the view where it was: the list is not scrolled to the file, nothing in it takes focus', async () => {
  const log = [];
  const tile = fakeEl({
    scrollIntoView: () => log.push('tile.scrollIntoView'),
    focus: () => log.push('tile.focus'),
  });
  for (const flowOrder of [false, true]) {
    const p = page({ views: { log, tile } });
    await p.Flow.toggle(3);
    if (flowOrder) await p.Flow.useFlowOrder();
    p.press(p.colX(1));
    p.moveTo(p.gapX(4) + 3);
    assert.strictEqual(await p.D.drop(), true, 'the file moved');
    assert.strictEqual(p.moves.length, 1);
  }
  assert.deepStrictEqual(log, [], 'no scroll, reveal or focus on the drop');
});

test('the marks a table row shows (table-view.js fits the chips around them): Flow order positions, none in playlist order', async () => {
  const p = page();
  await p.Flow.toggle(3);
  assert.strictEqual(p.Flow.marksFor(11), null, 'playlist order, nothing playing: no marks');
  assert.strictEqual(p.Flow.marksKey(11), '');
  await p.Flow.useFlowOrder();           // 15 14 13 12 11 against 11 12 13 14 15
  assert.deepStrictEqual({ ...p.Flow.marksFor(11) }, { pos: '5 · was 1', playing: false, next: false });
  assert.strictEqual(p.Flow.marksFor(13), null, 'the middle file keeps its place');
  assert.strictEqual(p.Flow.marksKey(11), '5 · was 1|');
});
