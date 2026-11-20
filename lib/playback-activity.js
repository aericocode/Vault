/**
 * Is anything playing? The signal AI scan's Auto mode waits on
 * (lib/ai-scan-mode.js, lib/import-queue.js).
 *
 * Two kinds of source report here:
 *
 *   tabs   every viewer page (this PC or another device) sends a light
 *          heartbeat while its player, mini player, picture-in-picture or an
 *          unmuted Wall tile plays or sits paused: POST /api/playback/beat with
 *          the background header, so it never counts as the user being present
 *          for the autolock. A tab that stops beating (closed, asleep, offline)
 *          stops counting after STALE_MS.
 *   stage  Stage's own reports (lib/stage/hub.js), server side, so they never go
 *          stale: Stage says when it plays, pauses, stops and closes.
 *
 * Hover previews and thumbnails never report: they are pictures, or muted
 * tiles the client leaves out (player-lib/playback-beat.js).
 *
 * Paused counts for PAUSE_GRACE_MS from the moment it paused, then stops
 * counting, so a paused player left open overnight never holds scanning.
 * Listeners hear each flip of isPlaying(); a timer flips it when a pause grace
 * or a stale tab runs out, with no report needed.
 */

const STALE_MS = 45_000;          // a tab that has not beaten for this long has gone
const PAUSE_GRACE_MS = 90_000;    // paused this long no longer counts as playing
const MAX_SOURCES = 64;           // tabs are few; a flood of made-up ids cannot grow this

const _timings = { staleMs: STALE_MS, pauseGraceMs: PAUSE_GRACE_MS };
let _now = () => Date.now();

/** id -> { state: 'playing'|'paused', at, pausedSince, stale: boolean } */
const _sources = new Map();
const _listeners = [];
let _last = false;
let _timer = null;

/**
 * One report. `state` is 'playing', 'paused' or 'idle' (idle forgets the
 * source). `stale` false for a server-side source that never goes quiet.
 */
function report(id, state, { stale = true } = {}) {
  if (typeof id !== 'string' || !id) return isPlaying();
  const now = _now();
  if (state === 'idle') {
    _sources.delete(id);
  } else if (state === 'playing' || state === 'paused') {
    const prev = _sources.get(id);
    if (!prev && _sources.size >= MAX_SOURCES) _dropOldest();
    const pausedSince = state === 'paused'
      ? (prev && prev.state === 'paused' ? prev.pausedSince : now)
      : null;
    _sources.set(id, { state, at: now, pausedSince, stale });
  }
  return _evaluate();
}

function _dropOldest() {
  let oldest = null;
  for (const [k, v] of _sources) if (!oldest || v.at < _sources.get(oldest).at) oldest = k;
  if (oldest) _sources.delete(oldest);
}

function _counts(src, now) {
  if (src.stale && now - src.at >= _timings.staleMs) return false;
  if (src.state === 'playing') return true;
  return now - src.pausedSince < _timings.pauseGraceMs;
}

/** True while anything plays, or paused within the grace window. */
function isPlaying() {
  const now = _now();
  for (const src of _sources.values()) if (_counts(src, now)) return true;
  return false;
}

/** Work out the answer, tell listeners on a flip, and arm the timer for the next expiry. */
function _evaluate() {
  const now = _now();
  let playing = false;
  let next = Infinity;
  for (const [k, src] of _sources) {
    if (src.stale && now - src.at >= _timings.staleMs) { _sources.delete(k); continue; }
    const counts = _counts(src, now);
    if (counts) playing = true;
    // When could this source stop counting by itself?
    if (src.stale) next = Math.min(next, src.at + _timings.staleMs);
    if (src.state === 'paused' && counts) next = Math.min(next, src.pausedSince + _timings.pauseGraceMs);
  }
  if (_timer) { clearTimeout(_timer); _timer = null; }
  if (next !== Infinity) {
    _timer = setTimeout(() => { _timer = null; _evaluate(); }, Math.max(0, next - now) + 20);
    if (typeof _timer.unref === 'function') _timer.unref();
  }
  if (playing !== _last) {
    _last = playing;
    for (const fn of _listeners) {
      try { fn(playing); } catch (err) { console.warn(`[Playback] listener failed: ${err.message}`); }
    }
  }
  return playing;
}

/** fn(playing) on every flip. */
function onChange(fn) {
  if (typeof fn === 'function') _listeners.push(fn);
}

/** Test seams. */
function _reset() {
  _sources.clear();
  _last = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}
function _setClock(fn) { _now = fn || (() => Date.now()); }
function _setTimings(t) { Object.assign(_timings, t); }

module.exports = {
  report, isPlaying, onChange,
  STALE_MS, PAUSE_GRACE_MS,
  _reset, _setClock, _setTimings, _evaluate,
};
