/* =========================================================================
   PLAYER SMOOTH - the full player's progress lines and the mini player's
   seek bar move every animation frame while the file plays
   (player-lib/smooth-progress.js), not in timeupdate's steps.

   One loop for the element playing in the player or the mini player (a
   video, an audio file, a mix's master). Each frame it reads its
   currentTime and writes:
   - Classic's seek bar (#videoProgressBar / #audioProgressBar), unless the
     bar is being dragged (the drag draws it),
   - Modern's played segments and knob (ModernDock.paintPlayhead),
   - the pink line along the top of the picture (PlayerTrack.paintLine),
   - the mini player's seek fill (#miniSeekFill), unless dragged.
   Labels (the time, the time left), A-B and the ridge keep their
   timeupdate cadence. The loop starts on play / playing / timeupdate /
   seeked of that element (one capturing listener on the document each) and
   stops by itself when the element pauses, ends, leaves the page or stops
   being the player's element, and while the tab is hidden. A seek, a loop
   back to the start or a speed change is read straight from currentTime,
   so the line snaps rather than gliding back across the bar.
   Stage's bar (mpv or Basic) has its own loop (stage-control.js).
   ========================================================================= */

const PlayerSmooth = (() => {
  /** The <video>/<audio> the player or the mini player plays now, or null. */
  function mediaEl() {
    const st = typeof currentMediaState !== 'undefined' ? currentMediaState : null;
    const el = st && st.element;
    return el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') ? el : null;
  }

  const SP = () => (typeof SmoothProgress !== 'undefined' ? SmoothProgress : null);

  function paintBar(barId, wrapId, pct) {
    const bar = document.getElementById(barId);
    if (!bar) return;
    const wrap = document.getElementById(wrapId);
    if (wrap && wrap.classList.contains('scrubbing')) return;   // the drag wins
    bar.style.width = pct;
  }

  /** Every line that follows this element, at its time now. */
  function paint(el) {
    const sp = SP();
    if (!sp) return;
    const f = sp.fraction(el.currentTime, el.duration);
    const pct = sp.pct(f);
    if (Number.isFinite(el.duration) && el.duration > 0) {
      paintBar('videoProgressBar', 'videoProgressWrapper', pct);
      paintBar('audioProgressBar', 'audioProgressWrapper', pct);
    }
    if (typeof ModernDock !== 'undefined' && ModernDock.paintPlayhead) ModernDock.paintPlayhead(true);
    if (typeof PlayerTrack !== 'undefined' && PlayerTrack.paintLine) PlayerTrack.paintLine(el);
    const mini = document.getElementById('miniPlayer');
    if (mini && mini.classList.contains('active') && (typeof miniMediaEl !== 'function' || miniMediaEl() === el)) {
      const seek = document.getElementById('miniSeek');
      const fill = document.getElementById('miniSeekFill');
      if (fill && !(seek && seek.classList.contains('scrubbing'))) fill.style.width = pct;
    }
  }

  let lp = null;
  function frame() {
    const el = mediaEl();
    if (!el || !SP().playing(el)) return false;
    paint(el);
    return true;
  }

  function onMedia(e) {
    const el = mediaEl();
    if (!el || e.target !== el || !SP()) return;
    if (!lp) lp = SP().loop(frame);
    if (SP().playing(el)) lp.kick();
  }

  if (typeof document !== 'undefined') {
    // Media events do not bubble; a capturing listener up here sees them all.
    for (const type of ['play', 'playing', 'timeupdate', 'seeked', 'ratechange']) {
      document.addEventListener(type, onMedia, true);
    }
  }

  return { paint, running: () => !!(lp && lp.running()) };
})();

if (typeof window !== 'undefined') window.PlayerSmooth = PlayerSmooth;
