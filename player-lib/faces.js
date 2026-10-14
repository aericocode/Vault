/* =========================================================================
   FACES - face search in the viewer (FACES_BUILD_SPEC section 8).

   Everything the feature draws lives here, reached from small hooks:
     detail-view.js   renderFacesSection()      the People row (modal + sidebar)
     filters.js       setFocusIds(ids, label, opts)   the person focus banner
     filter-chips.js  facesFindChipHtml()       "Find a person" before More
     selection.js     facesSelectionButton(n)   "Find faces (N)"
     player-video.js  renderFacesFrameButton()  "Find people in this frame"
     settings.js      facesSettingsHtml() / facesWireSettings()  Face search section
     importer.js      [data-no-import-drop]     the photo box keeps its drops;
                      window.vaultScanPane      the Faces view of the scan panel
     faces-tab.js     the 👤 Faces tab (people); facesTabStatusChanged, facesOpenPerson

   Feature off (or models missing) means none of it renders: every hook
   answers '' and the tile right-click stays the browser's own. The server is
   the source of truth (GET /api/faces/status); this file caches it so the
   hooks can answer synchronously, and re-renders when it changes.
   ========================================================================= */

const FACES_KINDS = ['image', 'gif', 'video'];
const FACES_CHIPS_SHOWN = 8;
const FACES_INTERVALS = [2, 3.5, 10];        // the quick picks; "Custom" takes 0.5 to 120
const FACES_MAX_FRAMES_DEFAULT = 2000;
const FACES_WIDTHS = [
  { value: 'close', label: 'Close matches' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Cast a wider net' },
];

// The face models a user picks between (settings facesModel, FACE_MODELS_SPEC).
// Sizes are the download in decimal MB; the two grunt models (YuNet, SFace)
// add FACES_GRUNT_MB on the first setup.
const FACES_KEEPERS = {
  ir50: { label: 'Standard', mb: 174, recommended: true,
    desc: 'Recognises people well, including blurry and small faces in videos.' },
  ir101: { label: 'Best', mb: 261,
    desc: 'Fewest mix-ups between people. A little slower on photos and uses more memory while checking.' },
};
const FACES_DEFAULT_KEEPER = 'ir50';
const FACES_GRUNT_MB = 39;

// Plain words for the server's refusal codes (server/faces-routes.js).
const FACES_MSG = {
  FACES_OFF: 'Face search is turned off.',
  FACE_MODELS_MISSING: 'Face search is not set up yet. Finish it in Settings > Face search.',
  MIGRATE_RUNNING: 'A library move is running. Try again when it has finished.',
  QUERY_EXPIRED: 'That search has expired. Try it again.',
  FACE_ENGINE_FAILED: 'Face search could not start. Try again, or download the models again in Settings > Face search.',
  // The app's lock screen (vault-ui.js fetch wrapper) answers this one.
  VAULT_LOCKED: '',
  FACE_MODEL_CHANGED: 'This face was found by an older version of face search. Look for faces in the file again.',
  TOO_LARGE: 'That photo is too big. The limit is 25 MB.',
  BAD_IMAGE: 'That file could not be read as a photo.',
  FRAME_FAILED: 'Could not read this frame of the video.',
  FILE_MISSING: 'The file is missing from disk.',
  NOT_ELIGIBLE: 'Only photos, GIFs and videos can be checked for faces.',
  NOT_FOUND: 'That face is no longer there.',
  // The Faces tab (people). Most of these mean the page is out of date.
  NAME_TAKEN: 'Someone else in Faces already has that name.',
  BAD_NAME: 'Names can be up to 120 characters.',
  BAD_COVER: 'That photo is no longer one of this person\'s faces. Try another.',
  BAD_IDS: 'Some of these people have changed. Refresh and try again.',
  BAD_FILTER: 'Faces could not do that. Refresh and try again.',
  BAD_SORT: 'Faces could not do that. Refresh and try again.',
  BAD_KIND: 'Faces could not do that. Refresh and try again.',
  BAD_ANSWER: 'Faces could not do that. Refresh and try again.',
  BAD_REQUEST: 'Faces could not do that. Refresh and try again.',
  NO_FACES: 'None of those faces can be added. They may belong to someone else now.',
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
    throw Object.assign(new Error(msg), { code: data.code, status: resp.status, keys: data.keys, data });
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
  // Only the first setup: a face model download later runs with modelsReady already true.
  if (prev && !prev.modelsReady && prev.download && prev.download.running && s.modelsReady) showToast('Face search is ready.');
  const flipped = was !== facesReady();
  if (flipped) facesApplyState();
  facesSettingsPaint();
  if (typeof facesTabStatusChanged === 'function') facesTabStatusChanged(flipped);
  facesScanPaint();
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
  // The person's name, unless names are private (a native tooltip cannot blur).
  const name = g.personName && !document.body.classList.contains('pm-names') ? g.personName : '';
  if (g.firstTimeS == null) return name;   // photos: nothing else worth saying
  const n = g.appearances || 1;
  const seen = `Seen in ${n} spot${n === 1 ? '' : 's'}, first at ${formatDuration(g.firstTimeS) || '0:00'}`;
  return name ? `${name}. ${seen}` : seen;
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

/** Chip menu: the person's page in the Faces tab, with the surface out of the way. */
function facesOpenInFaces(chip, personId) {
  if (chip.closest('#mediaSidebarBody')) { if (typeof minimizePlayer === 'function') minimizePlayer(); }
  else if (typeof closeModal === 'function') closeModal();
  facesOpenPerson(personId);
}

/* ── Person focus (filters.js focus set) ───────────────────────────────── */

let facesFocus = null;   // { src: {kind, id}, cropUrl, width, count, total, capped, opts, ids, match, source, likelyPerson }
let facesFocusSeq = 0;

/**
 * Search for one face (a stored group or a query face from a photo/frame)
 * and show the matches, best first. Called again with a new width, it
 * updates the same banner in place. `refresh` re-asks with the same width
 * after the results' people changed (an add, a name): the grid stays on its
 * page when the files did not change.
 * @returns {Promise<boolean>} whether the focus is showing
 */
async function facesOpenFocus(src, cropUrl, width = 'normal', { refresh = false } = {}) {
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
  const prev = facesFocus;
  const same = prev && prev.src.kind === src.kind && prev.src.id === src.id;
  if (refresh && !same) return false;        // the focus ended while this was asked
  const opts = same ? prev.opts : {
    renderBanner: facesRenderBanner,
    // Exited, or replaced by another focus: forget this one.
    onClear: () => {
      if (facesFocus && facesFocus.opts === opts) facesFocus = null;
      if (typeof renderSelectionBar === 'function') renderSelectionBar();
    },
  };
  opts.rankedScores = r.ids.map((id, i) => ({ id, score: r.scores[i] }));
  // A chip's own file always matches itself; it stays in the grid but does
  // not count as "another file that looks like this person".
  const others = src.mediaId ? r.ids.filter(id => id !== src.mediaId).length : r.ids.length;
  facesFocus = {
    src, cropUrl, width, wanted: width, count: r.ids.length, others, total: r.total, capped: !!r.capped, opts,
    ids: r.ids, match: r.match || {}, source: r.source || null, likelyPerson: r.likelyPerson || null,
  };
  if (refresh && prev.ids && prev.ids.length === r.ids.length && prev.ids.every((id, i) => id === r.ids[i])) {
    renderFocusBar();
    if (typeof applyFilters === 'function') applyFilters({ keepPage: true });
  } else {
    setFocusIds(r.ids, 'files that look like this person', opts);
  }
  if (typeof renderSelectionBar === 'function') renderSelectionBar();
  return true;
}

/** Ask the showing focus again (its people changed). */
function facesRefreshFocus() {
  const f = facesFocus;
  if (!f) return Promise.resolve(false);
  return facesOpenFocus(f.src, f.cropUrl, f.width, { refresh: true });
}

/**
 * The person the results are measured against: the clicked face's person,
 * or for a photo or frame, the person most of the results belong to.
 * @returns {{ id, name } | null}
 */
function facesFocusTarget(f = facesFocus) {
  if (!f) return null;
  if (f.src.kind === 'group') return f.source && f.source.personId ? { id: f.source.personId, name: f.source.personName || null } : null;
  return f.likelyPerson && f.likelyPerson.id ? { id: f.likelyPerson.id, name: f.likelyPerson.name || null } : null;
}

/**
 * Sort the results by who their matched face belongs to.
 * inT: already the target. others: Map personId -> { name, ids } of other
 * NAMED people (never moved without Pick which + a confirm). addable:
 * [{ mediaId, groupId }] that are in no one, or in someone not named yet.
 */
function facesBreakdown(f = facesFocus) {
  const T = facesFocusTarget(f);
  const out = { T, inT: [], others: new Map(), addable: [] };
  if (!f) return out;
  for (const id of f.ids || []) {
    const m = f.match[id];
    if (!m) continue;
    if (T && m.personId === T.id) out.inT.push(id);
    else if (m.personId && m.personName) {
      const o = out.others.get(m.personId) || { name: m.personName, ids: [] };
      o.ids.push(id);
      out.others.set(m.personId, o);
    } else out.addable.push({ mediaId: id, groupId: m.groupId });
  }
  return out;
}

const facesPmName = (name) => `<span class="ft-pm-name">${escapeHtml(name)}</span>`;
const facesNames = () => document.body.classList.contains('pm-names');
/** "Barack Obama", or "this person" for someone without a name. */
const facesWho = (T) => (T && T.name ? facesPmName(T.name) : 'this person');

const FACES_PEN = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a0a0a0" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"></path></svg>';

function facesRenderBanner(bar) {
  const f = facesFocus;
  if (!f) return;
  // A repaint under an open name field would leave it typing into nothing:
  // wait until the field closes (facesBannerName's onClose repaints).
  if (typeof FT !== 'undefined' && FT.naming && bar.contains(FT.naming.host)) { f.bannerDirty = true; return; }
  f.bannerDirty = false;
  const n = f.count;
  const b = facesBreakdown(f);
  const T = b.T;
  const lead = f.capped
    ? `Showing the closest <b>${n.toLocaleString()}</b> of ${Number(f.total).toLocaleString()} ${f.total === 1 ? 'file that looks' : 'files that look'} like`
    : `Showing <b>${n.toLocaleString()}</b> ${n === 1 ? 'file that looks' : 'files that look'} like`;
  // Naming: the clicked face's person (rename or a first name), a photo's
  // likely person while it has no name, or for a photo with no clear person
  // a new person from the results that are not in anyone yet.
  const whoT = T && T.name ? facesPmName(T.name) : f.src.kind === 'query' ? 'that person' : 'this person';
  const canName = f.src.kind === 'group' || (T ? !T.name : b.addable.length > 0);
  const addName = '<span class="faces-bname"><button type="button" class="faces-addname" data-faces-name>Add a name</button></span>';
  // Every result is already the person: say so once ("All 5 are X."); for
  // someone with no name yet, that they look like one person, and offer the name.
  const allIn = !!(T && f.others && !b.addable.length && !b.others.size && b.inT.length === n);
  const sameUnnamed = allIn && !T.name && n > 1 ? ' They all look like the same person.' : '';
  const allAre = (who, already) => (n === 1 ? `It is ${already}${who}.` : n === 2 ? `Both are ${already}${who}.`
    : `All ${n.toLocaleString()} are ${already}${who}.`);
  let text;
  if (f.src.kind === 'group') {
    if (!f.others) text = `No other files look like this person at this setting.${canName && !(T && T.name) ? addName : ''}`;
    else if (T && T.name) {
      text = `${lead} <span class="faces-bname"><span class="faces-bname-in"><span class="faces-bname-text ft-pm-name" data-faces-name>${escapeHtml(T.name)}</span><button type="button" class="faces-pen" data-faces-name aria-label="Rename" title="Rename">${FACES_PEN}</button></span></span>${allIn ? ` ${allAre(whoT, 'already ')}` : ''}`;
    } else text = `${lead} this person.${addName}`;
  } else {
    text = `${lead} this face.`;
    if (allIn && T.name) text += ` ${allAre(`<b>${facesPmName(T.name)}</b>`, '')}`;
    else if (sameUnnamed) text += sameUnnamed;
    else if (T) text += ` Most of them are ${T.name ? `<b>${facesPmName(T.name)}</b>` : 'someone with no name yet'}.`;
    if (canName) text += addName;
  }

  // Second row: who the results already are, and the add.
  let row2 = '';
  if (T && f.others && (b.addable.length || b.others.size)) {
    const parts = [];
    const be = (k) => (k === 1 ? 'is' : 'are');
    if (b.inT.length) parts.push(`<b>${b.inT.length.toLocaleString()}</b> ${be(b.inT.length)} ${b.others.size ? '' : 'already '}${whoT}.`);
    for (const o of b.others.values()) parts.push(`<b>${o.ids.length.toLocaleString()}</b> ${be(o.ids.length)} ${facesPmName(o.name)}.`);
    const notIn = b.others.size || f.src.kind === 'query' ? 'not in anyone yet' : 'not yet';
    if (b.addable.length) parts.push(`<b>${b.addable.length.toLocaleString()}</b> ${be(b.addable.length)} ${notIn}.`);
    const k = b.addable.length;
    row2 = `
      <div class="faces-brow2">
        <span class="faces-bsum">${parts.join(' ')}</span>
        ${k ? `<button type="button" class="faces-badd" data-faces-add>Add ${k === 1 ? 'it' : `the ${k.toLocaleString()}`} to ${whoT}</button>` : ''}
        <button type="button" class="faces-bghost" data-faces-pick>Pick which</button>
        <button type="button" class="faces-blink" data-faces-open>Open ${whoT} in Faces</button>
      </div>`;
  }
  bar.classList.add('faces-banner');
  bar.innerHTML = `
    <div class="faces-brow">
      ${f.cropUrl ? `<span class="faces-banner-crop"><img class="face-crop" src="${escapeHtml(f.cropUrl)}" alt=""></span>` : ''}
      <span class="focus-banner-text">${text}</span>
      <span class="settings-seg faces-width" role="group" aria-label="How close a match">
        ${FACES_WIDTHS.map(w => `<button type="button" class="settings-seg-btn" data-faces-width="${w.value}"
          aria-pressed="${w.value === f.wanted ? 'true' : 'false'}">${w.label}</button>`).join('')}
      </span>
      <button class="focus-banner-close" id="focusBarClear">Clear results</button>
    </div>${row2}`;
  bar.querySelector('#focusBarClear').addEventListener('click', clearFocusIds);
  bar.querySelectorAll('[data-faces-name]').forEach(el => el.addEventListener('click', () => facesBannerName(bar)));
  bar.querySelector('[data-faces-add]')?.addEventListener('click', (e) => {
    e.currentTarget.disabled = true;
    facesAddToTarget(facesBreakdown().addable.map(a => a.groupId));
  });
  bar.querySelector('[data-faces-pick]')?.addEventListener('click', facesPickWhich);
  bar.querySelector('[data-faces-open]')?.addEventListener('click', () => {
    const t = facesFocusTarget();
    if (t && typeof facesOpenPerson === 'function') facesOpenPerson(t.id);
  });
  bar.querySelectorAll('[data-faces-width]').forEach(b => b.addEventListener('click', async () => {
    const w = b.dataset.facesWidth;
    if (!facesFocus) return;
    // The width already showing, clicked again: search again (people may have changed).
    if (w === facesFocus.wanted && w === facesFocus.width) { facesRefreshFocus(); return; }
    // Compare with the last width ASKED for: quick clicks must end on the last one.
    if (w === facesFocus.wanted) return;
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

/**
 * The banner's name field (faces-tab.js ftStartNaming, the same field as the
 * Faces tab). A face with a person names that person; a face in no one, or a
 * photo with no clear person, starts a new person from it.
 */
function facesBannerName(bar) {
  const f = facesFocus;
  if (!f || typeof ftStartNaming !== 'function') return;
  const host = bar.querySelector('.faces-bname');
  if (!host || host.classList.contains('ft-naming')) return;
  const b = facesBreakdown(f);
  const T = b.T;
  const fromQuery = f.src.kind === 'query';
  const id = T && (!fromQuery || !T.name) ? T.id : null;
  const groupIds = id != null ? null : fromQuery ? b.addable.map(a => a.groupId) : [f.src.id];
  // The search runs again after every save, whatever happens to the field
  // meanwhile (a click elsewhere closes it before the answer is back).
  const save = async (name, mergeIfTaken) => {
    const json = { name, ...(groupIds ? { groupIds } : {}), ...(mergeIfTaken ? { mergeIfTaken: true } : {}) };
    const p = await facesApi(id != null ? `/api/faces/people/${id}` : '/api/faces/people', { method: 'POST', json });
    setTimeout(() => facesRefreshFocus(), 0);
    return p;
  };
  ftStartNaming({
    host, anchor: host.firstElementChild, id, initial: (T && T.name) || '', me: { coverUrl: f.cropUrl }, save,
    onDone: (p, how = {}) => {
      // A new person from a photo's results: say what moved (a merge already said so).
      const count = id == null && p && Array.isArray(p.moved) ? p.moved.length : 0;
      if (fromQuery && count && p.name && !how.merged) {
        showToast(facesNames() ? `Added ${facesFiles(count)} to a new person.` : `Added ${facesFiles(count)} to ${p.name}.`);
      }
    },
    onClose: () => { if (facesFocus && facesFocus.bannerDirty) renderFocusBar(); },
  });
}

const facesFiles = (k) => `${k.toLocaleString()} ${k === 1 ? 'file' : 'files'}`;

/**
 * Add faces to the banner's person (POST /api/faces/people/:id/add). Faces
 * of another named person are only taken with `takeFromNamed`, which only
 * Pick which + its confirm ever sends.
 * @returns {Promise<boolean>} whether the call went through
 */
async function facesAddToTarget(groupIds, { takeFromNamed = false } = {}) {
  const T = facesFocusTarget();
  if (!T || !groupIds.length) { renderFocusBar(); return false; }
  let moved = 0, already = 0;
  const skipped = [];
  try {
    for (let i = 0; i < groupIds.length; i += 2000) {
      const json = { groupIds: groupIds.slice(i, i + 2000) };
      if (takeFromNamed) json.takeFromNamed = true;
      const r = await facesApi(`/api/faces/people/${T.id}/add`, { method: 'POST', json });
      moved += (r.moved || []).length;
      already += (r.already || []).length;
      skipped.push(...(r.skipped || []));
    }
  } catch (err) { facesToastError(err); renderFocusBar(); return false; }
  if (typeof FT !== 'undefined') FT.faces.delete(T.id);
  const named = T.name && !facesNames();
  let msg = moved ? (named ? `Added ${facesFiles(moved)} to ${T.name}.` : `Added ${facesFiles(moved)}.`)
    : already ? (named ? `Already in ${T.name}.` : 'Already in this person.')
    : 'Nothing was added.';
  const other = skipped.filter(s => s.reason === 'other-named').length;
  const lost = skipped.length - other;
  if (other) msg += ` ${other.toLocaleString()} ${other === 1 ? 'was' : 'were'} left out because ${other === 1 ? 'it belongs' : 'they belong'} to someone else.`;
  if (lost) msg += ` ${lost.toLocaleString()} could not be added.`;
  showToast(msg);
  await facesRefreshFocus();
  return true;
}

function facesAddOne(mediaId) {
  const m = facesFocus && facesFocus.match[mediaId];
  if (m) facesAddToTarget([m.groupId]);
}

/** Pick which: tick the results that are not in the person yet; the selection bar adds them. */
function facesPickWhich() {
  const f = facesFocus;
  if (!f || typeof selectedIds === 'undefined') return;
  const b = facesBreakdown(f);
  f.picking = true;
  selectedIds.clear();
  for (const a of b.addable) selectedIds.add(a.mediaId);
  selectionChanged();
  lastSelectedId = null;
  syncTileCheckboxes();
  renderSelectionBar();
  showToast(b.addable.length
    ? 'Ticked the files that are not in this person yet. Untick any that are wrong, then click Add at the bottom.'
    : 'Tick the files to add, then click Add at the bottom.');
}

/** Selected results whose face is not the banner's person yet. */
function facesPicked() {
  const f = facesFocus;
  const T = facesFocusTarget(f);
  if (!T || typeof selectedIds === 'undefined') return [];
  return [...selectedIds].map(id => ({ mediaId: id, m: f.match[id] })).filter(x => x.m && x.m.personId !== T.id);
}

/** "👤 Add N to X" in the selection bar while face results with a person are showing. */
function facesPickedButton() {
  const f = facesFocus;
  document.body.classList.toggle('faces-picking', !!(f && f.picking && selectedIds.size));
  const T = facesFocusTarget(f);
  const k = facesPicked().length;
  if (!T || !k) return '';
  return `<button class="sel-btn sel-faces-add" onclick="facesAddPicked()"
    title="Add the matching face in each selected file to this person">👤 Add ${k.toLocaleString()} to ${facesWho(T)}</button>`;
}

async function facesAddPicked() {
  const T = facesFocusTarget();
  if (!T) return;
  const picked = facesPicked();
  const named = picked.filter(x => x.m.personId && x.m.personName);
  let list = picked, take = false;
  if (named.length) {
    const byName = new Map();
    for (const x of named) byName.set(x.m.personName, (byName.get(x.m.personName) || 0) + 1);
    const who = [...byName].map(([name, k]) => `<b>${k.toLocaleString()}</b> ${k === 1 ? 'is' : 'are'} <b>${facesPmName(name)}</b>`).join(', ');
    const rest = picked.length - named.length;
    const it = named.length === 1 ? 'it' : 'them';
    let say;
    if (named.length === 1) {
      // One file: name it. Names private: say it without names.
      const x = named[0];
      const row = typeof getMediaById === 'function' ? getMediaById(x.mediaId) : null;
      say = facesNames() || !row
        ? 'One of these files is someone else right now. Adding it moves that face to this person.'
        : `<b>${escapeHtml(row.filename)}</b> is <b>${facesPmName(x.m.personName)}</b> right now. Adding it moves that face to ${facesWho(T)}.`;
    } else {
      say = `Of the ${facesFiles(picked.length)} you picked, ${who}. Adding them moves those faces to ${facesWho(T)}.`;
    }
    const choice = await facesAsk({
      title: 'Move from someone else?',
      html: `<p class="vault-modal-hint">${say}</p>`,
      buttons: [
        { label: 'Cancel', value: null },
        ...(rest ? [{ label: `Add only the other ${rest.toLocaleString()}`, value: 'skip' }] : []),
        { label: `Move ${it} too`, value: 'move', primary: true },
      ],
    });
    if (!choice) return;
    if (choice === 'skip') list = picked.filter(x => !(x.m.personId && x.m.personName));
    else take = true;
  }
  if (!list.length) return;
  if (await facesAddToTarget(list.map(x => x.m.groupId), { takeFromNamed: take })) {
    if (facesFocus) facesFocus.picking = false;
    clearSelection();
  }
}

/**
 * A small question in the app's modal style. Modal for real: Tab stays
 * inside, and the safe answer (the first button, Cancel) has the focus, so a
 * stray Enter never does the irreversible thing. Focus goes back to where it
 * was when the question closes.
 * @returns {Promise<any>} the value of the button clicked; null for Cancel, Esc or a click outside
 */
function facesAsk({ title, html, buttons }) {
  return new Promise((resolve) => {
    document.getElementById('facesAsk')?._close();
    const opener = document.activeElement;
    const ov = document.createElement('div');
    ov.id = 'facesAsk';
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = `
      <div class="vault-modal" role="dialog" aria-modal="true" aria-labelledby="facesAskTitle">
        <h3 id="facesAskTitle">${escapeHtml(title)}</h3>
        ${html}
        <div class="vault-modal-actions">${buttons.map((b, i) => `<button class="vault-btn${b.primary ? ' vault-btn-primary' : ''}${b.danger ? ' faces-ask-danger' : ''}" data-ask="${i}">${escapeHtml(b.label)}</button>`).join('')}</div>
      </div>`;
    document.body.appendChild(ov);
    const done = (v) => {
      ov.remove();
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
      resolve(v);
    };
    ov._close = () => done(null);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(null); });
    ov.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...ov.querySelectorAll('button:not(:disabled)')];
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ov.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ov.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    });
    ov.querySelectorAll('[data-ask]').forEach(b => b.addEventListener('click', () => done(buttons[Number(b.dataset.ask)].value)));
    ov.querySelector('[data-ask]')?.focus();
  });
}

/** Result tiles: "✓ Barack Obama", another person's name, or "Not yet" + "+ Add to X" (cards.js via facesTileExtrasHtml). */
function facesResultTagHtml(media) {
  const f = facesFocus;
  const m = f && media && f.match && f.match[media.id];
  if (!m) return '';
  const T = facesFocusTarget(f);
  if (T && m.personId === T.id) return `<span class="faces-tag">✓ ${T.name ? facesPmName(T.name) : 'This person'}</span>`;
  if (m.personId && m.personName) return `<span class="faces-tag">${facesPmName(m.personName)}</span>`;
  if (!T) return '';
  return `<span class="faces-tag is-new">Not yet</span><button type="button" class="faces-tag-add"
    onclick="event.stopPropagation(); facesAddOne(${media.id})">+ Add to ${facesWho(T)}</button>`;
}

/** Chip menu: this face is not a face (a pattern, a shadow). Gone from everything. */
async function facesNotAFace(mediaId, groupId) {
  facesConfirm = null;
  try {
    await facesApi(`/api/faces/groups/${groupId}/not-a-face`, { method: 'POST' });
  } catch (err) { facesToastError(err); facesPaint(mediaId); return; }
  const info = facesInfo.get(mediaId);
  if (info) info.groups = (info.groups || []).filter(g => g.id !== groupId);
  facesPaint(mediaId);
  showUndoToast('Marked as not a face. It will not show up in face search.', async () => {
    try { await facesApi(`/api/faces/groups/${groupId}/unhide`, { method: 'POST' }); }
    catch (err) { facesToastError(err); return; }
    facesInfo.delete(mediaId);
    facesLoad(mediaId);
    showToast('The face is back.');
  }, 8000);
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

/**
 * "Faces (N)" in the selection bar (short, so the bar stays one line), and
 * "Add N to X" while face results with a person are showing; '' while off.
 */
function facesSelectionButton(n) {
  if (!facesReady()) { document.body.classList.remove('faces-picking'); return ''; }
  const add = facesPickedButton();
  if (!n) return add;
  return `${add}<button class="sel-btn sel-faces" onclick="facesIndexSelection()"
    title="Find faces in the selected files">👤 Faces (${n})</button>`;
}

let facesWatching = false;

/** Queue the selection; the scan panel shows how it goes. */
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
  showToast(`Looking for faces in ${added} file${added === 1 ? '' : 's'}.`);
  facesScanStarted();
}

/* ── Scan panel: the Faces view (importer.js window.vaultScanPane) ─────── */

// shown: the pane is up for the current (or just finished) run. hidden: the
// user pressed Hide for this run. runKey: which run that was (startedAt).
const facesScan = { shown: false, hidden: false, focus: false, running: false, runKey: null, stopArm: null, stopped: false };
const FACES_SCAN_POLL_MS = 1500;

/** A run the user just started (selection, Find faces in everything): show it, in front. */
function facesScanStarted() {
  facesScan.hidden = false;
  facesScan.focus = true;
  facesRefreshStatus().then(() => facesWatchQueue());
}

/**
 * Poll while the queue runs, and only then: every status answer repaints the
 * panel (facesSetStatus -> facesScanPaint), and the last one paints it finished.
 */
function facesWatchQueue() {
  if (facesWatching) return;
  facesWatching = true;
  const tick = async () => {
    if (document.hidden) { setTimeout(tick, FACES_SCAN_POLL_MS); return; }
    const s = await facesRefreshStatus();
    if (s && s.queue && s.queue.running && facesReady()) { setTimeout(tick, FACES_SCAN_POLL_MS); return; }
    facesWatching = false;
  };
  setTimeout(tick, FACES_SCAN_POLL_MS);
}

/** "about 4 min" / "about 20 s", the same rounding as the Faces tab's screen time. */
function facesAbout(s) {
  if (s < 60) return `about ${Math.max(5, Math.round(s / 5) * 5)} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return `about ${h} h${m ? ` ${m} min` : ''}`;
}

function facesScanRow(r) {
  const name = `<span class="dq-name">${escapeHtml(r.filename || `File ${r.mediaId}`)}</span>`;
  if (!r.ok) return `<div class="dq-row dq-failed"><span class="dq-ico">✕</span>${name}<span class="fsq-res">could not be read</span></div>`;
  if (!r.faces) return `<div class="dq-row dq-done fsq-none"><span class="dq-ico">–</span>${name}<span class="fsq-res">no faces</span></div>`;
  const names = r.names || [];
  const people = r.people || 0;
  const res = people === 1 && names.length === 1 ? facesPmName(names[0])
    : people ? `${people.toLocaleString()} ${people === 1 ? 'person' : 'people'}`
    : `${r.faces.toLocaleString()} ${r.faces === 1 ? 'face' : 'faces'}`;
  return `<div class="dq-row dq-done"><span class="dq-ico">✓</span>${name}<span class="fsq-res">${res}</span></div>`;
}

/** Build the pane's fixed parts once: the buttons keep their armed state across polls. */
function facesScanBuild(pane) {
  if (pane.querySelector('.fsq-head')) return;
  pane.innerHTML = `
    <div class="dq-head fsq-head"><span class="fsq-ico"></span><span class="dq-title fsq-title"></span>
      <button type="button" class="dq-x fsq-x" title="Dismiss" hidden>✕</button></div>
    <div class="dq-bar"><div class="dq-bar-fill fsq-fill"></div></div>
    <div class="dq-meta"><span class="fsq-meta"></span></div>
    <div class="dq-list fsq-list"></div>
    <div class="fsq-sum" hidden><span class="fsq-sum-text"></span><button type="button" class="fsq-open">Open Faces</button></div>
    <div class="dq-actions fsq-actions">
      <button type="button" class="dq-btn dq-btn-quiet fsq-hide" title="Hide this panel. Faces are still found in the background">Hide</button>
      <button type="button" class="dq-btn fsq-pause"></button>
      <button type="button" class="dq-btn dq-btn-danger fsq-stop">Stop</button>
    </div>`;
  pane.querySelector('.fsq-x').addEventListener('click', () => { facesScan.shown = false; window.vaultScanPane.drop('faces'); });
  pane.querySelector('.fsq-hide').addEventListener('click', () => {
    facesScan.hidden = true;
    facesScan.shown = false;
    window.vaultScanPane.drop('faces');
  });
  pane.querySelector('.fsq-open').addEventListener('click', () => {
    if (typeof ftOnTab === 'function' && ftOnTab()) { if (FT.personId != null) ftClosePerson(); }
    else if (typeof switchTab === 'function') switchTab('faces');
  });
  pane.querySelector('.fsq-pause').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const act = facesStatus?.queue?.paused ? 'resume' : 'pause';
    btn.disabled = true;
    try { await facesApi(`/api/faces/queue/${act}`, { method: 'POST' }); }
    catch (err) { facesToastError(err); }
    btn.disabled = false;
    await facesRefreshStatus();
    facesWatchQueue();
  });
  pane.querySelector('.fsq-stop').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Click again to stop';
      clearTimeout(facesScan.stopArm);
      facesScan.stopArm = setTimeout(() => facesScanDisarm(btn), 5000);
      return;
    }
    facesScanDisarm(btn);
    facesScan.stopped = true;
    try { await facesApi('/api/faces/queue/cancel', { method: 'POST' }); }
    catch (err) { facesToastError(err); }
    await facesRefreshStatus();
  });
}

function facesScanDisarm(btn) {
  clearTimeout(facesScan.stopArm);
  facesScan.stopArm = null;
  btn.classList.remove('armed');
  btn.textContent = 'Stop';
}

/**
 * The run as the panel shows it: running from the queue, finished from
 * lastRun. `recent` (newest first) holds this run's files at its front; a
 * click's file (direct) is not part of the run.
 */
function facesScanPaint() {
  const api = window.vaultScanPane;
  if (!api) return;
  const s = facesStatus;
  const q = s && s.queue;
  if (!facesReady() || !q) {
    if (api.has('faces')) api.drop('faces');
    facesScan.shown = false;
    facesScan.running = false;
    facesSwitchPane.shown = false;
    facesSwitchPane.running = false;
    return;
  }
  const wasRunning = facesScan.running;
  facesScan.running = !!q.running;
  if (q.running) {
    const key = q.startedAt || 'run';
    // A new run shows again, even after the last one was hidden.
    if (key !== facesScan.runKey) { facesScan.runKey = key; facesScan.hidden = false; facesScan.stopped = false; }
    if (!facesWatching) facesWatchQueue();
    if (facesScan.hidden) return;
    facesScan.shown = true;
  } else if (wasRunning) {
    // Just finished. A hidden panel says so in a toast instead.
    facesReloadOpenBoxes();
    const last = q.lastRun;
    if (!facesScan.shown && last && last.total) showToast(`Finished looking for faces in ${facesFiles(last.total)}.`);
  }
  // No run owns the pane: it may show a face model switch instead.
  if (!facesScan.shown) { facesSwitchPanePaint(); return; }

  const run = q.running ? q : (q.lastRun || {});
  // Stop shrinks total to what was checked; planned is what the run set out to do.
  const total = Math.max(run.planned || 0, run.total || 0);
  const finished = (run.done || 0) + (run.failed || 0);
  const recent = (q.recent || []).filter(r => !r.direct).slice(0, Math.min(finished, 50));
  const withPeople = run.withPeople != null ? run.withPeople : recent.filter(r => r.ok && r.faces > 0).length;
  const stopped = !q.running && (facesScan.stopped || finished < total);
  const pane = api.open('faces', {
    tab: '👤 Faces',
    sub: q.running ? `${Math.max(0, total - finished).toLocaleString()} left` : 'done',
    focus: facesScan.focus,
  });
  facesScan.focus = false;
  facesScanBuild(pane);
  const $ = (sel) => pane.querySelector(sel);

  const ico = $('.fsq-ico');
  if (q.running && !q.paused) { if (!ico.querySelector('.dq-spin')) ico.innerHTML = '<span class="dq-spin"></span>'; }
  else ico.innerHTML = `<span class="dq-ico">${q.running ? '⏸' : run.failed || stopped ? '⚠' : '✓'}</span>`;
  $('.fsq-title').textContent = `${q.running
    ? `${q.paused ? 'Paused: finding' : 'Finding'} faces in ${facesFiles(total)}`
    : stopped ? `Stopped after checking ${finished.toLocaleString()} of ${facesFiles(total)}`
    : `Finished looking for faces in ${facesFiles(total)}`}`;
  $('.fsq-x').hidden = !!q.running;
  $('.fsq-fill').style.width = `${total ? Math.min(100, (finished / total) * 100) : 0}%`;
  $('.fsq-meta').textContent = `${finished.toLocaleString()} of ${total.toLocaleString()}`
    + (q.running && !q.paused && q.etaS ? ` · ${facesAbout(q.etaS)} left` : '')
    + (run.failed ? ` · ${run.failed.toLocaleString()} could not be read` : '');

  const active = q.running ? (q.current || []).map(c => `<div class="dq-row dq-active"><span class="dq-ico">⏳</span>`
    + `<span class="dq-name">${escapeHtml(c.filename || `File ${c.id}`)}</span>`
    + `<span class="fsq-res">${c.progress > 0 && c.progress < 1 ? `${Math.round(c.progress * 100)}%` : ''}</span></div>`).join('') : '';
  const html = active + recent.map(facesScanRow).join('');
  const list = $('.fsq-list');
  if (list.dataset.html !== html) { list.dataset.html = html; list.innerHTML = html; }

  $('.fsq-sum').hidden = !finished;
  $('.fsq-sum-text').textContent = `${q.running ? 'So far: people' : 'People'} found in ${withPeople.toLocaleString()} of ${facesFiles(finished)}.`;

  $('.fsq-actions').hidden = !q.running;
  const pause = $('.fsq-pause');
  pause.textContent = q.paused ? 'Resume' : 'Pause';
  pause.classList.toggle('dq-btn-primary', !!q.paused);
}

/* ── Scan panel: the face model switch (same Faces pane, when no run shows) ── */

// key: which switch (from, to, start); hidden: the user pressed Hide for it;
// running: the last status had one, so its end can be told apart.
const facesSwitchPane = { key: null, hidden: false, shown: false, focus: false, running: false, label: '', to: null };
let facesSwitchWatching = false;
let facesSwitchExpectUntil = 0;
const facesSwitchExpected = () => Date.now() < facesSwitchExpectUntil && !facesActiveSwitch(facesStatus);

/** A switch the user just started in Settings: show it, in front. */
function facesSwitchStarted() {
  facesSwitchExpectUntil = Date.now() + 6000;
  facesSwitchPane.hidden = false;
  facesSwitchPane.focus = true;
  facesScanPaint();
  facesWatchSwitch();
}

/** Poll while a switch moves and the panel shows it (Settings polls on its own). */
function facesWatchSwitch() {
  if (facesSwitchWatching) return;
  facesSwitchWatching = true;
  const tick = async () => {
    if (document.hidden || facesPollTimer || facesWatching) { setTimeout(tick, FACES_SCAN_POLL_MS); return; }
    const s = await facesRefreshStatus();
    const sw = facesActiveSwitch(s);
    if ((sw && !sw.paused && facesSwitchPane.shown && facesReady()) || facesSwitchExpected()) { setTimeout(tick, FACES_SCAN_POLL_MS); return; }
    facesSwitchWatching = false;
  };
  setTimeout(tick, FACES_SCAN_POLL_MS);
}

async function facesSwitchPause(btn) {
  const act = facesActiveSwitch(facesStatus)?.paused ? 'resume' : 'pause';
  btn.disabled = true;
  try { facesSetStatus(await facesApi(`/api/faces/model-switch/${act}`, { method: 'POST' })); }
  catch (err) { facesToastError(err); }
  btn.disabled = false;
  facesSettingsPoll();
}

function facesSwitchPaneBuild(pane) {
  if (pane.querySelector('.fsw-head')) return;
  pane.innerHTML = `
    <div class="dq-head fsw-head"><span class="fsw-ico"></span><span class="dq-title fsw-title"></span>
      <button type="button" class="dq-x fsw-x" title="Dismiss" hidden>✕</button></div>
    <div class="dq-bar"><div class="dq-bar-fill fsw-fill"></div></div>
    <div class="dq-meta"><span class="fsw-meta"></span></div>
    <div class="dq-meta fsw-named" hidden></div>
    <div class="dq-actions fsw-actions">
      <button type="button" class="dq-btn dq-btn-quiet fsw-hide" title="Hide this panel. Faces are still re-read in the background">Hide</button>
      <button type="button" class="dq-btn fsw-pause"></button>
    </div>`;
  const drop = () => { facesSwitchPane.shown = false; window.vaultScanPane.drop('faces'); };
  pane.querySelector('.fsw-x').addEventListener('click', drop);
  pane.querySelector('.fsw-hide').addEventListener('click', () => { facesSwitchPane.hidden = true; drop(); });
  pane.querySelector('.fsw-pause').addEventListener('click', (e) => facesSwitchPause(e.currentTarget));
}

/** Called by facesScanPaint whenever no face check run owns the pane. */
function facesSwitchPanePaint() {
  const api = window.vaultScanPane;
  const st = facesSwitchPane;
  const s = facesStatus;
  const sw = facesActiveSwitch(s);
  if (sw) {
    const key = `${sw.from}>${sw.to}>${sw.startedAt || ''}`;
    if (key !== st.key) { st.key = key; st.hidden = false; }
    st.running = true;
    st.to = sw.to;
    st.label = FACES_KEEPERS[facesKeeperName(sw.to)]?.label || 'new';
    if (st.hidden) return;
    st.shown = true;
    if (!sw.paused) facesWatchSwitch();
  } else if (st.running) {
    // Ended: finished (lastModelSwitch is this one) or called off (gone back).
    st.running = false;
    const finished = !!(s && s.lastModelSwitch && s.lastModelSwitch.to === st.to);
    if (!finished) { if (st.shown) { st.shown = false; api?.drop('faces'); } return; }
    if (!st.shown) { showToast(`Faces were re-read with the ${st.label} model.`); return; }
  }
  if (!st.shown || !api) return;

  const pane = api.open('faces', {
    tab: '👤 Faces',
    sub: sw ? `${Math.max(0, (sw.total || 0) - (sw.done || 0)).toLocaleString()} left` : 'done',
    focus: st.focus,
  });
  st.focus = false;
  facesSwitchPaneBuild(pane);
  const $ = (sel) => pane.querySelector(sel);
  const ico = $('.fsw-ico');
  if (sw && !sw.paused) { if (!ico.querySelector('.dq-spin')) ico.innerHTML = '<span class="dq-spin"></span>'; }
  else ico.innerHTML = `<span class="dq-ico">${sw ? '⏸' : '✓'}</span>`;
  $('.fsw-title').textContent = !sw ? `Finished re-reading faces with the ${st.label} model`
    : sw.paused ? `Paused: re-reading faces with the ${st.label} model`
    : `Re-reading faces with the ${st.label} model`;
  $('.fsw-x').hidden = !!sw;
  $('.fsw-fill').style.width = sw ? facesPct(sw.done || 0, sw.total || 0) : '100%';
  const stuck = !sw && s && s.lastModelSwitch ? s.lastModelSwitch.stuck || 0 : 0;
  $('.fsw-meta').textContent = sw ? facesSwitchCount(sw)
    : 'Names and fixes stayed. People were sorted again with the new model.'
      + (stuck ? ` ${facesFiles(stuck)} could not be re-read; see Settings > Face search.` : '');
  const named = $('.fsw-named');
  named.hidden = !(sw && sw.namedTotal);
  if (!named.hidden) named.textContent = facesSwitchNamed(sw);
  $('.fsw-actions').hidden = !sw;
  if (sw) {
    const pause = $('.fsw-pause');
    pause.textContent = sw.paused ? 'Resume' : 'Pause';
    pause.classList.toggle('dq-btn-primary', !!sw.paused);
  }
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

/* ── Settings > Face search ────────────────────────────────────────────── */

// Same markup as settings.js toggleRow / segRow, with this block's own
// data attributes so the Settings tab's generic wiring never picks them up.
function facesToggleRow(key, title, desc, extraClass = '') {
  return `
    <label class="settings-toggle${extraClass ? ` ${extraClass}` : ''}">
      <span class="settings-toggle-text">
        <span class="settings-toggle-title">${title}</span>
        <span class="settings-toggle-desc">${desc}</span>
      </span>
      <input type="checkbox" data-faces-setting="${key}">
      <span class="settings-switch" aria-hidden="true"></span>
    </label>`;
}

function facesStatHtml(id) {
  return `<div><span class="faces-stat-num" id="${id}Num"></span><span class="faces-stat-label" id="${id}Label"></span></div>`;
}

/** The whole Settings > Face search section (settings.js RENDERERS.faces). */
function facesSettingsHtml() {
  return `
    <div class="faces-settings" id="facesSettings">
      ${facesToggleRow('enabled', 'Face search',
        'Click a face in a file\'s info to see every file that person is in, or search with a photo.', 'faces-main-toggle')}
      <p class="settings-note faces-privacy">Face search runs entirely on this computer. Nothing is
      uploaded. Faces are stored in your library and can be deleted here at any time.</p>

      <div class="mig-card" id="facesOffCard" hidden>
        <div class="mig-card-title">What you can do with it</div>
        <ul class="faces-list">
          <li>Click a face in a file's info to see every file that person is in.</li>
          <li>Drop a photo on 👤 Find a person to search with it.</li>
          <li>Pause a video and find the people in that frame.</li>
        </ul>
        <p class="faces-card-foot">The first time, Vault downloads three models (about ${facesSetupMB()} MB).
        Nothing else is set up until you turn it on.</p>
      </div>

      <div id="facesSetup" hidden>
        <h3 class="settings-h faces-h">Setting up</h3>
        <div class="mig-card" id="facesSetupCard">
          <div class="faces-status-line" id="facesSetupText"></div>
          <div class="mig-progress" id="facesDlBar" hidden>
            <div class="mig-bar"><div class="mig-bar-fill"></div></div>
            <div class="mig-bar-stats"></div>
          </div>
          <div class="mig-actions"><button class="settings-btn" id="facesDlBtn" type="button">Download the models</button></div>
        </div>
      </div>

      <div id="facesOnRows" hidden>
        <h3 class="settings-h faces-h">Your library</h3>
        <div class="mig-card">
          <div class="faces-stats">
            ${facesStatHtml('facesStatChecked')}
            ${facesStatHtml('facesStatPeople')}
            ${facesStatHtml('facesStatLeft')}
          </div>
          <div class="mig-progress" id="facesQueueBar">
            <div class="mig-bar"><div class="mig-bar-fill"></div></div>
            <div class="mig-bar-stats" hidden></div>
          </div>
          <div class="mig-actions" id="facesActions">
            <button class="settings-btn" id="facesAllBtn" type="button" hidden></button>
            <button class="settings-btn" id="facesPauseBtn" type="button" hidden>Pause</button>
            <button class="settings-btn faces-ghost" id="facesStopBtn" type="button" hidden>Stop</button>
            <span class="faces-qstatus" id="facesQueueText"></span>
          </div>
          <p class="faces-done" id="facesDoneText" hidden></p>
        </div>

        <div id="facesModelRows" hidden>
          <h3 class="settings-h faces-h">Face model</h3>
          <div class="faces-models">${Object.keys(FACES_KEEPERS).map(facesModelCardHtml).join('')}</div>
          <div class="faces-stuck" id="facesStuck" hidden>
            <span id="facesStuckText"></span>
            <button class="faces-link" id="facesStuckShow" type="button">Show which</button>
            <button class="faces-link" id="facesStuckRetry" type="button">Try again</button>
            <ul class="faces-stuck-list" id="facesStuckList" hidden></ul>
          </div>
          <div class="mig-card faces-switch-card" id="facesSwitchCard" hidden>
            <div class="faces-status-line" id="facesSwitchText"></div>
            <div class="mig-progress" id="facesSwitchBar">
              <div class="mig-bar"><div class="mig-bar-fill"></div></div>
              <div class="mig-bar-stats"></div>
            </div>
            <p class="faces-switch-named" id="facesSwitchNamed" hidden></p>
            <div class="mig-actions">
              <button class="settings-btn" id="facesSwitchDlBtn" type="button" hidden></button>
              <button class="settings-btn faces-ghost" id="facesSwitchPauseBtn" type="button" hidden>Pause</button>
              <button class="settings-btn faces-ghost" id="facesSwitchBackBtn" type="button" hidden></button>
            </div>
          </div>
          <p class="faces-model-hint" id="facesModelHint"></p>
        </div>

        <h3 class="settings-h faces-h">Checking</h3>
        ${facesToggleRow('autoIndex', 'Find faces in new imports automatically',
          'New photos and videos are checked for faces after they are added.')}
        <div class="settings-toggle settings-seg-row faces-stack">
          <span class="settings-toggle-text">
            <span class="settings-toggle-title" id="facesIntervalLabel">How closely to check videos</span>
            <span class="settings-toggle-desc">Closer checks find more faces but take longer. Applies to files checked from now on.</span>
          </span>
          <span class="settings-seg" role="group" aria-labelledby="facesIntervalLabel">
            ${FACES_INTERVALS.map(v => `<button type="button" class="settings-seg-btn" data-faces-interval="${v}"
              aria-pressed="false">Every ${v} seconds</button>`).join('')}
            <button type="button" class="settings-seg-btn" data-faces-interval="custom" aria-pressed="false">Custom</button>
          </span>
          <label class="faces-custom" id="facesCustomRow" hidden>Every
            <input class="settings-num" type="number" id="facesCustomInterval" min="0.5" max="120" step="0.5"
              aria-label="Seconds between checked frames"> seconds</label>
        </div>
        <label class="settings-toggle">
          <span class="settings-toggle-text">
            <span class="settings-toggle-title">Most frames per video</span>
            <span class="settings-toggle-desc">Longer videos spread these frames evenly. More frames find more faces but take longer.</span>
          </span>
          <span class="settings-num-wrap">
            <input class="settings-num faces-maxframes" type="number" id="facesMaxFrames" min="100" max="20000" step="1">
          </span>
        </label>
      </div>

      <!-- Its own section, outside facesOnRows: the privacy line promises
           deletion at any time, so this shows whenever face data exists,
           on or off. -->
      <div id="facesDeleteRow" hidden>
        <h3 class="settings-h faces-h">Face data</h3>
        <div class="settings-toggle faces-delete-row">
          <span class="settings-toggle-text">
            <span class="settings-toggle-title">Delete all face data</span>
            <span class="settings-toggle-desc">Removes every face Vault has found. Your photos and videos are not touched.</span>
          </span>
          <button class="settings-btn faces-danger" id="facesDeleteBtn" type="button">Delete</button>
        </div>
      </div>
    </div>`;
}

let facesPollTimer = null;
let facesDeleteArm = null;
let facesCustomOpen = false;   // "Custom" picked, field showing before a value is saved

// Decimal megabytes, whole numbers, the same unit as "about 39 MB".
const facesMB = (b) => Math.round(Number(b || 0) / 1e6).toLocaleString();
const facesPct = (part, whole) => (whole ? `${Math.min(100, (part / whole) * 100).toFixed(1)}%` : '0%');

/** Paint the section from facesStatus. Cheap; called after every poll. */
function facesSettingsPaint() {
  const root = document.getElementById('facesSettings');
  const s = facesStatus;
  if (!root || !s) return;
  const $ = (id) => document.getElementById(id);
  const toggle = root.querySelector('[data-faces-setting="enabled"]');
  if (toggle && !toggle.dataset.busy) toggle.checked = !!s.enabled;

  const dl = s.download;
  const c = s.counts || {};

  // Off: what the feature does. Hidden while the download question is open,
  // so the dialog sits over just the switch.
  $('facesOffCard').hidden = !!s.enabled || !!(toggle && toggle.dataset.busy);

  // Turned on, models not here yet: the download card.
  const setup = s.enabled && !s.modelsReady;
  $('facesSetup').hidden = !setup;
  if (setup) {
    const running = !!(dl && dl.running);
    const damaged = Object.values(s.missingReasons || {}).includes('corrupt');
    $('facesSetupText').textContent = running
      ? 'Downloading the face search models from huggingface.co.'
      : dl && dl.error ? 'The download did not finish. Check your connection and try again.'
      : damaged ? 'A face search model is damaged. Download it again to fix it.'
      : `Face search needs three models (about ${facesSetupMB()} MB) before it can work.`;
    $('facesSetupCard').classList.toggle('faces-warn', !running && !!(damaged || (dl && dl.error)));
    $('facesDlBar').hidden = !running;
    if (running) {
      $('facesDlBar').querySelector('.mig-bar-fill').style.width = facesPct(dl.received, dl.total);
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
  facesModelPaint();
  const q = s.queue || {};
  const eligible = c.eligible || 0;
  const indexed = Math.min(c.indexed || 0, eligible);
  const withFaces = c.withFaces || 0;
  const left = Math.max(0, eligible - indexed);
  const stat = (id, num, label) => { $(`${id}Num`).textContent = num; $(`${id}Label`).textContent = label; };
  stat('facesStatChecked', `${indexed.toLocaleString()} of ${eligible.toLocaleString()}`,
    eligible === 1 ? 'photo or video checked' : 'photos and videos checked');
  stat('facesStatPeople', withFaces.toLocaleString(), withFaces === 1 ? 'file with people in it' : 'files with people in them');
  stat('facesStatLeft', left.toLocaleString(), 'still to check');
  // Nothing to check: "0 of 0" says nothing the line below does not say better.
  root.querySelector('.faces-stats').hidden = !eligible;

  // Idle, the bar is the share of the library checked; while a run is going
  // (or paused) it is that run's progress, with "N of M" under it.
  const bar = $('facesQueueBar');
  const barStats = bar.querySelector('.mig-bar-stats');
  bar.classList.toggle('faces-paused', !!(q.running && q.paused));
  if (q.running) {
    const finished = (q.done || 0) + (q.failed || 0);
    bar.querySelector('.mig-bar-fill').style.width = facesPct(finished, q.total || 0);
    barStats.textContent =
      `${finished.toLocaleString()} of ${(q.total || 0).toLocaleString()}${q.failed ? `, ${q.failed} could not be checked` : ''}`;
  } else {
    bar.querySelector('.mig-bar-fill').style.width = eligible ? facesPct(indexed, eligible) : '0%';
  }
  barStats.hidden = !q.running;

  const all = $('facesAllBtn');
  all.hidden = !!q.running || !left;
  all.textContent = indexed ? 'Find faces in the rest' : 'Find faces in everything';
  const pause = $('facesPauseBtn');
  pause.hidden = !q.running;
  pause.textContent = q.paused ? 'Resume' : 'Pause';
  // Resume is the thing to do next; Pause is the quiet one.
  pause.classList.toggle('faces-ghost', !q.paused);
  $('facesStopBtn').hidden = !q.running;
  const text = $('facesQueueText');
  if (q.running) {
    const cur = (q.current || [])[0];
    text.innerHTML = q.paused ? 'Paused.'
      : cur ? `Checking <span class="faces-qname">${escapeHtml(cur.filename || '')}</span>` : 'Starting…';
  } else {
    text.textContent = '';
  }
  $('facesActions').hidden = !q.running && !left;

  const done = $('facesDoneText');
  done.hidden = !!q.running || !!left;
  done.textContent = !eligible ? 'There are no photos or videos to check yet.'
    : `Every photo and video has been checked.${s.autoIndex ? ' New imports are checked automatically.' : ''}`;

  root.querySelector('[data-faces-setting="autoIndex"]').checked = !!s.autoIndex;
  const custom = facesCustomOpen || !FACES_INTERVALS.includes(s.intervalS);
  root.querySelectorAll('[data-faces-interval]').forEach(b => b.setAttribute('aria-pressed',
    String(b.dataset.facesInterval === 'custom' ? custom : !custom && Number(b.dataset.facesInterval) === s.intervalS)));
  $('facesCustomRow').hidden = !custom;
  const ci = $('facesCustomInterval');
  if (document.activeElement !== ci && s.intervalS != null) ci.value = s.intervalS;
  const mf = $('facesMaxFrames');
  if (document.activeElement !== mf) mf.value = s.maxFrames ?? FACES_MAX_FRAMES_DEFAULT;
}

/** Commit a number field: in range and on the step, or put the saved value back. */
async function facesSettingsNumber(input, key, { min, max, step }) {
  const raw = Number(input.value);
  const v = Math.round(raw / step) * step;
  const saved = key === 'maxFrames' ? (facesStatus?.maxFrames ?? FACES_MAX_FRAMES_DEFAULT) : facesStatus?.intervalS;
  if (input.value === '' || !Number.isFinite(raw) || v < min || v > max) {
    showToast(`Pick a number from ${min.toLocaleString()} to ${max.toLocaleString()}.`);
    if (saved != null) input.value = saved;
    return;
  }
  if (v === saved) { input.value = v; return; }
  await facesSettingsPost({ [key]: v });
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
    if (s && ((s.queue && s.queue.running) || (s.download && s.download.running)
      || (facesActiveSwitch(s) && !facesActiveSwitch(s).paused) || facesSwitchExpected())) facesSettingsPoll();
  }, 1500);
}

async function facesSettingsPost(patch) {
  try {
    facesSetStatus(await facesApi('/api/faces/settings', { method: 'POST', json: patch }));
    return true;
  } catch (err) { facesToastError(err); facesSettingsPaint(); return false; }
}

/** The face model the first setup downloads: the choice, Standard unless changed. */
function facesSetupKeeper() {
  const m = facesStatus && facesStatus.facesModel;
  return FACES_KEEPERS[m] ? m : FACES_DEFAULT_KEEPER;
}
function facesSetupMB() { return FACES_GRUNT_MB + FACES_KEEPERS[facesSetupKeeper()].mb; }

/** Approve the download of each key (lib/model-consent.js). Throws a toast-ready Error. */
async function facesAllowKeys(keys) {
  for (const key of keys) {
    const r = await fetch('/api/settings/model-downloads', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, allow: true }),
    });
    if (!r.ok) throw new Error('Downloads are turned off for this copy of Vault.');
  }
}

/**
 * A download question in the style of subtitlesShowModelConsent. Resolves
 * true on the yes button. Shares the #facesConsent id with the Escape handler.
 */
function facesConsentModal({ label, title, body, yes }) {
  return new Promise((resolve) => {
    document.getElementById('facesConsent')?.remove();
    const ov = document.createElement('div');
    ov.id = 'facesConsent';
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = `
      <div class="vault-modal" role="dialog" aria-label="${label}">
        <h3>⬇ ${title}</h3>
        ${body}
        <div class="vault-modal-actions">
          <button class="vault-btn" data-consent="no">Not now</button>
          <button class="vault-btn vault-btn-primary" data-consent="yes">${yes}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const answer = (ok) => { ov.remove(); resolve(ok); };
    ov._close = () => answer(false);
    ov.querySelector('[data-consent="yes"]').addEventListener('click', () => answer(true));
    ov.querySelector('[data-consent="no"]').addEventListener('click', () => answer(false));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) answer(false); });
    ov.querySelector('[data-consent="yes"]').focus();
  });
}

