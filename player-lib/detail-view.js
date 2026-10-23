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

   The Modern look's player is the one exception: renderDetailPanel (bottom
   of this file) lays the same sections out as a tabbed Info panel. It reuses
   every section renderer above (notes, subtitles, music, people, games,
   duplicates, studio, rating); only the small inline blocks of this function
   are drawn again there, in the panel's own style. The library modal and
   Classic never see it.
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
    : '<span class="field-empty">–</span>';

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
      <p class="detail-error-hint">The file itself is fine. It plays and can be tagged. Fix the cause above, then use 🔄 Rescan to try the AI analysis again. If the file was still being copied when it was scanned, use Force refresh.</p>
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
        <button onclick="openMixInEditor(${media.id})" class="detail-mix-btn" title="Tweak layers, effects, sync, or update the saved mix">
          🎛 Open in Editor
        </button>
        <div class="detail-mix-hint">Custom mix: a virtual file assembled from its source videos. Edit layers/effects (and the title/description) in the Editor.</div>
      </div>` : ''}

      ${dupeSection || ''}
    </div>

    ${errorSection}

    <div class="detail-section">
      <h3>Description ${editBtn('description')}</h3>
      <div class="field-content">
        <p class="detail-description">${media.description ? escapeHtml(media.description) : '<span class="field-empty">–</span>'}</p>
      </div>
    </div>

    ${typeof renderNotesSection === 'function' ? renderNotesSection(media) : ''}

    ${typeof renderSubtitlesSidebarSection === 'function' ? renderSubtitlesSidebarSection(media) : ''}

    ${typeof renderMusicSidebarSection === 'function' ? renderMusicSidebarSection(media) : ''}

    ${typeof renderFacesSection === 'function' ? renderFacesSection(media, opts) : ''}

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
        ${typeof studiosDetailItemHtml === 'function' ? studiosDetailItemHtml(media) : ''}
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

/* =========================================================================
   MODERN PLAYER INFO PANEL - the tabbed panel beside the Modern player
   (.notes/MODERN_PLAYER_SPEC.md, Phase 3; mock vault-player-v2.html).

   A header row of quick actions (line icons, the ones that do not fit go to
   More), tabs that only show when they apply (player-lib/player/
   panel-layout.js decides which), and a note box pinned under every tab.

   The whole tab area plus the note box is ONE .notes-section, so notes.js
   finds the list (Notes tab) and the input (note box) from either end
   exactly as it does in Classic: nothing in notes.js had to learn about tabs.

   Music, People and the Notes count fill in after the fact (their own async
   loads call detailPanelMusic / detailPanelSetCount / detailPanelNotesChanged).
   ========================================================================= */

/** The tab picked last; remembered for the session (page load). */
let detailPanelTab = 'details';

const DETAIL_PANEL_TABS = {
  details: 'Details', notes: 'Notes', subtitles: 'Subtitles', music: 'Music', people: 'People', file: 'File',
};

/** True when the player sidebar should draw the tabbed panel (Modern look). */
function detailPanelTabbed() {
  return typeof isModernLayout === 'function' && isModernLayout();
}

function detailPanelIcon(name) {
  return typeof vaultIcon === 'function' ? vaultIcon(name) : '';
}

/* Quick actions: icon, words (the tooltip and the More menu row) and the
   inline handler, which runs with `this` = the clicked button. */
const DETAIL_PANEL_ACTIONS = {
  flag: {
    icon: 'flag',
    label: (m) => (m.user_flagged_delete ? 'Flagged for deletion. Click to unflag' : 'Flag for deletion'),
    click: (m, p) => `toggleFlagDelete('${p}'); detailPanelFlagged()`,
  },
  trash: { icon: 'trash', label: () => 'Move to trash', click: (m) => `trashOrRestoreFromSidebar(${m.id})` },
  restore: { icon: 'rescan', label: () => 'Restore from trash', click: (m) => `trashOrRestoreFromSidebar(${m.id})` },
  copy: { icon: 'copy', label: () => 'Copy path', click: (m, p) => `copyPath('${p}')` },
  refresh: {
    icon: 'refresh',
    label: () => 'Force refresh: read the file again (length, size, codecs) and remake its thumbnail and hover frames. The AI scan is not redone',
    short: 'Force refresh',
    click: (m) => `window.vaultForceRefresh && window.vaultForceRefresh([${m.id}], this)`,
  },
  rescan: { icon: 'spark', label: () => 'Rescan with AI (LM Studio must be running)', short: 'Rescan with AI', click: (m) => `detailPanelBusy(this, rescanMedia(${m.id}))` },
  scan: { icon: 'spark', label: () => 'Scan with AI now (LM Studio must be running)', short: 'Scan with AI now', click: (m) => `detailPanelBusy(this, rescanMedia(${m.id}))` },
  collections: { icon: 'folder', label: () => 'Add to or remove from collections', short: 'Collections', click: (m) => `openCollectionPicker([${m.id}], this)` },
  editor: { icon: 'mix', label: () => 'Open in the Editor: layers, effects, sync and the saved mix', short: 'Open in Editor', click: (m) => `openMixInEditor(${m.id})` },
  remove: {
    icon: 'scissors',
    label: () => 'Remove from library. The file on disk is not touched',
    short: 'Remove from library',
    click: (m) => `removeRecords([${m.id}])`,
  },
};

function detailPanelActionsHtml(media, escapedPath) {
  const { row, more } = PanelLayout.actionsFor(media);
  const btn = (key) => {
    const a = DETAIL_PANEL_ACTIONS[key];
    const label = escapeHtml(a.label(media));
    const on = key === 'flag' && media.user_flagged_delete;
    return `<button type="button" class="mpp-qa-btn${on ? ' on' : ''}" data-qa="${key}" title="${label}" aria-label="${escapeHtml(a.short || a.label(media))}"${key === 'flag' ? ` aria-pressed="${on ? 'true' : 'false'}"` : ''}
      onclick="${a.click(media, escapedPath)}">${detailPanelIcon(a.icon)}</button>`;
  };
  const item = (key, overflow) => {
    const a = DETAIL_PANEL_ACTIONS[key];
    return `<button type="button" role="menuitem" class="mpp-menu-item" data-qa-item="${key}"${overflow ? ' hidden' : ''}
      onclick="detailPanelMoreClose(); ${a.click(media, escapedPath)}">${detailPanelIcon(a.icon)}<span>${escapeHtml(a.short || a.label(media))}</span></button>`;
  };
  return `
    <div class="mpp-qa" role="toolbar" aria-label="File actions">
      ${row.map(btn).join('')}
      <span class="mpp-qa-more-wrap">
        <button type="button" class="mpp-qa-btn mpp-qa-more" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded="false"
          onclick="detailPanelMoreToggle(this)">${detailPanelIcon('more')}</button>
        <div class="mpp-menu" role="menu" hidden onkeydown="detailPanelMenuKey(event)">
          ${row.map(k => item(k, true)).join('')}
          ${more.map(k => item(k, false)).join('')}
        </div>
      </span>
      <span class="mpp-qa-sp"></span>
      <button type="button" class="mpp-qa-btn mpp-qa-close" title="Close the panel (I)" aria-label="Close the panel" onclick="toggleSidebar()">${detailPanelIcon('close')}</button>
    </div>`;
}

/**
 * The Modern player's Info panel. Same data as renderDetailBody, laid out in
 * tabs. opts.extraFile: markup for the bottom of the File tab (the session's
 * skipped list from player-core.js).
 */
function renderDetailPanel(media, opts = {}) {
  const type = media.media_type || '';
  const timed = type === 'video' || type === 'audio';
  const mediaElements = safeParseJSON(media.media_elements, []);
  const transcribedText = safeParseJSON(media.transcribed_text, []);
  const suggested = safeParseJSON(media.suggested_file_name, []);
  const themes = safeParseJSON(media.themes, []);
  const tags = safeParseJSON(media.tags, []);
  const locations = safeParseJSON(media.locations, []);
  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const notes = typeof getNotes === 'function' ? getNotes(media.filepath) : [];

  const editBtn = (key, what) => `<button type="button" class="field-edit-btn mpp-edit" onclick="startFieldEdit(this, ${media.id}, '${key}')"
    title="Edit ${what}" aria-label="Edit ${what}">${detailPanelIcon('edit')}</button>`;
  const empty = '<span class="field-empty">None yet</span>';
  const chips = (list) => (list.length ? list.map(v => `<span class="tag">${escapeHtml(v)}</span>`).join('') : empty);
  const chipSection = (title, key) => {
    const list = { tags, themes, locations }[key];
    return `
      <div class="detail-section mpp-sec">
        <h3 class="mpp-lbl">${title} ${editBtn(key, title.toLowerCase())}</h3>
        <div class="field-content"><div class="card-tags">${chips(list)}</div></div>
      </div>`;
  };
  const textItems = (items) => items.map(t => `
    <div class="text-item">
      <q>${escapeHtml(t.text)}</q>
      ${t.location ? `<div class="location">${escapeHtml(t.location)}</div>` : ''}
    </div>`).join('');
  const kv = (label, value, cls = '') => `<div class="mpp-kv-row${cls ? ` ${cls}` : ''}"><dt>${label}</dt><dd>${value}</dd></div>`;
  const na = (v) => (v == null || v === '' ? '<span class="field-empty">Unknown</span>' : escapeHtml(String(v)));

  /* ── Details ── */
  const details = `
    ${typeof renderStarRatingSection === 'function' ? renderStarRatingSection(media) : ''}
    <div class="detail-section mpp-sec">
      <h3 class="mpp-lbl">Description ${editBtn('description', 'description')}</h3>
      <div class="field-content">
        <p class="detail-description">${media.description ? escapeHtml(media.description) : empty}</p>
      </div>
    </div>
    ${chipSection('Tags', 'tags')}
    ${chipSection('Themes', 'themes')}
    ${chipSection('Places', 'locations')}
    ${mediaElements.length ? `
    <div class="detail-section mpp-sec">
      <h3 class="mpp-lbl">What's in it</h3>
      <div class="elements-list elements-kv">
        ${mediaElements.map((e, i) => `
          <div class="element-item">
            <div class="element-type">${escapeHtml(titleCaseKey(e.type))}</div>
            <div class="element-details">${escapeHtml(e.details)}</div>
            <button type="button" class="element-edit-btn mpp-edit" onclick="startElementEdit(this, ${media.id}, ${i})"
              title="Edit ${escapeHtml(titleCaseKey(e.type))}">${detailPanelIcon('edit')}</button>
          </div>`).join('')}
      </div>
    </div>` : ''}
    <div class="detail-section mpp-sec">
      <h3 class="mpp-lbl">Language, content and quality ${editBtn('info', 'language, content and quality')}</h3>
      <div class="field-content">
        <dl class="mpp-kv">
          ${kv('Language', na(media.language_name))}
          ${kv('Content', na(media.content_type))}
          ${kv('Quality', na(media.quality_flag))}
        </dl>
      </div>
    </div>
    ${typeof studiosDetailItemHtml === 'function' && type !== 'mix' ? `
    <div class="detail-section mpp-sec mpp-studio">${studiosDetailItemHtml(media)}</div>` : ''}
    ${typeof renderGamesSidebarSection === 'function' ? renderGamesSidebarSection(media) : ''}
    ${type === 'mix' ? `
    <p class="mpp-hint">A custom mix: a virtual file put together from its source videos. Change its layers, effects, sync, title and description in the Editor (the mix button at the top).</p>` : ''}`;

  /* ── Notes ── */
  const notesPane = `
    ${media.dupe_group ? '<p class="mpp-hint">Notes are shared with this file\'s duplicates.</p>' : ''}
    <div class="notes-list">${typeof renderNotesList === 'function' ? renderNotesList(notes, escapedPath) : ''}</div>
    <p class="mpp-hint">Click a time in a note to jump there; a range like 0:41-1:03 loops.${timed ? ' A note from the box below starts with the time you began typing it.' : ''}</p>`;

  /* ── File ── */
  const views = [
    `${media.view_count || 0} ${(media.view_count || 0) === 1 ? 'view' : 'views'}${media.last_viewed_at ? `, last ${escapeHtml(media.last_viewed_at)}` : ''}`,
    `done ${media.done_count || 0}${media.last_done_position > 0 ? ` (last at ${formatDuration(media.last_done_position)})` : ''}`,
    `hot ${media.hot_count || 0}${media.last_hot_position > 0 ? ` (last at ${formatDuration(media.last_hot_position)})` : ''}`,
  ].join(' · ');
  const errorSection = (media.processing_error && media.processing_error !== 'unscanned') ? `
    <div class="detail-section detail-section--error mpp-sec">
      <h3 class="mpp-lbl mpp-lbl--warn">${detailPanelIcon('alert')} Processing error</h3>
      <p class="detail-error">${escapeHtml(media.processing_error)}</p>
      <p class="detail-error-hint">The file itself is fine. It plays and can be tagged. Fix the cause above, then use Rescan with AI (the sparkle button at the top) to try the AI analysis again. If the file was still being copied when it was scanned, use Force refresh.</p>
    </div>` : '';
  const music = typeof renderMusicSidebarSection === 'function' ? renderMusicSidebarSection(media) : '';
  const file = `
    ${errorSection}
    <div class="detail-section mpp-sec">
      <dl class="mpp-kv">
        ${kv('Path', escapeHtml(media.filepath), 'detail-path')}
        ${kv('Type', na(type))}
        ${kv('Length', media.duration_seconds ? formatDuration(media.duration_seconds) : na(null))}
        ${kv('Resolution', media.width && media.height ? `${media.width} x ${media.height}` : na(null))}
        ${kv('Size', media.filesize_bytes ? formatFileSize(media.filesize_bytes) : na(null))}
        ${kv('Frames', na(media.frames_analyzed))}
        ${kv('Views', views)}
        ${kv('Processed', na(media.processed_at))}
        ${kv('Model', na(media.model_used))}
      </dl>
    </div>
    <div class="mpp-music-slot">${type === 'video' ? music : ''}</div>
    ${typeof renderDuplicateSection === 'function' ? renderDuplicateSection(media) : ''}
    ${suggested.length ? `
    <div class="detail-section mpp-sec">
      <h3 class="mpp-lbl">Suggested file name</h3>
      <div class="text-items">${textItems(suggested)}</div>
    </div>` : ''}
    ${transcribedText.length ? `
    <div class="detail-section mpp-sec">
      <h3 class="mpp-lbl">Transcribed text</h3>
      <div class="text-items">${textItems(transcribedText)}</div>
    </div>` : ''}
    ${opts.extraFile || ''}
    <div class="sidebar-nav-hint">
      <span><kbd>Alt</kbd>+<kbd>Left</kbd> Previous</span>
      <span><kbd>Alt</kbd>+<kbd>Right</kbd> Next</span>
      <span><kbd>I</kbd> Close</span>
    </div>`;

  /* ── People ── */
  const people = `
    ${typeof renderFacesSection === 'function' ? renderFacesSection(media) : ''}
    <p class="mpp-hint mpp-people-empty">No people found in this file yet.</p>
    ${type === 'video' && typeof facesFindInFrame === 'function' ? `<button type="button" class="mpp-btn" onclick="facesFindInFrame()">${detailPanelIcon('face-scan')}Find faces in this frame</button>` : ''}`;

  /* A video's Music section waits in the File tab until a fingerprint scan
     shows there is music (detailPanelMusic moves it); audio always has it. */
  const panes = {
    details,
    notes: notesPane,
    subtitles: typeof renderSubtitlesSidebarSection === 'function' ? renderSubtitlesSidebarSection(media) : '',
    music: type === 'audio' ? music : '',
    people,
    file,
  };

  const faces = typeof facesReady === 'function' && facesReady();
  const tabs = PanelLayout.tabsFor(type, { faces, fingerprinted: false });
  const active = PanelLayout.pickTab(tabs, detailPanelTab);
  const errDot = errorSection ? ' mpp-tab--alert' : '';
  const tabHtml = PanelLayout.TAB_ORDER.map(k => {
    const count = k === 'notes' && notes.length ? notes.length : '';
    return `<button type="button" role="tab" class="mpp-tab${k === 'file' ? errDot : ''}" id="mppTab-${k}" data-mpp-tab="${k}"
      aria-controls="mppPane-${k}" aria-selected="${k === active}" tabindex="${k === active ? 0 : -1}"${tabs.includes(k) ? '' : ' hidden'}
      onclick="detailPanelSelect('${k}')">${DETAIL_PANEL_TABS[k]}<span class="mpp-count">${count}</span></button>`;
  }).join('');
  const paneHtml = PanelLayout.TAB_ORDER.map(k => `
    <div class="mpp-pane" role="tabpanel" id="mppPane-${k}" data-mpp-pane="${k}" aria-labelledby="mppTab-${k}"${k === active ? '' : ' hidden'}>
      ${panes[k]}
    </div>`).join('');

  const placeholder = timed ? detailPanelNotePlaceholder() : 'Add a note, Enter to save';

  return `
    <div class="detail-body detail-body--player mpp" data-media-id="${media.id}" data-mpp-type="${escapeHtml(type)}">
      ${detailPanelActionsHtml(media, escapedPath)}
      ${media.user_trashed ? `
      <div class="mpp-notice">${detailPanelIcon('trash')}<span>This file is in the trash folder.
        <small class="trash-original-path">Original: ${escapeHtml(media.trashed_original_path || '')}</small></span></div>` : ''}
      <div class="mpp-tabs" role="tablist" aria-label="Info" onkeydown="detailPanelTabKey(event)">${tabHtml}</div>
      <div class="mpp-scope notes-section" data-notes-for="${escapeHtml(media.filepath)}">
        <div class="mpp-panes">${paneHtml}</div>
        <div class="mpp-notebox">
          ${typeof renderNoteSnippets === 'function' ? renderNoteSnippets(escapedPath) : ''}
          <div class="notes-add mpp-noteadd"${timed ? ' data-note-at=""' : ''}>
            ${timed ? `<button type="button" class="mpp-ib" onclick="insertCurrentTimestamp(this)" title="Put the current time in the note">${detailPanelIcon('clock')}</button>` : ''}
            <textarea class="note-textarea note-input-field" rows="1" placeholder="${placeholder}" aria-label="New note"></textarea>
            <button type="button" class="mpp-ib" onclick="saveNoteSnippet(this)" title="Keep the typed text as a quick note to reuse">${detailPanelIcon('star')}</button>
            <button type="button" class="mpp-ib" onclick="clearNoteInput(this)" title="Clear the box without saving">${detailPanelIcon('close')}</button>
            <button type="button" class="mpp-ib mpp-ib--pri" onclick="addNote('${escapedPath}', this)" title="Add the note (Enter)">${detailPanelIcon('check')}</button>
          </div>
        </div>
      </div>
    </div>`;
}

/* ── Panel behaviour ─────────────────────────────────────────────────── */

function detailPanelRoot() {
  return document.querySelector('#mediaSidebarBody .mpp');
}

function detailPanelPlayerTime() {
  const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');
  return el && Number.isFinite(el.currentTime) ? el.currentTime : NaN;
}

/** "Note at 1:16, Enter to save"; just "Note at 1:16" when the box is too
 *  narrow for the rest on one line (a 900 px window). */
function detailPanelNotePlaceholder(input) {
  const t = detailPanelPlayerTime();
  const at = `Note at ${PanelLayout.formatTime(Number.isFinite(t) ? t : 0)}`;
  const full = `${at}, Enter to save`;
  return input && input.clientWidth > 0 && detailPanelTextWidth(full, input) > detailPanelInnerWidth(input) ? at : full;
}

let detailPanelMeasure = null;
/** How wide `text` draws in the box's font. */
function detailPanelTextWidth(text, el) {
  detailPanelMeasure = detailPanelMeasure || document.createElement('canvas').getContext('2d');
  if (!detailPanelMeasure) return 0;
  detailPanelMeasure.font = getComputedStyle(el).font;
  return detailPanelMeasure.measureText(text).width;
}

/** The box's width for text: less its padding. */
function detailPanelInnerWidth(el) {
  const s = getComputedStyle(el);
  return el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
}

/** Put the current time (and the right length) in the note box's placeholder. */
function detailPanelPlaceholderUpdate() {
  const input = document.querySelector('#mediaSidebarBody .notes-add[data-note-at] .note-input-field');
  if (!input) return;
  const text = detailPanelNotePlaceholder(input);
  if (input.placeholder !== text) input.placeholder = text;
}

/** Show one tab. remember: false when the panel picks it rather than you. */
function detailPanelSelect(key, { remember = true, focus = false } = {}) {
  const root = detailPanelRoot();
  const tab = root?.querySelector(`[data-mpp-tab="${key}"]`);
  if (!tab || tab.hidden) return;
  root.querySelectorAll('[data-mpp-tab]').forEach(t => {
    const on = t === tab;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  });
  root.querySelectorAll('[data-mpp-pane]').forEach(p => { p.hidden = p.dataset.mppPane !== key; });
  const panes = root.querySelector('.mpp-panes');
  if (panes) panes.scrollTop = 0;
  if (remember) {
    detailPanelTab = key;
    root.dataset.picked = '1';
  }
  if (focus) tab.focus();
}

/** Left / Right / Home / End move between tabs (and stay out of the player). */
function detailPanelTabKey(e) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) {
    // Enter / Space pick the focused tab instead of play / pause; Up / Down
    // do nothing here rather than change the volume (or zoom a picture).
    // Alt+Left / Right still go to the previous / next file.
    if (e.altKey) return;
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.stopPropagation();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.preventDefault();
    }
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const tabs = [...e.currentTarget.querySelectorAll('[data-mpp-tab]:not([hidden])')];
  const i = tabs.indexOf(document.activeElement);
  let next;
  if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = tabs.length - 1;
  else next = (Math.max(0, i) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  if (tabs[next]) detailPanelSelect(tabs[next].dataset.mppTab, { focus: true });
}

/**
 * Re-check which tabs apply (face search switched, a fingerprint scan
 * landed) and keep a shown tab selected. Until you pick a tab yourself,
 * the remembered one wins as soon as it appears (Music shows up only once
 * its scan state has loaded).
 */
function detailPanelSync() {
  const root = detailPanelRoot();
  if (!root || typeof PanelLayout === 'undefined') return;
  const faces = typeof facesReady === 'function' && facesReady();
  const tabs = PanelLayout.tabsFor(root.dataset.mppType, { faces, fingerprinted: root.dataset.fp === '1' });
  root.querySelectorAll('[data-mpp-tab]').forEach(t => { t.hidden = !tabs.includes(t.dataset.mppTab); });
  const current = root.querySelector('[data-mpp-tab][aria-selected="true"]')?.dataset.mppTab;
  const want = root.dataset.picked ? current : detailPanelTab;
  const pick = PanelLayout.pickTab(tabs, tabs.includes(want) ? want : current);
  if (pick !== current) detailPanelSelect(pick, { remember: false });
}

/** A count beside a tab's name (null or 0: none). */
function detailPanelSetCount(mediaId, tab, n) {
  const root = detailPanelRoot();
  if (!root || Number(root.dataset.mediaId) !== Number(mediaId)) return;
  const el = root.querySelector(`[data-mpp-tab="${tab}"] .mpp-count`);
  if (el) el.textContent = n > 0 ? String(n) : '';
}

/** notes.js redrew a notes list: keep the Notes count in step. */
function detailPanelNotesChanged(section, n) {
  const root = section?.closest?.('.mpp');
  const el = root?.querySelector('[data-mpp-tab="notes"] .mpp-count');
  if (el) el.textContent = n > 0 ? String(n) : '';
}

/**
 * music.js loaded this file's Music ID state. A video gets its Music tab
 * once it has been fingerprinted; before that the section (with its
 * "Fingerprint and scan" button) sits in the File tab.
 */
function detailPanelMusic(mediaId, info) {
  const root = detailPanelRoot();
  if (!root || Number(root.dataset.mediaId) !== Number(mediaId) || !info) return;
  const section = root.querySelector('.music-section');
  if (root.dataset.mppType === 'video' && section) {
    const fp = !!info.fingerprinted;
    const wasFp = root.dataset.fp;   // undefined on the first answer
    const onMusic = root.querySelector('[data-mpp-tab="music"]')?.getAttribute('aria-selected') === 'true';
    root.dataset.fp = fp ? '1' : '';
    const home = fp ? root.querySelector('[data-mpp-pane="music"]') : root.querySelector('.mpp-music-slot');
    if (home && section.parentElement !== home) home.appendChild(section);
    // Fingerprints removed from the Music tab: Music ID now lives in File.
    if (!fp && onMusic) detailPanelSelect('file', { remember: false });
    detailPanelSync();
    // Scanned from the File tab just now: follow the songs to their tab.
    const onFile = root.querySelector('[data-mpp-tab="file"]')?.getAttribute('aria-selected') === 'true';
    if (fp && wasFp === '' && onFile) detailPanelSelect('music', { remember: false });
  }
  detailPanelSetCount(mediaId, 'music', (info.songs || []).length);
}

/** Flag toggled: light the button (and its More row) without a re-render. */
function detailPanelFlagged() {
  const root = detailPanelRoot();
  if (!root) return;
  const m = typeof getMediaById === 'function' ? getMediaById(Number(root.dataset.mediaId)) : null;
  const on = m ? !!m.user_flagged_delete : !root.querySelector('[data-qa="flag"].on');
  root.querySelectorAll('[data-qa="flag"]').forEach(b => {
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? 'Flagged for deletion. Click to unflag' : 'Flag for deletion';
  });
}

/** Disable a quick action while its promise runs. */
function detailPanelBusy(btn, promise) {
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('busy');
  Promise.resolve(promise).finally(() => {
    if (btn.isConnected) { btn.disabled = false; btn.classList.remove('busy'); }
  });
}

/* ── More menu ── */

function detailPanelMoreToggle(btn) {
  const menu = btn.parentElement.querySelector('.mpp-menu');
  if (!menu) return;
  if (!menu.hidden) { detailPanelMoreClose(); return; }
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('open');
  // The click that opened it must not close it again.
  setTimeout(() => document.addEventListener('pointerdown', detailPanelMoreOutside, true), 0);
  menu.querySelector('.mpp-menu-item:not([hidden])')?.focus();
}

function detailPanelMoreClose() {
  document.removeEventListener('pointerdown', detailPanelMoreOutside, true);
  const root = detailPanelRoot();
  const menu = root?.querySelector('.mpp-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const btn = root.querySelector('.mpp-qa-more');
  btn?.setAttribute('aria-expanded', 'false');
  btn?.classList.remove('open');
}

function detailPanelMoreOutside(e) {
  if (e.target.closest?.('.mpp-qa-more-wrap')) return;
  detailPanelMoreClose();
}

/** Esc closes the menu (not the panel); Up / Down move through it. */
function detailPanelMenuKey(e) {
  const items = [...e.currentTarget.querySelectorAll('.mpp-menu-item:not([hidden])')];
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    detailPanelMoreClose();
    detailPanelRoot()?.querySelector('.mpp-qa-more')?.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    const i = items.indexOf(document.activeElement);
    const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  } else if (e.key === ' ' || e.key === 'Enter') {
    e.stopPropagation();   // the item's own click, not play / pause
  } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && !e.altKey) {
    e.preventDefault();    // not a seek while the menu has focus
    e.stopPropagation();
  }
}

/* ── Quick actions that do not fit go to More, from the end ── */

const detailPanelFitObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(entries => {
    entries.forEach(en => detailPanelFit(en.target));
    detailPanelPlaceholderUpdate();   // the panel's width changed, so may the box's
  }) : null;

function detailPanelFit(qa) {
  if (!qa || !qa.isConnected) return;
  const row = [...qa.querySelectorAll('[data-qa]')];
  const style = getComputedStyle(qa);
  const width = qa.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  // Room for More, close and the gap before close
  const n = PanelLayout.fitActions(width, row.length, { btn: 36, gap: 4, fixed: 36 * 2 + 4 * 2 + 8 });
  row.forEach((b, i) => {
    b.hidden = i >= n;
    const item = qa.querySelector(`[data-qa-item="${b.dataset.qa}"]`);
    if (item) item.hidden = i < n;
  });
}

/** Called once the panel is in the page (player-core.js renderSidebar). */
function detailPanelMounted() {
  const root = detailPanelRoot();
  if (!root) return;
  const qa = root.querySelector('.mpp-qa');
  if (detailPanelFitObserver) {
    detailPanelFitObserver.disconnect();
    if (qa) detailPanelFitObserver.observe(qa);
  }
  detailPanelFit(qa);
  detailPanelPlaceholderUpdate();
}

/* The note box remembers the playback time a note was started at (it is
   put in front of the note on save, notes.js _noteBoxText), and keeps the
   placeholder's time current while the box is empty. */
document.addEventListener('input', (e) => {
  const input = e.target;
  if (!input?.classList?.contains('note-input-field')) return;
  const box = input.closest('.notes-add[data-note-at]');
  if (!box) return;
  if (!input.value.trim()) { box.dataset.noteAt = ''; return; }
  if (box.dataset.noteAt === '') {
    const t = detailPanelPlayerTime();
    if (Number.isFinite(t)) box.dataset.noteAt = String(t);
  }
});

document.addEventListener('timeupdate', (e) => {
  if (!e.target?.closest?.('#mediaPlayerContent')) return;
  detailPanelPlaceholderUpdate();
}, true);

/* Switching between Classic and Modern with the panel open redraws it in the
   new look, keeping whatever is half-typed in the note box, and the time it
   was started at: Classic's box has no place for that time, so it is kept
   here, with the file and the draft it belongs to, for the way back
   (PanelLayout.draftStartAt decides whether it still applies). */
let detailPanelDraftAt = null;   // {id, text, at} while Classic shows
window.addEventListener('vault:layout-style', () => {
  if (typeof sidebarOpen === 'undefined' || !sidebarOpen || typeof renderSidebar !== 'function') return;
  const input = document.querySelector('#mediaSidebarBody .note-input-field');
  const draft = input ? input.value : '';
  const box = document.querySelector('#mediaSidebarBody .notes-add[data-note-at]');
  const saved = detailPanelDraftAt;
  detailPanelDraftAt = box && draft.trim()
    ? { id: Number(box.closest('.mpp')?.dataset.mediaId), text: draft.trim(), at: box.dataset.noteAt || '' }
    : null;
  if (input) input.value = '';   // carried over below, not saved as a note by the redraw
  renderSidebar();
  const next = document.querySelector('#mediaSidebarBody .note-input-field');
  if (next && draft) next.value = draft;
  const nextBox = document.querySelector('#mediaSidebarBody .notes-add[data-note-at]');
  if (nextBox) {
    const id = Number(nextBox.closest('.mpp')?.dataset.mediaId);
    nextBox.dataset.noteAt = draft.trim() ? PanelLayout.draftStartAt(saved, id, draft) : '';
  }
});
