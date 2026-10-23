/* =========================================================================
   ICONS - the Modern look's line icons, in place of the app's own emoji.

   One small set: 24 x 24, drawn with the text color (stroke currentColor),
   one stroke weight, sized 1em so each icon takes the font size of where it
   sits. Classic keeps every emoji it has today.

   Live switching without a re-render: a swapped spot carries BOTH the emoji
   and the icon, and the look's body class picks which one shows
   (css/icons.css: .vi-c holds the emoji, .modern-only the icon). So switching looks
   in Settings updates every tile, button and tab at once, and the emoji's
   text stays in textContent for anything that reads it.

   - vaultIcon(name, cls)          one <svg> (aria-hidden), '' for an unknown name
   - vaultIconSwap(emoji, name)    emoji for Classic + icon for Modern
   - vaultTypeIcon(mediaType)      the file type icon tiles show with no picture
   - vaultStripLeadingEmoji(text)  "💾 Saved" -> "Saved" (toasts, in Modern)
   - vaultToastText(text)          the toast's words for the current look
   - vaultIconsUpgrade(root)       fill static markup: <span data-vi="name">📚 </span>
   ========================================================================= */

/* Inner SVG markup per icon. Paths only: the <svg> wrapper sets stroke,
   fill and weight for all of them. */
