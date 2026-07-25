/* =========================================================================
   ElapsedTimer — pause/resume-capable game clock.

   Games must freeze their timer whenever their view isn't active (tab switch,
   game switch). A plain "now - startTime" timer can't pause, so this
   accumulates elapsedMs across run intervals: pause() banks the current
   interval's delta and stops the rAF; resume() re-anchors startedAt. Restore
   seeds elapsedMs from a saved game, then resume() continues from there.
   ========================================================================= */

class ElapsedTimer {
  constructor() {
    this._elapsedMs = 0;      // banked time from completed run intervals
    this._startedAt = null;   // perf timestamp of the current run interval (null = paused)
    this._raf = null;
    this._onTick = null;      // callback(elapsedSeconds), fired each frame while running
  }

  /** Begin ticking (from the current elapsedMs). */
  start(onTick) {
    this._onTick = onTick || null;
    this.resume();
  }

  resume() {
    if (this._startedAt != null) return;    // already running
    this._startedAt = performance.now();
    const loop = () => {
      if (this._startedAt == null) return;  // paused between frames
      if (this._onTick) this._onTick(this.elapsedMs() / 1000);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() {
    if (this._startedAt == null) return;    // already paused
    this._elapsedMs += performance.now() - this._startedAt;
    this._startedAt = null;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }

  /** Total elapsed including the in-progress interval. */
  elapsedMs() {
    return this._elapsedMs + (this._startedAt != null ? performance.now() - this._startedAt : 0);
  }

  /** Seed elapsed on restore (call before resume()). */
  setElapsedMs(ms) {
    this._elapsedMs = Math.max(0, Number(ms) || 0);
    this._startedAt = null;
  }

  get running() { return this._startedAt != null; }

  /** Stop for good (same as pause; kept for API symmetry with old ScoreKeeper). */
  stop() { this.pause(); }
}

// Global (no module system in this app; loaded before the game scripts)
window.ElapsedTimer = ElapsedTimer;
