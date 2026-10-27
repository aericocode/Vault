/**
 * What the Vault tab hands mpv Stage to play on its own (player-lib/
 * stage-control.js computeUpcoming, sendUpcoming, onStarted), and the
 * queue's own guards (player-lib/player/player-core.js queueNav,
 * autoAdvance). The beta.2 reports: a file ends and the next one does not
 * play, with the tab in the background or just after Up next was edited.
 *
 *  - the list is long (the rest of the list and Up next), so Stage keeps
 *    going with the tab throttled or frozen
 *  - rows that cannot be loaded never send a shorter or empty list (Stage
 *    keeps its own), and it is tried again
 *  - a file Up next played is given up before the next list is worked out
 *    (it would play again)
 *  - a queue move that hangs gives way; a file ending whose next file cannot
 *    load is tried again, never left stopped
 *
 * stage-control.js and parts of player-core.js run in a VM with a fake page.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** A list of n videos (ids 101...), as the Library holds it. */
function fakeLibrary(n) {
  const ids = Uint32Array.from({ length: n }, (_, i) => 101 + i);
  const rows = new Map([...ids].map((id, i) => [id, { id, filepath: `C:/clips/${id}.mp4`, filename: `${id}.mp4`, media_type: 'video', duration_seconds: 30 + i }]));
  rows.set(50, { id: 50, filepath: 'C:/clips/50.mp4', filename: '50.mp4', media_type: 'video', duration_seconds: 20 });
  const lib = {
    failRows: false,
    TYPE_NAMES: ['', 'video', 'audio', 'image', 'gif', 'mix', 'document'],
    spec: { collectionId: null },
    ids, types: Uint8Array.from(ids, () => 1),
    known: () => true, length: () => ids.length, idAt: (i) => ids[i], indexOf: (id) => ids.indexOf(id),
    typeAt: () => 'video', rowAt: (i) => rows.get(ids[i]) || null, row: (id) => rows.get(id) || null,
    needsFetch: () => false,
    waitIds: async () => ids,
    fetchRows: async (want, o = {}) => {
      if (lib.failRows && o.strict) throw Object.assign(new Error('rows unavailable'), { name: 'RowsUnavailable' });
      return [...want].map(id => rows.get(id) || null);
    },
    rowsForRange: async (a, b, o) => lib.fetchRows([...ids.subarray(a, b)], o),
  };
  return lib;
}

