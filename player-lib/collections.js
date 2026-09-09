/* =========================================================================
   COLLECTIONS - Hierarchical collections (folders of collections + playlists)

   Model: collections.kind = 'folder' | 'collection'. Folders hold other
   collections/folders (via parent_id); ONLY collections hold media items.
   A collection IS a playlist when played; a folder plays as the deduped union
   of its whole subtree.

   Surfaces (flat, emoji-free, app dark tokens):
   - Collections TAB: breadcrumb chips + folder cards + collection mosaic cards,
     drill in/out, per-card ⋯ menu (Rename / Move to… / Delete).
   - Add-to-collection PICKER: instant tree from cache, square checkboxes,
     type-ahead, + New collection / + New folder, optimistic toggle.
   ========================================================================= */

let collectionsList = [];                 // [{id, name, description, parent_id, kind, item_count, child_count, first_ids}]
let collectionMembers = new Map();        // collection id → ordered media_id array (LOAD-BEARING cache for filters.js)
let activeCollectionId = null;            // an OPEN collection/folder filters the grid
let currentFolderId = null;               // Collections-tab drill-in context (null = root)

/* ── Inline SVG icons (no external assets — privacy rule) ───────────────── */
const ICON = {
  chevron: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  folderBig: '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  dash: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  folderPlus: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3"/><line x1="12" y1="14" x2="12" y2="20"/><line x1="9" y1="17" x2="15" y2="17"/></svg>',
  dots: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
};

async function loadCollections() {
  try {
    collectionsList = await fetch('/api/collections').then(r => r.json());
    // Prefetch memberships for COLLECTIONS only (folders resolve on open) — the
    // id sets power filters.js (mediaInAnyCollection / active-collection view).
    await Promise.all(
      collectionsList.filter(c => c.kind !== 'folder').map(c => fetchCollectionMembers(c.id, true))
    );
  } catch {
    collectionsList = [];
  }
  renderCollectionHeader();
  renderCollectionsTabBar();
  if (typeof renderResults === 'function') renderResults();
}

/** Media ids that passed the current filters (published by applyFilters). */
let lastMatchedIds = new Set();

function setMatchedMediaIds(list) {
  lastMatchedIds = new Set(list.map(m => m.id));
}

async function fetchCollectionMembers(id, force = false) {
  if (!force && collectionMembers.has(id)) return collectionMembers.get(id);
  const data = await fetch(`/api/collections/${id}`).then(r => r.json());
  collectionMembers.set(id, data.media_ids || []);
  return collectionMembers.get(id);
}

function getCollectionById(id) {
  return collectionsList.find(c => c.id === id);
}

/* ── Tree helpers (client mirror of the server's parent_id tree) ────────── */

/** Root→id chain of folders (for breadcrumbs and path prefixes). */
function _folderPath(id) {
  const path = [];
  let cur = id;
  const seen = new Set();
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    const c = getCollectionById(cur);
    if (!c) break;
    path.unshift({ id: c.id, name: c.name });
    cur = c.parent_id ?? null;
  }
  return path;
}

/** "Folder / Sub / " muted prefix for a collection shown out of context. */
function _pathPrefix(c) {
  const p = _folderPath(c.parent_id).map(f => escapeHtml(f.name)).join(' / ');
  return p ? `<span class="coll-path">${p} / </span>` : '';
}

/** Deduped union of a folder subtree's collection members, from the cache. */
function _folderAggregateIds(folderId) {
  const seen = new Set();
  const out = [];
  const walk = (pid) => {
    for (const ch of collectionsList.filter(x => x.parent_id === pid)) {
      if (ch.kind === 'folder') walk(ch.id);
      else for (const m of (collectionMembers.get(ch.id) || [])) {
        if (!seen.has(m)) { seen.add(m); out.push(m); }
      }
    }
  };
  walk(folderId);
  return out;
}

/** Is `folderId` an ancestor (or self) of collection/folder `id`? */
function _isAncestorFolder(folderId, id) {
  let cur = id;
  const seen = new Set();
  while (cur != null && !seen.has(cur)) {
    if (cur === folderId) return true;
    seen.add(cur);
    cur = getCollectionById(cur)?.parent_id ?? null;
  }
  return false;
}

/* ── Collections TAB: breadcrumb + New actions + View all ──────────────── */

function renderCollectionsTabBar() {
  const bar = document.getElementById('collectionsTabBar');
  if (!bar) return;
  const show = (typeof currentTab !== 'undefined' && currentTab === 'collections') && activeCollectionId == null;
  if (!show) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
  bar.style.display = 'flex';

  const crumbs = [{ id: null, name: 'Collections' }, ..._folderPath(currentFolderId)];
  const crumbHtml = crumbs.map((cr, i) => {
    const last = i === crumbs.length - 1;
    const arg = cr.id === null ? 'null' : cr.id;
    return `<button class="coll-crumb ${last ? 'current' : ''}" data-crumb-parent="${cr.id === null ? '' : cr.id}" onclick="drillIntoFolder(${arg})">${escapeHtml(cr.name)}</button>`
      + (last ? '' : '<span class="coll-crumb-sep">›</span>');
  }).join('');

  let viewAll = '';
  if (currentFolderId != null) {
    const f = getCollectionById(currentFolderId);
    viewAll = `<button class="coll-viewall" onclick="openCollection(${currentFolderId})" title="Play this folder as one playlist">View all ${f ? f.item_count : 0} items</button>`;
  }

  bar.innerHTML = `
    <div class="coll-crumbs">${crumbHtml}</div>
    <div class="coll-tabbar-actions">
      ${viewAll}
      <button class="coll-newbtn" onclick="createFromTab('folder')">${ICON.plus} New folder</button>
      <button class="coll-newbtn" onclick="createFromTab('collection')">${ICON.plus} New collection</button>
    </div>`;
}

