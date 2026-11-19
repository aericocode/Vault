/* =========================================================================
   SETTINGS > PRIVATE SHARING, and the windows it opens: My shares, Change
   saved password (with the one-time warning), Copy format, Delete all.

   One page, both looks (player-lib/settings.js draws it: RENDERERS.sharing,
   wired by shareSettingsWire). The values live on the SERVER
   (GET /api/share/state, POST /api/share/settings), not in localStorage:
   the server acts on them (the on/off switch above all). The page renders
   from the last state it heard, then again once the server answers.

   Short page: the switch and three everyday choices, then a folded "More
   options" (<details class="settings-acc">), My shares and the reset.

   SECRETS. The saved password is shown only after Show (and the Vault
   password when one is set), only in its own field, and the field is emptied
   when Settings closes (shareSettingsClosed). Nothing is kept in a variable.

   Needs share-client.js and share-ui.js. Load before settings.js.
   ========================================================================= */

const SHARE_SETTINGS_DEFAULTS = {
  enabled: false, passwordChoice: 'random', deleteAfterDays: 7, split: '2g', customPartBytes: 2 * 1024 ** 3,
  nameMode: 'typed', keepLocal: false, onPartFail: 'retry3', accountMode: 'perStart', copyFormat: 'default',
  customFormat: '{link}\npass: {pass}', rememberPasswords: true, rememberFiles: true, hideInPrivacy: true, topBarIcon: true,
};

const shSet = () => ({ ...SHARE_SETTINGS_DEFAULTS, ...((_shareState && _shareState.settings) || {}) });

function _shSel(key, options, value, label) {
  return `<select class="settings-sel" data-share-sel="${key}" aria-label="${shEsc(label)}">${options.map(o =>
    `<option value="${shEsc(o.value)}"${String(o.value) === String(value) ? ' selected' : ''}>${shEsc(o.label)}</option>`).join('')}</select>`;
}

function _shSwitch(key, on, label) {
  return `<input type="checkbox" data-share-setting="${key}"${on ? ' checked' : ''} aria-label="${shEsc(label)}">
        <span class="settings-switch" aria-hidden="true"></span>`;
}

/** The custom part size as { n, unit } for the field: whole GB when it is, else MB. */
function shareCustomSizeParts(bytes) {
  const MB = 1024 * 1024, GB = 1024 * MB;
  const b = Number(bytes) || 2 * GB;
  return b % GB === 0 ? { n: b / GB, unit: 'GB' } : { n: Math.round(b / MB), unit: 'MB' };
}

/** A typed size in bytes, or null when it is outside 50 MB to 16 GB. */
function shareParseCustomSize(n, unit) {
  const v = Number(String(n).trim());
  if (!Number.isFinite(v) || v <= 0) return null;
  const MB = 1024 * 1024;
  const bytes = Math.round(v * (unit === 'GB' ? 1024 * MB : MB));
  return bytes >= 50 * MB && bytes <= 16 * 1024 * MB ? bytes : null;
}

