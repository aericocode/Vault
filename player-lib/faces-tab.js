/* =========================================================================
   FACES TAB - everyone in the library (FACES_PEOPLE_SPEC section 4).

   Lives inside #mainContainer like the Collections tab:
     home    #facesView holds the people grid (search, sort, chips, the
             checking strip, "Same person?" strip, tiles); the library grid
             is emptied (filters.js applyFilters -> facesHomeShowing).
     person  #facesView holds the breadcrumb and header; the library grid
             below shows the person's files (filters.js currentQuerySpec ->
             facesPersonQuery: onlyIds + rankedIds in the person's order).

   A People | Studios switch (FT.mode, remembered) sits at the start of the
   top row; in Studios mode studios.js draws #facesView instead (studiosRender),
   with or without face search.

   Hooks into other files:
     tabs.js        facesTabEnter() / facesTabLeave()
     filters.js     facesHomeShowing(), facesPersonQuery()
     cards.js       facesTileExtrasHtml(media)   "▶ from 0:04", "✕ Not this person";
                                                 in the library, the face results' tags (faces.js)
     viewtracker.js facesStartAt(el)             play from the first appearance
     faces.js       facesTabStatusChanged()      status polls repaint the strip
   Server: /api/faces/people*, /api/faces/review (server/faces-routes.js).
   ========================================================================= */

const FT_SORTS = [
  { value: 'files', label: 'Most files' },
  { value: 'screen', label: 'Most time on screen' },
  { value: 'recent', label: 'Recently added' },
  { value: 'name', label: 'Name A to Z' },
];
const FT_FILTERS = [
  { value: 'all', label: 'Everyone' },
  { value: 'named', label: 'Named' },
  { value: 'unnamed', label: 'Not named yet' },
  { value: 'favorites', label: '★ Favorites' },
  { value: 'single', label: 'In only one file' },
  { value: 'hidden', label: 'Hidden' },
];
const FT_PAGE = 200;
const FT_CARD_MIN = { S: 130, M: 170, L: 230 };
const FT_FLIP_MS = 700;

const FT = {
  filter: 'all', sort: 'files', q: '',
  people: [], total: 0, counts: null, limit: FT_PAGE, loaded: false, seq: 0,
  review: { total: 0, pairs: [] },
  sel: new Map(),            // id -> person (kept while the list changes under it)
  anchor: null,              // last checkbox clicked, for shift ranges
  personId: null, person: null, kind: 'all',
  fileIds: null, fileInfo: {}, filesSeq: 0, filesReady: null,
  faces: new Map(),          // personId -> [{ groupId, mediaId, cropUrl }]
  naming: null,              // the open name editor
  pin: null,                 // a person kept in the grid after a merge or name (ftRevealTile)
  lastCounts: null,
  pollTimer: null,
  mode: 'people',            // the People | Studios switch (studios.js draws Studios)
};
try { if (localStorage.getItem('vaultFacesMode') === 'studios') FT.mode = 'studios'; } catch {}

/* ── Small helpers ─────────────────────────────────────────────────────── */

const ftEsc = (s) => escapeHtml(String(s ?? ''));
const ftOnTab = () => typeof currentTab !== 'undefined' && currentTab === 'faces';
const ftView = () => document.getElementById('facesView');
const ftPlural = (n, one, many) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

function ftTime(s) {
  return s ? formatDuration(s) : '0:00';
}

/** "About 1 min on screen" / "About 20 s on screen". */
function ftScreen(s) {
  if (!s || s < 1) return '';
  if (s < 60) return `About ${Math.max(5, Math.round(s / 5) * 5)} s on screen`;
  const min = Math.round(s / 60);
  if (min < 60) return `About ${min} min on screen`;
  const h = Math.floor(min / 60), m = min % 60;
  return `About ${h} h${m ? ` ${m} min` : ''} on screen`;
}

function ftBadges(p) {
  const out = [ftPlural(p.files, 'file', 'files')];
  if (p.videos) { const t = ftScreen(p.screenS); if (t) out.push(t); }
  else if (p.photos) out.push('Photos only');
  return out;
}

function ftName(p) { return p && p.name ? p.name : ''; }

/** Names are private (Settings > Privacy): toasts and labels say less. */
const ftPrivate = () => document.body.classList.contains('pm-names');

/** The toast after two or more people became one. */
function ftTogether(p) {
  if (ftPrivate()) return 'Put together.';
  return p && p.name ? `Put together under ${p.name}.` : 'Put together as one person.';
}

/** Same call shape as facesApi; 409 bodies ride along on err.data. */
async function ftApi(url, opts) {
  try { return await facesApi(url, opts); }
  catch (err) {
    // People routes answer 404 for a person merged away or emptied meanwhile.
    if (err.status === 404 && /\/api\/faces\/(people|review)/.test(url)) err.message = 'That person is no longer in Faces. Refresh to see the latest.';
    throw err;
  }
}

function ftCropImg(url, cls = '') {
  return url ? `<img class="face-crop ${cls}" src="${ftEsc(url)}" alt="" loading="lazy" draggable="false">`
    : `<span class="ft-blank ${cls}" aria-hidden="true">👤</span>`;
}

/* ── Tab hooks ─────────────────────────────────────────────────────────── */

function facesHomeShowing() {
  if (!ftOnTab()) return false;
  if (FT.mode === 'studios') return typeof studiosOpenId !== 'function' || studiosOpenId() == null;
  return FT.personId == null;
}

/** onlyIds + rankedIds for an open person, or null. */
function facesPersonQuery() {
  if (!ftOnTab() || FT.mode !== 'people' || FT.personId == null) return null;
  const ids = FT.fileIds || [];
  const n = ids.length;
  return { onlyIds: ids.slice(), rankedIds: ids.map((id, i) => ({ id, score: n - i })) };
}

function facesTabEnter() {
  const main = document.getElementById('mainContainer');
  main?.classList.add('faces-on');
  const view = ftView();
  if (view) view.hidden = false;
  ftApplyMode();
  if (FT.personId != null) ftRenderPerson();
  else ftRenderHome();
  facesRefreshStatus({ background: true });
  facesHeaderCount();
  ftPoll();
}

function facesTabLeave() {
  ftCloseNaming();
  ftUnpin();
  ftClosePops();
  if (typeof stClosePops === 'function') stClosePops();
  document.getElementById('mainContainer')?.classList.remove('faces-on', 'faces-home', 'faces-person', 'faces-studio');
  const view = ftView();
  if (view) view.hidden = true;
  ftPaintSelBar();
  clearTimeout(FT.pollTimer);
  FT.pollTimer = null;
  if (typeof renderLibraryCount === 'function') renderLibraryCount();
}

function ftApplyMode() {
  const main = document.getElementById('mainContainer');
  if (!main) return;
  const studios = FT.mode === 'studios';
  const studio = studios && typeof studiosOpenId === 'function' && studiosOpenId() != null;
  const person = !studios && FT.personId != null && facesReady();
  main.classList.toggle('faces-home', !person && !studio);
  main.classList.toggle('faces-person', person);
  main.classList.toggle('faces-studio', studio);
}

/** People | Studios, at the start of both views' top row. */
function ftModeSegHtml() {
  const b = (m, label) => `<button type="button" class="${FT.mode === m ? 'on' : ''}" data-ft-mode="${m}" aria-pressed="${FT.mode === m}">${label}</button>`;
  return `<span class="ft-mode" role="group" aria-label="Show">${b('people', 'People')}${b('studios', 'Studios')}</span>`;
}

/** Flip the switch: nothing stays open on either side. */
function ftSetMode(mode) {
  if (FT.mode === mode) return;
  ftCloseNaming();
  ftClosePops();
  ftUnpin();
  ftFlipStop();
  if (typeof studiosReset === 'function') studiosReset();
  FT.mode = mode;
  try { localStorage.setItem('vaultFacesMode', mode); } catch {}
  FT.personId = null; FT.person = null; FT.fileIds = null; FT.fileInfo = {};
  ftPaintSelBar();
  ftRenderHome();
  applyFilters();
  if (!facesHeaderCount() && typeof renderLibraryCount === 'function') renderLibraryCount();
  ftPoll();
  document.querySelector(`#facesView [data-ft-mode="${mode}"]`)?.focus();
}

/** faces.js calls this after every status answer. */
function facesTabStatusChanged(readyFlipped) {
  if (!ftOnTab() || FT.mode === 'studios') return;   // Studios do not need face search
  if (readyFlipped) {
    ftApplyMode();
    if (FT.personId != null && facesReady()) ftRenderPerson();
    else ftRenderHome();
    if (typeof applyFilters === 'function') applyFilters();
    return;
  }
  if (!facesReady()) {
    // Off (or still setting up): the intro card follows the switch.
    const view = ftView();
    if (view) view.innerHTML = ftOffViewHtml();
    return;
  }
  if (FT.personId == null) {
    ftPaintStrip();
    const s = facesStatus || {};
    const c = s.counts || {};
    const key = `${c.indexed || 0}|${s.people ? s.people.total : ''}|${c.people || 0}`;
    if (FT.lastCounts != null && FT.lastCounts !== key) ftReloadSoon();
    FT.lastCounts = key;
  }
  ftPoll();
}

let ftReloadTimer = null;
function ftReloadSoon() {
  clearTimeout(ftReloadTimer);
  ftReloadTimer = setTimeout(() => { ftLoadPeople(); ftLoadReview(); }, 400);
}

/** Poll while something is moving and the home is on screen. */
function ftPoll() {
  clearTimeout(FT.pollTimer);
  FT.pollTimer = null;
  if (!ftOnTab() || FT.mode !== 'people' || FT.personId != null || !facesReady()) return;
  const s = facesStatus || {};
  const moving = (s.queue && s.queue.running) || (s.people && s.people.sorting);
  if (!moving) return;
  FT.pollTimer = setTimeout(() => { FT.pollTimer = null; if (ftOnTab()) facesRefreshStatus(); }, 3000);
}

/* ── Off: before face search is turned on ──────────────────────────────── */

function ftOffHtml() {
  const s = facesStatus;
  if (!s) return '<div class="ft-off-wait"></div>';
  const head = (stroke, face, size) => `<svg width="${size}" height="${size}" viewBox="0 0 72 72"><circle cx="36" cy="36" r="34" fill="#252525" stroke="${stroke}" stroke-width="2"></circle><circle cx="36" cy="29" r="11" fill="none" stroke="${face}" stroke-width="2.5"></circle><path d="M16 58c3-10 11-15 20-15s17 5 20 15" fill="none" stroke="${face}" stroke-width="2.5"></path></svg>`;
  // Turned on, models still coming: the same card, pointing at the setup.
  const setup = s.enabled && !s.modelsReady;
  return `
    <div class="ft-off">
      <section class="ft-empty">
        <div class="ft-heads" aria-hidden="true">${head('#333', '#666', 72)}${head('#6366f1', '#a0a0a0', 92)}${head('#333', '#666', 72)}</div>
        <h1>See everyone in your library</h1>
        <ul>
          <li>Every person Vault finds gets a card here.</li>
          <li>Give them a name, and open their card to see every file they are in.</li>
          <li>Search with a photo, or pause a video and find who is on screen.</li>
        </ul>
        <button class="ft-btn ft-btn-lg" type="button" data-ft-turnon>${setup ? 'Finish setting up face search' : 'Turn on face search'}</button>
        <p class="ft-small">Runs entirely on this computer. Nothing is uploaded. Vault downloads two small models (about 39 MB) once.</p>
      </section>
    </div>`;
}

