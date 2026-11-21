/**
 * mpv Stage plays what browsers refuse (HEVC, MPEG-2, WMV, AC-3 ...), so
 * while mpv is Stage a file is passed over only for reasons true for mpv:
 *
 *  - decideMpv (player-lib/playback-decide.js): a probed file against the
 *    decoders the running mpv reported; unprobed or not known: handed over
 *  - mpv-caps.js: the decoder-list read once per mpv start, null when it
 *    cannot be read
 *  - the engine and the hub remember a file mpv failed on for the rest of
 *    that Stage (never handed again; a file picked by hand gets another go),
 *    and never write the browser's playback_failed mark
 *  - the page (stage-control.js computeUpcoming, countInputs; player-core.js
 *    isKnownBadMedia): what mpv is handed, the queue's walk and "Plays in"
 *    ignore the browser's verdict under mpv, and keep it everywhere else
 *    (no Stage, Basic Stage, the library's own "Plays here").
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const Decide = require('../player-lib/playback-decide.js');
const StageRules = require('../player-lib/stage-rules.js');
const { readMpvCaps, codecsFromDecoderList } = require('../lib/stage/mpv-caps');
const { createEngine } = require('../lib/stage/engine');
const { createHub, validateReport } = require('../lib/stage/hub');

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

// What a typical mpv build reports (a slice of it): far more than a browser.
const MPV = new Set(['h264', 'hevc', 'av1', 'vp8', 'vp9', 'mpeg2video', 'mpeg4', 'msmpeg4v3', 'wmv3', 'vc1', 'theora',
  'aac', 'mp3', 'ac3', 'eac3', 'dts', 'wmav2', 'flac', 'opus', 'vorbis', 'pcm_s16le', 'mjpeg']);
// Chrome without HEVC: the caps the browser judges by.
const BROWSER = new Set(['h264', 'vp8', 'vp9', 'av1', 'aac', 'mp3', 'opus', 'flac']);

const probed = (extra) => ({ media_type: 'video', probe_version: 1, ...extra });
const ROWS = {
  hevcMkv: probed({ id: 1, filename: 'a.mkv', video_codec: 'hevc', audio_codec: 'aac', container: 'matroska,webm', pix_fmt: 'yuv420p' }),
  mpeg2: probed({ id: 2, filename: 'b.mpg', video_codec: 'mpeg2video', audio_codec: 'mp2', container: 'mpeg' }),
  wmv: probed({ id: 3, filename: 'c.wmv', video_codec: 'wmv3', audio_codec: 'wmav2', container: 'asf' }),
  ac3: probed({ id: 4, filename: 'd.mkv', video_codec: 'h264', audio_codec: 'ac3', container: 'matroska,webm', pix_fmt: 'yuv420p' }),
  xvidAvi: probed({ id: 5, filename: 'e.avi', video_codec: 'mpeg4', audio_codec: 'mp3', container: 'avi' }),
  failedHere: probed({ id: 6, filename: 'f.mp4', video_codec: 'h264', audio_codec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2', playback_failed: 1 }),
  unprobedMkv: { id: 7, media_type: 'video', filename: 'g.mkv', probe_version: 0 },
  rv40: probed({ id: 8, filename: 'h.rmvb', video_codec: 'rv40', audio_codec: 'cook', container: 'rm' }),
  plain: probed({ id: 9, filename: 'i.mp4', video_codec: 'h264', audio_codec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2', pix_fmt: 'yuv420p' }),
};

/* ── decideMpv ────────────────────────────────────────────────────────── */

test('decideMpv: what browsers refuse plays when this mpv has the decoder', () => {
  for (const k of ['hevcMkv', 'mpeg2', 'wmv', 'ac3', 'xvidAvi', 'plain']) {
    assert.deepStrictEqual(Decide.decideMpv(ROWS[k], MPV), { state: 'play', reason: null }, k);
  }
  // The same files, judged for the browser: unchanged, still refused.
  for (const k of ['hevcMkv', 'mpeg2', 'wmv', 'xvidAvi']) {
    assert.strictEqual(Decide.decide(ROWS[k], BROWSER).mode, 'unsupported', `${k}: the browser still says no`);
  }
});

