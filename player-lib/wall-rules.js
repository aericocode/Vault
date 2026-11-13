/* =========================================================================
   WALL RULES - the pure parts of the Wall's settings, shared by the Wall
   (player-lib/wall.js) and the tests. No DOM, no network.

   - cfgFrom(raw)              the Wall's settings from a stored blob, every
                               value checked against its choices (an older
                               blob migrated to the nearest choice)
   - visibilityAction(o)       whether the Wall stops when its page is hidden,
                               and whether a clip the browser paused by itself
                               is played again
   ========================================================================= */

const WallRules = (() => {
  const CFG_VERSION = 3;

  // Every setting is a short list of choices (Wall 3.11: chips in the bar).
  const MODES = ['grid', 'scroll'];
  const LAYOUTS = ['horizontal', 'vertical'];    // slices of different heights, or columns of different widths
  const SIZES = ['small', 'medium', 'large'];
  const VARIETIES = ['even', 'mixed', 'wild'];
  const PACES = ['slow', 'medium', 'fast'];
  const CLIPS = [15, 30, 60, 'whole'];
  const PLAYING = ['auto', 1, 2, 3, 4, 6, 8, 10, 12];
  const SOUNDS = ['off', 'hover', 'follow', 'rotate'];
  const MIXES = ['both', 'videos', 'pictures'];
  const ORDERS = ['shuffle', 'order'];

  // What each choice means.
  const SIZE_PX = { small: 260, medium: 390, large: 560 };         // the base block size
  const VARIETY_PCT = { even: 15, mixed: 60, wild: 100 };          // how much slice heights / column widths differ
  const PACE_PIC_S = { slow: 25, medium: 15, fast: 10 };           // Grid: seconds between picture changes
  const PACE_SPEED = { slow: 2, medium: 4, fast: 5 };              // Scroll: speed level (1 to 10; 10 * 1.4^(level-1) px/s)

  /** A stored number (or numeric string); anything else (true, [], '') is NaN. */
  function toNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
  }

  /** The key of `table` whose value is nearest to n (by ratio when `log`), or null for no number. */
  function nearestKey(table, n, log = true) {
    if (!Number.isFinite(n) || (log && n <= 0)) return null;
    let best = null;
    let bestD = Infinity;
    for (const [k, v] of Object.entries(table)) {
      const d = log ? Math.abs(Math.log(v / n)) : Math.abs(v - n);
      if (d < bestD) { best = k; bestD = d; }
    }
    return best;
  }

  /**
   * Settings from the stored blob. A blob of this version is checked
   * against the choices; an older one (Round 2 sliders, or the first Wall)
   * is moved to the nearest choices so the wall keeps its feel:
   *  - Layout: Slices -> Horizontal, Columns (or a blob from before
   *    Layout existed) -> Vertical.
   *  - Block size (colWidth, or the first Wall's row height) -> Size.
   *  - Height variety -> Variety.
   *  - Pictures (Grid) or Speed (Scroll), whichever mode was in use -> Pace.
   *  - Clip length, "Play clips to the end" -> Clips.
   *  - Videos at once: the old default (6) becomes Auto, any other number
   *    the nearest choice.
   *  - Sound Auto -> Follow.
   */
  function cfgFrom(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const cur = raw.v === CFG_VERSION;
    const out = { v: CFG_VERSION };
    out.mode = MODES.includes(raw.mode) ? raw.mode : 'grid';

    if (cur) {
      out.layout = LAYOUTS.includes(raw.layout) ? raw.layout : 'horizontal';
      out.size = SIZES.includes(raw.size) ? raw.size : 'medium';
      out.variety = VARIETIES.includes(raw.variety) ? raw.variety : 'mixed';
      out.pace = PACES.includes(raw.pace) ? raw.pace : 'medium';
      out.clips = CLIPS.includes(raw.clips) ? raw.clips : 30;
      out.playing = PLAYING.includes(raw.playing) ? raw.playing : 'auto';
      out.sound = SOUNDS.includes(raw.sound) ? raw.sound : 'off';
    } else {
      const known = Object.keys(raw).length > 0;
      out.layout = raw.layout === 'slices' ? 'horizontal' : (known ? 'vertical' : 'horizontal');
      // Block size: Round 2's column width, or the first Wall's row height (blocks were about 1.5x as wide).
      let px = toNum(raw.colWidth);
      if (!Number.isFinite(px) && raw.v == null) px = toNum(raw.blockSize) * 1.5;
      out.size = nearestKey(SIZE_PX, px) || 'medium';
      out.variety = nearestKey(VARIETY_PCT, toNum(raw.sliceVariety), false) || 'mixed';
      const fromPic = nearestKey(PACE_PIC_S, toNum(raw.picSpeed));
      const fromSpeed = nearestKey(PACE_SPEED, toNum(raw.scrollSpeed), false);
      out.pace = (out.mode === 'scroll' ? (fromSpeed || fromPic) : (fromPic || fromSpeed)) || 'medium';
      const len = toNum(raw.clipLen);
      if (raw.clipsToEnd === true || (raw.v == null && len >= 120)) out.clips = 'whole';
      else out.clips = Number(nearestKey({ 15: 15, 30: 30, 60: 60 }, len)) || 30;
      const n = Math.round(toNum(raw.playing));
      if (!Number.isFinite(n) || n === 6) out.playing = 'auto';
      else out.playing = Number(nearestKey({ 1: 1, 2: 2, 3: 3, 4: 4, 6: 6, 8: 8, 10: 10, 12: 12 }, Math.max(1, n)));
      // "Sound on hover" (a checkbox) became the Sound choice; Auto became Follow.
      if (raw.sound === 'auto') out.sound = 'follow';
      else if (SOUNDS.includes(raw.sound)) out.sound = raw.sound;
      else out.sound = raw.soundOnHover === true ? 'hover' : 'off';
    }

    out.mix = MIXES.includes(raw.mix) ? raw.mix : 'both';
    out.order = ORDERS.includes(raw.order) ? raw.order : 'shuffle';
    out.source = typeof raw.source === 'string' && /^(library|c:\d+|s:\d+)$/.test(raw.source) ? raw.source : 'library';
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
    CFG_VERSION, MODES, LAYOUTS, SIZES, VARIETIES, PACES, CLIPS, PLAYING, SOUNDS, MIXES, ORDERS,
    SIZE_PX, VARIETY_PCT, PACE_PIC_S, PACE_SPEED,
    toNum, nearestKey, cfgFrom, visibilityAction,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WallRules;
if (typeof window !== 'undefined') window.WallRules = WallRules;
