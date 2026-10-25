/**
 * Face indexing vs library migration, both directions (FACES_BUILD_SPEC
 * section 6), and the auto-index hook on the import pipeline.
 *
 * - while a migrate job runs, the face indexing starts answer 409
 *   MIGRATE_RUNNING and auto-index refuses to enqueue;
 * - while the face queue runs (and is not paused), a migrate refuses to start.
 *
 * The migrate planner and the AI scan (processFile) are swapped for stubs on
 * their module exports, which is what the server calls at run time.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-guards-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const faces = require('../lib/faces/service');
const migrate = require('../commands/migrate');
const scan = require('../commands/scan');
const importQueue = require('../lib/import-queue');
const { app } = require('../server/index');
const { person, group, createFakes } = require('./helpers/faces-fakes');

const fk = createFakes();
const svc = faces.setInstance(faces.createService({
  modelStore: fk.modelStore, engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames,
}));

let server, base;
const files = {};
function addFile(name, type = 'image') {
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  files[name] = fp;
  return Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)')
    .run(fp, name, type).lastInsertRowid);
}

const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json() };
};
const get = async (p) => (await fetch(base + p)).json();
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};

/** Start a migrate preview that holds until the returned release() is called. */
async function startBlockedMigrate(t) {
  let release;
  const gate = new Promise(r => { release = r; });
  const orig = { planPrefix: migrate.planPrefix, summarize: migrate.summarize };
  migrate.planPrefix = async () => { await gate; return { rewrite: [], absorb: [] }; };
  migrate.summarize = () => ({ stub: true });
  t.after(() => Object.assign(migrate, orig));
  const r = await post('/api/migrate/preview', { mode: 'prefix', oldPrefix: 'X:\\old', newPrefix: 'X:\\new' });
  assert.strictEqual(r.status, 202, 'the migrate job is running');
  return async () => {
    release();
    await until(async () => (await get('/api/migrate/job')).running === false);
  };
}

test.before(async () => {
  db.init();
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  await post('/api/faces/settings', { enabled: true });
});

