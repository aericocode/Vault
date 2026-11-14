/**
 * player-lib/wall.js (the Wall tab) in a VM: the pure pieces. Settings
 * (Wall 3.11 choices, and the migration of Round 2 and first-Wall blobs),
 * the Vertical plan (columns of different widths), the Grid fit (the board
 * ends exactly at the bottom edge), Scroll's 10% start and slot order, the
 * Videos Auto controller, Rotate sound (who is heard next, and when),
 * where a clip starts (clips play to the end), the 3-minute limit for
 * converted clips, the freeze watchdog, and the masonry plan: equal columns, exact shapes, files wider
 * than 2.5:1 spanning two columns, and a board that always reaches the
 * bottom edge whatever the shapes and sizes. Slices: full-width rows that
 * end flush, files at their exact shape, heights within the clamps.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWall() {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'player-lib', f), 'utf8');
  const ctx = { window: {}, document: {}, console, Math, Number, String, Array, Object, JSON, Map, Set, Promise };
  vm.createContext(ctx);
  // The settings rules load first, as in the page.
  vm.runInContext(`${read('wall-rules.js')}\n${read('wall.js')}\nglobalThis.__wall = Wall;`, ctx);
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

test('clips play to the end from a random point at least 30 s before it, so a fresh board\'s clips end apart', () => {
  assert.strictEqual(W.MIN_RUN_S, 30);
  assert.strictEqual(W.clipStart(0, 0.5), 0, 'no duration known: from the start');
  assert.strictEqual(W.clipStart(45, 0.9), 0, 'a short clip plays whole');
  assert.strictEqual(W.clipStart(60, 0.9), 0, 'up to twice the minimum run: whole');
  assert.strictEqual(W.clipStart(600, 0), 0);
  assert.strictEqual(W.clipStart(600, 0.5), 285);
  for (const dur of [61, 120, 3600]) {
    for (const r of [0, 0.3, 0.999999]) {
      const s = W.clipStart(dur, r);
      assert.ok(s >= 0 && dur - s >= W.MIN_RUN_S - 1e-9, `at least 30 s left (${dur}, ${r})`);
    }
  }
  // Different random draws give different end times for the same file.
  assert.notStrictEqual(600 - W.clipStart(600, 0.2), 600 - W.clipStart(600, 0.7));
});

test('grid clips: the first short clips on a fresh board start further in, one by one, so they do not all end together', () => {
  const shares = [5, 4, 3, 2, 1, 0, -1].map(left => W.staggerShare(left, 5));
  assert.deepStrictEqual(shares.map(r => +r.toFixed(3)), [1, 0.8, 0.6, 0.4, 0.2, 1, 1]);
  assert.strictEqual(W.staggerShare(3, 0), 1, 'never more than a whole clip');
  // Five 30 s clips started together end 6 s apart.
  const ends = shares.slice(0, 5).map(s => 30 - W.clipStart(30, 0.5, s));
  assert.deepStrictEqual(ends.map(e => +e.toFixed(3)), [30, 24, 18, 12, 6]);
  assert.strictEqual(W.clipStart(0, 0.5, 0.4), 0, 'no duration known: from the start');
  // A long clip already ends at a random time: its start ignores the share.
  assert.strictEqual(W.clipStart(600, 0.5, 0.2), W.clipStart(600, 0.5));
});

test('wall.js: a clip keeps its block until it ends, loops when Loop clips is on, and the next file comes in by advance', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'wall.js'), 'utf8');
  assert.match(src, /v\.loop = cfg\.loopClips;/, 'a new clip loops only with Loop clips on');
  assert.match(src, /addEventListener\('ended', \(\) => \{ if \(b\.video === rec\) setDue\(b, 0\); \}\)/, 'an ended clip is due at once');
  assert.match(src, /for \(const rec of liveRecs\(\)\) rec\.v\.loop = cfg\.loopClips;/, 'the checkbox reaches the clips playing now');
  assert.doesNotMatch(src, /clipMs|cfg\.clips/, 'no clip timer is left');
  assert.doesNotMatch(src, /wallShuffleBtn/, 'no Shuffle button in the bar');
  assert.match(src, /if \(cfg\.order !== 'shuffle' \|\| !poolIds/, 'Shuffle again never runs In order');
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
  // A fit shown next to the slot loses to any other fit, and to a crop of a file not next to it.
  const near = swapOpts({ onScreen: (r) => r.id !== 3, touching: (r) => r.id === 1 });
  assert.strictEqual(W.pickSwap([{ id: 1, a: 16 / 9 }, { id: 2, a: 1.7 }], 16 / 9, near).i, 1);
  assert.deepStrictEqual({ ...W.pickSwap([{ id: 1, a: 16 / 9 }, { id: 3, a: 1 }], 16 / 9, near) }, { i: 1, fit: false });
  assert.deepStrictEqual({ ...W.pickSwap([{ id: 1, a: 16 / 9 }], 16 / 9, near) }, { i: 0, fit: true }, 'no other choice');
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

/* Slices: full-width rows of different heights. */

