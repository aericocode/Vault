'use strict';
/**
 * seen (POST /api/collections/:id/order): every order write a page sends
 * says which order it was showing, and the server refuses the write (409
 * STALE, nothing written) when that is not the order on disk. These tests
 * drive the real page code that sends them (collection-reorder.js whole:
 * drags, Alt+arrows, their Undo; collections.js: the page's turn for order
 * writes, its reads, Remove and its Undo) over one fake server shared by
 * two pages (two windows), with the real rules for what Flow keeps
 * (helpers/flow-custom-fake.js runs lib/flow/custom.js). Requests take a
 * little time, so writes and reads overlap as they do in a browser.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { flowCustomFake } = require('./helpers/flow-custom-fake');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CID = 5;
const A0 = [1, 2, 3, 4, 5, 6];
const SMOOTH = [6, 5, 4, 3, 2, 1];
const STALE_ACTION = 'This playlist was changed in another window. It is up to date now, so try that again.';
const STALE_UNDO = 'This order was changed in another window, so there was nothing to undo.';

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

/** The server: the order, what Flow keeps, every order write it was sent and what it answered. */
function newServer(order = A0) {
  const s = { order: order.slice(), custom: flowCustomFake(CID), log: [] };
  /** Another window's write, straight to the server (that window's page is not modelled). */
  s.write = (body) => {
    const r = s.custom.post(s.order.slice(), body);
    s.order = r.order.slice();
    return r;
  };
  s.row = () => s.custom.state(s.order);
  return s;
}

function handle(server, url, o) {
  const method = o.method || 'GET';
  const body = o.body ? JSON.parse(o.body) : null;
  if (url === `/api/collections/${CID}/order`) {
    let r;
    try { r = server.custom.post(server.order.slice(), body); } catch (err) {
      server.log.push({ body, status: err.code === 'STALE' ? 409 : 400 });
      return json({ error: err.message, code: err.code }, err.code === 'STALE' ? 409 : 400);
    }
    server.order = r.order.slice();
    server.log.push({ body, status: 200 });
    return json({ ...r, item_count: r.order.length, first_ids: r.order.slice(0, 4) });
  }
  if (url === `/api/collections/${CID}/items` && method === 'DELETE') {
    const orderBefore = server.order.slice();
    server.order = server.order.filter(m => !body.ids.includes(m));
    return json({ removed: orderBefore.length - server.order.length, item_count: server.order.length, first_ids: server.order.slice(0, 4),
      media_ids: server.order.slice(), order_before: orderBefore, flow_custom: server.row() });
  }
  if (url === `/api/collections/${CID}/items`) {
    const had = new Set(server.order);
    const added = body.ids.filter(m => !had.has(m));
    server.order.push(...added);
    return json({ added: added.length, item_count: server.order.length, first_ids: server.order.slice(0, 4) });
  }
  if (url === `/api/collections/${CID}`) return json({ media_ids: server.order.slice(), flow_custom: server.row(), item_count: server.order.length });
  throw new Error(`unexpected ${method} ${url}`);
}

/**
 * A page (a window) on the server. delay: how long a request takes each way
 * (the server acts in between). Its grid is what applyFilters last read.
 */
