/* =========================================================================
   FRAME FIT — live-media jigsaw, ported into the Games host.

   Original game by aericode (SAMPLES/FrameFit). Ported changes
   (FRAMEFIT_SPEC.md):
     • single library source via /media/:id — the queue, file picker,
       landing panels and media modal are gone (the host picks media);
     • toolkit.css dropped — the ~6 kept controls are rebuilt under a
       scoped .ff-root with app tokens;
     • run clock is the shared ElapsedTimer (pauses off-view);
     • full save/restore: piece positions + groups + the EdgeTable's exact
       tab directions (serialize/load) + view + clock + playback position;
     • PuzzleEngine upgraded to Pointer Events with removable listeners
       (window key handlers unhooked on destroy — tab lifecycle);
     • renderer untouched architecturally: single rAF, prescaled
       OffscreenCanvas, per-edge borders, cached Path2Ds.

   Everything lives under a module-private `FF`; the only global is the
   window.gamesRegister('framefit', …) call at the end.
   ========================================================================= */
(function () {
  const FF = {};

  const PIECE_STEPS = [6, 12, 20, 30, 42, 56, 80, 110, 140, 180, 220, 260, 300, 350, 400, 500, 650, 800];
  const WS_PAD = 1.5;   // workspace = puzzle * (1 + 2*WS_PAD) per axis

  // Background-colour presets for the workspace (ported from the original
  // FrameFit source's swatch grid). The custom picker covers anything else.
  const BG_PRESETS = [
    { c: '#151515', name: 'App Dark' },
    { c: '#0d0e10', name: 'Black' },
    { c: '#1e1f22', name: 'Charcoal' },
    { c: '#1a1a2e', name: 'Navy' },
    { c: '#1b2d2a', name: 'Forest' },
    { c: '#2d2b3a', name: 'Plum' },
    { c: '#3d2b1b', name: 'Cocoa' },
    { c: '#f5e6d0', name: 'Cream' },
  ];

  /* ═══ Shapes — EdgeTable + Path2D builders + PathCache (verbatim core) ═══ */

  const TAB_DEPTH = 0.28;
  const NECK = 0.18;
  const HEAD = 0.25;

  class EdgeTable {
    constructor() {
      this._v = new Map(); // vertical edges   (right side of col c)
      this._h = new Map(); // horizontal edges (bottom side of row r)
      this._cols = 0;
      this._rows = 0;
    }
    generate(cols, rows) {
      this._cols = cols; this._rows = rows;   // recorded for serialize()
      this._v.clear();
      this._h.clear();
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols - 1; c++)
          this._v.set(`${c}:${r}`, Math.random() < 0.5 ? 1 : -1);
      for (let r = 0; r < rows - 1; r++)
        for (let c = 0; c < cols; c++)
          this._h.set(`${c}:${r}`, Math.random() < 0.5 ? 1 : -1);
    }
    /** Arrays of ±1 in generate() iteration order — restore must reproduce
        the exact tab directions or pieces won't interlock. */
    serialize() {
      const v = [], h = [];
      for (let r = 0; r < this._rows; r++)
        for (let c = 0; c < this._cols - 1; c++) v.push(this._v.get(`${c}:${r}`));
      for (let r = 0; r < this._rows - 1; r++)
        for (let c = 0; c < this._cols; c++) h.push(this._h.get(`${c}:${r}`));
      return { v, h };
    }
    load(cols, rows, { v, h }) {
      this._cols = cols; this._rows = rows;
      this._v.clear(); this._h.clear();
      let i = 0;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols - 1; c++) this._v.set(`${c}:${r}`, v[i++]);
      let j = 0;
      for (let r = 0; r < rows - 1; r++)
        for (let c = 0; c < cols; c++) this._h.set(`${c}:${r}`, h[j++]);
    }
    right(c, r) { return this._v.get(`${c}:${r}`) ?? 0; }
    bottom(c, r) { return this._h.get(`${c}:${r}`) ?? 0; }
    left(c, r) { return this._v.get(`${c - 1}:${r}`) ?? 0; }
    top(c, r) { return this._h.get(`${c}:${r - 1}`) ?? 0; }
  }

  const edgeTable = new EdgeTable(); // module-local singleton

  function buildPiecePath(pw, ph, col, row, cols, rows) {
    const p = new Path2D();
    const mx = pw / 2, my = ph / 2;
    const et = edgeTable;
    p.moveTo(0, 0);
    if (row > 0) {
      const d = et.top(col, row) * ph * TAB_DEPTH;
      p.lineTo(mx - pw * NECK, 0);
      p.bezierCurveTo(mx - pw * NECK, d * 0.5, mx - pw * HEAD, d, mx, d);
      p.bezierCurveTo(mx + pw * HEAD, d, mx + pw * NECK, d * 0.5, mx + pw * NECK, 0);
    }
    p.lineTo(pw, 0);
    if (col < cols - 1) {
      const d = et.right(col, row) * pw * TAB_DEPTH;
      p.lineTo(pw, my - ph * NECK);
      p.bezierCurveTo(pw + d * 0.5, my - ph * NECK, pw + d, my - ph * HEAD, pw + d, my);
      p.bezierCurveTo(pw + d, my + ph * HEAD, pw + d * 0.5, my + ph * NECK, pw, my + ph * NECK);
    }
    p.lineTo(pw, ph);
    if (row < rows - 1) {
      const d = et.bottom(col, row) * ph * TAB_DEPTH;
      p.lineTo(mx + pw * NECK, ph);
      p.bezierCurveTo(mx + pw * NECK, ph + d * 0.5, mx + pw * HEAD, ph + d, mx, ph + d);
      p.bezierCurveTo(mx - pw * HEAD, ph + d, mx - pw * NECK, ph + d * 0.5, mx - pw * NECK, ph);
    }
    p.lineTo(0, ph);
    if (col > 0) {
      const d = et.left(col, row) * pw * TAB_DEPTH;
      p.lineTo(0, my + ph * NECK);
      p.bezierCurveTo(d * 0.5, my + ph * NECK, d, my + ph * HEAD, d, my);
      p.bezierCurveTo(d, my - ph * HEAD, d * 0.5, my - ph * NECK, 0, my - ph * NECK);
    }
    p.closePath();
    return p;
  }

  function buildEdgePath(pw, ph, col, row, cols, rows, edge) {
    const p = new Path2D();
    const mx = pw / 2, my = ph / 2;
    const et = edgeTable;
    if (edge === 'top') {
      p.moveTo(0, 0);
      if (row > 0) {
        const d = et.top(col, row) * ph * TAB_DEPTH;
        p.lineTo(mx - pw * NECK, 0);
        p.bezierCurveTo(mx - pw * NECK, d * 0.5, mx - pw * HEAD, d, mx, d);
        p.bezierCurveTo(mx + pw * HEAD, d, mx + pw * NECK, d * 0.5, mx + pw * NECK, 0);
      }
      p.lineTo(pw, 0);
    } else if (edge === 'right') {
      p.moveTo(pw, 0);
      if (col < cols - 1) {
        const d = et.right(col, row) * pw * TAB_DEPTH;
        p.lineTo(pw, my - ph * NECK);
        p.bezierCurveTo(pw + d * 0.5, my - ph * NECK, pw + d, my - ph * HEAD, pw + d, my);
        p.bezierCurveTo(pw + d, my + ph * HEAD, pw + d * 0.5, my + ph * NECK, pw, my + ph * NECK);
      }
      p.lineTo(pw, ph);
    } else if (edge === 'bottom') {
      p.moveTo(pw, ph);
      if (row < rows - 1) {
        const d = et.bottom(col, row) * ph * TAB_DEPTH;
        p.lineTo(mx + pw * NECK, ph);
        p.bezierCurveTo(mx + pw * NECK, ph + d * 0.5, mx + pw * HEAD, ph + d, mx, ph + d);
        p.bezierCurveTo(mx - pw * HEAD, ph + d, mx - pw * NECK, ph + d * 0.5, mx - pw * NECK, ph);
      }
      p.lineTo(0, ph);
    } else { // left
      p.moveTo(0, ph);
      if (col > 0) {
        const d = et.left(col, row) * pw * TAB_DEPTH;
        p.lineTo(0, my + ph * NECK);
        p.bezierCurveTo(d * 0.5, my + ph * NECK, d, my + ph * HEAD, d, my);
        p.bezierCurveTo(d, my - ph * HEAD, d * 0.5, my - ph * NECK, 0, my - ph * NECK);
      }
      p.lineTo(0, 0);
    }
    return p;
  }

  class PathCache {
    constructor() { this._cache = new Map(); this._edges = new Map(); this._pw = 0; this._ph = 0; }
    reset(pw, ph) { this._cache.clear(); this._edges.clear(); this._pw = pw; this._ph = ph; }
    get(col, row, cols, rows) {
      const id = row * 10000 + col;
      if (!this._cache.has(id)) this._cache.set(id, buildPiecePath(this._pw, this._ph, col, row, cols, rows));
      return this._cache.get(id);
    }
    getEdge(col, row, cols, rows, edge) {
      const key = `${col},${row},${edge}`;
      if (!this._edges.has(key)) this._edges.set(key, buildEdgePath(this._pw, this._ph, col, row, cols, rows, edge));
      return this._edges.get(key);
    }
  }

  /* ═══ MediaSource — single video/image draw source (queue removed) ═══════ */

  FF.MediaSource = class MediaSource {
    constructor(root) {
      this._type = null;   // 'video' | 'image'
      this._vid = document.createElement('video');
      this._vid.playsInline = true;
      this._vid.loop = false;         // manual loop below (native loop can silently fail)
      this._vid.volume = 0.7;
      this._vid.style.display = 'none';
      this._img = document.createElement('img');
      this._img.style.display = 'none';
      root.appendChild(this._vid);
      root.appendChild(this._img);

      // Manual loop: seek back near the end — fires before a stalled 'ended'
      this._onTimeUpdate = () => {
        const d = this._vid.duration;
        if (!isFinite(d) || d <= 0) return;
        if (this._vid.currentTime >= d - 0.08) {
          this._vid.currentTime = 0;
          if (this._vid.paused) this._vid.play().catch(() => {});
        }
      };
      this._vid.addEventListener('timeupdate', this._onTimeUpdate);
      this._vid.addEventListener('ended', () => {
        this._vid.currentTime = 0;
        this._vid.play().catch(() => {});
      });
    }

    /** Load the media; resolves { w, h } once drawable. */
    load(url, kind) {
      this._type = kind === 'video' ? 'video' : 'image';
      return new Promise((resolve, reject) => {
        if (this._type === 'video') {
          const onLoaded = () => {
            this._vid.removeEventListener('loadeddata', onLoaded);
            resolve({ w: this._vid.videoWidth, h: this._vid.videoHeight });
          };
          const onErr = () => reject(new Error('video failed to load'));
          this._vid.addEventListener('loadeddata', onLoaded);
          this._vid.addEventListener('error', onErr, { once: true });
          this._vid.src = url;
          this._vid.load();
          this._vid.play().catch(() => {});
        } else {
          this._img.onload = () => resolve({ w: this._img.naturalWidth, h: this._img.naturalHeight });
          this._img.onerror = () => reject(new Error('image failed to load'));
          this._img.src = url;
        }
      });
    }

    getSource() { return this._type === 'video' ? this._vid : (this._type ? this._img : null); }
    get isVideo() { return this._type === 'video'; }
    get videoEl() { return this._type === 'video' ? this._vid : null; }

    isVideoPlaying() { return this._type === 'video' && !this._vid.paused && !this._vid.ended; }
    playVideo() { if (this._type === 'video') this._vid.play().catch(() => {}); }
    pauseVideo() { if (this._type === 'video') this._vid.pause(); }
    togglePlay() { if (this._type !== 'video') return; this._vid.paused ? this.playVideo() : this.pauseVideo(); }
    seekTo(pct) { if (this._vid.duration) this._vid.currentTime = pct * this._vid.duration; }
    seekAbs(t) { if (this._vid.duration) this._vid.currentTime = Math.max(0, Math.min(this._vid.duration, t)); }
    seek(delta) { this.seekAbs((this._vid.currentTime || 0) + delta); }
    setSpeed(rate) { this._vid.playbackRate = Math.max(0.25, Math.min(4, rate)); }
    setVolume(v) { this._vid.volume = Math.max(0, Math.min(1, v)); }
    get currentTime() { return this._type === 'video' ? this._vid.currentTime : 0; }
    get duration() { return this._type === 'video' ? (this._vid.duration || 0) : 0; }

    destroy() {
      try {
        this._vid.pause();
        this._vid.removeEventListener('timeupdate', this._onTimeUpdate);
        this._vid.removeAttribute('src'); this._vid.load(); this._vid.remove();
      } catch {}
      try { this._img.src = ''; this._img.remove(); } catch {}
      this._type = null;
    }
  };

  /* ═══ PuzzleEngine — state machine (Pointer Events, removable) ═══════════ */

  FF.PuzzleEngine = class PuzzleEngine {
    constructor(canvasEl, wsEl) {
      this._canvas = canvasEl;
      this._ws = wsEl;
      this._vx = 0; this._vy = 0; this._vs = 1;
      this._drag = null;
      this._pan = null;
      this._spaceDown = false;
      this._onSnap = null; this._onWin = null; this._onProgress = null;
      this._pc = null;
      this._bindEvents();
    }

    _absorbCfg(cfg) {
      const { cols, rows, pw, ph, puzX, puzY, puzW, puzH, wsW, wsH } = cfg;
      this._cols = cols; this._rows = rows;
      this._pw = pw; this._ph = ph;
      this._puzX = puzX; this._puzY = puzY;
      this._puzW = puzW; this._puzH = puzH;
      this._wsW = wsW; this._wsH = wsH;
    }

    init(cfg) {
      this._absorbCfg(cfg);
      this._pieces = [];
      this._pieceById = new Map();
      this._groups = new Map();
      this._gidSeq = 1;
      this._t0 = Date.now();
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) {
          const id = r * this._cols + c;
          const gid = this._gidSeq++;
          this._groups.set(gid, new Set([id]));
          const { x, y } = this._randomScatterPos(this._pw, this._ph, this._wsW, this._wsH, this._puzX, this._puzY, this._puzW, this._puzH);
          const pc = { id, col: c, row: r, x, y, gid };
          this._pieces.push(pc);
          this._pieceById.set(id, pc);
        }
      }
      this._drag = null;
      this._pan = null;
    }

    /** Seed saved positions + groups (restore path — no scatter, no RNG). */
    restore(cfg, px, py, pg) {
      this._absorbCfg(cfg);
      this._t0 = Date.now();               // engine-internal elapsed is unused
      this._pieces = [];
      this._pieceById = new Map();
      this._groups = new Map();
      for (let id = 0; id < px.length; id++) {
        const col = id % this._cols, row = (id / this._cols) | 0;
        const pc = { id, col, row, x: px[id], y: py[id], gid: pg[id] + 1 };
        this._pieces.push(pc);
        this._pieceById.set(id, pc);
        let set = this._groups.get(pc.gid);
        if (!set) this._groups.set(pc.gid, set = new Set());
        set.add(id);
      }
      this._gidSeq = Math.max(0, ...pg) + 2;
      this._drag = null;
      this._pan = null;
    }

    reset() {
      this._pieces = [];
      this._pieceById = new Map();
      this._groups = new Map();
      this._drag = null;
      this._pan = null;
    }

    onSnap(cb) { this._onSnap = cb; }
    onWin(cb) { this._onWin = cb; }
    onProgress(cb) { this._onProgress = cb; }

    getState() {
      return {
        pieces: this._pieces ?? [],
        groups: this._groups ?? new Map(),
        pieceById: this._pieceById ?? new Map(),
        dragGid: this._drag?.gid ?? null,
      };
    }

    /* ── Viewport ── */

    fitView() {
      const sw = this._ws.clientWidth;
      const sh = this._ws.clientHeight;
      if (!this._wsW || !this._wsH) return;
      this._vs = Math.min(sw / this._wsW, sh / this._wsH) * 0.88;
      this._vx = (sw - this._wsW * this._vs) / 2;
      this._vy = (sh - this._wsH * this._vs) / 2;
      this._applyVP();
    }

    getView() { return { vx: this._vx, vy: this._vy, vs: this._vs }; }
    setView({ vx, vy, vs }) {
      if ([vx, vy, vs].every(Number.isFinite) && vs > 0) {
        this._vx = vx; this._vy = vy; this._vs = vs;
        this._applyVP();
      } else {
        this.fitView();
      }
    }

    _applyVP() {
      this._canvas.style.transform = `translate(${this._vx}px,${this._vy}px) scale(${this._vs})`;
    }

    _screenToWS(sx, sy) {
      return { x: (sx - this._vx) / this._vs, y: (sy - this._vy) / this._vs };
    }

    /* ── Events (stored bound refs so destroy can unhook everything) ── */

    _bindEvents() {
      const ws = this._ws;
      this._hDown = (e) => this._onDown(e);
      this._hMove = (e) => this._onMove(e);
      this._hUp = (e) => this._onUp(e);
      this._hWheel = (e) => this._onWheel(e);
      this._hKeyDown = (e) => { if (e.code === 'Space' && !e.repeat) { e.preventDefault(); this._spaceDown = true; } };
      this._hKeyUp = (e) => { if (e.code === 'Space') this._spaceDown = false; };
      ws.addEventListener('pointerdown', this._hDown);
      ws.addEventListener('pointermove', this._hMove);
      ws.addEventListener('pointerup', this._hUp);
      ws.addEventListener('pointercancel', this._hUp);
      ws.addEventListener('wheel', this._hWheel, { passive: false });
      window.addEventListener('keydown', this._hKeyDown);
      window.addEventListener('keyup', this._hKeyUp);
    }

    destroy() {
      const ws = this._ws;
      ws.removeEventListener('pointerdown', this._hDown);
      ws.removeEventListener('pointermove', this._hMove);
      ws.removeEventListener('pointerup', this._hUp);
      ws.removeEventListener('pointercancel', this._hUp);
      ws.removeEventListener('wheel', this._hWheel);
      window.removeEventListener('keydown', this._hKeyDown);
      window.removeEventListener('keyup', this._hKeyUp);
      this.reset();
    }

    _wsRect() { return this._ws.getBoundingClientRect(); }

    _onDown(e) {
      if (e.button === 2) return;
      const rect = this._wsRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      try { this._ws.setPointerCapture(e.pointerId); } catch {}

      if (this._spaceDown || e.button === 1) { this._startPan(sx, sy); return; }
      if (!this._pieces?.length) { this._startPan(sx, sy); return; }

      const wp = this._screenToWS(sx, sy);
      const hit = this._hitTest(wp.x, wp.y);
      if (!hit) { this._startPan(sx, sy); return; }

      const gid = hit.gid;
      const members = this._groups.get(gid);
      const orig = new Map();
      members.forEach(pid => {
        const p = this._pieceById.get(pid);
        orig.set(pid, { x: p.x, y: p.y });
      });
      this._drag = { gid, startWX: wp.x, startWY: wp.y, origPositions: orig };

      // Dragged group renders (and hit-tests) above everything else
      const dragged = this._pieces.filter(p => members.has(p.id));
      const rest = this._pieces.filter(p => !members.has(p.id));
      this._pieces = [...rest, ...dragged];
      this._ws.style.cursor = 'grabbing';
    }

    _onMove(e) {
      const rect = this._wsRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      if (this._pan) {
        this._vx = this._pan.vx0 + sx - this._pan.sx;
        this._vy = this._pan.vy0 + sy - this._pan.sy;
        this._applyVP();
        return;
      }
      if (!this._drag) return;
      const wp = this._screenToWS(sx, sy);
      const dx = wp.x - this._drag.startWX;
      const dy = wp.y - this._drag.startWY;
      const members = this._groups.get(this._drag.gid);
      members.forEach(pid => {
        const o = this._drag.origPositions.get(pid);
        const pc = this._pieceById.get(pid);
        pc.x = o.x + dx;
        pc.y = o.y + dy;
      });
    }

    _onUp() {
      this._ws.style.cursor = '';
      this._ws.classList.remove('pan');
      if (this._pan) { this._pan = null; return; }
      if (this._drag) {
        this._trySnap(this._drag.gid);
        this._drag = null;
      }
    }

    _onWheel(e) {
      e.preventDefault();
      const rect = this._wsRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const f = e.deltaY > 0 ? 0.88 : 1.14;
      const ns = Math.max(0.04, Math.min(8, this._vs * f));
      this._vx = sx - (sx - this._vx) * (ns / this._vs);
      this._vy = sy - (sy - this._vy) * (ns / this._vs);
      this._vs = ns;
      this._applyVP();
    }

    _startPan(sx, sy) {
      this._pan = { sx, sy, vx0: this._vx, vy0: this._vy };
      this._ws.classList.add('pan');
    }

    /* ── Hit testing (precise Path2D, then padded bbox fallback) ── */

    _hitTest(wx, wy) {
      if (!this._hitCtx) {
        const oc = new OffscreenCanvas(1, 1);
        this._hitCtx = oc.getContext('2d');
      }
      // Bbox pre-filter must clear the tab bumps (TAB_DEPTH 0.28); this only
      // gates the precise isPointInPath test, so it adds no grabbable area.
      const ox = this._pw * 0.30;
      const oy = this._ph * 0.30;
      const precise = [];
      for (let i = this._pieces.length - 1; i >= 0; i--) {
        const pc = this._pieces[i];
        if (wx < pc.x - ox || wx > pc.x + this._pw + ox) continue;
        if (wy < pc.y - oy || wy > pc.y + this._ph + oy) continue;
        const path = this._pc.get(pc.col, pc.row, this._cols, this._rows);
        if (this._hitCtx.isPointInPath(path, wx - pc.x, wy - pc.y)) precise.push(pc);
      }
      if (precise.length) return this._pickSmallestGroup(precise);

      // Fallback: a small bbox pad so near-misses still grab. Tightened a bit
      // from the old ~0.44·pw reach (→ ~0.28·pw) so pieces feel more responsive
      // and less sticky, while keeping some grab tolerance.
      const PAD = Math.max(this._pw, this._ph) * 0.08;
      const fx = this._pw * 0.20 + PAD;
      const fy = this._ph * 0.20 + PAD;
      const near = [];
      for (let i = this._pieces.length - 1; i >= 0; i--) {
        const pc = this._pieces[i];
        if (wx < pc.x - fx || wx > pc.x + this._pw + fx) continue;
        if (wy < pc.y - fy || wy > pc.y + this._ph + fy) continue;
        near.push(pc);
      }
      return near.length ? this._pickSmallestGroup(near) : null;
    }

    /**
     * When several pieces sit under the cursor, grab the one in the SMALLEST
     * group — a lone piece pulls off a big clump instead of dragging it. Input
     * is in top-first render order, so equal-size ties keep the topmost piece.
     */
    _pickSmallestGroup(hits) {
      let best = null, bestSize = Infinity;
      for (const pc of hits) {
        const size = this._groups.get(pc.gid)?.size ?? 1;
        if (size < bestSize) { bestSize = size; best = pc; }
      }
      return best;
    }

    setPathCache(pc) { this._pc = pc; }

    /* ── Snap engine ── */

    get SNAP_DIST() { return Math.max(14, Math.min(28, (this._pw + this._ph) * 0.08)); }

    _trySnap(gid) {
      let members = this._groups.get(gid);
      if (!members) return;
      let snapped = false;
      let found = true;
      while (found) {
        found = false;
        members = this._groups.get(gid);
        if (!members) break;
        for (const pid of members) {
          const pc = this._pieceById.get(pid);
          for (const nb of this._neighbors(pc.col, pc.row)) {
            const nbPc = this._pieceById.get(nb.r * this._cols + nb.c);
            if (!nbPc || members.has(nbPc.id)) continue;
            const expX = pc.x + nb.dc * this._pw;
            const expY = pc.y + nb.dr * this._ph;
            if (Math.hypot(nbPc.x - expX, nbPc.y - expY) < this.SNAP_DIST) {
              this._mergeGroups(gid, nbPc.gid, pc, nb.dc, nb.dr);
              snapped = true;
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }
      if (snapped) {
        this._onSnap?.();
        this._onProgress?.(this._progressInfo());
        this._checkWin();
      }
    }

    _neighbors(col, row) {
      const out = [];
      if (col > 0) out.push({ c: col - 1, r: row, dc: -1, dr: 0 });
      if (col < this._cols - 1) out.push({ c: col + 1, r: row, dc: 1, dr: 0 });
      if (row > 0) out.push({ c: col, r: row - 1, dc: 0, dr: -1 });
      if (row < this._rows - 1) out.push({ c: col, r: row + 1, dc: 0, dr: 1 });
      return out;
    }

    _mergeGroups(gidA, gidB, anchorA, dc, dr) {
      const nbPc = this._pieceById.get((anchorA.row + dr) * this._cols + (anchorA.col + dc));
      const ox = (anchorA.x + dc * this._pw) - nbPc.x;
      const oy = (anchorA.y + dr * this._ph) - nbPc.y;
      const bMembers = this._groups.get(gidB);
      const aMembers = this._groups.get(gidA);
      bMembers.forEach(pid => {
        const p = this._pieceById.get(pid);
        p.x += ox;
        p.y += oy;
        p.gid = gidA;
        aMembers.add(pid);
      });
      this._groups.delete(gidB);
    }

    _checkWin() {
      if (this._groups.size === 1) this._onWin?.();
    }

    _progressInfo() {
      const total = this._cols * this._rows - 1;
      const done = this._cols * this._rows - this._groups.size;
      return { done, total, pct: total > 0 ? done / total : 0 };
    }

    get progress() { return this._progressInfo(); }

    /* ── Gather ── */

    gather() {
      if (!this._pieces?.length) return;
      let bigGid = null, bigSize = 0;
      for (const [gid, members] of this._groups) {
        if (members.size > bigSize) { bigSize = members.size; bigGid = gid; }
      }
      const pad = Math.max(this._pw, this._ph);
      const zoneX = this._puzX - pad;
      const zoneY = this._puzY - pad;
      const zoneR = this._puzX + this._puzW + pad;
      const zoneB = this._puzY + this._puzH + pad;
      const LERP = 0.6;
      const moved = new Set();
      for (const pc of this._pieces) {
        if (pc.gid === bigGid || moved.has(pc.gid)) continue;
        moved.add(pc.gid);
        const cx = pc.x + this._pw / 2;
        const cy = pc.y + this._ph / 2;
        const tx = Math.max(zoneX + this._pw / 2, Math.min(zoneR - this._pw / 2, cx));
        const ty = Math.max(zoneY + this._ph / 2, Math.min(zoneB - this._ph / 2, cy));
        if (cx === tx && cy === ty) continue;
        const dx = (tx - cx) * LERP;
        const dy = (ty - cy) * LERP;
        const members = this._groups.get(pc.gid);
        members.forEach(pid => {
          const p = this._pieceById.get(pid);
          p.x += dx;
          p.y += dy;
        });
      }
    }

    _randomScatterPos(pw, ph, wsW, wsH, puzX, puzY, puzW, puzH) {
      const margin = Math.max(pw, ph) * 0.5;
      const clearX0 = puzX - pw * 1.5;
      const clearX1 = puzX + puzW + pw * 0.5;
      const clearY0 = puzY - ph * 1.5;
      const clearY1 = puzY + puzH + ph * 0.5;
      let x, y, attempts = 0;
      do {
        x = margin + Math.random() * (wsW - pw - margin * 2);
        y = margin + Math.random() * (wsH - ph - margin * 2);
        attempts++;
      } while (attempts < 12 && x > clearX0 && x < clearX1 && y > clearY0 && y < clearY1);
      return { x, y };
    }
  };

  /* ═══ Renderer — single rAF, prescale-once, per-edge borders (verbatim) ══ */

  const OUTLINE_COLOR = 'rgba(0,0,0,0.65)';
  const OUTLINE_WIDTH = 1.4;
  const DRAG_OUTLINE_COLOR = 'rgba(129,140,248,0.9)';
  const DRAG_OUTLINE_WIDTH = 2.0;
  const GHOST_ALPHA = 0.18;
  const GHOST_BORDER_COLOR = 'rgba(255,255,255,0.06)';
  const GHOST_BORDER_WIDTH = 1.5;
  const SHADOW_BLUR = 16;
  const SHADOW_OFFSET_Y = 6;
  const EDGES = ['top', 'right', 'bottom', 'left'];
  const EDGE_DIR = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
  const EMPTY_SET = new Set();

  FF.Renderer = class Renderer {
    constructor(canvas, player, engine) {
      this._canvas = canvas;
      this._ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
      this._player = player;
      this._engine = engine;
      this._pathCache = new PathCache();
      this._lastBitmap = null;
      this._showGhost = false;
      this._rafId = null;
      this._running = false;
      this._solvedAt = null;
      this._bgColor = '#151515';
      this._boundTick = this._tick.bind(this);
      this._onSolved = null;
      this._solveTimer = null;
    }

    setup(cols, rows, pw, ph, puzX, puzY, puzW, puzH, wsW, wsH) {
      this._cols = cols; this._rows = rows;
      this._pw = pw; this._ph = ph;
      this._puzX = puzX; this._puzY = puzY;
      this._puzW = puzW; this._puzH = puzH;
      this._wsW = wsW; this._wsH = wsH;
      this._canvas.width = wsW;
      this._canvas.height = wsH;
      this._pathCache.reset(pw, ph);
      this._solvedAt = null;
      this._staticSrc = null;
      this._srcOC = null;
      this._srcCtx = null;
      if (this._lastBitmap) { this._lastBitmap.close(); this._lastBitmap = null; }
    }

    setBgColor(c) { this._bgColor = c; }

    start() {
      this._running = true;
      if (!this._rafId) this._rafId = requestAnimationFrame(this._boundTick);
    }

    stop() {
      this._running = false;
      if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    }

    destroy() {
      this.stop();
      clearTimeout(this._solveTimer);
      if (this._lastBitmap) { this._lastBitmap.close(); this._lastBitmap = null; }
    }

    toggleGhost() { this._showGhost = !this._showGhost; return this._showGhost; }
    setGhost(on) { this._showGhost = !!on; }

    /** Win: fade borders over 2s, then fire onSolved (win overlay). */
    solve() {
      this._solvedAt = performance.now();
      clearTimeout(this._solveTimer);
      this._solveTimer = setTimeout(() => { this._onSolved?.(); }, 1800);
    }

    /** Restore of an already-solved board: borders gone, no overlay callback. */
    setSolved() { this._solvedAt = performance.now() - 3000; }

    onSolved(cb) { this._onSolved = cb; }
    getPathCache() { return this._pathCache; }

    _tick() {
      if (!this._running) return;
      this._rafId = requestAnimationFrame(this._boundTick);
      this._drawFrame();
    }

    _drawFrame() {
      const ctx = this._ctx;
      const src = this._player.getSource();
      const state = this._engine.getState();

      let srcBitmap = this._lastBitmap;
      if (src) {
        const fresh = this._prescaleSource(src);
        if (fresh) srcBitmap = fresh;
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = this._bgColor;
      ctx.fillRect(0, 0, this._wsW, this._wsH);

      if (srcBitmap) {
        ctx.strokeStyle = GHOST_BORDER_COLOR;
        ctx.lineWidth = GHOST_BORDER_WIDTH;
        ctx.strokeRect(this._puzX, this._puzY, this._puzW, this._puzH);
      }

      if (this._showGhost && srcBitmap) {
        ctx.globalAlpha = GHOST_ALPHA;
        ctx.drawImage(srcBitmap, this._puzX, this._puzY);
        ctx.globalAlpha = 1;
      }

      const dragIds = state.dragGid != null
        ? (state.groups.get(state.dragGid) ?? EMPTY_SET)
        : EMPTY_SET;

      let borderAlpha = 1;
      if (this._solvedAt !== null) {
        const elapsed = (performance.now() - this._solvedAt) / 1000;
        borderAlpha = Math.max(0, 1 - elapsed / 2);
      }

      // Fully solved: one unclipped blit erases hairline seams
      if (borderAlpha <= 0 && srcBitmap && state.pieces.length > 0) {
        const p0 = state.pieces[0];
        ctx.drawImage(srcBitmap, p0.x - p0.col * this._pw, p0.y - p0.row * this._ph);
        return;
      }

      for (const pc of state.pieces) {
        this._drawPiece(ctx, pc, srcBitmap, dragIds.has(pc.id), state.groups, state.pieceById, borderAlpha);
      }
    }

    _drawPiece(ctx, pc, srcBitmap, isDragged, groups, pieceById, borderAlpha = 1) {
      const path = this._pathCache.get(pc.col, pc.row, this._cols, this._rows);

      if (isDragged) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, pc.x, pc.y);
        ctx.shadowColor = 'rgba(0,0,0,0.75)';
        ctx.shadowBlur = SHADOW_BLUR;
        ctx.shadowOffsetY = SHADOW_OFFSET_Y;
        ctx.shadowOffsetX = 3;
        ctx.fillStyle = 'rgba(0,0,0,0.001)';
        ctx.fill(path);
        ctx.restore();
      }

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, pc.x, pc.y);
      ctx.clip(path);
      if (srcBitmap) {
        const ovf = Math.ceil(Math.max(this._pw, this._ph) * TAB_DEPTH + 2);
        const srcX = Math.max(0, pc.col * this._pw - ovf);
        const srcY = Math.max(0, pc.row * this._ph - ovf);
        const srcR = Math.min(this._puzW, (pc.col + 1) * this._pw + ovf);
        const srcB = Math.min(this._puzH, (pc.row + 1) * this._ph + ovf);
        const srcW = srcR - srcX;
        const srcH = srcB - srcY;
        const dstX = srcX - pc.col * this._pw;
        const dstY = srcY - pc.row * this._ph;
        ctx.drawImage(srcBitmap, srcX, srcY, srcW, srcH, dstX, dstY, srcW, srcH);
      } else {
        ctx.fillStyle = `hsl(${(pc.col + pc.row) * 41}, 18%, 18%)`;
        const ovf = Math.ceil(Math.max(this._pw, this._ph) * 0.4);
        ctx.fillRect(-ovf, -ovf, this._pw + ovf * 2, this._ph + ovf * 2);
      }
      ctx.restore();

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, pc.x, pc.y);
      if (borderAlpha <= 0) { ctx.restore(); return; }
      ctx.globalAlpha = borderAlpha;
      if (isDragged) {
        ctx.strokeStyle = DRAG_OUTLINE_COLOR;
        ctx.lineWidth = DRAG_OUTLINE_WIDTH;
      } else {
        ctx.strokeStyle = OUTLINE_COLOR;
        ctx.lineWidth = OUTLINE_WIDTH;
      }
      for (const edge of EDGES) {
        const [dc, dr] = EDGE_DIR[edge];
        const nc = pc.col + dc, nr = pc.row + dr;
        if (nc >= 0 && nc < this._cols && nr >= 0 && nr < this._rows) {
          const nb = pieceById.get(nr * this._cols + nc);
          if (nb && nb.gid === pc.gid) continue;    // internal seam — skip
        }
        ctx.stroke(this._pathCache.getEdge(pc.col, pc.row, this._cols, this._rows, edge));
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    _prescaleSource(src) {
      let srcW, srcH;
      const isVideo = src instanceof HTMLVideoElement;
      if (isVideo) {
        srcW = src.videoWidth; srcH = src.videoHeight;
        if (!srcW || !srcH || src.readyState < 2) return null;
      } else {
        srcW = src.naturalWidth; srcH = src.naturalHeight;
        if (!srcW || !srcH) return null;
        if (this._lastBitmap && this._staticSrc === src) return null; // images: prescale once
        this._staticSrc = src;
      }
      if (!this._srcOC || this._srcOC.width !== this._puzW || this._srcOC.height !== this._puzH) {
        this._srcOC = new OffscreenCanvas(this._puzW, this._puzH);
        this._srcCtx = this._srcOC.getContext('2d', { alpha: false });
      }
      this._srcCtx.drawImage(src, 0, 0, srcW, srcH, 0, 0, this._puzW, this._puzH);
      if (this._lastBitmap) this._lastBitmap.close();
      this._lastBitmap = this._srcOC.transferToImageBitmap();
      return this._lastBitmap;
    }
  };

  /* ═══ Small helpers ══════════════════════════════════════════════════════ */

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function fmtMMSS(sec) {
    if (!isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /* ═══ FrameFitGame — host contract (mount/pause/resume/getState/destroy) ═ */

  class FrameFitGame {
    constructor() {
      this._timer = new ElapsedTimer();
      this._container = null; this._root = null;
      this._mediaId = null; this._media = null; this._url = null;
      this._player = null; this._engine = null; this._renderer = null;
      this._ws = null; this._canvas = null;
      this._phase = 'setup';               // setup | playing | solved
      this._pieceStep = this._loadStep();
      this._layout = null;
      this._ghost = false;
      this._wasPlaying = false;
      this._mediaLoaded = false;
      this._onProgress = () => {};
      this._loadingEl = null;
      this._newConfirm = 0;
      this._bg = '#151515';
    }

    _loadStep() {
      try {
        const v = parseInt(localStorage.getItem('framefit_step'), 10);
        if (Number.isInteger(v) && v >= 0 && v < PIECE_STEPS.length) return v;
      } catch {}
      return 4; // 42 pieces — friendly default
    }
    _saveStep() { try { localStorage.setItem('framefit_step', String(this._pieceStep)); } catch {} }

    _loadBg() { try { return localStorage.getItem('framefit_bg') || ''; } catch { return ''; } }
    _saveBg() { try { localStorage.setItem('framefit_bg', this._bg); } catch {} }

    /* ── Loading veil (on the host container so root rebuilds keep it) ── */
    _showLoading(text) {
      this._hideLoading();
      const el = document.createElement('div');
      el.className = 'game-loading-overlay';
      el.innerHTML = `<div class="game-spinner"></div><div>${esc(text || 'Loading…')}</div>`;
      this._container.appendChild(el);
      this._loadingEl = el;
    }
    _hideLoading() { if (this._loadingEl) { this._loadingEl.remove(); this._loadingEl = null; } }

    async mount(container, { mediaId, media, savedState, onProgress }) {
      this._container = container;
      this._mediaId = mediaId;
      this._media = media || getMediaById(mediaId);
      this._url = '/media/' + mediaId;
      this._onProgress = onProgress || (() => {});
      container.innerHTML = '<div class="ff-root" id="ff-root"></div>';
      this._root = container.querySelector('#ff-root');
      this._bg = this._loadBg() ||
        getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim() || '#151515';
      this._player = new FF.MediaSource(this._root);

      // NB: getState() emits parallel arrays px/py/pg — test THAT shape
      if (savedState && Array.isArray(savedState.px) && savedState.px.length) {
        this._showLoading('Restoring puzzle…');
        try { await this._applyState(savedState); }
        catch (e) { console.error('[FrameFit] restore failed:', e); this._showPieceChooser(); }
        finally { this._hideLoading(); }
      } else {
        if (savedState && Number.isInteger(savedState.pieceStep)) this._pieceStep = savedState.pieceStep;
        this._showPieceChooser();
      }
    }

    /* ── Pre-game piece-count chooser ── */

    _showPieceChooser() {
      this._phase = 'setup';
      const kind = this._media?.media_type === 'video' ? '🎬' : '🖼';
      this._root.innerHTML = `
        <div class="ff-setup">
          <h2 class="ff-setup-title">${kind} ${esc(this._media?.filename || 'Media')}</h2>
          <p class="ff-setup-sub">Slice it into a jigsaw — it keeps playing while you solve.</p>
          <div class="ff-setup-slider">
            <span class="ff-lbl">Pieces</span>
            <input type="range" id="ff-setup-pieces" min="0" max="${PIECE_STEPS.length - 1}" step="1" value="${this._pieceStep}">
            <span class="ff-pieces-lbl" id="ff-setup-lbl">${PIECE_STEPS[this._pieceStep]}</span>
          </div>
          <button class="ff-btn ff-btn-primary ff-start-btn" id="ff-setup-start">▶ Start puzzle</button>
        </div>`;
      const slider = this._root.querySelector('#ff-setup-pieces');
      slider.addEventListener('input', () => {
        this._pieceStep = parseInt(slider.value, 10);
        this._root.querySelector('#ff-setup-lbl').textContent = PIECE_STEPS[this._pieceStep];
        this._saveStep();
      });
      this._root.querySelector('#ff-setup-start').addEventListener('click', () => this._start());
    }

    async _start() {
      this._showLoading('Loading media…');
      try {
        const kind = this._media?.media_type === 'video' ? 'video' : 'image';
        let dims;
        if (this._mediaLoaded) {
          const src = this._player.getSource();
          dims = kind === 'video'
            ? { w: src.videoWidth, h: src.videoHeight }
            : { w: src.naturalWidth, h: src.naturalHeight };
          this._player.playVideo();
        } else {
          dims = await this._player.load(this._url, kind);
          this._mediaLoaded = true;
        }

        this._buildGameUI();
        await this._waitForWidth();

        const target = PIECE_STEPS[this._pieceStep];
        const { cols, rows } = this._bestGrid(target, dims.w, dims.h);
        this._layout = this._computeLayout(cols, rows, dims.w, dims.h);

        edgeTable.generate(cols, rows);
        this._wireBoard();
        this._engine.init(this._layout);
        this._engine.fitView();

        this._timer.setElapsedMs(0);
        this._startClock();
        this._setProgress({ done: 0, total: cols * rows - 1, pct: 0 });
        this._phase = 'playing';
        this._onProgress();
      } catch (e) {
        console.error('[FrameFit] start failed:', e);
        showToast('⚠ Frame Fit: ' + e.message);
        this._showPieceChooser();
      } finally {
        this._hideLoading();
      }
    }

    /* Renderer.setup + engine pathCache share — used by start AND restore. */
    _wireBoard() {
      const l = this._layout;
      this._renderer.setup(l.cols, l.rows, l.pw, l.ph, l.puzX, l.puzY, l.puzW, l.puzH, l.wsW, l.wsH);
      this._renderer.setBgColor(this._bg);
      this._renderer.setGhost(this._ghost);
      this._root.querySelector('#ff-ghost')?.classList.toggle('active', this._ghost);
      this._engine.setPathCache(this._renderer.getPathCache());
      this._engine.onSnap(() => this._onProgress());
      this._engine.onProgress((info) => { this._setProgress(info); this._onProgress(); });
      this._engine.onWin(() => this._onWinTriggered());
      this._renderer.start();
    }

    _startClock() {
      this._timer.start((sec) => {
        const el = this._root.querySelector('#ff-time');
        if (el) el.textContent = fmtMMSS(sec);
      });
    }

    /* ── Game UI (top bar / workspace / transport) ── */

    _buildGameUI() {
      const isVideo = this._media?.media_type === 'video';
      this._root.innerHTML = `
        <div id="ff-top">
          <div class="ff-top-left">
            <span class="ff-title">Frame Fit</span>
            <label class="ff-pieces" title="Applies to the next New puzzle">
              <span class="ff-lbl">Pieces</span>
              <input type="range" id="ff-pieces" min="0" max="${PIECE_STEPS.length - 1}" step="1" value="${this._pieceStep}">
              <span class="ff-pieces-lbl" id="ff-pieces-lbl">${PIECE_STEPS[this._pieceStep]}</span>
            </label>
          </div>
          <div class="ff-top-right">
            <div class="ff-bg" id="ff-bg">
              <button class="ff-btn ff-bg-btn" id="ff-bg-btn" title="Workspace background colour">
                <span class="ff-bg-swatch" id="ff-bg-swatch" style="background:${esc(this._bg)}"></span> BG
              </button>
              <div class="ff-bg-pop" id="ff-bg-pop">
                <div class="ff-bg-grid">
                  ${BG_PRESETS.map(p => `<button class="ff-bg-sw" data-bg="${p.c}" style="background:${p.c}" title="${esc(p.name)}"></button>`).join('')}
                </div>
                <label class="ff-bg-custom">
                  <span>Custom</span>
                  <input type="color" id="ff-bg-custom" value="${/^#[0-9a-f]{6}$/i.test(this._bg) ? this._bg : '#151515'}">
                </label>
              </div>
            </div>
            <button class="ff-btn" id="ff-ghost" title="Toggle the faint reference image">👁 Ghost</button>
            <button class="ff-btn" id="ff-fit" title="Fit the workspace to the screen">⤢ Fit</button>
            <button class="ff-btn" id="ff-gather" title="Pull loose pieces toward the puzzle">✥ Gather</button>
            <div class="ff-hud">
              <span class="ff-hud-stat"><span class="ff-lbl">Time</span><span id="ff-time">0:00</span></span>
              <span class="ff-hud-stat"><span class="ff-lbl">Done</span><span id="ff-progress">0%</span></span>
            </div>
            <button class="ff-btn" id="ff-new" title="Re-cut a fresh puzzle (uses the Pieces slider)">↻ New</button>
          </div>
        </div>
        <div id="ff-ws"><canvas id="ff-canvas"></canvas></div>
        <div id="ff-transport" ${isVideo ? '' : 'style="display:none;"'}>
          <button class="ff-btn" id="ff-back">◀◀ 10</button>
          <button class="ff-btn ff-btn-primary" id="ff-play">⏸</button>
          <button class="ff-btn" id="ff-fwd">10 ▶▶</button>
          <div class="ff-scrub" id="ff-scrub"><div class="ff-scrub-fill" id="ff-scrub-fill"></div></div>
          <span class="ff-time-lbl" id="ff-clock">0:00 / 0:00</span>
          <span class="ff-vol">🔊<input type="range" id="ff-vol" min="0" max="1" step="0.05" value="0.7"></span>
          <input type="range" id="ff-speed" min="0.5" max="2" step="0.25" value="1" title="Playback speed">
          <span class="ff-time-lbl" id="ff-speed-lbl" title="Click to reset">1×</span>
        </div>`;

      // MediaSource elements were children of the old root HTML — re-append
      this._root.appendChild(this._player._vid);
      this._root.appendChild(this._player._img);

      this._ws = this._root.querySelector('#ff-ws');
      this._canvas = this._root.querySelector('#ff-canvas');

      if (this._engine) this._engine.destroy();
      if (this._renderer) this._renderer.destroy();
      this._engine = new FF.PuzzleEngine(this._canvas, this._ws);
      this._renderer = new FF.Renderer(this._canvas, this._player, this._engine);

      this._bindControls(isVideo);
    }

    _bindControls(isVideo) {
      const q = (sel) => this._root.querySelector(sel);

      q('#ff-ghost').addEventListener('click', () => {
        this._ghost = this._renderer.toggleGhost();
        q('#ff-ghost').classList.toggle('active', this._ghost);
        this._onProgress();
      });
      q('#ff-fit').addEventListener('click', () => this._engine.fitView());
      q('#ff-gather').addEventListener('click', () => this._engine.gather());

      this._initBgPicker();

      const pieces = q('#ff-pieces');
      pieces.addEventListener('input', () => {
        this._pieceStep = parseInt(pieces.value, 10);
        q('#ff-pieces-lbl').textContent = PIECE_STEPS[this._pieceStep];
        this._saveStep();
      });

      // Two-step New (original's confirm pattern, restyled)
      const newBtn = q('#ff-new');
      newBtn.addEventListener('click', () => {
        if (this._phase === 'playing' && this._newConfirm === 0) {
          this._newConfirm = 1;
          newBtn.textContent = '↻ Confirm?';
          newBtn.classList.add('ff-btn-warn');
          setTimeout(() => {
            this._newConfirm = 0;
            newBtn.textContent = '↻ New';
            newBtn.classList.remove('ff-btn-warn');
          }, 3000);
          return;
        }
        this._newConfirm = 0;
        this._resetBoard();
        this._showPieceChooser();
      });

      if (!isVideo) return;
      const vid = this._player.videoEl;

      const playBtn = q('#ff-play');
      const syncPlay = () => { playBtn.textContent = this._player.isVideoPlaying() ? '⏸' : '▶'; };
      playBtn.addEventListener('click', () => { this._player.togglePlay(); });
      vid.addEventListener('play', syncPlay);
      vid.addEventListener('pause', syncPlay);
      syncPlay();

      q('#ff-back').addEventListener('click', () => this._player.seek(-10));
      q('#ff-fwd').addEventListener('click', () => this._player.seek(10));
      q('#ff-vol').addEventListener('input', (e) => this._player.setVolume(parseFloat(e.target.value)));

      const speed = q('#ff-speed');
      const speedLbl = q('#ff-speed-lbl');
      speed.addEventListener('input', () => {
        const r = parseFloat(speed.value);
        this._player.setSpeed(r);
        speedLbl.textContent = (Number.isInteger(r) ? r : r.toFixed(2).replace(/0$/, '')) + '×';
      });
      speedLbl.addEventListener('click', () => {
        speed.value = '1'; this._player.setSpeed(1); speedLbl.textContent = '1×';
      });

      // Scrub: click/drag anywhere on the bar; fill driven by timeupdate
      const scrub = q('#ff-scrub');
      const fill = q('#ff-scrub-fill');
      const clock = q('#ff-clock');
      let scrubbing = false;
      const scrubTo = (e) => {
        const r = scrub.getBoundingClientRect();
        this._player.seekTo(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      };
      scrub.addEventListener('pointerdown', (e) => { scrubbing = true; scrub.setPointerCapture(e.pointerId); scrubTo(e); });
      scrub.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e); });
      scrub.addEventListener('pointerup', () => { scrubbing = false; });
      this._onVidTime = () => {
        const d = this._player.duration;
        if (d) fill.style.width = ((this._player.currentTime / d) * 100).toFixed(2) + '%';
        clock.textContent = `${fmtMMSS(this._player.currentTime)} / ${fmtMMSS(d)}`;
      };
      vid.addEventListener('timeupdate', this._onVidTime);
      this._onVidTime();
    }

    _setProgress(info) {
      const el = this._root.querySelector('#ff-progress');
      if (el) el.textContent = Math.round((info?.pct ?? 0) * 100) + '%';
    }

    /* ── Background-colour picker (presets + custom) ── */

    _initBgPicker() {
      const root = this._root;
      const btn = root.querySelector('#ff-bg-btn');
      const pop = root.querySelector('#ff-bg-pop');
      const swatch = root.querySelector('#ff-bg-swatch');
      const custom = root.querySelector('#ff-bg-custom');
      if (!btn || !pop) return;
      const sws = [...root.querySelectorAll('.ff-bg-sw')];

      const markOn = (c) => sws.forEach(s =>
        s.classList.toggle('on', (s.dataset.bg || '').toLowerCase() === (c || '').toLowerCase()));

      const apply = (c) => {
        if (!c) return;
        this._bg = c;
        this._saveBg();
        swatch.style.background = c;
        if (/^#[0-9a-f]{6}$/i.test(c)) custom.value = c;
        markOn(c);
        this._renderer?.setBgColor(c);
        this._onProgress();                 // persist the chosen bg into the save
      };

      btn.addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('show'); });
      // One document listener per game instance — drop any prior before re-adding
      if (this._bgDocClick) document.removeEventListener('click', this._bgDocClick);
      this._bgDocClick = (e) => {
        if (!pop.contains(e.target) && !btn.contains(e.target)) pop.classList.remove('show');
      };
      document.addEventListener('click', this._bgDocClick);

      sws.forEach(s => s.addEventListener('click', () => { apply(s.dataset.bg); pop.classList.remove('show'); }));
      custom.addEventListener('input', () => apply(custom.value));
      markOn(this._bg);
    }

    /* ── Layout math (verbatim from the original App) ── */

    _bestGrid(target, mediaW, mediaH) {
      const aspect = mediaW / mediaH;
      let bestCols = 4, bestRows = Math.max(2, Math.round(target / 4));
      let bestScore = Infinity;
      const maxC = Math.ceil(Math.sqrt(target * 2));
      for (let c = 2; c <= maxC; c++) {
        const r = Math.max(2, Math.round(target / c));
        const total = c * r;
        if (total < 4) continue;
        const pieceAspect = aspect * r / c;
        const squareness = Math.abs(Math.log(pieceAspect));
        const countError = Math.abs(total - target) / target;
        const score = squareness + countError * 0.5;
        if (score < bestScore) { bestScore = score; bestCols = c; bestRows = r; }
      }
      return { cols: bestCols, rows: bestRows };
    }

    _computeLayout(cols, rows, mediaW, mediaH) {
      const sw = this._ws.clientWidth;
      const sh = this._ws.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const maxPuzW = sw * 0.55 * dpr;
      const maxPuzH = sh * 0.65 * dpr;
      const scale = Math.min(maxPuzW / mediaW, maxPuzH / mediaH, 1);
      const pw = Math.max(20, Math.round((mediaW * scale) / cols));
      const ph = Math.max(20, Math.round((mediaH * scale) / rows));
      const puzW = pw * cols;
      const puzH = ph * rows;
      const wsW = Math.round(puzW * (1 + 2 * WS_PAD));
      const wsH = Math.round(puzH * (1 + 2 * WS_PAD));
      const puzX = Math.round((wsW - puzW) / 2);
      const puzY = Math.round((wsH - puzH) / 2);
      return { cols, rows, pw, ph, puzW, puzH, wsW, wsH, puzX, puzY };
    }

    _waitForWidth() {
      return new Promise(resolve => {
        let tries = 0;
        const check = () => {
          if ((this._ws?.getBoundingClientRect().width || 0) > 0 || tries++ > 60) return resolve();
          requestAnimationFrame(check);
        };
        check();
      });
    }

    /* ── Win ── */

    _onWinTriggered() {
      if (this._phase === 'solved') return;
      this._phase = 'solved';
      this._timer.stop();
      this._renderer.solve();
      this._renderer.onSolved(() => this._showWinOverlay());
      this._onProgress();
    }

    _showWinOverlay() {
      this._root.querySelector('#ff-win')?.remove();
      const elapsed = this._timer.elapsedMs() / 1000;
      const overlay = document.createElement('div');
      overlay.id = 'ff-win';
      overlay.innerHTML = `
        <div class="ff-win-card">
          <h2>Solved! 🎉</h2>
          <p>Completed in ${fmtMMSS(elapsed)}</p>
          <div class="ff-win-btns">
            <button class="ff-btn" id="ff-win-keep">Keep watching</button>
            <button class="ff-btn ff-btn-primary" id="ff-win-new">New puzzle</button>
          </div>
        </div>`;
      this._root.appendChild(overlay);
      overlay.querySelector('#ff-win-keep').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#ff-win-new').addEventListener('click', () => {
        overlay.remove();
        this._resetBoard();
        this._showPieceChooser();
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    }

    /* Stop the board but KEEP the loaded media (New Game reuses it). */
    _resetBoard() {
      this._timer.pause();
      this._timer.setElapsedMs(0);
      if (this._renderer) { this._renderer.destroy(); this._renderer = null; }
      if (this._engine) { this._engine.destroy(); this._engine = null; }
      if (this._onVidTime && this._player?.videoEl) {
        this._player.videoEl.removeEventListener('timeupdate', this._onVidTime);
        this._onVidTime = null;
      }
      this._layout = null;
      this._phase = 'setup';
      // Keep media elements alive across the innerHTML swap
      if (this._player) {
        this._player._vid.remove();
        this._player._img.remove();
        this._root.appendChild(this._player._vid);
        this._root.appendChild(this._player._img);
      }
    }

    /* ── Save / restore (spec §8) ── */

    getState() {
      if (this._phase === 'setup' || !this._layout || !this._engine) {
        return { v: 1, media_id: this._mediaId, phase: 'setup', pieceStep: this._pieceStep, bg: this._bg, progress: 0 };
      }
      const st = this._engine.getState();
      const pieces = [...st.pieces].sort((a, b) => a.id - b.id);
      const gids = [...new Set(pieces.map(p => p.gid))];
      const gIndex = new Map(gids.map((g, i) => [g, i]));
      return {
        v: 1,
        media_id: this._mediaId,
        phase: this._phase,
        pieceStep: this._pieceStep,
        layout: this._layout,
        edges: edgeTable.serialize(),
        px: pieces.map(p => Math.round(p.x)),
        py: pieces.map(p => Math.round(p.y)),
        pg: pieces.map(p => gIndex.get(p.gid)),
        view: this._engine.getView(),
        elapsedMs: Math.round(this._timer.elapsedMs()),
        ghost: this._ghost,
        bg: this._bg,
        progress: this._engine.progress?.pct ?? 0,
        media_t: Math.round((this._player?.currentTime || 0) * 10) / 10,
      };
    }

    async _applyState(s) {
      this._pieceStep = Number.isInteger(s.pieceStep) ? s.pieceStep : this._pieceStep;
      this._layout = s.layout;
      this._ghost = !!s.ghost;
      if (s.bg) { this._bg = s.bg; this._saveBg(); }

      const kind = this._media?.media_type === 'video' ? 'video' : 'image';
      await this._player.load(this._url, kind);
      this._mediaLoaded = true;
      if (s.media_t && kind === 'video') this._player.seekAbs(s.media_t);

      edgeTable.load(s.layout.cols, s.layout.rows, s.edges);
      this._buildGameUI();
      await this._waitForWidth();
      this._wireBoard();                      // renderer.setup resets the path cache
      this._engine.restore(s.layout, s.px, s.py, s.pg);
      this._engine.setView(s.view || {});

      this._timer.setElapsedMs(s.elapsedMs || 0);
      this._phase = s.phase === 'solved' ? 'solved' : 'playing';
      if (this._phase === 'solved') {
        this._renderer.setSolved();           // borders gone, no overlay re-pop
        const el = this._root.querySelector('#ff-time');
        if (el) el.textContent = fmtMMSS((s.elapsedMs || 0) / 1000);
        this._setProgress({ pct: 1 });
      } else {
        this._startClock();
        this._setProgress(this._engine.progress);
      }
    }

    /* ── Host lifecycle ── */

    pause() {
      this._wasPlaying = this._player?.isVideoPlaying?.() ?? false;  // capture BEFORE pausing
      this._renderer?.stop();
      this._timer.pause();
      this._player?.pauseVideo();
    }

    resume() {
      this._renderer?.start();
      if (this._phase === 'playing') this._timer.resume();
      if (this._wasPlaying) this._player?.playVideo();
    }

    destroy() {
      try { this._timer.stop(); } catch {}
      this._hideLoading();
      if (this._bgDocClick) { document.removeEventListener('click', this._bgDocClick); this._bgDocClick = null; }
      if (this._renderer) { try { this._renderer.destroy(); } catch {} this._renderer = null; }
      if (this._engine) { try { this._engine.destroy(); } catch {} this._engine = null; }
      if (this._player) { try { this._player.destroy(); } catch {} this._player = null; }
      if (this._container) this._container.innerHTML = '';
    }
  }

  window.gamesRegister('framefit', {
    label: 'Frame Fit',
    icon: '🧩',
    desc: 'Slice a video, gif, or image into a jigsaw — solve it while it plays.',
    acceptTypes: ['video', 'gif', 'image'],
    factory: () => new FrameFitGame(),
  });
})();
