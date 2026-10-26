/**
 * Basic Stage: the browser's picture-in-picture of the mini player's video,
 * for when mpv is not there (or Settings › Stage says Basic).
 *
 *  - player-lib/stage-rules.js   which Stage runs, what Basic can show, what
 *                                it does with a file it cannot show
 *  - lib/stage/settings.js       the player setting, checked
 *  - server/stage-routes.js      the choice in the state, the open answer,
 *                                VAULT_STAGE_NO_MPV
 *  - stage-control.js, vault-ui.js, player-core.js   the page's seams (source)
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stage-basic-'));
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');

const Rules = require('../player-lib/stage-rules');
const stageSettings = require('../lib/stage/settings');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

/* ── Which Stage runs ───────────────────────────────────────────────────── */

test('player choice: Auto is mpv when mpv is found, else Basic; Basic only is always Basic', () => {
  assert.strictEqual(Rules.playerChoice({ setting: 'auto', mpvFound: true }), 'mpv');
  assert.strictEqual(Rules.playerChoice({ setting: 'auto', mpvFound: false }), 'basic');
  assert.strictEqual(Rules.playerChoice({ setting: 'basic', mpvFound: true }), 'basic');
  assert.strictEqual(Rules.playerChoice({ setting: 'basic', mpvFound: false }), 'basic');
  assert.strictEqual(Rules.playerChoice({ setting: 'nonsense', mpvFound: true }), 'mpv', 'anything else counts as Auto');
  assert.strictEqual(Rules.playerChoice({ mpvFound: 'yes' }), 'basic', 'only a real true is found');
  assert.strictEqual(Rules.playerChoice(), 'basic');
});

test('Basic plays videos only', () => {
  assert.strictEqual(Rules.basicPlays('video'), true);
  for (const t of ['image', 'gif', 'audio', 'document', 'mix', undefined]) assert.strictEqual(Rules.basicPlays(t), false, String(t));
});

/* ── The setting ────────────────────────────────────────────────────────── */

test('settings: the player is Auto by default, Basic when chosen, anything else refused', () => {
  assert.strictEqual(stageSettings.DEFAULTS.player, 'auto');
  assert.strictEqual(stageSettings.normalize({ player: 'basic' }).player, 'basic');
  assert.strictEqual(stageSettings.normalize({ player: 'mpv' }).player, 'auto');
  const base = stageSettings.normalize({});
  assert.strictEqual(stageSettings.validatePatch({ player: 'basic' }, base).settings.player, 'basic');
  assert.strictEqual(stageSettings.validatePatch({ player: 'auto' }, base).ok, true);
  assert.strictEqual(stageSettings.validatePatch({ player: 'webview2' }, base).ok, false);
  assert.strictEqual(stageSettings.validatePatch({ player: true }, base).ok, false);
});

/* ── The routes (a fake mpv host; nothing is started) ───────────────────── */

const express = require('express');
const appSettings = require('../lib/app-settings');
const { buildRouter } = require('../server/stage-routes');

