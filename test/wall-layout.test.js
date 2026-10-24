/**
 * player-lib/wall.js (the Wall tab) in a VM: the pure pieces of Round 2.
 * Settings migration from the first Wall (picSpeed / clipLen / blockSize),
 * clamping, and the masonry plan: equal columns, exact shapes, files wider
 * than 2.5:1 spanning two columns, and a board that always reaches the
 * bottom edge whatever the shapes and sizes.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
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

test('empty wall: the filter hint only when a search or filter is on; an empty library gets its own state', () => {
  const lib = (o) => W.emptyMessage({ source: 'library', narrowed: false, libraryEmpty: false, ...o });
  assert.strictEqual(lib({ libraryEmpty: true }).kind, 'library');
  assert.strictEqual(lib({ libraryEmpty: true }).title, 'Your library is empty');
  assert.doesNotMatch(lib({ libraryEmpty: true }).hint, /filter/);
  assert.strictEqual(lib({ narrowed: true }).kind, 'filter');
  assert.match(lib({ narrowed: true }).hint, /filters/);
  assert.strictEqual(lib({ narrowed: true, libraryEmpty: true }).kind, 'filter', 'a search that matched nothing is not an empty library');
  assert.strictEqual(lib({}).kind, 'unfit');
  assert.doesNotMatch(lib({}).hint, /filter/);
  assert.strictEqual(W.emptyMessage({ source: 'c:3', narrowed: true, libraryEmpty: true }).kind, 'source');
  for (const o of [{}, { narrowed: true }, { libraryEmpty: true }]) assert.doesNotMatch(JSON.stringify(lib(o)), /—|–/, 'no dashes');
});

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
    assert.strictEqual(c.sound, 'off');
    assert.strictEqual(c.pauseOnHover, true);
  }
});

test('settings: the old Sound on hover checkbox migrates to the Sound choice', () => {
  // A Round 2 blob saved before the Sound choice existed.
  const on = W.cfgFrom({ v: 2, soundOnHover: true, mode: 'scroll' });
  assert.strictEqual(on.sound, 'hover');
  assert.strictEqual(on.pauseOnHover, true, 'existing users keep pause on hover');
  assert.ok(!('soundOnHover' in on), 'the old key is not carried forward');
  assert.strictEqual(W.cfgFrom({ v: 2, soundOnHover: false }).sound, 'off');
  assert.strictEqual(W.cfgFrom({ v: 2, soundOnHover: 'yes' }).sound, 'off', 'only a real true counts');
  // The new key wins over the old one, and junk falls back.
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'auto', soundOnHover: false }).sound, 'auto');
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'loud' }).sound, 'off');
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'loud', soundOnHover: true }).sound, 'hover');
  // Pause on hover is on unless it was turned off.
  assert.strictEqual(W.cfgFrom({ v: 2, pauseOnHover: false }).pauseOnHover, false);
  assert.strictEqual(W.cfgFrom({ v: 2, pauseOnHover: 0 }).pauseOnHover, true);
  // Saving and loading again changes nothing.
  for (const c of [on, W.cfgFrom({ v: 2, sound: 'auto', pauseOnHover: false })]) {
    assert.deepStrictEqual(W.cfgFrom(JSON.parse(JSON.stringify(c))), c);
  }
});

/* Auto sound: which playing clip is heard. */
const clip = (key, left, startedAt) => ({ key, left, startedAt });

test('auto sound: the clip with the most time left is heard', () => {
  const cands = [clip('a', 4000, 1), clip('b', 19000, 2), clip('c', 7000, 3)];
  assert.strictEqual(W.pickAudible(cands, null), 'b');
  assert.strictEqual(W.pickAudible([], null), null, 'nothing plays: silence');
  assert.strictEqual(W.pickAudible([], 'a'), null, 'the heard clip stopped and nothing else plays');
  // A clip nothing ends (loops, or the drift is paused) has the most time.
  assert.strictEqual(W.pickAudible([clip('a', 90000, 1), clip('b', Infinity, 0)], null), 'b');
});

