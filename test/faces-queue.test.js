/**
 * lib/faces/queue.js: worker limit, dedupe, pause / resume, cancel aborting
 * running work through its AbortSignal, suspend (vault lock) putting running
 * files back, runNow jumping the queue, and the status shape.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createQueue, progressOf } = require('../lib/faces/queue');

/** runFile whose calls wait until released; records starts and aborts. */
function harness({ workers = 2, now } = {}) {
  const started = [];
  const aborted = [];
  const gates = new Map();
  const fail = new Set();
  const runFile = (item, { signal, onProgress }) => {
    started.push(item.id);
    onProgress(0.25);
    return new Promise((resolve, reject) => {
      gates.set(item.id, () => resolve(!fail.has(item.id)));
      signal.addEventListener('abort', () => { aborted.push(item.id); reject(new Error('aborted')); }, { once: true });
    });
  };
  const q = createQueue({ runFile, workers, ...(now ? { now } : {}) });
  const release = async (id) => { gates.get(id)(); await tick(); };
  return { q, started, aborted, release, fail };
}

const tick = () => new Promise(r => setImmediate(r));
const items = (...ids) => ids.map(id => ({ id, filename: `${id}.jpg` }));

test('runs at most `workers` files at once, dedupes, and reports progress', async () => {
  const { q, started, release } = harness({ workers: 2 });
  const r = q.enqueue(items(1, 2, 3));
  assert.deepStrictEqual(r, { added: 3, already: 0 });
  assert.deepStrictEqual(q.enqueue(items(2, 3, 4)), { added: 1, already: 2 });
  assert.deepStrictEqual(started, [1, 2]);
  let s = q.status();
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.total, 4);
  assert.deepStrictEqual(s.current, [{ id: 1, filename: '1.jpg', progress: 0.25 }, { id: 2, filename: '2.jpg', progress: 0.25 }]);
  assert.ok(s.startedAt);
  assert.ok(q.isBusy());
  await release(1);
  assert.deepStrictEqual(started, [1, 2, 3]);
  await release(2); await release(3); await release(4);
  s = q.status();
  assert.deepStrictEqual([s.running, s.done, s.failed, s.total, s.current.length, s.startedAt], [false, 0, 0, 0, 0, null],
    'counters reset once the run is over');
  assert.deepStrictEqual([s.lastRun.done, s.lastRun.failed, s.lastRun.total], [4, 0, 4]);
  assert.ok(!q.isBusy());
});

test('a failed file is counted, the run goes on', async () => {
  const { q, release, fail } = harness({ workers: 1 });
  fail.add(1);
  q.enqueue(items(1, 2));
  await release(1); await release(2);
  const s = q.status().lastRun;
  assert.deepStrictEqual([s.done, s.failed], [1, 1]);
});

test('pause stops new files starting (running ones finish); resume carries on', async () => {
  const { q, started, release } = harness({ workers: 1 });
  q.enqueue(items(1, 2));
  q.pause();
  assert.strictEqual(q.status().paused, true);
  await release(1);
  assert.deepStrictEqual(started, [1], 'nothing new starts while paused');
  assert.ok(!q.isBusy(), 'a paused queue with banked work is not busy');
  q.resume();
  assert.deepStrictEqual(started, [1, 2]);
  assert.ok(q.isBusy());
  await release(2);
  assert.strictEqual(q.status().lastRun.done, 2);
});

test('cancel clears pending and aborts running files through their signal', async () => {
  const { q, started, aborted } = harness({ workers: 2 });
  q.enqueue(items(1, 2, 3, 4));
  q.cancel();
  await q.settled();
  assert.deepStrictEqual(aborted.sort(), [1, 2]);
  assert.deepStrictEqual(started, [1, 2], 'pending files never start');
  const s = q.status();
  assert.deepStrictEqual([s.running, s.done, s.failed, s.total, s.startedAt], [false, 0, 0, 0, null]);
  assert.ok(!q.isBusy());
});

