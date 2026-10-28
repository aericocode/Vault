/**
 * Full-screen Flow (player-lib/flow.js "Full screen"):
 *  - the pure parts (player-lib/flow-chart-math.js): Fit and Zoom geometry,
 *    the plot's height, what is under the pointer (a column and where in
 *    it, or a hand-over), the pointer's place as a time and a hover frame
 *    (as the seek bars pick them), keeping the playing column in view, and
 *    the sideways scroll while a drag sits near an edge;
 *  - flow.js in a vm with a permissive fake page: in and out (the button's
 *    toggle, F, Esc, never while typing or when another listener took Esc),
 *    the order and picks kept, the grid not drawn on every poll while full
 *    screen covers it, picking a file or a hand-over for the strip, and a
 *    column drag in Zoom (also after the chart scrolled sideways).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../player-lib/flow-chart-math.js');
const FlowOrder = require('../player-lib/flow-order.js');
const DragAutoScroll = require('../player-lib/drag-autoscroll.js');
const DockGeom = require('../player-lib/player/dock-geometry.js');

/* ── The pure parts ───────────────────────────────────────────────────── */

test('Fit puts the whole list in the width; Zoom gives each file FS_COL_PX and widens the chart', () => {
  const fit = M.fsLayout(1200, 40, 40, 8, false);
  assert.strictEqual(fit.W, 1200);
  assert.strictEqual(fit.step, (1200 - 48) / 40);
  const zoom = M.fsLayout(1200, 40, 40, 8, true);
  assert.strictEqual(zoom.step, M.FS_COL_PX);
  assert.strictEqual(zoom.W, 48 + 40 * M.FS_COL_PX, 'scrolled sideways');
  // A short list is already wider than FS_COL_PX a file: Zoom changes nothing.
  assert.deepStrictEqual(M.fsLayout(1200, 4, 40, 8, true), M.fsLayout(1200, 4, 40, 8, false));
  assert.strictEqual(M.fsLayout(50, 3, 40, 8, false).W, 200, 'never narrower than 200');
});

test('the plot gets the height the lanes, names, thumbnails and scrollbar leave, never under 80', () => {
  const plain = M.fsPlotHeight(600, { lanes: 0 });
  const lanes = M.fsPlotHeight(600, { lanes: 3 });
  assert.strictEqual(plain - lanes, 3 * 14);
  const thumbs = M.fsPlotHeight(600, { lanes: 3, thumbs: M.fsThumbHeight(140), bar: 14 });
  assert.strictEqual(lanes - thumbs, M.fsThumbHeight(140) + 14);
  assert.strictEqual(M.fsPlotHeight(60, { lanes: 5 }), 80);
  assert.ok(M.fsThumbHeight(140) > 60 && M.fsThumbHeight(140) < 100, '16:9 in a 140 px column');
});

test('hit: a column and how far across its line, or a hand-over near the line between two', () => {
  const g = { L: 40, R: 8, W: 548, TOP: 16, PH: 200, n: 5, step: 100, gap: 10, dense: false };
  assert.deepStrictEqual(M.chartHit(90, 100, g), { kind: 'col', i: 0, frac: 0.5 });
  assert.deepStrictEqual(M.chartHit(50, 100, g), { kind: 'col', i: 0, frac: 0 }, 'the start of its line (after the gap)');
  assert.deepStrictEqual(M.chartHit(130, 100, g), { kind: 'col', i: 0, frac: 1 }, 'the end of its line');
  assert.deepStrictEqual(M.chartHit(240 + 4, 100, g), { kind: 'hand', i: 1 }, 'between 2 and 3: file 1 into 2');
  assert.deepStrictEqual(M.chartHit(240 - 8, 100, g), { kind: 'hand', i: 1 });
  assert.strictEqual(M.chartHit(240 - 9, 100, g).kind, 'col', 'past HAND_PX it is the column');
  assert.strictEqual(M.chartHit(240, 300, g).kind, 'col', 'below the plot (lanes, names): the column');
  assert.strictEqual(M.chartHit(40, 100, g).kind, 'col', 'the left edge is no hand-over');
  assert.strictEqual(M.chartHit(20, 100, g), null, 'left of the plot');
  assert.strictEqual(M.chartHit(545, 100, g), null, 'right of the plot');
  assert.strictEqual(M.chartHit(240, 100, { ...g, dense: true }).kind, 'col', 'thousands of files: no hand-overs to point at');
});

