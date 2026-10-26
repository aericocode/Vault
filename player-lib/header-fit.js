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
      text or the buttons change size (ResizeObserver), the open tab or a
      tab's content (the Editor queue badge) changes, or the look is switched.

   2. Modern look only (css/layout-modern.css does the rest):
      - "＋ Add" menu: its entries click the real Add files / Add folder
        buttons (importer.js), which Modern hides, and copy their busy state.
        Their emoji become line icons (player-lib/icons.js).
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

  // Every step is measured at the same width. A step that wraps makes the
  // header taller, which can give the page a scrollbar and narrow the row
  // for the next step (which then fails when it would fit). So the page's
  // scrollbar is held as it was while the steps are tried. If the pick then
  // adds or removes the scrollbar, the probe changes width and the fit runs
  // again at the new width; a one-line pick never grows the header, so this
  // settles.
  function fit() {
    const root = document.documentElement;
    const hadBar = window.innerWidth - root.clientWidth > 0;
    const before = root.style.overflowY;
    root.style.overflowY = hadBar ? 'scroll' : 'hidden';
    let pick = STEPS[0];
    try {
      for (const step of STEPS) {
        header.classList.remove(...ALL);
        header.classList.add(...step);
        if (!wraps()) { pick = step; break; }
      }
    } finally {
      root.style.overflowY = before;
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
      // The real button's words ("📁 Picker open…" while busy), with a line
      // icon in place of its emoji: this menu is Modern only.
      // data-menu-text: a fuller name than the button's own (Classic's short
      // "Playlist…" is "Import playlist…" here).
      const text = (real.dataset.menuText || real.textContent).trim();
      if (item.dataset.addText !== text) {
        item.dataset.addText = text;
        const words = typeof vaultStripLeadingEmoji === 'function' ? vaultStripLeadingEmoji(text) : text;
        const icon = typeof vaultIcon === 'function' ? vaultIcon(item.dataset.addIcon, 'vi-gap') : '';
        item.innerHTML = icon + words.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      }
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
    // "1,234 media files loaded (5 hidden)" -> "1,234 files"; a narrowed
    // result brings its own short form ("12 of 353 files", database.js).
    // Anything else ("18 people", "Loading…") is already short or must be read.
    const m = full.match(/^([\d.,\s  ]+?)\s+media files loaded/);
    const text = count.dataset.short || (m ? `${m[1].trim()} files` : full);
    if (short.textContent !== text) short.textContent = text;
    // The count is about the library: the Editor, Games and Wall tabs have
    // nothing it describes (Faces writes its own count of people).
    const tab = typeof currentTab === 'undefined' ? 'library' : currentTab;
    setIf(short, 'hidden', !['library', 'collections', 'faces'].includes(tab));
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
      // Fit on the next frame: fitting inside the callback can change sizes the
      // grid's own observer is still delivering ("ResizeObserver loop" error).
      let fitQueued = false;
      const ro = new ResizeObserver(() => {
        if (fitQueued) return;
        fitQueued = true;
        requestAnimationFrame(() => { fitQueued = false; fit(); });
      });
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
        characterData: true, attributes: true, attributeFilter: ['title', 'data-tip', 'data-short'] });
    }
    // The open tab moved (its name shows, the old one folds), or a tab's
    // content changed: the Editor tab's queue badge comes and goes by text
    // and inline style, either way the tabs need more or less room. fit()
    // itself only writes the header's classes and the tabs' data-tip, which
    // this does not watch, so it cannot feed back into itself.
    new MutationObserver(() => { syncCount(); fit(); })
      .observe(tabsNav, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden'] });

    window.addEventListener('vault:layout-style', () => { closeMenu(false); syncAll(); });
    // Emoji and fonts arriving late can change widths after the first pass.
    document.fonts?.ready?.then(fit);
    syncAll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
