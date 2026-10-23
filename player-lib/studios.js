/* =========================================================================
   STUDIOS - files and people grouped by where they come from
   (.notes/STUDIOS_SPEC.md section 3, mockups S1 to S5).

   Lives in the 👤 Faces tab next to People (the People | Studios switch,
   FT.mode in faces-tab.js), inside the same #facesView:
     home    the studio grid (search, sort, chips, + New studio)
     studio  breadcrumb, header, People, Files; the library grid below shows
             the studio's files (filters.js currentQuerySpec -> studiosQuery:
             spec.studioId, like collectionId).
   Studios work with face search off: only the people parts need it.

   Hooks into other files:
     faces-tab.js   ftRenderHome() hands the view over in Studios mode;
                    the person page draws studio chips with the helpers here
     filters.js     studiosQuery()
     selection.js   studiosSelectionButton()       "🏢 Studio ▾"
     detail-view.js studiosDetailItemHtml(media)   the File Info "Studio" row
     cards.js       studiosTileTagHtml(media)      the studio name on a tile
   Server: /api/studios*, /api/media/studio (server/studios-routes.js).
   ========================================================================= */

const ST_SORTS = [
  { value: 'files', label: 'Most files' },
  { value: 'name', label: 'Name A to Z' },
  { value: 'recent', label: 'Recently added' },
  { value: 'years', label: 'Years active' },
];
const ST_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'favorites', label: '★ Favorites' },
  { value: 'nophoto', label: 'No cover picked' },
];
const ST_PAGE = 200;
const ST_CARD_MIN = { S: 200, M: 260, L: 330 };
const ST_IDS_CHUNK = 5000;
const ST_COVER_MAX = 15 * 1024 * 1024;
const ST_TEXT_MAX = 5000;
const ST_MSG = {
  NAME_TAKEN: 'There is already a studio with that name.',
  NOT_FOUND: 'That studio is no longer there. Refresh to see the latest.',
  TOO_LARGE: 'That photo is too big (15 MB at most).',
  BAD_IMAGE: 'That file is not a photo Vault can use. Try a JPG, PNG or WebP.',
  FACES_OFF: 'Turn on face search to add people to studios.',
  NOT_IN_STUDIO: 'That file is not in this studio any more.',
  FRAME_FAILED: 'Vault could not read that frame. Try another one.',
  FILE_MISSING: 'That file is missing on disk.',
  NOT_ELIGIBLE: 'Only photos, GIFs and videos have a picture to use.',
};

const ST = {
  q: '', sort: 'files', filter: 'all', limit: ST_PAGE,
  list: [], total: 0, counts: null, loaded: false, seq: 0,
  studioId: null, studio: null, kind: 'all', pageSeq: 0, filesReady: null,
  names: new Map(),       // studio id -> name (tile tags, the File Info row)
};

/* ── Small helpers ─────────────────────────────────────────────────────── */

const stEsc = (s) => escapeHtml(String(s ?? ''));
const stPlural = (n, one, many) => `${Number(n || 0).toLocaleString()} ${n === 1 ? one : many}`;
const stNamesHidden = () => document.body.classList.contains('pm-names');
const stInStudios = () => ftOnTab() && FT.mode === 'studios';
const STAR_SVG = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="#facc15" aria-hidden="true"><path d="M12 2l3 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.4 21.7l1.8-7.3L1.5 9.5 9 8.9z"></path></svg>`;

/** "2009 to 2017", "2024 to now", "Until 2017", "2012", or ''. */
function stYears(a, b) {
  a = a == null || a === '' ? null : Number(a);
  b = b == null || b === '' ? null : Number(b);
  if (a && b) return a === b ? String(a) : `${a} to ${b}`;
  if (a) return `${a} to now`;
  if (b) return `Until ${b}`;
  return '';
}
const stYearsText = (a, b) => stYears(a, b) || 'No years set';

const ST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '1961-08-04' -> '4 Aug 1961', '1961-08' -> 'Aug 1961', '1961' -> '1961'. */
function stBorn(v) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(v || '').trim());
  if (!m) return v ? String(v) : '';
  const mon = m[2] ? ST_MONTHS[Number(m[2]) - 1] : '';
  if (m[3]) return `${Number(m[3])} ${mon} ${m[1]}`;
  if (mon) return `${mon} ${m[1]}`;
  return m[1];
}

/** Only real web links become links. */
function stUrlList(urls) {
  const list = Array.isArray(urls) ? urls : String(urls || '').split(/\s+/);
  return list.map(u => String(u).trim()).filter(u => /^https?:\/\/[^\s"'<>`]+$/i.test(u));
}
function stLinksHtml(urls) {
  return stUrlList(urls).map(u => {
    let host = u;
    try { host = new URL(u).hostname.replace(/^www\./i, ''); } catch {}
    return `<a class="st-link" href="${stEsc(u)}" target="_blank" rel="noopener noreferrer">${stEsc(host)}</a>`;
  }).join('');
}

function stCoverHtml(s, cls = '') {
  const letter = (String(s && s.name || '?').trim()[0] || '?').toUpperCase();
  const fallback = `<span class="st-letter ${cls}" aria-hidden="true">${stEsc(letter)}</span>`;
  if (!s || !s.coverUrl) return fallback;
  // Thumbnails off: an automatic cover (a file's thumbnail) is not asked for.
  if (String(s.coverUrl).startsWith('/thumb/') && typeof thumbsOff === 'function' && thumbsOff()) return fallback;
  return `<img class="st-cover-img ${cls}" src="${stEsc(s.coverUrl)}" alt="" loading="lazy" draggable="false"
    onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'st-letter ${cls}',textContent:${stEsc(JSON.stringify(letter))}}))">`;
}

function stRemember(list) {
  for (const s of list || []) if (s && s.id != null && s.name) ST.names.set(s.id, s.name);
}

/** Same shape as facesApi (fetch + JSON, refusals as sentences). */
async function stApi(url, { method = 'GET', json, body, type, background } = {}) {
  const headers = {};
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  else if (type) headers['Content-Type'] = type;
  if (background) headers['X-Vault-Background'] = '1';
  let resp;
  try { resp = await fetch(url, { method, headers, body }); }
  catch { throw Object.assign(new Error('Could not reach Vault. Try again.'), { code: 'NETWORK' }); }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    let msg = ST_MSG[data.code] || '';
    if (!msg && resp.status === 404 && /\/api\/studios\/\d+/.test(url)) msg = ST_MSG.NOT_FOUND;
    // These checks answer in plain sentences; other 400s are for developers.
    if (!msg && ['BAD_YEARS', 'BAD_BORN', 'BAD_URL', 'BAD_NAME'].includes(data.code) && data.error) msg = String(data.error);
    if (!msg && resp.status === 400) msg = 'Vault could not do that. Try again.';
    if (!msg) msg = resp.status === 423 ? '' : 'Studios ran into a problem. Try again.';
    throw Object.assign(new Error(msg), { code: data.code, status: resp.status, data });
  }
  return data;
}
const stToastError = (err) => { if (err && err.message) showToast(err.message); };

/* ── Hooks ─────────────────────────────────────────────────────────────── */

/** filters.js: the open studio's files, or null. */
function studiosQuery() {
  if (!stInStudios() || ST.studioId == null) return null;
  const types = ST.kind === 'video' ? ['video'] : ST.kind === 'photo' ? ['image', 'gif'] : [];
  return { studioId: ST.studioId, mediaTypes: types };
}

function studiosOpenId() { return ST.studioId; }

/** Leaving Studios mode (the switch, opening a person): nothing stays open. */
function studiosReset() {
  stClosePops();
  ST.studioId = null;
  ST.studio = null;
  ST.kind = 'all';
}

/** "3 studios" in the header while the Studios view shows. */
function studiosHeaderCount() {
  if (!stInStudios() || !ST.counts) return false;
  const el = document.getElementById('totalCount');
  if (el) el.textContent = stPlural(Number(ST.counts.all || 0), 'studio', 'studios');
  return true;
}

