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

    if (transcriber.isFasterWhisperAvailable()) {
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
        console.warn(`  ✗ Transcription failed: ${err.message}`);
      }
    } else {
      console.log(`  ⚠ faster-whisper not found. Install with: pip install faster-whisper`);
    }

    return {
      transcription,
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
      // No transcription available - return basic info with any ID3 tags
      const desc = metaDesc || `Audio file (${content.duration?.toFixed(1) || '?'}s)`;

      return {
        description: desc + ' - transcription unavailable',
        content_type: 'audio',
        language: 'unknown',
        themes: [],
        tags: ['audio', ...(content.artist ? [content.artist.toLowerCase()] : [])],
        explicit: false,
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
        explicit: analysis.has_sensitive_data || false,
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
      explicit: false,
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
