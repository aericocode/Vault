/**
 * PMV Studio — FFmpeg render pipeline (CJS port of the sample's renderer).
 * Per-clip extraction → optional triptych → concat (chunked xfade) → mux audio.
 *
 * Port fixes vs. the sample (spec §6.2):
 *  - clip extraction runs 4-parallel (the original was serial ffmpeg spawns)
 *  - xfade concatenation is CHUNKED (batches of ~40 inputs, then the batches
 *    are hard-concatenated) — the original chained every clip into one
 *    filter_complex, which blows up arg length/memory around 200 clips
 *  - cancellation: pass a `signal` ({ canceled: bool }) — checked between
 *    clips; live ffmpeg children are tracked and killed
 *
 * PRIVACY MODEL: the FINAL render never touches disk — the last concat pass
 * writes fragmented MP4 to stdout and renderEDL returns the Buffer (the
 * service holds it in RAM until the user downloads or imports it). Working
 * clips are transient by nature; the caller stages them under the managed
 * temp dir so a crash leaves nothing outside wipeTempDir's reach.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs/promises');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const XFADE_CHUNK = 40;
const CLIP_PARALLEL = 4;

/* ── Process tracking (cancel support) ──────────────────────────────────── */

const _children = new Set();

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    _children.add(proc);
    let stderr = '';
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      _children.delete(proc);
      if (code === 0) resolve(stderr);
      else reject(new Error(`FFmpeg exited with code ${code}:\n${stderr.slice(-800)}`));
    });
    proc.on('error', (e) => { _children.delete(proc); reject(e); });
  });
}

/** runFFmpeg, but the output is stdout → Buffer (RAM-capped, kill on excess). */
function runFFmpegCapture(args, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    _children.add(proc);
    const chunks = [];
    let total = 0;
    let overCap = false;
    proc.stdout.on('data', (d) => {
      total += d.length;
      if (total > maxBytes) {
        if (!overCap) { overCap = true; try { proc.kill('SIGKILL'); } catch {} }
        return;
      }
      chunks.push(d);
    });
    let stderr = '';
    proc.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      _children.delete(proc);
      if (overCap) {
        reject(new Error(`render exceeded the ${(maxBytes / 1024 ** 3).toFixed(1)} GB in-memory cap. Lower the resolution/quality or use a shorter soundtrack`));
      } else if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`FFmpeg exited with code ${code}:\n${stderr.slice(-800)}`));
      }
    });
    proc.on('error', (e) => { _children.delete(proc); reject(e); });
  });
}

/** Kill every live ffmpeg child (job cancel). */
function killAll() {
  for (const proc of _children) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  _children.clear();
}

function checkCanceled(signal) {
  if (signal?.canceled) throw new Error('canceled');
}

/* ── Audio prep ─────────────────────────────────────────────────────────── */

/** Strip cover art / re-encode the soundtrack to clean AAC. */
async function prepareCleanAudio(audioPath, workDir) {
  const cleanPath = path.join(workDir, 'audio_clean.m4a');
  await runFFmpeg(['-i', audioPath, '-vn', '-c:a', 'aac', '-b:a', '192k', '-y', cleanPath]);
  return cleanPath;
}

/** Concatenate multiple soundtrack files into one (user-ordered). */
async function concatenateAudio(audioPaths, outputPath) {
  if (audioPaths.length === 1) return audioPaths[0];
  const listPath = outputPath + '.audiolist.txt';
  const content = audioPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, content);
  await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'aac', '-b:a', '192k', '-vn', '-y', outputPath]);
  await fs.unlink(listPath).catch(() => {});
  return outputPath;
}

/* ── Main render ────────────────────────────────────────────────────────── */