test('the pointer across a column is the time under it, and the nearest of the seek bars\' five frames', () => {
  const d = 240;
  for (let k = 0; k <= 100; k++) {
    const frac = k / 100;
    const f = M.frameAt(frac, d);
    assert.strictEqual(f.t, frac * d);
    assert.strictEqual(f.idx, DockGeom.scrubFrameIndex(f.t, d), `at ${frac}`);
  }
  // Frames sit at 1/6 .. 5/6 of the file.
  assert.strictEqual(M.frameAt(1 / 6, 600).idx, 0);
  assert.strictEqual(M.frameAt(0.5, 600).idx, 2);
  assert.strictEqual(M.frameAt(5 / 6, 600).idx, 4);
  assert.strictEqual(M.frameAt(1, 600).idx, 4);
  // No length known: the same frame by place, time 0.
  assert.deepStrictEqual(M.frameAt(0.5, 0), { t: 0, idx: 2 });
  // The line and the time agree: a point at frac along the drawn column is frac of the file.
  const g = { L: 40, R: 8, W: 1000, TOP: 16, PH: 200, n: 5, step: 140, gap: 8, dense: false };
  const x0 = g.L + 2 * g.step + g.gap, x1 = g.L + 3 * g.step - g.gap;
  const hit = M.chartHit(x0 + (x1 - x0) * 0.25, 100, g);
  assert.strictEqual(hit.i, 2);
  assert.strictEqual(M.frameAt(hit.frac, 200).t, 50);
});

test('follow: a column out of view is centred; one in view is left alone', () => {
  assert.strictEqual(M.followScroll(300, 440, 0, 1000), null);
  assert.strictEqual(M.followScroll(1500, 1640, 0, 1000), 1070);
  assert.strictEqual(M.followScroll(100, 240, 500, 1000), 0, 'never before the start');
  assert.strictEqual(M.followScroll(970, 1010, 0, 1000), 490, 'too near the edge counts as out of view');
});

test('edge scroll: DragAutoScroll speed near the left or right edge, a step a frame, kept inside the chart', () => {
  const left = 100, right = 1100;
  const sp = (x) => DragAutoScroll.speed(x, left, right, { band: 60 });
  assert.strictEqual(sp(600), 0, 'the middle does not scroll');
  assert.ok(sp(1095) > 0 && sp(105) < 0);
  assert.ok(sp(1099) > sp(1060), 'faster nearer the edge');
  assert.strictEqual(M.scrollStep(200, 1000, 16, 900), 216);
  assert.strictEqual(M.scrollStep(200, -1000, 16, 900), 184);
  assert.strictEqual(M.scrollStep(895, 1000, 16, 900), 900, 'stops at the end');
  assert.strictEqual(M.scrollStep(5, -1000, 16, 900), 0, 'stops at the start');
  assert.strictEqual(M.scrollStep(200, 1000, 500, 900), 250, 'a long frame (a hidden tab) moves at most 50 ms worth');
});

/* ── flow.js in a fake page ───────────────────────────────────────────── */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'flow.js'), 'utf8');

function fakeEl(over = {}) {
  const el = {
    style: { setProperty() {}, removeProperty() {} }, dataset: {}, hidden: false, innerHTML: '', textContent: '',
    clientWidth: 800, clientHeight: 500, offsetWidth: 200, offsetHeight: 20, isConnected: true, scrollLeft: 0, scrollWidth: 800,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, append() {}, remove() {}, replaceWith() {}, insertAdjacentHTML() {}, insertAdjacentElement() {}, focus() {},
    setPointerCapture() {}, releasePointerCapture() {},
    querySelector: () => fakeEl(), querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 300, width: 800, height: 300 }),
    matches: () => false,
    ...over,
  };
  return el;
}

