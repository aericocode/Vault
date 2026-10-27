/**
 * Stage (PLAYLISTS_SPEC 5, "Stage host, final"): the window shared in
 * Discord is the user's mpv, driven by the server, run from the mini player
 * as its remote.
 *
 *  - player-lib/stage-rules.js   what Stage plays next by itself (Up next,
 *                                then the list), resume, views, GIF loops
 *  - lib/stage/settings.js       Settings › Stage, checked
 *  - lib/stage/geometry.js       size presets: the picture, not the window
 *  - lib/stage/hub.js            the Control <-> Stage link through the server
 *  - server/stage-routes.js      the routes behind the lock gate and guards;
 *                                opening Stage with a fake mpv
 *  - no WebView2 leftovers
 *
 * mpv itself (finding it, its arguments, the IPC, the engine) is in
 * test/stage-mpv.test.js. No window is ever opened here: every launch uses a
 * fake mpv host, and VAULT_DISABLE_NATIVE_PICKER=1 keeps the picker shut.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stage-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
delete process.env.VAULT_DB_PASSWORD;

const ROOT = path.join(__dirname, '..');
const Rules = require('../player-lib/stage-rules');
const stageSettings = require('../lib/stage/settings');
const geometry = require('../lib/stage/geometry');
const { createHub, validateCommand, validateReport, MAX_UPCOMING } = require('../lib/stage/hub');

/* ── Upcoming: what Stage moves on to by itself ─────────────────────────── */

test('upcoming: Up next first, then the list carries on from its anchor', () => {
  const out = Rules.upcoming({ upNext: [{ id: 50 }, { id: 51 }], anchor: 2, length: 6, repeat: 'off', count: 3 });
  assert.deepStrictEqual(out, [{ via: 'upnext', id: 50 }, { via: 'upnext', id: 51 }, { via: 'list', index: 3 }]);
});

test('upcoming: files that cannot play are passed over, in Up next and in the list', () => {
  const out = Rules.upcoming({
    upNext: [{ id: 50, ok: false }, { id: 51 }], anchor: 0, length: 5,
    okAt: (i) => i !== 1, repeat: 'off', count: 3,
  });
  assert.deepStrictEqual(out, [{ via: 'upnext', id: 51 }, { via: 'list', index: 2 }, { via: 'list', index: 3 }]);
});

test('upcoming: the end of the list with Repeat off is the end; Repeat all starts over', () => {
  assert.deepStrictEqual(Rules.upcoming({ anchor: 4, length: 5, repeat: 'off' }), []);
  assert.deepStrictEqual(Rules.upcoming({ anchor: 4, length: 5, repeat: 'all', count: 2 }), [{ via: 'list', index: 0 }, { via: 'list', index: 1 }]);
  // A whole lap comes back round to the anchor itself.
  assert.deepStrictEqual(Rules.upcoming({ anchor: 1, length: 2, repeat: 'all', count: 3 }), [{ via: 'list', index: 0 }, { via: 'list', index: 1 }]);
});

test('upcoming: a list of one, or one that only has the anchor to play, does not wrap onto itself', () => {
  assert.deepStrictEqual(Rules.upcoming({ anchor: 0, length: 1, repeat: 'all' }), []);
  assert.deepStrictEqual(Rules.upcoming({ anchor: 2, length: 4, okAt: (i) => i === 2, repeat: 'all' }), []);
});

test('upcoming: Repeat one gives nothing (the file on Stage loops); nothing from the list yet starts at the top', () => {
  assert.deepStrictEqual(Rules.upcoming({ upNext: [{ id: 9 }], anchor: 1, length: 4, repeat: 'one' }), []);
  assert.deepStrictEqual(Rules.upcoming({ anchor: -1, length: 3, repeat: 'off', count: 2 }), [{ via: 'list', index: 0 }, { via: 'list', index: 1 }]);
});

test('upcoming: count limits the answer, Up next alone can fill it', () => {
  assert.deepStrictEqual(Rules.upcoming({ upNext: [{ id: 1 }, { id: 2 }, { id: 3 }], anchor: 0, length: 9 }), [{ via: 'upnext', id: 1 }, { via: 'upnext', id: 2 }]);
});

/* ── Resume, views, pictures, names ─────────────────────────────────────── */

test('resumeAt: the saved spot, as the player does (10 s in, under 90 %)', () => {
  assert.strictEqual(Rules.resumeAt({ last_position: 42, duration_seconds: 100 }), 42);
  assert.strictEqual(Rules.resumeAt({ last_position: 5, duration_seconds: 100 }), 0);
  assert.strictEqual(Rules.resumeAt({ last_position: 95, duration_seconds: 100 }), 0);
  assert.strictEqual(Rules.resumeAt({ last_position: 42, duration_seconds: 100 }, { resume: false }), 0);
  assert.strictEqual(Rules.resumeAt(null), 0);
});

