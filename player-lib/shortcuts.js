/* =========================================================================
   SHORTCUTS - the keyboard shortcuts list: one table, two views

   SHORTCUTS below is the single list of every key the app answers to,
   written from the handlers themselves (player-controls.js, app.js, cards.js,
   dock.js, dock-edit.js, notes.js, metadata-edit.js, editor.js, wall.js,
   faces-review.js, settings.js, lovense-sync.js, up-next.js). Two views are built from it:
   - the window that ? (Shift + /) opens from anywhere, with the group for
     where the user is now first and marked "You are here";
   - Settings > Keyboard shortcuts (settings.js calls shortcutsSettingsHtml
     and shortcutsWireSettings).
   A key added to a handler belongs in this table too.

   Also here: isBrowserChord(e), the guard the single-key shortcuts use so
   Ctrl / Cmd chords (Ctrl+R reload, Ctrl+= page zoom) stay the browser's.
   Loaded early (right after utils.js), so its window keydown listener runs
   ahead of every other one while the window is open.
   ========================================================================= */

/** The groups, in the order they show when no group is "here". */
const SHORTCUT_GROUPS = [
  { id: 'player',   title: 'Player' },
  { id: 'pictures', title: 'Pictures in the player' },
  { id: 'mini',     title: 'Mini player' },
  { id: 'library',  title: 'Library' },
  { id: 'dock',     title: 'Library, Modern with the preview pane' },
  { id: 'wall',     title: 'Wall' },
  { id: 'editor',   title: 'Editor' },
  { id: 'faces',    title: 'Faces review' },
  { id: 'anywhere', title: 'Anywhere' },
  { id: 'typing',   title: 'While typing' },
];

/**
 * Every shortcut. keys: the alternatives, each one key ('R') or a combination
 * (['Ctrl', 'Shift', 'H']); 'click' in a combination is a mouse click.
 */
