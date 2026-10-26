/**
 * Settings search (player-lib/settings-search.js), run in a VM: the index is
 * well formed and every anchor in it is on the page it names (each Settings
 * page rendered by settings.js, with the Thumbnails and Scanning groups, Face search and
 * Keyboard shortcuts pages from their own files, in both looks); matching
 * covers names, descriptions and extra words, results group by page with the
 * best first and the matched words marked; keyboard shortcuts come from
 * shortcuts.js and jump to their own row. Modern has its own pages
 * (settings-kit.js): every entry is found on its Modern page too.
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
    addEventListener: noop, appendChild: noop, prepend: noop, insertAdjacentHTML: noop, insertAdjacentElement: noop,
    setAttribute: noop, removeAttribute: noop, querySelector: () => null, querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {},
  };
}

/** The search alone, with the shortcuts table. */
function loadSearch() {
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp,
    window: { addEventListener: noop },
    document: { addEventListener: noop, getElementById: () => null, querySelector: () => null },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('shortcuts.js')}\n${read('settings-kit.js')}\n${read('settings-search.js')}
    ;globalThis.__s = { SETTINGS_INDEX, SETTINGS_SEARCH_PAGES, SHORTCUTS, settingsSearch, settingsSearchMark,
      settingsSearchResultsHtml, settingsSearchScore, SETTINGS_SEARCH_SHORTCUT_LIMIT,
      settingsSearchFocusTarget, settingsSearchTarget, SETTINGS_SEARCH_FIELD,
      settingsSearchPages, settingsSearchPageOf, SETTINGS_PAGE_IDS_MODERN };`, ctx);
  return ctx.__s;
}

/** settings.js and the files whose pages it shows, for rendering each page. */
function loadSettings(look) {
  const store = { vault_settings: JSON.stringify({ layoutStyle: look }) };
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    requestAnimationFrame: noop,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { port: '8765', hostname: '127.0.0.1' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    document: {
      readyState: 'loading', addEventListener: noop, body: stubEl(), documentElement: stubEl(),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: stubEl,
    },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: noop,
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  ctx.dispatchEvent = noop;
  vm.createContext(ctx);
  for (const f of ['shortcuts.js', 'settings-kit.js', 'thumb-settings-ui.js', 'watchers-ui.js', 'scan-settings-ui.js', 'stage-settings-ui.js', 'settings.js', 'faces.js']) vm.runInContext(read(f), ctx);
  return ctx;
}

const S = loadSearch();
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'db-viewer.html'), 'utf8');
// Arrays made in the VM have its prototypes: plain() before deepStrictEqual.
const pages = (groups) => plain(groups.map(g => g.page));
const ids = (group) => plain(group.items.map(i => i.item.id));

/* ── The index ─────────────────────────────────────────────────────────── */

test('index: one entry per anchor, known pages, plain words', () => {
  const pageIds = S.SETTINGS_SEARCH_PAGES.map(p => p.id);
  const seen = new Set();
  for (const e of S.SETTINGS_INDEX) {
    const key = `${e.page}|${e.id}`;
    assert.ok(!seen.has(key), `${key} listed twice`);
    seen.add(key);
    assert.ok(pageIds.includes(e.page), `${key}: unknown page`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(e.id), `${key}: anchor is a plain name`);
    assert.ok(typeof e.label === 'string' && e.label.length > 2, `${key}: a name`);
    assert.ok(typeof e.desc === 'string' && e.desc.length > 10, `${key}: a description`);
    assert.ok(Array.isArray(e.keywords) && e.keywords.every(k => typeof k === 'string' && k === k.toLowerCase()), `${key}: keywords`);
    assert.ok(e.look === undefined || e.look === 'modern' || e.look === 'classic', `${key}: look`);
    assert.ok(e.mpage === undefined || S.SETTINGS_PAGE_IDS_MODERN.includes(e.mpage), `${key}: unknown Modern page`);
    for (const text of [e.label, e.desc, ...e.keywords]) assert.ok(!/[–—]/.test(text), `${key}: no dashes in "${text}"`);
  }
  for (const look of ['classic', 'modern']) {
    for (const p of S.settingsSearchPages(look)) {
      assert.ok(S.SETTINGS_INDEX.some(e => (!e.look || e.look === look) && S.settingsSearchPageOf(e, look) === p.id),
        `${look} ${p.id} has at least one entry`);
      assert.ok(!/[\p{Extended_Pictographic}–—]/u.test(p.title), `${p.id}: plain title`);
    }
  }
});

for (const look of ['classic', 'modern']) {
  test(`index: every anchor is on its page (${look})`, () => {
    const ctx = loadSettings(look);
    assert.strictEqual(ctx.isModernLayout(), look === 'modern');
    const pages = S.settingsSearchPages(look);
    assert.deepStrictEqual(plain(ctx.vaultSettingsPageIds()), plain(pages.map(p => p.id)),
      'the search knows every page in the Settings menu, in order');
    const html = Object.fromEntries(pages.map(p => [p.id, ctx.vaultSettingsPageHtml(p.id)]));
    for (const e of S.SETTINGS_INDEX) {
      if (e.look && e.look !== look) continue;
      // A control outside Settings (the Modern Size slider) lives on the page itself.
      if (e.outside) { assert.ok(PAGE.includes(`id="${e.outside}"`), `db-viewer.html: no id="${e.outside}"`); continue; }
      const page = S.settingsSearchPageOf(e, look);
      const here = html[page].includes(`data-sfind="${e.id}"`);
      assert.ok(here, `${page}: no data-sfind="${e.id}" for "${e.label}"`);
    }
    // Rows for the other look only: Card size is Classic's, the Library file Modern's.
    assert.strictEqual(html.library.includes('data-sfind="dbFile"'), look === 'modern');
  });
}

for (const [look, ids] of [['classic', ['settings', 'library']], ['modern', ['general', 'privacy', 'library', 'guides']]]) {
  test(`index: every toggle, number and choice row on the Settings pages is in it (${look})`, () => {
    const ctx = loadSettings(look);
    const html = ids.map(id => ctx.vaultSettingsPageHtml(id)).join('');
    const anchors = [...html.matchAll(/data-sfind="([^"]+)"/g)].map(m => m[1]);
    const indexed = new Set(S.SETTINGS_INDEX.map(e => e.id));
    // Model download rows come and go with what Vault has asked for; their
    // group heading is indexed instead.
    const missing = anchors.filter(a => !indexed.has(a) && !a.startsWith('modelConsent:'));
    assert.deepStrictEqual(missing, [], 'anchors on the page with no index entry');
  });
}

test('Modern: results name the Modern pages; Backend still finds AI servers', () => {
  const m = (q) => S.settingsSearch(q, { look: 'modern' });
  const backend = m('backend');
  assert.strictEqual(backend[0].page, 'servers');
  assert.strictEqual(backend[0].title, 'AI servers');
  assert.ok(ids(backend[0]).includes('backendInstances'));
  assert.match(S.settingsSearchResultsHtml(backend, 'backend'), /data-sfind-go="servers\|backendInstances"/);
  // The privacy rows moved to Privacy and security.
  const lock = m('auto-lock');
  assert.strictEqual(lock[0].page, 'privacy');
  assert.strictEqual(lock[0].title, 'Privacy and security');
  assert.ok(ids(m('privacy mode').find(g => g.page === 'privacy')).includes('privacyMode'));
  // General keeps the look and playback rows.
  assert.deepStrictEqual(ids(m('library look')[0]), ['layoutStyle']);
  assert.strictEqual(m('library look')[0].title, 'General');
  assert.ok(m('continue where i left off').some(g => g.page === 'general' && ids(g).includes('resumePlayback')));
  // No Planned group in Modern; Classic still has it.
  assert.ok(!m('planned').some(g => ids(g).some(id => id.startsWith('p_'))));
  assert.ok(S.settingsSearch('planned', { look: 'classic' }).some(g => ids(g).includes('p_confirmTrash')));
  // Classic is unchanged: its own page names.
  assert.strictEqual(S.settingsSearch('backend', { look: 'classic' })[0].page, 'backend');
  assert.strictEqual(S.settingsSearch('auto-lock', { look: 'classic' })[0].page, 'settings');
});

/* ── Matching ──────────────────────────────────────────────────────────── */

test('names, descriptions and extra words all match; every word must', () => {
  const thumb = S.settingsSearch('thumb', { look: 'classic' });
  assert.strictEqual(thumb[0].page, 'library', 'the Thumbnails group leads');
  assert.strictEqual(ids(thumb[0])[0], 'thMake');
  assert.ok(ids(thumb[0]).includes('th-hover') && ids(thumb[0]).includes('thSpace'));
  assert.ok(ids(thumb.find(g => g.page === 'settings')).includes('privacyHide'), 'found in a description');

  for (const q of ['disk', 'storage']) {
    const lib = S.settingsSearch(q).find(g => g.page === 'library');
    assert.ok(lib && ['thMake', 'thKeep', 'thSpace'].every(id => ids(lib).includes(id)), `${q} finds thumbnails`);
    assert.ok(lib.items.find(i => i.item.id === 'thMake').related.length, `${q}: says which extra word matched`);
  }
  const pw = S.settingsSearch('password');
  assert.deepStrictEqual(ids(pw.find(g => g.page === 'settings')).slice(0, 3).sort(), ['autolockMinutes', 'vaultPassword', 'vaultSecurity']);
  assert.ok(ids(pw.find(g => g.page === 'guides')).includes('guide-encryption'));

  assert.deepStrictEqual(pages(S.settingsSearch('hover preview frames')).slice(0, 1), ['library']);
  assert.strictEqual(S.settingsSearch('thumbnails zebra').length, 0, 'every word has to match');
  assert.strictEqual(S.settingsSearch('   ').length, 0);
});

test('grouping: by page, the best match first, menu order breaks ties', () => {
  const g = S.settingsSearch('lock');
  assert.strictEqual(g[0].page, 'settings', 'Auto-lock is a name match');
  for (const group of g) {
    const scores = plain(group.items.filter(i => !i.item.shortcut).map(i => i.score));
    assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a), `${group.page}: best first`);
  }
  const best = plain(g.map(x => x.best));
  assert.deepStrictEqual(best, [...best].sort((a, b) => b - a), 'groups by their best match');
  assert.strictEqual(new Set(pages(g)).size, g.length, 'one group per page');
});

test('one look only: Card size is Classic\'s, the Library file Modern\'s', () => {
  const has = (q, look, id) => S.settingsSearch(q, { look }).some(g => ids(g).includes(id));
  assert.ok(has('card size', 'classic', 'cardSize'));
  assert.ok(!has('card size', 'modern', 'cardSize'));
  assert.ok(has('database', 'modern', 'dbFile'));
  assert.ok(!has('database', 'classic', 'dbFile'));
});

test('marks: every matched word in the name and description, escaped', () => {
  assert.strictEqual(S.settingsSearchMark('Make thumbnails', ['thumb']), 'Make <mark>thumb</mark>nails');
  assert.strictEqual(S.settingsSearchMark('Auto-lock after', ['LOCK'.toLowerCase(), 'auto']), '<mark>Auto</mark>-<mark>lock</mark> after');
  assert.strictEqual(S.settingsSearchMark('a <b> & c', ['b']), 'a &lt;<mark>b</mark>&gt; &amp; c');
  const html = S.settingsSearchResultsHtml(S.settingsSearch('thumb'), 'thumb');
  assert.match(html, /<h3 class="settings-h sfind-gh" aria-hidden="true">Library<\/h3>/);
  assert.match(html, /data-sfind-go="library\|thMake"/);
  assert.match(html, /Make <mark>thumb<\/mark>nails/);
  assert.ok(!/[–—]/.test(html.replace(/<[^>]+>/g, '')), 'no dashes in what the results say');
  assert.match(S.settingsSearchResultsHtml([], 'zebra'), /No settings match "zebra"/);
});

/* ── Keyboard shortcuts ────────────────────────────────────────────────── */

test('shortcuts: rows from shortcuts.js, each jumps to its own row on the Keyboard shortcuts page', () => {
  const mute = S.settingsSearch('mute').find(g => g.page === 'shortcuts');
  assert.ok(mute, 'a Keyboard shortcuts group');
  const row = mute.items.find(i => i.item.label === 'Mute or unmute');
  assert.ok(row, 'Mute or unmute');
  assert.strictEqual(row.item.id, `sk-${S.SHORTCUTS.findIndex(r => r.desc === 'Mute or unmute')}`);
  assert.match(row.item.desc, /^M · Player$/);

  // Keys are searchable too, as in the ? window.
  const priv = S.settingsSearch('ctrl shift h');
  const sk = priv.find(g => g.page === 'shortcuts');
  assert.ok(sk && sk.items.some(i => i.item.label === 'Privacy mode on or off'));
  assert.match(sk.items.find(i => i.item.label === 'Privacy mode on or off').item.desc, /^Ctrl\+Shift\+H · Anywhere$/);

  // The page's own entry stays ahead of its rows.
  const keys = S.settingsSearch('keyboard').find(g => g.page === 'shortcuts');
  assert.strictEqual(keys.items[0].item.id, 'shortcutsList');
});

test('shortcuts: the first few, and how many more there are', () => {
  const esc = S.settingsSearch('esc').find(g => g.page === 'shortcuts');
  const rows = esc.items.filter(i => i.item.shortcut);
  assert.strictEqual(rows.length, S.SETTINGS_SEARCH_SHORTCUT_LIMIT);
  const total = S.SHORTCUTS.filter(r => r.keys.flat().includes('Esc')).length;
  assert.ok(total > S.SETTINGS_SEARCH_SHORTCUT_LIMIT);
  assert.ok(esc.more >= total - S.SETTINGS_SEARCH_SHORTCUT_LIMIT);
  assert.match(S.settingsSearchResultsHtml([esc], 'esc'), new RegExp(`Show all ${rows.length + esc.more} shortcuts`));
});

test('shortcuts: every row carries its anchor in the Keyboard shortcuts page', () => {
  const ctx = loadSettings('classic');
  const html = ctx.vaultSettingsPageHtml('shortcuts');
  S.SHORTCUTS.forEach((r, i) => assert.ok(html.includes(`data-sfind="sk-${i}"`), `row ${i}: ${r.desc}`));
});

test('card size in Modern: the Size slider above the grid, outside Settings', () => {
  const g = S.settingsSearch('card size', { look: 'modern' });
  const top = g[0].items[0].item;
  assert.strictEqual(top.outside, 'cardSizeRange');
  assert.strictEqual(S.settingsSearchTarget(top), '@cardSizeRange');
  assert.match(S.settingsSearchResultsHtml(g, 'card size'), /data-sfind-go="@cardSizeRange"/);
  assert.ok(!S.settingsSearch('card size', { look: 'classic' }).some(x => ids(x).includes('cardSizeRange')));
  assert.match(PAGE, /<div class="card-size-control modern-only">[\s\S]*?id="cardSizeRange"/);
});

test('results: a listbox of options with unique ids, grouped by page', () => {
  const out = S.settingsSearchResultsHtml(S.settingsSearch('esc'), 'esc');
  const opts = [...out.matchAll(/role="option" id="([^"]+)"/g)].map(m => m[1]);
  assert.ok(opts.length > 3);
  assert.strictEqual(new Set(opts).size, opts.length, 'unique ids');
  assert.match(out, /<section class="sfind-group" role="group" aria-label="Keyboard shortcuts">/);
  assert.match(out, /class="sfind-item sfind-more" role="option"/, 'Show all is an option too');
  const src = read('settings-search.js');
  assert.match(src, /role="combobox" aria-autocomplete="list" aria-expanded="false"/);
  assert.match(src, /setAttribute\('aria-activedescendant', list\[active\]\.id\)/);
});

/** A tiny stand-in for an element: matches() understands SETTINGS_SEARCH_FIELD. */
function fakeEl(tag, type, kids = [], disabled = false) {
  const el = { tagName: tag.toUpperCase(), type, disabled, kids };
  el.matches = (sel) => sel.split(',').some(part => {
    const p = part.trim();
    const t = p.match(/^[a-z]+/)[0];
    if (t !== tag) return false;
    const not = [...p.matchAll(/:not\(\[type="([a-z]+)"\]\)/g)].map(m => m[1]);
    return !not.includes(type);
  });
  el.querySelector = (sel) => {
    for (const k of kids) { if (k.matches(sel)) return k; const d = k.querySelector(sel); if (d) return d; }
    return null;
  };
  return el;
}

test('landing on a setting never focuses a button: fields only, else just the flash', () => {
  const t = S.settingsSearchFocusTarget;
  // Delete all face data: a row with only a Delete button.
  assert.strictEqual(t(fakeEl('div', '', [fakeEl('span', ''), fakeEl('button', 'button')])), null);
  // Check for updates: a button on its own.
  assert.strictEqual(t(fakeEl('button', 'button')), null);
  // A toggle row: its checkbox.
  const cb = fakeEl('input', 'checkbox');
  assert.strictEqual(t(fakeEl('label', '', [fakeEl('span', ''), cb])), cb);
  // A choice row with buttons and no field: nothing.
  assert.strictEqual(t(fakeEl('div', '', [fakeEl('button', 'button'), fakeEl('button', 'button')])), null);
  // Number fields, selects and text areas take focus; disabled ones and hidden inputs do not.
  const num = fakeEl('input', 'number');
  assert.strictEqual(t(fakeEl('label', '', [fakeEl('button', 'button'), num])), num);
  const sel = fakeEl('select', '');
  assert.strictEqual(t(fakeEl('div', '', [sel])), sel);
  assert.strictEqual(t(fakeEl('div', '', [fakeEl('input', 'number', [], true)])), null);
  assert.strictEqual(t(fakeEl('div', '', [fakeEl('input', 'hidden'), fakeEl('input', 'submit')])), null);
  assert.strictEqual(S.SETTINGS_SEARCH_FIELD.split(',').map(p => p.trim().match(/^[a-z]+/)[0]).join(' '),
    'input select textarea', 'only fields');
});
