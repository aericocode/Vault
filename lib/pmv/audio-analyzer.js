/**
 * PMV Studio — soundtrack analysis (CJS port of the sample's audio-analyzer).
 * PCM extract → energy-based onset beats → BPM estimate → grid quantize →
 * energy curve. Pure function of the audio file; results are cached by the
 * repo (pmv_audio_analysis).
 */

const { spawn } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

/** Extract mono PCM samples for analysis. */
function extractAudioPCM(filePath, sampleRate = 22050) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const proc = spawn(FFMPEG, [
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

/** Energy-differential onset detection with an adaptive local threshold. */
function detectBeats(samples, sampleRate, { hopSize = 512, sensitivity = 1.4 } = {}) {
  const frameSize = 1024;
  const beats = [];
  const energies = [];

  for (let i = 0; i < samples.length - frameSize; i += hopSize) {
    let energy = 0;
    for (let j = 0; j < frameSize; j++) energy += samples[i + j] * samples[i + j];
    energies.push(energy / frameSize);
  }

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

  const maxEnergy = Math.max(...curve.map(c => c.energy));
  if (maxEnergy > 0) for (const c of curve) c.energyNorm = c.energy / maxEnergy;
  return curve;
}

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

/** Snap beats toward the BPM grid (partial pull, keeps groove). */
function quantizeBeats(beats, bpm, strength = 0.5) {
  const beatInterval = 60 / bpm;
  return beats.map(beat => {
    const gridPos = Math.round(beat.time / beatInterval) * beatInterval;
    return { ...beat, originalTime: beat.time, time: beat.time + (gridPos - beat.time) * strength };
  });
}

/** Full soundtrack analysis. */
async function analyzeAudio(filePath, onProgress) {
  const progress = (stage, pct) => onProgress?.({ stage, percent: pct });

  progress('extract', 0);
  const { samples, sampleRate } = await extractAudioPCM(filePath);

  progress('beats', 30);
  const rawBeats = detectBeats(samples, sampleRate);

  progress('bpm', 50);
  const { bpm, confidence, beatInterval } = estimateBPM(rawBeats);

  progress('quantize', 60);
  const beats = quantizeBeats(rawBeats, bpm, 0.3);

  progress('energy', 80);
  const energyCurve = computeEnergyCurve(samples, sampleRate);

  progress('done', 100);

  return {
    duration: samples.length / sampleRate,
    sampleRate, bpm, bpmConfidence: confidence, beatInterval,
    beats, energyCurve, totalBeats: beats.length,
  };
}

module.exports = { extractAudioPCM, detectBeats, computeEnergyCurve, estimateBPM, quantizeBeats, analyzeAudio };
