/* =========================================================================
   FACES REVIEW - one face at a time (FACES_REVIEW_SPEC, round 4, part B).

   Search finds, review files: nothing here adds faces to a person in bulk.
   Every add shows the actual face and nothing starts as Yes.

     facesReviewOpen()     "Is this X?" panel over the face results (F2a),
                           from the banner's "Review N faces"
     facesCompareOpen()    the results that are other named people, side by
                           side with the target (F3), from "Compare"
     facesPersonPicker()   "Add to someone else…": a name search over people
                           + "New person", the Faces tab's name field
     frCardHtml() + frKeys()  the face card and its keys, shared with the
                           person page's "Is this X?" (faces-tab.js, F2b)
     frShowFrame()         the whole frame or photo with the face box

   Keys (Y, N, left/right) only work while focus is inside a card list; no
   global keydown. Server: POST /api/faces/check-faces (card details),
   /people/:id/review-faces (Yes / No), /people/:id/move (Compare),
   /people/merge.
   ========================================================================= */

const FR_PAGE = 60;           // review cards fetched at a time (check-faces takes 200 at most)
const FR_YES_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M5 12l5 5 9-10"></path></svg>';
const FR_NO_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';
const FR_X_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>';

/**
 * The visible part of the page as --fr-vx / --fr-vy / --fr-vw / --fr-vh: on
 * a phone the page can be wider (and so taller) than the screen, and a fixed
 * panel or bar sized to the page would end past the screen's edge.
 */
function frSyncViewport() {
  // Some browsers (and a hidden pane) report a 0-sized visual viewport: then the window's size.
  const v = window.visualViewport && window.visualViewport.width > 0 && window.visualViewport.height > 0 ? window.visualViewport : null;
  const st = document.documentElement.style;
  st.setProperty('--fr-vw', `${Math.round(v ? v.width : window.innerWidth)}px`);
  st.setProperty('--fr-vh', `${Math.round(v ? v.height : window.innerHeight)}px`);
  st.setProperty('--fr-vx', `${Math.round(v ? v.offsetLeft : 0)}px`);
  st.setProperty('--fr-vy', `${Math.round(v ? v.offsetTop : 0)}px`);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', frSyncViewport);
  window.visualViewport.addEventListener('scroll', frSyncViewport);
}
window.addEventListener('resize', frSyncViewport);
document.addEventListener('visibilitychange', () => { if (!document.hidden) frSyncViewport(); });
frSyncViewport();
const frVw = () => (window.visualViewport && window.visualViewport.width > 0 ? window.visualViewport.width : window.innerWidth);

const frEsc = (s) => escapeHtml(String(s ?? ''));
const frName = (name) => `<span class="ft-pm-name">${frEsc(name)}</span>`;
/** "Barack Obama" (privacy-wrapped), or "this person" while there is no name. */
const frWho = (T) => (T && T.name ? frName(T.name) : 'this person');
/** For aria-labels and other plain text: no names while names are private. */
const frWhoText = (T) => (T && T.name && !document.body.classList.contains('pm-names') ? T.name : 'this person');
const frPlural = (n, one, many) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

/* ── Cards ─────────────────────────────────────────────────────────────── */

/** "beach_day_04.jpg" or "interview_2019.mp4 · at 3:12". */
function frMetaText(it) {
  const at = it.mediaType === 'video' && it.timeS != null ? ` · at ${formatDuration(it.timeS) || '0:00'}` : '';
  return `${it.filename || ''}${at}`;
}

function frSrcThumb(mediaId) {
  if (mediaId == null) return '';
  if ((typeof thumbsOff === 'function' && thumbsOff())) return '';
  const row = typeof getMediaById === 'function' ? getMediaById(mediaId) : null;
  const attrs = typeof thumbImgAttrs === 'function' ? thumbImgAttrs(row || { id: mediaId }) : `src="/thumb/${Number(mediaId)}"`;
  return `<span class="fr-src"><img class="fr-src-img" ${attrs} alt="" loading="lazy" onerror="this.parentElement.remove()"></span>`;
}

/**
 * One face card. it: { key, cropUrl, mediaId, filename, mediaType, timeS,
 * tier, files }. ans: 'yes' | 'no' | undefined (nothing starts decided).
 * o.yes / o.no: the two answers' labels; o.stacked puts them one above the
 * other (Compare); o.noLine shows "Not X" over a No (the review).
 */
function frCardHtml(it, ans, o = {}) {
  const yes = ans === 'yes', no = ans === 'no';
  const yesLabel = o.yes || 'Yes', noLabel = o.no || 'No';
  const more = it.files > 1 ? ` · ${frPlural(it.files, 'file', 'files')}` : '';
  const crop = it.cropUrl ? `<img class="face-crop" src="${frEsc(it.cropUrl)}" alt="" loading="lazy" draggable="false">`
    : '<span class="ft-blank" aria-hidden="true">👤</span>';
  return `
    <div class="fr-card${yes ? ' is-yes' : ''}${no && o.noLine !== false ? ' is-no' : ''}" data-fr-key="${frEsc(it.key)}">
      <div class="fr-face">
        <button type="button" class="fr-face-btn" data-fr-frame aria-label="${it.mediaType === 'video' ? 'See the whole frame' : 'See the whole photo'}">${crop}</button>
        ${frSrcThumb(it.mediaId)}
        ${it.tier === 'likely' && o.strong !== false ? '<span class="fr-strong">Strong match</span>' : ''}
        ${no && o.noLine !== false ? `<span class="fr-noline">Not ${o.who || 'this person'}</span>` : ''}
      </div>
      <div class="fr-meta">${frEsc(frMetaText(it))}${more}</div>
      <div class="fr-yn${o.stacked ? ' is-stacked' : ''}">
        <button type="button" class="${yes ? 'on-yes' : ''}" data-fr-ans="yes" aria-pressed="${yes}">${o.stacked ? '' : FR_YES_SVG} ${yesLabel}</button>
        <button type="button" class="${no ? 'on-no' : ''}" data-fr-ans="no" aria-pressed="${no}">${o.stacked ? '' : FR_NO_SVG} ${noLabel}</button>
      </div>
    </div>`;
}

