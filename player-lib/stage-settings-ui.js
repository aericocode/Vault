/* =========================================================================
   SETTINGS › STAGE - the window shared in Discord (PLAYLISTS_SPEC 5).

   One page, both looks (player-lib/settings.js draws it: RENDERERS.stage,
   wired by stageSettingsWire). The values live on the server
   (GET / POST /api/stage/settings, lib/stage/settings.js), because the Stage
   window is its own browser and reads them from there; an open Stage takes
   a change at once.

   Modern: a card of rows (settings-kit.js). Classic: its own heading and the
   same rows, the seconds inside the sentence ("for 3 s").
   ========================================================================= */

const STAGE_SETTINGS_DEFAULTS = {
  showName: true, nameSeconds: 3, windowName: 'Vault Stage', imageSeconds: 8,
  cursorSeconds: 1, openSize: 'free', muteVault: true, tips: true,
};
let _stageSettings = { ...STAGE_SETTINGS_DEFAULTS };
let _stageSettingsLoaded = false;

const STAGE_SIZE_OPTIONS = [
  { value: 'free', label: 'Free size' },
  { value: '720p', label: '720p (1280 × 720)' },
  { value: '1080p', label: '1080p (1920 × 1080)' },
  { value: '1440p', label: '1440p (2560 × 1440)' },
];

function _stEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _stSwitch(key, on) {
  return `<input type="checkbox" data-stage-setting="${key}" ${on ? 'checked' : ''}>
        <span class="settings-switch" aria-hidden="true"></span>`;
}

function _stNum(key, value, min, max, label) {
  return `<span class="settings-num-wrap">
          <input class="settings-num" type="number" min="${min}" max="${max}" step="1" data-stage-num="${key}" value="${value}" aria-label="${_stEsc(label)}">
          <span class="settings-num-unit">s</span>
        </span>`;
}

/** The Stage page, in the look that is on. */
function stageSettingsHtml() {
  const s = _stageSettings;
  const modern = typeof settingsIsModern === 'function' && settingsIsModern();
  const sizeSel = `<select class="settings-sel" data-stage-sel="openSize" aria-label="Size when Stage opens">
          ${STAGE_SIZE_OPTIONS.map(o => `<option value="${o.value}"${s.openSize === o.value ? ' selected' : ''}>${_stEsc(o.label)}</option>`).join('')}
        </select>`;
  const nameField = `<input class="settings-text" type="text" maxlength="60" spellcheck="false" autocomplete="off"
          data-stage-text="windowName" placeholder="Vault Stage" value="${_stEsc(s.windowName)}" aria-label="Window name">`;

  if (modern) {
    const rows = settingsRowHtml({
      sfind: 'stageShowName', title: 'Show the name as a file starts', desc: 'Bottom left, over the picture.',
      control: `<span class="stage-set-pair">${_stNum('nameSeconds', s.nameSeconds, 1, 30, 'Seconds the name shows')}
        <label class="stage-set-sw" title="Show the name">${_stSwitch('showName', s.showName)}</label></span>`,
    })
      + settingsRowHtml({ sfind: 'stageWindowName', title: 'Window name', desc: 'What Discord lists, and may show on the stream.', control: nameField })
      + settingsRowHtml({ sfind: 'stageImageSeconds', title: 'Show pictures for', desc: 'GIFs play at least one full loop.', control: _stNum('imageSeconds', s.imageSeconds, 1, 600, 'Seconds a picture shows') })
      + settingsRowHtml({ sfind: 'stageCursor', title: 'Hide the cursor', desc: 'After it stops moving over Stage.', control: _stNum('cursorSeconds', s.cursorSeconds, 1, 60, 'Seconds before the cursor hides') })
      + settingsRowHtml({ sfind: 'stageOpenSize', title: 'Size when Stage opens', desc: 'Free size keeps the size and spot you last left it at.', control: sizeSel })
      + settingsRowHtml({ tag: 'label', sfind: 'stageMuteVault', title: 'Mute Vault while Stage is open', desc: 'So viewers don’t hear the file twice.', control: _stSwitch('muteVault', s.muteVault) })
      + settingsRowHtml({ tag: 'label', sfind: 'stageTips', title: 'Tips when Stage opens', desc: 'How to share it in Discord.', control: _stSwitch('tips', s.tips) });
    return `<p class="settings-note stage-set-lead">Stage is the window you share in Discord. Open it from the mini player, the full player, or Play on Stage on a collection.</p>`
      + settingsCardHtml({ title: 'Stage', sfind: 'stage', body: rows });
  }

  // Classic
  const lbl = (text, body) => `${text} ${body}`;
  return `
      <h3 class="settings-h" data-sfind="stage">${typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel('🎬 Stage', { icon: false }) : '🎬 Stage'}</h3>
      <p class="settings-note">The window you share in Discord. Open it from the mini player, the full player, or Play on Stage on a collection.</p>
      ${settingsRowHtml({ sfind: 'stageShowName', title: lbl('Show the name as a file starts, for', _stNum('nameSeconds', s.nameSeconds, 1, 30, 'Seconds the name shows')), desc: 'Bottom left, over the picture.', control: `<label class="stage-set-sw">${_stSwitch('showName', s.showName)}</label>` })}
      ${settingsRowHtml({ sfind: 'stageWindowName', title: 'Window name', desc: 'What Discord lists, and may show on the stream.', control: nameField })}
      ${settingsRowHtml({ sfind: 'stageImageSeconds', title: lbl('Show pictures for', _stNum('imageSeconds', s.imageSeconds, 1, 600, 'Seconds a picture shows')), desc: 'GIFs play at least one full loop.' })}
      ${settingsRowHtml({ sfind: 'stageCursor', title: lbl('Hide the cursor after', _stNum('cursorSeconds', s.cursorSeconds, 1, 60, 'Seconds before the cursor hides')) })}
      ${settingsRowHtml({ sfind: 'stageOpenSize', title: 'Size when Stage opens', control: sizeSel })}
      ${settingsRowHtml({ tag: 'label', sfind: 'stageMuteVault', title: 'Mute Vault while Stage is open', control: _stSwitch('muteVault', s.muteVault) })}
      ${settingsRowHtml({ tag: 'label', sfind: 'stageTips', title: 'Tips when Stage opens', control: _stSwitch('tips', s.tips) })}`;
}

