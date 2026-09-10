/**
 * PMV Studio — pipeline orchestration + job queue (replaces the sample's
 * server.js runFullPipeline/runRender, minus uploads and WebSockets).
 *
 * One pipeline runs at a time (queued like the music exporter). Progress is
 * written to the pmv_jobs row (throttled) and the client polls. Analysis
 * results come from / go to the repo caches, so repeat jobs on the same
 * sources skip to EDL + render.
 */

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn } = require('child_process');

const config = require('../../config');
const database = require('../database');
const repo = require('./repo');
const audioAnalyzer = require('./audio-analyzer');
const videoAnalyzer = require('./video-analyzer');
const vlTagger = require('./vl-tagger');
const alignment = require('./alignment');
const renderer = require('./renderer');
const gpuDetect = require('./gpu-detect');
const secureAssets = require('../secure-assets');
const ownedDir = require('../owned-dir');
const vault = require('../vault');
const { envVar } = require('../env-var');
const { ROOT } = require('../approot');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const EXPORTS_DIR = envVar('EXPORTS') || path.join(ROOT, 'exports');
// Working intermediates (extracted clips, VL frames, concat audio) are library
// content — they stage under the MANAGED temp dir so wipeTempDir clears any
// crash leftovers on the next start. (They used to live under exports/.)
const WORK_DIR = path.join(config.paths.tempDir, 'pmv_work');
const PREVIEWS_DIR = path.join(config.paths.thumbnailDir, 'pmv_previews');

/* ── Finished renders — RAM only ────────────────────────────────────────────
   The rendered MP4 exists ONLY here until the user acts: ⬇ Download streams
   it, ➕ Add to library writes it to disk (the one sanctioned write). A
   server restart or vault lock drops the buffers; the EDL persists, so
   "Re-render" regenerates in one click. Capped so 4K renders can't eat the
   machine (override with PMV_EXPORT_MAX_GB). */
const MAX_OUTPUT_BYTES = Math.max(1, Number(process.env.PMV_EXPORT_MAX_GB) || 2) * 1024 ** 3;
const MAX_KEPT_OUTPUTS = 2;
const _outputs = new Map();            // jobId -> Buffer (insertion order = age)

function _storeOutput(jobId, buf) {
  _outputs.delete(jobId);
  _outputs.set(jobId, buf);
  while (_outputs.size > MAX_KEPT_OUTPUTS) {
    _outputs.delete(_outputs.keys().next().value);
  }
}

/** RAM-held render for a job (null once dropped/expired). */
function getOutput(jobId) { return _outputs.get(jobId) || null; }

/** Availability flag the client needs: RAM buffer, or the imported/legacy file. */
function decorateJob(job) {
  if (!job) return job;
  const out = job.result?.outputPath;
  return { ...job, available: _outputs.has(job.id) || !!(out && fs.existsSync(out)) };
}

// Analysis cache versioning — bump when analyzer logic changes materially
const VIDEO_ANALYSIS_VERSION = 'v1';
const AUDIO_ANALYSIS_VERSION = 'v1';

/* ── Queue + cancel signals ─────────────────────────────────────────────── */

const _queue = [];
let _active = null;                    // jobId currently in the pipeline
const _signals = new Map();            // jobId -> { canceled }

function enqueue(jobId) {
  _queue.push(jobId);
  _pump();
}

function _pump() {
  if (_active || _queue.length === 0) return;
  const jobId = _queue.shift();
  _active = jobId;
  const signal = { canceled: false };
  _signals.set(jobId, signal);

  runFullPipeline(jobId, signal)
    .catch(err => {
      const msg = signal.canceled ? 'canceled' : (err.message || String(err));
      // Guarded: a vault lock mid-job closes the DB before this rejection
      // lands (the locking listener already marked the row).
      try {
        repo.updateJob(jobId, {
          status: signal.canceled ? 'canceled' : 'error',
          error: msg, completed_at: new Date().toISOString(),
        });
      } catch {}
      if (!signal.canceled) console.error(`[PMV] job ${jobId} failed:`, err.message);
    })
    .finally(() => {
      _signals.delete(jobId);
      _active = null;
      _pump();
    });
}

function cancelJob(jobId) {
  const idx = _queue.indexOf(jobId);
  if (idx >= 0) {
    _queue.splice(idx, 1);
    repo.updateJob(jobId, { status: 'canceled', error: 'canceled', completed_at: new Date().toISOString() });
    return true;
  }
  const signal = _signals.get(jobId);
  if (signal) {
    signal.canceled = true;
    renderer.killAll();
    return true;
  }
  return false;
}