const FACES_RESEARCH_NOTE = 'was made by researchers from photos collected for research. Vault uses it only on your own library.';

/** Download the models; asks first when the keys are not approved yet. */
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

/** The first-time question: all three models in one prompt. Resolves true once approved and started. */
async function facesAskConsent() {
  const name = facesSetupKeeper();
  const k = FACES_KEEPERS[name];
  const ok = await facesConsentModal({
    label: 'Download the face search models',
    title: 'Download the face search models?',
    body: `
      <p class="vault-modal-hint">Face search needs three models from <b>huggingface.co</b>,
        about ${facesSetupMB()} MB in all:</p>
      <ul class="vault-modal-hint faces-consent-list">
        <li>one that finds faces in photos and video frames (under 1 MB)</li>
        <li>one that groups the faces found in each file (about ${FACES_GRUNT_MB} MB)</li>
        <li>the ${k.label} face model, which tells people apart (about ${k.mb} MB)</li>
      </ul>
      <p class="vault-modal-hint">They run on this computer only. Your photos and videos are never
        uploaded. If you say no, nothing is downloaded, and face search cannot be used until the
        models are here.</p>
      <p class="vault-modal-hint">The ${k.label} face model ${FACES_RESEARCH_NOTE}</p>`,
    yes: 'Download them',
  });
  if (!ok) return false;
  try { await facesAllowKeys(['face:detect', 'face:embed', `face:keeper-${name}`]); }
  catch (err) { facesToastError(err); return false; }
  return facesStartDownload();
}

