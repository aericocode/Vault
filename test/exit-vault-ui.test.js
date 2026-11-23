/**
 * Exit Vault on the page: the button pinned under the Settings menu
 * (player-lib/settings.js) and the press itself (player-lib/exit-vault.js),
 * run in a VM with stub fetch, dialogs and navigation.
 *
 * The press asks first in the app's own confirm (never window.confirm), with
 * a plain line for a share or an AI scan it would stop, and only a yes sends
 * POST /api/exit. Once Vault answers, the tab moves to the "Vault has
 * stopped" page; when it does not, the press says so and nothing moves.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LIB = path.join(__dirname, '..', 'player-lib');
const read = (f) => fs.readFileSync(path.join(LIB, f), 'utf8');
const noop = () => {};

/**
 * exit-vault.js with: activity (GET answer, or 'fail'), post (POST status and
 * body, or 'fail'), confirmAnswer, style (computed colors).
 */
function loadExit({ activity = { share: null, aiScan: false }, post = { status: 200, body: { ok: true } }, confirmAnswer = true, style = {} } = {}) {
  const t = { fetches: [], confirms: [], alerts: [], navigated: [], blobs: [], nativeConfirm: 0 };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const ctx = {
    console, JSON, Object, String, Array, Promise, Error, RegExp, Number,
    fetch: async (url, opts = {}) => {
      t.fetches.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
      if ((opts.method || 'GET') === 'GET') {
        if (activity === 'fail') throw new TypeError('Failed to fetch');
        return res(200, activity);
      }
      if (post === 'fail') throw new TypeError('Failed to fetch');
      return res(post.status, post.body);
    },
    confirm: () => { t.nativeConfirm++; return true; },
    vaultConfirm: async (message, o) => { t.confirms.push({ message, o }); return confirmAnswer; },
    vaultAlert: async (message, o) => { t.alerts.push({ message, o }); },
    Blob: class { constructor(parts, o) { this.text = parts.join(''); this.type = o && o.type; t.blobs.push(this); } },
    URL: { createObjectURL: (b) => `blob:http://127.0.0.1:8765/${t.blobs.indexOf(b)}` },
    location: { replace: (u) => t.navigated.push(u) },
    getComputedStyle: (el) => ({
      getPropertyValue: (n) => (el === ctx.document.documentElement ? (style[n] || '') : ''),
      backgroundColor: el === ctx.document.body ? (style.bodyBg || 'rgb(15, 15, 15)') : '',
      color: 'rgb(224, 224, 224)',
      fontFamily: style.font || "'Segoe UI', sans-serif",
    }),
  };
  ctx.document = { documentElement: {}, body: {} };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('exit-vault.js'), ctx);
  t.ctx = ctx;
  t.posts = () => t.fetches.filter(f => f.method === 'POST');
  return t;
}

test('asks first: Cancel sends nothing and leaves the page alone', async () => {
  const t = loadExit({ confirmAnswer: false });
  assert.strictEqual(await t.ctx.vaultExitVault(), 'cancelled');
  assert.strictEqual(t.confirms.length, 1, 'the app\'s own confirm');
  assert.strictEqual(t.nativeConfirm, 0, 'never window.confirm');
  assert.strictEqual(t.confirms[0].o.title, 'Exit Vault?');
  assert.strictEqual(t.confirms[0].o.okLabel, 'Exit Vault');
  assert.strictEqual(t.confirms[0].message, 'Vault will stop on this computer. To use it again, start it from its folder.');
  assert.strictEqual(t.confirms[0].o.danger, false, 'nothing would stop: a plain confirm');
  assert.deepStrictEqual(t.posts(), [], 'no POST without a yes');
  assert.deepStrictEqual(t.navigated, []);
});

