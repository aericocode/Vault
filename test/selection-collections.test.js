/**
 * Ticking files in an open collection:
 *  - the selection bar (and Select page / Select all) shows for a collection
 *    opened in the Collections tab, not only in the Library tab
 *    (player-lib/selection.js selectionGridShowing);
 *  - a press on a tile's tick box or one of its buttons is a click, never
 *    the start of a rearranging drag, even when the mouse moves a little
 *    (player-lib/collection-reorder.js); a drag from the rest of the tile
 *    still rearranges.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** One top-level function of a browser script, by its name. */
function grab(src, name) {
  let at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is there`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let depth = 0;
  // The body's brace: after the parameter list (a default can hold braces too).
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${name}: no end`);
}

/* ── The selection bar's tabs ─────────────────────────────────────────── */

const sel = read('player-lib/selection.js');

function showing(currentTab, activeCollectionId) {
  const ctx = { currentTab, activeCollectionId };
  vm.createContext(ctx);
  vm.runInContext(`${grab(sel, 'selectionGridShowing')}\nglobalThis.__r = selectionGridShowing();`, ctx);
  return ctx.__r;
}

test('the selection bar belongs to the Library tab and to a collection open in the Collections tab', () => {
  assert.strictEqual(showing('library', null), true);
  assert.strictEqual(showing('library', 7), true, 'a collection opened from the Library tab');
  assert.strictEqual(showing('collections', 7), true, 'a collection opened in the Collections tab');
  assert.strictEqual(showing('collections', null), false, 'the collection cards are not files');
  for (const tab of ['faces', 'editor', 'games', 'wall']) assert.strictEqual(showing(tab, null), false, tab);
});

test('the bar and the Select page / Select all row both ask selectionGridShowing', () => {
  const bar = grab(sel, 'renderSelectionBar');
  assert.match(bar, /const onLibrary = selectionGridShowing\(\);/);
  const row = grab(sel, 'renderResultsSelect');
  assert.match(row, /const onLibrary = selectionGridShowing\(\);/);
  assert.ok(!/currentTab === 'library'/.test(bar + row), 'no Library-tab-only test left in either');
});

/* ── A press on the tick box is a click, not a drag ───────────────────── */

/** A tile element: its tick box, its buttons and its thumbnail. */
function fakeTile(id) {
  const tile = { dataset: { id: String(id) }, kids: [], classList: { add() {}, remove() {}, toggle() {} } };
  tile.hasAttribute = (a) => a === 'draggable';
  tile.contains = (el) => el === tile || tile.kids.includes(el);
  tile.closest = (q) => (q.startsWith('.media-tile') ? tile : q === '#resultsGrid' ? {} : null);
  const part = (tag, cls, inActions = false) => {
    const el = { tag, cls };
    el.closest = (q) => {
      if (q.startsWith('.media-tile')) return tile;
      if (q === '#resultsGrid') return {};
      const sels = q.split(',').map(s => s.trim());
      if (sels.includes(tag) || sels.includes(`.${cls}`)) return el;
      if (inActions && sels.includes('.tile-actions')) return { actions: true };
      return null;
    };
    tile.kids.push(el);
    return el;
  };
  tile.box = part('input', 'tile-select');
  tile.star = part('button', 'tile-btn', true);
  tile.thumb = part('img', 'tile-img');
  tile.name = part('div', 'tile-name');
  return tile;
}

function reorderPage() {
  const on = {};
  const doc = {
    addEventListener: (t, fn) => { (on[t] = on[t] || []).push(fn); },
    querySelectorAll: () => [],
    getElementById: () => null,
  };
  const ctx = {
    document: doc, window: { addEventListener() {} }, setTimeout: () => 0, console,
    activeCollectionId: 5,
    collectionMembers: new Map([[5, [1, 2, 3]]]),
    getCollectionById: () => ({ id: 5, kind: 'collection' }),
    currentSortField: () => 'playlist',
    Library: { shuffled: false, spec: { collectionId: 5 }, search: null, row: () => ({ filename: 'a.mp4' }), indexOf: () => 0 },
    selectedIds: new Set(),
  };
  vm.createContext(ctx);
  vm.runInContext(read('player-lib/collection-reorder.js'), ctx);
  const fire = (type, e) => { for (const fn of on[type] || []) fn(e); };
  /** Press on `from`, then the browser's dragstart on the tile. True when the drag goes ahead. */
  const dragFrom = (tile, from) => {
    fire('pointerdown', { target: from });
    let prevented = false;
    const dt = { setData() {}, effectAllowed: '' };
    fire('dragstart', { target: tile, dataTransfer: dt, preventDefault: () => { prevented = true; } });
    fire('dragend', {});
    return !prevented;
  };
  return { dragFrom };
}

