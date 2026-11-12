/**
 * The Stage window kept to the video's shape on Linux (lib/stage/window-fit.js).
 *
 * The pure part: the size a window should have for a video, from any size,
 * with no loops on rounding. The watcher: when it acts, when it waits, and
 * that it never fights a drag, a maximised window, a preset size or a size
 * the desktop would not give. Timers are fake; no mpv runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createWindowFit, fitSize, fitsAspect, stepSize, videoAspect, MIN_SIDE, AWAIT_MAX_MS, BUDGET, ECHO_STRIKES } = require('../lib/stage/window-fit');

const A169 = 16 / 9;
const A43 = 4 / 3;
const A916 = 9 / 16;
const A235 = 2.35;

/* ── The video's shape ──────────────────────────────────────────────────── */

test('videoAspect: display size, a quarter turn swaps it, no video is null', () => {
  assert.strictEqual(videoAspect({ w: 1440, h: 1080, dw: 1920, dh: 1080 }), A169, 'display size, not stored size (anamorphic)');
  assert.strictEqual(videoAspect({ dw: 1920, dh: 1080, rotate: 90 }), 1080 / 1920);
  assert.strictEqual(videoAspect({ dw: 1920, dh: 1080, rotate: 270 }), 1080 / 1920);
  assert.strictEqual(videoAspect({ dw: 1920, dh: 1080, rotate: 180 }), A169);
  assert.strictEqual(videoAspect({ dw: 1920, dh: 1080, rotate: -90 }), 1080 / 1920);
  for (const bad of [null, undefined, 'x', {}, { dw: 0, dh: 1080 }, { dw: 1920 }, { dw: NaN, dh: 1 }, { dw: Infinity, dh: 1 }]) {
    assert.strictEqual(videoAspect(bad), null, JSON.stringify(bad));
  }
});

test('fitsAspect: within a pixel, either way of rounding', () => {
  assert.ok(fitsAspect({ w: 1280, h: 720 }, A169));
  assert.ok(fitsAspect({ w: 1279, h: 719 }, A169));      // 1279 / 1.777 = 719.4
  assert.ok(fitsAspect({ w: 1281, h: 720 }, A169));      // one pixel: no bar to speak of, no new request
  assert.ok(!fitsAspect({ w: 1284, h: 720 }, A169));
  assert.ok(!fitsAspect({ w: 1280, h: 760 }, A169));
  assert.ok(!fitsAspect({ w: 1280, h: 720 }, A43));
  assert.ok(!fitsAspect(null, A169));
  assert.ok(!fitsAspect({ w: 1280, h: 720 }, 0));
});

/* ── The size it should have ────────────────────────────────────────────── */

test('fitSize: the side that was dragged leads, the other follows', () => {
  // Dragged wider from 1280x720: the width stays.
  assert.deepStrictEqual(fitSize({ win: { w: 1600, h: 720 }, aspect: A169, prev: { w: 1280, h: 720 } }), { w: 1600, h: 900 });
  // Dragged taller: the height stays.
  assert.deepStrictEqual(fitSize({ win: { w: 1280, h: 900 }, aspect: A169, prev: { w: 1280, h: 720 } }), { w: 1600, h: 900 });
  // Narrower and a little taller: the width changed more.
  assert.deepStrictEqual(fitSize({ win: { w: 960, h: 730 }, aspect: A169, prev: { w: 1280, h: 720 } }), { w: 960, h: 540 });
});

test('fitSize: a new video keeps about the same area, so shapes back and forth come back to the same size', () => {
  const a = fitSize({ win: { w: 1280, h: 720 }, aspect: A916, prev: { w: 1280, h: 720 } });
  assert.ok(fitsAspect(a, A916));
  assert.ok(Math.abs(a.w * a.h - 1280 * 720) / (1280 * 720) < 0.01, JSON.stringify(a));
  const back = fitSize({ win: a, aspect: A169, prev: a });
  assert.ok(Math.abs(back.w - 1280) <= 2 && Math.abs(back.h - 720) <= 2, JSON.stringify(back));
  // No size before: the same.
  const first = fitSize({ win: { w: 960, h: 540 }, aspect: A43 });
  assert.ok(fitsAspect(first, A43));
  assert.ok(Math.abs(first.w * first.h - 960 * 540) / (960 * 540) < 0.01);
});

