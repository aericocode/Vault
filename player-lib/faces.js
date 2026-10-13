/* =========================================================================
   FACES - face search in the viewer (FACES_BUILD_SPEC section 8).

   Everything the feature draws lives here, reached from small hooks:
     detail-view.js   renderFacesSection()      the People row (modal + sidebar)
     filters.js       setFocusIds(ids, label, opts)   the person focus banner
     filter-chips.js  facesFindChipHtml()       "Find a person" before More
     selection.js     facesSelectionButton(n)   "Find faces (N)"
     player-video.js  renderFacesFrameButton()  "Find people in this frame"
     settings.js      facesSettingsHtml() / facesWireSettings()  Library block
     importer.js      [data-no-import-drop]     the photo box keeps its drops

   Feature off (or models missing) means none of it renders: every hook
   answers '' and the tile right-click stays the browser's own. The server is
   the source of truth (GET /api/faces/status); this file caches it so the
   hooks can answer synchronously, and re-renders when it changes.
   ========================================================================= */

const FACES_KINDS = ['image', 'gif', 'video'];
const FACES_CHIPS_SHOWN = 8;
const FACES_WIDTHS = [
  { value: 'close', label: 'Close matches' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Cast a wider net' },
];

// Plain words for the server's refusal codes (server/faces-routes.js).
const FACES_MSG = {
  FACES_OFF: 'Face search is turned off.',
  FACE_MODELS_MISSING: 'Face search is not set up yet. Finish it in Settings > Library.',
  MIGRATE_RUNNING: 'A library move is running. Try again when it has finished.',
  QUERY_EXPIRED: 'That search has expired. Try it again.',
  FACE_ENGINE_FAILED: 'Face search could not start. Try again, or download the models again in Settings > Library.',
  // The app's lock screen (vault-ui.js fetch wrapper) answers this one.
  VAULT_LOCKED: '',
  FACE_MODEL_CHANGED: 'This face was found by an older version of face search. Look for faces in the file again.',
  TOO_LARGE: 'That photo is too big. The limit is 25 MB.',
  BAD_IMAGE: 'That file could not be read as a photo.',
  FRAME_FAILED: 'Could not read this frame of the video.',
  FILE_MISSING: 'The file is missing from disk.',
  NOT_ELIGIBLE: 'Only photos, GIFs and videos can be checked for faces.',
  NOT_FOUND: 'That face is no longer there.',
};

let facesStatus = null;          // last GET /api/faces/status
const facesInfo = new Map();     // mediaId -> GET /api/media/:id/faces answer
const facesBusy = new Set();     // mediaIds with a "find faces" running
const facesJustEmpty = new Set();// mediaIds showing "No faces found" for 4 s
const facesExpanded = new Set(); // mediaIds whose "+N more" was opened
let facesConfirm = null;         // { mediaId, groupId } awaiting "Hide this face"

/** On, and able to work: the only state in which anything but Settings shows. */
function facesReady() {
  return !!(facesStatus && facesStatus.enabled && facesStatus.modelsReady);
}

/* ── Server calls ──────────────────────────────────────────────────────── */

/**
 * fetch + JSON with the refusals turned into plain sentences.
 * @returns the parsed answer; throws Error with .code and a toast-ready message
 */
async function facesApi(url, { method = 'GET', json, body, type, background } = {}) {
  const headers = {};
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (type) headers['Content-Type'] = type;
  if (background) headers['X-Vault-Background'] = '1';
  let resp;
  try { resp = await fetch(url, { method, headers, body }); }
  catch { throw Object.assign(new Error('Could not reach Vault. Try again.'), { code: 'NETWORK' }); }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    // The feature changed under us: bring every surface back in line.
    if (data.code === 'FACES_OFF' || data.code === 'FACE_MODELS_MISSING') facesRefreshStatus();
    const msg = resp.status === 423 ? '' : (FACES_MSG[data.code] ?? 'Face search ran into a problem. Try again.');
    throw Object.assign(new Error(msg), { code: data.code, status: resp.status, keys: data.keys });
  }
  return data;
}

/** Toast a failed call, unless there is nothing to say (the vault locked). */
function facesToastError(err) {
  if (err && err.message) showToast(err.message);
}

async function facesRefreshStatus({ background = true } = {}) {
  try {
    const s = await facesApi('/api/faces/status', { background });
    facesSetStatus(s);
    return s;
  } catch { return facesStatus; }
}

function facesSetStatus(s) {
  const was = facesReady();
  const prev = facesStatus;
  facesStatus = s;
  if (prev && prev.download && prev.download.running && s.modelsReady) showToast('Face search is ready.');
  if (was !== facesReady()) facesApplyState();
  facesSettingsPaint();
}

/** Show or remove every face surface after the feature turns on or off. */
function facesApplyState() {
  const on = facesReady();
  if (!on) {
    document.querySelectorAll('.faces-section').forEach(el => el.remove());
    facesCloseMenu();
    facesClosePopover();
    document.getElementById('facesPicker')?.remove();
    if (facesFocus && typeof clearFocusIds === 'function') clearFocusIds();
    facesInfo.clear();
  }
  if (on) facesAddToOpenSurfaces();
  const btn = document.getElementById('facesFrameBtn');
  if (btn) btn.hidden = !on;
  if (typeof renderFilterChipRow === 'function') renderFilterChipRow();
  if (typeof renderSelectionBar === 'function') renderSelectionBar();
}

/* ── People row (detail-view.js) ───────────────────────────────────────── */

/**
 * The section shell. It stays hidden until GET /api/media/:id/faces says
 * there is something to show; a data attribute (not an id) because the
 * library modal and the player sidebar can both be open (see musicBoxes).
 */
