/* =========================================================================
   WALL - a screen-filling collage of the library (LIBRARY_LAYOUT_SPEC Part 2)

   Justified rows of blocks that keep each file's shape. A few videos play
   muted at once, the rest of the blocks show pictures that change every few
   seconds. Ambient, so smoothness wins over features:

   - Layout is plain flexbox. Each block's flex-grow is its aspect ratio, so a
     row always fills the width exactly and the browser does the math. Rows
     are flex:1 in a column, so the board always fills the height. Changing
     one block's shape re-flows that one row and nothing else.
   - Rows are picked so their natural width is close to the screen width
     (the pick looks a few items ahead for one whose shape fills the gap), so
     the stretch flexbox applies stays small; object-fit: cover hides it.
   - The playing cap is counted on live <video> elements, including one that
     is still fading out. A remux (HLS) stream counts as 2 and only one runs at
     a time: the server runs at most 2 FFmpeg sessions for the whole app and a
     third would kill the main player's.
   - Every replaced <video> is released (pause, src removed, load()) so its
     decoder and HTTP connection go with it. Leaving the tab, opening the
     player, or locking the library releases them all; a hidden browser tab or
     the Pause button only pauses them.
   - One 250 ms scheduler tick drives every block (no timer per block).

   Sources go through the existing query API (Library.queryOnce: POST
   /api/library/query + the binary id list) and rows through Library.fetchRows
   (POST /api/media/rows). Thumbnails go through thumbs.js, so the vault's
   blob mode works unchanged. Videos use /media/:id (the same URL the player's
   native path gets) and /stream/:id via /api/playback for remux.

   Globals used by tabs.js / vault-ui.js: wallEnter(), wallLeave(), wallLockStop().
   ========================================================================= */

