/* =========================================================================
   STREAM TAGS - your own labels for files in a stream set, in lanes (Role,
   Mood, Moments...). The server keeps them (lib/stream-tags.js,
   server/stream-tags-routes.js); this file keeps a copy the page reads
   synchronously, and every way of tagging:

     - Keys: hovering a tile or a table row (not typing), a tag's key
       toggles that tag on the file, or on the whole selection when the file
       is part of it. While Stage is open, the same keys tag the file on
       Stage when the pointer is over the Stage bar or the bar has focus.
       The keys stand aside for everything that already has them: the
       player (its own keys), the mini player and Stage (Q, N, P, R, H, 0 to
       9 and Space), any dialog, menu or Settings, and typing. ? and U are
       never tag keys (the server refuses them).
     - Right-click on a tile or row, and the selection bar's Stream tag
       button: a menu grouped by lane, ticks (a dash when only some of the
       files have it), Clear stream tags and Edit lanes... (Settings, Stage).
     - The Stage bar's + Tag button (StageBar.paint calls paintStage).
     - Chips on tiles (two, then +n) and in the table's Title cell.
     - The Stream tag filter (filters.js reads #filterStreamTag; the chip,
       the More sheet and the rail list come from filter-chips.js).

   The copy: lanes and every assignment, loaded once (GET /api/stream-tags
   and /assignments), updated from the answer of every change made here, and
   refreshed for a collection's files when it opens (refreshCollection).

   window.FlowLaneSource (the Flow chart's lane rows) reads the same copy:
     lanes()                      [{ key, label }] in lane order
     cells(laneKey, mediaIds)     per file, its tags in that lane [{ color, label }]
     chips(mediaId)               all of a file's tags [{ color, label }]
     onChange(cb)                 cb() after any change to lanes, tags or assignments

   Hooks other files call (guarded with typeof):
     streamTagTileHtml(media)     cards.js renderTile
     streamTagRowHtml(media)      table-view.js Title cell
     streamTagsSelectionButton()  selection.js renderSelectionBar
     StreamTags.paintStage(id)    stage-bar.js paint
     StreamTags.stageMenu(btn)    stage-bar.js act('tag')
     StreamTags.refreshCollection(id)  collections.js openCollection
   ========================================================================= */

