/* =========================================================================
   TRACK PROGRESS - the thin pink line along the top of the picture, and the
   file's name with the time left in it beside it ("city-night-drive.webm
   4:12": just the clock, "left" is the word for the whole stream's time
   left on the Stage bar), for the player (player-lib/player/player-track.js), the Wall
   (player-lib/wall.js) and mpv Stage (lib/stage/engine.js,
   lib/stage/mpv-overlay.js).

   When it shows:
   - The player: with the controls, and for the "name as a file starts"
     seconds when a file opens (Settings > Stage, showName / nameSeconds).
   - mpv Stage: as a file starts (the same setting) and when the mouse moves
     over the Stage window.
   - The Wall: on the block the mouse is over.
   One switch for all three, "Always show the progress line" (Settings >
   Stage, progressAlways, kept on the server with the other Stage settings so
   mpv Stage can read it too): the line stays on at rest; the name and the
   time left still fade.

   The pure parts (time left in words, how far along) run in Node for the
   tests. The browser part keeps that one setting (and the name seconds) for
   the pages: TrackProgress.settings(), TrackProgress.load(), and a
   'vault-track-progress' event on window when it changes.
   ========================================================================= */

const TrackProgress = (() => {
  /** "4:12", "1:02:03"; whole seconds, rounded up (it reads 0:00 only at the very end). */
  function clock(seconds) {
    const s = Math.max(0, Math.ceil(Number(seconds) - 1e-6));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  /**
   * The time left in the file as it shows beside the name: "4:12", or ''
   * when it is not known. Just the clock: the word "left" is kept for the
   * stream's time left (the Stage bar's count, the countdown warnings).
   */
  function leftText(seconds) {
    return Number.isFinite(seconds) && seconds >= 0 ? clock(seconds) : '';
  }

  /**
   * How far along a file is: { frac (0..1), left (seconds) }, or null when
   * its length is not known (a stream still opening, a picture).
   */
  function fileProgress(t, d) {
    const dur = Number(d);
    if (!Number.isFinite(dur) || dur <= 0) return null;
    const pos = Math.max(0, Math.min(dur, Number(t) || 0));
    return { frac: pos / dur, left: dur - pos };
  }

  /**
   * How far along the clip a Wall block plays is: the time it has played
   * (elapsed, seconds) against the time until its block changes (leftMs, as
   * the Wall works it out). A clip that never changes (it loops) has no end:
   * then it is the file's own progress, from t and d.
   */
  function clipProgress({ elapsed = 0, leftMs = Infinity, t = 0, d = 0 } = {}) {
    if (!Number.isFinite(leftMs)) return fileProgress(t, d);
    const left = Math.max(0, leftMs / 1000);
    const done = Math.max(0, Number(elapsed) || 0);
    const total = done + left;
    return { frac: total > 0 ? done / total : 1, left };
  }

  /** The Wall's choice: the clip being played, or the whole file (the default). */
  function wallProgress(mode, o) {
    return mode === 'clip' ? clipProgress(o) : fileProgress(o && o.t, o && o.d);
  }

  /* ── The setting, in the browser ──────────────────────────────────── */

  const DEFAULTS = Object.freeze({ always: false, showName: true, nameSeconds: 3 });
  let cur = { ...DEFAULTS };
  let loaded = false;        // the server has answered once
  let loading = null;

  /** The values the pages act on, from Stage settings (lib/stage/settings.js). */
  function fromStage(s) {
    const src = s && typeof s === 'object' ? s : {};
    const n = Math.round(Number(src.nameSeconds));
    return {
      always: src.progressAlways === true,
      showName: src.showName !== false,
      nameSeconds: Number.isFinite(n) ? Math.max(1, Math.min(30, n)) : DEFAULTS.nameSeconds,
    };
  }

  function settings() { return cur; }

  /** Take new Stage settings (a save on the Settings page, or the first load). */
  function update(stageSettings) {
    const next = fromStage(stageSettings);
    const changed = next.always !== cur.always || next.showName !== cur.showName || next.nameSeconds !== cur.nameSeconds;
    cur = next;
    loaded = true;
    if (changed && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('vault-track-progress', { detail: cur }));
    }
    return cur;
  }

  function load() {
    if (typeof fetch !== 'function') return Promise.resolve(cur);
    if (loading) return loading;
    loading = fetch('/api/stage/settings')
      .then(r => (r.ok ? r.json() : null))
      .then((s) => (s ? update(s) : cur))
      .catch(() => cur)
      .finally(() => { loading = null; });
    return loading;
  }

  /** Load once (a locked library refuses the first try: asked again when a page needs it). */
  function ensure() { return loaded ? Promise.resolve(cur) : load(); }

  return { clock, leftText, fileProgress, clipProgress, wallProgress, fromStage, settings, update, load, ensure, DEFAULTS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TrackProgress;
if (typeof window !== 'undefined') {
  window.TrackProgress = TrackProgress;
  // Read once as the page loads; Settings > Stage hands over each save.
  if (typeof document !== 'undefined') TrackProgress.load();
}
