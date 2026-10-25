/**
 * People server, fix round 1: stats cache vs the sorting job, centroid
 * memory, names held by people the grid does not show, "Not this person"
 * re-sorting and its exact undo (restore), suggestions with hidden people and
 * the cap, pruning emptied people, the cover index.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-people-fixes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;
fs.writeFileSync(process.env.VAULT_SETTINGS_FILE, JSON.stringify({ facesEnabled: true }));

const db = require('../lib/database');
const faces = require('../lib/faces/service');
const store = require('../lib/faces/store');
const people = require('../lib/faces/people');
const { createSorter, createCentroids, MAX_SUGGESTIONS } = require('../lib/faces/people-sort');
const { app } = require('../server/index');
const { person, like, group, createFakes, DIM } = require('./helpers/faces-fakes');

const fk = createFakes();
const svc = faces.setInstance(faces.createService({
  modelStore: fk.modelStore, engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames,
  peopleDebounceMs: 60000,
}));

let server, base;
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
const post = async (p, body) => { const r = await fetch(base + p, json(body)); return { status: r.status, body: await r.json() }; };
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const q = (sql, ...a) => db.get().prepare(sql).all(...a);
const one = (sql, ...a) => db.get().prepare(sql).get(...a);

let n = 0;
/** A checked file with these face groups (straight through the store). */
function file(groups) {
  const mid = Number(db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'image')")
    .run(path.join(tmp, `m${++n}.jpg`), `m${n}.jpg`).lastInsertRowid);
  store.saveFileResult(mid, 'stub-v1', { groups });
  return mid;
}
const pidsOf = (mid) => q('SELECT cluster_id AS c FROM face_groups WHERE media_id = ? ORDER BY id', mid).map(r => r.c);
const gidsOf = (mid) => q('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', mid).map(r => r.id);
const sort = () => svc.sortPeopleNow();

