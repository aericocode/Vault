/* =========================================================================
   WALL - a screen-filling collage of the library (LIBRARY_LAYOUT_SPEC Part 2
   and Round 2)

   Blocks that keep each file's shape. A few videos play muted at once, the
   rest of the blocks show pictures. No gap between blocks.

   Settings (Wall 3.11: chips in the bar, each a short list; wall-rules.js
   checks them and moves an older blob to the nearest choices):
   Source and Order (Shuffle | In order; with Shuffle the menu also has a
   "Shuffle again" action); Grid | Scroll; Layout (Horizontal | Vertical)
   with Size (base block 260 / 390 / 560 px) and Variety (Even / Mixed /
   Wild) in the same menu; Pace (Grid: pictures change every 25 / 15 / 10
   s, Scroll: speed level 2 / 4 / 5); Sound (Off, On hover, Follow, or
   Rotate every 10 / 20 / 30 / 60 s or Mix it up); Videos (Auto or a fixed
   number, 2 to 12). Under More: Show, Pause on hover, Only files that play
   without converting, Keep playing when this tab is hidden, Loop clips
   instead of changing them.

   Two layouts:

   - Horizontal: full-width slices of different heights. A slice takes
     files until they fill the width at a target height (the block size,
     varied at random by Variety and nudged by the first file's
     resolution), then its exact height is solved so the row ends flush
     (sliceRow).
   - Vertical: masonry columns of different widths (the block size times a
     random factor from Variety, scaled so the columns exactly span the
     board). Files stack down each column at their exact shape; in Scroll
     a file wider than 2.5:1 may span two columns.

   Two modes:

   - Grid: a still board that fits the screen exactly, nothing cut off at
     the bottom (fitGrid). Horizontal: the last slice aims at the height
     left, then every slice is scaled by one factor (at most 1) and
     centered, leaving black bars at the sides. Vertical: no spanning;
     each column picks a last file that ends near the bottom, then is
     scaled on its own to end there and centered in its place. Pictures
     change on a timer (Pace), clips when they end, crossfading.
   - Scroll: the board drifts upward. New files join at the bottom of the
     shortest column (Horizontal: as a whole new slice), files that leave
     the top are released and dropped.

   Clips play to the end: then the next file from the source whose shape
   fits takes the block (advance), in both modes. A long clip starts at a
   random point at least 30 s before its end; a short one from the start,
   except the first clips on a fresh Grid board, which start further in
   one by one (staggerShare) so they do not all end together (clipStart).
   With "Loop clips instead of changing them" a clip loops in its block
   instead and stays: in Grid until something stops it (fewer
   Videos, a new board), in Scroll until it leaves the top. A very long
   clip simply plays a long time; Rotate sound gives the variety.

   Ambient, so smoothness wins over features:

   - Fixed slots. The board is planned once per board size; a block's
     place and size never change after it is placed. A swap brings in a file
     whose stored shape is within about 15% of the slot; when the queue has
     none, the incoming file is cropped into the slot (object-fit: cover).
     A real size the element reports later is remembered for later picks and
     never moves anything. Layout, Size, Variety, mode and window size
     changes plan the board again, once, behind a short fade.
   - Blocks are absolutely placed inside one track element. Scroll mode moves
     only the track (translate3d from requestAnimationFrame), so a frame does
     no layout. Blocks that leave the top go from the DOM; every so often the
     coordinates are rebased in the same frame so the numbers stay small.
   - The playing cap (Videos) is counted on live <video> elements, including
     one that is still fading out. A remux (HLS) stream counts as 2 and only
     one runs at a time: the server runs at most 2 FFmpeg sessions for the
     whole app and a third would kill the main player's. In Scroll mode a
     clip may start once at least 10% of it (of the block, or of the board
     for a taller block) is on the board; the slots go to the blocks most in
     view, and a playing clip leaving at the top gives its slot first to a
     block more in view than it is (scrollRank, leavingFor).
   - Videos Auto (autoStep): starts at 4. Every 4 s the playing clips are
     judged by their dropped frames (getVideoPlaybackQuality), stalls
     ('waiting' after they played) and, in Scroll, animation frames over
     50 ms. Smooth with blocks waiting for a slot: one more (up to 12). Not
     smooth: one fewer (down to 2), and no raise for 20 s. Frozen while the
     page is hidden. The chip shows the number now.
   - Every replaced <video> is released (pause, src removed, load(), hls
     destroyed, stream closed). Leaving the tab, opening the player, locking
     the library or closing the page releases them all. A hidden browser tab
     releases the remux streams (so their FFmpeg sessions stop instead of
     idling out a minute later) and pauses the rest; on return the freed
     slots start again with fresh streams. The Pause button only pauses.
   - One 250 ms scheduler tick drives every block (no timer per block).
   - Clips play to their end. A converted (remux) clip plays at most
     3 minutes (REMUX_MAX_RUN_MS, clipDue), looping or not, then its block
     takes a new file, so the one remux slot moves on.
   - Freeze watchdog (from the tick: shouldAdvance, freezeStep): a clip that
     should be playing (wall running, not held by Pause on hover; in a hidden
     page only while other clips are seen moving) whose time stands still
     for 8 s is freed like one that ended. A second freeze of the same file
     in a session leaves it out. A clip the browser pauses in a visible page
     gets one more play() first. Not counted as a stall for Auto.

   Sound (the Sound chip): Off, On hover (only the hovered clip is heard),
   Follow (exactly one playing clip that has an audio track is heard; when
   it stops, the sound moves to the playing clip with sound that has the
   most time left on the wall, and never away from one that is still
   playing; no clip with sound, no sound and no badge), or Rotate (Follow,
   and every 10 / 20 / 30 / 60 s, or after a fresh random 10 to 40 s for
   Mix it up, the sound also moves to another playing clip with sound and
   at least ROTATE_MIN_LEFT_MS left, the one not heard for longest;
   none, it stays; a move that falls due while the heard clip is held by
   Pause on hover waits; rotateWaitMs, rotateDue). In Scroll only a clip at least half in
   view is heard. Whether a clip has sound comes from the row's probe
   (audio_codec), else from the element once it plays. Every handover is a
   slow volume crossfade, and at most two clips are ever partly audible
   (one fading out, one fading in). The level and mute come
   from the player's stored volume (vault_volume). In Follow and Rotate, a
   hovered clip borrows the sound while hovered when "Pause on hover" is
   on; with it off, hovering is only the caption. A browser that refuses
   sound before a click keeps the clip playing muted and asks for a click
   on the wall.

   Sources go through the existing query API (Library.queryOnce: POST
   /api/library/query + the binary id list) and rows through Library.fetchRows
   (POST /api/media/rows). Thumbnails go through thumbs.js, so the vault's
   blob mode works unchanged. Videos use /media/:id (the same URL the player's
   native path gets) and /stream/:id via /api/playback for remux.

   Hidden pages (WallRules.visibilityAction). "Keep playing when this tab is
   hidden" is on by default: the Wall carries on with another tab selected,
   or with its window covered or not focused (Chromium then treats the page
   as hidden too). Two things stand in the way and are dealt with here:
   - Chromium pauses muted videos in hidden pages, and holds new ones before
     they start: such a clip is played again (clipPaused, replayHeld).
   - Timers in hidden pages are slowed (once a second, then once a minute
     after a few minutes): the scheduler's tick comes from a small worker
     while the page is hidden (worker timers are not slowed that way).
   What a hidden page still cannot do: animate (Scroll mode stands still,
   requestAnimationFrame does not run) and fade (the crossfade is skipped).
   Turned off, a hidden tab pauses the Wall and gives up its converted clips
   to save power, as it always did. A minimised window is paused by the
   browser whatever the setting (nothing can capture it then anyway).

   Globals used by tabs.js / vault-ui.js: wallEnter(), wallLeave(), wallLockStop().
   viewtracker.js asks wallStartAt(el) so a clicked clip continues in the
   player from where it was on the Wall.
   ========================================================================= */

