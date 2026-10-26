/**
 * Stage (PLAYLISTS_SPEC 5): the window shared in Discord, run from the mini
 * player as its remote.
 *
 *  - player-lib/stage-rules.js   what Stage plays next by itself (Up next,
 *                                then the list), resume, views, GIF loops
 *  - lib/stage/settings.js       Settings › Stage, checked
 *  - lib/stage/geometry.js       size presets: the picture, not the window
 *  - lib/stage/hub.js            the Control <-> Stage link through the server
 *  - lib/stage/host.js, sdk.js   how Stage opens here, the pinned SDK files
 *  - server/stage-routes.js      the routes behind the lock gate and guards
 *  - tools/sea/build-app.js      nothing extra in the install root
 *
 * No window is ever opened: VAULT_STAGE_HOST=popup and
 * VAULT_DISABLE_NATIVE_PICKER=1 are set before the app loads.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stage-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
process.env.VAULT_STAGE_HOST = 'popup';
process.env.VAULT_STAGE_DATA = path.join(tmp, 'stage-webview');
delete process.env.VAULT_DB_PASSWORD;

const ROOT = path.join(__dirname, '..');
const Rules = require('../player-lib/stage-rules');
const stageSettings = require('../lib/stage/settings');
const geometry = require('../lib/stage/geometry');
const { createHub, validateCommand, validateReport } = require('../lib/stage/hub');
const { chooseMode, createHost, sweepStale, pidAlive } = require('../lib/stage/host');
const sdk = require('../lib/stage/sdk');
const ring = require('../lib/stream/ring');

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
  assert.strictEqual(validateCommand({ type: 'load', item: item('a1', 1), upcoming: new Array(5).fill(item('b', 2)) }).ok, false);
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

test('reports are checked', () => {
  assert.strictEqual(validateReport({ type: 'status', key: 'a1', state: 'playing', t: 3, d: 30 }).ok, true);
  assert.strictEqual(validateReport({ type: 'status', key: 'a1', state: 'dancing' }).ok, false);
  assert.strictEqual(validateReport({ type: 'started' }).ok, false);
  assert.strictEqual(validateReport({ type: 'bounds', x: 1, y: 2, w: 0, h: 5 }).ok, false);
  assert.strictEqual(validateReport({ type: 'whatever' }).ok, false);
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

function hubFor({ alive = false, graceMs = 30, openGraceMs = 60 } = {}) {
  const calls = [];
  const host = {
    alive: () => alive, close: () => calls.push('close'), front: () => calls.push('front'),
    size: (p) => calls.push(`size:${p}`), setTitle: (t) => calls.push(`title:${t}`),
  };
  const hub = createHub({
    host, graceMs, openGraceMs, heartbeatMs: 0,
    settings: { get: () => stageSettings.normalize({}), sizes: stageSettings.OPEN_SIZES, presets: stageSettings.SIZE_PRESETS },
  });
  return { hub, calls, host };
}

test('hub: commands wait for an open Stage; a Stage that connects gets the whole session', () => {
  const { hub } = hubFor();
  assert.strictEqual(hub.command({ type: 'play' }).status, 409);
  hub.opened('popup');
  assert.strictEqual(hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2)], repeat: 'all' }).status, 200);
  hub.command({ type: 'volume', volume: 0.3, muted: false });
  const st = fakeStream();
  hub.attach('stage', st.req, st.res);
  const sync = st.res.events().find(e => e.event === 'sync').data;
  assert.strictEqual(sync.current.key, 'a1');
  assert.deepStrictEqual(sync.upcoming.map(u => u.key), ['a2']);
  assert.strictEqual(sync.volume, 0.3);
  assert.strictEqual(sync.settings.windowName, 'Vault Stage');
  hub.close();
});

test('hub: Stage moving on by itself makes the upcoming file current and tells Control', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const ctl = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2, { via: 'upnext' }), item('a3', 3, { via: 'list', index: 4 })] });
  assert.strictEqual(hub.report({ type: 'started', key: 'a2', auto: true }).status, 200);
  const s = hub.state();
  assert.strictEqual(s.current.key, 'a2');
  assert.deepStrictEqual(s.upcoming.map(u => u.key), ['a3']);
  const started = ctl.res.events().filter(e => e.event === 'started').pop().data;
  assert.strictEqual(started.item.via, 'upnext');
  assert.strictEqual(started.auto, true);
  // A file it was never given is refused.
  assert.strictEqual(hub.report({ type: 'started', key: 'zz9', auto: true }).status, 409);
  // An upcoming list worked out for a file Stage has already left is stale.
  assert.strictEqual(hub.command({ type: 'upcoming', upcoming: [item('b1', 9)], forKey: 'a1' }).body.stale, true);
  assert.deepStrictEqual(hub.state().upcoming.map(u => u.key), ['a3']);
  assert.strictEqual(hub.command({ type: 'upcoming', upcoming: [item('b1', 9)], forKey: 'a2' }).status, 200);
  assert.deepStrictEqual(hub.state().upcoming.map(u => u.key), ['b1']);
  hub.close();
});

test('hub: skipped files are reported with what they were; status keeps the paused flag', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const ctl = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2, { via: 'upnext' })] });
  hub.report({ type: 'skipped', key: 'a2', reason: 'it can\u2019t be played' });
  const sk = ctl.res.events().find(e => e.event === 'skipped').data;
  assert.strictEqual(sk.item.id, 2);
  assert.deepStrictEqual(hub.state().upcoming, []);
  hub.report({ type: 'status', key: 'a1', state: 'paused', t: 4, d: 30, paused: true });
  assert.strictEqual(hub.state().paused, true);
  assert.ok(ctl.res.events().some(e => e.event === 'status' && e.data.t === 4));
  hub.close();
});

test('hub: Control\u2019s Close answers with where Stage was; the stream ending then says closed', async () => {
  const { hub, calls } = hubFor();
  hub.opened('popup');
  const ctl = fakeStream();
  const st = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.attach('stage', st.req, st.res);
  hub.command({ type: 'load', item: item('a1', 1) });
  hub.report({ type: 'status', key: 'a1', state: 'playing', t: 12.5, d: 30, paused: false });
  const out = hub.command({ type: 'close' });
  assert.strictEqual(out.body.last.t, 12.5);
  assert.strictEqual(out.body.last.current.key, 'a1');
  assert.ok(st.res.events().some(e => e.event === 'close'));
  assert.ok(!calls.includes('close'), 'no host process: nothing to tell');
  st.res.end();
  await new Promise(r => setTimeout(r, 60));
  assert.ok(ctl.res.events().some(e => e.event === 'closed'));
  assert.strictEqual(hub.state().open, false);
  hub.close();
});

test('hub: a Stage page that vanishes on its own is gone, not closed; a reload in time is neither', async () => {
  const { hub } = hubFor({ graceMs: 40 });
  hub.opened('popup');
  const ctl = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  const s1 = fakeStream();
  hub.attach('stage', s1.req, s1.res);
  s1.res.end();
  const s2 = fakeStream();
  hub.attach('stage', s2.req, s2.res);      // reloaded within the grace period
  await new Promise(r => setTimeout(r, 70));
  assert.strictEqual(hub.state().open, true);
  s2.res.end();
  await new Promise(r => setTimeout(r, 70));
  assert.ok(ctl.res.events().some(e => e.event === 'gone'));
  assert.ok(!ctl.res.events().some(e => e.event === 'closed'));
  hub.close();
});

test('hub: with a host process, its exit decides (the window\u2019s own close is closed, a crash is gone)', () => {
  for (const [byUser, word] of [[true, 'closed'], [false, 'gone']]) {
    const { hub } = hubFor({ alive: true });
    hub.opened('webview2');
    const ctl = fakeStream();
    hub.attach('control', ctl.req, ctl.res);
    hub.hostExited({ byUser });
    assert.ok(ctl.res.events().some(e => e.event === word), word);
    assert.strictEqual(hub.state().open, false);
    hub.close();
  }
});

test('hub: a pop-up that never connects is gone after a while', async () => {
  const { hub } = hubFor({ openGraceMs: 40, graceMs: 10 });
  const ctl = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.opened('popup');
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(hub.state().open, false);
  assert.ok(ctl.res.events().some(e => e.event === 'gone'));
  hub.close();
});

test('hub: lock is black at once: every stream told and ended, commands 423, Hold after the unlock', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const ctl = fakeStream();
  const st = fakeStream();
  hub.attach('control', ctl.req, ctl.res);
  hub.attach('stage', st.req, st.res);
  hub.command({ type: 'load', item: item('a1', 1) });
  hub.report({ type: 'status', key: 'a1', state: 'playing', t: 3, d: 30, paused: false });
  hub.lock();
  assert.ok(st.res.events().some(e => e.event === 'locked'));
  assert.ok(st.res.ended && ctl.res.ended);
  assert.strictEqual(hub.count('stage'), 0);
  assert.strictEqual(hub.command({ type: 'play' }).status, 423);
  assert.strictEqual(hub.report({ type: 'ready' }).status, 423);
  hub.unlock();
  const s = hub.state();
  assert.strictEqual(s.hold, true);
  assert.strictEqual(s.resume, true, 'it was playing: Hold off plays again');
  assert.strictEqual(s.current.key, 'a1');
  hub.close();
});

test('hub: a pop-up closed while locked does not keep the session open after the unlock', async () => {
  const h = createHub({
    host: { alive: () => false }, graceMs: 20, unlockGraceMs: 40, heartbeatMs: 0,
    settings: { get: () => stageSettings.normalize({}), sizes: stageSettings.OPEN_SIZES },
  });
  h.opened('popup');
  const st = fakeStream();
  h.attach('stage', st.req, st.res);
  h.command({ type: 'load', item: item('a1', 1) });
  h.lock();                        // streams ended; the pop-up is closed while locked and says nothing
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(h.state().open, true, 'nothing decided while locked');
  h.unlock();
  const ctl = fakeStream();
  h.attach('control', ctl.req, ctl.res);
  await new Promise(r => setTimeout(r, 90));
  assert.strictEqual(h.state().open, false);
  assert.ok(ctl.res.events().some(e => e.event === 'gone'));
  assert.strictEqual(h.command({ type: 'play' }).status, 409);
  h.close();
});

test('hub: a Stage that reconnects after the unlock keeps its session', async () => {
  const h = createHub({ host: { alive: () => false }, graceMs: 20, unlockGraceMs: 60, heartbeatMs: 0, settings: { get: () => ({}), sizes: ['free'] } });
  h.opened('popup');
  const s1 = fakeStream();
  h.attach('stage', s1.req, s1.res);
  h.lock();
  h.unlock();
  const s2 = fakeStream();
  h.attach('stage', s2.req, s2.res);
  await new Promise(r => setTimeout(r, 90));
  assert.strictEqual(h.state().open, true);
  h.close();
});

test('hub: opening again within a closing session’s grace period is a new Stage, not a closed one', async () => {
  const h = createHub({ host: { alive: () => false }, graceMs: 30, openGraceMs: 30, heartbeatMs: 0, settings: { get: () => ({}), sizes: ['free'] } });
  h.opened('popup');
  const ctl = fakeStream();
  h.attach('control', ctl.req, ctl.res);
  const s1 = fakeStream();
  h.attach('stage', s1.req, s1.res);
  h.command({ type: 'close' });
  s1.res.end();
  h.opened('popup');               // pressed Stage again at once
  const s2 = fakeStream();
  h.attach('stage', s2.req, s2.res);
  s2.res.end();                    // and this one crashes
  await new Promise(r => setTimeout(r, 70));
  const evs = ctl.res.events().map(e => e.event);
  assert.ok(evs.includes('gone'), evs.join(','));
  assert.ok(!evs.includes('closed'), 'the earlier Close does not carry over');
  h.close();
});

test('hub: privacy mode hiding file names reaches Stage at once and leaves no names in the session', () => {
  const { hub } = hubFor();
  hub.opened('popup');
  const st = fakeStream();
  hub.attach('stage', st.req, st.res);
  hub.command({ type: 'load', item: item('a1', 1), upcoming: [item('a2', 2), item('a3', 3)] });
  assert.strictEqual(hub.command({ type: 'privacy' }).status, 400);
  assert.strictEqual(hub.command({ type: 'privacy', hideNames: true }).status, 200);
  const relayed = st.res.events().filter(e => e.event === 'privacy').pop();
  assert.strictEqual(relayed.data.hideNames, true);
  const s = hub.state();
  assert.strictEqual(s.hideNames, true);
  assert.strictEqual(s.current.filename, '');
  assert.deepStrictEqual(s.upcoming.map(u => u.filename), ['', '']);
  // A Stage that (re)connects is told too, and gets no names.
  const st2 = fakeStream();
  hub.attach('stage', st2.req, st2.res);
  const sync = st2.res.events().find(e => e.event === 'sync').data;
  assert.strictEqual(sync.hideNames, true);
  assert.ok(sync.upcoming.every(u => u.filename === ''));
  // Off again: the flag goes; the names come back with the files Control sends next.
  hub.command({ type: 'privacy', hideNames: false });
  assert.strictEqual(hub.state().hideNames, false);
  hub.command({ type: 'upcoming', upcoming: [item('a2', 2)], forKey: 'a1' });
  assert.strictEqual(hub.state().upcoming[0].filename, 'f2.mp4');
  hub.close();
});

test('Stage and the remote handle privacy changes (names dropped and resent)', () => {
  const stage = fs.readFileSync(path.join(ROOT, 'player-lib', 'stage.js'), 'utf8');
  assert.match(stage, /on\('privacy', \(c\) => setPrivacy\(c\.hideNames === true\)\)/);
  assert.match(stage, /setPrivacy\(s\.hideNames === true\)/, 'from the sync too');
  assert.match(stage, /upcoming\.forEach\(blank\)/);
  assert.match(stage, /settings\.showName \|\| hideNames/);
  const ctl = fs.readFileSync(path.join(ROOT, 'player-lib', 'stage-control.js'), 'utf8');
  assert.match(ctl, /new MutationObserver\(/);
  assert.match(ctl, /cmd\(\{ type: 'privacy', hideNames: on \}\)/);
  assert.match(ctl, /if \(cur\) sendUpcoming\(\);/);
});

test('hub: front, size and close go to the host process while it runs; settings reach Stage and the title', () => {
  const { hub, calls } = hubFor({ alive: true });
  hub.opened('webview2');
  const st = fakeStream();
  hub.attach('stage', st.req, st.res);
  hub.command({ type: 'front' });
  hub.command({ type: 'size', preset: '720p' });
  hub.command({ type: 'close' });
  hub.settingsChanged();
  assert.deepStrictEqual(calls, ['front', 'size:720p', 'close', 'title:Vault Stage']);
  assert.ok(st.res.events().some(e => e.event === 'settings'));
  hub.close();
});

/* ── How Stage opens, and the SDK files ─────────────────────────────────── */

