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
     flowStageCurrent(row)        stage-control.js setCurrent
   ========================================================================= */

const Flow = (() => {
  const POLL_MS = 1500;
  const REFETCH_MS = 2500;
  const st = {
    cid: null,          // the collection the panel belongs to
    open: false,
    order: false,       // Flow order is what the grid shows
    shape: 'smooth',
    data: null,         // GET /api/flow/collections/:id
    byId: new Map(),    // id -> features
    status: null,       // GET /api/flow/status
    pollTimer: null,
    lastCount: -1,
    lastFetch: 0,
    fetching: false,
    appliedOrder: null, // the order last handed to the query
    hot: -1,            // the chart column under the pointer
    geom: null,         // the chart as last drawn (columns, range) for hover and click
    drawnW: 0,
    nowId: null,        // the file Stage is playing (stageCurrent)
    lanePrefs: null,    // which lane rows show (localStorage)
    hookedSource: null, // the FlowLaneSource whose onChange we listen to
    flashTimer: null,
  };

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));
  const panel = () => document.getElementById('flowPanel');
  const activeId = () => (typeof activeCollectionId !== 'undefined' ? activeCollectionId : null);
  const isMine = () => st.cid != null && st.cid === activeId();
  const tooMany = () => !!(st.status && st.status.collection && st.status.collection.tooMany);

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
    paint();
  }

  async function toggle(cid) {
    if (st.open && st.cid === cid) { close(); return; }
    if (st.cid !== cid) reset();
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
      const data = await api(`/api/flow/collections/${cid}?shape=${encodeURIComponent(st.shape)}`);
      if (cid !== st.cid) return;
      st.data = data;
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
    if (st.open && typeof renderResults === 'function') renderResults();
  }

  /** What changes when a measurement lands (a stale row measured again changes only stale). */
  const countKey = (c) => `${c.measured}:${c.failed}:${c.stale || 0}`;

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
    // Measuring, or measuring again (stale: an older method, for the chart's detail).
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
    const next = st.data.order;
    if (st.appliedOrder && st.appliedOrder.length === next.length && st.appliedOrder.every((id, i) => id === next[i])) return;
    st.appliedOrder = next.slice();
    if (typeof applyFilters === 'function') await applyFilters({ keepPage: true });
    if (typeof renderReorderNote === 'function') renderReorderNote();
  }

  async function useFlowOrder() {
    if (!isMine()) return;
    st.order = true;
    if (!st.data) await refetch(true);
    st.appliedOrder = null;
    await applyOrder();
    paint();
  }

  async function usePlaylistOrder() {
    if (!st.order) return;
    st.order = false;
    st.appliedOrder = null;
    paint();
    if (typeof switchToPlaylistOrder === 'function') await switchToPlaylistOrder();
    else if (typeof applyFilters === 'function') await applyFilters({ keepPage: true });
  }

  async function pickShape(shape) {
    if (!FlowOrder.isShape(shape)) return;
    st.shape = shape;
    st.order = true;
    paint();
    await refetch(true);
    st.appliedOrder = null;
    await applyOrder();
    paint();
  }

  async function saveOrder() {
    if (!st.data || !isMine()) return;
    const cid = st.cid;
    const before = st.data.playlistOrder.slice();
    const order = st.data.order.slice();
    try {
      await post(`/api/collections/${cid}/order`, { order });
    } catch (err) { toastErr(err, 'saving the order'); return; }
    st.order = false;
    st.appliedOrder = null;
    await refetch(true);
    if (typeof switchToPlaylistOrder === 'function') await switchToPlaylistOrder();
    const undo = async () => {
      try {
        await post(`/api/collections/${cid}/order`, { order: before });
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
      const why = q.reason === 'paused' ? 'Paused'
        : q.reason === 'stage' ? 'Waiting while Stage plays'
        : q.reason === 'locked' ? 'Waiting: Vault is locked'
        : again ? 'Adding detail to the chart:' : 'Measuring';
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
      if (!(q && q.state !== 'idle')) parts.push('<button type="button" class="flow-btn flow-btn-sm" data-flow-q="retry">Try again</button>');
    }
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

  const eColor = (v) => `color-mix(in oklab, var(--flow-e-lo), var(--flow-e-hi) ${Math.round(Math.max(0, Math.min(1, v)) * 100)}%)`;
  const GRADE_VAR = { smooth: 'var(--flow-ok)', noticeable: 'var(--flow-warn)', jump: 'var(--flow-bad)' };
  const GRADE_WORD = { smooth: 'Smooth hand-over', noticeable: 'Noticeable hand-over', jump: 'Jump' };
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  const f1 = (v) => (Math.round(v * 10) / 10).toString();
  const pct = (v) => Math.round(Math.max(0, Math.min(1, v)) * 100);
  const shortName = (f) => String((f && f.name) || '').replace(/\.[a-z0-9]{1,5}$/i, '');
  /** Drawn as a line: measured, with sound (no audio stream, or silent: nothing). */
  const drawable = (f) => !!(f && f.measured && !f.failed && !f.noSound);

  function chartOrder() {
    const d = st.data;
    return d ? (st.order ? d.order : d.playlistOrder) : [];
  }

  function chartHandovers(order) {
    const d = st.data;
    return st.order ? d.handovers : FlowOrder.summary(d.features, order).handovers;
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

     A cell with several tags is drawn as side-by-side rounded segments; an
     untagged cell is a very faint rounded bar. Which rows show is the user's
     pick (the Lanes toggles), kept in localStorage: { tempo: bool,
     'tag:<key>': bool }; a tag lane shows until it is turned off, Tempo
     until it is turned on. Anything the provider throws or returns malformed
     counts as no tags. */

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
      return c.filter(t => t && t.color).map(t => ({ color: String(t.color), label: String(t.label || '') }));
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

  function chartHtml() {
    const d = st.data;
    if (!d || !d.features.length) return '';
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
    const PH = W < 560 ? 110 : W < 1000 ? 130 : 150;
    const laneY = TOP + PH + 10;
    const H = laneY + lanes.length * LANE_ROW + (lanes.length ? 0 : -6);
    const step = (W - L - R) / n;
    const dense = step < DENSE_PX;
    const gap = dense ? 0 : Math.min(8, step * 0.12);
    const base = TOP + PH;
    const targets = st.order && d.targets ? d.targets : null;

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
      </defs>`;
    // Gridlines, labelled 0-100.
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      const gy = f1(y(v));
      svg += `<line class="flow-grid" x1="${L}" x2="${W - R}" y1="${gy}" y2="${gy}"/><text class="flow-axis" x="${L - 6}" y="${f1(y(v) + 3.5)}" text-anchor="end">${pct(v)}</text>`;
    }
    svg += `<rect class="flow-col-hot" x="0" y="0" width="0" height="${H}" rx="4" visibility="hidden"/>`;

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
          const qy = f1(y(f.em));
          quiet += `<line x1="${f1(x0)}" x2="${f1(x1)}" y1="${qy}" y2="${qy}"/>`;
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
      const title = esc(`${GRADE_WORD[h.grade]}: ${shortName(fa) || `file ${i + 1}`} into ${shortName(fb) || `file ${i + 2}`}`);
      const c = Math.max(1, gap);
      svg += `<path class="flow-hand flow-hand-${h.grade}" d="M${f1(a[0])},${f1(a[1])} C${f1(a[0] + c)},${f1(a[1])} ${f1(b[0] - c)},${f1(b[1])} ${f1(b[0])},${f1(b[1])}"><title>${title}</title></path>`;
      if (h.grade === 'jump' && step >= 8) {
        const bx = (a[0] + b[0]) / 2, by = Math.max(7, Math.min(a[1], b[1]) - 10);
        svg += `<g class="flow-badge"><title>${title}</title><circle cx="${f1(bx)}" cy="${f1(by)}" r="6.5"/><text x="${f1(bx)}" y="${f1(by + 3.4)}" text-anchor="middle">!</text></g>`;
      }
    });
    if (jumpsDense) svg += `<path class="flow-hand flow-hand-jump" d="${jumpsDense}"/>`;

    // The file playing now.
    const nowI = st.nowId != null ? order.indexOf(st.nowId) : -1;
    if (nowI >= 0) svg += `<circle class="flow-now-dot" cx="${f1(cx(nowI))}" cy="5" r="3"><title>Playing now</title></circle>`;

    if (lanes.length) svg += lanesSvg(lanes, order, { L, step, laneY, dense });

    const label = `Energy across the ${st.order ? 'Flow' : 'playlist'} order, ${pct(lo)} to ${pct(hi)}`;
    wrap.querySelector('.flow-chart-svg').innerHTML = `<svg class="flow-chart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${svg}</svg>`;
    st.geom = { W, H, L, R, TOP, PH, step, n, order, dense, lo, hi };
    namesRow(wrap, order, { L, step, dense, nowI });
    if (st.hot >= n) st.hot = -1;
    showHot(st.hot);
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
      html += `<span class="flow-nm${i === nowI ? ' now' : ''}${named ? '' : ' num'}" data-i="${i}" style="left:${f1(left)}px;width:${f1(w)}px" title="${esc(`${i + 1}. ${(f && f.name) || ''}${i === nowI ? ' (playing now)' : ''}`)}"><b>${i + 1}</b>${named ? esc(name) : ''}</span>`;
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
      if (Array.isArray(c) && c.length) chips = `<span class="flow-chips">${c.filter(t => t && t.label).map(t => `<span class="flow-chip" style="--c:${esc(t.color || 'var(--text-secondary)')}">${esc(t.label)}</span>`).join('')}</span>`;
    }
    tip.innerHTML = `<span class="flow-tip-t">${i + 1}. ${esc(shortName(f) || 'Untitled')}</span><span class="flow-tip-m">${esc(line)}</span>${chips}`;
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
    const jumps = st.order ? d.jumps : d.playlistJumps;
    if (d.counts.music < 2) return '';
    return jumps ? `${plural(jumps, 'jump', 'jumps')} between files` : 'Every hand-over is smooth or close';
  }

  function legendHtml() {
    const d = st.data;
    const anyQuiet = !!(d && d.features.some(f => drawable(f) && !f.music));
    return `<div class="flow-legend">
          <span><i class="flow-key-energy"></i>Energy (loudness and tempo)</span>
          <span><i class="flow-key-line" style="background:var(--flow-ok)"></i>Smooth hand-over</span>
          <span><i class="flow-key-dash" style="border-color:var(--flow-warn)"></i>Noticeable</span>
          <span><i class="flow-key-line" style="background:var(--flow-bad)"></i>Jump</span>
          ${st.order && d && d.targets ? '<span><i class="flow-key-dash flow-key-target"></i>Shape you picked</span>' : ''}
          ${anyQuiet ? '<span><i class="flow-key-dots"></i>No music</span>' : ''}
        </div>`;
  }

  function paint() {
    const el = panel();
    if (!el) return;
    if (!st.open || !isMine()) { el.hidden = true; el.innerHTML = ''; st.geom = null; return; }
    el.hidden = false;
    if (tooMany()) { el.innerHTML = `<div class="flow-row"><span class="flow-title">Flow</span>${progressHtml()}</div>`; st.geom = null; return; }
    const shapes = FlowOrder.SHAPES.map(s => `<button type="button" data-flow-shape="${s.key}" aria-pressed="${String(st.order && st.shape === s.key)}">${esc(s.label)}</button>`).join('');
    el.innerHTML = `
      <div class="flow-row">
        <span class="flow-title">Flow</span>
        ${progressHtml()}
        <span class="flow-seg" role="group" aria-label="Order">
          <button type="button" data-flow-order="playlist" aria-pressed="${String(!st.order)}">Playlist order</button>
          <button type="button" data-flow-order="flow" aria-pressed="${String(st.order)}">Flow order</button>
        </span>
        <span class="flow-sp"></span>
        <span class="flow-seg-label">Shape</span>
        <span class="flow-seg flow-shapes" role="group" aria-label="Shape">${shapes}</span>
      </div>
      ${lanesRowHtml()}
      ${chartHtml()}
      <div class="flow-row">
        ${legendHtml()}
        <span class="flow-sp"></span>
        <span class="flow-sub" id="flowSummary">${esc(summaryText())}</span>
        ${st.order && st.data ? '<button type="button" class="flow-btn" data-flow-save>Save as playlist order</button>' : ''}
      </div>`;
    st.geom = null;
    drawChart();
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
      const ln = e.target.closest('[data-flow-lane]');
      if (ln) { toggleLane(ln.dataset.flowLane); return; }
      if (e.target.closest('[data-flow-save]')) { saveOrder(); return; }
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
        const g = FlowOrder.grade(FlowOrder.handoverCost(prev, f), prev, f);
        if (g !== 'none') dot = `<span class="flow-join flow-join-${g}" title="${g === 'jump' ? 'A jump' : g === 'noticeable' ? 'A noticeable change' : 'A smooth hand-over'} from the file before"></span>`;
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
    let on = false;
    try { on = !!(await api('/api/stage/settings')).flowShuffle; } catch { return false; }
    if (!on) return false;
    let data = st.cid === cid && st.data ? st.data : null;
    if (!data) { try { data = await api(`/api/flow/collections/${cid}?shape=smooth`); } catch { return false; } }
    if (!data.features.some(f => f.measured && f.music)) return false;
    const order = FlowOrder.flowShuffle(data.features);
    if (st.order) { st.order = false; st.appliedOrder = null; paint(); }
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
  });
  document.addEventListener('DOMContentLoaded', wire);
  if (document.readyState !== 'loading') wire();

  return {
    toggle, close, pickShape, useFlowOrder, usePlaylistOrder, saveOrder, refetch,
    tileHtml, queryRanked, shuffleCollection, stageCurrent,
    isOpen: () => st.open && isMine(),
    orderOn: () => st.order && isMine() && !!st.appliedOrder,
    countText: () => (st.order && isMine() && st.appliedOrder ? `Flow order: ${FlowOrder.shapeLabel(st.shape).toLowerCase()}` : null),
    leaveOrder: () => { if (st.order) { st.order = false; st.appliedOrder = null; paint(); } },
    _state: () => ({ ...st, byId: st.byId.size, data: st.data && { order: st.data.order, counts: st.data.counts, jumps: st.data.jumps } }),
  };
})();

window.Flow = Flow;

/* Hooks (see the header). */
function flowButtonHtml(c) {
  if (!c || c.kind === 'folder') return '';
  const on = Flow.isOpen();
  return `<button class="coll-action coll-flow${on ? ' on' : ''}" id="collFlowBtn" aria-pressed="${on}" onclick="Flow.toggle(${c.id})" title="Order these files so each one flows into the next">Flow…</button>`;
}
function flowTileHtml(media) { return Flow.tileHtml(media); }
function flowQueryRanked() { return Flow.queryRanked(); }
function flowOrderOn() { return Flow.orderOn(); }
function flowLeaveOrder() { Flow.leaveOrder(); }
function flowCountText() { return Flow.countText(); }
function flowShuffleCollection(id) { return Flow.shuffleCollection(id); }
function flowStageCurrent(row) { Flow.stageCurrent(row); }
