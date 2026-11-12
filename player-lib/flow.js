/* =========================================================================
   FLOW - order a collection so each file flows into the next.

   The Flow… button in the collection bar opens this panel above the files.
   Opening it asks the server to measure the collection's music (tempo,
   energy and loudness at each file's start, middle and end; lib/flow/), and
   shows the energy across the order, the shape you pick, and how many
   hand-overs between files are jumps. The chart (see "The chart" below) is
   drawn at the panel's real width, with lane rows (Tempo, and stream tag
   lanes from window.FlowLaneSource when it exists) and the files' names,
   Fit or Zoom; wide columns get the lanes as tag rows and a preview card
   each. Clicking a column picks its file for the strip under the names
   (Preview, Play, Show in list...; see "Under the chart" below).

   One order: a collection has one play order, its playlist order
   (collection_items.position). Everything here that changes the order
   changes that one, on the server, at once, with Undo: picking a Shape
   (and Waves' peaks, Place tagged files) rearranges the playlist into it
   ("Shapes" below), dragging a column moves a file in it, and clicking a
   saved order loads it into the playlist ("Saved orders" below). The grid,
   Play all, Stage and the count line read the playlist order, so they need
   nothing from here.

   Saved orders: snapshots of the playlist order (and its skips) to keep and
   bring back (the chips on the Lanes row, ＋ Save this order; see "Saved
   orders" below and lib/flow/saved.js).

   Place tagged files (On / Off, shown once a file in the collection has a
   stream tag with a Place, on by default then): a shape puts those files
   where their tag says (First, Last, At a peak...; FlowOrder.planOrder).

   While the panel is open, tiles show a small energy start/middle/end bar
   and the BPM, and a dot for the hand-over from the file before (smooth,
   noticeable, jump). Flow shuffle (Settings › Stage) makes the collection's
   Shuffle lean toward good hand-overs. The Stage bar shows the playing
   file's tempo and energy (StageBar.setFlowText, when the bar is there).

   Ignore calm intros and credits (Settings › Stage): the server applies it
   to the features (player-lib/flow-order.js, Calm edges). The chart shades
   the parts of a file Flow looks past (f.cut) and draws its line there
   dashed and dimmer; hand-overs meet the line where those parts end.
   Changing the setting makes what Flow holds out of date, panel open or not
   (flowSettingsChanged, settingsChanged): the open panel asks again, Flow
   shuffle asks afresh. It never rearranges the playlist by itself.

   Hooks other files call (guarded with typeof):
     flowButtonHtml(c)            collections.js renderCollectionHeader
     flowTileHtml(media)          cards.js renderTile
     flowShuffleCollection(id)    collections.js playCollection (Shuffle)
     flowStageCurrent(row)        stage-control.js setCurrent
     flowSettingsChanged()        stage-settings-ui.js (Ignore calm intros and credits)
     flowMembersChanged(cid)      collection-reorder.js, collections.js, importer.js (order or files changed)
     flowSavedStale(cid)          collections.js fetchCollectionMembers (files came or went)
     flowOrderSynced(cid)         collections.js takeCollectionAnswer (the order read again differs)
     flowCustomAnswer(cid, data, { read }?)  collection-reorder.js _installOrder (an order write's answer),
                                  collections.js takeCollectionAnswer (read: the collection read again)

   Calls out (guarded): reorderReady() and reorderMove(ids, before)
   (collection-reorder.js) for dragging a column in the chart to move its
   file ("Dragging a column to move its file" below).
   ========================================================================= */

