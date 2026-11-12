/**
 * Custom, server side (lib/flow/custom.js): the collection's own order kept
 * while a Flow shape is in. POST /api/collections/:id/order with flow (a
 * shape, or null), GET /api/flow/collections/:id/custom, the drop on any
 * other write, files coming and going, Duplicate, Delete, skips never
 * touched, and the table's migration both ways (a library from before it;
 * an older Vault using a library that has it).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-flow-custom-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const custom = require('../lib/flow/custom');
const { app } = require('../server/index');

let server, base, coll, folder;
const m = [];

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < 6; i++) m.push(Number(ins.run(path.join(tmp, `f${i}.mp4`), `f${i}.mp4`, 'video', 60).lastInsertRowid));
  coll = db.createCollection('Friday').id;
  db.addToCollection(coll, m.slice(0, 5));
  folder = db.createCollection('A folder', { kind: 'folder' }).id;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const send = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const order = (c = coll) => db.getCollectionItems(c);
const kept = async (c = coll) => (await send('GET', `/api/flow/collections/${c}/custom`)).body.custom;
const rowCount = () => db.get().prepare('SELECT COUNT(*) FROM flow_custom_orders').pluck().get();

test('the table: one row per collection, nothing in it until a shape is put in', () => {
  assert.strictEqual(rowCount(), 0);
  const cols = db.get().prepare('PRAGMA table_info(flow_custom_orders)').all();
  assert.deepStrictEqual(cols.map(c => c.name), ['collection_id', 'order_json', 'shape', 'waves', 'places', 'shaped_json', 'updated_at']);
  assert.strictEqual(cols.find(c => c.name === 'collection_id').pk, 1);
  custom.ensureSchema(db.get());   // twice is fine
});

test('a shape from Custom keeps the order from before; shape to shape keeps it; Custom (flow null) drops it; each answer says what was', async () => {
  const mine = order();
  const waves = [m[4], m[2], m[0], m[1], m[3]];
  let r = await send('POST', `/api/collections/${coll}/order`, { order: waves, flow: { shape: 'waves', waves: 3, places: false } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.flow_custom, { custom: mine, shape: 'waves', waves: 3, places: false, shaped: waves, lit: true });
  assert.strictEqual(r.body.flow_custom_was, null);
  assert.deepStrictEqual(await kept(), { custom: mine, shape: 'waves', waves: 3, places: false, shaped: waves, lit: true });
  const peak = [m[0], m[4], m[2], m[3], m[1]];
  r = await send('POST', `/api/collections/${coll}/order`, { order: peak, flow: { shape: 'peak' } });
  assert.deepStrictEqual(r.body.flow_custom.custom, mine, 'shape to shape keeps the custom order');
  assert.deepStrictEqual(r.body.flow_custom_was, { custom: mine, shape: 'waves', waves: 3, places: false, shaped: waves, lit: true });
  // Custom: the kept order written back with flow null.
  r = await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
  assert.strictEqual(r.body.flow_custom, null);
  assert.strictEqual(r.body.flow_custom_was.shape, 'peak');
  assert.strictEqual(await kept(), null);
  assert.deepStrictEqual(order(), mine);
  // Its Undo: the peak order and exactly what was kept.
  const was = r.body.flow_custom_was;
  r = await send('POST', `/api/collections/${coll}/order`, { order: peak, flow: { shape: was.shape, waves: was.waves, places: was.places, custom: was.custom } });
  assert.deepStrictEqual(await kept(), { custom: mine, shape: 'peak', waves: 2, places: false, shaped: peak, lit: true });
  // Without flow (a drag, its Undo): that order is the custom one, nothing kept, and the answer has no flow fields.
  r = await send('POST', `/api/collections/${coll}/order`, { move: [m[1]], before: m[0] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.flow_custom, undefined);
  assert.strictEqual(await kept(), null);
  await send('POST', `/api/collections/${coll}/order`, { order: mine });
});

test('a kept row the playlist is no longer in (an older Vault wrote the order): not lit, and the next shape keeps the order there now', async () => {
  const mine = order();
  const shaped = mine.slice().reverse();
  await send('POST', `/api/collections/${coll}/order`, { order: shaped, flow: { shape: 'smooth' } });
  // 3.10's statement, word for word: positions written straight.
  const set = db.get().prepare('UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_id = ? AND position IS NOT ?');
  const other = [shaped[1], shaped[0], ...shaped.slice(2)];
  other.forEach((id, i) => set.run(i, coll, id, i));
  assert.strictEqual((await kept()).lit, false);
  const r = await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: { shape: 'build' } });
  assert.deepStrictEqual(r.body.flow_custom.custom, other, 'the order before this write, not the stale one');
  assert.strictEqual(r.body.flow_custom_was.lit, false, 'an Undo of this goes back to Custom');
  await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
});

test('files added and taken out while a shape is in: still lit, the kept order without the gone files and with the new ones at the end', async () => {
  const mine = order();
  const shaped = mine.slice().reverse();
  await send('POST', `/api/collections/${coll}/order`, { order: shaped, flow: { shape: 'steady' } });
  db.removeFromCollection(coll, [mine[1]]);
  db.addToCollection(coll, [m[5]]);
  const c = await kept();
  assert.strictEqual(c.lit, true);
  assert.deepStrictEqual(c.custom, [mine[0], ...mine.slice(2), m[5]]);
  await send('POST', `/api/collections/${coll}/order`, { order: c.custom, flow: null });
  db.removeFromCollection(coll, [m[5]]);
  db.addToCollection(coll, [mine[1]]);
  await send('POST', `/api/collections/${coll}/order`, { order: mine });
});

test('flow never changes the skips; bad flow is refused and nothing is written', async () => {
  const mine = order();
  db.replaceCollectionSkips(coll, [mine[2]]);
  await send('POST', `/api/collections/${coll}/order`, { order: mine.slice().reverse(), flow: { shape: 'peak' } });
  assert.deepStrictEqual(db.getCollectionSkips(coll), [mine[2]]);
  await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
  assert.deepStrictEqual(db.getCollectionSkips(coll), [mine[2]]);
  for (const flow of ['waves', { shape: 'zigzag' }, { shape: 'waves', waves: 9 }, { shape: 'peak', places: 'yes' }, { shape: 'peak', custom: [0] }, [1]]) {
    const r = await send('POST', `/api/collections/${coll}/order`, { order: mine.slice().reverse(), flow });
    assert.strictEqual(r.status, 400, JSON.stringify(flow));
  }
  assert.deepStrictEqual(order(), mine);
  assert.strictEqual(await kept(), null);
  assert.strictEqual((await send('POST', `/api/collections/${folder}/order`, { order: [], flow: null })).status, 400);
  assert.strictEqual((await send('GET', '/api/flow/collections/abc/custom')).status, 400);
  db.replaceCollectionSkips(coll, []);
});

test('Duplicate copies what is kept (the copy is lit too); Delete removes it', async () => {
  const mine = order();
  const shaped = mine.slice().reverse();
  await send('POST', `/api/collections/${coll}/order`, { order: shaped, flow: { shape: 'waves', waves: 4, places: true } });
  const copy = db.duplicateCollection(coll).id;
  assert.deepStrictEqual(await kept(copy), await kept(coll));
  assert.strictEqual((await kept(copy)).lit, true);
  // Each on its own afterwards.
  await send('POST', `/api/collections/${copy}/order`, { order: (await kept(copy)).custom, flow: null });
  assert.strictEqual(await kept(copy), null);
  assert.strictEqual((await kept(coll)).shape, 'waves');
  await send('POST', `/api/collections/${copy}/order`, { order: shaped, flow: { shape: 'peak' } });
  const n = rowCount();
  db.deleteCollection(copy);
  assert.strictEqual(rowCount(), n - 1);
  await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
});

/* ── Migration both ways (child processes, their own library) ── */