test('positionToSave and viewCounts follow viewtracker.js', () => {
  assert.strictEqual(Rules.positionToSave(12.34, 100), 12.3);
  assert.strictEqual(Rules.positionToSave(91, 100), 0);
  assert.strictEqual(Rules.positionToSave(0, 100), null);
  assert.strictEqual(Rules.positionToSave(5, 0), null);
  assert.strictEqual(Rules.viewCounts(75, 100), true);
  assert.strictEqual(Rules.viewCounts(74, 100), false);
  assert.strictEqual(Rules.viewCounts(180, 3600), true);
  assert.strictEqual(Rules.viewCounts(10, 0), false);
});

/** A tiny animated GIF: frames with the given delays (hundredths). */
function gif(delays, { globalTable = true } = {}) {
  const b = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, globalTable ? 0x80 : 0, 0, 0];
  if (globalTable) b.push(0, 0, 0, 255, 255, 255);
  b.push(0x21, 0xFF, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0);   // loop forever
  for (const d of delays) {
    b.push(0x21, 0xF9, 4, 0, d & 0xff, d >> 8, 0, 0);
    b.push(0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4C, 0x01, 0);
  }
  b.push(0x3B);
  return Uint8Array.from(b);
}

test('gifLoopSeconds: one loop from the frame delays; tiny delays count as 1/10 s', () => {
  assert.strictEqual(Rules.gifLoopSeconds(gif([50, 50, 100])), 2);
  assert.strictEqual(Rules.gifLoopSeconds(gif([0, 1, 20])), 0.4);
  assert.strictEqual(Rules.gifLoopSeconds(gif([25], { globalTable: false })), 0.25);
  assert.strictEqual(Rules.gifLoopSeconds(Uint8Array.from([1, 2, 3])), 0);
  assert.strictEqual(Rules.gifLoopSeconds(Buffer.from('not a gif at all, just text')), 0);
});

test('pictureMs: the setting for a picture; a GIF plays whole loops, at least one', () => {
  assert.strictEqual(Rules.pictureMs({ media_type: 'image' }, 8), 8000);
  assert.strictEqual(Rules.pictureMs({ media_type: 'gif' }, 8, 3), 9000);     // three 3 s loops cover 8 s
  assert.strictEqual(Rules.pictureMs({ media_type: 'gif' }, 8, 12), 12000);   // one long loop
  assert.strictEqual(Rules.pictureMs({ media_type: 'gif', duration: 5 }, 8, 0), 10000);
  assert.strictEqual(Rules.pictureMs({ media_type: 'gif' }, 8, 0), 8000);
});

test('nameText: no folder, no extension', () => {
  assert.strictEqual(Rules.nameText('C:\\clips\\Night drive part 2.mkv'), 'Night drive part 2');
  assert.strictEqual(Rules.nameText('Harbor at dawn.jpg'), 'Harbor at dawn');
  assert.strictEqual(Rules.nameText('v1.2 final'), 'v1.2 final');
  assert.strictEqual(Rules.nameText('.hidden'), '.hidden');
});

/* ── Settings › Stage ───────────────────────────────────────────────────── */

test('settings: defaults, and a stored object normalised', () => {
  assert.deepStrictEqual(stageSettings.normalize(null), stageSettings.DEFAULTS);
  const s = stageSettings.normalize({ imageSeconds: 9999, cursorSeconds: 0, windowName: '  My\nStage  ', openSize: '4k', showName: 'yes', extra: 1 });
  assert.strictEqual(s.imageSeconds, 600);
  assert.strictEqual(s.cursorSeconds, 1);
  assert.strictEqual(s.windowName, 'My Stage');
  assert.strictEqual(s.openSize, 'free');
  assert.strictEqual(s.showName, true);
  assert.ok(!('extra' in s));
});

