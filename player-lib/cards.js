/* =========================================================================
   CARDS - Tile/card rendering and pagination

   Grid view renders compact thumbnail-first TILES (48/page, 6-8+ columns)
   with a hover popover for full details. List view keeps the original
   detail-rich card layout.
   ========================================================================= */

// Type icon fallbacks for tiles without thumbnails (audio, documents, 3D…)
const TILE_TYPE_ICONS = {
  video: '🎬',
  image: '🖼️',
  gif: '🎞️',
  audio: '🎵',
  document: '📄',
  mix: '🎛',
};

/**
 * Tooltip for the ⚠ tile badge. The badge used to read "Processing error" and
 * nothing else, so the one piece of information the user needed — WHICH error,
 * and therefore what to install — was reachable only by opening the details
 * modal, which nothing on the tile suggested. Truncated: a title attribute is a
 * glance, not a log; the modal shows the whole thing.
 * @param {string} msg - stored processing_error
 * @returns {string} plain text (the caller escapes it)
 */
const ERROR_TOOLTIP_MAX = 160;
function errorTooltip(msg) {
  const text = String(msg || '').trim();
  if (!text) return 'Processing error';
  const short = text.length > ERROR_TOOLTIP_MAX
    ? text.slice(0, ERROR_TOOLTIP_MAX - 1).trimEnd() + '…'
    : text;
  return `Processing error: ${short}`;
}

/* ── Adaptive grid: exact columns for the viewport, complete rows only ── */

const TILE_MIN_WIDTH = 170;  // px — matches the old minmax() minimum
const GRID_GAP = 12;         // px — 0.75rem
const TARGET_ROWS = 5;       // rows per page (9 cols × 5 = 45 on a 4K screen)

/**
 * Compute the column count that fits, pin the grid to exactly that many
 * columns, and set pageSize = columns × TARGET_ROWS so the last row is
 * never ragged. Returns true if pageSize changed.
 */
function updateGridLayout() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return false;

  const width = grid.clientWidth;
  if (!width) return false;

  const cols = Math.max(2, Math.floor((width + GRID_GAP) / (TILE_MIN_WIDTH + GRID_GAP)));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  const newSize = cols * TARGET_ROWS;
  if (newSize === pageSize) return false;

  pageSize = newSize;
  // Clamp the current page so a resize can't strand us past the end
  const totalPages = Math.max(1, Math.ceil(filteredMedia.length / pageSize));
  if (currentPage > totalPages) currentPage = totalPages;
  return true;
}

function renderResults() {
  updateGridLayout();

  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  const pageItems = filteredMedia.slice(start, end);

  document.getElementById('filteredCount').textContent = filteredMedia.length.toLocaleString();
  document.getElementById('showingCount').textContent = pageItems.length.toLocaleString();

  const resultsGrid = document.getElementById('resultsGrid');
  const collCards = typeof renderCollectionCards === 'function' ? renderCollectionCards() : '';
  resultsGrid.innerHTML = collCards + pageItems.map(m => renderTile(m)).join('');
  renderPagination();

  // Keep the selection bar's "Select page" count/state in sync after paging
  if (typeof renderSelectionBar === 'function') renderSelectionBar();
}

/* ── Compact tile (grid view) ──────────────────────────────────────────────
   The filename `title=` tooltip below is written conditionally: a native
   tooltip cannot be blurred by CSS, so the only way to stop a hover printing
   the name in the clear is to not write the attribute at all. It is dropped
   when privacy mode is hiding FILE NAMES specifically (body.pm-names) rather
   than for privacy mode as a whole — with names left visible the tooltip leaks
   nothing the tile is not already showing. settings.js repaints the grid when
   either the mode or that choice changes. */

