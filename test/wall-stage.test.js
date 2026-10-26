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
const stageSettings = require('../lib/stage/settings');
const { createHub, validateCommand, validateReport, MAX_SPEC_BYTES } = require('../lib/stage/hub');
const ring = require('../lib/stream/ring');

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

/* ── The hub: commands and reports ──────────────────────────────────────── */

const wallCmd = (o = {}) => ({ type: 'wall', cfg: { v: 2, source: 'c:1', sound: 'auto', playing: 4 }, spec: { collectionId: 1 }, label: 'Friday stream', ...o });

test('wall commands are checked: settings clamped as the Wall reads them, the spec bounded', () => {
  const ok = validateCommand(wallCmd({ cfg: { v: 2, playing: 99, colWidth: 'x', source: 'drop table', keepPlaying: true, evil: 1 } }));
  assert.ok(ok.ok);
  assert.strictEqual(ok.cmd.cfg.playing, 16);
  assert.strictEqual(ok.cmd.cfg.colWidth, 390);
  assert.strictEqual(ok.cmd.cfg.source, 'library');
  assert.ok(!('evil' in ok.cmd.cfg), 'unknown keys never travel');
  assert.deepStrictEqual(ok.cmd.spec, { collectionId: 1 });
  assert.strictEqual(ok.cmd.label, 'Friday stream');
  assert.strictEqual(ok.cmd.paused, false);
  assert.strictEqual(ok.cmd.from, null);
  assert.strictEqual(validateCommand(wallCmd({ label: undefined })).cmd.label, 'The Wall');
  assert.strictEqual(validateCommand(wallCmd({ label: 'x'.repeat(500) })).cmd.label.length, 120);
  assert.strictEqual(validateCommand(wallCmd({ spec: undefined })).ok, true, 'no spec: the whole library');
  assert.strictEqual(validateCommand(wallCmd({ paused: true, from: 'pabc123' })).cmd.from, 'pabc123');
  for (const bad of [
    { cfg: undefined }, { cfg: [1] }, { cfg: 'x' },
    { spec: [] }, { spec: 'x' }, { spec: { search: { text: 'x'.repeat(MAX_SPEC_BYTES) } } },
    { label: 5 }, { paused: 'yes' }, { from: 'no spaces' }, { from: 7 },
  ]) assert.strictEqual(validateCommand(wallCmd(bad)).ok, false, JSON.stringify(bad).slice(0, 60));
  assert.deepStrictEqual(validateCommand({ type: 'wallShuffle' }), { ok: true, cmd: { type: 'wallShuffle' } });
  assert.deepStrictEqual(validateCommand({ type: 'wallOff', extra: 1 }), { ok: true, cmd: { type: 'wallOff' } });
});

test('wall reports are checked: a known state, counts, at most six peek ids', () => {
  const r = validateReport({ type: 'wall', state: 'running', clips: 9, blocks: 24, running: true, paused: false, message: '', ids: [1, 2, 'x', -3, 4, 5, 6, 7, 8, 9] });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.rep.ids, [1, 2, 4, 5, 6, 7]);
  assert.strictEqual(r.rep.clips, 9);
  assert.strictEqual(validateReport({ type: 'wall', state: 'running', clips: -1 }).rep.clips, 0);
  assert.strictEqual(validateReport({ type: 'wall', state: 'running', message: 'x'.repeat(900) }).rep.message.length, 300);
  assert.strictEqual(validateReport({ type: 'wall', state: 'dancing' }).ok, false);
  assert.strictEqual(validateReport({ type: 'wall' }).ok, false);
  // Stage's status while the Wall is on it.
  assert.strictEqual(validateReport({ type: 'status', key: null, state: 'wall', paused: false }).ok, true);
});

/** A server-sent event stream that records what it was sent. */
function fakeStream() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.out = '';
  res.writeHead = () => {};
  res.write = (s) => { res.out += s; return true; };
  res.end = () => { res.ended = true; res.emit('close'); };
  res.events = () => res.out.split('\n\n').filter(b => b.startsWith('event: ')).map((b) => {
    const [e, d] = b.split('\n');
    return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
  });
  return { req, res };
}

function hubFor({ alive = false } = {}) {
  const calls = [];
  const hub = createHub({
    host: { alive: () => alive, close: () => calls.push('close'), front: () => {}, size: () => {}, setTitle: () => {} },
    graceMs: 30, openGraceMs: 60, heartbeatMs: 0,
    settings: { get: () => stageSettings.normalize({}), sizes: stageSettings.OPEN_SIZES, presets: stageSettings.SIZE_PRESETS },
  });
  return { hub, calls };
}

