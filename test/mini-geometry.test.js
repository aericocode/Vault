/**
 * The floating mini player's geometry (player-lib/player/mini-geometry.js):
 * the saved corner and width made safe, the corner a dropped box snaps to,
 * the width clamp (240 px to half the window, always fitting), the box in
 * its corner, and the shape-keeping resize from the grip.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'player', 'mini-geometry.js'), 'utf8');
  const ctx = { Math, Number, Object, Array };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__g = MiniGeom;`, ctx);
  return ctx.__g;
}

const G = load();

test('saved geometry: good values kept, rounded', () => {
  assert.deepStrictEqual({ ...G.geomFrom({ corner: 'tl', w: 333.6 }) }, { corner: 'tl', w: 334 });
  for (const c of ['tl', 'tr', 'bl', 'br']) assert.strictEqual(G.geomFrom({ corner: c, w: 400 }).corner, c);
});

test('saved geometry: anything broken falls back to bottom right, 480 wide', () => {
  for (const raw of [undefined, null, 'junk', 42, [], {}, { corner: 'middle', w: 'big' },
    { corner: 'br', w: NaN }, { corner: 'br', w: Infinity }, { corner: 'br', w: -5 }, { corner: 'br', w: 50 }, { corner: 'br', w: 1e6 }]) {
    const g = G.geomFrom(raw);
    assert.strictEqual(g.w, raw && typeof raw === 'object' && raw.w === 400 ? 400 : 480, JSON.stringify(raw));
    assert.ok(['tl', 'tr', 'bl', 'br'].includes(g.corner));
  }
  assert.strictEqual(G.geomFrom({ corner: 'middle', w: 400 }).corner, 'br');
  assert.strictEqual(G.geomFrom({ corner: 'tr', w: '400' }).w, 480, 'a string is not a width');
});

test('snap: the nearest corner by the box centre', () => {
  assert.strictEqual(G.nearestCorner(100, 100, 1600, 900), 'tl');
  assert.strictEqual(G.nearestCorner(1500, 100, 1600, 900), 'tr');
  assert.strictEqual(G.nearestCorner(100, 800, 1600, 900), 'bl');
  assert.strictEqual(G.nearestCorner(1500, 800, 1600, 900), 'br');
  // Exactly in the middle counts as bottom right, where the box starts.
  assert.strictEqual(G.nearestCorner(800, 450, 1600, 900), 'br');
});

test('clamp: between 240 px and half the window width', () => {
  assert.strictEqual(G.clampWidth(100, 16 / 9, 1600, 900), 240);
  assert.strictEqual(G.clampWidth(500, 16 / 9, 1600, 900), 500);
  assert.strictEqual(G.clampWidth(1200, 16 / 9, 1600, 900), 800);
});

test('clamp: a portrait box is at most half the window tall', () => {
  // 9:16 in 1600x900: half the height is 450 tall, so 253 wide.
  const w = G.clampWidth(800, 9 / 16, 1600, 900);
  assert.strictEqual(w, Math.round(450 * 9 / 16));
  assert.ok(w / (9 / 16) <= 450 + 1);
});

test('clamp: a landscape box in a short window is capped by height too', () => {
  // 16:9 in 1600x500: half the height is 250 tall, so 444 wide, not 800.
  assert.strictEqual(G.clampWidth(1200, 16 / 9, 1600, 500), Math.round(250 * 16 / 9));
});

test('clamp: the 240 px minimum is for the longer side', () => {
  // Portrait 9:16 shrunk all the way: 240 tall (135 wide), not 240 wide.
  const w = G.clampWidth(10, 9 / 16, 1600, 900);
  assert.strictEqual(w, 135);
  assert.strictEqual(Math.round(w / (9 / 16)), 240);
  // Landscape: 240 wide.
  assert.strictEqual(G.clampWidth(10, 16 / 9, 1600, 900), 240);
  // Square: 240 each way.
  assert.strictEqual(G.clampWidth(10, 1, 1600, 900), 240);
});

test('clamp: the box always fits the window less its margins', () => {
  for (const [a, vw, vh] of [[9 / 16, 1600, 300], [16 / 9, 300, 1600], [1, 260, 260], [21 / 9, 1920, 1080]]) {
    const w = G.clampWidth(5000, a, vw, vh);
    assert.ok(w <= vw - 2 * G.MARGIN + 0.5, `${a} ${vw}x${vh}: width ${w}`);
    assert.ok(w / a <= vh - 2 * G.MARGIN + 1, `${a} ${vw}x${vh}: height ${w / a}`);
  }
});

test('clamp: a window too small for 240 px gets what fits', () => {
  const w = G.clampWidth(480, 16 / 9, 200, 600);
  assert.strictEqual(w, 200 - 2 * G.MARGIN);
  assert.strictEqual(G.clampWidth(480, 16 / 9, 0, 0), 0);
});

test('clamp: a bad aspect or width is treated as 16:9 and 480', () => {
  assert.strictEqual(G.clampWidth(NaN, 0, 1600, 900), 480);
  assert.strictEqual(G.clampWidth(500, -1, 1600, 900), 500);
});

test('corner rect: each corner sits its margin in from both edges', () => {
  const vw = 1600, vh = 900, m = G.MARGIN;
  const tl = G.cornerRect('tl', 480, 16 / 9, vw, vh);
  assert.deepStrictEqual({ ...tl }, { left: m, top: m, width: 480, height: 270 });
  const br = G.cornerRect('br', 480, 16 / 9, vw, vh);
  assert.deepStrictEqual({ ...br }, { left: vw - 480 - m, top: vh - 270 - m, width: 480, height: 270 });
  const tr = G.cornerRect('tr', 480, 16 / 9, vw, vh);
  assert.strictEqual(tr.left, vw - 480 - m); assert.strictEqual(tr.top, m);
  const bl = G.cornerRect('bl', 480, 16 / 9, vw, vh);
  assert.strictEqual(bl.left, m); assert.strictEqual(bl.top, vh - 270 - m);
});

test('corner rect: a shrunk window pulls the box back in, still its shape', () => {
  const r = G.cornerRect('br', 900, 16 / 9, 1000, 600);
  assert.strictEqual(r.width, 500);                 // half the window
  assert.strictEqual(r.height, Math.round(500 / (16 / 9)));
  assert.ok(r.left >= 0 && r.left + r.width <= 1000);
  assert.ok(r.top >= 0 && r.top + r.height <= 600);
});

test('corner rect: an unknown corner is bottom right', () => {
  const a = G.cornerRect('zz', 480, 16 / 9, 1600, 900);
  const b = G.cornerRect('br', 480, 16 / 9, 1600, 900);
  assert.deepStrictEqual({ ...a }, { ...b });
});

test('aspect resize: pulling the grip away from the snapped corner grows the box', () => {
  // Snapped bottom right: the grip is top left, so left and up grow.
  assert.strictEqual(G.aspectResize(400, -50, 0, 'br', 16 / 9), 450);
  assert.strictEqual(G.aspectResize(400, 50, 0, 'br', 16 / 9), 350);
  // Snapped top left: the grip is bottom right, so right and down grow.
  assert.strictEqual(G.aspectResize(400, 50, 0, 'tl', 16 / 9), 450);
  // Snapped bottom left: right grows; snapped top right: left grows.
  assert.strictEqual(G.aspectResize(400, 30, 0, 'bl', 16 / 9), 430);
  assert.strictEqual(G.aspectResize(400, -30, 0, 'tr', 16 / 9), 430);
});

test('aspect resize: a vertical pull counts in width units, and the bigger pull wins', () => {
  // 18 px up on a 16:9 box snapped bottom right = 32 px wider.
  assert.strictEqual(G.aspectResize(400, 0, -18, 'br', 16 / 9), 432);
  // Down on a box snapped top right grows it.
  assert.strictEqual(G.aspectResize(400, 0, 18, 'tr', 16 / 9), 432);
  // A diagonal: the x pull (10) is smaller than the y pull (18 * 16/9 = 32).
  assert.strictEqual(G.aspectResize(400, -10, -18, 'br', 16 / 9), 432);
  // Not clamped here: clampWidth does that.
  assert.strictEqual(G.aspectResize(400, 1000, 0, 'br', 16 / 9), -600);
});

test('corner rect: never shorter than 150 px, any shape, and always fits', () => {
  const shapes = { '32:9': 32 / 9, '21:9': 21 / 9, '16:9': 16 / 9, '1:1': 1, '9:16': 9 / 16 };
  for (const [vw, vh] of [[1400, 850], [1920, 1080], [1000, 620]]) {
    for (const [name, a] of Object.entries(shapes)) {
      for (const w of [0, 240, 480, 99999]) {          // min, default, max
        const r = G.cornerRect('br', w, a, vw, vh);
        const tag = `${name} w=${w} in ${vw}x${vh}: ${r.width}x${r.height}`;
        assert.ok(r.height >= G.MIN_H, `${tag} too short`);
        assert.ok(r.left >= 0 && r.top >= 0, `${tag} off the top or left`);
        assert.ok(r.left + r.width <= vw - G.MARGIN, `${tag} past the right margin`);
        assert.ok(r.top + r.height <= vh - G.MARGIN, `${tag} past the bottom margin`);
        assert.ok(r.width <= vw / 2 + 0.5 && r.height <= Math.max(vh / 2, G.MIN_H) + 0.5, `${tag} over half the window`);
      }
    }
  }
  // 32:9 at the minimum width: letterboxed to 150 tall, not 68.
  assert.deepStrictEqual({ ...G.cornerRect('tl', 240, 32 / 9, 1400, 850) }, { left: 16, top: 16, width: 240, height: 150 });
  // A window too short for 150 gets what fits.
  assert.strictEqual(G.cornerRect('tl', 240, 32 / 9, 1400, 120).height, 120 - 2 * G.MARGIN);
});
