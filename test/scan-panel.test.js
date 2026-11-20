/**
 * The AI scan panel (player-lib/importer.js) and the Activity button it now
 * lives under (player-lib/activity.js), run in a VM with a small fake DOM
 * and a fake server.
 *
 * Scan work the SERVER queued (a watched folder, here) with no import started
 * from the page shows as an AI scan section in the Activity dropdown, and the
 * button gets a ring, a count and a colour; nothing floats over the library
 * and there is no Hide. A wait is amber with its reason and Try now; a run
 * that ends with failures is red, keeps its result (Retry all and Show failed
 * right in the dropdown) and Open shows the full panel on the Failed tab;
 * Dismiss forgets the list on the server; a clean finish stays as a quiet
 * result. In Modern nothing it draws is an emoji.
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

/* ── A DOM just big enough for the panel and the Activity button ─────────
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
      for (const e of this._q.values()) { e.removed = true; if (byId.get(e.id) === e) byId.delete(e.id); }
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
      // The first button that shows, in the order the markup has them.
      if (sel === 'button:not([hidden])') {
        const walk = (el) => { for (const c of el._q.values()) { if (c.tagName === 'BUTTON' && !c.hidden) return c; const d = walk(c); if (d) return d; } return null; };
        for (const k of [this, ...this.children]) { const b = k.tagName === 'BUTTON' && k !== this && !k.hidden ? k : walk(k); if (b) return b; }
        return null;
      }
      for (const c of this._q.values()) { if (c._q.has(sel)) return c._q.get(sel); }
      if (!this._generic.has(sel)) this._generic.set(sel, new El());
      return this._generic.get(sel);
    }
    querySelectorAll() { return []; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    appendChild(c) { this.children.push(c); c.parent = this; c.removed = false; return c; }
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      c.parent = this; c.removed = false; return c;
    }
    remove() {
      this.removed = true;
      if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
      if (byId.get(this.id) === this) byId.delete(this.id);
      for (const e of this._q.values()) e.remove();
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    get isConnected() { return !this.removed; }
    contains(n) { for (let x = n; x; x = x.parent) if (x === this) return true; return false; }
    focus() { document.activeElement = this; }
    get nextElementSibling() { const p = this.parent; if (!p) return null; const i = p.children.indexOf(this); return i < 0 ? null : (p.children[i + 1] || null); }
    get previousElementSibling() { const p = this.parent; if (!p) return null; const i = p.children.indexOf(this); return i > 0 ? p.children[i - 1] : null; }
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

/** importer.js (with icons.js and activity.js) in a VM against a scripted server. */
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
    headers: [],
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
      if (!opts.method) server.headers.push([url, (opts.headers || {})['X-Vault-Background']]);
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
  vm.runInContext(read('activity.js'), ctx);
  vm.runInContext(read('importer.js'), ctx);
  const fire = async (type, ev = {}) => { for (const f of dom.docListeners[type] || []) f(ev); await flush(); };
  /** Run every live interval once (the fast poll, or the light one). */
  const tick = async () => { for (const f of [...intervals.values()]) f(); await flush(); };
  const $ = (id) => dom.document.getElementById(id);
  const act = ctx.vaultActivity;
  /** The button as a person sees it. */
  const button = () => ({
    state: $('activityWrap').dataset.state,
    badge: $('activityBadge').hidden ? '' : $('activityBadge').textContent,
    badgeTone: $('activityBadge').dataset.tone,
    ring: !$('activityRing').hidden,
    ringDash: $('activityRingFg').getAttribute('stroke-dasharray'),
    label: $('activityBtn').getAttribute('aria-label'),
  });
  return { ctx, dom, server, intervals, timeouts, toasts, fire, tick, $, act, button, stack };
}

const EMOJI = /\p{Extended_Pictographic}/u;
const modernText = (html) => html.replace(/<span class="vi-c">[\s\S]*?<\/span>/g, '').replace(/<[^>]+>/g, '');

const RUNNING = {
  total: 3, done: 0, failed: 0, paused: false, pausedBy: null,
  active: [{ id: 1, filename: 'beach.mp4', source: 'watch', watchFolder: 'D:\\Downloads', startedAt: 1 }],
  pending: [{ id: 2, filename: 'b.mp4' }, { id: 3, filename: 'c.mkv' }], pendingCount: 2,
  model: { name: 'minicpm-v-4.6', copies: 2 }, etaMs: 6 * 60000, workersPerInstance: 2, instances: [],
};

