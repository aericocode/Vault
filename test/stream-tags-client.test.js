/**
 * The page's side of stream tags (player-lib/stream-tags.js), run in a VM
 * with a fake server: the copy it keeps (load, a collection refreshed, a
 * tag put on and taken off), window.FlowLaneSource (lanes, cells, chips,
 * onChange), and chips that escape what the user typed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'stream-tags.js'), 'utf8');

const LANES = [
  { id: 1, name: 'Role', multi: true, sort: 0, tags: [
    { id: 1, laneId: 1, name: 'Opener', color: '#4ade80', hotkey: 'O', place: 'first', sort: 0 },
    { id: 5, laneId: 1, name: 'Closer', color: '#f472b6', hotkey: 'X', place: 'last', sort: 1 },
  ] },
  { id: 2, name: 'Mood <b>', multi: false, sort: 1, tags: [
    { id: 7, laneId: 2, name: '<img src=x onerror=alert(1)>', color: '#7dd3fc', hotkey: '1', place: 'anywhere', sort: 0 },
  ] },
];

function load() {
  const calls = [];
  let rows = [[10, 5], [10, 1], [11, 7]];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetch = async (url, opts = {}) => {
    calls.push([url, opts.body ? JSON.parse(opts.body) : null]);
    if (url === '/api/stream-tags') return reply({ lanes: LANES });
    if (url === '/api/stream-tags/assignments') return reply({ rows });
    if (url === '/api/stream-tags/collections/3') return reply({ assignments: { 12: [1] } });
    if (url === '/api/stream-tags/assign') {
      const b = JSON.parse(opts.body);
      const out = {};
      for (const m of b.mediaIds) {
        const have = rows.filter(r => r[0] === m).map(r => r[1]);
        const next = b.op === 'add' ? [...new Set([...have, b.tagId])] : have.filter(t => t !== b.tagId);
        rows = rows.filter(r => r[0] !== m).concat(next.map(t => [m, t]));
        if (next.length) out[m] = next;
      }
      return reply({ op: b.op, changed: 1, assignments: out });
    }
    return { ok: false, status: 404, json: async () => ({ error: 'nope' }) };
  };
  const noop = () => {};
  const toasts = [];
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Number, Object, Array, String, RegExp,
    fetch,
    showToast: (m) => toasts.push(m),
    collectionMembers: new Map([[3, [12, 13]]]),
    document: {
      readyState: 'complete', addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
      createElement: () => ({ set innerHTML(v) { this._h = v; }, firstElementChild: null }),
    },
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  vm.createContext(ctx);
  vm.runInContext(`${SRC}\nthis.StreamTags = StreamTags;`, ctx);
  return { ctx, calls, toasts };
}

const settle = () => new Promise(r => setTimeout(r, 10));

test('the copy loads once: lanes in order, each file\'s tags in lane order', async () => {
  const { ctx, calls } = load();
  await ctx.StreamTags.load();
  assert.strictEqual(ctx.StreamTags.loaded(), true);
  // File 10 was sent Closer first: it reads in the lane's order.
  assert.deepStrictEqual([...ctx.StreamTags.tagsOf(10).map(t => t.name)], ['Opener', 'Closer']);
  await ctx.StreamTags.load();
  assert.strictEqual(calls.filter(c => c[0] === '/api/stream-tags/assignments').length, 1);
});

test('FlowLaneSource: lanes, cells per file and lane, chips, onChange', async () => {
  const { ctx } = load();
  await ctx.StreamTags.load();
  const src = ctx.window.FlowLaneSource;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.lanes())), [{ key: 'lane:1', label: 'Role' }, { key: 'lane:2', label: 'Mood <b>' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.cells('lane:1', [10, 11, 99]))), [
    [{ color: '#4ade80', label: 'Opener' }, { color: '#f472b6', label: 'Closer' }], [], [],
  ]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.cells('lane:2', [11]))), [[{ color: '#7dd3fc', label: '<img src=x onerror=alert(1)>' }]]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.cells('nope', [10]))), [[]]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(src.chips(10))).map(c => c.label), ['Opener', 'Closer']);
  let n = 0;
  src.onChange(() => { n++; });
  await ctx.StreamTags.apply(5, [11], 'toggle');
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(src.chips(11).map(c => c.label), ['Closer', '<img src=x onerror=alert(1)>']);
  await ctx.StreamTags.refreshCollection(3);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(src.chips(12).map(c => c.label), ['Opener']);
});

test('toggle on several files: on all unless every one has it, then off all', async () => {
  const { ctx, calls, toasts } = load();
  await ctx.StreamTags.load();
  await ctx.StreamTags.apply(1, [10, 11], 'toggle');
  assert.strictEqual(calls.at(-1)[1].op, 'add');
  assert.deepStrictEqual(calls.at(-1)[1].mediaIds, [10, 11]);
  assert.match(toasts.at(-1), /Opener: on 2 files/);
  await ctx.StreamTags.apply(1, [10, 11], 'toggle');
  assert.strictEqual(calls.at(-1)[1].op, 'remove');
  assert.deepStrictEqual(ctx.StreamTags.tagsOf(11).map(t => t.id), [7]);
  await settle();
});

test('chips escape the names; at most two, then +n', async () => {
  const { ctx } = load();
  await ctx.StreamTags.load();
  await ctx.StreamTags.apply(7, [10], 'add');
  const html = ctx.StreamTags.tileHtml({ id: 10 });
  assert.ok(!html.includes('<img'), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('title="Role: Opener"'));
  assert.ok(ctx.StreamTags.tileHtml({ id: 11 }).includes('title="Mood &lt;b&gt;: &lt;img'), 'the lane name is escaped too');
  assert.match(html, /\+1</);
  assert.strictEqual(ctx.StreamTags.tileHtml({ id: 99 }), '');
});
