/**
 * The AI scan panel (player-lib/importer.js), run in a VM with a small fake
 * DOM and a fake server: it shows for scan work the SERVER queued (a watched
 * folder, here) with no import started from the page, which is the bug the
 * power user hit; it shows a wait with its reason and a Try now button; a run
 * that ends with failures stays up on the Failed tab with the groups; Close
 * forgets the list on the server; a clean finish hides itself; and in Modern
 * nothing it draws is an emoji.
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
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r)); };

/* ── A DOM just big enough for the panel ─────────────────────────────────
   innerHTML is not parsed into a tree; every id="…" in it becomes an element
   that querySelector('#id') and getElementById find, with `hidden` read off
   its tag. Anything else querySelector is asked for gets a quiet stand-in. */
function makeDom() {
  const byId = new Map();
  class El {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this._q = new Map();
      this._generic = new Map();
      this.dataset = {};
      this.style = {};
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.textContent = '';
      this.listeners = {};
      this.attrs = {};
      this.removed = false;
      const cls = new Set();
      this.classList = {
        add: (...c) => c.forEach(x => cls.add(x)),
        remove: (...c) => c.forEach(x => cls.delete(x)),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
        contains: (c) => cls.has(c),
      };
      this._html = '';
    }
    set id(v) { this._id = v; byId.set(v, this); }
    get id() { return this._id; }
    set className(v) { String(v).split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c)); }
    set innerHTML(html) {
      this._html = String(html);
      for (const e of this._q.values()) if (byId.get(e.id) === e) byId.delete(e.id);
      this._q.clear();
      for (const m of this._html.matchAll(/<([a-z]+)\b([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
        const e = new El(m[1]);
        e.id = m[3];
        e.hidden = /\shidden(?=[\s>]|$)/.test(` ${m[2]} ${m[4]}`);
        e.parent = this;
        this._q.set(`#${m[3]}`, e);
      }
    }
    get innerHTML() { return this._html; }
    querySelector(sel) {
      if (this._q.has(sel)) return this._q.get(sel);
      for (const c of this._q.values()) { if (c._q.has(sel)) return c._q.get(sel); }
      if (!this._generic.has(sel)) this._generic.set(sel, new El());
      return this._generic.get(sel);
    }
    querySelectorAll() { return []; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    appendChild(c) { this.children.push(c); c.parent = this; c.removed = false; return c; }
    remove() {
      this.removed = true;
      if (byId.get(this.id) === this) byId.delete(this.id);
      for (const e of this._q.values()) e.remove();
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    get isConnected() { return !this.removed; }
    click() { for (const f of this.listeners.click || []) f({ currentTarget: this, target: this }); }
  }
  const docListeners = {};
  const document = {
    hidden: false,
    activeElement: null,
    readyState: 'complete',
    addEventListener: (t, f) => { (docListeners[t] ||= []).push(f); },
    getElementById: (id) => byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => new El(tag),
    body: new El('body'),
  };
  return { document, docListeners, byId, El };
}

/** importer.js (and icons.js) in a VM against a scripted server. */
function load({ modern = false } = {}) {
  const dom = makeDom();
  const stack = new dom.El();
  const intervals = new Map();
  const timeouts = new Map();
  let tid = 0;
  const server = {
    queue: { total: 0, done: 0, failed: 0, active: [], pending: [], pendingCount: 0, paused: false, pausedBy: null },
    summary: { active: 0, queued: 0, waiting: 0, failed: 0, done: 0, total: 0 },
    failures: { failed: { total: 0, groups: [] }, waiting: { count: 0, sample: [] } },
    log: [],
  };
  const toasts = [];
  const ctx = {
    console, Math, JSON, Array, Object, String, Number, Boolean, Map, Set, RegExp, Date, Promise, Error, Symbol,
    document: dom.document,
    navigator: { clipboard: { writeText: async () => {} } },
    localStorage: { getItem: () => '1', setItem: noop, removeItem: noop },
    setInterval: (f) => { intervals.set(++tid, f); return tid; },
    clearInterval: (id) => { intervals.delete(id); },
    setTimeout: (f, ms) => { timeouts.set(++tid, { f, ms }); return tid; },
    clearTimeout: (id) => { timeouts.delete(id); },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: (t) => toasts.push(t),
    queuePanelStack: () => stack,
    fetch: async (url, opts = {}) => {
      server.log.push(`${opts.method || 'GET'} ${url}`);
      const body = url.startsWith('/api/import/queue/summary') ? server.summary
        : url.startsWith('/api/import/queue') ? server.queue
          : url.startsWith('/api/import/failures') ? server.failures : {};
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)), text: async () => '' };
    },
  };
  ctx.window = ctx;
  ctx.isModernLayout = () => modern;
  vm.createContext(ctx);
  vm.runInContext(read('icons.js'), ctx);
  vm.runInContext(read('importer.js'), ctx);
  const fire = async (type) => { for (const f of dom.docListeners[type] || []) f({}); await flush(); };
  /** Run every live interval once (the fast poll, or the light one). */
  const tick = async () => { for (const f of [...intervals.values()]) f(); await flush(); };
  return { ctx, dom, server, intervals, timeouts, toasts, fire, tick, $: (id) => dom.document.getElementById(id) };
}