const FAILED_GROUPS = {
  failed: { total: 1, groups: [{ key: 'media-info', label: 'Could not read media info', explain: 'The file may be damaged, still being copied.',
    count: 12, sample: [{ id: 3, filename: 'c.mkv', folder: 'D:\\Media\\Clips', error: 'Could not read media info' }] }] },
  waiting: { count: 0, sample: [] },
};

test('server-queued work shows under the Activity button, with no import started from the page and nothing floating', async () => {
  const t = load();
  await t.fire('DOMContentLoaded');
  // Nothing to do yet: the fast poll gives up after a while and the light count takes over.
  for (let i = 0; i < 45; i++) await t.tick();
  assert.strictEqual(t.$('act-sec-ai'), null, 'no AI scan section for an idle queue');
  assert.deepStrictEqual(t.button(), { state: 'idle', badge: '', badgeTone: 'idle', ring: false, ringDash: null, label: 'Activity: nothing running' });
  assert.ok(t.server.log.some(l => l === 'GET /api/import/queue/summary'), 'the light count is being asked');

  // A watched folder adds files on the server.
  t.server.summary = { active: 1, queued: 2, waiting: 0, failed: 0, done: 0, total: 3 };
  t.server.queue = { ...RUNNING, done: 1 };
  await t.tick();
  await t.tick();
  assert.ok(t.$('act-sec-ai'), 'the AI scan section appeared');
  assert.strictEqual(t.$('act-ai-title').textContent, 'AI scan');
  assert.strictEqual(t.$('act-ai-status').textContent, '1 of 3');
  assert.match(t.$('act-ai-detail').innerHTML, /^Now: <span class="dq-name">beach\.mp4<\/span>$/, 'the file name rides in .dq-name (blurred under privacy)');
  assert.match(t.$('act-ai-fill').style.width, /^33\.33+\d*%$/);
  const b = t.button();
  assert.strictEqual(b.state, 'work', 'accent while it only runs');
  assert.strictEqual(b.badge, '1');
  assert.ok(b.ring, 'a ring for the scan\'s progress');
  assert.strictEqual(b.ringDash, '33.3 100');
  assert.strictEqual(b.label, 'Activity: 1 running');
  assert.match(t.$('act-ai-acts').innerHTML, /data-act="pause"[\s\S]*data-act="open"/, 'Pause and Open');
  assert.strictEqual(t.$('act-ai-b-pause').textContent, 'Pause');

  // Nothing floats: the panel lives in the dropdown, which is closed.
  assert.strictEqual(t.stack.children.length, 0, 'nothing in the bottom right corner');
  assert.strictEqual(t.$('scanQueuePanel').parent, t.$('activityHost'), 'the panel is the full view in the dropdown');
  assert.ok(!t.$('scanQueuePanel').classList.contains('delete-queue'), 'not the floating card');
  assert.strictEqual(t.$('activityPop').hidden, true, 'nothing opened over the library');
  assert.strictEqual(t.$('scanAiPane').hidden, true);
  assert.ok(!/scanHideBtn|>Hide</.test(t.$('scanAiPane').innerHTML), 'no Hide button');

  // Open: the full panel with everything it had.
  t.act.openView('ai');
  assert.strictEqual(t.$('activityPop').hidden, false);
  assert.strictEqual(t.$('activityBtn').getAttribute('aria-expanded'), 'true');
  assert.strictEqual(t.$('activityMain').hidden, true, 'the list gives way');
  assert.strictEqual(t.$('activityView').hidden, false);
  assert.strictEqual(t.$('scanAiPane').hidden, false);
  assert.strictEqual(t.$('scanHeadSub').textContent, '· 1 of 3');
  assert.match(t.$('scanEta').textContent, /^1 working · about 6 min left · minicpm-v-4\.6 \(2 copies\)$/);
  assert.match(t.$('scanList').innerHTML, /beach\.mp4[\s\S]*from Downloads/);
  for (const id of ['scanWorkersNum', 'scanPauseBtn', 'scanCancelBtn', 'scanRetryAll', 'scanShowFailed', 'scanCopyList', 'scanLoadAnyway', 'scanTabs']) {
    assert.ok(t.$(id), `${id} is still there`);
  }
  assert.strictEqual(t.$('scanTabs').hidden, true, 'no tabs while nothing failed or waits');
  // Live updates keep the view as it is.
  await t.tick();
  assert.strictEqual(t.$('scanAiPane').hidden, false);
  assert.strictEqual(t.act.viewing(), 'ai');
  // Back to the list.
  t.$('activityBack').click();
  assert.strictEqual(t.$('activityMain').hidden, false);
  assert.strictEqual(t.$('scanAiPane').hidden, true);
  assert.ok(!t.server.log.some(l => /add-paths|pick-/.test(l)), 'no import from this page');
  assert.ok(t.server.headers.every(([, bg]) => bg === '1'), 'every poll is a background request');
});

