const { execSync } = require('child_process');
const proc = require('./proc');

/**
 * Run ffprobe and return the parsed JSON (format + streams).
 * Shared by getInfo/getAudioInfo so we probe each file once.
 * @param {string} filepath
 * @returns {Promise<object|null>}
 */
async function probe(filepath) {
  try {
    const { stdout } = await proc.run('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filepath
    ]);
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`  Error probing media: ${err.message}`);
    return null;
  }
}

/**
 * Get media file information using ffprobe
 * @param {string} filepath - Path to media file
 * @returns {Promise<object|null>} Media info or null on error
 */
async function getInfo(filepath) {
  // Superset of what it used to return: the same one ffprobe call now also
  // yields the codec details the playback decision needs, so every caller that
  // already probes for duration can store them for free.
  const info = await getStreamInfo(filepath);
  if (!info) return null;
  return { ...info, codec: info.video_codec || 'unknown' };
}

/**
 * Everything the playback decision needs, from ONE ffprobe call.
 *
 * The first video stream that is NOT an attached picture is the real one:
 * cover art in an MP4/MKV shows up as a video stream (mjpeg/png) carrying
 * disposition.attached_pic = 1, and treating that as "the video" would mark
 * every tagged music file as an unplayable codec.
 *
 * @param {string} filepath
 * @returns {Promise<object|null>}
 */
async function getStreamInfo(filepath) {
  const data = await probe(filepath);
  if (!data) return null;

  const streams = data.streams || [];
  const v = streams.find(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find(s => s.codec_type === 'audio');
  const format = data.format || {};
  const level = parseInt(v?.level);

  return {
    duration: parseFloat(format.duration) || 0,
    width: v?.width || 0,
    height: v?.height || 0,
    filesize: parseInt(format.size) || 0,
    bitrate: parseInt(format.bit_rate) || 0,
    video_codec: v?.codec_name || null,
    audio_codec: a?.codec_name || null,
    pix_fmt: v?.pix_fmt || null,
    codec_profile: v?.profile != null ? String(v.profile) : null,
    codec_level: Number.isFinite(level) && level > 0 ? level : null,
    container: format.format_name || null,
    has_video: !!v,
    has_audio: !!a,
  };
}

/**
 * Get audio-specific info + tags (used by the audio processor)
 * @param {string} filepath
 * @returns {Promise<object>} audio info ({} on error)
 */
async function getAudioInfo(filepath) {
  const data = await probe(filepath);
  if (!data) return {};

  const audioStream = data.streams?.find(s => s.codec_type === 'audio');
  const format = data.format || {};

  return {
    duration: parseFloat(format.duration) || 0,
    bitrate: parseInt(format.bit_rate) || 0,
    sampleRate: audioStream?.sample_rate ? parseInt(audioStream.sample_rate) : 0,
    channels: audioStream?.channels || 0,
    codec: audioStream?.codec_name || 'unknown',
    title: format.tags?.title || format.tags?.TITLE || null,
    artist: format.tags?.artist || format.tags?.ARTIST || null,
    album: format.tags?.album || format.tags?.ALBUM || null,
  };
}

/**
 * Get frame count for a video/gif
 * @param {string} filepath - Path to media file
 * @returns {Promise<number>} Frame count or 0 on error
 */
async function getFrameCount(filepath) {
  try {
    const { stdout } = await proc.run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-count_packets',
      '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', filepath
    ]);
    return parseInt(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Check if ffprobe is available (sync — startup check only)
 * @returns {boolean}
 */
function isAvailable() {
  try {
    // Resolved, not bare: a copy downloaded next to the exe counts. Quoted
    // because that path can contain spaces (e.g. under C:\Program Files).
    const ffprobe = require('./ffmpeg-locate').resolve('ffprobe');
    execSync(`"${ffprobe}" -version`, { encoding: 'utf-8', windowsHide: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a WebP file is animated (has multiple frames)
 * @param {string} filepath - Path to WebP file
 * @returns {Promise<boolean>} True if animated
 */
async function isAnimatedWebp(filepath) {
  try {
    // Check frame count - animated WebP will have > 1 frame
    const frameCount = await getFrameCount(filepath);
    if (frameCount > 1) return true;

    // Alternative: check duration - animated WebP will have duration > 0
    const { stdout } = await proc.run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', filepath
    ]);
    const duration = parseFloat(stdout.trim());
    return duration > 0.1; // If duration > 0.1s, likely animated
  } catch (err) {
    return false;
  }
}

module.exports = {
  probe,
  getInfo,
  getStreamInfo,
  getAudioInfo,
  getFrameCount,
  isAvailable,
  isAnimatedWebp,
};
