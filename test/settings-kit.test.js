/**
 * The Settings building blocks and the Modern page map
 * (player-lib/settings-kit.js), run in a VM, and settings.js on top of them
 * in both looks: the row, card, fold and dialog markup; old page ids landing
 * on the new pages (and back); the Modern menu grouped with line icons; the
 * Modern pages built from cards, with no emoji in their names or buttons, no
 * Planned group, environment variables only inside Advanced folds; and the
 * Obsession Score switch worded the other way round without changing what
 * is stored.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const noop = () => {};
const read = (f) => fs.readFileSync(path.join(LIB, f), 'utf8');
const plain = (x) => JSON.parse(JSON.stringify(x));

function stubEl() {
  return {
    addEventListener: noop, appendChild: noop, prepend: noop, insertAdjacentHTML: noop,
    setAttribute: noop, removeAttribute: noop, querySelector: () => stubEl(), querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false }, style: {}, dataset: {},
  };
}

/** The kit alone (with the icons it draws with). */
function loadKit(modern = false) {
  const ctx = { console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp };
  ctx.window = ctx;
  ctx.isModernLayout = () => modern;
  vm.createContext(ctx);
  vm.runInContext(`${read('icons.js')}\n${read('settings-kit.js')}
    ;globalThis.__k = { settingsRowHtml, settingsCardHtml, settingsFoldHtml, settingsDialogHtml, settingsDialogOpenerAttrs,
      SETTINGS_PAGES_MODERN, SETTINGS_PAGE_IDS_MODERN, SETTINGS_PAGE_ALIASES, settingsResolvePage, settingsIsModern };`, ctx);
  return ctx.__k;
}

/** settings.js and the files whose pages it shows, in one look. */
function loadSettings(look, stored = {}) {
  const store = { vault_settings: JSON.stringify({ layoutStyle: look, ...stored }) };
  let shell = '';
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: noop,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { port: '8765', hostname: '127.0.0.1' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: noop,
  };
  ctx.document = {
    readyState: 'complete', addEventListener: noop,
    body: Object.assign(stubEl(), { appendChild: (el) => { shell = el.innerHTML || ''; } }),
    documentElement: stubEl(), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: stubEl,
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  ctx.dispatchEvent = noop;
  vm.createContext(ctx);
  for (const f of ['icons.js', 'shortcuts.js', 'settings-kit.js', 'thumb-settings-ui.js', 'watchers-ui.js', 'scan-settings-ui.js', 'settings.js', 'faces.js']) {
    vm.runInContext(read(f), ctx);
  }
  ctx.__shell = () => shell;
  return ctx;
}

/** What a page shows in Modern: Classic-only emoji spans and comments go. */
const shown = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<span class="vi-c">[\s\S]*?<\/span>/g, '');
const EMOJI = /\p{Extended_Pictographic}/u;

/* ── Building blocks ───────────────────────────────────────────────────── */

test('row: name and line on the left, the control on the right, one anchor', () => {
  const K = loadKit();
  const html = K.settingsRowHtml({ tag: 'label', sfind: 'resumePlayback', title: 'Continue where I left off',
    desc: 'Positions are always saved.', control: '<input type="checkbox">', cls: 'is-disabled' });
  assert.match(html, /^\s*<label class="settings-toggle is-disabled" data-sfind="resumePlayback">/);
  assert.match(html, /<span class="settings-toggle-text">\s*<span class="settings-toggle-title">Continue where I left off<\/span>\s*<span class="settings-toggle-desc">Positions are always saved.<\/span>\s*<\/span>\s*<input type="checkbox">\s*<\/label>$/);
  // No line, no class, no anchor: none of them are written.
  const bare = K.settingsRowHtml({ title: 'Name', control: '<b>x</b>' });
  assert.match(bare, /^\s*<div class="settings-toggle">/);
  assert.ok(!bare.includes('settings-toggle-desc') && !bare.includes('data-sfind'));
  // A title id for a group's aria-labelledby, and extra lines after the description.
  const seg = K.settingsRowHtml({ titleId: 'segLabel_x', title: 'T', desc: 'D', extra: '<span id="note"></span>' });
  assert.match(seg, /<span class="settings-toggle-title" id="segLabel_x">T<\/span>\s*<span class="settings-toggle-desc">D<\/span><span id="note"><\/span>/);
});

