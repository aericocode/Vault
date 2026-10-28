/**
 * The Stage set log: what Stage played, for the streamer.
 *
 *   - lib/stage/setlog.js on its own, with a fake clock and an in-memory
 *     database: where a set starts and ends (Stage closed, 30 minutes of
 *     nothing playing), the 30 second skip, offsets, a file played again,
 *     pauses, the last 20 sets kept;
 *   - the hub (lib/stage/hub.js) telling it what mpv Stage plays;
 *   - player-lib/stage-setlog.js SetLogRules: the times, the copies;
 *   - the routes, on the real app (the set log in Vault's own database,
 *     Basic Stage's reports from the page).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-setlog-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
delete process.env.VAULT_DB_PASSWORD;

const Database = require('better-sqlite3');
const vm = require('node:vm');
const { ensureSchema, createSetLog, IDLE_MS, KEEP_SETS, FLUSH_MS, BASIC_STALE_MS } = require('../lib/stage/setlog');
const { createHub } = require('../lib/stage/hub');
const R = require('../player-lib/stage-setlog.js');

const MIN = 60 * 1000;
const T0 = new Date(2026, 9, 27, 20, 2, 0).getTime();   // Tue Oct 27 2026, 8:02 PM

function rig({ titles = {}, locked = null } = {}) {
  const mem = new Database(':memory:');
  ensureSchema(mem);
  const clock = { t: T0 };
  const log = createSetLog({ db: () => mem, now: () => clock.t, titleFor: (id) => titles[id] || null, isLocked: () => !!(locked && locked.on) });
  const at = (ms) => { clock.t = ms; };
  const step = (ms) => { clock.t += ms; };
  const newest = () => log.setById(log.sets()[0].id);
  return { mem, log, clock, at, step, newest };
}

/* ── Recording ──────────────────────────────────────────────────────────── */

test('a set starts with the first file played, offsets from there, newest first', () => {
  const { log, step, newest } = rig();
  assert.deepStrictEqual(log.sets(), [], 'nothing until Stage plays');
  log.start({ id: 1, title: 'Opening Glow', key: 'a', playing: true });
  step(3 * MIN + 24000);
  log.start({ id: 2, title: 'Night Drive', key: 'b', playing: true });
  step(4 * MIN);
  const { set, entries } = newest();
  assert.strictEqual(set.startedAt, T0);
  assert.strictEqual(set.open, true);
  assert.deepStrictEqual(entries.map(e => [e.title, e.offset, e.now, e.skipped]), [
    ['Night Drive', 204, true, false],
    ['Opening Glow', 0, false, false],
  ]);
  assert.strictEqual(entries[1].played, 204);
  assert.strictEqual(entries[0].played, 240, 'the file playing now counts up');
  assert.strictEqual(set.played, 2);
});

test('under 30 seconds played is a skip; pauses do not count and make no new entry', () => {
  const { log, step, newest } = rig();
  log.start({ id: 1, title: 'Static Bloom', key: 'a', playing: true });
  step(28000);
  log.start({ id: 2, title: 'Harbor', key: 'b', playing: true });
  step(20000);
  log.playing(false, 'b');               // paused for ten minutes
  step(10 * MIN);
  log.playing(true, 'b');
  step(15000);
  log.stop();
  const { entries, set } = newest();
  assert.strictEqual(entries.length, 2, 'a pause is not a new entry');
  const [harbor, bloom] = entries;
  assert.strictEqual(bloom.skipped, true);
  assert.strictEqual(bloom.played, 28);
  assert.strictEqual(harbor.played, 35, 'only the time it played');
  assert.strictEqual(harbor.skipped, false);
  assert.strictEqual(set.played, 1);
});

test('a report about another file than the one playing is ignored', () => {
  const { log, step, newest } = rig();
  log.start({ id: 1, title: 'A', key: 'a', playing: true });
  step(40000);
  log.playing(false, 'zzz');
  step(20000);
  assert.strictEqual(newest().entries[0].played, 60);
});

