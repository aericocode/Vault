/**
 * Audio DSP shared by PMV Studio (lib/pmv/audio-analyzer.js) and Flow
 * (lib/flow/analyze.js): PCM out of ffmpeg, onsets, energy, tempo and
 * loudness. Everything here is a pure function of the samples, except
 * extractPCM, which runs ffmpeg.
 *
 * Moved out of the PMV analyzer so Flow measures with the same code:
 *   extractAudioPCM, detectBeats, computeEnergyCurve, estimateBPM
 * are PMV's, unchanged. New for Flow:
 *   extractPCM          seek / length / channels / low priority / cancel
 *   loudnessBlocks, integratedLoudness   ITU-R BS.1770 (EBU R128) loudness
 *   fft, fluxEnvelope, envelopeTempo,    tempo from the autocorrelation of a
 *   estimateTempo                        spectral-flux onset envelope (24 log
 *                                        bands), with octave handling, a
 *                                        confidence and a sub-window score
 */

const { spawn } = require('child_process');
const os = require('os');

function ffmpegCmd() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('../ffmpeg-locate').resolve('ffmpeg'); } catch { return 'ffmpeg'; }
}

/* ── PCM out of ffmpeg ─────────────────────────────────────────────────── */

/** Extract mono PCM samples for analysis (PMV's call, as it always was). */
function extractAudioPCM(filePath, sampleRate = 22050) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn(ffmpegCmd(), [
      '-i', filePath,
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      '-v', 'quiet',
      'pipe:1',
    ], { windowsHide: true });

    proc.stdout.on('data', c => chunks.push(c));
    proc.on('close', () => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4) return reject(new Error('no audio decoded (is there an audio stream?)'));
      const samples = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
      resolve({ samples, sampleRate });
    });
    proc.on('error', reject);
  });
}

/**
 * Decode part (or all) of a file's first audio stream to f32 PCM through a pipe
 * (nothing is written to disk).
 *
 * @param {string} filePath
 * @param {object} [o]
 * @param {number} [o.sampleRate=22050]
 * @param {number} [o.channels=2]       interleaved when 2
 * @param {number} [o.start]            seconds (input seek, fast)
 * @param {number} [o.duration]         seconds
 * @param {boolean} [o.lowPriority]     run ffmpeg at the lowest process priority, one thread
 * @param {AbortSignal} [o.signal]      kills ffmpeg
 * @param {number} [o.timeoutMs=120000]
 * @param {boolean} [o.truePeak]       also run ffmpeg's ebur128 true-peak meter (4x oversampled, at the
 *                                      source's own rate) over the same stretch, in the same process
 * @returns {Promise<{samples: Float32Array, sampleRate: number, channels: number, truePeakDb?: number|null}>}
 *   Rejects with code NO_AUDIO when the file has no audio stream, ABORTED when cancelled.
 */
function extractPCM(filePath, { sampleRate = 22050, channels = 2, start = null, duration = null, lowPriority = false, signal = null, timeoutMs = 120000, truePeak = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' }));
    const args = ['-nostdin', '-hide_banner', '-nostats', '-v', truePeak ? 'info' : 'error'];
    if (lowPriority) args.push('-threads', '1');
    if (start != null && start > 0) args.push('-ss', start.toFixed(3));
    if (duration != null && duration > 0) args.push('-t', duration.toFixed(3));
    args.push('-i', filePath, '-vn', '-sn', '-dn', '-map', '0:a:0',
      '-ac', String(channels), '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1');
    if (truePeak) args.push('-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-');
    let proc;
    try { proc = spawn(ffmpegCmd(), args, { windowsHide: true }); } catch (err) { return reject(couldNotRun('ffmpeg', err)); }
    if (lowPriority) {
      try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not allowed: normal priority */ }
    }
    const chunks = [];
    let errText = '';
    let done = false;
    const finish = (fn) => { if (done) return; done = true; clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); fn(); };
    const onAbort = () => { try { proc.kill(); } catch {} finish(() => reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' }))); };
    if (signal) signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => { try { proc.kill(); } catch {} finish(() => reject(Object.assign(new Error('ffmpeg took too long'), { code: 'TIMEOUT' }))); }, timeoutMs);
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', c => { errText = (errText + c.toString()).slice(-8000); });
    proc.on('error', err => finish(() => reject(couldNotRun('ffmpeg', err))));
    proc.on('close', (code) => finish(() => {
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 4 * channels) {
        if (/matches no streams|does not contain any stream|Output file #0 does not contain/i.test(errText)) {
          return reject(Object.assign(new Error('no audio stream'), { code: 'NO_AUDIO' }));
        }
        if (code !== 0) return reject(Object.assign(new Error(lastLine(errText) || `ffmpeg exited with ${code}`), { code: 'DECODE' }));
        // Decoded nothing at all (a window past the end, an empty stream).
        return resolve({ samples: new Float32Array(0), sampleRate, channels, truePeakDb: null });
      }
      const n = Math.floor(buffer.length / (4 * channels)) * channels;
      // One copy into its own memory (little-endian, as every machine Vault runs on).
      const samples = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + n * 4));
      let truePeakDb;
      if (truePeak) {
        const m = /True peak:\s*[\r\n]+\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/i.exec(errText);
        truePeakDb = m && m[1] !== '-inf' ? Number(m[1]) : null;
      }
      resolve({ samples, sampleRate, channels, truePeakDb });
    }));
  });
}

