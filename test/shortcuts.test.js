/**
 * The keyboard shortcuts list (player-lib/shortcuts.js), run in a VM: the
 * table is well formed, "You are here" follows what is on screen, the search
 * filters rows, ? opens only when not typing, and the player's single-key
 * shortcuts leave Ctrl / Cmd chords to the browser (Ctrl+R reloads, it does
 * not pick a random file).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const noop = () => {};

function makeCtx(extra = {}) {
  const docListeners = [];
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp,
    window: { addEventListener: noop },
    document: {
      addEventListener: (type, fn) => docListeners.push({ type, fn }),
      getElementById: () => null,
      querySelector: () => null,
    },
    ...extra,
  };
  ctx.__docListeners = docListeners;
  vm.createContext(ctx);
  return ctx;
}

function loadShortcuts() {
  const ctx = makeCtx();
  const src = fs.readFileSync(path.join(LIB, 'shortcuts.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__s = { SHORTCUT_GROUPS, SHORTCUTS, shortcutsFilter, shortcutsGroups,
    shortcutsDetectContext, shortcutsShouldOpen, isBrowserChord, shortcutsGroupsHtml };`, ctx);
  return ctx.__s;
}

const S = loadShortcuts();
const plain = (x) => JSON.parse(JSON.stringify(x));
const key = (k, mods = {}, target = { nodeType: 1, tagName: 'BODY' }) => ({ key: k, target, ...mods });

/* ── The table ─────────────────────────────────────────────────────────── */

test('table: every row has a known group, keys and plain-language words', () => {
  const ids = new Set(S.SHORTCUT_GROUPS.map(g => g.id));
  assert.strictEqual(ids.size, S.SHORTCUT_GROUPS.length, 'group ids are unique');
  for (const r of S.SHORTCUTS) {
    assert.ok(ids.has(r.ctx), `unknown group ${r.ctx}`);
    assert.ok(Array.isArray(r.keys) && r.keys.length, `${r.desc}: no keys`);
    for (const alt of r.keys) {
      const parts = Array.isArray(alt) ? alt : [alt];
      assert.ok(parts.length && parts.every(p => typeof p === 'string' && p.length), `${r.desc}: bad key ${JSON.stringify(alt)}`);
    }
    assert.ok(typeof r.desc === 'string' && r.desc.trim().length > 3, 'a description');
    assert.ok(!/[–—]/.test(r.desc), `no dashes: ${r.desc}`);
  }
  for (const g of S.SHORTCUT_GROUPS) {
    assert.ok(S.SHORTCUTS.some(r => r.ctx === g.id), `group ${g.id} has rows`);
    assert.ok(!/[–—]/.test(g.title));
  }
});

test('table: the contexts asked for, in order, and no key listed twice in one group (Esc aside)', () => {
  assert.deepStrictEqual(plain(S.SHORTCUT_GROUPS.map(g => g.id)),
    ['player', 'pictures', 'mini', 'library', 'dock', 'wall', 'editor', 'faces', 'anywhere', 'typing']);
  for (const g of S.SHORTCUT_GROUPS) {
    const seen = new Set();
    for (const r of S.SHORTCUTS.filter(x => x.ctx === g.id)) {
      for (const alt of r.keys) {
        const k = Array.isArray(alt) ? alt.join('+') : alt;
        if (k === 'Esc') continue;
        assert.ok(!seen.has(k), `${g.id}: ${k} listed twice`);
        seen.add(k);
      }
    }
  }
});

test('table: ? is listed once, under Anywhere, and nothing else uses it', () => {
  const q = S.SHORTCUTS.filter(r => r.keys.flat().includes('?'));
  assert.strictEqual(q.length, 1);
  assert.strictEqual(q[0].ctx, 'anywhere');
});

test('table: the real handlers, including what the preview got wrong', () => {
  const find = (ctx, k) => S.SHORTCUTS.filter(r => r.ctx === ctx && r.keys.some(a => (Array.isArray(a) ? a.join('+') : a) === k));
  assert.ok(find('player', 'Q')[0].desc.includes('video and audio'), 'Q only shrinks video and audio');
  assert.ok(find('player', '+').length && find('player', '=').length, 'documents: + and = make text bigger');
  assert.ok(find('pictures', '=').length && find('pictures', '_').length);
  assert.ok(find('editor', '[')[0].desc.includes('then'), 'in the Editor [ and ] step start, end, off');
  assert.ok(find('dock', 'Up').length && find('dock', 'Down').length, 'the preview pane moves by rows too');
  assert.ok(find('typing', 'Ctrl+Enter').length, 'Ctrl+Enter saves a file description');
});

/* ── You are here ──────────────────────────────────────────────────────── */

