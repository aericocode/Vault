/**
 * Edge auto-scroll while dragging tiles or table rows to reorder a
 * collection: the pure speed / band maths (player-lib/drag-autoscroll.js),
 * then the frame loop collection-reorder.js drives from dragover, in a vm
 * with a bare page (a fake clock, frames run by hand, window.scrollBy
 * recorded): it starts in the band, stops on drop, dragend, leaving the
 * band, or when dragover stops coming, and the visible edges allow for the
 * sticky header and the Stage bar.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const S = require('../player-lib/drag-autoscroll.js');

const speed = (y, top = 0, bottom = 1000, o) => S.speed(y, top, bottom, o);

/* ── The maths ────────────────────────────────────────────────────────── */

test('no scrolling in the middle, nor on the inner side of each band', () => {
  assert.strictEqual(speed(500), 0);
  assert.strictEqual(speed(S.BAND), 0, 'exactly at the top band\'s inner side');
  assert.strictEqual(speed(1000 - S.BAND), 0, 'exactly at the bottom band\'s inner side');
  assert.strictEqual(speed(S.BAND + 1), 0);
});

test('up in the top band, down in the bottom one, faster nearer the edge', () => {
  const ys = [S.BAND - 1, 50, 30, 10, 0];
  const up = ys.map(y => speed(y));
  assert.ok(up.every(v => v < 0), 'negative: up');
  for (let i = 1; i < up.length; i++) assert.ok(Math.abs(up[i]) > Math.abs(up[i - 1]), `faster at ${ys[i]} than at ${ys[i - 1]}`);
  const down = ys.map(y => speed(1000 - y));
  assert.ok(down.every(v => v > 0), 'positive: down');
  for (let i = 1; i < down.length; i++) assert.ok(down[i] > down[i - 1]);
  // Symmetric.
  ys.forEach((y, i) => assert.ok(Math.abs(up[i] + down[i]) < 1e-9));
});

test('the speed runs from about MIN_SPEED just inside the band to MAX_SPEED at the edge, and stays there past it', () => {
  assert.ok(Math.abs(speed(S.BAND - 0.001)) >= S.MIN_SPEED);
  assert.ok(Math.abs(speed(S.BAND - 0.001)) < S.MIN_SPEED + 1);
  assert.strictEqual(speed(0), -S.MAX_SPEED);
  assert.strictEqual(speed(1000), S.MAX_SPEED);
  assert.strictEqual(speed(-40), -S.MAX_SPEED, 'over a bar above the files: full speed');
  assert.strictEqual(speed(1060), S.MAX_SPEED, 'over the Stage bar: full speed');
  // Eased: halfway into the band is under halfway between the two speeds.
  const half = speed(S.BAND / 2);
  assert.ok(-half < (S.MIN_SPEED + S.MAX_SPEED) / 2);
});

test('the bands sit at the visible edges, under a sticky header and over the Stage bar', () => {
  const top = 120, bottom = 700;
  assert.strictEqual(speed(130, top, bottom), speed(10, 0, 580), 'measured from the header\'s bottom');
  assert.ok(speed(130, top, bottom) < 0);
  assert.strictEqual(speed(top + S.BAND + 5, top, bottom), 0);
  assert.ok(speed(690, top, bottom) > 0, 'just above the Stage bar');
  assert.strictEqual(speed(bottom - S.BAND - 5, top, bottom), 0);
});

test('a short window keeps a middle that does not scroll; nonsense scrolls nothing', () => {
  // 150 px of files: the bands are 50 px each, not 70.
  assert.strictEqual(speed(75, 0, 150), 0);
  assert.ok(speed(49, 0, 150) < 0);
  assert.ok(speed(101, 0, 150) > 0);
  assert.strictEqual(speed(10, 200, 200), 0, 'no room at all');
  assert.strictEqual(speed(10, 300, 200), 0);
  assert.strictEqual(speed(NaN), 0);
  assert.strictEqual(speed(10, 0, Infinity), 0);
  // Options.
  assert.strictEqual(speed(0, 0, 1000, { band: 100, min: 10, max: 50 }), -50);
  assert.strictEqual(speed(95, 0, 1000, { band: 100, min: 10, max: 50 }), -(10 + 40 * 0.05 * 0.05));
});

/* ── The frame loop (collection-reorder.js) ───────────────────────────── */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'collection-reorder.js'), 'utf8');

function fakeTile(id, top = 300) {
  const tile = { dataset: { id: String(id) }, classList: { add() {}, remove() {}, toggle() {} } };
  tile.hasAttribute = (a) => a === 'draggable';
  tile.contains = (el) => el === tile;
  tile.closest = (q) => (q.startsWith('.media-tile') ? tile : q === '#resultsGrid' ? {} : null);
  tile.ends = [];
  tile.addEventListener = (type, fn) => { if (type === 'dragend') tile.ends.push(fn); };
  tile.getBoundingClientRect = () => ({ top, bottom: top + 48, left: 0, right: 400, height: 48, width: 400 });
  return tile;
}