function renderFacesSection(media) {
  if (!facesReady() || !media || !FACES_KINDS.includes(media.media_type)) return '';
  // A fresh surface (opened, re-rendered, next file) drops any half-asked hide.
  facesConfirm = null;
  setTimeout(() => facesLoad(media.id), 0);
  return `
    <div class="detail-section faces-section" data-faces-section="${media.id}" hidden>
      <h3>👤 People</h3>
      <div class="field-content" data-faces-box="${media.id}"></div>
    </div>`;
}

/**
 * Turned on while a detail surface is open: slot the People row into it
 * where renderDetailBody would have (after Music, before Games / the rest),
 * without re-rendering the surface and losing a half-typed note.
 */
function facesAddToOpenSurfaces() {
  document.querySelectorAll('#modalBody .detail-body, #mediaSidebarBody .detail-body').forEach(body => {
    const id = Number(body.dataset.mediaId);
    if (!id || body.querySelector('.faces-section')) return;
    const media = (typeof getMediaById === 'function' && getMediaById(id))
      || (currentMediaState?.currentMediaData?.id === id ? currentMediaState.currentMediaData : null);
    const html = media ? renderFacesSection(media) : '';
    if (!html) return;
    const music = body.querySelector('.music-section');
    if (music) { music.insertAdjacentHTML('afterend', html); return; }
    const next = body.querySelector('.games-section, .sidebar-nav-hint')
      || [...body.querySelectorAll('.detail-section')].find(s => /^File Info/.test(s.querySelector('h3')?.textContent || ''));
    if (next) next.insertAdjacentHTML('beforebegin', html);
  });
}

async function facesLoad(mediaId) {
  if (!document.querySelector(`[data-faces-box="${mediaId}"]`)) return;
  if (facesInfo.has(mediaId)) facesPaint(mediaId);   // instant repaint, then refresh
  try {
    facesInfo.set(mediaId, await facesApi(`/api/media/${mediaId}/faces`, { background: true }));
  } catch { if (!facesInfo.has(mediaId)) return; }
  facesPaint(mediaId);
}

/** Fill every open People box for this file from the cached answer. */
function facesPaint(mediaId) {
  const html = facesBoxHtml(mediaId, facesInfo.get(mediaId));
  document.querySelectorAll(`[data-faces-box="${mediaId}"]`).forEach(box => {
    box.innerHTML = html;
    box.closest('.faces-section').hidden = !html;
  });
}

function facesTip(g) {
  if (g.firstTimeS == null) return '';     // photos: nothing worth saying
  const n = g.appearances || 1;
  return `Seen in ${n} spot${n === 1 ? '' : 's'}, first at ${formatDuration(g.firstTimeS) || '0:00'}`;
}

function facesBoxHtml(mediaId, info) {
  if (facesBusy.has(mediaId)) {
    return '<span class="faces-busy"><span class="faces-spinner" aria-hidden="true"></span>Looking for faces…</span>';
  }
  if (!info || !info.eligible) return '';
  if (!info.indexed) {
    if (info.error) {
      return `<span class="faces-hint">Could not check this file for faces.</span>
        <button type="button" class="settings-link faces-retry" data-faces-find="${mediaId}">Try again</button>`;
    }
    return `<button type="button" class="faces-find-btn" data-faces-find="${mediaId}">Find faces in this file</button>`;
  }
  const groups = info.groups || [];
  if (!groups.length) return facesJustEmpty.has(mediaId) ? '<span class="faces-hint">No faces found</span>' : '';

  const all = facesExpanded.has(mediaId) || groups.length <= FACES_CHIPS_SHOWN + 1;
  const shown = all ? groups : groups.slice(0, FACES_CHIPS_SHOWN);
  const pending = facesConfirm && facesConfirm.mediaId === mediaId ? facesConfirm.groupId : null;
  const chips = shown.map(g => {
    const tip = facesTip(g);
    return `<button type="button" class="face-chip${g.id === pending ? ' is-pending' : ''}" data-face-group="${g.id}"
        data-face-media="${mediaId}" aria-label="Find this person"${tip ? ` title="${escapeHtml(tip)}"` : ''}>${g.cropUrl
        ? `<img class="face-crop" src="${escapeHtml(g.cropUrl)}" alt="" loading="lazy">`
        : '<span class="face-chip-blank" aria-hidden="true">👤</span>'}</button>`;
  }).join('');
  const more = all ? '' : `<button type="button" class="face-more" data-faces-more="${mediaId}">+${groups.length - shown.length} more</button>`;
  const confirm = pending == null ? '' : `
    <div class="faces-confirm">Hide this face from search?
      <button type="button" class="faces-confirm-btn is-danger" data-faces-hide="${pending}" data-face-media="${mediaId}">Hide</button>
      <button type="button" class="faces-confirm-btn" data-faces-hide-cancel data-face-media="${mediaId}">Cancel</button>
    </div>`;
  return `<div class="face-chips">${chips}${more}</div>${confirm}`;
}

/**
 * Check one file now (the People button, the tile menu). It jumps the queue
 * and the server answers when it is done, which is seconds for most files.
 */