async function renderEDL(edlData, audioPath, target, options = {}, onProgress, signal = null) {
  const {
    resolution = '1920:1080',
    fps = 30,
    layout = 'standard',
    encoderConfig = null,
  } = options;
  // target: { workDir, maxBytes } — intermediates go under workDir (caller
  // stages it in the managed temp dir); the final pass returns a Buffer.
  const { workDir, maxBytes = Infinity } = target;

  const clipCodec = encoderConfig?.codec || 'libx264';
  const clipFastArgs = encoderConfig?.fastArgs || ['-crf', '26', '-preset', 'ultrafast'];
  const finalArgs = encoderConfig?.qualityArgs || ['-crf', '20', '-preset', 'medium'];

  const edl = edlData.edl;
  const clipsDir = path.join(workDir, 'clips');
  await fs.mkdir(clipsDir, { recursive: true });

  onProgress?.({ stage: 'preparing audio', percent: 0 });
  const cleanAudioPath = await prepareCleanAudio(audioPath, workDir);

  /* Phase 1: extract clips (parallel batches) */
  onProgress?.({ stage: 'extracting clips', percent: 2 });
  const clipPaths = new Array(edl.length).fill(null);
  let doneClips = 0;

  async function extractClip(i) {
    checkCanceled(signal);
    const entry = edl[i];
    const clipPath = path.join(clipsDir, `clip_${String(i).padStart(4, '0')}.mp4`);
    const videoSource = entry.videoPath;
    if (!videoSource) return;

    const filterParts = [
      `scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:-1:-1:color=black`,
    ];
    const colorEffect = entry.effects?.find(e => e.type === 'color');
    if (colorEffect?.filter) filterParts.push(colorEffect.filter);
    const speedEffect = entry.effects?.find(e => e.type === 'speed');
    if (speedEffect) filterParts.push(`setpts=${(1 / speedEffect.value).toFixed(3)}*PTS`);

    const baseArgs = (codec, encArgs) => [
      '-ss', String(entry.sourceIn),
      '-i', videoSource,
      '-t', String(entry.duration),
      '-vf', filterParts.join(','),
      '-r', String(fps),
      '-c:v', codec, ...encArgs,
      '-an', '-y', clipPath,
    ];

    try {
      await runFFmpeg(baseArgs(clipCodec, clipFastArgs));
      clipPaths[i] = clipPath;
    } catch (err) {
      if (signal?.canceled) throw err;
      if (clipCodec !== 'libx264') {
        // GPU encode can fail per-clip — CPU fallback
        try {
          await runFFmpeg(baseArgs('libx264', ['-crf', '26', '-preset', 'ultrafast']));
          clipPaths[i] = clipPath;
        } catch (err2) {
          console.warn(`[PMV] clip ${i} failed (CPU fallback too): ${err2.message.slice(-200)}`);
        }
      } else {
        console.warn(`[PMV] clip ${i} failed: ${err.message.slice(-200)}`);
      }
    }

    doneClips++;
    onProgress?.({ stage: 'extracting clips', percent: 2 + Math.round((doneClips / edl.length) * 48), detail: `Clip ${doneClips}/${edl.length}` });
  }

  for (let i = 0; i < edl.length; i += CLIP_PARALLEL) {
    checkCanceled(signal);
    const batch = [];
    for (let j = i; j < Math.min(i + CLIP_PARALLEL, edl.length); j++) batch.push(extractClip(j));
    await Promise.all(batch);
  }

  // Preserve EDL alignment for triptych, then compact
  const orderedEntries = edl.filter((_, i) => clipPaths[i]);
  const orderedClips = clipPaths.filter(Boolean);
  if (orderedClips.length === 0) throw new Error('No clips were successfully extracted.');

  /* Phase 2: triptych layout */
  let finalClips = orderedClips;
  if (layout === 'triptych') {
    finalClips = [];
    for (let i = 0; i < orderedClips.length; i++) {
      checkCanceled(signal);
      const entry = orderedEntries[i];
      const centerVideo = entry.centerVideoPath || entry.videoPath;
      const centerIn = entry.centerSourceIn ?? entry.sourceIn;
      const centerClipPath = path.join(clipsDir, `center_${String(i).padStart(4, '0')}.mp4`);
      const triPath = path.join(clipsDir, `tri_${String(i).padStart(4, '0')}.mp4`);

      try {
        await runFFmpeg([
          '-ss', String(centerIn), '-i', centerVideo,
          '-t', String(entry.duration),
          '-vf', `scale=${resolution}:force_original_aspect_ratio=decrease,pad=${resolution}:-1:-1:color=black`,
          '-r', String(fps), '-c:v', clipCodec, ...clipFastArgs,
          '-an', '-y', centerClipPath,
        ]);
        await applyTriptychLayout(orderedClips[i], centerClipPath, triPath, resolution, clipCodec, clipFastArgs);
        finalClips.push(triPath);
      } catch (err) {
        if (signal?.canceled) throw err;
        try {
          await applyTriptychLayoutSingle(orderedClips[i], triPath, resolution, clipCodec, clipFastArgs);
          finalClips.push(triPath);
        } catch {
          finalClips.push(orderedClips[i]);
        }
      }

      onProgress?.({ stage: 'triptych layout', percent: 50 + Math.round((i / orderedClips.length) * 18), detail: `Panel ${i + 1}/${orderedClips.length}` });
    }
  }

  /* Phase 3: concatenate + audio (final pass streams to a Buffer) */
  checkCanceled(signal);
  onProgress?.({ stage: 'concatenating', percent: 70, detail: `Joining ${finalClips.length} clips…` });

  let buffer;
  const hasXfades = orderedEntries.some(e => e.transition?.type === 'xfade');
  if (hasXfades && finalClips.length > 1) {
    buffer = await concatenateWithTransitionsChunked(finalClips, orderedEntries, { maxBytes }, cleanAudioPath, {
      codec: clipCodec, fastArgs: clipFastArgs, encoderArgs: finalArgs, fps, workDir: clipsDir,
    }, onProgress, signal);
  } else {
    buffer = await concatenateSimple(finalClips, { maxBytes }, cleanAudioPath,
      { codec: clipCodec, encoderArgs: finalArgs, workDir: clipsDir });
  }

  /* Phase 4: cleanup */
  onProgress?.({ stage: 'cleanup', percent: 96 });
  await fs.rm(clipsDir, { recursive: true, force: true });
  if (cleanAudioPath !== audioPath) await fs.unlink(cleanAudioPath).catch(() => {});

  onProgress?.({ stage: 'done', percent: 100 });
  return { buffer, fileSize: buffer.length, clips: finalClips.length };
}