const VAULT_ICONS = {
  // Header tabs
  library: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  editor: '<path d="M4 7h9M18 7h2M4 17h2M11 17h9"/><circle cx="15.5" cy="7" r="2.3"/><circle cx="8.5" cy="17" r="2.3"/>',
  games: '<rect x="2.5" y="7" width="19" height="11" rx="5"/><path d="M7.5 10.5v4M5.5 12.5h4"/><path d="M15.5 11.5h.01M18 14h.01"/>',
  wall: '<rect x="3.5" y="3.5" width="9" height="8" rx="1.2"/><rect x="15" y="3.5" width="5.5" height="11" rx="1.2"/><rect x="3.5" y="14" width="9" height="6.5" rx="1.2"/><rect x="15" y="17" width="5.5" height="3.5" rx="1.2"/>',
  // Header buttons and the status pill
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  flame: '<path d="M12 21.5c3.9 0 6.5-2.8 6.5-6.5 0-3.6-2.6-5.6-3.8-9.5-1.8 1.7-2.7 3.6-2.7 5.4-.9-.8-1.8-1.9-2-3.8-2.1 1.9-4.5 4.7-4.5 7.9 0 3.7 2.6 6.5 6.5 6.5z"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="M11.2 11.8 20 3M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z"/><path d="M14 3.5v5h5"/>',
  // Library toolbar
  filter: '<path d="M4 5h16l-6 7.5v6l-4-2v-4z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.4-4.4"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
  table: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  dock: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M14.5 4.5v15"/>',
  heart: '<path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/>',
  trash: '<path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>',
  rescan: '<path d="M4 13a8 8 0 1 0 2.3-5.7"/><path d="M4 4.5V10h5.5"/>',
  // Dock
  play: '<path d="M7.5 5v14l11-7z"/>',
  flag: '<path d="M5.5 21V4M5.5 4.5h11l-2.2 4.2 2.2 4.3h-11"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  // Mini player (player-lib/player/mini-player.js). Forward is rewind
  // mirrored in css/mini-player.css, which keeps the set small.
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  expand: '<path d="M14 4.5h5.5V10M10 19.5H4.5V14M19.5 4.5 13 11M4.5 19.5 11 13"/>',
  pip: '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="6.5" height="5.5" rx="1"/>',
  rewind: '<path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
  // File types (tiles waiting for a picture, or with thumbnails Off)
  video: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7.5 4.5v15M16.5 4.5v15M3 9.5h4.5M3 14.5h4.5M16.5 9.5H21M16.5 14.5H21"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-9.5 8.5"/>',
  gif: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  audio: '<path d="M9 18V5.5l11-2v12.5"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  mix: '<path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',
  // Tile badges and hover buttons
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5h.01"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  alert: '<path d="M10.3 4.2 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17h.01"/>',
  note: '<path d="M5 4.5h14v10l-5 5H5z"/><path d="M14 19.5v-5h5M8.5 9h7M8.5 12.5h4"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  drop: '<path d="M12 3.5s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10.5 12 3.5 12 3.5z"/>',
  // Editor song cards
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><path d="M12 17h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  // Editor, Games, the selection bar
  save: '<path d="M5 3.5h11l3.5 3.5v11.5a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2v-13a2 2 0 0 1 1.5-2z"/><path d="M8 3.5v5h7v-5M8 20.5v-6h8v6"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 15v3.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V15"/>',
  box: '<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9"/>',
  zap: '<path d="M13 3 5 13.5h6.5L11 21l8-10.5h-6.5z"/>',
  scale: '<path d="M12 4v16M8 20h8M5 7h14"/><path d="m5 7-2.5 6a2.5 2.5 0 0 0 5 0zM19 7l-2.5 6a2.5 2.5 0 0 0 5 0z"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  shuffle: '<path d="M3.5 7h3.5c4.5 0 5.5 10 10 10h3.5M3.5 17h3.5c1.6 0 2.7-1.2 3.6-2.8M13.4 9.8C14.3 8.2 15.4 7 17 7h3.5"/><path d="m18 4.5 2.5 2.5L18 9.5M18 14.5l2.5 2.5-2.5 2.5"/>',
  timer: '<circle cx="12" cy="13.5" r="7"/><path d="M12 13.5v-3.5M10 3h4"/>',
  puzzle: '<path d="M5 8.5h3.5a2 2 0 1 1 4 0H16v3.5a2 2 0 1 1 0 4V19.5H5V16a2 2 0 1 0 0-4z"/>',
  scissors: '<circle cx="6.5" cy="7" r="2.5"/><circle cx="6.5" cy="17" r="2.5"/><path d="M8.6 8.4 20 17M8.6 15.6 20 7"/>',
  building: '<rect x="5" y="3.5" width="14" height="17" rx="1"/><path d="M9 7.5h2M13 7.5h2M9 11h2M13 11h2M9 14.5h2M13 14.5h2M10.5 20.5v-3h3v3"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  chevron: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  stack: '<rect x="4" y="4" width="12" height="9" rx="1.5"/><rect x="8" y="11" width="12" height="9" rx="1.5"/>',
  // Folder watchers (player-lib/watchers-ui.js)
  more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  // The AI scan panel (player-lib/importer.js)
  spark: '<path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z"/><path d="M18.5 16.5v4M16.5 18.5h4"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  // The Modern Settings menu (player-lib/settings-kit.js)
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  chip: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M9.5 3v3.5M14.5 3v3.5M9.5 17.5V21M14.5 17.5V21M3 9.5h3.5M3 14.5h3.5M17.5 9.5H21M17.5 14.5H21"/>',
  plug: '<path d="M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 0 1-11 0z"/><path d="M12 17v4"/>',
  book: '<path d="M4.5 5.5a2 2 0 0 1 2-2h13v15h-13a2 2 0 0 0-2 2z"/><path d="M4.5 20.5v-15M19.5 18.5v2h-13"/>',
  // The Modern player's dock (player-lib/player/player-modern.js). Drawn at
  // stroke 1.75 there (css/player/player-modern.css); the numbers and letters
  // inside skip, A-B and repeat-one are filled text, not strokes.
  'play-fill': '<path d="M8 5l11 7-11 7z" fill="currentColor"/>',
  'pause-bold': '<path d="M7 5h2.6v14H7zM14.4 5H17v14h-2.6z" fill="currentColor" stroke="none"/>',
  'prev-file': '<path d="M6 5v14M19 5l-10 7 10 7z"/>',
  'next-file': '<path d="M18 5v14M5 5l10 7-10 7z"/>',
  'back-ten': '<path d="M12 4a8 8 0 1 1-7.4 5"/><path d="M4 3.5v5.5h5.5"/><text x="12" y="15.5" text-anchor="middle" font-size="7" font-weight="700" font-family="system-ui,sans-serif" fill="currentColor" stroke="none">10</text>',
  'fwd-ten': '<path d="M12 4a8 8 0 1 0 7.4 5"/><path d="M20 3.5v5.5h-5.5"/><text x="12" y="15.5" text-anchor="middle" font-size="7" font-weight="700" font-family="system-ui,sans-serif" fill="currentColor" stroke="none">10</text>',
  hot: '<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8 0 4 3 7 7 7z"/><path d="M12 22c-1.7 0-3-1.3-3-3 0-1.6 1.5-2.8 3-5 1.5 2.2 3 3.4 3 5 0 1.7-1.3 3-3 3z"/>',
  'done-tick': '<path d="M5 3h14v18l-7-4-7 4z"/><path d="M8.5 9.5l2.5 2.5 4.5-5"/>',
  'face-scan': '<path d="M4 8V5h3M17 5h3v3M4 16v3h3M17 19h3v-3"/><circle cx="12" cy="10.5" r="2.7"/><path d="M7.8 17.5a4.3 4.3 0 0 1 8.4 0"/>',
  vibe: '<rect x="9" y="4" width="6" height="16" rx="3"/><path d="M5.5 9a4.5 4.5 0 0 0 0 6M18.5 9a4.5 4.5 0 0 1 0 6M2.5 6.5a8.5 8.5 0 0 0 0 11M21.5 6.5a8.5 8.5 0 0 1 0 11"/>',
  beat: '<rect x="2" y="7" width="20" height="10" rx="5"/><path d="M8 4.5v15"/><circle cx="8" cy="12" r="2.2" fill="currentColor" stroke="none"/><circle cx="13" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  'ab-loop': '<path d="M5 12a7 7 0 0 1 14 0"/><path d="M16.5 9.5l2.5 2.5 2.2-2.8"/><text x="5" y="21" text-anchor="middle" font-size="8.5" font-weight="800" font-family="system-ui,sans-serif" fill="currentColor" stroke="none">A</text><text x="19" y="21" text-anchor="middle" font-size="8.5" font-weight="800" font-family="system-ui,sans-serif" fill="currentColor" stroke="none">B</text>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  'repeat-one': '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/><text x="12" y="14.8" text-anchor="middle" font-size="7.5" font-weight="800" font-family="system-ui,sans-serif" fill="currentColor" stroke="none">1</text>',
  cc: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M10.5 10.2a2.2 2.2 0 1 0 0 3.6M17 10.2a2.2 2.2 0 1 0 0 3.6"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  'fullscreen-exit': '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  fit: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 9l-2 3 2 3M16 9l2 3-2 3"/>',
  'chev-left': '<path d="M15 6l-6 6 6 6"/>',
  'chev-right': '<path d="M9 6l6 6-6 6"/>',
};

