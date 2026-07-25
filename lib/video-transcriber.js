/**
 * Video Transcriber - Extract audio from video and transcribe it
 * 
 * Uses FFmpeg to extract audio, then faster-whisper for transcription.
 * Designed to be used alongside vision analysis for richer video understanding.
 * 
 * The whisper model is loaded ONCE and kept in memory for the entire scan,
 * avoiding the ~15s model load time per file.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const proc = require('./proc');
const config = require('../config');
const ownedDir = require('./owned-dir');
const { ROOT } = require('./approot');

// Resilient to a config that predates the subtitles block (partial syncs /
// older config.js) — the whisper model must never be undefined.
const SUBS = config.subtitles || {};
const WHISPER_MODEL = process.env.WHISPER_MODEL || SUBS.model || 'large-v3-turbo';
const WHISPER_COMPUTE = process.env.WHISPER_COMPUTE || SUBS.computeType || 'int8_float16';
const SCAN_MAX_CHARS = (config.Global_options && config.Global_options.max_characters_per_transcription) || 8000;

// Local temp directory (same pattern as temp_frames)
const TEMP_AUDIO_DIR = process.env.VIDEO_TAGGER_TEMP_AUDIO || path.join(ROOT, 'temp_audio');

// Persistent whisper server process
let whisperServer = null;
let whisperReady = false;
let pendingRequests = new Map();
let requestId = 0;

/**
 * Ensure temp audio directory exists
 */
function ensureTempDir() {
  // mkdir + conditional app-owned marker (gates the end-of-run cleanupAll wipe).
  ownedDir.ensureManaged(TEMP_AUDIO_DIR, 'tempaudio');
}

/**
 * Create a unique temp directory for a single file
 */