test('context: the layer on top wins', () => {
  const ctx = (env) => S.shortcutsDetectContext({ tab: 'library', ...env });
  assert.strictEqual(ctx({}), 'library');
  assert.strictEqual(ctx({ dockShown: true }), 'dock');
  assert.strictEqual(ctx({ playerOpen: true, mediaType: 'video' }), 'player');
  assert.strictEqual(ctx({ playerOpen: true, mediaType: 'audio' }), 'player');
  assert.strictEqual(ctx({ playerOpen: true, mediaType: 'document' }), 'player');
  assert.strictEqual(ctx({ playerOpen: true, mediaType: 'image' }), 'pictures');
  assert.strictEqual(ctx({ playerOpen: true, mediaType: 'gif' }), 'pictures');
  assert.strictEqual(ctx({ miniOpen: true }), 'mini');
  assert.strictEqual(ctx({ tab: 'editor', editorMix: true }), 'editor');
  assert.strictEqual(ctx({ tab: 'wall' }), 'wall');
  assert.strictEqual(ctx({ tab: 'wall', playerOpen: true, mediaType: 'video' }), 'player', 'the player over the wall');
  assert.strictEqual(ctx({ tab: 'wall', miniOpen: true }), 'mini');
  assert.strictEqual(ctx({ facesReview: true, playerOpen: true }), 'faces', 'a Faces review sits above the player');
  assert.strictEqual(ctx({ tab: 'faces', facesInline: true }), 'faces');
  assert.strictEqual(ctx({ tab: 'faces' }), 'library');
  assert.strictEqual(ctx({ tab: 'studios', dockShown: true }), 'dock');
});

test('groups: here comes first and is marked; the rest keep their order', () => {
  const g = S.shortcutsGroups('', 'wall');
  assert.strictEqual(g[0].id, 'wall');
  assert.strictEqual(g[0].here, true);
  assert.ok(g.slice(1).every(x => !x.here));
  assert.deepStrictEqual(plain(g.slice(1).map(x => x.id)),
    ['player', 'pictures', 'mini', 'library', 'dock', 'editor', 'faces', 'anywhere', 'typing']);
  const none = S.shortcutsGroups('', null);
  assert.strictEqual(none[0].id, 'player');
  assert.ok(none.every(x => !x.here));
  const html = S.shortcutsGroupsHtml(S.shortcutsGroups('', 'editor'), '');
  assert.strictEqual((html.match(/You are here/g) || []).length, 1);
  assert.ok(html.indexOf('Editor') < html.indexOf('Player'));
});

/* ── Search ────────────────────────────────────────────────────────────── */

test('search: words, keys and group names; every word must match', () => {
  const descs = (q) => plain(S.shortcutsFilter(S.SHORTCUTS, q).map(r => `${r.ctx}: ${r.desc}`));
  assert.strictEqual(S.shortcutsFilter(S.SHORTCUTS, '').length, S.SHORTCUTS.length);
  assert.strictEqual(S.shortcutsFilter(S.SHORTCUTS, '   ').length, S.SHORTCUTS.length);
  const loop = descs('loop');
  assert.ok(loop.length >= 5 && loop.every(d => /loop/i.test(d)), JSON.stringify(loop));
  assert.deepStrictEqual(descs('MUTE'), ['player: Mute or unmute']);
  assert.deepStrictEqual(descs('zoom'), ['pictures: Zoom in', 'pictures: Zoom out', 'pictures: Reset zoom and turn']);
  assert.ok(descs('ctrl').some(d => d.includes('Privacy mode')));
  assert.ok(descs('wall').every(d => d.startsWith('wall:') || /wall/i.test(d)));
  assert.deepStrictEqual(descs('loop editor').length, 2);
  assert.deepStrictEqual(descs('nothing like this'), []);
  // Arrows answer to their names as well as their symbols.
  assert.ok(descs('left arrow').some(d => d.includes('5 seconds')));
});

test('search: groups the search empties drop out, and no match says so', () => {
  const g = S.shortcutsGroups('mute', 'wall');
  assert.deepStrictEqual(plain(g.map(x => x.id)), ['player']);
  assert.deepStrictEqual(plain(S.shortcutsGroups('zzzz', 'player')), []);
  const html = S.shortcutsGroupsHtml([], '<b>');
  assert.ok(html.includes('No shortcut matches') && html.includes('&lt;b&gt;'));
});

/* ── Opening with ? ────────────────────────────────────────────────────── */

