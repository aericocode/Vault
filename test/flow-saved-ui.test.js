/**
 * Saved Flow orders in the panel (player-lib/flow.js "Saved orders"): saving
 * the working order under a name, loading it again (fitted to the files the
 * collection has now: a removed file dropped, an added one at the end), the
 * order's name ("Flow order: Friday set", ", edited" after a move), a
 * built-in shape letting go of it, Delete with Undo, and a reload coming
 * back to it (vault.flow.order.<id> keeps its id).
 *
 * flow.js runs in a vm with a bare page, as in flow-grid-sync.test.js; the
 * server's saved-order routes are played here in memory.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FlowOrder = require('../player-lib/flow-order.js');
const FlowChartMath = require('../player-lib/flow-chart-math.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');
const CID = 3;
const SKIPS_SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'collection-skips.js'), 'utf8');

const feat = (id) => ({ id, measured: true, music: true, es: 0.2 + (id % 4) * 0.2, em: 0.2 + (id % 3) * 0.3, ee: 0.2 + (id % 5) * 0.15, bs: 120, bm: 120, be: 120 });

/** One server (the collection's files and its saved orders) that several pages (reloads) share. */
function server(ids = [1, 2, 3, 4, 5, 6, 7, 8]) {
  return { members: ids.slice(), saved: [], nextId: 1, posts: [], store: new Map() };
}

function page(srv, { skips = false } = {}) {
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
    applyFilters: async () => {
      const ranked = ctx.flowQueryRanked();
      const order = ranked ? ranked.slice().sort((a, b) => b.score - a.score).map(r => r.id) : srv.members;
      Library.spec = { collectionId: CID, rankedIds: ranked };
      Library.ids = Uint32Array.from(order);
      (listeners['vault:results-changed'] || []).forEach(fn => fn({}));
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
        (srv.puts ||= []).push(body);
        Object.assign(srv.saved[i], body);
        return ok({ ...srv.saved[i] });
      }
      m = /\/api\/flow\/collections\/(\d+)\?shape=(\w+)&places=(\d)(?:&waves=(\d))?/.exec(url);
      if (m) {
        const shape = m[2], on = m[3] === '1', waves = m[4] ? Number(m[4]) : 2;
        const feats = srv.members.map(feat);
        const order = FlowOrder.planOrder(feats, { shape, waves }).order;
        const sum = FlowOrder.summary(feats, order);
        return ok({ shape, waves, order, playlistOrder: srv.members.slice(), features: feats, targets: FlowOrder.targetsFor(shape, feats),
          handovers: sum.handovers, jumps: sum.jumps, playlistJumps: 0, counts: { measured: feats.length, failed: 0, music: feats.length }, places: {}, placesOn: on });
      }
      return ok({ collection: { total: srv.members.length, measured: srv.members.length, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } });
    },
  };
  ctx.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  if (skips) vm.runInContext(`${SKIPS_SRC}\nglobalThis.__Skips = Skips;`, ctx);
  return { ctx, Flow: ctx.window.Flow, Library, toasts, undos, emit: (t) => (listeners[t] || []).forEach(fn => fn({})) };
}

const grid = (p) => Array.from(p.Library.ids);
// What the order is called (the count line says it too, lower case for a shape: countText).
const pill = (p) => `Flow order: ${p.Flow.saved.name()}`;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