const item = (key, id) => ({ key, id, media_type: 'video', filename: `f${id}.mp4`, duration: 30 });
const last = (s, name) => s.res.events().filter(e => e.event === name).pop();

test('hub: the Wall needs an open Stage; shown, it replaces the file and Stage and the other tabs are told', () => {
  const { hub } = hubFor();
  assert.strictEqual(hub.command(wallCmd()).status, 409);
  hub.opened('popup');
  const ctl = fakeStream();
  const st = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.attach('stage', st.req, st.res);
  hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2)] });
  assert.strictEqual(hub.command(wallCmd({ from: 'pme' })).status, 200);
  const s = hub.state();
  assert.strictEqual(s.current, null, 'Stage stops showing a file');
  assert.deepStrictEqual(s.upcoming, [], 'files wait');
  assert.strictEqual(s.wall.label, 'Friday stream');
  assert.strictEqual(s.status.state, 'wall');
  assert.strictEqual(last(st, 'wall').data.cfg.playing, 4);
  assert.strictEqual(last(ctl, 'cmd').data.type, 'wall');
  assert.strictEqual(last(ctl, 'cmd').data.from, 'pme', 'the sending tab knows its own change');
  // A Stage that (re)connects gets the Wall at once.
  const st2 = fakeStream();
  hub.attach('stage', st2.req, st2.res);
  assert.strictEqual(last(st2, 'sync').data.wall.spec.collectionId, 1);
  hub.close();
});

test('hub: play and pause pause the Wall; seeking is refused; a report updates the remote', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const ctl = fakeStream();
  const st = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.attach('stage', st.req, st.res);
  hub.command(wallCmd({ from: 'pme' }));
  assert.strictEqual(hub.command({ type: 'pause' }).status, 200);
  assert.strictEqual(hub.state().wall.paused, true);
  const w = last(st, 'wall').data;
  assert.strictEqual(w.paused, true, 'Stage gets the Wall paused, not a file pause');
  assert.strictEqual(w.from, null, 'every tab mirrors it, the sender too');
  assert.strictEqual(last(ctl, 'cmd').data.type, 'wall');
  hub.command({ type: 'play' });
  assert.strictEqual(hub.state().wall.paused, false);
  const seek = hub.command({ type: 'seek', t: 4 });
  assert.strictEqual(seek.status, 409);
  assert.strictEqual(seek.body.code, 'WALL_ON_STAGE');
  assert.strictEqual(hub.report({ type: 'wall', state: 'running', clips: 9, ids: [3, 4] }).status, 200);
  assert.strictEqual(hub.state().wallStatus.clips, 9);
  assert.strictEqual(last(ctl, 'wallStatus').data.clips, 9);
  assert.strictEqual(hub.command({ type: 'wallShuffle' }).status, 200);
  assert.ok(last(st, 'wallShuffle'));
  hub.close();
});

test('hub: Back to one file at a time, Stop, and a file played on Stage all end the Wall there', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const st = fakeStream();
  hub.attach('stage', st.req, st.res);
  hub.command(wallCmd());
  hub.report({ type: 'wall', state: 'running', clips: 2 });
  assert.strictEqual(hub.command({ type: 'wallOff' }).status, 200);
  assert.strictEqual(hub.state().wall, null);
  assert.strictEqual(hub.state().wallStatus, null);
  assert.strictEqual(hub.state().status.state, 'black', 'Stop: black until a file comes');
  assert.ok(last(st, 'wallOff'));
  assert.strictEqual(hub.command({ type: 'wallOff' }).body.already, true);
  assert.strictEqual(hub.command({ type: 'wallShuffle' }).status, 409, 'nothing to shuffle');
  // A late report from the Wall that left is not taken.
  assert.strictEqual(hub.report({ type: 'wall', state: 'running', clips: 5 }).body.stale, true);
  assert.strictEqual(hub.state().wallStatus, null);
  // A report never starts the Wall: only Control's command does (roles).
  assert.strictEqual(hub.state().wall, null);
  // A file played on Stage replaces the Wall.
  hub.command(wallCmd());
  hub.command({ type: 'load', item: item('b1', 7) });
  assert.strictEqual(hub.state().wall, null);
  assert.strictEqual(hub.state().current.key, 'b1');
  // Play and pause are the file's again.
  hub.command({ type: 'pause' });
  assert.strictEqual(hub.state().paused, true);
  assert.strictEqual(last(st, 'pause').data.type, 'pause');
  hub.close();
});

