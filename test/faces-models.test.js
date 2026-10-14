/**
 * Face model upgrade (FACE_MODELS_SPEC): SFace grunt + AdaFace keeper (H1),
 * 512-d keeper vectors end to end, thresholds per keeper, the model
 * registry / consent / download per keeper, and the model switch job (H3):
 * progress persisted across a restart, pause / resume, lock and migrate
 * guards, the full re-check fallback, user data preserved, search during a
 * switch, named people first, going back.
 *
 * Runs on the stub engine (lib/faces/stub.js): createEngine({ backend:
 * 'stub', keeper }) answers 128-d "SFace" vectors for grouping and 512-d
 * keeper vectors (stub-ir50 / stub-ir101 spaces) for what is stored; without
 * a keeper it is stub-v1, the layout of libraries from before keepers.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-models-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;
fs.writeFileSync(process.env.VAULT_SETTINGS_FILE, JSON.stringify({ facesEnabled: true }));

const db = require('../lib/database');
const appSettings = require('../lib/app-settings');
const faces = require('../lib/faces/service');
const store = require('../lib/faces/store');
const models = require('../lib/faces/models');
const { thresholdFor, peopleThresholds, sameFileThreshold } = require('../lib/faces/thresholds');
const { createEngine } = require('../lib/faces/engine');
const { analyzeFile, analyzeFrame, CROPS_PER_GROUP } = require('../lib/faces/analyze');
const { stubKeeperEmbedding, stubEmbedding, stubFrame } = require('../lib/faces/stub');
const { createIndex } = require('../lib/faces/index-mem');
const { createFileModelStore } = require('../lib/faces/download');

const q = (sql, ...a) => db.get().prepare(sql).all(...a);
const one = (sql, ...a) => db.get().prepare(sql).get(...a);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const ALL_KEYS = ['face:detect', 'face:embed', 'face:keeper-ir50', 'face:keeper-ir101'];

/** A model store that knows keeper files (like production); `present` is mutable. */
function keyedStore(present) {
  return {
    present,
    entries: () => ALL_KEYS.map(key => ({ key, url: `https://example.test/${key}`, sha256: 'a'.repeat(64), size: 1, dest: path.join(tmp, 'm', key) })),
    status() {
      const paths = {}, reasons = {};
      for (const k of ALL_KEYS) { paths[k] = `/m/${k}`; if (!present.has(k)) reasons[k] = 'absent'; }
      const missing = Object.keys(reasons);
      return { ready: !missing.length, missing, reasons, paths };
    },
  };
}

/** Stub engines, every one remembered (to count keeper calls), with optional hooks. */
function engineMaker(hooks = {}) {
  const made = [];
  const factory = (o) => {
    const e = createEngine({ backend: 'stub', keeper: o.keeper });
    if (hooks.embedKeeper) {
      const orig = e.embedKeeper;
      e.embedKeeper = async (...a) => { await hooks.embedKeeper(e, a); return orig(...a); };
    }
    made.push(e);
    return e;
  };
  return { factory, made, keeperCalls: () => made.reduce((s, e) => s + e.calls.keeper, 0) };
}

let locked = false, migrating = false;
function makeService({ present, hooks, workers = 1 } = {}) {
  const ms = keyedStore(present || new Set(ALL_KEYS));
  const eng = engineMaker(hooks);
  const svc = faces.createService({
    modelStore: ms, engineFactory: eng.factory, fileExists: () => true,
    isVaultLocked: () => locked, isMigrateRunning: () => migrating,
    peopleDebounceMs: 60000, switchWorkers: workers, workers: 1, switchRetryMs: 20,
  });
  return { svc, ms, eng };
}

let mediaN = 0;
function addMedia(name, type = 'image', dur = null) {
  return Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)')
    .run(path.join(tmp, 'lib', `${++mediaN}`, name), name, type, dur).lastInsertRowid);
}

/** Index a file the way a library from before keepers did (SFace vectors, stub-v1). */
async function indexLegacy(mid) {
  const row = one('SELECT * FROM media WHERE id = ?', mid);
  const kind = store.kindOf(row);
  const e = createEngine({ backend: 'stub' });
  const r = await analyzeFile(e, { filepath: row.filepath, kind, durationS: row.duration_seconds || undefined }, { intervalS: 3.5, maxFrames: 2000 });
  store.saveFileResult(mid, 'stub-v1', r, { isVideo: kind === 'video', screenIntervalS: kind === 'video' ? 3.5 : null });
}

function resetLibrary() {
  store.deleteAllData();
  db.get().prepare('DELETE FROM media').run();
  db.get().prepare('DELETE FROM face_meta').run();
  db.get().prepare('DELETE FROM studio_people').run();
  db.get().prepare('DELETE FROM studios').run();
  appSettings.set({ facesModel: 'ir50' });
  locked = false; migrating = false;
}

test.before(() => { db.init(); });
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ---------------------------------------------------------------------------
// pipeline (H1)

