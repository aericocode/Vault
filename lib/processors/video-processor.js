/**
 * Video Processor - Handles video, image, and GIF files
 * 
 * Uses vision API to analyze frames extracted from media.
 */

const BaseProcessor = require('./base-processor');
const mediaInfo = require('../media-info');
const frameExtractor = require('../frame-extractor');
const visionApi = require('../vision-api');

class VideoProcessor extends BaseProcessor {
  static get type() {
    return 'video';
  }

  static get extensions() {
    return [
      // Video formats
      '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
      '.m4v', '.mpeg', '.mpg', '.3gp', '.mts', '.m2ts',
      '.vob', '.ogv', '.rm', '.rmvb', '.asf', '.divx',
      // Images
      '.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif',
      // Animated
      '.gif',
    ];
  }

  static get mediaType() {
    return 'video'; // Will be refined in getMetadata
  }

  /**
   * Determine specific media type from extension
   */
  getSpecificMediaType(filepath) {
    const ext = filepath.toLowerCase().slice(filepath.lastIndexOf('.'));
    
    if (ext === '.gif') return 'gif';
    if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'].includes(ext)) return 'image';
    return 'video';
  }

  async getMetadata(filepath) {
    const base = await super.getMetadata(filepath);
    const info = await mediaInfo.getInfo(filepath);

    if (!info) {
      throw new Error('Could not read media info');
    }

    return {
      ...base,
      mediaType: this.getSpecificMediaType(filepath),
      duration: info.duration,
      width: info.width,
      height: info.height,
      codec: info.codec,
      bitrate: info.bitrate,
    };
  }

  async extractContent(filepath, metadata, options = {}) {
    const extraction = await frameExtractor.extract(
      filepath,
      metadata.mediaType,
      metadata.duration,
      metadata.height
    );

    const content = {
      frames: extraction.frames,
      qualityFlag: extraction.qualityFlag,
      tempDir: extraction.tempDir,
      originalFrameCount: extraction.originalFrameCount,
      dedupedFrameCount: extraction.dedupedFrameCount,
      transcription: null,
      transcriptionLanguage: null,
    };

    // Audio transcription for videos — previously only the legacy (non
    // --all-types) scan path did this, so --all-types dropped transcription.
    if (options.transcribeVideo && metadata.mediaType === 'video') {
      const transcriber = require('../video-transcriber');
      const result = await transcriber.transcribeVideo(filepath);
      if (result && result.text) {
        content.transcription = result.text;
        content.transcriptionLanguage = result.language;
      }
    }

    return content;
  }

  async analyze(content, filename, options = {}) {
    if (!content.frames || content.frames.length === 0) {
      return null;
    }

    // Determine media type from filename for prompt selection
    const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    let mediaType = 'video';
    if (ext === '.gif') mediaType = 'gif';
    else if (['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tiff', '.tif'].includes(ext)) mediaType = 'image';

    const analysisOptions = {};
    if (content.transcription) {
      analysisOptions.transcription = content.transcription;
      analysisOptions.transcriptionLanguage = content.transcriptionLanguage;
    }
    // Soft theme-vocabulary grounding, passed down from the scan run
    if (Array.isArray(options.themeVocab) && options.themeVocab.length) {
      analysisOptions.themeVocab = options.themeVocab;
    }

    return await visionApi.analyze(content.frames, filename, mediaType, analysisOptions);
  }

  async cleanup(content) {
    if (content && content.tempDir) {
      frameExtractor.cleanup(content.tempDir);
    }
  }
}

module.exports = VideoProcessor;