function drillIntoFolder(id) {
  currentFolderId = id;
  closeCardMenu();
  renderCollectionsTabBar();
  renderResults();
}

/** Placeholder that names the destination folder when drilled in. */
function _createPlaceholder(kind, parentId) {
  const noun = kind === 'folder' ? 'folder' : 'collection';
  const f = parentId != null ? getCollectionById(parentId) : null;
  return f ? `New ${noun} in ${f.name}…` : `New ${noun} name…`;
}

function createFromTab(kind) {
  const bar = document.getElementById('collectionsTabBar');
  const actions = bar?.querySelector('.coll-tabbar-actions');
  if (!actions || actions.querySelector('.coll-create-input')) return;
  const input = document.createElement('input');
  input.className = 'coll-create-input';
  input.placeholder = _createPlaceholder(kind, currentFolderId);
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { renderCollectionsTabBar(); return; }
    if (e.key === 'Enter') {
      const name = input.value.trim();
      if (!name) { renderCollectionsTabBar(); return; }
      const created = await apiCreateCollection(name, kind, currentFolderId);
      renderCollectionsTabBar();
      if (created) renderResults();
    }
  });
  input.addEventListener('blur', () => setTimeout(renderCollectionsTabBar, 150));
  actions.innerHTML = '';
  actions.appendChild(input);
  input.focus();
}

/** POST a new collection/folder; update local state. @returns created row|null */
async function apiCreateCollection(name, kind, parentId) {
  const resp = await fetch('/api/collections', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, kind, parent_id: parentId ?? null }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    showToast(e.code === 'NAME_TAKEN' ? '⚠ A collection with that name already exists here' : `⚠ ${e.error || 'Create failed'}`);
    return null;
  }
  const created = await resp.json();
  collectionsList.push({ ...created, item_count: 0, child_count: 0, first_ids: [] });
  if (created.kind !== 'folder') collectionMembers.set(created.id, []);
  return created;
}

/* ── Collection / folder CARDS in the grid ─────────────────────────────── */

/** Tri-filter value: '' include, '1' only, '0' hide. */
function collectionsFilterValue() {
  return typeof getTriFilterValue === 'function' ? getTriFilterValue('filterCollections') : '';
}

/**
 * Card HTML for the Collections tab. Root/folder context shows this folder's
 * direct children (folders first, then collections). A tab search flattens
 * matching collections across all folders with a muted path prefix.
 */
function renderCollectionCards() {
  if (typeof currentTab !== 'undefined' && currentTab !== 'collections') return '';
  if (activeCollectionId != null) return '';

  const q = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();

  if (q) {
    const matches = collectionsList.filter(c => c.kind !== 'folder' && c.name.toLowerCase().includes(q));
    if (matches.length === 0) return `<div class="coll-empty-state">No collections match your search.</div>`;
    return matches.map(c => collectionCardHtml(c, true)).join('');
  }

  const children = collectionsList
    .filter(c => (c.parent_id ?? null) === (currentFolderId ?? null))
    .sort((a, b) => (a.kind === 'folder' ? 0 : 1) - (b.kind === 'folder' ? 0 : 1));

  if (children.length === 0) {
    const msg = currentFolderId == null
      ? 'No collections yet. Select files in the Library to Collect them, or add a folder above.'
      : 'This folder is empty. Add a collection above.';
    return `<div class="coll-empty-state">${msg}</div>`;
  }
  return children.map(c => c.kind === 'folder' ? folderCardHtml(c) : collectionCardHtml(c, false)).join('');
}

function folderCardHtml(c) {
  return `
    <div class="media-tile folder-tile" data-coll-id="${c.id}" data-drag-id="${c.id}" data-drag-kind="folder" draggable="true" onclick="drillIntoFolder(${c.id})" title="${escapeHtml(c.name)}">
      <div class="tile-thumb folder-glyph">${ICON.folderBig}</div>
      <div class="tile-name">${escapeHtml(c.name)}</div>
      <div class="tile-meta">${c.child_count} collection${c.child_count === 1 ? '' : 's'} · ${c.item_count} item${c.item_count === 1 ? '' : 's'}</div>
      <button class="coll-card-menu-btn" onclick="event.stopPropagation(); openCardMenu(${c.id}, this)" title="More">${ICON.dots}</button>
    </div>`;
}

function collectionCardHtml(c, showPath) {
  const thumbs = (c.first_ids || []).slice(0, 4);
  const cells = Array.from({ length: 4 }, (_, i) => thumbs[i]
    ? `<img class="coll-mosaic-img" loading="lazy" draggable="false" src="/thumb/${thumbs[i]}" alt="" onerror="this.style.visibility='hidden'">`
    : '<div class="coll-mosaic-empty"></div>').join('');
  const prefix = showPath ? _pathPrefix(c) : '';
  return `
    <div class="media-tile collection-tile" data-coll-id="${c.id}" data-drag-id="${c.id}" data-drag-kind="collection" draggable="true" onclick="openCollection(${c.id})" title="${escapeHtml(c.name)}${c.description ? ' — ' + escapeHtml(c.description) : ''}">
      <div class="tile-thumb coll-mosaic">${cells}</div>
      <div class="tile-name">${prefix}${escapeHtml(c.name)}</div>
      <div class="tile-meta"><span class="coll-count">${c.item_count} item${c.item_count === 1 ? '' : 's'}</span></div>
      <button class="coll-card-menu-btn" onclick="event.stopPropagation(); openCardMenu(${c.id}, this)" title="More">${ICON.dots}</button>
    </div>`;
}

