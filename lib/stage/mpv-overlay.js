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
 *          stage-countdown.js decides what shows), under the black sheet.
 *
 * The canvas is 720 high and as wide as the window's shape (res_x 0), so
 * nothing is stretched. The name is text from the library: it is made inert
 * (no override blocks, no \N, no line breaks) before it goes in.
 */

const NAME_ID = 1;
const BLACK_ID = 2;
const COUNTDOWN_ID = 3;
const COUNTDOWN_Z = 5;             // over the name (0), under Hold's black sheet (10)
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
 * @param {string} text  already cut to the name (StageRules.nameText)
 * @param {number} fade  0..1
 */
function nameEvent(text, fade = 1) {
  const t = truncate(assEscape(text));
  if (!t) return '';
  const y = Math.round(RES_Y * (1 - 0.045));
  return `{\\an1\\pos(41,${y})\\fn${FONT}\\fs31\\b1\\q2\\bord1.6\\shad1.2\\1c&HFFFFFF&\\3c&H000000&\\4c&H000000&`
    + `\\1a${alpha(0, fade)}\\3a${alpha(0x50, fade)}\\4a${alpha(0x60, fade)}}${t}`;
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
  NAME_ID, BLACK_ID, COUNTDOWN_ID, COUNTDOWN_Z, RES_Y, FADE_STEPS, FADE_MS, COUNTDOWN_FS,
  assEscape, truncate, alpha, nameEvent, blackEvent, countdownEvent, overlayCommand, fadeSteps,
};