const Wall = (() => {
  const R = typeof WallRules !== 'undefined' ? WallRules : (typeof window !== 'undefined' && window.WallRules);
  const { cfgFrom, SIZE_PX, VARIETY_PCT, PACE_PIC_S, PACE_SPEED } = R;
  const MIX_TYPES = { both: ['video', 'image', 'gif'], videos: ['video'], pictures: ['image', 'gif'] };

  const MAX_REMUX = 1;               // see the header: the server's FFmpeg cap is 2, app-wide
  const REMUX_COST = 2;
  const FADE_MS = 600;
  const REPLAN_FADE_MS = 200;
  const TICK_MS = 250;
  const LOOKAHEAD = 24;              // how far into the queue a build pick may look
  const SHAPE_TOL = Math.log(1.15);  // a swap's file fits the slot within 15%
  const WIDE = 2.5;                  // wider than this spans two columns
  const LOAD_TIMEOUT_MS = 12000;
  const REMUX_TIMEOUT_MS = 25000;
  const REMUX_MAX_RUN_MS = 180000;   // a converted clip gives up the one remux slot after 3 minutes
  const FREEZE_MS = 8000;            // a playing clip whose time stands still this long is stuck
  const FREEZE_DT_MAX_MS = 1000;     // a late tick counts at most this much (sleep, throttled timers)
  const FREEZES_BAD = 2;             // freezes in a session before a file is left out
  const ASPECT_MIN = 0.25;
  const ASPECT_MAX = 4;
  const DEFAULT_ASPECT = 16 / 9;
  const MAX_BLOCKS = 1500;
  const READY_CAP = 1500;            // the most rows the buffer holds
  const REBASE_AT = 20000;           // scroll offset (px) at which coordinates are rebased
  const FS_IDLE_MS = 3000;
  // Scroll: a clip may start once at least START_FRAC of it (of its height,
  // or of the board's height for a block taller than the board) is on the
  // board, and may be heard (Follow, Rotate) while at least HEAR_FRAC is.
  const START_FRAC = 0.10;
  const HEAR_FRAC = 0.5;
  const GAP = 0;                     // no gap between blocks (fixed)

  /* ── Settings ───────────────────────────────────────────────────────── */

  let cfg = null;

  function loadCfg() {
    return cfgFrom((typeof window.vaultWallSettings === 'function' && window.vaultWallSettings()) || {});
  }

  function saveCfg() {
    if (typeof window.vaultSetWallSettings === 'function') window.vaultSetWallSettings(cfg);
  }

  const sizePx = () => SIZE_PX[cfg.size] || 390;
  const varietyPct = () => VARIETY_PCT[cfg.variety] != null ? VARIETY_PCT[cfg.variety] : 60;
  /** Grid: seconds between picture changes. */
  const picSec = () => PACE_PIC_S[cfg.pace] || 15;
  /** Scroll speed level (1 to 10) in pixels per second. */
  const speedPx = () => 10 * Math.pow(1.4, (PACE_SPEED[cfg.pace] || 4) - 1);

  /**
   * The share of a block (top y, height h) on a board showing top..top+H,
   * measured against min(h, H) so a block taller than the board can reach 1.
   */
  function visibleFrac(y, h, top, H) {
    const base = Math.min(h, H);
    if (!(base > 0)) return 0;
    const seen = Math.min(y + h, top + H) - Math.max(y, top);
    return Math.max(0, Math.min(1, seen / base));
  }

  /** Scroll: at least `frac` of the block is on the board (half a pixel of slack). */
  function inView(y, h, top, H, frac) {
    const base = Math.min(h, H);
    return base > 0 && visibleFrac(y, h, top, H) * base >= frac * base - 0.5;
  }

  /**
   * Scroll: ms until a block drifting up at `pxPerSec` has less than `frac`
   * (default HEAR_FRAC) of itself on the board at the top. Negative once past.
   */
  function scrollLeftMs(y, h, offset, H, pxPerSec, frac = HEAR_FRAC) {
    return (y + h - frac * Math.min(h, H) - offset) / pxPerSec * 1000;
  }

  /**
   * Scroll: the order in which waiting clips get a slot (pure). `cands` are
   * { y, h, lastPlayedAt } of blocks that may play; returns those at least
   * START_FRAC in view, most in view first; a tie goes to a block whose top
   * is on the board (entering) over one whose top has passed, then to the
   * one that waited longest, then the higher one.
   */
  function scrollRank(cands, top, H) {
    const out = [];
    for (const c of cands) {
      const f = visibleFrac(c.y, c.h, top, H);
      if (inView(c.y, c.h, top, H, START_FRAC)) out.push({ c, f, late: c.y < top ? 1 : 0 });
    }
    out.sort((a, b) => (b.f - a.f) || (a.late - b.late)
      || ((a.c.lastPlayedAt || 0) - (b.c.lastPlayedAt || 0)) || (a.c.y - b.c.y));
    return out.map(o => o.c);
  }

  /**
   * Scroll: the playing clips that would give their slot to `cand` (pure),
   * soonest gone first. A clip gives its slot when it is under START_FRAC in
   * view (or off the board), or when it is leaving at the top (its top has
   * passed) and is less in view than `cand`. A clip entering at the bottom
   * keeps its slot: it is on its way into view.
   */
  function leavingFor(cand, playing, top, H) {
    const fc = visibleFrac(cand.y, cand.h, top, H);
    return playing.filter((p) => {
      if (!inView(p.y, p.h, top, H, START_FRAC)) return true;
      return p.y < top && visibleFrac(p.y, p.h, top, H) < fc;
    }).sort((a, b) => (a.y + a.h) - (b.y + b.h));
  }

  /* Videos at once: Auto. Every AUTO_WINDOW_MS the clips' playback is
     judged: smooth, with blocks waiting for a slot, raises the target by one;
     not smooth lowers it by one and holds off raising for AUTO_HOLD_MS. */
  const AUTO_START = 4;
  const AUTO_MIN = 2;
  const AUTO_MAX = 12;
  const AUTO_WINDOW_MS = 4000;
  const AUTO_HOLD_MS = 20000;
  const STALL_GRACE_MS = 2000;       // a wait this soon after a clip starts is its start, not a stall

  /**
   * One Auto step (pure). `st` is { target, holdUntil }; `s` the window's
   * sample: { dropRate (dropped / decoded frames, null with none decoded),
   * stalls (playing clips that had to wait for data), hitchRate (Scroll
   * frames over 50 ms, null outside Scroll), wanting (a block in view is
   * waiting for a slot the target keeps from it) }. Returns the next state.
   */
  function autoStep(st, s, t) {
    const drop = s.dropRate == null ? 0 : s.dropRate;
    const hitch = s.hitchRate == null ? 0 : s.hitchRate;
    const stalls = s.stalls || 0;
    if (drop > 0.05 || stalls >= 2 || hitch > 0.05) {
      return { target: Math.max(AUTO_MIN, st.target - 1), holdUntil: t + AUTO_HOLD_MS };
    }
    const smooth = drop < 0.02 && stalls === 0 && hitch < 0.02;
    if (smooth && s.wanting && t >= st.holdUntil && st.target < AUTO_MAX) {
      return { target: st.target + 1, holdUntil: st.holdUntil };
    }
    return { target: st.target, holdUntil: st.holdUntil };
  }

  /**
   * Scroll: which leaving clips to stop so a clip costing `cost` can start.
   * `leaving` is [{ cost, remux }], soonest gone first. Returns the indices to
   * stop ([] = it fits already), null when stopping every leaving clip would
   * still not make room, or 'remux' when the one remux slot is held by a clip
   * that is not leaving (stopping others cannot help).
   */
  function scrollFreePlan(cost, isRemux, free, remuxFree, leaving) {
    const stops = [];
    if (isRemux && !remuxFree) {
      const i = leaving.findIndex(l => l.remux);
      if (i < 0) return 'remux';
      stops.push(i);
      free += leaving[i].cost;
    }
    for (let i = 0; i < leaving.length && free < cost; i++) {
      if (stops.includes(i)) continue;
      stops.push(i);
      free += leaving[i].cost;
    }
    return free >= cost ? stops : null;
  }

  /* ── State ──────────────────────────────────────────────────────────── */

  let els = null;
  let active = false;          // the Wall tab is showing
  let userPaused = false;
  let playerOpen = false;
  let rootFs = false;          // the wall is full screen, maybe under the player (openItem)
  let running = false;
  let pausedAt = 0;
  let tickTimer = null;
  let built = false;
  let buildGen = 0;
  let layoutGen = 0;           // bumped by every layout, so a waiting relayout knows it is stale
  // Layout work asked for while the tab was hidden (the board has no size
  // then): 'keep' or 'fresh', done on the way back in. Never laid out hidden.
  let dirty = false;
  let fading = false;          // a re-plan is behind its fade
  let reducedNote = false;     // Scroll started paused for reduced motion
  let reducedDone = false;     // ...and that happens once per visit to Scroll

  let blocks = [];             // in placement order
  // Grid: the first clips after a layout start further into the clip, one
  // by one, so a fresh board's short clips do not all end together.
  let staggerLeft = 0;
  let staggerFrom = 0;
  const STAGGER_WINDOW_MS = 4000;
  // The plan: column count, each column's width and x, and each column's
  // next free y (its content bottom plus one gap). Slices (layout 'slices',
  // cols 0) has one next free y, `bottom`, and the base slice height `base`.
  // `fitH` is set in Grid mode: the board's height, which the plan is fitted to.
  const lay = { layout: 'columns', W: 0, H: 0, cols: 0, cw: 0, cws: [], gap: 0, colX: [], tops: [], base: 0, bottom: 0, fitH: 0 };
  let hoverBlock = null;
  // A primary-button press that only closed the popover or turned sound on:
  // the click that follows it is swallowed. Any later press, or a click
  // that does not come within SWALLOW_MS (a right-click has none), ends it.
  let swallowUntil = 0;
  // Long enough for a slow press; every new press clears it anyway.
  const SWALLOW_MS = 5000;

  // Sound. `autoRec` is Auto's pick, `audioRec` the clip being heard now (or
  // fading in); clips being faded out are in `fadingRecs` until silent.
  let autoRec = null;
  let audioRec = null;
  let soundBlocked = false;    // the browser refused sound before a click
  const fadingRecs = new Set();
  let rampTimer = 0;
  const dbgKeys = new WeakMap();  // clip → a number, for Wall._audio() only
  let dbgSeq = 0;

  const drift = { offset: 0, raf: 0, lastT: 0, frames: [], rebases: 0, removed: 0 };
  const stats = { swaps: 0, exact: 0, near: 0, crops: 0, worstCrop: 1, staleDropped: 0, moreFetches: 0, rowFetches: 0, replays: 0, stalls: 0, freezes: 0 };

  let liveCost = 0;            // slots held by live <video> elements

  // Videos at once, Auto: the target (see autoStep) and this window's counts.
  // stalls: playing clips that had to wait for data; frames/hitches: Scroll
  // animation frames, and those over 50 ms.
  const auto = { target: AUTO_START, holdUntil: 0, windowAt: 0, stalls: 0, frames: 0, hitches: 0, lastSample: null, log: [] };
  /** How many slots the clips may hold now. */
  const playCap = () => (cfg.playing === 'auto' ? auto.target : cfg.playing);
  let liveRemux = 0;

  // The pool: every id the source matches, in play order, and a buffer of
  // fetched, eligible rows waiting to go up on the wall.
  let poolKey = '';
  let poolIds = null;
  let poolCursor = 0;
  let poolWrapped = false;          // the cursor has been round the whole source (it is small)
  let poolGen = 0;
  let ready = [];
  const skipCounts = new WeakMap(); // buffered row → how often a take passed it over
  let fillPromise = null;
  let poolHasEligible = false;
  const onScreen = new Map();  // id → how many blocks show it
  const badIds = new Set();    // failed to load or play this session
  const freezeCounts = new Map(); // id → how often it froze on the wall this session
  let lastTickAt = 0;          // the freeze watchdog's last tick (0: none since the wall started running)
  const aspectCache = new Map(); // id → the real shape, learned from the element
  const modeCache = new Map();   // id → 'native' | 'remux' | null

  const now = () => Date.now();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /**
   * Every change to a block's swap time goes through here. A held block
   * (Pause on hover) keeps its remaining time in holdLeft, which hoverEnd
   * turns back into a swap time, so it has to follow every new dueAt: a clip
   * that starts during the hover then gets its whole length afterwards.
   */
  function setDue(b, t, at = now()) {
    b.dueAt = t;
    if (b.held) b.holdLeft = t - at;
  }

  /**
   * When a clip that started playing at `startedAt` must give up its block
   * (pure): a converted (remux) clip after REMUX_MAX_RUN_MS, even while it
   * loops, so the one remux slot moves on; a direct clip never (it plays to
   * its end, or for good while it loops).
   */
  function clipDue(mode, startedAt) {
    return mode === 'remux' && startedAt > 0 ? startedAt + REMUX_MAX_RUN_MS : Infinity;
  }

  /**
   * How long (ms) a clip still plays on the wall (pure), from: dueIn (its
   * block's swap time from now, clipDue for a converted clip), held (Pause on
   * hover, with holdLeft the swap time it keeps), leaveIn (Scroll: until it
   * leaves the board) and mediaLeft (until the file ends).
   */
  function clipLeft({ dueIn = Infinity, held = false, holdLeft = Infinity, leaveIn = Infinity, mediaLeft = Infinity } = {}) {
    // A held block gets at least 1.5 s again when the mouse leaves (hoverEnd).
    const swapIn = held ? Math.max(1500, holdLeft) : dueIn;
    const left = Math.min(leaveIn, swapIn, mediaLeft);
    return Number.isNaN(left) ? Infinity : left;
  }

  /**
   * Whether a clip's time is expected to move right now (pure): it started
   * on a running wall, has not ended, and is not held by Pause on hover. In
   * a hidden page (Keep playing when hidden) the browser may hold media back
   * on its own, so a clip there counts only while another clip on the wall
   * is seen moving: a hidden tab alone never makes a clip look stuck.
   */
  function shouldAdvance({ running = false, started = false, ended = false, held = false, hidden = false, keepPlaying = true, othersMoving = false } = {}) {
    if (!running || !started || ended || held) return false;
    if (hidden) return keepPlaying && othersMoving;
    return true;
  }

  /**
   * The freeze watchdog, one tick (pure). `still` is how long (ms) the clip
   * has stood still while it should have moved; returns the new value and
   * whether it is stuck now. Time it was not expected to move starts the
   * count over, and one late tick adds at most FREEZE_DT_MAX_MS.
   */
  function freezeStep(still, { moved = false, should = false, dt = 0 } = {}) {
    if (moved || !should) return { still: 0, frozen: false };
    const next = (Number(still) || 0) + clamp(Number(dt) || 0, 0, FREEZE_DT_MAX_MS);
    return { still: next, frozen: next >= FREEZE_MS };
  }

  /* ── What can go on the wall ────────────────────────────────────────── */

  function kindOf(row) {
    if (!row) return null;
    if (row.media_type === 'image' || row.media_type === 'gif') return 'picture';
    if (row.media_type === 'video') return 'video';
    return null;
  }

  /** 'native' | 'remux' | null, decided the same way the grid's chips decide. */
  function playMode(row) {
    if (modeCache.has(row.id)) return modeCache.get(row.id);
    let mode = null;
    const st = typeof mediaPlaybackState === 'function' ? mediaPlaybackState(row) : { state: 'play' };
    const api = window.VaultPlaybackDecide;
    if (st.state !== 'no') {
      if (api && (row.probe_version || 0) >= 1) {
        const caps = typeof playbackCapsSet === 'function' ? playbackCapsSet() : api.DEFAULT_CAPS;
        const v = api.decide(row, caps);
        mode = v.mode === 'native' || v.mode === 'remux' ? v.mode : null;
      } else if (st.state === 'play') {
        mode = 'native';
      }
    }
    if (mode === 'remux' && !hlsAvailable()) mode = null;
    modeCache.set(row.id, mode);
    return mode;
  }

  function hlsAvailable() {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) return true;
    try { return !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl'); } catch { return false; }
  }

  function eligible(row) {
    const k = kindOf(row);
    if (!k || badIds.has(row.id)) return false;
    if (cfg.mix === 'videos' && k !== 'video') return false;
    if (cfg.mix === 'pictures' && k !== 'picture') return false;
    if (k === 'video') {
      const m = playMode(row);
      if (!m) return false;
      if (m === 'remux' && cfg.directOnly) return false;
    }
    return true;
  }

  /** The stored shape (or one learned from the element earlier), clamped. */
  function aspectOf(row) {
    const learned = aspectCache.get(row.id);
    if (learned) return learned;
    const w = Number(row.width) || 0;
    const h = Number(row.height) || 0;
    return w > 0 && h > 0 ? clamp(w / h, ASPECT_MIN, ASPECT_MAX) : DEFAULT_ASPECT;
  }

  /**
   * Whether the shape the wall uses for this file is settled: stored, or
   * learned. A picture without a stored size is not settled until its shape
   * has been read (or reading it failed, and 16:9 it is); a video without
   * one keeps the 16:9 guess.
   */
  function shapeKnown(row) {
    if (aspectCache.has(row.id) || (Number(row.width) > 0 && Number(row.height) > 0)) return true;
    return kindOf(row) !== 'picture' || probeFailed.has(row.id);
  }

  /*
   * A picture with no stored size would go up as a 16:9 guess and be cropped
   * for its whole life (a slot never changes). So its shape is read first:
   * the picture is loaded off screen (the same URL the block shows, so the
   * block's load is then a cache hit) and the shape remembered. A few at a
   * time; builds and swaps prefer files whose shape is known.
   */
  const PROBE_MAX = 6;
  const probing = new Map();   // id → Promise
  const probeQueue = [];
  const probeFailed = new Set();

  function probeShape(row) {
    if (shapeKnown(row) || kindOf(row) !== 'picture' || probing.has(row.id) || probeFailed.has(row.id) || badIds.has(row.id)) return;
    let resolve;
    const p = new Promise(r => { resolve = r; });
    p._start = () => {
      const img = new Image();
      img.decoding = 'async';
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        if (img.naturalWidth && img.naturalHeight) {
          aspectCache.set(row.id, clamp(img.naturalWidth / img.naturalHeight, ASPECT_MIN, ASPECT_MAX));
        } else {
          probeFailed.add(row.id);
        }
        probing.delete(row.id);
        img.removeAttribute('src');
        probeActive--;
        pumpProbes();
        resolve();
      };
      img.onload = done;
      img.onerror = done;
      timer = setTimeout(done, LOAD_TIMEOUT_MS);
      img.src = `/media/${row.id}`;
    };
    probing.set(row.id, p);
    probeQueue.push(p);
    pumpProbes();
  }

  let probeActive = 0;
  function pumpProbes() {
    while (probeActive < PROBE_MAX && probeQueue.length) {
      probeActive++;
      probeQueue.shift()._start();
    }
  }

  /** Wait (a little) for the shapes of the next files the board will use. */
  async function shapesFor(n, ms) {
    const ps = [];
    for (let i = 0; i < Math.min(n, ready.length); i++) {
      probeShape(ready[i]);
      const p = probing.get(ready[i].id);
      if (p && !shapeKnown(ready[i])) ps.push(p);
    }
    if (!ps.length) return;
    await Promise.race([Promise.all(ps), new Promise(r => setTimeout(r, ms))]);
  }

  function titleOf(row) {
    return row.title || row.filename || '';
  }

  /* ── Source → query spec ────────────────────────────────────────────── */

  function withMix(spec) {
    const want = MIX_TYPES[cfg.mix];
    const have = spec.filters && Array.isArray(spec.filters.mediaTypes) ? spec.filters.mediaTypes : [];
    const types = have.length ? want.filter(t => have.includes(t)) : want;
    if (!types.length) return null;
    return { ...spec, filters: { ...(spec.filters || {}), mediaTypes: types } };
  }

  /** A saved search's stored control state, as a query spec. */
  function savedSearchSpec(s) {
    const st = s.filters || {};
    const [field, dir] = String(st.sortValue || 'processed_desc').split('_');
    return {
      search: {
        text: st.searchText != null ? String(st.searchText) : String(s.search_text || ''),
        metadataOnly: !!st.metadataOnly,
        fuzzy: !!st.fuzzySearch,
        semantic: !!st.semanticSearch,
        subtitles: false,
      },
      filters: {
        mediaTypes: Array.isArray(st.mediaTypes) ? st.mediaTypes : (st.filterType ? [st.filterType] : []),
        safeOnly: !!st.safeOnly,
        extensions: Array.isArray(st.selectedExtensions) ? st.selectedExtensions : [],
        content: st.filterContent || '',
        language: st.filterLanguage || '',
        quality: st.filterQuality || '',
        theme: st.filterTheme || '',
        minRating: st.filterMinRating || '0',
        durMin: typeof st.durMin === 'number' ? st.durMin : 0,
        durMax: typeof st.durMax === 'number' ? st.durMax : null,
        collections: st.filterCollections || '',
        starred: st.filterStarred || '',
        hasNotes: st.filterHasNotes || '',
        flagged: st.filterFlagged || '',
        duplicates: st.filterDuplicates || '',
        scanStatus: st.filterScanStatus || '',
      },
      sort: {
        field: ['processed', 'name', 'size', 'duration', 'rating', 'views', 'done'].includes(field) ? field : 'processed',
        dir: dir === 'asc' ? 'asc' : 'desc',
        favesFirst: !!st.favesFirst,
      },
    };
  }

  /** The spec for the picked source (before the mix), or null when it is gone. */
  function baseSpec() {
    const src = cfg.source;
    if (src.startsWith('c:')) {
      const id = Number(src.slice(2));
      return { collectionId: id };
    }
    if (src.startsWith('s:')) {
      const id = Number(src.slice(2));
      const s = (typeof savedSearches !== 'undefined' ? savedSearches : []).find(x => x.id === id);
      return s ? savedSearchSpec(s) : null;
    }
    // The Library view's own search and filters, whichever tab or
    // collection was on screen before the Wall (each view keeps its own,
    // filters.js SearchScopes). A collection is its own source (c:<id>).
    if (typeof currentQuerySpec === 'function') {
      const spec = currentQuerySpec({ library: true });
      spec.search = { ...spec.search, subtitles: false };
      return spec;
    }
    return {};
  }

  function sourceSpec() {
    const base = baseSpec();
    if (!base) return null;
    return withMix(base);
  }

  function computePoolKey() {
    return JSON.stringify([sourceSpec(), cfg.order, cfg.directOnly]);
  }

  /* ── The pool ───────────────────────────────────────────────────────── */

  function shuffleInPlace(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** How many rows the buffer should hold: a screenful and a half, and some spare. */
  function readyTarget() {
    const W = (els && els.board.clientWidth) || window.innerWidth;
    const H = (els && els.board.clientHeight) || window.innerHeight;
    const cw = Math.max(60, Math.min(W, sizePx() * 0.8));   // Variety makes some blocks smaller
    const est = Math.ceil((W * H * 1.6) / (cw * cw * 0.9));
    return Math.max(40, est + 40);
  }

  async function buildPool() {
    const gen = ++poolGen;
    ready = [];
    poolIds = null;
    poolCursor = 0;
    poolWrapped = false;
    poolHasEligible = false;
    fillPromise = null;
    const spec = sourceSpec();
    if (!spec) return;
    let out;
    try {
      out = await Library.queryOnce(spec, { pageSize: 200, allIds: true });
    } catch (err) {
      if (err && err.code === 'SEMANTIC_UNAVAILABLE') {
        out = await Library.queryOnce({ ...spec, search: { ...spec.search, semantic: false } },
          { pageSize: 200, allIds: true });
      } else {
        throw err;
      }
    }
    if (gen !== poolGen) return;
    const ids = Uint32Array.from(out.ids || []);
    if (cfg.order === 'shuffle') shuffleInPlace(ids);
    poolIds = ids;
    await fill();
  }

  /**
   * Top the buffer up. One call scans a bounded number of ids so a huge
   * library of mostly ineligible files never stalls; a small pool is walked
   * round more than once, which is how a 10-file source still fills a board.
   * `more` fetches one more batch past the usual target (a swap found no
   * file of its slot's shape in the buffer), up to a hard cap.
   */
  function fill(more = false) {
    if (fillPromise) return fillPromise;
    const gen = poolGen;
    fillPromise = (async () => {
      if (!poolIds || !poolIds.length) return;
      const target = fillTarget(ready.length, readyTarget(), more);
      const scanLimit = Math.min(8000, Math.max(target * 3, poolIds.length));
      let scanned = 0;
      while (ready.length < target && scanned < scanLimit) {
        // A whole pass found nothing: the source has nothing the wall can show.
        if (scanned >= poolIds.length && !poolHasEligible) break;
        const ids = [];
        const n = batchSize(ready.length, target, scanLimit - scanned);
        if (n <= 0) break;
        for (let i = 0; i < n; i++) {
          ids.push(poolIds[poolCursor]);
          poolCursor++;
          scanned++;
          if (poolCursor >= poolIds.length) {
            poolCursor = 0;
            poolWrapped = true;
            if (cfg.order === 'shuffle') shuffleInPlace(poolIds);
          }
        }
        let rowsOut;
        try {
          stats.rowFetches++;
          rowsOut = await Library.fetchRows(ids);
        } catch {
          break;
        }
        if (gen !== poolGen) return;
        for (const r of rowsOut) {
          if (r && eligible(r)) { ready.push(r); poolHasEligible = true; probeShape(r); }
        }
      }
    })().finally(() => { if (gen === poolGen) fillPromise = null; });
    return fillPromise;
  }

  function take(i) {
    const out = takeAt(ready, i, skipCounts);
    ready = out.list;
    stats.staleDropped += out.dropped;
    if (ready.length < readyTarget() / 2) fill();
    return out.item;
  }

  /* ── The plan (pure; also exercised by test/wall-layout.test.js) ────── */

  /** Vertical: how far a column's width may stray from the block size (0.6 = 0.4x to 1.6x), from the Variety. */
  const colSpread = (pct) => Math.min(0.6, Math.max(0, pct) * 0.0075);

  /**
   * The Vertical plan: columns of different widths. Each column's width is
   * the block size times a random factor (1 +/- spread), then all are scaled
   * so together they exactly span the board (o: { spread, rand }). With no
   * spread every column is as wide (the Round 2 Columns layout).
   */
  function planColumns(W, colWidth, gap, o = {}) {
    const cols = Math.max(1, Math.round((W + gap) / (colWidth + gap)));
    const spread = clamp(o.spread || 0, 0, 0.6);
    const rand = o.rand || Math.random;
    const raw = [];
    for (let c = 0; c < cols; c++) raw.push(spread ? 1 + (rand() * 2 - 1) * spread : 1);
    const sum = raw.reduce((s, f) => s + f, 0);
    const room = W - gap * (cols - 1);
    const cws = raw.map(f => room * f / sum);
    const colX = [];
    let x = 0;
    for (let c = 0; c < cols; c++) { colX.push(x); x += cws[c] + gap; }
    // The last column ends exactly at the right edge (no rounding sliver).
    cws[cols - 1] = W - colX[cols - 1];
    return { layout: 'columns', cols, cw: room / cols, cws, gap, colX, tops: new Array(cols).fill(0) };
  }

  /** A column's width (plans from before per-column widths have only cw). */
  const colW = (plan, c) => (plan.cws ? plan.cws[c] : plan.cw);

  /**
   * Where the next block of this shape goes: the shortest column, and for a
   * file wider than 2.5:1 also the neighbour of it that is closer to level
   * (always including the shortest column, so the board keeps growing at
   * its lowest point whatever the shapes). `hole` is the space the lower
   * column leaves empty; the picker holds a wide file back while that hole
   * would be big, so in practice it lands where two bottoms are near level.
   * A plan fitted to the screen (Grid, `noSpan`) never spans: each column
   * is scaled on its own to end at the bottom edge.
   */
  function slotFor(plan, aspect) {
    const { cols, cw, gap, colX, tops } = plan;
    let span = cols >= 2 && aspect > WIDE && !plan.noSpan ? 2 : 1;
    let col = 0;
    let y = Infinity;
    let hole = 0;
    for (let c = 0; c < cols; c++) if (tops[c] < y) { y = tops[c]; col = c; }
    if (span === 2) {
      const left = col > 0 ? tops[col - 1] : Infinity;
      const right = col + 1 < cols ? tops[col + 1] : Infinity;
      if (left < right) col -= 1;
      const top = Math.max(tops[col], tops[col + 1]);
      hole = top - Math.min(tops[col], tops[col + 1]);
      y = top;
      // Too ragged to span (a source of nothing but panoramas gets here):
      // one column, still at its exact shape, instead of a big empty hole.
      if (hole > cw * 0.25) {
        span = 1;
        hole = 0;
        y = Infinity;
        for (let c = 0; c < cols; c++) if (tops[c] < y) { y = tops[c]; col = c; }
      }
    }
    const w = span === 2 ? colW(plan, col) + colW(plan, col + 1) + gap : colW(plan, col);
    return { col, span, x: colX[col], y, w, h: w / aspect, hole };
  }

  /**
   * Grid: the plan fitted to the screen (pure). Returns the slots moved so
   * the board ends exactly at the bottom edge H, every file at its shape:
   *  - Slices: every slice scaled by one factor s = H / content height
   *    (never above 1, which would make the slices wider than the board),
   *    each centered, leaving black bars at the sides.
   *  - Columns: each column scaled on its own so it ends at H (never above
   *    1), and centered in its place.
   * Each slot gains `s`, the factor it was scaled by.
   */
  function fitGrid(plan, slots, H, W) {
    if (plan.layout === 'slices') {
      let bottom = 0;
      for (const sl of slots) bottom = Math.max(bottom, sl.y + sl.h);
      const s = bottom > 0 ? Math.min(1, H / bottom) : 1;
      const ox = (W - W * s) / 2;
      return slots.map(sl => ({ ...sl, x: ox + sl.x * s, y: sl.y * s, w: sl.w * s, h: sl.h * s, s }));
    }
    const bottoms = new Array(plan.cols).fill(0);
    for (const sl of slots) bottoms[sl.col] = Math.max(bottoms[sl.col], sl.y + sl.h);
    return slots.map((sl) => {
      const s = bottoms[sl.col] > 0 ? Math.min(1, H / bottoms[sl.col]) : 1;
      const w = sl.w * s;
      return { ...sl, x: plan.colX[sl.col] + (colW(plan, sl.col) - w) / 2, y: sl.y * s, w, h: sl.h * s, s };
    });
  }

  /**
   * The gap between two rects { x, y, w, h } (pure): the larger of the
   * horizontal and vertical distance, so 0 or a gap's width means they
   * touch (corners too) and a negative value that they overlap.
   */
  function rectGap(a, b) {
    const dx = Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w);
    const dy = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
    return Math.max(dx, dy);
  }

  function placeSlot(plan, s) {
    for (let c = s.col; c < s.col + s.span; c++) plan.tops[c] = s.y + s.h + plan.gap;
  }

  /** The content bottom of the shortest column (Slices: of the last slice). */
  function minBottom(plan) {
    if (plan.layout === 'slices') return plan.bottom - plan.gap;
    let m = Infinity;
    for (const t of plan.tops) m = Math.min(m, t - plan.gap);
    return m;
  }

  /*
   * Slices: full-width rows of different heights instead of columns. A slice
   * takes files until their shapes, at the slice's target height, fill the
   * width, then its exact height is solved so the row ends flush at the
   * right edge. Every file keeps its exact shape, so the fixed slots and the
   * swap pick work as they do for columns. The plan has one bottom edge.
   */
  const SLICE_MIN = 0.45;            // a slice's height, as a share of the block size
  const SLICE_MAX = 2.2;
  const SLICE_ITEMS = 24;            // the most files one slice holds

  /**
   * The Slices plan. `blockSize` is the base slice height; on a narrow board
   * it is capped so a 16:9 file at that height still fits the width.
   */
  function planSlices(W, blockSize, gap) {
    const base = Math.max(40, Math.min(blockSize, W / 1.8));
    return { layout: 'slices', cols: 0, cw: 0, gap, colX: [], tops: [], base, bottom: 0 };
  }

  /**
   * One slice (pure). `cands` are the files it may use, best first, as
   * { a: aspect, px: the short side in pixels, 0 when unknown }. `o` gives
   * { W, base, gap, variety (0..1), byRes, rand () => [0, 1) }.
   *
   * The target height is the block size times a random variety factor
   * (0.3x to 1.7x at full variety), nudged up for a high-resolution first
   * file and down for a small one. Files join in order until the solved
   * height drops to the target; the last one joins only if that lands closer
   * to the target. A file that would make the slice shorter than the floor
   * waits for a later slice. A file never appears twice in a slice: when the
   * candidates run out the slice stops where it is, even taller than the
   * ceiling (Grid scales the board down to fit). Only with `o.repeat` (the
   * caller passed every file the source has) do the slice's own files
   * repeat, in turn, so each copy is as far from the other as the slice
   * allows.
   *
   * Returns { picks: indices into cands (a repeat appears twice), h, target, lo, hi }.
   * h is exact: (W - gaps) / sum of the aspects. It is outside lo..hi only
   * when no choice of the files given can do better (one file wider than
   * the board at the floor height, or too few files).
   */
  function sliceRow(cands, o) {
    if (!cands.length) return null;
    const { W, base, gap } = o;
    const lo = base * SLICE_MIN;
    const hi = base * SLICE_MAX;
    const hOf = (sum, n) => (W - gap * (n - 1)) / sum;
    // Grid (o.fitLeft: the height left above the bottom edge): the last
    // slice aims at exactly what is left and stops at or above it, so the
    // board needs only a small scale down to end at the edge; a slice
    // before it leaves at least a floor-height slice of room.
    const fit = o.fitLeft != null;
    const last = fit && o.fitLeft <= hi;
    let target = 0;
    let first = -1;
    if (last) {
      target = clamp(o.fitLeft, lo, hi);
      first = cands.findIndex(c => hOf(c.a, 1) >= target);
    }
    // The first file: the first one that can start a slice at least lo tall.
    if (first < 0) first = cands.findIndex(c => hOf(c.a, 1) >= lo);
    if (first < 0) first = 0;
    if (!last) {
      const f = 1 + (o.rand() * 2 - 1) * clamp(o.variety, 0, 1) * 0.7;
      target = base * Math.max(0.45, f);
      const px = cands[first].px;
      if (o.byRes && px > 0) target *= clamp(Math.pow(px / 720, 0.35), 0.7, 1.35);
      if (fit) target = Math.min(target, o.fitLeft - lo);
      target = clamp(target, lo, hi);
    }

    const picks = [first];
    const used = new Set(picks);
    let sum = cands[first].a;
    let h = hOf(sum, 1);
    let next = 0;
    let rep = 0;
    let spare = -1;            // the last Grid slice: the file to add if nothing keeps it at or above the target
    for (let tries = 0; h > target && picks.length < SLICE_ITEMS && tries < SLICE_ITEMS * 3; tries++) {
      while (next < cands.length && used.has(next)) next++;
      // Out of files: stop if the slice can, or a spare can end it; repeat only when allowed.
      if (next >= cands.length && (!o.repeat || h <= hi || spare >= 0)) break;
      const j =next < cands.length ? next++ : picks[rep++ % picks.length];
      used.add(j);
      const hn = hOf(sum + cands[j].a, picks.length + 1);
      const stopOk = h <= hi;
      const addOk = hn >= lo;
      // Past the target with it: it joins if that lands closer (never for
      // the last Grid slice, which stays at or above it), or if stopping is no option.
      const closer = !last && Math.log(target / hn) < Math.log(h / target);
      if (last && hn < target && !stopOk) {
        // Still too tall to stop, and this file would take it under the
        // height left: look for one that does not, keeping this as a spare.
        if (addOk && (spare < 0 || hn > hOf(sum + cands[spare].a, picks.length + 1))) spare = j;
        continue;
      }
      if (hn < target && !(addOk && (!stopOk || closer))) {
        if (stopOk) break;
        continue;             // too wide for this slice: it waits
      }
      picks.push(j);
      sum += cands[j].a;
      h = hn;
      spare = -1;
    }
    if (last && h > hi && spare >= 0) {
      picks.push(spare);
      sum += cands[spare].a;
      h = hOf(sum, picks.length);
    }
    return { picks, h, target, lo, hi };
  }

  /**
   * The candidates for the next slice, best first (pure). `front` is the
   * front of the buffer (rows with an id), `shown` the blocks on the board
   * as { item, x, y, w, h }, `o` gives { known(r): shape known, W, max,
   * wrapped: the buffer has been round the whole source }.
   *
   * Each file comes once. Files not on screen come first, in buffer order
   * (a shape still being read later). Then files already on screen, the
   * ones farthest above the bottom edge first; the files of the slice
   * directly above (which the new slice touches) come last, those at its
   * right end first, as the new slice fills from the left. At most `max`.
   *
   * Returns { pool: [{ r, fromReady }], repeat }. repeat is true when the
   * pool holds every file there is to show (a small source the buffer has
   * been round), so sliceRow may repeat files rather than leave the slice
   * short. A buffer that is short for now does not count.
   */
  function slicePool(front, shown, o) {
    let lastY = -Infinity;
    let edge = 0;
    for (const b of shown) { lastY = Math.max(lastY, b.y); edge = Math.max(edge, b.y + b.h); }
    const lowest = new Map();      // id -> the lowest bottom of its blocks
    const above = new Map();       // id -> its rightmost center in the slice above
    for (const b of shown) {
      if (!b.item) continue;
      const id = b.item.id;
      lowest.set(id, Math.max(lowest.get(id) || 0, b.y + b.h));
      if (Math.abs(b.y - lastY) < 0.5) above.set(id, Math.max(above.get(id) || 0, b.x + b.w / 2));
    }
    const repeatScore = (id) => {
      if (above.has(id)) return 100 + (1 - above.get(id) / Math.max(1, o.W));
      if (lowest.has(id)) return 10 + Math.min(1, lowest.get(id) / Math.max(1, edge));
      return 0;
    };
    const seen = new Set();
    const pool = [];
    front.forEach((r, i) => {
      if (seen.has(r.id)) return;
      seen.add(r.id);
      pool.push({ r, fromReady: true, score: i * 0.01 + (o.known(r) ? 0 : 3) + repeatScore(r.id) });
    });
    for (const b of shown) {
      if (!b.item || seen.has(b.item.id)) continue;
      seen.add(b.item.id);
      pool.push({ r: b.item, fromReady: false, score: repeatScore(b.item.id) });
    }
    pool.sort((p, q) => p.score - q.score);
    return { pool: pool.slice(0, o.max), repeat: !!o.wrapped && pool.length <= o.max };
  }

  /**
   * The slots of one slice of height h at the plan's bottom edge (aspects
   * in order), and the bottom edge moved below it. The last slot ends
   * exactly at the right edge.
   */
  function placeSlice(plan, aspects, h, W) {
    const y = plan.bottom;
    const out = [];
    let x = 0;
    aspects.forEach((a, k) => {
      const w = k === aspects.length - 1 ? Math.max(1, W - x) : a * h;
      out.push({ x, y, w, h });
      x += w + plan.gap;
    });
    plan.bottom = y + h + plan.gap;
    return out;
  }

  /**
   * Index of the best next item for the board being built: early in the
   * queue, not already on screen, and (for a wide file) only where its two
   * columns are close to level. A file on screen comes after every file
   * that is not, and one shown in a block its slot would touch
   * (`touches(r, slot)`) after those.
   */
  function buildIndex(plan, list, isOnScreen, touches) {
    const n = Math.min(LOOKAHEAD, list.length);
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const r = list[i];
      let score = i * 0.01;
      if (!shapeKnown(r)) score += 3;
      const s = slotFor(plan, aspectOf(r));
      if (isOnScreen(r)) score += touches && touches(r, s) ? 40 : 10;
      // A wide file waits for two columns that are near level.
      if (s.span === 2 && s.hole > plan.cw * 0.12) score += 5 + s.hole / plan.cw;
      else if (s.span === 1 && plan.cols >= 2 && aspectOf(r) > WIDE && !plan.noSpan) score += 6;
      if (plan.fitH) score += fitScore(s.h, plan.fitH - s.y, s.w);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /**
   * Grid, Vertical: how well a file of height h suits a column with `left`
   * px to go to the bottom edge (pure; lower is better, 0 = no preference).
   * Near the bottom the column is scaled down to end at the edge by
   * (filled + h) / filled, so a last file that ends just past the edge is
   * best; one that leaves a gap too small for any other file is worst.
   */
  function fitScore(h, left, w) {
    if (left > w * 1.8) return 0;               // plenty of room yet
    if (h >= left) return 2 * (h - left) / Math.max(left, w * 0.25);
    if (left - h >= w * 0.5) return 0.1;        // room for one more file
    return 1.5;
  }

  /**
   * Index of the file a swap should bring into a slot of shape `aspect`
   * (pure: `o` gives aspectOf(r), usable(r), onScreen(r), touching(r),
   * currentId, order). touching(r): a block next to the slot shows r.
   *
   * Any file within the tolerance fits, wherever it sits in the buffer; a
   * file not on screen beats one that is, one shown next to the slot comes
   * after those, and the slot's current file comes last. A fresh or
   * elsewhere-shown file is cropped in rather than a fitting one placed next
   * to its copy. The position only chooses among fits, never whether one fits:
   * "In order" takes the fit closest to the front, Shuffle weighs a closer
   * shape against a place further back (a perfect fit is worth about 70
   * places), so the buffer is used from the front. `fit` is false when
   * nothing fits and the closest shape will be cropped into the slot.
   */
  function pickSwap(list, aspect, o) {
    let best = -1;
    let bestDup = Infinity;
    let bestKey = Infinity;
    let crop = -1;
    let cropDup = Infinity;
    let cropKey = Infinity;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      // A file whose shape is not known yet (still being read) waits: as a
      // guess it could be anything, and the slot would crop it badly.
      if (!o.usable(r)) continue;
      const dup = (o.currentId != null && r.id === o.currentId) ? 3
        : !o.onScreen(r) ? 0 : (o.touching && o.touching(r)) ? 2 : 1;
      const d = Math.abs(Math.log(o.aspectOf(r) / aspect));
      if (d <= SHAPE_TOL) {
        const key = o.order === 'order' ? i : d + i * 0.002;
        if (dup < bestDup || (dup === bestDup && key < bestKey)) { best = i; bestDup = dup; bestKey = key; }
      }
      // Nothing fits: the closest shape, so the crop is as small as it can be.
      if (dup < cropDup || (dup === cropDup && d < cropKey)) { crop = i; cropDup = dup; cropKey = d; }
    }
    // A file next to its copy only when every other file would be too; the
    // slot's own file again only when everything else would be a repeat.
    if (best >= 0 && (bestDup <= 1 || (bestDup === 2 && cropDup >= 2) || (bestDup === 3 && cropDup >= 1))) {
      return { i: best, fit: true };
    }
    return { i: crop, fit: false };
  }

  function swapIndex(list, b) {
    return pickSwap(list, b.aspect, {
      aspectOf,
      usable: (r) => !badIds.has(r.id) && shapeKnown(r),
      onScreen: isOnScreen,
      touching: (r) => touchesCopy(r.id, b, b),
      currentId: b.item ? b.item.id : null,
      order: cfg.order,
    });
  }

  /* The buffer: bounded, and files nobody takes do not sit in it forever. */

  const BATCH = 150;            // ids per row fetch
  const STALE_SKIPS = 150;      // a file passed over this often leaves the buffer

  /** How many rows a top-up aims for: the usual target, or one batch past what is held; never past the cap. */
  function fillTarget(held, base, more) {
    return Math.min(READY_CAP, more ? Math.max(base, held + BATCH) : base);
  }

  /** How many ids the next fetch takes: never more than the room left (an id gives at most one row). */
  function batchSize(held, target, scanLeft) {
    return Math.max(0, Math.min(BATCH, scanLeft, target - held));
  }

  /**
   * Take list[i] out of the buffer. Every file in front of it was passed
   * over once more; one passed over STALE_SKIPS times (a rare shape no slot
   * wants) is dropped, so it stops holding a place at the front. It comes
   * round again with the pool. Returns { item, list, dropped }.
   */
  function takeAt(list, i, skips) {
    const item = list.splice(i, 1)[0];
    skips.delete(item);
    let stale = 0;
    for (let k = 0; k < i && k < list.length; k++) {
      const n = (skips.get(list[k]) || 0) + 1;
      skips.set(list[k], n);
      if (n >= STALE_SKIPS) stale++;
    }
    if (!stale) return { item, list, dropped: 0 };
    const kept = list.filter((r) => {
      if ((skips.get(r) || 0) < STALE_SKIPS) return true;
      skips.delete(r);
      return false;
    });
    return { item, list: kept, dropped: stale };
  }

  /* ── DOM ────────────────────────────────────────────────────────────── */

  /*
   * The bar: every common setting is a chip that shows its value and opens
   * a short menu of choices under it (radio items, a check on the current
   * one, a small sub-label on the right). A section with a title starts
   * with it, one without starts after a line. Layout, Size and Variety
   * share one chip. Sound's items set two settings (sound and soundEvery)
   * through the made-up key 'soundPick'. Order ends in an action (Shuffle
   * again), shown only with Shuffle. The rarely changed ones are under More.
   */
  const opt = (v, label, short = label, sub = '') => ({ v, label, short, sub });
  const PACE_SUB = {
    grid: { slow: 'every 25 s', medium: 'every 15 s', fast: 'every 10 s' },
    scroll: { slow: 'gentle', medium: 'steady', fast: 'brisk' },
  };
  const CHIPS = {
    order: { label: 'Order', title: 'The order files go up in',
      sections: [{ key: 'order', options: [opt('shuffle', 'Shuffle'), opt('order', 'In order')] }],
      action: { id: 'shuffleAgain', label: 'Shuffle again', title: 'Start over with a fresh shuffle' } },
    layout: { label: 'Layout', title: 'How the blocks are laid out, and how big they are',
      sections: [
        { key: 'layout', title: 'Layout', options: [opt('horizontal', 'Horizontal', 'Horizontal', 'rows'), opt('vertical', 'Vertical', 'Vertical', 'columns')] },
        { key: 'size', title: 'Size', options: [opt('small', 'Small'), opt('medium', 'Medium'), opt('large', 'Large')] },
        { key: 'variety', title: 'Variety', options: [opt('even', 'Even'), opt('mixed', 'Mixed'), opt('wild', 'Wild')] },
      ] },
    // Sub-labels and the note depend on the mode (syncControls).
    pace: { label: 'Pace', title: '', note: ' ',
      sections: [{ key: 'pace', options: [opt('slow', 'Slow'), opt('medium', 'Medium'), opt('fast', 'Fast')] }] },
    sound: { label: 'Sound', title: 'Which clip you hear',
      sections: [
        { key: 'soundPick', options: [opt('off', 'Off'), opt('hover', 'On hover'), opt('follow', 'Follow one clip', 'Follow', 'until it ends')] },
        { key: 'soundPick', title: 'Rotate to another clip', options: [
          ...[10, 20, 30, 60].map(n => opt(String(n), `Every ${n} s`)), opt('mix', 'Mix it up', 'Mix it up', '10 to 40 s')] },
      ] },
    // Auto's sub-label ("now N") follows the target (syncControls).
    playing: { label: 'Videos', title: 'How many videos play at once',
      note: 'Auto adds clips while playback is smooth and drops one when frames start to skip.',
      sections: [
        { key: 'playing', options: [opt('auto', 'Auto', 'Auto', ' ')] },
        { key: 'playing', options: R.PLAYING.filter(n => n !== 'auto').map(n => opt(n, String(n))) },
      ] },
  };

  /** The value a menu item's key stands for (soundPick: the Sound choice as one value). */
  function menuValue(key) {
    if (key === 'soundPick') return cfg.sound === 'rotate' ? String(cfg.soundEvery) : cfg.sound;
    return cfg[key];
  }

  const caret = () => `${typeof vaultIcon === 'function' ? vaultIcon('chevron', 'modern-only wall-caret') : ''}<span class="classic-only wall-caret" aria-hidden="true">&#9662;</span>`;

  function chipHtml(name) {
    const d = CHIPS[name];
    const cap = name[0].toUpperCase() + name.slice(1);
    const sep = (attrs = '') => `<div class="wall-menu-sep" role="separator"${attrs}></div>`;
    let items = d.sections.map((s, i) => `${i && !s.title ? sep() : ''}${s.title ? `<div class="wall-menu-head" role="presentation">${s.title}</div>` : ''}${
      s.options.map(o => `<button type="button" class="wall-menu-item" role="menuitemradio" aria-checked="false" tabindex="-1" data-key="${s.key}" data-value="${o.v}"><span class="wall-menu-label">${o.label}</span><span class="wall-menu-sub">${o.sub.trim()}</span></button>`).join('')}`).join('');
    if (d.note) items += `<div class="wall-menu-note" role="presentation">${d.note.trim()}</div>`;
    if (d.action) {
      items += `${sep(' data-action-sep')}<button type="button" class="wall-menu-item wall-menu-action" role="menuitem" tabindex="-1" data-action="${d.action.id}" title="${d.action.title}">${d.action.label}</button>`;
    }
    return `<span class="wall-chip-wrap" id="wallChip${cap}Wrap">
        <button type="button" class="wall-chip" id="wallChip${cap}" data-chip="${name}" aria-haspopup="menu" aria-expanded="false" aria-controls="wallMenu${cap}"${d.title ? ` title="${d.title}"` : ''}>
          <span class="wall-chip-k">${d.label}</span><span class="wall-chip-v" id="wallChip${cap}Val"></span>${caret()}
        </button>
        <div class="wall-menu" id="wallMenu${cap}" role="menu" aria-label="${d.label}" hidden>${items}</div>
      </span>`;
  }

  function ensureDom() {
    if (els) return;
    const root = document.getElementById('wallContainer');
    root.classList.add('wall-root');
    root.innerHTML = `
      <div class="wall-bar" id="wallBar">
        <label class="wall-chip wall-chip-select" title="What the wall shows">
          <span class="wall-chip-k">Source</span>
          <select id="wallSource" class="wall-chip-sel"></select>
        </label>
        ${chipHtml('order')}
        <div class="wall-seg" role="group" aria-label="Wall mode">
          <button type="button" class="wall-seg-btn" id="wallModeGrid" data-mode="grid">Grid</button>
          <button type="button" class="wall-seg-btn" id="wallModeScroll" data-mode="scroll">Scroll</button>
        </div>
        ${chipHtml('layout')}
        ${chipHtml('pace')}
        ${chipHtml('sound')}
        ${chipHtml('playing')}
        <button type="button" class="wall-btn" id="wallPauseBtn">Pause</button>
        <span class="wall-note" id="wallNote" hidden>Paused for reduced motion</span>
        <span class="wall-status" id="wallStatus"></span>
        <button type="button" class="wall-btn" id="wallMoreBtn" title="More settings"
          aria-haspopup="dialog" aria-expanded="false" aria-controls="wallPop">More</button>
        <button type="button" class="wall-btn" id="wallFullBtn">Full screen</button>
        <div class="wall-pop" id="wallPop" role="dialog" aria-label="More settings" hidden>
          <label class="wall-pop-row">
            <span class="wall-label">Show</span>
            <select id="wallMix" class="m-select">
              <option value="both">Videos and pictures</option>
              <option value="videos">Videos only</option>
              <option value="pictures">Pictures only</option>
            </select>
          </label>
          <label class="wall-check" title="Hovering a block holds it: its timer waits, and Scroll mode stops drifting.">
            <input type="checkbox" id="wallHoverPause" class="m-check"> Pause on hover</label>
          <label class="wall-check" title="Skip videos that need converting on the fly. They are heavier to play.">
            <input type="checkbox" id="wallDirect" class="m-check"> Only files that play without converting</label>
          <label class="wall-check" title="On: the Wall keeps playing while you use another tab or window. Off: a hidden tab pauses it to save power.">
            <input type="checkbox" id="wallKeepPlaying" class="m-check"> Keep playing when this tab is hidden</label>
          <label class="wall-check" id="wallLoopRow" title="Off: when a clip ends, a new file that fits its block takes its place. On: the clip starts over and stays.">
            <input type="checkbox" id="wallLoop" class="m-check"> Loop clips instead of changing them</label>
        </div>
      </div>
      <div class="wall-stage">
        <div class="wall-board" id="wallBoard"><div class="wall-track" id="wallTrack"></div></div>
        <div class="wall-msg" id="wallMsg" hidden></div>
        <div class="wall-paused" id="wallPaused" hidden>Paused</div>
        <div class="wall-soundnote" id="wallSoundNote" hidden>Click the wall to turn sound on</div>
      </div>`;
    const $ = (id) => root.querySelector('#' + id);
    els = {
      root,
      bar: $('wallBar'),
      board: $('wallBoard'),
      track: $('wallTrack'),
      msg: $('wallMsg'),
      paused: $('wallPaused'),
      status: $('wallStatus'),
      note: $('wallNote'),
      source: $('wallSource'),
      modeGrid: $('wallModeGrid'),
      modeScroll: $('wallModeScroll'),
      chips: {},
      more: $('wallMoreBtn'),
      pop: $('wallPop'),
      mix: $('wallMix'),
      hoverPause: $('wallHoverPause'),
      soundNote: $('wallSoundNote'),
      direct: $('wallDirect'),
      keep: $('wallKeepPlaying'),
      pauseBtn: $('wallPauseBtn'),
      loop: $('wallLoop'),
      loopRow: $('wallLoopRow'),
      fullBtn: $('wallFullBtn'),
    };
    for (const name of Object.keys(CHIPS)) {
      const cap = name[0].toUpperCase() + name.slice(1);
      els.chips[name] = { wrap: $(`wallChip${cap}Wrap`), btn: $(`wallChip${cap}`), val: $(`wallChip${cap}Val`), menu: $(`wallMenu${cap}`) };
    }
    wireControls();
    wireBoard();
    syncControls();
  }

  /** The words a chip shows for a setting's value. */
  function chipText(name) {
    if (name === 'playing' && cfg.playing === 'auto') return `Auto (${auto.target})`;
    const key = CHIPS[name].sections[0].key;
    const v = menuValue(key);
    for (const s of CHIPS[name].sections) {
      const o = s.key === key && s.options.find(x => String(x.v) === String(v));
      if (o) return o.short;
    }
    return String(v);
  }

  function syncControls() {
    const scroll = cfg.mode === 'scroll';
    els.modeGrid.setAttribute('aria-pressed', String(!scroll));
    els.modeScroll.setAttribute('aria-pressed', String(scroll));
    for (const [name, c] of Object.entries(els.chips)) {
      c.val.textContent = chipText(name);
      for (const it of c.menu.querySelectorAll('.wall-menu-item[data-key]')) {
        const v = menuValue(it.dataset.key);
        it.setAttribute('aria-checked', String(String(v) === it.dataset.value));
      }
    }
    // Shuffle again: only with Shuffle (In order has nothing to shuffle).
    const shuffling = cfg.order === 'shuffle';
    for (const el of els.chips.order.menu.querySelectorAll('[data-action], [data-action-sep]')) el.hidden = !shuffling;
    // Pace: what each choice means in this mode.
    const paceSub = PACE_SUB[scroll ? 'scroll' : 'grid'];
    for (const it of els.chips.pace.menu.querySelectorAll('.wall-menu-item[data-value]')) {
      it.querySelector('.wall-menu-sub').textContent = paceSub[it.dataset.value] || '';
    }
    els.chips.pace.menu.querySelector('.wall-menu-note').textContent = scroll ? 'How fast the wall scrolls.' : 'How often pictures change.';
    els.chips.playing.menu.querySelector('[data-value="auto"] .wall-menu-sub').textContent = `now ${auto.target}`;
    const lay3 = els.chips.layout;
    lay3.btn.title = `${CHIPS.layout.title}. Now: ${lay3.val.textContent}, ${cfg.size} size, ${cfg.variety} variety.`;
    // Pace is how often pictures change in Grid, how fast the wall moves in Scroll.
    els.chips.pace.btn.title = scroll ? 'How fast the wall scrolls' : `How often pictures change (now every ${picSec()} s)`;
    // No clips when only pictures are shown.
    els.loopRow.hidden = cfg.mix === 'pictures';
    els.chips.playing.wrap.hidden = cfg.mix === 'pictures';
    els.chips.sound.wrap.hidden = cfg.mix === 'pictures';
    els.mix.value = cfg.mix;
    els.hoverPause.checked = cfg.pauseOnHover;
    els.direct.checked = cfg.directOnly;
    els.keep.checked = cfg.keepPlaying2;
    els.loop.checked = cfg.loopClips;
    els.note.hidden = !reducedNote;
  }

  function populateSources() {
    const sel = els.source;
    const opts = ['<option value="library">Current library filter</option>'];
    const colls = (typeof collectionsList !== 'undefined' ? collectionsList : [])
      .filter(c => c.kind !== 'folder');
    if (colls.length) {
      opts.push('<optgroup label="Collections">');
      for (const c of colls) opts.push(`<option value="c:${c.id}">${escapeHtml(c.name || 'Untitled')}</option>`);
      opts.push('</optgroup>');
    }
    const saved = typeof savedSearches !== 'undefined' ? savedSearches : [];
    if (saved.length) {
      opts.push('<optgroup label="Saved searches">');
      for (const s of saved) opts.push(`<option value="s:${s.id}">${escapeHtml(s.name || 'Untitled')}</option>`);
      opts.push('</optgroup>');
    }
    sel.innerHTML = opts.join('');
    // A collection or saved search that has since been deleted falls back.
    if (![...sel.options].some(o => o.value === cfg.source)) {
      cfg.source = 'library';
      saveCfg();
    }
    sel.value = cfg.source;
  }

  function debounce(fn, ms) {
    let t = null;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }

  /** Entering Scroll with reduced motion asked for: start paused, say why. */
  function applyReducedMotion() {
    if (cfg.mode !== 'scroll') { reducedDone = false; if (reducedNote) { reducedNote = false; syncControls(); } return; }
    if (reducedDone || !reducedMotion()) return;
    reducedDone = true;
    reducedNote = true;
    userPaused = true;
    syncControls();
  }

  function setPaused(p) {
    userPaused = p;
    if (!p && reducedNote) { reducedNote = false; els.note.hidden = true; }
    evaluate();
  }

  /** A chip's menu item was picked: store the value and do what it changes. */
  function pickChoice(key, raw) {
    if (key === 'soundPick') {
      // One value for the two Sound settings: off / hover / follow, or how often Rotate moves.
      const every = R.SOUND_EVERY.find(x => String(x) === raw);
      const sound = every !== undefined ? 'rotate' : R.SOUNDS.find(x => x === raw && x !== 'rotate');
      if (!sound || (sound === cfg.sound && (every === undefined || every === cfg.soundEvery))) return;
      cfg.sound = sound;
      if (every !== undefined) cfg.soundEvery = every;
      rotateWait = 0;   // a new Rotate timing starts from the clip heard now
      saveCfg();
      syncControls();
      syncAudio();
      return;
    }
    const lists = { order: R.ORDERS, layout: R.LAYOUTS, size: R.SIZES, variety: R.VARIETIES, pace: R.PACES, playing: R.PLAYING };
    const v = (lists[key] || []).find(x => String(x) === raw);
    if (v === undefined || v === cfg[key]) return;
    cfg[key] = v;
    saveCfg();
    syncControls();
    if (key === 'order') rebuild();
    else if (key === 'layout' || key === 'size' || key === 'variety') replan(true);
    else if (key === 'pace') retimeStills();
    else if (key === 'playing') { trimVideos(); fillSlots(); }
  }

  function wireControls() {
    for (const [name, c] of Object.entries(els.chips)) {
      c.btn.addEventListener('click', () => setMenu(openMenu === name ? null : name));
      c.menu.addEventListener('click', (e) => {
        const it = e.target.closest('.wall-menu-item');
        if (!it) return;
        if (it.dataset.action === 'shuffleAgain') shuffleNow();
        else pickChoice(it.dataset.key, it.dataset.value);
        setMenu(null);
        c.btn.focus();
      });
      c.menu.addEventListener('keydown', (e) => menuKey(e, c.menu));
    }

    els.source.addEventListener('change', () => { cfg.source = els.source.value; saveCfg(); rebuild(); });
    els.mix.addEventListener('change', () => { cfg.mix = els.mix.value; saveCfg(); syncControls(); rebuild(); });
    els.direct.addEventListener('change', () => { cfg.directOnly = els.direct.checked; saveCfg(); rebuild(); });
    els.hoverPause.addEventListener('change', () => {
      cfg.pauseOnHover = els.hoverPause.checked;
      saveCfg();
      // A block hovered right now takes the new rule at once.
      const b = hoverBlock;
      if (b) { hoverEnd(b); hoverStart(b); }
    });
    els.loop.addEventListener('change', () => {
      cfg.loopClips = els.loop.checked;
      saveCfg();
      // The clips playing now take it at once: a looping clip that stops
      // looping plays on to its end, then the next file takes the block.
      for (const rec of liveRecs()) rec.v.loop = cfg.loopClips;
    });
    els.keep.addEventListener('change', () => {
      cfg.keepPlaying2 = els.keep.checked;
      saveCfg();
      evaluate();
    });

    for (const btn of [els.modeGrid, els.modeScroll]) {
      btn.addEventListener('click', () => {
        const m = btn.dataset.mode;
        if (m === cfg.mode) return;
        cfg.mode = m;
        saveCfg();
        applyReducedMotion();
        syncControls();
        replan(true);
      });
    }

    els.pauseBtn.addEventListener('click', () => setPaused(!userPaused));
    els.fullBtn.addEventListener('click', toggleFullscreen);

    // The menus: Escape or a click outside closes them. A click on the
    // board that closes one only closes it (it does not also open a file).
    els.more.addEventListener('click', () => setMenu(openMenu === 'more' ? null : 'more'));
    // Only a primary-button press on the board is followed by a click to swallow.
    const swallowNext = (e) => {
      if (e.button === 0 && els.board.contains(e.target)) swallowUntil = now() + SWALLOW_MS;
    };
    // Registered first, so every press ends what an earlier one left behind.
    document.addEventListener('pointerdown', () => { swallowUntil = 0; }, true);
    document.addEventListener('pointerdown', (e) => {
      if (!openMenu) return;
      const p = menuParts(openMenu);
      if (p && (p.menu.contains(e.target) || p.btn.contains(e.target))) return;
      setMenu(null);
      swallowNext(e);
    }, true);
    // The browser refused sound before a click: this click (a user gesture)
    // turns it on. On the board it only does that; it does not open a file.
    document.addEventListener('pointerdown', (e) => {
      if (!soundBlocked || !active) return;
      swallowNext(e);
      soundBlocked = false;
      els.soundNote.hidden = true;
      for (const rec of liveRecs()) applyGain(rec);
    }, true);
    document.addEventListener('keydown', onKey);

    document.addEventListener('fullscreenchange', () => {
      // A clip opened from the full-screen wall goes full screen on top of it
      // (openItem), and the wall stays full screen underneath: kept as is, so
      // the board does not change size behind the player.
      const top = document.fullscreenElement;
      const was = rootFs;
      rootFs = top === els.root || (rootFs && !!top && top === document.getElementById('mediaPlayerOverlay'));
      els.root.classList.toggle('wall-fs', rootFs);
      els.fullBtn.textContent = rootFs ? 'Leave full screen' : 'Full screen';
      if (top === els.root) showBarBriefly();
      else if (!rootFs) { clearTimeout(fsTimer); els.root.classList.remove('wall-bar-idle'); }
      // In full screen the browser takes Escape for itself and leaves every
      // level at once. Locking it (Chromium only) hands it to the page, so
      // Escape can go back one step: the player to the wall, then the wall out
      // of full screen. Holding Escape still leaves full screen.
      const kb = navigator.keyboard;
      if (rootFs && !was && kb && kb.lock) kb.lock(['Escape']).catch(() => {});
      else if (!rootFs && was && kb && kb.unlock) kb.unlock();
    });
    els.root.addEventListener('mousemove', () => { if (els.root.classList.contains('wall-fs')) showBarBriefly(); });
    els.bar.addEventListener('focusin', () => { if (els.root.classList.contains('wall-fs')) showBarBriefly(); });
    document.addEventListener('visibilitychange', evaluate);

    // The board's size is what the plan is made of: plan again once the
    // resizing has stopped.
    new ResizeObserver(debounce(() => { if (active && built) refitBoard(); }, 300)).observe(els.board);
    window.addEventListener('resize', () => { if (active) placeRoot(); });
    // The header can change height without the window resizing (its rows wrap).
    const header = document.getElementById('appHeader');
    if (header) new ResizeObserver(() => { if (active) placeRoot(); }).observe(header, { box: 'border-box' });

    // A closing or reloading page never reaches leave(): release every clip so
    // each remux stream sends its close beacon (the player does the same).
    window.addEventListener('pagehide', () => { if (liveCost > 0) releaseAllVideos(); });

    // The player (full or mini) opening over the wall pauses it; closing resumes.
    const ov = document.getElementById('mediaPlayerOverlay');
    const mini = document.getElementById('miniPlayer');
    const watch = () => {
      const open = !!(ov && ov.classList.contains('active')) || !!(mini && mini.classList.contains('active'));
      if (open !== playerOpen) {
        // Opening: a fresh record of where the player leaves files. Closing:
        // the player's times go to the blocks showing those files (keepPlayerTimes).
        if (open) playerLeft.clear(); else keepPlayerTimes();
        playerOpen = open;
        evaluate();
      }
    };
    const mo = new MutationObserver(watch);
    if (ov) mo.observe(ov, { attributes: true, attributeFilter: ['class'] });
    if (mini) mo.observe(mini, { attributes: true, attributeFilter: ['class'] });
  }

  /*
   * One menu open at a time: a chip's menu (by chip name) or 'more' (the
   * More popover). Escape or a click outside closes it.
   */
  let openMenu = null;

  function menuParts(name) {
    if (name === 'more') return { btn: els.more, menu: els.pop };
    const c = els.chips[name];
    return c ? { btn: c.btn, menu: c.menu } : null;
  }

  function setMenu(name) {
    if (openMenu && openMenu !== name) {
      const p = menuParts(openMenu);
      if (p) { p.menu.hidden = true; p.btn.setAttribute('aria-expanded', 'false'); }
    }
    openMenu = name || null;
    const p = name ? menuParts(name) : null;
    if (!p) return;
    p.menu.hidden = false;
    p.btn.setAttribute('aria-expanded', 'true');
    if (name === 'more') {
      const first = p.menu.querySelector('input, select');
      if (first) first.focus();
      return;
    }
    // Under its chip, kept inside the window.
    p.menu.style.left = '';
    p.menu.style.right = '';
    const r = p.menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) { p.menu.style.left = 'auto'; p.menu.style.right = '0'; }
    const cur = p.menu.querySelector('[aria-checked="true"]') || p.menu.querySelector('.wall-menu-item');
    if (cur) cur.focus();
  }

  /** Arrow keys, Home and End move through a menu's items; Tab closes it. */
  function menuKey(e, menu) {
    const items = [...menu.querySelectorAll('.wall-menu-item')].filter(it => !it.hidden);
    const i = items.indexOf(document.activeElement);
    let j = -1;
    if (e.key === 'ArrowDown') j = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    else if (e.key === 'Tab') { setMenu(null); return; }
    if (j < 0) return;
    e.preventDefault();
    items[j].focus();
  }

  /**
   * Escape closes a menu, else leaves full screen (it only gets here in full
   * screen with the Escape key locked); Space pauses the wall (not while
   * typing or on a control).
   */
  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape' && openMenu) {
      e.preventDefault();
      e.stopPropagation();
      const p = menuParts(openMenu);
      setMenu(null);
      if (p) p.btn.focus();
      return;
    }
    // The player over the wall takes its own Escape (player-controls.js).
    if (e.key === 'Escape' && !e.defaultPrevented && document.fullscreenElement === els.root) {
      e.preventDefault();
      document.exitFullscreen().catch(() => {});
      return;
    }
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (!built || playerOpen) return;
    const t = e.target;
    // Space keeps its own meaning on a control (a checkbox, a button) and
    // in anything you type into.
    if (t && t.closest && t.closest('input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"])')) return;
    // Nor behind a dialog or overlay (Settings, the detail modal...): there
    // Space belongs to that layer, scrolling it for one. The generic check
    // from dock.js; the Wall's own menus (the More popover is a role=dialog
    // too) are the one layer Space still pauses under.
    if (!openMenu && typeof dockModalLayerOpen === 'function' && dockModalLayerOpen()) return;
    e.preventDefault();
    setPaused(!userPaused);
  }

  let fsTimer = null;
  function showBarBriefly() {
    els.root.classList.remove('wall-bar-idle');
    clearTimeout(fsTimer);
    fsTimer = setTimeout(function hide() {
      if (!els.root.classList.contains('wall-fs')) return;
      // Kept while a menu is open or the mouse is on the bar.
      if (openMenu || els.bar.matches(':hover')) { fsTimer = setTimeout(hide, FS_IDLE_MS); return; }
      els.root.classList.add('wall-bar-idle');
    }, FS_IDLE_MS);
  }

  /** The board changed size: plan it again (once, after resizing stopped). */
  function refitBoard() {
    const W = els.board.clientWidth;
    const H = els.board.clientHeight;
    if (!W || !H) return;
    if (W === lay.W && H === lay.H) return;
    replan(true);
  }

  function wireBoard() {
    const board = els.board;
    board.addEventListener('mouseover', (e) => {
      const b = blockOf(e.target);
      if (!b || b.hovered) return;
      if (e.relatedTarget && b.el.contains(e.relatedTarget)) return;
      hoverStart(b);
    });
    board.addEventListener('mouseout', (e) => {
      const b = blockOf(e.target);
      if (!b || !b.hovered) return;
      if (e.relatedTarget && b.el.contains(e.relatedTarget)) return;
      hoverEnd(b);
    });
    board.addEventListener('click', (e) => {
      if (swallowUntil) {
        const swallow = now() <= swallowUntil;
        swallowUntil = 0;
        if (swallow) return;
      }
      const b = blockOf(e.target);
      if (b) openItem(b);
    });
  }

  function blockOf(node) {
    const el = node && node.closest ? node.closest('.wall-block') : null;
    return el && el._wall && !el._wall.dead ? el._wall : null;
  }

  /** The wall sits below the header and fills the rest of the window. */
  function placeRoot() {
    const header = document.getElementById('appHeader');
    const top = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
    els.root.style.setProperty('--wall-top', `${top}px`);
  }

  function showMsg(text) {
    els.msg.textContent = text;
    els.msg.hidden = !text;
  }

  /**
   * Why the wall came up empty, as { kind, title, hint }. Only a search or a
   * filter earns the "clear it" hint; a library with no files at all gets the
   * library's own empty state (with Add), and files that exist but cannot go
   * up (all music, say) are told so.
   */
  function emptyMessage({ source, narrowed, libraryEmpty }) {
    if (source !== 'library') {
      return { kind: 'source', title: '', hint: 'Nothing to show from this source. Pick another source or change what it shows.' };
    }
    if (narrowed) {
      return { kind: 'filter', title: '', hint: 'Nothing to show. The Wall uses your current library search and filters; clear them or pick another source.' };
    }
    if (libraryEmpty) {
      return { kind: 'library', title: 'Your library is empty', hint: 'Add a folder or some files and they will show up here. Your files stay where they are.' };
    }
    return { kind: 'unfit', title: '', hint: 'Nothing to show. The Wall plays videos and pictures, and none of your files can go up with these Wall settings.' };
  }

  function showEmpty() {
    // The Library view's, not the controls on screen (see baseSpec).
    const m = emptyMessage({
      source: cfg.source,
      narrowed: typeof libraryNarrowed === 'function' && libraryNarrowed(),
      libraryEmpty: typeof Library !== 'undefined' && Library.known() && Library.length() === 0,
    });
    if (m.kind !== 'library') { showMsg(m.hint); return; }
    // The same empty state as the library's (cards.js emptyStateHtml), with its Add actions.
    const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s));
    const ic = typeof vaultIcon === 'function' ? vaultIcon('folder', 'empty-state-ic') : '';
    const btn = (id, label, primary) => (document.getElementById(id)
      ? `<button type="button" class="empty-state-btn m-btn${primary ? ' is-primary' : ''}" data-wall-add="${id}">${esc(label)}</button>` : '');
    const hasFolder = !!document.getElementById('addFolderBtn');
    const actions = btn('addFolderBtn', 'Add folder', true) + btn('addFilesBtn', 'Add files', !hasFolder);
    els.msg.innerHTML = `<div class="empty-state" role="status">
        ${ic}
        <div class="empty-state-title">${esc(m.title)}</div>
        <div class="empty-state-hint">${esc(m.hint)}</div>
        ${actions ? `<div class="empty-state-actions">${actions}</div>` : ''}
      </div>`;
    els.msg.hidden = false;
    els.msg.querySelectorAll('[data-wall-add]').forEach(b => b.addEventListener('click', () => {
      document.getElementById(b.dataset.wallAdd)?.click();
    }));
  }

  function updateStatus() {
    if (!els) return;
    let playing = 0;
    for (const b of blocks) if (b.video) playing++;
    els.status.textContent = built && blocks.length ? `${playing} playing` : '';
  }

  /* ── Layout ─────────────────────────────────────────────────────────── */

  function makeBlock(slot) {
    const el = document.createElement('div');
    el.className = 'wall-block';
    el.style.left = `${slot.x.toFixed(2)}px`;
    el.style.top = `${slot.y.toFixed(2)}px`;
    el.style.width = `${slot.w.toFixed(2)}px`;
    el.style.height = `${slot.h.toFixed(2)}px`;
    const cap = document.createElement('div');
    cap.className = 'wall-cap';
    el.appendChild(cap);
    const spk = document.createElement('div');
    spk.className = 'wall-spk';
    spk.setAttribute('aria-hidden', 'true');
    spk.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" focusable="false"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
    el.appendChild(spk);
    const b = {
      el, cap,
      x: slot.x, y: slot.y, w: slot.w, h: slot.h, col: slot.col,
      aspect: slot.w / slot.h,  // the slot's shape, fixed for its life
      item: null,
      cropped: false,
      video: null,          // { v, layer, hls, token, cost, mode, id, released }
      pending: null,        // a still layer waiting for its picture
      dueAt: 0,
      loadDeadline: 0,
      startedAt: 0,
      lastPlayedAt: 0,
      hovered: false,
      held: false,          // hovered with Pause on hover: its timer (and the drift) waits
      holdLeft: 0,
      rand: Math.random(),
      fitWait: false,
      dead: false,
    };
    el._wall = b;
    return b;
  }

  /** Grid: a block moved and scaled once, when the new board is fitted to the screen (same shape). */
  function moveBlock(b, slot) {
    b.x = slot.x; b.y = slot.y; b.w = slot.w; b.h = slot.h;
    b.el.style.left = `${slot.x.toFixed(2)}px`;
    b.el.style.top = `${slot.y.toFixed(2)}px`;
    b.el.style.width = `${slot.w.toFixed(2)}px`;
    b.el.style.height = `${slot.h.toFixed(2)}px`;
  }

  /** Release a block for good: its videos, its place in the counts, its DOM. */
  function dropBlock(b) {
    b.dead = true;
    for (const v of b.el.querySelectorAll('video')) releaseVideo(v._wallRec);
    b.video = null;
    if (b.item) {
      const c = (onScreen.get(b.item.id) || 1) - 1;
      if (c > 0) onScreen.set(b.item.id, c); else onScreen.delete(b.item.id);
    }
    if (hoverBlock === b) { hoverBlock = null; }
    b.el.remove();
  }

  /** Tear the board down. Every video is released, not just removed. */
  function teardownBlocks() {
    for (const b of blocks) {
      b.dead = true;
      for (const v of b.el.querySelectorAll('video')) releaseVideo(v._wallRec);
      b.video = null;
    }
    blocks = [];
    hoverBlock = null;
    onScreen.clear();
    if (els) els.track.textContent = '';
  }

  const isOnScreen = (r) => onScreen.has(r.id);

  /** How far apart (px) the nearest block showing file `id` is from `rect` (skipping block `except`). */
  function nearestCopy(id, rect, except) {
    let d = Infinity;
    for (const b of blocks) if (b !== except && b.item && b.item.id === id) d = Math.min(d, rectGap(b, rect));
    return d;
  }

  /** A block showing file `id` touches `rect` (shares an edge or a corner, across the gap). */
  const touchesCopy = (id, rect, except) => nearestCopy(id, rect, except) <= lay.gap + 2;

  /**
   * The next file for the board being built. When the queue is empty (a
   * tiny source, or the next batch not fetched yet) the board repeats what
   * it already shows, the file whose copy is farthest from where it goes,
   * so it is always full.
   */
  function nextBuildItem() {
    const i = buildIndex(lay, ready, isOnScreen, (r, s) => touchesCopy(r.id, s));
    if (i >= 0) return take(i);
    fill();
    let best = null;
    let bestD = -Infinity;
    const seen = new Set();
    for (const b of blocks) {
      if (!b.item || seen.has(b.item.id)) continue;
      seen.add(b.item.id);
      const d = nearestCopy(b.item.id, slotFor(lay, aspectOf(b.item)));
      if (d > bestD) { bestD = d; best = b.item; }
    }
    return best;
  }

  /** Put one more block on the board at the next place the plan has for it (or at `slot`). */
  function addBlock(item, slot) {
    const s = slot || slotFor(lay, aspectOf(item));
    if (!slot) placeSlot(lay, s);
    const b = makeBlock(s);
    blocks.push(b);
    els.track.appendChild(b.el);
    showStill(b, item);
    return b;
  }

  /** A file's short side in pixels (0 when not stored), for "Bigger for high resolution". */
  function shortSide(row) {
    const w = Number(row.width) || 0;
    const h = Number(row.height) || 0;
    return w > 0 && h > 0 ? Math.min(w, h) : 0;
  }

  /**
   * Slices: put one more full-width slice on the board. Its candidates are
   * the front of the buffer, preferred the way buildIndex prefers them (not
   * on screen, shape known, early). A short buffer is padded with files the
   * board already shows, away from the slice above (slicePool). Returns its blocks
   * ([] when there is nothing to show).
   */
  function addSlice() {
    if (ready.length < SLICE_ITEMS) fill();
    const { pool, repeat } = slicePool(ready.slice(0, LOOKAHEAD), blocks, { known: shapeKnown, W: lay.W, max: SLICE_ITEMS, wrapped: poolWrapped });
    if (!pool.length) return [];
    const row = sliceRow(pool.map(p => ({ a: aspectOf(p.r), px: shortSide(p.r) })), {
      W: lay.W, base: lay.base, gap: lay.gap,
      variety: varietyPct() / 100, byRes: true, rand: Math.random, repeat,
      fitLeft: lay.fitH ? lay.fitH - lay.bottom : undefined,
    });
    const items = row.picks.map(k => pool[k].r);
    // The buffer files it uses leave the buffer (each once, found again by
    // identity: a take can drop stale rows and move the others).
    const taken = new Set();
    for (const k of row.picks) {
      const p = pool[k];
      if (!p.fromReady || taken.has(p.r)) continue;
      taken.add(p.r);
      const i = ready.indexOf(p.r);
      if (i >= 0) take(i);
    }
    const slots = placeSlice(lay, items.map(aspectOf), row.h, lay.W);
    return items.map((item, k) => addBlock(item, slots[k]));
  }

  /** Grow the board once: one block (Columns) or one whole slice (Slices). Returns the new blocks. */
  function growOnce() {
    if (lay.layout === 'slices') return addSlice();
    const item = nextBuildItem();
    return item ? [addBlock(item)] : [];
  }

  /** How far the columns must reach: the screen (Grid) or a screen and a half (Scroll). */
  function fillLine() {
    return cfg.mode === 'scroll' ? drift.offset + lay.H + Math.max(400, lay.H * 0.5) : lay.H;
  }

  /**
   * Build the board from the buffer: columns planned from the board width,
   * blocks added to the shortest column until every column passes the
   * bottom edge (Scroll: half a screen further, for what drifts in next).
   * Slices: whole slices added until the last one passes that line.
   */
  function layout() {
    layoutGen++;
    const W = els.board.clientWidth;
    const H = els.board.clientHeight;
    // A hidden board has no size: leave what is there alone (the caller marks
    // the board dirty and it is laid out on the way back in).
    if (!W || !H) return false;
    teardownBlocks();
    const plan = cfg.layout === 'horizontal'
      ? planSlices(W, sizePx(), GAP)
      : planColumns(W, sizePx(), GAP, { spread: colSpread(varietyPct()) });
    // Grid fits the board to the screen: nothing is cut off at the bottom.
    const grid = cfg.mode !== 'scroll';
    Object.assign(lay, { base: 0, bottom: 0, cws: null }, plan, { W, H, fitH: grid ? H : 0, noSpan: grid });
    drift.offset = 0;
    applyOffset();

    const line = fillLine();
    while (blocks.length < MAX_BLOCKS && minBottom(lay) < line) {
      if (!growOnce().length) break;
    }
    if (lay.fitH && blocks.length) {
      const fitted = fitGrid(lay, blocks.map(b => ({ x: b.x, y: b.y, w: b.w, h: b.h, col: b.col })), H, W);
      blocks.forEach((b, i) => moveBlock(b, fitted[i]));
    }

    const t = now();
    for (const b of blocks) {
      // Staggered so the pictures never all change together.
      setDue(b, t + (0.2 + Math.random() * 0.9) * picSec() * 1000);
    }
    // ...and neither do the clips: the first ones start one by one further in (clipStart).
    staggerLeft = playCap();
    staggerFrom = t;
    pinOnScreen();
    updateStatus();
    return true;
  }

  function markDirty(keep) {
    if (dirty !== 'fresh') dirty = keep ? 'keep' : 'fresh';
  }

  /**
   * Lay out again, keeping what is on screen now at the front of the queue.
   *
   * The new layout must come out as full as a fresh build: the queue is first
   * topped up for the new board (a smaller block size needs far more items),
   * and nothing in it is dropped, so a small source repeats items exactly the
   * way a fresh build of it does. Hidden, nothing is done but marking the
   * board dirty; entering the tab does the work.
   */
  async function relayout(keep) {
    if (!built || !els) return;
    if (!active) { markDirty(keep); return; }
    const gen = ++layoutGen;
    const pg = poolGen;
    for (let i = 0; i < 3 && ready.length < readyTarget(); i++) {
      await fill();
      if (gen !== layoutGen || pg !== poolGen || !built) return;
    }
    await shapesFor(LOOKAHEAD * 2, 1500);
    if (gen !== layoutGen || pg !== poolGen || !built) return;
    if (!active) { markDirty(keep); return; }
    if (keep) {
      // What is in view now, top to bottom, goes up first again.
      const top = drift.offset;
      const back = blocks
        .filter(b => b.item && !b.dead && b.y + b.h > top && b.y < top + lay.H)
        .sort((a, c) => (a.y - c.y) || (a.x - c.x))
        .map(b => b.item);
      ready = back.concat(ready).slice(0, READY_CAP);
    }
    if (!layout()) { markDirty(keep); return; }
    dirty = false;
    if (running) fillSlots();
  }

  /** Plan the board again behind a short fade (block size, gap, mode, resize). */
  let replanGen = 0;
  function replan(keep) {
    if (!built || !els) return;
    if (!active) { markDirty(keep); return; }
    const gen = ++replanGen;
    fading = true;
    syncDrift();
    els.board.classList.add('wall-fading');
    setTimeout(async () => {
      if (gen !== replanGen) return;
      try { await relayout(keep); } finally {
        if (gen === replanGen) {
          fading = false;
          els.board.classList.remove('wall-fading');
          evaluate();
        }
      }
    }, REPLAN_FADE_MS);
  }

  /** The element told us the real shape: remember it for later picks. The slot never changes. */
  function learnAspect(item, w, h) {
    if (!w || !h) return;
    const a = clamp(w / h, ASPECT_MIN, ASPECT_MAX);
    if (Math.abs(Math.log(a / aspectOf(item))) > 0.02) aspectCache.set(item.id, a);
  }

  let _pinTimer = null;
  function pinOnScreen() {
    clearTimeout(_pinTimer);
    _pinTimer = setTimeout(() => {
      // Pinned so the player can open any block (getMediaById reads the cache).
      Library.pin('wall', blocks.map(b => b.item && b.item.id).filter(Boolean));
    }, 300);
  }

  /* ── Scroll mode ────────────────────────────────────────────────────── */

  function applyOffset() {
    if (!els) return;
    const dpr = window.devicePixelRatio || 1;
    const y = Math.round(drift.offset * dpr) / dpr;
    els.track.style.transform = y ? `translate3d(0, ${-y}px, 0)` : '';
  }

  function driftShouldRun() {
    return cfg.mode === 'scroll' && active && built && running && !fading && !(hoverBlock && hoverBlock.held);
  }

  function syncDrift() {
    if (driftShouldRun()) {
      if (!drift.raf) { drift.lastT = 0; drift.raf = requestAnimationFrame(frame); }
    } else if (drift.raf) {
      cancelAnimationFrame(drift.raf);
      drift.raf = 0;
      drift.lastT = 0;
    }
  }

  function frame(t) {
    drift.raf = 0;
    if (!driftShouldRun()) return;
    if (drift.lastT) {
      const raw = t - drift.lastT;
      drift.frames.push(raw);
      auto.frames++;
      if (raw > 50) auto.hitches++;
      if (drift.frames.length > 2000) drift.frames.splice(0, 1000);
      drift.offset += speedPx() * Math.min(100, raw) / 1000;
    }
    drift.lastT = t;
    maintainScroll();
    applyOffset();
    drift.raf = requestAnimationFrame(frame);
  }

  /**
   * Keep the drifting board stocked: drop blocks that have left the top,
   * add blocks to the shortest column (or a whole slice) below the fold, and every so often
   * move the coordinates back toward zero (same frame, so nothing jumps).
   */
  function maintainScroll() {
    let removed = 0;
    if (blocks.length && blocks.some(b => b.y + b.h < drift.offset - 2)) {
      const keep = [];
      for (const b of blocks) {
        if (b.y + b.h < drift.offset - 2 && removed < 8) { dropBlock(b); removed++; }
        else keep.push(b);
      }
      blocks = keep;
      drift.removed += removed;
    }
    const line = fillLine();
    // Up to three blocks a frame, or one whole slice.
    const perFrame = lay.layout === 'slices' ? 1 : 3;
    for (let n = 0; n < perFrame && blocks.length < MAX_BLOCKS && minBottom(lay) < line; n++) {
      const added = growOnce();
      if (!added.length) break;
      for (const b of added) setDue(b, Infinity);
    }
    if (removed) { pinOnScreen(); updateStatus(); }
    if (drift.offset > REBASE_AT) {
      const s = Math.floor(drift.offset);
      drift.offset -= s;
      for (let c = 0; c < lay.tops.length; c++) lay.tops[c] -= s;
      if (lay.layout === 'slices') lay.bottom -= s;
      for (const b of blocks) {
        b.y -= s;
        b.el.style.top = `${b.y.toFixed(2)}px`;
      }
      drift.rebases++;
    }
  }

  /* ── Stills (pictures, and videos waiting for a slot) ───────────────── */

  function stillDelay() {
    return picSec() * 1000 * (0.7 + Math.random() * 0.6);
  }

  function setStillSrc(img, item, layer) {
    if (kindOf(item) === 'picture') {
      // The file itself: a gif animates, a photo is sharp at any block size.
      img.src = `/media/${item.id}`;
      return;
    }
    if (typeof thumbsEncrypted === 'function' && thumbsEncrypted()) {
      const hit = typeof getThumbBlob === 'function' ? getThumbBlob(item.id) : null;
      if (hit) { img.src = hit; return; }
      img.dataset.thumbId = String(item.id);
      img.dataset.thumbSrc = thumbUrl(item);
      if (typeof hydrateThumbs === 'function') hydrateThumbs(layer);
      return;
    }
    img.dataset.thumbId = String(item.id);
    img.src = typeof thumbUrl === 'function' ? thumbUrl(item) : `/thumb/${item.id}`;
  }

  function whenImgReady(img, ms) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onErr);
        resolve(ok);
      };
      // decode() first, so the fade never starts on a picture still decoding
      // (capped: Chrome can hold decode() back in a tab it is not painting)
      const onLoad = () => {
        const p = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
        Promise.race([p, new Promise(r => setTimeout(r, 1000))])
          .then(() => finish(img.naturalWidth > 0));
      };
      const onErr = () => finish(false);
      timer = setTimeout(() => finish(img.complete && img.naturalWidth > 0), ms);
      if (img.complete && img.naturalWidth) onLoad();
      else {
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onErr);
      }
    });
  }

  /** A block with no picture: the file's type icon on the dark block. */
  function addWallTypeIcon(layer, item) {
    if (layer.querySelector('.wall-type-icon')) return;
    const icons = typeof TILE_TYPE_ICONS !== 'undefined' ? TILE_TYPE_ICONS : {};
    const span = document.createElement('span');
    span.className = 'wall-type-icon';
    span.setAttribute('aria-hidden', 'true');
    // Classic's emoji, Modern's line icon (player-lib/icons.js)
    span.innerHTML = typeof vaultIconSwap === 'function'
      ? vaultIconSwap(icons[item.media_type] || '🎬', VAULT_TYPE_ICON_NAMES[item.media_type] || 'video')
      : (icons[item.media_type] || '🎬');
    layer.appendChild(span);
  }

  /** Swap a block to a new item: the new picture fades in over the old one. */
  function showStill(b, item) {
    const prevItem = b.item;
    if (prevItem) {
      const c = (onScreen.get(prevItem.id) || 1) - 1;
      if (c > 0) onScreen.set(prevItem.id, c); else onScreen.delete(prevItem.id);
    }
    b.item = item;
    b.cropped = Math.abs(Math.log(aspectOf(item) / b.aspect)) > 0.01;
    onScreen.set(item.id, (onScreen.get(item.id) || 0) + 1);
    b.cap.textContent = titleOf(item);
    b.el.title = '';

    const layer = document.createElement('div');
    layer.className = 'wall-layer';
    const img = document.createElement('img');
    img.className = 'wall-media';
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;
    layer.appendChild(img);
    b.el.insertBefore(layer, b.cap);
    if (b.pending) b.pending.remove();
    b.pending = layer;
    // Thumbnails switched off in Settings: a video's still is its type icon,
    // and nothing is asked for.
    const noThumb = kindOf(item) !== 'picture' && typeof thumbsOff === 'function' && thumbsOff();
    if (!noThumb) setStillSrc(img, item, layer);

    if (noThumb) addWallTypeIcon(layer, item);

    (noThumb ? Promise.resolve(false) : whenImgReady(img, LOAD_TIMEOUT_MS)).then((ok) => {
      if (b.dead || b.pending !== layer) { layer.remove(); return; }
      b.pending = null;
      if (ok) learnAspect(item, img.naturalWidth, img.naturalHeight);
      else if (kindOf(item) === 'picture') {
        // A picture that will not load: drop it and move on soon.
        badIds.add(item.id);
        setDue(b, Math.min(b.dueAt, now() + 800));
      } else {
        layer.classList.add('wall-nothumb');
        addWallTypeIcon(layer, item);
      }
      reveal(b, layer);
    });
    pinOnScreen();
  }

  /** Fade a layer in, then drop (and release) everything under it. */
  function reveal(b, layer) {
    // Force the start state so the transition runs even on a fresh layer.
    void layer.offsetWidth;
    layer.classList.add('on');
    // A clip keeps its still underneath: that is what shows when it stops.
    if (layer.classList.contains('wall-vlayer')) return;
    setTimeout(() => {
      if (b.dead || !layer.isConnected) return;
      let node = layer.previousElementSibling;
      while (node) {
        const prev = node.previousElementSibling;
        if (node.classList.contains('wall-layer')) {
          const v = node.querySelector('video');
          if (v && b.video && b.video.v === v) { node = prev; continue; }
          if (v) releaseVideo(v._wallRec);
          node.remove();
        }
        node = prev;
      }
      updateStatus();
    }, FADE_MS + 50);
  }

  /* ── Videos ─────────────────────────────────────────────────────────── */

  const MIN_RUN_S = 30;     // a clip starts at least this far from its end (when it is long enough)

  /**
   * Where a clip of `dur` seconds starts (pure; `rnd` in [0, 1)); it plays
   * to the end from there. A long clip: at a random point at least
   * MIN_RUN_S before the end, so the same files do not always open the same
   * way and clips end at different times. A clip up to twice that long:
   * from the start, or with `share` below 1 (a staggered start on a fresh
   * board, staggerShare) only its last `share` plays.
   */
  function clipStart(dur, rnd, share = 1) {
    if (dur > 2 * MIN_RUN_S) return rnd * (dur - MIN_RUN_S);
    return dur > 0 && share < 1 ? dur * (1 - Math.max(0, share)) : 0;
  }

  /**
   * The share of a short clip the first clips on a fresh Grid board play
   * (pure): the first `playing` to start get playing/playing,
   * (playing-1)/playing, ... 1/playing, so they end one by one over one
   * clip length; `left` is how many staggered starts remain. Every other
   * clip plays from the start.
   */
  function staggerShare(left, playing) {
    return left > 0 ? Math.min(1, left / Math.max(1, playing)) : 1;
  }

  /** The clip's decoded and dropped frame counts so far (0s where the browser cannot tell). */
  function frameCounts(v) {
    try {
      const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      if (q) return { total: q.totalVideoFrames || 0, dropped: q.droppedVideoFrames || 0 };
    } catch {}
    return { total: 0, dropped: 0 };
  }

  function startVideo(b) {
    const item = b.item;
    const mode = playMode(item);
    if (!mode || (mode === 'remux' && cfg.directOnly)) return false;
    const cost = mode === 'remux' ? REMUX_COST : 1;
    if (liveCost + cost > playCap()) return false;
    if (mode === 'remux' && liveRemux >= MAX_REMUX) return false;

    // Where the clip was before the player opened, or where the player left
    // this file. Used once. Watched to its end: the block takes a new file.
    const dur = Number(item.duration_seconds) || 0;
    const back = resumeAt(b.resume, undefined, item.id, dur);
    b.resume = null;
    // (Scroll swaps only playing blocks: there the file just starts afresh.)
    if (back === 'ended' && cfg.mode !== 'scroll') { setDue(b, 0); return false; }

    const v = document.createElement('video');
    v.className = 'wall-media';
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.loop = cfg.loopClips;   // Loop clips: the clip starts over and keeps its block
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.setAttribute('disableremoteplayback', '');
    const layer = document.createElement('div');
    layer.className = 'wall-layer wall-vlayer';
    layer.appendChild(v);
    b.el.insertBefore(layer, b.cap);

    // audio: whether the clip has sound, true/false from the probe, null until learned.
    const rec = { v, layer, hls: null, token: null, cost, mode, id: item.id, released: false, replayAt: 0,
      gain: 0, from: 0, to: 0, t0: 0, block: b, startedAt: 0, audio: storedAudio(item) };
    v._wallRec = rec;
    liveCost += cost;
    if (mode === 'remux') liveRemux++;
    b.video = rec;
    b.startedAt = 0;
    // No timer for a direct clip: it keeps the block until it ends ('ended'
    // below), or for good while it loops (a converted one: see 'playing').
    setDue(b, Infinity);
    b.loadDeadline = now() + (mode === 'remux' ? REMUX_TIMEOUT_MS : LOAD_TIMEOUT_MS);

    // Back from the player: the clip carries on where it was (resumeAt).
    // Otherwise, Grid soon after a layout: a staggered start (a looping clip needs none).
    let share = 1;
    if (typeof back !== 'number' && cfg.mode !== 'scroll' && !cfg.loopClips) {
      if (now() - staggerFrom > STAGGER_WINDOW_MS) staggerLeft = 0;
      share = staggerShare(staggerLeft, playCap());
      if (staggerLeft > 0) staggerLeft--;
    }
    const start = typeof back === 'number' ? back : clipStart(dur, Math.random(), share);

    v.addEventListener('playing', () => {
      if (b.video !== rec || b.dead) return;
      b.loadDeadline = 0;
      b.startedAt = now();
      rec.startedAt = b.startedAt;
      // A converted clip gives up its block (and the remux slot) after 3 minutes.
      if (mode === 'remux') setDue(b, clipDue(mode, b.startedAt));
      rec.q = frameCounts(v);   // Auto counts dropped frames from here
      learnAspect(item, v.videoWidth, v.videoHeight);
      reveal(b, layer);
      syncAudio();
      updateStatus();
    }, { once: true });
    // The clip ended (never while it loops): the next file takes the block.
    v.addEventListener('ended', () => { if (b.video === rec) setDue(b, 0); });
    // A clip that has been playing a while and has to wait for data: a
    // stall, for Auto (the first moments after a start do not count).
    v.addEventListener('waiting', () => {
      if (rec.released || !running || !rec.startedAt || now() - rec.startedAt < STALL_GRACE_MS) return;
      auto.stalls++;
      stats.stalls++;
    });
    v.addEventListener('error', () => videoFailed(b, rec));
    v.addEventListener('pause', () => clipPaused(b, rec));

    if (mode === 'native') {
      v.src = `/media/${item.id}${start > 0.5 ? `#t=${start.toFixed(1)}` : ''}`;
      v.play().catch(() => {});
    } else {
      attachRemux(b, rec, start);
    }
    updateStatus();
    return true;
  }

  async function attachRemux(b, rec, start) {
    let info = null;
    try {
      const caps = typeof codecCaps === 'function' ? codecCaps() : '';
      const res = await fetch(`/api/playback/${rec.id}?caps=${encodeURIComponent(caps)}`);
      if (res.ok) info = await res.json();
    } catch { /* handled below */ }
    if (rec.released) return;
    if (!info || (info.mode !== 'remux' && info.mode !== 'native')) { videoFailed(b, rec); return; }
    const v = rec.v;
    if (info.mode === 'native') {
      v.src = `${info.url || `/media/${rec.id}`}${start > 0.5 ? `#t=${start.toFixed(1)}` : ''}`;
      v.play().catch(() => {});
      return;
    }
    rec.token = wallToken();
    const url = `${info.url}?c=${encodeURIComponent(rec.token)}`;
    if (!(typeof Hls !== 'undefined' && Hls.isSupported())) {
      v.src = url;                                // Safari: native HLS
      if (start > 0.5) v.addEventListener('loadedmetadata', () => { try { v.currentTime = start; } catch {} }, { once: true });
      v.play().catch(() => {});
      return;
    }
    const hls = new Hls({ maxBufferLength: 12, maxMaxBufferLength: 20, enableWorker: true, startPosition: start > 0.5 ? start : -1 });
    rec.hls = hls;
    hls.on(Hls.Events.ERROR, (evt, data) => { if (data && data.fatal) videoFailed(b, rec); });
    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!rec.released) v.play().catch(() => {}); });
    hls.loadSource(url);
    hls.attachMedia(v);
  }

  /**
   * A stream token only the Wall mints: "wall-" + a lowercase UUID. The server
   * remembers closed tokens (and refuses their late requests) only in exactly
   * this shape, so the main player's tokens never take that path.
   * crypto.randomUUID needs a secure context, which plain-http LAN access is
   * not, so the same shape is built from getRandomValues there.
   */
  function wallToken() {
    const c = window.crypto;
    if (c && typeof c.randomUUID === 'function') return `wall-${c.randomUUID().toLowerCase()}`;
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `wall-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /* A hidden page (WallRules.visibilityAction). Where the Wall keeps
     playing, a clip the browser paused by itself (Chromium pauses muted
     videos in hidden pages) is played again: at once, and from the
     scheduler's tick for one that would not start. */
  const REPLAY_GAP_MS = 400;           // never more often than this per clip

  function pageAction(reason) {
    return R.visibilityAction({
      keepPlaying: !!(cfg && cfg.keepPlaying2),
      visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
      reason,
    });
  }

  /**
   * A clip paused: the Wall's own pauses (setRunning, release) come with
   * running off or released. In a visible page the browser gets one more
   * play(); if the clip still does not move, the freeze watchdog frees it.
   */
  function clipPaused(b, rec) {
    if (rec.released || b.dead || b.video !== rec || !running || rec.v.ended) return;
    if (pageAction('clip') === 'replay') replay(rec);
    else if (document.visibilityState !== 'hidden' && !rec.kicked) {
      rec.kicked = true;
      replay(rec);
    }
  }

  /**
   * Clips the browser holds paused, from the tick. A clip started while the
   * page is hidden is held before it ever plays too (Chromium defers media
   * in hidden pages), so not only clips that played already: one with a
   * source to play. Without this it would time out and count as broken.
   */
  function replayHeld() {
    for (const b of blocks) {
      const rec = b.video;
      if (!rec || rec.released || !rec.v.paused || rec.v.ended) continue;
      if (!b.startedAt && !(rec.v.currentSrc || rec.hls)) continue;
      replay(rec);
    }
  }

  function replay(rec) {
    const t = now();
    if (t - rec.replayAt < REPLAY_GAP_MS) return;
    rec.replayAt = t;
    stats.replays++;
    rec.v.play().catch(() => {});
  }

  /* The tick in a hidden page. Chromium slows a hidden page's timers to once
     a second, and after a few minutes to once a minute, which would leave
     clips ended and blocks unchanged for a minute at a time. A dedicated
     worker's timers are not slowed that way, so while the page is hidden and
     the Wall runs, the tick is driven from one (a few lines from a Blob, no
     file, nothing but a timer). Shown again, the page's own timer takes over. */
  let tickWorker = null;
  let tickWorkerUrl = null;

  function workerTicks(on) {
    if (!on) {
      if (tickWorker) { try { tickWorker.terminate(); } catch {} tickWorker = null; }
      return;
    }
    if (tickWorker || typeof Worker !== 'function' || typeof Blob !== 'function') return;
    try {
      if (!tickWorkerUrl) {
        tickWorkerUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${TICK_MS});`], { type: 'text/javascript' }));
      }
      tickWorker = new Worker(tickWorkerUrl);
      tickWorker.onmessage = () => { if (running && document.visibilityState === 'hidden') tick(); };
    } catch { tickWorker = null; }
  }

  /** Free a video for good: decoder, buffers, connection, stream session. */
  function releaseVideo(rec) {
    if (!rec || rec.released) return;
    rec.released = true;
    liveCost -= rec.cost;
    if (rec.mode === 'remux') liveRemux--;
    const v = rec.v;
    // Silent at once, even halfway through a crossfade.
    try { v.muted = true; v.volume = 0; } catch {}
    fadingRecs.delete(rec);
    if (audioRec === rec) audioRec = null;
    if (autoRec === rec) autoRec = null;
    try { v.pause(); } catch {}
    if (rec.hls) {
      try { rec.hls.destroy(); } catch {}
      rec.hls = null;
    }
    if (rec.token && typeof _closeStream === 'function') _closeStream(rec.id, rec.token);
    try { v.removeAttribute('src'); v.load(); } catch {}
    v.remove();
    if (rec.layer) rec.layer.remove();
  }

  function videoFailed(b, rec) {
    if (rec.released) return;
    badIds.add(rec.id);
    releaseVideo(rec);
    if (b.video === rec) {
      b.video = null;
      setDue(b, cfg.mode === 'scroll' ? Infinity : now() + 400);   // swap the block to something that works
      b.lastPlayedAt = now();
    }
    updateStatus();
  }

  /** Stop a block's video and fall back to its still (which is underneath). */
  function stopVideo(b) {
    if (!b.video) return;
    releaseVideo(b.video);
    b.video = null;
    b.lastPlayedAt = now();
    setDue(b, cfg.mode === 'scroll' ? Infinity : now() + stillDelay());
  }

  /**
   * Release only the remux (HLS) clips, each back to its still: what a hidden
   * browser tab gives up. Their slots refill with fresh tokens on return.
   */
  function releaseRemuxVideos() {
    for (const b of blocks) {
      if (b.video && b.video.mode === 'remux') stopVideo(b);
      for (const v of b.el.querySelectorAll('video')) {
        if (v._wallRec && v._wallRec.mode === 'remux') releaseVideo(v._wallRec);
      }
    }
    updateStatus();
  }

  function releaseAllVideos() {
    for (const b of blocks) {
      if (b.video) {
        releaseVideo(b.video);
        b.video = null;
        b.lastPlayedAt = now();
      }
      // Any video still fading out under a new picture goes too.
      for (const v of b.el.querySelectorAll('video')) releaseVideo(v._wallRec);
    }
    updateStatus();
  }

  const canPlay = (b) => !b.video && !b.dead && b.item
    && kindOf(b.item) === 'video' && !badIds.has(b.item.id);

  /**
   * Free slots go to the video blocks that have waited longest (Grid). In
   * Scroll a block may start once at least START_FRAC of it is on the board
   * (scrollRank): the blocks most in view first. A playing clip that is
   * leaving at the top gives its slot to a block more in view than it is
   * (leavingFor), soonest gone first, and only as many stop as that block
   * needs to start.
   */
  function fillSlots() {
    if (!running) return;
    const cap = playCap();
    if (cfg.mode !== 'scroll') {
      if (liveCost >= cap) return;
      // A still that is still loading does not hold its block back: the clip
      // layer goes on top of it either way.
      // Not the hovered block: Pause on hover asked it to stay as it is.
      const cands = blocks.filter(b => canPlay(b) && !b.held);
      // Back from the player, the clips that were playing go first.
      cands.sort((a, c) => (!!c.resume - !!a.resume) || (a.lastPlayedAt - c.lastPlayedAt) || (a.rand - c.rand));
      for (const b of cands) {
        if (liveCost >= cap) break;
        startVideo(b);
      }
      return;
    }
    const top = drift.offset;
    // A block whose top has passed ("late") would leave soon and every start
    // costs a seek on the drive, so it takes only slots that are free and
    // never holds slots back for itself.
    const cands = scrollRank(blocks.filter(canPlay), top, lay.H);
    // Not the hovered one: Pause on hover asked it to stay.
    const playing = blocks.filter(b => b.video && !b.held);
    for (const b of cands) {
      const mode = playMode(b.item);
      if (!mode || (mode === 'remux' && cfg.directOnly)) continue;   // never plays here
      const cost = mode === 'remux' ? REMUX_COST : 1;
      if (cost > cap) continue;
      const claims = b.y >= top;
      const pool = claims ? leavingFor(b, playing, top, lay.H) : [];
      const plan = scrollFreePlan(cost, mode === 'remux', cap - liveCost, liveRemux < MAX_REMUX,
        pool.map(l => ({ cost: l.video.cost, remux: l.video.mode === 'remux' })));
      // A clip that is staying holds the remux slot: wait, and let the others play.
      if (plan === 'remux') continue;
      if (plan === null) {
        // Not enough room yet. A block whose top is on the board holds back
        // the slots that free up next for itself (it is the most in view of
        // those waiting), until it starts or its top passes the board top.
        // At a cap of 2 this can leave a slot idle for a remux clip that
        // never gets room; a known trade-off, without it remux clips in
        // Scroll would hardly ever play.
        if (claims) break;
        continue;
      }
      for (const i of plan) {
        const gone = pool[i];
        stopVideo(gone);
        playing.splice(playing.indexOf(gone), 1);
      }
      startVideo(b);
    }
  }

  /** How long (ms) a block's clip still plays to its end: Infinity while it loops or is not known yet. */
  function mediaLeftMs(b) {
    const v = b.video && b.video.v;
    if (!v || v.loop || !(Number.isFinite(v.duration) && v.duration > 0)) return Infinity;
    return (v.duration - v.currentTime) * 1000;
  }

  /** Fewer videos at once: stop the clips closest to their end (Scroll: nearest the top). */
  function trimVideos() {
    const cap = playCap();
    if (liveCost <= cap) return;
    const playing = blocks.filter(b => b.video)
      .sort(cfg.mode === 'scroll' ? (a, c) => (a.y + a.h) - (c.y + c.h) : (a, c) => mediaLeftMs(a) - mediaLeftMs(c));
    for (const b of playing) {
      if (liveCost <= cap) break;
      stopVideo(b);
    }
    updateStatus();
  }

  function retimeStills() {
    if (cfg.mode === 'scroll') return;
    const t = now();
    const max = picSec() * 1000;
    for (const b of blocks) {
      if (!b.video && b.dueAt - t > max) setDue(b, t + Math.random() * max);
    }
  }

  /* ── Hover ──────────────────────────────────────────────────────────── */

  function hoverStart(b) {
    b.hovered = true;
    b.el.classList.add('wall-hover');
    // Pause on hover: the block's timer waits (and Scroll mode stops drifting).
    b.held = cfg.pauseOnHover;
    if (b.held) b.holdLeft = b.dueAt - now();
    hoverBlock = b;
    syncDrift();
    syncAudio();
  }

  function hoverEnd(b) {
    b.hovered = false;
    b.el.classList.remove('wall-hover');
    if (b.held && cfg.mode !== 'scroll' && Number.isFinite(b.holdLeft)) b.dueAt = now() + Math.max(1500, b.holdLeft);
    b.held = false;
    if (hoverBlock === b) hoverBlock = null;
    syncDrift();
    syncAudio();
  }

  /* ── Sound ──────────────────────────────────────────────────────────── */

  const AUDIO_FADE_MS = 1200;  // a handover is a slow, equal-power crossfade
  const AUTO_SETTLE_MS = 500;
  const RAMP_STEP_MS = 16;
  let autoAt = -Infinity;      // when Follow's last handover began
  let heardSince = 0;          // when the clip heard now was picked (Rotate)
  let rotateWait = 0;          // Rotate: how long (ms) it is heard before the sound moves on; 0 = draw one
  const ROTATE_MIN_LEFT_MS = 5000;   // Rotate moves only to a clip with at least this long left after the crossfade
  const MIX_MIN_MS = 10000;
  const MIX_MAX_MS = 40000;

  /**
   * Rotate: how long (ms) the clip heard now keeps the sound (pure). `every`
   * is the Rotate choice (10, 20, 30, 60 s, or 'mix'); for Mix it up `rnd`
   * (in [0, 1)) gives a fresh wait between 10 and 40 s.
   */
  function rotateWaitMs(every, rnd) {
    if (every === 'mix') return MIX_MIN_MS + Math.min(1, Math.max(0, Number(rnd) || 0)) * (MIX_MAX_MS - MIX_MIN_MS);
    return (Number(every) || 20) * 1000;
  }

  /**
   * Rotate: whether the sound moves on now (pure). o: { t, since (when the
   * clip heard now was picked), wait (rotateWaitMs), settling (a Follow
   * handover is still settling), held (the heard clip is hovered with Pause
   * on hover: the move waits until the mouse leaves) }.
   */
  function rotateDue({ t, since, wait, settling = false, held = false }) {
    return !settling && !held && wait > 0 && t - since >= wait;
  }

  /**
   * Which playing clip Auto should be heard (pure). `cands` are the clips
   * playing now, as { key, left, startedAt }: `left` is the time (ms) until
   * the clip has to hand the sound on, that is until it is swapped or leaves
   * less the crossfade (Infinity when nothing ends it). The clip heard now
   * keeps the sound while it has time left, whatever the others have: fewer
   * jumps. Otherwise the most time left wins, a tie goes to the most recent
   * start. Only when no clip has time left (they are all about to stop) is
   * one without it heard: the current one while it plays, else the one with
   * the most. Returns a key, or null when nothing plays.
   */
  function pickAudible(cands, current) {
    const leftOf = (c) => (Number.isNaN(c.left) ? -Infinity : c.left);
    const cur = current != null ? cands.find(c => c.key === current) : null;
    if (cur && leftOf(cur) > 0) return current;
    let best = null;
    for (const c of cands) {
      const left = leftOf(c);
      if (!best || left > best.left || (left === best.left && c.startedAt > best.startedAt)) {
        best = { key: c.key, left, startedAt: c.startedAt };
      }
    }
    if (best && best.left <= 0 && cur) return current;
    return best ? best.key : null;
  }

  /**
   * Rotate: the clip to hear next (pure). Of the playing clips other than
   * `current`, only one with more than `minLeft` ms left counts (not one
   * about to stop or leave). Of those, the one not heard for longest
   * (`heardAt`, 0 = never), so the sound goes round every clip on the wall
   * (looping clips all have endless time left); a tie goes to the most time
   * left, then the most recent start. None: `current` stays.
   */
  function rotatePick(cands, current, minLeft = 0) {
    let best = null;
    const heard = (c) => c.heardAt || 0;
    for (const c of cands) {
      if (c.key === current || !(c.left > Math.max(0, minLeft))) continue;
      if (!best || heard(c) < heard(best)
        || (heard(c) === heard(best) && (c.left > best.left || (c.left === best.left && c.startedAt > best.startedAt)))) best = c;
    }
    return best ? best.key : current;
  }

  /**
   * Which clip may keep fading out (pure): of the clips other than `want`
   * still sounding or on their way up ({ gain, to }), the loudest; null if none.
   */
  function fadeOutPick(recs, want) {
    let out = null;
    for (const r of recs) {
      if (r !== want && (r.gain > 0 || r.to > 0) && (!out || r.gain > out.gain)) out = r;
    }
    return out;
  }

  /** The app's volume as the player stores it (slider 0 to 1.5, curved); 0 when muted. */
  function soundLevel() {
    let vol = 1;
    let muted = false;
    if (typeof playerIsSilent === 'function' && typeof savedVolume !== 'undefined') {
      muted = playerIsSilent();
      vol = Number(savedVolume);
    } else {
      try {
        const s = JSON.parse(localStorage.getItem('vault_volume') || 'null');
        if (s && typeof s === 'object') { vol = Number(s.volume); muted = !!s.muted; }
      } catch {}
    }
    if (muted || !(vol > 0)) return 0;
    const v = Math.min(1.5, vol);
    return Math.min(1, Math.pow(v / 1.5, 2) * 1.5);   // the player's curve (sliderToVolume, max 1.5)
  }

  function liveRecs() {
    if (!els) return [];
    const out = [];
    for (const v of els.track.querySelectorAll('video')) {
      if (v._wallRec && !v._wallRec.released) out.push(v._wallRec);
    }
    return out;
  }

  /** Whether a file has sound as its probe stored it: true/false, or null (not probed yet). */
  function storedAudio(item) {
    if (!item || !(Number(item.probe_version) > 0)) return null;
    return !!item.audio_codec;
  }

  const AUDIO_LEARN_MS = 1500;   // a playing clip that decoded no sound by then has none

  /**
   * Whether a clip has sound: the probe's answer, else the element's once it
   * plays (audioTracks or mozHasAudio where there is one; in Chrome, decoded
   * audio bytes, which a muted clip decodes too). null while not known yet.
   */
  function hasAudio(rec) {
    if (rec.audio !== null) return rec.audio;
    const v = rec.v;
    if (v.readyState < 1) return null;
    if (v.audioTracks && typeof v.audioTracks.length === 'number') rec.audio = v.audioTracks.length > 0;
    else if (typeof v.mozHasAudio === 'boolean') rec.audio = v.mozHasAudio;
    else if (typeof v.webkitAudioDecodedByteCount === 'number') {
      if (v.webkitAudioDecodedByteCount > 0) rec.audio = true;
      else if (rec.startedAt && now() - rec.startedAt > AUDIO_LEARN_MS) rec.audio = false;
    } else {
      rec.audio = true;   // no way to tell: assume it has sound
    }
    return rec.audio;
  }

  /**
   * A block's clip that is playing now and can hold the sound. In Scroll, a
   * clip for Follow or Rotate must be at least HEAR_FRAC in view; with
   * `onBoard` (the hovered clip) any part of it on the board will do.
   */
  function playingRec(b, onBoard) {
    const rec = b.video;
    if (!rec || rec.released || b.dead || !b.startedAt) return null;
    if (cfg.mode === 'scroll') {
      const top = drift.offset;
      const seen = onBoard
        ? b.y < top + lay.H && b.y + b.h > top
        : inView(b.y, b.h, top, lay.H, HEAR_FRAC);
      if (!seen) return null;
    }
    return rec;
  }

  /**
   * How long (ms) this clip still plays on the wall, as far as the wall
   * knows: until it ends (never while it loops), a converted clip no longer
   * than its 3 minutes (clipDue, its block's swap time), and in Scroll no longer than
   * until less than HEAR_FRAC of it is left on the board at the top (no
   * limit from the drift while it is paused).
   */
  function timeLeft(b, t) {
    let leaveIn = Infinity;
    if (cfg.mode === 'scroll' && driftShouldRun()) leaveIn = scrollLeftMs(b.y, b.h, drift.offset, lay.H, speedPx());
    return clipLeft({ dueIn: b.dueAt - t, held: b.held, holdLeft: b.holdLeft, leaveIn, mediaLeft: mediaLeftMs(b) });
  }

  /** The clip that should be heard right now, or null. Keeps Auto's pick up to date. */
  function wantedRec() {
    if (!running || !active || playerOpen || cfg.sound === 'off') return null;
    if (cfg.sound === 'hover') return hoverBlock ? playingRec(hoverBlock, true) : null;
    const t = now();
    const cands = [];
    // Only clips with sound: a silent clip must never hold it while another could be heard.
    for (const rec of liveRecs()) {
      if (!rec.startedAt || rec.v.paused || hasAudio(rec) !== true) continue;
      const b = rec.block;
      if (b.video === rec) {
        if (!playingRec(b)) continue;
        // The handover starts a crossfade before the clip stops, so it is never cut off.
        cands.push({ key: rec, left: timeLeft(b, t) - AUDIO_FADE_MS, startedAt: b.startedAt, heardAt: rec.heardAt || 0 });
      } else if (!b.dead) {
        // A Grid block's old clip, still playing under its next picture's fade:
        // no time left, but it keeps the sound until it really stops if
        // nothing else can take it.
        cands.push({ key: rec, left: -AUDIO_FADE_MS, startedAt: rec.startedAt });
      }
    }
    // A handover settles over a short window: a clip that starts playing
    // within it (often the one taking the slot the old clip gave up) can
    // still win if it has more time left. After that the pick sticks.
    const settling = t - autoAt < AUTO_SETTLE_MS;
    const pick = pickAudible(cands, settling ? null : autoRec);
    if (pick !== autoRec) {
      if (!settling) autoAt = t;
      autoRec = pick;
      if (pick) pick.heardAt = t;
      heardSince = t;
      rotateWait = 0;
    }
    // Rotate: once the wait is over the sound moves on to another playing
    // clip with sound and time left (none: it stays, and tries again on the
    // next tick). No settle window here, so the pick is not taken straight
    // back by the clip with the most time. A heard clip held by Pause on
    // hover keeps the sound until the mouse leaves.
    if (cfg.sound === 'rotate' && autoRec) {
      if (!rotateWait) rotateWait = rotateWaitMs(cfg.soundEvery, Math.random());
      const held = !!(autoRec.block && autoRec.block.held);
      if (rotateDue({ t, since: heardSince, wait: rotateWait, settling, held })) {
        const next = rotatePick(cands, autoRec, ROTATE_MIN_LEFT_MS);
        if (next !== autoRec) { autoRec = next; next.heardAt = t; heardSince = t; rotateWait = 0; }
      }
    }
    // A hovered clip borrows the sound while hovered (with Pause on hover on).
    // Only a clip known to have sound borrows it, so hovering a silent clip
    // never mutes the wall.
    const hovered = hoverBlock && hoverBlock.held ? playingRec(hoverBlock, true) : null;
    return (hovered && hasAudio(hovered) === true) ? hovered : autoRec;
  }

  /** Put a clip's gain on its element: volume follows the ramp, muted when silent. */
  function applyGain(rec) {
    if (rec.released) return;
    const v = rec.v;
    const level = soundLevel();
    const vol = clamp(rec.gain * level, 0, 1);
    try { v.volume = vol; } catch {}
    if (vol <= 0 || soundBlocked) {
      if (!v.muted) v.muted = true;
      return;
    }
    if (!v.muted) return;
    v.muted = false;
    // Without a click on the page the browser may refuse sound (and pause
    // the clip): keep it playing muted and ask for a click.
    const p = v.play();
    if (p && p.catch) {
      p.catch(() => {
        if (rec.released) return;
        v.muted = true;
        if (running) v.play().catch(() => {});
        if (!soundBlocked) {
          soundBlocked = true;
          if (els && active && audioRec && hasAudio(audioRec) === true) els.soundNote.hidden = false;
        }
      });
    }
  }

  function rampTick() {
    rampTimer = 0;
    const t = now();
    for (const rec of [...fadingRecs]) {
      if (rec.released) { fadingRecs.delete(rec); continue; }
      const k = Math.min(1, (t - rec.t0) / AUDIO_FADE_MS);
      // Quarter-sine curves: the clip coming in and the one going out always
      // sum to constant power, and each curve starts and ends gently.
      const q = k * Math.PI / 2;
      rec.gain = rec.to >= rec.from
        ? rec.from + (rec.to - rec.from) * Math.sin(q)
        : rec.to + (rec.from - rec.to) * Math.cos(q);
      if (k >= 1) { rec.gain = rec.to; fadingRecs.delete(rec); }
      applyGain(rec);
    }
    if (fadingRecs.size) rampTimer = setTimeout(rampTick, RAMP_STEP_MS);
  }

  function fadeTo(rec, to) {
    if (rec.to === to && (fadingRecs.has(rec) || rec.gain === to)) return;
    rec.from = rec.gain;
    rec.to = to;
    rec.t0 = now();
    fadingRecs.add(rec);
    if (!rampTimer) rampTimer = setTimeout(rampTick, 0);
  }

  /**
   * Bring every clip's sound in line with what should be heard: the wanted
   * clip fades in, every other one fades out (a crossfade on a handover).
   * A paused, hidden or left wall is silenced at once.
   */
  function syncAudio() {
    if (!els) return;
    // Any click or key press on the page since (a user gesture) lets sound play.
    if (soundBlocked && navigator.userActivation && navigator.userActivation.hasBeenActive) soundBlocked = false;

    const want = wantedRec();
    const recs = liveRecs();
    if (!running) {
      for (const rec of recs) {
        fadingRecs.delete(rec);
        rec.gain = 0; rec.to = 0;
        applyGain(rec);
      }
      audioRec = null;
    } else {
      audioRec = want && soundLevel() > 0 ? want : null;
      // At most one clip fades out, the loudest; any other still sounding
      // (a handover overtaken in the settle window, on start or unmute) is
      // silenced now. So never more than two clips are partly audible: a
      // new pick starts one fresh crossfade instead of layering a third.
      const out = fadeOutPick(recs, audioRec);
      for (const rec of recs) {
        if (rec === audioRec) fadeTo(rec, 1);
        else if (rec === out) fadeTo(rec, 0);
        else if (rec.gain > 0 || rec.to > 0) {
          fadingRecs.delete(rec);
          rec.gain = 0; rec.from = 0; rec.to = 0;
        }
        // A clip not fading takes a changed level (the player's volume) here.
        if (!fadingRecs.has(rec)) applyGain(rec);
      }
    }
    // The speaker badge only on a clip that has sound (hover may pick a silent one).
    const badge = audioRec && hasAudio(audioRec) === true ? audioRec : null;
    for (const b of blocks) {
      b.el.classList.toggle('wall-audible', !!badge && b.video === badge);
    }
    // The note only while there is something to hear.
    els.soundNote.hidden = !(soundBlocked && active && badge);
  }

  /* ── The scheduler ──────────────────────────────────────────────────── */

  /**
   * The block shows its next file, one whose shape fits the slot: a
   * picture's time is up (Grid), or a clip ended or its time is up.
   */
  function advance(b) {
    const { i, fit } = swapIndex(ready, b);
    if (i < 0) { fill(); setDue(b, now() + 2000); return; }
    if (!fit && !b.fitWait && ready.length < READY_CAP) {
      // Nothing of this shape in the buffer: fetch one more batch (never past
      // the cap) and try once more shortly, before falling back to a crop.
      b.fitWait = true;
      if (!fillPromise) stats.moreFetches++;
      fill(true);
      setDue(b, now() + 1500);
      return;
    }
    b.fitWait = false;
    const next = take(i);
    stats.swaps++;
    if (!fit) {
      stats.crops++;
      stats.worstCrop = Math.max(stats.worstCrop, Math.exp(Math.abs(Math.log(aspectOf(next) / b.aspect))));
    }
    else if (Math.abs(Math.log(aspectOf(next) / b.aspect)) <= 0.01) stats.exact++;
    else stats.near++;
    if (b.video) {
      // The old clip keeps playing under the fade and is released after it.
      b.video = null;
      b.lastPlayedAt = now();
    }
    showStill(b, next);
    // Scroll changes no pictures on a timer: a still waits for a slot or its way off the top.
    setDue(b, cfg.mode === 'scroll' ? Infinity : now() + stillDelay());
  }

  /* Videos at once, Auto: the wiring around autoStep. */

  /** Start a new window: counts back to zero, every playing clip's frame counts as the base. */
  function autoReset(t) {
    auto.windowAt = t;
    auto.stalls = 0;
    auto.frames = 0;
    auto.hitches = 0;
    for (const rec of liveRecs()) if (rec.startedAt) rec.q = frameCounts(rec.v);
  }

  /** A block that could play now is kept from it by the target alone. */
  function autoWanting() {
    if (liveCost + 1 <= auto.target) return false;
    const free = blocks.filter(b => canPlay(b) && !b.held);
    if (cfg.mode !== 'scroll') return free.length > 0;
    return scrollRank(free, drift.offset, lay.H).length > 0;
  }

  /** From the tick: every AUTO_WINDOW_MS, judge the window and move the target. Frozen while hidden. */
  function autoTick(t) {
    if (cfg.playing !== 'auto' || document.visibilityState === 'hidden') { auto.windowAt = 0; return; }
    if (!auto.windowAt) { autoReset(t); return; }
    if (t - auto.windowAt < AUTO_WINDOW_MS) return;
    let total = 0;
    let dropped = 0;
    for (const rec of liveRecs()) {
      if (!rec.startedAt || !rec.q) continue;
      const q = frameCounts(rec.v);
      total += Math.max(0, q.total - rec.q.total);
      dropped += Math.max(0, q.dropped - rec.q.dropped);
    }
    const sample = {
      dropRate: total > 0 ? dropped / total : null,
      stalls: auto.stalls,
      hitchRate: cfg.mode === 'scroll' && auto.frames >= 20 ? auto.hitches / auto.frames : null,
      wanting: autoWanting(),
    };
    const next = autoStep(auto, sample, t);
    auto.lastSample = { ...sample, at: t, target: next.target };
    auto.log.push(auto.lastSample);            // for Wall._stats() (debugging)
    if (auto.log.length > 30) auto.log.shift();
    const changed = next.target !== auto.target;
    auto.target = next.target;
    auto.holdUntil = next.holdUntil;
    autoReset(t);
    if (changed) { syncControls(); trimVideos(); }
  }

  /**
   * The freeze watchdog, from the tick: a clip that should be playing
   * (shouldAdvance) and whose time has not moved for FREEZE_MS is freed like
   * one that ended, and its block takes a new file. Only a second freeze of
   * the same file in a session leaves it out (badIds).
   */
  function watchFrozen(t) {
    const dt = lastTickAt ? t - lastTickAt : 0;
    lastTickAt = t;
    const hidden = document.visibilityState === 'hidden';
    const seen = [];
    let moving = 0;
    for (const b of blocks) {
      const rec = b.video;
      if (!rec || rec.released || b.dead || rec.frozen) continue;
      let pos = NaN;
      try { pos = rec.v.currentTime; } catch {}
      const moved = Number.isFinite(pos) && Number.isFinite(rec.wPos) && Math.abs(pos - rec.wPos) > 0.001;
      if (Number.isFinite(pos)) rec.wPos = pos;
      if (moved) moving++;
      seen.push({ b, rec, moved });
    }
    for (const { b, rec, moved } of seen) {
      const should = shouldAdvance({
        running, started: !!b.startedAt, ended: rec.v.ended, held: b.held, hidden,
        keepPlaying: !!cfg.keepPlaying2, othersMoving: moving - (moved ? 1 : 0) > 0,
      });
      const step = freezeStep(rec.still, { moved, should, dt });
      rec.still = step.still;
      if (!step.frozen) continue;
      rec.frozen = true;
      stats.freezes++;
      const n = (freezeCounts.get(rec.id) || 0) + 1;
      freezeCounts.set(rec.id, n);
      if (n >= FREEZES_BAD) badIds.add(rec.id);
      setDue(b, 0);   // the same way out as a clip that ended
    }
  }

  function tick() {
    if (!running) return;
    const t = now();
    const grid = cfg.mode !== 'scroll';
    let swaps = 0;
    watchFrozen(t);
    for (const b of blocks) {
      if (b.dead || b.held) continue;
      if (b.video && b.loadDeadline && t > b.loadDeadline) { videoFailed(b, b.video); continue; }
      // At most a few swaps per tick, so a burst of due blocks spreads out.
      if (grid && t >= b.dueAt && !b.pending && swaps < 3) {
        advance(b);
        swaps++;
      } else if (!grid && b.video && t >= b.dueAt && !b.pending && swaps < 3) {
        advance(b);     // a clip that ended or whose time is up in Scroll mode
        swaps++;
      }
    }
    if (pageAction('clip') === 'replay') replayHeld();
    autoTick(t);
    fillSlots();
    updateStatus();
    syncAudio();
  }

  function setRunning(on) {
    if (on === running) { syncDrift(); syncAudio(); return; }
    running = on;
    auto.windowAt = 0;          // Auto judges only time spent running
    lastTickAt = 0;             // the freeze watchdog counts only time spent running
    if (on) {
      const d = pausedAt ? now() - pausedAt : 0;
      for (const b of blocks) {
        if (Number.isFinite(b.dueAt)) b.dueAt += d;
        if (b.loadDeadline) b.loadDeadline += d;
        if (b.startedAt) b.startedAt += d;
        if (b.video) {
          if (b.video.startedAt) b.video.startedAt += d;
          b.video.v.play().catch(() => {});
        }
      }
      tickTimer = setInterval(tick, TICK_MS);
      tick();
    } else {
      pausedAt = now();
      workerTicks(false);
      clearInterval(tickTimer);
      tickTimer = null;
      for (const b of blocks) if (b.video) { try { b.video.v.pause(); } catch {} }
    }
    syncDrift();
    syncAudio();
  }

  /**
   * One place decides whether the wall runs. Off the tab or under the player
   * the videos are released outright (their connections are needed
   * elsewhere). A hidden window releases the remux streams and pauses the
   * rest; the Pause button only pauses.
   */
  function evaluate() {
    if (!els) return;
    const release = !active || playerOpen;
    // Hidden: pause and give up the converted clips, unless the Wall keeps playing.
    const hiddenStop = pageAction('page') === 'pause';
    if (release && liveCost > 0) {
      // Under the player the board stays: its clips carry on from here after.
      if (active && playerOpen) rememberTimes();
      releaseAllVideos();
    }
    else if (hiddenStop && liveRemux > 0) releaseRemuxVideos();
    setRunning(active && built && !userPaused && !playerOpen && !hiddenStop);
    // Running in a hidden page: the tick comes from the worker (see workerTicks).
    workerTicks(running && document.visibilityState === 'hidden');
    els.pauseBtn.textContent = userPaused ? 'Resume' : 'Pause';
    els.pauseBtn.setAttribute('aria-pressed', String(userPaused));
    els.paused.hidden = !(built && userPaused);
  }

  /* ── Actions ────────────────────────────────────────────────────────── */

  async function rebuild() {
    const gen = ++buildGen;
    built = false;
    setRunning(false);
    teardownBlocks();
    updateStatus();
    showMsg('Loading the wall...');
    poolKey = computePoolKey();
    try {
      await buildPool();
    } catch (err) {
      if (gen !== buildGen) return;
      showMsg(typeof friendlyError === 'function' ? friendlyError(err, 'loading the wall') : 'Could not load the wall.');
      return;
    }
    if (gen !== buildGen) return;
    if (!ready.length) {
      showEmpty();
      return;
    }
    await shapesFor(LOOKAHEAD * 3, 2500);
    if (gen !== buildGen) return;
    showMsg('');
    if (!active) return;            // left while loading: lay out on the way back in
    dirty = layout() ? false : 'fresh';
    built = true;
    evaluate();
  }

  /** Shuffle again (the Order menu): a fresh shuffle of the source and a new board. Shuffle only. */
  function shuffleNow() {
    if (cfg.order !== 'shuffle' || !poolIds || !poolIds.length) return;
    poolGen++;
    fillPromise = null;
    shuffleInPlace(poolIds);
    poolCursor = 0;
    ready = [];
    const gen = poolGen;
    fill().then(() => shapesFor(LOOKAHEAD * 2, 1500)).then(() => {
      if (gen !== poolGen) return;
      if (!active || !layout()) { markDirty(false); return; }
      dirty = false;
      built = true;
      evaluate();
      if (running) fillSlots();
    });
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (els.root.requestFullscreen) {
      els.root.requestFullscreen().catch(() => {});
    }
  }

  async function openItem(b) {
    const item = b.item;
    if (!item) return;
    // A clip that is playing (or paused on hover) continues in the player from
    // where it is. Read now: opening the player releases every clip. A still,
    // or a clip not started yet, opens as before.
    const rec = b.video;
    pendingStart = null;
    if (rec && !rec.released && b.startedAt && item.media_type === 'video') {
      const t = rec.v.currentTime;
      if (Number.isFinite(t) && t > 0) pendingStart = { id: item.id, time: t, until: now() + START_TTL_MS };
    }
    // The player lives outside the wall, so over a full-screen wall it goes
    // full screen too, on top: closing it then goes back to the full-screen
    // wall (leaving full screen drops only the top level). Any other full
    // screen is left first, as before.
    const overWall = document.fullscreenElement === els.root;
    if (document.fullscreenElement && !overWall) { try { await document.exitFullscreen(); } catch {} }
    if (!Library.row(item.id)) { try { await Library.fetchRows([item.id]); } catch {} }
    if (typeof playMediaById === 'function') playMediaById(item.id);
    const ov = document.getElementById('mediaPlayerOverlay');
    if (overWall && document.fullscreenElement === els.root && ov && ov.classList.contains('active')) {
      // Refused (the click too long ago, say): leave full screen altogether
      // rather than keep the player hidden behind the wall.
      // (exitAllFullscreen is player-core.js's.)
      ov.requestFullscreen().catch(() => exitAllFullscreen());
    }
  }

  /** The player is full screen on top of the full-screen wall. */
  function underPlayer() {
    return rootFs && !!document.fullscreenElement && document.fullscreenElement !== (els && els.root);
  }

  /* ── Continue in the player ─────────────────────────────────────────── */

  // openItem leaves { id, time, until } here; the player's first
  // loadedmetadata for that file takes it (viewtracker.js -> wallStartAt).
  // A remux stream is a VOD playlist on the file's own timeline from 0, on
  // the Wall and in the player alike, so the clip's time is the player's time.
  const START_TTL_MS = 15000;   // a remux stream can take a while to start
  let pendingStart = null;

  /**
   * The start time for `id` if `pending` is for that file and not expired.
   * Pure, for the tests. Any answer (a time or null) uses the pending value up.
   */
  function takeStart(pending, id, t) {
    if (!pending || id == null || pending.id !== id) return null;
    if (!(t <= pending.until)) return null;
    return pending.time;
  }

  /** viewtracker.js asks this before its resume seek; true = handled. */
  function startAt(el) {
    const p = pendingStart;
    if (!p || !el) return false;
    pendingStart = null;
    let id = Number(el.dataset && el.dataset.playbackMediaId) || null;
    if (!id && typeof currentMediaState !== 'undefined' && currentMediaState.currentMediaData) id = currentMediaState.currentMediaData.id;
    // A file outside the current library results (the Wall showing a
    // collection or saved search) plays by path, with neither id above.
    if (!id && typeof _mediaItemFromSrc === 'function') id = _mediaItemFromSrc(el.currentSrc || el.src)?.id || null;
    const t = takeStart(p, id, now());
    if (t == null) return false;
    // A clip at its very end would open on the last frame: start as usual.
    if (!(el.duration > t + 1)) return false;
    try { el.currentTime = t; } catch { return false; }
    return true;
  }

  /* ── Keep clip times over the player ────────────────────────────────── */

  // Opening a clip in the player releases every clip on the board. Each
  // block remembers where its clip was (b.resume), and the player reports
  // where it left each file it played (playerLeft, id -> seconds), so on
  // return the same clips carry on from their own times and the opened one
  // from where it was watched to.
  const playerLeft = new Map();

  function rememberTimes() {
    for (const b of blocks) {
      b.resume = null;
      const rec = b.video;
      if (!rec || rec.released || !b.startedAt) continue;
      let t = NaN;
      try { t = rec.v.currentTime; } catch {}
      if (Number.isFinite(t) && t > 0) b.resume = { id: rec.id, time: t };
      // A converted clip's 3-minute limit starts over when it comes back.
      if (rec.mode === 'remux') setDue(b, Infinity);
    }
  }

  /**
   * The player closed: each block showing a file the player played carries
   * on from the player's time. The rest of the record is dropped, so a file
   * that comes up later starts fresh.
   */
  function keepPlayerTimes() {
    for (const b of blocks) {
      const id = b.item && b.item.id;
      if (id != null && playerLeft.has(id)) b.resume = { id, time: playerLeft.get(id) };
    }
    playerLeft.clear();
  }

  /**
   * Where a block's clip starts on return from the player (pure): the
   * player's time for this file first, then the block's own. null = no
   * memory (a fresh start); 'ended' = within END_GAP_S of the end.
   */
  const END_GAP_S = 1;
  function resumeAt(resume, left, id, dur) {
    let t = null;
    if (typeof left === 'number' && left >= 0) t = left;   // Infinity: watched to the end
    else if (resume && resume.id === id && typeof resume.time === 'number' && resume.time >= 0) t = resume.time;
    if (t == null) return null;
    if (t === Infinity || (dur > 0 && t > dur - END_GAP_S)) return 'ended';
    return t;
  }

  /** player-core.js stopping a player element (viewtracker.js passes it on). */
  function playerStopped(el) {
    if (!playerOpen || !el || el.tagName !== 'VIDEO') return;
    let id = Number(el.dataset && el.dataset.playbackMediaId) || null;
    if (!id && typeof _mediaItemFromSrc === 'function') id = _mediaItemFromSrc(el.currentSrc || el.src)?.id || null;
    const t = el.currentTime;
    if (id && Number.isFinite(t)) playerLeft.set(id, el.ended ? Infinity : t);
  }

  /* ── Tab hooks ──────────────────────────────────────────────────────── */

  function enter() {
    if (!cfg) cfg = loadCfg();
    ensureDom();
    active = true;
    document.body.classList.add('wall-active');
    window.scrollTo(0, 0);
    placeRoot();
    populateSources();
    applyReducedMotion();
    syncControls();
    if (!built || computePoolKey() !== poolKey) rebuild();
    else if (dirty || !blocks.length) {
      // Something asked for a layout while the tab was hidden, or the board
      // is empty: lay it out now that it has a size.
      const keep = dirty !== 'fresh';
      dirty = false;
      relayout(keep);
      evaluate();
    } else {
      // Back on the tab with the same source: plan again if the window changed.
      refitBoard();
      evaluate();
    }
  }

  function leave() {
    active = false;
    document.body.classList.remove('wall-active');
    if (els) setMenu(null);
    if (document.fullscreenElement === (els && els.root)) document.exitFullscreen().catch(() => {});
    evaluate();
  }

  /** The library locked: drop everything. Unlocking reloads the page. */
  function lockStop() {
    if (!els) return;
    active = false;
    document.body.classList.remove('wall-active');
    built = false;
    dirty = false;
    buildGen++;
    poolGen++;
    setRunning(false);
    teardownBlocks();
    ready = [];
    poolIds = null;
    try { Library.pin('wall', []); } catch {}
  }

  return {
    enter, leave, lockStop, startAt, playerStopped, underPlayer,
    // Pure pieces, for test/wall-layout.test.js.
    _pure: { emptyMessage, cfgFrom, takeStart, resumeAt, planColumns, colSpread, slotFor, placeSlot, minBottom, planSlices, sliceRow, slicePool, rectGap, placeSlice, fitGrid, fitScore, SLICE_MIN, SLICE_MAX, pickSwap, fillTarget, batchSize, takeAt, pickAudible, rotatePick, rotateWaitMs, rotateDue, fadeOutPick, clipStart, staggerShare, storedAudio, setDue, clipDue, clipLeft, shouldAdvance, freezeStep, REMUX_MAX_RUN_MS, FREEZE_MS, FREEZE_DT_MAX_MS, visibleFrac, inView, scrollLeftMs, scrollRank, leavingFor, scrollFreePlan, autoStep, START_FRAC, HEAR_FRAC, ROTATE_MIN_LEFT_MS, MIN_RUN_S, AUTO_START, AUTO_MIN, AUTO_MAX, AUTO_HOLD_MS, READY_CAP, STALE_SKIPS },
    // Sound state, for tests and debugging: every live clip's element state.
    _audio: () => {
      const t = now();
      const keyOf = (r) => { if (!dbgKeys.has(r)) dbgKeys.set(r, ++dbgSeq); return dbgKeys.get(r); };
      const byRec = new Map();
      for (const b of blocks) if (b.video) byRec.set(b.video, b);
      return {
        sound: cfg && cfg.sound,
        level: soundLevel(),
        blocked: soundBlocked,
        note: !!(els && !els.soundNote.hidden),
        heard: audioRec ? keyOf(audioRec) : null,
        auto: autoRec ? keyOf(autoRec) : null,
        handoverAt: autoAt,
        badges: els ? els.track.querySelectorAll('.wall-block.wall-audible').length : 0,
        clips: liveRecs().map((r) => {
          const b = byRec.get(r);
          return {
            key: keyOf(r), id: r.id, audio: r.audio, muted: r.v.muted, volume: +r.v.volume.toFixed(3), paused: r.v.paused, gain: +r.gain.toFixed(3),
            current: !!b, started: b ? b.startedAt : 0, left: b && playingRec(b) ? Math.round(timeLeft(b, t)) : null,
            y: b ? Math.round(b.y - drift.offset) : null,
          };
        }),
      };
    },
    // For tests and debugging in the console.
    _stats: () => ({
      mode: cfg && cfg.mode,
      blocks: blocks.length,
      domBlocks: els ? els.track.querySelectorAll('.wall-block').length : 0,
      liveCost,
      liveRemux,
      videos: els ? els.board.querySelectorAll('video').length : 0,
      playing: els ? [...els.board.querySelectorAll('video')].filter(v => !v.paused).length : 0,
      hls: blocks.reduce((n, b) => n + [...b.el.querySelectorAll('video')].filter(v => v._wallRec && v._wallRec.hls).length, 0),
      ready: ready.length,
      pool: poolIds ? poolIds.length : 0,
      running,
      userPaused,
      drifting: !!drift.raf,
      offset: drift.offset,
      rebases: drift.rebases,
      removed: drift.removed,
      lay: { layout: lay.layout, W: lay.W, H: lay.H, cols: lay.cols, cw: lay.cw, gap: lay.gap, base: lay.base,
        minBottom: lay.tops.length || lay.layout === 'slices' ? minBottom(lay) : 0 },
      auto: { ...auto, log: auto.log.slice(), cap: cfg ? playCap() : 0 },
      ...stats,
    }),
    _blocks: () => blocks.map(b => ({
      id: b.item && b.item.id, x: b.x, y: b.y, w: b.w, h: b.h,
      stored: b.item ? aspectOf(b.item) : 0, cropped: b.cropped, video: !!b.video,
      remux: !!(b.video && b.video.mode === 'remux'),
      due: b.dueAt, hovered: b.hovered, held: b.held, audible: b.el.classList.contains('wall-audible'),
    })),
    _frames: (reset) => { const f = drift.frames.slice(); if (reset) drift.frames = []; return f; },
    _cfg: () => ({ ...cfg }),
    _queue: () => ready.map(r => ({ id: r.id, a: +aspectOf(r).toFixed(2), known: shapeKnown(r), on: onScreen.has(r.id), bad: badIds.has(r.id) })),
  };
})();

function wallEnter() { Wall.enter(); }
function wallLeave() { Wall.leave(); }
function wallLockStop() { Wall.lockStop(); }
function wallStartAt(el) { return Wall.startAt(el); }
function wallPlayerStopped(el) { Wall.playerStopped(el); }
function wallUnderPlayer() { return Wall.underPlayer(); }
