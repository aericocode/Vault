/* =========================================================================
   HEADER FIT - keeps the header on one line, plus the Modern header's pieces.

   1. Tab fit (both looks). The header is a wrapping flex row, so "does it fit"
      is measured, not guessed from a breakpoint: the row fits when it is no
      taller than its tallest item. Steps, first one that fits wins:
        full tabs -> tighter tabs (.tabs-tight) -> icon-only tabs except the
        open one (.tabs-collapsed, name in the styled tooltip).
      If even icon-only tabs cannot keep it on one line (narrow windows) the
      tabs go back to full size: the header wraps either way, so the names
      may as well stay. Re-measured whenever the header's width, the count
      text or the buttons change size (ResizeObserver), the open tab changes
      or the look is switched.

   2. Modern look only (css/layout-modern.css does the rest):
      - "＋ Add" menu: its entries click the real Add files / Add folder
        buttons (importer.js), which Modern hides, and copy their busy state.
      - Status pill: the streak chip (gamify-ui.js) and the device chip
        (lovense-ui.js) are drawn as one pill. Each keeps its own click and
        live updates; data-status on .header-buttons says which are showing.
      - Short count: "34 files" in muted text, with the full count and the
        database name in its tooltip, kept in step with #totalCount.
   ========================================================================= */