/** A seeded random source, so a slice can be drawn again exactly. */
function seeded(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

const PXS = [360, 480, 720, 1080, 1440, 2160];

/** Fill a Slices plan the way the Wall does: whole slices until the bottom passes H. */
function fillSlices(Wd, H, blockSize, gap, o = {}) {
  const rnd = seeded(o.seed || 1);
  const plan = W.planSlices(Wd, blockSize, gap);
  const rows = [];
  let k = 0;
  while (W.minBottom(plan) < H && rows.length < 2000) {
    const n = o.queue != null ? o.queue : 24;
    const cands = [];
    for (let i = 0; i < n; i++, k++) {
      const shapes = o.shapes || SHAPES;
      cands.push({ a: shapes[k % shapes.length], px: PXS[(k * 7) % PXS.length] });
    }
    const row = W.sliceRow(cands, { W: Wd, base: plan.base, gap, variety: o.variety != null ? o.variety : 0.6, byRes: o.byRes !== false, rand: rnd,
      fitLeft: o.fit ? H - plan.bottom : undefined });
    const aspects = [...row.picks].map(i => cands[i].a);
    const slots = W.placeSlice(plan, aspects, row.h, Wd);
    rows.push({ row, aspects, slots: [...slots] });
  }
  return { plan, rows };
}

test('slices: every slice fills the width exactly, with no overlap', () => {
  for (const [Wd, H] of [[1280, 760], [1920, 1040], [3440, 1400], [500, 700]]) {
    for (const bs of [120, 260, 390, 640, 1280]) {
      for (const gap of [0, 4, 12]) {
        for (const shapes of [SHAPES, [4], [9 / 16], [0.25], [32 / 9, 1]]) {
          const { plan, rows } = fillSlices(Wd, H, bs, gap, { shapes });
          assert.ok(W.minBottom(plan) >= H, `full at ${Wd}x${H} block ${bs} gap ${gap}`);
          const all = [];
          for (const { slots } of rows) {
            assert.strictEqual(slots[0].x, 0, 'starts at the left edge');
            const last = slots[slots.length - 1];
            assert.ok(Math.abs(last.x + last.w - Wd) < 1e-6, `ends at the right edge (${last.x + last.w} vs ${Wd})`);
            for (let i = 1; i < slots.length; i++) {
              assert.ok(Math.abs(slots[i].x - (slots[i - 1].x + slots[i - 1].w + gap)) < 1e-6, 'one gap between neighbours');
            }
            all.push(...slots);
          }
          for (let i = 1; i < rows.length; i++) {
            const above = rows[i - 1].slots[0];
            assert.ok(Math.abs(rows[i].slots[0].y - (above.y + above.h + gap)) < 1e-6, 'one gap between slices');
          }
          for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length && all[j].y < all[i].y + all[i].h; j++) {
              const a = all[i], b = all[j];
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

test('slices: every file keeps its shape, and heights stay within the clamps', () => {
  for (const [Wd, bs, gap] of [[1920, 390, 4], [1280, 260, 0], [3440, 120, 12], [2560, 640, 4]]) {
    for (const variety of [0, 0.6, 1]) {
      const { plan, rows } = fillSlices(Wd, 20000, bs, gap, { variety, seed: Wd + bs });
      for (const { row, aspects, slots } of rows) {
        aspects.forEach((a, k) => {
          // The last slot is trimmed to the edge: only rounding can differ.
          assert.ok(Math.abs(Math.log((slots[k].w / slots[k].h) / a)) < 1e-6, 'shape kept');
        });
        assert.ok(row.h >= plan.base * W.SLICE_MIN - 1e-6, `not below the floor (${row.h} at base ${plan.base})`);
        assert.ok(row.h <= plan.base * W.SLICE_MAX + 1e-6, `not above the ceiling (${row.h} at base ${plan.base})`);
        assert.ok(row.target >= row.lo && row.target <= row.hi);
      }
    }
  }
});

test('slices: a very wide file', () => {
  // The base is capped on a narrow board so the widest shape the Wall uses
  // (4:1, aspectOf's clamp) still reaches the floor height on its own.
  const plan = W.planSlices(500, 1280, 4);
  assert.ok(plan.base < 1280, 'the base is capped on a narrow board');
  const row = W.sliceRow([{ a: 4, px: 1080 }], { W: 500, base: plan.base, gap: 4, variety: 0, byRes: true, rand: () => 0.5 });
  assert.deepStrictEqual([...row.picks], [0]);
  assert.strictEqual(row.h, 125, 'alone, flush: 500 px wide at 4:1');
  assert.ok(row.h >= row.lo - 1e-9);
  // Wider than the board at the floor (an uncapped base): with another file
  // to start on, the wide one waits for a later slice...
  const o = { W: 500, base: 400, gap: 4, variety: 0, byRes: false, rand: () => 0.5 };
  const row2 = W.sliceRow([{ a: 4, px: 1080 }, { a: 1, px: 1080 }], o);
  assert.strictEqual(row2.picks[0], 1);
  assert.ok(![...row2.picks].includes(0), 'too wide for this slice');
  // ...and with nothing else, it takes the slice alone at its own shape.
  const row3 = W.sliceRow([{ a: 4, px: 1080 }], o);
  assert.deepStrictEqual([...row3.picks], [0]);
  assert.strictEqual(row3.h, 125);
});

test('slices: a file never repeats in a slice; only a whole tiny source repeats, to stay full width', () => {
  const o1 = { W: 1920, base: 300, gap: 4, variety: 0, byRes: false, rand: () => 0.5 };
  const alone = W.sliceRow([{ a: 9 / 16, px: 1080 }], o1);
  assert.deepStrictEqual([...alone.picks], [0], 'out of files: the slice stops, too tall');
  assert.ok(alone.h > alone.hi);
  const row = W.sliceRow([{ a: 9 / 16, px: 1080 }], { ...o1, repeat: true });
  assert.ok(row.picks.length > 1, 'the one portrait file repeats');
  assert.ok(row.picks.every(i => i === 0));
  assert.ok(Math.abs(row.h * (9 / 16) * row.picks.length + 4 * (row.picks.length - 1) - 1920) < 1e-6, 'flush');
  assert.ok(row.h <= row.hi);
  assert.strictEqual(W.sliceRow([], { W: 1920, base: 300, gap: 4, variety: 0, byRes: false, rand: () => 0.5 }), null);
  // Grid: a tiny source still covers the board to the bottom edge.
  const { plan } = fillSlices(1920, 1080, 390, 4, { queue: 1, shapes: [16 / 9] });
  assert.ok(W.minBottom(plan) >= 1080);
});

/** A source of n files (id k, shape SHAPES[k % 10]) on a Slices board, built the way the Wall builds it. */
function wallSlices(Wd, H, bs, gap, n, o = {}) {
  const rnd = seeded(o.seed || 1);
  const plan = W.planSlices(Wd, bs, gap);
  const files = Array.from({ length: n }, (_, k) => ({ id: k, a: SHAPES[(k * 3 + (o.seed || 0)) % SHAPES.length] }));
  let cursor = 0;
  const ready = [];
  const blocks = [];
  const rows = [];
  while (W.minBottom(plan) < H && rows.length < 400) {
    // The buffer walks round a small source more than once, as fill() does.
    while (ready.length < (o.buffer || 40)) ready.push(files[cursor++ % n]);
    const { pool, repeat } = W.slicePool(ready.slice(0, 24), blocks, { known: () => true, W: Wd, max: 24, wrapped: cursor >= n });
    const draw = rnd();
    const cands = pool.map(p => ({ a: p.r.a, px: 1080 }));
    const opts = { W: Wd, base: plan.base, gap, variety: 0.6, byRes: false, rand: () => draw, repeat,
      fitLeft: o.fit ? H - plan.bottom : undefined };
    const row = W.sliceRow(cands, opts);
    const items = row.picks.map(k => pool[k].r);
    for (const k of new Set(row.picks)) if (pool[k].fromReady) ready.splice(ready.indexOf(pool[k].r), 1);
    const slots = W.placeSlice(plan, items.map(r => r.a), row.h, Wd);
    const placed = items.map((item, k) => ({ item, ...slots[k] }));
    rows.push({ row, items, placed, repeat, cands, opts });
    blocks.push(...placed);
  }
  return { plan, rows, blocks };
}

const BOARDS = [[1920, 1040, 120], [1920, 1040, 260], [1280, 760, 390], [3440, 1400, 120], [500, 700, 260]];

test('slices: no file twice in a slice unless the source has too few files to fill it', () => {
  for (const [Wd, H, bs] of BOARDS) {
    for (let n = 1; n <= 30; n++) {
      for (const buffer of [1, 5, 24, 40]) {
        for (const fit of [false, true]) {
          const { rows } = wallSlices(Wd, H, bs, 4, n, { buffer, fit, seed: n });
          for (const { row, items, repeat, cands, opts } of rows) {
            const ids = items.map(r => r.id);
            const label = `${Wd}x${H} block ${bs}, ${n} files, buffer ${buffer}${fit ? ', Grid' : ''}`;
            if (new Set(ids).size < ids.length) {
              // Only a whole small source repeats, and only when without a repeat the slice could not stop.
              assert.ok(repeat && n <= 24, `${label}: a repeat in [${ids}]`);
              const alone = W.sliceRow(cands, { ...opts, repeat: false });
              assert.ok(alone.h > alone.hi, `${label}: a repeat in [${ids}] though [${[...alone.picks]}] could stop`);
              assert.ok(alone.picks.length < ids.length);
            }
            // A tiny source repeats, but never side by side (unless it is one file).
            for (let k = 1; k < ids.length && n > 1; k++) assert.notStrictEqual(ids[k], ids[k - 1], `${label}: copies side by side [${ids}]`);
            assert.ok(row.picks.length >= 1);
          }
        }
      }
    }
  }
});

test('slices: a file is never in two touching blocks while the source has files enough', () => {
  const touching = (a, b) => a.y === b.y || (Math.abs(b.y - (a.y + a.h + 4)) < 1e-6
    && Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > -4.01);
  for (const [Wd, H, bs] of BOARDS) {
    for (const n of [6, 10, 13, 20, 30, 60]) {
      for (const fit of [false, true]) {
        const { rows } = wallSlices(Wd, H * 3, bs, 4, n, { fit, seed: n + bs });
        for (let i = 0; i < rows.length; i++) {
          const prev = i > 0 ? rows[i - 1].placed : [];
          const cur = rows[i].placed;
          // Enough files: more than this slice and the one above hold together.
          if (n < cur.length + prev.length) continue;
          for (let k = 0; k < cur.length; k++) {
            for (const other of [...prev, ...cur.slice(0, k)]) {
              assert.ok(!(other.item.id === cur[k].item.id && touching(other, cur[k])),
                `${Wd}x${H} block ${bs}, ${n} files, slice ${i}: file ${cur[k].item.id} touches its copy`);
            }
          }
        }
      }
    }
  }
});

test('slices: a small Grid board still ends exactly at the bottom edge', () => {
  for (const [Wd, H, bs] of BOARDS) {
    for (const n of [1, 2, 3, 5, 13, 30]) {
      const { plan, blocks } = wallSlices(Wd, H, bs, 4, n, { fit: true, seed: n });
      const fitted = W.fitGrid(plan, blocks, H, Wd);
      const bottom = Math.max(...fitted.map(s => s.y + s.h));
      assert.ok(Math.abs(bottom - H) < 1e-6, `${Wd}x${H} block ${bs}, ${n} files: ends at the edge (${bottom})`);
      assertNoOverlap(fitted);
    }
  }
});

test('slice pool: each file once; files of the slice above last, those on screen after fresh ones', () => {
  const f = (id) => ({ id, a: 16 / 9 });
  const shown = [
    { item: f(1), x: 0, y: 0, w: 100, h: 50 }, { item: f(2), x: 104, y: 0, w: 100, h: 50 },
    { item: f(3), x: 0, y: 54, w: 100, h: 50 }, { item: f(4), x: 104, y: 54, w: 100, h: 50 },
  ];
  const front = [f(3), f(5), f(5), f(1), f(6)];
  const { pool, repeat } = W.slicePool(front, shown, { known: () => true, W: 204, max: 24 });
  assert.deepStrictEqual([...pool.map(p => p.r.id)], [5, 6, 2, 1, 4, 3], 'fresh, then far on screen, then the slice above (right end first)');
  assert.deepStrictEqual([...pool.map(p => p.fromReady)], [true, true, false, true, false, true]);
  assert.strictEqual(repeat, false, 'the buffer has not been round the whole source yet');
  assert.strictEqual(W.slicePool(front, shown, { known: () => true, W: 204, max: 24, wrapped: true }).repeat, true,
    'every file there is: the slice may repeat');
  const big = W.slicePool(Array.from({ length: 30 }, (_, i) => f(100 + i)), shown, { known: () => true, W: 204, max: 24, wrapped: true });
  assert.strictEqual(big.pool.length, 24);
  assert.strictEqual(big.repeat, false);
});

test('slices: a high-resolution first file makes a taller slice than a low-resolution one', () => {
  const cands = (px) => [{ a: 16 / 9, px }, ...Array.from({ length: 23 }, () => ({ a: 16 / 9, px: 720 }))];
  let hiSum = 0, loSum = 0;
  for (let d = 0; d < 50; d++) {
    const draw = (px) => {
      const r = seeded(100 + d);
      return W.sliceRow(cands(px), { W: 1920, base: 300, gap: 4, variety: 0.6, byRes: true, rand: r });
    };
    const big = draw(2160), small = draw(360);
    assert.ok(big.target > small.target, 'the 4K file aims higher at the same draw');
    assert.ok(big.h >= small.h, `4K ${big.h} vs 360p ${small.h}`);
    hiSum += big.h;
    loSum += small.h;
  }
  assert.ok(hiSum > loSum * 1.3, 'clearly taller on average');
  // Turned off, resolution makes no difference.
  const off = (px) => W.sliceRow(cands(px), { W: 1920, base: 300, gap: 4, variety: 0.6, byRes: false, rand: seeded(7) });
  assert.strictEqual(off(2160).h, off(360).h);
});

test('slices: no height variety gives slices of about the same height', () => {
  const spread = (variety) => {
    const { plan, rows } = fillSlices(1920, 30000, 300, 4, { variety, byRes: false, seed: 3 });
    const logs = rows.map(r => Math.log(r.row.h / plan.base));
    if (variety === 0) {
      for (const r of rows) assert.strictEqual(r.row.target, plan.base, 'one target for every slice');
      for (const l of logs) assert.ok(Math.abs(l) < Math.log(1.6), `near the block size (${Math.exp(l)})`);
    }
    const mean = logs.reduce((s, l) => s + l, 0) / logs.length;
    return Math.sqrt(logs.reduce((s, l) => s + (l - mean) ** 2, 0) / logs.length);
  };
  assert.ok(spread(0) < spread(1) * 0.75, 'full variety spreads the heights much more');
});

/* ── Settings (Wall 3.11: short lists of choices) ─────────────────────── */

test('settings: defaults for an empty or broken blob', () => {
  for (const raw of [undefined, null, {}, 'junk', { v: 4, playing: 'x', layout: 'diagonal', mode: 'diagonal', source: 'drop table', soundEvery: 15, loopClips: 'yes', size: 3 }]) {
    const c = W.cfgFrom(raw);
    assert.strictEqual(c.v, 4);
    assert.strictEqual(c.mode, 'grid');
    assert.strictEqual(c.layout, 'horizontal');
    assert.strictEqual(c.size, 'medium');
    assert.strictEqual(c.variety, 'mixed');
    assert.strictEqual(c.pace, 'medium');
    assert.strictEqual(c.playing, 'auto');
    assert.strictEqual(c.sound, 'off');
    assert.strictEqual(c.soundEvery, 20);
    assert.strictEqual(c.loopClips, false);
    assert.strictEqual(c.source, 'library');
    assert.strictEqual(c.mix, 'both');
    assert.strictEqual(c.order, 'shuffle');
    assert.strictEqual(c.pauseOnHover, true);
    assert.strictEqual(c.directOnly, false);
    assert.strictEqual(c.keepPlaying2, true);
    for (const k of ['gap', 'colWidth', 'picSpeed', 'clipLen', 'clipsToEnd', 'clips', 'scrollSpeed', 'sliceVariety', 'sliceByRes']) {
      assert.ok(!(k in c), `${k} is gone`);
    }
  }
});

test('settings: every choice of this version is kept, and saving changes nothing', () => {
  const c = W.cfgFrom({ v: 4, mode: 'scroll', layout: 'vertical', size: 'large', variety: 'wild', pace: 'fast',
    playing: 8, sound: 'rotate', soundEvery: 'mix', mix: 'videos', order: 'order', source: 's:4',
    pauseOnHover: false, directOnly: true, loopClips: true, keepPlaying2: false });
  assert.deepStrictEqual({ ...c }, { v: 4, mode: 'scroll', layout: 'vertical', size: 'large', variety: 'wild', pace: 'fast',
    playing: 8, sound: 'rotate', soundEvery: 'mix', mix: 'videos', order: 'order', source: 's:4',
    pauseOnHover: false, directOnly: true, loopClips: true, keepPlaying2: false });
  assert.deepStrictEqual(W.cfgFrom(JSON.parse(JSON.stringify(c))), c);
  // Only real choices: no 5 videos, no 15 s rotation, no 'auto' sound in a new blob.
  assert.strictEqual(W.cfgFrom({ v: 4, playing: 5 }).playing, 'auto');
  assert.strictEqual(W.cfgFrom({ v: 4, sound: 'auto' }).sound, 'off');
  for (const n of [2, 3, 4, 6, 8, 10, 12]) assert.strictEqual(W.cfgFrom({ v: 4, playing: n }).playing, n);
  for (const e of [10, 20, 30, 60, 'mix']) assert.strictEqual(W.cfgFrom({ v: 4, soundEvery: e }).soundEvery, e);
  for (const e of [15, '20', 0, null, 'random']) assert.strictEqual(W.cfgFrom({ v: 4, soundEvery: e }).soundEvery, 20);
  assert.strictEqual(W.cfgFrom({ v: 4, playing: 1 }).playing, 2, 'one video is no longer a choice: two');
  assert.strictEqual(W.cfgFrom({ v: 4, loopClips: 1 }).loopClips, false, 'only a real true loops');
});

test('settings: a version 3 blob (the first chips) drops Clips, keeps the rest, and its Rotate is every 20 s', () => {
  const old = { v: 3, mode: 'grid', layout: 'vertical', size: 'small', variety: 'even', pace: 'slow',
    clips: 'whole', playing: 6, sound: 'rotate', mix: 'both', order: 'shuffle', source: 'c:2',
    pauseOnHover: true, directOnly: false, keepPlaying2: true };
  const c = W.cfgFrom(old);
  assert.strictEqual(c.v, 4);
  assert.ok(!('clips' in c), 'Clips is gone: clips always play to the end');
  assert.strictEqual(c.sound, 'rotate');
  assert.strictEqual(c.soundEvery, 20, 'Rotate was every 20 s');
  assert.strictEqual(c.loopClips, false, 'clips change to a new file, as before');
  assert.strictEqual(c.playing, 6, 'a v3 6 is a real pick (Auto existed then)');
  assert.deepStrictEqual([c.layout, c.size, c.variety, c.pace, c.source], ['vertical', 'small', 'even', 'slow', 'c:2']);
  assert.strictEqual(W.cfgFrom({ v: 3, sound: 'follow', clips: 15 }).sound, 'follow');
  assert.strictEqual(W.cfgFrom({ v: 3, playing: 1 }).playing, 2);
  for (const clips of [15, 30, 60, 'whole']) assert.ok(!('clips' in W.cfgFrom({ v: 3, clips })));
});

test('settings: the old Sound choices migrate (Auto becomes Follow, the hover checkbox On hover)', () => {
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'auto' }).sound, 'follow');
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'hover' }).sound, 'hover');
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'off', soundOnHover: true }).sound, 'off', 'the newer key wins');
  const on = W.cfgFrom({ v: 2, soundOnHover: true, mode: 'scroll' });
  assert.strictEqual(on.sound, 'hover');
  assert.ok(!('soundOnHover' in on), 'the old key is not carried forward');
  assert.strictEqual(W.cfgFrom({ v: 2, soundOnHover: 'yes' }).sound, 'off', 'only a real true counts');
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'loud' }).sound, 'off');
  assert.strictEqual(W.cfgFrom({ v: 2, pauseOnHover: false }).pauseOnHover, false);
  assert.strictEqual(W.cfgFrom({ v: 2, pauseOnHover: 0 }).pauseOnHover, true);
});

