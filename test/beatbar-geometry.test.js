/**
 * The Modern beat bar's geometry (player-lib/beatbar-geometry.js): the saved
 * width made safe, the symmetric width drag from the grip, the lane timing
 * (px per second fixed by Speed, so a wider lane shows more time), the lane's
 * box over the video, the vertical drag, and where the settings panel opens.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'beatbar-geometry.js'), 'utf8');
  const ctx = { Math, Number, Object, Array };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__g = BeatBarGeom;`, ctx);
  return ctx.__g;
}

const G = load();
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('width: good values kept, out of range clamped, junk falls back to 56%', () => {
  assert.strictEqual(G.clampWidthFrac(0.7), 0.7);
  assert.strictEqual(G.clampWidthFrac(0.1), 0.30);
  assert.strictEqual(G.clampWidthFrac(2), 0.96);
  for (const v of [undefined, null, NaN, Infinity, '0.7', {}, []]) assert.strictEqual(G.clampWidthFrac(v), 0.56, String(v));
});

test('grip drag: away from the centre (left) widens, toward it narrows, both sides move', () => {
  // 1000 px video, 56% = 560 px. Dragging the left grip 50 px left moves the
  // left edge 50 px out, and the right edge mirrors it: +100 px in total.
  assert.ok(near(G.widthAfterGripDrag(0.56, -50, 1000), 0.66));
  assert.ok(near(G.widthAfterGripDrag(0.56, 50, 1000), 0.46));
  assert.strictEqual(G.widthAfterGripDrag(0.56, 0, 1000), 0.56);
});

test('grip drag: stays inside 30%..96% and ignores broken input', () => {
  assert.strictEqual(G.widthAfterGripDrag(0.56, -5000, 1000), 0.96);
  assert.strictEqual(G.widthAfterGripDrag(0.56, 5000, 1000), 0.30);
  assert.strictEqual(G.widthAfterGripDrag(null, -50, 1000), G.widthAfterGripDrag(0.56, -50, 1000));
  assert.strictEqual(G.widthAfterGripDrag(0.6, NaN, 1000), 0.6);
  assert.strictEqual(G.widthAfterGripDrag(0.6, -50, 0), 0.6);
});

test('timing: at the default width the lane shows the Speed lookahead, like Classic', () => {
  const t = G.laneTiming({ laneW: 560, refW: 1000, playheadFrac: 0.5, baseLookahead: 5 });
  assert.ok(near(t.lookahead, 5));
  assert.ok(near(t.lookbehind, 5));
  assert.strictEqual(t.playheadX, 280);
  assert.ok(near(t.pxPerSec, 280 / 5));
});

test('timing: px per second stay fixed as the lane widens, so lookahead grows with width', () => {
  const at = (laneW) => G.laneTiming({ laneW, refW: 1000, playheadFrac: 0.25, baseLookahead: 4 });
  const narrow = at(300), def = at(560), wide = at(960);
  assert.ok(near(narrow.pxPerSec, def.pxPerSec));
  assert.ok(near(wide.pxPerSec, def.pxPerSec));
  assert.ok(near(wide.lookahead / def.lookahead, 960 / 560));
  assert.ok(near(narrow.lookahead / def.lookahead, 300 / 560));
  // and what is drawn matches: the right edge is exactly `lookahead` seconds ahead
  for (const t of [narrow, def, wide]) assert.ok(near(t.playheadX + t.lookahead * t.pxPerSec, t.playheadX / 0.25));
});

test('timing: behind the playhead scales with the playhead spot', () => {
  const q = G.laneTiming({ laneW: 560, refW: 1000, playheadFrac: 0.25, baseLookahead: 6 });
  assert.ok(near(q.lookbehind, 2));
  const l = G.laneTiming({ laneW: 560, refW: 1000, playheadFrac: 0.1, baseLookahead: 9 });
  assert.ok(near(l.lookbehind, 1));
});

test('timing: Speed still sets px per second (faster = more px per second)', () => {
  const slow = G.laneTiming({ laneW: 560, refW: 1000, playheadFrac: 0.5, baseLookahead: 10 });
  const fast = G.laneTiming({ laneW: 560, refW: 1000, playheadFrac: 0.5, baseLookahead: 2 });
  assert.ok(near(fast.pxPerSec / slow.pxPerSec, 5));
});

test('timing: same Speed shows the same seconds at the same width fraction on any screen size', () => {
  const small = G.laneTiming({ laneW: 0.7 * 800, refW: 800, playheadFrac: 0.5, baseLookahead: 5 });
  const big = G.laneTiming({ laneW: 0.7 * 1920, refW: 1920, playheadFrac: 0.5, baseLookahead: 5 });
  assert.ok(near(small.lookahead, big.lookahead));
});

test('timing: broken input does not throw or produce NaN', () => {
  const t = G.laneTiming({ laneW: 0, refW: 0, playheadFrac: 7, baseLookahead: -1 });
  for (const k of ['playheadX', 'lookahead', 'lookbehind', 'pxPerSec']) assert.ok(Number.isFinite(t[k]), k);
});

test('lane box: centred on the video, width from widthFrac', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 600 };
  const b = G.laneBox({ rect, widthFrac: 0.5, posFrac: 0.5 });
  assert.strictEqual(b.width, 500);
  assert.strictEqual(b.left, 350);
  assert.strictEqual(b.left + b.width / 2, rect.left + rect.width / 2);
  assert.strictEqual(b.top, 50 + 300 - 34);
  assert.strictEqual(b.height, 68);
});

test('lane box: no saved spot sits above the dock; saved spots are clamped inside the video', () => {
  const rect = { left: 0, top: 0, width: 1000, height: 600 };
  assert.strictEqual(G.laneBox({ rect, widthFrac: null, posFrac: null }).top, 600 - 68 - 150);
  assert.strictEqual(G.laneBox({ rect, widthFrac: null, posFrac: null }).width, 560);
  assert.strictEqual(G.laneBox({ rect, widthFrac: 0.5, posFrac: 0 }).top, 4);
  assert.strictEqual(G.laneBox({ rect, widthFrac: 0.5, posFrac: 1 }).top, 600 - 68 - 4);
  // a video shorter than the lane: centred rather than flipping outside
  const tiny = G.laneBox({ rect: { left: 0, top: 0, width: 300, height: 40 }, widthFrac: 0.5, posFrac: 0.2 });
  assert.strictEqual(tiny.top, -14);
});

test('vertical drag: pointer y -> centre fraction, clamped', () => {
  const rect = { top: 100, height: 400 };
  assert.strictEqual(G.posFracFromPointer(300, rect), 0.5);
  assert.strictEqual(G.posFracFromPointer(0, rect), 0);
  assert.strictEqual(G.posFracFromPointer(900, rect), 1);
  assert.strictEqual(G.posFracFromPointer(300, { top: 0, height: 0 }), null);
});

test('panel: opens above its anchor, right edges aligned, bottom fixed so it grows upward', () => {
  const p = G.panelPlace({ anchor: { top: 600, bottom: 640, right: 1200 }, vw: 1400, vh: 900, panelW: 380 });
  assert.strictEqual(p.right, 200);
  assert.strictEqual(p.bottom, 900 - 600 + 10);
  assert.strictEqual(p.top, null);
  assert.strictEqual(p.maxHeight, 600 - 10 - 8);
});

test('panel: flips below when the bar is near the top, and never leaves the window sideways', () => {
  const p = G.panelPlace({ anchor: { top: 40, bottom: 104, right: 1390 }, vw: 1400, vh: 900, panelW: 380 });
  assert.strictEqual(p.bottom, null);
  assert.strictEqual(p.top, 114);
  assert.strictEqual(p.right, 10);
  // a tall panel that does not fit above but does below goes below
  const tall = G.panelPlace({ anchor: { top: 300, bottom: 364, right: 1000 }, vw: 1400, vh: 1000, panelH: 560, panelW: 380 });
  assert.strictEqual(tall.top, 374);
  // fits nowhere: the bigger side, scrolling inside it
  const cramped = G.panelPlace({ anchor: { top: 400, bottom: 464, right: 1000 }, vw: 1400, vh: 675, panelH: 700, panelW: 380 });
  assert.strictEqual(cramped.top, null);
  assert.strictEqual(cramped.maxHeight, 400 - 18);
  const crampedLow = G.panelPlace({ anchor: { top: 200, bottom: 264, right: 1000 }, vw: 1400, vh: 675, panelH: 700, panelW: 380 });
  assert.strictEqual(crampedLow.bottom, null);
  assert.strictEqual(crampedLow.maxHeight, 675 - 264 - 18);
  const left = G.panelPlace({ anchor: { top: 600, bottom: 640, right: 100 }, vw: 1400, vh: 900, panelW: 380 });
  assert.strictEqual(left.right, 1400 - 380 - 8);
});

/* ── Stored config shape: the released build must still read it ───────────
   The released beatbar.js loads { ...DEFAULT_CONFIG, ...raw } and its
   settings popover calls config.fillColor.toLowerCase() and
   config.borderColor.toLowerCase(), then reads the numbers as numbers. */

