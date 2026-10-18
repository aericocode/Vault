/**
 * player-lib/wall.js (the Wall tab) in a VM: the pure pieces of Round 2.
 * Settings migration from the first Wall (picSpeed / clipLen / blockSize),
 * clamping, and the masonry plan: equal columns, exact shapes, files wider
 * than 2.5:1 spanning two columns, and a board that always reaches the
 * bottom edge whatever the shapes and sizes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWall() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'wall.js'), 'utf8');
  const ctx = { window: {}, document: {}, console, Math, Number, String, Array, Object, JSON, Map, Set, Promise };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__wall = Wall;`, ctx);
  return ctx.__wall._pure;
}

const W = loadWall();

test('settings: defaults for an empty or broken blob', () => {
  for (const raw of [undefined, null, {}, 'junk', { playing: 'x', gap: NaN, mode: 'diagonal', source: 'drop table' }]) {
    const c = W.cfgFrom(raw);
    assert.strictEqual(c.v, 2);
    assert.strictEqual(c.playing, 6);
    assert.strictEqual(c.picSpeed, 8);
    assert.strictEqual(c.clipLen, 20);
    assert.strictEqual(c.colWidth, 390);
    assert.strictEqual(c.gap, 4);
    assert.strictEqual(c.scrollSpeed, 4);
    assert.strictEqual(c.mode, 'grid');
    assert.strictEqual(c.source, 'library');
    assert.strictEqual(c.clipsToEnd, false);
  }
});

test('settings: out-of-range values are clamped', () => {
  const c = W.cfgFrom({ v: 2, playing: 99, picSpeed: 0, clipLen: 9999, colWidth: 5, gap: -3, scrollSpeed: 42 });
  assert.strictEqual(c.playing, 16);
  assert.strictEqual(c.picSpeed, 2);
  assert.strictEqual(c.clipLen, 120);
  assert.strictEqual(c.colWidth, 120);
  assert.strictEqual(c.gap, 0);
  assert.strictEqual(c.scrollSpeed, 10);
});

test('settings: a first-Wall blob migrates and keeps its feel', () => {
  const old = { playing: 9, picSpeed: 13, clipLen: 35, blockSize: 300, gap: 7, mix: 'videos', order: 'order',
    source: 'c:12', soundOnHover: true, directOnly: true, barOpen: false };
  const c = W.cfgFrom(old);
  assert.strictEqual(c.playing, 9);
  assert.strictEqual(c.picSpeed, 13, 'seconds are kept exactly, not snapped to a slider step');
  assert.strictEqual(c.clipLen, 35);
  assert.strictEqual(c.clipsToEnd, false);
  assert.strictEqual(c.colWidth, 450, 'row height 300 becomes column width 450');
  assert.strictEqual(c.gap, 7);
  assert.strictEqual(c.mix, 'videos');
  assert.strictEqual(c.order, 'order');
  assert.strictEqual(c.source, 'c:12');
  assert.strictEqual(c.soundOnHover, true);
  assert.strictEqual(c.directOnly, true);
  assert.strictEqual(c.mode, 'grid');
  assert.ok(!('blockSize' in c) && !('barOpen' in c), 'old keys are not carried forward');
  // The old default row height lands on the new default column width.
  assert.strictEqual(W.cfgFrom({ blockSize: 260 }).colWidth, 390);
  // Saving and loading again changes nothing.
  assert.deepStrictEqual(W.cfgFrom(JSON.parse(JSON.stringify(c))), c);
});

test('settings: the old "Full clip" maximum becomes Play clips to the end', () => {
  const c = W.cfgFrom({ clipLen: 120 });
  assert.strictEqual(c.clipsToEnd, true);
  // In a Round 2 blob, 120 is just 120 seconds.
  const d = W.cfgFrom({ v: 2, clipLen: 120, clipsToEnd: false });
  assert.strictEqual(d.clipsToEnd, false);
  assert.strictEqual(d.clipLen, 120);
});

test('speed sliders run faster to the right', () => {
  for (const steps of [W.PIC_STEPS, W.CLIP_STEPS]) {
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] < steps[i - 1]);
  }
  assert.strictEqual(W.PIC_STEPS[W.nearestStep(W.PIC_STEPS, 8)], 8);
  assert.strictEqual(W.PIC_STEPS[W.nearestStep(W.PIC_STEPS, 13)], 12);
  assert.strictEqual(W.CLIP_STEPS[W.nearestStep(W.CLIP_STEPS, 35)], 30);
});

/** Fill a plan the way the Wall does: shortest column first, until every column passes H. */
function fillPlan(Wd, H, colWidth, gap, aspects) {
  const plan = W.planColumns(Wd, colWidth, gap);
  const placed = [];
  let k = 0;
  while (W.minBottom(plan) < H && placed.length < 5000) {
    const a = aspects[k++ % aspects.length];
    const s = W.slotFor(plan, a);
    W.placeSlot(plan, s);
    placed.push({ ...s, a });
  }
  return { plan, placed };
}