/** The Private sharing page. */
function shareSettingsHtml() {
  const s = shSet();
  const st = _shareState || {};
  const modern = typeof settingsIsModern === 'function' && settingsIsModern();
  const saved = !!(st.savedPassword && st.savedPassword.set);
  const count = Number(st.shareCount) || 0;
  const cs = shareCustomSizeParts(s.customPartBytes);
  const row = settingsRowHtml;

  const top = row({ sfind: 'shareMyShares', title: 'My shares', desc: 'Everything Vault has uploaded for you, from its own records.',
    control: `<button type="button" class="settings-btn settings-btn-quiet" data-share-act="myshares">My shares (<span data-share-count>${count}</span>)</button>` })
    + row({ tag: 'label', sfind: 'shareEnabled', title: 'Turn on Share privately',
      desc: 'Packs files into a locked archive and uploads it to gofile.io, only when you ask and confirm.',
      control: _shSwitch('enabled', s.enabled, 'Turn on Share privately') })
    + row({ sfind: 'sharePasswordChoice', title: 'Password for a new share', control: _shSel('passwordChoice', SHARE_PASSWORD_CHOICE_OPTIONS, s.passwordChoice, 'Password for a new share') })
    + row({ sfind: 'shareDeleteAfter', title: 'Delete from gofile after', control: _shSel('deleteAfterDays', SHARE_DELETE_AFTER_OPTIONS, s.deleteAfterDays, 'Delete from gofile after') })
    + row({ sfind: 'shareSplit', title: 'Split big archives into parts of', control: _shSel('split', SHARE_SPLIT_OPTIONS, s.split, 'Split big archives into parts of') })
    + (st.offline ? '<p class="settings-note">Vault is set to stay offline (VAULT_OFFLINE=1), so it cannot reach gofile.io. Uploads, deletes and delete timers are all blocked.</p>' : '')
    + (st.sevenZipFound === false ? '<p class="settings-note">Vault could not find its 7-Zip program, so it cannot pack files.</p>' : '');

  const groups = [
    ['Password', row({ sfind: 'shareSavedPassword', title: 'My saved password',
      desc: saved ? 'Hidden. Show asks for your Vault password when one is set.' : 'None saved yet.',
      control: `<span class="share-set-pw">
          <input type="password" class="settings-text share-mono" id="shSavedPw" readonly autocomplete="off" aria-label="My saved password" data-share-private data-share-mask
                 placeholder="${saved ? '••••••••••••••••' : 'None saved'}">
          <button type="button" class="settings-btn settings-btn-quiet" data-share-act="pw-show" aria-pressed="false"${saved ? '' : ' disabled'}>Show</button>
          <button type="button" class="settings-btn settings-btn-quiet" data-share-act="pw-change">Change</button>
        </span>` })],
    ['Archive', row({ sfind: 'shareNameMode', title: 'Archive name', control: _shSel('nameMode', SHARE_NAME_MODE_OPTIONS, s.nameMode, 'Archive name') })
      + `<div data-share-custom-row${s.split === 'custom' ? '' : ' hidden'}>${row({ sfind: 'shareCustomPart', title: 'Custom part size',
        desc: '50 MB to 16 GB.', extra: '<span class="settings-toggle-desc share-set-err" data-share-custom-err hidden></span>',
        control: `<span class="share-set-size">
            <input class="settings-num" type="number" min="1" step="1" data-share-custom-n value="${cs.n}" aria-label="Custom part size">
            <select class="settings-sel" data-share-custom-unit aria-label="Unit"><option${cs.unit === 'MB' ? ' selected' : ''}>MB</option><option${cs.unit === 'GB' ? ' selected' : ''}>GB</option></select>
          </span>` })}</div>`
      + row({ tag: 'label', sfind: 'shareKeepLocal', title: 'Keep the packed archive on this computer after upload', control: _shSwitch('keepLocal', s.keepLocal, 'Keep the packed archive on this computer after upload') })],
    ['Upload', row({ sfind: 'shareOnPartFail', title: 'If a part fails', control: _shSel('onPartFail', SHARE_PART_FAIL_OPTIONS, s.onPartFail, 'If a part fails') })
      + row({ sfind: 'shareAccount', title: 'gofile guest account', control: _shSel('accountMode', SHARE_ACCOUNT_OPTIONS, s.accountMode, 'gofile guest account') })],
    ['Copy format', row({ sfind: 'shareCopyFormat', title: 'Copy as block gives',
      control: `<span class="share-set-pw">${_shSel('copyFormat', SHARE_COPY_FORMAT_OPTIONS, s.copyFormat, 'Copy as block gives')}
          <button type="button" class="settings-btn settings-btn-quiet" data-share-act="format-edit">Edit</button></span>` })],
    ['What Vault remembers', row({ tag: 'label', sfind: 'shareRememberPasswords', title: 'Passwords of past shares', control: _shSwitch('rememberPasswords', s.rememberPasswords, 'Passwords of past shares') })
      + row({ tag: 'label', sfind: 'shareRememberFiles', title: 'Which files were in each share', desc: 'Folded away in My shares.', control: _shSwitch('rememberFiles', s.rememberFiles, 'Which files were in each share') })
      + row({ tag: 'label', sfind: 'shareHideInPrivacy', title: 'Hide My shares in privacy mode', control: _shSwitch('hideInPrivacy', s.hideInPrivacy, 'Hide My shares in privacy mode') })
      + row({ tag: 'label', sfind: 'shareTopBarIcon', title: 'Show a top bar icon while an upload is running', control: _shSwitch('topBarIcon', s.topBarIcon, 'Show a top bar icon while an upload is running') })],
  ];
  const more = (body) => `
      <details class="settings-acc share-more" data-sfind="shareMore"${_shareMoreOpen ? ' open' : ''}>
        <summary><span class="share-more-title">More options</span><span class="share-more-desc">Password, archive, upload, copy format, what Vault remembers</span></summary>
        <div class="settings-acc-body">${body}</div>
      </details>`;
  const foot = `
      <p class="settings-note">All of these start with safe choices. You can share without opening More options.</p>
      <div class="share-set-foot" data-sfind="shareReset"><button type="button" class="settings-btn settings-btn-quiet" data-share-act="reset">Put everything back to the defaults</button></div>`;

  if (modern) {
    return `<div data-share-page>`
      + settingsCardHtml({ title: 'Private sharing', sfind: 'sharing', body: top })
      + more(groups.map(([t, b]) => settingsCardHtml({ title: t, body: b })).join(''))
      + foot + '</div>';
  }
  const h = typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel('📤 Private sharing', { icon: false }) : '📤 Private sharing';
  return `<div data-share-page>
      <h3 class="settings-h" data-sfind="sharing">${h}</h3>
      ${top}
      ${more(groups.map(([t, b]) => `<h4 class="share-set-h">${t}</h4>${b}`).join(''))}
      ${foot}</div>`;
}

let _shareMoreOpen = false;

/** Settings closed (or the page left): the shown saved password goes. */
function shareSettingsClosed() {
  const pw = typeof document !== 'undefined' && document.getElementById('shSavedPw');
  if (pw) { pw.value = ''; shareSetFieldShown(pw, false); }
  const b = typeof document !== 'undefined' && document.querySelector('[data-share-act="pw-show"]');
  if (b) { b.textContent = 'Show'; b.setAttribute('aria-pressed', 'false'); }
}

function _shPageRoot(root) {
  return root && root.querySelector ? root.querySelector('[data-share-page]') : null;
}

