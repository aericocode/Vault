/* =========================================================================
   STAGE COUNTDOWN - the countdown to the end of what Stage plays, and the
   warnings before it. Pure: no DOM, no network, no timers (the caller hands
   it the time), so test/stage-countdown.test.js runs it in Node. The mpv
   Stage engine (lib/stage/engine.js) feeds it the time left about four times
   a second and draws what it answers (lib/stage/mpv-overlay.js
   countdownEvent); the Settings page uses its checks for the minutes field.

   Settings › Stage (lib/stage/settings.js keeps them, off by default):
     warnOn, warnMinutes    "30 minutes left" for a few seconds at each of
                            these minutes before the end
     countdownOn, countdownMinutes
                            from that many minutes before the end, a running
                            clock (4:59) stays on the picture until the end
     countdownCorner, countdownSize   where and how big

   The rules:
   - Time left is clock time ("wall clock") to the moment Stage will run out
     of files: it holds while paused, and it is the caller's job to work it
     out (null: the end is not known, as with Repeat; about: some length is
     not known).
   - A run starts the first time the end is known, and again whenever the
     caller says so (reset: a file picked by hand) or after the end was not
     known for a moment. Nothing carries over from one run to the next.
   - A warning is armed while the time left is above it. It fires once when
     playback carries the time left down across it: down by about as much
     time as went by. A jump across it (a seek forward, a file dropped from
     the list) fires nothing.
   - A run that starts below a warning never fires it: a 12 minute list
     with 30, 15, 10 only says "10 minutes left". Once the time left is
     above it again by a real change (Up next grew past it, a seek back),
     it is armed again and fires when playback crosses it.
   - After it fires, it stays quiet until the time left is more than
     REARM_S above it again, so seeking back and forth a little around it,
     or a moment's wobble in the time, never fires it twice.
   - Two warnings crossed in the same moment show only the nearer one.
   - "about" (a length not known) draws nothing and fires nothing. Coming
     out of it is treated like a jump: the time left starts afresh there,
     so a warning far behind is never shown late.
   ========================================================================= */

