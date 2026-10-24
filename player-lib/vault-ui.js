/* =========================================================================
   VAULT UI — the header padlock IS the lock control.

   Unlocked: shackle drawn open; click → lock. If the DB has no password
   yet, the click first opens a create-password modal (with confirm) and
   encrypts — the session then STAYS UNLOCKED (encryption at rest is already
   in force; autolock handles locking later). If a scan is running, the first
   click arms an orange warning state ("locking interrupts the scan") and only
   a second click within 6s force-locks.

   Locked: an opaque full-screen lock covers the app (client data wiped).
   The password field shows straight away, focused. Only when a stored
   unlockHoldSeconds is above its 0 default is the field hidden until the
   big padlock is pressed and held (pointer, or Space / Enter on the focused
   lock). Unlock reloads the page fresh.

   The password dialogs (set, change) and the first-launch offer are built on
   the .vault-modal shell (css/vault.css), which other prompts share too.

   Autolock (server-side, config.security.autolockMinutes) is detected by a
   status poll + a fetch wrapper that watches for 423 responses. Real user
   input feeds the server's idle clock via a throttled /api/vault/touch.
   ========================================================================= */
(function () {
  let _status = { encrypted: false, locked: false, scanActive: false };
  let _armedInterrupt = false;   // scan-warning two-click state
  let _armTimer = null;

  const LOCK_SVG = `
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path class="lock-shackle" d="M32 48 V38 C32 22 68 22 68 38 V48" fill="none" stroke="#1e1f22" stroke-width="11" stroke-linecap="round"/>
      <path class="lock-shackle" d="M32 48 V38 C32 22 68 22 68 38 V48" fill="none" style="stroke: var(--brand);" stroke-width="8" stroke-linecap="round"/>
      <rect x="22.5" y="44.5" width="55" height="45" rx="9" fill="#1e1f22"/>
      <rect x="24" y="46" width="52" height="42" rx="8" style="fill: var(--brand);"/>
      <path d="M36 58 L48 67 L36 76 Z" fill="#1e1f22"/>
      <path d="M52 58 L64 67 L52 76 Z" fill="#1e1f22"/>
    </svg>`;

  const $logo = () => document.getElementById('vaultLogo');
  const $keyBtn = () => document.getElementById('vaultChangePass');

  /* ── Instance name ──────────────────────────────────────────────────────
     A free-text name for THIS running Vault, so two copies on two ports are
     tellable apart from the browser tab strip alone. It is server-owned
     (vault-settings.json) rather than a browser preference, because the lock
     screen has to show it before anyone has unlocked anything — which is also
     why it rides on /api/vault/status, the one route that answers while
     locked. Blank means "Vault" everywhere, which is today's behaviour. */

  let _instanceName = '';

  const displayName = () => (_instanceName || 'Vault');

  /** The header logo is an SVG followed by a bare text node ("Vault") in
   *  db-viewer.html. Rewriting that node leaves the SVG, the click-to-lock
   *  handler, the open-shackle class and the gamify brand colour alone, which
   *  is the whole reason for not re-rendering the element. */
  function logoTextNode() {
    const el = $logo();
    if (!el) return null;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return n;
    }
    // No text node (a future header rebuild): add one after the SVG.
    const node = document.createTextNode(displayName());
    el.appendChild(node);
    return node;
  }

  /** The lock screen's heading: the name is what tells two locked tabs
   *  apart, so it is the heading itself, not a small line above it. */
  const lockHeading = () => `${displayName()} is locked`;

  /** Title, header word and lock-screen heading, from one string. Safe to
   *  call before the lock overlay exists; showLockOverlay() re-applies it. */
  function applyInstanceName(name) {
    _instanceName = String(name == null ? '' : name).trim().slice(0, 40);
    applyTitle();
    const node = logoTextNode();
    if (node) node.textContent = displayName();
    const heading = document.getElementById('vaultLockTitle');
    if (heading) heading.textContent = lockHeading();
  }

  // Locked adds a "Locked:" prefix, so the lock state reads from the tab
  // strip too — the case this whole feature exists for is a second Vault
  // sitting locked and unfocused in another tab.
  function applyTitle() {
    document.title = (_status.locked ? 'Locked: ' : '') + displayName();
  }

  // Settings applies a rename live, with no reload, through this.
  window.vaultApplyInstanceName = applyInstanceName;

  /* ── Status + logo rendering ─────────────────────────────────────────── */

  async function refreshStatus() {
    try {
      const s = await fetch('/api/vault/status').then(r => r.json());
      const wasLocked = _status.locked;
      _status = s;
      // Older servers (and Part A before it lands) simply omit the field; the
      // name stays blank and everything reads "Vault", as it does today.
      applyInstanceName(s.instanceName || '');
      // The browser may only cache thumbnails while the library is plaintext;
      // see player-lib/thumbs.js.
      if (typeof setThumbsEncrypted === 'function') setThumbsEncrypted(!!s.encrypted && !s.locked);
      renderLogo();
      if (s.locked && !wasLocked) enterLockedUi();   // autolock fired while idle
      else if (s.locked) showLockOverlay();          // booted locked
    } catch { /* server unreachable — leave the UI as-is */ }
  }

  function renderLogo() {
    const el = $logo();
    if (!el) return;
    el.classList.toggle('vault-open', !_status.locked);
    el.classList.toggle('vault-warn', _armedInterrupt);
    el.title = _status.locked ? 'The library is locked'
      : _armedInterrupt ? 'A scan is running. Locking now interrupts it. Click again to lock anyway.'
      : _status.encrypted ? 'Lock the library'
      : 'Set a vault password (encrypts the library file)';
    el.setAttribute('aria-label', el.title);
    // The 🔑 change-password affordance only makes sense on an encrypted,
    // unlocked vault — hidden while plaintext or locked.
    const key = $keyBtn();
    if (key) key.style.display = (_status.encrypted && !_status.locked) ? '' : 'none';
  }

  /* ── Lock flow (logo click while unlocked) ───────────────────────────── */

  function onLogoClick() {
    if (_status.locked) return;                    // overlay owns locked-state input
    if (!_status.encrypted) { openCreatePassModal(); return; }
    doLock(_armedInterrupt);
  }

  async function doLock(force) {
    try {
      const resp = await fetch('/api/vault/lock', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: !!force }),
      });
      const data = await resp.json();
      if (resp.status === 409 && data.code === 'VAULT_SCAN_ACTIVE') {
        // First click while scanning: arm the warning, require a second click
        _armedInterrupt = true;
        renderLogo();
        showToast('A scan is running. Click the lock again to stop it and lock the library.', { type: 'error' });
        clearTimeout(_armTimer);
        _armTimer = setTimeout(() => { _armedInterrupt = false; renderLogo(); }, 6000);
        return;
      }
      if (!resp.ok) { errorToast(data, 'locking the library'); return; }
      _armedInterrupt = false;
      clearTimeout(_armTimer);
      _status = data;
      enterLockedUi();
    } catch (err) {
      errorToast(err, 'locking the library');
    }
  }

  /* Readable words for a failure (player-lib/utils.js friendlyError), with a
     plain fallback if utils.js is ever missing. */
  function errorText(err, what) {
    if (typeof friendlyError === 'function') return friendlyError(err, what);
    return `Something went wrong while ${what}. Try again.`;
  }
  function errorToast(err, what) {
    showToast(errorText(err, what), { type: 'error' });
  }

  /** Hard-stop every playback subsystem the moment the vault locks. Runs on
   *  manual lock, autolock, AND cross-window lock (all funnel through
   *  enterLockedUi). Each call is guarded so a missing/erroring subsystem never
   *  blocks the rest — nothing should keep emitting behind the lock screen. */
  function haltAllPlayback() {
    // Vibe FIRST — it's a physical device; stop it the instant we lock.
    try { window.LovenseSync?.lockStop?.(); } catch {}
    // Active game → pause (also persists its save).
    try { if (typeof gamesPauseIfActive === 'function') gamesPauseIfActive(); } catch {}
    // Wall tab: release every clip and clear the board.
    try { if (typeof wallLockStop === 'function') wallLockStop(); } catch {}
    // Editor mix preview (the stack/grid stage) — lock never closes the editor,
    // so its videos play on unless we tear the mix down explicitly.
    try { if (typeof editorCloseMix === 'function') editorCloseMix({ silent: true }); } catch {}
    // Main player (also stops its own custom mix via stopMixPlayer) + mini player.
    try { if (typeof closeMediaPlayer === 'function') closeMediaPlayer(); } catch {}
    try { if (typeof closeMiniPlayer === 'function') closeMiniPlayer(); } catch {}
    try { if (typeof stopMixPlayer === 'function') stopMixPlayer(); } catch {}
    // Safety net: pause + mute any <video>/<audio> still alive (detached
    // previews, beatbar, anything future). Unlock reloads the page, so muting
    // has no lasting effect — it just guarantees silence while locked.
    try {
      document.querySelectorAll('video, audio').forEach(el => {
        try { el.pause(); el.muted = true; } catch {}
      });
    } catch {}
  }

  /** Wipe client-side state and cover the app with the lock screen. */
  function enterLockedUi() {
    _status.locked = true;
    applyTitle();                 // "Locked:" prefix the moment it locks
    haltAllPlayback();
    // Decrypted thumbnails are held as object URLs in this tab. Locking the
    // vault has to take them with it, not just hide the grid.
    try { if (typeof revokeThumbBlobs === 'function') revokeThumbBlobs(); } catch {}
    try {
      if (typeof Library !== 'undefined') Library.clear();
      if (typeof renderResults === 'function') renderResults();
    } catch {}
    renderLogo();
    showLockOverlay();
  }

  /* ── Shared pieces for the password dialogs and the lock screen ──────── */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Line icons from player-lib/icons.js; both looks show them here (these
  // controls are new, there is no Classic emoji to keep).
  const icon = (name) => (typeof vaultIcon === 'function' ? vaultIcon(name) : '');

  /** The show / hide toggle inside a password field. */
  function eyeButtonHtml(inputId) {
    return `<button type="button" class="vault-eye" data-eye-for="${inputId}" aria-controls="${inputId}"`
      + ` aria-pressed="false" aria-label="Show password" title="Show password">${icon('eye') || 'Show'}</button>`;
  }

  /** One labelled password field: label above, eye toggle inside, an optional
   *  note under it that the field also points screen readers at. */
  function passFieldHtml(id, label, { note = '', autocomplete = 'new-password' } = {}) {
    const noteId = `${id}Note`;
    return `
      <div class="vault-field">
        <label class="vault-label" for="${id}">${esc(label)}</label>
        <div class="vault-pass-wrap">
          <input type="password" id="${id}" class="vault-input" autocomplete="${autocomplete}"
                 spellcheck="false" autocapitalize="off"${note ? ` aria-describedby="${noteId}"` : ''}>
          ${eyeButtonHtml(id)}
        </div>
        ${note ? `<div class="vault-field-note" id="${noteId}">${esc(note)}</div>` : ''}
      </div>`;
  }

  /** Wire every eye toggle under root. Showing swaps the field to text; the
   *  button says what it will do next and shows the matching icon. */
  function wireEyeToggles(root) {
    root.querySelectorAll('.vault-eye').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = root.querySelector('#' + btn.dataset.eyeFor);
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        const words = show ? 'Hide password' : 'Show password';
        btn.setAttribute('aria-pressed', String(show));
        btn.setAttribute('aria-label', words);
        btn.title = words;
        btn.innerHTML = icon(show ? 'eye-off' : 'eye') || (show ? 'Hide' : 'Show');
      });
      // A press on the eye should not pull focus out of the field being typed in.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
    });
  }

  /** The error line under the fields: alert icon and plain words, or hidden. */
  function setErrorLine(el, msg) {
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.innerHTML = `${icon('alert')}<span>${esc(msg)}</span>`;
    el.hidden = false;
  }

  /** Mark one field as the one to fix: red edge, a short shake, focus. */
  function flagField(input, { clear = false } = {}) {
    if (!input) return;
    if (clear) input.value = '';
    input.setAttribute('aria-invalid', 'true');
    input.classList.remove('vault-shake');
    void input.offsetWidth;                         // restart the animation
    input.classList.add('vault-shake');
    input.focus();
    if (!clear && typeof input.select === 'function') input.select();
  }

  /**
   * A .vault-modal dialog with the keyboard handled: Esc cancels, Enter
   * submits (a focused button answers for itself, so Enter on Cancel
   * cancels), Tab stays inside, focus goes back to whatever had it. A click
   * on the backdrop does nothing: these dialogs hold typed passwords, and a
   * stray click should not throw them away.
   */
  function openVaultModal({ id, labelledBy, describedBy, html, onSubmit, onCancel }) {
    document.getElementById(id)?.remove();
    const opener = document.activeElement;
    const ov = document.createElement('div');
    ov.id = id;
    ov.className = 'vault-modal-overlay';
    ov.innerHTML = html;
    const box = ov.querySelector('.vault-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (labelledBy) box.setAttribute('aria-labelledby', labelledBy);
    if (describedBy) box.setAttribute('aria-describedby', describedBy);
    document.body.appendChild(ov);

    const close = () => {
      ov.remove();
      if (opener && opener.isConnected && typeof opener.focus === 'function') {
        try { opener.focus({ preventScroll: true }); } catch { /* gone */ }
      }
    };
    const cancel = () => (onCancel ? onCancel(close) : close());

    ov.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        cancel();
      } else if (e.key === 'Enter') {
        if (e.target && e.target.tagName === 'BUTTON') { e.stopPropagation(); return; }
        e.preventDefault(); e.stopPropagation();
        if (e.repeat || e.isComposing) return;
        if (onSubmit) onSubmit();
      } else if (e.key === 'Tab') {
        const f = [...box.querySelectorAll('input, button')].filter(n => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    // Typing in a field clears its red edge.
    ov.addEventListener('input', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('vault-input')) {
        e.target.removeAttribute('aria-invalid');
        e.target.classList.remove('vault-shake');
      }
    });
    wireEyeToggles(ov);
    return { ov, box, q: (sel) => ov.querySelector(sel), close, cancel };
  }

  /** Busy state for a dialog's main button. */
  function setBusy(btn, busy, idleLabel, busyLabel) {
    btn.disabled = busy;
    btn.textContent = busy ? busyLabel : idleLabel;
  }

  const NO_RECOVERY = 'There is no way to recover a lost password.';

  /* ── Set-password dialog (first lock on a plaintext DB) ──────────────── */

  function openCreatePassModal() {
    if (_status.encrypted || _status.locked) return;
    const OK = 'Set password';
    const d = openVaultModal({
      id: 'vaultPassModal',
      labelledBy: 'vaultPassTitle',
      describedBy: 'vaultPassHint',
      html: `
        <div class="vault-modal vault-pass-dlg">
          <h3 id="vaultPassTitle">Set a vault password</h3>
          <div id="vaultPassHint" class="vault-modal-body">
            <p class="vault-modal-hint">Vault encrypts the library file with this password. Your media files are not changed.</p>
            <p class="vault-modal-hint vault-modal-strong">${NO_RECOVERY}</p>
          </div>
          ${passFieldHtml('vaultPass1', 'Password', { note: 'At least 4 characters.' })}
          ${passFieldHtml('vaultPass2', 'Type it again')}
          <div class="vault-modal-err" id="vaultPassErr" role="alert" hidden></div>
          <div class="vault-modal-actions">
            <button class="vault-btn" id="vaultPassCancel" type="button">Cancel</button>
            <button class="vault-btn vault-btn-primary" id="vaultPassOk" type="button">${OK}</button>
          </div>
        </div>`,
      onSubmit: () => submit(),
    });
    const { q } = d;
    const err = (m) => setErrorLine(q('#vaultPassErr'), m);
    q('#vaultPassCancel').onclick = d.cancel;

    async function submit() {
      const btn = q('#vaultPassOk');
      if (btn.disabled) return;
      const f1 = q('#vaultPass1'), f2 = q('#vaultPass2');
      const p1 = f1.value, p2 = f2.value;
      if (p1.length < 4) { err('The password must be at least 4 characters.'); flagField(f1); return; }
      if (p1 !== p2) { err('The two passwords do not match. Type it again.'); flagField(f2, { clear: true }); return; }
      err('');
      setBusy(btn, true, OK, 'Encrypting the library…');
      try {
        const resp = await fetch('/api/vault/setpass', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pass: p1 }),
        });
        const data = await resp.json().catch(() => ({ status: resp.status }));
        if (!resp.ok) {
          err(errorText(data, 'setting the password'));
          setBusy(btn, false, OK);
          return;
        }
        d.close();
        // Deliberately NO lock here. Setting the password encrypts the file in
        // place; the session that just created it carries on unlocked (the
        // server never locked either — setPassword only rekeys). Sending the
        // user to the lock screen to retype a password they typed twice a
        // second ago was the old behaviour and it read as a bug.
        _status = data;                 // {encrypted:true, locked:false}
        // Thumbnails become uncacheable the moment the library is encrypted.
        if (typeof setThumbsEncrypted === 'function') setThumbsEncrypted(true);
        if (typeof renderResults === 'function') renderResults();
        renderLogo();                   // padlock → open + key button appears, no reload
        showToast('Password set. The library is encrypted and stays open while you use it.', { type: 'success' });
      } catch (e2) {
        err(errorText(e2, 'setting the password'));
        setBusy(btn, false, OK);
      }
    }
    q('#vaultPassOk').onclick = submit;
    q('#vaultPass1').focus();
  }

  /* ── Change-password dialog (key button, encrypted + unlocked) ───────── */

  function openChangePassModal() {
    if (!_status.encrypted || _status.locked) return;
    const OK = 'Change password';
    const d = openVaultModal({
      id: 'vaultPassModal',
      labelledBy: 'vaultPassTitle',
      describedBy: 'vaultPassHint',
      html: `
        <div class="vault-modal vault-pass-dlg">
          <h3 id="vaultPassTitle">Change vault password</h3>
          <div id="vaultPassHint" class="vault-modal-body">
            <p class="vault-modal-hint">Enter your current password, then choose a new one. Vault encrypts the library file again with the new password. Nothing is scanned again.</p>
            <p class="vault-modal-hint vault-modal-strong">${NO_RECOVERY}</p>
          </div>
          ${passFieldHtml('vaultCur', 'Current password', { autocomplete: 'current-password' })}
          ${passFieldHtml('vaultNew1', 'New password', { note: 'At least 4 characters.' })}
          ${passFieldHtml('vaultNew2', 'Type the new password again')}
          <div class="vault-modal-err" id="vaultPassErr" role="alert" hidden></div>
          <div class="vault-modal-actions">
            <button class="vault-btn" id="vaultPassCancel" type="button">Cancel</button>
            <button class="vault-btn vault-btn-primary" id="vaultPassOk" type="button">${OK}</button>
          </div>
        </div>`,
      onSubmit: () => submit(),
    });
    const { q } = d;
    const err = (m) => setErrorLine(q('#vaultPassErr'), m);
    q('#vaultPassCancel').onclick = d.cancel;

    async function submit() {
      const btn = q('#vaultPassOk');
      if (btn.disabled) return;
      const fc = q('#vaultCur'), f1 = q('#vaultNew1'), f2 = q('#vaultNew2');
      const cur = fc.value, n1 = f1.value, n2 = f2.value;
      if (!cur) { err('Enter your current password.'); flagField(fc); return; }
      if (n1.length < 4) { err('The new password must be at least 4 characters.'); flagField(f1); return; }
      if (n1 !== n2) { err('The two new passwords do not match. Type it again.'); flagField(f2, { clear: true }); return; }
      if (n1 === cur) { err('The new password is the same as the current one. Choose a different one.'); flagField(f1); return; }
      err('');
      setBusy(btn, true, OK, 'Changing the password…');
      try {
        const resp = await fetch('/api/vault/changepass', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current: cur, next: n1 }),
        });
        const data = await resp.json().catch(() => ({}));

        // Lockout: the vault sealed itself. Drop the modal and let the lock
        // screen take over — no explanation of the mechanism.
        if (resp.status === 423 || data.locked) {
          d.ov.remove();
          if (!_status.locked) enterLockedUi();
          return;
        }
        if (!resp.ok) {
          setBusy(btn, false, OK);
          if (data.code === 'VAULT_WRONG_CURRENT') {
            // Generic on purpose: no count of tries left.
            err('That is not your current password. Try again.');
            flagField(fc, { clear: true });
          } else {
            err(errorText({ ...data, status: resp.status }, 'changing the password'));
          }
          return;
        }
        d.close();
        showToast('Vault password changed.', { type: 'success' });
        _status = data;               // stays unlocked; renderLogo keeps the key button
        renderLogo();
      } catch (e2) {
        err(errorText(e2, 'changing the password'));
        setBusy(btn, false, OK);
      }
    }
    q('#vaultPassOk').onclick = submit;
    q('#vaultCur').focus();
  }

  // Settings (Privacy and security) opens the same dialogs from its own
  // buttons. Each does nothing when it does not apply (already encrypted /
  // not encrypted yet / locked).
  window.vaultOpenSetPassword = openCreatePassModal;
  window.vaultOpenChangePassword = openChangePassModal;

  /* ── Lock screen (opaque overlay, field shown straight away) ─────────── */

  /**
   * How long the lock must be held before the password box appears.
   * Default 0 = no hold: the field shows at once. The hold gesture itself is
   * still fully wired (0–10s) and honours a stored unlockHoldSeconds, but no
   * Settings row renders for it any more — see player-lib/settings.js.
   */
  function holdSeconds() {
    const raw = typeof window.vaultSetting === 'function' ? window.vaultSetting('unlockHoldSeconds') : 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(10, Math.round(n)));
  }

  /** Which copy of Vault this tab is, in words: "on this computer, port
   *  8800" for a local address, the address itself otherwise. */
  function whereLine() {
    const host = String(location.hostname || '').replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '::1' || /^127\./.test(host);
    const port = location.port || (location.protocol === 'https:' ? '443' : '80');
    return local ? `Vault on this computer, port ${port}` : `Vault at ${location.host}`;
  }

  function showLockOverlay() {
    if (document.getElementById('vaultLockScreen')) return;
    document.getElementById('vaultPassModal')?.remove();
    if (typeof window.vaultDialogCloseAll === 'function') window.vaultDialogCloseAll();
    // The shortcuts list holds the keyboard while open; it must not sit over the lock.
    if (typeof shortcutsIsOpen === 'function' && shortcutsIsOpen()) shortcutsClose({ keepFocus: true });
    const secs = holdSeconds();
    const holdHint = `Press and hold the lock for ${secs} second${secs === 1 ? '' : 's'} to unlock.`;
    const ov = document.createElement('div');
    ov.id = 'vaultLockScreen';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'vaultLockTitle');
    // With no hold the lock picture is decoration (a click on it still just
    // focuses the field), so it stays out of the Tab order. With a hold it is
    // the control: a real button that Space / Enter can hold too.
    const logoAttrs = secs === 0
      ? 'tabindex="-1" aria-hidden="true"'
      : `aria-label="Press and hold to unlock" aria-describedby="vaultLockHint"`;
    ov.innerHTML = `
      <div class="vault-lock-center">
        <button type="button" class="vault-lock-logo" id="vaultHoldTarget" ${logoAttrs}
                style="--vault-hold-ms:${secs * 1000}ms">
          ${LOCK_SVG}
          <svg class="vault-hold-ring" viewBox="0 0 120 120" aria-hidden="true">
            <circle cx="60" cy="60" r="54" fill="none" stroke-width="5"/>
          </svg>
        </button>
        <h1 class="vault-lock-title" id="vaultLockTitle">${esc(lockHeading())}</h1>
        <p class="vault-lock-hint" id="vaultLockHint">${secs === 0 ? 'Enter your password to unlock the library.' : holdHint}</p>
        <form id="vaultUnlockForm" class="vault-unlock-form" novalidate${secs === 0 ? '' : ' hidden'}>
          <label class="vault-sr-only" for="vaultUnlockPass">Password</label>
          <div class="vault-pass-wrap">
            <input type="password" id="vaultUnlockPass" class="vault-input" placeholder="Password"
                   autocomplete="current-password" spellcheck="false" autocapitalize="off"
                   aria-describedby="vaultLockErr">
            ${eyeButtonHtml('vaultUnlockPass')}
          </div>
          <button class="vault-btn vault-btn-primary" type="submit">Unlock</button>
        </form>
        <p class="vault-lock-err" id="vaultLockErr" role="alert"></p>
        <p class="vault-lock-addr">${esc(whereLine())}</p>
      </div>`;
    document.body.appendChild(ov);
    // Keep Tab and screen readers on the lock screen: nothing behind it is
    // reachable while locked. Unlock reloads the page, so nothing undoes this.
    for (const n of Array.from(document.body.children)) {
      if (n !== ov) n.inert = true;
    }
    // The overlay is built after boot, so the name is applied again here.
    applyInstanceName(_instanceName);
    wireEyeToggles(ov);
    bindUnlock(ov, secs);
    if (secs === 0) ov.querySelector('#vaultUnlockPass').focus();
    else ov.querySelector('#vaultHoldTarget').focus();
  }

  function bindUnlock(ov, secs) {
    const target = ov.querySelector('#vaultHoldTarget');
    const form = ov.querySelector('#vaultUnlockForm');
    const hint = ov.querySelector('#vaultLockHint');
    const errLine = ov.querySelector('#vaultLockErr');
    const input = form.querySelector('#vaultUnlockPass');
    const submitBtn = form.querySelector('button[type="submit"]');
    const showErr = (msg) => {
      errLine.innerHTML = msg ? `${icon('alert')}<span>${esc(msg)}</span>` : '';
    };
    let holdTimer = null;
    // The key (Space / Enter) whose press started a keyboard hold, until its
    // keyup. While it is down the field is not focused: its auto-repeats would
    // otherwise land in the field as invisible spaces (or submit it empty).
    let heldKey = null;

    const reveal = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      target.classList.remove('holding');
      if (form.hidden) {
        form.hidden = false;
        hint.textContent = 'Enter your password to unlock the library.';
        // The lock has done its job; take it out of the Tab order.
        target.tabIndex = -1;
      }
      if (!heldKey) input.focus();                    // else on that key's keyup
    };
    const startHold = () => {
      if (!form.hidden) { if (!heldKey) input.focus(); return; }   // prompt already revealed
      // 0 = the deliberate-gesture guard is off; a click is enough.
      if (secs === 0) { reveal(); return; }
      if (holdTimer) return;
      target.classList.add('holding');                // CSS ring fills over `secs`
      holdTimer = setTimeout(reveal, secs * 1000);
    };
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      target.classList.remove('holding');
    };
    target.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      startHold();
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
      target.addEventListener(ev, cancelHold);
    }
    // Keyboard: holding Space or Enter on the focused lock is the same gesture.
    target.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (e.repeat) return;
      heldKey = e.key;
      startHold();
    });
    target.addEventListener('keyup', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      cancelHold();
      if (e.key !== heldKey) return;
      heldKey = null;
      if (!form.hidden) input.focus();
    });
    target.addEventListener('blur', () => { heldKey = null; cancelHold(); });

    input.addEventListener('input', () => {
      input.classList.remove('vault-shake');
      input.removeAttribute('aria-invalid');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitBtn.disabled) return;
      if (!input.value) {
        showErr('Enter your password.');
        flagField(input);
        return;
      }
      submitBtn.disabled = true;
      showErr('');
      try {
        const resp = await fetch('/api/vault/unlock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pass: input.value }),
        });
        if (resp.ok) {
          hint.textContent = 'Unlocked. Loading your library…';
          location.reload();                          // fresh boot with data
          return;
        }
        const data = await resp.json().catch(() => ({}));
        // The server's own words for a wrong password are short and
        // lowercase (and pinned by a test), so the code picks the copy here.
        showErr(data.code === 'VAULT_WRONG_PASS'
          ? 'That password is not right. Try again.'
          : errorText({ ...data, status: resp.status }, 'unlocking the library'));
        flagField(input, { clear: true });
      } catch (e2) {
        showErr(errorText(e2, 'unlocking the library'));
        input.focus();
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  /* ── Autolock detection + idle feeding ───────────────────────────────── */

  // Any data endpoint answering 423 means the server locked (autolock or a
  // second window) — swap to the lock screen immediately.
  const _origFetch = window.fetch;
  //
  // The same wrapper tells the rest of the page when Vault itself stops
  // answering: 'vault:offline' on the first failed request to this server,
  // 'vault:online' on the next one that gets any answer (the 45 s status
  // poll keeps asking). Requests to other sites and aborted requests do not
  // count.
  let _offline = false;
  const sameOrigin = (input) => {
    try {
      const u = typeof input === 'string' || input instanceof URL ? input : input && input.url;
      return new URL(String(u), location.href).origin === location.origin;
    } catch { return false; }
  };
  window.fetch = async function (...args) {
    let resp;
    try {
      resp = await _origFetch.apply(this, args);
    } catch (err) {
      if (!_offline && err && err.name === 'TypeError' && sameOrigin(args[0])) {
        _offline = true;
        window.dispatchEvent(new CustomEvent('vault:offline'));
      }
      throw err;
    }
    if (_offline && sameOrigin(args[0])) {
      _offline = false;
      window.dispatchEvent(new CustomEvent('vault:online'));
    }
    if (resp.status === 423 && !_status.locked) enterLockedUi();
    return resp;
  };

  // Real user input resets the server's idle clock (throttled to 1/min).
  // The status poll deliberately does NOT count (server-side exclusion is
  // implicit: only this touch call and real data traffic reset it).
  let _lastTouch = 0;
  function touchActivity() {
    if (_status.locked || !_status.encrypted) return;
    const now = Date.now();
    if (now - _lastTouch < 60 * 1000) return;
    _lastTouch = now;
    _origFetch('/api/vault/touch', { method: 'POST' }).catch(() => {});
  }

  /* ── Boot ─────────────────────────────────────────────────────────────── */

  /** The header logo is a plain div in db-viewer.html; make it a keyboard
   *  control too (Tab to it, Enter or Space locks / sets a password). */
  function makeLogoKeyboardable() {
    const el = $logo();
    if (!el) return;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (!e.repeat) onLogoClick();
    });
  }

  /** Inject the small 🔑 change-password button beside the header logo. */
  function installKeyButton() {
    const logo = $logo();
    if (!logo || $keyBtn()) return;
    const btn = document.createElement('button');
    btn.id = 'vaultChangePass';
    btn.type = 'button';
    btn.className = 'vault-key-btn';
    // The 🔑 for Classic, a line key for Modern (player-lib/icons.js).
    btn.innerHTML = typeof vaultIconSwap === 'function' ? vaultIconSwap('🔑', 'key') : '🔑';
    btn.title = 'Change vault password';
    btn.setAttribute('aria-label', 'Change vault password');
    btn.style.display = 'none';                     // renderLogo() reveals it when apt
    btn.addEventListener('click', openChangePassModal);
    logo.insertAdjacentElement('afterend', btn);
  }

  /* ── First-launch: offer to set a password ────────────────────────────────
     Without one the database is a plain SQLite file — AI descriptions, notes,
     view counts, finishes and the Obsession history are all readable by anyone
     who opens the folder. That's the honest reason to ask, and asking once at
     the start is far more effective than making individual features opt-in to
     work around it.

     Asked ONCE: the answer lives server-side (vault-settings.json via
     /api/settings/app), so a different browser profile doesn't re-nag someone
     who already said no. Declining is a real choice, not a deferral. */

  async function maybeOfferPassword() {
    let s;
    try {
      const resp = await fetch('/api/settings/app');
      if (!resp.ok) return;                       // locked or older server
      s = await resp.json();
    } catch { return; }
    if (s.encrypted || s.passwordPromptSeen) return;

    const remember = () => fetch('/api/settings/app', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passwordPromptSeen: true }),
    }).catch(() => {});

    // Esc is the same answer as Not now: declining is a real choice.
    const d = openVaultModal({
      id: 'vaultFirstRunModal',
      labelledBy: 'vaultFirstRunTitle',
      describedBy: 'vaultFirstRunBody',
      html: `
        <div class="vault-modal">
          <h3 id="vaultFirstRunTitle">Protect your library?</h3>
          <div id="vaultFirstRunBody" class="vault-modal-body">
            <p class="vault-modal-hint">
              Vault keeps your tags, notes, ratings, watch history and AI descriptions in one
              library file on this computer. Without a password, anyone who can open that file
              can read it.
            </p>
            <p class="vault-modal-hint">
              A password encrypts the library file. Your media files are not changed. If you would
              rather it never locks while you use it, set
              <b>Settings &gt; Privacy and security &gt; Auto-lock after</b> to 0. The library stays
              encrypted either way.
            </p>
            <p class="vault-modal-hint vault-modal-strong">
              There is no way to recover a lost password. Pick one you will remember, or keep it in
              a password manager.
            </p>
          </div>
          <div class="vault-modal-actions">
            <button class="vault-btn" id="vaultFirstRunSkip" type="button">Not now</button>
            <button class="vault-btn vault-btn-primary" id="vaultFirstRunSet" type="button">Set a password</button>
          </div>
        </div>`,
      onCancel: (close) => { remember(); close(); },
    });

    d.q('#vaultFirstRunSkip').addEventListener('click', d.cancel);
    d.q('#vaultFirstRunSet').addEventListener('click', () => {
      remember();
      d.close();
      openCreatePassModal();
    });
    d.q('#vaultFirstRunSet').focus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    $logo()?.addEventListener('click', onLogoClick);
    makeLogoKeyboardable();
    installKeyButton();
    document.addEventListener('pointerdown', touchActivity, true);
    document.addEventListener('keydown', touchActivity, true);
    // Watching counts as being there: a video or audio file playing in the
    // main player or the mini player keeps the vault open, hands off the
    // keyboard or not. Paused, ended, or still loading does not count, so a
    // player left on a paused frame still locks on schedule. Native playback
    // of a fully buffered file makes no requests at all, which is why this
    // cannot rely on data traffic the way scans and remux segments do.
    setInterval(() => {
      const playing = [...document.querySelectorAll(
        '#mediaPlayerContent video, #mediaPlayerContent audio, #miniPlayerMedia video, #miniPlayerMedia audio'
      )].some(el => !el.paused && !el.ended && el.readyState >= 2);
      if (playing) touchActivity();
    }, 30 * 1000);
    refreshStatus();
    setInterval(refreshStatus, 45 * 1000);
    // After the setup-tools banner has had its moment — one prompt at a time.
    setTimeout(maybeOfferPassword, 1200);
  });
})();