const Wall = (() => {
  const RANGES = {
    playing:   { min: 1, max: 16, step: 1, def: 6 },
    picSpeed:  { min: 2, max: 60, step: 1, def: 8 },
    clipLen:   { min: 5, max: 120, step: 5, def: 20 },   // the max means "Full clip"
    blockSize: { min: 120, max: 640, step: 10, def: 260 },
    gap:       { min: 0, max: 12, step: 1, def: 4 },
  };
  const MIXES = ['both', 'videos', 'pictures'];
  const ORDERS = ['shuffle', 'order'];
  const MIX_TYPES = { both: ['video', 'image', 'gif'], videos: ['video'], pictures: ['image', 'gif'] };

  const MAX_REMUX = 1;               // see the header: the server's FFmpeg cap is 2, app-wide
  const REMUX_COST = 2;
  const FADE_MS = 600;
  const TICK_MS = 250;
  const LOOKAHEAD = 16;              // how far into the queue a pick may look for a shape
  const LOAD_TIMEOUT_MS = 12000;
  const REMUX_TIMEOUT_MS = 25000;
  const ASPECT_MIN = 0.25;
  const ASPECT_MAX = 4;
  const DEFAULT_ASPECT = 16 / 9;

  /* ── Settings ───────────────────────────────────────────────────────── */

  let cfg = null;

  function clampNum(v, r) {
    const n = Number(v);
    if (!Number.isFinite(n)) return r.def;
    return Math.min(r.max, Math.max(r.min, Math.round(n / r.step) * r.step));
  }

  function loadCfg() {
    const raw = (typeof window.vaultWallSettings === 'function' && window.vaultWallSettings()) || {};
    const out = {};
    for (const [k, r] of Object.entries(RANGES)) out[k] = clampNum(raw[k] ?? r.def, r);
    out.mix = MIXES.includes(raw.mix) ? raw.mix : 'both';
    out.order = ORDERS.includes(raw.order) ? raw.order : 'shuffle';
    out.source = typeof raw.source === 'string' && /^(library|c:\d+|s:\d+)$/.test(raw.source) ? raw.source : 'library';
    out.soundOnHover = raw.soundOnHover === true;
    out.directOnly = raw.directOnly === true;
    out.barOpen = raw.barOpen !== false;
    return out;
  }

  function saveCfg() {
    if (typeof window.vaultSetWallSettings === 'function') window.vaultSetWallSettings(cfg);
  }

  const fullClip = () => cfg.clipLen >= RANGES.clipLen.max;

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

  let rows = [];               // [{ el, blocks: [] }]
  let blocks = [];
  const lay = { W: 0, H: 0, R: 0, rh: 0 };

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

  function aspectOf(row) {
    const learned = aspectCache.get(row.id);
    if (learned) return learned;
    const w = Number(row.width) || 0;
    const h = Number(row.height) || 0;
    return w > 0 && h > 0 ? clamp(w / h, ASPECT_MIN, ASPECT_MAX) : DEFAULT_ASPECT;
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

  /** How many rows the buffer should hold: a screenful and some spare. */
  function readyTarget() {
    const W = (els && els.board.clientWidth) || window.innerWidth;
    const H = (els && els.board.clientHeight) || window.innerHeight;
    const est = Math.ceil((W * H) / (cfg.blockSize * cfg.blockSize * 1.4));
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
   */
  function fill() {
    if (fillPromise) return fillPromise;
    const gen = poolGen;
    fillPromise = (async () => {
      if (!poolIds || !poolIds.length) return;
      const target = readyTarget();
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
          if (r && eligible(r)) { ready.push(r); poolHasEligible = true; }
        }
      }
    })().finally(() => { if (gen === poolGen) fillPromise = null; });
    return fillPromise;
  }

  /**
   * Index in `ready` of the best next item: early in the queue, not already
   * on screen, and (when a shape is wanted) closest to that aspect ratio.
   */
  function bestIndex(target) {
    const n = Math.min(LOOKAHEAD, ready.length);
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      const r = ready[i];
      if (badIds.has(r.id)) continue;
      let score = i * 0.01;
      if (onScreen.has(r.id)) score += 10;
      if (target) score += Math.abs(Math.log(aspectOf(r) / target));
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  function take(i) {
    const r = ready.splice(i, 1)[0];
    if (ready.length < readyTarget() / 2) fill();
    return r;
  }

  function pick(target) {
    const i = bestIndex(target);
    if (i < 0) { fill(); return null; }
    return take(i);
  }

  /* ── DOM ────────────────────────────────────────────────────────────── */

  function slider(id, label, key) {
    const r = RANGES[key];
    return `<label class="wall-field wall-slider" title="${label}">
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
        <div class="wall-bar-main">
          <label class="wall-field">
            <span class="wall-label">Source</span>
            <select id="wallSource"></select>
          </label>
          <label class="wall-field">
            <span class="wall-label">Mix</span>
            <select id="wallMix">
              <option value="both">Videos and pictures</option>
              <option value="videos">Videos only</option>
              <option value="pictures">Pictures only</option>
            </select>
          </label>
          <label class="wall-field">
            <span class="wall-label">Order</span>
            <select id="wallOrder">
              <option value="shuffle">Shuffle</option>
              <option value="order">In order</option>
            </select>
          </label>
          ${slider('wallPlaying', 'Playing at once', 'playing')}
          ${slider('wallPicSpeed', 'Picture speed', 'picSpeed')}
          ${slider('wallClipLen', 'Clip length', 'clipLen')}
          ${slider('wallBlockSize', 'Block size', 'blockSize')}
          ${slider('wallGap', 'Gap', 'gap')}
          <label class="wall-check"><input type="checkbox" id="wallSound"> Sound on hover</label>
          <label class="wall-check" title="Skip videos that need converting on the fly. They are heavier to play.">
            <input type="checkbox" id="wallDirect"> Only files that play directly</label>
        </div>
        <div class="wall-bar-actions">
          <span class="wall-status" id="wallStatus"></span>
          <button type="button" class="wall-btn" id="wallPauseBtn">Pause</button>
          <button type="button" class="wall-btn" id="wallShuffleBtn">Shuffle now</button>
          <button type="button" class="wall-btn" id="wallFullBtn">Full screen</button>
          <button type="button" class="wall-btn wall-btn-quiet" id="wallBarBtn"></button>
        </div>
      </div>
      <div class="wall-stage">
        <div class="wall-board" id="wallBoard"></div>
        <div class="wall-msg" id="wallMsg" hidden></div>
        <div class="wall-paused" id="wallPaused" hidden>Paused</div>
      </div>`;
    const $ = (id) => root.querySelector('#' + id);
    els = {
      root,
      bar: $('wallBar'),
      board: $('wallBoard'),
      msg: $('wallMsg'),
      paused: $('wallPaused'),
      status: $('wallStatus'),
      source: $('wallSource'),
      mix: $('wallMix'),
      order: $('wallOrder'),
      playing: $('wallPlaying'),
      picSpeed: $('wallPicSpeed'),
      clipLen: $('wallClipLen'),
      blockSize: $('wallBlockSize'),
      gap: $('wallGap'),
      sound: $('wallSound'),
      direct: $('wallDirect'),
      pauseBtn: $('wallPauseBtn'),
      shuffleBtn: $('wallShuffleBtn'),
      fullBtn: $('wallFullBtn'),
      barBtn: $('wallBarBtn'),
    };
    wireControls();
    wireBoard();
    syncControls();
  }

  function fmt(key, v) {
    if (key === 'playing') return String(v);
    if (key === 'picSpeed') return `${v} s`;
    if (key === 'clipLen') return v >= RANGES.clipLen.max ? 'Full clip' : `${v} s`;
    return `${v} px`;
  }

  function syncControls() {
    for (const key of Object.keys(RANGES)) {
      els[key].value = String(cfg[key]);
      els.root.querySelector(`#${els[key].id}Out`).textContent = fmt(key, cfg[key]);
    }
    els.mix.value = cfg.mix;
    els.order.value = cfg.order;
    els.sound.checked = cfg.soundOnHover;
    els.direct.checked = cfg.directOnly;
    els.root.classList.toggle('wall-bar-closed', !cfg.barOpen);
    els.barBtn.textContent = cfg.barOpen ? 'Hide controls' : 'Show controls';
    els.root.style.setProperty('--wall-gap', `${cfg.gap}px`);
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

  function wireControls() {
    const relayoutSoon = debounce(() => relayout(true), 180);

    for (const key of Object.keys(RANGES)) {
      const input = els[key];
      const out = els.root.querySelector(`#${input.id}Out`);
      input.addEventListener('input', () => {
        const v = clampNum(input.value, RANGES[key]);
        out.textContent = fmt(key, v);
        if (v === cfg[key]) return;
        cfg[key] = v;
        if (key === 'playing') trimVideos();
        else if (key === 'picSpeed') retimeStills();
        else if (key === 'clipLen') retimeClips();
        else if (key === 'blockSize') relayoutSoon();
        else if (key === 'gap') {
          els.root.style.setProperty('--wall-gap', `${v}px`);
          rows.forEach(refitRow);
        }
        updateStatus();
      });
      input.addEventListener('change', saveCfg);
    }

    els.source.addEventListener('change', () => { cfg.source = els.source.value; saveCfg(); rebuild(); });
    els.mix.addEventListener('change', () => { cfg.mix = els.mix.value; saveCfg(); rebuild(); });
    els.order.addEventListener('change', () => { cfg.order = els.order.value; saveCfg(); rebuild(); });
    els.direct.addEventListener('change', () => { cfg.directOnly = els.direct.checked; saveCfg(); rebuild(); });
    els.sound.addEventListener('change', () => {
      cfg.soundOnHover = els.sound.checked;
      saveCfg();
      if (!cfg.soundOnHover) muteAll();
    });

    els.pauseBtn.addEventListener('click', () => { userPaused = !userPaused; evaluate(); });
    els.shuffleBtn.addEventListener('click', shuffleNow);
    els.fullBtn.addEventListener('click', toggleFullscreen);
    els.barBtn.addEventListener('click', () => {
      cfg.barOpen = !cfg.barOpen;
      saveCfg();
      syncControls();
    });

    document.addEventListener('fullscreenchange', () => {
      const fs = document.fullscreenElement === els.root;
      els.root.classList.toggle('wall-fs', fs);
      els.fullBtn.textContent = fs ? 'Leave full screen' : 'Full screen';
    });
    document.addEventListener('visibilitychange', evaluate);

    // The board's size is what the layout is made of. A size change that
    // keeps the same number of rows needs nothing: flexbox re-fits the rows.
    new ResizeObserver(debounce(() => { if (active && built) refitBoard(); }, 200)).observe(els.board);
    window.addEventListener('resize', () => { if (active) placeRoot(); });

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

  /**
   * The board changed size. Same number of rows and about the same width:
   * flexbox re-fits the rows by itself. Otherwise lay out again.
   */
  function refitBoard() {
    const W = els.board.clientWidth;
    const H = els.board.clientHeight;
    if (!W || !H) return;
    if (rowCountFor(H) !== lay.R) { relayout(true); return; }
    lay.W = W; lay.H = H; lay.rh = (H - cfg.gap * (lay.R - 1)) / lay.R;
    rows.forEach(refitRow);
    // Much wider or narrower with the same rows: the rows no longer hold
    // the right number of blocks, and every block would be squeezed.
    if (Math.abs(Math.log(boardFit())) > 0.12) relayout(true);
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
    const playing = blocks.filter(b => b.video).length;
    els.status.textContent = built && blocks.length
      ? `${playing} playing, ${blocks.length} on the wall` : '';
  }

  /* ── Layout ─────────────────────────────────────────────────────────── */

  function rowCountFor(H) {
    return Math.max(1, Math.round((H + cfg.gap) / (cfg.blockSize + cfg.gap)));
  }

  function makeBlock(item, row) {
    const el = document.createElement('div');
    el.className = 'wall-block';
    const cap = document.createElement('div');
    cap.className = 'wall-cap';
    el.appendChild(cap);
    const b = {
      el, cap, row,
      item: null,
      aspect: aspectOf(item),
      video: null,          // { v, layer, hls, token, cost, mode, id, released }
      pending: null,        // a still layer waiting for its picture
      dueAt: 0,
      loadDeadline: 0,
      startedAt: 0,
      lastPlayedAt: 0,
      hovered: false,
      holdLeft: 0,
      rand: Math.random(),
      dead: false,
      first: item,
    };
    el._wall = b;
    el.style.flexGrow = String(b.aspect);
    return b;
  }

  /** Tear the board down. Every video is released, not just removed. */
  function teardownBlocks() {
    for (const b of blocks) {
      b.dead = true;
      for (const v of b.el.querySelectorAll('video')) releaseVideo(v._wallRec);
      b.video = null;
    }
    blocks = [];
    rows = [];
    onScreen.clear();
    if (els) els.board.textContent = '';
  }

  /**
   * Build the board from the buffer. Each row takes items until its natural
   * width (aspect × row height) reaches the board width; near the end it
   * looks ahead for the shape that fills the rest best, and stops instead
   * when adding anything would overshoot more than stretching would.
   */
  function layout() {
    teardownBlocks();
    const W = els.board.clientWidth;
    const H = els.board.clientHeight;
    if (!W || !H) return;
    const g = cfg.gap;
    const R = rowCountFor(H);
    const rh = (H - g * (R - 1)) / R;
    Object.assign(lay, { W, H, R, rh });

    const frag = document.createDocumentFragment();
    for (let r = 0; r < R; r++) {
      const rowEl = document.createElement('div');
      rowEl.className = 'wall-row';
      const row = { el: rowEl, blocks: [] };
      let used = 0;
      while (row.blocks.length < 60) {
        const n = row.blocks.length;
        const rem = W - used - (n ? g : 0);
        if (n && rem <= 0) break;
        const target = rem > rh * 2.5 ? null : rem / rh;
        const i = bestIndex(target);
        if (i < 0) break;
        const w = aspectOf(ready[i]) * rh;
        // Stretching the row by `rem` beats squeezing it by more than that.
        if (n && w - rem > rem) break;
        const item = take(i);
        const b = makeBlock(item, row);
        row.blocks.push(b);
        blocks.push(b);
        rowEl.appendChild(b.el);
        used += (n ? g : 0) + b.aspect * rh;
        onScreen.set(item.id, (onScreen.get(item.id) || 0) + 1);
      }
      if (!row.blocks.length) break;
      refitRow(row);
      rows.push(row);
      frag.appendChild(rowEl);
    }
    els.board.appendChild(frag);

    const t = now();
    for (const b of blocks) {
      const item = b.first;
      b.first = null;
      onScreen.set(item.id, onScreen.get(item.id) - 1);
      if (!onScreen.get(item.id)) onScreen.delete(item.id);
      showStill(b, item);
      // Staggered so the pictures never all change together.
      b.dueAt = t + (0.2 + Math.random() * 0.9) * cfg.picSpeed * 1000;
    }
    pinOnScreen();
    updateStatus();
  }

  /** Lay out again, keeping what is on screen now at the front of the queue. */
  function relayout(keep) {
    if (!built || !els) return;
    if (keep) {
      const seen = new Set();
      const back = [];
      for (const b of blocks) {
        if (b.item && !seen.has(b.item.id)) { seen.add(b.item.id); back.push(b.item); }
      }
      ready = back.concat(ready.filter(r => !seen.has(r.id)));
    }
    layout();
    if (running) fillSlots();
  }

  /**
   * The shape a replacement should have so the row goes back to its natural
   * width: whatever aspect the other blocks leave over.
   */
  function rebalanceTarget(b) {
    const row = b.row;
    const n = row.blocks.length;
    const avail = (lay.W - cfg.gap * (n - 1)) / lay.rh;
    let others = 0;
    for (const o of row.blocks) if (o !== b) others += o.aspect;
    return clamp(avail - others, 0.4, 3.5);
  }

  function setAspect(b, a) {
    if (Math.abs(Math.log(a / b.aspect)) < 0.02) return;
    b.aspect = a;
    b.el.style.flexGrow = String(a);
    refitRow(b.row);
  }

  /**
   * A row's flex-grow in the board column is its natural height: the height
   * at which its blocks, at their true shapes, exactly fill the width. So a
   * row that came out a little short or long takes a little more or less
   * height instead of stretching its blocks, and the only distortion left is
   * one small factor shared by the whole board.
   */
  /** Board height over the rows' natural heights: 1 means no block is stretched. */
  function boardFit() {
    let sum = 0;
    for (const row of rows) {
      let a = 0;
      for (const o of row.blocks) a += o.aspect;
      sum += (lay.W - cfg.gap * (row.blocks.length - 1)) / a;
    }
    return sum ? (lay.H - cfg.gap * (rows.length - 1)) / sum : 1;
  }

  function refitRow(row) {
    if (!row || !row.blocks.length || !lay.W) return;
    let sum = 0;
    for (const o of row.blocks) sum += o.aspect;
    const h = (lay.W - cfg.gap * (row.blocks.length - 1)) / sum;
    row.el.style.flexGrow = h.toFixed(2);
  }

  /** The element told us the real shape: remember it and re-fit the row. */
  function learnAspect(b, item, w, h) {
    if (!w || !h) return;
    const a = clamp(w / h, ASPECT_MIN, ASPECT_MAX);
    if (Math.abs(Math.log(a / aspectOf(item))) > 0.02) aspectCache.set(item.id, a);
    if (b.item === item && !b.dead) setAspect(b, a);
  }

  let _pinTimer = null;
  function pinOnScreen() {
    clearTimeout(_pinTimer);
    _pinTimer = setTimeout(() => {
      // Pinned so the player can open any block (getMediaById reads the cache).
      Library.pin('wall', blocks.map(b => b.item && b.item.id).filter(Boolean));
    }, 300);
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
    onScreen.set(item.id, (onScreen.get(item.id) || 0) + 1);
    b.cap.textContent = titleOf(item);
    b.el.title = '';
    setAspect(b, aspectOf(item));

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
      if (ok) learnAspect(b, item, img.naturalWidth, img.naturalHeight);
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

  function clipMs() {
    return fullClip() ? Infinity : cfg.clipLen * 1000;
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
    v.loop = !fullClip();
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
    const clip = fullClip() ? 0 : cfg.clipLen;
    const start = clip && dur > clip + 1 ? Math.random() * (dur - clip) : 0;

    v.addEventListener('playing', () => {
      if (b.video !== rec || b.dead) return;
      b.loadDeadline = 0;
      b.startedAt = now();
      b.dueAt = b.startedAt + clipMs();
      learnAspect(b, item, v.videoWidth, v.videoHeight);
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
    rec.token = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '')
      : `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
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
      b.dueAt = now() + 400;      // swap the block to something that works
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
    b.dueAt = now() + stillDelay();
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

  /** Free slots go to the video blocks that have waited longest. */
  function fillSlots() {
    if (!running || liveCost >= cfg.playing) return;
    // A still that is still loading does not hold its block back: the clip
    // layer goes on top of it either way.
    const cands = blocks.filter(b => !b.video && !b.dead && b.item
      && kindOf(b.item) === 'video' && !badIds.has(b.item.id));
    cands.sort((a, c) => (a.lastPlayedAt - c.lastPlayedAt) || (a.rand - c.rand));
    for (const b of cands) {
      if (liveCost >= cfg.playing) break;
      startVideo(b);
    }
  }

  /** "Playing at once" went down: stop the clips closest to their end. */
  function trimVideos() {
    if (liveCost <= cfg.playing) return;
    const playing = blocks.filter(b => b.video).sort((a, c) => a.dueAt - c.dueAt);
    for (const b of playing) {
      if (liveCost <= cfg.playing) break;
      stopVideo(b);
    }
    updateStatus();
  }

  function retimeStills() {
    const t = now();
    const max = cfg.picSpeed * 1000;
    for (const b of blocks) {
      if (!b.video && b.dueAt - t > max) b.dueAt = t + Math.random() * max;
    }
  }

  function retimeClips() {
    for (const b of blocks) {
      if (!b.video) continue;
      b.video.v.loop = !fullClip();
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
  }

  function hoverEnd(b) {
    b.hovered = false;
    b.el.classList.remove('wall-hover');
    if (Number.isFinite(b.holdLeft)) b.dueAt = now() + Math.max(1500, b.holdLeft);
    if (b.video) b.video.v.muted = true;
  }

  /* ── The scheduler ──────────────────────────────────────────────────── */

  function advance(b) {
    const next = pick(rebalanceTarget(b));
    if (!next) { b.dueAt = now() + 2000; return; }
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
    let swaps = 0;
    for (const b of blocks) {
      if (b.dead || b.hovered) continue;
      if (b.video && b.loadDeadline && t > b.loadDeadline) { videoFailed(b, b.video); continue; }
      // At most a few swaps per tick, so a burst of due blocks spreads out.
      if (t >= b.dueAt && !b.pending && swaps < 3) {
        advance(b);
        swaps++;
      }
    }
    fillSlots();
  }

  function setRunning(on) {
    if (on === running) return;
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
        : 'Nothing to show from this source. Pick another source or change the mix.');
      return;
    }
    showMsg('');
    if (!active) return;            // left while loading: lay out on the way back in
    layout();
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
    fill().then(() => {
      if (!active) return;
      layout();
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
    syncControls();
    if (!built || computePoolKey() !== poolKey) rebuild();
    else {
      // Back on the tab with the same source: re-fit if the window changed.
      refitBoard();
      evaluate();
    }
  }

  function leave() {
    active = false;
    document.body.classList.remove('wall-active');
    if (document.fullscreenElement === (els && els.root)) document.exitFullscreen().catch(() => {});
    evaluate();
  }

  /** The library locked: drop everything. Unlocking reloads the page. */
  function lockStop() {
    if (!els) return;
    active = false;
    built = false;
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
    // For tests and debugging in the console.
    _stats: () => ({
      blocks: blocks.length,
      rows: rows.length,
      liveCost,
      liveRemux,
      videos: els ? els.board.querySelectorAll('video').length : 0,
      playing: els ? [...els.board.querySelectorAll('video')].filter(v => !v.paused).length : 0,
      ready: ready.length,
      pool: poolIds ? poolIds.length : 0,
      running,
      lay: { ...lay },
    }),
  };
})();

function wallEnter() { Wall.enter(); }
function wallLeave() { Wall.leave(); }
function wallLockStop() { Wall.lockStop(); }