test('suspend (vault lock) aborts and requeues running files; unsuspend restarts them', async () => {
  const { q, started, aborted, release } = harness({ workers: 1 });
  q.enqueue(items(1, 2));
  q.suspend();
  await q.settled();
  assert.deepStrictEqual(aborted, [1]);
  assert.strictEqual(q.status().paused, true);
  assert.ok(!q.isBusy());
  q.unsuspend();
  assert.deepStrictEqual(started, [1, 1], 'the interrupted file runs again first');
  await release(1); await release(2);
  assert.strictEqual(q.status().lastRun.done, 2);
});

test('runNow jumps the queue, ignores the worker limit and pause, and joins a running file', async () => {
  const { q, started, release } = harness({ workers: 1 });
  q.enqueue(items(1, 2, 3));
  q.pause();
  const p3 = q.runNow({ id: 3, filename: '3.jpg' });
  assert.deepStrictEqual(started, [1, 3]);
  const again = q.runNow({ id: 3, filename: '3.jpg' });
  await release(3);
  assert.strictEqual(await p3, 'done');
  assert.strictEqual(await again, 'done');
  assert.strictEqual(q.status().total, 2, 'pulled from pending; a click is not queue work');
  assert.deepStrictEqual(q.status().current.map(c => c.id), [1], 'the click is not listed as queue work');
  q.resume();
  await release(1); await release(2);
  assert.deepStrictEqual([q.status().lastRun.done, q.status().lastRun.total], [2, 2]);
});

test('regression: a file re-queued right after cancel is really queued and runs', async () => {
  const { q, started, release } = harness({ workers: 1 });
  q.enqueue(items(1));
  q.cancel();                                  // run 1 is still winding down
  assert.deepStrictEqual(q.enqueue(items(1)), { added: 1, already: 0 }, 'not deduped against the aborting run');
  assert.deepStrictEqual(started, [1, 1], 'the new run starts');
  assert.ok(q.isQueued(1));
  await release(1);
  await q.settled();
  const s = q.status();
  assert.deepStrictEqual([s.running, s.lastRun.done, s.lastRun.total], [false, 1, 1]);
});

test('regression: runNow right after cancel starts a fresh run instead of joining the aborted one', async () => {
  const { q, started, release } = harness({ workers: 1 });
  q.enqueue(items(7));
  q.cancel();
  const p = q.runNow({ id: 7, filename: '7.jpg' });
  assert.deepStrictEqual(started, [7, 7]);
  await release(7);
  assert.strictEqual(await p, 'done');
});

test('regression: status goes idle (no startedAt, zero counters) when a run completes or is cancelled', async () => {
  const { q, release } = harness({ workers: 1 });
  q.enqueue(items(1));
  assert.ok(q.status().startedAt);
  await release(1);
  let s = q.status();
  assert.deepStrictEqual([s.startedAt, s.total, s.done, s.etaS], [null, 0, 0, null]);
  q.enqueue(items(2, 3));
  q.cancel();
  await q.settled();
  s = q.status();
  assert.deepStrictEqual([s.running, s.startedAt, s.total, s.done, s.failed], [false, null, 0, 0, 0]);
});

test('progressOf normalizes the shapes analyzeFile may report', () => {
  assert.strictEqual(progressOf(0.5, 0), 0.5);
  assert.strictEqual(progressOf({ fraction: 2 }, 0), 1);
  assert.strictEqual(progressOf({ done: 1, total: 4 }, 0), 0.25);
  assert.strictEqual(progressOf({ framesChecked: 3, totalFrames: 6 }, 0), 0.5);
  assert.strictEqual(progressOf({ junk: true }, 0.3), 0.3);
});

