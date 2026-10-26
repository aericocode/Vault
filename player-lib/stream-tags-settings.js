/* =========================================================================
   SETTINGS › STAGE › LANES AND STREAM TAGS - the editor for your lanes and
   their tags (player-lib/stream-tags.js keeps the page's copy; the server
   is lib/stream-tags.js).

   Per lane: its name, One per file / Several per file, up / down, Delete.
   Per tag: its colour, name, Place (where Flow order puts its files), key,
   up / down, Delete. "+ Add a tag" under each lane, "+ Add a lane" at the
   end. Every change is saved as it is made; deleting a lane or tag that
   files carry, and switching a lane to One per file when files carry
   several of its tags, ask first and say how many files.

   stage-settings-ui.js draws it on the Stage page (streamLanesSettingsHtml)
   and wires it (streamLanesSettingsWire).
   ========================================================================= */

const STREAM_LANE_COLORS = ['#4ade80', '#f59e0b', '#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#7dd3fc', '#fde047', '#94a3b8', '#f87171'];

function _slEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function _slPlaceSelect(t) {
  const labels = typeof StreamTags !== 'undefined' ? StreamTags.PLACE_LABELS : { anywhere: 'Anywhere' };
  return `<select class="settings-sel sl-place" data-sl-tag-place="${t.id}" aria-label="Place for ${_slEsc(t.name)}" title="Where Flow order puts files with this tag">
      ${Object.entries(labels).map(([v, l]) => `<option value="${v}"${t.place === v ? ' selected' : ''}>Place: ${_slEsc(l)}</option>`).join('')}
    </select>`;
}

function _slTagRow(t, i, n) {
  const files = t.count ? `<span class="sl-count" title="Files with this tag">${t.count.toLocaleString()} ${t.count === 1 ? 'file' : 'files'}</span>` : '';
  return `<div class="sl-tag" data-sl-tag="${t.id}">
      <input type="color" class="sl-color" data-sl-tag-color="${t.id}" value="${_slEsc(t.color)}" aria-label="Colour for ${_slEsc(t.name)}" title="Colour">
      <input type="text" class="settings-text sl-name" data-sl-tag-name="${t.id}" value="${_slEsc(t.name)}" maxlength="40" spellcheck="false" autocomplete="off" aria-label="Tag name">
      ${files}
      ${_slPlaceSelect(t)}
      <input type="text" class="settings-text sl-key" data-sl-tag-key="${t.id}" value="${_slEsc(t.hotkey || '')}" maxlength="2" spellcheck="false" autocomplete="off" placeholder="key" aria-label="Key for ${_slEsc(t.name)}" title="Press it while hovering a tile, or over the Stage bar. Empty: no key">
      <span class="sl-acts">
        <button type="button" class="sl-btn" data-sl-tag-move="${t.id}" data-dir="-1" title="Move up" aria-label="Move ${_slEsc(t.name)} up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="sl-btn" data-sl-tag-move="${t.id}" data-dir="1" title="Move down" aria-label="Move ${_slEsc(t.name)} down"${i === n - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" class="sl-btn sl-del" data-sl-tag-del="${t.id}" title="Delete this tag" aria-label="Delete ${_slEsc(t.name)}">✕</button>
      </span>
    </div>`;
}

