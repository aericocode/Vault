/**
 * Saved orders in the Flow panel (player-lib/flow.js "Saved orders"): there
 * is one order, the playlist order. ＋ Save this order keeps it (as shown
 * on screen) and the skips now; clicking a chip loads it into the playlist
 * order, order and skips in one request (POST /api/collections/:id/order
 * { order, skips }), fitted to the files there are now, with Undo; a chip is
 * lit while the playlist still is it. Saved orders from before (a shape, no
 * skips of their own) load too. Update with this order, Rename, Delete.
 *
 * flow.js (and collection-skips.js) run in a vm with a bare page; the
 * server's routes are played here in memory.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FlowOrder = require('../player-lib/flow-order.js');
const FlowChartMath = require('../player-lib/flow-chart-math.js');
const { flowCustomFake } = require('./helpers/flow-custom-fake');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');
const SKIPS_SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'collection-skips.js'), 'utf8');
const CID = 3;

const feat = (id) => ({ id, measured: true, music: true, es: 0.2 + (id % 4) * 0.2, em: 0.2 + (id % 3) * 0.3, ee: 0.2 + (id % 5) * 0.15, bs: 120, bm: 120, be: 120 });

/** The server: the collection's playlist order and skips, and its saved orders. */
function server(ids = [1, 2, 3, 4, 5, 6, 7, 8]) {
  return { members: ids.slice(), skips: [], saved: [], nextId: 1, posts: [], puts: [], orders: [], store: new Map(), custom: flowCustomFake(CID) };
}

