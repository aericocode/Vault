const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const mediaInfo = require('./media-info');
const proc = require('./proc');
const ownedDir = require('./owned-dir');

/**
 * Calculate how many frames to extract based on duration and resolution
 */
function calculateFrameParams(duration, height) {
  const intervalConfig = config.frames.intervals.find(i => duration <= i.maxDuration);
  let interval = intervalConfig?.interval || 20;

  const resConfig = config.frames.resolutionMultipliers.find(r => height <= r.maxHeight);
  const multiplier = resConfig?.multiplier || 1;
  const qualityFlag = resConfig?.flag || 'unknown';

  let frameCount = Math.ceil(duration / interval * multiplier);
  frameCount = Math.max(config.frames.minFrames, Math.min(config.frames.maxFrames, frameCount));

  const actualInterval = duration / frameCount;

  return { frameCount, interval: actualInterval, qualityFlag };
}

/**
 * Generate weighted timestamps for frame extraction
 * More frames at start and end of video
 */
function generateWeightedTimestamps(duration, frameCount) {
  const w = config.frames.weighted;

  if (!w.enabled || duration < 10) {
    // Fall back to uniform distribution for short videos or if disabled
    const timestamps = [];
    const interval = duration / (frameCount + 1);
    for (let i = 1; i <= frameCount; i++) {
      timestamps.push(interval * i);
    }
    return timestamps;
  }

  const startEnd = duration * w.startPercent;      // Start region duration
  const endStart = duration * (1 - w.endPercent);  // End region start time
  const middleDuration = duration - startEnd - (duration * w.endPercent);

  // Calculate weighted frame distribution
  const totalWeight = (w.startPercent * w.startWeight) +
                      ((1 - w.startPercent - w.endPercent) * w.middleWeight) +
                      (w.endPercent * w.endWeight);

  const startFrames = Math.max(1, Math.round(frameCount * (w.startPercent * w.startWeight) / totalWeight));
  const endFrames = Math.max(1, Math.round(frameCount * (w.endPercent * w.endWeight) / totalWeight));
  const middleFrames = Math.max(1, frameCount - startFrames - endFrames);

  const timestamps = [];

  // Start region frames (0 to startEnd)
  if (startFrames > 0 && startEnd > 0) {
    const startInterval = startEnd / (startFrames + 1);
    for (let i = 1; i <= startFrames; i++) {
      timestamps.push(startInterval * i);
    }
  }

  // Middle region frames (startEnd to endStart)
  if (middleFrames > 0 && middleDuration > 0) {
    const middleInterval = middleDuration / (middleFrames + 1);
    for (let i = 1; i <= middleFrames; i++) {
      timestamps.push(startEnd + (middleInterval * i));
    }
  }

  // End region frames (endStart to duration)
  if (endFrames > 0) {
    const endDuration = duration - endStart;
    const endInterval = endDuration / (endFrames + 1);
    for (let i = 1; i <= endFrames; i++) {
      timestamps.push(endStart + (endInterval * i));
    }
  }

  // Sort and ensure we don't exceed duration
  return timestamps
    .sort((a, b) => a - b)
    .filter(t => t > 0 && t < duration);
}

/**
 * Run ffmpeg asynchronously (no shell — args passed directly).
 * Filter strings keep their ffmpeg-level quoting (e.g. scale='min(600,iw)':-1),
 * which the ffmpeg filtergraph parser handles itself.
 */
function runFfmpeg(args) {
  return proc.run('ffmpeg', args);
}

/**
 * Calculate simple hash of image file for deduplication
 */
function hashFrame(framePath) {
  const data = fs.readFileSync(framePath);
  return crypto.createHash('md5').update(data).digest('hex');
}

/**
 * Deduplicate frames by removing very similar ones
 * Uses file size + hash comparison
 */
function deduplicateFrames(frames) {
  if (!config.performance.deduplicateFrames || frames.length <= 3) {
    return frames;
  }

  const seen = new Map();
  const unique = [];

  for (const frame of frames) {
    const stats = fs.statSync(frame);
    const sizeKey = Math.round(stats.size / 1000); // Round to nearest KB

    // Quick size-based filter
    const similarSizes = [...seen.entries()].filter(([k]) =>
      Math.abs(k - sizeKey) <= 2 // Within 2KB
    );

    if (similarSizes.length > 0) {
      // Check hash for similar-sized frames
      const hash = hashFrame(frame);
      const isDupe = similarSizes.some(([, hashes]) => hashes.includes(hash));

      if (isDupe) {
        continue; // Skip duplicate
      }

      // Add hash to existing size bucket
      if (seen.has(sizeKey)) {
        seen.get(sizeKey).push(hash);
      } else {
        seen.set(sizeKey, [hash]);
      }
    } else {
      seen.set(sizeKey, [hashFrame(frame)]);
    }

    unique.push(frame);
  }

  return unique;
}

