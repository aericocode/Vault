/**
 * The Flow panel (player-lib/flow.js) across collections: the shape picked
 * on one collection never carries over to another that has nothing
 * remembered. flow.js runs in a vm with a bare page (no DOM nodes, fetch
 * answered here), so only its state and requests are checked.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FlowOrder = require('../player-lib/flow-order.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');

function page() {
  const listeners = {};
  const store = new Map();
  const urls = [];
  const feats = [1, 2, 3].map((id, i) => ({ id, measured: true, music: true, es: 0.3 + i * 0.2, em: 0.3 + i * 0.2, ee: 0.3 + i * 0.2, bs: 120, bm: 120, be: 120 }));
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const status = { collection: { total: 3, measured: 3, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } };
  const ctx = {
    console,
    FlowOrder,
    activeCollectionId: null,
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    applyFilters: async () => {},
    fetch: async (url) => {
      urls.push(url);
      const m = /\/api\/flow\/collections\/(\d+)\?shape=(\w+)/.exec(url);
      if (m) {
        const shape = m[2];
        return ok({ shape, order: [1, 2, 3], playlistOrder: [1, 2, 3], features: feats, targets: FlowOrder.targetsFor(shape, feats),
          handovers: [], jumps: 0, playlistJumps: 0, counts: { measured: 3, failed: 0, music: 3 }, places: {}, placesOn: false });
      }
      return ok(status);
    },
  };
  ctx.window = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const emit = (type) => (listeners[type] || []).forEach(fn => fn({}));
  return { ctx, Flow: ctx.window.Flow, store, urls, emit };
}

test('a shape picked on one collection is not carried to another with nothing remembered', async () => {
  const p = page();
  p.ctx.activeCollectionId = 3;
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  assert.strictEqual(JSON.parse(p.store.get('vault.flow.shape.3')).shape, 'waves');

  // Another collection opens (the grid's answer says so), then Flow on it.
  p.ctx.activeCollectionId = 1;
  p.emit('vault:results-changed');
  p.urls.length = 0;
  await p.Flow.toggle(1);
  const asked = p.urls.filter(u => u.startsWith('/api/flow/collections/1?'));
  assert.ok(asked.length > 0);
  assert.ok(asked.every(u => u.includes('shape=smooth')), `asked with the other collection's shape: ${asked.join(', ')}`);
  assert.strictEqual(p.Flow._state().shape, 'smooth');
  assert.strictEqual(p.store.has('vault.flow.shape.1'), false, 'nothing picked there yet');
  // The first collection keeps its own.
  assert.strictEqual(JSON.parse(p.store.get('vault.flow.shape.3')).shape, 'waves');
});

test('opening Flow straight on another collection (no grid answer between) starts from the default shape too', async () => {
  const p = page();
  p.ctx.activeCollectionId = 3;
  await p.Flow.toggle(3);
  await p.Flow.pickShape('build');
  p.ctx.activeCollectionId = 1;
  p.urls.length = 0;
  await p.Flow.toggle(1);
  assert.ok(p.urls.filter(u => u.startsWith('/api/flow/collections/1?')).every(u => u.includes('shape=smooth')));
  assert.strictEqual(p.Flow._state().shape, 'smooth');
});

test('a collection gets the shape last picked in it back when Flow opens (a starting point, not an order)', async () => {
  const p = page();
  p.store.set('vault.flow.shape.1', JSON.stringify({ shape: 'peak', waves: 2, places: null }));
  p.ctx.activeCollectionId = 3;
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  p.ctx.activeCollectionId = 1;
  p.urls.length = 0;
  await p.Flow.toggle(1);
  assert.strictEqual(p.Flow._state().shape, 'peak');
  assert.ok(p.urls.filter(u => u.startsWith('/api/flow/collections/1?')).every(u => u.includes('shape=peak')));
  assert.ok(!p.urls.some(u => u.includes('/order')), 'opening writes no order');
});

test('Waves: the count of peaks is asked for and remembered with the shape; a bad entry reads as 2', async () => {
  const p = page();
  p.ctx.activeCollectionId = 3;
  await p.Flow.toggle(3);
  p.urls.length = 0;
  await p.Flow.pickWaves(4);
  assert.strictEqual(p.Flow._state().shape, 'waves');
  assert.strictEqual(p.Flow._state().waves, 4);
  assert.ok(p.urls.some(u => u.startsWith('/api/flow/collections/3?shape=waves') && u.includes('waves=4')), p.urls.join(', '));
  assert.deepStrictEqual(JSON.parse(p.store.get('vault.flow.shape.3')), { shape: 'waves', waves: 4, places: null });
  // Another shape keeps the count for later, and does not ask with it.
  p.urls.length = 0;
  await p.Flow.pickShape('build');
  assert.ok(p.urls.filter(u => u.startsWith('/api/flow/collections/3?')).every(u => !u.includes('waves=')));
  await p.Flow.pickShape('waves');
  assert.strictEqual(p.Flow._state().waves, 4);

  p.store.set('vault.flow.shape.1', JSON.stringify({ shape: 'waves', waves: 9 }));
  p.ctx.activeCollectionId = 1;
  p.urls.length = 0;
  await p.Flow.toggle(1);
  assert.strictEqual(p.Flow._state().waves, 2);
  assert.ok(p.urls.filter(u => u.startsWith('/api/flow/collections/1?')).every(u => u.includes('waves=2')));
});

test('a working Flow order an older Vault kept on this computer is removed when the page loads, never shown', async () => {
  const store = new Map([['vault.flow.order.1', JSON.stringify({ shape: 'peak', places: null, edited: [3, 2, 1] })], ['vault.flow.order.7', '{}'], ['vault.flow.lanes', '["tempo"]']]);
  const ctx = {
    console, FlowOrder, activeCollectionId: 1,
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: {
      get length() { return store.size; },
      key: (i) => [...store.keys()][i] ?? null,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0,
    applyFilters: async () => { throw new Error('the grid is not asked for another order'); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  };
  ctx.window = { addEventListener() {}, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  assert.deepStrictEqual([...store.keys()], ['vault.flow.lanes']);
  assert.strictEqual(ctx.window.Flow._state().shape, 'smooth');
});