/**
 * The first audio stream of a file: channels, layout, and the file's length.
 * Rejects NO_AUDIO when there is none.
 * @returns {Promise<{channels: number, layout: string, sampleRate: number, duration: number|null}>}
 */
function probeAudio(filePath, { signal = null, timeoutMs = 30000 } = {}) {
  let cmd = 'ffprobe';
  try { cmd = require('../ffmpeg-locate').resolve('ffprobe'); } catch {}
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' }));
    const { execFile } = require('child_process');
    const child = execFile(cmd, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,channel_layout,sample_rate',
      '-show_entries', 'format=duration', '-of', 'json', filePath], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' }));
      // ffprobe not there (or not allowed to run), or stopped by the timeout: said so, not as a file it could not read.
      if (err && typeof err.code === 'string' && !err.code.startsWith('ERR_')) return reject(couldNotRun('ffprobe', err));
      if (err && err.killed) return reject(Object.assign(new Error('ffprobe took too long'), { code: 'TIMEOUT' }));
      if (err) return reject(Object.assign(new Error(lastLine(stderr) || `ffprobe failed (exit ${err.code})`), { code: 'DECODE' }));
      let j;
      try { j = JSON.parse(stdout); } catch { return reject(Object.assign(new Error('ffprobe gave no answer'), { code: 'DECODE' })); }
      const s = (j.streams || [])[0];
      if (!s) return reject(Object.assign(new Error('no audio stream'), { code: 'NO_AUDIO' }));
      const d = Number(j.format && j.format.duration);
      resolve({ channels: Number(s.channels) || 2, layout: String(s.channel_layout || ''), sampleRate: Number(s.sample_rate) || 0, duration: Number.isFinite(d) && d > 0 ? d : null });
    });
    const onAbort = () => { try { child.kill(); } catch {} };
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

/**
 * BS.1770 channel weights in ffmpeg's channel order for a layout: 1 for left,
 * right and centre, 1.41 for surrounds, 0 for the LFE. { channels, weights }
 * to decode with; a layout not listed (or more than 8 channels) is mixed
 * down to stereo.
 */
const LAYOUT_WEIGHTS = {
  mono: [1], stereo: [1, 1], '2.1': [1, 1, 0], '3.0': [1, 1, 1], '3.0(back)': [1, 1, 1.41],
  '3.1': [1, 1, 1, 0], quad: [1, 1, 1.41, 1.41], 'quad(side)': [1, 1, 1.41, 1.41], '4.0': [1, 1, 1, 1.41],
  '4.1': [1, 1, 1, 0, 1.41], '5.0': [1, 1, 1, 1.41, 1.41], '5.0(side)': [1, 1, 1, 1.41, 1.41],
  '5.1': [1, 1, 1, 0, 1.41, 1.41], '5.1(side)': [1, 1, 1, 0, 1.41, 1.41],
  '6.0': [1, 1, 1, 1.41, 1.41, 1.41], '6.1': [1, 1, 1, 0, 1.41, 1.41, 1.41],
  '7.0': [1, 1, 1, 1.41, 1.41, 1.41, 1.41], '7.1': [1, 1, 1, 0, 1.41, 1.41, 1.41, 1.41],
  '7.1(wide)': [1, 1, 1, 0, 1.41, 1.41, 1, 1], '7.1(wide-side)': [1, 1, 1, 0, 1, 1, 1.41, 1.41],
};
function channelWeights(layout, channels) {
  const w = LAYOUT_WEIGHTS[layout];
  if (w && w.length === channels) return { channels, weights: w };
  if (!layout && channels === 1) return { channels: 1, weights: [1] };
  return { channels: 2, weights: [1, 1] };
}