test('chooseMode: the switch, the platform, test servers, the runtime and the files', () => {
  const win = { platform: 'win32', runtime: '130.0', sdkOk: true };
  assert.strictEqual(chooseMode({ ...win, env: {} }).mode, 'webview2');
  assert.strictEqual(chooseMode({ ...win, env: { VAULT_STAGE_HOST: 'popup' } }).mode, 'popup');
  assert.strictEqual(chooseMode({ ...win, platform: 'linux', env: {} }).mode, 'popup');
  assert.strictEqual(chooseMode({ ...win, env: { VAULT_DISABLE_NATIVE_PICKER: '1' } }).mode, 'popup');
  assert.strictEqual(chooseMode({ ...win, env: { VAULT_DISABLE_NATIVE_PICKER: '1', VAULT_STAGE_HOST: 'webview2' } }).mode, 'webview2');
  assert.strictEqual(chooseMode({ ...win, runtime: null, env: {} }).mode, 'popup');
  assert.strictEqual(chooseMode({ ...win, sdkOk: false, env: {} }).mode, 'popup');
  assert.strictEqual(chooseMode({ ...win, platform: 'darwin', env: { VAULT_STAGE_HOST: 'webview2' } }).mode, 'popup');
});

test('sdk.verify: all three files, byte for byte the pinned ones', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'sdk-'));
  const files = {};
  for (const n of ['a.dll', 'b.dll']) {
    const buf = crypto.randomBytes(64);
    fs.writeFileSync(path.join(dir, n), buf);
    files[n] = crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
  }
  assert.strictEqual(sdk.verify(dir, { files }).ok, true);
  const dir2 = fs.mkdtempSync(path.join(tmp, 'sdk-'));
  fs.writeFileSync(path.join(dir2, 'a.dll'), 'changed');
  const r = sdk.verify(dir2, { files });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.mismatched, ['a.dll']);
  assert.deepStrictEqual(r.missing, ['b.dll']);
  assert.deepStrictEqual(Object.keys(sdk.SDK_FILES).sort(), ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']);
  for (const h of Object.values(sdk.SDK_FILES)) assert.match(h, /^[0-9A-F]{64}$/);
});