/**
 * Card list behaviour for a container: clicks on Yes / No and the face, and
 * the keys Y, N, left and right while focus is inside it.
 *   answer(key, 'yes'|'no')  record (a second click on the same answer clears it)
 *   frame(key)               show the whole frame
 */
function frKeys(root, { answer, frame }) {
  if (root._frWired) return;
  root._frWired = true;
  const cards = () => [...root.querySelectorAll('.fr-card')];
  const focusCard = (card) => card && (card.querySelector('.fr-face-btn') || card).focus();
  root.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    const card = t && t.closest('.fr-card');
    if (!card || !root.contains(card)) return;
    const a = t.closest('[data-fr-ans]');
    if (a) { answer(card.dataset.frKey, a.dataset.frAns, { toggle: true }); return; }
    if (t.closest('[data-fr-frame]')) frame(card.dataset.frKey, card);
  });
  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.matches('input, textarea, select')) return;
    const list = cards();
    if (!list.length) return;
    const card = t.closest('.fr-card');
    const i = card ? list.indexOf(card) : -1;
    const k = e.key.toLowerCase();
    if (k === 'y' || k === 'n') {
      const decided = (c) => !!c.querySelector('[data-fr-ans][aria-pressed="true"]');
      // Outside a card: the first face with no answer (none left: nothing to do).
      const at = i >= 0 ? list[i] : list.find(c => !decided(c));
      if (!at) return;
      e.preventDefault();
      e.stopPropagation();   // N is also "next file" while the mini player shows
      const key = at.dataset.frKey;
      answer(key, k === 'y' ? 'yes' : 'no', { toggle: false });
      // The list repaints. Go on to the next face with no answer yet (after
      // this one, else from the top), so a second key press never changes
      // the answer just given; with every face answered, stay here.
      const again = cards();
      const pos = again.findIndex(c => c.dataset.frKey === key);
      const nextOpen = again.slice(pos + 1).find(c => !decided(c)) || again.slice(0, Math.max(0, pos)).find(c => !decided(c));
      if (nextOpen) focusCard(nextOpen);
      else (root.querySelector('[data-fr-add]:not(:disabled), [data-fc-move]:not(:disabled), [data-ft-might="add"]:not(:disabled), [data-ft-check="save"]:not(:disabled)') || again[pos].querySelector('.fr-face-btn')).focus();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      if (t.closest('.fr-yn') && !card) return;
      e.preventDefault();
      e.stopPropagation();
      const j = i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
      focusCard(list[j]);
    }
  });
}

/**
 * A section heading with its bulk buttons on the right, the same in every
 * review section: [{ attr, label, disabled }] (attr: the data attribute the
 * section's own click handler reads).
 */
function frSectionHead(title, note, buttons = []) {
  return `<div class="fr-secth"><h3>${title}</h3>${note ? `<span>${note}</span>` : ''}
    ${buttons.length ? `<span class="fr-secth-acts">${buttons.map(b => `<button type="button" class="ft-btn ghost ft-btn-md" ${b.attr}${b.disabled ? ' disabled' : ''}>${b.label}</button>`).join('')}</span>` : ''}</div>`;
}

/* ── The whole frame / photo with the face box ─────────────────────────── */

/** it: { mediaId, mediaType, timeS, bbox [x, y, w, h] as fractions, filename } */
function frShowFrame(it, opener) {
  document.getElementById('frFrame')?._close();
  frSyncViewport();
  if (!it || it.mediaId == null) return;
  const ov = document.createElement('div');
  ov.id = 'frFrame';
  ov.className = 'fr-frame-ov';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', it.mediaType === 'video' ? 'The whole frame' : 'The whole photo');
  const b = Array.isArray(it.bbox) && it.bbox.length === 4 ? it.bbox.map(Number) : null;
  const box = b ? `<span class="fr-box" style="left:${(b[0] * 100).toFixed(2)}%;top:${(b[1] * 100).toFixed(2)}%;width:${(b[2] * 100).toFixed(2)}%;height:${(b[3] * 100).toFixed(2)}%"></span>` : '';
  const src = `/media/${Number(it.mediaId)}`;
  const media = it.mediaType === 'video'
    ? `<video class="fr-frame-media" src="${src}#t=${Number(it.timeS || 0).toFixed(2)}" muted playsinline preload="auto"></video>`
    : `<img class="fr-frame-media" src="${src}" alt="">`;
  ov.innerHTML = `
    <div class="fr-frame">
      <div class="fr-frame-box">${media}${box}</div>
      <div class="fr-frame-cap"><span class="fr-frame-name">${frEsc(frMetaText(it))}</span>
        <button type="button" class="faces-bghost" data-fr-close>Close</button></div>
    </div>`;
  document.body.appendChild(ov);
  const v = ov.querySelector('video');
  if (v) v.addEventListener('loadedmetadata', () => { try { v.currentTime = Number(it.timeS || 0); } catch {} }, { once: true });
  const done = () => {
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    ov.remove();
    if (opener && opener.isConnected) opener.focus();
  };
  ov._close = done;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) done(); });
  ov.querySelector('[data-fr-close]').addEventListener('click', done);
  ov.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); }
    else if (e.key === 'Tab') { e.preventDefault(); ov.querySelector('[data-fr-close]').focus(); }
  });
  ov.querySelector('[data-fr-close]').focus();
}

/* ── "Add to someone else…" ────────────────────────────────────────────── */

