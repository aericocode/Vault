/**
 * Faces round 4 (FACES_REVIEW_SPEC), server side, over HTTP against the real
 * Express app with the stub engine (no models, no network):
 *   A  the stricter join rule (bar, margin over the second-best person, the
 *      named bar), the one-time re-check of automatic joins (confirmed,
 *      hidden, covers untouched; runs once; sliced and resumable), the model
 *      switch asking for it again, and older versions opening the library
 *   B  the endpoints the review needs: review-faces (Yes / No), move
 *      (Compare), check-faces (the cards), and "Might also be" offering a
 *      face the re-check took out
 *
 * Library (stub-v1 = SFace numbers: join 0.56, margin 0.05; embeddings from
 * basis vectors, helpers/faces-fakes.js):
 *   x1 x2   Xena (basis 20), named      y1 y2   Yuri (basis 21), named
 *   cl      0.75 to Xena only: joins her
 *   mg      0.70 to Xena and 0.68 to Yuri: no margin, its own person
 *   lo      0.53 to Xena: under the bar, its own person
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-faces-review-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const faces = require('../lib/faces/service');
const store = require('../lib/faces/store');
const { createSorter, joinOk, JOIN_RULE } = require('../lib/faces/people-sort');
const { peopleThresholds } = require('../lib/faces/thresholds');
const { app } = require('../server/index');
const { person, like, group, createFakes } = require('./helpers/faces-fakes');

const qtmp = path.join(tmp, 'qtmp');
fs.mkdirSync(qtmp, { recursive: true });
const fk = createFakes();
const svc = faces.setInstance(faces.createService({
  modelStore: fk.modelStore, engineFactory: fk.engineFactory, analyze: fk.analyze, frames: fk.frames,
  peopleDebounceMs: 40, tmpDir: qtmp,
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
const one = (sql, ...a) => db.get().prepare(sql).get(...a);
const all = (sql, ...a) => db.get().prepare(sql).all(...a);
const run = (sql, ...a) => db.get().prepare(sql).run(...a);

async function index(names) {
  const r = await post('/api/faces/index', { ids: names.map(n => ids[n]) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  await svc.settled();
  await svc.sortPeopleNow();
}

const gid = (name) => one('SELECT id FROM face_groups WHERE media_id = ? ORDER BY id', ids[name]).id;
const pidOf = (name) => one('SELECT cluster_id FROM face_groups WHERE id = ?', gid(name)).cluster_id;
const groupRow = (name) => one('SELECT cluster_id, person_locked, recheck_from FROM face_groups WHERE id = ?', gid(name));

/** A unit vector from { axis: value } (the rest of the length on `rest`). */
function vec(parts, rest) {
  const v = new Float32Array(128);
  let n = 0;
  for (const [i, x] of Object.entries(parts)) { v[i] = x; n += x * x; }
  if (rest != null) v[rest] = Math.sqrt(Math.max(0, 1 - n));
  return v;
}

/** Put files' faces into a person the way an older sorting rule would have (automatic, unlocked). */
function autoJoin(names, pid) {
  for (const n of names) run('UPDATE face_groups SET cluster_id = ?, person_locked = 0, sort_held = 0 WHERE media_id = ?', pid, ids[n]);
  store.bumpPeople();
}

/** Forget that the library was checked under the current join rule. */
function forgetRule() {
  run("DELETE FROM face_meta WHERE key IN ('join_rule', 'join_recheck')");
}

const P = {};

test.before(async () => {
  db.init();
  const scripts = {
    'x1.jpg': [person(20)], 'x2.jpg': [like(20, 0.9, 100)],
    'y1.jpg': [person(21)], 'y2.jpg': [like(21, 0.9, 101)],
    'cl.jpg': [like(20, 0.75, 102)],
    'mg.jpg': [vec({ 20: 0.7, 21: 0.68 }, 103)],
    'lo.jpg': [like(20, 0.53, 104)],
  };
  for (const [name, vecs] of Object.entries(scripts)) {
    addFile(name);
    fk.fileScripts.set(files[name], { groups: vecs.map(v => group(v)) });
  }
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.strictEqual((await post('/api/faces/settings', { enabled: true })).status, 200);
  await index(['x1.jpg', 'x2.jpg', 'y1.jpg', 'y2.jpg']);
  P.x = pidOf('x1.jpg');
  P.y = pidOf('y1.jpg');
  assert.strictEqual((await post(`/api/faces/people/${P.x}`, { name: 'Xena' })).status, 200);
  assert.strictEqual((await post(`/api/faces/people/${P.y}`, { name: 'Yuri' })).status, 200);
  await index(['cl.jpg', 'mg.jpg', 'lo.jpg']);
});