/* ── Render: home or studio page ───────────────────────────────────────── */

function studiosRender() {
  const view = ftView();
  if (!view) return;
  if (ST.studioId != null) { stRenderPage(); return; }
  stRenderHome();
}

function stRenderHome() {
  const view = ftView();
  if (!view.querySelector('.st-home')) {
    view.innerHTML = `
      <div class="st-home">
        <section class="ft-panel">
          <div class="ft-row">
            ${ftModeSegHtml()}
            <label class="ft-search">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
              <input type="text" id="stSearch" placeholder="Search studios by name" aria-label="Search studios" autocomplete="off">
            </label>
            <button class="ft-pill" type="button" id="stSortBtn" aria-haspopup="menu"></button>
            <button class="st-new" type="button" data-st-new>+ New studio</button>
          </div>
          <div class="ft-row ft-chips">
            <span class="st-chips" id="stChips" role="group" aria-label="Show"></span>
            <button class="ft-link st-auto-link" type="button" data-st-auto>Put files in studios by folder name</button>
          </div>
        </section>
        <div class="st-grid" id="stGrid"></div>
        <div class="ft-more-row st-more-row" id="stMoreRow" hidden><button class="ft-btn ghost" type="button" data-st-showmore>Show more studios</button></div>
      </div>`;
    view.querySelector('#stSearch').value = ST.q;
  }
  stPaintSort();
  stPaintChips();
  stPaintGrid();
  stLoadList();
}

function stPaintSort() {
  const b = document.getElementById('stSortBtn');
  if (b) b.textContent = `Sort: ${ST_SORTS.find(s => s.value === ST.sort).label} ▾`;
}

function stPaintChips() {
  const host = document.getElementById('stChips');
  if (!host) return;
  const c = ST.counts || {};
  host.innerHTML = ST_FILTERS.map(f => `<button class="ft-chip${ST.filter === f.value ? ' on' : ''}" type="button"
    data-st-filter="${f.value}" aria-pressed="${ST.filter === f.value}">${f.label}<b>${c[f.value] != null ? Number(c[f.value]).toLocaleString() : ''}</b></button>`).join('');
}

async function stLoadList() {
  const seq = ++ST.seq;
  const qs = new URLSearchParams({ q: ST.q, sort: ST.sort, filter: ST.filter, offset: '0', limit: String(ST.limit) });
  let r;
  try { r = await stApi(`/api/studios?${qs}`, { background: true }); }
  catch (err) { if (seq === ST.seq && !ST.loaded) stToastError(err); return; }
  if (seq !== ST.seq) return;
  ST.list = r.studios || [];
  ST.total = r.total || 0;
  ST.counts = r.counts || {};
  ST.loaded = true;
  stRemember(ST.list);
  stPaintChips();
  stPaintGrid();
  studiosHeaderCount();
}

function stEmptyText() {
  if (ST.q) return `No studio called "${stEsc(ST.q)}".`;
  switch (ST.filter) {
    case 'favorites': return 'No favorites yet. Open a studio and click ★ Favorite.';
    case 'nophoto': return 'Every studio has a cover picked.';
    default: return 'No studios yet. A studio groups files by where they come from, like a channel, a site or a maker.';
  }
}

function stCardHtml(s) {
  const preview = (s.peoplePreview || []).slice(0, 4);
  const n = Number(s.people || 0);
  const more = !n ? 'No people yet' : n > preview.length && preview.length ? `+${(n - preview.length).toLocaleString()} ${n - preview.length === 1 ? 'person' : 'people'}` : stPlural(n, 'person', 'people');
  return `
    <article class="st-card" data-studio="${s.id}" tabindex="0" aria-label="${stNamesHidden() ? 'Studio' : stEsc(s.name)}">
      <div class="st-cover">${stCoverHtml(s)}
        ${s.favorite ? `<span class="st-star" aria-label="Favorite">${STAR_SVG(14)}</span>` : ''}</div>
      <div class="st-body">
        <div class="st-name">${stEsc(s.name)}</div>
        <div class="st-years">${stYearsText(s.yearStart, s.yearEnd)}</div>
        <div class="st-foot">
          ${preview.length ? `<span class="st-faces">${preview.map(p => ftCropImg(p.cropUrl)).join('')}</span>` : ''}
          <span class="st-more">${more}</span>
          <span class="st-fbadge">${stPlural(s.files, 'file', 'files')}</span>
        </div>
      </div>
    </article>`;
}

function stPaintGrid() {
  const grid = document.getElementById('stGrid');
  if (!grid) return;
  const size = typeof window.vaultCardSize === 'function' ? window.vaultCardSize() : 'M';
  grid.style.setProperty('--st-min', `${ST_CARD_MIN[size] || 260}px`);
  if (!ST.loaded) { grid.innerHTML = ''; return; }
  const add = '<button class="st-addcard" type="button" data-st-new><b aria-hidden="true">+</b>New studio</button>';
  grid.innerHTML = ST.list.length ? ST.list.map(stCardHtml).join('') + (ST.q || ST.filter !== 'all' ? '' : add)
    : `<div class="ft-none">${stEmptyText()}</div>${ST.q || ST.filter !== 'all' ? '' : add}`;
  const more = document.getElementById('stMoreRow');
  if (more) more.hidden = ST.list.length >= ST.total;
}

/* ── New studio (name prompt) ──────────────────────────────────────────── */

function stNewStudio(anchor) {
  const pop = stPop(anchor, `
    <div class="fpop-title">New studio</div>
    <input type="text" class="ft-field ft-pop-search st-pop-input" placeholder="Studio name" aria-label="Studio name" maxlength="200" autocomplete="off">
    <div class="st-pop-note" hidden></div>
    <div class="st-pop-acts"><button class="ft-btn ghost" type="button" data-st-pop="cancel">Cancel</button><button class="ft-btn" type="button" data-st-pop="make">Make studio</button></div>`, 'New studio');
  const input = pop.querySelector('input');
  const note = pop.querySelector('.st-pop-note');
  const make = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    let s;
    try { s = await stApi('/api/studios', { method: 'POST', json: { name } }); }
    catch (err) {
      const other = err.data && (err.data.other || err.data.studio);
      note.hidden = false;
      note.innerHTML = other && other.id != null
        ? `There is already a studio called that. <button class="ft-link" type="button" data-st-pop-open="${Number(other.id)}">Open it</button>`
        : stEsc(err.message);
      return;
    }
    stClosePops();
    stRemember([s]);
    stOpenStudio(s.id);
    stLoadList();   // the counts and the header
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); make(); } });
  input.addEventListener('input', () => { note.hidden = true; });
  pop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-st-pop]');
    if (b) { if (b.dataset.stPop === 'make') make(); else stClosePops(); return; }
    const o = e.target.closest('[data-st-pop-open]');
    if (o) { stClosePops(); stOpenStudio(Number(o.dataset.stPopOpen)); }
  });
  input.focus();
}

/* ── Studio page ───────────────────────────────────────────────────────── */

/** Open a studio's page (from a card, a chip, the File Info row). */
function stOpenStudio(id) {
  stClosePops();
  if (FT.mode !== 'studios') {
    FT.mode = 'studios';
    try { localStorage.setItem('vaultFacesMode', 'studios'); } catch {}
  }
  FT.personId = null; FT.person = null; FT.fileIds = null; FT.fileInfo = {};
  ST.studioId = Number(id);
  ST.studio = null;
  ST.kind = 'all';
  if (!ftOnTab()) { switchTab('faces'); return; }
  if (typeof ftCloseNaming === 'function') ftCloseNaming();
  ftPaintSelBar();
  ftApplyMode();
  stRenderPage();
  ST.filesReady = applyFilters();
  if (typeof scrollLibraryToTop === 'function') scrollLibraryToTop();
}

