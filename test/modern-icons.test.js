/**
 * The Modern look's line icons (player-lib/icons.js), run in a VM: the icon
 * helper's markup, the Classic / Modern swap (emoji and icon side by side,
 * the look picks one), the header tabs in db-viewer.html (no emoji left in
 * what Modern shows, every icon-only tab keeps its name), and toasts losing
 * their leading emoji in Modern only.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'player-lib');
const noop = () => {};

function load(files, { modern = false, extra = {} } = {}) {
  const toast = { textContent: '', classList: { add: noop, remove: noop } };
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, setTimeout: noop, clearTimeout: noop,
    document: {
      addEventListener: noop,
      getElementById: (id) => (id === 'toast' ? toast : null),
      querySelector: () => null,
    },
    TILE_TYPE_ICONS: { video: '🎬', image: '🖼️', gif: '🎞️', audio: '🎵', document: '📄', mix: '🎛' },
    ...extra,
  };
  ctx.window = ctx;
  ctx.isModernLayout = () => modern;
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), ctx);
  // Top-level consts live in the context's script scope, not on its global.
  ctx.VAULT_ICONS = vm.runInContext('typeof VAULT_ICONS === "undefined" ? undefined : VAULT_ICONS', ctx);
  ctx.__toast = toast;
  return ctx;
}

const EMOJI = /\p{Extended_Pictographic}/u;
/** What Modern shows of some swapped markup: the Classic-only spans go. */
const modernText = (html) => html.replace(/<span class="vi-c">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');
/** What Classic shows: the Modern-only icons go. */
const classicText = (html) => html.replace(/<svg[^>]*modern-only[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');

const I = load(['icons.js']);

/* ── The icon helper ───────────────────────────────────────────────────── */

test('icon set: line icons, all well formed', () => {
  const names = Object.keys(I.VAULT_ICONS);
  assert.ok(names.length >= 28 && names.length <= 130, `${names.length} icons`);
  for (const n of names) {
    const svg = I.vaultIcon(n);
    assert.match(svg, /^<svg class="vi vi-[a-z-]+" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"/);
    assert.match(svg, /aria-hidden="true" focusable="false">/, `${n} is hidden from screen readers`);
    assert.ok(svg.endsWith('</svg>'));
    assert.ok(!EMOJI.test(svg), `${n}: no emoji`);
    // One weight for the whole set: no icon sets its own stroke width.
    assert.ok(!/stroke-width/.test(I.VAULT_ICONS[n]), `${n} keeps the set's stroke width`);
  }
});

test('icon helper: extra classes, unknown names give nothing', () => {
  assert.match(I.vaultIcon('gear', 'modern-only vi-gap'), /class="vi vi-gear modern-only vi-gap"/);
  assert.strictEqual(I.vaultIcon('nope'), '');
  assert.strictEqual(I.vaultIcon(''), '');
});

test('swap: Classic keeps the emoji, Modern shows the icon, words keep their gap', () => {
  const html = I.vaultIconSwap('📚 ', 'library');
  assert.match(html, /^<span class="vi-c">📚 <\/span><svg class="vi vi-library modern-only vi-gap"/);
  assert.strictEqual(classicText(html), '📚 ');
  assert.strictEqual(modernText(html), '');
  // An icon on its own (a button with a title) gets no gap.
  assert.match(I.vaultIconSwap('🚩', 'flag'), /class="vi vi-flag modern-only"/);
  // Escaped, and an unknown icon falls back to the plain emoji.
  assert.strictEqual(I.vaultIconSwap('<b>', 'nope'), '&lt;b&gt;');
  assert.match(I.vaultIconSwap('a&b', 'flag'), /<span class="vi-c">a&amp;b<\/span>/);
});

test('type icons: each file type has its own, anything else is a folder', () => {
  const seen = new Set();
  for (const type of ['video', 'image', 'gif', 'audio', 'document', 'mix']) {
    const html = I.vaultTypeIcon(type);
    assert.strictEqual(classicText(html), I.TILE_TYPE_ICONS[type], `${type}: Classic emoji unchanged`);
    const name = html.match(/class="vi vi-([a-z]+)/)[1];
    assert.ok(!seen.has(name), `${type} has its own icon`);
    seen.add(name);
  }
  assert.match(I.vaultTypeIcon('3d'), /vi-folder/);
  assert.strictEqual(classicText(I.vaultTypeIcon('3d')), '📁');
});

test('static markup: data-vi spots are filled once, the emoji kept for Classic', () => {
  const el = {
    textContent: '🔄 ', innerHTML: '', attrs: { 'data-vi': 'refresh' },
    getAttribute(n) { return this.attrs[n] ?? null; },
    setAttribute(n, v) { this.attrs[n] = v; },
  };
  let calls = 0;
  const root = { querySelectorAll: () => { calls++; return 'data-vi-done' in el.attrs ? [] : [el]; } };
  I.vaultIconsUpgrade(root);
  assert.match(el.innerHTML, /^<span class="vi-c">🔄 <\/span><svg class="vi vi-refresh modern-only vi-gap"/);
  assert.ok('data-vi-done' in el.attrs);
  const before = el.innerHTML;
  I.vaultIconsUpgrade(root);
  assert.strictEqual(el.innerHTML, before, 'a filled spot is left alone');
  assert.strictEqual(calls, 2);
});

/* ── The header tabs ───────────────────────────────────────────────────── */

const html = fs.readFileSync(path.join(ROOT, 'db-viewer.html'), 'utf8');
const tabs = [...html.matchAll(/<button class="app-tab[^"]*" data-tab="([a-z]+)"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)]
  .map(m => ({ tab: m[1], label: m[2], inner: m[3] }));

test('tabs: all six, each with a named line icon and its name for icon-only tabs', () => {
  assert.deepStrictEqual(tabs.map(t => t.tab), ['library', 'collections', 'faces', 'editor', 'games', 'wall']);
  for (const t of tabs) {
    const m = t.inner.match(/<span class="app-tab-ic" aria-hidden="true" data-vi="([a-z]+)">([^<]*)<\/span>/);
    assert.ok(m, `${t.tab}: icon spot`);
    assert.ok(I.VAULT_ICONS[m[1]], `${t.tab}: known icon ${m[1]}`);
    assert.ok(EMOJI.test(m[2]), `${t.tab}: Classic emoji still there`);
    // Folded tabs show the icon alone: header-fit.js puts aria-label in the tooltip.
    assert.ok(t.label.length > 2 && !EMOJI.test(t.label), `${t.tab}: aria-label is the name`);
  }
  assert.strictEqual(new Set(tabs.map(t => t.inner.match(/data-vi="([a-z]+)"/)[1])).size, 6, 'six different icons');
});

test('tabs: no emoji left in what Modern shows, and Classic is unchanged', () => {
  for (const t of tabs) {
    const [, name, emoji] = t.inner.match(/data-vi="([a-z]+)">([^<]*)</);
    const swapped = t.inner.replace(/(data-vi="[a-z]+">)[^<]*</, `$1${I.vaultIconSwap(emoji, name)}<`);
    const modern = modernText(swapped).trim();
    assert.ok(!EMOJI.test(modern), `${t.tab}: Modern shows "${modern}"`);
    assert.strictEqual(modern, t.label, `${t.tab}: Modern shows the name`);
    assert.strictEqual(classicText(swapped).trim(), `${emoji}${t.label}`.trim(), `${t.tab}: Classic as before`);
  }
});

test('other static controls: no emoji in Modern for the toolbar and header buttons', () => {
  for (const id of ['railToggleBtn', 'searchCollapseBtn', 'dockToggleBtn', 'hdrAddBtn', 'refreshBtn', 'favesFirstBtn']) {
    const m = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>([\\s\\S]*?)</button>`));
    assert.ok(m, id);
    const swapped = m[1].replace(/<span([^>]*) data-vi="([a-z]+)">([^<]*)<\/span>/g,
      (all, attrs, name, emoji) => `<span${attrs}>${I.vaultIconSwap(emoji, name)}</span>`);
    assert.ok(/data-vi="[a-z]+"/.test(m[1]), `${id}: has an icon spot`);
    assert.ok(!/[\p{Extended_Pictographic}▦☰▣＋▲▼]/u.test(modernText(swapped)), `${id}: ${modernText(swapped)}`);
  }
  for (const v of ['grid', 'table']) {
    const m = html.match(new RegExp(`data-view="${v}"[^>]*>([\\s\\S]*?)</button>`));
    assert.match(m[1], /data-vi="(grid|table)"/);
  }
});

/* ── Toasts ────────────────────────────────────────────────────────────── */

test('leading emoji: stripped once, stars and plain text left alone', () => {
  const s = I.vaultStripLeadingEmoji;
  assert.strictEqual(s('💾 Saved'), 'Saved');
  assert.strictEqual(s('⚠ Folder appears to be empty'), 'Folder appears to be empty');
  assert.strictEqual(s('⬆️ Level up! You are now: Fan'), 'Level up! You are now: Fan');
  assert.strictEqual(s('🔥 +5 pts'), '+5 pts');
  assert.strictEqual(s('↻ Rescan these'), 'Rescan these');
  assert.strictEqual(s('🏅 Achievement: 🎬 Binge'), 'Achievement: 🎬 Binge', 'only the leading one');
  assert.strictEqual(s('Library refreshed!'), 'Library refreshed!');
  assert.strictEqual(s('★ 3 stars'), '★ 3 stars');
  assert.strictEqual(s('🔥'), '🔥', 'nothing but an emoji: keep it');
  assert.strictEqual(s(''), '');
});

test('toasts: Modern drops the leading emoji, Classic keeps it (utils.js holds the only showToast)', () => {
  const m = load(['icons.js', 'utils.js'], { modern: true });
  m.showToast('💾 Saved');
  assert.strictEqual(m.__toast.textContent, 'Saved');
  const c = load(['icons.js', 'utils.js'], { modern: false });
  c.showToast('💾 Saved');
  assert.strictEqual(c.__toast.textContent, '💾 Saved');
  // One definition: app.js used to carry a second copy that replaced this one.
  for (const f of fs.readdirSync(LIB).filter(n => n.endsWith('.js') && n !== 'utils.js')) {
    assert.ok(!/^function showToast\(/m.test(fs.readFileSync(path.join(LIB, f), 'utf8')), `${f} defines no showToast`);
  }
});

test('page: icons.js loads right after utils.js, before anything that draws', () => {
  const scripts = [...html.matchAll(/<script src="\.\/player-lib\/([^"]+)"/g)].map(m => m[1]);
  const i = scripts.indexOf('icons.js');
  assert.strictEqual(scripts[i - 1], 'utils.js');
  for (const f of ['cards.js', 'dock.js', 'table-view.js', 'collections.js', 'wall.js', 'editor.js', 'settings.js', 'header-fit.js']) {
    assert.ok(scripts.indexOf(f) > i, `${f} after icons.js`);
  }
  assert.match(html, /<link rel="stylesheet" href="\.\/css\/icons\.css">/);
});

/* ── Emoji sequences, labels, the faves button ─────────────────────────── */

test('leading emoji: whole sequences go (skin tones, joins, flags, keycaps)', () => {
  const s = I.vaultStripLeadingEmoji;
  assert.strictEqual(s('👍🏽 nice'), 'nice');
  assert.strictEqual(s('👨‍👩‍👧 family'), 'family');
  assert.strictEqual(s('🏳️‍🌈 pride'), 'pride');
  assert.strictEqual(s('🇳🇱 Dutch'), 'Dutch');
  assert.strictEqual(s('1️⃣ first'), 'first');
  assert.strictEqual(s('1 file'), '1 file', 'a digit on its own is words');
  assert.strictEqual(s('⚙️ Options'), 'Options');
});

test('labels: Classic keeps the emoji, Modern shows the icon (or the words alone)', () => {
  const out = I.vaultEmojiLabel('💾 Saved mixes');
  assert.strictEqual(classicText(out), '💾 Saved mixes');
  assert.strictEqual(modernText(out), 'Saved mixes');
  assert.match(out, /vi-save modern-only vi-gap/);
  const plainLabel = I.vaultEmojiLabel('📖 Guides', { icon: false });
  assert.ok(!/<svg/.test(plainLabel), 'nav labels: words only');
  assert.strictEqual(modernText(plainLabel), 'Guides');
  assert.strictEqual(I.vaultEmojiLabel('Plain words'), 'Plain words');
  assert.strictEqual(modernText(I.vaultEmojiLabel('🧩')), '', 'an icon-only label');
  assert.match(I.vaultEmojiLabel('🧩'), /vi-puzzle modern-only"/);
  assert.strictEqual(modernText(I.vaultEmojiLabel('👍🏽 Thanks')), 'Thanks', 'the whole sequence is Classic only');
  for (const name of Object.values(vm.runInContext('VAULT_EMOJI_ICONS', I))) assert.ok(I.VAULT_ICONS[name], `icon ${name} exists`);
  // Every emoji in the map is one the label helper can find at the start of a label.
  const lead = vm.runInContext('VAULT_ONE_LEADING_EMOJI', I);
  for (const e of Object.keys(vm.runInContext('VAULT_EMOJI_ICONS', I))) assert.ok(lead.test(`${e} words`), `${e} is found as a leading emoji`);
  assert.match(I.vaultEmojiLabel('⚠ Could not save'), /vi-alert modern-only vi-gap/);
});

test('faves first: aria-pressed follows the toggle, in both looks', () => {
  assert.match(html, /id="favesFirstBtn"[^>]*aria-pressed="false"/);
  const src = fs.readFileSync(path.join(LIB, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
  const fn = src.match(/function syncSortControls\(\) \{[\s\S]*?\n\}\n/)[0];
  for (const modern of [false, true]) {
    const attrs = {}, classes = new Set();
    const fav = {
      innerHTML: '', setAttribute: (k, v) => { attrs[k] = v; },
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    };
    const ctx = load(['icons.js'], { modern });
    ctx.document.getElementById = (id) => (id === 'favesFirstBtn' ? fav : null);
    vm.runInContext(`let currentSort = 'processed_desc'; let favesFirst = false;
      function currentSortField() { return currentSort.split('_')[0]; }
      function currentSortDir() { return currentSort.split('_')[1] || 'desc'; }
      ${fn}`, ctx);
    vm.runInContext('syncSortControls()', ctx);
    assert.strictEqual(attrs['aria-pressed'], 'false');
    vm.runInContext('favesFirst = true; syncSortControls()', ctx);
    assert.strictEqual(attrs['aria-pressed'], 'true');
    assert.ok(classes.has('active'));
    assert.strictEqual((modern ? modernText : classicText)(fav.innerHTML), modern ? '' : '❤');
  }
});

/* ── Modern: no emoji in the Settings menu, Editor, Games, selection bar ── */

const MODERN_EMOJI = /[\p{Extended_Pictographic}▤▦＋⬅⬆⬇]/u;
const visibleModern = (h) => modernText(h.replace(/<option[\s\S]*?<\/option>/g, '')).replace(/\s+/g, ' ').trim();

test('Settings menu: every page name is plain words in Modern, Classic keeps its emoji', () => {
  const src = fs.readFileSync(path.join(LIB, 'settings.js'), 'utf8').replace(/\r\n/g, '\n');
  const block = src.match(/const SECTIONS = \[([\s\S]*?)\n {2}\];/)[1];
  const labels = [...block.matchAll(/^\s*\{ id: '[a-z]+',\s*label: '([^']+)' \}/gm)].map(m => m[1]);
  assert.ok(labels.length >= 9, `${labels.length} pages`);
  for (const l of labels) {
    const out = I.vaultEmojiLabel(l, { icon: false });
    assert.ok(!MODERN_EMOJI.test(modernText(out)), `${l}: ${modernText(out)}`);
    assert.strictEqual(classicText(out), l);
  }
  assert.match(src, /data-section="\$\{s\.id\}">\$\{navLabel\(s\.label\)\}<\/button>/);
  assert.match(src, /\$\{navLabel\('🌿 Support Vault'\)\}/);
});

function loadUi(files, modern, extra = {}) {
  const ctx = load(['icons.js'], { modern, extra: {
    escapeHtml: (x) => String(x ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    localStorage: { getItem: () => null, setItem: noop }, setInterval: () => 0, clearInterval: noop,
    Promise,
    ...extra,
  } });
  ctx.document.querySelectorAll = () => [];
  ctx.document.createElement = () => ({ classList: { add: noop, remove: noop }, appendChild: noop });
  ctx.window.addEventListener = noop;
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(LIB, f), 'utf8'), ctx);
  return ctx;
}

test('Editor: sub-tabs and the home page headings and buttons have no emoji in Modern', () => {
  for (const modern of [true, false]) {
    const root = { innerHTML: '', classList: { add: noop, remove: noop } };
    const ctx = loadUi(['pmv.js', 'editor.js'], modern);
    ctx.document.getElementById = (id) => (id === 'editorContainer' ? root : null);
    try { vm.runInContext('renderEditorHome()', ctx); } catch { /* the panels fill in from the server */ }
    const all = vm.runInContext("editorSubTabsHtml('mix')", ctx) + root.innerHTML;
    assert.match(all, /Saved mixes/);
    if (modern) assert.ok(!MODERN_EMOJI.test(visibleModern(all)), visibleModern(all));
    else assert.match(classicText(all), /🎛 Mix &amp; Match[\s\S]*💾 Saved mixes[\s\S]*📤 Exports/);
  }
});

test('Games: the home title, game rows and save cards have no emoji in Modern', async () => {
  const root = { innerHTML: '', classList: { add: noop, remove: noop } };
  const ctx = loadUi(['games/games.js'], true, { formatDuration: () => '1:00', getMediaById: () => ({ id: 1, filename: 'a.mp4' }) });
  ctx.document.getElementById = (id) => (id === 'gamesContainer' ? root : null);
  vm.runInContext(`gamesRegister('reelorder', { label: 'Reel Order', icon: '🎬', desc: 'Order the clips' });
    gamesRegister('framefit', { label: 'Frame Fit', icon: '🧩', desc: 'A jigsaw' });
    gamesState.savesLoaded = true;`, ctx);
  await vm.runInContext('renderGamesHome()', ctx);
  assert.match(root.innerHTML, /Reel Order[\s\S]*Frame Fit/);
  assert.ok(!MODERN_EMOJI.test(visibleModern(root.innerHTML)), visibleModern(root.innerHTML));
  const card = vm.runInContext(`renderSaveCard(GAMES.framefit, { save_id: 's1', media_id: 1, state: { elapsedMs: 60000 } })`, ctx);
  assert.ok(!MODERN_EMOJI.test(visibleModern(card)), visibleModern(card));
  assert.match(card, /aria-label="Delete this saved game"/);
});

test('selection bar: every button is words and a line icon in Modern', () => {
  const bar = { innerHTML: '', classList: { add: noop, remove: noop } };
  const ctx = loadUi(['selection.js'], true);
  ctx.document.getElementById = (id) => (id === 'selectionBar' ? bar : null);
  vm.runInContext(`selectedIds = new Set([1, 2, 3]);
    renderResultsSelect = () => {};
    selectionCounts = () => ({ count: 3, trashed: 1, av: 3, video: 3, flagged: 0, errored: 1, unscanned: 0, faceable: 0 });
    fingerprintSelected = () => {};`, ctx);
  vm.runInContext('renderSelectionBar()', ctx);
  assert.match(bar.innerHTML, /Collect[\s\S]*Forget/);
  const text = visibleModern(bar.innerHTML.replace(/>✕</g, '><'));
  assert.ok(!MODERN_EMOJI.test(text), text);
  for (const w of ['Music ID', 'Stack', 'Grid', 'Retry errors', 'Trash', 'Restore', 'Flag', 'Collect', 'Forget']) assert.match(text, new RegExp(w));
});
