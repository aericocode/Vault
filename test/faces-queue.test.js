/**
 * lib/faces/queue.js: worker limit, dedupe, pause / resume, cancel aborting
 * running work through its AbortSignal, suspend (vault lock) putting running
 * files back, runNow jumping the queue, and the status shape.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createQueue, progressOf } = require('../lib/faces/queue');

/** runFile whose calls wait until released; records starts and aborts. */
function harness({ workers = 2 } = {}) {
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
  const q = createQueue({ runFile, workers });
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
  assert.strictEqual(q.status().total, 3, 'pulled from pending, not counted twice');
  q.resume();
  await release(1); await release(2);
  assert.strictEqual(q.status().lastRun.done, 3);
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