/** The Off card with the People | Studios switch above it. */
function ftOffViewHtml() {
  return `<div class="ft-mode-row">${ftModeSegHtml()}</div>${ftOffHtml()}`;
}

/** Settings > Face search, then the same switch + consent flow as the toggle. */
async function ftTurnOn() {
  if (typeof window.vaultOpenSettings !== 'function') return;
  window.vaultOpenSettings('faces');
  const s = facesStatus;
  if (s && s.enabled) return;   // only the setup is left: the section shows it
  const cb = document.querySelector('#facesSettings [data-faces-setting="enabled"]');
  if (!cb || cb.checked) return;
  cb.checked = true;
  await facesToggleEnabled(cb);
}

/* ── Home ──────────────────────────────────────────────────────────────── */

function ftRenderHome() {
  const view = ftView();
  if (!view) return;
  ftApplyMode();
  if (FT.mode === 'studios') { studiosRender(); ftPaintSelBar(); return; }
  if (!facesReady()) {
    view.innerHTML = ftOffViewHtml();
    ftPaintSelBar();
    return;
  }
  if (!view.querySelector('.ft-home')) {
    view.innerHTML = `
      <div class="ft-home">
        <section class="ft-panel">
          <div class="ft-row">
            ${ftModeSegHtml()}
            <label class="ft-search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
              <input type="text" id="ftSearch" placeholder="Search people by name" aria-label="Search people by name" autocomplete="off">
            </label>
            <button class="ft-pill" type="button" id="ftSortBtn" aria-haspopup="menu"></button>
          </div>
          <div class="ft-row ft-chips" id="ftChips" role="group" aria-label="Show"></div>
        </section>
        <div class="ft-checking" id="ftStrip" hidden></div>
        <section class="ft-review" id="ftReview" aria-label="Same person?" hidden></section>
        <div class="ft-grid" id="ftGrid"></div>
        <div class="ft-more-row" id="ftMoreRow" hidden><button class="ft-btn ghost" type="button" data-ft-showmore>Show more people</button></div>
      </div>`;
    view.querySelector('#ftSearch').value = FT.q;
  }
  ftPaintSort();
  ftPaintChips();
  ftPaintStrip();
  ftPaintReview();
  ftPaintGrid();
  ftLoadPeople();
  ftLoadReview();
}

function ftPaintSort() {
  const b = document.getElementById('ftSortBtn');
  if (b) b.textContent = `Sort: ${FT_SORTS.find(s => s.value === FT.sort).label} ▾`;
}

function ftPaintChips() {
  const host = document.getElementById('ftChips');
  if (!host) return;
  const c = FT.counts || {};
  host.innerHTML = FT_FILTERS.map(f => `<button class="ft-chip${FT.filter === f.value ? ' on' : ''}" type="button"
    data-ft-filter="${f.value}" aria-pressed="${FT.filter === f.value}">${f.label}<b>${c[f.value] != null ? Number(c[f.value]).toLocaleString() : ''}</b></button>`).join('');
}

/** "Still checking your library", or the unchecked files, or nothing. */
function ftPaintStrip() {
  const el = document.getElementById('ftStrip');
  if (!el) return;
  const s = facesStatus || {};
  const c = s.counts || {};
  const q = s.queue || {};
  const eligible = c.eligible || 0;
  const indexed = Math.min(c.indexed || 0, eligible);
  const left = Math.max(0, eligible - indexed);
  // While a run goes, its own progress: the same numbers as the scan panel.
  const runDone = (q.done || 0) + (q.failed || 0);
  const runTotal = q.total || 0;
  const ofText = `<b>${runDone.toLocaleString()} of ${runTotal.toLocaleString()}</b>`;
  const runBar = `<span class="ft-bar"><span class="ft-fill" style="width:${runTotal ? Math.min(100, (runDone / runTotal) * 100) : 0}%"></span></span>`;
  let html = '';
  if (q.running && q.paused) {
    html = `<span>Checking is paused: ${ofText} files checked.</span>
      ${runBar}
      <button type="button" class="ft-link" data-ft-queue="resume">Resume</button>`;
  } else if (q.running) {
    html = `<span>Still checking: ${ofText} files. More people will show up as they are found.</span>
      ${runBar}
      <button type="button" class="ft-link" data-ft-queue="pause">Pause</button>`;
  } else if (s.people && s.people.sorting) {
    html = '<span>Sorting faces into people. More people will show up in a moment.</span>';
  } else if (left) {
    html = `<span><b>${left.toLocaleString()}</b> ${left === 1 ? 'photo or video has' : 'photos and videos have'} not been checked yet.</span>
      <button type="button" class="ft-link" data-ft-queue="all">Find faces in the rest</button>`;
  }
  el.hidden = !html;
  if (el.innerHTML !== html) el.innerHTML = html;
}

async function ftQueue(act) {
  try {
    if (act === 'all') await ftApi('/api/faces/index', { method: 'POST', json: { all: true } });
    else await ftApi(`/api/faces/queue/${act}`, { method: 'POST' });
  } catch (err) { facesToastError(err); }
  if (act === 'all') facesScanStarted();
  else await facesRefreshStatus();
}

async function ftLoadPeople() {
  if (!facesReady()) return;
  const seq = ++FT.seq;
  const qs = new URLSearchParams({ filter: FT.filter, sort: FT.sort, q: FT.q, offset: '0', limit: String(FT.limit) });
  let r;
  try { r = await ftApi(`/api/faces/people?${qs}`, { background: true }); }
  catch (err) { if (seq === FT.seq && !FT.loaded) facesToastError(err); return; }
  if (seq !== FT.seq) return;
  FT.people = r.people || [];
  FT.total = r.total || 0;
  FT.counts = r.counts || {};
  FT.loaded = true;
  // Selected people keep their latest numbers (the merge label reads them).
  for (const p of FT.people) if (FT.sel.has(p.id)) FT.sel.set(p.id, p);
  // A kept person the list has again needs no keeping; one it lacks may have
  // been merged away, hidden or emptied meanwhile.
  if (FT.pin && FT.people.some(p => p.id === FT.pin.id)) FT.pin = null;
  else if (FT.pin) ftCheckPin();
  ftPaintChips();
  ftPaintGrid();
  ftPaintSelBar();
  facesHeaderCount();
}

/** "18 people" in the header while the tab is showing; database.js asks first. */
function facesHeaderCount() {
  if (ftOnTab() && FT.mode === 'studios') return typeof studiosHeaderCount === 'function' && studiosHeaderCount();
  if (!ftOnTab() || !facesReady() || !FT.counts) return false;
  const el = document.getElementById('totalCount');
  if (el) el.textContent = ftPlural(Number(FT.counts.all || 0), 'person', 'people');
  return true;
}

async function ftLoadReview() {
  if (!facesReady()) return;
  try { FT.review = await ftApi('/api/faces/review?limit=3', { background: true }); }
  catch { return; }
  ftPaintReview();
}

function ftEmptyText() {
  if (FT.q) return `No one called "${ftEsc(FT.q)}".`;
  const c = FT.counts || {};
  switch (FT.filter) {
    case 'named': return 'No one has a name yet. Click Add a name under a face.';
    case 'unnamed': return 'Everyone has a name.';
    case 'favorites': return 'No favorites yet. Open a person and click ★ Favorite.';
    case 'single': return 'Everyone here shows up in more than one file.';
    case 'hidden': return 'No one is hidden.';
    default: return c.hidden ? 'Everyone found so far is hidden.'
      : 'No people yet. They show up here as Vault finds faces in your photos and videos.';
  }
}

function ftTileHtml(p) {
  const sel = FT.sel.has(p.id);
  const name = ftName(p);
  return `
    <article class="ft-tile${sel ? ' ft-sel' : ''}${p.hidden ? ' ft-hidden' : ''}" data-person="${p.id}" tabindex="0"
      aria-label="${name ? ftEsc(name) : 'Not named yet'}">
      <div class="ft-thumb">
        ${ftCropImg(p.coverUrl, 'ft-img')}
        ${p.favorite ? '<span class="ft-star" aria-label="Favorite"><svg width="13" height="13" viewBox="0 0 24 24" fill="#facc15" aria-hidden="true"><path d="M12 2l3 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.4 21.7l1.8-7.3L1.5 9.5 9 8.9z"></path></svg></span>' : ''}
        <button class="ft-check" type="button" aria-label="Select" aria-pressed="${sel}" title="Select (shift-click for a range)">${sel ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>' : ''}</button>
        <span class="ft-scrub-cap" hidden></span>
        <span class="ft-scrub" hidden></span>
      </div>
      ${name ? `<div class="ft-name" title="${ftEsc(name)}">${ftEsc(name)}</div>`
        : `<button class="ft-addname" type="button" data-ft-addname="${p.id}">Add a name</button>`}
      <div class="ft-meta">${ftBadges(p).map(b => `<span class="ft-badge">${ftEsc(b)}</span>`).join('')}</div>
    </article>`;
}

function ftPaintGrid() {
  const grid = document.getElementById('ftGrid');
  if (!grid) return;
  if (FT.naming && FT.naming.inGrid) { FT.gridDirty = true; return; }
  FT.gridDirty = false;
  const size = typeof window.vaultCardSize === 'function' ? window.vaultCardSize() : 'M';
  grid.style.setProperty('--ft-min', `${FT_CARD_MIN[size] || 170}px`);
  if (!FT.loaded) { grid.innerHTML = ''; return; }
  const list = FT.pin && !FT.people.some(p => p.id === FT.pin.id) ? [FT.pin, ...FT.people] : FT.people;
  grid.innerHTML = list.length ? list.map(ftTileHtml).join('')
    : `<div class="ft-none">${ftEmptyText()}</div>`;
  const more = document.getElementById('ftMoreRow');
  if (more) more.hidden = FT.people.length >= FT.total;
}

/* ── "Same person?" strip + dialog ─────────────────────────────────────── */

function ftPairSide(p) {
  const name = ftName(p);
  return `<div class="ft-f2">${ftCropImg(p.coverUrl)}<div class="${name ? 'ft-pname' : 'ft-pname ft-muted'}">${name ? ftEsc(name) : 'Not named yet'}</div></div>`;
}

