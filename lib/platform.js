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

/**
 * What to tell someone whose Vault has no encryption module
 * (better-sqlite3-multiple-ciphers, an optional dependency): it can then
 * neither open nor create an encrypted library (VAULT_NO_CIPHER). The module
 * is compiled from source wherever npm finds no prebuilt for that Node, which
 * on Linux means build tools must be installed. The packaged app ships the
 * module itself, so there the only fix is a fresh download.
 * @param {object} [o]  platform / isSea (tests)
 * @returns {string} plain sentences, no file paths
 */
function cipherMissingHelp({ platform = process.platform, isSea = require('./approot').isSea } = {}) {
  if (isSea) {
    return 'The encryption module is missing from this copy of Vault. Download Vault again and replace this folder\'s Vault program and runtime folder.';
  }
  if (platform === 'linux') {
    return 'The encryption module (better-sqlite3-multiple-ciphers) did not install, usually because build tools are missing. '
      + 'Install them (Ubuntu or Debian: sudo apt install build-essential python3. Fedora: sudo dnf install gcc-c++ make python3. '
      + 'Arch: sudo pacman -S base-devel python), then run npm install again in Vault\'s folder.';
  }
  if (platform === 'darwin') {
    return 'The encryption module (better-sqlite3-multiple-ciphers) did not install. '
      + 'Install the Xcode command line tools (xcode-select --install), then run npm install again in Vault\'s folder.';
  }
  return 'The encryption module (better-sqlite3-multiple-ciphers) did not install. Run npm install again in Vault\'s folder.';
}

module.exports = { CASE_INSENSITIVE_PATHS, BACKSLASH_SEPARATES, openUrl, cipherMissingHelp };