/* ── Per-card ⋯ menu: Rename / Move to… / Delete ───────────────────────── */

let _cardMenuEl = null;

function openCardMenu(id, btn) {
  closeCardMenu();
  const c = getCollectionById(id);
  if (!c) return;
  const menu = document.createElement('div');
  menu.className = 'coll-card-menu';
  menu.innerHTML = `
    <button class="coll-menu-item" onclick="cardRename(${id})">Rename</button>
    <button class="coll-menu-item" onclick="cardMoveMenu(${id})">Move to…</button>
    <button class="coll-menu-item coll-menu-danger" onclick="cardDelete(${id}, this)">Delete</button>`;
  document.body.appendChild(menu);
  _cardMenuEl = menu;
  const r = btn.getBoundingClientRect();
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`;
  menu.style.left = `${Math.min(window.innerWidth - menu.offsetWidth - 8, r.left)}px`;
  setTimeout(() => {
    document.addEventListener('pointerdown', _cardMenuOutside, true);
    document.addEventListener('keydown', _cardMenuEsc);
  }, 0);
}

function _cardMenuOutside(e) { if (!e.target.closest('.coll-card-menu')) closeCardMenu(); }
function _cardMenuEsc(e) { if (e.key === 'Escape') closeCardMenu(); }
function closeCardMenu() {
  _cardMenuEl?.remove();
  _cardMenuEl = null;
  document.removeEventListener('pointerdown', _cardMenuOutside, true);
  document.removeEventListener('keydown', _cardMenuEsc);
}

async function cardRename(id) {
  closeCardMenu();
  const c = getCollectionById(id);
  const nameEl = document.querySelector(`.media-tile[data-coll-id="${id}"] .tile-name`);
  if (!c || !nameEl) return;
  const input = document.createElement('input');
  input.className = 'coll-create-input';
  input.value = c.name;
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { renderResults(); return; }
    if (e.key !== 'Enter') return;
    const v = input.value.trim();
    if (v && v !== c.name) {
      const resp = await fetch(`/api/collections/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v }),
      });
      if (!resp.ok) {
        const e2 = await resp.json().catch(() => ({}));
        showToast(e2.code === 'NAME_TAKEN' ? '⚠ A collection with that name already exists here' : '⚠ Rename failed');
        renderResults(); return;
      }
      c.name = v;
      showToast('Renamed');
    }
    renderResults();
    renderCollectionsTabBar();
  });
  input.addEventListener('blur', () => setTimeout(renderResults, 150));
  nameEl.innerHTML = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
}

function cardMoveMenu(id) {
  if (!_cardMenuEl) return;
  const folders = collectionsList.filter(f => f.kind === 'folder' && f.id !== id);
  const opts = [`<button class="coll-menu-item" onclick="cardMove(${id}, null)">Top level</button>`]
    .concat(folders.map(f => `<button class="coll-menu-item" onclick="cardMove(${id}, ${f.id})">${escapeHtml(f.name)}</button>`));
  _cardMenuEl.innerHTML = `<div class="coll-menu-head">Move to</div>${opts.join('')}`;
}