const StreamTags = (() => {
  const PLACE_LABELS = {
    first: 'First', last: 'Last', peak: 'At a peak', after_peak: 'After a peak', low: 'At a low point', anywhere: 'Anywhere',
  };
  // The mini player's and Stage's keys (app.js, stage-control.js): theirs while either shows.
  const MINI_KEYS = new Set(['Q', 'N', 'P', 'R', 'H', ' ', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  const CHUNK = 50000;

  const st = {
    lanes: [],               // GET /api/stream-tags lanes, in order
    tags: new Map(),         // id -> tag (with laneId)
    lanesById: new Map(),
    rank: new Map(),         // tag id -> its place in lane order (for sorting a file's tags)
    byMedia: new Map(),      // media id -> [tag id] in lane order
    loaded: false,
    loading: null,
    subs: new Set(),
    hoverId: null,           // the tile or row under the pointer
    overBar: false,          // the pointer is over the Stage bar
    stageId: null,           // the file on Stage (paintStage)
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const color = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? c : '#94a3b8');

  async function api(url, opts) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Server returned ${r.status}`), { status: r.status, code: data.code });
    return data;
  }
  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const toast = (msg) => { if (typeof showToast === 'function') showToast(msg); };
  const toastErr = (err, what) => {
    if (err && err.status === 423) return;          // the lock screen takes over
    if (typeof showErrorToast === 'function') showErrorToast(err, what);
    else toast(err.message);
  };

  /* ── The copy ───────────────────────────────────────────────────── */

  function setLanes(lanes) {
    st.lanes = Array.isArray(lanes) ? lanes : [];
    st.tags = new Map();
    st.lanesById = new Map();
    st.rank = new Map();
    let k = 0;
    for (const l of st.lanes) {
      st.lanesById.set(l.id, l);
      for (const t of l.tags) { st.tags.set(t.id, t); st.rank.set(t.id, k++); }
    }
    // Tags that went away (a lane or tag deleted elsewhere) leave the files.
    for (const [m, list] of st.byMedia) {
      const kept = list.filter(id => st.tags.has(id)).sort((a, b) => st.rank.get(a) - st.rank.get(b));
      if (kept.length) st.byMedia.set(m, kept); else st.byMedia.delete(m);
    }
  }

  /** { mediaId: [tagId] } from the server; ids asked about but missing from it have none. */
  function setAssignments(assignments, askedIds = []) {
    for (const id of askedIds) st.byMedia.delete(Number(id));
    for (const [m, list] of Object.entries(assignments || {})) {
      const kept = list.filter(id => st.tags.has(id)).sort((a, b) => st.rank.get(a) - st.rank.get(b));
      if (kept.length) st.byMedia.set(Number(m), kept); else st.byMedia.delete(Number(m));
    }
  }

  async function loadLanes() {
    const d = await api('/api/stream-tags');
    setLanes(d.lanes);
  }

  /** Lanes and every assignment. Once; later calls wait for the same load. */
  function load(force = false) {
    if (st.loading && !force) return st.loading;
    st.loading = (async () => {
      try {
        await loadLanes();
        const all = await api('/api/stream-tags/assignments');
        st.byMedia = new Map();
        for (const [m, t] of all.rows || []) {
          if (!st.tags.has(t)) continue;
          const list = st.byMedia.get(m);
          if (list) list.push(t); else st.byMedia.set(m, [t]);
        }
        for (const [m, list] of st.byMedia) st.byMedia.set(m, list.sort((a, b) => st.rank.get(a) - st.rank.get(b)));
        st.loaded = true;
        changed(null);
      } catch (err) {
        st.loading = null;           // try again next time
        if (err.status !== 423) console.warn('[stream tags]', err.message);
      }
    })();
    return st.loading;
  }

  /** The lanes again (Settings changed them), keeping the assignments. */
  async function reloadLanes() {
    try { await loadLanes(); changed(null); } catch (err) { toastErr(err, 'loading the stream tags'); }
  }

  /** A collection opened: its files' tags fresh from the server. */
  async function refreshCollection(cid) {
    if (!st.loaded) { await load(); return; }
    try {
      const d = await api(`/api/stream-tags/collections/${Number(cid)}`);
      const members = typeof collectionMembers !== 'undefined' && collectionMembers.get ? collectionMembers.get(Number(cid)) : null;
      const ids = Array.isArray(members) ? members : Object.keys(d.assignments || {});
      setAssignments(d.assignments, ids);
      changed(null);
    } catch (err) { if (err.status !== 423 && err.status !== 404) console.warn('[stream tags]', err.message); }
  }

  const tagIdsOf = (id) => st.byMedia.get(Number(id)) || [];
  const tagsOf = (id) => tagIdsOf(id).map(t => st.tags.get(t)).filter(Boolean);
  const hasAny = () => st.tags.size > 0;

  /* ── Change and repaint ─────────────────────────────────────────── */

  /** Something changed: the files whose tags changed (null: maybe any). */
  function changed(mediaIds) {
    repaintTiles(mediaIds);
    paintStage(st.stageId);
    renderFilterOptions();
    // The shortcuts list shows the keys the tags really have.
    if (typeof shortcutsSetStreamTagKeys === 'function') shortcutsSetStreamTagKeys([...st.tags.values()].map(t => t.hotkey).filter(Boolean));
    for (const cb of st.subs) { try { cb(); } catch (err) { console.warn('[stream tags] a listener failed:', err); } }
  }

  /* ── Tagging ────────────────────────────────────────────────────── */

  async function chunked(ids, fn) {
    let last = null;
    const merged = {};
    for (let i = 0; i < ids.length; i += CHUNK) {
      last = await fn(ids.slice(i, i + CHUNK));
      Object.assign(merged, last.assignments || {});
    }
    return { last, merged };
  }

  /**
   * Put a tag on files, take it off or toggle it. Toggle on several files:
   * on all of them unless every one has it already, then off all (decided
   * here, so a big selection sent in parts acts as one).
   */
  async function apply(tagId, mediaIds, op = 'toggle') {
    const t = st.tags.get(tagId);
    const ids = [...new Set(mediaIds.map(Number).filter(Number.isInteger))];
    if (!t || !ids.length) return;
    if (op === 'toggle') op = ids.every(id => tagIdsOf(id).includes(tagId)) ? 'remove' : 'add';
    try {
      const { merged } = await chunked(ids, part => post('/api/stream-tags/assign', { tagId, mediaIds: part, op }));
      setAssignments(merged, ids);
      changed(ids);
      const what = ids.length === 1 ? (ids[0] === st.stageId && st.overBar ? 'the file on Stage' : 'this file')
        : `${ids.length.toLocaleString()} files`;
      toast(op === 'add' ? `${t.name}: on ${what}` : `${t.name}: off ${what}`);
    } catch (err) { toastErr(err, 'changing a stream tag'); }
  }

  async function clearFiles(mediaIds) {
    const ids = [...new Set(mediaIds.map(Number).filter(Number.isInteger))];
    if (!ids.length) return;
    try {
      const { merged } = await chunked(ids, part => post('/api/stream-tags/clear', { mediaIds: part }));
      setAssignments(merged, ids);
      changed(ids);
      toast(ids.length === 1 ? 'Stream tags cleared' : `Stream tags cleared on ${ids.length.toLocaleString()} files`);
    } catch (err) { toastErr(err, 'clearing stream tags'); }
  }

  /** The files an action on this file reaches: the selection when it is part of one. */
  function targetsFor(id) {
    if (typeof selectedIds !== 'undefined' && selectedIds.has(id) && selectedIds.size > 1) return [...selectedIds];
    return [id];
  }

  /* ── Chips ──────────────────────────────────────────────────────── */

  function chipHtml(t) {
    return `<span class="stag-chip" style="--c:${color(t.color)}" title="${esc(laneName(t))}: ${esc(t.name)}">${esc(t.name)}</span>`;
  }
  const laneName = (t) => (st.lanesById.get(t.laneId) || {}).name || '';

  function chipsHtml(id, max = 2) {
    const list = tagsOf(id);
    if (!list.length) return '';
    const shown = list.slice(0, max).map(chipHtml).join('');
    const more = list.length > max
      ? `<span class="stag-chip stag-more" title="${esc(list.slice(max).map(t => t.name).join(', '))}">+${list.length - max}</span>` : '';
    return shown + more;
  }

  function tileHtml(media) {
    const html = media ? chipsHtml(media.id) : '';
    return html ? `<span class="tile-stags" aria-label="Stream tags">${html}</span>` : '';
  }

  function rowHtml(media) {
    const html = media ? chipsHtml(media.id) : '';
    return html ? `<span class="tile-stags tv-stags" aria-label="Stream tags">${html}</span>` : '';
  }

  /** Chips on the tiles and rows on screen (only these files, or all). */
  function repaintTiles(mediaIds) {
    const want = mediaIds ? new Set(mediaIds.map(Number)) : null;
    document.querySelectorAll('.media-tile[data-id]:not(.tile-skel)').forEach((tile) => {
      const id = Number(tile.dataset.id);
      if (want && !want.has(id)) return;
      const row = tile.classList.contains('tv-row');
      const host = row ? tile.querySelector('.tv-c-title') : tile.querySelector('.tile-thumb');
      if (!host) return;
      const html = row ? rowHtml({ id }) : tileHtml({ id });
      const old = host.querySelector(':scope > .tile-stags');
      if (!html) { if (old) old.remove(); return; }
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const el = tmp.firstElementChild;
      if (old) old.replaceWith(el);
      else if (row) { const name = host.querySelector('.tv-name'); if (name) name.after(el); else host.appendChild(el); }
      else host.appendChild(el);
    });
  }

  /* ── The menu (right-click, the selection bar, the Stage bar) ───── */

  let menuEl = null;
  let subEl = null;

  function closeMenu() {
    const had = menuEl && menuEl.contains(document.activeElement);
    const opener = menuEl && menuEl._opener;
    if (subEl) { subEl.remove(); subEl = null; }
    if (menuEl) { menuEl.remove(); menuEl = null; }
    document.removeEventListener('pointerdown', onOutside, true);
    if (had && opener && opener.isConnected) { try { opener.focus({ preventScroll: true }); } catch {} }
  }
  function onOutside(e) {
    if ((menuEl && menuEl.contains(e.target)) || (subEl && subEl.contains(e.target))) return;
    closeMenu();
  }

  /** Where a menu goes: at a point, or above / below a button. */
  function place(el, at) {
    const r = el.getBoundingClientRect();
    let x, y;
    if (at.rect) {
      x = at.rect.left;
      y = at.rect.top - r.height - 6 >= 8 && (at.up || at.rect.bottom + r.height + 6 > innerHeight) ? at.rect.top - r.height - 6 : at.rect.bottom + 6;
    } else { x = at.x; y = at.y; }
    el.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  }

  /**
   * items: { label, run, check: 'on' | 'mixed' | '', color, kbd, sub: items,
   * disabled } | { header } | { sep }.
   */
  function itemsHtml(items) {
    return items.map((it, i) => {
      if (it.sep) return '<hr class="stag-sep">';
      if (it.header) return `<div class="stag-head" role="presentation">${esc(it.header)}</div>`;
      const check = it.check === 'on' ? '✓' : it.check === 'mixed' ? '–' : '';
      const aria = it.check !== undefined ? ` role="menuitemcheckbox" aria-checked="${it.check === 'on' ? 'true' : it.check === 'mixed' ? 'mixed' : 'false'}"` : ' role="menuitem"';
      const sw = it.color ? `<i class="stag-dot" style="--c:${color(it.color)}"></i>` : '';
      const tail = it.sub ? '<span class="stag-kbd" aria-hidden="true">›</span>' : it.kbd ? `<kbd class="stag-kbd">${esc(it.kbd)}</kbd>` : '';
      return `<button type="button" class="stag-mi"${aria} data-i="${i}"${it.sub ? ' aria-haspopup="menu"' : ''}${it.disabled ? ' disabled' : ''}>
        <span class="stag-check" aria-hidden="true">${check}</span>${sw}<span class="stag-label">${esc(it.label)}</span>${tail}</button>`;
    }).join('');
  }

  function buildMenu(items, cls = '') {
    const el = document.createElement('div');
    el.className = `stag-menu ${cls}`;
    el.setAttribute('role', 'menu');
    el.innerHTML = itemsHtml(items);
    el._items = items;
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b || b.disabled) return;
      const it = items[Number(b.dataset.i)];
      if (it.sub) { openSub(b, it.sub); return; }
      closeMenu();
      if (it.run) it.run();
    });
    el.addEventListener('pointerover', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b || el !== menuEl) return;
      const it = items[Number(b.dataset.i)];
      if (it.sub) openSub(b, it.sub);
      else if (subEl) { subEl.remove(); subEl = null; }
    });
    el.addEventListener('keydown', (e) => menuKey(e, el));
    return el;
  }

  function openSub(btn, items) {
    if (subEl && subEl._for === btn) return subEl;
    if (subEl) subEl.remove();
    subEl = buildMenu(items, 'stag-sub');
    subEl._for = btn;
    document.body.appendChild(subEl);
    const r = btn.getBoundingClientRect();
    const w = subEl.getBoundingClientRect().width;
    const x = r.right + w + 4 <= innerWidth ? r.right + 2 : r.left - w - 2;
    place(subEl, { x, y: r.top - 4 });
    return subEl;
  }

  /** Close the submenu, focus back on the item that opened it. */
  function closeSub() {
    if (!subEl) return;
    const back = subEl._for;
    subEl.remove();
    subEl = null;
    back?.focus();
  }

  /** Arrows move, Right opens a submenu, Left closes it (Esc: the window listener in wire()). */
  function menuKey(e, el) {
    const btns = [...el.querySelectorAll('.stag-mi:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    let handled = true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const n = btns.length;
      if (n) btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus();
    } else if (e.key === 'ArrowRight' && el === menuEl && i >= 0) {
      const it = el._items[Number(btns[i].dataset.i)];
      if (it && it.sub) openSub(btns[i], it.sub)?.querySelector('.stag-mi:not([disabled])')?.focus();
    } else if (e.key === 'ArrowLeft' && el === subEl) {
      closeSub();
    } else if (e.key !== 'Tab') {
      handled = false;
    }
    // The page's own arrow keys (the dock, paging) stay out of it.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  function openMenu(items, at, opener = null) {
    closeMenu();
    if (typeof hideTilePopover === 'function') hideTilePopover();
    if (typeof facesCloseMenu === 'function') facesCloseMenu();
    menuEl = buildMenu(items);
    menuEl._opener = opener;
    document.body.appendChild(menuEl);
    place(menuEl, at);
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
    menuEl.querySelector('.stag-mi:not([disabled])')?.focus({ preventScroll: true });
  }

  /** The lanes as menu items for these files: ticks, dashes for some. */
  function laneItems(ids) {
    const out = [];
    for (const l of st.lanes) {
      if (!l.tags.length) continue;
      out.push({ header: `${l.name}${l.multi ? '' : ' (one per file)'}` });
      for (const t of l.tags) {
        let n = 0;
        for (const id of ids) if (tagIdsOf(id).includes(t.id)) n++;
        out.push({
          label: t.name, color: t.color, kbd: t.hotkey || '',
          check: n === 0 ? '' : n === ids.length ? 'on' : 'mixed',
          run: () => apply(t.id, ids, n === ids.length ? 'remove' : 'add'),
        });
      }
    }
    if (!out.length) out.push({ label: 'No stream tags yet', disabled: true });
    const any = ids.some(id => tagIdsOf(id).length);
    out.push({ sep: true });
    out.push({ label: 'Clear stream tags', disabled: !any, run: () => clearFiles(ids) });
    out.push({ label: 'Edit lanes…', run: openEditor });
    return out;
  }

  function openEditor() {
    if (typeof window.vaultOpenSettings !== 'function') return;
    window.vaultOpenSettings('stage');
    setTimeout(() => {
      const el = document.querySelector('#settingsBody [data-sfind="stageLanes"]');
      if (el) el.scrollIntoView({ block: 'start' });
    }, 50);
  }

  async function tileMenu(e, tile) {
    const id = Number(tile.dataset.id);
    const ids = targetsFor(id);
    const at = { x: e.clientX, y: e.clientY };
    let faces = null;
    if (typeof facesTileMenuItems === 'function') {
      // Usually known already (the tile shows its faces); never more than a moment's wait.
      try { faces = await Promise.race([facesTileMenuItems(id), new Promise(r => setTimeout(() => r(null), 400))]); } catch { faces = null; }
    }
    const items = [{ label: ids.length > 1 ? `Stream tag (${ids.length.toLocaleString()} files)` : 'Stream tag', sub: laneItems(ids) }];
    if (faces && faces.length) items.push({ sep: true }, ...faces);
    openMenu(items, at);
  }

  function selectionMenu(btn) {
    if (typeof selectedIds === 'undefined' || !selectedIds.size) return;
    if (menuEl && menuEl._opener === btn) { closeMenu(); return; }
    openMenu(laneItems([...selectedIds]), { rect: btn.getBoundingClientRect(), up: true }, btn);
  }

  function selectionButton() {
    const label = typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel('🏷 Stream tag') : 'Stream tag';
    return `<button class="sel-btn sel-stags" onclick="StreamTags.selectionMenu(this)" title="Stream tags for the selected files" aria-haspopup="menu">${label}</button>`;
  }

  /* ── The Stage bar ──────────────────────────────────────────────── */

  function paintStage(id) {
    st.stageId = id || null;
    const btn = document.getElementById('stageBarTag');
    if (!btn) return;
    btn.disabled = !st.stageId;
    const box = document.getElementById('stageBarTagChips');
    const html = st.stageId ? chipsHtml(st.stageId) : '';
    if (box && box.innerHTML !== html) {
      box.innerHTML = html;
      btn.classList.toggle('sb-tag-has', !!html);
      // The right side changed width: the bar lays itself out again.
      if (typeof StageBar !== 'undefined' && StageBar && StageBar.shown && StageBar.shown()) StageBar.relayout();
    }
    const names = tagsOf(st.stageId).map(t => t.name).join(', ');
    btn.title = st.stageId ? (names ? `Stream tags: ${names}` : 'Add a stream tag to the file on Stage') : 'Stream tags (nothing on Stage)';
  }

  function stageMenu(btn) {
    if (!st.stageId) return;
    if (menuEl && menuEl._opener === btn) { closeMenu(); return; }
    openMenu(laneItems([st.stageId]), { rect: btn.getBoundingClientRect(), up: true }, btn);
  }

  /* ── Keys ───────────────────────────────────────────────────────── */

  function typing(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT') return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(el.type);
    return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
  }

  function keyBlocked(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return true;
    if (typing(e.target) || typing(document.activeElement)) return true;
    if (typeof vaultModalOpen === 'function' && vaultModalOpen()) return true;
    if (menuEl) return true;
    if (document.querySelector('#mediaPlayerOverlay.active, .modal-overlay.active, .settings-overlay.active, #frPanel, .fr-cmp-ov, .fr-pairs-panel, #facesMenu')) return true;
    return false;
  }

  /** The tag whose key this is, or null. */
  function tagForKey(key) {
    if (typeof key !== 'string' || [...key].length !== 1) return null;
    const k = key.toUpperCase();
    for (const t of st.tags.values()) if (t.hotkey && t.hotkey.toUpperCase() === k) return t;
    return null;
  }

  function stageTarget() {
    if (typeof StageBar === 'undefined' || !StageBar || !StageBar.shown || !StageBar.shown()) return null;
    const bar = document.getElementById('stageBar');
    const focused = bar && bar.contains(document.activeElement);
    if (!focused && !st.overBar) return null;
    return st.stageId;
  }

  function hoveredTile() {
    // The hover popover (cards.js) speaks for the tile it belongs to, even where it covers another.
    const pop = document.querySelector('#tilePopover.visible');
    if (pop && pop.matches(':hover') && typeof _popoverForId !== 'undefined' && _popoverForId != null) return Number(_popoverForId);
    if (st.hoverId == null) return null;
    const el = document.querySelector(`.media-tile[data-id="${st.hoverId}"]:not(.tile-skel)`);
    if (!el || !el.matches(':hover')) return null;
    return st.hoverId;
  }

  function onKey(e) {
    if (!st.tags.size || keyBlocked(e)) return;
    const t = tagForKey(e.key);
    if (!t) return;
    const miniOn = !!document.querySelector('#miniPlayer.active');
    if (miniOn && MINI_KEYS.has(e.key.toUpperCase())) return;
    const stage = stageTarget();
    const tile = stage == null ? hoveredTile() : null;
    if (stage == null && tile == null) return;
    e.preventDefault();
    e.stopPropagation();
    apply(t.id, stage != null ? [stage] : targetsFor(tile), 'toggle');
  }

  /* ── The filter (#filterStreamTag) ──────────────────────────────── */

  function renderFilterOptions() {
    const sel = document.getElementById('filterStreamTag');
    if (!sel) return;
    const cur = sel.value;
    const counts = new Map();
    for (const list of st.byMedia.values()) for (const t of list) counts.set(t, (counts.get(t) || 0) + 1);
    const html = '<option value="">All stream tags</option>' + st.lanes.map(l => l.tags.map(t =>
      `<option value="${t.id}">${esc(l.name)}: ${esc(t.name)} (${(counts.get(t.id) || 0).toLocaleString()})</option>`).join('')).join('');
    if (sel.innerHTML === html) return;
    sel.innerHTML = html;
    if (cur && sel.querySelector(`option[value="${cur}"]`)) sel.value = cur;
    else if (cur) { sel.value = ''; if (typeof applyFilters === 'function') applyFilters(); }
    if (typeof renderFilterChipRow === 'function') renderFilterChipRow();
    if (typeof renderFilterRail === 'function') renderFilterRail();
  }

  /* ── Wiring ─────────────────────────────────────────────────────── */

  function wire() {
    document.addEventListener('mouseover', (e) => {
      const tile = e.target instanceof Element ? e.target.closest('.media-tile[data-id]:not(.tile-skel)') : null;
      st.hoverId = tile ? Number(tile.dataset.id) : null;
      st.overBar = !!(e.target instanceof Element && e.target.closest('#stageBar'));
    });
    document.addEventListener('keydown', onKey);
    // Right-click on a tile or row: this menu (with the face search items
    // when face search is on). A face chip keeps its own menu.
    window.addEventListener('contextmenu', (e) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('.face-chip[data-face-group]')) return;
      const tile = e.target.closest('.media-tile[data-id]:not(.tile-skel)');
      if (!tile || !st.loaded) return;
      e.preventDefault();
      e.stopPropagation();
      tileMenu(e, tile);
    }, true);
    window.addEventListener('keydown', (e) => {
      // Esc closes the submenu first, then the menu, before anything else hears it.
      if (e.key !== 'Escape' || !menuEl) return;
      e.preventDefault();
      e.stopPropagation();
      if (subEl && subEl.contains(document.activeElement)) closeSub();
      else closeMenu();
    }, true);
    window.addEventListener('resize', closeMenu);
    document.getElementById('filterStreamTag')?.addEventListener('change', () => {
      if (typeof applyFilters === 'function') applyFilters();
    });
    // Booted locked: the first load waited for 423 to go; the library loading means it has.
    window.addEventListener('vault:library-loaded', () => { if (!st.loaded) load(); });
    load();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  return {
    PLACE_LABELS, load, reloadLanes, refreshCollection, apply, clearFiles, tagsOf, tagIdsOf, hasAny,
    lanes: () => st.lanes, tag: (id) => st.tags.get(id) || null, loaded: () => st.loaded,
    tileHtml, rowHtml, selectionButton, selectionMenu, paintStage, stageMenu, closeMenu, openEditor,
    onChange: (cb) => { if (typeof cb === 'function') st.subs.add(cb); },
    changed,
  };
})();

/* The Flow chart's lane rows (player-lib/flow.js chart): synchronous, over the copy above. */
window.FlowLaneSource = {
  lanes() {
    return StreamTags.lanes().map(l => ({ key: `lane:${l.id}`, label: l.name }));
  },
  cells(laneKey, mediaIds) {
    const m = /^lane:(\d+)$/.exec(String(laneKey));
    const laneId = m ? Number(m[1]) : null;
    return (mediaIds || []).map(id => (laneId == null ? [] : StreamTags.tagsOf(id)
      .filter(t => t.laneId === laneId).map(t => ({ color: t.color, label: t.name }))));
  },
  chips(mediaId) {
    return StreamTags.tagsOf(mediaId).map(t => ({ color: t.color, label: t.name }));
  },
  onChange(cb) { StreamTags.onChange(cb); },
};

function streamTagTileHtml(media) { return StreamTags.tileHtml(media); }
function streamTagRowHtml(media) { return StreamTags.rowHtml(media); }
function streamTagsSelectionButton() { return StreamTags.loaded() ? StreamTags.selectionButton() : ''; }