test('fitSize: always whole pixels in the shape; doing it again changes nothing (no oscillation)', () => {
  const aspects = [A169, A43, A916, A235, 1, 1.85, 21 / 9, 3 / 2, 1080 / 1350, 1919 / 1079, 853 / 480];
  for (const aspect of aspects) {
    for (let w = 200; w <= 2600; w += 97) {
      for (let h = 200; h <= 1500; h += 89) {
        for (const prev of [null, { w: 1280, h: 720 }, { w, h: h + 50 }, { w: w + 50, h }]) {
          const t = fitSize({ win: { w, h }, aspect, prev });
          assert.ok(Number.isInteger(t.w) && Number.isInteger(t.h), JSON.stringify({ w, h, aspect, t }));
          assert.ok(fitsAspect(t, aspect), JSON.stringify({ w, h, aspect, t }));
          // From the size it asked for, it asks for nothing new.
          for (const p of [null, t, prev, { w, h }]) {
            assert.deepStrictEqual(fitSize({ win: t, aspect, prev: p }), t, JSON.stringify({ w, h, aspect, t, p }));
          }
        }
      }
    }
  }
});

test('fitSize: kept on the display and above the smallest size, still in shape', () => {
  const screen = { w: 1920, h: 1080 };
  // Dragged wide enough that the height would pass the screen.
  const t = fitSize({ win: { w: 1900, h: 900 }, aspect: A43, prev: { w: 1200, h: 900 }, screen });
  assert.ok(t.h <= Math.floor(1080 * 0.95) && t.w <= Math.floor(1920 * 0.95), JSON.stringify(t));
  assert.ok(fitsAspect(t, A43));
  // A tall video at the area of a wide window: kept on the screen.
  const p = fitSize({ win: { w: 1800, h: 1000 }, aspect: A916, screen });
  assert.ok(p.h <= Math.floor(1080 * 0.95) && fitsAspect(p, A916), JSON.stringify(p));
  // Tiny: at least MIN_SIDE on the short side.
  const s = fitSize({ win: { w: 50, h: 40 }, aspect: A169 });
  assert.ok(Math.min(s.w, s.h) >= MIN_SIDE - 1 && fitsAspect(s, A169), JSON.stringify(s));
  const tall = fitSize({ win: { w: 60, h: 200 }, aspect: A916, prev: { w: 60, h: 100 } });
  assert.ok(Math.min(tall.w, tall.h) >= MIN_SIDE - 1 && fitsAspect(tall, A916), JSON.stringify(tall));
  // Bad input: nothing.
  assert.strictEqual(fitSize({ win: null, aspect: A169 }), null);
  assert.strictEqual(fitSize({ win: { w: 100, h: 100 }, aspect: 0 }), null);
  assert.strictEqual(fitSize({ win: { w: 100, h: 100 }, aspect: NaN }), null);
});

test('stepSize: one wheel notch about 10% bigger or smaller, in the video shape (or the window shape with no video)', () => {
  const up = stepSize({ win: { w: 1280, h: 720 }, aspect: A169, dir: 1 });
  assert.deepStrictEqual(up, { w: 1408, h: 792 });
  const down = stepSize({ win: { w: 1280, h: 720 }, aspect: A169, dir: -1 });
  assert.ok(fitsAspect(down, A169) && down.w < 1280);
  const noVideo = stepSize({ win: { w: 800, h: 600 }, aspect: null, dir: 1 });
  assert.ok(fitsAspect(noVideo, A43));
  assert.strictEqual(stepSize({ win: null, aspect: A169, dir: 1 }), null);
});

/* ── The watcher ────────────────────────────────────────────────────────── */

