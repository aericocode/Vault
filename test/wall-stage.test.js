/**
 * The Wall on Stage (PLAYLISTS_SPEC, Stage decisions 6 and 8) and the Wall
 * that keeps playing when hidden.
 *
 *  - player-lib/wall-rules.js   settings (keepPlaying), what a change redoes,
 *                               the visibility rule, the remote's line
 *  - lib/stage/hub.js           the wall commands and reports, lock, roles
 *  - player-lib/wall.js         the seams the Stage page uses (its host, its
 *                               stream tokens), in a VM
 *  - lib/stream/ring.js         Stage's tokens never close Control's
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WallRules = require('../player-lib/wall-rules');

const ROOT = path.join(__dirname, '..');

/* ── The visibility rule ────────────────────────────────────────────────── */

test('visibility: a hidden tab pauses the Wall unless it keeps playing; Stage always keeps playing', () => {
  const act = (o) => WallRules.visibilityAction({ reason: 'page', ...o });
  assert.strictEqual(act({ visibility: 'visible' }), 'run');
  assert.strictEqual(act({ visibility: 'hidden' }), 'pause', 'today’s resource saving stays the default');
  assert.strictEqual(act({ visibility: 'hidden', keepPlaying: true }), 'run');
  assert.strictEqual(act({ visibility: 'hidden', onStage: true }), 'run');
  assert.strictEqual(act({ visibility: 'hidden', onStage: true, keepPlaying: false }), 'run', 'the setting never stops Stage');
  assert.strictEqual(act({ visibility: 'visible', onStage: true }), 'run');
  // Only a real true counts.
  assert.strictEqual(act({ visibility: 'hidden', keepPlaying: 'yes' }), 'pause');
  assert.strictEqual(WallRules.visibilityAction(), 'run', 'no facts: a visible page');
});

test('visibility: a clip the browser paused is played again only where the Wall keeps playing and nobody paused it', () => {
  const act = (o) => WallRules.visibilityAction({ reason: 'clip', ...o });
  // Chromium pauses muted videos in hidden pages: undone where the Wall keeps playing.
  assert.strictEqual(act({ visibility: 'hidden', keepPlaying: true }), 'replay');
  assert.strictEqual(act({ visibility: 'hidden', onStage: true }), 'replay');
  // Stage: nobody touches its clips, so any pause the Wall did not ask for is undone, hidden or not.
  assert.strictEqual(act({ visibility: 'visible', onStage: true }), 'replay');
  // A tab that pauses when hidden: leave it (the Wall pauses itself anyway).
  assert.strictEqual(act({ visibility: 'hidden' }), 'ignore');
  // A tab in view: a pause the Wall did not ask for is the user's (a media key).
  assert.strictEqual(act({ visibility: 'visible', keepPlaying: true }), 'ignore');
  assert.strictEqual(act({ visibility: 'visible' }), 'ignore');
});

/* ── Settings ───────────────────────────────────────────────────────────── */

test('settings: "Keep playing when this tab is hidden" is off unless turned on, and survives a save', () => {
  assert.strictEqual(WallRules.cfgFrom({}).keepPlaying, false);
  assert.strictEqual(WallRules.cfgFrom({ v: 2, keepPlaying: true }).keepPlaying, true);
  assert.strictEqual(WallRules.cfgFrom({ v: 2, keepPlaying: 1 }).keepPlaying, false);
  assert.strictEqual(WallRules.cfgFrom(undefined).keepPlaying, false);
  const c = WallRules.cfgFrom({ v: 2, keepPlaying: true, sound: 'auto', mode: 'scroll' });
  assert.deepStrictEqual(WallRules.cfgFrom(JSON.parse(JSON.stringify(c))), c);
});

