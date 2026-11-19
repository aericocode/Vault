/**
 * The selection bar (player-lib/selection.js), run in a VM with a small fake
 * DOM: one list of actions (SEL_ACTIONS) behind a bar of a few pinned
 * buttons with words, and a More menu with every action that applies,
 * grouped, with a pin per row (stored in settings.js selBarPinned).
 *
 *  - the list holds every action the old bar could show, each with the
 *    condition it had;
 *  - the default pins and the bar's short words, the "(n)" counts;
 *  - pin / unpin (a default too), unknown ids ignored, back to the defaults,
 *    the pins kept in vault_settings;
 *  - More: the groups in order, pinned rows marked, the keys, a pin that
 *    does not run the action, popovers anchored to More;
 *  - no room: pinned buttons move into More from the right, the words stay.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const read = (f) => fs.readFileSync(path.join(LIB, f), 'utf8');
const noop = () => {};

/* ── A fake DOM: enough of it for the bar and the menu ────────────────── */

function classList(el) {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
    contains: (c) => set.has(c),
    _set: set,
    get value() { return [...set].join(' '); },
  };
}

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
    if (m[1] === 'button' || m[1] === 'span' || m[1] === 'div') continue;
    out[m[1]] = m[2] === undefined ? '' : m[2];
  }
  return out;
}

/** One selector part against an element: [attr], [attr="v"], .class, :not([hidden]) left out. */
function matchOne(el, sel) {
  sel = sel.trim().replace(/^#selectionBar\s+/, '');
  if (sel.startsWith('.')) {
    const [cls, ...rest] = sel.slice(1).split(':');
    return el.classList.contains(cls) && (!rest.length || !el.hidden);
  }
  const m = sel.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
  if (m) return m[1] in el.attrs && (m[2] === undefined || el.attrs[m[1]] === m[2]);
  return sel === 'button' && el.tag === 'button';
}
const matches = (el, sel) => sel.split(',').some(s => matchOne(el, s));

function makeButton(ctx, tagHtml, inner, owner) {
  const attrs = attrsOf(tagHtml);
  const el = {
    tag: 'button', attrs, inner, owner,
    classList: classList(),
    dataset: {},
    hidden: false,
    isConnected: true,
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; },
    focus() { ctx.document.activeElement = el; },
    closest(sel) { return matches(el, sel) ? el : null; },
    getBoundingClientRect: () => ({ left: 300, top: 700, right: 380, bottom: 732, width: 80, height: 32 }),
  };
  for (const c of (attrs.class || '').split(/\s+/).filter(Boolean)) el.classList.add(c);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = v;
  }
  return el;
}

/** Parse the buttons out of some markup, in order, siblings linked (a menu row's action, then its pin). */
function parseButtons(ctx, html, owner) {
  const out = [];
  for (const m of html.matchAll(/(<button\b[^>]*>)([\s\S]*?)<\/button>/g)) out.push(makeButton(ctx, m[1], m[2], owner));
  for (let i = 0; i < out.length; i++) {
    const pinNext = out[i + 1] && out[i + 1].classList.contains('sel-pin') ? out[i + 1] : null;
    out[i].nextElementSibling = pinNext;
    out[i].previousElementSibling = out[i].classList.contains('sel-pin') ? out[i - 1] : null;
  }
  return out;
}

function makeContainer(ctx, extra = {}) {
  const el = {
    _html: '', kids: [], listeners: {}, style: {}, attrs: {},
    classList: classList(),
    offsetWidth: 600, offsetHeight: 48,
    isConnected: true,
    get innerHTML() { return this._html; },
    set innerHTML(h) { this._html = h; this.kids = parseButtons(ctx, h, this); },
    addEventListener(t, fn, cap) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    setAttribute(k, v) { this.attrs[k] = v; },
    querySelectorAll(sel) { return this.kids.filter(k => matches(k, sel)); },
    querySelector(sel) { return this.kids.find(k => matches(k, sel)) || null; },
    contains(x) { return x === this || this.kids.includes(x); },
    remove() { this.isConnected = false; ctx.__removed.push(this); },
    getBoundingClientRect: () => ({ left: 18, top: 700, right: 618, bottom: 748, width: 600, height: 48 }),
    ...extra,
  };
  return el;
}

/**
 * selection.js (with icons.js) and a bar whose last piece wraps once more
 * than `room` pinned buttons show (no room limit by default).
 */