async function cardMove(id, parentId) {
  closeCardMenu();
  const resp = await fetch(`/api/collections/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent_id: parentId }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    const msg = e.code === 'NAME_TAKEN' ? '⚠ A collection with that name already exists there'
      : e.code === 'CYCLE' ? '⚠ Can’t move a folder into its own subtree'
      : `⚠ ${e.error || 'Move failed'}`;
    showToast(msg);
    return;
  }
  // Refresh the list so parent_ids + folder counts reflect the move (items,
  // hence the membership cache, are unchanged).
  collectionsList = await fetch('/api/collections').then(r => r.json());
  renderResults();
  renderCollectionsTabBar();
  showToast('Moved');
}

async function cardDelete(id, btn) {
  const c = getCollectionById(id);
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = c && c.kind === 'folder' ? 'Delete folder — contents move up?' : 'Really delete?';
    btn.classList.add('armed');
    return;
  }
  closeCardMenu();
  collectionsList = await fetch(`/api/collections/${id}`, { method: 'DELETE' }).then(r => r.json());
  collectionMembers.delete(id);
  if (activeCollectionId === id) activeCollectionId = null;
  renderResults();
  renderCollectionsTabBar();
  showToast(c && c.kind === 'folder' ? 'Folder deleted — contents moved up a level' : 'Collection deleted — files and records untouched');
}

/* ── Open / close a collection or folder ───────────────────────────────── */

async function openCollection(id) {
  await fetchCollectionMembers(id, true);   // folders resolve to their aggregate union
  activeCollectionId = id;
  renderCollectionHeader();
  renderCollectionsTabBar();
  applyFilters();
}

function closeCollection() {
  activeCollectionId = null;
  renderCollectionHeader();
  renderCollectionsTabBar();
  applyFilters();
}

/** Header strip shown while a collection/folder is open (in #collectionsBar). */
function renderCollectionHeader() {
  const bar = document.getElementById('collectionsBar');
  if (!bar) return;
  const c = getCollectionById(activeCollectionId);
  if (!c) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  const isFolder = c.kind === 'folder';
  bar.style.display = 'flex';
  bar.innerHTML = `
    <button class="coll-back" onclick="closeCollection()" title="Back to all collections">← Collections</button>
    <div class="coll-head-main">
      <div class="coll-head-name" id="collHeadName">
        <span class="coll-head-title">${isFolder ? `<span class="coll-head-folder">${ICON.folder}</span>` : ''}${escapeHtml(c.name)}</span>
        <button class="field-edit-btn" onclick="editCollectionName(${c.id})" title="Rename">✎</button>
        <span class="coll-count">${c.item_count} item${c.item_count === 1 ? '' : 's'}${isFolder ? ' · folder' : ' · playlist order'}</span>
      </div>
      <div class="coll-head-desc" id="collHeadDesc" onclick="editCollectionDesc(${c.id})" title="Click to edit description">
        ${c.description ? escapeHtml(c.description) : '<span class="field-empty">Add a description…</span>'}
      </div>
    </div>
    <div class="coll-head-actions">
      <button class="coll-action" onclick="playCollection(${c.id}, false)">Play All</button>
      <button class="coll-action" onclick="playCollection(${c.id}, true)">Shuffle</button>
      <button class="coll-action coll-delete" id="collDeleteBtn" onclick="deleteCollectionTwoStep(${c.id}, this)">Delete</button>
    </div>
  `;
}

/* ── Inline rename + description (no popups) ───────────────────────────── */

function _inlineInput(value, placeholder, onSave) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit-input coll-head-input';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSave(input.value.trim());
    if (e.key === 'Escape') renderCollectionHeader();
  });
  input.addEventListener('blur', () => setTimeout(renderCollectionHeader, 150));
  return input;
}

function editCollectionName(id) {
  const c = getCollectionById(id);
  const holder = document.getElementById('collHeadName');
  if (!c || !holder) return;
  const input = _inlineInput(c.name, 'Collection name', async (v) => {
    if (v && v !== c.name) {
      const resp = await fetch(`/api/collections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: v }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        showToast(e.code === 'NAME_TAKEN' ? '⚠ A collection with that name already exists here' : '⚠ Rename failed');
        renderCollectionHeader(); return;
      }
      c.name = v;
      showToast('Renamed');
    }
    renderCollectionHeader();
    renderResults();
  });
  holder.innerHTML = '';
  holder.appendChild(input);
  input.focus();
  input.select();
}

