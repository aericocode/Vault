/**
 * The countdown to the end of what Stage plays (QOL countdown):
 *
 *  - player-lib/stage-countdown.js   the rules: warnings once per run, none
 *                                     for times already passed, none on a
 *                                     jump; the running clock; the settings
 *  - player-lib/playlist-time.js     time left at a playback speed
 *  - player-lib/stage-rules.js       upcomingPlan: is that all Stage plays
 *  - lib/stage/mpv-overlay.js        what is drawn: only times, in a corner
 *  - lib/stage/engine.js             the time left from mpv, drawn with
 *                                     osd-overlay, sent to Control
 *  - lib/stage/hub.js, settings.js   complete and the time left pass
 *                                     through; the settings are checked
 *  - player-lib/stage-bar.js         the bar shows the time on its own
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const C = require('../player-lib/stage-countdown.js');
const PlaylistTime = require('../player-lib/playlist-time.js');
const StageRules = require('../player-lib/stage-rules.js');
const Overlay = require('../lib/stage/mpv-overlay');
const { createEngine } = require('../lib/stage/engine');
const { createHub, validateCommand, validateReport } = require('../lib/stage/hub');
const stageSettings = require('../lib/stage/settings');
const StageBarRules = require('../player-lib/stage-bar.js');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ON = { warnOn: true, warnMinutes: [30, 15, 10], countdownOn: true, countdownMinutes: 5 };

/** Feed a countdown a run of time-left values, one a second (or `step` ms apart). */
function feed(cd, lefts, { settings = ON, start = 0, step = 1000 } = {}) {
  const out = [];
  lefts.forEach((left, i) => out.push(cd.update({ left, at: start + i * step, settings })));
  return out;
}
const warnings = (outs) => outs.map(o => o.warning).filter(Boolean);
/** Seconds counting down by one from a to b. */
const down = (a, b) => Array.from({ length: a - b + 1 }, (_, i) => a - i);

/* ── The settings ─────────────────────────────────────────────────────── */

test('countdown settings: the minutes field takes whole minutes, sorted, without repeats, up to 8', () => {
  assert.deepStrictEqual(C.parseMinutes('10, 30 15'), { ok: true, minutes: [30, 15, 10] });
  assert.deepStrictEqual(C.parseMinutes(' 5;5 , 60 '), { ok: true, minutes: [60, 5] });
  assert.deepStrictEqual(C.parseMinutes(''), { ok: true, minutes: [] }, 'empty: no warnings');
  assert.strictEqual(C.parseMinutes('10, ten').ok, false);
  assert.strictEqual(C.parseMinutes('2.5').ok, false, 'whole minutes only');
  assert.strictEqual(C.parseMinutes('-5').ok, false);
  assert.match(C.parseMinutes('0').error, /1 to 600 minutes/);
  assert.match(C.parseMinutes('601').error, /1 to 600 minutes/);
  assert.match(C.parseMinutes('1 2 3 4 5 6 7 8 9').error, /Up to 8 warnings/);
  assert.strictEqual(C.parseMinutes('1 2 3 4 5 6 7 8 8').ok, true, 'repeats do not count against the cap');
  assert.strictEqual(C.minutesText([10, 30, 15, 30]), '30, 15, 10');
  for (const e of ['Use whole minutes, like 30, 15, 10.', C.parseMinutes('0').error, C.parseMinutes('1 2 3 4 5 6 7 8 9').error]) assert.ok(!e.includes('—'));
});