test('save the working order under a name, then load it back fitted to the files there are now', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.Flow.pickShape('waves', 3);
  // A move, so the order is not what Waves works out.
  const g = grid(p);
  await p.Flow.moveInOrder([g[g.length - 1]], g[0]);
  const mine = p.Flow.workingOrder();
  assert.strictEqual(pill(p), 'Flow order: Waves, edited');

  assert.strictEqual(await p.Flow.saved.save('  Friday set '), true);
  // What was sent: the name, shape, peaks, Place tagged files and the whole working order.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.posts[0])), { name: 'Friday set', shape: 'waves', waves: 3, places: false, order: mine });
  assert.strictEqual(p.Flow.saved.active(), srv.saved[0].id, 'saving makes it the active one');
  assert.strictEqual(pill(p), 'Flow order: Friday set');
  assert.strictEqual(p.Flow.countText(), 'Flow order: Friday set');
  assert.match(p.Flow.saved.html(), /flow-chip on/);
  assert.match(p.Flow.saved.html(), /Friday set<\/span><span class="flow-chip-shape">Waves 3</);

  // A taken name (any case): said, nothing saved.
  assert.strictEqual(await p.Flow.saved.save('FRIDAY SET'), false);
  assert.match(p.toasts.at(-1), /already a saved order called/);
  assert.strictEqual(srv.posts.length, 1);

  // Moved again: ", edited", and Update puts the moves in it.
  await p.Flow.moveInOrder([grid(p)[2]], null);
  assert.strictEqual(p.Flow.saved.edited(), true);
  assert.strictEqual(pill(p), 'Flow order: Friday set, edited');
  assert.strictEqual(p.Flow.countText(), 'Flow order: Friday set, edited');
  // Edited shows on the chip as a dot; Update is in its ⋯ menu, not under the chart.
  assert.match(p.Flow.saved.html(), /flow-chip on is-edited/);
  assert.match(p.Flow.saved.html(), /flow-chip-dot/);
  const moved = p.Flow.workingOrder();
  await p.Flow.saved.update(srv.saved[0].id);
  assert.deepStrictEqual(srv.saved[0].order, moved);
  assert.strictEqual(pill(p), 'Flow order: Friday set');
  // Update's Undo puts the saved order back as it was.
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(srv.saved[0].order, mine);
  assert.strictEqual(pill(p), 'Flow order: Friday set, edited');

  // A built-in shape lets go of it.
  await p.Flow.pickShape('build');
  assert.strictEqual(p.Flow.saved.active(), null);
  assert.strictEqual(pill(p), 'Flow order: Build up');
  assert.doesNotMatch(p.Flow.saved.html(), /flow-chip on/);
  assert.strictEqual(JSON.parse(srv.store.get(`vault.flow.order.${CID}`)).saved, null);

  // The collection changes: file 2 removed, file 9 added.
  srv.members = srv.members.filter(id => id !== 2).concat(9);
  await p.Flow.saved.use(srv.saved[0].id);
  const want = FlowOrder.reconcileOrder(mine, srv.members);
  assert.deepStrictEqual(want.slice(0, -1), mine.filter(id => id !== 2));
  assert.strictEqual(want.at(-1), 9, 'the new file at the end');
  assert.deepStrictEqual(p.Flow.workingOrder(), want);
  assert.deepStrictEqual(grid(p), want, 'the grid shows the saved order');
  assert.deepStrictEqual(p.Flow._view.order(), want, 'the chart shows the same');
  const s = p.Flow._state();
  assert.deepStrictEqual({ shape: s.shape, waves: s.waves, places: s.places, order: s.order }, { shape: 'waves', waves: 3, places: false, order: true });
  assert.strictEqual(pill(p), 'Flow order: Friday set', 'fitted to the files is not an edit');
  assert.strictEqual(JSON.parse(srv.store.get(`vault.flow.order.${CID}`)).saved, srv.saved[0].id);

  // Back to playlist order lets go of it too.
  await p.Flow.usePlaylistOrder();
  assert.strictEqual(p.Flow.saved.active(), null);
  assert.strictEqual(srv.store.has(`vault.flow.order.${CID}`), false);
});

test('a reload comes back to the saved order it was showing', async () => {
  const srv = server();
  const a = page(srv);
  await a.Flow.toggle(CID);
  await a.Flow.pickShape('peak');
  await a.Flow.saved.save('Peak night');
  const order = a.Flow.workingOrder();

  const b = page(srv);       // the same server and localStorage: a reload
  b.emit('vault:results-changed');
  await settle();
  assert.strictEqual(b.Flow.saved.active(), srv.saved[0].id);
  assert.deepStrictEqual(b.Flow.workingOrder(), order);
  assert.strictEqual(pill(b), 'Flow order: Peak night');
});