/** Draw the page again from the latest state (keeps More options open or shut). */
function shareSettingsRepaint(root) {
  const page = _shPageRoot(root);
  if (!page) return;
  const det = page.querySelector('details.share-more');
  if (det) _shareMoreOpen = det.open;
  page.outerHTML = shareSettingsHtml();
  sharePrivacyChanged(root);
}

async function shareSaveSettings(patch, root, { quiet = false } = {}) {
  try {
    const r = await shareApi('POST', '/settings', patch);
    if (_shareState) _shareState.settings = { ...(_shareState.settings || {}), ...r.settings };
    else _shareState = { settings: r.settings };
    if ('hideInPrivacy' in patch) shareSyncPrivacyHide();
    if (!quiet && typeof showToast === 'function') {
      let msg = 'Saved';
      if (r.passwordsCleared) msg = 'Saved. The stored passwords of past shares were deleted.';
      if (r.fileListsCleared) msg = 'Saved. The stored file lists were deleted.';
      showToast(msg);
    }
    shareStatePollSoon();
    return true;
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message, { type: 'error' });
    shareSettingsRepaint(root);
    return false;
  }
}

/** Wire the page (settings.js calls this each time the page is shown). */
function shareSettingsWire(root) {
  if (!root) return;
  sharePrivacyChanged(root);
  if (!root._shareWired) {
    root._shareWired = true;
    root.addEventListener('toggle', (e) => {
      if (e.target && e.target.classList && e.target.classList.contains('share-more')) _shareMoreOpen = e.target.open;
    }, true);
    root.addEventListener('change', (e) => shareSettingsChange(e, root));
    root.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-share-act]');
      if (!b || !_shPageRoot(root) || b.disabled) return;
      shareSettingsClick(b, root);
    });
    window.addEventListener('vault:share-state', () => {
      root.querySelectorAll('[data-share-count]').forEach((el) => { el.textContent = String((_shareState && _shareState.shareCount) || 0); });
    });
  }
  shareApi('GET', '/state', null, { background: true }).then((st) => {
    _shareState = st;
    shareSyncPrivacyHide();
    // Not while the user is in one of its fields: that would pull focus away.
    const a = document.activeElement;
    if (!(a && a.closest && a.closest('[data-share-page]'))) shareSettingsRepaint(root);
  }).catch(() => {});
}

async function shareSettingsChange(e, root) {
  const t = e.target;
  if (!_shPageRoot(root) || !t || !t.closest) return;
  const sel = t.closest('[data-share-sel]');
  if (sel) {
    const key = sel.dataset.shareSel;
    const value = key === 'deleteAfterDays' ? Number(sel.value) : sel.value;
    if (key === 'split') {
      const r = root.querySelector('[data-share-custom-row]');
      if (r) r.hidden = value !== 'custom';
    }
    if (key === 'passwordChoice' && value === 'saved' && !(_shareState && _shareState.savedPassword && _shareState.savedPassword.set)) {
      const ok = await shareOpenChangePassword({ forChoice: true });
      if (!ok) { sel.value = 'random'; return; }
    }
    await shareSaveSettings({ [key]: value }, root);
    if (key === 'copyFormat' && value === 'custom') shareOpenCopyFormat(root);
    return;
  }
  const sw = t.closest('[data-share-setting]');
  if (sw) {
    const key = sw.dataset.shareSetting;
    const on = sw.checked;
    let confirm;
    if (!on && (key === 'rememberPasswords' || key === 'rememberFiles')) {
      const pw = key === 'rememberPasswords';
      const ok = typeof vaultConfirm === 'function' ? await vaultConfirm(
        pw ? 'Vault deletes the stored passwords of past shares. Copy block then gives the link only for those shares.'
          : 'Vault deletes the stored lists of which files were in each share.',
        { title: pw ? 'Stop remembering passwords?' : 'Stop remembering file lists?', okLabel: 'Delete them', cancelLabel: 'Keep them', danger: true }) : true;
      if (!ok) { sw.checked = true; return; }
      confirm = true;
    }
    const patch = { [key]: on };
    if (confirm) patch.confirm = true;
    await shareSaveSettings(patch, root);
    if (key === 'enabled') shareStatePollSoon();
    return;
  }
  if (t.closest('[data-share-custom-n]') || t.closest('[data-share-custom-unit]')) {
    const n = root.querySelector('[data-share-custom-n]');
    const unit = root.querySelector('[data-share-custom-unit]');
    const err = root.querySelector('[data-share-custom-err]');
    const bytes = shareParseCustomSize(n.value, unit.value);
    if (bytes == null) {
      if (err) { err.textContent = 'The part size must be between 50 MB and 16 GB.'; err.hidden = false; }
      n.setAttribute('aria-invalid', 'true');
      const last = shareCustomSizeParts(shSet().customPartBytes);
      n.value = String(last.n);
      unit.value = last.unit;
      return;
    }
    if (err) { err.hidden = true; err.textContent = ''; }
    n.removeAttribute('aria-invalid');
    await shareSaveSettings({ customPartBytes: bytes }, root);
  }
}

