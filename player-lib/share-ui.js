/* =========================================================================
   SHARE PRIVATELY: the share window (steps 1 to 4 and 3b), the top bar icon,
   the entry points on the selection bar, on one file's menu and on a
   collection card's menu, the large share warning and ask, the Vault
   password prompt, and the privacy guard ("My shares" hide category).

   Steps (.notes/SHARE_PRIVATELY_SPEC.md section 4):
     review   1. what will be packed; nothing leaves the computer
     packing  2. packing and the checks, run by the server
     checked  2. the three check results and the password
     confirm  3. the warning, the summary and the tick box; Upload stays off
                 until the box is ticked
     upload   3b. one row per part; Pause, Try again, Stop and delete
     done     4. link and password, Copy as block, Delete from gofile now
     failed   what failed, in plain words, with the safe way out
   The window can be closed while uploading; the top bar icon and My shares
   open it again (shareOpenShare).

   SECRETS. A password reaches the page only from a click on Show or Copy,
   lives in that window's own field, and goes when the window closes (the
   fields are emptied and the window object dropped). Nothing is stored in the
   browser. The Vault password typed into the prompt goes in the body of the
   one request and is dropped.

   Needs share-client.js (shareApi and the helpers). Load before settings.js.
   ========================================================================= */

/* ── Shared state ─────────────────────────────────────────────────────── */

// The last GET /api/share/state answer: no secrets in it.
let _shareState = null;
let _sharePollTimer = null;

const shEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s)) : String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
const shIcon = (name, cls = '') => (typeof vaultIcon === 'function' ? vaultIcon(name, cls) : '');
const shToast = (msg, type) => { if (typeof showToast === 'function') showToast(msg, type ? { type } : undefined); };

/** Is the feature switched on (as far as the page last heard)? */
function shareEnabled() {
  return !!(_shareState && _shareState.enabled);
}

/** Privacy mode with "My shares" ticked. */
function sharePrivate() {
  return !!(typeof document !== 'undefined' && document.body && document.body.classList
    && document.body.classList.contains('pm-shares'));
}

/** Privacy mode with "File names" ticked (the global category). */
function shareNamesPrivate() {
  return !!(typeof document !== 'undefined' && document.body && document.body.classList
    && document.body.classList.contains('pm-names'));
}

/**
 * Privacy turned on or off: the private parts (My shares list, the top bar
 * popup text, the share window's file list, every archive name, the link, the
 * password and the Both together block) are blurred by css/share.css and
 * taken out of the keyboard order here (inert), so a hidden row can never be
 * reached with Tab or acted on blind. A field that holds the link or a
 * password (data-share-mask) also turns into dots, so a blurred field never
 * holds readable text; it gets its own type back when privacy goes off. The
 * copy buttons read from the server or the share, never from the field, so
 * they keep working.
 *
 * Lists of the user's own file names (data-share-names: the step 1 list,
 * folded rows included, and the files of a share in My shares) go the same
 * way under "My shares" and also under the global "File names" category.
 *
 * A masked text field (data-share-secret, see shareSecretField) is not
 * switched here: css/share.css keeps it as dots while "My shares" is on.
 */
function sharePrivacyChanged(root) {
  if (typeof document === 'undefined') return;
  const scope = root || document;
  if (!scope.querySelectorAll) return;
  const on = sharePrivate();
  const names = on || shareNamesPrivate();
  const hide = (el, h) => {
    el.inert = h;
    if (h) el.setAttribute('aria-hidden', 'true'); else el.removeAttribute('aria-hidden');
  };
  scope.querySelectorAll('[data-share-private]').forEach((el) => hide(el, on));
  scope.querySelectorAll('[data-share-names]').forEach((el) => hide(el, names));
  scope.querySelectorAll('[data-share-mask]').forEach((el) => {
    if (el.dataset.shareSecret !== undefined) return;
    if (on) {
      if (el.dataset.shareType === undefined) el.dataset.shareType = el.type || 'text';
      el.type = 'password';
    } else if (el.dataset.shareType !== undefined) {
      el.type = el.dataset.shareType;
      delete el.dataset.shareType;
    }
  });
}

/** Is this field showing its text (or would it, once privacy is off)? */
function shareFieldShown(input) {
  if (input.dataset && input.dataset.shareSecret !== undefined) return input.dataset.shareSecret === 'shown';
  const t = input.dataset && input.dataset.shareType !== undefined ? input.dataset.shareType : input.type;
  return t !== 'password';
}

/** Show or hide a password field. Under privacy it stays dots until privacy goes off. */
function shareSetFieldShown(input, show) {
  if (input.dataset && input.dataset.shareSecret !== undefined) { input.dataset.shareSecret = show ? 'shown' : 'hidden'; return; }
  const t = show ? 'text' : 'password';
  if (input.dataset && input.dataset.shareType !== undefined) input.dataset.shareType = t;
  else input.type = t;
}

/**
 * A field for a new share password that the browser must not offer to save
 * (a password manager would keep a copy outside Vault): a text field drawn as
 * dots by css/share.css (data-share-secret="hidden"), so no password field is
 * ever submitted or removed. Show and Hide go through shareSetFieldShown; with
 * "My shares" on it stays dots whatever Show says. A browser that cannot draw
 * a text field as dots gets a plain password field back (dots, a save offer
 * at worst), never readable text.
 */
function shareSecretField(input) {
  if (!input) return input;
  const masks = typeof CSS !== 'undefined' && CSS && typeof CSS.supports === 'function'
    && (CSS.supports('-webkit-text-security', 'disc') || CSS.supports('text-security', 'disc'));
  if (!masks) {
    input.type = 'password';
    delete input.dataset.shareSecret;
    if (input.parentNode) sharePrivacyChanged(input.parentNode);
  }
  return input;
}

/** A piece of text that privacy mode blurs (an archive name, in a line of other words). */
function sharePrivSpan(text) {
  return `<span class="share-priv" data-share-private>${shEsc(text)}</span>`;
}

/** Settings > privacy chip "My shares" changed: the server keeps the same choice. */
function shareHideInPrivacyChanged(on) {
  if (_shareState && _shareState.settings) _shareState.settings.hideInPrivacy = !!on;
  shareApi('POST', '/settings', { hideInPrivacy: !!on }).catch(() => {});
}

/** Keep the privacy chip in step with the server's "Hide My shares in privacy mode". */
function shareSyncPrivacyHide() {
  const s = _shareState && _shareState.settings;
  if (!s || typeof window === 'undefined' || typeof window.vaultSetPrivacyHide !== 'function') return;
  const hide = typeof window.vaultSetting === 'function' ? window.vaultSetting('privacyHide') : null;
  if (hide && !!hide.shares !== !!s.hideInPrivacy) window.vaultSetPrivacyHide('shares', !!s.hideInPrivacy);
}

/* ── Modal shell ──────────────────────────────────────────────────────── */

const _shareModals = [];   // open share dialogs, newest last

/**
 * A dialog on the .vault-modal shell (css/vault.css), so the page shortcuts
 * stay quiet while it is open (vault-dialogs.js vaultModalOpen). Esc calls
 * onEsc (default: close), Tab stays inside, focus goes back on close.
 *
 * outside: true makes a click on the dim backdrop do what Esc does. Only for
 * windows where nothing can be lost (My shares, Delete all, the Copy format
 * editor with no edits); the share window and Change saved password ignore
 * both, so a stray click or key cannot drop typed input or hide a job. The
 * press and the release must both land on the backdrop: a text selection
 * dragged out of the window does not close it.
 */
function shareModal({ id, labelledBy, html, cls = '', onEsc, outside = false }) {
  if (id) document.getElementById(id)?.remove();
  const opener = document.activeElement;
  const ov = document.createElement('div');
  if (id) ov.id = id;
  ov.className = 'vault-modal-overlay share-ov';
  ov.innerHTML = `<div class="vault-modal share-dlg${cls ? ` ${cls}` : ''}" role="dialog" aria-modal="true"${labelledBy ? ` aria-labelledby="${labelledBy}"` : ''}>${html}</div>`;
  const box = ov.firstElementChild;
  document.body.appendChild(ov);
  const m = { ov, box, q: (sel) => box.querySelector(sel), qa: (sel) => box.querySelectorAll(sel), closed: false };

  function onKey(e) {
    if (m.closed || _shareModals[_shareModals.length - 1] !== m) return;
    if (typeof window.vaultDialogOpen === 'function' && window.vaultDialogOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (onEsc) onEsc(); else m.close();
    } else if (e.key === 'Tab') {
      const f = [...box.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex="0"]')]
        .filter(n => !n.disabled && n.offsetParent !== null && !n.closest('[inert]'));
      if (!f.length) return;
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
    }
  }
  window.addEventListener('keydown', onKey, true);
  if (outside) {
    let downOnBackdrop = false;
    ov.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === ov; });
    ov.addEventListener('click', (e) => {
      const both = downOnBackdrop && e.target === ov;
      downOnBackdrop = false;
      if (!both || m.closed || _shareModals[_shareModals.length - 1] !== m) return;
      if (onEsc) onEsc(); else m.close();
    });
  }
  m.close = () => {
    if (m.closed) return;
    m.closed = true;
    window.removeEventListener('keydown', onKey, true);
    // Empty every field first: a password must not outlive its window.
    box.querySelectorAll('input, textarea').forEach((el) => { el.value = ''; });
    ov.remove();
    const i = _shareModals.indexOf(m);
    if (i >= 0) _shareModals.splice(i, 1);
    if (opener && opener.isConnected && typeof opener.focus === 'function') {
      try { opener.focus({ preventScroll: true }); } catch { /* gone */ }
    }
  };
  _shareModals.push(m);
  sharePrivacyChanged(box);
  return m;
}

function shareFocus(el) {
  if (!el) return;
  try { el.focus({ preventScroll: true }); } catch { /* gone */ }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { if (el.isConnected && document.activeElement !== el) { try { el.focus(); } catch { /* gone */ } } });
  }
}

/** The error line in a dialog: plain words, or hidden. */
function shareSetError(el, msg) {
  if (!el) return;
  if (!msg) { el.hidden = true; el.textContent = ''; return; }
  el.innerHTML = `${shIcon('alert')}<span>${shEsc(msg)}</span>`;
  el.hidden = false;
}

/** A password field with its Show button (type=password until Show is pressed). */
function sharePassFieldHtml(id, label, { note = '', autocomplete = 'off', placeholder = '' } = {}) {
  return `
    <div class="vault-field">
      <label class="vault-label" for="${id}">${shEsc(label)}</label>
      <div class="share-pw-row">
        <input type="password" id="${id}" class="vault-input share-mono" autocomplete="${autocomplete}" spellcheck="false"
               autocapitalize="off"${placeholder ? ` placeholder="${shEsc(placeholder)}"` : ''}${note ? ` aria-describedby="${id}Note"` : ''}>
        <button type="button" class="vault-btn" data-sh-show="${id}" aria-pressed="false">Show</button>
      </div>
      ${note ? `<div class="vault-field-note" id="${id}Note">${shEsc(note)}</div>` : ''}
    </div>`;
}

/** Wire every Show button under root: it swaps its field between dots and text. */
function shareWireShowButtons(root) {
  root.querySelectorAll('[data-sh-show]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = root.querySelector(`#${btn.dataset.shShow}`);
      if (!input) return;
      // Through the helpers, so a field privacy mode hides stays dots.
      const show = !shareFieldShown(input);
      shareSetFieldShown(input, show);
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-pressed', String(show));
    });
  });
}

/* ── The Vault password prompt ────────────────────────────────────────── */

/**
 * Ask for the Vault password. Resolves with what was typed, or null on
 * Cancel. The field is emptied as the prompt closes; the caller sends the
 * value in one request body and drops it.
 */
