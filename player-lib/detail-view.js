/* =========================================================================
   DETAIL VIEW - The single renderer behind BOTH media-detail surfaces:
   the library modal (modal.js → #modalBody) and the player sidebar
   (player-core.js → #mediaSidebarBody).

   They used to be two hand-maintained copies of the same markup, so they
   drifted: Subtitles, Music ID and Games only ever landed in the sidebar,
   the ✎ inline editors only existed there too, and the library kept a few
   fields (frames_analyzed, the 📍 location lines) the sidebar had dropped.
   One renderer means a section added here shows up on both surfaces —
   there is no second copy to forget.

   Only four things may vary by context, and they are the ONLY reads of
   opts.context in this file:
     1. ▶ Play          — library only (the player is already playing it)
     2. Keyboard hints  — player only
     3. Trash handler   — trashOrRestoreFromDetails vs ...FromSidebar
     4. Wrapper class   — .detail-body--library / --player, so CSS can set
                          density for 800px vs 480px without a markup diff
   ========================================================================= */

/**
 * Seek this media to `seconds`, opening it in the player first when it isn't
 * the file already playing. The Subtitles/Music controls used to live only in
 * the player sidebar and could assume a live <video>; now that they also
 * render in the library modal there may be nothing to seek, so they take the
 * same open-then-seek route as seekToNoteTimestamp (player-lib/notes.js).
 * @returns {boolean} false when the media isn't in the loaded library at all
 */
function detailSeekTo(mediaId, seconds) {
  if (!Number.isFinite(seconds)) return false;
  seconds = Math.max(0, seconds);

  // #miniPlayerMedia counts too: while minimised the element lives there, and
  // missing it meant "seek in the thing you're already playing" tore the mini
  // player down and reloaded the file in the full player to reach the same spot.
  const el = document.querySelector(
    '#mediaPlayerContent video, #mediaPlayerContent audio, #miniPlayerMedia video, #miniPlayerMedia audio');
  const current = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
  if (el && current && current.id === mediaId) {
    el.currentTime = seconds;
    el.play?.();
    return true;
  }

  const item = typeof getMediaById === 'function' ? getMediaById(mediaId) : null;
  if (!item) return false;

  closeModal?.();
  playMedia({ filepath: item.filepath, filename: item.filename, media_type: item.media_type });
  const onLoaded = (e) => {
    const t = e.target;
    if (!['VIDEO', 'AUDIO'].includes(t.tagName)) return;
    if (!t.closest('#mediaPlayerContent')) return;
    document.removeEventListener('loadedmetadata', onLoaded, true);
    t.currentTime = seconds;
    t.play?.();
  };
  document.addEventListener('loadedmetadata', onLoaded, true);
  setTimeout(() => document.removeEventListener('loadedmetadata', onLoaded, true), 10000);
  return true;
}

/**
 * Full inner HTML for a detail surface.
 * @param {object} media  media row
 * @param {{context?: 'library'|'player'}} opts
 * @returns {string}
 */
