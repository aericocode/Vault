/**
 * Games copy (player-lib/games/games.js): the "works with" toast names the
 * file types in plain words ("videos, GIFs and pictures"), not the raw
 * media_type list ("video, gif, image").
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const noop = () => {};

function loadGames() {
  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    createElement: () => ({ classList: { add: noop, remove: noop }, appendChild: noop, style: {} }),
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, Promise,
    document: doc,
    window: { addEventListener: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    escapeHtml: (x) => String(x ?? ''),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'games', 'games.js'), 'utf8'), ctx);
  return ctx;
}

test('gamesTypeList: plain words, joined with commas and "and"', () => {
  const ctx = loadGames();
  const list = (types) => vm.runInContext(`gamesTypeList(${JSON.stringify(types)})`, ctx);
  assert.strictEqual(list(['video']), 'videos');
  assert.strictEqual(list(['video', 'image']), 'videos and pictures');
  assert.strictEqual(list(['video', 'gif', 'image']), 'videos, GIFs and pictures');
  assert.strictEqual(list(['audio']), 'audio files');
  assert.strictEqual(list([]), '');
});
