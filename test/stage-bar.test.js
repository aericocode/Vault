/**
 * The Stage bar (player-lib/stage-bar.js): the remote while Stage is open,
 * docked along the bottom in place of the mini player.
 *  - StageBarRules   what fits at a width, the height kept free, and the
 *                    view drawn from what Stage is doing (pure)
 *  - StageBar        show / hide keep and give back the page's room, the
 *                    Flow text hook (a fake page in a VM)
 *  - utils.js        toasts step over the bar
 *  - the page's seams (source): the markup, the mini player hidden under the
 *    bar, Up next and the menu opening above it
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const R = require('../player-lib/stage-bar.js');

/* ── What fits ──────────────────────────────────────────────────────────── */

test('fit: a wide bar shows everything; narrower ones drop the 10 s buttons, then the Up next word, then the volume slider, then the still, then the times and Repeat, then Hold', () => {
  const all = { skip: true, unLabel: true, volSlider: true, thumb: true, times: true, repeat: true, hold: true };
  assert.deepStrictEqual(R.fit(1600), all);
  assert.deepStrictEqual(R.fit(1024), all);
  assert.deepStrictEqual(R.fit(1000), { ...all, skip: false });
  assert.deepStrictEqual(R.fit(900), { ...all, skip: false });
  assert.deepStrictEqual(R.fit(860), { ...all, skip: false, unLabel: false });
  const narrow = { ...all, skip: false, unLabel: false, volSlider: false };
  assert.deepStrictEqual(R.fit(700), narrow);
  assert.deepStrictEqual(R.fit(500), { ...narrow, thumb: false });
  assert.deepStrictEqual(R.fit(470), { ...narrow, thumb: false, times: false, repeat: false });
  assert.deepStrictEqual(R.fit(390), { ...narrow, thumb: false, times: false, repeat: false, hold: false });
  // Never brings a piece back as it narrows (one row, the order above)
  let prev = R.fit(2000);
  for (let w = 2000; w >= 300; w -= 10) {
    const f = R.fit(w);
    for (const k of Object.keys(f)) assert.ok(!(f[k] && !prev[k]), `${k} came back at ${w}`);
    prev = f;
  }
  assert.deepStrictEqual(R.fit(0), all, 'not measured yet: everything');
});

test('reserve: the bar\'s own height while shown (rounded up), nothing once hidden', () => {
  assert.strictEqual(R.reserve(true, 75), 75);
  assert.strictEqual(R.reserve(true, 74.2), 75);
  assert.strictEqual(R.reserve(false, 75), 0);
  assert.strictEqual(R.reserve(true, 0), 0);
  assert.strictEqual(R.reserve(true, undefined), 0);
});

/* ── The view ───────────────────────────────────────────────────────────── */

const playing = { hasFile: true, filename: 'clip.mp4', mediaType: 'video', t: 65, d: 300, paused: false, volume: 0.8, muted: false, repeat: 'off', upNext: 0 };

test('view: a video on Stage: its name, On Stage (live), the times, the seek bar, Pause', () => {
  const v = R.view(playing);
  assert.strictEqual(v.title, 'clip.mp4');
  assert.deepStrictEqual(v.pill, { word: 'On Stage', live: true });
  assert.strictEqual(v.note, '');
  assert.deepStrictEqual([v.seek.now, v.seek.end, v.seek.enabled], ['1:05', '5:00', true]);
  assert.ok(Math.abs(v.seek.fraction - 65 / 300) < 1e-9);
  assert.deepStrictEqual(v.play, { paused: false, label: 'Pause' });
  assert.deepStrictEqual([v.volume.silent, v.volume.value, v.volume.title], [false, 0.8, 'Mute Stage']);
  assert.strictEqual(v.front, 'Bring Stage to the front');
  assert.strictEqual(R.view({ ...playing, t: 3725, d: 7200 }).seek.now, '1:02:05');
  assert.strictEqual(R.view({ ...playing, fmt: (s) => `${s}s` }).seek.now, '65s', 'the page\'s own formatter when given');
});

test('view: privacy mode hides the name ("this file"), and a file with no name says the same', () => {
  assert.strictEqual(R.view({ ...playing, namesHidden: true }).title, 'this file');
  assert.strictEqual(R.view({ ...playing, filename: '' }).title, 'this file');
});

