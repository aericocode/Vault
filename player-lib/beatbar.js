/* =========================================================================
   BEAT BAR - Beat detection + scrolling beat visualization for videos.

   Port of beatbar_userscript.js (v2.5.3) adapted to the local player:
   - The server extracts a small mono audio track via ffmpeg
     (/api/media/:id/beat-audio) and we decode + analyze locally.
   - 🥁 toggle + ⚙ settings buttons in the player controls (videos only).
     Enabled state persists in localStorage across videos AND sessions.
   - Beats are cached in localStorage per media id + sensitivity.

   Settings (⚙, persisted in localStorage `beatbar_config`, all live-preview):
   - Sensitivity 1.0–10.0 (decimals). 2.0 = default; anchored so 1.0 matches
     the original "level 2" floor and everything above ramps up hard.
   - Speed — faster scroll = less preview time (shorter lookahead).
   - Playhead position 10 / 25 / 50%.
   - Icon shape (custom rounded paths), beat effect (pulse/echo/ripple/spark),
     fill colour/size/opacity, border colour/width — all themed controls,
     no native pickers or dropdowns.
   - Drag the bar vertically from anywhere on it (horizontal stays locked).

   The settings panel opens ABOVE the bar (never covering the in-bar ⚙),
   both ⚙ buttons toggle it, and clicking anywhere else closes it.

   Rendering runs on requestAnimationFrame (full display refresh) with a
   drift-corrected time estimate so motion stays smooth between the video's
   coarse ~4Hz timeupdate samples.
   ========================================================================= */

