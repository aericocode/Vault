/* =========================================================================
   GAMES SIDEBAR - "Send to game" section in the player info sidebar.

   Follows the renderMusicSidebarSection shape (player-lib/music.js): returns
   an HTML shell synchronously. No async fill needed — the buttons just launch
   a game on the current file. Only shows for media types some game accepts.
   ========================================================================= */

// Client mirror of the server allowlist (server/games-routes.js GAME_ACCEPT_TYPES)
const GAMES_SIDEBAR_ENTRIES = [
  { key: 'reelorder', label: 'Reel Order', icon: '🎬', accept: ['video'] },
  { key: 'framefit', label: 'Frame Fit', icon: '🧩', accept: ['video', 'gif', 'image'] },
];

function renderGamesSidebarSection(media) {
  if (!media) return '';
  const usable = GAMES_SIDEBAR_ENTRIES.filter(g => g.accept.includes(media.media_type));
  if (!usable.length) return '';

  const btns = usable.map(g =>
    `<button class="games-btn" onclick="gamesSendToGame('${g.key}', ${media.id})" title="Open this ${escapeHtml(media.media_type)} in ${escapeHtml(g.label)}">
      ${g.icon} ${escapeHtml(g.label)}
    </button>`).join('');

  return `
    <div class="detail-section games-section">
      <h3>🎮 Games</h3>
      <div class="field-content games-sidebar-body">${btns}</div>
    </div>`;
}