test('countdown settings: stored the way the other Stage settings are, off by default, checked strictly', () => {
  const d = stageSettings.normalize({});
  assert.strictEqual(d.warnOn, false);
  assert.strictEqual(d.countdownOn, false);
  assert.deepStrictEqual(d.warnMinutes, [30, 15, 10]);
  assert.strictEqual(d.countdownMinutes, 5);
  assert.strictEqual(d.countdownCorner, 'top-right');
  assert.strictEqual(d.countdownSize, 'medium');
  // A hand-edited file is made valid.
  const n = stageSettings.normalize({ warnMinutes: [10, 30, 30, 0, 'x', 700, 15], countdownMinutes: 999, countdownCorner: 'middle', countdownSize: 'huge' });
  assert.deepStrictEqual(n.warnMinutes, [30, 15, 10]);
  assert.strictEqual(n.countdownMinutes, 60, 'clamped');
  assert.strictEqual(n.countdownCorner, 'top-right');
  assert.strictEqual(n.countdownSize, 'medium');
  // The route refuses what is wrong rather than quietly dropping it.
  const ok = stageSettings.validatePatch({ warnOn: true, warnMinutes: [10, 20], countdownOn: true, countdownMinutes: 3, countdownCorner: 'bottom-left', countdownSize: 'large' });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.settings.warnMinutes, [20, 10]);
  assert.strictEqual(ok.settings.countdownCorner, 'bottom-left');
  for (const bad of [{ warnMinutes: '30, 15' }, { warnMinutes: [0] }, { warnMinutes: [1.5] }, { warnMinutes: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    { countdownMinutes: 0 }, { countdownMinutes: 61 }, { countdownMinutes: '5' }, { countdownCorner: 'center' }, { countdownSize: 'xl' }, { warnOn: 'yes' }]) {
    assert.strictEqual(stageSettings.validatePatch(bad).ok, false, JSON.stringify(bad));
  }
});

test('countdown settings: rows in both looks, in Settings search, the error line hides with [hidden]', () => {
  const ui = read('player-lib/stage-settings-ui.js');
  for (const id of ['stageWarnings', 'stageCountdown', 'stageCountdownLook']) {
    assert.ok(ui.includes(`sfind: '${id}'`), `${id} row`);
    assert.ok(read('player-lib/settings-search.js').includes(`id: '${id}'`), `${id} in Settings search`);
  }
  assert.match(ui, /_stageCountdownRows\(s, true\)/, 'Modern');
  assert.match(ui, /_stageCountdownRows\(s, false\)/, 'Classic');
  assert.match(read('css/stage-remote.css'), /\.stage-warn-err\[hidden\] \{ display: none; \}/);
  for (const f of ['player-lib/stage-countdown.js', 'player-lib/stage-settings-ui.js', 'lib/stage/mpv-overlay.js']) assert.ok(!read(f).includes('—'), `${f}: no em dash`);
  const html = read('db-viewer.html');
  assert.ok(html.indexOf('player-lib/stage-countdown.js') > 0 && html.indexOf('player-lib/stage-countdown.js') < html.indexOf('player-lib/stage-control.js'), 'loaded before stage-control.js');
});

/* ── The rules ────────────────────────────────────────────────────────── */

test('countdown: each warning fires once as playback crosses it, for a few seconds', () => {
  const cd = C.create();
  const outs = feed(cd, down(905, 590));
  assert.deepStrictEqual(warnings(outs).filter((w, i, a) => a.indexOf(w) === i), ['15 minutes left', '10 minutes left']);
  const at15 = outs.findIndex(o => o.warning === '15 minutes left');
  assert.strictEqual(905 - at15, 900, 'at 15:00 left exactly');
  const shown = outs.filter(o => o.warning === '15 minutes left').length;
  assert.ok(shown >= 5 && shown <= 7, `shown for about ${C.WARN_MS / 1000} s (${shown})`);
});

test('countdown: warnings already passed when the run starts never fire (a short list says only the nearer ones)', () => {
  const cd = C.create();
  const outs = feed(cd, down(12 * 60, 9 * 60));
  assert.deepStrictEqual([...new Set(warnings(outs))], ['10 minutes left'], '30 and 15 had passed: only 10');
  const cd2 = C.create();
  assert.deepStrictEqual(warnings(feed(cd2, down(200, 0))), [], 'a 3 minute list: no warning at all');
});

test('countdown: a jump across a warning fires nothing; seeking back above it and playing across fires it again, a wobble near it never does', () => {
  const cd = C.create();
  let at = 0;
  const step = (left) => cd.update({ left, at: (at += 1000), settings: ON });
  step(700); step(699);
  assert.strictEqual(step(560).warning, null, 'seek forward over 10:00: nothing');
  assert.strictEqual(step(559).warning, null);
  step(640);                       // seek back above it
  const outs = [];
  for (let l = 639; l >= 590; l--) outs.push(step(l));
  assert.strictEqual(warnings(outs)[0], '10 minutes left', 'played across it: fires now (it never had)');
  assert.ok(!outs.at(-1).warning, 'and has gone again');
  // A little back and forth around it (under REARM_S): never a second time.
  const after = [];
  for (let k = 0; k < 3; k++) { step(605); for (let l = 604; l >= 590; l--) after.push(step(l)); }
  assert.deepStrictEqual(warnings(after), []);
  // A real seek back above it, then played across: it fires again, once each time.
  const again = [];
  for (let k = 0; k < 2; k++) { step(640); for (let l = 639; l >= 590; l--) again.push(step(l)); }
  assert.strictEqual(again.filter((o, i) => o.warning && !(i && again[i - 1].warning)).length, 2);
});