function page(server, { delay = 3 } = {}) {
  const toasts = [], undos = [], keys = [];
  let grid = server.order.slice();
  const Library = {
    shuffled: false, spec: { collectionId: CID, rankedIds: null }, search: null,
    row: (id) => ({ filename: `f${id}.mp4` }),
    indexOf: (id) => grid.indexOf(id), ownWrite: (p) => p,
    waitIds: async () => grid.slice(),
  };
  const main = { style: { display: '' }, classList: { contains: (c) => c === 'active' } };
  const ctx = {
    console, Promise, JSON, Set, Map, Error, Array, Object, Number, setTimeout, clearTimeout,
    COLL_ID_CHUNK: 50000,
    activeCollectionId: CID,
    collectionsList: [{ id: CID, kind: 'collection', name: 'Mix', item_count: server.order.length, first_ids: [] }],
    collectionMembers: new Map([[CID, server.order.slice()]]),
    selectedIds: new Set(),
    Library,
    collectionIsOpen: () => true,
    currentSortField: () => 'playlist',
    document: { addEventListener: (t, fn) => { if (t === 'keydown') keys.push(fn); }, querySelectorAll: () => [], querySelector: () => null, getElementById: (id) => (id === 'mainContainer' ? main : null) },
    window: { addEventListener() {} },
    selectionChanged() {}, syncTileCheckboxes() {}, renderSelectionBar() {},
    _patchPickerRow() {}, _patchAncestorCounts() {}, _applyToggleSideEffects() {},
    renderCollectionHeader() {}, renderCollectionCount() {},
    escapeHtml: (s) => String(s),
    showToast: (m) => toasts.push(String(m)),
    showErrorToast: (e) => toasts.push(`error: ${e.message}`),
    collErrorToast: (e) => toasts.push(`error: ${e.message}`),
    showUndoToast: (m, fn) => undos.push({ m, fn }),
    flowMembersChanged() {},
    flowRow: undefined,
    flowCustomAnswer: (id, data) => { if (data && data.flow_custom !== undefined) ctx.flowRow = data.flow_custom; },
    applyFilters: async () => { await sleep(delay); grid = server.order.slice(); },
    fetch: async (url, o = {}) => {
      await sleep(delay);
      const r = handle(server, url, o);
      await sleep(delay);
      return r;
    },
  };
  ctx.getCollectionById = (id) => ctx.collectionsList.find(c => c.id === id);
  vm.createContext(ctx);
  const fsrc = read('player-lib/flow.js');
  const coll = read('player-lib/collections.js');
  const names = ['collectionOrderTurn', 'collectionReadToken', 'collectionReadFresh', 'takeCollectionAnswer', 'takeCollectionLength', 'fetchCollectionMembers',
    'collResponseError', 'collectionUndoGuard', 'collectionResync', 'changeCollectionMembership', '_openMembersNow', '_untickLeftOpenCollection', '_retick',
    '_selectionRedraw', 'openPlainCollection', 'selectedInOpenCollection', 'removeSelectedFromCollection', 'undoRemoveFromCollection', '_undoRemoveNow'];
  vm.runInContext(
    ['flowGuardOf', 'flowKeepOf', 'flowUndoOf'].map(n => new RegExp(`function ${n}[\\s\\S]*?\\n}\\r?\\n`).exec(fsrc)[0]).join('\n')
    + `\nvar STALE_UNDO_TEXT = ${JSON.stringify(/const STALE_UNDO_TEXT = '([^']+)'/.exec(fsrc)[1])};`
    + `\nvar STALE_ACTION_TEXT = ${JSON.stringify(/const STALE_ACTION_TEXT = '([^']+)'/.exec(fsrc)[1])};`
    + '\n' + names.map(n => grab(coll, n)).join('\n'), ctx);
  vm.runInContext(read('player-lib/collection-reorder.js'), ctx);
  const p = {
    ctx, toasts, undos, server,
    grid: () => grid.slice(),
    cache: () => ctx.collectionMembers.get(CID).slice(),
    /** The library check after another window wrote: the collection read again. */
    catchUp: () => ctx.fetchCollectionMembers(CID, true),
    /** A drag of `id` in front of `before` (null: to the end). */
    drag: (id, before) => ctx.reorderMove([id], before),
    /** Alt+arrow with `id` ticked. */
    key: (id, key) => { ctx.selectedIds = new Set([id]); return keys[0]({ altKey: true, key, preventDefault() {}, target: null }); },
    remove: (ids) => { ctx.selectedIds = new Set(ids); return ctx.removeSelectedFromCollection(); },
    /** The page's own turn is idle (every write it started has its answer in). */
    idle: async () => { await (ctx.collectionOrderTurn.tail || Promise.resolve()); await sleep(delay * 4); },
  };
  return p;
}

const statuses = (s) => s.log.map(e => e.status);
const stale = (s) => s.log.filter(e => e.status === 409).length;
/** The lit button as the server has it: 'custom', a shape, or 'none'. */
const lit = (s) => { const r = s.row(); return !r || r.mode === 'custom' ? 'custom' : (r.mode === 'shape' ? r.shape : 'none'); };

/* ── another window first: refused, nothing written, the page reads again ── */