function isActive(jobId) { return _active === jobId || _queue.includes(jobId); }

/* ── Progress (throttled DB writes) ─────────────────────────────────────── */

function makeProgress(jobId) {
  let last = 0;
  return (status, stage, percent) => {
    const now = Date.now();
    if (now - last < 400 && percent < 100) return;
    last = now;
    repo.updateJob(jobId, { status, stage, progress: Math.round(percent * 10) / 10 });
  };
}

function checkCanceled(signal) {
  if (signal?.canceled) throw new Error('canceled');
}

/* ── Library-metadata relevance floor (spec §6.4) ───────────────────────── */

function libraryMetadataFloor(mediaRow, criteria) {
  if (!criteria || !mediaRow) return 0;
  const words = criteria.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  if (!words.length) return 0;
  const hay = [
    mediaRow.description || '',
    mediaRow.tags || '',
    mediaRow.themes || '',
    mediaRow.media_elements || '',
  ].join(' ').toLowerCase();
  const hits = words.filter(w => hay.includes(w)).length;
  return hits >= Math.max(1, Math.ceil(words.length / 2)) ? 6 : 0;
}

/* ── Cached analysis helpers ────────────────────────────────────────────── */

function videoParamsHash(row) {
  return `${VIDEO_ANALYSIS_VERSION}:${row.filesize_bytes || 0}`;
}

async function analyzedVideo(row, onStage, signal) {
  const hash = videoParamsHash(row);
  const cached = repo.getVideoAnalysis(row.id, hash);
  if (cached) {
    onStage?.('cached');
    return { segments: cached.segments, duration: cached.duration, width: cached.width, height: cached.height };
  }
  checkCanceled(signal);
  const va = await videoAnalyzer.analyzeVideo(row.filepath, p => onStage?.(p.stage), {});
  repo.putVideoAnalysis(row.id, hash, {
    segments: va.segments, duration: va.info.duration, width: va.info.width, height: va.info.height,
  });
  return { segments: va.segments, duration: va.info.duration, width: va.info.width, height: va.info.height };
}

async function analyzedAudio(row, onStage, signal) {
  const hash = `${AUDIO_ANALYSIS_VERSION}:${row.filesize_bytes || 0}`;
  const cached = repo.getAudioAnalysis(row.id, hash);
  if (cached) {
    onStage?.('cached');
    return cached;
  }
  checkCanceled(signal);
  const analysis = await audioAnalyzer.analyzeAudio(row.filepath, p => onStage?.(p.stage));
  repo.putAudioAnalysis(row.id, hash, analysis);
  return analysis;
}

/* ── Preview stills (one JPEG per EDL entry) ────────────────────────────── */

async function extractPreviews(jobId, edlEntries, signal) {
  // Vault mode: previews are content derived from source media and must NOT
  // persist in plaintext under thumbnailDir. ffmpeg still needs a real file, so
  // render into the (wiped) temp dir, fold the bytes into secure_assets.db, and
  // unlink — same pattern as lib/thumbnails.js. The pmv_previews subdir is never
  // even created. Non-vault: byte-for-byte the old on-disk behavior.
  const vault = secureAssets.enabled();
  const dir = vault ? config.paths.tempDir : path.join(PREVIEWS_DIR, jobId);
  await fsp.mkdir(dir, { recursive: true });
  // Mark the managed ROOT (tempDir in vault mode, thumbnailDir — parent of
  // pmv_previews — otherwise) so its later sweeps stay permitted.
  ownedDir.ensureManaged(vault ? config.paths.tempDir : config.paths.thumbnailDir,
    vault ? 'temp' : 'thumbs');
  const BATCH = 6;
  const CAP = 300;

  const entries = edlEntries.slice(0, CAP);
  for (let i = 0; i < entries.length; i += BATCH) {
    checkCanceled(signal);
    await Promise.all(entries.slice(i, i + BATCH).map((entry, j) => {
      const idx = i + j;
      const name = `p_${String(idx).padStart(4, '0')}.jpg`;
      // Vault mode renders to a unique throwaway temp path (jobId+idx keeps
      // concurrent batch items from colliding); non-vault writes the cache file.
      const out = vault ? path.join(dir, `pmvprev_${jobId}_${name}`) : path.join(dir, name);
      const url = `/api/pmv/previews/${jobId}/${name}`;
      return new Promise(resolve => {
        const proc = spawn(FFMPEG, [
          '-ss', String(entry.sourceIn + Math.min(0.2, entry.duration / 2)),
          '-i', entry.videoPath,
          '-frames:v', '1', '-vf', 'scale=192:-2', '-q:v', '5',
          '-y', out,
        ], { windowsHide: true });
        proc.on('close', code => {
          if (code === 0) {
            if (vault) {
              try {
                secureAssets.putPmvPreview(jobId, idx, fs.readFileSync(out));
                entry.preview = url;
              } catch { /* leave preview unset on read/store failure */ }
              try { fs.unlinkSync(out); } catch {}
            } else {
              entry.preview = url;
            }
          } else if (vault) {
            try { fs.unlinkSync(out); } catch {}
          }
          resolve();
        });
        proc.on('error', () => {
          if (vault) { try { fs.unlinkSync(out); } catch {} }
          resolve();
        });
      });
    }));
  }
}

