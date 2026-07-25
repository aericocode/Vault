/**
 * PMV Studio — source-video analysis (CJS port of the sample's video-analyzer).
 * scdet scene boundaries → per-second motion scores → ≤4s segments with
 * motion/peak scoring. Frames for VL tagging are extracted separately and only
 * when VL actually runs. Segment analysis is a pure function of the file and
 * is cached by the repo (pmv_video_analysis).
 *
 * Port fixes vs. the sample:
 *  - r_frame_rate parsed safely (the original ran eval() on ffprobe output)
 */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs/promises');

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** Parse "num/den" fraction strings from ffprobe without eval. */
function parseFraction(s, fallback = 30) {
  if (typeof s !== 'string') return fallback;
  const m = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (m) {
    const den = Number(m[2]);
    return den > 0 ? Number(m[1]) / den : fallback;
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function getVideoInfo(filePath) {
  const { stdout } = await exec(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ]);
  const info = JSON.parse(stdout);
  const videoStream = info.streams.find(s => s.codec_type === 'video');
  const audioStream = info.streams.find(s => s.codec_type === 'audio');

  return {
    duration: parseFloat(info.format.duration),
    width: videoStream?.width,
    height: videoStream?.height,
    fps: parseFraction(videoStream?.r_frame_rate),
    hasAudio: !!audioStream,
    codec: videoStream?.codec_name,
    filePath,
  };
}

/**
 * Scene boundaries via scdet, retrying with lower thresholds, then
 * motion-peak splits, so short/static sources still yield enough segments.
 */
async function detectSceneChanges(filePath, duration, { threshold = 0.15, minSegments = 8 } = {}) {
  let scenes = await _runScdet(filePath, threshold);
  if (scenes.length < minSegments && threshold > 0.05) scenes = await _runScdet(filePath, 0.08);
  if (scenes.length < minSegments) scenes = await _runScdet(filePath, 0.04);

  if (scenes.length < minSegments) {
    const motionSplits = await _motionBasedSplits(filePath, duration, minSegments - scenes.length);
    const allTimes = new Set(scenes.map(s => Math.round(s.time * 10) / 10));
    for (const s of motionSplits) {
      const rounded = Math.round(s.time * 10) / 10;
      let tooClose = false;
      for (const t of allTimes) {
        if (Math.abs(t - rounded) < 0.5) { tooClose = true; break; }
      }
      if (!tooClose) { allTimes.add(rounded); scenes.push(s); }
    }
    scenes.sort((a, b) => a.time - b.time);
  }

  return scenes;
}

function _runScdet(filePath, threshold) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const proc = spawn(FFMPEG, [
      '-i', filePath,
      '-vf', `scdet=threshold=${threshold}:sc_pass=1`,
      '-f', 'null', '-',
    ], { windowsHide: true });

    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('close', () => {
      const scenes = [];
      const times = [...stderr.matchAll(/lavfi\.scd\.time=(\d+\.?\d*)/g)];
      const scores = [...stderr.matchAll(/lavfi\.scd\.score=(\d+\.?\d*)/g)];
      for (let i = 0; i < times.length; i++) {
        scenes.push({ time: parseFloat(times[i][1]), score: scores[i] ? parseFloat(scores[i][1]) : threshold });
      }
      resolve(scenes);
    });
    proc.on('error', reject);
  });
}

async function _motionBasedSplits(filePath, duration, needed) {
  const motionScores = await computeMotionScores(filePath, 4);
  if (motionScores.length === 0) {
    const interval = duration / (needed + 1);
    return Array.from({ length: needed }, (_, i) => ({ time: interval * (i + 1), score: 0.5, source: 'even-split' }));
  }

  const peaks = [];
  for (let i = 1; i < motionScores.length - 1; i++) {
    if (motionScores[i].motionScore > motionScores[i - 1].motionScore &&
        motionScores[i].motionScore > motionScores[i + 1].motionScore &&
        motionScores[i].motionScore > 0.02) {
      peaks.push({ time: motionScores[i].time, score: motionScores[i].motionScore, source: 'motion-peak' });
    }
  }

  peaks.sort((a, b) => b.score - a.score);
  const selected = peaks.slice(0, needed);

  if (selected.length < needed) {
    const fillCount = needed - selected.length;
    const interval = duration / (fillCount + 1);
    for (let i = 1; i <= fillCount; i++) {
      const t = interval * i;
      if (t > 0.5 && t < duration - 0.5 && !selected.some(s => Math.abs(s.time - t) < 1.0)) {
        selected.push({ time: t, score: 0.3, source: 'even-fill' });
      }
    }
  }

  return selected.sort((a, b) => a.time - b.time);
}

