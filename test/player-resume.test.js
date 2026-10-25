/**
 * Resume and the playback decision for files the browser cannot play natively
 * (player-lib/viewtracker.js, player-lib/player/player-stream.js), in a VM.
 *
 * Two bugs, both on dev before this:
 * - A converted (remux) file plays through hls.js, whose src is a blob: URL.
 *   viewtracker.js found the library row from the src only, so a remux file
 *   never resumed, never saved its position, and never counted a view.
 * - playMedia only knew the row id for a file in the current results, so a
 *   file opened from outside them (a Wall collection, a saved search) skipped
 *   the server's playback decision and played by path, remux or not.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'player-lib', rel), 'utf8');

class FakeHTMLElement {
  constructor(tagName, { src = '', id = null, inPlayer = true, where = '#mediaPlayerContent', inMix = false, duration = 600 } = {}) {
    this.tagName = tagName;
    this.src = src;
    this.currentSrc = src;
    this.dataset = {};
    if (id != null) this.dataset.playbackMediaId = String(id);
    this.inPlayer = inPlayer;
    this.where = where;
    this.inMix = inMix;
    this.paused = false;
    this.duration = duration;
    this.currentTime = 0;
    this.isConnected = true;
  }
  closest(sel) {
    if (sel === '.mix-player-stage') return this.inMix ? {} : null;
    return this.inPlayer && sel === this.where ? {} : null;
  }
  pause() { this.paused = true; }
  play() { return Promise.resolve(); }
  canPlayType() { return ''; }
}

/** viewtracker.js with a fake library; returns its document listeners and the calls it made. */
function loadViewtracker(rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const listeners = {};
  const winListeners = {};
  const calls = { fetch: [], toast: [], stopped: [] };
  const onPage = [];
  const ctx = {
    console, URL, Math, Number, String, Object, JSON, Promise, setTimeout, clearTimeout,
    HTMLElement: FakeHTMLElement,
    location: { origin: 'http://localhost:1' },
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      getElementById() { return null; },
      querySelectorAll() { return onPage; },
    },
    window: { dispatchEvent() {}, addEventListener(type, fn) { winListeners[type] = fn; } },
    // player-core.js's teardown; viewtracker wraps it
    stopMediaElement(el) { calls.stopped.push(el); if (el) { el.currentTime = 0; el.duration = NaN; } },
    CustomEvent: class {},
    playMedia() {},
    Library: { rowByPath: (p) => rows.find(r => r.filepath === p) || null },
    getMediaById: (id) => byId.get(id) || null,
    showToast: (m) => calls.toast.push(m),
    formatDuration: (s) => `${Math.floor(s)}s`,
    fetch: (url, opts) => { calls.fetch.push({ url, keepalive: !!(opts && opts.keepalive), body: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve({ ok: false }); },
  };
  vm.createContext(ctx);
  vm.runInContext(read('viewtracker.js'), ctx);
  return { listeners, winListeners, calls, ctx, onPage };
}

const remuxRow = () => ({ id: 13, filepath: 'K:/m/long.mkv', last_position: 120 });
const nativeRow = () => ({ id: 5, filepath: 'K:/m/clip.mp4', last_position: 90 });

test('resume: a remux file (blob: src) resumes from its id stamp', () => {
  const { listeners, calls } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:http://localhost:1/abc', id: 13 });
  listeners.loadedmetadata({ target: el });
  assert.strictEqual(el.currentTime, 120);
  assert.strictEqual(calls.toast.length, 1);
});

test('resume: a blob: src with no id stamp resolves nothing (as before)', () => {
  const { listeners } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:http://localhost:1/abc' });
  listeners.loadedmetadata({ target: el });
  assert.strictEqual(el.currentTime, 0);
});

test('resume: a native file still resolves from its src', () => {
  for (const src of ['/media/by-path?p=' + encodeURIComponent('K:/m/clip.mp4'), '/media/5']) {
    const { listeners } = loadViewtracker([nativeRow()]);
    const el = new FakeHTMLElement('VIDEO', { src });
    listeners.loadedmetadata({ target: el });
    assert.strictEqual(el.currentTime, 90, src);
  }
});

test('resume: the id stamp wins over a src naming another file', () => {
  const { listeners } = loadViewtracker([remuxRow(), nativeRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: '/media/5', id: 13 });
  listeners.loadedmetadata({ target: el });
  assert.strictEqual(el.currentTime, 120);
});

test('resume: a stamp for a row the client does not hold falls back to the src', () => {
  const { listeners } = loadViewtracker([nativeRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: '/media/5', id: 999 });
  listeners.loadedmetadata({ target: el });
  assert.strictEqual(el.currentTime, 90);
});

test('pause: a remux file saves its position against its own id', () => {
  const { listeners, calls } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:http://localhost:1/abc', id: 13 });
  el.currentTime = 245.37;
  listeners.pause({ target: el });
  const save = calls.fetch.find(c => c.url === '/api/media/13/flags');
  assert.ok(save, 'position saved');
  assert.strictEqual(save.body.last_position, 245.4);
});

test('timeupdate: watch tracking and the throttled save find a remux file', () => {
  const { listeners, calls } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:http://localhost:1/abc', id: 13 });
  el.currentTime = 10;
  listeners.timeupdate({ target: el });          // first tick: picks the row
  for (let t = 11; t <= 16; t++) { el.currentTime = t; listeners.timeupdate({ target: el }); }
  assert.ok(calls.fetch.some(c => c.url === '/api/media/13/flags'), 'throttled save went to row 13');
});

/* ── Save at close (viewtracker.js wraps stopMediaElement) ─────────────── */

/** Play `el` from `from` to `to` in 1s ticks, so the watch tracker holds heat. */
function playThrough(listeners, el, from, to) {
  for (let t = from; t <= to; t++) { el.currentTime = t; listeners.timeupdate({ target: el }); }
}
const flagsCalls = (calls, id) => calls.fetch.filter(c => c.url === `/api/media/${id}/flags`);
const heatCalls = (calls, id) => calls.fetch.filter(c => c.url === `/api/media/${id}/heatmap`);

test('close: a playing remux file saves its position and heatmap before teardown', () => {
  const { listeners, calls, ctx } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:http://localhost:1/abc', id: 13 });
  playThrough(listeners, el, 200, 203);          // throttled save not reached yet
  el.currentTime = 203.27;
  calls.fetch.length = 0;
  ctx.stopMediaElement(el);
  assert.strictEqual(calls.stopped.length, 1, 'the real teardown still runs');
  assert.strictEqual(heatCalls(calls, 13).length, 1, 'heatmap sent');
  const saves = flagsCalls(calls, 13);
  assert.strictEqual(saves.length, 1);
  assert.strictEqual(saves[0].body.last_position, 203.3);
  assert.strictEqual(saves[0].keepalive, false, 'keepalive only for pagehide');
});

test('close: the mini player saves too', () => {
  const { calls, ctx } = loadViewtracker([nativeRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: '/media/5', where: '#miniPlayerMedia' });
  el.currentTime = 42;
  ctx.stopMediaElement(el);
  assert.strictEqual(flagsCalls(calls, 5)[0].body.last_position, 42);
});

test('close: a finished file is saved as 0', () => {
  const { calls, ctx } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:x', id: 13, duration: 600 });
  el.currentTime = 560;
  ctx.stopMediaElement(el);
  assert.strictEqual(flagsCalls(calls, 13)[0].body.last_position, 0);
});

test('close: no second save right after a pause at the same spot', () => {
  const { listeners, calls, ctx } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:x', id: 13 });
  el.currentTime = 245.31;
  listeners.pause({ target: el });
  ctx.stopMediaElement(el);
  assert.strictEqual(flagsCalls(calls, 13).length, 1);
});

test('close: nothing moved since it resumed, so no save', () => {
  const { calls, ctx } = loadViewtracker([remuxRow()]);   // last_position 120
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:x', id: 13 });
  el.currentTime = 120;
  ctx.stopMediaElement(el);
  assert.strictEqual(flagsCalls(calls, 13).length, 0);
});

test('close: paused, then moved, then closed saves the new spot', () => {
  const { listeners, calls, ctx } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:x', id: 13 });
  el.currentTime = 100;
  listeners.pause({ target: el });
  el.currentTime = 300;
  ctx.stopMediaElement(el);
  assert.deepStrictEqual(flagsCalls(calls, 13).map(c => c.body.last_position), [100, 300]);
});

test('close: saved against the id stamp, never the file the src names', () => {
  const { calls, ctx } = loadViewtracker([remuxRow(), nativeRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: '/media/5', id: 13 });
  el.currentTime = 77;
  ctx.stopMediaElement(el);
  assert.strictEqual(flagsCalls(calls, 13).length, 1);
  assert.strictEqual(flagsCalls(calls, 5).length, 0);
});

test('close: elements outside the player, mix layers and a missing element save nothing', () => {
  const { calls, ctx } = loadViewtracker([nativeRow()]);
  const outside = new FakeHTMLElement('VIDEO', { src: '/media/5', inPlayer: false });
  const layer = new FakeHTMLElement('VIDEO', { src: '/media/5', inMix: true });
  outside.currentTime = layer.currentTime = 50;
  ctx.stopMediaElement(outside);
  ctx.stopMediaElement(layer);
  ctx.stopMediaElement(null);
  assert.strictEqual(calls.fetch.length, 0);
  assert.strictEqual(calls.stopped.length, 3, 'teardown still runs for each');
});

test('close: positions are saved with "Resume playback positions" off', () => {
  const { calls, ctx } = loadViewtracker([nativeRow()]);
  ctx.vaultSetting = (k) => (k === 'resumePlayback' ? false : undefined);
  const el = new FakeHTMLElement('VIDEO', { src: '/media/5' });
  el.currentTime = 33;
  ctx.stopMediaElement(el);
  assert.strictEqual(flagsCalls(calls, 5)[0].body.last_position, 33);
});

test('close: the heatmap is sent once, not again when the next file starts', () => {
  const { listeners, calls, ctx } = loadViewtracker([remuxRow(), nativeRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:x', id: 13 });
  playThrough(listeners, el, 10, 13);
  ctx.stopMediaElement(el);
  const next = new FakeHTMLElement('VIDEO', { src: '/media/5' });
  next.currentTime = 1;
  listeners.timeupdate({ target: next });
  assert.strictEqual(heatCalls(calls, 13).length, 1);
});

test('pagehide: saves the playing file with keepalive', () => {
  const { listeners, winListeners, calls, onPage } = loadViewtracker([remuxRow()]);
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:x', id: 13, where: '#miniPlayerMedia' });
  playThrough(listeners, el, 300, 303);
  el.currentTime = 303.3;
  onPage.push(el);
  calls.fetch.length = 0;
  winListeners.pagehide();
  const heat = heatCalls(calls, 13);
  const save = flagsCalls(calls, 13);
  assert.strictEqual(heat.length, 1);
  assert.strictEqual(save.length, 1);
  assert.strictEqual(save[0].body.last_position, 303.3);
  assert.ok(heat[0].keepalive && save[0].keepalive);
});

test('pagehide: nothing playing sends nothing', () => {
  const { winListeners, calls } = loadViewtracker([remuxRow()]);
  winListeners.pagehide();
  assert.strictEqual(calls.fetch.length, 0);
});

/* ── Expanding the mini player (maximizePlayer stamps the new element) ──── */

test('maximize: the new element continues from the stamped spot, not the resume point', () => {
  const { listeners, calls } = loadViewtracker([remuxRow()]);   // last_position 120
  const el = new FakeHTMLElement('VIDEO', { src: 'blob:x', id: 13 });
  el.dataset.maximizeAt = '252.6';
  listeners.loadedmetadata({ target: el });
  assert.strictEqual(el.currentTime, 252.6);
  assert.strictEqual(el.paused, false);
  assert.strictEqual(calls.toast.length, 0, 'not announced as a resume');
  assert.strictEqual(el.dataset.maximizeAt, undefined, 'used once');
});

test('maximize: a paused file stays paused, even with resume off', () => {
  const { listeners, ctx } = loadViewtracker([nativeRow()]);
  ctx.vaultSetting = () => false;
  const el = new FakeHTMLElement('VIDEO', { src: '/media/5' });
  el.dataset.maximizeAt = '14.8';
  el.dataset.maximizePaused = '1';
  listeners.loadedmetadata({ target: el });
  assert.strictEqual(el.currentTime, 14.8);
  assert.strictEqual(el.paused, true);
  assert.strictEqual(el.dataset.maximizePaused, undefined);
});

/* ── player-stream.js ──────────────────────────────────────────────────── */

function loadStream({ playback } = {}) {
  const ctx = {
    console, Math, Number, String, Object, JSON, Promise, Date, encodeURIComponent,
    window: { addEventListener() {} },
    document: { createElement: () => ({ canPlayType: () => '' }) },
    sessionStorage: { getItem: () => 'h264,aac', setItem() {} },
    fetch: async () => (playback ? { ok: true, json: async () => playback } : { ok: false }),
  };
  vm.createContext(ctx);
  vm.runInContext(read('player/player-stream.js'), ctx);
  return ctx;
}

test('playbackMediaIdFor: explicit id, then the results row, then any held row', () => {
  const { playbackMediaIdFor: f } = loadStream();
  const held = (p) => (p === 'K:/m/long.mkv' ? { id: 13 } : null);
  assert.strictEqual(f({ id: 14, filepath: 'K:/m/long.mkv' }, { id: 13 }, held), 14);
  assert.strictEqual(f({ id: '14', filepath: 'x' }, null, held), 14);
  assert.strictEqual(f({ filepath: 'K:/m/long.mkv' }, { id: 9 }, held), 9);
  // Outside the results: no results row, but the client holds the row.
  assert.strictEqual(f({ filepath: 'K:/m/long.mkv' }, null, held), 13);
  // Not a library file at all (a mix, a stub).
  assert.strictEqual(f({ filepath: 'K:/other.mp4' }, null, held), null);
  assert.strictEqual(f({ id: 0, filepath: 'K:/other.mp4' }, null, held), null);
  assert.strictEqual(f({ id: 'junk' }, null, null), null);
  assert.strictEqual(f(null, null, held), null);
});

test('attachPlaybackSource: no id plays by path and clears any old stamp', async () => {
  const ctx = loadStream();
  const el = new FakeHTMLElement('VIDEO', { id: 13 });
  const r = await ctx.attachPlaybackSource(el, null, 'K:/x.mp4', '/media/by-path?p=x');
  assert.strictEqual(r.mode, 'native');
  assert.strictEqual(el.src, '/media/by-path?p=x');
  assert.strictEqual(el.dataset.playbackMediaId, undefined);
});

test('attachPlaybackSource: server unreachable still stamps the id', async () => {
  const ctx = loadStream();
  const el = new FakeHTMLElement('VIDEO');
  await ctx.attachPlaybackSource(el, 5, 'K:/m/clip.mp4', '/media/by-path?p=x');
  assert.strictEqual(el.dataset.playbackMediaId, '5');
});

test('attachPlaybackSource: a remux decision stamps the id', async () => {
  const ctx = loadStream({ playback: { mode: 'remux', url: '/stream/13/index.m3u8' } });
  const el = new FakeHTMLElement('VIDEO');
  el.canPlayType = () => 'maybe';                 // native HLS path (no hls.js in the VM)
  const r = await ctx.attachPlaybackSource(el, 13, 'K:/m/long.mkv', '/media/by-path?p=x');
  assert.strictEqual(r.mode, 'remux');
  assert.strictEqual(el.dataset.playbackMediaId, '13');
  assert.match(el.src, /^\/stream\/13\/index\.m3u8\?c=/);
});