/** ffmpeg or ffprobe could not be started at all (not found, not allowed): code SPAWN, the system's code in the text. */
function couldNotRun(tool, err) {
  const why = (err && (err.code || err.message)) || 'unknown error';
  return Object.assign(new Error(`couldn't run ${tool} (${why})`), { code: 'SPAWN' });
}

function lastLine(s) {
  const lines = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}

/** Interleaved stereo (or mono) -> mono mix. */
function toMono(samples, channels) {
  if (channels === 1) return samples;
  const n = Math.floor(samples.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += samples[i * channels + c];
    out[i] = s / channels;
  }
  return out;
}

/* ── PMV's onsets, energy curve and BPM (unchanged) ────────────────────── */

/** Mean-square energy of each frame (frameSize samples, every hop). */
function frameEnergies(samples, { frameSize = 1024, hopSize = 512 } = {}) {
  const energies = [];
  for (let i = 0; i < samples.length - frameSize; i += hopSize) {
    let energy = 0;
    for (let j = 0; j < frameSize; j++) energy += samples[i + j] * samples[i + j];
    energies.push(energy / frameSize);
  }
  return energies;
}

/** Energy-differential onset detection with an adaptive local threshold. */
function detectBeats(samples, sampleRate, { hopSize = 512, sensitivity = 1.4 } = {}) {
  const beats = [];
  const energies = frameEnergies(samples, { frameSize: 1024, hopSize });
  const windowSize = Math.floor(sampleRate / hopSize * 0.5); // ~500ms

  for (let i = windowSize; i < energies.length - windowSize; i++) {
    let localAvg = 0;
    for (let j = i - windowSize; j < i + windowSize; j++) localAvg += energies[j];
    localAvg /= (windowSize * 2);

    if (energies[i] > localAvg * sensitivity && energies[i] > energies[i - 1] && energies[i] >= energies[i + 1]) {
      const time = (i * hopSize) / sampleRate;
      if (beats.length === 0 || time - beats[beats.length - 1].time > 0.1) {
        beats.push({ time, energy: energies[i], strength: energies[i] / (localAvg || 0.001) });
      }
    }
  }

  return beats;
}

/** 100ms-resolution energy curve, normalized 0-1. */
function computeEnergyCurve(samples, sampleRate, resolution = 0.1) {
  const samplesPerBin = Math.floor(sampleRate * resolution);
  const curve = [];

  for (let i = 0; i < samples.length; i += samplesPerBin) {
    const end = Math.min(i + samplesPerBin, samples.length);
    let sumSq = 0;
    for (let j = i; j < end; j++) sumSq += samples[j] * samples[j];
    curve.push({ time: i / sampleRate, energy: sumSq / (end - i) });
  }

  let maxEnergy = 0;
  for (const c of curve) if (c.energy > maxEnergy) maxEnergy = c.energy;
  if (maxEnergy > 0) for (const c of curve) c.energyNorm = c.energy / maxEnergy;
  return curve;
}

/** PMV's BPM: the most common gap between onsets (10 ms bins). */
function estimateBPM(beats) {
  if (beats.length < 4) return { bpm: 120, confidence: 0, beatInterval: 0.5 };

  const histogram = {};
  for (let i = 1; i < beats.length; i++) {
    const key = Math.round((beats[i].time - beats[i - 1].time) * 100) / 100;
    histogram[key] = (histogram[key] || 0) + 1;
  }

  let bestInterval = 0.5, bestCount = 0;
  for (const [interval, count] of Object.entries(histogram)) {
    if (count > bestCount) { bestCount = count; bestInterval = parseFloat(interval); }
  }

  return {
    bpm: Math.min(300, Math.max(30, Math.round(60 / bestInterval))),
    confidence: bestCount / (beats.length - 1),
    beatInterval: bestInterval,
  };
}