function child(work) {
  const env = { ...process.env, VAULT_DB: path.join(work, 'library.db'), VAULT_SETTINGS_FILE: path.join(work, 'settings.json') };
  return (body) => {
    const r = cp.spawnSync(process.execPath, ['-e', `const out = {}; ${body}; console.log('@@' + JSON.stringify(out));`],
      { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 120000 });
    const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('@@'));
    assert.ok(line, `child produced no result: ${r.stderr}`);
    return JSON.parse(line.slice(2));
  };
}

test('a library from before Custom (no table) opens: the table is added, the order untouched', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-custom-old-'));
  const run = child(work);
  try {
    run(`const db = require('./lib/database'); db.init();
      const d = db.get();
      const ins = d.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
      const a = ins.run('/a.mp4', 'a.mp4').lastInsertRowid, b = ins.run('/b.mp4', 'b.mp4').lastInsertRowid;
      const c = db.createCollection('Kept').id; db.addToCollection(c, [Number(b), Number(a)]);
      d.exec('DROP TABLE flow_custom_orders');
      db.close();`);
    const out = run(`const db = require('./lib/database'); db.init();
      const c = db.getCollections().find(x => x.name === 'Kept').id;
      out.table = !!db.get().prepare("SELECT name FROM sqlite_master WHERE name = 'flow_custom_orders'").get();
      out.names = db.getCollectionItems(c).map(id => db.get().prepare('SELECT filename FROM media WHERE id = ?').pluck().get(id));
      out.custom = require('./lib/flow/custom').state(db.get(), c);
      db.close();`);
    assert.strictEqual(out.table, true);
    assert.deepStrictEqual(out.names, ['b.mp4', 'a.mp4']);
    assert.strictEqual(out.custom, null);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
});