/* ── Settings > Face search: the face model (Standard / Best) ──────────── */

/** 'ir50' | 'ir101' for a settings name or a model id, else null (SFace, unknown). */
function facesKeeperName(id) {
  if (FACES_KEEPERS[id]) return id;
  const fm = (facesStatus && facesStatus.faceModels) || {};
  return Object.keys(fm).find(n => fm[n] && fm[n].modelId === id) || null;
}

function facesModelCardHtml(name) {
  const k = FACES_KEEPERS[name];
  return `
    <div class="faces-model" data-faces-model="${name}">
      <div class="faces-model-top"><b>${k.label}</b><span class="faces-model-tag" hidden></span></div>
      <p class="faces-model-desc"></p>
      <span class="faces-model-meta">${k.mb} MB download${k.recommended ? ' · Recommended' : ''}</span>
      <button class="settings-btn faces-model-btn" type="button" data-faces-switch="${name}" hidden>Switch to ${k.label}</button>
    </div>`;
}

/**
 * Where the face model stands. phase: 'download' (the choice is not on disk
 * yet), 'switch' (faces are being re-read with it), or null. target is the
 * model being moved to, old the one still answering searches meanwhile.
 */
/** The switch in progress, or null. { idle: true } only reports stuck files. */
function facesActiveSwitch(s) {
  const sw = s && s.modelSwitch;
  return sw && !sw.idle ? sw : null;
}