test('the same file played again later is a new entry; the same play told twice is not', () => {
  const { log, step, newest } = rig();
  log.start({ id: 7, title: 'Harbor', key: 'a', playing: true });
  step(MIN);
  log.start({ id: 7, title: 'Harbor', key: 'a', playing: true });     // mpv picking it up again after an unlock
  step(MIN);
  log.start({ id: 8, title: 'Overpass', key: 'b', playing: true });
  step(MIN);
  log.start({ id: 7, title: 'Harbor', key: 'c', playing: true });
  step(MIN);
  const { entries } = newest();
  assert.deepStrictEqual(entries.map(e => [e.mediaId, e.offset]), [[7, 180], [8, 120], [7, 0]]);
  assert.strictEqual(entries[2].played, 120);
});

test('closing Stage ends the set; the next file starts a new one at 0:00', () => {
  const { log, step } = rig();
  log.start({ id: 1, title: 'A', key: 'a', playing: true });
  step(5 * MIN);
  log.close();
  step(MIN);
  log.start({ id: 2, title: 'B', key: 'b', playing: true });
  const [now, before] = log.sets();
  assert.strictEqual(before.open, false);
  assert.strictEqual(before.endedAt, T0 + 5 * MIN);
  assert.strictEqual(before.duration, 300);
  assert.strictEqual(now.open, true);
  assert.strictEqual(log.setById(now.id).entries[0].offset, 0);
});

test('30 minutes with nothing playing ends the set; 29 does not', () => {
  const { log, step, clock } = rig();
  log.start({ id: 1, title: 'A', key: 'a', playing: true });
  step(5 * MIN);
  log.stop();                                    // the list finished
  step(29 * MIN);
  log.start({ id: 2, title: 'B', key: 'b', playing: true });
  assert.strictEqual(log.sets().length, 1, 'under 30 minutes: the same set');
  step(MIN);
  log.playing(false, 'b');                       // paused, then left
  const pausedAt = clock.t;
  step(IDLE_MS);
  const sets = log.sets();
  assert.strictEqual(sets.length, 1);
  assert.strictEqual(sets[0].open, false, 'ended by the reading itself');
  assert.strictEqual(sets[0].endedAt, pausedAt, 'ended when playing stopped');
  // Play pressed after that: a new set, that file first.
  log.playing(true, 'b');
  const after = log.sets();
  assert.strictEqual(after.length, 2);
  const { entries } = log.setById(after[0].id);
  assert.deepStrictEqual(entries.map(e => [e.mediaId, e.offset, e.now]), [[2, 0, true]]);
});

test('only the last 20 sets are kept', () => {
  const { log, step, mem } = rig();
  for (let i = 0; i < KEEP_SETS + 5; i++) {
    log.start({ id: i + 1, title: `F${i}`, key: `k${i}`, playing: true });
    step(MIN);
    log.close();
    step(MIN);
  }
  const sets = log.sets();
  assert.strictEqual(sets.length, KEEP_SETS);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) n FROM stage_sets').get().n, KEEP_SETS);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) n FROM stage_set_entries').get().n, KEEP_SETS, 'their entries go too');
  assert.strictEqual(log.setById(sets[0].id).entries[0].title, `F${KEEP_SETS + 4}`);
  assert.strictEqual(log.setById(sets[KEEP_SETS - 1].id).entries[0].title, 'F5');
});

test('the title is the library name at the time, else the one given', () => {
  const { log, newest } = rig({ titles: { 1: 'From the library.mp4' } });
  log.start({ id: 1, title: '', key: 'a', playing: true });
  log.start({ id: 2, title: 'Given.mp4', key: 'b', playing: true });
  assert.deepStrictEqual(newest().entries.map(e => e.title), ['Given.mp4', 'From the library.mp4']);
});