test('view: the status pill and line: Holding, Finished, Locked; a note; getting ready', () => {
  const held = R.view({ ...playing, hold: true, paused: true, t: 83 });
  assert.deepStrictEqual(held.pill, { word: 'Holding', live: false });
  assert.strictEqual(held.note, 'Holding. Paused at 1:23. Press Hold again to come back.');
  assert.strictEqual(held.play.label, 'Play');
  assert.match(held.hold.title, /^Holding: Stage is black and silent/);
  assert.strictEqual(R.view({ ...playing, finished: true }).pill.word, 'Finished');
  const locked = R.view({ ...playing, locked: true, hold: true });
  assert.deepStrictEqual([locked.pill.word, locked.note, locked.seek.enabled], ['Locked', 'Stage went black. Unlock to carry on.', false]);
  assert.strictEqual(R.view({ ...playing, note: 'Skipped “x.mp4”: it can’t be played.' }).note, 'Skipped “x.mp4”: it can’t be played.');
  assert.strictEqual(R.view({ ...playing, loading: true }).note, 'Getting ready…');
  assert.strictEqual(R.view({ ...playing, loading: true, note: 'End of the list.' }).note, 'End of the list.', 'a note says more than getting ready');
});

test('view: nothing on Stage yet: "Stage is open", what to do, nothing to press but the bar\'s own buttons', () => {
  const v = R.view({ hasFile: false, repeat: 'off' });
  assert.strictEqual(v.title, 'Stage is open');
  assert.strictEqual(v.note, 'Play a file to show it there.');
  assert.deepStrictEqual([v.hasFile, v.seek.enabled, v.seek.now, v.seek.end, v.play.paused], [false, false, '', '', true]);
  assert.strictEqual(R.view({ hasFile: false, basic: true }).note, 'Play a video to show it there.');
});

test('view: a picture: no seek, its countdown on the right (paused or running), none while held', () => {
  const pic = { ...playing, mediaType: 'image', t: 3, d: 8, pictureLive: true };
  const v = R.view(pic);
  assert.deepStrictEqual([v.seek.enabled, v.seek.now, v.seek.end], [false, '', 'next in 5 s']);
  assert.strictEqual(R.view({ ...pic, paused: true }).seek.end, 'paused · 5 s left');
  assert.strictEqual(R.view({ ...pic, hold: true }).seek.end, '');
  assert.strictEqual(R.view({ ...pic, pictureLive: false }).seek.end, '', 'not reported by Stage yet');
  assert.match(R.view({ ...pic, hold: true }).note, /^Holding\. Press Hold again/, 'no "Paused at" for a picture');
});

test('view: Basic Stage: Hold pauses and mutes (it says it cannot go black); the volume is the page\'s', () => {
  const b = { ...playing, basic: true, volumeMax: 1.5, volume: 1.2 };
  const v = R.view(b);
  assert.match(v.hold.title, /Basic Stage can’t go black/);
  assert.deepStrictEqual([v.volume.max, v.volume.value, v.volume.title], [1.5, 1.2, 'Mute']);
  assert.strictEqual(R.view({ ...b, hold: true }).note, 'Holding: paused and muted. Press Hold again to come back.');
  assert.strictEqual(R.view({ ...b, muted: true }).volume.title, 'Unmute');
  assert.strictEqual(v.front, 'Show the picture-in-picture window');
});

test('view: volume, Repeat and Up next', () => {
  assert.deepStrictEqual(R.view({ ...playing, muted: true }).volume, { silent: true, value: 0, max: 1, title: 'Unmute Stage' });
  assert.strictEqual(R.view({ ...playing, volume: 0 }).volume.silent, true);
  assert.deepStrictEqual(R.view({ ...playing, repeat: 'one' }).repeat, { mode: 'one', title: 'Repeat this file. Click to turn repeat off', label: 'Repeat this file' });
  assert.strictEqual(R.view({ ...playing, repeat: 'odd' }).repeat.mode, 'off');
  assert.deepStrictEqual(R.view({ ...playing, upNext: 1 }).upNext, { count: 1, label: 'Up next, 1 file' });
  assert.deepStrictEqual(R.view({ ...playing, upNext: 3 }).upNext, { count: 3, label: 'Up next, 3 files' });
  assert.deepStrictEqual(R.view(playing).upNext, { count: 0, label: 'Up next' });
});