test('card, fold and dialog: heading, Advanced, and an opener the search can unfold', () => {
  const K = loadKit();
  const card = K.settingsCardHtml({ title: 'Look', body: '<p>x</p>', sfind: 'a', id: 'c1', hidden: true, cls: 'extra' });
  assert.match(card, /<section class="settings-card extra" id="c1" data-sfind="a" hidden>\s*<h3 class="settings-card-h">Look<\/h3>\s*<p>x<\/p>\s*<\/section>/);
  assert.ok(!K.settingsCardHtml({ body: 'x' }).includes('<h3'), 'no heading when there is no title');
  const fold = K.settingsFoldHtml({ body: '<p>env</p>' });
  assert.match(fold, /<details class="settings-fold">\s*<summary>Advanced<\/summary>\s*<div class="settings-fold-body"><p>env<\/p><\/div>\s*<\/details>/);
  const dlg = K.settingsDialogHtml({ id: 'migQuickDlg', title: 'Quick move', body: '<input id="f">', wide: true });
  assert.match(dlg, /<div class="settings-dlg-ov" id="migQuickDlg" hidden>/);
  assert.match(dlg, /<div class="settings-dlg is-wide" role="dialog" aria-modal="true" aria-labelledby="migQuickDlgTitle">/);
  assert.match(dlg, /<h3 class="settings-dlg-title" id="migQuickDlgTitle">Quick move<\/h3>/);
  assert.match(dlg, /data-dlg-close[^>]*aria-label="Close"><svg class="vi vi-close"/);
  // settings-search.js unfolds a hidden [id] through [aria-controls=id][aria-expanded=false].
  assert.strictEqual(K.settingsDialogOpenerAttrs('migQuickDlg'),
    ' data-dlg-open="migQuickDlg" aria-controls="migQuickDlg" aria-expanded="false" aria-haspopup="dialog"');
});

test('Modern menu: You, Library, AI, Help, each page with a line icon', () => {
  const K = loadKit();
  assert.deepStrictEqual(plain(K.SETTINGS_PAGES_MODERN.map(g => g.group)), ['You', 'Library', 'AI', 'Help']);
  assert.deepStrictEqual(plain(K.SETTINGS_PAGE_IDS_MODERN),
    ['general', 'privacy', 'shortcuts', 'library', 'faces', 'models', 'servers', 'seedpacks', 'guides', 'about']);
  const titles = K.SETTINGS_PAGES_MODERN.flatMap(g => g.pages.map(p => p.title));
  assert.deepStrictEqual(plain(titles), ['General', 'Privacy and security', 'Keyboard shortcuts', 'Library and files',
    'Face search', 'Models and scanning', 'AI servers', 'Seed packs', 'Guides', 'About']);
  const ctx = { console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('icons.js'), ctx);
  for (const g of K.SETTINGS_PAGES_MODERN) {
    for (const p of g.pages) assert.ok(vm.runInContext(`vaultIcon(${JSON.stringify(p.icon)})`, ctx), `${p.id}: icon ${p.icon}`);
  }
});

test('page map: old ids land on the new pages, and new ids on the old ones', () => {
  const K = loadKit();
  const classic = ['settings', 'library', 'faces', 'shortcuts', 'guides', 'models', 'seedpacks', 'backend', 'about'];
  const m = (id) => K.settingsResolvePage(id, 'modern', K.SETTINGS_PAGE_IDS_MODERN);
  const c = (id) => K.settingsResolvePage(id, 'classic', classic);
  assert.strictEqual(m('settings'), 'general');
  assert.strictEqual(m('backend'), 'servers');
  for (const id of ['library', 'faces', 'shortcuts', 'guides', 'models', 'seedpacks', 'about']) {
    assert.strictEqual(m(id), id, `${id} kept its id`);
    assert.strictEqual(c(id), id);
  }
  assert.strictEqual(c('general'), 'settings');
  assert.strictEqual(c('privacy'), 'settings');
  assert.strictEqual(c('servers'), 'backend');
  assert.strictEqual(m('cove'), null, 'a hidden page is no page');
  assert.strictEqual(m('nope'), null);
  assert.strictEqual(c('nope'), null);
  // Every id of either look finds a page in the other.
  for (const id of classic) assert.ok(m(id), `classic ${id} in Modern`);
  for (const id of K.SETTINGS_PAGE_IDS_MODERN) assert.ok(c(id), `modern ${id} in Classic`);
});

/* ── settings.js on top ────────────────────────────────────────────────── */