const SHORTCUTS = [
  // player-controls.js (the full player)
  { ctx: 'player', keys: ['Space'], desc: 'Play or pause' },
  { ctx: 'player', keys: ['Left', 'Right'], desc: 'Back or forward 5 seconds' },
  { ctx: 'player', keys: ['J', 'L'], desc: 'Back or forward 10 seconds' },
  { ctx: 'player', keys: ['0', '9'], desc: 'Jump to 0% through 90% of the file (5 is halfway)' },
  { ctx: 'player', keys: ['Up', 'Down'], desc: 'Volume up or down' },
  { ctx: 'player', keys: ['M'], desc: 'Mute or unmute' },
  { ctx: 'player', keys: ['F'], desc: 'Full screen on or off' },
  { ctx: 'player', keys: ['N', 'P'], desc: 'Next or previous file' },
  { ctx: 'player', keys: [['Alt', 'Left'], ['Alt', 'Right']], desc: 'Previous or next file, even while typing in a box' },
  { ctx: 'player', keys: ['R'], desc: 'Random file' },
  { ctx: 'player', keys: ['I'], desc: 'Show or hide the side panel (info and notes)' },
  { ctx: 'player', keys: ['Q'], desc: 'Shrink to the mini player (video and audio)' },
  // up-next.js
  { ctx: 'player', keys: ['U'], desc: 'Add the file playing to the end of Up next, so it plays again later' },
  { ctx: 'player', keys: [['Shift', 'U']], desc: 'Put the file playing at the front of Up next, so it plays again next' },
  { ctx: 'player', keys: ['<', ','], desc: 'Slower' },
  { ctx: 'player', keys: ['>', '.'], desc: 'Faster' },
  { ctx: 'player', keys: ['['], desc: 'Loop: set the start' },
  { ctx: 'player', keys: [']'], desc: 'Loop: set the end' },
  { ctx: 'player', keys: ['\\'], desc: 'Loop: turn it off' },
  { ctx: 'player', keys: ['+', '='], desc: 'Bigger text (documents)' },
  { ctx: 'player', keys: ['-', '_'], desc: 'Smaller text (documents)' },
  { ctx: 'player', keys: ['Esc'], desc: 'Close: full screen first, then the side panel, then the player' },
  { ctx: 'player', keys: ['Esc'], desc: 'In a side panel box: leave the box (an empty box also closes the panel)' },

  // player-controls.js, when the file is a picture or a GIF
  { ctx: 'pictures', keys: ['+', '=', 'Up'], desc: 'Zoom in' },
  { ctx: 'pictures', keys: ['-', '_', 'Down'], desc: 'Zoom out' },
  { ctx: 'pictures', keys: ['0'], desc: 'Reset zoom and turn' },
  { ctx: 'pictures', keys: ['R'], desc: 'Turn a quarter to the right' },

  // app.js (while the mini player shows)
  { ctx: 'mini', keys: ['Space'], desc: 'Play or pause' },
  { ctx: 'mini', keys: ['Q'], desc: 'Back to the full player' },
  { ctx: 'mini', keys: ['N', 'P'], desc: 'Next or previous file' },
  { ctx: 'mini', keys: ['R'], desc: 'Random file' },
  { ctx: 'mini', keys: ['U'], desc: 'Add to the end of Up next: the file you picked in the library, or else the file playing' },
  { ctx: 'mini', keys: [['Shift', 'U']], desc: 'Play next: the file you picked in the library, or else the file playing' },
  { ctx: 'mini', keys: ['Esc'], desc: 'Close the mini player' },
  // stream-tags.js (the keys are yours: these are the Role lane's to start with)
  { ctx: 'mini', keys: ['O', 'C', 'L', 'I', 'X'], desc: 'Stream tag keys, with the pointer over the Stage bar: put that tag on the file on Stage, or take it off' },

  // cards.js, selection.js
  { ctx: 'library', keys: ['PageDown', 'PageUp'], desc: 'Next or previous page (Pages layout)' },
  { ctx: 'library', keys: ['Home', 'End'], desc: 'First or last page (Pages layout)' },
  { ctx: 'library', keys: [['Shift', 'click']], desc: 'Select a range: tick one tile, then Shift+click the tick box of another' },
  // up-next.js (two or more ticked files win over the preview pane's file)
  { ctx: 'library', keys: ['U'], desc: 'Add the picked or ticked files to the end of Up next' },
  { ctx: 'library', keys: [['Shift', 'U']], desc: 'Play the picked or ticked files next (front of Up next)' },
  // stream-tags.js (set your own in Settings, Stage: Lanes and stream tags)
  { ctx: 'library', keys: ['O', 'C', 'L', 'I', 'X'], desc: 'Stream tag keys (the Role lane\'s to start with): put that tag on the file under the pointer, or take it off. On a ticked file: every ticked file' },
  // saved-searches.js (the panel under the search box, Modern)
  { ctx: 'library', keys: ['Up', 'Down'], desc: 'In the empty search box: open your saved searches and move between them' },
  { ctx: 'library', keys: ['Enter'], desc: 'Run the highlighted saved search (nothing highlighted: search for what you typed)' },
  { ctx: 'library', keys: ['Delete'], desc: 'Remove the highlighted saved search, while editing them' },

  // dock.js
  { ctx: 'dock', keys: ['Left', 'Right', 'Up', 'Down'], desc: 'Move between tiles (up and down go a row)' },
  { ctx: 'dock', keys: ['Enter'], desc: 'Play the selected tile' },

  // wall.js
  { ctx: 'wall', keys: ['Space'], desc: 'Pause or resume the wall' },
  { ctx: 'wall', keys: ['Esc'], desc: 'Close the wall settings' },

  // editor.js (while a mix is open)
  { ctx: 'editor', keys: ['Space'], desc: 'Play or pause the mix' },
  { ctx: 'editor', keys: ['Left', 'Right'], desc: 'Back or forward 5 seconds' },
  { ctx: 'editor', keys: [['Shift', 'Left'], ['Shift', 'Right']], desc: 'Back or forward 10 seconds' },
  { ctx: 'editor', keys: ['M'], desc: 'Show or hide the mixer' },
  { ctx: 'editor', keys: ['[', ']'], desc: 'Loop: set the start, then the end, then turn it off' },
  { ctx: 'editor', keys: ['\\'], desc: 'Loop: turn it off' },

  // faces-review.js (the review windows and the checks on a person's page)
  { ctx: 'faces', keys: ['Y'], desc: 'Yes for this face, or Same for this pair (or the first one with no answer)' },
  { ctx: 'faces', keys: ['N'], desc: 'No for this face, or Different for this pair (or the first one with no answer)' },
  { ctx: 'faces', keys: ['S'], desc: 'Skip this pair for now (Same person?)' },
  { ctx: 'faces', keys: ['Left', 'Right'], desc: 'Move between faces or pairs' },
  { ctx: 'faces', keys: ['Esc'], desc: 'Close the review window (Same person? asks first if answers are not saved)' },

  // this file, settings.js, every popover and window, lovense-sync.js
  { ctx: 'anywhere', keys: ['?'], desc: 'Show this list' },
  { ctx: 'anywhere', keys: [['Ctrl', 'Shift', 'H']], desc: 'Privacy mode on or off' },
  { ctx: 'anywhere', keys: ['Esc'], desc: 'Close the window, menu or popover on top' },
  { ctx: 'anywhere', keys: ['Esc'], desc: 'Stop Lovense sync while it runs' },

  // notes.js, dock-edit.js, metadata-edit.js, collections.js
  { ctx: 'typing', keys: ['Enter'], desc: 'Save (notes, names, tags and other fields)' },
  { ctx: 'typing', keys: [['Shift', 'Enter']], desc: 'New line in a note or the preview pane description' },
  { ctx: 'typing', keys: [['Ctrl', 'Enter']], desc: 'Save a description in the file details' },
  { ctx: 'typing', keys: ['Esc'], desc: 'Cancel the edit' },
  { ctx: 'typing', keys: [','], desc: 'Add the typed tag (preview pane)' },
  { ctx: 'typing', keys: ['Up', 'Down'], desc: 'Pick a suggestion (preview pane tags and collections)' },
  { ctx: 'typing', keys: ['Backspace'], desc: 'Remove the last tag, in an empty tag box (preview pane)' },
];