async function serve(opts) {
  const log = [];
  const router = buildRouter({
    hostFactory: () => { log.push('host'); return { start: async () => { log.push('start'); return { ok: true }; }, alive: () => false, set: async () => null, kill() {}, quit() {} }; },
    lib: {}, ...opts,
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const at = `http://127.0.0.1:${srv.address().port}`;
  return { at, log, close: () => new Promise((r) => srv.close(r)) };
}
const found = async () => ({ found: true, path: 'C:\\Program Files\\mpv\\mpv.exe', version: 'v0.41.0', source: 'default' });
const post = (at, p, body) => fetch(at + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

test('routes: the state says which Stage opens (mpv found, mpv missing, VAULT_STAGE_NO_MPV, Basic only)', async () => {
  appSettings.set({ stage: stageSettings.normalize({}) });
  const a = await serve({ find: found, env: {} });
  const b = await serve({ find: async () => ({ found: false }), env: {} });
  const c = await serve({ find: found, env: { VAULT_STAGE_NO_MPV: '1' } });
  try {
    assert.strictEqual((await (await fetch(a.at + '/api/stage/mpv')).json()).choice, 'mpv');
    assert.strictEqual((await (await fetch(b.at + '/api/stage/mpv')).json()).choice, 'basic');
    const nc = await (await fetch(c.at + '/api/stage/state')).json();
    assert.strictEqual(nc.mpv.found, false, 'the test switch hides mpv');
    assert.strictEqual(nc.mpv.choice, 'basic');
    appSettings.set({ stage: stageSettings.normalize({ player: 'basic' }) });
    assert.strictEqual((await (await fetch(a.at + '/api/stage/mpv')).json()).choice, 'basic', 'Basic only, even with mpv there');
  } finally {
    appSettings.set({ stage: stageSettings.normalize({}) });
    await a.close(); await b.close(); await c.close();
  }
});

test('routes: opening with Basic chosen or mpv missing starts nothing on the server (the page runs Basic)', async () => {
  const a = await serve({ find: found, env: {} });
  const b = await serve({ find: async () => ({ found: false }), env: {} });
  try {
    appSettings.set({ stage: stageSettings.normalize({ player: 'basic' }) });
    const r1 = await post(a.at, '/api/stage/open');
    assert.strictEqual(r1.status, 200);
    assert.strictEqual((await r1.json()).mode, 'basic');
    assert.deepStrictEqual(a.log, [], 'no mpv started');
    appSettings.set({ stage: stageSettings.normalize({}) });
    const r2 = await post(b.at, '/api/stage/open');
    assert.strictEqual(r2.status, 409);
    const j = await r2.json();
    assert.strictEqual(j.code, 'MPV_MISSING');
    assert.strictEqual(j.mode, 'basic');
    assert.deepStrictEqual(b.log, []);
  } finally {
    appSettings.set({ stage: stageSettings.normalize({}) });
    await a.close(); await b.close();
  }
});

/* ── The page's seams ───────────────────────────────────────────────────── */

test('a lock takes Basic Stage out of picture-in-picture first, then everything stops; nothing reopens by itself', () => {
  const ui = read('player-lib/vault-ui.js');
  const halt = ui.slice(ui.indexOf('function haltAllPlayback'), ui.indexOf('function enterLockedUi'));
  const lockAt = halt.indexOf('StageControl.lockStop()');
  assert.ok(lockAt > 0, 'haltAllPlayback calls StageControl.lockStop()');
  assert.ok(lockAt < halt.indexOf('closeMiniPlayer'), 'before the mini player closes');
  const sc = read('player-lib/stage-control.js');
  const lock = sc.slice(sc.indexOf('function lockStop()'), sc.indexOf('/* ── Privacy mode'));
  assert.match(lock, /el\.pause\(\)/);
  assert.match(lock, /closeBasic\(\{ how: 'lock' \}\)/);
  const close = sc.slice(sc.indexOf('function closeBasic('), sc.indexOf('function lockStop()'));
  assert.match(close, /document\.exitPictureInPicture\(\)/);
  assert.match(sc, /Basic Stage closed when Vault locked\. Press the Stage button to show it again\./, 'said after the unlock');
  assert.ok(!/requestPictureInPicture[\s\S]{0,200}BASIC_LOCK_KEY/.test(sc), 'the note does not reopen anything');
});

test('Basic keeps every file in the mini player (its window is the Stage); the queue asks it what to pass over', () => {
  const core = read('player-lib/player/player-core.js');
  assert.match(core, /const keepMini = wasMini && \(lastPlaySource === 'auto' \|\| \(opts && opts\.stayMini === true\)\)/);
  const sc = read('player-lib/stage-control.js');
  assert.match(sc, /if \(basic\) return basicIntercept\(mediaData, opts\);/);
  assert.match(sc, /function passOver\(mediaType\) \{\s*return basic && !StageRules\.basicPlays\(mediaType\);/);
  assert.match(core, /if \(row && queuePassesOver\(row\.media_type\)\) \{ if \(passed\) passed\.push\(row\); continue; \}/);
  assert.match(sc, /if \(opts\) opts\.stayMini = true;/);
  assert.match(read('player-lib/player/mini-player.js'), /function miniPipCarrying\(\)/, 'the window is handed to the next file, not closed');
});

test('Basic: no "Stage needs mpv" dialog; Hold says it cannot go black; sizes say why not; mpv mentioned once in the tips; Vault not muted for it', () => {
  const sc = read('player-lib/stage-control.js');
  assert.ok(!sc.includes("title: 'Stage needs mpv'") && !/function noMpv/.test(sc));
  assert.match(sc, /if \(err\.code === 'MPV_MISSING'\) \{ startBasic\(\{ then \}\); return; \}/);
  assert.match(read('player-lib/stage-bar.js'), /Basic Stage can’t go black/, 'the Stage bar Hold says so');
  assert.match(sc, /Sizes need the full Stage \(mpv\)/);
  const tips = sc.slice(sc.indexOf('el.innerHTML = basic ?'), sc.indexOf(': `', sc.indexOf('el.innerHTML = basic ?')));
  assert.strictEqual((tips.match(/mpv/g) || []).length, 1, 'mpv once in the Basic tips');
  assert.match(sc, /const on = open && !basic && settings\.muteVault !== false;/);
  const ui = read('player-lib/stage-settings-ui.js');
  assert.match(ui, /Basic \(picture-in-picture\): no extra program\. It shows the address and controls when your mouse is over it, plays videos only, and stays on top\./);
  assert.match(ui, /data-stage-player/);
});

test('copy: the Basic Stage words have no dashes, and nothing links to a download', () => {
  for (const f of ['player-lib/stage-control.js', 'player-lib/stage-settings-ui.js', 'player-lib/stage-rules.js']) {
    for (const l of read(f).split('\n').filter(x => /Basic|picture-in-picture/.test(x))) {
      assert.doesNotMatch(l, /—|–/, `${f}: ${l.trim().slice(0, 90)}`);
      assert.doesNotMatch(l, /href=|https?:\/\/mpv|download=/i, `${f}: ${l.trim().slice(0, 90)}`);
    }
  }
});

/* ── The queue walking past what Basic cannot show (player-core.js, in a VM) ── */

const vm = require('node:vm');

/** player-core's own walker, lifted out of the file, with a fake list. */
function walker(types, { basic = true } = {}) {
  const core = read('player-lib/player/player-core.js');
  const grab = (sig) => {
    const i = core.indexOf(sig);
    let depth = 0;
    let j = core.indexOf('{', core.indexOf(')', i));
    for (; j < core.length; j++) { if (core[j] === '{') depth++; else if (core[j] === '}' && --depth === 0) break; }
    return core.slice(i, j + 1);
  };
  const rows = types.map((t, i) => ({ id: i + 1, media_type: t, filename: `f${i + 1}` }));
  const played = [];
  const noted = [];
  const ctx = {
    Library: { known: () => true, firstPageIds: [], length: () => rows.length, typeAt: (i) => rows[i].media_type, types: true, rowAt: (i) => rows[i], rowsForRange: async () => {} },
    NAV_WINDOW: 24,
    isKnownBadMedia: () => false,
    playIndexHandsFree: async (i) => { played.push(i); return true; },
    StageControl: { passOver: (t) => basic && t !== 'video', notePassed: (list, o) => noted.push({ names: list.map(r => r.filename), end: !!(o && o.end) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab('function queuePassesOver(')}\n${grab('async function nextPlayableIndex(')}\n${grab('async function playListStep(')}\nglobalThis.__w = { nextPlayableIndex, playListStep };`, ctx);
  return { ...ctx.__w, played, noted };
}

test('queue: Next walks past pictures to the next video, names them, opens nothing it passed (3, 5)', async () => {
  const w = walker(['video', 'image', 'gif', 'video']);
  assert.strictEqual(await w.playListStep(1, 0, false), true);
  assert.deepStrictEqual(w.played, [3], 'only the video is opened');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(w.noted)), [{ names: ['f2', 'f3'], end: false }]);
});

test('queue: Previous steps back over a picture to the video before it (3)', async () => {
  const w = walker(['video', 'image', 'video']);
  assert.strictEqual(await w.playListStep(-1, 2, false), true);
  assert.deepStrictEqual(w.played, [0]);
});

test('queue: Repeat all wraps past trailing pictures; nothing playable left says so (4)', async () => {
  const w = walker(['video', 'video', 'image', 'audio']);
  assert.strictEqual(await w.playListStep(1, 1, true), true, 'wraps to the top');
  assert.deepStrictEqual(w.played, [0]);
  const off = walker(['video', 'video', 'image', 'audio']);
  assert.strictEqual(await off.playListStep(1, 1, false), false, 'Repeat off: the end');
  assert.strictEqual(off.noted.pop().end, true, '"Nothing more that Basic Stage can play."');
  const none = walker(['image', 'gif', 'audio']);
  assert.strictEqual(await none.playListStep(1, -1, true), false);
  assert.strictEqual(none.noted.pop().end, true);
});

test('queue: with mpv (not Basic) nothing is passed over', async () => {
  const w = walker(['video', 'image', 'video'], { basic: false });
  await w.playListStep(1, 0, false);
  assert.deepStrictEqual(w.played, [1]);
  assert.deepStrictEqual(w.noted, []);
});

/* ── The remote in Basic (stage-control.js in a VM with a fake page) ─────── */

function page({ classic = false } = {}) {
  const listeners = {};
  const toasts = [];
  const cmds = [];
  const navs = [];
  let observer = null;
  const classes = new Set(classic ? [] : ['layout-modern']);
  const changed = (before) => { if ([...classes].join() !== before && observer) observer(); };
  const body = {
    classList: {
      contains: (c) => classes.has(c),
      add: (...c) => { const before = [...classes].join(); c.forEach(x => classes.add(x)); changed(before); },
      remove: (...c) => { const before = [...classes].join(); c.forEach(x => classes.delete(x)); changed(before); },
      toggle: (c, on) => { if (on) body.classList.add(c); else body.classList.remove(c); },
    },
  };
  const doc = {
    body,
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    exitPictureInPicture: () => { const el = doc.pictureInPictureElement; doc.pictureInPictureElement = null; if (el) el.dispatchEvent(new Event('leavepictureinpicture')); return Promise.resolve(); },
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: () => {},
    getElementById: () => null,
    querySelector: (q) => (q === '#miniPlayerMedia video' ? video : null),
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => null, hidden: true, style: {} }),
  };
  class FakeVideo extends EventTarget {
    constructor() { super(); this.tagName = 'VIDEO'; this.readyState = 4; this.paused = false; this.muted = false; this.currentTime = 12; }
    requestPictureInPicture() {
      doc.pictureInPictureElement = this;
      for (const fn of listeners.enterpictureinpicture || []) fn({ target: this });
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    play() { this.paused = false; for (const fn of listeners.play || []) fn({ target: this }); return Promise.resolve(); }
  }
  const video = new FakeVideo();
  const ctx = {
    document: doc, window: { addEventListener() {} }, console, setTimeout, clearTimeout, setInterval: () => 0, Promise, JSON, Math, Date, Error, Event, EventTarget,
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    HTMLMediaElement: FakeVideo,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    showToast: (m) => toasts.push(m),
    currentMediaState: { type: 'video', miniMode: true },
    minimizePlayer() {},
    getCurrentMediaIndex: () => 0,
    queueNav: (fn) => { navs.push(fn); },
    nextPlayableIndex: async () => 2,
    playIndexHandsFree: async (i) => { navs.push(`play ${i}`); return true; },
    fetch: async (url, o) => {
      if (url === '/api/stage/state') return { ok: true, status: 200, json: async () => ({ open: false, mpv: { found: false, choice: 'basic' }, settings: { tips: false } }) };
      if (url === '/api/stage/cmd') { cmds.push(JSON.parse(o.body)); return { ok: false, status: 409, json: async () => ({ error: 'Stage is not open.', code: 'STAGE_CLOSED' }) }; }
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/stage-rules.js')}\n${read('player-lib/stage-control.js')}\nglobalThis.__sc = StageControl;`, ctx);
  return { SC: ctx.__sc, toasts, cmds, navs, body, doc, video, wait: (ms) => new Promise(r => setTimeout(r, ms)) };
}

const isOpen = (p) => [p.SC._state().basic, p.SC._state().open];

for (const classic of [false, true]) {
  test(`Basic in the ${classic ? 'Classic' : 'Modern'} look stays open: the page's own class changes and privacy are not a server session (1)`, async () => {
    const p = page({ classic });
    await p.wait(10);
    await p.SC.openStage();
    await p.wait(50);
    assert.deepStrictEqual(isOpen(p), [true, true]);
    assert.ok(p.doc.pictureInPictureElement, 'in picture-in-picture');
    p.body.classList.add('pm-names');          // privacy mode hides file names
    await p.wait(50);
    assert.deepStrictEqual(p.cmds, [], 'no server command in Basic');
    assert.deepStrictEqual(isOpen(p), [true, true]);
    await p.SC.closeStage();
    assert.deepStrictEqual(isOpen(p), [false, false]);
  });
}

test('Basic: the window going without the user (its element out of the page, a failed hand-over) closes Stage cleanly; so does the mini player closing (2)', async () => {
  const p = page();
  await p.wait(10);
  await p.SC.openStage();
  await p.wait(30);
  // The element leaves picture-in-picture once it is out of the page: only the element hears it.
  p.doc.pictureInPictureElement = null;
  p.video.dispatchEvent(new Event('leavepictureinpicture'));
  await p.wait(500);
  assert.deepStrictEqual(isOpen(p), [false, false], 'not half-open');
  assert.match(p.toasts.pop(), /Stage closed/);
  await p.SC.openStage();
  await p.wait(30);
  assert.deepStrictEqual(isOpen(p), [true, true]);
  p.SC.miniClosing();                          // a give-up, the playing file trashed, closeMiniPlayer()
  assert.deepStrictEqual(isOpen(p), [false, false]);
  assert.strictEqual(p.toasts.pop(), 'Stage closed.');
});

test('Basic: a hand-picked picture is refused while open, and plays normally once Stage is closed (no stuck state)', async () => {
  const p = page();
  await p.wait(10);
  await p.SC.openStage();
  await p.wait(30);
  assert.strictEqual(p.SC.intercept({ media_type: 'image', filename: 'x.png' }, { source: 'user' }), true);
  assert.match(p.toasts.pop(), /Basic Stage plays videos only/);
  const o = {};
  assert.strictEqual(p.SC.intercept({ media_type: 'video', filename: 'v.mp4' }, o), false, 'a video plays');
  assert.strictEqual(o.stayMini, true, 'in the mini player, so in its window');
  p.SC.miniClosing();
  assert.strictEqual(p.SC.intercept({ media_type: 'image', filename: 'x.png' }, { source: 'user' }), false, 'closed: the player opens it');
});

test('Basic: Play while Held ends Hold and brings the sound back', async () => {
  const p = page();
  await p.wait(10);
  await p.SC.openStage();
  await p.wait(30);
  p.SC.toggleHold();
  assert.strictEqual(p.SC._state().basicHold, true);
  assert.deepStrictEqual([p.video.paused, p.video.muted], [true, true]);
  await p.video.play();
  assert.strictEqual(p.SC._state().basicHold, false);
  assert.strictEqual(p.video.muted, false);
});

test('Basic: Play on Stage while Basic is already open may start its list with a picture: walked past to the first video, not refused', async () => {
  const p = page();
  await p.wait(10);
  await p.SC.openStage();
  await p.wait(30);
  await p.SC.openStage({ then: () => { p.SC.intercept({ media_type: 'image', filename: 'first.png', filepath: 'C:\\x\\first.png' }, {}); } });
  assert.ok(!p.toasts.some(t => /Close Stage to open this here/.test(t)), 'not refused');
  assert.strictEqual(p.navs.length, 1, 'the queue walks on');
  await p.navs[0]();
  assert.deepStrictEqual(p.navs.slice(1), ['play 2']);
  assert.match(p.toasts.pop(), /Skipped “first\.png”: Basic Stage plays videos only\./);
});