function editCollectionDesc(id) {
  const c = getCollectionById(id);
  const holder = document.getElementById('collHeadDesc');
  if (!c || !holder || holder.querySelector('input')) return;
  const input = _inlineInput(c.description || '', 'Describe this collection…', async (v) => {
    await fetch(`/api/collections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: v }),
    });
    c.description = v;
    renderCollectionHeader();
  });
  holder.innerHTML = '';
  holder.appendChild(input);
  input.focus();
}

/* ── Two-step delete (no browser alert) ────────────────────────────────── */

async function deleteCollectionTwoStep(id, btn) {
  const c = getCollectionById(id);
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = c && c.kind === 'folder' ? 'Delete folder — contents move up?' : 'Really delete?';
    btn.classList.add('armed');
    setTimeout(() => {
      if (btn.isConnected) {
        delete btn.dataset.armed;
        btn.textContent = 'Delete';
        btn.classList.remove('armed');
      }
    }, 3500);
    return;
  }
  const parent = c ? (c.parent_id ?? null) : null;
  collectionsList = await fetch(`/api/collections/${id}`, { method: 'DELETE' }).then(r => r.json());
  collectionMembers.delete(id);
  if (activeCollectionId === id) { activeCollectionId = null; currentFolderId = parent; }
  renderCollectionHeader();
  renderCollectionsTabBar();
  applyFilters();
  showToast(c && c.kind === 'folder'
    ? 'Folder deleted — contents moved up a level'
    : '📁 Collection deleted — files and records untouched');
}

/* ── Playback ──────────────────────────────────────────────────────────── */

async function playCollection(id, shuffle) {
  if (activeCollectionId !== id) await openCollection(id);
  if (filteredMedia.length === 0) { showToast('Collection is empty'); return; }
  // A collection is a queue, so repeat-one would sit on the first file forever.
  // Step it down to off for this session only, leaving the remembered mode (and
  // repeat-all, which still advances) alone.
  if (typeof repeatMode === 'function' && repeatMode() === 'one' &&
      typeof setRepeatMode === 'function') {
    setRepeatMode('off', { persist: false });
  }
  if (shuffle) {
    for (let i = filteredMedia.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [filteredMedia[i], filteredMedia[j]] = [filteredMedia[j], filteredMedia[i]];
    }
    renderResults();
  }
  const first = filteredMedia[0];
  playMedia({ filepath: first.filepath, filename: first.filename, media_type: first.media_type });
}

/* ── Filter-layer hooks (called from filters.js) ───────────────────────── */

/** Is this media id in ANY collection? (📁 tri-filter on the Library tab.)
 *  Folders are aggregates of collections, so they're skipped — a media item's
 *  membership is fully captured by the leaf collections' caches. */
function mediaInAnyCollection(id) {
  for (const c of collectionsList) {
    if (c.kind === 'folder') continue;
    const ids = collectionMembers.get(c.id);
    if (ids && ids.includes(id)) return true;
  }
  return false;
}

/** Membership test for applyFilters (works for an open collection OR folder —
 *  a folder's cache holds its aggregate union, set on open). */
function inActiveCollection(m) {
  if (activeCollectionId == null) return true;
  const ids = collectionMembers.get(activeCollectionId);
  return ids ? ids.includes(m.id) : true;
}

/** Playlist-order comparator hook for sortFilteredMedia. */
function applyCollectionOrder(list) {
  if (activeCollectionId == null) return false;
  const ids = collectionMembers.get(activeCollectionId);
  if (!ids) return false;
  const pos = new Map(ids.map((id, i) => [id, i]));
  list.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
  return true;
}

/* ── Add-to-collection PICKER (shared: single item + multi-select) ─────── */

let _pickerIds = [];
let _pickerFilter = '';
const PICKER_EXPANDED_KEY = 'collPickerExpanded';

function _pickerExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(PICKER_EXPANDED_KEY) || '[]')); }
  catch { return new Set(); }
}
function _setPickerExpanded(set) {
  try { localStorage.setItem(PICKER_EXPANDED_KEY, JSON.stringify([...set])); } catch {}
}

function openCollectionPicker(ids, anchorEl) {
  _pickerIds = ids.filter(Boolean);
  if (_pickerIds.length === 0) return;
  closeCollectionPicker();
  _pickerFilter = '';

  // Open INSTANTLY from the local cache — no awaited requests.
  const panel = document.createElement('div');
  panel.id = 'collectionPicker';
  panel.className = 'coll-picker';
  panel.innerHTML = buildPickerHtml();
  document.body.appendChild(panel);

  const r = anchorEl?.getBoundingClientRect();
  const top = r ? Math.min(window.innerHeight - panel.offsetHeight - 12, r.bottom + 6) : 120;
  const left = r ? Math.min(window.innerWidth - panel.offsetWidth - 12, r.left) : 120;
  panel.style.top = `${Math.max(8, top)}px`;
  panel.style.left = `${Math.max(8, left)}px`;

  setTimeout(() => document.addEventListener('pointerdown', _pickerOutside, true), 0);

  // ONE background request to true-up any drifted row states.
  refreshPickerMembership();
}

function _pickerOutside(e) {
  if (e.target.closest('#collectionPicker')) return;
  closeCollectionPicker();
}

function closeCollectionPicker() {
  document.getElementById('collectionPicker')?.remove();
  document.removeEventListener('pointerdown', _pickerOutside, true);
}

/** all | some | none for the selected ids against a collection's cache. */
function _collectionState(c) {
  const members = collectionMembers.get(c.id) || [];
  const inCount = _pickerIds.filter(id => members.includes(id)).length;
  return inCount === 0 ? 'none' : (inCount === _pickerIds.length ? 'all' : 'some');
}

function _checkboxHtml(state) {
  const inner = state === 'all' ? ICON.check : state === 'some' ? ICON.dash : '';
  return `<span class="coll-check" data-state="${state}">${inner}</span>`;
}

function buildPickerHtml() {
  return `
    <div class="coll-picker-head">Add ${_pickerIds.length > 1 ? `${_pickerIds.length} items` : 'to collection'}</div>
    <input type="text" class="coll-picker-filter" id="collPickerFilter" placeholder="Filter collections…"
      oninput="onPickerFilter(this.value)" value="${escapeHtml(_pickerFilter)}">
    <div class="coll-picker-list" id="collPickerList">${buildPickerRows()}</div>
    <div class="coll-picker-topbar" id="collPickerTopBar" data-crumb-parent="">${ICON.folder}<span>Move to top level</span></div>
    <div class="coll-picker-footer">
      <button class="coll-picker-add" onclick="pickerCreate('collection')">${ICON.plus} New collection</button>
      <button class="coll-picker-add" onclick="pickerCreate('folder')">${ICON.plus} New folder</button>
    </div>
  `;
}

function buildPickerRows() {
  if (_pickerFilter) {
    const q = _pickerFilter.toLowerCase();
    const matches = collectionsList.filter(c => c.kind !== 'folder' && c.name.toLowerCase().includes(q));
    if (matches.length === 0) return '<div class="coll-picker-empty">No matches</div>';
    return matches.map(c => pickerCollRow(c, 0, true)).join('');
  }
  const expanded = _pickerExpanded();
  const out = [];
  const walk = (nodes, depth) => {
    for (const c of nodes) {
      if (c.kind === 'folder') {
        const open = expanded.has(c.id);
        out.push(pickerFolderRow(c, depth, open));
        if (open) walk(collectionsList.filter(x => x.parent_id === c.id), depth + 1);
      } else {
        out.push(pickerCollRow(c, depth, false));
      }
    }
  };
  walk(collectionsList.filter(c => (c.parent_id ?? null) === null), 0);
  return out.join('') || '<div class="coll-picker-empty">No collections yet</div>';
}

function pickerFolderRow(c, depth, open) {
  const nm = escapeHtml(c.name);
  return `<div class="coll-picker-row coll-picker-folder" data-drag-id="${c.id}" data-drag-kind="folder" draggable="true" style="padding-left:${8 + depth * 20}px" onclick="togglePickerFolder(${c.id})">
    <span class="coll-chevron-wrap ${open ? 'open' : ''}">${ICON.chevron}</span>
    <span class="coll-folder-ic">${ICON.folder}</span>
    <span class="coll-picker-name">${nm}</span>
    <span class="coll-count" data-fcount="${c.id}">${c.item_count}</span>
    <span class="coll-folder-actions">
      <button type="button" class="coll-folder-act" title="New collection in ${nm}" onclick="event.stopPropagation(); pickerCreateChild(${c.id}, 'collection')">${ICON.plus}</button>
      <button type="button" class="coll-folder-act" title="New subfolder in ${nm}" onclick="event.stopPropagation(); pickerCreateChild(${c.id}, 'folder')">${ICON.folderPlus}</button>
    </span>
  </div>`;
}

function pickerCollRow(c, depth, showPath) {
  const prefix = showPath ? _pathPrefix(c) : '';
  return `<div class="coll-picker-row coll-picker-coll" data-id="${c.id}" data-drag-id="${c.id}" data-drag-kind="collection" draggable="true" style="padding-left:${8 + depth * 20}px" onclick="togglePickerCollection(${c.id})">
    ${_checkboxHtml(_collectionState(c))}
    <span class="coll-picker-name">${prefix}${escapeHtml(c.name)}</span>
    <span class="coll-count" data-count="${c.id}">${c.item_count}</span>
  </div>`;
}

function onPickerFilter(v) {
  _pickerFilter = v.trim();
  const list = document.getElementById('collPickerList');
  if (list) list.innerHTML = buildPickerRows();
}

function togglePickerFolder(id) {
  const set = _pickerExpanded();
  if (set.has(id)) set.delete(id); else set.add(id);
  _setPickerExpanded(set);
  const list = document.getElementById('collPickerList');
  if (list) list.innerHTML = buildPickerRows();
}

function _rebuildPicker() {
  const panel = document.getElementById('collectionPicker');
  if (panel) panel.innerHTML = buildPickerHtml();
}

/** Patch one collection row's checkbox + count in place (data-id targeted). */
function _patchPickerRow(id) {
  const c = getCollectionById(id);
  const row = document.querySelector(`#collectionPicker .coll-picker-coll[data-id="${id}"]`);
  if (c && row) {
    const chk = row.querySelector('.coll-check');
    const state = _collectionState(c);
    if (chk) { chk.dataset.state = state; chk.innerHTML = state === 'all' ? ICON.check : state === 'some' ? ICON.dash : ''; }
    const count = row.querySelector('.coll-count');
    if (count) count.textContent = c.item_count;
  }
}

/** Recompute + repaint ancestor-folder aggregate counts after a toggle. */
function _patchAncestorCounts(collId) {
  let pid = getCollectionById(collId)?.parent_id ?? null;
  const seen = new Set();
  while (pid != null && !seen.has(pid)) {
    seen.add(pid);
    const f = getCollectionById(pid);
    if (!f) break;
    f.item_count = _folderAggregateIds(pid).length;
    const span = document.querySelector(`#collectionPicker [data-fcount="${pid}"]`);
    if (span) span.textContent = f.item_count;
    pid = f.parent_id ?? null;
  }
}

/** POST membership for _pickerIds; correct any drifted row display. */
async function refreshPickerMembership() {
  let rows;
  try {
    rows = await fetch('/api/collections/membership', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: _pickerIds }),
    }).then(r => r.json());
  } catch { return; }
  if (!document.getElementById('collectionPicker') || !Array.isArray(rows)) return;
  const counts = new Map(rows.map(r => [r.id, r.member_count]));
  for (const c of collectionsList) {
    if (c.kind === 'folder') continue;
    const serverIn = counts.get(c.id) || 0;
    const cacheIn = _pickerIds.filter(id => (collectionMembers.get(c.id) || []).includes(id)).length;
    if (serverIn !== cacheIn) {
      // Cache drifted — trust the server for the picker's tri-state. Re-fetch
      // the true id list so the cache (and filters) heal too.
      await fetchCollectionMembers(c.id, true);
      _patchPickerRow(c.id);
      _patchAncestorCounts(c.id);
    }
  }
}

