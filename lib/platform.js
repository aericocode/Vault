/**
 * Small platform facts shared across lib/, so each module does not guess.
 *
 * CASE_INSENSITIVE_PATHS: whether two paths that differ only in letter case
 * name the same file. True on Windows (NTFS) and macOS (APFS and HFS+ are
 * case-insensitive by default). False on Linux, where ext4, btrfs and xfs
 * keep A.mp4 and a.mp4 as two files: folding case there would bind or shield
 * the wrong row. Older code gates on `process.platform === 'win32'` directly;
 * new gates use this.
 */

const { spawn, exec } = require('child_process');

const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

/** Is \ a path separator? Windows only: on Linux and macOS it is a legal file-name character. */
const BACKSLASH_SEPARATES = process.platform === 'win32';

/**
 * Open a URL in the default browser. Never through a shell with the URL in
 * the command line, except the Windows `start` builtin, which only exists in
 * cmd and is given a URL Vault built itself (127.0.0.1 and a port number).
 * Failure is quiet: a headless box has no browser, and the server runs anyway.
 * @param {string} url
 * @param {object} [o]  platform / spawnFn / execFn (tests)
 * @returns {string} what was asked to open it ('start', 'open' or 'xdg-open')
 */
function openUrl(url, { platform = process.platform, spawnFn = spawn, execFn = exec } = {}) {
  if (platform === 'win32') {
    execFn(`start "" "${url}"`);
    return 'start';
  }
  const opener = platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawnFn(opener, [url], { detached: true, stdio: 'ignore', shell: false });
    child.on('error', () => {});     // no xdg-open (a minimal or headless install)
    child.unref();
  } catch { /* nothing to open it with */ }
  return opener;
}

module.exports = { CASE_INSENSITIVE_PATHS, BACKSLASH_SEPARATES, openUrl };