const CLASSIC = '#7aa8ff';
const RELEASED_DEFAULTS = {
  sensitivity: 2.0, speed: 7, playheadFrac: 0.5, posFrac: null, nudgeSec: 0,
  shape: 'circle', effects: { pulse: true, ripple: false, spark: false },
  fillColor: '#7aa8ff', fillSize: 9, fillOpacity: 1.0, borderColor: '#ffffff', borderWidth: 0,
};
// What this build keeps in memory before saving (never picked a colour, Modern width set)
const MEMORY = { ...RELEASED_DEFAULTS, fillColor: null, widthFrac: null, effects: { ...RELEASED_DEFAULTS.effects } };

function releasedRead(json) {
  const raw = JSON.parse(json);
  const cfg = { ...RELEASED_DEFAULTS, ...raw, effects: { ...RELEASED_DEFAULTS.effects, ...(raw.effects || {}) } };
  // the calls the released popover makes on open
  cfg.fillColor.toLowerCase();
  cfg.borderColor.toLowerCase();
  for (const k of ['sensitivity', 'speed', 'playheadFrac', 'nudgeSec', 'fillSize', 'fillOpacity', 'borderWidth']) {
    assert.strictEqual(typeof cfg[k], 'number', k);
  }
  assert.ok(cfg.posFrac === null || typeof cfg.posFrac === 'number');
  return cfg;
}