function ftPaintReview() {
  const el = document.getElementById('ftReview');
  if (!el) return;
  const r = FT.review || {};
  const pairs = r.pairs || [];
  el.hidden = !pairs.length;
  if (!pairs.length) { el.innerHTML = ''; return; }
  const n = r.total || pairs.length;
  el.innerHTML = `
    <div class="ft-review-h"><h2>Same person?</h2><span>${n.toLocaleString()} to look at. Saying yes puts their files together.</span>
      <button type="button" class="ft-link" data-ft-reviewall>Review all</button></div>
    <div class="ft-pairs">${pairs.slice(0, 3).map(pr => `
      <div class="ft-pair" data-a="${pr.a.id}" data-b="${pr.b.id}">
        <div class="ft-faces2">${ftPairSide(pr.a)}${ftPairSide(pr.b)}</div>
        <div class="ft-qa"><span>Same person?</span>
          <button class="ft-btn" type="button" data-ft-answer="same">Yes</button>
          <button class="ft-btn ghost" type="button" data-ft-answer="different">No</button></div>
      </div>`).join('')}</div>`;
}

/** Send a review answer. @returns the toast text, or null when it failed. */
async function ftAnswer(a, b, answer) {
  let r;
  try { r = await ftApi('/api/faces/review', { method: 'POST', json: { a, b, answer } }); }
  catch (err) { facesToastError(err); return null; }
  FT.faces.delete(a); FT.faces.delete(b);
  return answer === 'same' ? ftTogether(r && r.person) : 'Got it. They stay separate.';
}

let ftDlg = null;   // { pairs, i, total, changed, opener }

async function ftOpenReview() {
  const opener = document.activeElement;
  let r;
  try { r = await ftApi('/api/faces/review?limit=200'); } catch (err) { facesToastError(err); return; }
  if (!r.pairs || !r.pairs.length) { showToast('Nothing to look at right now.'); return; }
  ftDlg = { pairs: r.pairs, i: 0, total: r.total || r.pairs.length, changed: false, opener };
  const ov = document.createElement('div');
  ov.className = 'ft-overlay';
  ov.id = 'ftReviewDlg';
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) ftCloseReview(); });
  // Keep Tab inside the dialog while it is open.
  ov.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...ov.querySelectorAll('button:not(:disabled)')];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !ov.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !ov.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  document.body.appendChild(ov);
  ftPaintDialog();
}

function ftPaintDialog(toast) {
  const ov = document.getElementById('ftReviewDlg');
  if (!ov || !ftDlg) return;
  const pr = ftDlg.pairs[ftDlg.i];
  if (!pr) {
    ftCloseReview();
    showToast(toast ? `${toast} That was the last one.` : 'That was the last one.');
    return;
  }
  if (toast) showToast(toast);
  const col = (p, sample) => {
    const name = ftName(p);
    const kinds = [p.videos ? ftPlural(p.videos, 'video', 'videos') : '', p.photos ? ftPlural(p.photos, 'photo', 'photos') : ''].filter(Boolean).join(', ');
    return `<div class="ft-col">
      ${ftCropImg(p.coverUrl, 'ft-big')}
      <div class="${name ? 'ft-who' : 'ft-who ft-muted'}">${name ? ftEsc(name) : 'Not named yet'}</div>
      <div class="ft-sub">${ftPlural(p.files, 'file', 'files')}${kinds ? ` · ${kinds}` : ''}</div>
      <div class="ft-files">${(sample || []).slice(0, 3).map(id => `<img class="ft-file tile-img" src="/thumb/${id}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`).join('')}</div>
    </div>`;
  };
  const named = pr.a.name ? pr.a : pr.b.name ? pr.b : null;
  const nm = named && `<span class="ft-pm-name">${ftEsc(named.name)}</span>`;
  const hint = named
    ? `Yes puts their files together under ${nm}. You can split them again from ${nm}'s page.`
    : 'Yes puts their files together. You can split them again from their page.';
  ov.innerHTML = `
    <div class="ft-dlg" role="dialog" aria-modal="true" aria-label="Same person?">
      <div class="ft-dlg-h"><h2>Same person?</h2><span>${(ftDlg.i + 1).toLocaleString()} of ${ftDlg.total.toLocaleString()}</span>
        <button type="button" class="ft-x" data-ft-dlg="close" aria-label="Close">×</button></div>
      <div class="ft-cols">${col(pr.a, pr.sample && pr.sample.a)}${col(pr.b, pr.sample && pr.sample.b)}</div>
      <div class="ft-dlg-acts">
        <button class="ft-btn ft-btn-md" type="button" data-ft-dlg="same">Yes, same person</button>
        <button class="ft-btn ghost ft-btn-md" type="button" data-ft-dlg="different">No, different people</button>
        <button class="ft-btn ghost ft-btn-md" type="button" data-ft-dlg="skip">Not sure, skip</button>
        <button type="button" class="ft-link" data-ft-dlg="close">Done for now</button>
      </div>
      <div class="ft-hint">${hint}</div>
    </div>`;
  ov.querySelector('[data-ft-dlg="same"]').focus();
  ov.querySelectorAll('[data-ft-dlg]').forEach(b => b.addEventListener('click', async () => {
    const act = b.dataset.ftDlg;
    if (act === 'close') { ftCloseReview(); return; }
    let said = '';
    if (act !== 'skip') {
      ov.querySelectorAll('button').forEach(x => { x.disabled = true; });
      said = await ftAnswer(pr.a.id, pr.b.id, act);
      if (said == null) { ftPaintDialog(); return; }
      ftDlg.changed = true;
      // A merged person can sit in later pairs too: those pairs are stale now.
      if (act === 'same') {
        const gone = new Set([pr.a.id, pr.b.id]);
        ftDlg.pairs = ftDlg.pairs.filter((x, j) => j <= ftDlg.i || !(gone.has(x.a.id) || gone.has(x.b.id)));
      }
    }
    ftDlg.i++;
    ftPaintDialog(said);
  }));
}

function ftCloseReview() {
  document.getElementById('ftReviewDlg')?.remove();
  const changed = ftDlg && ftDlg.changed;
  const opener = ftDlg && ftDlg.opener;
  ftDlg = null;
  if (changed) ftLoadPeople();
  // Back where the dialog was opened from. The strip redraws (or goes away
  // with the last pair), so look again once it has.
  const back = () => {
    const el = opener && opener.isConnected && opener.offsetParent ? opener
      : document.querySelector('#ftReview:not([hidden]) [data-ft-reviewall]') || document.getElementById('ftSearch');
    el?.focus();
  };
  back();
  ftLoadReview().then(back);
}

/* ── Hover flip-through ────────────────────────────────────────────────── */

let ftFlip = null;   // { tile, timer, i, faces }

async function ftFacesOf(id) {
  if (FT.faces.has(id)) return FT.faces.get(id);
  const p = ftApi(`/api/faces/people/${id}/faces?limit=8`, { background: true }).catch(() => []);
  FT.faces.set(id, p);
  const faces = await p;
  FT.faces.set(id, faces);
  return faces;
}

function ftFlipStart(tile) {
  if (ftFlip && ftFlip.tile === tile) return;
  ftFlipStop();
  const id = Number(tile.dataset.person);
  const me = { tile, timer: null, i: 0, faces: null };
  ftFlip = me;
  me.timer = setTimeout(async () => {
    const faces = await ftFacesOf(id);
    if (ftFlip !== me || !faces || faces.length < 2) return;
    me.faces = faces;
    const cap = tile.querySelector('.ft-scrub-cap');
    const bar = tile.querySelector('.ft-scrub');
    bar.innerHTML = faces.map(() => '<i></i>').join('');
    cap.hidden = false;
    bar.hidden = false;
    const step = () => {
      if (ftFlip !== me) return;
      const img = tile.querySelector('.ft-img');
      if (img) img.src = faces[me.i].cropUrl;
      cap.textContent = `${me.i + 1} of ${faces.length} files`;
      bar.querySelectorAll('i').forEach((x, j) => x.classList.toggle('on', j === me.i));
      me.i = (me.i + 1) % faces.length;
      me.timer = setTimeout(step, FT_FLIP_MS);
    };
    step();
  }, 200);
}

function ftFlipStop() {
  if (!ftFlip) return;
  const { tile, timer } = ftFlip;
  clearTimeout(timer);
  ftFlip = null;
  const p = FT.people.find(x => x.id === Number(tile.dataset.person));
  const img = tile.querySelector('.ft-img');
  if (img && p) img.src = p.coverUrl;
  tile.querySelector('.ft-scrub-cap')?.setAttribute('hidden', '');
  tile.querySelector('.ft-scrub')?.setAttribute('hidden', '');
}

/* ── Naming (tiles and the person header) ──────────────────────────────── */

/**
 * Open a name field in `host` for person `id`. Suggests existing names;
 * picking one asks "X is already in Faces. Same person?".
 * onDone(person|null) runs after a save (null = cancelled).
 *
 * The face results banner (faces.js) uses the same field for a face that may
 * not be anyone yet: `id` is then null (no one to leave out of the
 * suggestions), `me` is the face shown in the same-person question, and
 * `save(name, mergeIfTaken)` does the saving (it answers the person, or
 * throws NAME_TAKEN with data.other, like the people route does). onClose()
 * runs whenever the field closes (saved, cancelled or clicked away from).
 */
function ftStartNaming({ host, anchor, id, initial = '', inGrid = false, onDone, save = null, me = null, onClose = null }) {
  ftCloseNaming();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ft-field';
  input.value = initial;
  input.placeholder = 'Add a name';
  input.setAttribute('aria-label', 'Name');
  input.setAttribute('autocomplete', 'off');
  const drop = document.createElement('div');
  drop.className = 'ft-drop';
  drop.setAttribute('role', 'listbox');
  drop.setAttribute('aria-label', 'Names');
  drop.hidden = true;
  const replaced = anchor;
  anchor.replaceWith(input);
  host.appendChild(drop);
  host.classList.add('ft-naming');
  const nm = { id, host, input, drop, replaced, opts: [], hi: 0, seq: 0, inGrid, onDone, note: '', initial, save, me, onClose };
  FT.naming = nm;

  const refresh = debounce(() => ftNameOptions(nm), 120);
  input.addEventListener('input', () => { nm.note = ''; nm.ask = null; refresh(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); ftCloseNaming(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!nm.opts.length) return;
      nm.hi = (nm.hi + (e.key === 'ArrowDown' ? 1 : -1) + nm.opts.length) % nm.opts.length;
      ftPaintDrop(nm);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!input.value.trim()) {
        // Clearing an existing name takes the person back to "not named yet".
        if (initial) ftSaveName(nm, '');
        else ftCloseNaming();
        return;
      }
      const v = input.value.trim();
      if (initial && v === initial.trim()) { ftCloseNaming(); return; }   // unchanged
      // Typed faster than the suggestions came back: save what was typed (a
      // name someone else has still comes back as NAME_TAKEN and asks).
      if (nm.optsFor !== v) { ftSaveName(nm, v); return; }
      if (nm.opts[nm.hi]) ftPickOption(nm, nm.opts[nm.hi]);
    }
  });
  drop.addEventListener('mousedown', (e) => e.preventDefault());   // keep the focus in the field
  drop.addEventListener('click', (e) => {
    const o = e.target.closest('[data-opt]');
    if (o) { ftPickOption(nm, nm.opts[Number(o.dataset.opt)]); return; }
    const ask = e.target.closest('[data-ask]');
    if (!ask) return;
    if (ask.dataset.ask === 'yes') ftSaveName(nm, nm.askName, true);
    else {
      nm.ask = null;
      nm.note = 'Try a different name for this person.';
      ftPaintDrop(nm);
      input.focus();
      input.select();
    }
  });
  input.focus();
  input.select();
  if (initial) ftNameOptions(nm);
}

