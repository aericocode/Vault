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

/* Sizes as measured in each look (Classic's buttons carry a border and emoji glyphs). */
const SIZES = { right: 380, unLabel: 58, volSlider: 76, repeat: 38, hold: 38, ctrls: 190, skip: 76, times: 84, pad: 28, gap: 14 };
const SIZES_CLASSIC = { ...SIZES, right: 374, ctrls: 196, unLabel: 56 };
const ALL = { skip: true, unLabel: true, volSlider: true, thumb: true, times: true, repeat: true, hold: true };

/** What a plan takes up: [right cluster, transport row, seek row]. */
function used(l, m) {
  let right = m.right;
  for (const k of ['unLabel', 'volSlider', 'repeat', 'hold']) if (!l.show[k]) right -= m[k];
  const ctrls = m.ctrls - (l.show.skip ? 0 : m.skip);
  const seekRow = l.seek + (l.show.times ? m.times : 0);
  return [right, ctrls, seekRow];
}

test('layout: the transport is in the middle of the window: both sides the same width, each holding the right-hand buttons', () => {
  for (const m of [SIZES, SIZES_CLASSIC]) {
    for (const w of [2000, 1600, 1100, 1000, 900, 760, 600, 520]) {
      const l = R.layout(w, m);
      assert.ok(l.mid != null, `${w}: centred`);
      assert.strictEqual(l.side, (w - m.pad - 2 * m.gap - l.mid) / 2, `${w}: equal sides`);
      const [right, ctrls, seekRow] = used(l, m);
      assert.ok(l.side >= right, `${w}: the right side holds its buttons (${l.side} >= ${right})`);
      assert.ok(l.mid >= Math.max(ctrls, seekRow), `${w}: the middle holds the transport and the seek row`);
    }
  }
  assert.deepStrictEqual(R.layout(2000, SIZES), { show: ALL, mid: 644, seek: 560, side: 650 }, 'wide: everything, the seek bar at its widest');
  assert.deepStrictEqual(R.layout(1100, SIZES).show, ALL, '1100: everything');
});

test('layout: narrower bars drop the 10 s buttons, then the Up next word, then the volume slider, then the times, Repeat and Hold, before the seek bar gives way', () => {
  assert.deepStrictEqual(R.layout(1000, SIZES).show, { ...ALL, skip: false, unLabel: false });
  assert.deepStrictEqual(R.layout(900, SIZES).show, { ...ALL, skip: false, unLabel: false, volSlider: false });
  assert.strictEqual(R.layout(900, SIZES).seek, R.seekWant(900), 'the seek bar keeps the width it wants while pieces can still go');
  assert.deepStrictEqual(R.layout(760, SIZES).show, { ...ALL, skip: false, unLabel: false, volSlider: false, times: false });
  const none = { skip: false, unLabel: false, volSlider: false, times: false, repeat: false, hold: false };
  assert.deepStrictEqual(R.layout(600, SIZES).show, { ...none, thumb: true, hold: true });
  // Too narrow to centre at all: everything optional gone, the seek bar at its minimum, nothing overflows
  assert.deepStrictEqual(R.layout(480, SIZES), { show: { ...none, thumb: false }, mid: null, seek: R.SEEK_MIN, side: null });
  assert.deepStrictEqual(R.layout(0), { show: ALL, mid: null, seek: null, side: null }, 'not measured yet: everything');
  assert.ok(R.layout(1100).mid > 0, 'the nominal sizes stand in before the bar is measured');
});