test('a press on the tick box or a tile button never starts a rearranging drag; the rest of the tile still does', () => {
  const p = reorderPage();
  const tile = fakeTile(2);
  assert.strictEqual(p.dragFrom(tile, tile.box), false, 'the tick box: a click');
  assert.strictEqual(p.dragFrom(tile, tile.star), false, 'a tile button: a click');
  assert.strictEqual(p.dragFrom(tile, tile.thumb), true, 'the picture: a drag');
  assert.strictEqual(p.dragFrom(tile, tile.name), true, 'the name: a drag');
});

/* ── Remove from this collection (collections.js, in a VM) ────────────── */

const coll = read('player-lib/collections.js');

/** The collections code the selection bar uses, with a fake server holding collection 5 = [1..5]. */
function collectionsVm({ failDelete = false } = {}) {
  const server = new Map([[5, [1, 2, 3, 4, 5]]]);
  const requests = [];
  const toasts = [];
  const undos = [];
  let refreshed = 0;
  const json = (data, ok = true, status = 200) => ({ ok, status, json: async () => data, text: async () => JSON.stringify(data) });
  const ctx = {
    console, Promise, JSON, Set, Map, Error,
    COLL_ID_CHUNK: 50000,
    activeCollectionId: 5,
    collectionsList: [{ id: 5, kind: 'collection', name: 'Road <trip>', item_count: 5, first_ids: [] }],
    collectionMembers: new Map([[5, [1, 2, 3, 4, 5]]]),
    selectedIds: new Set(),
    selectionChanged() {}, syncTileCheckboxes() {}, renderSelectionBar() {},
    _patchPickerRow() {}, _patchAncestorCounts() {},
    _applyToggleSideEffects() { refreshed++; },
    renderCollectionHeader() {},
    applyFilters: async () => { refreshed++; },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    showToast: (m) => toasts.push(m),
    showErrorToast: (e, what) => toasts.push(`error: ${what}`),
    collErrorToast: (e, what) => toasts.push(`error: ${what}`),
    collResponseError: async () => new Error('refused'),
    showUndoToast: (msg, fn) => undos.push({ msg, fn }),
    fetch: async (url, o = {}) => {
      const method = o.method || 'GET';
      const body = o.body ? JSON.parse(o.body) : null;
      requests.push(`${method} ${url}`);
      const id = 5;
      const list = server.get(id);
      if (url === '/api/collections/5' && method === 'GET') return json({ media_ids: list });
      if (url === '/api/collections/5/items' && method === 'DELETE') {
        if (failDelete) return json({ error: 'no' }, false, 500);
        server.set(id, list.filter(m => !body.ids.includes(m)));
        return json({ item_count: server.get(id).length, first_ids: server.get(id).slice(0, 4) });
      }
      if (url === '/api/collections/5/items' && method === 'POST') {
        server.set(id, list.concat(body.ids.filter(m => !list.includes(m))));
        return json({ item_count: server.get(id).length });
      }
      if (url === '/api/collections/5/order' && method === 'POST') {
        server.set(id, body.order.slice());
        return json({ order: body.order, item_count: body.order.length, first_ids: body.order.slice(0, 4) });
      }
      return json({}, false, 404);
    },
  };
  ctx.getCollectionById = (id) => ctx.collectionsList.find(c => c.id === id);
  vm.createContext(ctx);
  const names = ['fetchCollectionMembers', 'changeCollectionMembership', '_openMembersNow', '_untickLeftOpenCollection', '_retick',
    '_selectionRedraw', 'openPlainCollection', 'selectedInOpenCollection', 'removeSelectedFromCollection', 'undoRemoveFromCollection'];
  vm.runInContext(names.map(n => grab(coll, n)).join('\n') + `\nglobalThis.__c = { ${names.join(', ')} };`, ctx);
  return { ctx, c: ctx.__c, server, requests, toasts, undos, refreshed: () => refreshed };
}

