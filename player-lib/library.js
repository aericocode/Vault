/* =========================================================================
   LIBRARY - the results the grid shows, asked of the server

   The browser no longer holds the library. It describes what it wants to see
   (a query spec: search text, filters, sort) and the server answers with the
   first page of rows straight away, then the full ordered id list as a compact
   binary download (SERVER_SEARCH_SPEC sections 6 and 7.1). Rows for any other
   position are fetched on demand into a bounded cache.

   What the rest of the viewer reads from here:
     Library.length()        how many results (the exact total once known)
     Library.known()         is that total exact yet?
     Library.idAt(i)         the id at a result position
     Library.indexOf(id)     the position of an id, or -1
     Library.row(id)         a cached row, synchronously (null on a miss)
     Library.rowByPath(fp)   the same, by filepath
     Library.fetchRows(ids)  make sure rows are cached, resolves them in order
     Library.rowsForRange()  rows for result positions [start, end)
     Library.facets          library-wide counts (6.4)

   Rows on screen and the player's current item and neighbours are pinned, so
   the cache never evicts what something is showing. A fetched row is merged
   into the cached object when there is one, so a row object handed out once
   stays the live one.

   Events (on window):
     vault:results-changed   a new first page is installed
     vault:results-counted   the full id list arrived (exact total known)
     vault:counting          the count is taking a moment (400 ms rule)
     vault:facets-changed    new library-wide counts
     vault:index-state       the search index started or finished building
     vault:row-updated       a cached row changed (detail.id)
   ========================================================================= */