test('layout sweep, every 10 px from 360 to 2000 in both looks: the seek bar never gets narrower as the window widens, no piece comes back narrower, nothing overflows', () => {
  for (const [look, m] of [['Modern', SIZES], ['Classic', SIZES_CLASSIC]]) {
    let prev = null;
    for (let w = 360; w <= 2000; w += 10) {
      const l = R.layout(w, m);
      const [right, ctrls, seekRow] = used(l, m);
      assert.ok(l.seek >= R.SEEK_MIN && l.seek <= R.SEEK_MAX, `${look} ${w}: seek ${l.seek} in range`);
      if (prev) {
        assert.ok(l.seek >= prev.seek, `${look} ${w}: seek ${l.seek} < ${prev.seek} at ${w - 10}`);
        for (const k of Object.keys(l.show)) assert.ok(!(prev.show[k] && !l.show[k]), `${look}: ${k} went away at ${w} after showing at ${w - 10}`);
      }
      if (l.mid != null) {
        assert.ok(m.pad + 2 * m.gap + 2 * l.side + l.mid <= w + 1e-9, `${look} ${w}: fits`);
        assert.ok(l.side >= right && l.mid >= Math.max(ctrls, seekRow), `${look} ${w}: every column holds its content`);
      } else {
        assert.ok(m.pad + 2 * m.gap + Math.max(ctrls, seekRow) + right <= w, `${look} ${w}: uncentred, still fits`);
      }
      prev = l;
    }
  }
  // The widths the verifier saw the seek bar collapse at
  for (const [a, b] of [[790, 820], [880, 910], [910, 940]]) {
    for (const m of [SIZES, SIZES_CLASSIC]) assert.ok(R.layout(b, m).seek >= R.layout(a, m).seek, `${a} -> ${b}`);
  }
  for (let w = 360; w < 2000; w += 1) assert.ok(R.seekWant(w + 1) >= R.seekWant(w), `seekWant ${w}`);
  // A page scrollbar appearing makes the bar 15 px narrower than the window: the seek bar goes by the window
  for (const m of [SIZES, SIZES_CLASSIC]) {
    for (let w = 600; w <= 2000; w += 10) assert.ok(R.layout(w - 15, m, w).seek >= R.layout(w - 10, m, w - 10).seek, `scrollbar at ${w}`);
  }
  assert.deepStrictEqual([R.seekWant(900), R.seekWant(1100), R.seekWant(1600), R.seekWant(2000)], [160, 200, 450, 560]);
});

test('previewAt: the time under the pointer and the nearest of the five hover frames (the same rule as the player)', () => {
  const DockGeom = require('../player-lib/player/dock-geometry.js');
  const p = R.previewAt(150, 100, 400, 200, DockGeom.scrubFrameIndex);
  assert.deepStrictEqual([p.frac, p.t, p.x], [0.125, 25, 50]);
  assert.strictEqual(p.idx, DockGeom.scrubFrameIndex(25, 200));
  assert.strictEqual(R.previewAt(50, 100, 400, 200).t, 0, 'left of the bar: the start');
  assert.strictEqual(R.previewAt(900, 100, 400, 200).t, 200, 'right of it: the end');
  for (let t = 0; t <= 300; t += 7) {
    const x = 100 + (t / 300) * 400;
    assert.strictEqual(R.previewAt(x, 100, 400, 300).idx, DockGeom.scrubFrameIndex(t, 300), `the built-in rule matches at ${t}`);
  }
  assert.deepStrictEqual(R.previewAt(150, 100, 0, 200), { frac: 0, t: 0, x: 0, idx: 0 }, 'an unmeasured bar');
});

test('thumbSrc: the still is the grid tile URL (the library row version), the vault-mode copy first, nothing without a picture', () => {
  const url = (r) => (r.thumb_version ? `/thumb/${r.id}?v=${r.thumb_version}` : `/thumb/${r.id}`);
  const canShow = (r) => r.media_type !== 'document' && r.id !== 99;
  // Stage's own row may be bare (adopted after a reload): the library row carries the version
  assert.strictEqual(R.thumbSrc({ id: 5, media_type: 'video' }, { libRow: { id: 5, thumb_version: 1234, media_type: 'video' }, url, canShow }), '/thumb/5?v=1234');
  assert.strictEqual(R.thumbSrc({ id: 5, media_type: 'video' }, { url, canShow }), '/thumb/5', 'not loaded in the library: the plain URL');
  assert.strictEqual(R.thumbSrc({ id: 5, media_type: 'video' }, { libRow: { id: 6, thumb_version: 9 }, url, canShow }), '/thumb/5', 'another file row is not used');
  assert.strictEqual(R.thumbSrc({ id: 5, media_type: 'video' }, { url, canShow, blob: 'blob:x' }), 'blob:x');
  assert.strictEqual(R.thumbSrc({ id: 99, media_type: 'video' }, { url, canShow }), '', 'the server said it has no picture');
  assert.strictEqual(R.thumbSrc(null, { url }), '');
  const sc = read('player-lib/stage-control.js');
  assert.match(sc, /StageBarRules\.thumbSrc\(row, \{ libRow, canShow: canShowThumb, url: thumbUrl, blob \}\)/);
});

