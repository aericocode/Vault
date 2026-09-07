/**
 * Playback decision matrix — a PURE function, no I/O.
 *
 * Given a media row (the codec columns ffprobe filled in) and the set of codec
 * tags the CLIENT says it can decode, decide how the file should be played:
 *
 *   native      — serve the original file to <video src>, Range seeking
 *   remux       — repackage into MPEG-TS HLS segments with FFmpeg (-c copy)
 *   unsupported — nothing this pass can do (the transcode tier is a later branch)
 *
 * Kept out of the routes so every row of the spec's table can be checked
 * without a server or a database — see tools/check-stream-decide.js.
 */

/** Client caps assumed when the request carries none (CLI, curl, tests). */
const DEFAULT_CAPS = ['h264', 'vp8', 'vp9', 'av1', 'aac', 'mp3', 'opus', 'flac'];

/** Audio codecs MPEG-TS can carry as a straight copy. */
const TS_AUDIO_COPY = new Set(['aac', 'mp3']);

/** Video codecs MPEG-TS can carry as a straight copy. */
const TS_VIDEO_COPY = new Set(['h264', 'hevc']);

/** Audio a browser plays inside a native container. */
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis']);

/** Containers a browser opens directly (tokens of ffprobe format_name). */
const NATIVE_CONTAINERS = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2', 'webm']);

/** Containers Chrome/Edge open optimistically (rule 4.2.4). */
const OPTIMISTIC_CONTAINERS = new Set(['matroska', 'matroska,webm']);

/** Audio-only codecs a browser plays as-is. */
const NATIVE_AUDIO_ONLY = new Set([
  'mp3', 'flac', 'aac', 'opus', 'vorbis',
  'pcm_s16le', 'pcm_u8', 'pcm_s24le', 'pcm_f32le',
]);

/** Readable names for the codecs we refuse, used in the reason sentence. */
const CODEC_NAMES = {
  mpeg4: 'MPEG-4 Part 2 (Xvid/DivX)',
  msmpeg4v3: 'MS MPEG-4 v3 (DivX 3)',
  msmpeg4v2: 'MS MPEG-4 v2',
  msmpeg4v1: 'MS MPEG-4 v1',
  mpeg2video: 'MPEG-2',
  mpeg1video: 'MPEG-1',
  wmv1: 'WMV 7', wmv2: 'WMV 8', wmv3: 'WMV 9', vc1: 'VC-1',
  rv40: 'RealVideo', rv30: 'RealVideo', rv20: 'RealVideo',
  theora: 'Theora', mjpeg: 'Motion JPEG', prores: 'ProRes',
  dvvideo: 'DV', flv1: 'Sorenson Spark', svq3: 'Sorenson 3',
  vp6: 'VP6', vp6f: 'VP6', h263: 'H.263', cinepak: 'Cinepak',
  h264: 'H.264', hevc: 'HEVC', av1: 'AV1', vp8: 'VP8', vp9: 'VP9',
};

const HEVC_HINT =
  'Chrome and Edge on Windows can play HEVC after installing the free HEVC Video Extensions from the Microsoft Store.';
const TENBIT_HINT =
  '10-bit video needs a converted copy. That is planned for a later version.';

/** First token of ffprobe format_name ("matroska,webm" is kept whole). */
function containerToken(container) {
  const c = String(container || '').toLowerCase().trim();
  if (OPTIMISTIC_CONTAINERS.has(c)) return c;
  return c.split(',')[0] || '';
}

function is10bit(pixFmt, profile) {
  const p = String(pixFmt || '').toLowerCase();
  if (/1[02](le|be)|p010|p210/.test(p)) return true;
  return /\b(10|12)\b/.test(String(profile || ''));
}

function isHighChroma(pixFmt) {
  return /yuvj?42[24]|yuvj?444|gbr/.test(String(pixFmt || '').toLowerCase());
}

/**
 * Map codec + pixel format + profile onto one of the fixed capability tags the
 * client probes for. null means "no browser decodes this, ever".
 */
function videoTag(codec, pixFmt, profile) {
  const c = String(codec || '').toLowerCase();
  const ten = is10bit(pixFmt, profile);
  if (c === 'h264') return (ten || isHighChroma(pixFmt)) ? 'h264hi10' : 'h264';
  if (c === 'hevc' || c === 'h265') return ten ? 'hevc10' : 'hevc';
  if (c === 'av1') return 'av1';
  if (c === 'vp9') return 'vp9';
  if (c === 'vp8') return 'vp8';
  return null;
}

