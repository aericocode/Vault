/* =========================================================================
   NOTES / FLAGS - User fields persisted through the viewer server API

   Writes are optimistic: the in-memory item updates immediately (snappy UI),
   then the change POSTs to /api/media/:id/flags. On failure a toast shows
   and the server value is restored on next reload.

   The old File System Access API machinery (file handles, manual save,
   auto-save, download fallback, Firefox warning) is gone — the server owns
   the .db now.
   ========================================================================= */

/**
 * POST user-editable fields for a media item.
 * @param {object} item - the in-memory media row (must have .id)
 * @param {object} fields - e.g. { user_starred: 1 }
 */
async function postFlags(item, fields) {
  try {
    const resp = await fetch(`/api/media/${item.id}/flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    // Sync canonical values back (cheap safety net for races) — but never
    // clobber last_position unless this request actually wrote it (it
    // changes continuously during playback)
    const updated = await resp.json();
    if (!('last_position' in fields)) delete updated.last_position;
    Object.assign(item, updated);
  } catch (err) {
    console.error('[Flags] Save failed:', err);
    showToast('⚠ Save failed: ' + err.message);
  }
}

/**
 * Get notes for a media item by filepath.
 * Returns parsed array of {text, timestamp} or empty array.
 */
function getNotes(filepath) {
  const item = allMedia.find(m => m.filepath === filepath);
  return item ? safeParseJSON(item.user_notes || '', []) : [];
}

/**
 * Save notes array for a given filepath (in-memory + server).
 * Notes are shared across confirmed dupes (same dupe_group): the server
 * propagates the write to the whole group, so mirror it locally too.
 */
function saveNotesToDb(filepath, notesArray) {
  const item = allMedia.find(m => m.filepath === filepath);
  if (!item) return false;

  const json = JSON.stringify(notesArray);
  item.user_notes = json;

  if (item.dupe_group) {
    allMedia.forEach(m => {
      if (m.dupe_group === item.dupe_group) m.user_notes = json;
    });
  }

  // Notes are searchable — drop the cached search text / fuzzy index
  if (typeof invalidateFuse === 'function') invalidateFuse();

  postFlags(item, { user_notes: json });
  return true;
}

/* ── Saved note snippets (quick notes) ──────────────────────────────────────
   Reusable snippets, like saved searches but for notes: one click stamps the
   snippet onto the current file instead of retyping it 20 times. Stored
   server-side in the saved_notes table. */

let _noteSnippets = [];

async function loadNoteSnippets() {
  try {
    _noteSnippets = await fetch('/api/note-snippets').then(r => r.json());
  } catch {
    _noteSnippets = [];
  }
}

document.addEventListener('DOMContentLoaded', loadNoteSnippets);

// Colour palette for tag chips (mirrors the beatbar swatch set)
const SNIPPET_COLORS = ['#7aa8ff', '#4ade80', '#fbbf24', '#f472b6', '#a855f7', '#22d3ee', '#fb7185', '#94a3b8'];

function _hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

/** Inline style tinting a chip with its colour (subtle fill + solid border). */
function _snippetChipStyle(color) {
  const rgb = _hexToRgb(color);
  if (!rgb) return '';
  return `background: rgba(${rgb.r},${rgb.g},${rgb.b},0.16); border-color: ${color};`;
}

function renderNoteSnippets(escapedPath) {
  if (_noteSnippets.length === 0) return '';
  const chips = _noteSnippets.map(s => {
    const escText = escapeHtml(s.text).replace(/'/g, '&#39;');
    return `<span class="note-snippet-chip" draggable="true" data-id="${s.id}" data-text="${escText}"
        style="${_snippetChipStyle(s.color)}"
        onclick="insertNoteSnippet(this)"
        onmouseenter="snippetColorHover(this)" onmouseleave="snippetColorMaybeHide()"
        ondragstart="onSnippetDragStart(event)" ondragend="onSnippetDragEnd(event)">
      ${s.color ? `<span class="note-snippet-dot" style="background:${s.color}"></span>` : ''}
      <span class="note-snippet-label">${escapeHtml(s.text)}</span>
      <button class="note-snippet-del" onclick="event.stopPropagation(); deleteNoteSnippet(${s.id})" title="Forget this snippet">✕</button>
    </span>`;
  }).join('');
  return `<div class="note-snippets" ondragover="onSnippetDragOver(event)" ondrop="onSnippetDrop(event)">${chips}</div>`;
}

/* ── Colour grid on hover (singleton popover, beatbar-style swatches) ────── */

let _snippetColorTimer = null;

function snippetColorHover(chip) {
  if (_dragSnippetId != null) return;        // don't pop while dragging
  clearTimeout(_snippetColorTimer);
  _snippetColorTimer = setTimeout(() => showSnippetColorGrid(chip), 500);
}

function snippetColorMaybeHide() {
  clearTimeout(_snippetColorTimer);
  setTimeout(() => {
    const pop = document.getElementById('snippetColorPopover');
    if (pop && !pop.matches(':hover') && !document.querySelector('.note-snippet-chip:hover')) {
      hideSnippetColorGrid();
    }
  }, 130);
}

function ensureSnippetPopover() {
  let pop = document.getElementById('snippetColorPopover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'snippetColorPopover';
    pop.className = 'snippet-color-popover';
    pop.addEventListener('mouseleave', hideSnippetColorGrid);
    document.body.appendChild(pop);
  }
  return pop;
}

function showSnippetColorGrid(chip) {
  if (!chip || !chip.isConnected) return;
  const id = Number(chip.dataset.id);
  const pop = ensureSnippetPopover();
  pop.innerHTML =
    `<button class="snippet-swatch snippet-swatch-clear" onclick="setSnippetColor(${id}, '')" title="No colour">✕</button>` +
    SNIPPET_COLORS.map(c =>
      `<button class="snippet-swatch" style="background:${c}" onclick="setSnippetColor(${id}, '${c}')" title="${c}"></button>`).join('');
  pop.classList.add('visible');

  // Position above the chip, clamped to the viewport (flip below if needed)
  const r = chip.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left + r.width / 2 - pw / 2));
  let top = r.top - ph - 6;
  if (top < 8) top = r.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hideSnippetColorGrid() {
  document.getElementById('snippetColorPopover')?.classList.remove('visible');
}

async function setSnippetColor(id, color) {
  hideSnippetColorGrid();
  try {
    const resp = await fetch(`/api/note-snippets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    _noteSnippets = await resp.json();
    refreshAllSnippetRows();
  } catch (err) {
    showToast('⚠ Colour update failed: ' + err.message);
  }
}

/* ── Drag to reorder (group tags over time) ─────────────────────────────── */

let _dragSnippetId = null;

function onSnippetDragStart(e) {
  const chip = e.target.closest('.note-snippet-chip');
  if (!chip) return;
  _dragSnippetId = chip.dataset.id;
  chip.classList.add('snippet-dragging');
  hideSnippetColorGrid();
  e.dataTransfer.effectAllowed = 'move';
  try { e.dataTransfer.setData('text/plain', _dragSnippetId); } catch {}
}

/** Find the chip the dragged one should be inserted BEFORE (null = append). */
function _snippetDropTarget(container, x, y) {
  const chips = [...container.querySelectorAll('.note-snippet-chip:not(.snippet-dragging)')];
  let best = null, bestDist = Infinity;
  for (const c of chips) {
    const r = c.getBoundingClientRect();
    if (y < r.top - 6 || y > r.bottom + 6) continue; // only chips on the pointer's row
    const cx = r.left + r.width / 2;
    if (x <= cx && cx - x < bestDist) { bestDist = cx - x; best = c; }
  }
  return best;
}

function onSnippetDragOver(e) {
  if (_dragSnippetId == null) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const container = e.currentTarget;
  const dragging = container.querySelector('.note-snippet-chip.snippet-dragging');
  if (!dragging) return; // dragged from another section — ignore
  const before = _snippetDropTarget(container, e.clientX, e.clientY);
  if (before == null) container.appendChild(dragging);
  else if (before !== dragging.nextSibling) container.insertBefore(dragging, before);
}

function onSnippetDrop(e) { e.preventDefault(); }

async function onSnippetDragEnd(e) {
  const chip = e.target.closest('.note-snippet-chip');
  chip?.classList.remove('snippet-dragging');
  if (_dragSnippetId == null) return;
  _dragSnippetId = null;

  const container = chip?.closest('.note-snippets');
  if (!container) return;
  const ids = [...container.querySelectorAll('.note-snippet-chip')].map(c => Number(c.dataset.id));

  try {
    const resp = await fetch('/api/note-snippets/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (resp.ok) { _noteSnippets = await resp.json(); refreshAllSnippetRows(); }
  } catch { /* DOM already reflects the new order; next load reconciles */ }
}

/**
 * 🕐 button → insert the player's current position (e.g. "1:23") into the
 * note box at the cursor. Pairs with the note range/seek links: type
 * "0:11-1:23" and it becomes a clickable A-B loop.
 */
function insertCurrentTimestamp(btnEl) {
  const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');
  if (!el || !isFinite(el.currentTime)) {
    showToast('Play the file first to grab its timestamp');
    return;
  }
  const ts = formatDuration(el.currentTime) || '0:00';
  const section = btnEl.closest('.notes-section');
  const input = section?.querySelector('.note-input-field');
  if (!input) return;

  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  // Pad with a space when butting up against existing text
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const insert = `${lead}${ts}${trail}`;
  input.value = before + insert + after;
  const caret = start + insert.length;
  input.focus();
  input.setSelectionRange(caret, caret);
}

/**
 * Chip click → insert the snippet into the note BOX (not straight into a
 * saved note). If text is already there, chain with ", " — so several tags
 * can be stacked into one note comment, then saved with a single Add Note.
 */
function insertNoteSnippet(chipEl) {
  const section = chipEl.closest('.notes-section');
  const input = section?.querySelector('.note-input-field');
  if (!input) return;

  const tag = chipEl.dataset.text || '';
  const existing = input.value.trim();
  input.value = existing ? `${existing.replace(/,\s*$/, '')}, ${tag}` : tag;
  input.focus();
}

/** Save the currently-typed note text as a reusable snippet. */
async function saveNoteSnippet(btnEl) {
  const section = btnEl?.closest('.notes-section');
  const input = section?.querySelector('.note-input-field');
  const text = input?.value.trim();
  if (!text) {
    showToast('Type a note first, then ☆ saves it as a quick note');
    return;
  }
  try {
    const resp = await fetch('/api/note-snippets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    _noteSnippets = await resp.json();
    refreshAllSnippetRows();
    showToast('☆ Saved as quick note');
  } catch (err) {
    showToast('⚠ Save failed: ' + err.message);
  }
}

async function deleteNoteSnippet(id) {
  try {
    const resp = await fetch(`/api/note-snippets/${id}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    _noteSnippets = await resp.json();
    refreshAllSnippetRows();
  } catch (err) {
    showToast('⚠ Delete failed: ' + err.message);
  }
}

/** Redraw the snippet chip rows in every visible notes section. */
function refreshAllSnippetRows() {
  document.querySelectorAll('.notes-section').forEach(section => {
    const filepath = section.dataset.notesFor;
    if (!filepath) return;
    const escapedPath = escapeHtml(filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const existing = section.querySelector('.note-snippets');
    const html = renderNoteSnippets(escapedPath);
    if (existing) {
      if (html) existing.outerHTML = html;
      else existing.remove();
    } else if (html) {
      section.querySelector('.notes-add')?.insertAdjacentHTML('beforebegin', html);
    }
  });
}

/* ── Clickable timestamps (YouTube-style) ───────────────────────────────────
   "2:35" / "1:02:33" inside a note becomes a link that seeks the player.
   If the file isn't playing yet, it opens it and seeks once loaded. */

// A single timestamp fragment: [h:]m:ss
const _TS = '(?:\\d{1,2}:)?\\d{1,2}:\\d{2}';
// Range ("0:11-1:23" / "0:11 - 1:23") tried FIRST so it wins over singles.
// Dash class covers hyphen + en/em dash (common when text is pasted).
const _TS_LINK_RE = new RegExp(`\\b(${_TS})\\s*[-–—]\\s*(${_TS})\\b|\\b${_TS}\\b`, 'g');

function _parseTs(ts) {
  const parts = String(ts).trim().split(':').map(Number);
  if (parts.some(n => Number.isNaN(n))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/**
 * Linkify timestamps in note text:
 *   "2:35"        → seek link
 *   "0:11-1:23"   → A-B loop link (also "0:11 - 1:23")
 */
function linkifyTimestamps(escapedText, escapedPath) {
  return escapedText.replace(_TS_LINK_RE, (m, aTs, bTs) => {
    if (aTs) {
      // Range → loop between the two points
      return `<a class="note-ts note-ts-range" href="#" onclick="loopNoteRange('${escapedPath}', '${aTs}', '${bTs}'); return false;" title="Loop ${aTs}–${bTs}">🔁 ${aTs}–${bTs}</a>`;
    }
    return `<a class="note-ts" href="#" onclick="seekToNoteTimestamp('${escapedPath}', '${m}'); return false;" title="Jump to ${m}">${m}</a>`;
  });
}

/**
 * Click a note range → set the player's A-B loop to that span (opening the
 * file first if it isn't the one playing).
 */
function loopNoteRange(filepath, aTs, bTs) {
  const a = _parseTs(aTs), b = _parseTs(bTs);
  if (a == null || b == null) return;
  const item = allMedia.find(m => m.filepath === filepath);
  if (!item || typeof setAbLoop !== 'function') return;

  const current = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
  const playerOpen = document.getElementById('mediaPlayerOverlay')?.classList.contains('active');
  const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');

  if (playerOpen && current && current.filepath === filepath && el) {
    setAbLoop(a, b);
    return;
  }

  // Not playing yet — open it, then set the loop once metadata arrives
  closeModal?.();
  playMedia({ filepath: item.filepath, filename: item.filename, media_type: item.media_type });
  const onLoaded = (e) => {
    const t = e.target;
    if (!['VIDEO', 'AUDIO'].includes(t.tagName)) return;
    if (!t.closest('#mediaPlayerContent')) return;
    document.removeEventListener('loadedmetadata', onLoaded, true);
    setAbLoop(a, b);
  };
  document.addEventListener('loadedmetadata', onLoaded, true);
  setTimeout(() => document.removeEventListener('loadedmetadata', onLoaded, true), 10000);
}

function seekToNoteTimestamp(filepath, ts) {
  const secs = ts.split(':').map(Number).reduce((acc, p) => acc * 60 + p, 0);
  const item = allMedia.find(m => m.filepath === filepath);
  if (!item) return;

  const current = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
  const playerOpen = document.getElementById('mediaPlayerOverlay')?.classList.contains('active');
  const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio');

  if (playerOpen && current && current.filepath === filepath && el) {
    el.currentTime = secs;
    el.play?.();
    return;
  }

  // Not playing yet — open it, then seek once metadata arrives
  closeModal?.();
  playMedia({ filepath: item.filepath, filename: item.filename, media_type: item.media_type });
  const onLoaded = (e) => {
    const t = e.target;
    if (!['VIDEO', 'AUDIO'].includes(t.tagName)) return;
    if (!t.closest('#mediaPlayerContent')) return;
    document.removeEventListener('loadedmetadata', onLoaded, true);
    t.currentTime = secs;
    t.play?.();
  };
  document.addEventListener('loadedmetadata', onLoaded, true);
  setTimeout(() => document.removeEventListener('loadedmetadata', onLoaded, true), 10000);
}

/**
 * Render the notes section HTML for the modal.
 * @param {object} media - The media record
 * @returns {string} HTML string
 */
function renderNotesSection(media) {
  const notes = getNotes(media.filepath);
  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  let notesListHtml = '';
  if (notes.length > 0) {
    notesListHtml = notes.map((note, i) => `
      <div class="note-entry" data-index="${i}">
        <div class="note-timestamp">${escapeHtml(note.timestamp)}</div>
        <div class="note-text">${linkifyTimestamps(escapeHtml(note.text), escapedPath)}</div>
        <button class="note-delete" onclick="deleteNote('${escapedPath}', ${i})" title="Delete this note">✕</button>
      </div>
    `).join('');
  } else {
    notesListHtml = '<div class="notes-empty">No notes yet</div>';
  }

  return `
    <div class="detail-section notes-section" data-notes-for="${escapeHtml(media.filepath)}">
      <h3>📝 Notes${media.dupe_group ? ' <small style="font-weight:400;color:var(--text-muted);">(shared across dupes)</small>' : ''}</h3>
      <div class="notes-list">
        ${notesListHtml}
      </div>
      ${renderNoteSnippets(escapedPath)}
      <div class="notes-add">
        <div class="note-input-wrap">
          <button class="note-ts-btn" onclick="insertCurrentTimestamp(this)" title="Insert the current playback time">🕐</button>
          <textarea class="note-textarea note-input-field" placeholder="Add a note..." rows="2"></textarea>
        </div>
        <div class="notes-actions">
          <button class="note-save-snippet-btn" onclick="saveNoteSnippet(this)" title="Save the typed text as a reusable quick note">☆</button>
          <button class="note-clear-btn" onclick="clearNoteInput(this)" title="Clear the note box without saving">Clear</button>
          <button class="note-add-btn" onclick="addNote('${escapedPath}', this)">Add Note</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Add a note with the given text directly (used by quick-note chips).
 */
function addNoteText(filepath, text) {
  text = (text || '').trim();
  if (!text) return;

  const notes = getNotes(filepath);
  notes.push({
    text,
    timestamp: new Date().toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }),
  });

  if (saveNotesToDb(filepath, notes)) {
    refreshAllNotesSections(filepath);
    showToast(`Note added: ${text.length > 40 ? text.slice(0, 40) + '…' : text}`);
  }
}

/**
 * Auto-submit any half-typed note before the context that owns it goes away
 * (video changes, sidebar closes, player minimizes/closes). Scans every
 * visible notes section and saves whatever is in its input as a real note —
 * so an in-progress note is never silently lost. Empty inputs are skipped.
 */
function flushPendingNotes() {
  document.querySelectorAll('.notes-section').forEach(section => {
    const filepath = section.dataset.notesFor;
    const input = section.querySelector('.note-input-field');
    if (!filepath || !input) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';              // clear first so a re-render race can't double-add
    addNoteText(filepath, text);
  });
}

/** Clear button → wipe the note input without saving. */
function clearNoteInput(btnEl) {
  const section = btnEl?.closest('.notes-section');
  const input = section?.querySelector('.note-input-field');
  if (input) {
    input.value = '';
    input.focus();
  }
}

/**
 * Add a new timestamped note entry.
 * @param {string} filepath
 * @param {HTMLElement} btnEl - the clicked button, used to find the nearest textarea
 */
function addNote(filepath, btnEl) {
  // Find the textarea in the same notes-section as the clicked button
  const section = btnEl ? btnEl.closest('.notes-section') : null;
  const input = section ? section.querySelector('.note-input-field') : document.querySelector('.note-input-field');
  if (!input) return;

  const text = input.value.trim();
  if (!text) return;

  const notes = getNotes(filepath);
  notes.push({
    text: text,
    timestamp: new Date().toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  });

  if (saveNotesToDb(filepath, notes)) {
    refreshAllNotesSections(filepath);
    showToast('Note added');
  }
}

/**
 * Delete a note by index.
 */
function deleteNote(filepath, index) {
  const notes = getNotes(filepath);
  if (index < 0 || index >= notes.length) return;

  notes.splice(index, 1);

  if (saveNotesToDb(filepath, notes)) {
    refreshAllNotesSections(filepath);
    showToast('Note deleted');
  }
}

/**
 * Re-render ALL visible notes sections for the given filepath.
 * Handles both the modal and info overlay having notes simultaneously.
 */
function refreshAllNotesSections(filepath) {
  const escapedPath = escapeHtml(filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const notes = getNotes(filepath);

  // Find all notes sections for this filepath
  const sections = document.querySelectorAll(`.notes-section[data-notes-for="${CSS.escape(filepath)}"]`);

  sections.forEach(section => {
    const notesList = section.querySelector('.notes-list');
    if (!notesList) return;

    if (notes.length > 0) {
      notesList.innerHTML = notes.map((note, i) => `
        <div class="note-entry" data-index="${i}">
          <div class="note-timestamp">${escapeHtml(note.timestamp)}</div>
          <div class="note-text">${linkifyTimestamps(escapeHtml(note.text), escapedPath)}</div>
          <button class="note-delete" onclick="deleteNote('${escapedPath}', ${i})" title="Delete this note">✕</button>
        </div>
      `).join('');
    } else {
      notesList.innerHTML = '<div class="notes-empty">No notes yet</div>';
    }

    // Clear input in this section
    const input = section.querySelector('.note-input-field');
    if (input) input.value = '';
  });
}

// ── Stars & Ratings ─────────────────────────────────────────────────────

/**
 * Toggle starred state for a media item.
 */
function toggleStar(filepath) {
  const item = allMedia.find(m => m.filepath === filepath);
  if (!item) return;

  const newValue = item.user_starred ? 0 : 1;
  item.user_starred = newValue;
  postFlags(item, { user_starred: newValue });

  refreshAllStarRatingSections(filepath);
  renderResults(); // re-render to update badges
}

/**
 * Set rating for a media item (0-5, 0 = unrated).
 */
function setRating(filepath, rating) {
  const item = allMedia.find(m => m.filepath === filepath);
  if (!item) return;

  rating = Math.max(0, Math.min(5, parseInt(rating) || 0));
  item.user_rating = rating;
  postFlags(item, { user_rating: rating });

  refreshAllStarRatingSections(filepath);
  renderResults(); // re-render to update badges
}

/**
 * Toggle the flagged-for-deletion state for a media item.
 */
function toggleFlagDelete(filepath) {
  const item = allMedia.find(m => m.filepath === filepath);
  if (!item) return;

  const newValue = item.user_flagged_delete ? 0 : 1;
  item.user_flagged_delete = newValue;
  postFlags(item, { user_flagged_delete: newValue });

  renderResults();
}

/**
 * Render the star + rating control HTML.
 * Used in modal, info overlay, and (compactly) on cards.
 * @param {object} media - The media record
 * @returns {string} HTML string
 */
function renderStarRatingSection(media) {
  const starred = media.user_starred ? 1 : 0;
  const rating = media.user_rating || 0;
  const escapedPath = escapeHtml(media.filepath).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const starClass = starred ? 'star-btn starred' : 'star-btn';
  const starIcon = starred ? '❤' : '🤍';

  let ratingHtml = '';
  for (let i = 1; i <= 5; i++) {
    const filled = i <= rating;
    ratingHtml += `<button class="rating-star ${filled ? 'filled' : ''}" onclick="setRating('${escapedPath}', ${i === rating ? 0 : i})" title="${i === rating ? 'Clear rating' : i + '/5'}">${filled ? '★' : '☆'}</button>`;
  }

  return `
    <div class="star-rating-section" data-star-rating-for="${escapeHtml(media.filepath)}">
      <button class="${starClass}" onclick="toggleStar('${escapedPath}')" title="${starred ? 'Remove fave' : 'Fave this file'}">
        ${starIcon}<span class="star-label">Fave</span>
      </button>
      <div class="rating-control">
        <span class="rating-label">Rating:</span>
        <div class="rating-stars">${ratingHtml}</div>
        ${rating > 0 ? `<span class="rating-value">${rating}/5</span>` : ''}
      </div>
    </div>
  `;
}

/**
 * Render compact star + rating for card badges.
 * @param {object} media
 * @returns {string} HTML badges
 */
function renderCardStarRating(media) {
  let html = '';
  if (media.user_starred) {
    html += '<span class="meta-badge starred-badge">❤ Fave</span>';
  }
  if (media.user_rating > 0) {
    const stars = '★'.repeat(media.user_rating) + '☆'.repeat(5 - media.user_rating);
    html += `<span class="meta-badge rating-badge">${stars}</span>`;
  }
  return html;
}

/**
 * Refresh all visible star/rating sections for a filepath.
 */
function refreshAllStarRatingSections(filepath) {
  const media = allMedia.find(m => m.filepath === filepath);
  if (!media) return;

  const sections = document.querySelectorAll(`.star-rating-section[data-star-rating-for="${CSS.escape(filepath)}"]`);
  sections.forEach(section => {
    const temp = document.createElement('div');
    temp.innerHTML = renderStarRatingSection(media);
    const newSection = temp.firstElementChild;
    section.replaceWith(newSection);
  });
}
