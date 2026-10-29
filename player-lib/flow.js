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

   Playlist order / Flow order: Flow order is a play order you switch to. The
   grid (and so Play all, Play on Stage and Up next's "the list carries on")
   follows it: the library query gets the order as rankedIds (filters.js
   currentQuerySpec), so a search or filter still applies on top. "Save as
   playlist order" writes it with POST /api/collections/:id/order, with Undo.

   Place tagged files (On / Off, shown once a file in the collection has a
   stream tag with a Place, on by default then): Flow order puts those files
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
   (flowSettingsChanged, settingsChanged): a Flow order the grid shows is
   asked for and applied again, Flow shuffle asks afresh.

   Hooks other files call (guarded with typeof):
     flowButtonHtml(c)            collections.js renderCollectionHeader
     flowTileHtml(media)          cards.js renderTile
     flowQueryRanked()            filters.js currentQuerySpec
     flowOrderOn()                collection-reorder.js reorderBlockedReason
     flowLeaveOrder()             collection-reorder.js switchToPlaylistOrder
     flowCountText()              collections.js collectionCountText
     flowShuffleCollection(id)    collections.js playCollection (Shuffle)
     flowWorkingOrder()           collection-reorder.js (drags in Flow order)
     flowMoveInOrder(ids, before) collection-reorder.js reorderMove
     flowOrderBarHtml()           collection-reorder.js renderReorderNote (the order bar)
     flowStageCurrent(row)        stage-control.js setCurrent
     flowSettingsChanged()        stage-settings-ui.js (Ignore calm intros and credits)
     flowMembersChanged(cid)      collection-reorder.js, collections.js, importer.js (order or files changed)

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
    order: false,       // Flow order is what the grid shows
    shape: DEFAULT_SHAPE,
    data: null,         // GET /api/flow/collections/:id
    byId: new Map(),    // id -> features
    status: null,       // GET /api/flow/status
    pollTimer: null,
    lastCount: -1,
    lastFetch: 0,
    fetching: false,
    appliedOrder: null, // the order last handed to the query
    places: null,       // Place tagged files: true / false as picked, null = on when any file has a placed tag
    hot: -1,            // the chart column under the pointer
    geom: null,         // the chart as last drawn (columns, range) for hover and click
    drawnW: 0,
    nowId: null,        // the file Stage is playing (stageCurrent)
    lanePrefs: null,    // which lane rows show (localStorage)
    hookedSource: null, // the FlowLaneSource whose onChange we listen to
    flashTimer: null,
    membersRef: null,   // the collection's member list last worked from (watchMembers)
    edited: null,       // the working Flow order after drags (ids), or null: as worked out
    zoom: false,        // Zoom (wide columns, sideways scroll) or Fit (localStorage, see zoomPref)
    sel: null,          // the file picked (id), shown in the strip
    selHand: -1,        // the hand-over picked (file i into i + 1), or -1
    follow: true,       // Zoom: keep the playing file in view (until the user scrolls)
    autoLeft: 0,        // the sideways scroll Flow itself last set (anything else is the user's)
    tilesKey: null,     // what the grid's tiles were last drawn from (tilesKeyNow)
  };

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const panel = () => document.getElementById('flowPanel');
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
    st.cid = null; st.open = false; st.order = false; st.data = null; st.byId = new Map();
    st.status = null; st.lastCount = -1; st.appliedOrder = null; st.fetchFails = 0; st.toasted = false;
    st.showWhy = false; st.lastMoved = null;
    // Each collection starts from the default shape (or its remembered one,
    // restore / toggle): never the shape picked on the one before.
    st.shape = DEFAULT_SHAPE;
    st.places = null;
    st.edited = null;
    st.membersRef = null;
    st.sel = null; st.selHand = -1;
    st.follow = true;
    session++;
    paint();
  }

  async function toggle(cid) {
    phStart();
    if (st.open && st.cid === cid) { close(); return; }
    if (st.cid !== cid) {
      reset();
      // Opened before the grid's first answer could restore it (a quick
      // click after opening the collection): take the remembered order now.
      const m = recalled(cid);
      if (m) adopt(m);
    }
    st.cid = cid;
    st.open = true;
    st.follow = true;
    // The tiles show Flow's marks while it is open: the next answer draws the grid.
    st.tilesKey = null;
    paint();
    renderHeaderButton();
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

  /** Show on the order bar: open the panel and put focus on its Hide button. */
  function showFromBar() {
    const p = toggle(st.cid);
    panel()?.querySelector('[data-flow-hide]')?.focus({ preventScroll: true });
    return p;
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
    // The order bar shows Show and a sparkline only while the panel is closed.
    if (typeof renderReorderNote === 'function') renderReorderNote();
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

  async function fetchOnce() {
    st.fetching = true;
    const cid = st.cid;
    try {
      const data = await api(`/api/flow/collections/${cid}?shape=${encodeURIComponent(st.shape)}&places=${placesOn() ? 1 : 0}`);
      if (cid !== st.cid) return;
      st.data = data;
      if (typeof collectionMembers !== 'undefined' && collectionMembers.get(cid)) st.membersRef = collectionMembers.get(cid);
      if (st.edited) {
        const kept = reconcile(st.edited, data.order);
        const same = kept.length === st.edited.length && kept.every((id, i) => id === st.edited[i]);
        st.edited = kept;
        if (!same) remember();
      }
      // Asked before the answer said which files have a placed tag: ask again.
      if (placesOn() !== !!data.placesOn) again = true;
      st.byId = new Map(data.features.map(f => [f.id, f]));
      st.lastFetch = Date.now();
      st.lastCount = countKey(data.counts);
      st.fetchFails = 0;
      if (st.order) await applyOrder();
    } catch (err) {
      // Counted as a fetch all the same (so a poll does not ask again at once),
      // backing off, and said once, not on every try.
      st.lastFetch = Date.now();
      st.fetchFails = (st.fetchFails || 0) + 1;
      if (err.status === 413 && st.status && st.status.collection) st.status.collection.tooMany = true;
      if (err.status !== 423 && !st.toasted) { st.toasted = true; toastErr(err, 'working out Flow order'); }
    } finally {
      st.fetching = false;
    }
    paint();
    if (typeof renderReorderNote === 'function') renderReorderNote();
    // The open panel's tiles show what Flow measured. The grid is drawn again
    // only for the first answer after opening (every tile gains its Flow row,
    // so its rows are measured again) and when the order it shows changed
    // (applyOrder, through applyFilters). A measurement landing while the
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

  /* ── Order ──────────────────────────────────────────────────────── */

  /** The order the grid shows, as rankedIds (null: not in Flow order). */
  function queryRanked() {
    if (!st.order || !isMine() || !st.appliedOrder) return null;
    const n = st.appliedOrder.length;
    return st.appliedOrder.map((id, i) => ({ id, score: n - i }));
  }

  async function applyOrder() {
    if (!st.data) return;
    const next = workingOrder();
    if (st.appliedOrder && st.appliedOrder.length === next.length && st.appliedOrder.every((id, i) => id === next[i])) return;
    st.appliedOrder = next.slice();
    if (typeof applyFilters === 'function') await applyFilters({ keepPage: true });
    if (typeof renderReorderNote === 'function') renderReorderNote();
  }

  async function useFlowOrder() {
    if (!isMine()) return;
    st.order = true;
    remember();
    if (!st.data) await refetch(true);
    st.appliedOrder = null;
    await applyOrder();
    paint();
  }

  async function usePlaylistOrder() {
    if (!st.order) return;
    leave();
    paint();
    if (typeof switchToPlaylistOrder === 'function') await switchToPlaylistOrder();
    else if (typeof applyFilters === 'function') await applyFilters({ keepPage: true });
  }

  async function pickShape(shape) {
    if (!FlowOrder.isShape(shape)) return;
    const dropped = st.order ? st.edited : null, prevShape = st.shape, prevPlaces = st.places;
    session++;
    st.shape = shape;
    st.order = true;
    st.edited = null;
    remember();
    paint();
    await refetch(true);
    st.appliedOrder = null;
    await applyOrder();
    paint();
    offerUndoEdits(dropped, prevShape, prevPlaces, `Worked out ${FlowOrder.shapeLabel(shape)} afresh`);
  }

  async function pickPlaces(on) {
    const dropped = st.order ? st.edited : null, prevShape = st.shape, prevPlaces = st.places;
    session++;
    st.places = !!on;
    st.order = true;
    st.edited = null;
    remember();
    paint();
    await refetch(true);
    st.appliedOrder = null;
    await applyOrder();
    paint();
    offerUndoEdits(dropped, prevShape, prevPlaces, `Place tagged files is ${on ? 'on' : 'off'} now`);
  }

  /** The Place tagged files switch: only for a collection with placed tags (or once used). */
  function placesHtml() {
    if (st.places == null && !hasPlaced()) return '';
    const on = placesOn();
    return `<span class="flow-opt"><span class="flow-seg-label">Place tagged files</span>
        <span class="flow-seg" role="group" aria-label="Place tagged files" title="Files with a stream tag that has a Place (Opener, Closer...) go where it says">
          <button type="button" data-flow-places="1" aria-pressed="${String(on)}">On</button>
          <button type="button" data-flow-places="0" aria-pressed="${String(!on)}">Off</button>
        </span></span>`;
  }

  /** The collection's files now, from the server (the page's copy can be behind). */
  async function freshMembers(cid) {
    if (typeof fetchCollectionMembers === 'function') {
      try { return (await fetchCollectionMembers(cid, true)).slice(); } catch {}
    }
    return (typeof collectionMembers !== 'undefined' && collectionMembers.get(cid)) || null;
  }

  /**
   * Write an order as the playlist order, kept to the files the collection
   * has right now (a file added or removed since is never a stale list). A
   * 400 (the members changed on the way): ask again, keep to them, try once more.
   */
  async function saveMembersOrder(cid, order) {
    const attempt = async () => {
      const members = await freshMembers(cid);
      const list = members ? reconcile(order, members) : order.slice();
      const saved = await post(`/api/collections/${cid}/order`, { order: list });
      // The page's copy of the playlist order (rearranging reads it).
      if (typeof collectionMembers !== 'undefined') collectionMembers.set(cid, Array.isArray(saved.order) ? saved.order : list);
      return saved;
    };
    try { return await attempt(); } catch (err) {
      if (err && err.status === 400) return attempt();
      throw err;
    }
  }

  async function saveOrder() {
    if (!st.data || !isMine()) return;
    const cid = st.cid;
    const before = st.data.playlistOrder.slice();
    try {
      await saveMembersOrder(cid, workingOrder());
    } catch (err) { toastErr(err, 'saving the order'); return; }
    leave();
    await refetch(true);
    if (typeof switchToPlaylistOrder === 'function') await switchToPlaylistOrder();
    const undo = async () => {
      try {
        await saveMembersOrder(cid, before);
        if (cid === st.cid) await refetch(true);
        if (typeof applyFilters === 'function') await applyFilters({ keepPage: true });
        if (typeof showToast === 'function') showToast('Playlist order put back');
      } catch (err) { toastErr(err, 'putting the order back'); }
    };
    if (typeof showUndoToast === 'function') showUndoToast('Saved as the playlist order', undo);
    else if (typeof showToast === 'function') showToast('Saved as the playlist order');
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

  /* ── The working Flow order: edits, the bar, remembering ────────────
     While Flow order shows, dragging tiles (or Alt+arrows,
     collection-reorder.js) edits the working order here, in memory: the
     bar says "edited", the chart, hand-overs and jumps follow it, and
     nothing is saved until Save as playlist order. Back to playlist order
     drops it; picking a shape (or Place tagged files) again works the order
     out afresh and drops the edits, with Undo.

     Remembered per collection on this computer (localStorage
     vault.flow.order.<id>: { shape, places, edited }): while the key is
     there, opening the collection (or reloading) shows Flow order again.
     Going back, saving or shuffling removes it. An edited order is kept
     valid when files come or go: gone ones dropped, new ones at the end. */

  const MEM_PREFIX = 'vault.flow.order.';

  /** The order Flow order shows: the edited one, or the one worked out. */
  function workingOrder() {
    if (!st.data) return [];
    return st.edited || st.data.order;
  }

  /** The edited order kept to the collection's files (gone dropped, new at the end). */
  const reconcile = (edited, base) => FlowOrder.reconcileOrder(edited, base);

  /*
   * A Flow session: bumped when Flow order is left (Back, Save, Shuffle), the
   * collection changes, or the order is worked out afresh. An Undo made in
   * one session does nothing in another (or in another collection).
   */
  let session = 0;
  const sessionNow = () => ({ cid: st.cid, gen: session });
  const sameSession = (s) => s.cid === st.cid && s.gen === session && st.order && isMine();

  let sumMemo = { edited: null, data: null, value: null };
  /** Hand-overs and jumps of what Flow order shows now. */
  function orderSummary() {
    const d = st.data;
    if (!d) return { handovers: [], jumps: 0 };
    if (!st.edited) return { handovers: d.handovers, jumps: d.jumps };
    if (sumMemo.edited !== st.edited || sumMemo.data !== d) sumMemo = { edited: st.edited, data: d, value: FlowOrder.summary(d.features, st.edited) };
    return sumMemo.value;
  }

  function remember() {
    if (st.cid == null) return;
    try {
      if (!st.order) localStorage.removeItem(MEM_PREFIX + st.cid);
      else localStorage.setItem(MEM_PREFIX + st.cid, JSON.stringify({ shape: st.shape, places: st.places, edited: st.edited }));
    } catch {}
  }

  /** The remembered Flow order for a collection, or null (one that is not valid is removed). */
  function recalled(cid) {
    let text = null;
    try { text = localStorage.getItem(MEM_PREFIX + cid); } catch { return null; }
    if (text == null) return null;
    const v = FlowOrder.parseRemembered(text);
    if (!v) { try { localStorage.removeItem(MEM_PREFIX + cid); } catch {} }
    return v;
  }

  /** Show a remembered Flow order (recalled) for st.cid: its shape, its switch and its edits. */
  function adopt(m) {
    st.shape = m.shape;
    st.places = m.places;
    st.edited = m.edited;
    st.order = true;
    st.appliedOrder = null;
  }

  /** The collection just opened: show Flow order again if it was showing. */
  let restoring = null;
  async function restore(cid) {
    const m = recalled(cid);
    if (!m || restoring === cid) return;
    restoring = cid;
    try {
      if (st.cid !== cid) reset();
      st.cid = cid;
      adopt(m);
      await refetch(true);
    } finally {
      restoring = null;
    }
  }

  /** Leave Flow order (Back, Save, Shuffle...): edits dropped, nothing remembered. */
  function leave() {
    session++;
    st.order = false;
    st.appliedOrder = null;
    st.edited = null;
    remember();
  }

  /**
   * A drag or Alt+arrows in Flow order: move `ids` to sit before `before`
   * (null: the end) in the working order. In memory only, with Undo.
   * @returns {Promise<boolean>} whether the order changed
   */
  async function moveInOrder(ids, before) {
    if (!st.order || !st.data || !isMine()) return false;
    const prev = workingOrder().slice();
    const prevEdited = st.edited;
    const next = FlowOrder.moveBlock(prev, ids, before);
    if (!next) return false;
    const moving = new Set(ids);
    const block = next.filter(id => moving.has(id));
    const made = sessionNow();
    st.edited = next;
    remember();
    await applyOrder();
    paint();
    if (typeof renderReorderNote === 'function') renderReorderNote();
    const n = next.indexOf(block[0]) + 1;
    const f = st.byId.get(block[0]);
    // selection.js showUndoToast takes HTML: the name is escaped.
    const msg = block.length === 1
      ? (namesHidden() ? `Moved this file to position ${n} in Flow order` : `Moved “${esc(shortName(f) || 'file')}” to position ${n} in Flow order`)
      : `Moved ${block.length} files to position ${n} in Flow order`;
    const undo = async () => {
      if (!sameSession(made) || !st.data) return;      // another collection, or Flow order left since
      st.edited = prevEdited ? reconcile(prevEdited, st.data.order) : null;
      remember();
      await applyOrder();
      paint();
      if (typeof renderReorderNote === 'function') renderReorderNote();
    };
    if (typeof showUndoToast === 'function') showUndoToast(msg, undo);
    return true;
  }

  /** Picking a shape or Place tagged files again dropped the edits: Undo puts them (and the old pick) back. */
  function offerUndoEdits(dropped, prevShape, prevPlaces, what) {
    if (!dropped || typeof showUndoToast !== 'function') return;
    const made = sessionNow();
    showUndoToast(`${what}, so your moves in Flow order were dropped`, async () => {
      if (!sameSession(made)) return;                  // Back, Save, another collection or another pick since
      st.shape = prevShape;
      st.places = prevPlaces;
      st.order = true;
      await refetch(true);
      if (!st.data) return;
      if (!sameSession(made)) return;
      st.edited = reconcile(dropped, st.data.order);
      st.appliedOrder = null;
      remember();
      await applyOrder();
      paint();
      if (typeof renderReorderNote === 'function') renderReorderNote();
    });
  }

  /** The order bar over the grid while Flow order shows (collection-reorder.js renderReorderNote). */
  function orderBarHtml() {
    if (!st.order || !isMine()) return '';
    const name = `${FlowOrder.shapeLabel(st.shape)}${st.edited ? ', edited' : ''}`;
    let status = 'Not saved';
    const d = st.data;
    if (d && d.counts && d.counts.music >= 2) status += ` · ${plural(orderSummary().jumps, 'jump', 'jumps')}, was ${d.playlistJumps.toLocaleString()}`;
    const closed = !st.open;
    const spark = closed ? sparkHtml() : '';
    return `<span class="flow-ob-pill">Flow order: ${esc(name)}</span>
      <span class="flow-ob-status">${esc(status)}</span>
      <span class="flow-ob-count" data-flow-count>${esc(orderCountText())}</span>
      ${spark || '<span class="flow-sp"></span>'}
      <button type="button" class="flow-btn flow-btn-sm" onclick="Flow.usePlaylistOrder()">Back to playlist order</button>
      <button type="button" class="flow-btn flow-btn-sm flow-ob-save" onclick="Flow.saveOrder()">Save as playlist order</button>
      ${closed ? `<button type="button" class="flow-btn flow-btn-sm flow-ob-show" onclick="Flow.showFromBar()" title="Show the Flow panel">Show ▾</button>` : ''}`;
  }

  /**
   * The order bar's count (player-lib/stage-count.js): "Track 12 of 40 ·
   * 2:14:30 left" while Stage plays this collection (StageControl.countFor),
   * else "40 files · 2:41:05": the files in the order and their lengths
   * added up (videos and sound; pictures have none here), "about" when some
   * are not known yet. Rows not loaded are fetched once, then it is drawn
   * again. Over StageCount.TIME_CAP files: the number only.
   */
  let countRowsKey = '';
  function orderCountText() {
    if (typeof StageCount === 'undefined' || typeof Library === 'undefined') return '';
    const onStage = typeof StageControl !== 'undefined' && StageControl.countFor ? StageControl.countFor(st.cid) : null;
    if (onStage) return onStage;
    const n = Library.length();
    if (!Library.known() || n > StageCount.TIME_CAP) return StageCount.listText(n, null);
    let secs = 0, unknown = 0, timed = 0;
    const missing = [];
    for (let i = 0; i < n; i++) {
      const r = Library.rowAt(i);
      if (!r) { missing.push(Library.idAt(i)); unknown++; continue; }
      if (r.media_type !== 'video' && r.media_type !== 'audio') continue;
      timed++;
      if (Number(r.duration_seconds) > 0) secs += Number(r.duration_seconds); else unknown++;
    }
    if (missing.length) {
      const key = `${st.cid}|${n}|${missing.length}`;
      if (key !== countRowsKey) {
        countRowsKey = key;
        Library.fetchRows(missing).then(paintCount, () => {});
      }
    }
    if (!timed && !missing.length) return StageCount.listText(n, null);
    if (unknown * 2 > Math.max(1, timed + missing.length)) return StageCount.listText(n, null);
    return StageCount.listText(n, Math.round(secs), unknown > 0);
  }

  /** Draw the order bar's count again (each second while Stage plays, stage-control.js paint). */
  function paintCount() {
    const els = document.querySelectorAll('[data-flow-count]');
    if (!els.length) return;
    const text = orderCountText();
    for (const el of els) if (el.textContent !== text) el.textContent = text;
  }

  /** The order bar's sparkline: the working order's middle energies (decoration only). */
  const SPARK_W = 300, SPARK_H = 24;
  function sparkHtml() {
    if (!st.data) return '';
    const vals = workingOrder().map((id) => {
      const f = st.byId.get(id);
      return drawable(f) && f.music ? f.em : null;
    });
    const d = FlowChartMath.sparkPath(vals, SPARK_W, SPARK_H);
    if (!d) return '';
    return `<span class="flow-ob-spark" aria-hidden="true"><svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" focusable="false"><path d="${d}"/></svg></span>`;
  }

  /* ── Tile marks ─────────────────────────────────────────────────────
     On the open collection's tiles and table rows, in every order: a
     "Playing" mark and a thin progress line on the file playing (the same
     clock as the playhead), and "Next" on the file the list plays next
     (Up next's own tag already marks its files). While Flow order shows,
     a file whose place changed shows its position and the old one faint
     ("3 · was 7"). Painted onto whatever the grid drew (a watch on the
     grid, and a check every PH_TICK_MS), so cards.js and table-view.js
     need nothing; only the progress line's width changes between paints. */

  function nextFrom(playing) {
    if (typeof Library === 'undefined') return null;
    const upNext = typeof UpNext !== 'undefined' && UpNext.count() > 0 ? UpNext.ids() : [];
    return FlowOrder.nextAfter(playing, { upNext, indexOf: (id) => Library.indexOf(id), idAt: (i) => Library.idAt(i) });
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
    const flowOn = !!(st.order && isMine() && st.data && st.appliedOrder);
    return { src, playing, next: nx && !nx.upNext ? nx.id : null, flowOn };
  }

  /* The marks as they are now, looked at once per task (a table draws many
     rows in one go and asks for each: flowMarksFor). The position maps are
     kept while the orders are the same arrays (an order is replaced, never
     changed in place). */
  let marksMemo = null;
  let posMemo = { w: null, p: null, pos: null, was: null };
  function marksNow() {
    if (marksMemo) return marksMemo;
    const s = marksState();
    let pos = null, was = null;
    if (s.flowOn) {
      const w = workingOrder(), p = st.data.playlistOrder;
      if (posMemo.w !== w || posMemo.p !== p) {
        posMemo = { w, p, pos: new Map(w.map((id, i) => [id, i])), was: new Map(p.map((id, i) => [id, i])) };
      }
      pos = posMemo.pos;
      was = posMemo.was;
    }
    marksMemo = { s, pos, was };
    Promise.resolve().then(() => { marksMemo = null; });
    return marksMemo;
  }

  /** The marks a file shows: { pos: '3 · was 7' or null, playing, next }, or null for none. */
  function marksFor(id) {
    const { s, pos, was } = marksNow();
    const moved = pos && pos.has(id) && was.has(id) && pos.get(id) !== was.get(id);
    const out = { pos: moved ? `${pos.get(id) + 1} · was ${was.get(id) + 1}` : null, playing: id === s.playing, next: id !== s.playing && id === s.next };
    return out.pos || out.playing || out.next ? out : null;
  }
  const marksSig = (m) => (m ? `${m.pos || ''}|${m.playing ? 'p' : ''}${m.next ? 'n' : ''}` : '');

  function paintMarks() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    marksMemo = null;
    const { s, pos, was } = marksNow();
    marksKey = `${s.playing}|${s.next}|${s.flowOn ? workingOrder().length + ':' + (st.edited ? 'e' : '') + st.shape : ''}`;
    // Nothing to mark and nothing marked: the grid's own redraws (a scroll
    // through a long list draws rows) cost no walk over the tiles.
    const any = s.playing != null || s.next != null || !!pos;
    if (!any && !marksOn) return;
    marksOn = any;
    const refit = [];
    for (const tile of grid.querySelectorAll('.media-tile[data-id]')) {
      const id = Number(tile.dataset.id);
      let html = '';
      if (pos && pos.has(id) && was.has(id) && pos.get(id) !== was.get(id)) {
        html += `<span class="flow-mk-pos" title="Position ${pos.get(id) + 1} in Flow order, ${was.get(id) + 1} in the playlist order">${pos.get(id) + 1}<s> · was ${was.get(id) + 1}</s></span>`;
      }
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

  /** Every PH_TICK_MS: repaint the marks when what plays (or the order) changed, else move the progress line. */
  /*
   * The collection's files changed while Flow order shows (added, removed,
   * the picker, Import...: every change puts a new list in collectionMembers):
   * keep the edited order to them and work Flow order out again, panel open
   * or not, so a new file shows and Save never sends a stale list.
   */
  function watchMembers() {
    if (!st.order || !isMine() || typeof collectionMembers === 'undefined') return;
    const m = collectionMembers.get(st.cid);
    if (!m || m === st.membersRef) return;
    const first = st.membersRef == null;
    st.membersRef = m;
    if (first) return;
    if (st.edited) { st.edited = reconcile(st.edited, m); remember(); }
    refetch(true);
  }

  function marksTick() {
    watchMembers();
    if (document.hidden) return;
    const s = marksState();
    const key = `${s.playing}|${s.next}|${s.flowOn ? workingOrder().length + ':' + (st.edited ? 'e' : '') + st.shape : ''}`;
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
       - Flow order with a shape: the target as a dashed curve;
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
    return d ? (st.order ? workingOrder() : d.playlistOrder) : [];
  }

  /** The dashed guide: the picked shape's targets in Flow order (edited or not), else null. */
  function guide() {
    return st.order && st.data ? FlowOrder.guideTargets(st.shape, st.data) : null;
  }

  function chartHandovers(order) {
    const d = st.data;
    // A column being dragged: the hand-overs of the order it would make, graded live.
    if (dragOrder()) return FlowOrder.summary(d.features, order).handovers;
    return st.order ? orderSummary().handovers : FlowOrder.summary(d.features, order).handovers;
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
    // The target (Flow order with a shape).
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

    const label = `Energy across the ${st.order ? 'Flow' : 'playlist'} order, ${pct(lo)} to ${pct(hi)}`;
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
    const key = `${ph.src.id}|${g.order.length}|${g.W}|${g.lo}|${g.hi}|${st.order}`;
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
     order, or an unsaved Flow order), a file's column in the chart (or its
     name) can be dragged too. A press only becomes a drag once the pointer
     has moved FlowChartMath.DRAG_THRESHOLD px, so a click still shows the
     file below. While dragging, the chart is drawn as it would be with the
     file moved (its hand-overs graded live), a faded column follows the
     pointer, a line marks where it lands and a label says "Move to 4 of 12";
     in a big collection (one thin line) only the line and the label. Escape,
     pointercancel or losing the pointer cancels. The drop is the grid's own
     move (collection-reorder.js reorderMove: saved with Undo in playlist
     order, part of the try in Flow order); the chart keeps the new order
     drawn until the move is in. Nothing scrolls on the drop: the view stays
     where it was and only the chart and the list's contents change. The pointer is captured on the panel, which every repaint
     keeps (the chart's own host is moved during one). */

  let drag = null;   // { pointerId, x0, y0, from, id, order, on, slot, x, preview, hold }
  let dragClicked = false;

  /** Can a column be dragged now? Exactly when the grid would take a move, in the order the chart shows. */
  function dragAllowed() {
    if (!st.open || !isMine() || !st.geom || !st.data) return false;
    if (typeof reorderReady !== 'function' || !reorderReady()) return false;
    if (typeof _reorderBusy !== 'undefined' && _reorderBusy) return false;
    const flowShown = !!(st.order && st.appliedOrder);
    return flowShown === !!st.order;
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
    const jumps = st.order ? orderSummary().jumps : d.playlistJumps;
    if (d.counts.music < 2) return '';
    return jumps ? `${plural(jumps, 'jump', 'jumps')} between files` : 'Every hand-over is smooth or close';
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
      : a?.matches?.('#flowPanel [data-flow-pick]') ? `[data-flow-pick="${a.dataset.flowPick}"]` : null;
    const keepFocus = act || KEEP_FOCUS.find(sel => a?.matches?.(`#flowPanel ${sel}`));
    const shapes = FlowOrder.SHAPES.map(s => `<button type="button" data-flow-shape="${s.key}" aria-pressed="${String(st.order && st.shape === s.key)}">${esc(s.label)}</button>`).join('');
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
    el.innerHTML = `
      <div class="flow-row">
        <span class="flow-title">Flow</span>
        ${progressHtml()}
        <span class="flow-seg" role="group" aria-label="Order">
          <button type="button" data-flow-order="playlist" aria-pressed="${String(!st.order)}">Playlist order</button>
          <button type="button" data-flow-order="flow" aria-pressed="${String(st.order)}">Flow order</button>
        </span>
        <span class="flow-sp"></span>
        ${placesHtml()}
        <span class="flow-opt"><span class="flow-seg-label">Shape</span>
        <span class="flow-seg flow-shapes" role="group" aria-label="Shape">${shapes}</span></span>
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
        ${st.order && st.data ? '<button type="button" class="flow-btn" data-flow-save>Save as playlist order</button>' : ''}
      </div>`;
    const slot = el.querySelector('#flowChartSlot');
    if (slot && keep) slot.replaceWith(keep);
    st.geom = null;
    drawChart();
    paintStrip();
    // Put back the sideways scroll the repaint took (the wrap was out of the page).
    const w = document.getElementById('flowChartWrap');
    if (w && keepLeft) setScroll(w, keepLeft);
    if (keepFocus) el.querySelector(keepFocus)?.focus({ preventScroll: true });
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
      const o = e.target.closest('[data-flow-order]');
      if (o) { if (o.dataset.flowOrder === 'flow') useFlowOrder(); else usePlaylistOrder(); return; }
      const q = e.target.closest('[data-flow-q]');
      if (q) { queueAct(q.dataset.flowQ); return; }
      if (e.target.closest('[data-flow-why]')) { st.showWhy = !st.showWhy; paint(); return; }
      const pl = e.target.closest('[data-flow-places]');
      if (pl) { pickPlaces(pl.dataset.flowPlaces === '1'); return; }
      const ln = e.target.closest('[data-flow-lane]');
      if (ln) { toggleLane(ln.dataset.flowLane); return; }
      if (e.target.closest('[data-flow-save]')) { saveOrder(); return; }
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
    if (st.sel === id) { st.sel = null; paintStrip(); }
    // selection.js showUndoToast takes HTML: the names are escaped.
    const msg = namesHidden() ? `Removed this file from ${esc(c.name)}` : `Removed “${esc(shortName(f) || 'file')}” from ${esc(c.name)}`;
    if (typeof showUndoToast === 'function' && typeof undoRemoveFromCollection === 'function') showUndoToast(msg, () => undoRemoveFromCollection(c.id, [id], order));
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
   * holds is out of date, open or not. The open panel, or a Flow order the
   * grid shows, asks again at once (the order is applied anew); otherwise
   * the answer is dropped, so Flow shuffle and the next open ask afresh. A
   * Flow order kept for a collection that is not open now is forgotten here
   * and restored (and asked for) when that collection opens again.
   */
  function settingsChanged() {
    if (st.cid == null) return null;
    if (!isMine()) { reset(); return null; }
    if (st.open || st.order) return refetch(true);
    st.data = null;
    st.byId = new Map();
    st.lastCount = -1;
    return null;
  }

  /**
   * The collection's playlist order or its files changed on the server (a
   * drag or Alt+arrows in playlist order, Undo, files added or taken out:
   * collection-reorder.js, collections.js, importer.js). The open panel's
   * chart, jumps and counts, and a Flow order the grid shows, follow at
   * once: a pure reorder is drawn straight from the page's copy, then the
   * server is asked (as a poll does: the chart is kept, no flicker). Panel
   * closed and no Flow order: the held answer is dropped (Flow shuffle and
   * the next open ask afresh), nothing is fetched.
   */
  function membersChanged(cid) {
    if (st.cid == null || cid !== st.cid) return null;
    if (!isMine()) { reset(); return null; }
    if (!st.open && !st.order) {
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
        paint();
        if (typeof renderReorderNote === 'function') renderReorderNote();
      }
    }
    return refetch(true);
  }

  async function shuffleCollection(cid) {
    // Any shuffle (Flow shuffle or not) leaves Flow order, and forgets it.
    if (st.order && st.cid === cid) { leave(); paint(); }
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

  window.addEventListener('vault:results-changed', () => {
    if (st.cid != null && st.cid !== activeId()) reset();
    else renderHeaderButton();
    // A collection that was showing Flow order when it was left (or the page reloaded): show it again.
    const cid = activeId();
    if (cid != null && st.cid == null && recalled(cid)) restore(cid);
    scheduleMarks();
  });
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
    toggle, close, pickShape, showFromBar, useFlowOrder, usePlaylistOrder, saveOrder, refetch,
    tileHtml, queryRanked, shuffleCollection, stageCurrent,
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
    },
    orderOn: () => st.order && isMine() && !!st.appliedOrder,
    countText: () => (st.order && isMine() && st.appliedOrder ? `Flow order: ${FlowOrder.shapeLabel(st.shape).toLowerCase()}${st.edited ? ', edited' : ''}` : null),
    leaveOrder: () => { if (st.order) { leave(); paint(); } },
    workingOrder: () => (st.order && isMine() ? workingOrder().slice() : null),
    moveInOrder, orderBarHtml, paintCount,
    settingsChanged, membersChanged,
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
function flowQueryRanked() { return Flow.queryRanked(); }
function flowOrderOn() { return Flow.orderOn(); }
function flowLeaveOrder() { Flow.leaveOrder(); }
function flowCountText() { return Flow.countText(); }
function flowShuffleCollection(id) { return Flow.shuffleCollection(id); }
function flowWorkingOrder() { return Flow.workingOrder(); }
function flowMoveInOrder(ids, before) { return Flow.moveInOrder(ids, before); }
function flowOrderBarHtml() { return Flow.orderBarHtml(); }
function flowStageCurrent(row) { Flow.stageCurrent(row); }
function flowSettingsChanged() { return Flow.settingsChanged(); }
function flowMembersChanged(cid) { return Flow.membersChanged(cid); }
/** The marks a table row shows after its name (table-view.js works out the chips' room around them). */
function flowMarksFor(id) { return Flow.marksFor(id); }
function flowMarksKey(id) { return Flow.marksKey(id); }
