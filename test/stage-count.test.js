/**
 * Track count and time left (player-lib/stage-count.js): "Track 12 of 40 ·
 * 2:14:30 left" on the Stage bar, "40 files · 2:41:05" on a collection's
 * count line. Pure.
 */

const test = require('node:test');
const assert = require('node:assert');
const C = require('../player-lib/stage-count.js');

const vids = (n, d = 60) => Array.from({ length: n }, () => ({ type: 'video', duration: d }));

test('count: the track is the list file the list stands on, the total is the list plus Up next', () => {
  const s = C.summary({ types: Array(40).fill('video'), length: 40, anchor: 11, rest: vids(28), current: { t: 10, d: 60 }, repeat: 'off' });
  assert.deepStrictEqual([s.index, s.total], [12, 40]);
  const u = C.summary({ types: Array(40).fill('video'), length: 40, anchor: 11, upNext: vids(3), rest: vids(28), current: { t: 0, d: 60 } });
  assert.deepStrictEqual([u.index, u.total], [12, 43], 'Up next waiting adds to the total');
  // An Up next file playing counts as the track on, and stays counted after.
  const p = C.summary({ types: Array(40).fill('video'), length: 40, anchor: 11, upPlayed: 1, upNext: vids(2), rest: vids(28), current: { t: 0, d: 60 } });
  assert.deepStrictEqual([p.index, p.total], [13, 43]);
  assert.strictEqual(C.summary({ types: [], length: 0, anchor: -1 }), null, 'no list');
  assert.strictEqual(C.summary({ types: ['video'], length: 1, anchor: -1 }), null, 'a file from outside the list: nothing to count');
});

test('count: documents and mixes are never played, so never counted; Basic Stage counts videos only', () => {
  const types = ['video', 'document', 'image', 'gif', 'audio', 'video', 'mix'];
  const s = C.summary({ types, length: types.length, anchor: 5, rest: [], current: { t: 0, d: 10 } });
  assert.deepStrictEqual([s.index, s.total], [5, 5]);
  const b = C.summary({ types, length: types.length, anchor: 5, rest: [], current: { t: 0, d: 10 }, basic: true, upNext: [{ type: 'image' }, { type: 'video', duration: 5 }] });
  assert.deepStrictEqual([b.index, b.total], [2, 3], 'Basic passes over pictures and sound, in the list and in Up next');
  assert.strictEqual(b.left, 15, 'and they add no time');
  assert.strictEqual(C.summary({ types: (i) => (i % 2 ? 'video' : 'document'), length: 4, anchor: 3, rest: [] }).index, 2, 'types as a function too');
});

test('time left: the rest of the file on Stage, Up next, then the rest of the list; pictures for their seconds, GIFs whole loops', () => {
  const s = C.summary({
    types: Array(5).fill('video'), length: 5, anchor: 1, current: { t: 20, d: 60 },
    upNext: [{ type: 'image' }, { type: 'gif', duration: 3 }],
    rest: [{ type: 'video', duration: 100 }, { type: 'audio', duration: 200 }, { type: 'video', duration: 30 }],
    imageSeconds: 8,
  });
  // 40 + 8 + 9 (three 3 s loops cover 8 s) + 330
  assert.strictEqual(s.left, 387);
  assert.strictEqual(s.about, false);
  assert.strictEqual(C.fileSeconds({ type: 'gif' }, 8), 8, 'a GIF of unknown length: the picture seconds');
  assert.strictEqual(C.fileSeconds({ type: 'video' }, 8), null);
});

test('time left: Repeat all and Repeat this file never end, so only the count shows', () => {
  for (const repeat of ['all', 'one']) {
    const s = C.summary({ types: Array(4).fill('video'), length: 4, anchor: 0, rest: vids(3), current: { t: 0, d: 60 }, repeat });
    assert.deepStrictEqual([s.index, s.total, s.left], [1, 4, null], repeat);
    assert.deepStrictEqual(C.text(s), { track: 'Track 1 of 4', time: '' });
  }
});

test('time left: unknown lengths make it "about"; mostly unknown or too many files to look at: no time', () => {
  const some = C.summary({ types: Array(4).fill('video'), length: 4, anchor: 0, rest: [{ type: 'video', duration: 60 }, null, { type: 'video' }], current: { t: 0, d: 60 } });
  assert.strictEqual(some.left, 120);
  assert.strictEqual(some.about, true);
  assert.strictEqual(C.text(some).time, 'about 2:00 left');
  const most = C.summary({ types: Array(5).fill('video'), length: 5, anchor: 0, rest: [null, null, null, { type: 'video', duration: 9 }], current: { t: 0, d: 0 } });
  assert.strictEqual(most.left, null);
  const big = C.summary({ types: Array(C.TIME_CAP + 10).fill('video'), length: C.TIME_CAP + 10, anchor: 0, rest: vids(10), restTotal: C.TIME_CAP + 9, current: { t: 0, d: 60 } });
  assert.strictEqual(big.left, null);
  assert.strictEqual(big.total, C.TIME_CAP + 10);
});