test('settings changes: only what changed is redone on a board that is up', () => {
  const base = WallRules.cfgFrom({ v: 2 });
  const ch = (patch) => {
    const out = WallRules.cfgChanges(base, WallRules.cfgFrom({ ...base, ...patch }));
    return Object.keys(out).filter(k => out[k]).sort();
  };
  assert.deepStrictEqual(ch({}), [], 'nothing changed: nothing to do');
  assert.deepStrictEqual(ch({ source: 'c:3' }), ['pool']);
  assert.deepStrictEqual(ch({ mix: 'videos' }), ['pool']);
  assert.deepStrictEqual(ch({ order: 'order' }), ['pool']);
  assert.deepStrictEqual(ch({ directOnly: true }), ['pool']);
  assert.deepStrictEqual(ch({ colWidth: 500 }), ['plan']);
  assert.deepStrictEqual(ch({ gap: 8 }), ['plan']);
  assert.deepStrictEqual(ch({ mode: 'scroll' }), ['clips', 'plan'], 'clips loop in Scroll: retimed too');
  assert.deepStrictEqual(ch({ picSpeed: 3 }), ['stills']);
  assert.deepStrictEqual(ch({ clipLen: 60 }), ['clips']);
  assert.deepStrictEqual(ch({ clipsToEnd: true }), ['clips']);
  assert.deepStrictEqual(ch({ playing: 2 }), ['playing']);
  assert.deepStrictEqual(ch({ sound: 'auto' }), ['sound']);
  assert.deepStrictEqual(ch({ pauseOnHover: false }), ['hover']);
  assert.deepStrictEqual(ch({ keepPlaying: true }), ['visible']);
  assert.deepStrictEqual(ch({ scrollSpeed: 9 }), [], 'read on every frame');
  assert.deepStrictEqual(Object.values(WallRules.cfgChanges(null, base)).filter(Boolean).length > 0, true, 'from nothing: everything');
});

test('the remote’s line: source, clips, sound, as the mockup has it; no dashes', () => {
  assert.strictEqual(WallRules.wallLine({ label: 'Friday stream', clips: 9, sound: 'auto' }), 'Friday stream · 9 clips · sound Auto');
  assert.strictEqual(WallRules.wallLine({ label: 'Library', clips: 1, sound: 'off' }), 'Library · 1 clip · sound Off');
  assert.strictEqual(WallRules.wallLine({ label: 'Library', mix: 'pictures', sound: 'hover' }), 'Library · pictures · sound On hover');
  assert.strictEqual(WallRules.wallLine({ label: '', state: 'loading', sound: 'auto' }), 'The Wall · getting ready · sound Auto');
  assert.strictEqual(WallRules.wallLine({ label: 'X', state: 'empty' }), 'X · nothing to show · sound Off');
  assert.strictEqual(WallRules.wallLine({ label: 'X', clips: 3, paused: true }), 'X · 3 clips · sound Off · paused');
  assert.strictEqual(WallRules.wallLine({ label: 'X', clips: -4, sound: 'loud' }), 'X · 0 clips · sound Off');
  for (const s of ['loading', 'running', 'empty', 'error']) assert.doesNotMatch(WallRules.wallLine({ state: s }), /—|–/);
});

/* ── Stream tokens: Stage's never close Control's ───────────────────────── */

function loadWall() {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'player-lib', f), 'utf8');
  const ctx = { window: {}, document: {}, console, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Uint8Array };
  vm.createContext(ctx);
  vm.runInContext(`${read('wall-rules.js')}\n${read('wall.js')}\nglobalThis.__wall = Wall;`, ctx);
  return ctx.__wall;
}
const Wall = loadWall();

test('the Wall on Stage runs with Stage’s own host: no chrome, "stage-" tokens, rows and sound from Stage', () => {
  const calls = [];
  const h = Wall._pure.stageHost('root', {
    query: (s) => calls.push(['q', s]), fetchRows: (ids) => calls.push(['r', ids]), soundLevel: () => 0.4, status: () => {},
  }, () => ({ collectionId: 7 }));
  assert.strictEqual(h.chrome, false);
  assert.strictEqual(h.onStage, true);
  assert.strictEqual(h.tokenPrefix, 'stage');
  assert.deepStrictEqual(h.baseSpec(), { collectionId: 7 });
  assert.strictEqual(h.soundLevel(), 0.4);
  h.pin([1, 2]);   // nothing to pin on Stage
  h.query({ a: 1 });
  h.fetchRows([5]);
  assert.deepStrictEqual(calls, [['q', { a: 1 }], ['r', [5]]]);
  const v = Wall._pure.vaultHost();
  assert.strictEqual(v.chrome, true);
  assert.strictEqual(v.onStage, false);
  assert.strictEqual(v.tokenPrefix, 'wall');
  // The same settings rules in the Wall and in the hub.
  assert.strictEqual(JSON.stringify(Wall._pure.cfgFrom({ playing: 99 })), JSON.stringify(WallRules.cfgFrom({ playing: 99 })));
});

