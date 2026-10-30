/* =========================================================================
   STAGE PREVIEW - while Stage is open, a click on a tile or table row
   previews the file instead of playing it.

   Without Stage a click plays the file (or, with the Modern preview pane
   open, shows it there). With Stage open that click would put the file on
   Stage, live in front of the viewers. So while Stage is open:

     - a single click shows the file in the preview pane (dock.js). The pane
       is on for as long as Stage is open, in Classic too, and goes
       back to the user's own setting when Stage closes: the setting itself
       is never changed. A window too narrow for the pane opens the file's
       details instead;
     - a double click (or Enter on the picked tile, or the pane's Play)
       plays it on Stage: only the file both clicks were on, never from a
       tile's own controls, never just after the layout moved. The pane
       comes on as Stage opens, so the grid does not move under a click;
     - the first time, a toast says so, and the pane carries a line about it.

   Nothing previewed makes a sound: the pane shows a still and the tiles'
   hover frames are pictures, so the streamer's desktop audio only ever
   carries Stage itself.

   Hooks other files call (guarded with typeof):
     stagePreviewClick(id)     cards.js tileThumbClick: true = handled here
     stagePreviewDblClick(id)  cards.js tileThumbDblClick: true = handled here
     stagePreviewForcing()     dock.js: the pane shows for Stage
     stagePreviewHintHtml()    dock.js: the line in the pane
     StagePreview.previewPlaying(id)  stage-bar.js / the Stage menu: Preview
   stage-bar.js fires 'vault:stage-bar' ({ on }) when the bar shows and hides.
   ========================================================================= */

const StagePreview = (() => {
  const HINT_KEY = 'vault_stagePreviewHint';
  let forcing = false;

  const stageOn = () => typeof StageBar !== 'undefined' && !!StageBar && !!StageBar.shown && StageBar.shown();

  function hintOnce() {
    let seen = false;
    try { seen = localStorage.getItem(HINT_KEY) === '1'; } catch {}
    if (seen) return;
    try { localStorage.setItem(HINT_KEY, '1'); } catch {}
    if (typeof showToast === 'function') showToast('Stage is on: click to preview, double-click to play on Stage');
  }

  // A double click plays only the file both of its clicks were on, with no
  // change of layout since the first: a grid that moved under the pointer
  // (the pane, the rail, a resize) must never put another file on Stage.
  const DBL_MS = 600;           // the two clicks of one double click
  const SETTLE_MS = 300;        // a layout change this recent: not a double click
  let clicks = [];              // the last two clicks: { id, at }
  let layoutAt = 0;             // when the grid last changed size or the pane came or went

  /** Inside a control of its own (the tick box, the heart, flag, trash, details, a link). */
  const onControl = (ev) => {
    const t = ev && ev.target;
    return !!(t && t.closest && t.closest('input, button, label, a, select, textarea, .tile-actions, .tile-select, .tv-actions, .tv-c-sel'));
  };

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  function noteLayout() { layoutAt = now(); }

  /** A single click while Stage is open: preview, never play. */
  function click(id) {
    if (!stageOn()) return false;
    clicks = [...clicks.slice(-1), { id, at: now() }];
    if (typeof hideTilePopover === 'function') hideTilePopover();
    if (!forcing) setForcing(true);   // normally already on since Stage opened
    if (typeof dockIsShown === 'function' && dockIsShown() && typeof dockSelect === 'function') dockSelect(id);
    else if (typeof showDetailsById === 'function') showDetailsById(id);   // too narrow for the pane
    hintOnce();
    return true;
  }

  /**
   * The Stage bar's Preview: the file on Stage, the way a click on its tile
   * shows it. With the pane showing and the file in the results, in the pane,
   * its tile brought on screen; else (a file the grid does not list, a
   * window too narrow for the pane) its details, by id.
   */
  async function previewPlaying(id) {
    if (!stageOn() || !id) return false;
    if (typeof hideTilePopover === 'function') hideTilePopover();
    if (!forcing) setForcing(true);
    const pane = typeof dockIsShown === 'function' && dockIsShown() && typeof dockSelect === 'function';
    let inResults = pane && typeof dockPickInResults === 'function' ? dockPickInResults(id) : false;
    // Only the first page's ids are here yet: the full list says.
    if (inResults == null) {
      const ids = await Library.waitIds().catch(() => null);
      inResults = !!(ids && ids.includes(id));
    }
    if (!pane || !inResults) {
      // A file the grid does not list may have no row here yet.
      if (!Library.row(id)) await Library.fetchRows([id]).catch(() => null);
      if (typeof showDetailsById === 'function') showDetailsById(id);
      return true;
    }
    dockSelect(id);
    const i = Library.indexOf(id);
    if (i >= 0 && typeof dockReveal === 'function') dockReveal(i);
    return true;
  }

  /** Would this double click on id play it? (Both clicks on id, close together, nothing moved.) */
  function sameFile(id) {
    const [a, b] = clicks;
    if (!a || !b || a.id !== id || b.id !== id) return false;
    const t = now();
    if (b.at - a.at > DBL_MS || t - a.at > DBL_MS + 200) return false;
    if (layoutAt >= a.at - SETTLE_MS) return false;
    return true;
  }

  /**
   * A double click while Stage is open: play it on Stage, but only the same
   * file both clicks were on, never from a control, never just after the
   * layout moved. Handled (true) either way, so nothing else plays it.
   */
  function dblClick(id, ev) {
    if (!stageOn()) return false;
    if (onControl(ev) || !sameFile(id)) return true;
    clicks = [];
    if (typeof playMediaById === 'function') playMediaById(id);
    return true;
  }

  function hintHtml() {
    if (!stageOn()) return '';
    return '<div class=dock-stage-hint data-dock-part=stagehint>Stage is on: click a file to preview it here, double-click it (or press Enter) to play it on Stage.</div>';
  }

  function setForcing(on) {
    if (forcing === on) return;
    forcing = on;
    noteLayout();
    if (typeof dockSync === 'function') dockSync();
  }

  // The pane comes with Stage, so the grid never moves under a click: on
  // when the Stage bar shows, back to the user's own setting when it goes.
  window.addEventListener('vault:stage-bar', (e) => {
    const on = !!(e.detail && e.detail.on);
    clicks = [];
    setForcing(on);
    // The pane's Stage line comes and goes with Stage, on the same file too.
    if (typeof dockIsShown === 'function' && dockIsShown() && typeof dockRepaintAll === 'function') dockRepaintAll();
  });

  // Anything else that moves the grid (the rail, the window, the pane's width).
  if (typeof ResizeObserver === 'function' && typeof document !== 'undefined') {
    const watch = () => {
      const grid = document.getElementById('resultsGrid');
      if (grid) new ResizeObserver(noteLayout).observe(grid);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch); else watch();
  }

  return { click, dblClick, previewPlaying, hintHtml, onControl, noteLayout, forcing: () => forcing && stageOn(), stageOn };
})();

function stagePreviewClick(id) { return StagePreview.click(id); }
function stagePreviewDblClick(id, ev) { return StagePreview.dblClick(id, ev); }
function stagePreviewForcing() { return StagePreview.forcing(); }
function stagePreviewHintHtml() { return StagePreview.hintHtml(); }