async function facesFindNow(mediaId, { force = false, toast = false } = {}) {
  if (facesBusy.has(mediaId)) return;
  facesBusy.add(mediaId);
  facesPaint(mediaId);
  if (toast) showToast('Looking for faces in this file.');
  let info;
  try {
    info = await facesApi(`/api/media/${mediaId}/find-faces`, { method: 'POST', json: { force } });
  } catch (err) {
    facesBusy.delete(mediaId);
    facesPaint(mediaId);
    facesToastError(err);
    return;
  }
  facesBusy.delete(mediaId);
  facesInfo.set(mediaId, info);
  const n = (info.groups || []).length;
  if (info.indexed && !n) {
    facesJustEmpty.add(mediaId);
    setTimeout(() => { facesJustEmpty.delete(mediaId); facesPaint(mediaId); }, 4000);
  }
  facesPaint(mediaId);
  if (toast) {
    showToast(!info.indexed ? 'Could not check this file for faces.'
      : n ? `Found ${n} ${n === 1 ? 'person' : 'people'} in this file.` : 'No faces found in this file.');
  }
}

async function facesHide(mediaId, groupId) {
  facesConfirm = null;
  try {
    await facesApi(`/api/faces/groups/${groupId}/hide`, { method: 'POST' });
  } catch (err) { facesToastError(err); facesPaint(mediaId); return; }
  const info = facesInfo.get(mediaId);
  if (info) info.groups = (info.groups || []).filter(g => g.id !== groupId);
  facesPaint(mediaId);
}

/** A chip was chosen: person focus, then get the surface out of the way. */
async function facesChipFocus(chip) {
  const inPlayer = !!chip.closest('#mediaSidebarBody');
  const img = chip.querySelector('img');
  const ok = await facesOpenFocus({ kind: 'group', id: Number(chip.dataset.faceGroup), mediaId: Number(chip.dataset.faceMedia) },
    img ? img.getAttribute('src') : '');
  if (!ok) return;
  if (inPlayer) { if (typeof minimizePlayer === 'function') minimizePlayer(); }
  else if (typeof closeModal === 'function') closeModal();
}

/* ── Person focus (filters.js focus set) ───────────────────────────────── */

let facesFocus = null;   // { src: {kind, id}, cropUrl, width, count, total, capped, opts }
let facesFocusSeq = 0;

/**
 * Search for one face (a stored group or a query face from a photo/frame)
 * and show the matches, best first. Called again with a new width, it
 * updates the same banner in place.
 * @returns {Promise<boolean>} whether the focus is showing
 */
async function facesOpenFocus(src, cropUrl, width = 'normal') {
  const seq = ++facesFocusSeq;
  const url = src.kind === 'group' ? `/api/faces/groups/${src.id}/similar` : `/api/faces/query/${encodeURIComponent(src.id)}/similar`;
  let r;
  try {
    r = await facesApi(url, { method: 'POST', json: { width } });
  } catch (err) {
    if (seq === facesFocusSeq) {
      facesToastError(err);
      if (facesFocus) { facesFocus.wanted = facesFocus.width; renderFocusBar(); }
    }
    return false;
  }
  if (seq !== facesFocusSeq) return false;   // a newer request (another width) wins
  const same = facesFocus && facesFocus.src.kind === src.kind && facesFocus.src.id === src.id;
  const opts = same ? facesFocus.opts : {
    renderBanner: facesRenderBanner,
    // Exited, or replaced by another focus: forget this one.
    onClear: () => { if (facesFocus && facesFocus.opts === opts) facesFocus = null; },
  };
  opts.rankedScores = r.ids.map((id, i) => ({ id, score: r.scores[i] }));
  // A chip's own file always matches itself; it stays in the grid but does
  // not count as "another file that looks like this person".
  const others = src.mediaId ? r.ids.filter(id => id !== src.mediaId).length : r.ids.length;
  facesFocus = { src, cropUrl, width, wanted: width, count: r.ids.length, others, total: r.total, capped: !!r.capped, opts };
  setFocusIds(r.ids, 'files that look like this person', opts);
  return true;
}

function facesRenderBanner(bar) {
  const f = facesFocus;
  if (!f) return;
  const n = f.count;
  const text = !f.others ? 'No other files look like this person at this setting.'
    : f.capped ? `Showing the closest <b>${n.toLocaleString()}</b> of ${Number(f.total).toLocaleString()} files that look like this person.`
    : `Showing <b>${n.toLocaleString()}</b> ${n === 1 ? 'file that looks' : 'files that look'} like this person.`;
  bar.innerHTML = `
    ${f.cropUrl ? `<span class="faces-banner-crop"><img class="face-crop" src="${escapeHtml(f.cropUrl)}" alt=""></span>` : ''}
    <span class="focus-banner-text">${text}</span>
    <span class="settings-seg faces-width" role="group" aria-label="How close a match">
      ${FACES_WIDTHS.map(w => `<button type="button" class="settings-seg-btn" data-faces-width="${w.value}"
        aria-pressed="${w.value === f.wanted ? 'true' : 'false'}">${w.label}</button>`).join('')}
    </span>
    <button class="focus-banner-close" id="focusBarClear">Show everything</button>`;
  bar.querySelector('#focusBarClear').addEventListener('click', clearFocusIds);
  bar.querySelectorAll('[data-faces-width]').forEach(b => b.addEventListener('click', async () => {
    const w = b.dataset.facesWidth;
    // Compare with the last width ASKED for: quick clicks must end on the last one.
    if (!facesFocus || w === facesFocus.wanted) return;
    facesFocus.wanted = w;
    bar.querySelectorAll('[data-faces-width]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (w === facesFocus.width) {
      facesFocusSeq++;            // back to what is showing: drop the request in flight
      return;
    }
    await facesOpenFocus(facesFocus.src, facesFocus.cropUrl, w);
    bar.querySelector(`[data-faces-width="${facesFocus?.wanted}"]`)?.focus();
  }));
}

/* ── Small menu (chip right-click, tile right-click) ───────────────────── */

