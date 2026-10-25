/**
 * The viewer's side of the thumbnail settings, run in a VM:
 * player-lib/thumbs.js decides whether a tile asks for a picture at all (Off:
 * never), whether a pending one is waited for (When shown: as long as the
 * tile is there), what prefetch may warm, and whether hover frames are asked
 * for; player-lib/thumb-settings-ui.js reads the typed sizes.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, extra = {}) {
  const noop = () => {};
  const ctx = {
    console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Date, Error, Number, String, Array, Object, Boolean, RegExp,
    fetch: async () => { throw new Error('no network in this test'); },
    document: { addEventListener: noop, querySelectorAll: () => [], getElementById: () => null },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: noop },
    HTMLImageElement: class {},
    ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', file), 'utf8'), ctx);
  return ctx;
}

const video = { id: 1, media_type: 'video' };
const audio = { id: 2, media_type: 'audio' };
const doc = { id: 3, media_type: 'document' };

test('default settings: today\'s tiles, plus album art for music', () => {
  const t = load('thumbs.js');
  assert.strictEqual(t.canShowThumb(video), true);
  assert.strictEqual(t.canShowThumb(audio), true, 'inside pictures on by default');
  assert.strictEqual(t.canShowThumb(doc), false);
  assert.strictEqual(t.thumbHoverOn(), true);
  assert.strictEqual(t.thumbRetryDelay(0), 1000);
  assert.strictEqual(t.thumbRetryDelay(4), null, 'For every file: gives up after the backoff, as before');
  assert.strictEqual(t.thumbPrefetchable(video), true);
});

test('Off: no tile asks for anything, nothing is prefetched, no hover frames', () => {
  const t = load('thumbs.js');
  t.setThumbSettings({ make: 'off', keep: 'keep', hover: true, inside: true });
  for (const m of [video, audio, { id: 4, media_type: 'image' }, { id: 5, media_type: 'mix' }]) {
    assert.strictEqual(t.canShowThumb(m), false, m.media_type);
    assert.strictEqual(t.thumbPrefetchable({ ...m, thumb_version: 9 }), false);
  }
  assert.strictEqual(t.thumbHoverOn(), false);
  t.setThumbSettings({ make: 'all', keep: 'keep', hover: true, inside: true });
  assert.strictEqual(t.canShowThumb(video), true, 'switching back on asks again');
});

test('When shown: a pending picture is waited for while the tile is there', () => {
  const t = load('thumbs.js');
  t.setThumbSettings({ make: 'shown', keep: 'keep', hover: true, inside: true });
  assert.strictEqual(t.thumbRetryDelay(3), 8000);
  assert.strictEqual(t.thumbRetryDelay(4), 3000);
  assert.strictEqual(t.thumbRetryDelay(500), 3000);
});

test('When shown: prefetch warms only pictures already made; memory mode warms nothing', () => {
  const t = load('thumbs.js');
  t.setThumbSettings({ make: 'shown', keep: 'keep', hover: true, inside: true });
  assert.strictEqual(t.thumbPrefetchable(video), false, 'not made yet: not asked for');
  assert.strictEqual(t.thumbPrefetchable({ ...video, thumb_version: 5 }), true);
  t.setThumbSettings({ make: 'shown', keep: 'memory', hover: true, inside: true });
  assert.strictEqual(t.thumbPrefetchable({ ...video, thumb_version: 5 }), false);
});

test('hover frames off: tiles do not scrub; inside pictures off: music shows its icon', () => {
  const t = load('thumbs.js');
  t.setThumbSettings({ make: 'all', keep: 'keep', hover: false, inside: false });
  assert.strictEqual(t.thumbHoverOn(), false);
  assert.strictEqual(t.canShowThumb(audio), false);
  assert.strictEqual(t.canShowThumb(video), true);
});

test('size boxes: exact typed sizes in MB or GB, a bare number in the box\'s unit', () => {
  const u = load('thumb-settings-ui.js');
  const parse = u.vaultThumbSizeParse;
  assert.strictEqual(parse('450', 'MB'), 450);
  assert.strictEqual(parse('450 MB', 'GB'), 450);
  assert.strictEqual(parse('1.5 GB', 'MB'), 1536);
  assert.strictEqual(parse('2g', 'MB'), 2048);
  assert.strictEqual(parse('3', 'GB'), 3072);
  assert.strictEqual(parse('2,5 gb', 'MB'), 2560);
  assert.strictEqual(parse('lots', 'MB'), null);
  assert.strictEqual(parse('-5', 'MB'), null);
  assert.strictEqual(u.vaultThumbFmtMB(300), '300 MB');
  assert.strictEqual(u.vaultThumbFmtMB(2048), '2 GB');
  assert.strictEqual(u.vaultThumbFmtMB(1536), '1.5 GB');
});

test('no em dash in the Thumbnails group\'s text', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'thumb-settings-ui.js'), 'utf8');
  // Only string literals reach the page; comments are allowed anything.
  const strings = src.match(/(['`])(?:\\.|(?!\1).)*\1/gs) || [];
  for (const s of strings) assert.ok(!s.includes('—'), s.slice(0, 60));
});