function page(srv) {
  const listeners = {};
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fail = (status, body) => ({ ok: false, status, json: async () => body });
  const Library = {
    spec: null, ids: null,
    indexOf: (id) => (Library.ids ? Array.prototype.indexOf.call(Library.ids, id) : -1),
    idAt: (i) => (Library.ids && i >= 0 && i < Library.ids.length ? Library.ids[i] : undefined),
  };
  const toasts = [];
  const undos = [];
  const ctx = {
    console,
    FlowOrder,
    FlowChartMath,
    Library,
    anyFilterIsSet: () => false,
    activeCollectionId: CID,
    collectionMembers: new Map([[CID, srv.members.slice()]]),
    showToast: (m) => toasts.push(String(m)),
    showUndoToast: (m, fn) => undos.push({ m, fn }),
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: {
      getItem: (k) => (srv.store.has(k) ? srv.store.get(k) : null),
      setItem: (k, v) => srv.store.set(k, String(v)),
      removeItem: (k) => srv.store.delete(k),
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    // The grid: the playlist order.
    applyFilters: async () => {
      Library.spec = { collectionId: CID, rankedIds: null };
      Library.ids = Uint32Array.from(srv.members);
      (listeners['vault:results-changed'] || []).forEach(fn => fn({}));
    },
    // collections.js takeCollectionAnswer, the part this needs: the skips.
    takeCollectionAnswer: (id, data) => {
      if (Array.isArray(data.skipped_ids) && ctx.__Skips.take(id, data.skipped_ids)) ctx.__Skips.changed(id);
    },
    fetch: async (url, opts = {}) => {
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      let m = /\/api\/flow\/collections\/(\d+)\/saved$/.exec(url);
      if (m && method === 'GET') return ok(srv.saved.map(s => ({ ...s })));
      if (m && method === 'POST') {
        srv.posts.push(body);
        if (srv.saved.some(s => s.name.toLowerCase() === body.name.toLowerCase())) return fail(409, { error: 'taken', code: 'NAME_TAKEN' });
        const row = { id: srv.nextId++, collectionId: CID, name: body.name, shape: body.shape, waves: body.waves, places: !!body.places, order: body.order.slice(), skips: body.skips === undefined ? null : body.skips, createdAt: srv.nextId, updatedAt: srv.nextId };
        srv.saved.push(row);
        return ok({ ...row });
      }
      m = /\/api\/flow\/saved\/(\d+)$/.exec(url);
      if (m) {
        const i = srv.saved.findIndex(s => s.id === Number(m[1]));
        if (i < 0) return fail(404, { error: 'not found', code: 'NOT_FOUND' });
        if (method === 'DELETE') { srv.saved.splice(i, 1); return ok({ ok: true }); }
        srv.puts.push(body);
        Object.assign(srv.saved[i], body);
        return ok({ ...srv.saved[i] });
      }
      if (/\/api\/collections\/3\/order$/.test(url)) {
        srv.orders.push(body);
        const same = !body.order || (body.order.length === srv.members.length && body.order.every(id => srv.members.includes(id)));
        if (!same) return fail(400, { error: 'order must list every file in the collection exactly once', code: 'BAD_ORDER' });
        const r = srv.custom.post(srv.members.slice(), body);
        srv.members = r.order.slice();
        const out = { ...r, item_count: srv.members.length };
        if (body.skips) {
          out.was_skipped_ids = srv.skips.slice();
          srv.skips = srv.members.filter(id => body.skips.includes(id));
          out.skipped_ids = srv.skips.slice();
        }
        return ok(out);
      }
      if (/\/api\/flow\/collections\/3\/custom$/.test(url)) return ok({ custom: srv.custom.state(srv.members) });
      m = /\/api\/flow\/collections\/(\d+)\?shape=(\w+)&places=(\d)(?:&waves=(\d))?/.exec(url);
      if (m) {
        const shape = m[2], on = m[3] === '1', waves = m[4] ? Number(m[4]) : 2;
        const feats = srv.members.slice().sort((a, b) => a - b).map(feat);
        const order = FlowOrder.planOrder(feats, { shape, waves }).order;
        const sum = FlowOrder.summary(feats, order);
        return ok({ shape, waves, order, playlistOrder: srv.members.slice(), features: feats, targets: FlowOrder.targetsFor(shape, feats),
          handovers: sum.handovers, jumps: sum.jumps, playlistJumps: 0, counts: { measured: feats.length, failed: 0, music: feats.length }, places: {}, placesOn: on,
          custom: srv.custom.state(srv.members) });
      }
      return ok({ collection: { total: srv.members.length, measured: srv.members.length, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } });
    },
  };
  ctx.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  vm.runInContext(`${SKIPS_SRC}\nglobalThis.__Skips = Skips;`, ctx);
  const S = ctx.__Skips;
  S.take(CID, srv.skips);
  return { ctx, Flow: ctx.window.Flow, Library, S, toasts, undos };
}

/** A drag as collection-reorder.js makes it: written by hand, the page's copy, then Flow told. */
async function drag(p, srv, order) {
  const r = srv.custom.post(srv.members.slice(), { order, flow: { manual: true } });
  srv.members = order.slice();
  p.ctx.collectionMembers.set(CID, order.slice());
  p.ctx.flowCustomAnswer(CID, r);
  await p.ctx.flowMembersChanged(CID);
  await p.ctx.applyFilters();
}
const lit = (p) => p.Flow.saved.active();

test('Save this order keeps the playlist order and the skips now; its chip is lit until the order changes', async () => {
  const srv = server();
  srv.skips = [2];
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  await drag(p, srv, [3, 1, 2, 8, 7, 6, 5, 4]);
  assert.match(p.Flow.saved.html(), /data-flow-saved-new[^>]*title="Keep the playlist order as it is now \(and its skips\)/);
  assert.strictEqual(await p.Flow.saved.save('  My mix '), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.posts[0])), { name: 'My mix', shape: 'playlist', waves: 2, places: false, order: [3, 1, 2, 8, 7, 6, 5, 4], skips: [2] });
  assert.strictEqual(lit(p), srv.saved[0].id, 'the playlist order is it: lit');
  assert.match(p.Flow.saved.html(), /flow-chip on/);
  assert.match(p.Flow.saved.html(), /My mix<\/span><\/button>/, 'no shape under a name saved from a plain order');
  assert.strictEqual(srv.orders.length, 0, 'saving writes no order');
  // A taken name (any case): said, nothing saved.
  assert.strictEqual(await p.Flow.saved.save('MY MIX'), false);
  assert.match(p.toasts.at(-1), /already a saved order called/);
  // Any change lets go of it: a move, or a skip.
  await drag(p, srv, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(lit(p), null);
  await drag(p, srv, [3, 1, 2, 8, 7, 6, 5, 4]);
  assert.strictEqual(lit(p), srv.saved[0].id);
  p.S.take(CID, [2, 5]);
  assert.strictEqual(lit(p), null, 'another skip: not it any more');
});

test('clicking a chip loads it into the playlist order (order and skips, one request), with Undo', async () => {
  const srv = server();
  srv.skips = [4];
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  await drag(p, srv, [8, 7, 6, 5, 4, 3, 2, 1]);
  p.S.take(CID, [1, 2]); srv.skips = [1, 2];
  await p.Flow.saved.save('Backwards');
  // Changed since: the playlist order and the skips.
  await drag(p, srv, [1, 2, 3, 4, 5, 6, 7, 8]);
  p.S.take(CID, [6]); srv.skips = [6];
  assert.strictEqual(lit(p), null);
  assert.strictEqual(await p.Flow.saved.use(srv.saved[0].id), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.orders.at(-1))), { order: [8, 7, 6, 5, 4, 3, 2, 1], skips: [1, 2], flow: { manual: true } });
  assert.strictEqual(srv.orders.length, 1, 'one request');
  assert.deepStrictEqual(srv.members, [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepStrictEqual(p.ctx.collectionMembers.get(CID), [8, 7, 6, 5, 4, 3, 2, 1]);
  assert.deepStrictEqual(Array.from(p.Library.ids), [8, 7, 6, 5, 4, 3, 2, 1], 'the grid (and so Play all and Stage) follow');
  assert.deepStrictEqual([...p.S.setFor(CID)].sort(), [1, 2]);
  assert.strictEqual(lit(p), srv.saved[0].id);
  assert.match(p.undos.at(-1).m, /Loaded “Backwards” into the playlist order/);
  // Clicking it again: it already is the playlist order, nothing is written.
  assert.strictEqual(await p.Flow.saved.use(srv.saved[0].id), false);
  assert.strictEqual(srv.orders.length, 1);
  // Undo: the order and the skips from before.
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.orders.at(-1))), { order: [1, 2, 3, 4, 5, 6, 7, 8], skips: [6], flow: { restore: null, rev: null } }, 'with the check that nothing is kept still');
  assert.deepStrictEqual([...p.S.setFor(CID)], [6]);
  assert.strictEqual(lit(p), null);
  assert.strictEqual(p.toasts.at(-1), 'Playlist order put back');
});