test('Pause and Resume from the dropdown go through the panel\'s own button', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  t.act.act('ai', 'pause');
  await t.tick();
  assert.ok(t.server.log.includes('POST /api/import/queue/pause'));
  t.server.queue = { ...RUNNING, paused: true, pausedBy: 'user' };
  await t.tick();
  assert.strictEqual(t.$('act-ai-status').textContent, 'Paused');
  assert.strictEqual(t.$('act-ai-b-pause').textContent, 'Resume');
  assert.strictEqual(t.button().state, 'wait', 'paused: amber');
  t.act.act('ai', 'pause');
  await t.tick();
  assert.ok(t.server.log.includes('POST /api/import/queue/resume'));
});

test('waiting: amber, the reason, a count on the tab, and Try now', async () => {
  const t = load();
  t.server.queue = { ...RUNNING, active: [], pendingCount: 3, paused: true, pausedBy: 'waiting',
    waiting: { count: 3, code: 'no-room', reason: 'Not enough free GPU memory to load vis (needs about 6.0 GB, 2.1 GB free).', since: 5 } };
  await t.fire('DOMContentLoaded');
  assert.strictEqual(t.$('act-ai-status').textContent, 'Waiting for the scan model');
  assert.strictEqual(t.$('act-sec-ai').dataset.tone, 'wait');
  assert.deepStrictEqual([t.button().state, t.button().badgeTone], ['wait', 'wait']);
  assert.strictEqual(t.button().label, 'Activity: 1 waiting', 'a held scan says waiting, not running');
  assert.strictEqual(t.$('act-ai-b-pause').textContent, 'Try now');
  assert.strictEqual(t.$('scanHeadSub').textContent, '· 3 waiting');
  assert.strictEqual(t.$('scanTabs').hidden, false);
  assert.strictEqual(t.$('scanTabWaitingN').textContent, '(3)');
  assert.strictEqual(t.$('scanWaitLine').hidden, false);
  assert.match(t.$('scanWaitBox').innerHTML, /Not enough free GPU memory/);
  assert.match(t.$('scanPauseBtn').innerHTML, /Try now/);
  assert.match(t.$('scanEta').textContent, /^Nothing is scanning/);
  assert.ok(t.toasts.some(x => /waiting for the scan model/.test(x)), 'said once');
  assert.strictEqual(t.$('activityPop').hidden, true, 'and nothing opened');
});

test('a halt turns the button red and pulses it, keeps the toast, and opens nothing', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  t.server.queue = { ...RUNNING, paused: true, pausedBy: 'model', halt: { at: 7, reason: 'The scan model is not loaded' } };
  await t.tick();
  assert.ok(t.toasts.some(x => /AI scan paused: The scan model is not loaded/.test(x)));
  assert.strictEqual(t.button().state, 'need');
  assert.strictEqual(t.button().badgeTone, 'need');
  assert.strictEqual(t.$('act-ai-status').textContent, 'Stopped');
  assert.match(t.$('act-ai-detail').innerHTML, /Model unavailable: The scan model is not loaded/);
  assert.ok(t.$('activityWrap').classList.contains('act-pulse'), 'the button pulses');
  assert.strictEqual(t.$('activityPop').hidden, true, 'nothing opened over the library');
  assert.strictEqual(t.button().label, 'Activity: 1 needs you');
});

