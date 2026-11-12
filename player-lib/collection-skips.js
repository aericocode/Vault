/* =========================================================================
   SKIP ON TRACKS - skip files in a collection without taking them out.

   A skipped file keeps its place in the playlist order and stays in the
   grid, dimmed and marked "Skipped", but nothing that moves on by itself
   lands on it: Next, Previous, a file ending, Repeat all, Shuffle, Random,
   Play all, Play on Stage (mpv and Basic) and the Up next footer's "then the
   list carries on" all pass over it (player-core.js nextPlayableIndex,
   stage-control.js computeUpcoming). Clicking it still plays it: Skip only
   changes what plays on its own. Up next plays what was put in it.

   Saved with the collection (collection_items.skipped, lib/database.js), per
   collection: a file can be skipped in one collection and not another. A
   folder has none of its own and plays every file.

   A saved order (flow.js "Saved orders") keeps its own skips. While one
   shows, flow.js hands it here (Skips.useVariant): its skips are the ones
   read and written, the playlist's are left alone. One with none of its own
   yet (saved before skips) shows the playlist's until the first change,
   which gives it its own copy.

   Where: a Skip button on each tile and table row of an open collection,
   Skip / Unskip in the selection bar, and "Unskip all" next to the
   collection's count line (with Undo). The count line says how long the
   collection plays and how much the skips take off ("40 files · 1:42:05,
   18:20 skipped · playlist order"); the maths is player-lib/playlist-time.js.

   Hooks other files call (guarded with typeof):
     skipTileClass(id), skipTileTag(id), skipTileButton(id)   cards.js, table-view.js
     skipCountParts(c)                collections.js collectionCountText
     skipHeaderHtml(c)                collections.js renderCollectionHeader
     skipSelectionButton(ids)         selection.js renderSelectionBar
     Skips.setFor(cid) / Skips.has    player-core.js, stage-control.js, flow.js
   Tells others: window event 'vault:skips-changed' { cid }.
   ========================================================================= */

