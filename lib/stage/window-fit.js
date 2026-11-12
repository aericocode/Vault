/**
 * The Stage window at Free size on Linux: always the video's shape, so the
 * picture fills it with no black bars, like Windows.
 *
 * mpv is started with --keepaspect-window=yes there (mpv-args.js windowPlan),
 * which keeps the shape the window was last sized to while it is dragged
 * (a hint the window manager follows on X11; mpv itself on Wayland). This
 * watches the rest and puts it right over the IPC connection Vault already
 * holds:
 *
 *   - a desktop that ignores the hint (the window ends a drag in another
 *     shape): once the size has stopped changing for a moment, the window is
 *     set to the video's shape, following the side that was dragged;
 *   - the next file with another shape: the window takes that shape with
 *     about the same area (so 16:9, 9:16, 16:9 comes back to the same size);
 *   - the first file after Stage opens, the same.
 *
 * It never acts while the window is maximised or full screen, at a preset
 * size (setEnabled(false)), or with no video (audio only, nothing loaded).
 * Pictures count as video.
 *
 * Sizes: mpv's osd-width / osd-height (the picture area, in the window's own
 * pixels) in, mpv's geometry property (WxH, the same pixels; no position, so
 * the window stays where it is) out. On X11 mpv applies geometry again on
 * every new file, so after a drag that already has the right shape the
 * geometry is set to that size too, without changing anything on screen.
 *
 * No loops: a size that comes back right after Vault's own request in the
 * wrong shape gets that request once more (the desktop may have held it to
 * the old shape hint); after that, whatever comes back is accepted as it is
 * (the desktop may round it or keep it on the screen). Apart from that one
 * repeat, a request is never sent twice for the same size.
 */

const MIN_SIDE = 160;        // never smaller than this on its short side
const SCREEN_SHARE = 0.95;   // never larger than this much of the display
const SETTLE_MS = 450;       // the size has to rest this long (a drag keeps changing it)
const ANSWER_MS = 1500;      // what comes back this soon after a request is the answer to it
const WHEEL_STEP = 1.1;      // one wheel notch

const isSize = (s) => !!s && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0;
const same = (a, b) => isSize(a) && isSize(b) && a.w === b.w && a.h === b.h;

/**
 * The video's shape (width / height) as it is shown, from mpv's
 * video-out-params: display size (pixel aspect and any aspect override
 * already in), turned a quarter for a 90 or 270 degree rotation. null with
 * no video.
 */
function videoAspect(params) {
  if (!params || typeof params !== 'object') return null;
  let w = Number(params.dw);
  let h = Number(params.dh);
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  const rot = ((Math.round(Number(params.rotate) || 0) % 360) + 360) % 360;
  if (rot % 180 === 90) [w, h] = [h, w];
  return w / h;
}

/**
 * Is the window already the video's shape? Within a pixel: a desktop that
 * rounds a size by one never starts another round of requests, and a one
 * pixel difference shows no bar.
 */
function fitsAspect(win, aspect) {
  if (!isSize(win) || !(aspect > 0)) return false;
  return Math.abs(Math.round(win.w / aspect) - win.h) <= 1 || Math.abs(Math.round(win.h * aspect) - win.w) <= 1;
}

/**
 * The size the window should have: the video's shape, near `win`.
 *
 *   - `prev` (the size it had before) and one side changed more than the
 *     other: that side stays and the other follows (a drag of the right edge
 *     keeps the new width);
 *   - otherwise (a new video, or both changed alike): about the same area;
 *   - then kept within `screen` (the display, if known) and at least
 *     MIN_SIDE on its short side, still in shape.
 *
 * Whole pixels, and always fitsAspect(); a size that already is comes back
 * as it is. Pure.
 * @param {object} o
 * @param {{w:number,h:number}} o.win
 * @param {number} o.aspect                      width / height
 * @param {{w:number,h:number}|null} [o.prev]
 * @param {{w:number,h:number}|null} [o.screen]
 * @returns {{w:number,h:number}|null}
 */
function fitSize({ win, aspect, prev = null, screen = null }) {
  if (!isSize(win) || !(aspect > 0) || !Number.isFinite(aspect)) return null;
  const inside = (s) => Math.min(s.w, s.h) >= MIN_SIDE
    && (!isSize(screen) || (s.w <= Math.floor(screen.w * SCREEN_SHARE) && s.h <= Math.floor(screen.h * SCREEN_SHARE)));
  // Already in shape and within limits: as it is (so asking again changes nothing).
  if (fitsAspect(win, aspect) && inside(win) && Number.isInteger(win.w) && Number.isInteger(win.h)) return { w: win.w, h: win.h };
  let side = 'area';
  if (isSize(prev)) {
    const dw = Math.abs(win.w - prev.w) / prev.w;
    const dh = Math.abs(win.h - prev.h) / prev.h;
    if (dw > dh) side = 'w';
    else if (dh > dw) side = 'h';
  }
  let w;
  let h;
  if (side === 'w') { w = win.w; h = w / aspect; }
  else if (side === 'h') { h = win.h; w = h * aspect; }
  else { h = Math.sqrt((win.w * win.h) / aspect); w = h * aspect; }
  let changed = false;
  if (isSize(screen)) {
    const maxW = Math.floor(screen.w * SCREEN_SHARE);
    const maxH = Math.floor(screen.h * SCREEN_SHARE);
    if (w > maxW) { w = maxW; h = w / aspect; changed = true; }
    if (h > maxH) { h = maxH; w = h * aspect; changed = true; }
  }
  const short = Math.min(w, h);
  if (short < MIN_SIDE) { w *= MIN_SIDE / short; h *= MIN_SIDE / short; changed = true; }
  // Round the side that leads, then the other from it, so the shape holds.
  if (side === 'w' && !changed) {
    w = Math.round(w);
    h = Math.max(1, Math.round(w / aspect));
  } else {
    h = Math.max(1, Math.round(h));
    w = Math.max(1, Math.round(h * aspect));
  }
  return { w, h };
}

