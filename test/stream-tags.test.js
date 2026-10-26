/**
 * Stream tags (lib/stream-tags.js, server/stream-tags-routes.js): the seed
 * (once only), lanes and tags (create, rename, recolour, reorder, delete),
 * validation (names, colours, keys), tagging files (add, remove, toggle,
 * One per file replaces, clear), cleanup when a record, a tag or a lane
 * goes, the library filter, Flow order with places over HTTP, and the lock
 * gate and the CSRF guard.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-stream-tags-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const tags = require('../lib/stream-tags');
const flowStore = require('../lib/flow/store');
const { app } = require('../server/index');

let server, base, coll;
const ids = [];

test.before(async () => {
  db.init();
  const d = db.get();
  const ins = d.prepare("INSERT INTO media (filepath, filename, media_type, duration_seconds, filesize_bytes, file_mtime_ms) VALUES (?, ?, 'video', 60, 1000, 5)");
  for (let i = 0; i < 8; i++) ids.push(Number(ins.run(path.join(tmp, `s${i}.mp4`), `s${i}.mp4`).lastInsertRowid));
  coll = db.createCollection('Friday set').id;
  db.addToCollection(coll, ids);
  const src = flowStore.srcOf({ filesize_bytes: 1000, file_mtime_ms: 5 });
  const es = [0.3, 0.5, 0.7, 0.4, 0.6, 0.8, 0.2, 0.55];
  es.forEach((e, i) => flowStore.save(d, ids[i], src, { lufs: -20, peak_db: -6, has_music: 1, e_start: e, e_mid: e, e_end: e, bpm_start: 120, bpm_mid: 120, bpm_end: 120, bpm_conf: 0.9 }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  vault._locked = false;
  require('../lib/flow/service').cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const get = (p, h = {}) => fetch(base + p, { headers: h });
const post = (p, body, h = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body || {}) });
const del = (p) => fetch(base + p, { method: 'DELETE' });
const json = async (r, status = 200) => { const b = await r.json(); assert.strictEqual(r.status, status, JSON.stringify(b)); return b; };
const lanes = async () => (await json(await get('/api/stream-tags'))).lanes;
const roleTag = async (name) => (await lanes()).find(l => l.name === 'Role').tags.find(t => t.name === name);

test('the seed: Role, Several per file, with the five tags in order, keys, places and colours', async () => {
  const [role] = await lanes();
  assert.strictEqual(role.name, 'Role');
  assert.strictEqual(role.multi, true);
  assert.deepStrictEqual(role.tags.map(t => [t.name, t.hotkey, t.place, t.color]), [
    ['Opener', 'O', 'first', '#4ade80'],
    ['Centerpiece', 'C', 'peak', '#f59e0b'],
    ['Palate cleanser', 'L', 'low', '#22d3ee'],
    ['Intermission', 'I', 'after_peak', '#a78bfa'],
    ['Closer', 'X', 'last', '#f472b6'],
  ]);
});

test('seeded once: deleted seed tags stay deleted when the schema runs again', () => {
  const d = db.get();
  const role = tags.list(d)[0];
  const t = tags.createTag(d, { laneId: role.id, name: 'Temp', color: '#123456' });
  tags.deleteTag(d, t.id);
  const before = tags.list(d).length;
  // A lane deleted entirely is not put back either.
  const extra = tags.createLane(d, { name: 'Scratch' });
  tags.deleteLane(d, extra.id);
  tags.ensureSchema(d);
  assert.strictEqual(tags.list(d).length, before);
  // A fresh database is seeded; the same one never twice.
  const Database = require('better-sqlite3');
  const fresh = new Database(':memory:');
  tags.ensureSchema(fresh);
  fresh.prepare('DELETE FROM stream_tags').run();
  fresh.prepare('DELETE FROM stream_lanes').run();
  tags.ensureSchema(fresh);
  assert.strictEqual(fresh.prepare('SELECT COUNT(*) AS n FROM stream_lanes').get().n, 0);
  fresh.close();
});

test('lanes: create, rename, One per file, reorder; names checked', async () => {
  const mood = await json(await post('/api/stream-tags/lanes', { name: '  Mood  ', multi: false }));
  assert.strictEqual(mood.name, 'Mood');
  assert.strictEqual(mood.multi, false);
  await json(await post('/api/stream-tags/lanes', { name: 'mood' }), 409);
  await json(await post('/api/stream-tags/lanes', { name: '' }), 400);
  await json(await post('/api/stream-tags/lanes', { name: 'x'.repeat(41) }), 400);
  await json(await post('/api/stream-tags/lanes', { name: 'Ok', multi: 'yes' }), 400);
  const renamed = await json(await post(`/api/stream-tags/lanes/${mood.id}`, { name: 'Feel' }));
  assert.strictEqual(renamed.name, 'Feel');
  const all = await lanes();
  const order = all.map(l => l.id).reverse();
  const after = await json(await post('/api/stream-tags/lanes/order', { ids: order }));
  assert.deepStrictEqual(after.lanes.map(l => l.id), order);
  await json(await post('/api/stream-tags/lanes/order', { ids: [999999] }), 400);
  await json(await post('/api/stream-tags/lanes/abc', { name: 'x' }), 400);
  await json(await post('/api/stream-tags/lanes/999999', { name: 'x' }), 404);
});

test('tags: colours, keys (one printable key, unique, any case) and places are checked', async () => {
  const feel = (await lanes()).find(l => l.name === 'Feel');
  const ok = await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'Chill', color: '#7DD3FC', hotkey: '1', place: 'anywhere' }));
  assert.strictEqual(ok.color, '#7dd3fc');
  assert.strictEqual(ok.hotkey, '1');
  const short = await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'Hype', color: '#f93', hotkey: 'h' }));
  assert.strictEqual(short.color, '#ff9933');
  assert.strictEqual(short.hotkey, 'H');
  assert.strictEqual(short.place, 'anywhere');
  // Taken in any case, by any lane.
  const taken = await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'Dreamy', color: '#c4b5fd', hotkey: 'c' }), 409);
  assert.strictEqual(taken.code, 'HOTKEY_TAKEN');
  assert.match(taken.error, /Centerpiece/);
  for (const bad of ['ab', ' ', '\u0007', 5]) await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'Bad', color: '#000000', hotkey: bad }), 400);
  for (const bad of ['?', 'u']) assert.strictEqual((await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'Bad', color: '#000000', hotkey: bad }), 400)).code, 'HOTKEY_RESERVED');
  for (const color of ['red', '#12345', '12345a', '#gggggg', null]) await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'Bad', color }), 400);
  await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'Bad', color: '#000000', place: 'middle' }), 400);
  await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: 'chill', color: '#000000' }), 409);
  await json(await post('/api/stream-tags/tags', { laneId: 999999, name: 'Bad', color: '#000000' }), 404);
  // Edit: rename, recolour, a new key, no key, a place.
  const ed = await json(await post(`/api/stream-tags/tags/${short.id}`, { name: 'Hyped', color: '#fb923c', hotkey: '2', place: 'peak' }));
  assert.deepStrictEqual([ed.name, ed.color, ed.hotkey, ed.place], ['Hyped', '#fb923c', '2', 'peak']);
  const nokey = await json(await post(`/api/stream-tags/tags/${short.id}`, { hotkey: null, place: 'anywhere' }));
  assert.strictEqual(nokey.hotkey, null);
  // Its own key again is fine.
  await json(await post(`/api/stream-tags/tags/${ok.id}`, { hotkey: '1' }));
  // Reorder within the lane.
  const lane = await json(await post(`/api/stream-tags/lanes/${feel.id}/order`, { ids: [short.id, ok.id] }));
  assert.deepStrictEqual(lane.tags.map(t => t.name), ['Hyped', 'Chill']);
});

test('names and colours that render are stored as typed, never as markup (the page escapes them)', async () => {
  const feel = (await lanes()).find(l => l.name === 'Feel');
  const t = await json(await post('/api/stream-tags/tags', { laneId: feel.id, name: '<img src=x onerror=alert(1)>', color: '#000000' }));
  assert.strictEqual(t.name, '<img src=x onerror=alert(1)>');
  await json(await post(`/api/stream-tags/tags/${t.id}`, { color: '#000;background:url(x)' }), 400);
  await json(await del(`/api/stream-tags/tags/${t.id}`));
});

test('tagging: add, toggle, remove; Several per file adds up', async () => {
  const opener = await roleTag('Opener');
  const closer = await roleTag('Closer');
  let r = await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: [ids[0], ids[1]], op: 'add' }));
  assert.strictEqual(r.changed, 2);
  r = await json(await post('/api/stream-tags/assign', { tagId: closer.id, mediaIds: [ids[0]] }));
  assert.strictEqual(r.op, 'add');
  assert.deepStrictEqual(r.assignments[ids[0]].sort(), [opener.id, closer.id].sort());
  // Toggle on a mixed selection puts it on all; again takes it off all.
  r = await json(await post('/api/stream-tags/assign', { tagId: closer.id, mediaIds: [ids[0], ids[1]], op: 'toggle' }));
  assert.strictEqual(r.op, 'add');
  r = await json(await post('/api/stream-tags/assign', { tagId: closer.id, mediaIds: [ids[0], ids[1]], op: 'toggle' }));
  assert.strictEqual(r.op, 'remove');
  assert.deepStrictEqual(r.assignments[ids[0]], [opener.id]);
  // Ids not in the library are skipped.
  r = await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: [987654], op: 'add' }));
  assert.strictEqual(r.changed, 0);
  await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: ['1'] }), 400);
  await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: [ids[0]], op: 'flip' }), 400);
  await json(await post('/api/stream-tags/assign', { tagId: 999999, mediaIds: [ids[0]] }), 404);
});

test('One per file: tagging in the lane replaces the file\'s tag there; switching a lane to One trims', async () => {
  const feel = (await lanes()).find(l => l.name === 'Feel');
  const [hyped, chill] = feel.tags;
  await json(await post('/api/stream-tags/assign', { tagId: chill.id, mediaIds: [ids[2], ids[3]], op: 'add' }));
  const r = await json(await post('/api/stream-tags/assign', { tagId: hyped.id, mediaIds: [ids[2]], op: 'add' }));
  assert.deepStrictEqual(r.assignments[ids[2]], [hyped.id]);
  // Other lanes are untouched by the replace.
  const opener = await roleTag('Opener');
  await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: [ids[3]], op: 'add' }));
  await json(await post('/api/stream-tags/assign', { tagId: hyped.id, mediaIds: [ids[3]], op: 'add' }));
  const now = await json(await post('/api/stream-tags/for', { mediaIds: [ids[3]] }));
  assert.deepStrictEqual(now.assignments[ids[3]].sort(), [opener.id, hyped.id].sort());
  // Several per file, then back to One: each file keeps its first tag in the lane's order.
  await json(await post(`/api/stream-tags/lanes/${feel.id}`, { multi: true }));
  await json(await post('/api/stream-tags/assign', { tagId: chill.id, mediaIds: [ids[3]], op: 'add' }));
  const before = (await lanes()).find(l => l.id === feel.id);
  assert.strictEqual(before.several, 1);
  const one = await json(await post(`/api/stream-tags/lanes/${feel.id}`, { multi: false }));
  assert.strictEqual(one.trimmed, 1);
  const after = await json(await post('/api/stream-tags/for', { mediaIds: [ids[3]] }));
  assert.deepStrictEqual(after.assignments[ids[3]].sort(), [opener.id, hyped.id].sort());
});

test('reading: for a set of files, for a collection, and all of them', async () => {
  const c = await json(await get(`/api/stream-tags/collections/${coll}`));
  assert.ok(c.assignments[ids[0]].length >= 1);
  await json(await get('/api/stream-tags/collections/999999'), 404);
  const all = await json(await get('/api/stream-tags/assignments'));
  assert.ok(all.rows.some(([m]) => m === ids[0]));
  await json(await post('/api/stream-tags/for', { mediaIds: 'nope' }), 400);
});

test('clear: one lane or everything, on these files', async () => {
  const feel = (await lanes()).find(l => l.name === 'Feel');
  let r = await json(await post('/api/stream-tags/clear', { mediaIds: [ids[3]], laneId: feel.id }));
  assert.strictEqual(r.removed, 1);
  assert.strictEqual(r.assignments[ids[3]].length, 1);
  r = await json(await post('/api/stream-tags/clear', { mediaIds: [ids[3]] }));
  assert.strictEqual(r.assignments[ids[3]], undefined);
});

test('the library filter: filters.streamTag finds the files that carry it, and follows changes', async () => {
  const opener = await roleTag('Opener');
  const ask = async (filters) => (await json(await post('/api/library/query', { filters, pageSize: 50 }))).total;
  const n = await ask({ streamTag: opener.id });
  const expect = db.get().prepare('SELECT COUNT(*) AS n FROM media_stream_tags WHERE tag_id = ?').get(opener.id).n;
  assert.strictEqual(n, expect);
  await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: [ids[7]], op: 'add' }));
  assert.strictEqual(await ask({ streamTag: opener.id }), expect + 1);
  await json(await post('/api/library/query', { filters: { streamTag: 'x' } }), 400);
});

test('stream tags never touch the library tags', () => {
  const row = db.get().prepare('SELECT tags, themes FROM media WHERE id = ?').get(ids[0]);
  assert.ok(!String(row.tags || '').includes('Opener'));
  assert.ok(!String(row.themes || '').includes('Opener'));
});

test('cleanup: a deleted record, a deleted tag and a deleted lane take their assignments with them', async () => {
  const d = db.get();
  const opener = await roleTag('Opener');
  const gone = Number(d.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'gone.mp4', 'video')").run(path.join(tmp, 'gone.mp4')).lastInsertRowid);
  await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: [gone], op: 'add' }));
  db.deleteRecords([gone]);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM media_stream_tags WHERE media_id = ?').get(gone).n, 0);

  const lane = await json(await post('/api/stream-tags/lanes', { name: 'Moments' }));
  const a = await json(await post('/api/stream-tags/tags', { laneId: lane.id, name: 'Chat break', color: '#94a3b8', hotkey: 'B' }));
  const b = await json(await post('/api/stream-tags/tags', { laneId: lane.id, name: 'Shout-out', color: '#fde047', hotkey: 'S' }));
  await json(await post('/api/stream-tags/assign', { tagId: a.id, mediaIds: [ids[4], ids[5]], op: 'add' }));
  await json(await post('/api/stream-tags/assign', { tagId: b.id, mediaIds: [ids[5], ids[6]], op: 'add' }));
  const listed = (await lanes()).find(l => l.id === lane.id);
  assert.strictEqual(listed.files, 3);
  assert.deepStrictEqual(listed.tags.map(t => t.count), [2, 2]);
  const dt = await json(await del(`/api/stream-tags/tags/${a.id}`));
  assert.strictEqual(dt.files, 2);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM media_stream_tags WHERE tag_id = ?').get(a.id).n, 0);
  await json(await del(`/api/stream-tags/tags/${a.id}`), 404);
  const dl = await json(await post(`/api/stream-tags/lanes/${lane.id}/delete`, {}));
  assert.strictEqual(dl.files, 2);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM media_stream_tags WHERE tag_id = ?').get(b.id).n, 0);
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM stream_tags WHERE lane_id = ?').get(lane.id).n, 0);
  // Its keys are free again.
  const again = await json(await post('/api/stream-tags/tags', { laneId: (await lanes())[0].id, name: 'Shout', color: '#fde047', hotkey: 's' }));
  await json(await del(`/api/stream-tags/tags/${again.id}`));
});

test('Flow order over HTTP: places=1 puts First, Last and At a peak where they say; places lists them', async () => {
  const d = db.get();
  d.prepare('DELETE FROM media_stream_tags').run();
  const opener = await roleTag('Opener');
  const closer = await roleTag('Closer');
  const center = await roleTag('Centerpiece');
  // The wildest file opens, the first one closes, the calmest takes the peak.
  await json(await post('/api/stream-tags/assign', { tagId: opener.id, mediaIds: [ids[5]], op: 'add' }));
  await json(await post('/api/stream-tags/assign', { tagId: closer.id, mediaIds: [ids[0]], op: 'add' }));
  await json(await post('/api/stream-tags/assign', { tagId: center.id, mediaIds: [ids[6]], op: 'add' }));
  const off = await json(await get(`/api/flow/collections/${coll}?shape=build`));
  assert.strictEqual(off.placesOn, false);
  assert.deepStrictEqual(off.places, { [ids[5]]: 'first', [ids[0]]: 'last', [ids[6]]: 'peak' });
  const on = await json(await get(`/api/flow/collections/${coll}?shape=build&places=1`));
  assert.strictEqual(on.placesOn, true);
  assert.strictEqual(on.order[0], ids[5]);
  assert.strictEqual(on.order[on.order.length - 1], ids[0]);
  const top = on.targets.indexOf(Math.max(...on.targets.slice(0, -1)));
  assert.strictEqual(on.order[top], ids[6]);
  assert.notDeepStrictEqual(on.order, off.order);
  // A tag change shows at once (not a minute later from the cache).
  await json(await post('/api/stream-tags/clear', { mediaIds: [ids[5]] }));
  const changed = await json(await get(`/api/flow/collections/${coll}?shape=build&places=1`));
  assert.strictEqual(changed.places[ids[5]], undefined);
  await json(await get(`/api/flow/collections/${coll}?shape=build&places=yes`), 400);
});

test('the lock gate (423) and the CSRF guard cover the routes', async () => {
  vault._locked = true;
  try {
    assert.strictEqual((await get('/api/stream-tags')).status, 423);
    assert.strictEqual((await post('/api/stream-tags/lanes', { name: 'Locked' })).status, 423);
  } finally { vault._locked = false; }
  const r = await post('/api/stream-tags/lanes', { name: 'Evil' }, { Origin: 'http://evil.example' });
  assert.strictEqual(r.status, 403);
  assert.ok(!(await lanes()).some(l => l.name === 'Evil'));
});

test('Unicode: keys stay one key in either case; names compare in any case and composition; invisible names refused', async () => {
  const d = db.get();
  const H = (v) => { try { return tags.cleanHotkey(v); } catch (e) { return e.code || 'BAD'; } };
  // One key upper case and lower case: ß (SS), ŉ (ʼN), ﬁ (FI) are not.
  for (const k of ['ß', 'ŉ', 'ﬁ', '́', '​', '‮', ' ', '�']) assert.strictEqual(H(k), 'BAD_REQUEST', JSON.stringify(k));
  assert.strictEqual(H('é'), 'É');
  assert.strictEqual(H('é'), 'É', 'a composed key is one key');
  assert.strictEqual(H('ж'), 'Ж');
  const N = (v) => { try { return tags.cleanName(v, 'Tag'); } catch (e) { return e.code; } };
  for (const v of ['​', '​‍⁠', '‮‭', '́̂', 'ㅤ', ' ﻿ ']) assert.strictEqual(N(v), 'BAD_REQUEST', JSON.stringify(v));
  // Bidi overrides are taken out of names.
  assert.strictEqual(N('Clo‮ser'), 'Closer');
  assert.strictEqual(N('Café'), 'Café');
  // Taken in any case and composition, not only A to Z.
  const lane = await json(await post('/api/stream-tags/lanes', { name: 'Ärger' }));
  assert.strictEqual((await json(await post('/api/stream-tags/lanes', { name: 'ärger' }), 409)).code, 'NAME_TAKEN');
  assert.strictEqual((await json(await post('/api/stream-tags/lanes', { name: 'ÄRGER' }), 409)).code, 'NAME_TAKEN');
  const t = await json(await post('/api/stream-tags/tags', { laneId: lane.id, name: 'Café', color: '#123456', hotkey: 'ж' }));
  assert.strictEqual((await json(await post('/api/stream-tags/tags', { laneId: lane.id, name: 'CAFÉ', color: '#123456' }), 409)).code, 'NAME_TAKEN');
  assert.strictEqual((await json(await post('/api/stream-tags/tags', { laneId: lane.id, name: 'Other', color: '#123456', hotkey: 'Ж' }), 409)).code, 'HOTKEY_TAKEN');
  await json(await del(`/api/stream-tags/tags/${t.id}`));
  await json(await del(`/api/stream-tags/lanes/${lane.id}`));
  assert.ok(d);
});
