const path = require('path');
const { ROOT } = require('../lib/approot');

const isWindows = process.platform === 'win32';

const config = {
  // AI backend — any OpenAI-compatible /v1/chat/completions server works:
  // LM Studio (default), Ollama, llama.cpp server, vLLM, …
  // Multiple endpoints load-balance (multi-GPU / multi-machine).
  lmStudio: {
    // LM Studio:  http://localhost:1234/v1/chat/completions   (default)
    // Ollama:     http://localhost:11434/v1/chat/completions  (also set AI_MODEL)
    // Example multi-GPU: LM_STUDIO_URLS=http://localhost:1234/...,http://localhost:1235/...
    endpoints: (process.env.LM_STUDIO_URLS || 'http://localhost:1234/v1/chat/completions')
      .split(',')
      .map(url => url.trim()),
    // Model name sent with each request. LM Studio ignores it (uses whatever
    // is loaded), so null is fine there — but Ollama/vLLM REQUIRE it.
    // Ollama example: AI_MODEL=qwen2.5vl:7b (a vision model — scans need one)
    model: process.env.AI_MODEL || null,
    temperature: 0.3,
    maxTokens: 6000,
  },

  Global_options: {
    // Scan-snippet transcription budget (turbo is fast enough for 8k)
    max_characters_per_transcription: parseInt(process.env.WHISPER_MAX_CHARS) || 8000,
  },

  // Whisper transcription + subtitle generation (see SUBTITLES_SPEC.md).
  // 'large-v3-turbo' is the default everywhere — near-large accuracy at ~8×
  // large-v3 speed. Set WHISPER_MODEL=small for low-VRAM hardware.
  subtitles: {
    model: process.env.WHISPER_MODEL || 'large-v3-turbo',
    computeType: process.env.WHISPER_COMPUTE || 'int8_float16',
    wordTimestamps: true,
    // 'opus' (local OPUS-MT via CTranslate2, auto-fetched per language pair)
    // with LM Studio as the built-in fallback when the model can't be fetched
    translateEngine: process.env.SUB_TRANSLATE || 'opus',
    targetLang: 'en',
    onScan: process.env.SUB_ON_SCAN === 'true',
    translateOnScan: process.env.SUB_TRANSLATE_ON_SCAN !== 'false',
    // Keep the loaded Whisper/translation/diarization sidecars warm in the
    // viewer server. 0 = never unload once loaded; N = unload after
    // N idle minutes (for low-VRAM boxes). CLI scans always clean up at exit.
    idleUnloadMinutes: Number.isFinite(parseFloat(process.env.WHISPER_IDLE_MINUTES))
      ? parseFloat(process.env.WHISPER_IDLE_MINUTES) : 30, // 0 = never unload
    // Voice-activity filter: whisper only decodes speech regions, skipping
    // music/silence/gaps. Big transcription speedup on padded content, small
    // on wall-to-wall talking, and fewer hallucinations in silence. Timestamps
    // are mapped back to the original timeline. WHISPER_VAD=0 to disable.
    vad: process.env.WHISPER_VAD !== '0',
    vadMinSilenceMs: parseInt(process.env.WHISPER_VAD_MIN_SILENCE_MS) || 500,
    // Local-first network policy for AI MODELS (whisper + OPUS-MT translation).
    // Once a model is on disk it ALWAYS loads offline (local_files_only) — no
    // silent HuggingFace pings on every load. A model that ISN'T installed yet
    // needs a one-time download; this flag governs that reach:
    //   true  (default) — allow the one-time fetch, with a prominent warning
    //   false           — never touch the network; a missing model errors with
    //                     instructions instead (air-gapped / strict local mode)
    // VAULT_OFFLINE=1 (the app-wide hard offline switch) also forces this off.
    allowModelDownload: process.env.SUB_ALLOW_DOWNLOADS !== '0' && process.env.VAULT_OFFLINE !== '1',
    // Where converted OPUS-MT models live (one dir per language pair)
    opusModelDir: process.env.OPUS_MODEL_DIR || path.join(ROOT, 'models', 'opus-mt'),
    // Speaker diarization → <v Speaker N> cue tags (player colors voices).
    // sherpa-onnx backend: CPU, runs in parallel with whisper (≈free), no
    // HuggingFace account. Monologues are detected and left untagged.
    // 'pyannote' backend is available but needs pyannote.audio + an HF token.
    diarize: process.env.SUB_DIARIZE !== 'false',
    diarizeBackend: process.env.SUB_DIARIZE_BACKEND || 'sherpa',
    diarizeModelDir: process.env.DIARIZE_MODEL_DIR || path.join(ROOT, 'models', 'diarize'),
    diarizeNumSpeakers: parseInt(process.env.SUB_DIARIZE_SPEAKERS) || -1,   // -1 = auto-detect
    // higher → fewer speakers. isFinite guard (not `|| 0.5`) so an explicit
    // SUB_DIARIZE_THRESHOLD=0 (max-split, for testing) isn't coerced back to 0.5.
    diarizeThreshold: Number.isFinite(parseFloat(process.env.SUB_DIARIZE_THRESHOLD))
      ? parseFloat(process.env.SUB_DIARIZE_THRESHOLD) : 0.9,
    // Per-file diagnostic logging (whisper pre-scan timing, "no speech
    // detected" notices). Off by default — the server console should only
    // carry true errors; this is for tracking down model-loading/detection
    // issues, not routine operation.
    debug: process.env.SUBTITLES_DEBUG === '1',
  },

  // Performance settings
  performance: {
    // Parallel frame extraction (CPU-bound) - safe to run many
    maxFrameWorkers: parseInt(process.env.FRAME_WORKERS) || 4,
    
    // Parallel vision API calls per endpoint (GPU-bound)
    // With 2 endpoints, total concurrent = 2 * this value
    maxVisionWorkersPerEndpoint: parseInt(process.env.VISION_WORKERS) || 1,
    
    // Frame deduplication - skip very similar frames
    deduplicateFrames: process.env.DEDUPE_FRAMES !== 'false',
    
    // Batch size for queuing files
    batchSize: parseInt(process.env.BATCH_SIZE) || 50,

    // Pipeline depth: how many files each endpoint works ahead on.
    // 2 means one file extracts frames while another runs vision inference,
    // keeping the GPU busy. Total workers = endpoints * visionWorkers * depth.
    pipelineDepth: parseInt(process.env.PIPELINE_DEPTH) || 2,
  },

  // Frame extraction settings - OPTIMIZED FOR SPEED
  frames: {
    intervals: [
      { maxDuration: 60, interval: 2 },       // < 1 min: every 2s
      { maxDuration: 600, interval: 5 },      // 1-10 min: every 5s
      { maxDuration: 3600, interval: 10 },    // 10-60 min: every 10s
      { maxDuration: Infinity, interval: 20 } // > 1 hr: every 20s
    ],

    resolutionMultipliers: [
      { maxHeight: 360, multiplier: 1.5, flag: 'very_low_res' },
      { maxHeight: 480, multiplier: 1.2, flag: 'low_res' },
      { maxHeight: 720, multiplier: 1.0, flag: 'acceptable' },
      { maxHeight: 1080, multiplier: 1.0, flag: 'good' },
      { maxHeight: Infinity, multiplier: 1.0, flag: 'high' }
    ],

    // Weighted extraction - more frames from start/end of videos
    weighted: {
      enabled: true,
      startPercent: 0.10,    // First 10% of video
      endPercent: 0.10,      // Last 10% of video
      startWeight: 2.5,      // 2.5x more frames in start region
      endWeight: 2.0,        // 2x more frames in end region
      middleWeight: 1.0,     // Base weight for middle
    },

    maxFrames: 35,       // Fine tune for accuracy vs speed (25fps ~30s, 45fps ~38s)
    minFrames: 3,
    gifFrames: 5,
    
    maxWidth: 600,       // Smaller frames = faster API
    jpegQuality: 3,
  },

  // File extensions by media type (DEFAULT - video/image/gif only)
  // For all types including documents/audio/3d, use --all-types flag
  // which uses the processor registry instead
  extensions: {
    video: [
      '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
      '.m4v', '.mpeg', '.mpg', '.3gp', '.mts', '.m2ts',
      '.vob', '.ogv', '.rm', '.rmvb', '.asf', '.divx'
    ],
    image: ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'],
    gif: ['.gif'],
    
    // Additional types (used when --all-types is enabled via processor registry)
    // Listed here for reference only - actual extensions come from processors
    // document: ['.txt', '.md', '.html', '.json', '.docx', '.rtf', '.js', '.ts', '.xml', '.pdf'],
    // audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'],
  },

  // Paths
  paths: {
    tempDir: process.env.VIDEO_TAGGER_TEMP || path.join(ROOT, 'temp_frames'),
    database: process.env.VIDEO_TAGGER_DB || path.join(ROOT, 'video_metadata.db'),
    // Encrypted derived-artifact store (thumbs/scrub/beat-audio/subtitles) used
    // only in vault mode. Lives next to the main DB so a scratch/test DB gets
    // its own isolated store; env override for explicit placement.
    get secureAssets() {
      return process.env.VIDEO_TAGGER_SECURE_ASSETS
        || path.join(path.dirname(path.resolve(this.database)), 'secure_assets.db');
    },
    outputBase: process.env.VIDEO_TAGGER_OUTPUT || path.join(ROOT, 'sorted_media'),
    debugLog: process.env.VIDEO_TAGGER_DEBUG_LOG || path.join(ROOT, 'bad_json_responses.log'),
    thumbnailDir: process.env.VIDEO_TAGGER_THUMBS || path.join(ROOT, 'thumbnails'),
    trashDir: process.env.VIDEO_TAGGER_TRASH || path.join(ROOT, 'trash'),
    // NOTE: there is deliberately NO importDir. Vault never copies source media
    // onto local disk — everything is referenced in place (see the native
    // pickers + /api/import/add-paths). The former imports/ folder is gone.
  },

  // Vault lock (DB encryption via better-sqlite3-multiple-ciphers)
  security: {
    // Auto-lock after this many minutes without API activity. An active scan
    // counts as activity — only a manual (forced) lock interrupts one. 0 = off.
    autolockMinutes: Number.isFinite(parseInt(process.env.VAULT_AUTOLOCK_MINUTES))
      ? parseInt(process.env.VAULT_AUTOLOCK_MINUTES) : 30,
  },

  // Viewer server (local-only — this app moves/deletes real files)
  server: {
    host: '127.0.0.1',
    port: parseInt(process.env.MEDIA_TAGGER_PORT) || 8765,
  },

  // Network policy — the app-wide hard offline switch. VAULT_OFFLINE=1 makes
  // lib/net.js reject every non-loopback request (models, update checks, any
  // remote LLM endpoint); loopback sidecars/LLM still work. This is the single
  // flag an air-gapped/strict-privacy user flips to guarantee zero egress.
  net: {
    offline: process.env.VAULT_OFFLINE === '1',
  },

  // Thumbnail generation (served by /thumb/:id, generated via ffmpeg)
  thumbnails: {
    width: parseInt(process.env.THUMB_WIDTH) || 320,
    jpegQuality: 4,          // ffmpeg -q:v (2 best .. 31 worst)
    videoSeekPercent: 0.15,  // grab the frame 15% into the video
  },

  // Embeddings (semantic search over existing text metadata — no rescan).
  // LM Studio JIT-loads the model on first /v1/embeddings request.
  embeddings: {
    enabled: process.env.EMBEDDINGS !== 'false',
    model: process.env.EMBEDDING_MODEL || 'text-embedding-nomic-embed-text-v1.5',
    batchSize: parseInt(process.env.EMBED_BATCH) || 32,
  },

  // Duplicate detection (scan-time skip + shared notes)
  dupes: {
    enabled: process.env.DUPE_SKIP !== 'false',
    // Only consider files at least this large (small files collide too easily)
    minSizeBytes: (parseInt(process.env.DUPE_MIN_MB) || 10) * 1024 * 1024,
    // Sizes within ±1% count as the same file (rehosted/re-muxed copies)
    sizeTolerance: parseFloat(process.env.DUPE_SIZE_TOLERANCE) || 0.01,
  },

  isWindows,
};

