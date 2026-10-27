/**
 * Flow over HTTP against the real app (server/flow-routes.js,
 * lib/flow/service.js, lib/flow/store.js): Flow order for a collection from
 * stored measurements, the counts, Save as playlist order and Undo through
 * the existing order route, the lock gate (423) and the CSRF guard, bad
 * input; Settings › Stage's new keys; and Even out loudness reaching mpv as a
 * per-file option (a fake mpv: nothing is started, nothing plays).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-flow-routes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const store = require('../lib/flow/store');
const stageSettings = require('../lib/stage/settings');
const { createEngine } = require('../lib/stage/engine');
const { volumeGainSupported } = require('../lib/stage/mpv-host');
const { app } = require('../server/index');

let server, base, coll;
const ids = [];

test.before(async () => {
  db.init();
  const d = db.get();
  const ins = d.prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds, filesize_bytes, file_mtime_ms) VALUES (?, ?, ?, 60, 1000, 5)");
  for (let i = 0; i < 6; i++) ids.push(Number(ins.run(path.join(tmp, `f${i}.mp4`), `f${i}.mp4`, i === 5 ? 'image' : 'video').lastInsertRowid));
  coll = db.createCollection('Friday stream').id;
  db.addToCollection(coll, ids);
  // Energies 0.9, 0.1, 0.5, 0.3, (talk 0.4), picture: Build up is 1, 3, 2, 0 by energy
  const src = store.srcOf({ filesize_bytes: 1000, file_mtime_ms: 5 });
  const f = (e, bpm, music = 1) => ({ lufs: -20, peak_db: -6, has_music: music, e_start: e, e_mid: e, e_end: e, bpm_start: bpm, bpm_mid: bpm, bpm_end: bpm, bpm_conf: music ? 0.9 : 0.1 });
  store.save(d, ids[0], src, f(0.9, 140));
  store.save(d, ids[1], src, f(0.1, 90));
  store.save(d, ids[2], src, f(0.5, 120));
  store.save(d, ids[3], src, f(0.3, 100));
  store.save(d, ids[4], src, f(0.4, null, 0));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  vault._locked = false;
  require('../lib/flow/service').cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const get = (p, h = {}) => fetch(base + p, { headers: h });
const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body || {}) });

test('the schema: media_flow exists and a deleted record takes its row with it', () => {
  const d = db.get();
  const id = Number(d.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'gone.mp4', 'video')").run(path.join(tmp, 'gone.mp4')).lastInsertRowid);
  store.save(d, id, 'x', { lufs: -10 });
  assert.ok(d.prepare('SELECT 1 FROM media_flow WHERE media_id = ?').get(id));
  db.deleteRecords([id]);
  assert.strictEqual(d.prepare('SELECT 1 FROM media_flow WHERE media_id = ?').get(id), undefined);
});

test('a changed file counts as not measured (size or time differ)', () => {
  const d = db.get();
  assert.strictEqual(store.currentFor(d, [ids[0]]).size, 1);
  d.prepare('UPDATE media SET file_mtime_ms = 6 WHERE id = ?').run(ids[0]);
  assert.strictEqual(store.currentFor(d, [ids[0]]).size, 0);
  d.prepare('UPDATE media SET file_mtime_ms = 5 WHERE id = ?').run(ids[0]);
});

test('GET /api/flow/collections/:id: Build up orders by energy, talk placed by shape, the picture too', async () => {
  const r = await get(`/api/flow/collections/${coll}?shape=build`);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.shape, 'build');
  assert.strictEqual(j.order.length, 6);
  const music = j.order.filter(id => [ids[0], ids[1], ids[2], ids[3]].includes(id));
  assert.deepStrictEqual(music, [ids[1], ids[3], ids[2], ids[0]]);
  assert.deepStrictEqual(j.playlistOrder, ids);
  assert.strictEqual(j.targets.length, 6);
  assert.strictEqual(j.handovers.length, 5);
  assert.deepStrictEqual(j.counts, { total: 6, measurable: 5, measured: 5, music: 4, noMusic: 1, failed: 0, left: 0, stale: 0, kept: 0, max: 5000, tooMany: false });
  const pic = j.features.find(f => f.id === ids[5]);
  assert.strictEqual(pic.kind, 'other');
});

test('GET with a fixed first file, and bad input', async () => {
  const j = await (await get(`/api/flow/collections/${coll}?shape=smooth&first=${ids[0]}`)).json();
  assert.strictEqual(j.order[0], ids[0]);
  assert.strictEqual((await get(`/api/flow/collections/${coll}?shape=wobbly`)).status, 400);
  assert.strictEqual((await get(`/api/flow/collections/${coll}?first=abc`)).status, 400);
  assert.strictEqual((await get('/api/flow/collections/0')).status, 400);
  assert.strictEqual((await get('/api/flow/collections/99999')).status, 404);
  assert.strictEqual((await get('/api/flow/status?collection=x')).status, 400);
});

test('GET /api/flow/media/:id: the Stage bar line', async () => {
  const j = await (await get(`/api/flow/media/${ids[0]}`)).json();
  assert.strictEqual(j.text, '140 BPM · energy high');
  assert.strictEqual((await (await get(`/api/flow/media/${ids[4]}`)).json()).text, 'no music');
  assert.strictEqual((await get('/api/flow/media/99999')).status, 404);
});

test("the chart's data: each file's name, and its envelope (2 decimals) when it has one", async () => {
  const d = db.get();
  d.prepare('UPDATE media_flow SET env = ? WHERE media_id = ?').run('[[0.05,0.8123],[0.5,0.9],[0.95,0.886]]', ids[0]);
  // A shape not asked for yet (the order cache knows nothing of a direct write).
  const j = await (await get(`/api/flow/collections/${coll}?shape=steady`)).json();
  const f0 = j.features.find(f => f.id === ids[0]);
  assert.deepStrictEqual(f0.env, [[0.05, 0.81], [0.5, 0.9], [0.95, 0.89]]);
  assert.strictEqual(f0.name, 'f0.mp4');
  const f1 = j.features.find(f => f.id === ids[1]);
  assert.ok(!('env' in f1), 'no envelope: the chart draws start, middle and end');
  assert.strictEqual(j.features.find(f => f.id === ids[5]).name, 'f5.mp4');
  assert.ok(!('title' in f0), 'no song linked: no title');
  d.prepare('UPDATE media_flow SET env = NULL WHERE media_id = ?').run(ids[0]);
});

test("the chart's names: the library's title when one song is linked to the file, none for a mix", async () => {
  const music = require('../lib/musicid/repo');
  const a = music.findOrCreateSong({ title: 'Glass Hours', artist: 'Neon Harbor' });
  const b = music.findOrCreateSong({ title: 'Low Orbit', artist: '' });
  music.linkSongToMedia({ media_id: ids[1], song_id: a });
  music.linkSongToMedia({ media_id: ids[2], song_id: b });
  music.linkSongToMedia({ media_id: ids[3], song_id: a });
  music.linkSongToMedia({ media_id: ids[3], song_id: b });
  // Music ID's placeholder for a song it grouped by sound alone is not a title.
  const c = music.findOrCreateSong({ title: 'Unknown Song 1', artist: 'Unknown', source: 'auto-cluster' });
  music.linkSongToMedia({ media_id: ids[0], song_id: c });
  const j = await (await get(`/api/flow/collections/${coll}?shape=build&first=${ids[1]}`)).json();
  const by = new Map(j.features.map(f => [f.id, f]));
  assert.strictEqual(by.get(ids[1]).title, 'Glass Hours by Neon Harbor');
  assert.strictEqual(by.get(ids[2]).title, 'Low Orbit');
  assert.ok(!('title' in by.get(ids[3])), 'two songs: no one title');
  assert.strictEqual(by.get(ids[3]).name, 'f3.mp4');
  assert.ok(!('title' in by.get(ids[0])), 'a placeholder: the file name instead');
  db.get().prepare('DELETE FROM media_songs WHERE media_id IN (?, ?, ?, ?)').run(ids[0], ids[1], ids[2], ids[3]);
});

/** Wait until the measuring queue has nothing left. */
async function queueIdle() {
  const t0 = Date.now();
  for (;;) {
    const s = await (await get('/api/flow/status')).json();
    if (s.queue.state === 'idle' && !s.queue.current && !s.queue.pending) return;
    if (Date.now() - t0 > 5000) throw new Error('the queue never went idle');
    await new Promise(res => setTimeout(res, 50));
  }
}