function facesMenu(x, y, items) {
  facesCloseMenu();
  if (typeof hideTilePopover === 'function') hideTilePopover();   // it would sit on top
  const menu = document.createElement('div');
  menu.className = 'fpop faces-menu';
  menu.id = 'facesMenu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = items.map((it, i) =>
    `<button type="button" class="fpop-opt faces-menu-item" role="menuitem" data-i="${i}">${escapeHtml(it.label)}</button>`).join('');
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    facesCloseMenu();
    items[Number(b.dataset.i)].run();
  });
  menu.querySelector('button')?.focus();
}

function facesCloseMenu() { document.getElementById('facesMenu')?.remove(); }

/* ── Tile right-click + selection bar ──────────────────────────────────── */

/** "Faces (N)" in the selection bar (short, so the bar stays one line); '' while off. */
function facesSelectionButton(n) {
  if (!facesReady() || !n) return '';
  return `<button class="sel-btn sel-faces" onclick="facesIndexSelection()"
    title="Find faces in the selected files">👤 Faces (${n})</button>`;
}

let facesWatchTimer = null;

/** Queue the selection; one toast when it is done (spec 8.8). */
async function facesIndexSelection() {
  const ids = [...selectedIds];
  const chunk = typeof BULK_ID_CHUNK === 'number' ? BULK_ID_CHUNK : 5000;
  let added = 0;
  try {
    for (let i = 0; i < ids.length; i += chunk) {
      const r = await facesApi('/api/faces/index', { method: 'POST', json: { ids: ids.slice(i, i + chunk) } });
      added += r.added || 0;
    }
  } catch (err) { facesToastError(err); return; }
  if (!added) { showToast('These files have already been checked for faces.'); return; }
  showToast(`Looking for faces in ${added} file${added === 1 ? '' : 's'}. Progress is in Settings > Library.`);
  facesWatchQueue();
}

/** Background watch for a user-started job: one "finished" toast. */
function facesWatchQueue() {
  if (facesWatchTimer) return;
  const tick = async () => {
    const s = await facesRefreshStatus();
    if (s && s.queue && s.queue.running) { facesWatchTimer = setTimeout(tick, 3000); return; }
    facesWatchTimer = null;
    const last = s && s.queue && s.queue.lastRun;
    if (last && last.total) showToast(`Finished looking for faces in ${last.total} file${last.total === 1 ? '' : 's'}.`);
    facesReloadOpenBoxes();
  };
  facesWatchTimer = setTimeout(tick, 3000);
}

/** Refresh every People row on screen (after a queue run or delete-all). */
function facesReloadOpenBoxes() {
  const ids = new Set([...document.querySelectorAll('[data-faces-box]')].map(b => Number(b.dataset.facesBox)));
  ids.forEach(id => { facesInfo.delete(id); facesLoad(id); });
}

async function facesTileMenu(e, tile) {
  const id = Number(tile.dataset.id);
  if (typeof selectedIds !== 'undefined' && selectedIds.has(id) && selectedIds.size > 1) {
    const n = selectionCounts().faceable;
    if (!n) return;                       // nothing face search can check: native menu
    e.preventDefault();
    facesMenu(e.clientX, e.clientY, [{
      label: `Find faces in ${n} selected file${n === 1 ? '' : 's'}`, run: facesIndexSelection,
    }]);
    return;
  }
  const m = typeof getMediaById === 'function' ? getMediaById(id) : null;
  if (!m || !FACES_KINDS.includes(m.media_type)) return;
  e.preventDefault();
  const { clientX: x, clientY: y } = e;
  let info = facesInfo.get(id);
  if (!info) {
    try { info = await facesApi(`/api/media/${id}/faces`, { background: true }); facesInfo.set(id, info); }
    catch { info = null; }
  }
  const again = !!(info && info.indexed);
  facesMenu(x, y, [{
    label: again ? 'Look for faces again' : 'Find faces in this file',
    run: () => facesFindNow(id, { force: again, toast: true }),
  }]);
}

/* ── Find a person (search by photo) ───────────────────────────────────── */

/** The filter-row button; '' while the feature is off (also read by fchipFitRow). */
function facesFindChipHtml() {
  if (!facesReady()) return '';
  // fchipFitRow swaps in the icon alone when the row is short of room.
  return `<button type="button" class="fchip fchip-more faces-find-chip" id="findPersonChip"
    aria-haspopup="dialog" aria-expanded="false" aria-label="Find a person" data-tip="Find a person"
    data-full="👤 Find a person" data-compact="👤">👤 Find a person</button>`;
}

/** The same button inside the More sheet, shown only while the row has folded it away. */
function facesSheetHtml() {
  if (!facesReady()) return '';
  return `<div class="faces-sheet-row"><button type="button" class="fchip fchip-more faces-sheet-find"
    aria-haspopup="dialog">👤 Find a person</button></div>`;
}