test('copy: the bar\'s words have no dashes', () => {
  const src = read('player-lib/stage-bar.js');
  const strings = src.match(/'[^'\n]*'|`[^`\n]*`/g) || [];
  for (const s of strings) assert.doesNotMatch(s, /—|–/, s);
  const html = read('db-viewer.html');
  const bar = html.slice(html.indexOf('id="stageBar"'), html.indexOf('<!-- Jump back to the top'));
  assert.doesNotMatch(bar, /—|–/);
});

/* ── The bar on a fake page: room kept and given back, the Flow hook ───── */

function fakePage({ focusInMini = false, pmNames = false } = {}) {
  const els = {};
  const classes = (set) => ({
    add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)),
    contains: (c) => set.has(c), toggle: (c, on) => { if (on === undefined ? !set.has(c) : on) set.add(c); else set.delete(c); },
  });
  const el = (id, extra = {}) => {
    const set = new Set();
    els[id] = { id, hidden: true, textContent: '', style: {}, dataset: {}, attrs: {}, classList: classes(set), _cls: set,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      addEventListener() {}, querySelector: () => null, contains: () => false, matches: () => false,
      getBoundingClientRect: () => ({ left: 0, top: 925, right: 1600, bottom: 1000, width: 1600, height: 75 }),
      ...extra };
    return els[id];
  };
  const focused = [];
  el('stageBar', { clientWidth: 900, offsetHeight: 74.4, focus() { focused.push('stageBar'); } });
  el('stageBarFlow');
  el('stageBarTitle');
  const miniBtn = { id: 'miniStageBtn', blur() { focused.push('blur miniStageBtn'); } };
  el('miniPlayer', { contains: (x) => x === miniBtn });
  const rootProps = {};
  const bodySet = new Set(pmNames ? ['pm-names'] : []);
  const placed = [];
  const ctx = {
    console, Math, JSON, String, Number, Object, Array, Set, Map,
    document: {
      getElementById: (id) => els[id] || null,
      activeElement: focusInMini ? miniBtn : null,
      body: { classList: classes(bodySet) },
      documentElement: { style: { setProperty: (k, v) => { rootProps[k] = v; }, removeProperty: (k) => { delete rootProps[k]; } } },
    },
    vaultPlaceToasts: () => placed.push('toasts'),
    miniLayout: () => placed.push('mini'),
  };
  ctx.window = ctx;
  ctx.innerWidth = 900;
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/stage-bar.js')}\nglobalThis.__sb = StageBar;`, ctx);
  return { SB: ctx.__sb, els, rootProps, bodySet, placed, focused };
}

test('show keeps the bar\'s height free (body.stage-bar-on, --stagebar-h) and fits it to its width; hide gives the room back and puts the mini player back', () => {
  const p = fakePage();
  p.SB.show();
  assert.strictEqual(p.SB.shown(), true);
  assert.strictEqual(p.els.stageBar.hidden, false);
  assert.ok(p.bodySet.has('stage-bar-on'));
  assert.strictEqual(p.rootProps['--stagebar-h'], '75px');
  assert.ok(p.els.stageBar._cls.has('sb-no-skip') && !p.els.stageBar._cls.has('sb-no-label'), '900 px: the 10 s buttons go');
  assert.ok(p.placed.includes('toasts'), 'the toasts step over it');
  p.placed.length = 0;
  p.SB.hide();
  assert.strictEqual(p.SB.shown(), false);
  assert.strictEqual(p.els.stageBar.hidden, true);
  assert.ok(!p.bodySet.has('stage-bar-on'));
  assert.ok(!('--stagebar-h' in p.rootProps));
  assert.deepStrictEqual(p.placed, ['mini', 'toasts'], 'the mini player goes back to its corner, then the toasts');
  assert.strictEqual(p.SB.anchorRect('upnext'), null, 'nothing opens from a hidden bar');
});

test('setFlowText: the Flow order hook fills the spot beside the pill, and empties it', () => {
  const p = fakePage();
  p.SB.setFlowText('128 BPM · high');
  assert.deepStrictEqual([p.els.stageBarFlow.textContent, p.els.stageBarFlow.hidden, p.SB.flowText()], ['128 BPM · high', false, '128 BPM · high']);
  p.SB.setFlowText('');
  assert.deepStrictEqual([p.els.stageBarFlow.textContent, p.els.stageBarFlow.hidden], ['', true]);
  p.SB.setFlowText(null);
  assert.strictEqual(p.els.stageBarFlow.hidden, true);
});