test.after(async () => {
  svc.cancel();
  await svc.settled();
  await svc.peopleSettled();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/* ── A: the join rule ──────────────────────────────────────────────────── */

test('join rule: thresholds per model (join = mightLikely, margin 0.05, named bar = join)', () => {
  for (const m of ['sface-2021dec', 'stub-v1', 'adaface-ir50-webface4m', 'adaface-ir101-webface12m']) {
    const t = peopleThresholds(m);
    assert.strictEqual(t.join, t.mightLikely, m);
    assert.strictEqual(t.joinMargin, 0.05, m);
    assert.ok(t.joinNamed >= t.join, m);
    assert.ok(t.join > t.people, `${m}: stricter than the old people bar`);
  }
  assert.strictEqual(peopleThresholds('adaface-ir50-webface4m').join, 0.402);
  assert.strictEqual(peopleThresholds('adaface-ir101-webface12m').join, 0.394);
});

test('join rule: joinOk needs the bar (named: joinNamed) and the margin over the second-best person', () => {
  const th = { join: 0.5, joinNamed: 0.55, joinMargin: 0.05 };
  assert.strictEqual(joinOk({ pid: 1, score: 0.52, second: -1 }, false, th), true);
  assert.strictEqual(joinOk({ pid: 1, score: 0.49, second: -1 }, false, th), false, 'under the bar');
  assert.strictEqual(joinOk({ pid: 1, score: 0.52, second: -1 }, true, th), false, 'a named person needs joinNamed');
  assert.strictEqual(joinOk({ pid: 1, score: 0.56, second: -1 }, true, th), true);
  assert.strictEqual(joinOk({ pid: 1, score: 0.7, second: 0.66 }, false, th), false, 'margin 0.04 < 0.05');
  assert.strictEqual(joinOk({ pid: 1, score: 0.7, second: 0.64 }, false, th), true);
  assert.strictEqual(joinOk({ pid: null, score: 0.9, second: -1 }, false, th), false);
});

test('join rule in the sorter: a clear face joins; an ambiguous one (no margin) and a weak one start their own people', () => {
  assert.strictEqual(pidOf('x2.jpg'), P.x);
  assert.strictEqual(pidOf('cl.jpg'), P.x, '0.73 to Xena, nobody close: joins');
  assert.strictEqual(groupRow('cl.jpg').person_locked, 0, 'the sorter put it there: automatic');
  const mg = pidOf('mg.jpg');
  assert.ok(mg && mg !== P.x && mg !== P.y, '0.68 vs 0.66: ambiguous faces never join');
  const lo = pidOf('lo.jpg');
  assert.ok(lo && lo !== P.x, 'under the 0.56 bar');
  for (const id of [mg, lo]) assert.strictEqual(one('SELECT name FROM face_people WHERE id = ?', id).name, null);
});

/* ── A: the one-time re-check ──────────────────────────────────────────── */

test('re-check: unnamed people lose automatic faces that fail (offered back); named people never lose a face, failing ones are asked about; runs once', async () => {
  const names = { r1: [like(20, 0.45, 110)], r2: [like(20, 0.45, 111)], r3: [like(20, 0.45, 112)], r5: [like(20, 0.45, 114)],
    r6: [like(20, 0.85, 115)], h1: [person(22)], r4: [like(22, 0.45, 113)],
    r8: [like(20, 0.45, 117)], r9: [like(20, 0.45, 118)], w1: [person(27)], w2: [like(27, 0.9, 119)], uq: [like(27, 0.4, 127)],
    wq: [like(27, 0.45, 109)] };
  for (const [n, v] of Object.entries(names)) { addFile(`${n}.jpg`); fk.fileScripts.set(files[`${n}.jpg`], { groups: v.map(x => group(x)) }); }
  await index(Object.keys(names).map(n => `${n}.jpg`));
  // What an older, looser rule left behind in Xena (named): automatic faces ...
  autoJoin(['r1.jpg', 'r2.jpg', 'r3.jpg', 'r5.jpg', 'r6.jpg', 'r8.jpg', 'r9.jpg'], P.x);
  // ... r2 the user put there; r8, r9 locked by 3.7's naming (never confirmed one by one);
  // r3 is a hidden face; r5 is Xena's chosen cover.
  run('UPDATE face_groups SET person_locked = 1, confirmed = 1 WHERE id = ?', gid('r2.jpg'));
  run('UPDATE face_groups SET person_locked = 1, confirmed = 0 WHERE id IN (?, ?)', gid('r8.jpg'), gid('r9.jpg'));
  run('UPDATE face_groups SET hidden = 1 WHERE id = ?', gid('r3.jpg'));
  run('UPDATE face_people SET cover_group_id = ? WHERE id = ?', gid('r5.jpg'), P.x);
  // An unnamed person: a weak automatic face (wq) and a weak locked one (uq, a 3.7 merge).
  const pu = pidOf('w1.jpg');
  autoJoin(['w2.jpg', 'uq.jpg', 'wq.jpg'], pu);
  run('UPDATE face_groups SET person_locked = 1 WHERE id = ?', gid('uq.jpg'));
  // A hidden person with a weak automatic face.
  const ph = pidOf('h1.jpg');
  autoJoin(['r4.jpg'], ph);
  run('UPDATE face_people SET hidden = 1 WHERE id = ?', ph);
  store.bumpPeople();
  forgetRule();
  await svc.sortPeopleNow();
  // Unnamed: the automatic face that fails goes out, remembering where it was.
  const wq = groupRow('wq.jpg');
  assert.notStrictEqual(wq.cluster_id, pu, 'wq (0.44) taken back out of the unnamed person');
  assert.strictEqual(wq.recheck_from, pu);
  assert.deepStrictEqual(one('SELECT name, hidden FROM face_people WHERE id = ?', wq.cluster_id), { name: null, hidden: 0 });
  assert.deepStrictEqual([pidOf('uq.jpg'), one('SELECT recheck_ask FROM face_groups WHERE id = ?', gid('uq.jpg')).recheck_ask], [pu, null], 'locked: stays, not asked');
  // Named: nothing leaves Xena; every face that fails and nobody confirmed is asked about.
  for (const n of ['r1.jpg', 'r2.jpg', 'r3.jpg', 'r5.jpg', 'r6.jpg', 'r8.jpg', 'r9.jpg', 'x1.jpg', 'x2.jpg', 'cl.jpg']) assert.strictEqual(pidOf(n), P.x, n);
  for (const n of ['r1.jpg', 'r8.jpg', 'r9.jpg']) assert.strictEqual(one('SELECT recheck_ask FROM face_groups WHERE id = ?', gid(n)).recheck_ask, P.x, n);
  for (const n of ['r2.jpg', 'r3.jpg', 'r5.jpg', 'r6.jpg', 'x1.jpg', 'x2.jpg', 'cl.jpg']) assert.strictEqual(one('SELECT recheck_ask FROM face_groups WHERE id = ?', gid(n)).recheck_ask, null, n);
  assert.strictEqual(pidOf('r4.jpg'), ph, 'hidden people are never touched');
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_rule'").value, JOIN_RULE);
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_recheck'"), undefined);
  assert.deepStrictEqual([svc._sorter.lastRecheck().out, svc._sorter.lastRecheck().asked], [1, 3]);
  const xena = (await get('/api/faces/people?filter=named')).body.people.find(p => p.id === P.x);
  assert.strictEqual(xena.toCheck, 3, 'the Faces grid shows "3 faces to check"');
  assert.strictEqual((await get(`/api/faces/people/${P.x}`)).body.toCheck, 3);
  // "Might also be" offers wq back to its person (0.44 is under every tier) ...
  const c = await get(`/api/faces/people/${pu}/candidates?limit=50`);
  const it = c.body.items.find(i => i.personId === wq.cluster_id);
  assert.ok(it, 'offered back');
  assert.strictEqual(it.tier, 'maybe');
  // ... and once the user says Yes it is home again, with nothing left to offer.
  assert.strictEqual((await post(`/api/faces/people/${pu}/candidates`, { accept: [wq.cluster_id] })).status, 200);
  assert.deepStrictEqual([pidOf('wq.jpg'), groupRow('wq.jpg').recheck_from], [pu, null]);
  // Runs once: another weak automatic face put in later is not asked about.
  addFile('r7.jpg');
  fk.fileScripts.set(files['r7.jpg'], { groups: [group(like(20, 0.45, 116))] });
  await index(['r7.jpg']);
  autoJoin(['r7.jpg'], P.x);
  await svc.sortPeopleNow();
  assert.deepStrictEqual([pidOf('r7.jpg'), one('SELECT recheck_ask FROM face_groups WHERE id = ?', gid('r7.jpg')).recheck_ask], [P.x, null], 'the rule is recorded: no second re-check');
  // A model switch asks for it again: r7 is asked about, and still nothing leaves Xena.
  svc._modelSwitch.resort('stub-v1');
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_rule'"), undefined);
  await svc.sortPeopleNow();
  assert.deepStrictEqual([pidOf('r7.jpg'), one('SELECT recheck_ask FROM face_groups WHERE id = ?', gid('r7.jpg')).recheck_ask], [P.x, P.x]);
  for (const n of ['r1.jpg', 'r2.jpg', 'r5.jpg', 'r6.jpg', 'r8.jpg', 'r9.jpg']) assert.strictEqual(pidOf(n), P.x, n);
});

test('verifier repro: a person named after an old-rule sort keeps every face through a model switch re-check; the doubtful ones are asked', async () => {
  const names = { an0: [person(40)] };
  for (let i = 1; i <= 6; i++) names[`an${i}`] = [like(40, 0.6, 40 + i)];
  for (const [n, v] of Object.entries(names)) { addFile(`${n}.jpg`); fk.fileScripts.set(files[`${n}.jpg`], { groups: v.map(x => group(x)) }); }
  await index(Object.keys(names).map(n => `${n}.jpg`));
  const anna = pidOf('an0.jpg');
  // The old rule (people 0.50) put all six 0.60 faces with the anchor.
  autoJoin(Object.keys(names).map(n => `${n}.jpg`), anna);
  assert.strictEqual((await post(`/api/faces/people/${anna}`, { name: 'Anna' })).status, 200);
  svc._modelSwitch.resort('stub-v1');
  await svc.sortPeopleNow();
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id = ?', anna).n, 7, 'Anna keeps all 7 faces');
  const asked = one('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id = ? AND recheck_ask = ?', anna, anna).n;
  assert.strictEqual(asked, 6, 'the six faces at 0.55 to the rest are asked about');
  assert.strictEqual((await get(`/api/faces/people/${anna}`)).body.toCheck, 6);
  assert.strictEqual((await get(`/api/faces/people/${anna}`)).body.files, 7);
});

test('hidden people: adds and moves never take their faces; results never name them', async () => {
  for (const [n, v] of [['z1.jpg', person(35)], ['z2.jpg', like(35, 0.9, 108)]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(v)] });
  }
  await index(['z1.jpg', 'z2.jpg']);
  const pz = pidOf('z1.jpg');
  assert.strictEqual(pidOf('z2.jpg'), pz);
  assert.strictEqual((await post(`/api/faces/people/${pz}`, { name: 'Zed', hidden: true })).status, 200);
  const s = await post(`/api/faces/groups/${gid('z1.jpg')}/similar`, { width: 'wide' });
  assert.strictEqual(s.body.match[ids['z2.jpg']].personHidden, true);
  assert.strictEqual(s.body.match[ids['x1.jpg']]?.personHidden, undefined);
  const r = await post(`/api/faces/people/${P.x}/review-faces`, { add: [gid('z2.jpg')] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.body.moved, r.body.skipped], [[], [{ groupId: gid('z2.jpg'), reason: 'hidden-person' }]]);
  const m = await post(`/api/faces/people/${P.x}/move`, { from: pz, groupIds: [gid('z2.jpg')] });
  assert.strictEqual(m.status, 200);
  assert.deepStrictEqual([m.body.moved, m.body.skipped], [[], [{ groupId: gid('z2.jpg'), reason: 'hidden-person' }]]);
  assert.strictEqual(pidOf('z2.jpg'), pz);
});