function _slLaneHtml(l, i, n) {
  return `<div class="sl-lane" data-sl-lane="${l.id}">
      <div class="sl-lanehead">
        <input type="text" class="settings-text sl-lane-name" data-sl-lane-name="${l.id}" value="${_slEsc(l.name)}" maxlength="40" spellcheck="false" autocomplete="off" aria-label="Lane name">
        <select class="settings-sel sl-multi" data-sl-lane-multi="${l.id}" aria-label="How many tags of ${_slEsc(l.name)} a file can have">
          <option value="1"${l.multi ? ' selected' : ''}>Several per file</option>
          <option value="0"${l.multi ? '' : ' selected'}>One per file</option>
        </select>
        <span class="sl-acts">
          <button type="button" class="sl-btn" data-sl-lane-move="${l.id}" data-dir="-1" title="Move this lane up" aria-label="Move ${_slEsc(l.name)} up"${i === 0 ? ' disabled' : ''}>↑</button>
          <button type="button" class="sl-btn" data-sl-lane-move="${l.id}" data-dir="1" title="Move this lane down" aria-label="Move ${_slEsc(l.name)} down"${i === n - 1 ? ' disabled' : ''}>↓</button>
          <button type="button" class="sl-btn sl-del" data-sl-lane-del="${l.id}" title="Delete this lane and its tags" aria-label="Delete the lane ${_slEsc(l.name)}">✕</button>
        </span>
      </div>
      ${l.tags.map((t, k) => _slTagRow(t, k, l.tags.length)).join('')}
      <button type="button" class="sl-add sl-addtag" data-sl-add-tag="${l.id}">+ Add a tag to ${_slEsc(l.name)}</button>
    </div>`;
}

/** The editor's inside (lanes, or a line while they load). */
function _slBodyHtml() {
  const ready = typeof StreamTags !== 'undefined' && StreamTags.loaded();
  const lanes = ready ? StreamTags.lanes() : [];
  const list = !ready ? '<p class="settings-note">Loading your lanes…</p>'
    : lanes.length ? lanes.map((l, i) => _slLaneHtml(l, i, lanes.length)).join('')
      : '<p class="settings-note">No lanes yet.</p>';
  return `${list}
    <button type="button" class="sl-add" data-sl-add-lane>+ Add a lane</button>
    <p class="settings-note sl-note">One per file: tagging a file in that lane replaces its tag there (good for Mood). Several per file: tags add up.
      Key: press it while the pointer is over a tile or row, or over the Stage bar while Stage is open. Press it again to take the tag off.
      While the mini player or Stage is open, Q, N, P, R, H and 0 to 9 stay theirs. Place: where Flow order puts these files when Place tagged files is on.
      Stream tags are your own and never mix into the library's tags.</p>`;
}

/** The card (Modern) or the section (Classic) on the Stage page. */
function streamLanesSettingsHtml(modern) {
  const body = `<div class="sl-editor" data-sl-editor>${_slBodyHtml()}</div>`;
  if (modern && typeof settingsCardHtml === 'function') return settingsCardHtml({ title: 'Lanes and stream tags', sfind: 'stageLanes', body });
  return `<h3 class="settings-h" data-sfind="stageLanes">${typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel('🏷 Lanes and stream tags', { icon: false }) : 'Lanes and stream tags'}</h3>${body}`;
}

function _slRepaint(root, focusSel = null) {
  const box = root && root.querySelector('[data-sl-editor]');
  if (!box) return;
  // Keep the field being typed in, and where the page is.
  const active = document.activeElement;
  const keep = !focusSel && active && box.contains(active) ? [...active.attributes].find(a => a.name.startsWith('data-sl-')) : null;
  box.innerHTML = _slBodyHtml();
  const sel = focusSel || (keep ? `[${keep.name}="${keep.value}"]` : null);
  const el = sel ? box.querySelector(sel) : null;
  if (el) { try { el.focus({ preventScroll: true }); if (focusSel && el.select) el.select(); } catch {} }
}

