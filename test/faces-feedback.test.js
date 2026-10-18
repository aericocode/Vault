/**
 * Faces round 3, server part (FACES_FEEDBACK_SPEC E1 to E6), over HTTP
 * against the real Express app with the stub engine (no models, no network):
 *   E1 similar results know their people (match, source, likelyPerson)
 *   E2 add faces to a person, E3 a new person from faces
 *   E4 "Might also be" candidates and their answers
 *   E5 the queue's recent list, progress and lastRun.withPeople
 *   E6 not a face (a face, a whole person), kept across a re-check
 *
 * Library (embeddings from basis vectors, see helpers/faces-fakes.js):
 *   o1, o2, o3   person 0 ("Barack")
 *   mix          person 0 and person 1 in one photo
 *   b1, b2       person 1 ("Joe")
 *   m1           cosine 0.47 to person 0: its own person, too far to be offered
 *   y1           cosine 0.55 to person 0, w1 between person 0 and n1: moved
 *                into their own people; y1 is a "maybe", w1 is not offered
 *                (too close to n1: no margin)
 *   l1 h1 d1 r1 n1  cosine 0.65 to 0.7 to person 0: sorted into Barack, then
 *                moved by the test into their own people (a "likely", a
 *                hidden one, a 'different' answer, a reject, a named one)
 *   s1           person 2, a stranger
 *   t1           person 3; t2 t3 t4 cosine 0.45 to person 3, each alone
 *   a1 a2 a3 a4  person 4, 5, 6, 7 (for add / create / not-a-face)
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-feedback-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const faces = require('../lib/faces/service');
const store = require('../lib/faces/store');
const candidates = require('../lib/faces/candidates');
const { createQueue, RECENT_MAX } = require('../lib/faces/queue');
const { app } = require('../server/index');
const { person, like, group, createFakes } = require('./helpers/faces-fakes');

const qtmp = path.join(tmp, 'qtmp');
fs.mkdirSync(qtmp, { recursive: true });
const fk = createFakes();
let migrating = false;
const svc = faces.setInstance(faces.createService({
  modelStore: fk.modelStore, engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames,
  isMigrateRunning: () => migrating, peopleDebounceMs: 40, tmpDir: qtmp,
}));

let server, base;
const ids = {};
const files = {};

function addFile(name, type = 'image') {
  const fp = path.join(tmp, 'media', name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, name);
  files[name] = fp;
  ids[name] = Number(db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)')
    .run(fp, name, type).lastInsertRowid);
  return ids[name];
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const post = async (p, body) => { const r = await fetch(base + p, json(body)); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const q = (sql, ...a) => db.get().prepare(sql).all(...a);
const one = (sql, ...a) => db.get().prepare(sql).get(...a);

async function index(names, { force = false } = {}) {
  const r = await post('/api/faces/index', { ids: names.map(n => ids[n]), force });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await svc.settled();
  await svc.sortPeopleNow();
}

/** Group ids of a file, best match to basis person i first. */
function groupsOf(name, i = null) {
  const rows = q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', ids[name]).map(r => r.id);
  if (i == null) return rows;
  return rows.sort((a, b) => store.groupVectors(b)[0][i] - store.groupVectors(a)[0][i]);
}
const gid = (name, i = null) => groupsOf(name, i)[0];
const pidOf = (name, i = null) => one('SELECT cluster_id FROM face_groups WHERE id = ?', gid(name, i)).cluster_id;