test('Remove from this collection: the ticked files leave it, are unticked, and Undo puts them back in their places', async () => {
  const v = collectionsVm();
  v.ctx.selectedIds = new Set([2, 4, 99]);       // 99: ticked, not in this collection
  assert.deepStrictEqual([...v.c.selectedInOpenCollection()], [2, 4]);
  await v.c.removeSelectedFromCollection();
  assert.deepStrictEqual(v.server.get(5), [1, 3, 5]);
  assert.deepStrictEqual(v.ctx.collectionMembers.get(5), [1, 3, 5]);
  assert.deepStrictEqual([...v.ctx.selectedIds], [99], 'only the removed files are unticked');
  assert.ok(v.refreshed() >= 2, 'the grid is refreshed again once the server has the change');
  assert.deepStrictEqual(v.toasts, [], 'no second toast beside the Undo one');
  assert.strictEqual(v.undos.length, 1);
  assert.strictEqual(v.undos[0].msg, 'Removed 2 files from Road &lt;trip&gt;', 'the name is escaped (the Undo toast takes HTML)');
  await v.undos[0].fn();
  assert.deepStrictEqual(v.server.get(5), [1, 2, 3, 4, 5], 'back in, in the old order');
  assert.deepStrictEqual(v.ctx.collectionMembers.get(5), [1, 2, 3, 4, 5]);
  assert.strictEqual(v.toasts.pop(), 'Put back in Road <trip>');
});

test('Remove from this collection: nothing for a folder; a refused change leaves the files ticked', async () => {
  const f = collectionsVm();
  f.ctx.collectionsList[0].kind = 'folder';
  f.ctx.selectedIds = new Set([2]);
  assert.strictEqual(f.c.openPlainCollection(), null);
  assert.deepStrictEqual([...f.c.selectedInOpenCollection()], []);
  await f.c.removeSelectedFromCollection();
  assert.deepStrictEqual(f.requests, []);

  const v = collectionsVm({ failDelete: true });
  v.ctx.selectedIds = new Set([2, 4]);
  await v.c.removeSelectedFromCollection();
  assert.deepStrictEqual(v.server.get(5), [1, 2, 3, 4, 5]);
  assert.deepStrictEqual([...v.ctx.selectedIds].sort(), [2, 4], 'still ticked: they are still in the grid');
  assert.deepStrictEqual(v.undos, []);
});

test('files that leave the open collection any other way (the picker, a read-back) are unticked too', async () => {
  const v = collectionsVm();
  v.ctx.selectedIds = new Set([1, 3]);
  await v.c.changeCollectionMembership(5, [3], false);          // the Add to collection picker, unticking it
  assert.deepStrictEqual([...v.ctx.selectedIds], [1]);
  v.server.set(5, [2, 4, 5]);                                  // changed elsewhere, read again
  await v.c.fetchCollectionMembers(5, true);
  assert.deepStrictEqual([...v.ctx.selectedIds], [], '1 left the collection: unticked');
  // Another collection than the open one: the selection is left alone.
  v.ctx.activeCollectionId = null;
  v.ctx.selectedIds = new Set([2]);
  await v.c.changeCollectionMembership(5, [2], false);
  assert.deepStrictEqual([...v.ctx.selectedIds], [2]);
});

test('the selection bar offers Remove from this collection only for the ticked files the open collection holds', () => {
  const bar = grab(sel, 'renderSelectionBar');
  assert.match(bar, /const inCollection = typeof selectedInOpenCollection === 'function' \? selectedInOpenCollection\(\)\.length : 0;/);
  assert.match(bar, /inCollection === 0 \? '' :/);
  assert.match(bar, /onclick="removeSelectedFromCollection\(\)"/);
  assert.match(bar, /Remove from this collection/);
});
