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
/**
 * Extension → media type, by the same rules scan() applies.
 *
 * Exported so a caller that needs its OWN walk — commands/migrate.js runs an
 * async, paced one so a 100k-file tree doesn't seize the server's event loop —
 * can classify files identically without copying the extension table. scan()
 * itself is unchanged and still synchronous for every existing caller.
 *
 * @returns {string|null} media type, or null when the extension isn't media
 */
function mediaTypeForExt(ext, { useProcessorRegistry = false } = {}) {
  if (useProcessorRegistry) {
    const proc = getProcessors();
    const ProcessorClass = proc.registry.getByExtension(ext);
    return ProcessorClass ? ProcessorClass.mediaType : null;
  }
  return config.getMediaType(ext);
}

function scan(dirPath, recursive = true, options = {}) {
  const { useProcessorRegistry = false } = options;

  const getMediaTypeFunc = (ext) => mediaTypeForExt(ext, { useProcessorRegistry });

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
  mediaTypeForExt,
  getStats,
  isDirectory,
  isFile,
};