test('a set left open by an earlier run ends where its last file did', () => {
  const mem = new Database(':memory:');
  ensureSchema(mem);
  const clock = { t: T0 };
  const a = createSetLog({ db: () => mem, now: () => clock.t });
  a.start({ id: 1, title: 'A', key: 'a', playing: true });
  clock.t += 2 * MIN;
  a.playing(false, 'a');                  // saved with 120 s played
  clock.t += 3 * 3600 * 1000;             // Vault quit; started again much later
  const b = createSetLog({ db: () => mem, now: () => clock.t });
  const [s] = b.sets();
  assert.strictEqual(s.open, false);
  assert.strictEqual(s.endedAt, T0 + 2 * MIN);
  assert.strictEqual(b.setById(s.id).entries[0].played, 120);
});

test('what plays is written every so often, so a crash keeps it (not "skipped after 0:00")', () => {
  const { log, step, mem, clock } = rig();
  log.start({ id: 1, title: 'A', key: 'a', playing: true });
  const row = () => mem.prepare('SELECT played_s, seen_at, ended_at FROM stage_set_entries').get();
  step(FLUSH_MS - 1000);
  log.tick();
  assert.strictEqual(row().played_s, 0, 'not yet');
  step(1000);
  log.tick();
  assert.strictEqual(row().played_s, FLUSH_MS / 1000);
  step(FLUSH_MS);
  log.playing(true, 'a');                 // mpv's status reports write it too
  assert.strictEqual(row().played_s, 2 * FLUSH_MS / 1000);
  const seen = clock.t;
  step(10000);                            // then Vault dies: these 10 s are never written
  step(3600 * 1000);
  const after = createSetLog({ db: () => mem, now: () => clock.t });
  const [set] = after.sets();
  assert.strictEqual(set.open, false);
  assert.strictEqual(set.endedAt, seen, 'the set ends where the file was last written');
  const [e] = after.setById(set.id).entries;
  assert.strictEqual(e.played, 2 * FLUSH_MS / 1000);
  assert.strictEqual(e.skipped, false);
  assert.strictEqual(row().ended_at, seen);
  assert.strictEqual(R.chapters(after.setById(set.id).entries), '00:00 A', 'kept in the copies');
});

test('Basic: a page that goes quiet has stopped where it was last heard of; the idle rule then works', () => {
  const { log, step, newest } = rig();
  log.basic('start', { id: 3, title: 'B' });
  for (let i = 0; i < 3; i++) { step(20000); log.basic('beat'); }
  step(BASIC_STALE_MS - 1000);
  log.tick();
  assert.strictEqual(newest().entries[0].now, true, 'not yet');
  step(1000);
  log.tick();
  const [e] = newest().entries;
  assert.strictEqual(e.now, false);
  assert.strictEqual(e.played, 60, 'played until the last beat, not until now');
  step(IDLE_MS);
  log.tick();
  assert.strictEqual(log.sets()[0].open, false, '30 minutes after it went quiet, the set has ended');
  assert.strictEqual(log.sets()[0].endedAt, T0 + 60000);
});

test('Basic: a paused page that keeps beating stays one entry; play after a quiet spell is a new entry', () => {
  const { log, step, newest } = rig();
  log.basic('start', { id: 3, title: 'B' });
  step(40000);
  log.basic('paused');
  for (let i = 0; i < 6; i++) { step(20000); log.basic('beat'); log.tick(); }
  log.basic('playing');
  step(10000);
  let es = newest().entries;
  assert.strictEqual(es.length, 1);
  assert.strictEqual(es[0].played, 50);
  // asleep (a frozen tab), then plays on: the old entry ended, a new one for the same file
  step(BASIC_STALE_MS + 1000);
  log.tick();
  log.basic('playing');
  es = newest().entries;
  assert.deepStrictEqual(es.map(x => [x.mediaId, x.now]), [[3, true], [3, false]]);
});