function facesModelPhase(s) {
  const needs = FACES_KEEPERS[s.needsModel] ? s.needsModel : null;
  const sw = facesActiveSwitch(s);
  if (needs) return { phase: 'download', target: needs, old: facesKeeperName(s.activeModel), sw };
  if (sw) return { phase: 'switch', target: facesKeeperName(sw.to), old: facesKeeperName(sw.from), sw };
  return { phase: null, target: null, old: null, sw: null };
}

function facesModelPaint() {
  const $ = (id) => document.getElementById(id);
  const s = facesStatus;
  const fm = s.faceModels;
  $('facesModelRows').hidden = !fm;   // a server without the choice
  if (!fm) return;
  const chosen = FACES_KEEPERS[s.facesModel] ? s.facesModel : FACES_DEFAULT_KEEPER;
  const { phase, target, old, sw } = facesModelPhase(s);
  const dl = phase === 'download' && s.download && s.download.model === target ? s.download : null;
  const loading = !!(dl && dl.running);

  document.querySelectorAll('#facesModelRows [data-faces-model]').forEach(card => {
    const n = card.dataset.facesModel;
    const k = FACES_KEEPERS[n];
    const m = fm[n] || {};
    let tag = '', kind = '', desc = k.desc;
    if (phase && n === target) {
      if (phase === 'switch') { tag = 'Switching'; kind = 'go'; desc = 'Downloaded.'; }
      else if (loading) { tag = 'Downloading'; kind = 'go'; desc = 'Downloading now.'; }
      else { tag = 'Not downloaded'; desc = 'Not downloaded yet.'; }
    } else if (phase && n === old) {
      tag = 'Still used until the switch is done';
      desc = 'Face search keeps working the whole time.';
    } else if (!phase && n === chosen) {
      tag = 'In use'; kind = 'use';
    } else {
      tag = m.present === true ? 'Downloaded' : m.present === false ? 'Not downloaded' : '';
    }
    card.classList.toggle('on', n === (phase ? target : chosen));
    const t = card.querySelector('.faces-model-tag');
    t.textContent = tag;
    t.hidden = !tag;
    t.classList.toggle('faces-tag-use', kind === 'use');
    t.classList.toggle('faces-tag-go', kind === 'go');
    card.querySelector('.faces-model-desc').textContent = desc;
    const meta = card.querySelector('.faces-model-meta');
    meta.hidden = !!phase;
    meta.textContent = (m.present === true ? 'Downloaded' : `${k.mb} MB download`) + (k.recommended ? ' · Recommended' : '');
    card.querySelector('.faces-model-btn').hidden = !!phase || n === chosen;
  });

  facesStuckPaint(phase ? 0 : (s.modelSwitch && s.modelSwitch.stuck) || 0);

  const card = $('facesSwitchCard');
  card.hidden = !phase;
  $('facesModelHint').textContent = phase
    ? 'Names, merges and hidden faces carry over. When it finishes, people are sorted again with the new model and "Same person?" may have new suggestions.'
    : 'Switching re-reads only the faces Vault already found, so it is much quicker than checking everything again. Names and fixes stay.';
  if (!phase) return;
  const label = FACES_KEEPERS[target]?.label || 'new';
  const bar = $('facesSwitchBar');
  const stats = bar.querySelector('.mig-bar-stats');
  const named = $('facesSwitchNamed');
  const dlBtn = $('facesSwitchDlBtn');
  const pause = $('facesSwitchPauseBtn');
  if (phase === 'download') {
    const failed = !loading && !!(dl && dl.error);
    $('facesSwitchText').textContent = loading ? `Downloading the ${label} model from huggingface.co.`
      : failed ? `The ${label} model did not finish downloading. Check your connection and try again.`
      : `The ${label} model is not downloaded yet.`;
    card.classList.toggle('faces-warn', failed);
    bar.hidden = !loading;
    bar.classList.remove('faces-paused');
    if (loading) {
      bar.querySelector('.mig-bar-fill').style.width = facesPct(dl.received, dl.total);
      stats.textContent = `${facesMB(dl.received)} of ${facesMB(dl.total)} MB`;
    }
    named.hidden = true;
    dlBtn.hidden = loading;
    dlBtn.textContent = failed ? 'Try again' : 'Download it';
    dlBtn.dataset.model = target;
    pause.hidden = true;
  } else {
    card.classList.remove('faces-warn');
    $('facesSwitchText').textContent = sw.paused
      ? `Paused: re-reading faces with the ${label} model.` : `Re-reading faces with the ${label} model.`;
    bar.hidden = false;
    bar.classList.toggle('faces-paused', !!sw.paused);
    bar.querySelector('.mig-bar-fill').style.width = facesPct(sw.done || 0, sw.total || 0);
    stats.textContent = facesSwitchCount(sw);
    named.hidden = !sw.namedTotal;
    if (sw.namedTotal) named.textContent = facesSwitchNamed(sw);
    dlBtn.hidden = true;
    pause.hidden = false;
    pause.textContent = sw.paused ? 'Resume' : 'Pause';
    pause.classList.toggle('faces-ghost', !sw.paused);
  }
  // Back to the model still in use. None when that is the model from before
  // the choice existed (an old library's): it cannot be picked.
  const back = $('facesSwitchBackBtn');
  const to = old && old !== target ? old : null;
  back.hidden = !to;
  if (to) { back.textContent = `Go back to ${FACES_KEEPERS[to].label}`; back.dataset.model = to; }
}

