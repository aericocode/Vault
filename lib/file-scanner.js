const fs = require('fs');
const path = require('path');
const config = require('../config');

// Lazy load processors to avoid circular dependency
let processors = null;
function getProcessors() {
  if (!processors) {
    processors = require('./processors');
  }
  return processors;
}

/**
 * Scan directory for media files
 * @param {string} dirPath - Directory to scan
 * @param {boolean} recursive - Whether to scan subdirectories
 * @param {object} options - Scan options
 * @param {boolean} options.useProcessorRegistry - Use processor registry for extensions
 * @returns {object[]} Array of file info objects
 */
function scan(dirPath, recursive = true, options = {}) {
  const { useProcessorRegistry = false } = options;
  
  let allExtensions;
  let getMediaTypeFunc;
  
  if (useProcessorRegistry) {
    const proc = getProcessors();
    allExtensions = proc.getSupportedExtensions();
    getMediaTypeFunc = (ext) => {
      const ProcessorClass = proc.registry.getByExtension(ext);
      return ProcessorClass ? ProcessorClass.mediaType : null;
    };
  } else {
    allExtensions = config.getAllExtensions();
    getMediaTypeFunc = (ext) => config.getMediaType(ext);
  }
  
  const files = [];
  
  function scanDir(currentPath) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch (err) {
      console.error(`Cannot read directory: ${currentPath} - ${err.message}`);
      return;
    }
    
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      
      if (entry.isDirectory() && recursive) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const mediaType = getMediaTypeFunc(ext);
        
        if (mediaType) {
          files.push({
            path: fullPath,
            name: entry.name,
            ext,
            mediaType
          });
        }
      }
    }
  }
  
  scanDir(dirPath);
  return files;
}

/**
 * Get file stats
 * @param {string} filepath - Path to file
 * @returns {object|null} File stats or null
 */
function getStats(filepath) {
  try {
    return fs.statSync(filepath);
  } catch {
    return null;
  }
}

/**
 * Check if path exists and is a directory
 */
function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check if path exists and is a file
 */
function isFile(filepath) {
  try {
    return fs.statSync(filepath).isFile();
  } catch {
    return false;
  }
}

module.exports = {
  scan,
  getStats,
  isDirectory,
  isFile,
};
