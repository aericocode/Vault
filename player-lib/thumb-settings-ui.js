/* =========================================================================
   THUMBNAIL SETTINGS - the "Thumbnails" group in Settings > Library.

   The settings themselves live on the server (lib/thumb-settings.js) because
   the scan CLI obeys them too; this file only draws the group, saves each
   change with POST /api/settings/thumbnails, and hands the result to
   thumbs.js (vaultSetThumbSettings) so the grid follows straight away.

   Also here: the "Space used and cleanup" fold-out (closed by default) and
   the "Remove saved thumbnails?" dialog shown when a change makes the
   pictures already saved unnecessary. Nothing is ever deleted without a
   second click naming the size, and the files themselves are never touched.

   settings.js calls vaultThumbSettingsHtml() inside RENDERERS_library and
   vaultWireThumbSettings() from wireLibrarySection, in both looks.
   ========================================================================= */

(function () {
  const MAKE = [
    { value: 'off', label: 'Off' },
    { value: 'all', label: 'For every file' },
    { value: 'shown', label: 'When shown' },
  ];
  const STEP = { memoryMB: 100, diskCapMB: 1024 };
  const UNIT = { memoryMB: 'MB', diskCapMB: 'GB' };   // a bare number typed means this

  // What the server last said. Filled before the first paint from thumbs.js.
  let cfg = null;
  let bounds = { memoryMB: { min: 50, max: 4096 }, diskCapMB: { min: 100, max: 1048576 } };
  let spaceOpen = false;

  const h = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s)) : String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

  function current() {
    if (cfg) return cfg;
    const t = typeof thumbCfg === 'function' ? thumbCfg() : {};
    return { make: 'all', keep: 'keep', diskCapMB: 2048, memoryMB: 300, hover: true, inside: true, ...t };
  }

  /* ── Sizes ──────────────────────────────────────────────────────────── */

  /** 300 -> "300 MB", 2048 -> "2 GB", 1536 -> "1.5 GB". */
  function fmtMB(mb) {
    if (mb < 1024) return `${mb} MB`;
    return `${+(mb / 1024).toFixed(2)} GB`;
  }

  /** Bytes for the space numbers. */
  function fmtBytes(b) {
    const n = Number(b) || 0;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
    return `${(n / 1073741824).toFixed(1)} GB`;
  }

  /**
   * "450", "450 MB", "1.5 GB", "2g" -> whole MB. A bare number is in the box's
   * own unit (MB for memory, GB for disk). null when it is not a size.
   */
  function parseSize(text, defUnit) {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*([mg]b?|[mg]i?b)?\s*$/i.exec(String(text || ''));
    if (!m) return null;
    const n = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const unit = m[2] ? m[2][0].toUpperCase() + 'B' : defUnit;
    return Math.round(unit === 'GB' ? n * 1024 : n);
  }

  function boundsText(key) {
    const b = bounds[key];
    return `${fmtMB(b.min)} to ${fmtMB(b.max)}`;
  }

  /* ── Markup ─────────────────────────────────────────────────────────── */

  function sizeBox(key, label) {
    const c = current();
    return `<span class="th-size" data-th-size-wrap="${key}">
        <input type="text" class="th-size-input" data-th-size="${key}" inputmode="decimal"
               spellcheck="false" autocomplete="off" aria-label="${h(label)}" value="${h(fmtMB(c[key]))}" data-mb="${c[key]}">
        <span class="th-size-arrows">
          <button type="button" class="th-size-step" data-th-step="${key}" data-th-dir="1" tabindex="-1" aria-label="More">&#9652;</button>
          <button type="button" class="th-size-step" data-th-step="${key}" data-th-dir="-1" tabindex="-1" aria-label="Less">&#9662;</button>
        </span>
      </span>`;
  }

  function radio(value, titleHtml, desc) {
    const c = current();
    return `<label class="th-radio">
        <input type="radio" name="thKeep" value="${value}" ${c.keep === value ? 'checked' : ''}>
        <span class="th-radio-text">
          <span class="th-radio-title">${titleHtml}</span>
          <span class="settings-toggle-desc">${desc}</span>
        </span>
      </label>`;
  }

  function toggle(key, title, desc) {
    const c = current();
    return settingsRowHtml({
      tag: 'label', sfind: `th-${key}`, title, desc,
      control: `<input type="checkbox" data-th-toggle="${key}" ${c[key] ? 'checked' : ''}>
        <span class="settings-switch" aria-hidden="true"></span>`,
    });
  }

  // Modern words a few lines shorter; Classic keeps its own.
  const modern = () => typeof settingsIsModern === 'function' && settingsIsModern();

  function html() {
    const c = current();
    const m = modern();
    const group = `
      <div class="th-group" id="thGroup">${settingsRowHtml({
        cls: 'settings-seg-row', sfind: 'thMake', titleId: 'segLabel_thMake', title: 'Make thumbnails',
        desc: m ? 'Pictures on tiles, in the preview pane and on the Wall.' : 'The small pictures on tiles, in the dock and on the Wall.',
        extra: `
            <span class="settings-toggle-desc th-off-note" id="thOffNote" ${c.make === 'off' ? '' : 'hidden'}>Off: no pictures are made or saved, and tiles show the file type icon.</span>`,
        control: `<span class="settings-seg" role="group" aria-labelledby="segLabel_thMake">
            ${MAKE.map(o => `
              <button type="button" class="settings-seg-btn" data-th-make="${o.value}"
                      aria-pressed="${c.make === o.value ? 'true' : 'false'}">${h(o.label)}</button>`).join('')}
          </span>`,
      })}

        <div class="th-sub" id="thKeepBox" data-sfind="thKeep" ${c.make === 'shown' ? '' : 'hidden'}>
          ${radio('keep', 'Keep them', 'Made the first time a tile is on screen, then saved like today.')}
          ${radio('cap', `Keep up to ${sizeBox('diskCapMB', 'Disk limit')}`, 'On disk. The ones not seen for longest are removed first.')}
          ${radio('memory', `Only while Vault is running, up to ${sizeBox('memoryMB', 'Memory limit')}`, 'Held in memory, nothing saved to disk. The ones not seen for longest are dropped first. Tiles are made again after a restart.')}
          <p class="settings-note th-bounds">Type an exact size, for example 450 MB. Disk: ${h(boundsText('diskCapMB'))}. Memory: ${h(boundsText('memoryMB'))}.</p>
        </div>

        <div class="th-more" id="thMore" ${c.make === 'off' ? 'hidden' : ''}>
          ${toggle('inside', 'Use pictures already inside files', m
            ? 'Album art in music and the cover art some videos carry. Nothing is made for those.'
            : 'Album art in music, and cover art some videos carry (common for downloaded or ripped videos, rare from phones and cameras). Those files need nothing made or stored.')}
          ${toggle('hover', 'Hover preview frames', m
            ? '5 extra pictures per video for scrubbing on hover. Most of the space thumbnails use.'
            : '5 extra pictures per video for scrubbing when you hover a tile. About 85% of the space thumbnails use.')}
        </div>

        <p class="th-status" id="thStatus" role="status" aria-live="polite"></p>

        <div class="th-disc">
          <button type="button" class="th-disc-h" id="thSpaceToggle" data-sfind="thSpace" aria-expanded="${spaceOpen}" aria-controls="thSpaceBody">
            <span class="mig-chev" aria-hidden="true">${spaceOpen ? '&#9662;' : '&#9656;'}</span>
            <span>Space used and cleanup</span>
          </button>
          <div class="th-disc-b" id="thSpaceBody" ${spaceOpen ? '' : 'hidden'}>
            <div class="th-space" id="thSpace">Counting…</div>
          </div>
        </div>
      </div>`;
    if (m) return settingsCardHtml({ title: 'Thumbnails', body: group });
    return `
      <h3 class="settings-h">Thumbnails</h3>${group}`;
  }

  /* ── Saving ─────────────────────────────────────────────────────────── */

  function status(text, bad = false) {
    const el = document.getElementById('thStatus');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('th-bad', !!bad);
  }

  async function push(patch) {
    const res = await fetch('/api/settings/thumbnails', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function adopt(data) {
    cfg = {
      make: data.make, keep: data.keep, diskCapMB: data.diskCapMB, memoryMB: data.memoryMB,
      hover: data.hover, inside: data.inside,
      // The server bumps this to give every tile a new URL (thumbs.js
      // thumbVersionTag); dropping it here would undo that until a reload.
      salt: Number(data.salt) || 0,
    };
    if (data.bounds) bounds = data.bounds;
    if (typeof window.vaultSetThumbSettings === 'function') window.vaultSetThumbSettings(cfg);
  }

  /** Repaint the group's controls from cfg without rebuilding it. */
  function paint() {
    const c = current();
    const root = document.getElementById('thGroup');
    if (!root) return;
    root.querySelectorAll('[data-th-make]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.thMake === c.make)));
    root.querySelectorAll('input[name="thKeep"]').forEach(r => { r.checked = r.value === c.keep; });
    root.querySelectorAll('[data-th-toggle]').forEach(t => { t.checked = !!c[t.dataset.thToggle]; });
    root.querySelectorAll('[data-th-size]').forEach(inp => {
      if (document.activeElement !== inp) {
        inp.value = fmtMB(c[inp.dataset.thSize]);
        inp.dataset.mb = String(c[inp.dataset.thSize]);
      }
    });
    document.getElementById('thKeepBox').hidden = c.make !== 'shown';
    document.getElementById('thMore').hidden = c.make === 'off';
    document.getElementById('thOffNote').hidden = c.make !== 'off';
  }

  function storageOf(c) {
    if (c.make === 'off') return 'off';
    return c.make === 'all' ? 'keep' : c.keep;
  }

  /** Save a change, repaint the grid, then offer to remove what is no longer needed. */
  async function change(patch) {
    const before = { ...current() };
    status('Saving…');
    let data;
    try {
      data = await push(patch);
    } catch (err) {
      status(err.message, true);
      paint();
      return;
    }
    adopt(data);
    paint();
    status('Saved.');
    if (typeof renderResults === 'function') { try { renderResults(); } catch {} }
    if (spaceOpen) loadSpace();
    offerCleanup(before, current());
  }

  /* ── "Remove saved thumbnails?" ─────────────────────────────────────── */

  function describe(c) {
    if (c.make === 'off') return 'Off';
    if (c.make === 'all') return 'For every file';
    if (c.keep === 'memory') return `When shown, only while Vault is running`;
    if (c.keep === 'cap') return `When shown, keep up to ${fmtMB(c.diskCapMB)}`;
    return 'When shown, keep them';
  }

  async function offerCleanup(prev, next) {
    const sBefore = storageOf(prev);
    const sAfter = storageOf(next);
    let ask = null;
    if ((sAfter === 'off' && sBefore !== 'off') || (sAfter === 'memory' && sBefore !== 'memory')) {
      ask = { what: 'all', lead: `You switched to <b>${h(describe(next))}</b>.` };
    } else if (sAfter === 'cap' && (sBefore !== 'cap' || next.diskCapMB < prev.diskCapMB)) {
      ask = { what: 'trim', lead: `You set a limit of <b>${h(fmtMB(next.diskCapMB))}</b>.` };
    } else if (prev.hover && !next.hover && sAfter !== 'off') {
      ask = { what: 'scrub', lead: 'You turned hover preview frames off.' };
    }
    if (!ask) return;

    let sp;
    try { sp = await fetch('/api/thumbnails/space').then(r => (r.ok ? r.json() : null)); } catch { sp = null; }
    if (!sp) return;
    if (sp.deleting) { watchDelete(sp.deleting); return; }   // one delete at a time
    const stored = sp.covers.bytes + sp.scrub.bytes;
    let bytes;
    if (ask.what === 'all') bytes = stored;
    else if (ask.what === 'scrub') bytes = sp.scrub.bytes;
    else {
      // Exactly what Remove would take now (down to 95% of the limit, never
      // what is on screen), not a guess from the totals.
      let est = null;
      try { est = await fetch('/api/thumbnails/trim-estimate').then(r => (r.ok ? r.json() : null)); } catch {}
      bytes = est ? est.bytes : 0;
    }
    if (!(bytes > 0)) return;

    const have = ask.what === 'scrub' ? 'Hover frames you already have use' : 'Thumbnails you already have use';
    const keepNote = ask.what === 'trim'
      ? ' If you keep them, the ones not seen for longest are removed over time until they fit.'
      : '';
    const choice = await dialog({
      title: 'Remove saved thumbnails?',
      body: `<p class="th-dlg-p">${ask.lead} ${have} <b>${h(fmtBytes(stored && ask.what !== 'scrub' ? stored : bytes))}</b>.${keepNote}</p>
        <div class="th-warn"><b>Your files are not touched.</b> Only the saved pictures are removed. If you switch back later, they are made again, which takes time.</div>`,
      keep: 'Keep them',
      remove: `Remove ${fmtBytes(bytes)}`,
    });
    if (choice !== 'remove') return;
    await runDelete(ask.what);
  }

  /** A small modal. Keep is the default (focused) button. Resolves 'keep' | 'remove'. */
  function dialog({ title, body, keep, remove }) {
    return new Promise((resolve) => {
      document.getElementById('thDialog')?._close?.();
      const opener = document.activeElement;
      const ov = document.createElement('div');
      ov.id = 'thDialog';
      ov.className = 'vault-modal-overlay';
      ov.innerHTML = `
        <div class="vault-modal th-dlg" role="alertdialog" aria-modal="true" aria-labelledby="thDialogTitle">
          <h3 id="thDialogTitle">${h(title)}</h3>
          ${body}
          <div class="vault-modal-actions">
            <button type="button" class="vault-btn" data-th-ans="keep">${h(keep)}</button>
            <button type="button" class="vault-btn th-btn-danger" data-th-ans="remove">${h(remove)}</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const done = (v) => {
        if (!ov.isConnected) return;
        ov.remove();
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
        resolve(v);
      };
      ov._close = () => done('keep');
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) done('keep'); });
      ov.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('keep'); return; }
        if (e.key !== 'Tab') return;
        const f = [...ov.querySelectorAll('button')];
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      });
      ov.querySelectorAll('[data-th-ans]').forEach(b => b.addEventListener('click', () => done(b.dataset.thAns)));
      ov.querySelector('[data-th-ans="keep"]').focus();
    });
  }

  /* ── A delete in progress (this tab's, another tab's, or from before the
     panel was opened): the server says so in /api/thumbnails/space. While
     it runs the delete buttons and the dialog's Remove are off, and the
     status line counts. ── */

  let delPoll = null;
  let delBusy = false;

  function setDeleteBusy(on) {
    delBusy = !!on;
    document.querySelectorAll('[data-th-del]').forEach(b => {
      b.disabled = delBusy || !(Number(b.dataset.thBytes) > 0);
    });
    document.querySelectorAll('[data-th-ans="remove"]').forEach(b => { b.disabled = delBusy; });
  }

  function deletingText(d) {
    const noun = d.what === 'scrub' ? 'hover frames' : 'thumbnails';
    const n = d.total > 0 ? ` ${d.done.toLocaleString()} of ${d.total.toLocaleString()} done.` : '';
    return `Deleting saved ${noun}…${n} On a large library this can take a few minutes.`;
  }

  /** Follow a running delete until the server says it is over. */
  function watchDelete(d) {
    setDeleteBusy(true);
    status(deletingText(d));
    if (delPoll) return;
    delPoll = setInterval(async () => {
      let sp = null;
      try { sp = await fetch('/api/thumbnails/space').then(r => (r.ok ? r.json() : null)); } catch {}
      if (!sp) return;
      if (sp.deleting) { status(deletingText(sp.deleting)); return; }
      clearInterval(delPoll);
      delPoll = null;
      setDeleteBusy(false);
      status('Done. The saved pictures are deleted.');
      const box = document.getElementById('thSpace');
      if (spaceOpen && box && box.isConnected) renderSpace(box, sp);
    }, 1500);
  }

  async function runDelete(what) {
    if (delBusy) return;
    setDeleteBusy(true);
    status(deletingText({ what, done: 0, total: 0 }));
    watchDelete({ what, done: 0, total: 0 });
    try {
      const res = await fetch('/api/thumbnails/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (delPoll) { clearInterval(delPoll); delPoll = null; }
      status(`Removed ${fmtBytes(data.bytes)} of saved pictures.`);
    } catch (err) {
      if (delPoll) { clearInterval(delPoll); delPoll = null; }
      status(`Could not remove them: ${err.message}`, true);
    }
    setDeleteBusy(false);
    if (typeof window.vaultSetThumbSettings === 'function') window.vaultSetThumbSettings(current());
    if (typeof renderResults === 'function') { try { renderResults(); } catch {} }
    if (spaceOpen) loadSpace();
  }

  /* ── Space used and cleanup ─────────────────────────────────────────── */

  async function loadSpace() {
    const box = document.getElementById('thSpace');
    if (!box) return;
    box.textContent = 'Counting…';
    let sp = null;
    try { sp = await fetch('/api/thumbnails/space').then(r => (r.ok ? r.json() : null)); } catch {}
    if (!box.isConnected) return;
    if (!sp) { box.textContent = 'Could not count them.'; return; }
    renderSpace(box, sp);
  }

  function renderSpace(box, sp) {
    // The headline is thumbnails only (covers and hover frames). Face crops
    // and the beat audio cache are shown on their own line: they are not
    // thumbnails and nothing here deletes them.
    const total = sp.covers.bytes + sp.scrub.bytes + sp.other.bytes;   // the bar's whole
    const files = sp.covers.count + sp.scrub.count;
    const thumbs = sp.covers.bytes + sp.scrub.bytes;
    const pct = (b) => (total > 0 ? Math.max(b > 0 ? 0.5 : 0, (b / total) * 100) : 0).toFixed(2);
    const mem = sp.memory || { bytes: 0, count: 0 };
    // Only in "only while running": in the other modes memory holds just the
    // pictures read from inside files, and the line would read as a promise.
    const memLine = storageOf(current()) === 'memory'
      ? `<div class="th-mem">In memory now: <b>${h(fmtBytes(mem.bytes + (mem.art ? mem.art.bytes : 0)))}</b> of ${h(fmtBytes(mem.max))} (${(mem.count + (mem.art ? mem.art.count : 0)).toLocaleString()} pictures, nothing on disk).</div>`
      : '';
    box.innerHTML = `
      <div>Thumbnails use <b>${h(fmtBytes(thumbs))}</b> for ${files.toLocaleString()} files.</div>
      ${sp.other.count > 0 ? `<div class="th-other">Other saved data (face crops, beat audio): ${h(fmtBytes(sp.other.bytes))} in ${sp.other.count.toLocaleString()} files, not deleted here.</div>` : ''}
      <div class="th-bar" aria-hidden="true">
        <b class="th-bar-covers" style="width:${pct(sp.covers.bytes)}%"></b><b class="th-bar-scrub" style="width:${pct(sp.scrub.bytes)}%"></b><b class="th-bar-other" style="width:${pct(sp.other.bytes)}%"></b>
      </div>
      <div class="th-legend">
        <span><i class="th-bar-covers"></i>Covers ${h(fmtBytes(sp.covers.bytes))}</span>
        <span><i class="th-bar-scrub"></i>Hover frames ${h(fmtBytes(sp.scrub.bytes))}</span>
        <span title="Face crops and the beat audio cache. Not deleted here."><i class="th-bar-other"></i>Other ${h(fmtBytes(sp.other.bytes))}</span>
      </div>
      ${memLine}
      <div class="th-warn"><b>This deletes saved pictures, not your files.</b> Your videos and photos are not touched. Making the pictures again takes time: hours on a large library, longer on a slow drive.</div>
      <div class="th-btns" id="thDelBtns">
        <button type="button" class="settings-btn th-btn-danger" data-th-del="scrub" data-th-bytes="${sp.scrub.bytes}" ${sp.scrub.bytes > 0 ? '' : 'disabled'}>Delete hover frames (${h(fmtBytes(sp.scrub.bytes))})</button>
        <button type="button" class="settings-btn th-btn-danger" data-th-del="all" data-th-bytes="${thumbs}" ${thumbs > 0 ? '' : 'disabled'}>Delete all thumbnails (${h(fmtBytes(thumbs))})</button>
      </div>
      <div class="th-confirm" id="thDelConfirm" hidden></div>`;
    if (sp.deleting) watchDelete(sp.deleting);
    else if (delBusy) setDeleteBusy(true);
    box.querySelectorAll('[data-th-del]').forEach(b => b.addEventListener('click', () => confirmDelete(b.dataset.thDel, Number(b.dataset.thBytes))));
  }

  /** The confirm step, in the page: names the size and that files are untouched. */
  function confirmDelete(what, bytes) {
    if (delBusy) return;
    const bar = document.getElementById('thDelConfirm');
    const btns = document.getElementById('thDelBtns');
    if (!bar || !btns) return;
    const size = fmtBytes(bytes);
    const noun = what === 'scrub' ? 'hover frames' : 'thumbnails';
    bar.innerHTML = `
      <span>Delete ${h(size)} of ${noun}? Your files are not touched.</span>
      <span class="th-btns">
        <button type="button" class="settings-btn" data-th-confirm="no">Cancel</button>
        <button type="button" class="settings-btn th-btn-danger" data-th-confirm="yes">Delete ${h(size)}</button>
      </span>`;
    btns.hidden = true;
    bar.hidden = false;
    bar.querySelector('[data-th-confirm="no"]').focus();
    bar.querySelector('[data-th-confirm="no"]').addEventListener('click', () => { bar.hidden = true; btns.hidden = false; });
    bar.querySelector('[data-th-confirm="yes"]').addEventListener('click', async () => {
      bar.querySelectorAll('button').forEach(b => { b.disabled = true; });
      await runDelete(what);
    });
  }

  function setSpaceOpen(open) {
    spaceOpen = !!open;
    const body = document.getElementById('thSpaceBody');
    const btn = document.getElementById('thSpaceToggle');
    if (!body || !btn) return;
    body.hidden = !spaceOpen;
    btn.setAttribute('aria-expanded', String(spaceOpen));
    btn.querySelector('.mig-chev').innerHTML = spaceOpen ? '&#9662;' : '&#9656;';
    if (spaceOpen) loadSpace();
  }

  /* ── Size boxes ─────────────────────────────────────────────────────── */

  /**
   * The size a box stands for, in whole MB. The box shows a rounded figure
   * (1100 MB reads "1.07 GB"), so it keeps the exact value in data-mb and only
   * re-reads the text when the user typed something else.
   */
  function boxMB(text, trueMB, key) {
    if (Number.isFinite(trueMB) && String(text).trim() === fmtMB(trueMB)) return trueMB;
    return parseSize(text, UNIT[key]);
  }

  /** Where an arrow goes from what the box shows: exactly one step. */
  function stepFrom(text, trueMB, key, dir) {
    const b = bounds[key];
    const base = boxMB(text, trueMB, key) ?? trueMB;
    return Math.max(b.min, Math.min(b.max, base + dir * STEP[key]));
  }

  function commitSize(inp, exact) {
    const key = inp.dataset.thSize;
    const c = current();
    const mb = exact != null ? exact : boxMB(inp.value, Number(inp.dataset.mb), key);
    const b = bounds[key];
    if (mb == null || mb < b.min || mb > b.max) {
      const what = key === 'memoryMB' ? 'The memory limit' : 'The disk limit';
      status(`${what} can be ${boundsText(key)}. Type a size like ${key === 'memoryMB' ? '450 MB' : '3 GB'}.`, true);
      inp.value = fmtMB(c[key]);
      inp.dataset.mb = String(c[key]);
      return;
    }
    inp.value = fmtMB(mb);
    inp.dataset.mb = String(mb);
    const patch = { [key]: mb };
    // Typing a size picks its option too.
    const keep = key === 'memoryMB' ? 'memory' : 'cap';
    if (c.keep !== keep) patch.keep = keep;
    if (mb === c[key] && !patch.keep) return;
    change(patch);
  }

  function step(key, dir) {
    const inp = document.querySelector(`[data-th-size="${key}"]`);
    if (!inp) return;
    const trueMB = Number(inp.dataset.mb) || current()[key];
    const next = stepFrom(inp.value, trueMB, key, dir);
    inp.value = fmtMB(next);
    commitSize(inp, next);
  }

  /* ── Wiring ─────────────────────────────────────────────────────────── */

  async function wire() {
    const root = document.getElementById('thGroup');
    if (!root) return;

    root.querySelectorAll('[data-th-make]').forEach(btn => btn.addEventListener('click', () => {
      if (btn.dataset.thMake !== current().make) change({ make: btn.dataset.thMake });
    }));
    root.querySelectorAll('input[name="thKeep"]').forEach(r => r.addEventListener('change', () => {
      if (r.checked && r.value !== current().keep) change({ keep: r.value });
    }));
    root.querySelectorAll('[data-th-toggle]').forEach(t => t.addEventListener('change', () => {
      change({ [t.dataset.thToggle]: t.checked });
    }));
    root.querySelectorAll('[data-th-size]').forEach(inp => {
      inp.addEventListener('change', () => commitSize(inp));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          step(inp.dataset.thSize, e.key === 'ArrowUp' ? 1 : -1);
        }
      });
      // A click in the box must not tick the radio before a value is typed.
      inp.addEventListener('click', (e) => e.preventDefault());
    });
    root.querySelectorAll('[data-th-step]').forEach(btn => btn.addEventListener('click', (e) => {
      e.preventDefault();
      step(btn.dataset.thStep, Number(btn.dataset.thDir));
    }));
    document.getElementById('thSpaceToggle').addEventListener('click', () => setSpaceOpen(!spaceOpen));
    if (spaceOpen) loadSpace();

    // Fresh numbers from the server (another window may have changed them).
    try {
      const r = await fetch('/api/settings/thumbnails');
      if (r.ok) { adopt(await r.json()); paint(); }
    } catch {}
  }

  window.vaultThumbSettingsHtml = html;
  window.vaultWireThumbSettings = wire;
  // For tests.
  window.vaultThumbSizeParse = parseSize;
  window.vaultThumbFmtMB = fmtMB;
  window.vaultThumbStepFrom = stepFrom;
  window.vaultThumbAdopt = adopt;   // tests
})();