/** A watcher on fake timers and a fake clock; `sets` collects the geometry it asks for. */
function rig({ screen = null, onSet = null } = {}) {
  let clock = 1_000_000;
  const timers = new Map();
  let nextId = 1;
  const sets = [];
  const settled = [];
  const fit = createWindowFit({
    setGeometry: (s) => { sets.push(`${s.w}x${s.h}`); if (onSet) onSet(s, clock); },
    getScreen: async () => screen,
    onSettled: (s) => settled.push(`${s.w}x${s.h}`),
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  async function advance(ms) {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) { timers.delete(id); t.fn(); }
    }
    await fit.idle();
    await new Promise((r) => setImmediate(r));
    await fit.idle();
  }
  const size = (w, h) => { fit.onProperty('osd-width', w); fit.onProperty('osd-height', h); };
  const video = (dw, dh, rotate = 0) => fit.onProperty('video-out-params', { dw, dh, rotate });
  return { fit, sets, settled, advance, size, video, pending: () => timers.size, now: () => clock };
}

test('watcher: off until Free size is on; then the first video sets the shape', async () => {
  const r = rig();
  r.size(960, 540);
  r.video(1440, 1080);                      // 4:3
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, [], 'not enabled yet (a preset, or not open)');
  r.fit.setEnabled(true);
  await r.advance(1000);
  assert.strictEqual(r.sets.length, 1);
  const [w, h] = r.sets[0].split('x').map(Number);
  assert.ok(fitsAspect({ w, h }, A43) && Math.abs(w * h - 960 * 540) / (960 * 540) < 0.01, r.sets[0]);
  // mpv answers with that size: accepted, nothing more.
  r.size(w, h);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets.length, 1);
  assert.deepStrictEqual(r.settled, [`${w}x${h}`]);
});

test('watcher: waits for a drag to stop, then follows the dragged side', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, ['1280x720'], 'in shape: only mpv geometry kept in step');
  // A drag of the right edge: many sizes, close together.
  for (let w = 1290; w <= 1600; w += 10) { r.size(w, 720); await r.advance(50); }
  assert.deepStrictEqual(r.sets, ['1280x720'], 'nothing while the drag goes on');
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, ['1280x720', '1600x900']);
});

test('watcher: a desktop that keeps the shape during the drag (aspect hint honoured): mpv geometry kept in step, nothing on screen moves', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  r.size(1600, 900);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, ['1280x720', '1600x900']);
  r.size(1600, 900);                        // no change: no event, nothing
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, ['1280x720', '1600x900']);
});

test('watcher: a desktop that will not give the size asked for: asked once more, then its answer stands (no loop)', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  r.size(1900, 720);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets.slice(-1), ['1900x1069']);
  // The desktop keeps it at 1900x1040 (a panel, say): asked once more.
  r.size(1900, 1040);
  await r.advance(600);
  assert.deepStrictEqual(r.sets, ['1280x720', '1900x1069', '1900x1069']);
  // Again 1900x1040 (here as a wobble through 1900x1039): accepted.
  r.size(1900, 1039);
  r.size(1900, 1040);
  await r.advance(600);
  await r.advance(5000);
  assert.deepStrictEqual(r.sets, ['1280x720', '1900x1069', '1900x1069']);
  assert.strictEqual(r.pending(), 0);
});

test('watcher: X11 order (new size, then the new shape hint): a request held to the old shape is sent once more and then fits', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  r.video(1440, 1080);                      // 4:3
  await r.advance(1000);
  const asked = r.sets[r.sets.length - 1];
  const [w, h] = asked.split('x').map(Number);
  assert.ok(fitsAspect({ w, h }, A43), asked);
  // The window manager held it to the old 16:9 hint: the height came, the width followed the old shape.
  r.size(Math.round(h * A169), h);
  await r.advance(600);
  assert.deepStrictEqual(r.sets.slice(-2), [asked, asked], 'the same request once more');
  // Now the hint is 4:3: it fits, and that is the end of it.
  r.size(w, h);
  await r.advance(5000);
  assert.deepStrictEqual(r.sets.slice(-2), [asked, asked]);
  assert.strictEqual(r.pending(), 0);
});