/* Emoji the app leads its own labels with, and the icon that stands in for
   each in Modern. A label whose emoji is not here shows its words alone. */
const VAULT_EMOJI_ICONS = {
  '📁': 'folder', '🗂': 'folder', '🗑': 'trash', '♻': 'rescan', '↻': 'rescan', '🔄': 'refresh',
  '🎵': 'audio', '🎬': 'video', '🎛': 'mix', '🎚': 'editor', '🖼': 'image', '🎞': 'gif',
  '💾': 'save', '📤': 'upload', '⬆': 'upload', '⬇': 'download', '📦': 'box', '⚡': 'zap', '⚖': 'scale',
  '⬅': 'back', '🔀': 'shuffle', '⏱': 'timer', '🧩': 'puzzle', '▶': 'play', '🔍': 'search',
  '🚩': 'flag', '🏳': 'flag', '✂': 'scissors', '👤': 'person', '🏢': 'building', '▤': 'stack', '▦': 'grid',
  '＋': 'plus', '➕': 'plus', '❓': 'help', '🔗': 'link', '🎮': 'games', '⚙': 'gear', '🕘': 'clock',
};

/**
 * A label that starts with an emoji ("💾 Saved mixes"): Classic keeps the
 * emoji, Modern shows the matching line icon (icon: false, or no icon for
 * that emoji: the words alone). The words are HTML already; only the emoji
 * is escaped. A label with no leading emoji comes back as it was.
 */
function vaultEmojiLabel(label, { icon = true } = {}) {
  const s = String(label == null ? '' : label);
  const m = s.match(VAULT_ONE_LEADING_EMOJI);
  if (!m) return s;
  const base = m[0].trim().replace(/[︎️]/g, '');
  const name = icon ? VAULT_EMOJI_ICONS[base] : null;
  const words = s.slice(m[0].length);
  const lead = `<span class="vi-c">${vaultIconEsc(m[0])}</span>`;
  return lead + (name ? vaultIcon(name, `modern-only${words ? ' vi-gap' : ''}`) : '') + words;
}