/**
 * Extract frames from an image file
 */
async function extractFromImage(filepath, tempDir, height) {
  const outPath = path.join(tempDir, 'frame_001.jpg');
  const maxWidth = config.frames.maxWidth;
  const quality = config.frames.jpegQuality;

  await runFfmpeg([
    '-y', '-i', filepath, '-vframes', '1',
    '-vf', `scale='min(${maxWidth},iw)':-1`,
    '-q:v', String(quality), outPath
  ]);

  const resConfig = config.frames.resolutionMultipliers.find(r => height <= r.maxHeight);
  return {
    frames: [outPath],
    qualityFlag: resConfig?.flag || 'unknown'
  };
}

/**
 * Extract frames from a GIF
 */
async function extractFromGif(filepath, tempDir, height) {
  const frameCount = config.frames.gifFrames;
  const totalFrames = (await mediaInfo.getFrameCount(filepath)) || 10;
  const step = Math.max(1, Math.floor(totalFrames / frameCount));
  const maxWidth = config.frames.maxWidth;
  const quality = config.frames.jpegQuality;

  const outPattern = path.join(tempDir, 'frame_%03d.jpg');
  await runFfmpeg([
    '-y', '-i', filepath,
    '-vf', `select='not(mod(n\\,${step}))',scale='min(${maxWidth},iw)':-1`,
    '-vframes', String(frameCount), '-q:v', String(quality), outPattern
  ]);

  let extracted = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg')).sort();
  let frames = extracted.map(f => path.join(tempDir, f));

  // Deduplicate
  frames = deduplicateFrames(frames);

  const resConfig = config.frames.resolutionMultipliers.find(r => height <= r.maxHeight);

  return {
    frames,
    qualityFlag: resConfig?.flag || 'unknown'
  };
}

/**
 * Extract frames from animated WebP by first converting to GIF
 */
async function extractFromAnimatedWebp(filepath, tempDir, height) {
  const maxWidth = config.frames.maxWidth;
  const quality = config.frames.jpegQuality;
  const frameCount = config.frames.gifFrames;

  // First, convert animated WebP to GIF
  const tempGif = path.join(tempDir, 'converted.gif');

  try {
    console.log(`  Converting animated WebP to GIF...`);
    await runFfmpeg([
      '-y', '-i', filepath,
      '-vf', `scale='min(${maxWidth},iw)':-1`, tempGif
    ]);

    // Now extract frames from the converted GIF
    const totalFrames = (await mediaInfo.getFrameCount(tempGif)) || 10;
    const step = Math.max(1, Math.floor(totalFrames / frameCount));

    const outPattern = path.join(tempDir, 'frame_%03d.jpg');
    await runFfmpeg([
      '-y', '-i', tempGif,
      '-vf', `select='not(mod(n\\,${step}))'`,
      '-vframes', String(frameCount), '-q:v', String(quality), outPattern
    ]);

    // Clean up temp GIF
    try { fs.unlinkSync(tempGif); } catch {}

    let extracted = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg')).sort();
    let frames = extracted.map(f => path.join(tempDir, f));

    // Deduplicate
    frames = deduplicateFrames(frames);

    const resConfig = config.frames.resolutionMultipliers.find(r => height <= r.maxHeight);

    return {
      frames,
      qualityFlag: resConfig?.flag || 'unknown'
    };
  } catch (err) {
    console.error(`  Animated WebP conversion failed: ${err.message}`);
    // Fall back to extracting single frame
    return extractFromImage(filepath, tempDir, height);
  }
}

/**
 * Extract frames from a video file using weighted distribution.
 * Frames are extracted CONCURRENTLY (config.performance.maxFrameWorkers) —
 * previously each frame was a blocking execSync call, which serialized the
 * entire scan across all workers.
 */