let frPicker = null;   // the open popover element

function facesPersonPickerClose() {
  if (frPicker && typeof FT !== 'undefined' && FT.naming && frPicker.contains(FT.naming.host)) ftCloseNaming();
  frPicker?.remove();
  frPicker = null;
}

/**
 * A name search over people + 'New person "text"', in a popover above
 * `anchor`. onChosen({ id, name }) (id null = a new person with that name)
 * does the adding and answers true when it went through.
 */
function facesPersonPicker({ anchor, label, excludeId = null, onChosen }) {
  facesPersonPickerClose();
  if (typeof ftStartNaming !== 'function') return;
  const pop = document.createElement('div');
  pop.className = 'fr-pick';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', label);
  pop.innerHTML = `<div class="fr-pick-label">${frEsc(label)}</div><span class="fr-pick-host"><span class="fr-pick-anchor"></span></span>`;
  document.body.appendChild(pop);
  frPicker = pop;
  const r = anchor.getBoundingClientRect();
  const vw = frVw();
  const w = Math.min(320, vw - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(r.right - w, vw - w - 8))}px`;
  pop.style.bottom = `${Math.max(8, innerHeight - r.top + 8)}px`;
  const host = pop.querySelector('.fr-pick-host');
  const finish = async (to) => {
    const ok = await onChosen(to);
    if (ok) facesPersonPickerClose();
    else anchor.focus();
    return ok;
  };
  ftStartNaming({
    host, anchor: host.firstElementChild, id: excludeId, placeholder: 'Type a name',
    newLabel: (v) => `New person "${v}"`,
    pickPerson: (p) => { finish({ id: p.id, name: p.name || null }); },
    // A new name: nobody is made until the faces are added (one request).
    save: async (name) => {
      const ok = await finish({ id: null, name });
      if (!ok) throw Object.assign(new Error(''), { code: 'NOT_ADDED' });
      return { id: null, name };
    },
    onClose: () => {
      if (frPicker === pop) { pop.remove(); frPicker = null; }
      // Esc or a pick: back to the button, so the panel's own keys keep working.
      const a = document.activeElement;
      if ((!a || a === document.body) && anchor.isConnected) anchor.focus();
    },
  });
}

/* ── "Is this X?" over the face results (F2a) ──────────────────────────── */

let FR = null;   // { el, opener, T, gids, items: Map gid -> item, loaded, seq, answers (the focus's) }

function frAnswersOf(f) {
  if (!f.reviewAnswers) f.reviewAnswers = new Map();   // group id -> 'yes' | 'no' (kept while these results show)
  return f.reviewAnswers;
}

function facesReviewClose() {
  if (!FR) return;
  const { el, opener } = FR;
  if (typeof FT !== 'undefined' && FT.naming && el.contains(FT.naming.host)) ftCloseNaming();
  facesPersonPickerClose();
  document.getElementById('frFrame')?._close();
  FR = null;
  el.remove();
  document.getElementById('frBackdrop')?.remove();
  if (opener && opener.isConnected) opener.focus();
}

/** "Review N faces": the panel. With no one to compare with yet, it asks for a name first. */
function facesReviewOpen(opener) {
  const f = facesFocus;
  if (!f) return;
  facesCompareClose();
  facesReviewClose();
  frSyncViewport();
  const back = document.createElement('div');
  back.id = 'frBackdrop';
  back.className = 'fr-backdrop';
  document.body.appendChild(back);
  const el = document.createElement('aside');
  el.className = 'fr-panel';
  el.id = 'frPanel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'frTitle');
  document.body.appendChild(el);
  FR = { el, opener, T: null, gids: [], items: new Map(), loaded: 0, seq: 0 };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('frFrame')) { e.preventDefault(); e.stopPropagation(); facesReviewClose(); }
  });
  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-fr-x]')) { facesReviewClose(); return; }
    if (t.closest('[data-fr-more]')) { frReviewLoad(); return; }
    if (t.closest('[data-fr-askname]')) { frReviewAskName(); return; }
    if (t.closest('[data-fr-norest]')) {
      // Only the faces shown that have no answer yet.
      const answers = frAnswersOf(facesFocus || f);
      for (const g of FR.gids) if (FR.items.has(g) && !answers.has(g)) answers.set(g, 'no');
      frReviewPaint();
      FR.el.querySelector('[data-fr-add]:not(:disabled)')?.focus();
      return;
    }
    if (t.closest('[data-fr-add]')) { frReviewCommit(t.closest('button')); return; }
    if (t.closest('[data-fr-else]')) { frReviewElse(t.closest('button')); }
  });
  frKeys(el, {
    answer: (key, a, { toggle }) => {
      const answers = frAnswersOf(facesFocus || f);
      const gid = Number(key);
      if (toggle && answers.get(gid) === a) answers.delete(gid); else answers.set(gid, a);
      frReviewPaint();
    },
    frame: (key, card) => frShowFrame(FR && FR.items.get(Number(key)), card.querySelector('.fr-face-btn')),
  });
  const T = facesFocusTarget(f);
  if (!T) { frReviewAskName(); return; }
  frReviewStart(T);
}

/** No person yet (a photo, a face in no one): who is it? The name is used when faces are added. */
function frReviewAskName() {
  const el = FR.el;
  const f = facesFocus;
  el.innerHTML = `
    <div class="fr-head">
      ${f && f.cropUrl ? `<span class="fr-crop"><img class="face-crop" src="${frEsc(f.cropUrl)}" alt=""></span>` : ''}
      <div class="fr-h"><div class="fr-title" id="frTitle">Who is this?</div>
        <div class="fr-note">Give them a name first. Then say Yes or No to each face. Nobody is added until you choose.</div></div>
      <button type="button" class="faces-bghost fr-x" data-fr-x aria-label="Close">${FR_X_SVG}</button>
    </div>
    <div class="fr-body"><span class="fr-name-host"><span class="fr-name-anchor"></span></span></div>`;
  const host = el.querySelector('.fr-name-host');
  ftStartNaming({
    host, anchor: host.firstElementChild, id: null, placeholder: 'Type a name', me: { coverUrl: f && f.cropUrl },
    newLabel: (v) => `New person "${v}"`,
    pickPerson: (p) => { if (facesFocus) facesFocus.named = { id: p.id, name: p.name || null }; frReviewNamed(); },
    save: async (name) => { if (facesFocus) facesFocus.named = { id: null, name }; return { id: null, name }; },
    onDone: () => frReviewNamed(),
    // Closed without a name (Esc, a click elsewhere): a button to try again.
    onClose: () => {
      if (!FR || FR.el !== el || FR.T || (facesFocus && facesFocusTarget(facesFocus))) return;
      const body = el.querySelector('.fr-body');
      if (body) body.innerHTML = '<button type="button" class="faces-addname" data-fr-askname>Add a name</button>';
    },
  });
}

function frReviewNamed() {
  if (!FR || !facesFocus) return;
  renderFocusBar();
  const T = facesFocusTarget(facesFocus);
  if (T) frReviewStart(T); else frReviewAskName();
}

function frReviewStart(T) {
  const f = facesFocus;
  FR.T = T;
  FR.gids = facesBreakdown(f).addable.map(a => a.groupId);
  FR.items = new Map();
  FR.loaded = 0;
  frReviewPaint();
  frReviewLoad().then(() => {
    const first = FR && FR.el.querySelector('.fr-card .fr-face-btn');
    if (first) first.focus(); else FR?.el.querySelector('[data-fr-x]')?.focus();
  });
}

/** The next page of cards (details and "Strong match" from the server). */
async function frReviewLoad() {
  if (!FR) return;
  const st = FR;
  const page = st.gids.slice(st.loaded, st.loaded + FR_PAGE);
  if (!page.length) return;
  const seq = ++st.seq;
  let r;
  try {
    r = await facesApi('/api/faces/check-faces', { method: 'POST', json: { groupIds: page, ...(st.T && st.T.id != null ? { personId: st.T.id } : {}) } });
  } catch (err) { facesToastError(err); return; }
  if (FR !== st || seq !== st.seq) return;
  for (const it of r.items || []) st.items.set(it.groupId, { ...it, key: String(it.groupId) });
  st.loaded += page.length;
  frReviewPaint();
}

function frReviewCounts() {
  const answers = frAnswersOf(facesFocus);
  const shown = FR.gids.filter(g => FR.items.has(g));
  let yes = 0, no = 0;
  for (const g of FR.gids) { const a = answers.get(g); if (a === 'yes') yes++; else if (a === 'no') no++; }
  return { yes, no, open: FR.gids.length - yes - no, shown };
}

function frReviewPaint() {
  if (!FR || !FR.T || !facesFocus) return;
  const el = FR.el;
  const f = facesFocus;
  const T = FR.T;
  const who = frWho(T);
  const answers = frAnswersOf(f);
  const { yes, no, open, shown } = frReviewCounts();
  const b = facesBreakdown(f);
  const others = [...b.others.values()];
  const n = FR.gids.length;
  const hadFocus = el.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = hadFocus && hadFocus.closest('.fr-card') ? hadFocus.closest('.fr-card').dataset.frKey : null;
  const focusAns = hadFocus && hadFocus.dataset ? hadFocus.dataset.frAns : null;
  const cards = shown.map(g => frCardHtml(FR.items.get(g), answers.get(g), { who })).join('');
  const rest = n - FR.loaded;
  const otherN = others.reduce((s, o) => s + o.ids.length, 0);
  const otherNames = others.map(o => frName(o.name));
  const namesText = otherNames.length <= 2 ? otherNames.join(' or ') : `${otherNames.slice(0, -1).join(', ')} or ${otherNames[otherNames.length - 1]}`;
  const main = yes ? `Add ${yes.toLocaleString()} to ${who}` : no ? 'Save my answers' : `Add 0 to ${who}`;
  el.innerHTML = `
    <div class="fr-head">
      ${f.cropUrl ? `<span class="fr-crop"><img class="face-crop" src="${frEsc(f.cropUrl)}" alt=""></span>` : ''}
      <div class="fr-h"><div class="fr-title" id="frTitle">Is this ${who}?</div>
        <div class="fr-note">${n ? `${frPlural(n, 'face that is', 'faces that are')} not in anyone yet. Only the ones you say Yes to are added.` : 'No faces left to review here.'}</div></div>
      <button type="button" class="faces-bghost fr-x" data-fr-x aria-label="Close">${FR_X_SVG}</button>
    </div>
    <div class="fr-body">
      ${shown.length ? frSectionHead('Faces', '', [{ attr: 'data-fr-norest', label: 'No to the rest', disabled: !shown.some(g => !answers.has(g)) }]) : ''}
      <div class="fr-cards" role="list" aria-label="Faces to review">${cards}</div>
      ${rest > 0 ? `<button type="button" class="faces-blink fr-more" data-fr-more>Show ${Math.min(rest, FR_PAGE).toLocaleString()} more</button>` : ''}
      ${shown.length ? '<p class="fr-note fr-keys">Keys: <span class="fr-kbd">Y</span> yes, <span class="fr-kbd">N</span> no, <span class="fr-kbd">←</span> <span class="fr-kbd">→</span> move between faces. Click a face to see the whole frame.</p>' : ''}
      ${otherN ? `<p class="fr-note">The ${otherN.toLocaleString()} that ${otherN === 1 ? 'is' : 'are'} ${namesText} ${otherN === 1 ? 'is' : 'are'} not here. Use Compare for those.</p>` : ''}
    </div>
    <div class="fr-foot">
      <span class="fr-sum"><b>${yes.toLocaleString()}</b> yes, <b>${no.toLocaleString()}</b> no, <b>${open.toLocaleString()}</b> not decided</span>
      <button type="button" class="faces-bghost faces-lg" data-fr-else${yes ? '' : ' disabled'}>Add to someone else…</button>
      <button type="button" class="faces-badd faces-lg" data-fr-add${yes || (no && T.id != null) ? '' : ' disabled'}>${main}</button>
    </div>`;
  if (typeof hydrateThumbs === 'function') hydrateThumbs(el);
  if (focusKey) {
    const card = el.querySelector(`.fr-card[data-fr-key="${focusKey}"]`);
    const target = card && (focusAns ? card.querySelector(`[data-fr-ans="${focusAns}"]`) : card.querySelector('.fr-face-btn'));
    if (target) target.focus();
  } else if (hadFocus && hadFocus.matches('[data-fr-more]')) el.querySelector('.fr-card:last-child .fr-face-btn')?.focus();
}

function frReviewLists() {
  const answers = frAnswersOf(facesFocus);
  const yes = [], no = [];
  for (const g of FR.gids) { const a = answers.get(g); if (a === 'yes') yes.push(g); else if (a === 'no') no.push(g); }
  return { yes, no };
}

/** "Add N to X": the Yes faces join X; the No faces are remembered as not X. */
async function frReviewCommit(btn) {
  if (!FR || !facesFocus) return;
  const { yes, no } = frReviewLists();
  const T = FR.T;
  if (!yes.length && !(no.length && T.id != null)) return;
  btn.disabled = true;
  const r = await facesAddFaces(T, yes, { reject: T.id != null ? no : [] });
  if (!r) { btn.disabled = false; return; }
  if (facesFocus) facesFocus.reviewAnswers = null;
  facesReviewClose();
  await facesAfterAnswer(r);
}

/** "Add to someone else…": the Yes faces go to another person (clearly one person, but not X). */
function frReviewElse(btn) {
  const { yes } = frReviewLists();
  if (!yes.length) return;
  facesPersonPicker({
    anchor: btn, label: `Add ${yes.length === 1 ? 'this face' : `these ${yes.length.toLocaleString()} faces`} to`,
    excludeId: FR.T && FR.T.id != null ? FR.T.id : null,
    onChosen: async (to) => {
      const r = await facesAddFaces(to, yes);
      if (!r) return false;
      if (facesFocus) facesFocus.reviewAnswers = null;
      facesReviewClose();
      await facesAfterAnswer(r);
      return true;
    },
  });
}

/* ── Compare: the results that are other people (F3) ───────────────────── */

let FC = null;   // { el, opener, T, pid, answers: Map gid -> 'move'|'keep', items: Map, people: Map pid -> { files, faces } }

function facesCompareClose() {
  if (!FC) return;
  const { el, opener } = FC;
  document.getElementById('frFrame')?._close();
  FC = null;
  el.remove();
  if (opener && opener.isConnected) opener.focus();
}

function facesCompareOpen(opener) {
  const f = facesFocus;
  const T = facesFocusTarget(f);
  if (!f || !T || T.id == null) return;
  const others = facesBreakdown(f).others;
  if (!others.size) return;
  facesReviewClose();
  facesCompareClose();
  frSyncViewport();
  const el = document.createElement('div');
  el.className = 'fr-cmp-ov';
  el.innerHTML = '<section class="fr-cmp" role="dialog" aria-modal="true" aria-labelledby="fcTitle"></section>';
  document.body.appendChild(el);
  const pid = [...others.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length)[0][0];
  FC = { el, opener, T, pid, answers: new Map(), items: new Map(), people: new Map(), seq: 0 };
  el.addEventListener('mousedown', (e) => { if (e.target === el) facesCompareClose(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('frFrame')) { e.preventDefault(); e.stopPropagation(); facesCompareClose(); }
  });
  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-fc-x]')) { facesCompareClose(); return; }
    const seg = t.closest('[data-fc-person]');
    if (seg) { FC.pid = Number(seg.dataset.fcPerson); frComparePaint(); frCompareLoad(); return; }
    if (t.closest('[data-fc-move]')) { frCompareCommit(t.closest('button')); return; }
    if (t.closest('[data-fc-merge]')) frCompareMerge(t.closest('button'));
  });
  frKeys(el, {
    answer: (key, a, { toggle }) => {
      const gid = Number(key);
      const v = a === 'yes' ? 'move' : 'keep';
      if (toggle && FC.answers.get(gid) === v) FC.answers.delete(gid); else FC.answers.set(gid, v);
      frComparePaint();
    },
    frame: (key, card) => frShowFrame(FC && FC.items.get(Number(key)), card.querySelector('.fr-face-btn')),
  });
  frComparePaint();
  frCompareLoad().then(() => FC?.el.querySelector('.fr-cmp .fr-card .fr-face-btn, [data-fc-x]')?.focus());
}

/** The other person's faces in question, plus both people's sample faces and file counts. */
async function frCompareLoad() {
  if (!FC || !facesFocus) return;
  const st = FC;
  const o = facesBreakdown(facesFocus).others.get(st.pid);
  if (!o) return;
  const seq = ++st.seq;
  const need = o.groups.filter(g => !st.items.has(g)).slice(0, 200);
  const person = async (id, limit) => {
    if (st.people.has(id)) return;
    const [p, faces] = await Promise.all([facesApi(`/api/faces/people/${id}`), facesApi(`/api/faces/people/${id}/faces?limit=${limit}`)]);
    st.people.set(id, { files: p.files || 0, name: p.name || null, faces: faces || [] });
  };
  try {
    const [r] = await Promise.all([
      need.length ? facesApi('/api/faces/check-faces', { method: 'POST', json: { groupIds: need, personId: st.T.id } }) : { items: [] },
      person(st.T.id, 4), person(st.pid, 3),
    ]);
    for (const it of r.items || []) st.items.set(it.groupId, { ...it, key: String(it.groupId) });
  } catch (err) { facesToastError(err); return; }
  if (FC !== st || seq !== st.seq) return;
  frComparePaint();
}

function frComparePaint() {
  if (!FC || !facesFocus) return;
  const st = FC;
  const sec = st.el.querySelector('.fr-cmp');
  const others = facesBreakdown(facesFocus).others;
  if (!others.has(st.pid)) {
    if (!others.size) { facesCompareClose(); return; }
    st.pid = [...others.keys()][0];
  }
  const o = others.get(st.pid);
  const T = st.T;
  const X = frWho(T), Y = frName(o.name);
  const n = o.groups.length;
  const tp = st.people.get(T.id), yp = st.people.get(st.pid);
  const moves = o.groups.filter(g => st.answers.get(g) === 'move').length;
  const keeps = o.groups.filter(g => st.answers.get(g) === 'keep').length;
  const hadFocus = st.el.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = hadFocus && hadFocus.closest('.fr-card') ? hadFocus.closest('.fr-card').dataset.frKey : null;
  const focusAns = hadFocus && hadFocus.dataset ? hadFocus.dataset.frAns : null;
  const faceTile = (x) => `<div class="fr-sample">${x.cropUrl ? `<img class="face-crop" src="${frEsc(x.cropUrl)}" alt="" loading="lazy">` : '<span class="ft-blank" aria-hidden="true">👤</span>'}</div>`;
  const side = (p, name, max) => {
    if (!p) return '<div class="fr-samples"></div>';
    const shown = p.faces.slice(0, max);
    const more = Math.max(0, p.files - shown.length);
    return `<div class="fr-samples">${shown.map(faceTile).join('')}${more && max < 4 ? `<div class="fr-sample fr-sample-more">+ ${more.toLocaleString()} more</div>` : ''}</div>`;
  };
  const cards = o.groups.filter(g => st.items.has(g)).map(g => {
    const a = st.answers.get(g);
    return frCardHtml(st.items.get(g), a === 'move' ? 'yes' : a === 'keep' ? 'no' : undefined,
      { yes: `Move to ${X}`, no: `Keep in ${Y}`, stacked: true, noLine: false, strong: false });
  }).join('');
  const segs = [...others.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length)
    .map(([pid, x]) => `<button type="button" class="settings-seg-btn" data-fc-person="${pid}" aria-pressed="${pid === st.pid}">${frName(x.name)} (${x.ids.length.toLocaleString()})</button>`).join('');
  sec.innerHTML = `
    <div class="fr-cmp-head">
      <div class="fr-h"><div class="fr-title" id="fcTitle">${n === 1 ? `1 face in ${Y} looks` : `${n.toLocaleString()} faces in ${Y} look`} like ${X}</div>
        <div class="fr-note">Nothing moves unless you choose it. ${Y}'s other files stay where they are.</div></div>
      <span class="settings-seg fr-cmp-seg" role="group" aria-label="Person">${segs}</span>
      <button type="button" class="faces-bghost fr-x" data-fc-x aria-label="Close">${FR_X_SVG}</button>
    </div>
    <div class="fr-cmp-grid">
      <div class="fr-cmp-side"><div class="fr-secth"><h3>${X}</h3><span>${tp ? frPlural(tp.files, 'file', 'files') : ''}</span></div>${side(tp, T.name, 4)}</div>
      <div class="fr-cmp-mid"><div class="fr-secth"><h3>${n === 1 ? 'The face in question' : `The ${n.toLocaleString()} in question`}</h3><span>Pick for each one</span></div>
        <div class="fr-cards fr-cmp-cards" role="list" aria-label="Faces in question">${cards}</div></div>
      <div class="fr-cmp-side"><div class="fr-secth"><h3>${Y}</h3><span>${yp ? frPlural(yp.files, 'file', 'files') : ''}</span></div>${side(yp, o.name, 1)}</div>
    </div>
    <div class="fr-foot">
      <span class="fr-sum">Move <b>${moves.toLocaleString()}</b> ${moves === 1 ? 'face' : 'faces'} from ${Y} to ${X}. Keep <b>${keeps.toLocaleString()}</b>.</span>
      <button type="button" class="faces-bghost faces-lg" data-fc-merge>They are the same person: merge…</button>
      <button type="button" class="faces-badd faces-lg" data-fc-move${moves ? '' : ' disabled'}>Move ${moves === 1 ? '1 face' : `${moves.toLocaleString()} faces`}</button>
    </div>`;
  if (focusKey) {
    const card = sec.querySelector(`.fr-card[data-fr-key="${focusKey}"]`);
    const t = card && (focusAns ? card.querySelector(`[data-fr-ans="${focusAns}"]`) : card.querySelector('.fr-face-btn'));
    if (t) t.focus();
  } else if (hadFocus && hadFocus.dataset && hadFocus.dataset.fcPerson) {
    sec.querySelector(`[data-fc-person="${st.pid}"]`)?.focus();
  }
}

/** "Move N faces": out of Y and into X, as the user's decision (Y keeps a "not this person" for each). */
async function frCompareCommit(btn) {
  if (!FC || !facesFocus) return;
  const st = FC;
  const o = facesBreakdown(facesFocus).others.get(st.pid);
  if (!o) return;
  const move = o.groups.filter(g => st.answers.get(g) === 'move');
  const keep = o.groups.filter(g => st.answers.get(g) === 'keep');
  if (!move.length) return;
  btn.disabled = true;
  let r;
  try {
    r = await facesApi(`/api/faces/people/${st.T.id}/move`, { method: 'POST', json: { from: st.pid, groupIds: move, keep } });
  } catch (err) { facesToastError(err); btn.disabled = false; return; }
  if (typeof FT !== 'undefined') { FT.faces.delete(st.T.id); FT.faces.delete(st.pid); }
  const k = (r.moved || []).length;
  const named = !document.body.classList.contains('pm-names');
  showToast(k ? (named && st.T.name ? `Moved ${frPlural(k, 'face', 'faces')} to ${st.T.name}.` : `Moved ${frPlural(k, 'face', 'faces')}.`) : 'Nothing was moved. Those faces have changed.');
  for (const g of [...move, ...keep]) st.answers.delete(g);
  st.people.clear();
  await facesRefreshFocus();
  if (FC !== st) return;
  if (!facesBreakdown(facesFocus).others.size) { facesCompareClose(); return; }
  frComparePaint();
  frCompareLoad();
}

/** "They are the same person: merge…": a second step that names both and their files, then the usual merge. */
async function frCompareMerge(btn) {
  if (!FC) return;
  const st = FC;
  const o = facesBreakdown(facesFocus).others.get(st.pid);
  if (!o) return;
  const tp = st.people.get(st.T.id), yp = st.people.get(st.pid);
  const X = frWho(st.T), Y = frName(o.name);
  const files = (p) => (p ? ` (${frPlural(p.files, 'file', 'files')})` : '');
  const choice = await facesAsk({
    title: 'Put these two people together?',
    html: `<p class="vault-modal-hint"><b>${Y}</b>${files(yp)} and <b>${X}</b>${files(tp)} become one person, called ${X}. Every face of ${Y} moves, not only the ones in these results.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Yes, they are the same person', value: 'merge', primary: true }],
  });
  if (!choice || FC !== st) return;
  btn.disabled = true;
  try {
    await facesApi('/api/faces/people/merge', { method: 'POST', json: { ids: [st.T.id, st.pid], into: st.T.id } });
  } catch (err) { facesToastError(err); btn.disabled = false; return; }
  if (typeof FT !== 'undefined') FT.faces.delete(st.T.id);
  showToast(document.body.classList.contains('pm-names') || !st.T.name ? 'Put together.' : `Put together as ${st.T.name}.`);
  st.people.clear();
  await facesRefreshFocus();
  if (FC !== st) return;
  if (!facesBreakdown(facesFocus).others.size) { facesCompareClose(); return; }
  frComparePaint();
  frCompareLoad();
}