const Library = (() => {
  const ROW_CACHE_MAX = 10000;
  const ROWS_BATCH = 2000;            // POST /api/media/rows takes up to 2000 ids
  const ROWS_CONCURRENCY = 3;
  const POLL_MS = 3000;
  const COUNTING_DELAY_MS = 400;      // "counting…" only after this long
  const IDS_FALLBACK_MS = 300;        // start the id list even if no render asked
  const PAGE_MIN = 100;
  const PAGE_MAX = 500;               // the query route's own cap

  // Type codes of the binary id list (spec section 2).
  const TYPE_CODES = { video: 1, audio: 2, image: 3, gif: 4, mix: 5, document: 6 };
  const TYPE_NAMES = ['', 'video', 'audio', 'image', 'gif', 'mix', 'document'];

  /* ── Row cache ──────────────────────────────────────────────────────── */

  const cache = new Map();     // id → row (Map order is the LRU order)
  const byPath = new Map();    // filepath → id
  const stale = new Set();     // cached rows older than the library version
  const gone = new Set();      // ids the server says do not exist (this version)
  const inflight = new Map();  // id → Promise of the batch fetching it
  const pins = new Map();      // owner → Set(ids)

  // Write responses carry the full row; the viewer never needs these two.
  const DROP_FIELDS = ['embedding', 'audio_transcription'];

  // Ids a fetchRows() call is still collecting: never evicted under it, so a
  // call's answer cannot depend on what another batch pushed out.
  const holding = new Map();   // id → number of calls holding it

  function hold(ids, delta) {
    for (const id of ids) {
      const n = (holding.get(id) || 0) + delta;
      if (n > 0) holding.set(id, n); else holding.delete(id);
    }
  }

  function isPinned(id) {
    if (holding.has(id)) return true;
    for (const s of pins.values()) if (s.has(id)) return true;
    return false;
  }

  function pin(owner, ids) {
    if (!ids || !ids.length) pins.delete(owner);
    else pins.set(owner, new Set(ids.filter(Boolean)));
  }

  function evict() {
    if (cache.size <= ROW_CACHE_MAX) return;
    const target = Math.floor(ROW_CACHE_MAX * 0.9);
    for (const id of cache.keys()) {
      if (cache.size <= target) break;
      if (isPinned(id)) continue;
      const row = cache.get(id);
      cache.delete(id);
      stale.delete(id);
      if (row && byPath.get(row.filepath) === id) byPath.delete(row.filepath);
    }
  }

  /** Put a server row into the cache, merging into the cached object. */
  function putRow(row) {
    if (!row || !row.id) return null;
    for (const k of DROP_FIELDS) if (k in row) delete row[k];
    const have = cache.get(row.id);
    let out = row;
    if (have && have !== row) {
      if (have.filepath !== row.filepath && byPath.get(have.filepath) === row.id) byPath.delete(have.filepath);
      Object.assign(have, row);
      out = have;
      cache.delete(row.id);           // re-insert: most recently used
    }
    cache.set(row.id, out);
    if (out.filepath) byPath.set(out.filepath, out.id);
    stale.delete(row.id);
    gone.delete(row.id);
    return out;
  }

  function touch(id) {
    const row = cache.get(id);
    if (!row) return;
    cache.delete(id);
    cache.set(id, row);
  }

  function row(id) {
    return (id && cache.get(id)) || null;
  }

  function rowByPath(filepath) {
    const id = byPath.get(filepath);
    return id ? row(id) : null;
  }

  let _rowSlots = ROWS_CONCURRENCY;
  const _rowWaiters = [];
  async function rowSlot() {
    if (_rowSlots > 0) { _rowSlots--; return; }
    await new Promise(res => _rowWaiters.push(res));
  }
  function releaseRowSlot() {
    const next = _rowWaiters.shift();
    if (next) next(); else _rowSlots++;
  }

  /**
   * One POST /api/media/rows. Resolves { ok, rows: Map(id → cached row) }:
   * ok false when the request failed (offline, locked, server error), so the
   * caller can tell "not there" from "could not ask".
   */
  async function postRows(ids, gen) {
    await rowSlot();
    const rows = new Map();
    try {
      const resp = await fetch('/api/media/rows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Vault-Background': '1' },
        body: JSON.stringify({ ids }),
      });
      if (!resp.ok) return { ok: false, rows };
      const list = (await resp.json()).rows || [];
      // A lock in the meantime cleared the cache; never refill it.
      if (gen !== _gen) return { ok: false, rows };
      for (const r of list) {
        const kept = putRow(r);
        if (kept) rows.set(kept.id, kept);
      }
      for (const id of ids) if (!rows.has(id)) gone.add(id);
      evict();
      return { ok: true, rows };
    } catch {
      return { ok: false, rows };
    } finally {
      releaseRowSlot();
    }
  }

  /** Rows a bulk action needed could not be loaded (the server did not answer). */
  class RowsUnavailable extends Error {
    constructor(count) {
      super(`${count.toLocaleString()} file(s) could not be loaded from the server. Nothing was changed. Try again.`);
      this.count = count;
    }
  }

  /**
   * Make sure these rows are cached (stale ones refetched). Resolves the rows
   * in the order asked, null where a row does not exist or could not be
   * loaded. The answer is collected as it arrives, and the asked ids are held
   * against eviction meanwhile, so a big call never loses its own rows.
   * The array carries `.failed` (ids the server could not be asked about)
   * and `.gone` (ids the server says do not exist).
   * @param {number[]} ids
   * @param {{force?: boolean, strict?: boolean}} [opts]
   *   force: refetch even fresh rows; strict: reject with RowsUnavailable
   *   when any row could not be loaded (bulk actions: never a silent skip)
   */
  async function fetchRows(ids, { force = false, strict = false } = {}) {
    const list = Array.from(ids || []).filter(Boolean);
    const uniq = [...new Set(list)];
    hold(uniq, 1);
    try {
      const got = new Map();
      const failed = new Set();
      const waits = [];
      const take = (out, asked) => {
        for (const id of asked) {
          const r = out.rows.get(id);
          if (r) { got.set(id, r); failed.delete(id); }
          else if (!out.ok) {
            // A stale copy is still the row; only a row we have never seen fails.
            const old = cache.get(id);
            if (old) got.set(id, old); else failed.add(id);
          }
        }
      };
      const need = [];
      for (const id of uniq) {
        const p = inflight.get(id);
        if (p) { waits.push(p.then(out => take(out, [id]))); continue; }
        if (!force && cache.has(id) && !stale.has(id)) { got.set(id, cache.get(id)); continue; }
        if (!force && gone.has(id)) continue;
        need.push(id);
      }
      const gen = _gen;
      for (let i = 0; i < need.length; i += ROWS_BATCH) {
        const batch = need.slice(i, i + ROWS_BATCH);
        const p = postRows(batch, gen);
        for (const id of batch) inflight.set(id, p);
        p.then(() => { for (const id of batch) if (inflight.get(id) === p) inflight.delete(id); });
        waits.push(p.then(out => take(out, batch)));
      }
      if (waits.length) await Promise.all(waits);
      const out = list.map(id => got.get(id) || null);
      out.failed = failed.size;
      out.gone = uniq.filter(id => !got.has(id) && !failed.has(id)).length;
      if (strict && failed.size) throw new RowsUnavailable(failed.size);
      return out;
    } finally {
      hold(uniq, -1);
    }
  }

  /** Is this row missing or out of date (worth a fetch before showing)? */
  function needsFetch(id) {
    if (!id || gone.has(id)) return false;
    return !cache.has(id) || stale.has(id);
  }

  /* ── The current result ─────────────────────────────────────────────── */

  let _gen = 0;          // bumped by clear(): anything older is dropped
  let _seq = 0;          // bumped by every query: stale responses are dropped
  const res = {
    // Before the first query: an empty result whose (zero) count is known.
    seq: 0, spec: null, qid: null, version: null,
    firstIds: [], ids: new Uint32Array(0), types: new Uint8Array(0), total: 0,
    search: null, idsPromise: null, idsStarted: false,
    counting: false, empty: true, shuffled: false,
  };
  let _countingTimer = null;
  let _idsTimer = null;
  let _idsWaiters = [];

  function length() {
    if (res.ids) return res.ids.length;
    if (res.total != null) return res.total;
    return res.firstIds.length;
  }
  function known() { return res.ids != null || res.total != null; }
  function idAt(i) {
    if (i < 0) return undefined;
    return res.ids ? res.ids[i] : res.firstIds[i];
  }
  function typeAt(i) {
    if (res.types) return TYPE_NAMES[res.types[i]] || '';
    const r = row(res.firstIds[i]);
    return r ? r.media_type : '';
  }
  function indexOf(id) {
    if (!id) return -1;
    return res.ids ? res.ids.indexOf(id) : res.firstIds.indexOf(id);
  }
  function rowAt(i) { return row(idAt(i)); }

  /** Every result id (waits for the list). Resolves null if superseded. */
  async function allIds() {
    const ids = await waitIds();
    return ids;
  }

  function settleIdsWaiters(value) {
    const w = _idsWaiters;
    _idsWaiters = [];
    for (const fn of w) fn(value);
  }

  /** Resolves the current result's id list once it is here (null if replaced). */
  function waitIds() {
    if (res.ids) return Promise.resolve(res.ids);
    startIds();
    const seq = res.seq;
    return new Promise(resolve => _idsWaiters.push((v) => resolve(seq === res.seq ? v : null)));
  }

  /**
   * Start the id list download. Called once the first page is on screen (so a
   * slow count never delays the first thumbnails), or after 300 ms, or right
   * away by anything that needs a position past the first page.
   */
  function startIds() {
    if (res.ids || res.idsStarted || !res.qid) return;
    res.idsStarted = true;
    clearTimeout(_idsTimer);
    const seq = res.seq;
    res.idsPromise = loadIds(seq).catch(() => null);
  }

  /** A failed id list download tries again shortly, while it is still wanted. */
  function retryIds(seq) {
    if (seq !== res.seq) return;
    res.idsStarted = false;
    setTimeout(() => { if (seq === res.seq) startIds(); }, 2000);
  }

  async function loadIds(seq, retried = false) {
    let resp;
    try {
      resp = await fetch(`/api/library/query/${encodeURIComponent(res.qid)}/ids`);
    } catch {
      retryIds(seq);
      return null;
    }
    if (seq !== res.seq) return null;
    if (resp.status === 404 && !retried) {
      // The plan expired (10 minutes, or pushed out by newer queries): ask again.
      const again = await postQuery(res.spec, pageSizeFor());
      if (seq !== res.seq || !again.ok) return null;
      res.qid = again.data.qid;
      return loadIds(seq, true);
    }
    if (!resp.ok) { if (resp.status !== 423) retryIds(seq); return null; }
    const buf = await resp.arrayBuffer();
    if (seq !== res.seq) return null;
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true);
    const version = dv.getUint32(4, true);
    // Little-endian on the wire, and every browser Vault runs in is too.
    const ids = new Uint32Array(buf, 8, n);
    const types = new Uint8Array(buf, 8 + n * 4, n);
    res.ids = ids;
    res.types = types;
    res.total = n;
    clearTimeout(_countingTimer);
    res.counting = false;
    const versionChanged = version !== res.version;
    if (versionChanged) {
      // Recomputed against newer data: the list wins, cached rows may be old.
      res.version = version;
      markAllStale();
    }
    settleIdsWaiters(ids);
    emit('vault:results-counted', { versionChanged });
    return ids;
  }

  function pageSizeFor() {
    const grid = typeof pageSize === 'number' ? pageSize : 45;
    return Math.max(PAGE_MIN, Math.min(PAGE_MAX, grid * 2));
  }

  async function postQuery(spec, size) {
    const resp = await fetch('/api/library/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...spec, pageSize: size }),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  }

  class QueryFailed extends Error {
    constructor(status, message, code) { super(message); this.status = status; this.code = code || null; }
  }

  function resetResult(seq) {
    clearTimeout(_countingTimer);
    clearTimeout(_idsTimer);
    settleIdsWaiters(null);
    res.seq = seq;
    res.qid = null;
    res.firstIds = [];
    res.ids = null;
    res.types = null;
    res.total = null;
    res.idsPromise = null;
    res.idsStarted = false;
    res.counting = false;
    res.shuffled = false;
  }

  /**
   * Run a query and install its first page as the current result.
   * Resolves true when installed, false when a newer query superseded it.
   * Rejects with QueryFailed on a 400 or 503 (the caller shows the message).
   * @param {object} spec  the 6.1 body without pageSize
   * @param {{needIds?: boolean}} [opts] needIds: start the id list right away
   */
  // Queries still on their way. Select all waits for them, so it always
  // applies to the results the user is looking at (or about to).
  let _queriesInFlight = 0;
  let _settleWaiters = [];

  /** Resolves once no query is in flight (the latest result is installed). */
  function settled() {
    if (!_queriesInFlight) return Promise.resolve();
    return new Promise(resolve => _settleWaiters.push(resolve));
  }

  async function query(spec, opts) {
    _queriesInFlight++;
    try {
      return await runQuery(spec, opts);
    } finally {
      if (--_queriesInFlight === 0) {
        const w = _settleWaiters;
        _settleWaiters = [];
        for (const fn of w) fn();
      }
    }
  }

  async function runQuery(spec, { needIds = false } = {}) {
    const seq = ++_seq;
    // Sent straight away, even at boot: the server answers in order, and the
    // first page should not queue behind the slower startup requests.
    const out = await postQuery(spec, pageSizeFor());
    if (seq !== _seq) return false;
    if (!out.ok) {
      if (out.status === 423) return false;   // the lock screen takes over
      throw new QueryFailed(out.status, out.data.error || `Server returned ${out.status}`, out.data.code);
    }
    const data = out.data;
    resetResult(seq);
    res.spec = spec;
    res.qid = data.qid;
    res.version = data.version;
    res.search = data.search || null;
    res.empty = false;
    res.firstIds = data.page.ids || [];
    for (const r of data.page.rows || []) putRow(r);
    evict();
    if (data.complete) {
      res.total = res.firstIds.length;
      res.ids = Uint32Array.from(res.firstIds);
      res.types = Uint8Array.from(res.firstIds, id => TYPE_CODES[row(id)?.media_type] || 0);
    } else {
      _countingTimer = setTimeout(() => {
        if (seq !== res.seq || res.ids) return;
        res.counting = true;
        emit('vault:counting');
      }, COUNTING_DELAY_MS);
      if (needIds) startIds();
      else _idsTimer = setTimeout(() => { if (seq === res.seq) startIds(); }, IDS_FALLBACK_MS);
    }
    noteIndexState(res.search && res.search.indexState, res.search && res.search.indexProgress);
    lastResultAt = Date.now();
    // Painting waits for what the first render needs (the vault's thumbnail
    // mode, the end of a one-time "preparing" step).
    await renderGate;
    if (seq !== _seq) return false;
    emit('vault:results-changed');
    return true;
  }

  /** The grid painted the first page: the id list may start now. */
  function firstPageShown() {
    if (!res.ids && res.qid) startIds();
  }

  /** An empty result with no query (the Collections tab home, a failed search). */
  function setEmpty({ search = null } = {}) {
    const seq = ++_seq;
    resetResult(seq);
    res.spec = null;
    res.empty = true;
    res.search = search;
    res.ids = new Uint32Array(0);
    res.types = new Uint8Array(0);
    res.total = 0;
    emit('vault:results-changed');
  }

  /** Shuffle the result in place (collection Shuffle): the grid follows. */
  async function shuffle() {
    const ids = await waitIds();
    if (!ids) return false;
    const types = res.types;
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
      const u = types[i]; types[i] = types[j]; types[j] = u;
    }
    res.shuffled = true;
    return true;
  }

  /**
   * Rows for result positions [start, end). Waits for the id list when the
   * range runs past the first page.
   */
  async function rowsForRange(start, end, opts) {
    start = Math.max(0, start);
    if (!known() || (!res.ids && end > res.firstIds.length)) {
      if (end > res.firstIds.length) await waitIds();
    }
    end = Math.min(end, length());
    const ids = [];
    for (let i = start; i < end; i++) ids.push(idAt(i));
    const rows = await fetchRows(ids, opts);
    for (const id of ids) touch(id);
    return rows;
  }

  /* ── One-off queries (pickers, side counts) ─────────────────────────── */

  /**
   * A query that does not touch the grid's result.
   * @returns {Promise<{rows, ids, total, complete, search}>} rows: the first
   *   page (cached too); ids: every id when opts.allIds, else the page's.
   */
  async function queryOnce(spec, { pageSize: size = 200, allIds: wantAll = false } = {}) {
    await bootGate;
    const out = await postQuery(spec, Math.max(1, Math.min(PAGE_MAX, size)));
    if (!out.ok) throw new QueryFailed(out.status, out.data.error || `Server returned ${out.status}`, out.data.code);
    const data = out.data;
    const rows = (data.page.rows || []).map(putRow).filter(Boolean);
    evict();
    let ids = data.page.ids || [];
    let total = data.complete ? ids.length : null;
    if (wantAll && !data.complete) {
      const resp = await fetch(`/api/library/query/${encodeURIComponent(data.qid)}/ids`);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        const n = new DataView(buf).getUint32(0, true);
        ids = new Uint32Array(buf, 8, n);
        total = n;
      }
    }
    return { rows, ids, total, complete: !!data.complete, search: data.search || null };
  }

  /** Counts for a selection too big to fetch rows for (6.6). */
  async function idsSummary(ids) {
    const body = ids instanceof Uint32Array ? ids : Uint32Array.from(ids);
    const resp = await fetch('/api/library/ids-summary', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
    });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    return resp.json();
  }

  /* ── Facets ─────────────────────────────────────────────────────────── */

  let facets = null;
  let _facetsEtag = null;
  let _facetsPromise = null;

  function refreshFacets() {
    if (_facetsPromise) return _facetsPromise;
    _facetsPromise = (async () => {
      await bootGate;
      const gen = _gen;
      try {
        const headers = { 'X-Vault-Background': '1' };
        if (_facetsEtag && facets) headers['If-None-Match'] = _facetsEtag;
        const resp = await fetch('/api/library/facets', { headers, cache: 'no-store' });
        if (gen !== _gen) return facets;
        if (resp.status === 304) return facets;
        if (!resp.ok) return facets;
        const data = await resp.json();
        if (gen !== _gen) return facets;
        facets = data;
        _facetsEtag = resp.headers.get('ETag');
        api.facets = facets;
        noteIndexState(data.indexState, null);
        emit('vault:facets-changed');
      } catch { /* the next poll tries again */ }
      return facets;
    })().finally(() => { _facetsPromise = null; });
    return _facetsPromise;
  }

  /* ── Index state (first launch after the update builds search indexes) ─ */

  const index = { state: 'ready', progress: null, step: null, steps: null };

  function noteIndexState(state, progress) {
    if (!state) return;
    const s = state === 'ready' ? 'ready' : state;
    const was = index.state;
    index.state = s;
    if (progress != null) index.progress = progress;
    if (s === 'ready') index.progress = null;
    if (was !== s) emit('vault:index-state', { from: was, to: s });
  }

  /* ── Version polling ────────────────────────────────────────────────── */

  let lastResultAt = 0;
  let _locked = false;
  let _lostServer = false;   // a request failed for want of a server: recover on the next good poll
  let _seenVersion = null;
  let _pollTimer = null;
  let _pollBusy = false;
  let _deferred = false;
  let _ownWrites = 0;
  let _autoBusyUntil = 0;
  let _lastAutoMs = 0;
  let onLibraryChanged = null;   // set by filters.js: re-run the query, keep the place

  /** The player or the detail view is open: a re-query would move things under it. */
  function viewerBusy() {
    if (document.getElementById('mediaPlayerOverlay')?.classList.contains('active')) return true;
    if (document.getElementById('miniPlayer')?.classList.contains('active')) return true;
    if (document.getElementById('modalOverlay')?.classList.contains('active')) return true;
    return false;
  }

  function markAllStale() {
    for (const id of cache.keys()) stale.add(id);
    gone.clear();
  }

  /** Refresh just the pinned rows (the open item), and say which changed. */
  async function refreshPinned() {
    const ids = new Set();
    for (const s of pins.values()) for (const id of s) ids.add(id);
    if (!ids.size) return;
    const before = new Map();
    for (const id of ids) {
      const r = cache.get(id);
      if (r) before.set(id, r.processing_error);
    }
    await fetchRows([...ids], { force: true });
    for (const id of ids) {
      const r = cache.get(id);
      if (r) emit('vault:row-updated', { id, scanLanded: before.get(id) === 'unscanned' && r.processing_error !== 'unscanned' });
    }
  }

  async function runAutoRequery() {
    if (!onLibraryChanged) return;
    const t0 = Date.now();
    _autoBusyUntil = Infinity;
    try { await onLibraryChanged(); } catch {}
    _lastAutoMs = Date.now() - t0;
    // A big library's id list can take a second or two to build: never spend
    // more than about a fifth of the server's time re-running it.
    _autoBusyUntil = Date.now() + Math.max(POLL_MS, _lastAutoMs * 4);
  }

  async function pollOnce() {
    // Locked: nothing to poll until the unlock reloads the page.
    if (_pollBusy || _locked || document.hidden) return;
    _pollBusy = true;
    const gen = _gen;
    try {
      let v;
      try {
        const resp = await fetch('/api/library/version', { headers: { 'X-Vault-Background': '1' }, cache: 'no-store' });
        // An HTTP error is an answer: only no response at all means the server
        // went away (and earns a re-run once it is back).
        if (!resp.ok) return;
        v = await resp.json();
      } catch { _lostServer = true; return; }
      if (gen !== _gen) return;
      // Back after a restart or a network error: whatever was asked meanwhile
      // (a search, rows for the tiles) may have gone unanswered, so the query
      // runs again, keeping the place, even if the version did not move.
      const recovered = _lostServer;
      _lostServer = false;
      const wasState = index.state;
      noteIndexState(v.index && v.index.state, v.index && v.index.progress);
      if (v.index) { index.step = v.index.step; index.steps = v.index.steps; }
      if (index.state === 'building') emit('vault:index-progress');
      const indexDone = wasState !== 'ready' && index.state === 'ready';

      // The counts follow every change, whatever the grid is showing.
      if (v.version !== _seenVersion || indexDone || (facets && facets.stale)) {
        _seenVersion = v.version;
        refreshFacets();
      }
      if (recovered) {
        markAllStale();
        if (viewerBusy()) { _deferred = true; refreshPinned(); return; }
        await runAutoRequery();
        return;
      }
      if (_ownWrites > 0 || _ackTimer) return;
      if (res.version == null && !indexDone) return;
      if (v.version === res.version && !indexDone) return;
      // Something changed the library (a scan, another window, the CLI).
      if (viewerBusy() && !indexDone) {
        _deferred = true;
        markAllStale();
        res.version = v.version;     // remembered: run once the viewer closes
        refreshPinned();
        return;
      }
      if (Date.now() < _autoBusyUntil) return;
      markAllStale();
      await runAutoRequery();
    } finally {
      _pollBusy = false;
    }
  }

  /** The player or detail view closed: run a re-query that waited for it. */
  function resumeDeferred() {
    if (!_deferred || viewerBusy()) return;
    _deferred = false;
    runAutoRequery();
  }

  function startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(pollOnce, POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollOnce(); });
  }

  /**
   * Our own edit (a rating, a fave, a note, a tag) bumps the library version
   * too. Today's grid never re-filtered on those, so the version they produce
   * is taken as seen rather than re-running the query under the user's hand.
   * The counts are refreshed, since a fave or a rating moves them.
   */
  async function ownWrite(promise) {
    _ownWrites++;
    clearTimeout(_ackTimer);
    try {
      return await promise;
    } finally {
      _ownWrites--;
      // A burst of edits (bulk flag) is acknowledged once, after the last.
      if (_ownWrites === 0) _ackTimer = setTimeout(ackOwnWrites, 300);
    }
  }

  /* Known limit (verifier round 2, D5): a change from elsewhere that lands in
     the ~300 ms between our own write and this acknowledgement is taken as
     seen with it, so it does not re-run the query by itself. The API has no
     way to tell our bumps from someone else's without a server change; the
     next outside change (a scan bumps the version every file) re-runs the
     query, and the counts are refreshed here either way. */
  let _ackTimer = null;
  async function ackOwnWrites() {
    _ownWrites++;               // the poll stays out until this is done
    try {
      const resp = await fetch('/api/library/version', { headers: { 'X-Vault-Background': '1' }, cache: 'no-store' });
      if (resp.ok) {
        const v = await resp.json();
        if (res.version != null && !_deferred) res.version = v.version;
      }
    } catch {}
    _ownWrites--;
    _ackTimer = null;
    refreshFacets();
  }

  /* ── Boot gate (after an unlock, the server may still be preparing) ── */

  let _bootOpen;
  const bootGate = new Promise(r => { _bootOpen = r; });
  let renderGate = Promise.resolve();

  /**
   * Wait out the one-time "preparing" step (spec 6.5). The server answers
   * between index statements, but one statement can hold it for half a
   * minute on a big encrypted library, so no timeout and retry on errors.
   * @param {(index) => void} onProgress  called while preparing
   */
  async function boot(onProgress) {
    let state = 'ready';
    for (;;) {
      let v = null;
      try {
        const resp = await fetch('/api/library/version', { headers: { 'X-Vault-Background': '1' }, cache: 'no-store' });
        if (resp.status === 423) { state = 'locked'; break; }   // the lock screen owns the page
        if (resp.ok) v = await resp.json();
      } catch { /* the server is busy with a statement: try again */ }
      if (v && v.index) {
        index.step = v.index.step;
        index.steps = v.index.steps;
        if (v.index.state !== 'preparing') {
          noteIndexState(v.index.state, v.index.progress);
          break;
        }
        index.state = 'preparing';
        onProgress && onProgress(index);
      }
      await new Promise(r => setTimeout(r, v ? 1000 : 1500));
    }
    _bootOpen();
    startPolling();
    return state;
  }

  /* ── Lock ───────────────────────────────────────────────────────────── */

  function clear() {
    _gen++;
    _locked = true;
    _seq++;
    resetResult(_seq);
    res.spec = null;
    res.empty = true;
    res.version = null;
    res.ids = new Uint32Array(0);
    res.types = new Uint8Array(0);
    res.total = 0;
    cache.clear();
    byPath.clear();
    stale.clear();
    gone.clear();
    inflight.clear();
    pins.clear();
    facets = null;
    api.facets = null;
    _facetsEtag = null;
    _deferred = false;
  }

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  }

  /** After an edit response: update the cached row and tell the surfaces. */
  function patchRow(r) {
    const out = putRow(r);
    if (out) emit('vault:row-updated', { id: out.id });
    return out;
  }

  /** Visit every cached row (a dupe group's shared notes, for one). */
  function eachCachedRow(fn) {
    for (const r of cache.values()) fn(r);
  }

  /** A record left the library (delete, forget): drop it from the cache. */
  function forget(ids) {
    for (const id of ids) {
      const r = cache.get(id);
      if (r && byPath.get(r.filepath) === id) byPath.delete(r.filepath);
      cache.delete(id);
      stale.delete(id);
      gone.add(id);
    }
  }

  const api = {
    TYPE_CODES, TYPE_NAMES,
    get spec() { return res.spec; },
    get version() { return res.version; },
    get ids() { return res.ids; },
    get types() { return res.types; },
    get total() { return known() ? length() : null; },
    get search() { return res.search; },
    get counting() { return res.counting; },
    get isEmptyResult() { return res.empty; },
    get firstPageIds() { return res.firstIds; },
    get index() { return index; },
    get deferred() { return _deferred; },
    facets: null,
    QueryFailed, RowsUnavailable,
    length, known, idAt, typeAt, indexOf, rowAt, allIds, waitIds,
    row, rowByPath, eachCachedRow, fetchRows, needsFetch, rowsForRange, putRow, patchRow, forget, pin, isPinned,
    query, settled, queryOnce, setEmpty, firstPageShown, shuffle, idsSummary,
    refreshFacets, boot, resumeDeferred, ownWrite, clear,
    invalidateRows: markAllStale,
    /** A query failed for want of a server: re-run it once polling gets an answer. */
    noteServerLost() { _lostServer = true; },
    set onLibraryChanged(fn) { onLibraryChanged = fn; },
    set renderGate(p) { renderGate = Promise.resolve(p).catch(() => {}); },
    get onLibraryChanged() { return onLibraryChanged; },
    _stats: () => ({ rows: cache.size, stale: stale.size, gone: gone.size, pins: [...pins.values()].reduce((n, s) => n + s.size, 0) }),
  };
  return api;
})();

window.Library = Library;