test('decideMpv: a codec this mpv lacks is still left out up front, with a plain reason', () => {
  const v = Decide.decideMpv(ROWS.rv40, MPV);
  assert.strictEqual(v.state, 'no');
  assert.strictEqual(v.reason, 'mpv on this computer has no decoder for RealVideo video.');
  assert.ok(!/—/.test(v.reason), 'no em dash');
  // A sound file whose codec mpv lacks; a file with no stream at all.
  assert.strictEqual(Decide.decideMpv({ media_type: 'audio', probe_version: 1, audio_codec: 'atrac9' }, MPV).state, 'no');
  assert.strictEqual(Decide.decideMpv(probed({}), MPV).state, 'no');
  // Video whose sound mpv cannot decode: the picture still plays.
  assert.strictEqual(Decide.decideMpv(probed({ video_codec: 'h264', audio_codec: 'cook' }), MPV).state, 'play');
  // h265 is HEVC.
  assert.strictEqual(Decide.decideMpv(probed({ video_codec: 'H265' }), MPV).state, 'play');
});

test('decideMpv: the browser\'s own verdicts are not asked (playback_failed, the extension list)', () => {
  assert.strictEqual(Decide.decideMpv(ROWS.failedHere, MPV).state, 'play');
  assert.strictEqual(Decide.decideMpv(ROWS.unprobedMkv, MPV).state, 'unknown', 'not probed: handed over, mpv decides');
});

test('decideMpv: no decoder list (not read) rules nothing out; pictures and documents are not its business', () => {
  for (const caps of [null, undefined, new Set(), []]) {
    assert.strictEqual(Decide.decideMpv(ROWS.rv40, caps).state, 'unknown');
  }
  assert.strictEqual(Decide.decideMpv({ media_type: 'image', probe_version: 1, video_codec: 'png' }, MPV).state, 'unknown');
  assert.strictEqual(Decide.decideMpv(null, MPV).state, 'unknown');
  assert.strictEqual(Decide.decideMpv(ROWS.hevcMkv, [...MPV]).state, 'play', 'an array works as well as a Set');
});

/* ── mpv-caps.js ──────────────────────────────────────────────────────── */

test('mpv caps: codec names from decoder-list, each once, junk dropped', () => {
  const list = [
    { codec: 'h264', driver: 'h264', description: 'H.264' },
    { codec: 'h264', driver: 'h264_cuvid', description: 'Nvidia' },
    { codec: 'HEVC', driver: 'hevc' },
    { codec: 'ac3', driver: 'ac3' },
    { codec: 'bad name', driver: 'x' }, { codec: '<script>' }, { driver: 'no codec' }, null, 'str',
  ];
  assert.deepStrictEqual(codecsFromDecoderList(list), ['ac3', 'h264', 'hevc']);
  // Real names with a dot or a dash are kept.
  assert.deepStrictEqual(codecsFromDecoderList([{ codec: 'acelp.kelvin' }, { codec: 'g723_1' }, { codec: 'dvb_subtitle' }, { codec: 'adpcm_ima_qt' }, { codec: 'a-b' }, { codec: '.x' }]),
    ['a-b', 'acelp.kelvin', 'adpcm_ima_qt', 'dvb_subtitle', 'g723_1']);
  assert.strictEqual(codecsFromDecoderList(null), null);
  assert.strictEqual(codecsFromDecoderList({}), null);
  assert.strictEqual(codecsFromDecoderList([]), null);
});