/* ── Loudness: ITU-R BS.1770-4 / EBU R128 ──────────────────────────────── */

/**
 * The K-weighting pre-filter (a high shelf then a high pass) as two biquads
 * for any sample rate. The analogue parameters are the ones that give the
 * standard's published 48 kHz coefficients exactly (the libebur128 /
 * pyloudnorm derivation), so 22.05 kHz gets the same curve up to its Nyquist.
 */
function kWeightCoefs(fs) {
  // Stage 1: high shelf, +4 dB above ~1.7 kHz (the head).
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: high pass at ~38 Hz (RLB).
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

function biquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    y[i] = y0;
  }
  return y;
}

/**
 * Mean-square power of every 400 ms gating block (75 % overlap) of one stretch
 * of audio, K-weighted, summed over the channels with the BS.1770 weights
 * (1 for left, right and centre, 1.41 for the surrounds, 0 for the LFE;
 * channelWeights() gives them for a layout).
 * Blocks from several stretches of one file can be pooled before gating.
 * @returns {number[]}
 */
function loudnessBlocks(samples, sampleRate, channels, weights = null) {
  const n = Math.floor(samples.length / channels);
  const block = Math.round(0.4 * sampleRate);
  const step = Math.round(0.1 * sampleRate);
  if (n < block) return [];
  const [s1, s2] = kWeightCoefs(sampleRate);
  // Running sum of squares per channel (prefix sums) so each block is O(1).
  const prefix = new Float64Array(n + 1);
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = samples[i * channels + c];
    const w = weights && Number.isFinite(weights[c]) ? weights[c] : 1;
    if (!w) continue;                       // LFE: not counted
    const y = biquad(biquad(ch, s1), s2);
    for (let i = 0; i < n; i++) prefix[i + 1] += w * y[i] * y[i];
  }
  for (let i = 1; i <= n; i++) prefix[i] += prefix[i - 1];
  const out = [];
  for (let s = 0; s + block <= n; s += step) out.push((prefix[s + block] - prefix[s]) / block);
  return out;
}

const blockLufs = (z) => -0.691 + 10 * Math.log10(z);

/**
 * Integrated loudness (LUFS) of pooled gating blocks: absolute gate -70 LUFS,
 * then the relative gate 10 LU under the absolute-gated mean. null for
 * silence (nothing above -70).
 */
function integratedLoudness(blocks) {
  const abs = blocks.filter(z => z > 0 && blockLufs(z) > -70);
  if (!abs.length) return null;
  const meanAbs = abs.reduce((s, z) => s + z, 0) / abs.length;
  const rel = blockLufs(meanAbs) - 10;
  const kept = abs.filter(z => blockLufs(z) > rel);
  if (!kept.length) return null;
  return blockLufs(kept.reduce((s, z) => s + z, 0) / kept.length);
}

/** Highest absolute sample value (0..1+) of interleaved samples. */
function samplePeak(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > p) p = a; }
  return p;
}

/* ── Tempo: autocorrelation of a spectral-flux onset envelope ──────────── */

const FLUX_N = 512;          // FFT size (23 ms at 22.05 kHz)
const FLUX_HOP = 256;        // 86 frames a second at 22.05 kHz
const FLUX_BANDS = 24;       // log-spaced, 30 Hz .. 11 kHz
const FLUX_FLOOR_DB = 30;    // a band this far under the stretch's average band energy reads as silence