/* ── Full pipeline ──────────────────────────────────────────────────────── */

async function runFullPipeline(jobId, signal) {
  const job = repo.getJob(jobId);
  if (!job) return;
  const progress = makeProgress(jobId);
  const options = job.options || {};
  const criteria = (options.userCriteria || '').trim() || null;

  ownedDir.ensureManaged(config.paths.tempDir, 'temp');
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const videoRows = job.video_ids.map(id => database.getById(id)).filter(Boolean);
  const audioRows = job.audio_ids.map(id => database.getById(id)).filter(Boolean);
  if (!videoRows.length) throw new Error('no valid source videos');
  if (!audioRows.length) throw new Error('no valid soundtrack');

  /* 1. Soundtrack: concat if multiple (user-ordered), then analyze (cached
     only for single tracks — concatenations are one-offs) */
  progress('analyzing', 'Preparing soundtrack', 2);
  let audioPath = audioRows[0].filepath;
  let audioAnalysis;
  if (audioRows.length > 1) {
    audioPath = await renderer.concatenateAudio(audioRows.map(r => r.filepath), path.join(jobDir, 'combined_audio.m4a'));
    checkCanceled(signal);
    progress('analyzing', 'Analyzing soundtrack (beats)', 5);
    audioAnalysis = await audioAnalyzer.analyzeAudio(audioPath, p => progress('analyzing', `Soundtrack: ${p.stage}`, 5 + p.percent * 0.08));
  } else {
    progress('analyzing', 'Analyzing soundtrack (beats)', 5);
    audioAnalysis = await analyzedAudio(audioRows[0], s => progress('analyzing', `Soundtrack: ${s}`, 8), signal);
  }
  checkCanceled(signal);

  /* 2. Video analysis (cache-aware) */
  const allSegments = [];
  const videoInfos = [];
  const perVidPct = 35 / videoRows.length;
  for (let i = 0; i < videoRows.length; i++) {
    const row = videoRows[i];
    const base = 15 + i * perVidPct;
    progress('analyzing', `Video ${i + 1}/${videoRows.length}: analyzing`, base);
    const va = await analyzedVideo(row, s => progress('analyzing', `Video ${i + 1}/${videoRows.length}: ${s}`, base + perVidPct * 0.8), signal);
    const segs = va.segments.map(s => ({ ...s, sourceVideo: i, videoPath: row.filepath }));
    // Re-index globally (cache stores per-video indices)
    segs.forEach((s, k) => { s.index = allSegments.length + k; });
    allSegments.push(...segs);
    videoInfos.push({ index: i, media_id: row.id, path: row.filepath, duration: va.duration, width: va.width, height: va.height });
    checkCanceled(signal);
  }

  /* 3. Optional VL tagging (library-metadata floor first — spec §6.4) */
  const useVL = !!(criteria && options.enableVL !== false) || options.enableVL === true;
  if (useVL) {
    const vlStatus = await vlTagger.checkVLAvailability(options.vlConfig || {});
    if (vlStatus.available) {
      const budget = Math.max(20, Math.min(1000, Number(options.aiFrameBudget) || 200));
      const perVideoBudget = Math.ceil(budget / videoRows.length);
      let taggedTotal = 0;

      for (let i = 0; i < videoRows.length; i++) {
        checkCanceled(signal);
        const row = videoRows[i];
        const floor = libraryMetadataFloor(row, criteria);
        const vidSegs = allSegments.filter(s => s.sourceVideo === i);

        progress('analyzing', `AI frames: video ${i + 1}/${videoRows.length}`, 52 + (i / videoRows.length) * 8);
        const frames = await videoAnalyzer.extractFrames(row.filepath, jobDir, {
          fps: Number(options.scanFps) || 2, maxFrames: perVideoBudget, videoIndex: i,
          duration: videoInfos[i].duration,
        });
        const tagged = await vlTagger.tagFrames(frames, criteria, options.vlConfig || {}, p => {
          progress('analyzing', `AI frames: V${i + 1} ${p.current}/${p.total}`, 52 + ((i + p.percent / 100) / videoRows.length) * 8);
        });
        taggedTotal += tagged.length;
        vlTagger.applyTagsToSegments(vidSegs, tagged, { relevanceFloor: floor });
      }
      progress('analyzing', `AI tagging done (${taggedTotal} frames)`, 60);
    } else {
      progress('analyzing', `AI skipped: ${vlStatus.error}`, 60);
    }
  } else if (criteria) {
    // VL off but criteria given: floor from library metadata alone
    for (let i = 0; i < videoRows.length; i++) {
      const floor = libraryMetadataFloor(videoRows[i], criteria);
      if (floor > 0) {
        for (const s of allSegments) {
          if (s.sourceVideo === i) s.vlRelevance = Math.max(s.vlRelevance || 0, floor);
        }
      }
    }
  }

  /* 4. EDL */
  checkCanceled(signal);
  progress('analyzing', 'Aligning cuts to beats', 62);
  const seed = options.seed ?? Math.floor(Math.random() * 1e9);
  const edlRaw = alignment.createEDL(audioAnalysis, allSegments, {
    targetDuration: audioAnalysis.duration,
    minClipDuration: Number(options.minClipDuration) || 0.3,
    maxClipDuration: Number(options.maxClipDuration) || 4,
    cutOnBeats: options.cutOnBeats !== false,
    preferHighAction: options.preferHighAction !== false,
    orderMode: options.orderMode === 'sequential' ? 'sequential' : 'shuffle',
    userFilter: criteria,
    relevanceThreshold: Number(options.relevanceThreshold) || 6,
    seed,
  }, videoInfos);

  if (options.layout === 'triptych') alignment.attachCenterSources(edlRaw, allSegments, seed);

  const edl = alignment.enrichEDL(edlRaw, {
    transitions: options.transitions !== false,
    colorEffects: options.colorEffects === true,
    speedRamping: options.speedRamping === true,
  });

  /* 5. Previews, then EDL is reviewable while the render continues */
  progress('analyzing', 'Extracting previews', 64);
  await extractPreviews(jobId, edl.edl, signal);

  repo.updateJob(jobId, {
    edl: {
      entries: edl.edl, seed, bpm: audioAnalysis.bpm, totalBeats: audioAnalysis.totalBeats,
      duration: audioAnalysis.duration, coverage: edl.coverage,
      uniqueSegments: edl.uniqueSegments, totalSegments: edl.totalSegments,
      videoInfos: videoInfos.map(v => ({ index: v.index, media_id: v.media_id, duration: v.duration })),
    },
    status: 'edl_ready', stage: 'Edit ready, rendering', progress: 66,
  });

  /* 6. Auto-render (user can re-render after edits) */
  await runRender(jobId, signal, { audioPath });
}