async function shareSettingsClick(b, root) {
  const act = b.dataset.shareAct;
  if (act === 'myshares') return shareOpenMyShares();
  if (act === 'format-edit') return shareOpenCopyFormat(root);
  if (act === 'pw-change') {
    const ok = await shareOpenChangePassword();
    if (ok) shareSettingsRepaint(root);
    return;
  }
  if (act === 'pw-show') {
    const input = root.querySelector('#shSavedPw');
    if (!input) return;
    if (input.value) {
      const show = !shareFieldShown(input);
      shareSetFieldShown(input, show);
      b.textContent = show ? 'Hide' : 'Show';
      b.setAttribute('aria-pressed', String(show));
      return;
    }
    try {
      const sp = _shareState && _shareState.savedPassword;
      const r = await shareWithGate((vaultPassword) => shareApi('POST', '/saved-password/reveal', vaultPassword ? { vaultPassword } : {}),
        { needed: !!(sp && sp.vaultPasswordSet), why: 'Vault asks for your Vault password before it shows the saved password.' });
      if (!r) return;
      input.value = r.password;
      shareSetFieldShown(input, true);
      b.textContent = 'Hide';
      b.setAttribute('aria-pressed', 'true');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message, { type: 'error' });
    }
    return;
  }
  if (act === 'reset') {
    const ok = typeof vaultConfirm === 'function' ? await vaultConfirm(
      'Every choice on this page goes back to its default. Share privately stays on or off as it is. Your shares and the saved password are kept.',
      { title: 'Put everything back to the defaults?', okLabel: 'Put back', cancelLabel: 'Cancel' }) : true;
    if (!ok) return;
    try {
      const r = await shareApi('POST', '/settings/reset', { confirm: true });
      if (_shareState) _shareState.settings = r.settings;
      shareSyncPrivacyHide();
      shareSettingsRepaint(root);
      if (typeof showToast === 'function') showToast('Back to the defaults');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message, { type: 'error' });
    }
  }
}

/* ── Change saved password ─────────────────────────────────────────────── */

/** The one-time warning before a saved password is stored with no Vault password. */
function shareNoVaultPasswordWarning() {
  if (typeof vaultConfirm !== 'function') return Promise.resolve(false);
  return vaultConfirm(
    'There is no Vault password, so the saved password would be stored unencrypted in the library file. Anyone who can open that file can read it.\n\nSet a Vault password first if that matters to you. Vault shows this warning only once.',
    { title: 'Save it without a Vault password?', okLabel: 'Save it anyway', cancelLabel: 'Cancel' });
}

/**
 * Change saved password. Resolves true when a password was saved. The Vault
 * password field shows only when one is set. Random saves a new 24 character
 * password straight away and shows it in the field (as dots until Show).
 */
function shareOpenChangePassword({ forChoice = false } = {}) {
  return new Promise((resolve) => {
    const sp = (_shareState && _shareState.savedPassword) || {};
    const gate = !!sp.vaultPasswordSet;
    let savedAny = false;
    let randomValue = null;
    let busy = false;
    const m = shareModal({
      id: 'shareChangePwDlg', labelledBy: 'shareChangePwTitle', cls: 'share-dlg-mid',
      onEsc: () => finish(),
      html: `
        <h3 id="shareChangePwTitle">Change saved password</h3>
        <p class="vault-modal-hint">This replaces the password Vault offers for new shares. Shares you already made keep the password they were packed with.</p>
        ${gate ? sharePassFieldHtml('shCpVault', 'Your Vault password', { autocomplete: 'current-password', placeholder: 'Needed to replace the saved one', note: 'Asked only when a Vault password is set.' }) : ''}
        <div class="vault-field">
          <label class="vault-label" for="shCpNew">New share password</label>
          <div class="share-pw-row">
            <input type="password" id="shCpNew" class="vault-input share-mono" autocomplete="new-password" spellcheck="false" autocapitalize="off" maxlength="128" aria-describedby="shCpNewNote">
            <button type="button" class="vault-btn" data-sh-show="shCpNew" aria-pressed="false">Show</button>
            <button type="button" class="vault-btn" data-cp-act="random">Random</button>
            <button type="button" class="vault-btn" data-cp-act="copy">Copy</button>
          </div>
          <div class="vault-field-note" id="shCpNewNote">Type your own or press Random for a 24 character one. It is shown here until you close this window, then hidden.</div>
        </div>
        <div class="share-ok-line" data-cp-ok hidden></div>
        <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
        <div class="vault-modal-actions">
          <button type="button" class="vault-btn" data-cp-act="cancel">${forChoice ? 'Cancel' : 'Close'}</button>
          <button type="button" class="vault-btn vault-btn-primary" data-cp-act="save">Save password</button>
        </div>`,
    });
    shareWireShowButtons(m.box);
    const err = (msg) => shareSetError(m.q('[data-sh-err]'), msg);
    const newField = m.q('#shCpNew');
    function finish() {
      if (m.closed) return;
      randomValue = null;
      m.close();
      resolve(savedAny);
    }
    async function send(body) {
      const vaultField = m.q('#shCpVault');
      if (gate && !vaultField.value) { err('Enter your Vault password to replace the saved one.'); vaultField.focus(); return null; }
      const withGate = () => (gate ? { ...body, vaultPassword: vaultField.value } : body);
      try {
        return await shareApi('POST', '/saved-password/change', withGate());
      } catch (e) {
        if (e.code === 'WARNING_NEEDED') {
          const yes = await shareNoVaultPasswordWarning();
          if (!yes) return null;
          return shareApi('POST', '/saved-password/change', { ...withGate(), acknowledgeNoVaultPassword: true });
        }
        throw e;
      }
    }
    async function onSave(random) {
      if (busy) return;
      err('');
      busy = true;
      try {
        if (!random && randomValue !== null && newField.value === randomValue) { finish(); return; }
        if (!random && !newField.value) { err('Type a password, or press Random.'); newField.focus(); return; }
        const r = await send(random ? { random: true } : { password: newField.value });
        if (!r || m.closed) return;
        savedAny = true;
        if (_shareState && _shareState.savedPassword) { _shareState.savedPassword.set = true; _shareState.savedPassword.warningNeeded = false; }
        err('');
        if (random) {
          newField.value = r.password;
          randomValue = r.password;
          const ok = m.q('[data-cp-ok]');
          ok.textContent = 'A new random password was saved. Press Show or Copy if you need it now.';
          ok.hidden = false;
        } else {
          finish();
          if (typeof showToast === 'function') showToast('Saved password changed');
        }
      } catch (e) {
        err(e.message);
      } finally {
        busy = false;
      }
    }
    m.box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cp-act]');
      if (!b) return;
      const act = b.dataset.cpAct;
      if (act === 'cancel') finish();
      else if (act === 'save') onSave(false);
      else if (act === 'random') onSave(true);
      else if (act === 'copy') { if (newField.value) shareCopyText(newField.value, 'Password copied'); }
    });
    shareFocus(gate ? m.q('#shCpVault') : newField);
  });
}

