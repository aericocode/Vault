/**
 * Extensions that browsers can natively play/render (no plugin needed).
 *
 * Server copy of BROWSER_PLAYABLE_EXTENSIONS in player-lib/filters.js, which
 * the library's "★ safe" toggle and the extension play stars read. The server
 * needs the same list now that filters run in SQL (lib/library-query.js).
 * test/playable-extensions.test.js parses the browser file and fails when the
 * two lists drift, so edit both together.
 */
const BROWSER_PLAYABLE_EXTENSIONS = [
  // Video
  'mp4', 'webm', 'ogg', 'ogv', 'mov',
  // Audio
  'mp3', 'wav', 'ogg', 'oga', 'webm', 'aac', 'flac', 'm4a', 'opus',
  // Image
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'jfif',
  // Document
  'pdf', 'txt', 'html', 'htm', 'json', 'xml', 'csv', 'md',
];

module.exports = { BROWSER_PLAYABLE_EXTENSIONS: new Set(BROWSER_PLAYABLE_EXTENSIONS) };