test('sdk.verify is never cached: a file changed after a check fails the next one', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'sdk-'));
  const buf = crypto.randomBytes(64);
  fs.writeFileSync(path.join(dir, 'WebView2Loader.dll'), buf);
  const files = { 'WebView2Loader.dll': crypto.createHash('sha256').update(buf).digest('hex').toUpperCase() };
  assert.strictEqual(sdk.verify(dir, { files }).ok, true);
  fs.appendFileSync(path.join(dir, 'WebView2Loader.dll'), Buffer.alloc(8));
  assert.strictEqual(sdk.verify(dir, { files }).ok, false);
  // The launcher checks with verify (uncached); only the remote's "how it opens" uses the remembered answer.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'stage', 'host.js'), 'utf8');
  assert.match(src, /const check = sdk\.verify\(dir\)/);
  assert.match(src, /sdk\.looksPresent\(/);
  assert.strictEqual(sdk.pinsEnv({ 'a.dll': 'AB', 'b.dll': 'CD' }), 'a.dll=AB;b.dll=CD');
});

test('the helper checks the files itself and fails closed (pins from the environment)', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const { SCRIPT } = require('../lib/stage/host-script');
  assert.match(SCRIPT, /\$env:VAULT_STAGE_PINS/);
  assert.match(SCRIPT, /Assembly\.Load\(bytes\)/, 'the managed assemblies are loaded from the checked bytes');
  assert.ok(!/Add-Type -Path/.test(SCRIPT), 'never loaded from the SDK folder by path');
  assert.match(SCRIPT, /OpenVerifiedLoader\(launchDir/, 'the loader is checked again right before it is loaded');
  assert.match(SCRIPT, /FileShare\.Read\)/, 'and held read-only until the web view has loaded it');
  assert.match(SCRIPT, /finally \{ loaderLock\.Dispose\(\); \}/);
  const { spawn } = require('node:child_process');
  const run = async (files, pins) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'sdk-run-'));
    for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
    const script = path.join(tmp, `stage-helper-test-${Date.now()}.ps1`);
    fs.writeFileSync(script, SCRIPT);
    // A bad file stops the helper before anything is loaded or any window exists.
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script], {
      windowsHide: true,
      env: { ...process.env, VAULT_STAGE_SDK: dir, VAULT_STAGE_PINS: pins, VAULT_STAGE_LAUNCH: path.join(dir, 'launch'), VAULT_STAGE_URL: 'about:blank', VAULT_STAGE_PARENT: String(process.pid) },
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    const t = setTimeout(() => { try { p.kill(); } catch {} }, 60000);
    const code = await new Promise(r => p.on('exit', r));
    clearTimeout(t);
    return { code, out: out.trim(), written: fs.existsSync(path.join(dir, 'launch', 'Microsoft.Web.WebView2.Core.dll')) };
  };
  const core = crypto.randomBytes(32);
  const bad = await run({ 'Microsoft.Web.WebView2.Core.dll': core }, `Microsoft.Web.WebView2.Core.dll=${'0'.repeat(64)}`);
  assert.strictEqual(bad.code, 3);
  assert.match(bad.out, /error Microsoft\.Web\.WebView2\.Core\.dll is not the expected file/);
  assert.strictEqual(bad.written, false, 'nothing written for a file that failed');
  const noPin = await run({ 'Microsoft.Web.WebView2.Core.dll': core }, '');
  assert.strictEqual(noPin.code, 3);
  assert.match(noPin.out, /error no pin for/);
  const gone = await run({}, `Microsoft.Web.WebView2.Core.dll=${'0'.repeat(64)}`);
  assert.strictEqual(gone.code, 3);
  assert.match(gone.out, /is missing/);
});

