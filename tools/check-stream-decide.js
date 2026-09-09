/**
 * Runnable check for the playback decision matrix — every row of the spec's
 * test table, with and without client capabilities.
 *
 *   node tools/check-stream-decide.js
 *
 * No database, no server, no ffmpeg: decide() is a pure function and this is
 * the cheapest place to notice a regression in it.
 */

const { decide, DEFAULT_CAPS } = require('../lib/stream/decide');

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';
const MKV = 'matroska,webm';

/** A browser with everything, as reported by MediaSource.isTypeSupported. */
const FULL = ['h264', 'h264hi10', 'hevc', 'hevc10', 'av1', 'vp9', 'vp8', 'aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3'];

const cases = [
  // [name, row, caps, expected mode, extra assertions]
  ['rx-h264-aac.mp4 (default caps)',
    { video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv420p', codec_profile: 'High', container: MP4 },
    null, 'native'],
  ['rx-h264-aac.mkv (default caps)',
    { video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv420p', codec_profile: 'High', container: MKV },
    null, 'native', d => d.fallback === 'remux'],
  ['rx-h264-ac3.mkv (default caps)',
    { video_codec: 'h264', audio_codec: 'ac3', pix_fmt: 'yuv420p', codec_profile: 'High', container: MKV },
    null, 'remux', d => d.audioPlan === 'aac' && d.videoPlan === 'copy'],
  ['rx-h264-ac3.mkv (browser claims ac3)',
    { video_codec: 'h264', audio_codec: 'ac3', pix_fmt: 'yuv420p', codec_profile: 'High', container: MKV },
    FULL, 'remux', d => d.audioPlan === 'aac'],
  ['rx-h264-mp3.avi (default caps)',
    { video_codec: 'h264', audio_codec: 'mp3', pix_fmt: 'yuv420p', codec_profile: 'High', container: 'avi' },
    null, 'remux', d => d.audioPlan === 'copy'],
  ['rx-h264-aac.ts (default caps)',
    { video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv420p', codec_profile: 'High', container: 'mpegts' },
    null, 'remux', d => d.audioPlan === 'copy'],
  ['rx-hevc-aac.mp4 (default caps: no hevc)',
    { video_codec: 'hevc', audio_codec: 'aac', pix_fmt: 'yuv420p', codec_profile: 'Main', container: MP4 },
    null, 'unsupported', d => /HEVC decoder/.test(d.hint || '')],
  ['rx-hevc-aac.mp4 (caps has hevc)',
    { video_codec: 'hevc', audio_codec: 'aac', pix_fmt: 'yuv420p', codec_profile: 'Main', container: MP4 },
    FULL, 'native'],
  ['hevc in mkv (caps has hevc)',
    { video_codec: 'hevc', audio_codec: 'aac', pix_fmt: 'yuv420p', codec_profile: 'Main', container: MKV },
    FULL, 'native', d => d.fallback === 'remux'],
  ['hevc in avi (caps has hevc)',
    { video_codec: 'hevc', audio_codec: 'ac3', pix_fmt: 'yuv420p', codec_profile: 'Main', container: 'avi' },
    FULL, 'remux', d => d.audioPlan === 'aac'],
  ['rx-xvid-mp3.avi (default caps)',
    { video_codec: 'mpeg4', audio_codec: 'mp3', pix_fmt: 'yuv420p', codec_profile: 'Simple Profile', container: 'avi' },
    null, 'unsupported', d => /MPEG-4 Part 2/.test(d.reason)],
  ['rx-xvid-mp3.avi (full caps: still no decoder)',
    { video_codec: 'mpeg4', audio_codec: 'mp3', pix_fmt: 'yuv420p', codec_profile: 'Simple Profile', container: 'avi' },
    FULL, 'unsupported'],
  ['rx-h264hi10.mkv (default caps)',
    { video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv420p10le', codec_profile: 'High 10', container: MKV },
    null, 'unsupported', d => /10-bit/.test(d.hint || '')],
  ['rx-h264hi10.mkv (caps has h264hi10)',
    { video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv420p10le', codec_profile: 'High 10', container: MKV },
    FULL, 'native', d => d.fallback === 'remux'],
  ['rx-audio-ac3.mka (default caps)',
    { video_codec: null, audio_codec: 'ac3', container: MKV },
    null, 'remux', d => d.audioPlan === 'aac'],
  ['plain mp3 (default caps)',
    { video_codec: null, audio_codec: 'mp3', container: 'mp3' },
    null, 'native'],
  ['flac (default caps)',
    { video_codec: null, audio_codec: 'flac', container: 'flac' },
    null, 'native'],
  ['wav (default caps)',
    { video_codec: null, audio_codec: 'pcm_s16le', container: 'wav' },
    null, 'native'],

  // Cases the table implies rather than lists.
  ['vp9 in webm', { video_codec: 'vp9', audio_codec: 'opus', pix_fmt: 'yuv420p', container: MKV }, null, 'native'],
  ['vp9 in avi cannot be remuxed into TS',
    { video_codec: 'vp9', audio_codec: 'mp3', pix_fmt: 'yuv420p', container: 'avi' },
    null, 'unsupported', d => /cannot be repackaged/.test(d.reason)],
  ['mpeg2 in vob', { video_codec: 'mpeg2video', audio_codec: 'ac3', pix_fmt: 'yuv420p', container: 'mpeg' },
    null, 'unsupported', d => /MPEG-2/.test(d.reason)],
  ['wmv3 in asf', { video_codec: 'wmv3', audio_codec: 'wmav2', pix_fmt: 'yuv420p', container: 'asf' },
    null, 'unsupported', d => /WMV 9/.test(d.reason)],
  ['h264 4:2:2 counts as hi10-class',
    { video_codec: 'h264', audio_codec: 'aac', pix_fmt: 'yuv422p', codec_profile: 'High 4:2:2', container: MP4 },
    null, 'unsupported'],
  ['mp4 with flac audio and default caps',
    { video_codec: 'h264', audio_codec: 'flac', pix_fmt: 'yuv420p', container: MP4 },
    null, 'native'],
  ['mp4 with ac3 audio needs a remux',
    { video_codec: 'h264', audio_codec: 'ac3', pix_fmt: 'yuv420p', container: MP4 },
    null, 'remux', d => d.audioPlan === 'aac'],
  ['no streams at all', { video_codec: null, audio_codec: null, container: 'mp4' }, null, 'unsupported'],
];

let failed = 0;
for (const [name, row, caps, expected, extra] of cases) {
  const d = decide(row, caps ? new Set(caps) : new Set(DEFAULT_CAPS));
  const okMode = d.mode === expected;
  const okExtra = !extra || extra(d);
  if (okMode && okExtra) {
    console.log(`  ok    ${name} -> ${d.mode}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}: expected ${expected}${okMode ? ' (extra assertion failed)' : ''}, got ${d.mode}`);
    console.log(`        ${JSON.stringify(d)}`);
  }
}

// Every unsupported answer must carry a sentence a human can act on.
for (const [name, row, caps] of cases) {
  const d = decide(row, caps ? new Set(caps) : new Set(DEFAULT_CAPS));
  if (d.mode === 'unsupported' && !d.reason) {
    failed++;
    console.log(`  FAIL  ${name}: unsupported with no reason`);
  }
}

console.log('');
console.log(failed ? `${failed} check(s) failed` : `all ${cases.length} checks passed`);
process.exit(failed ? 1 : 0);
