/**
 * Music ID — Chromaprint fingerprinting (ffmpeg + fpcalc).
 *
 * CJS port of the SAMPLES project's fingerprint.js with one addition the
 * samples lacked: a SILENCE GATE. Chunks whose mean RMS energy is below
 * SILENCE_FLOOR_DB never enter the DB (and therefore never match), which
 * kills the dead-air false-match failure mode.
 *
 * Chunking: 30s windows hopping every 15s (50% overlap). Each fingerprint
 * int encodes ~0.124s of audio; chunks store as base64 in SQLite TEXT.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Resolved per call, not once at load: a copy downloaded next to the exe by
// the setup banner must be picked up without a restart (lib/ffmpeg-locate.js).
// An explicit env override still beats everything.
const FPCALC = () => process.env.FPCALC_PATH || require('../ffmpeg-locate').resolve('fpcalc');
const FFMPEG = () => process.env.FFMPEG_PATH || require('../ffmpeg-locate').resolve('ffmpeg');

const CHUNK_DURATION = 30;     // seconds
const CHUNK_HOP = 15;          // seconds (50% overlap)
const SAMPLE_RATE = 11025;     // chromaprint downsamples to ~11025 anyway
const CHANNELS = 1;            // mono
const MIN_FP_DURATION = 8;     // chromaprint needs ~8s minimum
const SILENCE_FLOOR_DB = -45;  // chunks quieter than this (mean RMS dBFS) are skipped

/** Run a process, resolve { stdout, stderr, code }. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('close', (code) => resolve({ stdout, stderr, code }));
    p.on('error', reject);
  });
}

/**
 * Extract the media's audio track to a temporary mono WAV at SAMPLE_RATE Hz.
 * Returns { wavPath, tmpDir } — caller must rm the tmpDir.
 */