const Skips = (() => {
  const EMPTY = new Set();
  const byColl = new Map();     // collection id -> Set of skipped ids (replaced, never changed in place)
  // The saved order showing, with its own skips: { cid, sid, name, own, set, length, save(ids) }, or null.
  let variant = null;
  const variantFor = (cid) => (variant && variant.cid === cid ? variant : null);

  /** The skipped files of a collection (a Set; the same object until they change). */
  function setFor(cid) {
    if (cid == null) return EMPTY;
    const v = variantFor(cid);
    if (v && v.own) return v.set;
    return byColl.get(cid) || EMPTY;
  }
  const has = (cid, id) => setFor(cid).has(Number(id));
  const count = (cid) => setFor(cid).size;

  /** The server's list for a collection (GET /api/collections/:id and every skip answer). */
  function take(cid, ids) {
    if (cid == null || !Array.isArray(ids)) return;
    const prev = byColl.get(cid);
    const next = new Set(ids.map(Number));
    if (prev && prev.size === next.size && [...next].every(id => prev.has(id))) return;
    byColl.set(cid, next);
    return true;
  }

  const sameSet = (a, b) => a.size === b.size && [...a].every(id => b.has(id));

  /**
   * The saved order showing (flow.js syncSkips): { cid, sid, name, skips
   * (ids, or null: none of its own), length (its length fields, or null),
   * save(ids) -> Promise<row> }, or null for the playlist's own skips.
   */
  function useVariant(v) {
    const before = variant;
    const beforeSet = before ? setFor(before.cid) : null;
    variant = v && v.cid != null ? {
      cid: v.cid, sid: v.sid, name: v.name || '', own: Array.isArray(v.skips),
      set: new Set((v.skips || []).map(Number)), length: v.length || null, save: v.save,
    } : null;
    // Tell only when what plays changed (flow.js calls this on every repaint of what shows).
    const cids = new Set([before && before.cid, variant && variant.cid].filter(c => c != null));
    for (const cid of cids) {
      const was = before && before.cid === cid ? beforeSet : (byColl.get(cid) || EMPTY);
      const lenWas = before && before.cid === cid ? before.length : null;
      const lenNow = variant && variant.cid === cid ? variant.length : null;
      if (!sameSet(was, setFor(cid)) || (lenWas && lenWas.skipped_seconds) !== (lenNow && lenNow.skipped_seconds)
        || (before && before.cid === cid ? before.sid : null) !== (variant && variant.cid === cid ? variant.sid : null)) changed(cid);
    }
  }

  /** The length fields the count line reads: the saved order's own while it has its own skips, else the collection's. */
  function lengthFor(c) {
    const v = c ? variantFor(c.id) : null;
    return v && v.own && v.length ? v.length : c;
  }

  /** The name of the saved order whose skips these are, or null for the playlist's. */
  const variantName = (cid) => { const v = variantFor(cid); return v ? v.name : null; };

  function changed(cid) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('vault:skips-changed', { detail: { cid } }));
    }
  }

  async function send(method, cid, body) {
    const resp = await fetch(`/api/collections/${cid}/skips`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!resp.ok) {
      if (typeof collResponseError === 'function') throw await collResponseError(resp);
      throw new Error(`Server returned ${resp.status}`);
    }
    return resp.json();
  }

  /** An answer from the server: the list and the collection's length fields. */
  function install(cid, data) {
    take(cid, data.skipped_ids || []);
    const c = typeof getCollectionById === 'function' ? getCollectionById(cid) : null;
    if (c && typeof takeCollectionLength === 'function') takeCollectionLength(c, data);
    changed(cid);
  }

  const toastErr = (err, what) => {
    if (err && err.status === 423) return;          // the lock screen takes over
    if (typeof collErrorToast === 'function') collErrorToast(err, what);
    else if (typeof showToast === 'function') showToast(`Could not finish ${what}.`, { type: 'error' });
  };

  /** A saved order's skips, all of them (its save answers with the row; flow.js hands it back here). */
  async function saveVariant(v, ids) {
    await v.save(ids);
  }

  /** Skip (on true) or un-skip these files. @returns {Promise<boolean>} done */
  async function set(cid, ids, on) {
    const list = (ids || []).map(Number).filter(Boolean);
    if (cid == null || !list.length) return false;
    const v = variantFor(cid);
    if (v && typeof v.save === 'function') {
      const next = new Set(setFor(cid));
      for (const id of list) { if (on) next.add(id); else next.delete(id); }
      try { await saveVariant(v, [...next]); return true; } catch (err) { toastErr(err, on ? 'skipping that' : 'unskipping that'); return false; }
    }
    try {
      install(cid, await send('POST', cid, { ids: list, skip: !!on }));
      return true;
    } catch (err) { toastErr(err, on ? 'skipping that' : 'unskipping that'); return false; }
  }

  /** Unskip every file in the collection, with Undo (the skips come back). */
  async function unskipAll(cid) {
    const was = [...setFor(cid)];
    if (cid == null || !was.length) return false;
    const v = variantFor(cid);
    if (v && typeof v.save === 'function') {
      try { await saveVariant(v, []); } catch (err) { toastErr(err, 'unskipping the files'); return false; }
      const msg = `Unskipped ${was.length === 1 ? '1 file' : `${was.length.toLocaleString()} files`} in “${v.name}”`;
      const undo = async () => {
        try { await saveVariant(v, was); if (typeof showToast === 'function') showToast('Skips put back'); } catch (err) { toastErr(err, 'putting the skips back'); }
      };
      if (typeof showUndoToast === 'function') showUndoToast(typeof escapeHtml === 'function' ? escapeHtml(msg) : msg, undo);
      else if (typeof showToast === 'function') showToast(msg);
      return true;
    }
    let data;
    try { data = await send('PUT', cid, { ids: [] }); } catch (err) { toastErr(err, 'unskipping the files'); return false; }
    install(cid, data);
    const back = Array.isArray(data.was_ids) && data.was_ids.length ? data.was_ids : was;
    const msg = `Unskipped ${back.length === 1 ? '1 file' : `${back.length.toLocaleString()} files`}`;
    const undo = async () => {
      try {
        // The skips from before, kept to the files there are now (the server leaves out non-members).
        install(cid, await send('POST', cid, { ids: back, skip: true }));
        if (typeof showToast === 'function') showToast('Skips put back');
      } catch (err) { toastErr(err, 'putting the skips back'); }
    };
    if (typeof showUndoToast === 'function') showUndoToast(msg, undo);
    else if (typeof showToast === 'function') showToast(msg);
    return true;
  }

  return { setFor, has, count, take, set, unskipAll, changed, useVariant, lengthFor, variantName, _byColl: byColl };
})();

if (typeof window !== 'undefined') window.Skips = Skips;

/* ── Where skips show ──────────────────────────────────────────────────── */

/** The open collection (not a folder), whose files can be skipped, or null. */
function skipOpenCollection() {
  if (typeof activeCollectionId === 'undefined' || activeCollectionId == null) return null;
  const c = typeof getCollectionById === 'function' ? getCollectionById(activeCollectionId) : null;
  if (!c || c.kind === 'folder') return null;
  // The grid still shows another answer (mid switch): nothing yet.
  const spec = typeof Library !== 'undefined' ? Library.spec : null;
  if (spec && spec.collectionId != null && spec.collectionId !== c.id) return null;
  return c;
}

function skipIsOn(id) {
  const c = skipOpenCollection();
  return !!c && Skips.has(c.id, id);
}

/** ' tile-skipped' on a skipped file's tile or row in the open collection. */
function skipTileClass(id) {
  return skipIsOn(id) ? ' tile-skipped' : '';
}

/** The "Skipped" mark on a skipped tile's picture. */
function skipTileTag(id) {
  return skipIsOn(id) ? '<span class="tile-skip-tag" title="Skipped: playback passes over this file. It keeps its place.">Skipped</span>' : '';
}

