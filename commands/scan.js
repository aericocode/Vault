const fs = require('fs');
const config = require('../config');
const db = require('../lib/database');
const dupes = require('../lib/dupes');
const scanner = require('../lib/file-scanner');
const mediaInfo = require('../lib/media-info');
const frameExtractor = require('../lib/frame-extractor');
const visionApi = require('../lib/vision-api');
const modelHealth = require('../lib/model-health');
const operations = require('../lib/operations');
const { WorkQueue, ProgressTracker } = require('../lib/work-queue');

// Lazy load modules
let processors = null;
let videoTranscriber = null;

function getProcessors() {
  if (!processors) {
    processors = require('../lib/processors');
  }
  return processors;
}

function getVideoTranscriber() {
  if (!videoTranscriber) {
    videoTranscriber = require('../lib/video-transcriber');
  }
  return videoTranscriber;
}

/**
 * If this file matches an already-analyzed row (normalized name + size ±1%,
 * ≥10MB), clone that row's analysis + notes, link both into a dupe group,
 * and skip AI processing entirely.
 * @returns {object|null} scan result if skipped as dupe, else null
 */
function tryDupeSkip(filepath, filename, mediaType, startTime) {
  let stat;
  try {
    stat = fs.statSync(filepath);
  } catch {
    return null;
  }
  if (stat.size < config.dupes.minSizeBytes) return null;

  const key = dupes.nameKey(filename);
  const match = db.findDupeCandidate(key, mediaType, stat.size);
  if (!match || match.filepath === filepath) return null;

  // Clone the match's analysis (parse stored JSON back into arrays)
  const parse = (s, fb) => { try { return JSON.parse(s) || fb; } catch { return fb; } };
  const tags = parse(match.tags, []);
  if (!tags.includes('dupe')) tags.push('dupe');

  db.saveMedia({
    filepath,
    filename,
    mediaType: match.media_type,
    duration: match.duration_seconds,
    width: match.width,
    height: match.height,
    filesize: stat.size,
    language: match.language,
    themes: parse(match.themes, []),
    locations: parse(match.locations, []),
    qualityFlag: match.quality_flag,
    description: match.description,
    tags,
    contentType: match.content_type,
    mediaElements: parse(match.media_elements, []),
    transcribedText: parse(match.transcribed_text, []),
    audioTranscription: match.audio_transcription,
    framesAnalyzed: 0,
    model: `dupe-of-${match.id}`,
    error: null,
  });

  // Link both rows into a shared dupe group + share notes
  const newId = db.getMediaId(filepath);
  const groupId = match.dupe_group || Math.min(match.id, newId);
  db.setDupeGroup([match.id, newId], groupId);
  if (match.user_notes && match.user_notes !== '[]') {
    db.setGroupNotes(groupId, match.user_notes);
  }

  // Same content → same vector; copy instead of re-embedding
  if (config.embeddings.enabled && match.embedding) {
    require('../lib/embeddings').copyEmbedding(match.id, newId);
  }

  return {
    success: true,
    filename,
    analysis: { content_type: match.content_type, language: match.language },
    elapsed: Date.now() - startTime,
    frames: 0,
    transcribed: false,
    dupeOf: match.filename,
  };
}

/** Render the thumbnail for a freshly saved row. Never fatal to a scan. */
async function ensureThumbFor(filepath) {
  try {
    const row = db.getByPath(filepath);
    if (row) await require('../lib/thumbnails').ensureThumbnail(row);
  } catch { /* a missing thumbnail is cosmetic; the scan still succeeded */ }
}

/**
 * Process a single file using the appropriate processor.
 *
 * This is now the ONLY processing path — the old legacy processFile()
 * duplicated ~130 lines of this logic for the default (video/image/gif)
 * scan and was the reason --all-types silently dropped transcription:
 * only the legacy path honored options.transcribeVideo.
 */