async function extractAudio(mediaPath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-fp-'));
  const wavPath = path.join(tmpDir, 'audio.wav');
  const { code, stderr } = await run(FFMPEG(), [
    '-hide_banner', '-loglevel', 'error',
    '-y',
    '-i', mediaPath,
    '-vn',
    '-ac', String(CHANNELS),
    '-ar', String(SAMPLE_RATE),
    '-f', 'wav',
    wavPath,
  ]);
  if (code !== 0) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw new Error(`ffmpeg failed: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
  }
  return { wavPath, tmpDir };
}

/**
 * Per-window RMS energy (dBFS) straight from the extracted WAV — we control
 * the ffmpeg args so the format is always RIFF pcm_s16le mono. Streaming a
 * 60-min file at 11025 Hz is ~79 MB; read it once, square-sum per window.
 *
 * Returns (startSec, lengthSec) => mean dBFS, or null if the WAV can't be
 * parsed (in which case the caller skips gating rather than failing).
 */
function buildEnergyProbe(wavPath) {
  let buf;
  try { buf = fs.readFileSync(wavPath); } catch { return null; }
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;

  // Walk RIFF chunks to find 'data' (ffmpeg may emit LIST chunks first)
  let off = 12;
  let dataStart = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') { dataStart = off + 8; dataLen = Math.min(size, buf.length - dataStart); break; }
    off += 8 + size + (size % 2);
  }
  if (dataStart < 0) return null;

  const samples = Math.floor(dataLen / 2);
  return (startSec, lengthSec) => {
    const s0 = Math.max(0, Math.min(samples, Math.floor(startSec * SAMPLE_RATE)));
    const s1 = Math.max(s0, Math.min(samples, Math.floor((startSec + lengthSec) * SAMPLE_RATE)));
    const n = s1 - s0;
    if (n <= 0) return -Infinity;
    let sumSq = 0;
    for (let i = s0; i < s1; i++) {
      const v = buf.readInt16LE(dataStart + i * 2) / 32768;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / n);
    return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  };
}

/**
 * Fingerprint a window of an audio file from startSec for lengthSec.
 * If startSec is null, fingerprints the whole file.
 * Returns { duration, fingerprint: number[] }.
 */
async function fingerprintWindow(wavPath, startSec = null, lengthSec = null) {
  let target = wavPath;
  let cleanup = null;
  if (startSec != null) {
    const tmp = path.join(os.tmpdir(), `vt-trim-${crypto.randomUUID()}.wav`);
    // Re-encode (no -c copy) so the output WAV is valid to seek/decode
    const { code, stderr } = await run(FFMPEG(), [
      '-hide_banner', '-loglevel', 'error',
      '-y',
      '-ss', String(startSec),
      '-t', String(lengthSec),
      '-i', wavPath,
      '-ac', String(CHANNELS),
      '-ar', String(SAMPLE_RATE),
      '-f', 'wav',
      tmp,
    ]);
    if (code !== 0) throw new Error(`ffmpeg trim failed: ${stderr.trim()}`);
    target = tmp;
    cleanup = () => { try { fs.unlinkSync(tmp); } catch {} };
  }
  try {
    const { code, stdout, stderr } = await run(FPCALC(), ['-raw', '-json', target]);
    if (code !== 0) throw new Error(`fpcalc failed: ${stderr.trim()}`);
    const parsed = JSON.parse(stdout);
    const fp = parsed.fingerprint;
    if (!Array.isArray(fp)) throw new Error('fpcalc raw fingerprint not an array');
    return { duration: Number(parsed.duration), fingerprint: fp };
  } finally {
    if (cleanup) cleanup();
  }
}

/**
 * Generate chunked fingerprints across an entire file, skipping silent chunks.
 * @returns { chunks: Array<{start_sec,end_sec,duration,fingerprint}>, skippedSilent: number }
 */
async function fingerprintMedia(mediaPath, opts = {}) {
  const {
    chunkDuration = CHUNK_DURATION,
    chunkHop = CHUNK_HOP,
    totalDuration = null,
    onProgress = null,
  } = opts;

  const { wavPath, tmpDir } = await extractAudio(mediaPath);
  try {
    let total = totalDuration;
    if (total == null) {
      const { duration } = await fingerprintWindow(wavPath);
      total = duration;
    }
    const energyAt = buildEnergyProbe(wavPath);
    const starts = [];
    for (let s = 0; s + MIN_FP_DURATION <= total; s += chunkHop) starts.push(s);

    const chunks = [];
    let skippedSilent = 0;
    let i = 0;
    for (const start of starts) {
      const len = Math.min(chunkDuration, total - start);
      if (len < MIN_FP_DURATION) break;
      i++;
      // Silence gate: dead air never enters the DB, so it can never match
      if (energyAt && energyAt(start, len) < SILENCE_FLOOR_DB) {
        skippedSilent++;
        if (onProgress) onProgress({ done: i, total: starts.length, sec: start });
        continue;
      }
      const { duration, fingerprint } = await fingerprintWindow(wavPath, start, len);
      chunks.push({ start_sec: start, end_sec: start + duration, duration, fingerprint });
      if (onProgress) onProgress({ done: i, total: starts.length, sec: start });
    }
    return { chunks, skippedSilent };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** Fingerprint a specific segment of a file (used for song reference fingerprints). */
async function fingerprintSegment(mediaPath, startSec, endSec) {
  const { wavPath, tmpDir } = await extractAudio(mediaPath);
  try {
    const len = endSec - startSec;
    if (len < MIN_FP_DURATION) {
      throw new Error(`Segment too short: ${len.toFixed(1)}s (min ${MIN_FP_DURATION}s)`);
    }
    return await fingerprintWindow(wavPath, startSec, len);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** Verify fpcalc + ffmpeg are installed and runnable. */
async function checkTools() {
  const errors = [];
  let fpcalcVersion = null;
  let ffmpegVersion = null;
  try {
    const r = await run(FPCALC(), ['-version']);
    if (r.code !== 0) errors.push('fpcalc -version failed');
    else fpcalcVersion = (r.stdout + r.stderr).trim().split('\n')[0];
  } catch (e) {
    errors.push('fpcalc not found — use ⬇ Download in the setup banner at the top of the page, or install Chromaprint to PATH.');
  }
  try {
    const r = await run(FFMPEG(), ['-version']);
    if (r.code !== 0) errors.push('ffmpeg -version failed');
    else ffmpegVersion = r.stdout.split('\n')[0];
  } catch (e) {
    errors.push(`ffmpeg not found: ${e.message}`);
  }
  return { ok: errors.length === 0, fpcalcVersion, ffmpegVersion, errors };
}

/** Encode int array as base64 for SQLite TEXT column. */
function encodeFingerprint(intArr) {
  const buf = Buffer.alloc(intArr.length * 4);
  for (let i = 0; i < intArr.length; i++) buf.writeInt32LE(intArr[i] | 0, i * 4);
  return buf.toString('base64');
}

/** Decode base64 fingerprint back to Int32Array. */
function decodeFingerprint(str) {
  const buf = Buffer.from(str, 'base64');
  const out = new Int32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt32LE(i * 4);
  return out;
}

module.exports = {
  CHUNK_DURATION, CHUNK_HOP, SAMPLE_RATE, MIN_FP_DURATION, SILENCE_FLOOR_DB,
  extractAudio, fingerprintWindow, fingerprintMedia, fingerprintSegment,
  checkTools, encodeFingerprint, decodeFingerprint,
};
