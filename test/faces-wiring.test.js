/**
 * The face service wired to the REAL engine layer (analyze.js + the stub
 * engine, no models, no ffmpeg): engine pools (one engine per queue worker,
 * a separate interactive engine, idle close, retire), the production model
 * store over the registry, calibrated thresholds, and analyzeFile's progress
 * as the queue reads it.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-wiring-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
process.env.FACE_MODEL_DIR = path.join(tmp, 'models');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const faces = require('../lib/faces/service');
const { createEnginePool } = require('../lib/faces/engine-pool');
const { createEngine } = require('../lib/faces/engine');
const { analyzeFile } = require('../lib/faces/analyze');
const { progressOf } = require('../lib/faces/queue');
const { thresholdFor, THRESHOLDS } = require('../lib/faces/thresholds');
const models = require('../lib/faces/models');

test.before(() => db.init());
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// engine pool

function fakeFactory() {
  const made = [];
  const factory = () => {
    const e = { id: made.length, loads: 0, closed: false, async load() { this.loads++; }, close() { this.closed = true; } };
    made.push(e);
    return e;
  };
  return { made, factory };
}

function manualTimers() {
  const timers = new Set();
  return {
    setTimer: (fn) => { const t = { fn }; timers.add(t); return t; },
    clearTimer: (t) => timers.delete(t),
    fire: () => { for (const t of [...timers]) { timers.delete(t); t.fn(); } },
    count: () => timers.size,
  };
}

test('pool: lazy, reuses idle engines, never more than size, waiters get the next free one', async () => {
  const { made, factory } = fakeFactory();
  const tm = manualTimers();
  const pool = createEnginePool({ factory, size: 2, idleMs: 1000, ...tm });
  assert.strictEqual(made.length, 0);
  const a = await pool.acquire();
  const b = await pool.acquire();
  assert.deepStrictEqual([made.length, a.loads, b.loads], [2, 1, 1]);
  let third = null;
  const p = pool.acquire().then((e) => { third = e; });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(third, null, 'third caller waits');
  pool.release(a);
  await p;
  assert.strictEqual(third, a);
  assert.strictEqual(made.length, 2);
  pool.release(b); pool.release(a);
  assert.strictEqual(tm.count(), 2, 'idle timers armed');
  tm.fire();
  assert.ok(a.closed && b.closed, 'idle engines closed');
  assert.strictEqual(pool.stats().engines, 0);
  const c = await pool.acquire();              // and recreated on demand
  assert.strictEqual(c.id, 2);
});

test('pool: idle timer never closes a busy engine; retire closes busy ones on release', async () => {
  const { factory } = fakeFactory();
  const tm = manualTimers();
  const pool = createEnginePool({ factory, size: 2, idleMs: 1000, ...tm });
  const a = await pool.acquire();
  const b = await pool.acquire();
  pool.release(b);
  const b2 = await pool.acquire();             // timer cleared on reuse
  assert.strictEqual(b2, b);
  tm.fire();
  assert.ok(!a.closed && !b.closed);
  pool.release(b);
  pool.retire();
  assert.ok(b.closed, 'idle engine closed at once');
  assert.ok(!a.closed, 'busy engine kept until released');
  pool.release(a);
  assert.ok(a.closed);
  const fresh = await pool.acquire();
  assert.ok(fresh !== a && fresh !== b);
});

test('pool: a failed load frees the slot and propagates', async () => {
  let fail = true;
  const pool = createEnginePool({
    size: 1,
    factory: () => ({ async load() { if (fail) throw Object.assign(new Error('nope'), { code: 'FACE_MODELS_MISSING' }); }, close() {} }),
  });
  await assert.rejects(pool.acquire(), (e) => e.code === 'FACE_MODELS_MISSING');
  fail = false;
  const e = await pool.acquire();
  assert.ok(e);
  assert.strictEqual(pool.stats().engines, 1);
});

// ---------------------------------------------------------------------------
// registry, store, thresholds

test('thresholds come from the model registry', () => {
  assert.deepStrictEqual({ ...THRESHOLDS }, models.matchThresholds('sface-2021dec'));
  assert.deepStrictEqual([thresholdFor('close'), thresholdFor('normal'), thresholdFor('wide')], [0.5, 0.42, 0.36]);
  assert.strictEqual(thresholdFor('bogus'), 0.42);
  assert.strictEqual(thresholdFor('wide', 'stub-v1'), models.matchThresholds('stub-v1').wide);
});

test('production model store: registry entries, size and sha256 readiness', () => {
  const svc = faces.createService();            // no injected model store
  const entries = models.downloadEntries();
  assert.deepStrictEqual(entries.map((e) => e.key), ['face:detect', 'face:embed']);
  for (const e of entries) {
    assert.strictEqual(e.dest, path.join(process.env.FACE_MODEL_DIR, models.FACE_MODELS[e.key].file));
    assert.strictEqual(e.size, models.FACE_MODELS[e.key].bytes);
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
  }
  assert.deepStrictEqual(svc.models().missing, ['face:detect', 'face:embed']);
  fs.mkdirSync(process.env.FACE_MODEL_DIR, { recursive: true });
  fs.writeFileSync(entries[0].dest, Buffer.alloc(entries[0].size));
  fs.writeFileSync(entries[1].dest, Buffer.alloc(100));       // truncated
  assert.deepStrictEqual(svc.models().reasons, { 'face:detect': 'corrupt', 'face:embed': 'size' });
  fs.writeFileSync(entries[1].dest, Buffer.alloc(entries[1].size));
  // right sizes but zeroed: the sha256 check calls them corrupt, never ready
  assert.deepStrictEqual([svc.models().ready, svc.models().reasons], [false, { 'face:detect': 'corrupt', 'face:embed': 'corrupt' }]);
  assert.deepStrictEqual(svc.status().missingReasons, { 'face:detect': 'corrupt', 'face:embed': 'corrupt' });
  fs.rmSync(process.env.FACE_MODEL_DIR, { recursive: true, force: true });
  assert.strictEqual(svc.models().ready, false);
});

// ---------------------------------------------------------------------------
// progress

test("analyzeFile's progress reads as a rising fraction in the queue", async () => {
  const seen = [];
  await analyzeFile(createEngine({ backend: 'stub' }), { filepath: '/v/p1_d35.mp4', kind: 'video' },
    { intervalS: 3.5, onProgress: (p) => seen.push(progressOf(p, -1)) });
  assert.strictEqual(seen.length, 10);
  assert.ok(seen.every((f, i) => f > 0 && (i === 0 || f > seen[i - 1])), `${seen}`);
  assert.ok(seen[9] >= 0.98 && seen[9] < 1);
  const img = [];
  await analyzeFile(createEngine({ backend: 'stub' }), { filepath: '/i/p1.jpg', kind: 'image' },
    { onProgress: (p) => img.push(progressOf(p, -1)) });
  assert.deepStrictEqual(img, [1]);
});

// ---------------------------------------------------------------------------
// service + real analyze + stub engines

function addMedia(name, type, duration = null) {
  return Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)')
    .run(path.join(tmp, 'lib', name), name, type, duration).lastInsertRowid);
}

function wiredService(extra = {}) {
  const engines = [];
  const svc = faces.createService({
    modelStore: { entries: () => [], status: () => ({ ready: true, missing: [], paths: {} }) },
    engineFactory: () => {
      const e = createEngine({ backend: 'stub' });
      const close = e.close;
      e.close = () => { e.closedAt = engines.length; close(); };
      engines.push(e);
      return e;
    },
    fileExists: () => true,
    ...extra,
  });
  return { svc, engines };
}

test('queue workers get their own engines; clicks use the frame lane (photos, frames) or the file lane (videos)', async () => {
  require('../lib/app-settings').set({ facesEnabled: true });
  const { svc, engines } = wiredService();
  const vids = ['a_p1@0-20_p2@10-40_d40.mp4', 'b_p3_d30.mp4', 'c_p1_p4_d30.mp4'].map((n) => addMedia(n, 'video', null));
  const img = addMedia('solo_p7.jpg', 'image');
  const mid = svc.modelId();
  assert.strictEqual(mid, 'stub-v1');
  const before = engines.length;                 // modelId() may construct (not load) one

  svc.enqueue({ ids: vids });
  const now = await svc.findFacesNow(img);       // runs beside the queue on the interactive engine
  assert.deepStrictEqual([now.indexed, now.groups.length], [true, 1]);
  await svc.settled();

  assert.strictEqual(svc._engines.queue.stats().engines, 2, 'one engine per queue worker');
  assert.strictEqual(svc._engines.frame.stats().engines, 1, 'a photo click runs on the frame lane');
  assert.strictEqual(svc._engines.file.stats().engines, 0, 'file lane (videos) not started');
  assert.strictEqual(engines.slice(before).filter((e) => e.loaded).length, 3, 'two queue engines + the frame lane');

  const a = svc.fileFaces(vids[0]);
  assert.deepStrictEqual([a.indexed, a.groups.length], [true, 2]);
  assert.strictEqual(svc.fileFaces(vids[2]).groups.length, 2);

  // search by frame goes through the interactive engine's own frame source
  const interactiveBefore = engines.reduce((s, e) => s + e.calls.detect, 0);
  const r = await svc.searchImage({ mediaId: vids[0], timeS: 15 });
  assert.strictEqual(r.faces.length, 2, 'p1 and p2 are both on screen at 15 s');
  assert.strictEqual(engines.reduce((s, e) => s + e.calls.detect, 0), interactiveBefore + 1);
  assert.strictEqual(svc._engines.frame.stats().engines, 1, 'search reused the frame lane');
  // a video click takes the file lane
  const v = addMedia('clicked_p5_d10.mp4', 'video', 10);
  assert.strictEqual((await svc.findFacesNow(v)).groups.length, 1);
  assert.strictEqual(svc._engines.file.stats().engines, 1);
  // and the query finds p1's other file
  const hits = svc.similarToQuery(r.faces[0].queryId, 'normal').ids;
  assert.ok(hits.includes(vids[0]) && hits.includes(vids[2]) && !hits.includes(vids[1]), `${hits}`);

  // retire (vault lock) closes every idle engine
  svc.onVaultLocked();
  assert.deepStrictEqual(['queue', 'file', 'frame'].map((k) => svc._engines[k].stats().engines), [0, 0, 0]);
  svc.onVaultUnlocked();
});

test('idle engines are closed after the idle time', async () => {
  const { svc } = wiredService({ queueIdleMs: 30, interactiveIdleMs: 30 });
  const id = addMedia('later_p9.jpg', 'image');
  await svc.findFacesNow(id);
  assert.strictEqual(svc._engines.frame.stats().engines, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(svc._engines.frame.stats().engines, 0);
});

test('frame search never waits behind a long find-faces-now', async () => {
  const { createFakes, person, group } = require('./helpers/faces-fakes');
  const fk = createFakes();
  let open;
  const gate = new Promise((r) => { open = r; });
  const svc = faces.createService({ modelStore: fk.modelStore, engineFactory: fk.engineFactory,
    analyze: fk.analyze, frames: fk.frames, fileExists: () => true });
  const longId = addMedia('long-video.mp4', 'video', 3600);
  const imgId = addMedia('still.jpg', 'image');
  fk.fileScripts.set(path.join(tmp, 'lib', 'long-video.mp4'), { gate, groups: [group(person(1))] });
  fk.frameScripts.set(path.join(tmp, 'lib', 'still.jpg'), [{ embedding: person(2), bbox: [0.1, 0.1, 0.2, 0.2], crop: Buffer.from('c') }]);
  const long = svc.findFacesNow(longId);           // holds the file lane until the gate opens
  await new Promise((r) => setImmediate(r));
  const r = await Promise.race([
    svc.searchImage({ mediaId: imgId, timeS: 0 }).then((x) => x.faces.length),
    new Promise((res) => setTimeout(() => res('blocked'), 2000)),
  ]);
  assert.strictEqual(r, 1, 'frame search answered while the file lane was busy');
  open();
  assert.strictEqual((await long).indexed, true);
});

test('an engine that fails to load answers FACE_ENGINE_FAILED, never the raw onnx error', async (t) => {
  const errors = [];
  const orig = console.error;
  console.error = (m) => errors.push(String(m));
  t.after(() => { console.error = orig; });
  const svc = faces.createService({
    modelStore: { entries: () => [], status: () => ({ ready: true, missing: [], paths: {} }) },
    engineFactory: () => ({ modelId: 'stub-v1', async load() { throw new Error('Load model from x.onnx failed:Protobuf parsing failed.'); }, close() {} }),
    fileExists: () => true,
  });
  const id = addMedia('broken-model_p1.jpg', 'image');
  await assert.rejects(svc.searchImage({ mediaId: id, timeS: 0 }), (e) =>
    e.status === 503 && e.code === 'FACE_ENGINE_FAILED' && !/Protobuf/.test(e.message));
  assert.ok(errors.some((m) => /Protobuf/.test(m)), 'the raw error goes to the server log');
  // a file check records the clear message, not the onnx one
  await svc.findFacesNow(id);
  const row = db.get().prepare('SELECT faces_error FROM media WHERE id = ?').get(id);
  assert.match(row.faces_error, /could not load its models/);
});

test('find-faces on a photo never waits behind a long video find-faces', async () => {
  const { createFakes, person, group } = require('./helpers/faces-fakes');
  const fk = createFakes();
  let open;
  const gate = new Promise((r) => { open = r; });
  const svc = faces.createService({ modelStore: fk.modelStore, engineFactory: fk.engineFactory,
    analyze: fk.analyze, frames: fk.frames, fileExists: () => true });
  const longId = addMedia('long-video-2.mp4', 'video', 3600);
  const photoId = addMedia('photo-click.jpg', 'image');
  fk.fileScripts.set(path.join(tmp, 'lib', 'long-video-2.mp4'), { gate, groups: [group(person(1))] });
  fk.fileScripts.set(path.join(tmp, 'lib', 'photo-click.jpg'), { groups: [group(person(2))] });
  const long = svc.findFacesNow(longId);           // holds the file lane
  await new Promise((r) => setImmediate(r));
  const r = await Promise.race([
    svc.findFacesNow(photoId).then((f) => f.groups.length),
    new Promise((res) => setTimeout(() => res('blocked'), 2000)),
  ]);
  assert.strictEqual(r, 1, 'the photo was checked while the long video ran');
  assert.deepStrictEqual([svc._engines.file.stats().busy, svc._engines.frame.stats().engines], [1, 1]);
  open();
  assert.strictEqual((await long).indexed, true);
});

test("the queue's Stop leaves a click alone; turning the feature off stops it", async () => {
  const { createFakes, person, group } = require('./helpers/faces-fakes');
  const fk = createFakes();
  require('../lib/app-settings').set({ facesEnabled: true });
  const svc = faces.createService({ modelStore: fk.modelStore, engineFactory: fk.engineFactory,
    analyze: fk.analyze, frames: fk.frames, fileExists: () => true });
  const mk = (name) => {
    const id = addMedia(name, 'video', 3600);
    let open;
    const gate = new Promise((r) => { open = r; });
    fk.fileScripts.set(path.join(tmp, 'lib', name), { gate, groups: [group(person(3))] });
    return { id, open };
  };
  const a = mk('click-keep.mp4');
  const run = svc.findFacesNow(a.id);
  await new Promise((r) => setImmediate(r));
  svc.cancel();                                    // the Stop button
  a.open();
  assert.deepStrictEqual([(await run).indexed, (await run).groups.length], [true, 1], 'the click finished');
  const b = mk('click-off.mp4');
  const run2 = svc.findFacesNow(b.id);
  await new Promise((r) => setImmediate(r));
  svc.updateSettings({ enabled: false });          // feature off: everything stops
  assert.strictEqual((await run2).indexed, false);
  assert.ok(fk.calls.aborted.includes(path.join(tmp, 'lib', 'click-off.mp4')));
  require('../lib/app-settings').set({ facesEnabled: true });
});