test('countdown: the list grows past a warning (Up next added), then playback crosses it: it fires', () => {
  const cd = C.create();
  let at = 0;
  const step = (left) => cd.update({ left, at: (at += 1000), settings: ON });
  for (let l = 400; l >= 380; l--) assert.strictEqual(step(l).warning, null, 'a short list: below every warning');
  step(1000);                      // 10 minutes of files added to Up next
  const outs = [];
  for (let l = 999; l >= 590; l--) outs.push(step(l));
  assert.deepStrictEqual([...new Set(warnings(outs))], ['15 minutes left', '10 minutes left']);
  assert.strictEqual(999 - outs.findIndex(o => o.warning === '15 minutes left'), 900, 'at 15:00 left');
});

test('countdown: a run that starts below a warning never fires it, even with a tick that comes late', () => {
  const cd = C.create();
  let at = 0;
  const outs = [];
  for (let l = 599; l >= 500; l--) outs.push(cd.update({ left: l, at: (at += 1000), settings: ON }));
  assert.deepStrictEqual(warnings(outs), []);
  assert.deepStrictEqual(cd._run().armed, []);
});

test('countdown: a short dip in the time left (under 2 s, faster than time went by) is a jump, not a crossing', () => {
  const cd = C.create();
  cd.update({ left: 601.5, at: 0, settings: ON });
  assert.strictEqual(cd.update({ left: 599.8, at: 200, settings: ON }).warning, null, 'down 1.7 s in 0.2 s');
  assert.strictEqual(cd.update({ left: 601.4, at: 400, settings: ON }).warning, null);
  const outs = [];
  for (let i = 1; i <= 4; i++) outs.push(cd.update({ left: 601.4 - i, at: 400 + i * 1000, settings: ON }));
  assert.deepStrictEqual(warnings(outs).slice(0, 1), ['10 minutes left'], 'fires when playback really gets there');
  assert.strictEqual(outs.findIndex(o => o.warning), 1, 'at 599.4, not before 600');
});

test('countdown: paused holds the clock and fires nothing; a faster speed is a jump; two at once show the nearer', () => {
  const cd = C.create();
  const s = { ...ON, warnMinutes: [10, 9] };
  let at = 0;
  const step = (left) => cd.update({ left, at: (at += 1000), settings: s });
  step(301);
  for (let i = 0; i < 20; i++) assert.strictEqual(step(299).clock, '4:59', 'paused: holds');
  // A big drop in a short moment (2x speed, a file dropped): no warning, the clock follows.
  const cd2 = C.create();
  cd2.update({ left: 700, at: 0, settings: s });
  assert.strictEqual(cd2.update({ left: 500, at: 1000, settings: s }).warning, null);
  // Two warnings crossed in the same natural step (a tick that came late): the nearer one.
  const cd3 = C.create();
  cd3.update({ left: 601, at: 0, settings: s });
  assert.strictEqual(cd3.update({ left: 539, at: 62000, settings: s }).warning, '9 minutes left');
});

test('countdown: the running clock from N minutes before the end, m:ss, and nothing when the end is not known', () => {
  const cd = C.create();
  assert.strictEqual(cd.update({ left: 301, at: 0, settings: ON }).clock, null);
  assert.strictEqual(cd.update({ left: 300, at: 1000, settings: ON }).clock, '5:00');
  assert.strictEqual(cd.update({ left: 59, at: 2000, settings: ON }).clock, '0:59');
  assert.strictEqual(cd.update({ left: 0, at: 3000, settings: ON }).clock, '0:00');
  assert.deepStrictEqual(cd.update({ left: null, at: 4000, settings: ON }), { clock: null, warning: null }, 'Repeat on, finished: nothing');
  assert.strictEqual(C.create().update({ left: 200, at: 0, settings: { ...ON, countdownOn: false } }).clock, null, 'off: no clock');
  assert.strictEqual(C.create().update({ left: 3600, at: 0, settings: { ...ON, countdownMinutes: 60 } }).clock, '1:00:00');
  assert.deepStrictEqual(C.create().update({ left: 200, at: 0 }), { clock: null, warning: null }, 'default settings: off');
});