test('?: opens on its own, not with Ctrl / Cmd / Alt, not while typing', () => {
  const input = (type) => ({ nodeType: 1, tagName: 'INPUT', type });
  assert.strictEqual(S.shortcutsShouldOpen(key('?', { shiftKey: true })), true);
  assert.strictEqual(S.shortcutsShouldOpen(key('/', { shiftKey: false })), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', { ctrlKey: true, shiftKey: true })), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', { metaKey: true })), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', { altKey: true })), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', { ctrlKey: true, altKey: true })), true, 'AltGr types ? on some keyboards');
  assert.strictEqual(S.shortcutsShouldOpen(key('?', { repeat: true })), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', {}, input('text'))), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', {}, input('search'))), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', {}, input(''))), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', {}, { nodeType: 1, tagName: 'TEXTAREA' })), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', {}, { nodeType: 1, tagName: 'DIV', isContentEditable: true })), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?', {}, input('checkbox'))), true, 'a tick box takes no typing');
  assert.strictEqual(S.shortcutsShouldOpen(key('?', {}, input('range'))), true);
  // Focus in a text box (a modal that takes typing) even when the event's target is not.
  assert.strictEqual(S.shortcutsShouldOpen(key('?'), { nodeType: 1, tagName: 'TEXTAREA' }), false);
  assert.strictEqual(S.shortcutsShouldOpen(key('?'), { nodeType: 1, tagName: 'BUTTON' }), true);
});

test('isBrowserChord: Ctrl / Cmd with a letter or symbol; not Space, arrows, Esc or AltGr', () => {
  assert.strictEqual(S.isBrowserChord(key('r', { ctrlKey: true })), true);
  assert.strictEqual(S.isBrowserChord(key('R', { ctrlKey: true, shiftKey: true })), true);
  assert.strictEqual(S.isBrowserChord(key('r', { metaKey: true })), true);
  assert.strictEqual(S.isBrowserChord(key('=', { ctrlKey: true })), true);
  assert.strictEqual(S.isBrowserChord(key('r')), false);
  assert.strictEqual(S.isBrowserChord(key('<', { shiftKey: true })), false);
  assert.strictEqual(S.isBrowserChord(key(' ', { ctrlKey: true })), false);
  assert.strictEqual(S.isBrowserChord(key('ArrowLeft', { ctrlKey: true })), false);
  assert.strictEqual(S.isBrowserChord(key('Escape', { ctrlKey: true })), false);
  assert.strictEqual(S.isBrowserChord(key('[', { ctrlKey: true, altKey: true })), false, 'AltGr+8 types [ on a German keyboard');
  assert.strictEqual(S.isBrowserChord(key('[', { ctrlKey: true, getModifierState: (m) => m === 'AltGraph' })), false);
});

/* ── The player's keys ─────────────────────────────────────────────────── */