/** Side effects after a membership change (scoped — no blanket re-render). */
function _applyToggleSideEffects(id) {
  // An open collection/folder whose contents changed must re-filter the grid.
  if (activeCollectionId != null && (activeCollectionId === id || _isAncestorFolder(activeCollectionId, id))) {
    if (activeCollectionId !== id) collectionMembers.set(activeCollectionId, _folderAggregateIds(activeCollectionId));
    renderCollectionHeader();
    if (typeof applyFilters === 'function') applyFilters();
    return;
  }
  // Library 📁 tri-filter depends on membership too.
  if (collectionsFilterValue() && typeof applyFilters === 'function') { applyFilters(); return; }
  // Collections tab at root: refresh card counts/mosaics only.
  if (typeof currentTab !== 'undefined' && currentTab === 'collections' && activeCollectionId == null
      && typeof renderResults === 'function') renderResults();
}

async function togglePickerCollection(id) {
  const c = getCollectionById(id);
  if (!c) return;
  const adding = _collectionState(c) !== 'all';

  // Snapshot for rollback
  const prevMembers = (collectionMembers.get(id) || []).slice();
  const prevCount = c.item_count;
  const prevFirst = c.first_ids;

  // Optimistic cache + card state update
  const next = adding
    ? prevMembers.concat(_pickerIds.filter(x => !prevMembers.includes(x)))
    : prevMembers.filter(x => !_pickerIds.includes(x));
  collectionMembers.set(id, next);
  c.item_count = next.length;
  c.first_ids = next.slice(0, 4);
  _patchPickerRow(id);
  _patchAncestorCounts(id);
  _applyToggleSideEffects(id);

  try {
    const resp = await fetch(`/api/collections/${id}/items`, {
      method: adding ? 'POST' : 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: _pickerIds }),
    });
    if (!resp.ok) throw new Error('request failed');
    const data = await resp.json();
    // True-up authoritative count + mosaic from the response (no follow-up GET).
    c.item_count = data.item_count;
    if (Array.isArray(data.first_ids)) c.first_ids = data.first_ids;
    _patchPickerRow(id);
    _patchAncestorCounts(id);
    showToast(adding ? `📁 Added to ${c.name}` : `Removed from ${c.name}`);
  } catch {
    collectionMembers.set(id, prevMembers);
    c.item_count = prevCount;
    c.first_ids = prevFirst;
    _patchPickerRow(id);
    _patchAncestorCounts(id);
    _applyToggleSideEffects(id);
    showToast('⚠ Collection update failed');
  }
}