/* ── Copy format ──────────────────────────────────────────────────────── */

function shareOpenCopyFormat(root) {
  const s = shSet();
  let choice = s.copyFormat;
  const m = shareModal({
    id: 'shareFormatDlg', labelledBy: 'shareFormatTitle', cls: 'share-dlg-mid',
    html: `
      <h3 id="shareFormatTitle">Copy format</h3>
      <div class="vault-field">
        <label class="vault-label" for="shFmtChoice">Copy as block gives</label>
        ${shareSelect('shFmtChoice', [
          { value: 'custom', label: 'My own format' },
          { value: 'default', label: 'Link, then pass: line (default)' },
          { value: 'oneLine', label: 'One line: code and pass' },
        ], choice)}
      </div>
      <div data-fmt-own>
        <div class="vault-field">
          <label class="vault-label" for="shFmtText">My format</label>
          <textarea id="shFmtText" class="vault-input share-mono share-fmt-text" rows="2" maxlength="${SHARE_FORMAT_MAX}" spellcheck="false" aria-describedby="shFmtHint">${shEsc(s.customFormat)}</textarea>
          <div class="vault-field-note" id="shFmtHint">This box shows only for My own format. Press a piece to drop it in.</div>
        </div>
        <div class="share-chips" role="group" aria-label="Pieces">
          ${['{link}', '{code}', '{pass}', '{name}'].map(p => `<button type="button" class="share-chip share-mono" data-fmt-piece="${p}">${p}</button>`).join('')}
        </div>
      </div>
      <div class="vault-field">
        <div class="vault-label" id="shFmtPrevLabel">What gets copied</div>
        <pre class="share-pre share-mono" aria-labelledby="shFmtPrevLabel" aria-live="polite" data-fmt-preview></pre>
      </div>
      <p class="vault-modal-hint">{link} is the full web address. {code} is the short code at its end. {pass} is the archive password. {name} is the archive name.</p>
      <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
      <div class="vault-modal-actions share-actions">
        <button type="button" class="vault-btn" data-fmt-act="default">Back to the default</button>
        <span class="share-sp"></span>
        <button type="button" class="vault-btn" data-fmt-act="cancel">Cancel</button>
        <button type="button" class="vault-btn vault-btn-primary" data-fmt-act="save">Save</button>
      </div>`,
  });
  const sel = m.q('#shFmtChoice');
  const text = m.q('#shFmtText');
  const paint = () => {
    choice = sel.value;
    m.q('[data-fmt-own]').hidden = choice !== 'custom';
    const fmt = choice === 'custom' ? text.value : SHARE_READY_FORMATS[choice];
    m.q('[data-fmt-preview]').textContent = shareFormatPreview(fmt);
  };
  sel.addEventListener('change', paint);
  text.addEventListener('input', paint);
  m.box.addEventListener('click', async (e) => {
    const piece = e.target.closest('[data-fmt-piece]');
    if (piece) {
      const p = piece.dataset.fmtPiece;
      const a = text.selectionStart ?? text.value.length, b = text.selectionEnd ?? text.value.length;
      text.value = text.value.slice(0, a) + p + text.value.slice(b);
      text.focus();
      text.selectionStart = text.selectionEnd = a + p.length;
      paint();
      return;
    }
    const btn = e.target.closest('[data-fmt-act]');
    if (!btn) return;
    if (btn.dataset.fmtAct === 'cancel') { m.close(); return; }
    if (btn.dataset.fmtAct === 'default') { sel.value = 'default'; paint(); return; }
    const patch = { copyFormat: choice };
    if (choice === 'custom') {
      if (!text.value.trim()) { shareSetError(m.q('[data-sh-err]'), 'Type a format, or pick a ready one.'); return; }
      patch.customFormat = text.value;
    }
    const ok = await shareSaveSettings(patch, root || document.getElementById('settingsBody'), { quiet: true });
    if (!ok) return;
    m.close();
    if (typeof showToast === 'function') showToast('Copy format saved');
    if (root) shareSettingsRepaint(root);
  });
  paint();
  shareFocus(sel);
}