for (const delay of [0, 5]) {
  test(`r1 (drag, ${delay} ms a request): A Smooth, B catches up, A Custom, B drags from Smooth: refused, nothing written, a plain toast, no Undo, B shows A0; Waves then Custom gives A0`, async () => {
    const s = newServer();
    const b = page(s, { delay });
    s.write({ order: SMOOTH, flow: { shape: 'smooth' }, seen: A0 });     // A
    await b.catchUp();
    assert.deepStrictEqual(b.cache(), SMOOTH);
    s.write({ flow: { custom: true }, seen: SMOOTH });                    // A
    assert.deepStrictEqual(s.order, A0);
    const row = s.row(), u = b.undos.length;
    assert.strictEqual(await b.drag(1, 6), false);
    assert.deepStrictEqual(s.log.at(-1), { body: { move: [1], before: 6, flow: { manual: true }, seen: SMOOTH }, status: 409 });
    assert.deepStrictEqual(s.order, A0, 'the Smooth order is not written under Custom');
    assert.deepStrictEqual(s.row(), row, 'what Flow keeps is not touched');
    assert.strictEqual(b.toasts.at(-1), STALE_ACTION);
    assert.strictEqual(b.undos.length, u, 'no Undo');
    assert.deepStrictEqual(b.cache(), A0, 'B read it again');
    assert.deepStrictEqual(b.grid(), A0, 'the grid too: the tile is not left where it was dropped');
    assert.strictEqual(lit(s), 'custom');
    // Tried again, it goes through, and its Undo puts A0 back with Custom lit.
    assert.strictEqual(await b.drag(1, 6), true);
    await b.undos.at(-1).fn();
    assert.deepStrictEqual(s.order, A0);
    assert.strictEqual(lit(s), 'custom');
    s.write({ order: SMOOTH, flow: { shape: 'waves' }, seen: A0 });
    assert.deepStrictEqual(s.write({ flow: { custom: true }, seen: SMOOTH }).order, A0, 'Custom gives A0');
  });

  test(`r1 (Remove, ${delay} ms a request): B, showing Smooth, takes a file out after A's Custom; its Undo puts back the server's order (A0), not B's; Custom stays lit; Waves then Custom gives A0`, async () => {
    const s = newServer();
    const b = page(s, { delay });
    s.write({ order: SMOOTH, flow: { shape: 'smooth' }, seen: A0 });
    await b.catchUp();
    s.write({ flow: { custom: true }, seen: SMOOTH });
    await b.remove([3]);
    assert.deepStrictEqual(s.order, [1, 2, 4, 5, 6]);
    assert.deepStrictEqual(b.cache(), [1, 2, 4, 5, 6], 'the page takes the order the remove left');
    await b.undos.at(-1).fn();
    const last = s.log.at(-1);
    assert.strictEqual(last.status, 200, JSON.stringify(last));
    assert.deepStrictEqual(last.body.order, A0, 'the order from right before the remove, the server\'s');
    assert.deepStrictEqual(last.body.seen, [1, 2, 4, 5, 6, 3]);
    assert.deepStrictEqual(s.order, A0);
    assert.strictEqual(lit(s), 'custom', 'the lit button matches the order');
    assert.strictEqual(stale(s), 0);
    s.write({ order: SMOOTH, flow: { shape: 'waves' }, seen: A0 });
    assert.deepStrictEqual(s.write({ flow: { custom: true }, seen: SMOOTH }).order, A0);
  });
}

test('probe3 mirror: Peak lit over A0, A drags, B (still showing Peak) drags: refused; the lit button (nothing) matches the order; Custom gives A0', async () => {
  const s = newServer();
  const peak = [3, 1, 5, 2, 6, 4];
  s.write({ order: peak, flow: { shape: 'peak' }, seen: A0 });
  const a = page(s), b = page(s);
  assert.strictEqual(await a.drag(4, 3), true);
  const after = s.order.slice();
  assert.strictEqual(lit(s), 'none');
  assert.strictEqual(await b.drag(3, null), false);
  assert.strictEqual(s.log.at(-1).status, 409);
  assert.deepStrictEqual(s.order, after);
  assert.strictEqual(lit(s), 'none');
  assert.strictEqual(b.ctx.flowRow.mode, 'edited', 'B has the row A left');
  assert.deepStrictEqual(b.cache(), after);
  assert.deepStrictEqual(s.write({ flow: { custom: true }, seen: after }).order, A0);
});

test('Alt+arrow from a page behind another window: refused the same way, the file not moved', async () => {
  const s = newServer();
  const b = page(s);
  s.write({ order: SMOOTH, flow: { shape: 'smooth' }, seen: A0 });
  await b.key(2, 'ArrowLeft');
  assert.strictEqual(s.log.at(-1).status, 409);
  assert.deepStrictEqual(s.order, SMOOTH);
  assert.strictEqual(b.toasts.at(-1), STALE_ACTION);
  assert.deepStrictEqual(b.grid(), SMOOTH);
  await b.key(2, 'ArrowLeft');
  assert.deepStrictEqual(s.order, [6, 5, 4, 2, 3, 1], 'tried again it moves');
});