function page({ wrapW = 800, wrapH = 500, stage = false, extra = {} } = {}) {
  const ids = [11, 12, 13, 14, 15];
  const feats = ids.map((id, i) => ({ id, name: `file${id}.mp4`, measured: true, music: true, es: 0.2 + 0.1 * i, em: 0.25 + 0.1 * i, ee: 0.3 + 0.1 * i, bs: 120, bm: 120, be: 120 }));
  const answer = () => ({ shape: 'smooth', edges: 'off', order: ids.slice().reverse(), playlistOrder: ids.slice(), features: feats, targets: null,
    handovers: [], jumps: 0, playlistJumps: 0, counts: { measured: 5, failed: 0, music: 5 }, places: {}, placesOn: false });
  const moves = [], played = [], renders = [];
  const svgBox = { left: 0 };
  const svg = fakeEl({ getBoundingClientRect: () => ({ left: svgBox.left, top: 0, right: svgBox.left + 800, bottom: 300, width: 800, height: 300 }) });
  const parts = new Map();          // the wrap's own children, kept (what was drawn can be read)
  const wrap = fakeEl({ clientWidth: wrapW, clientHeight: wrapH, querySelector: (q) => (q === 'svg' ? svg : (parts.get(q) || parts.set(q, fakeEl()).get(q))) });
  const strip = fakeEl();
  const panelEl = fakeEl();
  const classes = new Set();
  const body = fakeEl({ classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle() {}, contains: (c) => classes.has(c) } });
  const keyListeners = [];         // window keydown listeners in the order added: { fn, capture }
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  const ctx = {
    console, FlowOrder, FlowChartMath: M, DragAutoScroll,
    activeCollectionId: 3,
    collectionMembers: new Map([[3, ids.slice()]]),
    document: {
      readyState: 'complete', body, activeElement: null,
      getElementById: (id) => (id === 'flowPanel' ? panelEl : id === 'flowChartWrap' ? wrap : id === 'flowStrip' ? strip : null),
      querySelector: (q) => (q === '#flowChartWrap svg' ? svg : null),
      querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeEl(),
      documentElement: { clientWidth: 1280 },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    applyFilters: async () => {},
    renderResults: () => renders.push(1),
    Library: { indexOf: () => -1 },
    reorderReady: () => true,
    reorderMove: async (moveIds, before) => { moves.push({ ids: moveIds, before }); return true; },
    playMediaById: (id) => played.push(id),
    StageControl: { isOpen: () => stage, basicOn: () => false },
    isTypingTarget: (el) => !!(el && el.tagName === 'INPUT'),
    ...extra,
    fetch: async (url) => {
      if (/\/api\/flow\/collections\/\d+\?/.test(url)) return ok(answer());
      return ok({ collection: { total: 5, measurable: 5, measured: 5, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } });
    },
  };
  ctx.window = {
    addEventListener: (type, fn, opt) => { if (type === 'keydown') keyListeners.push({ fn, capture: opt === true || !!(opt && opt.capture) }); },
    dispatchEvent() {}, innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollTo() {},
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const Flow = ctx.window.Flow;
  const F = Flow._full;
  const key = (k, over = {}) => {
    const e = { key: k, target: body, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...over };
    // As the browser runs them on window: capture listeners in the order added, then the rest.
    const order = [...keyListeners.filter(l => l.capture), ...keyListeners.filter(l => !l.capture)];
    for (const l of (over.reverse ? order.reverse() : order)) l.fn(e);
    return e;
  };
  const geom = () => Flow._state().geom;
  const colX = (i) => svgBox.left + geom().L + (i + 0.5) * geom().step;
  const gapX = (s) => svgBox.left + geom().L + s * geom().step;
  const target = { closest: (q) => (q === '#flowChartWrap' ? wrap : null) };
  const D = Flow._drag;
  const press = (x) => D.down({ button: 0, target, clientX: x, clientY: 100, pointerId: 1 });
  const moveTo = (x) => D.move({ pointerId: 1, buttons: 1, clientX: x, clientY: 100, preventDefault() {} });
  return { ctx, Flow, F, D, key, classes, strip, wrap, parts, svgBox, moves, played, renders, geom, colX, gapX, press, moveTo, target };
}

test('in and out: the button, F, Esc; never while typing, or when Esc was taken first', async () => {
  const p = page();
  await p.Flow.toggle(3);
  assert.strictEqual(p.Flow.isFull(), false);
  assert.strictEqual(p.F.toggle(), true, 'the ⛶ button');
  assert.strictEqual(p.Flow.isFull(), true);
  assert.ok(p.classes.has('flow-fs-on'));
  p.F.toggle();                          // Exit full screen
  assert.strictEqual(p.Flow.isFull(), false);
  assert.ok(!p.classes.has('flow-fs-on'));

  assert.ok(p.key('f').defaultPrevented, 'F opens it');
  assert.strictEqual(p.Flow.isFull(), true);
  p.key('F');
  assert.strictEqual(p.Flow.isFull(), false, 'F again closes it');
  p.key('f');
  p.key('Escape');
  assert.strictEqual(p.Flow.isFull(), false, 'Esc closes it');
  assert.strictEqual(p.key('Escape').defaultPrevented, false, 'Esc while not full screen is left to the page');

  p.key('f', { target: { tagName: 'INPUT' } });
  assert.strictEqual(p.Flow.isFull(), false, 'typing an f in a box');
  p.key('f', { ctrlKey: true });
  assert.strictEqual(p.Flow.isFull(), false, 'Ctrl+F is the browser\'s');
  p.key('f');
  p.key('Escape', { defaultPrevented: true });
  assert.strictEqual(p.Flow.isFull(), true, 'an Esc another listener took (a drag, Up next\'s list) does not close it');
  p.key('Escape');
  assert.strictEqual(p.Flow.isFull(), false);
});

test('F does nothing while the panel is closed; hiding the panel leaves full screen', async () => {
  const p = page();
  p.key('f');
  assert.strictEqual(p.Flow.isFull(), false);
  await p.Flow.toggle(3);
  p.key('f');
  assert.strictEqual(p.Flow.isFull(), true);
  p.Flow.close();
  assert.strictEqual(p.Flow.isFull(), false);
  assert.ok(!p.classes.has('flow-fs-on'));
});

test('the order, edits and picks are the same in full screen and back', async () => {
  const p = page();
  await p.Flow.toggle(3);
  await p.Flow.pickShape('waves');
  await p.Flow.moveInOrder([11], 15);
  const before = { ...p.Flow._state() };
  p.F.toggle();
  assert.deepStrictEqual([...p.geom().order], [...before.edited], 'full screen draws the edited Flow order');
  p.F.pick(2);
  p.F.zoom(true);
  p.F.toggle();
  const after = p.Flow._state();
  assert.strictEqual(after.order, true);
  assert.strictEqual(after.shape, 'waves');
  assert.deepStrictEqual([...after.edited], [...before.edited]);
  assert.deepStrictEqual([...p.geom().order], [...before.edited]);
  p.F.toggle();
  assert.strictEqual(p.F.state().zoom, true, 'Zoom is kept for next time');
  assert.strictEqual(p.F.state().sel, before.edited[2], 'and the file picked');
});

test('a poll while full screen covers the grid does not draw the grid; leaving draws it once', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.F.toggle();
  const n = p.renders.length;
  await p.Flow.refetch(true);
  await p.Flow.refetch(true);
  assert.strictEqual(p.renders.length, n, 'no grid redraw');
  assert.strictEqual(p.F.state().gridStale, true);
  p.F.toggle();
  assert.strictEqual(p.renders.length, n + 1, 'once on the way out');
  await p.Flow.refetch(true);
  assert.strictEqual(p.renders.length, n + 2, 'the small panel draws it as before');
});