test('countdown: a length not known draws nothing but keeps the run, coming out of it is a jump; an unknown end starts a new one', () => {
  const cd = C.create();
  feed(cd, down(605, 598));                     // 10 fires
  cd.update({ left: 597, about: true, at: 9000, settings: ON });
  assert.deepStrictEqual(cd._run().fired, [10], 'kept (15 and 30 were below from the start)');
  // Known again far lower: a jump, nothing fires late.
  const late = C.create();
  let at = 0;
  late.update({ left: 1000, at, settings: ON });
  for (let i = 1; i <= 500; i++) late.update({ left: 1000, about: true, at: (at += 1000), settings: ON });
  const back = [];
  for (let l = 500; l >= 490; l--) back.push(late.update({ left: l, at: (at += 1000), settings: ON }));
  assert.deepStrictEqual(warnings(back), [], 'no "10 minutes left" at 8:20 left');
  assert.deepStrictEqual(cd.update({ left: 590, about: true, at: 10000, settings: ON }), { clock: null, warning: null });
  cd.update({ left: null, at: 11000, settings: ON });
  assert.strictEqual(cd._run(), null, 'unknown end: the run is over');
  // A new run (the reset a hand-picked file makes too): 10 can fire again.
  const outs = feed(cd, down(605, 598), { start: 20000 });
  assert.ok(warnings(outs).includes('10 minutes left'));
  cd.reset();
  assert.strictEqual(cd._run(), null);
});

test('countdown: warnings switched on (or added) mid-run only fire for times still ahead', () => {
  const cd = C.create();
  const off = { ...ON, warnOn: false };
  feed(cd, down(1000, 950), { settings: off });
  const outs = feed(cd, down(949, 590), { settings: ON, start: 60000 });
  assert.deepStrictEqual([...new Set(warnings(outs))], ['15 minutes left', '10 minutes left'], '30 had passed when switched on');
  const outs2 = feed(cd, down(589, 470), { settings: { ...ON, warnMinutes: [30, 15, 10, 8, 9.5] }, start: 500000 });
  assert.deepStrictEqual([...new Set(warnings(outs2))], ['8 minutes left'], 'a minute added while it is still ahead fires; bad ones are dropped');
});

test('countdown words: minutes, one minute, whole hours; the end as a clock time', () => {
  assert.strictEqual(C.warningText(1), '1 minute left');
  assert.strictEqual(C.warningText(30), '30 minutes left');
  assert.strictEqual(C.warningText(60), '1 hour left');
  assert.strictEqual(C.warningText(120), '2 hours left');
  assert.strictEqual(C.warningText(90), '90 minutes left');
  assert.strictEqual(C.clock(65.2), '1:06', 'rounded up: 0:00 only at the very end');
  const now = new Date(2026, 10, 12, 22, 30, 0).getTime();
  const t = C.endsAt(12 * 60, now, 'en-US');
  assert.match(t, /^ends 10:42\sPM$/);
  assert.match(C.endsAt(5 * 3600, now, 'en-US'), /^ends Fri(,)? 3:30\sAM$/, 'tomorrow: with the weekday');
  assert.strictEqual(C.endsAt(null, now), null);
});

/* ── Time left and the list Stage is handed ──────────────────────────── */

test('PlaylistTime.timeLeft at a speed: clock time, pictures keep theirs', () => {
  const list = [{ type: 'video', duration: 600 }, { type: 'image' }, { type: 'audio', duration: 100 }];
  assert.strictEqual(PlaylistTime.timeLeft(list, { index: 0, position: 200 }).seconds, 400 + 8 + 100);
  assert.strictEqual(PlaylistTime.timeLeft(list, { index: 0, position: 200, speed: 2 }).seconds, 200 + 8 + 50);
  assert.strictEqual(PlaylistTime.timeLeft(list, { index: 0, position: 200, speed: 0 }).seconds, 508, 'a bad speed counts as 1x');
});

