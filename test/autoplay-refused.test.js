/**
 * Hands-free playback that stops, said out loud:
 *  - player-stream.js _startPlayback: the browser's autoplay block
 *    (NotAllowedError) on a file the queue moved to by itself logs a
 *    "[Vault next]" line and shows one toast (at most one a minute); an
 *    AbortError (a teardown, a newer source) stays quiet, as before;
 *  - player-core.js autoAdvanceDiag: a file ending that moved nowhere logs
 *    where the list stood, and never throws.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** One top-level function of a browser script, by how it starts. */
function grab(src, sig) {
  const at = src.indexOf(sig);
  assert.ok(at >= 0, `${sig} is there`);
  let depth = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${sig}: no end`);
}

function starter(source) {
  const src = read('player-lib/player/player-stream.js');
  const warns = [];
  const toasts = [];
  const ctx = {
    console: { warn: (...a) => warns.push(a.join(' ')) },
    showToast: (m) => toasts.push(m),
    Date,
  };
  vm.createContext(ctx);
  vm.runInContext(`let lastPlaySource = ${JSON.stringify(source)};\nlet _autoplayToastAt = 0;\n${grab(src, 'function _startPlayback(')}\n${grab(src, 'function _playRefused(')}\nglobalThis.__s = { _startPlayback, setSource: (s) => { lastPlaySource = s; } };`, ctx);
  return { ...ctx.__s, warns, toasts };
}

const refusing = (name) => ({ isConnected: true, play: () => { const e = new Error('blocked'); e.name = name; return Promise.reject(e); } });
const tick = () => new Promise(r => setImmediate(r));

test('autoplay blocked on a file the queue moved to: one line and one toast', async () => {
  const s = starter('auto');
  s._startPlayback(refusing('NotAllowedError'));
  await tick();
  assert.strictEqual(s.warns.length, 1);
  assert.match(s.warns[0], /^\[Vault next\] The browser blocked/);
  assert.strictEqual(s.toasts.length, 1);
  assert.doesNotMatch(s.toasts[0], /—/, 'no em dash in the copy');
  s._startPlayback(refusing('NotAllowedError'));
  await tick();
  assert.strictEqual(s.warns.length, 2, 'every refusal is logged');
  assert.strictEqual(s.toasts.length, 1, 'but the toast shows at most once a minute');
});

test('autoplay blocked on a file opened by hand: logged, no toast', async () => {
  const s = starter('user');
  s._startPlayback(refusing('NotAllowedError'));
  await tick();
  assert.strictEqual(s.warns.length, 1);
  assert.strictEqual(s.toasts.length, 0);
});

test('an aborted start (teardown, newer source) stays quiet; a start that works says nothing', async () => {
  const s = starter('auto');
  s._startPlayback(refusing('AbortError'));
  s._startPlayback({ isConnected: true, play: () => Promise.resolve() });
  s._startPlayback({ isConnected: false, play: () => { const e = new Error('x'); e.name = 'NotAllowedError'; return Promise.reject(e); } });
  await tick();
  assert.deepStrictEqual([s.warns, s.toasts], [[], []]);
});

test('a play() that throws at once (old browsers) is caught too', () => {
  const s = starter('auto');
  assert.doesNotThrow(() => s._startPlayback({ isConnected: true, play: () => { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; } }));
  assert.strictEqual(s.toasts.length, 1);
});

test('autoAdvanceDiag: says where the list stood, and never throws', () => {
  const core = read('player-lib/player/player-core.js');
  const warns = [];
  const L = { length: () => 40, known: () => true, ids: new Uint32Array(40) };
  const ctx = {
    console: { warn: (...a) => warns.push(a) },
    Library: L,
    queueList: () => L,
    queueSkipSet: () => new Set([5, 6]),
    listAnchorIndex: () => 38,
    upNextCount: () => 0,
    repeatMode: () => 'off',
    document: { hidden: true },
  };
  vm.createContext(ctx);
  vm.runInContext(`${grab(core, 'function autoAdvanceDiag(')}\nglobalThis.__d = autoAdvanceDiag;`, ctx);
  ctx.__d('nothing left to move on to');
  assert.match(warns[0][0], /^\[Vault next\] A file ended but playback did not move on: nothing left to move on to\./);
  assert.deepStrictEqual({ ...warns[0][1] }, { at: 38, of: 40, countKnown: true, idsLoaded: true, ownList: false, skipped: 2, upNext: 0, repeat: 'off', collection: null, tabHidden: true });
  ctx.queueList = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => ctx.__d('x'));
  assert.strictEqual(warns.length, 2);
});