test('Delete lets go of the active one; Undo brings it back as the active one', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.Flow.pickShape('steady');
  await p.Flow.saved.save('Keep');
  await p.Flow.saved.save('Other');
  const id = p.Flow.saved.active();
  await p.Flow.saved.remove(id);
  assert.deepStrictEqual(srv.saved.map(s => s.name), ['Keep']);
  assert.strictEqual(p.Flow.saved.active(), null);
  assert.strictEqual(pill(p), 'Flow order: Steady, edited', 'the order stays, the name goes');
  assert.match(p.undos.at(-1).m, /Deleted the saved order “Other”/);
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(srv.saved.map(s => s.name), ['Keep', 'Other']);
  assert.strictEqual(p.Flow.saved.active(), srv.saved[1].id);
  assert.strictEqual(pill(p), 'Flow order: Other');
  // Rename.
  assert.strictEqual(await p.Flow.saved.rename(srv.saved[1].id, 'keep'), false, 'taken, ignoring case');
  assert.strictEqual(await p.Flow.saved.rename(srv.saved[1].id, 'Sunday'), true);
  assert.strictEqual(pill(p), 'Flow order: Sunday');
});

test('switching between saved orders offers Undo only for moves that were not saved', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.Flow.pickShape('waves', 2);
  await p.Flow.saved.save('A');
  await p.Flow.pickShape('build');
  await p.Flow.saved.save('B');
  const n = p.undos.length;
  await p.Flow.saved.use(srv.saved[0].id);
  assert.strictEqual(p.undos.length, n, 'B as saved: nothing dropped, no Undo');
  await p.Flow.moveInOrder([grid(p)[0]], null);
  await p.Flow.saved.use(srv.saved[1].id);
  assert.match(p.undos.at(-1).m, /Switched to “B”, so your moves/);
  await p.undos.at(-1).fn();
  assert.strictEqual(pill(p), 'Flow order: A, edited');
});

test('nothing under the chart saves: Update is in the chip menu, the top row says Make this the playlist order', () => {
  const src = require('node:fs').readFileSync(require.resolve('../player-lib/flow.js'), 'utf8');
  assert.ok(!src.includes('data-flow-save>') && !src.includes('data-flow-saved-update'), 'no save buttons in the panel');
  assert.ok(src.includes('>Make this the playlist order</button>'));
  assert.ok(!src.includes('>Save as playlist order<'));
});

/* ── Saved from Playlist order (a variation of the playlist) ─────────── */

test('in Playlist order, Save this order keeps the playlist order as it is on screen, and Playlist order stays on', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  if (p.Flow._state().order) await p.Flow.usePlaylistOrder();
  // The playlist as rearranged on screen (collection-reorder.js keeps the page's copy).
  const mine = [3, 1, 2, 8, 7, 6, 5, 4];
  p.ctx.collectionMembers = new Map([[CID, mine]]);
  p.Library.spec = { collectionId: CID, rankedIds: null };
  p.Library.ids = Uint32Array.from(mine);
  assert.match(p.Flow.saved.html(), /data-flow-saved-new[^>]*title="Keep the playlist order as it is now/, 'the chip shows in Playlist order too');
  assert.strictEqual(await p.Flow.saved.save('My mix'), true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.posts[0])), { name: 'My mix', shape: 'playlist', waves: 2, places: false, order: mine });
  assert.strictEqual(p.Flow._state().order, false, 'still Playlist order');
  assert.strictEqual(p.Flow.saved.active(), null);
  assert.match(p.Flow.saved.html(), /My mix<\/span><span class="flow-chip-shape">from playlist</);
  assert.doesNotMatch(p.Flow.saved.html(), /flow-chip on/);

  // Clicking it shows that order; no shape is taken from it.
  const shapeBefore = p.Flow._state().shape;
  await p.Flow.saved.use(srv.saved[0].id);
  assert.deepStrictEqual(p.Flow.workingOrder(), mine);
  assert.deepStrictEqual(grid(p), mine, 'the grid plays it');
  assert.strictEqual(p.Flow._state().shape, shapeBefore);
  assert.strictEqual(p.Flow.countText(), 'Flow order: My mix');

  // Flow order on the switch: the shape worked out afresh, the saved one let go.
  await p.Flow.useFlowOrder();
  assert.strictEqual(p.Flow.saved.active(), null);
  const feats = srv.members.map(feat);
  assert.deepStrictEqual(p.Flow.workingOrder(), FlowOrder.planOrder(feats, { shape: shapeBefore, waves: 2 }).order);
});

