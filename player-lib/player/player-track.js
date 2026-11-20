/* =========================================================================
   PLAYER TRACK - the pink progress line and the time left in the full
   player (player-lib/track-progress.js has the rules and the setting).

   - The time left rides beside the name at the top left: Classic's header
     (#mediaPlayerLeft) and Modern's top bar (#mpLeft). They show with the
     controls, as the name always has. A long name is cut (ellipsis) so the
     time left always shows in full (css/player/player-base.css).
   - As a file starts the name and time left show on their own for the
     seconds of Settings > Stage "Show the name as a file starts" (the same
     setting as Stage; off there, no moment here either): the overlay's
     .tp-moment class, the buttons hidden.
   - The 3 px pink line (.tp-line) runs along the top edge of the picture
     (of the video column for audio and mixes): with the controls, in the
     start moment, and at rest too with "Always show the progress line"
     (.tp-always).
   - Videos, audio and mixes only: pictures and documents have no progress.

   Where the line sits and the time left are kept current from the playing
   element's own timeupdate (about 4 a second, one capturing listener on
   the document for every element). The line's fill moves every animation
   frame while the file plays and the line shows (paintLine, from
   player-smooth.js), so it glides instead of stepping. The mini player,
   fullscreen and the Wall under the player are untouched: everything here
   lives in #mediaPlayerOverlay.
   ========================================================================= */

const PlayerTrack = (() => {
  let line = null;
  let fill = null;
  let momentTimer = null;

  const overlay = () => document.getElementById('mediaPlayerOverlay');
  const hasProgress = (type) => type === 'video' || type === 'audio' || type === 'mix';
  const TP = () => (typeof TrackProgress !== 'undefined' ? TrackProgress : null);

  function state() { return typeof currentMediaState !== 'undefined' ? currentMediaState : null; }

  /** The playing <video> or <audio> (a mix's master), or null. */
  function media() {
    const st = state();
    const el = st && st.element;
    return el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') && hasProgress(st.type) ? el : null;
  }

  function ensureLine() {
    const main = document.querySelector('#mediaPlayerOverlay .media-player-main');
    if (!main) return null;
    if (!line || line.parentNode !== main) {
      if (line) line.remove();
      line = document.createElement('div');
      line.className = 'tp-line';
      line.setAttribute('aria-hidden', 'true');
      fill = document.createElement('i');
      line.appendChild(fill);
      main.appendChild(line);
      // The info panel opening or a paused video's window changing size moves the picture.
      if (typeof ResizeObserver === 'function') new ResizeObserver(() => update()).observe(main);
    }
    return main;
  }

  /** Along the top edge of the picture (a video), else of the whole column. */
  function place(main, el) {
    const m = main.getBoundingClientRect();
    let left = 0, width = m.width, top = 0;
    if (el.tagName === 'VIDEO' && state().type === 'video') {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const l = Math.max(r.left, m.left);
        const rr = Math.min(r.right, m.right);
        left = l - m.left;
        width = Math.max(0, rr - l);
        top = Math.max(0, Math.min(m.height - 3, r.top - m.top));
      }
    }
    const s = line.style;
    const px = (n) => `${Math.round(n)}px`;
    if (s.left !== px(left)) s.left = px(left);
    if (s.width !== px(width)) s.width = px(width);
    if (s.top !== px(top)) s.top = px(top);
  }

  /** The line and the time left as they are now. */
  function update() {
    const ov = overlay();
    const tp = TP();
    if (!ov || !tp || !ov.classList.contains('active')) return;
    const el = media();
    const p = el ? tp.fileProgress(el.currentTime, el.duration) : null;
    ov.classList.toggle('tp-has', !!p);
    const text = p ? tp.leftText(p.left) : '';
    for (const id of ['mediaPlayerLeft', 'mpLeft']) {
      const span = document.getElementById(id);
      if (span && span.textContent !== text) span.textContent = text;
    }
    if (!p) return;
    const main = ensureLine();
    if (!main) return;
    place(main, el);
    fill.style.transform = `scaleX(${p.frac.toFixed(5)})`;
  }

  /**
   * The line's fill only, every animation frame while the file plays
   * (player-smooth.js): no measuring, so a frame is one style write. Where
   * the line sits and the time left keep the timeupdate cadence (update).
   */
  function paintLine(el) {
    const ov = overlay();
    const tp = TP();
    if (!fill || !line || !line.isConnected || !ov || !tp || el !== media()) return;
    if (!ov.classList.contains('tp-has')) return;
    // Drawn only while it shows: with the controls, the start moment, or always on.
    if (!(ov.classList.contains('controls-visible') || ov.classList.contains('tp-moment') || ov.classList.contains('tp-always'))) return;
    const p = tp.fileProgress(el.currentTime, el.duration);
    if (p) fill.style.transform = `scaleX(${p.frac.toFixed(5)})`;
  }

  function syncAlways() {
    const ov = overlay();
    const tp = TP();
    if (ov && tp) ov.classList.toggle('tp-always', tp.settings().always === true);
  }

  /** A file opened in the full player (openMedia): the start moment, and the line from the start. */
  function fileStarted(type) {
    const ov = overlay();
    const tp = TP();
    if (!ov || !tp) return;
    clearTimeout(momentTimer);
    ov.classList.remove('tp-moment');
    tp.ensure().then(syncAlways);
    syncAlways();
    update();
    const s = tp.settings();
    if (!hasProgress(type) || !s.showName) return;
    ov.classList.add('tp-moment');
    momentTimer = setTimeout(() => ov.classList.remove('tp-moment'), s.nameSeconds * 1000);
  }

  function onMedia(e) { if (e.target === media()) update(); }

  if (typeof document !== 'undefined') {
    // Media events do not bubble, but a capturing listener up here sees them all.
    for (const type of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked']) {
      document.addEventListener(type, onMedia, true);
    }
    window.addEventListener('resize', () => update());
    window.addEventListener('vault-track-progress', () => { syncAlways(); update(); });
  }

  return { fileStarted, update, paintLine };
})();

if (typeof window !== 'undefined') window.PlayerTrack = PlayerTrack;
