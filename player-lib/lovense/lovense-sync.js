/* =========================================================================
   LOVENSE SYNC — beat-driven direct-drive reconciler (LOVENSE_SPEC.md §4/§5).

   Replaces vid2vibes' 5-second Pattern-chunk streaming, which structurally
   could not sync (chunks idle at boundaries; pre-sending truncates; pauses
   play out the tail). Here the device is a stateful actuator holding ONE
   scalar (strength 0–20) that we reconcile every ~70ms against a target
   sampled from a precomputed intensity envelope at video.currentTime + lead:

     • send only when the target CHANGES  → gapless, ~beat-rate traffic
     • keepalive resend at timeSec/2 while holding a nonzero strength —
       NOT optional: Function only holds for timeSec, so a sustained value
       would expire on-device mid-passage without it
     • timeSec: 2 doubles as a hardware dead-man's switch — if the page
       dies, the device stops itself within 2s with no code running
     • every tick re-anchors to video.currentTime → pause/seek/speed safe

   Beats come from BeatBar.ensureBeats() — the same array the visual bar
   draws, so device and visuals can't drift apart.
   ========================================================================= */
(function () {
  const LS_CFG = 'lovense_cfg';
  const LS_ENABLED = 'lovense_enabled';

  const TICK_MS = 70;
  const ENV_STEP = 0.05;        // envelope grid (s)
  const MIN_SEND_MS = 90;       // hard rate cap (~11/s ceiling)
  const SAFETY_SEC = 2;         // Function timeSec — the dead-man's switch
  const KEEPALIVE_MS = SAFETY_SEC * 500;  // resend held strength at timeSec/2

  const DEFAULT_CFG = {
    min: 2,            // strength floor while the envelope is active (0–20)
    max: 20,           // strength ceiling (0–20)
    leadMs: 120,       // send lead ≈ one-way command latency (Test calibrates)
    mode: 'energy',    // 'energy' (sustain floor) | 'pulse' (crisp per-beat)
    floor: 0.12,       // envelope sustain floor between beats (energy mode)
  };

  function loadCfg() {
    try { return { ...DEFAULT_CFG, ...(JSON.parse(localStorage.getItem(LS_CFG)) || {}) }; }
    catch { return { ...DEFAULT_CFG }; }
  }

  const LovenseSync = {
    cfg: loadCfg(),
    enabled: (() => { try { return localStorage.getItem(LS_ENABLED) === '1'; } catch { return false; } })(),

    _video: null,
    _mediaId: null,
    _env: null,           // Float32Array 0..1 on the ENV_STEP grid
    _envMode: null,       // mode the envelope was built with
    _beats: null,
    _timer: null,
    _running: false,
    _deviceStrength: -1,  // last value actually sent (-1 = unknown → force send)
    _lastSendAt: 0,
    _vidHandlers: null,
    _docHandlers: null,
    onStatus: null,       // cb(text) — UI status line

    saveCfg(partial) {
      this.cfg = { ...this.cfg, ...partial };
      try { localStorage.setItem(LS_CFG, JSON.stringify(this.cfg)); } catch {}
      // Intensity/mode changes re-shape the envelope; rebuild from kept beats
      if (this._beats && this._envMode !== this.cfg.mode) this._buildEnvelope();
    },

    setEnabled(on) {
      this.enabled = !!on;
      try { localStorage.setItem(LS_ENABLED, on ? '1' : '0'); } catch {}
      if (!on) {
        this._stopLoop();
        this._stopDevice();
      } else if (this._video && this._env && !this._video.paused) {
        this._startLoop();
      }
      this._status();
    },

    /* ── Media attachment (playMedia wrapper in lovense-ui.js calls this) ── */

    async setMedia(videoEl, mediaItem) {
      this.detach();
      if (!videoEl || !mediaItem?.id) return;
      this._video = videoEl;
      this._mediaId = mediaItem.id;
      this._bindVideo(videoEl);

      if (!this.enabled) return;
      this._status('analyzing beats…');
      try {
        const { beats, bpm } = await BeatBar.ensureBeats(mediaItem);
        // Media switched again while we were detecting? Bail quietly.
        if (this._mediaId !== mediaItem.id) return;
        this._beats = beats;
        this._buildEnvelope();
        this._status(`${beats.length} beats · ${Math.round(bpm)} BPM`);
        if (!videoEl.paused) this._startLoop();
      } catch (e) {
        this._beats = null;
        this._env = null;
        this._status('beats unavailable: ' + e.message);
      }
    },

    detach() {
      this._stopLoop();
      if (this._video && this._vidHandlers) {
        for (const [ev, fn] of this._vidHandlers) this._video.removeEventListener(ev, fn);
      }
      if (this._video) this._stopDevice();
      this._video = null;
      this._mediaId = null;
      this._vidHandlers = null;
      this._beats = null;
      this._env = null;
    },

    _bindVideo(v) {
      const hs = [
        ['play', () => { if (this.enabled && this._env) this._startLoop(); }],
        ['pause', () => { this._stopLoop(); this._stopDevice(); }],
        ['ended', () => { this._stopLoop(); this._stopDevice(); }],
        ['seeking', () => { this._deviceStrength = -1; }],  // force fresh send after the seek settles
      ];
      for (const [ev, fn] of hs) v.addEventListener(ev, fn);
      this._vidHandlers = hs;
    },

    /* ── Envelope: beats → intensity(t) 0..1 on a fine grid ─────────────── */

    _buildEnvelope() {
      const v = this._video;
      const beats = this._beats;
      if (!v || !beats) return;
      const dur = v.duration && isFinite(v.duration) ? v.duration
        : (beats.length ? beats[beats.length - 1] + 5 : 0);
      const n = Math.max(1, Math.ceil(dur / ENV_STEP) + 1);
      const env = new Float32Array(n);
      const mode = this.cfg.mode;
      const decayFor = (gap) => mode === 'pulse'
        ? 0.22
        : Math.max(0.15, Math.min(gap || 0.45, 0.45));

      for (let b = 0; b < beats.length; b++) {
        const t = beats[b];
        const gap = (beats[b + 1] ?? t + 1) - t;
        const decay = decayFor(gap);
        const i0 = Math.max(0, Math.round(t / ENV_STEP));
        const i1 = Math.min(n - 1, Math.ceil((t + decay * 1.6) / ENV_STEP));
        for (let i = i0; i <= i1; i++) {
          const age = i * ENV_STEP - t;
          const k = Math.exp(-3.2 * Math.max(0, age) / decay);
          if (k > env[i]) env[i] = k;
        }
        // Sustain floor from this beat toward the next (energy mode only) —
        // the song keeps "humming" between hits instead of dying to zero
        if (mode === 'energy') {
          const f = this.cfg.floor;
          const e1 = Math.min(n - 1, Math.ceil(Math.min(t + 4, beats[b + 1] ?? t + 4) / ENV_STEP));
          for (let i = i0; i <= e1; i++) if (env[i] < f) env[i] = f;
        }
      }
      this._env = env;
      this._envMode = mode;
    },

    _sample(t) {
      const env = this._env;
      if (!env || t < 0) return 0;
      const i = t / ENV_STEP;
      const lo = Math.floor(i);
      if (lo >= env.length) return 0;
      const a = env[lo], b = env[Math.min(env.length - 1, lo + 1)];
      return a + (b - a) * (i - lo);
    },

    /* ── The reconciler loop (§4.3) ──────────────────────────────────────── */

    _startLoop() {
      if (this._running) return;                 // guard: play can re-fire
      if (!LovenseApi.isConnected || !LovenseApi.activeDeviceId) { this._status('no device'); return; }
      this._running = true;
      this._deviceStrength = -1;                 // fresh anchor
      this._tick();
      this._status('synced');
    },

    _stopLoop() {
      this._running = false;
      clearTimeout(this._timer);
      this._timer = null;
    },

    _stopDevice() {
      if (LovenseApi.isConnected && LovenseApi.activeDeviceId) {
        LovenseApi.stop(LovenseApi.activeDeviceId);
      }
      this._deviceStrength = -1;
    },

    /** External hard-stop (vault lock / teardown): halt the reconcile loop and
     *  the device NOW, but keep the enabled toggle so it resumes on the next
     *  play (e.g. after unlock reloads the page). */
    lockStop() { this._stopLoop(); this._stopDevice(); this._status('idle'); },

    /** Another tab took ownership of the device: halt our loop WITHOUT sending
     *  Stop — the new owner is driving it now, and our last command's 2s
     *  dead-man timeSec retires by itself. Enabled stays as-is, so clicking
     *  Vibe in this tab later reconnects and takes control back. */
    haltQuiet() { this._stopLoop(); this._deviceStrength = -1; this._status('no device'); },

    _tick() {
      if (!this._running) return;
      const v = this._video;
      if (!v) { this._stopLoop(); return; }
      if (v.paused || v.seeking) { this._schedule(); return; }  // events own resync

      const t = v.currentTime + (this.cfg.leadMs / 1000) * (v.playbackRate || 1);
      const e = this._sample(t);
      const target = e <= 0.02 ? 0
        : Math.max(0, Math.min(20, Math.round(this.cfg.min + e * (this.cfg.max - this.cfg.min))));

      const now = performance.now();
      const changed = target !== this._deviceStrength;
      const keepalive = !changed && target > 0 && (now - this._lastSendAt) > KEEPALIVE_MS;
      if ((changed || keepalive) && now - this._lastSendAt >= MIN_SEND_MS) {
        this._lastSendAt = now;
        this._deviceStrength = target;
        LovenseApi.setStrength(LovenseApi.activeDeviceId, target, SAFETY_SEC);
      }
      this._schedule();
    },

    _schedule() { this._timer = setTimeout(() => this._tick(), TICK_MS); },

    _status(text) {
      try { this.onStatus?.(text ?? (this.enabled ? (this._running ? 'synced' : 'idle') : 'off')); } catch {}
    },

    /* ── Global safety nets (installed once) ─────────────────────────────── */

    installSafetyNets() {
      if (this._docHandlers) return;
      const onVis = () => {
        if (document.hidden && this._running) { this._stopLoop(); this._stopDevice(); }
      };
      const onUnload = () => { LovenseApi.stopKeepalive(); };
      const onKey = (e) => {
        // Panic: Esc while syncing → stop device + disable
        if (e.key === 'Escape' && this._running) {
          this.setEnabled(false);
          if (typeof showToast === 'function') showToast('💟 Vibe stopped (Esc)');
        }
      };
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('beforeunload', onUnload);
      document.addEventListener('keydown', onKey);
      this._docHandlers = [onVis, onUnload, onKey];
    },
  };

  window.LovenseSync = LovenseSync;
})();