test('settings: Columns becomes Vertical, Slices Horizontal; a saved blob from before Layout keeps columns', () => {
  assert.strictEqual(W.cfgFrom({ v: 2, layout: 'columns' }).layout, 'vertical');
  assert.strictEqual(W.cfgFrom({ v: 2, layout: 'slices' }).layout, 'horizontal');
  assert.strictEqual(W.cfgFrom({ v: 2, mode: 'grid' }).layout, 'vertical', 'Round 2 had only columns');
  assert.strictEqual(W.cfgFrom({ playing: 9 }).layout, 'vertical', 'so did the first Wall');
  assert.strictEqual(W.cfgFrom({}).layout, 'horizontal', 'a new user gets the new default');
});

test('settings: Block size, Height variety, Pictures and Speed move to the nearest choice; Clips is dropped', () => {
  const size = (colWidth) => W.cfgFrom({ v: 2, colWidth }).size;
  assert.strictEqual(size(120), 'small');
  assert.strictEqual(size(300), 'small');
  assert.strictEqual(size(330), 'medium');
  assert.strictEqual(size(390), 'medium');
  assert.strictEqual(size(460), 'medium');
  assert.strictEqual(size(480), 'large');
  assert.strictEqual(size(1280), 'large');
  const variety = (sliceVariety) => W.cfgFrom({ v: 2, sliceVariety }).variety;
  assert.strictEqual(variety(0), 'even');
  assert.strictEqual(variety(35), 'even');
  assert.strictEqual(variety(40), 'mixed');
  assert.strictEqual(variety(60), 'mixed');
  assert.strictEqual(variety(85), 'wild');
  assert.strictEqual(variety(100), 'wild');
  // Pace comes from the mode that was in use: Pictures in Grid, Speed in Scroll.
  const grid = (picSpeed, scrollSpeed) => W.cfgFrom({ v: 2, mode: 'grid', picSpeed, scrollSpeed }).pace;
  assert.strictEqual(grid(60, 1), 'slow');
  assert.strictEqual(grid(20, 9), 'slow');
  assert.strictEqual(grid(15, 1), 'medium');
  assert.strictEqual(grid(13), 'medium');
  assert.strictEqual(grid(8, 1), 'fast', 'the old default 8 s is nearest 10 s');
  assert.strictEqual(grid(6), 'fast');
  assert.strictEqual(grid(2), 'fast');
  const scroll = (scrollSpeed, picSpeed) => W.cfgFrom({ v: 2, mode: 'scroll', scrollSpeed, picSpeed }).pace;
  assert.strictEqual(scroll(1, 2), 'slow');
  assert.strictEqual(scroll(2, 60), 'slow');
  assert.strictEqual(scroll(4, 60), 'medium', 'the old default speed 4 stays medium');
  assert.strictEqual(scroll(5), 'fast');
  assert.strictEqual(scroll(7), 'fast');
  assert.strictEqual(scroll(10), 'fast');
  assert.strictEqual(scroll(undefined, 4), 'fast', 'no speed saved: the pictures setting');
  // Clip length is dropped: clips always play to the end, and change to a new file.
  for (const o of [{ clipLen: 5 }, { clipLen: 120 }, { clipLen: 20, clipsToEnd: true }]) {
    const c = W.cfgFrom({ v: 2, ...o });
    assert.ok(!('clips' in c) && !('clipLen' in c) && !('clipsToEnd' in c));
    assert.strictEqual(c.loopClips, false);
  }
});

