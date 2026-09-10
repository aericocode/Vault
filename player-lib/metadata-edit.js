/* =========================================================================
   METADATA TOOLS - Rescan failed scans + hand-correct AI fields + remove
   records from the library (files stay on disk).

   Editing is INLINE (no popups): every AI field section in the sidebar has
   a small ✎ in its corner that swaps the content for an input in place —
   including each Media Elements entry.

   - renderMetaTools(media)   → toolbar HTML (🔄 rescan-on-error, ✂ remove)
   - fieldEditBtn(id, key)    → the corner ✎ (used by renderSidebar)
   - startFieldEdit / startInfoEdit / startElementEdit → inline editors
   - rescanMedia(id, btn)     → POST /api/media/:id/rescan
   - removeRecords(ids)       → POST /api/records/delete (confirm first)
   ========================================================================= */

/** Toolbar shown in the info panels. Rescan appears only for failed scans. */
function renderMetaTools(media) {
  return `
    <div class="meta-tools">
      ${media.processing_error ? `
      <button class="meta-tool-btn meta-rescan-btn" onclick="rescanMedia(${media.id}, this)" title="Run the AI scan on this file now (LM Studio must be running)">
        ${media.processing_error === 'unscanned' ? '⏳ Scan now' : '🔄 Rescan'}
      </button>` : ''}
      <button class="meta-tool-btn" onclick="openCollectionPicker([${media.id}], this)" title="Add/remove this item in your collections">
        📁 Collections
      </button>
      <button class="meta-tool-btn meta-remove-btn" onclick="removeRecords([${media.id}])" title="Delete this record from the library. The file on disk is NOT touched">
        ✂ Remove record
      </button>
    </div>
  `;
}

/** Re-render whichever info surfaces are currently showing this item. */
function refreshInfoSurfaces(media) {
  // A re-render replaces the note textarea, so half-typed text has to be banked
  // first — otherwise saving a tag silently ate whatever was in the note box.
  // flushPendingNotes() blanks each input before saving it, so the re-render
  // this triggers can't double-add.
  if (typeof flushPendingNotes === 'function') flushPendingNotes();
  renderResults();
  const modal = document.getElementById('modalOverlay');
  if (modal?.classList.contains('active')) showDetails(media);
  if (typeof sidebarOpen !== 'undefined' && sidebarOpen &&
      currentMediaState?.currentMediaData?.id === media.id) {
    currentMediaState.currentMediaData = media;
    renderSidebar();
  }
}

/* ── Rescan ─────────────────────────────────────────────────────────────── */

async function rescanMedia(id, btn) {
  const item = getMediaById(id);
  if (!item) return;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Scanning… (can take a minute)';
  }
  showToast(`🔄 Rescanning ${item.filename}…`);

  try {
    const resp = await fetch(`/api/media/${id}/rescan`, { method: 'POST' });
    const data = await resp.json();

    if (data.row) {
      Object.assign(item, data.row);
      refreshInfoSurfaces(item);
    }

    if (!resp.ok) throw new Error(data.error || `Server returned ${resp.status}`);

    if (data.ok) {
      showToast(`✅ Rescanned ${item.filename} (${((data.elapsed || 0) / 1000).toFixed(1)}s)`);
    } else {
      showToast(`⚠ Rescan failed again: ${data.error}`);
    }
  } catch (err) {
    showToast(`⚠ Rescan failed: ${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🔄 Rescan';
    }
  }
}

/* ── Inline metadata editing (no popups) ────────────────────────────────────
   Each editable sidebar section carries a corner ✎ (fieldEditBtn). Clicking
   it swaps the section's .field-content for an input IN PLACE with ✓/✕.
   Saving POSTs just that field and re-renders the sidebar. */

function _csvToArray(value) {
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/** Corner pencil for a sidebar section. `key` names the field/editor. */
function fieldEditBtn(id, key) {
  return `<button class="field-edit-btn" onclick="startFieldEdit(this, ${id}, '${key}')" title="Edit">✎</button>`;
}

/** POST one-or-more AI fields, sync the item, re-render everything. */
async function saveMetaFields(id, fields, okMsg = '💾 Saved') {
  const item = getMediaById(id);
  if (!item) return false;
  try {
    const resp = await fetch(`/api/media/${id}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    Object.assign(item, await resp.json());
    // Edited fields are searchable — drop the cached search text / fuzzy index
    if (typeof invalidateFuse === 'function') invalidateFuse();
    refreshInfoSurfaces(item);
    showToast(okMsg);
    return true;
  } catch (err) {
    showToast('⚠ Save failed: ' + err.message);
    return false;
  }
}

/**
 * Discard an inline edit by re-rendering the surface it lives in. The editors
 * now appear in the library modal as well as the player sidebar, so blindly
 * calling renderSidebar() would repaint the wrong panel (or none) and leave
 * the half-open editor on screen.
 */
function _cancelEdit(node) {
  // Same reason as refreshInfoSurfaces: this repaints the surface, taking the
  // note textarea with it. Cancelling a tag edit must not discard a note draft.
  if (typeof flushPendingNotes === 'function') flushPendingNotes();
  const body = node?.closest?.('.detail-body');
  if (body?.classList.contains('detail-body--library')) {
    const item = getMediaById(Number(body.dataset.mediaId));
    if (item) showDetails(item);
    return;
  }
  if (typeof renderSidebar === 'function') renderSidebar();
}