test('a saved order from before (a shape, no skips of its own) loads its stored order fitted to the files there are now, skips left alone', async () => {
  const srv = server([1, 2, 3, 4, 5, 6, 7, 9]);
  srv.skips = [5];
  // Saved when file 8 was in the collection and file 9 was not.
  srv.saved.push({ id: 50, collectionId: CID, name: 'Old', shape: 'waves', waves: 3, places: true, order: [8, 2, 1, 3, 4, 5, 6, 7], skips: null, createdAt: 1, updatedAt: 1 });
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  assert.match(p.Flow.saved.html(), /Old<\/span><span class="flow-chip-shape">Waves 3</);
  await p.Flow.saved.use(50);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.orders.at(-1))), { order: [2, 1, 3, 4, 5, 6, 7, 9], flow: { manual: true } }, 'gone file dropped, new one at the end, no skips sent, by hand');
  assert.deepStrictEqual(srv.members, [2, 1, 3, 4, 5, 6, 7, 9]);
  assert.deepStrictEqual([...p.S.setFor(CID)], [5], "the playlist's skips stay");
  assert.strictEqual(lit(p), 50);
  const st = p.Flow._state();
  assert.deepStrictEqual([st.shape, st.places], ['smooth', null], 'loading takes no shape or switch from it');
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.orders.at(-1))), { order: [1, 2, 3, 4, 5, 6, 7, 9], flow: { restore: null, rev: null } });
});

test('saving while the playlist is still a shape records the shape; a chip shows it', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  await p.Flow.pickShape('waves', 3);
  const order = srv.members.slice();
  await p.Flow.saved.save('Friday set');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.posts[0])), { name: 'Friday set', shape: 'waves', waves: 3, places: false, order, skips: [] });
  assert.match(p.Flow.saved.html(), /Friday set<\/span><span class="flow-chip-shape">Waves 3</);
  // After a move it is a plain order again.
  await drag(p, srv, order.slice().reverse());
  await p.Flow.saved.save('Moved');
  assert.strictEqual(srv.posts.at(-1).shape, 'playlist');
});