test('a row from the previous method (no envelope) is used meanwhile, counted stale, and measured again', async () => {
  const d = db.get();
  d.prepare('UPDATE media_flow SET version = 2 WHERE media_id = ?').run(ids[2]);
  await new Promise(res => setTimeout(res, 1100));             // the counts cache
  const j = await (await get(`/api/flow/collections/${coll}?shape=peak`)).json();
  assert.strictEqual(j.counts.measured, 5);
  assert.strictEqual(j.counts.stale, 1);
  assert.strictEqual(j.counts.left, 0);
  const f2 = j.features.find(f => f.id === ids[2]);
  assert.strictEqual(f2.measured, true);
  assert.strictEqual(f2.em, 0.5);
  const m = await (await post(`/api/flow/collections/${coll}/measure`)).json();
  assert.strictEqual(m.added, 1, 'queued to be measured again');
  await queueIdle();

  // The file is not on disk (an unplugged drive): its older numbers are kept, no error row.
  const kept = () => d.prepare('SELECT version, error, e_start, e_mid, e_end, bpm_mid FROM media_flow WHERE media_id = ?').get(ids[2]);
  assert.deepStrictEqual(kept(), { version: 2, error: null, e_start: 0.5, e_mid: 0.5, e_end: 0.5, bpm_mid: 120 });
  assert.strictEqual(store.get(d, ids[2]).stale, 1);
  await new Promise(res => setTimeout(res, 1100));
  const s = await (await get(`/api/flow/status?collection=${coll}`)).json();
  assert.strictEqual(s.collection.failed, 0);
  // Kept its older numbers: counted as kept, not as stale still to do (no "adding detail" for it).
  assert.strictEqual(s.collection.stale, 0);
  assert.strictEqual(s.collection.kept, 1);
  assert.strictEqual(s.collection.measured, 5);
  // Not asked again on the next open (no loop) ...
  assert.strictEqual((await (await post(`/api/flow/collections/${coll}/measure`)).json()).added, 0);
  // ... but Try again asks once more, and a second failure still keeps the numbers.
  assert.strictEqual((await (await post(`/api/flow/collections/${coll}/measure`, { retry: true })).json()).added, 1);
  await queueIdle();
  assert.deepStrictEqual(kept(), { version: 2, error: null, e_start: 0.5, e_mid: 0.5, e_end: 0.5, bpm_mid: 120 });
  assert.strictEqual((await (await post(`/api/flow/collections/${coll}/measure`)).json()).added, 0);
  // Back to the current method for the tests after (the same numbers).
  d.prepare('UPDATE media_flow SET version = ? WHERE media_id = ?').run(require('../lib/flow/analyze').VERSION, ids[2]);
});