function renderTile(media) {
  const isFlagged = !!media.user_flagged_delete;
  const isTrashed = !!media.user_trashed;
  const hasNotes = media.user_notes && media.user_notes !== '[]' && media.user_notes !== '';
  const isUnscanned = media.processing_error === 'unscanned';
  const hasError = !!media.processing_error && !isUnscanned;
  const rating = media.user_rating || 0;
  const duration = media.duration_seconds ? formatDuration(media.duration_seconds) : '';
  const icon = TILE_TYPE_ICONS[media.media_type] || '📁';
  const canThumb = ['image', 'gif', 'video', 'mix'].includes(media.media_type);
  const isMix = media.media_type === 'mix';
  const isSelected = typeof selectedIds !== 'undefined' && selectedIds.has(media.id);

  // Can this file play at all? The chips ask the same question (filters.js);
  // here the answer only ever adds the ⚠ that playback_failed used to add on
  // its own, now also for files whose codecs this browser has no decoder for
  // and no remux path to.
  const playState = typeof mediaPlaybackState === 'function'
    ? mediaPlaybackState(media)
    : { state: media.playback_failed ? 'no' : 'unknown', reason: 'Failed to play' };
  const cannotPlay = playState.state === 'no';
  const cannotPlayWhy = playState.reason || 'Failed to play';

  // Small indicator row: only what matters at a glance
  const views = media.view_count || 0;
  const doneCount = media.done_count || 0;
  const hotCount = media.hot_count || 0;
  const indicators = [
    views > 0 ? `<span class="tile-ind ind-views" title="Viewed ${views}×">👁${views > 1 ? views : ''}</span>` : '',
    media.user_starred ? '<span class="tile-ind ind-star" title="Fave">❤</span>' : '',
    rating > 0 ? `<span class="tile-ind ind-rating" title="Rated ${rating}/5">${rating}</span>` : '',
    isFlagged ? '<span class="tile-ind ind-flag" title="Flagged">🚩</span>' : '',
    media.dupe_group ? '<span class="tile-ind ind-dupe" title="Confirmed duplicate — notes shared">⧉</span>' : '',
    isTrashed ? '<span class="tile-ind ind-trashed" title="In trash">🗑</span>' : '',
    cannotPlay ? `<span class="tile-ind ind-error" title="${escapeHtml(cannotPlayWhy)}">⚠</span>` : '',
    hasNotes ? '<span class="tile-ind ind-notes" title="Has notes">📝</span>' : '',
    hasError ? `<span class="tile-ind ind-error" title="${escapeHtml(errorTooltip(media.processing_error))}">⚠</span>` : '',
    isUnscanned ? '<span class="tile-ind ind-unscanned" title="Not scanned yet — AI analysis pending">⏳</span>' : '',
    (typeof mediaSongIds === 'function' && mediaSongIds(media.id).length > 0)
      ? `<span class="tile-ind ind-music" title="${mediaSongIds(media.id).length} song(s) identified">🎵</span>` : '',
  ].filter(Boolean).join('');

  // Hot 🔥 / Done 💦 markers live at the thumb's bottom-LEFT (opposite the
  // duration, which sits bottom-right) to save room on the indicator bar.
  const hotDone = [
    hotCount > 0 ? `<span class="hd-hot" title="Intense moments marked ${hotCount}×">🔥${hotCount > 1 ? hotCount : ''}</span>` : '',
    doneCount > 0 ? `<span class="hd-done" title="Finishers: sessions ended here ${doneCount}×">💦${doneCount > 1 ? doneCount : ''}</span>` : '',
  ].filter(Boolean).join('');

  const thumb = canThumb
    ? `<img class="tile-img" loading="lazy" src="/thumb/${media.id}" alt=""
         onerror="this.parentElement.classList.add('thumb-fallback'); this.remove();">`
    : '';

  // Custom mixes are virtual files — nothing on disk to trash
  const dMode = typeof getDeleteMode === 'function' ? getDeleteMode() : 'soft';
  const delTitle = dMode === 'hard' ? 'Delete permanently (no undo)'
    : dMode === 'recycle' ? 'Delete to Recycle Bin' : 'Move to trash';
  const trashBtn = isMix ? '' : (isTrashed
    ? `<button class="tile-btn" onclick="restoreSingle(${media.id})" title="Restore from trash">♻</button>`
    : `<button class="tile-btn ${dMode !== 'soft' ? 'tile-btn-danger' : ''}" onclick="trashSingle(${media.id})" title="${delTitle}">🗑</button>`);

  // Resume progress sliver (video/audio with a stored position)
  const resumePct = (['video', 'audio'].includes(media.media_type) &&
    media.last_position > 0 && media.duration_seconds > 0)
    ? Math.min(100, (media.last_position / media.duration_seconds) * 100)
    : 0;

  // Audio-similarity mode: show each tile's % match to the anchor file
  let simChip = '';
  if (typeof audioSimScores !== 'undefined' && audioSimScores) {
    if (media.id === audioSimAnchorId) {
      simChip = '<span class="tile-badge sim-badge sim-anchor" title="Similarity anchor — other files are ranked against this one">≈ anchor</span>';
    } else if (audioSimScores.has(media.id)) {
      simChip = `<span class="tile-badge sim-badge" title="Audio similarity: rarity-weighted share of songs in common with the anchor">≈${Math.round(audioSimScores.get(media.id) * 100)}%</span>`;
    }
  }

  return `
    <div class="media-tile ${isFlagged ? 'tile-flagged' : ''} ${isTrashed ? 'tile-trashed' : ''} ${isSelected ? 'tile-selected' : ''} ${cannotPlay ? 'tile-failed' : ''} ${media.id === lastOpenedMediaId ? 'tile-last-opened' : ''} ${(typeof isCardBusy === 'function' && isCardBusy(media.id)) ? 'tile-busy' : ''}" data-id="${media.id}">
      <div class="tile-thumb ${canThumb ? '' : 'thumb-fallback'}" onclick="playMediaById(${media.id})">
        ${thumb}
        <span class="tile-type-icon">${icon}</span>
        ${duration ? `<span class="tile-duration">${duration}</span>` : ''}
        ${hotDone ? `<span class="tile-hotdone">${hotDone}</span>` : ''}
        ${resumePct > 2 ? `<div class="tile-resume" style="width:${resumePct.toFixed(1)}%" title="Resume at ${formatDuration(media.last_position)}"></div>` : ''}
        <input type="checkbox" class="tile-select" ${isSelected ? 'checked' : ''}
          onclick="onTileSelect(event, ${media.id})" title="Select (shift-click for range)">
        <div class="tile-actions" onclick="event.stopPropagation()">
          <button class="tile-btn ${media.user_starred ? 'active-star' : ''}" onclick="toggleStar(mediaPathById(${media.id}))" title="${media.user_starred ? 'Remove Fave' : 'Fave'}">${media.user_starred ? '❤' : '🤍'}</button>
          <button class="tile-btn ${isFlagged ? 'active-flag' : ''}" onclick="toggleFlagDelete(mediaPathById(${media.id}))" title="${isFlagged ? 'Unflag' : 'Flag'}">🚩</button>
          ${trashBtn}
          <button class="tile-btn" onclick="showDetailsById(${media.id})" title="Details">ⓘ</button>
        </div>
      </div>
      <div class="tile-name"${document.body.classList.contains('pm-names') ? '' : ` title="${escapeHtml(media.filename)}"`}>${escapeHtml(media.filename)}</div>
      <div class="tile-meta">
        <span class="tile-badge type-${media.media_type}">${media.media_type}</span>
        ${simChip}
        ${media.language_code && media.language_code !== 'none' ? `<span class="tile-badge lang" title="${escapeHtml(media.language_name || '')}">${escapeHtml(media.language_code.toUpperCase())}</span>` : ''}
        <span class="tile-indicators">${indicators}</span>
      </div>
    </div>
  `;
}