test('settings: Videos at once keeps a number the user picked; the old default becomes Auto', () => {
  const p = (playing) => W.cfgFrom({ v: 2, playing }).playing;
  assert.strictEqual(p(6), 'auto');
  assert.strictEqual(p(undefined), 'auto');
  assert.strictEqual(p('junk'), 'auto');
  assert.strictEqual(p(1), 2, 'one video is no longer a choice');
  assert.strictEqual(p(5), 6);
  assert.strictEqual(p(7), 8);
  assert.strictEqual(p(9), 10);
  assert.strictEqual(p(16), 12);
  assert.strictEqual(p('3'), 3, 'a numeric string still counts');
  assert.strictEqual(p(0), 2);
  assert.strictEqual(W.cfgFrom({ v: 2, sound: 'auto' }).soundEvery, 20);
});

test('settings: a first-Wall blob migrates and keeps its feel', () => {
  const old = { playing: 9, picSpeed: 13, clipLen: 35, blockSize: 300, gap: 7, mix: 'videos', order: 'order',
    source: 'c:12', soundOnHover: true, directOnly: true, barOpen: false };
  const c = W.cfgFrom(old);
  assert.strictEqual(c.playing, 10);
  assert.strictEqual(c.pace, 'medium', '13 s is nearest 15 s');
  assert.ok(!('clips' in c) && !('clipLen' in c));
  assert.strictEqual(c.size, 'medium', 'row height 300 was a column about 450 wide');
  assert.strictEqual(c.layout, 'vertical');
  assert.strictEqual(c.mix, 'videos');
  assert.strictEqual(c.order, 'order');
  assert.strictEqual(c.source, 'c:12');
  assert.strictEqual(c.sound, 'hover');
  assert.strictEqual(c.directOnly, true);
  assert.ok(!('blockSize' in c) && !('barOpen' in c) && !('gap' in c), 'old keys are not carried forward');
  assert.strictEqual(W.cfgFrom({ blockSize: 260 }).size, 'medium', 'the old default row height: Medium');
  assert.strictEqual(W.cfgFrom({ blockSize: true }).size, 'medium', 'blockSize: true is not a row height');
  assert.deepStrictEqual(W.cfgFrom(JSON.parse(JSON.stringify(c))), c, 'saving and loading again changes nothing');
});

