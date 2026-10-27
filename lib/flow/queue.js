/**
 * Flow's measuring queue: one file at a time, in the background.
 *
 * Work comes from two places, in this order:
 *   1. asked for: a collection's files when Flow opens on it, new files when
 *      "Measure for Flow" says New files too (add(ids), first come first);
 *   2. the whole library, when that setting says Whole library now: the next
 *      unmeasured file from nextSweep() (an id, 'later' when it read a stretch
 *      with nothing to do, null at the end; the caller walks the library in
 *      small keyset steps and keeps the cursor across kicks).
 *
 * It waits, and stops a file half-way (that file goes back to the front), when:
 *   - you press Pause (until Resume),
 *   - the vault is locked (nothing is read or written while locked),
 *   - Stage is playing (CPU matters while streaming; checked every 2 s and
 *     on kick()).
 * cancel() drops everything asked for (the sweep stays as the setting says).
 *
 * The measuring itself is a function handed in (measure(id, signal)), so the
 * tests drive the queue with fakes and no ffmpeg.
 */

const SLICE_MS = 8;

function createQueue({
  measure,
  isLocked = () => false,
  stagePlaying = () => false,
  sweepOn = () => false,
  nextSweep = () => null,
  onChange = () => {},
  pollMs = 2000,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const pending = [];             // ids asked for, in order
  const queued = new Set();
  let userPaused = false;
  let running = false;            // the loop is alive
  let current = null;             // { id, ctl }
  let sweepDone = false;          // the whole-library pass found nothing left (until restartSweep())
  let sweepRetry = null;          // a library file stopped half-way: taken again first
  let batch = { done: 0, failed: 0, total: 0 };
  let waitTimer = null;
  let lastReason = null;
  const ms = [];                  // recent per-file times

  function blockedBy() {
    if (userPaused) return 'paused';
    if (isLocked()) return 'locked';
    if (stagePlaying()) return 'stage';
    return null;
  }

  function status() {
    const reason = blockedBy();
    const sweep = !!sweepOn() && !sweepDone;
    const busy = pending.length > 0 || !!current || sweep;
    return {
      state: !busy ? 'idle' : reason ? 'waiting' : 'measuring',
      reason: busy ? reason : (userPaused ? 'paused' : null),
      paused: userPaused,
      current: current ? current.id : null,
      pending: pending.length,
      sweep,
      done: batch.done, failed: batch.failed, total: batch.total,
      avgMs: ms.length ? Math.round(ms.reduce((s, x) => s + x, 0) / ms.length) : null,
    };
  }

  function changed() { try { onChange(status()); } catch {} }

  function take() {
    if (pending.length) {
      const id = pending.shift();
      queued.delete(id);
      return { id, sweep: false };
    }
    if (sweepOn() && !sweepDone) {
      if (sweepRetry != null) { const id = sweepRetry; sweepRetry = null; return { id, sweep: true }; }
      const id = nextSweep();
      if (id === 'later') return { later: true };
      if (id != null) return { id, sweep: true };
      sweepDone = true;
    }
    return null;
  }

  function waitThenRun() {
    timers.clearTimeout(waitTimer);
    waitTimer = timers.setTimeout(() => { waitTimer = null; run(); }, pollMs);
    if (waitTimer && waitTimer.unref) waitTimer.unref();
  }

  async function run() {
    if (running) return;
    running = true;
    let slice = Date.now();
    try {
      for (;;) {
        // Many files can settle at once (missing, no sound): never more than
        // SLICE_MS of that in a row before the server gets to answer others.
        if (Date.now() - slice >= SLICE_MS) {
          await new Promise(r => setImmediate(r));
          slice = Date.now();
        }
        const reason = blockedBy();
        if (reason) {
          if (reason !== lastReason) { lastReason = reason; changed(); }
          // Paused and locked come back through resume() / kick(); Stage is polled.
          if (reason === 'stage' && (pending.length || sweepOn())) waitThenRun();
          return;
        }
        lastReason = null;
        const job = take();
        if (!job) {
          batch = { done: 0, failed: 0, total: 0 };
          changed();
          return;
        }
        if (job.later) {
          // The library walk read a stretch with nothing to measure: let the
          // server breathe, then walk on.
          await new Promise(r => setImmediate(r));
          continue;
        }
        const ctl = new AbortController();
        const cur = { id: job.id, ctl, sweep: job.sweep, cancelled: false };
        current = cur;
        changed();
        const t0 = Date.now();
        // Stage starting (or a lock) mid-file stops the file at once, not after it.
        let watch = null;
        const check = () => {
          watch = null;
          if (current !== cur) return;
          if (blockedBy()) { ctl.abort(); return; }
          watch = timers.setTimeout(check, pollMs);
          if (watch && watch.unref) watch.unref();
        };
        watch = timers.setTimeout(check, pollMs);
        if (watch && watch.unref) watch.unref();
        let ok = true;
        try {
          await measure(job.id, ctl.signal);
        } catch (err) {
          if (ctl.signal.aborted || (err && err.code === 'ABORTED')) {
            timers.clearTimeout(watch);
            current = null;
            if (cur.cancelled) continue;
            // Stopped half-way (Pause, the lock, Stage): it goes back to the front.
            if (!job.sweep && !queued.has(job.id)) { pending.unshift(job.id); queued.add(job.id); }
            if (job.sweep) sweepRetry = job.id;
            continue;
          }
          ok = false;
        }
        timers.clearTimeout(watch);
        current = null;
        if (ok) { ms.push(Date.now() - t0); if (ms.length > 20) ms.shift(); }
        if (!job.sweep) {
          if (ok) batch.done++; else { batch.done++; batch.failed++; }
        }
        changed();
      }
    } finally {
      running = false;
    }
  }

  /** Something may have changed (unlocked, Stage stopped, the setting): look again. */
  function kick() {
    if (current && blockedBy()) { current.ctl.abort(); return; }
    run();
  }

  /** Start the whole-library pass again from the top (the caller resets its cursor). */
  function restartSweep() {
    sweepDone = false;
    run();
  }

  /** Ask for these files (skips ones already waiting). Front: ahead of what is waiting. */
  function add(ids, { front = false } = {}) {
    const fresh = [];
    for (const id of ids) {
      if (!Number.isInteger(id) || id <= 0 || queued.has(id) || (current && current.id === id)) continue;
      queued.add(id);
      fresh.push(id);
    }
    if (front) pending.unshift(...fresh); else pending.push(...fresh);
    batch.total += fresh.length;
    if (fresh.length) changed();
    run();
    return fresh.length;
  }

  function pause() {
    userPaused = true;
    if (current) current.ctl.abort();
    changed();
  }

  function resume() {
    userPaused = false;
    changed();
    run();
  }

  function cancel() {
    pending.length = 0;
    queued.clear();
    batch = { done: 0, failed: 0, total: 0 };
    if (current && !current.sweep) { current.cancelled = true; current.ctl.abort(); }
    changed();
  }

  function has(id) { return queued.has(id) || (!!current && current.id === id); }

  /** The files asked for that are still to do: waiting, and the one being measured (not the library pass's). */
  function ids() {
    const out = pending.slice();
    if (current && !current.sweep && !queued.has(current.id)) out.push(current.id);
    return out;
  }

  return { add, pause, resume, cancel, kick, restartSweep, status, has, ids, _pending: () => pending.slice() };
}

module.exports = { createQueue, SLICE_MS };
