/* =========================================================================
   NOW PLAYING - the tile of the file playing now, and the way back to it.

   While the mini player or Stage is up, the tile of the file playing has a
   green ring and a "Now playing" label (css/tiles.css .tile-now-playing;
   the CSS shows them only while something plays, so nothing has to be told
   when playback stops). The class follows the file as it changes
   (noteFileOpened, player-core.js, which every way of playing goes through,
   Stage too) and every grid render puts it back (cards.js renderTile,
   table-view.js).

   A click on the file's name in the mini player or on the Stage bar brings
   its tile on screen, from any tab: the list on screen if it holds the
   file, else the list it plays from (Stage's, or the collection it was
   opened in), else the Library. Then the page holding it (paged) or however
   far down (continuous, where it may not exist yet), and a short glow (a
   steady ring instead when the system asks for reduced motion). Not found
   anywhere: a toast that names a search or filter only when one is set.
   ========================================================================= */

const NowPlaying = (() => {
  const GLOW_MS = 1600;
  const FIND_MS = 2500;        // how long to wait for the tile (or a list) to be drawn
  const SCROLL_MS = 600;       // a smooth scroll is over by then
  let id = null;
  let from = null;             // where it was opened: { cid } (see placeNow)

  const reduced = () => (typeof prefersReducedMotion === 'function' ? prefersReducedMotion() : false);
  const tiles = (sel) => document.querySelectorAll(`#resultsGrid .media-tile${sel}`);

  /** The class a tile render adds (cards.js, table-view.js). */
  function tileClass(tileId) {
    return id != null && tileId === id ? ' tile-now-playing' : '';
  }

  /** A new file is playing: move the border to its tile. */
  function set(newId) {
    const next = Number(newId) > 0 ? Number(newId) : null;
    // Where it was opened, every time (the same file opened again from a collection plays from there now).
    from = next != null ? placeNow() : null;
    if (next === id) return;
    id = next;
    if (typeof document === 'undefined') return;
    tiles('.tile-now-playing').forEach(t => { if (Number(t.dataset.id) !== id) t.classList.remove('tile-now-playing'); });
    if (id != null) tiles(`[data-id="${id}"]`).forEach(t => t.classList.add('tile-now-playing'));
  }

  /** The tile for `want` once it is drawn (a page or rows may still be on their way), or null. */
  function waitForTile(want) {
    const started = Date.now();
    return new Promise((resolve) => {
      const look = () => {
        const el = document.querySelector(`#resultsGrid .media-tile[data-id="${want}"]:not(.tile-skel)`);
        if (el) { resolve(el); return; }
        if (Date.now() - started > FIND_MS) { resolve(null); return; }
        requestAnimationFrame(look);
      };
      look();
    });
  }

  function glow(el) {
    el.classList.remove('tile-np-glow');
    void el.offsetWidth;                       // start the animation again on a second click
    el.classList.add('tile-np-glow');
    setTimeout(() => el.classList.remove('tile-np-glow'), GLOW_MS);
  }

  const tabNow = () => (typeof currentTab !== 'undefined' ? currentTab : 'library');
  const openCid = () => (typeof activeCollectionId !== 'undefined' ? activeCollectionId : null);

  /** The grid on screen is a list of files: the Library tab, or an open collection. */
  const onList = () => tabNow() === 'library' || (tabNow() === 'collections' && openCid() != null);

  /** Where the file was opened: { cid } (a collection), or { cid: null } (anywhere else: the library). */
  function placeNow() {
    return { cid: tabNow() === 'collections' && openCid() != null ? openCid() : null };
  }

  /** The playing file's place in the list on screen, or -1 (once the full list is in). */
  async function indexHere(want) {
    let i = Library.indexOf(want);
    // Only the first page's ids may be here yet: the full list says.
    if (i < 0 && !Library.known()) {
      await Library.waitIds().catch(() => null);
      i = Library.indexOf(want);
    }
    return i;
  }

  /**
   * Go to a collection (cid), or the Library tab (null), the way Back to
   * Stage does, and wait for that list's result (the old one stays in
   * Library until the new one is in).
   */
  async function goTo(cid) {
    if (cid != null && typeof getCollectionById === 'function' && !getCollectionById(cid)) return false;
    const before = Library.spec;
    if (cid != null) {
      if (tabNow() !== 'collections') switchTab('collections');
      if (openCid() !== cid) await openCollection(cid);
    } else {
      switchTab('library');
    }
    const started = Date.now();
    await new Promise((resolve) => {
      const look = () => {
        const s = Library.spec;
        const fresh = s && s !== before && (s.collectionId == null ? null : s.collectionId) === cid;
        if (fresh || Date.now() - started > FIND_MS) { resolve(); return; }
        requestAnimationFrame(look);
      };
      look();
    });
    return true;
  }

  /** Where the file plays from: Stage's list while Stage is open, else where it was opened. */
  function source() {
    const SC = typeof StageControl !== 'undefined' ? StageControl : null;
    const s = SC && SC.isOpen() && typeof SC.playingFrom === 'function' ? SC.playingFrom() : null;
    return s || from || { cid: null };
  }

  /** Search text or a filter narrows the list on screen. */
  function narrowed() {
    const box = document.getElementById('searchInput');
    return !!(box && box.value.trim()) || (typeof anyFilterIsSet === 'function' && anyFilterIsSet());
  }

  /**
   * Bring the playing file's tile on screen and make it glow. If the list on
   * screen holds it (the Library tab, or an open collection), right there.
   * Otherwise, from any tab: the list it plays from (Stage's, or the
   * collection it was opened in), and if that does not hold it, the Library.
   */
  async function reveal() {
    const want = id;
    if (want == null) return;
    let i = onList() ? await indexHere(want) : -1;
    if (i < 0) {
      const src = source();
      const places = src.cid != null ? [src.cid, null] : [null];
      for (const cid of places) {
        const here = cid == null ? tabNow() === 'library' : tabNow() === 'collections' && openCid() === cid;
        if (!here && !(await goTo(cid))) continue;
        if (want !== id) return;
        i = await indexHere(want);
        if (i >= 0) break;
      }
    }
    if (want !== id) return;
    if (i < 0) {
      if (typeof showToast === 'function') {
        showToast(narrowed()
          ? 'The file playing is not in the list on screen. A search or filter is hiding it.'
          : 'The file playing is not in the library list, so it has no tile to show.');
      }
      return;
    }
    if (typeof revealMediaIndex === 'function') revealMediaIndex(i);
    const el = await waitForTile(want);
    if (!el || want !== id) return;
    el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    glow(el);
    setTimeout(() => clearOfMini(el), reduced() ? 0 : SCROLL_MS);
  }

  /**
   * The tile ended under the mini player (the last rows cannot scroll any
   * higher): room below the grid while the mini player is up (css/tiles.css
   * --np-reserve), and the tile moved up out from under it.
   */
  function clearOfMini(el) {
    const mini = document.getElementById('miniPlayer');
    if (!mini || !mini.classList.contains('active') || !el.isConnected) return;
    const m = mini.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const under = m.width > 0 && m.top > window.innerHeight / 3
      && t.right > m.left && t.left < m.right && t.bottom > m.top && t.top < m.bottom;
    if (!under) return;
    document.getElementById('resultsGrid')?.style.setProperty('--np-reserve', `${Math.ceil(m.height) + 16}px`);
    window.scrollBy({ top: t.bottom - m.top + 12, behavior: 'auto' });
  }

  function wire() {
    document.getElementById('miniPlayerTitle')?.addEventListener('click', (e) => {
      e.stopPropagation();                     // not the mini player's show / hide controls
      reveal();
    });
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  return { set, tileClass, reveal, id: () => id };
})();

function nowPlayingTileClass(tileId) { return NowPlaying.tileClass(tileId); }
