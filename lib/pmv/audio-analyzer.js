/**
 * PMV Studio — soundtrack analysis (CJS port of the sample's audio-analyzer).
 * PCM extract → energy-based onset beats → BPM estimate → grid quantize →
 * energy curve. Pure function of the audio file; results are cached by the
 * repo (pmv_audio_analysis).
 */

// The DSP itself is shared with Flow (lib/flow/analyze.js): lib/audio/dsp.js.
const { extractAudioPCM, detectBeats, computeEnergyCurve, estimateBPM } = require('../audio/dsp');

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