/* ── "Same person?" in the panel (the Faces tab's Review all) ──────────────
   Pairs of people that may be one person, as cards: both faces side by side,
   names and file counts, Same / Not the same. Nothing is answered until
   Save my answers (POST /api/faces/review/answers: Same merges as before,
   Not the same is remembered). */

const FP_PAGE = 30;
let FP = null;   // { el, back, opener, pairs, shown, answers: Map key -> 'yes'|'no', total }

const fpKey = (pr) => `${Math.min(pr.a.id, pr.b.id)}-${Math.max(pr.a.id, pr.b.id)}`;

function facesPairsReviewClose() {
  if (!FP) return;
  const { el, back, opener } = FP;
  FP = null;
  el.remove();
  back.remove();
  if (opener && opener.isConnected) opener.focus();
}

async function facesPairsReviewOpen(opener) {
  let r;
  try { r = await facesApi('/api/faces/review?limit=200'); } catch (err) { facesToastError(err); return; }
  const skip = typeof FT !== 'undefined' && FT.reviewSkip ? FT.reviewSkip : new Set();
  const pairs = (r.pairs || []).filter(p => !skip.has(fpKey(p)));
  if (!pairs.length) { showToast('Nothing to look at right now.'); return; }
  facesPairsReviewClose();
  frSyncViewport();
  const back = document.createElement('div');
  back.className = 'fr-backdrop';
  document.body.appendChild(back);
  const el = document.createElement('aside');
  el.className = 'fr-panel fr-pairs-panel';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', 'fpTitle');
  document.body.appendChild(el);
  FP = { el, back, opener, pairs, shown: Math.min(FP_PAGE, pairs.length), answers: new Map(), total: Math.max(r.total || 0, pairs.length) };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !(typeof FT !== 'undefined' && FT.naming)) { e.preventDefault(); e.stopPropagation(); facesPairsReviewClose(); }
  });
  el.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t || !FP) return;
    if (t.closest('[data-fp-x]')) { facesPairsReviewClose(); return; }
    if (t.closest('[data-fp-more]')) { FP.shown = Math.min(FP.pairs.length, FP.shown + FP_PAGE); fpPaint(); return; }
    if (t.closest('[data-fp-norest]')) {
      for (const pr of FP.pairs.slice(0, FP.shown)) if (!FP.answers.has(fpKey(pr))) FP.answers.set(fpKey(pr), 'no');
      fpPaint();
      FP.el.querySelector('[data-fp-save]:not(:disabled)')?.focus();
      return;
    }
    if (t.closest('[data-fp-save]')) fpSave(t.closest('button'));
  });
  frKeys(el, {
    answer: (key, a, { toggle }) => {
      if (!FP) return;
      if (toggle && FP.answers.get(key) === a) FP.answers.delete(key); else FP.answers.set(key, a);
      fpPaint();
    },
    frame: () => {},
  });
  fpPaint();
  el.querySelector('.fr-card .fr-face-btn')?.focus();
}

