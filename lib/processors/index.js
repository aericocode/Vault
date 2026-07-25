/**
 * Processors Index - Auto-discovers and registers all processors
 * 
 * Usage:
 *   const { registry, getProcessor } = require('./lib/processors');
 *   const processor = getProcessor('video.mp4');
 *   const result = await processor.process('video.mp4');
 */

const path = require('path');
const { registry } = require('./registry');
const BaseProcessor = require('./base-processor');

// Auto-discover processors in this directory
registry.autoDiscover(__dirname);

/**
 * Get processor instance for a file
 * @param {string} filepath - Path to file
 * @returns {BaseProcessor|null}
 */
function getProcessor(filepath) {
  return registry.createProcessor(filepath);
}

/**
 * Check if a file can be processed
 * @param {string} filepath - Path to file
 * @returns {boolean}
 */
function canProcess(filepath) {
  return registry.canProcess(filepath);
}

/**
 * Get all supported extensions
 * @returns {string[]}
 */
function getSupportedExtensions() {
  return registry.getSupportedExtensions();
}

/**
 * Get all processor types
 * @returns {string[]}
 */
function getProcessorTypes() {
  return registry.getProcessorTypes();
}

module.exports = {
  registry,
  getProcessor,
  canProcess,
  getSupportedExtensions,
  getProcessorTypes,
  BaseProcessor,
};
