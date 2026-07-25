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
  const data = await probe(filepath);
  if (!data) return null;

  const videoStream = data.streams?.find(s => s.codec_type === 'video');
  const format = data.format || {};

  return {
    duration: parseFloat(format.duration) || 0,
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    filesize: parseInt(format.size) || 0,
    codec: videoStream?.codec_name || 'unknown',
    bitrate: parseInt(format.bit_rate) || 0,
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
    execSync('ffprobe -version', { encoding: 'utf-8', windowsHide: true, stdio: 'ignore' });
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
  getAudioInfo,
  getFrameCount,
  isAvailable,
  isAnimatedWebp,
};
