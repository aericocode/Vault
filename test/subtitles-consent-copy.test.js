/**
 * The subtitles model consent speaks plainly (audit M3): what the model is
 * for and its size, no codename ("large-v3-turbo"), no domain name, no emoji
 * and no em dash. The consent keys themselves are unchanged (lib/model-consent.js).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'player', 'player-subtitles.js'), 'utf8');
  const ctx = {
    console, Math, Number, String, Object, JSON, Promise, Map, Set, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

const EMOJI = /[\u2190-\u2BFF\u{1F000}-\u{1FFFF}]/u;

test('consent copy: plain names, sizes as "about", nothing technical', () => {
  const { subtitlesConsentCopy: copy } = load();
  const whisper = copy('whisper', 'large-v3-turbo', '~1.5 GB');
  assert.strictEqual(whisper.title, 'Download the subtitles model (about 1.5 GB)?');
  const opus = copy('opus', 'ja', '~300 MB');
  assert.strictEqual(opus.title, 'Download the Japanese to English translation pack (about 300 MB)?');
  assert.match(opus.what, /Japanese subtitles to English/);
  const diarize = copy('diarize', '', '~35 MB');
  assert.strictEqual(diarize.title, 'Download the speaker detection models (about 35 MB)?');
  assert.strictEqual(diarize.them, true);
  assert.strictEqual(copy('whisper', 'large-v3-turbo', '').title, 'Download the subtitles model?');
  for (const c of [whisper, opus, diarize, copy('other', 'x', '')]) {
    const all = [c.title, c.what, c.decline].join(' ');
    assert.doesNotMatch(all, /large-v3|turbo|huggingface|whisper|→|—/i, all);
    assert.doesNotMatch(all, EMOJI, all);
    assert.match(c.decline, /\.$/, 'decline is a full sentence');
  }
});
