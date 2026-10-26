/* =========================================================================
   IMPORT PLAYLIST - make a collection from a VLC or PotPlayer playlist
   (PLAYLISTS_SPEC, build step 3; Modern UI review item 3)

   Entry points: "Import playlist…" in the Modern header's + Add menu (it
   clicks the hidden Classic button, like Add files / Add folder), the
   Classic header button, the Collections tab's New actions, and dropping a
   .m3u / .m3u8 / .xspf / .pls / .dpl file on the window (importer.js hands
   those drops here; media drops add as before).

   The server reads the file (it comes from the native picker, or a drop
   traced back to its real path by the drop resolver) and matches every entry
   against the library (lib/playlist/import.js). This page only ever names
   the playlist by the session id the server handed out.

   The review window (both looks, the Add window's dialog styles):
     In your library (n)            go into the collection
     On disk, not in your library   Add and scan… makes the collection, then
                                    opens the normal Add window with exactly
                                    these files; each lands at its playlist
                                    place as soon as its row exists
     Not found (n)                  Find in folder… looks for them by name
     Left out                       web links, Vault's trash, other kinds of
                                    file, entries listed twice
   Then: a new collection named after the playlist, or add to one. A toast
   offers Undo (the collection goes, or the added files come out; files added
   to the library stay).
   ========================================================================= */