function createTempDir() {
  ensureTempDir();
  const uniqueId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tempDir = path.join(TEMP_AUDIO_DIR, uniqueId);
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Cleanup a specific temp directory
 */
function cleanup(tempDir) {
  if (tempDir && fs.existsSync(tempDir)) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Cleanup all temp audio files and shutdown server
 */
function cleanupAll() {
  // Shutdown whisper server first
  shutdownServer();

  if (fs.existsSync(TEMP_AUDIO_DIR)) {
    // Gate the whole-dir wipe on the app-owned marker (skip + warn if missing).
    if (!ownedDir.guardSweep(TEMP_AUDIO_DIR, 'temp-audio cleanup')) return;
    try {
      fs.rmSync(TEMP_AUDIO_DIR, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Check if faster-whisper is available.
 * Memoized — this used to spawn a fresh `pip show` for EVERY file processed.
 */
let _fasterWhisperAvailable = null;
function isFasterWhisperAvailable() {
  if (_fasterWhisperAvailable !== null) return _fasterWhisperAvailable;
  try {
    const result = spawnSync('python', ['-m', 'pip', 'show', 'faster-whisper'], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 10000,
    });
    _fasterWhisperAvailable = !!result.stdout?.includes('faster-whisper');
  } catch {
    _fasterWhisperAvailable = false;
  }
  return _fasterWhisperAvailable;
}

/**
 * Check if video has an audio stream (async — no event-loop blocking)
 */
async function hasAudioStream(filepath) {
  try {
    const { stdout } = await proc.run('ffprobe', [
      '-v', 'quiet', '-select_streams', 'a',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filepath
    ], { timeout: 30000 });
    return stdout.trim().includes('audio');
  } catch {
    return false;
  }
}

/**
 * Extract audio from video to temporary WAV file (async)
 */
async function extractAudio(videoPath, tempDir, maxDuration = 0, startSec = 0) {
  const outputPath = path.join(tempDir, 'extracted_audio.wav');

  try {
    // -ss before -i for a fast seek to the window start (used by "Fix here")
    const args = [];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le');
    if (maxDuration > 0) {
      args.push('-t', String(maxDuration));
    }
    args.push(outputPath, '-y');

    await proc.run('ffmpeg', args, { timeout: 300000 });

    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return outputPath;
    }
  } catch (err) {
    console.warn(`  Audio extraction failed: ${err.message}`);
  }

  return null;
}

/**
 * Python script for persistent whisper server
 * Loads model ONCE, then processes files via stdin/stdout JSON protocol
 */
const WHISPER_SERVER_SCRIPT = `
import sys
import json
import os

# Disable unnecessary warnings
import warnings
warnings.filterwarnings("ignore")

# Voice-activity filter (set by the Node side from config.subtitles.vad).
# Skips music/silence so whisper only decodes speech — big speedup on padded
# content. faster-whisper maps segment timestamps back to the original audio.
VAD_ENABLED = os.environ.get("WHISPER_VAD", "1") != "0"
try:
    VAD_MIN_SILENCE_MS = int(os.environ.get("WHISPER_VAD_MIN_SILENCE_MS", "500"))
except ValueError:
    VAD_MIN_SILENCE_MS = 500
VAD_KW = dict(vad_filter=True, vad_parameters=dict(min_silence_duration_ms=VAD_MIN_SILENCE_MS)) if VAD_ENABLED else {}

try:
    from faster_whisper import WhisperModel
except ImportError:
    print(json.dumps({"type": "error", "message": "faster-whisper not installed"}), flush=True)
    sys.exit(1)

def main():
    model_size = sys.argv[1] if len(sys.argv) > 1 else "base"
    device = sys.argv[2] if len(sys.argv) > 2 else "auto"
    compute_type = sys.argv[3] if len(sys.argv) > 3 else "float16"
    
    # Auto-detect device
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except:
            device = "cpu"
    
    # Adjust compute type for CPU (float16 kernels are GPU-only)
    if device == "cpu" and compute_type.endswith("float16"):
        compute_type = "int8"

    # Local-first model loading: try the on-disk cache with NO network first
    # (faster-whisper otherwise pings HuggingFace on every single load). Only
    # if the model isn't installed do we consider a one-time download, gated by
    # SUB_ALLOW_DOWNLOADS so a strict/air-gapped box never reaches out.
    allow_download = os.environ.get("SUB_ALLOW_DOWNLOADS", "1") != "0"
    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type, local_files_only=True)
        print(json.dumps({"type": "ready", "device": device, "model": model_size, "downloaded": False}), flush=True)
    except Exception:
        if not allow_download:
            print(json.dumps({"type": "error", "message":
                f"Whisper model '{model_size}' is not installed and network downloads are off "
                f"(SUB_ALLOW_DOWNLOADS=0). Enable it once to fetch the model, or pre-install it."}), flush=True)
            sys.exit(1)
        # One-time fetch from HuggingFace — announce it so the pill/log can say so
        print(json.dumps({"type": "model_downloading", "model": model_size}), flush=True)
        try:
            model = WhisperModel(model_size, device=device, compute_type=compute_type)
            print(json.dumps({"type": "ready", "device": device, "model": model_size, "downloaded": True}), flush=True)
        except Exception as e:
            print(json.dumps({"type": "error", "message": str(e)}), flush=True)
            sys.exit(1)
    
    # Process requests from stdin
    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
            req_id = request.get("id", 0)
            filepath = request.get("filepath")
            max_chars = request.get("max_chars", 4000)
            
            if request.get("command") == "shutdown":
                print(json.dumps({"type": "shutdown", "id": req_id}), flush=True)
                break

            if not filepath:
                print(json.dumps({"type": "result", "id": req_id, "error": "No filepath provided"}), flush=True)
                continue

            if request.get("command") == "subtitles":
                # STREAMING full transcription: whisper's segment generator is
                # lazy, so emit each segment the instant it's decoded (low TTFW +
                # real progress) instead of draining the whole file first.
                # An explicit "language" skips auto-detection entirely — the fix
                # for clips whose opening 30s misleads the detector.
                forced_lang = request.get("language") or None
                segments, info = model.transcribe(filepath, beam_size=5, word_timestamps=True, language=forced_lang, **VAD_KW)
                # language + duration are known before consuming the generator
                print(json.dumps({
                    "type": "sub_start", "id": req_id,
                    "language": info.language,
                    "language_probability": info.language_probability,
                    "duration": info.duration,
                }), flush=True)
                for segment in segments:
                    words = []
                    for w in (segment.words or []):
                        words.append({"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word})
                    print(json.dumps({
                        "type": "sub_segment", "id": req_id,
                        "start": round(segment.start, 3),
                        "end": round(segment.end, 3),
                        "text": segment.text.strip(),
                        "words": words,
                    }), flush=True)
                print(json.dumps({"type": "sub_done", "id": req_id}), flush=True)
                continue

            # Transcribe (scan snippet — capped)
            segments, info = model.transcribe(filepath, beam_size=5, **VAD_KW)
            
            # Collect text until we hit character limit
            text_parts = []
            total_chars = 0
            stopped_early = False
            
            for segment in segments:
                segment_text = segment.text.strip()
                segment_len = len(segment_text)
                
                if total_chars + segment_len + 1 > max_chars:
                    remaining = max_chars - total_chars - 1
                    if remaining > 50:
                        text_parts.append(segment_text[:remaining] + "...")
                    stopped_early = True
                    break
                
                text_parts.append(segment_text)
                total_chars += segment_len + 1
            
            result = {
                "type": "result",
                "id": req_id,
                "text": " ".join(text_parts),
                "language": info.language,
                "language_probability": info.language_probability,
                "duration": info.duration,
                "stopped_early": stopped_early
            }
            print(json.dumps(result), flush=True)
            
        except json.JSONDecodeError as e:
            print(json.dumps({"type": "error", "message": f"Invalid JSON: {e}"}), flush=True)
        except Exception as e:
            req_id = request.get("id", 0) if 'request' in dir() else 0
            print(json.dumps({"type": "result", "id": req_id, "error": str(e)}), flush=True)

if __name__ == "__main__":
    main()
`;

/**
 * Start the persistent whisper server.
 * Concurrency-safe: parallel workers all await the same startup promise
 * instead of spawning multiple servers.
 */
let whisperStarting = null;

async function startServer(opts = {}) {
  if (whisperServer && whisperReady) {
    return true;
  }
  if (whisperStarting) {
    return whisperStarting;
  }
  whisperStarting = startServerInner(opts).finally(() => { whisperStarting = null; });
  return whisperStarting;
}

async function startServerInner({ onDownloading } = {}) {
  // large-v3-turbo @ int8_float16 is the default everywhere (scan snippets AND
  // subtitle jobs — one warm model). WHISPER_MODEL=small for low-VRAM boxes.
  const model = WHISPER_MODEL;
  const device = process.env.WHISPER_DEVICE || 'auto';
  const compute = WHISPER_COMPUTE;
  
  // Write server script to temp directory
  ensureTempDir();
  const scriptPath = path.join(TEMP_AUDIO_DIR, 'whisper_server.py');
  fs.writeFileSync(scriptPath, WHISPER_SERVER_SCRIPT);
  
  return new Promise((resolve, reject) => {
    console.log(`  Starting whisper server (model: ${model})...`);
    const startTime = Date.now();
    
    // -X utf8: Windows Python otherwise decodes piped stdin as cp1252,
    // corrupting non-ASCII filepaths in request JSON
    whisperServer = spawn('python', ['-X', 'utf8', '-u', scriptPath, model, device, compute], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
        // Config is the single source; the sidecar reads these from env
        WHISPER_VAD: (SUBS.vad !== false) ? '1' : '0',
        WHISPER_VAD_MIN_SILENCE_MS: String(SUBS.vadMinSilenceMs || 500),
        SUB_ALLOW_DOWNLOADS: (SUBS.allowModelDownload !== false) ? '1' : '0',
        // Hard-offline mode: whisper fetches models from HuggingFace at load,
        // and that call can't route through lib/net.js — forbid it in-sidecar.
        ...(config.net?.offline ? { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } : {}),
      },
    });
    
    // Handle stdout line by line
    const rl = readline.createInterface({ input: whisperServer.stdout });
    
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        
        if (msg.type === 'model_downloading') {
          // Model not on disk — one-time fetch from HuggingFace (gated by
          // SUB_ALLOW_DOWNLOADS). Announce loudly; the pill mirrors it.
          console.log(`  ⚠ Downloading whisper model "${msg.model}" from HuggingFace (one-time, ~1.5GB)...`);
          try { onDownloading?.(msg.model); } catch {}
        } else if (msg.type === 'ready') {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          console.log(`  ✓ Whisper server ready (${msg.device}, ${msg.downloaded ? 'downloaded + loaded' : 'loaded'} in ${elapsed}s)`);
          whisperReady = true;
          resolve(true);
        } else if (msg.type === 'result') {
          const pending = pendingRequests.get(msg.id);
          if (pending) {
            pendingRequests.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(msg.error));
            } else {
              pending.resolve({
                text: msg.text,
                language: msg.language,
                confidence: msg.language_probability,
                duration: msg.duration,
                stoppedEarly: msg.stopped_early,
              });
            }
          }
        } else if (msg.type === 'sub_start') {
          try { pendingRequests.get(msg.id)?.onStart?.(msg); } catch (e) { console.error('[whisper] onStart', e); }
        } else if (msg.type === 'sub_segment') {
          try { pendingRequests.get(msg.id)?.onSegment?.(msg); } catch (e) { console.error('[whisper] onSegment', e); }
        } else if (msg.type === 'sub_done') {
          const pending = pendingRequests.get(msg.id);
          if (pending) { pendingRequests.delete(msg.id); pending.resolve({ complete: true }); }
        } else if (msg.type === 'error') {
          console.error(`  Whisper server error: ${msg.message}`);
          if (!whisperReady) {
            reject(new Error(msg.message));
          }
        } else if (msg.type === 'shutdown') {
          whisperReady = false;
        }
      } catch (err) {
        // Non-JSON output, ignore (could be warnings)
      }
    });
    
    // Handle stderr (warnings, etc) - suppress to reduce noise
    whisperServer.stderr.on('data', (data) => {
      // Uncomment for debugging:
      // console.error(`  [whisper] ${data.toString().trim()}`);
    });
    
    whisperServer.on('error', (err) => {
      console.error(`  Whisper server failed to start: ${err.message}`);
      whisperServer = null;
      whisperReady = false;
      reject(err);
    });
    
    whisperServer.on('close', (code) => {
      whisperServer = null;
      whisperReady = false;
      // Reject any pending requests
      for (const [id, pending] of pendingRequests) {
        pending.reject(new Error('Whisper server closed'));
      }
      pendingRequests.clear();
    });
    
    // Timeout for server startup — generous because the FIRST boot of a new
    // model size downloads it from the HF hub (large-v3-turbo ≈ 1.6GB)
    setTimeout(() => {
      if (!whisperReady) {
        reject(new Error('Whisper server startup timeout (first run downloads the model — retry, or pre-fetch with: python -c "from faster_whisper import WhisperModel; WhisperModel(\'large-v3-turbo\')")'));
      }
    }, 600000); // 10 minutes
  });
}