test('stale helper scripts and launch folders of a Vault that is gone are swept', () => {
  const t = fs.mkdtempSync(path.join(tmp, 'sweep-'));
  const udd = path.join(t, 'udd');
  let dead = 999999;
  while (pidAlive(dead)) dead--;
  fs.writeFileSync(path.join(t, `vault-stage-${dead}-1.ps1`), 'x');
  fs.writeFileSync(path.join(t, `vault-stage-${process.pid}-1.ps1`), 'x');
  fs.writeFileSync(path.join(t, 'vault-pick-1.ps1'), 'x');
  fs.mkdirSync(path.join(udd, 'sdk-launch', `${dead}-5`), { recursive: true });
  fs.mkdirSync(path.join(udd, 'sdk-launch', `${process.pid}-5`), { recursive: true });
  sweepStale(udd, t);
  assert.ok(!fs.existsSync(path.join(t, `vault-stage-${dead}-1.ps1`)));
  assert.ok(fs.existsSync(path.join(t, `vault-stage-${process.pid}-1.ps1`)), 'its own stays');
  assert.ok(fs.existsSync(path.join(t, 'vault-pick-1.ps1')), 'not ours: left alone');
  assert.ok(!fs.existsSync(path.join(udd, 'sdk-launch', `${dead}-5`)));
  assert.ok(fs.existsSync(path.join(udd, 'sdk-launch', `${process.pid}-5`)));
});