/* ── Render (initial + re-render) ───────────────────────────────────────── */

async function runRender(jobId, signal = null, { audioPath = null } = {}) {
  const job = repo.getJob(jobId);
  if (!job?.edl?.entries?.length) throw new Error('EDL not ready');
  const options = job.options || {};
  const progress = makeProgress(jobId);

  ownedDir.ensureManaged(config.paths.tempDir, 'temp');
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Re-render path: reconstruct the soundtrack source
  if (!audioPath) {
    const audioRows = job.audio_ids.map(id => database.getById(id)).filter(Boolean);
    if (!audioRows.length) throw new Error('soundtrack no longer in library');
    audioPath = audioRows.length > 1
      ? await renderer.concatenateAudio(audioRows.map(r => r.filepath), path.join(jobDir, 'combined_audio.m4a'))
      : audioRows[0].filepath;
  }

  const gpu = await gpuDetect.detectGPU();
  const enc = gpuDetect.getEncoderConfig(gpu, options.quality || 'medium');

  progress('rendering', `Rendering (${gpu.label})`, 68);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const filename = `pmv_${stamp}_${job.edl.seed}.mp4`;

  // Final MP4 comes back as a Buffer — nothing lands on disk until the user
  // downloads it or adds it to the library (importToLibrary writes the file).
  const result = await renderer.renderEDL(
    { edl: job.edl.entries },
    audioPath, { workDir: jobDir, maxBytes: MAX_OUTPUT_BYTES },
    {
      resolution: options.resolution || '1920:1080',
      layout: options.layout === 'triptych' ? 'triptych' : 'standard',
      encoderConfig: enc,
    },
    p => progress('rendering', p.detail || p.stage, 68 + (p.percent / 100) * 30),
    signal
  );

  _storeOutput(jobId, result.buffer);
  repo.updateJob(jobId, {
    status: 'complete', stage: 'done', progress: 100,
    completed_at: new Date().toISOString(),
    result: {
      // no outputPath: the fresh render lives in RAM only. A previous
      // import's library file stays a library file via its media row.
      filename,
      fileSize: result.fileSize,
      clips: result.clips,
      bpm: job.edl.bpm,
      duration: job.edl.duration,
      encoder: enc.codec,
      imported_media_id: job.result?.imported_media_id || null,
    },
  });

  // Working clips are cleaned by the renderer; drop the job work dir
  await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
}

