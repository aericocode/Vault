/**
 * The Flow panel follows every change to a collection's order or files
 * (beta report: the chart kept the old order after a drag until it was
 * hidden and shown again):
 *  - collection-reorder.js calls flowMembersChanged after a move (drag or
 *    Alt+arrows: reorderMove) and after Undo, with the server's order in
 *    the page's copy by then (there is one order: a move always saves);
 *  - collections.js calls it after files are taken out (and put back);
 *  - flow.js membersChanged: panel open, the chart's playlist order and
 *    jumps change at once and the server is asked once; panel closed,
 *    nothing is asked and the held answer is dropped.
 * Each browser script runs in a vm with a bare page.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FlowOrder = require('../player-lib/flow-order.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = (data, ok = true, status = 200) => ({ ok, status, json: async () => data, text: async () => JSON.stringify(data) });

/* ── collection-reorder.js ────────────────────────────────────────────── */

function reorderPage() {
  const server = [1, 2, 3, 4];
  const calls = [];
  const undos = [];
  const doc = { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null };
  const ctx = {
    console, document: doc, window: { addEventListener() {} }, setTimeout, Promise, JSON,
    activeCollectionId: 5,
    collectionMembers: new Map([[5, server.slice()]]),
    getCollectionById: () => ({ id: 5, kind: 'collection' }),
    currentSortField: () => 'playlist',
    Library: { shuffled: false, spec: { collectionId: 5 }, search: null, row: () => ({ filename: 'a.mp4' }), indexOf: () => 0, ownWrite: (p) => p },
    selectedIds: new Set(),
    applyFilters: async () => { calls.push('grid'); },
    escapeHtml: (s) => String(s),
    showToast() {},
    collErrorToast() {},
    showUndoToast: (msg, fn) => undos.push(fn),
    flowMembersChanged: (id) => calls.push(`flow:${id}:${ctx.collectionMembers.get(id).join(',')}`),
    fetch: async (url, o) => {
      const body = JSON.parse(o.body);
      let order;
      if (body.order) order = body.order.slice();
      else {
        const rest = server.filter(id => !body.move.includes(id));
        const at = body.before == null ? rest.length : rest.indexOf(body.before);
        order = [...rest.slice(0, at), ...body.move, ...rest.slice(at)];
      }
      server.splice(0, server.length, ...order);
      return json({ order, item_count: order.length, first_ids: order.slice(0, 4) });
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('player-lib/collection-reorder.js'), ctx);
  return { ctx, calls, undos, server };
}

test('a move in playlist order tells Flow, with the new order already in the page\'s copy', async () => {
  const p = reorderPage();
  assert.strictEqual(await p.ctx.reorderMove([4], 1), true);
  assert.deepStrictEqual(p.server, [4, 1, 2, 3]);
  assert.ok(p.calls.includes('flow:5:4,1,2,3'), p.calls.join(' | '));
  assert.ok(p.calls.indexOf('flow:5:4,1,2,3') < p.calls.lastIndexOf('grid'), 'Flow hears before the grid query finishes');
});

test('a move from Flow (reorderMove) scrolls nothing and focuses nothing in the grid', async () => {
  {
    const p = reorderPage();
    const log = [];
    const tile = { focus: () => log.push('focus'), scrollIntoView: () => log.push('scrollIntoView'), classList: { add() {}, remove() {} } };
    for (const fn of ['scrollTo', 'scrollBy', 'scroll']) p.ctx.window[fn] = () => log.push(fn);
    p.ctx.document.querySelector = () => tile;
    p.ctx.document.querySelectorAll = () => [tile];
    p.ctx.dockReveal = () => log.push('dockReveal');
    p.ctx.revealMediaIndex = () => log.push('revealMediaIndex');
    assert.strictEqual(await p.ctx.reorderMove([4], 1), true);
    assert.deepStrictEqual(log, []);
  }
});

test('Undo of a move tells Flow too', async () => {
  const p = reorderPage();
  await p.ctx.reorderMove([1], null);
  p.calls.length = 0;
  await p.undos[0]();
  assert.deepStrictEqual(p.server, [1, 2, 3, 4]);
  assert.ok(p.calls.includes('flow:5:1,2,3,4'));
});

test('a move is a hand order (flow manual: over a shape, edited) and Flow hears the answer; its Undo sends back the row from before, so a shape lit before is lit again', async () => {
  const { flowCustomFake } = require('./helpers/flow-custom-fake');
  const p = reorderPage();
  const fake = flowCustomFake(5);
  // Peak was picked (the order before it, 1..4, is kept).
  fake.post([1, 2, 3, 4], { order: [3, 1, 4, 2], flow: { shape: 'peak' } });
  p.server.splice(0, 4, 3, 1, 4, 2);
  p.ctx.collectionMembers.set(5, [3, 1, 4, 2]);
  const bodies = [], heard = [];
  p.ctx.fetch = async (url, o) => {
    const body = JSON.parse(o.body);
    bodies.push(body);
    const r = fake.post(p.server.slice(), body);
    p.server.splice(0, p.server.length, ...r.order);
    return json({ ...r, item_count: r.order.length, first_ids: r.order.slice(0, 4) });
  };
  p.ctx.flowCustomAnswer = (id, data) => heard.push([id, data.flow_custom && data.flow_custom.mode]);
  // flow.js's helper, as the page has it.
  vm.runInContext(/function flowUndoOf[\s\S]*?\n}\r?\n/.exec(read('player-lib/flow.js'))[0], p.ctx);
  const peakRow = fake.state(p.server.slice());
  assert.strictEqual(await p.ctx.reorderMove([2], 3), true);
  assert.deepStrictEqual(bodies[0], { move: [2], before: 3, flow: { manual: true } });
  assert.deepStrictEqual(heard.at(-1), [5, 'edited'], 'a shape changed by hand: nothing lit');
  await p.undos[0]();
  assert.deepStrictEqual(bodies[1].order, [3, 1, 4, 2]);
  assert.deepStrictEqual(bodies[1].flow.restore.mode, 'shape');
  assert.deepStrictEqual(heard.at(-1), [5, 'shape'], 'Peak lit again');
  assert.deepStrictEqual(fake.state(p.server.slice()), peakRow, 'the row exactly');
  // With nothing kept, a move's Undo sends no flow.
  const q = reorderPage();
  q.ctx.flowUndoOf = p.ctx.flowUndoOf;
  const sent = [];
  const f2 = flowCustomFake(5);
  q.ctx.fetch = async (url, o) => { const b = JSON.parse(o.body); sent.push(b); const r = f2.post(q.server.slice(), b); q.server.splice(0, 4, ...r.order); return json({ ...r, item_count: 4 }); };
  await q.ctx.reorderMove([1], null);
  await q.undos[0]();
  assert.deepStrictEqual(sent[1], { order: [1, 2, 3, 4] });
});

