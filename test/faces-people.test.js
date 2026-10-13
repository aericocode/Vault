/**
 * People across the library (FACES_PEOPLE_SPEC sections 1 to 3, 5 and 9):
 * the sorting job, the user's corrections, re-check carry-over, stats,
 * cleanup, settings, and the shape of every /api/faces/people* and
 * /api/faces/review route over HTTP against the real Express app. The engine
 * is the stub from helpers/faces-fakes.js (no models, no network).
 *
 * Library (embeddings from basis vectors, see the fakes):
 *   a1.jpg   person 0
 *   b1.jpg   person 1
 *   ab.jpg   person 0 and person 1
 *   v1.mp4   person 0 (10 appearances from 4 s) and person 2 (3 appearances), 100 s
 *   v2.mp4   person 2 (4 appearances), 60 s
 *   near.jpg a face at cosine 0.49 to person 0 (a "Same person?" suggestion)
 *   c1.jpg   person 3
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-people-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const faces = require('../lib/faces/service');
const store = require('../lib/faces/store');
const { createSorter } = require('../lib/faces/people-sort');
const { THRESHOLDS, peopleThresholds } = require('../lib/faces/thresholds');
const { app } = require('../server/index');
const { person, like, group, createFakes, DIM } = require('./helpers/faces-fakes');

const fk = createFakes();
let locked = false;
let migrating = false;
const svc = faces.setInstance(faces.createService({
  modelStore: fk.modelStore, engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames,
  isVaultLocked: () => locked, isMigrateRunning: () => migrating, peopleDebounceMs: 40,
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
const q = (sql, ...a) => db.get().prepare(sql).all(...a);
const one = (sql, ...a) => db.get().prepare(sql).get(...a);

/** Index (or force re-check) files and wait for the queue and the sorting job. */
async function index(names, { force = false } = {}) {
  const r = await post('/api/faces/index', { ids: names.map(n => ids[n]), force });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await svc.settled();
  await svc.sortPeopleNow();
}

/** Person id of the (first) face group in a file that is closest to basis person i. */
function personIn(name, i) {
  const rows = q('SELECT g.id, g.cluster_id FROM face_groups g WHERE g.media_id = ? ORDER BY g.id', ids[name]);
  let best = null, bs = -2;
  for (const r of rows) {
    const v = store.groupVectors(r.id)[0];
    if (v[i] > bs) { bs = v[i]; best = r.cluster_id; }
  }
  return best;
}

const fileNamesOf = (pid) => q(`SELECT DISTINCT m.filename AS f FROM face_groups g JOIN media m ON m.id = g.media_id
  WHERE g.cluster_id = ? ORDER BY m.filename`, pid).map(r => r.f);

/** The current partition of groups into people, as sorted arrays of "file#k" labels. */
function partition() {
  const by = new Map();
  for (const r of q(`SELECT g.id, g.cluster_id, m.filename FROM face_groups g JOIN media m ON m.id = g.media_id ORDER BY g.id`)) {
    if (!by.has(r.cluster_id)) by.set(r.cluster_id, []);
    by.get(r.cluster_id).push(`${r.filename}#${r.id}`);
  }
  return [...by.values()].map(a => a.sort().join(',')).sort();
}

const ITEM_KEYS = ['addedAt', 'coverUrl', 'favorite', 'files', 'hidden', 'id', 'name', 'photos', 'screenS', 'videos'];

