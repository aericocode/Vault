/**
 * Flow: measure one file's music from its sound (FLOW, "What Vault measures").
 *
 * Per file: loudness (integrated LUFS, EBU R128), the true peak, and the
 * tempo and energy of three windows: the start (first 30 s), the middle (45 s
 * around the half-way point) and the end (last 30 s). Plus whether it has
 * music at all ("no music": no steady beat anywhere).
 *
 * It runs in a worker thread (lib/flow/worker.js), never on the server's
 * main thread.
 *
 * How it decodes (speed matters: this runs over whole libraries):
 *   - ffprobe first: the audio stream's channels and layout, the length (a
 *     file with no audio stream stops here);
 *   - up to 150 s long (60 s for surround): the whole file, once;
 *   - longer: only the three windows, plus six 8 s samples spread over the
 *     rest for the loudness (about 2.5 minutes of audio whatever the length),
 *     each an ffmpeg input seek. The loudness of a long file is an estimate
 *     from those parts, gated as R128 gates the whole;
 *   - length unknown even to ffprobe: the first 150 s, as if that were all.
 * So memory stays bounded: at most 150 s of stereo (or 60 s of 7.1) at
 * 22.05 kHz, about 26 MB (42 MB).
 *
 * Loudness: the file's own channels (up to 7.1) at 22.05 kHz, K-weighted
 * (designed for 22.05 kHz from the standard's analogue parameters), with the
 * BS.1770 channel weights (surrounds 1.41, LFE left out); a layout Vault does
 * not know is mixed down to stereo. Content above 11 kHz is not heard by it:
 * a few tenths of a dB on typical material (test/flow-analyze.test.js checks
 * it against ffmpeg's ebur128, stereo and 5.1).
 *
 * Peak: ffmpeg's ebur128 true-peak meter (4x oversampled, at the source's own
 * sample rate) over the same stretches, in the same ffmpeg process, so high
 * frequencies the 22.05 kHz decode cannot carry still count. This is what
 * Even out loudness keeps positive gain under (lib/flow/loudness.js).
 *
 * Energy (0 calm .. 1 intense) uses a fixed scale, the same for every file
 * and every library, so stored values never need recomputing:
 *   0.6 x loudness of the window, -38 LUFS -> 0 .. -8 LUFS -> 1
 *   0.2 x onset rate (PMV's onset detector), 0 .. 6 per second
 *   0.2 x tempo, 60 -> 0 .. 180 BPM -> 1 (0.5 when there is no beat)
 *
 * Energy envelope (the Flow chart's line): about 10 points per file, each
 * [t, e] with t where in the file (0..1) and e the energy on the same fixed
 * scale, from audio already decoded for the rest (no extra decoding):
 *   - a file decoded whole: ENV_POINTS equal slices (fewer for a short file,
 *     a slice at least ENV_MIN_S seconds; under 3 slices, no envelope);
 *   - a long file: the start, middle and end windows (each split in two when
 *     it covers an eighth of the file or more) plus the 8 s loudness samples
 *     that fall outside the windows, sorted by time.
 * A slice with no steady beat of its own uses the file's tempo, as the
 * windows do. Stored compactly in media_flow.env (lib/flow/store.js).
 *
 * "No music": the best tempo confidence of the three windows is under 0.3, or
 * the file is quieter than -50 LUFS (silence, room tone). Speech, a held tone
 * and noise have no steady beat and land here; so does beatless ambient music,
 * which is the price of keeping it simple.
 */

const dsp = require('../audio/dsp');

const VERSION = 3;              // bump when the method changes: older rows are measured again (3: the envelope)
const MIN_VERSION = 2;          // older rows from here on mean the same (no envelope): used until measured again
const SR = 22050;
const WHOLE_MAX_S = 150;        // decode it all up to this long (stereo or less)
const WHOLE_MAX_SURROUND_S = 60;
const EDGE_S = 30;              // start and end windows
const MID_S = 45;               // the middle window
const SAMPLE_S = 8;             // the extra loudness samples of a long file
const SAMPLES = 6;
const ENV_POINTS = 10;          // the envelope of a file decoded whole
const ENV_MIN_S = 4;            // seconds a slice at least
const MUSIC_CONF = 0.3;
const SILENT_LUFS = -50;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round = (v, d = 3) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