const SHAPES = [16 / 9, 9 / 16, 0.4, 1, 21 / 9, 32 / 9, 4, 4 / 3, 3 / 4, 2 / 3];

test('masonry: equal columns that exactly span the width', () => {
  for (const [Wd, cwant, gap] of [[1280, 390, 4], [1920, 260, 0], [3440, 120, 12], [300, 960, 4]]) {
    const p = W.planColumns(Wd, cwant, gap);
    assert.ok(p.cols >= 1);
    const right = p.colX[p.cols - 1] + p.cw;
    assert.ok(Math.abs(right - Wd) < 1e-6, `last column ends at the edge (${right} vs ${Wd})`);
    for (let c = 1; c < p.cols; c++) assert.ok(Math.abs(p.colX[c] - p.colX[c - 1] - p.cw - gap) < 1e-6);
  }
});

test('masonry: every block keeps its exact shape; only wide files span two columns', () => {
  const { plan, placed } = fillPlan(1920, 1080, 300, 4, SHAPES);
  for (const s of placed) {
    assert.ok(Math.abs(s.w / s.h - s.a) < 1e-9, 'shape kept exactly');
    if (s.a <= 2.5) assert.strictEqual(s.span, 1, 'only a wide file spans');
    assert.ok(Math.abs(s.w - (s.span * plan.cw + (s.span - 1) * plan.gap)) < 1e-9);
  }
});

test('masonry: blocks never overlap and the board reaches the bottom edge', () => {
  for (const [Wd, H] of [[1280, 760], [1920, 1040], [3440, 1400], [500, 700]]) {
    for (const cwant of [120, 260, 390, 640, 960]) {
      for (const gap of [0, 4, 12]) {
        for (const shapes of [SHAPES, [4], [9 / 16], [32 / 9, 1]]) {
          const { plan, placed } = fillPlan(Wd, H, cwant, gap, shapes);
          assert.ok(W.minBottom(plan) >= H, `full at ${Wd}x${H} col ${cwant} gap ${gap}`);
          for (let i = 0; i < placed.length; i++) {
            const a = placed[i];
            assert.ok(a.x >= -1e-6 && a.x + a.w <= Wd + 1e-6, 'inside the width');
            for (let j = i + 1; j < placed.length; j++) {
              const b = placed[j];
              const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
              const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
              assert.ok(!(ox > 0.01 && oy > 0.01), 'no overlap');
            }
          }
        }
      }
    }
  }
});

test('masonry: wide files span two columns unless that would leave a big hole', () => {
  const { placed } = fillPlan(1920, 1080, 300, 4, SHAPES);
  const wide = placed.filter(s => s.a > 2.5);
  assert.ok(wide.some(s => s.span === 2), 'wide files span two columns where they can');
  // Nothing but panoramas on an odd number of columns: no column is left empty.
  const pano = fillPlan(1280, 690, 390, 0, [4]);
  assert.strictEqual(pano.plan.cols, 3);
  for (let c = 0; c < 3; c++) assert.ok(pano.placed.some(s => s.col <= c && c < s.col + s.span));
  const area = pano.placed.reduce((n, s) => n + s.w * Math.min(s.h, Math.max(0, 690 - s.y)), 0);
  assert.ok(area / (1280 * 690) > 0.85, 'the board is covered, not holes');
});

test('masonry: a wide file goes where two columns are near level', () => {
  const plan = W.planColumns(1200, 300, 0);    // 4 columns
  plan.tops = [500, 100, 120, 900];
  const s = W.slotFor(plan, 4);
  assert.strictEqual(s.span, 2);
  assert.strictEqual(s.col, 1);
  assert.strictEqual(s.y, 120);
  assert.strictEqual(s.hole, 20);
});