async function ftNameOptions(nm) {
  const v = nm.input.value.trim();
  if (nm.saving || nm.ask) return;   // a save or the same-person question has the box
  const seq = ++nm.seq;
  if (!v) { nm.opts = []; ftPaintDrop(nm); return; }
  let list = [];
  try {
    const qs = new URLSearchParams({ filter: 'named', q: v, sort: 'name', limit: '5' });
    list = ((await ftApi(`/api/faces/people?${qs}`, { background: true })).people || []).filter(p => p.id !== nm.id);
  } catch {}
  if (seq !== nm.seq || FT.naming !== nm) return;
  const same = (x) => x && x.trim().toLowerCase() === v.toLowerCase();
  // An exact match, or the current name unchanged: no 'new name' option.
  const exact = list.some(p => same(p.name)) || (nm.initial && v === nm.initial.trim());
  nm.opts = list.map(p => ({ person: p })).concat(exact ? [] : [{ name: v }]);
  nm.optsFor = v;
  nm.hi = 0;
  nm.ask = null;
  ftPaintDrop(nm);
}

function ftPaintDrop(nm) {
  const d = nm.drop;
  if (nm.ask) {
    const me = nm.me || (FT.person && FT.person.id === nm.id ? FT.person : FT.people.find(p => p.id === nm.id)) || {};
    d.className = 'ft-ask';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'Same person?');
    d.innerHTML = `
      <div class="ft-ask-faces">${ftCropImg(me.coverUrl)}<span aria-hidden="true">+</span>${ftCropImg(nm.ask.coverUrl)}</div>
      <p><b>${ftEsc(nm.ask.name)}</b> is already in Faces. Same person?</p>
      <div class="ft-ask-acts"><button class="ft-btn" type="button" data-ask="yes">Yes, put them together</button>
        <button class="ft-btn ghost" type="button" data-ask="no">No, someone else</button></div>`;
    d.hidden = false;
    d.querySelector('[data-ask="yes"]').focus();
    return;
  }
  d.className = 'ft-drop';
  d.setAttribute('role', 'listbox');
  d.setAttribute('aria-label', 'Names');
  const items = nm.opts.map((o, i) => o.person
    ? `<button class="ft-opt${i === nm.hi ? ' hi' : ''}" type="button" role="option" aria-selected="${i === nm.hi}" data-opt="${i}">${ftCropImg(o.person.coverUrl)}${ftEsc(o.person.name)}<span>${ftPlural(o.person.files, 'file', 'files')}</span></button>`
    : `<button class="ft-opt${i === nm.hi ? ' hi' : ''}" type="button" role="option" aria-selected="${i === nm.hi}" data-opt="${i}"><span class="ft-plus" aria-hidden="true">+</span>${nm.initial ? `Rename to "${ftEsc(o.name)}"` : `New person called "${ftEsc(o.name)}"`}</button>`).join('');
  d.innerHTML = (nm.note ? `<div class="ft-drop-note">${nm.note}</div>` : '') + items;
  d.hidden = !items && !nm.note;
}

function ftPickOption(nm, o) {
  if (!o) return;
  if (o.person) { nm.seq++; nm.ask = o.person; nm.askName = o.person.name; ftPaintDrop(nm); return; }
  ftSaveName(nm, o.name);
}

async function ftSaveName(nm, name, mergeIfTaken = false) {
  nm.seq++;   // suggestions still on their way must not paint over what comes next
  nm.saving = true;
  let p;
  try {
    p = nm.save ? await nm.save(name, mergeIfTaken)
      : await ftApi(`/api/faces/people/${nm.id}`, { method: 'POST', json: mergeIfTaken ? { name, mergeIfTaken: true } : { name } });
  } catch (err) {
    nm.saving = false;
    if (err.code === 'NAME_TAKEN' && err.data && err.data.other) {
      if (FT.naming !== nm) return;
      nm.ask = err.data.other;
      nm.askName = err.data.other.name || name;
      ftPaintDrop(nm);
      return;
    }
    facesToastError(err);
    return;
  }
  if (FT.naming !== nm) return;
  ftCloseNaming();
  if (nm.id != null) FT.faces.delete(nm.id);
  if (p && p.id != null) FT.faces.delete(p.id);
  if (mergeIfTaken) showToast(ftTogether(p));
  if (nm.onDone) nm.onDone(p, { merged: mergeIfTaken });
}

function ftCloseNaming() {
  const nm = FT.naming;
  if (!nm) return;
  FT.naming = null;
  nm.drop.remove();
  nm.host.classList.remove('ft-naming');
  if (nm.input.isConnected) nm.input.replaceWith(nm.replaced);
  if (nm.inGrid && FT.gridDirty) ftPaintGrid();
  if (nm.onClose) nm.onClose();
}

/* ── Selection, merge, hide ────────────────────────────────────────────── */

function ftToggleSel(id, { range = false } = {}) {
  const ids = FT.people.map(p => p.id);
  const byId = new Map(FT.people.map(p => [p.id, p]));
  if (FT.pin && !byId.has(FT.pin.id)) byId.set(FT.pin.id, FT.pin);
  if (range && FT.anchor != null && ids.includes(FT.anchor) && ids.includes(id)) {
    const [a, b] = [ids.indexOf(FT.anchor), ids.indexOf(id)].sort((x, y) => x - y);
    for (let i = a; i <= b; i++) FT.sel.set(ids[i], byId.get(ids[i]));
  } else if (FT.sel.has(id)) FT.sel.delete(id);
  else FT.sel.set(id, byId.get(id));
  FT.anchor = id;
  ftPaintGrid();
  ftPaintSelBar();
}

function ftClearSel() {
  FT.sel.clear();
  FT.anchor = null;
  ftPaintGrid();
  ftPaintSelBar();
}

/** The person a merge keeps: a named one, else the one with the most files. */
function ftMergeTarget(list) {
  const by = (a, b) => (b.files || 0) - (a.files || 0);
  const named = list.filter(p => p && p.name).sort(by);
  return named[0] || list.filter(Boolean).sort(by)[0];
}

function ftPaintSelBar() {
  let bar = document.getElementById('ftSelBar');
  const show = ftOnTab() && FT.mode === 'people' && FT.personId == null && facesReady() && FT.sel.size > 0;
  if (!show) { if (bar) bar.classList.remove('visible'); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ftSelBar';
    bar.className = 'ft-selbar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Selected people');
    document.body.appendChild(bar);
    bar.addEventListener('click', ftSelBarClick);
  }
  const list = [...FT.sel.values()];
  const n = list.length;
  const target = ftMergeTarget(list);
  const allHidden = list.every(p => p && p.hidden);
  bar.innerHTML = `
    <b>${ftPlural(n, 'person', 'people')} selected</b>
    ${n >= 2 ? `<button class="ft-sbtn primary" type="button" data-ft-sel="merge">${target && target.name ? `Merge into <span class="ft-pm-name">${ftEsc(target.name)}</span>` : 'Merge into one person'}</button>` : ''}
    <button class="ft-sbtn" type="button" data-ft-sel="${allHidden ? 'unhide' : 'hide'}">${allHidden ? 'Unhide' : 'Hide'}</button>
    <button class="ft-sbtn" type="button" data-ft-sel="notface">Not a face</button>
    <button class="ft-sbtn quiet" type="button" data-ft-sel="clear">Clear</button>`;
  bar.classList.add('visible');
}

async function ftSelBarClick(e) {
  const b = e.target.closest('[data-ft-sel]');
  if (!b) return;
  const act = b.dataset.ftSel;
  if (act === 'clear') { ftClearSel(); return; }
  const list = [...FT.sel.values()].filter(Boolean);
  if (act === 'notface') {
    if (!await ftNotAFace(list)) return;
    FT.sel.clear();
    ftUnpin();
    ftPaintSelBar();
    ftLoadPeople();
    ftLoadReview();
    return;
  }
  if (act === 'merge') {
    if (list.length > 50) { showToast('Merge up to 50 people at a time.'); return; }
    const target = ftMergeTarget(list);
    b.disabled = true;
    let merged;
    try {
      merged = await ftApi('/api/faces/people/merge', { method: 'POST', json: { ids: list.map(p => p.id), into: target.id } });
    } catch (err) { facesToastError(err); b.disabled = false; return; }
    list.forEach(p => FT.faces.delete(p.id));
    FT.sel.clear();
    showToast(ftTogether(merged));
    ftPaintSelBar();
    ftLoadReview();
    ftUnpin();
    await ftLoadPeople();
    const id = merged && merged.id != null ? merged.id : target.id;
    const tile = ftRevealTile(id, merged);
    // No one had a name: ask for one now, while the person is in front of
    // them, rather than leaving a new "Not named yet" somewhere in the grid.
    if (!target.name && tile && !FT.naming) {
      ftAskName({
        box: tile, crop: tile.querySelector('.ft-thumb'), id, me: merged, inGrid: true,
        onDone: (p, how) => ftNamedAfterMerge(p || merged, how),
        focusBack: () => document.querySelector(`#ftGrid .ft-tile[data-person="${id}"]`),
      });
    }
    return;
  }
  const hidden = act === 'hide';
  const ids = list.map(p => p.id);
  if (!await ftSetHidden(ids, hidden)) return;
  FT.sel.clear();
  ftUnpin();
  ftPaintSelBar();
  ftLoadPeople();
  if (hidden) {
    showUndoToast(`Hid ${ftPlural(ids.length, 'person', 'people')}. You can find them under Hidden.`, async () => {
      await ftSetHidden(ids, false);
      ftLoadPeople();
    }, 8000);
  } else showToast(`${ftPlural(ids.length, 'person is', 'people are')} back in Everyone.`);
}

async function ftSetHidden(ids, hidden) {
  try {
    for (const id of ids) await ftApi(`/api/faces/people/${id}`, { method: 'POST', json: { hidden } });
    return true;
  } catch (err) { facesToastError(err); ftLoadPeople(); return false; }
}

/* ── After a merge: keep the person in view, ask who it is ────────────── */

/**
 * Scroll person `id`'s tile into view and flash it. A person the list no
 * longer has (the filter hides them now, or they sit past the loaded page)
 * stays pinned at the front of the grid until the view changes (filter, sort,
 * search, leaving the tab), so what was just done never seems to vanish.
 * @returns {Element|null} the tile
 */
function ftRevealTile(id, person) {
  const grid = document.getElementById('ftGrid');
  if (!grid) return null;
  if (!FT.people.some(p => p.id === id)) {
    if (person && person.id === id) { FT.pin = person; ftPaintGrid(); }
  } else if (FT.pin && FT.pin.id === id) {
    FT.pin = null;
    ftPaintGrid();
  }
  const tile = grid.querySelector(`.ft-tile[data-person="${id}"]`);
  if (!tile) return null;
  tile.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  tile.classList.remove('ft-flash');
  void tile.offsetWidth;   // restart the animation
  tile.classList.add('ft-flash');
  return tile;
}