function shareAskVaultPassword(why, problem = '') {
  return new Promise((resolve) => {
    const m = shareModal({
      id: 'shareGateDlg', labelledBy: 'shareGateTitle', cls: 'share-dlg-small',
      onEsc: () => done(null),
      html: `
        <h3 id="shareGateTitle">Enter your Vault password</h3>
        <p class="vault-modal-hint">${shEsc(why || 'Vault asks for it before it shows a saved password.')}</p>
        ${sharePassFieldHtml('shareGatePass', 'Your Vault password', { autocomplete: 'current-password' })}
        <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
        <div class="vault-modal-actions">
          <button type="button" class="vault-btn" data-sh-act="cancel">Cancel</button>
          <button type="button" class="vault-btn vault-btn-primary" data-sh-act="ok">OK</button>
        </div>`,
    });
    shareWireShowButtons(m.box);
    shareSetError(m.q('[data-sh-err]'), problem);
    const input = m.q('#shareGatePass');
    function done(value) {
      if (m.closed) return;
      m.close();
      resolve(value);
    }
    m.q('[data-sh-act="cancel"]').addEventListener('click', () => done(null));
    const ok = () => {
      const v = input.value;
      if (!v) { shareSetError(m.q('[data-sh-err]'), 'Type your Vault password.'); input.focus(); return; }
      done(v);
    };
    m.q('[data-sh-act="ok"]').addEventListener('click', ok);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } });
    shareFocus(input);
  });
}

/**
 * Run a gated request. call(vaultPassword) does the request. needed: ask
 * before the first try (the share used the saved password and a Vault
 * password is set). A wrong or missing Vault password asks again. Resolves
 * with the answer, or null when the user cancelled.
 */
async function shareWithGate(call, { needed = false, why = '' } = {}) {
  let vp;
  if (needed) {
    vp = await shareAskVaultPassword(why);
    if (vp == null) return null;
  }
  for (;;) {
    try {
      const out = await call(vp);
      vp = null;
      return out;
    } catch (err) {
      vp = null;
      if (err && (err.code === 'GATE_NEEDED' || err.code === 'GATE_WRONG')) {
        const left = err.extra && Number.isFinite(err.extra.attemptsLeft) ? err.extra.attemptsLeft : null;
        const problem = err.code === 'GATE_WRONG'
          ? `${err.message}${left != null ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}` : '';
        vp = await shareAskVaultPassword(why, problem);
        if (vp == null) return null;
        continue;
      }
      throw err;
    }
  }
}

/** Does this share's password need the Vault password to be shown? */
function shareNeedsGate(share) {
  const sp = _shareState && _shareState.savedPassword;
  return !!(share && share.passwordKind === 'saved' && sp && sp.vaultPasswordSet);
}

/** Copy text to the clipboard (only ever from a click). */
async function shareCopyText(text, done) {
  try {
    await navigator.clipboard.writeText(String(text));
    shToast(done || 'Copied', 'success');
    return true;
  } catch {
    shToast('Could not copy. Select the text and copy it by hand.', 'error');
    return false;
  }
}

/* ── The share window ─────────────────────────────────────────────────── */

let _shareWin = null;   // the open window, or null

const SHARE_PHASE_WORDS = { staging: 'Getting the files ready', cleaning: 'Removing personal details', packing: 'Packing and encrypting', checking: 'Checking the archive' };

/**
 * Open the window for these library files (step 1). collectionName: the share
 * came from a collection's menu; step 1 names it. It stays on this page: it is
 * never sent with the share and never names the archive.
 */