function loadPlayer(mediaType) {
  const calls = [];
  const rec = (name) => (...a) => calls.push(name + (a.length ? `(${a.join(',')})` : ''));
  const overlay = { classList: { contains: (c) => c === 'active' } };
  const ctx = makeCtx({
    currentMediaState: { type: mediaType },
    abLoopA: null, abLoopB: null,
  });
  ctx.document.getElementById = (id) => (id === 'mediaPlayerOverlay' ? overlay : null);
  ctx.document.fullscreenElement = null;
  for (const fn of ['togglePlay', 'toggleAudioPlay', 'skipVideo', 'skipAudio', 'toggleMute', 'toggleAudioMute',
    'setVolume', 'setAudioVolume', 'zoomImage', 'toggleFullscreen', 'toggleSidebar', 'closeMediaInfo',
    'closeMediaPlayer', 'minimizePlayer', 'showMediaInfo', 'playNextMedia', 'playPreviousMedia', 'playRandomMedia',
    'rotateImage', 'resetImage', 'adjustDocFontSize', 'toggleAbLoop', 'clearAbLoop', 'cycleSpeed']) ctx[fn] = rec(fn);
  vm.runInContext(fs.readFileSync(path.join(LIB, 'shortcuts.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(LIB, 'player', 'player-controls.js'), 'utf8'), ctx);
  const handler = ctx.__docListeners.find(l => l.type === 'keydown').fn;
  const press = (k, mods = {}) => {
    const before = calls.length;
    handler({ key: k, target: { tagName: 'BODY', closest: () => null }, preventDefault: noop, stopPropagation: noop, stopImmediatePropagation: () => calls.push('stop'), ...mods });
    return calls.slice(before);
  };
  return press;
}

test('player: R picks a random file; Ctrl+R and Cmd+R are left to the browser (reload)', () => {
  const press = loadPlayer('video');
  assert.deepStrictEqual(press('r'), ['playRandomMedia']);
  assert.deepStrictEqual(press('R', { shiftKey: true }), ['playRandomMedia']);
  assert.deepStrictEqual(press('r', { ctrlKey: true }), []);
  assert.deepStrictEqual(press('R', { ctrlKey: true, shiftKey: true }), []);
  assert.deepStrictEqual(press('r', { metaKey: true }), []);
});

test('player: other letters and symbols ignore Ctrl too; Shift keys, Space, arrows and Alt+arrows still work', () => {
  const press = loadPlayer('video');
  for (const k of ['f', 'm', 'n', 'p', 'q', 'i', 'j', 'l', '[', '\\', ',', '.']) {
    assert.deepStrictEqual(press(k, { ctrlKey: true }), [], `Ctrl+${k}`);
  }
  assert.deepStrictEqual(press('n'), ['playNextMedia']);
  assert.deepStrictEqual(press('<', { shiftKey: true }), ['cycleSpeed(-1)']);
  assert.deepStrictEqual(press('>', { shiftKey: true }), ['cycleSpeed(1)']);
  assert.deepStrictEqual(press('['), ['toggleAbLoop']);
  assert.deepStrictEqual(press(' '), ['togglePlay']);
  assert.deepStrictEqual(press('ArrowRight'), ['skipVideo(5)']);
  assert.deepStrictEqual(press('ArrowRight', { altKey: true }), ['playNextMedia']);
  assert.deepStrictEqual(press('ArrowLeft', { altKey: true }), ['playPreviousMedia']);
  assert.deepStrictEqual(press('?', { shiftKey: true }), [], '? is nothing to the player');
  // Q stops the key there: app.js's mini player Q would otherwise bring the full player back at once.
  assert.deepStrictEqual(press('q'), ['minimizePlayer', 'stop']);
});

test('player pictures: + _ zoom, Ctrl+= / Ctrl+- zoom the page instead', () => {
  const press = loadPlayer('image');
  assert.deepStrictEqual(press('+', { shiftKey: true }), ['zoomImage(0.25)']);
  assert.deepStrictEqual(press('_', { shiftKey: true }), ['zoomImage(-0.25)']);
  assert.deepStrictEqual(press('=', { ctrlKey: true }), []);
  assert.deepStrictEqual(press('-', { ctrlKey: true }), []);
  assert.deepStrictEqual(press('0', { ctrlKey: true }), []);
  assert.deepStrictEqual(press('r'), ['rotateImage(90)']);
});

/* ── Focus stays in the window ─────────────────────────────────────────── */

test('focus trap: Tab and Shift+Tab go round the window; focus outside is brought back', () => {
  const ctx = makeCtx({ Node: Object });
  const src = fs.readFileSync(path.join(LIB, 'shortcuts.js'), 'utf8');
  vm.runInContext(`${src}\n;globalThis.__k = { shortcutsOnKey, shortcutsTabTarget, setWin: (w) => { _skWin = w; } };`, ctx);
  const K = ctx.__k;
  const doc = ctx.document;
  const ctl = (name) => ({ name, focus() { doc.activeElement = this; } });
  const search = ctl('search'), close = ctl('close'), link = ctl('link'), behind = ctl('app-tab');
  const inside = [search, close, link];
  const ov = { isConnected: true, contains: (el) => inside.includes(el), querySelectorAll: () => inside, querySelector: () => search };
  K.setWin({ ov, opener: null, onFocusIn: noop });
  const press = (k, mods = {}) => {
    const ev = { key: k, target: doc.activeElement, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...mods };
    K.shortcutsOnKey(ev);
    return ev;
  };
  doc.activeElement = search;
  let ev = press('Tab');
  assert.strictEqual(doc.activeElement.name, 'close');
  assert.ok(ev.prevented && ev.stopped, 'the page never sees the Tab');
  press('Tab'); assert.strictEqual(doc.activeElement.name, 'link');
  press('Tab'); assert.strictEqual(doc.activeElement.name, 'search', 'wraps round from the last control');
  press('Tab', { shiftKey: true }); assert.strictEqual(doc.activeElement.name, 'link', 'Shift+Tab wraps back');
  // Focus has landed behind the window: Tab and typing come back inside.
  doc.activeElement = behind;
  press('Tab'); assert.strictEqual(doc.activeElement.name, 'search');
  doc.activeElement = behind;
  ev = press(' ');
  assert.ok(ev.prevented && ev.stopped, 'Space does not press the control behind');
  assert.strictEqual(doc.activeElement.name, 'search');
  // Inside the window, ordinary keys type as usual.
  ev = press('a');
  assert.ok(!ev.prevented && ev.stopped);
  // Pure helper edge cases.
  assert.strictEqual(K.shortcutsTabTarget([], search, false), null);
  assert.strictEqual(K.shortcutsTabTarget(inside, behind, true).name, 'link');
});

test('context: the Editor is here only while a mix is open; Games has no group', () => {
  assert.strictEqual(S.shortcutsDetectContext({ tab: 'editor', editorMix: true }), 'editor');
  assert.strictEqual(S.shortcutsDetectContext({ tab: 'editor', editorMix: false }), null);
  assert.strictEqual(S.shortcutsDetectContext({ tab: 'games' }), null);
  const g = S.shortcutsGroups('', null);
  assert.ok(g.every(x => !x.here));
  assert.strictEqual(g[0].id, 'player');
});
