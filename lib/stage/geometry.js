/**
 * Stage window sizes (PLAYLISTS_SPEC 5, Stage decision 4). Pure.
 *
 * A size preset is the size of the PICTURE (the window's client area), not of
 * the window: 1080p means the page Discord captures is exactly 1920 x 1080.
 * The window around it is larger by its frame. The Stage host has no title
 * bar, but Windows still keeps invisible resize borders on the left, right and
 * bottom, so the two sizes differ by a few pixels that depend on the DPI.
 *
 * The host reports both rectangles (screen pixels); this works out the window
 * rectangle that gives a client area of the wanted size, keeping the picture's
 * top-left corner where it is, and inside the work area when it fits there.
 *
 * Rectangles are { x, y, w, h }.
 */

const MIN_CLIENT = Object.freeze({ w: 160, h: 90 });

function isRect(r) {
  return !!r && ['x', 'y', 'w', 'h'].every(k => Number.isFinite(r[k])) && r.w > 0 && r.h > 0;
}

/** How much bigger the window is than its client area, per side (never negative). */
function frameInsets(win, client) {
  if (!isRect(win) || !isRect(client)) return { l: 0, t: 0, r: 0, b: 0 };
  const nn = (v) => Math.max(0, Math.round(v));
  return {
    l: nn(client.x - win.x),
    t: nn(client.y - win.y),
    r: nn((win.x + win.w) - (client.x + client.w)),
    b: nn((win.y + win.h) - (client.y + client.h)),
  };
}

/**
 * The window rectangle whose client area is `size` ({ w, h }).
 * @param {{w:number,h:number}} size  wanted client size
 * @param {object} win      the window's rectangle now
 * @param {object} client   its client area now, in screen pixels
 * @param {object} [work]   the work area of the monitor it is on (optional)
 */
function windowRectForClient(size, win, client, work) {
  const cw = Math.max(MIN_CLIENT.w, Math.round(Number(size && size.w) || 0));
  const ch = Math.max(MIN_CLIENT.h, Math.round(Number(size && size.h) || 0));
  const f = frameInsets(win, client);
  let cx = isRect(client) ? Math.round(client.x) : 0;
  let cy = isRect(client) ? Math.round(client.y) : 0;
  if (isRect(work)) {
    // Keep the picture on its monitor: pull it back in when it would run off
    // the right or bottom, but never past the left or top edge (a preset
    // larger than the screen starts at the work area's corner).
    cx = Math.max(work.x, Math.min(cx, work.x + work.w - cw));
    cy = Math.max(work.y, Math.min(cy, work.y + work.h - ch));
  }
  return { x: cx - f.l, y: cy - f.t, w: cw + f.l + f.r, h: ch + f.t + f.b };
}

/** The client size a window of `win` has with these insets (the inverse, for checks). */
function clientSizeFor(win, insets) {
  const f = insets || { l: 0, t: 0, r: 0, b: 0 };
  return { w: win.w - f.l - f.r, h: win.h - f.t - f.b };
}

/** Which preset (or 'free') a client size is. */
function presetOf(client, presets) {
  if (!isRect(client)) return 'free';
  for (const [name, p] of Object.entries(presets || {})) {
    if (Math.round(client.w) === p.w && Math.round(client.h) === p.h) return name;
  }
  return 'free';
}

/**
 * A stored window rectangle that is still usable: whole pixels, a sane size,
 * and at least partly on one of `screens` (work areas) when they are known.
 * null otherwise (the host then picks its default spot).
 */
function usableBounds(b, screens) {
  if (!isRect(b) || b.w < MIN_CLIENT.w || b.h < MIN_CLIENT.h || b.w > 16384 || b.h > 16384) return null;
  const r = { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) };
  if (Array.isArray(screens) && screens.length) {
    // At least 64 x 64 px of it on some monitor, so it can be grabbed.
    const onOne = screens.some(s => isRect(s)
      && Math.min(r.x + r.w, s.x + s.w) - Math.max(r.x, s.x) >= 64
      && Math.min(r.y + r.h, s.y + s.h) - Math.max(r.y, s.y) >= 64);
    if (!onOne) return null;
  }
  return r;
}

module.exports = { MIN_CLIENT, isRect, frameInsets, windowRectForClient, clientSizeFor, presetOf, usableBounds };
