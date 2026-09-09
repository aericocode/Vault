/**
 * Runnable check for the More sheet's click plumbing.
 *
 * This one runs in the page, not in node: what it guards is event delivery and
 * DOM identity, and neither survives being faked outside a browser. Open the
 * viewer, then paste this file into the console (or run it through whatever
 * drives the page) and read the summary it returns.
 *
 *   node -e "..."                     // no: nothing to run against
 *   copy(await fetch('/tools/check-more-sheet.js').then(r => r.text()))
 *   …paste in the viewer's console…
 *
 * What it guards, from Fix round 6c:
 *
 *   1. Fifty rapid clicks alternating between two segments inside the sheet
 *      leave the sheet open and both filters set. Round 6b decided "inside or
 *      outside" with closest() on the clicked node; a re-render triggered by
 *      the click itself could pull that node out of the page first, and the
 *      answer for a click plainly inside the sheet came back "outside".
 *   2. A chip keeps its identity across a re-render. Setting a filter used to
 *      rebuild the chip row and swap the sheet's chips for fresh copies, which
 *      detached the button an open popover was anchored to.
 *   3. The popover survives a re-render of the chip it hangs off, and still
 *      closes on an outside click and on picking a value.
 *   4. Every way of closing the sheet still closes it: the backdrop, Escape,
 *      a tile in the grid, and the More chip itself.
 */

(function checkMoreSheet() {
  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond, detail: cond ? '' : detail });
    console.log(`  ${cond ? 'ok   ' : 'FAIL '} ${name}${cond || !detail ? '' : `  (${detail})`}`);
  };

  const sheet = () => document.getElementById('moreFiltersSheet');
  const isOpen = () => sheet()?.classList.contains('active') === true;
  const moreChip = () => document.getElementById('moreFiltersChip');

  const press = (el) => {
    if (!el) return;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }));
    if (el.focus) el.focus();
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, composed: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
  };

  const seg = (key, value) =>
    sheet()?.querySelector(`[data-fseg="${key}"][data-fseg-value="${value}"]`);

  const reset = () => {
    ['fave', 'scan', 'notes', 'flagged'].forEach(k => fchipSet(k, ''));
    if (!isOpen()) press(moreChip());
  };

  // ── 1. fifty rapid clicks, alternating between two segments ──────────────
  reset();
  check('the sheet opens', isOpen(), 'the More chip did not open it');

  let closedAt = -1;
  let missing = -1;
  for (let i = 0; i < 50; i++) {
    const [key, value] = i % 2 ? ['scan', 'failed'] : ['fave', '1'];
    const target = seg(key, value);
    if (!target) { missing = i; break; }
    press(target);
    if (!isOpen()) { closedAt = i; break; }
  }
  check('fifty rapid segment clicks leave the sheet open', closedAt === -1,
    `closed on click ${closedAt}`);
  check('every segment stayed in the page across those clicks', missing === -1,
    `segment gone at click ${missing}`);
  check('both filters ended up set', fchipValue('fave') === '1' && fchipValue('scan') === 'failed',
    `fave=${fchipValue('fave')} scan=${fchipValue('scan')}`);

  // ── 2. a chip keeps its identity when its value changes ──────────────────
  reset();
  const chipBefore = sheet().querySelector('[data-fchip="content"]');
  fchipSet('fave', '1');            // any filter change re-renders the row
  const chipAfter = sheet().querySelector('[data-fchip="content"]');
  check('a sheet chip is repainted, not replaced', chipBefore === chipAfter,
    'the chip button was swapped for a new node');
  check('the sheet stayed open through the re-render', isOpen());

  // ── 3. the popover survives a re-render, and still closes ────────────────
  reset();
  press(sheet().querySelector('[data-fchip="content"]'));
  const anchor = filterPopoverAnchor();
  check('a chip inside the sheet opens a popover', filterPopoverIsOpen());
  fchipSet('fave', '1');
  check('the popover anchor is still in the page after a re-render',
    !!filterPopoverAnchor()?.isConnected);
  window.dispatchEvent(new Event('scroll'));
  check('a scroll does not close the popover behind the user', filterPopoverIsOpen());
  check('the popover kept the same anchor', filterPopoverAnchor() === anchor);
  press(document.body);
  check('an outside click closes the popover', !filterPopoverIsOpen());
  check('the sheet is still open behind it', isOpen());

  // ── 4. every way of closing the sheet still closes it ────────────────────
  reset();
  press(document.getElementById('filtersBackdrop'));
  check('the backdrop closes the sheet', !isOpen());

  reset();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the sheet', !isOpen());

  reset();
  press(document.getElementById('resultsGrid'));
  check('a click on the library closes the sheet', !isOpen());

  reset();
  press(moreChip());
  check('the More chip closes the sheet', !isOpen());

  reset();

  const failures = results.filter(r => !r.ok);
  console.log(`\n  ${results.length - failures.length}/${results.length} checks passed`);
  return { passed: results.length - failures.length, total: results.length, failures };
})();