test.before(async () => {
  db.init();
  addFile('a1.jpg', 'image');
  addFile('b1.jpg', 'image');
  addFile('ab.jpg', 'image');
  addFile('v1.mp4', 'video', { duration: 100 });
  addFile('v2.mp4', 'video', { duration: 60 });
  addFile('near.jpg', 'image');
  addFile('c1.jpg', 'image');
  fk.fileScripts.set(files['a1.jpg'], { groups: [group(person(0))] });
  fk.fileScripts.set(files['b1.jpg'], { groups: [group(person(1))] });
  fk.fileScripts.set(files['ab.jpg'], { groups: [group(like(0, 0.9, 101)), group(like(1, 0.9, 102))] });
  fk.fileScripts.set(files['v1.mp4'], { groups: [
    group([like(0, 0.95, 103), like(0, 0.9, 104)], { appearances: 10, firstTimeS: 4 }),
    group(person(2), { appearances: 3, firstTimeS: 50 }),
  ] });
  fk.fileScripts.set(files['v2.mp4'], { groups: [group(like(2, 0.9, 105), { appearances: 4, firstTimeS: 1 })] });
  fk.fileScripts.set(files['near.jpg'], { groups: [group(like(0, 0.49, 106))] });
  fk.fileScripts.set(files['c1.jpg'], { groups: [group(person(3))] });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  svc.cancel();
  await svc.settled();
  await svc.peopleSettled();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('thresholds: people 0.50, the 0.46 suggestion floor, norm and might-be bands live with the search widths', () => {
  assert.strictEqual(THRESHOLDS.people, 0.5);
  assert.strictEqual(THRESHOLDS.suggest, 0.46);
  const all = { people: 0.5, suggest: 0.46, dropNorm: 7, startNorm: 9, mightLikely: 0.56, mightMargin: 0.05, mightMaybe: 0.48 };
  assert.deepStrictEqual(peopleThresholds('sface-2021dec'), all);
  assert.deepStrictEqual(peopleThresholds('unknown-model'), all);
});

test('feature off: every people route is FACES_OFF', async () => {
  for (const [method, p] of [['GET', '/api/faces/people'], ['GET', '/api/faces/people/1'], ['GET', '/api/faces/people/1/files'],
    ['GET', '/api/faces/people/1/faces'], ['POST', '/api/faces/people/1'], ['POST', '/api/faces/people/merge'],
    ['POST', '/api/faces/people/1/not-in'], ['GET', '/api/faces/review'], ['POST', '/api/faces/review']]) {
    const r = await fetch(base + p, method === 'POST' ? json({}) : {});
    assert.strictEqual(r.status, 409, p);
    assert.strictEqual((await r.json()).code, 'FACES_OFF', p);
  }
  const s = await get('/api/faces/status');
  assert.deepStrictEqual(s.body.people, { sorting: false, pending: 0, total: 0 });
});

test('settings: intervalS 0.5 to 120 in steps of 0.5, maxFrames 100 to 20000, both in status and used', async () => {
  for (const v of [0.25, 0.7, 120.5, 0, -1, '2', NaN, null, true]) {
    const r = await post('/api/faces/settings', { intervalS: v });
    assert.strictEqual(r.status, 400, `intervalS ${v}`);
    assert.strictEqual(r.body.code, 'BAD_SETTING');
  }
  for (const v of [99, 20001, 100.5, '200', null, 0]) {
    const r = await post('/api/faces/settings', { maxFrames: v });
    assert.strictEqual(r.status, 400, `maxFrames ${v}`);
    assert.strictEqual(r.body.code, 'BAD_SETTING');
  }
  for (const v of [0.5, 120, 7.5]) {
    const r = await post('/api/faces/settings', { intervalS: v });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.intervalS, v);
  }
  for (const v of [100, 20000, 1234]) {
    const r = await post('/api/faces/settings', { maxFrames: v });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.maxFrames, v);
  }
  const saved = JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8'));
  assert.strictEqual(saved.facesIntervalS, 7.5);
  assert.strictEqual(saved.facesMaxFrames, 1234);
  // A hand-edited bad value reads as the default
  fs.writeFileSync(process.env.VAULT_SETTINGS_FILE, JSON.stringify({ ...saved, facesIntervalS: 0.3, facesMaxFrames: 5 }));
  let s = (await get('/api/faces/status')).body;
  assert.strictEqual(s.intervalS, 3.5);
  assert.strictEqual(s.maxFrames, 2000);

  // Used for files checked from now on: analyzeFile gets both, and screen time
  // per group = appearances x the spacing used (a long video spreads maxFrames).
  await post('/api/faces/settings', { enabled: true, intervalS: 2, maxFrames: 100 });
  const long = addFile('long.mp4', 'video', { duration: 1000 });
  fk.fileScripts.set(files['long.mp4'], { groups: [group(person(40), { appearances: 5, firstTimeS: 10 })] });
  await index(['long.mp4']);
  const call = fk.calls.analyzeFile.at(-1);
  assert.deepStrictEqual([call.opts.intervalS, call.opts.maxFrames], [2, 100]);
  assert.strictEqual(one('SELECT screen_s FROM face_groups WHERE media_id = ?', long).screen_s, 50);   // 5 x max(2, 1000/100)
  db.deleteRecords([long]);
  // back to the defaults for the rest of the suite
  s = (await post('/api/faces/settings', { intervalS: 3.5, maxFrames: 2000 })).body;
  assert.deepStrictEqual([s.intervalS, s.maxFrames], [3.5, 2000]);
});

test('sorting: same person across files joins, strangers start new people, photos get no screen time', async () => {
  const before = (await get('/api/faces/status')).body.people;
  assert.strictEqual(before.total, 0);
  const r = await post('/api/faces/index', { ids: ['a1.jpg', 'b1.jpg', 'ab.jpg', 'v1.mp4', 'v2.mp4', 'near.jpg', 'c1.jpg'].map(n => ids[n]) });
  assert.strictEqual(r.status, 200);
  await svc.settled();
  await svc.sortPeopleNow();
  const s = (await get('/api/faces/status')).body.people;
  assert.deepStrictEqual(s, { sorting: false, pending: 0, total: 5 });

  const alice = personIn('a1.jpg', 0);
  assert.ok(alice);
  assert.deepStrictEqual(fileNamesOf(alice), ['a1.jpg', 'ab.jpg', 'v1.mp4']);
  assert.deepStrictEqual(fileNamesOf(personIn('b1.jpg', 1)), ['ab.jpg', 'b1.jpg']);
  assert.deepStrictEqual(fileNamesOf(personIn('v1.mp4', 2)), ['v1.mp4', 'v2.mp4']);
  assert.deepStrictEqual(fileNamesOf(personIn('near.jpg', 0)), ['near.jpg']);   // 0.49: not joined
  assert.deepStrictEqual(fileNamesOf(personIn('c1.jpg', 3)), ['c1.jpg']);
  assert.strictEqual(one('SELECT screen_s FROM face_groups WHERE media_id = ?', ids['a1.jpg']).screen_s, null);
  assert.deepStrictEqual(q('SELECT screen_s FROM face_groups WHERE media_id = ? ORDER BY appearances DESC', ids['v1.mp4']).map(r => r.screen_s), [35, 10.5]);
  // automatic sorting never locks
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_groups WHERE person_locked = 1').n, 0);
});

