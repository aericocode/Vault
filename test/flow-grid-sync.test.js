/**
 * The Flow chart and the grid read one order (player-lib/flow.js). The grid
 * is the library query, which applies the search and the filters on top of
 * Flow order, so it can show fewer files than the collection; Next, Previous
 * and Stage walk the grid's list. The chart (its columns, guide, jumps and
 * the tiles' positions) is kept to the files the grid shows.
 *
 * The bug this guards: Place tagged files on, a duration filter hiding the
 * two long Openers, Waves picked. The chart drew every file (MOMMY 2nd,
 * glasses 4th) while the cards had MOMMY 1st and glasses 2nd, and Next from
 * MOMMY went to glasses: three surfaces, two orders.
 *
 * flow.js runs in a vm with a bare page; the library query is played here:
 * applyFilters takes Flow's rankedIds (flowQueryRanked, as filters.js does)
 * or the playlist order, and drops what the filter hides.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FlowOrder = require('../player-lib/flow-order.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');

const IDS = [1, 2, 3, 4, 5, 6, 7, 8];
// 1 and 3 are long (the filter hides them); 1, 2, 3, 4 are Openers.
const PLACES = { 1: 'first', 2: 'first', 3: 'first', 4: 'first' };
const PLAYLIST = [1, 2, 3, 4, 5, 6, 7, 8];
const feats = IDS.map((id) => ({ id, measured: true, music: true, es: 0.2 + (id % 4) * 0.2, em: 0.2 + (id % 3) * 0.3, ee: 0.2 + (id % 5) * 0.15, bs: 120, bm: 120, be: 120 }));

/** The server's Flow order: Openers first when Places is on, the shape decides the rest. */
function serverOrder(shape, places) {
  const o = FlowOrder.planOrder(feats, { shape, places: places ? PLACES : null }).order;
  return o;
}

function page({ hidden = [] } = {}) {
  const listeners = {};
  const store = new Map();
  const hide = new Set(hidden);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const status = { collection: { total: IDS.length, measured: IDS.length, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } };
  const emit = (type) => (listeners[type] || []).forEach(fn => fn({}));
  const Library = {
    spec: null, ids: null,
    indexOf: (id) => (Library.ids ? Array.prototype.indexOf.call(Library.ids, id) : -1),
    idAt: (i) => (Library.ids && i >= 0 && i < Library.ids.length ? Library.ids[i] : undefined),
  };
  const ctx = {
    console,
    FlowOrder,
    Library,
    activeCollectionId: 3,
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    // The library query: Flow's rankedIds when it gives them, else the playlist order; the filter on top.
    applyFilters: async () => {
      const ranked = ctx.flowQueryRanked();
      const order = ranked ? ranked.slice().sort((a, b) => b.score - a.score).map(r => r.id) : PLAYLIST;
      Library.spec = { collectionId: 3, rankedIds: ranked };
      Library.ids = Uint32Array.from(order.filter(id => !hide.has(id)));
      emit('vault:results-changed');
    },
    fetch: async (url) => {
      const m = /\/api\/flow\/collections\/(\d+)\?shape=(\w+)&places=(\d)/.exec(url);
      if (m) {
        const shape = m[2], on = m[3] === '1';
        const order = serverOrder(shape, on);
        const sum = FlowOrder.summary(feats, order);
        return ok({ shape, order, playlistOrder: PLAYLIST, features: feats, targets: FlowOrder.targetsFor(shape, feats),
          handovers: sum.handovers, jumps: sum.jumps, playlistJumps: FlowOrder.summary(feats, PLAYLIST).jumps,
          counts: { measured: IDS.length, failed: 0, music: IDS.length }, places: PLACES, placesOn: on });
      }
      return ok(status);
    },
  };
  ctx.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, Flow: ctx.window.Flow, Library, emit };
}

/** The chart's order, the grid's order and Next from each file all agree. */
function assertOneOrder(p, what) {
  const chart = p.Flow._view.order();
  const grid = Array.from(p.Library.ids);
  assert.deepStrictEqual(chart, grid, `${what}: the chart and the grid show different orders`);
  for (let i = 0; i < grid.length; i++) {
    const next = FlowOrder.nextAfter(grid[i], { indexOf: p.Library.indexOf, idAt: p.Library.idAt });
    assert.strictEqual(next ? next.id : undefined, chart[i + 1], `${what}: Next from ${grid[i]} is not the chart's next`);
  }
  const guide = p.Flow._view.guide();
  if (guide) assert.strictEqual(guide.length, chart.length, `${what}: the guide has a point per column`);
}

for (const hidden of [[], [1, 3]]) {
  const label = hidden.length ? 'a filter hiding two Openers' : 'no filter';
  test(`chart, grid and Next read one order: Places on and off, every shape (${label})`, async () => {
    const p = page({ hidden });
    await p.Flow.toggle(3);
    for (const places of [true, false, true]) {
      await p.Flow.pickPlaces(places);
      assert.strictEqual(p.Flow._state().places, places);
      assertOneOrder(p, `${label}, places ${places} switched`);
      for (const shape of FlowOrder.SHAPES.map(s => s.key)) {
        await p.Flow.pickShape(shape);
        assertOneOrder(p, `${label}, places ${places}, ${shape}`);
      }
    }
  });
}

test('the Waves report: Places on, long Openers filtered out, Waves picked', async () => {
  const p = page({ hidden: [1, 3] });
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  const full = serverOrder('waves', true);
  // The Openers lead the worked-out order; the grid shows 2 and 4 of them.
  assert.deepStrictEqual(full.slice(0, 4).sort(), [1, 2, 3, 4]);
  assertOneOrder(p, 'waves');
  assert.deepStrictEqual(p.Flow._view.order().slice(0, 2), full.filter(id => id === 2 || id === 4));
  // The tiles' positions are positions in the grid: the first tile is 1 (or unmarked).
  const first = p.Flow._view.order()[0];
  const m = p.Flow.marksFor(first);
  assert.ok(!m || !m.pos || m.pos.startsWith('1 '), `the first tile says ${m && m.pos}`);
  assert.match(p.Flow._view.summary(), /2 files hidden by the search or filters/);
});

test('drags in the chart and in the grid keep the chart and the grid on one order (filter on)', async () => {
  const p = page({ hidden: [1, 3] });
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  const grid = Array.from(p.Library.ids);
  // A move the way the grid (or the chart's drop) asks for it: before a shown file.
  await p.Flow.moveInOrder([grid[grid.length - 1]], grid[0]);
  assertOneOrder(p, 'after a move to the top');
  assert.strictEqual(p.Flow._view.order()[0], grid[grid.length - 1]);
  await p.Flow.moveInOrder([grid[1]], null);
  assertOneOrder(p, 'after a move to the end');
  // A refetch (a measuring update) keeps the edited order and the grid together.
  await p.Flow.refetch(true);
  assertOneOrder(p, 'after a refetch');
  // Back to playlist order: the chart draws the playlist order the grid shows.
  await p.Flow.usePlaylistOrder();
  await p.ctx.applyFilters();
  assertOneOrder(p, 'playlist order');
});
