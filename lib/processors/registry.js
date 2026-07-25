/**
 * Processor Registry - Maps file extensions to their processors
 * 
 * Automatically discovers and registers processors.
 * Provides lookup by extension or file path.
 */

const path = require('path');

class ProcessorRegistry {
  constructor() {
    this.processors = new Map(); // extension -> processor class
    this.processorTypes = new Map(); // type name -> processor class
  }

  /**
   * Register a processor class
   * @param {class} ProcessorClass - Class extending BaseProcessor
   */
  register(ProcessorClass) {
    const type = ProcessorClass.type;
    const extensions = ProcessorClass.extensions;

    this.processorTypes.set(type, ProcessorClass);

    for (const ext of extensions) {
      this.processors.set(ext.toLowerCase(), ProcessorClass);
    }

    console.log(`Registered processor: ${type} (${extensions.join(', ')})`);
  }

  /**
   * Get processor for a file extension
   * @param {string} extension - File extension (with or without dot)
   * @returns {class|null} Processor class or null
   */
  getByExtension(extension) {
    const ext = extension.startsWith('.') ? extension : '.' + extension;
    return this.processors.get(ext.toLowerCase()) || null;
  }

  /**
   * Get processor for a file path
   * @param {string} filepath - Path to file
   * @returns {class|null} Processor class or null
   */
  getByPath(filepath) {
    const ext = path.extname(filepath).toLowerCase();
    return this.processors.get(ext) || null;
  }

  /**
   * Get processor by type name
   * @param {string} type - Processor type (e.g., 'video', 'document')
   * @returns {class|null} Processor class or null
   */
  getByType(type) {
    return this.processorTypes.get(type) || null;
  }

  /**
   * Check if a file can be processed
   * @param {string} filepath - Path to file
   * @returns {boolean}
   */
  canProcess(filepath) {
    return this.getByPath(filepath) !== null;
  }

  /**
   * Get all supported extensions
   * @returns {string[]}
   */
  getSupportedExtensions() {
    return Array.from(this.processors.keys());
  }

  /**
   * Get all registered processor types
   * @returns {string[]}
   */
  getProcessorTypes() {
    return Array.from(this.processorTypes.keys());
  }

  /**
   * Create processor instance for a file
   * @param {string} filepath - Path to file
   * @returns {BaseProcessor|null} Processor instance or null
   */
  createProcessor(filepath) {
    const ProcessorClass = this.getByPath(filepath);
    if (!ProcessorClass) return null;
    return new ProcessorClass();
  }

  /**
   * Discover and register the built-in processors.
   *
   * Was a runtime `fs.readdirSync` + dynamic `require` scan of `dir`; replaced
   * with a static require table so bundlers / Node SEA can follow every import.
   * The list mirrors the *-processor.js files in lib/processors/ (base-processor
   * / index / registry were always skipped by the old scan's filter, so they're
   * absent here too). The `type && extensions` guard is preserved.
   *
   * @param {string} [dir] - Unused; kept for call-site compatibility.
   */
  autoDiscover(dir) {
    const modules = {
      'video-processor.js': require('./video-processor'),
      'document-processor.js': require('./document-processor'),
      'audio-processor.js': require('./audio-processor'),
    };

    for (const [file, ProcessorClass] of Object.entries(modules)) {
      try {
        if (ProcessorClass.type && ProcessorClass.extensions) {
          this.register(ProcessorClass);
        }
      } catch (err) {
        console.warn(`Failed to load processor ${file}: ${err.message}`);
      }
    }
  }
}

// Singleton instance
const registry = new ProcessorRegistry();

module.exports = {
  ProcessorRegistry,
  registry,
};
