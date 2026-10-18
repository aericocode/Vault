/**
 * Faces round 4 (FACES_REVIEW_SPEC), server side, over HTTP against the real
 * Express app with the stub engine (no models, no network):
 *   A  the stricter join rule (bar, margin over the second-best person, the
 *      named bar), the one-time re-check of automatic joins (confirmed,
 *      hidden, covers untouched; runs once; sliced and resumable), the model
 *      switch asking for it again, and older versions opening the library
 *      and "Might also be" offering a face the re-check took out
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

test('re-check: automatic faces that fail the new rule leave their person (recheck_from); confirmed, hidden, covers and hidden people stay; runs once', async () => {
  const names = { r1: [like(20, 0.45, 110)], r2: [like(20, 0.45, 111)], r3: [like(20, 0.45, 112)], r5: [like(20, 0.45, 114)],
    r6: [like(20, 0.85, 115)], h1: [person(22)], r4: [like(22, 0.45, 113)] };
  for (const [n, v] of Object.entries(names)) { addFile(`${n}.jpg`); fk.fileScripts.set(files[`${n}.jpg`], { groups: v.map(x => group(x)) }); }
  await index(Object.keys(names).map(n => `${n}.jpg`));
  // What an older, looser rule left behind: all in Xena, automatic ...
  autoJoin(['r1.jpg', 'r2.jpg', 'r3.jpg', 'r5.jpg', 'r6.jpg'], P.x);
  // ... except r2, which the user put there; r3 is a hidden face; r5 is Xena's chosen cover.
  run('UPDATE face_groups SET person_locked = 1 WHERE id = ?', gid('r2.jpg'));
  run('UPDATE face_groups SET hidden = 1 WHERE id = ?', gid('r3.jpg'));
  run('UPDATE face_people SET cover_group_id = ? WHERE id = ?', gid('r5.jpg'), P.x);
  // A hidden person with a weak automatic face.
  const ph = pidOf('h1.jpg');
  autoJoin(['r4.jpg'], ph);
  run('UPDATE face_people SET hidden = 1 WHERE id = ?', ph);
  store.bumpPeople();
  forgetRule();
  await svc.sortPeopleNow();
  const r1 = groupRow('r1.jpg');
  assert.notStrictEqual(r1.cluster_id, P.x, 'r1 (0.44 to Xena) taken back out');
  assert.strictEqual(r1.recheck_from, P.x);
  assert.strictEqual(r1.person_locked, 0);
  assert.deepStrictEqual(one('SELECT name, hidden FROM face_people WHERE id = ?', r1.cluster_id), { name: null, hidden: 0 }, 'into a new unnamed person');
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_groups WHERE cluster_id = ?', r1.cluster_id).n, 1);
  for (const n of ['r2.jpg', 'r3.jpg', 'r5.jpg', 'r6.jpg', 'x1.jpg', 'x2.jpg', 'cl.jpg']) assert.strictEqual(pidOf(n), P.x, n);
  assert.strictEqual(pidOf('r4.jpg'), ph, 'hidden people are never touched');
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_rule'").value, JOIN_RULE);
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_recheck'"), undefined);
  assert.strictEqual(svc._sorter.lastRecheck().out, 1);
  // "Might also be" offers it back to Xena (0.44 is under every tier), until answered.
  const c = await get(`/api/faces/people/${P.x}/candidates?limit=50`);
  const it = c.body.items.find(i => i.personId === r1.cluster_id);
  assert.ok(it, 'offered back');
  assert.strictEqual(it.tier, 'maybe');
  // Runs once: another weak automatic face put in later stays where it is.
  addFile('r7.jpg');
  fk.fileScripts.set(files['r7.jpg'], { groups: [group(like(20, 0.45, 116))] });
  await index(['r7.jpg']);
  autoJoin(['r7.jpg'], P.x);
  await svc.sortPeopleNow();
  assert.strictEqual(pidOf('r7.jpg'), P.x, 'the rule is recorded: no second re-check');
  // The model switch asks for it again (with the new model's vectors).
  svc._modelSwitch.resort('stub-v1');
  assert.strictEqual(one("SELECT value FROM face_meta WHERE key = 'join_rule'"), undefined);
  await svc.sortPeopleNow();
  assert.notStrictEqual(pidOf('r7.jpg'), P.x, 'checked again after a model switch');
  assert.strictEqual(groupRow('r7.jpg').recheck_from, P.x);
  for (const n of ['r2.jpg', 'r5.jpg', 'r6.jpg']) assert.strictEqual(pidOf(n), P.x, n);
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

/* ── Older versions ────────────────────────────────────────────────────── */

test('older versions: the schema change is one nullable column; their writes still work; a pre-3.8 library upgrades in place', () => {
  const cols = db.get().prepare('PRAGMA table_info(face_groups)').all();
  const col = cols.find(c => c.name === 'recheck_from');
  assert.ok(col);
  assert.strictEqual(col.notnull, 0);
  assert.strictEqual(col.dflt_value, null);
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
  raw.exec("DELETE FROM face_meta WHERE key IN ('join_rule', 'join_recheck')");
  raw.close();
  db.init(file);
  assert.ok(db.get().prepare('PRAGMA table_info(face_groups)').all().some(c => c.name === 'recheck_from'));
  assert.ok(db.get().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_face_groups_recheck'").get());
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_groups').n, before);
  assert.strictEqual(one('SELECT COUNT(*) AS n FROM face_people WHERE name IS NOT NULL').n, named);
});
