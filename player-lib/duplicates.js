/* =========================================================================
   DUPLICATES - Detect duplicate files by type + filesize + duration
   ========================================================================= */

// Map of duplicate group key → array of media items
let duplicateGroups = {};

// Set of filepaths that are in a duplicate group
let duplicateFilepaths = new Set();

/**
 * Scan allMedia and build duplicate groups.
 * Called after DB load and after any data changes.
 *
 * Groups by media_type + filesize_bytes.
 * Within each group, flags duration match as "exact" vs "likely".
 */
function buildDuplicateIndex() {
  duplicateGroups = {};
  duplicateFilepaths = new Set();

  // Group by type + filesize
  const sizeMap = {};
  allMedia.forEach(m => {
    if (!m.filesize_bytes || !m.media_type) return;
    const key = `${m.media_type}:${m.filesize_bytes}`;
    if (!sizeMap[key]) sizeMap[key] = [];
    sizeMap[key].push(m);
  });

  // Only keep groups with 2+ files
  Object.entries(sizeMap).forEach(([key, items]) => {
    if (items.length < 2) return;
    duplicateGroups[key] = items;
    items.forEach(m => duplicateFilepaths.add(m.filepath));
  });

  const groupCount = Object.keys(duplicateGroups).length;
  const fileCount = duplicateFilepaths.size;
  if (groupCount > 0) {
    console.log(`[Duplicates] Found ${groupCount} groups, ${fileCount} files`);
  }
}

/**
 * Check if a media item is in a duplicate group.
 */
function isDuplicate(filepath) {
  return duplicateFilepaths.has(filepath);
}

/**
 * Get the duplicate group for a media item.
 * Returns array of media objects in the same group, or null.
 */
function getDuplicateGroup(media) {
  if (!media.filesize_bytes || !media.media_type) return null;
  const key = `${media.media_type}:${media.filesize_bytes}`;
  const group = duplicateGroups[key];
  return (group && group.length > 1) ? group : null;
}

/**
 * Check if two media items in a group are exact duplicates (duration matches too).
 */
function isExactDuplicate(a, b) {
  if (!a.duration_seconds || !b.duration_seconds) return false;
  // Match within 1 second tolerance
  return Math.abs(a.duration_seconds - b.duration_seconds) < 1;
}

/**
 * Render a duplicate badge for a card.
 */
function renderDuplicateBadge(media) {
  if (!isDuplicate(media.filepath)) return '';
  const group = getDuplicateGroup(media);
  if (!group) return '';

  const count = group.length - 1; // exclude self
  // Check if any pair in group is an exact match (same duration)
  const hasExact = group.some(other =>
    other.filepath !== media.filepath && isExactDuplicate(media, other)
  );

  if (hasExact) {
    return `<span class="meta-badge duplicate-badge exact" title="${count} files with identical size and duration">⚠ ${count} exact dupes</span>`;
  }
  return `<span class="meta-badge duplicate-badge likely" title="${count} files with identical size (different duration)">⚠ ${count} likely dupes</span>`;
}

/**
 * Render duplicate details for the modal/sidebar.
 */
function renderDuplicateSection(media) {
  const group = getDuplicateGroup(media);
  if (!group || group.length < 2) return '';

  const escapedCurrentPath = escapeHtml(media.filepath);
  const others = group.filter(m => m.filepath !== media.filepath);

  let html = `<div class="detail-section duplicate-section">
    <h3>⚠ Duplicate Files (${group.length -1} matches)</h3>
    
    <div class="duplicate-list">`;

  others.forEach(other => {
    const exact = isExactDuplicate(media, other);
    const escapedPath = escapeHtml(other.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const flagged = other.user_flagged_delete ? 'flagged' : '';

    html += `
      <div class="duplicate-item ${flagged}">
        <div class="duplicate-match-type">${exact ? '🔴 Exact match' : '🟡 Same size'}</div>
        <div class="duplicate-filename">${escapeHtml(other.filename)}</div>
        <div class="duplicate-details">
          ${other.duration_seconds ? formatDuration(other.duration_seconds) : 'N/A'} •
          ${other.filesize_bytes ? formatFileSize(other.filesize_bytes) : 'N/A'} •
          ${other.width && other.height ? `${other.width}×${other.height}` : 'N/A'}
        </div>
        <div class="duplicate-path">${escapeHtml(truncatePath(other.filepath, 60))}</div>
        <div class="duplicate-actions">
          <button onclick="copyPath('${escapedPath}')" class="dup-action-btn">Copy Path</button>
          <button onclick="toggleFlagDelete('${escapedPath}'); this.classList.toggle('active')" class="dup-action-btn flag-btn ${other.user_flagged_delete ? 'active' : ''}" title="Flag">🚩</button>
          ${other.user_trashed
            ? `<button onclick="trashDupeFromDetails(${other.id}, ${media.id})" class="dup-action-btn dup-restore-btn" title="Restore this duplicate from trash">♻ Restore</button>`
            : `<button onclick="trashDupeFromDetails(${other.id}, ${media.id})" class="dup-action-btn dup-trash-btn" title="Move this duplicate to trash (notes are shared, nothing is lost)">🗑 Trash</button>`}
          ${typeof renderStarRatingSection === 'function' ? renderStarRatingSection(other) : ''}
        </div>
      </div>`;
  });

  html += '</div></div>';
  return html;
}