/* key -> [what the chip shows, its name for search and screen readers] */
const SHORTCUT_KEY_NAMES = {
  Left: ['←', 'Left arrow'],
  Right: ['→', 'Right arrow'],
  Up: ['↑', 'Up arrow'],
  Down: ['↓', 'Down arrow'],
  PageDown: ['PgDn', 'Page Down'],
  PageUp: ['PgUp', 'Page Up'],
  Esc: ['Esc', 'Escape'],
  '\\': ['\\', 'Backslash'],
};

function shortcutKeyLabel(k) { return SHORTCUT_KEY_NAMES[k] ? SHORTCUT_KEY_NAMES[k][0] : k; }
function shortcutKeyName(k) { return SHORTCUT_KEY_NAMES[k] ? SHORTCUT_KEY_NAMES[k][1] : k; }

/** Everything a search can match on one row: its words, its keys, its group. */
function shortcutRowText(row) {
  const g = SHORTCUT_GROUPS.find(x => x.id === row.ctx);
  const keys = row.keys.flat().map(k => `${k} ${shortcutKeyLabel(k)} ${shortcutKeyName(k)}`);
  return `${row.desc} ${keys.join(' ')} ${g ? g.title : ''}`.toLowerCase();
}

/** The rows that have every word of the query (any order, any case). */
function shortcutsFilter(rows, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows.slice();
  return rows.filter((r) => {
    const hay = shortcutRowText(r);
    return words.every(w => hay.includes(w));
  });
}

/** The groups to show, here first; groups the search leaves empty drop out. */
function shortcutsGroups(query, here) {
  const rows = shortcutsFilter(SHORTCUTS, query);
  const order = SHORTCUT_GROUPS.slice();
  const i = order.findIndex(g => g.id === here);
  if (i > 0) order.unshift(order.splice(i, 1)[0]);
  return order
    .map(g => ({ id: g.id, title: g.title, here: g.id === here, rows: rows.filter(r => r.ctx === g.id) }))
    .filter(g => g.rows.length);
}