/** The tile's (and table row's) Skip button, in an open collection only. */
function skipTileButton(id) {
  const c = skipOpenCollection();
  if (!c) return '';
  const on = Skips.has(c.id, id);
  const label = on ? 'Unskip: play this file again' : 'Skip: keep it here but do not play it';
  const glyph = typeof vaultIconSwap === 'function' ? vaultIconSwap('⏭', 'next-file') : '⏭';
  return `<button type="button" class="tile-btn tile-skip-btn${on ? ' active-skip' : ''}" onclick="toggleSkipFile(${Number(id)})" title="${label}" aria-label="${label}" aria-pressed="${on}">${glyph}</button>`;
}

/** The tile button: skip or unskip one file in the open collection. */
function toggleSkipFile(id) {
  const c = skipOpenCollection();
  if (!c) return Promise.resolve(false);
  return Skips.set(c.id, [id], !Skips.has(c.id, id));
}

/**
 * The count line's skip part: { time, note } where time replaces the
 * collection's whole length with what plays, and note is what the skips
 * take off ("18:20 skipped", or "3 skipped" with no lengths known). Null
 * when nothing is skipped (or for a folder).
 */
function skipCountParts(c) {
  if (!c || c.kind === 'folder') return null;
  const L = Skips.lengthFor(c);
  const n = Number(L.skipped_count) || Skips.count(c.id);
  if (!(n > 0)) return null;
  // A saved order's own skips: the tooltip says whose.
  const vName = Skips.variantName(c.id);
  const whose = vName ? ` in “${vName}”` : '';
  const files = `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
  const clock = typeof StageCount !== 'undefined' ? StageCount.clock : (s) => `${Math.round(s)} s`;
  const all = typeof StageCount !== 'undefined' ? StageCount.collectionTime(c) : null;
  const sSec = Number(L.skipped_seconds) || 0;
  if (!all || !(sSec > 0)) return { seconds: null, note: `${files} skipped`, title: `${files} skipped${whose}: playback passes over ${n === 1 ? 'it' : 'them'}.` };
  const about = all.about || (Number(L.skipped_unknown_count) || 0) > 0;
  const plays = Math.max(0, all.seconds - sSec);
  return {
    seconds: plays,
    about,
    note: `${about ? 'about ' : ''}${clock(sSec)} skipped`,
    title: `${files} skipped${whose}. It plays for ${about ? 'about ' : ''}${clock(plays)}; with ${n === 1 ? 'it' : 'them'} it would be ${clock(all.seconds)}.`,
  };
}

/** Unskip all, next to the count line, while the open collection has skips. */
function skipHeaderHtml(c) {
  if (!c || c.kind === 'folder' || !Skips.count(c.id)) return '';
  return `<button type="button" class="coll-note-btn coll-unskip" onclick="Skips.unskipAll(${Number(c.id)})" title="Play every file in this collection again (you can Undo)">Unskip all</button>`;
}

/** The selection bar's Skip / Unskip for the ticked files the open collection holds. */
function skipSelectionButton(ids) {
  const c = skipOpenCollection();
  if (!c || !ids || !ids.length) return '';
  const allOn = ids.every(id => Skips.has(c.id, id));
  const n = ids.length;
  const files = `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
  const label = typeof selBtnLabel === 'function' ? selBtnLabel(allOn ? 'Unskip' : 'Skip', n) : (allOn ? 'Unskip' : 'Skip');
  const text = typeof vaultEmojiLabel === 'function' ? vaultEmojiLabel(`⏭ ${label}`) : `⏭ ${label}`;
  return `<button class="sel-btn sel-skip${allOn ? ' sel-skipped' : ''}" onclick="skipSelected(${allOn ? 'false' : 'true'})"
    title="${allOn ? `Play ${files} again` : `Keep ${files} in place but do not play ${n === 1 ? 'it' : 'them'}`}">${text}</button>`;
}

async function skipSelected(on) {
  const c = skipOpenCollection();
  if (!c || typeof selectedInOpenCollection !== 'function') return false;
  const ids = selectedInOpenCollection();
  if (!ids.length) return false;
  const ok = await Skips.set(c.id, ids, on);
  if (ok && typeof showToast === 'function') {
    showToast(`${on ? 'Skipped' : 'Unskipped'} ${ids.length === 1 ? '1 file' : `${ids.length.toLocaleString()} files`}`);
  }
  return ok;
}

/* A change to the open collection's skips: its tiles, count line and
   selection bar follow (Stage and the queue listen for themselves). */
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('vault:skips-changed', (e) => {
    const cid = e.detail && e.detail.cid;
    if (typeof activeCollectionId === 'undefined' || cid !== activeCollectionId) return;
    if (typeof renderCollectionCount === 'function') renderCollectionCount();
    if (typeof renderResults === 'function') renderResults();
    if (typeof renderSelectionBar === 'function') renderSelectionBar();
  });
}