test('a run that ends with failures: red, Retry all and Show failed in the dropdown, Open shows the Failed tab, Dismiss forgets the list', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  t.server.queue = { ...RUNNING, done: 2, failed: 1, active: [], pending: [], pendingCount: 0 };
  t.server.failures = FAILED_GROUPS;
  await t.tick();
  await t.tick();
  assert.ok(t.$('act-sec-ai'), 'still listed');
  assert.strictEqual(t.$('act-ai-status').textContent, 'Done, 1 failed');
  assert.strictEqual(t.$('act-ai-detail').innerHTML, '2 files scanned, 1 file could not be scanned');
  const b = t.button();
  assert.deepStrictEqual([b.state, b.badge, b.badgeTone, b.ring], ['need', '1', 'need', false], 'red with nothing running, the count is what needs you');
  assert.strictEqual(b.label, 'Activity: 1 needs you');
  assert.strictEqual(t.$('activityIdle').hidden, true, 'no "Nothing is running" over a result that needs you');
  assert.match(t.$('act-ai-acts').innerHTML, /data-act="retry"[\s\S]*data-act="show"[\s\S]*data-act="open"/);
  assert.strictEqual(t.$('act-ai-b-retry').textContent, 'Retry all');
  assert.strictEqual(t.$('act-ai-x').hidden, false, 'it can be dismissed');
  assert.ok(![...t.timeouts.values()].some(x => x.ms === 4000), 'no auto-clear with failures on it');
  assert.ok(!t.server.log.some(l => l.startsWith('GET /api/import/failures')), 'the list is not fetched while nobody looks');

  // Open: the full panel on the Failed tab, with the groups.
  t.act.openView('ai');
  await t.tick();
  assert.strictEqual(t.$('scanHeadSub').textContent, '· done, 1 failed');
  assert.strictEqual(t.$('scanViewFailed').hidden, false, 'opened on the Failed tab');
  assert.ok(t.server.log.some(l => l.startsWith('GET /api/import/failures')));
  const groups = t.$('scanGroups').innerHTML;
  assert.match(groups, /Could not read media info/);
  assert.match(groups, /\(12\)/);
  assert.match(groups, /c\.mkv[\s\S]*D:\\Media\\Clips/);
  assert.match(groups, /and 11 more/);
  assert.match(groups, /data-force-refresh="3"/, 'Force refresh per file');
  assert.match(groups, /data-grp-retry/, 'Retry this group');
  t.$('activityBack').click();

  // Retry all, straight from the section.
  t.act.act('ai', 'retry');
  await t.tick();
  assert.ok(t.server.log.includes('POST /api/import/failures/retry'));

  // Dismiss forgets the list on the server.
  t.act.act('ai', 'dismiss');
  await new Promise(r => setImmediate(r));
  assert.ok(t.server.log.includes('POST /api/import/failures/clear'));
  assert.strictEqual(t.$('act-sec-ai'), null, 'gone');
  assert.strictEqual(t.button().state, 'idle');
});

test('a reload after a run with failures shows them again, in red', async () => {
  const t = load();
  t.server.queue = { ...RUNNING, done: 2, failed: 1, active: [], pending: [], pendingCount: 0 };
  t.server.failures = { failed: { total: 1, groups: [] }, waiting: { count: 0, sample: [] } };
  await t.fire('DOMContentLoaded');
  assert.ok(t.$('act-sec-ai'));
  assert.strictEqual(t.$('act-ai-status').textContent, 'Done, 1 failed');
  assert.strictEqual(t.button().state, 'need');
});

test('a clean finish stays as a quiet result: no colour, no count, until dismissed', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  t.server.queue = { ...RUNNING, done: 3, active: [], pending: [], pendingCount: 0 };
  await t.tick();
  assert.strictEqual(t.$('act-ai-status').textContent, 'Done');
  assert.strictEqual(t.$('act-ai-detail').innerHTML, '3 files scanned');
  assert.strictEqual(t.$('act-sec-ai').dataset.tone, 'done');
  assert.deepStrictEqual([t.button().state, t.button().badge, t.button().ring], ['idle', '', false]);
  assert.strictEqual(t.$('activityIdle').hidden, false, 'Nothing is running');
  const clear = [...t.timeouts.values()].find(x => x.ms === 4000);
  assert.ok(clear, 'the (empty) list is still forgotten on the server');
  clear.f();
  await new Promise(r => setImmediate(r));
  assert.ok(t.server.log.includes('POST /api/import/failures/clear'));
  assert.ok(t.$('act-sec-ai'), 'the result stays');
  t.act.act('ai', 'dismiss');
  assert.strictEqual(t.$('act-sec-ai'), null);
});

test('Cancel takes the section away; files still finishing do not bring it back', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  t.$('scanCancelBtn').click();
  t.$('scanCancelBtn').click();
  await t.tick();
  assert.ok(t.server.log.includes('POST /api/import/queue/cancel'));
  assert.strictEqual(t.$('act-sec-ai'), null);
  t.server.queue = { ...RUNNING, pending: [], pendingCount: 0 };
  await t.tick();
  assert.strictEqual(t.$('act-sec-ai'), null);
});