/** One wheel notch bigger (+1) or smaller (-1), in the video's shape (or the window's, with no video). */
function stepSize({ win, aspect, dir, screen = null }) {
  if (!isSize(win)) return null;
  const k = dir > 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
  const a = aspect > 0 ? aspect : win.w / win.h;
  return fitSize({ win: { w: win.w * k, h: win.h * k }, aspect: a, screen });
}

/**
 * The watcher for one Stage window.
 * @param {object} o
 * @param {(size: {w:number,h:number}) => void} o.setGeometry   sets mpv's geometry to WxH
 * @param {() => Promise<{w:number,h:number}|null>} [o.getScreen]  the display's size, or null
 * @param {(size: {w:number,h:number}) => void} [o.onSettled]   the window rests at this size (Free size)
 */
function createWindowFit({
  setGeometry, getScreen = async () => null, onSettled = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, settleMs = SETTLE_MS,
} = {}) {
  let enabled = false;
  let stopped = false;
  const win = { w: 0, h: 0 };
  let aspect = null;
  let maximized = false;
  let fullscreen = false;
  let settled = null;      // the size it rested at last (Free size)
  let geometry = null;     // the geometry Vault set last
  let askedAt = 0;         // when Vault last asked for a size
  let retried = false;     // that request was sent a second time
  let timer = null;
  let running = Promise.resolve();

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; running = running.then(check, check); }, settleMs);
    if (timer && timer.unref) timer.unref();
  }

  function ask(size) {
    geometry = { ...size };
    askedAt = now();
    setGeometry({ ...size });
  }

  const blocked = () => stopped || !enabled || maximized || fullscreen;

  async function check() {
    if (blocked() || !isSize(win) || !(aspect > 0)) return;
    const cur = { w: win.w, h: win.h };
    if (askedAt && now() - askedAt < ANSWER_MS) {
      askedAt = 0;
      if (fitsAspect(cur, aspect) || retried) {
        // The answer to Vault's own request: taken as it is.
        retried = false;
        settled = cur;
        onSettled({ ...cur });
        return;
      }
      if (!same(cur, geometry)) {
        // The desktop held the window to the old shape: on X11 mpv sends the
        // new shape hint just after the new size, so the request can meet the
        // old hint. Asked once more, then whatever comes back stands.
        retried = true;
        ask(geometry);
        return;
      }
      // Got the size asked for, but it is not this video's shape (a size from
      // before, set back by a size pick): fitted like any other.
    }
    askedAt = 0;
    retried = false;
    let screen = null;
    try { screen = await getScreen(); } catch { screen = null; }
    if (blocked()) return;
    const target = fitsAspect(cur, aspect) ? cur : fitSize({ win: cur, aspect, prev: settled, screen });
    if (!target) return;
    if (same(target, cur)) {
      settled = cur;
      // In shape already: only keep mpv's geometry in step (X11 applies it again on the next file).
      if (!same(geometry, cur)) { geometry = { ...cur }; setGeometry({ ...cur }); }
      onSettled({ ...cur });
      return;
    }
    if (same(target, geometry)) {
      // Asked for exactly this before and did not get it: the desktop's answer stands.
      settled = cur;
      onSettled({ ...cur });
      return;
    }
    settled = target;
    ask(target);
  }

  return {
    /** A property-change from mpv (only the ones below matter). */
    onProperty(name, data) {
      switch (name) {
        case 'osd-width':
        case 'osd-height': {
          const v = Number(data);
          const k = name === 'osd-width' ? 'w' : 'h';
          if (Number.isFinite(v) && v > 0 && v !== win[k]) { win[k] = v; schedule(); }
          break;
        }
        case 'video-out-params': {
          const a = videoAspect(data);
          if (a !== aspect) { aspect = a; if (a) schedule(); }
          break;
        }
        case 'window-maximized':
          maximized = data === true;
          if (!maximized) schedule();
          break;
        case 'fullscreen':
          fullscreen = data === true;
          if (!fullscreen) schedule();
          break;
        default:
      }
    },
    /** Free size (true) or a preset (false). */
    setEnabled(on) {
      enabled = on === true;
      if (enabled) schedule();
      else if (timer) { clearTimer(timer); timer = null; }
    },
    /** Vault set the size itself (a preset, back to Free): its answer is accepted too. */
    noteGeometry(size) {
      if (!isSize(size)) return;
      geometry = { w: Math.round(size.w), h: Math.round(size.h) };
      askedAt = now();
    },
    /** The mouse wheel over the picture: one step bigger or smaller (Free size only). */
    async step(dir) {
      if (blocked() || !isSize(win)) return;
      let screen = null;
      try { screen = await getScreen(); } catch { screen = null; }
      if (blocked()) return;
      const target = stepSize({ win, aspect, dir, screen });
      if (!target || same(target, win)) return;
      settled = target;
      ask(target);
    },
    /** The size it rested at last at Free size, or null. */
    freeSize: () => (settled ? { ...settled } : null),
    isMaximized: () => maximized,
    stop() {
      stopped = true;
      if (timer) { clearTimer(timer); timer = null; }
    },
    /** For tests: wait for a check in progress. */
    idle: () => running,
  };
}

module.exports = { createWindowFit, fitSize, fitsAspect, stepSize, videoAspect, MIN_SIDE, SCREEN_SHARE, SETTLE_MS, ANSWER_MS, WHEEL_STEP };