const EMOJI = /\p{Extended_Pictographic}/u;
const modernText = (html) => html.replace(/<span class="vi-c">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');

const RUNNING = {
  total: 3, done: 0, failed: 0, paused: false, pausedBy: null,
  active: [{ id: 1, filename: 'beach.mp4', source: 'watch', watchFolder: 'D:\\Downloads', startedAt: 1 }],
  pending: [{ id: 2, filename: 'b.mp4' }, { id: 3, filename: 'c.mkv' }], pendingCount: 2,
  model: { name: 'minicpm-v-4.6', copies: 2 }, etaMs: 6 * 60000, workersPerInstance: 2, instances: [],
};

test('server-queued work brings the panel up, with no import started from the page', async () => {
  const t = load();
  await t.fire('DOMContentLoaded');
  // Nothing to do yet: the fast poll gives up after a while and the light count takes over.
  for (let i = 0; i < 45; i++) await t.tick();
  assert.strictEqual(t.$('scanQueuePanel'), null, 'no panel for an idle queue');
  assert.ok(t.server.log.some(l => l === 'GET /api/import/queue/summary'), 'the light count is being asked');

  // A watched folder adds files on the server.
  t.server.summary = { active: 1, queued: 2, waiting: 0, failed: 0, done: 0, total: 3 };
  t.server.queue = RUNNING;
  await t.tick();
  await t.tick();
  const panel = t.$('scanQueuePanel');
  assert.ok(panel, 'the panel appeared');
  assert.ok(panel.classList.contains('visible'));
  assert.strictEqual(t.$('scanAiPane').hidden, false);
  assert.strictEqual(t.$('scanHeadSub').textContent, '· 0 of 3');
  assert.match(t.$('scanEta').textContent, /^1 working · about 6 min left · minicpm-v-4\.6 \(2 copies\)$/);
  assert.match(t.$('scanList').innerHTML, /beach\.mp4[\s\S]*from Downloads/);
  assert.ok(!t.server.log.some(l => /add-paths|pick-/.test(l)), 'no import from this page');
  assert.strictEqual(t.$('scanTabs').hidden, true, 'no tabs while nothing failed or waits');
});

test('waiting: the reason, a count on the tab, and Try now', async () => {
  const t = load();
  t.server.queue = { ...RUNNING, active: [], pendingCount: 3, paused: true, pausedBy: 'waiting',
    waiting: { count: 3, code: 'no-room', reason: 'Not enough free GPU memory to load vis (needs about 6.0 GB, 2.1 GB free).', since: 5 } };
  await t.fire('DOMContentLoaded');
  assert.strictEqual(t.$('scanHeadSub').textContent, '· 3 waiting');
  assert.strictEqual(t.$('scanTabs').hidden, false);
  assert.strictEqual(t.$('scanTabWaitingN').textContent, '(3)');
  assert.strictEqual(t.$('scanWaitLine').hidden, false);
  assert.match(t.$('scanWaitBox').innerHTML, /Not enough free GPU memory/);
  assert.match(t.$('scanPauseBtn').innerHTML, /Try now/);
  assert.match(t.$('scanEta').textContent, /^Nothing is scanning/);
  assert.ok(t.toasts.some(x => /waiting for the scan model/.test(x)), 'said once');
});

test('a run that ends with failures stays on the Failed tab until Close, which forgets the list', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  t.server.queue = { ...RUNNING, done: 2, failed: 1, active: [], pending: [], pendingCount: 0 };
  t.server.failures = {
    failed: { total: 1, groups: [{ key: 'media-info', label: 'Could not read media info', explain: 'The file may be damaged, still being copied.',
      count: 12, sample: [{ id: 3, filename: 'c.mkv', folder: 'D:\\Media\\Clips', error: 'Could not read media info' }] }] },
    waiting: { count: 0, sample: [] },
  };
  await t.tick();
  await t.tick();
  assert.ok(t.$('scanQueuePanel'), 'still showing');
  assert.strictEqual(t.$('scanHeadSub').textContent, '· done, 1 failed');
  assert.strictEqual(t.$('scanCloseBtn').hidden, false);
  assert.strictEqual(t.$('scanViewFailed').hidden, false, 'opened on the Failed tab');
  assert.ok(t.server.log.some(l => l.startsWith('GET /api/import/failures')));
  const groups = t.$('scanGroups').innerHTML;
  assert.match(groups, /Could not read media info/);
  assert.match(groups, /\(12\)/);
  assert.match(groups, /c\.mkv[\s\S]*D:\\Media\\Clips/);
  assert.match(groups, /and 11 more/);
  assert.match(groups, /data-force-refresh="3"/, 'Force refresh per file');
  assert.match(groups, /data-grp-retry/, 'Retry this group');
  assert.ok(![...t.timeouts.values()].some(x => x.ms === 4000), 'no auto-hide with failures on it');

  t.$('scanCloseBtn').click();
  await new Promise(r => setImmediate(r));
  assert.ok(t.server.log.includes('POST /api/import/failures/clear'));
  assert.strictEqual(t.$('scanQueuePanel'), null, 'closed');
});