test('measure: queues only what is not measured; status counts it', async () => {
  const d = db.get();
  d.prepare('DELETE FROM media_flow WHERE media_id = ?').run(ids[3]);
  const r = await post(`/api/flow/collections/${coll}/measure`);
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.added, 1);
  // The file is not on disk: it ends up "couldn't be measured", with the reason kept.
  const t0 = Date.now();
  let s;
  do {
    await new Promise(res => setTimeout(res, 50));
    s = await (await get(`/api/flow/status?collection=${coll}`)).json();
  } while (s.collection.failed === 0 && Date.now() - t0 < 5000);
  assert.strictEqual(s.collection.failed, 1);
  assert.match(store.get(d, ids[3]).error, /not where the library says/);
  assert.strictEqual(store.get(d, ids[3]).error_code, 'MISSING');
  // Try again queues it once more (and the file that kept its numbers in the test before).
  const again = await (await post(`/api/flow/collections/${coll}/measure`, { retry: true })).json();
  assert.strictEqual(again.added, 2);
  // Put the row back for the tests after.
  await new Promise(res => setTimeout(res, 300));
  store.save(d, ids[3], store.srcOf({ filesize_bytes: 1000, file_mtime_ms: 5 }), { lufs: -20, has_music: 1, e_start: 0.3, e_mid: 0.3, e_end: 0.3, bpm_start: 100, bpm_mid: 100, bpm_end: 100 });
});

test('Save as playlist order and Undo go through POST /api/collections/:id/order', async () => {
  const j = await (await get(`/api/flow/collections/${coll}?shape=build`)).json();
  let r = await post(`/api/collections/${coll}/order`, { order: j.order });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(db.getCollectionItems(coll), j.order);
  const after = await (await get(`/api/flow/collections/${coll}?shape=build`)).json();
  assert.deepStrictEqual(after.playlistOrder, j.order);
  r = await post(`/api/collections/${coll}/order`, { order: j.playlistOrder });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(db.getCollectionItems(coll), ids);
});