(function () {
  const header = document.getElementById('appHeader');
  const row = header && header.querySelector('.header-content');
  const tabsNav = document.getElementById('appTabs');
  if (!header || !row || !tabsNav) return;

  // Only write what changed: the observers below watch these same nodes.
  const setIf = (el, prop, value) => { if (el[prop] !== value) el[prop] = value; };
  const setAttrIf = (el, name, value) => {
    if (value == null) { if (el.hasAttribute(name)) el.removeAttribute(name); }
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };

  /* ── 1. Tab fit ─────────────────────────────────────────────────────── */

  const STEPS = [[], ['tabs-tight'], ['tabs-tight', 'tabs-collapsed']];
  const ALL = ['tabs-tight', 'tabs-collapsed'];

  function wraps() {
    let tallest = 0;
    for (const el of row.children) {
      if (el.classList.contains('hdr-fit-probe')) continue;
      if (el.offsetWidth) tallest = Math.max(tallest, el.offsetHeight);
    }
    return row.clientHeight > tallest + 1;
  }

  function fit() {
    let pick = STEPS[0];
    for (const step of STEPS) {
      header.classList.remove(...ALL);
      header.classList.add(...step);
      if (!wraps()) { pick = step; break; }
    }
    header.classList.remove(...ALL);
    header.classList.add(...pick);
    syncTabTips();
  }

  // Names of folded tabs: the styled tooltip (player-lib/tooltip.js) reads
  // data-tip; aria-label carries the name for screen readers either way.
  function syncTabTips() {
    const folded = header.classList.contains('tabs-collapsed');
    for (const tab of tabsNav.querySelectorAll('.app-tab')) {
      const tip = folded && !tab.classList.contains('active') ? tab.getAttribute('aria-label') : null;
      setAttrIf(tab, 'data-tip', tip);
    }
  }

  // A zero-height probe the full width of the row: its size follows the
  // window, never the wrapping, so watching it cannot feed back into itself.
  const probe = document.createElement('div');
  probe.className = 'hdr-fit-probe';
  probe.setAttribute('aria-hidden', 'true');
  row.prepend(probe);

  /* ── 2. Modern pieces ───────────────────────────────────────────────── */

  // Add menu
  const addWrap = document.getElementById('hdrAdd');
  const addBtn = document.getElementById('hdrAddBtn');
  const addMenu = document.getElementById('hdrAddMenu');
  const items = addMenu ? [...addMenu.querySelectorAll('.hdr-add-item')] : [];
  const realFor = (item) => document.getElementById(item.dataset.addFor);
  const usableItems = () => items.filter(i => !i.hidden && !i.disabled);

  function syncAddItems() {
    let any = false, busy = false;
    for (const item of items) {
      const real = realFor(item);
      setIf(item, 'hidden', !real);
      if (!real) continue;
      any = true;
      const text = real.textContent.trim();
      if (item.textContent !== text) item.textContent = text;
      setIf(item, 'disabled', real.disabled);
      busy = busy || real.disabled;
    }
    if (addWrap) setIf(addWrap, 'hidden', !any);
    if (addBtn && addBtn.classList.contains('is-busy') !== busy) addBtn.classList.toggle('is-busy', busy);
  }

  const menuOpen = () => !!addMenu && !addMenu.hidden;
  function openMenu(focusIndex) {
    if (!addMenu) return;
    syncAddItems();
    addMenu.hidden = false;
    addBtn.setAttribute('aria-expanded', 'true');
    const usable = usableItems();
    if (focusIndex != null && usable.length) usable[(focusIndex + usable.length) % usable.length].focus();
    document.addEventListener('pointerdown', onOutside, true);
  }
  function closeMenu(refocus) {
    if (!menuOpen()) return;
    addMenu.hidden = true;
    addBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) addBtn.focus();
  }
  function onOutside(e) {
    if (addWrap && !addWrap.contains(e.target)) closeMenu(false);
  }

  if (addBtn && addMenu) {
    addBtn.addEventListener('click', () => (menuOpen() ? closeMenu(false) : openMenu(0)));
    addBtn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(0); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); openMenu(-1); }
      else if (e.key === 'Escape' && menuOpen()) { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    });
    addMenu.addEventListener('keydown', (e) => {
      const usable = usableItems();
      const at = usable.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); usable[(at + 1) % usable.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); usable[(at - 1 + usable.length) % usable.length]?.focus(); }
      else if (e.key === 'Home') { e.preventDefault(); usable[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); usable[usable.length - 1]?.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === 'Tab') closeMenu(false);
    });
    for (const item of items) {
      item.addEventListener('click', () => {
        const real = realFor(item);
        closeMenu(true);
        if (real && !real.disabled) real.click();
      });
    }
  }

  // Status pill: which of the two chips are on screen.
  function chipShown(id) {
    const el = document.getElementById(id);
    return !!el && !el.hidden && el.style.display !== 'none';
  }
  function syncStatus(btns) {
    const g = chipShown('gamifyChip'), l = chipShown('lovenseChip');
    setAttrIf(btns, 'data-status', g && l ? 'both' : g ? 'gamify' : l ? 'lovense' : 'none');
  }

  // Short count
  const count = document.getElementById('totalCount');
  const short = document.getElementById('headerCountShort');
  function syncCount() {
    if (!count || !short) return;
    const full = count.textContent.trim();
    // "1,234 media files loaded (5 hidden)" -> "1,234 files". Anything else
    // ("18 people", "Loading…", a warning) is already short or must be read.
    const m = full.match(/^([\d.,\s  ]+?)\s+media files loaded/);
    const text = m ? `${m[1].trim()} files` : full;
    if (short.textContent !== text) short.textContent = text;
    const lines = [full];
    const hiddenTypes = count.getAttribute('data-tip') || count.getAttribute('title');
    if (hiddenTypes) lines.push(hiddenTypes);
    const db = document.getElementById('dbFileName');
    if (db) {
      lines.push(`Database: ${db.textContent.replace(/^\s*📁\s*/u, '').trim()}`);
      const where = db.getAttribute('data-tip') || db.getAttribute('title');
      if (where) lines.push(where);
    }
    setAttrIf(short, 'data-tip', lines.join('\n'));
  }

  /* ── Wiring ─────────────────────────────────────────────────────────── */

  function syncAll() {
    const btns = header.querySelector('.header-buttons');
    if (btns) syncStatus(btns);
    syncAddItems();
    syncCount();
    fit();
  }

  function boot() {
    const btns = header.querySelector('.header-buttons');
    const info = header.querySelector('.db-info');

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => fit());
      ro.observe(probe);
      if (btns) ro.observe(btns);
      if (info) ro.observe(info);
    } else {
      window.addEventListener('resize', fit);
    }

    // Chips arrive late (gamify waits for the first results) and show or hide
    // by inline style; the Add buttons change text and disabled while a
    // picker is open.
    if (btns) {
      new MutationObserver(() => { syncStatus(btns); syncAddItems(); })
        .observe(btns, { childList: true, subtree: true, characterData: true,
          attributes: true, attributeFilter: ['style', 'hidden', 'disabled'] });
    }
    // The count is rewritten by several modules; #dbFileName is added next to
    // it once the server answers.
    if (info) new MutationObserver(syncCount).observe(info, { childList: true });
    if (count) {
      new MutationObserver(syncCount).observe(count, { childList: true, subtree: true,
        characterData: true, attributes: true, attributeFilter: ['title', 'data-tip'] });
    }
    // The open tab moved: its name shows, the old one folds.
    new MutationObserver(fit)
      .observe(tabsNav, { subtree: true, attributes: true, attributeFilter: ['class'] });

    window.addEventListener('vault:layout-style', () => { closeMenu(false); syncAll(); });
    // Emoji and fonts arriving late can change widths after the first pass.
    document.fonts?.ready?.then(fit);
    syncAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
