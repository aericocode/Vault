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
  assert.strictEqual(t.button().label, 'Activity: 2 running, 2 waiting');
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