const Flow = (() => {
  const POLL_MS = 1500;
  const REFETCH_MS = 2500;
  const DEFAULT_SHAPE = 'smooth';
  const st = {
    cid: null,          // the collection the panel belongs to
    open: false,
    shape: DEFAULT_SHAPE, // the shape last picked (what st.data.order is worked out for)
    waves: FlowOrder.WAVES_DEFAULT,  // Waves: how many peaks (1..6)
    data: null,         // GET /api/flow/collections/:id
    byId: new Map(),    // id -> features
    status: null,       // GET /api/flow/status
    pollTimer: null,
    lastCount: -1,
    lastFetch: 0,
    fetching: false,
    custom: null,       // what the server keeps for Custom (lib/flow/custom.js): { custom, shape, waves, places, shaped, lit } or null
    places: null,      // Place tagged files: true / false as picked, null = on when any file has a placed tag
    hot: -1,            // the chart column under the pointer
    geom: null,         // the chart as last drawn (columns, range) for hover and click
    drawnW: 0,
    nowId: null,        // the file Stage is playing (stageCurrent)
    lanePrefs: null,    // which lane rows show (localStorage)
    hookedSource: null, // the FlowLaneSource whose onChange we listen to
    flashTimer: null,
    zoom: false,       // Zoom (wide columns, sideways scroll) or Fit (localStorage, see zoomPref)
    sel: null,          // the file picked (id), shown in the strip
    selHand: -1,        // the hand-over picked (file i into i + 1), or -1
    follow: true,       // Zoom: keep the playing file in view (until the user scrolls)
    autoLeft: 0,        // the sideways scroll Flow itself last set (anything else is the user's)
    tilesKey: null,     // what the grid's tiles were last drawn from (tilesKeyNow)
    saved: null,        // the collection's saved orders (GET .../saved), for savedCid
    savedCid: null,
    savedInput: null,  // the name box: { mode: 'new' | 'rename', id, value, focus }, or null
  };

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const panel = () => document.getElementById('flowPanel');
  // True while paint replaces the panel: the name box leaving the page then is not the user leaving it.
  let painting = false;
  const activeId = () => (typeof activeCollectionId !== 'undefined' ? activeCollectionId : null);
  const isMine = () => st.cid != null && st.cid === activeId();
  const tooMany = () => !!(st.status && st.status.collection && st.status.collection.tooMany);

  /* Place tagged files (stream tags with a Place, player-lib/stream-tags.js):
     on by default once a file in the collection has one. The server's answer
     says which files do; before the first answer, the page's own copy does. */
  function hasPlaced() {
    if (st.data && st.data.places) return Object.keys(st.data.places).length > 0;
    if (typeof StreamTags === 'undefined' || typeof collectionMembers === 'undefined') return false;
    const ids = collectionMembers.get(st.cid) || [];
    return ids.some(id => StreamTags.tagsOf(id).some(t => t.place && t.place !== 'anywhere'));
  }
  const placesOn = () => (st.places == null ? hasPlaced() : st.places);

  async function api(url, opts) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Server returned ${r.status}`), { status: r.status, code: data.code });
    return data;
  }
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const toastErr = (err, what) => {
    if (err && err.status === 423) return;          // the lock screen takes over
    if (typeof showErrorToast === 'function') showErrorToast(err, what);
    else if (typeof showToast === 'function') showToast(`Flow: ${err.message}`);
  };

  /* ── Open / close ───────────────────────────────────────────────── */

  function reset() {
    clearTimeout(st.pollTimer);
    st.pollTimer = null;
    st.cid = null; st.open = false; st.data = null; st.byId = new Map();
    st.status = null; st.lastCount = -1; st.custom = null; st.fetchFails = 0; st.toasted = false;
    st.showWhy = false; st.lastMoved = null;
    // Each collection starts from the default shape (or its remembered one,
    // toggle): never the shape picked on the one before.
    st.shape = DEFAULT_SHAPE;
    st.waves = FlowOrder.WAVES_DEFAULT;
    st.places = null;
    st.saved = null; st.savedCid = null; st.savedInput = null;
    st.sel = null; st.selHand = -1;
    st.follow = true;
    paint();
  }

  async function toggle(cid) {
    phStart();
    if (st.open && st.cid === cid) { close(); return; }
    if (st.cid !== cid) {
      reset();
      // The shape (and its switches) last picked in this collection, as the
      // starting point: only a hint, the playlist order is never touched.
      const m = recalledShape(cid);
      if (m) { st.shape = m.shape; st.waves = m.waves; st.places = m.places; }
    }
    st.cid = cid;
    st.open = true;
    st.follow = true;
    // The tiles show Flow's marks while it is open: the next answer draws the grid.
    st.tilesKey = null;
    paint();
    renderHeaderButton();
    if (st.savedCid !== cid) await loadSaved(cid);
    try {
      st.status = await api(`/api/flow/status?collection=${cid}`);
    } catch (err) { toastErr(err, 'opening Flow'); }
    // Too big for Flow: the panel says so, and nothing is measured or worked out.
    if (tooMany()) { paint(); return; }
    try {
      st.status = await post(`/api/flow/collections/${cid}/measure`, {});
    } catch (err) { toastErr(err, 'measuring for Flow'); }
    await refetch(true);
    schedulePoll();
  }

  function close() {
    st.open = false;
    clearTimeout(st.pollTimer);
    st.pollTimer = null;
    paint();
    renderHeaderButton();
    if (typeof renderResults === 'function') renderResults();
  }

  function renderHeaderButton() {
    const b = document.getElementById('collFlowBtn');
    if (!b) return;
    const on = st.open && isMine();
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.title = flowButtonTitle(on);
    const chev = b.querySelector('.flow-chev');
    if (chev) chev.textContent = on ? '▴' : '▾';
  }

  /* ── Data ───────────────────────────────────────────────────────── */

  // One fetch at a time; a forced one asked during a fetch runs right after it
  // (a shape picked while the last answer is on its way must not be lost).
  let fetchP = null;
  let again = false;
  async function refetch(force = false) {
    if (!isMine()) return;
    if (st.fetching) {
      if (force) again = true;
      return fetchP;
    }
    if (!force && Date.now() - st.lastFetch < REFETCH_MS * Math.min(8, 2 ** (st.fetchFails || 0))) return;
    fetchP = fetchOnce();
    await fetchP;
    if (again) { again = false; await refetch(true); }
  }

  /** The question for the server: the shape picked, its peaks and Place tagged files. */
  const flowUrl = (cid) => `/api/flow/collections/${cid}?shape=${encodeURIComponent(st.shape)}&places=${placesOn() ? 1 : 0}${st.shape === 'waves' ? `&waves=${st.waves}` : ''}`;

  /** An answer about st.cid, kept. */
  function takeData(data) {
    st.data = data;
    st.byId = new Map(data.features.map(f => [f.id, f]));
    st.lastFetch = Date.now();
    st.lastCount = countKey(data.counts);
    st.fetchFails = 0;
    if (data.custom !== undefined) st.custom = data.custom;
  }

  async function fetchOnce() {
    st.fetching = true;
    const cid = st.cid;
    try {
      const url = flowUrl(cid);
      const data = await api(url);
      if (cid !== st.cid) return;
      // Another shape picked meanwhile: this answer is for the one before; ask again.
      if (url !== flowUrl(cid)) { again = true; return; }
      takeData(data);
      // A shape lit on the server (after a reload, or put in elsewhere) is the
      // one picked: ask again for it, so the guide and the peaks match.
      if (!inPick && adoptLit()) { again = true; return; }
      // Asked before the answer said which files have a placed tag: ask again.
      if (placesOn() !== !!data.placesOn) again = true;
    } catch (err) {
      // Counted as a fetch all the same (so a poll does not ask again at once),
      // backing off, and said once, not on every try.
      st.lastFetch = Date.now();
      st.fetchFails = (st.fetchFails || 0) + 1;
      if (err.status === 413 && st.status && st.status.collection) st.status.collection.tooMany = true;
      if (err.status !== 423 && !st.toasted) { st.toasted = true; toastErr(err, 'working out the Flow chart'); }
    } finally {
      st.fetching = false;
    }
    paint();
    // The open panel's tiles show what Flow measured. The grid is drawn again
    // only for the first answer after opening (every tile gains its Flow row,
    // so its rows are measured again). A measurement landing while the
    // panel is open only rewrites the Flow row of the tiles on screen: a whole
    // grid drawn on every answer cost 80 to 170 ms with 50 cards showing.
    const tk = tilesKeyNow();
    if (st.open && tk !== st.tilesKey) {
      const first = st.tilesKey == null;
      st.tilesKey = tk;
      if (first) { if (typeof renderResults === 'function') renderResults(); }
      else paintTileRows();
    }
  }

  /** Each tile on screen gets its Flow row afresh (tileHtml), nothing else on it changes. */
  function paintTileRows() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    for (const tile of grid.querySelectorAll('.media-tile[data-id]:not(.tv-row)')) {
      const html = tileHtml({ id: Number(tile.dataset.id) });
      const old = tile.querySelector(':scope > .tile-flow');
      if (old ? old._flowHtml === html : !html) continue;
      if (old) old.remove();
      if (!html) continue;
      tile.insertAdjacentHTML('beforeend', html);
      const row = tile.querySelector(':scope > .tile-flow');
      if (row) row._flowHtml = html;
    }
  }

  /** What the tiles' Flow row (tileHtml) is drawn from: each file's measurements. */
  function tilesKeyNow() {
    const d = st.data;
    if (!d) return '';
    let k = '';
    for (const f of d.features) k += `${f.id}:${f.kind}:${f.measured ? 1 : 0}${f.failed ? 1 : 0}${f.noSound ? 1 : 0}${f.music ? 1 : 0}:${f.es}:${f.em}:${f.ee}:${f.ei}:${f.eo}:${f.bs}:${f.bm}:${f.be}:${f.reason || ''}|`;
    return k;
  }

  /** What changes when a measurement lands (a stale row measured again changes only stale). */
  const countKey = (c) => `${c.measured}:${c.failed}:${c.stale || 0}:${c.kept || 0}`;

  function schedulePoll() {
    clearTimeout(st.pollTimer);
    st.pollTimer = null;
    if (!st.open || !isMine()) return;
    st.pollTimer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    st.pollTimer = null;
    if (!st.open || !isMine()) return;
    try {
      const s = await fetch(`/api/flow/status?collection=${st.cid}`, { headers: { 'X-Vault-Background': '1' } });
      if (!s.ok) { if (s.status !== 423) schedulePoll(); return; }
      st.status = await s.json();
    } catch { schedulePoll(); return; }
    const c = st.status.collection;
    if (!c || c.tooMany) { paint(); return; }
    const count = countKey(c);
    // Measuring, updating measurements (stale: measured by an older method),
    // or measuring this collection's files again (Try again, Measure again).
    const active = (c.left > 0 || c.stale > 0 || (c.queued || 0) > 0) && st.status.queue.state !== 'idle';
    // Measure again and Try again change numbers and reasons, not always counts:
    // the chart follows each of this collection's files done (and the last one).
    const moved = `${count}|${c.queued || 0}`;
    const done = st.lastMoved != null && moved !== st.lastMoved;
    st.lastMoved = moved;
    if (count !== st.lastCount || done) await refetch(!active);
    paint();
    // Keep going while something is still being measured for this collection.
    if (active) schedulePoll();
  }

  /* ── Shapes and Custom ──────────────────────────────────────────────
     A shape (Smooth, Build up, Waves, Peak, Steady) is something done to
     the playlist order, not a second order: picking one asks the server for
     the collection in that shape (GET /api/flow/collections/:id, worked out
     from what is measured so far; files not measured yet keep their place)
     and writes it as the playlist order at once, with Undo (the order from
     right before, exactly). Waves' peaks are part of the pick: a peak count
     rearranges into Waves with that many peaks. Place tagged files
     rearranges again while the playlist is still in the shape, else it is
     kept for the next pick.

     Custom is the user's own order. At most one of Custom and the shapes
     is lit, and the server says which (lib/flow/custom.js: the row's mode,
     st.custom.mode); nothing is worked out by comparing orders. Each write
     says what the user did (flow, with the order): a shape picked while
     Custom is lit keeps the order from before as the custom one; shape to
     shape keeps it; Custom ({ custom: true }) has the server put it back
     (files gone since dropped, new ones at the end); a drag or a saved
     order loaded ({ manual: true }) over a shape leaves nothing lit (mode
     'edited': neither the shape nor the kept order), and a shape picked
     then keeps the kept order as it is; over Custom, Custom stays lit.
     Every Undo sends back the row from before the write ({ restore, rev }).
     Remove, Add and their Undos say nothing and change nothing.

     The shape last picked, its peaks and Place tagged files are remembered
     per collection on this computer (localStorage vault.flow.shape.<id>) as
     where the panel starts while Custom is lit; a lit shape comes from the
     server. */

  const SHAPE_PREFIX = 'vault.flow.shape.';
  // The working Flow order kept before there was one order: removed, never shown.
  const OLD_ORDER_PREFIX = 'vault.flow.order.';
  const sameIds = (a, b) => !!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]);
  const toast = (msg) => { if (typeof showToast === 'function') showToast(msg); };
  const shapeName = (shape, waves) => `${FlowOrder.shapeLabel(shape)}${shape === 'waves' ? ` ${waves}` : ''}`;

  /** The playlist order as the page has it now (the server's last answer), or null. */
  function playlistNow() {
    const m = typeof collectionMembers !== 'undefined' && st.cid != null ? collectionMembers.get(st.cid) : null;
    return m || (st.data ? st.data.playlistOrder : null);
  }

  /** The answer's order (the picked shape worked out) is the playlist order, so the shape's guide lines up with it. */
  function guideFits() {
    const d = st.data;
    if (!d || d.shape !== st.shape || (st.shape === 'waves' && FlowOrder.wavesCount(d.waves) !== st.waves)) return false;
    return sameIds(d.order, playlistNow());
  }

  /** The shape the server has lit ({ mode, shape, waves, places, kept, custom, rev }), or null: Custom or nothing is lit. */
  function litShape() {
    const c = st.custom;
    return c && c.lit ? c : null;
  }

  /** Custom is lit: no row, or the row says so ('edited', a shape changed by hand: nothing is lit). */
  function customLit() {
    const c = st.custom;
    return !c || c.mode === 'custom';
  }

  /** The playlist order is still the shape picked here (its peaks and Place tagged files too). */
  function shapeLit() {
    const l = litShape();
    return !!l && l.shape === st.shape && (st.shape !== 'waves' || l.waves === st.waves) && l.places === placesOn();
  }

  /** A lit shape is the one picked: the buttons, the peaks and the guide follow it (after a reload, an Undo). */
  function adoptLit() {
    const l = litShape();
    if (!l || shapeLit()) return false;
    st.shape = l.shape; st.waves = FlowOrder.wavesCount(l.waves); st.places = l.places;
    rememberShape();
    return true;
  }

  // What an Undo sends: the row before, or the row unchanged as a check (flowGuardOf), so a stale Undo is refused.
  const undoFlow = (data) => flowGuardOf(data);

  function rememberShape() {
    if (st.cid == null) return;
    try { localStorage.setItem(SHAPE_PREFIX + st.cid, JSON.stringify({ shape: st.shape, waves: st.waves, places: st.places })); } catch {}
  }

  /** The shape last picked in a collection ({ shape, waves, places }), or null. */
  function recalledShape(cid) {
    let v = null;
    try { v = JSON.parse(localStorage.getItem(SHAPE_PREFIX + cid) || 'null'); } catch { return null; }
    if (!v || typeof v !== 'object' || !FlowOrder.isShape(v.shape)) return null;
    return { shape: v.shape, waves: FlowOrder.wavesCount(v.waves), places: typeof v.places === 'boolean' ? v.places : null };
  }

  /** Remove the working Flow orders an older Vault kept on this computer (vault.flow.order.<id>). */
  function forgetOldOrders() {
    try {
      const gone = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(OLD_ORDER_PREFIX)) gone.push(k);
      }
      gone.forEach(k => localStorage.removeItem(k));
    } catch {}
  }

  /*
   * Changes to the playlist order made here go one after another (a second
   * pick waits for the first to be written), so each Undo puts back the
   * order from right before it.
   */
  let turn = Promise.resolve();
  function inTurn(fn) {
    const p = turn.then(fn);
    turn = p.catch(() => {});
    return p;
  }

  /** The collection's files now, from the server (the page's copy can be behind). */
  async function freshMembers(cid) {
    if (typeof fetchCollectionMembers === 'function') {
      try { return (await fetchCollectionMembers(cid, true)).slice(); } catch {}
    }
    return (typeof collectionMembers !== 'undefined' && collectionMembers.get(cid)) || null;
  }

  // Order writes of this page on their way (customAnswer leaves a read answer landing meanwhile out).
  let writing = 0;

  /*
   * Write an order (and, when given, exactly these skips) as the
   * collection's playlist order, in one request: POST
   * /api/collections/:id/order { order, skips?, flow? }. flow says what
   * the user did (lib/flow/custom.js); order null: none sent (Custom, the
   * server writes the kept order). Kept to the
   * files it has right now (gone ones dropped, new ones at the end), so a
   * file added or taken out since is never lost; a 400 (the files changed
   * on the way): ask again, keep to them, try once more. The answer goes
   * where every rearrange's goes (collection-reorder.js _installOrder: the
   * page's copy, the count line, the skips, the grid and this panel).
   */
  async function writePlaylist(cid, order, skips, flow) {
    writing++;
    try { return await writeNow(cid, order, skips, flow); } finally { writing--; }
  }
  async function writeNow(cid, order, skips, flow) {
    const attempt = async () => {
      const members = await freshMembers(cid);
      const body = {};
      if (order) body.order = members ? reconcile(order, members) : order.slice();
      if (Array.isArray(skips)) body.skips = skips.slice();
      if (flow !== undefined) body.flow = flow;
      const p = post(`/api/collections/${cid}/order`, body);
      return typeof Library !== 'undefined' && typeof Library.ownWrite === 'function' ? Library.ownWrite(p) : p;
    };
    let data;
    try { data = await attempt(); } catch (err) {
      if (!err || err.status !== 400) throw err;
      data = await attempt();
    }
    customAnswer(cid, data);
    if (typeof _installOrder === 'function') await _installOrder(cid, data);
    else {
      if (typeof collectionMembers !== 'undefined' && Array.isArray(data.order)) collectionMembers.set(cid, data.order);
      if (typeof takeCollectionAnswer === 'function') takeCollectionAnswer(cid, data);
      membersChanged(cid);
      if (activeId() === cid && typeof applyFilters === 'function') await applyFilters({ keepPage: true });
    }
    return data;
  }

  /** Read again what the server holds (the files and their order, what is kept for Custom) and draw the panel from it. */
  async function resync(cid) {
    if (cid !== st.cid) return;
    await freshMembers(cid);
    if (activeId() === cid && typeof applyFilters === 'function') { try { await applyFilters({ keepPage: true }); } catch {} }
    await refetch(true);
    if (cid === st.cid && !inPick && adoptLit()) await refetch(true);
    paint();
  }

  /** The grid shows another sort or a shuffle: back to playlist order, so what just changed is what shows. */
  async function showPlaylist(cid) {
    if (activeId() !== cid || typeof switchToPlaylistOrder !== 'function') return;
    const sorted = typeof currentSortField === 'function' && currentSortField() !== 'playlist';
    if (sorted || (typeof Library !== 'undefined' && Library.shuffled)) await switchToPlaylistOrder();
  }

  /**
   * An Undo that puts back an order (and skips, when given) written here,
   * and (flow: undoFlow) the row the server kept before it. Another window
   * changed what Flow keeps since (409 STALE): nothing was written; a plain
   * toast, and the page reads the collection again (grid, lit button, files).
   */
  const undoWrite = (cid, order, skips, flow) => () => inTurn(async () => {
    try {
      await writePlaylist(cid, order, skips, flow);
      await showPlaylist(cid);
      toast('Playlist order put back');
    } catch (err) {
      if (err && err.code === 'STALE') {
        toast(STALE_UNDO_TEXT);
        if (cid === st.cid) await resync(cid);
        else if (typeof fetchCollectionMembers === 'function') { try { await fetchCollectionMembers(cid, true); } catch {} }
        return;
      }
      toastErr(err, 'putting the order back');
    }
    // The shape that is lit again is the one picked (its peaks, Place tagged files).
    if (cid === st.cid && adoptLit()) refetch(true);
    paint();
  });

  /** Pick a shape (waves: Waves' peaks): the playlist order is rearranged into it, with Undo. */
  function pickShape(shape, waves = st.waves) {
    if (!FlowOrder.isShape(shape)) return Promise.resolve(false);
    return inTurn(() => applyShape(shape, waves, st.places));
  }

  /** Waves with this many peaks (1..6): the same as picking the shape. */
  const pickWaves = (n) => pickShape('waves', n);

  /** Place tagged files on or off: the playlist rearranged again while it is still in the shape, else kept for the next pick. */
  function pickPlaces(on) {
    return inTurn(async () => {
      if (!isMine()) return false;
      if (shapeLit()) return applyShape(st.shape, st.waves, !!on);
      st.places = !!on;
      rememberShape();
      paint();
      await refetch(true);
      return false;
    });
  }

  // True while a shape is being put in: an answer landing meanwhile does not move the picked shape (adoptLit).
  let inPick = false;
  async function applyShape(shape, waves, places) {
    inPick = true;
    try { return await putShape(shape, waves, places); } finally { inPick = false; }
  }

  /** @returns {Promise<boolean>} whether the playlist order changed */
  async function putShape(shape, waves, places) {
    if (!isMine()) return false;
    const cid = st.cid;
    // The lit shape picked again: asking again could rearrange it once more
    // (the plan starts from the order it is given), so it stays as it is.
    if (shapeLit() && shape === st.shape && FlowOrder.wavesCount(waves) === st.waves && places === st.places) {
      toast(`The playlist order is already ${shapeName(st.shape, st.waves)}`);
      return false;
    }
    // Kept only once the shape is in: a failed pick leaves the panel as it was.
    const prev = { shape: st.shape, waves: st.waves, places: st.places };
    const giveUp = (err, what) => {
      if (cid === st.cid) { st.shape = prev.shape; st.waves = prev.waves; st.places = prev.places; }
      toastErr(err, what);
      paint();
      // The write may have been kept with its answer lost: the panel follows what the server holds.
      if (cid === st.cid) resync(cid);
      return false;
    };
    st.shape = shape;
    st.waves = FlowOrder.wavesCount(waves);
    st.places = places;
    paint();
    let data;
    try {
      data = await api(flowUrl(cid));
      if (cid !== st.cid) return false;
      takeData(data);
      // The answer said which files have a placed tag, and that changes the question: ask once more.
      if (placesOn() !== !!data.placesOn) {
        data = await api(flowUrl(cid));
        if (cid !== st.cid) return false;
        takeData(data);
      }
    } catch (err) { return giveUp(err, 'working out the order'); }
    const label = shapeName(st.shape, st.waves);
    const before = (await freshMembers(cid)) || data.playlistOrder.slice();
    if (cid !== st.cid) return false;
    const order = reconcile(data.order, before);
    const flow = { shape: st.shape, waves: st.waves, places: placesOn() };
    let written;
    try { written = await writePlaylist(cid, order, undefined, flow); } catch (err) { return giveUp(err, 'rearranging the playlist order'); }
    rememberShape();
    await showPlaylist(cid);
    paint();
    const same = sameIds(written.order || order, before);
    const back = undoFlow(written);
    // Worked out the same as it was and nothing kept changed: nothing to Undo.
    if (same && flowUndoOf(written) === undefined) {
      toast(`The playlist order is already ${label}`);
      return false;
    }
    // No file moved, but the shape is lit now (and Custom kept): that is undoable too.
    const msg = same ? `${label} is picked. The files were already in that order.` : `Rearranged the playlist order: ${label}`;
    // selection.js showUndoToast takes HTML.
    if (typeof showUndoToast === 'function') showUndoToast(esc(msg), undoWrite(cid, before, undefined, back));
    else toast(msg);
    return !same;
  }

  /** Custom: the server puts the kept order back in as the playlist order, with Undo. Nothing while Custom is lit. */
  function pickCustom() {
    return inTurn(async () => {
      if (!isMine()) return false;
      const cid = st.cid;
      // Custom lit here: the panel may be behind (a change in another window), so it is read again and drawn.
      if (customLit()) { await resync(cid); return false; }
      const before = (await freshMembers(cid)) || playlistNow().slice();
      if (cid !== st.cid) return false;
      let data;
      try { data = await writePlaylist(cid, null, undefined, { custom: true }); } catch (err) {
        toastErr(err, 'putting your custom order back');
        paint();
        resync(cid);
        return false;
      }
      const back = undoFlow(data);
      // Custom was lit on the server already (another window): nothing written; drawn from the server.
      if (flowUndoOf(data) === undefined) { await resync(cid); return false; }
      await showPlaylist(cid);
      paint();
      const undo = undoWrite(cid, before, undefined, back);
      if (typeof showUndoToast === 'function') showUndoToast('Back to your custom order', undo);
      else toast('Back to your custom order');
      return true;
    });
  }

  /** Waves' peaks, 1..6: while Waves is the shape picked. */
  function wavesHtml() {
    if (st.shape !== 'waves') return '';
    const lit = shapeLit();
    let btns = '';
    for (let n = FlowOrder.WAVES_MIN; n <= FlowOrder.WAVES_MAX; n++) {
      btns += `<button type="button" data-flow-waves="${n}" aria-pressed="${String(lit && st.waves === n)}" title="${n === 1 ? 'One peak' : `${n} peaks`}: rearrange the playlist order (you can Undo)">${n}</button>`;
    }
    return `<span class="flow-opt"><span class="flow-seg-label">Waves</span>
        <span class="flow-seg flow-waves" role="group" aria-label="How many waves">${btns}</span></span>`;
  }

  /** The Place tagged files switch: only for a collection with placed tags (or once used). */
  function placesHtml() {
    if (st.places == null && !hasPlaced()) return '';
    const on = placesOn();
    return `<span class="flow-opt"><span class="flow-seg-label">Place tagged files</span>
        <span class="flow-seg" role="group" aria-label="Place tagged files" title="Files with a stream tag that has a Place (Opener, Closer...) go where it says when you pick a shape">
          <button type="button" data-flow-places="1" aria-pressed="${String(on)}">On</button>
          <button type="button" data-flow-places="0" aria-pressed="${String(!on)}">Off</button>
        </span></span>`;
  }

  async function queueAct(act) {
    try {
      if (act === 'retry') st.status = await post(`/api/flow/collections/${st.cid}/measure`, { retry: true });
      else if (act === 'again') st.status = await post(`/api/flow/collections/${st.cid}/measure`, { all: true });
      else st.status = await post(`/api/flow/${act === 'pause' ? 'pause' : 'resume'}`, {});
    } catch (err) { toastErr(err, act === 'pause' ? 'pausing' : 'measuring for Flow'); }
    if (act !== 'pause') {
      try { st.status = await api(`/api/flow/status?collection=${st.cid}`); } catch {}
      // What the poll compares with, so a run that is over before the first poll still refetches.
      const c = st.status && st.status.collection;
      if (c && !c.tooMany && act !== 'resume') st.lastMoved = `${countKey(c)}|${c.queued || 0}|asked`;
      schedulePoll();
    }
    paint();
  }

  /*
   * The files the grid shows. The library query applies the search and the
   * filters on top of the playlist order, so the grid, the table and what
   * Next, Previous and Stage play can hold fewer files than the collection.
   * The chart, its hand-overs and jumps and the guide are kept to the same
   * files, so every one of them reads one order: a file the grid hides is
   * not a column either.
   */
  let gridMemo = { ids: null, set: null };
  /** The grid's files as a Set, or null: no answer for this collection yet. */
  function gridSet() {
    if (typeof Library === 'undefined' || !isMine()) return null;
    const spec = Library.spec, ids = Library.ids;
    if (!spec || spec.collectionId !== st.cid || !ids) return null;
    if (gridMemo.ids !== ids) gridMemo = { ids, set: new Set(ids) };
    return gridMemo.set;
  }
  const shownMemo = new WeakMap();   // order -> { set, list }
  /** An order kept to the files the grid shows (the same array when it shows them all). */
  function shown(order) {
    const set = gridSet();
    if (!set || !order) return order;
    const m = shownMemo.get(order);
    if (m && m.set === set) return m.list;
    const kept = order.filter(id => set.has(id));
    const list = kept.length === order.length ? order : kept;
    shownMemo.set(order, { set, list });
    return list;
  }

  /** An order kept to the collection's files (gone dropped, new at the end). */
  const reconcile = (order, base) => FlowOrder.reconcileOrder(order, base);

  let plMemo = { order: null, data: null, jumps: 0 };
  /** Jumps in the playlist order, kept to the files the grid shows. */
  function playlistJumps() {
    const d = st.data;
    if (!d) return 0;
    const p = shown(d.playlistOrder);
    if (p === d.playlistOrder) return d.playlistJumps;
    if (plMemo.order !== p || plMemo.data !== d) plMemo = { order: p, data: d, jumps: FlowOrder.summary(d.features, p).jumps };
    return plMemo.jumps;
  }

  /* ── Saved orders ───────────────────────────────────────────────────
     Snapshots of the playlist order to keep and bring back (server:
     lib/flow/saved.js, in the library database): the chips on the Lanes
     row. Each holds the whole collection's order as it was saved, the skips
     then (row.skips; null in one saved before skips: it has none of its
     own), and the shape it was made with when the playlist was still
     exactly a shape (else shape 'playlist'; the chip shows the shape's name
     only).

     ＋ Save this order keeps the order on screen (orderToSave: the playlist
     order, or a sort or shuffle as shown; a search keeps the files it hides
     in their place) and the skips now. Clicking a chip loads it into the
     playlist order, order and skips in one request (writePlaylist), with
     Undo (the order and skips from right before). It is fitted to the files
     the collection has now: gone files dropped, new ones at the end. One
     with no skips of its own leaves the playlist's skips as they are.

     A chip is lit while the playlist order (and skips, when it has its own)
     is still what it holds (savedLit); any change lets go of it. The chip
     menu: Rename, Update with this order (the order on screen and the skips
     now go into it, with Undo), Delete (with Undo). */

  const SAVED_MAX = 30;
  const SHAPE_PLAYLIST = 'playlist';   // lib/flow/saved.js SHAPE_PLAYLIST
  const savedList = () => (st.saved && st.savedCid === st.cid ? st.saved : []);

  /** The playlist order (and its skips, when the saved order has its own) is still this saved order. */
  function savedLit(s) {
    const p = playlistNow();
    if (!s || !p) return false;
    if (!sameIds(p, reconcile(s.order, p))) return false;
    if (!Array.isArray(s.skips)) return true;
    const members = new Set(p);
    const want = new Set(s.skips.filter(id => members.has(id)));
    const now = typeof Skips !== 'undefined' ? [...Skips.setFor(st.cid)].filter(id => members.has(id)) : [];
    return now.length === want.size && now.every(id => want.has(id));
  }

  /** The saved order the playlist order is now, or null. */
  const savedNow = () => savedList().find(savedLit) || null;

  /** What a save or Update records as the shape: the shape picked while the playlist is still exactly it, else 'playlist'. */
  const shapeToSave = (order) => (shapeLit() && sameIds(order, playlistNow()) ? st.shape : SHAPE_PLAYLIST);

  /** The grid's whole result list for this collection, in the order on screen, or null (not this collection's, or not here). */
  async function screenIds(cid) {
    if (typeof Library === 'undefined' || !Library.spec || Library.spec.collectionId !== cid) return null;
    const ids = typeof Library.waitIds === 'function' ? await Library.waitIds() : Library.ids;
    return ids && Library.spec.collectionId === cid ? Array.from(ids) : null;
  }

  /**
   * The whole collection in the order on screen: the files the grid shows
   * take their slots in the order it shows them (a sort, a shuffle, a drag),
   * and files the grid hides (a search, a filter, the trash) keep their
   * place in `base`.
   */
  function onScreenOrder(base, screen) {
    if (!screen) return base;
    const inBase = new Set(base);
    const seq = screen.filter(id => inBase.has(id));
    const shownSet = new Set(seq);
    let k = 0;
    return base.map(id => (shownSet.has(id) ? seq[k++] : id));
  }

  /** The order a save or Update keeps: the order on screen (onScreenOrder) over the playlist order as it is now. */
  async function orderToSave(cid) {
    const base = (await freshMembers(cid)) || (st.data ? st.data.playlistOrder.slice() : []);
    return onScreenOrder(base, await screenIds(cid));
  }

  /** The playlist's skips now, for a save or Update. */
  const skipsToSave = (cid) => (typeof Skips !== 'undefined' ? { skips: [...Skips.setFor(cid)] } : {});

  /** What the chip says under the name: the shape it was made with, or nothing. */
  const shapeText = (s) => (s.shape === SHAPE_PLAYLIST ? '' : shapeName(s.shape, s.waves));
  const nameTaken = (name, exceptId = null) => savedList().some(s => s.id !== exceptId && s.name.toLowerCase() === name.toLowerCase());

  /** The collection's saved orders, from the server. */
  async function loadSaved(cid) {
    try {
      const list = await api(`/api/flow/collections/${cid}/saved`);
      if (cid !== st.cid) return;
      st.saved = Array.isArray(list) ? list : [];
      st.savedCid = cid;
    } catch (err) {
      if (cid === st.cid) toastErr(err, 'loading the saved orders');
      return;
    }
    paint();
  }

  /**
   * Load a saved order into the playlist order: its order (fitted to the
   * files there are now) and its skips, in one request, with Undo.
   * @returns {Promise<boolean>} whether the playlist changed
   */
  function useSaved(id) {
    return inTurn(async () => {
      const s = savedList().find(x => x.id === id);
      if (!s || !isMine()) return false;
      const cid = st.cid;
      st.savedInput = null;
      if (savedLit(s)) { paint(); return false; }
      const before = await freshMembers(cid);
      const skips = Array.isArray(s.skips) ? s.skips : undefined;
      let data;
      try { data = await writePlaylist(cid, s.order.length ? s.order : (before || []), skips, { manual: true }); } catch (err) {
        toastErr(err, 'loading the saved order');
        paint();
        return false;
      }
      await showPlaylist(cid);
      paint();
      // Undo: the order from before, and the skips from before when they were changed (the server's list).
      const wasSkips = skips ? (Array.isArray(data.was_skipped_ids) ? data.was_skipped_ids : []) : undefined;
      const back = before || (st.data ? st.data.playlistOrder.slice() : null);
      const msg = `Loaded “${esc(s.name)}” into the playlist order`;
      // Loaded by hand: Custom is lit; the Undo puts back the row from before too (a shape lit comes back lit).
      if (back && typeof showUndoToast === 'function') showUndoToast(msg, undoWrite(cid, back, wasSkips, undoFlow(data)));
      else toast(`Loaded “${s.name}” into the playlist order`);
      return true;
    });
  }

  /**
   * Keep the order on screen and the skips now under a name.
   * @returns {Promise<boolean>} saved
   */
  async function saveNamed(raw) {
    if (!st.data || !isMine()) return false;
    const name = String(raw || '').trim();
    if (!name) return false;
    if (nameTaken(name)) { toast(`There is already a saved order called “${name}”. Pick another name.`); return false; }
    if (savedList().length >= SAVED_MAX) { toast(`A collection keeps up to ${SAVED_MAX} saved orders. Delete one to save this.`); return false; }
    const cid = st.cid;
    const order = await orderToSave(cid);
    if (cid !== st.cid) return false;
    const shape = shapeToSave(order);
    let row;
    try {
      row = await post(`/api/flow/collections/${cid}/saved`, { name, shape, waves: st.waves, places: shape === SHAPE_PLAYLIST ? false : placesOn(), order, ...skipsToSave(cid) });
    } catch (err) {
      if (err.code === 'NAME_TAKEN') toast(`There is already a saved order called “${name}”. Pick another name.`);
      else if (err.code === 'FULL') toast(`A collection keeps up to ${SAVED_MAX} saved orders. Delete one to save this.`);
      else toastErr(err, 'saving the order');
      return false;
    }
    if (cid !== st.cid) return true;
    st.saved = [...savedList(), row];
    st.savedCid = cid;
    st.savedInput = null;
    paint();
    toast(`Saved “${name}”`);
    return true;
  }

  /** A new name for a saved order. @returns {Promise<boolean>} renamed (or the same name) */
  async function renameSaved(id, raw) {
    const s = savedList().find(x => x.id === id);
    if (!s) return false;
    const name = String(raw || '').trim();
    if (!name) return false;
    if (name === s.name) { st.savedInput = null; paint(); return true; }
    if (nameTaken(name, id)) { toast(`There is already a saved order called “${name}”. Pick another name.`); return false; }
    let row;
    try { row = await api(`/api/flow/saved/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); } catch (err) {
      if (err.code === 'NAME_TAKEN') toast(`There is already a saved order called “${name}”. Pick another name.`);
      else toastErr(err, 'renaming the saved order');
      return false;
    }
    st.saved = savedList().map(x => (x.id === id ? row : x));
    st.savedInput = null;
    paint();
    return true;
  }

  /** Put the order on screen and the skips now into a saved order, with Undo (it is put back as it was). */
  async function updateSaved(id) {
    const s = savedList().find(x => x.id === id);
    if (!s || !st.data || !isMine()) return;
    const cid = st.cid;
    const order = await orderToSave(cid);
    if (cid !== st.cid) return;
    const shape = shapeToSave(order);
    const was = { shape: s.shape, waves: s.waves, places: s.places, order: s.order, skips: Array.isArray(s.skips) ? s.skips : null };
    const put = (body) => api(`/api/flow/saved/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let row;
    try { row = await put({ shape, waves: st.waves, places: shape === SHAPE_PLAYLIST ? false : placesOn(), order, ...skipsToSave(cid) }); } catch (err) { toastErr(err, 'updating the saved order'); return; }
    if (cid !== st.cid) return;
    st.saved = savedList().map(x => (x.id === id ? row : x));
    paint();
    const undo = async () => {
      let back;
      try { back = await put(was); } catch (err) { toastErr(err, 'putting the saved order back'); return; }
      if (cid !== st.cid || st.savedCid !== cid) return;
      st.saved = savedList().map(x => (x.id === id ? back : x));
      paint();
    };
    // selection.js showUndoToast takes HTML: the name is escaped.
    if (typeof showUndoToast === 'function') showUndoToast(`Updated “${esc(s.name)}” with this order`, undo);
    else toast(`Updated “${s.name}”`);
  }

  /** Delete a saved order, with Undo (it is saved again, under the same name). */
  async function deleteSaved(id) {
    const s = savedList().find(x => x.id === id);
    if (!s) return;
    const cid = st.cid;
    try { await api(`/api/flow/saved/${id}`, { method: 'DELETE' }); } catch (err) {
      if (err.status !== 404) { toastErr(err, 'deleting the saved order'); return; }
    }
    if (cid !== st.cid) return;
    st.saved = savedList().filter(x => x.id !== id);
    if (st.savedInput && st.savedInput.id === id) st.savedInput = null;
    paint();
    const undo = async () => {
      let row;
      try {
        row = await post(`/api/flow/collections/${cid}/saved`, { name: s.name, shape: s.shape, waves: s.waves, places: s.places, order: s.order, ...(Array.isArray(s.skips) ? { skips: s.skips } : {}) });
      } catch (err) {
        if (err.code === 'NAME_TAKEN') toast(`Could not bring back “${s.name}”: another saved order has that name now.`);
        else toastErr(err, 'bringing back the saved order');
        return;
      }
      if (cid !== st.cid || st.savedCid !== cid) return;
      st.saved = [...savedList(), row].sort((a, b) => (a.createdAt - b.createdAt) || (a.id - b.id));
      paint();
    };
    if (typeof showUndoToast === 'function') showUndoToast(`Deleted the saved order “${esc(s.name)}”`, undo);
    else toast(`Deleted “${s.name}”`);
  }

  /** The chip's menu (its ⋯ button, or a right click on it). */
  function savedMenu(id, at, opener = null) {
    const s = savedList().find(x => x.id === id);
    if (!s) return;
    const items = [
      { label: 'Rename', run: () => startNaming('rename', id) },
      { label: 'Update with this order', disabled: !st.data, run: () => updateSaved(id) },
      { sep: true },
      { label: 'Delete', run: () => deleteSaved(id) },
    ];
    if (typeof StreamTags !== 'undefined' && typeof StreamTags.openMenu === 'function') StreamTags.openMenu(items, at, opener);
  }

  /** Open the name box: for a new saved order ('new') or in place of a chip ('rename'). */
  function startNaming(mode, id = null) {
    if (mode === 'new' && !st.data) return;
    const s = id != null ? savedList().find(x => x.id === id) : null;
    if (mode === 'rename' && !s) return;
    st.savedInput = { mode, id, value: s ? s.name : '', focus: true };
    paint();
  }

  /** Close the name box without saving; the focus goes back to what it replaced. */
  function stopNaming() {
    const inp = st.savedInput;
    st.savedInput = null;
    paint();
    const back = inp && inp.mode === 'rename' ? `[data-flow-saved="${inp.id}"]` : '[data-flow-saved-new]';
    panel()?.querySelector(back)?.focus({ preventScroll: true });
  }

  /** Enter in the name box. */
  async function commitNaming(input) {
    const inp = st.savedInput;
    if (!inp || inp.busy) return;
    inp.value = input.value;
    if (!inp.value.trim()) { stopNaming(); return; }
    inp.busy = true;
    try {
      const ok = inp.mode === 'rename' ? await renameSaved(inp.id, inp.value) : await saveNamed(inp.value);
      if (ok) {
        const sel = inp.mode === 'rename' ? `[data-flow-saved="${inp.id}"]` : '[data-flow-saved-new]';
        panel()?.querySelector(sel)?.focus({ preventScroll: true });
      }
    } finally { inp.busy = false; }
  }

  function namingHtml() {
    const inp = st.savedInput;
    const label = inp.mode === 'rename' ? 'New name for this saved order' : 'Name this order';
    return `<input type="text" class="flow-chip-input" data-flow-saved-input maxlength="80" placeholder="Name this order" aria-label="${label}" value="${esc(inp.value || '')}">`;
  }

  const addChipHtml = () => '<button type="button" class="flow-chip flow-chip-add" data-flow-saved-new title="Keep the playlist order as it is now (and its skips) under a name, to bring it back later">＋ Save this order</button>';

  function chipHtml(s) {
    const on = savedLit(s);
    const sub = shapeText(s);
    const title = `${s.name}${sub ? `: ${sub}${s.places ? ', tagged files placed' : ''}` : ''}. ${on ? 'This is the playlist order now.' : 'Click to make this the playlist order (you can Undo).'}`;
    return `<span class="flow-chip${on ? ' on' : ''}" data-flow-chip="${s.id}">`
      + `<button type="button" class="flow-chip-main" data-flow-saved="${s.id}" aria-pressed="${String(on)}" title="${esc(title)}">`
      + `<span class="flow-chip-name">${esc(s.name)}</span>${sub ? `<span class="flow-chip-shape">${esc(sub)}</span>` : ''}</button>`
      + `<button type="button" class="flow-chip-more" data-flow-saved-menu="${s.id}" aria-label="${esc(`More for ${s.name}`)}" aria-haspopup="menu" title="Rename, update or delete">⋯</button></span>`;
  }

  /** The saved orders on the Lanes row: a spacer, Saved, the chips, ＋ Save this order. */
  function savedHtml() {
    const list = savedList();
    const inp = st.savedInput;
    const chips = list.map(s => (inp && inp.mode === 'rename' && inp.id === s.id ? namingHtml() : chipHtml(s))).join('');
    let add = '';
    if (inp && inp.mode === 'new') add = namingHtml();
    else if (st.data) add = addChipHtml();
    if (!chips && !add) return '';
    return `<span class="flow-sp"></span>
        <span class="flow-saved" role="group" aria-label="Saved orders">${list.length ? '<span class="flow-seg-label">Saved</span>' : ''}${chips}${add}</span>`;
  }

  /* ── Tile marks ─────────────────────────────────────────────────────
     On the open collection's tiles and table rows, in every order: a
     "Playing" mark and a thin progress line on the file playing (the same
     clock as the playhead), and "Next" on the file the list plays next
     (Up next's own tag already marks its files). Painted onto whatever the
     grid drew (a watch on the grid, and a check every PH_TICK_MS), so
     cards.js and table-view.js need nothing; only the progress line's width
     changes between paints. */

  function nextFrom(playing) {
    if (typeof Library === 'undefined') return null;
    const upNext = typeof UpNext !== 'undefined' && UpNext.count() > 0 ? UpNext.ids() : [];
    // Skipped files (collection-skips.js) are passed over, as the queue does.
    const skipped = typeof queueSkipSet === 'function' ? queueSkipSet(Library) : null;
    return FlowOrder.nextAfter(playing, { upNext, indexOf: (id) => Library.indexOf(id), idAt: (i) => Library.idAt(i), skipped });
  }

  let marksKey = '';
  let marksQueued = false;
  let marksOn = false;      // did the last paint mark anything (else a grid redraw has nothing to take off)
  function scheduleMarks() {
    if (marksQueued) return;
    marksQueued = true;
    requestAnimationFrame(() => { marksQueued = false; paintMarks(); });
  }

  function marksState() {
    const inColl = activeId() != null;
    const src = inColl ? playSource() : null;
    const playing = src ? src.id : null;
    const nx = inColl ? nextFrom(playing) : null;
    return { src, playing, next: nx && !nx.upNext ? nx.id : null };
  }

  /* The marks as they are now, looked at once per task (a table draws many
     rows in one go and asks for each: flowMarksFor). */
  let marksMemo = null;
  function marksNow() {
    if (marksMemo) return marksMemo;
    marksMemo = { s: marksState() };
    Promise.resolve().then(() => { marksMemo = null; });
    return marksMemo;
  }

  /** The marks a file shows: { pos: null, playing, next }, or null for none (pos: table-view.js reads it). */
  function marksFor(id) {
    const { s } = marksNow();
    const out = { pos: null, playing: id === s.playing, next: id !== s.playing && id === s.next };
    return out.playing || out.next ? out : null;
  }
  const marksSig = (m) => (m ? `${m.pos || ''}|${m.playing ? 'p' : ''}${m.next ? 'n' : ''}` : '');

  function paintMarks() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    marksMemo = null;
    const { s } = marksNow();
    marksKey = `${s.playing}|${s.next}`;
    // Nothing to mark and nothing marked: the grid's own redraws (a scroll
    // through a long list draws rows) cost no walk over the tiles.
    const any = s.playing != null || s.next != null;
    if (!any && !marksOn) return;
    marksOn = any;
    const refit = [];
    for (const tile of grid.querySelectorAll('.media-tile[data-id]')) {
      const id = Number(tile.dataset.id);
      let html = '';
      if (id === s.playing) html += '<span class="flow-mk-badge flow-mk-now">Playing</span><span class="flow-mk-prog"><i></i></span>';
      else if (id === s.next) html += '<span class="flow-mk-badge flow-mk-next">Next</span>';
      const host = tile.querySelector('.tile-thumb') || tile.querySelector('.tv-c-title');
      if (!host) continue;
      // A table row's name and chips were fitted around other marks: fit them again.
      const name = host.querySelector(':scope > .tv-name');
      if (name && name.dataset.mk != null && name.dataset.mk !== marksSig(marksFor(id))) refit.push(id);
      let mk = host.querySelector(':scope > .flow-marks');
      tile.classList.toggle('flow-mk-playing', id === s.playing);
      if (!html) { if (mk) mk.remove(); continue; }
      if (mk && mk.dataset.k === html) continue;
      if (!mk) {
        mk = document.createElement('span');
        mk.className = 'flow-marks';
        host.appendChild(mk);
      }
      mk.dataset.k = html;
      mk.innerHTML = html;
    }
    if (refit.length && typeof StreamTags !== 'undefined' && StreamTags.repaintTiles) StreamTags.repaintTiles(refit);
    paintProgress(s);
  }

  function paintProgress(s) {
    const bar = s.playing != null ? document.querySelector('#resultsGrid .flow-mk-prog > i') : null;
    if (!bar || !s.src) return;
    const d = Number(s.src.el.duration);
    const p = d > 0 && Number.isFinite(d) ? Math.max(0, Math.min(1, (Number(s.src.el.currentTime) || 0) / d)) : 0;
    const w = `${(p * 100).toFixed(1)}%`;
    if (bar.style.width !== w) bar.style.width = w;            // written only when it moved
  }

  /** Every PH_TICK_MS: repaint the marks when what plays changed, else move the progress line. */
  function marksTick() {
    if (document.hidden) return;
    const s = marksState();
    const key = `${s.playing}|${s.next}`;
    if (key !== marksKey) paintMarks();
    else paintProgress(s);
  }

  function startMarks() {
    const grid = document.getElementById('resultsGrid');
    if (grid && typeof MutationObserver === 'function') new MutationObserver(scheduleMarks).observe(grid, { childList: true, subtree: true });
    setInterval(marksTick, PH_TICK_MS);
  }

  /* ── The panel ──────────────────────────────────────────────────── */


  function progressHtml() {
    const s = st.status;
    if (tooMany()) return `<span class="flow-sub">Flow works on collections of up to ${(s.collection.max || 5000).toLocaleString()} files. This one has ${s.collection.total.toLocaleString()}.</span>`;
    // The latest poll first: the order's counts are only as new as the last order fetched.
    const c = (s && s.collection) || (st.data && st.data.counts);
    if (!c) return '<span class="flow-sub">Looking…</span>';
    const done = c.measured + c.failed;
    const q = s && s.queue;
    const busy = !!(q && q.state !== 'idle');
    const queued = busy ? c.queued || 0 : 0;
    // Files being tried again (Try again, Measure again): not counted as failed meanwhile.
    const redo = queued > 0 && ((c.queuedFailed || 0) > 0 || (c.again || 0) > 0);
    const failed = Math.max(0, c.failed - (busy ? c.queuedFailed || 0 : 0));
    const parts = [];
    if (c.measurable === 0) {
      parts.push('<span class="flow-sub">No videos or audio here to measure</span>');
    } else if ((c.left > 0 || c.stale > 0 || queued > 0) && busy) {
      // Measuring, measuring again, or (everything measured by an older method) adding the chart's detail.
      const again = !redo && !(c.left > 0);
      const wait = q.reason === 'paused' ? 'Paused'
        : q.reason === 'stage' ? 'Waiting while Stage plays'
        : q.reason === 'locked' ? 'Waiting: Vault is locked'
        : null;
      const why = again ? (wait ? `${wait}: updating measurements,` : 'Updating measurements:') : (wait || (c.again > 0 ? 'Measuring again' : 'Measuring'));
      const n = again ? c.measured - c.stale : redo ? c.measurable - queued : done;
      const of = again ? c.measured : c.measurable;
      const pct = Math.round((n / Math.max(1, of)) * 100);
      parts.push(`<span class="flow-sub">${why} ${n.toLocaleString()} of ${plural(of, 'file', 'files')}</span>`);
      parts.push(`<span class="flow-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></span>`);
      parts.push(q.paused
        ? '<button type="button" class="flow-btn flow-btn-sm" data-flow-q="resume">Resume</button>'
        : '<button type="button" class="flow-btn flow-btn-sm" data-flow-q="pause" title="Stop measuring for now">Pause</button>');
    } else {
      parts.push(`<span class="flow-sub">${c.measured.toLocaleString()} of ${plural(c.measurable, 'file', 'files')} measured</span>`);
      if (c.left > 0) parts.push('<button type="button" class="flow-btn flow-btn-sm" data-flow-q="retry">Measure the rest</button>');
    }
    if (failed > 0) {
      const groups = failGroups();
      const tip = groups.length ? `Why: ${groups.slice(0, 3).map(g => `${g.reason} (${g.n})`).join('; ')}` : '';
      parts.push(`<span class="flow-sub flow-failed"${tip ? ` title="${esc(tip)}"` : ''}>${plural(failed, 'file', 'files')} couldn’t be measured</span>`);
      if (groups.length) parts.push(`<button type="button" class="flow-btn flow-btn-sm flow-why-btn" data-flow-why aria-expanded="${String(!!st.showWhy)}">${st.showWhy ? 'Hide why' : 'Why?'}</button>`);
    }
    if (c.kept > 0) {
      parts.push(`<span class="flow-sub">${plural(c.kept, 'file', 'files')} kept ${c.kept === 1 ? 'its' : 'their'} older measurements (couldn’t measure again)</span>`);
    }
    // Flow's measuring itself failed (not the files): those files were left for later.
    if (s && s.workerError && !busy && c.left > 0) {
      parts.push(`<span class="flow-sub flow-failed" title="${esc(s.workerError)}">Measuring stopped working, so some files were left for later</span>`);
    }
    if ((failed > 0 || c.kept > 0) && !busy) parts.push('<button type="button" class="flow-btn flow-btn-sm" data-flow-q="retry">Try again</button>');
    if (!busy && c.measurable > 0 && done > 0) parts.push('<button type="button" class="flow-btn flow-btn-sm" data-flow-q="again" title="Measure every file in this collection again">Measure again</button>');
    return parts.join('');
  }

  /** Why files couldn't be measured, grouped by reason, most first: [{ reason, n, names }]. */
  function failGroups() {
    const by = new Map();
    for (const f of (st.data && st.data.features) || []) {
      if (!f.failed) continue;
      const reason = f.reason || 'no reason given';
      let g = by.get(reason);
      if (!g) by.set(reason, (g = { reason, n: 0, names: [] }));
      g.n++;
      if (g.names.length < 10) g.names.push(shortName(f) || f.name || `file ${f.id}`);
    }
    return [...by.values()].sort((a, b) => b.n - a.n);
  }

  /** The reasons, listed under the panel's first row while Why? is open. */
  function whyHtml() {
    if (!st.showWhy) return '';
    const groups = failGroups();
    if (!groups.length) return '';
    const cap = (t) => (/^ff(mpeg|probe) /.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1));
    const items = groups.map(g => {
      const more = g.n > g.names.length ? `, and ${g.n - g.names.length} more` : '';
      return `<li${namesHidden() ? '' : ` title="${esc(g.names.join(', ') + more)}"`}><span>${esc(cap(g.reason))}</span> <span class="flow-sub">${plural(g.n, 'file', 'files')}</span></li>`;
    }).join('');
    return `<ul class="flow-why" aria-label="Why files couldn’t be measured">${items}</ul>`;
  }

  /* ── The chart ──────────────────────────────────────────────────────
     Drawn at the panel's real pixel width (and again when it changes size),
     never a stretched viewBox, so marks stay round and lines thin.
       - height: zoomed to the list's own range (FlowChartMath.yRange), four
         faint gridlines labelled 0-100 on the left;
       - each file: a monotone curve through its envelope (or start, middle,
         end), stroked with a gradient keyed to ABSOLUTE energy (calm at 0,
         intense at 1, whatever the zoom), a faint fill under it; no music: a
         dotted line at its middle energy; not measured: nothing;
       - hand-overs on the line: a short curve from the end of one file to the
         start of the next (smooth faint green, noticeable amber dashed, jump
         red with a "!" badge);
       - the playlist order still in the shape picked: its target as a dashed curve;
       - lane rows under the plot (Tempo, and tag lanes from FlowLaneSource):
         colour bars, or with wide columns tag rows in text and a preview
         card each ("Under the chart");
       - a names row under that, aligned to the columns.
     Below DENSE_PX a column, one simplified path replaces the per-file
     curves, and the fill, names and badges are left out. */

  const DENSE_PX = 3;          // px a column: below this, one simplified path
  const NAMES_PX = 64;         // px a column: below this, numbers only
  const NUM_PX = 22;           // px between the numbers shown
  const LANE_ROW = 14;
  const LANES_KEY = 'vault.flow.lanes';
  const CHART_H_KEY = 'vault.flow.chartHeight';
  const CHART_H_STEP = 10;     // px an arrow key moves the grip

  /* The plot's height: the user's (the grip under the chart, remembered on
     this computer), or by width when they have not picked one. */
  const defaultChartH = (W) => (W < 560 ? 110 : W < 1000 ? 130 : 150);
  let chartH = (() => {
    try { return FlowChartMath.clampChartHeight(localStorage.getItem(CHART_H_KEY)); } catch { return null; }
  })();
  function setChartH(px, save) {
    chartH = px == null ? null : FlowChartMath.clampChartHeight(px);
    if (save) {
      try {
        if (chartH == null) localStorage.removeItem(CHART_H_KEY);
        else localStorage.setItem(CHART_H_KEY, String(chartH));
      } catch {}
    }
    if (st.open && isMine()) drawChart();
    const grip = document.querySelector('#flowPanel .flow-grip');
    if (grip) grip.setAttribute('aria-valuenow', String(currentChartH()));
  }
  const currentChartH = () => chartH || (st.geom ? st.geom.PH : defaultChartH(document.getElementById('flowChartWrap')?.clientWidth || 800));

  function gripHtml() {
    if (!st.data || !st.data.features.length) return '';
    return `<div class="flow-grip" role="separator" aria-orientation="horizontal" tabindex="0"
        aria-label="Chart height" aria-valuemin="${FlowChartMath.CHART_H_MIN}" aria-valuemax="${FlowChartMath.CHART_H_MAX}" aria-valuenow="${currentChartH()}"
        title="Drag to make the chart taller or shorter. Double click to reset."><i></i></div>`;
  }

  const eColor = (v) => `color-mix(in oklab, var(--flow-e-lo), var(--flow-e-hi) ${Math.round(Math.max(0, Math.min(1, v)) * 100)}%)`;
  const GRADE_VAR = { smooth: 'var(--flow-ok)', noticeable: 'var(--flow-warn)', jump: 'var(--flow-bad)' };
  const GRADE_WORD = { smooth: 'Smooth hand-over', noticeable: 'Noticeable hand-over', jump: 'Jump' };
  /** A hand-over in words: "Jump: A into B. Energy drops 14 · same tempo". */
  const handTitle = (h, fa, fb, i) => `${GRADE_WORD[h.grade]}: ${titleName(fa, `file ${i + 1}`)} into ${titleName(fb, `file ${i + 2}`)}. ${FlowOrder.handoverText(fa, fb, h)}${skipNote(fa, fb)}`;
  /** Auto found the parts Flow looks past (they are calm); 15 s and 30 s skip them whatever they are. */
  const calmSkips = () => !!(st.data && st.data.edges === 'auto');
  /**
   * ". Looks past a calm end (20 s) and a calm start (15 s)" when Flow skipped
   * part of either side (". Looks past the end (15 s)..." for 15 s and 30 s), else ''.
   */
  const skipNote = (fa, fb) => {
    const end = fa && fa.skip ? fa.skip[1] : 0, start = fb && fb.skip ? fb.skip[0] : 0;
    const calm = calmSkips() ? 'a calm' : 'the';
    const parts = [end ? `${calm} end (${end} s)` : '', start ? `${calm} start (${start} s)` : ''].filter(Boolean);
    return parts.length ? `. Looks past ${parts.join(' and ')}` : '';
  };
  /** The chart's words for a file's ignored parts. */
  const ignoredTitle = (f, side) => `${titleName(f, 'This file')}: Flow looks past its ${side === 0 ? `first ${f.skip[0]} s` : `last ${f.skip[1]} s`}${calmSkips() ? ` (a calm ${side === 0 ? 'intro' : 'end'})` : ''}`;
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  const pct = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100);
  /** What the chart calls a file: the library's title, or the file name without its extension. */
  const shortName = (f) => (f && f.title) || String((f && f.name) || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  /** A name for a native tooltip (it cannot be blurred): none while Hide file names is on. */
  const titleName = (f, fallback) => (namesHidden() ? fallback : shortName(f) || fallback);
  /** Drawn as a line: measured, with sound (no audio stream, or silent: nothing). */
  const drawable = (f) => !!(f && f.measured && !f.failed && !f.noSound);

  function chartOrder() {
    const d = st.data;
    if (d && dragOrder()) return dragOrder();
    return d ? shown(d.playlistOrder) : [];
  }

  /** The dashed guide: the picked shape's targets while the playlist order is still that shape, else null. */
  function guide() {
    if (!st.data) return null;
    // The targets go by position, so a lit shape (put in here, or after a
    // reload) draws them on the playlist order even when working it out
    // again from that order would give another one.
    const fits = guideFits();
    if (!fits && !shapeLit()) return null;
    const t = FlowOrder.guideTargets(st.shape, st.data, st.waves);
    const w = fits ? st.data.order : playlistNow();
    if (!t || !w || t.length !== w.length) return null;
    const s = shown(w);
    if (s === w) return t;
    // The grid hides some files: each shown column keeps its position's target.
    const at = new Map(w.map((id, i) => [id, i]));
    const out = s.map(id => t[at.get(id)]);
    return out.every(v => typeof v === 'number') ? out : null;
  }

  function chartHandovers(order) {
    // The order drawn (a column being dragged: the order it would make), graded live.
    return FlowOrder.summary(st.data.features, order).handovers;
  }

  /* ── Lane rows ───────────────────────────────────────────────────────
     One 14 px row per lane under the plot, labelled at the left. Tempo is
     Flow's own (a BPM colour bar per file). Tag lanes come from an optional
     global provider (the stream tags work defines it); without one there
     are no tag lanes. The contract, exactly:

       window.FlowLaneSource = {
         lanes(): Array<{ key: string, label: string }>,            // available tag lanes, in order
         cells(laneKey: string, mediaIds: number[]): Array<Array<{ color: string, label: string }>>,  // per file, the tags in that lane ([] = none)
         chips(mediaId: number): Array<{ color: string, label: string }>, // all of a file's stream tags (for the hover card)
         onChange(cb: () => void): void                            // call cb to redraw when tags change
       }

     Colours must be #rgb or #rrggbb: a tag with any other colour is not
     drawn (its chip falls back to grey). A cell with several tags is drawn
     as side-by-side rounded segments; an
     untagged cell is a very faint rounded bar. Which rows show is the user's
     pick (the Lanes toggles), kept in localStorage: { tempo: bool,
     'tag:<key>': bool }; a tag lane shows until it is turned off, Tempo
     until it is turned on. Anything the provider throws or returns malformed
     counts as no tags. */

  /** A provider's colour, only as #rgb or #rrggbb (it goes into markup; anything else is dropped). */
  const safeColor = (c) => (typeof c === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(c.trim()) ? c.trim() : null);

  function laneSource() {
    const s = typeof window !== 'undefined' ? window.FlowLaneSource : null;
    if (!s || typeof s.lanes !== 'function' || typeof s.cells !== 'function') return null;
    if (st.hookedSource !== s) {
      st.hookedSource = s;
      if (typeof s.onChange === 'function') {
        try { s.onChange(() => { if (st.open && isMine()) schedulePaint(); }); } catch {}
      }
    }
    return s;
  }

  function tagLanes() {
    const s = laneSource();
    if (!s) return [];
    try {
      const l = s.lanes();
      return Array.isArray(l) ? l.filter(x => x && x.key != null).map(x => ({ key: `tag:${x.key}`, laneKey: x.key, label: String(x.label || x.key) })) : [];
    } catch { return []; }
  }

  function lanePrefs() {
    if (st.lanePrefs) return st.lanePrefs;
    let p = {};
    try { p = JSON.parse(localStorage.getItem(LANES_KEY) || '{}') || {}; } catch { p = {}; }
    st.lanePrefs = typeof p === 'object' && !Array.isArray(p) ? p : {};
    return st.lanePrefs;
  }

  function laneOn(key) {
    const p = lanePrefs();
    if (key in p) return !!p[key];
    return key !== 'tempo';
  }

  function toggleLane(key) {
    const p = lanePrefs();
    p[key] = !laneOn(key);
    try { localStorage.setItem(LANES_KEY, JSON.stringify(p)); } catch {}
    paint();
  }

  /** Every lane there is, in order: tag lanes, then Tempo. */
  const allLanes = () => [...tagLanes(), { key: 'tempo', label: 'Tempo' }];

  /** Per file (in order), the cells of a lane: [{color, label}] each. */
  function laneCells(lane, order) {
    if (lane.key === 'tempo') {
      return order.map((id) => {
        const f = st.byId.get(id);
        const bpm = f && drawable(f) && f.music ? (f.bm || f.bs || f.be) : null;
        return bpm ? [{ color: eColor(FlowChartMath.tempoShare(bpm)), label: `${Math.round(bpm)} BPM` }] : [];
      });
    }
    const s = laneSource();
    let out = null;
    try { out = s ? s.cells(lane.laneKey, order) : null; } catch { out = null; }
    return order.map((_, i) => {
      const c = out && Array.isArray(out[i]) ? out[i] : [];
      return c.filter(t => t && safeColor(t.color)).map(t => ({ color: safeColor(t.color), label: String(t.label || '') }));
    });
  }

  function lanesSvg(lanes, order, g) {
    let svg = '';
    const { L, step, laneY, dense } = g;
    const inset = Math.min(2, step * 0.15);
    const cellW = Math.max(0.5, step - 2 * inset);
    lanes.forEach((lane, r) => {
      const ry = laneY + r * LANE_ROW;
      const cells = laneCells(lane, order);
      const rx = Math.min(4, cellW / 2);
      if (dense) {
        // Runs of the same colour as one bar each (thousands of files).
        let i = 0;
        while (i < cells.length) {
          const c = cells[i][0] ? cells[i][0].color : null;
          let j = i + 1;
          while (j < cells.length && (cells[j][0] ? cells[j][0].color : null) === c) j++;
          svg += `<rect class="${c ? '' : 'flow-lane-empty'}" x="${f1(L + i * step)}" y="${ry}" width="${f1((j - i) * step)}" height="8" rx="2"${c ? ` fill="${esc(c)}"` : ''}/>`;
          i = j;
        }
      } else {
        cells.forEach((tags, i) => {
          const x0 = L + i * step + inset;
          if (!tags.length) { svg += `<rect class="flow-lane-empty" x="${f1(x0)}" y="${ry}" width="${f1(cellW)}" height="8" rx="${f1(rx)}"/>`; return; }
          const k = tags.length;
          const gapX = k > 1 ? Math.min(1, cellW / k / 4) : 0;
          const sw = (cellW - gapX * (k - 1)) / k;
          tags.forEach((t, j) => {
            svg += `<rect x="${f1(x0 + j * (sw + gapX))}" y="${ry}" width="${f1(Math.max(0.5, sw))}" height="8" rx="${f1(Math.min(4, sw / 2))}" fill="${esc(t.color)}"><title>${esc(`${i + 1}. ${titleName(st.byId.get(order[i]), `File ${i + 1}`)}: ${t.label}`)}</title></rect>`;
          });
        });
      }
      const label = lane.label.length > 14 ? `${lane.label.slice(0, 13)}…` : lane.label;
      svg += `<text class="flow-lane-label" x="${L - 6}" y="${ry + 7.5}" text-anchor="end"><title>${esc(lane.label)}</title>${esc(label)}</text>`;
    });
    return svg;
  }

  /* ── Drawing ──────────────────────────────────────────────────────── */

  function chartHtml(reuse = false) {
    const d = st.data;
    if (!d || !d.features.length) return '';
    if (reuse) return '<div id="flowChartSlot"></div>';
    return `<div class="flow-chart-wrap" id="flowChartWrap">
        <div class="flow-chart-svg"></div>
        <div class="flow-ltags" hidden></div>
        <div class="flow-cards" hidden></div>
        <div class="flow-names"></div>
      </div>`;
  }

  /** Fit or Zoom, beside Hide: only with a chart to size. */
  function zoomHtml() {
    if (!st.data || !st.data.features.length) return '';
    return `<span class="flow-seg flow-zoom" role="group" aria-label="Chart width">
          <button type="button" data-flow-zoom="0" aria-pressed="${String(!st.zoom)}" title="The whole list in the width">Fit</button>
          <button type="button" data-flow-zoom="1" aria-pressed="${String(st.zoom)}" title="A wide column for each file, scroll sideways">Zoom</button>
        </span>`;
  }

  /* Fit or Zoom is remembered on this computer, as the lanes and the chart's height are. */
  const ZOOM_KEY = 'vault.flow.zoom';
  st.zoom = (() => { try { return localStorage.getItem(ZOOM_KEY) === '1'; } catch { return false; } })();
  function setZoom(on) {
    if (on === st.zoom) return;
    st.zoom = on;
    st.follow = true;
    try { localStorage.setItem(ZOOM_KEY, on ? '1' : '0'); } catch {}
    hideCard();
    unscrub();
    paint();
  }

  function lanesRowHtml() {
    if (!st.data || !st.data.features.length) return '';
    const btns = allLanes().map(l => `<button type="button" data-flow-lane="${esc(l.key)}" aria-pressed="${String(laneOn(l.key))}">${esc(l.label)}</button>`).join('');
    return `<div class="flow-row flow-lanes-row">
        <span class="flow-seg-label">Lanes</span>
        <span class="flow-seg" role="group" aria-label="Lanes under the chart">${btns}</span>
        ${savedHtml()}
      </div>`;
  }

  function drawChart() {
    const wrap = document.getElementById('flowChartWrap');
    const d = st.data;
    if (!wrap || !d) return;
    st.drawnW = wrap.clientWidth;
    const order = chartOrder();
    const n = order.length;
    if (!n) return;
    wireWrap(wrap);
    const lanes = allLanes().filter(l => laneOn(l.key));
    const longest = lanes.reduce((m, l) => Math.max(m, Math.min(14, l.label.length)), 3);
    const R = 8, TOP = 16;
    // Fit (the whole list in the width) or Zoom (wide columns, the wrap
    // scrolls sideways). Wide columns get the lanes as tag rows in HTML text
    // (labelled a little wider than the svg's) and a preview card each.
    let L = Math.round(Math.max(34, Math.min(110, longest * 6.6 + 14)));
    let lay = FlowChartMath.colLayout(wrap.clientWidth, n, L, R, st.zoom);
    const rows = FlowChartMath.cardRows(lay.step, thumbsShown());
    if (!rows.rich) {
      L = Math.round(Math.max(30, Math.min(96, longest * 5.6 + 10)));
      lay = FlowChartMath.colLayout(wrap.clientWidth, n, L, R, st.zoom);
    }
    const W = lay.W, step = lay.step;
    wrap.classList.toggle('flow-zoomed', W > Math.floor(wrap.clientWidth));
    const PH = chartH || defaultChartH(Math.max(200, Math.floor(wrap.clientWidth)));
    // Readable tag rows (wide columns) sit under the svg, not in it.
    const svgLanes = rows.rich ? [] : lanes;
    const laneY = TOP + PH + 10;
    const H = laneY + svgLanes.length * LANE_ROW + (svgLanes.length ? 0 : -6);
    const dense = step < DENSE_PX;
    const gap = dense ? 0 : Math.min(8, step * 0.12);
    const base = TOP + PH;
    const targets = guide();

    // The height range: the list's own values (and the targets).
    const vals = [];
    for (const id of order) {
      const f = st.byId.get(id);
      if (!drawable(f)) continue;
      if (f.music) for (const p of FlowChartMath.filePoints(f)) vals.push(p[1]);
      else vals.push(f.em);
    }
    if (targets) vals.push(...targets);
    const { lo, hi } = FlowChartMath.yRange(vals);
    const y = (v) => TOP + PH - ((v - lo) / (hi - lo)) * PH;
    const cx = (i) => L + (i + 0.5) * step;

    let svg = `<defs>
        <linearGradient id="flowEg" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${f1(y(0))}" y2="${f1(y(1))}">
          <stop offset="0" style="stop-color:var(--flow-e-lo)"/><stop offset="1" style="stop-color:var(--flow-e-hi)"/>
        </linearGradient>
        <linearGradient id="flowFadeG" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </linearGradient>
        <mask id="flowFade" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${base}"><rect x="0" y="${TOP}" width="${W}" height="${PH}" fill="url(#flowFadeG)"/></mask>
        <clipPath id="flowClip"><rect x="${L - 2}" y="0" width="${W - R - L + 4}" height="${base + 1}"/></clipPath>
      </defs>`;
    // Gridlines, labelled 0-100.
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      const gy = f1(y(v));
      svg += `<line class="flow-grid" x1="${L}" x2="${W - R}" y1="${gy}" y2="${gy}"/><text class="flow-axis" x="${L - 6}" y="${f1(y(v) + 3.5)}" text-anchor="end">${pct(v)}</text>`;
    }
    svg += `<rect class="flow-col-hot" x="0" y="0" width="0" height="${H}" rx="4" visibility="hidden"/>`;
    const selI = st.sel != null ? order.indexOf(st.sel) : -1;
    if (selI >= 0) svg += `<rect class="flow-col-sel" x="${f1(L + selI * step)}" y="0" width="${f1(Math.max(2, step))}" height="${H}" rx="4"/>`;

    // The plot: nothing in it is drawn outside it (lane rows and labels sit below and left).
    svg += '<g clip-path="url(#flowClip)">';
    // The target (the playlist order still in the shape picked).
    if (targets && targets.length) {
      const every = Math.max(1, Math.ceil(targets.length / Math.max(2, (W - L - R) / 4)));
      const pts = [];
      for (let i = 0; i < targets.length; i += every) pts.push([cx(i), y(targets[i])]);
      if ((targets.length - 1) % every) pts.push([cx(targets.length - 1), y(targets[targets.length - 1])]);
      svg += `<path class="flow-target" d="${FlowChartMath.monotonePath(pts)}"/>`;
    }

    const ends = new Array(n).fill(null);
    let lines = '', fills = '', quiet = '';
    let bands = '', holes = '';      // the ignored parts: shaded bands, and the same as mask rects
    if (dense) {
      // One simplified path: each file's middle energy, broken where there is no line.
      let d1 = '', open = false;
      for (let i = 0; i < n; i++) {
        const f = st.byId.get(order[i]);
        if (!drawable(f) || !f.music) { open = false; continue; }
        d1 += `${open ? 'L' : 'M'}${f1(cx(i))},${f1(y(f.em))}`;
        open = true;
      }
      if (d1) lines += `<path d="${d1}"/>`;
    } else {
      for (let i = 0; i < n; i++) {
        const f = st.byId.get(order[i]);
        if (!drawable(f)) continue;
        const x0 = L + i * step + gap, x1 = L + (i + 1) * step - gap;
        if (!f.music) {
          // No music: a dotted line at its middle energy, where its hand-overs meet it (as they are graded).
          const ym = y(f.em);
          quiet += `<line x1="${f1(x0)}" x2="${f1(x1)}" y1="${f1(ym)}" y2="${f1(ym)}"/>`;
          ends[i] = { s: [x0, ym], e: [x1, ym] };
          continue;
        }
        const pts = FlowChartMath.filePoints(f).map(([t, e]) => [x0 + (x1 - x0) * t, y(e)]);
        ends[i] = { s: pts[0], e: pts[pts.length - 1] };
        const cut = FlowChartMath.ignoredSpan(f);
        if (cut) {
          // Flow looks past a calm intro or end: shaded, the line dashed there, and hand-overs meet the line where it ends.
          const xa = x0 + (x1 - x0) * cut.a, xb = x0 + (x1 - x0) * cut.b;
          const sl = FlowChartMath.slopes(pts);
          if (cut.a > 0) {
            bands += `<rect x="${f1(x0)}" y="${TOP}" width="${f1(xa - x0)}" height="${PH}"><title>${esc(ignoredTitle(f, 0))}</title></rect>`;
            holes += `<rect x="${f1(x0 - gap - 1)}" y="0" width="${f1(xa - x0 + gap + 1)}" height="${base + 2}"/>`;
            ends[i].s = [xa, FlowChartMath.monotoneAt(pts, xa, sl)];
          }
          if (cut.b < 1) {
            bands += `<rect x="${f1(xb)}" y="${TOP}" width="${f1(x1 - xb)}" height="${PH}"><title>${esc(ignoredTitle(f, 1))}</title></rect>`;
            holes += `<rect x="${f1(xb)}" y="0" width="${f1(x1 - xb + gap + 1)}" height="${base + 2}"/>`;
            ends[i].e = [xb, FlowChartMath.monotoneAt(pts, xb, sl)];
          }
        }
        const path = FlowChartMath.monotonePath(pts);
        lines += `<path d="${path}"/>`;
        fills += `<path d="${path} L${f1(x1)},${base} L${f1(x0)},${base} Z"/>`;
      }
    }
    if (bands) svg += `<g class="flow-ignored">${bands}</g>`;
    if (fills) svg += `<g class="flow-fill" mask="url(#flowFade)">${fills}</g>`;
    if (quiet) svg += `<g class="flow-quiet">${quiet}</g>`;
    if (lines && holes) {
      // The line solid outside the ignored parts, dashed and dimmer inside them.
      svg += `<defs><mask id="flowKeep" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/><g fill="#000">${holes}</g></mask>
        <mask id="flowSkip" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><g fill="#fff">${holes}</g></mask></defs>`;
      svg += `<g class="flow-line" mask="url(#flowKeep)">${lines}</g><g class="flow-line flow-line-skipped" mask="url(#flowSkip)">${lines}</g>`;
    } else if (lines) svg += `<g class="flow-line${dense ? ' flow-line-dense' : ''}">${lines}</g>`;

    // Hand-overs, on the line.
    const hand = chartHandovers(order);
    let jumpsDense = '';
    hand.forEach((h, i) => {
      if (!h || h.grade === 'none' || i + 1 >= n) return;
      if (dense) {
        if (h.grade === 'jump') jumpsDense += `M${f1(L + (i + 1) * step)},${base - 5}V${base}`;
        return;
      }
      const a = ends[i] && ends[i].e, b = ends[i + 1] && ends[i + 1].s;
      if (!a || !b) return;
      const fa = st.byId.get(order[i]), fb = st.byId.get(order[i + 1]);
      const title = esc(handTitle(h, fa, fb, i));
      const c = Math.max(1, gap);
      svg += `<path class="flow-hand flow-hand-${h.grade}${st.selHand === i ? ' flow-hand-sel' : ''}" d="M${f1(a[0])},${f1(a[1])} C${f1(a[0] + c)},${f1(a[1])} ${f1(b[0] - c)},${f1(b[1])} ${f1(b[0])},${f1(b[1])}"><title>${title}</title></path>`;
      if (h.grade === 'jump' && step >= 8) {
        const bx = (a[0] + b[0]) / 2, by = Math.max(7, Math.min(a[1], b[1]) - 10);
        svg += `<g class="flow-badge"><title>${title}</title><circle cx="${f1(bx)}" cy="${f1(by)}" r="6.5"/><text x="${f1(bx)}" y="${f1(by + 3.4)}" text-anchor="middle">${h.energyGrade !== 'jump' && h.tempoGrade === 'jump' ? '♩' : '!'}</text></g>`;
      }
    });
    if (jumpsDense) svg += `<path class="flow-hand flow-hand-jump" d="${jumpsDense}"/>`;
    svg += '</g>';

    // The file playing now.
    const nowI = st.nowId != null ? order.indexOf(st.nowId) : -1;
    if (nowI >= 0) svg += `<circle class="flow-now-dot" cx="${f1(cx(nowI))}" cy="5" r="3"><title>Playing now</title></circle>`;

    if (svgLanes.length) svg += lanesSvg(svgLanes, order, { L, step, laneY, dense });
    // The playhead (moved by phPlace only; hidden until something of this order plays).
    svg += `<g class="flow-playhead" visibility="hidden" pointer-events="none"><line class="flow-ph-line" x1="0" x2="0" y1="0" y2="${H}"/><circle class="flow-ph-glow" r="8"/><circle class="flow-ph-dot" r="4"/></g>`;

    const label = `Energy across the playlist order, ${pct(lo)} to ${pct(hi)}`;
    wrap.querySelector('.flow-chart-svg').innerHTML = `<svg class="flow-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`;
    st.geom = { W, H, L, R, TOP, PH, step, n, order, dense, lo, hi, hand, gap, y, cards: rows.cardsOn };
    tagRows(wrap, rows.rich ? lanes : null, order, { L, step, W });
    cardsRow(wrap, order, rows.cardsOn ? { L, step, W, h: rows.cardH, selI, nowI } : null);
    namesRow(wrap, order, { L, step, dense, nowI, W });
    if (rows.cardsOn) fetchMissingRows(order);
    if (st.hot >= n) st.hot = -1;
    showHot(drag && drag.on ? -1 : st.hot);
    paintDrag();
    phTick();
    // Measured while the page may still be settling (a scrollbar coming or
    // going): look again once it has, and redraw if the width moved.
    requestAnimationFrame(() => {
      const w = document.getElementById('flowChartWrap');
      if (w && w.clientWidth !== st.drawnW && st.open && isMine()) drawChart();
    });
  }

  /* ── The playhead ───────────────────────────────────────────────────
     While a file of the shown order plays (on Stage, Basic Stage, the
     player or the mini player), a dot rides its line: across its column by
     the time played, up and down on the same smoothed monotone curve the
     chart draws (FlowChartMath.monotoneAt), with a faint line through the
     column. No music: on its dotted line. A file with no line: the column
     line only. Not in the shown order: nothing.

     Only the dot's own element moves: a check every PH_TICK_MS (and on
     play / pause / seek) finds what plays and where; while it plays, a
     requestAnimationFrame loop (about 30 fps, writing only what moved)
     carries the dot between position reports (mpv reports a few times a
     second), and the tiles' progress line with it. It runs only while the
     dot can move (playing, a known length), and stops while paused, when
     the panel is closed or hidden, and when the tab is hidden. The dot lets
     clicks through, so clicking it jumps to the file like its column. */

  const PH_TICK_MS = 400;
  const ph = { timer: null, raf: 0, src: null, raw: NaN, t0: 0, wall: 0, d: 0, paused: true, key: null, index: -1, curve: null };

  /** What plays now, and its clock: { id, el } (el has currentTime, duration, paused), or null. */
  function playSource() {
    const stage = typeof StageControl !== 'undefined' ? StageControl : null;
    // Stage (mpv): its proxy carries the clock the Stage bar shows.
    if (stage && stage.isOpen() && !stage.basicOn() && typeof stage.currentId === 'function') {
      const id = stage.currentId();
      return id ? { id, el: stage.proxy } : null;
    }
    // The player, the mini player, Basic Stage: the page's own media element.
    if (typeof currentMediaState === 'undefined' || !currentMediaState) return null;
    const el = currentMediaState.element;
    if (!el || !el.isConnected || typeof el.currentTime !== 'number' || !(el.tagName === 'VIDEO' || el.tagName === 'AUDIO')) return null;
    const id = currentMediaState.playbackMediaId || (currentMediaState.currentMediaData && currentMediaState.currentMediaData.id) || null;
    return id ? { id, el } : null;
  }

  /** Read the clock; a new reading re-anchors the interpolation. */
  function phRead(src) {
    const el = src.el;
    const raw = Number(el.currentTime) || 0;
    if (src.el !== (ph.src && ph.src.el) || src.id !== (ph.src && ph.src.id) || raw !== ph.raw) {
      ph.raw = raw; ph.t0 = raw; ph.wall = performance.now();
    }
    ph.src = src;
    ph.d = Number(el.duration) > 0 && Number.isFinite(Number(el.duration)) ? Number(el.duration) : 0;
    ph.paused = !!el.paused || !!el.ended;
  }

  /** Seconds played now: the last reading, carried forward while playing (never more than 2 s ahead). */
  function phTime() {
    if (ph.paused) return ph.t0;
    const t = ph.t0 + Math.min(2, (performance.now() - ph.wall) / 1000);
    return ph.d > 0 ? Math.min(ph.d, t) : t;
  }

  function phHide() {
    const g = document.querySelector('#flowChartWrap .flow-playhead');
    if (g) g.setAttribute('visibility', 'hidden');
  }

  /** Put the dot where the playing file is now. */
  function phPlace() {
    const g = st.geom;
    const node = document.querySelector('#flowChartWrap .flow-playhead');
    if (!g || !node || !ph.src) { phHide(); return; }
    // Where the file is in the shown order (looked up again only when the chart or the file changes).
    const key = `${ph.src.id}|${g.order.length}|${g.W}|${g.lo}|${g.hi}`;
    if (ph.key !== key || ph.geom !== g) {
      ph.key = key; ph.geom = g;
      ph.index = g.order.indexOf(ph.src.id);
      ph.curve = null;
      if (ph.index >= 0) {
        const f = st.byId.get(ph.src.id);
        const x0 = g.L + ph.index * g.step + g.gap, x1 = g.L + (ph.index + 1) * g.step - g.gap;
        let pts = null, flat = null;
        if (g.dense) {
          // One simplified path: straight lines between the centres of the
          // music files next to each other (broken at anything else). The dot
          // rides those; where nothing is drawn it has no y.
          const at = (i) => { const h = st.byId.get(g.order[i]); return i >= 0 && i < g.n && drawable(h) && h.music ? g.y(h.em) : null; };
          const cx = (i) => g.L + (i + 0.5) * g.step;
          const yi = at(ph.index);
          if (yi != null) {
            pts = [];
            const yl = at(ph.index - 1), yr = at(ph.index + 1);
            if (yl != null) pts.push([cx(ph.index - 1), yl]);
            pts.push([cx(ph.index), yi]);
            if (yr != null) pts.push([cx(ph.index + 1), yr]);
          }
          ph.curve = { x0, x1, pts, linear: true, flat: null };
        } else {
          if (drawable(f) && f.music) pts = FlowChartMath.filePoints(f).map(([t, e]) => [x0 + (x1 - x0) * t, g.y(e)]);
          else if (drawable(f)) flat = g.y(f.em);                    // no music: its dotted line
          ph.curve = { x0, x1, pts, sl: pts ? FlowChartMath.slopes(pts) : null, flat };
        }
      }
    }
    if (ph.index < 0 || !ph.curve) { phHide(); return; }
    const c = ph.curve;
    const p = ph.d > 0 ? Math.max(0, Math.min(1, phTime() / ph.d)) : 0;
    const x = c.x0 + (c.x1 - c.x0) * p;
    const yv = c.linear ? linearAt(c.pts, x) : c.pts ? FlowChartMath.monotoneAt(c.pts, x, c.sl) : c.flat;
    const show = yv != null && Number.isFinite(yv) ? 'visible' : 'hidden';
    // Written only when something visible changed (each write costs a style pass).
    const sx = f1(x), sy = f1(show === 'visible' ? yv : 0);
    if (node.dataset.at === `${sx}|${sy}|${show}` && node.getAttribute('visibility') === 'visible') return;
    node.dataset.at = `${sx}|${sy}|${show}`;
    const [line, glow, dot] = node.children;
    line.setAttribute('x1', sx); line.setAttribute('x2', sx);
    for (const ci of [glow, dot]) { ci.setAttribute('cx', sx); ci.setAttribute('cy', sy); ci.setAttribute('visibility', show); }
    node.setAttribute('visibility', 'visible');
  }

  const linearAt = (pts, x) => FlowChartMath.linearAt(pts, x);

  // About 30 frames a second is plenty for a dot (and the tiles' progress line).
  const PH_FRAME_MS = 33;
  let phLast = 0;
  function phFrame(now) {
    ph.raf = 0;
    if (!phShouldRun()) { phPlace(); return; }
    if (!(now - phLast < PH_FRAME_MS)) {
      phLast = now;
      phRead(ph.src);
      phPlace();
      paintProgress(marksState());
    }
    ph.raf = requestAnimationFrame(phFrame);
  }

  function phShouldRun() {
    // Only while the dot can move: playing, with a known length (a picture on Stage has none).
    return !!(ph.src && !ph.paused && ph.d > 0 && !document.hidden && st.open && isMine() && st.geom && ph.index >= 0
      && document.getElementById('flowChartWrap') && panel() && !panel().hidden);
  }

  /** Find what plays, mark it, place the dot, and run or stop the loop. */
  let namesWere = null;
  function phTick() {
    if (st.open && isMine()) {
      // Hide file names or blurred thumbnails changed (Settings, Privacy): drawn again, no frame left scrubbed.
      const nh = `${namesHidden()}|${thumbsBlurred()}`;
      if (namesWere !== null && nh !== namesWere) { unscrub(); schedulePaint(); }
      namesWere = nh;
    }
    const on = st.open && isMine() && !!st.geom && !document.hidden;
    const src = on ? playSource() : null;
    if (on) {
      const stageOpen = typeof StageControl !== 'undefined' && StageControl.isOpen();
      // The name highlight follows what plays (Stage also tells stageCurrent).
      const id = src ? src.id : null;
      if ((src || !stageOpen) && id !== st.nowId) { st.nowId = id; scheduleDraw(); }
    }
    if (!src) {
      ph.src = null;
      if (ph.raf) { cancelAnimationFrame(ph.raf); ph.raf = 0; }
      phHide();
      return;
    }
    phRead(src);
    phPlace();
    follow();
    if (phShouldRun()) { if (!ph.raf) ph.raf = requestAnimationFrame(phFrame); }
    else if (ph.raf) { cancelAnimationFrame(ph.raf); ph.raf = 0; }
  }

  function phStart() {
    if (ph.timer) return;
    ph.timer = setInterval(() => { if (st.open) phTick(); else if (ph.raf || ph.src) phTick(); }, PH_TICK_MS);
    // Play, pause and seeks answer at once, not at the next check.
    for (const ev of ['play', 'pause', 'seeked', 'ended', 'loadedmetadata']) document.addEventListener(ev, () => { if (st.open) phTick(); }, true);
    if (typeof StageControl !== 'undefined' && StageControl.proxy) {
      for (const ev of ['play', 'pause', 'durationchange', 'ended']) StageControl.proxy.addEventListener(ev, () => { if (st.open) phTick(); });
    }
    document.addEventListener('visibilitychange', () => phTick());
  }

  function namesRow(wrap, order, { L, step, dense, nowI, W = 0 }) {
    const el = wrap.querySelector('.flow-names');
    el.style.width = `${W}px`;
    if (dense) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const named = step >= NAMES_PX;
    // Hide file names (privacy): blurred like the tiles' names, and no tooltip.
    const hideNames = namesHidden();
    const every = named ? 1 : Math.max(1, Math.ceil(NUM_PX / step));
    let html = '';
    for (let i = 0; i < order.length; i++) {
      if (i % every && i !== nowI) continue;
      const f = st.byId.get(order[i]);
      const name = shortName(f);
      const w = named ? step : Math.max(step, NUM_PX);
      const left = named ? L + i * step : L + (i + 0.5) * step - w / 2;
      const tip = hideNames ? `${i + 1}${i === nowI ? ' (playing now)' : ''}` : `${i + 1}. ${name}${i === nowI ? ' (playing now)' : ''}`;
      html += `<span class="flow-nm${i === nowI ? ' now' : ''}${named ? '' : ' num'}" data-i="${i}" style="left:${f1(left)}px;width:${f1(w)}px" title="${esc(tip)}"><b>${i + 1}</b>${named ? `<span class="flow-nm-t">${esc(name)}</span>` : ''}</span>`;
    }
    el.innerHTML = html;
  }

  /** Highlight column i (or none): the column, its name and its card (the hover card says more). */
  function showHot(i) {
    st.hot = i;
    const wrap = document.getElementById('flowChartWrap');
    const g = st.geom;
    if (!wrap || !g) { hoverWatch(); return; }
    const col = wrap.querySelector('.flow-col-hot');
    wrap.querySelectorAll('.flow-nm.hot, .flow-card.hot').forEach(x => x.classList.remove('hot'));
    if (i < 0 || i >= g.n) {
      if (col) col.setAttribute('visibility', 'hidden');
      hoverWatch();
      return;
    }
    if (col) {
      col.setAttribute('x', f1(g.L + i * g.step));
      col.setAttribute('width', f1(Math.max(2, g.step)));
      col.setAttribute('visibility', 'visible');
    }
    wrap.querySelector(`.flow-nm[data-i="${i}"]`)?.classList.add('hot');
    cardEls.get(g.order[i])?.classList.add('hot');
    hoverWatch();
  }

  function colAt(e) {
    const wrap = document.getElementById('flowChartWrap');
    const g = st.geom;
    if (!wrap || !g) return -1;
    // A name, a preview card or a tag cell is its column.
    const nm = e.target.closest && e.target.closest('.flow-nm, .flow-card, .flow-tg');
    if (nm && nm.dataset.i != null) return Number(nm.dataset.i);
    const svg = wrap.querySelector('svg');
    if (!svg) return -1;
    const r = svg.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (x < g.L || x >= g.W - g.R) return -1;
    return Math.max(0, Math.min(g.n - 1, Math.floor((x - g.L) / g.step)));
  }

  /** Scroll the list below to this file and light it up for a moment. */
  function revealFile(id) {
    const i = typeof Library !== 'undefined' ? Library.indexOf(id) : -1;
    if (i < 0) {
      if (typeof showToast === 'function') showToast('That file is not in the list below right now. A search or filter may be hiding it.');
      return;
    }
    if (typeof revealMediaIndex === 'function') revealMediaIndex(i);
    clearInterval(st.flashTimer);
    const until = Date.now() + 1800;
    let scrolled = false;
    const smooth = !(typeof prefersReducedMotion === 'function' && prefersReducedMotion());
    const sel = `#resultsGrid [data-id="${Number(id)}"]`;
    // Rows can be drawn again while it scrolls (and fetched first): keep the mark on.
    const tick = () => {
      const el = document.querySelector(sel);
      document.querySelectorAll('#resultsGrid .flow-flash').forEach(x => { if (x !== el) x.classList.remove('flow-flash'); });
      if (el) {
        el.classList.add('flow-flash');
        if (!scrolled) { scrolled = true; el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' }); }
      }
      if (Date.now() > until) {
        clearInterval(st.flashTimer);
        document.querySelectorAll('#resultsGrid .flow-flash').forEach(x => x.classList.remove('flow-flash'));
      }
    };
    tick();
    st.flashTimer = setInterval(tick, 120);
  }

  /* ── Dragging a column to move its file ───────────────────────────────
     Wherever a drag in the grid could move files (reorderReady: playlist
     order, no search ranking it), a file's column in the chart (or its
     name) can be dragged too. A press only becomes a drag once the pointer
     has moved FlowChartMath.DRAG_THRESHOLD px, so a click still shows the
     file below. While dragging, the chart is drawn as it would be with the
     file moved (its hand-overs graded live), a faded column follows the
     pointer, a line marks where it lands and a label says "Move to 4 of 12";
     in a big collection (one thin line) only the line and the label. Escape,
     pointercancel or losing the pointer cancels. The drop is the grid's own
     move (collection-reorder.js reorderMove: saved to the playlist order
     with Undo); the chart keeps the new order
     drawn until the move is in. Nothing scrolls on the drop: the view stays
     where it was and only the chart and the list's contents change. The pointer is captured on the panel, which every repaint
     keeps (the chart's own host is moved during one). */

  let drag = null;   // { pointerId, x0, y0, from, id, order, on, slot, x, preview, hold }
  let dragClicked = false;

  /** Can a column be dragged now? Exactly when the grid would take a move, in the order the chart shows. */
  function dragAllowed() {
    if (!st.open || !isMine() || !st.geom || !st.data) return false;
    if (typeof reorderReady !== 'function' || !reorderReady()) return false;
    return !(typeof _reorderBusy !== 'undefined' && _reorderBusy);
  }

  /** The order the chart draws while a drag shows (or holds) its preview, else null. */
  const dragOrder = () => (drag && (drag.hold || (drag.on && drag.preview))) || null;

  function svgX(e) {
    const svg = document.querySelector('#flowChartWrap svg');
    return svg ? e.clientX - svg.getBoundingClientRect().left : NaN;
  }

  /** The faded column at the pointer, where it lands and its label (drawn over the chart). */
  function paintDrag() {
    const svg = document.querySelector('#flowChartWrap svg');
    if (!svg) return;
    svg.querySelector('.flow-drag-layer')?.remove();
    const g = st.geom;
    if (!drag || !drag.on || !g) return;
    const t = FlowChartMath.dragTarget(drag.order, drag.from, drag.slot);
    const to = t ? t.to : drag.from;
    const base = g.TOP + g.PH;
    const lx = g.L + (to + 0.5) * g.step;
    let html = '';
    if (!g.dense) {
      const w = Math.max(4, g.step - 2 * g.gap);
      const gx = Math.max(g.L, Math.min(g.W - g.R - w, drag.x - w / 2));
      html += `<rect class="flow-drag-land" x="${f1(g.L + to * g.step + 1)}" y="${g.TOP}" width="${f1(Math.max(2, g.step - 2))}" height="${g.PH}" rx="4"/>`;
      html += `<rect class="flow-drag-ghost" x="${f1(gx)}" y="${g.TOP}" width="${f1(w)}" height="${g.PH}" rx="4"/>`;
    } else {
      // Columns too thin for the highlight: a line marks where it lands.
      html += `<line class="flow-drag-ins" x1="${f1(lx)}" x2="${f1(lx)}" y1="${g.TOP - 2}" y2="${base}"/>`;
    }
    const label = `Move to ${(to + 1).toLocaleString()} of ${g.n.toLocaleString()}`;
    const anchor = lx > g.W - 90 ? 'end' : lx < g.L + 90 ? 'start' : 'middle';
    const tx = anchor === 'end' ? lx - 6 : anchor === 'start' ? lx + 6 : lx;
    html += `<text class="flow-drag-label" x="${f1(tx)}" y="${g.TOP - 4}" text-anchor="${anchor}">${esc(label)}</text>`;
    svg.insertAdjacentHTML('beforeend', `<g class="flow-drag-layer" pointer-events="none">${html}</g>`);
  }

  let dragDrawQueued = false;
  function scheduleDragDraw() {
    if (dragDrawQueued) return;
    dragDrawQueued = true;
    requestAnimationFrame(() => { dragDrawQueued = false; if (st.open && isMine()) drawChart(); });
  }

  function dragDown(e) {
    if (e.button !== 0 || drag || !e.target.closest('#flowChartWrap') || !dragAllowed()) return;
    const i = colAt(e);
    if (i < 0) return;
    drag = { pointerId: e.pointerId, x0: e.clientX, y0: e.clientY, from: i, id: st.geom.order[i], order: st.geom.order.slice(), on: false, slot: i, x: svgX(e), preview: null, hold: null };
  }

  function dragMove(e) {
    if (!drag || drag.hold || e.pointerId !== drag.pointerId) return false;
    if (!drag.on) {
      // The button came up somewhere we didn't hear: the press is over, not a drag.
      if (!(e.buttons & 1)) { drag = null; return false; }
      if (!FlowChartMath.dragPassed(e.clientX - drag.x0, e.clientY - drag.y0)) return true;
      // The chart changed under the press (a poll): no drag from a stale column.
      if (!st.geom || st.geom.order.length !== drag.order.length || !dragAllowed()) { drag = null; return false; }
      drag.on = true;
      showHot(-1);
      hideCard();
      unscrub();
      try { panel()?.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add('flow-col-dragging');
    }
    e.preventDefault();
    dragAt(e.clientX);
    // Zoom: near the left or right edge, the chart scrolls (edgeFrame).
    maybeEdge(e.clientX);
    return true;
  }

  /** The dragged column at client x: its slot, the preview, the drawing. */
  function dragAt(clientX) {
    if (!drag || !drag.on) return;
    drag.x = svgX({ clientX });
    const g = st.geom;
    const slot = FlowChartMath.dragSlot(drag.x, { L: g.L, step: g.step, n: drag.order.length });
    if (slot !== drag.slot || !drag.preview) {
      drag.slot = slot;
      const t = FlowChartMath.dragTarget(drag.order, drag.from, slot);
      drag.preview = t ? FlowChartMath.movedOrder(drag.order, drag.from, t.to) : drag.order;
      scheduleDragDraw();
    } else paintDrag();
  }

  /** Off the page's drag look and the pointer let go (set drag.on false or drag null first: losing the capture cancels). */
  function endDragUi(d) {
    stopEdge();
    document.body.classList.remove('flow-col-dragging');
    try { panel()?.releasePointerCapture(d.pointerId); } catch {}
  }

  function cancelDrag() {
    const d = drag;
    if (!d) return;
    drag = null;
    if (d.on) { endDragUi(d); drawChart(); }
  }

  /** Let go: the move goes the grid's way; the chart keeps showing the new order until it is in. Nothing scrolls. */
  async function dropDrag() {
    const d = drag;
    if (!d || !d.on) { drag = null; return false; }
    d.on = false;
    const t = FlowChartMath.dragTarget(d.order, d.from, d.slot);
    if (t) d.hold = FlowChartMath.movedOrder(d.order, d.from, t.to);
    endDragUi(d);
    if (!t || typeof reorderMove !== 'function') { drag = null; drawChart(); return false; }
    let moved = false;
    try {
      moved = await reorderMove([d.id], t.before);
    } finally {
      if (drag === d) drag = null;
      drawChart();
    }
    // The view stays where it was: only the chart and the grid's contents
    // change. Show in list on the file's card is how to go to it.
    return moved;
  }

  // Redraw when the panel changes size (throttled), and when lanes change.
  let drawQueued = false, lastDraw = 0;
  function scheduleDraw() {
    if (drawQueued) return;
    drawQueued = true;
    const wait = Math.max(0, 120 - (Date.now() - lastDraw));
    setTimeout(() => requestAnimationFrame(() => {
      drawQueued = false;
      lastDraw = Date.now();
      if (st.open && isMine()) drawChart();
    }), wait);
  }
  let paintQueued = false;
  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; paint(); });
  }

  function summaryText() {
    const d = st.data;
    if (!d) return '';
    const jumps = playlistJumps();
    // Files the search or filters hide are not in the grid, so not on the chart either.
    // With neither set, the ones left out are what the grid never lists (a
    // document, a trashed file): no note, nothing is hidden by the user.
    const all = d.playlistOrder;
    const grid = gridSet();
    const hidden = grid ? all.filter(id => st.byId.has(id) && !grid.has(id)).length : 0;
    const spec = typeof Library !== 'undefined' ? Library.spec : null;
    const filtering = !!(spec && spec.search && spec.search.text) || (typeof anyFilterIsSet === 'function' && anyFilterIsSet());
    const note = hidden && filtering ? `${plural(hidden, 'file', 'files')} hidden by the search or filters` : '';
    if (d.counts.music < 2) return note;
    const text = jumps ? `${plural(jumps, 'jump', 'jumps')} between files` : 'Every hand-over is smooth or close';
    return note ? `${text} · ${note}` : text;
  }

  function legendHtml() {
    const d = st.data;
    if (!d || !d.features.length) return '';
    const anyQuiet = d.features.some(f => drawable(f) && !f.music);
    const anyCut = d.features.some(f => drawable(f) && f.music && f.cut);
    return `<div class="flow-legend">
          <span><i class="flow-key-energy"></i>Energy (loudness and tempo)</span>
          <span><i class="flow-key-line" style="background:var(--flow-ok)"></i>Smooth hand-over</span>
          <span><i class="flow-key-dash" style="border-color:var(--flow-warn)"></i>Noticeable</span>
          <span><i class="flow-key-line" style="background:var(--flow-bad)"></i>Jump</span>
          ${guide() ? '<span><i class="flow-key-dash flow-key-target"></i>Shape you picked</span>' : ''}
          ${anyQuiet ? '<span><i class="flow-key-dots"></i>No music</span>' : ''}
          ${anyCut ? `<span><i class="flow-key-ignored"></i>${calmSkips() ? 'Calm intro or end, looked past' : 'Start or end, looked past'}</span>` : ''}
        </div>`;
  }

  function paint() {
    const el = panel();
    if (!el) return;
    if (!st.open || !isMine()) { hideCard(); unscrub(); el.hidden = true; el.innerHTML = ''; st.geom = null; return; }
    el.hidden = false;
    const hideBtn = '<button type="button" class="flow-btn flow-btn-sm flow-hide" data-flow-hide title="Hide the Flow panel">Hide ▴</button>';
    if (tooMany()) { el.innerHTML = `<div class="flow-row"><span class="flow-title">Flow</span>${progressHtml()}<span class="flow-sp"></span>${hideBtn}</div>`; st.geom = null; return; }
    // Keyboard focus on the grip, Hide, Fit / Zoom or a strip button stays there across repaints (polls repaint often).
    const KEEP_FOCUS = ['.flow-grip', '[data-flow-hide]', '[data-flow-zoom="0"]', '[data-flow-zoom="1"]'];
    const a = document.activeElement;
    const act = a?.matches?.('#flowPanel [data-flow-act]') ? `[data-flow-act="${a.dataset.flowAct}"]`
      : a?.matches?.('#flowPanel [data-flow-pick]') ? `[data-flow-pick="${a.dataset.flowPick}"]`
      : a?.matches?.('#flowPanel [data-flow-saved]') ? `[data-flow-saved="${a.dataset.flowSaved}"]`
      : a?.matches?.('#flowPanel [data-flow-saved-menu]') ? `[data-flow-saved-menu="${a.dataset.flowSavedMenu}"]`
      : a?.matches?.('#flowPanel [data-flow-shape]') ? `[data-flow-shape="${a.dataset.flowShape}"]`
      : a?.matches?.('#flowPanel [data-flow-custom]') ? '[data-flow-custom]'
      : a?.matches?.('#flowPanel [data-flow-waves]') ? `[data-flow-waves="${a.dataset.flowWaves}"]`
      : a?.matches?.('#flowPanel [data-flow-places]') ? `[data-flow-places="${a.dataset.flowPlaces}"]` : null;
    // The name box keeps what is typed, the focus and the caret across repaints.
    const naming = a?.matches?.('#flowPanel [data-flow-saved-input]') ? { s: a.selectionStart, e: a.selectionEnd } : null;
    if (naming && st.savedInput) st.savedInput.value = a.value;
    const keepFocus = act || ['[data-flow-saved-new]', ...KEEP_FOCUS].find(sel => a?.matches?.(`#flowPanel ${sel}`));
    // Each shape rearranges the playlist order; the one it is still in is lit
    // (litShape), or Custom is (customLit), or neither: a shape's order
    // changed by hand since.
    const lit = litShape();
    const cLit = customLit();
    const custom = `<button type="button" data-flow-custom aria-pressed="${String(cLit)}" title="${esc(cLit
      ? 'Your own order. It is the playlist order now.'
      : 'Your own order. Come back to it after trying a shape.')}">Custom</button>`;
    const shapes = custom + FlowOrder.SHAPES.map(s => {
      const on = !!lit && lit.shape === s.key;
      return `<button type="button" data-flow-shape="${s.key}" aria-pressed="${String(on)}" title="${esc(on ? `The playlist order is ${s.label} now` : `Rearrange the playlist order as ${s.label} (you can Undo)`)}">${esc(s.label)}</button>`;
    }).join('');
    // The chart's host is kept across repaints (polls repaint often): an empty
    // host would shrink the panel for a moment, and a page scrollbar going
    // with it would make the chart measure too wide. The strip is drawn with
    // its text for the same reason: empty while drawChart measures, the page
    // was a line shorter for that moment, and a page scrolled to its end lost
    // its place (the browser clamps the scroll to the shorter page).
    const keep = document.getElementById('flowChartWrap');
    const keepLeft = keep ? keep.scrollLeft : 0;
    // A tag cell with keyboard focus keeps it (taking the host out of the page drops it).
    const tg = keep && document.activeElement && keep.contains(document.activeElement) && document.activeElement.dataset && document.activeElement.dataset.flowTag
      ? `[data-flow-tag="${document.activeElement.dataset.flowTag}"][data-i="${document.activeElement.dataset.i}"]` : null;
    if (keep) keep.remove();
    const chart = !!(st.data && st.data.features.length);
    const html = `
      <div class="flow-row">
        <span class="flow-title">Flow</span>
        ${progressHtml()}
        <span class="flow-sp"></span>
        ${placesHtml()}
        <span class="flow-opt"><span class="flow-seg-label">Shape</span>
        <span class="flow-seg flow-shapes" role="group" aria-label="Shape">${shapes}</span></span>
        ${wavesHtml()}
        ${zoomHtml()}
        ${hideBtn}
      </div>
      ${whyHtml()}
      ${lanesRowHtml()}
      ${chartHtml(!!keep)}
      ${gripHtml()}
      ${chart ? `<div class="flow-strip" id="flowStrip" aria-live="polite">${stripHtml()}</div>` : ''}
      <div class="flow-row">
        ${legendHtml()}
        <span class="flow-sp"></span>
        <span class="flow-sub" id="flowSummary">${esc(summaryText())}</span>
      </div>`;
    painting = true;
    try { el.innerHTML = html; } finally { painting = false; }
    const slot = el.querySelector('#flowChartSlot');
    if (slot && keep) slot.replaceWith(keep);
    st.geom = null;
    drawChart();
    paintStrip();
    // Put back the sideways scroll the repaint took (the wrap was out of the page).
    const w = document.getElementById('flowChartWrap');
    if (w && keepLeft) setScroll(w, keepLeft);
    const box = st.savedInput && el.querySelector('[data-flow-saved-input]');
    if (box && (naming || st.savedInput.focus)) {
      st.savedInput.focus = false;
      box.focus({ preventScroll: true });
      if (naming) { try { box.setSelectionRange(naming.s, naming.e); } catch {} } else box.select();
    } else if (keepFocus) el.querySelector(keepFocus)?.focus({ preventScroll: true });
    else if (tg) w?.querySelector(tg)?.focus({ preventScroll: true });
  }

  /* The grip under the chart: drag up or down for a shorter or taller chart,
     arrows do the same from the keyboard, a double click goes back to the
     size for the panel's width. The drag listens on the window: a poll can
     paint the panel (and a new grip) mid drag. */
  function wireGrip(el) {
    el.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.flow-grip');
      if (!grip || e.button !== 0) return;
      e.preventDefault();
      const y0 = e.clientY;
      const h0 = currentChartH();
      let queued = false, want = h0;
      document.body.classList.add('flow-grip-dragging');
      const move = (ev) => {
        want = h0 + (ev.clientY - y0);
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; setChartH(want, false); });
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        document.body.classList.remove('flow-grip-dragging');
        if (want !== h0) setChartH(want, true);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    el.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.flow-grip')) return;
      setChartH(null, true);
    });
    el.addEventListener('keydown', (e) => {
      if (!e.target.closest('.flow-grip')) return;
      const d = e.key === 'ArrowUp' ? -CHART_H_STEP : e.key === 'ArrowDown' ? CHART_H_STEP : 0;
      if (!d) return;
      // The arrows are the grid's too (dock.js): this one is the grip's.
      e.preventDefault();
      e.stopPropagation();
      setChartH(currentChartH() + d, true);
    });
  }

  function wire() {
    const el = panel();
    if (!el || el._flowWired) return;
    el._flowWired = true;
    el.addEventListener('click', (e) => {
      const s = e.target.closest('[data-flow-shape]');
      if (s) { pickShape(s.dataset.flowShape); return; }
      if (e.target.closest('[data-flow-custom]')) { pickCustom(); return; }
      // Saved orders (the chips on the Lanes row).
      const sv = e.target.closest('[data-flow-saved]');
      if (sv) { useSaved(Number(sv.dataset.flowSaved)); return; }
      const sm = e.target.closest('[data-flow-saved-menu]');
      if (sm) { savedMenu(Number(sm.dataset.flowSavedMenu), { rect: sm.getBoundingClientRect() }, sm); return; }
      if (e.target.closest('[data-flow-saved-new]')) { startNaming('new'); return; }
      if (e.target.closest('[data-flow-saved-input]')) return;
      const wv = e.target.closest('[data-flow-waves]');
      if (wv) { pickWaves(Number(wv.dataset.flowWaves)); return; }
      const q = e.target.closest('[data-flow-q]');
      if (q) { queueAct(q.dataset.flowQ); return; }
      if (e.target.closest('[data-flow-why]')) { st.showWhy = !st.showWhy; paint(); return; }
      const pl = e.target.closest('[data-flow-places]');
      if (pl) { pickPlaces(pl.dataset.flowPlaces === '1'); return; }
      const ln = e.target.closest('[data-flow-lane]');
      if (ln) { toggleLane(ln.dataset.flowLane); return; }
      const z = e.target.closest('[data-flow-zoom]');
      if (z) { setZoom(z.dataset.flowZoom === '1'); return; }
      const act = e.target.closest('[data-flow-act]');
      if (act) { stripAct(act.dataset.flowAct); return; }
      const pk = e.target.closest('[data-flow-pick]');
      if (pk) { pick(Number(pk.dataset.flowPick)); return; }
      if (e.target.closest('[data-flow-hide]')) {
        close();
        // Focus goes back to the toolbar button that opens it again.
        document.getElementById('collFlowBtn')?.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest('#flowChartWrap') && st.geom) {
        // The click that ends a column drag is not a click on the column.
        if (dragClicked) { dragClicked = false; return; }
        chartClick(e);
      }
    });
    el.addEventListener('pointerdown', dragDown);
    el.addEventListener('keydown', tagKey);
    // The name box: Enter saves (or renames), Esc gives up; typing is the box's own.
    el.addEventListener('keydown', (e) => {
      const box = e.target.closest && e.target.closest('[data-flow-saved-input]');
      if (!box) return;
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitNaming(box); }
      else if (e.key === 'Escape') { e.preventDefault(); stopNaming(); }
    });
    el.addEventListener('input', (e) => {
      if (st.savedInput && e.target.matches && e.target.matches('[data-flow-saved-input]')) st.savedInput.value = e.target.value;
    });
    // Leaving the box empty gives up. The chip (or ＋) goes back in its place
    // without a repaint: the click that moved the focus away must still land.
    el.addEventListener('focusout', (e) => {
      const box = e.target;
      if (painting || !box.isConnected || !box.matches || !box.matches('[data-flow-saved-input]')) return;
      const inp = st.savedInput;
      if (!inp || inp.busy || box.value.trim()) return;
      st.savedInput = null;
      const s = inp.mode === 'rename' ? savedList().find(x => x.id === inp.id) : null;
      const html = s ? chipHtml(s) : (st.data ? addChipHtml() : '');
      box.outerHTML = html;
    });
    el.addEventListener('contextmenu', (e) => {
      const chip = e.target.closest('[data-flow-chip]');
      if (!chip) return;
      e.preventDefault();
      savedMenu(Number(chip.dataset.flowChip), { x: e.clientX, y: e.clientY }, chip.querySelector('[data-flow-saved-menu]'));
    });
    el.addEventListener('pointermove', (e) => {
      if (dragMove(e)) return;
      const wrap = e.target.closest('#flowChartWrap');
      if (!wrap) { if (st.hot >= 0) showHot(-1); hideCard(); unscrub(); return; }
      const i = colAt(e);
      wrap.classList.toggle('flow-can-drag', i >= 0 && dragAllowed());
      if (i !== st.hot) showHot(i);
      // The hover card or a preview card's frame: next frame, never in this handler.
      hoverAt(e);
    });
    el.addEventListener('pointerup', (e) => {
      if (!drag || e.pointerId !== drag.pointerId) return;
      if (!drag.on) { drag = null; return; }
      // The browser follows with a click on the panel: not a click on a column.
      dragClicked = true;
      setTimeout(() => { dragClicked = false; }, 0);
      dropDrag();
    });
    // A press let go outside the panel before it became a drag.
    window.addEventListener('pointerup', (e) => { if (drag && !drag.on && e.pointerId === drag.pointerId) drag = null; });
    el.addEventListener('pointercancel', cancelDrag);
    el.addEventListener('lostpointercapture', () => { if (drag && drag.on) cancelDrag(); });
    el.addEventListener('pointerleave', () => { if (st.hot >= 0) showHot(-1); hideCard(); unscrub(); });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !drag || !drag.on) return;
      e.preventDefault();
      e.stopPropagation();
      cancelDrag();
    }, true);
    wireGrip(el);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        const wrap = document.getElementById('flowChartWrap');
        if (wrap && wrap.clientWidth !== st.drawnW) scheduleDraw();
      }).observe(el);
    }
  }

  /* ── Under the chart: tag rows, preview cards, the strip ─────────────
     Fit puts the whole list in the panel's width; Zoom gives each file
     ZOOM_COL_PX and the chart scrolls sideways (the wheel over it, the
     scrollbar, a trackpad or Shift and the wheel; the wheel stays with
     the chart at either end, so the page doesn't move under it).
     Columns CARD_PX or wider get the lanes as rows of readable tags and a
     preview card each above the names (scrubbed by the pointer); narrower
     ones keep the colour bars and no cards. Clicking a column (or its card)
     picks its file for the strip under the names (a double click plays it);
     clicking a hand-over explains it there; dragging a card moves its file
     as dragging the column does. Hovering shows a card by the pointer for a
     hand-over (the end of one file beside the start of the next), and,
     without preview cards, for a column: the file's frame at the time under
     the pointer (the seek bars' hover frames, /scrub/:id/:idx).

     Nothing here listens to the page's own scroll or wheel. While something
     plays in Zoom, the 400 ms playhead check keeps it in view until the
     user scrolls the chart themselves. */

  const HAND_PX = 8;           // px either side of a hand-over that picks it
  const DBL_MS = 450;          // two clicks on one column this close: play it

  const namesHidden = () => !!(document.body && document.body.classList && document.body.classList.contains('pm-names'));
  const stageOpen = () => typeof StageControl !== 'undefined' && !!StageControl.isOpen && StageControl.isOpen();
  const libRow = (id) => (typeof Library !== 'undefined' && typeof Library.row === 'function' ? Library.row(id) : null);
  const durOf = (id) => { const r = libRow(id); return r && Number(r.duration_seconds) > 0 ? Number(r.duration_seconds) : 0; };
  const lenText = (id) => { const d = durOf(id); return d && typeof formatDuration === 'function' ? formatDuration(d) : ''; };
  const thumbsShown = () => !(typeof thumbsOff === 'function' && thumbsOff());
  /** Privacy: thumbnails blurred, no hover reveal (settings.js pm-thumbs): no frames from the pointer either. */
  const thumbsBlurred = () => !!(document.body && document.body.classList && document.body.classList.contains('pm-thumbs'));

  /** The file's still: its thumbnail as the tiles show it, or '' (none, thumbnails off). */
  function stillUrl(id) {
    if (!thumbsShown()) return '';
    const r = libRow(id);
    if (r && typeof canShowThumb === 'function' && !canShowThumb(r)) return '';
    if (typeof staticThumbSrc === 'function') return staticThumbSrc(id);
    return `/thumb/${id}`;
  }

  /** Hover frame idx of a video (the seek bars'), or '' when frames are off or it is not a video. */
  function frameUrl(id, idx) {
    if (typeof thumbHoverOn === 'function' && !thumbHoverOn()) return '';
    const r = libRow(id);
    if (r && r.media_type !== 'video') return '';
    if (r && typeof canShowThumb === 'function' && !canShowThumb(r)) return '';
    return typeof scrubUrl === 'function' ? scrubUrl(id, idx) : `/scrub/${id}/${idx}`;
  }

  /* Pictures asked for once and kept (a card that follows the pointer must
     not wait for the network each time it moves): the last IMG_KEEP. */
  const IMG_KEEP = 240;
  const imgs = new Map();      // url -> Image
  const failed = new Set();    // urls that did not load
  function warm(url) {
    if (!url || imgs.has(url) || typeof Image !== 'function') return;
    const im = new Image();
    im.decoding = 'async';
    im.onerror = () => failed.add(url);
    im.src = url;
    imgs.set(url, im);
    if (imgs.size > IMG_KEEP) imgs.delete(imgs.keys().next().value);
  }
  /** A file's five hover frames, warmed. */
  function warmFrames(id) { for (let k = 0; k < 5; k++) warm(frameUrl(id, k)); }

  /** The picture for a file at frac across it: its frame there, else its still. */
  function pictureAt(id, frac) {
    const fr = FlowChartMath.frameAt(frac, durOf(id));
    const u = frameUrl(id, fr.idx);
    if (u && !failed.has(u)) return { url: u, t: fr.t, idx: fr.idx };
    const s = stillUrl(id);
    return { url: s && !failed.has(s) ? s : '', t: fr.t, idx: fr.idx };
  }

  /* ── Tag rows (CARD_PX a column or wider) ──
     Each lane shown is a row under the plot, labelled at the left: a tag
     lane's tags as their names on their colours (ellipsis when tight),
     Tempo as the BPM and a small meter, a faint dashed slot where a file has
     nothing. With stream tags loaded, a tag lane's cell (empty or not) opens
     the stream tag menu for its file, as the preview pane's + Tag does. */

  /** Can a tag lane's cell open the stream tag menu (player-lib/stream-tags.js)? */
  const tagEditor = () => typeof StreamTags !== 'undefined' && typeof StreamTags.blockMenu === 'function'
    && !(typeof StreamTags.loaded === 'function' && !StreamTags.loaded());

  function tagRows(wrap, lanes, order, { L, step, W }) {
    const el = wrap.querySelector('.flow-ltags');
    if (!el) return;
    if (!lanes || !lanes.length) { if (!el.hidden) { el.hidden = true; el.innerHTML = ''; } return; }
    const ROW = FlowChartMath.TAG_ROW;
    el.hidden = false;
    el.style.width = `${W}px`;
    el.style.height = `${lanes.length * ROW}px`;
    const inset = 3, w = Math.max(4, step - 2 * inset);
    const edit = tagEditor();
    let html = '';
    lanes.forEach((lane, r) => {
      const top = r * ROW;
      const label = lane.label.length > 14 ? `${lane.label.slice(0, 13)}…` : lane.label;
      html += `<span class="flow-tg-l" style="top:${top}px;width:${L - 6}px" title="${esc(lane.label)}">${esc(label)}</span>`;
      const tempo = lane.key === 'tempo';
      const canEdit = edit && !tempo;
      const cells = tempo ? null : laneCells(lane, order);
      order.forEach((id, i) => {
        const pos = `left:${f1(L + i * step + inset)}px;top:${top}px;width:${f1(w)}px`;
        const who = `${i + 1}. ${titleName(st.byId.get(id), `File ${i + 1}`)}`;
        const ed = canEdit ? ` data-flow-tag="${esc(lane.key)}" role="button" tabindex="0" aria-haspopup="menu"` : '';
        if (tempo) {
          const f = st.byId.get(id);
          const bpm = f && drawable(f) && f.music ? (f.bm || f.bs || f.be) : null;
          if (!bpm) { html += `<span class="flow-tg flow-tg-empty" data-i="${i}" style="${pos}"></span>`; return; }
          const share = FlowChartMath.tempoShare(bpm);
          html += `<span class="flow-tg flow-tg-num" data-i="${i}" style="${pos}" title="${esc(`${who}: ${Math.round(bpm)} BPM`)}"><span>${Math.round(bpm)}</span><i><b style="width:${pct(share)}%;background:${esc(eColor(share))}"></b></i></span>`;
          return;
        }
        const tags = cells[i];
        if (!tags.length) {
          html += canEdit
            ? `<span class="flow-tg flow-tg-empty" data-i="${i}"${ed} style="${pos}" title="${esc(`${who}: add a ${lane.label} tag`)}" aria-label="${esc(`${titleName(st.byId.get(id), `File ${i + 1}`)}: add a ${lane.label} tag`)}">+ ${esc(lane.label)}</span>`
            : `<span class="flow-tg flow-tg-empty" data-i="${i}" style="${pos}"></span>`;
          return;
        }
        html += `<span class="flow-tg" data-i="${i}"${ed} style="${pos}"${canEdit ? ` aria-label="${esc(`${titleName(st.byId.get(id), `File ${i + 1}`)}, ${lane.label}: ${tags.map(t => t.label).join(', ')}`)}"` : ''}>${tags.map(t => `<span class="flow-tg-t" style="background:${esc(t.color)};color:${FlowChartMath.inkOn(t.color)}" title="${esc(`${who}: ${t.label}`)}">${esc(t.label)}</span>`).join('')}</span>`;
      });
    });
    // A cell with keyboard focus keeps it (polls redraw often).
    const f = document.activeElement;
    const had = f && el.contains && el.contains(f) && f.dataset && f.dataset.flowTag ? [f.dataset.flowTag, f.dataset.i] : null;
    el.innerHTML = html;
    if (had) el.querySelector(`[data-flow-tag="${had[0]}"][data-i="${had[1]}"]`)?.focus({ preventScroll: true });
  }

  /** Enter or Space on a tag cell opens its menu, as a click does. */
  function tagKey(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return false;
    const tg = e.target && e.target.closest && e.target.closest('[data-flow-tag]');
    const g = st.geom;
    if (!tg || !g || !tagEditor() || e.ctrlKey || e.metaKey || e.altKey) return false;
    const id = g.order[Number(tg.dataset.i)];
    if (id == null) return false;
    e.preventDefault();
    e.stopPropagation();
    StreamTags.blockMenu(tg, id);
    return true;
  }

  /* ── Preview cards (CARD_PX a column or wider) ──
     A 16:9 card under each column: the file's first hover frame (a picture
     that is not a video: its thumbnail), its length in the corner. Pointing
     at it (or at its column over the plot) scrubs the five frames, a thin
     bar showing where; leaving puts the first frame back. Cards are kept by
     id across draws (a drag redraws every frame), and only cards in view
     (or a column either side) ask for their picture. */

  const CARD_LOAD_PAD = 140;       // px either side of the view whose cards load too
  const CARD_KEEP_VIEWS = 3;       // views either side whose cards keep their picture (further: dropped)
  const cardEls = new Map();       // id -> card element
  let cardsHost = null;            // the .flow-cards those belong to
  let scrubbed = null;             // the card being scrubbed

  /** The length badge as the grid's tiles show it (cards.js tileDurationText): none for pictures or under 1 s. */
  function cardLen(id) {
    const r = libRow(id);
    if (!r) return '';
    if (typeof tileDurationText === 'function') return tileDurationText(r);
    const d = Number(r.duration_seconds) || 0;
    return r.media_type !== 'image' && d >= 1 && typeof formatDuration === 'function' ? formatDuration(d) : '';
  }

  /** A card's resting picture: the first hover frame, else the still, else ''. */
  function firstUrl(id) {
    const u = frameUrl(id, 0);
    if (u && !failed.has(u)) return u;
    const s = stillUrl(id);
    return s && !failed.has(s) ? s : '';
  }

  function setImg(el, url) {
    el._src = url;
    if (!url) { el._img.style.visibility = 'hidden'; el._img.removeAttribute('src'); return; }
    el._img.style.visibility = '';
    el._img.src = url;
  }

  function makeCard(id) {
    const el = document.createElement('div');
    el.className = 'flow-card';
    el.dataset.id = String(id);
    const im = document.createElement('img');
    im.alt = '';
    im.draggable = false;
    im.decoding = 'async';
    const len = document.createElement('i');
    len.className = 'flow-card-len';
    const bar = document.createElement('b');
    bar.className = 'flow-card-bar';
    el.append(im, len, bar);
    Object.assign(el, { _id: id, _img: im, _len: len, _bar: bar, _src: '', _want: null, _loaded: false, _scrub: false });
    // A frame that does not load: the next best picture (the still), or none.
    im.onerror = () => {
      if (el._src) failed.add(el._src);
      const next = el._scrub ? '' : firstUrl(id);
      if (!el._scrub) el._want = next;
      setImg(el, next && next !== el._src ? next : '');
    };
    return el;
  }

  function cardsRow(wrap, order, g) {
    const host = wrap.querySelector('.flow-cards');
    if (!host) return;
    if (host !== cardsHost) { cardEls.clear(); cardsHost = host; scrubbed = null; }
    if (!g) {
      if (!host.hidden || cardEls.size) { host.hidden = true; host.innerHTML = ''; cardEls.clear(); scrubbed = null; }
      return;
    }
    host.hidden = false;
    host.style.width = `${g.W}px`;
    host.style.height = `${g.h}px`;
    const w = FlowChartMath.cardWidth(g.step, g.h), h = g.h - 8;
    const seen = new Set();
    const add = [];
    order.forEach((id, i) => {
      seen.add(id);
      let el = cardEls.get(id);
      if (!el) { el = makeCard(id); cardEls.set(id, el); add.push(el); }
      const x = g.L + i * g.step + (g.step - w) / 2;
      el._x = x; el._w = w;
      el.dataset.i = String(i);
      el.style.left = `${f1(x)}px`;
      el.style.width = `${f1(w)}px`;
      el.style.height = `${h}px`;
      el.classList.toggle('sel', i === g.selI);
      el.classList.toggle('now', i === g.nowI);
      const want = firstUrl(id);
      if (want !== el._want) { el._want = want; el._loaded = false; }
      const len = cardLen(id);
      if (el._len.textContent !== len) el._len.textContent = len;
    });
    for (const [id, el] of cardEls) {
      if (seen.has(id)) continue;
      el.remove();
      cardEls.delete(id);
      if (scrubbed === el) scrubbed = null;
    }
    if (add.length) host.append(...add);
    cardsLoad();
  }

  /**
   * Cards in view (or near it) that have not asked for their picture yet ask
   * now; cards more than CARD_KEEP_VIEWS views away drop theirs (a big
   * collection in Zoom never holds thousands of pictures). Between the two
   * a picture stays, so scrolling back and forth or a redraw never flickers.
   */
  function cardsLoad() {
    const wrap = document.getElementById('flowChartWrap');
    if (!wrap || !cardEls.size) return;
    const left = wrap.scrollLeft, vw = wrap.clientWidth;
    const a = left - CARD_LOAD_PAD, b = left + vw + CARD_LOAD_PAD;
    const keep = Math.max(1200, vw * CARD_KEEP_VIEWS);
    for (const el of cardEls.values()) {
      if (el._scrub) continue;
      const x0 = el._x, x1 = el._x + el._w;
      if (el._loaded) {
        if (x1 < left - keep || x0 > left + vw + keep) { el._loaded = false; setImg(el, ''); }
        continue;
      }
      if (x1 < a || x0 > b) continue;
      el._loaded = true;
      if (el._src !== el._want) setImg(el, el._want);
    }
  }

  let cardsLoadQueued = false;
  function scheduleCardsLoad() {
    if (cardsLoadQueued || !cardEls.size) return;
    cardsLoadQueued = true;
    requestAnimationFrame(() => { cardsLoadQueued = false; cardsLoad(); });
  }

  /** Card i shows its frame at frac across the file, the bar at frac. */
  function scrubCard(i, frac) {
    const g = st.geom;
    const id = g ? g.order[i] : null;
    const el = id != null ? cardEls.get(id) : null;
    if (scrubbed && scrubbed !== el) unscrub();
    if (!el) return;
    const blur = thumbsBlurred();
    if (!blur) warmFrames(id);
    const p = blur ? { url: el._want } : pictureAt(id, frac);
    el._scrub = true;
    el._loaded = true;
    scrubbed = el;
    if (p.url && p.url !== el._src) setImg(el, p.url);
    el._bar.style.width = `${f1(Math.max(0, Math.min(1, frac)) * 100)}%`;
    hoverWatch();
  }

  /** The card scrubbed goes back to its first frame. */
  function unscrub() {
    const el = scrubbed;
    if (!el) return;
    scrubbed = null;
    hoverWatch();
    el._scrub = false;
    el._bar.style.width = '0';
    if (el._src !== el._want) setImg(el, el._want || '');
  }

  /* ── The hover card ── */

  let card = null;             // the element (on body, so repaints never touch it)
  const hov = { x: 0, y: 0, target: null, queued: false, key: '', w: 0, h: 0, src: '' };

  function cardEl() {
    if (card && card.isConnected) return card;
    card = document.createElement('div');
    card.className = 'flow-hcard';
    card.setAttribute('aria-hidden', 'true');
    card.hidden = true;
    document.body.appendChild(card);
    return card;
  }

  function hideCard() {
    hov.key = '';
    if (card && !card.hidden) card.hidden = true;
    hoverWatch();
  }

  /*
   * While something shows for the pointer (the hover card, a column lit, a
   * card scrubbed), a scroll anywhere (the page, the chart, an ancestor)
   * moves things from under it: all of it goes until the pointer moves
   * again. The listener is there only while something shows (passive,
   * capture: element scrolls do not bubble), so a library scroll with
   * nothing hovered costs Flow nothing.
   */
  let hoverWatched = false;
  function onHoverScroll() {
    if (drag && drag.on) return;
    hideCard();
    unscrub();
    if (st.hot >= 0) showHot(-1);
    hoverWatch();
  }
  function hoverWatch() {
    const on = !!((card && !card.hidden) || st.hot >= 0 || scrubbed);
    if (on === hoverWatched) return;
    hoverWatched = on;
    if (on) window.addEventListener('scroll', onHoverScroll, { capture: true, passive: true });
    else window.removeEventListener('scroll', onHoverScroll, { capture: true, passive: true });
  }

  /** Pointer moved over the chart: the hover card or a preview card's frame, next frame. */
  function hoverAt(e) {
    hov.x = e.clientX; hov.y = e.clientY; hov.target = e.target;
    if (hov.queued) return;
    hov.queued = true;
    requestAnimationFrame(hoverFrame);
  }

  /** What is under the pointer: chartHit, with the names and thumbnails rows counting as their column. */
  function hoverHit(x, y) {
    const g = st.geom;
    const svg = document.querySelector('#flowChartWrap svg');
    if (!g || !svg) return null;
    const r = svg.getBoundingClientRect();
    return FlowChartMath.chartHit(x - r.left, y - r.top, g, HAND_PX);
  }

  function hoverFrame() {
    hov.queued = false;
    if (!st.geom || !st.open || !isMine() || (drag && drag.on)) { hideCard(); unscrub(); return; }
    const hit = hoverHit(hov.x, hov.y);
    if (st.geom.cards) {
      // Preview cards under the chart: a column's preview is its card (scrubbed
      // by the pointer, on the card or over the column); the floating card is
      // left for hand-overs, so two previews never show at once.
      const cd = hov.target && hov.target.closest ? hov.target.closest('.flow-card') : null;
      if (cd && cd.dataset.i != null) {
        hideCard();
        const r = cd.getBoundingClientRect();
        const i = Number(cd.dataset.i);
        scrubCard(i, FlowChartMath.cardScrub(hov.x - r.left, r.width, durOf(st.geom.order[i])).frac);
        return;
      }
      if (hit && hit.kind === 'col') { hideCard(); scrubCard(hit.i, hit.frac); return; }
      unscrub();
    }
    if (!hit) { hideCard(); return; }
    paintCard(hit);
  }

  function chipsHtml(id) {
    const s = laneSource();
    if (!s || typeof s.chips !== 'function') return '';
    let c = [];
    try { c = s.chips(id) || []; } catch { c = []; }
    if (!Array.isArray(c) || !c.length) return '';
    return `<span class="flow-chips">${c.filter(t => t && t.label).map(t => `<span class="flow-chip" style="--c:${safeColor(t.color) || 'var(--text-secondary)'}">${esc(t.label)}</span>`).join('')}</span>`;
  }

  /** "3:54 · 128 BPM · energy 40 → 62 → 55", what is known of it. */
  function metaText(id) {
    const f = st.byId.get(id);
    const parts = [];
    const len = lenText(id);
    if (len) parts.push(len);
    if (!f || f.kind === 'other') parts.push('not a video or audio file');
    else if (f.failed) parts.push(f.reason ? `couldn’t be measured: ${f.reason}` : 'couldn’t be measured');
    else if (!f.measured) parts.push('not measured yet');
    else if (f.noSound) parts.push('no sound');
    else if (!f.music) parts.push(`no music · energy ${pct(f.em)}`);
    else parts.push(`${FlowOrder.bpmText(f)} BPM`, `energy ${pct(f.es)} → ${pct(f.em)} → ${pct(f.ee)}`);
    return parts.join(' · ');
  }

  function paintCard(hit) {
    const g = st.geom;
    const el = cardEl();
    let key;
    if (hit.kind === 'hand') {
      const a = g.order[hit.i], b = g.order[hit.i + 1];
      const h = g.hand && g.hand[hit.i];
      key = `h:${a}:${b}:${h ? h.grade : ''}`;
      if (key !== hov.key) {
        // Blurred thumbnails (pm-thumbs): no frame from inside a file, only its first.
        const out = frameUrl(a, thumbsBlurred() ? 0 : 4) || stillUrl(a), inn = frameUrl(b, 0) || stillUrl(b);
        const fa = st.byId.get(a), fb = st.byId.get(b);
        const graded = h && h.grade !== 'none';
        const why = graded ? `${FlowOrder.handoverText(fa, fb, h)}${skipNote(fa, fb)}` : 'Not graded: one side has no measured sound';
        el.innerHTML = `<div class="flow-hc-pair"><span class="flow-hc-img"><img alt="" draggable="false"${out ? ` src="${esc(out)}"` : ''}><i>End of ${hit.i + 1}</i></span><span class="flow-hc-img"><img alt="" draggable="false"${inn ? ` src="${esc(inn)}"` : ''}><i>Start of ${hit.i + 2}</i></span></div>
          <span class="flow-hc-t${graded ? ` flow-hc-${h.grade}` : ''}">${esc(graded ? GRADE_WORD[h.grade] : 'Hand-over')}: ${hit.i + 1} into ${hit.i + 2}</span>
          <span class="flow-hc-m"><span class="flow-pm-name">${esc(shortName(fa) || 'file')}</span> into <span class="flow-pm-name">${esc(shortName(fb) || 'file')}</span></span>
          <span class="flow-hc-m">${esc(why)}</span>`;
        el.querySelectorAll('img').forEach(im => { im.onerror = () => { im.style.visibility = 'hidden'; }; });
        hov.src = '';
      }
    } else {
      const id = g.order[hit.i];
      key = `c:${id}:${hit.i}`;
      warmFrames(id);
      const p = pictureAt(id, thumbsBlurred() ? 0 : hit.frac);
      if (key !== hov.key) {
        const f = st.byId.get(id);
        el.innerHTML = `<span class="flow-hc-img flow-hc-one"><img alt="" draggable="false"><i class="flow-hc-time"></i></span>
          <span class="flow-hc-t"><b>${hit.i + 1}.</b> <span class="flow-pm-name">${esc(shortName(f) || 'Untitled')}</span></span>
          <span class="flow-hc-m">${esc(metaText(id))}</span>${chipsHtml(id)}`;
        const im = el.querySelector('img');
        im.onerror = () => { im.style.visibility = 'hidden'; };
        hov.src = '';
      }
      const box = el.querySelector('.flow-hc-one');
      const im = box && box.querySelector('img');
      if (im && p.url && p.url !== hov.src) { hov.src = p.url; im.style.visibility = ''; im.src = p.url; }
      if (box) box.classList.toggle('flow-hc-noimg', !p.url);
      const tm = el.querySelector('.flow-hc-time');
      const d = durOf(id);
      if (tm) {
        const txt = d && typeof formatDuration === 'function' ? formatDuration(Math.max(1, Math.round(p.t))) : '';
        if (tm.textContent !== txt) tm.textContent = txt;
      }
    }
    if (key !== hov.key) {
      hov.key = key;
      el.hidden = false;
      hov.w = el.offsetWidth || 240;          // measured once a card, not on every move
      hov.h = el.offsetHeight || 180;
    }
    el.hidden = false;
    hoverWatch();
    // Beside the pointer, flipped to stay in the window.
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 720;
    let x = hov.x + 18, y = hov.y + 18;
    if (x + hov.w > vw - 8) x = hov.x - 18 - hov.w;
    if (y + hov.h > vh - 8) y = hov.y - 18 - hov.h;
    el.style.transform = `translate(${Math.round(Math.max(4, x))}px, ${Math.round(Math.max(4, y))}px)`;
  }

  /* ── The strip under the chart ── */

  /** A hand-over's grade and why, with both ends: "Smooth: energy steady, same tempo (energy 62 to 58, 120 BPM to 122 BPM)". */
  function handWhy(a, b) {
    const fa = st.byId.get(a), fb = st.byId.get(b);
    const h = drawable(fa) && drawable(fb) ? FlowOrder.handover(fa, fb) : null;
    if (!h || h.grade === 'none') return { grade: 'none', text: 'Not graded (one side has no measured sound)' };
    const word = GRADE_WORD[h.grade].replace(' hand-over', '');
    const bpm = (v) => (v ? `${Math.round(v)} BPM` : 'no tempo');
    const ends = `energy ${pct(fa.ee)} to ${pct(fb.es)}${fa.music && fb.music ? `, ${bpm(fa.be || fa.bm)} to ${bpm(fb.bs || fb.bm)}` : ''}`;
    return { grade: h.grade, short: `${word}: ${FlowOrder.handoverText(fa, fb, h)}`, text: `${word}: ${FlowOrder.handoverText(fa, fb, h)}${skipNote(fa, fb)} (${ends})` };
  }

  /** "In: Smooth: energy steady" (the whole why in its tooltip). */
  const handHtml = (label, h, none) => (h
    ? `<span class="flow-st-h flow-st-h-${h.grade}" title="${esc(h.text)}"><b>${label}:</b> ${esc(h.short || h.text)}</span>`
    : `<span class="flow-st-h flow-st-h-none"><b>${label}:</b> ${none}</span>`);
  const CLOSE_BTN = '<button type="button" class="flow-btn flow-btn-sm flow-st-x" data-flow-pick="-1" title="Close the details" aria-label="Close the details">✕</button>';

  function stripHtml() {
    const g = st.geom;
    const order = g ? g.order : chartOrder();
    const n = order.length;
    if (st.selHand >= 0 && st.selHand + 1 < n) {
      const i = st.selHand, a = order[i], b = order[i + 1];
      const w = handWhy(a, b);
      return `<span class="flow-st-k">Hand-over · ${i + 1} into ${i + 2} of ${n}</span>
        <span class="flow-st-name"><span class="flow-pm-name">${esc(shortName(st.byId.get(a)) || 'file')}</span> into <span class="flow-pm-name">${esc(shortName(st.byId.get(b)) || 'file')}</span></span>
        <span class="flow-st-h flow-st-h-${w.grade} flow-st-why" title="${esc(w.text)}">${esc(w.text)}</span>
        <span class="flow-st-acts"><button type="button" class="flow-btn flow-btn-sm" data-flow-pick="${i}">Show ${i + 1}</button><button type="button" class="flow-btn flow-btn-sm" data-flow-pick="${i + 1}">Show ${i + 2}</button>${CLOSE_BTN}</span>`;
    }
    const i = st.sel != null ? order.indexOf(st.sel) : -1;
    if (i < 0) return '<span class="flow-sub flow-st-hint">Click a file to see it here, or a hand-over to see why. Double-click a file to play it.</span>';
    const id = order[i];
    const f = st.byId.get(id);
    const hin = i > 0 ? handWhy(order[i - 1], id) : null;
    const hout = i + 1 < n ? handWhy(id, order[i + 1]) : null;
    const play = stageOpen() ? 'Play on Stage' : 'Play';
    const inColl = typeof openPlainCollection === 'function' ? !!openPlainCollection() : true;
    return `<span class="flow-st-k">Selected · ${i + 1} of ${n}</span>
      <span class="flow-st-name flow-pm-name" title="${esc(titleName(f, 'Untitled'))}">${esc(shortName(f) || 'Untitled')}</span>
      <span class="flow-sub">${esc(metaText(id))}</span>
      ${handHtml('In', hin, 'First in the order')}
      ${handHtml('Out', hout, 'Last in the order')}
      <span class="flow-st-acts">
        <button type="button" class="flow-btn flow-btn-sm" data-flow-act="preview" title="${stageOpen() ? 'Show it in the preview pane, never on Stage' : 'Show it in the preview pane or its details'}">Preview</button>
        <button type="button" class="flow-btn flow-btn-sm" data-flow-act="play">${play}</button>
        <button type="button" class="flow-btn flow-btn-sm" data-flow-act="reveal" title="Scroll the list below to this file">Show in list</button>
        ${typeof upNextAddFrom === 'function' ? '<button type="button" class="flow-btn flow-btn-sm" data-flow-act="next" title="Play it after the file playing now">Play next</button>' : ''}
        ${inColl ? '<button type="button" class="flow-btn flow-btn-sm" data-flow-act="remove" title="Remove from this collection">Remove</button>' : ''}
        ${CLOSE_BTN}
      </span>`;
  }

  function paintStrip() {
    const el = document.getElementById('flowStrip');
    if (!el) return;
    el.innerHTML = stripHtml();
  }

  /** The strip's buttons, for the file picked. */
  async function stripAct(act) {
    const id = st.sel;
    if (id == null) return;
    if (act === 'preview') {
      if (typeof stagePreviewClick === 'function' && stagePreviewClick(id)) return;
      if (typeof dockSelectFromClick === 'function' && dockSelectFromClick(id)) return;
      if (typeof showDetailsById === 'function') showDetailsById(id);
    } else if (act === 'play') {
      playHere(id);
    } else if (act === 'reveal') {
      revealFile(id);
    } else if (act === 'next') {
      if (typeof upNextAddFrom === 'function') upNextAddFrom(id, 'next', 'library');
    } else if (act === 'remove') {
      await removeOne(id);
    }
  }

  /**
   * Play from the chart: on Stage when it is open (as a tile's double click);
   * otherwise videos and sound go to the mini player, so the panel stays in
   * view (the full player would cover it). Other files open in the player.
   */
  function playHere(id) {
    if (typeof playMediaById !== 'function') return;
    const m = typeof getMediaById === 'function' ? getMediaById(id) : libRow(id);
    const av = m && (m.media_type === 'video' || m.media_type === 'audio');
    if (stageOpen() || !av || typeof playMedia !== 'function') { playMediaById(id); return; }
    const mini = typeof currentMediaState !== 'undefined' && currentMediaState && currentMediaState.miniMode === true;
    if (mini) { playMedia({ id: m.id, filepath: m.filepath, filename: m.filename, media_type: m.media_type }, { stayMini: true }); return; }
    playMediaById(id);
    if (typeof minimizePlayer === 'function') minimizePlayer();
  }

  /** Remove from this collection, with the selection bar's Undo (collections.js). */
  async function removeOne(id) {
    const c = typeof openPlainCollection === 'function' ? openPlainCollection() : null;
    if (!c || typeof changeCollectionMembership !== 'function') return;
    const order = ((typeof collectionMembers !== 'undefined' && collectionMembers.get(c.id)) || []).slice();
    const f = st.byId.get(id);
    const ok = await changeCollectionMembership(c.id, [id], false, { quiet: true });
    if (!ok) return;
    const guard = typeof collectionUndoGuard === 'function' ? collectionUndoGuard(c.id) : undefined;
    if (st.sel === id) { st.sel = null; paintStrip(); }
    // selection.js showUndoToast takes HTML: the names are escaped.
    const msg = namesHidden() ? `Removed this file from ${esc(c.name)}` : `Removed “${esc(shortName(f) || 'file')}” from ${esc(c.name)}`;
    if (typeof showUndoToast === 'function' && typeof undoRemoveFromCollection === 'function') showUndoToast(msg, () => undoRemoveFromCollection(c.id, [id], order, guard));
  }

  /** Pick column i (or none) for the strip. */
  function pick(i) {
    const g = st.geom;
    st.selHand = -1;
    st.sel = g && i >= 0 && i < g.n ? g.order[i] : null;
    paintStrip();
    drawChart();
  }

  function pickHand(i) {
    st.selHand = i;
    paintStrip();
    drawChart();
  }

  let lastClick = { id: null, at: 0 };
  /** A click on the chart: a tag cell opens its menu, a hand-over explains itself, a column is picked, twice plays. */
  function chartClick(e) {
    const g = st.geom;
    if (!g) return;
    // A tag lane's cell: the stream tag menu for that file (the preview pane's + Tag).
    const tg = e.target && e.target.closest && e.target.closest('[data-flow-tag]');
    if (tg && tagEditor()) {
      lastClick = { id: null, at: 0 };
      const id = g.order[Number(tg.dataset.i)];
      if (id != null) StreamTags.blockMenu(tg, id);
      return;
    }
    const nm = e.target && e.target.closest && e.target.closest('.flow-nm, .flow-card');
    const hit = nm ? { kind: 'col', i: Number(nm.dataset.i) } : hoverHit(e.clientX, e.clientY);
    if (!hit || !(hit.i >= 0)) return;
    if (hit.kind === 'hand') { lastClick = { id: null, at: 0 }; pickHand(hit.i); return; }
    const id = g.order[hit.i];
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (lastClick.id === id && t - lastClick.at < DBL_MS) {
      lastClick = { id: null, at: 0 };
      playHere(id);
      return;
    }
    lastClick = { id, at: t };
    pick(hit.i);
  }

  /* The cards' length badges and frames need each file's row (its length
     and kind): rows the page has not loaded yet are asked for once a list of
     the collection's files (a new list, files added or taken out, asks again;
     a drag's preview order or a reorder of the same files does not). */
  let rowsAsked = null;
  function fetchMissingRows(order) {
    if (typeof Library === 'undefined' || typeof Library.fetchRows !== 'function') return;
    const members = (typeof collectionMembers !== 'undefined' && collectionMembers.get(st.cid)) || (st.data && st.data.features);
    if (members === rowsAsked) return;
    rowsAsked = members;
    const missing = [];
    for (const id of order) {
      if (missing.length >= 3000) break;
      if (!libRow(id)) missing.push(id);
    }
    if (missing.length) Library.fetchRows(missing).then(() => { if (st.open && isMine()) { paintStrip(); scheduleDraw(); } }, () => {});
  }

  /** Zoom while something plays: keep it in view, until the user scrolls themselves (till the next file). */
  let followId = null;
  function follow() {
    if (ph.src && ph.src.id !== followId) { followId = ph.src.id; st.follow = true; }
    if (!st.zoom || !st.follow || !st.geom || !ph.src || ph.paused) return;
    const wrap = document.getElementById('flowChartWrap');
    const g = st.geom;
    const i = g.order.indexOf(ph.src.id);
    if (!wrap || i < 0 || g.W <= wrap.clientWidth) return;
    const to = FlowChartMath.followScroll(g.L + i * g.step, g.L + (i + 1) * g.step, wrap.scrollLeft, wrap.clientWidth);
    if (to == null) return;
    setScroll(wrap, to);
  }

  function setScroll(wrap, left) {
    wrap.scrollLeft = left;
    st.autoLeft = wrap.scrollLeft;
  }

  /**
   * The wrap's own listeners (once a wrap): a scroll by the user stops
   * following. The user's: one soon after their wheel, press or key on the
   * chart (the browser also moves the scroll itself, keeping it inside a
   * chart whose view just got a little wider, which is not theirs). A
   * plain up/down wheel over a chart wider than its view scrolls it sideways,
   * and stays with it at either end (the page never starts moving instead).
   */
  const USER_SCROLL_MS = 1500;

  /** How far a wheel moves the chart sideways, or 0 to leave it to the page. */
  function wheelSideways(e, wrap) {
    if (e.ctrlKey || e.shiftKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return 0;
    const room = wrap.scrollWidth - wrap.clientWidth;
    if (!(room > 1)) return 0;
    const dx = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? wrap.clientWidth : 1);
    return dx || 0;
  }
  let userAt = -Infinity;
  function wireWrap(wrap) {
    if (!wrap || wrap._flowWired) return;
    wrap._flowWired = true;
    const intent = () => { userAt = performance.now(); };
    for (const t of ['pointerdown', 'keydown']) wrap.addEventListener(t, intent, { passive: true });
    wrap.addEventListener('wheel', (e) => {
      intent();
      const dx = wheelSideways(e, wrap);
      if (!dx) return;
      e.preventDefault();
      wrap.scrollLeft += dx;
    }, { passive: false });
    wrap.addEventListener('scroll', () => {
      // Flow's own scrolls set autoLeft first.
      if (Math.abs(wrap.scrollLeft - st.autoLeft) > 2 && performance.now() - userAt < USER_SCROLL_MS) st.follow = false;
      // The chart moved under the pointer: the card, the scrub and the lit column wait for the next pointer move.
      if (!(drag && drag.on)) { hideCard(); unscrub(); if (st.hot >= 0) showHot(-1); }
      // Preview cards scrolled into view load their pictures (next frame).
      scheduleCardsLoad();
    }, { passive: true });
  }

  /* ── Dragging near an edge in Zoom scrolls sideways (DragAutoScroll's maths) ── */
  const edge = { raf: 0, x: 0, last: 0 };
  function edgeSpeed(wrap) {
    if (typeof DragAutoScroll === 'undefined') return 0;
    const r = wrap.getBoundingClientRect();
    return DragAutoScroll.speed(edge.x, r.left, r.right, { band: 60 });
  }
  function maybeEdge(clientX) {
    edge.x = clientX;
    if (!st.zoom || edge.raf) return;
    const wrap = document.getElementById('flowChartWrap');
    if (!wrap || wrap.scrollWidth <= wrap.clientWidth || !edgeSpeed(wrap)) return;
    edge.last = performance.now();
    edge.raf = requestAnimationFrame(edgeFrame);
  }
  function edgeFrame(now) {
    edge.raf = 0;
    const wrap = document.getElementById('flowChartWrap');
    if (!drag || !drag.on || !wrap) return;
    const sp = edgeSpeed(wrap);
    if (!sp) return;
    const max = wrap.scrollWidth - wrap.clientWidth;
    const next = FlowChartMath.scrollStep(wrap.scrollLeft, sp, now - edge.last, max);
    edge.last = now;
    if (Math.round(next) !== Math.round(wrap.scrollLeft)) {
      setScroll(wrap, next);
      st.follow = false;
      dragAt(edge.x);
    }
    // On while the pointer stays in the band, until the chart's end in that direction.
    if (sp > 0 ? next < max : next > 0) edge.raf = requestAnimationFrame(edgeFrame);
  }
  function stopEdge() { if (edge.raf) { cancelAnimationFrame(edge.raf); edge.raf = 0; } }

  /* ── Tiles ──────────────────────────────────────────────────────── */

  function tileHtml(media) {
    if (!st.open || !isMine() || !media) return '';
    const f = st.byId.get(media.id);
    if (!f) return '';
    let dot = '';
    if (typeof Library !== 'undefined') {
      const i = Library.indexOf(media.id);
      const prev = i > 0 ? st.byId.get(Library.idAt(i - 1)) : null;
      if (prev) {
        const h = FlowOrder.handover(prev, f);
        const g = h.grade;
        if (g !== 'none') dot = `<span class="flow-join flow-join-${g}" title="${esc(`${g === 'jump' ? 'A jump' : g === 'noticeable' ? 'A noticeable change' : 'A smooth hand-over'} from the file before. ${FlowOrder.handoverText(prev, f, h)}`)}"></span>`;
      }
    }
    let body;
    if (f.kind === 'other') body = '';
    else if (f.failed) body = `<span class="flow-tile-note"${f.reason ? ` title="${esc(`Couldn’t be measured: ${f.reason}`)}"` : ''}>couldn’t measure</span>`;
    else if (!f.measured) body = '<span class="flow-tile-note">not measured yet</span>';
    else if (!f.music) body = '<span class="flow-tile-note">no music</span>';
    else {
      const bars = [f.es, f.em, f.ee].map(v => `<b style="height:${Math.max(2, Math.round(v * 12))}px;background:${eColor(v)}"></b>`).join('');
      body = `<span class="flow-ebar" title="Energy at the start, middle and end">${bars}</span><span>${esc(FlowOrder.bpmText(f))} BPM</span>`;
    }
    if (!body && !dot) return '';
    return `<div class="tile-flow">${dot}${body}</div>`;
  }

  /* ── Flow shuffle ───────────────────────────────────────────────── */

  /**
   * Ignore calm intros and credits changed (nothing is measured): what Flow
   * holds is out of date, open or not. The open panel asks again at once;
   * otherwise the answer is dropped, so Flow shuffle and the next open ask
   * afresh. The playlist order is not touched.
   */
  function settingsChanged() {
    if (st.cid == null) return null;
    if (!isMine()) { reset(); return null; }
    if (st.open) return refetch(true);
    st.data = null;
    st.byId = new Map();
    st.lastCount = -1;
    return null;
  }

  /** Files left or came: the saved orders are read again (their own skips are kept to the files there are). */
  function savedStale(cid) {
    if (st.cid != null && cid === st.cid && st.savedCid === cid && savedList().length) loadSaved(cid);
  }

  const customKey = (c) => (c ? `${c.mode}|${c.shape}|${c.waves}|${c.places}|${c.rev}` : '');

  /**
   * Which of Custom and the shapes is lit now, from an order write's answer
   * (here, or a drag: collection-reorder.js _installOrder), or (read: true)
   * from the collection read again (collections.js takeCollectionAnswer: the
   * library check after a change in another window, which may have moved no
   * file at all). A read is drawn at once when it changed anything; one
   * landing while a write of this page is on its way is left out (the
   * write's own answer is newer).
   */
  function customAnswer(cid, data, { read = false } = {}) {
    if (cid !== st.cid || !data || data.flow_custom === undefined) return;
    if (read && writing) return;
    const changed = customKey(st.custom) !== customKey(data.flow_custom);
    st.custom = data.flow_custom;
    const adopted = !inPick && adoptLit();
    if (!read || !changed || !st.open || !isMine()) return;
    paint();
    if (adopted) refetch(true);
  }

  /**
   * The collection's order or files were read again from the server
   * (collections.js takeCollectionAnswer: a change in another window, the
   * library check): the lit button is drawn from it at once, and what the
   * server keeps for Custom is read again (another window may have picked a
   * shape or Custom).
   */
  function orderSynced(cid) {
    if (!st.open || !isMine() || cid !== st.cid) return;
    paint();
    refetch(true);
  }

  /**
   * The collection's playlist order or its files changed on the server (a
   * drag or Alt+arrows in playlist order, Undo, files added or taken out:
   * collection-reorder.js, collections.js, importer.js, and the shapes and
   * saved orders here). The open panel's chart, jumps, counts, lit shape and
   * chips follow at once: a pure reorder is drawn straight from the page's
   * copy, then the server is asked (as a poll does: the chart is kept, no
   * flicker). Panel closed: the held answer is dropped (Flow shuffle and the
   * next open ask afresh), nothing is fetched.
   */
  function membersChanged(cid) {
    if (st.cid == null || cid !== st.cid) return null;
    if (!isMine()) { reset(); return null; }
    savedStale(cid);
    if (!st.open) {
      st.data = null;
      st.byId = new Map();
      st.lastCount = -1;
      return null;
    }
    const m = typeof collectionMembers !== 'undefined' ? collectionMembers.get(cid) : null;
    const d = st.data;
    if (d && Array.isArray(m) && m.length === d.playlistOrder.length) {
      const had = new Set(d.playlistOrder);
      if (m.every(id => had.has(id)) && !m.every((id, i) => id === d.playlistOrder[i])) {
        st.data = { ...d, playlistOrder: m.slice(), playlistJumps: FlowOrder.summary(d.features, m).jumps };
      }
    }
    // Files came or went: the chart waits for the answer below; the shape and chips light from the page's copy now.
    paint();
    return refetch(true);
  }

  async function shuffleCollection(cid) {
    let on = false;
    try { on = !!(await api('/api/stage/settings')).flowShuffle; } catch { return false; }
    if (!on) return false;
    let data = st.cid === cid && st.data ? st.data : null;
    if (!data) { try { data = await api(`/api/flow/collections/${cid}?shape=smooth`); } catch { return false; } }
    if (!data.features.some(f => f.measured && f.music)) return false;
    const order = FlowOrder.flowShuffle(data.features);
    return Library.shuffle(order);
  }

  /* ── The Stage bar's line ───────────────────────────────────────── */

  const textCache = new Map();
  let stageGen = 0;
  async function stageCurrent(row) {
    const id = row && row.id;
    // The chart marks the file playing now.
    if ((id || null) !== st.nowId) {
      st.nowId = id || null;
      if (st.open && isMine() && st.geom) scheduleDraw();
    }
    const bar = typeof StageBar !== 'undefined' ? StageBar : null;
    if (!bar || typeof bar.setFlowText !== 'function') return;
    const my = ++stageGen;
    if (!id || !['video', 'audio'].includes(row.media_type)) { bar.setFlowText(''); return; }
    let text = textCache.get(id);
    if (text === undefined) {
      const f = st.byId.get(id);
      if (f && f.measured) text = FlowOrder.flowText(f);
      else {
        try { text = (await api(`/api/flow/media/${id}`)).text || ''; } catch { text = ''; }
      }
      if (text) textCache.set(id, text);
    }
    if (my === stageGen) bar.setFlowText(text || '');
  }

  /* ── Leaving the collection ─────────────────────────────────────── */

  /** The grid's files changed (a search or filter, or its id list came in): the chart follows. */
  function gridChanged() {
    if (!st.open || !isMine() || !st.data || !st.geom || dragOrder()) return;
    const want = chartOrder(), had = st.geom.order;
    if (want.length !== had.length || want.some((id, i) => id !== had[i])) schedulePaint();
  }
  window.addEventListener('vault:results-counted', gridChanged);

  window.addEventListener('vault:results-changed', () => {
    gridChanged();
    if (st.cid != null && st.cid !== activeId()) reset();
    else renderHeaderButton();
    scheduleMarks();
  });
  // The skips changed: a saved order's chip lights or lets go (savedLit).
  window.addEventListener('vault:skips-changed', (e) => {
    if (st.open && isMine() && e && e.detail && e.detail.cid === st.cid && savedList().length) schedulePaint();
  });
  forgetOldOrders();
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startMarks);
  else setTimeout(startMarks, 0);

  // A stream tag changed (player-lib/stream-tags.js, loaded after this file):
  // a Place may have, so the open panel asks again.
  const watchTags = () => {
    if (typeof StreamTags === 'undefined') return;
    StreamTags.onChange(() => { if (st.open && isMine() && st.data) refetch(true); });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchTags);
  else setTimeout(watchTags, 0);

  return {
    toggle, close, pickShape, pickWaves, pickPlaces, pickCustom, refetch,
    tileHtml, shuffleCollection, stageCurrent,
    /** The shape picked, whether the playlist order is still exactly it (its button lit), and whether Custom is lit instead. */
    shape: () => ({ shape: st.shape, waves: st.waves, places: placesOn(), lit: shapeLit(), custom: customLit() }),
    isOpen: () => st.open && isMine(),
    // The chart (tests): clicks, picks, the strip, Fit / Zoom.
    _view: {
      click: chartClick, pick, pickHand, strip: stripHtml, act: stripAct, play: playHere,
      // The preview cards: what each shows, loading what is in view, scrubbing.
      cards: () => [...cardEls.values()].map(el => ({ id: el._id, i: Number(el.dataset.i), src: el._src, loaded: !!el._loaded, bar: el._bar.style.width, len: el._len.textContent })),
      cardsLoad, scrub: scrubCard, unscrub, tagKey, follow,
      zoom: (on) => setZoom(!!on),
      hot: showHot,
      state: () => ({ zoom: st.zoom, sel: st.sel, selHand: st.selHand, follow: st.follow, hot: st.hot }),
      order: () => chartOrder().slice(), guide, summary: summaryText,
    },
    // Saved orders (the chips; tests drive them here as the clicks do).
    saved: {
      load: loadSaved, use: useSaved, save: saveNamed, rename: renameSaved, update: updateSaved, remove: deleteSaved,
      list: () => savedList().slice(), active: () => (savedNow() ? savedNow().id : null), html: savedHtml,
    },
    settingsChanged, membersChanged, savedStale, orderSynced, customAnswer,
    marksFor, marksKey: (id) => marksSig(marksFor(id)),
    // Column drags (tests): the press, the moves, the drop.
    _drag: { allowed: dragAllowed, down: dragDown, move: dragMove, drop: dropDrag, cancel: cancelDrag, state: () => drag },
    _state: () => ({ ...st, byId: st.byId.size, data: st.data && { order: st.data.order, counts: st.data.counts, jumps: st.data.jumps, playlistOrder: st.data.playlistOrder, playlistJumps: st.data.playlistJumps } }),
  };
})();