/* ── Concat variants ────────────────────────────────────────────────────── */

/**
 * `out` is a file path for intermediate (chunk) writes, or { maxBytes } for
 * the final pass — which then streams fragmented MP4 to stdout and resolves
 * the Buffer instead of touching disk.
 */
async function concatenateSimple(clipPaths, out, cleanAudioPath, opts) {
  const toBuffer = typeof out !== 'string';
  const listPath = path.join(opts.workDir, `concat_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`);
  const listContent = clipPaths.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, listContent);

  const args = [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-i', cleanAudioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', opts.codec, ...(opts.encoderArgs || []),
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
  ];
  try {
    if (toBuffer) {
      // stdout isn't seekable → fragmented MP4 instead of +faststart
      args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
      return await runFFmpegCapture(args, out.maxBytes);
    }
    args.push('-movflags', '+faststart', '-y', out);
    await runFFmpeg(args);
    return null;
  } finally {
    await fs.unlink(listPath).catch(() => {});
  }
}

/**
 * Chunked xfade: xfade-chain each batch of ≤XFADE_CHUNK clips into an
 * intermediate, then hard-concat the intermediates with the audio. Batch
 * boundaries land on hard cuts, which beat-aligned EDLs are full of anyway.
 */
async function concatenateWithTransitionsChunked(clipPaths, edl, out, cleanAudioPath, opts, onProgress, signal) {
  if (clipPaths.length <= XFADE_CHUNK) {
    return concatenateWithTransitions(clipPaths, edl, out, cleanAudioPath, opts);
  }

  const chunkOutputs = [];
  for (let start = 0; start < clipPaths.length; start += XFADE_CHUNK) {
    checkCanceled(signal);
    const clipChunk = clipPaths.slice(start, start + XFADE_CHUNK);
    const edlChunk = edl.slice(start, start + XFADE_CHUNK);
    const chunkPath = path.join(opts.workDir, `xchunk_${String(chunkOutputs.length).padStart(3, '0')}.mp4`);

    if (clipChunk.length === 1) {
      chunkOutputs.push(clipChunk[0]);
    } else {
      await concatenateWithTransitions(clipChunk, edlChunk, chunkPath, null, { ...opts, encoderArgs: opts.fastArgs });
      chunkOutputs.push(chunkPath);
    }
    onProgress?.({ stage: 'concatenating', percent: 70 + Math.round((start / clipPaths.length) * 20), detail: `Transition batch ${chunkOutputs.length}` });
  }

  return concatenateSimple(chunkOutputs, out, cleanAudioPath, opts);
}