/**
 * Get media type for extension (default types only: video/image/gif)
 */
config.getMediaType = (ext) => {
  ext = ext.toLowerCase();
  if (config.extensions.video.includes(ext)) return 'video';
  if (config.extensions.image.includes(ext)) return 'image';
  if (config.extensions.gif.includes(ext)) return 'gif';
  return null;
};

/**
 * Get all supported extensions (default types only: video/image/gif)
 * For all types, use the processor registry via --all-types flag
 */
config.getAllExtensions = () => [
  ...config.extensions.video,
  ...config.extensions.image,
  ...config.extensions.gif,
];

/**
 * Get all extensions from processor registry (all supported types)
 * Lazy loads processors to avoid circular dependencies
 */
config.getAllProcessorExtensions = () => {
  try {
    const processors = require('../lib/processors');
    return processors.getSupportedExtensions();
  } catch (err) {
    console.warn('Could not load processors:', err.message);
    return config.getAllExtensions();
  }
};

/**
 * Get media type from processor registry
 */
config.getProcessorMediaType = (ext) => {
  try {
    const processors = require('../lib/processors');
    const ProcessorClass = processors.registry.getByExtension(ext);
    return ProcessorClass ? ProcessorClass.mediaType : null;
  } catch {
    return config.getMediaType(ext);
  }
};

config.getDbPassword = () => process.env.VIDEO_TAGGER_DB_PASSWORD || null;

module.exports = config;