test('text: "Track 12 of 40 · 2:14:30 left" in parts, the closed form "40 files · 2:41:05", no em dashes', () => {
  assert.deepStrictEqual(C.text({ index: 12, total: 40, left: 2 * 3600 + 14 * 60 + 30, about: false }), { track: 'Track 12 of 40', time: '2:14:30 left' });
  assert.deepStrictEqual(C.text({ index: 1, total: 2, left: 65, about: false }), { track: 'Track 1 of 2', time: '1:05 left' });
  assert.deepStrictEqual(C.text(null), { track: '', time: '' });
  assert.strictEqual(C.listText(40, 2 * 3600 + 41 * 60 + 5), '40 files · 2:41:05');
  assert.strictEqual(C.listText(1, 30, true), '1 file · about 0:30');
  assert.strictEqual(C.listText(12, null), '12 files');
  assert.strictEqual(C.clock(86400 + 2 * 3600 + 14 * 60 + 30), '1:02:14:30', 'a day or more: days first');
  assert.strictEqual(C.clock(3 * 86400 + 5), '3:00:00:05');
  assert.strictEqual(C.clock(86399), '23:59:59');
  assert.strictEqual(C.listText(900, 2 * 86400 + 3600), '900 files · 2:01:00:00');
  assert.strictEqual(C.listText(0, 50), '0 files');
  const src = require('node:fs').readFileSync(require.resolve('../player-lib/stage-count.js'), 'utf8');
  assert.ok(!src.includes('—'), 'no em dash anywhere');
});

test('upPlayed: Up next plays add one; a list file one step on keeps them; a jump or the list starting over starts again', () => {
  assert.strictEqual(C.nextUpPlayed(0, { via: 'upnext' }), 1);
  assert.strictEqual(C.nextUpPlayed(2, { via: 'list', index: 6, lastIndex: 5 }), 2);
  assert.strictEqual(C.nextUpPlayed(2, { via: 'list', index: 0, lastIndex: 39 }), 0, 'Repeat all starting over');
  assert.strictEqual(C.nextUpPlayed(2, { via: 'list', index: 20, lastIndex: 5 }), 0, 'a jump');
  assert.strictEqual(C.nextUpPlayed(2, { via: 'user' }), 0);
});

test('upPlayed: the queue moving on by itself past files that do not play (a picture on Basic, a document) keeps the count', () => {
  assert.strictEqual(C.nextUpPlayed(1, { via: 'list', index: 2, lastIndex: 0, auto: true }), 1);
  assert.strictEqual(C.nextUpPlayed(1, { via: 'list', index: 2, lastIndex: 0, auto: false }), 0, 'a file picked further on is a jump');
  assert.strictEqual(C.nextUpPlayed(1, { via: 'list', index: 0, lastIndex: 2, auto: true }), 0, 'Previous or the list starting over');
  // Basic: [video, image, video] and one Up next file played between them: Track 3 of 3, not Track 2 of 2.
  const types = ['video', 'image', 'video'];
  const up = C.nextUpPlayed(C.nextUpPlayed(0, { via: 'list', index: 0, lastIndex: -1, auto: false }), { via: 'upnext' });
  const after = C.nextUpPlayed(up, { via: 'list', index: 2, lastIndex: 0, auto: true });
  const s = C.summary({ types, length: 3, anchor: 2, upPlayed: after, basic: true, rest: [], current: { t: 0, d: 10 } });
  assert.deepStrictEqual([s.index, s.total], [3, 3]);
});

test('a whole collection\'s length from the server: any size, "about" with some unknown, none with most unknown', () => {
  const c = (timed, total, unknown, files = timed) => ({ item_count: files, timed_count: timed, total_seconds: total, unknown_seconds_count: unknown });
  // 640 files, far past TIME_CAP: still timed.
  assert.deepStrictEqual(C.collectionTime(c(640, 148328, 0)), { seconds: 148328, about: false });
  assert.strictEqual(C.listText(640, 148328), '640 files · 1:17:12:08');
  assert.deepStrictEqual(C.collectionTime(c(10, 600, 5)), { seconds: 600, about: true }, 'half unknown: about');
  assert.strictEqual(C.collectionTime(c(10, 500, 6)), null, 'more than half unknown');
  assert.strictEqual(C.collectionTime(c(0, 0, 0, 12)), null, 'pictures only');
  assert.strictEqual(C.collectionTime({ item_count: 4 }), null, 'nothing from the server (yet)');
  assert.strictEqual(C.collectionTime(null), null);
});

/* ── Plays in: how long until a file is up on Stage (the preview pane) ── */

// A list of 6 videos (ids 1..6, 60 s each) standing on id 2, Stage 20 s into it.
const plan = (o = {}) => ({
  types: Array(6).fill('video'), length: 6, anchor: 1,
  current: { id: 2, t: 20, d: 60 },
  rest: vids(4), restIds: [3, 4, 5, 6], repeat: 'off',
  ...o,
});