function fpSide(p) {
  const name = p.name ? `<span class="ft-pm-name">${frEsc(p.name)}</span>` : '<span class="fp-noname">Not named yet</span>';
  const crop = p.coverUrl ? `<img class="face-crop" src="${frEsc(p.coverUrl)}" alt="" loading="lazy">` : '<span class="ft-blank" aria-hidden="true">👤</span>';
  return `<div class="fp-side"><div class="fp-face">${crop}</div><div class="fp-name">${name}</div><div class="fp-files">${frPlural(p.files || 0, 'file', 'files')}</div></div>`;
}

function fpPaint() {
  if (!FP) return;
  const el = FP.el;
  const hadFocus = el.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = hadFocus && hadFocus.closest('.fr-card') ? hadFocus.closest('.fr-card').dataset.frKey : null;
  const focusAns = hadFocus && hadFocus.dataset ? hadFocus.dataset.frAns : null;
  const list = FP.pairs.slice(0, FP.shown);
  let same = 0, diff = 0;
  for (const a of FP.answers.values()) { if (a === 'yes') same++; else if (a === 'no') diff++; }
  const open = FP.pairs.length - same - diff;
  const cards = list.map((pr) => {
    const key = fpKey(pr);
    const a = FP.answers.get(key);
    return `
      <div class="fr-card fp-card${a === 'yes' ? ' is-yes' : ''}${a === 'no' ? ' is-no' : ''}" data-fr-key="${key}" role="listitem">
        <button type="button" class="fr-face-btn fp-pair" aria-label="Pair ${list.indexOf(pr) + 1} of ${FP.pairs.length}">${fpSide(pr.a)}<span class="fp-plus" aria-hidden="true">+</span>${fpSide(pr.b)}</button>
        <div class="fr-yn">
          <button type="button" class="${a === 'yes' ? 'on-yes' : ''}" data-fr-ans="yes" aria-pressed="${a === 'yes'}">Same</button>
          <button type="button" class="${a === 'no' ? 'on-no' : ''}" data-fr-ans="no" aria-pressed="${a === 'no'}">Not the same</button>
        </div>
      </div>`;
  }).join('');
  const rest = FP.pairs.length - FP.shown;
  el.innerHTML = `
    <div class="fr-head">
      <div class="fr-h"><div class="fr-title" id="fpTitle">Same person?</div>
        <div class="fr-note">${frPlural(FP.total, 'pair', 'pairs')} to look at. Same puts their files together; Not the same keeps them apart for good.</div></div>
      <button type="button" class="faces-bghost fr-x" data-fp-x aria-label="Close">${FR_X_SVG}</button>
    </div>
    <div class="fr-body">
      ${frSectionHead('Pairs', '', [{ attr: 'data-fp-norest', label: 'Not the same to the rest', disabled: !list.some(pr => !FP.answers.has(fpKey(pr))) }])}
      <div class="fr-cards fp-cards" role="list" aria-label="Pairs">${cards}</div>
      ${rest > 0 ? `<button type="button" class="faces-blink fr-more" data-fp-more>Show ${Math.min(rest, FP_PAGE).toLocaleString()} more</button>` : ''}
      <p class="fr-note fr-keys">Keys: <span class="fr-kbd">Y</span> same, <span class="fr-kbd">N</span> not the same, <span class="fr-kbd">←</span> <span class="fr-kbd">→</span> move between pairs.</p>
    </div>
    <div class="fr-foot">
      <span class="fr-sum"><b>${same.toLocaleString()}</b> same, <b>${diff.toLocaleString()}</b> not the same, <b>${open.toLocaleString()}</b> not decided</span>
      <button type="button" class="faces-badd faces-lg" data-fp-save${same || diff ? '' : ' disabled'}>Save my answers</button>
    </div>`;
  if (focusKey) {
    const card = el.querySelector(`.fr-card[data-fr-key="${focusKey}"]`);
    const t = card && (focusAns ? card.querySelector(`[data-fr-ans="${focusAns}"]`) : card.querySelector('.fr-face-btn'));
    if (t) t.focus();
  } else if (hadFocus && hadFocus.matches('[data-fp-more]')) el.querySelector(`.fr-card:nth-child(${FP.shown - FP_PAGE + 1}) .fr-face-btn`)?.focus();
}