test('settings: a POST body is checked strictly', () => {
  const base = stageSettings.normalize({});
  assert.strictEqual(stageSettings.validatePatch({ imageSeconds: 5 }, base).settings.imageSeconds, 5);
  assert.strictEqual(stageSettings.validatePatch({ openSize: '1080p' }, base).settings.openSize, '1080p');
  assert.strictEqual(stageSettings.validatePatch({ nope: 1 }, base).ok, false);
  assert.strictEqual(stageSettings.validatePatch({ showName: 'no' }, base).ok, false);
  assert.strictEqual(stageSettings.validatePatch({ imageSeconds: 'lots' }, base).ok, false);
  // Out of range is refused, not quietly clamped (the error says the range).
  const far = stageSettings.validatePatch({ nameSeconds: 99 }, base);
  assert.strictEqual(far.ok, false);
  assert.match(far.error, /1 to 30/);
  assert.strictEqual(stageSettings.validatePatch({ cursorSeconds: 0 }, base).ok, false);
  assert.strictEqual(stageSettings.validatePatch({ imageSeconds: 2.5 }, base).ok, false);
  assert.strictEqual(stageSettings.validatePatch({ imageSeconds: '7' }, base).settings.imageSeconds, 7);
  assert.strictEqual(stageSettings.validatePatch({ windowName: '   ' }, base).ok, false);
  assert.strictEqual(stageSettings.validatePatch({ openSize: '4k' }, base).ok, false);
  assert.strictEqual(stageSettings.validatePatch([], base).ok, false);
  // Window names are one printable line, capped.
  assert.strictEqual(stageSettings.cleanWindowName(`a\u0000b\u2028c ${'x'.repeat(100)}`).length, stageSettings.WINDOW_NAME_MAX);
});

/* ── Size presets: the picture's size ───────────────────────────────────── */

test('presets set the client area exactly: the window grows by its frame', () => {
  // A window with invisible borders 7 px left, right and bottom, none on top.
  const win = { x: 100, y: 50, w: 974, h: 547 };
  const client = { x: 107, y: 50, w: 960, h: 540 };
  const f = geometry.frameInsets(win, client);
  assert.deepStrictEqual(f, { l: 7, t: 0, r: 7, b: 7 });
  const r = geometry.windowRectForClient({ w: 1920, h: 1080 }, win, client, { x: 0, y: 0, w: 3840, h: 2088 });
  assert.deepStrictEqual(r, { x: 100, y: 50, w: 1934, h: 1087 });
  assert.deepStrictEqual(geometry.clientSizeFor(r, f), { w: 1920, h: 1080 });
});

test('presets: the Stage window (no frame) is the picture; it stays on its monitor', () => {
  const win = { x: 3000, y: 1800, w: 640, h: 360 };
  const r = geometry.windowRectForClient({ w: 1280, h: 720 }, win, win, { x: 0, y: 0, w: 3840, h: 2088 });
  assert.deepStrictEqual(r, { x: 2560, y: 1368, w: 1280, h: 720 });
  // Bigger than the screen: from the work area's corner, still the full size.
  const big = geometry.windowRectForClient({ w: 2560, h: 1440 }, win, win, { x: 0, y: 0, w: 1920, h: 1040 });
  assert.deepStrictEqual(big, { x: 0, y: 0, w: 2560, h: 1440 });
  // A second monitor to the left (negative coordinates) is respected.
  const left = geometry.windowRectForClient({ w: 1280, h: 720 }, { x: -1900, y: 100, w: 640, h: 360 }, { x: -1900, y: 100, w: 640, h: 360 }, { x: -1920, y: 0, w: 1920, h: 1040 });
  assert.deepStrictEqual(left, { x: -1900, y: 100, w: 1280, h: 720 });
});

test('presetOf and usableBounds', () => {
  assert.strictEqual(geometry.presetOf({ x: 0, y: 0, w: 1920, h: 1080 }, stageSettings.SIZE_PRESETS), '1080p');
  assert.strictEqual(geometry.presetOf({ x: 0, y: 0, w: 1919, h: 1080 }, stageSettings.SIZE_PRESETS), 'free');
  assert.deepStrictEqual(geometry.usableBounds({ x: 10.4, y: 20, w: 640, h: 360 }), { x: 10, y: 20, w: 640, h: 360 });
  assert.strictEqual(geometry.usableBounds({ x: 0, y: 0, w: 20, h: 20 }), null);
  assert.strictEqual(geometry.usableBounds({ x: 5000, y: 0, w: 640, h: 360 }, [{ x: 0, y: 0, w: 1920, h: 1040 }]), null);
  assert.ok(geometry.usableBounds({ x: 1800, y: 0, w: 640, h: 360 }, [{ x: 0, y: 0, w: 1920, h: 1040 }]));
});

/* ── The hub ────────────────────────────────────────────────────────────── */

const item = (key, id, extra = {}) => ({ key, id, media_type: 'video', filename: `f${id}.mp4`, duration: 30, ...extra });

