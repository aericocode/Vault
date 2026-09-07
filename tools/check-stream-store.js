/**
 * Runnable check for the segment store's bookkeeping.
 *
 *   node tools/check-stream-store.js
 *
 * The thing being guarded is stream_cache.bytes. A producer restart re-emits
 * segments that are already stored (every backward seek runs FFmpeg again from
 * an earlier boundary), so put() is called more than once for the same segment
 * number, and counting each call inflates the total without bound. Eviction
 * then runs against a number that has nothing to do with the disk.
 *
 * Runs against a throwaway database and cache directory in the OS temp dir; it
 * never touches a real library, and needs no ffmpeg.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-storecheck-'));
process.env.VAULT_DB = path.join(work, 'check.db');
process.env.VAULT_STREAM_CACHE = path.join(work, 'stream-cache');

const db = require('../lib/database');
const store = require('../lib/stream/store');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok    ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ''}`);
}

db.init(process.env.VAULT_DB);

const ID = 4242;
const TOTAL = 8;
const seg = (n, size) => Buffer.alloc(size, n);

console.log('stream_cache.bytes');

store.put(ID, 5, seg(5, 1000), TOTAL);
const after1 = db.getStreamCache(ID);
check('one put counts once', after1.bytes === 1000, `bytes=${after1.bytes}`);
check('have_mask records segment 5', store.maskHas(after1.have_mask, 5) === true);

// The whole point: the same segment arriving a second time from a restarted
// producer must not be counted again.
store.put(ID, 5, seg(5, 1000), TOTAL);
const after2 = db.getStreamCache(ID);
check('re-put of segment 5 counts once', after2.bytes === 1000, `bytes=${after2.bytes}`);

// A different segment still counts.
store.put(ID, 6, seg(6, 500), TOTAL);
check('a new segment still adds', db.getStreamCache(ID).bytes === 1500,
  `bytes=${db.getStreamCache(ID).bytes}`);

// Three full restart cycles: 5 and 6 re-emitted every time.
for (let cycle = 0; cycle < 3; cycle++) {
  store.put(ID, 5, seg(5, 1000), TOTAL);
  store.put(ID, 6, seg(6, 500), TOTAL);
}
check('three restart cycles change nothing', db.getStreamCache(ID).bytes === 1500,
  `bytes=${db.getStreamCache(ID).bytes}`);

// Self-heal on completion: bytes is recomputed from what is really stored.
// The row is deliberately corrupted first, the way an old inflated row would be.
for (let n = 0; n < TOTAL; n++) if (n !== 5 && n !== 6) store.put(ID, n, seg(n, 100), TOTAL);
const complete = db.getStreamCache(ID);
check('the set reports complete', complete.complete === 1);
check('bytes equals what is on disk', complete.bytes === store.bytesOf(ID),
  `row=${complete.bytes} disk=${store.bytesOf(ID)}`);
check('bytes equals the sum of the writes', complete.bytes === 1000 + 500 + 6 * 100,
  `bytes=${complete.bytes}`);

console.log('refused sweeps');

// A cache root without the .vault-owned marker must not lose its rows.
fs.rmSync(path.join(store.root(), require('../lib/owned-dir').MARKER_NAME), { force: true });
const refused = store.deleteAll(ID);
check('deleteAll reports the refusal', refused.ok === false && !!refused.error);
check('the bookkeeping row survives a refused delete', !!db.getStreamCache(ID));
const cleared = store.clearAll();
check('clearAll reports the refusal', cleared.ok === false && !!cleared.error);
check('rows survive a refused clear', !!db.getStreamCache(ID));

// With the marker back, both paths work again.
require('../lib/owned-dir').markOwned(store.root());
check('deleteAll succeeds once the folder is marked', store.deleteAll(ID).ok === true);
check('the row is gone', db.getStreamCache(ID) === null);

db.close();
try { fs.rmSync(work, { recursive: true, force: true }); } catch {}

console.log('');
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
