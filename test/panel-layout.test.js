/**
 * The Modern tabbed Info panel, beside the player and as the library detail
 * view (player-lib/player/panel-layout.js,
 * drawn by player-lib/detail-view.js renderDetailPanel): which tabs each file
 * type gets, the tab it opens on, the quick actions and how many fit, times
 * in notes (hundredths too), the panel-only icon swap (icons.js), and that
 * the page wires it up for Modern only.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'player-lib');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function load() {
  const ctx = { Math, Number, Object, Array, String };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib', 'player', 'panel-layout.js')}\nglobalThis.__p = PanelLayout;`, ctx);
  return ctx.__p;
}
const P = load();
const tabs = (type, o) => [...P.tabsFor(type, o)].join(' ');

/* ── Tabs ──────────────────────────────────────────────────────────────── */

test('tabs: video gets Subtitles, and Music only once fingerprinted', () => {
  assert.strictEqual(tabs('video'), 'details notes subtitles file');
  assert.strictEqual(tabs('video', { fingerprinted: true }), 'details notes subtitles music file');
  assert.strictEqual(tabs('video', { faces: true, fingerprinted: true }), 'details notes subtitles music people file');
});

test('tabs: Up next only beside the player (upNext), before File, for every type', () => {
  assert.strictEqual(tabs('video', { upNext: true }), 'details notes subtitles upnext file');
  assert.strictEqual(tabs('image', { faces: true, upNext: true }), 'details notes people upnext file');
  assert.strictEqual(tabs('document', { upNext: true }), 'details notes upnext file');
  assert.strictEqual(tabs('mix'), 'details notes file', 'the library details have no Up next tab');
});

test('tabs: audio always has Music, never People', () => {
  assert.strictEqual(tabs('audio'), 'details notes subtitles music file');
  assert.strictEqual(tabs('audio', { faces: true }), 'details notes subtitles music file');
});

test('tabs: pictures get Details, Notes, People, File; documents and mixes Details, Notes, File', () => {
  for (const t of ['image', 'gif']) {
    assert.strictEqual(tabs(t), 'details notes file', t);
    assert.strictEqual(tabs(t, { faces: true, fingerprinted: true }), 'details notes people file', t);
  }
  for (const t of ['document', 'mix', '', undefined, 'weird']) {
    assert.strictEqual(tabs(t, { faces: true, fingerprinted: true }), 'details notes file', String(t));
  }
});

test('tabs: always in the panel order', () => {
  assert.deepStrictEqual([...P.TAB_ORDER], ['details', 'notes', 'subtitles', 'music', 'people', 'upnext', 'file']);
  const all = P.tabsFor('video', { faces: true, fingerprinted: true, upNext: true });
  assert.deepStrictEqual([...all], [...P.TAB_ORDER]);
});

test('opening tab: the remembered one when this file has it, else the first', () => {
  assert.strictEqual(P.pickTab(['details', 'notes', 'file'], 'notes'), 'notes');
  assert.strictEqual(P.pickTab(['details', 'notes', 'file'], 'music'), 'details');
  assert.strictEqual(P.pickTab(['details', 'notes', 'file'], undefined), 'details');
  assert.strictEqual(P.pickTab([], 'notes'), 'details');
  assert.strictEqual(P.pickTab(null, 'notes'), 'details');
});

/* ── Quick actions ─────────────────────────────────────────────────────── */

test('quick actions: a file on disk', () => {
  const a = P.actionsFor({ media_type: 'video' });
  assert.deepStrictEqual([...a.row], ['flag', 'trash', 'copy', 'refresh', 'collections']);
  assert.deepStrictEqual([...a.more], ['remove']);
});

test('quick actions: trashed files restore, failed or unscanned files offer the AI scan', () => {
  assert.deepStrictEqual([...P.actionsFor({ media_type: 'image', user_trashed: 1 }).row],
    ['flag', 'restore', 'copy', 'refresh', 'collections']);
  assert.ok(P.actionsFor({ media_type: 'video', processing_error: 'timeout' }).row.includes('rescan'));
  const unscanned = P.actionsFor({ media_type: 'video', processing_error: 'unscanned' }).row;
  assert.ok(unscanned.includes('scan') && !unscanned.includes('rescan'));
  assert.ok(!P.actionsFor({ media_type: 'video', processing_error: null }).row.some(k => k === 'scan' || k === 'rescan'));
});

test('quick actions: a mix has no file on disk, so no trash or refresh, but Open in Editor', () => {
  const a = P.actionsFor({ media_type: 'mix', user_trashed: 1 });
  assert.deepStrictEqual([...a.row], ['flag', 'copy', 'collections', 'editor']);
  assert.deepStrictEqual([...a.more], ['remove'], 'remove stays reachable for mixes');
  assert.deepStrictEqual([...P.actionsFor(null).row], ['flag', 'trash', 'copy', 'refresh', 'collections']);
});

