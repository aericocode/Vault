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
  // Classic keeps each label's emoji, Modern shows the line icon (icons.js).
  const label = (s) => (typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel(s) : s);
  return `
    <div class="meta-tools">
      ${media.processing_error ? `
      <button class="meta-tool-btn meta-rescan-btn" onclick="rescanMedia(${media.id}, this)" title="Run the AI scan on this file now (LM Studio must be running)">
        ${label(media.processing_error === 'unscanned' ? '⏳ Scan now' : '🔄 Rescan')}
      </button>` : ''}
      ${media.media_type !== 'mix' ? `
      <button class="meta-tool-btn meta-refresh-btn" onclick="window.vaultForceRefresh && window.vaultForceRefresh([${media.id}], this)"
        title="Force refresh: read the file again (length, size, codecs), remake its thumbnail and hover frames, and clear a stale error. The AI scan is not redone">
        ${typeof vaultIconSwap === 'function' ? vaultIconSwap('🔄 ', 'refresh') : '🔄 '}Force refresh
      </button>` : ''}
      <button class="meta-tool-btn" onclick="openCollectionPicker([${media.id}], this)" title="Add this file to a collection, or take it out of one">
        ${label('📁 Collections')}
      </button>
      <button class="meta-tool-btn meta-remove-btn" onclick="removeRecords([${media.id}])" title="Take this file out of the library. The file on disk is not touched">
        ${label('✂ Remove from library')}
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

  const label = (s) => (typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel(s) : s);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = label('⏳ Scanning… (can take a minute)');
  }
  showToast(`🔄 Scanning ${item.filename}…`);

  try {
    const resp = await fetch(`/api/media/${id}/rescan`, { method: 'POST' });
    const data = await resp.json().catch(() => ({}));

    if (data.row) {
      Object.assign(item, data.row);
      refreshInfoSurfaces(item);
    }

    if (!resp.ok) throw metaHttpError(resp.status, data.error);

    if (data.ok) {
      showToast(`Scanned ${item.filename} in ${((data.elapsed || 0) / 1000).toFixed(1)} s.`, { type: 'success' });
    } else {
      // The scan ran and failed: the reason is shown in the file's Processing error.
      const why = friendlyError(data.error);
      showToast(`The scan of ${item.filename} failed again. ${why === friendlyError(null) ? 'Its details say why.' : why}`, { type: 'error' });
    }
  } catch (err) {
    showErrorToast(err, 'scanning the file');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = label('🔄 Rescan');
    }
  }
}

/** A failed request as an Error showErrorToast can word (the server's sentence, or a plain "try again"). */
function metaHttpError(status, serverText) {
  const err = new Error(serverText || `Server returned ${status}`);
  err.status = status;
  if (!serverText) err.name = 'HttpError';
  return err;
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

/** POST one-or-more AI fields, sync the item, re-render everything.
 *  Resolves to whether the server saved it. */
async function saveMetaFields(id, fields, okMsg = '💾 Saved') {
  const item = getMediaById(id);
  if (!item) return false;
  try {
    // An edit of ours: the grid does not re-run its search for it (as before).
    const resp = await Library.ownWrite(fetch(`/api/media/${id}/metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }));
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw metaHttpError(resp.status, body && body.error);
    }
    const updated = await resp.json();
    for (const k of ['embedding', 'audio_transcription']) delete updated[k];
    Object.assign(item, updated);
    Library.patchRow(item);
    refreshInfoSurfaces(item);
    // okMsg null: no toast (the dock pane shows its own small "Saved" tick).
    if (okMsg !== null) showToast(okMsg);
    return true;
  } catch (err) {
    showErrorToast(err, 'saving the change');
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
  // The Modern Info panel shows line icons here (icons.js vaultPanelIconSwap).
  const glyph = (emoji, icon) => (typeof vaultPanelIconSwap === 'function' ? vaultPanelIconSwap(emoji, icon) : emoji);
  save.innerHTML = glyph('✓', 'check');
  save.title = 'Save (Enter)';
  save.onclick = onSave;
  const cancel = document.createElement('button');
  cancel.className = 'inline-edit-cancel';
  cancel.innerHTML = glyph('✕', 'close');
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
  input.className = 'inline-edit-input m-field';   // .m-field: the Modern field (layout-modern.css)
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
    input.className = 'inline-edit-input m-field';
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
  input.className = 'inline-edit-input element-edit-input m-field';
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

// Ids per /api/records/delete request: well under the 2 MB JSON body limit.
const REMOVE_ID_CHUNK = 50000;

async function removeRecords(ids) {
  if (ids.length === 0) return;
  // One record is named; a selection is counted (Select all can hand this a
  // whole library, whose rows the tab never loads).
  let label = `${ids.length.toLocaleString()} files`;
  if (ids.length === 1) {
    const [only] = await Library.fetchRows(ids);
    if (!only) return;
    label = `"${only.filename}"`;
  }
  const one = ids.length === 1;
  const ok = await vaultConfirm(`Remove ${label} from the library?`, {
    title: 'Remove from library',
    list: one ? [
      'The file stays on disk. Only its library entry is removed.',
      'Its tags, notes, ratings and watch history are deleted for good.',
      'Scanning its folder again adds it back as a new entry.',
    ] : [
      'The files stay on disk. Only their library entries are removed.',
      'Their tags, notes, ratings and watch history are deleted for good.',
      'Scanning their folder again adds them back as new entries.',
    ],
    okLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;

  // Chunked (body limit); each chunk deletes its own records outright, so
  // splitting changes nothing but the number of requests. A chunk that fails
  // stops the run: the chunks before it are gone, and everything below says
  // exactly that rather than "failed".
  let deleted = 0;
  let sent = 0;            // ids in the chunks the server confirmed
  let error = null;
  for (let i = 0; i < ids.length; i += REMOVE_ID_CHUNK) {
    const chunk = ids.slice(i, i + REMOVE_ID_CHUNK);
    try {
      const resp = await fetch('/api/records/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: chunk }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw metaHttpError(resp.status, body && body.error);
      }
      deleted += (await resp.json()).deleted || 0;
      sent += chunk.length;
    } catch (err) {
      error = err;
      break;
    }
  }

  // Drop what is gone from the row cache and the selection, close any
  // surface showing it, and re-run the query.
  const removed = ids.slice(0, sent);
  if (removed.length) {
    const idSet = new Set(removed);
    Library.forget(removed);
    if (typeof selectedIds !== 'undefined') {
      removed.forEach(id => selectedIds.delete(id));
      if (typeof selectionChanged === 'function') selectionChanged();
    }
    closeModal?.();
    if (typeof closeMediaPlayer === 'function' &&
        idSet.has(currentMediaState?.currentMediaData?.id)) {
      closeMediaPlayer();
    }
    applyFilters({ keepPage: true }); // stay on the current page after removal
  }
  if (typeof renderSelectionBar === 'function') renderSelectionBar();

  const files = (n) => `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
  if (!error) {
    showToast(deleted === 1
      ? '✂ Removed 1 file from the library. The file stays on disk.'
      : `✂ Removed ${files(deleted)} from the library. The files stay on disk.`);
  } else if (!removed.length) {
    showErrorToast(error, 'removing from the library');
  } else {
    showToast(`Removed ${deleted.toLocaleString()} of ${files(ids.length)} from the library. ` +
      `${(ids.length - sent).toLocaleString()} could not be removed: ${friendlyError(error, 'removing them')} The files stay on disk.`,
      { type: 'error' });
  }
}

function removeSelectedRecords() {
  removeRecords([...selectedIds]);
}
