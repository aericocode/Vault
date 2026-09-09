/* =========================================================================
   TOOLTIP - one styled tooltip for every `title` in the app

   The app carries a few hundred `title` attributes. They are the right thing
   to write at the call site (they are also the accessible name of last resort)
   and the wrong thing to render: the native tooltip cannot be styled, cannot
   be positioned, waits about a second, and on a dark UI arrives as a white
   system box.

   So this file leaves the call sites alone and takes over the rendering. One
   delegated handler watches hover and focus. The first time an element with a
   `title` is pointed at, the text moves to `data-tip` and the attribute is
   removed - which is the only way to suppress the native tooltip - and one
   shared element is positioned under the target. Anything that already has a
   `data-tip` works without a title at all.

   Nothing here changes what a screen reader gets: `aria-label` is never
   touched, and the target points at the tooltip with `aria-describedby` while
   it is on screen.
   ========================================================================= */

(() => {
  const SHOW_DELAY_MS = 350;
  const GAP = 8;          // distance from the target
  const EDGE = 8;         // keep this far from the viewport edges
  const TIP_ID = 'vaultTooltip';

  let tip = null;
  let target = null;        // the element the tooltip belongs to
  let showTimer = null;
  let aliveTimer = null;
  let prevDescribedBy = null;

  function ensureTip() {
    if (tip && tip.isConnected) return tip;
    tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.className = 'vtip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
  }

  /** The nearest ancestor (or self) that carries tooltip text. */
  function tipTargetOf(node) {
    if (!(node instanceof Element)) return null;
    const el = node.closest('[data-tip], [title]');
    if (!el) return null;
    // Lift a native title exactly once. After this the element is data-tip
    // only, so the browser has nothing left to draw.
    const raw = el.getAttribute('title');
    if (raw !== null) {
      el.removeAttribute('title');
      const text = raw.trim();
      if (text) el.setAttribute('data-tip', text);
    }
    return el.getAttribute('data-tip') ? el : null;
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();

    let top = r.bottom + GAP;
    let above = false;
    if (top + t.height > window.innerHeight - EDGE && r.top - GAP - t.height > EDGE) {
      top = r.top - GAP - t.height;
      above = true;
    }

    let left = r.left + r.width / 2 - t.width / 2;
    left = Math.max(EDGE, Math.min(left, window.innerWidth - t.width - EDGE));

    tip.classList.toggle('vtip-above', above);
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;

    // The arrow follows the target, not the box, so a tooltip pushed sideways
    // by the viewport edge still points at the thing it describes.
    const arrow = Math.round(r.left + r.width / 2 - left);
    tip.style.setProperty('--vtip-arrow', `${Math.max(10, Math.min(arrow, t.width - 10))}px`);
  }

  function show(el) {
    const text = el.getAttribute('data-tip');
    if (!text || !el.isConnected) return;
    ensureTip();
    tip.textContent = text;
    tip.hidden = false;
    tip.classList.add('is-on');
    place(el);

    prevDescribedBy = el.getAttribute('aria-describedby');
    el.setAttribute('aria-describedby', TIP_ID);
    target = el;

    // A tooltip whose element got re-rendered underneath it would otherwise
    // hang there pointing at nothing: grids and control bars repaint often.
    clearInterval(aliveTimer);
    aliveTimer = setInterval(() => {
      if (!target || !target.isConnected) hide();
    }, 500);
  }

  function hide() {
    clearTimeout(showTimer);
    clearInterval(aliveTimer);
    showTimer = null;
    if (target) {
      if (prevDescribedBy === null) target.removeAttribute('aria-describedby');
      else target.setAttribute('aria-describedby', prevDescribedBy);
    }
    prevDescribedBy = null;
    target = null;
    if (tip) {
      tip.classList.remove('is-on');
      tip.hidden = true;
    }
  }

  function schedule(el) {
    if (el === target) return;
    hide();
    showTimer = setTimeout(() => show(el), SHOW_DELAY_MS);
  }

  document.addEventListener('mouseover', e => {
    const el = tipTargetOf(e.target);
    if (el) schedule(el);
    else if (target || showTimer) hide();
  }, true);

  document.addEventListener('mouseout', e => {
    if (!target && !showTimer) return;
    // Moving deeper inside the same element is not leaving it.
    const to = e.relatedTarget;
    if (to instanceof Node && target && target.contains(to)) return;
    hide();
  }, true);

  document.addEventListener('focusin', e => {
    const el = tipTargetOf(e.target);
    if (el) schedule(el);
  }, true);

  document.addEventListener('focusout', () => hide(), true);

  /* Scrolling moves the target out from under the tooltip, so the tooltip
     follows it, and gives up only once the target has left the viewport.
     Hiding on any scroll at all was the first version and it was wrong:
     focusing a control scrolls it into view, so tabbing to a button cancelled
     the tooltip that focus had just asked for. */
  document.addEventListener('scroll', () => {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const gone = r.bottom < 0 || r.top > window.innerHeight
      || r.right < 0 || r.left > window.innerWidth;
    if (gone) hide();
    else place(target);
  }, true);
  window.addEventListener('resize', () => hide());
  window.addEventListener('blur', () => hide());
  document.addEventListener('mousedown', () => hide(), true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (target || showTimer)) hide();
  }, true);
})();