function facesOpenPopover(anchor) {
  facesClosePopover();
  const pop = document.createElement('div');
  pop.className = 'fpop faces-pop';
  pop.id = 'facesPop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Find a person');
  pop.innerHTML = `
    <div class="fpop-title">Find a person</div>
    <label class="faces-drop" id="facesDrop" data-no-import-drop tabindex="0">
      <span class="faces-drop-text">Drop a photo here, or <u>choose one</u></span>
      <input type="file" accept="image/*" hidden>
    </label>
    <div class="faces-pop-status" id="facesPopStatus" aria-live="polite"></div>
    <p class="faces-pop-note">You can also paste a photo with Ctrl+V.</p>
    <p class="faces-pop-note">The photo is only used for this search and is not kept.</p>`;
  document.body.appendChild(pop);
  const a = anchor.getBoundingClientRect();
  const w = pop.getBoundingClientRect().width;
  pop.style.left = `${Math.max(8, Math.min(a.left, innerWidth - w - 8))}px`;
  pop.style.top = `${a.bottom + 6}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const drop = pop.querySelector('#facesDrop');
  const input = drop.querySelector('input');
  input.addEventListener('change', () => { if (input.files[0]) facesSearchPhoto(input.files[0]); input.value = ''; });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  // The importer listens on document; [data-no-import-drop] makes it stand
  // down, and these handlers take the file instead.
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    const f = [...(e.dataTransfer.files || [])][0];
    if (f) facesSearchPhoto(f);
  });
  drop.focus();
}

function facesClosePopover() {
  const pop = document.getElementById('facesPop');
  if (!pop) return;
  pop.remove();
  document.getElementById('findPersonChip')?.setAttribute('aria-expanded', 'false');
}

function facesPopStatus(text) {
  const el = document.getElementById('facesPopStatus');
  if (el) el.textContent = text;
}

async function facesSearchPhoto(file) {
  if (!/^image\//.test(file.type || '')) { facesPopStatus('That file is not a photo.'); return; }
  facesPopStatus('Looking for faces…');
  let r;
  try {
    r = await facesApi('/api/faces/search-image', { method: 'POST', body: file, type: file.type });
  } catch (err) { facesPopStatus(err.message); return; }
  if (!r.faces.length) { facesPopStatus('No face found in that photo.'); return; }
  facesPopStatus('');
  facesClosePopover();
  facesPickAndFocus(r.faces);
}

/**
 * The 0 / 1 / 2+ step shared by photo and frame search: one face searches
 * at once, several ask "Which person?" first.
 * @returns {Promise<boolean>} whether a focus opened
 */
function facesPickAndFocus(faces) {
  if (faces.length === 1) return facesOpenFocus({ kind: 'query', id: faces[0].queryId }, faces[0].cropUrl);
  return new Promise((resolve) => {
    document.getElementById('facesPicker')?.remove();
    const ov = document.createElement('div');
    ov.id = 'facesPicker';
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = `
      <div class="vault-modal faces-picker" role="dialog" aria-label="Which person?">
        <h3>Which person?</h3>
        <div class="face-chips faces-picker-chips">
          ${faces.map((f, i) => `<button type="button" class="face-chip face-chip-lg" data-pick="${i}" aria-label="Person ${i + 1}">
            <img class="face-crop" src="${escapeHtml(f.cropUrl)}" alt=""></button>`).join('')}
        </div>
        <div class="vault-modal-actions"><button class="vault-btn" data-pick-cancel>Cancel</button></div>
      </div>`;
    document.body.appendChild(ov);
    const done = (v) => { ov.remove(); resolve(v); };
    ov._close = () => done(false);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(false); });
    ov.querySelector('[data-pick-cancel]').addEventListener('click', () => done(false));
    ov.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', async () => {
      const f = faces[Number(b.dataset.pick)];
      ov.remove();
      resolve(await facesOpenFocus({ kind: 'query', id: f.queryId }, f.cropUrl));
    }));
    ov.querySelector('[data-pick]')?.focus();
  });
}

/* ── Player: find people in this frame ─────────────────────────────────── */

let facesPlayerPath = null;   // the file the video player was built for

/** Called from renderVideoPlayer with the file it is about to play. */
function renderFacesFrameButton(filepath) {
  facesPlayerPath = filepath || null;
  return `<button onclick="facesFindInFrame()" class="control-btn faces-frame-btn" id="facesFrameBtn"
    title="Find people in this frame"${facesReady() ? '' : ' hidden'}>👤</button>`;
}

async function facesFindInFrame() {
  const el = currentMediaState && currentMediaState.element;
  if (!el) return;
  el.pause();
  // currentMediaData is null when the file is not in the current results
  // (opened from elsewhere); the row cache still knows it by path.
  const media = currentMediaState.currentMediaData
    || (facesPlayerPath && typeof Library !== 'undefined' ? Library.rowByPath(facesPlayerPath) : null);
  if (!media || !media.id) { showToast('Could not tell which video is playing.'); return; }
  const btn = document.getElementById('facesFrameBtn');
  if (btn) btn.disabled = true;
  let r;
  try {
    r = await facesApi('/api/faces/search-image', { method: 'POST', json: { mediaId: media.id, timeS: el.currentTime || 0 } });
  } catch (err) { facesToastError(err); return; }
  finally { if (btn) btn.disabled = false; }
  if (!r.faces.length) { showToast('No face found in this frame.'); return; }
  // Results show in the grid, so the player steps aside for them.
  if (await facesPickAndFocus(r.faces) && typeof minimizePlayer === 'function') minimizePlayer();
}

/* ── Settings > Library > Face search ──────────────────────────────────── */

// Same markup as settings.js toggleRow / segRow, with this block's own
// data attributes so the Settings tab's generic wiring never picks them up.
function facesToggleRow(key, title, desc) {
  return `
    <label class="settings-toggle">
      <span class="settings-toggle-text">
        <span class="settings-toggle-title">${title}</span>
        <span class="settings-toggle-desc">${desc}</span>
      </span>
      <input type="checkbox" data-faces-setting="${key}">
      <span class="settings-switch" aria-hidden="true"></span>
    </label>`;
}

function facesSettingsHtml() {
  return `
    <h3 class="settings-h settings-h-mt">Face search</h3>
    <div class="faces-settings" id="facesSettings">
      ${facesToggleRow('enabled', 'Face search',
        'Click a face in a file\'s info to see every file that person is in, or search with a photo.')}
      <p class="settings-note faces-privacy">Face search runs entirely on this computer. Nothing is
      uploaded. Faces are stored in your library and can be deleted here at any time.</p>

      <div class="mig-card" id="facesSetup" hidden>
        <p class="settings-note faces-card-note" id="facesSetupText"></p>
        <div class="mig-progress" id="facesDlBar" hidden>
          <div class="mig-bar"><div class="mig-bar-fill"></div></div>
          <div class="mig-bar-stats"></div>
        </div>
        <div class="mig-actions"><button class="settings-btn" id="facesDlBtn" type="button">Download the models</button></div>
      </div>

      <div id="facesOnRows" hidden>
        <div class="mig-card">
          <div class="faces-status-line" id="facesStatusLine"></div>
          <div class="mig-progress" id="facesQueueBar" hidden>
            <div class="mig-bar"><div class="mig-bar-fill"></div></div>
            <div class="mig-bar-stats"></div>
          </div>
          <div class="mig-actions">
            <button class="settings-btn" id="facesAllBtn" type="button" hidden></button>
            <button class="settings-btn mig-apply" id="facesPauseBtn" type="button" hidden>Pause</button>
            <button class="settings-btn mig-apply" id="facesStopBtn" type="button" hidden>Stop</button>
            <span class="mig-status" id="facesQueueText"></span>
          </div>
        </div>
        ${facesToggleRow('autoIndex', 'Find faces in new imports automatically',
          'New photos and videos are checked for faces after they are added.')}
        <div class="settings-toggle settings-seg-row">
          <span class="settings-toggle-text">
            <span class="settings-toggle-title" id="facesIntervalLabel">How closely to check videos</span>
            <span class="settings-toggle-desc">Closer checks find more faces but take longer. Applies to files checked from now on.</span>
          </span>
          <span class="settings-seg" role="group" aria-labelledby="facesIntervalLabel">
            ${[2, 3.5, 10].map(v => `<button type="button" class="settings-seg-btn" data-faces-interval="${v}"
              aria-pressed="false">Every ${v} seconds</button>`).join('')}
          </span>
        </div>
      </div>
      <!-- Outside facesOnRows: the privacy line promises deletion at any
           time, so this shows whenever face data exists, on or off. -->
      <div class="mig-actions faces-delete-row" id="facesDeleteRow" hidden>
        <button class="settings-btn mig-apply faces-danger" id="facesDeleteBtn" type="button">Delete all face data</button>
      </div>
    </div>`;
}

let facesPollTimer = null;
let facesDeleteArm = null;

// Decimal megabytes, whole numbers, the same unit as "about 39 MB".
const facesMB = (b) => Math.round(Number(b || 0) / 1e6).toLocaleString();
// "photos and videos", or the singular for exactly one.
const facesPV = (n) => (n === 1 ? 'photo or video' : 'photos and videos');

/** Paint the block from facesStatus. Cheap; called after every poll. */
function facesSettingsPaint() {
  const root = document.getElementById('facesSettings');
  const s = facesStatus;
  if (!root || !s) return;
  const $ = (id) => document.getElementById(id);
  const toggle = root.querySelector('[data-faces-setting="enabled"]');
  if (toggle && !toggle.dataset.busy) toggle.checked = !!s.enabled;

  // Turned on, models not here yet: the download card.
  const dl = s.download;
  const c = s.counts || {};
  const setup = s.enabled && !s.modelsReady;
  $('facesSetup').hidden = !setup;
  if (setup) {
    const running = !!(dl && dl.running);
    const damaged = Object.values(s.missingReasons || {}).includes('corrupt');
    $('facesSetupText').textContent = running
      ? 'Downloading the face search models from huggingface.co.'
      : dl && dl.error ? 'The download did not finish. Check your connection and try again.'
      : damaged ? 'A face search model is damaged. Download it again to fix it.'
      : 'Face search needs two small models (about 39 MB) before it can work.';
    $('facesDlBar').hidden = !running;
    if (running) {
      $('facesDlBar').querySelector('.mig-bar-fill').style.width = dl.total ? `${Math.min(100, (dl.received / dl.total) * 100).toFixed(1)}%` : '0%';
      $('facesDlBar').querySelector('.mig-bar-stats').textContent = `${facesMB(dl.received)} of ${facesMB(dl.total)} MB`;
    }
    $('facesDlBtn').hidden = running;
    $('facesDlBtn').textContent = dl && dl.error ? 'Try again' : damaged ? 'Download again' : 'Download the models';
  }

  // Face data can outlive the switch; deleting it must always be possible.
  $('facesDeleteRow').hidden = !(c.indexed || c.people || c.withFaces);

  const on = s.enabled && s.modelsReady;
  $('facesOnRows').hidden = !on;
  if (!on) return;
  const q = s.queue || {};
  $('facesStatusLine').textContent = !c.eligible ? 'There are no photos or videos to check yet.'
    : !c.indexed ? (c.eligible === 1 ? 'Your 1 photo or video has not been checked yet.'
      : `None of your ${c.eligible.toLocaleString()} photos and videos have been checked yet.`)
    : `Checked ${c.indexed.toLocaleString()} of ${c.eligible.toLocaleString()} ${facesPV(c.eligible)}. Found people in ${c.withFaces.toLocaleString()}.`;
  const all = $('facesAllBtn');
  all.hidden = !!q.running || !c.eligible || c.indexed >= c.eligible;
  all.textContent = c.indexed ? 'Find faces in the rest' : 'Find faces in everything';

  $('facesQueueBar').hidden = !q.running;
  $('facesPauseBtn').hidden = !q.running;
  $('facesStopBtn').hidden = !q.running;
  const text = $('facesQueueText');
  if (q.running) {
    const finished = (q.done || 0) + (q.failed || 0);
    $('facesQueueBar').querySelector('.mig-bar-fill').style.width = q.total ? `${((finished / q.total) * 100).toFixed(1)}%` : '0%';
    $('facesQueueBar').querySelector('.mig-bar-stats').textContent =
      `${finished.toLocaleString()} of ${(q.total || 0).toLocaleString()}${q.failed ? `, ${q.failed} could not be checked` : ''}`;
    $('facesPauseBtn').textContent = q.paused ? 'Resume' : 'Pause';
    const cur = (q.current || [])[0];
    text.innerHTML = q.paused ? 'Paused.'
      : cur ? `Checking <span class="faces-qname">${escapeHtml(cur.filename || '')}</span>` : 'Starting…';
  } else {
    text.textContent = '';
  }
  root.querySelector('[data-faces-setting="autoIndex"]').checked = !!s.autoIndex;
  root.querySelectorAll('[data-faces-interval]').forEach(b =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.facesInterval) === s.intervalS)));
}

/** Poll every 1.5 s while the block is on screen and something is moving. */
function facesSettingsPoll() {
  clearTimeout(facesPollTimer);
  facesPollTimer = setTimeout(async () => {
    facesPollTimer = null;
    if (!document.getElementById('facesSettings')?.offsetParent) return;   // closed or another tab
    const wasRunning = facesStatus?.queue?.running;
    const s = await facesRefreshStatus();
    if (wasRunning && !s?.queue?.running) facesReloadOpenBoxes();
    if (s && ((s.queue && s.queue.running) || (s.download && s.download.running))) facesSettingsPoll();
  }, 1500);
}

async function facesSettingsPost(patch) {
  try {
    facesSetStatus(await facesApi('/api/faces/settings', { method: 'POST', json: patch }));
    return true;
  } catch (err) { facesToastError(err); facesSettingsPaint(); return false; }
}

/** Download the models; asks first when the two keys are not approved yet. */
async function facesStartDownload() {
  try {
    facesSetStatus(await facesApi('/api/faces/models/download', { method: 'POST' }));
    facesSettingsPoll();
    return true;
  } catch (err) {
    if (err.code === 'CONSENT_NEEDED') return facesAskConsent();
    if (err.code) facesToastError(err); else showToast('Could not start the download. Try again.');
    return false;
  }
}

/** Consent modal, in the style of subtitlesShowModelConsent. Resolves true once approved and started. */
function facesAskConsent() {
  return new Promise((resolve) => {
    document.getElementById('facesConsent')?.remove();
    const ov = document.createElement('div');
    ov.id = 'facesConsent';
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = `
      <div class="vault-modal" role="dialog" aria-label="Download the face search models">
        <h3>⬇ Download the face search models?</h3>
        <p class="vault-modal-hint">Face search needs two small models (about 39 MB) from
          <b>huggingface.co</b>. They run on this computer only.</p>
        <p class="vault-modal-hint">Your photos and videos are never uploaded. If you say no,
          nothing is downloaded, and face search cannot be used until the models are here.</p>
        <div class="vault-modal-actions">
          <button class="vault-btn" data-consent="no">Not now</button>
          <button class="vault-btn vault-btn-primary" data-consent="yes">Download them</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const answer = async (yes) => {
      ov.remove();
      if (!yes) { resolve(false); return; }
      try {
        for (const key of ['face:detect', 'face:embed']) {
          const r = await fetch('/api/settings/model-downloads', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, allow: true }),
          });
          if (!r.ok) throw new Error('Downloads are turned off for this copy of Vault.');
        }
      } catch (err) { facesToastError(err); resolve(false); return; }
      resolve(await facesStartDownload());
    };
    ov._close = () => answer(false);
    ov.querySelector('[data-consent="yes"]').addEventListener('click', () => answer(true));
    ov.querySelector('[data-consent="no"]').addEventListener('click', () => answer(false));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) answer(false); });
    ov.querySelector('[data-consent="yes"]').focus();
  });
}

