/**
 * Subtitles — generation pipeline + job queue (SUBTITLES_SPEC §4/§5).
 *
 * Pipeline per media item:
 *   extract audio → whisper (large-v3-turbo, word timestamps, full length)
 *   → cue shaping → original-language VTT
 *   → if non-English: OPUS-MT segment translation → English VTT
 *   → diarization (sherpa-onnx on CPU, launched in PARALLEL with the GPU
 *     whisper pass) → per-word speaker assignment → both VTTs rewritten with
 *     <v Speaker N> tags (skipped for monologues / on any diarizer failure)
 *   → full plain transcript into media.audio_transcription
 *
 * One Whisper job at a time (GPU-heavy), DB-backed, client polls. The model
 * stays warm for a short idle window after a job so bursts are cheap; both
 * sidecars shut down after the idle timeout.
 *
 * generateForMedia() is the core — the server queue AND the scan path
 * (--subtitles) both call it.
 */

const path = require('path');
const database = require('../database');
const config = require('../../config');
const transcriber = require('../video-transcriber');
const generator = require('./generator');
const translator = require('./translator');
const diarizer = require('./diarizer');
const repo = require('./repo');

// Resilient to an older/partial config missing the subtitles block
const SUBS = config.subtitles || {};
const WHISPER_MODEL = process.env.WHISPER_MODEL || SUBS.model || 'large-v3-turbo';

// Once loaded, the whisper model STAYS loaded (loading costs ~15s of GPU spin
// every time; VRAM is ~1.5 GB at int8). Low-VRAM boxes can opt back into
// unload-after-idle with WHISPER_IDLE_MINUTES=N (0 = keep warm forever).
const IDLE_SHUTDOWN_MS = (SUBS.idleUnloadMinutes ?? 5) * 60 * 1000;

/* ── Queue ──────────────────────────────────────────────────────────────── */

const _queue = [];
let _active = null;
let _idleTimer = null;

function _scheduleIdleShutdown() {
  clearTimeout(_idleTimer);
  if (!(IDLE_SHUTDOWN_MS > 0)) return;   // default: sidecars stay warm
  _idleTimer = setTimeout(() => {
    if (!_active && _queue.length === 0) {
      transcriber.shutdownServer();
      translator.shutdownSidecar();
      diarizer.shutdownSidecar();
    }
  }, IDLE_SHUTDOWN_MS);
}

// Per-job options (forced language). In-memory is enough: a restart fails
// queued jobs anyway (repo.failStaleJobs), so nothing durable is lost.
const _jobOpts = new Map();

/** Queue subtitle generation for a media id. Returns the job row.
 *  opts.language forces the spoken language (skips whisper auto-detect). */
function enqueue(media_id, opts = {}) {
  const existing = repo.activeJobFor(media_id);
  if (existing) return existing;              // already queued/running — reuse
  const job = repo.createJob(media_id);
  if (opts.language) _jobOpts.set(job.id, { language: opts.language });
  _queue.push(job.id);
  _pump();
  return job;
}

function _pump() {
  if (_active || _queue.length === 0) return;
  const jobId = _queue.shift();
  _active = jobId;
  clearTimeout(_idleTimer);

  _runJob(jobId)
    .catch(err => {
      repo.updateJob(jobId, {
        status: 'error', error: err.message || String(err),
        completed_at: new Date().toISOString(),
      });
      console.error(`[Subtitles] job ${jobId} failed:`, err.stack || err.message);
    })
    .finally(() => {
      _jobOpts.delete(jobId);
      _active = null;
      _scheduleIdleShutdown();
      _pump();
    });
}

function isActive(media_id) {
  return !!repo.activeJobFor(media_id);
}

async function _runJob(jobId) {
  const job = repo.getJob(jobId);
  if (!job) return;
  const row = database.getById(job.media_id);
  if (!row) throw new Error('media not found');

  const progress = (status, stage, pct) =>
    repo.updateJob(jobId, { status, stage, progress: Math.round(pct * 10) / 10 });

  await generateForMedia(row, {
    onProgress: (stage, pct, phase) => progress(phase || 'transcribing', stage, pct),
    // One-shot advisories (e.g. "no model to download — AI fallback"): stored
    // on the job row; the player's growth poll surfaces them as a toast.
    onNotice: (notice) => repo.updateJob(jobId, { notice }),
    language: _jobOpts.get(jobId)?.language || null,
  });

  repo.updateJob(jobId, {
    status: 'done', stage: 'done', progress: 100,
    completed_at: new Date().toISOString(),
  });
}

