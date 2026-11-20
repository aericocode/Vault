/**
 * Smooth progress (player-lib/smooth-progress.js): progress lines move every
 * animation frame while a file plays instead of in timeupdate's 4-a-second
 * steps. The fraction, the clock that runs on between mpv Stage's reports,
 * the frame loop (starts, stops by itself, never while hidden, no leaks),
 * following one media element, and where the player, the mini player, the
 * Stage bar, the Wall, the Editor and Frame Fit use it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const SP = require('../player-lib/smooth-progress.js');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** A requestAnimationFrame that runs only when told to. */
function fakeFrames() {
  let next = 1;
  const queue = new Map();
  return {
    raf: (cb) => { const id = next++; queue.set(id, cb); return id; },
    caf: (id) => { queue.delete(id); },
    pending: () => queue.size,
    /** Run one frame at time `now` (ms). */
    run(now = 0) {
      const cbs = [...queue.values()];
      queue.clear();
      for (const cb of cbs) cb(now);
      return cbs.length;
    },
  };
}

test('fraction: how far along, clamped; 0 while the length is unknown', () => {
  assert.strictEqual(SP.fraction(2, 8), 0.25);
  assert.strictEqual(SP.fraction(9, 8), 1);
  assert.strictEqual(SP.fraction(-1, 8), 0);
  assert.strictEqual(SP.fraction(3, NaN), 0);
  assert.strictEqual(SP.fraction(3, 0), 0);
  assert.strictEqual(SP.fraction(3, Infinity), 0);
  assert.strictEqual(SP.fraction(NaN, 8), 0);
});

test('pct: sub-pixel widths, never rounded to whole percents', () => {
  assert.strictEqual(SP.pct(0.123456), '12.3456%');
  assert.strictEqual(SP.pct(1 / 480), '0.2083%', 'an 8 s clip at 60 fps moves about 0.2% a frame');
  assert.strictEqual(SP.pct(2), '100.0000%');
  assert.strictEqual(SP.pct(NaN), '0.0000%');
});

test('an 8 s clip drawn per frame: many distinct positions a second, not 4', () => {
  // timeupdate gives about 4 readings a second; the frame loop one per frame.
  const perFrame = new Set();
  for (let ms = 0; ms < 1000; ms += 1000 / 60) perFrame.add(SP.pct(SP.fraction(1 + ms / 1000, 8)));
  const perTimeupdate = new Set();
  for (let ms = 0; ms < 1000; ms += 250) perTimeupdate.add(SP.pct(SP.fraction(1 + ms / 1000, 8)));
  assert.ok(perFrame.size >= 59, `per frame: ${perFrame.size} positions`);
  assert.strictEqual(perTimeupdate.size, 4);
});

test('report clock: runs on from the last report at its rate, held at the end, still while paused', () => {
  const c = SP.reportClock();
  assert.strictEqual(c.timeAt(0), 0, 'no report yet');
  c.report(2, 1000, { running: true, d: 8 });
  assert.strictEqual(c.timeAt(1000), 2);
  assert.strictEqual(c.timeAt(1500), 2.5);
  assert.strictEqual(c.timeAt(20000), 8, 'never past the end');
  c.report(3, 2000, { running: false, d: 8 });
  assert.strictEqual(c.timeAt(5000), 3, 'paused: stays');
  c.report(3, 2000, { running: true, rate: 2, d: 8 });
  assert.strictEqual(c.timeAt(2500), 4, 'at 2x it runs twice as fast');
});

test('report clock: a report a little behind what is shown holds the line (never a step back)', () => {
  const c = SP.reportClock();
  c.report(1, 0, { running: true, d: 8 });
  assert.strictEqual(c.timeAt(300), 1.3);
  // The next report arrives late and says 1.2 (rounded, a little behind).
  c.report(1.2, 300, { running: true, d: 8 });
  assert.strictEqual(c.timeAt(300), 1.3, 'held where it was');
  assert.strictEqual(c.timeAt(350), 1.3, 'still held while the time catches up');
  assert.ok(Math.abs(c.timeAt(450) - 1.35) < 1e-9, 'then runs on from the report');
});