/* Files the switch could not re-read: they stay in the old model. */
let facesStuckOpen = false;

// The server's reasons (lib/faces/model-switch.js) in plain words; anything
// else is a raw error, which is not shown.
const FACES_STUCK_WHY = {
  'file not found': 'The file is missing from disk.',
  'not a photo, GIF or video any more': 'It is no longer a photo, GIF or video.',
};

function facesStuckPaint(n) {
  const $ = (id) => document.getElementById(id);
  const box = $('facesStuck');
  box.hidden = !n;
  if (!n) { facesStuckOpen = false; $('facesStuckList').hidden = true; return; }
  $('facesStuckText').textContent = n === 1
    ? '1 file could not be re-read with the new model. It still works with the old one.'
    : `${n.toLocaleString()} files could not be re-read with the new model. They still work with the old one.`;
  $('facesStuckShow').textContent = facesStuckOpen ? 'Hide the list' : 'Show which';
  $('facesStuckList').hidden = !facesStuckOpen;
  // The list follows the count: reload it when the count changed.
  if (facesStuckOpen && Number($('facesStuckList').dataset.n) !== n) facesStuckLoad();
}

async function facesStuckLoad() {
  const list = document.getElementById('facesStuckList');
  list.dataset.n = String(facesActiveSwitch(facesStatus) ? 0 : (facesStatus?.modelSwitch?.stuck || 0));
  let files = [];
  try { files = (await facesApi('/api/faces/model-switch/stuck', { background: true })).files || []; }
  catch (err) { facesToastError(err); return; }
  list.innerHTML = files.map(f => `<li><span class="faces-stuck-name">${escapeHtml(f.filename || `File ${f.mediaId}`)}</span>`
    + `<span class="faces-stuck-why">${FACES_STUCK_WHY[f.reason] || 'It could not be read.'}</span></li>`).join('');
}