/** Radix-2 complex FFT, in place (re, im of a power-of-two length). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < h; j++) {
        const a = i + j, b = a + h;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const HANN = Float64Array.from({ length: FLUX_N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / FLUX_N));
const bandEdges = new Map();      // sampleRate -> FFT bin edges of the bands
function fluxBands(sampleRate) {
  if (!bandEdges.has(sampleRate)) {
    const top = Math.min(11000, sampleRate * 0.499);
    const e = [];
    for (let b = 0; b <= FLUX_BANDS; b++) e.push(Math.max(1, Math.round(30 * Math.pow(top / 30, b / FLUX_BANDS) * FLUX_N / sampleRate)));
    bandEdges.set(sampleRate, e);
  }
  return bandEdges.get(sampleRate);
}

/**
 * Onset strength per frame (spectral flux): each frame's energy in 24
 * log-spaced bands, as a log with a floor 30 dB under the stretch's average
 * band energy (so empty bands and codec noise read as flat); the rises,
 * half-wave rectified and averaged over the bands; less their local mean
 * (about a second). Frame f starts at sample f * hop.
 *
 * Per band rather than the whole signal's energy: in a dense, limited mix
 * (EDM, a PMV with voices over it) the overall energy hardly moves on the
 * beat, while the kick's and the hats' own bands still do.
 * @returns {{env: Float32Array, fps: number, hop: number, size: number}}
 */