test('Fit and Zoom geometry in the page: Zoom widens the chart past the view', async () => {
  const p = page({ wrapW: 500 });
  await p.Flow.toggle(3);
  p.F.toggle();
  assert.strictEqual(p.geom().W, 500);
  assert.ok(Math.abs(p.geom().step * 5 + p.geom().L + p.geom().R - 500) < 1e-9);
  p.F.zoom(true);
  assert.strictEqual(p.geom().step, M.FS_COL_PX);
  assert.strictEqual(p.geom().W, p.geom().L + p.geom().R + 5 * M.FS_COL_PX);
  assert.ok(p.geom().PH >= 80);
});

test('picking a column fills the strip; a hand-over explains itself; Play says Stage when Stage is open', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.F.toggle();
  p.F.pick(2);
  let html = p.F.strip();
  assert.match(html, /Selected · 3 of 5/);
  assert.match(html, /file13/);
  assert.match(html, /<b>In:<\/b>/);
  assert.match(html, /<b>Out:<\/b>/);
  assert.match(html, /energy \d+ to \d+, 120 BPM to 120 BPM/, 'the why: both ends');
  assert.match(html, />Play</);
  assert.match(html, /data-flow-act="preview"/);
  assert.match(html, /Play next|data-flow-act="remove"/);
  assert.doesNotMatch(html, /—/, 'no em dashes');
  p.F.pickHand(0);
  html = p.F.strip();
  assert.match(html, /Hand-over · 1 into 2 of 5/);
  assert.match(html, /file11.*into.*file12/s);

  const q = page({ stage: true });
  await q.Flow.toggle(3);
  q.F.toggle();
  q.F.pick(0);
  assert.match(q.F.strip(), />Play on Stage</);
  assert.match(q.F.strip(), /First in the order/);
});