test('an older Vault using a library that has the table: its own statements still work, and a collection it deleted loses its row on the next start', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-custom-older-'));
  const run = child(work);
  try {
    const old = run(`const db = require('./lib/database'); db.init();
      const d = db.get();
      const ins = d.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
      const ids = [1, 2, 3].map(i => Number(ins.run('/' + i + '.mp4', i + '.mp4').lastInsertRowid));
      const c = db.createCollection('Shaped').id; db.addToCollection(c, ids);
      db.reorderCollectionFull(c, { order: ids.slice().reverse() }, { flow: require('./lib/flow/custom').cleanFlow({ shape: 'peak' }) });
      out.c = c;
      // 3.10's own statements, word for word (lib/database.js): reorder, duplicate, delete.
      const set = d.prepare('UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_id = ? AND position IS NOT ?');
      ids.forEach((id, i) => set.run(i, c, id, i));
      const dup = Number(d.prepare('INSERT INTO collections (name, description, parent_id, kind) VALUES (?, ?, ?, ?)').run('Shaped copy', '', null, 'collection').lastInsertRowid);
      d.prepare('INSERT INTO collection_items (collection_id, media_id, position, added_at, skipped) SELECT ?, media_id, position, added_at, skipped FROM collection_items WHERE collection_id = ?').run(dup, c);
      out.dupItems = db.getCollectionItems(dup).length;
      out.lit = require('./lib/flow/custom').state(d, c).lit;
      d.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(c);
      d.prepare('DELETE FROM collections WHERE id = ?').run(c);
      out.orphan = d.prepare('SELECT COUNT(*) FROM flow_custom_orders WHERE collection_id = ?').pluck().get(c);
      db.close();`);
    assert.strictEqual(old.dupItems, 3, 'its duplicate copies the files');
    assert.strictEqual(old.lit, false, 'its reorder takes the shape out: Custom lit');
    assert.strictEqual(old.orphan, 1, 'its delete leaves the row');
    const out = run(`const db = require('./lib/database'); db.init();
      out.rows = db.get().prepare('SELECT COUNT(*) FROM flow_custom_orders').pluck().get();
      db.close();`);
    assert.strictEqual(out.rows, 0, 'the deleted collection\'s row is gone on the next start');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
});
