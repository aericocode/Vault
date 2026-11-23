/**
 * Hands-free playback that stops, said out loud:
 *  - player-stream.js _startPlayback: the browser's autoplay block
 *    (NotAllowedError) on a file the queue moved to by itself logs a
 *    "[Vault next]" line and shows one toast (at most one a minute); an
 *    AbortError (a teardown, a newer source) stays quiet, as before;
 *  - player-core.js autoAdvanceDiag: a file ending that moved nowhere logs
 *    where the list stood, and never throws.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** One top-level function of a browser script, by how it starts. */
function grab(src, sig) {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `${sig} is there`);
  let depth = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${sig}: no end`);
}

/** A document whose tab can be hidden and shown (visibilitychange listeners). */
function fakeDocument(hidden) {
  const listeners = new Set();
  return {
    hidden,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'visibilitychange') listeners.delete(fn); },
    show() { this.hidden = false; for (const fn of [...listeners]) fn(); },
    hide() { this.hidden = true; for (const fn of [...listeners]) fn(); },
    listeners,
  };
}

function starter(source, { document } = {}) {
  const src = read('player-lib/player/player-stream.js');
  const warns = [];
  const toasts = [];
  const ctx = {
    console: { warn: (...a) => warns.push(a.join(' ')) },
    showToast: (m) => toasts.push(m),
    Date,
    currentMediaState: { element: null },
  };
  if (document) ctx.document = document;
  vm.createContext(ctx);
  vm.runInContext(`let lastPlaySource = ${JSON.stringify(source)};\nlet _autoplayToastAt = 0;\n${grab(src, 'function _startPlayback(')}\n${grab(src, 'function _playRefused(')}\n${src.includes('function _startWhenShown(') ? grab(src, 'function _startWhenShown(') : ''}\nglobalThis.__s = { _startPlayback, setSource: (s) => { lastPlaySource = s; } };`, ctx);
  return { ...ctx.__s, warns, toasts, ctx };
}

/** A media element whose play() the browser refuses while `doc` is hidden, and allows once shown (or never, with `always`). */
function hiddenRefusing(doc, { always = false } = {}) {
  const el = {
    isConnected: true, paused: true, plays: 0,
    play() {
      el.plays++;
      if (doc.hidden || always) { const e = new Error('blocked'); e.name = 'NotAllowedError'; return Promise.reject(e); }
      el.paused = false;
      return Promise.resolve();
    },
  };
  return el;
}

const refusing = (name) => ({ isConnected: true, play: () => { const e = new Error('blocked'); e.name = name; return Promise.reject(e); } });
const tick = () => new Promise(r => setImmediate(r));

test('autoplay blocked on a file the queue moved to: one line and one toast', async () => {
  const s = starter('auto');
  s._startPlayback(refusing('NotAllowedError'));
  await tick();
  assert.strictEqual(s.warns.length, 1);
  assert.match(s.warns[0], /^\[Vault next\] The browser blocked/);
  assert.strictEqual(s.toasts.length, 1);
  assert.doesNotMatch(s.toasts[0], /—/, 'no em dash in the copy');
  s._startPlayback(refusing('NotAllowedError'));
  await tick();
  assert.strictEqual(s.warns.length, 2, 'every refusal is logged');
  assert.strictEqual(s.toasts.length, 1, 'but the toast shows at most once a minute');
});

test('autoplay blocked on a file opened by hand: logged, no toast', async () => {
  const s = starter('user');
  s._startPlayback(refusing('NotAllowedError'));
  await tick();
  assert.strictEqual(s.warns.length, 1);
  assert.strictEqual(s.toasts.length, 0);
});

test('an aborted start (teardown, newer source) stays quiet; a start that works says nothing', async () => {
  const s = starter('auto');
  s._startPlayback(refusing('AbortError'));
  s._startPlayback({ isConnected: true, play: () => Promise.resolve() });
  s._startPlayback({ isConnected: false, play: () => { const e = new Error('x'); e.name = 'NotAllowedError'; return Promise.reject(e); } });
  await tick();
  assert.deepStrictEqual([s.warns, s.toasts], [[], []]);
});

test('a play() that throws at once (old browsers) is caught too', () => {
  const s = starter('auto');
  assert.doesNotThrow(() => s._startPlayback({ isConnected: true, play: () => { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; } }));
  assert.strictEqual(s.toasts.length, 1);
});

test('the queue moved on in a background tab and the browser refused the start: it starts when the tab is shown, no toast', async () => {
  const doc = fakeDocument(true);
  const s = starter('auto', { document: doc });
  const el = hiddenRefusing(doc);
  s.ctx.currentMediaState.element = el;
  s._startPlayback(el);
  await tick();
  assert.strictEqual(el.plays, 1);
  assert.strictEqual(el.paused, true, 'sits paused while the tab is hidden');
  assert.strictEqual(s.toasts.length, 0, 'no "press play" while nobody is looking');
  assert.strictEqual(s.warns.length, 1, 'still logged');
  doc.hide();                                                 // another visibilitychange while hidden: nothing
  assert.strictEqual(el.plays, 1);
  doc.show();
  await tick();
  assert.strictEqual(el.plays, 2, 'started again on show');
  assert.strictEqual(el.paused, false, 'and plays');
  assert.strictEqual(doc.listeners.size, 0, 'the listener is gone');
  assert.strictEqual(s.toasts.length, 0);
});

test('shown again but still refused: the toast says so then', async () => {
  const doc = fakeDocument(true);
  const s = starter('auto', { document: doc });
  const el = hiddenRefusing(doc, { always: true });
  s.ctx.currentMediaState.element = el;
  s._startPlayback(el);
  await tick();
  assert.strictEqual(s.toasts.length, 0);
  doc.show();
  await tick();
  assert.strictEqual(el.plays, 2);
  assert.strictEqual(s.toasts.length, 1, 'the refusal in a shown tab is the one the user hears about');
  assert.strictEqual(doc.listeners.size, 0, 'no loop of retries');
});

test('shown again after something else took over: nothing starts', async () => {
  for (const change of ['another file', 'gone from the page', 'already playing']) {
    const doc = fakeDocument(true);
    const s = starter('auto', { document: doc });
    const el = hiddenRefusing(doc);
    s.ctx.currentMediaState.element = el;
    s._startPlayback(el);
    s._startPlayback(el);                                     // two refusals: one listener
    await tick();
    assert.strictEqual(doc.listeners.size, 1, `${change}: one listener`);
    if (change === 'another file') s.ctx.currentMediaState.element = {};
    if (change === 'gone from the page') el.isConnected = false;
    if (change === 'already playing') el.paused = false;
    doc.show();
    await tick();
    assert.strictEqual(el.plays, 2, `${change}: not started again`);
  }
});

test('played and paused by hand while the tab was hidden: not started again on show', async () => {
  for (const press of ['pause', 'play']) {
    const doc = fakeDocument(true);
    const s = starter('auto', { document: doc });
    const el = hiddenRefusing(doc);
    const on = new Map();
    el.addEventListener = (type, fn) => on.set(type, fn);
    el.removeEventListener = (type, fn) => { if (on.get(type) === fn) on.delete(type); };
    s.ctx.currentMediaState.element = el;
    s._startPlayback(el);
    await tick();
    assert.deepStrictEqual([...on.keys()].sort(), ['pause', 'play'], 'the wait listens for a press');
    on.get(press)();                                          // a press in a Picture-in-Picture window
    assert.strictEqual(doc.listeners.size, 0, `${press}: the wait is dropped`);
    assert.strictEqual(on.size, 0, `${press}: and its element listeners with it`);
    doc.show();
    await tick();
    assert.strictEqual(el.plays, 1, `${press}: the paused file stays paused`);
  }
});

test('a file opened by hand in a background tab: unchanged (logged, no toast, no start on show)', async () => {
  const doc = fakeDocument(true);
  const s = starter('user', { document: doc });
  const el = hiddenRefusing(doc);
  s.ctx.currentMediaState.element = el;
  s._startPlayback(el);
  await tick();
  assert.strictEqual(doc.listeners.size, 0);
  assert.deepStrictEqual([s.warns.length, s.toasts.length], [1, 0]);
});

test('autoAdvanceDiag: says where the list stood, and never throws', () => {
  const core = read('player-lib/player/player-core.js');
  const warns = [];
  const L = { length: () => 40, known: () => true, ids: new Uint32Array(40) };
  const ctx = {
    console: { warn: (...a) => warns.push(a) },
    Library: L,
    queueList: () => L,
    queueSkipSet: () => new Set([5, 6]),
    listAnchorIndex: () => 38,
    upNextCount: () => 0,
    repeatMode: () => 'off',
    document: { hidden: true },
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab(core, 'function autoAdvanceDiag(')}\nglobalThis.__d = autoAdvanceDiag;`, ctx);
  ctx.__d('nothing left to move on to');
  assert.match(warns[0][0], /^\[Vault next\] A file ended but playback did not move on: nothing left to move on to\./);
  assert.deepStrictEqual({ ...warns[0][1] }, { at: 38, of: 40, countKnown: true, idsLoaded: true, ownList: false, skipped: 2, upNext: 0, repeat: 'off', collection: null, tabHidden: true });
  ctx.queueList = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => ctx.__d('x'));
  assert.strictEqual(warns.length, 2);
});