/** Build the ✓/✕ row used by every inline editor. */
function _editActions(onSave) {
  const wrap = document.createElement('span');
  wrap.className = 'inline-edit-actions';
  const save = document.createElement('button');
  save.className = 'inline-edit-save';
  save.textContent = '✓';
  save.title = 'Save (Enter)';
  save.onclick = onSave;
  const cancel = document.createElement('button');
  cancel.className = 'inline-edit-cancel';
  cancel.textContent = '✕';
  cancel.title = 'Cancel (Esc)';
  cancel.onclick = () => _cancelEdit(cancel);
  wrap.append(save, cancel);
  return wrap;
}

function _wireKeys(input, onSave) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(input.tagName === 'TEXTAREA' && !e.ctrlKey)) {
      e.preventDefault();
      onSave();
    }
    if (e.key === 'Escape') _cancelEdit(input);
  });
}

/**
 * Inline editor for a simple field section.
 * key: 'description' (textarea) | 'themes'/'tags'/'locations' (csv input)
 *      | 'info' (language/content/quality group)
 */
function startFieldEdit(btn, id, key) {
  const media = getMediaById(id);
  const section = btn.closest('.detail-section');
  const content = section?.querySelector('.field-content');
  if (!media || !content) return;

  if (key === 'info') return startInfoEdit(content, media);

  const isText = key === 'description';
  const currentValue = isText
    ? (media.description || '')
    : safeParseJSON(media[key], []).join(', ');

  content.innerHTML = '';
  const editor = document.createElement('div');
  editor.className = 'inline-edit';

  const input = document.createElement(isText ? 'textarea' : 'input');
  if (isText) input.rows = 4;
  else {
    input.type = 'text';
    input.placeholder = 'comma, separated, values';
  }
  input.className = 'inline-edit-input';
  input.value = currentValue;

  const doSave = () => {
    const v = input.value.trim();
    saveMetaFields(id, { [key]: isText ? v : _csvToArray(v) });
  };
  _wireKeys(input, doSave);

  editor.appendChild(input);
  editor.appendChild(_editActions(doSave));
  content.appendChild(editor);
  input.focus();
}

/** Inline group editor for language / content type / quality. */
function startInfoEdit(content, media) {
  content.innerHTML = '';
  const editor = document.createElement('div');
  editor.className = 'inline-edit inline-edit-grid';

  const fields = [
    ['language', 'Language', media.language || ''],
    ['content_type', 'Content', media.content_type || ''],
    ['quality_flag', 'Quality', media.quality_flag || ''],
  ];
  const inputs = {};
  for (const [k, label, val] of fields) {
    const row = document.createElement('label');
    row.className = 'inline-edit-row';
    row.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit-input';
    input.value = val;
    inputs[k] = input;
    row.appendChild(input);
    editor.appendChild(row);
  }
  const doSave = () => saveMetaFields(media.id, {
    language: inputs.language.value.trim(),
    content_type: inputs.content_type.value.trim(),
    quality_flag: inputs.quality_flag.value.trim(),
  });
  Object.values(inputs).forEach(i => _wireKeys(i, doSave));

  editor.appendChild(_editActions(doSave));
  content.appendChild(editor);
  inputs.language.focus();
}

/** Inline editor for ONE media_elements entry (edits its details text). */
function startElementEdit(btn, id, index) {
  const media = getMediaById(id);
  if (!media) return;
  const elements = safeParseJSON(media.media_elements, []);
  if (!Array.isArray(elements) || !elements[index]) return;

  const chip = btn.closest('.element-item');
  const details = chip?.querySelector('.element-details');
  if (!details) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit-input element-edit-input';
  input.value = elements[index].details || '';

  const doSave = () => {
    elements[index] = { ...elements[index], details: input.value.trim() };
    saveMetaFields(id, { media_elements: elements });
  };
  _wireKeys(input, doSave);

  details.replaceWith(input);
  btn.replaceWith(_editActions(doSave));
  input.focus();
  input.select();
}

/* ── Remove records (library only — files untouched) ───────────────────── */

async function removeRecords(ids) {
  const items = ids.map(getMediaById).filter(Boolean);
  if (items.length === 0) return;

  const label = items.length === 1 ? `"${items[0].filename}"` : `${items.length} records`;
  const ok = confirm(
    `Remove ${label} from the library?\n\n` +
    `• The file(s) on disk are NOT touched\n` +
    `• All metadata, notes, ratings and view history for the record(s) are permanently deleted\n` +
    `• A future scan of their folder will re-add them as fresh entries`
  );
  if (!ok) return;

  try {
    const resp = await fetch('/api/records/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const { deleted } = await resp.json();

    // Drop from the in-memory library + close any surface showing them
    const idSet = new Set(ids);
    for (let i = allMedia.length - 1; i >= 0; i--) {
      if (idSet.has(allMedia[i].id)) allMedia.splice(i, 1);
    }
    if (typeof selectedIds !== 'undefined') ids.forEach(id => selectedIds.delete(id));
    closeModal?.();
    if (typeof closeMediaPlayer === 'function' &&
        idSet.has(currentMediaState?.currentMediaData?.id)) {
      closeMediaPlayer();
    }

    applyFilters({ keepPage: true }); // stay on the current page after removal
    if (typeof renderSelectionBar === 'function') renderSelectionBar();
    showToast(`✂ Removed ${deleted} record(s), files kept on disk`);
  } catch (err) {
    showToast('⚠ Remove failed: ' + err.message);
  }
}

function removeSelectedRecords() {
  removeRecords([...selectedIds]);
}