/* ── Vertical: columns of different widths ───────────────────────────── */

test('vertical: columns of different widths exactly span the board, around the block size', () => {
  for (const [Wd, size] of [[1280, 390], [1920, 260], [3440, 560], [300, 560], [2560, 390]]) {
    for (const spread of [0, W.colSpread(15), W.colSpread(60), W.colSpread(100)]) {
      for (let seed = 1; seed < 20; seed++) {
        const p = W.planColumns(Wd, size, 0, { spread, rand: seeded(seed) });
        assert.strictEqual(p.cws.length, p.cols);
        assert.strictEqual(p.colX[0], 0);
        for (let c = 1; c < p.cols; c++) assert.ok(Math.abs(p.colX[c] - (p.colX[c - 1] + p.cws[c - 1])) < 1e-9, 'side by side');
        const right = p.colX[p.cols - 1] + p.cws[p.cols - 1];
        assert.strictEqual(right, Wd, 'the last column ends exactly at the edge');
        const lo = Math.min(...p.cws), hi = Math.max(...p.cws);
        if (spread === 0) assert.ok(hi - lo < 1e-9, 'no variety: equal widths');
        else if (p.cols > 1) assert.ok(hi / lo <= (1 + spread) / (1 - spread) + 1e-9, 'within the spread');
      }
    }
  }
  assert.ok(W.colSpread(60) > 0.4 && W.colSpread(60) < 0.5, 'Mixed: about 0.55x to 1.45x');
  assert.ok(W.colSpread(100) <= 0.6, 'Wild never makes a column narrower than 0.4x');
  // Different widths do happen.
  const p = W.planColumns(1920, 390, 0, { spread: W.colSpread(60), rand: seeded(3) });
  assert.ok(Math.max(...p.cws) / Math.min(...p.cws) > 1.2);
});

/** Fill a Vertical plan the way the Wall does (shortest column first), optionally fitted (Grid). */
function fillVertical(Wd, H, size, spread, shapes, o = {}) {
  const plan = W.planColumns(Wd, size, 0, { spread, rand: seeded(o.seed || 1) });
  if (o.grid) { plan.noSpan = true; plan.fitH = H; }
  const placed = [];
  let k = 0;
  while (W.minBottom(plan) < H && placed.length < 5000) {
    let a = shapes[k % shapes.length];
    if (o.grid) {
      // The Grid pick near the bottom: the best of the next few files (fitScore).
      let best = 0, bestScore = Infinity;
      for (let i = 0; i < 24; i++) {
        const ai = shapes[(k + i) % shapes.length];
        const s = W.slotFor(plan, ai);
        const sc = i * 0.01 + W.fitScore(s.h, H - s.y, s.w);
        if (sc < bestScore) { bestScore = sc; best = i; }
      }
      a = shapes[(k + best) % shapes.length];
      k += best;
    }
    k++;
    const s = W.slotFor(plan, a);
    W.placeSlot(plan, s);
    placed.push({ ...s, a });
  }
  return { plan, placed };
}

function assertNoOverlap(slots) {
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i], b = slots[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(ox > 0.01 && oy > 0.01), 'no overlap');
    }
  }
}

test('vertical: files keep their exact shape, never overlap, and fill past the bottom edge', () => {
  for (const [Wd, H] of [[1280, 760], [1920, 1040], [500, 700]]) {
    for (const spread of [0, W.colSpread(60), W.colSpread(100)]) {
      for (const shapes of [SHAPES, [9 / 16], [32 / 9, 1]]) {
        const { plan, placed } = fillVertical(Wd, H, 390, spread, shapes, { seed: Wd });
        assert.ok(W.minBottom(plan) >= H);
        for (const s of placed) {
          assert.ok(Math.abs(s.w / s.h - s.a) < 1e-9, 'shape kept exactly');
          assert.ok(s.x >= -1e-9 && s.x + s.w <= Wd + 1e-6, 'inside the width');
          const want = s.span === 2 ? plan.cws[s.col] + plan.cws[s.col + 1] : plan.cws[s.col];
          assert.ok(Math.abs(s.w - want) < 1e-9, 'as wide as its column (or two)');
        }
        assertNoOverlap(placed);
      }
    }
  }
});

/* ── Grid fits the screen ────────────────────────────────────────────── */

function assertFitted(fitted, Wd, H, label) {
  for (const s of fitted) {
    assert.ok(s.x >= -1e-6 && s.x + s.w <= Wd + 1e-6, `${label}: inside the width`);
    assert.ok(s.y >= -1e-6 && s.y + s.h <= H + 1e-6, `${label}: nothing below the bottom edge (${s.y + s.h} vs ${H})`);
    assert.ok(s.s > 0 && s.s <= 1 + 1e-12, `${label}: scaled down only`);
  }
  assertNoOverlap(fitted);
}