/** The view changed: a pinned person goes back to following the filter. */
function ftUnpin() {
  FT.pin = null;
}

/**
 * Is the kept person still someone to show? Gone (merged away, Not a face,
 * emptied) or hidden outside the Hidden view: let go of them. Otherwise
 * refresh their numbers.
 */
async function ftCheckPin() {
  const id = FT.pin && FT.pin.id;
  if (id == null) return;
  let p = null;
  try { p = await ftApi(`/api/faces/people/${id}`, { background: true }); } catch { p = null; }
  if (!FT.pin || FT.pin.id !== id) return;
  FT.pin = p && (!p.hidden || FT.filter === 'hidden') ? { ...FT.pin, ...p } : null;
  ftPaintGrid();
}

/** Put the focus back on `el` unless the person has already moved it elsewhere. */
function ftRefocus(el) {
  const a = document.activeElement;
  if (el && el.isConnected && (!a || a === document.body)) el.focus({ preventScroll: true });
}

/**
 * "Who is this?": a small dialog beside a face crop, holding the usual name
 * field (suggestions, "already in Faces. Same person?") and Skip for now.
 * Skip, Esc or a click elsewhere leaves the person unnamed. `box` is the
 * positioned element the dialog lives in (a tile, the person header).
 */
function ftAskName({ box, crop, id, me, inGrid = false, onDone, focusBack }) {
  if (!box || !crop) return;
  const pop = document.createElement('div');
  pop.className = 'ft-whois';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Who is this?');
  pop.innerHTML = `
    <div class="ft-whois-title">Who is this?</div>
    <span class="ft-whois-slot"></span>
    <div class="ft-whois-acts"><button class="ft-btn ghost" type="button" data-whois-skip>Skip for now</button></div>`;
  box.appendChild(pop);
  box.classList.add('ft-asking');

  // Beside the crop where there is room, else on its other side, else under it.
  const b = box.getBoundingClientRect();
  const c = crop.getBoundingClientRect();
  const w = pop.offsetWidth;
  let left = c.right + 8;
  let top = c.top;
  if (left + w > innerWidth - 8) left = c.left - 8 - w;
  if (left < 8) { left = c.left; top = c.bottom + 8; }
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  pop.style.left = `${left - b.left}px`;
  pop.style.top = `${top - b.top}px`;

  // Clicks in here are not clicks on the tile (which would open the person).
  pop.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target.closest('[data-whois-skip]')) ftCloseNaming();
  });
  pop.addEventListener('contextmenu', (e) => e.stopPropagation());
  pop.addEventListener('keydown', (e) => e.stopPropagation());

  ftStartNaming({
    host: pop, anchor: pop.querySelector('.ft-whois-slot'), id, me, inGrid, onDone,
    onClose: () => {
      pop.remove();
      box.classList.remove('ft-asking');
      if (focusBack) ftRefocus(focusBack());
    },
  });
}

/** A merged person just got a name in the grid: show where they are now. */
async function ftNamedAfterMerge(p, how = {}) {
  ftLoadReview();
  await ftLoadPeople();
  if (!p || p.id == null) return;
  const shown = FT.people.some(x => x.id === p.id);
  ftRefocus(ftRevealTile(p.id, p));
  if (how.merged || !p.name) return;   // "Put together under ..." already said it
  let msg = ftPrivate() ? 'Name saved.' : `Saved as ${p.name}.`;
  if (!shown) msg += FT.filter === 'unnamed' ? ' They now show under Named.' : ' They stay here until you change the view.';
  showToast(msg);
}

/* ── Person page ───────────────────────────────────────────────────────── */

/** Open a person's page (from a tile, a chip menu, "Often seen with"). */
function facesOpenPerson(id) {
  ftCloseNaming();
  ftUnpin();
  ftClosePops();
  ftFlipStop();
  if (FT.mode !== 'people') {
    // A person opened from a studio: the switch follows.
    if (typeof studiosReset === 'function') studiosReset();
    FT.mode = 'people';
    try { localStorage.setItem('vaultFacesMode', 'people'); } catch {}
  }
  FT.personId = Number(id);
  FT.might = null;          // a fresh look every time the page opens
  FT.person = null;
  FT.kind = 'all';
  FT.fileIds = [];
  FT.fileInfo = {};
  if (!ftOnTab()) { switchTab('faces'); return; }
  ftApplyMode();
  ftPaintSelBar();
  ftRenderPerson();
  applyFilters();
  if (typeof scrollLibraryToTop === 'function') scrollLibraryToTop();
}

function ftClosePerson() {
  ftCloseNaming();
  ftClosePops();
  FT.personId = null;
  FT.person = null;
  FT.fileIds = null;
  FT.fileInfo = {};
  ftApplyMode();
  ftRenderHome();
  applyFilters();
}

function ftRenderPerson() {
  const view = ftView();
  if (!view) return;
  if (!facesReady()) { ftRenderHome(); return; }
  view.innerHTML = '<div class="ft-person" id="ftPerson"></div>';
  ftPaintPerson();
  ftLoadPerson();
}

async function ftLoadPerson() {
  const id = FT.personId;
  const seq = ++FT.filesSeq;
  let person, files;
  FT.filesReady = (async () => {
    try {
      [person, files] = await Promise.all([
        ftApi(`/api/faces/people/${id}`),
        ftApi(`/api/faces/people/${id}/files?kind=${FT.kind}`),
      ]);
    } catch (err) {
      if (seq !== FT.filesSeq) return;
      if (err.status === 404) { showToast('That person is no longer in Faces.'); ftClosePerson(); return; }
      facesToastError(err);
      return;
    }
    if (seq !== FT.filesSeq || FT.personId !== id) return;
    FT.person = person;
    if (!FT.counts) ftLoadPeople();   // the header's people count (opened straight into a person)
    if (!FT.might || FT.might.personId !== id) ftLoadMight();
    FT.fileIds = (files.ids || []);
    FT.fileInfo = files.files || {};
    ftPaintPerson();
    await applyFilters();
  })();
  return FT.filesReady;
}

async function ftLoadFiles() {
  const id = FT.personId;
  const seq = ++FT.filesSeq;
  FT.filesReady = (async () => {
    let files;
    try { files = await ftApi(`/api/faces/people/${id}/files?kind=${FT.kind}`); }
    catch (err) { facesToastError(err); return; }
    if (seq !== FT.filesSeq || FT.personId !== id) return;
    FT.fileIds = (files.ids || []);
    FT.fileInfo = files.files || {};
    await applyFilters();
  })();
  return FT.filesReady;
}

function ftPaintPerson() {
  const host = document.getElementById('ftPerson');
  if (!host) return;
  const p = FT.person;
  if (!p) {
    host.innerHTML = `<div class="ft-crumb"><button class="ft-back" type="button" data-ft-home>← Faces</button></div>`;
    return;
  }
  const name = ftName(p);
  const badges = [ftPlural(p.files, 'file', 'files')];
  if (p.videos) badges.push(ftPlural(p.videos, 'video', 'videos'));
  if (p.photos) badges.push(ftPlural(p.photos, 'photo', 'photos'));
  const t = p.videos ? ftScreen(p.screenS) : '';
  if (t) badges.push(t);
  const withChips = (p.oftenWith || []).map(o => `<button class="ft-mini" type="button" data-ft-open="${o.id}">${ftCropImg(o.coverUrl)}<span class="${o.name ? 'ft-mini-name' : 'ft-mini-name ft-muted'}">${o.name ? ftEsc(o.name) : 'Not named yet'}</span> · ${Number(o.shared).toLocaleString()}</button>`).join('');
  const seg = [['all', 'All', p.files], ['video', 'Videos', p.videos], ['photo', 'Photos', p.photos]];
  host.innerHTML = `
    <div class="ft-crumb"><button class="ft-back" type="button" data-ft-home>← Faces</button><span class="ft-sep">/</span>
      <b class="ft-crumb-name${name ? '' : ' ft-muted'}">${name ? ftEsc(name) : 'Not named yet'}</b>${p.hidden ? '<span class="ft-tag">Hidden</span>' : ''}</div>
    <section class="ft-head">
      <button class="ft-cover" type="button" data-ft-cover aria-haspopup="dialog" aria-label="Change photo">${ftCropImg(p.coverUrl)}<span class="ft-cover-cap">Change photo</span></button>
      <div class="ft-info">
        <div class="ft-title" id="ftTitle">
          ${name ? `<h1>${ftEsc(name)}</h1>` : '<h1 class="ft-muted">Not named yet</h1>'}
          <button class="ft-icon-btn" type="button" data-ft-rename aria-label="${name ? 'Rename' : 'Add a name'}" title="${name ? 'Rename' : 'Add a name'}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a0a0a0" stroke-width="2" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"></path></svg></button>
        </div>
        ${ftDetailsTopHtml(p)}
        <div class="ft-stats">${badges.map(b => `<span class="ft-pbadge">${ftEsc(b)}</span>`).join('')}</div>
        ${typeof stPersonChipsHtml === 'function' ? stPersonChipsHtml(p) : ''}
        <div class="ft-acts">
          <button class="ft-btn ft-btn-md" type="button" data-ft-play="0">▶ Play all</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-ft-play="1">Shuffle</button>
          <button class="ft-btn ghost ft-btn-md${p.favorite ? ' on' : ''}" type="button" data-ft-fav aria-pressed="${!!p.favorite}">★ Favorite</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-ft-details aria-haspopup="dialog">Edit details</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-ft-findmore>Find more that might be them</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-ft-more aria-haspopup="menu">More ▾</button>
        </div>
        ${p.description ? `<p class="st-desc">${ftEsc(p.description)}</p>` : ''}
        ${p.notes ? `<div class="st-notes"><b>Notes:</b> ${ftEsc(p.notes)}</div>` : ''}
        ${withChips ? `<div class="ft-with">Often seen with ${withChips}</div>` : ''}
      </div>
    </section>
    <section class="ft-might" id="ftMight" aria-label="Might also be" hidden></section>
    <div class="ft-seg" role="group" aria-label="Show">${seg.map(([k, label, n]) =>
      `<button type="button" class="${FT.kind === k ? 'on' : ''}" data-ft-kind="${k}" aria-pressed="${FT.kind === k}">${label} ${Number(n || 0).toLocaleString()}</button>`).join('')}</div>`;
  ftPaintMight();
}

/** S5: "Also known as", then Active / Born / links, under the name. */
function ftDetailsTopHtml(p) {
  const aka = String(p.aliases || '').split(',').map(x => x.trim()).filter(Boolean).join(', ');
  const years = typeof stYears === 'function' ? stYears(p.yearStart, p.yearEnd) : '';
  const born = p.born && typeof stBorn === 'function' ? stBorn(p.born) : '';
  const links = typeof stLinksHtml === 'function' ? stLinksHtml(p.urls) : '';
  const facts = `${years ? `<span><b>Active</b> ${years}</span>` : ''}${born ? `<span><b>Born</b> ${ftEsc(born)}</span>` : ''}${links}`;
  return `${aka ? `<div class="st-aka">Also known as: <span class="ft-pm-name">${ftEsc(aka)}</span></div>` : ''}
    ${facts ? `<div class="st-facts">${facts}</div>` : ''}`;
}