test('mpv caps: asked once over IPC with a time limit; an mpv that does not answer gives null, never a throw', async () => {
  const asked = [];
  const ok = await readMpvCaps({ command: async (cmd, opts) => { asked.push([cmd, opts]); return [{ codec: 'wmv3' }, { codec: 'hevc' }]; } });
  assert.deepStrictEqual(ok, { codecs: ['hevc', 'wmv3'] });
  assert.deepStrictEqual(asked[0][0], ['get_property', 'decoder-list']);
  assert.ok(asked[0][1].timeoutMs > 0);
  assert.strictEqual(await readMpvCaps({ command: async () => { throw new Error('property unavailable'); } }), null);
  assert.strictEqual(await readMpvCaps({ command: async () => null }), null);
  assert.strictEqual(await readMpvCaps(null), null);
});

/* ── The engine: a file mpv fails on ──────────────────────────────────── */

function engineFor() {
  let entry = 0;
  const loads = [];
  const reports = [];
  const mpv = {
    alive: () => true,
    async set() { return null; },
    async get() { return null; },
    async command(cmd) { if (Array.isArray(cmd) && cmd[0] === 'get_property' && cmd[1] === 'playlist') return []; return null; },
    async loadfile(file, mode) { entry += 1; loads.push([file, mode, entry]); return { playlist_entry_id: entry }; },
  };
  const timers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  const engine = createEngine({
    mpv, report: (r) => reports.push(r), now: () => 1e6, timers, readFile: async () => Buffer.alloc(0),
    settings: () => ({ showName: false }),
    lib: { pathFor: (id) => ({ ok: true, path: `D:\\m\\${id}.mkv` }), recordView() {}, savePosition() {}, mergeHeatmap() {}, touch() {}, isLocked: () => false },
  });
  engine.started({ volume: 1 });
  const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };
  const ev = async (e) => { engine.onEvent(e); await settle(); };
  return { engine, loads, reports, settle, ev };
}
const item = (key, id) => ({ key, id, media_type: 'video', filename: `${key}.mkv`, duration: 30, startAt: 0, via: 'list', index: id });

test('engine: a file mpv cannot play is reported failed and never handed to mpv again this Stage', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: item('a', 1), upcoming: [item('b', 2), item('c', 3)], repeat: 'all' });
  await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  await e.ev({ event: 'end-file', reason: 'eof', playlist_entry_id: 1 });
  await e.ev({ event: 'start-file', playlist_entry_id: 2 });
  // b: mpv's error before it showed anything.
  await e.ev({ event: 'end-file', reason: 'error', playlist_entry_id: 2 });
  assert.deepStrictEqual(e.reports.find(r => r.type === 'skipped'), { type: 'skipped', key: 'b', reason: 'it can’t be played', failed: true });
  assert.deepStrictEqual(e.engine._state().failed, [2]);
  // mpv moves on to c by itself (it was lined up).
  await e.ev({ event: 'start-file', playlist_entry_id: 3 });
  // Round again (Repeat all): Control (from an older list) hands b once more; it is passed over without mpv.
  const before = e.loads.length;
  e.engine.command({ type: 'upcoming', upcoming: [item('b2', 2), item('a2', 1)], repeat: 'all' });
  await e.settle();
  assert.ok(!e.loads.slice(before).some(l => l[0] === 'D:\\m\\2.mkv'), 'b never goes to mpv again');
  assert.ok(e.reports.some(r => r.type === 'skipped' && r.key === 'b2' && r.failed === true), 'and Control is told why');
  // Picked by hand: mpv gets another go.
  e.engine.command({ type: 'load', item: item('b3', 2), upcoming: [], repeat: 'off' });
  await e.settle();
  assert.deepStrictEqual(e.loads.at(-1).slice(0, 2), ['D:\\m\\2.mkv', 'replace']);
  assert.deepStrictEqual(e.engine._state().failed, []);
});

test('engine: a file that stopped part way (it did show) is not remembered as one mpv cannot play', async () => {
  const e = engineFor();
  e.engine.command({ type: 'load', item: item('a', 1), upcoming: [item('b', 2)], repeat: 'off' });
  await e.settle();
  await e.ev({ event: 'start-file', playlist_entry_id: 1 });
  await e.ev({ event: 'file-loaded' });
  await e.ev({ event: 'end-file', reason: 'error', playlist_entry_id: 1 });
  const r = e.reports.find(x => x.type === 'skipped');
  assert.deepStrictEqual(r, { type: 'skipped', key: 'a', reason: 'it stopped playing' });
  assert.deepStrictEqual(e.engine._state().failed, []);
});