/* ── The pages load the pieces in order ─────────────────────────────────── */

test('copy: the new Wall and Stage words have no dashes', () => {
  for (const f of ['player-lib/wall.js', 'player-lib/stage-control.js', 'player-lib/wall-rules.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const phrase of ['Show on Stage', 'Keep playing when this tab is hidden', 'Back to one file at a time', 'Wall on Stage']) {
      if (!src.includes(phrase)) continue;
      const lines = src.split('\n').filter(l => l.includes(phrase));
      for (const l of lines) assert.doesNotMatch(l, /—|–/, `${f}: ${l.trim().slice(0, 80)}`);
    }
  }
});

/* ── Follow-ups: spec size in bytes, a slider change racing the remote's pause ── */

test('echoes: a tab never takes settings from its own change, nor while a change of its own is on its way', () => {
  assert.strictEqual(WallRules.takeEchoCfg({ mine: false, pendingLocal: false }), true, 'another tab’s change');
  assert.strictEqual(WallRules.takeEchoCfg({ mine: true, pendingLocal: false }), false);
  assert.strictEqual(WallRules.takeEchoCfg({ mine: false, pendingLocal: true }), false, 'a slider just moved here wins');
  assert.strictEqual(WallRules.takeEchoCfg(), true);
});

function wallWithStage() {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'player-lib', f), 'utf8');
  const sent = [];
  const sc = { on: true, cfg: null, paused: false, mine: true, label: 'Friday stream', status: null, hold: false };
  const timers = [];
  const ctx = {
    window: { vaultWallSettings: () => ({ v: 2, source: 'c:1', colWidth: 300, sound: 'auto' }), vaultSetWallSettings: () => {} },
    document: {}, console, Math, Number, String, Array, Object, JSON, Map, Set, Promise, Uint8Array,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    StageControl: {
      wallState: () => ({ ...sc }),
      updateWall: (p) => { sent.push({ type: 'wall', ...JSON.parse(JSON.stringify(p)) }); sc.cfg = p.cfg; sc.paused = p.paused; sc.mine = true; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${read('wall-rules.js')}\n${read('wall.js')}\nglobalThis.__wall = Wall;`, ctx);
  const runTimers = () => { const fns = timers.splice(0); for (const f of fns) if (f) f(); };
  return { W: ctx.__wall, sc, sent, runTimers };
}

test('race: a slider moved just before the remote’s pause is kept (the pause goes as the whole, latest Wall)', () => {
  const { W, sc, sent, runTimers } = wallWithStage();
  W.stageChanged();                                       // the Wall is on Stage: this tab is its remote
  assert.strictEqual(W._stats().remote, true);
  W._remoteChange({ colWidth: 600 });                      // the slider moves; its push waits 120 ms
  assert.strictEqual(sent.length, 0);
  // The hub answers another play/pause with its older copy (from: null, so mine is false).
  sc.cfg = { ...W._cfg(), colWidth: 300 }; sc.mine = false; sc.paused = false;
  W.stageChanged();
  assert.strictEqual(W._cfg().colWidth, 600, 'the older echo does not undo the slider');
  // The remote's pause, inside the wait: one full Wall, the latest settings, paused.
  assert.strictEqual(W.stagePause(true), true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].cfg.colWidth, 600);
  assert.strictEqual(sent[0].paused, true);
  assert.strictEqual(sent[0].label, 'Friday stream', 'the name Stage has, before the tab was ever shown');
  runTimers();
  assert.strictEqual(sent.length, 1, 'the waiting push was sent with it, not again with old settings');
  // With nothing of its own on the way, another tab's change is followed.
  sc.cfg = { ...W._cfg(), colWidth: 800 }; sc.mine = false;
  W.stageChanged();
  assert.strictEqual(W._cfg().colWidth, 800);
});