test('watcher: a desktop that rounds by a pixel, even late, never starts another resize', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1000, 700);
  await r.advance(1000);
  assert.strictEqual(r.sets.length, 1);
  const [w, h] = r.sets[0].split('x').map(Number);
  // Answers one pixel off, after the answer window (so they look like the user's own changes).
  for (const [dw, dh] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    r.size(w + dw, h + dh);
    await r.advance(2500);
    // Anything set now is only the window's own size (mpv geometry kept in step): nothing moves on screen.
    for (const s of r.sets.slice(1)) assert.ok(['-1', '0', '1'].includes(String(Number(s.split('x')[0]) - w)), s);
    // And only a few of them: a desktop that keeps answering with another size is no longer asked (ECHO_STRIKES).
    assert.ok(r.sets.length <= 1 + ECHO_STRIKES, r.sets.join(' '));
  }
});

test('watcher: the next file with another shape takes that shape at about the same area', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  r.video(1080, 1920);                      // a portrait video
  await r.advance(1000);
  const [w, h] = r.sets[r.sets.length - 1].split('x').map(Number);
  assert.ok(fitsAspect({ w, h }, A916) && Math.abs(w * h - 1280 * 720) / (1280 * 720) < 0.01, `${w}x${h}`);
  r.size(w, h);
  await r.advance(1000);
  // A rotated phone video (stored 1920x1080, turned 90): portrait too, nothing to do.
  const before = r.sets.length;
  r.video(1920, 1080, 90);
  await r.advance(1000);
  assert.strictEqual(r.sets.length, before);
});

test('watcher: nothing while maximised or full screen; back from it, it fits again', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  r.fit.onProperty('window-maximized', true);
  r.size(1920, 1050);
  await r.advance(1000);
  r.video(1440, 1080);
  await r.advance(1000);
  r.fit.onProperty('fullscreen', true);
  r.size(1920, 1080);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, ['1280x720']);
  r.fit.onProperty('fullscreen', false);
  r.fit.onProperty('window-maximized', false);
  r.size(1280, 720);                        // back to the size it had: now the wrong shape for the 4:3 video
  await r.advance(1000);
  const [w, h] = r.sets[r.sets.length - 1].split('x').map(Number);
  assert.ok(fitsAspect({ w, h }, A43), `${w}x${h}`);
});

test('watcher: audio only or nothing loaded: the window is left as it is', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.size(960, 540);
  r.fit.onProperty('video-out-params', null);
  await r.advance(1000);
  r.size(1000, 300);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, []);
});

test('watcher: a preset turns it off; Vault\'s own size request is taken as it comes back', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1440, 1080);
  r.size(960, 720);
  await r.advance(1000);
  r.fit.setEnabled(false);
  r.fit.noteGeometry({ w: 1920, h: 1080 });
  r.size(1920, 1080);                       // 16:9 window, 4:3 video: a preset keeps its bars
  await r.advance(5000);
  assert.deepStrictEqual(r.sets, ['960x720']);
  // Back to Free size: Vault asks for the old size, and that answer is accepted too.
  r.fit.noteGeometry({ w: 960, h: 720 });
  r.fit.setEnabled(true);
  r.size(960, 720);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, ['960x720']);
  assert.deepStrictEqual(r.fit.freeSize(), { w: 960, h: 720 });
});

test('watcher: the wheel steps the size in the video shape, only at Free size and not maximised', async () => {
  const r = rig({ screen: { w: 1920, h: 1080 } });
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.fit.step(1);
  assert.deepStrictEqual(r.sets, [], 'off at a preset');
  r.fit.setEnabled(true);
  await r.advance(1000);
  await r.fit.step(1);
  assert.deepStrictEqual(r.sets, ['1280x720', '1408x792']);
  r.size(1408, 792);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets.length, 2, 'the answer to the step is accepted');
  // Up to the screen and no further.
  for (let i = 0; i < 10; i++) {
    await r.fit.step(1);
    const [w, h] = r.sets[r.sets.length - 1].split('x').map(Number);
    r.size(w, h);
    await r.advance(1000);
  }
  const [w, h] = r.sets[r.sets.length - 1].split('x').map(Number);
  assert.ok(h <= Math.floor(1080 * 0.95) && fitsAspect({ w, h }, A169), `${w}x${h}`);
  r.fit.onProperty('window-maximized', true);
  const n = r.sets.length;
  await r.fit.step(-1);
  assert.strictEqual(r.sets.length, n, 'nothing while maximised');
});