(function () {
  const LIST_EXT = /\.(m3u8?|xspf|pls|dpl)$/i;
  const SHOW_FIRST = 60;          // rows per group before "Show more"
  const SHOW_STEP = 500;

  const ico = (emoji, name) => (typeof vaultIconSwap === 'function' ? vaultIconSwap(emoji, name) : escapeHtml(emoji));
  const modernLook = () => (typeof vaultIsModern === 'function' && vaultIsModern());
  const fmtN = (v) => (Number(v) || 0).toLocaleString();
  const plural = (n, one, many) => `${fmtN(n)} ${n === 1 ? one : (many || one + 's')}`;
  const esc = (s) => escapeHtml(String(s == null ? '' : s));
  const errWords = (err, what) => (typeof friendlyError === 'function' ? friendlyError(err, what) : `Something went wrong while ${what}.`);
  const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

  /** A failed reply as something friendlyError reads (the server's own sentence when it has one). */
  async function replyError(resp) {
    const body = await resp.json().catch(() => ({}));
    return { error: body.error, status: resp.status, code: body.code };
  }

  /* ── Opening a playlist ──────────────────────────────────────────────── */

  // idle: Classic's header button, short so the Classic header stays on one
  // line at 1440 px; menu: what the Modern + Add menu shows for it
  // (header-fit.js reads data-menu-text).
  const LABELS = { idle: '📃 Playlist…', menu: '📃 Import playlist…', busy: '📃 Waiting for the file picker…', classicBusy: '📃 Picker open…' };
  let _busy = false;

  function setBusy(on) {
    _busy = on;
    const btn = document.getElementById('importPlaylistBtn');
    if (!btn) return;
    btn.disabled = on;
    btn.dataset.menuText = on ? LABELS.busy : LABELS.menu;
    btn.textContent = on ? (modernLook() ? LABELS.busy : LABELS.classicBusy) : LABELS.idle;
  }

  /** Picker → review. */
  async function importPlaylist() {
    if (_busy) return;
    setBusy(true);
    const hint = setTimeout(() => showToast('Waiting for the file picker. It may be behind this window.'), 900);
    let resp, data;
    try {
      resp = await fetch('/api/playlists/import/pick', { method: 'POST' });
      clearTimeout(hint);
      if (!resp.ok) {
        const err = await replyError(resp);
        if (resp.status === 423) return;
        let msg = errWords(err, 'opening the playlist');
        if (/cannot open the Windows file picker/i.test(msg)) msg += ' You can drop the playlist file onto this window instead.';
        showToast(msg, { type: 'error' });
        return;
      }
      data = await resp.json();
    } catch (err) {
      clearTimeout(hint);
      showToast(errWords(err, 'opening the playlist'), { type: 'error' });
      return;
    } finally {
      clearTimeout(hint);
      setBusy(false);
    }
    if (data.canceled) return;
    openReview(data);
  }
  window.vaultImportPlaylist = importPlaylist;

  /** A playlist file dropped on the window (importer.js): find its real path, else pick it. */
  async function importPlaylistDrop(file) {
    showToast('🔍 Finding where the playlist is on disk…');
    let data = null;
    try {
      const resp = await fetch('/api/playlists/import/drop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size == null ? null : file.size }),
      });
      if (resp.status === 423) return;
      if (resp.ok) data = await resp.json();
      else { showToast(errWords(await replyError(resp), 'reading the playlist'), { type: 'error' }); return; }
    } catch (err) {
      showToast(errWords(err, 'reading the playlist'), { type: 'error' });
      return;
    }
    if (data && data.session) { openReview(data); return; }
    // Its folder matters (relative entries), so the real path is needed.
    showToast('📃 Vault could not tell where that playlist is. Pick it in the file picker.');
    importPlaylist();
  }
  window.vaultImportPlaylistDrop = importPlaylistDrop;

  /* ── The review window ───────────────────────────────────────────────── */

  let _review = null;            // the server's review
  let _shown = {};               // group → rows shown
  let _target = null;            // { mode: 'new'|'existing', name, collectionId }

  const collectionsNow = () => (typeof collectionsList !== 'undefined' && Array.isArray(collectionsList) ? collectionsList : []);

  /** The playlist's name, or "Name (2)" when the root already has one. */
  function freeName(name) {
    const taken = new Set(collectionsNow().filter(c => c.parent_id == null).map(c => String(c.name).toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 1000; i++) {
      const n = `${name} (${i})`;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return name;
  }

  function collectionLabel(c) {
    const prefix = typeof _pathPrefix === 'function' ? _pathPrefix(c) : '';
    return `${prefix}${c.name}`;
  }

  function closeReview({ forget = true } = {}) {
    const ov = document.getElementById('playlistImportModal');
    if (!ov) return;
    if (ov.dataset.busy === '1') return;
    window.removeEventListener('keydown', onKey, true);
    ov.remove();
    if (forget && _review) fetch(`/api/playlists/import/${_review.session}/close`, { method: 'POST' }).catch(() => {});
    _review = null;
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !document.getElementById('playlistImportModal')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    closeReview();
  }

  function openReview(review) {
    if (_review && _review.session !== review.session) {
      fetch(`/api/playlists/import/${_review.session}/close`, { method: 'POST' }).catch(() => {});
    }
    window.removeEventListener('keydown', onKey, true);
    document.getElementById('playlistImportModal')?.remove();
    _review = review;
    _shown = {};
    const existing = collectionsNow().filter(c => c.kind !== 'folder');
    const openId = typeof activeCollectionId !== 'undefined' ? activeCollectionId : null;
    const open = existing.find(c => c.id === openId);
    _target = { mode: 'new', name: freeName(review.name || 'Playlist'), collectionId: open ? open.id : (existing[0]?.id ?? null) };

    const ov = document.createElement('div');
    ov.id = 'playlistImportModal';
    ov.className = 'import-overlay';
    ov.innerHTML = `
      <div class="import-modal pli-modal" role="dialog" aria-modal="true" aria-labelledby="pliTitle" tabindex="-1">
        <div class="imp-head">
          <span class="imp-ic">${ico('📃', 'queue')}</span>
          <div class="imp-titles">
            <div class="imp-t1" id="pliTitle">Import playlist</div>
            <div class="imp-t2" id="pliPath"></div>
          </div>
          <button type="button" class="imp-x" title="Close" aria-label="Close">${ico('✕', 'close')}</button>
        </div>
        <div class="imp-body" id="pliBody"></div>
        <div class="imp-foot">
          <span class="imp-sum" id="pliSummary"></span>
          <button type="button" class="vdlg-btn imp-cancel" id="pliCancel">Cancel</button>
          <button type="button" class="vdlg-btn vdlg-ok imp-go" id="pliGo">Import</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const q = (sel) => ov.querySelector(sel);
    q('#pliPath').textContent = review.playlistPath || review.fileName || '';
    q('#pliPath').title = review.playlistPath || '';

    q('.imp-x').addEventListener('click', () => closeReview());
    q('#pliCancel').addEventListener('click', () => closeReview());
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeReview(); });
    window.addEventListener('keydown', onKey, true);
    q('#pliGo').addEventListener('click', () => doImport({ addAndScan: false }));
    q('#pliBody').addEventListener('click', onBodyClick);
    q('#pliBody').addEventListener('change', onBodyChange);
    q('#pliBody').addEventListener('input', onBodyInput);
    render();
    q('.import-modal').focus();
  }

  /* One group: head with the count and its action, a note, and the rows. */
  // extra: more markup at the end of the group (built here, never spliced in with replace)
  function group(key, title, n, { note = '', action = '', rows = [], rowHtml, extra = '' }) {
    if (!n) return '';
    const shown = Math.min(rows.length, _shown[key] || SHOW_FIRST);
    const more = rows.length - shown;
    return `
      <section class="pli-group pli-${key}" data-group="${key}">
        <div class="pli-ghead">
          <div class="imp-sect pli-gtitle">${title} <span class="pli-count">(${fmtN(n)})</span></div>
          ${action}
        </div>
        ${note ? `<div class="imp-note pli-gnote">${note}</div>` : ''}
        ${rows.length ? `<ol class="pli-rows">${rows.slice(0, shown).map(rowHtml).join('')}</ol>` : ''}
        ${more > 0 ? `<button type="button" class="pli-more" data-more="${key}">Show ${fmtN(Math.min(more, SHOW_STEP))} more of ${fmtN(more)}</button>` : ''}
        ${extra}
      </section>`;
  }

  const num = (i) => `<span class="pli-num">${fmtN(i + 1)}</span>`;

  function render() {
    const ov = document.getElementById('playlistImportModal');
    if (!ov || !_review) return;
    const r = _review;
    const body = ov.querySelector('#pliBody');
    const scroll = body.scrollTop;
    const existing = collectionsNow().filter(c => c.kind !== 'folder');

    const target = `
      <div class="pli-target">
        <div class="imp-sect">Collection</div>
        <div class="pli-choices">
          <label class="pli-choice">
            <input type="radio" name="pliTarget" value="new"${_target.mode === 'new' ? ' checked' : ''}>
            <span class="pli-ctext"><b>Make a new collection</b>
              <input type="text" class="pli-name" id="pliName" maxlength="200" aria-label="Name of the new collection" value="${esc(_target.name)}"${_target.mode === 'new' ? '' : ' disabled'}>
            </span>
          </label>
          <label class="pli-choice${existing.length ? '' : ' is-disabled'}">
            <input type="radio" name="pliTarget" value="existing"${_target.mode === 'existing' ? ' checked' : ''}${existing.length ? '' : ' disabled'}>
            <span class="pli-ctext"><b>Add to a collection</b>
              ${existing.length ? `<select class="pli-select" id="pliColl" aria-label="Collection to add to"${_target.mode === 'existing' ? '' : ' disabled'}>
                ${existing.map(c => `<option value="${c.id}"${c.id === _target.collectionId ? ' selected' : ''}>${esc(collectionLabel(c))}</option>`).join('')}
              </select>
              <span class="pli-hint">The files go after the ones already in it.</span>` : '<span class="pli-hint">You have no collections yet.</span>'}
            </span>
          </label>
        </div>
        <div class="imp-note">Files go in the order the playlist has them.${r.duplicates ? ` ${plural(r.duplicates, 'entry is', 'entries are')} listed more than once and ${r.duplicates === 1 ? 'goes' : 'go'} in once, at the first place.` : ''}</div>
      </div>`;

    const lib = group('library', 'In your library', r.library.length, {
      note: `These go into the collection.${r.offline ? ` ${plural(r.offline, 'file is', 'files are')} offline right now (the drive may not be connected). ${r.offline === 1 ? 'It goes' : 'They go'} in anyway.` : ''}`,
      rows: r.library,
      rowHtml: (x) => `<li>${num(x.index)}<span class="pli-name-cell" title="${esc(x.name)}">${esc(x.title || x.name)}</span>${x.offline ? '<span class="pli-tag">Offline</span>' : ''}${x.how === 'folder' ? '<span class="pli-tag">Found in folder</span>' : ''}</li>`,
    });

    const disk = group('disk', 'On disk, not in your library', r.disk.length, {
      note: 'Add and scan… makes the collection now and opens the Add window for these files, with its usual options. Each file goes into the collection at its place in the playlist as soon as it is added. Import without them leaves them out.',
      action: `<button type="button" class="vdlg-btn pli-act" id="pliAddScan">${ico('＋ ', 'plus')}Add and scan…</button>`,
      rows: r.disk,
      rowHtml: (x) => `<li>${num(x.index)}<span class="pli-path" title="${esc(x.path)}">${esc(x.path)}</span></li>`,
    });

    const missingRows = r.missing;
    const ambiguous = r.ambiguous.length ? `
      <div class="pli-ambiguous">
        <div class="imp-note"><b>Found more than once (${fmtN(r.ambiguous.length)}).</b> Pick the right file, or leave it out.</div>
        ${r.ambiguous.map(a => `
          <fieldset class="pli-amb" data-index="${a.index}">
            <legend>${num(a.index)}<span class="pli-path" title="${esc(a.raw)}">${esc(a.raw)}</span></legend>
            ${a.options.map((o, i) => `<button type="button" class="pli-pick" data-index="${a.index}" data-pick="${i}" title="${esc(o.foundPath || o.path)}">${o.kind === 'library' ? 'In your library: ' : 'On disk: '}<span class="pli-path">${esc(o.path)}</span></button>`).join('')}
            <button type="button" class="pli-pick pli-skip" data-index="${a.index}" data-pick="skip">Leave it out</button>
          </fieldset>`).join('')}
      </div>` : '';
    const found = r.lastFind
      ? `<div class="imp-note pli-found">Looked in ${esc(r.lastFind.folder)}: found ${plural(r.lastFind.resolved, 'file')}${r.lastFind.ambiguous ? `, ${fmtN(r.lastFind.ambiguous)} more than once` : ''}.${r.lastFind.truncated ? ' The folder is very large, so Vault stopped looking part of the way.' : ''}</div>`
      : '';
    const network = r.network || [];
    const networkHtml = network.length ? `
      <details class="pli-left-item pli-network">
        <summary>${esc(`${plural(network.length, 'file is', 'files are')} on another computer and ${network.length === 1 ? 'was' : 'were'} not checked.`)}</summary>
        <div class="imp-note">Vault does not open network locations from a playlist unless your library already has files on that computer. Find in folder… can still find them by name.</div>
        <ol class="pli-rows">${network.slice(0, 200).map(x => `<li>${num(x.index)}<span class="pli-path" title="${esc(x.raw)}">${esc(x.raw)}</span></li>`).join('')}</ol>
      </details>` : '';
    const missingCount = missingRows.length + r.ambiguous.length + network.length;
    const missing = missingCount ? group('missing', 'Not found', missingCount, {
      note: 'Not at the place the playlist says. Find in folder… looks for them by file name in a folder you pick, for a playlist made on another PC or drive. Anything still missing is left out.',
      action: `<button type="button" class="vdlg-btn pli-act" id="pliFind">${ico('🔍 ', 'search')}Find in folder…</button>`,
      rows: missingRows,
      rowHtml: (x) => `<li>${num(x.index)}<span class="pli-path" title="${esc(x.raw)}">${esc(x.raw)}</span>${x.skippedByUser ? '<span class="pli-tag">Left out</span>' : ''}</li>`,
      extra: networkHtml + ambiguous + found,
    }) : '';

    const left = [];
    if (r.skipped.length) {
      const web = r.skipped.filter(s => s.reason === 'web').length;
      const other = r.skipped.length - web;
      if (web) left.push({ key: 'web', label: `${plural(web, 'web link')}. Vault does not follow links.`, rows: r.skipped.filter(s => s.reason === 'web') });
      if (other) left.push({ key: 'other', label: `${plural(other, 'entry', 'entries')} that ${other === 1 ? 'is' : 'are'} not a file on this PC.`, rows: r.skipped.filter(s => s.reason !== 'web') });
    }
    if (r.trashed.length) left.push({ key: 'trashed', label: `${plural(r.trashed.length, 'file')} in Vault's trash. Restore ${r.trashed.length === 1 ? 'it' : 'them'} first to have ${r.trashed.length === 1 ? 'it' : 'them'} in the collection.`, rows: r.trashed });
    if (r.unsupported.length) left.push({ key: 'unsupported', label: `${plural(r.unsupported.length, 'file')} Vault cannot play.`, rows: r.unsupported });
    const leftHtml = left.length ? `
      <section class="pli-group pli-left">
        <div class="imp-sect">Left out</div>
        ${left.map(l => `<details class="pli-left-item"><summary>${esc(l.label)}</summary><ol class="pli-rows">${l.rows.slice(0, 200).map(x => `<li>${num(x.index)}<span class="pli-path" title="${esc(x.raw)}">${esc(x.raw)}</span></li>`).join('')}</ol></details>`).join('')}
      </section>` : '';
    const truncated = r.truncated ? '<div class="imp-note">This playlist is very long. Only its first 200,000 entries were read.</div>' : '';
    const empty = !r.total ? '<div class="imp-note">This playlist has no entries.</div>' : '';

    body.innerHTML = target + empty + lib + disk + missing + leftHtml + truncated;
    body.scrollTop = scroll;

    const n = r.library.length;
    ov.querySelector('#pliSummary').innerHTML = `<b>${plural(n, 'file')}</b> ${_target.mode === 'new' ? 'in the new collection' : 'to add'}`;
    const go = ov.querySelector('#pliGo');
    go.textContent = _target.mode === 'new' ? 'Make collection' : 'Add to collection';
    go.disabled = !n || !targetOk();
    const addScan = ov.querySelector('#pliAddScan');
    if (addScan) addScan.disabled = !targetOk();
  }

  function targetOk() {
    if (_target.mode === 'new') return !!_target.name.trim();
    return _target.collectionId != null;
  }

  function onBodyInput(e) {
    if (e.target.id === 'pliName') {
      _target.name = e.target.value;
      const ov = document.getElementById('playlistImportModal');
      const ok = targetOk();
      ov.querySelector('#pliGo').disabled = !_review.library.length || !ok;
      const addScan = ov.querySelector('#pliAddScan');
      if (addScan) addScan.disabled = !ok;
    }
  }

  function onBodyChange(e) {
    const t = e.target;
    if (t.name === 'pliTarget') { _target.mode = t.value; render(); if (t.value === 'new') document.getElementById('pliName')?.focus(); }
    else if (t.id === 'pliColl') { _target.collectionId = Number(t.value); }
  }

  function onBodyClick(e) {
    const more = e.target.closest('[data-more]');
    if (more) {
      const key = more.dataset.more;
      _shown[key] = (_shown[key] || SHOW_FIRST) + SHOW_STEP;
      render();
      return;
    }
    if (e.target.closest('#pliFind')) { findInFolder(); return; }
    if (e.target.closest('#pliAddScan')) { doImport({ addAndScan: true }); return; }
    const pick = e.target.closest('.pli-pick');
    if (pick) choose(Number(pick.dataset.index), pick.dataset.pick === 'skip' ? null : Number(pick.dataset.pick));
  }

  function setModalBusy(on, label) {
    const ov = document.getElementById('playlistImportModal');
    if (!ov) return;
    if (on) ov.dataset.busy = '1'; else delete ov.dataset.busy;
    ov.querySelectorAll('button, input, select').forEach(el => {
      if (on) { el.dataset.wasDisabled = el.disabled ? '1' : ''; el.disabled = true; }
      else if (el.dataset.wasDisabled !== undefined) { el.disabled = el.dataset.wasDisabled === '1'; delete el.dataset.wasDisabled; }
    });
    const sum = ov.querySelector('#pliSummary');
    if (on && label) sum.textContent = label;
    if (!on) render();
  }

  async function findInFolder() {
    if (!_review) return;
    setModalBusy(true, 'Pick a folder in the folder picker…');
    let resp, data;
    try {
      resp = await fetch(`/api/playlists/import/${_review.session}/find-in-folder`, { method: 'POST' });
      data = await resp.json().catch(() => ({}));
    } catch (err) {
      setModalBusy(false);
      showToast(errWords(err, 'looking in the folder'), { type: 'error' });
      return;
    }
    if (!resp.ok) {
      setModalBusy(false);
      if (resp.status === 423) return;
      let msg = errWords({ error: data.error, status: resp.status }, 'looking in the folder');
      if (/cannot open the Windows file picker/i.test(msg)) msg = 'This copy of Vault cannot open the Windows folder picker.';
      showToast(msg, { type: 'error' });
      if (data.code === 'NOT_FOUND') closeReview({ forget: false });
      return;
    }
    if (data.canceled) { setModalBusy(false); return; }
    _review = data;
    setModalBusy(false);
    const f = data.found || {};
    showToast(f.resolved || f.ambiguous
      ? `Found ${plural(f.resolved + f.ambiguous, 'file')} in that folder.`
      : 'None of the missing files are in that folder.');
  }

  async function choose(index, pick) {
    try {
      const resp = await fetch(`/api/playlists/import/${_review.session}/choose`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, pick }),
      });
      if (!resp.ok) { showToast(errWords(await replyError(resp), 'choosing the file'), { type: 'error' }); return; }
      _review = await resp.json();
      render();
    } catch (err) {
      showToast(errWords(err, 'choosing the file'), { type: 'error' });
    }
  }

  const COMMIT_ERRORS = {
    NAME_TAKEN: 'A collection with that name already exists. Pick another name.',
    BAD_TARGET: null,
  };

  async function doImport({ addAndScan }) {
    if (!_review || !targetOk()) return;
    const review = _review;
    const body = _target.mode === 'new'
      ? { target: 'new', name: _target.name.trim(), addAndScan }
      : { target: 'existing', collectionId: _target.collectionId, addAndScan };
    setModalBusy(true, _target.mode === 'new' ? 'Making the collection…' : 'Adding to the collection…');
    let resp, data;
    try {
      resp = await fetch(`/api/playlists/import/${review.session}/commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      data = await resp.json().catch(() => ({}));
    } catch (err) {
      setModalBusy(false);
      showToast(errWords(err, 'making the collection'), { type: 'error' });
      return;
    }
    if (!resp.ok) {
      setModalBusy(false);
      if (resp.status === 423) return;
      showToast(COMMIT_ERRORS[data.code] || errWords({ error: data.error, status: resp.status }, 'making the collection'), { type: 'error' });
      if (data.code === 'NOT_FOUND') closeReview({ forget: false });
      return;
    }
    setModalBusy(false);
    closeReview({ forget: false });
    await refreshCollections(data.collectionId);
    showUndoToast(esc(doneText(data)), () => undoImport(data), 12000);
    if (addAndScan && data.disk && data.disk.length && typeof window.openImportModal === 'function') {
      window.openImportModal({
        mode: 'paths',
        title: 'Add and scan files from the playlist',
        path: `${plural(data.disk.length, 'file')} from ${review.fileName || review.name}`,
        roots: [review.name],
        subdirs: 0,
        noSubfolders: true,
        files: data.disk.map(d => ({ path: d.path, name: d.name, ext: extOf(d.name), size: d.size || 0, depth: 0 })),
        afterAdd: () => refreshCollections(data.collectionId),
      });
    }
  }

  /** The toast after an import. */
  function doneText(d) {
    const parts = [];
    const n = d.added;
    parts.push(d.created
      ? `Made “${d.name}” with ${plural(n, 'file')}.`
      : `Added ${plural(n, 'file')} to “${d.name}”.`);
    if (d.alreadyThere) parts.push(`${plural(d.alreadyThere, 'file was', 'files were')} already in it.`);
    if (d.pending) parts.push(`${plural(d.pending, 'more file goes', 'more files go')} in as ${d.pending === 1 ? 'it is' : 'they are'} added.`);
    if (d.missing) parts.push(`${plural(d.missing, 'file was', 'files were')} not found.`);
    if (d.trashed) parts.push(`${plural(d.trashed, 'file is', 'files are')} in Vault's trash.`);
    return parts.join(' ');
  }
  window.vaultPlaylistImportText = doneText;   // tests

  async function refreshCollections(collectionId) {
    try {
      if (typeof loadCollections === 'function') await loadCollections();
      const openId = typeof activeCollectionId !== 'undefined' ? activeCollectionId : null;
      if (openId != null && openId === collectionId && typeof openCollection === 'function') await openCollection(collectionId);
    } catch {}
  }

  async function undoImport(d) {
    try {
      const resp = await fetch(`/api/playlists/imports/${d.importId}/undo`, { method: 'POST' });
      if (!resp.ok) { showToast(errWords(await replyError(resp), 'undoing the import'), { type: 'error' }); return; }
      const u = await resp.json();
      const openId = typeof activeCollectionId !== 'undefined' ? activeCollectionId : null;
      if (u.deleted && openId === d.collectionId && typeof closeCollection === 'function') closeCollection();
      await refreshCollections(d.collectionId);
      showToast(u.deleted ? `Removed the collection “${d.name}”. The files stay in your library.` : `Took ${plural(u.removed, 'file')} back out of “${d.name}”.`);
    } catch (err) {
      showToast(errWords(err, 'undoing the import'), { type: 'error' });
    }
  }

  /* ── Header button (Classic shows it; Modern's + Add menu clicks it) ──── */
  document.addEventListener('DOMContentLoaded', () => {
    const btns = document.querySelector('.header-buttons');
    if (!btns || document.getElementById('importPlaylistBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'importPlaylistBtn';
    btn.className = 'header-btn';
    btn.dataset.menuText = LABELS.menu;
    btn.textContent = LABELS.idle;
    btn.title = 'Import a playlist from VLC or PotPlayer as a collection';
    btn.addEventListener('click', importPlaylist);
    const after = document.getElementById('addFolderBtn');
    if (after && after.parentNode === btns) after.after(btn);
    else btns.insertBefore(btn, btns.firstChild);
  });

  window.vaultIsPlaylistFileName = (name) => LIST_EXT.test(String(name || ''));
})();
