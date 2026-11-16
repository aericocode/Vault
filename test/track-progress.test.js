/**
 * Track progress (player-lib/track-progress.js): the time left in words, how
 * far along a file or a Wall clip is, and the one setting ("Always show the
 * progress line", Stage settings progressAlways) the player, the Wall and mpv
 * Stage all read. Also the Wall's "Progress line" choice (wall-rules.js) and
 * the setting's place in lib/stage/settings.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const TP = require('../player-lib/track-progress.js');
const WallRules = require('../player-lib/wall-rules.js');
const stageSettings = require('../lib/stage/settings');

test('time left: m:ss, h:mm:ss past an hour, rounded up so 0:00 is the very end', () => {
  assert.strictEqual(TP.leftText(252), '4:12');
  assert.strictEqual(TP.leftText(251.2), '4:12');
  assert.strictEqual(TP.leftText(0.4), '0:01');
  assert.strictEqual(TP.leftText(0), '0:00');
  assert.strictEqual(TP.leftText(3723), '1:02:03');
  assert.strictEqual(TP.leftText(59.9999999), '1:00');
  assert.strictEqual(TP.leftText(NaN), '');
  assert.strictEqual(TP.leftText(Infinity), '');
  assert.strictEqual(TP.leftText(-1), '');
  assert.strictEqual(TP.clock(600), '10:00');
});

test('file progress: how far along and what is left; no length known, no progress', () => {
  assert.deepStrictEqual(TP.fileProgress(25, 100), { frac: 0.25, left: 75 });
  assert.deepStrictEqual(TP.fileProgress(150, 100), { frac: 1, left: 0 }, 'past the end holds at the end');
  assert.deepStrictEqual(TP.fileProgress(-3, 100), { frac: 0, left: 100 });
  assert.deepStrictEqual(TP.fileProgress(undefined, 100), { frac: 0, left: 100 });
  assert.strictEqual(TP.fileProgress(10, 0), null);
  assert.strictEqual(TP.fileProgress(10, NaN), null, 'a stream still opening');
  assert.strictEqual(TP.fileProgress(10, Infinity), null, 'a live stream');
});

test('clip progress: time played on the wall against the time until its block changes; a clip with no end shows the file', () => {
  assert.deepStrictEqual(TP.clipProgress({ elapsed: 30, leftMs: 90000, t: 500, d: 600 }), { frac: 0.25, left: 90 });
  assert.deepStrictEqual(TP.clipProgress({ elapsed: 0, leftMs: 0 }), { frac: 1, left: 0 }, 'nothing either side: done');
  assert.deepStrictEqual(TP.clipProgress({ elapsed: -5, leftMs: 10000 }), { frac: 0, left: 10 });
  assert.deepStrictEqual(TP.clipProgress({ elapsed: 10, leftMs: Infinity, t: 30, d: 120 }), { frac: 0.25, left: 90 }, 'looping: the file');
  assert.deepStrictEqual(TP.wallProgress('file', { elapsed: 30, leftMs: 90000, t: 500, d: 600 }), TP.fileProgress(500, 600));
  assert.deepStrictEqual(TP.wallProgress('clip', { elapsed: 30, leftMs: 90000, t: 500, d: 600 }), { frac: 0.25, left: 90 });
  assert.deepStrictEqual(TP.wallProgress(undefined, { t: 60, d: 120 }), { frac: 0.5, left: 60 }, 'the whole file by default');
});

test('the setting: read from Stage settings, off by default; the seconds follow "Show the name as a file starts"', () => {
  assert.deepStrictEqual(TP.fromStage(undefined), { always: false, showName: true, nameSeconds: 3 });
  assert.deepStrictEqual(TP.fromStage({ progressAlways: true, showName: false, nameSeconds: 7 }), { always: true, showName: false, nameSeconds: 7 });
  assert.strictEqual(TP.fromStage({ progressAlways: 'yes' }).always, false, 'only true turns it on');
  assert.strictEqual(TP.fromStage({ nameSeconds: 99 }).nameSeconds, 30);
  assert.strictEqual(TP.fromStage({ nameSeconds: 'x' }).nameSeconds, 3);
  assert.deepStrictEqual(TP.settings(), TP.DEFAULTS);
  TP.update({ progressAlways: true, showName: true, nameSeconds: 5 });
  assert.deepStrictEqual(TP.settings(), { always: true, showName: true, nameSeconds: 5 });
  TP.update({});
  assert.deepStrictEqual(TP.settings(), TP.DEFAULTS);
});

test('the setting lives with the Stage settings on the server: progressAlways, off by default, true or false only', () => {
  assert.strictEqual(stageSettings.DEFAULTS.progressAlways, false);
  assert.strictEqual(stageSettings.normalize({ progressAlways: true }).progressAlways, true);
  assert.strictEqual(stageSettings.normalize({ progressAlways: 1 }).progressAlways, false);
  assert.strictEqual(stageSettings.validatePatch({ progressAlways: true }, {}).ok, true);
  assert.strictEqual(stageSettings.validatePatch({ progressAlways: true }, {}).settings.progressAlways, true);
  assert.strictEqual(stageSettings.validatePatch({ progressAlways: 'on' }, {}).ok, false);
});

test('Wall: "Progress line" follows the whole file unless the clip is picked; anything else falls back', () => {
  assert.strictEqual(WallRules.cfgFrom({}).progressOf, 'file');
  assert.strictEqual(WallRules.cfgFrom({ v: 4, progressOf: 'clip' }).progressOf, 'clip');
  assert.strictEqual(WallRules.cfgFrom({ v: 4, progressOf: 'block' }).progressOf, 'file');
  assert.strictEqual(WallRules.cfgFrom({ v: 2, progressOf: 'clip' }).progressOf, 'clip', 'kept from an older blob too');
  const c = WallRules.cfgFrom({ v: 4, progressOf: 'clip' });
  assert.deepStrictEqual(WallRules.cfgFrom(JSON.parse(JSON.stringify(c))), c);
  assert.deepStrictEqual(WallRules.PROGRESS_OF, ['file', 'clip']);
});
