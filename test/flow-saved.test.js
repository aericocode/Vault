/**
 * Saved Flow orders over HTTP against the real app (server/flow-routes.js,
 * lib/flow/saved.js): list, save, rename, replace, delete; what is refused
 * (bad input, a name taken in the same collection, more than 30); the lock
 * gate; Duplicate copying them and Delete taking them with the collection.
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-flow-saved-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const saved = require('../lib/flow/saved');
const { app } = require('../server/index');

let server, base, coll, other, folder;
const ids = [];

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, ?)');
  for (let i = 0; i < 5; i++) ids.push(Number(ins.run(path.join(tmp, `f${i}.mp4`), `f${i}.mp4`, 'video').lastInsertRowid));
  coll = db.createCollection('Friday stream').id;
  db.addToCollection(coll, ids);
  other = db.createCollection('Other').id;
  folder = db.createCollection('A folder', { kind: 'folder' }).id;
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

const send = (method, p, body) => fetch(base + p, {
  method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const list = async (cid) => (await send('GET', `/api/flow/collections/${cid}/saved`)).json();
const order = () => [ids[3], ids[1], ids[4], ids[0], ids[2]];

test('save, list, rename, replace and delete', async () => {
  let r = await send('POST', `/api/flow/collections/${coll}/saved`, { name: '  Friday set ', shape: 'waves', waves: 3, places: true, order: order() });
  assert.strictEqual(r.status, 200);
  const a = await r.json();
  assert.strictEqual(a.name, 'Friday set', 'the name is trimmed');
  assert.deepStrictEqual({ shape: a.shape, waves: a.waves, places: a.places, order: a.order, collectionId: a.collectionId },
    { shape: 'waves', waves: 3, places: true, order: order(), collectionId: coll });

  r = await send('POST', `/api/flow/collections/${coll}/saved`, { name: 'Calm start', shape: 'build', order: [ids[0], ids[1]] });
  const b = await r.json();
  assert.strictEqual(b.waves, 2, 'waves missing: 2');
  assert.strictEqual(b.places, false);
  assert.deepStrictEqual((await list(coll)).map(s => s.name), ['Friday set', 'Calm start']);
  assert.deepStrictEqual(await list(other), []);

  // Rename only: what it holds stays.
  r = await send('PUT', `/api/flow/saved/${b.id}`, { name: 'Slow build' });
  assert.strictEqual(r.status, 200);
  const b2 = await r.json();
  assert.strictEqual(b2.name, 'Slow build');
  assert.deepStrictEqual(b2.order, [ids[0], ids[1]]);
  // Its own name in another case is not "taken".
  assert.strictEqual((await send('PUT', `/api/flow/saved/${b.id}`, { name: 'SLOW BUILD' })).status, 200);

  // Replace what it holds (Update with this order).
  r = await send('PUT', `/api/flow/saved/${a.id}`, { shape: 'peak', waves: 1, places: false, order: [ids[4], ids[3], ids[2], ids[1], ids[0]] });
  const a2 = await r.json();
  assert.deepStrictEqual({ name: a2.name, shape: a2.shape, waves: a2.waves, places: a2.places, order: a2.order },
    { name: 'Friday set', shape: 'peak', waves: 1, places: false, order: [ids[4], ids[3], ids[2], ids[1], ids[0]] });
  assert.ok(a2.updatedAt >= a.updatedAt);

  r = await send('DELETE', `/api/flow/saved/${b.id}`);
  assert.deepStrictEqual(await r.json(), { ok: true });
  assert.deepStrictEqual((await list(coll)).map(s => s.name), ['Friday set']);
  assert.strictEqual((await send('DELETE', `/api/flow/saved/${b.id}`)).status, 404);
  assert.strictEqual((await send('PUT', `/api/flow/saved/${b.id}`, { name: 'x' })).status, 404);
  await send('DELETE', `/api/flow/saved/${a.id}`);
});

test('bad input is refused with the reason', async () => {
  const ok = { name: 'Fine', shape: 'smooth', order: [ids[0]] };
  const bad = [
    { name: '' }, { name: '   ' }, { name: 'x'.repeat(81) }, { name: 7 },
    { shape: 'zigzag' }, { shape: undefined },
    { waves: 0 }, { waves: 7 }, { waves: 2.5 }, { waves: '3' },
    { places: 'yes' },
    { order: 'nope' }, { order: [1, -2] }, { order: [0] }, { order: [1.5] }, { order: ['3'] }, { order: [2 ** 53] },
    { order: Array.from({ length: saved.ORDER_MAX + 1 }, (_, i) => i + 1) }, { order: undefined },
  ];
  for (const b of bad) {
    const r = await send('POST', `/api/flow/collections/${coll}/saved`, { ...ok, ...b });
    assert.strictEqual(r.status, 400, JSON.stringify(b).slice(0, 60));
    const j = await r.json();
    assert.strictEqual(j.code, 'BAD');
    assert.ok(j.error, 'says why');
  }
  assert.strictEqual((await send('POST', '/api/flow/collections/abc/saved', ok)).status, 400);
  assert.strictEqual((await send('POST', '/api/flow/collections/99999/saved', ok)).status, 404);
  assert.strictEqual((await send('POST', `/api/flow/collections/${folder}/saved`, ok)).status, 400);
  assert.strictEqual((await send('PUT', '/api/flow/saved/0', { name: 'x' })).status, 400);
  // 80 characters is fine; repeats in the order are dropped.
  const r = await send('POST', `/api/flow/collections/${coll}/saved`, { ...ok, name: 'y'.repeat(80), order: [ids[1], ids[0], ids[1]] });
  assert.strictEqual(r.status, 200);
  const row = await r.json();
  assert.deepStrictEqual(row.order, [ids[1], ids[0]]);
  // Nothing to change.
  assert.strictEqual((await send('PUT', `/api/flow/saved/${row.id}`, {})).status, 400);
  assert.strictEqual((await send('PUT', `/api/flow/saved/${row.id}`, { shape: 'nope' })).status, 400);
  await send('DELETE', `/api/flow/saved/${row.id}`);
  assert.deepStrictEqual(await list(coll), []);
});

test('names are unique per collection, ignoring case', async () => {
  const body = (name) => ({ name, shape: 'smooth', order: [ids[0]] });
  const a = await (await send('POST', `/api/flow/collections/${coll}/saved`, body('Late night'))).json();
  let r = await send('POST', `/api/flow/collections/${coll}/saved`, body(' LATE NIGHT '));
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).code, 'NAME_TAKEN');
  // Another collection may use it.
  r = await send('POST', `/api/flow/collections/${other}/saved`, body('late night'));
  assert.strictEqual(r.status, 200);
  const o = await r.json();
  // A rename onto a taken name is refused too.
  const b = await (await send('POST', `/api/flow/collections/${coll}/saved`, body('Early'))).json();
  r = await send('PUT', `/api/flow/saved/${b.id}`, { name: 'late Night' });
  assert.strictEqual(r.status, 409);
  for (const id of [a.id, b.id, o.id]) await send('DELETE', `/api/flow/saved/${id}`);
});

test('a collection keeps at most 30', async () => {
  const made = [];
  for (let i = 0; i < saved.MAX_PER_COLLECTION; i++) {
    const r = await send('POST', `/api/flow/collections/${coll}/saved`, { name: `Set ${i}`, shape: 'smooth', order: [ids[0]] });
    assert.strictEqual(r.status, 200);
    made.push((await r.json()).id);
  }
  const r = await send('POST', `/api/flow/collections/${coll}/saved`, { name: 'One more', shape: 'smooth', order: [ids[0]] });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await r.json()).code, 'FULL');
  // Another collection is not full.
  const o = await send('POST', `/api/flow/collections/${other}/saved`, { name: 'One more', shape: 'smooth', order: [ids[0]] });
  assert.strictEqual(o.status, 200);
  await send('DELETE', `/api/flow/saved/${(await o.json()).id}`);
  for (const id of made) await send('DELETE', `/api/flow/saved/${id}`);
});

test('locked: 423, nothing read or written', async () => {
  vault._locked = true;
  try {
    assert.strictEqual((await send('GET', `/api/flow/collections/${coll}/saved`)).status, 423);
    assert.strictEqual((await send('POST', `/api/flow/collections/${coll}/saved`, { name: 'x', shape: 'smooth', order: [] })).status, 423);
    assert.strictEqual((await send('DELETE', '/api/flow/saved/1')).status, 423);
  } finally { vault._locked = false; }
  assert.deepStrictEqual(await list(coll), []);
});

test('Duplicate copies the saved orders; Delete takes them with the collection', async () => {
  const d = db.get();
  const src = db.createCollection('Dup me').id;
  db.addToCollection(src, ids);
  const one = saved.create(d, src, { name: 'One', shape: 'waves', waves: 4, places: true, order: order() });
  saved.create(d, src, { name: 'Two', shape: 'peak', order: [ids[2]] });

  const r = await send('POST', `/api/collections/${src}/duplicate`);
  assert.strictEqual(r.status, 200);
  const copy = await r.json();
  const mine = await list(src);
  const theirs = await list(copy.id);
  const strip = (s) => ({ name: s.name, shape: s.shape, waves: s.waves, places: s.places, order: s.order });
  assert.deepStrictEqual(theirs.map(strip), mine.map(strip));
  assert.ok(theirs.every(s => s.collectionId === copy.id && !mine.some(m => m.id === s.id)), 'new rows, not shared ones');

  // Changing the copy's leaves the original's alone.
  await send('PUT', `/api/flow/saved/${theirs[0].id}`, { name: 'Changed' });
  assert.strictEqual(saved.get(d, one.id).name, 'One');

  db.deleteCollection(src);
  assert.deepStrictEqual(saved.list(d, src), []);
  assert.strictEqual(saved.list(d, copy.id).length, 2, 'the copy keeps its own');
});
