/**
 * The Flow panel's chart view (player-lib/flow.js "Under the chart"):
 *  - the pure parts (player-lib/flow-chart-math.js): Fit and Zoom geometry,
 *    when tag rows and preview cards show and how tall the cards row is,
 *    what is under the pointer (a column and where in it, or a hand-over),
 *    the pointer's place as a time and a hover frame (as the seek bars pick
 *    them), keeping the playing column in view, and the sideways scroll
 *    while a drag sits near an edge;
 *  - flow.js in a vm with a permissive fake page: Fit / Zoom (remembered),
 *    the plot keeping the grip's height, tag rows, preview cards, picking a
 *    file or a hand-over for the strip under the names, Show in list, a
 *    column drag in Zoom (also after the chart scrolled sideways), following
 *    what plays, and nothing listening to the page's scroll or wheel.
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

test('Fit puts the whole list in the width; Zoom gives each file ZOOM_COL_PX and widens the chart', () => {
  const fit = M.colLayout(1200, 40, 40, 8, false);
  assert.strictEqual(fit.W, 1200);
  assert.strictEqual(fit.step, (1200 - 48) / 40);
  const zoom = M.colLayout(1200, 40, 40, 8, true);
  assert.strictEqual(zoom.step, M.ZOOM_COL_PX);
  assert.strictEqual(M.ZOOM_COL_PX, 140);
  assert.strictEqual(zoom.W, 48 + 40 * M.ZOOM_COL_PX, 'scrolled sideways');
  // A short list is already wider than ZOOM_COL_PX a file: Zoom changes nothing.
  assert.deepStrictEqual(M.colLayout(1200, 4, 40, 8, true), M.colLayout(1200, 4, 40, 8, false));
  assert.strictEqual(M.colLayout(50, 3, 40, 8, false).W, 200, 'never narrower than 200');
});

test('under CARD_PX a column: colour bars and no cards; wider: tag rows and a card row of at most CARD_ROW_MAX', () => {
  assert.strictEqual(M.CARD_PX, 70);
  assert.deepStrictEqual(M.cardRows(69.9), { rich: false, cardsOn: false, cardH: 0 });
  const at70 = M.cardRows(70);
  assert.deepStrictEqual({ rich: at70.rich, cardsOn: at70.cardsOn }, { rich: true, cardsOn: true });
  assert.strictEqual(at70.cardH, Math.round(62 * 9 / 16) + 8, '16:9 in a 70 px column');
  assert.strictEqual(M.cardRows(140).cardH, 82, 'Zoom: 16:9 in a 140 px column');
  assert.strictEqual(M.cardRows(600).cardH, M.CARD_ROW_MAX, 'a wide Fit column: the row stops growing');
  assert.ok(M.CARD_ROW_MAX >= 80 && M.CARD_ROW_MAX <= 90, 'a modest row: the panel sits over the library');
  assert.deepStrictEqual(M.cardRows(140, false), { rich: true, cardsOn: false, cardH: 0 }, 'thumbnails off: tags, no cards');
  assert.strictEqual(M.cardWidth(600, M.CARD_ROW_MAX), Math.round((M.CARD_ROW_MAX - 8) * 16 / 9), 'a capped card keeps 16:9');
  assert.strictEqual(M.cardWidth(140), 132);
  assert.strictEqual(M.cardWidth(10), 24, 'never thinner than 24');
});

test('a card: the pointer x across it picks the nearest of the five frames; at rest the first', () => {
  assert.deepStrictEqual(M.cardScrub(0, 160, 300), { frac: 0, t: 0, idx: 0 }, 'the left edge: the first frame');
  assert.strictEqual(M.cardScrub(80, 160, 300).idx, 2);
  assert.strictEqual(M.cardScrub(80, 160, 300).t, 150);
  assert.strictEqual(M.cardScrub(160, 160, 300).idx, 4);
  assert.strictEqual(M.cardScrub(500, 160, 300).frac, 1, 'past the right edge: the end');
  assert.strictEqual(M.cardScrub(-20, 160, 300).frac, 0);
  assert.deepStrictEqual(M.cardScrub(40, 0, 300), { frac: 0, t: 0, idx: 0 }, 'no width: the first frame');
  for (let x = 0; x <= 160; x += 4) {
    const s = M.cardScrub(x, 160, 240);
    assert.strictEqual(s.idx, DockGeom.scrubFrameIndex(s.t, 240), 'as the seek bars pick them');
  }
});

test('a tag\'s text colour: dark on light colours, light on dark ones', () => {
  assert.strictEqual(M.inkOn('#f5a524'), '#111');
  assert.strictEqual(M.inkOn('#fff'), '#111');
  assert.strictEqual(M.inkOn('#1e3a8a'), '#fff');
  assert.strictEqual(M.inkOn('#000'), '#fff');
  assert.strictEqual(M.inkOn('red'), '#fff', 'not a hex colour: light');
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
    matches: () => false, getClientRects: () => [1], contains: () => false,
    ...over,
  };
  return el;
}

function page({ wrapW = 800, stage = false, extra = {}, win = {}, n = 5, store = {}, grid = null } = {}) {
  const ids = Array.from({ length: n }, (_, i) => 11 + i);
  const feats = ids.map((id, i) => ({ id, name: `file${id}.mp4`, measured: true, music: true, es: 0.2 + 0.1 * i, em: 0.25 + 0.1 * i, ee: 0.3 + 0.1 * i, bs: 120, bm: 120, be: 120 }));
  const answer = () => ({ shape: 'smooth', edges: 'off', order: ids.slice().reverse(), playlistOrder: ids.slice(), features: feats.map(f => ({ ...f })), targets: null,
    handovers: [], jumps: 0, playlistJumps: 0, counts: { measured: n, failed: 0, music: n }, places: {}, placesOn: false });
  const moves = [], played = [], renders = [], revealed = [];
  const svgBox = { left: 0 };
  const svg = fakeEl({ getBoundingClientRect: () => ({ left: svgBox.left, top: 0, right: svgBox.left + 800, bottom: 300, width: 800, height: 300 }) });
  const parts = new Map();          // the wrap's own children, kept (what was drawn can be read)
  const wrapListeners = {};        // the wrap's own listeners (scroll, and the user's wheel, press or key)
  const wrapOpts = {};
  const wrapClasses = new Set();
  const wrap = fakeEl({ clientWidth: wrapW, querySelector: (q) => (q === 'svg' ? svg : (parts.get(q) || parts.set(q, fakeEl()).get(q))),
    addEventListener: (t, fn, o) => { (wrapListeners[t] = wrapListeners[t] || []).push(fn); wrapOpts[t] = o; },
    classList: { add: (c) => wrapClasses.add(c), remove: (c) => wrapClasses.delete(c), toggle: (c, on) => (on ? wrapClasses.add(c) : wrapClasses.delete(c)), contains: (c) => wrapClasses.has(c) } });
  const strip = fakeEl({ id: 'flowStrip' });
  const panelEl = fakeEl();
  const classes = new Set();
  const body = fakeEl({ classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle() {}, contains: (c) => classes.has(c) } });
  const winListeners = [];         // window listeners: { type, fn }
  const docListeners = [];         // document listeners: { type, fn }
  const ok = (b) => ({ ok: true, status: 200, json: async () => b });
  const ctx = {
    console, FlowOrder, FlowChartMath: M, DragAutoScroll,
    activeCollectionId: 3,
    collectionMembers: new Map([[3, ids.slice()]]),
    document: {
      readyState: 'complete', body, activeElement: null, hidden: false,
      getElementById: (id) => (id === 'flowPanel' ? panelEl : id === 'flowChartWrap' ? wrap : id === 'flowStrip' ? strip : id === 'resultsGrid' ? grid : null),
      querySelector: (q) => (q === '#flowChartWrap svg' ? svg : null),
      querySelectorAll: () => [], addEventListener: (type, fn) => docListeners.push({ type, fn }), createElement: () => fakeEl(),
      documentElement: { clientWidth: 1280 },
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    performance: { now: () => Date.now() },
    applyFilters: async () => {},
    renderResults: () => renders.push(1),
    Library: { indexOf: (id) => ids.indexOf(id) },
    revealMediaIndex: (i) => revealed.push(i),
    reorderReady: () => true,
    reorderMove: async (moveIds, before) => { moves.push({ ids: moveIds, before }); return true; },
    playMediaById: (id) => played.push(id),
    StageControl: { isOpen: () => stage, basicOn: () => false },
    ...extra,
    fetch: async (url) => {
      if (/\/api\/flow\/collections\/\d+\?/.test(url)) return ok(answer());
      return ok({ collection: { total: n, measurable: n, measured: n, failed: 0, left: 0, stale: 0 }, queue: { state: 'idle' } });
    },
  };
  ctx.window = {
    addEventListener: (type, fn, opt) => winListeners.push({ type, fn, opt }),
    removeEventListener: (type, fn) => { const i = winListeners.findIndex(l => l.type === type && l.fn === fn); if (i >= 0) winListeners.splice(i, 1); },
    dispatchEvent() {}, innerWidth: 1280, innerHeight: 720, scrollY: 0, scrollTo() {}, ...win,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const Flow = ctx.window.Flow;
  const V = Flow._view;
  const key = (k, over = {}) => {
    const e = { key: k, target: body, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...over };
    for (const l of winListeners.filter(x => x.type === 'keydown')) l.fn(e);
    return e;
  };
  const fire = (type) => { for (const l of docListeners.filter(x => x.type === type)) l.fn({ type }); };
  const geom = () => Flow._state().geom;
  const colX = (i) => svgBox.left + geom().L + (i + 0.5) * geom().step;
  const gapX = (s) => svgBox.left + geom().L + s * geom().step;
  const target = { closest: (q) => (q === '#flowChartWrap' ? wrap : null) };
  const D = Flow._drag;
  const press = (x) => D.down({ button: 0, target, clientX: x, clientY: 100, pointerId: 1 });
  const moveTo = (x) => D.move({ pointerId: 1, buttons: 1, clientX: x, clientY: 100, preventDefault() {} });
  return { ctx, Flow, V, D, key, fire, wrapOpts, classes, strip, panelEl, wrap, wrapClasses, wrapListeners, winListeners, docListeners, parts, svgBox, moves, played, renders, revealed, store, geom, colX, gapX, press, moveTo, target };
}

test('Fit and Zoom in the panel: Zoom widens the chart past the view and scrolls it; the choice is remembered', async () => {
  const store = {};
  const p = page({ wrapW: 500, store });
  await p.Flow.toggle(3);
  assert.strictEqual(p.V.state().zoom, false, 'Fit by default');
  assert.strictEqual(p.geom().W, 500);
  assert.ok(Math.abs(p.geom().step * 5 + p.geom().L + p.geom().R - 500) < 1e-9);
  assert.strictEqual(p.wrapClasses.has('flow-zoomed'), false);
  p.V.zoom(true);
  assert.strictEqual(p.geom().step, M.ZOOM_COL_PX);
  assert.strictEqual(p.geom().W, p.geom().L + p.geom().R + 5 * M.ZOOM_COL_PX);
  assert.strictEqual(p.wrapClasses.has('flow-zoomed'), true, 'the wrap scrolls sideways');
  assert.strictEqual(store['vault.flow.zoom'], '1');
  // A new page (a reload) starts in Zoom.
  const q = page({ wrapW: 500, store });
  await q.Flow.toggle(3);
  assert.strictEqual(q.V.state().zoom, true);
  assert.strictEqual(q.geom().step, M.ZOOM_COL_PX);
  q.V.zoom(false);
  assert.strictEqual(store['vault.flow.zoom'], '0');
});

test('the plot keeps the panel\'s own height (the grip\'s, or by width), whatever the window or Zoom', async () => {
  const p = page({ wrapW: 1200 });
  await p.Flow.toggle(3);
  assert.strictEqual(p.geom().PH, 150, 'the default for a wide panel');
  p.V.zoom(true);
  assert.strictEqual(p.geom().PH, 150, 'Zoom changes the width only');
  const q = page({ wrapW: 1200, store: { 'vault.flow.chartHeight': '220' } });
  await q.Flow.toggle(3);
  assert.strictEqual(q.geom().PH, 220, 'the height the grip left');
});

test('the panel\'s first row: Fit / Zoom and Hide; no full screen button or key', async () => {
  const p = page();
  await p.Flow.toggle(3);
  const html = p.panelEl.innerHTML;
  assert.match(html, /data-flow-zoom="0"[^>]*>Fit</);
  assert.match(html, /data-flow-zoom="1"[^>]*>Zoom</);
  assert.match(html, /data-flow-hide/);
  assert.doesNotMatch(html, /data-flow-full|⛶|Full screen/);
  assert.match(html, /id="flowStrip"/, 'the strip under the names');
  assert.doesNotMatch(html, /—/, 'no em dashes');
  assert.strictEqual(p.key('f').defaultPrevented, false, 'F is left to the page');
  assert.strictEqual(p.Flow.isFull, undefined);
  assert.strictEqual(p.Flow.toggleFull, undefined);
});

test('lanes have one set of picks (the panel\'s): the old full screen key is never read or written', async () => {
  const store = { 'vault.flow.fsLanes': JSON.stringify({ tempo: true }) };
  const p = page({ wrapW: 900, store, win: roleLane });
  await p.Flow.toggle(3);
  assert.doesNotMatch(p.parts.get('.flow-ltags').innerHTML, />Tempo</, 'Tempo is off by default, whatever the old key says');
  assert.match(p.parts.get('.flow-ltags').innerHTML, />Role</);
  assert.strictEqual(store['vault.flow.fsLanes'], JSON.stringify({ tempo: true }), 'left as it was');
});

test('nothing listens to the page\'s scroll or wheel while nothing is hovered', async () => {
  const p = page({ wrapW: 400 });
  await p.Flow.toggle(3);
  p.V.zoom(true);
  p.V.pick(1);
  const types = p.winListeners.map(l => l.type).concat(p.docListeners.map(l => l.type));
  assert.ok(!types.includes('scroll') && !types.includes('wheel'), `window and document: ${types.join(', ')}`);
  assert.deepStrictEqual(Object.keys(p.wrapListeners).sort(), ['keydown', 'pointerdown', 'scroll', 'wheel'], 'the chart: its own scroll, and the user\'s hand on it');
  assert.strictEqual(p.wrapOpts.scroll.passive, true, 'the scroll is only heard');
  assert.strictEqual(p.wrapOpts.wheel.passive, false, 'the wheel may move the chart sideways');
});

test('an up/down wheel over a chart wider than its view scrolls it sideways, and stays with it at either end', async () => {
  const p = page({ wrapW: 400 });
  await p.Flow.toggle(3);
  p.V.zoom(true);
  p.wrap.scrollWidth = 1400; p.wrap.clientWidth = 400; p.wrap.scrollLeft = 100;
  const wheel = (o) => {
    const e = { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, taken: false, preventDefault() { this.taken = true; }, ...o };
    for (const fn of p.wrapListeners.wheel) fn(e);
    return e;
  };
  let e = wheel({ deltaY: 120 });
  assert.ok(e.taken);
  assert.strictEqual(p.wrap.scrollLeft, 220, 'down moves right');
  e = wheel({ deltaY: -3, deltaMode: 1 });
  assert.ok(e.taken);
  assert.strictEqual(p.wrap.scrollLeft, 100, 'lines count as 40px');
  assert.ok(!wheel({ deltaY: 100, shiftKey: true }).taken, 'Shift is the browser\'s own sideways scroll');
  assert.ok(!wheel({ deltaY: 100, ctrlKey: true }).taken, 'Ctrl is zoom');
  assert.ok(!wheel({ deltaX: 50, deltaY: 10 }).taken, 'a sideways trackpad swipe is the browser\'s');
  p.wrap.scrollLeft = 0;
  assert.ok(wheel({ deltaY: -100 }).taken, 'at the start, up stays with the chart');
  p.wrap.scrollLeft = 1000;
  assert.ok(wheel({ deltaY: 100 }).taken, 'at the end, down stays with the chart');
  p.wrap.scrollWidth = 400;
  p.wrap.scrollLeft = 0;
  assert.ok(!wheel({ deltaY: 100 }).taken, 'a chart that fits (Fit) leaves the wheel to the page');
});

test('a page scroll while something is hovered clears it all; the listener is there only meanwhile', async () => {
  const p = page({ wrapW: 1000 });
  await p.Flow.toggle(3);
  const scrolls = () => p.winListeners.filter(l => l.type === 'scroll');
  assert.strictEqual(scrolls().length, 0);
  // A lit column and a scrubbed card (the pointer over a column).
  p.V.hot(2);
  p.V.scrub(2, 0.6);
  assert.strictEqual(scrolls().length, 1, 'heard while something shows');
  assert.deepStrictEqual({ capture: scrolls()[0].opt.capture, passive: scrolls()[0].opt.passive }, { capture: true, passive: true }, 'every scroll (element scrolls do not bubble), never taken');
  assert.strictEqual(p.V.cards().find(c => c.i === 2).bar, '60%');
  scrolls()[0].fn({ type: 'scroll' });   // the page scrolls under the still pointer
  assert.strictEqual(p.V.state().hot, -1, 'the column is not lit any more');
  assert.strictEqual(p.V.cards().find(c => c.i === 2).bar, '0', 'the card is back on its first frame');
  assert.strictEqual(scrolls().length, 0, 'and the listener is gone');
  // The chart itself scrolling under a still pointer clears the same.
  p.V.hot(3);
  for (const fn of p.wrapListeners.scroll) fn();
  assert.strictEqual(p.V.state().hot, -1);
  assert.strictEqual(scrolls().length, 0);
  // Leaving the hover by itself takes the listener away too.
  p.V.hot(1);
  assert.strictEqual(scrolls().length, 1);
  p.V.hot(-1);
  assert.strictEqual(scrolls().length, 0);
});

test('a strip button with keyboard focus keeps it across repaints: Show N and close too', async () => {
  const p = page();
  await p.Flow.toggle(3);
  p.V.pickHand(1);
  for (const sel of ['[data-flow-pick="-1"]', '[data-flow-pick="2"]', '[data-flow-act="play"]']) {
    const [attr, val] = sel.slice(1, -1).split('=');
    const btn = fakeEl({ dataset: attr === 'data-flow-pick' ? { flowPick: JSON.parse(val) } : { flowAct: JSON.parse(val) },
      matches: (q) => q === `#flowPanel [${attr}]` });
    p.ctx.document.activeElement = btn;
    const focused = [];
    p.panelEl.querySelector = (q) => fakeEl({ focus: () => focused.push(q) });
    await p.Flow.refetch(true);           // a poll's repaint
    assert.ok(focused.length >= 1 && focused.every(q => q === sel), `${sel} keeps focus: ${focused}`);
  }
});

test('a poll answer that changes nothing on the tiles does not draw the grid; opening and closing do', async () => {
  const p = page();
  await p.Flow.toggle(3);
  const n = p.renders.length;
  assert.strictEqual(n, 1, 'opening draws the tiles with their Flow row, once');
  await p.Flow.refetch(true);
  await p.Flow.refetch(true);
  assert.strictEqual(p.renders.length, n, 'same measurements: no grid redraw');
  p.Flow.close();
  assert.strictEqual(p.renders.length, n + 1, 'closing takes the Flow row off');
  await p.Flow.toggle(3);
  assert.strictEqual(p.renders.length, n + 2, 'opening again draws it once');
});

test('a measurement landing rewrites only the Flow row of the tiles on screen, never the whole grid', async () => {
  let measured = false;
  const tile = (id) => {
    const t = fakeEl({ dataset: { id: String(id) }, rows: [] });
    t.querySelector = (q) => (q === ':scope > .tile-flow' ? t.rows[0] || null : null);
    t.insertAdjacentHTML = (where, html) => { const r = fakeEl({ html }); r.remove = () => { t.rows = t.rows.filter(x => x !== r); }; t.rows.push(r); };
    return t;
  };
  const tiles = [11, 12, 13].map(tile);
  const grid = fakeEl({ querySelectorAll: (q) => (q === '.media-tile[data-id]:not(.tv-row)' ? tiles : []) });
  const p = page({ grid, extra: { Library: { indexOf: (id) => id - 11, idAt: (i) => 11 + i } } });
  const realFetch = p.ctx.fetch;
  p.ctx.fetch = async (url) => {
    const r = await realFetch(url);
    if (!/\/api\/flow\/collections\/\d+\?/.test(url) || !measured) return r;
    const b = await r.json();
    b.features[0].em = 0.9;
    return { ok: true, status: 200, json: async () => b };
  };
  await p.Flow.toggle(3);
  const n = p.renders.length;
  measured = true;
  await p.Flow.refetch(true);
  assert.strictEqual(p.renders.length, n, 'no grid redraw while measuring');
  for (const t of tiles) assert.strictEqual(t.rows.length, 1, 'each tile has one Flow row');
  assert.match(tiles[0].rows[0].html, /flow-ebar/);
  assert.match(tiles[0].rows[0].html, /height:11px/, 'the new measurement (0.9 energy) on the tile');
  // The same answer again: nothing rewritten.
  const before = tiles.map(t => t.rows[0]);
  await p.Flow.refetch(true);
  assert.deepStrictEqual(tiles.map(t => t.rows[0]), before);
});

test('the grid is drawn when the order it shows changes (Flow order), through the filters, once', async () => {
  let flip = false;
  const filters = [];
  const p = page({ extra: { applyFilters: async () => { filters.push(1); } } });
  const realFetch = p.ctx.fetch;
  p.ctx.fetch = async (url) => {
    const r = await realFetch(url);
    if (!/\/api\/flow\/collections\/\d+\?/.test(url) || !flip) return r;
    const b = await r.json();
    b.order = b.order.slice().reverse();
    return { ok: true, status: 200, json: async () => b };
  };
  await p.Flow.toggle(3);
  await p.Flow.useFlowOrder();
  const f = filters.length, n = p.renders.length;
  await p.Flow.refetch(true);
  assert.strictEqual(filters.length, f, 'the same order: nothing drawn');
  flip = true;
  await p.Flow.refetch(true);
  assert.strictEqual(filters.length, f + 1, 'a new order: the grid gets it');
  assert.strictEqual(p.renders.length, n, 'and no second, direct grid redraw');
});

test('picking a column fills the strip; a hand-over explains itself; Play says Stage when Stage is open', async () => {
  const p = page();
  await p.Flow.toggle(3);
  assert.match(p.strip.innerHTML, /Click a file to see it here/, 'a short hint while nothing is picked');
  p.V.pick(2);
  let html = p.V.strip();
  assert.strictEqual(p.strip.innerHTML, html);
  assert.match(html, /Selected · 3 of 5/);
  assert.match(html, /file13/);
  assert.match(html, /<b>In:<\/b>/);
  assert.match(html, /<b>Out:<\/b>/);
  assert.match(html, /energy \d+ to \d+, 120 BPM to 120 BPM/, 'the why: both ends');
  assert.match(html, />Play</);
  assert.match(html, /data-flow-act="preview"/);
  assert.match(html, /data-flow-act="reveal"[^>]*>Show in list</);
  assert.match(html, /data-flow-pick="-1"/, 'a way to close it');
  assert.doesNotMatch(html, /—/, 'no em dashes');
  p.V.pickHand(0);
  html = p.V.strip();
  assert.match(html, /Hand-over · 1 into 2 of 5/);
  assert.match(html, /file11.*into.*file12/s);
  p.V.pick(-1);
  assert.match(p.strip.innerHTML, /Click a file/);

  const q = page({ stage: true });
  await q.Flow.toggle(3);
  q.V.pick(0);
  assert.match(q.V.strip(), />Play on Stage</);
  assert.match(q.V.strip(), /First in the order/);
});

test('a click picks a column (the page does not scroll), two quick clicks play it, a click near a boundary picks the hand-over; Show in list scrolls', async () => {
  const p = page();
  await p.Flow.toggle(3);
  const g = p.geom();
  p.V.click({ clientX: p.colX(1), clientY: 100, target: {} });
  assert.strictEqual(p.V.state().sel, g.order[1]);
  assert.deepStrictEqual(p.revealed, [], 'a click no longer scrolls the list away from the panel');
  p.V.click({ clientX: p.colX(1), clientY: 100, target: {} });
  assert.deepStrictEqual(p.played, [g.order[1]], 'a double click plays it, as a tile\'s does');
  p.V.click({ clientX: p.gapX(3) + 2, clientY: 100, target: {} });
  assert.strictEqual(p.V.state().selHand, 2);
  assert.deepStrictEqual(p.played, [g.order[1]]);
  p.V.pick(3);
  await p.V.act('reveal');
  assert.deepStrictEqual(p.revealed, [g.order[3] - 11], 'Show in list: the old click, on a button');
});

test('Zoom: a column drag lands where it would in Fit, also after the chart scrolled sideways', async () => {
  const p = page({ wrapW: 400 });
  await p.Flow.toggle(3);
  p.V.zoom(true);
  assert.strictEqual(p.geom().step, M.ZOOM_COL_PX);
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

test('Esc during a column drag cancels the drag', async () => {
  const p = page({ wrapW: 400 });
  await p.Flow.toggle(3);
  p.press(p.colX(1));
  p.moveTo(p.gapX(4) + 3);
  assert.strictEqual(p.D.state().on, true);
  const e = p.key('Escape');
  assert.ok(e.defaultPrevented);
  assert.strictEqual(p.D.state(), null, 'the drag is cancelled');
  assert.strictEqual(await p.D.drop(), false);
  assert.deepStrictEqual(p.moves, []);
  assert.strictEqual(p.key('Escape').defaultPrevented, false, 'without a drag Esc is the page\'s');
});

test('Zoom while something plays keeps it in view, until the user scrolls the chart', async () => {
  const el = { currentTime: 10, duration: 100, paused: false, ended: false, isConnected: true, tagName: 'VIDEO' };
  const p = page({ wrapW: 400, n: 12, store: { 'vault.flow.zoom': '1' }, extra: { currentMediaState: { element: el, playbackMediaId: 20 } } });
  await p.Flow.toggle(3);
  const i = p.geom().order.indexOf(20);
  assert.ok(p.geom().L + i * M.ZOOM_COL_PX > 400, 'the playing file starts off to the right');
  p.fire('play');                        // the playhead check
  assert.strictEqual(p.wrap.scrollLeft, M.followScroll(p.geom().L + i * M.ZOOM_COL_PX, p.geom().L + (i + 1) * M.ZOOM_COL_PX, 0, 400));
  assert.ok(p.wrap.scrollLeft > 0);
  // The browser moving the scroll by itself (a view a little wider) is not the user.
  p.wrap.scrollLeft -= 15;
  for (const fn of p.wrapListeners.scroll) fn();
  assert.strictEqual(p.V.state().follow, true, 'not the user');
  // The user scrolls the chart (a wheel over it, then the scroll): following stops.
  for (const fn of p.wrapListeners.wheel) fn({ deltaX: 40, deltaY: 0, deltaMode: 0, preventDefault() {} });
  p.wrap.scrollLeft = 0;
  for (const fn of p.wrapListeners.scroll) fn();
  assert.strictEqual(p.V.state().follow, false);
  p.fire('play');
  assert.strictEqual(p.wrap.scrollLeft, 0);
  // The next file playing: followed again.
  p.ctx.currentMediaState.playbackMediaId = 21;
  p.fire('play');
  assert.strictEqual(p.V.state().follow, true, 'a new file re-arms it');
  assert.ok(p.wrap.scrollLeft > 0);
  // Stopped again by the user, then the panel hidden and shown: followed again.
  for (const fn of p.wrapListeners.pointerdown) fn();
  p.wrap.scrollLeft = 0;
  for (const fn of p.wrapListeners.scroll) fn();
  assert.strictEqual(p.V.state().follow, false);
  p.Flow.close();
  await p.Flow.toggle(3);
  assert.strictEqual(p.V.state().follow, true, 'showing the panel again re-arms it');
  // Fit: nothing to follow.
  const q = page({ wrapW: 400, n: 12, extra: { currentMediaState: { element: el, playbackMediaId: 20 } } });
  await q.Flow.toggle(3);
  q.fire('play');
  assert.strictEqual(q.wrap.scrollLeft, 0);
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
  const svgHtml = () => p.parts.get('.flow-chart-svg').innerHTML;
  assert.match(svgHtml(), /<title>[^<]*file1[1-5]/, 'names in the tooltips normally');
  p.classes.add('pm-names');
  p.V.pick(1);                           // draws again
  assert.doesNotMatch(svgHtml(), /file1[1-5]/, 'no file names in any tooltip');
  await p.V.act('remove');
  assert.deepStrictEqual(toasts, ['Removed this file from Set']);
  p.classes.delete('pm-names');
  p.V.pick(2);
  await p.V.act('remove');
  assert.match(toasts[1], /Removed “file1[0-9]” from Set/);
});

test('Play keeps the panel in view: videos go to the mini player; Stage open plays on Stage', async () => {
  const calls = [];
  const row = (id) => ({ id, filepath: `/v/${id}.mp4`, filename: `${id}.mp4`, media_type: 'video' });
  const mk = (stage, mini) => page({ stage, extra: {
    getMediaById: row,
    playMedia: (m, o) => calls.push(['playMedia', m.id, o && o.stayMini]),
    minimizePlayer: () => calls.push(['minimize']),
    currentMediaState: { miniMode: mini },
  } });
  let p = mk(false, false);
  p.V.play(12);
  assert.deepStrictEqual([...p.played], [12]);
  assert.deepStrictEqual(calls.splice(0), [['minimize']], 'opened, then to the mini player');
  p = mk(false, true);
  p.V.play(13);
  assert.deepStrictEqual([...p.played], []);
  assert.deepStrictEqual(calls.splice(0), [['playMedia', 13, true]], 'the mini player plays it in place');
  p = mk(true, false);
  p.V.play(14);
  assert.deepStrictEqual([...p.played], [14], "Stage: as a tile's double click");
  assert.deepStrictEqual(calls, []);
});

/* ── Tag rows and preview cards ───────────────────────────────────────── */