test('grid fit, horizontal: the board ends exactly at the bottom, rows centered, shapes kept', () => {
  const scales = [];
  for (const [Wd, H] of [[1280, 760], [1920, 1040], [3440, 1400], [500, 700], [1920, 300]]) {
    for (const bs of [260, 390, 560]) {
      for (const shapes of [SHAPES, [16 / 9], [9 / 16], [4], [32 / 9, 1]]) {
        for (const variety of [0.15, 0.6, 1]) {
          const { plan, rows } = fillSlices(Wd, H, bs, 0, { shapes, variety, seed: Wd + bs, fit: true });
          const slots = rows.flatMap(r => r.slots);
          const fitted = W.fitGrid(plan, slots, H, Wd);
          const label = `${Wd}x${H} block ${bs} variety ${variety}`;
          assertFitted(fitted, Wd, H, label);
          const bottom = Math.max(...fitted.map(s => s.y + s.h));
          assert.ok(Math.abs(bottom - H) < 1e-6, `${label}: ends at the edge (${bottom})`);
          const s = fitted[0].s;
          scales.push(s);
          for (const f of fitted) assert.ok(Math.abs(f.s - s) < 1e-12, 'one scale for every slice');
          fitted.forEach((f, i) => {
            assert.ok(Math.abs(Math.log((f.w / f.h) / (slots[i].w / slots[i].h))) < 1e-9, 'shape kept');
          });
          // Each slice is centered: equal bars left and right.
          for (const r of rows) {
            const idx = r.slots.map(sl => slots.indexOf(sl));
            const left = fitted[idx[0]].x;
            const right = Wd - (fitted[idx[idx.length - 1]].x + fitted[idx[idx.length - 1]].w);
            assert.ok(Math.abs(left - right) < 1e-6, 'centered');
          }
        }
      }
    }
  }
  scales.sort((a, b) => a - b);
  const median = scales[Math.floor(scales.length / 2)];
  assert.ok(median > 0.9, `usually only a small scale down (median ${median.toFixed(3)})`);
});

test('grid fit, vertical: each column ends exactly at the bottom, centered in its place, shapes kept', () => {
  const mixed = [];
  for (const [Wd, H] of [[1280, 760], [1920, 1040], [500, 700], [1920, 400]]) {
    for (const spread of [W.colSpread(15), W.colSpread(60), W.colSpread(100)]) {
      for (const shapes of [SHAPES, [16 / 9], [9 / 16], [4, 1]]) {
        const { plan, placed } = fillVertical(Wd, H, 390, spread, shapes, { grid: true, seed: H });
        assert.ok(placed.every(s => s.span === 1), 'no spanning in a fitted Grid');
        const fitted = W.fitGrid(plan, placed, H, Wd);
        const label = `${Wd}x${H} spread ${spread.toFixed(2)}`;
        assertFitted(fitted, Wd, H, label);
        for (let c = 0; c < plan.cols; c++) {
          const col = fitted.filter(s => s.col === c);
          if (!col.length) continue;
          const bottom = Math.max(...col.map(s => s.y + s.h));
          assert.ok(Math.abs(bottom - H) < 1e-6, `${label}: column ${c} ends at the edge (${bottom})`);
          const left = col[0].x - plan.colX[c];
          const right = plan.colX[c] + plan.cws[c] - (col[0].x + col[0].w);
          assert.ok(Math.abs(left - right) < 1e-6 && left >= -1e-9, 'centered in its place');
          if (shapes === SHAPES) mixed.push(col[0].s);
        }
        fitted.forEach((f, i) => {
          assert.ok(Math.abs(Math.log((f.w / f.h) / placed[i].a)) < 1e-9, 'shape kept');
        });
      }
    }
  }
  // A real library has many shapes to pick a last file from (a source of one shape cannot be helped).
  mixed.sort((a, b) => a - b);
  const median = mixed[Math.floor(mixed.length / 2)];
  assert.ok(median > 0.9, `usually only a small scale down (median ${median.toFixed(3)})`);
});

test('grid fit: the last Grid slice stays at or above the height left', () => {
  const o = { W: 1920, base: 390, gap: 0, variety: 0.6, byRes: true, rand: () => 0.5 };
  const cands = Array.from({ length: 24 }, (_, i) => ({ a: [16 / 9, 4 / 3, 9 / 16, 1][i % 4], px: 1080 }));
  for (const left of [180, 250, 390, 500, 700, 850]) {
    const row = W.sliceRow(cands, { ...o, fitLeft: left });
    if (left < row.lo) assert.ok(row.h >= row.lo - 1e-9, `left ${left}: a floor-height slice (${row.h})`);
    // At or above what is left, unless every way to stop is too tall or short of it: then the nearest short one.
    else assert.ok(row.h >= left - 1e-9 || (row.h >= left * 0.9 && row.picks.length > 1), `left ${left}: at the edge (${row.h})`);
  }
  // A slice before the last leaves room for a floor-height slice.
  const row = W.sliceRow(cands, { ...o, fitLeft: 1000 });
  assert.ok(row.target <= 1000 - row.lo + 1e-9);
});

/* ── Scroll: start at 10%, slots to the most in view ─────────────────── */

test('scroll: a clip may start at 10% in view, and is heard at 50%', () => {
  assert.strictEqual(W.START_FRAC, 0.1);
  assert.strictEqual(W.HEAR_FRAC, 0.5);
  const H = 1000;
  assert.strictEqual(W.visibleFrac(100, 300, 0, H), 1);
  // Entering at the bottom: 30 px of 300 is enough to start.
  assert.ok(W.inView(H - 30, 300, 0, H, W.START_FRAC));
  assert.ok(!W.inView(H - 20, 300, 0, H, W.START_FRAC));
  assert.ok(!W.inView(H - 30, 300, 0, H, W.HEAR_FRAC), 'not heard yet');
  assert.ok(W.inView(H - 150, 300, 0, H, W.HEAR_FRAC));
  // A block taller than the board counts against the board's height.
  assert.ok(W.inView(H - 100, 3000, 0, H, W.START_FRAC), '100 px of a 1000 px board');
  assert.ok(!W.inView(H - 90, 3000, 0, H, W.START_FRAC));
  assert.ok(!W.inView(H, 300, 0, H, W.START_FRAC), 'off the board');
  assert.ok(!W.inView(0, 0, 0, H, W.START_FRAC), 'no height, no view');
  // Time left for sound runs out at 50% at the top.
  assert.strictEqual(W.scrollLeftMs(100, 300, 0, H, 20), (400 - 150) / 20 * 1000);
  assert.strictEqual(W.scrollLeftMs(0, 1500, 0, H, 10), (1500 - 500) / 10 * 1000);
  assert.ok(W.scrollLeftMs(100, 300, 300, H, 20) < 0);
});