test('report clock: a seek, a wrap to the start or a new file snaps at once', () => {
  const c = SP.reportClock();
  c.report(7.8, 0, { running: true, d: 8 });
  assert.strictEqual(c.timeAt(250), 8);
  c.report(0.1, 250, { running: true, d: 8 });
  assert.strictEqual(c.timeAt(250), 0.1, 'repeat one: back to the start, no glide backwards');
  c.report(5, 300, { running: true, d: 8 });
  c.report(4.9, 300, { running: true, d: 8, jump: true });
  assert.strictEqual(c.timeAt(300), 4.9, 'a seek made here is exact even a little back');
  c.reset();
  assert.strictEqual(c.timeAt(1000), 0);
});

test('loop: runs every frame until the step says stop; kick starts it again, once', () => {
  const f = fakeFrames();
  let n = 0;
  let more = true;
  const lp = SP.loop(() => { n++; return more; }, { raf: f.raf, caf: f.caf, doc: null });
  assert.strictEqual(f.pending(), 0, 'nothing until kicked');
  lp.kick();
  lp.kick();
  assert.strictEqual(f.pending(), 1, 'a second kick does not stack a second loop');
  f.run(); f.run(); f.run();
  assert.strictEqual(n, 3);
  assert.ok(lp.running());
  more = false;
  f.run();
  assert.strictEqual(n, 4);
  assert.strictEqual(f.pending(), 0, 'stopped by itself');
  assert.ok(!lp.running());
  more = true;
  lp.kick();
  f.run();
  assert.strictEqual(n, 5);
  lp.dispose();
  assert.strictEqual(f.pending(), 0, 'dispose cancels the frame asked for');
  lp.kick();
  assert.strictEqual(f.pending(), 0, 'a disposed loop never runs again');
});

test('loop: never runs while the tab is hidden; a step that throws stops it', () => {
  const f = fakeFrames();
  const doc = { hidden: true };
  let n = 0;
  const lp = SP.loop(() => { n++; return true; }, { raf: f.raf, caf: f.caf, doc });
  lp.kick();
  assert.strictEqual(f.pending(), 0, 'hidden: not even asked for');
  doc.hidden = false;
  lp.kick();
  f.run();
  doc.hidden = true;
  f.run();
  assert.strictEqual(n, 1, 'the frame after the tab hid does no work');
  assert.strictEqual(f.pending(), 0);
  lp.dispose();

  const warn = console.warn;
  console.warn = () => {};
  try {
    const bad = SP.loop(() => { throw new Error('boom'); }, { raf: f.raf, caf: f.caf, doc: null });
    bad.kick();
    f.run();
    assert.strictEqual(f.pending(), 0);
    bad.dispose();
  } finally { console.warn = warn; }
});

test('loops are released on dispose (no leaks)', () => {
  const before = SP._liveCount();
  const f = fakeFrames();
  const loops = Array.from({ length: 5 }, () => SP.loop(() => false, { raf: f.raf, caf: f.caf, doc: null }));
  assert.strictEqual(SP._liveCount(), before + 5);
  loops.forEach((l) => l.dispose());
  assert.strictEqual(SP._liveCount(), before);
});

test('follow: paints every frame while the element plays, exactly on its events, stops on pause; stop() takes it all off', () => {
  const f = fakeFrames();
  const el = new EventTarget();
  Object.assign(el, { currentTime: 0, duration: 8, paused: true, ended: false });
  const painted = [];
  const fol = SP.follow(el, (t, d) => painted.push([t, d]), { raf: f.raf, caf: f.caf, doc: null });
  assert.deepStrictEqual(painted, [[0, 8]], 'drawn once as it starts');
  el.paused = false;
  el.dispatchEvent(new Event('play'));
  for (let i = 1; i <= 30; i++) { el.currentTime = i / 60; f.run(i * 16.7); }
  assert.strictEqual(painted.length, 2 + 30, 'one paint per frame');
  el.currentTime = 0.1;                       // loop / repeat: back to the start
  f.run();
  assert.strictEqual(painted.at(-1)[0], 0.1, 'read straight from the element: it snaps back');
  el.paused = true;
  el.currentTime = 4;
  el.dispatchEvent(new Event('pause'));
  f.run();
  assert.strictEqual(f.pending(), 0, 'paused: the loop is gone');
  assert.strictEqual(painted.at(-1)[0], 4, 'and the line is exact where it stopped');
  el.currentTime = 6;
  el.dispatchEvent(new Event('seeked'));
  assert.strictEqual(painted.at(-1)[0], 6, 'a seek while paused is drawn at once');
  const count = painted.length;
  fol.stop();
  el.paused = false;
  el.dispatchEvent(new Event('play'));
  el.dispatchEvent(new Event('timeupdate'));
  f.run();
  assert.strictEqual(painted.length, count, 'nothing after stop()');
});