/** stage-control.js in a VM, mpv Stage open with the list's first file playing. */
function page({ n = 40, upNext = [], hub = null, loadFailures = 0, loadDelay = 0 } = {}) {
  let fails = loadFailures;
  const sent = [];
  const streams = [];
  const lib = fakeLibrary(n);
  let un = upNext.map(id => ({ id }));
  const takes = [];
  const UpNext = {
    items: () => un.slice(), count: () => un.length, ids: () => un.map(i => i.id),
    take: (id) => new Promise((resolve) => { takes.push(() => { un = un.filter(i => i.id !== id); resolve(); }); }),
    add: (id) => { un.push({ id }); },
    playerChanged() {}, closePopover() {},
  };
  class FakeEventSource {
    constructor() { this.on = {}; this.readyState = 1; streams.push(this); }
    addEventListener(name, fn) { this.on[name] = fn; }
    close() { this.readyState = 2; }
    emit(name, data) { if (this.on[name]) this.on[name]({ data: JSON.stringify(data) }); }
  }
  FakeEventSource.CLOSED = 2;
  const classes = new Set();
  const doc = {
    body: { classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle() {} } },
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => (id === 'miniPlayer' ? { classList: { add() {}, remove() {}, contains: () => false } } : id === 'miniPlayerMedia' ? { innerHTML: '' } : null),
    querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => null, hidden: true, style: {} }),
  };
  let stageOpen = false;
  const ctx = {
    document: doc, window: { addEventListener() {} }, console: { ...console, warn() {} }, setTimeout, clearTimeout, setInterval: () => 0,
    Promise, JSON, Math, Date, Error, TypeError, Event, EventTarget, Map, Set, Uint32Array, Uint8Array, Array,
    MutationObserver: class { observe() {} },
    EventSource: FakeEventSource,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    showToast() {},
    currentMediaState: { type: 'video', currentIndex: 0 },
    Library: lib, UpNext,
    listAnchorIndex: () => 0,
    repeatMode: () => 'off',
    noteFileOpened() {},
    queueNav: (fn) => fn(),
    miniPlayerOpen() {},
    fetch: async (url, o) => {
      const ok = (data) => ({ ok: true, status: 200, json: async () => data });
      if (url === '/api/stage/state') return ok({ open: stageOpen, mpv: { found: true, choice: 'mpv' }, settings: { tips: false } });
      if (url === '/api/stage/open') { stageOpen = true; return ok({ ok: true, mode: 'mpv' }); }
      if (url === '/api/stage/cmd') {
        const body = JSON.parse(o.body);
        if (body.type === 'load' && loadDelay) await wait(loadDelay);
        if (body.type === 'load' && fails > 0) { fails--; return { ok: false, status: 503, json: async () => ({ error: 'busy' }) }; }
        sent.push(body);
        if (!hub) return ok({ ok: true });
        // The real hub's rules (a list for a file it is not on is stale).
        const r = hub.command(body);
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      }
      return ok({});
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/stage-rules.js')}\n${read('player-lib/stage-control.js')}\nglobalThis.__sc = StageControl;`, ctx);
  const stream = () => streams[streams.length - 1];
  async function open() {
    await wait(10);
    await ctx.__sc.openStage();
    stream().emit('sync', { open: true, volume: 1, current: { key: 'k1', id: 101, filename: '101.mp4', media_type: 'video' }, status: { key: 'k1', t: 3, d: 30, paused: false, state: 'playing' } });
    await wait(150);
  }
  const lists = () => sent.filter(c => c.type === 'upcoming');
  return { SC: ctx.__sc, ctx, lib, sent, lists, stream, open, takes, UpNext };
}

test('Stage is handed the rest of the list (and Up next) at once, not two files: it plays on with this tab asleep', async () => {
  const p = page({ n: 40, upNext: [50] });
  await p.open();
  const l = p.lists().at(-1);
  assert.ok(l, 'a list went');
  assert.strictEqual(l.forKey, 'k1');
  assert.deepStrictEqual(l.upcoming.slice(0, 3).map(u => u.id), [50, 102, 103], 'Up next first, then the list from its anchor');
  assert.strictEqual(l.upcoming.length, 40, 'Up next and every list file after the one on Stage');
  assert.deepStrictEqual([...new Set(l.upcoming.map(u => u.key))].length, 40, 'each with its own key');
});

test('rows that cannot be loaded: nothing is sent (never a shorter or empty list over a good one), and it is tried again', async () => {
  const p = page({ n: 12 });
  await p.open();
  const before = p.lists().length;
  assert.ok(before >= 1);
  p.lib.failRows = true;
  p.SC.upNextChanged();
  await wait(300);
  assert.strictEqual(p.lists().length, before, 'no list sent while the rows cannot load');
  p.lib.failRows = false;
  await wait(2300);
  assert.strictEqual(p.lists().length, before + 1, 'tried again once they can');
  assert.strictEqual(p.lists().at(-1).upcoming.length, 11);
  const src = read('player-lib/stage-control.js');
  assert.ok(!/catch\(\(\) => \[\]\)/.test(src.slice(src.indexOf('async function computeUpcoming('), src.indexOf('async function sendList('))), 'no failure turned into an empty list');
});

test('a file Up next played is given up before the next list is worked out: it never comes round again', async () => {
  const p = page({ n: 6, upNext: [50] });
  await p.open();
  assert.strictEqual(p.lists().at(-1).upcoming[0].id, 50);
  const key = p.lists().at(-1).upcoming[0].key;
  const before = p.lists().length;
  // Stage moved on by itself to the Up next file.
  p.stream().emit('started', { item: { key, id: 50, filename: '50.mp4', media_type: 'video', via: 'upnext' }, auto: true });
  await wait(200);
  assert.strictEqual(p.lists().length, before, 'no list while Up next still has the file');
  assert.strictEqual(p.takes.length, 1, 'Up next was asked to give it up');
  p.takes[0]();
  await wait(200);
  const l = p.lists().at(-1);
  assert.strictEqual(p.lists().length, before + 1);
  assert.strictEqual(l.forKey, key, 'for the file on Stage now');
  assert.ok(!l.upcoming.some(u => u.id === 50), 'the file just played is not in it');
});

test('a list file whose row is not loaded yet ends the list there (never passed over unseen)', () => {
  const R = require('../player-lib/stage-rules.js');
  const plan = R.upcoming({ anchor: 0, length: 10, okAt: (i) => (i < 5 ? true : null), repeat: 'off', count: 500 });
  assert.deepStrictEqual(plan.map(x => x.index), [1, 2, 3, 4]);
});

/* ── The queue (player-core.js) ────────────────────────────────────────── */

function grab(src, start) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, start);
  let depth = 0;
  // From the body's brace (after the parameters, which may hold { } defaults).
  for (let j = src.indexOf(') {', i) + 2; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`no end for ${start}`);
}