async function facesStuckRetry(btn) {
  btn.disabled = true;
  try { facesSetStatus(await facesApi('/api/faces/model-switch/retry', { method: 'POST' })); }
  catch (err) { facesToastError(err); btn.disabled = false; return; }
  btn.disabled = false;
  facesStuckOpen = false;
  facesSwitchStarted();
  facesSettingsPoll();
}

/** "1,240 of 4,300 files · about 6 min left" (the switch counts files). */
function facesSwitchCount(sw) {
  const total = sw.total || 0;
  return `${(sw.done || 0).toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'file' : 'files'}`
    + (!sw.paused && sw.etaS ? ` · ${facesAbout(sw.etaS)} left` : '');
}

/** Named people's files are re-read first. */
function facesSwitchNamed(sw) {
  const done = sw.namedDone || 0;
  return done >= sw.namedTotal
    ? `Named people are done (${sw.namedTotal.toLocaleString()}).`
    : `Named people go first: ${done.toLocaleString()} of ${sw.namedTotal.toLocaleString()} done.`;
}

/** Download the chosen face model; asks again when its key is not approved. */
async function facesDownloadKeeper(name, { asked = false } = {}) {
  try {
    facesSetStatus(await facesApi('/api/faces/models/download', { method: 'POST', json: { model: name } }));
    facesSettingsPoll();
    return true;
  } catch (err) {
    if (err.code === 'CONSENT_NEEDED' && !asked) {
      if (!await facesAskModelConsent(name)) return false;
      return facesDownloadKeeper(name, { asked: true });
    }
    if (err.code) facesToastError(err); else showToast('Could not start the download. Try again.');
    return false;
  }
}