/* ── Toasts step over the bar (utils.js) ───────────────────────────────── */

test('a toast that would sit on the Stage bar goes just above it (the mini player under it is not what counts)', () => {
  const vh = 1000;
  const mk = (id, r, extra = {}) => ({ id, style: {}, hidden: false, offsetHeight: r.bottom - r.top, classList: { contains: (c) => (extra.cls || []).includes(c) },
    getBoundingClientRect() { const b = parseFloat(this.style.bottom); const h = r.bottom - r.top; return Number.isFinite(b) ? { ...r, top: vh - b - h, bottom: vh - b } : r; }, ...extra });
  const bar = mk('stageBar', { left: 0, right: 1600, top: 925, bottom: 1000 });
  const toast = mk('toast', { left: 1300, right: 1560, top: 924, bottom: 968 }, { cls: ['active'] });
  const mini = mk('miniPlayer', { left: 1100, right: 1580, top: 700, bottom: 970 }, { cls: ['active'] });
  const bodyCls = new Set(['stage-bar-on']);
  const els = { stageBar: bar, toast, miniPlayer: mini };
  const ctx = {
    console, Math, JSON, String, Number, Object, Array, Set, Map, parseFloat,
    window: { innerWidth: 1600, innerHeight: vh },
    document: {
      getElementById: (id) => els[id] || null, addEventListener() {}, querySelector: () => null,
      body: { classList: { contains: (c) => bodyCls.has(c) } },
      documentElement: { style: { setProperty() {} } },
    },
    getComputedStyle: (el) => ({ bottom: el.style.bottom || '32px', left: 'auto', right: '56px' }),
  };
  vm.createContext(ctx);
  vm.runInContext(read('player-lib/utils.js'), ctx);
  ctx.vaultToastsClearOfMini(null, toast);
  assert.strictEqual(toast.style.bottom, `${vh - 925 + 10}px`, 'just above the bar');
  // Without the bar the mini player is what counts again
  bodyCls.delete('stage-bar-on');
  bar.hidden = true;
  toast.style = {};
  ctx.vaultToastsClearOfMini(null, toast);
  assert.strictEqual(toast.style.bottom, `${vh - 700 + 10}px`, 'above the mini player');
});

/* ── The page's seams (source) ──────────────────────────────────────────── */

test('markup: the bar has every control, the Flow spot, and loads before stage-control.js; the mini player lost its Stage dressing', () => {
  const html = read('db-viewer.html');
  for (const id of ['stageBar', 'stageBarFront', 'stageBarTitle', 'stageBarPill', 'stageBarNote', 'stageBarFlow', 'stageBarPrev', 'stageBarBack',
    'stageBarPlay', 'stageBarFwd', 'stageBarNext', 'stageBarSeek', 'stageBarNow', 'stageBarEnd', 'stageBarUpNext', 'stageBarUpNextCount',
    'stageBarRepeat', 'stageBarHold', 'stageBarMute', 'stageBarVol', 'stageBarMenu', 'stageBarClose']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<span class="stagebar-flow" id="stageBarFlow" hidden><\/span>/);
  assert.match(html, /id="stageBarSeek" role="slider" tabindex="0"/, 'the seek bar takes the keyboard');
  assert.ok(html.indexOf('player-lib/stage-bar.js') > 0 && html.indexOf('player-lib/stage-bar.js') < html.indexOf('player-lib/stage-control.js'));
  for (const gone of ['miniStagePill', 'miniHoldBtn', 'miniRepeatBtn', 'mini-stage-only', 'mini-stage-hide']) assert.ok(!html.includes(gone), gone);
  const sc = read('player-lib/stage-control.js');
  for (const gone of ['miniStagePill', 'miniHoldBtn', 'miniStageStill', 'mini-stage-basic', 'miniPlayerTitle']) assert.ok(!sc.includes(gone), `stage-control.js still has ${gone}`);
  assert.ok(!/mini-stage/.test(read('css/stage-remote.css')), 'the mini player\'s Stage dressing is gone');
});