function loadBar({ modern = true, counts = {}, size = 3, inColl = [], skip = null, share = true, faces = true, stags = true, room = Infinity, pins } = {}) {
  const calls = [];
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    localStorage: { getItem: () => null, setItem: noop },
    innerWidth: 1280, innerHeight: 800,
    TILE_TYPE_ICONS: { video: '🎬' },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    __removed: [],
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  ctx.isModernLayout = () => modern;
  const docListeners = {};
  ctx.document = {
    activeElement: null,
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: (t, fn) => { docListeners[t] = (docListeners[t] || []).filter(f => f !== fn); },
    querySelectorAll: () => [],
    body: { appendChild: (el) => { ctx.__menuEl = el; el.isConnected = true; }, classList: classList() },
  };
  const bar = makeContainer(ctx);
  bar.id = 'selectionBar';
  // The X (the last piece) drops a line once more than `room` pinned buttons are showing.
  Object.defineProperty(bar, 'firstElementChild', { get: () => ({ offsetTop: 0 }) });
  Object.defineProperty(bar, 'lastElementChild', {
    get: () => ({ offsetTop: bar.kids.filter(k => k.dataset.selAct && !k.hidden).length > room ? 44 : 0 }),
  });
  // Popovers a test opens (stPop, collectionPicker) by id.
  ctx.__byId = {};
  ctx.document.getElementById = (id) => (id === 'selectionBar' ? bar : ctx.__byId[id] || null);
  ctx.document.querySelector = (sel) => {
    if (sel.startsWith('#selectionBar')) return bar.querySelector(sel);
    return null;
  };
  ctx.document.createElement = () => makeContainer(ctx);
  vm.createContext(ctx);
  vm.runInContext(read('icons.js'), ctx);
  vm.runInContext(read('selection.js'), ctx);

  const c = { count: size, trashed: 0, flagged: 0, failed: 0, errored: 0, unscanned: 0, av: 0, video: 0, faceable: 0, ...counts };
  ctx.__counts = c;
  ctx.__inColl = inColl;
  ctx.__skip = skip;
  ctx.__share = share;
  ctx.__faces = faces;
  ctx.__stags = stags;
  ctx.__calls = calls;
  ctx.__pins = pins === undefined ? null : pins;
  vm.runInContext(`
    var __realRefresh = forceRefreshSelected;
    selectedIds = new Set(Array.from({ length: ${size} }, (_, i) => i + 1));
    renderResultsSelect = () => {};
    selectionCounts = () => __counts;
    var selectedInOpenCollection = () => __inColl;
    var skipOpenCollection = () => (__skip ? { id: 5 } : null);
    var Skips = { has: (cid, id) => !!(__skip && __skip.on.includes(id)) };
    var UpNext = {};
    var upNextAddSelection = (w) => __calls.push(['upnext', w]);
    var addSelectionToCollection = (el) => __calls.push(['collect', el]);
    var removeSelectedFromCollection = () => __calls.push(['uncollect']);
    var skipSelected = (on) => __calls.push(['skip', on]);
    var studiosSelectionPick = (el) => __calls.push(['studio', el]);
    var StreamTags = { loaded: () => __stags, selectionMenu: (el) => __calls.push(['streamtag', el]), closeMenu: () => {} };
    bulkFlag = (v) => __calls.push(['flag', v]);
    var fingerprintSelected = () => __calls.push(['musicid']);
    var openEditorWithSelection = (l) => __calls.push(['editor', l]);
    var shareEnabled = () => __share;
    var shareOpenForSelection = () => __calls.push(['share']);
    retryErrorsSelected = () => __calls.push(['retry']);
    forceRefreshSelected = (el) => __calls.push(['refresh', el]);
    markPlayableSelected = () => __calls.push(['playable']);
    var facesReady = () => __faces;
    var facesIndexSelection = () => __calls.push(['faces']);
    trashSelected = () => __calls.push(['trash']);
    restoreSelected = () => __calls.push(['restore']);
    var removeSelectedRecords = () => __calls.push(['remove']);
    var hideTilePopover = () => __calls.push(['hidePopover']);
    window.vaultForceRefresh = () => {};
    window.vaultSelBarPinned = () => __pins;
    window.vaultSetSelBarPinned = (ids) => { __pins = ids; };
  `, ctx);
  const run = (code) => { const v = vm.runInContext(code, ctx); return Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : v; };
  run('renderSelectionBar()');
  return { ctx, bar, run, calls, menu: () => ctx.__menuEl, docListeners };
}

