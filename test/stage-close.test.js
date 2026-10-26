/**
 * The Stage bar's X closes Stage and stops playback: nothing carries on in
 * the mini player, in this Vault tab or any other, for mpv Stage and for
 * Basic (picture-in-picture) Stage. Close Stage in the Stage menu keeps
 * handing the file back to the mini player (player-lib/stage-control.js
 * closeStage, handBack).
 *
 * stage-control.js runs in a VM with a fake page; Stage's reports come in
 * over a fake event stream. The hub's side (the stop carried from the close
 * to every Control page) is in lib/stage/hub.js, tested at the end.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createHub, validateCommand } = require('../lib/stage/hub');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const ROW = { id: 41, filepath: 'C:/clips/a.mp4', filename: 'a.mp4', media_type: 'video', duration_seconds: 120 };

/**
 * stage-control.js in a VM. basic: Basic Stage (no mpv), else mpv Stage,
 * open with ROW playing. failClose: the close never reaches the server.
 * rowDelay: how long a file's row takes to arrive.
 */
function page({ basic = false, failClose = false, rowDelay = 0 } = {}) {
  const calls = [];
  const toasts = [];
  const cmds = [];
  const closes = [];
  const streams = [];
  const docListeners = {};
  const classes = new Set(['layout-modern']);
  const body = { classList: {
    contains: (c) => classes.has(c),
    add: (...c) => c.forEach(x => classes.add(x)),
    remove: (...c) => c.forEach(x => classes.delete(x)),
    toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
  } };
  class FakeVideo extends EventTarget {
    constructor() { super(); this.tagName = 'VIDEO'; this.readyState = 4; this.paused = false; this.muted = false; this.currentTime = 12; }
    requestPictureInPicture() {
      doc.pictureInPictureElement = this;
      for (const fn of docListeners.enterpictureinpicture || []) fn({ target: this });
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const video = new FakeVideo();
  // The mini player box: showRemote needs it to put the remote up.
  const mini = { classList: { add() {}, remove() {}, contains: () => false } };
  const doc = {
    body,
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    exitPictureInPicture: () => { const el = doc.pictureInPictureElement; doc.pictureInPictureElement = null; if (el) el.dispatchEvent(new Event('leavepictureinpicture')); return Promise.resolve(); },
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: () => {},
    getElementById: (id) => (id === 'miniPlayer' ? mini : id === 'miniPlayerMedia' ? { innerHTML: '' } : null),
    querySelector: (q) => (basic && q === '#miniPlayerMedia video' ? video : null),
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => null, hidden: true, style: {} }),
  };
  class FakeEventSource {
    constructor(url) { this.url = url; this.on = {}; this.readyState = 1; streams.push(this); }
    addEventListener(name, fn) { this.on[name] = fn; }
    close() { this.readyState = 2; this.closed = true; }
    emit(name, data) { if (!this.closed && this.on[name]) this.on[name]({ data: JSON.stringify(data) }); }
  }
  FakeEventSource.CLOSED = 2;
  let stageOpen = false;
  const ctx = {
    document: doc, window: { addEventListener() {} }, console: { ...console, warn() {} }, setTimeout, clearTimeout, setInterval: () => 0,
    Promise, JSON, Math, Date, Error, TypeError, Event, EventTarget, Map, Set,
    MutationObserver: class { observe() {} },
    HTMLMediaElement: FakeVideo,
    EventSource: FakeEventSource,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    showToast: (m) => toasts.push(String(m)),
    currentMediaState: { type: 'video', miniMode: true },
    Library: { fetchRows: async () => { if (rowDelay) await wait(rowDelay); return [ROW]; }, known: () => true, length: () => 0, waitIds: async () => [], rowsForRange: async () => [] },
    noteFileOpened() {},
    queueNav: (fn) => fn(),
    miniPlayerOpen() {},
    playMedia: (m) => calls.push(`playMedia ${m.id}`),
    minimizePlayer: () => calls.push('minimizePlayer'),
    closeMiniPlayer: () => { calls.push('closeMiniPlayer'); if (ctx.__sc.basicOn()) ctx.__sc.miniClosing(); },
    fetch: async (url, o) => {
      const ok = (data) => ({ ok: true, status: 200, json: async () => data });
      if (url === '/api/stage/state') {
        return ok(basic ? { open: false, mpv: { found: false, choice: 'basic' }, settings: { tips: false } }
          : { open: stageOpen, mpv: { found: true, choice: 'mpv' }, settings: { tips: false } });
      }
      if (url === '/api/stage/open') { stageOpen = true; return ok({ ok: true, mode: 'mpv' }); }
      if (url === '/api/stage/cmd') {
        const c = JSON.parse(o.body);
        cmds.push(c.type);
        if (c.type === 'close') {
          closes.push(c);
          if (failClose) throw new TypeError('Failed to fetch');
          stageOpen = false;
          return ok({ ok: true, last: { t: 30, paused: false } });
        }
        return ok({ ok: true });
      }
      return ok({});
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/stage-rules.js')}\n${read('player-lib/stage-control.js')}\nglobalThis.__sc = StageControl;`, ctx);
  const stream = () => streams[streams.length - 1];
  const syncPlaying = (key = 'k1') => stream().emit('sync', { open: true, volume: 1, current: { key, id: ROW.id, filename: ROW.filename, media_type: 'video' }, status: { key, t: 30, d: 120, paused: false, state: 'playing' } });
  /** Open Stage; mpv: Stage reports ROW playing (as after a page reload, or in a second tab). */
  async function openPlaying() {
    await wait(10);
    await ctx.__sc.openStage();
    if (!basic) {
      syncPlaying();
      await wait(20 + rowDelay);
    } else {
      await wait(30);
    }
    calls.length = 0;
    toasts.length = 0;
  }
  return { SC: ctx.__sc, calls, toasts, cmds, closes, stream, doc, openPlaying, syncPlaying };
}

/* ── mpv Stage ─────────────────────────────────────────────────────────── */

test('mpv: the X closes Stage with a stop and stops here; the mini player never takes the file over', async () => {
  const p = page();
  await p.openPlaying();
  assert.strictEqual(p.SC._state().cur.id, ROW.id, 'a file is on Stage');
  await p.SC.closeStageAndStop();
  assert.deepStrictEqual(p.closes, [{ type: 'close', stop: true }], 'Stage is told to close, and that it stops');
  assert.deepStrictEqual(p.calls, ['closeMiniPlayer'], 'the player here is stopped, nothing plays here');
  assert.deepStrictEqual(p.toasts, ['Stage closed.']);
  assert.strictEqual(p.SC.isOpen(), false);
  assert.strictEqual(p.SC._state().cur, null);
  assert.strictEqual(p.SC._state().remoteShown, false);
});

test('mpv: a second Vault tab hears the stopping close and stops too; a close without stop still hands back there', async () => {
  const b = page();
  await b.openPlaying();
  assert.strictEqual(b.SC._state().remoteShown, true, 'tab B shows the remote');
  b.stream().emit('closed', { current: { key: 'k1', id: ROW.id }, t: 10, paused: false, stop: true });
  await wait(10);
  assert.deepStrictEqual(b.calls, ['closeMiniPlayer'], 'tab B stops, it does not play the file');
  assert.deepStrictEqual(b.toasts, ['Stage closed.']);
  assert.deepStrictEqual([b.SC.isOpen(), b.SC._state().remoteShown], [false, false]);

  const c = page();
  await c.openPlaying();
  c.stream().emit('closed', { current: { key: 'k1', id: ROW.id }, t: 10, paused: false });
  await wait(10);
  assert.deepStrictEqual(c.calls, [`playMedia ${ROW.id}`, 'minimizePlayer'], 'the menu\'s Close or the window\'s own close: hands back as before');
  assert.match(c.toasts.pop(), /^Stage closed\. Playing here from 10s/);
});

test('mpv: a close that never reaches the server is tried again, then leaves the controls up and says so', async () => {
  const p = page({ failClose: true });
  await p.openPlaying();
  await p.SC.closeStageAndStop();
  assert.strictEqual(p.closes.length, 3, 'tried three times');
  assert.deepStrictEqual(p.calls, [], 'nothing stopped here: Stage still plays');
  assert.strictEqual(p.SC.isOpen(), true);
  assert.strictEqual(p.SC._state().remoteShown, true, 'the remote stays up');
  assert.deepStrictEqual(p.toasts, ['Stage could not be closed. Check that Vault is still running, then try again.']);
});

test('mpv: a file report still on its way when Stage closes never brings the remote back', async () => {
  const p = page({ rowDelay: 40 });
  await p.openPlaying();
  p.syncPlaying('k2');                        // a new file on Stage; its row is being fetched
  await p.SC.closeStageAndStop();
  await wait(80);
  assert.strictEqual(p.SC._state().cur, null);
  assert.strictEqual(p.SC._state().remoteShown, false);
  assert.strictEqual(p.SC.isOpen(), false);
});

test('mpv: Close Stage in the Stage menu still plays on in the mini player at the same spot', async () => {
  const p = page();
  await p.openPlaying();
  await p.SC.closeStage();
  assert.deepStrictEqual(p.closes, [{ type: 'close' }], 'no stop');
  assert.deepStrictEqual(p.calls, [`playMedia ${ROW.id}`, 'minimizePlayer']);
  assert.match(p.toasts.pop(), /^Stage closed\. Playing here from /);
});

/* ── Basic Stage ───────────────────────────────────────────────────────── */

test('Basic: the X closes Stage and stops the video (the mini player closes, picture-in-picture goes)', async () => {
  const p = page({ basic: true });
  await p.openPlaying();
  assert.deepStrictEqual([p.SC.basicOn(), p.SC.isOpen()], [true, true]);
  assert.ok(p.doc.pictureInPictureElement, 'in picture-in-picture');
  await p.SC.closeStageAndStop();
  assert.deepStrictEqual(p.calls, ['closeMiniPlayer'], 'the mini player is closed, not left playing');
  assert.deepStrictEqual([p.SC.basicOn(), p.SC.isOpen()], [false, false]);
  assert.strictEqual(p.doc.pictureInPictureElement, null);
  assert.deepStrictEqual(p.toasts, ['Stage closed.']);
  assert.deepStrictEqual(p.cmds, [], 'Basic has no server session');
});

test('Basic: Close Stage in the Stage menu still plays on in the mini player', async () => {
  const p = page({ basic: true });
  await p.openPlaying();
  await p.SC.closeStage();
  assert.deepStrictEqual(p.calls, [], 'the mini player is left playing');
  assert.deepStrictEqual([p.SC.basicOn(), p.SC.isOpen()], [false, false]);
  assert.match(p.toasts.pop(), /^Stage closed\. Playing here from /);
});

/* ── The hub: the stop goes to every Control page ──────────────────────── */

function fakeStream() {
  const chunks = [];
  const req = { on() {} };
  const res = { writeHead() {}, write: (c) => { chunks.push(c); return true; }, on() {} };
  const events = () => chunks.join('').split('\n\n').filter(b => b.startsWith('event:')).map((b) => {
    const [ev, data] = b.split('\n');
    return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
  });
  return { req, res, events };
}

function hubWithStage() {
  let alive = true;
  const hub = createHub({
    stage: { alive: () => alive, command() {}, close() {}, position: () => ({ key: 'a1', t: 7, paused: false }) },
    heartbeatMs: 0,
    settings: { get: () => ({}), sizes: ['free'] },
  });
  const exit = () => { alive = false; hub.stageExited({ byUser: true }); };
  return { hub, exit };
}

const item = (key, id) => ({ key, id, media_type: 'video', filename: `${id}.mp4` });

test('hub: the X\'s close (stop) reaches both Control tabs in the closed report; a plain close and the window\'s own close do not stop', () => {
  for (const [how, wantStop] of [['stop', true], ['plain', false], ['window', false]]) {
    const { hub, exit } = hubWithStage();
    hub.opened();
    hub.command({ type: 'load', item: item('a1', 1) });
    const a = fakeStream();
    const b = fakeStream();
    hub.attach('control', a.req, a.res);
    hub.attach('control', b.req, b.res);
    if (how === 'stop') assert.strictEqual(hub.command({ type: 'close', stop: true }).status, 200);
    else if (how === 'plain') assert.strictEqual(hub.command({ type: 'close' }).status, 200);
    else hub.closeRequested();
    exit();
    for (const s of [a, b]) {
      const closed = s.events().find(e => e.event === 'closed');
      assert.ok(closed, `${how}: closed is reported`);
      assert.strictEqual(closed.data.stop, wantStop, `${how}: stop is ${wantStop}`);
      assert.strictEqual(closed.data.current.key, 'a1');
    }
    // The next Stage starts with no stop pending.
    hub.opened();
    assert.strictEqual(hub._session().closeStop, false);
  }
});

test('hub: stop on a close must be true or false', () => {
  assert.deepStrictEqual(validateCommand({ type: 'close', stop: true }), { ok: true, cmd: { type: 'close', stop: true } });
  assert.deepStrictEqual(validateCommand({ type: 'close' }), { ok: true, cmd: { type: 'close', stop: false } });
  assert.strictEqual(validateCommand({ type: 'close', stop: 'yes' }).ok, false);
});

/* ── The bar ───────────────────────────────────────────────────────────── */

test('the bar\'s X is the close-and-stop; the Stage menu keeps "Close Stage, plays on here"', () => {
  const bar = read('player-lib/stage-bar.js');
  assert.match(bar, /case 'close': if \(SC\) SC\.closeStageAndStop\(\); break;/);
  const html = read('db-viewer.html');
  assert.match(html, /id="stageBarClose" data-sb-act="close" title="Close Stage and stop playing"/);
  const sc = read('player-lib/stage-control.js');
  assert.match(sc, /else if \(act === 'close'\) closeStage\(\);/, 'the menu item is unchanged');
  assert.match(sc, /<span class="sm-l">Close Stage<\/span><span class="sm-s">plays on here<\/span>/);
});