window.Flow = Flow;

/* Hooks (see the header). */
function flowButtonHtml(c) {
  if (!c || c.kind === 'folder') return '';
  const on = Flow.isOpen();
  const icon = typeof vaultIcon === 'function' ? vaultIcon('wave', 'modern-only vi-gap') : '';
  return `<button class="coll-action coll-flow${on ? ' on' : ''}" id="collFlowBtn" aria-pressed="${on}" onclick="Flow.toggle(${c.id})" title="${flowButtonTitle(on)}">${icon}Flow <span class="flow-chev" aria-hidden="true">${on ? '▴' : '▾'}</span></button>`;
}
function flowButtonTitle(open) { return open ? 'Hide the Flow panel' : 'Show the Flow panel'; }
function flowTileHtml(media) { return Flow.tileHtml(media); }
function flowShuffleCollection(id) { return Flow.shuffleCollection(id); }
function flowStageCurrent(row) { Flow.stageCurrent(row); }
function flowSettingsChanged() { return Flow.settingsChanged(); }
function flowMembersChanged(cid) { return Flow.membersChanged(cid); }
function flowSavedStale(cid) { return Flow.savedStale(cid); }
function flowOrderSynced(cid) { return Flow.orderSynced(cid); }
function flowCustomAnswer(cid, data, opts) { return Flow.customAnswer(cid, data, opts); }
/**
 * The flow an Undo of an order write sends (POST /api/collections/:id/order,
 * lib/flow/custom.js): the row from before it, over the row it left (rev),
 * or undefined when the write changed nothing the server keeps.
 */