test('a yes sends POST /api/exit as JSON, then shows the stopped page', async () => {
  const t = loadExit();
  assert.strictEqual(await t.ctx.vaultExitVault(), 'stopped');
  const [p] = t.posts();
  assert.strictEqual(p.url, '/api/exit');
  assert.strictEqual(p.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(p.body), { exit: true });
  assert.strictEqual(t.navigated.length, 1, 'the tab moved to the stopped page');
  assert.match(t.navigated[0], /^blob:/);
  const html = t.blobs[0].text;
  assert.strictEqual(t.blobs[0].type, 'text/html');
  assert.match(html, /<title>Vault has stopped<\/title>/);
  const words = html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.strictEqual(words, 'Vault has stopped Vault has stopped. You can close this tab. To use Vault again, start it from its folder.');
  assert.doesNotMatch(html, /<script/i, 'nothing on it runs, so nothing polls');
  assert.doesNotMatch(html, /src=|href=/, 'nothing on it asks the stopped server for anything');
});

test('the confirm says what would stop, one plain line each', async () => {
  for (const [activity, lines] of [
    [{ share: 'uploading', aiScan: false }, ['A share is still uploading. It will stop.']],
    [{ share: 'packing', aiScan: false }, ['A share is still being packed. It will stop.']],
    [{ share: null, aiScan: true }, ['An AI scan is still running. It will stop.']],
    [{ share: 'uploading', aiScan: true }, ['A share is still uploading. It will stop.', 'An AI scan is still running. It will stop.']],
  ]) {
    const t = loadExit({ activity, confirmAnswer: false });
    await t.ctx.vaultExitVault();
    const { message, o } = t.confirms[0];
    assert.deepStrictEqual(message.split('\n\n').slice(1), lines, JSON.stringify(activity));
    assert.strictEqual(o.danger, true, 'work would stop: starts on Cancel');
  }
});

test('when Vault does not say what is running, the confirm still shows, plain', async () => {
  const t = loadExit({ activity: 'fail', confirmAnswer: false });
  assert.strictEqual(await t.ctx.vaultExitVault(), 'cancelled');
  assert.strictEqual(t.confirms.length, 1);
  assert.strictEqual(t.confirms[0].message.split('\n\n').length, 1);
});

test('a refused exit says so, and the page stays', async () => {
  const t = loadExit({ post: { status: 423, body: { error: 'Vault is locked. Unlock it first.', code: 'VAULT_LOCKED' } } });
  assert.strictEqual(await t.ctx.vaultExitVault(), 'failed');
  assert.deepStrictEqual(t.navigated, []);
  assert.strictEqual(t.alerts.length, 1);
  assert.strictEqual(t.alerts[0].message, 'Vault did not stop. It is still running.\n\nVault is locked. Unlock it first.');
});

test('no answer at all says so, and the page stays', async () => {
  const t = loadExit({ post: 'fail' });
  assert.strictEqual(await t.ctx.vaultExitVault(), 'failed');
  assert.deepStrictEqual(t.navigated, []);
  assert.match(t.alerts[0].message, /^Vault did not answer, so it may still be running\./);
});

test('a second press while the first is in hand does nothing', async () => {
  const t = loadExit();
  let release;
  t.ctx.vaultConfirm = (message) => { t.confirms.push({ message }); return new Promise(r => { release = r; }); };
  const first = t.ctx.vaultExitVault();
  assert.strictEqual(await t.ctx.vaultExitVault(), 'busy');
  await new Promise(r => setImmediate(r));
  release(false);
  assert.strictEqual(await first, 'cancelled');
  assert.strictEqual(t.confirms.length, 1);
});