/** A person answer lands on the open page; the extras it may not carry stay. */
function ftMergePerson(p) {
  if (!p || !FT.person) return;
  Object.assign(FT.person, p, {
    oftenWith: p.oftenWith || FT.person.oftenWith,
    studios: p.studios || FT.person.studios,
  });
}

/** Studio chips changed: the person again (details and studios), not their files. */
async function ftReloadPersonDetails() {
  const id = FT.personId;
  if (id == null) return;
  let p;
  try { p = await ftApi(`/api/faces/people/${id}`, { background: true }); } catch (err) { facesToastError(err); return; }
  if (FT.personId !== id || !FT.person) return;
  ftMergePerson(p);
  ftPaintPerson();
}

/** S5: Edit details (name, other names, years, born, links, description, notes). */
function ftEditDetails() {
  const p = FT.person;
  if (!p || typeof stOverlay !== 'function') return;
  const v = (x) => ftEsc(x == null ? '' : x);
  const ov = stOverlay(`
    <form class="ft-dlg st-dlg st-form st-form-narrow" role="dialog" aria-modal="true" aria-label="Edit details" novalidate>
      <h2>Edit details</h2>
      <div><label class="st-lbl" for="pdName">Name</label><input class="st-in st-pm-field" id="pdName" type="text" maxlength="200" value="${v(p.name)}" placeholder="Not named yet"></div>
      <div><label class="st-lbl" for="pdAka">Other names</label><input class="st-in st-pm-field" id="pdAka" type="text" value="${v(p.aliases)}" placeholder="Separate them with commas"><div class="st-hint">Search finds them by any of these.</div></div>
      ${stYearsInputs('pdY1', 'pdY2', p.yearStart, p.yearEnd)}
      <div><label class="st-lbl" for="pdBorn">Born (optional)</label><input class="st-in" id="pdBorn" type="text" maxlength="10" value="${v(p.born)}" placeholder="1961-08-04, 1961-08 or 1961"></div>
      <div><label class="st-lbl" for="pdLinks">Links</label><textarea class="st-in st-in-links" id="pdLinks" rows="2" placeholder="https://">${v(stUrlList(p.urls).join('\n') || p.urls)}</textarea><div class="st-hint">One per line.</div></div>
      <div><label class="st-lbl" for="pdDesc">Description</label><textarea class="st-in" id="pdDesc">${v(p.description)}</textarea></div>
      <div><label class="st-lbl" for="pdNotes">Notes (only for you)</label><textarea class="st-in" id="pdNotes">${v(p.notes)}</textarea></div>
      <div class="st-err" role="alert" hidden></div>
      <div class="st-dacts st-dacts-end"><button class="ft-btn ghost ft-btn-md" type="button" data-pd-cancel>Cancel</button><button class="ft-btn ft-btn-md" type="submit">Save</button></div>
    </form>`);
  const form = ov.querySelector('form');
  const err = form.querySelector('.st-err');
  const say = (msg) => { err.textContent = msg; err.hidden = false; };
  form.querySelector('[data-pd-cancel]').addEventListener('click', () => ov._close());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = (id) => form.querySelector(`#${id}`).value;
    const name = val('pdName').trim();
    const yrs = stReadYears(val('pdY1'), val('pdY2'));
    if (yrs.error) { say(yrs.error); return; }
    const born = val('pdBorn').trim();
    const bm = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(born);
    const bornOk = !born || (bm && Number(bm[1]) >= 1800 && Number(bm[1]) <= 2100 && (!bm[2] || (Number(bm[2]) >= 1 && Number(bm[2]) <= 12))
      && (!bm[3] || (Number(bm[3]) >= 1 && Number(bm[3]) <= new Date(Number(bm[1]), Number(bm[2]), 0).getDate())));
    if (!bornOk) { say('Born needs to look like 1961, 1961-08 or 1961-08-04.'); return; }
    const linkLines = val('pdLinks').split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (linkLines.some(l => !/^https?:\/\/\S+$/i.test(l))) { say('Each link needs to start with http:// or https://, one per line.'); return; }
    const long = stTextTooLong([val('pdAka'), val('pdDesc'), val('pdNotes'), val('pdLinks')]);
    if (long) { say(long); return; }
    const patch = {
      aliases: val('pdAka').split(',').map(x => x.trim()).filter(Boolean).join(', '),
      urls: linkLines.join('\n'), description: val('pdDesc').trim(), notes: val('pdNotes').trim(),
      yearStart: yrs.a, yearEnd: yrs.b, born: born || null,
    };
    if (name !== (p.name || '')) patch.name = name;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    let r;
    try { r = await ftApi(`/api/faces/people/${p.id}`, { method: 'POST', json: patch }); }
    catch (ex) {
      btn.disabled = false;
      if (ex.code === 'NAME_TAKEN') say('Someone else in Faces already has that name. To put them together, use the pencil next to the name.');
      else say(ex.message || 'Could not save. Try again.');
      return;
    }
    ov._close();
    if (FT.personId === p.id && FT.person) { ftMergePerson(r); ftPaintPerson(); }
    showToast('Saved.');
  });
  form.querySelector('#pdName').focus();
}

async function ftPostPerson(patch) {
  const id = FT.personId;
  try {
    const p = await ftApi(`/api/faces/people/${id}`, { method: 'POST', json: patch });
    if (FT.personId === id && FT.person) ftMergePerson(p);
    return p;
  } catch (err) { facesToastError(err); return null; }
}

async function ftPlay(shuffle, ready = FT.filesReady) {
  if (ready) await ready;
  if (typeof Library === 'undefined' || Library.length() === 0) { showToast('There are no files to play.'); return; }
  // A person's files are a queue: repeat-one would sit on the first file.
  if (typeof repeatMode === 'function' && repeatMode() === 'one' && typeof setRepeatMode === 'function') {
    setRepeatMode('off', { persist: false });
  }
  if (shuffle && await Library.shuffle()) renderResults();
  const [first] = await Library.rowsForRange(0, 1);
  if (first) playMedia({ filepath: first.filepath, filename: first.filename, media_type: first.media_type });
}

async function ftFindMore() {
  const p = FT.person;
  if (!p) return;
  const faces = await ftFacesOf(p.id);
  const gid = p.coverGroupId || (faces && faces[0] && faces[0].groupId);
  if (!gid) { showToast('No face to search with.'); return; }
  const f = (faces || []).find(x => x.groupId === gid);
  await facesOpenFocus({ kind: 'group', id: gid, mediaId: f ? f.mediaId : undefined }, p.coverUrl, 'wide');
}

/* ── Popovers: Change photo, Merge with ───────────────────────────────── */

function ftClosePops() {
  document.getElementById('ftPop')?.remove();
}

function ftPop(anchor, html, label) {
  ftClosePops();
  const pop = document.createElement('div');
  pop.className = 'fpop ft-pop';
  pop.id = 'ftPop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  pop.innerHTML = html;
  document.body.appendChild(pop);
  const a = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(a.left, innerWidth - r.width - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(a.bottom + 6, innerHeight - r.height - 8))}px`;
  return pop;
}

async function ftChangePhoto(anchor) {
  const p = FT.person;
  if (!p) return;
  let faces;
  try { faces = await ftApi(`/api/faces/people/${p.id}/faces?limit=24`); } catch (err) { facesToastError(err); return; }
  if (FT.person !== p) return;
  const current = p.coverGroupId;
  const pop = ftPop(anchor, `
    <div class="fpop-title">Choose a photo</div>
    <div class="ft-pick">${faces.map(f => `<button type="button" class="ft-pick-btn${f.groupId === current ? ' on' : ''}" data-cover="${f.groupId}"
      aria-label="Use this photo" aria-pressed="${f.groupId === current}">${ftCropImg(f.cropUrl)}</button>`).join('')}</div>`, 'Choose a photo');
  pop.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cover]');
    if (!b) return;
    ftClosePops();
    const r = await ftPostPerson({ coverGroupId: Number(b.dataset.cover) });
    if (r) { FT.faces.delete(p.id); ftPaintPerson(); }
  });
  pop.querySelector('.ft-pick-btn')?.focus();
}

function ftMoreMenu(anchor) {
  const p = FT.person;
  if (!p) return;
  const r = anchor.getBoundingClientRect();
  facesMenu(r.left, r.bottom + 4, [
    { label: p.hidden ? 'Unhide this person' : 'Hide this person', run: () => ftHidePerson(!p.hidden) },
    { label: 'Merge with…', run: () => ftMergeWith(anchor) },
    { label: 'Not a face', run: async () => { if (await ftNotAFace([p])) ftClosePerson(); } },
  ]);
}

async function ftHidePerson(hidden) {
  const id = FT.personId;
  if (!await ftPostPerson({ hidden })) return;
  ftPaintPerson();
  if (hidden) {
    showUndoToast('Hidden from Faces. You can find them under Hidden.', async () => {
      try { await ftApi(`/api/faces/people/${id}`, { method: 'POST', json: { hidden: false } }); } catch (err) { facesToastError(err); return; }
      if (FT.personId === id && FT.person) { FT.person.hidden = false; ftPaintPerson(); }
    }, 8000);
  } else showToast('Back in Everyone.');
}

function ftMergeWith(anchor) {
  const me = FT.person;
  if (!me) return;
  const pop = ftPop(anchor, `
    <div class="fpop-title">Merge with…</div>
    <input type="text" class="ft-field ft-pop-search" placeholder="Search people by name" aria-label="Search people by name" autocomplete="off">
    <div class="ft-pop-list" role="listbox" aria-label="People"></div>`, 'Merge with');
  const input = pop.querySelector('input');
  const listEl = pop.querySelector('.ft-pop-list');
  let seq = 0;
  let rows = [];
  const load = async () => {
    const s = ++seq;
    const qs = new URLSearchParams({ filter: 'all', sort: input.value.trim() ? 'name' : 'files', q: input.value.trim(), limit: '9' });
    let r;
    try { r = await ftApi(`/api/faces/people?${qs}`, { background: true }); } catch { return; }
    if (s !== seq) return;
    rows = (r.people || []).filter(p => p.id !== me.id).slice(0, 8);
    listEl.innerHTML = rows.length ? rows.map((p, i) => `<button class="ft-opt" type="button" role="option" data-pick="${i}">${ftCropImg(p.coverUrl)}<span class="${p.name ? '' : 'ft-muted'}">${p.name ? ftEsc(p.name) : 'Not named yet'}</span><span>${ftPlural(p.files, 'file', 'files')}</span></button>`).join('')
      : '<div class="ft-drop-note">No one matches.</div>';
  };
  input.addEventListener('input', debounce(load, 150));
  listEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const other = rows[Number(b.dataset.pick)];
    ftClosePops();
    // Keep this page's person unless only the other one has a name.
    const into = !me.name && other.name ? other : me;
    let merged;
    try { merged = await ftApi('/api/faces/people/merge', { method: 'POST', json: { ids: [me.id, other.id], into: into.id } }); }
    catch (err) { facesToastError(err); return; }
    FT.faces.delete(me.id); FT.faces.delete(other.id);
    showToast(ftTogether(merged));
    facesOpenPerson(into.id);
    if (into.name) return;
    // Neither had a name: ask for one on the merged person's page.
    await FT.filesReady;
    const head = document.querySelector('#ftPerson .ft-head');
    if (FT.personId !== into.id || !FT.person || !head || FT.naming) return;
    ftAskName({
      box: head, crop: head.querySelector('.ft-cover'), id: into.id, me: FT.person,
      focusBack: () => document.querySelector('#ftPerson [data-ft-more]'),
      onDone: (p, how = {}) => {
        if (p && p.id !== FT.personId) { facesOpenPerson(p.id); return; }
        if (p && FT.person) ftMergePerson(p);
        ftPaintPerson();
        ftRefocus(document.querySelector('#ftPerson [data-ft-more]'));
        if (p && p.name && !how.merged) showToast(ftPrivate() ? 'Name saved.' : `Saved as ${p.name}.`);
      },
    });
  });
  input.focus();
  load();
}

/* ── Not a face (tile menu, selection bar, More menu) ─────────────────── */

/**
 * Every face of these people leaves Faces and face search (things that were
 * picked up by mistake). Asks first: there is no undo.
 * @returns {Promise<boolean>} whether it was done
 */
async function ftNotAFace(list) {
  list = list.filter(Boolean);
  const n = list.length;
  if (!n) return false;
  const ok = await facesAsk({
    title: 'Not a face?',
    html: `<p class="vault-modal-hint">${n === 1 ? 'Every face Vault found for this person' : `Every face Vault found for these ${n.toLocaleString()} people`}
      will be taken out of Faces and face search. Use this for things Vault picked up by mistake, like a pattern or a shadow.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Not a face', value: true, danger: true }],
  });
  if (!ok) return false;
  // One person gone meanwhile (merged, emptied) does not stop the rest.
  let done = 0, gone = 0;
  for (const p of list) {
    try {
      await ftApi(`/api/faces/people/${p.id}/not-a-face`, { method: 'POST' });
      done++;
    } catch (err) {
      if (err.status === 404) { gone++; continue; }
      facesToastError(err);
      ftLoadPeople();
      return done + gone > 0;
    }
    FT.faces.delete(p.id);
  }
  const took = done === 1 ? 'Took 1 person out of Faces (not a face).' : `Took ${done.toLocaleString()} people out of Faces (not faces).`;
  const lost = gone ? ` ${gone.toLocaleString()} ${gone === 1 ? 'was' : 'were'} no longer in Faces.` : '';
  showToast(done ? took + lost : `${gone === 1 ? 'That person is' : 'Those people are'} no longer in Faces.`);
  return true;
}

