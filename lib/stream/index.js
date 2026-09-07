/**
 * Keyframe index + VOD playlist for one media file.
 *
 * A remux plays through HLS, and HLS wants the whole timeline up front so the
 * scrub bar, the beat bar and A/B loops behave exactly like a native file. That
 * means we must know where every segment starts BEFORE FFmpeg has produced any
 * of them — hence a one-time keyframe scan per file, cached in `stream_index`.
 *
 * Segment boundaries are keyframes, because a copy-mode remux can only cut on
 * one. Walk the keyframes and open a new segment at the first keyframe that is
 * at least TARGET seconds past the current segment start; the last segment runs
 * to the end of the file.
 *
 * Timeline convention (the one thing to get right):
 *   - `container_start` is the first video packet timestamp of the SOURCE. TS
 *     captures routinely start at something like 1401.4 rather than 0.
 *   - keyframes/segments are stored MEDIA-RELATIVE, i.e. already with
 *     container_start subtracted, so the playlist timeline always starts at 0
 *     and matches `video.currentTime`.
 *   - the segments FFmpeg writes keep their original absolute timestamps
 *     (`-copyts`). hls.js works out the constant offset between the two from
 *     the first fragment it parses and applies it to the rest, so the two
 *     timelines never have to be reconciled by us. See lib/stream/session.js.
 */

const proc = require('../proc');

/** Bump when the index layout or the boundary rule changes (forces a rebuild). */
const INDEX_VERSION = 1;

/** Target segment length in seconds. Boundaries land on the next keyframe. */
const TARGET = 4;

/** Audio-only remuxes have no keyframes: fixed boundaries every 4 s. */
const AUDIO_SEGMENT = 4;

const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Read every video packet's timestamp + flags and keep the keyframes.
 *
 * AVI carries no PTS at all (ffprobe prints N/A), so dts_time is the fallback.
 * Both are wall-clock seconds already, which is why this uses csv rather than
 * counting frames.
 *
 * @returns {Promise<{keyframes:number[], containerStart:number}>} absolute times
 */
async function scanKeyframes(filepath) {
  const { stdout } = await proc.run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,dts_time,flags',
    '-of', 'csv=p=0', filepath,
  ], { maxBuffer: 256 * 1024 * 1024, timeout: 600000 });

  const keyframes = [];
  let containerStart = null;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const pts = parseFloat(parts[0]);
    const dts = parseFloat(parts[1]);
    const t = Number.isFinite(pts) ? pts : dts;
    if (!Number.isFinite(t)) continue;
    if (containerStart === null) containerStart = t;
    if (parts[2].includes('K')) keyframes.push(t);
  }
  keyframes.sort((a, b) => a - b);
  return { keyframes, containerStart: containerStart === null ? 0 : containerStart };
}

/**
 * Walk keyframes into segment start times (media-relative, first entry 0).
 * @param {number[]} rel  keyframe times with container_start already removed
 * @param {number} duration
 */
function boundariesFromKeyframes(rel, duration) {
  const starts = [0];
  let cur = 0;
  for (const k of rel) {
    if (k <= 0) continue;
    if (k >= duration - 0.2) break;          // too close to the end to be its own segment
    if (k - cur >= TARGET) { starts.push(r3(k)); cur = k; }
  }
  return starts;
}

/** Fixed boundaries for an audio-only remux (no keyframes to land on). */
function boundariesForAudio(duration) {
  const starts = [];
  for (let t = 0; t < duration - 0.2; t += AUDIO_SEGMENT) starts.push(r3(t));
  return starts.length ? starts : [0];
}

/**
 * Build the index for one file.
 * @param {string} filepath
 * @param {number} duration  from the media row (ffprobe format duration)
 * @param {boolean} audioOnly
 * @returns {Promise<{keyframes:number[], segments:number[], containerStart:number,
 *                    duration:number, indexVersion:number}>}
 */
async function build(filepath, duration, audioOnly = false) {
  if (audioOnly) {
    const d = duration > 0 ? duration : 0;
    return {
      keyframes: [], segments: boundariesForAudio(d), containerStart: 0,
      duration: r3(d), indexVersion: INDEX_VERSION,
    };
  }

  const { keyframes, containerStart } = await scanKeyframes(filepath);
  if (!keyframes.length) {
    const e = new Error('no keyframes found in the video stream');
    e.code = 'STREAM_NO_KEYFRAMES';
    throw e;
  }
  // The real duration of the packet timeline beats the container's claim when
  // they disagree; a playlist longer than the media makes hls.js stall at the
  // end waiting for a segment that never comes.
  const last = keyframes[keyframes.length - 1] - containerStart;
  let d = duration > 0 ? duration : 0;
  if (!d || d < last) d = last + TARGET;

  const rel = keyframes.map(k => r3(k - containerStart));
  return {
    keyframes: rel,
    segments: boundariesFromKeyframes(rel, d),
    containerStart: r3(containerStart),
    duration: r3(d),
    indexVersion: INDEX_VERSION,
  };
}

/** Per-segment durations, media-relative. */
function segmentDurations(segments, duration) {
  return segments.map((s, i) => r3((i + 1 < segments.length ? segments[i + 1] : duration) - s));
}

/**
 * Render the VOD playlist. Segment URIs carry the index version so a rebuilt
 * index can never be served stale segments out of a browser cache.
 */
function playlist(idx, client) {
  // The client token rides on every segment URI because hls.js resolves them
  // against the playlist PATH, which drops the playlist's own query string.
  const tag = client ? `&c=${encodeURIComponent(client)}` : '';
  const durs = segmentDurations(idx.segments, idx.duration);
  const target = Math.max(1, Math.ceil(Math.max(...durs)));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (let i = 0; i < durs.length; i++) {
    lines.push(`#EXTINF:${durs[i].toFixed(3)},`);
    lines.push(`seg/${i}.ts?v=${idx.indexVersion}${tag}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

module.exports = {
  INDEX_VERSION, TARGET, build, playlist, segmentDurations,
  scanKeyframes, boundariesFromKeyframes, boundariesForAudio,
};
