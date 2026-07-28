const path = require('path');
const config = require('../config');
const db = require('./database');

/**
 * Sanitize string for use in file paths
 */
function sanitize(str) {
  return (str || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Generate target path based on analysis
 */
function generateTargetPath(filepath, analysis, qualityFlag) {
  const contentType = sanitize(analysis.content_type);
  const theme = sanitize(analysis.themes?.[0] || 'misc');
  const language = sanitize(analysis.language);

  // No explicit/sfw level any more. The scan stopped classifying that (adult
  // media is the assumption, not a finding), so keeping the segment would have
  // filed every single file under a permanent "sfw" folder.
  const targetDir = path.join(config.paths.outputBase, contentType, theme, language);
  const filename = path.basename(filepath);
  
  return {
    targetDir,
    targetPath: path.join(targetDir, filename)
  };
}

/**
 * Generate shell command for move operation
 */
function generateMoveCommand(sourcePath, targetDir, targetPath) {
  if (config.isWindows) {
    return `if not exist "${targetDir}" mkdir "${targetDir}" && move "${sourcePath}" "${targetPath}"`;
  }
  return `mkdir -p "${targetDir}" && mv "${sourcePath}" "${targetPath}"`;
}

/**
 * Create and save a pending move operation
 */
function createMoveOperation(mediaId, filepath, analysis, qualityFlag) {
  const { targetDir, targetPath } = generateTargetPath(filepath, analysis, qualityFlag);
  const command = generateMoveCommand(filepath, targetDir, targetPath);
  
  db.savePendingOperation(mediaId, 'move', filepath, targetPath, command);
  
  return { targetDir, targetPath, command };
}

module.exports = {
  sanitize,
  generateTargetPath,
  generateMoveCommand,
  createMoveOperation,
};
