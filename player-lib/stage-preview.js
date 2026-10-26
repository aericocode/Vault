/* =========================================================================
   STAGE PREVIEW - while Stage is open, a click on a tile or table row
   previews the file instead of playing it.

   Without Stage a click plays the file (or, with the Modern preview pane
   open, shows it there). With Stage open that click would put the file on
   Stage, live in front of the viewers. So while Stage is open:

     - a single click shows the file in the preview pane (dock.js). The pane
       is turned on for as long as Stage is open, in Classic too, and goes
       back to the user's own setting when Stage closes: the setting itself
       is never changed. A window too narrow for the pane opens the file's
       details instead;
     - a double click (or Enter on the picked tile, or the pane's Play)
       plays it on Stage;
     - the first time, a toast says so, and the pane carries a line about it.

   Nothing previewed makes a sound: the pane shows a still and the tiles'
   hover frames are pictures, so the streamer's desktop audio only ever
   carries Stage itself.

   Hooks other files call (guarded with typeof):
     stagePreviewClick(id)     cards.js tileThumbClick: true = handled here
     stagePreviewDblClick(id)  cards.js tileThumbDblClick: true = handled here
     stagePreviewForcing()     dock.js: the pane shows for Stage
     stagePreviewHintHtml()    dock.js: the line in the pane
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

  /** A single click while Stage is open: preview, never play. */
  function click(id) {
    if (!stageOn()) return false;
    if (typeof hideTilePopover === 'function') hideTilePopover();
    if (!forcing) {
      forcing = true;
      if (typeof dockSync === 'function') dockSync();
    }
    if (typeof dockIsShown === 'function' && dockIsShown() && typeof dockSelect === 'function') dockSelect(id);
    else if (typeof showDetailsById === 'function') showDetailsById(id);   // too narrow for the pane
    hintOnce();
    return true;
  }

  /** A double click while Stage is open: play it on Stage. */
  function dblClick(id) {
    if (!stageOn()) return false;
    if (typeof playMediaById === 'function') playMediaById(id);
    return true;
  }

  function hintHtml() {
    if (!stageOn()) return '';
    return '<div class="dock-stage-hint" data-dock-part="stagehint">Stage is on: click a file to preview it here, double-click it (or press Enter) to play it on Stage.</div>';
  }

  window.addEventListener('vault:stage-bar', (e) => {
    const on = !!(e.detail && e.detail.on);
    if (!on && forcing) {
      // Stage closed: the pane goes back to the user's own setting.
      forcing = false;
      if (typeof dockSync === 'function') dockSync();
    }
    if (typeof dockIsShown === 'function' && dockIsShown() && typeof dockRefresh === 'function') dockRefresh();
  });

  return { click, dblClick, hintHtml, forcing: () => forcing && stageOn(), stageOn };
})();

function stagePreviewClick(id) { return StagePreview.click(id); }
function stagePreviewDblClick(id) { return StagePreview.dblClick(id); }
function stagePreviewForcing() { return StagePreview.forcing(); }
function stagePreviewHintHtml() { return StagePreview.hintHtml(); }
