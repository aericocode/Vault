/**
 * The Modern player dock's geometry (player-lib/player/dock-geometry.js):
 * the show / hide zones, the fold order for narrow stages, the timeline cut
 * at song edges and the time <-> px mapping across its gaps, the nearest
 * hover frame, note and Hot marks, and the heat ridge's curve.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'player', 'dock-geometry.js'), 'utf8');
  const ctx = { Math, Number, Object, Array, Set, String };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__g = DockGeom;`, ctx);
  return ctx.__g;
}

const G = load();
const plain = (v) => JSON.parse(JSON.stringify(v));

test('zones: the bottom 150 px and the top 76 px show the chrome at once', () => {
  const h = 900;
  for (const y of [750, 800, 899, 900, 0, 40, 76]) assert.strictEqual(G.zoneDecision(y, h, false), 'show', `y=${y}`);
  assert.strictEqual(G.zoneDecision(749, h, false), 'keep', 'hidden stays hidden just above the show zone');
  assert.strictEqual(G.zoneDecision(450, h, false), 'keep');
});

test('zones: visible chrome stays inside the 80 px buffer and hides past the hide line', () => {
  const h = 900;
  // Dock hide line: 900 - 150 - 80 = 670
  assert.strictEqual(G.zoneDecision(700, h, true), 'keep');
  assert.strictEqual(G.zoneDecision(670, h, true), 'keep');
  assert.strictEqual(G.zoneDecision(669, h, true), 'hide');
  // Top bar: stays to 76 + 80 = 156
  assert.strictEqual(G.zoneDecision(156, h, true), 'keep');
  assert.strictEqual(G.zoneDecision(157, h, true), 'hide');
  assert.strictEqual(G.zoneDecision(450, h, true), 'hide');
});

test('zones: no stage size or junk input never hides', () => {
  assert.strictEqual(G.zoneDecision(10, 0, true), 'keep');
  assert.strictEqual(G.zoneDecision(NaN, NaN, true), 'keep');
  assert.strictEqual(G.zoneDecision(undefined, 900, true), 'keep', 'no pointer height changes nothing');
});

test('fold: a wide stage keeps everything, folding goes slider, prev/next, faces+beat', () => {
  const all = { faces: true, vibe: true, beat: true };
  assert.strictEqual(G.foldLevel(1440, all), 0);
  const levels = [];
  for (let w = 1440; w >= 700; w -= 4) levels.push(G.foldLevel(w, all));
  // Never un-folds as the stage gets narrower
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1], `monotonic at ${1440 - i * 4}`);
  // Folds only as far as it must to keep play centred; with the left
  // cluster the wider one, folding the slider alone buys nothing, so it goes
  // together with previous / next (levels are cumulative)
  assert.deepStrictEqual([...new Set(levels)], [0, 2, 3, 4]);
  assert.ok(G.foldLevel(1024, all) >= 2, 'the mock 1024 px window folds at least the slider and previous / next');
  // With the right cluster the wider one, the slider goes first on its own
  assert.strictEqual(G.foldLevel(G.rowNeed(1, {}), {}), 1);
});

test('fold: below 700 px the left cluster folds too, then 10 s skips, long time, volume and full screen', () => {
  assert.strictEqual(G.foldLevel(699, {}), 4);
  assert.strictEqual(G.foldLevel(760, {}) < 4, true);
  const all = { faces: true, vibe: true, beat: true };
  const levels = [];
  for (let w = 699; w >= 300; w -= 1) levels.push(G.foldLevel(w, all));
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1], `monotonic at ${699 - i}`);
  assert.deepStrictEqual([...new Set(levels)], [4, 5, 6, 7]);
  assert.strictEqual(G.foldLevel(320, { faces: true }), 7, 'nothing left to fold: the last level');
});

test('fold: every stage from 480 px up fits its row, also with an hour-long file', () => {
  for (const hours of [false, true]) {
    for (const extra of [{}, { faces: true, vibe: true, beat: true }]) {
      const p = { ...extra, hours };
      for (let w = 480; w <= 1600; w += 2) {
        const level = G.foldLevel(w, p);
        assert.ok(G.rowNeed(level, p) <= w, `w=${w} hours=${hours} level=${level} needs ${G.rowNeed(level, p)}`);
      }
    }
  }
  // A long time label folds sooner than a short one
  assert.ok(G.foldLevel(560, { hours: true }) >= G.foldLevel(560, {}));
  assert.ok(G.clusterWidths(6, { hours: true }).left < G.clusterWidths(5, { hours: true }).left, 'level 6 shows the current time only');
});

test('fold: fewer optional buttons need less room', () => {
  const none = G.rowNeed(0, {});
  const all = G.rowNeed(0, { faces: true, vibe: true, beat: true });
  assert.ok(none <= all);
  assert.ok(G.foldLevel(1000, {}) <= G.foldLevel(1000, { faces: true, vibe: true, beat: true }));
  // Each fold level needs no more room than the one before
  for (let l = 1; l <= G.MAX_LEVEL; l++) assert.ok(G.rowNeed(l, { faces: true, vibe: true, beat: true }) <= G.rowNeed(l - 1, { faces: true, vibe: true, beat: true }));
});

test('fold: Hot, Done, play, A-B, repeat and subtitles never fold away', () => {
  const p = { faces: true, vibe: true, beat: true };
  const c4 = G.clusterWidths(4, p);
  assert.strictEqual(c4.left, G.W.time + G.W.sep + 2 * G.W.btn, 'level 4: time, Hot and Done stay');
  assert.strictEqual(c4.right, 6 * G.W.btn, 'level 4: A-B, repeat, CC, volume, gear, full screen stay');
  assert.strictEqual(c4.center, G.W.play + 2 * G.W.btn, 'level 4: back 10, play, forward 10 stay');
  const c7 = G.clusterWidths(7, p);
  assert.strictEqual(c7.left, G.W.timeShort + G.W.sep + 2 * G.W.btn, 'level 7: current time, Hot and Done');
  assert.strictEqual(c7.center, G.W.play, 'level 7: play');
  assert.strictEqual(c7.right, 4 * G.W.btn, 'level 7: A-B, repeat, CC and the gear');
});

test('segments: no song data is one plain segment', () => {
  assert.deepStrictEqual(plain(G.segments(185, [])), [{ start: 0, end: 185, song: -1 }]);
  assert.deepStrictEqual(plain(G.segments(185, null)), [{ start: 0, end: 185, song: -1 }]);
  assert.deepStrictEqual(plain(G.segments(0, [{ start_sec: 1, end_sec: 5 }])), []);
});

test('segments: songs cut the bar, plain time fills between, edges clamp', () => {
  const s = G.segments(185, [
    { start_sec: 122, end_sec: 159 },
    { start_sec: 55, end_sec: 107 },
    { start_sec: 170, end_sec: 400 },      // runs past the end
  ]);
  assert.deepStrictEqual(plain(s), [
    { start: 0, end: 55, song: -1 },
    { start: 55, end: 107, song: 1 },
    { start: 107, end: 122, song: -1 },
    { start: 122, end: 159, song: 0 },
    { start: 159, end: 170, song: -1 },
    { start: 170, end: 185, song: 2 },
  ]);
});

test('segments: overlaps merge, slivers join the song before, junk is dropped', () => {
  const s = G.segments(300, [
    { start_sec: 10, end_sec: 60 },
    { start_sec: 50, end_sec: 90 },        // overlaps the first
    { start_sec: 90.4, end_sec: 120 },     // 0.4 s after: a sliver
    { start_sec: 'x', end_sec: 5 },
    { start_sec: 200, end_sec: 200.2 },    // too short to be a song
    null,
  ]);
  assert.deepStrictEqual(plain(s), [
    { start: 0, end: 10, song: -1 },
    { start: 10, end: 90.4, song: 0 },
    { start: 90.4, end: 120, song: 2 },
    { start: 120, end: 300, song: -1 },
  ]);
  // A song starting in the first second takes the start of the bar
  assert.deepStrictEqual(plain(G.segments(100, [{ start_sec: 0.3, end_sec: 40 }]))[0], { start: 0, end: 40, song: 0 });
});

test('layout and mapping: px across 3 px gaps, round trip, gap snaps to the near edge', () => {
  const segs = G.segments(100, [{ start_sec: 50, end_sec: 100 }]);
  const lay = G.layout(segs, 203, 3);
  assert.deepStrictEqual(plain(lay), [{ x: 0, w: 100 }, { x: 103, w: 100 }]);
  assert.strictEqual(G.timeToX(0, segs, lay), 0);
  assert.strictEqual(G.timeToX(25, segs, lay), 50);
  assert.strictEqual(G.timeToX(50, segs, lay), 103);
  assert.strictEqual(G.timeToX(100, segs, lay), 203);
  for (const t of [0, 10, 33, 49.9, 50, 75, 100]) {
    assert.ok(Math.abs(G.xToTime(G.timeToX(t, segs, lay), segs, lay) - t) < 1e-9, `round trip ${t}`);
  }
  assert.strictEqual(G.xToTime(101, segs, lay), 50, 'gap nearer the left edge');
  assert.strictEqual(G.xToTime(102.5, segs, lay), 50, 'either way it is the boundary');
  assert.strictEqual(G.xToTime(-20, segs, lay), 0);
  assert.strictEqual(G.xToTime(999, segs, lay), 100);
  assert.deepStrictEqual(plain(G.layout([], 200)), []);
  assert.deepStrictEqual(plain(G.layout(segs, 2, 3)), [{ x: 0, w: 0 }, { x: 3, w: 0 }], 'too narrow: zero widths, never negative');
});

test('segmentIndexAt: the segment holding a time, the last one past the end', () => {
  const segs = G.segments(100, [{ start_sec: 30, end_sec: 60 }]);
  assert.strictEqual(G.segmentIndexAt(segs, 0), 0);
  assert.strictEqual(G.segmentIndexAt(segs, 30), 1);
  assert.strictEqual(G.segmentIndexAt(segs, 59.9), 1);
  assert.strictEqual(G.segmentIndexAt(segs, 60), 2);
  assert.strictEqual(G.segmentIndexAt(segs, 500), 2);
  assert.strictEqual(G.segmentIndexAt([], 5), -1);
});

test('scrub frame: the nearest of the five, which sit at 1/6 .. 5/6 of the file', () => {
  const d = 600;
  assert.strictEqual(G.scrubFrameIndex(0, d), 0);
  assert.strictEqual(G.scrubFrameIndex(100, d), 0);
  assert.strictEqual(G.scrubFrameIndex(200, d), 1);
  assert.strictEqual(G.scrubFrameIndex(300, d), 2);
  assert.strictEqual(G.scrubFrameIndex(349, d), 2);
  assert.strictEqual(G.scrubFrameIndex(351, d), 3);
  assert.strictEqual(G.scrubFrameIndex(500, d), 4);
  assert.strictEqual(G.scrubFrameIndex(600, d), 4);
  assert.strictEqual(G.scrubFrameIndex(10, 0), 0);
});

test('note marks: times inside note text, ranges by their start, nearest within 2 s', () => {
  const marks = G.noteMarks([
    { text: 'good bit at 1:56', timestamp: 'Oct 1, 2026' },
    { text: 'loop 0:11-1:23 and again 1:02:03' },
    { text: 'no time here' },
    { text: '' },
    null,
  ]);
  assert.deepStrictEqual(plain(marks.map(m => m.t)), [11, 83, 116, 3723]);
  assert.strictEqual(G.noteNear(marks, 117.5).text, 'good bit at 1:56');
  assert.strictEqual(G.noteNear(marks, 119), null);
  assert.strictEqual(G.noteNear(marks, 82, 2).t, 83);
  assert.strictEqual(G.noteNear([], 5), null);
});

test('hot marks: bucket centres with a mark, or the single last position', () => {
  const heat = new Array(100).fill(0);
  heat[10] = 2; heat[50] = 1;
  assert.deepStrictEqual(plain(G.hotMarks(heat, 200)), [21, 101]);
  assert.deepStrictEqual(plain(G.hotMarks(null, 200, 77)), [77]);
  assert.deepStrictEqual(plain(G.hotMarks(new Array(100).fill(0), 200, 500)), [200], 'clamped to the file');
  assert.deepStrictEqual(plain(G.hotMarks(null, 200, 0)), []);
  assert.deepStrictEqual(plain(G.hotMarks(heat, 0)), []);
});

test('smoothHeat: neighbour average scaled to a peak of 1, empty when nothing was watched', () => {
  const s = G.smoothHeat([0, 3, 0]);
  assert.deepStrictEqual(plain(s.map(x => Math.round(x * 1000) / 1000)), [1, 0.667, 1]);
  const t = G.smoothHeat([0, 0, 6, 0, 0]);
  assert.strictEqual(Math.max(...t), 1);
  assert.strictEqual(t[0], 0);
  assert.deepStrictEqual(plain(G.smoothHeat([0, 0, 0])), []);
  assert.deepStrictEqual(plain(G.smoothHeat(null)), []);
});

test('precise times: decimals only when there is a fraction, to the hundredth', () => {
  assert.strictEqual(G.formatPrecise(41), '0:41');
  assert.strictEqual(G.formatPrecise(41.25), '0:41.25');
  assert.strictEqual(G.formatPrecise(41.5), '0:41.5');
  assert.strictEqual(G.formatPrecise(41.07), '0:41.07');
  assert.strictEqual(G.formatPrecise(41.004), '0:41', 'under a hundredth rounds away');
  assert.strictEqual(G.formatPrecise(59.999), '1:00', 'rounding carries into the minute');
  assert.strictEqual(G.formatPrecise(3723.4), '1:02:03.4');
  assert.strictEqual(G.formatPrecise(0), '0:00');
  assert.strictEqual(G.formatPrecise(NaN), '0:00');
  assert.strictEqual(G.formatPrecise(-3), '0:00');
});

test('precise times: [h:]m:ss[.d|.dd] parses to the hundredth and round-trips', () => {
  assert.strictEqual(G.parsePrecise('0:41'), 41);
  assert.strictEqual(G.parsePrecise('0:41.5'), 41.5);
  assert.strictEqual(G.parsePrecise('0:41.25'), 41.25);
  assert.strictEqual(G.parsePrecise('0:41.05'), 41.05);
  assert.strictEqual(G.parsePrecise(' 1:02:03.07 '), 3723.07);
  for (const bad of ['', '41', '0:4', '0:60', '1:60:00', '0:41.123', '0:41.', 'a:bc', null]) {
    assert.strictEqual(G.parsePrecise(bad), null, String(bad));
  }
  for (const t of [0, 1, 41.25, 41.5, 599.99, 3723.07]) assert.strictEqual(G.parsePrecise(G.formatPrecise(t)), t);
});

test('note marks: hundredths in note times (m:ss.d, m:ss.dd, h:mm:ss.dd)', () => {
  const marks = G.noteMarks([
    { text: 'drop at 0:41.25 and 1:02.5' },
    { text: 'range 0:11.25-1:23.5' },
    { text: 'long one 1:02:03.07' },
  ]);
  assert.deepStrictEqual(plain(marks.map(m => m.t)), [11.25, 41.25, 62.5, 83.5, 3723.07]);
});

/* The note-time cases notes.js links (its _TS_LINK_RE, [h:]m:ss[.d|.dd]
   between word boundaries), so a pin sits wherever the note shows a link. */
