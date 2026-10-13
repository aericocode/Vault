/**
 * A small pool of face engines with idle shutdown.
 *
 * Each onnx engine owns one worker thread (~150 MB with both models loaded)
 * and runs one call at a time, so the service keeps:
 *   - a queue pool: one engine per queue worker (default 2, 2 ORT threads each)
 *   - an interactive pool of size 1 for find-faces-now and search-image, so a
 *     click never waits behind a long background video
 * Engines are created and loaded lazily on acquire(), and closed after
 * `idleMs` without use to give the memory back. Only IDLE engines are closed
 * by the timer; retire() (models re-downloaded, vault locked, delete-all)
 * closes idle engines now and busy ones as soon as they are released, so a
 * request in flight is never cut off by housekeeping.
 *
 * acquire() waits when every slot is busy. Errors from load() release the
 * slot and propagate (e.g. FACE_MODELS_MISSING).
 */

function createEnginePool({ factory, size = 1, idleMs = 120000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof factory !== 'function') throw new Error('createEnginePool: factory is required');
  let limit = Math.max(1, size | 0);
  const slots = new Set();        // { engine, busy, timer, retired, ready }
  const waiters = [];

  function closeSlot(s) {
    slots.delete(s);
    if (s.timer) { clearTimer(s.timer); s.timer = null; }
    try { s.engine.close?.(); } catch { /* best effort */ }
  }

  function armIdle(s) {
    if (s.timer) clearTimer(s.timer);
    s.timer = setTimer(() => { s.timer = null; if (!s.busy) closeSlot(s); }, idleMs);
    s.timer?.unref?.();
  }

  async function acquire() {
    for (;;) {
      for (const s of slots) {
        if (!s.busy && !s.retired) {
          s.busy = true;
          if (s.timer) { clearTimer(s.timer); s.timer = null; }
          return s.engine;
        }
      }
      if (slots.size < limit) {
        const s = { engine: factory(), busy: true, timer: null, retired: false };
        slots.add(s);
        try {
          await s.engine.load();
        } catch (err) {
          closeSlot(s);
          wakeOne();
          throw err;
        }
        return s.engine;
      }
      await new Promise((r) => waiters.push(r));
    }
  }

  function wakeOne() { const w = waiters.shift(); if (w) w(); }

  function release(engine) {
    for (const s of slots) {
      if (s.engine !== engine) continue;
      s.busy = false;
      if (s.retired) closeSlot(s);
      else armIdle(s);
      break;
    }
    wakeOne();
  }

  /** Run fn(engine) with an engine from the pool. */
  async function use(fn) {
    const e = await acquire();
    try { return await fn(e); } finally { release(e); }
  }

  /** Close idle engines now and busy ones when they come back. */
  function retire() {
    for (const s of [...slots]) {
      if (s.busy) s.retired = true;
      else closeSlot(s);
    }
    while (waiters.length) wakeOne();   // let waiters create fresh engines
  }

  function setSize(n) { limit = Math.max(1, n | 0); while (waiters.length) wakeOne(); }

  return {
    acquire, release, use, retire, setSize,
    stats: () => ({ engines: slots.size, busy: [...slots].filter((s) => s.busy).length, waiting: waiters.length, limit }),
  };
}

module.exports = { createEnginePool };