/** Re-render request from the client (EDL possibly edited). Queued. */
function enqueueRender(jobId) {
  const signal = { canceled: false };
  _signals.set(jobId, signal);
  repo.updateJob(jobId, { status: 'rendering', stage: 'queued for render', error: null });
  runRender(jobId, signal)
    .catch(err => {
      // Guarded: a vault lock closes the DB before this rejection lands
      try {
        repo.updateJob(jobId, {
          status: signal.canceled ? 'canceled' : 'error',
          error: err.message, completed_at: new Date().toISOString(),
        });
      } catch {}
    })
    .finally(() => _signals.delete(jobId));
}

/* ── Library import (manual Add) ────────────────────────────────────────── */

function importToLibrary(jobId) {
  const job = repo.getJob(jobId);
  if (!job?.result) return { error: 'output not ready' };
  if (job.result.imported_media_id && database.getById(job.result.imported_media_id)) {
    return { media_id: job.result.imported_media_id, already: true };
  }

  // "Add to library" is the ONE moment a render legitimately lands on disk —
  // an explicit user action, like ⬇ Download. Legacy pre-memory jobs already
  // have their file; fresh renders write it from the RAM buffer now.
  let out = job.result.outputPath;
  if (!out || !fs.existsSync(out)) {
    const buf = _outputs.get(jobId);
    if (!buf) return { error: 'render expired (held in memory only). Re-render, then add it' };
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    out = path.join(EXPORTS_DIR, job.result.filename || `pmv_${jobId}.mp4`);
    fs.writeFileSync(out, buf);
  }

  database.insertStubs([{ path: out, name: path.basename(out), mediaType: 'video' }]);
  const row = database.get().prepare('SELECT id FROM media WHERE filepath = ?').get(out);
  if (!row) return { error: 'library insert failed' };

  _outputs.delete(jobId);   // the library file owns the bytes now
  repo.updateJob(jobId, { result: { ...job.result, outputPath: out, imported_media_id: row.id } });
  return { media_id: row.id };
}

/* ── Cleanup ────────────────────────────────────────────────────────────── */

async function deleteJobArtifacts(jobId) {
  // Guard against traversal: jobId is interpolated into fs paths below. The
  // route validates too, but reject here as well so no caller can slip a
  // crafted id (e.g. ../..) into fsp.rm.
  if (!repo.isValidJobId(jobId)) throw new Error('invalid job id');
  const job = repo.getJob(jobId);
  if (!job) return; // nothing to clean up for an unknown job
  _outputs.delete(jobId);
  await fsp.rm(path.join(PREVIEWS_DIR, jobId), { recursive: true, force: true }).catch(() => {});
  try { secureAssets.deletePmvPreviews(jobId); } catch { /* store disabled — nothing to drop */ }
  await fsp.rm(path.join(WORK_DIR, jobId), { recursive: true, force: true }).catch(() => {});
  // A legacy on-disk render is deleted ONLY if it was never imported into the
  // library (fresh renders have no file — dropping the buffer was the delete)
  const out = job?.result?.outputPath;
  if (out && !job.result.imported_media_id) {
    await fsp.unlink(out).catch(() => {});
  }
  repo.deleteJob(jobId);
}

// Vault lock = the session key is gone: cancel every live pipeline/render,
// drop queued jobs and finished RAM renders. Rows are marked while 'locking'
// still has the DB handle open (mirrors lib/musicid/exporter.js).
vault.onChange((e) => {
  if (e !== 'locking') return;
  const mark = (id) => {
    try {
      repo.updateJob(id, { status: 'canceled', error: 'interrupted (vault locked)', completed_at: new Date().toISOString() });
    } catch {}
  };
  for (const id of _queue.splice(0)) mark(id);
  for (const [id, sig] of _signals) { sig.canceled = true; mark(id); }
  renderer.killAll();
  _outputs.clear();
});

module.exports = {
  enqueue, cancelJob, isActive, enqueueRender, importToLibrary, deleteJobArtifacts,
  extractPreviews, getOutput, decorateJob,
  PREVIEWS_DIR, EXPORTS_DIR,
};