test('in Playlist order, Update with this order puts the playlist order in a saved one and stays', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  await p.Flow.pickShape('peak');
  await p.Flow.saved.save('Peak');
  await p.Flow.usePlaylistOrder();
  const mine = [8, 7, 6, 5, 4, 3, 2, 1];
  p.ctx.collectionMembers = new Map([[CID, mine]]);
  p.Library.spec = { collectionId: CID, rankedIds: null };
  p.Library.ids = Uint32Array.from(mine);
  await p.Flow.saved.update(srv.saved[0].id);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(srv.puts.at(-1))), { shape: 'playlist', waves: 2, places: false, order: mine });
  assert.strictEqual(p.Flow._state().order, false);
  // Undo puts the shape and the order back.
  await p.undos.at(-1).fn();
  assert.strictEqual(srv.saved[0].shape, 'peak');
});

test('Save this order and Update keep the order on screen: a sort or a shuffle as shown; files a search hides keep their place', async () => {
  const srv = server();
  const p = page(srv);
  await p.Flow.toggle(CID);
  if (p.Flow._state().order) await p.Flow.usePlaylistOrder();
  p.ctx.collectionMembers = new Map([[CID, [1, 2, 3, 4, 5, 6, 7, 8]]]);
  // Sorted by name (or shuffled): the grid shows another order than the playlist's.
  const shown = [5, 4, 8, 6, 7, 1, 2, 3];
  p.Library.spec = { collectionId: CID, rankedIds: null };
  p.Library.ids = Uint32Array.from(shown);
  assert.strictEqual(await p.Flow.saved.save('By name'), true);
  assert.deepStrictEqual(srv.posts.at(-1).order, shown);
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

test("a saved order keeps its own skips: copied when saved, changed while it shows, the playlist's left alone", async () => {
  const srv = server();
  const p = page(srv, { skips: true });
  const S = p.ctx.__Skips;
  S.take(CID, [1]);                       // the playlist's own skips
  await p.Flow.toggle(CID);
  await p.Flow.pickShape('smooth');
  await p.Flow.saved.save('Night');
  assert.deepStrictEqual(srv.posts[0].skips, [1], 'the skips in use are copied');
  // Showing it: its skips are the ones read and written.
  await S.set(CID, [2], true);
  assert.deepStrictEqual(srv.puts.at(-1), { skips: [1, 2] });
  assert.deepStrictEqual([...S.setFor(CID)].sort(), [1, 2]);
  assert.deepStrictEqual([...S._byColl.get(CID)], [1], "the playlist's skips untouched");
  // Unskip all and Undo, on the saved order.
  await S.unskipAll(CID);
  assert.deepStrictEqual(srv.puts.at(-1), { skips: [] });
  assert.strictEqual(S.setFor(CID).size, 0);
  assert.match(p.undos.at(-1).m, /Unskipped 2 files in “Night”/);
  await p.undos.at(-1).fn();
  assert.deepStrictEqual([...S.setFor(CID)].sort(), [1, 2]);
  // Back to Playlist order: the playlist's skips again.
  await p.Flow.usePlaylistOrder();
  assert.deepStrictEqual([...S.setFor(CID)], [1]);
  await S.set(CID, [3], true).catch(() => {});   // the playlist's: the collection route, not the saved order
  assert.deepStrictEqual(srv.puts.at(-1), { skips: [1, 2] }, 'nothing written to the saved order');
});

test("a saved order from before skips plays with the playlist's until the first change gives it its own", async () => {
  const srv = server();
  srv.saved.push({ id: 50, collectionId: CID, name: 'Old', shape: 'build', waves: 2, places: false, order: [2, 1, 3, 4, 5, 6, 7, 8], skips: null, createdAt: 1, updatedAt: 1 });
  const p = page(srv, { skips: true });
  const S = p.ctx.__Skips;
  S.take(CID, [4]);
  await p.Flow.toggle(CID);
  await p.Flow.saved.load(CID);
  await p.Flow.saved.use(50);
  assert.deepStrictEqual([...S.setFor(CID)], [4], "the playlist's");
  await S.set(CID, [5], true);
  assert.deepStrictEqual(srv.puts.at(-1), { skips: [4, 5] });
  assert.deepStrictEqual([...S.setFor(CID)].sort(), [4, 5]);
  assert.deepStrictEqual([...S._byColl.get(CID)], [4]);
});
