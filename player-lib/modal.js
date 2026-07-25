/* =========================================================================
   MODAL - Detail modal for viewing media info -- default view
   ========================================================================= */

function showDetails(media) {
  document.getElementById('modalTitle').textContent = media.filename;
  
  const mediaElements = safeParseJSON(media.media_elements, []);
  const transcribedText = safeParseJSON(media.transcribed_text, []);
  const suggested_file_name = safeParseJSON(media.suggested_file_name, []);
  const themes = safeParseJSON(media.themes, []);
  const tags = safeParseJSON(media.tags, []);
  const locations = safeParseJSON(media.locations, []);

  let escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  
  let renderDupeSection = renderDuplicateSection(media)

  document.getElementById('modalBody').innerHTML = `
    <div class="detail-section">
      <div style="margin-bottom: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap;">
        <button onclick="closeModal(); playMedia({filepath: '${escapedPath}', filename: '${escapeHtml(media.filename).replace(/'/g, "\\'")}', media_type: '${media.media_type}'});" style="padding: 0.75rem 1.5rem; background: #22c55e; border: none; border-radius: 8px; color: white; cursor: pointer; font-weight: 600; font-size: 1rem;">
          ▶ Play
        </button>
        <button onclick="copyPath('${escapedPath}')" style="padding: 0.75rem 1rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); cursor: pointer;">
          Copy Path
        </button>
      </div>
      ${typeof renderMetaTools === 'function' ? renderMetaTools(media) : ''}
      ${typeof renderStarRatingSection === 'function' ? renderStarRatingSection(media) : ''}

    
    <div class="flag-for-deletion" style="margin-top: 1rem;">
    Flag this file: <button onclick="toggleFlagDelete('${escapedPath}'); this.classList.toggle('active')" class="dup-action-btn flag-btn ${media.user_flagged_delete ? 'active' : ''}" title="Flag current file for deletion">🚩</button> | ${media.user_trashed ? `
      🗑 This file is in the trash folder.<br>
      <small class="trash-original-path">Original: ${escapeHtml(media.trashed_original_path || '')}</small>
    ` : ''}
      <button onclick="trashOrRestoreFromDetails(${media.id})" style="padding: 0.6rem 1rem; background: ${media.user_trashed ? 'var(--success)' : 'var(--bg-tertiary)'}; border: 1px solid ${media.user_trashed ? 'var(--success)' : 'var(--danger)'}; border-radius: 8px; color: ${media.user_trashed ? '#fff' : 'var(--danger)'}; cursor: pointer; font-weight: 600;">
        ${media.user_trashed ? '♻ Restore from Trash' : '🗑 Move to Trash'}
      </button>
    </div>

    ${renderDupeSection ? renderDupeSection : ``}
    
      <h3>File Information</h3>
      <div class="detail-grid">
        <div class="detail-item detail-path-item">
          <label>Full Path</label>
          <span style="word-break: break-all;">${escapeHtml(media.filepath)}</span>
        </div>
        <div class="detail-item">
          <label>Media Type</label>
          <span>${media.media_type}</span>
        </div>
        <div class="detail-item">
          <label>Duration</label>
          <span>${media.duration_seconds ? formatDuration(media.duration_seconds) : 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Resolution</label>
          <span>${media.width && media.height ? `${media.width}×${media.height}` : 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>File Size</label>
          <span>${media.filesize_bytes ? formatFileSize(media.filesize_bytes) : 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Quality</label>
          <span>${media.quality_flag || 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Views</label>
          <span>👁 ${media.view_count || 0}${media.last_viewed_at ? ` (last: ${media.last_viewed_at})` : ''}</span>
        </div>
        <div class="detail-item">
          <label>Finishers</label>
          <span>💦 ${media.done_count || 0}${media.last_done_position > 0 ? ` (last at ${formatDuration(media.last_done_position)})` : ''}</span>
        </div>
      </div>
    </div>

    <div class="detail-section">
      <h3>Content Analysis</h3>
      <div class="detail-grid">
        <div class="detail-item">
          <label>Language</label>
          <span>${media.language_name || 'Unknown'}</span>
        </div>
        <div class="detail-item">
          <label>Content Type</label>
          <span>${media.content_type || 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Explicit</label>
          <span>${media.explicit ? 'Yes' : 'No'}</span>
        </div>
        <div class="detail-item">
          <label>Frames Analyzed</label>
          <span>${media.frames_analyzed || 'N/A'}</span>
        </div>
      </div>
    </div>

    ${media.processing_error ? `
    <div class="detail-section">
      <h3 style="color: var(--danger);">⚠ Processing Error</h3>
      <p style="color: var(--danger); background: rgba(239, 68, 68, 0.1); padding: 0.75rem; border-radius: 8px; border: 1px solid var(--danger);">${escapeHtml(media.processing_error)}</p>
    </div>
    ` : ''}

    ${media.description ? `
    <div class="detail-section">
      <h3>Description</h3>
      <p style="color: var(--text-secondary);">${escapeHtml(media.description)}</p>
    </div>
    ` : ''}

    ${typeof renderNotesSection === 'function' ? renderNotesSection(media) : ''}

    ${themes.length > 0 ? `
    <div class="detail-section">
      <h3>Themes</h3>
      <div class="card-tags">
        ${themes.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      </div>
    </div>
    ` : ''}

    ${locations.length > 0 ? `
    <div class="detail-section">
      <h3>Locations</h3>
      <div class="card-tags">
        ${locations.map(l => `<span class="tag">${escapeHtml(l)}</span>`).join('')}
      </div>
    </div>
    ` : ''}

    ${tags.length > 0 ? `
    <div class="detail-section">
      <h3>Tags</h3>
      <div class="card-tags">
        ${tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      </div>
    </div>
    ` : ''}

    ${mediaElements.length > 0 ? `
    <div class="detail-section">
      <h3>Media Elements</h3>
      <div class="elements-list">
        ${mediaElements.map(e => `
          <div class="element-item">
            <div class="element-type">${escapeHtml(e.type)}</div>
            <div class="element-details">${escapeHtml(e.details)}</div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${suggested_file_name.length > 0 ? `
    <div class="detail-section">
      <h3>Suggested File Name</h3>
      <div class="text-items">
        ${suggested_file_name.map(s => `
          <div class="text-item">
            <q>${escapeHtml(s.text)}</q>
            <div class="location">📍 ${escapeHtml(s.location)}</div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    ${transcribedText.length > 0 ? `
    <div class="detail-section">
      <h3>Transcribed Text</h3>
      <div class="text-items">
        ${transcribedText.map(t => `
          <div class="text-item">
            <q>${escapeHtml(t.text)}</q>
            <div class="location">📍 ${escapeHtml(t.location)}</div>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}

    <div class="detail-section">
      <h3>Processing Info</h3>
      <div class="detail-grid">
        <div class="detail-item">
          <label>Processed At</label>
          <span>${media.processed_at || 'N/A'}</span>
        </div>
        <div class="detail-item">
          <label>Model Used</label>
          <span>${media.model_used || 'N/A'}</span>
        </div>
      </div>
      <div style="margin-top: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; word-break: break-all;">
        <button onclick="closeModal(); playMedia({filepath: '${escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', filename: '${escapeHtml(media.filename).replace(/'/g, "\\'")}', media_type: '${media.media_type}'});" style="padding: 0.75rem 1.5rem; background: #22c55e; border: none; border-radius: 8px; color: white; cursor: pointer; font-weight: 600; font-size: 1rem;">
          ▶ Play
        </button>
        <button onclick="copyPath('${escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')" style="padding: 0.75rem 1rem; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); cursor: pointer;">
          Copy Path
        </button>
      </div>
    </div>

  `;

  document.getElementById('modalOverlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('modalOverlay').classList.remove('active');
  document.body.style.overflow = '';
}