/** Energy of one window from its loudness, onset rate and tempo (the fixed scale above). */
function windowEnergy({ lufs, onsetRate, bpm }) {
  const loud = lufs == null ? 0 : clamp01((lufs + 38) / 30);
  const onsets = clamp01((onsetRate || 0) / 6);
  // No beat: the tempo part sits at the middle, unless there is no sound at all.
  const tempo = bpm ? clamp01((bpm - 60) / 120) : (lufs == null ? 0 : 0.5);
  return clamp01(0.6 * loud + 0.2 * onsets + 0.2 * tempo);
}

/** Tempo, onset rate and loudness of one stretch of interleaved audio. */
function measureWindow(samples, channels, weights) {
  const blocks = dsp.loudnessBlocks(samples, SR, channels, weights);
  const mono = dsp.toMono(samples, channels);
  const seconds = mono.length / SR;
  if (seconds < 2) return { seconds, lufs: null, bpm: null, conf: 0, onsetRate: 0, blocks };
  const lufs = dsp.integratedLoudness(blocks);
  const t = dsp.estimateTempo(mono, SR);
  const onsets = dsp.detectBeats(mono, SR).length;
  return { seconds, lufs, bpm: t.bpm, conf: t.confidence, onsetRate: onsets / seconds, blocks };
}

/** Slice [a, b) seconds out of interleaved samples. */
function slice(samples, channels, a, b) {
  const s = Math.max(0, Math.floor(a * SR)) * channels;
  const e = Math.min(samples.length, Math.floor(b * SR) * channels);
  return samples.subarray(s, Math.max(s, e));
}

/** Where the three windows sit in a file `d` seconds long. */
function windowsFor(d) {
  const edge = Math.min(EDGE_S, d / 3);
  const mid = Math.min(MID_S, d / 3);
  return {
    start: [0, edge],
    mid: [Math.max(0, d / 2 - mid / 2), Math.min(d, d / 2 + mid / 2)],
    end: [Math.max(0, d - edge), d],
  };
}

const maxPeak = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

/**
 * Measure a file. Resolves the features (all numbers rounded), or rejects
 * (code NO_AUDIO when it has no audio stream, ABORTED when cancelled).
 * @param {string} filePath
 * @param {object} [o]
 * @param {number} [o.duration]   seconds, from the library; ffprobe's answer wins when it has one
 * @param {AbortSignal} [o.signal]
 * @param {Function} [o.extract]  dsp.extractPCM (tests)
 * @param {Function} [o.probe]    dsp.probeAudio (tests)
 */