test.before(async () => {
  db.init();
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

test('stats: the sorting job\'s writes do not drop the stats cache (user and file writes do); status total is a count', async () => {
  const a = file([group(person(0))]);
  file([group(like(0, 0.9, 100))]);
  await sort();
  const m1 = people.statsMap();
  store.bumpPeople({ background: true });
  assert.strictEqual(people.statsMap(), m1, 'a background write keeps the cache');
  // The job sorting a face is a background write: the cached stats stay (for up to 2 s).
  db.get().prepare('UPDATE face_groups SET cluster_id = NULL WHERE media_id = ?').run(a);
  people.resetCaches();
  const m2 = people.statsMap();
  await sort();
  assert.ok(pidsOf(a)[0] != null);
  assert.strictEqual(people.statsMap(), m2, 'the job sorting faces did not force a recompute');
  // A user's edit does.
  await post(`/api/faces/people/${pidsOf(a)[0]}`, { favorite: true });
  assert.notStrictEqual(people.statsMap(), m2);
  // A face write does too.
  const m3 = people.statsMap();
  file([group(person(1))]);
  assert.notStrictEqual(people.statsMap(), m3);
  await sort();
  people.resetCaches();
  const s = (await get('/api/faces/status')).body.people;
  const l = (await get('/api/faces/people')).body;
  assert.strictEqual(s.total, l.counts.all);
  assert.strictEqual(s.total, 2);
});

test('centroids: float32 sums in fixed blocks (no growth copies), people dropped when emptied', () => {
  const c = createCentroids();
  const v = (i) => { const x = new Float32Array(DIM); x[i % DIM] = 1; return x; };
  for (let i = 1; i <= 3000; i++) c.add(i, v(i), { requant: false });
  c.finish();
  assert.strictEqual(c.size(), 3000);
  const perPerson = 4 + 4 + DIM * 4 + DIM;   // pid, count, float32 sums, int8 scores
  assert.strictEqual(c.bytes(), Math.ceil(3000 / 1024) * 1024 * perPerson);
  assert.ok(perPerson < 700);
  const qv = new Int8Array(DIM); qv[5] = 127;
  assert.strictEqual(c.best(qv).pid, 5);
  c.sub(5, v(5));
  assert.strictEqual(c.has(5), false);
  assert.notStrictEqual(c.best(qv).pid, 5, 'an emptied person is never matched');
  assert.strictEqual(c.size(), 2999);
  // two faces, take one out: the other still defines the person
  const c2 = createCentroids();
  c2.add(1, v(7)); c2.add(1, v(8)); c2.add(2, v(9));
  c2.sub(1, v(8));
  const q7 = new Int8Array(DIM); q7[7] = 127;
  assert.deepStrictEqual(c2.best(q7), { pid: 1, score: 1 });
});

test('names: a person the grid does not show (trashed files only, hidden faces only) gives its name up without a prompt', async () => {
  // trashed only
  const t1 = file([group(person(10))]);
  await sort();
  const ann = pidsOf(t1)[0];
  await post(`/api/faces/people/${ann}`, { name: 'Ann', favorite: true });
  db.get().prepare('UPDATE media SET user_trashed = 1 WHERE id = ?').run(t1);
  const b1 = file([group(person(11))]);
  await sort();
  const bea = pidsOf(b1)[0];
  people.resetCaches();
  assert.ok(!(await get('/api/faces/people')).body.people.some(p => p.name === 'Ann'));
  let r = await post(`/api/faces/people/${bea}`, { name: 'ann' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual([r.body.id, r.body.name, r.body.favorite], [bea, 'ann', true]);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', ann), undefined, 'merged in');
  assert.deepStrictEqual(pidsOf(t1), [bea], 'its trashed face came along (restoring the file shows it under the name)');

  // hidden faces only (a named person keeps its hidden faces)
  const h1 = file([group(person(12))]);
  await sort();
  const cy = pidsOf(h1)[0];
  await post(`/api/faces/people/${cy}`, { name: 'Cy' });
  await post(`/api/faces/groups/${gidsOf(h1)[0]}/hide`, {});
  assert.ok(one('SELECT id FROM face_people WHERE id = ?', cy), 'named: kept');
  const d1 = file([group(person(13))]);
  await sort();
  r = await post(`/api/faces/people/${pidsOf(d1)[0]}`, { name: 'Cy' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, pidsOf(d1)[0]);

  // a person the user HID is shown (under Hidden): still asks
  const e1 = file([group(person(14))]);
  const f1 = file([group(person(15))]);
  await sort();
  await post(`/api/faces/people/${pidsOf(e1)[0]}`, { name: 'Eve', hidden: true });
  r = await post(`/api/faces/people/${pidsOf(f1)[0]}`, { name: 'Eve' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'NAME_TAKEN');
  assert.strictEqual(r.body.otherId, pidsOf(e1)[0]);
  assert.ok(!/Eve/.test(r.body.error), 'no names inside message strings');
});

test('not-in: faces are sorted again without that person: they stay together, or join a person who fits; restore undoes exactly', async () => {
  // Gil (person 20) in two files; a file with two faces of person 21 that were wrongly put into Gil.
  const g1 = file([group(person(20))]);
  const g2 = file([group(like(20, 0.9, 101))]);
  await sort();
  const gil = pidsOf(g1)[0];
  const w = file([group(like(21, 0.9, 102)), group(like(21, 0.88, 103))]);
  await sort();
  const wrong = pidsOf(w);
  db.get().prepare('UPDATE face_groups SET cluster_id = ? WHERE media_id = ?').run(gil, w);
  store.bumpPeople();
  const before = gidsOf(w);
  let r = await post(`/api/faces/people/${gil}/not-in`, { mediaId: w });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.person.id, gil);
  assert.strictEqual(r.body.person.files, 2);
  assert.strictEqual(r.body.moved.length, 2);
  for (const m of r.body.moved) assert.deepStrictEqual(Object.keys(m).sort(), ['groupId', 'newPerson', 'personId']);
  const [m1, m2] = r.body.moved;
  assert.strictEqual(m1.personId, m2.personId, 'two faces of one person in that file end up together');
  assert.deepStrictEqual([m1.newPerson, m2.newPerson].sort(), [false, true]);
  assert.ok(!wrong.includes(gil));
  assert.deepStrictEqual(q('SELECT person_id AS p, group_id AS g FROM face_person_rejects ORDER BY group_id'),
    before.map(g => ({ p: gil, g })));

  // undo: restore puts exactly those faces back, the rejects go, the emptied new person goes
  const newP = m1.personId;
  r = await post(`/api/faces/people/${gil}/restore`, { groupIds: r.body.moved.map(m => m.groupId) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.id, gil);
  assert.strictEqual(r.body.files, 3);
  assert.deepStrictEqual(pidsOf(w), [gil, gil]);
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_person_rejects').n, 0);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', newP), undefined);
  for (const bad of [{}, { groupIds: [] }, { groupIds: ['x'] }, { groupIds: [1, 1] }]) {
    assert.strictEqual((await post(`/api/faces/people/${gil}/restore`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await post(`/api/faces/people/${gil}/restore`, { groupIds: [999999] })).status, 404);

  // a face that fits ANOTHER existing person joins it; undo moves only that face back
  const h1 = file([group(person(22))]);
  const h2 = file([group(like(22, 0.9, 104))]);
  await sort();
  const hal = pidsOf(h1)[0];
  const x = file([group(like(22, 0.92, 105))]);
  await sort();
  assert.strictEqual(pidsOf(x)[0], hal);
  db.get().prepare('UPDATE face_groups SET cluster_id = ? WHERE media_id = ?').run(gil, x);
  store.bumpPeople();
  r = await post(`/api/faces/people/${gil}/not-in`, { mediaId: x });
  assert.deepStrictEqual(r.body.moved, [{ groupId: gidsOf(x)[0], personId: hal, newPerson: false }]);
  r = await post(`/api/faces/people/${gil}/restore`, { groupIds: [gidsOf(x)[0]] });
  assert.deepStrictEqual(pidsOf(x), [gil]);
  assert.deepStrictEqual(pidsOf(h1).concat(pidsOf(h2)), [hal, hal], 'the other person kept its own faces');
  void g2;
});

test('not-in without a current centroid cache (after a lock) still re-sorts and answers', async () => {
  const a = file([group(person(30))]);
  const b = file([group(like(30, 0.9, 106))]);
  await sort();
  const p = pidsOf(a)[0];
  const c = file([group(like(31, 0.9, 107))]);
  await sort();
  db.get().prepare('UPDATE face_groups SET cluster_id = ? WHERE media_id = ?').run(p, c);
  store.bumpPeople();
  svc.onVaultLocked();
  svc.onVaultUnlocked();
  assert.strictEqual(svc._sorter._cache(), null);
  const r = await post(`/api/faces/people/${p}/not-in`, { mediaId: c });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.moved.length, 1);
  assert.ok(r.body.moved[0].personId != null && r.body.moved[0].personId !== p);
  assert.strictEqual(pidsOf(c)[0], r.body.moved[0].personId);
  void b;
});

test('pruning: not-in on the only file and hiding the last visible face remove an unnamed person', async () => {
  const a = file([group(person(40))]);
  await sort();
  const p = pidsOf(a)[0];
  const r = await post(`/api/faces/people/${p}/not-in`, { mediaId: a });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.person, null);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', p), undefined);
  assert.ok(r.body.moved[0].personId !== p);

  const b = file([group(person(41))]);
  await sort();
  const pb = pidsOf(b)[0];
  await post(`/api/faces/groups/${gidsOf(b)[0]}/hide`, {});
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', pb), undefined);
  assert.deepStrictEqual(pidsOf(b), [null], 'the hidden face is detached, and never sorted again');
  await sort();
  assert.deepStrictEqual(pidsOf(b), [null]);
  // favorite: kept
  const c = file([group(person(42))]);
  await sort();
  const pc = pidsOf(c)[0];
  await post(`/api/faces/people/${pc}`, { favorite: true });
  await post(`/api/faces/groups/${gidsOf(c)[0]}/hide`, {});
  assert.ok(one('SELECT id FROM face_people WHERE id = ?', pc));
});

/** A unit vector from [axis, weight] pairs. */
function unit(pairs) {
  const v = new Float32Array(DIM);
  let n2 = 0;
  for (const [, x] of pairs) n2 += x * x;
  for (const [i, x] of pairs) v[i] = x / Math.sqrt(n2);
  return v;
}
const suggestion = (x, y) => one('SELECT score FROM face_person_suggestions WHERE a = ? AND b = ?', Math.min(x, y), Math.max(x, y));
const pairsOf = (x) => one('SELECT COUNT(*) AS n FROM face_person_suggestions WHERE a = ? OR b = ?', x, x).n;
/** A person made by the user from one face with this vector (wherever the job first put it). */
async function madePerson(vec) {
  const m = file([group(vec)]);
  await sort();
  const r = await post('/api/faces/people', { groupIds: gidsOf(m), takeFromNamed: true });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await sort();
  return r.body.id;
}

test('suggestions: person level, score >= 0.54 with a 0.04 margin over the second-best person; never two named people', async () => {
  const a1 = file([group(person(70))]);
  await sort();
  const ann = pidsOf(a1)[0];
  assert.strictEqual((await post(`/api/faces/people/${ann}`, { name: 'Sugg Ann' })).status, 200);
  // 0.60 to Ann, nobody else close: asked
  const u1 = await madePerson(unit([[70, 0.6], [120, 0.8]]));
  assert.ok(Math.abs(suggestion(u1, ann).score - 0.6) < 0.01, 'a clear near miss is asked');
  // 0.52 to Ann: below the bar
  const u2 = await madePerson(unit([[70, 0.52], [121, Math.sqrt(1 - 0.52 * 0.52)]]));
  assert.strictEqual(pairsOf(u2), 0, 'below 0.54 is not asked');
  // 0.58 to one person and 0.56 to another: no margin, not asked
  const b1 = file([group(person(72))]);
  const c1 = file([group(person(73))]);
  await sort();
  // named, so only the new person is the unnamed side of a question
  assert.strictEqual((await post(`/api/faces/people/${pidsOf(b1)[0]}`, { name: 'Sugg Bea' })).status, 200);
  assert.strictEqual((await post(`/api/faces/people/${pidsOf(c1)[0]}`, { name: 'Sugg Cy' })).status, 200);
  const u3 = await madePerson(unit([[72, 0.58], [73, 0.56], [122, Math.sqrt(1 - 0.58 * 0.58 - 0.56 * 0.56)]]));
  assert.strictEqual(pairsOf(u3), 0, 'too close to two people');
  // 0.62 vs 0.50: margin 0.12, asked (with the closer one)
  const d1 = file([group(person(74))]);
  file([group(person(75))]);
  await sort();
  assert.strictEqual((await post(`/api/faces/people/${pidsOf(d1)[0]}`, { name: 'Sugg Dee' })).status, 200);
  const u4 = await madePerson(unit([[74, 0.62], [75, 0.5], [123, Math.sqrt(1 - 0.62 * 0.62 - 0.5 * 0.5)]]));
  assert.ok(suggestion(u4, pidsOf(d1)[0]));
  assert.strictEqual(pairsOf(u4), 1);
  // the job finds it too when a person GROWS into a near miss of a named person (no user action)
  const g1 = file([group(person(76))]);
  await sort();
  const gp = pidsOf(g1)[0];
  assert.strictEqual((await post(`/api/faces/people/${gp}`, { name: 'Sugg Gil' })).status, 200);
  const n1 = file([group(like(76, 0.45, 124))]);
  await sort();
  const np = pidsOf(n1)[0];
  assert.notStrictEqual(np, gp);
  assert.strictEqual(pairsOf(np), 0, 'one face at 0.45: nothing to ask');
  file([group(unit([[76, 0.6], [124, 0.6]]))]);   // joins the stranger and pulls it to ~0.59
  await sort();
  assert.ok(suggestion(np, gp), 'person-level score crossed the bar after it grew');
  // naming the unnamed side the same as... anyone named: the pair goes (never two named people)
  assert.strictEqual((await post(`/api/faces/people/${u1}`, { name: 'Sugg Una' })).status, 200);
  await sort();
  assert.strictEqual(pairsOf(u1), 0, 'two named people are never asked about');
});

test('suggestions: never with a hidden person; hiding drops pairs; capped at the best 500, named-vs-unnamed first', async () => {
  const h = file([group(person(50))]);
  await sort();
  const ph = pidsOf(h)[0];
  await post(`/api/faces/people/${ph}`, { hidden: true });
  const near = await madePerson(unit([[50, 0.62], [108, 0.78]]));
  assert.strictEqual(pairsOf(ph), 0);
  assert.strictEqual(pairsOf(near), 0);
  // hiding a person drops its pairs
  const v1 = file([group(person(51))]);
  await sort();
  const pv = pidsOf(v1)[0];
  await madePerson(unit([[51, 0.62], [109, 0.78]]));
  assert.strictEqual(pairsOf(pv), 1);
  await post(`/api/faces/people/${pv}`, { hidden: true });
  assert.strictEqual(pairsOf(pv), 0);

  assert.strictEqual(MAX_SUGGESTIONS, 500);
  const k1 = file([group(person(52))]);
  await sort();
  const kp = pidsOf(k1)[0];
  const ku = await madePerson(unit([[52, 0.62], [110, 0.78]]));
  assert.strictEqual((await post(`/api/faces/people/${kp}`, { name: 'Sugg Kim' })).status, 200);
  await sort();
  assert.ok(suggestion(ku, kp));
  db.get().prepare('UPDATE face_person_suggestions SET score = 0.01 WHERE a = ? AND b = ?').run(Math.min(ku, kp), Math.max(ku, kp));
  const ins = db.get().prepare('INSERT OR IGNORE INTO face_person_suggestions (a, b, score) VALUES (?, ?, ?)');
  db.get().transaction(() => { for (let i = 0; i < 600; i++) ins.run(100000 + i, 200000 + i, 0.6 + i / 10000); })();
  await sort();
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_person_suggestions').n, MAX_SUGGESTIONS);
  assert.ok(suggestion(ku, kp), 'a named-vs-unnamed pair outranks a higher score between two unnamed people');
  const kept = one('SELECT COUNT(*) AS n, MIN(score) AS s FROM face_person_suggestions WHERE a >= 100000');
  assert.ok(kept.n > 0 && kept.n < 500);
  assert.ok(Math.abs(kept.s - (0.6 + (600 - kept.n) / 10000)) < 1e-9, 'the best scores stay');
  db.get().exec('DELETE FROM face_person_suggestions WHERE a >= 100000');
});

/** Every pair, as the incremental job left it, and as a full re-score of everyone (user-change mode) makes it. */
async function incrementalVsFull() {
  const all = () => q('SELECT a, b, score FROM face_person_suggestions WHERE a < 100000 ORDER BY a, b').map(r => `${r.a}-${r.b}`);
  const inc = all();
  db.get().exec('DELETE FROM face_person_suggestions');
  svc._sorter.markDirty(q('SELECT id FROM face_people').map(r => r.id));
  await sort();
  return { inc, full: all() };
}

test('incremental re-score ends where a full one does: stale pairs go, also with people that did not change', async () => {
  // The verifier's case: X named; u near X; W1 and W2 each near u; W1 and W2 merged.
  const x1 = file([group(person(90))]);
  await sort();
  const X = pidsOf(x1)[0];
  assert.strictEqual((await post(`/api/faces/people/${X}`, { name: 'Sugg Xena' })).status, 200);
  const w1m = file([group(unit([[91, 0.64], [92, 0.768]]))]);
  const w2m = file([group(unit([[91, 0.64], [93, 0.768]]))]);
  await sort();
  const u = await madePerson(unit([[90, 0.62], [91, 0.78]]));
  const W1 = pidsOf(w1m)[0], W2 = pidsOf(w2m)[0];
  assert.ok(suggestion(u, X));
  assert.strictEqual((await post('/api/faces/people/merge', { ids: [W1, W2], into: W1 })).status, 200);
  await sort();
  let r = await incrementalVsFull();
  assert.deepStrictEqual(r.inc, r.full);
  assert.ok(suggestion(u, X) && suggestion(u, W1), 'u is X\'s question; the merged W1 picks u');

  // A user grows named Y toward u: Y is now u's best named person, so u's pair
  // with X (a person nothing happened to) has to go.
  const y1 = file([group(unit([[94, 1]]))]);
  await sort();
  const Y = pidsOf(y1)[0];
  await post(`/api/faces/people/${Y}`, { name: 'Sugg Yul' });
  // put Y right next to u: give it u's direction (a user adds a face to Y)
  const yface = file([group(unit([[90, 0.6], [91, 0.79], [94, 0.1]]))]);
  await sort();
  await post(`/api/faces/people/${Y}/add`, { groupIds: gidsOf(yface), takeFromNamed: true });
  await sort();
  assert.strictEqual(suggestion(u, X), undefined, 'the pair with untouched X is gone');
  assert.ok(suggestion(u, Y));
  r = await incrementalVsFull();
  assert.deepStrictEqual(r.inc, r.full);
});

test('Might also be answers re-score: None of these / ✕ drops the "Same person?" pair, their Undo brings it back', async () => {
  const z1 = file([group(person(96))]);
  await sort();
  const Z = pidsOf(z1)[0];
  assert.strictEqual((await post(`/api/faces/people/${Z}`, { name: 'Sugg Zed' })).status, 200);
  const u = await madePerson(unit([[96, 0.65], [97, 0.76]]));
  assert.ok(suggestion(u, Z));
  let r = await post(`/api/faces/people/${Z}/candidates`, { reject: [u] });
  assert.deepStrictEqual(r.body.rejected, [u]);
  await sort();
  assert.strictEqual(pairsOf(u), 0, 'answered different: not asked');
  r = await post(`/api/faces/people/${Z}/candidates`, { unreject: [u] });
  assert.deepStrictEqual(r.body.unrejected, [u]);
  await sort();
  assert.ok(suggestion(u, Z), 'the Undo brings the question back');
  // the review's own "No" re-scores too: nothing else close, so nothing new is asked
  await post('/api/faces/review', { a: u, b: Z, answer: 'different' });
  await sort();
  assert.strictEqual(pairsOf(u), 0);
});

test('suggestions made by an older rule are dropped once and everyone is scored again', async () => {
  // The one-time pass scores everyone against NAMED people (cheap at any size); pairs of two
  // unnamed people come back only as those people change.
  const real = () => q(`SELECT s.a, s.b FROM face_person_suggestions s JOIN face_people pa ON pa.id = s.a JOIN face_people pb ON pb.id = s.b
    WHERE s.a < 100000 AND (pa.name IS NULL) != (pb.name IS NULL) ORDER BY s.a, s.b`);
  const before = real();
  assert.ok(before.length >= 2);
  assert.ok(one("SELECT value FROM face_meta WHERE key = 'suggest_rule'").value, 'the job wrote which rule made the pairs');
  db.get().prepare("UPDATE face_meta SET value = 'group-0.46' WHERE key = 'suggest_rule'").run();
  db.get().prepare('INSERT INTO face_person_suggestions (a, b, score) VALUES (100001, 200001, 0.47)').run();
  db.get().prepare('DELETE FROM face_person_suggestions WHERE a = ? AND b = ?').run(before[0].a, before[0].b);
  // a fresh process (a new sorter) after an update
  const s2 = createSorter({ database: db, store, debounceMs: 60000 });
  await s2.runNow();
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_person_suggestions WHERE a >= 100000').n, 0, 'old pairs are gone');
  // every person was scored again: the dropped pair is back
  const now = real().map(p => `${p.a}-${p.b}`);
  for (const p of before) assert.ok(now.includes(`${p.a}-${p.b}`), JSON.stringify(p));
  const rule = one("SELECT value FROM face_meta WHERE key = 'suggest_rule'").value;
  assert.notStrictEqual(rule, 'group-0.46');
  // only once: the next process keeps what is there
  db.get().prepare('INSERT INTO face_person_suggestions (a, b, score) VALUES (100001, 200001, 0.6)').run();
  const s3 = createSorter({ database: db, store, debounceMs: 60000 });
  await s3.runNow();
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_person_suggestions WHERE a >= 100000').n, 1);
  db.get().exec('DELETE FROM face_person_suggestions WHERE a >= 100000');
});

test('schema: face_people.cover_group_id is indexed', () => {
  assert.ok(q('PRAGMA index_list(face_people)').some(i => i.name === 'idx_face_people_cover'));
});

test('screen time for faces checked before screen_s existed: appearances x stored spacing, else the spacing the file would get now', async () => {
  const d = db.get();
  const video = (dur, stored = null) => Number(d.prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, 'video', ?)")
    .run(path.join(tmp, `v${++n}.mp4`), `v${n}.mp4`, dur).lastInsertRowid);
  const short = video(100), long = video(10000), known = video(100);
  for (const mid of [short, long, known]) {
    store.saveFileResult(mid, 'stub-v1', { groups: [group(person(60), { appearances: 10, firstTimeS: 1 })] }, { isVideo: true });
  }
  const pic = file([group(like(60, 0.9, 111))]);
  // as an older library has them: screen_s NULL; one file knows its spacing
  d.exec('UPDATE face_groups SET screen_s = NULL');
  d.prepare('UPDATE media SET faces_interval_s = 7 WHERE id = ?').run(known);
  await sort();
  const p = pidsOf(short)[0];
  assert.deepStrictEqual([short, long, known, pic].map(m => pidsOf(m)[0]), [p, p, p, p]);
  people.resetCaches();
  const r = (await get(`/api/faces/people/${p}`)).body;
  // 10 x max(3.5, 100/2000) + 10 x max(3.5, 10000/2000) + 10 x 7; the photo adds nothing
  assert.strictEqual(r.screenS, 35 + 50 + 70);
  assert.deepStrictEqual((await get(`/api/faces/people/${p}/files`)).body.ids, [known, long, short, pic]);
  // a different interval setting moves the files that don't know their spacing
  await post('/api/faces/settings', { intervalS: 10 });
  assert.strictEqual((await get(`/api/faces/people/${p}`)).body.screenS, 100 + 100 + 70);
  await post('/api/faces/settings', { intervalS: 3.5 });

  // from now on the spacing used is stored with the file (videos only)
  store.saveFileResult(short, 'stub-v1', { groups: [group(person(60), { appearances: 4 })] }, { isVideo: true, screenIntervalS: 2.5 });
  assert.strictEqual(one('SELECT faces_interval_s AS s FROM media WHERE id = ?', short).s, 2.5);
  assert.strictEqual(one('SELECT screen_s FROM face_groups WHERE media_id = ?', short).screen_s, 10);
  assert.strictEqual(one('SELECT faces_interval_s AS s FROM media WHERE id = ?', pic).s, null);
});

test('queue: pause with nothing queued or running stays idle; resume after it is harmless', async () => {
  let r = await post('/api/faces/queue/pause', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.running, r.body.paused], [false, false]);
  r = await post('/api/faces/queue/resume', {});
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.running, r.body.paused], [false, false]);
  // with work queued, pause still pauses
  const { createQueue } = require('../lib/faces/queue');
  let release;
  const gate = new Promise(res => { release = res; });
  const qq = createQueue({ runFile: () => gate, workers: 1 });
  assert.strictEqual(qq.pause().paused, false);
  qq.enqueue([{ id: 1 }, { id: 2 }]);
  assert.strictEqual(qq.pause().paused, true);
  release(true);
  await qq.settled();
  assert.deepStrictEqual([qq.status().running, qq.status().paused], [true, true], 'the queued file waits for Resume');
  qq.resume();
  await qq.settled();
  assert.strictEqual(qq.status().running, false);
});