test('the SDK folder is runtime/webview2 (or VAULT_WEBVIEW2_SDK), never the install root', () => {
  assert.strictEqual(sdk.sdkDir({}, 'X:\\Vault'), path.join('X:\\Vault', 'runtime', 'webview2'));
  assert.strictEqual(sdk.sdkDir({ VAULT_WEBVIEW2_SDK: path.join(tmp, 'w') }, 'X:\\Vault'), path.join(tmp, 'w'));
});

test('install layout: the release build puts the SDK files and their licence in runtime/webview2, nothing in the root', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'sea', 'build-app.js'), 'utf8');
  assert.match(src, /STAGE_SDK_DST = path\.join\(OUT, 'runtime', 'webview2'\)/);
  // Every copy of an SDK file or its licence lands under STAGE_SDK_DST.
  const copies = src.split('\n').filter(l => /copyFileSync/.test(l) && /(SDK|WEBVIEW2)/.test(l));
  assert.ok(copies.length >= 2);
  for (const l of copies) assert.match(l, /STAGE_SDK_DST/);
  assert.match(src, /STAGE_SDK\.verify\(STAGE_SDK_SRC\)/, 'checked before copying');
  // The licence text exists and is in the third-party notices too.
  const lic = fs.readFileSync(path.join(ROOT, 'lib', 'stage', 'WEBVIEW2-LICENSE.txt'), 'utf8');
  assert.match(lic, /Microsoft Corporation/);
  assert.match(fs.readFileSync(path.join(ROOT, 'player-lib', 'THIRD-PARTY.txt'), 'utf8'), /Microsoft WebView2 SDK/);
  // WebView2's own profile goes under Vault's data folder, never next to the helper.
  assert.match(fs.readFileSync(path.join(ROOT, 'lib', 'stage', 'host.js'), 'utf8'), /VAULT_STAGE_UDD: udd/);
});