test('a drag\'s Undo after another window reordered (no row change): refused by seen, nothing written, the Undo words', async () => {
  const s = newServer();
  const b = page(s);
  assert.strictEqual(await b.drag(6, 1), true);
  const dragged = s.order.slice();
  s.write({ order: dragged.slice().reverse() });   // an older Vault, no flow
  await b.undos.at(-1).fn();
  assert.strictEqual(s.log.at(-1).status, 409);
  assert.deepStrictEqual(s.order, dragged.slice().reverse());
  assert.strictEqual(b.toasts.at(-1), STALE_UNDO);
  assert.deepStrictEqual(b.cache(), s.order);
});

/* ── one window: its own writes never trip the check ──────────────────── */

test('one window, quick: two drags at once, a drag and its Undo at once, held Alt+arrows, a remove then a drag: no 409, the order as asked', async () => {
  const s = newServer();
  const p = page(s, { delay: 4 });
  // Two drags without waiting.
  const d1 = p.drag(6, 1), d2 = p.drag(5, 1);
  assert.deepStrictEqual(await Promise.all([d1, d2]), [true, true]);
  assert.deepStrictEqual(s.order, [6, 5, 1, 2, 3, 4]);
  // A drag, then its Undo right away (before the drag's answer is in).
  const d3 = p.drag(1, null);
  await sleep(1);
  const undo = p.undos.at(-1);
  await d3;
  await Promise.all([p.undos.at(-1).fn(), undo.fn()]);
  // Held Alt+Left: keys while a move is on its way are dropped, never sent stale.
  const held = [];
  for (let i = 0; i < 8; i++) { held.push(p.key(4, 'ArrowLeft')); await sleep(2); }
  await Promise.all(held);
  await p.idle();
  assert.ok(s.order.indexOf(4) < 5, 'it moved left');
  // A remove, then a drag at once.
  const rm = p.remove([2]);
  const d4 = p.drag(3, 6);
  await Promise.all([rm, d4]);
  await p.idle();
  assert.strictEqual(s.order.includes(2), false);
  assert.deepStrictEqual(statuses(s).filter(x => x !== 200), [], `no 409: ${JSON.stringify(s.log.filter(e => e.status !== 200))}`);
  assert.deepStrictEqual(p.toasts.filter(t => t === STALE_ACTION || t === STALE_UNDO), []);
  assert.deepStrictEqual(p.cache(), s.order, 'the page has the server\'s order');
});

test('one window: a slow read that began before a drag does not put the older order back under the page (no 409 on the next drag)', async () => {
  const s = newServer();
  const p = page(s, { delay: 2 });
  // A read that takes long: the server answers at once, the answer lands late.
  const f0 = p.ctx.fetch;
  let slow = true;
  p.ctx.fetch = async (url, o = {}) => {
    if (slow && url === `/api/collections/${CID}`) { slow = false; const r = handle(s, url, o); await sleep(40); return r; }
    return f0(url, o);
  };
  const r = p.catchUp();
  await sleep(5);
  assert.strictEqual(await p.drag(6, 1), true);
  await r;
  assert.deepStrictEqual(p.cache(), [6, 1, 2, 3, 4, 5], 'the late read is not taken');
  assert.strictEqual(await p.drag(5, 1), true);
  assert.strictEqual(stale(s), 0);
});

test('Remove\'s Undo after the same window added a file: the order from before, the added file at the end (no error)', async () => {
  const s = newServer();
  const p = page(s);
  await p.remove([2]);
  await p.ctx.changeCollectionMembership(CID, [9], true, { quiet: true });
  assert.deepStrictEqual(p.cache(), [1, 3, 4, 5, 6, 9]);
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(s.order, [1, 2, 3, 4, 5, 6, 9]);
  assert.strictEqual(stale(s), 0);
  assert.deepStrictEqual(p.toasts.filter(t => /error|Could not/.test(t)), []);
});

test('a drag\'s Undo after the same window added a file: the order from before, the added file at the end', async () => {
  const s = newServer();
  const p = page(s);
  assert.strictEqual(await p.drag(6, 1), true);
  await p.ctx.changeCollectionMembership(CID, [9], true, { quiet: true });
  await p.undos.at(-1).fn();
  assert.deepStrictEqual(s.order, [1, 2, 3, 4, 5, 6, 9]);
  assert.strictEqual(stale(s), 0);
  assert.strictEqual(p.toasts.at(-1), 'Order put back');
});