/** A Role lane (FlowLaneSource, as stream-tags.js gives it): file 11 is a Peak, the rest have none. */
const roleLane = {
  FlowLaneSource: {
    lanes: () => [{ key: 'lane:1', label: 'Role' }],
    cells: (key, mediaIds) => mediaIds.map(id => (id === 11 ? [{ color: '#f5a524', label: 'Peak' }] : [])),
    chips: () => [],
    onChange() {},
  },
};

test('tag rows: names on their colours, Tempo as a number and a meter, a dashed slot when empty', async () => {
  const menus = [];
  const StreamTags = { blockMenu: (el, id) => menus.push([el.dataset.i, id]), loaded: () => true, onChange() {}, tagsOf: () => [] };
  const p = page({ wrapW: 900, win: roleLane, extra: { StreamTags }, store: { 'vault.flow.lanes': JSON.stringify({ tempo: true }) } });
  await p.Flow.toggle(3);
  const order = p.geom().order;
  const html = p.parts.get('.flow-ltags').innerHTML;
  assert.strictEqual(p.parts.get('.flow-ltags').hidden, false);
  assert.match(html, /class="flow-tg-l"[^>]*>Role</, 'the lane\'s label at the left');
  assert.match(html, /class="flow-tg-l"[^>]*>Tempo</);
  assert.match(html, /<span class="flow-tg-t" style="background:#f5a524;color:#111"[^>]*>Peak<\/span>/, 'the tag\'s name on its colour');
  assert.match(html, /class="flow-tg flow-tg-num"[^>]*><span>120<\/span><i><b style="width:50%;/, 'Tempo: the value and a meter');
  const empties = html.match(/flow-tg flow-tg-empty" data-i="\d" data-flow-tag="tag:lane:1"[^>]*>\+ Role</g) || [];
  assert.strictEqual(empties.length, order.length - 1, 'every file without a Role: a slot to add one');
  assert.doesNotMatch(p.parts.get('.flow-chart-svg').innerHTML, /flow-lane-label/, 'no colour bars in the chart as well');
  // A tag lane's cell opens the stream tag menu for its file (empty or not).
  const cell = (i) => ({ dataset: { i: String(i) }, closest: (q) => (q === '[data-flow-tag]' ? cell(i) : null) });
  p.V.click({ target: cell(2), clientX: 0, clientY: 0 });
  assert.deepStrictEqual(menus, [['2', order[2]]]);
  assert.strictEqual(p.V.state().sel, null, 'the menu, not a pick');

  // No stream tags (or not loaded yet): the slot is only shown.
  const q = page({ wrapW: 900, win: roleLane });
  await q.Flow.toggle(3);
  const plain = q.parts.get('.flow-ltags').innerHTML;
  assert.match(plain, /flow-tg flow-tg-empty/);
  assert.doesNotMatch(plain, /data-flow-tag|\+ Role/);
  assert.doesNotMatch(html + plain, /—/, 'no em dashes');
});

test('preview cards: the first frame at rest, a frame from where the pointer is, back to the first on leaving', async () => {
  const kinds = { 11: 'video', 12: 'video', 13: 'image', 14: 'video', 15: 'audio' };
  const Library = { indexOf: () => -1, row: (id) => ({ id, media_type: kinds[id], duration_seconds: 300 }) };
  const p = page({ wrapW: 1000, extra: { Library, formatDuration: (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` } });
  await p.Flow.toggle(3);
  assert.strictEqual(p.parts.get('.flow-cards').hidden, false);
  const byId = () => new Map(p.V.cards().map(c => [c.id, c]));
  let c = byId();
  assert.strictEqual(c.size, 5, 'one card a file');
  assert.strictEqual(c.get(11).src, '/scrub/11/0', 'a video: its first hover frame');
  assert.strictEqual(c.get(13).src, '/thumb/13', 'a picture: its thumbnail');
  assert.strictEqual(c.get(15).src, '/thumb/15', 'audio: its still');
  const i11 = p.geom().order.indexOf(11);
  assert.strictEqual(c.get(11).i, i11, 'in its column');
  // Scrub: the pointer x across the card picks the frame, the bar shows where.
  p.V.scrub(i11, M.cardScrub(80, 160, 300).frac);
  c = byId();
  assert.strictEqual(c.get(11).src, '/scrub/11/2');
  assert.strictEqual(c.get(11).bar, '50%');
  p.V.scrub(i11, M.cardScrub(159, 160, 300).frac);
  assert.strictEqual(byId().get(11).src, '/scrub/11/4');
  p.V.unscrub();
  c = byId();
  assert.strictEqual(c.get(11).src, '/scrub/11/0', 'leaving: the first frame again');
  assert.strictEqual(c.get(11).bar, '0');
  // Another card scrubbed: the first goes back.
  p.V.scrub(i11, 1);
  p.V.scrub(p.geom().order.indexOf(12), 0.5);
  assert.strictEqual(byId().get(11).src, '/scrub/11/0');
  assert.strictEqual(byId().get(12).src, '/scrub/12/2');
});

test('the cards row stays modest in the panel: a wide Fit column gets a capped card', async () => {
  const p = page({ wrapW: 1600 });
  await p.Flow.toggle(3);
  assert.ok(p.geom().step > 300, `step ${p.geom().step}`);
  assert.strictEqual(p.parts.get('.flow-cards').style.height, `${M.CARD_ROW_MAX}px`);
});

test('the cards ask for the rows they need (lengths, kinds) once an order, not on every draw', async () => {
  const asked = [];
  const Library = { indexOf: () => -1, row: () => null, fetchRows: (ids) => { asked.push(ids.slice()); return Promise.resolve(); } };
  const p = page({ wrapW: 1000, extra: { Library } });
  await p.Flow.toggle(3);
  p.V.pick(1);
  p.V.pick(2);
  assert.strictEqual(asked.length, 1);
  assert.deepStrictEqual([...asked[0]].sort(), [11, 12, 13, 14, 15]);
});

test('preview cards ask for pictures only in view (and a column either side), the rest when scrolled to', async () => {
  const p = page({ wrapW: 400, store: { 'vault.flow.zoom': '1' } });
  await p.Flow.toggle(3);                // straight into Zoom
  const loaded = () => [...p.V.cards().filter(c => c.loaded).map(c => c.i)].sort();
  assert.deepStrictEqual(loaded(), [0, 1, 2, 3], 'the fifth card is past the view and its margin');
  assert.strictEqual(p.V.cards().find(c => c.i === 4).src, '');
  p.wrap.scrollLeft = 300;
  p.V.cardsLoad();
  assert.deepStrictEqual(loaded(), [0, 1, 2, 3, 4]);
});

test('narrow columns (Fit, many files): colour bars without text and no cards; Zoom has room', async () => {
  const p = page({ wrapW: 360, win: roleLane });
  await p.Flow.toggle(3);
  assert.ok(p.geom().step < M.CARD_PX, `step ${p.geom().step}`);
  assert.strictEqual(p.parts.get('.flow-ltags').hidden, true, 'no tag text');
  assert.strictEqual(p.parts.get('.flow-cards').hidden, true, 'no cards');
  assert.strictEqual(p.geom().cards, false);
  assert.match(p.parts.get('.flow-chart-svg').innerHTML, /flow-lane-label[^>]*><title>Role/, 'the lanes as colour bars, as before');
  p.V.zoom(true);
  assert.strictEqual(p.geom().step, M.ZOOM_COL_PX);
  assert.strictEqual(p.parts.get('.flow-ltags').hidden, false);
  assert.strictEqual(p.parts.get('.flow-cards').hidden, false);
  assert.match(p.parts.get('.flow-ltags').innerHTML, />Peak</);
});

test('a card is its column: a click picks it, two play it, and dragging it moves the file', async () => {
  const p = page({ wrapW: 400 });
  await p.Flow.toggle(3);
  p.V.zoom(true);
  const order = p.geom().order.slice();
  const card = (i) => ({ dataset: { i: String(i) }, closest: (q) => (q === '#flowChartWrap' ? p.wrap : q.split(', ').includes('.flow-card') ? card(i) : null) });
  p.V.click({ target: card(1), clientX: 0, clientY: 0 });
  assert.strictEqual(p.V.state().sel, order[1], 'a click selects (the strip)');
  p.V.click({ target: card(1), clientX: 0, clientY: 0 });
  assert.deepStrictEqual(p.played, [order[1]], 'a double click plays it');
  // Dragged from the card: the column drag's own threshold and drop.
  p.D.down({ button: 0, target: card(1), clientX: p.colX(1), clientY: 100, pointerId: 1 });
  assert.strictEqual(p.D.state().from, 1);
  p.moveTo(p.colX(1) + 2);
  assert.strictEqual(p.D.state().on, false, 'under the threshold: still a click');
  p.moveTo(p.gapX(4) + 3);
  assert.strictEqual(p.D.state().on, true);
  await p.D.drop();
  assert.deepStrictEqual(p.moves.map(m => [[...m.ids], m.before]), [[[order[1]], order[4]]]);
  // A press whose button came up unheard is not a drag (e.buttons).
  p.D.down({ button: 0, target: card(2), clientX: p.colX(2), clientY: 100, pointerId: 2 });
  p.D.move({ pointerId: 2, buttons: 0, clientX: p.gapX(4), clientY: 100, preventDefault() {} });
  assert.strictEqual(p.D.state(), null);
});

test('Hide file names: tag rows name no file, and the cards are blurred', async () => {
  const p = page({ wrapW: 900, win: roleLane });
  await p.Flow.toggle(3);
  assert.match(p.parts.get('.flow-ltags').innerHTML, /title="\d\. file1\d/, 'names in the tag tooltips normally');
  p.classes.add('pm-names');
  p.V.pick(0);
  const html = p.parts.get('.flow-ltags').innerHTML;
  assert.doesNotMatch(html, /file1\d/);
  assert.match(html, /title="\d\. File \d: /);
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'flow.css'), 'utf8');
  assert.match(css, /body\.pm-names \.flow-card img \{ filter: blur\(\d+px\); \}/, 'the card pictures blur as names do');
  assert.match(css, /body\.pm-names \.flow-nm-t,/);
});

test('picking a file or a hand-over moves nothing above the strip', async () => {
  const p = page({ wrapW: 1000 });
  await p.Flow.toggle(3);
  p.V.zoom(true);
  const at = () => ({ PH: p.geom().PH, cardsOn: p.geom().cards, cards: p.V.cards().map(c => [c.i, c.id]) });
  const before = at();
  assert.strictEqual(before.cardsOn, true);
  for (const i of [2, 0, 4]) {
    p.V.pick(i);
    assert.deepStrictEqual(at(), before, `picking file ${i + 1} moves nothing`);
  }
  p.V.pickHand(1);
  assert.deepStrictEqual(at(), before, 'nor a hand-over');
  // Two clicks on one card: the second still finds it, and it plays.
  const card = (i) => ({ dataset: { i: String(i) }, closest: (q) => (q.split(', ').includes('.flow-card') ? card(i) : null) });
  p.V.click({ target: card(3), clientX: 0, clientY: 0 });
  p.V.click({ target: card(3), clientX: 0, clientY: 0 });
  assert.deepStrictEqual(p.played, [p.geom().order[3]]);
});

test('blurred thumbnails (pm-thumbs): cards stay on their first frame and blur; the floating card blurs too', async () => {
  const p = page({ wrapW: 1000 });
  await p.Flow.toggle(3);
  p.classes.add('pm-thumbs');
  p.V.scrub(1, 0.9);
  const c = p.V.cards().find(x => x.i === 1);
  assert.match(c.src, /^\/scrub\/\d+\/0$/, 'no frame from the pointer');
  assert.strictEqual(c.bar, '90%', 'the bar still says where');
  p.V.unscrub();
  p.classes.delete('pm-thumbs');
  p.V.scrub(1, 0.9);
  assert.match(p.V.cards().find(x => x.i === 1).src, /^\/scrub\/\d+\/4$/, 'without it the pointer scrubs');
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'flow.css'), 'utf8');
  for (const sel of ['.flow-card img', '.flow-hcard img']) assert.ok(css.includes(`body.pm-thumbs ${sel}`), sel);
  assert.doesNotMatch(css, /flow-fs|flow-tip/, 'no full screen or in-chart tooltip styles left');
});

test('the length badge is the grid\'s: none for pictures or under a second', async () => {
  const rows = { 11: ['video', 300], 12: ['image', 0], 13: ['video', 0.4], 14: ['audio', 61], 15: ['image', 12] };
  const Library = { indexOf: () => -1, row: (id) => ({ id, media_type: rows[id][0], duration_seconds: rows[id][1] }) };
  const formatDuration = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const p = page({ wrapW: 1000, extra: { Library, formatDuration } });
  await p.Flow.toggle(3);
  const len = new Map(p.V.cards().map(c => [c.id, c.len]));
  assert.deepStrictEqual([11, 12, 13, 14, 15].map(id => len.get(id)), ['5:00', '', '', '1:01', '']);
  // cards.js's own rule when it is there.
  const q = page({ wrapW: 1000, extra: { Library, formatDuration, tileDurationText: (m) => `T${m.id}` } });
  await q.Flow.toggle(3);
  assert.strictEqual(q.V.cards().find(c => c.id === 12).len, 'T12');
});

test('scrolling the chart ends a scrub (the card under the pointer is another one now)', async () => {
  const p = page({ wrapW: 400, store: { 'vault.flow.zoom': '1' } });
  await p.Flow.toggle(3);
  p.V.scrub(1, 0.5);
  assert.strictEqual(p.V.cards().find(c => c.i === 1).bar, '50%');
  for (const fn of p.wrapListeners.scroll || []) fn();
  const c = p.V.cards().find(x => x.i === 1);
  assert.strictEqual(c.bar, '0');
  assert.match(c.src, /\/0$/, 'its first frame again');
});

test('a big list in Zoom: cards far from the view let their pictures go, and get them back when scrolled to', async () => {
  const p = page({ wrapW: 400, n: 40, store: { 'vault.flow.zoom': '1' } });
  await p.Flow.toggle(3);
  const loaded = () => [...p.V.cards().filter(c => c.loaded && c.src).map(c => c.i)].sort((a, b) => a - b);
  assert.deepStrictEqual(loaded(), [0, 1, 2, 3]);
  p.wrap.scrollLeft = 4000;
  p.V.cardsLoad();
  const far = loaded();
  assert.ok(!far.includes(0) && !far.includes(3), `the first cards dropped theirs: ${far}`);
  assert.ok(far.includes(Math.floor((4000 + 200) / M.ZOOM_COL_PX)), 'the cards in view have theirs');
  assert.strictEqual(p.V.cards().find(c => c.i === 0).src, '');
  // Nearby cards (within a few views) keep theirs: scrolling a little back loads nothing again and drops nothing.
  p.wrap.scrollLeft = 3600;
  p.V.cardsLoad();
  for (const i of far) assert.ok(loaded().includes(i), `card ${i} kept its picture`);
  p.wrap.scrollLeft = 0;
  p.V.cardsLoad();
  assert.deepStrictEqual(loaded().filter(i => i < 4), [0, 1, 2, 3], 'back at the start: loaded again');
});

test('a tag cell that opens the menu is a button for the keyboard: Enter or Space opens it', async () => {
  const menus = [];
  const StreamTags = { blockMenu: (el, id) => menus.push([el.dataset.i, id]), loaded: () => true, onChange() {}, tagsOf: () => [] };
  const p = page({ wrapW: 900, win: roleLane, extra: { StreamTags }, store: { 'vault.flow.lanes': JSON.stringify({ tempo: true }) } });
  await p.Flow.toggle(3);
  const html = p.parts.get('.flow-ltags').innerHTML;
  const editable = html.match(/<span class="flow-tg[^"]*"[^>]*data-flow-tag[^>]*>/g) || [];
  assert.strictEqual(editable.length, 5);
  for (const t of editable) assert.match(t, /role="button" tabindex="0"/);
  assert.doesNotMatch(html.match(/<span class="flow-tg flow-tg-num"[^>]*>/)[0], /tabindex/, 'Tempo is not a button');
  const cell = (i) => ({ dataset: { i: String(i) }, closest: (q) => (q === '[data-flow-tag]' ? cell(i) : null) });
  const ev = (k) => ({ key: k, target: cell(3), preventDefault() { this.prevented = true; }, stopPropagation() {} });
  const e = ev('Enter');
  assert.strictEqual(p.V.tagKey(e), true);
  assert.ok(e.prevented);
  p.V.tagKey(ev(' '));
  assert.strictEqual(p.V.tagKey(ev('a')), false);
  const order = p.geom().order;
  assert.deepStrictEqual(menus, [['3', order[3]], ['3', order[3]]]);
});
