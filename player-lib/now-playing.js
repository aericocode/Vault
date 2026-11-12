/* =========================================================================
   NOW PLAYING - the tile of the file playing now, and the way back to it.

   While the mini player or Stage is up, the tile of the file playing has a
   clear accent border (css/tiles.css .tile-now-playing; the CSS shows it
   only while something plays, so nothing has to be told when playback
   stops). The class follows the file as it changes (noteFileOpened,
   player-core.js, which every way of playing goes through, Stage too) and
   every grid render puts it back (cards.js renderTile, table-view.js).

   A click on the file's name in the mini player or on the Stage bar brings
   its tile on screen, on whichever page it is (paged) or however far down
   (continuous, where it may not exist yet), and gives it a short glow
   (a steady ring instead when the system asks for reduced motion). A file
   the grid does not list: with Stage on, Back to Stage goes to the list it
   plays from; otherwise a toast says why it cannot be shown.
   ========================================================================= */

const NowPlaying = (() => {
  const GLOW_MS = 1600;
  const FIND_MS = 2500;        // how long to wait for the tile to be drawn
  let id = null;

  const reduced = () => (typeof prefersReducedMotion === 'function' ? prefersReducedMotion() : false);
  const tiles = (sel) => document.querySelectorAll(`#resultsGrid .media-tile${sel}`);

  /** The class a tile render adds (cards.js, table-view.js). */
  function tileClass(tileId) {
    return id != null && tileId === id ? ' tile-now-playing' : '';
  }

  /** A new file is playing: move the border to its tile. */
  function set(newId) {
    const next = Number(newId) > 0 ? Number(newId) : null;
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

  /** Bring the playing file's tile on screen and make it glow. */
  async function reveal() {
    const want = id;
    if (want == null) return;
    let i = Library.indexOf(want);
    // Only the first page's ids may be here yet: the full list says.
    if (i < 0 && !Library.known()) {
      await Library.waitIds().catch(() => null);
      i = Library.indexOf(want);
    }
    if (i < 0) {
      // Stage plays from a list the user browsed away from: go back to it
      // (it brings the file on screen itself).
      const SC = typeof StageControl !== 'undefined' ? StageControl : null;
      if (SC && SC.isOpen()) {
        await SC.backToStage();
        if (Library.indexOf(want) >= 0) return;
      }
      if (typeof showToast === 'function') {
        showToast('The file playing is not in the list on screen. A search or filter may be hiding it.');
      }
      return;
    }
    if (typeof revealMediaIndex === 'function') revealMediaIndex(i);
    const el = await waitForTile(want);
    if (!el || want !== id) return;
    el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    glow(el);
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