/* ── The hub: the judgement goes to Control ───────────────────────────── */

function hubFor(caps) {
  const events = [];
  const stage = { alive: () => true, command() {}, caps: () => caps };
  const hub = createHub({ stage, settings: { get: () => ({}), sizes: ['free'] }, heartbeatMs: 0 });
  const res = { writeHead() {}, write: (s) => { const m = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(s); if (m) events.push([m[1], JSON.parse(m[2])]); }, on() {}, end() {} };
  hub.attach('control', { on() {} }, res);
  return { hub, events };
}

test('hub: mpv\'s decoders go with opened, sync and the state; a file it failed on is remembered until a hand pick or the end of Stage', () => {
  const { hub, events } = hubFor({ codecs: ['hevc', 'wmv3'] });
  hub.opened('mpv');
  assert.deepStrictEqual(events.find(e => e[0] === 'opened')[1], { mode: 'mpv', mpvCaps: ['hevc', 'wmv3'], mpvFailed: [] });
  assert.deepStrictEqual(hub.state().mpvCaps, ['hevc', 'wmv3']);
  hub.command({ type: 'load', item: { key: 'a', id: 1, media_type: 'video', filename: 'a.mkv' }, upcoming: [{ key: 'b', id: 2, media_type: 'video', filename: 'b.mkv' }] });
  assert.deepStrictEqual(validateReport({ type: 'skipped', key: 'b', failed: 'yes' }).rep.failed, false, 'only true counts');
  hub.report({ type: 'skipped', key: 'b', reason: 'it can’t be played', failed: true });
  assert.deepStrictEqual(events.filter(e => e[0] === 'skipped').pop()[1].failed, true);
  assert.deepStrictEqual(hub.state().mpvFailed, [2]);
  // A skip for another reason (a missing file) is not mpv failing.
  hub.report({ type: 'skipped', key: 'a', reason: 'it is not in the library' });
  assert.deepStrictEqual(hub.state().mpvFailed, [2]);
  hub.command({ type: 'load', item: { key: 'b9', id: 2, media_type: 'video', filename: 'b.mkv' } });
  assert.deepStrictEqual(hub.state().mpvFailed, [], 'picked by hand: another go');
  hub.report({ type: 'skipped', key: 'b9', reason: 'it can’t be played', failed: true });
  hub.stageExited({ byUser: true });
  assert.deepStrictEqual(hub.state().mpvFailed, [], 'a new Stage starts with a clean slate');
});

test('hub: decoders not known (an mpv that would not say) is null, so nothing is ruled out', () => {
  const { hub } = hubFor(null);
  hub.opened('mpv');
  assert.strictEqual(hub.state().mpvCaps, null);
  assert.deepStrictEqual(hub.mpvJudge(), { mpvCaps: null, mpvFailed: [] });
});

/* ── The page: what mpv is handed, the queue, "Plays in" ──────────────── */

/**
 * stage-control.js's judgement (knownBad, stageBad, takeMpvJudge) and
 * computeUpcoming, with player-core.js's isKnownBadMedia and filters.js's
 * mediaPlaybackState (the browser's verdict) as they are, in one VM.
 */
