/* =========================================================================
   SCANNING SETTINGS - the "Scanning" group at the top of Settings > Models.

   The choices live on the server (lib/scan-model.js, GET/POST
   /api/ai/scan-settings) because the server acts on them by itself: it loads
   the scan model when files are waiting, holds watched-folder files while the
   GPU is busy, and unloads a copy it loaded once the queue has been idle.

   The model list is what LM Studio has on disk (`lms ls`), vision models
   first. Nothing here recommends a model; the Models page's table does that.

   Mounted from settings.js with one line (its RENDERERS table): html() draws
   from the last answer the server gave, then wires itself and asks again.
   ========================================================================= */

(function () {
  const WHEN = [
    { value: 'room', label: 'Load it if there is room' },
    { value: 'wait', label: 'Wait until I load it' },
    { value: 'always', label: 'Always load it' },
  ];
  const IDLE = [
    { value: 0, label: 'Never' },
    { value: 5, label: '5 min idle' },
    { value: 10, label: '10 min idle' },
    { value: 30, label: '30 min idle' },
  ];

  let data = null;               // the last /api/ai/scan-settings answer
  let loading = null;

  const h = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

  function cfg() {
    return (data && data.settings) || { scanModel: '', whenNotLoaded: 'room', gpuFreeForWatch: false, unloadIdleMin: 10 };
  }

  const fmtGb = (b) => {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) return '';
    const g = n / (1024 ** 3);
    return g >= 10 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`;
  };
  const shortName = (id) => { const s = String(id || ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; };

  function modelOptions() {
    const c = cfg();
    const models = (data && data.models) || [];
    const opt = (m) => `<option value="${h(m.modelKey)}"${m.modelKey === c.scanModel ? ' selected' : ''}>`
      // The whole key: two publishers' builds of one model share a short name.
      + `${h(m.modelKey)}${fmtGb(m.sizeBytes) ? ` · ${fmtGb(m.sizeBytes)}` : ''}</option>`;
    const byName = (x, y) => x.modelKey.localeCompare(y.modelKey, 'en', { numeric: true });
    const vision = models.filter(m => m.vision !== false).sort(byName);
    const text = models.filter(m => m.vision === false).sort(byName);
    let out = `<option value=""${c.scanModel ? '' : ' selected'}>Automatic: whatever model is loaded</option>`;
    // A saved choice that is not on disk any more still shows, so it can be seen and changed.
    if (c.scanModel && !models.some(m => m.modelKey === c.scanModel)) {
      out += `<option value="${h(c.scanModel)}" selected>${h(shortName(c.scanModel))} (not found on disk)</option>`;
    }
    if (vision.length) out += `<optgroup label="Can read pictures">${vision.map(opt).join('')}</optgroup>`;
    // Shown so the list matches LM Studio's, but not pickable: a scan model has to read pictures.
    if (text.length) out += `<optgroup label="Text only, cannot scan pictures">${text.map(m => opt(m).replace('<option ', '<option disabled ')).join('')}</optgroup>`;
    if (!models.length && data) out += '<option value="" disabled>LM Studio did not list any models</option>';
    return out;
  }

  /** The line under Scan model: what decides it right now. */
  function modelNote() {
    if (!data) return 'Used for new files. Picked from the models LM Studio has on disk.';
    if (data.envModel) {
      // Modern keeps the variable's name in the line's tooltip.
      return typeof settingsIsModern === 'function' && settingsIsModern()
        ? `Fixed to ${shortName(data.envModel)} when Vault was started, which outranks this choice.`
        : `AI_MODEL is set to ${shortName(data.envModel)}, and it outranks this choice.`;
    }
    if (data.sessionModel) {
      // The page is called AI servers in Modern.
      const page = typeof settingsIsModern === 'function' && settingsIsModern() ? 'AI servers' : 'Backend';
      return `Right now scans use ${shortName(data.sessionModel)}, picked in the scan panel or the ${page} page. This choice applies again once that pick is set back to Auto (${page}, Model for scans) or Vault restarts.`;
    }
    return 'Used for new files. Picked from the models LM Studio has on disk.';
  }

  function whenNote() {
    if (data && !data.canLoad) {
      return `Vault cannot load models here (${h(data.cannotLoadReason || 'no lms command')}). With "Wait until I load it" files wait for you; otherwise they go out and LM Studio loads the model itself if it can.`;
    }
    return 'Room means free memory on the graphics card, read from the NVIDIA driver. Other cards wait unless you pick Always.';
  }

  function html() {
    const c = cfg();
    setTimeout(wire, 0);
    // A plain line under the name: the notes are set by id after a repaint.
    const note = (id, text) => `<span class="settings-toggle-desc" id="${id}">${text}</span>`;
    const group = `
      <div class="scan-set" id="scanSetGroup">${settingsRowHtml({
        sfind: 'scanModel', title: 'Scan model', extra: `
            ${note('scanSetModelNote', h(modelNote()))}`,
        control: `<select class="settings-sel scan-set-sel" id="scanSetModel" aria-label="Scan model">${modelOptions()}</select>`,
      })}
${settingsRowHtml({
        cls: 'settings-seg-row', sfind: 'scanWhenNotLoaded', titleId: 'segLabel_scanWhen', title: 'When it is not loaded', extra: `
            ${note('scanSetWhenNote', whenNote())}`,
        control: `<span class="settings-seg" role="group" aria-labelledby="segLabel_scanWhen">
            ${WHEN.map(o => `<button type="button" class="settings-seg-btn" data-scan-when="${o.value}"
              aria-pressed="${c.whenNotLoaded === o.value ? 'true' : 'false'}">${h(o.label)}</button>`).join('')}
          </span>`,
      })}
${settingsRowHtml({
        tag: 'label', sfind: 'scanGpuFree', title: 'Only scan watched folders when the GPU is free',
        desc: 'Watched folder files wait while any other model is loaded, so your other work is never slowed or pushed out.',
        control: `<input type="checkbox" id="scanSetGpuFree" ${c.gpuFreeForWatch ? 'checked' : ''}>
          <span class="settings-switch" aria-hidden="true"></span>`,
      })}
${settingsRowHtml({
        sfind: 'scanUnloadIdle', title: 'Unload the scan model after',
        desc: 'Frees GPU memory once the queue is empty. Only a copy Vault loaded itself, never one you loaded.',
        control: `<select class="settings-sel" id="scanSetIdle" aria-label="Unload the scan model after">
            ${IDLE.map(o => `<option value="${o.value}"${c.unloadIdleMin === o.value ? ' selected' : ''}>${h(o.label)}</option>`).join('')}
          </select>`,
      })}
        <p class="th-status scan-set-status" id="scanSetStatus" role="status" aria-live="polite"></p>
      </div>`;
    if (typeof settingsIsModern === 'function' && settingsIsModern()) return settingsCardHtml({ title: 'Scanning', body: group });
    return `
      <h3 class="settings-h">Scanning</h3>${group}`;
  }

  function status(text, bad = false) {
    const el = document.getElementById('scanSetStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('th-bad', !!bad);
  }

  /** Repaint from `data` without rebuilding the group. */
  function paint() {
    const root = document.getElementById('scanSetGroup');
    if (!root) return;
    const c = cfg();
    const sel = root.querySelector('#scanSetModel');
    if (sel && document.activeElement !== sel) sel.innerHTML = modelOptions();
    const mn = root.querySelector('#scanSetModelNote');
    mn.textContent = modelNote();
    if (data && data.envModel) mn.title = 'Set by the AI_MODEL environment variable'; else mn.removeAttribute('title');
    root.querySelector('#scanSetWhenNote').innerHTML = whenNote();
    root.querySelectorAll('[data-scan-when]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.scanWhen === c.whenNotLoaded)));
    root.querySelector('#scanSetGpuFree').checked = !!c.gpuFreeForWatch;
    const idle = root.querySelector('#scanSetIdle');
    if (document.activeElement !== idle) idle.value = String(c.unloadIdleMin);
  }

  async function load({ refresh = false } = {}) {
    if (loading) return loading;
    loading = (async () => {
      try {
        const res = await fetch(`/api/ai/scan-settings${refresh ? '?refresh=1' : ''}`);
        if (!res.ok) return;
        data = await res.json();
        paint();
      } catch { /* the group keeps what it showed */ } finally {
        loading = null;
      }
    })();
    return loading;
  }

  async function save(patch) {
    status('Saving…');
    try {
      const res = await fetch('/api/ai/scan-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      data = out;
      paint();
      status('Saved.');
      setTimeout(() => { const el = document.getElementById('scanSetStatus'); if (el && el.textContent === 'Saved.') status(''); }, 2000);
    } catch (err) {
      status(`Could not save: ${err.message}`, true);
      paint();
    }
  }

  function wire() {
    const root = document.getElementById('scanSetGroup');
    if (!root || root.dataset.wired) return;
    root.dataset.wired = '1';
    root.querySelector('#scanSetModel').addEventListener('change', (e) => save({ scanModel: e.target.value }));
    root.querySelectorAll('[data-scan-when]').forEach(b => b.addEventListener('click', () => {
      root.querySelectorAll('[data-scan-when]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      save({ whenNotLoaded: b.dataset.scanWhen });
    }));
    root.querySelector('#scanSetGpuFree').addEventListener('change', (e) => save({ gpuFreeForWatch: e.target.checked }));
    root.querySelector('#scanSetIdle').addEventListener('change', (e) => save({ unloadIdleMin: Number(e.target.value) }));
    load();
  }

  window.vaultScanSettingsHtml = html;
})();