test('watcher: stop() ends it: no timers left, nothing more asked', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1000, 1000);
  r.fit.stop();
  await r.advance(5000);
  assert.deepStrictEqual(r.sets, []);
  assert.strictEqual(r.pending(), 0);
});

/* ── Slow and stubborn desktops (verifier scenario) ─────────────────────── */

/**
 * A desktop that answers every geometry request late and with a steady
 * offset. 120 s of simulated time in 100 ms steps, after one drag by the user.
 */
async function slowDesktop({ delayMs, offset }) {
  const due = [];
  const r = rig({ screen: { w: 2560, h: 1440 }, onSet: (s, at) => due.push({ at: at + delayMs, w: s.w + offset, h: s.h }) });
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  r.size(1333, 720);                         // the user drags the right edge a little
  for (let t = 0; t < 120000; t += 100) {
    await r.advance(100);
    while (due.length && due[0].at <= r.now()) { const a = due.shift(); r.size(a.w, a.h); }
  }
  // Vault's requests after the user's drag (the first set is only the starting size kept in step).
  const widths = r.sets.slice(1).map((x) => Number(x.split('x')[0]));
  return { r, widths };
}

for (const delayMs of [1100, 1500, 3000]) {
  test(`watcher: a desktop answering in ${delayMs} ms with a steady +7 px: a bounded number of requests, no creep`, async () => {
    const { r, widths } = await slowDesktop({ delayMs, offset: 7 });
    assert.ok(r.sets.length <= 3, r.sets.join(' '));
    // (The late answer to the starting size may be fitted once as if it were a resize: still bounded.)
    assert.ok(Math.max(...widths) - Math.min(...widths) <= 60, r.sets.join(' '));
    assert.ok(Math.max(...widths) < 1400, r.sets.join(' '));
  });
}

test('watcher: a desktop that always adds 30 px (more than the slack): the budget stops it', async () => {
  for (const delayMs of [300, 1100, 3000]) {
    const { r, widths } = await slowDesktop({ delayMs, offset: 30 });
    assert.ok(r.sets.length <= BUDGET + 2, `${delayMs}: ${r.sets.join(' ')}`);
    assert.ok(Math.max(...widths) < 1333 + 30 * (BUDGET + 2), `${delayMs}: ${r.sets.join(' ')}`);
  }
});

test('watcher: a request the desktop never answers is given up after a while, so a later drag is fitted', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1280, 720);
  await r.advance(1000);
  r.size(1600, 720);
  await r.advance(1000);
  assert.deepStrictEqual(r.sets, ['1280x720', '1600x900']);
  await r.advance(AWAIT_MAX_MS + 1000);      // no answer at all
  r.size(1000, 900);                         // a later drag
  await r.advance(1000);
  assert.deepStrictEqual(r.sets.slice(-1), ['1000x563']);
});

/**
 * A desktop that answers every geometry request with a size in the video's
 * shape but not the one asked (a scale mismatch, a steady offset): the answer
 * to a keep-in-step request then looks like a resize by the user.
 */
async function echoDesktop({ delayMs, answer, seconds = 60, screen = { w: 1920, h: 1080 } }) {
  const due = [];
  const r = rig({ screen, onSet: (s, at) => due.push({ at: at + delayMs, ...answer(s) }) });
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(800, 450);
  for (let t = 0; t < seconds * 1000; t += 100) {
    await r.advance(100);
    while (due.length && due[0].at <= r.now()) { const a = due.shift(); r.size(a.w, a.h); }
  }
  return r;
}