test('the host helper script: no template breaks, every input from the environment, the protocol parses', () => {
  const { SCRIPT } = require('../lib/stage/host-script');
  assert.ok(!SCRIPT.includes('`'), 'no backtick: the script is a template literal');
  for (const v of ['VAULT_STAGE_URL', 'VAULT_STAGE_UDD', 'VAULT_STAGE_SDK', 'VAULT_STAGE_PARENT', 'VAULT_STAGE_TITLE']) assert.ok(SCRIPT.includes(v), v);
  assert.match(SCRIPT, /UserDataFolder = udd/);
  const h = createHost({ env: { VAULT_STAGE_HOST: 'popup' } });
  assert.deepStrictEqual(h.parse('bounds 1 2 3 4 5 6 7 8 0 0 3840 2088 1 10 20 640 360'),
    { type: 'bounds', win: { x: 1, y: 2, w: 3, h: 4 }, client: { x: 5, y: 6, w: 7, h: 8 }, work: { x: 0, y: 0, w: 3840, h: 2088 }, max: true, normal: { x: 10, y: 20, w: 640, h: 360 } });
  assert.deepStrictEqual(h.parse('closing user'), { type: 'closing', why: 'user' });
  assert.strictEqual(h.parse('bounds 1 2 x'), null);
  assert.strictEqual(h.parse('hello'), null);
});