async function fpSave(btn) {
  if (!FP) return;
  const answers = [];
  for (const pr of FP.pairs) {
    const a = FP.answers.get(fpKey(pr));
    if (a) answers.push({ a: pr.a.id, b: pr.b.id, answer: a === 'yes' ? 'same' : 'different' });
  }
  if (!answers.length) return;
  btn.disabled = true;
  let same = 0, diff = 0, named = 0, other = 0;
  try {
    for (let i = 0; i < answers.length; i += 200) {
      const r = await facesApi('/api/faces/review/answers', { method: 'POST', json: { answers: answers.slice(i, i + 200) } });
      for (const d of r.done || []) { if (d.answer === 'same') same++; else diff++; }
      for (const x of r.skipped || []) { if (x.reason === 'both-named') named++; else other++; }
    }
  } catch (err) { facesToastError(err); btn.disabled = false; return; }
  const said = [];
  if (same) said.push(same === 1 ? 'Put 1 pair together.' : `Put ${same.toLocaleString()} pairs together.`);
  if (diff) said.push(diff === 1 ? '1 pair stays apart.' : `${diff.toLocaleString()} pairs stay apart.`);
  // A Same that would have joined two named people (after an earlier Same in the list) is never done here.
  if (named) said.push(`${named === 1 ? '1 pair' : `${named.toLocaleString()} pairs`} skipped: both already have names. Use Merge in the Faces tab if they are the same.`);
  if (other) said.push(`${other.toLocaleString()} had changed and ${other === 1 ? 'was' : 'were'} left alone.`);
  showToast(said.join(' ') || 'Nothing changed.');
  facesPairsReviewClose();
  if (typeof FT !== 'undefined') FT.faces.clear();
  if (typeof ftLoadReview === 'function') ftLoadReview();
  if (typeof ftLoadPeople === 'function') ftLoadPeople();
}