test('settings.js: each look lists its own pages, and any id renders its page', () => {
  const c = loadSettings('classic');
  const m = loadSettings('modern');
  assert.deepStrictEqual(plain(c.vaultSettingsPageIds()),
    ['settings', 'library', 'faces', 'shortcuts', 'guides', 'models', 'seedpacks', 'backend', 'about']);
  assert.deepStrictEqual(plain(m.vaultSettingsPageIds()),
    ['general', 'privacy', 'shortcuts', 'library', 'faces', 'models', 'servers', 'seedpacks', 'guides', 'about']);
  assert.strictEqual(m.vaultSettingsResolvePage('backend'), 'servers');
  assert.strictEqual(m.vaultSettingsResolvePage('settings'), 'general');
  assert.strictEqual(c.vaultSettingsResolvePage('servers'), 'backend');
  assert.strictEqual(m.vaultSettingsPageHtml('backend'), m.vaultSettingsPageHtml('servers'));
  assert.strictEqual(c.vaultSettingsPageHtml('privacy'), c.vaultSettingsPageHtml('settings'));
  assert.ok(c.vaultSettingsPageHtml('cove').includes('Move to Cove'), 'the hidden page still renders by its id');
});

test('menu: Classic keeps its flat list with emoji, Modern groups it with icons', () => {
  const c = loadSettings('classic').__shell();
  const m = loadSettings('modern').__shell();
  assert.match(c, /data-section="settings">.*Settings<\/button>/);
  assert.ok(!c.includes('settings-nav-group'));
  assert.ok(!c.includes('data-section="general"'));
  for (const g of ['You', 'Library', 'AI', 'Help']) assert.match(m, new RegExp(`<div class="settings-nav-group" aria-hidden="true">${g}</div>`));
  assert.match(m, /data-section="servers"><svg class="vi vi-plug settings-nav-ic"[^>]*>[\s\S]*?<\/svg><span>AI servers<\/span><\/button>/);
  assert.ok(!m.includes('data-section="backend"'));
});

test('Modern pages: cards with headings, no emoji in names or buttons, no Planned group', () => {
  const ctx = loadSettings('modern');
  for (const id of ctx.vaultSettingsPageIds()) {
    const html = ctx.vaultSettingsPageHtml(id);
    assert.match(html, /<section class="settings-card[^"]*"[^>]*>\s*<h3 class="settings-card-h">/, `${id}: built from cards`);
    assert.ok(!/class="settings-h[ "]/.test(html), `${id}: no Classic headings`);
    const names = [...shown(html).matchAll(/<(?:span class="settings-toggle-title"|h3[^>]*|button[^>]*|a [^>]*)>([\s\S]*?)<\/(?:span|h3|button|a)>/g)]
      .map(x => x[1].replace(/<[^>]+>/g, '').trim());
    for (const n of names) assert.ok(!EMOJI.test(n), `${id}: emoji in "${n}"`);
    assert.ok(!/[—]/.test(shown(html).replace(/<[^>]+>/g, '')), `${id}: no em dash`);
  }
  const general = ctx.vaultSettingsPageHtml('general');
  assert.ok(!/planned/i.test(general + ctx.vaultSettingsPageHtml('privacy')), 'no Planned group');
  assert.ok(!general.includes('data-sfind="cardSize"'), 'Card size is the Size slider in Modern');
  for (const h of ['Look', 'Playback', 'This copy of Vault']) assert.ok(general.includes(`<h3 class="settings-card-h">${h}</h3>`), h);
  // The Hold to unlock row stays commented out.
  assert.match(ctx.vaultSettingsPageHtml('privacy'), /<!-- "Hold to unlock" row removed deliberately/);
  assert.ok(!ctx.vaultSettingsPageHtml('privacy').includes('data-setting-num="unlockHoldSeconds"'));
});

