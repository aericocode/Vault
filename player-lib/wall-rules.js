/* =========================================================================
   WALL RULES - the pure parts of the Wall's settings, shared by the Wall
   (player-lib/wall.js) and the tests. No DOM, no network.

   - cfgFrom(raw)              the Wall's settings from a stored blob, every
                               value clamped (an old blob migrated)
   - visibilityAction(o)       whether the Wall stops when its page is hidden,
                               and whether a clip the browser paused by itself
                               is played again
   ========================================================================= */

const WallRules = (() => {
  const CFG_VERSION = 2;
  const RANGES = {
    playing:     { min: 1, max: 16, step: 1, def: 6 },
    picSpeed:    { min: 2, max: 60, step: 1, def: 8 },     // seconds between picture changes
    clipLen:     { min: 5, max: 120, step: 1, def: 20 },   // seconds a clip plays
    colWidth:    { min: 120, max: 1280, step: 10, def: 390 },
    gap:         { min: 0, max: 12, step: 1, def: 4 },
    scrollSpeed: { min: 1, max: 10, step: 1, def: 4 },
  };
  // The speed sliders move along these, faster to the right. The stored value
  // stays in seconds and is kept exactly until the slider is moved.
  const PIC_STEPS = [60, 45, 30, 20, 15, 12, 10, 8, 6, 5, 4, 3, 2];
  const CLIP_STEPS = [120, 90, 60, 45, 30, 20, 15, 10, 8, 5];
  const MODES = ['grid', 'scroll'];
  const MIXES = ['both', 'videos', 'pictures'];
  const ORDERS = ['shuffle', 'order'];
  const SOUNDS = ['off', 'hover', 'auto'];

  /** A stored number (or numeric string); anything else (true, [], '') is NaN. */
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }

  function clampNum(v, r) {
    const n = toNum(v);
    if (!Number.isFinite(n)) return r.def;
    return Math.min(r.max, Math.max(r.min, Math.round(n / r.step) * r.step));
  }

  /**
   * Settings from the stored blob, every value clamped. A blob from before
   * Round 2 (no `v`) is migrated so the wall keeps its feel: "Full clip" (the
   * old clip maximum) becomes "Play clips to the end", and the old row height
   * becomes a column width (blocks were on average about 1.5 times as wide
   * as the row was tall).
   */
  function cfgFrom(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const old = raw.v !== CFG_VERSION;
    const out = { v: CFG_VERSION };
    out.playing = clampNum(raw.playing, RANGES.playing);
    out.picSpeed = clampNum(raw.picSpeed, RANGES.picSpeed);
    if (old && toNum(raw.clipLen) >= 120) {
      out.clipLen = RANGES.clipLen.max;
      out.clipsToEnd = true;
    } else {
      out.clipLen = clampNum(raw.clipLen, RANGES.clipLen);
      out.clipsToEnd = raw.clipsToEnd === true;
    }
    const oldRow = toNum(raw.blockSize);
    out.colWidth = old && raw.colWidth == null && Number.isFinite(oldRow)
      ? clampNum(oldRow * 1.5, RANGES.colWidth)
      : clampNum(raw.colWidth, RANGES.colWidth);
    out.gap = clampNum(raw.gap, RANGES.gap);
    out.scrollSpeed = clampNum(raw.scrollSpeed, RANGES.scrollSpeed);
    out.mode = MODES.includes(raw.mode) ? raw.mode : 'grid';
    out.mix = MIXES.includes(raw.mix) ? raw.mix : 'both';
    out.order = ORDERS.includes(raw.order) ? raw.order : 'shuffle';
    out.source = typeof raw.source === 'string' && /^(library|c:\d+|s:\d+)$/.test(raw.source) ? raw.source : 'library';
    // "Sound on hover" (a checkbox) became the Sound choice.
    out.sound = SOUNDS.includes(raw.sound) ? raw.sound : (raw.soundOnHover === true ? 'hover' : 'off');
    out.pauseOnHover = raw.pauseOnHover !== false;
    out.directOnly = raw.directOnly === true;
    // On by default: the Wall keeps playing with another tab selected or its
    // window covered (PLAYLISTS_SPEC "Stage host, final"). Turned off, a
    // hidden tab pauses it to save power. Stored as keepPlaying2: test builds
    // saved the earlier keepPlaying (off by default) on every save, so only a
    // choice made since it turned on by default counts.
    out.keepPlaying2 = raw.keepPlaying2 !== false;
    return out;
  }

  /**
   * Whether the Wall stops because its page is hidden (pure).
   *
   * o: {
   *   keepPlaying  the Wall setting "Keep playing when this tab is hidden" (cfg.keepPlaying2)
   *   visibility   'visible' | 'hidden' (document.visibilityState)
   *   reason       'page': the page was shown or hidden (Vault's own rule)
   *                'clip': a playing clip paused without the Wall asking
   *                        (Chromium pauses muted videos in hidden pages)
   * }
   * Returns 'run' (carry on), 'pause' (hidden: pause the clips and give up
   * the converted ones, as the Wall always has), 'replay' (play that clip
   * again) or 'ignore' (leave that clip alone).
   *
   * A clip the browser paused is played again only where the Wall keeps
   * playing and nobody can have paused it on purpose: a hidden page. In a
   * page that is showing, a pause the Wall did not ask for is the user's (a
   * media key), and stays.
   */
  function visibilityAction({ keepPlaying = true, visibility = 'visible', reason = 'page' } = {}) {
    const keep = keepPlaying !== false;
    const hidden = visibility === 'hidden';
    if (reason === 'clip') return keep && hidden ? 'replay' : 'ignore';
    return hidden && !keep ? 'pause' : 'run';
  }

  return {
    CFG_VERSION, RANGES, PIC_STEPS, CLIP_STEPS, MODES, MIXES, ORDERS, SOUNDS,
    toNum, clampNum, cfgFrom, visibilityAction,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WallRules;
if (typeof window !== 'undefined') window.WallRules = WallRules;
