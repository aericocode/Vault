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
const { flowCustomFake } = require('./helpers/flow-custom-fake');

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

/** The server's side: the playlist order and what it keeps for Custom. Shared by two pages = a reload. */
const newServer = () => ({ playlist: PLAYLIST.slice(), writes: 0, bodies: [], custom: flowCustomFake(3), fail: null });

/** The order route: POST /api/collections/3/order as server/index.js answers it. */
function postOrder(server, b) {
  server.bodies.push(b);
  let r;
  try { r = server.custom.post(server.playlist.slice(), b); } catch (err) { return { status: err.code === 'STALE' ? 409 : 400, body: { error: err.message, code: err.code } }; }
  server.playlist = r.order.slice();
  server.writes++;
  return { status: 200, body: { order: r.order.slice(), item_count: r.order.length, flow_custom: r.flow_custom, flow_custom_was: r.flow_custom_was } };
}

function page({ hidden = [], filtering = true, server = newServer(), store = new Map() } = {}) {
  const listeners = {};
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
    collectionMembers: new Map([[3, server.playlist.slice()]]),
    // collections.js: the files and their order read again from the server.
    fetchCollectionMembers: async (id) => { ctx.collectionMembers.set(id, server.playlist.slice()); return ctx.collectionMembers.get(id); },
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
        if (server.fail) return { ok: false, status: server.fail, json: async () => ({ error: 'the disk is full' }) };
        const r = postOrder(server, JSON.parse(opts.body));
        if (r.status !== 200) return { ok: false, status: r.status, json: async () => r.body };
        // Kept on the server, the answer lost on the way.
        if (server.loseAnswer) { server.loseAnswer = false; return { ok: false, status: 502, json: async () => ({ error: 'the answer was lost' }) }; }
        return ok(r.body);
      }
      if (/\/api\/flow\/collections\/3\/custom$/.test(url)) return ok({ custom: server.custom.state(server.playlist) });
      const m = /\/api\/flow\/collections\/(\d+)\?shape=(\w+)&places=(\d)/.exec(url);
      if (m) {
        const shape = m[2], on = m[3] === '1';
        const order = serverOrder(shape, on);
        const sum = FlowOrder.summary(feats, order);
        return ok({ shape, order, playlistOrder: server.playlist.slice(), features: feats, targets: FlowOrder.targetsFor(shape, feats),
          handovers: sum.handovers, jumps: sum.jumps, playlistJumps: FlowOrder.summary(feats, server.playlist).jumps,
          counts: { measured: IDS.length, failed: 0, music: IDS.length }, places: PLACES, placesOn: on,
          custom: server.custom.state(server.playlist) });
      }
      return ok(status);
    },
  };
  const undos = [], toasts = [];
  ctx.showUndoToast = (m, fn) => undos.push({ m, fn });
  ctx.showToast = (m) => toasts.push(String(m));
  ctx.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, Flow: ctx.window.Flow, Library, emit, server, store, undos, toasts };
}

/** Files come or go (added, taken out, an import placing them): the server, the page's copy, then Flow told; no order write. */
async function members(p, list) {
  p.server.playlist = list.slice();
  p.ctx.collectionMembers.set(3, list.slice());
  await p.ctx.flowMembersChanged(3);
  await p.ctx.applyFilters();
}

/**
 * An order write from outside flow.js, as collection-reorder.js _installOrder
 * takes it: the answer (which lights Custom or a shape), the page's copy,
 * then Flow told. flow: what the caller says (a drag: { manual: true }; its
 * Undo: flowUndoOf(the drag's answer); Remove's Undo, an older Vault: none).
 * told: false for another window or client (this page hears nothing).
 */
async function orderWrite(p, list, flow, { told = true } = {}) {
  const r = postOrder(p.server, flow === undefined ? { order: list.slice() } : { order: list.slice(), flow });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  if (!told) return r.body;
  p.ctx.collectionMembers.set(3, r.body.order.slice());
  p.ctx.flowCustomAnswer(3, r.body);
  await p.ctx.flowMembersChanged(3);
  await p.ctx.applyFilters();
  return r.body;
}

