/**
 * Audio Processor - Handles audio files with transcription and summarization
 *
 * Transcribes via the PERSISTENT faster-whisper sidecar (lib/video-transcriber.js),
 * then summarizes with the LLM. Previously this processor spawned a fresh
 * Python process — reloading the whisper model — for every single audio file,
 * via blocking spawnSync calls that also froze all parallel workers.
 *
 * Requirements:
 * - Python 3.8+ with faster-whisper: pip install faster-whisper
 * - FFmpeg (for audio probing/decoding)
 *
 * Environment variables (read by the sidecar):
 * - WHISPER_MODEL: Model size (tiny, base, small, medium, large-v3)
 * - WHISPER_DEVICE: cuda, cpu, or auto
 * - WHISPER_COMPUTE: float16, int8, int8_float16
 */

const BaseProcessor = require('./base-processor');
const mediaInfo = require('../media-info');
const transcriber = require('../video-transcriber');
const modelHealth = require('../model-health');

// Lazy load text API for summarization
let textApi = null;
function getTextApi() {
  if (!textApi) {
    textApi = require('../text-api');
  }
  return textApi;
}

// Max transcription characters to feed the summarizer
const AUDIO_MAX_CHARS = 12000;

class AudioProcessor extends BaseProcessor {
  static get type() {
    return 'audio';
  }

  static get extensions() {
    return [
      '.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a',
      '.aiff', '.alac', '.ape',
    ];
  }

  static get mediaType() {
    return 'audio';
  }

  async getMetadata(filepath) {
    const base = await super.getMetadata(filepath);
    const audioInfo = await mediaInfo.getAudioInfo(filepath);

    return {
      ...base,
      ...audioInfo,
      width: null,
      height: null,
    };
  }

  async extractContent(filepath, metadata, options = {}) {
    let transcription = null;
    let detectedLanguage = 'unknown';
    let confidence = 0;
    let transcriptionError = null;

    // No Python / no faster-whisper is a MISSING TOOL, not a finished job. This
    // used to fall through to analyze()'s "transcription unavailable"
    // placeholder and save as SUCCESS with model_used 'lm-studio' — a row no
    // future scan would ever look at again, so installing whisper afterwards
    // left the file permanently empty. Fail it instead: retryable, self-healed
    // by lib/self-heal.js the moment whisper appears. (A transcription that
    // legitimately comes back EMPTY still succeeds — that is a file with no
    // speech, not a broken install.)
    const check = transcriber.checkTranscriber();
    if (!check.ok) {
      const { whisperMissingMessage } = require('../processing-errors');
      const msg = whisperMissingMessage(check);
      console.log(`  ⚠ ${msg}`);
      throw new Error(msg);
    }

    try {
      console.log(`  Transcribing with faster-whisper sidecar (model: ${process.env.WHISPER_MODEL || 'base'})...`);
      // faster-whisper decodes audio itself — no extraction step needed.
      // startServer() is idempotent; the model loads once per scan.
      const result = await transcriber.transcribeAudio(filepath, AUDIO_MAX_CHARS);

      transcription = result.text || null;
      detectedLanguage = result.language || 'unknown';
      confidence = result.confidence || 0;

      if (transcription) {
        console.log(`  ✓ Transcribed: ${transcription.slice(0, 80)}...`);
        console.log(`  ✓ Language: ${detectedLanguage} (${(confidence * 100).toFixed(1)}% confidence)`);
      }
    } catch (err) {
      // A dead sidecar is the model going away, not a bad file. Swallowing it
      // here was the worst of both worlds: the row saved as SUCCESS with
      // "transcription unavailable", so a later rescan skipped it entirely.
      // Let it out so the scan queue halts and the run can be resumed.
      if (modelHealth.isModelUnavailable(err)) {
        console.error(`  ⚠ Transcription model unavailable: ${modelHealth.describe(err)}`);
        throw modelHealth.tag(err);
      }
      console.warn(`  ✗ Transcription failed: ${err.message}`);
      transcriptionError = err.message;
    }

    return {
      transcription,
      transcriptionError,
      detectedLanguage,
      confidence,
      duration: metadata.duration,
      hasTranscription: !!transcription,
      wordCount: transcription ? transcription.split(/\s+/).filter(w => w).length : 0,
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.album,
    };
  }

  async analyze(content, filename, options = {}) {
    const api = getTextApi();

    // Build metadata description
    let metaDesc = '';
    if (content.title) metaDesc += `Title: ${content.title}. `;
    if (content.artist) metaDesc += `Artist: ${content.artist}. `;
    if (content.album) metaDesc += `Album: ${content.album}. `;

    if (!content.transcription) {
      // Whisper RAN and came back with nothing — reaching here without the tool
      // is impossible now (extractContent throws). So this is a legitimate
      // result: a file with no speech in it. Say that, rather than the old
      // "transcription unavailable", which blamed the install and — now that
      // lib/self-heal.js hunts that exact phrase — would put a genuinely silent
      // file back in the scan queue on every single boot.
      const desc = metaDesc || `Audio file (${content.duration?.toFixed(1) || '?'}s)`;
      const why = content.transcriptionError
        ? `. Transcription failed: ${content.transcriptionError}`
        : '. No speech detected';

      return {
        description: desc.trimEnd() + why,
        content_type: 'audio',
        language: 'unknown',
        themes: [],
        tags: ['audio', ...(content.artist ? [content.artist.toLowerCase()] : [])],
        transcription: null,
        word_count: 0,
      };
    }

    // Combine metadata with transcription for analysis
    const textToAnalyze = metaDesc
      ? `${metaDesc}\n\nTranscription:\n${content.transcription}`
      : content.transcription;

    // Use LLM to summarize the transcription
    const analysis = await api.analyze(textToAnalyze, filename, {
      maxInputChars: AUDIO_MAX_CHARS,
    });

    if (analysis) {
      return {
        description: analysis.description,
        content_type: analysis.document_type || 'audio',
        language: content.detectedLanguage !== 'unknown'
          ? content.detectedLanguage
          : (analysis.language || 'unknown'),
        themes: analysis.themes || [],
        tags: [...(analysis.tags || []), 'audio', 'transcribed'],
        transcription: content.transcription,
        word_count: content.wordCount,
        sentiment: analysis.sentiment,
        title: content.title,
        artist: content.artist,
        album: content.album,
      };
    }

    // Fallback - just use transcription directly
    return {
      description: (metaDesc + content.transcription).slice(0, 500),
      content_type: 'audio',
      language: content.detectedLanguage,
      themes: [],
      tags: ['audio', 'transcribed'],
      transcription: content.transcription,
      word_count: content.wordCount,
      title: content.title,
      artist: content.artist,
      album: content.album,
    };
  }

  async cleanup(content) {
    // No temp files — the sidecar reads the source file directly
  }
}

module.exports = AudioProcessor;
