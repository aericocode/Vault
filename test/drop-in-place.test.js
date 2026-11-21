/**
 * Files dragged in from the file manager over an open collection, held
 * still over a spot, go in at that spot (owner request for 3.11): the pure
 * maths (player-lib/drag-autoscroll.js dwellStep and insertBefore,
 * lib/collection-order.js planInsert), then collection-reorder.js
 * inPlaceDragOver / inPlaceFinish in a vm with a bare page (a fake clock,
 * fake tiles): resting for DWELL_MS starts drop mode, which lasts until the
 * drag ends; in it the mark follows the pointer at once (and stays where it
 * was over a spot with no place), and it only shows while nothing hides any
 * of the collection's files.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../player-lib/drag-autoscroll.js');
const { planInsert } = require('../lib/collection-order');

/* ── Hold still (dwellStep) ───────────────────────────────────────────── */

const run = (steps, o) => {
  let s = null;
  for (const [x, y, scroll, t] of steps) s = S.dwellStep(s, x, y, scroll, t, o);
  return s;
};

test('dwellStep: settles only after DWELL_MS of dragovers at the same spot', () => {
  assert.strictEqual(S.DWELL_MS, 1000, 'one second');
  const steps = [];
  for (let t = 0; t < S.DWELL_MS; t += 50) steps.push([100, 100, 0, t]);
  assert.strictEqual(run(steps).settled, false, 'not yet');
  steps.push([100, 100, 0, S.DWELL_MS]);
  assert.strictEqual(run(steps).settled, true);
  assert.strictEqual(run(steps).moved, false);
});

test('dwellStep: small wobble counts as still; a move or a scroll starts the timer again', () => {
  const tol = S.DWELL_TOL;
  assert.strictEqual(run([[100, 100, 0, 0], [100 + tol, 100 - tol, 0, S.DWELL_MS / 2], [100 - tol, 100, 0, S.DWELL_MS]]).settled, true, 'within the tolerance');
  // The anchor does not drift: many small steps the same way are a move.
  const drift = run([[100, 100, 0, 0], [106, 100, 0, 400], [112, 100, 0, 800], [118, 100, 0, 1200]]);
  assert.strictEqual(drift.settled, false);
  const moved = S.dwellStep(run([[100, 100, 0, 0]]), 100 + tol + 1, 100, 0, 1500);
  assert.deepStrictEqual([moved.settled, moved.moved, moved.since], [false, true, 1500]);
  const scrolled = S.dwellStep(run([[100, 100, 0, 0]]), 100, 100, 40, 1500);
  assert.strictEqual(scrolled.settled, false, 'the page scrolled under a still pointer');
  assert.strictEqual(scrolled.moved, true);
  assert.strictEqual(S.dwellStep(null, 1, 1, 0, 5).settled, false, 'first step');
  assert.strictEqual(run([[0, 0, 0, 0], [0, 0, 0, 300]], { ms: 300 }).settled, true, 'options');
});

/* ── Drop mode's place among the tiles on screen (visibleDrop) ────────── */

