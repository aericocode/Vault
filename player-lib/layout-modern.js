/* =========================================================================
   LAYOUT MODERN - the toolbar pieces only the Modern library look has.

   The look itself is a body class (settings.js applyLayoutStyle) and CSS
   (css/layout-modern.css). This file wires the card-size slider: it writes
   the same min tile width cards.js lays the grid out with, so pages mode still
   fills whole rows at any width. The slider re-lays the grid live while it is
   dragged (one pass per frame) and saves when it is let go.
   ========================================================================= */

(function () {
  const range = document.getElementById('cardSizeRange');
  if (!range) return;

  const r = window.vaultCardWidthRange;
  if (r) { range.min = r.min; range.max = r.max; range.step = r.step; }

  function syncSlider() {
    if (typeof window.vaultCardMinWidth === 'function') range.value = String(window.vaultCardMinWidth());
  }

  let queued = false;
  function relayout() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      window.vaultRelayoutLibrary?.();
    });
  }

  // Dragging: save the value as we go (cheap, local) so cards.js reads it on
  // the next pass, and re-lay at most once per frame.
  range.addEventListener('input', () => {
    window.vaultSetCardMinWidth?.(range.value);
    relayout();
  });
  range.addEventListener('change', () => {
    const v = window.vaultSetCardMinWidth?.(range.value);
    if (v) range.value = String(v);
    relayout();
  });

  syncSlider();
  // Switching the look re-lays the grid (the min width source changes) and
  // puts the slider on the stored value.
  window.addEventListener('vault:layout-style', () => {
    syncSlider();
    window.vaultRelayoutLibrary?.();
  });
})();