test('commands are checked: shapes, keys, ranges, unknown types', () => {
  assert.strictEqual(validateCommand({ type: 'load', item: item('a1', 1) }).ok, true);
  assert.strictEqual(validateCommand({ type: 'load', item: { ...item('a1', 1), media_type: 'document' } }).ok, false);
  assert.strictEqual(validateCommand({ type: 'load', item: item('bad key!', 1) }).ok, false);
  assert.strictEqual(validateCommand({ type: 'load', item: item('a1', -3) }).ok, false);
  assert.strictEqual(validateCommand({ type: 'load', item: item('a1', 1), upcoming: new Array(MAX_UPCOMING + 1).fill(item('b', 2)) }).ok, false);
  assert.strictEqual(validateCommand({ type: 'load', item: item('a1', 1), repeat: 'sometimes' }).ok, false);
  assert.strictEqual(validateCommand({ type: 'seek', t: -1 }).ok, false);
  assert.strictEqual(validateCommand({ type: 'volume', volume: 1.5 }).ok, false);
  assert.strictEqual(validateCommand({ type: 'volume', volume: 0.5, muted: 'yes' }).ok, false);
  assert.strictEqual(validateCommand({ type: 'hold' }).ok, false);
  assert.strictEqual(validateCommand({ type: 'size', preset: '1080p' }, stageSettings.OPEN_SIZES).ok, true);
  assert.strictEqual(validateCommand({ type: 'size', preset: '8k' }, stageSettings.OPEN_SIZES).ok, false);
  assert.strictEqual(validateCommand({ type: 'explode' }).ok, false);
  assert.strictEqual(validateCommand(null).ok, false);
  // Filepaths never travel to Stage.
  const c = validateCommand({ type: 'load', item: { ...item('a1', 1), filepath: 'C:\\secret\\x.mp4' } }).cmd;
  assert.ok(!('filepath' in c.item));
});

test('reports are checked (they come from the engine, in a fixed shape)', () => {
  assert.strictEqual(validateReport({ type: 'status', key: 'a1', state: 'playing', t: 3, d: 30 }).ok, true);
  assert.strictEqual(validateReport({ type: 'status', key: 'a1', state: 'waiting' }).ok, true);
  assert.strictEqual(validateReport({ type: 'status', key: 'a1', state: 'dancing' }).ok, false);
  assert.strictEqual(validateReport({ type: 'started' }).ok, false);
  assert.strictEqual(validateReport({ type: 'skipped', key: 'a1', reason: 'x'.repeat(500) }).rep.reason.length, 200);
  // The page-only reports of the old Stage page are gone.
  for (const type of ['ready', 'bounds', 'closing', 'wall', 'whatever']) assert.strictEqual(validateReport({ type, x: 1, y: 1, w: 9, h: 9 }).ok, false, type);
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

/** A hub with a fake Stage runner that records what it was asked. */
function hubFor({ alive = true, position = null } = {}) {
  const calls = [];
  const runner = {
    alive: () => runner._alive,
    _alive: alive,
    command: (c) => calls.push(`cmd:${c.type}`),
    front: () => calls.push('front'),
    size: (p) => calls.push(`size:${p}`),
    close: () => calls.push('close'),
    position: () => position,
    lock: () => calls.push('lock'),
    unlock: (s) => calls.push(`unlock:${s.hold}:${s.resume}`),
    settingsChanged: (st) => calls.push(`settings:${st.windowName}`),
  };
  const hub = createHub({
    stage: runner, heartbeatMs: 0,
    settings: { get: () => stageSettings.normalize({}), sizes: stageSettings.OPEN_SIZES },
  });
  return { hub, calls, runner };
}

test('hub: commands wait for an open Stage; they reach the engine; a Control tab that connects gets the whole session', () => {
  const { hub, calls } = hubFor();
  assert.strictEqual(hub.command({ type: 'play' }).status, 409);
  hub.opened('mpv');
  assert.strictEqual(hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2)], repeat: 'all' }).status, 200);
  assert.deepStrictEqual(calls, ['cmd:load']);
  const { req, res } = fakeStream();
  hub.attach('control', req, res);
  const sync = res.events().find(e => e.event === 'sync').data;
  assert.strictEqual(sync.open, true);
  assert.strictEqual(sync.mode, 'mpv');
  assert.strictEqual(sync.current.key, 'a1');
  assert.strictEqual(sync.upcoming[0].key, 'a2');
  assert.strictEqual(sync.repeat, 'all');
  assert.strictEqual(sync.settings.windowName, 'Vault Stage');
});

