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

test('production model store: registry entries, exact-size readiness, flips without restart', () => {
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
  fs.writeFileSync(entries[1].dest, Buffer.alloc(100));       // truncated: still missing
  assert.deepStrictEqual(svc.models().missing, ['face:embed']);
  fs.writeFileSync(entries[1].dest, Buffer.alloc(entries[1].size));
  assert.strictEqual(svc.models().ready, true);
  assert.strictEqual(models.resolveFaceModelPaths().ok, true, 'same rule as the engine uses');
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

test('queue workers get their own engines; find-faces-now and search use a separate one', async () => {
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
  assert.strictEqual(svc._engines.interactive.stats().engines, 1);
  assert.strictEqual(engines.slice(before).filter((e) => e.loaded).length, 3, 'two queue engines + one interactive');

  const a = svc.fileFaces(vids[0]);
  assert.deepStrictEqual([a.indexed, a.groups.length], [true, 2]);
  assert.strictEqual(svc.fileFaces(vids[2]).groups.length, 2);

  // search by frame goes through the interactive engine's own frame source
  const interactiveBefore = engines.reduce((s, e) => s + e.calls.detect, 0);
  const r = await svc.searchImage({ mediaId: vids[0], timeS: 15 });
  assert.strictEqual(r.faces.length, 2, 'p1 and p2 are both on screen at 15 s');
  assert.strictEqual(engines.reduce((s, e) => s + e.calls.detect, 0), interactiveBefore + 1);
  // and the query finds p1's other file
  const hits = svc.similarToQuery(r.faces[0].queryId, 'normal').ids;
  assert.ok(hits.includes(vids[0]) && hits.includes(vids[2]) && !hits.includes(vids[1]), `${hits}`);

  // retire (vault lock) closes every idle engine
  svc.onVaultLocked();
  assert.deepStrictEqual([svc._engines.queue.stats().engines, svc._engines.interactive.stats().engines], [0, 0]);
  svc.onVaultUnlocked();
});

test('idle engines are closed after the idle time', async () => {
  const { svc } = wiredService({ queueIdleMs: 30, interactiveIdleMs: 30 });
  const id = addMedia('later_p9.jpg', 'image');
  await svc.findFacesNow(id);
  assert.strictEqual(svc._engines.interactive.stats().engines, 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(svc._engines.interactive.stats().engines, 0);
});