test('watcher: a desktop that answers every request with another size in shape: a few requests, then none (no creep)', async () => {
  const answers = {
    '+16/+9': (s) => ({ w: s.w + 16, h: s.h + 9 }),
    '+7/+4': (s) => ({ w: s.w + 7, h: s.h + 4 }),
    '+2/+1': (s) => ({ w: s.w + 2, h: s.h + 1 }),
    '2% bigger': (s) => ({ w: Math.round(s.w * 1.02), h: Math.round(s.h * 1.02) }),
    '0.8x': (s) => ({ w: Math.round(s.w * 0.8), h: Math.round(s.h * 0.8) }),
    '2x': (s) => ({ w: s.w * 2, h: s.h * 2 }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    for (const delayMs of [50, 300, 1100, 3000]) {
      const r = await echoDesktop({ delayMs, answer });
      assert.ok(r.sets.length <= ECHO_STRIKES + BUDGET, `${name} after ${delayMs} ms: ${r.sets.length} requests: ${r.sets.slice(0, 8).join(' ')}`);
      const n = r.sets.length;
      for (let i = 0; i < 100; i++) await r.advance(100);
      assert.strictEqual(r.sets.length, n, `${name} after ${delayMs} ms: still asking`);
    }
  }
});

test('watcher: a request the desktop ignored does not swallow a drag by the user soon after', async () => {
  for (const afterMs of [1000, 5000, 9900]) {
    const r = rig();
    r.fit.setEnabled(true);
    r.video(1920, 1080);
    r.size(1280, 720);
    await r.advance(1000);
    r.size(1333, 720);                       // a drag; Vault asks for 1333x750 and the desktop ignores it
    await r.advance(1000);
    assert.deepStrictEqual(r.sets.slice(-1), ['1333x750']);
    await r.advance(afterMs);
    r.size(800, 300);                        // the user drags it well away
    await r.advance(1000);
    const [w, h] = r.sets[r.sets.length - 1].split('x').map(Number);
    assert.ok(fitsAspect({ w, h }, A169) && w <= 800 && w >= 500, `after ${afterMs} ms: ${r.sets.join(' ')}`);
    r.size(w, h);
    await r.advance(5000);
    assert.deepStrictEqual(r.sets.slice(-1), [`${w}x${h}`], 'and that is the end of it');
  }
});

/* ── Odd input ──────────────────────────────────────────────────────────── */

test('fitSize: a tiny or broken display size is ignored, never a non-finite size', () => {
  for (const screen of [{ w: 1, h: 1 }, { w: 0.5, h: 1080 }, { w: 1920, h: 0 }, { w: NaN, h: 1080 }, { w: Infinity, h: Infinity }, { w: 100, h: 100 }, 'x', null]) {
    for (const aspect of [A169, A916, 1, 1e-6, 1e6]) {
      const t = fitSize({ win: { w: 1000, h: 700 }, aspect, prev: { w: 900, h: 700 }, screen });
      if (t === null) continue;
      assert.ok(Number.isFinite(t.w) && Number.isFinite(t.h) && Number.isInteger(t.w) && Number.isInteger(t.h), JSON.stringify({ screen, aspect, t }));
    }
  }
  assert.deepStrictEqual(fitSize({ win: { w: 1000, h: 700 }, aspect: A169, prev: { w: 900, h: 700 }, screen: { w: 1, h: 1 } }), { w: 1000, h: 563 });
});

test('watcher: never sends a non-finite geometry', async () => {
  const r = rig({ screen: { w: 0.3, h: NaN } });
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(1000, 700);
  await r.advance(1000);
  await r.fit.step(1);
  for (const s of r.sets) assert.match(s, /^\d+x\d+$/);
});

test('stepSize: wheel down at the smallest size, or up at the screen size, does nothing', () => {
  // A short side under about 176 px: one notch down goes to the smallest size, never back up.
  assert.deepStrictEqual(stepSize({ win: { w: 302, h: 170 }, aspect: A169, dir: -1 }), { w: 284, h: 160 });
  assert.strictEqual(stepSize({ win: { w: 284, h: 160 }, aspect: A169, dir: -1 }), null);
  const screen = { w: 1920, h: 1080 };
  assert.strictEqual(stepSize({ win: { w: 1824, h: 1026 }, aspect: A169, dir: 1, screen }), null);
  assert.ok(stepSize({ win: { w: 1280, h: 720 }, aspect: A169, dir: -1 }).w < 1280);
});

test('watcher: wheel down at the smallest size sends nothing', async () => {
  const r = rig();
  r.fit.setEnabled(true);
  r.video(1920, 1080);
  r.size(284, 160);
  await r.advance(1000);
  const n = r.sets.length;
  await r.fit.step(-1);
  assert.strictEqual(r.sets.length, n);
});