test('pause / resume / cancel answer the queue', async () => {
  let s = await (await post('/api/flow/pause')).json();
  assert.strictEqual(s.queue.paused, true);
  s = await (await post('/api/flow/resume')).json();
  assert.strictEqual(s.queue.paused, false);
  s = await (await post('/api/flow/cancel')).json();
  assert.strictEqual(s.queue.pending, 0);
});

test('locked: every Flow route answers 423', async () => {
  vault.bootLocked();
  try {
    for (const p of [`/api/flow/collections/${coll}`, '/api/flow/status', `/api/flow/media/${ids[0]}`]) {
      assert.strictEqual((await get(p)).status, 423, p);
    }
    for (const p of [`/api/flow/collections/${coll}/measure`, '/api/flow/pause', '/api/flow/resume', '/api/flow/cancel']) {
      assert.strictEqual((await post(p)).status, 423, p);
    }
    assert.strictEqual(require('../lib/flow/service').gainFor(ids[0]), null, 'no gain read while locked');
  } finally { vault._locked = false; }
});

test('CSRF: a cross-origin POST is refused', async () => {
  const r = await post(`/api/flow/collections/${coll}/measure`, {}, { Origin: 'https://evil.example' });
  assert.strictEqual(r.status, 403);
  const r2 = await post('/api/flow/pause', {}, { Origin: 'https://evil.example' });
  assert.strictEqual(r2.status, 403);
});

test('Settings › Stage: Even out loudness on, Measure for Flow, Flow shuffle off by default; bad values refused', async () => {
  assert.strictEqual(stageSettings.DEFAULTS.evenLoudness, true);
  assert.strictEqual(stageSettings.DEFAULTS.flowMeasure, 'use');
  assert.strictEqual(stageSettings.DEFAULTS.flowShuffle, false);
  let r = await post('/api/stage/settings', { flowMeasure: 'new', flowShuffle: true, evenLoudness: false });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.deepStrictEqual([j.flowMeasure, j.flowShuffle, j.evenLoudness], ['new', true, false]);
  assert.strictEqual((await post('/api/stage/settings', { flowMeasure: 'sometimes' })).status, 400);
  assert.strictEqual((await post('/api/stage/settings', { flowShuffle: 'yes' })).status, 400);
  assert.strictEqual((await (await get('/api/flow/status')).json()).mode, 'new');
  await post('/api/stage/settings', { flowMeasure: 'use', flowShuffle: false, evenLoudness: true });
});

/* ── Even out loudness reaching mpv (a fake mpv) ─────────────────────── */

function fakeMpv() {
  let entry = 0;
  const m = {
    log: [], props: {},
    alive: () => true,
    async set(name, value) { m.log.push(['set', name, value]); m.props[name] = value; return null; },
    async get(name) { return m.props[name]; },
    async command() { return null; },
    async loadfile(file, mode, opts) { entry++; m.log.push(['loadfile', file, mode, opts]); return { playlist_entry_id: entry }; },
  };
  return m;
}

function engineWith({ gain, volumeGain = true, settings = {} }) {
  const mpv = fakeMpv();
  const engine = createEngine({
    mpv, volumeGain,
    settings: () => ({ showName: false, ...settings }),
    lib: {
      pathFor: (id) => ({ ok: true, path: `D:\\m\\${id}.mp4` }),
      isLocked: () => false,
      loudnessGain: gain,
    },
  });
  engine.started({ volume: 1 });
  return { mpv, engine };
}
const item = (id, type = 'video') => ({ key: `k${id}`, id, media_type: type, filename: `${id}.mp4`, duration: 30, startAt: 0, via: 'list', index: 0 });
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)); };

