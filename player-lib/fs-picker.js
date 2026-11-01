/* =========================================================================
   Vault's own folder browser (Linux and macOS).

   On Windows every picker is the Windows file dialog. On Linux the server
   first opens the desktop's own dialog (zenity or kdialog). When it cannot
   (no display, no dialog program, or macOS), the picker route answers
   { fallback: true, mode, start, ext, name, title } and the caller opens
   this instead:

     const picked = await vaultFsPicker.fromReply(reply, { kind });
       kind: 'folder' | 'files' | 'playlist' | 'findFolder' | 'save' | 'mpv'
       → a path (string), an array of paths (kind 'files'), or null (Cancel)

   It lists one folder at a time through GET /api/fs/list (read-only on the
   server), with a Places rail on the left: home and its usual folders, the
   drives that are plugged in, and the library's own folders. It looks like
   the GTK and KDE dialogs on purpose: Enter opens, Backspace goes up, Esc
   cancels, Ctrl+H shows hidden folders, Ctrl+L (or clicking the path) types
   a path.

   decodeUriList(text): the paths in a drop's text/uri-list (file:// URIs),
   used by the drop handler in importer.js; also exported for the tests.
   ========================================================================= */

/**
 * The local paths in a text/uri-list: file:// URIs (no host, or localhost),
 * percent-decoded. Comments (#), other schemes and other hosts are skipped.
 * @param {string} text
 * @returns {string[]}
 */