test('Modern: no emoji in anything the panel or its section draws; Classic keeps them', async () => {
  for (const modern of [true, false]) {
    const t = load({ modern });
    t.server.queue = { ...RUNNING, done: 2, failed: 1, active: [], pending: [], pendingCount: 0 };
    t.server.failures = { failed: { total: 1, groups: [{ key: 'other', label: 'Other', explain: 'x', count: 1,
      sample: [{ id: 1, filename: 'a.mp4', folder: 'D:\\', error: 'e' }] }] }, waiting: { count: 0, sample: [] } };
    await t.fire('DOMContentLoaded');
    t.act.openView('ai');
    await t.tick();
    const html = t.$('scanAiPane').innerHTML + t.$('scanGroups').innerHTML + t.$('scanHeadIco').innerHTML
      + t.$('act-sec-ai').innerHTML + t.$('act-ai-ic').innerHTML + t.$('activityWrap').innerHTML;
    if (modern) assert.ok(!EMOJI.test(modernText(html)), modernText(html).match(EMOJI)?.[0]);
    else assert.ok(EMOJI.test(html), 'Classic keeps its emoji');
  }
});

test('a tab that empties gives way: Waiting picked, then the run ends with failures', async () => {
  const t = load();
  t.server.queue = { ...RUNNING, active: [], pendingCount: 2, paused: true, pausedBy: 'waiting',
    waiting: { count: 2, code: 'policy-wait', reason: 'vis is not loaded.', since: 9 } };
  await t.fire('DOMContentLoaded');
  t.act.openView('ai');
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
  assert.strictEqual(t.act.viewing(), 'ai', 'the view the user is in stays');
});

/* ── The dropdown itself ───────────────────────────────────────────────── */

test('the dropdown: aria on the button, Escape and an outside click close it, a click inside does not', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  const btn = t.$('activityBtn');
  const html = t.$('activityWrap').innerHTML;
  assert.match(html, /id="activityBtn" aria-haspopup="dialog" aria-expanded="false"\s+aria-controls="activityPop"/);
  assert.match(html, /id="activityPop" role="dialog" aria-label="Activity" hidden/);
  btn.click();
  assert.strictEqual(t.$('activityPop').hidden, false);
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'true');
  // A click inside (the stepper, the model picker, a tab) leaves it open.
  t.ctx.eventPathHasNode = (e, node) => !!e.inside && node === t.$('activityWrap');
  await t.fire('mousedown', { inside: true });
  assert.strictEqual(t.$('activityPop').hidden, false);
  await t.fire('mousedown', { inside: false });
  assert.strictEqual(t.$('activityPop').hidden, true, 'an outside click closes it');
  btn.click();
  await t.fire('keydown', { key: 'Escape' });
  assert.strictEqual(t.$('activityPop').hidden, true, 'Escape closes it');
  assert.strictEqual(btn.getAttribute('aria-expanded'), 'false');
  // Every open starts on the list.
  t.act.openView('ai');
  t.act.toggle(false);
  t.act.toggle(true);
  assert.strictEqual(t.$('activityMain').hidden, false);
  assert.strictEqual(t.act.viewing(), null);
});

test('jobs are listed in a fixed order, the ring follows the AI scan, the count counts running jobs', async () => {
  const t = load();
  await t.fire('DOMContentLoaded');
  t.act.set('share', { title: 'Share privately', running: true, tone: 'work', status: 'Packing 40%', pct: 40 });
  assert.strictEqual(t.button().ringDash, '40.0 100', 'the only running job drives the ring');
  t.server.queue = { ...RUNNING, done: 1, failed: 1, total: 4 };
  t.ctx.vaultWatchScanQueue({ fresh: true });
  await t.tick();
  assert.strictEqual(t.button().ringDash, '50.0 100', 'the AI scan drives it while it runs');
  assert.strictEqual(t.button().badge, '2');
  const order = t.$('activityList').children.map(c => c.dataset.job);
  assert.deepStrictEqual(order, ['ai', 'share'], 'AI scan first whatever started first');
  t.act.set('share', { title: 'Share privately', running: false, tone: 'wait', status: 'Ready to check', pct: null });
  assert.strictEqual(t.button().state, 'wait', 'a share ready to check is amber');
  assert.strictEqual(t.button().badge, '1');
  t.act.drop('share');
  assert.deepStrictEqual(t.$('activityList').children.map(c => c.dataset.job), ['ai']);
  // A share packing beside ones ready to check is amber but still running;
  // a held job (paused) counts for the badge but the words say waiting.
  t.act.set('share', { title: 'Share privately', running: true, tone: 'wait', status: 'Packing 10%', pct: 10 });
  t.act.set('faces', { title: 'Face search', running: true, held: true, tone: 'wait', status: 'Paused', pct: 5 });
  assert.strictEqual(t.button().label, 'Activity: 2 running, 1 waiting');
  assert.strictEqual(t.button().badge, '3');
});

