/**
 * Face indexing queue (FACES_BUILD_SPEC section 5).
 *
 * Its own in-memory queue, separate from the AI import queue: face work is
 * CPU, AI scans wait on the GPU server, so neither starves the other. Not
 * persisted: "Find faces in everything" only enqueues unindexed files, so
 * pressing it again after a restart resumes the work.
 *
 * `runFile(item, { signal, onProgress })` does one file and resolves true
 * (indexed) or false (failed, already recorded). If `signal` fired the run
 * counts as aborted whatever it returned.
 *
 * runNow (a user click) runs outside the queue: it never counts toward
 * total/done/failed/lastRun/ETA and is not listed as queue work, but a click
 * on a file that is queued takes it out of the queue, and a click on a file a
 * worker is already running joins that run instead of running it twice.
 *
 * ETA is estimated in work units (item.units: 1 for a photo, the expected
 * frame count for a video) from the throughput of finished files; when any
 * remaining item has unknown units, or nothing has finished yet, etaS is null.
 *
 * Pause stops new files starting (running ones finish). Cancel clears the
 * pending list and aborts running files. Suspend (vault lock) aborts running
 * files and puts them back at the front, to restart on unsuspend.
 */

function createQueue({ runFile, workers = 2, now = Date.now } = {}) {
  if (typeof runFile !== 'function') throw new Error('createQueue: runFile is required');

  let pending = [];                 // items { id, filename, force, reason }
  const pendingIds = new Set();
  const active = new Map();         // id -> { item, ctrl, progress, startedAt, direct, requeue, promise }
  // Cancelled runs still winding down (ffmpeg being killed). They are out of
  // `active` at once, so the same file can be queued or run again right away;
  // an aborted run never writes, so the two cannot both save.
  const draining = new Set();
  let limit = Math.max(1, Math.trunc(workers) || 1);
  let paused = false;
  let suspended = false;
  let total = 0, done = 0, failed = 0;
  let startedAt = null;
  let lastRun = null;               // { total, done, failed, finishedAt } of the last finished run
  const durations = [];             // { ms, units } of finished queue files
  const DURATION_SAMPLES = 50;

  function idle() { return workerCount() === 0 && pending.length === 0; }

  /** The run is over (finished or cancelled): park its tally, zero the counters. */
  function finishIfIdle() {
    if (!idle() || (total === 0 && done === 0 && failed === 0 && startedAt == null)) return;
    lastRun = { total, done, failed, finishedAt: new Date(now()).toISOString() };
    total = 0; done = 0; failed = 0; startedAt = null; durations.length = 0;
  }

  function workerCount() {
    let n = 0;
    for (const a of active.values()) if (!a.direct) n++;
    return n;
  }

  function pump() {
    while (!paused && !suspended && pending.length && workerCount() < limit) {
      const item = pending.shift();
      pendingIds.delete(item.id);
      start(item, false);
    }
  }

  function start(item, direct) {
    const ctrl = new AbortController();
    const entry = { item, ctrl, progress: 0, startedAt: now(), direct, requeue: false };
    if (!direct && startedAt == null) startedAt = entry.startedAt;
    active.set(item.id, entry);
    entry.promise = (async () => {
      let outcome;
      try {
        const ok = await runFile(item, {
          signal: ctrl.signal,
          onProgress: (p) => { entry.progress = progressOf(p, entry.progress); },
        });
        outcome = ctrl.signal.aborted ? 'aborted' : (ok === false ? 'failed' : 'done');
      } catch (err) {
        outcome = ctrl.signal.aborted ? 'aborted' : 'failed';
        if (outcome === 'failed') console.warn(`[Faces] ${item.filename || item.id}: ${err.message}`);
      } finally {
        if (active.get(item.id) === entry) active.delete(item.id);
        draining.delete(entry);
      }
      if (outcome === 'aborted' && entry.requeue) {
        // interrupted by suspend (vault lock): back to the front of the queue.
        // A queue file a click had joined rejoins the batch it came from.
        if (!pendingIds.has(item.id) && !active.has(item.id)) {
          pending.unshift(item);
          pendingIds.add(item.id);
          if (entry.joined) total++;
        }
      } else if (entry.direct) {
        // a click (or a queue run a click joined): outside the queue's tallies
      } else if (outcome === 'done') {
        done++;
        durations.push({ ms: now() - entry.startedAt, units: unitsOf(item) });
        if (durations.length > DURATION_SAMPLES) durations.shift();
      } else if (outcome === 'failed') {
        failed++;
      } else if (!entry.cancelled) {
        total = Math.max(0, total - 1);   // aborted outside cancel(): drop from the run
      }
      pump();
      finishIfIdle();
      return outcome;
    })();
    return entry;
  }

  /** Add items (deduped against pending and running). @returns {{added, already}} */
  function enqueue(items, { front = false } = {}) {
    let added = 0, already = 0;
    const fresh = [];
    for (const it of items) {
      if (pendingIds.has(it.id) || active.has(it.id)) { already++; continue; }
      pendingIds.add(it.id);
      fresh.push(it);
      added++;
    }
    pending = front ? fresh.concat(pending) : pending.concat(fresh);
    total += added;
    pump();
    return { added, already };
  }

  /**
   * Run one file now, outside the worker limit and regardless of pause (a user
   * is waiting on it). Joins the run already going for that file if any.
   * @returns {Promise<'done'|'failed'|'aborted'>}
   */
  function runNow(item) {
    const running = active.get(item.id);
    if (running) {
      // A worker is already on this file: the click joins that run, which from
      // now on belongs to the click. It leaves the queue's tallies (total drops
      // by one and it never counts as done/failed), Stop leaves it running, and
      // its worker slot goes back to the queue.
      if (!running.direct) {
        running.direct = true;
        running.joined = true;           // still a queue file underneath: a lock requeues it
        running.requeue = false;
        total = Math.max(0, total - 1);
        pump();
        finishIfIdle();
      }
      return running.promise;
    }
    if (pendingIds.has(item.id)) {      // queued: take it out and run it now
      pending = pending.filter(p => p.id !== item.id);
      pendingIds.delete(item.id);
      total = Math.max(0, total - 1);
    }
    const p = start(item, true).promise;
    finishIfIdle();                      // the queue may have just emptied
    return p;
  }

  /** Pause the queue. Nothing queued or running: nothing to pause (stays idle, never "paused" with no Resume). */
  function pause() {
    if (pending.length || workerCount() > 0) paused = true;
    return status();
  }
  function resume() { paused = false; pump(); return status(); }

  /**
   * Stop the queue: drop pending files and abort the running queue files.
   * Click runs (runNow) are the user's own request and keep going unless
   * includeDirect is set (feature off, delete-all).
   */
  function cancel({ includeDirect = false } = {}) {
    total = Math.max(0, total - pending.length);
    pending = [];
    pendingIds.clear();
    paused = false;
    for (const [id, a] of [...active]) {
      if (a.direct && !includeDirect) continue;
      active.delete(id);
      a.requeue = false;
      a.cancelled = true;
      a.ctrl.abort();
      draining.add(a);
      if (!a.direct) total = Math.max(0, total - 1);
    }
    finishIfIdle();
    return status();
  }

  function suspend() {
    if (suspended) return;
    suspended = true;
    for (const a of active.values()) {
      if (!a.direct || a.joined) a.requeue = true;
      a.ctrl.abort();
    }
  }

  function unsuspend() {
    if (!suspended) return;
    suspended = false;
    pump();
  }

  /** Settles once nothing is running (used by tests and delete-all). */
  async function settled() {
    while (active.size || draining.size) {
      await Promise.allSettled([...active.values(), ...draining].map(a => a.promise));
    }
  }

  /** True while work is running (or winding down), or waiting and allowed to run. */
  function isBusy() {
    return active.size > 0 || draining.size > 0 || (pending.length > 0 && !paused && !suspended);
  }

  function setWorkers(n) {
    limit = Math.max(1, Math.trunc(n) || 1);
    pump();
  }

  function estimateEta(queued) {
    const known = durations.filter(d => d.units > 0);
    if (!known.length || !queued.length) return null;
    const msPerUnit = known.reduce((a, d) => a + d.ms, 0) / known.reduce((a, d) => a + d.units, 0);
    let units = 0;
    for (const { item, progress } of queued) {
      const u = unitsOf(item);
      if (!(u > 0)) return null;           // a video of unknown length: no honest estimate
      units += u * (1 - (progress || 0));
    }
    return Math.max(1, Math.round((units * msPerUnit) / Math.max(1, Math.min(limit, queued.length)) / 1000));
  }

  function status() {
    const working = [...active.values()].filter(a => !a.direct);
    const remaining = pending.length + working.length;
    const etaS = estimateEta([...working.map(a => ({ item: a.item, progress: a.progress })), ...pending.map(item => ({ item, progress: 0 }))]);
    return {
      running: remaining > 0,
      paused: paused || suspended,
      total, done, failed,
      current: working.map(a => ({ id: a.item.id, filename: a.item.filename || null, progress: a.progress })),
      startedAt: startedAt == null ? null : new Date(startedAt).toISOString(),
      etaS,
      lastRun,
    };
  }

  return { enqueue, runNow, pause, resume, cancel, suspend, unsuspend, settled, isBusy, setWorkers, status,
    isQueued: (id) => pendingIds.has(id) || active.has(id) };
}

/** Work units of an item (see header); NaN when unknown. */
function unitsOf(item) {
  const u = Number(item && item.units);
  return Number.isFinite(u) && u > 0 ? u : NaN;
}

/** Normalize whatever analyzeFile reports into a 0..1 fraction. */
function progressOf(p, prev) {
  let f = null;
  if (typeof p === 'number') f = p;
  else if (p && typeof p === 'object') {
    if (typeof p.fraction === 'number') f = p.fraction;
    else if (typeof p.progress === 'number') f = p.progress;
    else if (p.total > 0 && typeof p.done === 'number') f = p.done / p.total;
    else if (p.totalFrames > 0 && typeof p.framesChecked === 'number') f = p.framesChecked / p.totalFrames;
  }
  if (f == null || !Number.isFinite(f)) return prev;
  return Math.round(Math.max(0, Math.min(1, f)) * 1000) / 1000;
}

module.exports = { createQueue, progressOf };