/** A drag (or Alt+arrows): a hand reorder. @returns its Undo (collection-reorder.js reorderUndo). */
async function dragTo(p, list) {
  const prev = p.server.playlist.slice();
  const answer = await orderWrite(p, list, { manual: true });
  const flow = p.ctx.flowUndoOf(answer);
  return () => orderWrite(p, prev, flow);
}

/** What the panel lights: 'custom', a shape, or 'none' (a shape changed by hand: neither). */
const panel = (p) => { const s = p.Flow.shape(); return s.custom ? 'custom' : (s.lit ? s.shape : 'none'); };
const row = (p) => p.server.custom.state(p.server.playlist);

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


test('a move after a shape: the chart and the grid stay on one order, nothing is lit and the shape never snaps back', async () => {
  const p = page({ hidden: [1, 3] });
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  assert.strictEqual(p.Flow.shape().lit, true);
  const next = p.server.playlist.slice();
  next.push(next.shift());
  await dragTo(p, next);
  assertOneOrder(p, 'after a move');
  assert.strictEqual(p.Flow.shape().lit, false, 'no longer the shape');
  assert.strictEqual(panel(p), 'none', 'nor the kept order: Custom is not lit');
  assert.strictEqual(p.Flow._view.guide(), null, 'no guide for a shape the playlist is not in');
  const w = p.server.writes;
  await p.Flow.refetch(true);
  assert.strictEqual(p.server.writes, w, 'a measuring update writes nothing');
  assert.deepStrictEqual(p.server.playlist, next);
  assertOneOrder(p, 'after a refetch');
});

/* ── Custom: the user's own order, kept while a shape is in (lib/flow/custom.js) ── */

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };

const MINE = [8, 1, 7, 2, 6, 3, 5, 4];

/** Custom lit, MINE the playlist, and nothing kept yet (a hand order on a collection never shaped). */
async function mine() {
  const p = page();
  await p.Flow.toggle(3);
  await dragTo(p, MINE);
  assert.strictEqual(row(p), null, 'a hand order with nothing kept keeps nothing');
  return p;
}

test('Custom is lit on a collection never shaped, and exactly one of Custom and the shapes is lit', async () => {
  const p = page();
  await p.Flow.toggle(3);
  assert.strictEqual(panel(p), 'custom');
  for (const shape of FlowOrder.SHAPES.map(s => s.key)) {
    await p.Flow.pickShape(shape);
    assert.strictEqual(panel(p), shape);
    assert.strictEqual(p.Flow.shape().custom, false);
  }
});

test('Custom, Waves, Peak, then Custom: the order from before the first shape comes back; each Undo puts back the order and the row exactly', async () => {
  const p = await mine();
  await p.Flow.pickShape('waves');
  assert.deepStrictEqual(p.server.bodies.at(-1).flow, { shape: 'waves', waves: 2, places: true });
  const waves = p.server.playlist.slice();
  const rowWaves = row(p);
  assert.strictEqual(rowWaves.mode, 'shape');
  assert.deepStrictEqual(rowWaves.kept, MINE, 'kept on the server');
  await p.Flow.pickShape('peak');
  const peak = p.server.playlist.slice();
  const rowPeak = row(p);
  assert.deepStrictEqual(rowPeak.kept, MINE, 'shape to shape keeps it');
  assert.strictEqual(panel(p), 'peak');
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.bodies.at(-1), { flow: { custom: true } }, 'Custom sends no order: the server writes the kept one');
  assert.deepStrictEqual(p.server.playlist, MINE);
  assert.strictEqual(panel(p), 'custom');
  assert.strictEqual(row(p).mode, 'custom');
  assert.deepStrictEqual(row(p).kept, MINE, 'the kept order stays in the row');
  assert.match(p.undos.at(-1).m, /Back to your custom order/);
  // Custom again while it is lit: nothing.
  const w = p.server.writes;
  assert.strictEqual(await p.Flow.pickCustom(), false);
  assert.strictEqual(p.server.writes, w);
  // Undo Custom: Peak again, lit, the row exactly as it was.
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(p.server.playlist, peak);
  assert.strictEqual(panel(p), 'peak');
  assert.deepStrictEqual(row(p), rowPeak);
  // Undo Peak: Waves, lit, the row exactly as it was.
  await p.undos.at(-2).fn();
  assert.deepStrictEqual(p.server.playlist, waves);
  assert.strictEqual(panel(p), 'waves');
  assert.deepStrictEqual(row(p), rowWaves);
  // Undo Waves: MINE, Custom lit, no row (there was none).
  await p.undos.at(-3).fn();
  assert.deepStrictEqual(p.server.playlist, MINE);
  assert.deepStrictEqual(p.server.bodies.at(-1).flow, { restore: null, rev: rowWaves.rev });
  assert.strictEqual(panel(p), 'custom');
  assert.strictEqual(row(p), null);
});