function stCloseStudio() {
  stClosePops();
  ST.studioId = null;
  ST.studio = null;
  ftApplyMode();
  stRenderHome();
  applyFilters();
}

function stRenderPage() {
  const view = ftView();
  if (!view) return;
  view.innerHTML = '<div class="st-page" id="stPage"></div>';
  stPaintPage();
  stLoadStudio();
}

async function stLoadStudio() {
  const id = ST.studioId;
  const seq = ++ST.pageSeq;
  let s;
  try { s = await stApi(`/api/studios/${id}`); }
  catch (err) {
    if (seq !== ST.pageSeq) return;
    if (err.status === 404) { showToast('That studio is no longer there.'); stCloseStudio(); return; }
    stToastError(err);
    return;
  }
  if (seq !== ST.pageSeq || ST.studioId !== id) return;
  ST.studio = s;
  stRemember([s]);
  if (!ST.counts) stLoadList();   // the header's count (opened straight into a studio)
  stPaintPage();
}

function stPaintPage() {
  const host = document.getElementById('stPage');
  if (!host) return;
  const s = ST.studio;
  if (!s) {
    host.innerHTML = '<div class="ft-crumb"><button class="ft-back" type="button" data-st-home>← Studios</button></div>';
    return;
  }
  const people = s.people || [];
  const nPeople = people.length;
  const badges = [stPlural(s.files, 'file', 'files')];
  if (s.videos) badges.push(stPlural(s.videos, 'video', 'videos'));
  if (s.photos) badges.push(stPlural(s.photos, 'photo', 'photos'));
  badges.push(stPlural(nPeople, 'person', 'people'));
  const years = stYears(s.yearStart, s.yearEnd);
  const links = stLinksHtml(s.urls);
  const seg = [['all', 'All', s.files], ['video', 'Videos', s.videos], ['photo', 'Photos', s.photos]];
  host.innerHTML = `
    <div class="ft-crumb"><button class="ft-back" type="button" data-st-home>← Studios</button><span class="ft-sep">/</span>
      <b class="ft-crumb-name st-pm">${stEsc(s.name)}</b></div>
    <section class="ft-head st-head">
      <button class="st-pcover" type="button" data-st-cover aria-haspopup="menu" aria-label="Change photo">${stCoverHtml(s)}<span class="ft-cover-cap">Change photo</span></button>
      <div class="ft-info st-info">
        <div class="ft-title"><h1 class="st-pm">${stEsc(s.name)}</h1></div>
        ${years || links ? `<div class="st-meta">${years ? `<span>Active ${years}</span>` : ''}${links}</div>` : ''}
        <div class="ft-stats">${badges.map(b => `<span class="ft-pbadge">${stEsc(b)}</span>`).join('')}</div>
        <div class="ft-acts">
          <button class="ft-btn ft-btn-md" type="button" data-st-play="0">▶ Play all</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-st-play="1">Shuffle</button>
          <button class="ft-btn ghost ft-btn-md${s.favorite ? ' on' : ''}" type="button" data-st-fav aria-pressed="${!!s.favorite}">★ Favorite</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-st-edit>Edit</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-st-more aria-haspopup="menu">More ▾</button>
        </div>
        ${s.description ? `<p class="st-desc">${stEsc(s.description)}</p>` : ''}
        ${s.notes ? `<div class="st-notes"><b>Notes:</b> ${stEsc(s.notes)}</div>` : ''}
      </div>
    </section>
    <section class="st-sec" aria-label="People">
      <div class="st-sec-h"><h2>People</h2>
        <span>${nPeople ? `${stPlural(nPeople, 'person', 'people')}. Added by you, or found in this studio's files.` : "No one yet. Add someone, or they show up here when Vault finds faces in this studio's files."}</span>
        <button class="st-secbtn" type="button" data-st-addperson>+ Add a person</button></div>
      ${nPeople ? `<div class="st-people">${people.map(stWhoHtml).join('')}</div>` : ''}
    </section>
    <section class="st-files" aria-label="Files">
      <div class="st-sec-h"><h2>Files</h2></div>
      <div class="ft-seg" role="group" aria-label="Show">${seg.map(([k, label, n]) =>
        `<button type="button" class="${ST.kind === k ? 'on' : ''}" data-st-kind="${k}" aria-pressed="${ST.kind === k}">${label} ${Number(n || 0).toLocaleString()}</button>`).join('')}</div>
    </section>`;
}

function stWhoHtml(p) {
  const name = p.name || '';
  return `
    <button class="st-who" type="button" data-st-who="${p.id}" aria-haspopup="dialog">
      ${ftCropImg(p.cropUrl)}
      <span class="st-who-name${name ? '' : ' ft-muted'}">${name ? stEsc(name) : 'Not named yet'}</span>
      ${p.explicit ? `<span class="st-who-yr">${stYearsText(p.yearStart, p.yearEnd)}</span>` : '<span class="ft-tag st-fromfiles">From files</span>'}
    </button>`;
}

async function stPost(patch) {
  const id = ST.studioId;
  try {
    const s = await stApi(`/api/studios/${id}`, { method: 'POST', json: patch });
    if (ST.studioId === id && ST.studio) Object.assign(ST.studio, s, { people: s.people || ST.studio.people });
    stRemember([s]);
    return s;
  } catch (err) { stToastError(err); return null; }
}

function stMoreMenu(anchor) {
  const s = ST.studio;
  if (!s) return;
  const r = anchor.getBoundingClientRect();
  facesMenu(r.left, r.bottom + 4, [
    { label: 'Merge with…', run: () => stMergeWith(anchor) },
    { label: 'Delete studio', run: () => stDelete(s) },
  ]);
}

/** Delete asks first; files stay. @returns whether it was deleted */
async function stDelete(s) {
  const ok = await facesAsk({
    title: 'Delete this studio?',
    html: `<p class="vault-modal-hint"><span class="ft-pm-name">${stEsc(s.name)}</span> will be deleted. Files stay in your library.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: 'Delete studio', value: true, danger: true }],
  });
  if (!ok) return false;
  try { await stApi(`/api/studios/${s.id}/delete`, { method: 'POST' }); }
  catch (err) { stToastError(err); return false; }
  ST.names.delete(s.id);
  showToast('Studio deleted. Its files are still in your library.');
  if (ST.studioId === s.id) stCloseStudio(); else if (stInStudios()) stLoadList();
  return true;
}

function stMergeWith(anchor) {
  const me = ST.studio;
  if (!me) return;
  stPicker(anchor, {
    title: 'Merge with…', placeholder: 'Search studios by name', allowNew: false, exclude: me.id,
    onPick: async (other) => {
      const ok = await facesAsk({
        title: 'Merge these studios?',
        html: `<p class="vault-modal-hint">The files and people of <span class="ft-pm-name">${stEsc(other.name)}</span> move to
          <span class="ft-pm-name">${stEsc(me.name)}</span>, and <span class="ft-pm-name">${stEsc(other.name)}</span> goes away.</p>`,
        buttons: [{ label: 'Cancel', value: false }, { label: 'Merge', value: true, primary: true }],
      });
      if (!ok) return;
      try { await stApi(`/api/studios/${other.id}/merge`, { method: 'POST', json: { into: me.id } }); }
      catch (err) { stToastError(err); return; }
      ST.names.delete(other.id);
      showToast(stNamesHidden() ? 'Put together.' : `Put together under ${me.name}.`);
      if (ST.studioId === me.id) { stLoadStudio(); ST.filesReady = applyFilters(); }
    },
  });
}

/* ── Cover: choose a photo, or a frame from one of its files ───────────── */