function pageFor(rows, { open = true, basic = false, caps = [...MPV], failed = [] } = {}) {
  const sc = read('player-lib/stage-control.js');
  const core = read('player-lib/player/player-core.js');
  const filters = read('player-lib/filters.js');
  const ids = rows.map(r => r.id);
  const byId = new Map(rows.map(r => [r.id, r]));
  const Library = {
    known: () => true, length: () => ids.length, idAt: (i) => ids[i], typeAt: (i) => byId.get(ids[i]).media_type,
    rowAt: (i) => byId.get(ids[i]), row: (id) => byId.get(id) || null,
    needsFetch: () => false, waitIds: async () => ids,
    fetchRows: async (want) => want.map(id => byId.get(id) || null),
    rowsForRange: async () => {},
  };
  const ctx = {
    window: { VaultPlaybackDecide: Decide }, Library, StageRules,
    UpNext: { items: () => [] },
    listNow: () => Library, listAnchorIndex: () => -1, currentRepeat: () => 'off', queueSkipSet: () => null,
    codecCaps: () => [...BROWSER].join(','),
    itemFor: (row) => ({ id: row.id }),
    // handBack's surroundings
    played: [], toasts: [], currentMediaState: { element: null },
    forgetSource() {}, hideTips() {}, closeMenu() {}, leaveRemote() {}, disconnect() {}, applyMute() {}, refreshState() {}, minimizePlayer() {},
    fmt: (x) => String(x),
    Set, Map, Math, Number, Array, Error, Promise, String, Object, JSON,
  };
  vm.createContext(ctx);
  const constOf = (src, name) => {
    const m = new RegExp(`const ${name} = new Set\\(\\[[\\s\\S]*?\\]\\);`).exec(src);
    assert.ok(m, name);
    return m[0];
  };
  vm.runInContext(`
    ${constOf(filters, 'BROWSER_PLAYABLE_EXTENSIONS')}
    ${constOf(filters, 'PLAYBACK_CODEC_TYPES')}
    let _playbackCaps = null;
    ${grab(filters, 'function playbackCapsSet(')}
    ${grab(filters, 'function mediaPlaybackState(')}
    ${grab(filters, 'function getExtension(')}
    ${grab(core, 'function isKnownBadMedia(')}
    const STAGEABLE = new Set(['video', 'image', 'gif', 'audio']);
    const UPCOMING_COUNT = 500;
    let open = ${open}, basic = ${basic};
    let mpvCodecs = null;
    const mpvFailed = new Set();
    ${grab(sc, 'function takeMpvJudge(')}
    ${grab(sc, 'function knownBad(')}
    ${grab(sc, 'function stageBad(')}
    ${grab(sc, 'async function computeUpcoming(')}
    let closeGen = 0, sentHideNames = null, cur = null;
    const playMedia = (m) => played.push(m.id);
    const showToast = (t) => toasts.push(t);
    ${grab(sc, 'function handBack(')}
    var StageControl = { knownBad };
    globalThis.__p = { handBack, setCur: (row) => { cur = { key: 'k', row }; }, isOpen: () => open, computeUpcoming, isKnownBadMedia, mediaPlaybackState, knownBad, takeMpvJudge, setOpen: (o, b) => { open = o; basic = b; } };
  `, ctx);
  ctx.__p.takeMpvJudge({ mpvCaps: caps, mpvFailed: failed });
  ctx.__p.ctx = ctx;
  return ctx.__p;
}

const ALL = Object.values(ROWS);
const idsOf = (list) => Array.from(list, i => i.id);   // out of the VM's realm

test('page, mpv Stage: what browsers refuse is handed to mpv; only what mpv lacks is left out', async () => {
  const p = pageFor(ALL);
  const up = await p.computeUpcoming();
  assert.deepStrictEqual(idsOf(up), [1, 2, 3, 4, 5, 6, 7, 9], 'HEVC, MPEG-2, WMV, AC-3, Xvid AVI, a file that failed in the browser, an unprobed .mkv: all go; RealVideo does not');
  // The queue's walk (Next, auto-advance, the end of the list) asks the same.
  assert.deepStrictEqual(ALL.filter(r => p.isKnownBadMedia(r)).map(r => r.id), [8]);
});

test('page, mpv Stage: a file mpv failed on is left out for the rest of the Stage', async () => {
  const p = pageFor(ALL, { failed: [2] });
  assert.deepStrictEqual(idsOf(await p.computeUpcoming()), [1, 3, 4, 5, 6, 7, 9]);
  assert.strictEqual(p.isKnownBadMedia(ROWS.mpeg2), true);
});

