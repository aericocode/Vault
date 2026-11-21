/**
 * What the running mpv can decode, for judging files before they reach it
 * (player-lib/playback-decide.js decideMpv).
 *
 * Asked once per mpv start, over its IPC, right after it answers
 * (stage-routes.js launch): the decoder-list property, every libavcodec
 * decoder this mpv build has, by codec name (h264, hevc, mpeg2video, wmv3,
 * ac3 ...: the same names ffprobe writes into the library's codec columns).
 * Hardware wrappers (h264_cuvid) carry the codec they decode, so each codec
 * is listed once.
 *
 * When the list cannot be read (an mpv that does not answer it, a timeout),
 * the answer is null and nothing is ruled out up front: every file is handed
 * to mpv, and one it cannot play is skipped by its own end-file error
 * (engine.js), as before.
 */

// Codec names are lower-case letters, digits, _ . and - (acelp.kelvin, pcm_s16le).
const CODEC_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const MAX_CODECS = 2000;
const READ_TIMEOUT_MS = 3000;

/**
 * The codec names in an mpv decoder-list answer, sorted and unique, or null
 * for anything that is not one.
 * @param {unknown} list
 * @returns {string[]|null}
 */
function codecsFromDecoderList(list) {
  if (!Array.isArray(list)) return null;
  const out = new Set();
  for (const d of list) {
    const c = d && typeof d.codec === 'string' ? d.codec.toLowerCase() : '';
    if (CODEC_RE.test(c)) out.add(c);
    if (out.size >= MAX_CODECS) break;
  }
  return out.size ? [...out].sort() : null;
}

/**
 * Ask mpv for its decoders. Never throws.
 * @param {{command: Function}} host   mpv-host.js (or a fake): command(['get_property', name], opts)
 * @returns {Promise<{codecs: string[]}|null>}
 */
async function readMpvCaps(host, { timeoutMs = READ_TIMEOUT_MS } = {}) {
  if (!host || typeof host.command !== 'function') return null;
  try {
    const codecs = codecsFromDecoderList(await host.command(['get_property', 'decoder-list'], { timeoutMs }));
    return codecs ? { codecs } : null;
  } catch {
    return null;
  }
}

module.exports = { readMpvCaps, codecsFromDecoderList };