test('sorting is deterministic: wiping the people and sorting again gives the same people', async () => {
  const first = partition();
  db.get().exec('UPDATE face_groups SET cluster_id = NULL; DELETE FROM face_people; DELETE FROM face_person_suggestions;');
  store.bumpPeople();
  assert.strictEqual((await get('/api/faces/status')).body.people.pending, q('SELECT id FROM face_groups').length);
  await svc.sortPeopleNow();
  assert.deepStrictEqual(partition(), first);
});

test('starts by itself: after indexing, and on start-up for faces found before people existed', async () => {
  const id = addFile('auto.jpg', 'image');
  fk.fileScripts.set(files['auto.jpg'], { groups: [group(like(3, 0.9, 107))] });
  await post('/api/faces/index', { ids: [id] });
  await svc.settled();
  const deadline = Date.now() + 3000;
  while (one('SELECT cluster_id FROM face_groups WHERE media_id = ?', id).cluster_id == null && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.strictEqual(one('SELECT cluster_id FROM face_groups WHERE media_id = ?', id).cluster_id, personIn('c1.jpg', 3));

  // A library with face groups and no people: schedulePeople (server start) sorts it.
  const first = partition();
  db.get().exec('UPDATE face_groups SET cluster_id = NULL; DELETE FROM face_people; DELETE FROM face_person_suggestions;');
  store.bumpPeople();
  svc.schedulePeople();
  const d2 = Date.now() + 3000;
  while (svc.status().people.pending > 0 && Date.now() < d2) await new Promise(r => setTimeout(r, 20));
  await svc.peopleSettled();
  assert.deepStrictEqual(partition(), first);
  db.deleteRecords([id]);
  await svc.sortPeopleNow();
});

test('GET /api/faces/people: shape, counts, filters, sorts, search, paging', async () => {
  const r = await get('/api/faces/people');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['counts', 'people', 'total']);
  assert.deepStrictEqual(Object.keys(r.body.counts).sort(), ['all', 'favorites', 'hidden', 'named', 'single', 'unnamed']);
  assert.deepStrictEqual(r.body.counts, { all: 5, named: 0, unnamed: 5, favorites: 0, single: 2, hidden: 0 });
  assert.strictEqual(r.body.total, 5);
  for (const p of r.body.people) assert.deepStrictEqual(Object.keys(p).sort(), ITEM_KEYS);
  // default sort: most files first (ties by id)
  assert.deepStrictEqual(r.body.people.map(p => p.files), [3, 2, 2, 1, 1]);
  const alice = r.body.people[0];
  assert.strictEqual(alice.id, personIn('a1.jpg', 0));
  assert.deepStrictEqual([alice.name, alice.favorite, alice.hidden, alice.files, alice.videos, alice.photos, alice.screenS],
    [null, false, false, 3, 1, 2, 35]);
  assert.match(alice.coverUrl, /^\/api\/faces\/crop\/\d+$/);
  assert.ok(!Number.isNaN(Date.parse(alice.addedAt)));
  // the cover crop is servable
  assert.strictEqual((await fetch(base + alice.coverUrl)).status, 200);

  const screen = (await get('/api/faces/people?sort=screen')).body.people;
  assert.deepStrictEqual(screen.slice(0, 2).map(p => p.screenS), [35, 24.5]);   // 10x3.5; (3+4)x3.5
  assert.strictEqual((await get('/api/faces/people?filter=single')).body.people.every(p => p.files === 1), true);
  const page = (await get('/api/faces/people?offset=1&limit=2')).body;
  assert.strictEqual(page.total, 5);
  assert.deepStrictEqual(page.people.map(p => p.id), r.body.people.slice(1, 3).map(p => p.id));
  for (const bad of ['filter=nobody', 'sort=random', 'limit=0', 'offset=-1', 'limit=abc']) {
    const b = await get(`/api/faces/people?${bad}`);
    assert.strictEqual(b.status, 400, bad);
  }
});

