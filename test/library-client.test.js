/**
 * player-lib/library.js (the viewer's row cache) in a VM, against a fake
 * POST /api/media/rows. Regression for verifier round 2, D1: a fetchRows()
 * answer must never depend on what eviction (cap 10,000 rows) pushed out
 * meanwhile, and a row that could not be loaded must be an error a bulk
 * action sees (strict), never a silent null.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MAX_ID = 80000;        // the fake library: ids 1..80000
const OFFLINE_FROM = 90000;  // asking for these fails like a dropped connection

function loadLibrary() {
  const calls = { rows: 0 };
  const fakeFetch = async (url, opts = {}) => {
    if (String(url) === '/api/media/rows') {
      calls.rows++;
      const { ids } = JSON.parse(opts.body);
      if (ids.some(id => id >= OFFLINE_FROM)) throw new TypeError('Failed to fetch');
      const rows = ids.filter(id => id <= MAX_ID)
        .map(id => ({ id, filepath: `/lib/${id}.mp4`, filename: `${id}.mp4`, media_type: 'video' }));
      // A little latency so concurrent calls really overlap.
      await new Promise(r => setTimeout(r, 1));
      return { ok: true, status: 200, json: async () => ({ rows }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, Uint32Array, Uint8Array, DataView, JSON, Math, Date, Error, TypeError, Number, String, Array, Object,
    setInterval: () => 0,
    fetch: fakeFetch,
    CustomEvent: class { constructor(name, o) { this.type = name; this.detail = o && o.detail; } },
    document: { hidden: false, getElementById: () => null, addEventListener: () => {} },
  };
  ctx.window = { dispatchEvent: () => true, addEventListener: () => {} };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'library.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__Library = Library;`, ctx);
  return { Library: ctx.__Library, calls };
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const nulls = (rows) => rows.filter(r => !r).length;

test('a fetch never loses its own rows to eviction (the verifier repro)', async () => {
  const { Library } = loadLibrary();
  await Library.fetchRows(range(60001, 61000));
  await Library.fetchRows(range(62001, 70500));
  const sel = range(60001, 62000);
  const rows = await Library.fetchRows(sel, { strict: true });
  assert.strictEqual(nulls(rows), 0);
  assert.deepStrictEqual(rows.map(r => r.id), sel);
  assert.strictEqual(rows.failed, 0);
  assert.strictEqual(rows.gone, 0);
});

test('one 12,000-id call, past the 10,000-row cap, comes back whole', async () => {
  const { Library } = loadLibrary();
  await Library.fetchRows(range(1, 9000));
  const big = range(30001, 42000);
  const rows = await Library.fetchRows(big);
  assert.strictEqual(nulls(rows), 0);
  assert.strictEqual(rows.length, 12000);
  // The cap applies again once nothing is held.
  await Library.fetchRows([1]);
  assert.ok(Library._stats().rows <= 12001);
});

test('overlapping calls each get every row they asked for', async () => {
  const { Library } = loadLibrary();
  const [a, b, c] = await Promise.all([
    Library.fetchRows(range(1, 11000)),
    Library.fetchRows(range(5001, 16000)),
    Library.fetchRows(range(15001, 26000)),
  ]);
  assert.deepStrictEqual([nulls(a), nulls(b), nulls(c)], [0, 0, 0]);
});

test('missing records are counted as gone; a failed request is an error in strict mode', async () => {
  const { Library } = loadLibrary();
  const rows = await Library.fetchRows([1, 2, MAX_ID + 5]);
  assert.strictEqual(nulls(rows), 1);
  assert.strictEqual(rows.gone, 1);
  assert.strictEqual(rows.failed, 0);

  const loose = await Library.fetchRows([3, OFFLINE_FROM + 1]);
  // One request carried both ids, so both could not be loaded.
  assert.strictEqual(loose.failed, 2, 'not strict: reported, not thrown');
  assert.strictEqual(nulls(loose), 2);
  await assert.rejects(Library.fetchRows([4, OFFLINE_FROM + 2], { strict: true }),
    (err) => err instanceof Library.RowsUnavailable && err.count === 2 && /could not be loaded/.test(err.message));
});
