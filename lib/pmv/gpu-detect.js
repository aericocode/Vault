/**
 * PMV Studio — GPU encoder detection via FFmpeg (CJS port of the sample's
 * utils/gpu-detect.js). NVENC is validated with a real tiny encode, not just
 * the -encoders listing; falls back to libx264 with a diagnostic hint.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const NULL_SINK = process.platform === 'win32' ? 'NUL' : '/dev/null';

let cachedResult = null;

async function detectGPU() {
  if (cachedResult) return cachedResult;

  const result = {
    nvenc: false,
    nvdec: false,
    encoder: 'libx264',
    hwaccelArgs: [],
    encoderArgs: [],
    label: 'CPU (libx264)',
    diagError: null,
  };

  try {
    const { stdout: encoders } = await exec(FFMPEG, ['-encoders'], { timeout: 5000 });

    if (encoders.includes('h264_nvenc')) {
      // Listed — validate it actually works (drivers can lie)
      try {
        await exec(FFMPEG, [
          '-y', '-f', 'lavfi',
          '-i', 'smptebars=size=256x256:duration=0.5:rate=10',
          '-c:v', 'h264_nvenc', '-preset', 'p1', '-f', 'mp4',
          NULL_SINK,
        ], { timeout: 15000 });
        result.nvenc = true;
        result.encoder = 'h264_nvenc';
        result.encoderArgs = ['-preset', 'p4', '-rc', 'vbr', '-tune', 'hq'];
        result.label = 'GPU (NVENC h264)';
      } catch (err) {
        const errMsg = (err.stderr || err.message || '').slice(-300);
        result.diagError = errMsg;
        result.label = 'CPU (libx264) — NVENC failed validation';
        if (errMsg.includes('Cannot load')) {
          result.hint = 'FFmpeg cannot load NVENC library. Update NVIDIA drivers.';
        } else if (errMsg.includes('not found') || errMsg.includes('No capable devices')) {
          result.hint = 'NVENC not available on this GPU/driver.';
        } else if (errMsg.includes('out of memory')) {
          result.hint = 'GPU out of memory for encoding. Close other GPU apps.';
        }
      }
    }

    if (encoders.includes('hevc_nvenc')) result.hevcNvenc = true;

    const { stdout: hwaccels } = await exec(FFMPEG, ['-hwaccels'], { timeout: 5000 });
    if (hwaccels.includes('cuda')) {
      result.nvdec = true;
      result.hwaccelArgs = ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'];
    }
  } catch (err) {
    result.error = err.message;
  }

  cachedResult = result;
  return result;
}

function getEncoderConfig(gpu, quality = 'medium') {
  if (gpu.nvenc) {
    const cqMap = { high: 18, medium: 23, low: 28 };
    const cq = cqMap[quality] || 23;
    return {
      codec: 'h264_nvenc',
      fastArgs: ['-preset', 'p1', '-rc', 'vbr', '-cq', '28'],
      qualityArgs: [...gpu.encoderArgs, '-cq', String(cq), '-b:v', '0'],
    };
  }

  const crfMap = { high: 16, medium: 20, low: 24 };
  const presetMap = { high: 'slow', medium: 'medium', low: 'ultrafast' };
  return {
    codec: 'libx264',
    fastArgs: ['-crf', '26', '-preset', 'ultrafast'],
    qualityArgs: ['-crf', String(crfMap[quality] || 20), '-preset', presetMap[quality] || 'medium'],
  };
}

module.exports = { detectGPU, getEncoderConfig };