test('H1: the keeper embeds only the exemplars of a video and every face of a photo; SFace does the rest', async () => {
  const e = createEngine({ backend: 'stub', keeper: 'ir50' });
  assert.deepStrictEqual([e.modelId, e.keeperIds], ['stub-ir50', ['stub-ir50', 'stub-ir101']]);
  const v = await analyzeFile(e, { filepath: '/v/clip_p1_p2@0-20_d60.mp4', kind: 'video' }, { intervalS: 3.5 });
  const exemplars = v.groups.flatMap(g => g.exemplars);
  assert.strictEqual(v.groups.length, 2);
  assert.ok(v.groups.every(g => g.exemplars.length >= 1 && g.exemplars.length <= 3));
  assert.strictEqual(e.calls.keeper, exemplars.length, 'keeper ran once per exemplar, not per face');
  assert.strictEqual(e.calls.embed, v.facesSeen, 'SFace ran on every face');
  assert.ok(v.facesSeen > exemplars.length * 3);
  for (const x of exemplars) {
    assert.strictEqual(x.embedding.length, 512);
    assert.ok(Number.isFinite(x.norm), 'the SFace norm is kept');
  }
  assert.ok(Math.abs(dot(v.groups[0].exemplars[0].embedding, stubKeeperEmbedding('stub-ir50', 1)) - 1) < 1e-5);
  assert.strictEqual(e.crops.size, 0, 'no crop stays in the worker after a file');

  const p = createEngine({ backend: 'stub', keeper: 'ir101' });
  const ph = await analyzeFile(p, { filepath: '/p/p1_p2_p3.jpg', kind: 'image' });
  assert.strictEqual(ph.groups.length, 3);
  assert.strictEqual(p.calls.keeper, 3, 'photos: every face');
  assert.ok(ph.groups.every(g => g.exemplars[0].embedding.length === 512));
  assert.ok(Math.abs(dot(ph.groups[0].exemplars[0].embedding, stubKeeperEmbedding('stub-ir101', 1)) - 1) < 1e-5);

  const old = createEngine({ backend: 'stub' });
  const ov = await analyzeFile(old, { filepath: '/v/clip_p1_d30.mp4', kind: 'video' }, { intervalS: 3.5 });
  assert.deepStrictEqual([old.modelId, old.calls.keeper, ov.groups[0].exemplars[0].embedding.length], ['stub-v1', 0, 128]);
});

test('H1: crops are capped per group while a long video plays, and freed after an abort', async () => {
  const e = createEngine({ backend: 'stub', keeper: 'ir50' });
  let most = 0;
  // 300 frames of the same two people in a dozen looks each.
  const r = await analyzeFile(e, { filepath: '/v/long_p1_p2_d300.mp4', kind: 'video' }, {
    intervalS: 1, onProgress: () => { most = Math.max(most, e.crops.size); },
  });
  assert.ok(most <= CROPS_PER_GROUP * 2, `crops held ${most}`);
  assert.strictEqual(e.crops.size, 0);
  assert.ok(r.groups.length >= 1);

  const ctrl = new AbortController();
  await assert.rejects(analyzeFile(e, { filepath: '/v/long_p1_d300.mp4', kind: 'video' }, {
    intervalS: 1, signal: ctrl.signal, onProgress: (pr) => { if (pr.framesChecked === 20) ctrl.abort(); },
  }), (err) => err.name === 'AbortError');
  assert.strictEqual(e.crops.size, 0, 'an aborted file leaves no crops');
});

test('H1: a frame can be embedded in several models at once (search during a switch)', async () => {
  const e = createEngine({ backend: 'stub', keeper: 'ir50' });
  const [f] = await analyzeFrame(e, stubFrame([4]), { models: ['stub-ir101', 'stub-v1', 'nope'] });
  assert.deepStrictEqual(Object.keys(f.embeddings).sort(), ['stub-ir101', 'stub-ir50', 'stub-v1']);
  assert.strictEqual(f.embedding, f.embeddings['stub-ir50']);
  assert.deepStrictEqual([f.embeddings['stub-ir101'].length, f.embeddings['stub-v1'].length], [512, 128]);
  assert.ok(Math.abs(dot(f.embeddings['stub-v1'], stubEmbedding(4)) - 1) < 1e-5);
});

// ---------------------------------------------------------------------------
// dimensions and thresholds

