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

   Modern look (isModernLayout()): a 64 px frosted "glass lane" instead of
   the card (renderGlassFrame, live only; exports keep renderBarFrame). The
   grip, BPM and gear show only while the mouse is over it. Drag it up or
   down anywhere; drag the grip sideways to resize it about the centre
   (config.widthFrac). Px per second stay fixed by Speed, so a wider lane
   shows more time (player-lib/beatbar-geometry.js). Its own settings panel
   (css/beatbar-modern.css) uses the same config keys. Switching looks
   rebuilds the overlay in place, beats and all. The glass lane is for the
   main player only: a bar attached to another video (the Editor) stays the
   classic card, which is what its export bakes.

   Needs player-lib/beatbar-geometry.js loaded first (db-viewer.html): the
   Modern maths and the stored config shape (storedConfig /
   fillColorFromStored) live there so Node tests can load them.
   ========================================================================= */

(function () {
  const G = window.BeatBarGeom;

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
    // null = never picked: the look's own default (fillColorOf). A colour
    // anyone saved is kept as it is in both looks.
    fillColor: null,
    fillSize: 9,           // base dot radius (px)
    fillOpacity: 1.0,      // 0.2–1
    borderColor: '#ffffff',
    borderWidth: 0,        // 0 = auto dark hairline for contrast
    // Modern lane width as a fraction of the video width (null = 56%).
    widthFrac: null,
  };

  const CLASSIC_FILL = '#7aa8ff';
  const MODERN_FILL = '#a5b4fc';
  const MODERN_FILL_SWATCHES = [MODERN_FILL, ...FILL_SWATCHES];
  const GLASS_BLUR_PX = 2.5;                    // the lane's frost: barely there
  const GLASS_TINT = 'rgba(16,16,22,0.13)';     // over the blurred picture
  const LANE_RADIUS = 12;                       // rounded rect like the app's cards (css/beatbar-modern.css)

  let _state = null; // one active attachment at a time (single player)

  const isEnabled = () => localStorage.getItem(LS_ENABLED) === '1';
  const isModern = () => typeof window.isModernLayout === 'function' && window.isModernLayout();
  const fillColorOf = (cfg, modern = isModern()) => cfg.fillColor || (modern ? MODERN_FILL : CLASSIC_FILL);

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
      // "Never picked a colour" is stored as the classic blue plus a flag,
      // so older builds reading this blob always find a colour string.
      cfg.fillColor = G.fillColorFromStored(raw, CLASSIC_FILL);
      delete cfg.fillColorAuto;
      return cfg;
    }
    catch { return { ...DEFAULT_CONFIG }; }
  }
  function saveConfig() {
    try { localStorage.setItem(LS_CONFIG, JSON.stringify(G.storedConfig(config, CLASSIC_FILL))); } catch {}
  }
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

  // v2: the streaming worker's beats moved ~46 ms earlier (AAC priming no
  // longer counted, peaks placed between envelope frames), so beats cached
  // before that are stale. Old-format keys are dropped once on load.
  const BEATS_CACHE_VER = 'v2_';
  function beatCacheKey(id) { return `${LS_BEATS_PREFIX}${BEATS_CACHE_VER}${id}_s${Number(config.sensitivity).toFixed(1)}`; }
  try {
    Object.keys(localStorage)
      .filter(k => k.startsWith(LS_BEATS_PREFIX) && !k.startsWith(LS_BEATS_PREFIX + BEATS_CACHE_VER))
      .forEach(k => localStorage.removeItem(k));
  } catch {}

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
      if (!state.destroyed) {
        setStatus(state, typeof friendlyError === 'function'
          ? `Beat bar: ${friendlyError(err, 'finding the beats')}` : `Beat bar: ${err.message}`);
      }
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
    state.modern = wantsModern(state);
    if (state.modern) return createModernOverlay(state);
    const overlay = document.createElement('div');
    overlay.className = 'beatbar-overlay';
    overlay.innerHTML = `
      <canvas class="beatbar-canvas"></canvas>
      <div class="beatbar-status"></div>
      <button class="beatbar-gear" title="Beat bar settings" aria-label="Beat bar settings">${glyph('⚙', 'gear')}</button>
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

  const settingsPanel = () => _state?.overlay?.querySelector('.beatbar-settings, .bbm-settings') || null;

  // `from` / `opts` only matter in Modern: 'bar' = the lane's own gear,
  // 'menu' = the player's gear menu (back arrow, anchored above the dock).
  function setSettingsOpen(open, from = 'bar', opts = {}) {
    const panel = settingsPanel();
    if (panel) panel.hidden = !open;
    _state?.overlay?.querySelector('.beatbar-gear')?.classList.toggle('gear-open', open);
    document.getElementById('beatbarSettingsBtn')?.classList.toggle('gear-open', open);
    if (_state?.modern) modernPanelOpened(_state, open, from, opts);
  }

  function toggleSettingsPanel(from, opts) {
    const panel = settingsPanel();
    if (panel) setSettingsOpen(panel.hidden, from, opts);
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
      qa('.bb-fill-swatch').forEach(b => b.classList.toggle('active', b.dataset.color.toLowerCase() === fillColorOf(config, !!state.modern).toLowerCase()));
      qa('.bb-border-swatch').forEach(b => b.classList.toggle('active', b.dataset.color.toLowerCase() === config.borderColor.toLowerCase()));
    };

    // The Modern panel reuses this wiring (same classes, same config keys);
    // only its value labels read differently.
    const modern = overlay.classList.contains('bb-modern');
    const borderVal = q('.bb-border-val');
    const fmtNudge = modern
      ? (ms) => ms === 0 ? '0 ms' : (ms > 0 ? `+${ms} ms` : `${ms} ms`)
      : (ms) => ms === 0 ? '0ms' : (ms > 0 ? `+${ms}ms` : `${ms}ms`);
    const fmtOpacity = modern ? (v) => `${Math.round(v * 100)}%` : (v) => Number(v).toFixed(2);
    const fmtBorder = (v) => (Number(v) > 0 ? String(v) : 'Auto');

    // Seed controls from config (again after a Reset)
    const seed = () => {
      sens.value = String(config.sensitivity); sensVal.textContent = Number(config.sensitivity).toFixed(1);
      speed.value = String(config.speed); speedVal.textContent = String(config.speed);
      nudge.value = String(Math.round((config.nudgeSec || 0) * 1000)); nudgeVal.textContent = fmtNudge(Math.round((config.nudgeSec || 0) * 1000));
      fillSize.value = String(config.fillSize); sizeVal.textContent = String(config.fillSize);
      fillOpacity.value = String(config.fillOpacity); opacityVal.textContent = fmtOpacity(config.fillOpacity);
      borderWidth.value = String(config.borderWidth);
      if (borderVal) borderVal.textContent = fmtBorder(config.borderWidth);
      syncChips();
    };
    seed();
    state._seedSettings = seed;

    // Live style / speed (drawBar reads config every frame)
    speed.addEventListener('input', () => { config.speed = parseFloat(speed.value); speedVal.textContent = speed.value; saveConfig(); });
    nudge.addEventListener('input', () => {
      const ms = parseFloat(nudge.value);
      config.nudgeSec = ms / 1000; nudgeVal.textContent = fmtNudge(ms); saveConfig();
    });
    fillSize.addEventListener('input', () => { config.fillSize = parseFloat(fillSize.value); sizeVal.textContent = fillSize.value; saveConfig(); });
    fillOpacity.addEventListener('input', () => { config.fillOpacity = parseFloat(fillOpacity.value); opacityVal.textContent = fmtOpacity(fillOpacity.value); saveConfig(); });
    borderWidth.addEventListener('input', () => {
      config.borderWidth = parseFloat(borderWidth.value);
      if (borderVal) borderVal.textContent = fmtBorder(config.borderWidth);
      saveConfig();
    });

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
      if (!config.borderWidth) { // picking a colour implies wanting a border
        config.borderWidth = 1.5; borderWidth.value = '1.5';
        if (borderVal) borderVal.textContent = fmtBorder(1.5);
      }
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

  /* ── Modern overlay: glass lane + its own settings panel ───────────────
     Same overlay element (so fullscreen, detach, export snapshot all work
     as before) holding the lane and a fixed-position panel. Every rule that
     styles it lives in css/beatbar-modern.css under body.layout-modern. */

  const svgIcon = (inner, cls = '') => `<svg class="bbm-svg ${cls}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
  const GRIP_SVG = svgIcon('<circle cx="9" cy="7" r="1.1"/><circle cx="15" cy="7" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="17" r="1.1"/><circle cx="15" cy="17" r="1.1"/>', 'bbm-dots');
  const BACK_SVG = svgIcon('<path d="M15 6l-6 6 6 6"/>');
  const CHEVRON_SVG = svgIcon('<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>', 'bbm-chev');
  const gearIcon = () => (typeof vaultIcon === 'function' && vaultIcon('gear')) ||
    svgIcon('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/>');
  const SHAPE_SVGS = {
    circle: '<circle cx="12" cy="12" r="7"/>',
    heart: '<path d="M12 19s-7-4.2-7-9.3A3.8 3.8 0 0 1 12 7.4a3.8 3.8 0 0 1 7 2.3C19 14.8 12 19 12 19z"/>',
    square: '<rect x="5.5" y="5.5" width="13" height="13" rx="3"/>',
    diamond: '<rect x="7" y="7" width="10" height="10" rx="2" transform="rotate(45 12 12)"/>',
    star: '<path d="M12 4.5l2.3 4.7 5.2.8-3.8 3.6.9 5.1L12 16.3l-4.6 2.4.9-5.1L4.5 10l5.2-.8z"/>',
  };
  const SHAPE_NAMES = { circle: 'Circle', heart: 'Heart', square: 'Square', diamond: 'Diamond', star: 'Star' };

  function modernPanelHtml() {
    const row = (label, control) => `<div class="bbm-row"><span class="bbm-lbl">${label}</span>${control}</div>`;
    const range = (cls, min, max, step, valCls, title = '') =>
      `<input type="range" class="${cls}" min="${min}" max="${max}" step="${step}"${title ? ` title="${title}"` : ''}><span class="bbm-val ${valCls}"></span>`;
    const swatches = (cls, colors) => `<span class="bbm-swatches">${colors.map(c =>
      `<button type="button" class="bb-swatch ${cls}" data-color="${c}" style="background:${c}" title="${c}" aria-label="Colour ${c}"></button>`).join('')}</span>`;
    const shapes = SHAPES.map(s =>
      `<button type="button" class="bb-shape-btn" data-shape="${s.id}" title="${SHAPE_NAMES[s.id]}" aria-label="${SHAPE_NAMES[s.id]}">${svgIcon(SHAPE_SVGS[s.id], 'bbm-solid')}</button>`).join('');
    const effects = EFFECTS.map(e =>
      `<button type="button" class="bb-chip bb-effect-btn" data-effect="${e.id}" title="Click to turn on or off. They can be combined">${e.label}</button>`).join('');
    return `
      <div class="bbm-settings" hidden role="dialog" aria-label="Beat bar settings">
        <div class="bbm-hdr">
          <button type="button" class="bbm-icon bbm-back" title="Back" aria-label="Back" hidden>${BACK_SVG}</button>
          <span class="bbm-title">Beat bar</span>
          <button type="button" class="bbm-link bbm-reset" title="Put timing and look back to the defaults">Reset</button>
        </div>
        <div class="bbm-prev" hidden><canvas></canvas></div>
        <div class="bbm-body">
          <div class="bbm-sh">Timing</div>
          ${row('Sensitivity', range('bb-sens', 1, 10, 0.1, 'bb-sens-val', 'Higher finds more beats'))}
          ${row('Speed', range('bb-speed', 2, 10, 0.5, 'bb-speed-val', 'How fast the beats move'))}
          ${row('Nudge', range('bb-nudge', -500, 500, 10, 'bb-nudge-val', 'Move the beats earlier or later to match your audio'))}
          ${row('Playhead', `<span class="bbm-seg bb-playhead-btns">
              <button type="button" class="bb-chip" data-frac="0.1">Left</button>
              <button type="button" class="bb-chip" data-frac="0.25">Quarter</button>
              <button type="button" class="bb-chip" data-frac="0.5">Middle</button></span>`)}
          <div class="bbm-sh bbm-look">Look</div>
          <div class="bbm-looks">
            ${row('Shape', `<span class="bbm-shapes">${shapes}</span>`)}
            ${row('Effects', `<span class="bbm-chips">${effects}</span>`)}
            ${row('Colour', swatches('bb-fill-swatch', MODERN_FILL_SWATCHES))}
            ${row('Size', range('bb-fill-size', 4, 18, 1, 'bb-size-val'))}
            ${row('Opacity', range('bb-fill-opacity', 0.2, 1, 0.05, 'bb-opacity-val'))}
          </div>
        </div>
        <button type="button" class="bbm-more-toggle" aria-expanded="false"><span>More</span>${CHEVRON_SVG}</button>
        <div class="bbm-more" hidden>
          <div class="bbm-looks">
            ${row('Outline', swatches('bb-border-swatch', BORDER_SWATCHES))}
            ${row('Outline width', range('bb-border-width', 0, 5, 0.5, 'bb-border-val', 'Auto draws a thin dark edge'))}
          </div>
          <button type="button" class="bbm-wide bbm-resetpos">Reset position and width</button>
        </div>
      </div>`;
  }

  function createModernOverlay(state) {
    const G = window.BeatBarGeom;
    const overlay = document.createElement('div');
    overlay.className = 'beatbar-overlay bb-modern';
    overlay.innerHTML = `
      <div class="bbm-lane">
        <canvas class="beatbar-canvas"></canvas>
        <span class="bbm-grip" title="Drag up or down to move. Drag sideways to make it wider or narrower">${GRIP_SVG}</span>
        <span class="bbm-bpm"></span>
        <span class="beatbar-status"></span>
        <button type="button" class="beatbar-gear bbm-gear" title="Beat bar settings" aria-label="Beat bar settings">${gearIcon()}</button>
      </div>
      ${modernPanelHtml()}
    `;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    state.canvas = overlay.querySelector('.beatbar-canvas');
    state.ctx = state.canvas.getContext('2d');
    state.statusEl = overlay.querySelector('.beatbar-status');
    state.bpmEl = overlay.querySelector('.bbm-bpm');
    state.panel = overlay.querySelector('.bbm-settings');
    state.prevWrap = overlay.querySelector('.bbm-prev');
    state.prevCanvas = state.prevWrap.querySelector('canvas');
    state._bpmShown = null;
    state._prevShown = null;
    const lane = overlay.querySelector('.bbm-lane');
    const panel = state.panel;

    overlay.querySelector('.bbm-gear').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsPanel('bar');
    });
    wireSettings(state, overlay);
    wireModernPanel(state, panel);
    wireModernDrag(state, lane);

    state._outsideClose = (e) => {
      if (panel.hidden) return;
      if (e.target.closest('.bbm-settings') || e.target.closest('.bbm-gear')) return;
      setSettingsOpen(false);
    };
    document.addEventListener('pointerdown', state._outsideClose, true);
    // Esc closes the panel first (and only the panel, not the player)
    state._keyClose = (e) => {
      if (e.key !== 'Escape' || panel.hidden) return;
      e.preventDefault(); e.stopPropagation();
      setSettingsOpen(false);
    };
    document.addEventListener('keydown', state._keyClose, true);

    const updatePos = () => {
      if (state.destroyed) return;
      const v = state.video;
      if (!v.isConnected) { detach(); return; }
      const rect = v.getBoundingClientRect();
      if (rect.width < 50 || rect.height < 50) {
        overlay.style.display = 'none';
        return;
      }
      // Taller lane for bigger icons / effects (never clipped); posFrac is
      // the lane's centre, so a height change keeps it centred where it was.
      state._laneH = G.laneHeight(config);
      const box = G.laneBox({ rect, widthFrac: config.widthFrac, posFrac: config.posFrac, laneH: state._laneH });
      state.videoW = rect.width;
      // Where the picture sits relative to the lane, for the blurred backdrop
      const pic = G.displayedVideoRect(rect, v.videoWidth, v.videoHeight, getComputedStyle(v).objectFit);
      state._backdrop = pic && { x: pic.left - box.left, y: pic.top - box.top, w: pic.width, h: pic.height };
      overlay.style.display = '';
      overlay.style.left = `${box.left}px`;
      overlay.style.top = `${box.top}px`;
      overlay.style.width = `${box.width}px`;
      overlay.style.height = `${box.height}px`;
      resizeCanvas(state);
      placeModernPanel(state);
    };
    state._updatePos = updatePos;

    placeOverlay(state);
    updatePos();
    state.ro = new ResizeObserver(updatePos);
    try { state.ro.observe(state.video); } catch {}
    window.addEventListener('resize', updatePos, { passive: true });
    state._posInterval = setInterval(updatePos, 1000);
  }

  function wireModernPanel(state, panel) {
    const q = (sel) => panel.querySelector(sel);
    q('.bbm-back').addEventListener('click', () => {
      const opts = state.panelOpts || {};
      setSettingsOpen(false);
      // Only shown when the opener passed onBack (the player's gear menu,
      // which reopens itself)
      if (typeof opts.onBack === 'function') opts.onBack();
    });
    q('.bbm-reset').addEventListener('click', () => {
      const oldSens = config.sensitivity;
      config = {
        ...DEFAULT_CONFIG, effects: { ...DEFAULT_CONFIG.effects },
        posFrac: config.posFrac, widthFrac: config.widthFrac,   // "Reset position and width" is its own button
      };
      saveConfig();
      state._seedSettings && state._seedSettings();
      if (config.sensitivity !== oldSens) {
        setStatus(state, 'Re-detecting…');
        loadBeats(state, { retune: true });
      }
    });
    const moreBtn = q('.bbm-more-toggle'), more = q('.bbm-more');
    moreBtn.addEventListener('click', () => {
      more.hidden = !more.hidden;
      moreBtn.setAttribute('aria-expanded', String(!more.hidden));
      panel.classList.toggle('bbm-more-open', !more.hidden);
    });
    q('.bbm-resetpos').addEventListener('click', () => {
      config.posFrac = null;
      config.widthFrac = null;
      saveConfig();
      state._updatePos && state._updatePos();
    });
  }

  function wireModernDrag(state, lane) {
    // Anywhere on the lane: drag up / down (horizontal stays centred). On the
    // grip, the first clear movement picks the axis: sideways resizes the lane
    // about its centre (away from the centre = wider), up / down moves it.
    const G = window.BeatBarGeom;
    const DRAG_THRESHOLD = 3;
    let drag = null;

    const onMove = (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (!drag.axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD) return;
        drag.axis = drag.grip && Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        state.overlay.classList.add('bbm-dragging', drag.axis === 'x' ? 'bbm-resizing' : 'bbm-moving');
      }
      const rect = state.video.getBoundingClientRect();
      if (drag.axis === 'x') {
        config.widthFrac = G.widthAfterGripDrag(drag.width, dx, rect.width);
      } else {
        // Keep the spot under the pointer where it was grabbed (no jump)
        const f = G.posFracFromPointer(ev.clientY - drag.offset, rect);
        if (f != null) config.posFrac = f;
      }
      state._updatePos && state._updatePos();
    };
    const onUp = (ev) => {
      if (!drag) return;
      const moved = !!drag.axis;
      drag = null;
      try { lane.releasePointerCapture(ev.pointerId); } catch {}
      lane.removeEventListener('pointermove', onMove);
      lane.removeEventListener('pointerup', onUp);
      lane.removeEventListener('pointercancel', onUp);
      state.overlay?.classList.remove('bbm-dragging', 'bbm-resizing', 'bbm-moving');
      if (moved) saveConfig();
    };
    lane.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.bbm-gear')) return;
      e.preventDefault(); e.stopPropagation();
      const r = lane.getBoundingClientRect();
      drag = {
        x: e.clientX, y: e.clientY, axis: null,
        grip: !!e.target.closest('.bbm-grip'),
        width: G.clampWidthFrac(config.widthFrac),
        offset: e.clientY - (r.top + r.height / 2),
      };
      try { lane.setPointerCapture(e.pointerId); } catch {}
      lane.addEventListener('pointermove', onMove);
      lane.addEventListener('pointerup', onUp);
      lane.addEventListener('pointercancel', onUp);
    });
  }

  function modernPanelOpened(state, open, from, opts) {
    state.overlay.classList.toggle('bbm-open', open);
    if (!open) return;
    state.panelFrom = from;
    state.panelOpts = opts || {};
    const back = state.panel.querySelector('.bbm-back');
    if (back) back.hidden = typeof state.panelOpts.onBack !== 'function';
    state._prevShown = null;
    syncPreview(state, performance.now());
    placeModernPanel(state);
  }

  // Above the lane's gear, or (from the player's gear menu) above the given
  // anchor / the dock's right end. Bottom-anchored so it grows upward when
  // the preview or "More" opens.
  function placeModernPanel(state) {
    const panel = state.panel;
    if (!panel || panel.hidden || !state.overlay || !window.BeatBarGeom) return;
    let anchor;
    if (state.panelFrom === 'menu') {
      const el = state.panelOpts?.anchor;
      const a = el && el.isConnected ? el.getBoundingClientRect() : null;
      if (a && a.width) anchor = a;
      else {
        const v = state.video.getBoundingClientRect();
        const y = v.bottom - 96;   // just above the dock
        anchor = { top: y, bottom: y, right: v.right - 16 };
      }
    } else {
      const lane = state.overlay.getBoundingClientRect();
      const gear = state.overlay.querySelector('.bbm-gear').getBoundingClientRect();
      anchor = { top: lane.top, bottom: lane.bottom, right: gear.right + 6 };
    }
    const p = window.BeatBarGeom.panelPlace({
      anchor, vw: window.innerWidth, vh: window.innerHeight,
      panelW: panel.offsetWidth || 380, panelH: panel.scrollHeight,
    });
    panel.style.right = `${p.right}px`;
    panel.style.bottom = p.bottom == null ? 'auto' : `${p.bottom}px`;
    panel.style.top = p.top == null ? 'auto' : `${p.top}px`;
    panel.style.maxHeight = `${p.maxHeight}px`;
  }

  // Per frame while Modern: the hover BPM label, and the settings preview
  // lane, which shows only while the video is paused (while playing, the real
  // bar is right there).
  function modernTick(state, nowPerf) {
    const bpmText = state.bpm > 0 ? `${Math.round(state.bpm)} BPM` : '';
    if (bpmText !== state._bpmShown) { state.bpmEl.textContent = bpmText; state._bpmShown = bpmText; }
    // Size / shape / effects changed: grow or shrink the lane right away
    if (state._laneH !== window.BeatBarGeom.laneHeight(config)) state._updatePos && state._updatePos();
    if (state.panel && !state.panel.hidden) syncPreview(state, nowPerf);
  }

  function syncPreview(state, nowPerf) {
    const show = !!state.video.paused;
    if (show !== state._prevShown) {
      state.prevWrap.hidden = !show;
      state._prevShown = show;
    }
    if (show) drawPreview(state, nowPerf);
  }

  // A steady beat at the video's tempo (120 BPM before it is known), so
  // every setting shows live, effects included, even with the video paused.
  function drawPreview(state, nowPerf) {
    const G = window.BeatBarGeom;
    const c = state.prevCanvas;
    const ph = `${G.laneHeight(config)}px`;
    if (state.prevWrap.style.height !== ph) state.prevWrap.style.height = ph;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext('2d');
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bpm = state.bpm >= 60 && state.bpm <= 200 ? state.bpm : 120;
    const iv = 60 / bpm, t = nowPerf / 1000;
    const timing = G.laneTiming({
      laneW: w, refW: w / G.WIDTH_DEFAULT, playheadFrac: config.playheadFrac, baseLookahead: lookaheadFor(config),
    });
    const n0 = Math.floor((t - timing.lookbehind - 1.5) / iv);
    const n1 = Math.ceil((t + timing.lookahead + 0.5) / iv);
    const beats = [];
    for (let n = n0; n <= n1; n++) beats.push(n * iv);
    renderGlassFrame(ctx, w, h, t, beats, config, timing, n0);
  }

  /* Live-only Modern painter (mock "glass lane"). The frost is drawn here,
     not with CSS backdrop-filter: a backdrop-filter over the <video> makes
     the browser composite the whole video differently, and the entire frame
     came out slightly brighter with the bar on. Instead, `backdrop` (the
     picture's box relative to the lane) redraws the video blurred inside the
     pill, under a light tint; the <video> itself is never touched. Then: a
     track hairline fading at both ends, a playhead in the beat
     colour that glows brighter on each hit, and beats that grow as they
     approach (0.62 -> 1), land with the same envelope and effects as the
     classic bar plus a soft glow, then fade out behind the playhead.
     `seedBase` keeps spark layouts stable for a sliding beat list.
     The lane is sized for the peak icon plus a share of the effects
     (BeatBarGeom.laneHeight); everything but the frost is drawn on a layer
     whose top and bottom EDGE_FADE px fade out, so the faint outer tails of
     big ripples / sparks soften away instead of being cut off. */
  function renderGlassFrame(ctx, w, h, t, beats, cfg, timing, seedBase = 0, backdrop = null) {
    ctx.clearRect(0, 0, w, h);
    const cy = h / 2;
    const radius = Math.min(LANE_RADIUS, h / 2);
    if (backdrop) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, radius);
      ctx.clip();
      paintBackdrop(ctx, w, h, backdrop);
      ctx.fillStyle = GLASS_TINT;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    const rgb = hexToRgb(fillColorOf(cfg, true));
    const col = `${rgb.r},${rgb.g},${rgb.b}`;
    const lift = (v, k) => Math.round(v + (255 - v) * k);

    const out = ctx;
    ctx = fxLayer(out);

    const tg = ctx.createLinearGradient(0, 0, w, 0);
    tg.addColorStop(0, 'rgba(255,255,255,0)');
    tg.addColorStop(0.15, 'rgba(255,255,255,0.14)');
    tg.addColorStop(0.85, 'rgba(255,255,255,0.14)');
    tg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = tg;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, radius);
    ctx.clip();

    const { playheadX, lookahead, lookbehind, pxPerSec } = timing;
    const nudgeSec = cfg.nudgeSec || 0;
    const firstT = t - lookbehind - 0.2 - nudgeSec;
    let lo = 0, hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < firstT) lo = mid + 1; else hi = mid;
    }

    // How hard the nearest beat is hitting right now (drives the playhead glow)
    let near = 0;
    for (let i = lo; i < beats.length; i++) {
      const phase = t - (beats[i] + nudgeSec - BEAT_NUDGE_SEC);
      if (phase <= -BEAT_ATTACK_SEC) break;
      near = Math.max(near, beatEnvelope(phase));
    }

    const pg = ctx.createLinearGradient(0, 0, 0, h);
    pg.addColorStop(0, `rgba(${col},0)`);
    pg.addColorStop(0.5, `rgba(${lift(rgb.r, 0.35)},${lift(rgb.g, 0.35)},${lift(rgb.b, 0.35)},${0.7 + 0.3 * near})`);
    pg.addColorStop(1, `rgba(${col},0)`);
    ctx.save();
    ctx.shadowColor = `rgba(${col},${0.4 + 0.6 * near})`;
    ctx.shadowBlur = 6 + 14 * near;
    ctx.strokeStyle = pg;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(playheadX, h * 0.08); ctx.lineTo(playheadX, h * 0.92); ctx.stroke();
    ctx.restore();

    const shape = cfg.shape || 'circle';
    const effects = cfg.effects || DEFAULT_CONFIG.effects;
    const anyEffect = effects.pulse || effects.ripple || effects.spark;
    const fillOpacity = cfg.fillOpacity == null ? 1 : cfg.fillOpacity;
    const borderWidth = cfg.borderWidth || 0;
    const borderColor = cfg.borderColor || '#ffffff';
    const baseR = Math.max(3, cfg.fillSize || 9);
    const pulseR = baseR + Math.max(8, baseR * 1.2);

    for (let i = lo; i < beats.length; i++) {
      const dt = (beats[i] + nudgeSec) - t;
      if (dt > lookahead + 0.2) break;
      const x = playheadX + dt * pxPerSec;

      let fade = 1;
      if (dt < 0) {
        fade = 1 - Math.min(1, -dt / PAST_FADE_SEC);
        if (fade <= 0) continue;
      }
      const approach = dt > 0 ? Math.max(0.62, 1 - (dt / lookahead) * 0.38) : 1;
      const k = beatEnvelope(t - (beats[i] + nudgeSec - BEAT_NUDGE_SEC));
      const r0 = baseR * approach;
      const radius = k > 0 && effects.pulse ? r0 + k * (pulseR - baseR) : r0;

      // Soft glow on the hit (Pulse brings its own, so only without it)
      if (k > 0 && !effects.pulse) {
        const gr = radius * 2.8;
        const g = ctx.createRadialGradient(x, cy, 0, x, cy, gr);
        g.addColorStop(0, `rgba(${col},${0.45 * k * fade})`);
        g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, cy, gr, 0, Math.PI * 2); ctx.fill();
      }
      if (k > 0 && anyEffect) {
        const pulse = effects.spark ? { sparks: makeSparks(i + seedBase) } : null;
        drawEffects(ctx, effects, shape, x, cy, effects.pulse ? radius : r0, k, rgb, fade, pulse);
      }

      traceShape(ctx, shape, x, cy, radius);
      ctx.globalAlpha = fade * fillOpacity * (dt > 0 ? 0.55 + 0.45 * approach : 1);
      ctx.fillStyle = k > 0 ? `rgb(${lift(rgb.r, k * 0.5)},${lift(rgb.g, k * 0.5)},${lift(rgb.b, k * 0.5)})` : `rgb(${col})`;
      ctx.fill();
      ctx.globalAlpha = fade;
      if (borderWidth > 0) {
        ctx.lineWidth = borderWidth;
        ctx.strokeStyle = borderColor;
      } else {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.restore(); // end clip

    // Soft top / bottom edges, then onto the lane
    const fade = Math.min(window.BeatBarGeom.EDGE_FADE, h / 4) / h;
    const mg = ctx.createLinearGradient(0, 0, 0, h);
    mg.addColorStop(0, 'rgba(0,0,0,0)');
    mg.addColorStop(fade, 'rgba(0,0,0,1)');
    mg.addColorStop(1 - fade, 'rgba(0,0,0,1)');
    mg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = mg;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
    out.drawImage(ctx.canvas, 0, 0, w, h);
  }

  // One offscreen layer per target canvas (lane, settings preview), same
  // pixel size and transform, cleared for this frame.
  const _fxLayers = new WeakMap();
  function fxLayer(out) {
    let c = _fxLayers.get(out.canvas);
    if (!c) { c = document.createElement('canvas'); _fxLayers.set(out.canvas, c); }
    if (c.width !== out.canvas.width || c.height !== out.canvas.height) {
      c.width = out.canvas.width; c.height = out.canvas.height;
    }
    const lc = c.getContext('2d');
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, c.width, c.height);
    lc.setTransform(out.getTransform());
    return lc;
  }

  /* The blurred picture under the lane, kept in an offscreen canvas
     (backdrop.cache, one per attachment). Redrawn while playing, after a
     seek lands, or when the lane / picture box changes; reused while paused
     (no per-frame blur cost) and while the video has no frame to give
     (seeking, readyState < 2), so the frost never drops out on a skip. */
  function paintBackdrop(ctx, w, h, backdrop) {
    const { video, x, y, w: bw, h: bh, cache } = backdrop;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    const key = `${pw}x${ph}|${x}|${y}|${bw}|${bh}`;
    const ready = video.readyState >= 2 && !video.seeking;
    const fresh = cache && cache.ok && cache.key === key && video.paused && cache.t === video.currentTime;
    if (ready && !fresh) {
      if (!cache) {                       // no cache (shouldn't happen): draw direct
        ctx.filter = `blur(${GLASS_BLUR_PX}px)`;
        try { ctx.drawImage(video, x, y, bw, bh); } catch {}
        ctx.filter = 'none';
        return;
      }
      const c = cache.canvas || (cache.canvas = document.createElement('canvas'));
      if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
      const cx = c.getContext('2d');
      cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.clearRect(0, 0, pw, ph);
      cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cx.filter = `blur(${GLASS_BLUR_PX}px)`;
      try {
        cx.drawImage(video, x, y, bw, bh);
        cache.ok = true; cache.key = key; cache.t = video.currentTime;
      } catch { cache.ok = false; }
      cx.filter = 'none';
    }
    // Last good frost (stretched if the lane changed size meanwhile)
    if (cache && cache.ok && cache.canvas) ctx.drawImage(cache.canvas, 0, 0, w, h);
  }

  // What the Modern lane says while it works: one plain line, no counts; the
  // BPM shows on hover once it is known.
  function modernStatus(text) {
    if (!text) return '';
    if (/beats · /.test(text)) return '';
    const m = /^(Analyzing|Extracting|Detecting|Re-detecting)\D*(\d+%)?/.exec(text);
    if (m) return m[2] ? `Finding beats... ${m[2]}` : 'Finding beats...';
    return text.replace(/^Beat bar: /, 'Could not find beats: ');
  }

  // Unhook one overlay (its DOM and listeners) but keep the beats, worker
  // and clock: used on detach and when the look switches.
  function teardownOverlay(state) {
    if (state.ro) try { state.ro.disconnect(); } catch {}
    state.ro = null;
    if (state._posInterval) clearInterval(state._posInterval);
    state._posInterval = null;
    if (state._updatePos) window.removeEventListener('resize', state._updatePos);
    if (state._outsideClose) document.removeEventListener('pointerdown', state._outsideClose, true);
    if (state._keyClose) document.removeEventListener('keydown', state._keyClose, true);
    state._outsideClose = state._keyClose = state._updatePos = null;
    state.overlay?.remove();
    state.overlay = state.canvas = state.ctx = state.statusEl = state.bpmEl = null;
    state.panel = state.prevWrap = state.prevCanvas = null;
    document.getElementById('beatbarSettingsBtn')?.classList.remove('gear-open');
  }

  // The glass lane is the main player's only. A bar riding another video
  // (the Editor's stack / grid master) stays the classic card in both looks,
  // so what you see there is what its export bakes.
  const wantsModern = (state) => !state.ownVideo && isModern() && !!window.BeatBarGeom;

  // Settings > Layout switched looks: rebuild the bar in place.
  window.addEventListener('vault:layout-style', () => {
    const state = _state;
    if (!state || state.destroyed) return;
    if (state.modern === wantsModern(state)) return;
    teardownOverlay(state);
    createOverlay(state);
  });

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
    if (state.statusEl) state.statusEl.textContent = state.modern ? modernStatus(text) : text;
  }

  /* ── Render loop (rAF; drift-corrected time estimate for smoothness) ────── */

  function startRenderLoop(state) {
    const tick = (now) => {
      if (state.destroyed) return;
      updateSmoothTime(state, now);
      drawBar(state);
      if (state.modern && state.overlay) modernTick(state, now);
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
    if (state.modern) {
      const G = window.BeatBarGeom;
      const timing = G.laneTiming({
        laneW: w, refW: state.videoW || w / G.WIDTH_DEFAULT,
        playheadFrac: config.playheadFrac, baseLookahead: lookaheadFor(config),
      });
      const bd = state._backdrop;
      renderGlassFrame(ctx, w, h, state.smoothTime, state.beats, config, timing, 0,
        bd ? { video: state.video, ...bd, cache: state._frost || (state._frost = {}) }
           : { video: { readyState: 0 }, cache: state._frost });
      return;
    }
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
      ownVideo: !!videoEl,
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
    if (state._statusTimer) clearTimeout(state._statusTimer);
    teardownOverlay(state);
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
    // The bake always draws the classic card (renderBarFrame). From the
    // Modern lane it is centred on the lane, in the colour the lane shows.
    const cfg = JSON.parse(JSON.stringify(config));
    cfg.fillColor = fillColorOf(config, !!state.modern);
    const top = state.modern ? oRect.top + oRect.height / 2 - BAR_HEIGHT / 2 : oRect.top;
    return {
      mediaId: state.mediaId,
      beats: state.beats.slice(),
      config: cfg,
      yFrac: (top - vRect.top) / vRect.height,
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
    // For buttons that draw the on / off state themselves (the Modern dock)
    try { document.dispatchEvent(new CustomEvent('beatbar:toggle', { detail: { on } })); } catch {}
    const media = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
    if (on && media?.media_type === 'video') {
      const item = Library.rowByPath(media.filepath);
      attach(item || media);
      // The Modern dock's beat bar button lights up instead of a toast
      if (!(typeof mpQuietToast === 'function' && mpQuietToast())) showToast(isModern() ? 'Beat bar on. It stays on for future videos'
        : '🥁 Beat bar ON, stays on for future videos');
    } else {
      detach();
      if (!on && !(typeof mpQuietToast === 'function' && mpQuietToast())) showToast('Beat bar off');
    }
  }
  window.toggleBeatBar = toggleBeatBar;

  // Settings button in the control bar — toggles the panel. If the bar isn't
  // running yet, turn it on first so there's something to preview.
  // In Modern this is the player's gear menu > "Beat bar settings": the panel
  // opens above the dock. Optional opts:
  //   anchor  element to open above (the dock's gear button)
  //   onBack  shows a back arrow in the header that calls it (reopen the menu)
  function openBeatBarSettings(opts) {
    opts = opts && typeof opts === 'object' && !(opts instanceof Event) ? opts : {};
    if (!_state) {
      if (!isEnabled()) {
        localStorage.setItem(LS_ENABLED, '1');
        try { document.dispatchEvent(new CustomEvent('beatbar:toggle', { detail: { on: true } })); } catch {}
      }
      syncButton();
      const media = (typeof currentMediaState !== 'undefined') && currentMediaState.currentMediaData;
      const item = media && (Library.rowByPath(media.filepath) || media);
      if (item) attach(item);
      setSettingsOpen(true, 'menu', opts);
      return;
    }
    toggleSettingsPanel('menu', opts);
  }
  window.openBeatBarSettings = openBeatBarSettings;

  /* Classic keeps the emoji; Modern shows the line icon (player-lib/icons.js). */
  function glyph(emoji, icon) {
    return typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, icon) : emoji;
  }

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
      ><span class="nav-icon">${glyph('🥁', 'beat')}</span><span class="beatbar-state">${on ? 'ON' : 'OFF'}</span></button>
      <button id="beatbarSettingsBtn" class="nav-btn beatbar-settings-btn"
        onclick="openBeatBarSettings()" title="Beat bar settings" aria-label="Beat bar settings"
      ><span class="nav-icon">${glyph('⚙', 'gear')}</span></button>`;
  }
  window.renderBeatBarButtons = renderButtons;

  function syncButton() {
    const btn = document.getElementById('beatbarBtn');
    if (!btn) return;
    const on = isEnabled();
    btn.classList.toggle('beatbar-btn-on', on);
    const stateEl = btn.querySelector('.beatbar-state');
    if (stateEl) stateEl.textContent = on ? 'ON' : 'OFF';
    // The Modern dock's button (player-modern.js) keeps its own wording
    btn.title = btn.classList.contains('mp-beat')
      ? (on ? 'Beat bar is on. Click to turn it off' : 'Beat bar is off. Click to turn it on')
      : buttonTitle(on);
  }

  /* Safety net for players that don't render the buttons themselves (and for
     any re-render that drops them). The video player supplies them up front,
     so this normally finds them already in place and only syncs the state. */
  function injectButtons() {
    // Live in the extras row (next to speed, between play row and nav bar) —
    // keeps Prev/Random/Info/Next in a fixed spot across media types
    const center = document.querySelector('.video-extras-row .pr-center');
    if (!center) return;
    // The Modern dock draws its own button
    if (!isModern() && !document.getElementById('beatbarBtn')) center.insertAdjacentHTML('beforeend', renderButtons());
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
          const item = Library.rowByPath(mediaData.filepath);
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