test('scroll: slots go to the clips most in view; one leaving the top gives its slot first', () => {
  const H = 1000;
  const top = 0;
  const mk = (id, y, h = 300, lastPlayedAt = 0) => ({ id, y, h, lastPlayedAt });
  const ids = (a) => [...a].map(b => b.id);
  // Ranking: most in view first; under 10% not at all.
  const cands = [mk('enter10', H - 40), mk('mid', 400), mk('enter50', H - 150), mk('below', H - 10), mk('topHalf', -150)];
  assert.deepStrictEqual(ids(W.scrollRank(cands, top, H)), ['mid', 'enter50', 'topHalf', 'enter10']);
  // A tie: entering beats leaving, then the one that waited longest.
  assert.deepStrictEqual(ids(W.scrollRank([mk('late', -150), mk('early', H - 150)], top, H)), ['early', 'late']);
  assert.deepStrictEqual(ids(W.scrollRank([mk('a', 100, 300, 50), mk('b', 500, 300, 10)], top, H)), ['b', 'a']);
  // Who gives a slot to a fully visible clip: leaving clips less in view, soonest gone first.
  const playing = [mk('leaving20', -240), mk('leaving60', -120), mk('gone', -320), mk('entering15', H - 45), mk('full', 300)];
  assert.deepStrictEqual(ids(W.leavingFor(mk('c', 400), playing, top, H)), ['gone', 'leaving20', 'leaving60']);
  // An entering clip keeps its slot even when it is barely in view.
  assert.ok(!ids(W.leavingFor(mk('c', 400), playing, top, H)).includes('entering15'));
  // A clip only half in view takes only from clips leaving with less in view.
  assert.deepStrictEqual(ids(W.leavingFor(mk('c', H - 150), playing, top, H)), ['gone', 'leaving20']);
  // The board's offset moves with the drift.
  assert.deepStrictEqual(ids(W.scrollRank([mk('x', 5300)], 5000, H)), ['x']);
});

/* ── Videos at once: Auto ────────────────────────────────────────────── */

test('auto videos: raises one at a time while smooth and blocks are waiting', () => {
  const st = { target: W.AUTO_START, holdUntil: 0 };
  assert.strictEqual(W.AUTO_START, 4);
  const smooth = { dropRate: 0.01, stalls: 0, hitchRate: 0, wanting: true };
  let s = W.autoStep(st, smooth, 1000);
  assert.strictEqual(s.target, 5);
  s = W.autoStep(s, smooth, 5000);
  assert.strictEqual(s.target, 6);
  // Nothing waiting for a slot: no reason to raise.
  assert.strictEqual(W.autoStep(s, { ...smooth, wanting: false }, 9000).target, 6);
  // No frames decoded (nothing playing yet) counts as smooth.
  assert.strictEqual(W.autoStep(s, { ...smooth, dropRate: null, hitchRate: null }, 9000).target, 7);
  // Between smooth and not smooth: stays.
  assert.strictEqual(W.autoStep(s, { ...smooth, dropRate: 0.03 }, 9000).target, 6);
  assert.strictEqual(W.autoStep(s, { ...smooth, stalls: 1 }, 9000).target, 6);
  // Never above the maximum.
  assert.strictEqual(W.autoStep({ target: W.AUTO_MAX, holdUntil: 0 }, smooth, 9000).target, W.AUTO_MAX);
  assert.strictEqual(W.AUTO_MAX, 12);
});

test('auto videos: lowers when playback stutters, holds off raising for a while, never below 2', () => {
  const bad = [{ dropRate: 0.08, stalls: 0 }, { dropRate: 0, stalls: 2 }, { dropRate: 0, stalls: 0, hitchRate: 0.1 }];
  for (const b of bad) {
    const s = W.autoStep({ target: 6, holdUntil: 0 }, { ...b, wanting: true }, 10000);
    assert.strictEqual(s.target, 5);
    assert.strictEqual(s.holdUntil, 10000 + W.AUTO_HOLD_MS);
  }
  assert.strictEqual(W.AUTO_HOLD_MS, 20000);
  // Hysteresis: smooth again, but no raise until the hold is over.
  const smooth = { dropRate: 0, stalls: 0, hitchRate: 0, wanting: true };
  let s = { target: 5, holdUntil: 30000 };
  s = W.autoStep(s, smooth, 14000);
  assert.strictEqual(s.target, 5);
  s = W.autoStep(s, smooth, 26000);
  assert.strictEqual(s.target, 5);
  s = W.autoStep(s, smooth, 30000);
  assert.strictEqual(s.target, 6, 'raises again once the hold is over');
  // A run of bad windows walks down to the minimum and stays there.
  let t = { target: 12, holdUntil: 0 };
  for (let i = 0; i < 20; i++) t = W.autoStep(t, { dropRate: 0.5, stalls: 3, wanting: true }, i * 4000);
  assert.strictEqual(t.target, W.AUTO_MIN);
  assert.strictEqual(W.AUTO_MIN, 2);
});

/* ── Sound: Rotate ───────────────────────────────────────────────────── */

test('rotate sound: moves to another playing clip with sound and time left; none, it stays', () => {
  const cands = [clip('a', 9000, 1), clip('b', 4000, 2), clip('c', 12000, 3)];
  assert.strictEqual(W.rotatePick(cands, 'c'), 'a', 'the most time left of the others');
  assert.strictEqual(W.rotatePick(cands, 'a'), 'c');
  assert.strictEqual(W.rotatePick([clip('a', 5000, 1)], 'a'), 'a', 'no other clip: it stays');
  assert.strictEqual(W.rotatePick([clip('a', 5000, 1), clip('b', -100, 2)], 'a'), 'a', 'never to a clip about to stop');
  assert.strictEqual(W.rotatePick([clip('a', 5000, 1), clip('b', 3000, 5), clip('c', 3000, 9)], 'a'), 'c', 'a tie goes to the most recent start');
  // With a minimum: never to a clip about to stop or leave, even with nothing better.
  const min = W.ROTATE_MIN_LEFT_MS;
  assert.strictEqual(min, 5000);
  assert.strictEqual(W.rotatePick([clip('a', 9000, 1), clip('b', min, 2)], 'a', min), 'a', 'exactly the minimum is not enough');
  assert.strictEqual(W.rotatePick([clip('a', 9000, 1), clip('b', min + 1, 2)], 'a', min), 'b');
  assert.strictEqual(W.rotatePick([clip('a', 900, 1), clip('b', 2000, 2), clip('c', Infinity, 3)], 'a', min), 'c', 'a looping clip has all the time in the world');
  // The sound goes round: the clip not heard for longest first (never heard: first of all).
  const h = (key, left, startedAt, heardAt) => ({ key, left, startedAt, heardAt });
  const loops = [h('a', Infinity, 1, 500), h('b', Infinity, 2, 300), h('c', Infinity, 3, 0)];
  assert.strictEqual(W.rotatePick(loops, 'a', min), 'c', 'never heard yet');
  loops[2].heardAt = 600;
  assert.strictEqual(W.rotatePick(loops, 'c', min), 'b', 'then the one heard longest ago, not back to a');
  assert.strictEqual(W.rotatePick([h('a', 9000, 1, 0), h('b', 2000, 2, 0)], 'c', min), 'a', 'a tie on hearing goes to the most time left');
  assert.strictEqual(W.rotatePick([h('a', 9000, 1, 900), h('b', 3000, 2, 0)], 'c', 4000), 'a', 'about to stop: skipped even if never heard');
});

