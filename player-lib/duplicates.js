/* =========================================================================
   DUPLICATES - Detect duplicate files by type + filesize + duration

   The rule is unchanged: two or more files with the same media_type and the
   same non-zero filesize_bytes form a group. The server keeps the groups now
   (GET /api/library/duplicates, paged), and the Dupes filter runs there too.
   The detail panel asks for them the first time it needs them and again
   after the library has changed; the group's rows come from Library.
   ========================================================================= */

const DUPE_PAGE = 1000;              // groups per request (the route's cap)
const DUPE_REFRESH_MS = 60 * 1000;   // a changing library re-reads at most this often

// `${media_type}:${filesize_bytes}` → [id, ...] in the server's order
let duplicateGroups = new Map();
let _dupeLoaded = { version: null, at: 0, promise: null };

/** Are the groups in hand current enough to show? */
function duplicateGroupsFresh() {
  return _dupeLoaded.version != null &&
    (_dupeLoaded.version === Library.version || Date.now() - _dupeLoaded.at < DUPE_REFRESH_MS);
}

/** Every duplicate group, keyed by type and size. Cached per library version. */
function loadDuplicateGroups() {
  const v = Library.version;
  if (duplicateGroupsFresh()) return Promise.resolve(duplicateGroups);
  if (_dupeLoaded.promise) return _dupeLoaded.promise;
  _dupeLoaded.promise = (async () => {
    const next = new Map();
    for (let offset = 0; ; offset += DUPE_PAGE) {
      const resp = await fetch(`/api/library/duplicates?offset=${offset}&limit=${DUPE_PAGE}`);
      if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
      const data = await resp.json();
      for (const g of data.groups || []) next.set(`${g.media_type}:${g.filesize_bytes}`, g.ids);
      if (offset + DUPE_PAGE >= (data.totalGroups || 0)) break;
    }
    duplicateGroups = next;
    _dupeLoaded = { version: v, at: Date.now(), promise: null };
    return duplicateGroups;
  })().catch((err) => {
    _dupeLoaded.promise = null;
    throw err;
  });
  return _dupeLoaded.promise;
}

/** The ids in this row's duplicate group (itself included), or null. */
function duplicateGroupIds(media) {
  if (!media || !media.filesize_bytes || !media.media_type) return null;
  const ids = duplicateGroups.get(`${media.media_type}:${media.filesize_bytes}`);
  return ids && ids.length > 1 ? ids : null;
}

/**
 * Check if a media item is in a duplicate group (from the groups loaded so
 * far; the Dupes filter itself runs on the server).
 */
function isDuplicate(media) {
  return !!duplicateGroupIds(media);
}

/**
 * Get the duplicate group for a media item.
 * Returns array of media objects in the same group (cached rows), or null.
 */
function getDuplicateGroup(media) {
  const ids = duplicateGroupIds(media);
  if (!ids) return null;
  const rows = ids.map(id => Library.row(id)).filter(Boolean);
  return rows.length > 1 ? rows : null;
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
  if (!isDuplicate(media)) return '';
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
 * Render duplicate details for the modal/sidebar. The groups and the other
 * files' rows may still be on their way, so this returns a slot that fills
 * itself in (empty when the file has no duplicates).
 */
function renderDuplicateSection(media) {
  if (!media || !media.filesize_bytes || !media.media_type) return '';
  const html = duplicateSectionHtml(media);
  if (html !== null) return `<div class="dupe-slot" data-dupe-for="${media.id}">${html}</div>`;
  fillDuplicateSection(media);
  return `<div class="dupe-slot" data-dupe-for="${media.id}"></div>`;
}

/** The section's markup, or null while the groups or rows are not here. */
function duplicateSectionHtml(media) {
  if (!duplicateGroupsFresh()) return null;
  const ids = duplicateGroupIds(media);
  if (!ids) return '';
  if (ids.some(id => !Library.row(id))) return null;
  return duplicateSectionMarkup(media, getDuplicateGroup(media));
}

async function fillDuplicateSection(media) {
  try {
    await loadDuplicateGroups();
    const ids = duplicateGroupIds(media);
    if (ids) await Library.fetchRows(ids);
  } catch { return; }
  const group = getDuplicateGroup(media);
  const html = group ? duplicateSectionMarkup(media, group) : '';
  document.querySelectorAll(`.dupe-slot[data-dupe-for="${media.id}"]`).forEach(el => { el.innerHTML = html; });
}

function duplicateSectionMarkup(media, group) {
  if (!group || group.length < 2) return '';

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
