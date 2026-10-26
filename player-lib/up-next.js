/* =========================================================================
   UP NEXT - the saved queue that plays before the list carries on
   (PLAYLISTS_SPEC step 4; the server side is lib/play-queue.js and
   /api/queue, the advance rule player-lib/up-next-rule.js).

   This module owns the client's copy of Up next. It loads it once, and
   every change goes to the server, whose answer (the whole list) is what
   every surface redraws from:
   - the mini player's Up next button and the list that opens above it
   - the Modern player panel's Up next tab, and the "Up next n" button in
     the Modern dock
   - Classic's Up next section at the top of Info & Notes
   - the small "Up next 1" tag on tiles in the grid
   Adding: Play next / + Up next in the dock (Modern), the selection bar and
   the details; U and Shift+U (this file's keydown listener).

   player-core.js asks count() and shift() when it moves on, and calls
   playerChanged() when a file opens. Stage (step 5) can later drive the same
   state from the mini player acting as its remote.
   ========================================================================= */

const UpNext = (() => {
  let items = [];             // [{ id, filename, filepath, media_type, duration_seconds, thumb_version, missing_since, source }]
  let byId = new Map();       // id -> position
  let chain = Promise.resolve();   // every request, one after another
  const shiftLog = [];        // ids shift() took out to play, oldest first
  const taken = new Set();    // ids shift() took whose removal the server has not answered yet
  // How long a request may take before it counts as failed, and how long a
  // move to the next file waits for changes still on their way.
  const LIMITS = { request: 8000, wait: 1500 };
  let popOpen = false;
  let thenGen = 0;
  let drag = null;            // { id, list } while a row is dragged

  const esc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s == null ? '' : s))
    : String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

  function ids() { return items.map(i => i.id); }
  function count() { return items.length; }
  function positionOf(id) { const i = byId.get(Number(id)); return i === undefined ? -1 : i; }

  function setItems(list) {
    // A file already taken to play never shows again while its removal is on its way.
    items = (Array.isArray(list) ? list : []).filter(it => !taken.has(it.id));
    byId = new Map(items.map((it, i) => [it.id, i]));
    render();
  }

  /* ── Talking to the server ─────────────────────────────────────────── */

  async function responseError(resp) {
    const body = await resp.json().catch(() => ({}));
    const err = new Error(body.error || `Server returned ${resp.status}`);
    err.status = resp.status;
    err.code = body.code;
    if (!body.error) err.name = 'HttpError';
    return err;
  }

  /**
   * Run a task after every task before it. Each task reads Up next as the
   * answer to the previous request left it, sends at most a request or two
   * and applies the answer before the next task starts, so answers are
   * applied in order and no change works from a stale list.
   */
  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  /**
   * Resolves once every change asked for so far has been answered, or after
   * `ms` at the most (Next and a file ending never wait on a slow server).
   */
  function settled(ms) {
    if (!(ms > 0)) return chain;
    return Promise.race([chain, new Promise(resolve => setTimeout(resolve, ms))]);
  }

  function timeoutError() {
    const err = new Error('Vault took too long to answer');
    err.name = 'TimeoutError';
    return err;
  }

  let seq = 0;          // requests sent
  let applied = 0;      // the newest request whose answer is on screen

  /** One request (inside a task). Its answer replaces the list, unless a newer one is already applied. */
  async function send(op, body) {
    const n = ++seq;
    // A request that never answers fails after LIMITS.request, and the queue
    // carries on exactly as after a network error.
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => { if (ctl) ctl.abort(); reject(timeoutError()); }, LIMITS.request);
    });
    const opts = op === 'get' ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    };
    if (ctl) opts.signal = ctl.signal;
    let data;
    try {
      data = await Promise.race([(async () => {
        const resp = await fetch(op === 'get' ? '/api/queue' : `/api/queue/${op}`, opts);
        if (!resp.ok) throw await responseError(resp);
        return resp.json();
      })(), late]);
    } finally {
      clearTimeout(timer);
    }
    if (n > applied) {
      applied = n;
      setItems(data.items);
    }
    return data;
  }

  /** Read Up next from the server again (after a failed change, a fresh library). */
  function load() {
    return enqueue(() => send('get').catch(() => { /* offline or locked: keep what is shown */ }));
  }

  /** A change failed: say so, then show what the server really has. */
  async function failed(err, what) {
    errorToast(err, what);
    await send('get').catch(() => {});
  }

  const ERROR_TEXT = {
    NOT_MEMBER: 'Up next changed in the meantime. Try again.',
    BEFORE_NOT_MEMBER: 'Up next changed in the meantime. Try again.',
    TOO_MANY: 'That is too many files to add at once.',
  };

  function errorToast(err, what) {
    if (err && err.status === 423) return;   // locked: the lock screen says it
    if (err && ERROR_TEXT[err.code]) showToast(ERROR_TEXT[err.code], { type: 'error' });
    else if (typeof showErrorToast === 'function') showErrorToast(err, what);
  }

  /**
   * A toast with Undo. `invert(now, skip)` works out the list that undoes
   * this one change from Up next as it is when Undo is pressed; `skip` holds
   * the files that started playing since (they are never put back).
   */
  function undoToast(message, invert) {
    const mark = shiftLog.length;
    const playingThen = playingId();
    const text = esc(message);
    const undo = () => enqueue(async () => {
      // Started playing since: taken by Up next, or opened some other way.
      const skip = shiftLog.slice(mark);
      const playing = playingId();
      if (playing && playing !== playingThen) skip.push(playing);
      const now = ids();
      const next = invert(now, skip);
      if (next.length === now.length && next.every((id, i) => id === now[i])) return;
      try {
        const data = await send('replace', { ids: next, source: 'undo' });
        if (data.refused && data.refused.length) showToast(refusedText(data.refused).replace('not added', 'not put back'), { type: 'error' });
      } catch (err) {
        await failed(err, 'undoing the change to Up next');
      }
    });
    if (typeof showUndoToast === 'function') showUndoToast(text, undo);
    else showToast(message);
  }

  function nameOf(id, list) {
    const it = (list || items).find(x => x.id === id);
    const row = !it && typeof Library !== 'undefined' ? Library.row(id) : null;
    return (it && it.filename) || (row && row.filename) || 'the file';
  }

  /** Words for files the server would not add (in the trash, or gone). */
  function refusedText(refused) {
    const list = refused || [];
    if (!list.length) return '';
    const trashed = list.filter(r => r.reason === 'trashed').length;
    const gone = list.length - trashed;
    const why = [trashed ? `${trashed} in the trash` : '', gone ? `${gone} no longer in the library` : ''].filter(Boolean).join(', ');
    return `${list.length === 1 ? '1 file was' : `${list.length} files were`} not added (${why})`;
  }

  /* ── Changes ───────────────────────────────────────────────────────── */

  /**
   * Add files at the front ('next') or the end ('end'). A file already in
   * Up next moves there. Toast with Undo.
   */
  function add(list, where, { source = null } = {}) {
    const clean = [...new Set((list || []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
    if (!clean.length) return Promise.resolve(null);
    return enqueue(async () => {
      const before = ids();
      let data;
      try {
        data = await send('add', { ids: clean, where: where === 'next' ? 'next' : 'end', ...(source ? { source } : {}) });
      } catch (err) {
        await failed(err, 'adding to Up next');
        return null;
      }
      const refused = data.refused || [];
      const no = new Set(refused.map(r => r.id));
      const added = clean.filter(id => !no.has(id));
      if (!added.length) {
        showToast(refusedText(refused), { type: 'error' });
        return data;
      }
      const one = added.length === 1 ? `“${nameOf(added[0], data.items)}”` : null;
      let msg = where === 'next'
        ? (one ? `${one} plays next` : `${added.length} files play next`)
        : (one ? `Added ${one} to Up next` : `Added ${added.length} files to Up next`);
      if (refused.length) msg += `. ${refusedText(refused)}`;
      undoToast(msg, (now) => UpNextRule.undoAdd(now, before, added));
      return data;
    });
  }

  function removeId(id) {
    const target = Number(id);
    return enqueue(async () => {
      const before = ids();
      if (!before.includes(target)) return;
      const name = nameOf(target);
      try {
        await send('remove', { ids: [target] });
      } catch (err) {
        await failed(err, 'removing from Up next');
        return;
      }
      undoToast(`Removed “${name}” from Up next`, (now, skip) => UpNextRule.undoRemove(now, before, [target], skip));
    });
  }

  function clear() {
    return enqueue(async () => {
      const before = ids();
      if (!before.length) return;
      try {
        await send('clear', {});
      } catch (err) {
        await failed(err, 'clearing Up next');
        return;
      }
      undoToast(`Cleared Up next (${before.length === 1 ? '1 file' : `${before.length} files`})`,
        (now, skip) => UpNextRule.undoClear(now, before, skip));
    });
  }

  /** Drag to reorder: move `id` to sit before `beforeId` (null: the end), after any change still on its way. */
  function move(id, beforeId) {
    return enqueue(async () => {
      const cur = ids();
      if (!cur.includes(id)) return;
      const order = cur.filter(x => x !== id);
      const at = beforeId == null || !order.includes(beforeId) ? order.length : order.indexOf(beforeId);
      order.splice(at, 0, id);
      if (order.every((x, i) => x === cur[i])) return;
      // Shown at once, then the server's answer.
      const pos = new Map(items.map(it => [it.id, it]));
      setItems(order.map(x => pos.get(x)));
      try {
        await send('move', { move: [id], before: at < order.length - 1 ? order[at + 1] : null });
      } catch (err) {
        await failed(err, 'rearranging Up next');
      }
    });
  }

  /**
   * The first file, taken out of Up next to play (player-core.js). Waits
   * for changes still on its way (up to LIMITS.wait), so a file ending right
   * after Shift+U plays the new first file. Resolves as soon as that file is
   * known; the server catches up behind.
   */
  function shift({ wait = LIMITS.wait } = {}) {
    return new Promise((resolve) => {
      let decided = false;
      let item = null;
      const decide = () => {
        if (decided) return;
        decided = true;
        item = items[0] || null;
        if (item) {
          shiftLog.push(item.id);
          taken.add(item.id);
          setItems(items.slice(1));
        }
        resolve(item);
      };
      // Changes still on their way get LIMITS.wait to land; past that the
      // first file shown now plays, and its removal follows them.
      const timer = setTimeout(decide, Math.max(0, Number(wait) || 0));
      enqueue(async () => {
        clearTimeout(timer);
        decide();
        if (!item) return;
        try {
          await send('remove', { ids: [item.id] });
        } catch {
          taken.delete(item.id);
          await send('remove', { ids: [item.id] }).catch(() => send('get').catch(() => {}));
        } finally {
          taken.delete(item.id);
        }
      });
    });
  }

  /**
   * Put a file shift() took back at the front (its row could not be loaded,
   * so it never played).
   */
  function unshift(item) {
    if (!item) return Promise.resolve();
    return enqueue(async () => {
      const i = shiftLog.lastIndexOf(item.id);
      if (i !== -1) shiftLog.splice(i, 1);
      taken.delete(item.id);
      if (ids().includes(item.id)) return;
      setItems([item, ...items]);
      try { await send('add', { ids: [item.id], where: 'next' }); } catch { await send('get').catch(() => {}); }
    });
  }

  /* ── What the keys and buttons act on ──────────────────────────────── */

  /** The ticked files in result order (files not in the results last). */
  function orderedSelection() {
    const sel = typeof selectedIds !== 'undefined' ? [...selectedIds] : [];
    if (typeof Library === 'undefined') return sel;
    const at = (id) => { const i = Library.indexOf(id); return i < 0 ? Infinity : i; };
    return sel.map((id, k) => ({ id, i: at(id), k })).sort((a, b) => (a.i - b.i) || (a.k - b.k)).map(x => x.id);
  }

  /** The library's pick: two or more ticked files win, else the dock's pick, else one ticked file. */
  function libraryTargets() {
    const sel = typeof selectedIds !== 'undefined' ? selectedIds : new Set();
    if (sel.size >= 2) return orderedSelection();
    if (typeof dockIsShown === 'function' && dockIsShown()
        && typeof _dockSelectedId !== 'undefined' && _dockSelectedId != null) return [_dockSelectedId];
    if (sel.size === 1) return [...sel];
    return [];
  }

  /** The file playing in the player or the mini player, or null. */
  function playingId() {
    if (typeof currentMediaState === 'undefined') return null;
    return currentMediaState.playbackMediaId || (currentMediaState.currentMediaData && currentMediaState.currentMediaData.id) || null;
  }

  function overlayOpen() { return !!document.getElementById('mediaPlayerOverlay')?.classList.contains('active'); }
  function miniOpen() { return !!document.getElementById('miniPlayer')?.classList.contains('active'); }

  /* ── Drawing ───────────────────────────────────────────────────────── */

  function lengthText(it) {
    if (it.media_type === 'image') return 'Picture';
    if (it.media_type === 'document') return 'Document';
    return it.duration_seconds && typeof formatDuration === 'function' ? formatDuration(it.duration_seconds) : '';
  }

  function rowHtml(it, i) {
    const thumb = typeof canShowThumb === 'function' && typeof thumbImgAttrs === 'function' && canShowThumb(it)
      ? `<img class="un-img" ${thumbImgAttrs(it)} alt="" draggable="false" loading="lazy" onerror="this.parentElement.classList.add('un-th-fallback'); this.remove();">`
      : '';
    const icon = typeof vaultTypeIcon === 'function' ? vaultTypeIcon(it.media_type) : '';
    const name = esc(it.filename);
    return `<div class="un-row${i === 0 ? ' un-first' : ''}" role="listitem" draggable="true" data-un-id="${it.id}">
      <span class="un-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
      <span class="un-th${thumb ? '' : ' un-th-fallback'}">${thumb}<span class="un-ti">${icon}</span></span>
      <span class="un-tt">${name}</span>
      <span class="un-du">${esc(lengthText(it))}</span>
      <button type="button" class="un-x" onclick="UpNext.removeId(${it.id})" title="Remove from Up next" aria-label="Remove ${name} from Up next">${typeof vaultIconSwap === 'function' ? vaultIconSwap('✕', 'close') : '✕'}</button>
    </div>`;
  }

  function headHtml() {
    const n = items.length;
    return `<div class="un-head">
      <h3 class="un-title">Up next</h3><span class="un-badge"${n ? '' : ' hidden'}>${n}</span>
      <span class="un-sp"></span>
      <button type="button" class="un-clear" onclick="UpNext.clear()"${n ? '' : ' disabled'}>Clear</button>
    </div>`;
  }

  /** One surface's list. `head`: the title row with the count and Clear. */
  function listHtml(head) {
    const rows = items.map(rowHtml).join('');
    return `${head ? headHtml() : ''}
      <div class="un-list" role="list" aria-label="Up next">${rows || '<p class="un-empty">Nothing lined up. Press U on a file to add it, or Shift+U to play it next.</p>'}</div>
      <div class="un-then" data-un-then hidden></div>`;
  }

  /** "Then the list carries on: ..." under every list on screen. */
  function refreshThen() {
    const els = document.querySelectorAll('[data-un-then]');
    if (!els.length) return;
    const playing = overlayOpen() || miniOpen();
    if (!playing || typeof upNextListContinuation !== 'function') { els.forEach(e => { e.hidden = true; }); return; }
    const gen = ++thenGen;
    upNextListContinuation().then((row) => {
      if (gen !== thenGen) return;
      const html = row ? `Then the list carries on: <b>${esc(row.filename)}</b>` : 'Then the list ends.';
      document.querySelectorAll('[data-un-then]').forEach(e => { e.innerHTML = html; e.hidden = false; });
      if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
    }).catch(() => {});
  }

  function paintTiles() {
    document.querySelectorAll('.media-tile[data-id] > .tile-thumb').forEach((th) => {
      const id = Number(th.parentElement.dataset.id);
      const i = positionOf(id);
      let tag = th.querySelector(':scope > .tile-upnext');
      if (i < 0) { if (tag) tag.remove(); return; }
      if (!tag) {
        th.insertAdjacentHTML('beforeend', tileTag(id));
        return;
      }
      tag.textContent = `Up next ${i + 1}`;
    });
  }

  /** The tile's tag (cards.js renderTile), '' for a file not in Up next. */
  function tileTag(id) {
    const i = positionOf(id);
    return i < 0 ? '' : `<span class="tile-upnext" title="In Up next">Up next ${i + 1}</span>`;
  }

  /** Redraw every surface from the current list. */
  function render() {
    const n = items.length;
    const badge = document.getElementById('miniUpNextCount');
    if (badge) { badge.textContent = String(n); badge.hidden = !n; }
    const btn = document.getElementById('miniUpNextBtn');
    if (btn) btn.setAttribute('aria-label', n ? `Up next, ${n === 1 ? '1 file' : `${n} files`}` : 'Up next');
    const pill = document.getElementById('mpUpNextBtn');
    if (pill) {
      const c = pill.querySelector('.mp-un-n');
      if (c) { c.textContent = n ? String(n) : ''; c.hidden = !n; }
      pill.setAttribute('aria-label', n ? `Up next, ${n === 1 ? '1 file' : `${n} files`}` : 'Up next');
    }
    document.querySelectorAll('[data-un-surface]').forEach((el) => {
      el.innerHTML = listHtml(el.dataset.unSurface !== 'classic');
      if (typeof hydrateThumbs === 'function') hydrateThumbs(el);
    });
    document.querySelectorAll('[data-un-classic]').forEach((el) => { el.hidden = !n; });
    document.querySelectorAll('.mpp [data-mpp-tab="upnext"] .mpp-count').forEach((el) => { el.textContent = n ? String(n) : ''; });
    // Next follows Up next both ways: somewhere to go while it has files,
    // back to the list's own answer when it empties (player-core.js).
    if (overlayOpen() && typeof playerHasNext === 'function') {
      const can = playerHasNext();
      document.querySelectorAll('#mpNext, #mediaPlayerControls [onclick^="playNextMedia"]').forEach((b) => { b.disabled = !can; });
    }
    paintTiles();
    if (popOpen) positionPopover();
    refreshThen();
    // The lists changed size: toasts move clear of them (utils.js).
    if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
  }

  /* ── The list above the mini player ────────────────────────────────── */

  function popEl() {
    let el = document.getElementById('upNextPop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'upNextPop';
      el.className = 'un-pop';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', 'Up next');
      el.hidden = true;
      el.innerHTML = '<div data-un-surface="pop"></div>';
      document.body.appendChild(el);
      // The list grows and shrinks (a row removed, the footer filled in):
      // toasts re-place against its new size. Placing toasts never resizes
      // the list, so this cannot loop.
      if (typeof ResizeObserver === 'function' && typeof vaultPlaceToasts === 'function') {
        new ResizeObserver(() => { if (popOpen) vaultPlaceToasts(); }).observe(el);
      }
    }
    return el;
  }

  function openPopover() {
    if (!miniOpen()) return;
    const el = popEl();
    popOpen = true;
    el.hidden = false;
    document.getElementById('miniUpNextBtn')?.setAttribute('aria-expanded', 'true');
    render();
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
  }

  function closePopover() {
    if (!popOpen) return;
    popOpen = false;
    const el = document.getElementById('upNextPop');
    if (el) el.hidden = true;
    document.getElementById('miniUpNextBtn')?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
  }

  function togglePopover() {
    if (popOpen) closePopover(); else openPopover();
  }

  function onOutside(e) {
    const el = document.getElementById('upNextPop');
    const btn = document.getElementById('miniUpNextBtn');
    if ((el && el.contains(e.target)) || (btn && btn.contains(e.target))) return;
    // The toasts (Undo after a ✕ or Clear in this list) count as inside.
    if (e.target.closest && e.target.closest('#undoToast, #toast')) return;
    closePopover();
  }

  /**
   * Above the mini player, lined up with its outer edge; below it when there
   * is more room there (a box snapped to a top corner).
   */
  function positionPopover() {
    if (!popOpen) return;
    const mini = document.getElementById('miniPlayer');
    const el = document.getElementById('upNextPop');
    if (!el || !mini || !mini.classList.contains('active')) { closePopover(); return; }
    const r = mini.getBoundingClientRect();
    const de = document.documentElement;
    const vw = de.clientWidth || window.innerWidth;
    const vh = de.clientHeight || window.innerHeight;
    const gap = 8;
    const w = Math.min(340, vw - 2 * gap);
    el.style.width = `${w}px`;
    const rightSide = r.left + r.width / 2 > vw / 2;
    const left = Math.max(gap, Math.min(vw - w - gap, rightSide ? r.right - w : r.left));
    el.style.left = `${left}px`;
    const above = r.top - 2 * gap;
    const below = vh - r.bottom - 2 * gap;
    el.style.maxHeight = '';
    el.style.top = '0px';
    el.style.bottom = 'auto';
    const natural = el.offsetHeight;
    const up = above >= natural || above >= below;
    const room = Math.max(120, up ? above : below);
    el.style.maxHeight = `${room}px`;
    // Pinned by its edge nearest the box, so a list that grows (the footer,
    // a file added) grows away from the mini player, never over it.
    if (up) {
      el.style.top = 'auto';
      el.style.bottom = `${vh - r.top + gap}px`;
    } else {
      el.style.top = `${r.bottom + gap}px`;
    }
    el.classList.toggle('un-pop-below', !up);
    // Toasts step out of the list's way too (utils.js).
    if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
  }

  /* ── The player panel ──────────────────────────────────────────────── */

  /** The Modern panel's Up next tab body (detail-view.js renderDetailPanel). */
  function panelPaneHtml() { return '<div class="un-panel" data-un-surface="panel"></div>'; }

  /** Classic: the section at the top of Info & Notes, shown while Up next has files. */
  function classicSectionHtml() {
    return `<div class="detail-section un-classic" data-un-classic${items.length ? '' : ' hidden'}>
      <h3 class="un-classic-h">Up next <button type="button" class="un-clear" onclick="UpNext.clear()">Clear</button></h3>
      <div data-un-surface="classic"></div>
    </div>`;
  }

  /** The side panel for a file outside the results: Up next alone. */
  function sidebarOnlyHtml() {
    return '<div class="detail-section un-side" data-un-surface="side"></div>';
  }

  /** The Modern dock's "Up next n" button (player-modern.js). */
  function dockButtonHtml() {
    const n = items.length;
    const icon = typeof vaultIcon === 'function' ? vaultIcon('queue', 'mp-i') : '';
    return `<button type="button" class="mp-ic mp-pill mp-upnext" id="mpUpNextBtn" onclick="UpNext.openPanel()"
      title="Up next: what plays before the list carries on" aria-label="${n ? `Up next, ${n === 1 ? '1 file' : `${n} files`}` : 'Up next'}"
      >${icon}<span class="mp-un-label">Up next</span><span class="mp-un-n"${n ? '' : ' hidden'}>${n || ''}</span></button>`;
  }

  /** Open the player's side panel on its Up next tab. */
  function openPanel() {
    if (typeof sidebarOpen !== 'undefined' && !sidebarOpen && typeof toggleSidebar === 'function') toggleSidebar();
    const root = document.querySelector('#mediaSidebarBody .mpp');
    if (root && typeof detailPanelSelect === 'function') detailPanelSelect('upnext', { root });
    else document.querySelector('#mediaSidebarBody [data-un-classic], #mediaSidebarBody .un-side')?.scrollIntoView({ block: 'start' });
    if (document.activeElement && document.activeElement.matches && document.activeElement.matches('.note-input-field')) {
      document.activeElement.blur();
    }
  }

  /* ── Drag to reorder (every list) ──────────────────────────────────── */

  function clearDropMarks() {
    document.querySelectorAll('.un-row.un-drop-before, .un-row.un-drop-after, .un-row.un-dragging')
      .forEach(r => r.classList.remove('un-drop-before', 'un-drop-after', 'un-dragging'));
  }

  document.addEventListener('dragstart', (e) => {
    const row = e.target.closest && e.target.closest('.un-row');
    if (!row) return;
    drag = { id: Number(row.dataset.unId), list: row.parentElement };
    row.classList.add('un-dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-vault-upnext', String(drag.id));
    } catch {}
    e.stopPropagation();
  });

  document.addEventListener('dragover', (e) => {
    if (!drag) return;
    const row = e.target.closest && e.target.closest('.un-row');
    if (!row || row.parentElement !== drag.list) return;
    e.preventDefault();
    e.stopPropagation();
    try { e.dataTransfer.dropEffect = 'move'; } catch {}
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    drag.list.querySelectorAll('.un-row').forEach(x => x.classList.remove('un-drop-before', 'un-drop-after'));
    if (Number(row.dataset.unId) !== drag.id) row.classList.add(after ? 'un-drop-after' : 'un-drop-before');
  }, true);

  document.addEventListener('drop', (e) => {
    if (!drag) return;
    const row = e.target.closest && e.target.closest('.un-row');
    const d = drag;
    drag = null;
    clearDropMarks();
    if (!row || row.parentElement !== d.list) return;
    e.preventDefault();
    e.stopPropagation();
    const target = Number(row.dataset.unId);
    if (target === d.id) return;
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    let before = target;
    if (after) {
      const order = ids().filter(x => x !== d.id);
      const i = order.indexOf(target);
      before = i + 1 < order.length ? order[i + 1] : null;
    }
    move(d.id, before);
  }, true);

  document.addEventListener('dragend', () => { if (drag) { drag = null; clearDropMarks(); } });

  /* ── Keys: U adds to the end, Shift+U plays next ───────────────────── */

  function keyTargets() {
    const modalId = Number(document.querySelector('.modal-overlay.active #modalBody .detail-body')?.dataset.mediaId);
    if (modalId) return { ids: [modalId], source: 'details' };
    if (overlayOpen()) { const id = playingId(); return { ids: id ? [id] : [], source: 'player' }; }
    if (miniOpen()) {
      // Pressed with the mini player in hand: the file playing. Otherwise the
      // library's pick (queueing while something plays is the point), and the
      // file playing when nothing is picked.
      const inMini = document.getElementById('miniPlayer')?.contains(document.activeElement);
      const lib = inMini ? [] : libraryTargets();
      if (lib.length) return { ids: lib, source: 'library' };
      const id = playingId();
      return { ids: id ? [id] : [], source: 'player' };
    }
    if (typeof dockGridTabVisible === 'function' && !dockGridTabVisible()) return null;
    return { ids: libraryTargets(), source: 'library' };
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'u' && e.key !== 'U') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (typeof isTypingTarget === 'function' ? isTypingTarget(t) : (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (typeof vaultModalOpen === 'function' && vaultModalOpen()) return;
    if (document.querySelector('.settings-overlay.active')) return;
    const target = keyTargets();
    if (!target) return;
    e.preventDefault();
    if (!target.ids.length) {
      showToast('Pick a file first, then press U to add it to Up next');
      return;
    }
    add(target.ids, e.shiftKey ? 'next' : 'end', { source: target.source });
  });

  // Esc closes the list before it reaches the mini player (which would close).
  window.addEventListener('keydown', (e) => {
    if (!popOpen || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closePopover();
    document.getElementById('miniUpNextBtn')?.focus({ preventScroll: true });
  }, true);

  window.addEventListener('resize', () => { if (popOpen) positionPopover(); });
  // A fresh library (first load, unlock): read Up next again.
  window.addEventListener('vault:library-loaded', load);
  load();

  return {
    _limits: LIMITS,   // tests shorten these
    count, ids, positionOf, load, settled, add, removeId, clear, move, shift, unshift,
    render, playerChanged: render, tileTag, libraryTargets, orderedSelection,
    togglePopover, openPopover, closePopover, positionPopover,
    panelPaneHtml, classicSectionHtml, sidebarOnlyHtml, dockButtonHtml, openPanel,
  };
})();

/* Inline handlers (dock, details, selection bar). */
function upNextAddFrom(id, where, source) {
  return UpNext.add([Number(id)], where, { source });
}
function upNextAddSelection(where) {
  return UpNext.add(UpNext.orderedSelection(), where, { source: 'selection' });
}
/** cards.js renderTile: the tile's "Up next 1" tag. */
function upNextTileTag(id) {
  return UpNext.tileTag(id);
}