test('a reload after a run with failures shows them again', async () => {
  const t = load();
  t.server.queue = { ...RUNNING, done: 2, failed: 1, active: [], pending: [], pendingCount: 0 };
  t.server.failures = { failed: { total: 1, groups: [] }, waiting: { count: 0, sample: [] } };
  await t.fire('DOMContentLoaded');
  assert.ok(t.$('scanQueuePanel'));
  assert.strictEqual(t.$('scanHeadSub').textContent, '· done, 1 failed');
});

test('a clean finish hides itself', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  t.server.queue = { ...RUNNING, done: 3, active: [], pending: [], pendingCount: 0 };
  await t.tick();
  const hide = [...t.timeouts.values()].find(x => x.ms === 4000);
  assert.ok(hide, 'auto-hide scheduled');
  hide.f();
  assert.strictEqual(t.$('scanQueuePanel'), null);
});

test('Modern: no emoji in anything the panel draws; Classic keeps them', async () => {
  for (const modern of [true, false]) {
    const t = load({ modern });
    t.server.queue = { ...RUNNING, done: 2, failed: 1, active: [], pending: [], pendingCount: 0 };
    t.server.failures = { failed: { total: 1, groups: [{ key: 'other', label: 'Other', explain: 'x', count: 1,
      sample: [{ id: 1, filename: 'a.mp4', folder: 'D:\\', error: 'e' }] }] }, waiting: { count: 0, sample: [] } };
    await t.fire('DOMContentLoaded');
    const html = t.$('scanAiPane').innerHTML + t.$('scanGroups').innerHTML + t.$('scanHeadIco').innerHTML;
    if (modern) assert.ok(!EMOJI.test(modernText(html)), modernText(html).match(EMOJI)?.[0]);
    else assert.ok(EMOJI.test(html), 'Classic keeps its emoji');
  }
});

test('a tab that empties gives way: Waiting picked, then the run ends with failures', async () => {
  const t = load();
  t.server.queue = { ...RUNNING, active: [], pendingCount: 2, paused: true, pausedBy: 'waiting',
    waiting: { count: 2, code: 'policy-wait', reason: 'vis is not loaded.', since: 9 } };
  await t.fire('DOMContentLoaded');
  // The user picks Waiting by hand.
  const tabs = t.$('scanTabs');
  for (const f of tabs.listeners.click || []) f({ target: { closest: () => ({ dataset: { scanTab: 'waiting' } }) } });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(t.$('scanViewWaiting').hidden, false);

  t.server.queue = { ...RUNNING, done: 1, failed: 2, active: [], pending: [], pendingCount: 0 };
  t.server.failures = { failed: { total: 2, groups: [{ key: 'other', label: 'Other', explain: 'x', count: 2, sample: [] }] }, waiting: { count: 0, sample: [] } };
  await t.tick();
  await t.tick();
  assert.strictEqual(t.$('scanViewWaiting').hidden, true, 'the emptied Waiting tab is not left showing');
  assert.strictEqual(t.$('scanViewFailed').hidden, false);
  assert.match(t.$('scanAiPane').innerHTML, /class="sp-retry-label">Retry all</, 'the count goes on the label, not the icon');
});