/**
 * Which group is "here". env is what shortcutsReadEnv() sees on screen; the
 * order is the stacking order (a Faces review sits above the player). null:
 * nothing here has keys of its own (the Editor before a mix is open, Games).
 */
function shortcutsDetectContext(env) {
  if (env.facesReview) return 'faces';
  if (env.playerOpen) return env.mediaType === 'image' || env.mediaType === 'gif' ? 'pictures' : 'player';
  if (env.miniOpen) return 'mini';
  // The Editor's keys only work while a mix is open; with the grid hidden
  // (Editor, Games) the Library keys do nothing either.
  if (env.tab === 'editor') return env.editorMix ? 'editor' : null;
  if (env.tab === 'games') return null;
  if (env.tab === 'wall') return 'wall';
  if (env.tab === 'faces' && env.facesInline) return 'faces';
  if (env.dockShown) return 'dock';
  return 'library';
}

function shortcutsReadEnv() {
  const has = (sel) => !!document.querySelector(sel);
  return {
    facesReview: has('#frPanel, .fr-cmp-ov, .fr-pairs-panel'),
    playerOpen: has('#mediaPlayerOverlay.active'),
    mediaType: typeof currentMediaState !== 'undefined' && currentMediaState ? currentMediaState.type : null,
    miniOpen: has('#miniPlayer.active'),
    tab: typeof currentTab !== 'undefined' ? currentTab : 'library',
    editorMix: typeof editorMix !== 'undefined' && !!editorMix,
    facesInline: has('#ftMight:not([hidden]), #ftCheck:not([hidden])'),
    dockShown: !!(document.body && document.body.classList.contains('dock-shown')),
  };
}

/* ── Key guards ───────────────────────────────────────────────────────── */

/** AltGr types [ ] \ ? and more on many keyboards; Windows reports it as Ctrl+Alt. */
function isAltGr(e) {
  return !!((e.getModifierState && e.getModifierState('AltGraph')) || (e.ctrlKey && e.altKey));
}

/**
 * A letter or symbol pressed with Ctrl or Cmd: the browser's (Ctrl+R reload,
 * Ctrl+= zoom), so the single-key shortcuts leave it alone. Space, the arrows
 * and Esc are not letters or symbols and keep working. AltGr is not Ctrl.
 */
function isBrowserChord(e) {
  if (!e || !(e.ctrlKey || e.metaKey)) return false;
  if (typeof e.key !== 'string' || e.key.length !== 1 || e.key === ' ') return false;
  if (!e.metaKey && isAltGr(e)) return false;
  return true;
}

