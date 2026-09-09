// =========================================================================
// PLAYER STREAM - route playback through /api/playback (native or HLS remux)
//
// The player used to point <video src> straight at the file and hope. Now the
// server decides: the page tells it which codecs THIS browser can actually
// decode, and gets back either the original file (native, Range seeking, no
// change from before) or an HLS playlist that FFmpeg fills in on demand.
//
// Everything downstream of the media element is untouched on purpose. The
// playlist is a VOD playlist, so video.duration is right from the first frame
// and scrubbing, the beat bar, the bar-end times, resume position and A/B loop
// all keep working exactly as they do on a native file.
// =========================================================================

/* ── What can this browser decode? ────────────────────────────────────────── */

// Fixed probe list, in the order the server expects. The tags are the contract
// between this file and player-lib/playback-decide.js — do not rename them.
const CODEC_PROBES = [
  ['h264', 'video/mp4; codecs="avc1.640028"'],
  ['h264hi10', 'video/mp4; codecs="avc1.6E0028"'],
  ['hevc', 'video/mp4; codecs="hvc1.1.6.L120.B0"'],
  ['hevc10', 'video/mp4; codecs="hvc1.2.4.L120.B0"'],
  ['av1', 'video/mp4; codecs="av01.0.08M.08"'],
  ['vp9', 'video/webm; codecs="vp09.00.10.08"'],
  ['vp8', 'video/webm; codecs="vp8"'],
  ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
  ['mp3', 'audio/mpeg'],
  ['opus', 'audio/webm; codecs="opus"'],
  ['flac', 'audio/mp4; codecs="flac"'],
  ['ac3', 'audio/mp4; codecs="ac-3"'],
  ['eac3', 'audio/mp4; codecs="ec-3"'],
];

const CAPS_KEY = 'vaultCodecCaps';
let _capsCache = null;

/**
 * Comma-separated capability string for the playback request. Computed once
 * per browser session: the answers cannot change while the tab is open, and
 * MediaSource.isTypeSupported is slow enough to be worth not repeating.
 */
function codecCaps() {
  if (_capsCache !== null) return _capsCache;
  try {
    const stored = sessionStorage.getItem(CAPS_KEY);
    if (stored) { _capsCache = stored; return _capsCache; }
  } catch { /* private mode — just recompute */ }

  const probe = document.createElement('video');
  const tags = [];
  for (const [tag, type] of CODEC_PROBES) {
    let ok = false;
    try {
      if (window.MediaSource && MediaSource.isTypeSupported) ok = MediaSource.isTypeSupported(type);
      if (!ok) ok = probe.canPlayType(type) === 'probably';
    } catch { ok = false; }
    if (ok) tags.push(tag);
  }
  _capsCache = tags.join(',');
  try { sessionStorage.setItem(CAPS_KEY, _capsCache); } catch {}
  return _capsCache;
}

/* ── The hls.js instance, one at a time ───────────────────────────────────── */

let _hls = null;

/** The media id currently being streamed, for the close beacon below. */
let _streamId = null;

/**
 * A token for THIS player instance, sent as `c` on the playlist and therefore
 * on every segment URI inside it.
 *
 * The server keeps one retention window per client. Without a token it can only
 * tell clients apart by address and user agent, which makes two tabs of the
 * same browser look like one seeking player: the second tab's seek drags the
 * first tab's window off the segments it is about to need, and its requests
 * time out. Minted per player instance, so opening the same file twice is two
 * clients, and it is also what stops one tab's close beacon ending the other
 * tab's stream.
 */
let _clientToken = null;

function _newClientToken() {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  } catch {}
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Tell the server the player is done with this stream. Segments are only ever
 * held in memory while a file plays, so this is what frees them (and stops
 * FFmpeg) the moment someone closes the player instead of a minute later, when
 * the server's idle timeout would have done it anyway. Best effort: a beacon
 * that never arrives costs nothing but that minute.
 */
function _closeStream(id, token) {
  if (!id) return;
  const url = `/stream/${id}/close${token ? `?c=${encodeURIComponent(token)}` : ''}`;
  try {
    if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([], { type: 'text/plain' }));
    else fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
  } catch {}
}

/** Tear down the live hls.js instance, if any. Safe to call at any time. */
function destroyStream() {
  const id = _streamId;
  const token = _clientToken;
  _streamId = null;
  _clientToken = null;
  if (_hls) {
    try { _hls.destroy(); } catch {}
    _hls = null;
  }
  _closeStream(id, token);
}

// A closed tab never reaches destroyStream(); the beacon is the only thing that
// can still be sent from here.
try {
  window.addEventListener('pagehide', () => { _closeStream(_streamId, _clientToken); });
} catch {}

function _supportsHls() {
  return typeof Hls !== 'undefined' && Hls.isSupported();
}

/* ── Attaching a source ───────────────────────────────────────────────────── */

/**
 * Re-state the session playback speed on this element.
 *
 * Loading a source resets playbackRate to defaultPlaybackRate, so every place
 * below that hands the element a new source has to say the speed again. The
 * helper in player-video.js sets defaultPlaybackRate too, which is what makes
 * the reset itself land on the right number.
 */
function _keepSessionSpeed(el) {
  if (typeof applySpeedTo === 'function') applySpeedTo(el);
}

/**
 * Point a media element at whatever the server says will play.
 *
 * @param {HTMLMediaElement} el      the <video> or <audio>
 * @param {number|null} mediaId      the library row id (null falls back to the URL)
 * @param {string} filepath          used only for the existing error path
 * @param {string} fallbackUrl       the by-path URL used before this existed
 * @param {{autoplay?: boolean}} opts
 */