/* ── My shares ────────────────────────────────────────────────────────── */

let _shareList = null;   // { m, shares, open: Set, files: Map, busy }

/** The actions one row offers, for its status (feature on or off). */
function shareRowActions(share, enabled) {
  const a = [];
  const st = share.status;
  if (st === 'uploaded') {
    a.push('copy', 'open', 'gone');
    if (share.deleteAfterDays && !share.timerSet) a.push('timer');
    a.push('delete');
  } else if (st === 'paused' || st === 'not_finished') {
    a.push('view', 'resume', 'stop');
  } else if (st === 'uploading' || st === 'packing' || st === 'checked' || st === 'stopping') {
    a.push('view');   // stopping: Stop and delete is running; nothing else until it ends
  } else if (st === 'failed') {
    if (share.onGofile) a.push('delete');
    a.push('remove');
  } else {
    a.push('remove');
  }
  return a.map(k => ({ key: k, disabled: (k === 'resume' || k === 'timer') && !enabled }));
}

const SHARE_ROW_LABEL = {
  copy: 'Copy block', open: 'Open', gone: 'Mark as gone', timer: 'Set timer again', delete: 'Delete',
  view: 'Open upload', resume: 'Resume', stop: 'Stop and delete', remove: 'Remove from list',
};

function shareRowHtml(share, list) {
  const id = Number(share.id);
  const open = list.open.has(id);
  const words = shareStatusWords(share);
  const link = shareSafeLink(share.link);
  const enabled = shareEnabled();
  const acts = shareRowActions(share, enabled).map(({ key, disabled }) => {
    const danger = key === 'delete' || key === 'stop';
    if (key === 'open') {
      return link ? `<a class="vault-btn share-row-btn" href="${shEsc(link)}" target="_blank" rel="noopener noreferrer">Open</a>`
        : '<button type="button" class="vault-btn share-row-btn" disabled>Open</button>';
    }
    return `<button type="button" class="vault-btn share-row-btn${danger ? ' share-btn-danger' : ''}" data-row-act="${key}" data-row-id="${id}"${disabled ? ' disabled title="Share privately is turned off. Turn it on in Settings first."' : ''}>${SHARE_ROW_LABEL[key]}</button>`;
  }).join('');
  const sub = `${Number(share.fileCount || 0).toLocaleString()} ${share.fileCount === 1 ? 'file' : 'files'}${share.partCount > 1 ? `, ${share.partCount} parts` : ''}`;
  const name = share.archiveDisplayName || `${share.archiveName}.7z`;
  let foldBody = '';
  if (open) {
    const d = list.files.get(id);
    const files = d && d.files ? d.files : null;
    foldBody = `
      <tr class="share-fold-row"><td></td><td colspan="5">
        <div class="share-fold">
          ${files === null ? '<span class="share-mut">Loading…</span>'
    : files.length ? files.map(f => `<div class="share-file"><span class="share-file-name">${shEsc(f.name)}</span><span class="share-mut">${shEsc(shareSize(f.sizeBytes))}</span></div>`).join('')
      : '<span class="share-mut">Vault did not keep which files were in this share.</span>'}
          <div class="share-mut share-fold-foot">${share.partCount === 1 ? '1 part' : `${Number(share.partCount || 0)} parts`}${share.accountThisSession ? ', gofile account from this session' : ''}</div>
        </div>
      </td></tr>`;
  }
  return `
    <tr class="share-row">
      <td class="share-fold-cell"><button type="button" class="share-fold-btn" data-row-act="fold" data-row-id="${id}" aria-expanded="${open}"
          aria-label="${open ? 'Hide' : 'Show'} files in this share">${shIcon(open ? 'chevron' : 'chev-right') || (open ? '▾' : '▸')}</button></td>
      <td><span class="share-mono">${shEsc(name)}</span><div class="share-mut share-small">${shEsc(sub)}</div></td>
      <td>${shEsc(shareSize(share.sizeBytes))}</td>
      <td>${share.uploadedAt ? shEsc(shareWhen(share.uploadedAt)) : '<span class="share-mut">Not yet</span>'}</td>
      <td><span class="share-st is-${words.tone}">${shEsc(words.text)}</span>${share.error ? `<div class="share-small share-st is-bad">${shEsc(share.error)}</div>` : ''}</td>
      <td><div class="share-row-acts">${acts}</div></td>
    </tr>${foldBody}`;
}