function stCoverMenu(anchor, s, after) {
  const r = anchor.getBoundingClientRect();
  const items = [
    { label: 'Choose a photo', run: () => stUploadCover(s, after) },
    { label: 'Use a frame from one of its files', run: () => stFramePicker(s, after) },
  ];
  if (s.coverKind) items.push({ label: 'Remove the photo', run: () => stSetCover(s, { clear: true }, after) });
  facesMenu(r.left, r.bottom + 4, items);
}

async function stSetCover(s, payload, after) {
  let r;
  try {
    r = payload instanceof Blob
      ? await stApi(`/api/studios/${s.id}/cover`, { method: 'POST', body: payload, type: payload.type || 'image/jpeg' })
      : await stApi(`/api/studios/${s.id}/cover`, { method: 'POST', json: payload });
  } catch (err) { stToastError(err); return; }
  Object.assign(s, { coverUrl: r.coverUrl, coverKind: r.coverKind });
  if (ST.studio && ST.studio.id === s.id && ST.studio !== s) Object.assign(ST.studio, { coverUrl: r.coverUrl, coverKind: r.coverKind });
  if (ST.studioId === s.id) stPaintPage();
  if (after) after(r);
}

function stUploadCover(s, after) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { showToast(ST_MSG.BAD_IMAGE); return; }
    if (f.size > ST_COVER_MAX) { showToast(ST_MSG.TOO_LARGE); return; }
    stSetCover(s, f, after);
  });
  input.click();
}

/** A grid of the studio's files: a photo as it is, a video as five frames. */
async function stFramePicker(s, after) {
  let ids;
  try { ids = (await stApi(`/api/studios/${s.id}/files?kind=all`)).ids || []; }
  catch (err) { stToastError(err); return; }
  if (!ids.length) { showToast('This studio has no files yet.'); return; }
  let rows = [];
  try { rows = await Library.fetchRows(ids.slice(0, 24)); } catch {}
  const opts = [];
  // Thumbnails off in Settings: nothing to pick from. Hover frames off: one
  // picture per video (its thumbnail) instead of five frames.
  const off = (typeof thumbsOff === 'function' && thumbsOff());
  const hover = typeof thumbHoverOn !== 'function' || thumbHoverOn();
  for (const m of (off ? [] : rows.filter(Boolean))) {
    if (hover && m.media_type === 'video' && m.duration_seconds >= 3) {
      for (let i = 0; i < 5; i++) opts.push({ mediaId: m.id, timeS: Math.round(m.duration_seconds * ((i + 1) / 6) * 10) / 10, src: `/scrub/${m.id}/${i}` });
    } else if (['image', 'gif', 'video'].includes(m.media_type)) {
      opts.push({ mediaId: m.id, timeS: 0, src: typeof thumbUrl === 'function' ? thumbUrl(m) : `/thumb/${m.id}` });
    }
  }
  if (!opts.length) { showToast('None of its files has a picture to use.'); return; }
  const ov = stOverlay(`
    <div class="ft-dlg st-dlg st-frames" role="dialog" aria-modal="true" aria-label="Use a frame">
      <div class="ft-dlg-h"><h2>Use a frame from one of its files</h2><button type="button" class="ft-x" data-st-x aria-label="Close">×</button></div>
      <div class="st-frame-grid">${opts.map((o, i) => `<button type="button" class="st-frame" data-frame="${i}" aria-label="Use this frame"><img class="tile-img" src="${stEsc(o.src)}" alt="" loading="lazy" onerror="this.closest('.st-frame').remove()"></button>`).join('')}</div>
    </div>`);
  ov.addEventListener('click', async (e) => {
    if (e.target.closest('[data-st-x]')) { ov._close(); return; }
    const b = e.target.closest('[data-frame]');
    if (!b) return;
    const o = opts[Number(b.dataset.frame)];
    ov._close();
    await stSetCover(s, { mediaId: o.mediaId, timeS: o.timeS }, after);
  });
  ov.querySelector('.st-frame')?.focus();
}

/* ── Dialogs (Edit studio, folder names, frames; Edit details uses it too) ── */

/** A modal overlay holding `html`; Esc, a click outside or ._close() closes it. */
function stOverlay(html, { onClose } = {}) {
  const opener = document.activeElement;
  const ov = document.createElement('div');
  ov.className = 'ft-overlay st-overlay';
  ov.innerHTML = html;
  document.body.appendChild(ov);
  const close = () => {
    if (!ov.isConnected) return;
    ov.remove();
    if (onClose) onClose();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
  };
  ov._close = close;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...ov.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea, a[href]')].filter(x => x.offsetParent);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !ov.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !ov.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  });
  return ov;
}

/**
 * Read a "Years active" pair. Empty boxes are null.
 * @returns {{a:number|null,b:number|null}|{error:string}}
 */
function stReadYears(aText, bText) {
  const one = (t) => {
    t = String(t || '').trim();
    if (!t) return null;
    if (!/^\d{4}$/.test(t)) return NaN;
    return Number(t);
  };
  const a = one(aText), b = one(bText);
  if (Number.isNaN(a) || Number.isNaN(b) || (a != null && (a < 1800 || a > 2100)) || (b != null && (b < 1800 || b > 2100))) {
    return { error: 'Years need to be four digits between 1800 and 2100.' };
  }
  if (a == null && b != null) return { error: 'Set the first year too.' };
  if (a != null && b != null && b < a) return { error: 'The second year cannot be before the first.' };
  return { a, b };
}