test('Modern: environment variables and flags only inside Advanced folds', () => {
  const ctx = loadSettings('modern');
  const ENV = /SUB_ALLOW_DOWNLOADS|VAULT_OFFLINE|WHISPER_MODEL|VISION_WORKERS|LM_STUDIO_URLS|MEDIA_TAGGER_PORT|AI_MODEL|--no-gamify|SETUP\.md/;
  for (const id of ['general', 'privacy', 'models', 'servers', 'guides']) {
    // Tooltips may name a variable; what the page says may not.
    const html = ctx.vaultSettingsPageHtml(id).replace(/ title="[^"]*"/g, '');
    // Take out the folds and the guides' Advanced lines: nothing may be left.
    const outside = html.replace(/<details class="settings-fold"[\s\S]*?<\/details>/g, '')
      .replace(/<p class="settings-guide-adv">[\s\S]*?<\/p>/g, '');
    assert.ok(!ENV.test(outside), `${id}: ${(outside.match(ENV) || [])[0]} outside an Advanced fold`);
  }
  const guides = ctx.vaultSettingsPageHtml('guides');
  assert.match(guides, /<b>Advanced:<\/b> Start Vault with <code>--no-gamify<\/code>/);
  assert.match(guides, /turns any video into a jigsaw puzzle \(under 800 pieces\)/, 'typo fixed');
  assert.match(guides, /30 minutes unless you change it/, 'timeout typo fixed');
  const classicGuides = loadSettings('classic').vaultSettingsPageHtml('guides');
  assert.match(classicGuides, /turn any video into a jigsaw puzzle \(under 800 pieces\)/, 'Classic typo fixed');
  assert.match(classicGuides, /idle timeout \(default 30 min\)/, 'Classic timeout typo fixed');
  // A card per guide, each opening its own dialog, anchored like Classic's.
  for (const slug of ['ai-scanning', 'semantic-search', 'music-id', 'beat-bar', 'subtitles', 'games', 'obsession-score', 'encryption']) {
    assert.match(guides, new RegExp(`class="settings-guide" data-sfind="guide-${slug}" data-dlg-open="guideDlg-${slug}"`));
    assert.match(guides, new RegExp(`<div class="settings-dlg-ov" id="guideDlg-${slug}" hidden>`));
  }
});

test('Show the Obsession Score: worded the other way round, stored the same', () => {
  const hidden = loadSettings('modern', { gamifyHidden: true }).vaultSettingsPageHtml('general');
  const shownOn = loadSettings('modern', { gamifyHidden: false }).vaultSettingsPageHtml('general');
  const box = (h) => h.match(/<input type="checkbox" data-setting="gamifyHidden"[^>]*>/)[0];
  assert.match(box(hidden), /data-invert="1"/);
  assert.ok(!/checked/.test(box(hidden)), 'hidden: the Show switch is off');
  assert.match(box(shownOn), /checked/, 'shown: the Show switch is on');
  assert.match(shownOn, /Show the Obsession Score/);
  // Classic keeps its Hide wording and its plain switch.
  const classic = loadSettings('classic', { gamifyHidden: true }).vaultSettingsPageHtml('settings');
  assert.match(classic, /Hide 🏆 Obsession Score/);
  assert.ok(!box(classic).includes('data-invert'));
  assert.match(box(classic), /checked/);
  // The handler reads data-invert.
  assert.match(read('settings.js'), /settings\.gamifyHidden = input\.dataset\.invert \? !input\.checked : input\.checked;/);
});

test('Modern Library: watched folders, moves and guides open in dialogs with the same ids', () => {
  const lib = loadSettings('modern').vaultSettingsPageHtml('library');
  // The summary row and its dialog, holding the same group Classic shows inline.
  assert.match(lib, /id="wfManageBtn" data-dlg-open="wfDlg"/);
  assert.match(lib, /<div class="settings-dlg-ov" id="wfDlg" hidden>[\s\S]*id="wfGroup"/);
  // Quick move and Deep search: Classic's forms, each in a dialog.
  assert.match(lib, /data-dlg-open="migQuickDlg"[^>]*>Quick move<\/button>/);
  assert.match(lib, /data-dlg-open="migDeepDlg"[^>]*>Deep search<\/button>/);
  assert.match(lib, /id="migQuickDlg" hidden>[\s\S]*data-mig-mode="prefix"[\s\S]*id="migOldPrefix"/);
  assert.match(lib, /id="migDeepDlg" hidden>[\s\S]*data-mig-mode="auto"[\s\S]*id="migNewRoot"/);
  assert.ok(!lib.includes('migDeepToggle'), 'no expander in Modern');
  // The other wiring ids are all there.
  for (const id of ['thGroup', 'pbCard', 'pbCheckBtn', 'pbResult', 'settingsDbFile', 'migRowNote']) assert.ok(lib.includes(`id="${id}"`), id);
  // Classic is as it was: inline forms, the expander, no dialogs.
  const c = loadSettings('classic').vaultSettingsPageHtml('library');
  assert.ok(c.includes('id="migDeepToggle"') && !c.includes('settings-dlg-ov'));
});