/** M2: download a face model that is not here yet. Resolves true once approved. */
async function facesAskModelConsent(name) {
  const k = FACES_KEEPERS[name];
  const ok = await facesConsentModal({
    label: `Download the ${k.label} face model`,
    title: `Switch to the ${k.label} face model?`,
    body: `
      <p class="vault-modal-hint">Vault downloads it once (about ${k.mb} MB) from <b>huggingface.co</b>.
        It runs on this computer only, and your photos and videos are never uploaded.</p>
      <p class="vault-modal-hint">Then Vault re-reads the faces it already found with the new model.
        It runs in the background, your names and fixes stay, and you can keep using Vault.</p>
      <p class="vault-modal-hint">This model ${FACES_RESEARCH_NOTE}</p>`,
    yes: 'Download and switch',
  });
  if (!ok) return false;
  try { await facesAllowKeys([`face:keeper-${name}`]); }
  catch (err) { facesToastError(err); return false; }
  return true;
}

/**
 * Pick a face model. One that is here: the switch starts at once. One that
 * is not: ask (M2), choose it, then download it; the server starts the
 * switch when the file is in. Choosing first means the switch still happens
 * if Settings is closed during the download.
 */
async function facesSwitchModel(name, btn) {
  const s = facesStatus;
  if (!s || !FACES_KEEPERS[name]) return;
  const m = (s.faceModels || {})[name] || {};
  if (btn) btn.disabled = true;
  try {
    if (m.present === false) {
      if (!await facesAskModelConsent(name)) return;
      if (!await facesSettingsPost({ model: name })) return;
      await facesDownloadKeeper(name, { asked: true });
    } else if (!await facesSettingsPost({ model: name })) return;
    facesSettingsPoll();
    facesSwitchStarted();
  } finally { if (btn) btn.disabled = false; }
}


