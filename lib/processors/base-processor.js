/**
 * Base Processor - Abstract class for all media/document processors
 * 
 * Each processor handles a specific category of files and defines:
 * - Which file extensions it supports
 * - How to extract metadata
 * - How to analyze content (vision, text summarization, transcription, etc.)
 */

class BaseProcessor {
  /**
   * @returns {string} Processor name/type (e.g., 'video', 'document', 'audio')
   */
  static get type() {
    throw new Error('Processor must define static type');
  }

  /**
   * @returns {string[]} File extensions this processor handles (lowercase, with dot)
   */
  static get extensions() {
    throw new Error('Processor must define static extensions');
  }

  /**
   * @returns {string} Media type category for database
   */
  static get mediaType() {
    throw new Error('Processor must define static mediaType');
  }

  /**
   * Check if this processor can handle a file
   * @param {string} filepath - Path to file
   * @returns {boolean}
   */
  static canProcess(filepath) {
    const ext = filepath.toLowerCase().slice(filepath.lastIndexOf('.'));
    return this.extensions.includes(ext);
  }

  /**
   * Extract basic file metadata
   * @param {string} filepath - Path to file
   * @returns {Promise<object>} Basic metadata (filesize, etc.)
   */
  async getMetadata(filepath) {
    const fs = require('fs');
    const path = require('path');
    
    const stats = fs.statSync(filepath);
    return {
      filename: path.basename(filepath),
      filepath: filepath,
      filesize: stats.size,
      mediaType: this.constructor.mediaType,
    };
  }

  /**
   * Extract content for analysis (frames, text, audio, etc.)
   * @param {string} filepath - Path to file
   * @param {object} metadata - Metadata from getMetadata
   * @param {object} options - Scan options (e.g. transcribeVideo)
   * @returns {Promise<object>} Extracted content ready for analysis
   */
  async extractContent(filepath, metadata, options = {}) {
    throw new Error('Processor must implement extractContent');
  }

  /**
   * Analyze extracted content
   * @param {object} content - Content from extractContent
   * @param {string} filename - Original filename
   * @param {object} options - Scan options
   * @returns {Promise<object|null>} Analysis result or null on failure
   */
  async analyze(content, filename, options = {}) {
    throw new Error('Processor must implement analyze');
  }

  /**
   * Clean up any temporary files created during processing
   * @param {object} content - Content object from extractContent
   */
  async cleanup(content) {
    // Override if processor creates temp files
  }

  /**
   * Process a file end-to-end
   * @param {string} filepath - Path to file
   * @param {object} options - Scan options (e.g. transcribeVideo) — previously
   *   dropped here, which is why --all-types silently disabled transcription
   * @returns {Promise<object>} Processing result
   */
  async process(filepath, options = {}) {
    // getMetadata used to sit outside this try, so anything it threw (a missing
    // ffprobe, a corrupt header) escaped as an exception instead of the
    // { success: false } every caller is written to handle. Callers use
    // result.metadata?.x, so a null here is safe.
    let metadata = null;
    let content = null;
    try {
      metadata = await this.getMetadata(filepath);
      content = await this.extractContent(filepath, metadata, options);
      const analysis = await this.analyze(content, metadata.filename, options);
      
      return {
        success: !!analysis,
        metadata,
        analysis,
        content, // For access to tempDir, etc.
      };
    } catch (err) {
      return {
        success: false,
        metadata,
        error: err.message,
        // Carried through so the caller can tell "the model is gone" (halt the
        // queue, keep the work) from "this file is bad" (record and move on) —
        // by this point it is only an { error } string otherwise.
        modelUnavailable: !!err.modelUnavailable,
        // …and, when the backend's complaint was "several models are loaded,
        // say which", the flag that turns the queue's halt into a picker.
        needsModelChoice: !!err.needsModelChoice,
        modelReason: err.modelReason,
        content,
      };
    }
  }
}

module.exports = BaseProcessor;