async function shareOpenForIds(ids, { collectionName = '' } = {}) {
  const mediaIds = [...new Set(Array.from(ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!mediaIds.length) { shToast('Pick at least one file.'); return; }
  if (mediaIds.length > 5000) { shToast('Pick 5,000 files or fewer to share at once.', 'error'); return; }
  if (!shareEnabled()) { shToast('Share privately is turned off. Turn it on in Settings first.', 'error'); return; }
  const w = shareWindowOpen();
  w.mediaIds = mediaIds;
  w.collectionName = String(collectionName || '');
  w.step = 'loading';
  shareWindowRender();
  try {
    w.preview = await shareApi('POST', '/preview', { mediaIds });
    if (w !== _shareWin) return;
    w.step = 'review';
  } catch (err) {
    if (w !== _shareWin) return;
    w.step = 'failed';
    w.failText = err.message;
    w.failLocal = true;
  }
  shareWindowRender();
  // The list shows at once; the personal details check fills in when ready.
  if (w.step === 'review' && w.preview && w.preview.checkPersonal) shareMetaRun(w);
}

/** The selection bar's button. */
function shareOpenForSelection() {
  if (typeof selectedIds === 'undefined') return;
  shareOpenForIds([...selectedIds]);
}

// The file types a collection's share takes: what its grid lists, without
// mixes (a mix is not one file on disk) and without the trash.
const SHARE_COLLECTION_TYPES = ['video', 'audio', 'image', 'gif'];

/**
 * A collection card's menu: every file in the collection, skipped ones too
 * (a skip is about playback). The server answers the whole id list, so a big
 * collection is not cut to the page the grid has drawn.
 */
async function shareOpenForCollection(id) {
  const c = typeof getCollectionById === 'function' ? getCollectionById(id) : null;
  if (!c || c.kind === 'folder') return;
  if (!shareEnabled()) { shToast('Share privately is turned off. Turn it on in Settings first.', 'error'); return; }
  let ids;
  try {
    const out = await Library.queryOnce({ collectionId: Number(id), filters: { mediaTypes: SHARE_COLLECTION_TYPES, trashed: '0' } },
      { pageSize: 1, allIds: true });
    // No total: the full list did not come, only the first page. Never share part of it.
    if (!out || (!out.complete && out.total == null)) throw new Error('partial');
    ids = Array.from(out.ids || []);
  } catch {
    shToast('Could not read this collection. Try again.', 'error');
    return;
  }
  if (!ids.length) { shToast('This collection has no files to share.'); return; }
  if (ids.length > 5000) { shToast('This collection has more than 5,000 files. Share privately takes up to 5,000 at once.', 'error'); return; }
  return shareOpenForIds(ids, { collectionName: c.name });
}

/** Open the window on a share that already exists (top bar, My shares). */
async function shareOpenShare(id) {
  const w = shareWindowOpen();
  w.id = Number(id);
  w.step = 'loading';
  shareWindowRender();
  await shareWindowRefresh();
  shareWindowPoll();
}

function shareWindowOpen() {
  if (_shareWin) shareWindowClose();
  const w = {
    id: null, mediaIds: [], preview: null, share: null, progress: null, step: 'loading',
    ticked: false, error: '', failText: '', failLocal: false, samples: [], timer: null, busy: false, partsSig: '',
    collectionName: '', filesOpen: false, bigAsk: null,
    // The personal details check (step 1): where it is, its answer, the choice.
    meta: null, metaProgress: null, metaError: false, metaTimer: null, metaChoice: 'remove', metaOpen: false, metaWaitPack: false,
  };
  // A click outside does nothing here: a stray click would drop what was typed
  // on step 1 or hide a running job. Esc asks to close, as Close does.
  w.m = shareModal({ id: 'shareWindow', labelledBy: 'shareWinTitle', cls: 'share-win', onEsc: () => shareWindowRequestClose() });
  _shareWin = w;
  return w;
}

/** Close the window. The upload, if any, keeps going on the server. */
function shareWindowClose() {
  const w = _shareWin;
  if (!w) return;
  clearTimeout(w.timer);
  w.timer = null;
  clearTimeout(w.metaTimer);
  w.metaTimer = null;
  _shareWin = null;
  if (w.bigAsk) w.bigAsk.close();
  w.m.close();
  // What the check found goes with the window.
  w.preview = null; w.share = null; w.progress = null; w.meta = null; w.metaProgress = null;
}

/**
 * Close (X, Esc, Close, Keep using Vault). On steps 2 and 3 this only hides
 * the window: a share waiting to pack, packing, or packed and waiting for the
 * check carries on in My shares. Only "Cancel and delete archive" cancels.
 */
async function shareWindowRequestClose() {
  const w = _shareWin;
  if (!w) return;
  const step = w.step;
  const kept = w.id && ['queued', 'packing', 'checked', 'confirm'].includes(step);
  shareWindowClose();
  if (kept) {
    shToast(step === 'checked' || step === 'confirm' ? 'Packed and waiting for you in My shares. Nothing was uploaded.'
      : step === 'queued' ? 'Waiting to pack. It carries on in My shares.' : 'Packing carries on in My shares.');
    shareStatePollSoon();
  }
}

/** Ask the server where this share is, and pick the step from it. */
async function shareWindowRefresh() {
  const w = _shareWin;
  if (!w || !w.id) return;
  let p;
  try {
    p = await shareApi('GET', `/shares/${w.id}/progress`, null, { background: true });
  } catch (err) {
    if (w !== _shareWin) return;
    if (err.code === 'NOT_FOUND') { shareWindowClose(); shToast('That share was not found.'); return; }
    const line = w.m && w.m.q('[data-sh-err]');
    if (line) shareSetError(line, err.message);
    return;
  }
  if (w !== _shareWin) return;
  w.progress = p;
  const before = w.step;
  let next = before;
  if (p.status === 'queued') next = 'queued';
  else if (p.status === 'packing') next = 'packing';
  else if (p.status === 'checked') next = before === 'confirm' ? 'confirm' : 'checked';
  // 'stopping': Stop and delete is running; stay on 3b (its buttons go off) until it ends.
  else if (['uploading', 'paused', 'not_finished', 'stopping'].includes(p.status)) next = 'upload';
  else if (p.status === 'uploaded' || p.status === 'expired') next = 'done';
  else if (p.status === 'failed') next = 'failed';
  else next = 'ended';
  // The share's own fields (name, size, password kind) when the step needs them.
  // (While waiting or packing only once, for the size line, when the window
  // was opened from My shares.)
  const fetchShare = next === 'packing' || next === 'queued' ? !w.share : (!w.share || next !== before);
  if (fetchShare) {
    try {
      const r = await shareApi('GET', `/shares/${w.id}`, null, { background: true });
      if (w !== _shareWin) return;
      w.share = r.share;
    } catch { /* the progress answer is enough to go on */ }
  }
  if (next === 'failed') { w.failText = p.error || (w.share && w.share.error) || 'Something went wrong.'; w.failLocal = false; }
  if (next === 'upload') shareNoteSample(w, p);
  w.step = next;
  if (next === before && next === 'upload') shareUploadUpdate();
  else if (next === before && next === 'packing') sharePackingUpdate();
  else if (next === before && next === 'queued') shareQueuedUpdate();
  else if (next === before && next === 'checked') shareCheckedNoteUpdate();
  // A step that has not changed is left alone: drawing it again would drop
  // a shown password, a message or the focus.
  else if (next !== before) shareWindowRender();
}

/** Poll while the window is open: 1 s while something runs, 5 s otherwise. */
function shareWindowPoll() {
  const w = _shareWin;
  if (!w || !w.id) return;
  clearTimeout(w.timer);
  const live = ['queued', 'packing', 'upload'].includes(w.step) || w.step === 'loading';
  w.timer = setTimeout(async () => {
    if (w !== _shareWin) return;
    await shareWindowRefresh();
    if (w === _shareWin) shareWindowPoll();
  }, live ? 1000 : 5000);
}

/** Keep the last 20 s of byte counts for the time-left estimate. */
function shareNoteSample(w, p) {
  const up = p && p.upload;
  if (!up) return;
  const now = Date.now();
  w.samples.push({ t: now, b: up.bytesDone });
  while (w.samples.length > 2 && now - w.samples[0].t > 20000) w.samples.shift();
}

function shareRate(w) {
  const s = w.samples;
  if (s.length < 2) return 0;
  const a = s[0], b = s[s.length - 1];
  return b.t > a.t && b.b > a.b ? (b.b - a.b) / ((b.t - a.t) / 1000) : 0;
}

/* Step markup pieces. */

/**
 * The step header. privName: an archive name after the title, blurred under
 * privacy. sub: plain words, or { html } already escaped.
 */
function shareHead(kicker, title, sub, privName = '') {
  const subHtml = sub && typeof sub === 'object' ? sub.html : shEsc(sub);
  return `
    <div class="share-head">
      <div class="share-head-text">
        ${kicker ? `<div class="share-kicker">${shEsc(kicker)}</div>` : ''}
        <h3 id="shareWinTitle">${shEsc(title)}${privName ? ` ${sharePrivSpan(privName)}` : ''}</h3>
        ${sub ? `<p class="vault-modal-hint share-sub">${subHtml}</p>` : ''}
      </div>
      <button type="button" class="share-x" data-sh-act="close" aria-label="Close" title="Close">${shIcon('close') || '&times;'}</button>
    </div>`;
}

function shareBar(percent, label) {
  const p = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  return `<div class="share-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${shEsc(label || 'Progress')}"><div class="share-bar-fill" style="width:${p}%"></div></div>`;
}

function shareSelect(id, options, value, extra = '') {
  return `<select class="vault-input share-sel" id="${id}"${extra}>${options.map(o =>
    `<option value="${shEsc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}${o.disabled ? ' disabled' : ''}>${shEsc(o.label)}</option>`).join('')}</select>`;
}

/** The archive as one line: "k7Qm2xVd9LpA.7z, 1.55 GB", or "k7Qm2xVd9LpA.7z, 4.2 GB in 3 parts" (never the .001 part name). */
function shareArchiveLineParts(share, checks) {
  const name = share ? share.archiveDisplayName || `${share.archiveName}.7z` : (checks && checks.archiveName ? `${checks.archiveName.value}.7z` : '');
  const bytes = checks && checks.parts && checks.parts.bytes ? checks.parts.bytes : share ? share.sizeBytes : 0;
  const count = checks && checks.parts ? checks.parts.count : share ? share.partCount : 1;
  return { name, rest: `, ${shareSize(bytes)}${count > 1 ? ` in ${count} parts` : ''}` };
}

function shareArchiveLine(share, checks) {
  const { name, rest } = shareArchiveLineParts(share, checks);
  return `${name}${rest}`;
}

/** The same line as markup, with the name blurred under privacy. */
function shareArchiveLineHtml(share, checks) {
  const { name, rest } = shareArchiveLineParts(share, checks);
  return `${sharePrivSpan(name)}${shEsc(rest)}`;
}

function shareWindowRender() {
  const w = _shareWin;
  if (!w) return;
  const box = w.m.box;
  const html = {
    loading: () => `${shareHead('', 'Share privately', 'Getting things ready.')}<p class="vault-modal-hint">One moment.</p>`,
    review: shareReviewHtml,
    queued: shareQueuedHtml,
    packing: sharePackingHtml,
    checked: shareCheckedHtml,
    confirm: shareConfirmHtml,
    upload: shareUploadHtml,
    done: shareDoneHtml,
    failed: shareFailedHtml,
    ended: () => `${shareHead('', 'This share has ended', shareStatusWords(w.share || w.progress).text)}
      <div class="vault-modal-actions"><button type="button" class="vault-btn vault-btn-primary" data-sh-act="close">Close</button></div>`,
  }[w.step] || (() => '');
  box.innerHTML = html(w);
  box.setAttribute('data-step', w.step);
  shareWireWindow(w);
  sharePrivacyChanged(box);
  if (w.step === 'upload') shareUploadUpdate();
  const first = box.querySelector('[data-sh-first]') || box.querySelector('.vault-btn-primary:not(:disabled)') || box.querySelector('[data-sh-act="close"]');
  shareFocus(first);
}

/* Step 1: review. */

// Over this many files the list folds to its first SHARE_FOLD_SHOW rows.
const SHARE_FOLD_OVER = 6;
const SHARE_FOLD_SHOW = 3;

/** How the archive goes up, from the plan: "3 parts of up to 2 GB", "one part"; '' when not known. */
function shareUploadsAs(p) {
  const n = Number(p && p.partCount);
  if (!Number.isInteger(n) || n < 1) return '';
  if (n === 1) return 'one part';
  return `${n.toLocaleString()} parts${p.partBytes ? ` of up to ${shareSize(p.partBytes)}` : ''}`;
}

/** The amber line on step 1 for a share of SHARE_LARGE_BYTES or more. Relative words only: speeds are not known. */
function shareBigNote(p) {
  const size = shareSize(p.totalBytes);
  const space = p.needBytes ? `, and packing needs about ${shareSize(p.needBytes)} of free space` : '';
  const n = Number(p.partCount);
  const parts = Number.isInteger(n) && n >= 1 ? ` It will upload as ${n === 1 ? 'one part' : `${n.toLocaleString()} parts`}.` : '';
  return `Large share. Packing and uploading ${size} can take a long time${space}.${parts}`;
}

/** "and N more files" / "Show fewer" on step 1. */
function shareToggleFiles(w, btn) {
  w.filesOpen = !w.filesOpen;
  const rows = w.m.box.querySelectorAll('#shFilesList .share-file');
  rows.forEach((row, i) => { row.hidden = !w.filesOpen && i >= SHARE_FOLD_SHOW; });
  const more = rows.length - SHARE_FOLD_SHOW;
  btn.textContent = w.filesOpen ? 'Show fewer' : `and ${more.toLocaleString()} more ${more === 1 ? 'file' : 'files'}`;
  btn.setAttribute('aria-expanded', w.filesOpen ? 'true' : 'false');
}

/** Pack files: at SHARE_HUGE_BYTES or more it asks first, once per click. */
function sharePackClicked() {
  const w = _shareWin;
  // The ask is open (a second click of a double click) or a request is out: nothing.
  if (!w || w.busy || w.bigAsk || w.step !== 'review') return;
  // The personal details check is still running: Pack files waits for it.
  // When it ends with nothing found, packing goes on by itself; when it found
  // something, the box shows and the choice is the user's.
  if (shareMetaPending(w)) {
    w.metaWaitPack = true;
    const btn = w.m.q('[data-sh-act="pack"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting for the check…'; }
    return;
  }
  if ((Number(w.preview && w.preview.totalBytes) || 0) >= SHARE_HUGE_BYTES) { shareAskBig(w); return; }
  sharePack();
}

/* Step 1: the personal details check ("Check files for personal details"). */

/** Is the check on and still without an answer? */
function shareMetaPending(w) {
  return !!(w && w.preview && w.preview.checkPersonal && !w.meta && !w.metaError);
}

/** Will the cleaned copies be made (the check found something and Remove is picked)? */
function shareMetaRemoving(w) {
  return !!(w && w.meta && w.meta.personalCount > 0 && w.metaChoice !== 'keep');
}

/** The free space figures step 1 shows: with the cleaned copies when they will be made. */
function shareSpaceNow(w) {
  const p = (w && w.preview) || {};
  if (shareMetaRemoving(w)) return { needBytes: w.meta.needBytes, enoughSpace: w.meta.enoughSpace, missingBytes: w.meta.missingBytes };
  return { needBytes: p.needBytes, enoughSpace: p.enoughSpace, missingBytes: p.missingBytes };
}

/** "N files" / "1 file". */
function shareFilesWord(n) {
  return `${Number(n).toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
}

/**
 * The meta slot of step 1: checking, the amber box, or the quiet line for
 * files of a type Vault does not read. The box shows when something was
 * found or when a check failed: a failed check is a problem, never "clean".
 */
function shareMetaHtml(w) {
  const p = w.preview || {};
  if (w.metaError) {
    return '<p class="vault-modal-hint" data-sh-metamsg>Vault could not check these files for personal details. If you pack them, Vault checks them again first and removes what it finds from the packed copies.</p>';
  }
  if (!w.meta) {
    const st = w.metaProgress;
    const count = st && st.total > 1 ? ` ${Number(st.checked || 0).toLocaleString()} of ${Number(st.total).toLocaleString()}` : '';
    return `<p class="vault-modal-hint share-meta-wait" role="status" data-sh-metamsg>Checking for personal details…${shEsc(count)}</p>`;
  }
  const m = w.meta;
  const unchecked = Number(m.uncheckedCount) || 0;
  const quiet = unchecked ? `<p class="vault-modal-hint" data-sh-metaunchecked>${shEsc(shareFilesWord(unchecked))} could not be checked and ${unchecked === 1 ? 'is' : 'are'} packed as ${unchecked === 1 ? 'it is' : 'they are'}.</p>` : '';
  const n = Number(m.personalCount) || 0;
  const failed = Number(m.failedCount) || 0;
  if (!n && !failed) return quiet;
  const byId = new Map((p.files || []).map(f => [Number(f.mediaId), f]));
  const nameOf = (mediaId) => { const file = byId.get(Number(mediaId)); return file ? (file.nameInArchive || file.name) : ''; };
  const rows = (m.files || []).map((f) => {
    const what = (f.findings || []).map(x => `<span class="share-meta-what"><span class="share-meta-label">${shEsc(x.label)}:</span> ${shEsc(x.value)}</span>`).join('');
    return `<div class="share-meta-file"><span class="share-meta-name">${shEsc(nameOf(f.mediaId))}</span>${what}</div>`;
  }).join('') + (m.failedFiles || []).map(f => `<div class="share-meta-file share-meta-failed"><span class="share-meta-name">${shEsc(nameOf(f.mediaId))}</span><span class="share-meta-what">The check did not finish for this file.</span></div>`).join('');
  const extra = Number(m.extraBytes) || 0;
  const failNote = failed ? ` Vault checks ${failed === 1 ? 'the file that could not be checked' : 'the files that could not be checked'} again when packing starts. If one still cannot be checked, packing stops and nothing is uploaded.` : '';
  const removeNote = (n ? `${n === 1 ? 'Only this file is copied and cleaned.' : `Only these ${n.toLocaleString()} files are copied and cleaned.`} Your originals are not changed.${extra ? ` Needs about ${shareSize(extra)} more free space.` : ''}` : 'Your originals are not changed.') + failNote;
  const keepNote = n
    ? `Whoever opens the archive can read these details.${failed ? ` ${failed === 1 ? 'The file that could not be checked is' : 'The files that could not be checked are'} packed as ${failed === 1 ? 'it is' : 'they are'}.` : ''}`
    : `${failed === 1 ? 'It is' : 'They are'} packed as ${failed === 1 ? 'it is' : 'they are'}, without the check.`;
  const title = n && failed
    ? `${shareFilesWord(n)} ${n === 1 ? 'carries' : 'carry'} personal details, ${failed.toLocaleString()} could not be checked`
    : n ? `${shareFilesWord(n)} ${n === 1 ? 'carries' : 'carry'} personal details`
      : `${shareFilesWord(failed)} could not be checked for personal details`;
  const choice = (value, title, note) => `
        <label class="share-meta-choice">
          <input type="radio" name="shMetaChoice" value="${value}"${w.metaChoice === value || (value === 'remove' && w.metaChoice !== 'keep') ? ' checked' : ''}>
          <span><b>${shEsc(title)}</b><span class="share-meta-note">${shEsc(note)}</span></span>
        </label>`;
  return `
    <div class="share-meta-box" role="group" aria-labelledby="shMetaTitle">
      <div class="share-meta-head">${shIcon('alert')}<span class="share-meta-title" id="shMetaTitle">${shEsc(title)}</span>
        <button type="button" class="vault-btn share-btn-amber share-meta-fold" data-sh-metafold aria-controls="shMetaList" aria-expanded="${w.metaOpen ? 'true' : 'false'}">${w.metaOpen ? 'Hide details' : 'Show details'}</button>
      </div>
      <div class="share-meta-list" id="shMetaList" data-share-names${w.metaOpen ? '' : ' hidden'}>${rows}</div>
      <div class="share-meta-choices" role="radiogroup" aria-label="Personal details in the packed copies">
        ${choice('remove', 'Remove from the packed copies', removeNote)}
        ${choice('keep', 'Share as they are', keepNote)}
      </div>
    </div>${quiet}`;
}

/** The "Personal details" tag on a flagged row of the file list. */
const SHARE_META_TAG = '<span class="share-meta-tag">Personal details</span>';

/** The check's answer came (or its progress moved): draw it in place, never the whole step. */
function shareMetaUpdate(w) {
  if (!w || w !== _shareWin || w.step !== 'review') return;
  const slot = w.m.q('[data-sh-meta]');
  if (slot) {
    const html = shareMetaHtml(w);
    if (slot.innerHTML !== html) {
      // Keep the keyboard on the choice the user is on.
      const had = document.activeElement && slot.contains(document.activeElement) ? document.activeElement : null;
      slot.innerHTML = html;
      if (had && had.name === 'shMetaChoice') { const r = slot.querySelector(`input[value="${had.value}"]`); if (r) r.focus(); }
      sharePrivacyChanged(slot);
    }
  }
  if (w.meta) {
    const flagged = new Set((w.meta.files || []).map(f => Number(f.mediaId)));
    w.m.qa('#shFilesList .share-file[data-mid]').forEach((row) => {
      const on = flagged.has(Number(row.dataset.mid));
      const name = row.querySelector('.share-file-name');
      const tag = name && name.querySelector('.share-meta-tag');
      if (on && name && !tag) name.insertAdjacentHTML('beforeend', SHARE_META_TAG);
      if (!on && tag) tag.remove();
    });
  }
  shareSpaceUpdate(w);
}

/** The free space line, the no-space error and Pack files, from shareSpaceNow. */
function shareSpaceUpdate(w) {
  if (!w || w !== _shareWin || w.step !== 'review') return;
  const p = w.preview || {};
  const sp = shareSpaceNow(w);
  const line = w.m.q('[data-sh-space]');
  if (line) line.textContent = sp.needBytes ? `Packing needs about ${shareSize(sp.needBytes)} of free space.` : '';
  const err = w.m.q('[data-sh-nospace]');
  if (err) err.innerHTML = shareNoSpaceHtml(sp);
  const big = w.m.q('[data-sh-bignote] > span');
  if (big) big.textContent = shareBigNote({ ...p, needBytes: sp.needBytes });
  const btn = w.m.q('[data-sh-act="pack"]');
  if (btn && !w.busy && !w.metaWaitPack) btn.disabled = sp.enoughSpace === false || p.sevenZipFound === false;
}

function shareNoSpaceHtml(sp) {
  if (sp.enoughSpace !== false) return '';
  return `<div class="vault-modal-err" role="alert">${shIcon('alert')}<span>There is not enough free space to pack these files.${sp.missingBytes ? ` ${shEsc(shareSize(sp.missingBytes))} more is needed.` : ''}</span></div>`;
}

/**
 * Run the check for the window's files: start it, then ask where it is until
 * it is done. The window may be drawn again meanwhile; this only ever draws
 * the meta slot, the tags and the space line.
 */
async function shareMetaRun(w) {
  let st;
  try {
    st = await shareApi('POST', '/meta-check', { mediaIds: w.mediaIds });
    for (;;) {
      if (w !== _shareWin || w.step !== 'review') return;
      if (st.off) { w.preview.checkPersonal = false; break; }
      if (st.done) { w.meta = st; break; }
      w.metaProgress = st;
      shareMetaUpdate(w);
      await new Promise((r) => { w.metaTimer = setTimeout(r, 700); });
      if (w !== _shareWin || w.step !== 'review') return;
      st = await shareApi('GET', `/meta-check/${encodeURIComponent(st.id)}`, null, { background: true });
    }
  } catch {
    if (w !== _shareWin) return;
    w.metaError = true;
  }
  if (w !== _shareWin || w.step !== 'review') return;
  if (!w.preview.checkPersonal) {
    const slot = w.m.q('[data-sh-meta]');
    if (slot) slot.innerHTML = '';
  }
  shareMetaUpdate(w);
  if (w.metaWaitPack) {
    w.metaWaitPack = false;
    const btn = w.m.q('[data-sh-act="pack"]');
    if (btn) btn.textContent = 'Pack files';
    shareSpaceUpdate(w);
    if (w.meta && !(w.meta.personalCount > 0) && !(w.meta.failedCount > 0) && !(btn && btn.disabled)) { sharePackClicked(); return; }
    // Something was found (or the check failed): the user picks first.
    shareFocus(w.m.q('[data-sh-metafold]') || btn);
  }
}

/**
 * "This share is very large": Go back is the main button (bottom right, and it
 * has the focus); Pack anyway sits bottom left, away from where Pack files was
 * clicked. Esc and Go back return to step 1 with nothing started; a click
 * outside does nothing.
 */
function shareAskBig(w) {
  const p = { ...(w.preview || {}), needBytes: shareSpaceNow(w).needBytes };
  const size = shareSize(p.totalBytes);
  const files = (p.files || []).length;
  const uploads = shareUploadsAs(p);
  const m = shareModal({
    id: 'shareBigDlg', labelledBy: 'shareBigTitle', cls: 'share-dlg-small share-big-dlg',
    onEsc: () => back(),
    html: `
      <h3 id="shareBigTitle">This share is very large</h3>
      <p class="vault-modal-hint">Packing and uploading this much can take a long time. You can stop at any point, and parts already uploaded can be deleted.</p>
      <dl class="share-box share-sum share-big-facts">
        ${w.collectionName ? `<dt>Collection</dt><dd>${sharePrivSpan(w.collectionName)}</dd>` : ''}
        <dt>Files</dt><dd>${files.toLocaleString()}</dd>
        <dt>Total size</dt><dd class="share-big-total">${shEsc(size)}</dd>
        ${p.needBytes ? `<dt>Free space needed to pack</dt><dd>${shEsc(shareSize(p.needBytes))}</dd>` : ''}
        ${uploads ? `<dt>Uploads as</dt><dd>${shEsc(uploads.charAt(0).toUpperCase() + uploads.slice(1))}</dd>` : ''}
      </dl>
      <div class="vault-modal-actions share-actions">
        <button type="button" class="vault-btn share-btn-amber" data-sh-big="go">Pack ${shEsc(size)} anyway</button>
        <span class="share-sp"></span>
        <button type="button" class="vault-btn vault-btn-primary" data-sh-big="back">Go back</button>
      </div>`,
  });
  w.bigAsk = m;
  // The second click of a double click on Pack files lands on the backdrop:
  // it must not take the focus off Go back.
  m.ov.addEventListener('mousedown', (e) => { if (e.target === m.ov) e.preventDefault(); });
  function back() {
    if (m.closed) return;
    m.close();
    if (w.bigAsk === m) w.bigAsk = null;
  }
  m.q('[data-sh-big="back"]').addEventListener('click', back);
  m.q('[data-sh-big="go"]').addEventListener('click', () => {
    if (m.closed) return;
    back();
    if (w === _shareWin && w.step === 'review') sharePack();
  });
  shareFocus(m.q('[data-sh-big="back"]'));
}

function shareReviewHtml(w) {
  const p = w.preview;
  const files = p.files || [];
  const s = (_shareState && _shareState.settings) || {};
  const typedOk = p.nameMode === 'typed';
  const savedOk = !!p.savedPasswordSet;
  const split = p.split && p.partCount > 1;
  const partWords = p.partBytes ? shareSize(p.partBytes) : '';
  const splitWords = split ? `It is split into ${p.partCount} parts of up to ${partWords}.`
    : s.split === 'none' ? 'It is not split into parts.' : partWords ? `Over ${partWords} the archive is split into parts.` : '';
  // With cleaned copies to make, the space figures count them (shareSpaceNow).
  const sp = shareSpaceNow(w);
  const space = sp.needBytes ? `Packing needs about ${shareSize(sp.needBytes)} of free space.` : '';
  const noSpace = sp.enoughSpace === false;
  const blocked = noSpace || p.sevenZipFound === false;
  const flagged = new Set(((w.meta && w.meta.files) || []).map(f => Number(f.mediaId)));
  const intro = 'Review what will be packed. Nothing is uploaded yet.';
  // "When packing is done" is "Upload on its own": a tick box here is the
  // go-ahead (the server needs it, confirmUpload: true); left unticked, the
  // share waits for the check as usual.
  const auto = p.afterPack === 'upload';
  const sub = w.collectionName ? { html: `Collection: ${sharePrivSpan(w.collectionName)}. ${shEsc(intro)}` } : intro;
  const big = (Number(p.totalBytes) || 0) >= SHARE_LARGE_BYTES;
  // A long list folds to its first few rows; "and N more files" opens the rest.
  const fold = files.length > SHARE_FOLD_OVER;
  const hideRow = (i) => fold && !w.filesOpen && i >= SHARE_FOLD_SHOW;
  const more = files.length - SHARE_FOLD_SHOW;
  return `
    ${shareHead('Step 1 of 4', 'Share privately', sub)}
    <div class="share-box share-files" data-share-private>
      <div class="share-files-list" id="shFilesList" data-share-names>
        ${files.map((f, i) => `<div class="share-file"${hideRow(i) ? ' hidden' : ''} data-mid="${Number(f.mediaId) || 0}"><span class="share-file-name">${shEsc(f.nameInArchive || f.name)}${flagged.has(Number(f.mediaId)) ? SHARE_META_TAG : ''}</span><span class="share-mut">${shEsc(shareSize(f.sizeBytes))}</span></div>`).join('')}
      </div>
      ${fold ? `<button type="button" class="share-link-btn share-more-files" data-sh-more aria-controls="shFilesList" aria-expanded="${w.filesOpen ? 'true' : 'false'}">${w.filesOpen ? 'Show fewer' : `and ${more.toLocaleString()} more ${more === 1 ? 'file' : 'files'}`}</button>` : ''}
      <div class="share-file share-file-total"><span>${files.length.toLocaleString()} ${files.length === 1 ? 'file' : 'files'}</span><span${big ? ' class="share-big-total"' : ''}>${big ? `${shIcon('alert')}<span class="share-sr">Large share: </span>` : ''}${shEsc(shareSize(p.totalBytes))}</span></div>
    </div>
    ${p.checkPersonal ? `<div class="share-meta" data-sh-meta>${shareMetaHtml(w)}</div>` : ''}
    ${big ? `<div class="share-big-note" data-sh-bignote>${shIcon('alert')}<span>${shEsc(shareBigNote({ ...p, needBytes: sp.needBytes }))}</span></div>` : ''}
    <div class="share-block">
      <div class="share-label">What will leave this computer</div>
      <ul class="share-list">
        <li data-sh-namewords>One encrypted 7z archive with a random name</li>
        <li>File names are hidden inside the archive</li>
        <li>The password stays here and is never uploaded</li>
        <li>Tags, notes and ratings are not included</li>
      </ul>
    </div>
    <div class="share-grid">
      <div class="vault-field">
        <label class="vault-label" for="shDest">Goes to</label>
        <input class="vault-input" id="shDest" value="gofile.io (guest, no account)" readonly>
      </div>
      <div class="vault-field">
        <label class="vault-label" for="shExpiry">Delete from gofile after</label>
        ${shareSelect('shExpiry', SHARE_DELETE_AFTER_OPTIONS, p.deleteAfterDays)}
      </div>
      <div class="vault-field">
        <label class="vault-label" for="shName">Archive name</label>
        <input class="vault-input" id="shName" maxlength="80" spellcheck="false" autocomplete="off"
               placeholder="${typedOk ? 'Random (leave empty)' : 'Random (set in Settings)'}"${typedOk ? '' : ' disabled'}>
      </div>
      <div class="vault-field">
        <label class="vault-label" for="shPwSrc">Password</label>
        ${shareSelect('shPwSrc', [
          { value: 'random', label: 'New random password' },
          { value: 'saved', label: savedOk ? 'My saved default password' : 'My saved default password (none saved yet)', disabled: !savedOk },
        ], savedOk ? p.passwordChoice : 'random')}
      </div>
    </div>
    <p class="vault-modal-hint">${typedOk ? 'A name you type is not hidden: gofile and anyone with the link can read it. ' : ''}<span data-sh-space>${shEsc(space)}</span> ${shEsc(splitWords)}</p>
    <div data-sh-nospace>${shareNoSpaceHtml(sp)}</div>
    ${p.sevenZipFound === false ? `<div class="vault-modal-err" role="alert">${shIcon('alert')}<span>Vault could not find its 7-Zip program, so it cannot pack files.</span></div>` : ''}
    ${auto ? shareAutoBlockHtml(w, s) : ''}
    ${p.packBusy && !blocked ? '<p class="vault-modal-hint" data-sh-packbusy>Another share is being packed. This one waits its turn and starts on its own, so you can keep using Vault meanwhile.</p>' : ''}
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      <span class="share-sp"></span>
      <button type="button" class="vault-btn" data-sh-act="close">Cancel</button>
      <button type="button" class="vault-btn vault-btn-primary" data-sh-act="pack"${blocked || w.metaWaitPack ? ' disabled' : ''}>${w.metaWaitPack ? 'Waiting for the check…' : 'Pack files'}</button>
    </div>`;
}

/**
 * Step 1 with "Upload on its own": what it means, and the tick box that says
 * so for this share. The password note shows when the password of this share
 * would not be kept (a new random one while "Passwords of past shares" is
 * off): it then waits to be seen, so it is never lost unseen.
 */
function shareAutoBlockHtml(w, s) {
  return `
    <div class="share-warn" data-sh-auto>When packing is done is set to Upload on its own. Once this share is packed and checked, Vault uploads it to gofile.io without asking again. After that, anyone with the link and the password can download the files until the upload is deleted.</div>
    <label class="share-tick">
      <input type="checkbox" id="shAutoTick"${w.autoTicked ? ' checked' : ''}>
      <span>Upload this archive to gofile.io on its own once it is packed and checked. These files are mine to share under gofile's terms.</span>
    </label>
    <p class="vault-modal-hint">Leave it unticked and Vault waits for you to check the archive first.</p>
    <p class="vault-modal-hint" data-sh-autopw${shareAutoPasswordLost(w, s) ? '' : ' hidden'}>Vault is not keeping the passwords of past shares, so this share waits for you to see its password before it uploads.</p>`;
}

/** Would a share started now lose its password unseen (a new random one, not remembered)? */
function shareAutoPasswordLost(w, s) {
  const src = w && w.m && w.m.q && w.m.q('#shPwSrc');
  const choice = src ? src.value : ((w && w.preview && w.preview.savedPasswordSet && w.preview.passwordChoice) || 'random');
  return choice !== 'saved' && s.rememberPasswords === false;
}

/*
 * The one-time warning about an unencrypted library file (spec 6.5). The
 * server asks for it (WARNING_NEEDED) before it stores the first secret with
 * no Vault password: the saved password, or a share while passwords of past
 * shares are remembered. The same words in both places; shown once for both.
 */
const SHARE_PLAIN_WARNING = 'There is no Vault password, so the library file is not encrypted. Anyone who can open it can read what Share privately keeps there: the saved password, the passwords of past shares, and their links and upload keys.\n\n'
  + 'To protect them, set a Vault password. Or turn off "Passwords of past shares" so share passwords are not kept (the ones already kept are deleted). Links and upload keys are still kept, so Vault can delete the uploads later.\n\n'
  + 'If you go ahead, Vault does not show this again. If you turn off "Passwords of past shares" instead, Vault shows it again when that is turned back on.';

/** Before the first share is stored. Resolves 'continue', 'forget' or 'cancel'. */
function shareAskPlainWarning() {
  if (typeof vaultChoose !== 'function') return Promise.resolve('cancel');
  return vaultChoose(SHARE_PLAIN_WARNING, {
    title: 'Share without a Vault password?',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Do not remember passwords', value: 'forget' },
      { label: 'Continue', value: 'continue', primary: true },
    ],
    cancelValue: 'cancel',
  });
}

/**
 * POST /shares, with the one-time warning when the server asks for it.
 * Resolves the answer, or null when the user cancelled at the warning.
 */
async function shareStartRequest(body) {
  try {
    return await shareApi('POST', '/shares', body);
  } catch (err) {
    if (err.code !== 'WARNING_NEEDED') throw err;
    const pick = await shareAskPlainWarning();
    if (pick === 'continue') return shareApi('POST', '/shares', { ...body, acknowledgeNoVaultPassword: true });
    if (pick !== 'forget') return null;
    // Off for this share and the next ones; the server then needs no warning.
    const r = await shareApi('POST', '/settings', { rememberPasswords: false, confirm: true });
    if (_shareState) _shareState.settings = { ...(_shareState.settings || {}), ...r.settings };
    return shareApi('POST', '/shares', body);
  }
}

async function sharePack() {
  const w = _shareWin;
  if (!w || w.busy) return;
  const q = w.m.q;
  const btn = q('[data-sh-act="pack"]');
  const name = q('#shName') && !q('#shName').disabled ? q('#shName').value.trim() : '';
  const body = {
    mediaIds: w.mediaIds,
    passwordChoice: q('#shPwSrc').value === 'saved' ? 'saved' : 'random',
    deleteAfterDays: Number(q('#shExpiry').value),
  };
  if (name) body.name = name;
  // Only with "Upload on its own" in force and its tick box ticked.
  const autoTick = q('#shAutoTick');
  if (autoTick && autoTick.checked && w.preview && w.preview.afterPack === 'upload') body.confirmUpload = true;
  // Personal details: only the choice goes; the server checks the files itself.
  if (w.preview && w.preview.checkPersonal) body.removePersonal = w.metaChoice !== 'keep';
  w.busy = true;
  btn.disabled = true;
  btn.textContent = 'Starting…';
  shareSetError(q('[data-sh-err]'), '');
  try {
    const r = await shareStartRequest(body);
    if (w !== _shareWin) return;
    if (!r) {
      btn.disabled = false;
      btn.textContent = 'Pack files';
      return;
    }
    w.id = r.share.id;
    w.share = r.share;
    // A share started while another packs waits its turn in the pack line.
    w.step = r.share.status === 'queued' ? 'queued' : 'packing';
    w.progress = null;
    shareWindowRender();
    shareWindowPoll();
  } catch (err) {
    if (w !== _shareWin) return;
    shareSetError(q('[data-sh-err]'), err.message);
    btn.disabled = false;
    btn.textContent = 'Pack files';
  } finally {
    w.busy = false;
  }
}

/* Step 2, waiting to pack and packing. Both can be left: the window hides
   and the share carries on in My shares. */

/** "Collection: Summer 2026, 48 files, 14.2 GB. Nothing is uploaded yet." (the collection only from this window). */
function sharePackingSub(w) {
  const p = w.preview || {};
  const share = w.share || {};
  const files = p.files ? p.files.length : Number(share.fileCount) || 0;
  const bytes = p.files ? p.totalBytes : share.sizeBytes;
  const facts = `${files.toLocaleString()} ${files === 1 ? 'file' : 'files'}${bytes ? `, ${shareSize(bytes)}` : ''}. Nothing is uploaded yet.`;
  return w.collectionName ? { html: `Collection: ${sharePrivSpan(w.collectionName)}, ${shEsc(facts)}` } : facts;
}

/** The quiet line under the bar: the user need not wait here. */
function sharePackingInfo(w) {
  const own = !!((w.progress && w.progress.uploadsOnItsOwn) || (w.share && w.share.uploadsOnItsOwn));
  return own
    ? 'You do not need to wait here. Packing carries on in My shares while you use Vault, and once it is packed and checked it uploads on its own. The drive may feel slower until then.'
    : 'You do not need to wait here. Packing carries on in My shares while you use Vault, and it will be ready for you to check when it is done. The drive may feel slower until then.';
}

function shareQueuedHtml(w) {
  const ahead = (w.progress && w.progress.waitingFor) || (w.share && w.share.waitingFor) || '';
  return `
    ${shareHead('Step 2 of 4', 'Waiting to pack', sharePackingSub(w))}
    <div class="share-block">
      <div class="share-mut" data-sh-waitfor>${shareWaitForHtml(ahead)}</div>
    </div>
    <p class="vault-modal-hint">Vault packs one share at a time. This one starts on its own, so you can keep using Vault meanwhile.</p>
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      <button type="button" class="vault-btn" data-sh-act="cancel-archive">Cancel this share</button>
      <span class="share-sp"></span>
      <button type="button" class="vault-btn vault-btn-primary" data-sh-act="close" data-sh-first>Keep using Vault</button>
    </div>`;
}

/** "Starts when <name> is packed", the name blurred under privacy. */
function shareWaitForHtml(ahead) {
  return ahead ? `Starts when ${sharePrivSpan(ahead)} is packed.` : 'Starts when the share before it is packed.';
}

function shareQueuedUpdate() {
  const w = _shareWin;
  if (!w || w.step !== 'queued') return;
  const el = w.m.q('[data-sh-waitfor]');
  const html = shareWaitForHtml((w.progress && w.progress.waitingFor) || '');
  if (el && el.innerHTML !== html) { el.innerHTML = html; sharePrivacyChanged(el); }
}

function sharePackingHtml(w) {
  return `
    ${shareHead('Step 2 of 4', 'Packing', sharePackingSub(w))}
    <div class="share-block" data-sh-packing>
      <div class="share-row-between share-mut"><span data-sh-phase>Getting the files ready</span><span data-sh-pct></span></div>
      ${shareBar(0, 'Packing progress')}
    </div>
    <p class="vault-modal-hint" data-sh-bginfo>${shEsc(sharePackingInfo(w))}</p>
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      <button type="button" class="vault-btn" data-sh-act="cancel-archive">Cancel and delete archive</button>
      <span class="share-sp"></span>
      <button type="button" class="vault-btn vault-btn-primary" data-sh-act="close" data-sh-first>Keep using Vault</button>
    </div>`;
}

function sharePackingUpdate() {
  const w = _shareWin;
  if (!w || w.step !== 'packing') return;
  const pk = (w.progress && w.progress.packing) || { phase: 'staging', percent: 0 };
  const q = w.m.q;
  const phase = q('[data-sh-phase]');
  if (phase) phase.textContent = SHARE_PHASE_WORDS[pk.phase] || 'Packing';
  const pct = q('[data-sh-pct]');
  if (pct) pct.textContent = pk.phase === 'packing' || (pk.phase === 'cleaning' && pk.percent > 0) ? `${Math.round(pk.percent || 0)}%` : '';
  const bar = q('.share-bar');
  if (bar) {
    const v = pk.phase === 'checking' ? 100 : Math.round(pk.percent || 0);
    bar.setAttribute('aria-valuenow', String(v));
    bar.firstElementChild.style.width = `${v}%`;
  }
}

/** Cancel and delete archive (steps 2 and 3, packing, or a share that failed before upload). */
async function shareCancelArchive() {
  const w = _shareWin;
  if (!w || !w.id || w.busy) return;
  w.busy = true;
  const waiting = w.step === 'queued';
  try {
    await shareApi('POST', `/shares/${w.id}/cancel`, {});
    if (w !== _shareWin) return;
    shareWindowClose();
    shToast(waiting ? 'Cancelled. Nothing was packed.' : 'Stopped. The packed archive was deleted.');
    shareStatePollSoon();
  } catch (err) {
    if (w !== _shareWin) return;
    if (err.code === 'NOT_FOUND') { shareWindowClose(); return; }
    shareSetError(w.m.q('[data-sh-err]'), err.message);
  } finally {
    w.busy = false;
  }
}

/* Step 2: the checks passed. */

/** line: plain words, or { html } already escaped (the archive line, with its name blurred under privacy). */
function shareCheckRow(ok, title, line, mono = false) {
  const lineHtml = line && typeof line === 'object' ? line.html : shEsc(line);
  return `
    <div class="share-check${ok ? '' : ' is-bad'}">
      ${shIcon(ok ? 'check' : 'alert', 'share-check-ic')}
      <div class="share-check-text"><span>${shEsc(title)}</span><span class="share-mut${mono ? ' share-mono' : ''}">${lineHtml}</span></div>
    </div>`;
}

function sharePasswordBlockHtml(w, label) {
  const share = w.share || {};
  const kept = share.passwordKept !== false;
  const gate = shareNeedsGate(share);
  if (!kept) return `<p class="vault-modal-hint">Vault did not keep the password of this share.</p>`;
  return `
    <div class="vault-field">
      <label class="vault-label" for="shPw">${shEsc(label)}</label>
      <div class="share-pw-row">
        <input type="password" id="shPw" class="vault-input share-mono" readonly placeholder="••••••••••••••••••••" autocomplete="off" data-share-private data-share-mask>
        <button type="button" class="vault-btn" data-sh-act="pw-show" aria-pressed="false">Show</button>
        <button type="button" class="vault-btn" data-sh-act="pw-copy">Copy${label.startsWith('Archive') ? ' password' : ''}</button>
      </div>
      ${gate ? '<div class="vault-field-note">It shows as dots until you enter your Vault password.</div>' : ''}
    </div>`;
}

function shareCheckedHtml(w) {
  const share = w.share || {};
  const c = (w.progress && w.progress.checks) || share.checks || {};
  const files = c.contents && c.contents.files != null ? c.contents.files : share.fileCount;
  const typed = c.archiveName ? c.archiveName.typed : share.nameTyped;
  const pwLabel = share.passwordKind === 'saved' ? 'Password (your saved default)' : 'Password (new random, 24 characters)';
  return `
    ${shareHead('Step 2 of 4', 'Check the archive', 'Packed and tested on this computer. Still nothing uploaded.')}
    <div class="share-box share-checks">
      ${shareCheckRow(!!(c.test && c.test.ok), 'Encrypted with AES-256', `Opening it with the password worked. ${files === 1 ? 'The file passed' : `All ${Number(files || 0).toLocaleString()} files passed`} the test.`)}
      ${shareCheckRow(!!(c.listWithoutPassword && c.listWithoutPassword.ok), 'File names are hidden', 'Listing the archive without the password was refused.')}
      ${shareCheckRow(true, typed ? 'Archive name (you typed it, so anyone with the link can read it)' : 'Archive name (random, change it on step 1)', { html: shareArchiveLineHtml(share, c) }, true)}
    </div>
    <div class="share-warn" data-sh-autonote${shareCheckedNote(w) ? '' : ' hidden'}>${shEsc(shareCheckedNote(w))}</div>
    ${sharePasswordBlockHtml(w, pwLabel)}
    <p class="vault-modal-hint">Without this password nobody can open the archive, including gofile.</p>
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      <button type="button" class="vault-btn" data-sh-act="cancel-archive">Cancel and delete archive</button>
      <span class="share-sp"></span>
      <button type="button" class="vault-btn vault-btn-primary" data-sh-act="to-confirm">Continue</button>
    </div>`;
}

/** Why a share set to upload on its own is still waiting here (the server's words), or ''. */
function shareCheckedNote(w) {
  return String((w.progress && w.progress.error) || '');
}

function shareCheckedNoteUpdate() {
  const w = _shareWin;
  if (!w || w.step !== 'checked') return;
  const el = w.m.q('[data-sh-autonote]');
  const text = shareCheckedNote(w);
  if (el && el.textContent !== text) { el.textContent = text; el.hidden = !text; }
}

/** Show (or hide) the share's password in #shPw; Copy puts it on the clipboard. */
async function sharePasswordAction(kind, btn) {
  const w = _shareWin;
  if (!w || !w.id) return;
  const input = w.m.q('#shPw');
  if (kind === 'show' && input && input.value) {
    const show = !shareFieldShown(input);
    shareSetFieldShown(input, show);
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
    return;
  }
  try {
    const r = await shareWithGate((vaultPassword) => shareApi('POST', `/shares/${w.id}/password`, vaultPassword ? { vaultPassword } : {}),
      { needed: shareNeedsGate(w.share), why: 'This share uses your saved password. Vault asks for your Vault password before it shows it.' });
    if (!r || w !== _shareWin) return;
    if (kind === 'copy') {
      await shareCopyText(r.password, 'Password copied');
      if (input && !input.value) input.value = r.password;
    } else if (input) {
      input.value = r.password;
      shareSetFieldShown(input, true);
      btn.textContent = 'Hide';
      btn.setAttribute('aria-pressed', 'true');
    }
    // Step 4: the block shows the real password once it has been asked for.
    if (w.step === 'done') shareDoneBlockReal(r.password);
  } catch (err) {
    if (w === _shareWin) shareSetError(w.m.q('[data-sh-err]'), err.message);
  }
}

/* Step 3: confirm. */

function shareAccountWords(mode) {
  return mode === 'perShare' ? 'Guest, made for this share'
    : mode === 'keep' ? 'Guest, made for Vault on first use'
      : 'Guest, made for Vault this session';
}

function shareConfirmHtml(w) {
  const share = w.share || {};
  const c = (w.progress && w.progress.checks) || share.checks || {};
  const s = (_shareState && _shareState.settings) || {};
  const bytes = c.parts && c.parts.bytes ? c.parts.bytes : share.sizeBytes;
  const offline = !!(_shareState && _shareState.offline);
  return `
    ${shareHead('Step 3 of 4', 'Upload to gofile.io?', 'This is the only step that sends anything off this computer.')}
    <div class="share-warn">Everything else in Vault stays on your computer. This upload does not. Once it is sent, anyone with the link and the password can download the files until the upload is deleted.</div>
    <dl class="share-box share-sum">
      <dt>Sending</dt><dd class="share-mono">${shareArchiveLineHtml(share, c)}</dd>
      <dt>To</dt><dd>upload.gofile.io (closest server)</dd>
      <dt>Account</dt><dd>${shEsc(shareAccountWords(s.accountMode))}</dd>
      <dt>Deleted after</dt><dd>${shEsc(shareDeleteAfterLabel(share.deleteAfterDays))}</dd>
      <dt>gofile can see</dt><dd>Your internet address and the archive size. Not the contents or file names.</dd>
    </dl>
    <label class="share-tick">
      <input type="checkbox" id="shTick" data-sh-first${w.ticked ? ' checked' : ''}>
      <span>I want to upload this archive to gofile.io, and these files are mine to share under gofile's terms.</span>
    </label>
    ${offline ? `<p class="vault-modal-hint" data-sh-offline>Vault is set to stay offline (VAULT_OFFLINE=1), so it cannot reach gofile.io. Uploads, deletes and delete timers are all blocked.</p>` : ''}
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      <button type="button" class="vault-btn" data-sh-act="cancel-archive">Cancel and delete archive</button>
      <span class="share-sp"></span>
      <button type="button" class="vault-btn" data-sh-act="back">Back</button>
      <button type="button" class="vault-btn vault-btn-primary" data-sh-act="upload"${shareUploadAllowed(w) ? '' : ' disabled'}>Upload ${shEsc(shareSize(bytes))}</button>
    </div>`;
}

/** Upload stays off until the box is ticked (and while a request is out). */
function shareUploadAllowed(w) {
  return !!(w && w.ticked && !w.busy);
}

async function shareStartUpload() {
  const w = _shareWin;
  if (!w || !w.id || !shareUploadAllowed(w)) return;
  const btn = w.m.q('[data-sh-act="upload"]');
  w.busy = true;
  if (btn) btn.disabled = true;
  shareSetError(w.m.q('[data-sh-err]'), '');
  try {
    const p = await shareApi('POST', `/shares/${w.id}/upload`, { confirm: true });
    if (w !== _shareWin) return;
    w.busy = false;
    w.progress = p;
    w.step = 'upload';
    w.samples = [];
    shareNoteSample(w, p);
    shareWindowRender();
    shareWindowPoll();
    shareStatePollSoon();
  } catch (err) {
    if (w !== _shareWin) return;
    w.busy = false;
    // The same words as the offline note: say it once, as the error.
    if (err.code === 'NET_OFF') { const note = w.m.q('[data-sh-offline]'); if (note) note.remove(); }
    shareSetError(w.m.q('[data-sh-err]'), err.message);
    if (btn) btn.disabled = !shareUploadAllowed(w);
    if (err.code === 'PARTS_CHANGED' || err.code === 'NOT_CHECKED') { w.failText = err.message; w.step = 'failed'; shareWindowRender(); }
  }
}

/* Step 3b: uploading. */

function shareUploadHtml(w) {
  const share = w.share || {};
  const up = (w.progress && w.progress.upload) || { parts: [] };
  const parts = up.parts || [];
  const count = parts.length || share.partCount || 1;
  const biggest = parts.reduce((n, x) => Math.max(n, x.sizeBytes || 0), 0) || share.partSize;
  const sub = count > 1
    ? `${shareSize(up.bytesTotal || share.sizeBytes)} in ${count} parts of up to ${shareSize(share.partSize || biggest)}. You can close this window; the upload keeps going.`
    : `${shareSize(up.bytesTotal || share.sizeBytes)} in one part. You can close this window; the upload keeps going.`;
  return `
    ${shareHead('Step 3 of 4, uploading', 'Uploading', sub, share.archiveName || '')}
    <div class="share-block">
      <div class="share-row-between share-mut"><span data-sh-bytes></span><span data-sh-eta></span></div>
      ${shareBar(up.percent, 'Overall progress')}
    </div>
    <div class="share-box share-parts" data-sh-parts></div>
    <div class="share-note-bad" data-sh-partnote hidden></div>
    <p class="vault-modal-hint" data-sh-state></p>
    <p class="vault-modal-hint">The link and password appear when every part is up.${count > 1 ? ` Whoever downloads needs all ${count} parts in one folder, then opens the first one.` : ''}</p>
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      <button type="button" class="vault-btn share-btn-danger" data-sh-act="stop">Stop and delete uploaded parts</button>
      <span class="share-sp"></span>
      <button type="button" class="vault-btn" data-sh-act="pause">Pause</button>
    </div>`;
}

function sharePartRowHtml(p) {
  const st = p.status;
  const right = st === 'done' ? '<span class="share-part-st is-ok">Done</span>'
    : st === 'failed' ? `<button type="button" class="vault-btn" data-sh-retry="${Number(p.partNo)}">Try again</button>`
      : st === 'uploading' ? `<span class="share-part-st is-busy" data-sh-partpct="${Number(p.partNo)}">${Math.round(p.percent || 0)}%</span>`
        : '<span class="share-part-st share-mut">Waiting</span>';
  const ic = st === 'done' ? shIcon('check', 'share-part-ic is-ok') : st === 'failed' ? shIcon('alert', 'share-part-ic is-bad') : shIcon('upload', 'share-part-ic');
  return `<div class="share-part">${ic}<span class="share-part-name share-mono" data-share-private>${shEsc(p.fileName)}</span><span class="share-mut">${shEsc(shareSize(p.sizeBytes))}</span>${right}</div>`;
}

/** Update 3b in place: numbers every poll, the rows only when a status changed (keeps focus). */
function shareUploadUpdate() {
  const w = _shareWin;
  if (!w || w.step !== 'upload') return;
  const q = w.m.q;
  const p = w.progress || {};
  const stopping = p.status === 'stopping';
  const up = p.upload || { parts: [], bytesDone: 0, bytesTotal: 0, percent: 0 };
  const parts = up.parts || [];
  const bytes = q('[data-sh-bytes]');
  if (bytes) bytes.textContent = `${shareSize(up.bytesDone)} of ${shareSize(up.bytesTotal)}`;
  const eta = q('[data-sh-eta]');
  if (eta) eta.textContent = p.status === 'uploading' ? shareEta(up.bytesTotal - up.bytesDone, shareRate(w)) : '';
  const bar = q('.share-bar');
  if (bar) { bar.setAttribute('aria-valuenow', String(up.percent || 0)); bar.firstElementChild.style.width = `${up.percent || 0}%`; }
  const sig = parts.map(x => `${x.partNo}:${x.status}`).join(',');
  const host = q('[data-sh-parts]');
  if (host && sig !== w.partsSig) {
    w.partsSig = sig;
    host.innerHTML = parts.map(sharePartRowHtml).join('');
    sharePrivacyChanged(host);
  } else if (host) {
    for (const x of parts) {
      const el = host.querySelector(`[data-sh-partpct="${Number(x.partNo)}"]`);
      if (el) el.textContent = `${Math.round(x.percent || 0)}%`;
    }
  }
  const failed = parts.filter(x => x.status === 'failed');
  const note = q('[data-sh-partnote]');
  if (note) {
    if (failed.length) {
      const f = failed[0];
      const others = parts.filter(x => x.status === 'done').map(x => x.partNo);
      note.textContent = `Part ${f.partNo} failed${f.tries ? ` ${f.tries} ${f.tries === 1 ? 'time' : 'times'}` : ''}${f.error ? ` (${f.error})` : ''}.`
        + (others.length ? ` ${others.length === 1 ? `Part ${others[0]} is` : `Parts ${others.slice(0, -1).join(', ')} and ${others[others.length - 1]} are`} not affected.` : '');
      note.hidden = false;
    } else { note.hidden = true; note.textContent = ''; }
  }
  const stateLine = q('[data-sh-state]');
  if (stateLine) {
    const enabled = shareEnabled();
    stateLine.textContent = p.status === 'stopping' ? 'Stopping and deleting the uploaded parts.'
      : up.waitingInLine ? 'Waiting for another upload to finish.'
      : p.status === 'paused' ? (p.error || 'Paused.')
        : p.status === 'not_finished' ? 'Vault was closed during the upload. Resume to carry on.'
          : '';
    if (!enabled && (p.status === 'paused' || p.status === 'not_finished')) stateLine.textContent += ' Turn on Share privately in Settings to carry on.';
  }
  const pause = q('[data-sh-act="pause"]');
  if (pause) {
    const resume = p.status === 'paused' || p.status === 'not_finished';
    pause.textContent = resume ? 'Resume' : 'Pause';
    pause.dataset.shMode = resume ? 'resume' : 'pause';
    pause.disabled = (resume && !shareEnabled()) || stopping;
  }
  const stopBtn = q('[data-sh-act="stop"]');
  if (stopBtn) stopBtn.disabled = stopping;
  // Try again needs the feature on; Stop and delete works either way.
  host?.querySelectorAll('[data-sh-retry]').forEach((b) => { b.disabled = !shareEnabled() || stopping; });
}

async function shareUploadAct(kind, arg) {
  const w = _shareWin;
  if (!w || !w.id || w.busy) return;
  if (kind === 'stop') {
    const ok = typeof vaultConfirm === 'function' ? await vaultConfirm(
      'The parts already on gofile are deleted, then the packed archive on this computer. Your own files are not touched.',
      { title: 'Stop and delete uploaded parts?', okLabel: 'Stop and delete', cancelLabel: 'Keep uploading', danger: true }) : true;
    if (!ok || w !== _shareWin) return;
  }
  w.busy = true;
  shareSetError(w.m.q('[data-sh-err]'), '');
  try {
    const path = kind === 'retry' ? `/shares/${w.id}/parts/${Number(arg)}/retry` : `/shares/${w.id}/${kind}`;
    const r = await shareApi('POST', path, kind === 'stop' ? { confirm: true } : {});
    if (w !== _shareWin) return;
    if (kind === 'stop') {
      shareWindowClose();
      shToast('Stopped. The uploaded parts and the packed archive were deleted.');
      shareStatePollSoon();
      return;
    }
    w.progress = r;
    w.partsSig = '';
    shareUploadUpdate();
    shareStatePollSoon();
  } catch (err) {
    if (w === _shareWin) shareSetError(w.m.q('[data-sh-err]'), err.message);
    if (kind === 'stop' && w === _shareWin) shareWindowRefresh();
  } finally {
    w.busy = false;
  }
}

/* Step 4: link and password. */

function shareDoneHtml(w) {
  const share = w.share || {};
  const s = (_shareState && _shareState.settings) || {};
  const link = share.link || (w.progress && w.progress.link) || '';
  const kept = share.passwordKept !== false;
  const masked = shareRenderFormat(shareFormatFor(s), { link, code: share.code || '', name: share.archiveName || '', pass: kept ? '••••••••••••' : null });
  const timer = share.deleteAt
    ? `gofile deletes this upload ${shareTimeLeft(share.deleteAt)}. Free gofile storage is temporary, so it may go sooner if nobody downloads it.`
    : share.deleteAfterDays && !share.timerSet
      ? 'gofile did not take the timer, so it decides when this upload goes. Free gofile storage is temporary.'
      : 'No timer is set, so gofile decides when it goes. Free gofile storage is temporary, so it may go sooner if nobody downloads it.';
  const local = s.keepLocal ? 'The packed archive was kept on this computer. Your original files are untouched.'
    : 'The local archive has been deleted. Your original files are untouched.';
  return `
    ${shareHead('Step 4 of 4', share.status === 'expired' ? 'Uploaded, timer ran out' : 'Uploaded', 'Send the link and the password separately if you can.')}
    <div class="vault-field">
      <label class="vault-label" for="shLink">Link</label>
      <div class="share-pw-row">
        <input class="vault-input share-mono" id="shLink" readonly value="${shEsc(link)}" data-share-private data-share-mask>
        <button type="button" class="vault-btn" data-sh-act="copy-link" data-sh-first>Copy link</button>
      </div>
    </div>
    ${sharePasswordBlockHtml(w, 'Archive password')}
    <div class="vault-field">
      <div class="vault-label" id="shBlockLabel">Both together</div>
      <div class="share-pw-row share-block-row">
        <pre class="share-pre share-mono" aria-labelledby="shBlockLabel" data-sh-block data-share-private>${shEsc(masked)}</pre>
        <button type="button" class="vault-btn vault-btn-primary" data-sh-act="copy-block">Copy as block</button>
      </div>
    </div>
    <div class="share-box share-notes">
      <div>${shEsc(timer)}${share.deleteAfterDays && !share.timerSet && share.status === 'uploaded' ? ` <button type="button" class="share-link-btn" data-sh-act="retry-timer"${shareEnabled() ? '' : ' disabled'}>Set timer again</button>` : ''}</div>
      <div>${shEsc(local)}</div>
    </div>
    <p class="vault-modal-hint">Find this again under My shares.</p>
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      <button type="button" class="vault-btn share-btn-danger" data-sh-act="delete-remote">Delete from gofile now</button>
      <span class="share-sp"></span>
      <button type="button" class="vault-btn" data-sh-act="close">Done</button>
    </div>`;
}

/** Once the password has been asked for, the block shows it too. */
function shareDoneBlockReal(password) {
  const w = _shareWin;
  if (!w || w.step !== 'done') return;
  const share = w.share || {};
  const s = (_shareState && _shareState.settings) || {};
  const pre = w.m.q('[data-sh-block]');
  if (pre) pre.textContent = shareRenderFormat(shareFormatFor(s), { link: share.link || '', code: share.code || '', name: share.archiveName || '', pass: password });
}

async function shareDoneAct(kind) {
  const w = _shareWin;
  if (!w || !w.id) return;
  const share = w.share || {};
  const err = (m) => shareSetError(w.m.q('[data-sh-err]'), m);
  try {
    if (kind === 'copy-link') {
      const link = share.link || (w.progress && w.progress.link);
      if (link) await shareCopyText(link, 'Link copied');
    } else if (kind === 'copy-block') {
      const r = await shareWithGate((vaultPassword) => shareApi('POST', `/shares/${w.id}/copy-block`, vaultPassword ? { vaultPassword } : {}),
        { needed: shareNeedsGate(share) && /\{pass\}/.test(shareFormatFor((_shareState && _shareState.settings) || {})), why: 'This share uses your saved password. Vault asks for your Vault password before it copies it.' });
      if (!r || w !== _shareWin) return;
      await shareCopyText(r.text, r.passwordIncluded ? 'Link and password copied' : 'Link copied. Vault did not keep the password.');
    } else if (kind === 'retry-timer') {
      const r = await shareApi('POST', `/shares/${w.id}/retry-timer`, {});
      if (w !== _shareWin) return;
      w.share = { ...share, ...r.share };
      shareWindowRender();
    } else if (kind === 'delete-remote') {
      const ok = typeof vaultConfirm === 'function' ? await vaultConfirm(
        'The link stops working for everyone and this cannot be undone. Your own files on this computer are not touched.',
        { title: 'Delete this upload from gofile?', okLabel: 'Delete from gofile', cancelLabel: 'Keep it', danger: true }) : true;
      if (!ok || w !== _shareWin) return;
      const r = await shareApi('POST', `/shares/${w.id}/delete-remote`, {});
      if (w !== _shareWin) return;
      shareWindowClose();
      shToast(r.share && r.share.status === 'gone' ? 'gofile said it was already gone. Marked as gone.' : 'Deleted from gofile.');
      shareStatePollSoon();
    }
  } catch (e) {
    if (w === _shareWin) err(e.message);
  }
}

/* Failed. */

// The server's words when a cleaned copy could not be made (service.js
// CLEAN_FAILED_START): the file name in them is blurred like the file list.
const SHARE_CLEAN_FAILED_RX = /^(Vault could not remove personal details from )(.+?)(, so this share was not packed\..*)$/s;
// And when a file's check failed (service.js CHECK_FAILED_START).
const SHARE_CHECK_FAILED_RX = /^(Vault could not check )(.+?)((?: and \d+ more files?)? for personal details, so this share was not packed\..*)$/s;

/** A share's error as markup: plain words, with a file name in it hidden under privacy. */
function shareErrorHtml(text) {
  const t = String(text == null ? '' : text);
  const m = SHARE_CLEAN_FAILED_RX.exec(t) || SHARE_CHECK_FAILED_RX.exec(t);
  if (!m || /^(one|\d+) of the files$/.test(m[2])) return shEsc(t);
  return `${shEsc(m[1])}<span class="share-priv" data-share-names>${shEsc(m[2])}</span>${shEsc(m[3])}`;
}

function shareFailedHtml(w) {
  const share = w.share || {};
  const remote = !!share.onGofile;
  const local = w.failLocal;
  return `
    ${shareHead('', 'Share privately stopped', remote ? 'Some parts may already be on gofile.' : 'Nothing was uploaded.')}
    <div class="share-warn share-warn-bad" role="alert">${shareErrorHtml(w.failText || 'Something went wrong.')}</div>
    <p class="vault-modal-hint">${remote ? 'Delete what was uploaded so far. You can also do it later from My shares.' : local ? 'Nothing was packed and nothing left this computer.' : 'Delete the packed archive to clean up. Your own files are not touched.'}</p>
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="vault-modal-actions share-actions">
      ${local ? '' : remote
    ? '<button type="button" class="vault-btn share-btn-danger" data-sh-act="delete-remote">Delete uploaded parts</button>'
    : '<button type="button" class="vault-btn" data-sh-act="cancel-archive">Delete archive</button>'}
      <span class="share-sp"></span>
      <button type="button" class="vault-btn vault-btn-primary" data-sh-act="close">Close</button>
    </div>`;
}

/* One click listener per render. */

function shareWireWindow(w) {
  const box = w.m.box;
  box.querySelectorAll('[data-sh-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.shAct;
      if (act === 'close') return shareWindowRequestClose();
      if (act === 'pack') return sharePackClicked();
      if (act === 'cancel-archive') return shareCancelArchive();
      if (act === 'to-confirm') { w.step = 'confirm'; w.ticked = false; return shareWindowRender(); }
      if (act === 'back') { w.step = 'checked'; return shareWindowRender(); }
      if (act === 'upload') return shareStartUpload();
      if (act === 'pw-show') return sharePasswordAction('show', btn);
      if (act === 'pw-copy') return sharePasswordAction('copy', btn);
      if (act === 'stop') return shareUploadAct('stop');
      if (act === 'pause') return shareUploadAct(btn.dataset.shMode === 'resume' ? 'resume' : 'pause');
      if (act === 'delete-remote' && w.step === 'failed') return shareDoneAct('delete-remote');
      return shareDoneAct(act);
    });
  });
  const parts = box.querySelector('[data-sh-parts]');
  if (parts) parts.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sh-retry]');
    if (b) shareUploadAct('retry', b.dataset.shRetry);
  });
  const tick = box.querySelector('#shTick');
  if (tick) tick.addEventListener('change', () => {
    w.ticked = tick.checked;
    const up = box.querySelector('[data-sh-act="upload"]');
    if (up) up.disabled = !shareUploadAllowed(w);
  });
  // Step 1's folded list opens and closes in place (a new draw would drop what was typed).
  const more = box.querySelector('[data-sh-more]');
  if (more) more.addEventListener('click', () => shareToggleFiles(w, more));
  // The personal details box: its fold and its two choices (in place, so the
  // rest of step 1 keeps what was typed). The slot stays; its inside changes.
  const metaSlot = box.querySelector('[data-sh-meta]');
  if (metaSlot) {
    metaSlot.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-sh-metafold]');
      if (!b) return;
      w.metaOpen = !w.metaOpen;
      const list = metaSlot.querySelector('#shMetaList');
      if (list) list.hidden = !w.metaOpen;
      b.textContent = w.metaOpen ? 'Hide details' : 'Show details';
      b.setAttribute('aria-expanded', w.metaOpen ? 'true' : 'false');
    });
    metaSlot.addEventListener('change', (e) => {
      const r = e.target;
      if (!r || r.name !== 'shMetaChoice') return;
      w.metaChoice = r.value === 'keep' ? 'keep' : 'remove';
      shareSpaceUpdate(w);
    });
  }
  // Upload on its own (step 1): the tick is kept across a redraw, and the
  // password note follows the password picked.
  const autoTick = box.querySelector('#shAutoTick');
  if (autoTick) autoTick.addEventListener('change', () => { w.autoTicked = autoTick.checked; });
  const pwSrc = box.querySelector('#shPwSrc');
  const autoPw = box.querySelector('[data-sh-autopw]');
  if (pwSrc && autoPw) pwSrc.addEventListener('change', () => { autoPw.hidden = !shareAutoPasswordLost(w, (_shareState && _shareState.settings) || {}); });
  const name = box.querySelector('#shName');
  if (name) name.addEventListener('input', () => {

    const li = box.querySelector('[data-sh-namewords]');
    if (li) li.textContent = name.value.trim() ? 'One encrypted 7z archive with the name you typed' : 'One encrypted 7z archive with a random name';
  });
  shareWireShowButtons(box);
}

/* ── Top bar icon ─────────────────────────────────────────────────────── */

let _shareTop = { popOpen: false };

function shareEnsureTopBar() {
  let wrap = document.getElementById('sharePillWrap');
  if (wrap) return wrap;
  const btns = document.querySelector('.header-buttons');
  if (!btns) return null;
  wrap = document.createElement('div');
  wrap.className = 'share-pill-wrap';
  wrap.id = 'sharePillWrap';
  wrap.hidden = true;
  const icon = typeof vaultIconSwap === 'function' ? vaultIconSwap('📤', 'upload') : '📤';
  wrap.innerHTML = `
    <button type="button" class="header-btn share-pill" id="sharePill" aria-haspopup="dialog" aria-expanded="false"
            aria-controls="sharePop" aria-label="My shares">${icon}<span class="share-pill-badge" id="sharePillBadge" hidden></span></button>
    <div class="watch-pop share-pop" id="sharePop" role="dialog" aria-label="Shares" hidden></div>`;
  const refresh = document.getElementById('refreshBtn');
  btns.insertBefore(wrap, refresh || null);
  wrap.querySelector('#sharePill').addEventListener('click', (e) => { e.stopPropagation(); sharePillClick(); });
  wrap.querySelector('#sharePop').addEventListener('click', (e) => {
    const list = e.target.closest('[data-share-list]');
    if (list) { shareTogglePop(false); shareOpenMyShares(); return; }
    const b = e.target.closest('[data-share-open]');
    if (!b) return;
    shareTogglePop(false);
    shareOpenShare(Number(b.dataset.shareOpen));
  });
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target)) shareTogglePop(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _shareTop.popOpen) shareTogglePop(false); });
  return wrap;
}

function shareTogglePop(open) {
  const pop = document.getElementById('sharePop');
  const btn = document.getElementById('sharePill');
  if (!pop || !btn) return;
  const next = open === undefined ? pop.hidden : !!open;
  pop.hidden = !next;
  _shareTop.popOpen = next;
  btn.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (next) shareRenderPop();
}

/** The upload line's first words, by status. */
const SHARE_TOP_VERB = { uploading: 'Uploading', paused: 'Paused:', not_finished: 'Upload not finished:' };

/** Counts for the icon: { working, ready, parts, stuck } (stuck: an upload paused or not finished). */
function shareTopCounts(tb) {
  const up = tb && tb.upload;
  return {
    working: (tb && tb.packing ? 1 : 0) + (up && up.status === 'uploading' ? 1 : 0) + (Number(tb && tb.packWaiting) || 0),
    ready: Number(tb && tb.readyToCheck) || 0,
    parts: Number(tb && tb.needsYou) || 0,
    stuck: !!(up && (up.status === 'paused' || up.status === 'not_finished')),
  };
}

/** Is a share packing, uploading, paused, not finished or holding a failed part? */
function shareTopActive(tb) {
  if (!tb) return false;
  if (typeof tb.active === 'boolean') return tb.active;
  return !!(tb.shareId || tb.needsYou);
}

/** The top bar button: the small popup while a share runs or needs you, else My shares. */
function sharePillClick() {
  if (shareTopActive(_shareState && _shareState.topBar)) { shareTogglePop(); return; }
  shareTogglePop(false);
  if (typeof shareOpenMyShares === 'function') shareOpenMyShares();
}

function shareRenderPill() {
  const wrap = shareEnsureTopBar();
  if (!wrap) return;
  const tb = _shareState && _shareState.topBar;
  if (!tb || !tb.show) { wrap.hidden = true; shareTogglePop(false); return; }
  wrap.hidden = false;
  const active = shareTopActive(tb);
  const c = shareTopCounts(tb);
  // The look: red with a failed part, amber with a share ready to check (or an
  // upload paused or not finished), the accent while something only runs.
  wrap.dataset.state = !active ? 'idle' : c.parts ? 'needs' : c.ready ? 'ready'
    : c.stuck ? tb.upload.status : tb.packing ? 'packing' : 'uploading';
  // The badge: failed parts first (red), else shares ready to check (amber).
  const badge = document.getElementById('sharePillBadge');
  const n = c.parts || c.ready;
  if (badge) {
    badge.hidden = !n;
    badge.textContent = n ? String(n) : '';
    badge.dataset.tone = !c.parts && c.ready ? 'amber' : 'red';
  }
  const btn = document.getElementById('sharePill');
  // Idle, it opens My shares directly: no popup to announce.
  if (active) btn.setAttribute('aria-haspopup', 'dialog'); else btn.removeAttribute('aria-haspopup');
  if (!active && _shareTop.popOpen) shareTogglePop(false);
  const bits = [];
  if (c.working) bits.push(`${c.working} working`);
  if (c.ready) bits.push(`${c.ready} ready to check`);
  if (c.stuck) bits.push(tb.upload.status === 'paused' ? 'an upload is paused' : 'an upload is not finished');
  if (c.parts) bits.push(`${c.parts} ${c.parts === 1 ? 'part needs' : 'parts need'} you`);
  const label = !active ? 'My shares' : `Shares: ${bits.join(', ') || 'open My shares'}`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
  if (_shareTop.popOpen) shareRenderPop();
}

/**
 * The popup: the share being packed and the upload, each with its bar and an
 * Open button, then how many wait to pack, the amber line for shares packed
 * and ready to check, and Open My shares. Archive names are blurred under
 * privacy (data-share-private); the buttons stay usable.
 */
function shareRenderPop() {
  const pop = document.getElementById('sharePop');
  const tb = _shareState && _shareState.topBar;
  if (!pop || !tb) return;
  const pk = tb.packing;
  const up = tb.upload;
  const row = (id, title, right, bar, line) => `
    <div class="share-pop-row">
      <div class="share-pop-text" data-share-private>
        <div class="share-pop-top"><b>${shEsc(title)}</b>${right ? `<span class="watch-pop-mut">${shEsc(right)}</span>` : ''}</div>
        ${bar}
        ${line ? `<span class="watch-pop-mut share-pop-line">${shEsc(line)}</span>` : ''}
      </div>
      <button type="button" class="watch-pop-btn" data-share-open="${Number(id)}">Open</button>
    </div>`;
  let html = '';
  if (pk) {
    const pct = pk.phase === 'checking' ? 100 : Math.round(pk.percent || 0);
    const cleaning = pk.phase === 'cleaning';
    const right = pk.phase === 'packing' || (cleaning && pct > 0) ? `${pct}%` : pk.phase === 'checking' ? 'Checking' : cleaning ? '' : 'Getting ready';
    html += row(pk.shareId, `Packing ${pk.archiveName || ''}`.trim(), right, shareBar(pct, `Packing ${pct} percent`), cleaning ? 'Removing personal details' : '');
  }
  if (up) {
    const pct = Math.round(up.percent || 0);
    const verb = up.status === 'uploading' && up.waitingInLine ? 'Waiting to upload' : (SHARE_TOP_VERB[up.status] || 'Upload');
    const right = up.status === 'uploading' && up.partCount > 1 ? `Part ${up.partNo} of ${up.partCount}` : `${pct}%`;
    const line = up.status !== 'uploading' && up.error ? up.error : '';
    html += row(up.shareId, `${verb} ${up.archiveName || ''}`.trim(), right, shareBar(pct, `Upload ${pct} percent`), line);
  }
  const waiting = Number(tb.packWaiting) || 0;
  const ready = Number(tb.readyToCheck) || 0;
  const parts = Number(tb.needsYou) || 0;
  if (waiting) html += `<div class="watch-pop-mut share-pop-line">${waiting.toLocaleString()} waiting to pack</div>`;
  if (ready) html += `<button type="button" class="share-link-btn share-pop-ready" data-share-list>${ready.toLocaleString()} packed and ready for you to check</button>`;
  if (parts) html += `<div class="share-pop-needs">${parts.toLocaleString()} ${parts === 1 ? 'part of an upload failed and needs' : 'parts of an upload failed and need'} you</div>`;
  pop.innerHTML = `${html}
    <div class="watch-pop-r share-pop-acts">
      <button type="button" class="share-link-btn" data-share-list>Open My shares</button>
    </div>`;
  sharePrivacyChanged(pop);
}

/* ── State poll ───────────────────────────────────────────────────────── */

/** Ask for the feature state now (after an action), then keep polling. */
function shareStatePollSoon() {
  clearTimeout(_sharePollTimer);
  _sharePollTimer = setTimeout(shareStatePoll, 300);
}

async function shareStatePoll() {
  clearTimeout(_sharePollTimer);
  const wasOn = shareEnabled();
  try {
    if (typeof document === 'undefined' || !document.hidden) {
      _shareState = await shareApi('GET', '/state', null, { background: true });
      shareSyncPrivacyHide();
      shareRenderPill();

      if (shareEnabled() !== wasOn && typeof renderSelectionBar === 'function') {
        try { renderSelectionBar(); } catch { /* not on the library */ }
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('vault:share-state'));
      }
    }
  } catch { /* locked or not reachable: try again later */ }
  const tb = _shareState && _shareState.topBar;
  const busy = shareEnabled() || (tb && tb.show);
  _sharePollTimer = setTimeout(shareStatePoll, busy ? 5000 : 30000);
}

/* ── Entry points ─────────────────────────────────────────────────────── */

/** Classic details: a button beside Copy Path, for one file. */
function shareDetailButtonHtml(media) {
  if (!shareEnabled() || !media || media.media_type === 'mix') return '';
  return `<button onclick="shareOpenForIds([${Number(media.id)}])" class="detail-copy-btn" title="Pack this file into a locked archive and upload it to gofile.io, after two checks">📤 Share privately</button>`;
}

/** Modern Info panel: a row in the More menu, for one file. */
function shareMenuItemHtml(media) {
  if (!shareEnabled() || !media || media.media_type === 'mix') return '';
  return `<button type="button" role="menuitem" class="mpp-menu-item" data-qa-item="share" onclick="detailPanelMoreClose(); shareOpenForIds([${Number(media.id)}])">${shIcon('upload')}<span>Share privately</span></button>`;
}

/* ── Boot ─────────────────────────────────────────────────────────────── */

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.querySelector && !window.__shareNoBoot) {
  const boot = () => { shareEnsureTopBar(); shareStatePoll(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  // After unlock the poll answers again; ask straight away.
  window.addEventListener('vault:online', () => shareStatePollSoon());
  // A page opened in a background tab skips the first poll; ask when it shows.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !_shareState) shareStatePollSoon(); });
}