test('stored config: a never-picked colour is saved as the classic blue plus a flag, never null', () => {
  for (const mem of [MEMORY, { ...MEMORY, fillColor: undefined }, { ...MEMORY, fillColor: '' }]) {
    const json = JSON.stringify(G.storedConfig(mem, CLASSIC));
    const raw = JSON.parse(json);
    assert.strictEqual(raw.fillColor, CLASSIC);
    assert.strictEqual(raw.fillColorAuto, true);
    assert.strictEqual(releasedRead(json).fillColor, CLASSIC);
    assert.strictEqual(G.fillColorFromStored(raw, CLASSIC), null, 'reads back as "follow the look"');
  }
});

test('stored config: a picked colour is saved as is, with no flag, and reads back', () => {
  const json = JSON.stringify(G.storedConfig({ ...MEMORY, fillColor: '#ff4d6d', fillColorAuto: true }, CLASSIC));
  const raw = JSON.parse(json);
  assert.strictEqual(raw.fillColor, '#ff4d6d');
  assert.ok(!('fillColorAuto' in raw));
  assert.strictEqual(G.fillColorFromStored(raw, CLASSIC), '#ff4d6d');
  releasedRead(json);
});

test('stored config: every saved shape this build makes is safe for the released reader', () => {
  const variants = [
    MEMORY,
    { ...MEMORY, widthFrac: 0.7, posFrac: 0.4 },
    { ...MEMORY, widthFrac: NaN },
    { ...MEMORY, fillColor: '#a5b4fc', borderWidth: 1.5, borderColor: '#000000' },
  ];
  for (const v of variants) {
    const raw = JSON.parse(JSON.stringify(G.storedConfig(v, CLASSIC)));
    releasedRead(JSON.stringify(raw));
    assert.ok(raw.widthFrac === null || typeof raw.widthFrac === 'number');
  }
  // storedConfig does not change the in-memory config
  assert.strictEqual(MEMORY.fillColor, null);
});

test('stored config: reading what other builds left behind', () => {
  assert.strictEqual(G.fillColorFromStored({}, CLASSIC), null, 'no blob: follow the look');
  assert.strictEqual(G.fillColorFromStored({ fillColor: null }, CLASSIC), null, 'an earlier test build stored null');
  assert.strictEqual(G.fillColorFromStored({ fillColor: 42 }, CLASSIC), null);
  assert.strictEqual(G.fillColorFromStored({ fillColor: '#7aa8ff' }, CLASSIC), '#7aa8ff', 'a released build saved its blue: kept');
  // released build kept our flag but the user picked pink there: the pick wins
  assert.strictEqual(G.fillColorFromStored({ fillColor: '#ec4899', fillColorAuto: true }, CLASSIC), '#ec4899');
  assert.strictEqual(G.fillColorFromStored({ fillColor: '#7AA8FF', fillColorAuto: true }, CLASSIC), null);
});

/* ── Lane height: room for the icon and its effects at any Size ──────────── */

const FX = [
  {}, { pulse: true }, { ripple: true }, { spark: true },
  { pulse: true, ripple: true }, { pulse: true, spark: true }, { pulse: true, ripple: true, spark: true },
];
const SHAPES_ALL = ['circle', 'heart', 'square', 'diamond', 'star'];