/**
 * Shutdown the whisper server
 */
function shutdownServer() {
  if (whisperServer && whisperReady) {
    try {
      whisperServer.stdin.write(JSON.stringify({ command: 'shutdown', id: -1 }) + '\n');
    } catch (err) {
      // Ignore write errors
    }
  }
  
  if (whisperServer) {
    try {
      whisperServer.kill();
    } catch (err) {
      // Ignore kill errors
    }
    whisperServer = null;
  }
  whisperReady = false;
  pendingRequests.clear();
}

/**
 * Transcribe audio using the persistent server
 */
async function transcribeAudio(audioPath, maxChars = SCAN_MAX_CHARS) {
  if (!whisperServer || !whisperReady) {
    await startServer();
  }
  
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });
    
    const request = {
      id,
      filepath: audioPath,
      max_chars: maxChars,
    };
    
    try {
      whisperServer.stdin.write(JSON.stringify(request) + '\n');
    } catch (err) {
      pendingRequests.delete(id);
      reject(err);
    }
    
    // Timeout for individual transcription
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('Transcription timeout'));
      }
    }, 300000); // 5 minute timeout per file
  });
}

/**
 * Full timed transcription for subtitle generation: every segment, word
 * timestamps, no character cap. audioPath should be an extracted wav (or any
 * file PyAV can decode). Slow for long files — callers run this in a queue.
 * @returns {Promise<{language, confidence, duration, segments:[{start,end,text,words}]}>}
 */