/**
 * Single filter_complex xfade chain. cleanAudioPath null → video-only out.
 * `out`: file path (chunk intermediates) or { maxBytes } (final → Buffer).
 */
async function concatenateWithTransitions(clipPaths, edl, out, cleanAudioPath, opts) {
  const toBuffer = typeof out !== 'string';
  const inputArgs = clipPaths.flatMap(p => ['-i', p]);

  let filterGraph = '';
  let lastLabel = '[0:v]';
  let offsetAccum = 0;

  for (let i = 1; i < clipPaths.length; i++) {
    const entry = edl[i];
    const transType = entry?.transition?.effect || 'fade';
    const transDur = Math.min(entry?.transition?.duration || 0.3, (edl[i - 1]?.duration || 1) * 0.4);

    offsetAccum += (edl[i - 1]?.duration || 1) - transDur;
    if (offsetAccum < 0) offsetAccum = 0;

    const outLabel = i === clipPaths.length - 1 ? '[vout]' : `[v${i}]`;
    filterGraph += `${lastLabel}[${i}:v]xfade=transition=${transType}:duration=${transDur.toFixed(3)}:offset=${offsetAccum.toFixed(3)}${outLabel};`;
    lastLabel = outLabel;
  }
  filterGraph = filterGraph.replace(/;$/, '');

  const args = [...inputArgs];
  if (cleanAudioPath) args.push('-i', cleanAudioPath);
  args.push('-filter_complex', filterGraph, '-map', '[vout]');
  if (cleanAudioPath) args.push('-map', `${clipPaths.length}:a:0`, '-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push('-c:v', opts.codec, ...(opts.encoderArgs || []), '-r', String(opts.fps));
  if (toBuffer) {
    args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    return runFFmpegCapture(args, out.maxBytes);
  }
  args.push('-movflags', '+faststart', '-y', out);
  await runFFmpeg(args);
  return null;
}

/* ── Triptych layouts (verbatim ports) ──────────────────────────────────── */

async function applyTriptychLayout(sideInput, centerInput, outputPath, resolution, codec, encArgs = []) {
  const [w, h] = resolution.split(':').map(Number);
  const panelW = Math.floor(w / 3);

  const filter = [
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black,split=2[side1][side2];`,
    `[1:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:-1:-1:color=black[cscaled];`,
    `[side1]crop=${panelW}:${h}:(iw-${panelW})/2:0[left];`,
    `[cscaled]crop=${panelW}:${h}:(iw-${panelW})/2:0[center];`,
    `[side2]crop=${panelW}:${h}:(iw-${panelW})/2:0,hflip[right];`,
    `[left][center][right]hstack=inputs=3`,
  ].join('');

  await runFFmpeg([
    '-i', sideInput, '-i', centerInput,
    '-filter_complex', filter,
    '-c:v', codec, ...encArgs,
    '-an', '-shortest', '-y', outputPath,
  ]);
}

async function applyTriptychLayoutSingle(inputPath, outputPath, resolution, codec, encArgs = []) {
  const [w, h] = resolution.split(':').map(Number);
  const panelW = Math.floor(w / 3);

  const filter = [
    `[0:v]split=3[a][b][c];`,
    `[a]crop=${panelW}:${h}:(iw-${panelW})/2:0[left];`,
    `[b]crop=${panelW}:${h}:(iw-${panelW})/2:0[center];`,
    `[c]crop=${panelW}:${h}:(iw-${panelW})/2:0,hflip[right];`,
    `[left][center][right]hstack=inputs=3`,
  ].join('');

  await runFFmpeg([
    '-i', inputPath, '-vf', filter,
    '-c:v', codec, ...encArgs,
    '-an', '-y', outputPath,
  ]);
}

module.exports = { renderEDL, concatenateAudio, killAll, runFFmpeg };