async function processFile(file, options = {}) {
  const { path: filepath, name: filename, mediaType } = file;
  const startTime = Date.now();

  // Check processing status
  const status = db.getProcessingStatus(filepath);

  if (status === 'success' && !options.reprocess) {
    return { skipped: true, reason: 'already_processed', filename };
  }

  if (status === 'vision_error' && !options.retryErrors) {
    return { skipped: true, reason: 'vision_error', filename };
  }

  if (status === 'other_error' && !options.reprocess) {
    return { skipped: true, reason: 'other_error', filename };
  }

  // Duplicate short-circuit: a file ≥10MB whose normalized name + size (±1%)
  // match an already-analyzed row is the same content 99.9% of the time —
  // copy its analysis instead of burning GPU time re-scanning it.
  if (config.dupes.enabled && status === 'new') {
    const dupeResult = tryDupeSkip(filepath, filename, mediaType, startTime);
    if (dupeResult) {
      await ensureThumbFor(filepath);
      return dupeResult;
    }
  }

  // Get processor for this file type
  const proc = getProcessors();
  const processor = proc.getProcessor(filepath);

  if (!processor) {
    return { error: 'No processor for file type', filename };
  }

  let content = null;
  try {
    // Process using the appropriate processor (options carried through —
    // this is what enables transcription under --all-types)
    const result = await processor.process(filepath, options);
    content = result.content;

    if (!result.success) {
      // The model went away mid-scan (unloaded, endpoint down, sidecar died) —
      // this file was never actually given a chance. Report it up WITHOUT
      // stamping processing_error on the row: marking it 'vision_error' would
      // make a later rescan skip it unless the user remembers --retry-errors.
      // The caller (lib/import-queue.js) halts the queue and requeues the file.
      if (result.modelUnavailable) {
        return {
          error: result.modelReason || result.error || 'Model unavailable',
          modelUnavailable: true,
          needsModelChoice: !!result.needsModelChoice,
          filename,
        };
      }
      db.saveMedia({
        filepath,
        filename,
        mediaType: result.metadata?.mediaType || mediaType,
        duration: result.metadata?.duration,
        width: result.metadata?.width,
        height: result.metadata?.height,
        filesize: result.metadata?.filesize,
        streamInfo: result.metadata?.streamInfo,
        error: result.error || 'Processing failed'
      });
      return { error: result.error || 'Processing failed', filename };
    }

    const analysis = result.analysis;
    const metadata = result.metadata;

    // Audio transcription comes from the audio processor's analysis
    // (analysis.transcription) or the video processor's content
    // (content.transcription when --transcribe-video is set)
    const audioTranscription = analysis.transcription || content?.transcription || null;

    // Save to database
    db.saveMedia({
      filepath,
      filename,
      mediaType: metadata.mediaType || mediaType,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      filesize: metadata.filesize,
      streamInfo: metadata.streamInfo,
      language: analysis.language,
      themes: analysis.themes,
      locations: analysis.locations,
      qualityFlag: content?.qualityFlag,
      description: analysis.description,
      tags: analysis.tags,
      contentType: analysis.content_type,
      mediaElements: analysis.media_elements || analysis.video_elements || {
        // Store document-specific stats here
        char_count: analysis.char_count,
        word_count: analysis.word_count,
        line_count: analysis.line_count,
        document_type: analysis.document_type,
        sentiment: analysis.sentiment,
        // 3D model stats
        triangles: analysis.triangles,
        vertices: analysis.vertices,
        format: analysis.format,
      },
      transcribedText: analysis.transcribed_text,
      audioTranscription,
      framesAnalyzed: content?.frames?.length || 0,
      model: 'lm-studio',
      error: null
    });

    // Build the thumbnail here rather than leave it to the first grid that
    // shows the file: the viewer's /thumb route never runs ffmpeg, so a file
    // that is scanned but not thumbnailed shows a placeholder until a
    // background job catches up. Cheap next to the AI pass we just ran.
    await ensureThumbFor(filepath);

    // Generate move operation (if applicable)
    const mediaId = db.getMediaId(filepath);
    if (mediaType !== 'document') {
      operations.createMoveOperation(mediaId, filepath, analysis, content?.qualityFlag);
    }

    // Embed the fresh metadata for semantic search (non-fatal on failure —
    // `node vault.js embed` backfills anything missed)
    if (config.embeddings.enabled) {
      await require('../lib/embeddings').embedOne(mediaId);
    }

    const elapsed = Date.now() - startTime;
    return {
      success: true,
      filename,
      analysis,
      elapsed,
      frames: content?.frames?.length || 0,
      deduped: content?.dedupedFrameCount,
      transcribed: !!audioTranscription,
      processorType: processor.constructor.type,
    };
  } finally {
    // Cleanup
    if (processor && content) {
      await processor.cleanup(content);
    }
  }
}

/**
 * Main parallel scan command
 */