test('Stage: a measured file plays with its gain (volume-gain), the next one too; unmeasured ones with none', async () => {
  const e = engineWith({ gain: (id) => ({ 1: -4.2, 2: 6 }[id] ?? null) });
  e.engine.command({ type: 'load', item: item(1), upcoming: [item(2)], repeat: 'off', paused: false });
  await settle();
  const loads = e.mpv.log.filter(l => l[0] === 'loadfile');
  assert.strictEqual(loads[0][3]['volume-gain'], '-4.2');
  assert.strictEqual(loads[1][3]['volume-gain'], '6.0');
  e.engine.command({ type: 'load', item: item(3), upcoming: [], repeat: 'off', paused: false });
  await settle();
  assert.strictEqual(e.mpv.log.filter(l => l[0] === 'loadfile').pop()[3]['volume-gain'], undefined);
  e.engine.closingNow();
});

test('Stage: an older mpv gets a volume filter; off in Settings means no gain; pictures never', async () => {
  const old = engineWith({ gain: () => -3, volumeGain: false });
  old.engine.command({ type: 'load', item: item(1), upcoming: [], repeat: 'off', paused: false });
  await settle();
  assert.strictEqual(old.mpv.log.find(l => l[0] === 'loadfile')[3].af, 'lavfi=[volume=-3.0dB]');
  old.engine.closingNow();
  const off = engineWith({ gain: () => -3, settings: { evenLoudness: false } });
  off.engine.command({ type: 'load', item: item(1), upcoming: [], repeat: 'off', paused: false });
  await settle();
  assert.deepStrictEqual(Object.keys(off.mpv.log.find(l => l[0] === 'loadfile')[3]).filter(k => k === 'volume-gain' || k === 'af'), []);
  off.engine.closingNow();
  const pic = engineWith({ gain: () => -3 });
  pic.engine.command({ type: 'load', item: item(1, 'image'), upcoming: [], repeat: 'off', paused: false });
  await settle();
  assert.strictEqual(pic.mpv.log.find(l => l[0] === 'loadfile')[3]['volume-gain'], undefined);
  pic.engine.closingNow();
  assert.strictEqual(volumeGainSupported('v0.41.0'), true);
  assert.strictEqual(volumeGainSupported('0.37.0'), false);
});

test('the library pass: a keyset walk on the primary key; changed and outdated files count again', () => {
  const d = db.get();
  const plan = d.prepare('EXPLAIN QUERY PLAN ' + store.SWEEP_SQL).all(0, 500).map(r => r.detail).join(' | ');
  assert.match(plan, /SEARCH m USING INTEGER PRIMARY KEY \(rowid>\?\)/);
  assert.match(plan, /SEARCH f USING INTEGER PRIMARY KEY \(rowid=\?\)/);
  assert.doesNotMatch(plan, /TEMP B-TREE|SCAN m/);
  // Everything measured: nothing to do; the cursor reaches the end.
  let r = store.sweepBatch(d, 0);
  assert.deepStrictEqual(r.ids, []);
  assert.strictEqual(r.done, true);
  // A changed file and an outdated row come back; pictures never.
  d.prepare('UPDATE media SET filesize_bytes = 2000 WHERE id = ?').run(ids[2]);
  d.prepare('UPDATE media_flow SET version = 0 WHERE media_id = ?').run(ids[1]);
  r = store.sweepBatch(d, 0);
  assert.deepStrictEqual(r.ids, [ids[1], ids[2]]);
  // Small steps: a limit of 2 rows a step, 2 rows a call.
  const step = store.sweepBatch(d, 0, { limit: 2, maxRows: 2 });
  assert.strictEqual(step.done, false);
  assert.strictEqual(step.cursor, ids[1]);
  d.prepare('UPDATE media SET filesize_bytes = 1000 WHERE id = ?').run(ids[2]);
  d.prepare('UPDATE media_flow SET version = ? WHERE media_id = ?').run(require('../lib/flow/analyze').VERSION, ids[1]);
});

test('a collection row whose file record is gone stays at the end, so Save is accepted', async () => {
  const d = db.get();
  d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)').run(coll, 987654, 99);
  try {
    const j = await (await get(`/api/flow/collections/${coll}?shape=build`)).json();
    assert.strictEqual(j.order[j.order.length - 1], 987654);
    assert.strictEqual(j.order.length, 7);
    const r = await post(`/api/collections/${coll}/order`, { order: j.order });
    assert.strictEqual(r.status, 200);
  } finally {
    d.prepare('DELETE FROM collection_items WHERE media_id = 987654').run();
    db.reorderCollection(coll, { order: ids });
  }
});