test('the checker\'s repro: Peak lit, a file taken out and added again (at the end): Peak stays lit, Custom gives MINE with the file in its kept place', async () => {
  const p = await mine();
  await p.Flow.pickShape('peak');
  const shaped = p.server.playlist.slice();
  await members(p, shaped.filter(id => id !== 5));
  assert.strictEqual(panel(p), 'peak');
  await members(p, shaped.filter(id => id !== 5).concat(5));
  assert.strictEqual(panel(p), 'peak', 'still Peak: nothing is compared');
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.playlist, MINE, 'file 5 back in its kept place');
});

test('no relighting by coincidence: a drag back by hand to the shaped order stays edited (nothing lit), and Custom brings the kept order back', async () => {
  const p = await mine();
  await p.Flow.pickShape('smooth');
  const shaped = p.server.playlist.slice();
  await dragTo(p, shaped.slice(1).concat(shaped[0]));
  assert.strictEqual(panel(p), 'none');
  await dragTo(p, shaped);
  assert.deepStrictEqual(p.server.playlist, shaped);
  assert.strictEqual(panel(p), 'none', 'the shaped order by hand is a hand order');
  assert.deepStrictEqual(row(p).kept, MINE, 'the kept order is still there');
  // The next shape pick keeps it (the order was a shape changed by hand, not the user's own).
  await p.Flow.pickShape('peak');
  assert.deepStrictEqual(row(p).kept, MINE);
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.playlist, MINE);
});

test('a drag while a shape is lit: nothing lit, the kept order stays; the drag undone puts the shape back lit; Custom restores the kept order and its Undo puts back the dragged order, nothing lit', async () => {
  const p = await mine();
  await p.Flow.pickShape('smooth');
  const shaped = p.server.playlist.slice();
  const before = row(p);
  const dragged = shaped.slice(1).concat(shaped[0]);
  const undo = await dragTo(p, dragged);
  assert.deepStrictEqual(p.server.bodies.at(-1).flow, { manual: true });
  assert.strictEqual(panel(p), 'none', 'neither the shape nor Custom after a drag');
  assert.strictEqual(row(p).mode, 'edited');
  assert.deepStrictEqual(row(p).kept, MINE, 'kept');
  await undo();
  assert.deepStrictEqual(p.server.playlist, shaped);
  assert.deepStrictEqual(row(p), before, 'the row exactly as before the drag');
  assert.strictEqual(panel(p), 'smooth', 'the shape is lit again');
  // Drag again, then Custom from the edited order.
  await dragTo(p, dragged);
  const edited = row(p);
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.bodies.at(-1), { flow: { custom: true } });
  assert.deepStrictEqual(p.server.playlist, MINE, 'Custom brings the kept order back exactly');
  assert.strictEqual(panel(p), 'custom');
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(p.server.playlist, dragged);
  assert.deepStrictEqual(row(p), edited, 'the edited row exactly');
  assert.strictEqual(panel(p), 'none');
});