test('Basic: replaying after it ended is a new entry', () => {
  const { log, step, newest } = rig();
  log.basic('start', { id: 3, title: 'B' });
  step(40000);
  log.basic('stopped');
  log.basic('start', { id: 3, title: 'B' });
  step(5000);
  assert.deepStrictEqual(newest().entries.map(x => [x.mediaId, x.now, x.played]), [[3, true, 5], [3, false, 40]]);
});

test('Basic reports never change what mpv Stage is playing', () => {
  const { log, step, newest } = rig();
  log.start({ id: 5, title: 'mpv file', key: 'k1', playing: true });
  step(10000);
  log.basic('paused');
  log.basic('stopped');
  log.basic('closed');
  log.basic('start', { id: 9, title: 'page' });
  step(10000);
  const { set, entries } = newest();
  assert.strictEqual(set.open, true);
  assert.deepStrictEqual(entries.map(x => [x.mediaId, x.now, x.played]), [[5, true, 20]]);
});

test('paused shows as paused, not playing', () => {
  const { log, step, newest } = rig();
  log.start({ id: 5, title: 'A', key: 'k1', playing: true });
  step(5000);
  log.playing(false, 'k1');
  const [e] = newest().entries;
  assert.deepStrictEqual([e.now, e.paused, R.right(e)], [true, true, 'Paused']);
});

test('while locked, writes wait and are done in order after the unlock', () => {
  const locked = { on: false };
  const { log, step, mem } = rig({ locked });
  log.start({ id: 1, title: 'A', key: 'a', playing: true });
  step(40000);
  locked.on = true;                      // Vault locks: Stage paused, then closed while locked
  log.playing(false, 'a');
  step(5000);
  log.close();
  step(60000);                           // a new set started and closed while still locked
  log.start({ id: 2, title: 'B', key: 'b', playing: true });
  step(45000);
  log.close();
  assert.strictEqual(mem.prepare('SELECT COUNT(*) n FROM stage_sets').get().n, 1, 'nothing written while locked');
  assert.strictEqual(mem.prepare('SELECT ended_at FROM stage_sets').get().ended_at, null);
  assert.ok(log._pending() > 0);
  locked.on = false;
  log.flush();
  const sets = mem.prepare('SELECT started_at, ended_at FROM stage_sets ORDER BY id').all();
  assert.deepStrictEqual(sets.map(x => ({ ...x })), [
    { started_at: T0, ended_at: T0 + 45000 },
    { started_at: T0 + 105000, ended_at: T0 + 150000 },
  ]);
  const ents = mem.prepare('SELECT media_id, played_s, ended_at FROM stage_set_entries ORDER BY id').all();
  assert.deepStrictEqual(ents.map(x => ({ ...x })), [
    { media_id: 1, played_s: 40, ended_at: T0 + 45000 },
    { media_id: 2, played_s: 45, ended_at: T0 + 150000 },
  ]);
  assert.strictEqual(log._pending(), 0);
});

test('an older table gets the seen_at column', () => {
  const mem = new Database(':memory:');
  mem.exec("CREATE TABLE stage_set_entries (id INTEGER PRIMARY KEY, set_id INTEGER NOT NULL, media_id INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, played_s REAL NOT NULL DEFAULT 0, ended_at INTEGER)");
  ensureSchema(mem);
  ensureSchema(mem);
  assert.ok(mem.prepare('PRAGMA table_info(stage_set_entries)').all().some(c => c.name === 'seen_at'));
});

/* ── Basic Stage's page tells the server (player-lib/stage-control.js) ──── */