test('stream tokens: Stage\u2019s "stage-" + UUID tokens get the Wall\u2019s closed-token handling', () => {
  assert.strictEqual(ring.isWallToken(`stage-${crypto.randomUUID()}`), true);
  assert.strictEqual(ring.isWallToken(`wall-${crypto.randomUUID()}`), true);
  assert.strictEqual(ring.isWallToken('stage-'), false);
  assert.strictEqual(ring.isWallToken(`stage-${crypto.randomUUID()}x`), false);
  assert.strictEqual(ring.isWallToken(`stagex-${crypto.randomUUID()}`), false);
});

/* ── The routes, on the real app ────────────────────────────────────────── */

const db = require('../lib/database');
const vault = require('../lib/vault');
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
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('GET /stage: the page, not cached, outside the lock gate', async () => {
  const r = await fetch(base + '/stage');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /html/);
  assert.match(r.headers.get('cache-control'), /no-store/);
  const html = await r.text();
  assert.match(html, /<title>Vault Stage<\/title>/);
  assert.match(html, /stage\.js/);
});

test('GET /api/stage/state: closed, how it opens here (the switch says pop-up), the settings', async () => {
  const s = await (await fetch(base + '/api/stage/state')).json();
  assert.strictEqual(s.open, false);
  assert.strictEqual(s.how, 'popup');
  assert.strictEqual(s.settings.windowName, 'Vault Stage');
});

test('events need a known role; commands before Stage opens are refused', async () => {
  assert.strictEqual((await fetch(base + '/api/stage/events?role=boss')).status, 400);
  const r = await post('/api/stage/cmd', { type: 'play' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).code, 'STAGE_CLOSED');
  assert.strictEqual((await post('/api/stage/cmd', { type: 'nope' })).status, 400);
  assert.strictEqual((await post('/api/stage/report', { type: 'status', state: 'bogus' })).status, 400);
});

test('POST /api/stage/open with the pop-up switch: no window, the page opens it; commands then work', async () => {
  const r = await (await post('/api/stage/open', {})).json();
  assert.strictEqual(r.mode, 'popup');
  const ok = await post('/api/stage/cmd', { type: 'load', item: item('r1', 1), upcoming: [] });
  assert.strictEqual(ok.status, 200);
  const s = await (await fetch(base + '/api/stage/state')).json();
  assert.strictEqual(s.open, true);
  assert.strictEqual(s.current.key, 'r1');
  const close = await (await post('/api/stage/cmd', { type: 'close' })).json();
  assert.strictEqual(close.last.current.key, 'r1');
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
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/stage/state', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.ok(status >= 400 && status < 500, `foreign Host: ${status}`);
});

test('Settings › Stage: read, saved, checked', async () => {
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
  const stored = JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8')).stage;
  assert.strictEqual(stored.windowName, 'Friday show');
});

test('locked: every Stage route under /api answers 423; the page itself still loads (it shows black)', async () => {
  vault._locked = true;
  try {
    for (const [m, p] of [['GET', '/api/stage/state'], ['GET', '/api/stage/events?role=stage'], ['GET', '/api/stage/settings'],
      ['POST', '/api/stage/cmd'], ['POST', '/api/stage/report'], ['POST', '/api/stage/open'], ['POST', '/api/stage/settings']]) {
      const r = m === 'GET' ? await fetch(base + p) : await post(p, { type: 'play' });
      assert.strictEqual(r.status, 423, `${m} ${p}`);
    }
    assert.strictEqual((await fetch(base + '/stage')).status, 200);
  } finally {
    vault._locked = false;
  }
});