function renderDetailBody(media, opts = {}) {
  const isLibrary = opts.context !== 'player';

  const mediaElements = safeParseJSON(media.media_elements, []);
  const transcribedText = safeParseJSON(media.transcribed_text, []);
  const suggested_file_name = safeParseJSON(media.suggested_file_name, []);
  const themes = safeParseJSON(media.themes, []);
  const tags = safeParseJSON(media.tags, []);
  const locations = safeParseJSON(media.locations, []);

  // Paths land inside single-quoted inline onclick attributes: escape the HTML
  // first, then the backslashes and quotes that would break out of the string.
  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const escapedName = escapeHtml(media.filename).replace(/'/g, "\\'");

  const editBtn = (key) => (typeof fieldEditBtn === 'function' ? fieldEditBtn(media.id, key) : '');
  const dupeSection = typeof renderDuplicateSection === 'function' ? renderDuplicateSection(media) : '';

  // The library modal sits over the grid, so Play has to dismiss it first.
  const playBtn = `
    <button onclick="closeModal(); playMedia({filepath: '${escapedPath}', filename: '${escapedName}', media_type: '${media.media_type}'});" class="detail-play-btn">
      ▶ Play
    </button>`;
  const copyBtn = `
    <button onclick="copyPath('${escapedPath}')" class="detail-copy-btn">
      Copy Path
    </button>`;

  const trashHandler = isLibrary ? 'trashOrRestoreFromDetails' : 'trashOrRestoreFromSidebar';

  const textItems = (items) => items.map(t => `
    <div class="text-item">
      <q>${escapeHtml(t.text)}</q>
      ${t.location ? `<div class="location">📍 ${escapeHtml(t.location)}</div>` : ''}
    </div>`).join('');

  const chips = (list) => list.length
    ? list.map(v => `<span class="tag">${escapeHtml(v)}</span>`).join('')
    : '<span class="field-empty">—</span>';

  /* The ⚠ badge on a tile is the ONLY hint that something went wrong, and this
     is where it sends you — so it goes directly under the actions, not two
     screens down past Description/Notes/Subtitles/Music/File Info where it used
     to sit (it did render; nobody scrolled that far to find it).

     'unscanned' is excluded: it is the not-yet-scanned sentinel, not a failure,
     and every freshly imported file was announcing itself here as
     "⚠ Processing Error — unscanned". */
  const errorSection = (media.processing_error && media.processing_error !== 'unscanned') ? `
    <div class="detail-section detail-section--error">
      <h3 style="color: var(--danger);">⚠ Processing Error</h3>
      <p class="detail-error">${escapeHtml(media.processing_error)}</p>
      <p class="detail-error-hint">The file itself is fine — it plays and can be tagged. Fix the cause above, then use 🔄 Rescan to try the AI analysis again.</p>
    </div>` : '';

  return `
    <div class="detail-body detail-body--${isLibrary ? 'library' : 'player'}" data-media-id="${media.id}">

    <div class="detail-section">
      <div class="detail-action-row">
        ${isLibrary ? playBtn : ''}
        ${copyBtn}
      </div>

      <div class="detail-path">${escapeHtml(media.filepath)}</div>

      ${typeof renderMetaTools === 'function' ? renderMetaTools(media) : ''}
      ${typeof renderStarRatingSection === 'function' ? renderStarRatingSection(media) : ''}

      <!-- The trash button (only) stays off mixes: a mix is virtual, assembled
           from its sources, so there is no file on disk to move. Its records
           are removed via ✂ Remove record in the meta tools above — which is
           why those are NOT gated on media_type, or deleting a saved mix from
           the library would have become impossible. -->
      <div class="flag-for-deletion" style="margin-top: 1rem;">
        Flag this file: <button onclick="toggleFlagDelete('${escapedPath}'); this.classList.toggle('active')" class="dup-action-btn flag-btn ${media.user_flagged_delete ? 'active' : ''}" title="Flag current file for deletion">🚩</button>
        ${media.media_type !== 'mix' ? `|
        ${media.user_trashed ? `
          🗑 This file is in the trash folder.<br>
          <small class="trash-original-path">Original: ${escapeHtml(media.trashed_original_path || '')}</small><br>` : ''}
        <button onclick="${trashHandler}(${media.id})" class="detail-trash-btn ${media.user_trashed ? 'is-trashed' : ''}">
          ${media.user_trashed ? '♻ Restore from Trash' : '🗑 Move to Trash'}
        </button>` : ''}
      </div>

      ${media.media_type === 'mix' ? `
      <div style="margin: 0.75rem 0;">
        <button onclick="openMixInEditor(${media.id})" class="detail-mix-btn" title="Tweak layers, effects, sync — or update the saved mix">
          🎛 Open in Editor
        </button>
        <div class="detail-mix-hint">Custom mix — a virtual file assembled from its source videos. Edit layers/effects (and the title/description) in the Editor.</div>
      </div>` : ''}

      ${dupeSection || ''}
    </div>

    ${errorSection}

    <div class="detail-section">
      <h3>Description ${editBtn('description')}</h3>
      <div class="field-content">
        <p class="detail-description">${media.description ? escapeHtml(media.description) : '<span class="field-empty">—</span>'}</p>
      </div>
    </div>

    ${typeof renderNotesSection === 'function' ? renderNotesSection(media) : ''}

    ${typeof renderSubtitlesSidebarSection === 'function' ? renderSubtitlesSidebarSection(media) : ''}

    ${typeof renderMusicSidebarSection === 'function' ? renderMusicSidebarSection(media) : ''}

    ${typeof renderGamesSidebarSection === 'function' ? renderGamesSidebarSection(media) : ''}

    ${isLibrary ? '' : `
    <div class="sidebar-nav-hint">
      <span><kbd>Alt</kbd>+<kbd>←</kbd> Prev</span>
      <span><kbd>Alt</kbd>+<kbd>→</kbd> Next</span>
      <span><kbd>I</kbd> Close</span>
    </div>`}

    <div class="detail-section">
      <h3>File Info ${editBtn('info')}</h3>
      <div class="field-content">
      <div class="detail-grid detail-grid--2col">
        <div class="detail-item">
          <label>Type</label>
          <span>${escapeHtml(media.media_type || '')}</span>
        </div>
        <div class="detail-item">
          <label>Duration</label>
          <span>${media.duration_seconds ? formatDuration(media.duration_seconds) : 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Res</label>
          <span>${media.width && media.height ? `${media.width}×${media.height}` : 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Size</label>
          <span>${media.filesize_bytes ? formatFileSize(media.filesize_bytes) : 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Quality</label>
          <span>${escapeHtml(media.quality_flag || 'N/A')}</span>
        </div>
        <div class="detail-item">
          <label>Lang</label>
          <span>${escapeHtml(media.language_name || 'Unknown')}</span>
        </div>
        <div class="detail-item">
          <label>Content</label>
          <span>${escapeHtml(media.content_type || 'N/A')}</span>
        </div>
        <div class="detail-item">
          <label>Frames</label>
          <span>${escapeHtml(String(media.frames_analyzed || 'N/A'))}</span>
        </div>
        <div class="detail-item detail-item--wide">
          <label>Views</label>
          <span>👁 ${media.view_count || 0}${media.last_viewed_at ? ` (last: ${escapeHtml(media.last_viewed_at)})` : ''} · 💦 ${media.done_count || 0}${media.last_done_position > 0 ? ` (last at ${formatDuration(media.last_done_position)})` : ''} · 🔥 ${media.hot_count || 0}${media.last_hot_position > 0 ? ` (last at ${formatDuration(media.last_hot_position)})` : ''}</span>
        </div>
      </div>
      </div>
    </div>

    <div class="detail-section detail-section--kv">
      <h3>Themes ${editBtn('themes')}</h3>
      <div class="field-content">
        <div class="card-tags">${chips(themes)}</div>
      </div>
    </div>

    <div class="detail-section detail-section--kv">
      <h3>Locations ${editBtn('locations')}</h3>
      <div class="field-content">
        <div class="card-tags">${chips(locations)}</div>
      </div>
    </div>

    <div class="detail-section detail-section--kv">
      <h3>Tags ${editBtn('tags')}</h3>
      <div class="field-content">
        <div class="card-tags">${chips(tags)}</div>
      </div>
    </div>

    ${mediaElements.length > 0 ? `
    <div class="detail-section">
      <h3>Media Elements</h3>
      <div class="elements-list elements-kv">
        ${mediaElements.map((e, i) => `
          <div class="element-item">
            <div class="element-type">${escapeHtml(titleCaseKey(e.type))}</div>
            <div class="element-details">${escapeHtml(e.details)}</div>
            <button class="element-edit-btn" onclick="startElementEdit(this, ${media.id}, ${i})" title="Edit ${escapeHtml(titleCaseKey(e.type))}">✎</button>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${suggested_file_name.length > 0 ? `
    <div class="detail-section">
      <h3>Suggested File Name</h3>
      <div class="text-items">${textItems(suggested_file_name)}</div>
    </div>
    ` : ''}

    ${transcribedText.length > 0 ? `
    <div class="detail-section">
      <h3>Transcribed Text</h3>
      <div class="text-items">${textItems(transcribedText)}</div>
    </div>
    ` : ''}

    <div class="detail-section">
      <h3>Processing</h3>
      <div class="detail-grid">
        <div class="detail-item">
          <label>Processed</label>
          <span>${escapeHtml(media.processed_at || 'N/A')}</span>
        </div>
        <div class="detail-item">
          <label>Model</label>
          <span>${escapeHtml(media.model_used || 'N/A')}</span>
        </div>
      </div>
      ${isLibrary ? `<div class="detail-action-row" style="margin-top: 1rem;">${playBtn}${copyBtn}</div>` : ''}
    </div>

    </div>
  `;
}
