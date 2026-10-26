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
 *   onsetEnvelope, estimateTempo         tempo from the autocorrelation of
 *                                        the onset envelope, with octave
 *                                        handling and a confidence
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
    try { proc = spawn(ffmpegCmd(), args, { windowsHide: true }); } catch (err) { return reject(err); }
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
    proc.on('error', err => finish(() => reject(err)));
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
      '-show_entries', 'format=duration', '-of', 'json', filePath], { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' }));
      if (err) return reject(Object.assign(new Error(lastLine(err.stderr || err.message) || 'ffprobe failed'), { code: 'DECODE' }));
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

/* ── Tempo: autocorrelation of the onset envelope ──────────────────────── */

const ENV_FRAME = 1024;
const ENV_HOP = 256;

/**
 * Onset strength per frame: the rise in log energy (half-wave rectified),
 * less its local average, so steady sound (a held tone, hiss) reads as zero.
 * The log has a floor 30 dB under the stretch's average energy, so sound
 * starting out of silence counts as one onset, not a cliff.
 * @returns {{env: Float32Array, fps: number}}
 */
function onsetEnvelope(mono, sampleRate) {
  const e = frameEnergies(mono, { frameSize: ENV_FRAME, hopSize: ENV_HOP });
  const fps = sampleRate / ENV_HOP;
  const n = e.length;
  const env = new Float32Array(n);
  let avgE = 0;
  for (let i = 0; i < n; i++) avgE += e[i];
  const floor = Math.max(1e-10, (avgE / Math.max(1, n)) * 1e-3);
  let prev = Math.log10(floor + (e[0] || 0));
  for (let i = 1; i < n; i++) {
    const cur = Math.log10(floor + e[i]);
    env[i] = Math.max(0, cur - prev);
    prev = cur;
  }
  // Take off the local mean (about a second).
  const w = Math.max(1, Math.round(fps * 0.5));
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    out[i] = Math.max(0, env[i] - (prefix[b] - prefix[a]) / (b - a));
  }
  return { env: out, fps };
}

const TEMPO_MIN = 50;
const TEMPO_MAX = 200;
const TEMPO_DOUBLE_MAX = 180;     // a slow pick is doubled only up to here

/**
 * Tempo of a stretch of mono audio.
 *
 * The onset envelope's autocorrelation r(lag) peaks at the beat period and its
 * multiples. Each lag in 40..240 BPM is scored r(l) + r(2l)/2 (a two-tooth
 * comb, so the true period beats its half), weighted by a broad preference
 * for ~120 BPM (a log-normal one octave wide, as most beat trackers use). Then
 * octave handling: when the pulse at double the tempo is nearly as strong
 * (r(l/2) >= 0.8 r(l)) and stays under 180 BPM, the faster one is taken (a DnB
 * track at 174 is not called 87). Parabolic interpolation refines the lag.
 *
 * confidence (0..1): how far the correlation one, two and three periods on
 * stands above the average correlation over the lag range, relative to r(0),
 * times how strong the onsets are. A click track is near 1; speech, noise or a
 * held tone are near 0.
 *
 * @returns {{bpm: number|null, confidence: number}}
 */
function estimateTempo(mono, sampleRate) {
  const { env, fps } = onsetEnvelope(mono, sampleRate);
  const n = env.length;
  const minLag = Math.max(2, Math.floor(60 * fps / 240));
  const maxLag = Math.ceil(60 * fps / 40);
  if (n < maxLag * 2 + 4) return { bpm: null, confidence: 0 };
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += env[i] * env[i];
  r0 /= n;
  if (!(r0 > 1e-9) || mean <= 0) return { bpm: null, confidence: 0 };
  const top = Math.min(n - 1, maxLag * 3 + 3);
  const r = new Float64Array(top + 1);
  for (let l = 1; l <= top; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += env[i] * env[i + l];
    r[l] = s / (n - l);
  }
  const prior = (lag) => {
    const bpm = 60 * fps / lag;
    const o = Math.log2(bpm / 120);
    return Math.exp(-0.5 * o * o);
  };
  let best = -1, bestScore = -Infinity;
  for (let l = minLag; l <= maxLag; l++) {
    const score = (r[l] + 0.5 * (2 * l <= top ? r[2 * l] : 0)) * prior(l);
    if (score > bestScore) { bestScore = score; best = l; }
  }
  if (best < 0) return { bpm: null, confidence: 0 };
  // Octave: a strong pulse at half the period means the tempo is double.
  const half = Math.round(best / 2);
  if (half >= minLag && 60 * fps / half <= TEMPO_DOUBLE_MAX) {
    const rh = Math.max(r[half], r[half - 1] || 0, r[half + 1] || 0);
    if (rh >= 0.8 * r[best]) best = r[half - 1] > r[half] && r[half - 1] >= (r[half + 1] || 0) ? half - 1 : (r[half + 1] > r[half] ? half + 1 : half);
  }
  // Refine the lag between frames.
  let lag = best;
  if (best > 1 && best < top) {
    const a = r[best - 1], b = r[best], c = r[best + 1];
    const d = a - 2 * b + c;
    if (d < 0) lag = best + 0.5 * (a - c) / d;
  }
  let avg = 0, cnt = 0;
  for (let l = minLag; l <= maxLag; l++) { avg += r[l]; cnt++; }
  avg /= cnt;
  // Onsets too faint to hear as a beat (a held tone's codec ripple is
  // perfectly periodic, and tiny) scale the confidence down to nothing: the
  // loudest 1 % of rises must reach 0.03 to count at all, 0.13 to count fully.
  const sorted = Float32Array.from(env).sort();
  const p99 = sorted[Math.floor(0.99 * (n - 1))];
  const strength = Math.max(0, Math.min(1, (p99 - 0.03) / 0.1));
  // A beat keeps going: the correlation one, two and three periods on must
  // all stand out (a rhythm-like flutter that drifts, as speech can, fades).
  const norm = (l) => {
    const li = Math.round(l);
    if (li > top) return 0;
    const v = Math.max(r[li], r[li - 1] || 0, li + 1 <= top ? r[li + 1] : 0);
    return Math.max(0, Math.min(1, (v - avg) / (r0 - avg || 1)));
  };
  const periodic = (norm(lag) + norm(2 * lag) + norm(3 * lag)) / 3;
  const confidence = periodic * strength;
  let bpm = 60 * fps / lag;
  while (bpm < TEMPO_MIN) bpm *= 2;
  while (bpm > TEMPO_MAX) bpm /= 2;
  return { bpm: Math.round(bpm * 10) / 10, confidence: Math.round(confidence * 1000) / 1000 };
}

module.exports = {
  extractAudioPCM, extractPCM, toMono, probeAudio, channelWeights,
  frameEnergies, detectBeats, computeEnergyCurve, estimateBPM,
  kWeightCoefs, loudnessBlocks, integratedLoudness, samplePeak,
  onsetEnvelope, estimateTempo,
};