test('512-d vectors: store validates per model, the index and people sorting are dimension-agnostic', async () => {
  resetLibrary();
  const k = stubKeeperEmbedding('stub-ir50', 1);
  assert.strictEqual(store.decodeEmbedding(store.encodeEmbedding(k, 'stub-ir50')).length, 512);
  assert.throws(() => store.encodeEmbedding(stubEmbedding(1), 'stub-ir50'), /512/);
  assert.throws(() => store.encodeEmbedding(k, 'stub-v1'), /128/);
  assert.strictEqual(store.encodeEmbedding(k, 'some-other-model').length, 2048, 'unknown models take a known layout');
  assert.deepStrictEqual([models.embedDim('adaface-ir50-webface4m'), models.embedDim('adaface-ir101-webface12m'), models.embedDim('sface-2021dec')], [512, 512, 128]);

  // Nothing in the vector paths assumes a length.
  for (const f of ['index-mem.js', 'people-sort.js', 'candidates.js', 'people.js', 'store.js', 'model-switch.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'lib', 'faces', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\b(128|512)\b/.test(code), `${f} hard-codes a vector length`);
  }

  const { svc } = makeService();
  const a = addMedia('a_p1_p2.jpg'), b = addMedia('b_p1v3.jpg'), c = addMedia('c_p2.jpg');
  svc.enqueue({ ids: [a, b, c] });
  await svc.settled();
  assert.deepStrictEqual(q('SELECT DISTINCT faces_model AS m FROM media WHERE faces_model IS NOT NULL').map(r => r.m), ['stub-ir50']);
  assert.ok(q('SELECT LENGTH(embedding) AS n FROM face_vectors').every(r => r.n === 2048));
  await svc.sortPeopleNow();
  const pa = q('SELECT cluster_id AS c FROM face_groups WHERE media_id IN (?, ?) ORDER BY media_id, id', a, b).map(r => r.c);
  assert.strictEqual(pa[0], pa[2], 'p1 in a and p1 (another look) in b are one person in 512-d');
  const g1 = one('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', a).id;
  const res = svc.similarToGroup(g1, 'close');
  assert.deepStrictEqual(res.ids.sort(), [a, b].sort());
  const { faces: qf } = await svc.searchImage({ mediaId: c });
  const sim = svc.similarToQuery(qf[0].queryId, 'normal');
  assert.deepStrictEqual(sim.ids.sort(), [a, c].sort());
  assert.strictEqual(svc.status().counts.indexed, 3);
});

test('thresholds per keeper: every SFace number mapped by equal LFW false-accept rate', () => {
  const sface = models.matchThresholds('sface-2021dec');
  for (const id of ['adaface-ir50-webface4m', 'adaface-ir101-webface12m', 'stub-ir50', 'stub-ir101']) {
    const t = models.matchThresholds(id);
    assert.deepStrictEqual(Object.keys(t).sort(), Object.keys(sface).sort(), `${id} has every threshold`);
    assert.ok(t.close > t.normal && t.normal > t.wide, id);
    assert.ok(t.mightLikely > t.mightMaybe && t.suggest > t.close, id);
    assert.deepStrictEqual([t.dropNorm, t.startNorm], [sface.dropNorm, sface.startNorm], 'SFace norms stay the quality signal');
    assert.strictEqual(t.people, 0.35, 'owner decision');
  }
  assert.deepStrictEqual(['close', 'normal', 'wide'].map(w => thresholdFor(w, 'adaface-ir50-webface4m')), [0.341, 0.272, 0.211]);
  assert.deepStrictEqual(['close', 'normal', 'wide'].map(w => thresholdFor(w, 'adaface-ir101-webface12m')), [0.33, 0.247, 0.186]);
  assert.deepStrictEqual([sameFileThreshold('sface-2021dec'), sameFileThreshold('adaface-ir50-webface4m'), sameFileThreshold('adaface-ir101-webface12m')], [0.45, 0.302, 0.279]);
  assert.strictEqual(peopleThresholds('stub-ir101').suggest, 0.371);
  assert.strictEqual(thresholdFor('wide', 'stub-v1'), 0.36, 'the SFace layout keeps its numbers');
});

test('index: a file is scored in its current model; a query only in the old model still finds switched files', () => {
  resetLibrary();
  const a = addMedia('a.jpg'), b = addMedia('b.jpg');
  const g = (vec) => ({ appearances: 1, best: { bbox: [0.1, 0.1, 0.3, 0.3] }, exemplars: [{ embedding: vec, bbox: [0.1, 0.1, 0.3, 0.3], detScore: 0.9 }] });
  store.saveFileResult(a, 'stub-v1', { groups: [g(stubEmbedding(7))] });
  store.saveFileResult(b, 'stub-v1', { groups: [g(stubEmbedding(7, 2))] });
  // b moves to stub-ir50; its stub-v1 vector waits in face_vectors_prev.
  const snap = store.switchSnapshot(b);
  const gid = snap.groups[0].id;
  assert.ok(store.switchFileModel(b, 'stub-ir50', { expect: new Map([[gid, 'stub-v1']]),
    newVecs: new Map([[gid, [{ embedding: stubKeeperEmbedding('stub-ir50', 7, 2), bbox: [0.1, 0.1, 0.3, 0.3] }]]]) }));
  const idx = createIndex();
  const oldOnly = idx.queryMulti([{ modelId: 'stub-v1', vecs: [stubEmbedding(7)], threshold: 0.5 }], { withGroups: true });
  assert.deepStrictEqual(oldOnly.ids.sort(), [a, b].sort(), 'old-model query: both files (b through its waiting vector)');
  const both = idx.queryMulti([
    { modelId: 'stub-v1', vecs: [stubEmbedding(7)], threshold: 0.5 },
    { modelId: 'stub-ir50', vecs: [stubKeeperEmbedding('stub-ir50', 7)], threshold: 0.341 },
  ], { withGroups: true });
  assert.deepStrictEqual([...both.ids].sort(), [a, b].sort());
  assert.strictEqual(both.models[both.ids.indexOf(b)], 'stub-ir50', 'b scored in its current model');
  assert.strictEqual(both.models[both.ids.indexOf(a)], 'stub-v1');
  const newOnly = idx.queryMulti([{ modelId: 'stub-ir50', vecs: [stubKeeperEmbedding('stub-ir50', 7)], threshold: 0.341 }]);
  assert.deepStrictEqual(newOnly.ids, [b]);
});

test('re-check into another model carries names, locks, rejects and hidden faces over by position', () => {
  resetLibrary();
  const m = addMedia('v.mp4', 'video', 60);
  const box1 = [0.1, 0.2, 0.3, 0.4], box2 = [0.6, 0.2, 0.3, 0.4];
  const gr = (vec, box, t) => ({ appearances: 3, firstTimeS: t, best: { bbox: box, frameTimeS: t }, exemplars: [{ embedding: vec, bbox: box, frameTimeS: t, detScore: 0.9 }] });
  store.saveFileResult(m, 'stub-v1', { groups: [gr(stubEmbedding(1), box1, 3.5), gr(stubEmbedding(2), box2, 7)] }, { isVideo: true });
  const [g1, g2] = q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', m).map(r => r.id);
  const pid = Number(db.get().prepare("INSERT INTO face_people (name, name_key, created_at, updated_at) VALUES ('Ann', 'ann', 'x', 'x')").run().lastInsertRowid);
  const other = Number(db.get().prepare("INSERT INTO face_people (created_at, updated_at) VALUES ('x', 'x')").run().lastInsertRowid);
  db.get().prepare('UPDATE face_groups SET cluster_id = ?, person_locked = 1 WHERE id = ?').run(pid, g1);
  db.get().prepare('INSERT INTO face_person_rejects (person_id, group_id) VALUES (?, ?)').run(other, g1);
  store.hideGroup(g2, { notFace: true });
  // The same faces at the same frames, now in the keeper's space.
  store.saveFileResult(m, 'stub-ir50', { groups: [gr(stubKeeperEmbedding('stub-ir50', 1), box1, 3.5), gr(stubKeeperEmbedding('stub-ir50', 2), box2, 7)] }, { isVideo: true });
  const rows = q('SELECT id, cluster_id, person_locked, hidden, not_face, model FROM face_groups WHERE media_id = ? ORDER BY id', m);
  assert.deepStrictEqual(rows.map(r => [r.cluster_id, r.person_locked, r.hidden, r.not_face, r.model]),
    [[pid, 1, 0, 0, 'stub-ir50'], [null, 0, 1, 1, 'stub-ir50']]);
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_person_rejects WHERE person_id = ? AND group_id = ?', other, rows[0].id).n, 1);
});

// ---------------------------------------------------------------------------
// models, consent, download per keeper

test('a library from before keepers keeps working until its keeper is downloaded; a fresh one needs it', async () => {
  resetLibrary();
  const present = new Set(['face:detect', 'face:embed']);
  const { svc } = makeService({ present });
  let s = svc.status();
  assert.deepStrictEqual([s.modelsReady, s.missing, s.facesModel, s.needsModel], [false, ['face:keeper-ir50'], 'ir50', 'ir50']);
  assert.deepStrictEqual([s.faceModels.ir50.present, s.faceModels.ir101.present], [false, false]);
  const a = addMedia('a_p1.jpg');
  await indexLegacy(a);
  s = svc.status();
  assert.deepStrictEqual([s.modelsReady, s.missing, s.activeModel, s.needsModel, s.modelSwitch], [true, [], 'stub-v1', 'ir50', null]);
  assert.strictEqual(svc.fileFaces(a).indexed, true);
  // IR-101 chosen but not downloaded, IR-50 on disk: a library from before
  // keepers waits for IR-101 (no double re-read)...
  present.add('face:keeper-ir50');
  appSettings.set({ facesModel: 'ir101' });
  s = svc.status();
  assert.deepStrictEqual([s.activeModel, s.needsModel], ['stub-v1', 'ir101']);
  // ...a library already in IR-50 keeps using IR-50 until IR-101 is there.
  const b = addMedia('b_p2.jpg');
  store.saveFileResult(b, 'stub-ir50', { groups: [{ appearances: 1, best: { bbox: [0, 0, 0.5, 0.5] },
    exemplars: [{ embedding: stubKeeperEmbedding('stub-ir50', 2), bbox: [0, 0, 0.5, 0.5] }] }] });
  s = svc.status();
  assert.deepStrictEqual([s.activeModel, s.needsModel], ['stub-ir50', 'ir101'], 'the other keeper serves until ir101 is downloaded');
});

test('download per keeper: consent per key, only the chosen keeper is fetched, then the switch starts', async (t) => {
  resetLibrary();
  const config = require('../config');
  const prev = [config.net.offline, config.subtitles.allowModelDownload];
  config.net.offline = false;
  config.subtitles.allowModelDownload = true;
  t.after(() => { [config.net.offline, config.subtitles.allowModelDownload] = prev; });
  const dir = path.join(tmp, 'dl');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = Object.fromEntries(ALL_KEYS.map(k => [k, Buffer.from(`bytes of ${k}`)]));
  const entries = ALL_KEYS.map(key => ({ key, url: `https://huggingface.co/x/${key.replace(':', '_')}.onnx`,
    sha256: crypto.createHash('sha256').update(bytes[key]).digest('hex'), size: bytes[key].length, dest: path.join(dir, key.replace(':', '_')) }));
  for (const key of ['face:detect', 'face:embed']) fs.writeFileSync(entries.find(e => e.key === key).dest, bytes[key]);
  const granted = new Set(['face:detect', 'face:embed']);
  const asked = [];
  const consent = { ENV_ALLOWS: true, isAllowed: (k) => granted.has(k), request: (k) => { asked.push(k); return false; } };
  const fetched = [];
  const fetchImpl = async (url) => { fetched.push(url); const key = ALL_KEYS.find(k => url.includes(k.replace(':', '_'))); return new Response(bytes[key], { status: 200 }); };
  const eng = engineMaker();
  const svc = faces.createService({ modelStore: createFileModelStore(() => entries), consent, fetchImpl,
    engineFactory: eng.factory, fileExists: () => true, peopleDebounceMs: 60000, switchWorkers: 1 });
  const a = addMedia('a_p1.jpg');
  await indexLegacy(a);
  assert.strictEqual(svc.status().needsModel, 'ir50');

  await assert.rejects(Promise.resolve().then(() => svc.startDownload({ model: 'ir101' })), (e) => e.code === 'CONSENT_NEEDED' && e.keys.join() === 'face:keeper-ir101');
  await assert.rejects(Promise.resolve().then(() => svc.startDownload({})), (e) => e.code === 'CONSENT_NEEDED' && e.keys.join() === 'face:keeper-ir50');
  assert.deepStrictEqual(asked, ['face:keeper-ir101', 'face:keeper-ir50']);
  assert.throws(() => svc.startDownload({ model: 'ir7' }), (e) => e.code === 'BAD_SETTING');
  granted.add('face:keeper-ir50');
  svc.startDownload({});
  assert.strictEqual(svc.status().faceModels.ir50.downloading, true);
  await svc.downloadSettled();
  assert.deepStrictEqual(fetched, [entries[2].url], 'only the IR-50 file');
  let s = svc.status();
  assert.deepStrictEqual([s.modelsReady, s.activeModel, s.needsModel, s.faceModels.ir50.present, s.faceModels.ir101.present, s.faceModels.ir50.consent],
    [true, 'stub-ir50', null, true, false, true]);
  await svc.modelSwitchSettled();
  assert.strictEqual(one('SELECT faces_model AS m FROM media WHERE id = ?', a).m, 'stub-ir50', 'the download started the switch, which finished');
  s = svc.status();
  assert.strictEqual(s.modelSwitch, null);
  assert.deepStrictEqual([s.lastModelSwitch.from, s.lastModelSwitch.to, s.lastModelSwitch.files], ['stub-v1', 'stub-ir50', 1]);
});

// ---------------------------------------------------------------------------
// the switch job

/** A small legacy library with user work on it. */
async function legacyLibrary(svc) {
  const files = {
    named: addMedia('named_p1_p2.jpg'),
    v1: addMedia('v1_p1_p3@20-60_d60.mp4', 'video', 60),
    v2: addMedia('v2_p2_p4_d40.mp4', 'video', 40),
    fav: addMedia('fav_p5.jpg'),
    m1: addMedia('m1_p6.jpg'),
    m2: addMedia('m2_p7.jpg'),
    hid: addMedia('hid_p8_p9.jpg'),
    plain: addMedia('plain_p10.jpg'),
    plain2: addMedia('plain2_p10v2.jpg'),
  };
  for (const id of Object.values(files)) await indexLegacy(id);
  await svc.sortPeopleNow();
  const pidOf = (mid, i = 0) => q('SELECT cluster_id AS c FROM face_groups WHERE media_id = ? ORDER BY id', mid)[i].c;
  const ann = pidOf(files.named, 0);
  svc.updatePerson(ann, { name: 'Ann' });
  svc.updatePerson(pidOf(files.fav), { favorite: true });
  const merged = svc.mergePeople({ ids: [pidOf(files.m1), pidOf(files.m2)], into: pidOf(files.m1) });
  // "Not this person": p3 of v1 out of Ann (rejects recorded), if it is there; else put it there first.
  const v1Groups = q('SELECT id, cluster_id FROM face_groups WHERE media_id = ? ORDER BY id', files.v1);
  db.get().prepare('INSERT OR IGNORE INTO face_person_rejects (person_id, group_id) VALUES (?, ?)').run(ann, v1Groups[1].id);
  const [h1, h2] = q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', files.hid).map(r => r.id);
  svc.hideGroup(h1);
  svc.notFaceGroup(h2);
  const studio = Number(db.get().prepare("INSERT INTO studios (name, name_key, created_at, updated_at) VALUES ('S', 's', 'x', 'x')").run().lastInsertRowid);
  db.get().prepare("INSERT INTO studio_people (studio_id, person_id, created_at) VALUES (?, ?, 'x')").run(studio, pidOf(files.v2, 1));
  return { files, ann, merged: merged.id };
}

/** Everything the user did, as data (group ids included: they must not change). */
function userSnapshot() {
  return JSON.stringify({
    groups: q('SELECT id, media_id, cluster_id, person_locked, hidden, not_face FROM face_groups WHERE cluster_id IN (SELECT id FROM face_people WHERE name IS NOT NULL OR favorite = 1) OR person_locked = 1 OR hidden = 1 ORDER BY id'),
    people: q('SELECT id, name, favorite, hidden FROM face_people WHERE name IS NOT NULL OR favorite = 1 ORDER BY id'),
    rejects: q('SELECT * FROM face_person_rejects ORDER BY person_id, group_id'),
    decisions: q('SELECT * FROM face_pair_decisions ORDER BY a, b'),
    studios: q('SELECT studio_id, person_id FROM studio_people ORDER BY person_id'),
    allGroupIds: q('SELECT id FROM face_groups ORDER BY id').map(r => r.id),
  });
}

test('switch SFace -> IR-50: named first, user work untouched, vectors re-read, people sorted again', async () => {
  resetLibrary();
  const present = new Set(['face:detect', 'face:embed']);
  const order = [];
  const { svc, eng } = makeService({ present, hooks: { embedKeeper: async (e, a) => { order.push(a[0]); } } });
  const { files, ann } = await legacyLibrary(svc);
  const before = userSnapshot();
  const autoBefore = one('SELECT COUNT(*) AS n FROM face_people WHERE name IS NULL AND favorite = 0').n;
  db.get().prepare("INSERT OR REPLACE INTO face_meta (key, value) VALUES ('suggest_rule', 'x')").run();
  const seen = [];
  const orig = store.switchFileModel;
  store.switchFileModel = (mid, ...rest) => { seen.push(mid); return orig(mid, ...rest); };
  try {
    present.add('face:keeper-ir50');
    svc.scheduleModelSwitch();
    await svc.modelSwitchSettled();
  } finally { store.switchFileModel = orig; }
  assert.deepStrictEqual(seen.slice(0, 2), [files.named, files.v1], 'files with a named face first');
  assert.strictEqual(seen[2], files.fav, 'then a favorite\'s');
  assert.deepStrictEqual(q('SELECT DISTINCT faces_model AS m FROM media').map(r => r.m), ['stub-ir50']);
  assert.deepStrictEqual(q('SELECT DISTINCT model FROM face_groups').map(r => r.model), ['stub-ir50']);
  assert.ok(q('SELECT LENGTH(embedding) AS n FROM face_vectors').every(r => r.n === 2048));
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_vectors_prev').n, 0, 'old vectors gone at the end');
  // The re-read vector equals a fresh index of the same face.
  const annVec = store.groupVectors(q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', files.named)[0].id)[0];
  assert.ok(Math.abs(dot(annVec, stubKeeperEmbedding('stub-ir50', 1)) - 1) < 1e-5);
  // User work: same group ids, names, merges, rejects, hidden / not-a-face, studios.
  const after = JSON.parse(userSnapshot()), b = JSON.parse(before);
  assert.deepStrictEqual(after.allGroupIds, b.allGroupIds, 'no group was re-created');
  assert.deepStrictEqual(after.people, b.people);
  assert.deepStrictEqual(after.rejects, b.rejects);
  assert.deepStrictEqual(after.studios, b.studios);
  for (const g of b.groups) {
    const a = after.groups.find(x => x.id === g.id);
    assert.deepStrictEqual(a, g, `group ${g.id} kept its person, lock and hide marks`);
  }
  assert.ok(eng.keeperCalls() > 0);
  // Re-sort: untouched automatic people were dissolved and sorted again; pairs scored again.
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'suggest_rule'"), undefined);
  await svc.sortPeopleNow();
  assert.ok(one('SELECT COUNT(*) AS n FROM face_people WHERE name IS NULL AND favorite = 0').n > 0);
  assert.ok(autoBefore > 0);
  assert.strictEqual(one('SELECT name FROM face_people WHERE id = ?', ann).name, 'Ann');
  const last = svc.status().lastModelSwitch;
  assert.deepStrictEqual([last.from, last.to, last.files, last.fallbacks, last.failed], ['stub-v1', 'stub-ir50', 9, 0, 0]);
});

test('switch: pause, progress kept across a restart, search and file faces in both models meanwhile, resume', async () => {
  resetLibrary();
  const present = new Set(['face:detect', 'face:embed']);
  let pauseAt = 3, svcRef = null;
  const { svc } = makeService({ present, hooks: {} });
  svcRef = svc;
  const { files } = await legacyLibrary(svc);
  const orig = store.switchFileModel;
  let n = 0;
  store.switchFileModel = (...a) => { const r = orig(...a); if (++n === pauseAt) svcRef.pauseModelSwitch(); return r; };
  try {
    present.add('face:keeper-ir50');
    svc.scheduleModelSwitch();
    await svc.modelSwitchSettled();
  } finally { store.switchFileModel = orig; }
  let ms = svc.status().modelSwitch;
  assert.deepStrictEqual([ms.from, ms.to, ms.done, ms.total, ms.paused], ['stub-v1', 'stub-ir50', 3, 9, true]);
  assert.deepStrictEqual([ms.namedDone, ms.namedTotal], [1, 1], 'Ann is fully re-read already');
  assert.deepStrictEqual(svc.queueStatus().modelSwitch.done, 3, 'the scan panel sees it too');
  assert.deepStrictEqual(new Set(q('SELECT faces_model AS m FROM media').map(r => r.m)), new Set(['stub-v1', 'stub-ir50']));
  assert.ok(one('SELECT COUNT(*) AS n FROM face_vectors_prev').n > 0);
  // Both models serve meanwhile.
  assert.strictEqual(svc.status().counts.indexed, 9);
  assert.strictEqual(svc.fileFaces(files.plain).indexed, true, 'a file not re-read yet still shows its faces');
  assert.strictEqual(svc.fileFaces(files.named).indexed, true);
  // p10 is in plain (old model) and plain2 (old model); p1 in named (new) and v1 (new, named tier).
  const { faces: qf } = await svc.searchImage({ mediaId: files.plain2 });
  assert.deepStrictEqual(svc.similarToQuery(qf[0].queryId, 'normal').ids.sort(), [files.plain, files.plain2].sort());
  const { faces: q1 } = await svc.searchImage({ mediaId: files.named });
  const p1 = svc.similarToQuery(q1[0].queryId, 'normal');
  assert.deepStrictEqual(p1.ids.sort(), [files.named, files.v1].sort());
  // A face of an old-model file finds a switched file (through its waiting old vectors), and back.
  const oldG = q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', files.v2)[0].id;   // p2, old model
  assert.ok(svc.similarToGroup(oldG, 'normal').ids.includes(files.named), 'old-model p2 finds named (new model)');
  const newG = q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', files.named)[1].id; // p2, new model
  assert.ok(svc.similarToGroup(newG, 'normal').ids.includes(files.v2), 'new-model p2 finds v2 (old model)');
  // Not re-queued by "find faces in everything": the switch handles them.
  assert.strictEqual(svc.enqueue({ all: true }).added, 0);

  // Restart: a new service on the same library sees the same progress, still paused.
  const { svc: svc2 } = makeService({ present });
  ms = svc2.status().modelSwitch;
  assert.deepStrictEqual([ms.done, ms.total, ms.paused], [3, 9, true]);
  svc2.scheduleModelSwitch();
  await svc2.modelSwitchSettled();
  assert.strictEqual(svc2.status().modelSwitch.done, 3, 'paused survives a restart');
  svc2.resumeModelSwitch();
  await svc2.modelSwitchSettled();
  assert.strictEqual(svc2.status().modelSwitch, null);
  assert.deepStrictEqual(q('SELECT DISTINCT faces_model AS m FROM media').map(r => r.m), ['stub-ir50']);
});

test('switch: a vault lock stops it with nothing written after the lock; a migrate defers it; unlock resumes', async () => {
  resetLibrary();
  const present = new Set(['face:detect', 'face:embed']);
  let gate = null, release = null;
  let svcRef = null;
  const { svc } = makeService({ present, hooks: { embedKeeper: async () => { if (gate) { const g = gate; gate = null; release(); await g; } } } });
  svcRef = svc;
  await legacyLibrary(svc);
  migrating = true;
  present.add('face:keeper-ir50');
  svc.scheduleModelSwitch();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM media WHERE faces_model = 'stub-ir50'").n, 0, 'nothing while a migrate runs');
  assert.throws(() => svc.resumeModelSwitch(), (e) => e.code === 'MIGRATE_RUNNING');
  migrating = false;

  let open;
  gate = new Promise(r => { open = r; });
  const blocked = new Promise(r => { release = r; });
  svc.scheduleModelSwitch();
  await blocked;                                   // the first file is inside the keeper
  locked = true;
  svcRef.onVaultLocked();
  open();
  await svc.modelSwitchSettled();
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM media WHERE faces_model = 'stub-ir50'").n, 0, 'the file in flight wrote nothing');
  assert.ok(svc.status().modelSwitch.total === 9);
  locked = false;
  svc.onVaultUnlocked();
  await new Promise(r => setTimeout(r, 20));
  await svc.modelSwitchSettled();
  assert.deepStrictEqual(q('SELECT DISTINCT faces_model AS m FROM media').map(r => r.m), ['stub-ir50']);
});

test('switch: a face that cannot be found again sends its file to a full re-check (names carried over by position)', async () => {
  resetLibrary();
  const present = new Set(['face:detect', 'face:embed']);
  const { svc } = makeService({ present });
  const { files, ann } = await legacyLibrary(svc);
  // v2's first exemplar row is moved off its face (as if the file changed); its other faces still match.
  const g = q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', files.v2)[0].id;
  db.get().prepare("UPDATE face_vectors SET bbox = '[0.9,0.9,0.05,0.05]' WHERE group_id = ?").run(g);
  const annGroupsBefore = q('SELECT id FROM face_groups WHERE cluster_id = ? ORDER BY id', ann).map(r => r.id);
  present.add('face:keeper-ir50');
  svc.scheduleModelSwitch();
  await svc.modelSwitchSettled();
  const last = svc.status().lastModelSwitch;
  assert.deepStrictEqual([last.fallbacks, last.failed, last.files], [1, 0, 9]);
  assert.strictEqual(one('SELECT faces_model AS m FROM media WHERE id = ?', files.v2).m, 'stub-ir50');
  assert.ok(!q('SELECT id FROM face_groups WHERE media_id = ?', files.v2).some(r => r.id === g), 'v2 was checked again (new groups)');
  assert.ok(q('SELECT LENGTH(embedding) AS n FROM face_vectors WHERE media_id = ?', files.v2).every(r => r.n === 2048));
  assert.deepStrictEqual(q('SELECT id FROM face_groups WHERE cluster_id = ? ORDER BY id', ann).map(r => r.id), annGroupsBefore,
    'Ann (not in v2) untouched');
});

test('switch: a file that cannot be read stays in its old model, still served; the switch still ends', async () => {
  resetLibrary();
  const present = new Set(['face:detect', 'face:embed']);
  const ms = keyedStore(present);
  const eng = engineMaker();
  let missing = null;
  const svc = faces.createService({ modelStore: ms, engineFactory: eng.factory, fileExists: (p) => p !== missing,
    isVaultLocked: () => false, isMigrateRunning: () => false, peopleDebounceMs: 60000, switchWorkers: 2 });
  const { files } = await legacyLibrary(svc);
  missing = one('SELECT filepath FROM media WHERE id = ?', files.plain).filepath;
  present.add('face:keeper-ir50');
  svc.scheduleModelSwitch();
  await svc.modelSwitchSettled();
  assert.strictEqual(one('SELECT faces_model AS m FROM media WHERE id = ?', files.plain).m, 'stub-v1');
  const s = svc.status();
  assert.deepStrictEqual([s.modelSwitch, s.lastModelSwitch.failed], [null, 1]);
  assert.strictEqual(svc.fileFaces(files.plain).indexed, true, 'still listed in its old model');
  assert.strictEqual(s.counts.indexed, 9);
});

test('switch IR-50 -> IR-101 and back before it ends: the way back swaps vectors without the engine', async () => {
  resetLibrary();
  const present = new Set(ALL_KEYS);
  const { svc, eng } = makeService({ present });
  const a = addMedia('a_p1_p2.jpg'), b = addMedia('b_p3.jpg'), c = addMedia('c_p1v2.jpg'), d = addMedia('d_p4.jpg');
  svc.enqueue({ all: true });
  await svc.settled();
  await svc.sortPeopleNow();
  svc.updatePerson(q('SELECT cluster_id AS c FROM face_groups WHERE media_id = ? ORDER BY id', a)[0].c, { name: 'Bo' });
  const vecBefore = store.groupVectors(q('SELECT id FROM face_groups WHERE media_id = ?', b)[0].id)[0];
  const orig = store.switchFileModel;
  let n = 0;
  store.switchFileModel = (...x) => { const r = orig(...x); if (++n === 2) svc.pauseModelSwitch(); return r; };
  try {
    svc.updateSettings({ model: 'ir101' });
    await svc.modelSwitchSettled();
  } finally { store.switchFileModel = orig; }
  assert.strictEqual(svc.status().activeModel, 'stub-ir101');
  assert.strictEqual(svc.status().modelSwitch.done, 2);
  const keeperBefore = eng.keeperCalls();
  svc.updateSettings({ model: 'ir50' });          // go back: a new choice starts its own (unpaused) switch
  await svc.modelSwitchSettled();
  assert.deepStrictEqual(q('SELECT DISTINCT faces_model AS m FROM media').map(r => r.m), ['stub-ir50']);
  assert.strictEqual(eng.keeperCalls(), keeperBefore, 'the two re-read files came back from their waiting vectors');
  assert.strictEqual(svc.status().lastModelSwitch.swapped, 2);
  const vecAfter = store.groupVectors(q('SELECT id FROM face_groups WHERE media_id = ?', b)[0].id)[0];
  assert.ok(Math.abs(dot(vecAfter, vecBefore) - 1) < 1e-6);
  assert.strictEqual(one("SELECT COUNT(*) AS n FROM face_people WHERE name = 'Bo'").n, 1);
  assert.ok([a, c, d].every(id => one('SELECT faces_model AS m FROM media WHERE id = ?', id).m === 'stub-ir50'));
});

test('settings and routes: facesModel validated, status and pause/resume over HTTP', async (t) => {
  resetLibrary();
  const { app } = require('../server/index');
  const present = new Set(['face:detect', 'face:embed']);
  const { svc } = makeService({ present });
  faces.setInstance(svc);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => { const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
  let r = await post('/api/faces/settings', { model: 'ir7' });
  assert.deepStrictEqual([r.status, r.body.code], [400, 'BAD_SETTING']);
  r = await post('/api/faces/settings', { model: 'ir101' });
  assert.deepStrictEqual([r.status, r.body.facesModel, r.body.needsModel], [200, 'ir101', 'ir101']);
  await post('/api/faces/settings', { model: 'ir50' });
  const a = addMedia('a_p1.jpg'), b = addMedia('b_p2.jpg');
  await indexLegacy(a); await indexLegacy(b);
  svc.scheduleModelSwitch();
  await svc.modelSwitchSettled();
  // Start a switch and pause it before it moves (pause right after it is created).
  const orig = store.setMeta;
  store.setMeta = (k, v) => { orig(k, v); if (k === 'model_switch' && v && !JSON.parse(v).paused) { store.setMeta = orig; svc.pauseModelSwitch(); } };
  present.add('face:keeper-ir50');
  svc.scheduleModelSwitch();
  await svc.modelSwitchSettled();
  store.setMeta = orig;
  const st = await (await fetch(base + '/api/faces/status')).json();
  assert.deepStrictEqual([st.modelSwitch.done, st.modelSwitch.total, st.modelSwitch.paused], [0, 2, true]);
  r = await post('/api/faces/model-switch/resume');
  assert.strictEqual(r.status, 200);
  await svc.modelSwitchSettled();
  r = await (await fetch(base + '/api/faces/status')).json();
  assert.deepStrictEqual([r.modelSwitch, r.lastModelSwitch.files, r.activeModel], [null, 2, 'stub-ir50']);
  r = await post('/api/faces/model-switch/pause');
  assert.strictEqual(r.status, 200, 'pausing with no switch is harmless');
});
