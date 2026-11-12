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
 * No loops, however slowly or oddly the desktop answers (none of these
 * depend on timing):
 *   - after Vault asks for a size, the next size that settles is the answer
 *     to it, however late it comes (up to AWAIT_MAX_MS, only so that a
 *     request the desktop ignored entirely does not swallow a later drag);
 *   - an answer within a few pixels of what was asked is accepted as it is;
 *     an answer far off in the wrong shape gets the same request once more
 *     (on X11 mpv sends the new shape hint just after the new size, so the
 *     desktop may hold the first try to the old shape), and whatever comes
 *     back then stands;
 *   - a later size within a few pixels of the size accepted last is taken as
 *     the desktop settling, not the user;
 *   - at most BUDGET requests of Vault's own until something new happens: a
 *     resize by the user (a size well away from anything Vault asked for or
 *     accepted), a new video shape, a size pick or a wheel step.
 * It cannot see the mouse button: mpv does not report a held button while
 * the desktop drags its frame. A drag paused longer than SETTLE_MS may be
 * fitted under the pointer; the next movement of the drag takes over again.
 */

const MIN_SIDE = 160;        // never smaller than this on its short side
const SCREEN_SHARE = 0.95;   // never larger than this much of the display
const SETTLE_MS = 450;       // the size has to rest this long (a drag keeps changing it)
const AWAIT_MAX_MS = 10000;  // a request with no answer at all by then is given up
const BUDGET = 3;            // Vault's own requests between two new things
const WHEEL_STEP = 1.1;      // one wheel notch
const SCREEN_MIN = 2 * MIN_SIDE;   // a display smaller than this is not believed

const isSize = (s) => !!s && Number.isFinite(s.w) && Number.isFinite(s.h) && s.w > 0 && s.h > 0;
const same = (a, b) => isSize(a) && isSize(b) && a.w === b.w && a.h === b.h;
const slack = (n) => Math.max(8, Math.round(n * 0.01));
/** Within a few pixels (8, or 1% of the side) of each other. */
const near = (a, b) => isSize(a) && isSize(b) && Math.abs(a.w - b.w) <= slack(b.w) && Math.abs(a.h - b.h) <= slack(b.h);
/** A display size worth using, or null. */
const usableScreen = (s) => (isSize(s) && s.w >= SCREEN_MIN && s.h >= SCREEN_MIN ? s : null);

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
 *   - then kept within `screen` (the display, if known and believable) and
 *     at least MIN_SIDE on its short side, still in shape.
 *
 * Whole, finite pixels, and always fitsAspect(); a size that already is
 * comes back as it is; null when there is nothing sensible. Pure.
 * @param {object} o
 * @param {{w:number,h:number}} o.win
 * @param {number} o.aspect                      width / height
 * @param {{w:number,h:number}|null} [o.prev]
 * @param {{w:number,h:number}|null} [o.screen]
 * @returns {{w:number,h:number}|null}
 */