function shareListHtml(list) {
  const shares = list.shares || [];
  const resumable = shares.some(s => s.status === 'paused' || s.status === 'not_finished');
  const online = shares.filter(s => s.onGofile);
  return `
    <div class="share-head">
      <div class="share-head-text">
        <h3 id="shareListTitle">My shares</h3>
        <p class="vault-modal-hint share-sub">Everything Vault has uploaded for you, from Vault's own records. Use Open to see the gofile page yourself.</p>
      </div>
      <button type="button" class="share-x" data-list-act="close" aria-label="Close" title="Close">${shIcon('close') || '&times;'}</button>
    </div>
    ${!shareEnabled() && resumable ? '<p class="vault-modal-hint share-off-line">Share privately is turned off. Turn it on in Settings to resume an upload.</p>' : ''}
    <div class="share-table-wrap" data-share-private>
      ${shares.length ? `
      <table class="share-table">
        <thead><tr><th class="share-fold-cell"><span class="share-sr">Files</span></th><th>Archive</th><th>Size</th><th>Uploaded</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${shares.map(s => shareRowHtml(s, list)).join('')}</tbody>
      </table>` : '<p class="vault-modal-hint share-empty">Nothing shared yet.</p>'}
    </div>
    <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
    <div class="share-list-foot">
      <p class="vault-modal-hint">Vault does not ask gofile about old uploads. Free gofile storage can be removed early, so use Open to check, then Mark as gone if it is.</p>
      <button type="button" class="vault-btn share-btn-danger" data-list-act="delete-all"${online.length ? '' : ' disabled'}>Delete all uploads from gofile</button>
    </div>`;
}

async function shareOpenMyShares() {
  if (_shareList && !_shareList.m.closed) { shareListRefresh(); return; }
  const m = shareModal({ id: 'shareListDlg', labelledBy: 'shareListTitle', cls: 'share-list-dlg', onEsc: () => shareListClose() });
  _shareList = { m, shares: [], open: new Set(), files: new Map(), timer: null };
  m.box.innerHTML = '<p class="vault-modal-hint">Loading…</p>';
  m.box.addEventListener('click', shareListClick);
  await shareListRefresh();
  const first = m.box.querySelector('[data-list-act="close"]');
  shareFocus(first);
}

function shareListClose() {
  const l = _shareList;
  if (!l) return;
  clearTimeout(l.timer);
  _shareList = null;
  l.m.close();
}

async function shareListRefresh() {
  const l = _shareList;
  if (!l) return;
  clearTimeout(l.timer);
  try {
    const r = await shareApi('GET', '/shares', null, { background: true });
    if (l !== _shareList) return;
    l.shares = r.shares || [];
  } catch (err) {
    if (l !== _shareList) return;
    l.error = err.message;
  }
  shareListRender();
  // While something is running, keep the list current.
  if (l.shares.some(s => ['packing', 'uploading'].includes(s.status))) l.timer = setTimeout(shareListRefresh, 5000);
}

function shareListRender() {
  const l = _shareList;
  if (!l) return;
  const active = document.activeElement;
  const keep = active && l.m.box.contains(active) ? (active.dataset.rowAct ? `[data-row-act="${active.dataset.rowAct}"][data-row-id="${active.dataset.rowId}"]` : active.dataset.listAct ? `[data-list-act="${active.dataset.listAct}"]` : null) : null;
  l.m.box.innerHTML = shareListHtml(l);
  shareSetError(l.m.box.querySelector('[data-sh-err]'), l.error || '');
  l.error = '';
  sharePrivacyChanged(l.m.box);
  if (keep) shareFocus(l.m.box.querySelector(keep));
}

async function shareListClick(e) {
  const l = _shareList;
  if (!l) return;
  const la = e.target.closest('[data-list-act]');
  if (la) {
    if (la.dataset.listAct === 'close') shareListClose();
    else if (la.dataset.listAct === 'delete-all') shareOpenDeleteAll();
    return;
  }
  const b = e.target.closest('[data-row-act]');
  if (!b || b.disabled) return;
  const id = Number(b.dataset.rowId);
  const share = l.shares.find(s => s.id === id);
  if (!share) return;
  const act = b.dataset.rowAct;
  try {
    if (act === 'fold') {
      if (l.open.has(id)) l.open.delete(id);
      else {
        l.open.add(id);
        if (!l.files.has(id)) {
          shareApi('GET', `/shares/${id}`, null, { background: true }).then((r) => {
            if (l !== _shareList) return;
            l.files.set(id, { files: r.share.files || [] });
            shareListRender();
          }).catch((err) => { if (l === _shareList) { l.files.set(id, { files: [] }); l.error = err.message; shareListRender(); } });
        }
      }
      shareListRender();
      return;
    }
    if (act === 'copy') {
      const fmt = shareFormatFor(shSet());
      const r = await shareWithGate((vaultPassword) => shareApi('POST', `/shares/${id}/copy-block`, vaultPassword ? { vaultPassword } : {}),
        { needed: shareNeedsGate(share) && fmt.includes('{pass}'), why: 'This share uses your saved password. Vault asks for your Vault password before it copies it.' });
      if (r) await shareCopyText(r.text, r.passwordIncluded ? 'Link and password copied' : 'Link copied. Vault did not keep the password.');
      return;
    }
    if (act === 'view') { shareListClose(); shareOpenShare(id); return; }
    if (act === 'gone') {
      await shareApi('POST', `/shares/${id}/mark-gone`, {});
    } else if (act === 'timer') {
      await shareApi('POST', `/shares/${id}/retry-timer`, {});
    } else if (act === 'resume') {
      await shareApi('POST', `/shares/${id}/resume`, {});
      shareStatePollSoon();
    } else if (act === 'stop') {
      const ok = await vaultConfirm('The parts already on gofile are deleted, then the packed archive on this computer. Your own files are not touched.',
        { title: 'Stop and delete uploaded parts?', okLabel: 'Stop and delete', cancelLabel: 'Keep it', danger: true });
      if (!ok) return;
      await shareApi('POST', `/shares/${id}/stop`, { confirm: true });
      shareStatePollSoon();
    } else if (act === 'delete') {
      const ok = await vaultConfirm('The link stops working for everyone and this cannot be undone. Your own files on this computer are not touched.',
        { title: 'Delete this upload from gofile?', okLabel: 'Delete from gofile', cancelLabel: 'Keep it', danger: true });
      if (!ok) return;
      const r = await shareApi('POST', `/shares/${id}/delete-remote`, {});
      if (typeof showToast === 'function') showToast(r.share && r.share.status === 'gone' ? 'gofile said it was already gone. Marked as gone.' : 'Deleted from gofile.');
    } else if (act === 'remove') {
      try {
        await shareApi('POST', `/shares/${id}/remove`, {});
      } catch (err) {
        if (err.code !== 'STILL_ONLINE') throw err;
        const ok = await vaultConfirm(err.message, { title: 'Remove it from the list anyway?', okLabel: 'Remove from list', cancelLabel: 'Keep it', danger: true });
        if (!ok) return;
        await shareApi('POST', `/shares/${id}/remove`, { confirm: true });
      }
      l.open.delete(id);
      l.files.delete(id);
      shareStatePollSoon();
    }
  } catch (err) {
    if (l === _shareList) l.error = err.message;
  }
  await shareListRefresh();
}