test('the owner\'s case: own order, a shape, a nudge, another shape: the kept order is still the own one (not the nudged shape); that pick\'s Undo puts back the edited row', async () => {
  const p = await mine();
  await p.Flow.pickShape('waves');
  const shaped = p.server.playlist.slice();
  const dragged = shaped.slice(1).concat(shaped[0]);
  await dragTo(p, dragged);
  const rowDragged = row(p);
  assert.strictEqual(rowDragged.mode, 'edited');
  await p.Flow.pickShape('peak');
  assert.strictEqual(panel(p), 'peak');
  assert.deepStrictEqual(row(p).kept, MINE, 'kept: a shape changed by hand never replaces it');
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(p.server.playlist, dragged);
  assert.deepStrictEqual(row(p), rowDragged, 'the edited row exactly');
  assert.strictEqual(panel(p), 'none');
  await p.Flow.pickShape('peak');
  // No Undo used: Custom still gives the own order.
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.playlist, MINE);
  assert.strictEqual(panel(p), 'custom');
});

test('while edited, a file taken out and put back: the row is not touched, nothing lit, and Custom puts the file back in its kept place', async () => {
  const p = await mine();
  await p.Flow.pickShape('peak');
  const shaped = p.server.playlist.slice();
  await dragTo(p, shaped.slice().reverse());
  const r = row(p);
  const now = p.server.playlist.slice();
  await members(p, now.filter(id => id !== 7));
  assert.strictEqual(panel(p), 'none');
  await members(p, now.filter(id => id !== 7).concat(7));
  assert.strictEqual(row(p).rev, r.rev, 'the row is not touched');
  assert.strictEqual(panel(p), 'none');
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.playlist, MINE, 'file 7 back in its kept place');
});

test('another window changes only which button is lit (no file moves): this panel repaints from the collection read again', async () => {
  const server = newServer();
  const a = page({ server });
  await a.Flow.toggle(3);
  await dragTo(a, MINE);
  // Another window: Peak worked out to this very order would move nothing; a hand-made row says the same.
  const r = postOrder(server, { order: MINE.slice(), flow: { shape: 'peak' } });
  assert.deepStrictEqual(r.body.order, MINE);
  assert.strictEqual(panel(a), 'custom', 'a has not heard yet');
  // The library check (collections.js takeCollectionAnswer): the same files, the row read again.
  const read = () => a.ctx.flowCustomAnswer(3, { media_ids: server.playlist.slice(), flow_custom: server.custom.state(server.playlist) }, { read: true });
  read();
  await settle();
  assert.strictEqual(panel(a), 'peak');
  postOrder(server, { order: MINE.slice(), flow: { manual: true } });
  read();
  assert.strictEqual(panel(a), 'none');
  postOrder(server, { flow: { custom: true } });
  read();
  assert.strictEqual(panel(a), 'custom');
});

const STALE_TEXT = 'This order was changed in another window, so there was nothing to undo.';

test('a stale Undo after later actions is refused as a whole: nothing written, a plain toast with no Undo, the panel as the server has it', async () => {
  const p = await mine();
  await p.Flow.pickShape('peak');
  const peakUndo = p.undos.at(-1).fn;   // would remove the row (there was none before Peak)
  const shaped = p.server.playlist.slice();
  await dragTo(p, shaped.slice().reverse());   // a later change of the row (mode edited)
  const now = row(p), order = p.server.playlist.slice(), w = p.server.writes, u = p.undos.length;
  await peakUndo();
  assert.strictEqual(p.server.bodies.at(-1).flow.restore, null, 'it was sent: no row before Peak');
  assert.strictEqual(p.server.writes, w, 'nothing written');
  assert.deepStrictEqual(p.server.playlist, order, 'the order is as it was');
  assert.deepStrictEqual(row(p), now, 'the row is not touched: MINE still kept');
  assert.strictEqual(p.toasts.at(-1), STALE_TEXT);
  assert.strictEqual(p.undos.length, u, 'no Undo for it');
  assert.deepStrictEqual(p.ctx.collectionMembers.get(3), order, 'the page has the server\'s order');
  assert.deepStrictEqual(Array.from(p.Library.ids), order, 'the grid too');
  assert.strictEqual(panel(p), 'none');
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.playlist, MINE);
});

