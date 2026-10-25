/**
 * Beat timing in the streaming beat worker (player-lib/beat-worker.js):
 * the AAC priming the raw ADTS stream carries is taken off every beat, a
 * peak is placed between envelope frames, and a gap left by a decoder error
 * is filled with silence so later beats stay on the audio's clock.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'beat-worker.js'), 'utf8');
  const ctx = { Math, Number, Object, Array, Float32Array, Uint8Array, Date, self: {}, postMessage() {} };
  vm.createContext(ctx);
  vm.runInContext(`${code}\nglobalThis.__w = { beatTimeAt, gapSamples, AAC_PRIMING_SAMPLES, HOP };`, ctx);
  return ctx.__w;
}

const W = load();
const SR = 22050;

test('the AAC priming (1024 samples) comes off every beat', () => {
  assert.strictEqual(W.AAC_PRIMING_SAMPLES, 1024);
  // a symmetric peak sits exactly on its frame
  const env = [0, 0, 0, 0, 0, 1, 4, 1, 0];
  assert.strictEqual(W.beatTimeAt(6, env, SR), (6 * W.HOP - 1024) / SR);
});

test('a peak leaning toward a neighbour lands between frames, never more than half a hop away', () => {
  const t = (env) => W.beatTimeAt(6, [0, 0, 0, 0, ...env], SR);
  const onFrame = (6 * W.HOP - 1024) / SR;
  const later = t([0, 1, 4, 3, 0]);
  const earlier = t([0, 3, 4, 1, 0]);
  assert.ok(later > onFrame && later - onFrame <= 0.5 * W.HOP / SR + 1e-12);
  assert.ok(earlier < onFrame && onFrame - earlier <= 0.5 * W.HOP / SR + 1e-12);
  assert.ok(Math.abs((later - onFrame) + (earlier - onFrame)) < 1e-12, 'mirror images move by the same amount');
  // parabola through (-1,1) (0,4) (1,3): vertex at +1/4 frame
  assert.ok(Math.abs((later - onFrame) - 0.25 * W.HOP / SR) < 1e-12);
});

test('flat or odd neighbours do not move the beat, and nothing is negative', () => {
  const onFrame = (6 * W.HOP - 1024) / SR;
  assert.strictEqual(W.beatTimeAt(6, [0, 0, 0, 0, 0, 4, 4, 4, 0], SR), onFrame);
  assert.strictEqual(W.beatTimeAt(1, [0, 1, 0], SR), 0, 'a beat inside the priming clamps to 0');
});

test('gap fill: none while the decoder output is continuous', () => {
  // timestamps the worker gives its chunks: frameIndex * 1024 / sr in microseconds
  let pos = 0;
  for (let f = 0; f < 500; f++) {
    const ts = Math.round(f * 1024 / SR * 1e6);
    assert.strictEqual(W.gapSamples(ts, SR, pos), 0, `frame ${f}`);
    pos += 1024;
  }
});

test('gap fill: chunks lost to a decoder error become silence of the same length', () => {
  const pos = 100 * 1024;                               // decoded so far
  const ts = Math.round(160 * 1024 / SR * 1e6);         // next output after 60 lost frames
  assert.ok(Math.abs(W.gapSamples(ts, SR, pos) - 60 * 1024) <= 1);
  assert.strictEqual(W.gapSamples(NaN, SR, pos), 0);
  assert.strictEqual(W.gapSamples(1e15, SR, 0), SR * 120, 'capped');
});