test('visibleDrop: the pointer is pulled into the visible files; off-screen tiles never count', () => {
  // Two rows of two: 0,1 at y 0..100, 2,3 at y 120..220.
  const R = (l, t) => ({ left: l, right: l + 100, top: t, bottom: t + 100 });
  const rects = [R(0, 0), R(110, 0), R(0, 120), R(110, 120)];
  const all = { top: 0, bottom: 800 };
  assert.deepStrictEqual(S.visibleDrop(20, 50, rects, all), { index: 0, side: 'before' }, 'on a tile: its half');
  assert.deepStrictEqual(S.visibleDrop(105, 50, rects, all), { index: 0, side: 'after' }, 'a gap: the nearest tile');
  // Row one scrolled under the header (view starts at 130): the pointer on the header lands on row two.
  assert.deepStrictEqual(S.visibleDrop(20, 10, rects, { top: 130, bottom: 800 }), { index: 2, side: 'before' });
  // Over a panel or a side gutter: still the nearest visible tile.
  assert.deepStrictEqual(S.visibleDrop(900, 150, rects, all), { index: 3, side: 'after' });
  // Below the last row with the last tile on screen: after it, whatever the x.
  assert.deepStrictEqual(S.visibleDrop(5, 500, rects, all), { index: 3, side: 'after' });
  // The bottom edge band with rows below the screen: the nearest visible row, not "after".
  assert.deepStrictEqual(S.visibleDrop(5, 900, rects, { top: 0, bottom: 150 }), { index: 0, side: 'before' });
  // Table rows: before / after by height.
  assert.deepStrictEqual(S.visibleDrop(5, 90, rects, all, { rows: true }), { index: 0, side: 'after' });
  // A table row cut off by the sticky header or the window edge never takes
  // the mark (its line would be hidden): the pointer on the header lands on
  // the first row that shows whole, and at the bottom on the last such row.
  const rows = [0, 48, 96, 144, 192].map(t => ({ left: 0, right: 600, top: t, bottom: t + 48 }));
  assert.deepStrictEqual(S.visibleDrop(5, 0, rows, { top: 20, bottom: 230 }, { rows: true }), { index: 1, side: 'before' });
  assert.deepStrictEqual(S.visibleDrop(5, 400, rows, { top: 20, bottom: 230 }, { rows: true }), { index: 3, side: 'after' });
  assert.strictEqual(S.onScreen(rows[0], { top: 20, bottom: 230 }, true), false, 'a cut-off row');
  assert.strictEqual(S.onScreen(rows[0], { top: 20, bottom: 230 }, false), true, 'a grid tile counts by its middle');
  assert.strictEqual(S.visibleDrop(5, 5, rects, { top: 400, bottom: 800 }), null, 'no tile on screen');
  assert.strictEqual(S.visibleDrop(5, 5, [], all), null);
});

/* ── The place in the full order (insertBefore) ───────────────────────── */

test('insertBefore: near side is the tile, far side the member after it in the FULL order, null at the end', () => {
  const order = [10, 20, 30, 40];
  assert.strictEqual(S.insertBefore(order, 20, 'before'), 20);
  assert.strictEqual(S.insertBefore(order, 20, 'after'), 30);
  assert.strictEqual(S.insertBefore(order, 40, 'after'), null);
  assert.strictEqual(S.insertBefore(order, 10, 'before'), 10);
  assert.strictEqual(S.insertBefore(order, 99, 'after'), undefined, 'not a member: no place');
  // Continuous / paged: the last LOADED tile is not the last member.
  const big = Array.from({ length: 5000 }, (_, i) => i + 1);
  assert.strictEqual(S.insertBefore(big, 200, 'after'), 201);
});

/* ── The server's plan (planInsert) ───────────────────────────────────── */

test('planInsert: new files go in as one block before the member, in the order given', () => {
  assert.deepStrictEqual(planInsert([1, 2, 3], [7, 8, 9], 2), { order: [1, 7, 8, 9, 2, 3], added: [7, 8, 9] });
  assert.deepStrictEqual(planInsert([1, 2, 3], [7], 1).order, [7, 1, 2, 3], 'at the start');
  assert.deepStrictEqual(planInsert([1, 2, 3], [7], null).order, [1, 2, 3, 7], 'null: the end');
  assert.deepStrictEqual(planInsert([], [7, 8], null).order, [7, 8]);
});