function basicPage() {
  const ROOT = path.join(__dirname, '..');
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const docListeners = {};
  const winListeners = {};
  const posts = [];
  const intervals = [];
  class FakeVideo extends EventTarget {
    constructor() {
      super();
      Object.assign(this, { tagName: 'VIDEO', readyState: 4, paused: false, muted: false, currentTime: 0, currentSrc: 'http://127.0.0.1/media/41', isConnected: true, ended: false });
    }
    requestPictureInPicture() { return Promise.resolve(); }
    pause() { this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    closest() { return null; }
  }
  const video = new FakeVideo();
  const mini = { classList: { add() {}, remove() {}, contains: () => false } };
  const classes = new Set();
  const doc = {
    body: { classList: { contains: (c) => classes.has(c), add: (...c) => c.forEach(x => classes.add(x)), remove: (...c) => c.forEach(x => classes.delete(x)), toggle() {} } },
    pictureInPictureEnabled: true,
    pictureInPictureElement: null,
    exitPictureInPicture: () => Promise.resolve(),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener: () => {},
    getElementById: (id) => (id === 'miniPlayer' ? mini : id === 'miniPlayerMedia' ? { innerHTML: '' } : null),
    querySelector: (q) => (q === '#miniPlayerMedia video' ? video : null),
    querySelectorAll: () => [],
    createElement: () => ({ addEventListener() {}, setAttribute() {}, querySelector: () => null, hidden: true, style: {} }),
  };
  const ctx = {
    document: doc,
    window: { addEventListener: (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); } },
    console: { ...console, warn() {} },
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    Promise, JSON, Math, Date, Error, TypeError, Event, EventTarget, Map, Set,
    MutationObserver: class { observe() {} },
    HTMLMediaElement: FakeVideo,
    EventSource: class { addEventListener() {} close() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    requestAnimationFrame: (fn) => fn(),
    showToast() {},
    currentMediaState: { type: 'video', miniMode: true, currentMediaData: { id: 41, filename: 'a.mp4', media_type: 'video' } },
    Library: { fetchRows: async () => [], known: () => true, length: () => 0, waitIds: async () => [], rowsForRange: async () => [] },
    noteFileOpened() {},
    queueNav: (fn) => fn(),
    miniPlayerOpen() {},
    playMedia() {},
    minimizePlayer() {},
    closeMiniPlayer() {},
    fetch: async (url, o) => {
      if (url === '/api/stage/setlog/basic') posts.push({ ...JSON.parse(o.body), bg: !!(o.headers && o.headers['X-Vault-Background']), keepalive: !!o.keepalive });
      const data = url === '/api/stage/state' ? { open: false, mpv: { found: false, choice: 'basic' }, settings: { tips: false } } : { ok: true };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('player-lib/stage-rules.js') + '\n' + read('player-lib/stage-control.js') + '\nglobalThis.__sc = StageControl;', ctx);
  const fire = (type) => { for (const fn of docListeners[type] || []) fn({ target: video, type }); };
  return { SC: ctx.__sc, video, fire, posts, intervals, winListeners };
}

test('Basic page: a new file starts an entry; playing it again after it ended is a new one too', async () => {
  const p = basicPage();
  await p.SC.openStage();
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(p.SC.basicOn(), true);
  p.posts.length = 0;
  p.fire('loadstart');
  p.fire('playing');
  p.video.paused = true; p.fire('pause');
  p.video.paused = false; p.fire('playing');
  p.video.ended = true; p.video.paused = true; p.fire('pause'); p.fire('ended');
  p.video.ended = false; p.video.paused = false; p.fire('playing');      // replay: same video, same file, no loadstart
  assert.deepStrictEqual(p.posts.map(x => x.state + (x.id ? ' ' + x.id : '')), ['start 41', 'paused', 'playing', 'stopped', 'start 41']);
});

test('Basic page: it beats in the background (never holding off auto-lock), and says stopped as the page goes', async () => {
  const p = basicPage();
  await p.SC.openStage();
  await new Promise(r => setTimeout(r, 20));
  p.posts.length = 0;
  const beat = p.intervals.find(i => i.ms === 20000);
  assert.ok(beat, 'a 20 s beat');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 60000;
    beat.fn();
    p.fire('timeupdate');                // just beat: not again
  } finally { Date.now = realNow; }
  for (const fn of p.winListeners.pagehide || []) fn({});
  assert.deepStrictEqual(p.posts.map(x => [x.state, x.bg, x.keepalive]), [['beat', true, false], ['stopped', true, true]]);
});

/* ── The hub tells it what mpv Stage plays ──────────────────────────────── */

test('hub: started, status, finished and Close reach the set log', () => {
  const calls = [];
  const fakeLog = new Proxy({}, { get: (_, k) => (...a) => calls.push([k, ...a]) });
  const hub = createHub({ stage: { alive: () => true, command() {}, close() {} }, settings: { get: () => ({}) }, heartbeatMs: 0, log: fakeLog });
  hub.opened('mpv');
  const item = { key: 'k1', id: 5, media_type: 'video', filename: 'Night Drive.mp4' };
  hub.command({ type: 'load', item });
  hub.report({ type: 'started', key: 'k1' });
  hub.report({ type: 'status', key: 'k1', state: 'playing', t: 1, d: 10 });
  hub.report({ type: 'status', key: 'k1', state: 'paused', t: 2, d: 10, paused: true });
  hub.report({ type: 'status', key: 'k1', state: 'playing', t: 2, d: 10, hold: true, paused: true });
  hub.report({ type: 'finished' });
  hub.command({ type: 'close', stop: true });
  hub.stageExited({ byUser: true });
  assert.deepStrictEqual(calls, [
    ['start', { id: 5, title: 'Night Drive.mp4', key: 'k1' }],
    ['playing', true, 'k1'],
    ['playing', false, 'k1'],
    ['playing', false, 'k1'],
    ['stop'],
    ['close'],
  ]);
});

test('hub: mpv gone by itself stops the file but leaves the set open', () => {
  const calls = [];
  const hub = createHub({ stage: { alive: () => true }, settings: { get: () => ({}) }, heartbeatMs: 0, log: { stop: () => calls.push('stop'), close: () => calls.push('close') } });
  hub.opened('mpv');
  hub.stageExited({ byUser: false });
  assert.deepStrictEqual(calls, ['stop']);
});

test('hub: a set log that throws never breaks Stage', () => {
  const hub = createHub({ stage: { alive: () => true }, settings: { get: () => ({}) }, heartbeatMs: 0, log: { start() { throw new Error('x'); } } });
  hub.opened('mpv');
  hub.command({ type: 'load', item: { key: 'k1', id: 5, media_type: 'video', filename: 'a' } });
  assert.strictEqual(hub.report({ type: 'started', key: 'k1' }).status, 200);
});

/* ── SetLogRules: the times and the copies ──────────────────────────────── */

test('times: offsets h:mm:ss, lengths m:ss, clock times', () => {
  assert.strictEqual(R.hms(0), '0:00:00');
  assert.strictEqual(R.hms(723), '0:12:03');
  assert.strictEqual(R.hms(4744), '1:19:04');
  assert.strictEqual(R.dur(238), '3:58');
  assert.strictEqual(R.dur(28.7), '0:28');
  assert.strictEqual(R.dur(3730), '1:02:10');
  assert.strictEqual(R.clock(T0), '8:02 PM');
  assert.strictEqual(R.clock(new Date(2026, 9, 27, 0, 5).getTime()), '12:05 AM');
  assert.strictEqual(R.clock(new Date(2026, 9, 27, 12, 0).getTime()), '12:00 PM');
});

test('the right side: length played, Playing now, skipped after', () => {
  assert.strictEqual(R.right({ played: 238 }), '3:58');
  assert.strictEqual(R.right({ played: 10, now: true }), 'Playing now');
  assert.strictEqual(R.right({ played: 10, now: true, paused: true }), 'Paused');
  assert.strictEqual(R.right({ played: 28, skipped: true }), 'skipped after 0:28');
});

test('the header: Tonight for this evening, a plain date for older sets', () => {
  const later = T0 + 90 * MIN;
  assert.strictEqual(R.header({ startedAt: T0, played: 14, open: true }, later), 'Tonight · started 8:02 PM · 14 played');
  const morning = new Date(2026, 9, 27, 10, 0).getTime();
  assert.strictEqual(R.header({ startedAt: morning, played: 3 }, later), 'Today · started 10:00 AM · 3 played');
  const days = new Date(2026, 9, 31, 12, 0).getTime();
  assert.strictEqual(R.header({ startedAt: T0, played: 2 }, days), 'Tue Oct 27 · started 8:02 PM · 2 played');
  // Past midnight, the set still going: still tonight's.
  const pastMidnight = new Date(2026, 9, 28, 1, 0).getTime();
  assert.strictEqual(R.day(T0, pastMidnight), 'Tonight', '8 PM seen at 1 AM');
  const elevenPm = new Date(2026, 9, 27, 23, 0).getTime();
  assert.strictEqual(R.day(elevenPm, pastMidnight), 'Tonight', '11 PM to 12:30 AM, seen at 1 AM');
  const twoAm = new Date(2026, 9, 28, 2, 0).getTime();
  const threePm = new Date(2026, 9, 28, 15, 0).getTime();
  assert.strictEqual(R.day(twoAm, threePm), 'Last night', 'a 2 AM set seen at 3 PM');
  assert.strictEqual(R.day(T0, threePm), 'Last night', 'yesterday evening, seen the next afternoon');
  assert.strictEqual(R.day(T0, new Date(2026, 9, 28, 21, 0).getTime()), 'Last night', 'yesterday evening, seen this evening');
  assert.strictEqual(R.day(T0, new Date(2026, 9, 29, 21, 0).getTime()), 'Tue Oct 27');
  assert.strictEqual(R.day(morning, new Date(2026, 9, 27, 13, 0).getTime()), 'Today');
  assert.strictEqual(R.day(new Date(2025, 0, 2, 20).getTime(), later), 'Thu Jan 2 2025');
  assert.strictEqual(R.setLabel({ startedAt: T0, duration: 9660 }, days), 'Tue Oct 27 · 2h 41m');
  assert.strictEqual(R.setLabel({ startedAt: T0, duration: 9660, open: true }, later), 'Tonight 8:02 PM · now playing');
});

const ENTRIES = [
  // newest first, as the server sends them
  { title: 'Overpass', offset: 4744, startedAt: T0 + 4744e3, played: 30, now: true },
  { title: 'Harbor', offset: 4488, startedAt: T0 + 4488e3, played: 238 },
  { title: 'Static Bloom', offset: 4460, startedAt: T0 + 4460e3, played: 28, skipped: true },
  { title: 'Night Drive', offset: 723, startedAt: T0 + 723e3, played: 246 },
  { title: 'Opening Glow', offset: 0, startedAt: T0, played: 204 },
];

test('Copy as chapters: from the set start, oldest first, skipped left out, h:mm:ss past an hour', () => {
  assert.strictEqual(R.chapters(ENTRIES), [
    '00:00 Opening Glow',
    '12:03 Night Drive',
    '1:14:48 Harbor',
    '1:19:04 Overpass',
  ].join('\n'));
});

test('Copy as chapters: the first line is 00:00 even when the first file was skipped', () => {
  const list = [
    { title: 'Second', offset: 45, startedAt: T0 + 45e3, played: 200 },
    { title: 'First', offset: 0, startedAt: T0, played: 3, skipped: true },
  ];
  assert.strictEqual(R.chapters(list), '00:00 Second');
  assert.strictEqual(R.chapters([]), '');
});

test('Copy list: clock times, oldest first, skipped left out', () => {
  assert.strictEqual(R.list(ENTRIES), [
    '8:02 PM  Opening Glow',
    '8:14 PM  Night Drive',
    '9:16 PM  Harbor',
    '9:21 PM  Overpass',
  ].join('\n'));
});

test('search: every word, any case', () => {
  assert.deepStrictEqual(R.filter(ENTRIES, 'night').map(e => e.title), ['Night Drive']);
  assert.deepStrictEqual(R.filter(ENTRIES, 'DRIVE night').map(e => e.title), ['Night Drive']);
  assert.strictEqual(R.filter(ENTRIES, '  ').length, ENTRIES.length);
  assert.strictEqual(R.filter(ENTRIES, 'nothing like it').length, 0);
});

test('no em dashes in what the set log says', () => {
  for (const f of ['player-lib/stage-setlog.js', 'lib/stage/setlog.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!text.includes('\u2014'), `${f} has an em dash`);
  }
});

/* ── The routes, on the real app ────────────────────────────────────────── */

const db = require('../lib/database');
const { app } = require('../server/index');
let server;
let base;

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const getJson = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

test('routes: Basic Stage reports a set; it reads back with library names and gone files marked', async () => {
  const d = db.get();
  const add = (fp, name) => Number(d.prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)').run(fp, name, 'video').lastInsertRowid);
  const a = add('C:/clips/night drive.mp4', 'night drive.mp4');
  const b = add('C:/clips/harbor.mp4', 'harbor.mp4');

  assert.deepStrictEqual((await getJson('/api/stage/setlog')).body, { sets: [] });
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start', id: a, title: 'page name.mp4' })).status, 200);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'paused' })).status, 200);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'playing' })).status, 200);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start', id: b })).status, 200);
  d.prepare('DELETE FROM media WHERE id = ?').run(b);     // removed from the library since

  const { sets } = (await getJson('/api/stage/setlog')).body;
  assert.strictEqual(sets.length, 1);
  assert.strictEqual(sets[0].open, true);
  const one = await getJson(`/api/stage/setlog/${sets[0].id}`);
  assert.strictEqual(one.status, 200);
  assert.deepStrictEqual(one.body.entries.map(e => [e.title, e.inLibrary, e.now]), [
    ['harbor.mp4', false, true],
    ['night drive.mp4', true, false],
  ]);

  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'closed' })).status, 200);
  const after = (await getJson('/api/stage/setlog')).body.sets;
  assert.strictEqual(after[0].open, false);
});