/** Per-second motion energy via low-res frame differencing. */
function computeMotionScores(filePath, sampleFps = 4) {
  return new Promise((resolve, reject) => {
    const scores = [];
    let prevFrame = null;
    let frameIndex = 0;
    const width = 160, height = 90;
    const frameSize = width * height * 3;

    const proc = spawn(FFMPEG, [
      '-i', filePath,
      '-vf', `fps=${sampleFps},scale=${width}:${height}`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-v', 'quiet',
      'pipe:1',
    ], { windowsHide: true });

    let buffer = Buffer.alloc(0);

    proc.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= frameSize) {
        const frame = buffer.subarray(0, frameSize);
        buffer = buffer.subarray(frameSize);

        if (prevFrame) {
          let diff = 0;
          for (let i = 0; i < frameSize; i += 12) {
            diff += Math.abs(frame[i] - prevFrame[i]);
            diff += Math.abs(frame[i + 1] - prevFrame[i + 1]);
            diff += Math.abs(frame[i + 2] - prevFrame[i + 2]);
          }
          const maxDiff = (frameSize / 12) * 255 * 3;
          scores.push({ time: frameIndex / sampleFps, motionScore: Math.min(1, (diff / maxDiff) * 10) });
        }

        prevFrame = Buffer.from(frame);
        frameIndex++;
      }
    });

    proc.on('close', () => resolve(scores));
    proc.on('error', reject);
  });
}

/** Extract JPEG frames for VL tagging (only called when VL runs). */
async function extractFrames(filePath, outputDir, { fps = 2, maxFrames = 500, videoIndex = 0, duration = null } = {}) {
  const dur = duration ?? (await getVideoInfo(filePath)).duration;
  const totalFramesAtFps = Math.floor(dur * fps);
  const actualFps = totalFramesAtFps > maxFrames ? maxFrames / dur : fps;

  const framesDir = path.join(outputDir, `frames_v${videoIndex}`);
  await fs.mkdir(framesDir, { recursive: true });

  await new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-i', filePath,
      '-vf', `fps=${actualFps},scale=512:-2`,
      '-q:v', '4', '-f', 'image2',
      path.join(framesDir, 'frame_%05d.jpg'),
    ], { windowsHide: true });
    proc.on('close', resolve);
    proc.on('error', reject);
  });

  const files = (await fs.readdir(framesDir)).filter(f => f.endsWith('.jpg')).sort();
  return files.map((f, i) => ({ time: i / actualFps, framePath: path.join(framesDir, f), filename: f, fps: actualFps }));
}

/**
 * Segments from scene boundaries + motion, subdividing anything over 4s so
 * the alignment engine always has fine-grained material.
 */
function buildSegments(scenes, motionScores, duration) {
  const boundaries = [0, ...scenes.map(s => s.time), duration];
  const deduped = [boundaries[0]];
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i] - deduped[deduped.length - 1] > 0.2) deduped.push(boundaries[i]);
  }

  const segments = [];
  const maxSegLen = 4;

  for (let i = 0; i < deduped.length - 1; i++) {
    const start = deduped[i];
    const end = deduped[i + 1];
    const segDuration = end - start;
    const subCount = segDuration > maxSegLen ? Math.ceil(segDuration / maxSegLen) : 1;
    const subLen = segDuration / subCount;

    for (let s = 0; s < subCount; s++) {
      const subStart = start + s * subLen;
      const subEnd = start + (s + 1) * subLen;
      const segMotion = motionScores.filter(m => m.time >= subStart && m.time < subEnd);
      const avgMotion = segMotion.length ? segMotion.reduce((sum, m) => sum + m.motionScore, 0) / segMotion.length : 0;
      const peakMotion = segMotion.length ? Math.max(...segMotion.map(m => m.motionScore)) : 0;

      segments.push({
        index: segments.length,
        start: subStart,
        end: subEnd,
        duration: subEnd - subStart,
        avgMotion, peakMotion,
        score: avgMotion * 0.4 + peakMotion * 0.6,
        vlTags: [], vlDescription: '', vlRelevance: 0,
      });
    }
  }

  return segments;
}

/** Full per-video analysis (frames NOT included — see extractFrames). */
async function analyzeVideo(filePath, onProgress, { videoIndex = 0 } = {}) {
  const progress = (stage, pct) => onProgress?.({ stage, percent: pct });

  progress('probe', 0);
  const info = await getVideoInfo(filePath);

  progress('scenes', 10);
  const minSegs = Math.max(8, Math.floor(info.duration / 3));
  const scenes = await detectSceneChanges(filePath, info.duration, { minSegments: minSegs });

  progress('motion', 40);
  const motionScores = await computeMotionScores(filePath);

  progress('segments', 90);
  const segments = buildSegments(scenes, motionScores, info.duration);

  progress('done', 100);
  return { info, scenes, motionScores, segments };
}

module.exports = {
  getVideoInfo, parseFraction, detectSceneChanges, computeMotionScores,
  extractFrames, buildSegments, analyzeVideo,
};