/** Move a file's faces into a new person of their own (what stricter sorting would have made). */
function solo(name, { hidden = 0, pname = null } = {}) {
  const stamp = new Date().toISOString();
  const pid = Number(db.get().prepare('INSERT INTO face_people (name, name_key, hidden, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(pname, pname && pname.toLowerCase(), hidden, stamp, stamp).lastInsertRowid);
  db.get().prepare('UPDATE face_groups SET cluster_id = ?, person_locked = 0 WHERE media_id = ?').run(pid, ids[name]);
  store.bumpPeople();
  return pid;
}

const P = {};

test.before(async () => {
  db.init();
  const scripts = {
    'o1.jpg': [person(0)], 'o2.jpg': [like(0, 0.9, 101)], 'o3.jpg': [like(0, 0.85, 102)],
    'mix.jpg': [like(0, 0.95, 103), like(1, 0.95, 104)],
    'b1.jpg': [person(1)], 'b2.jpg': [like(1, 0.9, 105)],
    'm1.jpg': [like(0, 0.47, 106)],
    'y1.jpg': [like(0, 0.55, 117)], 'w1.jpg': [(() => { const v = new Float32Array(128); v[0] = 0.6; v[111] = 0.8; return v; })()],
    'l1.jpg': [like(0, 0.7, 107)], 'h1.jpg': [like(0, 0.7, 108)], 'd1.jpg': [like(0, 0.68, 109)],
    'r1.jpg': [like(0, 0.66, 110)], 'n1.jpg': [like(0, 0.65, 111)],
    's1.jpg': [person(2)],
    't1.jpg': [person(3)], 't2.jpg': [like(3, 0.45, 112)], 't3.jpg': [like(3, 0.45, 113)], 't4.jpg': [like(3, 0.45, 114)],
    'a1.jpg': [person(4)], 'a2.jpg': [person(5)], 'a3.jpg': [person(6)], 'a4.jpg': [person(7)],
  };
  for (const [name, vecs] of Object.entries(scripts)) {
    addFile(name);
    fk.fileScripts.set(files[name], { groups: vecs.map(v => group(v)) });
  }
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.strictEqual((await post('/api/faces/settings', { enabled: true })).status, 200);
  // Barack's files first, so the near faces join his person when sorted.
  await index(['o1.jpg', 'o2.jpg', 'o3.jpg', 'mix.jpg', 'b1.jpg', 'b2.jpg']);
  await index(['m1.jpg', 'y1.jpg', 'w1.jpg', 'l1.jpg', 'h1.jpg', 'd1.jpg', 'r1.jpg', 'n1.jpg', 's1.jpg', 't1.jpg', 't2.jpg', 't3.jpg', 't4.jpg',
    'a1.jpg', 'a2.jpg', 'a3.jpg', 'a4.jpg']);
  P.barack = pidOf('o1.jpg');
  P.joe = pidOf('b1.jpg');
  assert.strictEqual((await post(`/api/faces/people/${P.barack}`, { name: 'Barack' })).status, 200);
  assert.strictEqual((await post(`/api/faces/people/${P.joe}`, { name: 'Joe' })).status, 200);
});

test.after(async () => {
  svc.cancel();
  await svc.settled();
  await svc.peopleSettled();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('setup: the library sorted as the header says', () => {
  for (const n of ['o2.jpg', 'o3.jpg', 'l1.jpg', 'h1.jpg', 'd1.jpg', 'r1.jpg', 'n1.jpg']) assert.strictEqual(pidOf(n), P.barack, n);
  assert.strictEqual(pidOf('mix.jpg', 0), P.barack);
  assert.strictEqual(pidOf('mix.jpg', 1), P.joe);
  assert.notStrictEqual(pidOf('m1.jpg'), P.barack, 'cosine 0.47 starts its own person');
  for (const n of ['t2.jpg', 't3.jpg', 't4.jpg']) assert.notStrictEqual(pidOf(n), pidOf('t1.jpg'), n);
});

/* ── E1 ─────────────────────────────────────────────────────────────────── */

test('E1 group search: match is the best-scoring face of each file, with its person; source = the clicked face\'s person', async () => {
  const r = await post(`/api/faces/groups/${gid('b1.jpg')}/similar`, { width: 'normal' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['capped', 'ids', 'match', 'rejected', 'scores', 'source', 'total']);
  assert.deepStrictEqual(r.body.source, { personId: P.joe, personName: 'Joe' });
  assert.deepStrictEqual(new Set(r.body.ids), new Set([ids['b1.jpg'], ids['b2.jpg'], ids['mix.jpg']]));
  assert.deepStrictEqual(Object.keys(r.body.match).map(Number).sort(), [...r.body.ids].sort());
  // mix.jpg has Barack and Joe: the match is Joe's face (the one that scored)
  assert.deepStrictEqual(r.body.match[ids['mix.jpg']], { groupId: gid('mix.jpg', 1), personId: P.joe, personName: 'Joe' });
  assert.deepStrictEqual(r.body.match[ids['b2.jpg']], { groupId: gid('b2.jpg'), personId: P.joe, personName: 'Joe' });

  const o = await post(`/api/faces/groups/${gid('o1.jpg')}/similar`, { width: 'close' });
  assert.deepStrictEqual(o.body.match[ids['mix.jpg']], { groupId: gid('mix.jpg', 0), personId: P.barack, personName: 'Barack' });
  assert.deepStrictEqual(o.body.source, { personId: P.barack, personName: 'Barack' });
});

async function querySearch(tag, embedding, width = 'normal') {
  fk.frameScripts.set(tag, [{ embedding, bbox: [0.1, 0.1, 0.2, 0.2], crop: Buffer.from('c') }]);
  const res = await fetch(`${base}/api/faces/search-image`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: tag });
  const { faces: found } = await res.json();
  return post(`/api/faces/query/${found[0].queryId}/similar`, { width });
}

test('E1 query search: likelyPerson = the person of at least half the results, else a best match >= 0.50, else null', async () => {
  // Barack has most of the results
  let r = await querySearch('q-barack', person(0));
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['capped', 'ids', 'likelyPerson', 'match', 'rejected', 'scores', 'total']);
  assert.deepStrictEqual(r.body.likelyPerson, { id: P.barack, name: 'Barack' });
  assert.strictEqual(r.body.match[ids['o2.jpg']].personId, P.barack);

  // person 3: t1 and three loners at 0.45: no majority, best match (1.0) is t1's person
  const p3 = pidOf('t1.jpg');
  r = await querySearch('q-three', person(3));
  assert.strictEqual(r.body.ids.length, 4);
  assert.strictEqual(r.body.ids[0], ids['t1.jpg']);
  assert.deepStrictEqual(r.body.likelyPerson, { id: p3, name: null });

  // the same, but the best match's person is hidden: null
  db.get().prepare('UPDATE face_people SET hidden = 1 WHERE id = ?').run(p3);
  store.bumpPeople({ membership: false });
  r = await querySearch('q-three-hidden', person(3));
  assert.strictEqual(r.body.likelyPerson, null);
  assert.strictEqual(r.body.match[ids['t1.jpg']].personId, p3, 'match still tells the truth');
  db.get().prepare('UPDATE face_people SET hidden = 0 WHERE id = ?').run(p3);
  store.bumpPeople({ membership: false });

  // no majority (three loners) and the best match under 0.50: null
  const v = new Float32Array(128); v[112] = 0.53; v[113] = 0.53; v[114] = 0.53; v[120] = 0.4;
  let n = 0; for (const x of v) n += x * x; for (let i = 0; i < 128; i++) v[i] /= Math.sqrt(n);
  r = await querySearch('q-between', v, 'wide');
  assert.deepStrictEqual(new Set(r.body.ids), new Set([ids['t2.jpg'], ids['t3.jpg'], ids['t4.jpg']]));
  assert.ok(r.body.scores[0] < 0.5);
  assert.strictEqual(r.body.likelyPerson, null);
});

/* ── E4 (before E2/E3 change the people) ─────────────────────────────────── */

test('E4 candidates: unnamed people ranked by the rule, hidden / different / rejected / named excluded, paged', async () => {
  P.l = solo('l1.jpg');
  P.h = solo('h1.jpg', { hidden: 1 });
  P.d = solo('d1.jpg');
  P.r = solo('r1.jpg');
  P.n = solo('n1.jpg', { pname: 'Other' });
  P.m = pidOf('m1.jpg');
  P.y = solo('y1.jpg');
  P.w = solo('w1.jpg');
  db.get().prepare("INSERT INTO face_pair_decisions (a, b, decision, created_at) VALUES (?, ?, 'different', 'x')")
    .run(Math.min(P.barack, P.d), Math.max(P.barack, P.d));
  db.get().prepare('INSERT INTO face_person_rejects (person_id, group_id) VALUES (?, ?)').run(P.barack, gid('r1.jpg'));
  store.bumpPeople();

  const r = await get(`/api/faces/people/${P.barack}/candidates`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  // person centroids: l1 0.68 with a wide margin over 'Other' = likely; w1
  // 0.59 but closer to 'Other' = not listed (no margin); y1 0.54 = maybe;
  // m1 0.46 not listed
  assert.deepStrictEqual(r.body.items.map(i => [i.personId, i.tier]), [[P.l, 'likely'], [P.y, 'maybe']]);
  assert.strictEqual(r.body.total, 2);
  const [it] = r.body.items;
  assert.deepStrictEqual(Object.keys(it).sort(), ['bbox', 'cropUrl', 'filename', 'files', 'groupId', 'mediaId', 'mediaType', 'personId', 'score', 'tier', 'timeS']);
  assert.deepStrictEqual([it.groupId, it.mediaId, it.filename, it.files, it.cropUrl],
    [gid('l1.jpg'), ids['l1.jpg'], 'l1.jpg', 1, `/api/faces/crop/${gid('l1.jpg')}`]);
  assert.ok(it.score >= 0.56 && r.body.items[1].score >= 0.52 && r.body.items[1].score < 0.56);

  const page = await get(`/api/faces/people/${P.barack}/candidates?limit=1&offset=1`);
  assert.deepStrictEqual([page.body.total, page.body.items.map(i => i.personId)], [2, [P.y]]);
  assert.strictEqual((await get(`/api/faces/people/${P.barack}/candidates?limit=0`)).status, 400);
  assert.strictEqual((await get(`/api/faces/people/${P.barack}/candidates?offset=-1`)).status, 400);
  assert.strictEqual((await get('/api/faces/people/987654/candidates')).status, 404);
  assert.strictEqual((await get('/api/faces/people/abc/candidates')).body.code, 'BAD_ID');

  // D1: trashing / restoring a file (no face counter moves) refreshes the cached list
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(ids['l1.jpg']);
  assert.deepStrictEqual((await get(`/api/faces/people/${P.barack}/candidates`)).body.items.map(i => i.personId), [P.y]);
  db.get().prepare('UPDATE media SET user_trashed = 0 WHERE id = ?').run(ids['l1.jpg']);
  assert.deepStrictEqual((await get(`/api/faces/people/${P.barack}/candidates`)).body.items.map(i => i.personId), [P.l, P.y]);
});

test('E4 the scoring rule is one swappable function', async () => {
  candidates.setRule({ id: 'test', score: (t, c) => ({ score: 0.9, groupId: c.groups[0].id }), tier: () => 'maybe' });
  try {
    const r = await get(`/api/faces/people/${P.barack}/candidates?limit=100`);
    assert.ok(r.body.items.every(i => i.tier === 'maybe' && i.score === 0.9));
    assert.ok(r.body.items.some(i => i.personId === pidOf('s1.jpg')), 'every eligible unnamed person was offered to the rule');
    assert.ok(!r.body.items.some(i => [P.h, P.d, P.r, P.n, P.joe].includes(i.personId)), 'exclusions are not the rule\'s job');
  } finally {
    candidates.setRule(null);
  }
});

test('E4 "None of these": every shown candidate answered different in one call, and the Undo brings them all back', async () => {
  const url = `/api/faces/people/${P.barack}/candidates`;
  const shown = (await get(url)).body.items.map(i => i.personId);
  assert.deepStrictEqual(shown, [P.l, P.y]);
  let r = await post(url, { reject: shown });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.merged, r.body.rejected, r.body.skipped], [[], shown, []]);
  for (const pid of shown) {
    assert.strictEqual(one('SELECT decision FROM face_pair_decisions WHERE a = ? AND b = ?', Math.min(P.barack, pid), Math.max(P.barack, pid)).decision, 'different');
  }
  assert.deepStrictEqual((await get(url)).body, { total: 0, items: [] }, 'never offered for this person again');
  await svc.sortPeopleNow();
  assert.deepStrictEqual((await get(url)).body.total, 0, 'a re-sort does not bring them back');
  // Undo
  r = await post(url, { unreject: shown });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.unrejected, shown);
  assert.deepStrictEqual((await get(url)).body.items.map(i => [i.personId, i.tier]), [[P.l, 'likely'], [P.y, 'maybe']]);
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_pair_decisions WHERE (a = ? OR b = ?) AND (a IN (?, ?) OR b IN (?, ?))',
    P.barack, P.barack, ...shown, ...shown).n, 0);
});

