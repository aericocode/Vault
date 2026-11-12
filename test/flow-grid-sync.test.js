/**
 * The Flow chart and the grid read one order (player-lib/flow.js). The grid
 * is the library query, which applies the search and the filters on top of
 * the playlist order (a shape picked rearranges that), so it can show fewer
 * files than the collection; Next, Previous
 * and Stage walk the grid's list. The chart (its columns, guide, jumps and
 * the tiles' positions) is kept to the files the grid shows.
 *
 * The bug this guards: Place tagged files on, a duration filter hiding the
 * two long Openers, Waves picked. The chart drew every file (MOMMY 2nd,
 * glasses 4th) while the cards had MOMMY 1st and glasses 2nd, and Next from
 * MOMMY went to glasses: three surfaces, two orders.
 *
 * flow.js runs in a vm with a bare page; the library query is played here:
 * applyFilters takes the playlist order (POST /api/collections/:id/order
 * changes it) and drops what the filter hides.
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

function page({ hidden = [], filtering = true } = {}) {
  const listeners = {};
  const server = { playlist: PLAYLIST.slice(), writes: 0 };
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
    anyFilterIsSet: () => filtering && hide.size > 0,
    activeCollectionId: 3,
    collectionMembers: new Map([[3, PLAYLIST.slice()]]),
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    // The library query: the playlist order, the filter on top.
    applyFilters: async () => {
      Library.spec = { collectionId: 3, rankedIds: null };
      Library.ids = Uint32Array.from(server.playlist.filter(id => !hide.has(id)));
      emit('vault:results-changed');
    },
    fetch: async (url, opts = {}) => {
      if (/\/api\/collections\/3\/order$/.test(url)) {
        const b = JSON.parse(opts.body);
        server.playlist = b.order.slice();
        server.writes++;
        return ok({ order: server.playlist.slice(), item_count: server.playlist.length });
      }
      const m = /\/api\/flow\/collections\/(\d+)\?shape=(\w+)&places=(\d)/.exec(url);
      if (m) {
        const shape = m[2], on = m[3] === '1';
        const order = serverOrder(shape, on);
        const sum = FlowOrder.summary(feats, order);
        return ok({ shape, order, playlistOrder: server.playlist.slice(), features: feats, targets: FlowOrder.targetsFor(shape, feats),
          handovers: sum.handovers, jumps: sum.jumps, playlistJumps: FlowOrder.summary(feats, server.playlist).jumps,
          counts: { measured: IDS.length, failed: 0, music: IDS.length }, places: PLACES, placesOn: on });
      }
      return ok(status);
    },
  };
  ctx.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, Flow: ctx.window.Flow, Library, emit, server };
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
    await p.ctx.applyFilters();
    for (const places of [true, false, true]) {
      await p.Flow.pickPlaces(places);
      assert.strictEqual(p.Flow._state().places, places);
      assertOneOrder(p, `${label}, places ${places} switched`);
      for (const shape of FlowOrder.SHAPES.map(s => s.key)) {
        await p.Flow.pickShape(shape);
        assert.deepStrictEqual(p.server.playlist, serverOrder(shape, places), `${shape}: written as the playlist order`);
        assert.strictEqual(p.Flow.shape().lit, true);
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

test('a move after a shape: the chart and the grid stay on one order, the shape lets go and never snaps back', async () => {
  const p = page({ hidden: [1, 3] });
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  assert.strictEqual(p.Flow.shape().lit, true);
  // A drag as collection-reorder.js makes it: written, the page's copy, then Flow told.
  const next = p.server.playlist.slice();
  next.push(next.shift());
  p.server.playlist = next;
  p.ctx.collectionMembers.set(3, next.slice());
  await p.ctx.flowMembersChanged(3);
  await p.ctx.applyFilters();
  assertOneOrder(p, 'after a move');
  assert.strictEqual(p.Flow.shape().lit, false, 'no longer the shape');
  assert.strictEqual(p.Flow._view.guide(), null, 'no guide for a shape the playlist is not in');
  const w = p.server.writes;
  await p.Flow.refetch(true);
  assert.strictEqual(p.server.writes, w, 'a measuring update writes nothing');
  assert.deepStrictEqual(p.server.playlist, next);
  assertOneOrder(p, 'after a refetch');
});

test('the lit shape picked again leaves the playlist order as it is (no second rearrange)', async () => {
  const p = page();
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves', 2);
  assert.strictEqual(p.Flow.shape().lit, true);
  const once = p.server.playlist.slice(), w = p.server.writes;
  await p.Flow.pickShape('waves', 2);
  await p.Flow.pickWaves(2);
  assert.strictEqual(p.server.writes, w, 'nothing written');
  assert.deepStrictEqual(p.server.playlist, once);
  assert.strictEqual(p.Flow.shape().lit, true);
  // Another peak count is a new pick.
  await p.Flow.pickWaves(3);
  assert.strictEqual(p.Flow.shape().waves, 3);
  assert.strictEqual(p.Flow.shape().lit, true);
});

test('files the grid never lists (a document, a trashed file) are left off the chart without blaming a filter', async () => {
  const p = page({ hidden: [1, 3], filtering: false });
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  assertOneOrder(p, 'waves');
  assert.doesNotMatch(p.Flow._view.summary(), /hidden/);
});