test('the note over the grid: Drag tiles to rearrange in playlist order, the shuffle note after a shuffle', () => {
  const noteFor = (over = {}) => {
    const p = reorderPage();
    const note = { innerHTML: 'old', hidden: false, classList: { toggle() {} } };
    p.ctx.document.getElementById = (id) => (id === 'collReorderNote' ? note : null);
    Object.assign(p.ctx.Library, over);
    p.ctx.renderReorderNote();
    return note;
  };
  const plain = noteFor();
  assert.match(plain.innerHTML, /Drag tiles to rearrange/);
  assert.strictEqual(plain.hidden, false);
  assert.match(noteFor({ shuffled: true }).innerHTML, /Showing a shuffled order/);
  const src = read('player-lib/collection-reorder.js') + read('player-lib/flow.js') + read('player-lib/filters.js') + read('player-lib/collections.js');
  assert.doesNotMatch(src, /flowOrderOn|flowWorkingOrder|flowMoveInOrder|flowLeaveOrder|flowQueryRanked|flowCountText/, 'no second order to ask about');
});

/* ── collections.js: taking files out, putting them back ──────────────── */

function grab(src, name) {
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

test('taking files out of a collection, and Undo, tell Flow once the server has the change', async () => {
  const server = [1, 2, 3, 4, 5];
  const flow = [];
  const undos = [];
  const ctx = {
    console, Promise, JSON, Set, Map, Error,
    COLL_ID_CHUNK: 50000,
    activeCollectionId: 5,
    collectionsList: [{ id: 5, kind: 'collection', name: 'Mix', item_count: 5, first_ids: [] }],
    collectionMembers: new Map([[5, server.slice()]]),
    selectedIds: new Set([2]),
    selectionChanged() {}, syncTileCheckboxes() {}, renderSelectionBar() {},
    _patchPickerRow() {}, _patchAncestorCounts() {}, _applyToggleSideEffects() {},
    renderCollectionHeader() {}, applyFilters: async () => {},
    escapeHtml: (s) => String(s), showToast() {}, showErrorToast() {}, collErrorToast() {},
    collResponseError: async () => new Error('refused'),
    showUndoToast: (msg, fn) => undos.push(fn),
    flowMembersChanged: (id) => flow.push(`${id}:${server.join(',')}`),
    fetch: async (url, o = {}) => {
      const method = o.method || 'GET';
      const body = o.body ? JSON.parse(o.body) : null;
      if (method === 'GET') return json({ media_ids: server.slice() });
      if (url.endsWith('/items') && method === 'DELETE') server.splice(0, server.length, ...server.filter(m => !body.ids.includes(m)));
      else if (url.endsWith('/items')) server.push(...body.ids.filter(m => !server.includes(m)));
      else if (url.endsWith('/order')) { server.splice(0, server.length, ...body.order); return json({ order: server.slice(), item_count: server.length }); }
      return json({ item_count: server.length, first_ids: server.slice(0, 4) });
    },
  };
  ctx.getCollectionById = (id) => ctx.collectionsList.find(c => c.id === id);
  vm.createContext(ctx);
  const coll = read('player-lib/collections.js');
  const names = ['takeCollectionAnswer', 'takeCollectionLength', 'fetchCollectionMembers', 'changeCollectionMembership', '_openMembersNow', '_untickLeftOpenCollection', '_retick',
    '_selectionRedraw', 'openPlainCollection', 'selectedInOpenCollection', 'removeSelectedFromCollection', 'undoRemoveFromCollection'];
  vm.runInContext(names.map(n => grab(coll, n)).join('\n') + `\nglobalThis.__c = { ${names.join(', ')} };`, ctx);
  await ctx.__c.removeSelectedFromCollection();
  assert.deepStrictEqual(flow, ['5:1,3,4,5'], 'after the server took it out');
  await undos[0]();
  assert.deepStrictEqual(flow, ['5:1,3,4,5', '5:1,2,3,4,5']);
});

test('an order read again from the server that differs (another window) tells Flow; the same order does not', () => {
  const synced = [];
  const ctx = {
    console, Set, Map,
    activeCollectionId: 5,
    collectionsList: [{ id: 5, kind: 'collection', name: 'Mix' }],
    collectionMembers: new Map([[5, [1, 2, 3]]]),
    flowOrderSynced: (id) => synced.push(id),
    renderCollectionCount() {},
  };
  ctx.getCollectionById = (id) => ctx.collectionsList.find(c => c.id === id);
  vm.createContext(ctx);
  const coll = read('player-lib/collections.js');
  vm.runInContext(['takeCollectionAnswer', 'takeCollectionLength'].map(n => grab(coll, n)).join('\n') + '\nglobalThis.__t = takeCollectionAnswer;', ctx);
  ctx.__t(5, { media_ids: [1, 2, 3] });
  assert.deepStrictEqual(synced, [], 'the same order');
  ctx.__t(5, { media_ids: [3, 1, 2] });
  assert.deepStrictEqual(synced, [5], 'reordered elsewhere');
  ctx.__t(5, { media_ids: [3, 1, 2, 4] });
  assert.deepStrictEqual(synced, [5, 5], 'a file came');
  ctx.__t(5, { order: [1, 2, 3, 4] });
  assert.deepStrictEqual(synced, [5, 5], 'an answer to this page\'s own write (no media_ids) is not a sync');
});

test('the collection read again hands Flow what it keeps for Custom, even when no file moved (another window changed only which button is lit)', () => {
  const told = [];
  const ctx = {
    console, Set, Map,
    activeCollectionId: 5,
    collectionsList: [{ id: 5, kind: 'collection', name: 'Mix' }],
    collectionMembers: new Map([[5, [1, 2, 3]]]),
    flowOrderSynced() {},
    flowCustomAnswer: (id, data, opts) => told.push([id, data.flow_custom && data.flow_custom.mode, opts]),
    renderCollectionCount() {},
  };
  ctx.getCollectionById = (id) => ctx.collectionsList.find(c => c.id === id);
  vm.createContext(ctx);
  const coll = read('player-lib/collections.js');
  vm.runInContext(['takeCollectionAnswer', 'takeCollectionLength'].map(n => grab(coll, n)).join('\n') + '\nglobalThis.__t = takeCollectionAnswer;', ctx);
  ctx.__t(5, { media_ids: [1, 2, 3], flow_custom: { mode: 'edited' } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(told)), [[5, 'edited', { read: true }]]);
  ctx.__t(5, { media_ids: [1, 2, 3], flow_custom: null });
  assert.strictEqual(told.length, 2, 'no row is an answer too (Custom lit)');
  ctx.__t(5, { media_ids: [1, 2, 3] });
  ctx.__t(5, { order: [1, 2, 3], flow_custom: null });
  assert.strictEqual(told.length, 2, 'an older server, or this page\'s own write answer (taken elsewhere): not a read');
});

/* ── flow.js membersChanged ───────────────────────────────────────────── */

function flowPage() {
  const urls = [];
  const server = { playlist: [1, 2, 3] };
  const feats = [
    { id: 1, measured: true, music: true, es: 0.2, em: 0.2, ee: 0.2, bs: 120, bm: 120, be: 120 },
    { id: 2, measured: true, music: true, es: 0.9, em: 0.9, ee: 0.9, bs: 120, bm: 120, be: 120 },
    { id: 3, measured: true, music: true, es: 0.25, em: 0.25, ee: 0.25, bs: 120, bm: 120, be: 120 },
  ];
  const answer = () => ({
    shape: 'smooth', edges: 'off', order: [1, 3, 2], playlistOrder: server.playlist.slice(), features: feats, targets: null,
    handovers: [], jumps: 0, playlistJumps: FlowOrder.summary(feats, server.playlist).jumps,
    counts: { measured: 3, failed: 0, music: 3 }, places: {}, placesOn: false,
  });
  const ctx = {
    console, FlowOrder,
    activeCollectionId: 3,
    collectionMembers: new Map([[3, [1, 2, 3]]]),
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    applyFilters: async () => {},
    Library: {},
    fetch: async (url) => {
      urls.push(url);
      if (/\/api\/flow\/collections\/\d+\?/.test(url)) return json(answer());
      return json({ collection: { total: 3, measured: 3, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } });
    },
  };
  ctx.window = { addEventListener() {}, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(read('player-lib/flow.js'), ctx);
  const asks = () => urls.filter(u => /\/api\/flow\/collections\/\d+\?/.test(u)).length;
  return { ctx, Flow: ctx.window.Flow, server, asks };
}

test('panel open: a reorder shows in the chart at once, then the server is asked once', async () => {
  const p = flowPage();
  await p.Flow.toggle(3);
  assert.deepStrictEqual(p.Flow._state().data.playlistOrder, [1, 2, 3]);
  assert.strictEqual(p.Flow._state().data.playlistJumps, 2);
  const n = p.asks();
  p.server.playlist = [1, 3, 2];
  p.ctx.collectionMembers.set(3, [1, 3, 2]);
  const pending = p.ctx.flowMembersChanged(3);
  assert.deepStrictEqual(p.Flow._state().data.playlistOrder, [1, 3, 2], 'drawn from the page\'s copy before the answer');
  assert.strictEqual(p.Flow._state().data.playlistJumps, 1);
  await pending;
  assert.strictEqual(p.asks(), n + 1);
  assert.deepStrictEqual(p.Flow._state().data.playlistOrder, [1, 3, 2]);
});

test('panel open: files taken out are asked for (the chart loses them)', async () => {
  const p = flowPage();
  await p.Flow.toggle(3);
  const n = p.asks();
  p.server.playlist = [1, 3];
  p.ctx.collectionMembers.set(3, [1, 3]);
  await p.ctx.flowMembersChanged(3);
  assert.strictEqual(p.asks(), n + 1);
  assert.deepStrictEqual(p.Flow._state().data.playlistOrder, [1, 3]);
});

test('panel closed: nothing asked, the answer dropped', async () => {
  const q = flowPage();
  await q.Flow.toggle(3);
  q.Flow.close();
  const n = q.asks();
  q.ctx.collectionMembers.set(3, [3, 2, 1]);
  assert.strictEqual(q.ctx.flowMembersChanged(3), null);
  assert.strictEqual(q.asks(), n, 'nothing asked while nothing shows it');
  assert.strictEqual(q.Flow._state().data, null, 'Flow shuffle and the next open ask afresh');
  // Another collection: nothing at all.
  assert.strictEqual(q.ctx.flowMembersChanged(9), null);
});