test('hub: the engine moving on by itself makes the upcoming file current and tells Control; a key it was not given is refused', () => {
  const { hub } = hubFor();
  hub.opened();
  hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2), item('a3', 3)] });
  const { req, res } = fakeStream();
  hub.attach('control', req, res);
  assert.strictEqual(hub.report({ type: 'started', key: 'a2', auto: true }).status, 200);
  const st = hub.state();
  assert.strictEqual(st.current.key, 'a2');
  assert.deepStrictEqual(st.upcoming.map(u => u.key), ['a3']);
  const ev = res.events().find(e => e.event === 'started').data;
  assert.strictEqual(ev.auto, true);
  assert.strictEqual(ev.item.key, 'a2');
  assert.strictEqual(hub.report({ type: 'started', key: 'zz', auto: true }).status, 409);
  // A stale answer for a file Stage has moved past is dropped.
  assert.strictEqual(hub.command({ type: 'upcoming', upcoming: [item('b1', 9)], forKey: 'a1' }).body.stale, true);
  assert.deepStrictEqual(hub.state().upcoming.map(u => u.key), ['a3']);
});

test('hub: skipped files are reported with what they were; status keeps Control’s pause on Hold', () => {
  const { hub } = hubFor();
  hub.opened();
  hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2)] });
  const { req, res } = fakeStream();
  hub.attach('control', req, res);
  hub.report({ type: 'skipped', key: 'a2', reason: 'it can’t be played' });
  assert.strictEqual(res.events().find(e => e.event === 'skipped').data.item.id, 2);
  assert.deepStrictEqual(hub.state().upcoming, []);
  hub.report({ type: 'status', key: 'a1', state: 'paused', t: 4, d: 30, paused: true, hold: false });
  assert.strictEqual(hub.state().paused, true);
  hub.command({ type: 'play' });
  hub.report({ type: 'status', key: 'a1', state: 'paused', t: 4, d: 30, paused: true, hold: true });
  assert.strictEqual(hub.state().paused, false, 'on Hold the engine is paused, Control still wants play');
});

test('hub: Control’s Close asks the engine where it is, closes mpv, and its exit says closed', () => {
  const { hub, calls, runner } = hubFor({ position: { key: 'a1', t: 12.5, paused: false } });
  hub.opened();
  hub.command({ type: 'load', item: item('a1', 1) });
  const { req, res } = fakeStream();
  hub.attach('control', req, res);
  const out = hub.command({ type: 'close' });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.last.t, 12.5);
  assert.ok(calls.includes('close'));
  runner._alive = false;
  hub.stageExited({ byUser: true });
  const closed = res.events().find(e => e.event === 'closed');
  assert.ok(closed);
  assert.strictEqual(closed.data.current.key, 'a1');
  assert.strictEqual(hub.state().open, false);
});

test('hub: mpv ending on its own (a crash) is gone, paused; the window’s own close button is closed', () => {
  const a = hubFor();
  a.hub.opened();
  a.hub.command({ type: 'load', item: item('a1', 1) });
  const s1 = fakeStream();
  a.hub.attach('control', s1.req, s1.res);
  a.hub.stageExited({ byUser: false });
  assert.ok(s1.res.events().find(e => e.event === 'gone'));

  const b = hubFor({ position: { key: 'a1', t: 3, paused: true } });
  b.hub.opened();
  b.hub.command({ type: 'load', item: item('a1', 1) });
  const s2 = fakeStream();
  b.hub.attach('control', s2.req, s2.res);
  b.hub.closeRequested();
  assert.ok(b.calls.includes('close'));
  b.hub.stageExited({ byUser: false });   // whatever mpv says: Vault asked it to close
  const closed = s2.res.events().find(e => e.event === 'closed');
  assert.ok(closed);
  assert.strictEqual(closed.data.t, 3);
  assert.strictEqual(closed.data.paused, true);
});

test('hub: a lock blacks Stage out at once (the engine is told), ends every stream, refuses commands and reports; the unlock comes back under Hold', () => {
  const { hub, calls } = hubFor();
  hub.opened();
  hub.command({ type: 'load', item: item('a1', 1) });
  const { req, res } = fakeStream();
  hub.attach('control', req, res);
  hub.lock();
  assert.ok(calls.includes('lock'));
  assert.ok(res.ended);
  assert.ok(res.events().some(e => e.event === 'locked'));
  assert.strictEqual(hub.count(), 0);
  assert.strictEqual(hub.command({ type: 'play' }).status, 423);
  assert.strictEqual(hub.report({ type: 'status', key: 'a1', state: 'playing' }).status, 423);
  hub.unlock();
  // It was playing: Hold on, and Hold off plays again (resume).
  assert.ok(calls.includes('unlock:true:true'), calls.join(' '));
  assert.strictEqual(hub.state().hold, true);
  assert.strictEqual(hub.command({ type: 'hold', on: false }).status, 200);
  assert.strictEqual(hub.state().resume, false);
});