test.after(async () => {
  svc.cancel();
  await svc.settled();
  importQueue.cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('a running migrate blocks the face indexing starts with 409 MIGRATE_RUNNING (reads stay open)', async (t) => {
  const id = addFile('m1.jpg');
  const finish = await startBlockedMigrate(t);
  try {
    for (const p of ['/api/faces/index', '/api/faces/queue/resume', `/api/media/${id}/find-faces`]) {
      const r = await post(p, { ids: [id] });
      assert.strictEqual(r.status, 409, p);
      assert.strictEqual(r.body.code, 'MIGRATE_RUNNING', p);
    }
    const f = await fetch(`${base}/api/media/${id}/faces`);
    assert.strictEqual(f.status, 200, 'reading faces is fine during a migrate');

    // Auto-index refuses too, and counts it as skipped
    await post('/api/faces/settings', { autoIndex: true });
    const skipped = svc._autoSkipped();
    assert.strictEqual(svc.autoEnqueue(id), false);
    assert.strictEqual(svc._autoSkipped(), skipped + 1);
    assert.strictEqual(svc.queueStatus().total, 0);
  } finally {
    await post('/api/faces/settings', { autoIndex: false });
    await finish();
  }
  // After the migrate the same request goes through
  assert.strictEqual((await post('/api/faces/index', { ids: [id] })).status, 200);
  await svc.settled();
});

test('regression: the migrate guard is not fooled by case, a trailing slash or escapes', async (t) => {
  const id = addFile('m2.jpg');
  const finish = await startBlockedMigrate(t);
  try {
    for (const p of [
      '/api/faces/index/', '/api/Faces/index', '/api/FACES/INDEX//', '/api/faces/queue/resume/',
      '/api/faces/Queue/Resume', `/api/media/${id}/find-faces/`, `/api/media/${id}/FIND-faces`,
      '/api/import/add-paths/', '/api/IMPORT/add-paths', '/api/import/queue/resume/', '/api/media/batch-rescan/',
      '/api/faces/%69ndex',
    ]) {
      const r = await post(p, { ids: [id], paths: [] });
      assert.strictEqual(r.status, 409, p);
      assert.strictEqual(r.body.code, 'MIGRATE_RUNNING', p);
    }
    // Defense in depth: the service itself refuses, whatever the route
    for (const call of [() => svc.enqueue({ ids: [id] }), () => svc.findFacesNow(id), () => svc.resume()]) {
      await assert.rejects(async () => call(), (err) => err.status === 409 && err.code === 'MIGRATE_RUNNING');
    }
    assert.strictEqual(svc.queueStatus().running, false, 'nothing was queued');
  } finally {
    await finish();
  }
});

test('a running face queue blocks a migrate from starting; pausing it makes room', async (t) => {
  let release;
  const gate = new Promise(r => { release = r; });
  const a = addFile('slow-a.jpg');
  const b = addFile('slow-b.jpg');
  fk.fileScripts.set(files['slow-a.jpg'], { gate, groups: [group(person(0))] });
  fk.fileScripts.set(files['slow-b.jpg'], { gate, groups: [] });
  svc._queue.setWorkers(1);
  t.after(() => svc._queue.setWorkers(2));
  try {
    await post('/api/faces/index', { ids: [a, b] });
    assert.ok(svc.isBusy());
    const r = await post('/api/migrate/preview', { mode: 'prefix', oldPrefix: 'X:\\old', newPrefix: 'X:\\new' });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /scan is running/);
    // Pause while slow-a runs: slow-b stays banked.
    await post('/api/faces/queue/pause');
  } finally {
    release();
  }
  await until(() => svc.queueStatus().current.length === 0);
  assert.strictEqual(svc.queueStatus().done, 1);
  // Paused with banked work: idle as far as migrate is concerned...
  assert.ok(!svc.isBusy());
  const finish = await startBlockedMigrate(t);
  // ...and resume is then refused until the migrate is done
  assert.strictEqual((await post('/api/faces/queue/resume')).body.code, 'MIGRATE_RUNNING');
  await finish();
  assert.strictEqual((await post('/api/faces/queue/resume')).status, 200);
  await svc.settled();
});

test('auto-index hook: new imports are queued only when the toggle is on', async (t) => {
  const origProcess = scan.processFile;
  scan.processFile = async () => ({});      // the AI scan, stubbed: it "succeeds" at once
  // add-paths also probes and thumbnails new files in the background; the
  // fixtures are not real media, so keep ffmpeg out of it.
  const thumbs = require('../lib/thumbnails');
  const mediaInfo = require('../lib/media-info');
  const orig = { enqueueThumbnail: thumbs.enqueueThumbnail, isAvailable: mediaInfo.isAvailable };
  thumbs.enqueueThumbnail = () => null;
  mediaInfo.isAvailable = () => false;
  t.after(() => {
    scan.processFile = origProcess;
    thumbs.enqueueThumbnail = orig.enqueueThumbnail;
    mediaInfo.isAvailable = orig.isAvailable;
  });

  const mk = (name) => {
    const fp = path.join(tmp, 'incoming', name);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, name);
    fk.fileScripts.set(fp, { groups: [group(person(3))] });
    return fp;
  };
  const indexedAt = (fp) => db.get().prepare('SELECT faces_indexed_at FROM media WHERE filepath = ?').get(fp)?.faces_indexed_at;
  const calledFor = (fp) => fk.calls.analyzeFile.some(c => c.file.filepath === fp);

  // Off (default): imported, scanned, never face-checked
  const off = mk('off.jpg');
  let r = await post('/api/import/add-paths', { paths: [off] });
  assert.strictEqual(r.status, 200);
  await until(() => !importQueue.isActive());
  await svc.settled();
  assert.ok(!calledFor(off));
  assert.strictEqual(indexedAt(off), null);

  // On: the new row is face-checked once its import finishes
  await post('/api/faces/settings', { autoIndex: true });
  const on = mk('on.jpg');
  const song = mk('song.mp3');
  r = await post('/api/import/add-paths', { paths: [on, song] });
  assert.strictEqual(r.body.added.length, 2);
  await until(() => !importQueue.isActive());
  await until(() => calledFor(on));
  await svc.settled();
  assert.ok(indexedAt(on), 'auto-indexed');
  assert.ok(!calledFor(song), 'audio is not eligible');

  // Models missing: skipped, not queued
  fk.setReady(false);
  try {
    const nomodel = mk('nomodel.jpg');
    await post('/api/import/add-paths', { paths: [nomodel] });
    await until(() => !importQueue.isActive());
    await svc.settled();
    assert.ok(!calledFor(nomodel));
  } finally {
    fk.setReady(true);
  }

  // A rescan of an existing row is not a new import
  const before = fk.calls.analyzeFile.length;
  const existing = db.get().prepare('SELECT id FROM media WHERE filepath = ?').get(off).id;
  db.get().prepare("UPDATE media SET processing_error = 'boom' WHERE id = ?").run(existing);
  await post('/api/media/retry-errors', { ids: [existing] });
  await until(() => !importQueue.isActive());
  await svc.settled();
  assert.strictEqual(fk.calls.analyzeFile.length, before);
  await post('/api/faces/settings', { autoIndex: false });
});
