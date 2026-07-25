/* =========================================================================
   TABS - Library | Collections | Editor | Games top-level views.

   Library and Collections share the existing search/grid machinery
   (#mainContainer); the tab only changes what the grid shows:
     - library:     media tiles, no collection cards
     - collections: collection cards (or an open collection's members)
   Editor is its own container (#editorContainer) rendered by editor.js.
   Games is its own container (#gamesContainer) rendered by games.js.
   ========================================================================= */

let currentTab = 'library';

function switchTab(tab) {
  if (tab === currentTab) {
    if (tab === 'editor' && typeof renderEditor === 'function') renderEditor();
    if (tab === 'games' && typeof renderGames === 'function') renderGames();
    return;
  }
  const prev = currentTab;
  currentTab = tab;

  document.querySelectorAll('.app-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));

  const main = document.getElementById('mainContainer');
  const editor = document.getElementById('editorContainer');
  const games = document.getElementById('gamesContainer');

  // Leaving a feature view pauses it (keeps its state/DOM), like a stopped tape
  if (prev === 'editor' && typeof editorPauseIfActive === 'function') editorPauseIfActive();
  if (prev === 'games' && typeof gamesPauseIfActive === 'function') gamesPauseIfActive();

  // Show exactly one container
  if (main) main.style.display = (tab === 'editor' || tab === 'games') ? 'none' : '';
  if (editor) editor.style.display = tab === 'editor' ? '' : 'none';
  if (games) games.style.display = tab === 'games' ? '' : 'none';

  if (tab === 'editor') {
    if (typeof renderEditor === 'function') renderEditor();
  } else if (tab === 'games') {
    if (typeof renderGames === 'function') renderGames();
  } else {
    // library / collections — switching between them closes any open collection
    if (typeof closeCardMenu === 'function') closeCardMenu();
    if (typeof activeCollectionId !== 'undefined' && activeCollectionId != null) {
      if (typeof closeCollection === 'function') closeCollection(); // re-applies filters
    } else if (typeof applyFilters === 'function') {
      applyFilters();
    }
    // Show/hide the Collections-tab breadcrumb + New actions for the new tab
    if (typeof renderCollectionsTabBar === 'function') renderCollectionsTabBar();
  }
  if (typeof renderSelectionBar === 'function') renderSelectionBar();
  try { localStorage.setItem('viewer_tab', tab); } catch {}
}

/** Restore last tab on boot (library stays the default landing view). */
document.addEventListener('DOMContentLoaded', () => {
  let saved = null;
  try { saved = localStorage.getItem('viewer_tab'); } catch {}
  if (saved === 'collections') switchTab('collections');
  // Editor is not restored — it needs a mix/queue context to be useful
});