test('the checker\'s two-window repro: A Smooth, B Peak, A Custom, B\'s Undo of Peak is refused; then Waves and Custom still give the own order', async () => {
  const server = newServer();
  const a = page({ server });
  const b = page({ server });
  await a.Flow.toggle(3);
  await b.Flow.toggle(3);
  await dragTo(a, MINE);
  const sync = async (p) => { await p.ctx.fetchCollectionMembers(3); p.ctx.flowCustomAnswer(3, { media_ids: server.playlist.slice(), flow_custom: server.custom.state(server.playlist) }, { read: true }); p.ctx.flowOrderSynced(3); await settle(); };
  await sync(b);
  await a.Flow.pickShape('smooth');
  await sync(b);
  assert.strictEqual(panel(b), 'smooth');
  await b.Flow.pickShape('peak');
  const bUndo = b.undos.at(-1).fn;
  await sync(a);
  assert.strictEqual(panel(a), 'peak');
  assert.strictEqual(await a.Flow.pickCustom(), true);
  assert.deepStrictEqual(server.playlist, MINE);
  const w = server.writes, r = row(a);
  await bUndo();
  assert.strictEqual(server.writes, w, 'B\'s stale Undo wrote nothing');
  assert.deepStrictEqual(server.playlist, MINE, 'the order is still the own one');
  assert.deepStrictEqual(row(a), r, 'Custom, as A left it');
  assert.strictEqual(b.toasts.at(-1), STALE_TEXT);
  assert.strictEqual(panel(b), 'custom', 'B now shows what the server has');
  assert.deepStrictEqual(Array.from(b.Library.ids), MINE, 'B\'s grid too');
  await a.Flow.pickShape('waves');
  assert.deepStrictEqual(row(a).kept, MINE);
  assert.strictEqual(await a.Flow.pickCustom(), true);
  assert.deepStrictEqual(server.playlist, MINE, 'Custom gives the own order');
});

test('every Undo here that meets a changed row is refused the same way: Custom\'s Undo and a saved order\'s Undo', async () => {
  const server = newServer();
  const a = page({ server });
  const b = page({ server });
  await a.Flow.toggle(3);
  await b.Flow.toggle(3);
  await dragTo(a, MINE);
  await a.Flow.pickShape('peak');
  await b.Flow.refetch(true);
  assert.strictEqual(await a.Flow.pickCustom(), true);
  const customUndo = a.undos.at(-1).fn;
  // B (stale) picks Build up: from Custom on the server, so MINE is kept again; the row changed.
  await b.ctx.fetchCollectionMembers(3);
  await b.Flow.pickShape('build');
  const w = server.writes, order = server.playlist.slice(), r = row(a);
  await customUndo();
  assert.strictEqual(server.writes, w);
  assert.deepStrictEqual(server.playlist, order);
  assert.deepStrictEqual(row(a), r);
  assert.strictEqual(a.toasts.at(-1), STALE_TEXT);
  assert.strictEqual(panel(a), 'build', 'A follows the server');
});