(function () {
  const LS_ENABLED = 'beatbar_enabled';
  const LS_CONFIG = 'beatbar_config';
  const LS_BEATS_PREFIX = 'beatbar_beats_';

  // Kick preset (userscript PRESETS.kick) + fixed defaults
  const PRESET = { bandLow: 40, bandHigh: 120, minBpm: 80, maxBpm: 180, sensitivity: 1.5, avgWindow: 1.0, q: 1.5 };
  const PAST_FADE_SEC = 1.2;

  /* ── Beat-sync feel — TWEAK THESE ────────────────────────────────────────
     Each beat's "hit" (icon grow + effects) is an ease-in / ease-out envelope
     centred on the beat rather than a hard flash that only decays afterwards.
     Three knobs control how it lands against the audio:

       BEAT_NUDGE_SEC   — fire the peak this many seconds EARLY. Counters the
                          perception + render lag that made hits feel late.
                          0 = peak dead-on the beat; raise it if still late,
                          lower toward 0 if it now feels early.
       BEAT_ATTACK_SEC  — grow-in time BEFORE the peak (anticipation): the icon
                          eases UP as it approaches the playhead line, so the
                          motion straddles the line instead of trailing left.
       BEAT_RELEASE_SEC — ease-out time AFTER the peak. Shorter = snappier and
                          less trailing to the left at high scroll speed.

     The curves themselves are easeInCubic (attack — motion concentrates right
     on the beat, so it reads snappy) and easeInOutCubic (release — smooth
     settle). Swap the two functions below to change the feel. */
  const BEAT_NUDGE_SEC = 0.045;   // fire the peak this many sec EARLY (raise if still late)
  const BEAT_ATTACK_SEC = 0.105;  // grow-in time BEFORE the peak (anticipation)
  const BEAT_RELEASE_SEC = 0.82;  // ease-out time AFTER the peak (shorter = snappier)

  const easeInCubic = (p) => p * p * p;
  const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

  // 0 → 1 → 0 as `phase` (seconds relative to the nudged beat; 0 = peak) sweeps
  // the attack then release windows. One curve drives icon size AND every
  // effect, so pulse / ripple / spark stay perfectly in step.
  function beatEnvelope(phase) {
    if (phase <= -BEAT_ATTACK_SEC || phase >= BEAT_RELEASE_SEC) return 0;
    if (phase <= 0) return easeInCubic(1 + phase / BEAT_ATTACK_SEC);   // grow into the beat
    return 1 - easeInOutCubic(phase / BEAT_RELEASE_SEC);               // ease back down
  }

  const BAR_HEIGHT = 120;           // "medium"
  const CONTROLS_OFFSET = 76;      // sit above the native <video> controls
  const MIN_WIDTH_FRAC = 0.5;      // bar is at least this fraction of viewport

  const FILL_SWATCHES = ['#7aa8ff', '#ff4d6d', '#ec4899', '#a855f7', '#9ef0df', '#4ade80', '#fbbf24', '#ffffff'];
  const BORDER_SWATCHES = ['#ffffff', '#000000', '#7aa8ff', '#ec4899', '#fbbf24'];
  const SHAPES = [
    { id: 'circle', glyph: '●' }, { id: 'heart', glyph: '♥' }, { id: 'square', glyph: '■' },
    { id: 'diamond', glyph: '◆' }, { id: 'star', glyph: '★' },
  ];
  // Independent, stackable beat effects (Off in the UI just clears all three)
  const EFFECTS = [
    { id: 'pulse', label: 'Pulse' }, { id: 'ripple', label: 'Ripple' }, { id: 'spark', label: 'Spark' },
  ];

  const DEFAULT_CONFIG = {
    sensitivity: 2.0,      // 1.0–10.0 (decimals); 2.0 == original default
    speed: 7,              // 2–10; higher = faster scroll / less preview
    playheadFrac: 0.5,     // 0.1 / 0.25 / 0.5
    // Bar position = the bar's CENTER as a fraction of the video height
    // (0 = top edge, 1 = bottom). null = classic spot above the native
    // controls. A fraction survives fullscreen and carries video-to-video.
    posFrac: null,
    // User-facing sync offset (seconds) for AV setups with a small
    // audio/video delay. Positive = beats hit the playhead LATER
    // (use if the bar currently feels early); negative = EARLIER.
    // Independent of the fixed BEAT_NUDGE_SEC feel-tuning constant above.
    nudgeSec: 0,
    // style
    shape: 'circle',       // circle | heart | square | diamond | star
    effects: { pulse: true, ripple: false, spark: false },
    fillColor: '#7aa8ff',
    fillSize: 9,           // base dot radius (px)
    fillOpacity: 1.0,      // 0.2–1
    borderColor: '#ffffff',
    borderWidth: 0,        // 0 = auto dark hairline for contrast
  };

  let _state = null; // one active attachment at a time (single player)

  const isEnabled = () => localStorage.getItem(LS_ENABLED) === '1';

  /* ── Config (localStorage) ─────────────────────────────────────────────── */

  function loadConfig() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_CONFIG) || '{}');
      const cfg = { ...DEFAULT_CONFIG, ...raw, effects: { ...DEFAULT_CONFIG.effects, ...(raw.effects || {}) } };
      // Migrate the old single-effect string → stackable toggles (echo merged into ripple)
      if (typeof raw.effect === 'string' && !raw.effects) {
        cfg.effects = {
          pulse: raw.effect === 'pulse',
          ripple: raw.effect === 'echo' || raw.effect === 'ripple',
          spark: raw.effect === 'spark',
        };
        delete cfg.effect;
      }
      return cfg;
    }
    catch { return { ...DEFAULT_CONFIG }; }
  }
  function saveConfig() { try { localStorage.setItem(LS_CONFIG, JSON.stringify(config)); } catch {} }
  let config = loadConfig();

  // Slider 1.0–10.0 → threshold multiplier (higher mult = lower threshold =
  // MORE beats). Anchored: 1.0 reproduces the original "level 2" floor and
  // 2.0 the original default; the curve keeps steepening all the way to 10
  // (≈ every local energy peak becomes a beat).
  function effectiveSensitivity() {
    const s = config.sensitivity;
    const mult = 0.8 + 0.15 * (s - 1) + 0.05 * (s - 1) * (s - 1);
    return PRESET.sensitivity / mult;
  }

  function lookaheadSeconds() {
    return lookaheadFor(config);
  }

  function lookaheadFor(cfg) {
    // speed 2 → 10s preview (slow), speed 10 → 2s preview (fast)
    return 12 - (cfg.speed || 7);
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 122, g: 168, b: 255 };
  }

  /* ── Beat cache (localStorage, small: ~2-6KB per video per level) ──────── */

  function beatCacheKey(id) { return `${LS_BEATS_PREFIX}${id}_s${Number(config.sensitivity).toFixed(1)}`; }

  function cacheGet(id) {
    try {
      const raw = localStorage.getItem(beatCacheKey(id));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function cacheSet(id, beats, bpm) {
    const key = beatCacheKey(id);
    const payload = JSON.stringify({ beats: beats.map(b => Math.round(b * 1000) / 1000), bpm });
    try {
      localStorage.setItem(key, payload);
    } catch {
      try {
        const keys = Object.keys(localStorage).filter(k => k.startsWith(LS_BEATS_PREFIX));
        keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => localStorage.removeItem(k));
        localStorage.setItem(key, payload);
      } catch {}
    }
  }

  /* ── Detection (ported verbatim from the userscript) ───────────────────── */

  function detectBeats(audioBuffer, opts) {
    const { sensitivity, minGapMs, avgWindowSec } = opts;
    const sr = audioBuffer.sampleRate;
    const data = audioBuffer.getChannelData(0);
    const frameSize = 1024, hop = 512;
    const numFrames = Math.floor((data.length - frameSize) / hop);
    const energy = new Float32Array(numFrames);

    for (let i = 0; i < numFrames; i++) {
      let sum = 0;
      const start = i * hop;
      for (let j = 0; j < frameSize; j++) {
        const v = data[start + j];
        sum += v * v;
      }
      energy[i] = Math.sqrt(sum / frameSize);
    }

    const onset = new Float32Array(numFrames);
    for (let i = 1; i < numFrames; i++) {
      const d = energy[i] - energy[i - 1];
      onset[i] = d > 0 ? d : 0;
    }

    const windowFrames = Math.round((sr / hop) * avgWindowSec);
    const minGapFrames = Math.round((minGapMs / 1000) * (sr / hop));
    const beats = [];
    let lastBeat = -Infinity;

    for (let i = 1; i < numFrames - 1; i++) {
      const w0 = Math.max(0, i - windowFrames);
      const w1 = Math.min(numFrames, i + windowFrames);
      let avg = 0;
      for (let k = w0; k < w1; k++) avg += energy[k];
      avg /= (w1 - w0);

      const e = energy[i];
      if (e > avg * sensitivity && e > energy[i - 1] && e >= energy[i + 1] &&
          onset[i] > 0 && i - lastBeat > minGapFrames) {
        beats.push((i * hop) / sr);
        lastBeat = i;
      }
    }
    return beats;
  }

  function estimateBpm(beats) {
    if (beats.length < 4) return 0;
    const ivs = [];
    for (let i = 1; i < beats.length; i++) ivs.push(beats[i] - beats[i - 1]);
    ivs.sort((a, b) => a - b);
    const med = ivs[Math.floor(ivs.length / 2)];
    return med ? 60 / med : 0;
  }

  // Decode + band-pass. The filtered buffer is sensitivity-independent, so we
  // keep it on the state and re-run only detectBeats when sensitivity changes.
  async function renderFiltered(arrayBuffer) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try {
      decoded = await ctx.decodeAudioData(arrayBuffer);
    } finally {
      ctx.close();
    }

    const offline = new OfflineAudioContext(1, decoded.length, decoded.sampleRate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    const p = PRESET;
    const hp1 = offline.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = p.bandLow; hp1.Q.value = p.q;
    const hp2 = offline.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = p.bandLow; hp2.Q.value = p.q;
    const lp1 = offline.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = p.bandHigh; lp1.Q.value = p.q;
    const lp2 = offline.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = p.bandHigh; lp2.Q.value = p.q;
    src.connect(hp1).connect(hp2).connect(lp1).connect(lp2).connect(offline.destination);
    src.start(0);
    return offline.startRendering();
  }

  function detectFromFiltered(filtered) {
    const beats = detectBeats(filtered, {
      sensitivity: effectiveSensitivity(),
      minGapMs: (60 / PRESET.maxBpm) * 1000,
      avgWindowSec: PRESET.avgWindow,
    });
    return { beats, bpm: estimateBpm(beats) };
  }

  /* ── Beat loading (cache → retune source → stream/legacy fetch) ────────── */

  async function loadBeats(state, { retune = false } = {}) {
    const cached = cacheGet(state.mediaId);
    if (cached) {
      applyBeats(state, cached.beats, cached.bpm, retune ? '' : `${cached.beats.length} beats · ${(cached.bpm || 0).toFixed(0)} BPM (cached)`);
      if (!retune) scheduleStatusClear(state);
      return;
    }

    // Retune without re-downloading: the streaming worker keeps the energy
    // envelope (works even mid-analysis), the legacy path keeps filtered PCM.
    if (state.worker) {
      state.worker.postMessage({ cmd: 'retune', effSens: effectiveSensitivity(), rawSens: config.sensitivity });
      return;
    }
    if (state.filtered) {
      const { beats, bpm } = detectFromFiltered(state.filtered);
      cacheSet(state.mediaId, beats, bpm);
      applyBeats(state, beats, bpm, `${beats.length} beats · ${bpm.toFixed(0)} BPM`);
      scheduleStatusClear(state);
      return;
    }

    if (supportsStreamBeats()) return workerLoadBeats(state);
    return legacyLoadBeats(state);
  }

  /* ── Streaming path (WebCodecs worker) ──────────────────────────────────
     The worker fetches ADTS AAC that the server streams DURING extraction,
     decodes chunk-by-chunk and posts beats progressively — the bar fills in
     within seconds even on multi-hour videos, memory stays flat (no 600MB
     whole-file PCM), and the page thread never blocks. Results arrive
     append-only, so swapping the array under the render loop is safe. */

  const supportsStreamBeats = () =>
    typeof window.AudioDecoder === 'function' && typeof window.Worker === 'function';

  function cleanupWorker(state) {
    try { state.worker?.postMessage({ cmd: 'stop' }); } catch {}
    try { state.worker?.terminate(); } catch {}
    state.worker = null;
  }

  function workerLoadBeats(state) {
    setStatus(state, 'Analyzing audio…');
    let w;
    try { w = new Worker('/player-lib/beat-worker.js'); }
    catch { return legacyLoadBeats(state); }
    state.worker = w;

    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (state.destroyed) return;
      if (m.type === 'beats') {
        state.beats = m.beats || [];
        state.bpm = m.bpm || 0;
        if (m.done) {
          // Cache only when the worker's sensitivity is still current (the
          // slider may have moved again while this answer was in flight).
          if (m.rawSens === config.sensitivity) cacheSet(state.mediaId, state.beats, state.bpm);
          setStatus(state, `${state.beats.length} beats · ${(state.bpm || 0).toFixed(0)} BPM`);
          scheduleStatusClear(state);
        } else {
          const dur = (isFinite(state.video?.duration) && state.video.duration) || 0;
          const pct = dur ? Math.min(99, Math.round((m.progressSec / dur) * 100)) : null;
          setStatus(state, pct == null ? 'Detecting beats…' : `Detecting beats… ${pct}%`);
        }
      } else if (m.type === 'error') {
        // WebCodecs path broke (codec support, stream error…) — one-shot
        // fallback to the whole-buffer decodeAudioData pipeline.
        cleanupWorker(state);
        legacyLoadBeats(state);
      }
    };
    w.onerror = () => {
      if (state.destroyed) return;
      cleanupWorker(state);
      legacyLoadBeats(state);
    };

    w.postMessage({
      cmd: 'start',
      url: `/api/media/${state.mediaId}/beat-audio?fmt=adts`,
      effSens: effectiveSensitivity(),
      rawSens: config.sensitivity,
      opts: {
        minGapMs: (60 / PRESET.maxBpm) * 1000,
        avgWindowSec: PRESET.avgWindow,
        bandLow: PRESET.bandLow,
        bandHigh: PRESET.bandHigh,
        q: PRESET.q,
      },
    });
  }

  /* ── Legacy path (no WebCodecs): whole-buffer decodeAudioData ──────────── */

  async function legacyLoadBeats(state) {
    try {
      setStatus(state, 'Extracting audio…');
      // Abortable: skipping to another video mid-download must release this
      // connection immediately (stacked zombie fetches starve the browser's
      // per-host connection limit and stall media loads)
      state.abort = new AbortController();
      const resp = await fetch(`/api/media/${state.mediaId}/beat-audio`, { signal: state.abort.signal });
      if (!resp.ok) throw new Error(`audio extraction failed (${resp.status})`);
      const buf = await resp.arrayBuffer();
      if (state.destroyed) return;

      setStatus(state, 'Detecting beats…');
      state.filtered = await renderFiltered(buf);
      if (state.destroyed) return;

      const { beats, bpm } = detectFromFiltered(state.filtered);
      cacheSet(state.mediaId, beats, bpm);
      applyBeats(state, beats, bpm, `${beats.length} beats · ${bpm.toFixed(0)} BPM`);
      scheduleStatusClear(state);
    } catch (err) {
      if (err?.name === 'AbortError') return; // detached mid-download — expected
      if (!state.destroyed) setStatus(state, `Beat bar: ${err.message}`);
    }
  }

  function applyBeats(state, beats, bpm, statusText) {
    state.beats = beats || [];
    state.bpm = bpm || 0;
    if (statusText != null) setStatus(state, statusText);
  }

  function scheduleStatusClear(state) {
    clearTimeout(state._statusTimer);
    state._statusTimer = setTimeout(() => setStatus(state, ''), 2500);
  }

  /* ── Shapes (custom paths tuned to the app's soft/rounded aesthetic) ───── */

  // Trace a closed polygon with rounded corners (quadratic curves through
  // the vertices). `roundness` 0..1 shifts the curve anchor toward the edge
  // midpoints (higher = rounder).
  function traceRoundedPolygon(ctx, pts, roundness) {
    const n = pts.length;
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    let prevMid = lerp(pts[0], pts[1], 0.5);
    ctx.moveTo(prevMid.x, prevMid.y);
    for (let i = 1; i <= n; i++) {
      const p = pts[i % n];
      const next = pts[(i + 1) % n];
      const mid = lerp(p, next, 0.5);
      // Pull the control point slightly toward the midpoint chord for softness
      const cp = lerp(p, lerp(prevMid, mid, 0.5), roundness * 0.5);
      ctx.quadraticCurveTo(cp.x, cp.y, mid.x, mid.y);
      prevMid = mid;
    }
    ctx.closePath();
  }

  function traceShape(ctx, shape, x, y, r) {
    ctx.beginPath();
    switch (shape) {
      case 'square':
        // Ever-so-slightly rounded corners
        ctx.roundRect(x - r * 0.92, y - r * 0.92, r * 1.84, r * 1.84, r * 0.28);
        break;
      case 'diamond': {
        // Rotated rounded square = diamond with soft points
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        const side = r * 1.5;
        ctx.roundRect(-side / 2, -side / 2, side, side, r * 0.22);
        ctx.restore();
        break;
      }
      case 'star': {
        // 5-point star with gently rounded tips
        const spikes = 5, outer = r * 1.12, inner = r * 0.52;
        const pts = [];
        for (let i = 0; i < spikes * 2; i++) {
          const rad = (i % 2 === 0) ? outer : inner;
          const a = (Math.PI / spikes) * i - Math.PI / 2;
          pts.push({ x: x + Math.cos(a) * rad, y: y + Math.sin(a) * rad });
        }
        traceRoundedPolygon(ctx, pts, 0.55);
        break;
      }
      case 'heart':
        // Bubbly heart: fat round lobes, soft bottom point
        ctx.moveTo(x, y + r * 0.78);
        ctx.bezierCurveTo(x - r * 0.28, y + r * 0.52, x - r * 1.35, y - r * 0.05, x - r * 1.02, y - r * 0.62);
        ctx.bezierCurveTo(x - r * 0.78, y - r * 1.12, x - r * 0.12, y - r * 0.92, x, y - r * 0.38);
        ctx.bezierCurveTo(x + r * 0.12, y - r * 0.92, x + r * 0.78, y - r * 1.12, x + r * 1.02, y - r * 0.62);
        ctx.bezierCurveTo(x + r * 1.35, y - r * 0.05, x + r * 0.28, y + r * 0.52, x, y + r * 0.78);
        ctx.closePath();
        break;
      default: // circle
        ctx.arc(x, y, r, 0, Math.PI * 2);
    }
  }

  /* ── Beat effects (stackable; k = 1→0 over the pulse life) ─────────────── */

  // Per-beat random spark layout so no two beats look identical: jittered
  // angles, per-particle speed/size, and a small angular drift while flying.
  // Deterministic per-beat layout (seeded by beat index via xorshift32) so the
  // same beat renders identical sparks every frame — no per-frame jitter, and
  // nothing to store or clean up between frames.
  function makeSparks(seed) {
    let s = ((seed + 1) * 2654435761) >>> 0;
    const rnd = () => {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
    const n = 5 + ((rnd() * 4) | 0); // 5–8 particles
    const base = rnd() * Math.PI * 2;
    return Array.from({ length: n }, (_, i) => ({
      ang: base + (Math.PI * 2 / n) * i + (rnd() - 0.5) * 0.9,
      speed: 1.4 + rnd() * 1.6,
      size: 0.12 + rnd() * 0.16,
      drift: (rnd() - 0.5) * 1.2,
    }));
  }

  function drawEffects(ctx, effects, shape, x, y, baseR, k, rgb, fade, pulse) {
    const a = k * fade;

    if (effects.pulse) {
      // Soft radial glow (the icon itself also grows — handled by caller)
      const g = ctx.createRadialGradient(x, y, 0, x, y, baseR + 18);
      g.addColorStop(0, `rgba(${rgb.r},${rgb.g},${rgb.b},${a * 0.55})`);
      g.addColorStop(1, `rgba(${rgb.r},${rgb.g},${rgb.b},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, baseR + 18, 0, Math.PI * 2); ctx.fill();
    }

    if (effects.ripple) {
      // The icon's own shape radiates outward as fading transparent outlines
      ctx.save();
      ctx.strokeStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
      for (const [delay, width] of [[0, 2], [0.3, 1.2]]) {
        const kk = Math.max(0, Math.min(1, (1 - k) / (1 - delay) - delay));
        if (kk <= 0) continue;
        const er = baseR * (1 + kk * 1.9);
        ctx.globalAlpha = a * 0.55 * (1 - kk * 0.5);
        ctx.lineWidth = width;
        traceShape(ctx, shape, x, y, er);
        ctx.stroke();
      }
      ctx.restore();
    }

    if (effects.spark && pulse.sparks) {
      ctx.save();
      ctx.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
      const travel = (1 - k) * baseR;
      for (const s of pulse.sparks) {
        const ang = s.ang + (1 - k) * s.drift;
        const dist = baseR + travel * s.speed;
        ctx.globalAlpha = a * 0.85;
        ctx.beginPath();
        ctx.arc(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist,
                Math.max(1, baseR * s.size * (0.4 + k * 0.6) + 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /* ── Overlay ───────────────────────────────────────────────────────────── */

  function createOverlay(state) {
    const overlay = document.createElement('div');
    overlay.className = 'beatbar-overlay';
    overlay.innerHTML = `
      <canvas class="beatbar-canvas"></canvas>
      <div class="beatbar-status"></div>
      <button class="beatbar-gear" title="Beat bar settings">⚙</button>
      ${settingsPanelHtml()}
    `;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.canvas = overlay.querySelector('.beatbar-canvas');
    state.ctx = state.canvas.getContext('2d');
    state.statusEl = overlay.querySelector('.beatbar-status');

    overlay.querySelector('.beatbar-gear').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsPanel();
    });
    wireSettings(state, overlay);
    wireDrag(state, overlay);

    // Click anywhere outside the panel / gear buttons → close
    state._outsideClose = (e) => {
      const panel = overlay.querySelector('.beatbar-settings');
      if (!panel || panel.hidden) return;
      if (e.target.closest('.beatbar-settings') ||
          e.target.closest('.beatbar-gear') ||
          e.target.closest('#beatbarSettingsBtn')) return;
      setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', state._outsideClose, true);

    const updatePos = () => {
      if (state.destroyed) return;
      const v = state.video;
      if (!v.isConnected) { detach(); return; }
      const rect = v.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) {
        overlay.style.display = 'none';
        return;
      }
      const vw = window.innerWidth;
      const w = Math.max(rect.width, vw * MIN_WIDTH_FRAC);
      let left = rect.left + (rect.width - w) / 2;
      left = Math.max(0, Math.min(vw - w, left));
      // Position by the bar's CENTER as a fraction of the video height, so
      // "top 10%" stays top 10% in fullscreen and on the next video.
      let top;
      if (config.posFrac == null) {
        top = rect.bottom - BAR_HEIGHT - CONTROLS_OFFSET; // classic: above controls
      } else {
        top = rect.top + config.posFrac * rect.height - BAR_HEIGHT / 2;
      }
      top = Math.max(rect.top + 4, Math.min(rect.bottom - BAR_HEIGHT - 4, top));

      overlay.style.display = '';
      overlay.style.left = `${left}px`;
      overlay.style.top = `${top}px`;
      overlay.style.width = `${w}px`;
      overlay.style.height = `${BAR_HEIGHT}px`;
      resizeCanvas(state);
    };
    state._updatePos = updatePos;

    placeOverlay(state);
    updatePos();
    state.ro = new ResizeObserver(updatePos);
    try { state.ro.observe(state.video); } catch {}
    window.addEventListener('resize', updatePos, { passive: true });
    state._posInterval = setInterval(updatePos, 1000);
  }

  // Keep the overlay inside whatever element is fullscreen (the player overlay),
  // otherwise it renders behind the fullscreen layer and disappears.
  function placeOverlay(state) {
    if (!state || !state.overlay) return;
    const fsEl = document.fullscreenElement;
    const parent = (fsEl && fsEl.contains(state.video)) ? fsEl : document.body;
    if (state.overlay.parentElement !== parent) parent.appendChild(state.overlay);
  }

  function setSettingsOpen(open) {
    const panel = _state?.overlay?.querySelector('.beatbar-settings');
    if (panel) panel.hidden = !open;
    _state?.overlay?.querySelector('.beatbar-gear')?.classList.toggle('gear-open', open);
    document.getElementById('beatbarSettingsBtn')?.classList.toggle('gear-open', open);
  }

  function toggleSettingsPanel() {
    const panel = _state?.overlay?.querySelector('.beatbar-settings');
    if (panel) setSettingsOpen(panel.hidden);
  }

  function settingsPanelHtml() {
    const swatchRow = (cls, colors) => colors.map(c =>
      `<button class="bb-swatch ${cls}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('');
    const shapeBtns = SHAPES.map(s =>
      `<button class="bb-chip bb-shape-btn" data-shape="${s.id}" title="${s.id}">${s.glyph}</button>`).join('');
    const effectBtns = EFFECTS.map(e =>
      `<button class="bb-chip bb-effect-btn" data-effect="${e.id}" title="Toggle. Effects stack">${e.label}</button>`).join('') +
      `<button class="bb-chip bb-effect-off" title="Disable all effects">Off</button>`;

    return `
      <div class="beatbar-settings" hidden>
        <div class="bb-row"><span class="bb-lbl">Sensitivity</span>
          <input type="range" class="bb-sens" min="1" max="10" step="0.1">
          <span class="bb-num bb-sens-val"></span></div>
        <div class="bb-row"><span class="bb-lbl">Speed</span>
          <input type="range" class="bb-speed" min="2" max="10" step="0.5">
          <span class="bb-num bb-speed-val"></span></div>
        <div class="bb-row"><span class="bb-lbl">Nudge</span>
          <input type="range" class="bb-nudge" min="-500" max="500" step="10" title="Shift beat timing to match your audio/video delay">
          <span class="bb-num bb-nudge-val"></span></div>
        <div class="bb-row"><span class="bb-lbl">Playhead</span>
          <span class="bb-chips bb-playhead-btns">
            <button class="bb-chip" data-frac="0.1">10%</button>
            <button class="bb-chip" data-frac="0.25">25%</button>
            <button class="bb-chip" data-frac="0.5">50%</button>
          </span></div>
        <div class="bb-row"><span class="bb-lbl">Icon</span>
          <span class="bb-chips">${shapeBtns}</span></div>
        <div class="bb-row"><span class="bb-lbl">Effect</span>
          <span class="bb-chips">${effectBtns}</span></div>
        <div class="bb-row"><span class="bb-lbl">Fill</span>
          <span class="bb-swatches">${swatchRow('bb-fill-swatch', FILL_SWATCHES)}</span></div>
        <div class="bb-row"><span class="bb-lbl">Size</span>
          <input type="range" class="bb-fill-size" min="4" max="18" step="1">
          <span class="bb-num bb-size-val"></span></div>
        <div class="bb-row"><span class="bb-lbl">Opacity</span>
          <input type="range" class="bb-fill-opacity" min="0.2" max="1" step="0.05">
          <span class="bb-num bb-opacity-val"></span></div>
        <div class="bb-row"><span class="bb-lbl">Border</span>
          <span class="bb-swatches">${swatchRow('bb-border-swatch', BORDER_SWATCHES)}</span>
          <input type="range" class="bb-border-width" min="0" max="5" step="0.5" title="Border width">
        </div>
      </div>`;
  }

  function wireSettings(state, overlay) {
    const q = (sel) => overlay.querySelector(sel);
    const qa = (sel) => [...overlay.querySelectorAll(sel)];
    const sens = q('.bb-sens'), sensVal = q('.bb-sens-val');
    const speed = q('.bb-speed'), speedVal = q('.bb-speed-val');
    const nudge = q('.bb-nudge'), nudgeVal = q('.bb-nudge-val');
    const fillSize = q('.bb-fill-size'), sizeVal = q('.bb-size-val');
    const fillOpacity = q('.bb-fill-opacity'), opacityVal = q('.bb-opacity-val');
    const borderWidth = q('.bb-border-width');

    const syncChips = () => {
      qa('.bb-playhead-btns .bb-chip').forEach(b =>
        b.classList.toggle('active', Math.abs(parseFloat(b.dataset.frac) - config.playheadFrac) < 1e-6));
      qa('.bb-shape-btn').forEach(b => b.classList.toggle('active', b.dataset.shape === config.shape));
      qa('.bb-effect-btn').forEach(b => b.classList.toggle('active', !!config.effects[b.dataset.effect]));
      const noneOn = !config.effects.pulse && !config.effects.ripple && !config.effects.spark;
      q('.bb-effect-off')?.classList.toggle('active', noneOn);
      qa('.bb-fill-swatch').forEach(b => b.classList.toggle('active', b.dataset.color.toLowerCase() === config.fillColor.toLowerCase()));
      qa('.bb-border-swatch').forEach(b => b.classList.toggle('active', b.dataset.color.toLowerCase() === config.borderColor.toLowerCase()));
    };

    const fmtNudge = (ms) => ms === 0 ? '0ms' : (ms > 0 ? `+${ms}ms` : `${ms}ms`);

    // Seed controls from config
    sens.value = String(config.sensitivity); sensVal.textContent = Number(config.sensitivity).toFixed(1);
    speed.value = String(config.speed); speedVal.textContent = String(config.speed);
    nudge.value = String(Math.round((config.nudgeSec || 0) * 1000)); nudgeVal.textContent = fmtNudge(Math.round((config.nudgeSec || 0) * 1000));
    fillSize.value = String(config.fillSize); sizeVal.textContent = String(config.fillSize);
    fillOpacity.value = String(config.fillOpacity); opacityVal.textContent = Number(config.fillOpacity).toFixed(2);
    borderWidth.value = String(config.borderWidth);
    syncChips();

    // Live style / speed (drawBar reads config every frame)
    speed.addEventListener('input', () => { config.speed = parseFloat(speed.value); speedVal.textContent = speed.value; saveConfig(); });
    nudge.addEventListener('input', () => {
      const ms = parseFloat(nudge.value);
      config.nudgeSec = ms / 1000; nudgeVal.textContent = fmtNudge(ms); saveConfig();
    });
    fillSize.addEventListener('input', () => { config.fillSize = parseFloat(fillSize.value); sizeVal.textContent = fillSize.value; saveConfig(); });
    fillOpacity.addEventListener('input', () => { config.fillOpacity = parseFloat(fillOpacity.value); opacityVal.textContent = Number(fillOpacity.value).toFixed(2); saveConfig(); });
    borderWidth.addEventListener('input', () => { config.borderWidth = parseFloat(borderWidth.value); saveConfig(); });

    qa('.bb-playhead-btns .bb-chip').forEach(btn => btn.addEventListener('click', () => {
      config.playheadFrac = parseFloat(btn.dataset.frac); saveConfig(); syncChips();
    }));
    qa('.bb-shape-btn').forEach(btn => btn.addEventListener('click', () => {
      config.shape = btn.dataset.shape; saveConfig(); syncChips();
    }));
    qa('.bb-effect-btn').forEach(btn => btn.addEventListener('click', () => {
      const id = btn.dataset.effect;
      config.effects[id] = !config.effects[id]; // toggle — effects stack
      saveConfig(); syncChips();
    }));
    q('.bb-effect-off')?.addEventListener('click', () => {
      config.effects = { pulse: false, ripple: false, spark: false };
      saveConfig(); syncChips();
    });
    qa('.bb-fill-swatch').forEach(btn => btn.addEventListener('click', () => {
      config.fillColor = btn.dataset.color; saveConfig(); syncChips();
    }));
    qa('.bb-border-swatch').forEach(btn => btn.addEventListener('click', () => {
      config.borderColor = btn.dataset.color;
      if (!config.borderWidth) { config.borderWidth = 1.5; borderWidth.value = '1.5'; } // picking a colour implies wanting a border
      saveConfig(); syncChips();
    }));

    // Sensitivity → live label; re-detect only when the value settles
    sens.addEventListener('input', () => { sensVal.textContent = parseFloat(sens.value).toFixed(1); });
    sens.addEventListener('change', () => {
      config.sensitivity = parseFloat(sens.value); saveConfig();
      setStatus(state, 'Re-detecting…');
      loadBeats(state, { retune: true });
    });
  }

  function wireDrag(state, overlay) {
    // The whole bar is the drag handle — grab it anywhere to slide it up/down
    // (horizontal stays locked/centered). A small movement threshold keeps a
    // stray click from nudging it. Dragging writes config.posFrac directly
    // (bar center ÷ video height), so it's inherently %-based.
    const DRAG_THRESHOLD = 3;
    let dragging = false, moved = false, startY = 0;

    const onMove = (ev) => {
      if (!dragging) return;
      if (!moved && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
      moved = true;
      const rect = state.video.getBoundingClientRect();
      if (rect.height <= 0) return;
      config.posFrac = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      state._updatePos && state._updatePos();
    };
    const onUp = (ev) => {
      if (!dragging) return;
      dragging = false;
      try { overlay.releasePointerCapture(ev.pointerId); } catch {}
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      if (moved) saveConfig();
    };
    overlay.addEventListener('pointerdown', (e) => {
      // The gear / settings panel keep their own interactions
      if (e.target.closest('.beatbar-gear') || e.target.closest('.beatbar-settings')) return;
      e.preventDefault(); e.stopPropagation();
      dragging = true; moved = false; startY = e.clientY;
      try { overlay.setPointerCapture(e.pointerId); } catch {}
      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
    });
  }

  function resizeCanvas(state) {
    if (!state.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = state.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (state.canvas.width !== w || state.canvas.height !== h) {
      state.canvas.width = w;
      state.canvas.height = h;
      state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function setStatus(state, text) {
    if (state.statusEl) state.statusEl.textContent = text;
  }

  /* ── Render loop (rAF; drift-corrected time estimate for smoothness) ────── */

  function startRenderLoop(state) {
    const tick = (now) => {
      if (state.destroyed) return;
      updateSmoothTime(state, now);
      drawBar(state);
      state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
  }

  // The <video> only reports currentTime a few times a second, so we run our
  // own monotonic clock at frame rate and gently ease it toward the real time
  // (snapping only on seeks/stalls).
  function updateSmoothTime(state, nowPerf) {
    const v = state.video;
    const rate = v.playbackRate || 1;
    if (v.paused || v.seeking) {
      state.smoothTime = v.currentTime;
      state.lastPerf = nowPerf;
      return;
    }
    if (state.lastPerf == null) {
      state.smoothTime = v.currentTime;
      state.lastPerf = nowPerf;
      return;
    }
    const dt = (nowPerf - state.lastPerf) / 1000;
    state.lastPerf = nowPerf;
    state.smoothTime += dt * rate;

    const drift = v.currentTime - state.smoothTime;
    if (Math.abs(drift) > 0.35) {
      state.smoothTime = v.currentTime;     // seek / big stall → snap
    } else {
      state.smoothTime += drift * 0.08;     // ease out small drift, no visible jump
    }
    if (v.duration && state.smoothTime > v.duration) state.smoothTime = v.duration;
  }

  function drawBar(state) {
    const ctx = state.ctx;
    const canvas = state.canvas;
    if (!ctx || !canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderBarFrame(ctx, w, h, state.smoothTime, state.beats, config);
  }

  // Pure frame painter — everything drawBar showed, from explicit inputs only.
  // The live overlay AND the export baker (renderOverlayPngStream) both call
  // this, so a baked bar is pixel-identical to the one on screen.
  function renderBarFrame(ctx, w, h, t, beats, cfg) {
    ctx.clearRect(0, 0, w, h);

    // Background card
    const pad = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(pad, pad, w - pad * 2, h - pad * 2, 8);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(pad + 8, h / 2);
    ctx.lineTo(w - pad - 8, h / 2);
    ctx.stroke();

    if (!beats.length) return;

    // Clip everything that moves (playhead + icons + effects) to the card so
    // nothing spills past the rounded edges of the bar UI.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(pad, pad, w - pad * 2, h - pad * 2, 8);
    ctx.clip();

    const playheadFrac = cfg.playheadFrac || 0.5;
    const lookahead = lookaheadFor(cfg);
    const playheadX = w * playheadFrac;
    const lookbehind = lookahead * (playheadFrac / (1 - playheadFrac));
    const pxPerSec = (w - playheadX) / lookahead;

    const shape = cfg.shape || 'circle';
    const effects = cfg.effects || DEFAULT_CONFIG.effects;
    const anyEffect = effects.pulse || effects.ripple || effects.spark;
    const fillColor = cfg.fillColor || '#7aa8ff';
    const rgb = hexToRgb(fillColor);
    const fillOpacity = cfg.fillOpacity == null ? 1 : cfg.fillOpacity;
    const borderWidth = cfg.borderWidth || 0;
    const borderColor = cfg.borderColor || '#ffffff';
    const baseR = Math.max(3, cfg.fillSize || 9);
    const pulseR = baseR + Math.max(8, baseR * 1.2);
    const nudgeSec = cfg.nudgeSec || 0; // user AV-sync offset; +later / -earlier

    // Playhead
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(playheadX, 6); ctx.lineTo(playheadX, h - 6); ctx.stroke();

    // First visible beat (binary search). Search against raw beat times, so
    // offset the window by -nudgeSec to account for the shift applied below.
    const firstT = t - lookbehind - 0.2 - nudgeSec;
    let lo = 0, hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < firstT) lo = mid + 1; else hi = mid;
    }

    for (let i = lo; i < beats.length; i++) {
      const dt = (beats[i] + nudgeSec) - t;
      if (dt > lookahead + 0.2) break;

      const x = playheadX + dt * pxPerSec;
      const y = h / 2;

      let fade = 1;
      if (dt < 0) {
        fade = 1 - Math.min(1, -dt / PAST_FADE_SEC);
        if (fade <= 0) continue;
      }

      // Envelope for THIS beat. phase = seconds relative to the nudged beat
      // moment (0 = peak, which lands BEAT_NUDGE_SEC before the beat reaches
      // the line). One `k` drives icon size AND every effect, so they stay in
      // step. Speed-independent in time: the hit peaks at the same instant
      // regardless of scroll speed, it just travels fewer/more pixels.
      const phase = t - (beats[i] + nudgeSec - BEAT_NUDGE_SEC);
      const k = beatEnvelope(phase);
      let radius = baseR;
      // Only the pulse effect grows the icon itself; the others radiate around it
      if (k > 0 && effects.pulse) radius = baseR + k * (pulseR - baseR);

      if (k > 0 && anyEffect) {
        const pulse = effects.spark ? { sparks: makeSparks(i) } : null;
        drawEffects(ctx, effects, shape, x, y, effects.pulse ? radius : baseR, k, rgb, fade, pulse);
      }

      // // Drop line to the bottom of the bar
      // ctx.save();
      // ctx.globalAlpha = fade * 0.4;
      // ctx.strokeStyle = fillColor;
      // ctx.lineWidth = 1.5;
      // ctx.beginPath(); ctx.moveTo(x, y + radius + 3); ctx.lineTo(x, h - 6); ctx.stroke();
      // ctx.restore();

      // Icon (fill + border)
      traceShape(ctx, shape, x, y, radius);
      ctx.globalAlpha = fade * fillOpacity;
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.globalAlpha = fade;
      if (borderWidth > 0) {
        ctx.lineWidth = borderWidth;
        ctx.strokeStyle = borderColor;
      } else {
        ctx.lineWidth = 1;                 // auto hairline for legibility on bright video
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore(); // end clip
  }

  /* ── Attach / detach ───────────────────────────────────────────────────── */

  async function attach(mediaItem, videoEl = null) {
    detach();
    // Default target is the main player; the Editor passes its own <video>
    // (stack/grid master) so the bar rides on top of the mix stage.
    const video = videoEl || document.querySelector('#mediaPlayerContent video');
    if (!video || !mediaItem?.id) return;

    const state = {
      video, mediaId: mediaItem.id,
      beats: [], bpm: 0,
      filtered: null, worker: null,
      smoothTime: 0, lastPerf: null,
      overlay: null, canvas: null, ctx: null, statusEl: null,
      rafId: null, ro: null, _posInterval: null, _statusTimer: null,
      _outsideClose: null, destroyed: false,
    };
    _state = state;

    createOverlay(state);
    startRenderLoop(state);
    loadBeats(state);
  }

  function detach() {
    const state = _state;
    if (!state) return;
    _state = null;
    state.destroyed = true;
    try { state.abort?.abort(); } catch {}
    cleanupWorker(state);
    if (state.rafId) cancelAnimationFrame(state.rafId);
    if (state.ro) try { state.ro.disconnect(); } catch {}
    if (state._posInterval) clearInterval(state._posInterval);
    if (state._statusTimer) clearTimeout(state._statusTimer);
    if (state._updatePos) window.removeEventListener('resize', state._updatePos);
    if (state._outsideClose) document.removeEventListener('pointerdown', state._outsideClose, true);
    state.overlay?.remove();
    document.getElementById('beatbarSettingsBtn')?.classList.remove('gear-open');
  }

  /* ── Toggle + settings buttons + player integration ────────────────────── */

  /**
   * Headless beats loader (Lovense sync, or anything that needs beat times
   * without the visual bar). Same cache + detection pipeline as the overlay,
   * so the bar and any consumer are in lockstep by construction.
   * @returns {Promise<{beats:number[], bpm:number}>}
   */
  async function ensureBeats(mediaItem) {
    if (!mediaItem?.id) throw new Error('media item required');
    const cached = cacheGet(mediaItem.id);
    if (cached) return { beats: cached.beats, bpm: cached.bpm };

    const resp = await fetch(`/api/media/${mediaItem.id}/beat-audio`);
    if (!resp.ok) throw new Error(`audio extraction failed (${resp.status})`);
    const filtered = await renderFiltered(await resp.arrayBuffer());
    const { beats, bpm } = detectFromFiltered(filtered);
    cacheSet(mediaItem.id, beats, bpm);
    return { beats, bpm };
  }

  /* ── Export baking (Editor mix export) ──────────────────────────────────
     The exporter snapshots the bar the moment the user hits "Start export";
     later settings changes never touch a queued render. The client renders
     the overlay itself (same renderBarFrame as the live bar → identical
     pixels) into a PNG frame stream that ffmpeg composites server-side. */

  /**
   * Freeze everything the export needs: beat times (in the ridden video's
   * time base), a deep config copy, and the bar's on-screen geometry as
   * fractions of the video frame (so the bake lands where the user sees it).
   * @returns {null | {mediaId, beats:number[], config:object, yFrac, hFrac}}
   */
  function exportSnapshot() {
    const state = _state;
    if (!state || !state.beats.length || !state.overlay || !state.video) return null;
    const vRect = state.video.getBoundingClientRect();
    const oRect = state.overlay.getBoundingClientRect();
    if (vRect.height < 1) return null;
    return {
      mediaId: state.mediaId,
      beats: state.beats.slice(),
      config: JSON.parse(JSON.stringify(config)),
      yFrac: (oRect.top - vRect.top) / vRect.height,
      hFrac: BAR_HEIGHT / vRect.height,
    };
  }

  /**
   * Offline-render the bar to a single Blob of back-to-back PNG frames —
   * exactly what ffmpeg's image2pipe demuxer eats. Rendered at the export's
   * pixel size so the server composites 1:1 with no scaling.
   * Note: spark layouts are seeded by beat index, so a bake whose beat list
   * was offset/trimmed draws different (still deterministic) spark spreads
   * than the live bar — same shapes, sizes and timing.
   * @param {{beats:number[], config:object, width:number, height:number,
   *          fps:number, durationSec:number, onProgress?:(p:number)=>void}} o
   * @returns {Promise<Blob>}
   */
  async function renderOverlayPngStream({ beats, config: cfg, width, height, fps, durationSec, onProgress }) {
    const scale = height / BAR_HEIGHT;      // renderBarFrame paints a 120-tall logical bar
    const logicalW = width / scale;
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d');
    const total = Math.max(1, Math.ceil(durationSec * fps));
    const parts = [];
    for (let f = 0; f < total; f++) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      renderBarFrame(ctx, logicalW, BAR_HEIGHT, f / fps, beats, cfg);
      parts.push(canvas.convertToBlob
        ? await canvas.convertToBlob({ type: 'image/png' })
        : await new Promise((res) => canvas.toBlob(res, 'image/png')));
      if (onProgress && f % 10 === 0) onProgress(f / total);
    }
    if (onProgress) onProgress(1);
    return new Blob(parts, { type: 'application/octet-stream' });
  }

  // Editor integration: attach the bar to any video element (stack/grid
  // master). Same beats cache, settings, and overlay as the main player.
  window.BeatBar = {
    attach,
    detach,
    isEnabled,
    isAttached: () => !!_state,
    attachedTo: () => _state?.video || null,
    ensureBeats,
    exportSnapshot,
    renderOverlayPngStream,
  };

  function toggleBeatBar() {
    const on = !isEnabled();
    localStorage.setItem(LS_ENABLED, on ? '1' : '0');
    syncButton();
    const media = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
    if (on && media?.media_type === 'video') {
      const item = allMedia.find(m => m.filepath === media.filepath);
      attach(item || media);
      showToast('🥁 Beat bar ON, stays on for future videos');
    } else {
      detach();
      if (!on) showToast('Beat bar off');
    }
  }
  window.toggleBeatBar = toggleBeatBar;

  // Settings button in the control bar — toggles the panel. If the bar isn't
  // running yet, turn it on first so there's something to preview.
  function openBeatBarSettings() {
    if (!_state) {
      if (!isEnabled()) localStorage.setItem(LS_ENABLED, '1');
      syncButton();
      const media = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
      const item = media && allMedia.find(m => m.filepath === media.filepath);
      if (item) attach(item);
      setSettingsOpen(true);
      return;
    }
    toggleSettingsPanel();
  }
  window.openBeatBarSettings = openBeatBarSettings;

  function buttonTitle(on) {
    return on
      ? 'Beat bar is ON. Click to turn off'
      : 'Beat bar is OFF. Click to turn on (stays on for future videos)';
  }

  /* Markup for the two extras-row buttons, already in their final state.
     The player renders this with the rest of its chrome so the row has its
     final geometry in the very first frame after a file change — buttons that
     arrive a tick later shove the whole control row sideways, which is
     miserable to watch on a stream. Only classes and label text ever change
     afterwards; CSS pins the widths so those can't move anything either. */
  function renderButtons() {
    const on = isEnabled();
    return `<button id="beatbarBtn" class="nav-btn beatbar-toggle${on ? ' beatbar-btn-on' : ''}"
        onclick="toggleBeatBar()" title="${buttonTitle(on)}"
      ><span class="nav-icon">🥁</span><span class="beatbar-state">${on ? 'ON' : 'OFF'}</span></button>
      <button id="beatbarSettingsBtn" class="nav-btn beatbar-settings-btn"
        onclick="openBeatBarSettings()" title="Beat bar settings"
      ><span class="nav-icon">⚙</span></button>`;
  }
  window.renderBeatBarButtons = renderButtons;

  function syncButton() {
    const btn = document.getElementById('beatbarBtn');
    if (!btn) return;
    const on = isEnabled();
    btn.classList.toggle('beatbar-btn-on', on);
    const stateEl = btn.querySelector('.beatbar-state');
    if (stateEl) stateEl.textContent = on ? 'ON' : 'OFF';
    btn.title = buttonTitle(on);
  }

  /* Safety net for players that don't render the buttons themselves (and for
     any re-render that drops them). The video player supplies them up front,
     so this normally finds them already in place and only syncs the state. */
  function injectButtons() {
    // Live in the extras row (next to speed, between play row and nav bar) —
    // keeps Prev/Random/Info/Next in a fixed spot across media types
    const center = document.querySelector('.video-extras-row .pr-center');
    if (!center) return;
    if (!document.getElementById('beatbarBtn')) center.insertAdjacentHTML('beforeend', renderButtons());
    syncButton();
  }

  // Follow the video into / out of native fullscreen without tearing down
  // (beats and settings are preserved — only the DOM parent changes).
  document.addEventListener('fullscreenchange', () => {
    if (!_state) return;
    placeOverlay(_state);
    requestAnimationFrame(() => _state && _state._updatePos && _state._updatePos());
  });

  document.addEventListener('DOMContentLoaded', () => {
    const orig = playMedia;
    playMedia = function (mediaData, ...rest) {
      // ...rest forwards playMedia's options (the hands-free source flag).
      orig(mediaData, ...rest);
      detach();
      if (mediaData?.media_type === 'video') {
        injectButtons();
        if (isEnabled()) {
          const item = allMedia.find(m => m.filepath === mediaData.filepath);
          if (item) attach(item);
        }
      }
    };

    const observer = new MutationObserver(() => {
      const overlay = document.getElementById('mediaPlayerOverlay');
      if (_state && overlay && !overlay.classList.contains('active')) detach();
    });
    const overlay = document.getElementById('mediaPlayerOverlay');
    if (overlay) observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });
})();
