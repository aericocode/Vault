/* =========================================================================
   FLOW - order a collection so each file flows into the next.

   The Flow… button in the collection bar opens this panel above the files.
   Opening it asks the server to measure the collection's music (tempo,
   energy and loudness at each file's start, middle and end; lib/flow/), and
   shows the energy across the order, the shape you pick, and how many
   hand-overs between files are jumps. The chart (see "The chart" below) is
   drawn at the panel's real width, with lane rows (Tempo, and stream tag
   lanes from window.FlowLaneSource when it exists) and the files' names;
   clicking a column scrolls the list to that file.

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
    // Each collection starts from the default shape (or its remembered one,
    // restore / toggle): never the shape picked on the one before.
    st.shape = DEFAULT_SHAPE;
    st.places = null;
    st.edited = null;
    st.membersRef = null;
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
    if (typeof renderResults === 'function') renderResults();
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
    if (st.open && typeof renderResults === 'function') renderResults();
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
    // Measuring, or updating measurements (stale: measured by an older method).
    const active = (c.left > 0 || c.stale > 0) && st.status.queue.state !== 'idle';
    if (count !== st.lastCount) await refetch(!active);
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
      else st.status = await post(`/api/flow/${act === 'pause' ? 'pause' : 'resume'}`, {});
    } catch (err) { toastErr(err, act === 'pause' ? 'pausing' : 'measuring for Flow'); }
    if (act !== 'pause') {
      try { st.status = await api(`/api/flow/status?collection=${st.cid}`); } catch {}
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
      ? `Moved “${esc(shortName(f) || 'file')}” to position ${n} in Flow order`
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
      ${spark || '<span class="flow-sp"></span>'}
      <button type="button" class="flow-btn flow-btn-sm" onclick="Flow.usePlaylistOrder()">Back to playlist order</button>
      <button type="button" class="flow-btn flow-btn-sm flow-ob-save" onclick="Flow.saveOrder()">Save as playlist order</button>
      ${closed ? `<button type="button" class="flow-btn flow-btn-sm flow-ob-show" onclick="Flow.showFromBar()" title="Show the Flow panel">Show ▾</button>` : ''}`;
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

  function paintMarks() {
    const grid = document.getElementById('resultsGrid');
    if (!grid) return;
    const s = marksState();
    let pos = null, was = null;
    if (s.flowOn) {
      pos = new Map(workingOrder().map((id, i) => [id, i]));
      was = new Map(st.data.playlistOrder.map((id, i) => [id, i]));
    }
    marksKey = `${s.playing}|${s.next}|${s.flowOn ? workingOrder().length + ':' + (st.edited ? 'e' : '') + st.shape : ''}`;
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
    const parts = [];
    if (c.measurable === 0) {
      parts.push('<span class="flow-sub">No videos or audio here to measure</span>');
    } else if ((c.left > 0 || c.stale > 0) && q && q.state !== 'idle') {
      // Measuring, or (everything measured by an older method) adding the chart's detail.
      const again = !(c.left > 0);
      const wait = q.reason === 'paused' ? 'Paused'
        : q.reason === 'stage' ? 'Waiting while Stage plays'
        : q.reason === 'locked' ? 'Waiting: Vault is locked'
        : null;
      const why = again ? (wait ? `${wait}: updating measurements,` : 'Updating measurements:') : (wait || 'Measuring');
      const n = again ? c.measured - c.stale : done;
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
    if (c.failed > 0) {
      parts.push(`<span class="flow-sub flow-failed">${plural(c.failed, 'file', 'files')} couldn’t be measured</span>`);
    }
    if (c.kept > 0) {
      parts.push(`<span class="flow-sub">${plural(c.kept, 'file', 'files')} kept ${c.kept === 1 ? 'its' : 'their'} older measurements (couldn’t measure again)</span>`);
    }
    if ((c.failed > 0 || c.kept > 0) && !(q && q.state !== 'idle')) parts.push('<button type="button" class="flow-btn flow-btn-sm" data-flow-q="retry">Try again</button>');
    return parts.join('');
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
       - lane rows under the plot (Tempo, and tag lanes from FlowLaneSource);
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
  const handTitle = (h, fa, fb, i) => `${GRADE_WORD[h.grade]}: ${shortName(fa) || `file ${i + 1}`} into ${shortName(fb) || `file ${i + 2}`}. ${FlowOrder.handoverText(fa, fb, h)}`;
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  const pct = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100);
  /** What the chart calls a file: the library's title, or the file name without its extension. */
  const shortName = (f) => (f && f.title) || String((f && f.name) || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  /** Drawn as a line: measured, with sound (no audio stream, or silent: nothing). */
  const drawable = (f) => !!(f && f.measured && !f.failed && !f.noSound);

  function chartOrder() {
    const d = st.data;
    return d ? (st.order ? workingOrder() : d.playlistOrder) : [];
  }

  /** The dashed guide: the picked shape's targets in Flow order (edited or not), else null. */
  function guide() {
    return st.order && st.data ? FlowOrder.guideTargets(st.shape, st.data) : null;
  }

  function chartHandovers(order) {
    const d = st.data;
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
         chips(mediaId: number): Array<{ color: string, label: string }>, // all of a file's stream tags (for the tooltip)
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
            svg += `<rect x="${f1(x0 + j * (sw + gapX))}" y="${ry}" width="${f1(Math.max(0.5, sw))}" height="8" rx="${f1(Math.min(4, sw / 2))}" fill="${esc(t.color)}"><title>${esc(`${i + 1}. ${shortName(st.byId.get(order[i]))}: ${t.label}`)}</title></rect>`;
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
        <div class="flow-names"></div>
        <div class="flow-tip" hidden></div>
      </div>`;
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
    const W = Math.max(200, Math.floor(wrap.clientWidth));
    st.drawnW = wrap.clientWidth;
    const order = chartOrder();
    const n = order.length;
    if (!n) return;
    const lanes = allLanes().filter(l => laneOn(l.key));
    const longest = lanes.reduce((m, l) => Math.max(m, Math.min(14, l.label.length)), 3);
    const L = Math.round(Math.max(30, Math.min(96, longest * 5.6 + 10)));
    const R = 8, TOP = 16;
    const PH = chartH || defaultChartH(W);
    const laneY = TOP + PH + 10;
    const H = laneY + lanes.length * LANE_ROW + (lanes.length ? 0 : -6);
    const step = (W - L - R) / n;
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
        const path = FlowChartMath.monotonePath(pts);
        lines += `<path d="${path}"/>`;
        fills += `<path d="${path} L${f1(x1)},${base} L${f1(x0)},${base} Z"/>`;
      }
    }
    if (fills) svg += `<g class="flow-fill" mask="url(#flowFade)">${fills}</g>`;
    if (quiet) svg += `<g class="flow-quiet">${quiet}</g>`;
    if (lines) svg += `<g class="flow-line${dense ? ' flow-line-dense' : ''}">${lines}</g>`;

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
      svg += `<path class="flow-hand flow-hand-${h.grade}" d="M${f1(a[0])},${f1(a[1])} C${f1(a[0] + c)},${f1(a[1])} ${f1(b[0] - c)},${f1(b[1])} ${f1(b[0])},${f1(b[1])}"><title>${title}</title></path>`;
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

    if (lanes.length) svg += lanesSvg(lanes, order, { L, step, laneY, dense });
    // The playhead (moved by phPlace only; hidden until something of this order plays).
    svg += `<g class="flow-playhead" visibility="hidden" pointer-events="none"><line class="flow-ph-line" x1="0" x2="0" y1="0" y2="${H}"/><circle class="flow-ph-glow" r="8"/><circle class="flow-ph-dot" r="4"/></g>`;

    const label = `Energy across the ${st.order ? 'Flow' : 'playlist'} order, ${pct(lo)} to ${pct(hi)}`;
    wrap.querySelector('.flow-chart-svg').innerHTML = `<svg class="flow-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`;
    st.geom = { W, H, L, R, TOP, PH, step, n, order, dense, lo, hi, hand, gap, y };
    namesRow(wrap, order, { L, step, dense, nowI });
    if (st.hot >= n) st.hot = -1;
    showHot(st.hot);
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
  function phTick() {
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

  function namesRow(wrap, order, { L, step, dense, nowI }) {
    const el = wrap.querySelector('.flow-names');
    if (dense) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const named = step >= NAMES_PX;
    const every = named ? 1 : Math.max(1, Math.ceil(NUM_PX / step));
    let html = '';
    for (let i = 0; i < order.length; i++) {
      if (i % every && i !== nowI) continue;
      const f = st.byId.get(order[i]);
      const name = shortName(f);
      const w = named ? step : Math.max(step, NUM_PX);
      const left = named ? L + i * step : L + (i + 0.5) * step - w / 2;
      html += `<span class="flow-nm${i === nowI ? ' now' : ''}${named ? '' : ' num'}" data-i="${i}" style="left:${f1(left)}px;width:${f1(w)}px" title="${esc(`${i + 1}. ${name}${i === nowI ? ' (playing now)' : ''}`)}"><b>${i + 1}</b>${named ? esc(name) : ''}</span>`;
    }
    el.innerHTML = html;
  }

  /** Highlight column i (or none) and show its tooltip. */
  function showHot(i) {
    st.hot = i;
    const wrap = document.getElementById('flowChartWrap');
    const g = st.geom;
    if (!wrap || !g) return;
    const col = wrap.querySelector('.flow-col-hot');
    const tip = wrap.querySelector('.flow-tip');
    wrap.querySelectorAll('.flow-nm.hot').forEach(x => x.classList.remove('hot'));
    if (i < 0 || i >= g.n) {
      if (col) col.setAttribute('visibility', 'hidden');
      tip.hidden = true;
      return;
    }
    if (col) {
      col.setAttribute('x', f1(g.L + i * g.step));
      col.setAttribute('width', f1(Math.max(2, g.step)));
      col.setAttribute('visibility', 'visible');
    }
    const nm = wrap.querySelector(`.flow-nm[data-i="${i}"]`);
    if (nm) nm.classList.add('hot');
    const id = g.order[i];
    const f = st.byId.get(id);
    let line;
    if (!f || f.kind === 'other') line = 'Not a video or audio file';
    else if (f.failed) line = 'Couldn’t be measured';
    else if (!f.measured) line = 'Not measured yet';
    else if (f.noSound) line = 'No sound';
    else if (!f.music) line = `No music · energy ${pct(f.em)}`;
    else line = `${FlowOrder.bpmText(f)} BPM · energy ${pct(f.es)} → ${pct(f.em)} → ${pct(f.ee)}`;
    let chips = '';
    const s = laneSource();
    if (s && typeof s.chips === 'function') {
      let c = [];
      try { c = s.chips(id) || []; } catch { c = []; }
      if (Array.isArray(c) && c.length) chips = `<span class="flow-chips">${c.filter(t => t && t.label).map(t => `<span class="flow-chip" style="--c:${safeColor(t.color) || 'var(--text-secondary)'}">${esc(t.label)}</span>`).join('')}</span>`;
    }
    // The hand-over into this file, and why it got its grade.
    const h = i > 0 && g.hand ? g.hand[i - 1] : null;
    const into = h && h.grade !== 'none'
      ? `<span class="flow-tip-h flow-tip-h-${h.grade}">From the file before: ${esc(`${GRADE_WORD[h.grade].replace(' hand-over', '')}. ${FlowOrder.handoverText(st.byId.get(g.order[i - 1]), f, h)}`)}</span>`
      : '';
    tip.innerHTML = `<span class="flow-tip-t">${i + 1}. ${esc(shortName(f) || 'Untitled')}</span><span class="flow-tip-m">${esc(line)}</span>${into}${chips}`;
    tip.hidden = false;
    // Beside the column, on the side with more room, so the column stays in view.
    const tw = tip.offsetWidth || 220;
    const x = g.L + (i + 0.5) * g.step;
    const room = Math.max(6, g.step / 2 + 6);
    let left = x + tw + room <= g.W ? x + room : x - room - tw;
    left = Math.max(0, Math.min(g.W - tw, left));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${g.TOP}px`;
  }

  function colAt(e) {
    const wrap = document.getElementById('flowChartWrap');
    const g = st.geom;
    if (!wrap || !g) return -1;
    const nm = e.target.closest && e.target.closest('.flow-nm');
    if (nm) return Number(nm.dataset.i);
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
    return `<div class="flow-legend">
          <span><i class="flow-key-energy"></i>Energy (loudness and tempo)</span>
          <span><i class="flow-key-line" style="background:var(--flow-ok)"></i>Smooth hand-over</span>
          <span><i class="flow-key-dash" style="border-color:var(--flow-warn)"></i>Noticeable</span>
          <span><i class="flow-key-line" style="background:var(--flow-bad)"></i>Jump</span>
          ${guide() ? '<span><i class="flow-key-dash flow-key-target"></i>Shape you picked</span>' : ''}
          ${anyQuiet ? '<span><i class="flow-key-dots"></i>No music</span>' : ''}
        </div>`;
  }

  function paint() {
    const el = panel();
    if (!el) return;
    if (!st.open || !isMine()) { el.hidden = true; el.innerHTML = ''; st.geom = null; return; }
    el.hidden = false;
    const hideBtn = '<button type="button" class="flow-btn flow-btn-sm flow-hide" data-flow-hide title="Hide the Flow panel">Hide ▴</button>';
    if (tooMany()) { el.innerHTML = `<div class="flow-row"><span class="flow-title">Flow</span>${progressHtml()}<span class="flow-sp"></span>${hideBtn}</div>`; st.geom = null; return; }
    // Keyboard focus on the grip or Hide stays there across repaints (polls repaint often).
    const KEEP_FOCUS = ['.flow-grip', '[data-flow-hide]'];
    const keepFocus = KEEP_FOCUS.find(sel => document.activeElement?.matches?.(`#flowPanel ${sel}`));
    const shapes = FlowOrder.SHAPES.map(s => `<button type="button" data-flow-shape="${s.key}" aria-pressed="${String(st.order && st.shape === s.key)}">${esc(s.label)}</button>`).join('');
    // The chart's host is kept across repaints (polls repaint often): an empty
    // host would shrink the panel for a moment, and a page scrollbar going
    // with it would make the chart measure too wide.
    const keep = document.getElementById('flowChartWrap');
    if (keep) keep.remove();
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
        ${hideBtn}
      </div>
      ${lanesRowHtml()}
      ${chartHtml(!!keep)}
      ${gripHtml()}
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
    if (keepFocus) el.querySelector(keepFocus)?.focus({ preventScroll: true });
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
      const pl = e.target.closest('[data-flow-places]');
      if (pl) { pickPlaces(pl.dataset.flowPlaces === '1'); return; }
      const ln = e.target.closest('[data-flow-lane]');
      if (ln) { toggleLane(ln.dataset.flowLane); return; }
      if (e.target.closest('[data-flow-save]')) { saveOrder(); return; }
      if (e.target.closest('[data-flow-hide]')) {
        close();
        // Focus goes back to the toolbar button that opens it again.
        document.getElementById('collFlowBtn')?.focus({ preventScroll: true });
        return;
      }
      if (e.target.closest('#flowChartWrap') && st.geom) {
        const i = colAt(e);
        if (i >= 0) revealFile(st.geom.order[i]);
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!e.target.closest('#flowChartWrap')) { if (st.hot >= 0) showHot(-1); return; }
      const i = colAt(e);
      if (i !== st.hot) showHot(i);
    });
    el.addEventListener('pointerleave', () => { if (st.hot >= 0) showHot(-1); });
    wireGrip(el);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        const wrap = document.getElementById('flowChartWrap');
        if (wrap && wrap.clientWidth !== st.drawnW) scheduleDraw();
      }).observe(el);
    }
  }

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
    else if (f.failed) body = '<span class="flow-tile-note">couldn’t measure</span>';
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
    orderOn: () => st.order && isMine() && !!st.appliedOrder,
    countText: () => (st.order && isMine() && st.appliedOrder ? `Flow order: ${FlowOrder.shapeLabel(st.shape).toLowerCase()}${st.edited ? ', edited' : ''}` : null),
    leaveOrder: () => { if (st.order) { leave(); paint(); } },
    workingOrder: () => (st.order && isMine() ? workingOrder().slice() : null),
    moveInOrder, orderBarHtml,
    _state: () => ({ ...st, byId: st.byId.size, data: st.data && { order: st.data.order, counts: st.data.counts, jumps: st.data.jumps } }),
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