function pickerCreate(kind) {
  const footer = document.querySelector('#collectionPicker .coll-picker-footer');
  if (!footer || footer.querySelector('.coll-create-input')) return;
  const input = document.createElement('input');
  input.className = 'coll-create-input';
  input.placeholder = kind === 'folder' ? 'New folder name…' : 'New collection name…';
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { _rebuildPicker(); return; }
    if (e.key !== 'Enter') return;
    const name = input.value.trim();
    if (!name) { _rebuildPicker(); return; }
    const created = await apiCreateCollection(name, kind, null); // new items at root
    _rebuildPicker();
    if (created && kind === 'collection') await togglePickerCollection(created.id); // add the items now
  });
  footer.innerHTML = '';
  footer.appendChild(input);
  input.focus();
}

/** Inline "create inside this folder" from a folder row's +/folder+ button.
 *  Auto-expands the folder and drops an input as its first (indented) child. */
function pickerCreateChild(folderId, kind) {
  const folder = getCollectionById(folderId);
  if (!folder) return;
  const set = _pickerExpanded();
  set.add(folderId);
  _setPickerExpanded(set);
  const list = document.getElementById('collPickerList');
  if (!list) return;
  list.innerHTML = buildPickerRows();

  const folderRow = list.querySelector(`.coll-picker-folder[data-drag-id="${folderId}"]`);
  if (!folderRow) return;
  // Children sit one level deeper than the folder itself.
  const childDepth = _folderPath(folderId).length;

  const row = document.createElement('div');
  row.className = 'coll-picker-row coll-picker-createrow';
  row.style.paddingLeft = `${8 + childDepth * 20}px`;
  const input = document.createElement('input');
  input.className = 'coll-create-input';
  input.placeholder = kind === 'folder' ? `New subfolder in ${folder.name}…` : `New collection in ${folder.name}…`;
  let busy = false;   // an in-flight create must not be cancelled by blur
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { row.remove(); return; }
    if (e.key !== 'Enter' || busy) return;
    const name = input.value.trim();
    if (!name) { row.remove(); return; }
    busy = true;
    const created = await apiCreateCollection(name, kind, folderId);
    busy = false;
    if (created) {
      // apiCreateCollection already updated collectionsList — insert in place.
      list.innerHTML = buildPickerRows();
      renderCollectionsTabBar();
      if (typeof renderResults === 'function') renderResults();
    } else {
      // NAME_TAKEN (or other) — toast already shown; keep the input to correct.
      input.focus();
      input.select();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (!busy) row.remove(); }, 150));
  row.appendChild(input);
  folderRow.insertAdjacentElement('afterend', row);
  input.focus();
}

/* ── Drag & drop: reparent collections/folders (picker + Collections tab) ──
   One document-level delegation set drives both surfaces. Drag sources carry
   data-drag-id / data-drag-kind; drop targets are folder rows/cards (by id)
   and any element with data-crumb-parent (breadcrumbs + the picker top bar). */

let _dragId = null;               // id of the node being dragged
let _dropEl = null;               // element currently highlighted as target
let _dragExpandTimer = null;      // picker collapsed-folder auto-expand timer
let _dragExpandFolderId = null;

/** Can `id` be re-parented under `targetParentId` (null = top level)? */
function _dragCanDrop(id, targetParentId) {
  const node = getCollectionById(id);
  if (!node) return false;
  const prev = node.parent_id ?? null;
  const dest = targetParentId ?? null;
  if (dest === prev) return false;                 // already there (no-op)
  if (dest === id) return false;                   // onto itself
  if (node.kind === 'folder' && dest != null && _isAncestorFolder(id, dest)) return false; // own descendant
  return true;
}

/** Recompute every folder's aggregate item_count + child_count from local state
 *  (structural moves change these; the membership cache is untouched). */
function _recomputeFolderCounts() {
  for (const c of collectionsList) {
    if (c.kind !== 'folder') continue;
    c.child_count = collectionsList.filter(x => (x.parent_id ?? null) === c.id).length;
    c.item_count = _folderAggregateIds(c.id).length;
  }
}

