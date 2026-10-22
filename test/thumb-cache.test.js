/**
 * Thumbnail settings, the pure parts: the memory cache's byte cap and LRU
 * order, the disk ledger's eviction order (least recently shown first, never
 * what is on screen), and what the settings route accepts.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-thumbcache-'));
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');

const { ByteLru, DiskUse } = require('../lib/thumb-cache');
const ts = require('../lib/thumb-settings');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const buf = (n, fill = 1) => Buffer.alloc(n, fill);

test('memory cache: total bytes never pass the cap, coldest goes first', () => {
  const c = new ByteLru(100);
  c.set('1:thumb', buf(40));
  c.set('2:thumb', buf(40));
  assert.strictEqual(c.bytes, 80);
  c.get('1:thumb');                       // 1 is now warmer than 2
  c.set('3:thumb', buf(40));              // 120 > 100: drop the coldest (2)
  assert.strictEqual(c.bytes, 80);
  assert.ok(c.has('1:thumb') && c.has('3:thumb') && !c.has('2:thumb'));
});

test('memory cache: a picture bigger than the whole cap is not kept', () => {
  const c = new ByteLru(10);
  assert.strictEqual(c.set('1:thumb', buf(11)), false);
  assert.strictEqual(c.size, 0);
  assert.strictEqual(c.bytes, 0);
});

test('memory cache: replacing a key does not count it twice; lowering the cap trims', () => {
  const c = new ByteLru(1000);
  c.set('1:thumb', buf(300));
  c.set('1:thumb', buf(200));
  assert.strictEqual(c.bytes, 200);
  c.set('2:s0', buf(300));
  c.set('3:art', buf(300));
  c.setMax(500);                          // 800 -> drop 1, then 2
  assert.deepStrictEqual([...c.map.keys()], ['3:art']);
  assert.strictEqual(c.bytes, 300);
});

test('memory cache: a 4 GB cap is not truncated to 32 bits', () => {
  const c = new ByteLru(4096 * 1024 * 1024);
  assert.strictEqual(c.maxBytes, 4294967296);
});

test('memory cache: deleteWhere and stats by kind', () => {
  const c = new ByteLru(1000);
  c.set('1:thumb', buf(10));
  c.set('1:s0', buf(20));
  c.set('2:art', buf(30));
  assert.deepStrictEqual(c.stats((k) => k.endsWith(':s0')), { bytes: 20, count: 1 });
  assert.strictEqual(c.deleteWhere((k) => k.startsWith('1:')), 2);
  assert.strictEqual(c.bytes, 30);
  c.clear();
  assert.strictEqual(c.size, 0);
  assert.strictEqual(c.bytes, 0);
});

test('disk ledger: least recently shown removed first, down to the target', () => {
  let now = 1_000_000;
  const d = new DiskUse({ protectMs: 100, now: () => now });
  d.add(1, 50, 10);
  d.add(2, 50, 30);
  d.add(3, 50, 20);
  d.add(4, 50, 40);
  assert.strictEqual(d.total, 200);
  assert.deepStrictEqual(d.victims(100), [1, 3]);
  d.touch(1, 50);                       // 1 was just shown again
  assert.deepStrictEqual(d.victims(100), [3, 2]);
  assert.deepStrictEqual(d.victims(500), [], 'under the limit: nothing');
  assert.deepStrictEqual(d.victims(0, 1), [3], 'max caps one pass');
});

test('disk ledger: never removes what was shown in the protect window', () => {
  let now = 10_000;
  const d = new DiskUse({ protectMs: 1000, now: () => now });
  d.add(1, 100, 9_500);                 // on screen
  d.add(2, 100, 1_000);
  assert.deepStrictEqual(d.victims(0), [2], 'falls short rather than removing the visible one');
  now = 20_000;
  assert.deepStrictEqual(d.victims(0), [2, 1]);
});

test('disk ledger: set replaces, remove and shrink keep the total right', () => {
  const d = new DiskUse({ protectMs: 0 });
  d.add(1, 10, 1);
  d.add(1, 15, 2);                      // a scrub frame for the same id
  assert.strictEqual(d.total, 25);
  d.set(1, 40, 3);
  assert.strictEqual(d.total, 40);
  d.shrink(1, 30);
  assert.strictEqual(d.total, 10);
  assert.strictEqual(d.remove(1), 10);
  assert.strictEqual(d.total, 0);
  d.set(2, 0, 1);
  assert.strictEqual(d.size, 0, 'zero bytes means no entry');
});

test('settings: defaults are today\'s behaviour', () => {
  ts._resetCache();
  const s = ts.get();
  assert.deepStrictEqual(s, { make: 'all', keep: 'keep', diskCapMB: 2048, memoryMB: 300, hover: true, inside: true, salt: 0 });
  assert.strictEqual(ts.storage(s), 'keep');
  assert.strictEqual(ts.scanMakes(s), true);
});

test('settings: storage follows make; keep only counts under When shown', () => {
  const base = ts.normalize({});
  assert.strictEqual(ts.storage({ ...base, make: 'all', keep: 'memory' }), 'keep');
  assert.strictEqual(ts.storage({ ...base, make: 'shown', keep: 'memory' }), 'memory');
  assert.strictEqual(ts.storage({ ...base, make: 'shown', keep: 'cap' }), 'cap');
  assert.strictEqual(ts.storage({ ...base, make: 'off', keep: 'cap' }), 'off');
  assert.strictEqual(ts.scanMakes({ ...base, make: 'shown' }), false);
  assert.strictEqual(ts.scanMakes({ ...base, make: 'off' }), false);
});

test('settings: validation names the bounds and refuses junk', () => {
  const cur = ts.normalize({});
  assert.deepStrictEqual(ts.validate({ make: 'off' }, cur).value.make, 'off');
  assert.strictEqual(ts.validate({ memoryMB: 450 }, cur).value.memoryMB, 450, 'an exact typed value is fine');
  const low = ts.validate({ memoryMB: 10 }, cur).error;
  assert.match(low, /50 MB to 4 GB/);
  const high = ts.validate({ diskCapMB: 5 * 1024 * 1024 }, cur).error;
  assert.match(high, /100 MB to 1024 GB/);
  assert.ok(ts.validate({ memoryMB: 300.5 }, cur).error, 'whole MB only');
  assert.ok(ts.validate({ memoryMB: '300' }, cur).error, 'a number, not text');
  assert.ok(ts.validate({ make: 'sometimes' }, cur).error);
  assert.ok(ts.validate({ keep: 'forever' }, cur).error);
  assert.ok(ts.validate({ hover: 'yes' }, cur).error);
  assert.ok(ts.validate({ evil: 1 }, cur).error);
  assert.ok(ts.validate({}, cur).error);
  assert.ok(ts.validate(null, cur).error);
  for (const r of [low, high]) assert.ok(!r.includes('—'), 'no em dash in user-facing text');
});

test('settings: update stores, and a hand-edited file falls back per field', () => {
  ts._resetCache();
  const r = ts.update({ make: 'shown', keep: 'memory', memoryMB: 700 });
  assert.strictEqual(r.value.memoryMB, 700);
  ts._resetCache();
  assert.strictEqual(ts.get().keep, 'memory', 'read back from the file');
  const raw = JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8'));
  raw.thumbnails = { make: 'bogus', keep: 'cap', memoryMB: -5, diskCapMB: 4096, hover: 'no' };
  fs.writeFileSync(process.env.VAULT_SETTINGS_FILE, JSON.stringify(raw));
  ts._resetCache();
  assert.deepStrictEqual(ts.get(), { make: 'all', keep: 'cap', diskCapMB: 4096, memoryMB: 300, hover: true, inside: true, salt: 0 });
});