/* ── Settings > General > AI scan ──────────────────────────────────────── */

test('AI scan Auto holding for playback: amber "Waiting for playback to stop", no Try now, no LM Studio button, no toast', async () => {
  const t = load();
  t.server.queue = { ...RUNNING, active: [], pendingCount: 3, paused: true, pausedBy: 'waiting',
    waiting: { count: 3, code: 'playback', reason: 'AI scan is set to Auto, so files wait while something plays.', since: null } };
  await t.fire('DOMContentLoaded');
  assert.strictEqual(t.$('act-ai-status').textContent, 'Waiting for playback to stop');
  assert.strictEqual(t.$('act-sec-ai').dataset.tone, 'wait');
  assert.strictEqual(t.button().state, 'wait');
  assert.ok(!/data-act="pause"/.test(t.$('act-ai-acts').innerHTML), 'nothing to try from the section either');
  assert.match(t.$('scanWaitLine').innerHTML, /Waiting for playback to stop/);
  assert.match(t.$('scanWaitBox').innerHTML, /Waiting for playback to stop/);
  assert.strictEqual(t.$('scanPauseBtn').hidden, true, 'it starts by itself: nothing to try');
  assert.strictEqual(t.$('scanOpenLms').hidden, true);
  assert.deepStrictEqual(t.toasts, [], 'no toast');
});

test('AI scan Off: no AI scan section, no scan toasts, no polling for it', async () => {
  const t = load();
  t.ctx.vaultAiScan = { isOff: () => true, isAuto: () => false, mode: () => 'off' };
  t.server.queue = { ...RUNNING, halt: { at: 9, reason: 'Model unavailable' },
    waiting: { count: 1, code: 'no-room', reason: 'x', since: 5 } };
  t.server.summary = { active: 1, queued: 2, waiting: 0, failed: 0, done: 0, total: 3 };
  await t.fire('DOMContentLoaded');
  for (let i = 0; i < 5; i++) await t.tick();
  t.ctx.vaultWatchScanQueue({ fresh: true });
  await t.tick();
  assert.strictEqual(t.$('act-sec-ai'), null, 'no AI scan section');
  assert.strictEqual(t.button().state, 'idle');
  assert.deepStrictEqual(t.toasts, []);
  assert.ok(!t.server.log.some(l => l.startsWith('GET /api/import/queue')), 'never asked');
});

test('AI scan switched Off while a run shows: the section goes', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  assert.ok(t.$('act-sec-ai'));
  t.ctx.vaultAiScan = { isOff: () => true, isAuto: () => false, mode: () => 'off' };
  await t.tick();
  assert.strictEqual(t.$('act-sec-ai'), null);
  assert.strictEqual(t.button().badge, '');
});

/* ── Callers ───────────────────────────────────────────────────────────── */

test('callers point at the Activity button instead of opening anything', () => {
  const sel = read('selection.js');
  assert.match(sel, /vaultWatchScanQueue\(\{ fresh: true, pulse: true \}\)/);
  assert.ok(!/Surface the scan panel/.test(sel));
  assert.ok(!/queuePanelStack\(\)\.appendChild/.test(sel.replace(/\(act \? act\.host\(\) : queuePanelStack\(\)\)\.appendChild/, '')), 'the delete queue goes under Activity');
  const faces = read('faces.js');
  assert.ok(!/fsq-hide|fsw-hide|facesScan\.hidden/.test(faces), 'no Hide in the face panes');
  assert.ok(!/the scan panel shows how it goes/.test(faces));
  const imp = read('importer.js');
  assert.ok(!/_scanDismissed|scanHideBtn/.test(imp), 'no Hide, no dismissed flag');
  assert.match(read('settings.js'), /vaultActivity\.running\('ai'\)/, 'the Backend poll asks the button, not the panel');
});

/* ── Adding files: overlapping adds ────────────────────────────────────── */