test('StageRules.upcomingPlan: complete only when the list runs out with Repeat off', () => {
  const okAll = () => true;
  assert.deepStrictEqual(StageRules.upcomingPlan({ anchor: 0, length: 5, okAt: okAll, count: 500 }).complete, true);
  assert.strictEqual(StageRules.upcomingPlan({ anchor: 0, length: 5, okAt: okAll, count: 500, repeat: 'all' }).complete, false, 'Repeat all never ends');
  assert.strictEqual(StageRules.upcomingPlan({ anchor: 0, length: 5, okAt: okAll, count: 500, repeat: 'one' }).complete, false);
  assert.strictEqual(StageRules.upcomingPlan({ anchor: 0, length: 900, okAt: okAll, count: 500 }).complete, false, 'cut at count');
  assert.strictEqual(StageRules.upcomingPlan({ anchor: 0, length: 501, okAt: okAll, count: 500 }).complete, true, 'exactly count left: all of it');
  assert.strictEqual(StageRules.upcomingPlan({ anchor: 0, length: 6, okAt: (i) => (i === 3 ? null : true), count: 500 }).complete, false, 'a row not known yet');
  assert.strictEqual(StageRules.upcomingPlan({ anchor: 0, length: 6, okAt: (i) => i !== 5, count: 500 }).complete, true, 'passed-over files at the end');
  assert.strictEqual(StageRules.upcomingPlan({ upNext: [{ id: 1 }, { id: 2 }], anchor: 0, length: 3, okAt: okAll, count: 2 }).complete, false, 'Up next filled it');
  // upcoming() answers as before.
  for (const o of [{ anchor: 0, length: 9, count: 3 }, { anchor: 2, length: 6, count: 50, repeat: 'all' }, { upNext: [{ id: 7 }], anchor: -1, length: 4, count: 3, okAt: (i) => i !== 1 }]) {
    assert.deepStrictEqual(StageRules.upcoming(o), StageRules.upcomingPlan(o).list);
  }
});

test('hub: complete and the time left pass through; an old page that never says complete gets no countdown', () => {
  const item = { key: 'k1', id: 1, media_type: 'video', filename: 'a.mp4' };
  assert.strictEqual(validateCommand({ type: 'load', item, complete: true }).cmd.complete, true);
  assert.strictEqual(validateCommand({ type: 'load', item }).cmd.complete, false);
  assert.strictEqual(validateCommand({ type: 'upcoming', upcoming: [], complete: 'yes' }).cmd.complete, false);
  const st = validateReport({ type: 'status', key: 'k1', state: 'playing', t: 1, d: 2, left: 125, about: true }).rep;
  assert.strictEqual(st.left, 125);
  assert.strictEqual(st.about, true);
  assert.strictEqual(validateReport({ type: 'status', key: 'k1', state: 'playing', left: -3 }).rep.left, null);
  const cmds = [];
  const hub = createHub({ stage: { alive: () => true, command: (c) => cmds.push(c) }, settings: { get: () => ({}) }, heartbeatMs: 0 });
  hub.opened('mpv');
  hub.command({ type: 'load', item, upcoming: [], complete: true });
  assert.strictEqual(hub.state().complete, true, 'kept for a page that reconnects, and for the unlock');
  hub.command({ type: 'upcoming', upcoming: [], forKey: 'k1' });
  assert.strictEqual(hub.state().complete, false);
  hub.close();
});

/* ── What is drawn ────────────────────────────────────────────────────── */