/* ── Core pipeline (queue + scan both call this) ────────────────────────── */

/**
 * Generate subtitle tracks for a media row.
 * @param {object} row - media row (id, filepath, media_type)
 * @param {object} opts - { onProgress(stage, pct, phase), translate,
 *   language: force the spoken language (whisper skips auto-detect — for clips
 *   whose opening misleads the detector, e.g. Japanese read as English) }
 * @returns {Promise<{language, tracks: string[]}>}
 */
async function generateForMedia(row, { onProgress = () => {}, onNotice = () => {}, translate = true, language = null } = {}) {
  if (!['video', 'audio'].includes(row.media_type)) {
    throw new Error(`subtitles need audio/video (got ${row.media_type})`);
  }
  if (!(await transcriber.hasAudioStream(row.filepath))) {
    // No audio stream at all — nothing to transcribe. Flag it and finish
    // cleanly (like the no-speech case) so the scan post-pass skips it next
    // time instead of re-probing, and no red error surfaces.
    _markNoSpeech(row.id);
    onProgress('No audio stream', 100, 'done');
    return { language: null, tracks: [], noSpeech: true };
  }

  /* 1. Extract full-length audio (16k mono wav — whisper's preferred diet) */
  onProgress('Extracting audio', 4, 'transcribing');
  const fs = require('fs');
  transcriber.ensureTempDir();
  const workDir = fs.mkdtempSync(path.join(transcriber.TEMP_AUDIO_DIR, 'subs_'));

  try {
    const audioPath = await transcriber.extractAudio(row.filepath, workDir, 0);
    if (!audioPath) throw new Error('audio extraction failed');

    /* 2. Speaker diarization starts NOW, in parallel with transcription: it's
       CPU-bound (sherpa-onnx) while whisper holds the GPU, so it finishes in
       the transcription's shadow. Best-effort — on failure the job proceeds
       with plain (voiceless) cues. */
    let speakerWait = false;   // true during the post-translation tail, when only the diarizer is left
    let diarPct = 0;           // sidecar chunk progress (sherpa backend, ~2% steps)
    const diarPromise = (SUBS.diarize !== false)
      ? diarizer.diarize(audioPath, {
          onProgress: (m) => console.log(`[Subtitles] ${m}`),
          onPct: (pct) => { diarPct = pct; if (speakerWait) speakerWaitPill(); },
        })
          .catch(err => {
            console.warn(`[Subtitles] diarization unavailable (${String(err.message || err).slice(0, 200)}). Keeping plain cues`);
            return null;
          })
      : Promise.resolve(null);

    /* 3. STREAM the transcription: cues land in the VTT as whisper decodes them,
       so the player shows the opening lines within seconds (low TTFW) and the
       progress bar climbs by media time instead of sitting at one number. */
    let lang = 'unknown', duration = 0, willTranslate = false, cueCount = 0;
    let lastPct = 8;                                 // pill % — stage-only updates must not regress it
    let curOrigPath = null, enPath = null;           // set once the language is known (onStart)
    const allCues = [];            // for the final plain-text transcript
    const allSegments = [];        // raw segments (with word timings) for the speaker merge
    const enQueue = [];            // cues awaiting translation
    let translateChain = Promise.resolve();
    // When translating, the pill tracks the TRANSLATION position (media time of
    // the last cue written to the EN track) — not transcription, which races
    // ahead in the background. Showing whisper's position would misrepresent the
    // actual wait, which is the translation catching up.
    let translatedEndSec = 0;      // media-seconds of EN track written so far
    let xlateStartWall = 0;        // wall-clock (ms) when translation began → ETA
    let aiFallback = null;         // set once when OPUS-MT gives way to LM Studio
    const STREAM_BATCH = 6;        // small during streaming → EN cues appear promptly
    const FINAL_BATCH = 48;        // larger for the tail drain → fewer round-trips

    function updateTranslatePill() {
      const frac = duration ? Math.min(1, translatedEndSec / duration) : 0;
      lastPct = 8 + frac * 82;     // main bar (8→90%) reflects the translation fraction
      let stage = `Translating ${fmtClock(translatedEndSec)} / ${fmtClock(duration)} · ${cueCount} lines`;
      if (aiFallback) stage += ' · AI fallback';
      // ETA on long files (>30 min) once there's enough signal to extrapolate.
      // Robust in both regimes: if translation keeps pace with transcription the
      // rate IS the transcription rate; if it lags, it's the translation rate.
      if (duration > 30 * 60 && xlateStartWall && translatedEndSec > 30) {
        const elapsed = (Date.now() - xlateStartWall) / 1000;
        const remaining = elapsed * (duration - translatedEndSec) / translatedEndSec;
        if (remaining > 3) stage += ` · ~${fmtEta(remaining)} left`;
      }
      onProgress(stage, lastPct, 'translating');
    }

    // Pill for the tail wait: the tracks are complete and viewable — the only
    // work left is the CPU speaker pass, which started with the job but scans
    // the whole file and can outlast the GPU passes by minutes on long media.
    // Live % from the diarizer sidecar maps onto the bar's 92→96 stretch.
    function speakerWaitPill() {
      onProgress(
        `Subtitles ready. Identifying speakers${diarPct ? ` (${Math.min(100, diarPct)}%)` : '…'}`,
        92 + (Math.min(100, diarPct) / 100) * 4,
        willTranslate ? 'translating' : 'transcribing');
    }

    const drainTranslation = (final = false) => {
      translateChain = translateChain.then(async () => {
        const min = final ? 1 : STREAM_BATCH;
        const take = final ? FINAL_BATCH : STREAM_BATCH;
        while (enQueue.length >= min) {
          const batch = enQueue.splice(0, take);
          if (!batch.length) break;
          const texts = batch.map(c => c.text.replace(/\n/g, ' '));
          let out;
          try {
            out = await translator.translateLines(texts, lang, {
              // Surface the one-time OPUS-MT model download and the AI engine's
              // per-batch progress (which otherwise sits silent through a long
              // drain); media-time progress + ETA are driven by
              // updateTranslatePill after each batch.
              onProgress: (m) => {
                if (/model/i.test(m) || m.startsWith('AI ')) onProgress(m, Math.max(lastPct, 8), 'translating');
              },
              // First fallback → its own pill flavor + a one-shot toast notice
              onFallback: (info) => {
                if (aiFallback) return;
                aiFallback = info;
                onNotice(_fallbackNotice(info, lang));
                updateTranslatePill();
              },
            });
          } catch { out = texts; }   // untranslated beats a dropped cue
          const blocks = batch.map((c, i) => generator.cueToVTTBlock({ ...c, text: out[i] || c.text }));
          fs.appendFileSync(enPath, blocks.join(''));
          const batchEnd = Math.max(...batch.map(c => c.end));
          if (batchEnd > translatedEndSec) translatedEndSec = batchEnd;
          updateTranslatePill();
        }
      });
      return translateChain;
    };

    await transcriber.transcribeSubtitlesStream(audioPath, {
      language,
      // Fires on a genuine cold load (idle-unloaded or first-ever) — a cached
      // model loads offline in a few seconds; only a never-installed model
      // switches to the download message below. Without this the pill would sit
      // at "Extracting audio" through the load looking stuck.
      onModelLoad: () => onProgress(`Loading Whisper model (${WHISPER_MODEL})…`, 6, 'transcribing'),
      onModelDownloading: () => onProgress(
        `Downloading Whisper model (${WHISPER_MODEL}), one-time, ~1.5 GB from HuggingFace…`, 6, 'transcribing'),
      // Fires as soon as the sidecar reports ready. Between here and onStart,
      // whisper front-scans the whole file (Silero VAD over the full audio,
      // plus language detect when not forced, plus first-run CUDA warmup — the
      // "~15s after the console said loaded" stretch), so the pill needs its
      // own stage or "Loading model" lingers looking stuck. A forced language
      // genuinely skips detection — the remaining wait is the speech scan.
      onModelReady: () => onProgress(
        language ? 'Scanning audio for speech…' : 'Analyzing audio (speech scan + language detection)…',
        7, 'transcribing'),
      onStart: (m) => {
        lang = m.language || 'unknown';
        duration = m.duration || 0;
        willTranslate = translate && lang !== 'en' && lang !== 'unknown';
        // registerTrack BEFORE the header write — it creates the tracks dir
        // (first-ever generation would otherwise ENOENT on a fresh install)
        curOrigPath = repo.trackPath(row.id, lang);
        repo.registerTrack(row.id, lang, 'original');
        fs.writeFileSync(curOrigPath, generator.vttHeader(lang, 'original'));
        if (willTranslate) {
          enPath = repo.trackPath(row.id, 'en');
          repo.registerTrack(row.id, 'en', 'translated');
          fs.writeFileSync(enPath, generator.vttHeader('en', 'translated'));
        }
        onProgress(
          willTranslate ? `Translating 0:00 / ${fmtClock(duration)}` : `Transcribing 0:00 / ${fmtClock(duration)}`,
          8, willTranslate ? 'translating' : 'transcribing'
        );
      },
      onSegment: (seg) => {
        allSegments.push(seg);
        // Per-segment cue shaping (word-boundary split); append immediately
        const cues = generator.shapeCues([seg]);
        if (cues.length) {
          fs.appendFileSync(curOrigPath, cues.map(generator.cueToVTTBlock).join(''));
          for (const c of cues) { allCues.push(c); cueCount++; if (willTranslate) enQueue.push(c); }
          if (willTranslate) {
            if (!xlateStartWall) xlateStartWall = Date.now();
            drainTranslation();
          }
        }
        // English source → the pill tracks transcription (it's the only work).
        // When translating, updateTranslatePill drives the pill instead, so we
        // never surface whisper racing ahead of the translation.
        if (!willTranslate) {
          const frac = duration ? Math.min(1, seg.end / duration) : 0;
          lastPct = 8 + frac * 82;
          onProgress(
            `Transcribing ${fmtClock(seg.end)} / ${fmtClock(duration)} · ${cueCount} lines`,
            lastPct, 'transcribing'
          );
        }
      },
    });

    /* No speech is a normal outcome (music-only, ambience, silence), not an
       error. Finish cleanly, dropping the header-only tracks onStart registered
       so the player doesn't offer empty subtitles. */
    if (!cueCount) {
      if (curOrigPath) repo.deleteTrack(row.id, lang);
      if (enPath) repo.deleteTrack(row.id, 'en');
      _markNoSpeech(row.id);
      if (SUBS.debug) console.log(`[Subtitles] no speech detected in media ${row.id}, nothing to subtitle`);
      onProgress('No speech detected', 100, 'done');
      return { language: lang, tracks: [], noSpeech: true };
    }

    // Real subtitles were produced — clear any stale no-speech flag from a
    // previous run (e.g. the file was re-encoded and now has speech).
    _markNoSpeech(row.id, false);

    /* 4. Drain the remaining translation backlog. The pill keeps tracking the
       translation position as it catches up (no premature jump to 94%). */
    if (willTranslate) {
      await drainTranslation(true);
      await translateChain;
    }

    /* 5. Merge speaker turns: split cues at speaker changes (word-level) and
       tag both tracks with <v Speaker N>. Skipped for monologues (assignVoices
       → null) and whenever diarization failed (turns → null). Both tracks are
       COMPLETE before this await — the old "Translated N lines · 92%" stretch
       was just this wait, unlabeled. */
    speakerWait = true;
    speakerWaitPill();
    const turns = await diarPromise;
    speakerWait = false;
    if (turns && cueCount) {
      const voiced = generator.assignVoices(allSegments, turns);
      if (voiced) {
        onProgress(`Labeling speakers · ${cueCount} lines`, 96, willTranslate ? 'translating' : 'transcribing');
        const voicedCues = generator.shapeCues(voiced);
        fs.writeFileSync(curOrigPath, generator.toVTT(voicedCues, { lang, kind: 'original' }));
        if (willTranslate && enPath) {
          _voiceTranslatedTrack(enPath, turns);
        }
        allCues.length = 0;
        allCues.push(...voicedCues);
      }
    }

    /* Persist the finished tracks into the encrypted store (vault mode) — the
       streamed working files under the temp dir are disposable from here on.
       No-op when vault mode is off. */
    repo.commitTrack(row.id, lang);
    if (willTranslate) repo.commitTrack(row.id, 'en');
    // Bound the plaintext window: drop the temp working copies now that the
    // canonical bytes are encrypted (readers re-materialize on demand).
    repo.dropWorkingCopy(row.id, lang);
    if (willTranslate) repo.dropWorkingCopy(row.id, 'en');

    /* 6. Full plain transcript → audio_transcription (search + AI chat) */
    try {
      database.get().prepare('UPDATE media SET audio_transcription = ? WHERE id = ?')
        .run(generator.toPlainText(allCues), row.id);
    } catch { /* non-fatal */ }

    /* 7. Index the English text for the library "Subtitles" search toggle */
    refreshEnglishSearchText(row.id);

    onProgress('done', 100, 'done');
    return { language: lang, tracks: willTranslate ? [lang, 'en'] : [lang] };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Voice-tag the English track IN PLACE: each streamed EN cue keeps its own
 * boundaries and text and gets the speaker with the most overlapped duration
 * (nearest turn when a cue sits in a silence gap). Names come from the same
 * speakerNamer over the same turns as the original track, so colors match.
 *
 * Deliberately NOT re-shaped to the original track's speaker splits: the old
 * approach re-translated every re-split cue — minutes of translator work (at
 * a frozen "Labeling speakers" pill) to regenerate text for cues that were
 * already on screen, and mid-sentence fragments translate worse than the
 * whole line anyway. The rare EN cue spanning a rapid exchange now shows the
 * dominant speaker's color; the original track still splits exactly.
 */
function _voiceTranslatedTrack(enPath, turns) {
  const fs = require('fs');
  let cues = [];
  try { cues = generator.parseVTT(fs.readFileSync(enPath, 'utf8')); } catch {}
  if (!cues.length) return;

  const sorted = (turns || []).filter(t => t && t.end > t.start).sort((a, b) => a.start - b.start);
  if (!sorted.length) return;
  const { name } = generator.speakerNamer(sorted);
  const speakerAt = generator.buildSpeakerAt(sorted);

  for (const c of cues) {
    const overlap = new Map();
    for (const t of sorted) {
      if (t.end <= c.start) continue;
      if (t.start >= c.end) break;
      const ov = Math.min(c.end, t.end) - Math.max(c.start, t.start);
      if (ov > 0) overlap.set(t.speaker, (overlap.get(t.speaker) || 0) + ov);
    }
    const raw = overlap.size
      ? [...overlap.entries()].sort((a, b) => b[1] - a[1])[0][0]
      : speakerAt((c.start + c.end) / 2);
    c.voice = name(raw) || null;
  }
  fs.writeFileSync(enPath, generator.toVTT(cues, { lang: 'en', kind: 'translated' }));
}

/** Human toast text for the OPUS-MT → LM Studio fallback (translator err codes). */
function _fallbackNotice(info, lang) {
  switch (info?.code) {
    case 'MODEL_UNAVAILABLE':     return `No ${lang}→en translation model available to download. Using AI fallback (LM Studio)`;
    case 'MODEL_UNREACHABLE':     return `Translation model download unreachable. Using AI fallback (LM Studio)`;
    case 'MODEL_DOWNLOAD_FAILED': return `Translation model ${lang}→en download failed. Using AI fallback (LM Studio)`;
    case 'DOWNLOADS_OFF':         return `Model downloads are off. Translating with AI fallback (LM Studio)`;
    default:                      return `OPUS-MT translator unavailable. Using AI fallback (LM Studio)`;
  }
}

function fmtClock(sec) {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Compact ETA for the translation pill ("~3 min left"). */
function fmtEta(sec) {
  if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  if (sec >= 90) return `${Math.round(sec / 60)} min`;
  return `${Math.max(1, Math.round(sec))}s`;
}

/* ── "Fix here" — re-scan a window around a timestamp ───────────────────── */

// Diarization runs on a window PADDED beyond the replaced span, so the kept
// cues on either side (which already carry global speaker tags) anchor the
// local→global speaker mapping — otherwise a window's "speaker 0" is unrelated
// to the track's "Speaker 1".
const DIAR_PATCH_PAD_S = 30;

/**
 * Re-transcribe a [at-window, at+window] slice and merge it into the existing
 * tracks (replacing whatever cues fell in that window). For gaps / bad patches.
 * Blocking — the window is small, so it's a few seconds on turbo.
 *
 * If the track is already speaker-tagged, the patched window is re-diarized too
 * and its cues get consistent <v Speaker N> tags (SUBTITLES_SPEC §4.4) — so a
 * fix keeps the speaker colors instead of dropping back to a single voice.
 */
async function patchWindow(row, atSec, windowSec = 60) {
  const fs = require('fs');
  const tracks = repo.listTracks(row.id);
  const original = tracks.find(t => t.kind === 'original');
  if (!original) throw new Error('generate subtitles first');
  const lang = original.lang;
  const enTrack = tracks.find(t => t.lang === 'en' && t.kind === 'translated');

  // Materialize the working VTT from the encrypted store (vault mode) so the
  // by-path merges below operate on a real file.
  repo.materializeTrack(row.id, lang);
  if (enTrack) repo.materializeTrack(row.id, 'en');
  let origCues = [];
  try { origCues = generator.parseVTT(fs.readFileSync(repo.trackPath(row.id, lang), 'utf8')); } catch {}
  const trackVoiced = origCues.some(c => c.voice);

  const start = Math.max(0, atSec - windowSec);
  const dur = windowSec * 2;   // whisper stops at EOF if the window runs past the end

  transcriber.ensureTempDir();
  const workDir = fs.mkdtempSync(path.join(transcriber.TEMP_AUDIO_DIR, 'patch_'));
  try {
    const audioPath = await transcriber.extractAudio(row.filepath, workDir, dur, start);
    if (!audioPath) throw new Error('audio extraction failed');

    // Force the track's language — a 1-2 min window is far too little signal
    // for auto-detect, and a patch must never come back in a different language
    // than the track it's splicing into.
    const result = await transcriber.transcribeSubtitles(
      audioPath, lang && lang !== 'unknown' ? { language: lang } : {});
    // clip timestamps are window-relative → shift segments (and words) to absolute
    const absSegs = (result.segments || []).map(s => ({
      ...s,
      start: s.start + start,
      end: s.end + start,
      words: Array.isArray(s.words)
        ? s.words.map(w => ({ ...w, start: w.start + start, end: w.end + start }))
        : s.words,
    }));

    let patchCues = generator.shapeCues(absSegs);
    if (!patchCues.length) return { patched: 0, window: [Math.round(start), Math.round(start + dur)], speakers: false };
    const end = Math.max(...patchCues.map(c => c.end));

    /* Re-diarize the padded window and re-tag, so a fix doesn't lose speaker
       colors. Best-effort: any failure keeps the plain re-transcribed cues. */
    let speakers = false;
    if (SUBS.diarize !== false) {
      try {
        const turns = await _diarizePatchWindow(row, start, end);
        if (turns && turns.length) {
          const voiced = trackVoiced
            ? await _voicePatchToTrack(row, origCues, absSegs, turns, start, end, lang)
            : generator.assignVoices(absSegs, turns);   // untagged track: fresh names, ≥2-speaker guard
          if (voiced) { patchCues = generator.shapeCues(voiced); speakers = patchCues.some(c => c.voice); }
        }
      } catch (err) {
        console.warn(`[Subtitles] patch diarization skipped (${String(err.message || err).slice(0, 160)})`);
      }
    }

    // Use the current physical path (repo.trackPath), which matches what
    // readTrackText materialized and what commitTrack re-encrypts — the stored
    // `path` column can predate a vault on/off switch and point elsewhere.
    _mergePatch(repo.trackPath(row.id, lang), patchCues, start, end, lang, 'original');
    repo.commitTrack(row.id, lang);   // vault: re-encrypt the patched track

    if (enTrack && lang !== 'en') {
      const texts = patchCues.map(c => c.text.replace(/\n/g, ' '));
      let tr;
      try { tr = await translator.translateLines(texts, lang, {}); } catch { tr = texts; }
      // spread keeps each cue's `voice`, so the EN track inherits the tags too
      const enPatch = patchCues.map((c, i) => ({ ...c, text: tr[i] || c.text }));
      _mergePatch(repo.trackPath(row.id, 'en'), enPatch, start, end, 'en', 'translated');
      repo.commitTrack(row.id, 'en');
    }

    // English track text moved → refresh the search index (covers en-original
    // clips too, where the original track itself is what got patched)
    refreshEnglishSearchText(row.id);

    return { patched: patchCues.length, window: [Math.round(start), Math.round(end)], speakers };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    // Drop plaintext working copies materialized for the merge (vault mode).
    try { repo.dropWorkingCopy(row.id, lang); if (enTrack) repo.dropWorkingCopy(row.id, 'en'); } catch {}
  }
}

/** Diarize a clip [clipStart, clipStart+clipDur] of a file; turns shifted to
 *  absolute time. clipDur ≤ 0 means "to EOF". */
async function _diarizeClip(row, clipStart, clipDur) {
  const fs = require('fs');
  transcriber.ensureTempDir();
  const dir = fs.mkdtempSync(path.join(transcriber.TEMP_AUDIO_DIR, 'diarclip_'));
  try {
    const wav = await transcriber.extractAudio(row.filepath, dir, clipDur > 0 ? clipDur : 0, clipStart);
    if (!wav) return null;
    const turns = await diarizer.diarize(wav);
    return (turns || []).map(t => ({ ...t, start: t.start + clipStart, end: t.end + clipStart }));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

/** Diarize a padded window around [start,end] (fast — a few seconds of audio). */
function _diarizePatchWindow(row, start, end) {
  const clipStart = Math.max(0, start - DIAR_PATCH_PAD_S);
  return _diarizeClip(row, clipStart, (end - clipStart) + DIAR_PATCH_PAD_S);
}

/**
 * Voice the patch segments with names consistent with the rest of the track.
 *
 * Fast path: map the window's raw diarization speakers onto the track's
 * existing "Speaker N" names via kept-cue anchors (majority global tag among
 * the kept cues that fall in each raw speaker's turns). If every window speaker
 * has an anchor, that's reliable and cheap.
 *
 * Fallback: when a window speaker has NO anchor (e.g. the fix swallowed all its
 * other cues, or a short clip), the windowed labels can't be trusted — so
 * re-diarize the whole file and name by first appearance. Diarization is
 * deterministic, so those names reproduce the ones the initial generation gave
 * the kept cues, keeping colors consistent without relabeling them.
 */
async function _voicePatchToTrack(row, origCues, absSegs, windowTurns, start, end, lang) {
  const { resolve, anchored } = _buildPatchResolver(origCues, windowTurns, start, end);
  const windowRaws = [...new Set(windowTurns.filter(t => t.end > start && t.start < end).map(t => t.speaker))];

  if (windowRaws.length && windowRaws.every(anchored)) {
    return generator.voiceSegments(absSegs, windowTurns, resolve);   // fast path — anchored
  }

  // Unanchored speaker → re-diarize the whole file for globally-stable names
  const fullTurns = await _diarizeClip(row, 0, 0).catch(() => null);
  if (fullTurns && fullTurns.length) {
    const { name } = generator.speakerNamer(fullTurns);
    return generator.voiceSegments(absSegs, fullTurns, name);
  }
  return generator.voiceSegments(absSegs, windowTurns, resolve);      // fall back to windowed labels
}

/**
 * Anchor-map builder: raw diarization speaker → the track's existing "Speaker
 * N" name, by majority vote among kept cues (outside [start,end], inside the
 * diarized span) whose midpoint falls in that raw speaker's turns. Unanchored
 * speakers mint fresh names continuing the track's numbering.
 * @returns { resolve(raw)→label, anchored(raw)→bool }
 */
function _buildPatchResolver(origCues, turns, start, end) {
  const speakerAt = generator.buildSpeakerAt(turns);
  const lo = Math.min(...turns.map(t => t.start));
  const hi = Math.max(...turns.map(t => t.end));

  const tally = new Map();   // raw → Map(globalName → count)
  let maxN = 0;
  for (const c of origCues) {
    const m = /Speaker\s+(\d+)/.exec(c.voice || '');
    if (m) maxN = Math.max(maxN, Number(m[1]));
    if (!c.voice) continue;
    const mid = (c.start + c.end) / 2;
    if (mid < lo || mid > hi) continue;           // outside the diarized span — no reliable turn
    if (c.end > start && c.start < end) continue; // inside the replaced window — being overwritten
    const raw = speakerAt(mid);
    if (raw == null) continue;
    if (!tally.has(raw)) tally.set(raw, new Map());
    const g = tally.get(raw);
    g.set(c.voice, (g.get(c.voice) || 0) + 1);
  }

  const map = new Map();
  for (const [raw, g] of tally) map.set(raw, [...g.entries()].sort((a, b) => b[1] - a[1])[0][0]);

  const minted = new Map();
  let next = maxN;
  return {
    anchored: (raw) => map.has(raw),
    resolve: (raw) => {
      if (raw == null) return null;
      if (map.has(raw)) return map.get(raw);
      if (!minted.has(raw)) minted.set(raw, `Speaker ${++next}`);
      return minted.get(raw);
    },
  };
}

/** Drop cues overlapping [start,end] in a VTT file, splice in the new ones. */
function _mergePatch(vttPath, patchCues, start, end, lang, kind) {
  const fs = require('fs');
  let existing = [];
  try { existing = generator.parseVTT(fs.readFileSync(vttPath, 'utf8')); } catch {}
  const kept = existing.filter(c => c.end <= start || c.start >= end);
  const merged = kept.concat(patchCues).sort((a, b) => a.start - b.start);
  fs.writeFileSync(vttPath, generator.toVTT(merged, { lang, kind }));
}

/* ── Searchable English subtitle text ───────────────────────────────────── */

/**
 * Recompute media.subtitle_en from the current English track on disk — the
 * translated track for foreign clips, or the original track for English ones
 * (both live under lang='en'). Powers the library's "Subtitles" search toggle,
 * which searches ONLY the English text (foreign originals stay out of search).
 * Cleared to NULL when no English track exists. Call after any change to the
 * EN track (generate, patch, edit, delete). Non-fatal on any failure.
 */
/**
 * Flag (or clear) media.subtitle_no_speech — the marker the scan post-pass uses
 * to skip files with no audio / no speech, so it never loads the whisper model
 * only to immediately fail. Non-fatal on any failure.
 */
function _markNoSpeech(media_id, value = true) {
  try {
    database.get().prepare('UPDATE media SET subtitle_no_speech = ? WHERE id = ?')
      .run(value ? 1 : 0, media_id);
  } catch { /* column may predate this migration — best-effort */ }
}

function refreshEnglishSearchText(media_id) {
  try {
    const en = repo.getTrack(media_id, 'en');
    let text = null;
    if (en) {
      // readTrackText materializes from the encrypted store in vault mode.
      const vtt = repo.readTrackText(media_id, 'en');
      if (vtt) text = generator.toPlainText(generator.parseVTT(vtt)) || null;
    }
    database.get().prepare('UPDATE media SET subtitle_en = ? WHERE id = ?').run(text, media_id);
  } catch { /* non-fatal — search text is best-effort */ }
}

/* ── Info for the player toggle ─────────────────────────────────────────── */

function infoFor(media_id) {
  const tracks = repo.listTracks(media_id);
  const original = tracks.find(t => t.kind === 'original');
  const job = repo.activeJobFor(media_id);
  return {
    status: job ? job.status : (tracks.length ? 'ready' : 'none'),
    job_id: job?.id || null,
    progress: job ? job.progress : (tracks.length ? 100 : 0),
    stage: job ? job.stage : null,              // "Transcribing 1:23 / 5:00 · 42 lines"
    notice: job?.notice || null,                // one-shot advisory → client toast
    source_lang: original?.lang || null,
    tracks: tracks.map(t => ({ lang: t.lang, kind: t.kind })),
  };
}

module.exports = {
  enqueue, isActive, generateForMedia, patchWindow, infoFor, refreshEnglishSearchText, IDLE_SHUTDOWN_MS,
  _voiceTranslatedTrack, _buildPatchResolver,   // exported for tests
};