test('hub: mpv gone while locked: the session ends at the unlock', () => {
  const { hub, runner } = hubFor();
  hub.opened();
  hub.lock();
  runner._alive = false;
  hub.unlock();
  assert.strictEqual(hub.state().open, false);
});

test('hub: privacy mode hiding file names reaches the engine and leaves no names in the session', () => {
  const { hub, calls } = hubFor();
  hub.opened();
  hub.command({ type: 'load', item: item('a1', 1, { filename: 'secret.mp4' }), upcoming: [item('a2', 2, { filename: 'other.mp4' })] });
  hub.command({ type: 'privacy', hideNames: true });
  assert.ok(calls.includes('cmd:privacy'));
  const st = hub.state();
  assert.strictEqual(st.current.filename, '');
  assert.strictEqual(st.upcoming[0].filename, '');
  assert.strictEqual(st.hideNames, true);
});

test('hub: front and size go to the runner only while mpv runs; settings reach mpv and the remote', () => {
  const { hub, calls, runner } = hubFor();
  hub.opened();
  hub.command({ type: 'front' });
  hub.command({ type: 'size', preset: '1080p' });
  hub.settingsChanged();
  assert.deepStrictEqual(calls, ['front', 'size:1080p', 'settings:Vault Stage']);
  runner._alive = false;
  hub.command({ type: 'front' });
  assert.deepStrictEqual(calls, ['front', 'size:1080p', 'settings:Vault Stage']);
});

/* ── No WebView2 leftovers ──────────────────────────────────────────────── */

test('the WebView2 Stage is gone: no host, SDK files, Stage page, switches or install steps', () => {
  for (const f of ['lib/stage/host.js', 'lib/stage/host-script.js', 'lib/stage/sdk.js', 'lib/stage/WEBVIEW2-LICENSE.txt', 'player-lib/stage.html', 'player-lib/stage.js', 'css/stage.css']) {
    assert.ok(!fs.existsSync(path.join(ROOT, f)), `${f} is gone`);
  }
  const files = [
    'tools/sea/build-app.js', 'SETUP.md', 'player-lib/THIRD-PARTY.txt', 'server/stage-routes.js', 'server/index.js',
    'player-lib/stage-control.js', 'player-lib/stage-settings-ui.js', 'db-viewer.html', '.gitignore',
    ...fs.readdirSync(path.join(ROOT, 'lib', 'stage')).map(f => `lib/stage/${f}`),
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const word of [/webview2/i, /VAULT_STAGE_HOST/, /VAULT_STAGE_BROWSER_ARGS/, /VAULT_WEBVIEW2_SDK/, /stage-webview/, /runtime\/webview2/]) {
      assert.ok(!word.test(text), `${f} mentions ${word}`);
    }
  }
});

/* ── The routes, on the real app ────────────────────────────────────────── */