test('a click never counts toward queue totals, lastRun or the running flag', async () => {
  const { q, release } = harness({ workers: 1 });
  const p = q.runNow({ id: 9, filename: '9.jpg' });
  let s = q.status();
  assert.deepStrictEqual([s.running, s.total, s.startedAt, s.current.length], [false, 0, null, 0]);
  assert.ok(q.isBusy(), 'still busy for the migrate guard');
  await release(9);
  assert.strictEqual(await p, 'done');
  s = q.status();
  assert.deepStrictEqual([s.done, s.total, s.lastRun], [0, 0, null]);
  // with a queue run going, a click on another file leaves the tally alone
  q.enqueue(items(1));
  const c = q.runNow({ id: 5, filename: '5.jpg' });
  await release(5); await c;
  await release(1);
  s = q.status();
  assert.deepStrictEqual([s.lastRun.total, s.lastRun.done], [1, 1]);
});

test('ETA is in work units and null when a remaining video has no known length', async () => {
  let t = 0;
  const { q, release } = harness({ workers: 1, now: () => t });
  q.enqueue([{ id: 1, filename: 'a.jpg', units: 1 }, { id: 2, filename: 'v.mp4', units: 1000 }, { id: 3, filename: 'b.jpg', units: 1 }]);
  assert.strictEqual(q.status().etaS, null, 'nothing finished yet');
  t = 2000; await release(1);                       // 1 unit took 2 s
  const s = q.status();
  // the video is a quarter done (harness reports 0.25): 750 + 1 units left at 2 s each
  assert.ok(s.etaS >= 1495 && s.etaS <= 1510, `about 751 units x 2 s, got ${s.etaS}`);
  q.enqueue([{ id: 4, filename: 'x.mp4' }]);        // unknown length
  assert.strictEqual(q.status().etaS, null);
  q.cancel();
  await q.settled();
});

test('cancel leaves click runs alone; cancel({ includeDirect }) stops them too', async () => {
  const { q, aborted, release } = harness({ workers: 1 });
  q.enqueue(items(1));
  const click = q.runNow({ id: 2, filename: '2.jpg' });
  q.cancel();
  assert.deepStrictEqual(aborted, [1], 'only the queue file was aborted');
  await release(2);
  assert.strictEqual(await click, 'done');
  const click2 = q.runNow({ id: 3, filename: '3.jpg' });
  q.cancel({ includeDirect: true });
  assert.strictEqual(await click2, 'aborted');
  await q.settled();
});

test('a click joining a running queue file takes it over: Stop leaves it, tallies drop it', async () => {
  const { q, started, aborted, release } = harness({ workers: 1 });
  q.enqueue(items(1, 2));
  assert.deepStrictEqual(started, [1]);
  const click = q.runNow({ id: 1, filename: '1.jpg' });      // joins the running queue run
  assert.deepStrictEqual(started, [1, 2], 'its worker slot went back to the queue');
  assert.strictEqual(q.status().total, 1);
  q.cancel();                                                   // the Stop button
  assert.deepStrictEqual(aborted, [2], 'the joined click run kept going');
  await release(1);
  assert.strictEqual(await click, 'done');
  await q.settled();
  assert.strictEqual(q.status().lastRun.done, 0, 'the joined run never counts as queue work');
});

test('regression: a queue file a click joined goes back to the queue on suspend (vault lock)', async () => {
  const { q, started, aborted } = harness({ workers: 1 });
  q.enqueue(items(1, 2));
  const click = q.runNow({ id: 1, filename: '1.jpg' });        // joins the running queue file
  assert.deepStrictEqual(started, [1, 2]);
  assert.strictEqual(q.status().total, 1);
  q.suspend();
  assert.strictEqual(await click, 'aborted');
  await tick();
  assert.deepStrictEqual(aborted.sort(), [1, 2]);
  assert.ok(q.isQueued(1), 'file 1 is queued again');
  assert.strictEqual(q.status().total, 2, 'and counted in the batch again');
  q.unsuspend();
  assert.strictEqual(started.length, 3, 'the queue resumes');
  assert.ok(started[2] === 1 || q.isQueued(1), 'file 1 runs or waits as queue work');
  q.cancel();
  await q.settled();
});