/* Which icon stands in for each file type, and for an unknown one. */
const VAULT_TYPE_ICON_NAMES = { video: 'video', image: 'image', gif: 'gif', audio: 'audio', document: 'file', mix: 'mix' };

function vaultIconEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One icon as an <svg> string, hidden from screen readers. '' for an unknown name. */
function vaultIcon(name, cls = '') {
  const inner = VAULT_ICONS[name];
  if (!inner) return '';
  return `<svg class="vi vi-${name}${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
    + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
}

/**
 * The emoji for Classic and the icon for Modern, side by side; the look's
 * body class shows one. A trailing space on the emoji ("📚 ") means words
 * follow, so the icon gets the same gap (.vi-gap).
 */
function vaultIconSwap(emoji, name) {
  const text = String(emoji == null ? '' : emoji);
  const icon = vaultIcon(name, `modern-only${/\s$/.test(text) ? ' vi-gap' : ''}`);
  if (!icon) return vaultIconEsc(text);
  return `<span class="vi-c">${vaultIconEsc(text)}</span>${icon}`;
}

/** The type icon for a tile with no picture: Classic's emoji, Modern's line icon. */
function vaultTypeIcon(mediaType) {
  const emoji = (typeof TILE_TYPE_ICONS !== 'undefined' && TILE_TYPE_ICONS[mediaType]) || '📁';
  return vaultIconSwap(emoji, VAULT_TYPE_ICON_NAMES[mediaType] || 'folder');
}

/* Emoji and the pictographic symbols the app leads its messages with
   (⚠ ✓ ✔ ✗ ✕ ↻ ⬇ ⬆ ♻ ✂ ▶ ＋), each as a whole sequence: variation selectors,
   skin tones, keycaps, tags, flags and ZWJ joins (👍🏽, 👨‍👩‍👧, 🏳️‍🌈). Stars are a
   rating, not decoration, so ★ ☆ are left alone. */
const VAULT_EMOJI_ONE = '(?:\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3'
  + '|(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|[\\u2190-\\u21FF\\u2300-\\u23FF\\u25A0-\\u25FF\\u2700-\\u27BF\\u2B00-\\u2BFF\\uFF0B])'
  + '[\\uFE0E\\uFE0F\\u20E3\\p{Emoji_Modifier}\\u{E0020}-\\u{E007F}]*)';
const VAULT_EMOJI_SEQ = `${VAULT_EMOJI_ONE}(?:\\u200D${VAULT_EMOJI_ONE})*`;
const VAULT_LEADING_EMOJI = new RegExp(`^(?:${VAULT_EMOJI_SEQ}\\s*)+`, 'u');
/** One leading emoji (a whole sequence) and the space after it. */
const VAULT_ONE_LEADING_EMOJI = new RegExp(`^${VAULT_EMOJI_SEQ}\\s*`, 'u');

/** "💾 Saved" -> "Saved". Text with no leading emoji, or only stars, comes back as it was. */
function vaultStripLeadingEmoji(text) {
  const s = String(text == null ? '' : text);
  if (/^[★☆]/.test(s)) return s;
  const out = s.replace(VAULT_LEADING_EMOJI, '');
  return out.trim() ? out : s;
}

function vaultIsModern() {
  return typeof window !== 'undefined' && typeof window.isModernLayout === 'function' && window.isModernLayout();
}

/** What a toast says in the current look: Modern drops the leading emoji. */
function vaultToastText(text) {
  return vaultIsModern() ? vaultStripLeadingEmoji(text) : String(text == null ? '' : text);
}

/**
 * Static markup names its icon: <span data-vi="library">📚 </span>. The
 * emoji stays for Classic and the icon is added for Modern. Safe to call
 * again: a filled spot is marked and skipped.
 */
function vaultIconsUpgrade(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope || typeof scope.querySelectorAll !== 'function') return;
  for (const el of scope.querySelectorAll('[data-vi]:not([data-vi-done])')) {
    el.innerHTML = vaultIconSwap(el.textContent, el.getAttribute('data-vi'));
    el.setAttribute('data-vi-done', '');
  }
}

// The header and toolbar are already parsed: this script loads right after utils.js.
if (typeof document !== 'undefined' && document.querySelectorAll) vaultIconsUpgrade(document);