const db = require('../lib/database');
const vault = require('../lib/vault');
const appSettings = require('../lib/app-settings');
const { app } = require('../server/index');
let server;
let base;
let port;

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => {
  vault._locked = false;
  await new Promise((resolve) => server.close(resolve));
  if (fakeServer) await new Promise((resolve) => fakeServer.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p, body, headers = {}, at = base) => fetch(at + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('GET /api/stage/state: closed, whether mpv is there, the settings', async () => {
  const s = await (await fetch(base + '/api/stage/state')).json();
  assert.strictEqual(s.open, false);
  assert.strictEqual(typeof s.mpv.found, 'boolean');
  assert.strictEqual(s.mpv.canChoose, false, 'test servers never open the picker');
  assert.strictEqual(s.settings.windowName, 'Vault Stage');
  assert.ok(!('how' in s) && !('popupBounds' in s));
});

test('events are for Control only; commands before Stage opens are refused; the old page routes are gone', async () => {
  assert.strictEqual((await fetch(base + '/api/stage/events?role=stage')).status, 400);
  assert.strictEqual((await fetch(base + '/api/stage/events?role=boss')).status, 400);
  const r = await post('/api/stage/cmd', { type: 'play' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).code, 'STAGE_CLOSED');
  assert.strictEqual((await post('/api/stage/cmd', { type: 'nope' })).status, 400);
  assert.strictEqual((await post('/api/stage/report', { type: 'status', state: 'playing' })).status, 404);
  const page = await fetch(base + '/stage');
  const text = await page.text();
  assert.ok(page.status !== 200 || !/stage\.js/.test(text), 'no Stage page');
});

test('the events stream answers as server-sent events', async () => {
  const ctl = new AbortController();
  const r = await fetch(base + '/api/stage/events?role=control', { signal: ctl.signal });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  let text = '';
  while (!/event: sync/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  assert.match(text, /"open":/);
});

test('cross-origin writes are refused (CSRF guard), and a foreign Host header too', async () => {
  const r = await post('/api/stage/cmd', { type: 'play' }, { Origin: 'http://evil.example' });
  assert.strictEqual(r.status, 403);
  const s = await post('/api/stage/settings', { tips: false }, { Origin: 'http://evil.example' });
  assert.strictEqual(s.status, 403);
  assert.strictEqual((await post('/api/stage/mpv/choose', {}, { Origin: 'http://evil.example' })).status, 403);
  assert.strictEqual((await post('/api/stage/open', {}, { Origin: 'http://evil.example' })).status, 403);
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/stage/state', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.ok(status >= 400 && status < 500, `foreign Host: ${status}`);
});

test('Settings › Stage: read, saved, checked; the mpv path is not a setting a page can send', async () => {
  const g = await (await fetch(base + '/api/stage/settings')).json();
  assert.strictEqual(g.imageSeconds, 8);
  const r = await post('/api/stage/settings', { imageSeconds: 5, windowName: 'Friday show' });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.imageSeconds, 5);
  assert.strictEqual(j.windowName, 'Friday show');
  assert.strictEqual((await post('/api/stage/settings', { imageSeconds: 'x' })).status, 400);
  assert.strictEqual((await post('/api/stage/settings', { nameSeconds: 31 })).status, 400);
  assert.strictEqual((await post('/api/stage/settings', { surprise: true })).status, 400);
  for (const k of ['mpvPath', 'mpv', 'path', 'stageMpv']) {
    assert.strictEqual((await post('/api/stage/settings', { [k]: 'C:\\Windows\\System32\\calc.exe' })).status, 400, k);
  }
  const stored = JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8'));
  assert.strictEqual(stored.stage.windowName, 'Friday show');
  assert.ok(!stored.stageMpv);
});

test('Choose mpv: the native picker only (never a path from the request); off on test servers; Find it again forgets the pick', async () => {
  const r = await post('/api/stage/mpv/choose', { path: 'C:\\Windows\\System32\\calc.exe' });
  assert.strictEqual(r.status, 409, 'VAULT_DISABLE_NATIVE_PICKER: the picker does not open');
  assert.ok(!(appSettings.all().stageMpv && appSettings.all().stageMpv.path));
  appSettings.set({ stageMpv: { path: 'C:\\nowhere\\mpv.exe' } });
  const m = await (await fetch(base + '/api/stage/mpv')).json();
  assert.strictEqual(m.chosen, 'C:\\nowhere\\mpv.exe');
  assert.ok(m.chosenProblem, 'a chosen path that is gone says why');
  assert.notStrictEqual(m.source, 'chosen');
  const f = await (await post('/api/stage/mpv/forget', {})).json();
  assert.strictEqual(f.mpv.chosen, null);
});

test('locked: every Stage route answers 423', async () => {
  vault._locked = true;
  try {
    for (const [m, p] of [['GET', '/api/stage/state'], ['GET', '/api/stage/events?role=control'], ['GET', '/api/stage/settings'],
      ['GET', '/api/stage/mpv'], ['POST', '/api/stage/cmd'], ['POST', '/api/stage/open'], ['POST', '/api/stage/settings'],
      ['POST', '/api/stage/mpv/choose'], ['POST', '/api/stage/mpv/forget']]) {
      const r = m === 'GET' ? await fetch(base + p) : await post(p, { type: 'play' });
      assert.strictEqual(r.status, 423, `${m} ${p}`);
    }
  } finally {
    vault._locked = false;
  }
});

/* ── Opening Stage with a fake mpv (the routes, the engine, the hub) ────── */

const express = require('express');
const { buildRouter } = require('../server/stage-routes');
let fakeServer = null;

/** A stand-in for lib/stage/mpv-host.js: records what it is asked, plays nothing. */
function fakeHostFactory(log) {
  return (opts) => {
    let alive = false;
    let entry = 0;
    const host = {
      opts,
      async start(exe, argsFor, { mpvVersion } = {}) {
        log.push({ start: exe, args: argsFor('\\\\.\\pipe\\vault-stage-test'), mpvVersion });
        alive = true;
        return { ok: true };
      },
      alive: () => alive,
      command: async (cmd) => { log.push({ cmd }); return null; },
      set: async (name, value) => { log.push({ set: [name, value] }); return null; },
      get: async () => null,
      loadfile: async (file, mode, o) => { log.push({ loadfile: [file, mode, o] }); entry += 1; return { playlist_entry_id: entry }; },
      quit: () => { alive = false; log.push('quit'); setImmediate(() => opts.onExit({ code: 0, asked: true })); },
      kill: () => { alive = false; },
      get pid() { return 1; },
    };
    log.host = host;
    return host;
  };
}

test('opening Stage: mpv found and started with Stage’s arguments; files go as library paths; the window’s close button closes it', async () => {
  const log = [];
  const found = { found: true, path: 'C:\\Program Files\\mpv\\mpv.exe', version: 'v0.41.0', source: 'default' };
  const router = buildRouter({
    hostFactory: fakeHostFactory(log),
    find: async () => found,
    lib: { pathFor: (id) => (id === 7 ? { ok: true, path: 'D:\\Media\\seven.mp4' } : { ok: false, reason: 'it is not in the library' }), isLocked: () => false },
    env: { VAULT_STAGE_MUTE: '1', VAULT_STAGE_TEST_QUIET: '1' },
  });
  const app2 = express();
  app2.use(express.json());
  app2.use(router);
  await new Promise((resolve) => { fakeServer = app2.listen(0, '127.0.0.1', resolve); });
  const at = `http://127.0.0.1:${fakeServer.address().port}`;

  const o = await (await post('/api/stage/open', {}, {}, at)).json();
  assert.deepStrictEqual(o, { ok: true, mode: 'mpv' });
  const start = log.find(l => l.start);
  assert.strictEqual(start.start, found.path);
  assert.ok(start.args.includes('--no-config'));
  assert.ok(start.args.includes('--ao=null') && start.args.includes('--mute=yes'), 'VAULT_STAGE_MUTE: silent');
  assert.ok(start.args.some(a => /^--geometry=\d+x\d+\+-20000\+0$/.test(a)), 'VAULT_STAGE_TEST_QUIET: off every screen');
  assert.ok(start.args.includes('--title=Friday show'), 'the Window name setting from the earlier test');
  // Again: brought to the front, not a second mpv.
  const again = await (await post('/api/stage/open', {}, {}, at)).json();
  assert.strictEqual(again.reused, true);
  assert.strictEqual(log.filter(l => l.start).length, 1);
  assert.ok(log.some(l => l.set && l.set[0] === 'ontop' && l.set[1] === true));

  const load = await post('/api/stage/cmd', { type: 'load', item: { key: 'k7', id: 7, media_type: 'video', filename: 'seven.mp4', filepath: 'C:\\evil.exe' }, upcoming: [] }, {}, at);
  assert.strictEqual(load.status, 200);
  await new Promise(r => setTimeout(r, 20));
  const lf = log.find(l => l.loadfile);
  assert.deepStrictEqual(lf.loadfile.slice(0, 2), ['D:\\Media\\seven.mp4', 'replace'], 'the path from the library, never from the request');

  // The window's own close button: mpv asks Vault, Vault closes it, Control hears "closed".
  log.host.opts.onEvent({ event: 'client-message', args: ['vault-stage', 'close'] });
  await new Promise(r => setTimeout(r, 20));
  assert.ok(log.includes('quit'));
  const st = await (await fetch(at + '/api/stage/state')).json();
  assert.strictEqual(st.open, false);
});

test('opening Stage without mpv: a clear answer, nothing started', async () => {
  const log = [];
  const router = buildRouter({ hostFactory: fakeHostFactory(log), find: async () => ({ found: false }), lib: {}, env: {} });
  const app3 = express();
  app3.use(express.json());
  app3.use(router);
  const srv = await new Promise((resolve) => { const s = app3.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const r = await post('/api/stage/open', {}, {}, `http://127.0.0.1:${srv.address().port}`);
    assert.strictEqual(r.status, 409);
    const j = await r.json();
    assert.strictEqual(j.code, 'MPV_MISSING');
    assert.match(j.error, /mpv/);
    assert.strictEqual(log.length, 0);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('the remote: a second Open while Stage is opening waits for it (its then runs); after the end of the list Close hands back no file; a status for a file it never sent is caught up from the server', () => {
  const src = fs.readFileSync(path.join(ROOT, 'player-lib', 'stage-control.js'), 'utf8');
  assert.match(src, /if \(opening\) \{\s*await opening;\s*if \(open && then\) then\(\);/);
  assert.strictEqual((src.match(/if \(finished\) cur = null;/g) || []).length, 2, 'Close and a vanished Stage hand back no file after the end');
  assert.match(src, /if \(r\.key && !sent\.has\(r\.key\)\) catchUp\(r\.key\);/);
  const ui = fs.readFileSync(path.join(ROOT, 'player-lib', 'stage-settings-ui.js'), 'utf8');
  assert.ok(ui.includes('mpv found: ') && !ui.includes('Full (mpv)'));
});
