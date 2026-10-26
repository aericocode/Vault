/**
 * Flow's measuring queue (lib/flow/queue.js) with a fake measure(): one file
 * at a time in order, Pause / Resume, the lock, Stage playing (a file
 * stopped half-way goes back to the front), Cancel, and the whole-library
 * pass going idle when nothing is left.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createQueue } = require('../lib/flow/queue');

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

/** measure() that takes `ms` and can be aborted; records what ran and what finished. */
function harness({ ms = 15, ...o } = {}) {
  const ran = [], finished = [], aborted = [];
  let running = 0, maxRunning = 0;
  const env = { locked: false, stage: false, sweep: false, library: [], cursor: 0, gap: 0 };
  const q = createQueue({
    pollMs: 10,
    isLocked: () => env.locked,
    stagePlaying: () => env.stage,
    sweepOn: () => env.sweep,
    nextSweep: () => {
      // Like the service: a cursor kept between calls, 'later' after a stretch with nothing.
      if (env.gap > 0) { env.gap--; return 'later'; }
      const id = env.library.find(x => x > env.cursor);
      if (id == null) return null;
      env.cursor = id;
      return id;
    },
    measure: (id, signal) => new Promise((resolve, reject) => {
      ran.push(id);
      running++; maxRunning = Math.max(maxRunning, running);
      const t = setTimeout(() => { running--; finished.push(id); env.library = env.library.filter(x => x !== id); if (o.fail && o.fail.includes(id)) reject(new Error('bad')); else resolve(); }, ms);
      signal.addEventListener('abort', () => { clearTimeout(t); running--; aborted.push(id); reject(Object.assign(new Error('x'), { code: 'ABORTED' })); });
    }),
    ...o.queueOpts,
  });
  const until = async (fn, limit = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > limit) throw new Error('timed out'); await tick(); } };
  return { q, env, ran, finished, aborted, until, max: () => maxRunning };
}

test('one file at a time, in the order asked; repeats are skipped; counts for the batch', async () => {
  const h = harness();
  assert.strictEqual(h.q.add([3, 1, 2]), 3);
  assert.strictEqual(h.q.add([1, 2, 4]), 1);
  assert.strictEqual(h.q.status().total, 4);
  await h.until(() => h.q.status().state === 'idle');
  assert.deepStrictEqual(h.finished, [3, 1, 2, 4]);
  assert.strictEqual(h.max(), 1);
});

test('a failed file is counted and the queue carries on', async () => {
  const h = harness({ fail: [2] });
  const seen = [];
  h.q.add([1, 2, 3]);
  await h.until(() => { const s = h.q.status(); seen.push(s.failed); return h.finished.length === 3; });
  assert.ok(seen.includes(1));
});

test('Pause stops the file half-way (it goes back to the front); Resume carries on', async () => {
  const h = harness({ ms: 60 });
  h.q.add([1, 2, 3]);
  await h.until(() => h.q.status().current === 1);
  h.q.pause();
  await tick(20);
  assert.deepStrictEqual(h.aborted, [1]);
  const s = h.q.status();
  assert.strictEqual(s.state, 'waiting');
  assert.strictEqual(s.reason, 'paused');
  assert.strictEqual(s.paused, true);
  await tick(100);
  assert.deepStrictEqual(h.finished, [], 'nothing while paused');
  h.q.resume();
  await h.until(() => h.q.status().state === 'idle');
  assert.deepStrictEqual(h.finished, [1, 2, 3]);
});

test('Stage playing: waits, stops a running file at once, picks up when Stage stops', async () => {
  const h = harness({ ms: 80 });
  h.q.add([1, 2]);
  await h.until(() => h.q.status().current === 1);
  h.env.stage = true;                 // Stage starts mid-file: the watch notices within pollMs
  await h.until(() => h.aborted.includes(1));
  assert.strictEqual(h.q.status().reason, 'stage');
  await tick(100);
  assert.deepStrictEqual(h.finished, []);
  h.env.stage = false;                // polled: no kick needed
  await h.until(() => h.q.status().state === 'idle');
  assert.deepStrictEqual(h.finished, [1, 2]);
});

test('the lock: nothing runs while locked; kick() after the unlock carries on', async () => {
  const h = harness({ ms: 40 });
  h.env.locked = true;
  h.q.add([5, 6]);
  await tick(60);
  assert.deepStrictEqual(h.ran, []);
  assert.strictEqual(h.q.status().reason, 'locked');
  h.env.locked = false;
  h.q.kick();
  await h.until(() => h.finished.length === 2);
  // Locked mid-file: kick() (the vault's lock event) stops it at once.
  h.q.add([7]);
  await h.until(() => h.q.status().current === 7);
  h.env.locked = true;
  h.q.kick();
  await tick(10);
  assert.ok(h.aborted.includes(7));
  assert.deepStrictEqual(h.q._pending(), [7], 'back at the front');
  h.env.locked = false;
  h.q.kick();
  await h.until(() => h.finished.includes(7));
});

test('Cancel drops what was asked for, including the file running, without putting it back', async () => {
  const h = harness({ ms: 50 });
  h.q.add([1, 2, 3]);
  await h.until(() => h.q.status().current === 1);
  h.q.cancel();
  await tick(80);
  assert.deepStrictEqual(h.finished, []);
  assert.strictEqual(h.q.status().state, 'idle');
  assert.deepStrictEqual(h.q._pending(), []);
});

test('whole library: walks the unmeasured files after what was asked, then goes idle', async () => {
  const h = harness({ ms: 5 });
  h.env.library = [10, 11, 12];
  h.env.gap = 3;                      // a stretch of already-measured files first
  h.env.sweep = true;
  h.q.add([99]);
  await h.until(() => h.finished.length === 4);
  assert.deepStrictEqual(h.finished, [99, 10, 11, 12]);
  await h.until(() => h.q.status().state === 'idle');
  assert.strictEqual(h.q.status().sweep, false, 'nothing left: the pass is done');
  // kick() (a lock, Stage, a setting) does not walk the library again...
  h.env.library = [13];
  h.q.kick();
  await tick(40);
  assert.ok(!h.finished.includes(13));
  // ...restartSweep() (Whole library now chosen again) does; the caller's cursor goes on from where it was.
  h.q.restartSweep();
  await h.until(() => h.finished.includes(13));
});

test('a library file stopped half-way is taken again first when the queue carries on', async () => {
  const h = harness({ ms: 60 });
  h.env.library = [20, 21];
  h.env.sweep = true;
  h.q.kick();
  await h.until(() => h.q.status().current === 20);
  h.q.pause();
  await tick(20);
  assert.deepStrictEqual(h.aborted, [20]);
  h.q.resume();
  await h.until(() => h.finished.length === 2);
  assert.deepStrictEqual(h.finished, [20, 21]);
});

test('10,000 files that settle at once (missing, no sound) never hold the event loop for long', async () => {
  let n = 0;
  const q = createQueue({ measure: () => { n++; if (n % 2) return Promise.reject(new Error('missing file')); return Promise.resolve(); }, pollMs: 1000 });
  const ids = Array.from({ length: 10000 }, (_, i) => i + 1);
  let maxGap = 0, last = Date.now(), ticks = 0;
  const iv = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 1);
  q.add(ids);
  const t0 = Date.now();
  while (q.status().state !== 'idle') await new Promise(r => setTimeout(r, 5));
  clearInterval(iv);
  assert.strictEqual(n, 10000);
  assert.ok(ticks >= 2, `a timer ran ${ticks} times while it drained (${Date.now() - t0} ms)`);
  assert.ok(maxGap < 40, `longest wait for a timer ${maxGap} ms`);
});