test('plays in: the rest of the file on Stage plus every file before it, Up next first', () => {
  assert.deepStrictEqual(C.until(plan(), 3), { seconds: 40, about: false }, 'next in the list: the rest of this one');
  assert.deepStrictEqual(C.until(plan(), 5), { seconds: 160, about: false });
  const up = plan({ upNext: [{ id: 9, type: 'video', duration: 30 }, { id: 8, type: 'video', duration: 45 }] });
  assert.deepStrictEqual(C.until(up, 9), { seconds: 40, about: false }, 'Up next plays first');
  assert.deepStrictEqual(C.until(up, 8), { seconds: 70, about: false });
  assert.deepStrictEqual(C.until(up, 3), { seconds: 115, about: false }, 'the list after Up next');
  assert.strictEqual(C.untilText(C.until(up, 3)), 'Plays in 1:55');
  assert.strictEqual(C.untilText({ seconds: 2 * 3600 + 14 * 60 + 30, about: false }), 'Plays in 2:14:30', 'the bar\'s clock');
});

test('plays in: the file on Stage is on now; a file ahead twice plays the first time', () => {
  assert.deepStrictEqual(C.until(plan(), 2), { now: true });
  assert.strictEqual(C.untilText(C.until(plan(), 2)), 'On Stage now');
  const twice = plan({ upNext: [{ id: 9, type: 'video', duration: 30 }, { id: 5, type: 'video', duration: 60 }] });
  assert.deepStrictEqual(C.until(twice, 5), { seconds: 70, about: false }, 'in Up next before its place in the list');
});

test('plays in: files that do not play are passed over and add no time; pictures add their seconds', () => {
  const o = plan({
    types: ['video', 'video', 'document', 'image', 'audio', 'video'],
    rest: [{ type: 'document' }, { type: 'image' }, { type: 'audio', duration: 100 }, { type: 'video', duration: 60 }],
    imageSeconds: 8,
  });
  assert.strictEqual(C.until(o, 3), null, 'a document never plays');
  assert.deepStrictEqual(C.until(o, 5), { seconds: 48, about: false }, '40 s + the picture\'s 8');
  assert.deepStrictEqual(C.until(o, 6), { seconds: 148, about: false });
  // Basic Stage plays videos only: the picture and the sound file are passed over.
  assert.strictEqual(C.until({ ...o, basic: true }, 4), null);
  assert.deepStrictEqual(C.until({ ...o, basic: true }, 6), { seconds: 40, about: false });
  // Skipped files reach it as a type that does not play (stage-control.js): not ahead.
  const sk = plan({ rest: [{ type: 'skipped' }, ...vids(3)] });
  assert.strictEqual(C.until(sk, 3), null);
  assert.deepStrictEqual(C.until(sk, 4), { seconds: 40, about: false });
});

test('plays in: "about" when a length on the way is not known, not for ones after it', () => {
  const o = plan({ rest: [{ type: 'video', duration: 60 }, null, ...vids(2)] });
  assert.deepStrictEqual(C.until(o, 3), { seconds: 40, about: false });
  assert.deepStrictEqual(C.until(o, 4), { seconds: 100, about: false }, 'its own length does not matter');
  assert.deepStrictEqual(C.until(o, 5), { seconds: 100, about: true }, 'a row not loaded yet on the way (it adds nothing)');
  assert.strictEqual(C.untilText(C.until(o, 5)), 'Plays in about 1:40');
  assert.deepStrictEqual(C.until(plan({ current: { id: 2, t: 5, d: 0 } }), 3), { seconds: 0, about: true }, 'the file on Stage has no length yet');
});

test('plays in: no honest answer, nothing shown', () => {
  assert.strictEqual(C.until(plan(), 1), null, 'already played');
  assert.strictEqual(C.until(plan(), 42), null, 'not in the list');
  assert.strictEqual(C.until(plan({ repeat: 'all' }), 3), null, 'Repeat all: the count gives no time');
  assert.strictEqual(C.until(plan({ repeat: 'one' }), 3), null, 'Repeat this file');
  assert.deepStrictEqual(C.until(plan({ repeat: 'one' }), 2), { now: true }, 'the file on Stage still is');
  assert.strictEqual(C.until(plan({ current: {} }), 3), null, 'nothing on Stage');
  assert.strictEqual(C.until(plan(), null), null);
  assert.strictEqual(C.until(null, 3), null);
  const big = C.TIME_CAP + 5;
  assert.strictEqual(C.until(plan({ types: Array(big + 2).fill('video'), length: big + 2, rest: [], restIds: [], restTotal: big }), 3), null, 'past TIME_CAP');
  const most = plan({ rest: [null, null, null, { type: 'video', duration: 60 }], restIds: [3, 4, 5, 6], current: { id: 2, t: 0, d: 0 } });
  assert.strictEqual(C.until(most, 6), null, 'more than half the lengths not known');
  assert.strictEqual(C.untilText(null), '');
});