test('mpv overlay: the countdown is only times, escaped, in the chosen corner, under Hold’s black sheet', () => {
  assert.strictEqual(Overlay.countdownEvent({}), '');
  const e = Overlay.countdownEvent({ clock: '4:59', warning: '5 minutes left', corner: 'top-right', size: 'medium' });
  assert.match(e, /^\{\\an9\\fnSegoe UI\\b1/);
  assert.ok(e.indexOf('4:59') < e.indexOf('5 minutes left'), 'top: the clock in the corner, the warning under it');
  assert.match(e, /\\fs42\}4:59\\N\{\\fs30\}5 minutes left$/);
  const b = Overlay.countdownEvent({ clock: '0:30', warning: '1 minute left', corner: 'bottom-left', size: 'large' });
  assert.match(b, /^\{\\an1/);
  assert.ok(b.indexOf('1 minute left') < b.indexOf('0:30'), 'bottom: the clock in the corner, the warning above');
  assert.match(Overlay.countdownEvent({ warning: '10 minutes left', size: 'small' }), /\\an9.*\{\\fs30\}10 minutes left$/);
  assert.match(Overlay.countdownEvent({ clock: '{\\pos(0,0)}x' }), /\\\{\\\u2060pos\(0,0\)\\\}x$/, 'text is inert');
  assert.ok(Overlay.COUNTDOWN_Z > 0 && Overlay.COUNTDOWN_Z < 10, 'over the name, under the black sheet (z 10)');
  assert.ok(![Overlay.NAME_ID, Overlay.BLACK_ID].includes(Overlay.COUNTDOWN_ID));
});

/* ── The engine, with a fake mpv ──────────────────────────────────────── */

function fakeClock() {
  let t = 1e6;
  let id = 0;
  const q = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout: (fn, ms) => { const k = ++id; q.set(k, { fn, at: t + (ms || 0) }); return k; },
      clearTimeout: (k) => { q.delete(k); },
      setInterval: () => 0,
      clearInterval: () => {},
    },
    advance(ms) { t += ms; },
  };
}

function engineFor({ settings = {}, failOverlay = false } = {}) {
  let entry = 0;
  const overlays = [];
  const mpv = {
    log: [], playlist: [],
    alive: () => true,
    async set(name, value) { mpv.log.push(['set', name, value]); return null; },
    async command(cmd) {
      if (!Array.isArray(cmd) && cmd.name === 'osd-overlay') {
        if (cmd.id === Overlay.COUNTDOWN_ID) overlays.push(cmd.data);
        if (failOverlay) throw new Error('unknown command');
        return null;
      }
      mpv.log.push(cmd);
      if (cmd[0] === 'get_property' && cmd[1] === 'playlist') return mpv.playlist.map(e => ({ id: e.id }));
      return null;
    },
    async loadfile(file, mode) {
      entry += 1;
      if (mode === 'replace') mpv.playlist = [];
      mpv.playlist.push({ id: entry, file });
      return { playlist_entry_id: entry };
    },
  };
  const clock = fakeClock();
  const reports = [];
  let st = { showName: false, imageSeconds: 8, ...ON, ...settings };
  const engine = createEngine({
    mpv, report: (r) => reports.push(r), now: clock.now, timers: clock.timers, settings: () => st,
    readFile: async () => Buffer.alloc(0),
    lib: { pathFor: (id) => ({ ok: true, path: `D:\\m\\${id}.mp4` }), recordView() {}, savePosition() {}, mergeHeatmap() {}, touch() {}, isLocked: () => false },
  });
  engine.started({ volume: 1 });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
  const ev = async (e) => { engine.onEvent(e); await settle(); };
  const prop = (name, data) => ev({ event: 'property-change', name, data });
  /** Play on: mpv's clock moves, a status goes out (the 250 ms timer, by hand). */
  async function at(t, { wall = 1000 } = {}) {
    clock.advance(wall);
    await prop('time-pos', t);
    engine.sendStatus(false);
  }
  const setSettings = (patch) => { st = { ...st, ...patch }; engine.settingsChanged(st); };
  const lastStatus = () => reports.filter(r => r.type === 'status').pop();
  return { engine, mpv, clock, reports, overlays, settle, ev, prop, at, setSettings, lastStatus, drawn: () => overlays[overlays.length - 1] };
}

const vid = (key, id, duration) => ({ key, id, media_type: 'video', filename: `secret-${key}.mp4`, duration, startAt: 0, via: 'list', index: id });

async function playing(e, { upcoming = [vid('b', 2, 300)], complete = true, repeat = 'off', duration = 600 } = {}) {
  e.engine.command({ type: 'load', item: vid('a', 1, duration), upcoming, repeat, paused: false, complete });
  await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.prop('duration', duration);
  await e.ev({ event: 'file-loaded' });
}