test('lane height: the default look is 68 px', () => {
  assert.strictEqual(G.laneHeight({ fillSize: 9, shape: 'circle', effects: { pulse: true } }), 68);
  assert.strictEqual(G.laneHeight({}), 68);
  assert.strictEqual(G.laneHeight(null), 68);
});

test('lane height: the peak icon never clips and stays clear of the edge fade, at every size / shape / effect', () => {
  for (let size = 4; size <= 18; size++) {
    for (const shape of SHAPES_ALL) {
      for (const effects of FX) {
        for (const borderWidth of [0, 5]) {
          const cfg = { fillSize: size, shape, effects, borderWidth };
          const half = G.laneHeight(cfg) / 2;
          const baseR = size, pulseR = size + Math.max(8, size * 1.2);
          const sf = shape === 'star' || shape === 'heart' ? 1.12 : shape === 'diamond' ? 1.06 : 1;
          const peak = (effects.pulse ? pulseR : baseR) * sf + Math.max(0.5, borderWidth / 2);
          assert.ok(half - G.EDGE_FADE >= peak - 1e-9, size + " " + shape + " " + JSON.stringify(effects) + " border " + borderWidth);
        }
      }
    }
  }
});

test('lane height: room for only a share of the effects, so big ripples / sparks do not pad the lane', () => {
  for (let size = 4; size <= 18; size++) {
    for (const shape of SHAPES_ALL) {
      for (const effects of FX) {
        const cfg = { fillSize: size, shape, effects };
        const full = Math.ceil(2 * (G.effectExtent(cfg) + G.EDGE_FADE));
        assert.ok(G.laneHeight(cfg) <= Math.max(68, full), 'never more than the full reach');
      }
    }
  }
  // the Size 13 heart with everything on (the user's example) is well under its full reach
  const heart = { fillSize: 13, shape: 'heart', effects: { pulse: true, ripple: true, spark: true } };
  assert.ok(G.laneHeight(heart) <= 0.8 * Math.ceil(2 * G.effectExtent(heart) + 12), "about a quarter shorter than room for every tail");
});

test('lane height: grows with Size and with each effect, never shrinks below the default', () => {
  for (const effects of FX) {
    let prev = 0;
    for (let size = 4; size <= 18; size++) {
      const h = G.laneHeight({ fillSize: size, shape: 'star', effects });
      assert.ok(h >= prev && h >= 68, size + " " + JSON.stringify(effects));
      prev = h;
    }
  }
  const max = (fx) => G.laneHeight({ fillSize: 18, shape: 'star', effects: fx });
  assert.ok(max({ pulse: true, ripple: true }) > max({ pulse: true }));
  assert.ok(max({ pulse: true, ripple: true, spark: true }) > max({ pulse: true, ripple: true }));
  assert.ok(max({ pulse: true, ripple: true, spark: true }) <= 140, 'stays a lane, not a wall');
});

test('lane height change keeps a saved lane centred where it was', () => {
  const rect = { left: 0, top: 0, width: 1280, height: 720 };
  const a = G.laneBox({ rect, widthFrac: 0.56, posFrac: 0.5, laneH: 80 });
  const b = G.laneBox({ rect, widthFrac: 0.56, posFrac: 0.5, laneH: 128 });
  assert.strictEqual(a.top + a.height / 2, b.top + b.height / 2);
});

/* ── The picture's box inside the <video> (for the lane's blurred backdrop) ─ */

test('displayed video rect: contain letterboxes, cover crops, fill stretches', () => {
  const box = { left: 10, top: 20, width: 1000, height: 1000 };
  const close = (a, b) => Object.keys(b).forEach(k => assert.ok(Math.abs(a[k] - b[k]) < 1e-9, k));
  close(G.displayedVideoRect(box, 1920, 1080, 'contain'), { left: 10, top: 20 + 218.75, width: 1000, height: 562.5 });
  assert.deepStrictEqual({ ...G.displayedVideoRect(box, 1920, 1080, '') }, { ...G.displayedVideoRect(box, 1920, 1080, 'contain') });
  const cover = G.displayedVideoRect(box, 1920, 1080, 'cover');
  assert.strictEqual(cover.height, 1000);
  assert.ok(Math.abs(cover.width - 1777.777) < 0.01);
  assert.ok(Math.abs(cover.left - (10 - 388.888)) < 0.01);
  close(G.displayedVideoRect(box, 1920, 1080, 'fill'), { left: 10, top: 20, width: 1000, height: 1000 });
  assert.strictEqual(G.displayedVideoRect(box, 0, 0, 'contain'), null, 'no metadata yet');
});
