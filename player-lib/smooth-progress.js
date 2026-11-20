/* =========================================================================
   SMOOTH PROGRESS - progress lines that glide at the display's frame rate
   instead of stepping with the media's timeupdate (about 4 a second, so an
   8 s clip drew its line in about 32 visible jumps).

   - fraction(t, d): how far along, 0..1 (0 while the length is unknown).
   - pct(f): a fill's width for that fraction, not rounded to the pixel.
   - reportClock(): a clock kept from position reports (mpv Stage tells its
     time about 4 times a second): between reports it runs on at the rate
     from the last one; a report a little behind what is shown holds the
     line still until the real time catches up (never a step backwards), a
     seek, a wrap to the start or anything further off snaps to it.
   - loop(step): one requestAnimationFrame loop. step(now) draws a frame and
     answers false to stop; kick() starts it again. It never runs while the
     tab is hidden (a visibilitychange kicks every live loop when the tab
     comes back, and each step decides whether there is anything to draw).

   Callers keep their own timeupdate work (the time labels, A-B, saving the
   spot): only the line's position moves per frame, and only writes happen
   in a frame (no reads of layout), so a frame costs one style write.
   The pure parts run in Node for the tests.
   ========================================================================= */

const SmoothProgress = (() => {
  /** How far along a file is, 0..1; 0 while its length is not known. */
  function fraction(t, d) {
    const dur = Number(d);
    const pos = Number(t);
    if (!Number.isFinite(dur) || dur <= 0 || !Number.isFinite(pos)) return 0;
    return Math.max(0, Math.min(1, pos / dur));
  }

  /** A fill's width for a fraction: "37.1234%" (sub-pixel, never rounded to whole pixels). */
  function pct(f) {
    const x = Number(f);
    const c = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
    return `${(c * 100).toFixed(4)}%`;
  }

  /**
   * A clock from position reports.
   *   report(t, now, { running, rate, d, jump }): the position t (seconds) as
   *     of now (ms, performance.now()); running: the time moves on from here;
   *     jump: a seek made here, taken exactly.
   *   timeAt(now): the position now.
   * maxBehind (s): a report at most this far behind what is shown holds the
   * line until the time catches up; further off (a seek, a wrap) snaps.
   */
  function reportClock({ maxBehind = 0.5 } = {}) {
    let base = null;            // { t, at, running, rate, d }
    let floor = -Infinity;      // shown already: the line does not go back past it

    function raw(now) {
      if (!base) return 0;
      let x = base.t;
      if (base.running) x += (Math.max(0, Number(now) - base.at) / 1000) * base.rate;
      if (base.d > 0) x = Math.min(x, base.d);
      return x;
    }

    function timeAt(now) {
      const x = raw(now);
      if (x < floor) return floor;
      floor = -Infinity;
      return x;
    }

    function report(t, now, { running = false, rate = 1, d = 0, jump = false } = {}) {
      const pos = Math.max(0, Number(t) || 0);
      const shown = base ? timeAt(now) : null;
      const wasRunning = !!(base && base.running);
      const r = Number(rate);
      base = {
        t: pos, at: Number(now) || 0, running: !!running,
        rate: Number.isFinite(r) && r > 0 ? r : 1,
        d: Number(d) > 0 ? Number(d) : 0,
      };
      floor = -Infinity;
      if (!jump && running && wasRunning && shown !== null && shown > pos && shown - pos <= maxBehind) floor = shown;
    }

    function reset() { base = null; floor = -Infinity; }

    return { report, timeAt, reset };
  }

  /* ── The frame loop ─────────────────────────────────────────────── */

  const live = new Set();

  /**
   * One requestAnimationFrame loop. step(now) draws a frame; answering
   * false stops the loop until kick() is called again.
   * opts.raf / opts.caf / opts.doc stand in for the browser's in tests.
   */
  function loop(step, opts = {}) {
    const raf = opts.raf || ((cb) => requestAnimationFrame(cb));
    const caf = opts.caf || ((id) => cancelAnimationFrame(id));
    const doc = 'doc' in opts ? opts.doc : (typeof document !== 'undefined' ? document : null);
    let id = 0;
    let dead = false;
    const hidden = () => !!(doc && doc.hidden);

    function frame(now) {
      id = 0;
      if (dead || hidden()) return;
      let more = false;
      try { more = step(now) !== false; } catch (e) { more = false; if (typeof console !== 'undefined') console.warn('[SmoothProgress]', e); }
      if (more && !dead) id = raf(frame);
    }
    const api = {
      kick() { if (!dead && !id && !hidden()) id = raf(frame); },
      stop() { if (id) { caf(id); id = 0; } },
      dispose() { api.stop(); dead = true; live.delete(api); },
      running: () => !!id,
    };
    live.add(api);
    return api;
  }

  /** The tab came back: every loop looks once whether it has something to draw. */
  function kickAll() { for (const l of live) l.kick(); }

  /** Is a media element (or anything shaped like one) playing on? */
  function playing(el) {
    return !!el && !el.paused && !el.ended && el.isConnected !== false;
  }

  /**
   * Follow one media element: paint(t, d) every frame while it plays, and
   * once on each of its events (a seek, a pause, a new length) so the line
   * is exact when it stops. stop() takes it all off.
   */
  const FOLLOW_EVENTS = ['play', 'playing', 'timeupdate', 'seeking', 'seeked', 'ratechange', 'durationchange', 'loadedmetadata', 'pause', 'ended', 'emptied'];
  function follow(el, paint, opts = {}) {
    const lp = loop(() => {
      if (!playing(el)) return false;
      paint(el.currentTime, el.duration);
      return true;
    }, opts);
    const onEvent = () => {
      paint(el.currentTime, el.duration);
      if (playing(el)) lp.kick();
    };
    for (const ev of FOLLOW_EVENTS) el.addEventListener(ev, onEvent);
    onEvent();
    return {
      kick: () => { if (playing(el)) lp.kick(); },
      stop() {
        for (const ev of FOLLOW_EVENTS) el.removeEventListener(ev, onEvent);
        lp.dispose();
      },
    };
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kickAll(); });
  }

  return { fraction, pct, reportClock, loop, follow, playing, kickAll, _liveCount: () => live.size };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SmoothProgress;
if (typeof window !== 'undefined') window.SmoothProgress = SmoothProgress;