test('over 5,000 files: Flow says so, queues nothing, and works out no order', async () => {
  const d = db.get();
  const big = db.createCollection('Everything').id;
  const ins = d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)');
  d.transaction(() => { for (let i = 0; i < 5001; i++) ins.run(big, 1000000 + i, i); })();
  const s = await (await get(`/api/flow/status?collection=${big}`)).json();
  assert.strictEqual(s.collection.tooMany, true);
  assert.strictEqual(s.collection.total, 5001);
  const m = await (await post(`/api/flow/collections/${big}/measure`)).json();
  assert.strictEqual(m.added, 0);
  const o = await get(`/api/flow/collections/${big}`);
  assert.strictEqual(o.status, 413);
  assert.match((await o.json()).error, /up to 5,000 files/);
  // The counts are one query, cheap whatever the size.
  const t0 = process.hrtime.bigint();
  await get(`/api/flow/status?collection=${big}`);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200);
});

test('Flow order is worked out once per change, not on every ask', async () => {
  const a = await (await get(`/api/flow/collections/${coll}?shape=waves`)).json();
  const t0 = process.hrtime.bigint();
  const b = await (await get(`/api/flow/collections/${coll}?shape=waves`)).json();
  assert.deepStrictEqual(a.order, b.order);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100);
});

test('Stage: switching Even out loudness while a file plays is file-local; the lined-up file is put there again', async () => {
  let cfg = { evenLoudness: true };
  const mpv = fakeMpv();
  const e = createEngine({
    mpv, volumeGain: true, settings: () => ({ showName: false, ...cfg }),
    lib: { pathFor: (id) => ({ ok: true, path: `D:\m\${id}.mp4` }), isLocked: () => false, loudnessGain: (id) => ({ 1: -4.2, 2: 6 }[id] ?? null) },
  });
  e.started({ volume: 1 });
  e.command({ type: 'load', item: item(1), upcoming: [item(2)], repeat: 'off', paused: false });
  await settle();
  mpv.log.length = 0;
  cfg = { evenLoudness: false };
  e.settingsChanged(cfg);
  await settle();
  assert.deepStrictEqual(mpv.log.find(l => l[0] === 'set'), ['set', 'file-local-options/volume-gain', 0]);
  assert.ok(!mpv.log.some(l => l[0] === 'set' && l[1] === 'volume-gain'), 'never the global option');
  const re = mpv.log.filter(l => l[0] === 'loadfile');
  assert.strictEqual(re.length, 1, 'the next file appended again');
  assert.strictEqual(re[0][2], 'append');
  assert.strictEqual(re[0][3]['volume-gain'], undefined, 'without its gain now');
  mpv.log.length = 0;
  cfg = { evenLoudness: true };
  e.settingsChanged(cfg);
  await settle();
  assert.deepStrictEqual(mpv.log.find(l => l[0] === 'set'), ['set', 'file-local-options/volume-gain', -4.2]);
  assert.strictEqual(mpv.log.filter(l => l[0] === 'loadfile')[0][3]['volume-gain'], '6.0');
  // Saving another setting changes nothing here.
  mpv.log.length = 0;
  e.settingsChanged({ evenLoudness: true, windowName: 'X' });
  await settle();
  assert.ok(!mpv.log.some(l => l[0] === 'loadfile' || (l[0] === 'set' && /volume-gain/.test(l[1]))));
  e.closingNow();
  // An older mpv: the same through a file-local volume filter.
  let cfg2 = { evenLoudness: true };
  const old = fakeMpv();
  const e2 = createEngine({ mpv: old, volumeGain: false, settings: () => ({ showName: false, ...cfg2 }), lib: { pathFor: (id) => ({ ok: true, path: `D:\m\${id}.mp4` }), isLocked: () => false, loudnessGain: () => -3 } });
  e2.started({ volume: 1 });
  e2.command({ type: 'load', item: item(1), upcoming: [], repeat: 'off', paused: false });
  await settle();
  cfg2 = { evenLoudness: false };
  e2.settingsChanged(cfg2);
  await settle();
  assert.ok(old.log.some(l => l[0] === 'set' && l[1] === 'file-local-options/af' && l[2] === ''));
  e2.closingNow();
});

test('folders: Flow refuses them (400), whatever is under them', async () => {
  const folder = db.createCollection('A folder', { kind: 'folder' }).id;
  for (const p of [`/api/flow/status?collection=${folder}`, `/api/flow/collections/${folder}`]) {
    const r = await get(p);
    assert.strictEqual(r.status, 400, p);
    assert.strictEqual((await r.json()).code, 'FOLDER');
  }
  assert.strictEqual((await post(`/api/flow/collections/${folder}/measure`)).status, 400);
});