/* ── Might also be (person page) ───────────────────────────────────────── */

const FT_MIGHT_PAGE = 24;
const FT_MIGHT_LESS = 6;     // less likely faces shown before "Show N more"

/** Other unnamed people that look like this one (GET .../candidates). Likely ones start ticked. */
async function ftLoadMight({ more = false } = {}) {
  const id = FT.personId;
  if (id == null) return;
  if (!FT.might || FT.might.personId !== id) {
    FT.might = { personId: id, total: 0, items: [], ticked: new Set(), lessShown: FT_MIGHT_LESS, seq: 0 };
  }
  const m = FT.might;
  const seq = ++m.seq;
  const qs = new URLSearchParams({ limit: String(FT_MIGHT_PAGE), offset: String(more ? m.items.length : 0) });
  let r;
  try { r = await ftApi(`/api/faces/people/${id}/candidates?${qs}`, { background: true }); }
  catch { return; }
  if (seq !== m.seq || FT.might !== m || FT.personId !== id) return;
  const items = r.items || [];
  if (!more) { m.items = []; m.ticked = new Set(); }
  const have = new Set(m.items.map(i => i.personId));
  for (const it of items) {
    if (have.has(it.personId)) continue;
    m.items.push(it);
    if (it.tier === 'likely') m.ticked.add(it.personId);
  }
  m.total = Math.max(r.total || 0, m.items.length);
  ftPaintMight();
}

function ftMightCardHtml(it, ticked) {
  const meta = `${ftEsc(it.filename || '')}${it.files > 1 ? ` · ${ftPlural(it.files, 'file', 'files')}` : ''}`;
  return `
    <div class="ft-cand${ticked ? ' on' : ''}" data-cand="${it.personId}">
      <button class="ft-cand-pick" type="button" data-ft-cand="tick" aria-pressed="${ticked}" aria-label="${ticked ? 'Ticked' : 'Not ticked'}">${ftCropImg(it.cropUrl)}</button>
      <span class="ft-cand-chk" aria-hidden="true">${ticked ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M5 12l5 5 9-10"></path></svg>' : ''}</span>
      <button class="ft-cand-no" type="button" data-ft-cand="no" aria-label="Not this person" title="Not this person">✕</button>
      <div class="ft-cmeta">${meta}</div>
    </div>`;
}

function ftPaintMight() {
  const el = document.getElementById('ftMight');
  if (!el) return;
  const m = FT.might;
  const p = FT.person;
  if (!m || !p || m.personId !== FT.personId || !m.items.length) { el.hidden = true; el.innerHTML = ''; return; }
  const likely = m.items.filter(i => i.tier === 'likely');
  const maybe = m.items.filter(i => i.tier !== 'likely');
  const shown = maybe.slice(0, m.lessShown);
  const rest = Math.max(0, m.total - likely.length - shown.length);
  const k = m.items.filter(i => m.ticked.has(i.personId)).length;
  const who = p.name ? `<span class="ft-pm-name">${ftEsc(p.name)}</span>` : 'this person';
  el.hidden = false;
  el.setAttribute('aria-label', p.name && !ftPrivate() ? `Might also be ${p.name}` : 'Might also be this person');
  el.innerHTML = `
    <div class="ft-might-h">
      <h2>Might also be ${who}</h2>
      <span>${ftPlural(m.total, 'face', 'faces')} ${m.total === 1 ? 'from another file looks' : 'from other files look'} a lot like ${p.name ? 'them' : 'this person'}. Tick the right ones.</span>
      <div class="ft-might-acts">
        <button class="ft-btn ft-btn-md" type="button" data-ft-might="add"${k ? '' : ' disabled'}>${k ? `Add the ${k.toLocaleString()} ticked to ${who}` : 'Tick faces to add'}</button>
        <button class="ft-btn ghost ft-btn-md" type="button" data-ft-might="${k ? 'untick' : 'tick'}">${k ? 'Untick all' : 'Tick all'}</button>
      </div>
    </div>
    ${likely.length ? `<div class="ft-might-sub">Very likely</div><div class="ft-cands">${likely.map(i => ftMightCardHtml(i, m.ticked.has(i.personId))).join('')}</div>` : ''}
    ${shown.length ? `<div class="ft-might-sub">Less likely</div><div class="ft-cands">${shown.map(i => ftMightCardHtml(i, m.ticked.has(i.personId))).join('')}</div>` : ''}
    ${rest ? `<button class="ft-link" type="button" data-ft-might="more">Show ${rest.toLocaleString()} more that ${rest === 1 ? 'is' : 'are'} less likely</button>` : ''}`;
}

/** A card's tick, or its ✕ ("not this person": recorded, and it does not come back). */
async function ftMightCard(pid, act, btn) {
  const m = FT.might;
  if (!m || m.personId !== FT.personId) return;
  if (act === 'tick') {
    if (m.ticked.has(pid)) m.ticked.delete(pid); else m.ticked.add(pid);
    ftPaintMight();
    document.querySelector(`#ftMight [data-cand="${pid}"] .ft-cand-pick`)?.focus();
    return;
  }
  btn.disabled = true;
  try { await ftApi(`/api/faces/people/${m.personId}/candidates`, { method: 'POST', json: { accept: [], reject: [pid] } }); }
  catch (err) { facesToastError(err); btn.disabled = false; return; }
  m.items = m.items.filter(i => i.personId !== pid);
  m.ticked.delete(pid);
  m.total = Math.max(0, m.total - 1);
  ftPaintMight();
  // Keep the list topped up when the ✕ emptied what was loaded.
  if (!m.items.length && m.total) ftLoadMight();
  const forId = m.personId;
  showUndoToast('Got it. That face will not be suggested for this person again.', async () => {
    try { await ftApi(`/api/faces/people/${forId}/candidates`, { method: 'POST', json: { unreject: [pid] } }); }
    catch (err) { facesToastError(err); return; }
    if (FT.personId === forId) { FT.might = null; ftLoadMight(); }
  }, 8000);
}

async function ftMightAction(act, btn) {
  const m = FT.might;
  const p = FT.person;
  if (!m || !p || m.personId !== FT.personId) return;
  if (act === 'untick') { m.ticked.clear(); ftPaintMight(); return; }
  if (act === 'tick') { m.items.forEach(i => m.ticked.add(i.personId)); ftPaintMight(); return; }
  if (act === 'more') {
    m.lessShown += FT_MIGHT_PAGE;
    const maybe = m.items.filter(i => i.tier !== 'likely').length;
    if (maybe < m.lessShown && m.items.length < m.total) ftLoadMight({ more: true });
    else ftPaintMight();
    return;
  }
  if (act !== 'add') return;
  const accept = m.items.filter(i => m.ticked.has(i.personId)).map(i => i.personId);
  if (!accept.length) return;
  btn.disabled = true;
  let r;
  try { r = await ftApi(`/api/faces/people/${m.personId}/candidates`, { method: 'POST', json: { accept, reject: [] } }); }
  catch (err) { facesToastError(err); btn.disabled = false; return; }
  const merged = r && Array.isArray(r.merged) ? r.merged : accept;
  const left = r && Array.isArray(r.skipped) ? r.skipped.length : 0;
  FT.faces.delete(m.personId);
  const name = ftPrivate() ? '' : ftName(r && r.person ? r.person : p);
  // Files the person gained (a merged face can sit in a file they were already in).
  const gained = r && r.person ? (r.person.files || 0) - (p.files || 0) : 0;
  const files = gained > 0 ? gained : m.items.filter(i => merged.includes(i.personId)).reduce((s, i) => s + (i.files || 1), 0);
  const what = ftPlural(files, 'file', 'files');
  showToast((merged.length ? (name ? `Added ${what} to ${name}.` : `Added ${what} to this person.`) : 'Nothing was added.')
    + (left ? ` ${left.toLocaleString()} could not be added because ${left === 1 ? 'it has' : 'they have'} changed.` : ''));
  FT.might = null;       // reloaded fresh with the person
  if (FT.personId === m.personId) ftLoadPerson();
}

/* ── Person grid tiles: "▶ from 0:04", "✕ Not this person" ────────────── */

