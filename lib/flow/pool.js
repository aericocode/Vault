/**
 * The main thread's side of Flow's workers (lib/flow/worker.js): one for
 * measuring and one for Flow order, each started when first needed, unref'd so it never keeps Vault running.
 * Measuring (ffmpeg's output and all the DSP) and Flow order both happen
 * there; the main thread only posts a message and waits.
 *
 * A worker that dies (or hangs past the watchdog, 8 minutes for one file:
 * ffmpeg itself gives up long before that, so only a stuck worker gets
 * there) is replaced, and the file is tried once more in the fresh worker
 * before it counts as "couldn't be measured".
 */

const path = require('path');
const { Worker } = require('worker_threads');

const WATCHDOG_MS = 8 * 60 * 1000;
const RETRYABLE = new Set(['WORKER_EXIT', 'WORKER_ERROR', 'HUNG']);

// Two workers: one measures, one works out Flow order, so a file that hangs
// (until the watchdog replaces its worker) never holds up an order request.
const workers = { measure: null, order: null };
let seq = 0;
const jobs = new Map();          // id -> { resolve, reject }

/** Fail the jobs that were out with this worker (a replacement's jobs carry on). */
function failAll(w, err) {
  for (const [id, j] of [...jobs]) {
    if (j.w !== w) continue;
    jobs.delete(id);
    j.reject(err);
  }
}

function get(kind) {
  if (workers[kind]) return workers[kind];
  const w = new Worker(path.join(__dirname, 'worker.js'));
  w.unref();
  w.on('message', (m) => {
    const j = jobs.get(m && m.id);
    if (!j) return;
    jobs.delete(m.id);
    if (m.ok) j.resolve(m.result);
    else j.reject(Object.assign(new Error(m.error || 'Flow worker failed'), { code: m.code || undefined }));
  });
  w.on('error', (err) => {
    if (workers[kind] === w) workers[kind] = null;
    failAll(w, Object.assign(new Error(`Flow worker failed: ${err && err.message}`), { code: 'WORKER_ERROR' }));
  });
  w.on('exit', () => {
    if (workers[kind] === w) workers[kind] = null;
    failAll(w, Object.assign(new Error('Flow worker stopped'), { code: 'WORKER_EXIT' }));
  });
  workers[kind] = w;
  return w;
}

function call(kind, msg, signal, { timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' }));
    const id = ++seq;
    const w = get(kind);
    let timer = null;
    // Held open while a job is out (so an answer is never lost), unref'd again after.
    const settle = (fn) => (v) => {
      clearTimeout(timer);
      if (![...jobs.values()].some(j => j.w === w)) w.unref();
      fn(v);
    };
    jobs.set(id, { w, resolve: settle(resolve), reject: settle(reject) });
    w.ref();
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const j = jobs.get(id);
        if (!j) return;
        jobs.delete(id);
        j.reject(Object.assign(new Error('Flow worker stopped answering'), { code: 'HUNG' }));
        // A stuck worker cannot be talked to: replace it.
        if (workers[kind] === w) { workers[kind] = null; w.terminate().catch(() => {}); }
      }, timeoutMs);
    }
    if (signal) signal.addEventListener('abort', () => { if (workers[kind] === w) w.postMessage({ type: 'cancel', id }); }, { once: true });
    w.postMessage({ ...msg, id });
  });
}

/** Retry once in a fresh worker when the worker itself failed (not the file). */
async function withRetry(fn, signal) {
  try {
    return await fn();
  } catch (err) {
    if (!err || !RETRYABLE.has(err.code) || (signal && signal.aborted)) throw err;
    return fn();
  }
}

/** Measure a file in the worker (lib/flow/analyze.js measureFile). */
function measure(filePath, { duration = null, signal = null, watchdogMs = WATCHDOG_MS } = {}) {
  return withRetry(() => call('measure', { type: 'measure', filePath, duration }, signal, { timeoutMs: watchdogMs }), signal);
}

/** Flow order in the worker: { order, targets, handovers, jumps }. */
function order(features, { shape, firstId = null } = {}) {
  return withRetry(() => call('order', { type: 'order', features, shape, firstId }, null, { timeoutMs: 60000 }), null);
}

function stop() {
  for (const k of Object.keys(workers)) {
    const w = workers[k];
    workers[k] = null;
    if (w) w.terminate().catch(() => {});
  }
}

module.exports = { measure, order, stop, WATCHDOG_MS };