test('quick actions: how many fit, the rest go to More', () => {
  const sizes = { btn: 36, gap: 4, fixed: 88 };
  // 396 px of row (a 420 px panel less padding): every one of 5 fits.
  assert.strictEqual(P.fitActions(396, 5, sizes), 5);
  // 226 px: (226 - 88 + 4) / 40 = 3
  assert.strictEqual(P.fitActions(226, 5, sizes), 3);
  assert.strictEqual(P.fitActions(100, 5, sizes), 0);
  assert.strictEqual(P.fitActions(50, 5, sizes), 0, 'never negative');
  // Not laid out yet (0 or junk width): show them all rather than none.
  assert.strictEqual(P.fitActions(0, 6, sizes), 6);
  assert.strictEqual(P.fitActions(NaN, 6, sizes), 6);
  assert.strictEqual(P.fitActions(1000, 0, sizes), 0);
});

/* ── Times in notes (notes.js): [h:]m:ss with optional hundredths ────── */

function loadNotes() {
  const noop = () => {};
  const ctx = {
    Math, Number, String, Array, Object, RegExp, JSON, console,
    document: { addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib', 'notes.js')}\nglobalThis.__n = { _parseTs, linkifyTimestamps, insertCurrentTimestamp };`, ctx);
  return { ...ctx.__n, ctx };
}
const N = loadNotes();
/** The [onclick target, text] of each link linkifyTimestamps makes. */
const links = (text) => [...N.linkifyTimestamps(text, 'p').matchAll(/onclick="(\w+)\('p', ([^)]*)\)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)]
  .map(m => `${m[1]}(${m[2]})`);

test('note times: whole seconds, hours, and up to hundredths', () => {
  assert.strictEqual(N._parseTs('1:56'), 116);
  assert.strictEqual(N._parseTs('1:56.4'), 116.4);
  assert.strictEqual(N._parseTs('0:41.25'), 41.25);
  assert.strictEqual(N._parseTs('1:02:03'), 3723);
  assert.strictEqual(N._parseTs('1:02:03.5'), 3723.5);
  assert.strictEqual(N._parseTs(' 0:05 '), 5);
  for (const bad of ['', 'abc', '1:5', '1:56.', '1:56.123', '123:45', '1:2:3', ':30', '1:56,4']) {
    assert.strictEqual(N._parseTs(bad), null, bad);
  }
});

test('note links: a time seeks, a range loops, both keep their hundredths', () => {
  assert.deepStrictEqual(links('see 1:56.4 here'), ["seekToNoteTimestamp('1:56.4')"]);
  assert.deepStrictEqual(links('loop 0:41.25-1:03.5 best'), ["loopNoteRange('0:41.25', '1:03.5')"]);
  assert.deepStrictEqual(links('loop 0:41 - 1:03'), ["loopNoteRange('0:41', '1:03')"]);
  assert.deepStrictEqual(links('at 1:02:03.25 it ends'), ["seekToNoteTimestamp('1:02:03.25')"]);
  // A full stop after a time is the sentence's, not a decimal.
  assert.deepStrictEqual(links('it ends at 1:56.'), ["seekToNoteTimestamp('1:56')"]);
  assert.deepStrictEqual(links('plain words'), []);
});

test('clock button: whole seconds, with a space after so typing stands apart', () => {
  const input = { value: '', selectionStart: 0, selectionEnd: 0, focus() {}, setSelectionRange() {} };
  N.ctx.document.querySelector = () => ({ currentTime: 76.93 });
  N.ctx.formatDuration = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  N.insertCurrentTimestamp({ closest: () => ({ querySelector: () => input }) });
  assert.strictEqual(input.value, '1:16 ');
});

/* ── Panel-only icons (icons.js) ───────────────────────────────────────── */

function loadIcons() {
  const ctx = { Math, JSON, Array, Object, String, RegExp, document: { querySelectorAll: () => [] } };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('player-lib', 'icons.js'), ctx);
  ctx.VAULT_ICONS = vm.runInContext('VAULT_ICONS', ctx);
  return ctx;
}
const I = loadIcons();

test('panel swap: the emoji stays for Classic and the library, the icon is panel-only', () => {
  const html = I.vaultPanelIconSwap('🔄 ', 'refresh');
  assert.match(html, /^<span class="vi-pc">🔄 <\/span><svg class="vi vi-refresh vi-pm vi-gap"/);
  assert.match(I.vaultPanelIconSwap('✎', 'edit'), /class="vi vi-edit vi-pm"/);
  // No icon: the panel shows the words alone.
  assert.strictEqual(I.vaultPanelIconSwap('🧬 '), '<span class="vi-pc">🧬 </span>');
  assert.strictEqual(I.vaultPanelIconSwap('<b>', 'nope'), '<span class="vi-pc">&lt;b&gt;</span>');
});

test('panel swap: CSS hides the icon everywhere but the Modern panel', () => {
  const css = read('css', 'player', 'player-panel-modern.css');
  assert.match(css, /\n\.vi-pm \{ display: none; \}/);
  assert.match(css, /\n\.vi-pc \{ display: contents; \}/);
  assert.match(css, /body\.layout-modern \.mpp \.vi-pc \{ display: none; \}/);
  assert.match(css, /body\.layout-modern \.mpp \.vi-pm \{ display: inline-block; \}/);
  // Every other rule is Modern only.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.split('{')[0].trim()).filter(Boolean);
  for (const sel of rules) {
    if (/^@(media|keyframes)/.test(sel) || /^(to|from)$/.test(sel)) continue;
    if (sel === '.vi-pc' || sel === '.vi-pm') continue;
    for (const one of sel.replace(/^@media[^{]*/, '').split(',')) {
      assert.match(one.trim(), /^body\.layout-modern\b/, `not Modern only: ${one.trim()}`);
    }
  }
});

test('every icon the panel and its sections name exists', () => {
  const files = ['detail-view.js', 'notes.js', 'music.js', 'faces.js', 'duplicates.js', 'studios.js', 'metadata-edit.js',
    path.join('player', 'player-subtitles.js'), path.join('games', 'games-sidebar.js')];
  const names = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    for (const m of src.matchAll(/(?:vaultPanelIconSwap|_panelGlyph|musicGlyph|subsGlyph|glyph)\('[^']*', '([a-z-]+)'\)/g)) names.add(m[1]);
    for (const m of src.matchAll(/detailPanelIcon\('([a-z-]+)'\)/g)) names.add(m[1]);
    for (const m of src.matchAll(/icon: '([a-z-]+)'/g)) if (f === 'detail-view.js') names.add(m[1]);
    for (const m of src.matchAll(/vi: '([a-z-]+)'/g)) names.add(m[1]);
  }
  assert.ok(names.size > 15, `found ${names.size}`);
  for (const n of names) assert.ok(I.VAULT_ICONS[n], `no icon "${n}"`);
});

/* ── Wiring ────────────────────────────────────────────────────────────── */

test('page: the panel module loads before detail-view.js, its CSS after the dock CSS', () => {
  const html = read('db-viewer.html');
  const at = (s) => { const i = html.indexOf(s); assert.ok(i > 0, s); return i; };
  assert.ok(at('player-lib/player/panel-layout.js') < at('player-lib/detail-view.js'));
  assert.ok(at('css/player/player-modern.css') < at('css/player/player-panel-modern.css'));
});

test('player sidebar: the tabbed panel only in Modern, Classic keeps renderDetailBody', () => {
  const src = read('player-lib', 'player', 'player-core.js');
  const fn = src.slice(src.indexOf('function renderSidebar()'), src.indexOf('function closeMediaInfo()'));
  assert.match(fn, /detailPanelTabbed\(\)\)[\s\S]*renderDetailPanel\(media, \{ extraFile: skipped \}\)/);
  assert.match(fn, /renderDetailBody\(media, \{ context: 'player' \}\) \+ skipped/);
  const dv = read('player-lib', 'detail-view.js');
  assert.match(dv, /function detailPanelTabbed\(\) \{\s*return typeof isModernLayout === 'function' && isModernLayout\(\);/);
});

test('library detail view: the tabbed panel in Modern (library surface), Classic keeps renderDetailBody', () => {
  const src = read('player-lib', 'modal.js');
  const fn = src.slice(src.indexOf('function showDetails('), src.indexOf('function closeModal('));
  assert.match(fn, /tabbed\s*\? renderDetailPanel\(media, \{ context: 'library' \}\)\s*: renderDetailBody\(media, \{ context: 'library' \}\)/);
  assert.match(fn, /if \(tabbed\) detailPanelMounted\(\);/);
});

test('panel surfaces: player-only and library-only parts stay on their own side', () => {
  const dv = read('player-lib', 'detail-view.js');
  const panel = dv.slice(dv.indexOf('function renderDetailPanel('), dv.indexOf('/* ── Panel behaviour'));
  // The current-time button and Find faces in this frame: player only.
  assert.match(panel, /timed && !lib \? `<button type="button" class="mpp-ib" onclick="insertCurrentTimestamp\(this\)"/);
  assert.match(panel, /!lib && type === 'video' && typeof facesFindInFrame/);
  // Play: library only; trash goes through the library's own handler there.
  assert.match(dv, /const play = lib \?/);
  assert.match(dv, /lib \? 'trashOrRestoreFromDetails' : 'trashOrRestoreFromSidebar'/);
  // The note box saves exactly what was typed: no automatic time.
  assert.ok(!/data-note-at/.test(dv), 'no start time on the box');
  assert.ok(!/_noteBoxText/.test(read('player-lib', 'notes.js')));
});