test('routes: bad input is refused', async () => {
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'dance' })).status, 400);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start' })).status, 400);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start', id: 1, title: 5 })).status, 400);
  assert.strictEqual((await getJson('/api/stage/setlog/abc')).status, 400);
  assert.strictEqual((await getJson('/api/stage/setlog/99999')).status, 404);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start', id: 1e300 })).status, 400, 'not a safe integer');
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start', id: 2 ** 53 })).status, 400);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start', id: 987654 })).status, 404, 'not in the library');
});

test('routes: the open log\'s poll does not count as the user being there (auto-lock still comes)', async () => {
  const vault = require('../lib/vault');
  vault._lastActivity = 0;
  const r = await fetch(base + '/api/stage/setlog', { headers: { 'X-Vault-Background': '1' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(vault._lastActivity, 0);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'stage-setlog.js'), 'utf8');
  assert.match(src, /'X-Vault-Background': '1'/, 'the popover sends it');
  vault.touch();
});

test('routes: a page title is not used; the library name is', async () => {
  const d = db.get();
  const id = Number(d.prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)').run('C:/clips/real.mp4', 'real.mp4', 'video').lastInsertRowid);
  assert.strictEqual((await post('/api/stage/setlog/basic', { state: 'start', id, title: 'made up by a page' })).status, 200);
  const { sets } = (await getJson('/api/stage/setlog')).body;
  const one = (await getJson('/api/stage/setlog/' + sets[0].id)).body;
  assert.strictEqual(one.entries[0].title, 'real.mp4');
  await post('/api/stage/setlog/basic', { state: 'closed' });
});

test('hidden file names: the set log blurs its names and its rows carry no name in a tooltip', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'stage-remote.css'), 'utf8');
  assert.match(css, /body\.pm-names \.slog-nm\s*\{[^}]*filter:\s*blur/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'stage-setlog.js'), 'utf8');
  assert.ok(!/title="Preview \$\{/.test(src), 'no file name in the row tooltip');
});