function fluxEnvelope(mono, sampleRate) {
  const frames = Math.max(0, Math.floor((mono.length - FLUX_N) / FLUX_HOP));
  const fps = sampleRate / FLUX_HOP;
  const edges = fluxBands(sampleRate);
  const re = new Float64Array(FLUX_N), im = new Float64Array(FLUX_N);
  const E = new Float64Array(frames * FLUX_BANDS);
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const o = f * FLUX_HOP;
    for (let i = 0; i < FLUX_N; i++) { re[i] = mono[o + i] * HANN[i]; im[i] = 0; }
    fft(re, im);
    for (let b = 0; b < FLUX_BANDS; b++) {
      let s = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) s += re[k] * re[k] + im[k] * im[k];
      E[f * FLUX_BANDS + b] = s;
      total += s;
    }
  }
  const floor = Math.max(1e-12, total / Math.max(1, frames * FLUX_BANDS) * Math.pow(10, -FLUX_FLOOR_DB / 10));
  for (let i = 0; i < E.length; i++) E[i] = Math.log10(floor + E[i]);
  const raw = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let d = 0;
    for (let b = 0; b < FLUX_BANDS; b++) { const x = E[f * FLUX_BANDS + b] - E[(f - 1) * FLUX_BANDS + b]; if (x > 0) d += x; }
    raw[f] = d / FLUX_BANDS;
  }
  const w = Math.max(1, Math.round(fps * 0.5));
  const prefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i] + raw[i];
  const env = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w), b = Math.min(frames, i + w + 1);
    env[i] = Math.max(0, raw[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  return { env, fps, hop: FLUX_HOP, size: FLUX_N };
}

const TEMPO_MIN = 50;
const TEMPO_MAX = 200;
const TEMPO_DOUBLE_MAX = 180;     // a slow pick is doubled only up to here
const COMB_TEETH = 4;
const SUB_S = 15;                 // the steadiness check: 15 s pieces, every 7.5 s
const SUB_HOP_S = 7.5;

/**
 * Tempo and the correlation of one onset envelope.
 *
 * The envelope less its mean is autocorrelated and divided by its variance,
 * so r(lag) is a correlation (-1..1): onsets off the beat (a voice, a moan, a
 * sound effect) add to the variance, not to r at the beat. Each lag in
 * 40..240 BPM is scored by a four-tooth comb, the mean of r at 1, 2, 3 and 4
 * periods (so the true period beats a 2:3 or 3:4 neighbour), weighted by a
 * broad preference for ~120 BPM (a log-normal one octave wide). Octave
 * handling: when the pulse at double the tempo is nearly as strong
 * (r(l/2) >= 0.8 r(l)) and stays under 180 BPM, the faster one is taken.
 * Parabolic interpolation refines the lag.
 * corr: the mean of r one, two and three periods on (0..1).
 */
function envelopeCorrelation(env, fps) {
  const n = env.length;
  const minLag = Math.max(2, Math.floor(60 * fps / 240));
  const maxLag = Math.ceil(60 * fps / 40);
  if (n < maxLag * 2 + 4) return { bpm: null, corr: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float64Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) { x[i] = env[i] - mean; v += x[i] * x[i]; }
  v /= n;
  if (!(v > 1e-12)) return { bpm: null, corr: 0 };
  const top = Math.min(n - 1, maxLag * COMB_TEETH + 3);
  const r = new Float64Array(top + 1);
  for (let l = 1; l <= top; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += x[i] * x[i + l];
    r[l] = s / (n - l) / v;
  }
  const at = (l) => {
    const li = Math.round(l);
    if (li > top) return 0;
    return Math.max(r[li], r[li - 1] || 0, li + 1 <= top ? r[li + 1] : 0);
  };
  const prior = (lag) => {
    const o = Math.log2(60 * fps / lag / 120);
    return Math.exp(-0.5 * o * o);
  };
  let best = -1, bestScore = -Infinity;
  for (let l = minLag; l <= maxLag; l++) {
    let s = 0, c = 0;
    for (let k = 1; k <= COMB_TEETH && k * l <= top; k++) { s += Math.max(0, at(k * l)); c++; }
    const score = (s / Math.max(1, c)) * prior(l);
    if (score > bestScore) { bestScore = score; best = l; }
  }
  if (best < 0) return { bpm: null, corr: 0 };
  const half = Math.round(best / 2);
  if (half >= minLag && 60 * fps / half <= TEMPO_DOUBLE_MAX && at(half) >= 0.8 * at(best)) {
    best = half;
    if (r[half - 1] > r[best] && r[half - 1] >= (r[half + 1] || 0)) best = half - 1;
    else if (r[half + 1] > r[best]) best = half + 1;
  }
  // Refine the lag between frames (at a peak only, by at most half a frame).
  let lag = best;
  if (best > 1 && best < top) {
    const a = r[best - 1], b = r[best], c = r[best + 1];
    const d = a - 2 * b + c;
    if (b >= a && b >= c && d < 0) lag = best + Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
  }
  if (!(lag > 0)) return { bpm: null, corr: 0 };
  const corr = (Math.max(0, at(lag)) + Math.max(0, at(2 * lag)) + Math.max(0, at(3 * lag))) / 3;
  let bpm = 60 * fps / lag;
  while (bpm < TEMPO_MIN) bpm *= 2;
  while (bpm > TEMPO_MAX) bpm /= 2;
  return { bpm, corr };
}

/**
 * Tempo of a stretch from its onset envelope (fluxEnvelope, or a slice of one).
 *
 * confidence (0..1): the correlation one, two and three periods on, times how
 * strong the onsets are (the loudest 1 % of rises must reach 0.10 to count at
 * all, 0.20 to count fully: a held tone, near silence or a pad of pure tones
 * (whose partials only beat against each other) is 0; music is 0.2 or more).
 * score (0..1): the same, but the better of the whole stretch's correlation
 * and the median of its 15 s pieces' (every 7.5 s), so a stretch whose tempo
 * changes part way (a compilation) still shows its beat. A click track is
 * near 0.8-0.9; speech, noise, a held tone and beatless ambient stay under
 * about 0.17.
 * @returns {{bpm: number|null, confidence: number, score: number}}
 */
function envelopeTempo(env, fps) {
  const t = envelopeCorrelation(env, fps);
  if (t.bpm == null) return { bpm: null, confidence: 0, score: 0 };
  const sorted = Float32Array.from(env).sort();
  const p99 = sorted[Math.floor(0.99 * (sorted.length - 1))];
  const strength = Math.max(0, Math.min(1, (p99 - 0.1) / 0.1));
  const L = Math.round(SUB_S * fps), H = Math.round(SUB_HOP_S * fps);
  const subs = [];
  for (let a = 0; a + L <= env.length; a += H) subs.push(envelopeCorrelation(env.subarray(a, a + L), fps).corr);
  subs.sort((a, b) => a - b);
  const med = subs.length ? subs[Math.floor(subs.length / 2)] : 0;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return { bpm: Math.round(t.bpm * 10) / 10, confidence: r3(t.corr * strength), score: r3(Math.max(t.corr, med) * strength) };
}

/** Tempo of a stretch of mono audio (envelopeTempo of its fluxEnvelope). */
function estimateTempo(mono, sampleRate) {
  const { env, fps } = fluxEnvelope(mono, sampleRate);
  return envelopeTempo(env, fps);
}

module.exports = {
  extractAudioPCM, extractPCM, toMono, probeAudio, channelWeights,
  frameEnergies, detectBeats, computeEnergyCurve, estimateBPM,
  kWeightCoefs, loudnessBlocks, integratedLoudness, samplePeak,
  fft, fluxEnvelope, envelopeTempo, estimateTempo,
};