async function extractFromVideo(filepath, tempDir, duration, height) {
  const { frameCount, qualityFlag } = calculateFrameParams(duration, height);
  const maxWidth = config.frames.maxWidth;
  const quality = config.frames.jpegQuality;

  // Generate weighted timestamps (more at start/end)
  const timestamps = generateWeightedTimestamps(duration, frameCount);

  const w = config.frames.weighted;
  if (w.enabled && duration >= 10) {
    const startEnd = duration * w.startPercent;
    const endStart = duration * (1 - w.endPercent);
    const startFrames = timestamps.filter(t => t <= startEnd).length;
    const endFrames = timestamps.filter(t => t >= endStart).length;
    const middleFrames = timestamps.length - startFrames - endFrames;

    console.log(`  Extracting ${timestamps.length} frames from: ${path.basename(filepath)} (weighted: ${startFrames} start, ${middleFrames} middle, ${endFrames} end)`);
  } else {
    console.log(`  Extracting ${timestamps.length} frames from: ${path.basename(filepath)} (uniform distribution)`);
  }

  // Extract frames at specific timestamps using input seeking (fast),
  // in parallel with a bounded pool
  const tasks = timestamps.map((t, i) => async () => {
    const outFile = path.join(tempDir, `frame_${String(i + 1).padStart(3, '0')}.jpg`);
    // -ss before -i = input seeking (fast, seeks to nearest keyframe)
    await runFfmpeg([
      '-y', '-ss', t.toFixed(3), '-i', filepath, '-vframes', '1',
      '-vf', `scale='min(${maxWidth},iw)':-1`,
      '-q:v', String(quality), outFile
    ]);
  });

  // runPool swallows individual failures (frames that fail to extract are skipped)
  await proc.runPool(tasks, config.performance.maxFrameWorkers);

  let extracted = fs.readdirSync(tempDir).filter(f => f.endsWith('.jpg')).sort();
  let frames = extracted.map(f => path.join(tempDir, f));

  // Deduplicate (important since keyframe seeking may produce similar frames)
  const originalCount = frames.length;
  frames = deduplicateFrames(frames);
  const dedupedCount = frames.length;

  if (originalCount !== dedupedCount) {
    console.log(`  Deduped: ${originalCount} → ${dedupedCount} frames`);
  }

  return {
    frames,
    qualityFlag,
    originalFrameCount: originalCount,
    dedupedFrameCount: dedupedCount
  };
}

/**
 * Extract frames from any media type
 */
async function extract(filepath, mediaType, duration, height) {
  // Mark the parent tempDir app-owned (so the end-of-run sweep is permitted),
  // then create the per-file scratch subdir under it.
  ownedDir.ensureManaged(config.paths.tempDir, 'temp');
  const tempDir = path.join(config.paths.tempDir, `${Date.now()}_${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    let result;

    // Check for animated WebP (treat as GIF-like)
    if (mediaType === 'image' && filepath.toLowerCase().endsWith('.webp')) {
      if (await mediaInfo.isAnimatedWebp(filepath)) {
        console.log(`  Detected animated WebP`);
        result = await extractFromAnimatedWebp(filepath, tempDir, height);
      } else {
        result = await extractFromImage(filepath, tempDir, height);
      }
    } else {
      switch (mediaType) {
        case 'image':
          result = await extractFromImage(filepath, tempDir, height);
          break;
        case 'gif':
          result = await extractFromGif(filepath, tempDir, height);
          break;
        case 'video':
        default:
          result = await extractFromVideo(filepath, tempDir, duration, height);
          break;
      }
    }

    // Always include tempDir for cleanup
    result.tempDir = tempDir;

    // Add immediate feedback for any extraction result
    if (!result.frames) {
      console.log(`  ✗ No frames extracted from: ${path.basename(filepath)}`);
    }

    return result;
  } catch (err) {
    console.log(`  ✗ Frame extraction error: ${err.message}`);
    return { frames: [], qualityFlag: 'extraction_failed', tempDir };
  }
}

/**
 * Clean up temporary frames directory
 */
function cleanup(framePathOrTempDir) {
  try {
    // Can be called with a frame path or directly with tempDir
    let dir = framePathOrTempDir;

    // If it's a file path, get the directory
    if (framePathOrTempDir && !fs.existsSync(framePathOrTempDir)) {
      // Already deleted, skip
      return;
    }

    if (framePathOrTempDir && fs.statSync(framePathOrTempDir).isFile()) {
      dir = path.dirname(framePathOrTempDir);
    }

    if (dir && fs.existsSync(dir) && dir.includes(config.paths.tempDir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    // Ignore cleanup errors
  }
}

function ensureTempDir() {
  ownedDir.ensureManaged(config.paths.tempDir, 'temp');
}

function cleanupAll() {
  try {
    if (fs.existsSync(config.paths.tempDir)) {
      // Gate the whole-dir wipe on the app-owned marker: never delete a temp dir
      // that was pointed at user data (missing marker → skip + warn).
      if (!ownedDir.guardSweep(config.paths.tempDir, 'temp-frames cleanup')) return;
      fs.rmSync(config.paths.tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    // Ignore
  }
}

module.exports = {
  extract,
  cleanup,
  ensureTempDir,
  cleanupAll,
  calculateFrameParams,
  generateWeightedTimestamps,
  deduplicateFrames,
};