test('auto sound: a tie goes to the most recently started clip', () => {
  const cands = [clip('a', Infinity, 100), clip('b', Infinity, 300), clip('c', Infinity, 200)];
  assert.strictEqual(W.pickAudible(cands, null), 'b');
  assert.strictEqual(W.pickAudible([clip('a', 5000, 10), clip('b', 5000, 20)], null), 'b');
  assert.strictEqual(W.pickAudible([clip('a', 5000, 20), clip('b', 5000, 10)], null), 'a');
});

test('auto sound: never switches away from a clip that is still playing', () => {
  const cands = [clip('a', 1000, 1), clip('b', Infinity, 2), clip('c', 60000, 3)];
  assert.strictEqual(W.pickAudible(cands, 'a'), 'a', 'more time elsewhere is no reason to jump');
  // Once it stops (no longer among the playing clips) the sound moves on.
  assert.strictEqual(W.pickAudible(cands.slice(1), 'a'), 'b');
  // A broken time left never wins.
  assert.strictEqual(W.pickAudible([clip('a', NaN, 9), clip('b', 10, 1)], null), 'b');
  // The clip being heard hands the sound on once its own time is up, crossfading while it still plays.
  assert.strictEqual(W.pickAudible([clip('a', 0, 9), clip('b', 4000, 8)], 'a'), 'b');
  assert.strictEqual(W.pickAudible([clip('a', 1, 9), clip('b', 4000, 8)], 'a'), 'a');
  // When every clip is about to stop, something playing is still heard (never silence while clips play):
  // the current one while it plays, else the one with the most time.
  assert.strictEqual(W.pickAudible([clip('a', -100, 9), clip('b', -50, 8)], 'a'), 'a');
  assert.strictEqual(W.pickAudible([clip('a', -250, 9), clip('b', 0, 8)], null), 'b');
  assert.strictEqual(W.pickAudible([clip('b', -50, 8)], 'gone'), 'b');
});

test('auto sound: a swapped Grid clip still playing keeps the sound until a clip with time left starts', () => {
  // The old clip under its block's next picture is a candidate with no time left.
  assert.strictEqual(W.pickAudible([clip('old', -350, 1), clip('x', -100, 2)], 'old'), 'old', 'no dip while everything is stopping');
  assert.strictEqual(W.pickAudible([clip('old', -350, 1), clip('new', 9000, 3)], 'old'), 'new');
});

test('auto sound: only a file the probe found sound in counts, unknown until probed', () => {
  assert.strictEqual(W.storedAudio({ probe_version: 1, audio_codec: 'aac' }), true);
  assert.strictEqual(W.storedAudio({ probe_version: 1, audio_codec: null }), false, 'probed, no audio stream');
  assert.strictEqual(W.storedAudio({ probe_version: 0, audio_codec: null }), null, 'not probed: the element tells');
  assert.strictEqual(W.storedAudio({ audio_codec: 'aac' }), null);
});

test('auto sound: at most one clip keeps fading out (never three partly audible)', () => {
  const a = { gain: 0.6, to: 0 }, b = { gain: 0.4, to: 1 }, c = { gain: 0, to: 0 }, d = { gain: 0, to: 0 };
  assert.strictEqual(W.fadeOutPick([a, b, c], c), a, 'the loudest keeps fading, the rest are silenced');
  assert.strictEqual(W.fadeOutPick([a, b, c], a), b);
  assert.strictEqual(W.fadeOutPick([c, d], c), null, 'nothing sounding: nothing to fade');
  assert.strictEqual(W.fadeOutPick([a], null), a);
});

