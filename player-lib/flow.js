/* =========================================================================
   FLOW - order a collection so each file flows into the next.

   The Flow… button in the collection bar opens this panel above the files.
   Opening it asks the server to measure the collection's music (tempo,
   energy and loudness at each file's start, middle and end; lib/flow/), and
   shows the energy across the order, the shape you pick, and how many
   hand-overs between files are jumps.

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
      st.lastCount = data.counts.measured + data.counts.failed;
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
    const count = c.measured + c.failed;
    const active = c.left > 0 && st.status.queue.state !== 'idle';
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

  const eColor = (v) => `color-mix(in oklab, var(--flow-e-lo), var(--flow-e-hi) ${Math.round(Math.max(0, Math.min(1, v)) * 100)}%)`;
  const GRADE_VAR = { smooth: 'var(--flow-ok)', noticeable: 'var(--flow-warn)', jump: 'var(--flow-bad)' };
  const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

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
    } else if (c.left > 0 && q && q.state !== 'idle') {
      const why = q.reason === 'paused' ? 'Paused'
        : q.reason === 'stage' ? 'Waiting while Stage plays'
        : q.reason === 'locked' ? 'Waiting: Vault is locked'
        : 'Measuring';
      const pct = Math.round((done / c.measurable) * 100);
      parts.push(`<span class="flow-sub">${why} ${done.toLocaleString()} of ${plural(c.measurable, 'file', 'files')}</span>`);
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

  function chartSvg() {
    const d = st.data;
    if (!d || !d.features.length) return '';
    const order = st.order ? d.order : d.playlistOrder;
    const W = 900, H = 120, pad = 12, n = order.length;
    const step = W / n;
    const y = (v) => H - pad - v * (H - 2 * pad);
    let svg = '';
    for (let i = 0; i < n; i++) if (i % 2) svg += `<rect x="${(i * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${H}" fill="var(--flow-band)"/>`;
    const gap = Math.min(4, step * 0.15);
    order.forEach((id, i) => {
      const f = st.byId.get(id);
      const x0 = i * step + gap, x1 = (i + 1) * step - gap;
      if (!f || !f.measured || f.failed) return;
      if (!f.music) {
        svg += `<line x1="${x0.toFixed(1)}" x2="${x1.toFixed(1)}" y1="${y(f.em).toFixed(1)}" y2="${y(f.em).toFixed(1)}" stroke="var(--flow-quiet)" stroke-width="2" stroke-dasharray="3 3"/>`;
        return;
      }
      const xs = [x0, (x0 + x1) / 2, x1], vs = [f.es, f.em, f.ee];
      const pts = xs.map((x, k) => `${x.toFixed(1)},${y(vs[k]).toFixed(1)}`).join(' ');
      svg += `<polyline points="${pts}" fill="none" stroke="${eColor(f.em)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    });
    // The hand-over marks, between files.
    const hand = st.order ? d.handovers : FlowOrder.summary(d.features, d.playlistOrder).handovers;
    hand.forEach((h, i) => {
      if (h.grade === 'none') return;
      const x = (i + 1) * step;
      svg += `<circle cx="${x.toFixed(1)}" cy="${H - 5}" r="3.5" fill="${GRADE_VAR[h.grade]}"><title>${h.grade === 'jump' ? 'Jump' : h.grade === 'noticeable' ? 'Noticeable' : 'Smooth'} hand-over</title></circle>`;
    });
    if (st.order && d.targets) {
      const pts = d.targets.map((t, i) => `${((i + 0.5) * step).toFixed(1)},${y(t).toFixed(1)}`).join(' ');
      svg += `<polyline points="${pts}" fill="none" stroke="var(--flow-target)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    }
    return `<svg class="flow-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Energy across the ${st.order ? 'Flow' : 'playlist'} order">${svg}</svg>`;
  }

  function summaryText() {
    const d = st.data;
    if (!d) return '';
    const jumps = st.order ? d.jumps : d.playlistJumps;
    if (d.counts.music < 2) return '';
    return jumps ? `${plural(jumps, 'jump', 'jumps')} between files` : 'Every hand-over is smooth or close';
  }

  function paint() {
    const el = panel();
    if (!el) return;
    if (!st.open || !isMine()) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    if (tooMany()) { el.innerHTML = `<div class="flow-row"><span class="flow-title">Flow</span>${progressHtml()}</div>`; return; }
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
      ${chartSvg()}
      <div class="flow-row">
        <div class="flow-legend">
          <span><i class="flow-key-energy"></i>Energy (loudness and tempo)</span>
          ${st.order && st.shape !== 'smooth' ? '<span><i class="flow-key-target"></i>Shape you picked</span>' : ''}
          <span><i style="background:var(--flow-ok)"></i>Smooth hand-over</span>
          <span><i style="background:var(--flow-warn)"></i>Noticeable</span>
          <span><i style="background:var(--flow-bad)"></i>Jump</span>
        </div>
        <span class="flow-sp"></span>
        <span class="flow-sub" id="flowSummary">${esc(summaryText())}</span>
        ${st.order && st.data ? '<button type="button" class="flow-btn" data-flow-save>Save as playlist order</button>' : ''}
      </div>`;
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
      if (e.target.closest('[data-flow-save]')) saveOrder();
    });
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
    const bar = typeof StageBar !== 'undefined' ? StageBar : null;
    if (!bar || typeof bar.setFlowText !== 'function') return;
    const id = row && row.id;
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