test('planInsert: members stay put, duplicates once, a gone anchor means the end', () => {
  // 3 is already in the collection: it stays where it is, the rest go in.
  assert.deepStrictEqual(planInsert([1, 2, 3, 4], [8, 3, 9, 8], 2), { order: [1, 8, 9, 2, 3, 4], added: [8, 9] });
  assert.deepStrictEqual(planInsert([1, 2], [1, 2], 2), { order: [1, 2], added: [] }, 'nothing new');
  assert.deepStrictEqual(planInsert([1, 2], [5], 77).order, [1, 2, 5], 'the anchor left meanwhile: the end');
  assert.deepStrictEqual(planInsert([1, 2], [0, -1, 1.5, 'x', 5], 1).order, [5, 1, 2], 'nonsense ids skipped');
});

test('planInsert: chunks sent one after another before the same member keep the drop order', () => {
  let order = [1, 2, 3];
  for (const chunk of [[10, 11], [12, 13], [14]]) order = planInsert(order, chunk, 2).order;
  assert.deepStrictEqual(order, [1, 10, 11, 12, 13, 14, 2, 3]);
});

/* ── The page side (collection-reorder.js) ────────────────────────────── */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'collection-reorder.js'), 'utf8');

/** Tile i of a grid three across, rows 120 px apart from y 300, moved up by geo.off (the page scrolled). */
function fakeTile(id, i, geo = { off: 0 }) {
  const cls = new Set();
  const tile = {
    dataset: { id: String(id) }, isConnected: true, cls,
    classList: {
      add: (c) => cls.add(c), remove: (...cs) => cs.forEach(c => cls.delete(c)),
      toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c),
    },
  };
  tile.closest = (q) => (q.startsWith('.media-tile') ? tile : q === '#resultsGrid' ? {} : null);
  tile.getBoundingClientRect = () => {
    const left = (i % 3) * 112, top = 300 + Math.floor(i / 3) * 120 - geo.off;
    return { top, bottom: top + 100, left, right: left + 100, height: 100, width: 100 };
  };
  return tile;
}

function page({ members = [1, 2, 3], total = members.length, sort = 'playlist' } = {}) {
  const clock = { now: 0 };
  const geo = { off: 0 };
  const win = { innerHeight: 800, scrollY: 0, addEventListener() {}, scrollBy() {} };
  const tiles = members.map((id, i) => fakeTile(id, i, geo));
  const every = tiles.slice();          // old ones too, for the marks
  const listeners = {};
  const grid = {
    querySelectorAll: () => tiles.slice(),
    contains: (t) => tiles.includes(t),
    getBoundingClientRect: () => ({ top: 300 - geo.off, bottom: 800, left: 0, right: 330 }),
  };
  const doc = {
    body: { classList: { contains: () => false } },
    addEventListener(type, fn) { listeners[type] = fn; },
    querySelectorAll: () => [],
    querySelector: () => null,
    getElementById: (id) => (id === 'resultsGrid' ? grid : null),
  };
  const timers = new Map();
  let nextTimer = 1;
  const ctx = {
    console, document: doc, window: win, DragAutoScroll: S,
    setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    performance: { now: () => clock.now },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    activeCollectionId: 5,
    collectionMembers: new Map([[5, members]]),
    getCollectionById: () => ({ id: 5, kind: 'collection' }),
    currentSortField: () => sort,
    Library: { shuffled: false, spec: { collectionId: 5 }, search: null, known: () => true, total, row: () => null, indexOf: () => 0 },
    selectedIds: new Set(),
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  // A dragover at x over tile i (left or right half by x), at time t.
  const over = (i, x, t) => {
    clock.now = t;
    const r = tiles[i].getBoundingClientRect();
    return vm.runInContext('inPlaceDragOver', ctx)({ target: tiles[i], clientX: x, clientY: r.top + 50 });
  };
  const overTarget = (target, x, y, t) => {
    clock.now = t;
    return vm.runInContext('inPlaceDragOver', ctx)({ target, clientX: x, clientY: y });
  };
  /** The page scrolled by y: the tiles move up, and the scroll listener runs (wheel, edge scroll). */
  const scrollTo = (y) => { win.scrollY = y; geo.off = y; if (listeners.scroll) listeners.scroll(); };
  /** The grid draws its tiles again (new elements, the old ones gone), without a dragover. */
  const redraw = () => {
    tiles.forEach((t, i) => { t.isConnected = false; tiles[i] = fakeTile(t.dataset.id, i, geo); every.push(tiles[i]); });
  };
  const finish = () => vm.runInContext('inPlaceFinish', ctx)();
  const marked = () => every.filter(t => t.isConnected).flatMap(t => [...t.cls].map(c => `${t.dataset.id}:${c.replace('reorder-drop-', '')}`));
  /** The drag went quiet: run the timers waiting now. */
  const quiet = () => { const run = [...timers.values()]; timers.clear(); run.forEach(fn => fn()); };
  return { over, overTarget, scrollTo, redraw, finish, marked, tiles, quiet };
}

/** Dragovers every 50 ms at the same spot from t0 for ms. */
function rest(p, i, x, t0, ms) {
  let r;
  for (let t = t0; t <= t0 + ms; t += 50) r = p.over(i, x, t);
  return r;
}

test('page: no mark until the pointer rests for DWELL_MS; then drop mode, the mark and its place', () => {
  assert.strictEqual(S.DWELL_MS, 1000, 'one second (owner request: enough to stop accidental drops)');
  const p = page();
  assert.strictEqual(rest(p, 1, 130, 0, S.DWELL_MS - 100), 'waiting');
  assert.deepStrictEqual(p.marked(), []);
  assert.strictEqual(p.finish(), null, 'a drop before drop mode adds at the end');
  assert.strictEqual(rest(p, 1, 130, 0, S.DWELL_MS), 'placing');
  assert.deepStrictEqual(p.marked(), ['2:before'], 'left half of tile 2');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.finish())), { collectionId: 5, before: 2 });
  assert.deepStrictEqual(p.marked(), [], 'the mark is cleared on drop');
  assert.strictEqual(p.finish(), null, 'finished: nothing more');
});

