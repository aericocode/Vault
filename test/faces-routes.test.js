/**
 * /api/faces/* and /api/media/:id/(faces|find-faces) over HTTP against the
 * real Express app, with the engine layer replaced by fakes that follow the
 * section 2 contract (no models, no network).
 *
 * Library: img1 and video3 show person 0, img2 shows person 1, video3 also
 * shows person 2, err.jpg always fails analysis, anim.gif has nobody in it,
 * song.mp3 is not eligible.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-routes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const config = require('../config');
const db = require('../lib/database');
const faces = require('../lib/faces/service');
const store = require('../lib/faces/store');
const { createFileModelStore } = require('../lib/faces/download');
const { app } = require('../server/index');
const { person, like, group, createFakes } = require('./helpers/faces-fakes');

const fk = createFakes();
let clock = Date.now();
const qtmp = path.join(tmp, 'qtmp');
fs.mkdirSync(qtmp);
const svc = faces.setInstance(faces.createService({
  modelStore: fk.modelStore, engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames,
  now: () => clock, tmpDir: qtmp,
}));

let server, base;
const ids = {};
const files = {};

function addFile(name, type, { duration = null } = {}) {
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  files[name] = fp;
  ids[name] = Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)')
    .run(fp, name, type, duration).lastInsertRowid);
  return ids[name];
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const post = async (p, body) => { const r = await fetch(base + p, json(body)); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const setEnabled = (on) => post('/api/faces/settings', { enabled: on });

test.before(async () => {
  db.init();
  addFile('img1.jpg', 'image');
  addFile('img2.jpg', 'image');
  addFile('video3.mp4', 'video', { duration: 120 });
  addFile('err.jpg', 'image');
  addFile('anim.gif', 'gif');
  addFile('song.mp3', 'audio');
  fk.fileScripts.set(files['img1.jpg'], { groups: [group(person(0), { crop: Buffer.from('crop-img1-p0') })] });
  fk.fileScripts.set(files['img2.jpg'], { groups: [group(person(1))] });
  fk.fileScripts.set(files['video3.mp4'], { groups: [
    group([like(0, 0.9, 101), like(0, 0.85, 102)], { appearances: 9, firstTimeS: 7 }),
    group(person(2), { appearances: 2, firstTimeS: 70 }),
  ] });
  fk.fileScripts.set(files['err.jpg'], { error: 'ffmpeg exploded' });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  svc.cancel();
  await svc.settled();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('feature off: status answers, everything else but settings/delete-all is FACES_OFF', async () => {
  const s = await get('/api/faces/status');
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(Object.keys(s.body).sort(),
    ['autoIndex', 'counts', 'download', 'enabled', 'intervalS', 'maxFrames', 'missing', 'missingReasons', 'modelsReady', 'people', 'queue'].sort());
  assert.deepStrictEqual(Object.keys(s.body.people).sort(), ['pending', 'sorting', 'suggestions', 'total']);
  assert.strictEqual(s.body.maxFrames, 2000);
  assert.strictEqual(s.body.enabled, false);
  assert.strictEqual(s.body.autoIndex, false);
  assert.strictEqual(s.body.intervalS, 3.5);
  assert.deepStrictEqual(Object.keys(s.body.queue).sort(),
    ['current', 'done', 'etaS', 'failed', 'lastRun', 'paused', 'planned', 'recent', 'running', 'startedAt', 'total', 'withPeople'].sort());
  for (const [method, p] of [
    ['POST', '/api/faces/index'], ['POST', '/api/faces/queue/pause'], ['POST', '/api/faces/queue/resume'],
    ['POST', '/api/faces/queue/cancel'], ['GET', `/api/media/${ids['img1.jpg']}/faces`],
    ['POST', `/api/media/${ids['img1.jpg']}/find-faces`], ['GET', '/api/faces/crop/1'],
    ['POST', '/api/faces/groups/1/similar'], ['POST', '/api/faces/groups/1/hide'],
    ['POST', '/api/faces/search-image'], ['GET', '/api/faces/query/abc/crop'], ['POST', '/api/faces/query/abc/similar'],
    ['POST', '/api/faces/groups/1/not-a-face'], ['POST', '/api/faces/people'], ['POST', '/api/faces/people/1/add'],
    ['GET', '/api/faces/people/1/candidates'], ['POST', '/api/faces/people/1/candidates'], ['POST', '/api/faces/people/1/not-a-face'],
  ]) {
    const r = await fetch(base + p, method === 'POST' ? json({}) : {});
    assert.strictEqual(r.status, 409, p);
    assert.strictEqual((await r.json()).code, 'FACES_OFF', p);
  }
  assert.strictEqual((await post('/api/faces/delete-all')).status, 200);
});

test('settings: enable, auto-index, interval (0.5 to 120 in steps of 0.5)', async () => {
  let r = await post('/api/faces/settings', { intervalS: 5.2 });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.code, 'BAD_SETTING');
  r = await post('/api/faces/settings', { enabled: true, intervalS: 10 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.enabled, true);
  assert.strictEqual(r.body.intervalS, 10);
  const saved = JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8'));
  assert.strictEqual(saved.facesEnabled, true);
  assert.strictEqual(saved.facesIntervalS, 10);
});

test('models missing: engine routes answer FACE_MODELS_MISSING with the missing keys', async () => {
  fk.setReady(false);
  try {
    const s = await get('/api/faces/status');
    assert.strictEqual(s.body.modelsReady, false);
    assert.deepStrictEqual(s.body.missing, ['face:detect', 'face:embed']);
    for (const p of ['/api/faces/index', '/api/faces/queue/resume', `/api/media/${ids['img1.jpg']}/find-faces`,
      '/api/faces/search-image', '/api/faces/groups/1/similar']) {
      const r = await post(p, { ids: [ids['img1.jpg']] });
      assert.strictEqual(r.status, 409, p);
      assert.strictEqual(r.body.code, 'FACE_MODELS_MISSING', p);
      assert.deepStrictEqual(r.body.missing, ['face:detect', 'face:embed'], p);
    }
  } finally {
    fk.setReady(true);
  }
});

test('model download: offline is refused, consent is per key, then it downloads and becomes ready', async (t) => {
  const crypto = require('node:crypto');
  const dir = path.join(tmp, 'models');
  const bytes = { det: Buffer.from('DET'), emb: Buffer.from('EMB') };
  const entries = [
    { key: 'face:detect', url: 'https://huggingface.co/m/det.onnx', sha256: crypto.createHash('sha256').update(bytes.det).digest('hex'), size: 3, dest: path.join(dir, 'det.onnx') },
    { key: 'face:embed', url: 'https://huggingface.co/m/emb.onnx', sha256: crypto.createHash('sha256').update(bytes.emb).digest('hex'), size: 3, dest: path.join(dir, 'emb.onnx') },
  ];
  const granted = new Set();
  const asked = [];
  const consent = { ENV_ALLOWS: true, isAllowed: (k) => granted.has(k), request: (k) => { asked.push(k); return false; } };
  const fetched = [];
  const fetchImpl = async (url, opts) => {
    fetched.push([url, opts.purpose]);
    return new Response(url.endsWith('det.onnx') ? bytes.det : bytes.emb, { status: 200 });
  };
  const dsvc = faces.createService({ modelStore: createFileModelStore(() => entries), consent, fetchImpl,
    engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames });
  faces.setInstance(dsvc);
  t.after(() => faces.setInstance(svc));

  let r = await post('/api/faces/models/download');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'NET_OFF', 'VAULT_OFFLINE wins');

  const prev = [config.net.offline, config.subtitles.allowModelDownload];
  config.net.offline = false;
  config.subtitles.allowModelDownload = true;
  t.after(() => { [config.net.offline, config.subtitles.allowModelDownload] = prev; });

  r = await post('/api/faces/models/download');
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'CONSENT_NEEDED');
  assert.deepStrictEqual(r.body.keys, ['face:detect', 'face:embed']);
  assert.deepStrictEqual(asked, ['face:detect', 'face:embed'], 'the asks are recorded for the consent UI');
  granted.add('face:detect');
  r = await post('/api/faces/models/download');
  assert.deepStrictEqual(r.body.keys, ['face:embed']);
  assert.strictEqual(fetched.length, 0, 'nothing fetched without consent for every key');

  granted.add('face:embed');
  r = await post('/api/faces/models/download');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.download);
  await dsvc.downloadSettled();
  const s = await get('/api/faces/status');
  assert.strictEqual(s.body.modelsReady, true);
  assert.deepStrictEqual(s.body.download, { running: false, received: 6, total: 6, error: null });
  assert.deepStrictEqual(fetched.map(f => f[1]), ['model', 'model']);
});

test('index everything: statuses, groups and errors persisted; ineligible files skipped', async () => {
  let r = await post('/api/faces/index', { ids: [ids['song.mp3']] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.added, 0);
  assert.strictEqual(r.body.skipped, 1);
  r = await post('/api/faces/index', { ids: 'nope' });
  assert.strictEqual(r.status, 400);

  r = await post('/api/faces/index', { all: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.added, 5);
  await svc.settled();

  const s = (await get('/api/faces/status')).body;
  assert.deepStrictEqual(s.counts, { eligible: 5, indexed: 4, withFaces: 3, people: 4 });
  assert.deepStrictEqual([s.queue.running, s.queue.startedAt], [false, null]);
  assert.deepStrictEqual([s.queue.lastRun.done, s.queue.lastRun.failed, s.queue.lastRun.total], [4, 1, 5]);

  const vcall = fk.calls.analyzeFile.find(c => c.file.filepath === files['video3.mp4']);
  assert.deepStrictEqual([vcall.file.kind, vcall.file.durationS, vcall.opts.intervalS, vcall.opts.maxFrames], ['video', 120, 10, 2000]);
  assert.strictEqual(fk.calls.analyzeFile.find(c => c.file.filepath === files['anim.gif']).file.kind, 'gif');

  const v = await get(`/api/media/${ids['video3.mp4']}/faces`);
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.body.eligible, true);
  assert.strictEqual(v.body.indexed, true);
  assert.strictEqual(v.body.error, null);
  assert.deepStrictEqual(v.body.groups.map(g => [g.appearances, g.firstTimeS]), [[9, 7], [2, 70]]);
  assert.deepStrictEqual(Object.keys(v.body.groups[0]).sort(), ['appearances', 'bestTimeS', 'cropUrl', 'firstTimeS', 'id', 'personId', 'personName']);

  const e = (await get(`/api/media/${ids['err.jpg']}/faces`)).body;
  assert.deepStrictEqual([e.indexed, e.error, e.groups.length], [false, 'ffmpeg exploded', 0]);
  const g = (await get(`/api/media/${ids['anim.gif']}/faces`)).body;
  assert.deepStrictEqual([g.indexed, g.groups.length], [true, 0]);
  const a = (await get(`/api/media/${ids['song.mp3']}/faces`)).body;
  assert.deepStrictEqual([a.eligible, a.indexed], [false, false]);
  assert.strictEqual((await get('/api/media/99999/faces')).status, 404);

  // A second "everything" only picks up what is not indexed: the failed file
  r = await post('/api/faces/index', { all: true });
  assert.strictEqual(r.body.added, 1);
  await svc.settled();
});

test('crop route serves the stored JPEG, cacheable forever (plain library)', async () => {
  const [g] = (await get(`/api/media/${ids['img1.jpg']}/faces`)).body.groups;
  const r = await fetch(base + g.cropUrl);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'crop-img1-p0');
  assert.strictEqual((await fetch(`${base}/api/faces/crop/987654`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/faces/crop/abc`)).status, 400);
});

test('similar: same person across files, widths, bad width, other people excluded', async () => {
  const [g] = (await get(`/api/media/${ids['img1.jpg']}/faces`)).body.groups;
  const r = await post(`/api/faces/groups/${g.id}/similar`, { width: 'normal' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['capped', 'ids', 'match', 'scores', 'source', 'total']);
  assert.deepStrictEqual(r.body.ids, [ids['img1.jpg'], ids['video3.mp4']]);
  assert.strictEqual(r.body.total, 2);
  assert.strictEqual(r.body.capped, false);
  assert.strictEqual((await post(`/api/faces/groups/${g.id}/similar`, { width: 'huge' })).body.code, 'BAD_WIDTH');
  assert.strictEqual((await post('/api/faces/groups/987654/similar', {})).status, 404);

  // Trashed files leave the results but keep their own chips
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(ids['video3.mp4']);
  try {
    assert.deepStrictEqual((await post(`/api/faces/groups/${g.id}/similar`, {})).body.ids, [ids['img1.jpg']]);
    assert.strictEqual((await get(`/api/media/${ids['video3.mp4']}/faces`)).body.groups.length, 2);
  } finally {
    db.get().prepare('UPDATE media SET user_trashed = 0 WHERE id = ?').run(ids['video3.mp4']);
  }
});

test('a model change makes everything read as not indexed until re-checked', async () => {
  fk.engine.modelId = 'stub-v2';
  try {
    const f = (await get(`/api/media/${ids['img1.jpg']}/faces`)).body;
    assert.deepStrictEqual([f.indexed, f.groups.length], [false, 0]);
    assert.strictEqual((await get('/api/faces/status')).body.counts.indexed, 0);
    const gid = db.get().prepare('SELECT id FROM face_groups WHERE media_id = ?').get(ids['img1.jpg']).id;
    const r = await post(`/api/faces/groups/${gid}/similar`, {});
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.code, 'FACE_MODEL_CHANGED');
  } finally {
    fk.engine.modelId = 'stub-v1';
  }
});

test('hide: the chip goes and the face leaves search', async () => {
  const [p0, p2] = (await get(`/api/media/${ids['video3.mp4']}/faces`)).body.groups;
  const r = await post(`/api/faces/groups/${p0.id}/hide`);
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  assert.deepStrictEqual((await get(`/api/media/${ids['video3.mp4']}/faces`)).body.groups.map(g => g.id), [p2.id]);
  const [g1] = (await get(`/api/media/${ids['img1.jpg']}/faces`)).body.groups;
  assert.deepStrictEqual((await post(`/api/faces/groups/${g1.id}/similar`, { width: 'wide' })).body.ids, [ids['img1.jpg']]);
  assert.strictEqual((await post('/api/faces/groups/987654/hide')).status, 404);
});

test('find-faces indexes one file now and answers the faces shape; force re-checks', async () => {
  const id = addFile('new.jpg', 'image');
  fk.fileScripts.set(files['new.jpg'], { groups: [group(person(5)), group(person(6))] });
  let r = await post(`/api/media/${id}/find-faces`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.eligible, r.body.indexed, r.body.groups.length], [true, true, 2]);
  const calls = fk.calls.analyzeFile.length;
  r = await post(`/api/media/${id}/find-faces`);
  assert.strictEqual(fk.calls.analyzeFile.length, calls, 'already indexed: no work');
  fk.fileScripts.set(files['new.jpg'], { groups: [group(person(5))] });
  r = await post(`/api/media/${id}/find-faces`, { force: true });
  assert.strictEqual(r.body.groups.length, 1);
  assert.strictEqual((await post(`/api/media/${ids['song.mp3']}/find-faces`)).body.code, 'NOT_ELIGIBLE');
  assert.strictEqual((await post('/api/media/99999/find-faces')).status, 404);
});

test('search-image with an uploaded photo: faces in memory, temp file gone, crops not cached', async () => {
  fk.frameScripts.set('two-people', [
    { embedding: person(0), bbox: [0.1, 0.1, 0.2, 0.2], crop: Buffer.from('q-crop-0') },
    { embedding: person(1), bbox: [0.5, 0.1, 0.2, 0.2], crop: Buffer.from('q-crop-1') },
  ]);
  const res = await fetch(`${base}/api/faces/search-image`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'two-people',
  });
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.faces.length, 2);
  assert.deepStrictEqual(Object.keys(body.faces[0]).sort(), ['bbox', 'cropUrl', 'queryId']);
  const dec = fk.calls.decodeImage.at(-1);
  assert.ok(dec.existed, 'decoded from a temp file');
  assert.ok(dec.filepath.startsWith(qtmp));
  assert.ok(!fs.existsSync(dec.filepath), 'temp file deleted after decoding');
  assert.deepStrictEqual(fs.readdirSync(qtmp), []);

  const c = await fetch(base + body.faces[1].cropUrl);
  assert.strictEqual(c.headers.get('cache-control'), 'no-store');
  assert.strictEqual(Buffer.from(await c.arrayBuffer()).toString(), 'q-crop-1');

  const sim = await post(`/api/faces/query/${body.faces[1].queryId}/similar`, { width: 'close' });
  assert.deepStrictEqual(sim.body.ids, [ids['img2.jpg']]);

  // Nothing about the query face reached the database
  assert.strictEqual(db.get().prepare("SELECT COUNT(*) AS n FROM face_groups WHERE best_bbox = '[0.5,0.1,0.2,0.2]'").get().n, 0);
});

test('search-image: bad photo, wrong type, too big, no faces', async () => {
  let r = await fetch(`${base}/api/faces/search-image`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: 'not-an-image' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual((await r.json()).code, 'BAD_IMAGE');
  r = await fetch(`${base}/api/faces/search-image`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${base}/api/faces/search-image`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.alloc(26 * 1024 * 1024) });
  assert.strictEqual(r.status, 413);
  assert.strictEqual((await r.json()).code, 'TOO_LARGE');
  r = await fetch(`${base}/api/faces/search-image`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'nobody-here' });
  assert.deepStrictEqual(await r.json(), { faces: [] });
  assert.deepStrictEqual(fs.readdirSync(qtmp), []);
});

test('search-image with { mediaId, timeS }: a video frame, or the photo itself', async () => {
  fk.frameScripts.set(`${files['video3.mp4']}@12.5`, [{ embedding: like(0, 0.9, 110), bbox: [0, 0, 0.5, 0.5], crop: Buffer.from('f') }]);
  let r = await post('/api/faces/search-image', { mediaId: ids['video3.mp4'], timeS: 12.5 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.faces.length, 1);
  assert.deepStrictEqual(fk.calls.grabFrame.at(-1), { filepath: files['video3.mp4'], timeS: 12.5 });
  r = await post('/api/faces/search-image', { mediaId: ids['img2.jpg'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(fk.calls.decodeImage.at(-1).filepath, files['img2.jpg']);
  assert.strictEqual((await post('/api/faces/search-image', { mediaId: 99999 })).status, 404);
  assert.strictEqual((await post('/api/faces/search-image', { mediaId: ids['song.mp3'] })).body.code, 'NOT_ELIGIBLE');
  assert.strictEqual((await post('/api/faces/search-image', {})).status, 400);
});

test('query faces expire after 15 minutes and at most 50 are kept', async () => {
  fk.frameScripts.set('one', [{ embedding: person(0), bbox: [0, 0, 1, 1], crop: Buffer.from('o') }]);
  const one = async () => (await (await fetch(`${base}/api/faces/search-image`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'one' })).json()).faces[0].queryId;
  const q = await one();
  assert.strictEqual((await post(`/api/faces/query/${q}/similar`, {})).status, 200);
  clock += 15 * 60 * 1000 + 1;
  const r = await post(`/api/faces/query/${q}/similar`, {});
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.body.code, 'QUERY_EXPIRED');
  assert.strictEqual((await fetch(`${base}/api/faces/query/${q}/crop`)).status, 404);

  const first = await one();
  for (let i = 0; i < 50; i++) await one();
  assert.strictEqual(svc._queries.size, 50);
  assert.strictEqual((await post(`/api/faces/query/${first}/similar`, {})).status, 404, 'oldest evicted');
});

test('queue routes: pause / resume / cancel; cancel aborts the running file', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const a = addFile('slow1.jpg', 'image');
  const b = addFile('slow2.jpg', 'image');
  fk.fileScripts.set(files['slow1.jpg'], { gate, groups: [] });
  fk.fileScripts.set(files['slow2.jpg'], { gate, groups: [] });
  svc._queue.setWorkers(1);
  try {
    let r = await post('/api/faces/index', { ids: [a, b] });
    assert.strictEqual(r.body.running, true);
    r = await post('/api/faces/queue/pause');
    assert.strictEqual(r.body.paused, true);
    r = await post('/api/faces/queue/resume');
    assert.strictEqual(r.body.paused, false);
    assert.deepStrictEqual((await get('/api/faces/status')).body.queue.current.map(c => c.id), [a]);
    r = await post('/api/faces/queue/cancel');
    await svc.settled();
    assert.ok(fk.calls.aborted.includes(files['slow1.jpg']), 'running file aborted');
    const s = (await get('/api/faces/status')).body.queue;
    assert.strictEqual(s.running, false);
    assert.ok(!fk.calls.analyzeFile.some(c => c.file.filepath === files['slow2.jpg']), 'pending file never ran');
    const f = (await get(`/api/media/${a}/faces`)).body;
    assert.deepStrictEqual([f.indexed, f.error], [false, null], 'a cancelled file is not marked failed');
  } finally {
    release();
    svc._queue.setWorkers(2);
  }
});

test('turning the feature off cancels the queue', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const a = addFile('slow3.jpg', 'image');
  fk.fileScripts.set(files['slow3.jpg'], { gate, groups: [] });
  try {
    await post('/api/faces/index', { ids: [a] });
    assert.strictEqual((await get('/api/faces/status')).body.queue.running, true);
    await setEnabled(false);
    await svc.settled();
    assert.ok(fk.calls.aborted.includes(files['slow3.jpg']));
    assert.strictEqual((await get('/api/faces/status')).body.queue.running, false);
  } finally {
    release();
    await setEnabled(true);
  }
});

test('hard delete through the records route removes faces, crops and search hits', async () => {
  const id = addFile('todelete.jpg', 'image');
  fk.fileScripts.set(files['todelete.jpg'], { groups: [group(person(0))] });
  const [g] = (await post(`/api/media/${id}/find-faces`)).body.groups;
  assert.ok(fs.existsSync(store.cropPath(g.id)));
  const [g1] = (await get(`/api/media/${ids['img1.jpg']}/faces`)).body.groups;
  assert.ok((await post(`/api/faces/groups/${g1.id}/similar`, {})).body.ids.includes(id));
  const r = await post('/api/records/delete', { ids: [id] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) AS n FROM face_groups WHERE media_id = ?').get(id).n, 0);
  assert.strictEqual(db.get().prepare('SELECT COUNT(*) AS n FROM face_vectors WHERE media_id = ?').get(id).n, 0);
  assert.ok(!fs.existsSync(store.cropPath(g.id)));
  assert.ok(!(await post(`/api/faces/groups/${g1.id}/similar`, {})).body.ids.includes(id));
});

test('delete-all: tables, crops, media columns, memory index, query cache and queue all cleared', async () => {
  // A search builds the memory index and a query face sits in the cache
  const [g1] = (await get(`/api/media/${ids['img1.jpg']}/faces`)).body.groups;
  await post(`/api/faces/groups/${g1.id}/similar`, {});
  await fetch(`${base}/api/faces/search-image`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: 'one' });
  assert.ok(svc._index.stats().built && svc._index.stats().vectors > 0);
  assert.ok(svc._queries.size > 0);
  // and a file is mid-analysis
  let release;
  const gate = new Promise(r => { release = r; });
  const a = addFile('slow4.jpg', 'image');
  fk.fileScripts.set(files['slow4.jpg'], { gate, groups: [group(person(9))] });
  await post('/api/faces/index', { ids: [a] });

  const r = await post('/api/faces/delete-all');
  release();
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  const d = db.get();
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM face_groups').get().n, 0);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM face_vectors').get().n, 0);
  assert.strictEqual(d.prepare(`SELECT COUNT(*) AS n FROM media WHERE faces_indexed_at IS NOT NULL
    OR faces_model IS NOT NULL OR faces_error IS NOT NULL`).get().n, 0);
  assert.ok(!fs.existsSync(store.cropDir()) || fs.readdirSync(store.cropDir()).length === 0);
  assert.deepStrictEqual(svc._index.stats(), { built: false, vectors: 0, modelId: null });
  assert.strictEqual(svc._queries.size, 0);
  assert.ok(fk.calls.aborted.includes(files['slow4.jpg']));
  const s = (await get('/api/faces/status')).body;
  assert.strictEqual(s.queue.running, false);
  assert.deepStrictEqual(s.counts, { eligible: 10, indexed: 0, withFaces: 0, people: 0 });
  assert.strictEqual((await post(`/api/faces/groups/${g1.id}/similar`, {})).status, 404);
});

test('the CSRF guard covers the raw-image upload like every other write', async () => {
  const r = await fetch(`${base}/api/faces/search-image`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg', Origin: 'http://evil.example' }, body: 'one',
  });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).code, 'CSRF_ORIGIN');
  assert.deepStrictEqual(fs.readdirSync(qtmp), [], 'nothing was written');
});

test('regression: settings and search-image inputs are strict', async () => {
  for (const v of ['3.5', [3.5], 3.25, null]) {
    const r = await post('/api/faces/settings', { intervalS: v });
    assert.strictEqual(r.status, 400, JSON.stringify(v));
  }
  for (const body of [{ mediaId: String(ids['img1.jpg']) }, { mediaId: [ids['img1.jpg']] }, { mediaId: 1.5 }, { mediaId: -1 },
    { mediaId: ids['video3.mp4'], timeS: -1 }, { mediaId: ids['video3.mp4'], timeS: '12' },
    { mediaId: ids['video3.mp4'], timeS: [1] }]) {
    const r = await post('/api/faces/search-image', body);
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
  // Past the end of a video with a known duration: clamped inside it
  let r = await post('/api/faces/search-image', { mediaId: ids['video3.mp4'], timeS: 500 });
  assert.strictEqual(r.status, 200);
  const at = fk.calls.grabFrame.at(-1).timeS;
  assert.ok(at <= 120 && at > 119, `clamped to the duration (${at})`);
  // No duration on record: absurd times are refused, sane ones pass through
  const nodur = addFile('nodur.mp4', 'video');
  r = await post('/api/faces/search-image', { mediaId: nodur, timeS: 2e7 });
  assert.strictEqual(r.status, 400);
  r = await post('/api/faces/search-image', { mediaId: nodur, timeS: 33 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(fk.calls.grabFrame.at(-1).timeS, 33);
});

test('regression: off-then-on and an immediate re-index really indexes the file', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const a = addFile('flip.jpg', 'image');
  fk.fileScripts.set(files['flip.jpg'], { gate, groups: [group(person(4))] });
  await post('/api/faces/index', { ids: [a] });
  await setEnabled(false);              // cancels: the run is still winding down
  await setEnabled(true);
  const r = await post('/api/faces/index', { ids: [a] });
  assert.strictEqual(r.body.added, 1, 'not deduped against the cancelled run');
  release();
  await svc.settled();
  const f = (await get(`/api/media/${a}/faces`)).body;
  assert.deepStrictEqual([f.indexed, f.groups.length], [true, 1]);
});

test('regression: a hidden face stays hidden through a forced re-check and a forced re-index', async () => {
  await setEnabled(true);
  const a = addFile('hideme.jpg', 'image');
  fk.fileScripts.set(files['hideme.jpg'], { groups: [group(person(7)), group(person(8))] });
  let f = (await post(`/api/media/${a}/find-faces`)).body;
  assert.strictEqual(f.groups.length, 2);
  // hide the person(7) group (inserted first)
  const db7 = db.get().prepare(`SELECT g.id FROM face_groups g JOIN face_vectors v ON v.group_id = g.id
    WHERE g.media_id = ? ORDER BY g.id`).all(a).map(r => r.id);
  assert.strictEqual(db7.length, 2);
  const hiddenId = db7[0];
  assert.strictEqual((await post(`/api/faces/groups/${hiddenId}/hide`)).status, 200);
  // same person seen a bit differently, plus a new person
  fk.fileScripts.set(files['hideme.jpg'], { groups: [group(like(7, 0.8, 110)), group(person(8)), group(person(9))] });
  f = (await post(`/api/media/${a}/find-faces`, { force: true })).body;
  assert.strictEqual(f.groups.length, 2, 'person 7 is still hidden after a re-check');
  let hidden = db.get().prepare('SELECT COUNT(*) n FROM face_groups WHERE media_id = ? AND hidden = 1').get(a).n;
  assert.strictEqual(hidden, 1);
  // a probe for person 7 must not find this file
  const probe = addFile('probe7.jpg', 'image');
  fk.fileScripts.set(files['probe7.jpg'], { groups: [group(person(7))] });
  const pf = (await post(`/api/media/${probe}/find-faces`)).body;
  assert.ok(!(await post(`/api/faces/groups/${pf.groups[0].id}/similar`, { width: 'wide' })).body.ids.includes(a));
  // queue path (force) too
  await post('/api/faces/index', { ids: [a], force: true });
  await svc.settled();
  hidden = db.get().prepare('SELECT COUNT(*) n FROM face_groups WHERE media_id = ? AND hidden = 1').get(a).n;
  assert.strictEqual(hidden, 1, 'still hidden after a forced queue re-index');
  assert.strictEqual((await get(`/api/media/${a}/faces`)).body.groups.length, 2);
});

test('regression: a request that hits the locked DB answers 423 VAULT_LOCKED, not 500', async (t) => {
  await setEnabled(true);
  const orig = svc.fileFaces;
  svc.fileFaces = () => { throw Object.assign(new Error('database is encrypted: password required'), { code: 'DB_ENCRYPTED' }); };
  t.after(() => { svc.fileFaces = orig; });
  const r = await get(`/api/media/${ids['img1.jpg']}/faces`);
  assert.deepStrictEqual([r.status, r.body.code], [423, 'VAULT_LOCKED']);
  assert.ok(!/encrypted/.test(r.body.error));
});

test('regression: an upload still arriving when the vault locks answers 423 and stores nothing', async () => {
  await setEnabled(true);
  const http = require('node:http');
  const body = Buffer.from('slow-upload-face'.repeat(200));
  fk.frameScripts.set(body.toString('utf8'), [{ embedding: person(3), bbox: [0.1, 0.1, 0.2, 0.2], crop: Buffer.from('q') }]);
  const before = svc._queries.size;
  const { port } = server.address();
  const res = new Promise((ok, fail) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/faces/search-image', method: 'POST',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Length': body.length } }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => ok({ status: r.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', fail);
    req.write(body.subarray(0, 1000));
    setTimeout(() => {
      svc.onVaultLocked();                      // the lock lands while the body is still arriving
      req.end(body.subarray(1000));
    }, 100);
  });
  const r = await res;
  svc.onVaultUnlocked();
  assert.deepStrictEqual([r.status, r.body.code], [423, 'VAULT_LOCKED']);
  assert.strictEqual(svc._queries.size, before, 'no query face was cached');
  // the same upload sent in one go after unlock works
  const ok = await fetch(base + '/api/faces/search-image', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body });
  assert.strictEqual(ok.status, 200);
});