/** Look up helpers used by inline tile handlers */
function mediaPathById(id) {
  const m = getMediaById(id);
  return m ? m.filepath : '';
}

function playMediaById(id) {
  const m = getMediaById(id);
  if (!m) return;
  hideTilePopover();
  // Mixes play in the main player too (renderMixPlayer); the sidebar's
  // "🎛 Open in Editor" button covers tweaking
  playMedia({ filepath: m.filepath, filename: m.filename, media_type: m.media_type });
}

function showDetailsById(id) {
  const m = getMediaById(id);
  if (!m) return;
  hideTilePopover();
  showDetails(m);
}

/* ── Hover popover (grid view) ─────────────────────────────────────────── */

let _popoverTimer = null;
let _popoverForId = null;

function ensureTilePopover() {
  let el = document.getElementById('tilePopover');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tilePopover';
    el.className = 'tile-popover';
    document.body.appendChild(el);
    // Keep the popover open while the pointer is over it
    el.addEventListener('mouseleave', hideTilePopover);
  }
  return el;
}

function buildPopoverHtml(media) {
  const themes = safeParseJSON(media.themes, []);
  const tags = safeParseJSON(media.tags, []);
  const allTags = [...themes, ...tags].slice(0, 12);
  const duration = media.duration_seconds ? formatDuration(media.duration_seconds) : '';
  const fileSize = media.filesize_bytes ? formatFileSize(media.filesize_bytes) : '';
  const rating = media.user_rating || 0;

  const flags = [
    media.user_starred ? '❤ Fave' : '',
    rating > 0 ? `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}` : '',
    media.user_flagged_delete ? '🚩 Flagged' : '',
    media.dupe_group ? '⧉ Dupe (notes shared)' : '',
    media.user_trashed ? '🗑 In trash' : '',
    media.playback_failed ? '⚠ Failed to play' : '',
  ].filter(Boolean);

  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const songCount = typeof mediaSongIds === 'function' ? mediaSongIds(media.id).length : 0;

  return `
    <div class="pop-title">${escapeHtml(media.filename)}</div>
    ${media.description ? `<div class="pop-desc">${escapeHtml(media.description)}</div>` : ''}
    ${allTags.length ? `<div class="pop-tags">${allTags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
    <div class="pop-meta">${[duration, fileSize, media.quality_flag, media.content_type, `👁 ${media.view_count || 0} views`].filter(Boolean).join(' • ')}</div>
    <div class="pop-path" title="${escapeHtml(media.filepath)}">
      <span class="pop-path-text">📁 ${escapeHtml(media.filepath)}</span>
      <button class="pop-path-copy" onclick="copyPath('${escapedPath}')" title="Copy full path">⧉</button>
    </div>
    ${flags.length ? `<div class="pop-flags">${flags.join(' &nbsp; ')}</div>` : ''}
    ${songCount > 0 && typeof startAudioSimilarity === 'function' ? `
      <div class="pop-actions">
        <button class="pop-action-btn" onclick="startAudioSimilarity(${media.id})"
          title="Rank the library by shared songs with this file">≈ Similar audio (${songCount} song${songCount === 1 ? '' : 's'})</button>
      </div>` : ''}
  `;
}

function showTilePopover(tileEl, media) {
  const pop = ensureTilePopover();
  pop.innerHTML = buildPopoverHtml(media);
  pop.classList.add('visible');
  _popoverForId = media.id;

  // Position beside the tile, clamped to the viewport
  const rect = tileEl.getBoundingClientRect();
  pop.style.left = '0px';
  pop.style.top = '0px';
  const popW = Math.min(340, window.innerWidth - 24);
  pop.style.width = popW + 'px';

  let left = rect.right + 8;
  if (left + popW > window.innerWidth - 12) {
    left = rect.left - popW - 8;           // flip to the left side
  }
  if (left < 12) left = 12;                 // clamp

  const popH = pop.offsetHeight;
  let top = rect.top;
  if (top + popH > window.innerHeight - 12) {
    top = window.innerHeight - popH - 12;
  }
  if (top < 12) top = 12;

  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hideTilePopover() {
  clearTimeout(_popoverTimer);
  _popoverTimer = null;
  _popoverForId = null;
  const pop = document.getElementById('tilePopover');
  if (pop) pop.classList.remove('visible');
}

/* ── Hover-scrub: cycle preview frames on video tiles (YouTube-style) ──── */

const SCRUB_FRAMES = 5;
const SCRUB_INTERVAL_MS = 450;

let _scrub = { id: null, timer: null, idx: 0, img: null };

function startScrub(tile, media) {
  if (media.media_type !== 'video' || !media.duration_seconds || media.duration_seconds < 3) return;
  const img = tile.querySelector('.tile-img');
  if (!img) return; // no thumbnail rendered (fallback icon)

  stopScrub();
  _scrub = { id: media.id, timer: null, idx: 0, img };

  _scrub.timer = setInterval(() => {
    if (!img.isConnected) { stopScrub(); return; }
    // onerror: fall back to the static thumb (e.g. scrub frame unavailable)
    img.onerror = () => { img.onerror = null; img.src = `/thumb/${media.id}`; };
    img.src = `/scrub/${media.id}/${_scrub.idx}`;
    _scrub.idx = (_scrub.idx + 1) % SCRUB_FRAMES;
  }, SCRUB_INTERVAL_MS);
}

function stopScrub() {
  if (_scrub.timer) clearInterval(_scrub.timer);
  if (_scrub.img && _scrub.img.isConnected && _scrub.id != null) {
    _scrub.img.onerror = null;
    _scrub.img.src = `/thumb/${_scrub.id}`; // restore the static thumb
  }
  _scrub = { id: null, timer: null, idx: 0, img: null };
}

/**
 * Reusable hover-scrub for any tile grid whose tiles carry a data-id and a
 * .tile-img (games picker, PMV picker, …). Same YouTube-style frame cycling
 * as the main library grid. Bound once per container element — safe to call
 * again after the container is re-created by an innerHTML swap.
 */
function attachHoverScrub(container) {
  if (!container || container._scrubBound) return;
  container._scrubBound = true;

  container.addEventListener('mouseover', (e) => {
    const tile = e.target.closest('[data-id]');
    if (!tile || !container.contains(tile)) return;
    const id = Number(tile.dataset.id);
    if (!id || id === _scrub.id) return;
    const media = getMediaById(id);
    if (media) startScrub(tile, media);
  });

  container.addEventListener('mouseout', (e) => {
    const tile = e.target.closest('[data-id]');
    if (!tile) return;
    const to = e.relatedTarget;
    if (to && tile.contains(to)) return;   // moving within the same tile
    stopScrub();
  });
}

// Delegated hover handling on the results grid
(function initTilePopover() {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return;

  grid.addEventListener('mouseover', (e) => {
    const tile = e.target.closest('.media-tile');
    if (!tile) return;
    const id = Number(tile.dataset.id);

    // Hover-scrub for videos (independent of the popover delay)
    if (id !== _scrub.id) {
      const media = getMediaById(id);
      if (media) startScrub(tile, media);
    }

    if (id === _popoverForId) return;

    clearTimeout(_popoverTimer);
    _popoverTimer = setTimeout(() => {
      const media = getMediaById(id);
      if (media && tile.isConnected) showTilePopover(tile, media);
    }, 150);
  });

  grid.addEventListener('mouseout', (e) => {
    const tile = e.target.closest('.media-tile');
    if (!tile) return;
    // Ignore moves within the same tile or into the popover itself
    const to = e.relatedTarget;
    if (to && (tile.contains(to) || to.closest?.('#tilePopover'))) return;
    stopScrub();
    clearTimeout(_popoverTimer);
    _popoverTimer = null;
    // Small grace period so the pointer can travel into the popover
    setTimeout(() => {
      const pop = document.getElementById('tilePopover');
      if (pop && !pop.matches(':hover') && !document.querySelector('.media-tile:hover')) {
        hideTilePopover();
      }
    }, 80);
  });

  // Hide on scroll — stale positioning looks broken
  window.addEventListener('scroll', () => { hideTilePopover(); stopScrub(); }, { passive: true });
})();

/* ── Detail-rich card (list view) ──────────────────────────────────────── */

function renderCard(media) {
  const themes = safeParseJSON(media.themes, []);
  const tags = safeParseJSON(media.tags, []);
  const allTags = [...themes, ...tags].slice(0, 6);

  const duration = media.duration_seconds
    ? formatDuration(media.duration_seconds)
    : '';

  const fileSize = media.filesize_bytes
    ? formatFileSize(media.filesize_bytes)
    : '';

  const cardUnscanned = media.processing_error === 'unscanned';
  const hasError = media.processing_error && !cardUnscanned;
  const hasNotes = media.user_notes && media.user_notes !== '[]' && media.user_notes !== '';
  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const isFlagged = media.user_flagged_delete ? true : false;

  return `
    <div class="media-card ${isFlagged ? 'card-flagged' : ''}">
      <div class="card-header">
        <div class="card-title">${escapeHtml(media.filename)}</div>
        <div class="card-path">
          <span>${escapeHtml(truncatePath(media.filepath))}</span>
          <button onclick="copyPath('${escapedPath}')">Copy Path</button>
        </div>
      </div>
      <div class="card-body">
        <div class="card-meta">
          <span class="meta-badge type-${media.media_type}">${media.media_type}</span>
          ${media.language_code && media.language_code !== 'none' ? `<span class="meta-badge language" title="${escapeHtml(media.language_name || '')}">${escapeHtml(media.language_code.toUpperCase())}</span>` : ''}
          ${media.content_type ? `<span class="meta-badge">${media.content_type}</span>` : ''}
          ${hasError ? `<span class="meta-badge error" title="${escapeHtml(errorTooltip(media.processing_error))}" data-error="${escapeHtml(media.processing_error)}">⚠ Error</span>` : ''}
          ${cardUnscanned ? '<span class="meta-badge unscanned-badge" title="AI analysis pending">⏳ Not scanned</span>' : ''}
          ${hasNotes ? '<span class="meta-badge has-notes">📝 Notes</span>' : ''}
          ${isFlagged ? '<span class="meta-badge flagged-badge">🚩 Flagged</span>' : ''}
          ${typeof renderDuplicateBadge === 'function' ? renderDuplicateBadge(media) : ''}
          ${typeof renderCardStarRating === 'function' ? renderCardStarRating(media) : ''}
        </div>
        ${media.description ? `<div class="card-description">${escapeHtml(media.description)}</div>` : ''}
        <div class="card-tags">
          ${allTags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
        </div>
      </div>
      <div class="card-footer">
        <span>${[duration, fileSize, media.quality_flag].filter(Boolean).join(' • ')}</span>
        <div style="display: flex; gap: 0.5rem; align-items: center;">
          <button class="expand-btn" onclick="showDetailsById(${media.id})">Details</button>
          <button class="play-btn" onclick="playMediaById(${media.id})">▶ Play</button>
        </div>
      </div>
      <div class="card-quick-actions">
        <button class="card-star-btn ${media.user_starred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleStar('${escapedPath}');" title="${media.user_starred ? 'Remove Fave' : 'Fave'}">${media.user_starred ? '❤' : '🤍'}</button>
        <div class="card-rating-inline">${renderCardInlineRating(media, escapedPath)}</div>
        <button class="card-flag-btn ${isFlagged ? 'flagged' : ''}" onclick="event.stopPropagation(); toggleFlagDelete('${escapedPath}');" title="${isFlagged ? 'Unflag' : 'Flag'}">🚩</button>
      </div>
    </div>
  `;
}

/**
 * Render inline clickable rating stars for a card.
 */
function renderCardInlineRating(media, escapedPath) {
  const rating = media.user_rating || 0;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= rating;
    html += `<button class="card-rating-star ${filled ? 'filled' : ''}" onclick="event.stopPropagation(); quickRate('${escapedPath}', ${i === rating ? 0 : i}, this)" title="${i === rating ? 'Clear' : i + '/5'}">${filled ? '★' : '☆'}</button>`;
  }
  return html;
}

/**
 * Quick-rate from card — updates DB and re-renders just the star row.
 */
function quickRate(filepath, rating, btnEl) {
  if (typeof setRating !== 'function') return;
  setRating(filepath, rating);
  // Re-render the rating stars in this card
  const container = btnEl.closest('.card-rating-inline');
  if (container) {
    const media = allMedia.find(m => m.filepath === filepath);
    if (media) {
      const escapedPath = escapeHtml(filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      container.innerHTML = renderCardInlineRating(media, escapedPath);
    }
  }
}

/* ── Pagination ────────────────────────────────────────────────────────── */

function renderPagination() {
  const totalPages = Math.ceil(filteredMedia.length / pageSize);
  const pagination = document.getElementById('pagination');
  if (totalPages <= 1) { pagination.innerHTML = ''; return; }

  let html = `<button ${currentPage === 1 ? 'disabled' : ''} onclick="goToPage(${currentPage - 1})">← Prev</button>`;

  const range = getPageRange(currentPage, totalPages);
  range.forEach((p, index) => {
    if (p === '...') {
      // Pass 'this' (the button element) so we can position the modal relative to it
      html += `<button class="dots" onclick="openJumpModal(event, ${totalPages})">...</button>`;
    } else {
      html += `<button class="${p === currentPage ? 'active' : ''}" onclick="goToPage(${p})">${p}</button>`;
    }
  });

  html += `<button ${currentPage === totalPages ? 'disabled' : ''} onclick="goToPage(${currentPage + 1})">Next →</button>`;
  pagination.innerHTML = html;
}

function openJumpModal(event, max) {
  event.stopPropagation(); // Prevent immediate closing

  // Remove existing modal if any
  const existing = document.getElementById('jump-modal');
  if (existing) existing.remove();

  const btn = event.currentTarget;
  const rect = btn.getBoundingClientRect();

  const modal = document.createElement('div');
  modal.id = 'jump-modal';
  modal.className = 'jump-modal';
  modal.innerHTML = `
    <input type="number" id="jump-input" min="1" max="${max}" placeholder="..." />
    <button onclick="executeJump(${max})">Go</button>
  `;

  document.body.appendChild(modal);

  // Position it above the clicked button
  modal.style.left = `${rect.left + (rect.width / 2) - (modal.offsetWidth / 2)}px`;
  modal.style.top = `${rect.top - modal.offsetHeight - 10 + window.scrollY}px`;

  const input = document.getElementById('jump-input');
  input.focus();

  // Handle Enter key
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') executeJump(max);
  });
}

function executeJump(max) {
  const val = parseInt(document.getElementById('jump-input').value);
  if (val >= 1 && val <= max) {
    goToPage(val);
    closeJumpModal();
  }
}

function closeJumpModal() {
  const modal = document.getElementById('jump-modal');
  if (modal) modal.remove();
}

// Close modal when clicking anywhere outside
document.addEventListener('click', (e) => {
  const modal = document.getElementById('jump-modal');
  if (modal && !modal.contains(e.target)) {
    closeJumpModal();
  }
});

function getPageRange(current, total) {
  // If total pages are low, just show them all
  if (total <= 9) return Array.from({length: total}, (_, i) => i + 1);

  // Near the start: [1, 2, 3, 4, 5, 6, '...', total]
  if (current <= 5) {
    return [1, 2, 3, 4, 5, 6, '...', total];
  }

  // Near the end: [1, '...', 420, 421, 422, 423, 424, 425]
  if (current >= total - 4) {
    return [1, '...', total-5, total-4, total-3, total-2, total-1, total];
  }

  // In the middle: [1, '...', 20, 21, 22, 23, 24, 25, 26, '...', 425]
  return [1, '...', current-3, current-2, current-1, current, current+1, current+2, current+3, '...', total];
}

function goToPage(page) {
  currentPage = page;
  renderResults();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
