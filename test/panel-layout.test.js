/**
 * The Modern player's tabbed Info panel (player-lib/player/panel-layout.js,
 * drawn by player-lib/detail-view.js renderDetailPanel): which tabs each file
 * type gets, the tab it opens on, the quick actions and how many fit, the
 * note box's leading time, the panel-only icon swap (icons.js), and that the
 * page wires it up for Modern only.
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
  assert.deepStrictEqual([...P.TAB_ORDER], ['details', 'notes', 'subtitles', 'music', 'people', 'file']);
  const all = P.tabsFor('video', { faces: true, fingerprinted: true });
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

/* ── The note box ──────────────────────────────────────────────────────── */

test('times: m:ss, and h:mm:ss past an hour', () => {
  assert.strictEqual(P.formatTime(0), '0:00');
  assert.strictEqual(P.formatTime(76.9), '1:16');
  assert.strictEqual(P.formatTime(3723), '1:02:03');
  assert.strictEqual(P.formatTime(-4), '0:00');
  assert.strictEqual(P.formatTime(NaN), '0:00');
});

test('note box: the time it was started at leads the note', () => {
  assert.strictEqual(P.noteWithTime('good bit', 76), '1:16 good bit');
  assert.strictEqual(P.noteWithTime('  spaced  ', 0), '0:00 spaced');
});

test('note box: a note that names a time, or has no usable time, is kept as typed', () => {
  assert.strictEqual(P.noteWithTime('loop 0:41-1:03 best waves', 76), 'loop 0:41-1:03 best waves');
  assert.strictEqual(P.noteWithTime('at 1:02:03 it ends', 5), 'at 1:02:03 it ends');
  assert.strictEqual(P.noteWithTime('no time', NaN), 'no time');
  assert.strictEqual(P.noteWithTime('no time', undefined), 'no time');
  assert.strictEqual(P.noteWithTime('no time', -1), 'no time');
  assert.strictEqual(P.noteWithTime('   ', 10), '');
  assert.strictEqual(P.noteWithTime('ratio 16:9 is wide', 10), '0:10 ratio 16:9 is wide', 'one-digit seconds is not a time');
});

test('note box: a time with letters right after it still counts, so no second time goes in', () => {
  assert.strictEqual(P.noteWithTime('0:05intro', 5), '0:05intro');
  assert.strictEqual(P.noteWithTime('0:05 intro', 5), '0:05 intro', 'the clock button\'s own insert');
  assert.strictEqual(P.noteWithTime('meet at 10:30pm', 7), 'meet at 10:30pm');
  assert.strictEqual(P.noteWithTime('1:02:03 x', 7), '1:02:03 x');
  assert.strictEqual(P.noteWithTime('(1:16) drop', 7), '(1:16) drop');
  assert.strictEqual(P.noteWithTime('v2:30', 7), 'v2:30');
  // Not times: too many digits, or part of a longer number.
  assert.strictEqual(P.noteWithTime('id 123:456', 7), '0:07 id 123:456');
  assert.strictEqual(P.noteWithTime('ip 10.0.0.1:8080', 7), '0:07 ip 10.0.0.1:8080');
});

test('note box: a start time carried through Classic only comes back with its own file and draft', () => {
  const saved = { id: 7, text: 'round trip', at: '3' };
  assert.strictEqual(P.draftStartAt(saved, 7, 'round trip'), '3');
  assert.strictEqual(P.draftStartAt(saved, 7, '  round trip, and more '), '3', 'typed on in Classic');
  assert.strictEqual(P.draftStartAt(saved, 8, 'round trip'), '', 'another file');
  assert.strictEqual(P.draftStartAt(saved, 7, 'classic draft'), '', 'saved in Classic, a new draft typed');
  assert.strictEqual(P.draftStartAt(saved, 7, ''), '');
  assert.strictEqual(P.draftStartAt({ id: 7, text: 'x', at: '' }, 7, 'x'), '', 'no time was taken');
  assert.strictEqual(P.draftStartAt(null, 7, 'x'), '');
  assert.strictEqual(P.draftStartAt({ id: 7, text: '', at: '3' }, 7, 'x'), '');
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
  // The library modal path never asks for the panel.
  assert.ok(!/renderDetailPanel/.test(read('player-lib', 'modal.js')));
});