/** A box that takes typing: keys there are text, not shortcuts. */
function shortcutsIsTyping(el) {
  if (!el || el.nodeType !== 1) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(el.type || 'text');
  return tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

/** ? on its own (Shift is how most keyboards type it), not while typing. */
function shortcutsShouldOpen(e, active) {
  if (!e || e.key !== '?' || e.repeat || e.isComposing) return false;
  if (e.metaKey) return false;
  if ((e.ctrlKey || e.altKey) && !isAltGr(e)) return false;
  if (shortcutsIsTyping(e.target) || shortcutsIsTyping(active)) return false;
  // Another dialog has the keyboard (vault-dialogs.js): the list would open on top of it.
  if (typeof vaultModalOpen === 'function' && vaultModalOpen()) return false;
  return true;
}

/* ── Rendering ────────────────────────────────────────────────────────── */

function shortcutsEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortcutKeysHtml(keys) {
  return keys.map((alt) => {
    const parts = Array.isArray(alt) ? alt : [alt];
    const chips = parts.map(p => (p === 'click'
      ? '<span class="sk-click">click</span>'
      : `<kbd title="${shortcutsEsc(shortcutKeyName(p))}">${shortcutsEsc(shortcutKeyLabel(p))}</kbd>`));
    return `<span class="sk-combo">${chips.join('<span class="sk-plus">+</span>')}</span>`;
  }).join('');
}

function shortcutsGroupsHtml(groups, query) {
  if (!groups.length) return `<p class="sk-empty">No shortcut matches "${shortcutsEsc(query)}".</p>`;
  return groups.map(g => `
    <section class="sk-group${g.here ? ' sk-here' : ''}" aria-label="${shortcutsEsc(g.title)}">
      <h3 class="sk-gh">${shortcutsEsc(g.title)}${g.here ? ' <span class="sk-now">You are here</span>' : ''}</h3>
      <ul class="sk-rows">${g.rows.map(r => `
        <li class="sk-row" data-sfind="sk-${SHORTCUTS.indexOf(r)}"><span class="sk-desc">${shortcutsEsc(r.desc)}</span><span class="sk-keys">${shortcutKeysHtml(r.keys)}</span></li>`).join('')}
      </ul>
    </section>`).join('');
}

/* ── The window (?) ───────────────────────────────────────────────────── */

let _skWin = null;      // { ov, opener, onFocusIn }

/** The controls Tab moves between inside the window. */
function shortcutsFocusables(root) {
  return [...root.querySelectorAll('input, button, [href], [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && !el.hidden);
}

/**
 * Where Tab (back: Shift+Tab) goes: the next or previous control in the
 * window, wrapping round; from anywhere outside it, the first (back: last).
 */
function shortcutsTabTarget(list, current, back) {
  if (!list.length) return null;
  const i = list.indexOf(current);
  if (i < 0) return back ? list[list.length - 1] : list[0];
  return list[(i + (back ? -1 : 1) + list.length) % list.length];
}

function shortcutsIsOpen() { return !!(_skWin && _skWin.ov.isConnected); }

/** Full screen shows only its own element, so the window goes inside it. */
function shortcutsHost() {
  const fs = document.fullscreenElement;
  return fs && fs.tagName !== 'VIDEO' ? fs : document.body;
}

function shortcutsOpen() {
  if (shortcutsIsOpen()) return;
  const here = shortcutsDetectContext(shortcutsReadEnv());
  const ov = document.createElement('div');
  ov.className = 'sk-overlay';
  ov.id = 'shortcutsOverlay';
  ov.innerHTML = `
    <div class="sk-win" role="dialog" aria-modal="true" aria-labelledby="skTitle">
      <div class="sk-head">
        <h2 id="skTitle">Keyboard shortcuts</h2>
        <input type="search" class="sk-search" placeholder="Find a shortcut" aria-label="Find a shortcut" autocomplete="off" spellcheck="false">
        <span class="sk-hint">Esc to close</span>
        <button type="button" class="sk-x" data-sk-close aria-label="Close" title="Close">${typeof vaultIconSwap === 'function' ? vaultIconSwap('×', 'close') : '&times;'}</button>
      </div>
      <div class="sk-body sk-cols"></div>
      <div class="sk-foot">
        <span>Shortcuts don't fire while you type in a box.</span>
        <button type="button" class="sk-link" data-sk-settings>Also in Settings &gt; Keyboard shortcuts</button>
      </div>
    </div>`;
  const body = ov.querySelector('.sk-body');
  const search = ov.querySelector('.sk-search');
  const paint = () => { body.innerHTML = shortcutsGroupsHtml(shortcutsGroups(search.value, here), search.value.trim()); };
  paint();
  search.addEventListener('input', () => { paint(); body.scrollTop = 0; });
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) shortcutsClose(); });
  ov.querySelector('[data-sk-close]').addEventListener('click', () => shortcutsClose());
  ov.querySelector('[data-sk-settings]').addEventListener('click', () => {
    shortcutsClose({ keepFocus: true });
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (typeof window.vaultOpenSettings === 'function') window.vaultOpenSettings('shortcuts');
  });
  // Focus stays inside while it is open: anything that lands behind it
  // (a click on the page, a script focusing a field) comes back to the search.
  const onFocusIn = (e) => {
    if (shortcutsIsOpen() && e.target instanceof Node && !ov.contains(e.target)) search.focus();
  };
  _skWin = { ov, opener: document.activeElement, onFocusIn };
  shortcutsHost().appendChild(ov);
  document.addEventListener('focusin', onFocusIn, true);
  search.focus();
}

