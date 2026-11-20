/**
 * What Stage draws over the picture in mpv, as osd-overlay ASS events. Pure.
 *
 *   name   the file's name, lower left, as a file starts (Settings › Stage),
 *          faded in and out in steps: an osd-overlay has no clock of its own,
 *          so the caller sends it again with a new alpha for each step;
 *   black  a black sheet over everything (Hold): the file stays loaded and
 *          paused under it, so Hold off is instant;
 *   countdown  the time to the end of the list and warnings before it, in a
 *          corner (Settings › Stage, off by default; player-lib/
 *          stage-countdown.js decides what shows), under the black sheet;
 *   progress  a 3 px pink line along the top edge, filled left to right by
 *          how far along the file is (player-lib/track-progress.js), with
 *          the name; the time left rides beside the name ("4:12 left").
 *
 * The canvas is 720 high and as wide as the window's shape (res_x 0), so
 * nothing is stretched. The name is text from the library: it is made inert
 * (no override blocks, no \N, no line breaks) before it goes in.
 */

const NAME_ID = 1;
const BLACK_ID = 2;
const COUNTDOWN_ID = 3;
const PROGRESS_ID = 4;
const COUNTDOWN_Z = 5;             // over the name (0), under Hold's black sheet (10)
const PROGRESS_Z = 4;              // over the name, under the countdown and Hold's black sheet
const LINE_PX = 3;                 // the line's height in the window's own pixels
const LINE_RGB = '&HA34FFF&';      // #ff4fa3, the default (ASS colours are blue, green, red)
const LINE_TRACK_ALPHA = 0x99;     // the unfilled part: black at 40 %
const RES_Y = 720;
const FONT = 'Segoe UI';
const MAX_CHARS = 80;
const FADE_STEPS = 6;
const FADE_MS = 350;               // the same fade as the old Stage page
const WORD_JOINER = '\u2060';

/** Text that is only text inside an ASS event. */
function assEscape(text) {
  return String(text == null ? '' : text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/\\/g, `\\${WORD_JOINER}`)
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, n = MAX_CHARS) {
  const a = Array.from(s);
  return a.length <= n ? s : `${a.slice(0, n - 1).join('').trimEnd()}…`;
}

/** ASS alpha: 00 is solid, FF is invisible; fade 0..1 scales from invisible to `base`. */
function alpha(base, fade) {
  const f = Math.max(0, Math.min(1, Number(fade) || 0));
  const a = Math.round(255 - (255 - base) * f);
  return `&H${a.toString(16).toUpperCase().padStart(2, '0')}&`;
}

/**
 * The name, lower left (3.2 % in, 4.5 % up, as css/stage.css had it), white
 * semi-bold with a soft dark edge and shadow.
 *
 * With `left` ("4:12") the time left rides right beside the name, a
 * little lighter. With the canvas width known the name is cut to what fits
 * next to it (nameBudget), so the time left always shows in full; the name
 * may be empty (privacy mode, or the name switched off) and then only the
 * time left shows.
 * @param {string} text  already cut to the name (StageRules.nameText)
 * @param {number} fade  0..1
 * @param {{left?: string, canvasW?: number}} [o]
 */
function nameEvent(text, fade = 1, { left = '', canvasW = 0 } = {}) {
  const l = assEscape(left);
  const budget = canvasW > 0 ? nameBudget(canvasW, l) : MAX_CHARS;
  const t = l || canvasW > 0 ? assEscape(truncate(plainText(text), budget)) : truncate(assEscape(text));
  if (!t && !l) return '';
  const y = Math.round(RES_Y * (1 - 0.045));
  const head = `{\\an1\\pos(41,${y})\\fn${FONT}\\fs31\\b1\\q2\\bord1.6\\shad1.2\\1c&HFFFFFF&\\3c&H000000&\\4c&H000000&`
    + `\\1a${alpha(0, fade)}\\3a${alpha(0x50, fade)}\\4a${alpha(0x60, fade)}}`;
  if (!l) return head + t;
  const tail = `{\\b0\\1a${alpha(0x1a, fade)}}${l}`;
  return head + (t ? `${t}\\h\\h\\h` : '') + tail;
}