async function facesToggleEnabled(cb) {
  if (!cb.checked) { await facesSettingsPost({ enabled: false }); return; }
  if (facesStatus && facesStatus.modelsReady) { await facesSettingsPost({ enabled: true }); return; }
  // Models missing: the switch stays off until the user agrees to the download.
  cb.checked = false;
  cb.dataset.busy = '1';
  let started = false;
  try {
    const md = await fetch('/api/settings/model-downloads').then(r => r.json()).catch(() => ({}));
    const ok = md.consents && md.consents['face:detect'] === true && md.consents['face:embed'] === true;
    started = ok ? await facesStartDownload() : await facesAskConsent();
  } finally { delete cb.dataset.busy; }
  if (started) await facesSettingsPost({ enabled: true });
  else facesSettingsPaint();
}

function facesDisarmDelete() {
  clearTimeout(facesDeleteArm);
  facesDeleteArm = null;
  const b = document.getElementById('facesDeleteBtn');
  if (b) { b.classList.remove('armed'); b.textContent = 'Delete all face data'; }
}

async function facesDeleteAll(btn) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to delete all face data';
    btn.dataset.armedAt = String(Date.now());
    facesDeleteArm = setTimeout(facesDisarmDelete, 4000);
    return;
  }
  // A double-click is one decision, not two: the second click must come later.
  if (Date.now() - Number(btn.dataset.armedAt || 0) < 400) return;
  facesDisarmDelete();
  btn.disabled = true;
  try { await facesApi('/api/faces/delete-all', { method: 'POST' }); }
  catch (err) { facesToastError(err); btn.disabled = false; return; }
  btn.disabled = false;
  showToast('All face data was deleted.');
  if (facesFocus) clearFocusIds();
  facesInfo.clear();
  await facesRefreshStatus({ background: false });
  facesReloadOpenBoxes();
}

