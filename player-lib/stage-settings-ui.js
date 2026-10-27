/* =========================================================================
   SETTINGS › STAGE - the window shared in Discord (PLAYLISTS_SPEC 5).

   One page, both looks (player-lib/settings.js draws it: RENDERERS.stage,
   wired by stageSettingsWire). The values live on the server
   (GET / POST /api/stage/settings, lib/stage/settings.js), because the
   server runs Stage (mpv) and acts on them; an open Stage takes a change at
   once.

   The Player row says where mpv is (GET /api/stage/mpv). "Choose mpv…" asks
   the server to open the native file picker (POST /api/stage/mpv/choose):
   the page never sends a path, and the server checks what was picked.

   Modern: a card of rows (settings-kit.js). Classic: its own heading and the
   same rows, the seconds inside the sentence ("for 3 s").
   ========================================================================= */

const STAGE_SETTINGS_DEFAULTS = {
  showName: true, nameSeconds: 3, windowName: 'Vault Stage', imageSeconds: 8,
  cursorSeconds: 1, openSize: 'free', muteVault: true, tips: true, player: 'auto',
  evenLoudness: true, flowMeasure: 'use', flowShuffle: false, flowEdges: 'auto',
};

const STAGE_FLOW_MEASURE_OPTIONS = [
  { value: 'use', label: 'Only when I use Flow' },
  { value: 'new', label: 'New files too' },
  { value: 'all', label: 'Whole library now' },
];

// Ignore calm intros and credits (player-lib/flow-order.js, Calm edges).
const STAGE_FLOW_EDGES_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'off', label: 'Off' },
  { value: '15', label: '15 s' },
  { value: '30', label: '30 s' },
];

const STAGE_BASIC_WORDS = 'Basic (picture-in-picture): no extra program. It shows the address and controls when your mouse is over it, plays videos only, and stays on top.';
let _stageSettings = { ...STAGE_SETTINGS_DEFAULTS };
let _stageSettingsLoaded = false;
let _stageMpv = null;          // { found, path, version, source, chosen, chosenProblem, canChoose, choice }

/** What the Player row says about mpv. */
function _stageMpvHtml() {
  const m = _stageMpv;
  if (!m) return '<span class="stage-mpv-line">Looking for mpv…</span>';
  const lines = [];
  if (m.found) {
    const where = m.source === 'chosen' ? ', the one you chose' : '';
    lines.push(`<span class="stage-mpv-line">mpv found: <code class="stage-mpv-path">${_stEsc(m.path)}</code>${m.version ? ` <span class="stage-mpv-ver">(${_stEsc(m.version)}${where})</span>` : (where ? ` <span class="stage-mpv-ver">(${where.slice(2)})</span>` : '')}</span>`);
  } else {
    lines.push('<span class="stage-mpv-line stage-mpv-missing">mpv was not found.</span>');
  }
  if (m.chosenProblem) lines.push(`<span class="stage-mpv-line stage-mpv-missing">The mpv you chose can’t be used: ${_stEsc(m.chosenProblem)}</span>`);
  // Which Stage opens now.
  const basic = m.choice === 'basic';
  lines.push(`<span class="stage-mpv-line stage-mpv-use">Stage uses: ${basic ? _stEsc(STAGE_BASIC_WORDS) : 'mpv, its own window (the full Stage).'}</span>`);
  if (!m.found) {
    lines.push('<span class="stage-mpv-line stage-mpv-how">For the full Stage (its own window, pictures, a black Hold, sizes), install mpv, a free video player, from mpv.io. Vault looks in Program Files and on PATH. If it is somewhere else, choose mpv.exe here.</span>');
  }
  return lines.join('');
}

function _stageMpvButtons() {
  const m = _stageMpv || {};
  const can = m.canChoose !== false;
  const off = can ? '' : ' disabled title="This copy of Vault cannot open the Windows file picker."';
  const p = _stageSettings.player === 'basic' ? 'basic' : 'auto';
  return `<span class="stage-mpv-acts">
          <select class="settings-sel" data-stage-player aria-label="Which Stage">
            <option value="auto"${p === 'auto' ? ' selected' : ''}>Auto: mpv when found, else Basic</option>
            <option value="basic"${p === 'basic' ? ' selected' : ''}>Basic only</option>
          </select>
          <button type="button" class="settings-btn settings-btn-quiet" data-stage-mpv="choose"${off}>Choose mpv…</button>
          ${m.chosen ? '<button type="button" class="settings-btn settings-btn-quiet" data-stage-mpv="forget" title="Forget the mpv you chose and find it again">Find it again</button>' : ''}
        </span>`;
}