test('Update with this order puts the order on screen and the skips now in it; Undo puts it back as it was', async () => {
  const srv = server();
  srv.saved.push({ id: 7, collectionId: CID, name: 'Peak', shape: 'peak', waves: 2, places: false, order: [2, 1, 3, 4, 5, 6, 7, 8], skips: null, createdAt: 1, updatedAt: 1 });
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  await drag(p, srv, [8, 7, 6, 5, 4, 3, 2, 1]);
  p.S.take(CID, [3]);
  await p.Flow.saved.update(7);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.puts.at(-1))), { shape: 'playlist', waves: 2, places: false, order: [8, 7, 6, 5, 4, 3, 2, 1], skips: [3] });
  assert.strictEqual(lit(p), 7);
  assert.match(p.undos.at(-1).m, /Updated “Peak” with this order/);
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.puts.at(-1))), { shape: 'peak', waves: 2, places: false, order: [2, 1, 3, 4, 5, 6, 7, 8], skips: null });
  assert.strictEqual(lit(p), null);
});

test('Delete with Undo, and Rename', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  await p.Flow.saved.save('Keep');
  await p.Flow.saved.save('Other');
  await p.Flow.saved.remove(srv.saved[1].id);
  assert.deepStrictEqual(srv.saved.map(s => s.name), ['Keep']);
  assert.match(p.undos.at(-1).m, /Deleted the saved order “Other”/);
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(srv.saved.map(s => s.name), ['Keep', 'Other']);
  assert.strictEqual(await p.Flow.saved.rename(srv.saved[1].id, 'keep'), false, 'taken, ignoring case');
  assert.strictEqual(await p.Flow.saved.rename(srv.saved[1].id, 'Sunday'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.Flow.saved.list().map(s => s.name))), ['Keep', 'Sunday']);
  assert.strictEqual(srv.orders.length, 0, 'none of it writes the playlist order');
});

test('Save this order and Update keep the order on screen: a sort or a shuffle as shown; files a search hides keep their place', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  // Sorted by name (or shuffled): the grid shows another order than the playlist's.
  const shown = [5, 4, 8, 6, 7, 1, 2, 3];
  p.Library.spec = { collectionId: CID, rankedIds: null };
  p.Library.ids = Uint32Array.from(shown);
  assert.strictEqual(await p.Flow.saved.save('By name'), true);
  assert.deepStrictEqual(srv.posts.at(-1).order, shown);
  assert.strictEqual(lit(p), null, 'not the playlist order: not lit');
  // A search shows 3 of them, in the order 7, 2, 5: those take their own slots (2, 5, 7) in that order, the rest stay.
  p.Library.ids = Uint32Array.from([7, 2, 5]);
  assert.strictEqual(await p.Flow.saved.save('Searched'), true);
  assert.deepStrictEqual(srv.posts.at(-1).order, [1, 7, 3, 4, 2, 6, 5, 8]);
  // Update follows the same rule.
  p.Library.ids = Uint32Array.from([8, 7, 6, 5, 4, 3, 2, 1]);
  await p.Flow.saved.update(srv.saved[0].id);
  assert.deepStrictEqual(srv.puts.at(-1).order, [8, 7, 6, 5, 4, 3, 2, 1]);
  // Another collection's results on screen: the playlist order.
  p.Library.spec = { collectionId: 99 };
  assert.strictEqual(await p.Flow.saved.save('Elsewhere'), true);
  assert.deepStrictEqual(srv.posts.at(-1).order, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a chip clicked while files came and went: a 400 is asked again with the files there are now', async () => {
  const srv = server([1, 2, 3, 4]);
  srv.saved.push({ id: 9, collectionId: CID, name: 'Mix', shape: 'playlist', waves: 2, places: false, order: [4, 3, 2, 1], skips: [1], createdAt: 1, updatedAt: 1 });
  const p = page(srv);
  await p.Flow.toggle(CID);
  // The page still thinks 1..4; the server has 1..5 by now (another window added 5).
  srv.members = [1, 2, 3, 4, 5];
  // The first two reads (the order Undo puts back, the first try) are behind.
  let reads = 0;
  p.ctx.fetchCollectionMembers = async () => { if (++reads <= 2) return [1, 2, 3, 4]; p.ctx.collectionMembers.set(CID, srv.members.slice()); return srv.members.slice(); };
  assert.strictEqual(await p.Flow.saved.use(9), true);
  assert.deepStrictEqual(srv.orders.map(o => o.order), [[4, 3, 2, 1], [4, 3, 2, 1, 5]]);
  assert.deepStrictEqual(srv.members, [4, 3, 2, 1, 5], 'no file lost');
  assert.deepStrictEqual(srv.skips, [1]);
});