test('a forced re-check of a file never silently drops a named person\'s face: same box = kept and asked; else offered back', async () => {
  for (const [n, v] of [['kf.jpg', like(20, 0.9, 105)], ['kg.jpg', like(20, 0.9, 106)]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(v, { bbox: [0.1, 0.1, 0.2, 0.2] })] });
  }
  await index(['kf.jpg', 'kg.jpg']);
  assert.deepStrictEqual([pidOf('kf.jpg'), pidOf('kg.jpg')], [P.x, P.x]);
  // The re-check reads both faces quite differently (cosine < 0.45 to the old ones).
  fk.fileScripts.set(files['kf.jpg'], { groups: [group(person(47), { bbox: [0.11, 0.1, 0.2, 0.2] })] });   // same place
  // kg: two strangers elsewhere in the photo (nothing in place, nothing like Xena).
  fk.fileScripts.set(files['kg.jpg'], { groups: [group(person(48), { bbox: [0.6, 0.6, 0.2, 0.2] }), group(person(36), { bbox: [0.6, 0.1, 0.2, 0.2] })] });
  for (const n of ['kf.jpg', 'kg.jpg']) assert.strictEqual((await post(`/api/media/${ids[n]}/find-faces`, { force: true })).status, 200);
  await svc.sortPeopleNow();
  // Same box (a face Xena got automatically): still Xena's, and Xena is asked about it.
  assert.deepStrictEqual(one('SELECT cluster_id, recheck_ask, confirmed FROM face_groups WHERE id = ?', gid('kf.jpg')), { cluster_id: P.x, recheck_ask: P.x, confirmed: 0 });
  // Nothing qualifies: both new faces are sorted on their own and offered back to Xena ("Is this Xena?").
  for (const g of all('SELECT id FROM face_groups WHERE media_id = ?', ids['kg.jpg'])) {
    assert.strictEqual(one('SELECT recheck_from FROM face_groups WHERE id = ?', g.id).recheck_from, P.x);
  }
  const kg = groupRow('kg.jpg');
  assert.notStrictEqual(kg.cluster_id, P.x);
  assert.strictEqual(kg.recheck_from, P.x);
  const c = await get(`/api/faces/people/${P.x}/candidates?limit=100`);
  assert.ok(c.body.items.some(i => i.personId === kg.cluster_id), 'offered back to Xena');
  // A face of an unnamed person is not kept that way (its person simply goes, as before).
  addFile('kh.jpg');
  fk.fileScripts.set(files['kh.jpg'], { groups: [group(person(49))] });
  await index(['kh.jpg']);
  const ph = pidOf('kh.jpg');
  fk.fileScripts.set(files['kh.jpg'], { groups: [group(like(49, 0.3, 107))] });
  assert.strictEqual((await post(`/api/media/${ids['kh.jpg']}/find-faces`, { force: true })).status, 200);
  await svc.sortPeopleNow();
  assert.deepStrictEqual([groupRow('kh.jpg').recheck_from, one('SELECT recheck_ask FROM face_groups WHERE id = ?', gid('kh.jpg')).recheck_ask], [null, null]);
  assert.notStrictEqual(pidOf('kh.jpg'), ph);
});