function _stageMpvPaint(root) {
  if (!root) return;
  const box = root.querySelector('[data-stage-mpv-box]');
  if (box) box.innerHTML = _stageMpvHtml();
  const acts = root.querySelector('[data-stage-mpv-acts]');
  if (acts) acts.innerHTML = _stageMpvButtons();
}

async function _stageMpvLoad(root) {
  try {
    const r = await fetch('/api/stage/mpv');
    if (r.ok) _stageMpv = await r.json();
  } catch {}
  _stageMpvPaint(root);
}

async function _stageMpvAct(act, root) {
  try {
    const r = await fetch(`/api/stage/mpv/${act === 'forget' ? 'forget' : 'choose'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Server returned ${r.status}`), { status: r.status });
    if (data.mpv) _stageMpv = data.mpv;
    if (!data.canceled && typeof showToast === 'function') showToast(act === 'forget' ? 'Vault finds mpv by itself again' : 'Stage will use this mpv');
  } catch (err) {
    if (typeof showErrorToast === 'function') showErrorToast(err, act === 'forget' ? 'forgetting the chosen mpv' : 'choosing mpv');
  }
  _stageMpvPaint(root);
}

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
  const measureSel = `<select class="settings-sel" data-stage-sel="flowMeasure" aria-label="Measure for Flow">
          ${STAGE_FLOW_MEASURE_OPTIONS.map(o => `<option value="${o.value}"${s.flowMeasure === o.value ? ' selected' : ''}>${_stEsc(o.label)}</option>`).join('')}
        </select>`;
  const edgesSel = `<select class="settings-sel" data-stage-sel="flowEdges" aria-label="Ignore calm intros and credits">
          ${STAGE_FLOW_EDGES_OPTIONS.map(o => `<option value="${o.value}"${s.flowEdges === o.value ? ' selected' : ''}>${_stEsc(o.label)}</option>`).join('')}
        </select>`;
  const edgesDesc = 'When Flow orders files, look past a quiet start or end. Playback is not changed.';
  const loudDesc = 'Quiet files are turned up and loud ones down, so viewers don’t reach for the volume. mpv Stage only: Basic can’t.';
  const measureDesc = 'Vault listens to each file’s music for Flow order on a collection, on this PC at low priority, and waits while Stage plays. Only when I use Flow measures a collection when you open Flow on it.';
  const shuffleDesc = 'A collection’s Shuffle lines files up so each one tends to flow into the next, instead of pure random. It still mixes things up.';
  const nameField = `<input class="settings-text" type="text" maxlength="60" spellcheck="false" autocomplete="off"
          data-stage-text="windowName" placeholder="Vault Stage" value="${_stEsc(s.windowName)}" aria-label="Window name">`;

  // Lanes and stream tags (player-lib/stream-tags-settings.js), after the Stage rows.
  const lanes = typeof streamLanesSettingsHtml === 'function' ? streamLanesSettingsHtml(modern) : '';

  const playerRow = settingsRowHtml({
    sfind: 'stagePlayer', title: 'Player', cls: 'stage-mpv-row',
    extra: `<span class="settings-toggle-desc stage-mpv-box" data-stage-mpv-box>${_stageMpvHtml()}</span>`,
    control: `<span data-stage-mpv-acts>${_stageMpvButtons()}</span>`,
  });

  if (modern) {
    const rows = playerRow + settingsRowHtml({
      sfind: 'stageShowName', title: 'Show the name as a file starts', desc: 'Bottom left, over the picture.',
      control: `<span class="stage-set-pair">${_stNum('nameSeconds', s.nameSeconds, 1, 30, 'Seconds the name shows')}
        <label class="stage-set-sw" title="Show the name">${_stSwitch('showName', s.showName)}</label></span>`,
    })
      + settingsRowHtml({ sfind: 'stageWindowName', title: 'Window name', desc: 'What Discord lists, and may show on the stream.', control: nameField })
      + settingsRowHtml({ sfind: 'stageImageSeconds', title: 'Show pictures for', desc: 'GIFs play at least one full loop.', control: _stNum('imageSeconds', s.imageSeconds, 1, 600, 'Seconds a picture shows') })
      + settingsRowHtml({ sfind: 'stageCursor', title: 'Hide the cursor', desc: 'After it stops moving over Stage.', control: _stNum('cursorSeconds', s.cursorSeconds, 1, 60, 'Seconds before the cursor hides') })
      + settingsRowHtml({ sfind: 'stageOpenSize', title: 'Size when Stage opens', desc: 'Free size keeps the size and spot you last left it at.', control: sizeSel })
      + settingsRowHtml({ tag: 'label', sfind: 'stageMuteVault', title: 'Mute Vault while Stage is open', desc: 'So viewers don’t hear the file twice.', control: _stSwitch('muteVault', s.muteVault) })
      + settingsRowHtml({ tag: 'label', sfind: 'stageTips', title: 'Tips when Stage opens', desc: 'How to share it in Discord.', control: _stSwitch('tips', s.tips) })
      + settingsRowHtml({ tag: 'label', sfind: 'stageEvenLoudness', title: 'Even out loudness on Stage', desc: loudDesc, control: _stSwitch('evenLoudness', s.evenLoudness) })
      + settingsRowHtml({ sfind: 'stageFlowMeasure', title: 'Measure for Flow', desc: measureDesc, control: measureSel })
      + settingsRowHtml({ sfind: 'stageFlowEdges', title: 'Ignore calm intros and credits', desc: edgesDesc, control: edgesSel })
      + settingsRowHtml({ tag: 'label', sfind: 'stageFlowShuffle', title: 'Flow shuffle', desc: shuffleDesc, control: _stSwitch('flowShuffle', s.flowShuffle) });
    return `<p class="settings-note stage-set-lead">Stage is the window you share in Discord. Open it from the mini player, the full player, or Play on Stage on a collection.</p>`
      + settingsCardHtml({ title: 'Stage', sfind: 'stage', body: rows }) + lanes;
  }

  // Classic
  const lbl = (text, body) => `${text} ${body}`;
  return `
      <h3 class="settings-h" data-sfind="stage">${typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel('🎬 Stage', { icon: false }) : '🎬 Stage'}</h3>
      <p class="settings-note">The window you share in Discord. Open it from the mini player, the full player, or Play on Stage on a collection.</p>
      ${playerRow}
      ${settingsRowHtml({ sfind: 'stageShowName', title: lbl('Show the name as a file starts, for', _stNum('nameSeconds', s.nameSeconds, 1, 30, 'Seconds the name shows')), desc: 'Bottom left, over the picture.', control: `<label class="stage-set-sw">${_stSwitch('showName', s.showName)}</label>` })}
      ${settingsRowHtml({ sfind: 'stageWindowName', title: 'Window name', desc: 'What Discord lists, and may show on the stream.', control: nameField })}
      ${settingsRowHtml({ sfind: 'stageImageSeconds', title: lbl('Show pictures for', _stNum('imageSeconds', s.imageSeconds, 1, 600, 'Seconds a picture shows')), desc: 'GIFs play at least one full loop.' })}
      ${settingsRowHtml({ sfind: 'stageCursor', title: lbl('Hide the cursor after', _stNum('cursorSeconds', s.cursorSeconds, 1, 60, 'Seconds before the cursor hides')) })}
      ${settingsRowHtml({ sfind: 'stageOpenSize', title: 'Size when Stage opens', control: sizeSel })}
      ${settingsRowHtml({ tag: 'label', sfind: 'stageMuteVault', title: 'Mute Vault while Stage is open', control: _stSwitch('muteVault', s.muteVault) })}
      ${settingsRowHtml({ tag: 'label', sfind: 'stageTips', title: 'Tips when Stage opens', control: _stSwitch('tips', s.tips) })}
      ${settingsRowHtml({ tag: 'label', sfind: 'stageEvenLoudness', title: 'Even out loudness on Stage', desc: loudDesc, control: _stSwitch('evenLoudness', s.evenLoudness) })}
      ${settingsRowHtml({ sfind: 'stageFlowMeasure', title: 'Measure for Flow', desc: measureDesc, control: measureSel })}
      ${settingsRowHtml({ sfind: 'stageFlowEdges', title: 'Ignore calm intros and credits', desc: edgesDesc, control: edgesSel })}
      ${settingsRowHtml({ tag: 'label', sfind: 'stageFlowShuffle', title: 'Flow shuffle', desc: shuffleDesc, control: _stSwitch('flowShuffle', s.flowShuffle) })}
      ${lanes}`;
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
    // An open Flow panel works its order out again (no measuring: player-lib/flow.js).
    if ('flowEdges' in patch && typeof flowSettingsChanged === 'function') flowSettingsChanged();
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
  _stageMpvLoad(root);
  if (typeof streamLanesSettingsWire === 'function') streamLanesSettingsWire(root);
  // The Settings body is one element for every page: one listener on it, ever.
  if (!root._stageMpvWired) {
    root._stageMpvWired = true;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-stage-mpv]');
      if (!b || b.disabled) return;
      _stageMpvAct(b.dataset.stageMpv, root);
    });
    // Auto or Basic only: saved, then the row says which Stage opens now.
    root.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-stage-player]');
      if (!sel) return;
      await _stageSettingsSave({ player: sel.value === 'basic' ? 'basic' : 'auto' }, root);
      _stageMpvLoad(root);
    });
  }
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