/** Other names as a list: aliasList when the server sends it (names may hold commas). */
function stAliasList(x) {
  if (x && Array.isArray(x.aliasList)) return x.aliasList.filter(Boolean);
  return String((x && x.aliases) || '').split(',').map(v => v.trim()).filter(Boolean);
}
/** One name per line in the box; saved as an array. */
const stReadAliases = (text) => String(text || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
function stAliasField(id, x, hint) {
  return `<div><label class="st-lbl" for="${id}">Other names</label><textarea class="st-in st-in-short st-pm-field" id="${id}" rows="2" placeholder="One name per line">${stEsc(stAliasList(x).join('\n'))}</textarea><div class="st-hint">One per line. ${hint}</div></div>`;
}

const ST_URL_RE = /^https?:\/\/[^\s"'<>`]+$/i;
/** Links, one per line. @returns {{list:string[]}|{error:string}} */
function stReadLinks(text) {
  const list = String(text || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  const ok = list.every(u => { if (!ST_URL_RE.test(u)) return false; try { new URL(u); return true; } catch { return false; } });
  return ok ? { list } : { error: 'Each link needs to start with http:// or https://, one per line, with no spaces.' };
}
function stLinksField(id, urls, label) {
  return `<div><label class="st-lbl" for="${id}">${label}</label><textarea class="st-in st-in-short st-pm-field" id="${id}" rows="2" placeholder="https://">${stEsc(String(urls || '').split(/\s*\n\s*/).filter(Boolean).join('\n'))}</textarea><div class="st-hint">One per line.</div></div>`;
}

function stTextTooLong(fields) {
  return fields.some(v => String(v || '').length > ST_TEXT_MAX) ? `Each box holds up to ${ST_TEXT_MAX.toLocaleString()} characters.` : '';
}

function stYearsInputs(idA, idB, a, b, label = 'Years active') {
  return `<div class="st-two">
    <div><label class="st-lbl" for="${idA}">${label}</label><input class="st-in" id="${idA}" type="text" inputmode="numeric" maxlength="4" placeholder="Year" value="${a != null ? stEsc(a) : ''}"></div>
    <span class="st-to">to</span>
    <div><label class="st-lbl" for="${idB}">&nbsp;</label><input class="st-in" id="${idB}" type="text" inputmode="numeric" maxlength="4" placeholder="Now" value="${b != null ? stEsc(b) : ''}" aria-label="Last year"></div>
  </div>`;
}

/** S4: Edit studio. */
function stEditStudio(s) {
  if (!s) return;
  const photo = () => `${stCoverHtml(s, 'st-dlg-cover')}`;
  const ov = stOverlay(`
    <form class="ft-dlg st-dlg st-form" role="dialog" aria-modal="true" aria-label="Edit studio" novalidate>
      <h2>Edit studio</h2>
      <div class="st-photo">
        <span class="st-photo-img">${photo()}</span>
        <div class="st-pbtns">
          <button class="ft-btn ghost ft-btn-md" type="button" data-st-f="upload">Choose a photo</button>
          <button class="ft-btn ghost ft-btn-md" type="button" data-st-f="frame">Use a frame from one of its files</button>
        </div>
      </div>
      <div><label class="st-lbl" for="stfName">Name</label><input class="st-in st-pm-field" id="stfName" type="text" maxlength="200" value="${stEsc(s.name)}"></div>
      ${stAliasField('stfAka', s, 'Used when matching folder names.')}
      ${stYearsInputs('stfY1', 'stfY2', s.yearStart, s.yearEnd)}
      ${stLinksField('stfUrl', s.urls, 'Website')}
      <div><label class="st-lbl" for="stfDesc">Description</label><textarea class="st-in st-pm-field" id="stfDesc">${stEsc(s.description || '')}</textarea></div>
      <div><label class="st-lbl" for="stfNotes">Notes (only for you)</label><textarea class="st-in st-pm-field" id="stfNotes">${stEsc(s.notes || '')}</textarea></div>
      <button class="st-tog" type="button" role="switch" aria-checked="${!!s.favorite}" data-st-f="fav"><span class="st-sw" aria-hidden="true"><i></i></span>Favorite</button>
      <div class="st-err" role="alert" hidden></div>
      <div class="st-dacts"><button class="st-del" type="button" data-st-f="delete">Delete studio</button>
        <button class="ft-btn ghost ft-btn-md" type="button" data-st-f="cancel">Cancel</button>
        <button class="ft-btn ft-btn-md" type="submit">Save</button></div>
    </form>`);
  const form = ov.querySelector('form');
  const err = form.querySelector('.st-err');
  const fav = form.querySelector('[data-st-f="fav"]');
  const refreshPhoto = () => { form.querySelector('.st-photo-img').innerHTML = photo(); };
  form.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-st-f]');
    if (!b) return;
    const act = b.dataset.stF;
    if (act === 'cancel') ov._close();
    else if (act === 'fav') fav.setAttribute('aria-checked', String(fav.getAttribute('aria-checked') !== 'true'));
    else if (act === 'upload') stUploadCover(s, refreshPhoto);
    else if (act === 'frame') stFramePicker(s, refreshPhoto);
    else if (act === 'delete') { if (await stDelete(s)) ov._close(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => form.querySelector(`#${id}`).value;
    const name = v('stfName').trim();
    const yrs = stReadYears(v('stfY1'), v('stfY2'));
    const links = stReadLinks(v('stfUrl'));
    const problem = !name ? 'A studio needs a name.'
      : yrs.error || links.error || stTextTooLong([v('stfAka'), v('stfDesc'), v('stfNotes'), v('stfUrl')]);
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    const patch = {
      name, aliases: stReadAliases(v('stfAka')),
      urls: links.list, description: v('stfDesc').trim(), notes: v('stfNotes').trim(),
      yearStart: yrs.a, yearEnd: yrs.b, favorite: fav.getAttribute('aria-checked') === 'true',
    };
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    let r;
    try { r = await stApi(`/api/studios/${s.id}`, { method: 'POST', json: patch }); }
    catch (ex) { btn.disabled = false; err.textContent = ex.message; err.hidden = false; return; }
    Object.assign(s, r, { people: r.people || s.people });
    stRemember([r]);
    ov._close();
    showToast('Saved.');
    if (ST.studioId === s.id) { if (ST.studio && ST.studio !== s) Object.assign(ST.studio, r, { people: r.people || ST.studio.people }); stPaintPage(); }
    if (stInStudios() && ST.studioId == null) stLoadList();
  });
  form.querySelector('#stfName').focus();
}

/* ── People in a studio (studio page and person page) ─────────────────── */

/**
 * The years card from S4 ("Barack Obama at The White House", From / to, Save).
 * `from` says which page it opened on, so the link goes to the other side.
 */
function stYearsPop(anchor, { studio, person, from }) {
  const pname = person.name || 'This person';
  const openOther = from === 'studio'
    ? (person.name ? `Open <span class="ft-pm-name">${stEsc(person.name)}</span>` : 'Open their page')
    : `Open <span class="ft-pm-name">${stEsc(studio.name)}</span>`;
  const pop = stPop(anchor, `
    <p class="st-yrs-p"><b class="ft-pm-name">${stEsc(pname)}</b> at <b class="ft-pm-name">${stEsc(studio.name)}</b></p>
    ${stYearsInputs('styA', 'styB', person.yearStart, person.yearEnd, 'From')}
    <div class="st-err" role="alert" hidden></div>
    <div class="st-pop-acts">
      <button class="ft-link st-open-other" type="button" data-st-y="open">${openOther}</button>
      ${person.explicit ? `<button class="ft-btn ghost" type="button" data-st-y="remove">Take out</button>` : ''}
      <button class="ft-btn" type="button" data-st-y="save">Save</button>
    </div>`, 'Years in this studio');
  pop.classList.add('st-yrs');
  const err = pop.querySelector('.st-err');
  const save = async () => {
    const y = stReadYears(pop.querySelector('#styA').value, pop.querySelector('#styB').value);
    if (y.error) { err.textContent = y.error; err.hidden = false; return; }
    try { await stApi(`/api/studios/${studio.id}/people`, { method: 'POST', json: { personId: person.id, yearStart: y.a, yearEnd: y.b } }); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; return; }
    stClosePops();
    stAfterPeopleChange();
  };
  pop.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); save(); } });
  pop.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-st-y]');
    if (!b) return;
    const act = b.dataset.stY;
    if (act === 'save') { save(); return; }
    if (act === 'open') {
      stClosePops();
      if (from === 'studio') facesOpenPerson(person.id, { fromStudio: { id: studio.id, name: studio.name } }); else stOpenStudio(studio.id);
      return;
    }
    if (act === 'remove') {
      try { await stApi(`/api/studios/${studio.id}/people/${person.id}/remove`, { method: 'POST' }); }
      catch (ex) { stToastError(ex); return; }
      stClosePops();
      stAfterPeopleChange();
    }
  });
  pop.querySelector('#styA').focus();
}

/** A membership changed: repaint whichever page is open. */
function stAfterPeopleChange() {
  if (stInStudios() && ST.studioId != null) stLoadStudio();
  if (ftOnTab() && FT.mode === 'people' && FT.personId != null && typeof ftReloadPersonDetails === 'function') ftReloadPersonDetails();
}