/* Membership changes and order writes that say nothing leave the row alone. */
for (const [what, change] of [
  ['files taken out, then Remove undone (collections.js undoRemoveFromCollection: added back, then the old order without flow)', async (p, shaped) => {
    await members(p, shaped.filter(id => id !== 2 && id !== 6));
    await members(p, shaped.filter(id => id !== 2 && id !== 6).concat(2, 6));
    await orderWrite(p, shaped);
  }],
  ['a file added, then taken out again', async (p, shaped) => {
    await members(p, shaped.concat(9));
    await members(p, shaped);
  }],
  ['another window or client (an older Vault) writing a plain order', async (p, shaped) => {
    await orderWrite(p, shaped.slice().reverse(), undefined, { told: false });
    await p.ctx.fetchCollectionMembers(3);
    p.ctx.flowOrderSynced(3);
    await p.Flow.refetch(true);
  }],
  ['a playlist import placing a file mid-way, then its Undo taking the file out', async (p, shaped) => {
    await members(p, shaped.slice(0, 3).concat(9, shaped.slice(3)));
    await members(p, shaped);
  }],
]) {
  test(`the kept order survives: ${what}`, async () => {
    const p = await mine();
    await p.Flow.pickShape('peak');
    const shaped = p.server.playlist.slice();
    const before = row(p);
    await change(p, shaped);
    assert.deepStrictEqual(row(p).rev, before.rev, 'the row is not touched');
    assert.strictEqual(panel(p), 'peak', 'the shape stays lit');
    assert.strictEqual(await p.Flow.pickCustom(), true);
    assert.deepStrictEqual(p.server.playlist, MINE, 'Custom restores the kept order exactly');
  });
}

test('files added and taken out while a shape is lit: the shape stays lit, Custom gives the kept order without the gone files and with the new ones at the end', async () => {
  const p = await mine();
  await p.Flow.pickShape('waves');
  const shaped = p.server.playlist.slice();
  // File 7 taken out, file 9 added (at the end, as adding does).
  await members(p, shaped.filter(id => id !== 7).concat(9));
  assert.strictEqual(panel(p), 'waves', 'still the shape');
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.playlist, [8, 1, 2, 6, 3, 5, 4, 9]);
  assert.strictEqual(panel(p), 'custom');
});

test('a shape pick that changes nothing on screen: undoable (and said so) when it lights the shape, nothing at all when it is lit already', async () => {
  const p = page();
  await p.Flow.toggle(3);
  // The playlist is already what Peak works out (by hand).
  await dragTo(p, serverOrder('peak', true));
  const n = p.undos.length;
  assert.strictEqual(await p.Flow.pickShape('peak'), false, 'the order did not change');
  assert.strictEqual(panel(p), 'peak');
  assert.strictEqual(p.undos.length, n + 1, 'but Peak lit now: with Undo');
  assert.strictEqual(p.undos.at(-1).m, 'Peak is picked. The files were already in that order.');
  await p.undos.at(-1).fn();
  assert.strictEqual(panel(p), 'custom');
  assert.strictEqual(row(p), null);
  // Lit already: nothing written, no Undo.
  await p.Flow.pickShape('peak');
  const w = p.server.writes, u = p.undos.length, r = row(p);
  assert.strictEqual(await p.Flow.pickShape('peak'), false);
  assert.strictEqual(p.server.writes, w);
  assert.strictEqual(p.undos.length, u);
  assert.deepStrictEqual(row(p), r);
  assert.strictEqual(p.toasts.at(-1), 'The playlist order is already Peak', 'said with no Undo');
});

test('after a reload the lit shape comes from the server, and Custom still brings the kept order back', async () => {
  const server = newServer();
  const store = new Map();
  const a = page({ server, store });
  await a.Flow.toggle(3);
  await dragTo(a, MINE);
  await a.Flow.pickShape('waves', 3);
  const waves3 = server.playlist.slice();
  // This computer forgets which shape it picked (another browser, cleared data).
  store.clear();
  const b = page({ server, store });
  await b.Flow.toggle(3);
  await b.ctx.applyFilters();
  assert.deepStrictEqual(b.ctx.collectionMembers.get(3), waves3);
  assert.strictEqual(panel(b), 'waves');
  assert.strictEqual(b.Flow.shape().waves, 3, 'the peaks follow the server');
  assert.ok(b.Flow._view.guide(), 'the guide is for the lit shape');
  assert.strictEqual(await b.Flow.pickCustom(), true);
  assert.deepStrictEqual(server.playlist, MINE);
  // A reload with Custom lit: Custom, whatever shape this computer remembers.
  const c = page({ server, store });
  await c.Flow.toggle(3);
  assert.strictEqual(panel(c), 'custom');
});