test('POST /api/faces/people/:id: rename (locks members), favorite, hide, cover, NAME_TAKEN, clear name', async () => {
  const alice = personIn('a1.jpg', 0);
  const bob = personIn('b1.jpg', 1);
  let r = await post(`/api/faces/people/${alice}`, { name: '  Alice   Smith ' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), [...ITEM_KEYS, 'coverGroupId', 'oftenWith'].sort());
  assert.strictEqual(r.body.name, 'Alice Smith');
  assert.strictEqual(one('SELECT name_key FROM face_people WHERE id = ?', alice).name_key, 'alice smith');
  assert.deepStrictEqual(q('SELECT DISTINCT person_locked AS l FROM face_groups WHERE cluster_id = ?', alice).map(x => x.l), [1]);

  // the name is taken: 409 with the other person
  r = await post(`/api/faces/people/${bob}`, { name: 'ALICE smith' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'NAME_TAKEN');
  assert.strictEqual(r.body.otherId, alice);
  assert.deepStrictEqual(Object.keys(r.body.other).sort(), ITEM_KEYS);
  assert.strictEqual(one('SELECT name FROM face_people WHERE id = ?', bob).name, null);

  r = await post(`/api/faces/people/${bob}`, { name: 'Bob', favorite: true });
  assert.deepStrictEqual([r.body.name, r.body.favorite], ['Bob', true]);
  for (const bad of [{ name: 5 }, { favorite: 'yes' }, { hidden: 1 }, { coverGroupId: 'x' }, { name: 'x'.repeat(200) }, { mergeIfTaken: 'y' }]) {
    const b = await post(`/api/faces/people/${bob}`, bad);
    assert.strictEqual(b.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await post('/api/faces/people/999999', { name: 'x' })).status, 404);
  assert.strictEqual((await post('/api/faces/people/abc', { name: 'x' })).status, 400);

  // cover: only a face of this person
  const otherFace = one('SELECT id FROM face_groups WHERE cluster_id != ? LIMIT 1', alice).id;
  assert.strictEqual((await post(`/api/faces/people/${alice}`, { coverGroupId: otherFace })).body.code, 'BAD_COVER');
  const mine = q('SELECT id FROM face_groups WHERE cluster_id = ? ORDER BY id', alice).map(x => x.id);
  r = await post(`/api/faces/people/${alice}`, { coverGroupId: mine[1] });
  assert.strictEqual(r.body.coverGroupId, mine[1]);
  assert.strictEqual(r.body.coverUrl, `/api/faces/crop/${mine[1]}`);
  r = await post(`/api/faces/people/${alice}`, { coverGroupId: null });
  assert.strictEqual(one('SELECT cover_group_id FROM face_people WHERE id = ?', alice).cover_group_id, null);

  // counts and filters
  let list = (await get('/api/faces/people')).body;
  assert.deepStrictEqual(list.counts, { all: 5, named: 2, unnamed: 3, favorites: 1, single: 2, hidden: 0 });
  assert.strictEqual(list.people[0].id, bob, 'favorites first');
  assert.deepStrictEqual((await get('/api/faces/people?filter=named&sort=name')).body.people.map(p => p.name), ['Alice Smith', 'Bob']);
  assert.deepStrictEqual((await get('/api/faces/people?q=smi')).body.people.map(p => p.id), [alice]);
  assert.deepStrictEqual((await get('/api/faces/people?filter=favorites')).body.people.map(p => p.id), [bob]);

  // hide: out of everything but the Hidden filter
  r = await post(`/api/faces/people/${bob}`, { hidden: true });
  assert.strictEqual(r.body.hidden, true);
  list = (await get('/api/faces/people')).body;
  assert.ok(!list.people.some(p => p.id === bob));
  assert.deepStrictEqual(list.counts, { all: 4, named: 1, unnamed: 3, favorites: 0, single: 2, hidden: 1 });
  assert.deepStrictEqual((await get('/api/faces/people?filter=hidden')).body.people.map(p => p.id), [bob]);
  assert.strictEqual((await get('/api/faces/status')).body.people.total, 4);
  await post(`/api/faces/people/${bob}`, { hidden: false, favorite: false });

  // empty string: back to "not named yet"
  const c = personIn('c1.jpg', 3);
  await post(`/api/faces/people/${c}`, { name: 'Carol' });
  r = await post(`/api/faces/people/${c}`, { name: '' });
  assert.strictEqual(r.body.name, null);
  assert.strictEqual(one('SELECT name_key FROM face_people WHERE id = ?', c).name_key, null);
});

test('GET /api/faces/people/:id, /files and /faces: shapes and order', async () => {
  const alice = personIn('a1.jpg', 0);
  const r = await get(`/api/faces/people/${alice}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, alice);
  assert.strictEqual(r.body.name, 'Alice Smith');
  // often seen with: Bob (ab.jpg) and person 2 (v1.mp4), one shared file each
  assert.deepStrictEqual(r.body.oftenWith.map(o => Object.keys(o).sort()), [['coverUrl', 'id', 'name', 'shared'], ['coverUrl', 'id', 'name', 'shared']]);
  assert.deepStrictEqual(r.body.oftenWith.map(o => [o.id, o.shared]).sort((a, b) => a[0] - b[0]),
    [[personIn('b1.jpg', 1), 1], [personIn('v1.mp4', 2), 1]].sort((a, b) => a[0] - b[0]));
  assert.strictEqual((await get('/api/faces/people/999999')).status, 404);

  const f = (await get(`/api/faces/people/${alice}/files`)).body;
  assert.deepStrictEqual(Object.keys(f).sort(), ['files', 'ids']);
  assert.deepStrictEqual(f.ids, [ids['v1.mp4'], ids['a1.jpg'], ids['ab.jpg']]);   // videos first, then photos by id
  assert.deepStrictEqual(Object.keys(f.files).map(Number).sort((a, b) => a - b), [...f.ids].sort((a, b) => a - b));
  const v = f.files[ids['v1.mp4']];
  assert.deepStrictEqual(Object.keys(v).sort(), ['appearances', 'firstTimeS', 'groupIds']);
  assert.deepStrictEqual([v.firstTimeS, v.appearances, v.groupIds.length], [4, 10, 1]);
  assert.deepStrictEqual(f.files[ids['a1.jpg']].firstTimeS, null);
  assert.deepStrictEqual((await get(`/api/faces/people/${alice}/files?kind=video`)).body.ids, [ids['v1.mp4']]);
  assert.deepStrictEqual((await get(`/api/faces/people/${alice}/files?kind=photo`)).body.ids, [ids['a1.jpg'], ids['ab.jpg']]);
  assert.strictEqual((await get(`/api/faces/people/${alice}/files?kind=gifs`)).status, 400);

  // videos by screen time
  const p2 = personIn('v1.mp4', 2);
  assert.deepStrictEqual((await get(`/api/faces/people/${p2}/files`)).body.ids, [ids['v2.mp4'], ids['v1.mp4']]);   // 14 s vs 10.5 s

  const fc = (await get(`/api/faces/people/${alice}/faces`)).body;
  assert.ok(Array.isArray(fc));
  assert.strictEqual(fc.length, 3);
  for (const x of fc) assert.deepStrictEqual(Object.keys(x).sort(), ['cropUrl', 'groupId', 'mediaId']);
  assert.strictEqual(new Set(fc.map(x => x.mediaId)).size, 3, 'one face per file');
  assert.strictEqual((await get(`/api/faces/people/${alice}/faces?limit=2`)).body.length, 2);
  assert.strictEqual((await get(`/api/faces/people/${alice}/faces?limit=0`)).status, 400);
});

test('GET /api/media/:id/faces adds personId and personName per group', async () => {
  const r = (await get(`/api/media/${ids['ab.jpg']}/faces`)).body;
  const names = r.groups.map(g => g.personName).sort();
  assert.deepStrictEqual(names, ['Alice Smith', 'Bob']);
  assert.deepStrictEqual(r.groups.map(g => g.personId).sort(), [personIn('ab.jpg', 0), personIn('ab.jpg', 1)].sort());
});

test('review: a near miss is suggested; shape; "different" is remembered, also after a re-sort', async () => {
  const alice = personIn('a1.jpg', 0);
  const near = personIn('near.jpg', 0);
  const r = await get('/api/faces/review');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['pairs', 'total']);
  assert.strictEqual(r.body.total, 1);
  const [pair] = r.body.pairs;
  assert.deepStrictEqual(Object.keys(pair).sort(), ['a', 'b', 'sample']);
  assert.deepStrictEqual(Object.keys(pair.a).sort(), ITEM_KEYS);
  assert.deepStrictEqual([pair.a.id, pair.b.id].sort((x, y) => x - y), [alice, near].sort((x, y) => x - y));
  assert.deepStrictEqual(Object.keys(pair.sample).sort(), ['a', 'b']);
  const sampleOf = (id) => (pair.a.id === id ? pair.sample.a : pair.sample.b);
  assert.deepStrictEqual(sampleOf(near), [ids['near.jpg']]);
  assert.strictEqual(sampleOf(alice).length, 3);

  for (const bad of [{ a: alice, b: alice, answer: 'same' }, { a: alice, b: near, answer: 'maybe' }, { a: 'x', b: near, answer: 'same' }]) {
    assert.strictEqual((await post('/api/faces/review', bad)).status, 400, JSON.stringify(bad));
  }
  const d = await post('/api/faces/review', { a: near, b: alice, answer: 'different' });
  assert.deepStrictEqual(d, { status: 200, body: { ok: true, person: null, merged: [] } });
  assert.deepStrictEqual(q('SELECT a, b, decision FROM face_pair_decisions'), [{ a: Math.min(alice, near), b: Math.max(alice, near), decision: 'different' }]);
  assert.strictEqual((await get('/api/faces/review')).body.total, 0);

  // wipe the people (not the decision), sort again: the pair is not asked again
  const before = partition();
  db.get().exec('UPDATE face_groups SET cluster_id = NULL WHERE media_id = ' + ids['near.jpg']);
  db.get().exec('DELETE FROM face_people WHERE id = ' + near);
  store.bumpPeople();
  await svc.sortPeopleNow();
  const near2 = personIn('near.jpg', 0);
  assert.notStrictEqual(near2, near);
  // the new person has no decision yet, so it may be suggested again (a new
  // face is a new question); its decision with the old id is gone with it
  assert.deepStrictEqual(partition().length, before.length);
  await post('/api/faces/review', { a: near2, b: alice, answer: 'different' });
  await svc.sortPeopleNow();
  assert.strictEqual((await get('/api/faces/review')).body.total, 0);
});

test('review "same" merges into the named person', async () => {
  const alice = personIn('a1.jpg', 0);
  const near = personIn('near.jpg', 0);
  db.get().exec('DELETE FROM face_pair_decisions');
  const r = await post('/api/faces/review', { a: near, b: alice, answer: 'same' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.person.id, alice);
  assert.deepStrictEqual(r.body.merged, [near]);
  assert.strictEqual(r.body.person.files, 4);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', near), undefined);
  assert.deepStrictEqual(fileNamesOf(alice), ['a1.jpg', 'ab.jpg', 'near.jpg', 'v1.mp4']);
  assert.deepStrictEqual(q('SELECT DISTINCT person_locked AS l FROM face_groups WHERE cluster_id = ?', alice).map(x => x.l), [1]);
});

test('re-check carry-over: a name and its members survive a forced re-check of every file', async () => {
  const alice = personIn('a1.jpg', 0);
  const bob = personIn('b1.jpg', 1);
  const oldGroups = q('SELECT id FROM face_groups WHERE cluster_id = ?', alice).map(x => x.id);
  // cover follows its face to the new id
  const coverOld = one('SELECT g.id FROM face_groups g WHERE g.cluster_id = ? AND g.media_id = ?', alice, ids['v1.mp4']).id;
  await post(`/api/faces/people/${alice}`, { coverGroupId: coverOld });
  await index(['a1.jpg', 'ab.jpg', 'near.jpg', 'v1.mp4', 'b1.jpg'], { force: true });
  const now = q('SELECT id FROM face_groups WHERE cluster_id = ?', alice).map(x => x.id);
  assert.ok(now.every(id => !oldGroups.includes(id)), 'new group ids');
  assert.deepStrictEqual(fileNamesOf(alice), ['a1.jpg', 'ab.jpg', 'near.jpg', 'v1.mp4']);
  assert.strictEqual(one('SELECT name FROM face_people WHERE id = ?', alice).name, 'Alice Smith');
  assert.deepStrictEqual(q('SELECT DISTINCT person_locked AS l FROM face_groups WHERE cluster_id = ?', alice).map(x => x.l), [1]);
  assert.strictEqual(personIn('b1.jpg', 1), bob);
  assert.deepStrictEqual(fileNamesOf(bob), ['ab.jpg', 'b1.jpg']);
  const coverNow = one('SELECT cover_group_id FROM face_people WHERE id = ?', alice).cover_group_id;
  assert.strictEqual(one('SELECT media_id FROM face_groups WHERE id = ?', coverNow).media_id, ids['v1.mp4']);
  assert.strictEqual((await get(`/api/faces/people/${alice}`)).body.coverGroupId, coverNow);
  // nothing left over
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_people p WHERE NOT EXISTS (SELECT 1 FROM face_groups g WHERE g.cluster_id = p.id)').n, 0);
});

test('not-in ("Not this person"): the file leaves, a new person, a reject; survives re-sort and re-check', async () => {
  const alice = personIn('a1.jpg', 0);
  const r = await post(`/api/faces/people/${alice}/not-in`, { mediaId: ids['ab.jpg'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['moved', 'person']);
  assert.strictEqual(r.body.person.id, alice);
  assert.strictEqual(r.body.person.files, 3);
  assert.strictEqual(r.body.moved.length, 1);
  const { groupId, personId } = r.body.moved[0];
  assert.notStrictEqual(personId, alice);
  assert.deepStrictEqual(q('SELECT person_id, group_id FROM face_person_rejects'), [{ person_id: alice, group_id: groupId }]);
  assert.deepStrictEqual(fileNamesOf(personId), ['ab.jpg']);
  assert.strictEqual(one('SELECT name FROM face_people WHERE id = ?', personId).name, null);

  for (const bad of [{}, { mediaId: 'x' }, { mediaId: -1 }]) {
    assert.strictEqual((await post(`/api/faces/people/${alice}/not-in`, bad)).status, 400);
  }
  assert.strictEqual((await post(`/api/faces/people/${alice}/not-in`, { mediaId: ids['c1.jpg'] })).status, 404);

  // a forced re-check of that file: the new group keeps its own person and the reject
  await index(['ab.jpg'], { force: true });
  const split = personIn('ab.jpg', 0);
  assert.strictEqual(split, personId);
  assert.notStrictEqual(split, alice);
  const g2 = one('SELECT id FROM face_groups WHERE cluster_id = ?', split).id;
  assert.deepStrictEqual(q('SELECT person_id, group_id FROM face_person_rejects'), [{ person_id: alice, group_id: g2 }]);

  // even unsorted again, the reject keeps it out of Alice
  db.get().prepare('UPDATE face_groups SET cluster_id = NULL WHERE id = ?').run(g2);
  db.get().prepare('DELETE FROM face_people WHERE id = ?').run(split);
  store.bumpPeople();
  await svc.sortPeopleNow();
  const again = one('SELECT cluster_id FROM face_groups WHERE id = ?', g2).cluster_id;
  assert.ok(again != null && again !== alice);
  // and the split person is not suggested back to Alice
  assert.ok(!(await get('/api/faces/review')).body.pairs.some(p => [p.a.id, p.b.id].includes(alice) && [p.a.id, p.b.id].includes(again)));
});

test('merge: validation, union of files, locks, rejects follow, and it survives a re-check', async () => {
  const c = personIn('c1.jpg', 3);
  const p2 = personIn('v1.mp4', 2);
  for (const bad of [{}, { ids: [c], into: c }, { ids: [c, p2], into: 12345 }, { ids: [c, c], into: c }, { ids: [c, 'x'], into: c },
    { ids: Array.from({ length: 51 }, (_, i) => i + 1), into: 1 }]) {
    assert.strictEqual((await post('/api/faces/people/merge', bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await post('/api/faces/people/merge', { ids: [c, 999999], into: c })).status, 404);

  const r = await post('/api/faces/people/merge', { ids: [c, p2], into: p2 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), [...ITEM_KEYS, 'coverGroupId', 'oftenWith'].sort());
  assert.strictEqual(r.body.id, p2);
  assert.strictEqual(r.body.files, 3);
  assert.deepStrictEqual(fileNamesOf(p2), ['c1.jpg', 'v1.mp4', 'v2.mp4']);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', c), undefined);
  assert.deepStrictEqual(q('SELECT DISTINCT person_locked AS l FROM face_groups WHERE cluster_id = ?', p2).map(x => x.l), [1]);

  // re-check all three: still one person
  await index(['c1.jpg', 'v1.mp4', 'v2.mp4'], { force: true });
  assert.deepStrictEqual(fileNamesOf(p2), ['c1.jpg', 'v1.mp4', 'v2.mp4']);

  // naming with mergeIfTaken merges into the existing name
  const split = personIn('ab.jpg', 0);
  const alice = personIn('a1.jpg', 0);
  const m = await post(`/api/faces/people/${split}`, { name: 'alice smith', mergeIfTaken: true });
  assert.strictEqual(m.status, 200);
  assert.strictEqual(m.body.id, alice);
  assert.strictEqual(m.body.name, 'Alice Smith');
  assert.deepStrictEqual(fileNamesOf(alice), ['a1.jpg', 'ab.jpg', 'near.jpg', 'v1.mp4']);
  // the reject against Alice went with it (the user put the face back)
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_person_rejects WHERE person_id = ?', alice).n, 0);
});

test('stats leave out trashed files and hidden faces', async () => {
  const alice = personIn('a1.jpg', 0);
  const base0 = (await get(`/api/faces/people/${alice}`)).body;
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(ids['v1.mp4']);
  require('../lib/faces/people').resetCaches();   // trash moves no counter (the stats cache lives 2 s)
  let p = (await get(`/api/faces/people/${alice}`)).body;
  assert.deepStrictEqual([p.files, p.videos, p.screenS], [base0.files - 1, 0, 0]);
  assert.ok(!(await get(`/api/faces/people/${alice}/files`)).body.ids.includes(ids['v1.mp4']));
  db.get().prepare('UPDATE media SET user_trashed = 0 WHERE id = ?').run(ids['v1.mp4']);

  const g = one('SELECT id FROM face_groups WHERE cluster_id = ? AND media_id = ?', alice, ids['a1.jpg']).id;
  assert.strictEqual((await post(`/api/faces/groups/${g}/hide`, {})).status, 200);
  p = (await get(`/api/faces/people/${alice}`)).body;
  assert.strictEqual(p.files, base0.files - 1);
  assert.ok(!(await get(`/api/faces/people/${alice}/faces`)).body.some(x => x.groupId === g));
});

test('cleanup: a hard delete drops empty unnamed people, keeps named or favorite ones (unlisted)', async () => {
  const n1 = addFile('solo1.jpg', 'image');
  const n2 = addFile('solo2.jpg', 'image');
  const n3 = addFile('solo3.jpg', 'image');
  fk.fileScripts.set(files['solo1.jpg'], { groups: [group(person(60))] });
  fk.fileScripts.set(files['solo2.jpg'], { groups: [group(person(61))] });
  fk.fileScripts.set(files['solo3.jpg'], { groups: [group(person(62))] });
  await index(['solo1.jpg', 'solo2.jpg', 'solo3.jpg']);
  const [p1, p2, p3] = [personIn('solo1.jpg', 60), personIn('solo2.jpg', 61), personIn('solo3.jpg', 62)];
  await post(`/api/faces/people/${p2}`, { name: 'Dora' });
  await post(`/api/faces/people/${p3}`, { favorite: true });
  const r = await post('/api/records/delete', { ids: [n1, n2, n3] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', p1), undefined);
  assert.ok(one('SELECT id FROM face_people WHERE id = ?', p2));
  assert.ok(one('SELECT id FROM face_people WHERE id = ?', p3));
  const list = (await get('/api/faces/people?filter=named')).body;
  assert.ok(!list.people.some(p => p.id === p2), 'empty named people are not listed');
  // the kept name is simply taken over by the next person given it
  const c1 = personIn('c1.jpg', 3);
  const p2b = await post(`/api/faces/people/${c1}`, { name: 'dora' });
  assert.strictEqual(p2b.status, 200);
  assert.strictEqual(p2b.body.id, c1);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', p2), undefined);
});

test('lock and migrate: the job writes nothing while locked or migrating, and resumes after', async () => {
  const id = addFile('later.jpg', 'image');
  fk.fileScripts.set(files['later.jpg'], { groups: [group(person(70))] });
  await post('/api/faces/index', { ids: [id] });
  await svc.settled();
  await svc.peopleSettled();
  db.get().exec('UPDATE face_groups SET cluster_id = NULL WHERE media_id = ' + id);
  store.bumpPeople();

  locked = true;
  svc.onVaultLocked();
  await svc.sortPeopleNow();
  assert.strictEqual(one('SELECT cluster_id FROM face_groups WHERE media_id = ?', id).cluster_id, null);
  locked = false;

  migrating = true;
  await svc.sortPeopleNow();
  assert.strictEqual(one('SELECT cluster_id FROM face_groups WHERE media_id = ?', id).cluster_id, null);
  migrating = false;

  svc.onVaultUnlocked();
  await svc.sortPeopleNow();
  assert.ok(one('SELECT cluster_id FROM face_groups WHERE media_id = ?', id).cluster_id != null);
});

test('delete-all wipes people, rejects, decisions and suggestions', async () => {
  const alice = personIn('a1.jpg', 0);
  await post(`/api/faces/people/${alice}/not-in`, { mediaId: ids['ab.jpg'] });
  db.get().prepare("INSERT OR IGNORE INTO face_pair_decisions (a, b, decision, created_at) VALUES (1, 2, 'different', 'x')").run();
  db.get().prepare('INSERT OR IGNORE INTO face_person_suggestions (a, b, score) VALUES (1, 2, 0.45)').run();
  const r = await post('/api/faces/delete-all');
  assert.strictEqual(r.status, 200);
  for (const t of ['face_people', 'face_person_rejects', 'face_pair_decisions', 'face_person_suggestions', 'face_groups']) {
    assert.strictEqual(one(`SELECT COUNT(*) AS n FROM ${t}`).n, 0, t);
  }
  const s = (await get('/api/faces/status')).body.people;
  assert.deepStrictEqual([s.pending, s.total], [0, 0]);
  assert.deepStrictEqual((await get('/api/faces/people')).body.counts, { all: 0, named: 0, unnamed: 0, favorites: 0, single: 0, hidden: 0 });
});

/* ── The job on its own: slices, yields, lock mid-run ─────────────────── */

function rand(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function randomUnit(r) {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = r() - 0.5;
  return store.normalize(v);
}

test('the job yields to the event loop while sorting thousands of faces, and a lock stops it mid-run', async () => {
  const r = rand(7);
  const N = 1500;
  const mids = [];
  // Straight into the tables, one transaction (saveFileResult per file is slow on disk).
  const d = db.get();
  d.transaction(() => {
    const insM = d.prepare("INSERT INTO media (filepath, filename, media_type, faces_indexed_at, faces_model) VALUES (?, ?, 'image', 'x', 'stub-v1')");
    const insG = d.prepare(`INSERT INTO face_groups (media_id, appearances, best_bbox, det_score, model, created_at)
      VALUES (?, 1, '[0,0,0.1,0.1]', ?, 'stub-v1', 'x')`);
    const insV = d.prepare('INSERT INTO face_vectors (group_id, media_id, det_score, embedding) VALUES (?, ?, 0.9, ?)');
    for (let i = 0; i < N; i++) {
      const mid = Number(insM.run(path.join(tmp, `bulk${i}.jpg`), `bulk${i}.jpg`).lastInsertRowid);
      mids.push(mid);
      const gid = Number(insG.run(mid, 0.5 + r() / 2).lastInsertRowid);
      insV.run(gid, mid, store.encodeEmbedding(randomUnit(r)));
    }
  })();
  svc._sorter.cancel();   // the service's own job stays out of this test
  let isLocked = false;
  const sorter = createSorter({ database: db, store, isVaultLocked: () => isLocked, sliceMs: 10 });

  // lock mid-run: nothing written after the lock
  const run = sorter.runNow();
  await new Promise(res => setImmediate(res));
  await new Promise(res => setImmediate(res));
  isLocked = true;
  sorter.suspend();
  await run;
  const afterLock = one('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id IS NOT NULL').n;
  await new Promise(res => setTimeout(res, 30));
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id IS NOT NULL').n, afterLock);
  assert.ok(afterLock < N, `stopped early (${afterLock} of ${N})`);
  assert.strictEqual(sorter._cache(), null, 'centroids dropped on lock');

  // unlocked: finishes, and the event loop keeps turning meanwhile
  isLocked = false;
  // Other work gets turns while it sorts: a timer keeps firing. (Wall-clock
  // gaps are not asserted tightly: under a loaded parallel test run the OS
  // alone can pause the process for 100+ ms.)
  let maxGap = 0, last = Date.now(), ticking = true, ticks = 0;
  const tick = () => { const t = Date.now(); ticks++; maxGap = Math.max(maxGap, t - last); last = t; if (ticking) setTimeout(tick, 1); };
  setTimeout(tick, 1);
  await sorter.runNow();
  ticking = false;
  assert.strictEqual(sorter.pending(), 0);
  assert.ok(ticks >= 5, `the event loop turned ${ticks} times while sorting`);
  assert.ok(maxGap < 1000, `event loop gap ${maxGap} ms`);
  // random faces are all strangers
  assert.strictEqual(one('SELECT COUNT(DISTINCT cluster_id) AS n FROM face_groups').n, N);
});