test('grid clips: the first clips after a layout stop one by one over a clip length', () => {
  const runs = [6, 5, 4, 3, 2, 1, 0, -1].map(left => W.staggerRun(left, 6));
  assert.deepStrictEqual(runs.map(r => +r.toFixed(3)), [1, 0.833, 0.667, 0.5, 0.333, 0.167, 1, 1]);
  assert.strictEqual(W.staggerRun(3, 0), 1, 'never more than a whole clip');
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
  assert.strictEqual(c.sound, 'hover', 'Sound on hover becomes the On hover choice');
  assert.strictEqual(c.pauseOnHover, true);
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

test('settings: non-numbers fall back to the defaults', () => {
  const c = W.cfgFrom({ playing: [], gap: true, scrollSpeed: {}, blockSize: true });
  assert.strictEqual(c.playing, 6);
  assert.strictEqual(c.gap, 4);
  assert.strictEqual(c.scrollSpeed, 4);
  assert.strictEqual(c.colWidth, 390, 'blockSize: true is not a row height');
  assert.strictEqual(W.cfgFrom({ blockSize: '' }).colWidth, 390);
  assert.strictEqual(W.cfgFrom({ blockSize: [] }).colWidth, 390);
  assert.strictEqual(W.cfgFrom({ playing: '9' }).playing, 9, 'a numeric string still counts');
});

/* The swap pick and the buffer. Rows are { id, a } with a known shape. */
const swapOpts = (extra = {}) => ({
  aspectOf: (r) => r.a, usable: () => true, onScreen: () => false, currentId: null, order: 'shuffle', ...extra,
});

test('swap: a fitting file is chosen however deep in the buffer it sits', () => {
  for (const order of ['shuffle', 'order']) {
    for (const depth of [0, 500, 1000, 1200, 1499]) {
      const list = [];
      for (let i = 0; i < depth; i++) list.push({ id: 10000 + i, a: 4 });   // rare panoramas nobody takes
      list.push({ id: 1, a: 16 / 9 });
      const got = W.pickSwap(list, 16 / 9, swapOpts({ order }));
      assert.deepStrictEqual({ ...got }, { i: depth, fit: true }, `${order}, fit at ${depth}`);
    }
  }
});

test('swap: In order takes the fit closest to the front; repeats come last', () => {
  const list = [{ id: 1, a: 4 }, { id: 2, a: 1.7 }, { id: 3, a: 16 / 9 }, { id: 4, a: 1.75 }];
  assert.strictEqual(W.pickSwap(list, 16 / 9, swapOpts({ order: 'order' })).i, 1);
  assert.strictEqual(W.pickSwap(list, 16 / 9, swapOpts()).i, 2, 'Shuffle prefers the closer shape');
  const on = swapOpts({ order: 'order', onScreen: (r) => r.id === 2 });
  assert.strictEqual(W.pickSwap(list, 16 / 9, on).i, 2, 'one already on screen loses to a fresh fit');
  // Only the slot's own file fits, but a fresh file can be cropped in: crop.
  const own = W.pickSwap([{ id: 7, a: 1 }, { id: 8, a: 16 / 9 }], 16 / 9, swapOpts({ currentId: 8 }));
  assert.deepStrictEqual({ ...own }, { i: 0, fit: false });
  // Nothing fits: the closest shape is cropped in.
  const crop = W.pickSwap([{ id: 1, a: 4 }, { id: 2, a: 1 }, { id: 3, a: 0.5 }], 16 / 9, swapOpts());
  assert.deepStrictEqual({ ...crop }, { i: 1, fit: false });
  // Files whose shape is not known yet are not picked.
  const wait = W.pickSwap([{ id: 1, a: 16 / 9, u: false }], 16 / 9, swapOpts({ usable: (r) => r.u !== false }));
  assert.strictEqual(wait.i, -1);
});

test('buffer: stays within the cap however many swaps miss', () => {
  // The Wall's fill loop, driven by the same helpers: every miss asks for
  // one more batch; each fetched id gives at most one row (here: always one).
  let held = 300;
  const base = 340;
  for (let miss = 0; miss < 500; miss++) {
    const target = W.fillTarget(held, base, true);
    assert.ok(target <= W.READY_CAP);
    let scanned = 0;
    while (held < target && scanned < 8000) {
      const n = W.batchSize(held, target, 8000 - scanned);
      if (n <= 0) break;
      scanned += n;
      held += n;
      assert.ok(held <= W.READY_CAP, `held ${held} after miss ${miss}`);
    }
    if (miss % 3 === 0) held--;           // a swap took one
  }
  assert.ok(held >= W.READY_CAP - 200, 'the buffer did grow toward the cap');
  assert.strictEqual(W.fillTarget(W.READY_CAP, base, true), W.READY_CAP);
  assert.strictEqual(W.batchSize(W.READY_CAP, W.READY_CAP, 8000), 0, 'at the cap nothing is fetched');
});

test('buffer: a file passed over many times leaves it', () => {
  const rare = { id: 1, a: 4 };
  let list = [rare];
  for (let i = 0; i < 400; i++) list.push({ id: 100 + i, a: 16 / 9 });
  const skips = new Map();
  let dropped = 0;
  for (let t = 0; t < W.STALE_SKIPS && list.includes(rare); t++) {
    const out = W.takeAt(list, 1, skips);   // something behind it is taken
    list = out.list;
    dropped += out.dropped;
  }
  assert.ok(!list.includes(rare), 'the rare file was dropped');
  assert.strictEqual(dropped, 1);
  assert.strictEqual(list[0].id, 100 + W.STALE_SKIPS, 'the others are untouched, in order');
});

test('pause on hover: a held block\'s remaining time follows every new swap time', () => {
  // Hovered while showing a still with 300 ms left: hoverStart snapshots that.
  const b = { dueAt: 10300, held: true, holdLeft: 300 };
  // A clip starts during the hover (its 'playing' handler): 30 s from now.
  W.setDue(b, 10000 + 30000, 10000);
  assert.strictEqual(b.dueAt, 40000);
  assert.strictEqual(b.holdLeft, 30000, 'the clip keeps its whole length after the hover');
  // The clip ends during the hover: due now, so hoverEnd's 1.5 s floor applies.
  W.setDue(b, 0, 20000);
  assert.ok(b.holdLeft < 0);
  // A block that is not held keeps its last snapshot untouched.
  const free = { dueAt: 5000, held: false, holdLeft: 123 };
  W.setDue(free, 9000, 1000);
  assert.strictEqual(free.dueAt, 9000);
  assert.strictEqual(free.holdLeft, 123);
});

test('settings: Block size reaches 1280 and stops there', () => {
  assert.strictEqual(W.RANGES.colWidth.max, 1280);
  assert.strictEqual(W.cfgFrom({ v: 2, colWidth: 1280 }).colWidth, 1280);
  assert.strictEqual(W.cfgFrom({ v: 2, colWidth: 1000 }).colWidth, 1000, 'above the old 960 cap is kept');
  assert.strictEqual(W.cfgFrom({ v: 2, colWidth: 5000 }).colWidth, 1280);
  assert.strictEqual(W.cfgFrom({ blockSize: 800 }).colWidth, 1200, 'a first-Wall row height follows the new cap');
  assert.strictEqual(W.cfgFrom({ blockSize: 2000 }).colWidth, 1280);
});

test('scroll: mostly in view = at least 66% of min(block, board) on the board', () => {
  assert.strictEqual(W.MOSTLY, 0.66);
  const H = 1000;
  // A 300 px block fully on the board, then leaving the top.
  assert.strictEqual(W.visibleFrac(100, 300, 0, H), 1);
  assert.ok(W.mostlyInView(100, 300, 0, H));
  assert.ok(W.mostlyInView(-102, 300, 0, H), '198 px of 300 (66%) still shows at the top');
  assert.ok(!W.mostlyInView(-110, 300, 0, H), '190 px of 300 is not enough');
  // Entering at the bottom.
  assert.ok(W.mostlyInView(H - 198, 300, 0, H));
  assert.ok(!W.mostlyInView(H - 150, 300, 0, H));
  // Off the board either way.
  assert.strictEqual(W.visibleFrac(-400, 300, 0, H), 0);
  assert.strictEqual(W.visibleFrac(H + 10, 300, 0, H), 0);
  assert.ok(!W.mostlyInView(H, 300, 0, H));
  // The board's offset moves with the drift.
  assert.ok(W.mostlyInView(5000, 300, 4900, H));
  assert.ok(!W.mostlyInView(4700, 300, 4900, H));
  // A block taller than the board counts against the board's height.
  assert.strictEqual(W.visibleFrac(-200, 1500, 0, H), 1, 'it fills the whole board');
  assert.ok(W.mostlyInView(-200, 1500, 0, H));
  assert.ok(W.mostlyInView(-840, 1500, 0, H), '660 px of a 1000 px board');
  assert.ok(!W.mostlyInView(-900, 1500, 0, H));
  assert.ok(W.mostlyInView(H - 660, 1500, 0, H), 'its top part, entering');
  assert.strictEqual(W.visibleFrac(0, 0, 0, H), 0, 'no height, no view');
});

test('scroll: time left runs out when the block stops being mostly in view at the top', () => {
  const H = 1000, speed = 20;   // px per second
  // y 100, h 300: 66% of 300 is 198, so it is mostly in view until offset 202.
  assert.strictEqual(W.scrollLeftMs(100, 300, 0, H, speed), 202 / 20 * 1000);
  const offAt = 0 + W.scrollLeftMs(100, 300, 0, H, speed) / 1000 * speed;
  assert.ok(Math.abs(offAt - 202) < 1e-9);
  assert.ok(W.mostlyInView(100, 300, offAt, H));
  assert.ok(!W.mostlyInView(100, 300, offAt + 1, H));
  // Already past: negative.
  assert.ok(W.scrollLeftMs(100, 300, 300, H, speed) < 0);
  // A block taller than the board: 66% of the board, not of the block.
  assert.strictEqual(W.scrollLeftMs(0, 1500, 0, H, 10), (1500 - 660) / 10 * 1000);
  // A block lower down has more time left than one near the top.
  assert.ok(W.scrollLeftMs(600, 300, 0, H, speed) > W.scrollLeftMs(100, 300, 0, H, speed));
});

test('Scroll: only as many leaving clips stop as a clip needs, and none when that cannot help', () => {
  // Arrays from the VM: copy them into this realm before comparing.
  const plan = (...a) => { const v = W.scrollFreePlan(...a); return Array.isArray(v) ? [...v] : v; };
  const n = { cost: 1, remux: false };
  const r = { cost: 2, remux: true };
  // Fits already: nothing stops.
  assert.deepStrictEqual(plan(1, false, 1, true, [n, n]), []);
  // A native clip needs one slot: the soonest gone leaving clip stops.
  assert.deepStrictEqual(plan(1, false, 0, true, [n, n]), [0]);
  // A remux clip needs two: two natives stop, or the leaving remux alone.
  assert.deepStrictEqual(plan(2, true, 0, true, [n, n, n]), [0, 1]);
  assert.deepStrictEqual(plan(2, true, 0, false, [n, r]), [1]);
  // The remux slot is held by a clip that is staying: stopping others cannot help.
  assert.strictEqual(plan(2, true, 2, false, [n, n]), 'remux');
  // Not enough to free: nothing is stopped.
  assert.strictEqual(plan(2, true, 0, true, [n]), null);
  assert.strictEqual(plan(1, false, 0, true, []), null);
  // The leaving remux plus one free slot already covers a remux clip.
  assert.deepStrictEqual(plan(2, true, 1, false, [n, r]), [1]);
});

test('continue in the player: the clip time applies only to the same file, before it expires', () => {
  const p = { id: 7, time: 42.5, until: 1000 };
  assert.strictEqual(W.takeStart(p, 7, 999), 42.5);
  assert.strictEqual(W.takeStart(p, 7, 1000), 42.5, 'the last moment still counts');
  assert.strictEqual(W.takeStart(p, 7, 1001), null, 'expired');
  assert.strictEqual(W.takeStart(p, 8, 999), null, 'a different file opened');
  assert.strictEqual(W.takeStart(p, null, 999), null, 'no id (a mix, a stub)');
  assert.strictEqual(W.takeStart(null, 7, 999), null, 'nothing pending');
  assert.strictEqual(W.takeStart({ id: 7, time: 3 }, 7, 999), null, 'no expiry = never applies');
});