test('the panel has one order: no switch, no Make this the playlist order, no working order kept on this computer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');
  assert.ok(!src.includes('Make this the playlist order'));
  assert.ok(!src.includes('data-flow-order='));
  assert.ok(!src.includes('data-flow-save-order'));
  assert.ok(!/localStorage\.setItem\(OLD_ORDER_PREFIX/.test(src));
  assert.ok(!/—/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'no em dash in what the user reads');
});

test('a chip loaded while a shape is lit is a hand order over a shape: nothing lit, the kept order stays; a shape then keeps it, and Custom brings it back; each Undo puts back the order and the row exactly', async () => {
  const srv = server();
  srv.saved.push({ id: 60, collectionId: CID, name: 'Mine', shape: 'playlist', waves: 2, places: false, order: [8, 1, 7, 2, 6, 3, 5, 4], skips: null, createdAt: 1, updatedAt: 1 });
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  await p.Flow.pickShape('peak');
  const peak = srv.members.slice();
  const row = srv.custom.state(srv.members);
  assert.strictEqual(p.Flow.shape().lit, true);
  assert.strictEqual(await p.Flow.saved.use(60), true);
  const chipOrder = [8, 1, 7, 2, 6, 3, 5, 4];
  assert.deepStrictEqual(srv.members, chipOrder);
  assert.deepStrictEqual(srv.orders.at(-1).flow, { manual: true }, 'a chip is loaded by hand');
  assert.strictEqual(p.Flow.shape().custom, false, 'Custom is not lit');
  assert.strictEqual(p.Flow.shape().lit, false, 'nor Peak');
  const edited = srv.custom.state(srv.members);
  assert.deepStrictEqual([edited.mode, edited.custom], ['edited', [1, 2, 3, 4, 5, 6, 7, 8]], 'the kept order stays in the row');
  // The chip's Undo: Peak, lit, the row exactly.
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(srv.members, peak);
  assert.deepStrictEqual(srv.custom.state(srv.members), row, 'the row exactly as before the chip');
  assert.strictEqual(p.Flow.shape().shape, 'peak');
  assert.strictEqual(p.Flow.shape().lit, true);
  // The chip again, then Steady: the kept order is still the own one, not the chip.
  assert.strictEqual(await p.Flow.saved.use(60), true);
  const edited2 = srv.custom.state(srv.members);
  await p.Flow.pickShape('steady');
  assert.deepStrictEqual(srv.custom.state(srv.members).kept, [1, 2, 3, 4, 5, 6, 7, 8]);
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(srv.members, chipOrder);
  assert.deepStrictEqual(srv.custom.state(srv.members), edited2, 'Steady undone: the edited row exactly');
  await p.Flow.pickShape('steady');
  // Custom, long after: the own order.
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(srv.members, [1, 2, 3, 4, 5, 6, 7, 8], 'Custom brings the kept order back exactly');
  assert.strictEqual(p.Flow.shape().custom, true);
});

test('Peak lit, saved as a chip, Custom, a drag, the chip loaded: Custom lit (Peak is not); the kept order comes back to use only after a shape is picked, and then it is the chip order', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.ctx.applyFilters();
  await p.Flow.pickShape('peak');
  const peak = srv.members.slice();
  await p.Flow.saved.save('Peak night');
  const chip = srv.saved.at(-1);
  assert.deepStrictEqual(chip.order, peak);
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(srv.members, [1, 2, 3, 4, 5, 6, 7, 8]);
  await drag(p, srv, [2, 1, 3, 4, 5, 6, 7, 8]);
  assert.strictEqual(await p.Flow.saved.use(chip.id), true);
  assert.deepStrictEqual(srv.members, peak, 'the chip is the Peak order');
  assert.strictEqual(p.Flow.shape().custom, true, 'Custom lit: a chip is a hand order, even one that matches a shape');
  assert.strictEqual(p.Flow.shape().lit, false, 'Peak is not lit');
  const w = srv.orders.length;
  assert.strictEqual(await p.Flow.pickCustom(), false, 'Custom does nothing: it is lit');
  assert.strictEqual(srv.orders.length, w);
  // A shape picked now keeps the chip order as the custom one.
  await p.Flow.pickShape('waves');
  assert.deepStrictEqual(srv.custom.state(srv.members).kept, peak);
  assert.strictEqual(await p.Flow.pickCustom(), true);
  assert.deepStrictEqual(srv.members, peak);
});