function codecLabel(codec) {
  const c = String(codec || '').toLowerCase();
  return CODEC_NAMES[c] || (codec ? String(codec).toUpperCase() : 'unknown');
}

function plain(mode, reason = null, hint = null) {
  return { mode, reason, hint, audioPlan: null, videoPlan: null, fallback: null };
}

/**
 * @param {object} row   media row: video_codec, audio_codec, pix_fmt,
 *                       codec_profile, container
 * @param {Set<string>|string[]} caps  codec tags the client can decode
 * @returns {{mode:'native'|'remux'|'unsupported', reason:?string, hint:?string,
 *            audioPlan:?('copy'|'aac'), videoPlan:?'copy', fallback:?'remux'}}
 */
function decide(row, caps) {
  const capsSet = caps instanceof Set ? caps : new Set(caps || DEFAULT_CAPS);
  const vcodec = String(row.video_codec || '').toLowerCase();
  const acodec = String(row.audio_codec || '').toLowerCase();
  const container = containerToken(row.container);

  // 1. Audio only.
  if (!vcodec) {
    if (!acodec) {
      return plain('unsupported', 'This file has no video or audio stream that Vault can read.');
    }
    const playable = NATIVE_AUDIO_ONLY.has(acodec)
      && (acodec.startsWith('pcm') || acodec === 'vorbis' || capsSet.has(acodec));
    if (playable) return plain('native');
    return { mode: 'remux', reason: null, hint: null, audioPlan: 'aac', videoPlan: null, fallback: null };
  }

  // 2. Can this client decode the video at all?
  const tag = videoTag(vcodec, row.pix_fmt, row.codec_profile);
  if (!tag) {
    return plain('unsupported',
      `This file uses the ${codecLabel(vcodec)} video codec, which browsers cannot play.`,
      'Converting it to a browser-friendly copy is planned for a later version.');
  }
  if (!capsSet.has(tag)) {
    const tenBit = tag === 'hevc10' || tag === 'h264hi10';
    let hint = null;
    if (tag === 'hevc') hint = HEVC_HINT;
    else if (tag === 'hevc10') hint = `${TENBIT_HINT} ${HEVC_HINT}`;
    else if (tag === 'h264hi10') hint = TENBIT_HINT;
    else if (tag === 'av1') hint = 'AV1 needs a newer browser, or a converted copy.';
    else if (tag === 'vp9' || tag === 'vp8') hint = 'This browser is missing the VP8/VP9 decoder.';
    return plain('unsupported',
      `This browser cannot decode ${codecLabel(vcodec)}${tenBit ? ' 10-bit' : ''} video.`, hint);
  }

  // Vorbis only ever appears inside webm/mkv, where a VP8-capable browser has
  // the decoder; there is no separate cap tag for it.
  const audioOk = !acodec
    || (NATIVE_AUDIO.has(acodec) && (acodec === 'vorbis' ? capsSet.has('vp8') : capsSet.has(acodec)));

  // 3. Native container with native audio.
  if (NATIVE_CONTAINERS.has(container) && audioOk) return plain('native');

  // 4. Matroska with native video and audio — Chrome/Edge open it directly.
  //    Optimistic on purpose: the player retries through remux on a media
  //    error, so a browser that refuses still ends up playing the file.
  if (OPTIMISTIC_CONTAINERS.has(container) && audioOk) {
    return {
      mode: 'native', reason: null, hint: null, audioPlan: null, videoPlan: null,
      fallback: TS_VIDEO_COPY.has(vcodec) ? 'remux' : null,
    };
  }

  // 5. Everything else is a remux, as long as MPEG-TS can carry the video.
  if (!TS_VIDEO_COPY.has(vcodec)) {
    return plain('unsupported',
      `${codecLabel(vcodec)} inside ${container || 'this container'} cannot be repackaged yet.`,
      'Converting it to a browser-friendly copy is planned for a later version.');
  }
  return {
    mode: 'remux', reason: null, hint: null,
    audioPlan: acodec ? (TS_AUDIO_COPY.has(acodec) ? 'copy' : 'aac') : null,
    videoPlan: 'copy', fallback: null,
  };
}

module.exports = {
  decide, DEFAULT_CAPS, videoTag, containerToken, codecLabel, is10bit,
  TS_VIDEO_COPY, TS_AUDIO_COPY, NATIVE_CONTAINERS, OPTIMISTIC_CONTAINERS,
};