test('rotate sound: how long a clip is heard (10, 20, 30, 60 s, or a fresh 10 to 40 s for Mix it up)', () => {
  for (const n of [10, 20, 30, 60]) {
    assert.strictEqual(W.rotateWaitMs(n, 0), n * 1000);
    assert.strictEqual(W.rotateWaitMs(n, 0.99), n * 1000, 'a fixed wait ignores the draw');
  }
  assert.strictEqual(W.rotateWaitMs('mix', 0), 10000, 'Mix it up: never under 10 s');
  assert.strictEqual(W.rotateWaitMs('mix', 0.5), 25000);
  assert.ok(W.rotateWaitMs('mix', 0.999999) < 40000, 'and under 40 s');
  assert.strictEqual(W.rotateWaitMs('mix', 7), 40000, 'a draw out of range is clamped');
  assert.strictEqual(W.rotateWaitMs('mix', -1), 10000);
  const r = seeded(7);
  const waits = Array.from({ length: 500 }, () => W.rotateWaitMs('mix', r()));
  assert.ok(waits.every(w => w >= 10000 && w <= 40000), 'every Mix it up wait is 10 to 40 s');
  assert.ok(Math.min(...waits) < 13000 && Math.max(...waits) > 37000, 'spread over the whole range');
  assert.ok(new Set(waits).size > 400, 'a fresh wait each time');
  assert.strictEqual(W.rotateWaitMs(undefined, 0), 20000, 'no choice: 20 s');
});

test('rotate sound: the move falls due after the wait, never while settling or while the heard clip is held', () => {
  const due = (o) => W.rotateDue({ t: 30000, since: 10000, wait: 20000, ...o });
  assert.strictEqual(due({}), true, 'exactly the wait');
  assert.strictEqual(due({ t: 29999 }), false, 'not before');
  assert.strictEqual(due({ t: 45000 }), true, 'a move that could not happen yet stays due');
  assert.strictEqual(due({ settling: true }), false, 'a Follow handover settles first');
  assert.strictEqual(due({ held: true }), false, 'hovered with Pause on hover: it waits');
  assert.strictEqual(due({ held: true, t: 90000 }), false, 'for as long as the hover lasts');
  assert.strictEqual(due({ wait: 0 }), false, 'no wait drawn yet: nothing due');
  // A Mix it up wait decides when it is due.
  const wait = W.rotateWaitMs('mix', 0.25);
  assert.strictEqual(W.rotateDue({ t: 1000 + wait - 1, since: 1000, wait }), false);
  assert.strictEqual(W.rotateDue({ t: 1000 + wait, since: 1000, wait }), true);
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

/* Converted (remux) clips: at most 3 minutes on the wall. */

test('converted clips: a remux clip gives up its block 3 minutes after it started; direct clips never', () => {
  assert.strictEqual(W.REMUX_MAX_RUN_MS, 180000);
  assert.strictEqual(W.clipDue('remux', 1000), 181000);
  assert.strictEqual(W.clipDue('native', 1000), Infinity, 'a direct clip plays to its end');
  assert.strictEqual(W.clipDue('remux', 0), Infinity, 'not started yet: the load deadline applies, not the run limit');
  assert.strictEqual(W.clipDue(null, 1000), Infinity);
});

test('converted clips: time left is the rest of the 3 minutes, so the sound hands over before it stops', () => {
  const started = 5000;
  const t = started + 170000;
  // The block's swap time for a remux clip is clipDue; a long file has more media left.
  const left = W.clipLeft({ dueIn: W.clipDue('remux', started) - t, mediaLeft: 600000 });
  assert.strictEqual(left, 10000);
  // Looping (no media end): the run limit still ends it.
  assert.strictEqual(W.clipLeft({ dueIn: W.clipDue('remux', started) - t, mediaLeft: Infinity }), 10000);
  // A short file ends first.
  assert.strictEqual(W.clipLeft({ dueIn: W.clipDue('remux', started) - t, mediaLeft: 4000 }), 4000);
  // A direct clip: only the file's end (or for good while it loops).
  assert.strictEqual(W.clipLeft({ dueIn: W.clipDue('native', started) - t, mediaLeft: 4000 }), 4000);
  assert.strictEqual(W.clipLeft({ dueIn: W.clipDue('native', started) - t }), Infinity);
  // Scroll: leaving the board can come first.
  assert.strictEqual(W.clipLeft({ dueIn: 10000, leaveIn: 3000 }), 3000);
  // Held by Pause on hover: at least 1.5 s again once the mouse leaves.
  assert.strictEqual(W.clipLeft({ dueIn: -500, held: true, holdLeft: -500 }), 1500);
  assert.strictEqual(W.clipLeft({ dueIn: 9000, held: true, holdLeft: 9000 }), 9000);
  assert.strictEqual(W.clipLeft({ mediaLeft: NaN }), Infinity);
});

/* The freeze watchdog. */

test('freeze watchdog: a clip is expected to move only on a running wall, started, not ended, not held', () => {
  const on = { running: true, started: true };
  assert.strictEqual(W.shouldAdvance(on), true);
  assert.strictEqual(W.shouldAdvance({ ...on, running: false }), false, 'the wall is paused');
  assert.strictEqual(W.shouldAdvance({ ...on, started: false }), false, 'still loading: the load deadline applies');
  assert.strictEqual(W.shouldAdvance({ ...on, ended: true }), false);
  assert.strictEqual(W.shouldAdvance({ ...on, held: true }), false, 'Pause on hover');
});

test('freeze watchdog: a hidden page alone never makes a clip look stuck', () => {
  const hid = { running: true, started: true, hidden: true };
  assert.strictEqual(W.shouldAdvance({ ...hid, keepPlaying: true, othersMoving: false }), false, 'nothing moves: the browser holds media back');
  assert.strictEqual(W.shouldAdvance({ ...hid, keepPlaying: true, othersMoving: true }), true, 'other clips play, this one does not');
  assert.strictEqual(W.shouldAdvance({ ...hid, keepPlaying: false, othersMoving: true }), false);
});

test('freeze watchdog: 8 s standing still while it should move frees the clip', () => {
  assert.strictEqual(W.FREEZE_MS, 8000);
  let still = 0;
  let frozen = false;
  let ticks = 0;
  while (!frozen && ticks < 100) {
    ({ still, frozen } = W.freezeStep(still, { moved: false, should: true, dt: 250 }));
    ticks++;
  }
  assert.strictEqual(ticks, 32, '8 s of 250 ms ticks');
  // Moving starts the count over.
  let s = W.freezeStep(7900, { moved: true, should: true, dt: 250 });
  assert.deepStrictEqual({ ...s }, { still: 0, frozen: false });
  // Time it was not expected to move starts the count over too.
  s = W.freezeStep(7900, { moved: false, should: false, dt: 250 });
  assert.deepStrictEqual({ ...s }, { still: 0, frozen: false });
  // One late tick (a throttled timer, a sleeping laptop) counts at most 1 s.
  s = W.freezeStep(0, { moved: false, should: true, dt: 60000 });
  assert.strictEqual(s.still, W.FREEZE_DT_MAX_MS);
  assert.strictEqual(s.frozen, false);
  s = W.freezeStep(7000, { moved: false, should: true, dt: 60000 });
  assert.strictEqual(s.frozen, true);
  // A clock that went back adds nothing.
  assert.strictEqual(W.freezeStep(100, { moved: false, should: true, dt: -5000 }).still, 100);
});