const ids = (b) => b.bar.kids.filter(k => k.dataset.selAct && !k.hidden).map(k => k.dataset.selAct);
const text = (html) => html.replace(/<span class="vi-c">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const classic = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const btn = (b, id) => b.bar.kids.find(k => k.dataset.selAct === id);
const row = (b, id) => b.menu().kids.find(k => k.dataset.selMi === id);
const pin = (b, id) => b.menu().kids.find(k => k.dataset.selPin === id);

/* ── The list ─────────────────────────────────────────────────────────── */

test('every action the old bar could show is in the list, in its group, in bar order', () => {
  const b = loadBar();
  const list = b.run('SEL_ACTIONS.map(a => [a.id, a.group, !!a.danger, !!a.popover])');
  assert.deepStrictEqual(list.map(a => a[0]), [
    'playnext', 'upnext', 'collect', 'uncollect', 'skip', 'studio', 'streamtag', 'flag',
    'stack', 'grid', 'musicid', 'share', 'retry', 'refresh', 'playable', 'faces', 'restore', 'trash', 'remove',
  ]);
  const group = Object.fromEntries(list.map(a => [a[0], a[1]]));
  assert.deepStrictEqual(
    ['playnext', 'upnext', 'collect', 'uncollect', 'skip', 'studio', 'streamtag', 'flag', 'stack', 'grid', 'musicid', 'share', 'retry', 'refresh', 'playable', 'faces', 'restore', 'trash', 'remove'].map(id => group[id]),
    ['play', 'play', 'collection', 'collection', 'collection', 'label', 'label', 'label', 'create', 'create', 'create', 'create', 'library', 'library', 'library', 'library', 'library', 'danger', 'danger']);
  assert.deepStrictEqual(list.filter(a => a[2]).map(a => a[0]), ['trash', 'remove'], 'Trash and Remove from library are set apart');
  assert.deepStrictEqual(list.filter(a => a[3]).map(a => a[0]), ['collect', 'studio', 'streamtag'], 'the three that open a menu or picker');
  // The old helpers that drew bar buttons in other files are gone: one list.
  for (const [f, name] of [['collection-skips.js', 'skipSelectionButton'], ['studios.js', 'studiosSelectionButton'], ['stream-tags.js', 'streamTagsSelectionButton'], ['share-ui.js', 'shareSelectionButton'], ['faces.js', 'facesSelectionButton']]) {
    assert.ok(!read(f).includes(`function ${name}(`), `${f}: ${name} is gone`);
  }
});

test('each action shows under the condition it had', () => {
  const vis = (opts) => loadBar(opts).run('selVisibleActions(selBarContext()).map(a => a.id)');
  // A plain selection of three images, nothing special.
  assert.deepStrictEqual(vis({ faces: false, share: false, stags: false }), ['playnext', 'upnext', 'collect', 'studio', 'flag', 'trash', 'remove']);
  // Collection open: Remove from this collection, and Skip only with the skip feature's collection.
  assert.ok(vis({ inColl: [1, 2] }).includes('uncollect'));
  assert.ok(!vis({ inColl: [1, 2] }).includes('skip'), 'no Skip without a plain open collection');
  assert.ok(vis({ inColl: [1, 2], skip: { on: [] } }).includes('skip'));
  assert.ok(!vis({ inColl: [], skip: { on: [] } }).includes('skip'), 'none of the ticked files is in it');
  assert.ok(!vis({}).includes('uncollect'));
  // Trashed files: Restore; all trashed: no Trash.
  assert.deepStrictEqual(vis({ counts: { trashed: 1 } }).filter(x => x === 'trash' || x === 'restore'), ['restore', 'trash']);
  assert.deepStrictEqual(vis({ counts: { trashed: 3 } }).filter(x => x === 'trash' || x === 'restore'), ['restore']);
  // Share and Stream tag only while their features are on; Faces when ready and something can be checked.
  assert.ok(vis({ share: true }).includes('share'));
  assert.ok(!vis({ share: false }).includes('share'));
  assert.ok(!vis({ stags: false }).includes('streamtag'));
  assert.ok(!vis({ faces: true }).includes('faces'), 'nothing faceable');
  assert.ok(vis({ faces: true, counts: { faceable: 2 } }).includes('faces'));
  assert.ok(!vis({ faces: false, counts: { faceable: 2 } }).includes('faces'));
  // Videos: Music ID for any audio or video, Stack and Grid from two videos.
  assert.ok(vis({ counts: { av: 1, video: 1 } }).includes('musicid'));
  assert.ok(!vis({ counts: { av: 1, video: 1 } }).includes('stack'), 'one video: no Stack');
  assert.ok(vis({ counts: { av: 2, video: 2 } }).includes('stack') && vis({ counts: { av: 2, video: 2 } }).includes('grid'));
  // Errored files: Retry (errors and never scanned), Force refresh (errors only), Mark as playable.
  assert.ok(vis({ counts: { unscanned: 1 } }).includes('retry'));
  assert.ok(!vis({ counts: { unscanned: 1 } }).includes('refresh'));
  assert.ok(vis({ counts: { errored: 1 } }).includes('refresh'));
  assert.ok(vis({ counts: { failed: 1 } }).includes('playable'));
  assert.ok(!vis({}).includes('playable') && !vis({}).includes('retry'));
});

/* ── The bar ──────────────────────────────────────────────────────────── */

test('the bar: the count, the pinned actions that apply with short words, More and the X', () => {
  const b = loadBar({ inColl: [1, 2, 3], skip: { on: [] } });
  assert.deepStrictEqual(ids(b), ['playnext', 'collect', 'uncollect', 'skip', 'share', 'trash']);
  const words = b.bar.kids.filter(k => k.dataset.selAct).map(k => text(k.inner));
  assert.deepStrictEqual(words, ['Play next', 'Collect', 'Uncollect', 'Skip', 'Share', 'Trash']);
  assert.match(b.bar.innerHTML, /<span class="sel-count">3 selected<\/span>/);
  const more = b.bar.querySelector('[data-sel-more]');
  assert.strictEqual(text(more.inner), 'More');
  assert.strictEqual(more.getAttribute('aria-haspopup'), 'menu');
  assert.strictEqual(more.getAttribute('aria-expanded'), 'false');
  assert.ok(b.bar.querySelector('.sel-clear'), 'the X');
  // The tooltip says what the button does, once: no menu words in front of it.
  assert.strictEqual(btn(b, 'collect').attrs.title, 'Add the selected files to a collection');
  assert.strictEqual(btn(b, 'uncollect').attrs.title, 'Take 3 files out of this collection. The files themselves are not touched');
  assert.match(btn(b, 'share').attrs.title, /^Pack the selected files/);
  assert.strictEqual(btn(b, 'playnext').attrs.title, 'Play the selected files after the one playing now (Shift+U)');
  for (const k of b.bar.kids.filter(x => x.dataset.selAct)) assert.doesNotMatch(k.attrs.title, /—/, 'no em dashes');
  // The classes other code finds them by.
  assert.ok(btn(b, 'collect').classList.contains('sel-collect'));
  assert.ok(btn(b, 'trash').classList.contains('sel-trash'));
  // No collection open: Uncollect and Skip stay away; a collection with every ticked file skipped says Unskip.
  assert.deepStrictEqual(ids(loadBar()), ['playnext', 'collect', 'share', 'trash']);
  const un = loadBar({ inColl: [1, 2, 3], skip: { on: [1, 2, 3] } });
  assert.strictEqual(text(btn(un, 'skip').inner), 'Unskip');
  assert.ok(btn(un, 'skip').classList.contains('sel-skipped'));
  assert.match(btn(un, 'skip').attrs.title, /Play 3 files again/);
  // Trashed files: Restore takes Trash's place.
  assert.deepStrictEqual(ids(loadBar({ counts: { trashed: 3 } })), ['playnext', 'collect', 'share', 'restore']);
});

test('the bar: "(n)" only when an action acts on part of the selection', () => {
  const b = loadBar({ size: 3, counts: { trashed: 1 }, inColl: [1, 2] , skip: { on: [] } });
  const words = Object.fromEntries(b.bar.kids.filter(k => k.dataset.selAct).map(k => [k.dataset.selAct, text(k.inner)]));
  assert.strictEqual(words.trash, 'Trash (2)');
  assert.strictEqual(words.restore, 'Restore (1)');
  assert.strictEqual(words.uncollect, 'Uncollect (2)');
  assert.strictEqual(words.skip, 'Skip (2)');
  assert.strictEqual(words.collect, 'Collect');
  // Faces counts the photos and videos it can check, Stack the videos.
  const f = loadBar({ size: 5, counts: { faceable: 2, video: 3, av: 3 }, pins: ['faces', 'stack', 'musicid'] });
  assert.deepStrictEqual(f.bar.kids.filter(k => k.dataset.selAct).map(k => text(k.inner)), ['Stack (3)', 'Music ID (3)', 'Faces (2)']);
  assert.match(btn(f, 'stack').attrs.title, /Open 3 videos in the Editor, layered in sync$/);
});

test('the bar: emoji and words in Classic, line icons and words in Modern', () => {
  const m = loadBar({ modern: true, counts: { trashed: 0 } });
  for (const k of m.bar.kids.filter(x => x.dataset.selAct)) {
    assert.match(k.inner, /<svg class="vi /, `${k.dataset.selAct}: a line icon`);
    assert.ok(!/\p{Extended_Pictographic}/u.test(text(k.inner)), `${k.dataset.selAct}: no emoji in Modern`);
  }
  const c = loadBar({ modern: false });
  assert.strictEqual(classic(btn(c, 'collect').inner), '📁 Collect');
  assert.strictEqual(classic(btn(c, 'trash').inner), '🗑 Trash');
  assert.strictEqual(classic(btn(c, 'playnext').inner), '⤴ Play next');
  assert.ok(!read('selection.js').includes('sel-compact') && !fs.readFileSync(path.join(__dirname, '..', 'css', 'tiles.css'), 'utf8').includes('sel-compact'),
    'no icon-only compact bar any more');
});

test('a bar button runs its action; popover actions open on the button', () => {
  const b = loadBar({ inColl: [1], skip: { on: [] } });
  const click = (el) => b.bar.listeners.click.forEach(fn => fn({ target: el }));
  click(btn(b, 'playnext'));
  click(btn(b, 'collect'));
  click(btn(b, 'skip'));
  click(btn(b, 'trash'));
  assert.deepStrictEqual(b.calls.map(c => c[0]), ['upnext', 'collect', 'skip', 'trash']);
  assert.strictEqual(b.calls[0][1], 'next');
  assert.strictEqual(b.calls[1][1], btn(b, 'collect'), 'the picker opens on the Collect button');
  assert.strictEqual(b.calls[2][1], true, 'Skip, since not all are skipped');
});

/* ── Overflow ─────────────────────────────────────────────────────────── */

test('no room: pinned buttons move into More from the right; the words, More and the X stay', () => {
  const b = loadBar({ inColl: [1, 2, 3], skip: { on: [] }, room: 3 });
  assert.deepStrictEqual(ids(b), ['playnext', 'collect', 'uncollect']);
  assert.ok(b.bar.classList.contains('sel-overflow'));
  assert.ok(b.bar.querySelector('[data-sel-more]') && b.bar.querySelector('.sel-clear'));
  assert.ok(!b.bar.classList.contains('sel-compact'));
  for (const k of b.bar.kids.filter(x => x.dataset.selAct && !x.hidden)) assert.ok(text(k.inner).length > 2, 'words kept');
  // The hidden ones are in More, marked as pinned with no room.
  b.run('openSelMenu(0)');
  assert.match(b.menu().innerHTML, /data-sel-mi="skip"[\s\S]*?Pinned, no room/);
  assert.match(b.menu().innerHTML, /data-sel-mi="collect"[\s\S]*?On the bar/);
  // Room again: they come back.
  const wide = loadBar({ inColl: [1, 2, 3], skip: { on: [] } });
  assert.deepStrictEqual(ids(wide), ['playnext', 'collect', 'uncollect', 'skip', 'share', 'trash']);
  assert.ok(!wide.bar.classList.contains('sel-overflow'));
});

/* ── Pins ─────────────────────────────────────────────────────────────── */

test('pin and unpin, a default too; unknown ids ignored; back to the defaults', () => {
  const b = loadBar();
  b.run("selSetPinned('flag', true)");
  assert.deepStrictEqual(ids(b), ['playnext', 'collect', 'flag', 'share', 'trash']);
  b.run("selSetPinned('collect', false)");
  assert.deepStrictEqual(ids(b), ['playnext', 'flag', 'share', 'trash'], 'a default can come off');
  assert.deepStrictEqual([...b.ctx.__pins].sort(), ['flag', 'playnext', 'restore', 'share', 'skip', 'trash', 'uncollect'].sort());
  b.run("selSetPinned('nope', true)");
  assert.ok(!b.ctx.__pins.includes('nope'), 'no pin for an action that does not exist');
  // A stored list from another version: unknown ids do nothing, and are kept.
  const old = loadBar({ pins: ['later-action', 'remove', 'upnext'] });
  assert.deepStrictEqual(ids(old), ['upnext', 'remove']);
  old.run("selSetPinned('flag', true)");
  assert.deepStrictEqual([...old.ctx.__pins], ['later-action', 'remove', 'upnext', 'flag']);
  // An empty list: nothing pinned, More and the X still there.
  const none = loadBar({ pins: [] });
  assert.deepStrictEqual(ids(none), []);
  assert.ok(none.bar.querySelector('[data-sel-more]'));
  // A broken stored value: the defaults.
  assert.deepStrictEqual(ids(loadBar({ pins: 'garbage' })), ['playnext', 'collect', 'share', 'trash']);
  b.run('selResetPinned()');
  assert.strictEqual(b.ctx.__pins, null);
  assert.deepStrictEqual(ids(b), ['playnext', 'collect', 'share', 'trash']);
});

test('the pins live in vault_settings (settings.js), as a list of ids, null for the defaults', async () => {
  const store = {};
  const load = async () => {
    const el = () => ({ addEventListener: noop, appendChild: noop, prepend: noop, insertAdjacentHTML: noop, insertAdjacentElement: noop, setAttribute: noop, removeAttribute: noop, querySelector: () => el(), querySelectorAll: () => [], classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {} });
    const ctx = {
      console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol, Intl,
      setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: noop,
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
      localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: noop },
      sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
      location: { port: '8765', hostname: '127.0.0.1' },
      CustomEvent: class { constructor(type) { this.type = type; } },
      escapeHtml: (s) => String(s ?? ''),
      showToast: noop,
    };
    ctx.document = { readyState: 'complete', addEventListener: noop, body: el(), documentElement: el(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: el };
    ctx.window = ctx;
    ctx.addEventListener = noop;
    ctx.dispatchEvent = noop;
    vm.createContext(ctx);
    for (const f of ['icons.js', 'shortcuts.js', 'settings-kit.js', 'thumb-settings-ui.js', 'watchers-ui.js', 'scan-settings-ui.js', 'settings.js']) vm.runInContext(read(f), ctx);
    return ctx;
  };
  let s = await load();
  assert.strictEqual(s.vaultSelBarPinned(), null, 'the default set until a pin is changed');
  s.vaultSetSelBarPinned(['flag', 'flag', 'collect', 7, 'later-action']);
  assert.deepStrictEqual(JSON.parse(store.vault_settings).selBarPinned, ['flag', 'collect', 'later-action']);
  s = await load();
  assert.deepStrictEqual([...s.vaultSelBarPinned()], ['flag', 'collect', 'later-action'], 'kept across a reload');
  s.vaultSetSelBarPinned(null);
  assert.strictEqual(JSON.parse(store.vault_settings).selBarPinned, null);
});

/* ── More ─────────────────────────────────────────────────────────────── */

test('More lists every action that applies, in its groups in order, the pinned ones marked, with the keys', () => {
  const b = loadBar({ counts: { av: 3, video: 3, errored: 1, failed: 1, faceable: 3, trashed: 1 }, inColl: [1, 2, 3], skip: { on: [] } });
  b.run('openSelMenu(0)');
  const html = b.menu().innerHTML;
  const heads = [...html.matchAll(/class="sel-menu-head"[^>]*>([^<]+)</g)].map(m => m[1]);
  assert.deepStrictEqual(heads, ['Play', 'Collection', 'Label', 'Create', 'Library']);
  const rows = b.menu().kids.filter(k => k.dataset.selMi).map(k => k.dataset.selMi);
  assert.deepStrictEqual(rows, b.run('selVisibleActions(selBarContext()).map(a => a.id)'), 'the menu is the complete list');
  const words = Object.fromEntries(b.menu().kids.filter(k => k.dataset.selMi).map(k => [k.dataset.selMi, text(k.inner.replace(/<span class="sel-mi-note[\s\S]*?<\/span>|<kbd[\s\S]*?<\/kbd>/g, ''))]));
  assert.deepStrictEqual(words, {
    playnext: 'Play next', upnext: 'Add to Up next',
    collect: 'Add to a collection', uncollect: 'Remove from this collection', skip: 'Skip in this collection',
    studio: 'Studio', streamtag: 'Stream tag', flag: 'Flag',
    stack: 'Stack in the Editor', grid: 'Grid in the Editor', musicid: 'Music ID', share: 'Share privately',
    retry: 'Retry errors (1)', refresh: 'Force refresh (1)', playable: 'Mark as playable (1)', faces: 'Find faces', restore: 'Restore (1)',
    trash: 'Trash (2)', remove: 'Remove from library',
  });
  // Trash and Remove from library at the bottom, set apart.
  assert.match(html, /class="sel-menu-foot">[\s\S]*data-sel-mi="trash"[\s\S]*data-sel-mi="remove"[\s\S]*Back to the default buttons/);
  assert.match(html, /sel-mrow sel-mrow-danger[\s\S]*data-sel-mi="trash"/);
  // Pinned and on the bar: marked; the key hints.
  assert.match(row(b, 'playnext').inner, /On the bar[\s\S]*<kbd class="sel-mi-kbd">Shift\+U<\/kbd>/);
  assert.match(row(b, 'upnext').inner, /<kbd class="sel-mi-kbd">U<\/kbd>/);
  assert.doesNotMatch(row(b, 'upnext').inner, /On the bar/);
  assert.strictEqual(pin(b, 'collect').getAttribute('aria-checked'), 'true');
  assert.strictEqual(pin(b, 'collect').getAttribute('aria-label'), 'Take Add to a collection off the bar');
  assert.strictEqual(pin(b, 'flag').getAttribute('aria-label'), 'Put Flag on the bar');
  assert.strictEqual(pin(b, 'flag').getAttribute('role'), 'menuitemcheckbox');
  assert.match(pin(b, 'flag').inner, /vi-pin/, 'a pin, not a star');
  // No file names in it: only the actions' words and counts.
  assert.doesNotMatch(html, /\.mp4|\.jpg|filename/i);
  // More says it is open; the hover popover went.
  assert.strictEqual(b.bar.querySelector('[data-sel-more]').getAttribute('aria-expanded'), 'true');
  assert.ok(b.calls.some(c => c[0] === 'hidePopover'));
});

test('More: a row runs its action and closes; a pin changes the bar and leaves the menu open', () => {
  const b = loadBar();
  b.run('openSelMenu(0)');
  const m = b.menu();
  m.listeners.click.forEach(fn => fn({ target: pin(b, 'flag') }));
  assert.strictEqual(b.calls.filter(c => c[0] === 'flag').length, 0, 'a pin does not run the action');
  assert.ok(b.run('selMenuOpen()'), 'still open');
  assert.deepStrictEqual(ids(b), ['playnext', 'collect', 'flag', 'share', 'trash']);
  assert.strictEqual(pin(b, 'flag').getAttribute('aria-checked'), 'true');
  // A default unpinned from the menu.
  m.listeners.click.forEach(fn => fn({ target: pin(b, 'trash') }));
  assert.deepStrictEqual(ids(b), ['playnext', 'collect', 'flag', 'share']);
  // Back to the default buttons, still open.
  m.listeners.click.forEach(fn => fn({ target: m.querySelector('[data-sel-reset]') }));
  assert.deepStrictEqual(ids(b), ['playnext', 'collect', 'share', 'trash']);
  assert.ok(b.run('selMenuOpen()'));
  // A row: runs and closes, focus back on More.
  m.listeners.click.forEach(fn => fn({ target: row(b, 'flag') }));
  assert.deepStrictEqual(b.calls.filter(c => c[0] === 'flag').map(c => [...c]), [['flag', 1]]);
  assert.ok(!b.run('selMenuOpen()'));
  assert.ok(!m.isConnected);
  assert.strictEqual(b.ctx.document.activeElement, b.bar.querySelector('[data-sel-more]'));
  assert.strictEqual(b.bar.querySelector('[data-sel-more]').getAttribute('aria-expanded'), 'false');
});

test('More: the collection picker, the studio picker and the stream tag menu open on the More button', () => {
  for (const id of ['collect', 'studio', 'streamtag']) {
    const b = loadBar();
    b.run('openSelMenu(0)');
    b.menu().listeners.click.forEach(fn => fn({ target: row(b, id) }));
    const call = b.calls.find(c => c[0] === id);
    assert.ok(call, `${id} ran`);
    assert.strictEqual(call[1], b.bar.querySelector('[data-sel-more]'), `${id}: anchored to More, inside the bar`);
    assert.ok(!b.run('selMenuOpen()'));
  }
});

test('Force refresh runs once at a time, from the bar or from More; both show it is busy', async () => {
  const b = loadBar({ counts: { errored: 2 }, pins: ['refresh'] });
  b.run(`
    forceRefreshSelected = __realRefresh;
    var __answer = null;
    window.vaultForceRefresh = (ids, btn, o) => { __calls.push(['vfr', ids.length, btn, o.onlyErrored]); return new Promise(r => { __answer = r; }); };
  `);
  const click = (el) => b.bar.listeners.click.forEach(fn => fn({ target: el }));
  // From More first: no button of its own, the guard still holds.
  b.run('openSelMenu(0)');
  b.menu().listeners.click.forEach(fn => fn({ target: row(b, 'refresh') }));
  assert.deepStrictEqual(b.calls.filter(c => c[0] === 'vfr').map(c => [...c]), [['vfr', 3, null, true]]);
  // Busy: the bar button is off, and the row in a menu opened now is too.
  assert.ok('disabled' in btn(b, 'refresh').attrs, 'the bar button is disabled');
  assert.strictEqual(btn(b, 'refresh').getAttribute('aria-busy'), 'true');
  b.run('openSelMenu(0)');
  assert.strictEqual(row(b, 'refresh').getAttribute('aria-disabled'), 'true');
  // A second press, from the row or the bar (the code path, as a disabled button sends no click): nothing.
  b.menu().listeners.click.forEach(fn => fn({ target: row(b, 'refresh') }));
  assert.ok(b.run('selMenuOpen()'), 'a busy row does nothing, the menu stays');
  b.run("selRunAction('refresh', null)");
  click(btn(b, 'refresh'));
  assert.strictEqual(b.calls.filter(c => c[0] === 'vfr').length, 1, 'one request until the first answers');
  // It answers: back on, and a new run can start.
  b.run('__answer(null)');
  await new Promise(r => setImmediate(r));
  assert.ok(!('disabled' in btn(b, 'refresh').attrs));
  assert.strictEqual(row(b, 'refresh').getAttribute('aria-disabled'), null);
  b.run("selRunAction('refresh', null)");
  assert.strictEqual(b.calls.filter(c => c[0] === 'vfr').length, 2);
  // A request that throws frees it too.
  let caught = null;
  b.ctx.__done = (p) => p.catch((e) => { caught = e; });
  b.run('__answer(null)');
  await new Promise(r => setImmediate(r));
  b.run("window.vaultForceRefresh = () => Promise.reject(new Error('down')); __done(forceRefreshSelected())");
  await new Promise(r => setImmediate(r));
  assert.ok(caught, 'the error is the caller\'s');
  assert.ok(!('disabled' in btn(b, 'refresh').attrs), 'back on after a failure');
});

test('the other actions never needed their element: only the popovers get one, as an anchor', () => {
  const b = loadBar();
  const src = b.run("SEL_ACTIONS.filter(a => /\\(c, el\\)|\\(_, el\\)/.test(String(a.run))).map(a => a.id)");
  assert.deepStrictEqual(src, ['collect', 'studio', 'streamtag']);
});

test('More: a picker that takes no focus itself (the collection picker) gets it, Esc still goes back to More', () => {
  const b = loadBar();
  const input = { focus() { b.ctx.document.activeElement = input; } };
  b.ctx.__byId.collectionPicker = { querySelector: () => input };
  b.run('openSelMenu(0)');
  b.menu().listeners.click.forEach(fn => fn({ target: row(b, 'collect') }));
  assert.strictEqual(b.ctx.document.activeElement, input, 'the picker\'s find box');
  // No picker to focus: More, not the page.
  const n = loadBar();
  n.run('openSelMenu(0)');
  n.menu().listeners.click.forEach(fn => fn({ target: row(n, 'collect') }));
  assert.strictEqual(n.ctx.document.activeElement, n.bar.querySelector('[data-sel-more]'));
  // A picker that focused itself keeps it (the studio picker's box).
  const s = loadBar();
  const own = { isConnected: true };
  s.run('studiosSelectionPick = () => { document.activeElement = __own; }');
  s.ctx.__own = own;
  s.run('openSelMenu(0)');
  s.menu().listeners.click.forEach(fn => fn({ target: row(s, 'studio') }));
  assert.strictEqual(s.ctx.document.activeElement, own);
  // Esc in the collection picker goes back to its anchor (collections.js _pickerEsc), which is More.
  assert.match(read('collections.js'), /_pickerAnchor && _pickerAnchor\.isConnected && _pickerAnchor/);
});

test('More: a picker opened from it is closed with the bar even after the bar repaints', () => {
  // Open More, pin something (the bar repaints with the menu open), open the
  // Studio picker from its row, repaint again, then clear from code.
  const b = loadBar();
  const pop = { isConnected: true };
  b.ctx.__pop = pop;
  b.run(`
    studiosSelectionPick = (el) => { el.classList.add('on'); __byId.stPop = __pop; };
    var stClosePops = () => { if (__byId.stPop) { __byId.stPop.isConnected = false; __byId.stPop = null; } };
    var clearSelection2 = () => { selectedIds.clear(); renderSelectionBar(); };
  `);
  b.run('openSelMenu(0)');
  b.menu().listeners.click.forEach(fn => fn({ target: pin(b, 'flag') }));
  // The bar was rewritten (a new button on it); the new More still says the menu is open.
  assert.strictEqual(b.bar.querySelector('[data-sel-more]').getAttribute('aria-expanded'), 'true');
  // A repaint that changes nothing keeps the same More button.
  const more = b.bar.querySelector('[data-sel-more]');
  b.run('renderSelectionBar()');
  assert.strictEqual(b.bar.querySelector('[data-sel-more]'), more);
  b.menu().listeners.click.forEach(fn => fn({ target: row(b, 'studio') }));
  assert.ok(pop.isConnected);
  b.ctx.__counts.flagged = 3;   // the bar's markup changes: a repaint
  b.run('renderSelectionBar()');
  assert.strictEqual(b.bar.querySelector('[data-sel-more]').getAttribute('aria-expanded'), 'false');
  b.run('clearSelection2()');
  assert.ok(!pop.isConnected, 'the studio picker went with the bar');
  // A studio picker the bar did not open stays.
  const o = loadBar();
  const other = { isConnected: true };
  o.ctx.__byId.stPop = other;
  o.run('var stClosePops = () => { __byId.stPop.isConnected = false; }; selectedIds.clear(); renderSelectionBar()');
  assert.ok(other.isConnected, 'not the bar\'s: left alone');
  // The collection picker and the stream tag menu: closed when the bar hides.
  const c = loadBar();
  c.run('var __closed = []; var closeBarCollectionPicker = () => __closed.push("coll"); StreamTags.closeMenu = () => __closed.push("stags"); selectedIds.clear(); renderSelectionBar()');
  assert.deepStrictEqual([...c.ctx.__closed], ['coll', 'stags']);
});

test('More: Esc closes it wherever the focus is; a press on a heading keeps the focus; no key listener while closed', () => {
  const b = loadBar();
  const doc = b.ctx.document;
  assert.strictEqual((b.docListeners.keydown || []).length, 0, 'nothing listens while the menu is closed');
  b.run('openSelMenu(0)');
  const m = b.menu();
  assert.strictEqual(m.tabIndex, -1);
  assert.strictEqual(b.docListeners.keydown.length, 1);
  const docKey = (k) => { let stopped = false; b.docListeners.keydown.forEach(fn => fn({ key: k, preventDefault: noop, stopPropagation: () => { stopped = true; } })); return stopped; };
  // A press on a heading or the padding: the browser would move the focus; the menu stops it.
  let prevented = false;
  m.listeners.mousedown.forEach(fn => fn({ target: { closest: () => null }, preventDefault: () => { prevented = true; } }));
  assert.ok(prevented, 'no focus change on a non-button');
  prevented = false;
  m.listeners.mousedown.forEach(fn => fn({ target: row(b, 'flag'), preventDefault: () => { prevented = true; } }));
  assert.ok(!prevented, 'a row press is the browser\'s own');
  // The focus went to the page anyway: the arrows bring it back to the last row.
  const rows = m.querySelectorAll('.sel-mi, .sel-menu-reset');
  m.listeners.focusin.forEach(fn => fn({ target: rows[2] }));
  doc.activeElement = doc.body;
  assert.ok(docKey('ArrowDown'));
  assert.strictEqual(doc.activeElement, rows[2]);
  // On a row, the arrows are the menu's own (not handled twice).
  assert.ok(!docKey('ArrowDown'));
  // Esc from the page closes it, back to More, and the key listener goes.
  doc.activeElement = doc.body;
  assert.ok(docKey('Escape'));
  assert.ok(!b.run('selMenuOpen()'));
  assert.strictEqual(doc.activeElement, b.bar.querySelector('[data-sel-more]'));
  assert.strictEqual(b.docListeners.keydown.length, 0);
});

test('More: rows carry no tooltip (their words say it), the names stay', () => {
  const b = loadBar({ counts: { errored: 1 } });
  b.run('openSelMenu(0)');
  for (const k of b.menu().kids.filter(x => x.dataset.selMi)) {
    assert.ok(!('title' in k.attrs), `${k.dataset.selMi}: no title`);
    assert.ok(text(k.inner).length > 2, 'its words are its name');
  }
  // The pins keep their names.
  assert.match(pin(b, 'flag').getAttribute('aria-label'), /^Put Flag on the bar$/);
});

test('More: arrow keys, Home / End, Left / Right to the pin, Esc back to More', () => {
  const b = loadBar();
  b.run('openSelMenu(0)');
  const m = b.menu();
  const doc = b.ctx.document;
  const key = (k) => { let stopped = false; m.listeners.keydown.forEach(fn => fn({ key: k, preventDefault: noop, stopPropagation: () => { stopped = true; } })); return stopped; };
  const rows = m.querySelectorAll('.sel-mi, .sel-menu-reset');
  assert.strictEqual(doc.activeElement, rows[0], 'opens on the first row');
  key('ArrowDown');
  assert.strictEqual(doc.activeElement, rows[1]);
  key('ArrowUp'); key('ArrowUp');
  assert.strictEqual(doc.activeElement, rows[rows.length - 1], 'wraps to the last (Back to the default buttons)');
  key('Home');
  assert.strictEqual(doc.activeElement, rows[0]);
  key('ArrowRight');
  assert.ok(doc.activeElement.classList.contains('sel-pin'), 'Right: the row\'s pin');
  key('ArrowDown');
  assert.strictEqual(doc.activeElement, pin(b, rows[1].dataset.selMi), 'down the pins');
  key('ArrowLeft');
  assert.strictEqual(doc.activeElement, rows[1]);
  key('End');
  assert.strictEqual(doc.activeElement, rows[rows.length - 1]);
  assert.strictEqual(key('Escape'), true, 'Esc stops there');
  assert.ok(!b.run('selMenuOpen()'));
  assert.strictEqual(doc.activeElement, b.bar.querySelector('[data-sel-more]'));
  // Up on More opens it at the last row.
  b.bar.listeners.keydown.forEach(fn => fn({ key: 'ArrowUp', target: b.bar.querySelector('[data-sel-more]'), preventDefault: noop }));
  assert.ok(b.run('selMenuOpen()'));
  const rows2 = b.menu().querySelectorAll('.sel-mi, .sel-menu-reset');
  assert.strictEqual(doc.activeElement, rows2[rows2.length - 1]);
});

test('More closes on a click outside, on the More button again, and when the selection empties; it follows a change', () => {
  const b = loadBar();
  b.run('openSelMenu(0)');
  const outside = { closest: () => null };
  b.docListeners.pointerdown.forEach(fn => fn({ target: outside }));
  assert.ok(!b.run('selMenuOpen()'), 'a click outside');
  b.run('toggleSelMenu()');
  assert.ok(b.run('selMenuOpen()'));
  b.run('toggleSelMenu()');
  assert.ok(!b.run('selMenuOpen()'), 'More again');
  b.run('openSelMenu(0)');
  // The selection changes: the menu draws the new state (all flagged now: Unflag).
  b.ctx.__counts.flagged = 3;
  b.run('renderSelectionBar()');
  assert.ok(b.run('selMenuOpen()'));
  assert.match(row(b, 'flag').inner, /Unflag/);
  b.run('selectedIds.clear(); renderSelectionBar()');
  assert.ok(!b.run('selMenuOpen()'), 'nothing selected: closed');
  assert.ok(!b.bar.classList.contains('visible'));
});

test('the bar hides while the full player is open, and on tabs without a library grid, as before', () => {
  const b = loadBar();
  assert.ok(b.bar.classList.contains('visible'));
  b.ctx.document.getElementById = ((get) => (id) => (id === 'mediaPlayerOverlay' ? { classList: { contains: (c) => c === 'active' } } : get(id)))(b.ctx.document.getElementById);
  b.run('renderSelectionBar()');
  assert.ok(!b.bar.classList.contains('visible'));
  const t = loadBar();
  t.run("var currentTab = 'editor'; renderSelectionBar()");
  assert.ok(!t.bar.classList.contains('visible'));
});

test('a tick still closes the hover popover (selectionChanged)', () => {
  const b = loadBar();
  b.calls.length = 0;
  b.run('selectionChanged()');
  assert.deepStrictEqual(b.calls.map(c => [...c]), [['hidePopover']]);
});
