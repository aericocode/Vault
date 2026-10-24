/* =========================================================================
   WALL - a screen-filling collage of the library (LIBRARY_LAYOUT_SPEC Part 2
   and Round 2)

   Masonry columns of blocks that keep each file's shape. A few videos play
   muted at once, the rest of the blocks show pictures. Two modes:

   - Grid: a still board. Blocks change their content on a timer (pictures
     every "Pictures" seconds, clips after "Clips" seconds), crossfading.
   - Scroll: the board drifts upward. New files join at the bottom of the
     shortest column, files that leave the top are released and dropped.

   Ambient, so smoothness wins over features:

   - Fixed slots. The columns are planned once per board size; a block's
     place and size never change after it is placed. A swap brings in a file
     whose stored shape is within about 15% of the slot; when the queue has
     none, the incoming file is cropped into the slot (object-fit: cover).
     A real size the element reports later is remembered for later picks and
     never moves anything. Block size, gap and window size changes plan the
     board again, once, behind a short fade.
   - Blocks are absolutely placed inside one track element. Scroll mode moves
     only the track (translate3d from requestAnimationFrame), so a frame does
     no layout. Blocks that leave the top go from the DOM; every so often the
     coordinates are rebased in the same frame so the numbers stay small.
   - The playing cap is counted on live <video> elements, including one that
     is still fading out. A remux (HLS) stream counts as 2 and only one runs
     at a time: the server runs at most 2 FFmpeg sessions for the whole app
     and a third would kill the main player's. In Scroll mode the slots go to
     blocks mostly in view first (at least 66% of the block, or of the board
     for a taller block, is on the board); a playing block that is no longer
     mostly in view at the top, or is off the board, is the first to give its
     slot to a block mostly in view that needs one.
   - Every replaced <video> is released (pause, src removed, load(), hls
     destroyed, stream closed). Leaving the tab, opening the player, locking
     the library or closing the page releases them all. A hidden browser tab
     releases the remux streams (so their FFmpeg sessions stop instead of
     idling out a minute later) and pauses the rest; on return the freed
     slots start again with fresh streams. The Pause button only pauses.
   - One 250 ms scheduler tick drives every block (no timer per block).

   Sound (the "Sound" choice in the gear popover): Off, On hover (only the
   hovered clip is heard), or Auto (exactly one playing clip that has an
   audio track is heard; when it stops, the sound moves to the playing clip
   with sound that has the most time left on the wall, and never away from
   one that is still playing; no clip with sound, no sound and no badge).
   Whether a clip has sound comes from the row's probe (audio_codec), else
   from the element once it plays. Every handover is a short volume
   crossfade, and at most two clips are ever partly audible (one fading out,
   one fading in). Grid clips start staggered over the clip length, so they
   never all stop together. The level and mute come from the player's
   stored volume (vault_volume). In Auto, a hovered clip borrows the sound
   while hovered when "Pause on hover" is on; with it off, hovering is only
   the caption and Auto keeps its pick. A browser that refuses sound before
   a click keeps the clip playing muted and asks for a click on the wall.

   Sources go through the existing query API (Library.queryOnce: POST
   /api/library/query + the binary id list) and rows through Library.fetchRows
   (POST /api/media/rows). Thumbnails go through thumbs.js, so the vault's
   blob mode works unchanged. Videos use /media/:id (the same URL the player's
   native path gets) and /stream/:id via /api/playback for remux.

   Globals used by tabs.js / vault-ui.js: wallEnter(), wallLeave(), wallLockStop().
   viewtracker.js asks wallStartAt(el) so a clicked clip continues in the
   player from where it was on the Wall.
   ========================================================================= */

