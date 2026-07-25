/* =========================================================================
   LOVENSE API — device discovery + Function/Stop commands over the LAN.

   Ported from SAMPLES/vid2vibes/scripts/lovenseApi.js with the Pattern
   streaming layer REMOVED (see LOVENSE_SPEC.md §3 — chunked Pattern commands
   can't sync live). This layer only knows:
     • GetToys handshake (saved IP → manual IP → subnet scan, abortable)
     • HTTP  http://<ip>:20010/command  (proven)
     • HTTPS https://<ip-with-dashes>.lovense.club:30010/command (secure ctx)
     • Function <Verb>:<0..20> with a short safety timeSec (dead-man's switch)
     • Stop (fire-twice; keepalive variant for beforeunload)

   The reconciler (lovense-sync.js) owns all timing. No globals except
   window.LovenseApi.
   ========================================================================= */
(function () {
  const LS_IP = 'lovense_remote_ip';
  const LS_TRANSPORT = 'lovense_transport'; // 'http' | 'https'
  const LS_DEVICE = 'lovense_device_id';
  const LS_ACTUATORS = 'lovense_device_actuators'; // { [nameKey]: { [verb]: bool } }

  const HTTP_PORT = 20010;
  const HTTPS_PORT = 30010;

  /* Per-device actuator catalog (GetToys name, lowercased, substring match).
     Each device exposes one or more actuators; the extra ones surface in the
     settings panel by device name. Only `default:true` actuators drive on
     first use — devices with a motor beyond vibration (rotate / pump / dual
     motors) default to VIBRATION ONLY until the user opts the others in.
     Devices with no vibration (Gush oscillate, Solace thrust) default to their
     one motor. Unknown devices fall back to a single Vibrate actuator. */
  const DEVICE_ACTUATORS = [
    { match: 'gush',   actuators: [{ verb: 'Oscillate', label: 'Oscillate', default: true }] },
    { match: 'solace', actuators: [{ verb: 'Thrusting', label: 'Thrust', default: true }] },
    { match: 'nora',   actuators: [{ verb: 'Vibrate', label: 'Vibrate', default: true }, { verb: 'Rotate', label: 'Rotate', default: false }] },
    { match: 'max',    actuators: [{ verb: 'Vibrate', label: 'Vibrate', default: true }, { verb: 'Pump', label: 'Pump (air)', default: false }] },
    { match: 'edge',   actuators: [{ verb: 'Vibrate1', label: 'Vibrate (base)', default: true }, { verb: 'Vibrate2', label: 'Vibrate (tip)', default: false }] },
    { match: 'gemini', actuators: [{ verb: 'Vibrate1', label: 'Vibrate 1', default: true }, { verb: 'Vibrate2', label: 'Vibrate 2', default: false }] },
    { match: 'flexer', actuators: [{ verb: 'Vibrate', label: 'Vibrate', default: true }, { verb: 'Fingering', label: 'Fingering', default: false }] },
  ];
  const FALLBACK_ACTUATORS = [{ verb: 'Vibrate', label: 'Vibrate', default: true }];

  /** Available actuators for a GetToys name (never empty). */
  function actuatorCatalog(name) {
    const n = (name || '').toLowerCase();
    const hit = DEVICE_ACTUATORS.find(m => n.includes(m.match));
    return hit ? hit.actuators : FALLBACK_ACTUATORS;
  }
  const _devKey = (device) => (device?.name || '').toLowerCase().trim();

  function loadActuatorMap() {
    try { return JSON.parse(localStorage.getItem(LS_ACTUATORS)) || {}; }
    catch { return {}; }
  }

  /* ── Cross-tab ownership ──────────────────────────────────────────────
     Exactly ONE tab talks to the device: the last one whose user clicked
     Connect (or the Vibe button). A successful connect broadcasts a claim;
     every other connected tab releases QUIETLY — no Stop is sent, because
     the claiming tab owns the device now and each command's 2s timeSec
     dead-man switch retires the old tab's last hold on its own. */
  const TAB_ID = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  let _bc = null;
  try { _bc = new BroadcastChannel('vault-lovense'); } catch { /* very old browser — single-tab behavior */ }

  const LovenseApi = {
    endpoint: null,        // base URL of the winning transport
    transport: null,
    devices: [],           // [{ id, name, nickname, battery, verb, actuators }]
    activeDeviceId: null,
    isConnected: false,
    onChange: null,        // cb() — connection/devices changed (UI refresh)
    onReleased: null,      // cb() — another tab took the device (UI toast + quiet halt)
    _actMap: loadActuatorMap(),  // per-device enabled actuators (persisted)

    _notify() { try { this.onChange?.(); } catch {} },

    _claimOwnership() { try { _bc?.postMessage({ type: 'claim', tab: TAB_ID }); } catch {} },

    /** Another tab claimed the device: drop our connection state WITHOUT
     *  sending Stop (that would stomp the new owner's first commands). */
    releaseQuiet() {
      if (!this.isConnected) return;
      this.endpoint = null;
      this.transport = null;
      this.devices = [];
      this.activeDeviceId = null;
      this.isConnected = false;
      try { this.onReleased?.(); } catch {}
      this._notify();
    },

    getActiveDevice() { return this.devices.find(d => d.id === this.activeDeviceId) || null; },

    /* ── Actuators (multi-motor devices) ──────────────────────────────── */

    /** Full actuator catalog available for a device (by model name). */
    deviceActuators(device) { return actuatorCatalog(device?.name); },

    /** Is `verb` currently enabled for `device`? Saved selection or default. */
    isActuatorOn(device, verb) {
      const saved = this._actMap[_devKey(device)];
      if (saved && verb in saved) return !!saved[verb];
      const a = actuatorCatalog(device?.name).find(x => x.verb === verb);
      return !!(a && a.default);
    },

    /** Toggle one actuator for a device and persist the whole set (per device). */
    setActuatorOn(device, verb, on) {
      const key = _devKey(device);
      if (!key) return;
      const cat = actuatorCatalog(device.name);
      const seed = {};
      const prev = this._actMap[key] || {};
      for (const a of cat) seed[a.verb] = (a.verb in prev) ? !!prev[a.verb] : a.default;
      seed[verb] = !!on;
      this._actMap[key] = seed;
      try { localStorage.setItem(LS_ACTUATORS, JSON.stringify(this._actMap)); } catch {}
      this._notify();
    },

    /** Verbs to drive for a device — enabled actuators, never empty. */
    enabledVerbs(device) {
      const cat = actuatorCatalog(device?.name);
      const on = cat.filter(a => this.isActuatorOn(device, a.verb));
      const use = on.length ? on : (cat.filter(a => a.default).length ? cat.filter(a => a.default) : [cat[0]]);
      return use.map(a => a.verb);
    },

    verbFor(deviceId) {
      const d = this.devices.find(x => x.id === deviceId);
      return this.enabledVerbs(d)[0] || 'Vibrate';
    },

    savedIP() { try { return localStorage.getItem(LS_IP); } catch { return null; } },

    /* ── Transport probes ─────────────────────────────────────────────── */

    _httpsHost(ip) { return `https://${ip.replace(/\./g, '-')}.lovense.club:${HTTPS_PORT}`; },

    async _post(base, payload, timeoutMs = 2500) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${base}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        return await resp.json();
      } finally {
        clearTimeout(t);
      }
    },

    /** GetToys against one base URL. Returns parsed device list or null. */
    async _tryBase(base, timeoutMs) {
      try {
        const data = await this._post(base, { command: 'GetToys' }, timeoutMs);
        if (data.code === 200 && data.data?.toys) {
          const toys = typeof data.data.toys === 'string' ? JSON.parse(data.data.toys) : data.data.toys;
          return Object.entries(toys).map(([id, t]) => {
            const actuators = actuatorCatalog(t.name);
            return {
              id,
              name: t.name || 'Unknown',
              nickname: t.nickName || t.name || 'Unnamed',
              battery: Number(t.battery) || 0,
              status: t.status === '1' || t.status === 1,
              actuators,                                    // full catalog for the panel
              verb: (actuators.find(a => a.default) || actuators[0]).verb,  // primary (chip/meta)
            };
          });
        }
      } catch { /* not this transport */ }
      return null;
    },

    /** Connect to one IP: HTTP first (proven), then the HTTPS cert domain. */
    async connect(ip, { timeoutMs = 2500 } = {}) {
      ip = (ip || '').trim();
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error('Enter the LAN IP shown in the Lovense app (e.g. 10.0.0.127)');

      const attempts = [
        { base: `http://${ip}:${HTTP_PORT}`, transport: 'http' },
        { base: this._httpsHost(ip), transport: 'https' },
      ];
      for (const a of attempts) {
        const devices = await this._tryBase(a.base, timeoutMs);
        if (devices) {
          this.endpoint = a.base;
          this.transport = a.transport;
          this.devices = devices;
          this.isConnected = true;
          // Restore the previously chosen device when it's still present
          let saved = null;
          try { saved = localStorage.getItem(LS_DEVICE); } catch {}
          this.activeDeviceId = devices.some(d => d.id === saved) ? saved : (devices[0]?.id ?? null);
          try {
            localStorage.setItem(LS_IP, ip);
            localStorage.setItem(LS_TRANSPORT, a.transport);
          } catch {}
          this._claimOwnership();     // this tab controls the device now
          this._notify();
          return { devices, transport: a.transport };
        }
      }
      throw new Error(`No Lovense app answering at ${ip} (:${HTTP_PORT} or :${HTTPS_PORT})`);
    },

    /** Saved IP → common subnet scan. Abortable via the returned controller. */
    scan() {
      const controller = { aborted: false, abort() { this.aborted = true; } };
      const run = async () => {
        const saved = this.savedIP();
        if (saved) {
          try { return await this.connect(saved, { timeoutMs: 1500 }); } catch {}
        }
        const ips = [];
        for (let i = 100; i < 140; i++) ips.push(`10.0.0.${i}`);
        for (let i = 100; i < 140; i++) ips.push(`192.168.1.${i}`);
        for (const ip of ips) {
          if (controller.aborted) throw new Error('scan cancelled');
          const devices = await this._tryBase(`http://${ip}:${HTTP_PORT}`, 450);
          if (devices) return await this.connect(ip);
        }
        throw new Error('Scan found no device — enter the IP from the Lovense app');
      };
      return { promise: run(), controller };
    },

    setActiveDevice(id) {
      this.activeDeviceId = id;
      try { localStorage.setItem(LS_DEVICE, id); } catch {}
      this._notify();
    },

    /* ── Drive commands (the reconciler's only surface) ───────────────── */

    /**
     * Hold `strength` (0–20) for up to timeSec. strength 0 ⇒ Stop.
     * NOT awaited by the reconciler — fire and track lastSendAt only.
     * Returns the fetch promise (Test uses it to measure RTT).
     */
    setStrength(deviceId, strength, timeSec = 2) {
      if (!this.endpoint || !deviceId) return Promise.resolve(false);
      const s = Math.max(0, Math.min(20, Math.round(strength)));
      let payload;
      if (s === 0) {
        payload = { command: 'Function', action: 'Stop', timeSec: 0, toy: deviceId, apiVer: 1 };
      } else {
        // Drive every enabled actuator in ONE Function — the Standard API accepts
        // a comma-joined action list (e.g. "Vibrate1:10,Vibrate2:10").
        const device = this.devices.find(x => x.id === deviceId);
        const action = this.enabledVerbs(device).map(v => `${v}:${s}`).join(',');
        payload = { command: 'Function', action, timeSec, toy: deviceId, apiVer: 1 };
      }
      return this._post(this.endpoint, payload, 1500)
        .then(d => d.code === 200)
        .catch(() => false);
    },

    /** Fire-twice Stop — the second send catches a command mid-flight. */
    stop(deviceId) {
      if (!this.endpoint || !deviceId) return;
      const payload = { command: 'Function', action: 'Stop', timeSec: 0, toy: deviceId, apiVer: 1 };
      const send = () => this._post(this.endpoint, payload, 1500).catch(() => {});
      send();
      setTimeout(send, 80);
    },

    /**
     * Unload-path Stop: a normal fetch is cancelled during page teardown, so
     * this uses keepalive (payload is tiny — far under the 64 KB cap). Even
     * if it's lost, the 2s timeSec dead-man's switch stops the device.
     */
    stopKeepalive() {
      if (!this.endpoint || !this.activeDeviceId) return;
      try {
        fetch(`${this.endpoint}/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({ command: 'Function', action: 'Stop', timeSec: 0, toy: this.activeDeviceId, apiVer: 1 }),
        }).catch(() => {});
      } catch {}
    },

    /**
     * Test ramp: short 0→20→0 sweep on the active device. Times the first
     * ack to calibrate the sync lead. Returns { ok, rttMs }.
     */
    async testRamp(deviceId = this.activeDeviceId) {
      if (!this.endpoint || !deviceId) throw new Error('not connected');
      const t0 = performance.now();
      const ok = await this.setStrength(deviceId, 6, 2);
      const rttMs = Math.round(performance.now() - t0);
      if (!ok) { this.stop(deviceId); throw new Error('device did not ack the test command'); }
      const steps = [[300, 12], [600, 20], [950, 10], [1250, 0]];
      for (const [delay, s] of steps) {
        setTimeout(() => this.setStrength(deviceId, s, 2), delay);
      }
      return { ok: true, rttMs };
    },

    disconnect() {
      if (this.activeDeviceId) this.stop(this.activeDeviceId);
      this.endpoint = null;
      this.transport = null;
      this.devices = [];
      this.activeDeviceId = null;
      this.isConnected = false;
      this._notify();
    },
  };

  // Another tab clicked Connect → it owns the device; we let go quietly.
  if (_bc) {
    _bc.onmessage = (e) => {
      if (e.data?.type === 'claim' && e.data.tab !== TAB_ID) LovenseApi.releaseQuiet();
    };
  }

  window.LovenseApi = LovenseApi;
})();