function shortcutsClose(opts = {}) {
  if (!_skWin) return;
  const { ov, opener, onFocusIn } = _skWin;
  _skWin = null;
  document.removeEventListener('focusin', onFocusIn, true);
  ov.remove();
  if (!opts.keepFocus && opener && opener.isConnected && typeof opener.focus === 'function') {
    try { opener.focus({ preventScroll: true }); } catch {}
  }
}

/**
 * Capture on window, registered before every other script's listener: while
 * the window is open it owns the keyboard (nothing behind it hears a key),
 * and ? never reaches another handler.
 */
function shortcutsOnKey(e) {
  if (shortcutsIsOpen()) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      shortcutsClose();
      return;
    }
    // ? closes it again; in the search box only while the box is empty, so
    // a ? can still be searched for.
    const inSearch = e.target && e.target.classList && e.target.classList.contains('sk-search');
    if (e.key === '?' && !e.metaKey && (!(e.ctrlKey || e.altKey) || isAltGr(e)) && !(inSearch && e.target.value)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      shortcutsClose();
      return;
    }
    e.stopImmediatePropagation();
    const ov = _skWin.ov;
    const active = document.activeElement;
    // Tab and Shift+Tab go round the window's own controls, never behind it.
    if (e.key === 'Tab') {
      e.preventDefault();
      const next = shortcutsTabTarget(shortcutsFocusables(ov), active, e.shiftKey);
      if (next) next.focus();
      return;
    }
    // A key with focus somehow outside the window must not type into or
    // press what is behind it: bring focus back to the search instead.
    if ((!active || !ov.contains(active)) && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const search = ov.querySelector('.sk-search');
      if (search) search.focus();
    }
    return;
  }
  if (!shortcutsShouldOpen(e, document.activeElement)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  shortcutsOpen();
}

/* ── Settings > Keyboard shortcuts ────────────────────────────────────── */

function shortcutsSettingsHtml() {
  const body = `
    <div class="sk-settings-top">
      <input type="search" class="sk-search" id="skSettingsSearch" placeholder="Find a shortcut" aria-label="Find a shortcut" autocomplete="off" spellcheck="false">
      <span class="sk-tip">Press <kbd>?</kbd> anywhere to see this list.</span>
    </div>
    <div class="sk-body sk-cols2" id="skSettingsList">${shortcutsGroupsHtml(shortcutsGroups('', shortcutsSettingsHere()), '')}</div>
    <p class="settings-note sk-settings-foot">Shortcuts don't fire while you type in a box.</p>`;
  // Modern: one card (player-lib/settings-kit.js); Classic: its heading.
  if (typeof settingsIsModern === 'function' && settingsIsModern()) {
    return settingsCardHtml({ title: 'Keyboard shortcuts', sfind: 'shortcutsList', body });
  }
  return `
    <h3 class="settings-h" data-sfind="shortcutsList">Keyboard shortcuts</h3>${body}`;
}

/** Where the user was when Settings opened (what is behind it), marked
 *  "You are here" like the ? window does. */
function shortcutsSettingsHere() {
  try { return shortcutsDetectContext(shortcutsReadEnv()); } catch { return null; }
}

function shortcutsWireSettings() {
  const input = document.getElementById('skSettingsSearch');
  const list = document.getElementById('skSettingsList');
  if (!input || !list) return;
  const here = shortcutsSettingsHere();
  input.addEventListener('input', () => {
    list.innerHTML = shortcutsGroupsHtml(shortcutsGroups(input.value, here), input.value.trim());
  });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.addEventListener) {
  window.addEventListener('keydown', shortcutsOnKey, true);
  // Going in or out of full screen: keep the window where it can be seen.
  document.addEventListener('fullscreenchange', () => {
    if (shortcutsIsOpen() && _skWin.ov.parentNode !== shortcutsHost()) shortcutsHost().appendChild(_skWin.ov);
  });
}