async function measureFile(filePath, { duration = null, signal = null, extract = dsp.extractPCM, probe = dsp.probeAudio } = {}) {
  const t0 = Date.now();
  const info = await probe(filePath, { signal });
  const { channels, weights } = dsp.channelWeights(info.layout, info.channels);
  const opts = { sampleRate: SR, channels, lowPriority: true, signal, truePeak: true };
  const d = info.duration || (Number(duration) > 0 ? Number(duration) : null);
  const wholeMax = channels > 2 ? WHOLE_MAX_SURROUND_S : WHOLE_MAX_S;
  let win;
  let blocks = [];
  let peak = null;
  const parts = [];               // the envelope's stretches: { t, w } (w measured by measureWindow)
  if (!d || d <= wholeMax) {
    // Short, or a length nobody knows: the first wholeMax seconds, as the whole.
    const { samples, truePeakDb } = await extract(filePath, { ...opts, duration: wholeMax + 1, timeoutMs: 300000 });
    const len = samples.length / channels / SR;
    if (len < 0.5) return emptyResult(t0);
    const w = windowsFor(len);
    blocks = dsp.loudnessBlocks(samples, SR, channels, weights);
    peak = truePeakDb;
    win = {
      start: measureWindow(slice(samples, channels, ...w.start), channels, weights),
      mid: measureWindow(slice(samples, channels, ...w.mid), channels, weights),
      end: measureWindow(slice(samples, channels, ...w.end), channels, weights),
    };
    const k = Math.min(ENV_POINTS, Math.floor(len / ENV_MIN_S));
    if (k >= 3) {
      for (let i = 0; i < k; i++) {
        const a = (len * i) / k, b = (len * (i + 1)) / k;
        parts.push({ t: (a + b) / 2 / len, w: measureWindow(slice(samples, channels, a, b), channels, weights) });
      }
    }
  } else {
    const w = windowsFor(d);
    win = {};
    for (const k of ['start', 'mid', 'end']) {
      const [a, b] = w[k];
      const { samples, truePeakDb } = await extract(filePath, { ...opts, start: a, duration: b - a });
      win[k] = measureWindow(samples, channels, weights);
      blocks = blocks.concat(win[k].blocks);
      peak = maxPeak(peak, truePeakDb);
      // The envelope: the window whole, or its two halves when it covers enough of the file.
      const len = samples.length / channels / SR;
      if (b - a >= d / 8 && len >= 2 * ENV_MIN_S) {
        for (const [p, q] of [[0, len / 2], [len / 2, len]]) {
          parts.push({ t: (a + (p + q) / 2) / d, w: measureWindow(slice(samples, channels, p, q), channels, weights) });
        }
      } else {
        parts.push({ t: (a + b) / 2 / d, w: win[k] });
      }
    }
    const inWindow = (at) => Object.values(w).some(([a, b]) => at >= a && at <= b);
    for (let i = 0; i < SAMPLES; i++) {
      const at = d * (i + 0.5) / SAMPLES;
      if (Math.abs(at - d / 2) < MID_S / 2 + SAMPLE_S) continue;      // inside the middle window already
      const { samples, truePeakDb } = await extract(filePath, { ...opts, start: Math.max(0, at - SAMPLE_S / 2), duration: SAMPLE_S });
      blocks = blocks.concat(dsp.loudnessBlocks(samples, SR, channels, weights));
      peak = maxPeak(peak, truePeakDb);
      if (!inWindow(at)) parts.push({ t: at / d, w: measureWindow(samples, channels, weights) });
    }
  }
  const lufs = dsp.integratedLoudness(blocks);
  const conf = Math.max(win.start.conf, win.mid.conf, win.end.conf);
  const hasMusic = lufs != null && lufs > SILENT_LUFS && conf >= MUSIC_CONF;
  // A window without a steady beat of its own borrows the best one's tempo.
  const best = [win.mid, win.start, win.end].sort((a, b) => b.conf - a.conf)[0];
  const bpmOf = (w) => (!hasMusic ? null : (w.conf >= MUSIC_CONF * 0.66 && w.bpm ? w.bpm : best.bpm));
  const bpm = { start: bpmOf(win.start), mid: bpmOf(win.mid), end: bpmOf(win.end) };
  const energy = (w, b) => windowEnergy({ lufs: w.lufs, onsetRate: w.onsetRate, bpm: hasMusic ? b : null });
  parts.sort((a, b) => a.t - b.t);
  const env = parts.length >= 3 ? parts.map(p => [round(clamp01(p.t)), round(energy(p.w, bpmOf(p.w)))]) : null;
  return {
    version: VERSION,
    lufs: round(lufs, 2),
    peak_db: peak == null ? null : round(peak, 2),
    has_music: hasMusic ? 1 : 0,
    no_audio: 0,
    bpm_start: round(bpm.start, 1), bpm_mid: round(bpm.mid, 1), bpm_end: round(bpm.end, 1),
    bpm_conf: round(conf, 3),
    e_start: round(energy(win.start, bpm.start)), e_mid: round(energy(win.mid, bpm.mid)), e_end: round(energy(win.end, bpm.end)),
    env,
    ms: Date.now() - t0,
  };
}

function emptyResult(t0) {
  return {
    version: VERSION, lufs: null, peak_db: null, has_music: 0, no_audio: 0,
    bpm_start: null, bpm_mid: null, bpm_end: null, bpm_conf: 0,
    e_start: 0, e_mid: 0, e_end: 0, env: null, ms: Date.now() - t0,
  };
}

/** The row for a file with no audio stream at all. */
function noAudioResult() {
  return { ...emptyResult(Date.now()), no_audio: 1, ms: 0 };
}

module.exports = { measureFile, noAudioResult, windowEnergy, windowsFor, VERSION, MIN_VERSION, MUSIC_CONF, SILENT_LUFS, ENV_POINTS };