test('a click picks a column, two quick clicks on it play it, a click near a boundary picks the hand-over', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.F.toggle();
  const g = p.geom();
  p.F.click({ clientX: p.colX(1), clientY: 100, target: {} });
  assert.strictEqual(p.F.state().sel, g.order[1]);
  p.F.click({ clientX: p.colX(1), clientY: 100, target: {} });
  assert.deepStrictEqual(p.played, [g.order[1]], 'a double click plays it, as a tile\'s does');
  p.F.click({ clientX: p.gapX(3) + 2, clientY: 100, target: {} });
  assert.strictEqual(p.F.state().selHand, 2);
  assert.deepStrictEqual(p.played, [g.order[1]]);
});

test('Zoom: a column drag lands where it would in the small chart, also after the chart scrolled sideways', async () => {
  const p = page({ wrapW: 400 });
  await p.Flow.toggle(3);
  p.F.toggle();
  p.F.zoom(true);
  assert.strictEqual(p.geom().step, M.FS_COL_PX);
  p.press(p.colX(1));                    // file 12
  p.moveTo(p.colX(1) + 2);
  assert.strictEqual(p.D.state().on, false, 'the same threshold');
  p.moveTo(p.gapX(4) + 3);
  assert.strictEqual(p.D.state().on, true);
  await p.D.drop();
  // Scrolled 300 px: the chart's left edge is 300 px off the view, the pointer maths follow.
  p.svgBox.left = -300;
  p.press(p.colX(4));                    // file 15
  p.moveTo(p.gapX(2) + 1);
  await p.D.drop();
  assert.deepStrictEqual(p.moves.map(m => [[...m.ids], m.before]), [[[12], 15], [[15], 13]]);
});

test('Esc during a column drag cancels the drag only, whichever listener hears it first', async () => {
  for (const reverse of [false, true]) {
    const p = page({ wrapW: 400 });
    await p.Flow.toggle(3);
    p.F.toggle();
    p.press(p.colX(1));
    p.moveTo(p.gapX(4) + 3);
    assert.strictEqual(p.D.state().on, true);
    const e = p.key('Escape', { reverse });
    assert.ok(e.defaultPrevented);
    assert.strictEqual(p.D.state(), null, 'the drag is cancelled');
    assert.strictEqual(p.Flow.isFull(), true, `still full screen (${reverse ? 'full screen listener first' : 'drag listener first'})`);
    assert.strictEqual(await p.D.drop(), false);
    assert.deepStrictEqual(p.moves, []);
    p.key('Escape');
    assert.strictEqual(p.Flow.isFull(), false, 'the next Esc leaves full screen');
  }
});

