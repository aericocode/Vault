/**
 * Track count and time left (player-lib/stage-count.js): "Track 12 of 40 ·
 * 2:14:30 left" on the Stage bar and the Flow order bar, "40 files ·
 * 2:41:05" on the Flow order bar while Stage is closed. Pure.
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
  assert.strictEqual(C.listText(640, 148328), '640 files · 41:12:08');
  assert.deepStrictEqual(C.collectionTime(c(10, 600, 5)), { seconds: 600, about: true }, 'half unknown: about');
  assert.strictEqual(C.collectionTime(c(10, 500, 6)), null, 'more than half unknown');
  assert.strictEqual(C.collectionTime(c(0, 0, 0, 12)), null, 'pictures only');
  assert.strictEqual(C.collectionTime({ item_count: 4 }), null, 'nothing from the server (yet)');
  assert.strictEqual(C.collectionTime(null), null);
});