function fitSize({ win, aspect, prev = null, screen = null }) {
  if (!isSize(win) || !(aspect > 0) || !Number.isFinite(aspect)) return null;
  const scr = usableScreen(screen);
  const inside = (s) => Math.min(s.w, s.h) >= MIN_SIDE
    && (!scr || (s.w <= Math.floor(scr.w * SCREEN_SHARE) && s.h <= Math.floor(scr.h * SCREEN_SHARE)));
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
  if (scr) {
    const maxW = Math.floor(scr.w * SCREEN_SHARE);
    const maxH = Math.floor(scr.h * SCREEN_SHARE);
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
  if (!Number.isFinite(w) || !Number.isFinite(h) || w > 16384 || h > 16384) return null;
  return { w, h };
}

/**
 * One wheel notch bigger (+1) or smaller (-1), in the video's shape (or the
 * window's, with no video). null when that way is already as far as it goes
 * (smaller at the smallest size, bigger at the screen's).
 */
function stepSize({ win, aspect, dir, screen = null }) {
  if (!isSize(win)) return null;
  const k = dir > 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
  const a = aspect > 0 ? aspect : win.w / win.h;
  const t = fitSize({ win: { w: win.w * k, h: win.h * k }, aspect: a, screen });
  if (!t) return null;
  if (dir > 0 ? t.w * t.h <= win.w * win.h : t.w * t.h >= win.w * win.h) return null;
  return t;
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
  let awaiting = false;    // Vault asked for a size and has not seen it settle since
  let askedAt = 0;
  let retried = false;     // that request was sent a second time
  let budget = BUDGET;     // Vault's own requests left until something new happens
  let timer = null;
  let running = Promise.resolve();

  function schedule() {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; running = running.then(check, check); }, settleMs);
    if (timer && timer.unref) timer.unref();
  }

  function send(size) {
    if (!isSize(size) || !Number.isInteger(size.w) || !Number.isInteger(size.h)) return false;
    geometry = { w: size.w, h: size.h };
    setGeometry({ w: size.w, h: size.h });
    return true;
  }

  /** One of Vault's own requests, if the budget allows; it waits for its answer. */
  function ask(size) {
    if (budget <= 0 || !send(size)) return false;
    budget -= 1;
    awaiting = true;
    askedAt = now();
    return true;
  }

  function accept(cur) {
    settled = cur;
    onSettled({ ...cur });
  }

  const blocked = () => stopped || !enabled || maximized || fullscreen;

  async function check() {
    if (blocked() || !isSize(win) || !(aspect > 0)) return;
    const cur = { w: win.w, h: win.h };
    if (awaiting && now() - askedAt <= AWAIT_MAX_MS) {
      // The answer to Vault's own request, however late.
      awaiting = false;
      if (fitsAspect(cur, aspect) || retried || near(cur, geometry)) { retried = false; accept(cur); return; }
      if (!same(cur, geometry)) {
        // Far off and the wrong shape: the desktop may have held it to the old shape hint. Once more.
        if (geometry && ask(geometry)) { retried = true; return; }
        accept(cur);
        return;
      }
      // Got the size asked for, but it is not this video's shape (a size from
      // before, set back by a size pick): fitted like any other.
    }
    awaiting = false;
    retried = false;
    if (settled && near(cur, settled) && !same(cur, settled)) {
      // A few pixels from where it settled: the desktop settling, not a resize. Kept in step only.
      accept(cur);
      if (fitsAspect(cur, aspect) && !same(geometry, cur)) send(cur);
      return;
    }
    if (settled && !near(cur, settled) && !near(cur, geometry)) budget = BUDGET;   // the user resized it
    let screen = null;
    try { screen = await getScreen(); } catch { screen = null; }
    if (blocked()) return;
    const target = fitSize({ win: cur, aspect, prev: settled, screen });
    if (!target) return;
    if (same(target, cur)) {
      accept(cur);
      // In shape already: only keep mpv's geometry in step (X11 applies it again on the next file).
      if (!same(geometry, cur)) send(cur);
      return;
    }
    if (same(target, geometry)) {
      // Asked for exactly this before and did not get it: the desktop's answer stands.
      accept(cur);
      return;
    }
    if (ask(target)) settled = target;
    else accept(cur);      // out of budget: left as it is until something new happens
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
          if (a !== aspect) {
            aspect = a;
            if (a) { budget = BUDGET; schedule(); }
          }
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
      budget = BUDGET;
      if (enabled) schedule();
      else if (timer) { clearTimer(timer); timer = null; }
    },
    /** Vault set the size itself (a preset, back to Free): its answer is accepted too. */
    noteGeometry(size) {
      if (!isSize(size)) return;
      geometry = { w: Math.round(size.w), h: Math.round(size.h) };
      awaiting = true;
      retried = false;
      askedAt = now();
      budget = BUDGET;
    },
    /** The mouse wheel over the picture: one step bigger or smaller (Free size only). */
    async step(dir) {
      if (blocked() || !isSize(win)) return;
      let screen = null;
      try { screen = await getScreen(); } catch { screen = null; }
      if (blocked()) return;
      const target = stepSize({ win, aspect, dir, screen });
      if (!target || same(target, win)) return;
      budget = BUDGET;
      retried = false;
      if (ask(target)) settled = target;
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

module.exports = { createWindowFit, fitSize, fitsAspect, stepSize, videoAspect, MIN_SIDE, SCREEN_SHARE, SETTLE_MS, AWAIT_MAX_MS, BUDGET, WHEEL_STEP };