/** Called by settings.js wireLibrarySection after every render of the tab. */
function facesWireSettings() {
  const root = document.getElementById('facesSettings');
  if (!root) return;
  root.querySelector('[data-faces-setting="enabled"]').addEventListener('change', (e) => facesToggleEnabled(e.target));
  root.querySelector('[data-faces-setting="autoIndex"]').addEventListener('change', (e) => facesSettingsPost({ autoIndex: e.target.checked }));
  root.querySelectorAll('[data-faces-interval]').forEach(b =>
    b.addEventListener('click', () => facesSettingsPost({ intervalS: Number(b.dataset.facesInterval) })));
  root.querySelector('#facesDlBtn').addEventListener('click', () => facesStartDownload());
  root.querySelector('#facesAllBtn').addEventListener('click', async () => {
    try { facesSetStatus({ ...facesStatus, queue: await facesApi('/api/faces/index', { method: 'POST', json: { all: true } }) }); }
    catch (err) { facesToastError(err); return; }
    facesSettingsPoll();
  });
  root.querySelector('#facesPauseBtn').addEventListener('click', async () => {
    const act = facesStatus?.queue?.paused ? 'resume' : 'pause';
    try { facesSetStatus({ ...facesStatus, queue: await facesApi(`/api/faces/queue/${act}`, { method: 'POST' }) }); }
    catch (err) { facesToastError(err); }
    facesSettingsPoll();
  });
  root.querySelector('#facesStopBtn').addEventListener('click', async () => {
    try { facesSetStatus({ ...facesStatus, queue: await facesApi('/api/faces/queue/cancel', { method: 'POST' }) }); }
    catch (err) { facesToastError(err); }
    facesRefreshStatus();
  });
  root.querySelector('#facesDeleteBtn').addEventListener('click', (e) => facesDeleteAll(e.currentTarget));
  facesSettingsPaint();
  facesRefreshStatus({ background: false }).then(facesSettingsPoll);
}