test('the stopped page takes the colors on screen; anything odd falls back', async () => {
  const t = loadExit({ style: { '--bg-primary': '#f6f6f8', '--text-primary': '#1b1b1f', '--text-secondary': '#55555c', bodyBg: 'rgba(0, 0, 0, 0)' } });
  await t.ctx.vaultExitVault();
  const html = t.blobs[0].text;
  assert.match(html, /background:#f6f6f8/, 'a see-through body uses the page color token');
  assert.match(html, /color:#1b1b1f/);
  assert.match(html, /color:#55555c/);

  const bad = loadExit({ style: { '--text-primary': 'red}</style><script>alert(1)</script>', font: 'x</style><script>' } });
  await bad.ctx.vaultExitVault();
  const html2 = bad.blobs[0].text;
  assert.doesNotMatch(html2, /<script/i);
  assert.match(html2, /color:#e0e0e0/, 'the default stands in');
});

test('copy: no em or en dashes in anything the press says', () => {
  const src = read('exit-vault.js');
  const strings = [...src.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map(m => m[1] || m[2] || '');
  for (const s of strings) assert.ok(!/[–—]/.test(s), s);
});

/* ── The button under the Settings menu (settings.js) ─────────────────── */

function loadSettingsShell(look) {
  const store = { vault_settings: JSON.stringify({ layoutStyle: look }) };
  const made = [];
  const listeners = {};
  const el = (tag) => {
    const n = {
      tag, innerHTML: '', className: '', id: '', style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      addEventListener: noop, appendChild: noop, insertAdjacentHTML: noop, setAttribute: noop, removeAttribute: noop,
      querySelectorAll: () => [],
      querySelector: (sel) => {
        const q = { isConnected: true, disabled: false, dataset: {}, focus: noop, addEventListener: (type, fn) => { (listeners[`${sel} ${type}`] ||= []).push(fn); } };
        return q;
      },
    };
    made.push(n);
    return n;
  };
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol, Intl,
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
    readyState: 'complete', addEventListener: noop, activeElement: null,
    body: el('body'), documentElement: el('html'), getElementById: (id) => made.find(n => n.id === id) || null, querySelector: () => null,
    querySelectorAll: () => [], createElement: el,
  };
  ctx.window = ctx;
  ctx.addEventListener = noop;
  ctx.dispatchEvent = noop;
  vm.createContext(ctx);
  for (const f of ['icons.js', 'shortcuts.js', 'settings-kit.js', 'thumb-settings-ui.js', 'watchers-ui.js', 'scan-settings-ui.js', 'settings.js']) {
    vm.runInContext(read(f), ctx);
  }
  return { ctx, made, listeners };
}

for (const look of ['modern', 'classic']) {
  test(`Settings (${look}): Exit Vault sits under the menu, outside every page, with its hint`, async () => {
    const { ctx, made, listeners } = loadSettingsShell(look);
    ctx.vaultOpenSettings('general');
    const shell = made.find(n => /settings-modal/.test(n.innerHTML));
    assert.ok(shell, 'the Settings window was built');
    const html = shell.innerHTML;
    const side = html.indexOf('class="settings-side"');
    const nav = html.indexOf('id="settingsNav"');
    const btn = html.indexOf('id="settingsExitBtn"');
    const body = html.indexOf('id="settingsBody"');
    assert.ok(side >= 0 && side < nav && nav < btn && btn < body, 'menu, then the button, in the side column; the pages after');
    assert.match(html, /<button type="button" class="settings-exit-btn" id="settingsExitBtn" data-exit-vault\s+title="Stops Vault on this computer\. Start it again from its folder\.">Exit Vault<\/button>/);
    assert.doesNotMatch(html, /class="settings-btn[ "][^"]*settings-exit-btn/, 'quiet, not the accent button');
    // No page carries a row for it any more.
    for (const id of ctx.vaultSettingsPageIds()) assert.doesNotMatch(ctx.vaultSettingsPageHtml(id), /data-exit-vault/, id);
    // The click goes to exit-vault.js.
    let pressed = 0;
    ctx.vaultExitVault = async () => { pressed++; return 'cancelled'; };
    const clicks = listeners['#settingsExitBtn click'] || [];
    assert.strictEqual(clicks.length, 1, 'one click handler');
    await clicks[0]();
    assert.strictEqual(pressed, 1);
  });
}