function page({ header = 64, stageBar = 0 } = {}) {
  const on = {};
  let frames = [];
  let nextFrame = 1;
  const clock = { now: 0 };
  const scrolls = [];
  const win = {
    innerHeight: 800, scrollY: 1000,
    addEventListener() {},
    scrollBy: (x, y) => { scrolls.push(y); win.scrollY += y; },
  };
  const body = { classList: { contains: (c) => c === 'stage-bar-on' && stageBar > 0 } };
  const doc = {
    body,
    addEventListener: (t, fn) => { (on[t] = on[t] || []).push(fn); },
    querySelectorAll: () => [],
    querySelector: (q) => (q === '.stage-bar' && stageBar ? { getBoundingClientRect: () => ({ top: 800 - stageBar, height: stageBar }) } : null),
    getElementById: (id) => (id === 'appHeader' ? { getBoundingClientRect: () => ({ top: 0, bottom: header, height: header }) } : null),
  };
  const ctx = {
    console, document: doc, window: win, DragAutoScroll: S,
    setTimeout: () => 0,
    performance: { now: () => clock.now },
    requestAnimationFrame: (fn) => { const id = nextFrame++; frames.push({ id, fn }); return id; },
    cancelAnimationFrame: (id) => { frames = frames.filter(f => f.id !== id); },
    activeCollectionId: 5,
    collectionMembers: new Map([[5, [1, 2, 3]]]),
    getCollectionById: () => ({ id: 5, kind: 'collection' }),
    currentSortField: () => 'playlist',
    Library: { shuffled: false, spec: { collectionId: 5 }, search: null, row: () => ({ filename: 'a.mp4' }), indexOf: () => 0 },
    selectedIds: new Set(),
  };
  ctx.window.innerHeight = 800;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const fire = (type, e) => { for (const fn of on[type] || []) fn(e); };
  /** Run the frames queued now, `ms` after the last. */
  const frame = (ms = 16) => {
    clock.now += ms;
    const run = frames; frames = [];
    for (const f of run) f.fn(clock.now);
  };
  const tile = fakeTile(1);
  const start = () => fire('dragstart', { target: tile, dataTransfer: { setData() {}, effectAllowed: '' }, preventDefault() {} });
  const over = (y, target = { closest: () => null }) => fire('dragover', { target, clientY: y, clientX: 10, preventDefault() {}, dataTransfer: {} });
  return { fire, frame, start, over, tile, scrolls, win, clock, pending: () => frames.length };
}

test('dragging near the bottom scrolls down each frame, near the top up; the middle does not', () => {
  const p = page();
  p.start();
  p.over(400);
  assert.strictEqual(p.pending(), 0, 'nothing in the middle');
  p.over(790);
  p.frame(); p.over(790); p.frame();
  assert.ok(p.scrolls.length >= 2);
  assert.ok(p.scrolls.every(y => y > 0), 'down');
  p.scrolls.length = 0;
  p.over(70);                       // the header is 64 px: 6 px into the files
  p.frame(); p.over(70); p.frame();
  assert.ok(p.scrolls.length >= 1 && p.scrolls.every(y => y < 0), 'up');
});

test('faster nearer the edge (the same time step)', () => {
  const a = page();
  a.start(); a.over(745); a.frame(); a.frame(16);
  const b = page();
  b.start(); b.over(795); b.frame(); b.frame(16);
  assert.ok(Math.abs(b.scrolls.at(-1)) > Math.abs(a.scrolls.at(-1)));
});

test('the loop stops when dragover stops coming, on leaving the band, on drop and on dragend', () => {
  const p = page();
  p.start();
  p.over(790);
  p.frame(); p.frame(100);
  assert.ok(p.pending() > 0, 'still going 116 ms after the last dragover');
  p.frame(60);
  assert.strictEqual(p.pending(), 0, 'no dragover for over 150 ms: stopped');

  p.over(790); p.frame();
  assert.ok(p.pending() > 0);
  p.over(400);
  assert.strictEqual(p.pending(), 0, 'out of the band: stopped at once');

  p.over(790); p.frame();
  p.fire('drop', { target: { closest: () => null }, preventDefault() {} });
  assert.strictEqual(p.pending(), 0, 'drop');

  p.start(); p.over(790); p.frame();
  p.fire('dragend', {});
  assert.strictEqual(p.pending(), 0, 'dragend');

  // The grid redrew the dragged row away: its own dragend still ends the drag.
  p.start(); p.over(790); p.frame();
  p.tile.ends.forEach(fn => fn());
  p.frame();
  assert.strictEqual(p.pending(), 0);
  const n = p.scrolls.length;
  p.over(790);
  assert.strictEqual(p.pending(), 0, 'no drag on: a dragover does nothing');
  assert.strictEqual(p.scrolls.length, n);
});

test('no drag of ours on: dragover near the edge scrolls nothing (files from the computer, say)', () => {
  const p = page();
  p.over(795);
  p.frame();
  assert.strictEqual(p.pending(), 0);
  assert.deepStrictEqual(p.scrolls, []);
});

test('the bottom band sits over the Stage bar while it shows', () => {
  const p = page({ stageBar: 90 });
  p.start();
  p.over(690);                      // 20 px above the Stage bar (it starts at 710)
  p.frame(); p.over(690); p.frame();
  assert.ok(p.scrolls.length && p.scrolls.every(y => y > 0));
  const q = page();
  q.start();
  q.over(690);                      // no Stage bar: 110 px from the bottom, no scrolling
  assert.strictEqual(q.pending(), 0);
});