/**
 * importPanel() out of importer.js (its run number, timer and failure list
 * with it), run in the same VM as the Activity button.
 */
function loadImportPanel() {
  const t = load();
  const src = read('importer.js');
  const a = src.indexOf('  let _importRun = 0;');
  const b = src.indexOf('  /* ── AI scan panel');
  assert.ok(a > 0 && b > a, 'importPanel found');
  t.ctx.fmtN = (v) => String(Number(v) || 0);
  vm.runInContext(`${src.slice(a, b)}\nwindow.__importPanel = importPanel;`, t.ctx);
  /** Run the timers set for this long, as if that much time passed. */
  t.runTimers = (ms) => {
    for (const [id, x] of [...t.timeouts]) if (x.ms === ms) { t.timeouts.delete(id); x.f(); }
  };
  t.panel = (n) => t.ctx.__importPanel(n, 'Adding');
  t.sec = () => t.act.get('import') || null;
  return t;
}

test('adding files: a clean add\'s timer cannot take away a newer add that failed; the failure stays red until dismissed', async () => {
  const t = loadImportPanel();
  await t.fire('DOMContentLoaded');
  const p1 = t.panel(1);
  p1.update(1, 'a.mp4');
  p1.finish(1);
  assert.strictEqual(t.sec().tone, 'done');
  // 1.4 s later another add, whose add-paths answers 500.
  const p2 = t.panel(1);
  p2.update(1, 'b.mp4');
  p2.fail('1 file', 'The server answered 500');
  p2.finish(0);
  // The first add's 3 s timer would have gone off now.
  t.runTimers(3000);
  const s = t.sec();
  assert.ok(s, 'the newer add\'s section is still there');
  assert.deepStrictEqual([s.tone, s.status, s.detail], ['need', 'Nothing added', '1 could not be added']);
  assert.strictEqual(t.button().label, 'Activity: 1 needs you');
  const view = t.$('importQueuePanel');
  assert.ok(view && !view.removed, 'the failure list is still in the dropdown');
  assert.strictEqual(s.view, view, 'and Open reaches it');
  assert.match(view.innerHTML, /1 file/);
  // Only Dismiss takes it away.
  t.act.act('import', 'dismiss');
  assert.strictEqual(t.sec(), null);
  assert.ok(view.removed);
  // A later clean add starts with nothing failed.
  const p3 = t.panel(1);
  p3.finish(1);
  assert.strictEqual(t.sec().tone, 'done');
});

test('adding files: a failed add is carried into the next add, and an older add failing late turns the newer result red', async () => {
  const t = loadImportPanel();
  await t.fire('DOMContentLoaded');
  const p1 = t.panel(2);
  p1.fail('1 file', 'No such folder');
  p1.finish(1);
  assert.strictEqual(t.sec().tone, 'need');
  // A new add before the failure was dismissed: it keeps the failure.
  const p2 = t.panel(1);
  p2.update(1, 'c.mp4');
  assert.match(t.sec().detail, /1 failed/);
  p2.finish(1);
  assert.deepStrictEqual([t.sec().tone, t.sec().detail], ['need', '1 could not be added']);
  assert.ok(![...t.timeouts.values()].some(x => x.ms === 3000), 'no timer takes a red result away');
  t.act.act('import', 'dismiss');
  // Two adds at once: the older one is still answering when the newer one ends clean.
  const old = t.panel(5);
  old.update(1, 'd.mp4');
  const late = t.panel(1);
  late.finish(1);
  assert.strictEqual(t.sec().tone, 'done');
  old.update(5, 'e.mp4');
  assert.strictEqual(t.sec().status, 'Added 1 of 1', 'the older add draws nothing over the newer one');
  old.fail('2 files', 'The server answered 500');
  assert.deepStrictEqual([t.sec().tone, t.sec().detail], ['need', '1 could not be added'], 'its failure (one row) shows on the newer result');
  t.runTimers(3000);
  assert.ok(t.sec(), 'and the clean timer no longer takes it away');
  old.finish(3);
  assert.strictEqual(t.sec().status, 'Added 1 of 1', 'the older add\'s end draws nothing either');
});

/* ── Held, waiting for you, and focus ──────────────────────────────────── */