test("F and Esc are left to More filters, a filter popover, Up next's list or a menu over the view", async () => {
  let sheet = true;
  const p = page({ extra: { filtersAreOpen: () => sheet } });
  await p.Flow.toggle(3);
  p.key('f');
  assert.strictEqual(p.Flow.isFull(), false, 'F types nothing and opens nothing under the sheet');
  sheet = false;
  p.key('f');
  assert.strictEqual(p.Flow.isFull(), true);
  sheet = true;
  assert.strictEqual(p.key('Escape').defaultPrevented, false, 'the sheet takes Esc');
  assert.strictEqual(p.Flow.isFull(), true);
  sheet = false;
  const q = page({ extra: { filterPopoverIsOpen: () => true } });
  await q.Flow.toggle(3);
  q.key('f');
  assert.strictEqual(q.Flow.isFull(), false);
});

test("Hide file names: no names in the chart's tooltips or the Remove toast", async () => {
  const toasts = [];
  const ext = {
    openPlainCollection: () => ({ id: 3, name: 'Set', kind: 'collection' }),
    changeCollectionMembership: async () => true,
    undoRemoveFromCollection: async () => {},
    showUndoToast: (msg) => toasts.push(msg),
  };
  const p = page({ extra: ext });
  await p.Flow.toggle(3);
  p.F.toggle();
  const svgHtml = () => p.parts.get('.flow-chart-svg').innerHTML;
  assert.match(svgHtml(), /<title>[^<]*file1[1-5]/, 'names in the tooltips normally');
  p.classes.add('pm-names');
  p.F.pick(1);                           // draws again
  assert.doesNotMatch(svgHtml(), /file1[1-5]/, 'no file names in any tooltip');
  await p.F.act('remove');
  assert.deepStrictEqual(toasts, ['Removed this file from Set']);
  p.classes.delete('pm-names');
  p.F.pick(2);
  await p.F.act('remove');
  assert.match(toasts[1], /Removed “file1[0-9]” from Set/);
});

test('a short view drops the thumbnail row before the plot gets short', async () => {
  const tall = page({ wrapW: 400, wrapH: 500 });
  await tall.Flow.toggle(3);
  tall.F.toggle();
  tall.F.zoom(true);
  assert.strictEqual(tall.parts.get('.flow-thumbs').hidden, false, 'room: the thumbnails show');
  const short = page({ wrapW: 400, wrapH: 260 });
  await short.Flow.toggle(3);
  short.F.toggle();
  short.F.zoom(true);
  assert.strictEqual(short.parts.get('.flow-thumbs').hidden, true, 'short: no thumbnail row');
  assert.ok(short.geom().PH >= M.FS_PLOT_MIN, `plot ${short.geom().PH} px`);
  assert.strictEqual(M.fsThumbsFit(M.FS_PLOT_MIN), true);
  assert.strictEqual(M.fsThumbsFit(M.FS_PLOT_MIN - 1), false);
});

test('Play keeps full screen: videos go to the mini player; Stage open plays on Stage', async () => {
  const calls = [];
  const row = (id) => ({ id, filepath: `/v/${id}.mp4`, filename: `${id}.mp4`, media_type: 'video' });
  const mk = (stage, mini) => page({ stage, extra: {
    getMediaById: row,
    playMedia: (m, o) => calls.push(['playMedia', m.id, o && o.stayMini]),
    minimizePlayer: () => calls.push(['minimize']),
    currentMediaState: { miniMode: mini },
  } });
  let p = mk(false, false);
  p.F.play(12);
  assert.deepStrictEqual([...p.played], [12]);
  assert.deepStrictEqual(calls.splice(0), [['minimize']], 'opened, then to the mini player');
  p = mk(false, true);
  p.F.play(13);
  assert.deepStrictEqual([...p.played], []);
  assert.deepStrictEqual(calls.splice(0), [['playMedia', 13, true]], 'the mini player plays it in place');
  p = mk(true, false);
  p.F.play(14);
  assert.deepStrictEqual([...p.played], [14], "Stage: as a tile's double click");
  assert.deepStrictEqual(calls, []);
});