test('naming locks nothing (3.8); a chosen cover and an add confirm the face', async () => {
  for (const n of ['x1.jpg', 'x2.jpg', 'y1.jpg']) {
    assert.deepStrictEqual(one('SELECT person_locked, confirmed FROM face_groups WHERE id = ?', gid(n)), { person_locked: 0, confirmed: 0 }, n);
  }
  assert.strictEqual((await post(`/api/faces/people/${P.y}`, { name: 'Yuri B' })).status, 200);
  assert.strictEqual(one('SELECT person_locked FROM face_groups WHERE id = ?', gid('y2.jpg')).person_locked, 0, 'a rename neither');
  assert.strictEqual((await post(`/api/faces/people/${P.y}`, { name: 'Yuri', coverGroupId: gid('y2.jpg') })).status, 200);
  assert.deepStrictEqual(one('SELECT person_locked, confirmed FROM face_groups WHERE id = ?', gid('y2.jpg')), { person_locked: 1, confirmed: 1 });
  assert.strictEqual(one('SELECT person_locked FROM face_groups WHERE id = ?', gid('y1.jpg')).person_locked, 0);
});

test('check faces: GET lists the asked faces; Yes keeps (confirmed, never asked again), No takes out (own person, not-X)', async () => {
  const g8 = gid('r8.jpg'), g9 = gid('r9.jpg');
  const l = await get(`/api/faces/people/${P.x}/to-check`);
  assert.strictEqual(l.status, 200);
  assert.strictEqual(l.body.total, 5);
  assert.deepStrictEqual(l.body.items.map(i => i.groupId), [gid('r1.jpg'), g8, g9, gid('r7.jpg'), gid('kf.jpg')]);
  assert.strictEqual(l.body.items[1].filename, 'r8.jpg');
  for (const b of [{}, { keep: [g8], remove: [g8] }, { keep: 'x' }]) {
    assert.strictEqual((await post(`/api/faces/people/${P.x}/to-check`, b)).status, 400, JSON.stringify(b));
  }
  const r = await post(`/api/faces/people/${P.x}/to-check`, { keep: [g8], remove: [g9, gid('x1.jpg')] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.kept, [g8]);
  assert.strictEqual(r.body.removed.length, 1);
  assert.deepStrictEqual(r.body.skipped, [{ groupId: gid('x1.jpg'), reason: 'moved-on' }]);
  assert.deepStrictEqual(one('SELECT cluster_id, person_locked, confirmed, recheck_ask FROM face_groups WHERE id = ?', g8),
    { cluster_id: P.x, person_locked: 1, confirmed: 1, recheck_ask: null });
  const out = one('SELECT cluster_id, person_locked, recheck_ask FROM face_groups WHERE id = ?', g9);
  assert.strictEqual(out.cluster_id, r.body.removed[0].personId);
  assert.notStrictEqual(out.cluster_id, P.x);
  assert.deepStrictEqual([out.person_locked, out.recheck_ask], [0, null]);
  assert.strictEqual(one('SELECT name FROM face_people WHERE id = ?', out.cluster_id).name, null);
  assert.ok(one('SELECT 1 FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.x, g9), 'recorded as not Xena');
  assert.strictEqual(r.body.person.toCheck, 3);
  assert.strictEqual((await get(`/api/faces/people/${P.x}/to-check`)).body.total, 3);
  // Another re-check (a new rule, a model switch) never asks about the kept face again.
  forgetRule();
  await svc.sortPeopleNow();
  assert.deepStrictEqual(one('SELECT cluster_id, recheck_ask FROM face_groups WHERE id = ?', g8), { cluster_id: P.x, recheck_ask: null });
  assert.notStrictEqual(pidOf('r9.jpg'), P.x, 'and the No stays out');
});

test('re-check: a library with nothing sorted yet is marked done without a walk', () => {
  const s = createSorter({ database: db, store });
  assert.strictEqual(typeof s.lastRecheck, 'function');
  // (the service's first run in before() found no sorted face: it recorded the rule then)
  assert.ok(one("SELECT value FROM face_meta WHERE key = 'join_rule'"));
});

test('re-check: sliced with event-loop yields, resumes after a stop where it left off, never empties a person', async () => {
  // 150 weak automatic faces in one unnamed person, inserted directly.
  const stamp = new Date().toISOString();
  const mid = addFile('bulk.jpg');
  const pid = Number(run('INSERT INTO face_people (created_at, updated_at) VALUES (?, ?)', stamp, stamp).lastInsertRowid);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const ins = db.get().prepare(`INSERT INTO face_groups (media_id, appearances, best_bbox, det_score, model, hidden, created_at, cluster_id, person_locked)
    VALUES (?, 1, '[0,0,0.1,0.1]', 0.9, 'stub-v1', 0, ?, ?, 0)`);
  const insV = db.get().prepare('INSERT INTO face_vectors (group_id, media_id, embedding) VALUES (?, ?, ?)');
  for (let i = 0; i < 150; i++) {
    const v = new Float32Array(128);
    let n = 0;
    for (let k = 30; k < 128; k++) { v[k] = rnd(); n += v[k] * v[k]; }
    for (let k = 30; k < 128; k++) v[k] *= 0.89 / Math.sqrt(n);
    v[25] = 0.45;
    const g = Number(ins.run(mid, stamp, pid).lastInsertRowid);
    insV.run(g, mid, store.encodeEmbedding(v, 'stub-v1'));
  }
  run("UPDATE media SET faces_indexed_at = ?, faces_model = 'stub-v1' WHERE id = ?", stamp, mid);
  store.bump();
  store.bumpPeople();
  forgetRule();
  // A sorter of its own: a clock that moves 1 ms per look and 2 ms slices,
  // so every slice is one page; the lock probe counts the yields.
  // The "lock" comes after the saved progress moved twice: a stop mid-walk.
  let t = 0, looks = 0, stopMidway = true, moves = 0, lastAfter = 0;
  const progress = () => { const r = one("SELECT value FROM face_meta WHERE key = 'join_recheck'"); return r ? JSON.parse(r.value).after : 0; };
  const s = createSorter({ database: db, store, sliceMs: 2, now: () => ++t, isVaultLocked: () => {
    looks++;
    if (!stopMidway) return false;
    const a = progress();
    if (a !== lastAfter) { lastAfter = a; moves++; }
    return moves >= 2;
  } });
  await s.runNow();
  const st = JSON.parse(one("SELECT value FROM face_meta WHERE key = 'join_recheck'").value);
  assert.strictEqual(st.rule, JOIN_RULE);
  assert.ok(st.after > 0, 'progress saved');
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_rule'"), undefined, 'not done yet');
  const outSoFar = one('SELECT COUNT(*) AS n FROM face_groups WHERE recheck_from = ? AND media_id = ?', pid, mid).n;
  assert.ok(outSoFar > 0 && outSoFar < 149, `part of the walk (${outSoFar})`);
  looks = 0; stopMidway = false;
  await s.runNow();
  assert.ok(looks >= 3, `yielded between slices (${looks} looks)`);
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_rule'").value, JOIN_RULE);
  const left = one('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id = ?', pid).n;
  assert.strictEqual(left, 1, 'the last face stays: a person is never emptied');
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_groups WHERE recheck_from = ? AND media_id = ?', pid, mid).n, 149);
  // The rest of the library is untouched by this walk.
  for (const n of ['x1.jpg', 'x2.jpg', 'cl.jpg', 'r2.jpg', 'r5.jpg', 'r6.jpg']) assert.strictEqual(pidOf(n), P.x, n);
  s.cancel();
  await s.settled();
  // Tidy: these synthetic faces are not part of the review tests below.
  run('DELETE FROM face_vectors WHERE media_id = ?', mid);
  run('DELETE FROM face_groups WHERE media_id = ?', mid);
  run('DELETE FROM face_people WHERE id NOT IN (SELECT DISTINCT cluster_id FROM face_groups WHERE cluster_id IS NOT NULL) AND name IS NULL');
  store.bump();
  store.bumpPeople();
});

/* ── B: the review endpoints ───────────────────────────────────────────── */

test('check-faces: card details, Strong match for the target, rejected flag; validation', async () => {
  const r = await post('/api/faces/check-faces', { groupIds: [gid('cl.jpg'), gid('lo.jpg'), gid('mg.jpg')], personId: P.x });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const [cl, lo, mg] = r.body.items;
  assert.deepStrictEqual(Object.keys(cl).sort(), ['bbox', 'cropUrl', 'filename', 'firstTimeS', 'groupId', 'hidden', 'mediaId', 'mediaType',
    'personId', 'personName', 'rejected', 'tier', 'timeS']);
  assert.strictEqual(cl.filename, 'cl.jpg');
  assert.strictEqual(cl.personName, 'Xena');
  assert.strictEqual(cl.tier, 'likely');
  assert.strictEqual(lo.tier, 'maybe', '0.52: not a strong match');
  assert.strictEqual(mg.tier, 'maybe', 'strong score but no margin over Yuri');
  assert.strictEqual(cl.timeS, null, 'photos have no time');
  assert.deepStrictEqual(cl.bbox.length, 4);
  const noP = await post('/api/faces/check-faces', { groupIds: [gid('cl.jpg')] });
  assert.strictEqual(noP.body.items[0].tier, null);
  assert.strictEqual((await post('/api/faces/check-faces', { groupIds: 'x' })).status, 400);
  assert.strictEqual((await post('/api/faces/check-faces', { groupIds: Array.from({ length: 201 }, (_, i) => i + 1) })).status, 400);
  assert.strictEqual((await post('/api/faces/check-faces', { groupIds: [1], personId: 999999 })).status, 404);
  assert.deepStrictEqual((await post('/api/faces/check-faces', { groupIds: [] })).body, { items: [] });
});

test('review-faces: Yes moves in (locked), No is a reject (never suggested, never auto-joined); a face is never both', async () => {
  for (const [n, v] of [['q1.jpg', like(20, 0.5, 120)], ['q2.jpg', like(20, 0.5, 121)], ['q3.jpg', like(21, 0.9, 122)]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(v)] });
  }
  await index(['q1.jpg', 'q2.jpg', 'q3.jpg']);
  const pq2 = pidOf('q2.jpg');
  assert.notStrictEqual(pidOf('q1.jpg'), P.x);
  assert.strictEqual(pidOf('q3.jpg'), P.y);
  const bad = [{}, { add: [] }, { add: [1], reject: [1] }, { add: ['1'] }, { reject: [1, 1] }];
  for (const b of bad) assert.strictEqual((await post(`/api/faces/people/${P.x}/review-faces`, b)).status, 400, JSON.stringify(b));
  assert.strictEqual((await post('/api/faces/people/999999/review-faces', { add: [gid('q1.jpg')] })).status, 404);
  const r = await post(`/api/faces/people/${P.x}/review-faces`, { add: [gid('q1.jpg'), gid('q3.jpg')], reject: [gid('q2.jpg'), gid('x1.jpg')] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.moved, [gid('q1.jpg')]);
  assert.deepStrictEqual(r.body.rejected, [gid('q2.jpg')]);
  assert.deepStrictEqual(r.body.skipped.map(s => s.reason).sort(), ['in-person', 'other-named']);
  assert.deepStrictEqual(groupRow('q1.jpg'), { cluster_id: P.x, person_locked: 1, recheck_from: null });
  assert.strictEqual(pidOf('q3.jpg'), P.y, 'never taken from another named person');
  assert.ok(one('SELECT 1 FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.x, gid('q2.jpg')));
  // No: its person is never offered to Xena, and the search marks it.
  const c = await get(`/api/faces/people/${P.x}/candidates?limit=50`);
  assert.ok(!c.body.items.some(i => i.personId === pq2));
  const s = await post(`/api/faces/groups/${gid('x1.jpg')}/similar`, { width: 'wide' });
  assert.ok(s.body.rejected.includes(ids['q2.jpg']), JSON.stringify(s.body.rejected));
  assert.ok(!s.body.rejected.includes(ids['q1.jpg']));
  // A re-check of the file keeps the No (carry-over).
  const before = gid('q2.jpg');
  const fr = await post(`/api/media/${ids['q2.jpg']}/find-faces`, { force: true });
  assert.strictEqual(fr.status, 200);
  await svc.sortPeopleNow();
  assert.notStrictEqual(gid('q2.jpg'), before);
  assert.ok(one('SELECT 1 FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.x, gid('q2.jpg')));
});

test('move (Compare): faces leave the other person as a decision; the other keeps a reject; keep records one for the target', async () => {
  for (const [n, v] of [['k1.jpg', like(21, 0.8, 123)], ['k2.jpg', like(21, 0.8, 124)], ['k3.jpg', like(21, 0.8, 125)]]) {
    addFile(n);
    fk.fileScripts.set(files[n], { groups: [group(v)] });
  }
  await index(['k1.jpg', 'k2.jpg', 'k3.jpg']);
  for (const n of ['k1.jpg', 'k2.jpg', 'k3.jpg']) assert.strictEqual(pidOf(n), P.y, n);
  for (const b of [{ groupIds: [gid('k1.jpg')] }, { from: P.y }, { from: P.y, groupIds: [gid('k1.jpg')], keep: [gid('k1.jpg')] }]) {
    assert.strictEqual((await post(`/api/faces/people/${P.x}/move`, b)).status, 400, JSON.stringify(b));
  }
  assert.strictEqual((await post(`/api/faces/people/${P.x}/move`, { from: P.x, groupIds: [gid('k1.jpg')] })).status, 400);
  assert.strictEqual((await post(`/api/faces/people/${P.x}/move`, { from: 999999, groupIds: [gid('k1.jpg')] })).status, 404);
  const r = await post(`/api/faces/people/${P.x}/move`, { from: P.y, groupIds: [gid('k1.jpg'), gid('x2.jpg')], keep: [gid('k2.jpg'), gid('cl.jpg')] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.moved, [gid('k1.jpg')]);
  assert.deepStrictEqual(r.body.kept, [gid('k2.jpg')]);
  // x2 is not in Yuri (not moved); cl is not in Yuri either, so no keep is recorded for it.
  assert.deepStrictEqual(r.body.skipped, [{ groupId: gid('x2.jpg'), reason: 'moved-on' }, { groupId: gid('cl.jpg'), reason: 'moved-on' }]);
  assert.ok(!one('SELECT 1 FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.x, gid('cl.jpg')));
  assert.strictEqual(r.body.fromPerson.id, P.y);
  assert.deepStrictEqual(groupRow('k1.jpg'), { cluster_id: P.x, person_locked: 1, recheck_from: null });
  assert.ok(one('SELECT 1 FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.y, gid('k1.jpg')), 'Yuri: not this person');
  assert.ok(!one('SELECT 1 FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.x, gid('k1.jpg')));
  assert.strictEqual(pidOf('k2.jpg'), P.y);
  assert.ok(one('SELECT 1 FROM face_person_rejects WHERE person_id = ? AND group_id = ?', P.x, gid('k2.jpg')), 'kept: not Xena');
  assert.strictEqual(pidOf('k3.jpg'), P.y, 'no choice made: untouched');
  // Moving a person's last face prunes an unnamed person, keeps a named one.
  addFile('u1.jpg');
  fk.fileScripts.set(files['u1.jpg'], { groups: [group(person(26))] });
  await index(['u1.jpg']);
  const pu = pidOf('u1.jpg');
  const r2 = await post(`/api/faces/people/${P.x}/move`, { from: pu, groupIds: [gid('u1.jpg')] });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.fromPerson, null);
  assert.strictEqual(one('SELECT id FROM face_people WHERE id = ?', pu), undefined);
});

test('feature off: the round 4 routes are FACES_OFF', async () => {
  assert.strictEqual((await post('/api/faces/settings', { enabled: false })).status, 200);
  try {
    for (const p of [`/api/faces/people/${P.x}/review-faces`, `/api/faces/people/${P.x}/move`, '/api/faces/check-faces']) {
      const r = await post(p, {});
      assert.strictEqual(r.status, 409, p);
      assert.strictEqual(r.body.code, 'FACES_OFF', p);
    }
  } finally {
    assert.strictEqual((await post('/api/faces/settings', { enabled: true })).status, 200);
  }
});

test('a re-read that drifts keeps the user\'s faces: same box a frame later, same box, the only face left (verifier probe2)', async () => {
  const mk = (n, v, t, type) => { addFile(n, type); fk.fileScripts.set(files[n], { groups: [group(v, { firstTimeS: t, bbox: [0.1, 0.1, 0.2, 0.2] })] }); };
  mk('c1.mp4', like(21, 0.9, 60), 4, 'video');
  mk('c2.mp4', like(21, 0.9, 61), 4, 'video');
  mk('c3.jpg', like(21, 0.9, 62), 0, 'image');
  await index(['c1.mp4', 'c2.mp4', 'c3.jpg']);
  // Yuri is named; the user says Yes to each face (confirmed).
  for (const n of ['c1.mp4', 'c2.mp4', 'c3.jpg']) {
    assert.strictEqual((await post(`/api/faces/people/${P.y}/review-faces`, { add: [gid(n)] })).status, 200);
    assert.deepStrictEqual(one('SELECT cluster_id, confirmed FROM face_groups WHERE id = ?', gid(n)), { cluster_id: P.y, confirmed: 1 }, n);
  }
  // Re-read much weaker (cosine 0.35 to Yuri: under every match threshold).
  fk.fileScripts.set(files['c1.mp4'], { groups: [group(like(21, 0.35, 63), { firstTimeS: 5, bbox: [0.1, 0.1, 0.2, 0.2] })] });   // same box, 1 s later
  fk.fileScripts.set(files['c2.mp4'], { groups: [group(like(21, 0.35, 64), { firstTimeS: 4, bbox: [0.1, 0.1, 0.2, 0.2] })] });   // same box, same time
  fk.fileScripts.set(files['c3.jpg'], { groups: [group(like(21, 0.35, 65), { firstTimeS: 0, bbox: [0.2, 0.2, 0.2, 0.2] })] });   // box moved
  for (const n of ['c1.mp4', 'c2.mp4', 'c3.jpg']) assert.strictEqual((await post(`/api/media/${ids[n]}/find-faces`, { force: true })).status, 200);
  await svc.sortPeopleNow();
  const st = (n) => one('SELECT cluster_id, person_locked, confirmed, recheck_ask FROM face_groups WHERE id = ?', gid(n));
  // Matched by place: the user's decision stands.
  assert.deepStrictEqual(st('c1.mp4'), { cluster_id: P.y, person_locked: 1, confirmed: 1, recheck_ask: null });
  assert.deepStrictEqual(st('c2.mp4'), { cluster_id: P.y, person_locked: 1, confirmed: 1, recheck_ask: null });
  // The photo's only face, read elsewhere and weak: still Yuri's, but asked about.
  assert.deepStrictEqual(st('c3.jpg'), { cluster_id: P.y, person_locked: 1, confirmed: 0, recheck_ask: P.y });
});

/* ── Older versions ────────────────────────────────────────────────────── */

test('older versions: the schema change is one nullable column; their writes still work; a pre-3.8 library upgrades in place', () => {
  const cols = db.get().prepare('PRAGMA table_info(face_groups)').all();
  const col = cols.find(c => c.name === 'recheck_from');
  assert.ok(col);
  assert.strictEqual(col.notnull, 0);
  assert.strictEqual(col.dflt_value, null);
  const conf = cols.find(c => c.name === 'confirmed'), ask = cols.find(c => c.name === 'recheck_ask');
  assert.deepStrictEqual([conf.notnull, conf.dflt_value], [1, '0'], 'confirmed: 0 for every older row');
  assert.deepStrictEqual([ask.notnull, ask.dflt_value], [0, null]);
  // 3.7's saveFileResult INSERT (no recheck_from) on the new schema.
  const stamp = new Date().toISOString();
  const g = Number(db.get().prepare(`INSERT INTO face_groups
    (media_id, appearances, first_time_s, best_time_s, best_bbox, det_score, model, hidden, created_at,
     cluster_id, person_locked, screen_s, not_face, norm)
    VALUES (?, 1, NULL, NULL, '[0,0,0.1,0.1]', 0.9, 'stub-v1', 0, ?, NULL, 0, NULL, 0, NULL)`).run(ids['x1.jpg'], stamp).lastInsertRowid);
  assert.strictEqual(one('SELECT recheck_from FROM face_groups WHERE id = ?', g).recheck_from, null);
  run('DELETE FROM face_groups WHERE id = ?', g);
  // A library from before 3.8 (no column, no index, no join rule): opening it adds them, data intact.
  const file = process.env.VAULT_DB;
  const before = one('SELECT COUNT(*) AS n FROM face_groups').n;
  const named = one('SELECT COUNT(*) AS n FROM face_people WHERE name IS NOT NULL').n;
  db.close();
  const Raw = (() => { try { return require('better-sqlite3-multiple-ciphers'); } catch { return require('better-sqlite3'); } })();
  const raw = new Raw(file);
  raw.exec('DROP INDEX IF EXISTS idx_face_groups_recheck');
  raw.exec('ALTER TABLE face_groups DROP COLUMN recheck_from');
  raw.exec('DROP INDEX IF EXISTS idx_face_groups_ask');
  raw.exec('ALTER TABLE face_groups DROP COLUMN recheck_ask');
  raw.exec('ALTER TABLE face_groups DROP COLUMN confirmed');
  raw.exec("DELETE FROM face_meta WHERE key IN ('join_rule', 'join_recheck')");
  raw.close();
  db.init(file);
  for (const c of ['recheck_from', 'confirmed', 'recheck_ask']) assert.ok(db.get().prepare('PRAGMA table_info(face_groups)').all().some(x => x.name === c), c);
  assert.ok(db.get().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_face_groups_recheck'").get());
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_groups').n, before);
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_people WHERE name IS NOT NULL').n, named);
});