function _rerenderAfterMove() {
  const list = document.getElementById('collPickerList');
  if (list) list.innerHTML = buildPickerRows();
  renderCollectionsTabBar();
  if (typeof renderResults === 'function') renderResults();
}

/** Optimistic re-parent + background PATCH; revert + toast on failure. */
async function _applyMove(id, targetParentId) {
  const node = getCollectionById(id);
  if (!node) return;
  const dest = targetParentId ?? null;
  if (!_dragCanDrop(id, dest)) {
    if (node.kind === 'folder' && dest != null && _isAncestorFolder(id, dest)) {
      showToast('⚠ Can’t move a folder into its own subtree');
    }
    return;
  }
  const prev = node.parent_id ?? null;
  node.parent_id = dest;
  if (dest != null) { const set = _pickerExpanded(); set.add(dest); _setPickerExpanded(set); }
  _recomputeFolderCounts();
  _rerenderAfterMove();

  try {
    const resp = await fetch(`/api/collections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_id: dest }),
    });
    if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw e; }
    showToast('Moved');
  } catch (e) {
    node.parent_id = prev;
    _recomputeFolderCounts();
    _rerenderAfterMove();
    const msg = e && e.code === 'CYCLE' ? '⚠ Can’t move a folder into its own subtree'
      : e && e.code === 'NAME_TAKEN' ? '⚠ A collection with that name already exists there'
      : e && e.code === 'BAD_PARENT' ? '⚠ Invalid destination'
      : '⚠ Move failed';
    showToast(msg);
  }
}

/** Resolve the drop target under the pointer → its parent id, or undefined. */
function _dropTargetParent(target) {
  const folderRow = target.closest('.coll-picker-folder');
  if (folderRow) return { el: folderRow, parent: Number(folderRow.dataset.dragId) };
  const folderCard = target.closest('.folder-tile');
  if (folderCard) return { el: folderCard, parent: Number(folderCard.dataset.dragId) };
  const crumb = target.closest('[data-crumb-parent]');
  if (crumb) {
    const raw = crumb.getAttribute('data-crumb-parent');
    return { el: crumb, parent: raw === '' ? null : Number(raw) };
  }
  return null;
}

function _clearDropHighlight() {
  if (_dropEl) { _dropEl.classList.remove('drop-target'); _dropEl = null; }
}

function _clearDragState() {
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
  _clearDropHighlight();
  clearTimeout(_dragExpandTimer);
  _dragExpandTimer = null;
  _dragExpandFolderId = null;
  _dragId = null;
  document.getElementById('collPickerTopBar')?.classList.remove('drag-active');
}

function _onDragStart(e) {
  const src = e.target.closest('[data-drag-id]');
  if (!src) return;                       // not one of our sources
  _dragId = Number(src.dataset.dragId);
  src.classList.add('dragging');
  try { e.dataTransfer.setData('text/plain', String(_dragId)); e.dataTransfer.effectAllowed = 'move'; } catch {}
  document.getElementById('collPickerTopBar')?.classList.add('drag-active');
}

function _onDragOver(e) {
  if (_dragId == null) return;
  const hit = _dropTargetParent(e.target);
  if (!hit || !_dragCanDrop(_dragId, hit.parent)) {
    _clearDropHighlight();
    clearTimeout(_dragExpandTimer);
    _dragExpandFolderId = null;
    return;
  }
  e.preventDefault();
  try { e.dataTransfer.dropEffect = 'move'; } catch {}
  if (_dropEl !== hit.el) { _clearDropHighlight(); hit.el.classList.add('drop-target'); _dropEl = hit.el; }

  // Auto-expand a hovered, collapsed picker folder after ~600ms.
  if (hit.el.classList.contains('coll-picker-folder')) {
    const fid = hit.parent;
    if (!_pickerExpanded().has(fid)) {
      if (_dragExpandFolderId !== fid) {
        clearTimeout(_dragExpandTimer);
        _dragExpandFolderId = fid;
        _dragExpandTimer = setTimeout(() => {
          const set = _pickerExpanded(); set.add(fid); _setPickerExpanded(set);
          const list = document.getElementById('collPickerList');
          if (list) list.innerHTML = buildPickerRows();
          _dropEl = null;   // old row detached by the rebuild
        }, 600);
      }
    } else { clearTimeout(_dragExpandTimer); _dragExpandFolderId = null; }
  } else { clearTimeout(_dragExpandTimer); _dragExpandFolderId = null; }
}

function _onDrop(e) {
  if (_dragId == null) return;
  const hit = _dropTargetParent(e.target);
  if (!hit) return;
  e.preventDefault();
  const id = _dragId;
  const dest = hit.parent;
  _clearDragState();
  _applyMove(id, dest);
}

function _onDragEnd() { _clearDragState(); }

let _dndWired = false;
function initCollectionsDnd() {
  if (_dndWired) return;
  _dndWired = true;
  document.addEventListener('dragstart', _onDragStart);
  document.addEventListener('dragover', _onDragOver);
  document.addEventListener('drop', _onDrop);
  document.addEventListener('dragend', _onDragEnd);
}

function addSelectionToCollection(btn) {
  openCollectionPicker([...selectedIds], btn);
}

document.addEventListener('DOMContentLoaded', () => { loadCollections(); initCollectionsDnd(); });