function core(extra = {}) {
  const src = read('player-lib/player/player-core.js');
  const toasts = [];
  const ctx = { setTimeout, clearTimeout, Promise, Error, console, showToast: (m) => toasts.push(String(m)), ...extra };
  vm.createContext(ctx);
  const nav = src.slice(src.indexOf('const NAV_STEP_MS'), src.indexOf('function queueList('));
  vm.runInContext(`${nav.replace(/\r/g, '')}
let _fileOpenedSeq = 0;
let _autoAdvanceGen = 0;
${grab(src, 'function playNextMediaOrWrap(')}
const AUTO_RETRY_MS = [30, 30, 30, 30];
${grab(src, 'function autoAdvance(').replace(/\r/g, '')}
globalThis.__q = { queueNav, autoAdvance, opened: () => { _fileOpenedSeq++; } };`, ctx);
  return { ...ctx.__q, toasts, ctx };
}

test('queueNav: a move that never settles gives way after a while, and the moves behind it run', async () => {
  const src = read('player-lib/player/player-core.js');
  assert.match(src, /const NAV_STEP_MS = 20000;/);
  const short = src.replace('const NAV_STEP_MS = 20000;', 'const NAV_STEP_MS = 50;');
  const ctx = { setTimeout, clearTimeout, Promise, Error };
  vm.createContext(ctx);
  vm.runInContext(`${short.slice(short.indexOf('const NAV_STEP_MS'), short.indexOf('function queueList(')).replace(/\r/g, '')}\nglobalThis.__n = queueNav;`, ctx);
  const ran = [];
  const hung = ctx.__n(() => new Promise(() => {}));
  const next = ctx.__n(async () => { ran.push('next'); return true; });
  await assert.rejects(hung, (e) => e.name === 'TimeoutError');
  assert.strictEqual(await next, true);
  assert.deepStrictEqual(ran, ['next']);
});

test('a file ends and the next one cannot load (or the move hangs): tried again, never just stopped; the end of the list is not retried', async () => {
  let answers = ['stopped', 'stopped', true];
  const q = core({ queueMove: async () => answers.shift() });
  q.ctx.queueMove = async () => answers.shift();
  vm.runInContext('queueMove = globalThis.queueMove;', q.ctx);
  await q.autoAdvance();
  await wait(150);
  assert.deepStrictEqual(answers, [], 'tried until it moved');
  // A hung move (rejected by queueNav) is tried again too.
  answers = [];
  let calls = 0;
  q.ctx.queueMove = async () => { calls++; if (calls === 1) throw Object.assign(new Error('late'), { name: 'TimeoutError' }); return true; };
  vm.runInContext('queueMove = globalThis.queueMove;', q.ctx);
  await q.autoAdvance();
  await wait(100);
  assert.strictEqual(calls, 2);
  // The end of the list: once, no retry.
  calls = 0;
  q.ctx.queueMove = async () => { calls++; return false; };
  vm.runInContext('queueMove = globalThis.queueMove;', q.ctx);
  await q.autoAdvance();
  await wait(150);
  assert.strictEqual(calls, 1);
  // Never past the retries: it says so.
  q.ctx.queueMove = async () => 'stopped';
  vm.runInContext('queueMove = globalThis.queueMove;', q.ctx);
  await q.autoAdvance();
  await wait(400);
  assert.match(q.toasts.at(-1), /Playback stopped: Vault could not open the next file/);
  // Something else played meanwhile: the retry stands down.
  calls = 0;
  q.ctx.queueMove = async () => { calls++; return 'stopped'; };
  vm.runInContext('queueMove = globalThis.queueMove;', q.ctx);
  await q.autoAdvance();
  q.opened();
  await wait(150);
  assert.strictEqual(calls, 1);
});