test('a disconnected drive and a pile of silent videos: the server keeps answering while they drain', async () => {
  const d = db.get();
  const pile = db.createCollection('Missing drive').id;
  const ins = d.prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes, file_mtime_ms, video_codec, audio_codec) VALUES (?, ?, 'video', 1, 1, 'h264', ?)");
  const add = d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)');
  d.transaction(() => {
    for (let i = 0; i < 4000; i++) {
      // Half on a drive that is not there, half probed as video with no sound.
      const id = Number(ins.run(i % 2 ? `Q:\gone\f${i}.mp4` : path.join(tmp, `nosound${i}.mp4`), `f${i}.mp4`, i % 2 ? 'aac' : null).lastInsertRowid);
      add.run(pile, id, i);
    }
  })();
  const r = await (await post(`/api/flow/collections/${pile}/measure`)).json();
  assert.strictEqual(r.added, 4000);
  let worst = 0, s;
  const t0 = Date.now();
  const { monitorEventLoopDelay } = require('node:perf_hooks');
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  do {
    const a = Date.now();
    s = await (await get(`/api/flow/status?collection=${pile}`)).json();
    worst = Math.max(worst, Date.now() - a);
  } while ((s.collection.measured + s.collection.failed) < 4000 && Date.now() - t0 < 30000);
  h.disable();
  assert.strictEqual(s.collection.failed, 2000, 'the missing ones');
  assert.strictEqual(s.collection.measured, 2000, 'the silent ones (no audio)');
  // Generous bounds: the full suite runs many files at once on a shared CPU and
  // disk (alone this drains in about 1.5 s with stalls near 10 ms).
  // Before the fix the server answered nothing for the whole drain (16 s).
  assert.ok(worst < 3000, `slowest answer while draining: ${worst} ms (all drained in ${Date.now() - t0} ms)`);
  assert.ok(h.max / 1e6 < 2000, `longest event-loop stall ${(h.max / 1e6).toFixed(0)} ms`);
});

test('quick answers: a failed write never crashes, and files dropped by a lock or a failed write are asked again', async () => {
  const d = db.get();
  const svc = require('../lib/flow/service');
  const c = db.createCollection('Quick drops').id;
  const mk = d.prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes, file_mtime_ms) VALUES (?, ?, 'video', 1, 1)");
  const add = d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)');
  const qids = [];
  for (let i = 0; i < 3; i++) { const id = Number(mk.run(`Q:\gone\drop${i}.mp4`, `drop${i}.mp4`).lastInsertRowid); add.run(c, id, i); qids.push(id); }
  const rowCount = () => d.prepare('SELECT COUNT(*) AS n FROM media_flow WHERE media_id IN (SELECT value FROM json_each(?))').get(JSON.stringify(qids)).n;
  const drained = async () => { const t0 = Date.now(); while (svc._queue().status().state !== 'idle' && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 20)); };

  // 1. The write fails (a full disk): logged, nothing thrown, the files kept for later.
  const realSave = store.save;
  store.save = () => { throw new Error('database or disk is full'); };
  try {
    svc.requestCollection(c);
    await drained();
    assert.doesNotThrow(() => svc._flushQuick());
  } finally { store.save = realSave; }
  assert.strictEqual(rowCount(), 0);
  assert.deepStrictEqual(svc._dropped().sort(), qids.slice().sort());
  svc.kick();                       // the next kick asks them again
  await drained();
  svc._flushQuick();
  assert.strictEqual(rowCount(), 3);

  // 2. The vault locks before the write: dropped, and asked again after the unlock.
  d.prepare('DELETE FROM media_flow WHERE media_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(qids));
  svc.requestCollection(c);
  await drained();
  vault.bootLocked();
  try { svc._flushQuick(); } finally { vault._locked = false; }
  assert.strictEqual(rowCount(), 0);
  assert.strictEqual(svc._dropped().length, 3);
  svc.kick();                       // what the unlock does (server/index.js vault.onChange)
  await drained();
  svc._flushQuick();
  assert.strictEqual(rowCount(), 3);
  assert.deepStrictEqual(svc._dropped(), []);
});