test('hub: a lock blacks the Wall out at once and keeps it for after the unlock, under Hold', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const ctl = fakeStream();
  const st = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.attach('stage', st.req, st.res);
  hub.command(wallCmd());
  hub.lock();
  assert.ok(st.res.events().some(e => e.event === 'locked'));
  assert.ok(st.res.ended, 'Stage’s stream is ended: it goes black and stops');
  assert.strictEqual(hub.command(wallCmd()).status, 423);
  assert.strictEqual(hub.command({ type: 'wallOff' }).status, 423);
  assert.strictEqual(hub.report({ type: 'wall', state: 'running' }).status, 423);
  hub.unlock();
  const st2 = fakeStream();
  hub.attach('stage', st2.req, st2.res);
  const sync = last(st2, 'sync').data;
  assert.strictEqual(sync.hold, true, 'back under Hold');
  assert.strictEqual(sync.resume, true, 'it was playing: Hold off carries on');
  assert.ok(sync.wall, 'the Wall comes back with it');
  hub.close();
});

test('hub: closing Stage with the Wall on it ends the Wall and says so; a new Stage starts on files', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const ctl = fakeStream();
  const st = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.attach('stage', st.req, st.res);
  hub.command(wallCmd());
  hub.hostExited({ byUser: true });
  const closed = last(ctl, 'closed').data;
  assert.strictEqual(closed.wall, true, 'Control brings the Wall back to its tab');
  assert.strictEqual(closed.current, null);
  assert.strictEqual(hub.state().wall, null);
  hub.opened('popup');
  assert.strictEqual(hub.state().wall, null);
  hub.close();
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

test('stream tokens: Wall on Stage tokens are "stage-" + UUID, in the closed-token scope, with or without randomUUID', () => {
  const withUuid = Wall._pure.tokenFor('stage', crypto);
  const fallback = Wall._pure.tokenFor('stage', { getRandomValues: (b) => crypto.randomFillSync(b) });
  const noCrypto = Wall._pure.tokenFor('stage', null);
  for (const t of [withUuid, fallback, noCrypto]) {
    assert.match(t, /^stage-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.strictEqual(ring.isWallToken(t), true);
  }
  assert.match(Wall._pure.tokenFor('wall', crypto), /^wall-/);
  assert.notStrictEqual(Wall._pure.tokenFor('stage', crypto), Wall._pure.tokenFor('stage', crypto));
});

test('stream tokens: closing a Stage clip never refuses Control’s Wall clip or its player on the same file', () => {
  const id = 900001;
  const stageTok = Wall._pure.tokenFor('stage', crypto);
  const wallTok = Wall._pure.tokenFor('wall', crypto);
  const playerTok = 'p' + crypto.randomBytes(6).toString('hex');
  ring.wallSeen(id, stageTok);
  ring.wallSeen(id, wallTok);
  ring.closeWallClient(id, stageTok);
  assert.strictEqual(ring.wallClosed(id, stageTok), true, 'the closed Stage clip’s late requests are refused');
  assert.strictEqual(ring.wallClosed(id, wallTok), false, 'Control’s Wall clip is untouched');
  assert.strictEqual(ring.wallClosed(id, playerTok), false, 'the player is never in this scope');
  ring.closeWallClient(id, wallTok);
  assert.strictEqual(ring.wallClosed(id, wallTok), true);
  ring.forget(id);
});

/* ── The pages load the pieces in order ─────────────────────────────────── */

test('pages: the Stage page and the Vault page load the Wall rules before the Wall', () => {
  const order = (html, names) => names.map(n => html.indexOf(`src="./player-lib/${n}"`));
  const stage = fs.readFileSync(path.join(ROOT, 'player-lib', 'stage.html'), 'utf8');
  const [rules, wall, stageJs, decide] = order(stage, ['wall-rules.js', 'wall.js', 'stage.js', 'playback-decide.js']);
  assert.ok(rules > 0 && rules < wall && wall < stageJs && decide < wall, 'stage.html: rules, then the Wall, then Stage');
  assert.ok(stage.includes('css/wall.css'));
  const page = fs.readFileSync(path.join(ROOT, 'db-viewer.html'), 'utf8');
  const [r2, w2, c2] = order(page, ['wall-rules.js', 'wall.js', 'stage-control.js']);
  assert.ok(r2 > 0 && r2 < w2 && r2 < c2, 'db-viewer.html: rules before the Wall and the remote');
});

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

test('wall spec size is measured in bytes (UTF-8), as the error says', () => {
  const big = { search: { text: 'é'.repeat(16000) } };            // 16,000 characters, about 32 KB
  assert.ok(JSON.stringify(big).length < MAX_SPEC_BYTES, 'short enough in characters');
  assert.strictEqual(validateCommand(wallCmd({ spec: big })).ok, false, 'too big in bytes');
  assert.strictEqual(validateCommand(wallCmd({ spec: { search: { text: 'é'.repeat(7000) } } })).ok, true);
});

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