async function transcribeSubtitlesStream(audioPath, { onStart, onSegment, onModelLoad, onModelReady, onModelDownloading, language = null, timeoutMs = 600000 } = {}) {
  if (!whisperServer || !whisperReady) {
    // Cold start: the model must load into VRAM before any segment streams
    // (a cached model — the normal case — loads offline in a few seconds; only
    // a never-installed model triggers onModelDownloading via the sidecar).
    // Signalled here — the ONLY place we know a real load is about to happen —
    // so a warm sidecar never flashes a false "loading".
    onModelLoad?.();
    await startServer({ onDownloading: onModelDownloading });
  }

  // Model is loaded from here on, but transcribe() still does front-work before
  // sub_start comes back: full-file VAD scan, language detection, and (first
  // request only) CUDA kernel warmup. Announce it so callers can retire their
  // "loading model" message the moment loading is actually done.
  onModelReady?.();
  const analyzeStart = Date.now();

  return new Promise((resolve, reject) => {
    const id = ++requestId;
    // Segment callbacks refresh the watchdog — a healthy stream is never idle
    // for long, so a stall (rather than slow-but-progressing) is detectable
    let watchdog;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Subtitle transcription stalled (no segment progress)'));
        }
      }, timeoutMs);
    };
    pendingRequests.set(id, {
      resolve: (v) => { clearTimeout(watchdog); resolve(v); },
      reject: (e) => { clearTimeout(watchdog); reject(e); },
      onStart: (m) => {
        arm();
        if (SUBS.debug) {
          console.log(`  Whisper pre-scan done in ${((Date.now() - analyzeStart) / 1000).toFixed(1)}s (VAD + language ${language ? 'forced' : 'detect'}: ${m.language})`);
        }
        onStart?.(m);
      },
      onSegment: (m) => { arm(); onSegment?.(m); },
    });

    try {
      whisperServer.stdin.write(JSON.stringify({
        id, command: 'subtitles', filepath: audioPath,
        ...(language ? { language } : {}),   // absent → sidecar auto-detects
      }) + '\n');
    } catch (err) {
      pendingRequests.delete(id);
      clearTimeout(watchdog);
      reject(err);
      return;
    }
    arm();  // startup allowance (model warm + first-segment decode)
  });
}