test('page: moving before drop mode starts the timer again', () => {
  const p = page();
  rest(p, 0, 50, 0, S.DWELL_MS - 200);
  assert.strictEqual(p.over(2, 290, S.DWELL_MS), 'waiting', 'moved to tile 3');
  assert.strictEqual(rest(p, 2, 290, S.DWELL_MS + 50, S.DWELL_MS - 200), 'waiting', 'not long enough since the move');
  assert.deepStrictEqual(p.marked(), []);
  assert.strictEqual(rest(p, 2, 290, 2 * S.DWELL_MS, 50), 'placing');
  assert.deepStrictEqual(p.marked(), ['3:after']);
});

test('page: in drop mode the mark follows every move at once, and moving never leaves it', () => {
  const p = page();
  rest(p, 0, 90, 0, S.DWELL_MS);                  // right half of tile 1: before 2
  assert.deepStrictEqual(p.marked(), ['1:after']);
  let t = S.DWELL_MS + 50;
  // Tile 3's right half, no rest: the mark is there at once.
  assert.strictEqual(p.over(2, 290, t += 50), 'placing');
  assert.deepStrictEqual(p.marked(), ['3:after']);
  assert.strictEqual(p.over(1, 120, t += 50), 'placing');
  assert.deepStrictEqual(p.marked(), ['2:before']);
  assert.strictEqual(p.over(0, 10, t += 50), 'placing');
  assert.deepStrictEqual(p.marked(), ['1:before']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.finish())), { collectionId: 5, before: 1 }, 'the drop goes at the showing mark');
});

const bar = { closest: () => null };   // a header, a bar, a floating panel: not a tile, not in the grid