test('Undo of a Place tagged files rearrange puts the switch back too (the shape is lit again)', async () => {
  const p = page();
  await p.Flow.toggle(3);
  await p.Flow.pickPlaces(false);
  await p.Flow.pickShape('build');
  assert.strictEqual(p.Flow.shape().places, false);
  const off = p.server.playlist.slice();
  assert.strictEqual(await p.Flow.pickPlaces(true), true);
  assert.strictEqual(p.Flow.shape().places, true);
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(p.server.playlist, off);
  assert.strictEqual(p.Flow.shape().places, false, 'the switch is back');
  assert.strictEqual(panel(p), 'build');
});

test('a shape that could not be written leaves the panel (and this computer) as before', async () => {
  const p = page();
  await p.Flow.toggle(3);
  await p.Flow.pickShape('build');
  const kept = p.store.get('vault.flow.shape.3');
  assert.match(kept, /"shape":"build"/);
  p.server.fail = 500;
  assert.strictEqual(await p.Flow.pickShape('peak'), false);
  assert.strictEqual(p.Flow.shape().shape, 'build');
  assert.strictEqual(p.store.get('vault.flow.shape.3'), kept, 'not remembered');
  assert.strictEqual(panel(p), 'build');
});


test('a shape written on the server with its answer lost: the panel follows what the server holds', async () => {
  const p = await mine();
  p.server.loseAnswer = true;
  assert.strictEqual(await p.Flow.pickShape('peak'), false);
  await settle();
  assert.deepStrictEqual(p.ctx.collectionMembers.get(3), p.server.playlist, 'the page has the order the server kept');
  assert.strictEqual(panel(p), 'peak', 'Peak lit, as on the server');
  assert.strictEqual(p.Flow.shape().shape, 'peak');
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(p.server.playlist, MINE);
});

test('another window picks a shape or Custom: this panel follows once the order is read again, and a click on a stale panel redraws it', async () => {
  const server = newServer();
  const a = page({ server });
  const b = page({ server });
  await a.Flow.toggle(3);
  await b.Flow.toggle(3);
  await dragTo(a, MINE);
  await a.Flow.pickShape('waves');
  // b learns of it as the library check would (collections.js takeCollectionAnswer -> flowOrderSynced).
  const sync = async (p) => { p.ctx.collectionMembers.set(3, server.playlist.slice()); p.ctx.flowOrderSynced(3); await settle(); };
  await sync(b);
  assert.strictEqual(panel(b), 'waves');
  // b picks Peak; a has not heard yet.
  await b.Flow.pickShape('peak');
  assert.strictEqual(panel(a), 'waves', 'a: still shows what it last knew (this is what the sync fixes)');
  await sync(a);
  assert.strictEqual(panel(a), 'peak', 'a follows');
  // b picks Custom; a clicks Custom before hearing: the server writes nothing new, a redraws as Custom.
  await b.Flow.pickCustom();
  const order = server.playlist.slice(), r = row(a), u = a.undos.length;
  assert.strictEqual(panel(a), 'peak', 'a is stale');
  assert.strictEqual(await a.Flow.pickCustom(), false);
  await settle();
  assert.deepStrictEqual(server.playlist, order, 'the order is as b left it');
  assert.deepStrictEqual(row(a), r, 'the row is as b left it');
  assert.strictEqual(panel(a), 'custom', 'a redrew from the server');
  assert.strictEqual(a.undos.length, u, 'no Undo toast for a click that did nothing');
  // b picks Smooth only; a, stale on Custom, clicks Custom: redrawn as Smooth only, nothing written.
  await b.Flow.pickShape('smooth');
  const w = server.writes;
  assert.strictEqual(panel(a), 'custom');
  assert.strictEqual(await a.Flow.pickCustom(), false);
  await settle();
  assert.strictEqual(panel(a), 'smooth');
  assert.strictEqual(server.writes, w);
});
