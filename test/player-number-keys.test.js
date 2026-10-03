/**
 * Number keys in the player (player-lib/player/player-controls.js), mpv style:
 * 0 = start, 1 = 10% ... 9 = 90%. The file runs in a VM with a fake document
 * so the real keydown handler is exercised, not a copy of it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'player', 'player-controls.js'), 'utf8');

function load(type, duration) {
  const calls = { resync: 0, controls: 0, resetImage: 0 };
  let handler = null;
  const element = { duration, currentTime: 12 };
  const ctx = {
    document: {
      addEventListener: (ev, fn) => { if (ev === 'keydown') handler = fn; },
      getElementById: (id) => (id === 'mediaPlayerOverlay' ? { classList: { contains: () => true } } : null),
    },
    currentMediaState: { type, element },
    isVideoLike: (t) => t === 'video' || t === 'mix',
    mixPlayerResync: () => { calls.resync++; },
    showMediaControls: () => { calls.controls++; },
    resetImage: () => { calls.resetImage++; },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const press = (key, mods = {}) => handler({
    key, target: { tagName: 'DIV' }, preventDefault() {}, ...mods,
  });
  return { ctx, element, calls, press };
}

test('percentKeyTime maps digits to tenths and refuses an unknown duration', () => {
  const { ctx } = load('video', 200);
  assert.strictEqual(ctx.percentKeyTime(200, '0'), 0);
  assert.strictEqual(ctx.percentKeyTime(200, '1'), 20);
  assert.strictEqual(ctx.percentKeyTime(200, 9), 180);
  assert.strictEqual(ctx.percentKeyTime(NaN, '5'), null);
  assert.strictEqual(ctx.percentKeyTime(Infinity, '5'), null);
  assert.strictEqual(ctx.percentKeyTime(0, '5'), null);
  assert.strictEqual(ctx.percentKeyTime(200, 'x'), null);
});

test('video, audio and mix seek; a mix re-syncs its followers', () => {
  for (const type of ['video', 'audio', 'mix']) {
    const { element, calls, press } = load(type, 100);
    press('3');
    assert.strictEqual(element.currentTime, 30, type);
    press('0');
    assert.strictEqual(element.currentTime, 0, type);
    assert.strictEqual(calls.controls, 2, type);
    assert.strictEqual(calls.resync, type === 'mix' ? 2 : 0, type);
  }
});

test('0 on an image still resets zoom and rotation, and digits do not seek it', () => {
  const { element, calls, press } = load('image', 100);
  press('0');
  press('5');
  assert.strictEqual(calls.resetImage, 1);
  assert.strictEqual(element.currentTime, 12);
});

test('Ctrl, Alt and Meta digits are left to the browser', () => {
  const { element, press } = load('video', 100);
  press('0', { ctrlKey: true });
  press('5', { altKey: true });
  press('7', { metaKey: true });
  assert.strictEqual(element.currentTime, 12);
});

test('no seek before the duration is known', () => {
  const { element, calls, press } = load('video', NaN);
  press('5');
  assert.strictEqual(element.currentTime, 12);
  assert.strictEqual(calls.controls, 0);
});

test('typing digits into a field does not seek', () => {
  const { element, press } = load('video', 100);
  press('5', { target: { tagName: 'INPUT' } });
  assert.strictEqual(element.currentTime, 12);
});
