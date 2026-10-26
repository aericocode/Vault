/**
 * The Wall keeps playing in the background (PLAYLISTS_SPEC "Stage host,
 * final"), and the Wall on Stage is gone.
 *
 *  - player-lib/wall-rules.js   the setting (on by default) and the
 *                               visibility rule
 *  - player-lib/wall.js         hidden pages: clips the browser pauses are
 *                               played again, the tick comes from a worker;
 *                               no Stage pieces left (in a VM and in source)
 *  - lib/stage/hub.js, stage-control.js   no Wall commands or remote mode
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WallRules = require('../player-lib/wall-rules');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ── The visibility rule ────────────────────────────────────────────────── */

test('visibility: the Wall keeps playing when its page is hidden unless that is turned off', () => {
  const act = (o) => WallRules.visibilityAction({ reason: 'page', ...o });
  assert.strictEqual(act({ visibility: 'visible' }), 'run');
  assert.strictEqual(act({ visibility: 'hidden' }), 'run', 'on by default');
  assert.strictEqual(act({ visibility: 'hidden', keepPlaying: true }), 'run');
  assert.strictEqual(act({ visibility: 'hidden', keepPlaying: false }), 'pause', 'turned off: a hidden tab saves power');
  assert.strictEqual(act({ visibility: 'visible', keepPlaying: false }), 'run');
  assert.strictEqual(WallRules.visibilityAction(), 'run', 'no facts: a visible page');
});

test('visibility: a clip the browser paused is played again only in a hidden page where the Wall keeps playing', () => {
  const act = (o) => WallRules.visibilityAction({ reason: 'clip', ...o });
  // Chromium pauses muted videos in hidden pages: undone.
  assert.strictEqual(act({ visibility: 'hidden' }), 'replay');
  assert.strictEqual(act({ visibility: 'hidden', keepPlaying: true }), 'replay');
  // Turned off: the Wall pauses itself anyway.
  assert.strictEqual(act({ visibility: 'hidden', keepPlaying: false }), 'ignore');
  // A page in view: a pause the Wall did not ask for is the user's (a media key), and stays.
  assert.strictEqual(act({ visibility: 'visible' }), 'ignore');
  assert.strictEqual(act({ visibility: 'visible', keepPlaying: true }), 'ignore');
});

/* ── The setting ────────────────────────────────────────────────────────── */

test('settings: "Keep playing when this tab is hidden" is on by default (new and old settings), off only when turned off since, and survives a save', () => {
  assert.strictEqual(WallRules.cfgFrom({}).keepPlaying2, true);
  assert.strictEqual(WallRules.cfgFrom(undefined).keepPlaying2, true);
  assert.strictEqual(WallRules.cfgFrom({ v: 2, sound: 'auto' }).keepPlaying2, true, 'settings saved before the setting existed');
  // Test builds stored the earlier keepPlaying:false on every save: that no longer counts.
  assert.strictEqual(WallRules.cfgFrom({ v: 2, keepPlaying: false }).keepPlaying2, true);
  assert.ok(!('keepPlaying' in WallRules.cfgFrom({ v: 2, keepPlaying: false })), 'the old key is dropped on the next save');
  assert.strictEqual(WallRules.cfgFrom({ v: 2, keepPlaying2: false }).keepPlaying2, false, 'turned off since: off');
  assert.strictEqual(WallRules.cfgFrom({ v: 2, keepPlaying: true, keepPlaying2: false }).keepPlaying2, false);
  const off = WallRules.cfgFrom({ v: 2, keepPlaying2: false, mode: 'scroll' });
  assert.deepStrictEqual(WallRules.cfgFrom(JSON.parse(JSON.stringify(off))), off);
});

test('the Wall reads its settings with the same rules (one copy, in wall-rules.js, loaded first)', () => {
  const ctx = { window: {}, document: {}, console, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Uint8Array };
  vm.createContext(ctx);
  vm.runInContext(`${read('player-lib/wall-rules.js')}\n${read('player-lib/wall.js')}\nglobalThis.__wall = Wall;`, ctx);
  const W = ctx.__wall;
  assert.strictEqual(JSON.stringify(W._pure.cfgFrom({ playing: 99 })), JSON.stringify(WallRules.cfgFrom({ playing: 99 })));
  assert.ok(!('stage' in W) && !('stageChanged' in W) && !('stagePause' in W));
  assert.ok(!W._pure.stageHost && !W._pure.vaultHost);
  const html = read('db-viewer.html');
  assert.ok(html.indexOf('player-lib/wall-rules.js') !== -1 && html.indexOf('player-lib/wall-rules.js') < html.indexOf('player-lib/wall.js'));
});

/* ── Hidden pages in wall.js ────────────────────────────────────────────── */

test('wall.js: in a hidden page clips the browser pauses are played again, and the tick comes from a worker', () => {
  const src = read('player-lib/wall.js');
  assert.match(src, /v\.addEventListener\('pause', \(\) => clipPaused\(b, rec\)\)/, 'a clip paused by the browser is noticed');
  assert.match(src, /if \(pageAction\('clip'\) === 'replay'\) replayHeld\(\);/, 'the tick plays held clips again');
  assert.match(src, /new Worker\(tickWorkerUrl\)/, 'a worker drives the tick while hidden');
  assert.match(src, /setInterval\(\(\) => postMessage\(0\), \$\{TICK_MS\}\)/, 'the worker does nothing but keep time');
  assert.match(src, /workerTicks\(running && document\.visibilityState === 'hidden'\)/);
  assert.match(src, /workerTicks\(false\)/, 'stopped with the Wall');
  assert.match(src, /id="wallKeepPlaying"/, 'the setting stays in the gear popover');
});

/* ── The Wall on Stage is gone ──────────────────────────────────────────── */

test('the Wall on Stage is gone: no button, panel, remote mode, hub commands or styles', () => {
  const wall = read('player-lib/wall.js');
  for (const w of ['Show on Stage', 'wallStageBtn', 'wall-onstage', 'StageControl', 'stageHost', 'tokenPrefix', 'pushToStage', 'Back to one file at a time']) {
    assert.ok(!wall.includes(w), `wall.js still has ${w}`);
  }
  const control = read('player-lib/stage-control.js');
  for (const w of ['showWall', 'updateWall', 'wallOff', 'wallState', 'wallShuffle', 'Wall on Stage', 'mini-stage-wall', 'wallStatus']) {
    assert.ok(!control.includes(w), `stage-control.js still has ${w}`);
  }
  for (const f of ['css/wall.css', 'css/stage-remote.css']) {
    const css = read(f);
    assert.ok(!/wall-onstage|mini-stage-wall/.test(css), `${f} still styles the Wall on Stage`);
  }
  const { validateCommand } = require('../lib/stage/hub');
  for (const type of ['wall', 'wallShuffle', 'wallOff']) assert.strictEqual(validateCommand({ type, cfg: {} }).ok, false, type);
  const rules = read('player-lib/wall-rules.js');
  assert.ok(!/onStage|wallLine|takeEchoCfg|cfgChanges/.test(rules));
});

test('copy: the Wall’s words have no dashes', () => {
  for (const f of ['player-lib/wall.js', 'player-lib/wall-rules.js']) {
    for (const l of read(f).split('\n').filter(x => /Keep playing when this tab is hidden|keeps playing|hidden page/i.test(x))) {
      assert.doesNotMatch(l, /—|–/, `${f}: ${l.trim().slice(0, 80)}`);
    }
  }
});