async function attachPlaybackSource(el, mediaId, filepath, fallbackUrl, opts = {}) {
  destroyStream();
  _keepSessionSpeed(el);

  // No id (a mix, a stub, anything not in the library): behave exactly as the
  // player did before this feature existed.
  if (!mediaId) {
    el.src = fallbackUrl;
    _keepSessionSpeed(el);
    if (opts.autoplay !== false) el.play().catch(() => {});
    return { mode: 'native' };
  }

  let info = null;
  try {
    const res = await fetch(`/api/playback/${mediaId}?caps=${encodeURIComponent(codecCaps())}`);
    if (res.ok) info = await res.json();
  } catch { /* server unreachable — fall through to the old behaviour */ }

  // The player may have moved on while the request was in flight.
  if (!el.isConnected) return { mode: 'stale' };

  if (!info) {
    el.src = fallbackUrl;
    _keepSessionSpeed(el);
    if (opts.autoplay !== false) el.play().catch(() => {});
    return { mode: 'native' };
  }

  if (info.mode === 'unsupported') {
    _reportUnplayable(el, mediaId, filepath, info);
    return { mode: 'unsupported', info };
  }

  if (info.mode === 'remux') {
    return _attachRemux(el, mediaId, filepath, info, opts);
  }

  // Native. Remember the server's offer of a remux retry so a media error can
  // take it up once before giving up (rule 4.2.4 is deliberately optimistic).
  el.dataset.playbackFallback = info.fallback || '';
  el.dataset.playbackMediaId = String(mediaId);
  el.src = info.url || fallbackUrl;
  _keepSessionSpeed(el);
  if (opts.autoplay !== false) el.play().catch(() => {});
  return { mode: 'native', info };
}

function _attachRemux(el, mediaId, filepath, info, opts) {
  el.dataset.playbackFallback = '';
  el.dataset.playbackMediaId = String(mediaId);

  const token = _newClientToken();
  const url = `${info.url}?c=${encodeURIComponent(token)}`;

  // Safari plays HLS natively and does it better than MSE would.
  if (!_supportsHls()) {
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      _streamId = mediaId;                       // native HLS: the beacon still applies
      _clientToken = token;
      el.src = url;
      _keepSessionSpeed(el);
      if (opts.autoplay !== false) el.play().catch(() => {});
      return { mode: 'remux', info };
    }
    _reportUnplayable(el, mediaId, filepath, {
      reason: 'This browser cannot play the converted stream Vault produced.',
      hint: null,
    });
    return { mode: 'unsupported', info };
  }

  const hls = new Hls({ maxBufferLength: 60, enableWorker: true });
  _hls = hls;
  _streamId = mediaId;
  _clientToken = token;
  hls.on(Hls.Events.ERROR, (evt, data) => {
    if (!data || !data.fatal) return;
    if (_hls !== hls) return;
    destroyStream();
    if (typeof handleMediaError === 'function') handleMediaError(filepath);
  });
  // MSE attach runs the media load algorithm, which resets playbackRate — so
  // the session speed has to be re-stated on the far side of it, not just once
  // before the element ever had a source.
  hls.on(Hls.Events.MEDIA_ATTACHED, () => _keepSessionSpeed(el));
  hls.on(Hls.Events.MANIFEST_PARSED, () => _keepSessionSpeed(el));
  hls.loadSource(url);
  hls.attachMedia(el);
  if (opts.autoplay !== false) {
    hls.on(Hls.Events.MANIFEST_PARSED, () => { el.play().catch(() => {}); });
  }
  return { mode: 'remux', info };
}

/**
 * A file the server says nothing can play. There is no media error to catch
 * here (we never gave the element a source), so mark the row the way the
 * capture-phase error listener would and then hand off to the player's normal
 * failure path — which closes the player, or skips the file in streaming mode.
 */
function _reportUnplayable(el, mediaId, filepath, info) {
  destroyStream();
  try { el.removeAttribute('src'); el.load(); } catch {}

  const media = typeof getMediaById === 'function' ? getMediaById(mediaId) : null;
  if (media && !media.playback_failed) {
    media.playback_failed = 1;
    if (typeof postFlags === 'function') postFlags(media, { playback_failed: 1 });
  }

  const msg = info.hint ? `${info.reason}\n${info.hint}` : info.reason;
  if (typeof handleMediaError === 'function') handleMediaError(filepath, msg);
  else if (typeof showToast === 'function') showToast(msg);
}

/**
 * The native path failed and the server said a remux was available. Retry
 * through HLS once; returns true when a retry was started.
 */
function retryThroughRemux(el, filepath) {
  if (!el || el.dataset.playbackFallback !== 'remux') return false;
  const mediaId = Number(el.dataset.playbackMediaId);
  if (!mediaId) return false;
  el.dataset.playbackFallback = '';                 // one attempt only
  const wasAt = el.currentTime || 0;
  _attachRemux(el, mediaId, filepath, { url: `/stream/${mediaId}/index.m3u8` }, { autoplay: true });
  if (wasAt > 0 && _hls) {
    _hls.on(Hls.Events.MANIFEST_PARSED, () => { try { el.currentTime = wasAt; } catch {} });
  }
  return true;
}

// A file that plays after all is un-marked by the existing capture-phase
// `canplay` listener in selection.js, which fires for a remuxed stream exactly
// as it does for a native one — so nothing extra is needed here.