async function _stageSettingsSave(patch, root) {
  try {
    const r = await fetch('/api/stage/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Server returned ${r.status}`), { status: r.status });
    _stageSettings = { ..._stageSettings, ...data };
    if (typeof showToast === 'function') showToast('Saved');
  } catch (err) {
    if (typeof showErrorToast === 'function') showErrorToast(err, 'saving the Stage settings');
  }
  _stageSettingsPaint(root);
}

/** Put the stored values back into the controls (after a save, or the first load). */
function _stageSettingsPaint(root) {
  const s = _stageSettings;
  if (!root) return;
  root.querySelectorAll('[data-stage-setting]').forEach((el) => { el.checked = !!s[el.dataset.stageSetting]; });
  root.querySelectorAll('[data-stage-num]').forEach((el) => { if (document.activeElement !== el) el.value = String(s[el.dataset.stageNum]); });
  root.querySelectorAll('[data-stage-text]').forEach((el) => { if (document.activeElement !== el) el.value = s[el.dataset.stageText]; });
  root.querySelectorAll('[data-stage-sel]').forEach((el) => { el.value = s[el.dataset.stageSel]; });
}

/** Wire the page drawn into root (settings.js calls this after drawing it). */
function stageSettingsWire(root) {
  if (!root) return;
  if (!_stageSettingsLoaded) {
    fetch('/api/stage/settings').then(r => (r.ok ? r.json() : null)).then((s) => {
      if (!s) return;
      _stageSettings = { ...STAGE_SETTINGS_DEFAULTS, ...s };
      _stageSettingsLoaded = true;
      _stageSettingsPaint(root);
    }).catch(() => {});
  }
  root.querySelectorAll('[data-stage-setting]').forEach((el) => {
    el.addEventListener('change', () => _stageSettingsSave({ [el.dataset.stageSetting]: el.checked }, root));
  });
  root.querySelectorAll('[data-stage-num]').forEach((el) => {
    el.addEventListener('change', () => {
      const n = Math.round(Number(el.value));
      const min = Number(el.min), max = Number(el.max);
      if (!Number.isFinite(n)) { _stageSettingsPaint(root); return; }
      const v = Math.max(min, Math.min(max, n));
      el.value = String(v);
      _stageSettingsSave({ [el.dataset.stageNum]: v }, root);
    });
  });
  root.querySelectorAll('[data-stage-sel]').forEach((el) => {
    el.addEventListener('change', () => _stageSettingsSave({ [el.dataset.stageSel]: el.value }, root));
  });
  root.querySelectorAll('[data-stage-text]').forEach((el) => {
    let timer = null;
    let last = el.value;
    const save = () => {
      clearTimeout(timer);
      const v = el.value.replace(/\s+/g, ' ').trim();
      if (!v) { el.value = _stageSettings.windowName; last = el.value; return; }
      if (v === last) return;
      last = v;
      _stageSettingsSave({ windowName: v }, root);
    };
    el.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(save, 600); });
    el.addEventListener('blur', save);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  });
}