/** "+ Add a person" on a studio page: the people search, as in Merge with. */
function stAddPerson(anchor) {
  const s = ST.studio;
  if (!s) return;
  const pop = stPop(anchor, `
    <div class="fpop-title">Add a person</div>
    <input type="text" class="ft-field ft-pop-search" placeholder="Search people by name" aria-label="Search people by name" autocomplete="off">
    <div class="ft-pop-list" role="listbox" aria-label="People"></div>`, 'Add a person');
  const input = pop.querySelector('input');
  const listEl = pop.querySelector('.ft-pop-list');
  const have = new Set((s.people || []).filter(p => p.explicit).map(p => p.id));
  let seq = 0, rows = [];
  const load = async () => {
    const q = ++seq;
    const v = input.value.trim();
    const qs = new URLSearchParams({ filter: 'all', sort: v ? 'name' : 'files', q: v, limit: '12' });
    let r;
    try { r = await facesApi(`/api/faces/people?${qs}`, { background: true }); }
    catch (err) {
      if (q !== seq) return;
      listEl.innerHTML = `<div class="ft-drop-note">${err.code === 'FACES_OFF' || !facesReady() ? 'Turn on face search to add people to studios.' : stEsc(err.message || 'Could not load people.')}</div>`;
      return;
    }
    if (q !== seq) return;
    rows = (r.people || []).filter(p => !have.has(p.id)).slice(0, 8);
    listEl.innerHTML = rows.length ? rows.map((p, i) => `<button class="ft-opt" type="button" role="option" data-pick="${i}">${ftCropImg(p.coverUrl)}<span class="${p.name ? '' : 'ft-muted'}">${p.name ? stEsc(p.name) : 'Not named yet'}</span><span>${stPlural(p.files, 'file', 'files')}</span></button>`).join('')
      : '<div class="ft-drop-note">No one matches.</div>';
  };
  input.addEventListener('input', debounce(load, 150));
  listEl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const p = rows[Number(b.dataset.pick)];
    stClosePops();
    try { await stApi(`/api/studios/${s.id}/people`, { method: 'POST', json: { personId: p.id } }); }
    catch (err) { stToastError(err); return; }
    showToast(stNamesHidden() || !p.name ? 'Added to this studio.' : `Added ${p.name} to ${s.name}.`);
    stAfterPeopleChange();
  });
  input.focus();
  load();
}

/** Person page: "+ Add to a studio". */
function stAddPersonToStudio(anchor, person) {
  // Every studio on their chips (added, or found in its files): its chip sets the years.
  const have = new Set((person.studios || []).map(x => x.id));
  stPicker(anchor, {
    title: 'Add to a studio', already: have,
    onPick: async (s) => {
      try { await stApi(`/api/studios/${s.id}/people`, { method: 'POST', json: { personId: person.id } }); }
      catch (err) { stToastError(err); return; }
      showToast(stNamesHidden() ? 'Added to the studio.' : `Added to ${s.name}.`);
      stAfterPeopleChange();
    },
  });
}

/** Person page: the studio chips row (S4/S5). */
function stPersonChipsHtml(p) {
  const chips = (p.studios || []).map(s => {
    const yrs = stYears(s.yearStart, s.yearEnd);
    return `<span class="st-chip">
      <button class="st-chip-main" type="button" data-st-chip="${s.id}" aria-haspopup="dialog">${stCoverHtml(s, 'st-chip-img')}<span class="st-pm">${stEsc(s.name)}</span>${yrs ? ` <span class="st-chip-yr">${yrs}</span>` : ''}</button>
      ${s.explicit ? `<button class="st-chip-x" type="button" data-st-chip-x="${s.id}" aria-label="Remove from studio" title="Remove from studio">✕</button>` : ''}
    </span>`;
  }).join('');
  return `<div class="st-chips-row">${chips}<button class="st-addst" type="button" data-st-addto>+ Add to a studio</button></div>`;
}

/* ── Studio picker (selection bar, File Info row, person page, Merge with) ── */

/**
 * Search studios and pick one; "New studio called X" makes one first.
 * opts: title, placeholder, allowNew, exclude (id or Set), already (Set of ids
 * shown as "Already in X", not pickable), clear (label of the red "take out"
 * row), above (open above the anchor), onPick(studio), onClear()
 */
function stPicker(anchor, { title = '', placeholder = 'Find or make a studio', allowNew = true, exclude = null, already = null, clear = '', above = false, onPick, onClear } = {}) {
  const pop = stPop(anchor, `
    ${title ? `<div class="fpop-title">${stEsc(title)}</div>` : ''}
    <input type="text" class="ft-field ft-pop-search st-pop-input" placeholder="${stEsc(placeholder)}" aria-label="${stEsc(placeholder)}" autocomplete="off">
    <div class="ft-pop-list st-pick-list" role="listbox" aria-label="Studios"></div>`, title || 'Studios', { above });
  const input = pop.querySelector('input');
  const listEl = pop.querySelector('.st-pick-list');
  const skip = (id) => exclude instanceof Set ? exclude.has(id) : exclude === id;
  let seq = 0, opts = [], hi = 0;
  const paint = () => {
    listEl.innerHTML = opts.map((o, i) => {
      const cls = `ft-opt st-opt${i === hi ? ' hi' : ''}${o.clear ? ' st-rm' : ''}`;
      if (o.already) return `<button class="ft-opt st-opt st-already" type="button" role="option" aria-disabled="true" disabled>${stCoverHtml(o.already, 'st-opt-img')}<div class="st-newtext">Already in <i class="st-pm st-newname">${stEsc(o.already.name)}</i></div></button>`;
      if (o.studio) return `<button class="${cls}" type="button" role="option" aria-selected="${i === hi}" data-i="${i}">${stCoverHtml(o.studio, 'st-opt-img')}<span class="st-pm">${stEsc(o.studio.name)}</span><span class="st-opt-n">${stPlural(o.studio.files, 'file', 'files')}</span></button>`;
      if (o.name) return `<button class="${cls}" type="button" role="option" aria-selected="${i === hi}" data-i="${i}"><span class="st-plus" aria-hidden="true">+</span><div class="st-newtext">New studio called "<i class="st-pm st-newname">${stEsc(o.name)}</i>"</div></button>`;
      return `<button class="${cls}" type="button" role="option" aria-selected="${i === hi}" data-i="${i}">${stEsc(clear)}</button>`;
    }).join('') || '<div class="ft-drop-note">No studios yet. Type a name to make one.</div>';
  };
  const load = async () => {
    const q = ++seq;
    const v = input.value.trim();
    const qs = new URLSearchParams({ q: v, sort: v ? 'name' : 'files', filter: 'all', limit: '50' });
    let list = [];
    try { list = (await stApi(`/api/studios?${qs}`, { background: true })).studios || []; }
    catch (err) { if (q === seq) { listEl.innerHTML = `<div class="ft-drop-note">${stEsc(err.message)}</div>`; } return; }
    if (q !== seq) return;
    stRemember(list);
    // An exact name (case and spaces aside) never offers a new studio, even one left out below.
    const key = (x) => String(x || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const exact = list.some(s => key(s.name) === key(v));
    list = list.filter(s => !skip(s.id)).slice(0, 8);
    opts = list.map(s => (already && already.has(s.id) ? { already: s } : { studio: s }));
    if (allowNew && v && !exact) opts.push({ name: v });
    if (clear) opts.push({ clear: true });
    hi = Math.max(0, opts.findIndex(o => !o.already));
    paint();
  };
  const choose = async (o) => {
    if (!o || o.already) return;
    stClosePops();
    if (o.clear) { if (onClear) onClear(); return; }
    if (o.studio) { onPick(o.studio); return; }
    let s;
    try { s = await stApi('/api/studios', { method: 'POST', json: { name: o.name } }); }
    catch (err) {
      const other = err.data && (err.data.other || err.data.studio);
      if (err.code === 'NAME_TAKEN' && other && other.id != null) s = other;
      else { stToastError(err); return; }
    }
    stRemember([s]);
    onPick(s);
  };
  input.addEventListener('input', debounce(load, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!opts.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      for (let n = 0; n < opts.length; n++) { hi = (hi + step + opts.length) % opts.length; if (!opts[hi].already) break; }
      paint();
    } else if (e.key === 'Enter') { e.preventDefault(); choose(opts[hi]); }
  });
  listEl.addEventListener('mousedown', (e) => e.preventDefault());
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) choose(opts[Number(b.dataset.i)]);
  });
  input.focus();
  load();
  return pop;
}

/* ── Putting files in a studio ────────────────────────────────────────── */

/** Selection bar button (Library tab). */
function studiosSelectionButton() {
  return '<button class="sel-btn sel-studio" type="button" onclick="studiosSelectionPick(this)" title="Put the selected files in a studio">' + (typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel('🏢 Studio ▾') : '🏢 Studio ▾') + '</button>';
}