test('note marks: same times as the note links, full stops and long decimals included', () => {
  const t = (text) => plain(G.noteMarks([{ text }]).map(m => m.t));
  assert.deepStrictEqual(t('good bit at 1:56.'), [116], 'a full stop after a time belongs to the sentence');
  assert.deepStrictEqual(t('ends 2:03:04.'), [7384], 'h:mm:ss before a full stop');
  assert.deepStrictEqual(t('v 1:23.456'), [83], 'three decimals stop at the whole second');
  assert.deepStrictEqual(t('three places 0:12.345'), [12]);
  assert.deepStrictEqual(t('at 0:41.25, then 0:43.5!'), [41.25, 43.5]);
  assert.deepStrictEqual(t('(1:56)'), [116]);
  assert.deepStrictEqual(t('range 0:11 - 1:23 and 0:30–0:40'), [11, 30, 40, 83]);
  assert.deepStrictEqual(t('1:02:33 start'), [3753]);
  assert.deepStrictEqual(t('time 1:75 as written'), [135], 'not range-checked, like the links');
  assert.deepStrictEqual(t('ab1:23 and 1:2 and 123:45'), [], 'no word boundary, one-digit seconds or three-digit minutes');
});

/* Pins and links cannot drift apart: the times notes.js would link (its own
   pattern, read from its source) are exactly the times pinned on the bar. */