const Wall = (() => {
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
  const ASPECT_MIN = 0.25;
  const ASPECT_MAX = 4;
  const DEFAULT_ASPECT = 16 / 9;
  const MAX_BLOCKS = 1500;
  const READY_CAP = 1500;            // the most rows the buffer holds
  const REBASE_AT = 20000;           // scroll offset (px) at which coordinates are rebased
  const FS_IDLE_MS = 3000;
  // Scroll: a block is "mostly in view" while at least this share of its
  // height (of the board's height, for a block taller than the board) is on
  // the board, top or bottom part. It may play and be heard while it is.
  const MOSTLY = 0.66;

  /* ── Settings ───────────────────────────────────────────────────────── */

  let cfg = null;

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
    return out;
  }

  function loadCfg() {
    return cfgFrom((typeof window.vaultWallSettings === 'function' && window.vaultWallSettings()) || {});
  }

  function saveCfg() {
    if (typeof window.vaultSetWallSettings === 'function') window.vaultSetWallSettings(cfg);
  }

  /** The step index closest to a value in seconds (by ratio, not difference). */
  function nearestStep(steps, sec) {
    let best = 0;
    for (let i = 1; i < steps.length; i++) {
      if (Math.abs(Math.log(steps[i] / sec)) < Math.abs(Math.log(steps[best] / sec))) best = i;
    }
    return best;
  }

  /** Scroll speed level (1 to 10) in pixels per second. */
  const speedPx = () => 10 * Math.pow(1.4, cfg.scrollSpeed - 1);

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

  /** Scroll: at least MOSTLY of the block is on the board (half a pixel of slack). */
  function mostlyInView(y, h, top, H) {
    return visibleFrac(y, h, top, H) * Math.min(h, H) >= MOSTLY * Math.min(h, H) - 0.5;
  }

  /**
   * Scroll: ms until a block drifting up at `pxPerSec` stops being mostly in
   * view at the top (its bottom part shrinks below MOSTLY). Negative once past.
   */
  function scrollLeftMs(y, h, offset, H, pxPerSec) {
    return (y + h - MOSTLY * Math.min(h, H) - offset) / pxPerSec * 1000;
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
  // The plan: column count and width, x of each column, and each column's
  // next free y (its content bottom plus one gap).
  const lay = { W: 0, H: 0, cols: 0, cw: 0, gap: 0, colX: [], tops: [] };
  let hoverBlock = null;
  // A primary-button press that only closed the popover or turned sound on:
  // the click that follows it is swallowed. Any later press, or a click
  // that does not come within SWALLOW_MS (a right-click has none), ends it.
  let swallowUntil = 0;
  // Long enough for a slow press; every new press clears it anyway.
  const SWALLOW_MS = 5000;
  // Clips that start right after a layout get shorter first runs, spread
  // over the clip length, so a Grid's clips never all stop together.
  let staggerLeft = 0;
  let staggerFrom = 0;
  const STAGGER_WINDOW_MS = 4000;

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
  const stats = { swaps: 0, exact: 0, near: 0, crops: 0, worstCrop: 1, staleDropped: 0, moreFetches: 0, rowFetches: 0 };

  let liveCost = 0;            // slots held by live <video> elements
  let liveRemux = 0;

  // The pool: every id the source matches, in play order, and a buffer of
  // fetched, eligible rows waiting to go up on the wall.
  let poolKey = '';
  let poolIds = null;
  let poolCursor = 0;
  let poolGen = 0;
  let ready = [];
  const skipCounts = new WeakMap(); // buffered row → how often a take passed it over
  let fillPromise = null;
  let poolHasEligible = false;
  const onScreen = new Map();  // id → how many blocks show it
  const badIds = new Set();    // failed to load or play this session
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
    // The library as the controls describe it right now.
    if (typeof currentQuerySpec === 'function') {
      const spec = currentQuerySpec();
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
    const cw = Math.max(60, Math.min(W, cfg.colWidth));
    const est = Math.ceil((W * H * 1.6) / (cw * cw * 0.9));
    return Math.max(40, est + 40);
  }

  async function buildPool() {
    const gen = ++poolGen;
    ready = [];
    poolIds = null;
    poolCursor = 0;
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

  function planColumns(W, colWidth, gap) {
    const cols = Math.max(1, Math.round((W + gap) / (colWidth + gap)));
    const cw = (W - gap * (cols - 1)) / cols;
    const colX = [];
    for (let c = 0; c < cols; c++) colX.push(c * (cw + gap));
    return { cols, cw, gap, colX, tops: new Array(cols).fill(0) };
  }

  /**
   * Where the next block of this shape goes: the shortest column, and for a
   * file wider than 2.5:1 also the neighbour of it that is closer to level
   * (always including the shortest column, so the board keeps growing at
   * its lowest point whatever the shapes). `hole` is the space the lower
   * column leaves empty; the picker holds a wide file back while that hole
   * would be big, so in practice it lands where two bottoms are near level.
   */
  function slotFor(plan, aspect) {
    const { cols, cw, gap, colX, tops } = plan;
    let span = cols >= 2 && aspect > WIDE ? 2 : 1;
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
    const w = span * cw + (span - 1) * gap;
    return { col, span, x: colX[col], y, w, h: w / aspect, hole };
  }

  function placeSlot(plan, s) {
    for (let c = s.col; c < s.col + s.span; c++) plan.tops[c] = s.y + s.h + plan.gap;
  }

  /** The content bottom of the shortest column. */
  function minBottom(plan) {
    let m = Infinity;
    for (const t of plan.tops) m = Math.min(m, t - plan.gap);
    return m;
  }

  /**
   * Index of the best next item for the board being built: early in the
   * queue, not already on screen, and (for a wide file) only where its two
   * columns are close to level.
   */
  function buildIndex(plan, list, isOnScreen) {
    const n = Math.min(LOOKAHEAD, list.length);
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const r = list[i];
      let score = i * 0.01;
      if (isOnScreen(r)) score += 10;
      if (!shapeKnown(r)) score += 3;
      const s = slotFor(plan, aspectOf(r));
      // A wide file waits for two columns that are near level.
      if (s.span === 2 && s.hole > plan.cw * 0.12) score += 5 + s.hole / plan.cw;
      else if (s.span === 1 && plan.cols >= 2 && aspectOf(r) > WIDE) score += 6;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  /**
   * Index of the file a swap should bring into a slot of shape `aspect`
   * (pure: `o` gives aspectOf(r), usable(r), onScreen(r), currentId, order).
   *
   * Any file within the tolerance fits, wherever it sits in the buffer; a
   * file not on screen beats one that is, and the slot's current file comes
   * last. The position only chooses among fits, never whether one fits:
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
      const dup = (o.currentId != null && r.id === o.currentId) ? 2 : (o.onScreen(r) ? 1 : 0);
      const d = Math.abs(Math.log(o.aspectOf(r) / aspect));
      if (d <= SHAPE_TOL) {
        const key = o.order === 'order' ? i : d + i * 0.002;
        if (dup < bestDup || (dup === bestDup && key < bestKey)) { best = i; bestDup = dup; bestKey = key; }
      }
      // Nothing fits: the closest shape, so the crop is as small as it can be.
      if (dup < cropDup || (dup === cropDup && d < cropKey)) { crop = i; cropDup = dup; cropKey = d; }
    }
    // The slot's own file again only when everything else would be a repeat too.
    if (best >= 0 && (bestDup < 2 || cropDup >= 1)) return { i: best, fit: true };
    return { i: crop, fit: false };
  }

  function swapIndex(list, aspect, current) {
    return pickSwap(list, aspect, {
      aspectOf,
      usable: (r) => !badIds.has(r.id) && shapeKnown(r),
      onScreen: isOnScreen,
      currentId: current ? current.id : null,
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

  function slider(id, label, min, max, step, hint, out = true) {
    return `<label class="wall-field wall-slider" id="${id}Field" title="${hint}">
        <span class="wall-label">${label}</span>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}">
        ${out ? `<output id="${id}Out"></output>` : ''}
      </label>`;
  }

  function popSlider(id, label, key) {
    const r = RANGES[key];
    return `<label class="wall-pop-row">
        <span class="wall-label">${label}</span>
        <input type="range" id="${id}" min="${r.min}" max="${r.max}" step="${r.step}">
        <output id="${id}Out"></output>
      </label>`;
  }

  function ensureDom() {
    if (els) return;
    const root = document.getElementById('wallContainer');
    root.classList.add('wall-root');
    root.innerHTML = `
      <div class="wall-bar" id="wallBar">
        <label class="wall-field">
          <span class="wall-label">Source</span>
          <select id="wallSource" class="m-select"></select>
        </label>
        <div class="wall-seg" role="group" aria-label="Wall mode">
          <button type="button" class="wall-seg-btn" id="wallModeGrid" data-mode="grid">Grid</button>
          <button type="button" class="wall-seg-btn" id="wallModeScroll" data-mode="scroll">Scroll</button>
        </div>
        <button type="button" class="wall-btn" id="wallPauseBtn">Pause</button>
        <button type="button" class="wall-btn" id="wallShuffleBtn" title="Start over with a fresh shuffle">Shuffle</button>
        ${slider('wallPic', 'Pictures', 0, PIC_STEPS.length - 1, 1, 'How often pictures change. Faster to the right.')}
        ${slider('wallClip', 'Clips', 0, CLIP_STEPS.length - 1, 1, 'How long each clip plays. Faster to the right.')}
        ${slider('wallSpeed', 'Speed', RANGES.scrollSpeed.min, RANGES.scrollSpeed.max, 1, 'How fast the wall scrolls. Faster to the right.', false)}
        <span class="wall-note" id="wallNote" hidden>Paused for reduced motion</span>
        <span class="wall-status" id="wallStatus"></span>
        <button type="button" class="wall-btn wall-icon-btn" id="wallGearBtn" aria-label="More settings"
          title="More settings" aria-haspopup="dialog" aria-expanded="false" aria-controls="wallPop">
          ${typeof vaultIcon === 'function' ? vaultIcon('gear', 'modern-only') : ''}<svg class="classic-only" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>
        </button>
        <button type="button" class="wall-btn" id="wallFullBtn">Full screen</button>
        <div class="wall-pop" id="wallPop" role="dialog" aria-label="More settings" hidden>
          ${popSlider('wallPlaying', 'Videos at once', 'playing')}
          ${popSlider('wallColWidth', 'Block size', 'colWidth')}
          ${popSlider('wallGap', 'Gap', 'gap')}
          <label class="wall-pop-row">
            <span class="wall-label">Show</span>
            <select id="wallMix" class="m-select">
              <option value="both">Videos and pictures</option>
              <option value="videos">Videos only</option>
              <option value="pictures">Pictures only</option>
            </select>
          </label>
          <label class="wall-pop-row">
            <span class="wall-label">Order</span>
            <select id="wallOrder" class="m-select">
              <option value="shuffle">Shuffle</option>
              <option value="order">In order</option>
            </select>
          </label>
          <label class="wall-pop-row" title="Off: every clip is silent. On hover: the clip under the mouse is heard. Auto: one clip is always heard, the one with the most time left.">
            <span class="wall-label">Sound</span>
            <select id="wallSound" class="m-select">
              <option value="off">Off</option>
              <option value="hover">On hover</option>
              <option value="auto">Auto</option>
            </select>
          </label>
          <label class="wall-check" title="Hovering a block holds it: its timer waits, and Scroll mode stops drifting.">
            <input type="checkbox" id="wallHoverPause" class="m-check"> Pause on hover</label>
          <label class="wall-check" title="Skip videos that need converting on the fly. They are heavier to play.">
            <input type="checkbox" id="wallDirect" class="m-check"> Only files that play without converting</label>
          <label class="wall-check"><input type="checkbox" id="wallToEnd" class="m-check"> Play clips to the end</label>
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
      pic: $('wallPic'), picOut: $('wallPicOut'), picField: $('wallPicField'),
      clip: $('wallClip'), clipOut: $('wallClipOut'), clipField: $('wallClipField'),
      speed: $('wallSpeed'), speedField: $('wallSpeedField'),
      gear: $('wallGearBtn'),
      pop: $('wallPop'),
      playing: $('wallPlaying'), playingOut: $('wallPlayingOut'),
      colWidth: $('wallColWidth'), colWidthOut: $('wallColWidthOut'),
      gap: $('wallGap'), gapOut: $('wallGapOut'),
      mix: $('wallMix'),
      order: $('wallOrder'),
      sound: $('wallSound'),
      hoverPause: $('wallHoverPause'),
      soundNote: $('wallSoundNote'),
      direct: $('wallDirect'),
      toEnd: $('wallToEnd'),
      pauseBtn: $('wallPauseBtn'),
      shuffleBtn: $('wallShuffleBtn'),
      fullBtn: $('wallFullBtn'),
    };
    wireControls();
    wireBoard();
    syncControls();
  }

  const SPEED_WORDS = ['', 'Slowest', 'Very slow', 'Slow', 'Easy', 'Medium', 'Brisk', 'Quick', 'Fast', 'Very fast', 'Fastest'];

  function syncControls() {
    const scroll = cfg.mode === 'scroll';
    els.modeGrid.setAttribute('aria-pressed', String(!scroll));
    els.modeScroll.setAttribute('aria-pressed', String(scroll));
    els.picField.hidden = scroll;
    els.clipField.hidden = scroll;
    els.speedField.hidden = !scroll;

    els.pic.value = String(nearestStep(PIC_STEPS, cfg.picSpeed));
    els.picOut.textContent = `${cfg.picSpeed} s`;
    els.pic.setAttribute('aria-valuetext', `every ${cfg.picSpeed} seconds`);
    els.clip.value = String(nearestStep(CLIP_STEPS, cfg.clipLen));
    els.clip.disabled = cfg.clipsToEnd;
    els.clipOut.textContent = cfg.clipsToEnd ? 'To the end' : `${cfg.clipLen} s`;
    els.clip.setAttribute('aria-valuetext', cfg.clipsToEnd ? 'clips play to the end' : `${cfg.clipLen} seconds each`);
    els.speed.value = String(cfg.scrollSpeed);
    els.speed.setAttribute('aria-valuetext', SPEED_WORDS[cfg.scrollSpeed] || String(cfg.scrollSpeed));

    els.playing.value = String(cfg.playing);
    els.playingOut.textContent = String(cfg.playing);
    els.colWidth.value = String(cfg.colWidth);
    els.colWidthOut.textContent = `${cfg.colWidth} px`;
    els.gap.value = String(cfg.gap);
    els.gapOut.textContent = `${cfg.gap} px`;
    els.mix.value = cfg.mix;
    els.order.value = cfg.order;
    els.sound.value = cfg.sound;
    els.hoverPause.checked = cfg.pauseOnHover;
    els.direct.checked = cfg.directOnly;
    els.toEnd.checked = cfg.clipsToEnd;
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

  function wireControls() {
    // Block size and gap: the label follows the drag, the board is planned
    // again once, when the slider is let go (or a key press settles).
    const replanSoon = debounce(() => replan(true), 150);

    els.pic.addEventListener('input', () => {
      cfg.picSpeed = PIC_STEPS[clamp(Number(els.pic.value) | 0, 0, PIC_STEPS.length - 1)];
      syncControls();
      retimeStills();
    });
    els.clip.addEventListener('input', () => {
      cfg.clipLen = CLIP_STEPS[clamp(Number(els.clip.value) | 0, 0, CLIP_STEPS.length - 1)];
      syncControls();
      retimeClips();
    });
    els.speed.addEventListener('input', () => {
      cfg.scrollSpeed = clampNum(els.speed.value, RANGES.scrollSpeed);
      syncControls();
    });
    els.playing.addEventListener('input', () => {
      cfg.playing = clampNum(els.playing.value, RANGES.playing);
      els.playingOut.textContent = String(cfg.playing);
      trimVideos();
      fillSlots();
    });
    for (const key of ['colWidth', 'gap']) {
      const input = els[key];
      input.addEventListener('input', () => {
        els[key + 'Out'].textContent = `${clampNum(input.value, RANGES[key])} px`;
      });
      input.addEventListener('change', () => {
        const v = clampNum(input.value, RANGES[key]);
        if (v === cfg[key]) return;
        cfg[key] = v;
        saveCfg();
        replanSoon();
      });
    }
    for (const input of [els.pic, els.clip, els.speed, els.playing]) input.addEventListener('change', saveCfg);

    els.source.addEventListener('change', () => { cfg.source = els.source.value; saveCfg(); rebuild(); });
    els.mix.addEventListener('change', () => { cfg.mix = els.mix.value; saveCfg(); rebuild(); });
    els.order.addEventListener('change', () => { cfg.order = els.order.value; saveCfg(); rebuild(); });
    els.direct.addEventListener('change', () => { cfg.directOnly = els.direct.checked; saveCfg(); rebuild(); });
    els.sound.addEventListener('change', () => {
      cfg.sound = SOUNDS.includes(els.sound.value) ? els.sound.value : 'off';
      saveCfg();
      syncAudio();
    });
    els.hoverPause.addEventListener('change', () => {
      cfg.pauseOnHover = els.hoverPause.checked;
      saveCfg();
      // A block hovered right now takes the new rule at once.
      const b = hoverBlock;
      if (b) { hoverEnd(b); hoverStart(b); }
    });
    els.toEnd.addEventListener('change', () => {
      cfg.clipsToEnd = els.toEnd.checked;
      saveCfg();
      syncControls();
      retimeClips();
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
    els.shuffleBtn.addEventListener('click', shuffleNow);
    els.fullBtn.addEventListener('click', toggleFullscreen);

    // The gear popover: Escape or a click outside closes it. A click on the
    // board that closes it only closes it (it does not also open a file).
    els.gear.addEventListener('click', () => setPop(els.pop.hidden));
    // Only a primary-button press on the board is followed by a click to swallow.
    const swallowNext = (e) => {
      if (e.button === 0 && els.board.contains(e.target)) swallowUntil = now() + SWALLOW_MS;
    };
    // Registered first, so every press ends what an earlier one left behind.
    document.addEventListener('pointerdown', () => { swallowUntil = 0; }, true);
    document.addEventListener('pointerdown', (e) => {
      if (els.pop.hidden) return;
      if (els.pop.contains(e.target) || els.gear.contains(e.target)) return;
      setPop(false);
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
      const fs = document.fullscreenElement === els.root;
      els.root.classList.toggle('wall-fs', fs);
      els.fullBtn.textContent = fs ? 'Leave full screen' : 'Full screen';
      if (fs) showBarBriefly(); else { clearTimeout(fsTimer); els.root.classList.remove('wall-bar-idle'); }
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
      if (open !== playerOpen) { playerOpen = open; evaluate(); }
    };
    const mo = new MutationObserver(watch);
    if (ov) mo.observe(ov, { attributes: true, attributeFilter: ['class'] });
    if (mini) mo.observe(mini, { attributes: true, attributeFilter: ['class'] });
  }

  function setPop(open) {
    els.pop.hidden = !open;
    els.gear.setAttribute('aria-expanded', String(open));
    if (open) {
      const first = els.pop.querySelector('input, select');
      if (first) first.focus();
    }
  }

  /** Escape closes the popover; Space pauses the wall (not while typing or on a control). */
  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape' && !els.pop.hidden) {
      e.preventDefault();
      e.stopPropagation();
      setPop(false);
      els.gear.focus();
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
    // from dock.js; the Wall's own settings popover (a role=dialog too) is
    // the one layer Space still pauses under.
    if (els.pop.hidden && typeof dockModalLayerOpen === 'function' && dockModalLayerOpen()) return;
    e.preventDefault();
    setPaused(!userPaused);
  }

  let fsTimer = null;
  function showBarBriefly() {
    els.root.classList.remove('wall-bar-idle');
    clearTimeout(fsTimer);
    fsTimer = setTimeout(function hide() {
      if (!els.root.classList.contains('wall-fs')) return;
      // Kept while the popover is open or the mouse is on the bar.
      if (!els.pop.hidden || els.bar.matches(':hover')) { fsTimer = setTimeout(hide, FS_IDLE_MS); return; }
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
      x: slot.x, y: slot.y, w: slot.w, h: slot.h,
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

  /**
   * The next file for the board being built. When the queue is empty (a
   * tiny source, or the next batch not fetched yet) the board repeats what
   * it already shows, so it is always full.
   */
  function nextBuildItem() {
    const i = buildIndex(lay, ready, isOnScreen);
    if (i >= 0) return take(i);
    fill();
    if (!blocks.length) return null;
    return blocks[Math.floor(Math.random() * blocks.length)].item;
  }

  /** Put one more block on the board at the next place the plan has for it. */
  function addBlock(item) {
    const s = slotFor(lay, aspectOf(item));
    placeSlot(lay, s);
    const b = makeBlock(s);
    blocks.push(b);
    els.track.appendChild(b.el);
    showStill(b, item);
    return b;
  }

  /** How far the columns must reach: the screen (Grid) or a screen and a half (Scroll). */
  function fillLine() {
    return cfg.mode === 'scroll' ? drift.offset + lay.H + Math.max(400, lay.H * 0.5) : lay.H;
  }

  /**
   * Build the board from the buffer: columns planned from the board width,
   * blocks added to the shortest column until every column passes the
   * bottom edge (Scroll: half a screen further, for what drifts in next).
   */
  function layout() {
    layoutGen++;
    const W = els.board.clientWidth;
    const H = els.board.clientHeight;
    // A hidden board has no size: leave what is there alone (the caller marks
    // the board dirty and it is laid out on the way back in).
    if (!W || !H) return false;
    teardownBlocks();
    Object.assign(lay, planColumns(W, cfg.colWidth, cfg.gap), { W, H });
    drift.offset = 0;
    applyOffset();

    const line = fillLine();
    while (blocks.length < MAX_BLOCKS && minBottom(lay) < line) {
      const item = nextBuildItem();
      if (!item) break;
      addBlock(item);
    }

    const t = now();
    for (const b of blocks) {
      // Staggered so the pictures never all change together.
      setDue(b, t + (0.2 + Math.random() * 0.9) * cfg.picSpeed * 1000);
    }
    // ...and neither do the clips: the first ones get runs spread over the clip length.
    staggerLeft = cfg.playing;
    staggerFrom = now();
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
   * add blocks to the shortest column below the fold, and every so often
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
    for (let n = 0; n < 3 && blocks.length < MAX_BLOCKS && minBottom(lay) < line; n++) {
      const item = nextBuildItem();
      if (!item) break;
      const b = addBlock(item);
      setDue(b, Infinity);
    }
    if (removed) { pinOnScreen(); updateStatus(); }
    if (drift.offset > REBASE_AT) {
      const s = Math.floor(drift.offset);
      drift.offset -= s;
      for (let c = 0; c < lay.tops.length; c++) lay.tops[c] -= s;
      for (const b of blocks) {
        b.y -= s;
        b.el.style.top = `${b.y.toFixed(2)}px`;
      }
      drift.rebases++;
    }
  }

  /* ── Stills (pictures, and videos waiting for a slot) ───────────────── */

  function stillDelay() {
    return cfg.picSpeed * 1000 * (0.7 + Math.random() * 0.6);
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

  /** Clips loop (and run until their block leaves) in Scroll mode. */
  const toEnd = () => cfg.clipsToEnd && cfg.mode !== 'scroll';

  function clipMs() {
    if (cfg.mode === 'scroll' || cfg.clipsToEnd) return Infinity;
    return cfg.clipLen * 1000;
  }

  function startVideo(b) {
    const item = b.item;
    const mode = playMode(item);
    if (!mode || (mode === 'remux' && cfg.directOnly)) return false;
    const cost = mode === 'remux' ? REMUX_COST : 1;
    if (liveCost + cost > cfg.playing) return false;
    if (mode === 'remux' && liveRemux >= MAX_REMUX) return false;

    const v = document.createElement('video');
    v.className = 'wall-media';
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.loop = !toEnd();
    v.preload = 'auto';
    v.disablePictureInPicture = true;
    v.setAttribute('disableremoteplayback', '');
    const layer = document.createElement('div');
    layer.className = 'wall-layer wall-vlayer';
    layer.appendChild(v);
    b.el.insertBefore(layer, b.cap);

    // audio: whether the clip has sound, true/false from the probe, null until learned.
    // run: the share of the clip length this clip plays (below 1 only for a staggered start).
    const rec = { v, layer, hls: null, token: null, cost, mode, id: item.id, released: false,
      gain: 0, from: 0, to: 0, t0: 0, block: b, startedAt: 0, run: 1, audio: storedAudio(item) };
    v._wallRec = rec;
    liveCost += cost;
    if (mode === 'remux') liveRemux++;
    b.video = rec;
    b.startedAt = 0;
    setDue(b, Infinity);
    b.loadDeadline = now() + (mode === 'remux' ? REMUX_TIMEOUT_MS : LOAD_TIMEOUT_MS);

    // A random point, far enough from the end for a whole clip.
    const dur = Number(item.duration_seconds) || 0;
    const clip = toEnd() ? 0 : cfg.clipLen;
    const start = clip && dur > clip + 1 ? Math.random() * (dur - clip) : 0;

    v.addEventListener('playing', () => {
      if (b.video !== rec || b.dead) return;
      b.loadDeadline = 0;
      b.startedAt = now();
      rec.startedAt = b.startedAt;
      // The first clips after a layout: the first to start plays the whole
      // length, the next a share less, and so on, so they stop one by one.
      // Only clips starting soon after the layout are staggered; later ones play in full.
      if (now() - staggerFrom > STAGGER_WINDOW_MS) staggerLeft = 0;
      rec.run = staggerRun(staggerLeft, cfg.playing);
      if (staggerLeft > 0) staggerLeft--;
      setDue(b, b.startedAt + clipMs() * rec.run);
      learnAspect(item, v.videoWidth, v.videoHeight);
      reveal(b, layer);
      syncAudio();
      updateStatus();
    }, { once: true });
    v.addEventListener('ended', () => { if (b.video === rec) setDue(b, 0); });
    v.addEventListener('error', () => videoFailed(b, rec));

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
   * Free slots go to the video blocks that have waited longest. In Scroll
   * mode blocks mostly visible come first (those whose top has passed after
   * the rest of them), then blocks entering at the bottom. A playing block
   * that is no longer mostly visible at the top (or is off the board) gives
   * its slot to a mostly visible block that needs it, and only as many are
   * stopped as that block needs to start.
   */
  function fillSlots() {
    if (!running) return;
    if (cfg.mode !== 'scroll') {
      if (liveCost >= cfg.playing) return;
      // A still that is still loading does not hold its block back: the clip
      // layer goes on top of it either way.
      // Not the hovered block: Pause on hover asked it to stay as it is.
      const cands = blocks.filter(b => canPlay(b) && !b.held);
      cands.sort((a, c) => (a.lastPlayedAt - c.lastPlayedAt) || (a.rand - c.rand));
      for (const b of cands) {
        if (liveCost >= cfg.playing) break;
        startVideo(b);
      }
      return;
    }
    const top = drift.offset;
    const bottom = top + lay.H;
    const mostly = (b) => mostlyInView(b.y, b.h, top, lay.H);
    // Candidates: blocks whose top is on the board (one entering at the bottom
    // may take a free slot before it is mostly in view), and "late" blocks
    // whose top has passed but that are still mostly in view (most never got
    // a slot while the cap was full). A late clip would leave soon and every
    // start costs a seek on the drive, so late blocks come after the others
    // that are mostly in view, take only slots that are free, and never hold
    // slots back for themselves.
    const late = (b) => b.y < top;
    const cands = blocks.filter(b => canPlay(b) && b.y < bottom && (b.y >= top || mostly(b)));
    cands.sort((a, c) => (mostly(c) - mostly(a)) || (late(a) - late(c))
      || (a.lastPlayedAt - c.lastPlayedAt) || (a.y - c.y));
    // Playing blocks that are leaving the top (or off the board), soonest gone
    // first. Not the hovered one: Pause on hover asked it to stay.
    const leaving = blocks.filter(b => b.video && !b.held && !mostly(b) && (b.y < top || b.y >= bottom))
      .sort((a, c) => a.y - c.y);
    for (const b of cands) {
      const mode = playMode(b.item);
      if (!mode || (mode === 'remux' && cfg.directOnly)) continue;   // never plays here
      const cost = mode === 'remux' ? REMUX_COST : 1;
      if (cost > cfg.playing) continue;
      // Only a block mostly in view whose top is on the board may have leaving
      // clips stopped for it, and only as many as it needs to start.
      const claims = mostly(b) && !late(b);
      const pool = claims ? leaving : [];
      const plan = scrollFreePlan(cost, mode === 'remux', cfg.playing - liveCost, liveRemux < MAX_REMUX,
        pool.map(l => ({ cost: l.video.cost, remux: l.video.mode === 'remux' })));
      // A clip that is staying holds the remux slot: wait, and let the others play.
      if (plan === 'remux') continue;
      if (plan === null) {
        // Not enough room yet. A block mostly in view (top on the board)
        // holds back the slots that free up next for itself, until it starts
        // or its top passes the board top. At a cap of 2 this can leave a
        // slot idle for a remux clip that never gets room; a known trade-off,
        // without it remux clips in Scroll would hardly ever play.
        if (claims) break;
        continue;
      }
      for (const i of plan.slice().sort((x, y) => y - x)) stopVideo(pool.splice(i, 1)[0]);
      startVideo(b);
    }
  }

  /** "Videos at once" went down: stop the clips closest to their end (Scroll: nearest the top). */
  function trimVideos() {
    if (liveCost <= cfg.playing) return;
    const playing = blocks.filter(b => b.video)
      .sort(cfg.mode === 'scroll' ? (a, c) => a.y - c.y : (a, c) => a.dueAt - c.dueAt);
    for (const b of playing) {
      if (liveCost <= cfg.playing) break;
      stopVideo(b);
    }
    updateStatus();
  }

  function retimeStills() {
    if (cfg.mode === 'scroll') return;
    const t = now();
    const max = cfg.picSpeed * 1000;
    for (const b of blocks) {
      if (!b.video && b.dueAt - t > max) setDue(b, t + Math.random() * max);
    }
  }

  function retimeClips() {
    for (const b of blocks) {
      if (!b.video) continue;
      b.video.v.loop = !toEnd();
      if (b.startedAt) setDue(b, b.startedAt + clipMs() * b.video.run);
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

  const AUDIO_FADE_MS = 350;
  const AUTO_SETTLE_MS = 500;
  const RAMP_STEP_MS = 25;
  let autoAt = -Infinity;      // when Auto's last handover began

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

  /**
   * The share of the clip length a clip plays (pure): after a layout, the
   * first `playing` clips to start get playing/playing, (playing-1)/playing,
   * ... 1/playing, so their swaps spread over one clip length; `left` is how
   * many staggered starts remain. Every other clip plays the whole length.
   */
  function staggerRun(left, playing) {
    return left > 0 ? Math.min(1, left / Math.max(1, playing)) : 1;
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
   * clip for Auto must be mostly in view (once it is not, at the top, it may
   * lose its slot any moment); with `onBoard` (the hovered clip) any part of
   * it on the board will do.
   */
  function playingRec(b, onBoard) {
    const rec = b.video;
    if (!rec || rec.released || b.dead || !b.startedAt) return null;
    if (cfg.mode === 'scroll') {
      const top = drift.offset;
      const seen = onBoard
        ? b.y < top + lay.H && b.y + b.h > top
        : mostlyInView(b.y, b.h, top, lay.H);
      if (!seen) return null;
    }
    return rec;
  }

  /**
   * How long (ms) this clip still plays on the wall, as far as the wall
   * knows: Grid, until its swap or its end; Scroll, until it stops being
   * mostly in view at the top (from then on it can lose its slot at any
   * moment); Infinity while the drift is paused.
   */
  function timeLeft(b, t) {
    if (cfg.mode === 'scroll') {
      if (!driftShouldRun()) return Infinity;
      return scrollLeftMs(b.y, b.h, drift.offset, lay.H, speedPx());
    }
    // A held block gets at least 1.5 s again when the mouse leaves (hoverEnd).
    const swapIn = b.held ? Math.max(1500, b.holdLeft) : b.dueAt - t;
    const v = b.video.v;
    let mediaLeft = Infinity;
    if (!v.loop && Number.isFinite(v.duration) && v.duration > 0) mediaLeft = (v.duration - v.currentTime) * 1000;
    const left = Math.min(swapIn, mediaLeft);
    return Number.isNaN(left) ? Infinity : left;
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
        cands.push({ key: rec, left: timeLeft(b, t) - AUDIO_FADE_MS, startedAt: b.startedAt });
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
      rec.gain = rec.from + (rec.to - rec.from) * k;
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

  /** Grid mode: the block shows its next file, one whose shape fits the slot. */
  function advance(b) {
    const { i, fit } = swapIndex(ready, b.aspect, b.item);
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
    setDue(b, now() + stillDelay());
  }

  function tick() {
    if (!running) return;
    const t = now();
    const grid = cfg.mode !== 'scroll';
    let swaps = 0;
    for (const b of blocks) {
      if (b.dead || b.held) continue;
      if (b.video && b.loadDeadline && t > b.loadDeadline) { videoFailed(b, b.video); continue; }
      // At most a few swaps per tick, so a burst of due blocks spreads out.
      if (grid && t >= b.dueAt && !b.pending && swaps < 3) {
        advance(b);
        swaps++;
      } else if (!grid && b.video && t >= b.dueAt) {
        stopVideo(b);   // a clip that ended in Scroll mode
      }
    }
    fillSlots();
    updateStatus();
    syncAudio();
  }

  function setRunning(on) {
    if (on === running) { syncDrift(); syncAudio(); return; }
    running = on;
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
    if (release && liveCost > 0) releaseAllVideos();
    else if (document.hidden && liveRemux > 0) releaseRemuxVideos();
    setRunning(active && built && !userPaused && !playerOpen && !document.hidden);
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
      showMsg(cfg.source === 'library'
        ? 'Nothing to show. The Wall uses your current library filter; clear it or pick another source.'
        : 'Nothing to show from this source. Pick another source or change what it shows.');
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

  function shuffleNow() {
    if (!poolIds || !poolIds.length) return;
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
    // The player lives outside the wall, so it cannot show over a full-screen wall.
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
    if (!Library.row(item.id)) { try { await Library.fetchRows([item.id]); } catch {} }
    if (typeof playMediaById === 'function') playMediaById(item.id);
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
    if (els) setPop(false);
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
    enter, leave, lockStop, startAt,
    // Pure pieces, for test/wall-layout.test.js.
    _pure: { cfgFrom, takeStart, nearestStep, planColumns, slotFor, placeSlot, minBottom, pickSwap, fillTarget, batchSize, takeAt, pickAudible, fadeOutPick, staggerRun, storedAudio, setDue, visibleFrac, mostlyInView, scrollLeftMs, scrollFreePlan, MOSTLY, PIC_STEPS, CLIP_STEPS, RANGES, READY_CAP, STALE_SKIPS },
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
      lay: { W: lay.W, H: lay.H, cols: lay.cols, cw: lay.cw, gap: lay.gap, minBottom: lay.tops.length ? minBottom(lay) : 0 },
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