const StageCountdown = (() => {
  const MINUTES_MIN = 1;
  const MINUTES_MAX = 600;            // 10 hours
  const MAX_WARNINGS = 8;
  const COUNTDOWN_MIN = 1;
  const COUNTDOWN_MAX = 60;
  const CORNERS = Object.freeze(['top-right', 'top-left', 'bottom-right', 'bottom-left']);
  const SIZES = Object.freeze(['small', 'medium', 'large']);
  const WARN_MS = 6000;               // how long a warning stays up
  const SLACK_S = 2;                  // how far the time left may rise and still count as playing on
  const AHEAD_S = 1;                  // how much more than the time gone by it may fall
  const REARM_S = 10;                 // how far above a fired warning the time left must go to arm it again
  const DEFAULTS = Object.freeze({
    warnOn: false,
    warnMinutes: Object.freeze([30, 15, 10]),
    countdownOn: false,
    countdownMinutes: 5,
    countdownCorner: 'top-right',
    countdownSize: 'medium',
  });

  /** A stored list made valid: whole minutes in range, largest first, no repeats, capped. Not a list: null. */
  function cleanMinutes(list) {
    if (!Array.isArray(list)) return null;
    const ok = list.filter(m => Number.isInteger(m) && m >= MINUTES_MIN && m <= MINUTES_MAX);
    return [...new Set(ok)].sort((a, b) => b - a).slice(0, MAX_WARNINGS);
  }

  /**
   * What the user typed in the minutes field: { ok: true, minutes } or
   * { ok: false, error } in words for the page. Commas, spaces or semicolons
   * between; empty is no warnings.
   */
  function parseMinutes(text) {
    const parts = String(text == null ? '' : text).split(/[\s,;]+/).filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return { ok: false, error: 'Use whole minutes, like 30, 15, 10.' };
      const m = Number(p);
      if (m < MINUTES_MIN || m > MINUTES_MAX) return { ok: false, error: `Each warning must be ${MINUTES_MIN} to ${MINUTES_MAX} minutes.` };
      out.push(m);
    }
    const minutes = [...new Set(out)].sort((a, b) => b - a);
    if (minutes.length > MAX_WARNINGS) return { ok: false, error: `Up to ${MAX_WARNINGS} warnings.` };
    return { ok: true, minutes };
  }

  /** The field's text for a list: "30, 15, 10". */
  function minutesText(list) {
    return (cleanMinutes(list) || []).join(', ');
  }

  /** Any settings object made complete and valid (only the countdown's keys). */
  function settingsOf(s) {
    const src = s && typeof s === 'object' ? s : {};
    const n = Number(src.countdownMinutes);
    return {
      warnOn: src.warnOn === true,
      warnMinutes: cleanMinutes(src.warnMinutes) || DEFAULTS.warnMinutes.slice(),
      countdownOn: src.countdownOn === true,
      countdownMinutes: Number.isInteger(n) && n >= COUNTDOWN_MIN && n <= COUNTDOWN_MAX ? n : DEFAULTS.countdownMinutes,
      countdownCorner: CORNERS.includes(src.countdownCorner) ? src.countdownCorner : DEFAULTS.countdownCorner,
      countdownSize: SIZES.includes(src.countdownSize) ? src.countdownSize : DEFAULTS.countdownSize,
    };
  }

  /** 4:05 under an hour, 1:00:00 from an hour. */
  function clock(seconds) {
    const v = Math.max(0, Math.ceil(Number(seconds) || 0));
    const h = Math.floor(v / 3600);
    const m = Math.floor((v % 3600) / 60);
    const ss = String(v % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /** "10 minutes left", "1 minute left", "2 hours left" (whole hours only), "90 minutes left". */
  function warningText(minutes) {
    const m = Math.max(1, Math.round(Number(minutes) || 1));
    if (m >= 60 && m % 60 === 0) { const h = m / 60; return `${h} ${h === 1 ? 'hour' : 'hours'} left`; }
    return `${m} ${m === 1 ? 'minute' : 'minutes'} left`;
  }

  /**
   * The clock time the end comes at, for the Stage bar: "ends 10:42 PM" in
   * the viewer's own way of writing times, with the weekday when it is not
   * today. null when left is not known.
   */
  function endsAt(left, nowMs = Date.now(), locale = undefined) {
    if (left == null || !(Number(left) >= 0)) return null;
    const end = new Date(nowMs + Number(left) * 1000);
    const today = new Date(nowMs);
    const sameDay = end.getFullYear() === today.getFullYear() && end.getMonth() === today.getMonth() && end.getDate() === today.getDate();
    const opts = sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
    try { return `ends ${end.toLocaleString(locale, opts)}`; } catch { return `ends ${end.toLocaleString(undefined, opts)}`; }
  }

  /**
   * One countdown. update() each time the time left is worked out; it
   * answers what to draw now: { clock: '4:59' | null, warning: '10 minutes
   * left' | null }.
   */
  function create() {
    let run = null;          // { armed, fired, prevLeft, prevAt }
    let warn = null;         // { text, until }

    function reset() { run = null; warn = null; }

    /**
     * @param {object} o
     * @param {number|null} o.left   seconds of clock time to the end; null: not known
     * @param {boolean} [o.about]    some length is not known
     * @param {number} o.at          now, in ms
     * @param {object} o.settings    the countdown settings (settingsOf)
     */
    function update({ left = null, about = false, at = 0, settings = {} } = {}) {
      const s = settingsOf(settings);
      if (left == null || !Number.isFinite(Number(left))) { reset(); return { clock: null, warning: null }; }
      if (about) {
        // Nothing known to count from: the next known time left starts afresh.
        if (run) run.prevLeft = null;
        return { clock: null, warning: null };
      }
      const L = Math.max(0, Number(left));
      if (!run) run = { armed: new Set(), fired: new Set(), prevLeft: null, prevAt: 0 };
      const mins = s.warnOn ? s.warnMinutes : [];
      if (run.prevLeft !== null) {
        const went = Math.max(0, (Number(at) - run.prevAt) / 1000);
        const drop = run.prevLeft - L;
        const natural = drop >= -SLACK_S && drop <= went + AHEAD_S;
        if (natural) {
          let hit = null;
          for (const m of mins) {
            const T = m * 60;
            if (!run.armed.has(m) || !(run.prevLeft > T && L <= T)) continue;
            run.armed.delete(m);
            run.fired.add(m);
            if (hit === null || m < hit) hit = m;
          }
          if (hit !== null) warn = { text: warningText(hit), until: Number(at) + WARN_MS };
        }
      }
      // Armed while above it (a fired one only once well above it again).
      for (const m of mins) {
        const T = m * 60;
        if (L > T + (run.fired.has(m) ? REARM_S : 0)) { run.armed.add(m); run.fired.delete(m); }
      }
      run.prevLeft = L;
      run.prevAt = Number(at);
      if (warn && !(Number(at) < warn.until)) warn = null;
      if (warn && !s.warnOn) warn = null;
      return {
        clock: s.countdownOn && L <= s.countdownMinutes * 60 ? clock(L) : null,
        warning: warn ? warn.text : null,
      };
    }

    return { update, reset, _run: () => run && { fired: [...run.fired], armed: [...run.armed], prevLeft: run.prevLeft } };
  }

  return {
    MINUTES_MIN, MINUTES_MAX, MAX_WARNINGS, COUNTDOWN_MIN, COUNTDOWN_MAX, CORNERS, SIZES, WARN_MS, DEFAULTS,
    cleanMinutes, parseMinutes, minutesText, settingsOf, clock, warningText, endsAt, create,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StageCountdown;
if (typeof window !== 'undefined') window.StageCountdown = StageCountdown;