test('css: equal side columns around the middle; the still shows the Stage icon (not a black box) while its thumbnail is still being made', () => {
  const css = read('css/stage-remote.css');
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) var\(--sb-mid, auto\) minmax\(0, 1fr\);/);
  assert.match(css, /\.stage-bar\.sb-uncentered \{ grid-template-columns: minmax\(0, 1fr\) auto auto; \}/);
  assert.match(css, /\.sb-thumb:not\(\.thumb-fallback\) img:not\(\[hidden\]\) \+ \.sb-thumb-ic \{ display: none; \}/);
  assert.doesNotMatch(css.slice(css.indexOf('.sb-thumb {'), css.indexOf('}', css.indexOf('.sb-thumb {'))), /background: #000/);
  assert.match(css, /body\.pm-thumbs #stageBarThumbImg,\s*body\.pm-thumbs \.sb-preview img \{ filter: blur\(14px\); \}/);
  const bar = read('player-lib/stage-bar.js');
  assert.match(bar, /img\.src = typeof scrubUrl === 'function' \? scrubUrl\(v\.id, p\.idx\)/, 'the player hover frames, not a second system');
  assert.match(bar, /v\.mediaType === 'video' && hoverOn/, 'videos only, and only with hover frames on');
  assert.doesNotMatch(read('db-viewer.html'), /id="stageBarSeek"[^>]*title=/, 'no tooltip over the hover frame');
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
  assert.ok(p.els.stageBar._cls.has('sb-no-skip') && p.els.stageBar._cls.has('sb-no-label') && p.els.stageBar._cls.has('sb-no-volslider') && !p.els.stageBar._cls.has('sb-no-repeat'), '900 px: the 10 s buttons, the Up next word and the volume slider go');
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

test('Up next, the Stage menu and the tips open above the bar while it shows; the X closes Stage and stops', () => {
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
  assert.match(bar, /case 'close': if \(SC\) SC\.closeStageAndStop\(\); break;/);
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

/** stage-control.js in a VM, Basic Stage (no mpv), a video in the mini player. */
function basicVm(extra = {}) {
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
  const toasts = [];
  const ctx = {
    document: doc, window: { addEventListener() {} }, console, setTimeout, clearTimeout, setInterval: () => 0, Promise, JSON, Math, Date, Error, Event, EventTarget,
    MutationObserver: class { constructor(fn) { observer = fn; } observe() {} },
    HTMLMediaElement: FakeVideo,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    showToast: (m) => toasts.push(String(m)),
    currentMediaState: { type: 'video', miniMode: true, currentMediaData: { id: 4, filename: 'secret.mp4', media_type: 'video' } },
    minimizePlayer() {},
    StageBarRules: R,
    StageBar: { show() {}, hide() {}, shown: () => true, anchorRect: () => null, paint: (v) => painted.push(v) },
    ...extra,
    fetch: async (url, o) => {
      if (url === '/api/stage/cmd') cmds.push(JSON.parse(o.body));
      if (url === '/api/stage/state') return { ok: true, status: 200, json: async () => ({ open: false, mpv: { found: false, choice: 'basic' }, settings: { tips: false } }) };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/stage-rules.js')}\n${read('player-lib/stage-control.js')}\nglobalThis.__sc = StageControl;`, ctx);
  return { ctx, SC: ctx.__sc, body, painted, cmds, toasts };
}

async function openBasic(p) {
  await new Promise(r => setTimeout(r, 10));
  await p.SC.openStage();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(p.SC._state().basic, true);
}

test('Basic Stage: turning privacy names on while held repaints the bar ("this file"), and sends nothing to the server', async () => {
  const p = basicVm();
  const { ctx, body, painted, cmds } = p;
  await openBasic(p);
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

/* ── Basic Stage and a video this browser cannot play ──────────────────── */

function deadVm({ dir = 'next', source = 'auto', moves = true } = {}) {
  const calls = [];
  const lib = { 10: { id: 10, filename: 'rx-xvid-mp3.avi', media_type: 'video' } };
  const p = basicVm({
    lastQueueDir: dir,
    lastPlaySource: source,
    Library: { row: (id) => lib[id] || null },
    queueNav: (fn) => fn(),
    queueMove: async (d) => { calls.push(`move ${d}`); return moves; },
    playNextMediaOrWrap: async () => { calls.push('next or wrap'); return moves; },
    closeMediaPlayer: () => calls.push('close'),
    noteSkippedThisSession: (row, why) => calls.push(`noted ${row.filename}: ${why}`),
    isKnownBadMedia: (row) => !!(row && row.playback_failed),
  });
  return { ...p, calls, lib };
}

test('Basic Stage: a video that fails to play is stepped over (the next one plays, the window stays), said once, and marked so the queue walks past it after', async () => {
  const p = deadVm();
  await openBasic(p);
  const dead = { id: 10, filename: 'rx-xvid-mp3.avi', media_type: 'video' };
  assert.strictEqual(p.SC.basicMediaFailed(dead), true, 'handled: the player does not give up (which closed the mini player and Stage)');
  await new Promise(r => setTimeout(r, 0));
  assert.deepStrictEqual(p.calls, ['next or wrap', 'noted rx-xvid-mp3.avi: it can’t be played here']);
  assert.strictEqual(p.toasts.at(-1), 'Skipped “rx-xvid-mp3.avi”: it can’t be played here.');
  assert.strictEqual(p.lib[10].playback_failed, 1, 'the library row is marked: Previous and Next step over it now');
  assert.deepStrictEqual([p.SC._state().basic, p.SC._state().open], [true, true], 'Stage stays open');
});

test('Basic Stage: a video that fails after Previous is stepped over backwards; with nothing left Stage closes and says why; mpv Stage is not affected', async () => {
  const back = deadVm({ dir: 'prev' });
  await openBasic(back);
  back.SC.basicMediaFailed({ id: 10, filename: 'x.avi', media_type: 'video' });
  await new Promise(r => setTimeout(r, 0));
  assert.strictEqual(back.calls[0], 'move prev');
  const end = deadVm({ moves: false });
  await openBasic(end);
  end.SC.basicMediaFailed({ id: 10, filename: 'x.avi', media_type: 'video' });
  await new Promise(r => setTimeout(r, 0));
  assert.deepStrictEqual(end.calls, ['next or wrap', 'close']);
  assert.strictEqual(end.toasts.at(-1), 'Skipped “x.avi”: it can’t be played here. Nothing more that Basic Stage can play.');
  const off = deadVm();
  assert.strictEqual(off.SC.basicMediaFailed({ id: 10 }), false, 'not Basic: the player handles it as always');
});

test('Basic Stage: a video already known not to play here is not tried: a pick of it is refused with the same words, the list walks past it', async () => {
  const p = deadVm();
  await openBasic(p);
  p.lib[10].playback_failed = 1;
  assert.strictEqual(p.SC.intercept({ id: 10, filename: 'rx-xvid-mp3.avi', media_type: 'video' }, { source: 'user' }), true);
  assert.strictEqual(p.toasts.at(-1), 'Skipped “rx-xvid-mp3.avi”: it can’t be played here.');
  assert.strictEqual(p.SC.intercept({ id: 4, filename: 'fine.mp4', media_type: 'video' }, {}), false, 'a good video plays');
  // A hands-free move names the next file by path only: it is judged on its own row, never the dead file still playing
  p.ctx.currentMediaState.playbackMediaId = 10;
  assert.strictEqual(p.SC.intercept({ filepath: 'C:\\v\\next.mp4', filename: 'next.mp4', media_type: 'video' }, { source: 'auto' }), false);
  const core = read('player-lib/player/player-core.js');
  const err = core.slice(core.indexOf('function handleMediaError('), core.indexOf('function highlightCard('));
  assert.ok(err.indexOf('StageControl.basicMediaFailed') > 0 && err.indexOf('StageControl.basicMediaFailed') < err.indexOf('giveUp();'), 'asked before the player gives up');
  assert.match(core, /async function queueMove\(dir, auto\) \{\s*lastQueueDir = dir;/);
  assert.match(core, /if \(row && !isKnownBadMedia\(row\)\) return i;/, 'the queue walk (Next and Previous) passes over known-bad files');
});