test('note marks: agree with notes.js link pattern on every case', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'notes.js'), 'utf8');
  const tsSrc = /const _TS = '([^']+)';/.exec(src);
  assert.ok(tsSrc, 'notes.js still defines _TS');
  // The source holds a JS string literal: '\\d' there is the regex \d
  const TS = tsSrc[1].replace(/\\\\/g, '\\');
  const link = new RegExp(`\\b(${TS})\\s*[-–—]\\s*(${TS})\\b|\\b${TS}\\b`, 'g');
  const secs = (ts) => {
    const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2}(?:\.\d{1,2})?)$/.exec(ts);
    return Math.round(((Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3])) * 100) / 100;
  };
  const cases = ['good bit at 1:56.', 'ends 2:03:04.', 'v 1:23.456', 'at 0:41.25, then 0:43.5!', '(1:56)',
    'range 0:11 - 1:23 and 0:30–0:40', '1:02:33 start', 'time 1:75 as written', 'ab1:23 and 1:2 and 123:45',
    'loop 0:11.25-1:23.5 again', '0:00 and 0:00.5', 'a.1:23 b 1:23.4.5'];
  for (const text of cases) {
    const linked = new Set();
    for (const m of text.matchAll(link)) {
      if (m[1]) { linked.add(secs(m[1])); linked.add(secs(m[2])); } else linked.add(secs(m[0]));
    }
    const pinned = G.noteMarks([{ text }]).map(m => m.t);
    assert.deepStrictEqual(plain(pinned), plain([...linked].sort((a, b) => a - b)), text);
  }
});