function studiosSelectionPick(btn) {
  const ids = [...selectedIds];
  if (!ids.length) return;
  btn.classList.add('on');
  const pop = stPicker(btn, {
    above: true, clear: ids.length === 1 ? 'Take it out of its studio' : 'Take these out of their studio',
    onPick: (s) => stAssign(ids, s), onClear: () => stAssign(ids, null),
  });
  pop._onClose = () => btn.classList.remove('on');
}

/** Set (or clear) the studio of these files. @returns whether it worked */
async function stAssign(ids, studio) {
  try {
    for (let i = 0; i < ids.length; i += ST_IDS_CHUNK) {
      await stApi('/api/media/studio', { method: 'POST', json: { ids: ids.slice(i, i + ST_IDS_CHUNK), studioId: studio ? studio.id : null } });
    }
  } catch (err) { stToastError(err); return false; }
  if (studio) stRemember([studio]);
  const files = stPlural(ids.length, 'file', 'files');
  if (!studio) showToast(ids.length === 1 ? 'Took the file out of its studio.' : `Took ${files} out of their studio.`);
  else showToast(stNamesHidden() ? `Put ${files} in a studio.` : `Put ${files} in ${studio.name}.`);
  await stRefreshRows(ids);
  return true;
}

/** Fresh rows for files whose studio changed: tiles and open File Info rows. */
async function stRefreshRows(ids) {
  const cached = ids.filter(id => typeof Library !== 'undefined' && Library.row(id)).slice(0, 2000);
  if (cached.length) { try { await Library.fetchRows(cached, { force: true }); } catch {} }
  if (typeof renderResults === 'function') renderResults();
  const want = new Set(ids);
  document.querySelectorAll('[data-st-detail]').forEach(el => {
    const id = Number(el.dataset.stDetail);
    if (want.has(id)) stLoadDetail(id, true);
  });
  if (stInStudios()) { if (ST.studioId != null) stLoadStudio(); else stLoadList(); }
}

/* ── File Info "Studio" row (detail-view.js) and tile tags (cards.js) ─── */

/**
 * What a row says about its studio: {id,name}, null for none, undefined when
 * the row does not say (then GET /api/media/:id is asked).
 */
function stMediaStudio(m) {
  if (!m) return undefined;
  if (m.studio !== undefined) return m.studio && m.studio.id != null ? { id: m.studio.id, name: m.studio.name || ST.names.get(m.studio.id) } : null;
  if (m.studio_id === null) return null;
  if (m.studio_id != null) {
    const name = m.studio_name || ST.names.get(m.studio_id);
    return name ? { id: m.studio_id, name } : { id: m.studio_id, name: null };
  }
  return undefined;
}

function stDetailValHtml(s) {
  const edit = `<button class="st-detail-edit" type="button" data-st-detail-edit title="${s ? 'Change studio' : 'Put this file in a studio'}" aria-label="${s ? 'Change studio' : 'Put this file in a studio'}">${typeof vaultPanelIconSwap === 'function' ? vaultPanelIconSwap('✎', 'edit') : '✎'}</button>`;
  if (s === undefined) return '<span class="field-empty">…</span>';
  if (!s) return `<span class="field-empty">None</span>${edit}`;
  return `<button class="st-detail-link" type="button" data-st-detail-open="${s.id}" title="Open this studio"><span class="st-pm">${stEsc(s.name || 'Studio')}</span></button>${edit}`;
}

function studiosDetailItemHtml(media) {
  if (!media || media.media_type === 'mix') return '';
  const s = stMediaStudio(media);
  if (s === undefined || (s && !s.name)) setTimeout(() => stLoadDetail(media.id), 0);
  return `<div class="detail-item detail-item--wide st-detail" data-st-detail="${media.id}"><label>Studio</label><span class="st-detail-val">${stDetailValHtml(s && !s.name ? undefined : s)}</span></div>`;
}

async function stLoadDetail(id, force = false) {
  const boxes = () => document.querySelectorAll(`[data-st-detail="${id}"] .st-detail-val`);
  if (!boxes().length) return;
  let s;
  const cached = !force && typeof Library !== 'undefined' ? Library.row(id) : null;
  s = cached ? stMediaStudio(cached) : undefined;
  if (s === undefined || (s && !s.name)) {
    try { s = stMediaStudio(await stApi(`/api/media/${id}`, { background: true })); } catch { s = undefined; }
  }
  if (s && !s.name) {
    try { const full = await stApi(`/api/studios/${s.id}`, { background: true }); s = { id: full.id, name: full.name }; stRemember([full]); }
    catch { s = null; }
  }
  if (s === undefined) s = null;   // the server does not know studios yet
  boxes().forEach(el => { el.innerHTML = stDetailValHtml(s); });
}

/** Library tiles: the studio's name at the bottom-left (not inside the Faces tab). */
function studiosTileTagHtml(media) {
  if (ftOnTab()) return '';
  const s = stMediaStudio(media);
  if (!s || !s.name) return '';
  return `<span class="st-tag">${stEsc(s.name)}</span>`;
}

/* ── Put files in studios by folder name (S3) ─────────────────────────── */

async function stAutoMatch() {
  // One dialog at a time: opening it again replaces the one already up.
  document.getElementById('stAutoDlg')?._close();
  const ov = stOverlay(`
    <div class="ft-dlg st-dlg st-auto" role="dialog" aria-modal="true" aria-labelledby="stAutoTitle">
      <h2 id="stAutoTitle">Put files in studios by folder name</h2>
      <p class="st-auto-p">Looking through your folders…</p>
      <div class="st-tbl"></div>
      <div class="st-dacts"><button class="ft-btn ghost ft-btn-md" type="button" data-st-a="cancel">Cancel</button>
        <button class="ft-btn ft-btn-md" type="button" data-st-a="apply" disabled>Put files in studios</button></div>
    </div>`);
  ov.id = 'stAutoDlg';
  const p = ov.querySelector('.st-auto-p');
  const tbl = ov.querySelector('.st-tbl');
  const apply = ov.querySelector('[data-st-a="apply"]');
  ov.querySelector('[data-st-a="cancel"]').focus();
  let matches = [];
  // Wired before anything can fail: Cancel works in every state (loading, no match, error).
  ov.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-st-a]');
    if (!b) return;
    if (b.dataset.stA === 'cancel') { ov._close(); return; }
    const pairs = matches.filter((m, i) => tbl.querySelector(`[data-m="${i}"]`)?.checked).map(m => ({ folder: m.folder, studioId: m.studioId }));
    if (!pairs.length) return;
    apply.disabled = true;
    let r;
    try { r = await stApi('/api/studios/auto/apply', { method: 'POST', json: { pairs } }); }
    catch (err) { stToastError(err); apply.disabled = false; return; }
    ov._close();
    const n = Number(r.changed || 0);
    showToast(n ? `Put ${stPlural(n, 'file', 'files')} in studios.` : 'Nothing changed. Those files are already in a studio.');
    // Any cached row may have changed studio: fetch again when next shown.
    if (typeof Library !== 'undefined' && typeof Library.invalidateRows === 'function') Library.invalidateRows();
    if (stInStudios()) { if (ST.studioId != null) stLoadStudio(); else stLoadList(); }
  });
  try { matches = ((await stApi('/api/studios/auto/preview', { method: 'POST', json: {} })).matches || []).filter(m => m.files > 0); }
  catch (err) { p.textContent = err.message || 'Could not look through your folders. Try again.'; return; }
  if (!ov.isConnected) return;
  if (!matches.length) {
    p.textContent = 'No folder names match a studio right now. Studios match folders by their name and their other names. Files already in a studio are left alone.';
    return;
  }
  p.textContent = 'Vault found folders whose names match a studio. Untick any that are wrong. Files already in a studio are left alone.';
  tbl.innerHTML = matches.map((m, i) => `
    <label class="st-tr">
      <input type="checkbox" class="st-cb" data-m="${i}" checked>
      <span class="st-tf" title="${stEsc(m.folder)}">${stEsc(m.folder)}</span><span class="st-arrow" aria-hidden="true">→</span>
      <span class="st-ts st-pm">${stEsc(m.studioName)}</span><span class="st-tn">${stPlural(m.files, 'file', 'files')}</span>
    </label>`).join('');
  const count = () => {
    const n = matches.filter((m, i) => tbl.querySelector(`[data-m="${i}"]`).checked).reduce((t, m) => t + m.files, 0);
    apply.disabled = !n;
    apply.textContent = n ? `Put ${stPlural(n, 'file', 'files')} in studios` : 'Nothing ticked';
  };
  tbl.addEventListener('change', count);
  count();
}