/* ── Delete all ───────────────────────────────────────────────────────── */

/**
 * The second check: what will be deleted, a tick box, the red button bottom
 * left (away from where Delete all was pressed) and "Keep them" highlighted
 * on the right. Rows are deleted one by one; a failed row says why.
 */
function shareOpenDeleteAll() {
  const l = _shareList;
  const rows = (l ? l.shares : []).filter(s => s.onGofile);
  if (!rows.length) return;
  const n = rows.length;
  const m = shareModal({
    id: 'shareDeleteAllDlg', labelledBy: 'shareDelAllTitle', cls: 'share-dlg-mid share-delall',
    html: `
      <h3 id="shareDelAllTitle">Delete ${n} ${n === 1 ? 'upload' : 'uploads'} from gofile?</h3>
      <p class="vault-modal-hint">Their links stop working for everyone and this cannot be undone. Your own files on this computer are not touched.</p>
      <div class="share-box share-delall-list" data-share-private data-del-list>
        ${rows.map(s => `<div class="share-file" data-del-row="${Number(s.id)}"><span class="share-mono share-file-name">${shEsc(s.archiveDisplayName || `${s.archiveName}.7z`)}</span><span class="share-mut" data-del-res>${shEsc(`${shareSize(s.sizeBytes)}, ${shareWhen(s.uploadedAt || s.createdAt).replace(/^Today .*/, 'today').replace(/^Yesterday .*/, 'yesterday')}`)}</span></div>`).join('')}
      </div>
      <label class="share-tick share-tick-danger"><input type="checkbox" id="shDelAllTick"><span>Yes, delete all ${n} from gofile</span></label>
      <div class="vault-modal-err" role="alert" data-sh-err hidden></div>
      <div class="vault-modal-actions share-actions">
        <button type="button" class="vault-btn share-btn-danger-solid" data-del-act="go" disabled>Delete all ${n}</button>
        <span class="share-sp"></span>
        <button type="button" class="vault-btn vault-btn-primary" data-del-act="keep">Keep them</button>
      </div>`,
  });
  const tick = m.q('#shDelAllTick');
  const go = m.q('[data-del-act="go"]');
  tick.addEventListener('change', () => { go.disabled = !tick.checked; });
  m.box.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-act]');
    if (!b || b.disabled) return;
    if (b.dataset.delAct === 'keep' || b.dataset.delAct === 'close') { m.close(); shareListRefresh(); return; }
    go.disabled = true;
    tick.disabled = true;
    go.textContent = 'Deleting…';
    try {
      const r = await shareApi('POST', '/delete-all', { confirm: true });
      for (const res of r.results || []) {
        const row = m.q(`[data-del-row="${Number(res.id)}"] [data-del-res]`);
        if (!row) continue;
        row.textContent = res.ok ? (res.status === 'gone' ? 'Already gone' : 'Deleted') : (res.error || 'Not deleted');
        row.classList.add(res.ok ? 'share-ok' : 'share-bad');
      }
      m.q('#shareDelAllTitle').textContent = r.failed ? `${r.deleted} deleted, ${r.failed} not deleted` : `${r.deleted} deleted from gofile`;
      if (r.failed) shareSetError(m.q('[data-sh-err]'), 'The ones not deleted stay in My shares with the reason. Try them again from there.');
    } catch (err) {
      shareSetError(m.q('[data-sh-err]'), err.message);
    }
    const acts = m.q('.vault-modal-actions');
    acts.innerHTML = '<span class="share-sp"></span><button type="button" class="vault-btn vault-btn-primary" data-del-act="close">Close</button>';
    shareFocus(acts.querySelector('button'));
    shareStatePollSoon();
  });
  shareFocus(m.q('[data-del-act="keep"]'));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shareSettingsHtml, shareRowActions, shareParseCustomSize, shareCustomSizeParts };
}