test('page, mpv Stage with its decoders not known: everything is handed over (mpv\'s own error skips what it cannot play)', async () => {
  const p = pageFor(ALL, { caps: null });
  assert.deepStrictEqual(idsOf(await p.computeUpcoming()), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('page, no Stage and Basic Stage: the browser\'s verdict stands, exactly as before', async () => {
  for (const [o, b] of [[false, false], [true, true]]) {
    const p = pageFor(ALL);
    p.setOpen(o, b);
    assert.strictEqual(p.knownBad(ROWS.hevcMkv), null, 'mpv\'s judgement is not asked');
    const bad = ALL.filter(r => p.isKnownBadMedia(r)).map(r => r.id);
    const browser = ALL.filter(r => p.mediaPlaybackState(r).state === 'no').map(r => r.id);
    assert.deepStrictEqual(bad, browser);
    assert.deepStrictEqual(bad, [1, 2, 3, 5, 6, 8], `open ${o}, basic ${b}: HEVC, MPEG-2, WMV, Xvid, the failed one and RealVideo`);
  }
});

test('page: the library\'s own "Plays here" verdict is the browser\'s even while mpv is Stage', () => {
  const p = pageFor(ALL);
  assert.strictEqual(p.mediaPlaybackState(ROWS.hevcMkv).state, 'no');
  assert.strictEqual(p.mediaPlaybackState(ROWS.failedHere).state, 'no');
  assert.strictEqual(p.isKnownBadMedia(ROWS.hevcMkv), false, 'while the queue, which plays on mpv, takes it');
});

test('page (source): the count, "Plays in" and what mpv is handed all go through the open Stage\'s judgement; mpv\'s failures never set playback_failed', () => {
  const sc = read('player-lib/stage-control.js');
  assert.match(grab(sc, 'function countInputs('), /const badRow = stageBad;/);
  assert.match(grab(sc, 'async function computeUpcoming('), /const okRow = \(r\) => !!r && STAGEABLE\.has\(r\.media_type\) && !stageBad\(r\);/);
  const skipped = grab(sc, 'function onSkipped(');
  assert.match(skipped, /mpvFailed\.add\(item\.id\)/);
  assert.ok(!/playback_failed/.test(skipped), 'the browser\'s mark is not written');
  assert.match(grab(sc, 'async function doOpen('), /takeMpvJudge\(r\);/, 'known before the first list is worked out');
  assert.ok(!/playback_failed\s*[:=]/.test(read('lib/stage/engine.js') + read('lib/stage/hub.js')), 'the engine and the hub never write it either');
});

/* ── The read of mpv's decoders never gets in the way of opening or closing ── */

/**
 * The Stage routes with a fake mpv whose decoder-list answer waits for the
 * test (release()), so something can happen while it is being read.
 */
async function routesWithSlowRead() {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-mpvcaps-'));
  process.env.VAULT_DB = process.env.VAULT_DB || path.join(tmp, 'library.db');
  process.env.VAULT_SETTINGS_FILE = process.env.VAULT_SETTINGS_FILE || path.join(tmp, 'settings.json');
  process.env.VAULT_OFFLINE = '1';
  process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
  const express = require('express');
  const { buildRouter } = require('../server/stage-routes');
  const t = { quits: 0, kills: 0, host: null };
  let release;
  t.reading = new Promise((resolve) => { t.readStarted = resolve; });
  const answer = new Promise((resolve) => { release = resolve; });
  t.release = () => release([{ codec: 'hevc' }, { codec: 'acelp.kelvin' }]);
  const factory = (opts) => {
    let alive = false;
    const host = {
      opts,
      async start() { alive = true; return { ok: true }; },
      alive: () => alive,
      command: async (cmd) => {
        if (cmd[1] === 'decoder-list') { t.readStarted(); return answer; }
        return null;
      },
      set: async () => null,
      get: async () => null,
      loadfile: async () => ({ playlist_entry_id: 1 }),
      quit: () => { t.quits++; alive = false; setImmediate(() => opts.onExit({ code: 0, asked: true })); },
      kill: () => { t.kills++; alive = false; },
      exitNow: () => { alive = false; opts.onExit({ code: 1, asked: false }); },
      get pid() { return 1; },
    };
    t.host = host;
    return host;
  };
  const router = buildRouter({
    hostFactory: factory,
    find: async () => ({ found: true, path: 'C:\mpv\mpv.exe', version: 'v0.41.0', source: 'default' }),
    lib: { pathFor: () => ({ ok: false, reason: 'no' }), isLocked: () => false },
    env: { VAULT_STAGE_MUTE: '1', VAULT_STAGE_TEST_QUIET: '1' },
  });
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const at = `http://127.0.0.1:${server.address().port}`;
  t.post = (p, body) => fetch(at + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  t.state = async () => (await fetch(at + '/api/stage/state')).json();
  t.done = () => new Promise((resolve) => server.close(resolve));
  return t;
}

test('open: mpv going away while its decoders are read ends cleanly (200, Stage closed, nothing thrown)', async () => {
  const t = await routesWithSlowRead();
  try {
    const opening = t.post('/api/stage/open', {});
    await t.reading;
    t.host.exitNow();
    t.release();
    const r = await opening;
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, mode: 'mpv', mpvCaps: null, mpvFailed: [] });
    const s = await t.state();
    assert.strictEqual(s.open, false, 'Stage is closed');
    assert.strictEqual(s.mpvCaps, null);
  } finally { await t.done(); }
});

test('open: a Close while mpv\'s decoders are read closes Stage (mpv asked to quit), the open still answers cleanly', async () => {
  const t = await routesWithSlowRead();
  try {
    const opening = t.post('/api/stage/open', {});
    await t.reading;
    const c = await t.post('/api/stage/cmd', { type: 'close', stop: true });
    assert.strictEqual(c.status, 200);
    await new Promise(r => setImmediate(r));
    assert.strictEqual(t.quits, 1, 'mpv was asked to quit: no mpv left behind');
    t.release();
    const r = await opening;
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).mpvCaps, null, 'a closed mpv\'s decoders are not kept');
    assert.strictEqual((await t.state()).open, false);
  } finally { await t.done(); }
});