test('follow: an element taken off the page stops the loop', () => {
  const f = fakeFrames();
  const el = new EventTarget();
  Object.assign(el, { currentTime: 1, duration: 8, paused: false, ended: false, isConnected: true });
  let n = 0;
  const fol = SP.follow(el, () => { n++; }, { raf: f.raf, caf: f.caf, doc: null });
  f.run();
  el.isConnected = false;
  f.run();
  assert.strictEqual(f.pending(), 0);
  assert.strictEqual(n, 2, 'the start, one frame');
  fol.stop();
});

/* ── Where it is used ─────────────────────────────────────────────── */

test('the page loads the helper before the players, and the player driver after the lines it moves', () => {
  const html = read('db-viewer.html');
  const at = (s) => { const i = html.indexOf(`src="./player-lib/${s}"`); assert.ok(i > 0, s); return i; };
  assert.ok(at('smooth-progress.js') < at('player/player-video.js'));
  assert.ok(at('smooth-progress.js') < at('stage-control.js'));
  assert.ok(at('smooth-progress.js') < at('wall.js'));
  assert.ok(at('player/player-track.js') < at('player/player-smooth.js'));
});

test('the Classic seek bar has no width transition (a seek or a wrap snaps, nothing lags a frame write)', () => {
  const css = read('css/player/player-video.css');
  const rule = css.match(/\.video-progress-bar\s*\{[^}]*\}/)[0].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rule, /transition\s*:/);
});

test('the player driver moves every line of the playing element per frame, and lets a drag win', () => {
  const src = read('player-lib/player/player-smooth.js');
  assert.match(src, /'videoProgressBar', 'videoProgressWrapper'/);
  assert.match(src, /'audioProgressBar', 'audioProgressWrapper'/);
  assert.match(src, /classList\.contains\('scrubbing'\)\) return;\s*\/\/ the drag wins/);
  assert.match(src, /ModernDock\.paintPlayhead\(true\)/);
  assert.match(src, /PlayerTrack\.paintLine\(el\)/);
  assert.match(src, /miniSeekFill/);
  const modern = read('player-lib/player/player-modern.js');
  assert.match(modern, /if \(fromFrame && st\.dragging\) return;/);
  const track = read('player-lib/player/player-track.js');
  assert.match(track, /paintLine/);
});

test('Stage bar: mpv runs on between reports, Basic reads its video; both stop when nothing moves', () => {
  const sc = read('player-lib/stage-control.js');
  assert.match(sc, /barClock\.report\(t, perfNow\(\), \{ running: mpvRunning\(\), d, jump: oldKey !== r\.key \}\)/);
  assert.match(sc, /barClock\.report\(t, perfNow\(\), \{ running: mpvRunning\(\), d, jump: true \}\)/, 'a seek from the bar is exact');
  assert.match(sc, /if \(!mpvRunning\(\) \|\| locked \|\| statusKey !== cur\.key\) return false;/);
  assert.match(sc, /if \(lineLoop\) \{ lineFrame\(\); lineLoop\.kick\(\); \}/);
});

test('Wall: one loop for the lines that show, labels on the tick', () => {
  const wall = read('player-lib/wall.js');
  assert.match(wall, /const lineLoop = typeof SmoothProgress !== 'undefined' \? SmoothProgress\.loop\(lineFrame\) : null;/);
  assert.match(wall, /if \(!b\.tpOn \|\| \(!always && !b\.hovered\)\) continue;/);
});