/** Collecting wrapper (non-streaming callers): returns { language, confidence, duration, segments }. */
async function transcribeSubtitles(audioPath, opts = {}) {
  const segments = [];
  let meta = {};
  await transcribeSubtitlesStream(audioPath, {
    ...opts,
    onStart: (m) => { meta = m; },
    onSegment: (s) => segments.push(s),
  });
  return { language: meta.language, confidence: meta.language_probability, duration: meta.duration, segments };
}

/**
 * Main function: Extract and transcribe audio from video
 */
async function transcribeVideo(videoPath, options = {}) {
  const maxChars = options.maxChars || SCAN_MAX_CHARS;
  
  // Estimate max audio duration needed
  const estimatedMinutes = Math.ceil((maxChars / 750) * 1.5);
  const maxAudioSeconds = Math.max(estimatedMinutes * 60, 300);
  
  // Check prerequisites
  if (!isFasterWhisperAvailable()) {
    console.log(`  ⚠ faster-whisper not available for video transcription`);
    return null;
  }

  if (!(await hasAudioStream(videoPath))) {
    console.log(`  ℹ Video has no audio stream`);
    return null;
  }

  console.log(`  Starting transcription for "${path.basename(videoPath)}" (max ${maxChars} chars, model: ${WHISPER_MODEL})`);

  // Create local temp directory
  const tempDir = createTempDir();
  
  try {
    // Extract audio
    console.log(`  Extracting audio (max ${Math.round(maxAudioSeconds/60)} min)...`);
    const audioPath = await extractAudio(videoPath, tempDir, maxAudioSeconds);
    
    if (!audioPath) {
      console.warn(`  Audio extraction failed, skipping transcription`);
      return null;
    }

    // Transcribe using persistent server (model already loaded!)
    console.log(`  Transcribing (max ${maxChars} chars)...`);
    const result = await transcribeAudio(audioPath, maxChars);
    
    if (result && result.text) {
      const wordCount = result.text.split(/\s+/).length;
      const earlyStop = result.stoppedEarly ? ' [limit reached]' : '';
      console.log(`  ✓ ${wordCount} words, ${result.text.length} chars (${result.language}, ${(result.confidence * 100).toFixed(1)}%)${earlyStop}`);
    }
    
    return result;
  } catch (err) {
    console.warn(`  ✗ Video transcription failed: ${err.message}`);
    return null;
  } finally {
    cleanup(tempDir);
  }
}

/**
 * Check if server is running
 */
function isServerRunning() {
  return whisperServer !== null && whisperReady;
}

module.exports = {
  transcribeVideo,
  transcribeSubtitles,
  transcribeSubtitlesStream,
  isFasterWhisperAvailable,
  hasAudioStream,
  extractAudio,
  transcribeAudio,
  ensureTempDir,
  cleanup,
  cleanupAll,
  startServer,
  shutdownServer,
  isServerRunning,
  TEMP_AUDIO_DIR,
};
