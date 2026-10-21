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

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'player-lib', rel), 'utf8');

class FakeHTMLElement {
  constructor(tagName, { src = '', id = null, inPlayer = true, duration = 600 } = {}) {
    this.tagName = tagName;
    this.src = src;
    this.currentSrc = src;
    this.dataset = {};
    if (id != null) this.dataset.playbackMediaId = String(id);
    this.inPlayer = inPlayer;
    this.duration = duration;
    this.currentTime = 0;
    this.isConnected = true;
  }
  closest(sel) { return this.inPlayer && sel === '#mediaPlayerContent' ? {} : null; }
  play() { return Promise.resolve(); }
  canPlayType() { return ''; }
}

/** viewtracker.js with a fake library; returns its document listeners and the calls it made. */
function loadViewtracker(rows) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const listeners = {};
  const calls = { fetch: [], toast: [] };
  const ctx = {
    console, URL, Math, Number, String, Object, JSON, Promise, setTimeout, clearTimeout,
    HTMLElement: FakeHTMLElement,
    location: { origin: 'http://localhost:1' },
    document: {
      addEventListener(type, fn) { listeners[type] = fn; },
      getElementById() { return null; },
    },
    window: { dispatchEvent() {} },
    CustomEvent: class {},
    playMedia() {},
    Library: { rowByPath: (p) => rows.find(r => r.filepath === p) || null },
    getMediaById: (id) => byId.get(id) || null,
    showToast: (m) => calls.toast.push(m),
    formatDuration: (s) => `${Math.floor(s)}s`,
    fetch: (url, opts) => { calls.fetch.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null }); return Promise.resolve({ ok: false }); },
  };
  vm.createContext(ctx);
  vm.runInContext(read('viewtracker.js'), ctx);
  return { listeners, calls, ctx };
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