test('E4 answers: accept merges (locked), reject records different; both leave the list', async () => {
  for (const bad of [{}, { accept: [] }, { accept: [P.l], reject: [P.l] }, { accept: [P.barack] }, { accept: 'x' },
    { reject: [1.5] }, { accept: [P.l, P.l] }]) {
    const r = await post(`/api/faces/people/${P.barack}/candidates`, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.strictEqual(r.body.code, 'BAD_IDS');
  }
  assert.strictEqual((await post('/api/faces/people/987654/candidates', { accept: [P.l] })).status, 404);

  const r = await post(`/api/faces/people/${P.barack}/candidates`, { accept: [P.l, P.n, 987654], reject: [P.w, P.y] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.merged, r.body.rejected], [[P.l], [P.w, P.y]]);
  assert.deepStrictEqual(r.body.skipped, [{ personId: P.n, reason: 'named' }, { personId: 987654, reason: 'gone' }]);
  assert.strictEqual(r.body.person.id, P.barack);
  assert.strictEqual(r.body.person.name, 'Barack');
  assert.deepStrictEqual(one('SELECT cluster_id, person_locked FROM face_groups WHERE id = ?', gid('l1.jpg')), { cluster_id: P.barack, person_locked: 1 });
  assert.strictEqual(one('SELECT 1 AS x FROM face_people WHERE id = ?', P.l), undefined);
  assert.strictEqual(one('SELECT decision FROM face_pair_decisions WHERE a = ? AND b = ?', Math.min(P.barack, P.y), Math.max(P.barack, P.y)).decision, 'different');
  assert.strictEqual(pidOf('n1.jpg'), P.n, 'a named person is never merged from here');
  const after = await get(`/api/faces/people/${P.barack}/candidates`);
  assert.deepStrictEqual(after.body, { total: 0, items: [] });
  // the sorting job never undoes it
  await svc.sortPeopleNow();
  assert.strictEqual(pidOf('l1.jpg'), P.barack);
});

test('E4 accept never merges hidden people or a pair answered different', async () => {
  addFile('k1.jpg'); addFile('k2.jpg');
  fk.fileScripts.set(files['k1.jpg'], { groups: [group(person(10))] });
  fk.fileScripts.set(files['k2.jpg'], { groups: [group(person(11))] });
  await index(['k1.jpg', 'k2.jpg']);
  const hid = pidOf('k1.jpg'), diff = pidOf('k2.jpg');
  db.get().prepare('UPDATE face_people SET hidden = 1 WHERE id = ?').run(hid);
  db.get().prepare("INSERT INTO face_pair_decisions (a, b, decision, created_at) VALUES (?, ?, 'different', 'x')")
    .run(Math.min(P.barack, diff), Math.max(P.barack, diff));
  store.bumpPeople();
  const r = await post(`/api/faces/people/${P.barack}/candidates`, { accept: [hid, diff] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.merged, []);
  assert.deepStrictEqual(r.body.skipped, [{ personId: hid, reason: 'hidden' }, { personId: diff, reason: 'different' }]);
  assert.deepStrictEqual([pidOf('k1.jpg'), pidOf('k2.jpg')], [hid, diff]);
});

/* ── E2 ─────────────────────────────────────────────────────────────────── */

test('E2 add: moves and locks, clears rejects, prunes emptied unnamed people, skips named / hidden / gone', async () => {
  const pa1 = pidOf('a1.jpg');
  const ga1 = gid('a1.jpg'), gb2 = gid('b2.jpg'), gs1 = gid('s1.jpg');
  db.get().prepare('INSERT INTO face_person_rejects (person_id, group_id) VALUES (?, ?)').run(P.barack, ga1);
  store.hideGroup(gid('a2.jpg'));
  const ga2 = gid('a2.jpg');
  const r = await post(`/api/faces/people/${P.barack}/add`, { groupIds: [ga1, gb2, ga2, 987654] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(Object.keys(r.body).sort(), ['already', 'moved', 'person', 'skipped']);
  assert.deepStrictEqual([r.body.moved, r.body.already], [[ga1], []]);
  assert.deepStrictEqual(r.body.skipped, [
    { groupId: gb2, reason: 'other-named' }, { groupId: ga2, reason: 'hidden' }, { groupId: 987654, reason: 'gone' }]);
  assert.strictEqual(r.body.person.id, P.barack);
  assert.deepStrictEqual(one('SELECT cluster_id, person_locked FROM face_groups WHERE id = ?', ga1), { cluster_id: P.barack, person_locked: 1 });
  assert.strictEqual(one('SELECT 1 AS x FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.barack, ga1), undefined);
  assert.strictEqual(one('SELECT 1 AS x FROM face_people WHERE id = ?', pa1), undefined, 'emptied unnamed person pruned');
  assert.strictEqual(pidOf('b2.jpg'), P.joe, 'a named person keeps its face');

  // takeFromNamed: explicit; Joe keeps existing (named), with his other files
  const t = await post(`/api/faces/people/${P.barack}/add`, { groupIds: [gb2, gs1], takeFromNamed: true });
  assert.deepStrictEqual(t.body.moved, [gb2, gs1]);
  assert.strictEqual(pidOf('b2.jpg'), P.barack);
  assert.strictEqual((await get(`/api/faces/people/${P.joe}`)).body.files, 2);
  // already in: listed apart, and nothing changes (no user counter moves; the
  // background job may move peopleVersion on its own, so that one is not compared)
  await svc.peopleSettled();
  const v = [store.peopleUserVersion(), store.version()];
  const again = await post(`/api/faces/people/${P.barack}/add`, { groupIds: [gb2] });
  assert.deepStrictEqual([again.body.moved, again.body.already], [[], [gb2]]);
  assert.deepStrictEqual([store.peopleUserVersion(), store.version()], v);
  // give b2 back to Joe for the rest of the suite
  assert.deepStrictEqual((await post(`/api/faces/people/${P.joe}/add`, { groupIds: [gb2], takeFromNamed: true })).body.moved, [gb2]);
});

test('E2 add: validation, 404, migrate guard', async () => {
  for (const bad of [{}, { groupIds: [] }, { groupIds: [1, 1] }, { groupIds: ['x'] }, { groupIds: [0] },
    { groupIds: Array.from({ length: 2001 }, (_, i) => i + 1) }]) {
    const r = await post(`/api/faces/people/${P.barack}/add`, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad).slice(0, 80));
    assert.strictEqual(r.body.code, 'BAD_IDS');
  }
  assert.strictEqual((await post(`/api/faces/people/${P.barack}/add`, { groupIds: [1], takeFromNamed: 'yes' })).status, 400);
  assert.strictEqual((await post('/api/faces/people/987654/add', { groupIds: [gid('a3.jpg')] })).status, 404);
  migrating = true;
  try {
    for (const [p, body] of [
      [`/api/faces/people/${P.barack}/add`, { groupIds: [gid('a3.jpg')] }],
      ['/api/faces/people', { name: 'Someone', groupIds: [gid('a3.jpg')] }],
      [`/api/faces/people/${P.barack}/candidates`, { reject: [P.joe] }],
      [`/api/faces/groups/${gid('a3.jpg')}/not-a-face`, {}],
      [`/api/faces/people/${pidOf('a3.jpg')}/not-a-face`, {}],
    ]) {
      const r = await post(p, body);
      assert.deepStrictEqual([r.status, r.body.code], [409, 'MIGRATE_RUNNING'], p);
    }
    assert.deepStrictEqual(one('SELECT hidden, not_face FROM face_groups WHERE id = ?', gid('a3.jpg')), { hidden: 0, not_face: 0 }, 'nothing written');
    assert.strictEqual(one('SELECT 1 AS x FROM face_people WHERE name_key = ?', 'someone'), undefined);
  } finally { migrating = false; }
});

/* ── E3 ─────────────────────────────────────────────────────────────────── */

test('E3 new person from faces: named, NAME_TAKEN, mergeIfTaken, unnamed, nothing to add', async () => {
  const pa3 = pidOf('a3.jpg');
  let r = await post('/api/faces/people', { name: '  New  Guy ', groupIds: [gid('a3.jpg')] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.name, 'New Guy');
  assert.strictEqual(r.body.mergedInto, null);
  assert.deepStrictEqual([r.body.files, r.body.moved, r.body.skipped], [1, [gid('a3.jpg')], []]);
  assert.ok(r.body.id !== pa3 && Array.isArray(r.body.oftenWith));
  assert.strictEqual(one('SELECT 1 AS x FROM face_people WHERE id = ?', pa3), undefined, 'the old unnamed person was pruned');
  assert.strictEqual(one('SELECT person_locked FROM face_groups WHERE id = ?', gid('a3.jpg')).person_locked, 1);
  const guy = r.body.id;

  r = await post('/api/faces/people', { name: 'barack', groupIds: [gid('a4.jpg')] });
  assert.deepStrictEqual([r.status, r.body.code, r.body.otherId], [409, 'NAME_TAKEN', P.barack]);
  assert.ok(!/barack/i.test(r.body.error), 'no name inside the error text');
  assert.strictEqual(pidOf('a4.jpg') !== P.barack, true, 'nothing moved');

  assert.strictEqual(r.body.mergedInto, undefined);
  r = await post('/api/faces/people', { name: 'Barack', groupIds: [gid('a4.jpg')], mergeIfTaken: true });
  assert.deepStrictEqual([r.status, r.body.id, r.body.moved, r.body.mergedInto], [200, P.barack, [gid('a4.jpg')], P.barack]);
  assert.strictEqual(pidOf('a4.jpg'), P.barack);

  // unnamed; a face of a named person needs takeFromNamed
  r = await post('/api/faces/people', { groupIds: [gid('a3.jpg')] });
  assert.deepStrictEqual([r.status, r.body.code], [409, 'NO_FACES']);
  assert.deepStrictEqual(r.body.skipped, [{ groupId: gid('a3.jpg'), reason: 'other-named' }]);
  const before = one('SELECT COUNT(*) AS n FROM face_people').n;
  r = await post('/api/faces/people', { groupIds: [987654] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_people').n, before, 'nothing created');
  r = await post('/api/faces/people', { groupIds: [gid('a3.jpg')], takeFromNamed: true });
  assert.deepStrictEqual([r.status, r.body.name, r.body.files], [200, null, 1]);
  assert.strictEqual((await get(`/api/faces/people/${guy}`)).body.files, 0, 'the named one stays, empty');

  for (const bad of [{ groupIds: [1], name: 5 }, { groupIds: [1], name: 'x'.repeat(200) }, { groupIds: [] }, { groupIds: [1], mergeIfTaken: 1 }]) {
    assert.strictEqual((await post('/api/faces/people', bad)).status, 400, JSON.stringify(bad));
  }
});

/* ── E6 ─────────────────────────────────────────────────────────────────── */

test('E6 not a face (one face): hidden + not_face, person pruned, out of counts, kept across a re-check', async () => {
  // s1 is in Barack (E2); give it its own person first
  const ps = solo('s1.jpg');
  const g = gid('s1.jpg');
  const countsBefore = (await get('/api/faces/status')).body.counts;
  const r = await post(`/api/faces/groups/${g}/not-a-face`);
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  assert.deepStrictEqual(one('SELECT hidden, not_face FROM face_groups WHERE id = ?', g), { hidden: 1, not_face: 1 });
  assert.strictEqual((await get(`/api/faces/people/${ps}`)).status, 404, 'its unnamed person is gone');
  const countsAfter = (await get('/api/faces/status')).body.counts;
  assert.strictEqual(countsAfter.people, countsBefore.people - 1);
  assert.strictEqual(countsAfter.withFaces, countsBefore.withFaces - 1);
  assert.deepStrictEqual((await get(`/api/media/${ids['s1.jpg']}/faces`)).body.groups, []);
  assert.strictEqual((await post('/api/faces/groups/987654/not-a-face')).status, 404);

  await index(['s1.jpg'], { force: true });
  const [ng] = q('SELECT id, hidden, not_face, cluster_id FROM face_groups WHERE media_id = ?', ids['s1.jpg']);
  assert.notStrictEqual(ng.id, g, 're-checked: a new group');
  assert.deepStrictEqual([ng.hidden, ng.not_face, ng.cluster_id], [1, 1, null]);
});

test('E6 not a face (a person): all faces; unnamed pruned, named kept empty; carry-over', async () => {
  const pt = pidOf('t2.jpg');
  let r = await post(`/api/faces/people/${pt}/not-a-face`);
  assert.deepStrictEqual(r.body, { ok: true, groups: 1, person: null });
  assert.strictEqual((await get(`/api/faces/people/${pt}`)).status, 404);
  assert.deepStrictEqual(one('SELECT hidden, not_face FROM face_groups WHERE media_id = ?', ids['t2.jpg']), { hidden: 1, not_face: 1 });

  const pn = pidOf('n1.jpg');   // 'Other' (named)
  r = await post(`/api/faces/people/${pn}/not-a-face`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.groups, r.body.person.id, r.body.person.files], [1, pn, 0]);
  const list = (await get('/api/faces/people?filter=all&limit=500')).body.people.map(p => p.id);
  assert.ok(!list.includes(pn), 'an empty named person never shows');

  await index(['t2.jpg', 'n1.jpg'], { force: true });
  for (const n of ['t2.jpg', 'n1.jpg']) {
    assert.deepStrictEqual(one('SELECT hidden, not_face FROM face_groups WHERE media_id = ?', ids[n]), { hidden: 1, not_face: 1 }, n);
  }
  assert.strictEqual((await post('/api/faces/people/987654/not-a-face')).status, 404);
});

test('E6 a plain hide stays a plain hide across a re-check (not_face 0)', async () => {
  // a2's face was hidden in E2
  await index(['a2.jpg'], { force: true });
  assert.deepStrictEqual(one('SELECT hidden, not_face FROM face_groups WHERE media_id = ?', ids['a2.jpg']), { hidden: 1, not_face: 0 });
});

/* ── E5 ─────────────────────────────────────────────────────────────────── */

test('E5 status: recent files newest first with faces, people, names, direct flag and error; lastRun.withPeople', async () => {
  addFile('bad.jpg');
  fk.fileScripts.set(files['bad.jpg'], { error: 'ffmpeg exploded' });
  addFile('empty.jpg');
  fk.fileScripts.set(files['empty.jpg'], { groups: [] });
  await index(['mix.jpg', 'bad.jpg', 'empty.jpg'], { force: true });
  await post(`/api/media/${ids['o2.jpg']}/find-faces`, { force: true });
  await svc.sortPeopleNow();
  const s = (await get('/api/faces/status')).body.queue;
  const recent = s.recent;
  assert.ok(recent.length <= RECENT_MAX);
  assert.deepStrictEqual(Object.keys(recent[0]).sort(), ['direct', 'faces', 'filename', 'finishedAt', 'mediaId', 'names', 'ok', 'people']);
  assert.deepStrictEqual([recent[0].mediaId, recent[0].direct, recent[0].ok, recent[0].faces, recent[0].names],
    [ids['o2.jpg'], true, true, 1, ['Barack']]);
  const byId = new Map(recent.slice(1, 4).map(r => [r.mediaId, r]));
  assert.deepStrictEqual(new Set(byId.keys()), new Set([ids['mix.jpg'], ids['bad.jpg'], ids['empty.jpg']]));
  const mix = byId.get(ids['mix.jpg']);
  assert.deepStrictEqual([mix.ok, mix.direct, mix.faces, mix.people, [...mix.names].sort()], [true, false, 2, 2, ['Barack', 'Joe']]);
  const bad = byId.get(ids['bad.jpg']);
  assert.deepStrictEqual([bad.ok, bad.error, bad.faces], [false, 'ffmpeg exploded', 0]);
  assert.deepStrictEqual([byId.get(ids['empty.jpg']).faces, byId.get(ids['empty.jpg']).names], [0, []]);
  // a hidden person is neither named nor counted
  db.get().prepare('UPDATE face_people SET hidden = 1 WHERE id = ?').run(P.joe);
  const mixH = (await get('/api/faces/status')).body.queue.recent.find(r => r.mediaId === ids['mix.jpg']);
  assert.deepStrictEqual([mixH.faces, mixH.people, mixH.names], [2, 1, ['Barack']]);
  db.get().prepare('UPDATE face_people SET hidden = 0 WHERE id = ?').run(P.joe);
  assert.ok(recent.every((r, i) => i === 0 || r.finishedAt <= recent[i - 1].finishedAt), 'newest first');
  assert.deepStrictEqual([s.lastRun.total, s.lastRun.done, s.lastRun.failed, s.lastRun.withPeople], [3, 2, 1, 1]);
});

test('E5 queue: recent capped at 50, newest first, clicks flagged direct and outside the counts; progress + filename while running', async () => {
  const gates = new Map();
  const q2 = createQueue({
    workers: 1,
    runFile: (item, { onProgress }) => new Promise((resolve) => {
      onProgress({ fraction: 0.25 });
      gates.set(item.id, () => resolve(item.id % 3 === 0 ? false : { faces: item.id % 2 }));
    }),
  });
  const items = Array.from({ length: 55 }, (_, i) => ({ id: i + 1, filename: `f${i + 1}.jpg`, units: 1 }));
  q2.enqueue(items);
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  await flush();
  assert.deepStrictEqual(q2.status().current, [{ id: 1, filename: 'f1.jpg', progress: 0.25 }]);
  for (let id = 1; id <= 55; id++) { await flush(); gates.get(id)(); }
  await q2.settled();
  const direct = q2.runNow({ id: 100, filename: 'click.jpg' });
  await flush(); gates.get(100)(); await direct;
  const s = q2.status();
  assert.strictEqual(s.recent.length, RECENT_MAX);
  assert.deepStrictEqual(s.recent.slice(0, 3).map(r => [r.mediaId, r.direct, r.ok]), [[100, true, true], [55, false, true], [54, false, false]]);
  assert.strictEqual(s.recent.at(-1).mediaId, 7);
  assert.deepStrictEqual([s.lastRun.total, s.lastRun.done, s.lastRun.failed], [55, 37, 18], 'the click is not counted');
  // done files with faces: odd ids not divisible by 3
  const expectWith = items.filter(i => i.id % 3 !== 0 && i.id % 2 === 1).length;
  assert.strictEqual(s.lastRun.withPeople, expectWith);
  q2.clearRecent();
  assert.deepStrictEqual(q2.status().recent, []);
});

test('E1 likelyPerson tie: the person whose first result ranks higher', async () => {
  for (const [n, v] of [['u1.jpg', person(8)], ['u2.jpg', like(8, 0.8, 115)], ['v1.jpg', person(9)], ['v2.jpg', like(9, 0.98, 116)]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(v)] });
  }
  await index(['u1.jpg', 'u2.jpg', 'v1.jpg', 'v2.jpg']);
  const a = pidOf('u1.jpg'), b = pidOf('v1.jpg');
  assert.ok(a !== b && pidOf('u2.jpg') === a && pidOf('v2.jpg') === b);
  const v = new Float32Array(128); v[8] = 0.75; v[9] = 0.66;
  const r = await querySearch('q-tie', v);
  assert.deepStrictEqual(r.body.ids, [ids['u1.jpg'], ids['v1.jpg'], ids['v2.jpg'], ids['u2.jpg']], 'ranks A, B, B, A');
  assert.deepStrictEqual(r.body.likelyPerson, { id: a, name: null });
});

test('E5 vault lock forgets the recent list (file names)', () => {
  assert.ok(svc.queueStatus().recent.length > 0);
  svc.onVaultLocked();
  assert.deepStrictEqual(svc.queueStatus().recent, []);
  svc.onVaultUnlocked();
});

/* ── E7: detection and joining defaults (quality experiment 2) ───────────── */

test('E7 detection: score floor 0.80, faces with an SFace norm under 7 dropped, norm reported', async () => {
  const { createStubEngine, stubFrame } = require('../lib/faces/stub');
  const analyze = require('../lib/faces/analyze');
  assert.strictEqual(analyze.MIN_SCORE, 0.8);
  assert.strictEqual(require('../lib/faces/engine').DEFAULT_MIN_SCORE, 0.8);
  const eng = createStubEngine();
  const f = await analyze.analyzeFrame(eng, stubFrame([{ person: 1 }, { person: 2, variant: 150 }, { person: 3, variant: 200 }]));
  assert.deepStrictEqual(f.map(x => x.norm).sort(), [12, 8], 'the norm-5 face is dropped, the others carry their norm');
  const r = await analyze.analyzeFile(eng, { filepath: 'p1_p2v150_p3v200.jpg', kind: 'image' });
  assert.deepStrictEqual(r.groups.map(g => g.exemplars[0].norm).sort(), [12, 8]);
  // minNorm can be lowered per call (calibration harness)
  assert.strictEqual((await analyze.analyzeFrame(eng, stubFrame([{ person: 3, variant: 200 }]), { minNorm: 0 })).length, 1);
  // an engine without embedWithNorm (older fakes) keeps every face, norm null
  const old = { modelId: 'stub-v1', detect: eng.detect, embed: eng.embed };
  assert.deepStrictEqual((await analyze.analyzeFrame(old, stubFrame([{ person: 3, variant: 200 }]))).map(x => x.norm), [null]);
});

test('E7 storage: norm per vector and per group (the clearest exemplar); none on record = NULL', async () => {
  addFile('nv1.mp4', 'video');
  fk.fileScripts.set(files['nv1.mp4'], { groups: [group([person(60), like(60, 0.7, 118)], { norm: [11.5, 9.25] })] });
  addFile('nv2.jpg');
  fk.fileScripts.set(files['nv2.jpg'], { groups: [group(person(61))] });
  await index(['nv1.mp4', 'nv2.jpg']);
  assert.deepStrictEqual(q('SELECT norm FROM face_vectors WHERE media_id = ? ORDER BY id', ids['nv1.mp4']).map(r => r.norm), [11.5, 9.25]);
  assert.strictEqual(one('SELECT norm FROM face_groups WHERE media_id = ?', ids['nv1.mp4']).norm, 11.5);
  assert.strictEqual(one('SELECT norm FROM face_groups WHERE media_id = ?', ids['nv2.jpg']).norm, null);
});

test('E7 sorting: an unclear face (norm < 9) joins a person but never starts one; held faces join a person that appears later', async () => {
  // joins: close to an existing person
  addFile('lo-join.jpg');
  fk.fileScripts.set(files['lo-join.jpg'], { groups: [group(like(0, 0.9, 119), { norm: 8 })] });
  // a stranger, unclear: stays unsorted (held), searchable, shown on its file, not in the grid
  addFile('lo-alone.jpg');
  fk.fileScripts.set(files['lo-alone.jpg'], { groups: [group(person(62), { norm: 8 })] });
  // the same stranger with no norm on record (old data) starts a person as before
  addFile('old-alone.jpg');
  fk.fileScripts.set(files['old-alone.jpg'], { groups: [group(person(63))] });
  const peopleBefore = (await get('/api/faces/people?limit=500')).body.counts.all;
  await index(['lo-join.jpg', 'lo-alone.jpg', 'old-alone.jpg']);
  assert.strictEqual(pidOf('lo-join.jpg'), P.barack);
  assert.deepStrictEqual(one('SELECT cluster_id, sort_held FROM face_groups WHERE id = ?', gid('lo-alone.jpg')), { cluster_id: null, sort_held: 1 });
  assert.notStrictEqual(pidOf('old-alone.jpg'), null);
  assert.strictEqual((await get('/api/faces/people?limit=500')).body.counts.all, peopleBefore + 1, 'only old-alone made a person');
  assert.strictEqual((await get('/api/faces/status')).body.people.pending, 0, 'held faces are not pending work');
  const chips = (await get(`/api/media/${ids['lo-alone.jpg']}/faces`)).body.groups;
  assert.deepStrictEqual(chips.map(c => [c.id, c.personId]), [[gid('lo-alone.jpg'), null]]);
  const s = await post(`/api/faces/groups/${gid('lo-alone.jpg')}/similar`, {});
  assert.deepStrictEqual([s.body.ids, s.body.match[ids['lo-alone.jpg']].personId], [[ids['lo-alone.jpg']], null]);
  // a clear face of that stranger arrives: it starts a person, and the held face joins it
  addFile('hi-alone.jpg');
  fk.fileScripts.set(files['hi-alone.jpg'], { groups: [group(like(62, 0.9, 120), { norm: 12 })] });
  await index(['hi-alone.jpg']);
  assert.notStrictEqual(pidOf('hi-alone.jpg'), null);
  assert.deepStrictEqual(one('SELECT cluster_id, sort_held FROM face_groups WHERE id = ?', gid('lo-alone.jpg')), { cluster_id: pidOf('hi-alone.jpg'), sort_held: 0 });
  // a held face also gets its chance when the user makes a person from faces
  addFile('lo2.jpg'); addFile('lo3.jpg');
  fk.fileScripts.set(files['lo2.jpg'], { groups: [group(person(64), { norm: 8.5 })] });
  fk.fileScripts.set(files['lo3.jpg'], { groups: [group(like(64, 0.9, 121), { norm: 8.5 })] });
  await index(['lo2.jpg', 'lo3.jpg']);
  assert.deepStrictEqual([pidOf('lo2.jpg'), pidOf('lo3.jpg')], [null, null]);
  const made = await post('/api/faces/people', { name: 'Unclear', groupIds: [gid('lo2.jpg')] });
  assert.strictEqual(made.status, 200);
  await svc.sortPeopleNow();
  assert.strictEqual(pidOf('lo3.jpg'), made.body.id);
});

test('E7 sorting: a held face is retried against a person a user action changed (merge)', async () => {
  // two looks of one person, 0.52 apart (two people under the 0.56 join bar); an unclear third look, 0.52 to each: held
  for (const [n, noise, nrm] of [['g1.jpg', 122, 12], ['g2.jpg', 123, 12], ['g3.jpg', 124, 8]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(like(70, 0.72, noise), { norm: nrm })] });
    await index([n]);
  }
  const p1 = pidOf('g1.jpg'), p2 = pidOf('g2.jpg');
  assert.ok(p1 && p2 && p1 !== p2);
  assert.deepStrictEqual(one('SELECT cluster_id, sort_held FROM face_groups WHERE id = ?', gid('g3.jpg')), { cluster_id: null, sort_held: 1 });
  // merged, the person's centroid sits at 0.59 to the held face: it joins on the next run
  assert.strictEqual((await post('/api/faces/people/merge', { ids: [p1, p2], into: p1 })).status, 200);
  await svc.sortPeopleNow();
  assert.deepStrictEqual(one('SELECT cluster_id, sort_held FROM face_groups WHERE id = ?', gid('g3.jpg')), { cluster_id: p1, sort_held: 0 });
});

test('E7 might also be: a person-level score needs a margin over the next named person; likely >= 0.56, maybe >= 0.52', () => {
  const { CENTROID_RULE } = candidates;
  const th = require('../lib/faces/thresholds').peopleThresholds('stub-v1');
  const p = (vec, id = 1) => ({ groups: [{ id, model: 'm', vec }], centroids: new Map([['m', vec]]) });
  const unit = (pairs) => { const v = new Float32Array(128); let n = 0; for (const [i, x] of pairs) { v[i] = x; n += x * x; } for (const [i] of pairs) v[i] /= Math.sqrt(n); return v; };
  const target = p(unit([[0, 1]]));
  const other = p(unit([[1, 1]]));
  const at = (s, o = 0) => p(unit([[0, s], [1, o], [2, Math.sqrt(Math.max(0, 1 - s * s - o * o))]]), 9);
  const tierOf = (cand) => CENTROID_RULE.tier(CENTROID_RULE.score(target, cand, [other]), th);
  assert.strictEqual(tierOf(at(0.6)), 'likely');
  assert.strictEqual(tierOf(at(0.6, 0.57)), null, 'margin 0.03 < 0.05');
  assert.strictEqual(tierOf(at(0.6, 0.54)), 'likely', 'margin 0.06');
  assert.strictEqual(tierOf(at(0.53)), 'maybe');
  assert.strictEqual(tierOf(at(0.53, 0.5)), null, 'a maybe needs the margin too');
  assert.strictEqual(tierOf(at(0.5)), null, 'below the 0.52 floor');
  const r = CENTROID_RULE.score(target, at(0.6, 0.2), [other]);
  assert.strictEqual(r.groupId, 9);
  assert.ok(Math.abs(r.margin - 0.4) < 1e-6);
});

test('E7 re-check: a carried-over automatic person whose faces are all unclear is dissolved (held), like a fresh index', async () => {
  const at = (name) => one('SELECT cluster_id, sort_held FROM face_groups WHERE id = ?', gid(name));
  const files3 = { 'uc1.jpg': [person(80)], 'uc3a.jpg': [person(82)], 'uc3b.jpg': [like(82, 0.9, 130)], 'uc4.jpg': [person(83)] };
  for (const [n, vecs] of Object.entries(files3)) { addFile(n); fk.fileScripts.set(files[n], { groups: vecs.map(v => group(v)) }); }
  await index(Object.keys(files3));   // no norm on record: each starts (or joins) a person
  const pU1 = pidOf('uc1.jpg'), pU3 = pidOf('uc3a.jpg'), pU4 = pidOf('uc4.jpg');
  assert.ok(pU1 && pU3 && pU4 && pidOf('uc3b.jpg') === pU3);
  assert.strictEqual((await post(`/api/faces/people/${pU4}`, { name: 'Kept' })).status, 200);
  // The same faces measured unclear on a re-check.
  for (const n of ['uc1.jpg', 'uc3b.jpg', 'uc4.jpg']) fk.fileScripts.set(files[n], { groups: files3[n].map(v => group(v, { norm: 8 })) });
  await index(['uc1.jpg', 'uc3b.jpg', 'uc4.jpg'], { force: true });
  // u1: its person is gone and the face is held, the state a fresh index of an unclear stranger gives
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', pU1), undefined);
  assert.deepStrictEqual(at('uc1.jpg'), { cluster_id: null, sort_held: 1 });
  addFile('uc5.jpg');
  fk.fileScripts.set(files['uc5.jpg'], { groups: [group(person(84), { norm: 8 })] });
  await index(['uc5.jpg']);
  assert.deepStrictEqual(at('uc5.jpg'), at('uc1.jpg'));
  // a person with one clear face (no norm on record) keeps the unclear one; a named person is the user's
  assert.deepStrictEqual([pidOf('uc3a.jpg'), pidOf('uc3b.jpg')], [pU3, pU3]);
  assert.strictEqual(pidOf('uc4.jpg'), pU4);
});

test('held faces join a person a user makes or grows before the request answers (no background run needed)', async () => {
  for (const [n, v] of [['hd1.jpg', person(95)], ['hd2.jpg', like(95, 0.9, 132)], ['hd3.jpg', person(96)], ['hd4.jpg', like(96, 0.9, 133)], ['hd5.jpg', like(96, 0.3, 134)]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(v, { norm: n === 'hd5.jpg' ? 12 : 8.5 })] });
  }
  await index(['hd1.jpg', 'hd2.jpg', 'hd3.jpg', 'hd4.jpg']);
  for (const n of ['hd1.jpg', 'hd2.jpg', 'hd3.jpg', 'hd4.jpg']) {
    assert.deepStrictEqual(one('SELECT cluster_id, sort_held FROM face_groups WHERE id = ?', gid(n)), { cluster_id: null, sort_held: 1 }, n);
  }
  // E3 from one held face: the other held face is in the answer and the search at once
  const made = await post('/api/faces/people', { name: 'Held Pair', groupIds: [gid('hd1.jpg')] });
  assert.strictEqual(made.status, 200);
  assert.strictEqual(pidOf('hd2.jpg'), made.body.id, 'joined inside the request');
  assert.strictEqual(made.body.files, 2);
  const s = await post(`/api/faces/groups/${gid('hd1.jpg')}/similar`, {});
  assert.strictEqual(s.body.match[ids['hd2.jpg']].personId, made.body.id);
  // E2 add: a clear person far from them (0.3); adding one held face moves its centroid within reach of the other
  await index(['hd5.jpg']);
  const p5 = pidOf('hd5.jpg');
  assert.ok(p5);
  const added = await post(`/api/faces/people/${p5}/add`, { groupIds: [gid('hd3.jpg')] });
  assert.strictEqual(added.status, 200);
  assert.strictEqual(pidOf('hd4.jpg'), p5);
  assert.strictEqual(added.body.person.files, 3);
});

test('Undo: unhide puts a not-a-face face back (into its person, or sorted again); unreject takes back a "different"', async () => {
  for (const [n, v] of [['nf1.jpg', person(90)], ['nf2.jpg', like(90, 0.9, 131)], ['nf3.jpg', person(91)]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(v)] });
  }
  await index(['nf1.jpg', 'nf2.jpg', 'nf3.jpg']);
  const p = pidOf('nf1.jpg');
  assert.ok(p && pidOf('nf2.jpg') === p);
  const g1 = gid('nf1.jpg');
  assert.strictEqual((await post(`/api/faces/groups/${g1}/not-a-face`)).status, 200);
  assert.deepStrictEqual(one('SELECT hidden, not_face FROM face_groups WHERE id = ?', g1), { hidden: 1, not_face: 1 });
  let r = await post(`/api/faces/groups/${g1}/unhide`);
  assert.deepStrictEqual([r.status, r.body.personId], [200, p]);
  assert.deepStrictEqual(one('SELECT hidden, not_face, cluster_id FROM face_groups WHERE id = ?', g1), { hidden: 0, not_face: 0, cluster_id: p });
  assert.deepStrictEqual((await get(`/api/media/${ids['nf1.jpg']}/faces`)).body.groups.map(x => [x.id, x.personId]), [[g1, p]]);
  // alone: its unnamed person was pruned with it; back, it is sorted into a person again
  const g3 = gid('nf3.jpg');
  await post(`/api/faces/groups/${g3}/not-a-face`);
  assert.strictEqual(pidOf('nf3.jpg'), null);
  assert.strictEqual((await post(`/api/faces/groups/${g3}/unhide`)).status, 200);
  await svc.sortPeopleNow();
  const p3 = pidOf('nf3.jpg');
  assert.ok(p3 && p3 !== p);
  assert.strictEqual((await post('/api/faces/groups/999999/unhide')).status, 404);
  // unreject
  r = await post(`/api/faces/people/${p}/candidates`, { reject: [p3] });
  assert.deepStrictEqual(r.body.rejected, [p3]);
  const pair = [Math.min(p, p3), Math.max(p, p3)];
  assert.ok(one('SELECT 1 AS x FROM face_pair_decisions WHERE a = ? AND b = ?', ...pair));
  r = await post(`/api/faces/people/${p}/candidates`, { unreject: [p3] });
  assert.deepStrictEqual([r.status, r.body.unrejected, r.body.merged, r.body.rejected], [200, [p3], [], []]);
  assert.strictEqual(one('SELECT 1 AS x FROM face_pair_decisions WHERE a = ? AND b = ?', ...pair), undefined);
  assert.strictEqual((await post(`/api/faces/people/${p}/candidates`, { unreject: [p] })).status, 400);
  assert.strictEqual((await post(`/api/faces/people/${p}/candidates`, { reject: [p3], unreject: [p3] })).status, 400);
});

test('E5 delete-all forgets recent files and lastRun', async () => {
  assert.notStrictEqual((await get('/api/faces/status')).body.queue.lastRun, null);
  assert.strictEqual((await post('/api/faces/delete-all')).status, 200);
  const s = (await get('/api/faces/status')).body.queue;
  assert.deepStrictEqual([s.lastRun, s.recent], [null, []]);
});