/** The toast for an Undo refused because another window changed the order since (409 STALE). */
const STALE_UNDO_TEXT = 'This order was changed in another window, so there was nothing to undo.';
/**
 * The flow an Undo of an order write sends: flowUndoOf when the write
 * changed the row, else the row as it is now, unchanged ({ restore: row,
 * rev: its rev }, or { restore: null, rev: null } for no row). The server
 * refuses the Undo as a whole when the row is no longer that one, so an
 * order never goes back under a mode that does not describe it.
 * undefined: an answer from a server that says nothing about the row.
 */
function flowGuardOf(data) {
  if (!data || data.flow_custom === undefined) return undefined;
  return flowUndoOf(data) || flowKeepOf(data.flow_custom);
}
/** The row unchanged, as an Undo's check: { restore: row | null, rev }. */
function flowKeepOf(row) {
  return row
    ? { restore: { mode: row.mode, shape: row.shape, waves: row.waves, places: row.places, kept: row.kept, rev: row.rev }, rev: row.rev }
    : { restore: null, rev: null };
}
function flowUndoOf(data) {
  const was = (data && data.flow_custom_was) || null, now = (data && data.flow_custom) || null;
  if (!was && !now) return undefined;
  if (was && now && was.rev === now.rev) return undefined;
  return {
    restore: was ? { mode: was.mode, shape: was.shape, waves: was.waves, places: was.places, kept: was.kept, rev: was.rev } : null,
    rev: now ? now.rev : null,
  };
}
/** The marks a table row shows after its name (table-view.js works out the chips' room around them). */
function flowMarksFor(id) { return Flow.marksFor(id); }
function flowMarksKey(id) { return Flow.marksKey(id); }