/* ── Popover (one at a time) ───────────────────────────────────────────── */

function stClosePops() {
  const pop = document.getElementById('stPop');
  if (!pop) return;
  pop.remove();
  if (pop._onClose) pop._onClose();
}

function stPop(anchor, html, label, { above = false } = {}) {
  stClosePops();
  if (typeof ftClosePops === 'function') ftClosePops();
  const pop = document.createElement('div');
  pop.className = 'fpop ft-pop st-pop';
  pop.id = 'stPop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  pop.innerHTML = html;
  pop._anchor = anchor;
  document.body.appendChild(pop);
  const a = anchor.getBoundingClientRect();
  const r = pop.getBoundingClientRect();
  const below = a.bottom + 6;
  const up = a.top - 6 - r.height;
  pop.style.left = `${Math.max(8, Math.min(a.left, innerWidth - r.width - 8))}px`;
  if ((above || below + r.height > innerHeight - 8) && up >= 8) {
    // Grows upward as its list fills in, so it never covers what opened it.
    pop.style.bottom = `${innerHeight - a.top + 6}px`;
    pop.style.maxHeight = `${a.top - 14}px`;
  } else {
    pop.style.top = `${Math.max(8, Math.min(below, innerHeight - r.height - 8))}px`;
  }
  return pop;
}

/* ── Events ────────────────────────────────────────────────────────────── */

const stSearchInput = debounce((v) => {
  ST.q = v.trim();
  ST.limit = ST_PAGE;
  stLoadList();
}, 200);

function stWire() {
  const view = ftView();
  if (!view || view._stWired) return;
  view._stWired = true;

  view.addEventListener('input', (e) => {
    if (e.target.id === 'stSearch') stSearchInput(e.target.value);
  });

  view.addEventListener('click', async (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;

    // Person page: studio chips (works in People mode too)
    const chip = t.closest('[data-st-chip]');
    if (chip && FT.person) {
      const s = (FT.person.studios || []).find(x => x.id === Number(chip.dataset.stChip));
      if (s) stYearsPop(chip, { studio: s, person: { id: FT.person.id, name: FT.person.name, yearStart: s.yearStart, yearEnd: s.yearEnd, explicit: s.explicit }, from: 'person' });
      return;
    }
    const chipX = t.closest('[data-st-chip-x]');
    if (chipX && FT.person) {
      const sid = Number(chipX.dataset.stChipX);
      try { await stApi(`/api/studios/${sid}/people/${FT.person.id}/remove`, { method: 'POST' }); }
      catch (err) { stToastError(err); return; }
      stAfterPeopleChange();
      return;
    }
    const addTo = t.closest('[data-st-addto]');
    if (addTo && FT.person) { stAddPersonToStudio(addTo, FT.person); return; }

    if (!stInStudios()) return;
    const filter = t.closest('[data-st-filter]');
    if (filter) { ST.filter = filter.dataset.stFilter; ST.limit = ST_PAGE; stPaintChips(); stLoadList(); return; }
    const sortBtn = t.closest('#stSortBtn');
    if (sortBtn) {
      const r = sortBtn.getBoundingClientRect();
      facesMenu(r.left, r.bottom + 4, ST_SORTS.map(s => ({
        label: `${s.value === ST.sort ? '✓ ' : ''}${s.label}`,
        run: () => { ST.sort = s.value; stPaintSort(); stLoadList(); },
      })));
      return;
    }
    const nw = t.closest('[data-st-new]');
    if (nw) { stNewStudio(nw); return; }
    if (t.closest('[data-st-auto]')) { stAutoMatch(); return; }
    if (t.closest('[data-st-showmore]')) { ST.limit += ST_PAGE; stLoadList(); return; }
    const card = t.closest('.st-card');
    if (card) { stOpenStudio(Number(card.dataset.studio)); return; }

    // Studio page
    if (t.closest('[data-st-home]')) { stCloseStudio(); return; }
    const s = ST.studio;
    if (!s) return;
    const play = t.closest('[data-st-play]');
    if (play) { ftPlay(play.dataset.stPlay === '1', ST.filesReady); return; }
    if (t.closest('[data-st-fav]')) { if (await stPost({ favorite: !s.favorite })) stPaintPage(); return; }
    if (t.closest('[data-st-edit]')) { stEditStudio(s); return; }
    const more = t.closest('[data-st-more]');
    if (more) { e.stopPropagation(); stMoreMenu(more); return; }
    const cover = t.closest('[data-st-cover]');
    if (cover) { e.stopPropagation(); stCoverMenu(cover, s); return; }
    const addP = t.closest('[data-st-addperson]');
    if (addP) { stAddPerson(addP); return; }
    const who = t.closest('[data-st-who]');
    if (who) {
      const p = (s.people || []).find(x => x.id === Number(who.dataset.stWho));
      if (p) stYearsPop(who, { studio: s, person: p, from: 'studio' });
      return;
    }
    const kind = t.closest('[data-st-kind]');
    if (kind && kind.dataset.stKind !== ST.kind) {
      ST.kind = kind.dataset.stKind;
      stPaintPage();
      ST.filesReady = applyFilters();
    }
  });

  view.addEventListener('keydown', (e) => {
    const card = e.target instanceof Element && e.target.classList.contains('st-card') ? e.target : null;
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); stOpenStudio(Number(card.dataset.studio)); }
  });
}

// File Info rows live in the library modal and the player sidebar.
document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return;
  const open = t.closest('[data-st-detail-open]');
  const edit = t.closest('[data-st-detail-edit]');
  if (!open && !edit) return;
  const box = t.closest('[data-st-detail]');
  const id = box ? Number(box.dataset.stDetail) : null;
  if (open) {
    if (t.closest('#mediaSidebarBody')) { if (typeof minimizePlayer === 'function') minimizePlayer(); }
    else if (typeof closeModal === 'function') closeModal();
    stOpenStudio(Number(open.dataset.stDetailOpen));
    return;
  }
  if (id == null) return;
  stPicker(edit, { clear: 'Take it out of its studio', onPick: (s) => stAssign([id], s), onClear: () => stAssign([id], null) });
}, true);   // capture: the modal stops clicks from bubbling out of it

// Outside clicks close the popover; Esc too.
document.addEventListener('mousedown', (e) => {
  const pop = document.getElementById('stPop');
  if (!pop) return;
  const t = e.target instanceof Element ? e.target : null;
  if (!t || pop.contains(t) || (pop._anchor && pop._anchor.contains(t)) || t.closest('#facesMenu')) return;
  stClosePops();
}, true);

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !document.getElementById('stPop')) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const a = document.getElementById('stPop')._anchor;
  stClosePops();
  if (a && a.isConnected) a.focus({ preventScroll: true });
}, true);

window.addEventListener('resize', () => stClosePops());

// Studio names for tile tags and File Info rows, once at start.
async function stLoadNames() {
  try { stRemember((await stApi('/api/studios?sort=name&filter=all&limit=1000', { background: true })).studios); } catch {}
  if (typeof renderResults === 'function' && typeof Library !== 'undefined' && Library.length && Library.length()) renderResults();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { stWire(); stLoadNames(); });
else { stWire(); stLoadNames(); }