async function _slCall(url, body, what, root) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Server returned ${r.status}`), { status: r.status, code: data.code });
    return data;
  } catch (err) {
    if (typeof showErrorToast === 'function') showErrorToast(err, what);
    // What the server has, back in the fields.
    await StreamTags.reloadLanes();
    _slRepaint(root);
    return null;
  }
}

const _slFiles = (n) => `${Number(n).toLocaleString()} ${n === 1 ? 'file' : 'files'}`;

function _slUniqueName(base, taken) {
  const lower = new Set(taken.map(s => s.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!lower.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

async function _slAfter(root, focusSel) {
  await StreamTags.reloadLanes();
  _slRepaint(root, focusSel);
}

/** Wire the editor drawn into root (stageSettingsWire calls this). */
function streamLanesSettingsWire(root) {
  if (!root || typeof StreamTags === 'undefined') return;
  // Fresh counts each time the page opens (files were tagged since).
  (StreamTags.loaded() ? StreamTags.reloadLanes() : StreamTags.load()).then(() => _slRepaint(root));
  if (root._slWired) return;
  root._slWired = true;
  const laneOf = (id) => StreamTags.lanes().find(l => l.id === id);
  const tagOf = (id) => StreamTags.tag(id);

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled || !b.closest('[data-sl-editor]')) return;
    if (b.hasAttribute('data-sl-add-lane')) {
      const name = _slUniqueName('New lane', StreamTags.lanes().map(l => l.name));
      const lane = await _slCall('/api/stream-tags/lanes', { name, multi: true }, 'adding a lane', root);
      if (lane) await _slAfter(root, `[data-sl-lane-name="${lane.id}"]`);
      return;
    }
    if (b.dataset.slAddTag) {
      const lane = laneOf(Number(b.dataset.slAddTag));
      if (!lane) return;
      const all = StreamTags.lanes().flatMap(l => l.tags);
      const color = STREAM_LANE_COLORS[all.length % STREAM_LANE_COLORS.length];
      const name = _slUniqueName('New tag', lane.tags.map(t => t.name));
      const t = await _slCall('/api/stream-tags/tags', { laneId: lane.id, name, color, place: 'anywhere' }, 'adding a tag', root);
      if (t) await _slAfter(root, `[data-sl-tag-name="${t.id}"]`);
      return;
    }
    if (b.dataset.slLaneMove) {
      const ids = StreamTags.lanes().map(l => l.id);
      const i = ids.indexOf(Number(b.dataset.slLaneMove)), j = i + Number(b.dataset.dir);
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      if (await _slCall('/api/stream-tags/lanes/order', { ids }, 'moving a lane', root)) await _slAfter(root, `[data-sl-lane-move="${ids[j]}"][data-dir="${b.dataset.dir}"]`);
      return;
    }
    if (b.dataset.slTagMove) {
      const t = tagOf(Number(b.dataset.slTagMove));
      const lane = t && laneOf(t.laneId);
      if (!lane) return;
      const ids = lane.tags.map(x => x.id);
      const i = ids.indexOf(t.id), j = i + Number(b.dataset.dir);
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      if (await _slCall(`/api/stream-tags/lanes/${lane.id}/order`, { ids }, 'moving a tag', root)) await _slAfter(root, `[data-sl-tag-move="${t.id}"][data-dir="${b.dataset.dir}"]`);
      return;
    }
    if (b.dataset.slTagDel) {
      const t = tagOf(Number(b.dataset.slTagDel));
      if (!t) return;
      if (t.count && typeof vaultConfirm === 'function') {
        const ok = await vaultConfirm(`${t.name} is on ${_slFiles(t.count)}. Delete it? Those files lose this tag.`, { title: 'Delete this stream tag?', okLabel: 'Delete', danger: true });
        if (!ok) return;
      }
      if (await _slCall(`/api/stream-tags/tags/${t.id}/delete`, {}, 'deleting a tag', root)) {
        await _slAfter(root);
        if (typeof showToast === 'function') showToast(`${t.name} deleted`);
      }
      return;
    }
    if (b.dataset.slLaneDel) {
      const lane = laneOf(Number(b.dataset.slLaneDel));
      if (!lane) return;
      const tagsWord = lane.tags.length === 1 ? '1 tag' : `${lane.tags.length} tags`;
      const msg = lane.files
        ? `${lane.name} and its ${tagsWord} are on ${_slFiles(lane.files)}. Delete the lane? Those files lose these tags.`
        : `Delete the lane ${lane.name}${lane.tags.length ? ` and its ${tagsWord}` : ''}?`;
      if (typeof vaultConfirm === 'function') {
        const ok = await vaultConfirm(msg, { title: 'Delete this lane?', okLabel: 'Delete', danger: !!lane.files });
        if (!ok) return;
      }
      if (await _slCall(`/api/stream-tags/lanes/${lane.id}/delete`, {}, 'deleting a lane', root)) {
        await _slAfter(root);
        if (typeof showToast === 'function') showToast(`${lane.name} deleted`);
      }
    }
  });

  // Names: saved when you leave the field or press Enter.
  const saveName = async (el) => {
    const v = el.value.replace(/\s+/g, ' ').trim();
    if (el.dataset.slLaneName) {
      const lane = laneOf(Number(el.dataset.slLaneName));
      if (!lane || v === lane.name) { if (lane) el.value = lane.name; return; }
      if (!v) { el.value = lane.name; return; }
      if (await _slCall(`/api/stream-tags/lanes/${lane.id}`, { name: v }, 'renaming a lane', root)) await _slAfter(root);
    } else if (el.dataset.slTagName) {
      const t = tagOf(Number(el.dataset.slTagName));
      if (!t || v === t.name) { if (t) el.value = t.name; return; }
      if (!v) { el.value = t.name; return; }
      if (await _slCall(`/api/stream-tags/tags/${t.id}`, { name: v }, 'renaming a tag', root)) await _slAfter(root);
    }
  };
  root.addEventListener('focusout', (e) => {
    const el = e.target;
    if (el.matches && el.matches('[data-sl-lane-name], [data-sl-tag-name]')) saveName(el);
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches) return;
    if (el.matches('[data-sl-lane-name], [data-sl-tag-name]') && e.key === 'Enter') { e.preventDefault(); el.blur(); }
    // The key field takes the key you press (Backspace / Delete: none).
    if (el.matches('[data-sl-tag-key]')) {
      if (e.key === 'Tab' || e.key === 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      const t = tagOf(Number(el.dataset.slTagKey));
      if (!t) return;
      let key;
      if (e.key === 'Backspace' || e.key === 'Delete') key = null;
      else if ([...e.key].length === 1 && e.key !== ' ') key = e.key.toUpperCase();
      else return;
      if ((t.hotkey || null) === key) return;
      el.value = key || '';
      _slCall(`/api/stream-tags/tags/${t.id}`, { hotkey: key }, 'setting the key', root).then((ok) => { if (ok) _slAfter(root); });
    }
  });

  root.addEventListener('change', async (e) => {
    const el = e.target;
    if (!el.matches) return;
    if (el.matches('[data-sl-tag-color]')) {
      const t = tagOf(Number(el.dataset.slTagColor));
      if (t && el.value.toLowerCase() !== t.color) {
        if (await _slCall(`/api/stream-tags/tags/${t.id}`, { color: el.value }, 'changing the colour', root)) await _slAfter(root);
      }
    } else if (el.matches('[data-sl-tag-place]')) {
      const t = tagOf(Number(el.dataset.slTagPlace));
      if (t && await _slCall(`/api/stream-tags/tags/${t.id}`, { place: el.value }, 'changing the place', root)) await _slAfter(root);
    } else if (el.matches('[data-sl-lane-multi]')) {
      const lane = laneOf(Number(el.dataset.slLaneMulti));
      if (!lane) return;
      const multi = el.value === '1';
      if (!multi && lane.several && typeof vaultConfirm === 'function') {
        const ok = await vaultConfirm(`${_slFiles(lane.several)} ${lane.several === 1 ? 'has' : 'have'} more than one tag in ${lane.name}. With One per file, each keeps its first tag (in the order above) and loses the rest.`,
          { title: 'Switch to One per file?', okLabel: 'Switch', danger: true });
        if (!ok) { el.value = '1'; return; }
      }
      const r = await _slCall(`/api/stream-tags/lanes/${lane.id}`, { multi }, 'changing the lane', root);
      if (r) {
        // Trimmed tags left files: everything on screen reads the copy again.
        if (r.trimmed) await StreamTags.load(true);
        await _slAfter(root);
      }
    }
  });
}