function facesTileExtrasHtml(media) {
  // Library: the face results' tags (faces.js).
  if (!ftOnTab()) return typeof facesResultTagHtml === 'function' ? facesResultTagHtml(media) : '';
  if (FT.mode !== 'people' || FT.personId == null || !media) return '';
  const info = FT.fileInfo[media.id];
  if (!info) return '';
  // Same rule as facesStartAt: under a second is just the start of the file.
  const from = media.media_type === 'video' && info.firstTimeS != null && info.firstTimeS >= 1
    ? `<span class="ft-from" title="This person first shows up at ${ftTime(info.firstTimeS)}">▶ from ${ftTime(info.firstTimeS)}</span>` : '';
  return `${from}<button class="ft-notme" type="button" onclick="event.stopPropagation(); facesNotThisPerson(${media.id})"
    title="This file does not show this person" aria-label="Not this person">✕<span class="ft-notme-text"> Not this person</span></button>`;
}

/**
 * The file's faces leave this person now. Undo puts them back with a merge
 * (it also clears the reject the split recorded).
 */
async function facesNotThisPerson(mediaId) {
  const personId = FT.personId;
  if (personId == null || !FT.fileIds.includes(mediaId)) return;
  let r;
  try {
    r = await ftApi(`/api/faces/people/${personId}/not-in`, { method: 'POST', json: { mediaId } });
  } catch (err) {
    facesToastError(err);
    if (FT.personId === personId) ftLoadPerson();
    return;
  }
  FT.faces.delete(personId);
  // The last file of an unnamed person: the person is gone, nothing to undo into.
  if (!r.person) {
    if (typeof hideUndoToast === 'function') hideUndoToast();   // an earlier Undo would aim at a person that is gone
    showToast('That was their last file, so they are no longer in Faces.');
    if (FT.personId === personId) ftClosePerson();
    return;
  }
  if (FT.personId === personId) {
    const at = FT.fileIds.indexOf(mediaId);
    if (at >= 0) FT.fileIds.splice(at, 1);
    if (FT.person) ftMergePerson(r.person);
    ftPaintPerson();
    applyFilters({ keepPage: true });
  }
  const groupIds = (r.moved || []).map(m => m.groupId);
  if (!groupIds.length) return;
  const name = ftPrivate() ? '' : ftName(r.person);
  showUndoToast(name ? `Removed this file from ${ftEsc(name)}.` : 'Removed this file from this person.', async () => {
    try {
      await ftApi(`/api/faces/people/${personId}/restore`, { method: 'POST', json: { groupIds } });
    } catch (err) { facesToastError(err); return; }
    FT.faces.delete(personId);
    if (FT.personId === personId) ftLoadPerson();
  }, 8000);
}

/* ── Playing from the person page: start at the first appearance ───────── */

/** viewtracker.js asks this before its resume seek; true = handled. */
function facesStartAt(el) {
  if (!ftOnTab() || FT.mode !== 'people' || FT.personId == null || !el) return false;
  if (el.currentTime > 0.5) return false;   // maximize / mini handover keeps its place
  const m = typeof currentMediaState !== 'undefined' && currentMediaState.currentMediaData;
  const info = m && FT.fileInfo[m.id];
  if (!info || info.firstTimeS == null || info.firstTimeS < 1) return false;
  if (!(el.duration > info.firstTimeS)) return false;
  el.currentTime = info.firstTimeS;
  showToast(`▶ From ${ftTime(info.firstTimeS)}, where this person first shows up`);
  return true;
}

/* ── Events ────────────────────────────────────────────────────────────── */

function ftWire() {
  const view = ftView();
  if (!view || view._ftWired) return;
  view._ftWired = true;

  view.addEventListener('input', (e) => {
    if (e.target.id !== 'ftSearch') return;
    ftSearchInput(e.target.value);
  });

  view.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const mode = t.closest('[data-ft-mode]');
    if (mode) { ftSetMode(mode.dataset.ftMode); return; }
    if (t.closest('[data-ft-turnon]')) { ftTurnOn(); return; }
    const filter = t.closest('[data-ft-filter]');
    if (filter) {
      FT.filter = filter.dataset.ftFilter;
      FT.limit = FT_PAGE;
      ftUnpin();
      ftPaintChips();
      ftLoadPeople();
      return;
    }
    const sortBtn = t.closest('#ftSortBtn');
    if (sortBtn) {
      const r = sortBtn.getBoundingClientRect();
      facesMenu(r.left, r.bottom + 4, FT_SORTS.map(s => ({
        label: `${s.value === FT.sort ? '✓ ' : ''}${s.label}`,
        run: () => { FT.sort = s.value; ftUnpin(); ftPaintSort(); ftLoadPeople(); },
      })));
      return;
    }
    const q = t.closest('[data-ft-queue]');
    if (q) { ftQueue(q.dataset.ftQueue); return; }
    if (t.closest('[data-ft-reviewall]')) { ftOpenReview(); return; }
    const ans = t.closest('[data-ft-answer]');
    if (ans) {
      const pair = ans.closest('.ft-pair');
      pair.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const said = await ftAnswer(Number(pair.dataset.a), Number(pair.dataset.b), ans.dataset.ftAnswer);
      if (said != null) {
        showToast(said);
        ftLoadReview();
        if (ans.dataset.ftAnswer === 'same') ftLoadPeople();
      } else pair.querySelectorAll('button').forEach(b => { b.disabled = false; });
      return;
    }
    if (t.closest('[data-ft-showmore]')) { FT.limit += FT_PAGE; ftLoadPeople(); return; }

    // People tiles
    const tile = t.closest('.ft-tile');
    if (tile) {
      if (t.closest('.ft-naming .ft-field, .ft-drop, .ft-ask, .ft-whois')) return;
      const id = Number(tile.dataset.person);
      if (t.closest('.ft-check')) { e.preventDefault(); ftToggleSel(id, { range: e.shiftKey }); return; }
      const add = t.closest('[data-ft-addname]');
      if (add) {
        ftStartNaming({ host: tile, anchor: add, id, inGrid: true, onDone: () => { ftLoadPeople(); ftLoadReview(); } });
        return;
      }
      if (e.ctrlKey || e.metaKey || e.shiftKey) { ftToggleSel(id, { range: e.shiftKey }); return; }
      facesOpenPerson(id);
      return;
    }

    // Person page: Might also be
    const mightBtn = t.closest('[data-ft-might]');
    if (mightBtn) { ftMightAction(mightBtn.dataset.ftMight, mightBtn); return; }
    const cand = t.closest('[data-ft-cand]');
    if (cand) { ftMightCard(Number(cand.closest('[data-cand]').dataset.cand), cand.dataset.ftCand, cand); return; }

    // Person page
    if (t.closest('[data-ft-home]')) { ftClosePerson(); return; }
    const open = t.closest('[data-ft-open]');
    if (open) { facesOpenPerson(Number(open.dataset.ftOpen)); return; }
    const play = t.closest('[data-ft-play]');
    if (play) { ftPlay(play.dataset.ftPlay === '1'); return; }
    if (t.closest('[data-ft-fav]')) {
      const p = FT.person;
      if (p && await ftPostPerson({ favorite: !p.favorite })) ftPaintPerson();
      return;
    }
    if (t.closest('[data-ft-findmore]')) { ftFindMore(); return; }
    if (t.closest('[data-ft-details]')) { ftEditDetails(); return; }
    const more = t.closest('[data-ft-more]');
    if (more) { e.stopPropagation(); ftMoreMenu(more); return; }
    const cover = t.closest('[data-ft-cover]');
    if (cover) { ftChangePhoto(cover); return; }
    const rename = t.closest('[data-ft-rename]');
    if (rename) {
      const title = document.getElementById('ftTitle');
      const h1 = title && title.querySelector('h1');
      if (!h1 || !FT.person) return;
      ftStartNaming({
        host: title, anchor: h1, id: FT.person.id, initial: FT.person.name || '',
        onDone: (p) => {
          if (p && p.id !== FT.personId) { facesOpenPerson(p.id); return; }
          if (p && FT.person) ftMergePerson(p);
          ftPaintPerson();
        },
      });
      return;
    }
    const kind = t.closest('[data-ft-kind]');
    if (kind && kind.dataset.ftKind !== FT.kind) {
      FT.kind = kind.dataset.ftKind;
      ftPaintPerson();
      ftLoadFiles();
    }
  });

  // People tiles: right-click for Open / Not a face.
  view.addEventListener('contextmenu', (e) => {
    const tile = e.target instanceof Element && e.target.closest('.ft-tile');
    if (!tile || tile.classList.contains('ft-naming')) return;
    const id = Number(tile.dataset.person);
    const p = FT.people.find(x => x.id === id) || (FT.pin && FT.pin.id === id ? FT.pin : null);
    if (!p) return;
    e.preventDefault();
    facesMenu(e.clientX, e.clientY, [
      { label: 'Open', run: () => facesOpenPerson(id) },
      { label: 'Not a face', run: async () => {
        if (!await ftNotAFace([p])) return;
        FT.sel.delete(id);
        if (FT.pin && FT.pin.id === id) ftUnpin();
        ftPaintSelBar();
        ftLoadPeople();
        ftLoadReview();
      } },
    ]);
  });

  view.addEventListener('keydown', (e) => {
    const tile = e.target instanceof Element && e.target.classList.contains('ft-tile') ? e.target : null;
    if (tile && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      facesOpenPerson(Number(tile.dataset.person));
    }
  });

  view.addEventListener('mouseover', (e) => {
    const thumb = e.target instanceof Element && e.target.closest('.ft-tile .ft-thumb');
    if (thumb) ftFlipStart(thumb.closest('.ft-tile'));
  });
  view.addEventListener('mouseout', (e) => {
    if (!ftFlip) return;
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest('.ft-thumb') : null;
    if (!to || to.closest('.ft-tile') !== ftFlip.tile) ftFlipStop();
  });
}

const ftSearchInput = debounce((v) => {
  FT.q = v.trim();
  FT.limit = FT_PAGE;
  ftUnpin();
  ftLoadPeople();
}, 200);

// Outside clicks close the name field and the popovers.
document.addEventListener('mousedown', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  if (FT.naming && !FT.naming.host.contains(t)) ftCloseNaming();
  if (!t.closest('#ftPop, [data-ft-cover], [data-ft-more], #facesMenu')) ftClosePops();
}, true);

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('ftReviewDlg')) ftCloseReview();
  else if (document.getElementById('ftPop')) ftClosePops();
  else if (FT.naming) ftCloseNaming();
  else if (ftOnTab() && FT.mode === 'people' && FT.personId == null && FT.sel.size && !document.querySelector('.modal-overlay.active, .media-player-overlay.active, .settings-overlay.active')) ftClearSel();
  else return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

window.addEventListener('resize', () => ftClosePops());

// Settings > Card size applies to people tiles too. settings.js asks the
// library to re-lay itself after saving it; the people grid follows along.
function ftApplyCardSize() {
  const grid = document.getElementById('ftGrid');
  if (!grid || typeof window.vaultCardSize !== 'function') return;
  grid.style.setProperty('--ft-min', `${FT_CARD_MIN[window.vaultCardSize()] || 170}px`);
}
{
  const relayout = window.vaultRelayoutLibrary;
  window.vaultRelayoutLibrary = (...args) => {
    const r = typeof relayout === 'function' ? relayout(...args) : undefined;
    ftApplyCardSize();
    return r;
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ftWire);
else ftWire();