function decodeUriList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^file:\/\/([^/]*)(\/.*)$/i.exec(line);
    if (!m) continue;
    const host = m[1].toLowerCase();
    if (host && host !== 'localhost') continue;          // a file on another machine
    let p;
    try { p = decodeURIComponent(m[2]); } catch { continue; }
    if (!p.startsWith('/') || p.includes('\u0000')) continue;
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { decodeUriList };

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const KINDS = {
    folder: { mode: 'folder', title: 'Add a folder to the library',
      sub: 'Pick the folder that holds your videos or images. Vault looks inside every folder below it too.',
      primary: 'Add this folder', empty: 'No folders here.' },
    findFolder: { mode: 'folder', title: 'Find the missing files',
      sub: 'Pick the folder that holds the playlist\'s files. Vault looks for them by name.',
      primary: 'Look in this folder', empty: 'No folders here.' },
    files: { mode: 'files', title: 'Add files to the library',
      sub: 'Pick the videos or images to add. Hold Ctrl to pick more than one.',
      primary: 'Add files', empty: 'Nothing here.' },
    playlist: { mode: 'file', title: 'Import a playlist',
      sub: 'Pick an .m3u, .m3u8, .xspf, .pls or .dpl file.',
      primary: 'Import playlist', empty: 'No playlists in this folder.' },
    save: { mode: 'save', title: 'Save playlist as',
      sub: 'Pick a folder and a name. Other players can open the file.',
      primary: 'Save', empty: 'No playlists in this folder yet.' },
    mpv: { mode: 'exe', title: 'Choose mpv',
      sub: 'Pick the mpv program. Most systems keep it in /usr/bin. Install it with: sudo apt install mpv',
      primary: 'Use this mpv', empty: 'No programs here.' },
  };

  const PLACE_ICONS = {
    home: 'folder', desktop: 'folder', videos: 'video', pictures: 'image', music: 'audio',
    download: 'download', documents: 'file', drive: 'box', network: 'server', computer: 'chip',
    library: 'library', programs: 'gear',
  };

  const icon = (name) => (typeof vaultIcon === 'function' ? vaultIcon(name, 'fsp-ic') : '');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const join = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
  const parentOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
  const fmt = (n) => Number(n).toLocaleString('en-US');

  function countText(e) {
    if (!e.counted || !e.count) return '';
    const bits = [];
    if (e.count.videos) bits.push(`${fmt(e.count.videos)} ${e.count.videos === 1 ? 'video' : 'videos'}`);
    if (e.count.images) bits.push(`${fmt(e.count.images)} ${e.count.images === 1 ? 'image' : 'images'}`);
    return bits.length ? bits.join(' · ') : 'no media';
  }

  const lastKey = (kind) => `vault.fsPicker.last.${kind}`;
  function readLast(kind) {
    try { return localStorage.getItem(lastKey(kind)) || ''; } catch { return ''; }
  }
  function writeLast(kind, dir) {
    try { localStorage.setItem(lastKey(kind), dir); } catch { /* private window */ }
  }

  let current = null;            // the open picker's state, or null

  /**
   * Open the browser.
   * @param {object} o
   * @param {string} o.kind     see KINDS
   * @param {string} [o.start]  the folder to open in
   * @param {string} [o.ext]    file modes: "m3u,m3u8"
   * @param {string} [o.name]   save: the suggested file name
   * @returns {Promise<string|string[]|null>}
   */
  function open(o) {
    if (current) current.finish(null);
    const kind = KINDS[o.kind] ? o.kind : 'folder';
    const k = KINDS[kind];
    const exts = String(o.ext || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const st = {
      kind, k, mode: k.mode, exts, path: '', parent: null, entries: [], places: [], truncated: false,
      sel: [], hidden: false, name: o.name || '', loading: false, error: '', typing: false, typed: '',
      typedError: '', opener: document.activeElement, inerted: [],
    };
    const ov = document.createElement('div');
    ov.className = 'fsp-ov';
    ov.innerHTML = `<div class="fsp" role="dialog" aria-modal="true" aria-labelledby="fspTitle">
      <div class="fsp-head"><h2 class="fsp-title" id="fspTitle">${esc(k.title)}</h2><p class="fsp-sub">${esc(k.sub)}</p></div>
      <div class="fsp-pathbar">
        <button type="button" class="fsp-btn fsp-icon-btn" data-fsp-up title="Up one folder (Backspace)" aria-label="Up one folder">${icon('arrow-up') || '↑'}</button>
        <div class="fsp-loc"></div>
      </div>
      <div class="fsp-body">
        <nav class="fsp-places" aria-label="Places"></nav>
        <div class="fsp-list" role="listbox" aria-label="Contents" tabindex="0"${k.mode === 'files' ? ' aria-multiselectable="true"' : ''}></div>
      </div>
      <div class="fsp-foot"></div>
    </div>`;
    st.ov = ov;
    st.box = ov.querySelector('.fsp');
    st.loc = ov.querySelector('.fsp-loc');
    st.placesEl = ov.querySelector('.fsp-places');
    st.list = ov.querySelector('.fsp-list');
    st.foot = ov.querySelector('.fsp-foot');

    return new Promise((resolve) => {
      st.finish = (value) => {
        if (st.done) return;
        st.done = true;
        current = null;
        if (value != null && st.path) writeLast(kind, st.path);
        ov.remove();
        for (const n of st.inerted) n.inert = false;
        if (st.opener && st.opener.isConnected && typeof st.opener.focus === 'function') {
          try { st.opener.focus({ preventScroll: true }); } catch { /* gone */ }
        }
        resolve(value);
      };
      current = st;
      document.body.appendChild(ov);
      for (const n of Array.from(document.body.children)) {
        if (n === ov || n.inert) continue;
        n.inert = true;
        st.inerted.push(n);
      }
      wire(st);
      renderFoot(st);
      const remembered = readLast(kind);
      const first = remembered || o.start || '';
      load(st, first).then((ok) => {
        if (!ok && first) load(st, o.start && o.start !== first ? o.start : '');
      });
      st.list.focus();
    });
  }

  /** Open it from a picker route's { fallback: true, ... } answer. */
  function fromReply(reply, { kind } = {}) {
    const r = reply || {};
    return open({ kind, start: r.start, ext: r.ext, name: r.name });
  }

  async function load(st, dir, { select = null, keepTyping = false } = {}) {
    st.loading = true;
    const q = new URLSearchParams({ path: dir || '', mode: st.mode });
    if (st.exts.length && st.mode !== 'files') q.set('ext', st.exts.join(','));
    if (st.hidden) q.set('hidden', '1');
    let resp, data;
    try {
      resp = await fetch(`/api/fs/list?${q}`);
      data = await resp.json().catch(() => ({}));
    } catch {
      resp = null;
      data = { error: 'Vault could not be reached. Is it still running?' };
    }
    if (st.done) return false;
    st.loading = false;
    if (data.places) st.places = data.places;
    if (!resp || !resp.ok) {
      if (resp && resp.status === 423) { st.finish(null); return false; }   // the lock screen takes over
      const msg = data.error || 'That folder cannot be opened.';
      if (keepTyping) st.typedError = msg;
      else if (!st.path) st.error = msg;
      else if (typeof showToast === 'function') showToast(msg, { type: 'error' });
      renderPlaces(st);
      render(st);
      return false;
    }
    st.path = data.path;
    st.parent = data.parent;
    st.entries = Array.isArray(data.entries) ? data.entries : [];
    st.truncated = !!data.truncated;
    st.error = '';
    st.typedError = '';
    st.typing = false;
    st.sel = select && st.entries.some((e) => e.name === select) ? [select] : [];
    if (select && st.mode === 'save' && !st.entries.some((e) => e.name === select && e.dir)) st.name = select;
    renderPlaces(st);
    render(st);
    return true;
  }

  /* ── Drawing ─────────────────────────────────────────────────────────── */

  function render(st) {
    renderLoc(st);
    renderList(st);
    renderFoot(st);
    const up = st.box.querySelector('[data-fsp-up]');
    if (up) up.disabled = !st.parent;
  }

  function renderLoc(st) {
    if (st.typing) {
      st.loc.innerHTML = `<input class="fsp-loc-input" type="text" spellcheck="false" autocomplete="off"
        aria-label="Type a path" value="${esc(st.typed)}">${st.typedError ? `<span class="fsp-loc-err" role="alert">${esc(st.typedError)}</span>` : ''}`;
      const i = st.loc.querySelector('input');
      i.focus();
      i.setSelectionRange(i.value.length, i.value.length);
      return;
    }
    const parts = st.path.split('/').filter(Boolean);
    let acc = '';
    let h = `<button type="button" class="fsp-crumb${parts.length ? '' : ' is-last'}" data-fsp-go="/" title="The top of this computer">/</button>`;
    parts.forEach((p, i) => {
      acc += `/${p}`;
      h += `${i ? '<span class="fsp-sep" aria-hidden="true">›</span>' : ''}<button type="button" class="fsp-crumb${i === parts.length - 1 ? ' is-last' : ''}" data-fsp-go="${esc(acc)}">${esc(p)}</button>`;
    });
    st.loc.innerHTML = `<div class="fsp-crumbs" title="Click to type a path (Ctrl+L)">${h}</div>`;
    const c = st.loc.querySelector('.fsp-crumbs');
    c.scrollLeft = c.scrollWidth;
  }

  function renderPlaces(st) {
    let h = '';
    for (const g of st.places) {
      h += `<h3>${esc(g.group)}</h3>`;
      for (const p of g.items || []) {
        const on = st.path === p.path || (p.path !== '/' && g.group !== 'This computer' && st.path.startsWith(`${p.path}/`));
        h += `<button type="button" class="fsp-place${on ? ' is-on' : ''}" data-fsp-go="${esc(p.path)}" title="${esc(p.path)}">
          ${icon(PLACE_ICONS[p.icon] || 'folder')}<span class="fsp-lbl">${esc(p.label)}</span>${p.tag ? `<span class="fsp-sz">${esc(p.tag)}</span>` : ''}</button>`;
      }
    }
    st.placesEl.innerHTML = h;
  }

  /** Entries that cannot be chosen: in mpv mode, programs not named mpv. */
  const dimmed = (st, e) => !e.dir && ((st.mode === 'exe' && e.name !== 'mpv') || st.mode === 'save');

  function renderList(st) {
    if (st.error) { st.list.innerHTML = `<div class="fsp-empty">${esc(st.error)}</div>`; return; }
    if (!st.path) { st.list.innerHTML = '<div class="fsp-empty">Loading…</div>'; return; }
    if (!st.entries.length) { st.list.innerHTML = `<div class="fsp-empty">${esc(st.k.empty)}</div>`; return; }
    const rows = st.entries.map((e) => {
      const sel = st.sel.includes(e.name);
      const ico = e.dir ? 'folder' : st.mode === 'exe' ? 'gear' : st.mode === 'file' || st.mode === 'save' ? 'note' : 'file';
      let meta = '';
      if (e.dir && (st.mode === 'folder' || st.mode === 'files')) {
        const ct = countText(e);
        if (ct) meta += `<span class="fsp-cnt">${esc(ct)}</span>`;
      }
      if (e.inLibrary) meta += '<span class="fsp-tag is-lib">In library</span>';
      return `<div role="option" class="fsp-row${sel ? ' is-sel' : ''}${dimmed(st, e) ? ' is-dim' : ''}" data-name="${esc(e.name)}" data-dir="${e.dir ? 1 : 0}" aria-selected="${sel}">
        ${icon(ico)}<span class="fsp-name">${esc(e.name)}</span><span class="fsp-meta">${meta}</span></div>`;
    }).join('');
    st.list.innerHTML = rows + (st.truncated ? '<div class="fsp-empty">This folder has more items than Vault lists. Type a path to go further.</div>' : '');
    const s = st.list.querySelector('.fsp-row.is-sel');
    if (s) s.scrollIntoView({ block: 'nearest' });
  }

  /** The save mode's file name, with the playlist extension added when it has none. */
  function saveName(st) {
    let n = st.name.trim();
    if (!n || n.includes('/') || n === '.' || n === '..') return '';
    const want = st.exts.length ? st.exts : ['m3u8'];
    if (!want.some((x) => n.toLowerCase().endsWith(`.${x}`))) n += `.${want[0]}`;
    return n;
  }

  /** What OK would choose now: a path, a list of paths, or '' (nothing yet). */
  function chosen(st) {
    if (!st.path) return '';
    if (st.mode === 'folder') {
      const d = st.sel.length && st.entries.find((e) => e.name === st.sel[0] && e.dir);
      return d ? join(st.path, d.name) : st.path;
    }
    if (st.mode === 'save') { const n = saveName(st); return n ? join(st.path, n) : ''; }
    const files = st.sel.filter((n) => st.entries.some((e) => e.name === n && !e.dir && !dimmed(st, e)));
    if (st.mode === 'files') return files.map((n) => join(st.path, n));
    return files.length ? join(st.path, files[0]) : '';
  }

  function renderFoot(st) {
    const c = chosen(st);
    const shown = Array.isArray(c) ? (c.length > 1 ? `${c.length} files` : (c[0] || '')) : c;
    const exists = st.mode === 'save' && !!saveName(st) && st.entries.some((e) => !e.dir && e.name === saveName(st));
    let h = '';
    if (st.mode === 'save') {
      const had = st.foot.querySelector('.fsp-save-input');
      if (had) {
        // Keep the box (and its cursor) while typing; only the rest changes.
        const warn = st.foot.querySelector('.fsp-warn');
        if (warn) warn.hidden = !exists;
        st.foot.querySelector('.fsp-chosen code').textContent = shown || 'nothing yet';
        const ok = st.foot.querySelector('[data-fsp-ok]');
        ok.disabled = !c;
        ok.textContent = exists ? 'Replace' : st.k.primary;
        return;
      }
      h += `<div class="fsp-saverow"><label for="fspSaveName">File name</label>
        <input id="fspSaveName" class="fsp-save-input" type="text" spellcheck="false" autocomplete="off" value="${esc(st.name)}"></div>
        <div class="fsp-warn"${exists ? '' : ' hidden'}>A playlist with this name is already here. Saving replaces it.</div>`;
    }
    h += `<div class="fsp-chosen"><span>${st.mode === 'save' ? 'Saves to' : 'Chosen'}</span><code>${esc(shown || 'nothing yet')}</code></div>
      <div class="fsp-actions">
        <label class="fsp-toggle"><input type="checkbox" data-fsp-hidden${st.hidden ? ' checked' : ''}> Show hidden folders</label>
        <span class="fsp-grow"></span>
        <button type="button" class="fsp-btn" data-fsp-cancel>Cancel</button>
        <button type="button" class="fsp-btn is-primary" data-fsp-ok${(Array.isArray(c) ? c.length : c) ? '' : ' disabled'}>${esc(exists ? 'Replace' : st.k.primary)}</button>
      </div>`;
    st.foot.innerHTML = h;
  }

  /* ── Acting ──────────────────────────────────────────────────────────── */

  function confirmPick(st) {
    const c = chosen(st);
    if (!c || (Array.isArray(c) && !c.length)) return;
    st.finish(c);
  }

  function goUp(st) { if (st.parent) load(st, st.parent, { select: st.path.split('/').pop() }); }

  function openRow(st, row) {
    const name = row.dataset.name;
    if (row.dataset.dir === '1') { load(st, join(st.path, name)); return; }
    if (row.classList.contains('is-dim') && st.mode !== 'save') return;
    st.sel = [name];
    if (st.mode === 'save') { st.name = name; const i = st.foot.querySelector('.fsp-save-input'); if (i) i.value = name; }
    confirmPick(st);
  }

  function clickRow(st, row, e) {
    const name = row.dataset.name;
    const isDir = row.dataset.dir === '1';
    if (isDir) {
      // Folder mode: the first click picks it, the second opens it (as the mockup and GTK do).
      // Other modes: one click opens a folder.
      if (st.mode === 'folder' && !st.sel.includes(name)) { st.sel = [name]; renderList(st); renderFoot(st); return; }
      load(st, join(st.path, name));
      return;
    }
    if (row.classList.contains('is-dim') && st.mode !== 'save') return;
    if (st.mode === 'files' && (e.ctrlKey || e.metaKey)) {
      st.sel = st.sel.includes(name) ? st.sel.filter((n) => n !== name) : [...st.sel, name];
    } else if (st.mode === 'files' && e.shiftKey && st.sel.length) {
      const names = st.entries.filter((x) => !x.dir).map((x) => x.name);
      const a = names.indexOf(st.sel[st.sel.length - 1]);
      const b = names.indexOf(name);
      if (a >= 0 && b >= 0) st.sel = names.slice(Math.min(a, b), Math.max(a, b) + 1);
      else st.sel = [name];
    } else st.sel = [name];
    if (st.mode === 'save') { st.name = name; const i = st.foot.querySelector('.fsp-save-input'); if (i) i.value = name; }
    renderList(st);
    renderFoot(st);
  }

  function moveSel(st, step) {
    const names = st.entries.map((e) => e.name);
    if (!names.length) return;
    const at = st.sel.length ? names.indexOf(st.sel[st.sel.length - 1]) : -1;
    const next = Math.max(0, Math.min(names.length - 1, at < 0 ? 0 : at + step));
    st.sel = [names[next]];
    const ent = st.entries[next];
    if (st.mode === 'save' && !ent.dir) {
      st.name = ent.name;
      const i = st.foot.querySelector('.fsp-save-input');
      if (i) i.value = ent.name;
    }
    renderList(st);
    renderFoot(st);
  }

  function startTyping(st) {
    st.typing = true;
    st.typed = st.path === '/' ? '/' : `${st.path}/`;
    st.typedError = '';
    renderLoc(st);
  }

  async function goTyped(st) {
    let v = st.typed.trim();
    if (v === '~' || v.startsWith('~/')) {
      const home = st.places.flatMap((g) => g.items || []).find((p) => p.icon === 'home');
      if (home) v = home.path + v.slice(1);
    }
    if (!v.startsWith('/')) { st.typedError = 'Type a full path, starting with /.'; renderLoc(st); return; }
    if (v.length > 1) v = v.replace(/\/+$/, '');
    const ok = await load(st, v, { keepTyping: true });
    if (ok || st.done) return;
    // A file's path in a file mode: open its folder and pick it.
    if (st.mode !== 'folder' && /a file, not a folder/i.test(st.typedError)) {
      const name = v.split('/').pop();
      await load(st, parentOf(v), { select: name, keepTyping: true });
      return;
    }
    renderLoc(st);
  }

  function wire(st) {
    st.box.addEventListener('click', (e) => {
      const t = e.target.closest('button, .fsp-row, .fsp-crumbs');
      if (!t || !st.box.contains(t)) return;
      if (t.dataset.fspGo) { load(st, t.dataset.fspGo); return; }
      if (t.hasAttribute('data-fsp-up')) { goUp(st); return; }
      if (t.hasAttribute('data-fsp-cancel')) { st.finish(null); return; }
      if (t.hasAttribute('data-fsp-ok')) { confirmPick(st); return; }
      if (t.classList.contains('fsp-row')) { clickRow(st, t, e); return; }
      if (t.classList.contains('fsp-crumbs')) startTyping(st);   // the empty part of the path bar
    });
    st.box.addEventListener('dblclick', (e) => {
      const row = e.target.closest('.fsp-row');
      if (row) openRow(st, row);
    });
    st.box.addEventListener('input', (e) => {
      if (e.target.classList.contains('fsp-save-input')) { st.name = e.target.value; renderFoot(st); }
      if (e.target.classList.contains('fsp-loc-input')) { st.typed = e.target.value; }
    });
    st.box.addEventListener('change', (e) => {
      if (e.target.hasAttribute('data-fsp-hidden')) { st.hidden = e.target.checked; load(st, st.path); }
    });
    // A press that starts and ends on the dim backdrop cancels, as vaultConfirm does.
    let downOnBackdrop = false;
    st.ov.addEventListener('mousedown', (e) => { downOnBackdrop = e.target === st.ov; });
    st.ov.addEventListener('click', (e) => { if (downOnBackdrop && e.target === st.ov) st.finish(null); downOnBackdrop = false; });
  }

  /* While the browser is open it has the keyboard: nothing behind it hears a
     key (the library and player shortcuts stay quiet). Registered on load,
     right after vault-dialogs.js, so it runs before the page's own handlers. */
  function onKey(e) {
    const st = current;
    if (!st) return;
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    const t = e.target;
    const inLoc = t && t.classList && t.classList.contains('fsp-loc-input');
    const inField = t && (t.tagName === 'INPUT' && t.type === 'text');
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (st.typing) { st.typing = false; st.typedError = ''; renderLoc(st); st.list.focus(); return; }
      st.finish(null);
      return;
    }
    if (mod && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      st.hidden = !st.hidden;
      load(st, st.path);
      return;
    }
    if (mod && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); startTyping(st); return; }
    if (inLoc) {
      if (e.key === 'Enter') { e.preventDefault(); goTyped(st); }
      return;
    }
    if (e.key === 'Enter') {
      if (e.repeat || e.isComposing) { e.preventDefault(); return; }
      if (t && t.tagName === 'BUTTON' && st.box.contains(t)) return;     // a focused button answers for itself
      e.preventDefault();
      if (inField) { confirmPick(st); return; }                          // the save box: Save
      const row = st.sel.length && st.list.querySelector(`.fsp-row[data-name="${CSS.escape(st.sel[st.sel.length - 1])}"]`);
      if (row) openRow(st, row);
      else if (st.mode === 'folder' || st.mode === 'save') confirmPick(st);
      return;
    }
    if (inField) return;
    if (e.key === 'Backspace') { e.preventDefault(); goUp(st); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(st, 1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(st, -1); return; }
    if (e.key === '/' || e.key === '~') { e.preventDefault(); startTyping(st); st.typed = e.key === '~' ? '~/' : '/'; renderLoc(st); return; }
    if (e.key === 'Tab') {
      // Keep Tab inside the browser (the rest of the page is inert anyway).
      const f = Array.from(st.box.querySelectorAll('button:not([disabled]), input, [tabindex="0"]'));
      const i = f.indexOf(t);
      e.preventDefault();
      const next = f[i < 0 ? 0 : (i + (e.shiftKey ? f.length - 1 : 1)) % f.length];
      if (next) next.focus();
    }
  }
  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, onKey, true);

  window.vaultFsPicker = { open, fromReply, isOpen: () => !!current };
  window.decodeUriList = decodeUriList;
})();
