/**
 * Ignore calm intros and credits changing while Flow holds an answer
 * (player-lib/flow.js settingsChanged): with the panel open or closed, a
 * Flow order the grid shows is asked for and applied again, Flow shuffle
 * asks afresh, and a collection that is not open forgets what it held.
 * flow.js runs in a vm with a bare page; the server's answer here depends on
 * the setting, as the real one does (lib/flow/service.js).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const FlowOrder = require('../player-lib/flow-order.js');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');

function page() {
  const urls = [];
  const server = { edges: 'auto' };
  const store = new Map();
  // Auto looks past file 2's intro (a different order and features than Off).
  const answer = () => {
    const auto = server.edges === 'auto';
    const feats = [1, 2, 3].map(id => ({ id, measured: true, music: true, es: 0.5, em: 0.5, ee: 0.5, bs: 120, bm: 120, be: 120,
      ...(auto && id === 2 ? { skip: [20, 0], cut: [0.1, 0] } : {}) }));
    return { shape: 'smooth', edges: server.edges, order: auto ? [2, 1, 3] : [3, 1, 2], playlistOrder: [1, 2, 3], features: feats, targets: null,
      handovers: [], jumps: 0, playlistJumps: 0, counts: { measured: 3, failed: 0, music: 3 }, places: {}, placesOn: false };
  };
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const shuffled = [];
  const ctx = {
    console, FlowOrder,
    activeCollectionId: 3,
    document: { readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0,
    applyFilters: async () => {},
    Library: { shuffle: (order) => { shuffled.push(order); return true; } },
    fetch: async (url) => {
      urls.push(url);
      if (/\/api\/flow\/collections\/\d+\?/.test(url)) return ok(answer());
      if (url.startsWith('/api/stage/settings')) return ok({ flowShuffle: true, flowEdges: server.edges });
      return ok({ collection: { total: 3, measured: 3, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } });
    },
  };
  ctx.window = { addEventListener() {}, dispatchEvent() {} };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, Flow: ctx.window.Flow, urls, server, shuffled };
}
const ranked = (p) => (p.Flow.queryRanked() || []).map(r => r.id);
const asks = (p) => p.urls.filter(u => /\/api\/flow\/collections\//.test(u)).length;

test('Flow order with the panel closed: a setting change asks again and the grid gets the new order', async () => {
  const p = page();
  await p.Flow.toggle(3);
  await p.Flow.useFlowOrder();
  assert.deepStrictEqual(ranked(p), [2, 1, 3]);
  p.Flow.close();
  assert.strictEqual(p.Flow.isOpen(), false);
  p.server.edges = 'off';
  await p.ctx.flowSettingsChanged();
  assert.deepStrictEqual(ranked(p), [3, 1, 2], 'the order the new setting gives');
  assert.strictEqual(p.Flow.orderOn(), true);
});

test('panel open: the chart data follow the setting at once', async () => {
  const p = page();
  await p.Flow.toggle(3);
  const n = asks(p);
  p.server.edges = 'off';
  await p.ctx.flowSettingsChanged();
  assert.strictEqual(asks(p), n + 1);
});

test('panel closed, no Flow order: the held answer is dropped, so Flow shuffle asks afresh', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.Flow.close();
  p.server.edges = 'off';
  const n = asks(p);
  await p.ctx.flowSettingsChanged();
  assert.strictEqual(asks(p), n, 'nothing asked while nothing shows it');
  assert.strictEqual(await p.Flow.shuffleCollection(3), true);
  assert.strictEqual(asks(p), n + 1, 'the shuffle asked for features under the new setting');
});

test('a collection that is not open any more forgets what Flow held for it', async () => {
  const p = page();
  await p.Flow.toggle(3);
  await p.Flow.useFlowOrder();
  p.ctx.activeCollectionId = 1;
  p.server.edges = 'off';
  await p.ctx.flowSettingsChanged();
  const s = p.Flow._state();
  assert.strictEqual(s.cid, null);
  assert.strictEqual(s.data, null);
  assert.strictEqual(s.appliedOrder, null);
});