test('player-core: Up next not loading is "stopped" (tried again), handleMediaError and Basic retry it rather than close', () => {
  const src = read('player-lib/player/player-core.js');
  assert.match(src, /if \(head === 'stopped'\) return 'stopped';/);
  assert.match(src, /if \(moved === 'stopped'\) \{ later\(\); return; \}/);
  assert.match(src, /function autoAdvanceOnEnded\(\) \{[\s\S]*?if \(isRepeatOne\(\)\) return;\s*autoAdvance\(\);/);
  const sc = read('player-lib/stage-control.js');
  assert.match(sc, /if \(moved === 'stopped'\) \{ later\(\); return; \}/);
});

/* ── Basic Stage: one video element for every file (player-core.js, player-video.js) ── */

test('Basic Stage: the next video loads into the same element (its picture-in-picture window stays); its old listeners come off, so a file ending moves on once', () => {
  const src = read('player-lib/player/player-video.js');
  let advanced = 0;
  class FakeVideo extends EventTarget {
    constructor() { super(); this.tagName = 'VIDEO'; this.dataset = { maximizeAt: '5' }; this.src = ''; this.isConnected = true; }
  }
  const video = new FakeVideo();
  const content = { innerHTML: 'old' };
  const ctx = {
    document: { getElementById: (id) => (id === 'mediaVideo' ? video : null) },
    currentMediaState: {}, window: {}, location: { protocol: 'http:' },
    bindMediaError() {}, videoControlsHtml: () => '', isRepeatOne: () => false, setupAudioBoost() {}, applyVolume() {}, sliderToVolume: () => 1,
    savedVolume: 1, updateVolumeDisplay() {}, playerIsSilent: () => false, applySpeedTo() {}, updateSpeedDisplay() {}, attachTailWatchdog() {},
    syncPlayPauseButton() {}, autoAdvanceOnEnded: () => { advanced++; }, wireVideoControls() {}, attachPlaybackSource() {},
    handleVideoClick() {}, handleVideoDoubleClick() {}, updateTotalTimeLabel() {}, formatDuration: () => '',
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab(src, 'function renderVideoPlayer(')}\n${grab(src, 'function _unbindVideoPlayer(')}\nglobalThis.__r = renderVideoPlayer;`, ctx);
  ctx.__r(content, { innerHTML: '' }, 'u', 'C:/a.mp4', 'a.mp4', false, true);
  ctx.__r(content, { innerHTML: '' }, 'u', 'C:/b.mp4', 'b.mp4', false, true, { reuse: video });
  ctx.__r(content, { innerHTML: '' }, 'u', 'C:/c.mp4', 'c.mp4', false, true, { reuse: video });
  assert.strictEqual(ctx.currentMediaState.element, video, 'the same element plays the next file');
  video.dispatchEvent(new Event('ended'));
  assert.strictEqual(advanced, 1, 'one move on, not one per file it played');
  assert.strictEqual(video.dataset.maximizeAt, undefined, 'nothing of the file before carried over');
  // The page side: Basic Stage keeps the element in the page and in picture-in-picture.
  const coreSrc = read('player-lib/player/player-core.js');
  assert.match(coreSrc, /const reuseEl = keepMini && media_type === 'video' && miniBoxEl\s*&& typeof StageControl !== 'undefined' && typeof StageControl\.basicOn === 'function' && StageControl\.basicOn\(\)/);
  assert.match(coreSrc, /reuseEl\._keepForNext = true;\s*stopMediaElement\(reuseEl\);/);
  assert.match(coreSrc, /if \(document\.pictureInPictureElement === el && !el\._pipCarry && !keep\) document\.exitPictureInPicture\(\)/);
  assert.match(coreSrc, /if \(element\.parentNode === miniMedia\) \{/, 'minimizePlayer never takes it out of the page');
  assert.match(coreSrc, /renderVideoPlayer\(content, controls, fileUrl, filepath, filename, hasPrev, hasNext, \{ reuse: reuseEl \}\)/);
  // Its sound keeps running through the audio graph it already has.
  assert.match(src, /const had = video\._boost;/);
  assert.match(coreSrc, /!\(reuseEl && reuseEl\._boost && reuseEl\._boost\.audioContext === currentMediaState\.audioContext\)/);
});

/* ── Verifier follow-ups ────────────────────────────────────────────────── */

for (const [name, opts] of [['the load answered 503 once, then tried again', { loadFailures: 1 }], ['a slow load (300 ms)', { loadDelay: 300 }]]) {
  test(`an Up next edit while the file's load is on its way (${name}): Stage ends with the edited list (the real hub's stale rule)`, async () => {
    const { createHub } = require('../lib/stage/hub');
    const hub = createHub({ heartbeatMs: 0, settings: { get: () => ({}), sizes: ['free'] }, stage: { alive: () => true, command() {} } });
    hub.opened('mpv');
    // Stage is on the file before.
    hub.command({ type: 'load', item: { key: 'k0', id: 101, media_type: 'video', filename: '101.mp4' }, upcoming: [] });
    const p = page({ n: 20, hub, ...opts });
    await wait(10);
    await p.SC.openStage();
    p.stream().emit('sync', { open: true, volume: 1, current: null, status: null });
    await wait(50);
    p.SC.intercept({ id: 104, filepath: 'C:/clips/104.mp4', filename: '104.mp4', media_type: 'video' }, {});
    await wait(20);
    p.UpNext.add(50);
    p.SC.upNextChanged();
    await wait(2500);
    const st = hub.state();
    assert.strictEqual(st.current.id, 104);
    assert.strictEqual(st.upcoming[0] && st.upcoming[0].id, 50, `the edit is on Stage: ${JSON.stringify(st.upcoming.slice(0, 3).map(u => u.id))}`);
    assert.ok(st.upcoming.length >= 16);
  });
}

test('hub: a load sent twice (tried again after a network error the first got through) plays once; a bad item says what is wrong', () => {
  const { createHub, validateCommand, MAX_UPCOMING } = require('../lib/stage/hub');
  const cmds = [];
  const hub = createHub({ heartbeatMs: 0, settings: { get: () => ({}), sizes: ['free'] }, stage: { alive: () => true, command: (c) => cmds.push(c.type) } });
  hub.opened('mpv');
  const load = { type: 'load', item: { key: 'kA', id: 1, media_type: 'video', filename: 'a.mp4' }, upcoming: [] };
  assert.strictEqual(hub.command(load).status, 200);
  assert.deepStrictEqual(hub.command(load).body, { ok: true, duplicate: true });
  assert.deepStrictEqual(cmds, ['load'], 'the engine got it once: the file is not restarted');
  assert.strictEqual(hub.command({ ...load, item: { ...load.item, key: 'kB' } }).status, 200, 'a new load (new key) still goes');
  const good = { key: 'k1', id: 1, media_type: 'video', filename: 'a.mp4' };
  const e1 = validateCommand({ type: 'upcoming', upcoming: [good, { ...good, key: 'k2', media_type: 'document' }] });
  assert.match(e1.error, /^upcoming item 2 is not a file Stage can play/);
  const e2 = validateCommand({ type: 'upcoming', upcoming: new Array(MAX_UPCOMING + 1).fill(good) });
  assert.strictEqual(e2.error, `upcoming has ${MAX_UPCOMING + 1} items; Stage takes up to ${MAX_UPCOMING}.`);
  assert.strictEqual(validateCommand({ type: 'upcoming', upcoming: 'x' }).error, 'upcoming must be a list of items.');
});

test('queueNav gave way, then the move finished after all: the retry waits for it and stands down (one file ended, one move)', async () => {
  const src = read('player-lib/player/player-core.js').replace(/\r/g, '');
  const opened = [];
  let anchor = 0;
  let calls = 0;
  const ctx = { setTimeout, clearTimeout, Promise, Error, console, showToast() {},
    queueMove: async () => { calls++; const from = anchor; await wait(calls === 1 ? 80 : 5); anchor = from + 1; opened.push(from + 1); ctx.__q.opened(); return true; } };
  vm.createContext(ctx);
  const nav = src.slice(src.indexOf('const NAV_STEP_MS'), src.indexOf('function queueList(')).replace('const NAV_STEP_MS = 20000;', 'const NAV_STEP_MS = 50;');
  vm.runInContext(`${nav}\nlet _fileOpenedSeq = 0;\nlet _autoAdvanceGen = 0;\n${grab(src, 'function playNextMediaOrWrap(')}\nconst AUTO_RETRY_MS = [10, 10, 10, 10];\n${grab(src, 'function autoAdvance(')}\nglobalThis.__q = { autoAdvance, opened: () => { _fileOpenedSeq++; } };`, ctx);
  await ctx.__q.autoAdvance();
  await wait(300);
  assert.deepStrictEqual(opened, [1]);
  assert.strictEqual(calls, 1);
});