test('open: the decoders read after opening reach the answer and the state (names with a dot kept)', async () => {
  const t = await routesWithSlowRead();
  try {
    const opening = t.post('/api/stage/open', {});
    await t.reading;
    t.release();
    const body = await (await opening).json();
    assert.deepStrictEqual(body.mpvCaps, ['acelp.kelvin', 'hevc']);
    assert.deepStrictEqual((await t.state()).mpvCaps, ['acelp.kelvin', 'hevc']);
    await t.post('/api/stage/cmd', { type: 'close', stop: true });
    await new Promise(r => setImmediate(r));
  } finally { await t.done(); }
});

test('closing mpv Stage on a file only mpv plays does not open it in this browser; one the browser plays is handed back as before', () => {
  for (const [row, here] of [[{ ...ROWS.hevcMkv, filepath: 'D:/a.mkv' }, false], [{ ...ROWS.failedHere, filepath: 'D:/f.mp4' }, false], [{ ...ROWS.plain, filepath: 'D:/i.mp4' }, true]]) {
    const p = pageFor(ALL);
    p.setCur(row);
    p.handBack({ t: 12, paused: false, how: 'closed' });
    const ctx = p.ctx;
    assert.strictEqual(p.isOpen(), false, 'Stage is closed either way');
    assert.deepStrictEqual(Array.from(ctx.played), here ? [row.id] : [], row.filename);
    assert.deepStrictEqual(Array.from(ctx.toasts), [here ? 'Stage closed. Playing here from 12.' : 'Stage closed.'], 'no error, just the close');
  }
});