/* ── Delegated events ──────────────────────────────────────────────────── */

// Capture phase: the detail modal stops click propagation at its content box.
document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (!t.closest('#facesMenu')) facesCloseMenu();
  if (!t.closest('#facesPop, #findPersonChip')) facesClosePopover();

  const findChip = t.closest('#findPersonChip, .faces-sheet-find');
  if (findChip) { if (document.getElementById('facesPop')) facesClosePopover(); else facesOpenPopover(findChip); return; }
  const chip = t.closest('.face-chip[data-face-group]');
  if (chip) { facesChipFocus(chip); return; }
  const find = t.closest('[data-faces-find]');
  if (find) { facesFindNow(Number(find.dataset.facesFind)); return; }
  const more = t.closest('[data-faces-more]');
  if (more) {
    const id = Number(more.dataset.facesMore);
    const box = more.closest('[data-faces-box]');
    facesExpanded.add(id);
    facesPaint(id);
    // Keyboard users land on the first chip that just appeared.
    box?.querySelectorAll('.face-chip')[FACES_CHIPS_SHOWN]?.focus();
    return;
  }
  // The confirm line carries its own file and face, so a line left on
  // another open surface still acts on what it shows.
  const hide = t.closest('[data-faces-hide]');
  if (hide) { facesHide(Number(hide.dataset.faceMedia), Number(hide.dataset.facesHide)); return; }
  const cancel = t.closest('[data-faces-hide-cancel]');
  if (cancel) { facesConfirm = null; facesPaint(Number(cancel.dataset.faceMedia)); }
}, true);

// Right-click: a face chip gets its menu; a tile gets "Find faces" only
// while the feature is on, otherwise the browser's own menu is untouched.
document.addEventListener('contextmenu', (e) => {
  if (!facesReady() || !(e.target instanceof Element)) return;
  const chip = e.target.closest('.face-chip[data-face-group]');
  if (chip) {
    e.preventDefault();
    const mediaId = Number(chip.dataset.faceMedia);
    const groupId = Number(chip.dataset.faceGroup);
    facesMenu(e.clientX, e.clientY, [
      { label: 'Find this person', run: () => facesChipFocus(chip) },
      { label: 'Hide this face', run: () => { facesConfirm = { mediaId, groupId }; facesPaint(mediaId); } },
    ]);
    return;
  }
  const tile = e.target.closest('.media-tile[data-id]:not(.tile-skel)');
  if (tile) facesTileMenu(e, tile);
});

// Esc closes the topmost face surface first, before the app's own Escape
// handling (the player, the detail modal) sees it.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('facesConsent') || document.getElementById('facesPicker');
  if (modal) modal._close();
  else if (document.getElementById('facesMenu')) facesCloseMenu();
  else if (document.getElementById('facesPop')) {
    facesClosePopover();
    document.getElementById('findPersonChip')?.focus();
  } else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// Ctrl+V of an image while the Find a person box is open.
document.addEventListener('paste', (e) => {
  if (!document.getElementById('facesPop')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && /^image\//.test(i.type));
  const file = item && item.getAsFile();
  if (!file) return;
  e.preventDefault();
  facesSearchPhoto(file);
});

window.addEventListener('resize', () => { facesCloseMenu(); facesClosePopover(); });

// Boot: learn whether the feature is on. A locked vault answers 423 and the
// feature simply stays dark until the unlock reloads the page.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => facesRefreshStatus());
else facesRefreshStatus();
