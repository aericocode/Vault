/* =========================================================================
   LOVENSE UI — header device chip + settings panel + control-bar Vibe toggle.

   Two surfaces (LOVENSE_SPEC.md §8), both app-token themed:
     A. control-bar "Vibe" button injected next to Loop (beatbar's playMedia
        wrapper pattern — no player-render files touched);
     B. header chip left of the Obsession Score (or first in the header)
        opening the settings popover: IP/connect, device pick + battery,
        intensity min/max, latency lead (Test auto-calibrates), mode, Test,
        Disconnect.
   ========================================================================= */
(function () {
  const DEFAULT_IP_HINT = '10.0.0.127';

  /* ── Header chip ───────────────────────────────────────────────────────── */

  function buildChip() {
    const btns = document.querySelector('.header-buttons');
    if (!btns || document.getElementById('lovenseChip')) return;
    const chip = document.createElement('button');
    chip.id = 'lovenseChip';
    chip.className = 'header-btn lovense-chip';
    chip.title = 'Lovense device — click for connection & sync settings';
    chip.onclick = togglePanel;
    const gamify = document.getElementById('gamifyChip');
    if (gamify) btns.insertBefore(chip, gamify);
    else btns.insertBefore(chip, btns.firstChild);
    renderChip();
  }

  function renderChip() {
    const chip = document.getElementById('lovenseChip');
    if (!chip) return;
    const d = LovenseApi.getActiveDevice();
    if (LovenseApi.isConnected && d) {
      chip.innerHTML = `💟 <span class="lovense-chip-name">${escapeHtml(d.nickname)}</span>` +
        `<span class="lovense-dot lovense-dot-on"></span>` +
        (d.battery ? `<span class="lovense-chip-batt">${d.battery}%</span>` : '');
    } else {
      chip.innerHTML = `💟 <span class="lovense-dot"></span>`;
    }
  }

  /* ── Settings panel ────────────────────────────────────────────────────── */

  function togglePanel() {
    const existing = document.getElementById('lovensePanel');
    if (existing) { existing.remove(); return; }
    openPanel();
  }

  function openPanel() {
    document.getElementById('lovensePanel')?.remove();
    const cfg = LovenseSync.cfg;
    const savedIp = LovenseApi.savedIP() || DEFAULT_IP_HINT;
    const panel = document.createElement('div');
    panel.id = 'lovensePanel';
    panel.className = 'lovense-panel';
    panel.innerHTML = `
      <div class="lovense-row lovense-status-row">
        <span id="lovStatus" class="lovense-status"></span>
        <button class="lovense-x" id="lovClose" title="Close">✕</button>
      </div>
      <div class="lovense-row">
        <span class="lovense-lbl">IP</span>
        <input type="text" class="lovense-input" id="lovIp" value="${escapeHtml(savedIp)}" placeholder="${DEFAULT_IP_HINT}" autocomplete="off">
        <button class="lovense-btn" id="lovConnect">Connect</button>
        <button class="lovense-btn" id="lovScan" title="Try the saved IP, then scan common subnets">Scan</button>
      </div>
      <div class="lovense-row lovense-devices" id="lovDevices"></div>
      <div class="lovense-row lovense-actuators" id="lovActuators"></div>
      <div class="lovense-row">
        <span class="lovense-lbl">Min</span>
        <input type="range" id="lovMin" min="0" max="19" step="1" value="${cfg.min}">
        <span class="lovense-num" id="lovMinV">${cfg.min}</span>
        <span class="lovense-lbl">Max</span>
        <input type="range" id="lovMax" min="1" max="20" step="1" value="${cfg.max}">
        <span class="lovense-num" id="lovMaxV">${cfg.max}</span>
      </div>
      <div class="lovense-row">
        <span class="lovense-lbl" title="Commands are sent this far ahead so they land on the beat — Test measures it">Lead</span>
        <input type="range" id="lovLead" min="0" max="400" step="10" value="${cfg.leadMs}">
        <span class="lovense-num" id="lovLeadV">${cfg.leadMs}ms</span>
      </div>
      <div class="lovense-row">
        <span class="lovense-lbl">Mode</span>
        <label class="lovense-radio"><input type="radio" name="lovMode" value="energy" ${cfg.mode === 'energy' ? 'checked' : ''}> Follow energy</label>
        <label class="lovense-radio"><input type="radio" name="lovMode" value="pulse" ${cfg.mode === 'pulse' ? 'checked' : ''}> Beat pulses</label>
      </div>
      <div class="lovense-row lovense-actions">
        <button class="lovense-btn lovense-btn-primary" id="lovTest" title="Short 1.5s ramp on the device — also calibrates the latency lead">▶ Test device</button>
        <button class="lovense-btn lovense-btn-danger" id="lovDisconnect">Disconnect</button>
      </div>
      <div class="lovense-hint">Local network only — nothing leaves your LAN. Esc while syncing = instant stop.</div>
    `;
    document.body.appendChild(panel);

    // Anchor under the chip
    const chip = document.getElementById('lovenseChip');
    if (chip) {
      const r = chip.getBoundingClientRect();
      panel.style.top = (r.bottom + 8) + 'px';
      panel.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    }

    const q = (sel) => panel.querySelector(sel);
    q('#lovClose').addEventListener('click', () => panel.remove());

    // Outside click closes (capture, like the beat-bar panel)
    const outside = (e) => {
      if (!panel.isConnected) { document.removeEventListener('pointerdown', outside, true); return; }
      if (e.target.closest('#lovensePanel') || e.target.closest('#lovenseChip')) return;
      panel.remove();
      document.removeEventListener('pointerdown', outside, true);
    };
    document.addEventListener('pointerdown', outside, true);

    q('#lovConnect').addEventListener('click', () => doConnect(q('#lovIp').value));
    q('#lovIp').addEventListener('keydown', (e) => { if (e.key === 'Enter') doConnect(q('#lovIp').value); });
    q('#lovScan').addEventListener('click', async () => {
      setStatus('scanning…');
      try { await LovenseApi.scan().promise; setStatus(null); }
      catch (e) { setStatus('⚠ ' + e.message); }
    });

    q('#lovMin').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      q('#lovMinV').textContent = v;
      if (v >= LovenseSync.cfg.max) { q('#lovMax').value = v + 1; q('#lovMaxV').textContent = v + 1; LovenseSync.saveCfg({ max: v + 1 }); }
      LovenseSync.saveCfg({ min: v });
    });
    q('#lovMax').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      q('#lovMaxV').textContent = v;
      if (v <= LovenseSync.cfg.min) { q('#lovMin').value = v - 1; q('#lovMinV').textContent = v - 1; LovenseSync.saveCfg({ min: v - 1 }); }
      LovenseSync.saveCfg({ max: v });
    });
    q('#lovLead').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      q('#lovLeadV').textContent = v + 'ms';
      LovenseSync.saveCfg({ leadMs: v });
    });
    panel.querySelectorAll('input[name="lovMode"]').forEach(r =>
      r.addEventListener('change', () => LovenseSync.saveCfg({ mode: r.value })));

    q('#lovTest').addEventListener('click', async () => {
      const btn = q('#lovTest');
      btn.disabled = true;
      btn.textContent = 'Testing…';
      try {
        const { rttMs } = await LovenseApi.testRamp();
        const lead = Math.max(40, Math.min(400, rttMs));
        LovenseSync.saveCfg({ leadMs: lead });
        const slider = q('#lovLead');
        if (slider) { slider.value = lead; q('#lovLeadV').textContent = lead + 'ms'; }
        setStatus(`test ok — ack ${rttMs}ms, lead set to ${lead}ms`);
      } catch (e) {
        setStatus('⚠ ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '▶ Test device';
      }
    });

    q('#lovDisconnect').addEventListener('click', () => {
      LovenseSync.setEnabled(false);
      LovenseApi.disconnect();
      setStatus(null);
    });

    renderPanelState();
  }

  async function doConnect(ip) {
    setStatus('connecting…');
    try {
      const { devices, transport } = await LovenseApi.connect(ip);
      setStatus(`connected (${transport}) — ${devices.length} device${devices.length === 1 ? '' : 's'}`);
    } catch (e) {
      setStatus('⚠ ' + e.message);
    }
  }

  function setStatus(text) {
    const el = document.getElementById('lovStatus');
    if (!el) return;
    if (text != null) { el.textContent = text; return; }
    const d = LovenseApi.getActiveDevice();
    el.textContent = LovenseApi.isConnected && d
      ? `● Connected — ${d.nickname} (${LovenseApi.transport})`
      : '○ Not connected';
    el.classList.toggle('on', LovenseApi.isConnected);
  }

  function renderPanelState() {
    const panel = document.getElementById('lovensePanel');
    if (!panel) return;
    setStatus(null);
    const wrap = panel.querySelector('#lovDevices');
    if (!LovenseApi.devices.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<span class="lovense-lbl">Device</span>' + LovenseApi.devices.map(d => `
      <label class="lovense-radio lovense-device">
        <input type="radio" name="lovDev" value="${escapeHtml(d.id)}" ${d.id === LovenseApi.activeDeviceId ? 'checked' : ''}>
        ${escapeHtml(d.nickname)} <span class="lovense-devmeta">${escapeHtml(d.verb)}${d.battery ? ` · ${d.battery}%` : ''}</span>
      </label>`).join('');
    wrap.querySelectorAll('input[name="lovDev"]').forEach(r =>
      r.addEventListener('change', () => LovenseApi.setActiveDevice(r.value)));
    renderActuators();
  }

  /** Per-device actuator toggles — only shown for multi-actuator devices, so
   *  the extra options appear based on which device is connected. Selection is
   *  saved per device (defaults to vibration only). */
  function renderActuators() {
    const wrap = document.getElementById('lovActuators');
    if (!wrap) return;
    const d = LovenseApi.getActiveDevice();
    const cat = d ? LovenseApi.deviceActuators(d) : [];
    if (!d || cat.length <= 1) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    wrap.innerHTML = '<span class="lovense-lbl">Motors</span>' + cat.map(a => `
      <label class="lovense-radio lovense-actuator">
        <input type="checkbox" data-verb="${escapeHtml(a.verb)}" ${LovenseApi.isActuatorOn(d, a.verb) ? 'checked' : ''}>
        ${escapeHtml(a.label)}
      </label>`).join('');
    wrap.querySelectorAll('input[data-verb]').forEach(cb =>
      cb.addEventListener('change', () => LovenseApi.setActuatorOn(d, cb.dataset.verb, cb.checked)));
  }

  /* ── Control-bar Vibe toggle (next to Loop) ────────────────────────────── */

  function injectVibeButton() {
    const loopBtn = document.getElementById('loopBtn');
    if (!loopBtn || document.getElementById('vibeBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'vibeBtn';
    btn.className = 'control-btn vibe-btn';
    btn.onclick = toggleVibe;
    loopBtn.insertAdjacentElement('afterend', btn);
    syncVibeButton();
  }

  /** A compact Vibe toggle inside the mini player controls, so the device stays
   *  controllable while minimized (the sync itself keeps running regardless). */
  function injectMiniVibeButton() {
    const controls = document.querySelector('#miniPlayer .mini-player-controls');
    if (!controls || document.getElementById('miniVibeBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'miniVibeBtn';
    btn.className = 'mini-ctrl mini-vibe-btn';
    btn.onclick = toggleVibe;
    const closeBtn = controls.querySelector('.mini-close');
    if (closeBtn) controls.insertBefore(btn, closeBtn);
    else controls.appendChild(btn);
    syncVibeButton();
  }

  function syncVibeButton() {
    const on = LovenseSync.enabled;
    const disconnected = on && !LovenseApi.isConnected;

    const full = document.getElementById('vibeBtn');
    if (full) {
      full.classList.toggle('active', on && !disconnected);
      full.classList.toggle('vibe-warn', disconnected);
      full.textContent = `Vibe: ${on ? (disconnected ? 'No device' : 'On') : 'Off'}`;
      full.title = disconnected
        ? 'Vibe is on but no device is connected — click to open settings'
        : on ? 'Device syncs to the beat — click to stop'
             : 'Sync a Lovense device to this video’s beat (persists across videos)';
    }

    const mini = document.getElementById('miniVibeBtn');
    if (mini) {
      mini.classList.toggle('active', on && !disconnected);
      mini.classList.toggle('vibe-warn', disconnected);
      mini.textContent = '💟';
      mini.title = disconnected
        ? 'Vibe on but no device connected'
        : on ? 'Vibe on — synced to the beat (click to stop)'
             : 'Sync a Lovense device to the beat';
    }
  }

  async function toggleVibe() {
    let on;
    if (!LovenseApi.isConnected) {
      // Not connected (fresh tab, or another tab took the device): the Vibe
      // click IS the connect gesture — try the saved IP and take control.
      const ip = LovenseApi.savedIP();
      if (!ip) {
        openPanel();
        showToast('💟 Connect your device first');
        return;
      }
      showToast('💟 Connecting…');
      try {
        await LovenseApi.connect(ip);
      } catch (e) {
        openPanel();
        showToast('⚠ ' + e.message);
        return;
      }
      on = true;              // connect-click means "start", never toggle-off
    } else {
      on = !LovenseSync.enabled;
    }
    LovenseSync.setEnabled(on);
    if (on) {
      attachCurrent();
      showToast('💟 Vibe ON — synced to the beat (stays on for future videos)');
    } else {
      showToast('Vibe off');
    }
    syncVibeButton();
  }

  /** Point the sync engine at whatever the player is showing right now —
   *  the full player content OR the mini player (they share the media element
   *  when minimized). */
  function attachCurrent() {
    const media = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
    if (!media || !['video', 'audio'].includes(media.media_type)) return;
    const el = document.querySelector('#mediaPlayerContent video, #mediaPlayerContent audio')
            || document.querySelector('#miniPlayerMedia video, #miniPlayerMedia audio');
    const item = allMedia.find(m => m.filepath === media.filepath) || media;
    if (el && item?.id) LovenseSync.setMedia(el, item);
  }

  /* ── Boot & player integration (beatbar's wrapper pattern) ─────────────── */

  document.addEventListener('DOMContentLoaded', () => {
    buildChip();
    injectMiniVibeButton();
    LovenseSync.installSafetyNets();
    LovenseApi.onChange = () => { renderChip(); renderPanelState(); syncVibeButton(); };
    LovenseSync.onStatus = () => syncVibeButton();
    // Another tab clicked Connect and owns the device now — stop driving it
    // (quietly: no Stop) and say so. Clicking Vibe/Connect here takes it back.
    LovenseApi.onReleased = () => {
      LovenseSync.haltQuiet();
      showToast('💟 Another tab took control of the device');
    };

    // NO auto-connect on load — with several tabs open, every tab grabbing
    // the device on startup is exactly how connections trampled each other.
    // Connecting is always an explicit gesture: the panel's Connect/Scan, or
    // the Vibe button (which retries the saved IP itself).

    const orig = playMedia;
    playMedia = function (mediaData, ...rest) {
      // ...rest forwards playMedia's options (the hands-free source flag) —
      // a wrapper that swallows them makes every skip look deliberate.
      orig(mediaData, ...rest);
      LovenseSync.detach();           // media changed → stop device immediately
      if (mediaData && ['video', 'audio'].includes(mediaData.media_type)) {
        setTimeout(() => {            // controls render async — inject after
          injectVibeButton();
          if (LovenseSync.enabled) attachCurrent();
        }, 50);
      }
    };

    // Minimizing moves the SAME media element into the mini player, so the sync
    // keeps running — re-point it at the mini element (defensive) instead of
    // stopping. Only a true close stops the device.
    if (typeof minimizePlayer === 'function') {
      const origMin = minimizePlayer;
      minimizePlayer = function () {
        origMin.apply(this, arguments);
        injectMiniVibeButton();
        if (LovenseSync.enabled) setTimeout(attachCurrent, 0);
      };
    }
    if (typeof closeMediaPlayer === 'function') {
      const origClose = closeMediaPlayer;
      closeMediaPlayer = function () {
        origClose.apply(this, arguments);
        LovenseSync.detach();         // full player closed → stop device
      };
    }
    if (typeof closeMiniPlayer === 'function') {
      const origCloseMini = closeMiniPlayer;
      closeMiniPlayer = function () {
        origCloseMini.apply(this, arguments);
        LovenseSync.detach();         // mini player closed → stop device
      };
    }
  });
})();