test('engine: the time left is the rest of the file plus what follows, sent with each status and drawn near the end', async () => {
  const e = engineFor();
  await playing(e);
  await e.at(0);
  assert.strictEqual(e.lastStatus().left, 900, '600 + 300');
  assert.strictEqual(e.lastStatus().about, false);
  assert.strictEqual(e.drawn(), undefined, '15:00 left at the start: passed already, nothing drawn');
  // Play on to 10:00 left: the warning.
  for (let t = 298; t <= 301; t++) await e.at(t);
  assert.strictEqual(e.lastStatus().left, 599);
  assert.match(e.drawn(), /10 minutes left$/);
  assert.ok(!e.overlays.some(d => /secret/.test(d)), 'never a name');
  // On to the last five minutes: the clock.
  await e.at(400, { wall: 99000 });
  assert.strictEqual(e.drawn(), '', 'the warning has gone; no clock yet');
  await e.at(600);
  assert.strictEqual(e.lastStatus().left, 300);
  assert.match(e.drawn(), /\}5:00$/);
  // The first file ends; mpv moves on to b: the time carries on from b's length.
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  e.engine.sendStatus(true);
  assert.strictEqual(e.lastStatus().left, 300, 'b not loaded yet: its library length');
  await e.prop('duration', 300);
  await e.ev({ event: 'file-loaded' });
  await e.at(1);
  assert.strictEqual(e.lastStatus().left, 299);
  assert.match(e.drawn(), /\}4:59/);
});

test('engine: an automatic hand-over to a file with a saved spot counts from 0 (mpv starts it there), never a dip', async () => {
  const e = engineFor();
  await playing(e, { duration: 60, upcoming: [{ ...vid('b', 2, 600), startAt: 120 }] });
  await e.at(50);
  assert.strictEqual(e.lastStatus().left, 610);
  const appended = e.mpv.playlist.find(p => p.id === 2);
  assert.ok(appended, 'b lined up in mpv');
  const lefts = [];
  for (let t = 51; t <= 60; t++) { await e.at(t); lefts.push(e.lastStatus().left); }
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  e.engine.sendStatus(true); lefts.push(e.lastStatus().left);
  await e.prop('duration', 600); e.engine.sendStatus(true); lefts.push(e.lastStatus().left);
  await e.ev({ event: 'file-loaded' }); e.engine.sendStatus(true); lefts.push(e.lastStatus().left);
  for (let t = 0; t <= 3; t++) { await e.at(t); lefts.push(e.lastStatus().left); }
  assert.ok(!lefts.some(l => l < 597), `no dip to the saved spot: ${lefts.join(' ')}`);
  assert.strictEqual(lefts.at(-1), 597);
  assert.ok(!e.overlays.some(d => /}8:00/.test(d)), 'the picture never showed 8:00');
  // A hand-picked file with a saved spot really starts there: counted from it.
  const h = engineFor();
  h.engine.command({ type: 'load', item: { ...vid('c', 3, 600), startAt: 120 }, upcoming: [], repeat: 'off', paused: false, complete: true });
  await h.settle();
  await h.ev({ event: 'start-file', playlist_entry_id: 1 });
  h.engine.sendStatus(true);
  assert.strictEqual(h.lastStatus().left, 480, 'started at 2:00 of 10:00');
});

test('engine: the last file ends: the picture clears at once (no 0:00 while Stage waits a moment)', async () => {
  const e = engineFor({ settings: { countdownMinutes: 5 } });
  await playing(e, { duration: 100, upcoming: [] });
  await e.at(98);
  assert.match(e.drawn(), /}0:02$/);
  await e.prop('eof-reached', true);
  assert.strictEqual(e.engine._state().waiting, true, 'waiting for Control');
  assert.strictEqual(e.drawn(), '', 'cleared while waiting');
  e.engine.sendStatus(true);
  assert.strictEqual(e.drawn(), '');
});