test('css: the mini player hides under the bar; the page, the dock, the rail, the Wall, the selection bar and the Top pill move up by its height', () => {
  const css = read('css/stage-remote.css');
  assert.match(css, /body\.stage-bar-on #miniPlayer \{\s*visibility: hidden !important;\s*pointer-events: none !important;/);
  assert.match(css, /body\.stage-bar-on \{ padding-bottom: var\(--stagebar-h, 0px\); \}/);
  for (const sel of ['.library-dock', '.filter-rail', '.wall-root']) assert.ok(css.includes(`body.stage-bar-on ${sel}`), sel);
  assert.match(css, /body\.stage-bar-on \.selection-bar,\s*body\.stage-bar-on \.scroll-top-pill \{ bottom: calc\(18px \+ var\(--stagebar-h, 0px\)\); \}/);
  for (const c of ['sb-no-skip .sb-skip', 'sb-no-label .sb-un-label', 'sb-no-volslider .sb-vol-slider', 'sb-no-thumb .sb-thumb']) assert.ok(css.includes(c), c);
});

test('Up next, the Stage menu and the tips open above the bar while it shows; Close Stage carries on in the mini player', () => {
  const un = read('player-lib/up-next.js');
  assert.match(un, /const r = sb \? sb\.anchorRect\('upnext'\) : mini\.getBoundingClientRect\(\);/);
  assert.match(un, /if \(!miniOpen\(\) && !stageBar\(\)\) return;/, 'opens from the bar even before Basic plays a video');
  assert.match(un, /stageBar\(\)\.contains\(document\.activeElement\)/, 'U with the bar in hand: the file playing');
  const sc = read('player-lib/stage-control.js');
  assert.match(sc, /placeNear\(el, 'menu'\)/);
  assert.match(sc, /placeNear\(el, 'tips'\)/);
  assert.match(sc, /if \(remoteShown \|\| basic\) \{ b\.show\(\); paint\(\); \} else b\.hide\(\);/);
  assert.match(sc, /Press the picture on the Stage bar to show Stage\./);
  const bar = read('player-lib/stage-bar.js');
  assert.match(bar, /case 'close': if \(SC\) SC\.closeStage\(\); break;/);
  assert.match(bar, /\$\('stageBarMenu'\)\?\.addEventListener\('contextmenu', \(e\) => act\('menu', e\)\);/, 'right-click opens the menu too');
});

test('opening Stage from the mini player\'s own Stage button: focus leaves the now hidden button for the bar, so Space cannot press it unseen', () => {
  const p = fakePage({ focusInMini: true });
  p.SB.show();
  assert.deepStrictEqual(p.focused, ['blur miniStageBtn', 'stageBar']);
  const q = fakePage();
  q.SB.show();
  assert.deepStrictEqual(q.focused, [], 'focus elsewhere is left alone');
  assert.match(read('db-viewer.html'), /id="stageBar" role="region" aria-label="Stage" tabindex="-1"/, 'the bar can take focus');
});

test('privacy mode: the bar title has no name in its tooltip, and the CSS blurs it like the players\' titles', () => {
  const p = fakePage({ pmNames: true });
  p.SB.paint(R.view({ ...playing, namesHidden: false }));
  assert.strictEqual(p.els.stageBarTitle.title, '', 'no name in the tooltip even from a stale view');
  const q = fakePage();
  q.SB.paint(R.view(playing));
  assert.strictEqual(q.els.stageBarTitle.title, 'clip.mp4');
  assert.match(read('css/stage-remote.css'), /body\.pm-names #stageBarTitle \{\s*filter: blur\(7px\);/);
});

test('a narrow bar has Repeat and Hold in the Stage menu instead; dropped() says which', () => {
  const p = fakePage();
  p.els.stageBar.clientWidth = 390;
  p.SB.show();
  assert.deepStrictEqual({ ...p.SB.dropped() }, { skip: true, unLabel: true, volSlider: true, thumb: true, times: true, repeat: true, hold: true });
  for (const c of ['sb-no-times', 'sb-no-repeat', 'sb-no-hold']) assert.ok(p.els.stageBar._cls.has(c), c);
  p.SB.hide();
  assert.deepStrictEqual({ ...p.SB.dropped() }, {}, 'nothing while hidden');
  const sc = read('player-lib/stage-control.js');
  assert.match(sc, /dropped\.repeat \? .*data-stage-act="repeat"/);
  assert.match(sc, /dropped\.hold \? .*data-stage-act="hold"/);
  assert.match(sc, /else if \(act === 'repeat'\) \{ if \(typeof cycleRepeatMode === 'function'\) cycleRepeatMode\(\); \}\s*else if \(act === 'hold'\) toggleHold\(\);/);
  assert.match(read('css/stage-remote.css'), /\.stage-bar\.sb-no-repeat #stageBarRepeat,\s*\.stage-bar\.sb-no-hold #stageBarHold \{ display: none; \}/);
});

test('one paint per Stage report; Basic volume and mute repaint by hand (a gain change fires no volumechange)', () => {
  const sc = read('player-lib/stage-control.js');
  const status = sc.slice(sc.indexOf('function onStatus('), sc.indexOf('function onStarted('));
  assert.strictEqual((status.match(/\bpaint\(\)/g) || []).length, 1, 'only the "still the file before" branch paints itself');
  assert.match(status, /fire\('timeupdate'\);\s*\/\/ draws the bar/);
  assert.match(sc, /proxy\.addEventListener\('timeupdate', \(\) => paint\(\)\);/);
  const bar = read('player-lib/stage-bar.js');
  assert.match(bar, /miniSetVolume\(slider\.value\);\s*\/\/[^\n]*\n\s*if \(typeof StageControl !== 'undefined'\) StageControl\.paintVolume\(\);/);
  assert.match(bar, /miniToggleMute\(\);\s*if \(SC\) SC\.paintVolume\(\);/);
});

/* ── Basic Stage and privacy (stage-control.js in a VM, a fake page) ────── */

test('Basic Stage: turning privacy names on while held repaints the bar ("this file"), and sends nothing to the server', async () => {
  let observer = null;
  const classes = new Set(['layout-modern']);
  const body = { classList: {
    contains: (c) => classes.has(c),
    add: (...c) => { c.forEach(x => classes.add(x)); if (observer) observer(); },
    remove: (...c) => { c.forEach(x => classes.delete(x)); if (observer) observer(); },
    toggle: (c, on) => { if (on) body.classList.add(c); else body.classList.remove(c); },
  } };
  const doc = {
    body, pictureInPictureEnabled: true, pictureInPictureElement: null,
    exitPictureInPicture: () => { doc.pictureInPictureElement = null; return Promise.resolve(); },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => null, hidden: true, style: {} }),
  };
  class FakeVideo extends EventTarget {
    constructor() { super(); this.tagName = 'VIDEO'; this.readyState = 4; this.paused = true; this.muted = false; this.currentTime = 12; this.duration = 30; }
    requestPictureInPicture() { doc.pictureInPictureElement = this; return Promise.resolve(); }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
  }
  const video = new FakeVideo();
  const mini = { classList: { contains: (c) => c === 'active' } };
  doc.getElementById = (id) => (id === 'miniPlayer' ? mini : null);
  doc.querySelector = (q) => (q === '#miniPlayerMedia video' ? video : null);
  const painted = [];
  const cmds = [];
  const ctx = {
    document: doc, window: { addEventListener() {} }, console, setTimeout, clearTimeout, setInterval: () => 0, Promise, JSON, Math, Date, Error, Event, EventTarget,
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    HTMLMediaElement: FakeVideo,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    showToast() {},
    currentMediaState: { type: 'video', miniMode: true, currentMediaData: { id: 4, filename: 'secret.mp4', media_type: 'video' } },
    minimizePlayer() {},
    StageBarRules: R,
    StageBar: { show() {}, hide() {}, shown: () => true, anchorRect: () => null, paint: (v) => painted.push(v) },
    fetch: async (url, o) => {
      if (url === '/api/stage/cmd') cmds.push(JSON.parse(o.body));
      if (url === '/api/stage/state') return { ok: true, status: 200, json: async () => ({ open: false, mpv: { found: false, choice: 'basic' }, settings: { tips: false } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/stage-rules.js')}\n${read('player-lib/stage-control.js')}\nglobalThis.__sc = StageControl;`, ctx);
  await new Promise(r => setTimeout(r, 10));
  await ctx.__sc.openStage();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(ctx.__sc._state().basic, true);
  ctx.__sc.toggleHold();                          // held (paused): no video event will repaint
  assert.strictEqual(painted.at(-1).title, 'secret.mp4');
  const before = painted.length;
  body.classList.add('pm-names');
  assert.ok(painted.length > before, 'painted again');
  assert.strictEqual(painted.at(-1).title, 'this file');
  body.classList.remove('pm-names');
  assert.strictEqual(painted.at(-1).title, 'secret.mp4');
  assert.deepStrictEqual(cmds, [], 'Basic has no server session');
});
