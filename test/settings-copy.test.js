/**
 * Settings copy from the 3.9 UI audit (player-lib/settings.js), run in a VM
 * with a stub server: the vault password row (L8) says "vault password" and
 * offers Set / Change, the model download rows (M5) use plain names with the
 * size after a middle dot instead of codenames, and the Modern model table
 * (M6) keeps the Whisper codename out of its columns.
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

function stubEl() {
  return {
    addEventListener: noop, appendChild: noop, prepend: noop, insertAdjacentHTML: noop, insertAdjacentElement: noop,
    setAttribute: noop, removeAttribute: noop, querySelector: () => stubEl(), querySelectorAll: () => [],
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, dataset: {},
  };
}

/** settings.js in one look, with the server answering from `routes` (url prefix -> JSON). */
async function loadSettings(look, routes = {}) {
  const store = { vault_settings: JSON.stringify({ layoutStyle: look }) };
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol, Intl,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop, requestAnimationFrame: noop,
    fetch: async (url) => {
      const hit = Object.keys(routes).find(k => String(url).startsWith(k));
      if (!hit) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => routes[hit] };
    },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    location: { port: '8765', hostname: '127.0.0.1' },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: noop,
  };
  ctx.document = {
    readyState: 'complete', addEventListener: noop,
    body: stubEl(), documentElement: stubEl(), getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], createElement: stubEl,
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  ctx.dispatchEvent = noop;
  vm.createContext(ctx);
  for (const f of ['icons.js', 'shortcuts.js', 'settings-kit.js', 'thumb-settings-ui.js', 'watchers-ui.js', 'scan-settings-ui.js', 'settings.js', 'faces.js']) {
    vm.runInContext(read(f), ctx);
  }
  // settings.js warms its server cache at load; let those fetches settle.
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  return ctx;
}

const text = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('L8: no password yet, both looks offer "Set a password" and say "vault password"', async () => {
  for (const look of ['modern', 'classic']) {
    const s = await loadSettings(look, { '/api/settings/app': { encrypted: false, autolockMinutes: 30 } });
    const html = s.vaultSettingsPageHtml(look === 'modern' ? 'privacy' : 'settings');
    assert.match(html, /<div id="settingsPassRow">/, look);
    assert.match(html, /data-sfind="vaultPassword"/, look);
    assert.match(html, /data-vault-pass="set"[^>]*>Set a password<\/button>/, look);
    assert.match(text(html), /No vault password yet\./, look);
    assert.doesNotMatch(html, /database password|padlock in the header/i, look);
  }
});

test('L8: with a password set, the row offers "Change password"', async () => {
  const s = await loadSettings('modern', { '/api/settings/app': { encrypted: true, autolockMinutes: 30 } });
  const html = s.vaultSettingsPageHtml('privacy');
  assert.match(html, /data-vault-pass="change"[^>]*>Change password<\/button>/);
  assert.doesNotMatch(html, /Set a password/);
});

test('M5: model download rows use plain names and the size after a middle dot', async () => {
  const s = await loadSettings('modern', {
    '/api/settings/app': { encrypted: false },
    '/api/settings/model-downloads': {
      envAllows: true, explicit: false,
      consents: { 'whisper:large-v3-turbo': true, 'face:keeper-ir50': true },
      pending: [{ key: 'opus:ja', sizeHint: '~300 MB' }, { key: 'diarize', sizeHint: '~35 MB' }, { key: 'opus:zz' }],
    },
  });
  const t = text(s.vaultSettingsPageHtml('privacy'));
  assert.match(t, /Subtitles model · about 1\.5 GB/);
  assert.match(t, /Japanese to English translation pack · about 300 MB/);
  assert.match(t, /Speaker detection models · about 35 MB/);
  assert.match(t, /Face search: standard face model/);
  assert.match(t, /zz to English translation pack · about 300 MB/, 'an unknown code shows as itself');
  assert.doesNotMatch(t, /large-v3-turbo|→en|Transcription model|huggingface\.co/);
  // The keys themselves are untouched: they are stored consent keys.
  assert.match(s.vaultSettingsPageHtml('privacy'), /data-setting="modelConsent:whisper:large-v3-turbo"/);
});

test('M6: the Modern model table says Version and Subtitles; the codename only in Advanced', async () => {
  const s = await loadSettings('modern');
  const html = s.vaultSettingsPageHtml('models');
  const table = html.slice(html.indexOf('models-tiers'), html.indexOf('settings-fold'));
  assert.match(table, /<span>GPU memory<\/span><span>Vision model \(scanning\)<\/span><span>Version<\/span><span>Subtitles model<\/span>/);
  assert.match(table, /Q4_K_M/);
  assert.doesNotMatch(table, /large-v3-turbo|Quant|instance|worker/);
  assert.match(html.slice(html.indexOf('settings-fold')), /large-v3-turbo/);
  // Classic keeps its own table.
  const c = (await loadSettings('classic')).vaultSettingsPageHtml('models');
  assert.match(c, /<span>Quant<\/span>/);
});