test('a paused face model switch reads as waiting only; every section that can pause says held', async () => {
  const t = load();
  await t.fire('DOMContentLoaded');
  // The shape facesSwitchPanePaint gives a paused switch.
  const faces = read('faces.js');
  const sw = faces.split('function facesSwitchPanePaint(')[1].split('\nfunction ')[0];
  assert.match(sw, /held: !!\(sw && sw\.paused\)/, 'the switch says held while paused');
  const scan = faces.split('function facesScanPaint(')[1].split('\nfunction ')[0];
  assert.match(scan, /held: !!\(q\.running && q\.paused\)/);
  assert.match(read('selection.js'), /held: !allDone && !!_dq\.paused/);
  assert.match(read('importer.js'), /running: true, held: tone !== 'work'/);
  t.act.set('faces', { title: 'Face search', running: true, held: true, tone: 'wait', status: 'Paused', pct: 30 });
  assert.strictEqual(t.button().label, 'Activity: 1 waiting');
  assert.strictEqual(t.button().badge, '1');
  t.act.set('faces', { title: 'Face search', running: true, held: false, tone: 'work', status: '3 of 10', pct: 30 });
  assert.strictEqual(t.button().label, 'Activity: 1 running');
});

test('things waiting for you are counted in amber when nothing runs and nothing is red', async () => {
  const t = load();
  await t.fire('DOMContentLoaded');
  t.act.set('share', { title: 'Share privately', running: false, tone: 'wait', waitCount: 5, status: 'Ready to check', pct: null });
  assert.deepStrictEqual([t.button().state, t.button().badge, t.button().badgeTone], ['wait', '5', 'wait'], 'each share ready to check counts');
  assert.strictEqual(t.button().label, 'Activity: 5 waiting for you');
  // Red still comes first.
  t.act.set('import', { title: 'Adding files', running: false, tone: 'need', status: 'Nothing added', pct: null });
  assert.deepStrictEqual([t.button().state, t.button().badge, t.button().badgeTone], ['need', '1', 'need']);
  assert.strictEqual(t.button().label, 'Activity: 5 waiting for you, 1 needs you');
  t.act.drop('import');
  // Something running: the count is the running jobs, as before.
  t.act.set('faces', { title: 'Face search', running: true, tone: 'work', status: '1 of 4', pct: 25 });
  assert.deepStrictEqual([t.button().badge, t.button().label], ['1', 'Activity: 1 running, 5 waiting for you']);
  t.act.drop('faces');
  // A share packing beside ones ready: running, and they still wait for you.
  t.act.set('share', { title: 'Share privately', running: true, tone: 'wait', waitCount: 2, status: 'Packing 5%', pct: 5 });
  assert.deepStrictEqual([t.button().badge, t.button().label], ['1', 'Activity: 1 running, 2 waiting for you']);
});

test('focus: Cancel in the AI scan view and a section\'s dismiss leave focus in the dropdown, or on the button when nothing is left', async () => {
  const t = load();
  t.server.queue = RUNNING;
  await t.fire('DOMContentLoaded');
  const doc = t.dom.document;
  doc.activeElement = doc.body;
  t.act.set('share', { title: 'Share privately', running: false, tone: 'wait', waitCount: 1, status: 'Ready to check', pct: null,
    actions: [{ key: 'shares', label: 'My shares', run: noop }] });
  t.act.toggle(true);
  t.act.openView('ai');
  assert.strictEqual(doc.activeElement, t.$('activityBack'));
  // Cancel: the pane is emptied (its button with it), then the section goes.
  const cancel = t.$('scanCancelBtn') || t.$('scanAiPane').querySelector('#scanCancelBtn');
  cancel.focus();
  t.ctx.vaultScanPane.drop('ai');
  assert.strictEqual(t.act.viewing(), null, 'back on the list');
  assert.strictEqual(doc.activeElement, t.$('act-share-b-shares'), 'on the next section\'s first control');
  // A dismiss on the last section: the button.
  t.act.set('share', { title: 'Share privately', running: false, tone: 'done', status: 'Done', pct: null, dismiss: () => t.act.drop('share') });
  t.$('act-share-x').focus();
  t.act.act('share', 'dismiss');
  assert.strictEqual(doc.activeElement, t.$('activityBtn'), 'nothing left: the Activity button');
  // A drop the person was not on leaves their focus alone.
  t.act.set('share', { title: 'Share privately', running: false, tone: 'done', status: 'Done', pct: null });
  const field = new t.dom.El('input');
  t.dom.document.body.appendChild(field);
  field.focus();
  t.act.drop('share');
  assert.strictEqual(doc.activeElement, field);
});