async function facesToggleEnabled(cb) {
  if (!cb.checked) { await facesSettingsPost({ enabled: false }); return; }
  if (facesStatus && facesStatus.modelsReady) { await facesSettingsPost({ enabled: true }); return; }
  // Models missing: the switch stays off until the user agrees to the download.
  cb.checked = false;
  cb.dataset.busy = '1';
  facesSettingsPaint();   // the Off card steps aside while the question is open
  let started = false;
  try {
    const md = await fetch('/api/settings/model-downloads').then(r => r.json()).catch(() => ({}));
    const ok = md.consents && ['face:detect', 'face:embed', 'face:keeper-' + facesSetupKeeper()].every(k => md.consents[k] === true);
    started = ok ? await facesStartDownload() : await facesAskConsent();
  } finally { delete cb.dataset.busy; }
  if (started) await facesSettingsPost({ enabled: true });
  else facesSettingsPaint();
}

function facesDisarmDelete() {
  clearTimeout(facesDeleteArm);
  facesDeleteArm = null;
  const b = document.getElementById('facesDeleteBtn');
  if (b) { b.classList.remove('armed'); b.textContent = 'Delete'; }
}

async function facesDeleteAll(btn) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Click again to delete';
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

/** Called by settings.js selectSection after every render of the Face search section. */
function facesWireSettings() {
  const root = document.getElementById('facesSettings');
  if (!root) return;
  root.querySelector('[data-faces-setting="enabled"]').addEventListener('change', (e) => facesToggleEnabled(e.target));
  root.querySelector('[data-faces-setting="autoIndex"]').addEventListener('change', (e) => facesSettingsPost({ autoIndex: e.target.checked }));
  facesCustomOpen = false;
  root.querySelectorAll('[data-faces-interval]').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.facesInterval === 'custom') {
      facesCustomOpen = true;
      facesSettingsPaint();
      const ci = document.getElementById('facesCustomInterval');
      ci.focus();
      ci.select();
      return;
    }
    facesCustomOpen = false;
    facesSettingsPost({ intervalS: Number(b.dataset.facesInterval) });
  }));
  const ci = root.querySelector('#facesCustomInterval');
  ci.addEventListener('change', () => facesSettingsNumber(ci, 'intervalS', { min: 0.5, max: 120, step: 0.5 }));
  ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') ci.blur(); });
  const mf = root.querySelector('#facesMaxFrames');
  mf.addEventListener('change', () => facesSettingsNumber(mf, 'maxFrames', { min: 100, max: 20000, step: 1 }));
  mf.addEventListener('keydown', (e) => { if (e.key === 'Enter') mf.blur(); });
  root.querySelector('#facesDlBtn').addEventListener('click', () => facesStartDownload());
  root.querySelector('#facesAllBtn').addEventListener('click', async () => {
    try { facesSetStatus({ ...facesStatus, queue: await facesApi('/api/faces/index', { method: 'POST', json: { all: true } }) }); }
    catch (err) { facesToastError(err); return; }
    facesScanStarted();
    facesSettingsPoll();
  });
  root.querySelector('#facesPauseBtn').addEventListener('click', async () => {
    const act = facesStatus?.queue?.paused ? 'resume' : 'pause';
    try { facesSetStatus({ ...facesStatus, queue: await facesApi(`/api/faces/queue/${act}`, { method: 'POST' }) }); }
    catch (err) { facesToastError(err); }
    // The counts moved while it ran: ask for them now, not on the next poll.
    await facesRefreshStatus();
    facesSettingsPoll();
  });
  root.querySelector('#facesStopBtn').addEventListener('click', async () => {
    try { facesSetStatus({ ...facesStatus, queue: await facesApi('/api/faces/queue/cancel', { method: 'POST' }) }); }
    catch (err) { facesToastError(err); }
    facesRefreshStatus();
  });
  root.querySelector('#facesDeleteBtn').addEventListener('click', (e) => facesDeleteAll(e.currentTarget));
  root.querySelectorAll('[data-faces-switch]').forEach(b => b.addEventListener('click', () => facesSwitchModel(b.dataset.facesSwitch, b)));
  root.querySelector('#facesSwitchDlBtn').addEventListener('click', (e) => facesDownloadKeeper(e.currentTarget.dataset.model));
  root.querySelector('#facesSwitchPauseBtn').addEventListener('click', (e) => facesSwitchPause(e.currentTarget));
  facesStuckOpen = false;
  root.querySelector('#facesStuckShow').addEventListener('click', () => {
    facesStuckOpen = !facesStuckOpen;
    if (facesStuckOpen) facesStuckLoad();
    facesSettingsPaint();
  });
  root.querySelector('#facesStuckRetry').addEventListener('click', (e) => facesStuckRetry(e.currentTarget));
  root.querySelector('#facesSwitchBackBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const to = btn.dataset.model;
    if (await facesSettingsPost({ model: to })) showToast(`Back on the ${FACES_KEEPERS[to].label} model.`);
    btn.disabled = false;
    facesSettingsPoll();
  });
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
    const g = ((facesInfo.get(mediaId) || {}).groups || []).find(x => x.id === groupId);
    facesMenu(e.clientX, e.clientY, [
      { label: 'Find this person', run: () => facesChipFocus(chip) },
      ...(g && g.personId && typeof facesOpenPerson === 'function'
        ? [{ label: 'Open in Faces', run: () => facesOpenInFaces(chip, g.personId) }] : []),
      { label: 'Hide this face', run: () => { facesConfirm = { mediaId, groupId }; facesPaint(mediaId); } },
      { label: 'Not a face', run: () => facesNotAFace(mediaId, groupId) },
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
  const modal = document.getElementById('facesAsk') || document.getElementById('facesConsent') || document.getElementById('facesPicker');
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

// Back from another tab while face checks run: catch up now, not on the next poll.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && facesWatching) facesRefreshStatus();
});

// Boot: learn whether the feature is on. A locked vault answers 423 and the
// feature simply stays dark until the unlock reloads the page.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => facesRefreshStatus());
else facesRefreshStatus();