test('page: in drop mode a pointer over a bar or below the files still marks the nearest visible spot', () => {
  const p = page();
  rest(p, 2, 290, 0, S.DWELL_MS);
  assert.deepStrictEqual(p.marked(), ['3:after']);
  assert.strictEqual(p.overTarget(bar, 10, 20, S.DWELL_MS + 50), 'placing', 'over the header');
  assert.deepStrictEqual(p.marked(), ['1:before'], 'the nearest row, by the pointer x');
  assert.strictEqual(p.overTarget(bar, 10, 700, S.DWELL_MS + 100), 'placing', 'below the last row');
  assert.deepStrictEqual(p.marked(), ['3:after'], 'below the last tile: after it');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.finish())), { collectionId: 5, before: null }, 'after the last member: the end');
});

test('page: in drop mode only tiles on screen count; a scroll moves the mark with the content', () => {
  const p = page({ members: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
  rest(p, 0, 10, 0, S.DWELL_MS);                  // tile 1, left half, pointer at y 350
  assert.deepStrictEqual(p.marked(), ['1:before']);
  p.scrollTo(120);                                // row two now under the still pointer
  assert.deepStrictEqual(p.marked(), ['4:before'], 'the scroll alone moved the mark with the content');
  // Scrolled 400: row one is above the screen, rows two and three at 20 and 140; the pointer is below them.
  p.scrollTo(400);
  assert.deepStrictEqual(p.marked(), ['9:after'], 'below the last row: after the last tile');
  assert.strictEqual(p.overTarget(bar, 10, 5, S.DWELL_MS + 50), 'placing', 'pointer on the header');
  assert.deepStrictEqual(p.marked(), ['4:before'], 'not the off-screen row it is nearer to');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.finish())), { collectionId: 5, before: 4 });
});

test('page: at the drop, a marked tile the grid drew away is looked up again; nothing on screen means the end', () => {
  const p = page({ members: [1, 2, 3, 4, 5, 6] });
  rest(p, 4, 200, 0, S.DWELL_MS);                 // tile 5, right half: before 6
  assert.deepStrictEqual(p.marked(), ['5:after']);
  p.redraw();                                     // no dragover since
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.finish())), { collectionId: 5, before: 6 }, 'same place, from the new tiles');
  const q = page({ members: [1, 2, 3, 4, 5, 6] });
  rest(q, 4, 200, 0, S.DWELL_MS);
  q.scrollTo(2000);                               // every tile off screen: no mark can show
  assert.deepStrictEqual(q.marked(), []);
  assert.strictEqual(q.finish(), null, 'no mark: the drop adds at the end');
});

test('page: a later drag starts fresh, not in drop mode', () => {
  const p = page();
  rest(p, 1, 130, 0, S.DWELL_MS);
  p.finish();
  assert.strictEqual(p.over(1, 130, 10000), 'waiting');
  assert.deepStrictEqual(p.marked(), []);
  assert.strictEqual(p.finish(), null);
});

test('page: no mark when something hides files, in another sort, or on an empty collection', () => {
  const hidden = page({ members: [1, 2, 3], total: 2 });
  assert.strictEqual(rest(hidden, 1, 130, 0, S.DWELL_MS + 100), 'off');
  assert.deepStrictEqual(hidden.marked(), []);
  assert.strictEqual(hidden.finish(), null);
  const sorted = page({ sort: 'name' });
  assert.strictEqual(rest(sorted, 1, 130, 0, S.DWELL_MS + 100), 'off');
  const empty = page({ members: [] });
  empty.tiles.push(fakeTile(9, 0));                 // a tile that is not a member
  assert.strictEqual(rest(empty, 0, 10, 0, S.DWELL_MS + 100), 'off');
  assert.strictEqual(empty.finish(), null);
});

test('page: a drag that ends unseen (no dragover any more, no dragleave) leaves no mark behind', () => {
  const p = page();
  rest(p, 1, 130, 0, S.DWELL_MS + 50);
  assert.deepStrictEqual(p.marked(), ['2:before']);
  p.quiet();
  assert.deepStrictEqual(p.marked(), []);
  assert.strictEqual(p.finish(), null, 'the next drop is not sent to the old spot');
});