async function run(args) {
  const dirPath = args[0];

  if (!dirPath) {
    console.error('Usage: vault scan <directory> [options]');
    console.error('');
    console.error('Options:');
    console.error('  -r, --recursive      Scan subdirectories');
    console.error('  --reprocess          Reprocess all files (including successful ones)');
    console.error('  --retry-errors       Retry files with Vision API errors');
    console.error('  -w, --workers N      Number of parallel workers');
    console.error('  --all-types          Process all supported file types (documents, audio)');
    console.error('  --type TYPE          Only process specific type (video, document, audio)');
    console.error('  --transcribe-video   Extract and transcribe audio from videos (requires faster-whisper)');
    console.error('  --fingerprint-audio  Also fingerprint audio files for Music ID (needs fpcalc; runs alongside the scan)');
    process.exit(1);
  }

  if (!scanner.isDirectory(dirPath)) {
    console.error(`Directory not found: ${dirPath}`);
    process.exit(1);
  }

  const recursive = args.includes('--recursive') || args.includes('-r');
  const reprocess = args.includes('--reprocess');
  const retryErrors = args.includes('--retry-errors');
  const allTypes = args.includes('--all-types');
  const transcribeVideo = args.includes('--transcribe-video');
  const fingerprintAudio = args.includes('--fingerprint-audio');
  const generateSubtitles = args.includes('--subtitles') || config.subtitles.onScan;

  // Parse --type flag
  const typeIdx = args.findIndex(a => a === '--type');
  const specificType = typeIdx >= 0 && args[typeIdx + 1] ? args[typeIdx + 1] : null;

  // Parse --workers flag
  const workersIdx = args.findIndex(a => a === '--workers' || a === '-w');

  // Check dependencies
  if (!mediaInfo.isAvailable()) {
    console.error('ffprobe not found. Please install ffmpeg.');
    process.exit(1);
  }

  // Check endpoints
  console.log('Checking LM Studio endpoints...');
  const endpoints = await visionApi.checkEndpoints();
  const availableEndpoints = endpoints.filter(e => e.available);

  if (availableEndpoints.length === 0) {
    console.error('No LM Studio endpoints available. Make sure LM Studio is running.');
    process.exit(1);
  }

  console.log(`Available endpoints: ${availableEndpoints.length}/${endpoints.length}`);
  availableEndpoints.forEach(e => console.log(`  ✓ ${e.endpoint}`));
  endpoints.filter(e => !e.available).forEach(e => console.log(`  ✗ ${e.endpoint}`));

  // Default workers: endpoints × vision workers × pipeline depth, so frame
  // extraction (CPU) for the next file overlaps vision inference (GPU) on
  // the current one instead of leaving the GPU idle.
  const maxWorkers = workersIdx >= 0 && args[workersIdx + 1]
    ? parseInt(args[workersIdx + 1])
    : availableEndpoints.length
      * config.performance.maxVisionWorkersPerEndpoint
      * config.performance.pipelineDepth;

  // Show registered processors if --all-types
  if (allTypes) {
    const proc = getProcessors();
    console.log(`\nRegistered processors: ${proc.getProcessorTypes().join(', ')}`);
  }

  console.log(`\nScanning: ${dirPath}`);
  console.log(`Recursive: ${recursive}`);
  console.log(`Reprocess all: ${reprocess}`);
  console.log(`Retry Vision errors: ${retryErrors}`);
  console.log(`All file types: ${allTypes}`);
  if (specificType) console.log(`Filter type: ${specificType}`);
  console.log(`Parallel workers: ${maxWorkers} (pipeline depth ${config.performance.pipelineDepth})`);
  console.log(`Frame deduplication: ${config.performance.deduplicateFrames ? 'enabled' : 'disabled'}`);

  // Check transcribe-video prerequisites (works with or without --all-types)
  let whisperUsed = false;
  if (transcribeVideo) {
    const transcriber = getVideoTranscriber();
    if (transcriber.isFasterWhisperAvailable()) {
      console.log(`Video transcription: enabled (model: ${process.env.WHISPER_MODEL || 'base'})`);
      await transcriber.startServer();
      whisperUsed = true;
    } else {
      console.log(`⚠ Video transcription: faster-whisper not found (install with: pip install faster-whisper)`);
    }
  }

  // Scan for files
  let files = scanner.scan(dirPath, recursive, { useProcessorRegistry: allTypes });

  // Filter by type if specified
  if (specificType) {
    files = files.filter(f => f.mediaType === specificType);
  }

  console.log(`Found ${files.length} files\n`);

  if (files.length === 0) return;

  // Audio files use the whisper sidecar too — flag it for shutdown
  if (allTypes || specificType === 'audio') {
    if (files.some(f => f.mediaType === 'audio')) whisperUsed = true;
  }

  // Initialize
  frameExtractor.ensureTempDir();
  db.init();

  // Register every found file in the library IMMEDIATELY (stub rows marked
  // 'unscanned') so the viewer shows them from the start — playable and
  // taggable while the AI analysis backfills below. Stubs count as 'new' on
  // any later scan, so an interrupted run picks up right where it left off.
  const stubCount = db.insertStubs(files);
  if (stubCount > 0) {
    console.log(`Registered ${stubCount} new file(s) in the library (visible in the viewer now; analysis backfills)\n`);
  }

  // Link existing dupes + merge their shared notes (idempotent; the first
  // run over a large library does the heavy lifting, later runs are cheap)
  if (config.dupes.enabled) {
    const bf = dupes.backfillDupes();
    if (bf.groups > 0 || bf.keysFilled > 0) {
      console.log(`Dupe backfill: ${bf.groups} groups, ${bf.linked} newly linked, ${bf.notesMerged} notes synced${bf.keysFilled ? `, ${bf.keysFilled} name keys filled` : ''}\n`);
    }
  }

  // Show Vision API error count if not retrying
  if (!retryErrors) {
    const visionErrorCount = db.getVisionErrorCount();
    if (visionErrorCount > 0) {
      console.log(`⚠ ${visionErrorCount} files have Vision API errors (use --retry-errors to retry)\n`);
    }
  }

  // ── Music ID: fingerprint audio ALONGSIDE the scan (opt-in) ──────────────
  // Fingerprinting is ffmpeg/fpcalc (CPU) while the audio scan is whisper/LM
  // (GPU/python), so they overlap instead of serializing. Kicked off here on
  // the freshly-inserted stub rows; awaited + matched after the scan loop.
  let musicSvc = null, fingerprintTask = null, audioIds = [];
  if (fingerprintAudio) {
    audioIds = files
      .filter(f => f.mediaType === 'audio')
      .map(f => db.getMediaId(f.path))
      .filter(Boolean);
    if (audioIds.length) {
      const { checkTools } = require('../lib/musicid/fingerprint');
      const tools = await checkTools();
      if (!tools.ok) {
        console.log(`⚠ Music ID fingerprinting skipped: ${tools.errors[0]}\n`);
      } else {
        musicSvc = require('../lib/musicid/service');
        console.log(`🎵 Fingerprinting ${audioIds.length} audio file(s) for Music ID alongside the scan…\n`);
        fingerprintTask = musicSvc.fingerprintBatch(audioIds, {
          concurrency: 2,
          autoLabel: true, // "Artist - Title.mp3" → named song reference
          onProgress: (p) => {
            if (p.error) console.log(`  🎵 ✗ ${p.filename}: ${p.error}`);
            else if (!p.skipped) console.log(`  🎵 ${p.filename}: ${p.chunks} chunks${p.skippedSilent ? ` (${p.skippedSilent} silent skipped)` : ''}${p.labeled ? ` → 📛 ${p.labeled.artist} – ${p.labeled.title}` : ''}`);
            else if (p.labeled) console.log(`  🎵 ${p.filename}: already fingerprinted → 📛 ${p.labeled.artist} – ${p.labeled.title}`);
          },
        }).catch(e => ({ error: e.message, stats: null, readyIds: [] }));
      }
    }
  }

  const progress = new ProgressTracker(files.length);
  const queue = new WorkQueue(maxWorkers);

  let processed = 0, skipped = 0, skippedVisionErrors = 0, errors = 0;
  let transcribedCount = 0, dupeCount = 0, notAttempted = 0;
  const byType = {};

  // Abort-on-dead-model. The GUI queue pauses and waits for a person; a CLI has
  // nobody to ask, so the equivalent is to stop and exit non-zero. Marching the
  // rest of the run into a dead endpoint is the one thing that must not happen —
  // it burns through thousands of files in seconds, "failing" every one.
  //
  // Tasks already handed to the WorkQueue can't be un-queued, so they check this
  // on the way in and return immediately. Files in flight when the model died
  // still finish (or fail) normally; nothing is force-killed.
  let aborted = null;               // { reason, filename }
  const abortNow = (reason, filename) => {
    if (aborted) return;            // first worker to notice owns the message
    aborted = { reason: String(reason || 'Model unavailable'), filename };
    console.error(`\n${'='.repeat(60)}`);
    console.error(`⚠ SCAN ABORTED: the AI model is unavailable`);
    console.error(`${'='.repeat(60)}`);
    console.error(`  ${aborted.reason}`);
    if (filename) console.error(`  Stopped at: ${filename}`);
    console.error(`  Files already running will finish; nothing else will start.\n`);
  };

  // Soft theme-vocabulary grounding: snapshot the library's existing themes
  // ONCE and feed them to every scan prompt, so new scans reuse established
  // themes instead of drifting (see config/prompts.js). Best-effort.
  let themeVocab = [];
  try { themeVocab = db.distinctCleanThemes(60); } catch {}

  // Process files in parallel
  const promises = files.map(file =>
    queue.add(async () => {
      if (aborted) { notAttempted++; return { abortSkipped: true, filename: file.name }; }

      let result;
      try {
        result = await processFile(file, { reprocess, retryErrors, transcribeVideo, themeVocab });
      } catch (err) {
        // processFile has no catch of its own, and a throw here would otherwise
        // be swallowed by allSettled and never reach the summary.
        if (modelHealth.isModelUnavailable(err)) {
          notAttempted++;        // interrupted, not failed — same remedy as the rest
          abortNow(err.modelReason || modelHealth.describe(err), file.name);
          return { modelUnavailable: true, filename: file.name };
        }
        errors++;
        console.log(`✗ ${file.name}: ${err.message}`);
        progress.tick(5000);
        return { error: err.message, filename: file.name };
      }

      // Not a file failure — the model went away. Left uncounted and unmarked in
      // the DB (see processFile), so re-running the same command picks these up.
      if (result.modelUnavailable) {
        // Counted here so the summary adds up to the file count: this one was
        // interrupted rather than skipped, but it needs the same re-run.
        notAttempted++;
        abortNow(result.error, result.filename);
        return result;
      }

      if (result.skipped) {
        skipped++;
        if (result.reason === 'vision_error') {
          skippedVisionErrors++;
        }
      } else if (result.error) {
        errors++;
        console.log(`✗ ${result.filename}: ${result.error}`);
      } else {
        processed++;
        byType[file.mediaType] = (byType[file.mediaType] || 0) + 1;
        if (result.transcribed) transcribedCount++;
        if (result.dupeOf) dupeCount++;

        const frameInfo = result.frames ? ` | ${result.frames} frames` : '';
        const transcribeInfo = result.transcribed ? ' | +audio' : '';
        const dupeInfo = result.dupeOf ? ` | ⧉ dupe of ${result.dupeOf}` : '';
        console.log(`✓ ${result.filename} | ${result.analysis.content_type || file.mediaType} | ${result.analysis.language}${frameInfo}${transcribeInfo}${dupeInfo} | ${(result.elapsed/1000).toFixed(1)}s`);
      }

      progress.tick(result.elapsed || 5000);

      // Print progress every 10 files
      if ((processed + skipped + errors) % 10 === 0) {
        console.log(`\n${progress.toString()}\n`);
      }

      return result;
    }, file.path)
  );

  // Wait for all to complete
  await Promise.allSettled(promises);

  console.log(`\n${'='.repeat(60)}`);
  console.log(aborted ? `ABORTED (model unavailable)` : `COMPLETE`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Processed: ${processed}`);
  if (Object.keys(byType).length > 1) {
    for (const [type, count] of Object.entries(byType)) {
      console.log(`  - ${type}: ${count}`);
    }
  }
  if (transcribedCount > 0) {
    console.log(`Files with audio transcription: ${transcribedCount}`);
  }
  if (dupeCount > 0) {
    console.log(`Duplicates detected (analysis reused, no AI scan): ${dupeCount}`);
  }
  console.log(`Skipped: ${skipped}${skippedVisionErrors > 0 ? ` (${skippedVisionErrors} with Vision API errors)` : ''}`);
  console.log(`Errors: ${errors}`);
  if (aborted) console.log(`Not attempted: ${notAttempted} (scan aborted)`);
  console.log(`Total time: ${progress.elapsed}`);

  if (aborted) {
    // The whole point of aborting: none of this was recorded as a failure, so
    // the same command resumes rather than needing --retry-errors.
    console.error(`\n⚠ ${aborted.reason}`);
    console.error(`  ${notAttempted} file(s) were never attempted and are NOT marked as failed.`);
    console.error(`  Load the model, then run the same command again to carry on.`);
    process.exitCode = 1;
  } else if (skippedVisionErrors > 0 && !retryErrors) {
    console.log(`\n⚠ Use --retry-errors to retry the ${skippedVisionErrors} files with Vision API errors`);
  }

  // Print endpoint stats
  console.log(`\nEndpoint statistics:`);
  visionApi.getStats().forEach(s => {
    console.log(`  ${s.endpoint}: ${s.requests} requests, ${s.errors} errors, avg ${s.avgTime}ms`);
  });

  // Post-passes are skipped on an abort: subtitles drive the same sidecar stack
  // that just died, and matching a half-scanned batch is work the resumed run
  // will redo anyway.
  if (aborted && (fingerprintTask || generateSubtitles)) {
    console.error(`  Skipped the post-scan pass${fingerprintTask && generateSubtitles ? 'es' : ''}` +
      ` (${[fingerprintTask && 'Music ID', generateSubtitles && 'subtitles'].filter(Boolean).join(', ')}). Re-run to finish them.`);
  }

  // ── Music ID: finish fingerprinting, then match (references + cross-media)
  if (fingerprintTask && !aborted) {
    console.log(`\n🎵 Finishing audio fingerprinting…`);
    const fp = await fingerprintTask;
    if (fp.error) {
      console.log(`⚠ Audio fingerprinting error: ${fp.error}`);
    } else {
      console.log(`🎵 Fingerprinted ${fp.stats.fingerprinted}${fp.stats.labeled ? `, ${fp.stats.labeled} named from filename` : ''}${fp.stats.failed ? `, ${fp.stats.failed} failed` : ''}${fp.stats.skipped ? `, ${fp.stats.skipped} already done` : ''}. Matching songs…`);
      const { matched } = musicSvc.scanBatch(fp.readyIds, {
        onMatch: ({ id, found }) => {
          const row = db.getById(id);
          console.log(`  🎵 ${row?.filename}: ${found.map(f => `${f.artist} – ${f.title}`).join('; ')}`);
        },
      });
      console.log(`🎵 ${matched} song link(s) created.` +
        (matched === 0 ? ' (references are stored, so videos will match these when fingerprinted)' : ''));
    }
  }

  // ── Subtitle generation post-pass (--subtitles / config.subtitles.onScan)
  // Runs after analysis so rows exist; reuses the warm whisper model.
  // Skips items that already have a track (idempotent across rescans).
  if (generateSubtitles && !aborted) {
    const subsService = require('../lib/subtitles/service');
    const subsRepo = require('../lib/subtitles/repo');
    const candidates = files
      .map(f => db.getByPath(f.path))
      .filter(row => row && ['video', 'audio'].includes(row.media_type))
      .filter(row => !row.subtitle_no_speech)   // known silent / no-audio — don't reload the model to re-fail
      .filter(row => subsRepo.listTracks(row.id).length === 0);

    if (candidates.length) {
      console.log(`\n📝 Generating subtitles for ${candidates.length} file(s)…`);
      for (const row of candidates) {
        try {
          const res = await subsService.generateForMedia(row, {
            translate: config.subtitles.translateOnScan,
            onProgress: (stage) => process.stdout.write(`\r  ${row.filename}: ${stage}          `),
          });
          console.log(`\r  ✓ ${row.filename}: ${res.noSpeech ? 'no speech detected' : res.language + (res.tracks.includes('en') && res.language !== 'en' ? ' + en' : '')}          `);
        } catch (err) {
          console.log(`\r  ✗ ${row.filename}: ${err.message}          `);
        }
      }
    }
  }

  // Cleanup — shut the whisper sidecar down too, otherwise its piped child
  // process keeps the Node event loop alive and the scan never exits
  frameExtractor.cleanupAll();
  if (whisperUsed || generateSubtitles) {
    getVideoTranscriber().cleanupAll();
    require('../lib/subtitles/translator').shutdownSidecar();
  }
  db.close();
}

module.exports = { run, processFile, processFileUnified: processFile };