test('engine: Repeat, a list that is not complete, Hold and a lock draw nothing; the bar still gets what is known', async () => {
  const rep = engineFor();
  await playing(rep, { repeat: 'all', duration: 200, upcoming: [] });
  await rep.at(10);
  assert.strictEqual(rep.lastStatus().left, null, 'Repeat all: no end');
  assert.strictEqual(rep.drawn(), undefined);

  const part = engineFor();
  await playing(part, { complete: false, duration: 200, upcoming: [] });
  await part.at(10);
  assert.strictEqual(part.lastStatus().left, null, 'not said to be all: no end');
  // Control's full answer comes: now there is an end (a single file played on its own counts to its own end).
  part.engine.command({ type: 'upcoming', upcoming: [], repeat: 'off', complete: true });
  await part.at(11);
  assert.strictEqual(part.lastStatus().left, 189);
  assert.match(part.drawn(), /\}3:09$/);

  // Hold: black, the countdown goes; Hold off: back.
  part.engine.command({ type: 'hold', on: true });
  await part.settle();
  assert.strictEqual(part.drawn(), '');
  part.engine.command({ type: 'hold', on: false });
  await part.at(12);
  assert.match(part.drawn(), /\}3:08$/);
  // Turned off in Settings: gone at once.
  part.setSettings({ countdownOn: false });
  assert.strictEqual(part.drawn(), '');
  part.setSettings({ countdownOn: true, countdownCorner: 'bottom-left', countdownSize: 'small' });
  assert.match(part.drawn(), /^\{\\an1.*\\fs30\}3:08$/);
  // A lock: nothing left on the picture.
  part.engine.lock();
  await part.settle();
  assert.strictEqual(part.drawn(), '');
});

test('engine: paused, the count holds (it is media time); a seek moves it; Repeat one stops it', async () => {
  const e = engineFor();
  await playing(e, { duration: 250, upcoming: [] });
  await e.at(10);
  e.engine.command({ type: 'pause' });
  await e.prop('pause', true);
  for (let i = 0; i < 5; i++) { e.clock.advance(1000); e.engine.sendStatus(false); }
  assert.strictEqual(e.lastStatus().left, 240);
  e.engine.command({ type: 'seek', t: 200 });
  await e.at(200);
  assert.strictEqual(e.lastStatus().left, 50);
  e.engine.command({ type: 'upcoming', upcoming: [], repeat: 'one', complete: false });
  await e.at(201);
  assert.strictEqual(e.lastStatus().left, null);
  assert.strictEqual(e.drawn(), '');
});

test('engine: an mpv that refuses osd-overlay plays on: nothing drawn, the time left still reported', async () => {
  const e = engineFor({ failOverlay: true });
  await playing(e, { duration: 200, upcoming: [] });
  await e.at(10);
  await e.settle();
  assert.strictEqual(e.lastStatus().left, 190);
  assert.strictEqual(e.engine._state().cur.loaded, true);
});

test('engine: pictures and unknown lengths in what follows', async () => {
  const e = engineFor();
  await playing(e, { duration: 100, upcoming: [{ ...vid('p', 4, null), media_type: 'image' }, vid('u', 5, null)] });
  await e.at(0);
  assert.strictEqual(e.lastStatus().left, 108, 'a picture counts its 8 s');
  assert.strictEqual(e.lastStatus().about, true, 'a length not known');
  assert.strictEqual(e.drawn(), undefined, 'about: nothing drawn on the picture');
});

/* ── The bar ──────────────────────────────────────────────────────────── */

test('Stage bar: the time left shows on its own (a file played with no list), and with the track count', () => {
  const base = { hasFile: true, mediaType: 'video', t: 1, d: 10 };
  assert.deepStrictEqual(StageBarRules.view({ ...base, countTime: '4:00 left', countEnds: 'ends 10:42 PM' }).count, { track: '', time: '4:00 left', ends: 'ends 10:42 PM' });
  assert.deepStrictEqual(StageBarRules.view({ ...base, countTrack: 'Track 2 of 9', countTime: '', countEnds: 'ends 10:42 PM' }).count, { track: 'Track 2 of 9', time: '', ends: '' }, 'no time, no end time');
  assert.deepStrictEqual(StageBarRules.view({ ...base, countTime: '4:00 left', countEnds: 'ends 10:42 PM', locked: true }).count, { track: '', time: '', ends: '' }, 'locked: nothing');
  assert.deepStrictEqual(StageBarRules.TIME_PIECES, ['countTime', 'countEnds'], 'laid out last, only where they fit');
  assert.match(read('player-lib/stage-bar.js'), /count\.title = \[v\.count\.track, v\.count\.time, ends\]/, 'the full text on hover');
  const ctl = read('player-lib/stage-control.js');
  assert.match(ctl, /function withTimeLeft\(sum\)/);
  assert.match(ctl, /complete: list\.complete === true/);
});
