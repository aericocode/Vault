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
     blocks fully in view first; blocks leaving the top give theirs up first.
   - Every replaced <video> is released (pause, src removed, load(), hls
     destroyed, stream closed). Leaving the tab, opening the player, locking
     the library or closing the page releases them all; a hidden browser tab
     or the Pause button only pauses them.
   - One 250 ms scheduler tick drives every block (no timer per block).

   Sources go through the existing query API (Library.queryOnce: POST
   /api/library/query + the binary id list) and rows through Library.fetchRows
   (POST /api/media/rows). Thumbnails go through thumbs.js, so the vault's
   blob mode works unchanged. Videos use /media/:id (the same URL the player's
   native path gets) and /stream/:id via /api/playback for remux.

   Globals used by tabs.js / vault-ui.js: wallEnter(), wallLeave(), wallLockStop().
   ========================================================================= */

const Wall = (() => {
  const CFG_VERSION = 2;
  const RANGES = {
    playing:     { min: 1, max: 16, step: 1, def: 6 },
    picSpeed:    { min: 2, max: 60, step: 1, def: 8 },     // seconds between picture changes
    clipLen:     { min: 5, max: 120, step: 1, def: 20 },   // seconds a clip plays
    colWidth:    { min: 120, max: 960, step: 10, def: 390 },
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

  /* ── Settings ───────────────────────────────────────────────────────── */

  let cfg = null;

  function clampNum(v, r) {
    const n = Number(v);
    if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return r.def;
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
    if (old && Number(raw.clipLen) >= 120) {
      out.clipLen = RANGES.clipLen.max;
      out.clipsToEnd = true;
    } else {
      out.clipLen = clampNum(raw.clipLen, RANGES.clipLen);
      out.clipsToEnd = raw.clipsToEnd === true;
    }
    const oldRow = Number(raw.blockSize);
    out.colWidth = old && raw.colWidth == null && raw.blockSize != null && Number.isFinite(oldRow)
      ? clampNum(oldRow * 1.5, RANGES.colWidth)
      : clampNum(raw.colWidth, RANGES.colWidth);
    out.gap = clampNum(raw.gap, RANGES.gap);
    out.scrollSpeed = clampNum(raw.scrollSpeed, RANGES.scrollSpeed);
    out.mode = MODES.includes(raw.mode) ? raw.mode : 'grid';
    out.mix = MIXES.includes(raw.mix) ? raw.mix : 'both';
    out.order = ORDERS.includes(raw.order) ? raw.order : 'shuffle';
    out.source = typeof raw.source === 'string' && /^(library|c:\d+|s:\d+)$/.test(raw.source) ? raw.source : 'library';
    out.soundOnHover = raw.soundOnHover === true;
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
  let swallowClick = false;

  const drift = { offset: 0, raf: 0, lastT: 0, frames: [], rebases: 0, removed: 0 };
  const stats = { swaps: 0, exact: 0, near: 0, crops: 0, worstCrop: 1 };

  let liveCost = 0;            // slots held by live <video> elements
  let liveRemux = 0;

  // The pool: every id the source matches, in play order, and a buffer of
  // fetched, eligible rows waiting to go up on the wall.
  let poolKey = '';
  let poolIds = null;
  let poolCursor = 0;
  let poolGen = 0;
  let ready = [];
  let fillPromise = null;
  let poolHasEligible = false;
  const onScreen = new Map();  // id → how many blocks show it
  const badIds = new Set();    // failed to load or play this session
  const aspectCache = new Map(); // id → the real shape, learned from the element
  const modeCache = new Map();   // id → 'native' | 'remux' | null

  const now = () => Date.now();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

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
      const target = more ? Math.min(READY_CAP, Math.max(readyTarget(), ready.length + 150)) : readyTarget();
      const scanLimit = Math.min(8000, Math.max(target * 3, poolIds.length));
      let scanned = 0;
      while (ready.length < target && scanned < scanLimit) {
        // A whole pass found nothing: the source has nothing the wall can show.
        if (scanned >= poolIds.length && !poolHasEligible) break;
        const ids = [];
        const n = Math.min(150, scanLimit - scanned);
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
    const r = ready.splice(i, 1)[0];
    if (ready.length < readyTarget() / 2) fill();
    return r;
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
   * Index of the file a swap should bring into a slot of shape `aspect`:
   * the earliest one within the tolerance, preferring one not already on
   * screen. `fit` is false when nothing fits and the closest shape will be
   * cropped into the slot.
   */
  function swapIndex(list, aspect, isOnScreen, current) {
    const n = list.length;            // the whole buffer: a few thousand compares at most
    let best = -1;
    let bestScore = Infinity;
    let first = -1;
    let firstScore = Infinity;
    for (let i = 0; i < n; i++) {
      const r = list[i];
      // A file whose shape is not known yet (still being read) waits: as a
      // guess it could be anything, and the slot would crop it badly.
      if (badIds.has(r.id) || !shapeKnown(r)) continue;
      const dup = (current && r.id === current.id) ? 2 : (isOnScreen(r) ? 1 : 0);
      const d = Math.abs(Math.log(aspectOf(r) / aspect));
      if (d <= SHAPE_TOL) {
        const score = d + i * 0.002 + dup;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      // Nothing fits: the closest shape, so the crop is as small as it can be.
      const fs = d + i * 0.002 + dup * 10;
      if (fs < firstScore) { firstScore = fs; first = i; }
    }
    if (best >= 0 && bestScore < 2) return { i: best, fit: true };
    if (best >= 0 && first >= 0 && firstScore >= 10) return { i: best, fit: true };
    return { i: first, fit: false };
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
          <select id="wallSource"></select>
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
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>
        </button>
        <button type="button" class="wall-btn" id="wallFullBtn">Full screen</button>
        <div class="wall-pop" id="wallPop" role="dialog" aria-label="More settings" hidden>
          ${popSlider('wallPlaying', 'Videos at once', 'playing')}
          ${popSlider('wallColWidth', 'Block size', 'colWidth')}
          ${popSlider('wallGap', 'Gap', 'gap')}
          <label class="wall-pop-row">
            <span class="wall-label">Show</span>
            <select id="wallMix">
              <option value="both">Videos and pictures</option>
              <option value="videos">Videos only</option>
              <option value="pictures">Pictures only</option>
            </select>
          </label>
          <label class="wall-pop-row">
            <span class="wall-label">Order</span>
            <select id="wallOrder">
              <option value="shuffle">Shuffle</option>
              <option value="order">In order</option>
            </select>
          </label>
          <label class="wall-check"><input type="checkbox" id="wallSound"> Sound on hover</label>
          <label class="wall-check" title="Skip videos that need converting on the fly. They are heavier to play.">
            <input type="checkbox" id="wallDirect"> Only direct-play files</label>
          <label class="wall-check"><input type="checkbox" id="wallToEnd"> Play clips to the end</label>
        </div>
      </div>
      <div class="wall-stage">
        <div class="wall-board" id="wallBoard"><div class="wall-track" id="wallTrack"></div></div>
        <div class="wall-msg" id="wallMsg" hidden></div>
        <div class="wall-paused" id="wallPaused" hidden>Paused</div>
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
    els.sound.checked = cfg.soundOnHover;
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
      cfg.soundOnHover = els.sound.checked;
      saveCfg();
      if (!cfg.soundOnHover) muteAll();
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
    document.addEventListener('pointerdown', (e) => {
      if (els.pop.hidden) return;
      if (els.pop.contains(e.target) || els.gear.contains(e.target)) return;
      setPop(false);
      if (els.board.contains(e.target)) swallowClick = true;
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
      if (swallowClick) { swallowClick = false; return; }
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
      b.dueAt = t + (0.2 + Math.random() * 0.9) * cfg.picSpeed * 1000;
    }
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
      ready = back.concat(ready);
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
    return cfg.mode === 'scroll' && active && built && running && !fading && !hoverBlock;
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
      b.dueAt = Infinity;
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
    setStillSrc(img, item, layer);

    whenImgReady(img, LOAD_TIMEOUT_MS).then((ok) => {
      if (b.dead || b.pending !== layer) { layer.remove(); return; }
      b.pending = null;
      if (ok) learnAspect(item, img.naturalWidth, img.naturalHeight);
      else if (kindOf(item) === 'picture') {
        // A picture that will not load: drop it and move on soon.
        badIds.add(item.id);
        b.dueAt = Math.min(b.dueAt, now() + 800);
      } else {
        layer.classList.add('wall-nothumb');
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

    const rec = { v, layer, hls: null, token: null, cost, mode, id: item.id, released: false };
    v._wallRec = rec;
    liveCost += cost;
    if (mode === 'remux') liveRemux++;
    b.video = rec;
    b.startedAt = 0;
    b.dueAt = Infinity;
    b.loadDeadline = now() + (mode === 'remux' ? REMUX_TIMEOUT_MS : LOAD_TIMEOUT_MS);

    // A random point, far enough from the end for a whole clip.
    const dur = Number(item.duration_seconds) || 0;
    const clip = toEnd() ? 0 : cfg.clipLen;
    const start = clip && dur > clip + 1 ? Math.random() * (dur - clip) : 0;

    v.addEventListener('playing', () => {
      if (b.video !== rec || b.dead) return;
      b.loadDeadline = 0;
      b.startedAt = now();
      b.dueAt = b.startedAt + clipMs();
      learnAspect(item, v.videoWidth, v.videoHeight);
      if (cfg.soundOnHover && b.hovered) unmute(b);
      reveal(b, layer);
      updateStatus();
    }, { once: true });
    v.addEventListener('ended', () => { if (b.video === rec) b.dueAt = 0; });
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
      b.dueAt = cfg.mode === 'scroll' ? Infinity : now() + 400;   // swap the block to something that works
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
    b.dueAt = cfg.mode === 'scroll' ? Infinity : now() + stillDelay();
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
   * mode only blocks in view qualify, fully visible ones first, and a block
   * already leaving the top gives its slot to a fully visible one.
   */
  function fillSlots() {
    if (!running) return;
    if (cfg.mode !== 'scroll') {
      if (liveCost >= cfg.playing) return;
      // A still that is still loading does not hold its block back: the clip
      // layer goes on top of it either way.
      const cands = blocks.filter(canPlay);
      cands.sort((a, c) => (a.lastPlayedAt - c.lastPlayedAt) || (a.rand - c.rand));
      for (const b of cands) {
        if (liveCost >= cfg.playing) break;
        startVideo(b);
      }
      return;
    }
    const top = drift.offset;
    const bottom = top + lay.H;
    const full = (b) => b.y >= top && b.y + b.h <= bottom;
    const cands = blocks.filter(b => canPlay(b) && b.y >= top && b.y < bottom);
    cands.sort((a, c) => (full(c) - full(a)) || (a.lastPlayedAt - c.lastPlayedAt) || (a.y - c.y));
    // Playing blocks that are leaving (or out of view), soonest gone first.
    const leaving = blocks.filter(b => b.video && !full(b) && (b.y < top || b.y >= bottom))
      .sort((a, c) => a.y - c.y);
    for (const b of cands) {
      if (startVideo(b)) continue;
      if (!full(b)) break;
      // Freeing slots cannot help a remux clip while another remux runs.
      if (playMode(b.item) === 'remux' && liveRemux >= MAX_REMUX) continue;
      while (leaving.length) {
        stopVideo(leaving.shift());
        if (startVideo(b)) break;
      }
      if (!b.video && !leaving.length) break;
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
      if (!b.video && b.dueAt - t > max) b.dueAt = t + Math.random() * max;
    }
  }

  function retimeClips() {
    for (const b of blocks) {
      if (!b.video) continue;
      b.video.v.loop = !toEnd();
      if (b.startedAt) b.dueAt = b.startedAt + clipMs();
    }
  }

  /* ── Sound on hover ─────────────────────────────────────────────────── */

  function unmute(b) {
    muteAll();
    if (b.video) b.video.v.muted = false;
  }

  function muteAll() {
    for (const b of blocks) if (b.video) b.video.v.muted = true;
  }

  function hoverStart(b) {
    b.hovered = true;
    b.el.classList.add('wall-hover');
    b.holdLeft = b.dueAt - now();
    if (cfg.soundOnHover) unmute(b);
    hoverBlock = b;
    syncDrift();
  }

  function hoverEnd(b) {
    b.hovered = false;
    b.el.classList.remove('wall-hover');
    if (cfg.mode !== 'scroll' && Number.isFinite(b.holdLeft)) b.dueAt = now() + Math.max(1500, b.holdLeft);
    if (b.video) b.video.v.muted = true;
    if (hoverBlock === b) hoverBlock = null;
    syncDrift();
  }

  /* ── The scheduler ──────────────────────────────────────────────────── */

  /** Grid mode: the block shows its next file, one whose shape fits the slot. */
  function advance(b) {
    const { i, fit } = swapIndex(ready, b.aspect, isOnScreen, b.item);
    if (i < 0) { fill(); b.dueAt = now() + 2000; return; }
    if (!fit && !b.fitWait && ready.length < READY_CAP) {
      // Nothing of this shape in the buffer: fetch more and try once more
      // shortly, before falling back to a crop.
      b.fitWait = true;
      fill(true);
      b.dueAt = now() + 1500;
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
    b.dueAt = now() + stillDelay();
  }

  function tick() {
    if (!running) return;
    const t = now();
    const grid = cfg.mode !== 'scroll';
    let swaps = 0;
    for (const b of blocks) {
      if (b.dead || b.hovered) continue;
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
  }

  function setRunning(on) {
    if (on === running) { syncDrift(); return; }
    running = on;
    if (on) {
      const d = pausedAt ? now() - pausedAt : 0;
      for (const b of blocks) {
        if (Number.isFinite(b.dueAt)) b.dueAt += d;
        if (b.loadDeadline) b.loadDeadline += d;
        if (b.startedAt) b.startedAt += d;
        if (b.video) b.video.v.play().catch(() => {});
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
  }

  /**
   * One place decides whether the wall runs. Off the tab or under the player
   * the videos are released outright (their connections are needed
   * elsewhere); a hidden window or the Pause button only pauses them.
   */
  function evaluate() {
    if (!els) return;
    const release = !active || playerOpen;
    if (release && liveCost > 0) releaseAllVideos();
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
      showMsg(err && err.message ? `Could not load the wall. ${err.message}` : 'Could not load the wall.');
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
    // The player lives outside the wall, so it cannot show over a full-screen wall.
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
    if (!Library.row(item.id)) { try { await Library.fetchRows([item.id]); } catch {} }
    if (typeof playMediaById === 'function') playMediaById(item.id);
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
    enter, leave, lockStop,
    // Pure pieces, for test/wall-layout.test.js.
    _pure: { cfgFrom, nearestStep, planColumns, slotFor, placeSlot, minBottom, PIC_STEPS, CLIP_STEPS, RANGES },
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
    })),
    _frames: (reset) => { const f = drift.frames.slice(); if (reset) drift.frames = []; return f; },
    _cfg: () => ({ ...cfg }),
    _queue: () => ready.map(r => ({ id: r.id, a: +aspectOf(r).toFixed(2), known: shapeKnown(r), on: onScreen.has(r.id), bad: badIds.has(r.id) })),
  };
})();

function wallEnter() { Wall.enter(); }
function wallLeave() { Wall.leave(); }
function wallLockStop() { Wall.lockStop(); }