/** Library text as one plain line (what assEscape starts from), before it is cut. */
function plainText(text) {
  // eslint-disable-next-line no-control-regex
  return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * How many characters of the name fit on one line beside `left` on a canvas
 * `canvasW` wide (720 high): a rough width per character of the 31 px bold
 * name and the time left, so the time left is never pushed off the right edge.
 */
function nameBudget(canvasW, left = '') {
  const leftW = left ? Array.from(left).length * 13 + 26 : 0;
  const avail = Number(canvasW) - 2 * 41 - leftW;
  return Math.max(4, Math.min(MAX_CHARS, Math.floor(avail / 14)));
}

/**
 * The progress line along the top edge: a faint dark track the full width
 * and the pink part filled to `frac`, LINE_PX of the window's pixels high
 * (osdH: the window's height in pixels; the canvas is RES_Y high).
 * @param {number} frac  0..1
 * color: the theme's Second color (#rrggbb, the Stage setting lineColor
 * that the page keeps up to date); the default pink when missing.
 * @param {{canvasW?: number, osdH?: number, fade?: number, color?: string}} [o]
 */
function lineEvent(frac, { canvasW = 0, osdH = 0, fade = 1, color = '' } = {}) {
  const f = Math.max(0, Math.min(1, Number(frac) || 0));
  const w = canvasW > 0 ? Math.round(canvasW) : Math.round(RES_Y * 16 / 9);
  const h = Math.max(1, Math.round((osdH > 0 ? LINE_PX * RES_Y / osdH : LINE_PX) * 100) / 100);
  const rect = (x) => `m 0 0 l ${x} 0 ${x} ${h} 0 ${h}`;
  const base = '{\\an7\\pos(0,0)\\bord0\\shad0\\blur0';
  const track = `${base}\\1c&H000000&\\1a${alpha(LINE_TRACK_ALPHA, fade)}\\p1}${rect(w)}{\\p0}`;
  const fill = Math.round(w * f * 10) / 10;
  if (fill <= 0) return track;
  return `${track}\n${base}\\1c${assColor(color)}\\1a${alpha(0, fade)}\\p1}${rect(fill)}{\\p0}`;
}

/** A #rrggbb color as an ASS colour (&HBBGGRR&); LINE_RGB for anything else. */
function assColor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return LINE_RGB;
  const h = hex.slice(1).toUpperCase();
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`;
}

/** The canvas width (RES_Y high) for a window of osdW x osdH pixels, or 0 when not known. */
function canvasWidth(osdW, osdH) {
  return osdW > 0 && osdH > 0 ? Math.round(RES_Y * osdW / osdH) : 0;
}

/** A black sheet much larger than any canvas (the canvas width follows the window). */
function blackEvent() {
  return '{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H000000&\\1a&H00&\\p1}m -4000 -4000 l 20000 -4000 20000 8000 -4000 8000{\\p0}';
}

/** Countdown sizes: the clock's height on the 720-high canvas (readable at 720p). */
const COUNTDOWN_FS = Object.freeze({ small: 30, medium: 42, large: 60 });
const COUNTDOWN_AN = Object.freeze({ 'top-left': 7, 'top-right': 9, 'bottom-left': 1, 'bottom-right': 3 });

/**
 * The countdown to the end and a warning ("10 minutes left"), in a corner
 * (player-lib/stage-countdown.js says what). Only times and fixed words,
 * never a name. White, bold, with a dark outline and shadow so it reads on
 * any picture. The corner's own margins place it (no \pos), so it needs no
 * canvas width; the clock sits in the corner and the warning, a little
 * smaller, next to it toward the middle.
 * @param {{clock?: string|null, warning?: string|null, corner?: string, size?: string}} o
 * @returns {string} ASS events, or '' for nothing
 */
function countdownEvent({ clock = null, warning = null, corner = 'top-right', size = 'medium' } = {}) {
  const c = clock ? assEscape(clock) : '';
  const w = warning ? assEscape(warning) : '';
  if (!c && !w) return '';
  const fs = COUNTDOWN_FS[size] || COUNTDOWN_FS.medium;
  const an = COUNTDOWN_AN[corner] || COUNTDOWN_AN['top-right'];
  const wfs = Math.round(fs * 0.72);
  const top = an === 7 || an === 9;
  const lines = [];
  if (c) lines.push(`{\\fs${fs}}${c}`);
  if (w) lines.push(`{\\fs${c ? wfs : fs}}${w}`);
  if (!top) lines.reverse();
  return `{\\an${an}\\fn${FONT}\\b1\\q2\\bord${(fs / 16).toFixed(1)}\\shad${(fs / 30).toFixed(1)}\\1c&HFFFFFF&\\3c&H000000&\\4c&H000000&\\1a&H00&\\3a&H20&\\4a&H70&}`
    + lines.join('\\N');
}

/** The named-arguments osd-overlay command for mpv's IPC. */
function overlayCommand(id, data, z = 0) {
  if (!data) return { name: 'osd-overlay', id, format: 'none', data: '' };
  return { name: 'osd-overlay', id, format: 'ass-events', data, res_x: 0, res_y: RES_Y, z };
}

/** The alpha steps of a fade: in is 1/n .. 1, out is (n-1)/n .. 0. */
function fadeSteps(dir, steps = FADE_STEPS) {
  const out = [];
  for (let i = 1; i <= steps; i++) out.push(dir === 'in' ? i / steps : (steps - i) / steps);
  return out;
}

module.exports = {
  NAME_ID, BLACK_ID, COUNTDOWN_ID, COUNTDOWN_Z, PROGRESS_ID, PROGRESS_Z, LINE_PX, LINE_RGB, RES_Y, FADE_STEPS, FADE_MS, COUNTDOWN_FS,
  assEscape, truncate, alpha, nameEvent, blackEvent, countdownEvent, overlayCommand, fadeSteps,
  plainText, nameBudget, lineEvent, canvasWidth, assColor,
};
