/**
 * Document Processor - Handles text documents
 * 
 * Extracts text content and uses LLM for summarization.
 * No vision API needed.
 */

const BaseProcessor = require('./base-processor');
const textExtractor = require('../text-extractor');
const textApi = require('../text-api');

class DocumentProcessor extends BaseProcessor {
  static get type() {
    return 'document';
  }

  static get extensions() {
    return textExtractor.getSupportedExtensions();
  }

  static get mediaType() {
    return 'document';
  }

  async getMetadata(filepath) {
    const base = await super.getMetadata(filepath);
    
    return {
      ...base,
      // Documents don't have duration/dimensions
      duration: null,
      width: null,
      height: null,
    };
  }

  async extractContent(filepath, metadata) {
    const text = await textExtractor.extract(filepath);
    
    return {
      text,
      charCount: text.length,
      wordCount: text.split(/\s+/).filter(w => w).length,
      lineCount: text.split('\n').length,
    };
  }

  async analyze(content, filename) {
    if (!content.text || content.text.trim().length === 0) {
      return {
        description: 'Empty document',
        document_type: 'other',
        language: 'unknown',
        themes: [],
        tags: [],
      };
    }

    // Try LLM analysis first
    const analysis = await textApi.analyze(content.text, filename);
    
    if (analysis) {
      return {
        // Map to standard fields
        description: analysis.description,
        content_type: analysis.document_type || 'document',
        language: analysis.language || 'unknown',
        themes: analysis.themes || [],
        tags: analysis.tags || [],
        explicit: analysis.has_sensitive_data || false,
        
        // Document-specific fields
        document_type: analysis.document_type,
        sentiment: analysis.sentiment,
        
        // Stats
        char_count: content.charCount,
        word_count: content.wordCount,
        line_count: content.lineCount,
      };
    }

    // Fallback to simple summarization
    console.log(`  Using fallback summarization for ${filename}`);
    const fallback = textApi.simpleSummarize(content.text, filename);
    
    return {
      description: fallback.description,
      content_type: fallback.document_type || 'document',
      language: fallback.language || 'unknown',
      themes: fallback.themes || [],
      tags: fallback.tags || [],
      explicit: false,
      document_type: fallback.document_type,
      sentiment: fallback.sentiment,
      char_count: content.charCount,
      word_count: content.wordCount,
      line_count: content.lineCount,
    };
  }

  async cleanup(content) {
    // Documents don't create temp files
  }
}

module.exports = DocumentProcessor;
