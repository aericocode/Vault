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

test('a shape from Custom keeps the order from before; shape to shape keeps it; Custom (no flow) leaves it waiting; Undo puts back exactly what was', async () => {
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
  const wasWaves = r.body.flow_custom_was;
  assert.deepStrictEqual(wasWaves, { custom: mine, shape: 'waves', waves: 3, places: false, shaped: waves, lit: true });
  // Custom: the kept order written back without flow: the row stays, not lit.
  r = await send('POST', `/api/collections/${coll}/order`, { order: mine });
  assert.deepStrictEqual(r.body.flow_custom, { custom: mine, shape: 'peak', waves: 2, places: false, shaped: peak, lit: false });
  assert.deepStrictEqual(order(), mine);
  // Its Undo (the peak order, no flow): lit again.
  r = await send('POST', `/api/collections/${coll}/order`, { order: peak });
  assert.strictEqual(r.body.flow_custom.lit, true);
  // Undo of Peak: the waves order and exactly the row from before it.
  r = await send('POST', `/api/collections/${coll}/order`, { order: waves, flow: { shape: wasWaves.shape, waves: wasWaves.waves, places: wasWaves.places, custom: wasWaves.custom, shaped: wasWaves.shaped } });
  assert.deepStrictEqual(await kept(), { custom: mine, shape: 'waves', waves: 3, places: false, shaped: waves, lit: true });
  // Undo of Waves (there was no row before it): flow null removes it.
  r = await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
  assert.strictEqual(r.body.flow_custom, null);
  assert.strictEqual(await kept(), null);
});

test('an exact restore keeps a waiting row waiting: the Undo of a shape picked over it gives back the old kept order and its old shaped order', async () => {
  const mine = order();
  const smooth = mine.slice().reverse();
  await send('POST', `/api/collections/${coll}/order`, { order: smooth, flow: { shape: 'smooth' } });
  const dragged = [smooth[1], smooth[0], ...smooth.slice(2)];
  await send('POST', `/api/collections/${coll}/order`, { order: dragged });   // a drag: the row waits
  assert.strictEqual((await kept()).lit, false);
  const build = [dragged[2], ...dragged.filter((_, i) => i !== 2)];
  let r = await send('POST', `/api/collections/${coll}/order`, { order: build, flow: { shape: 'build' } });
  assert.deepStrictEqual(r.body.flow_custom.custom, dragged, 'picked over a waiting row: the order before is the custom one');
  const was = r.body.flow_custom_was;
  assert.deepStrictEqual([was.custom, was.shaped, was.lit], [mine, smooth, false]);
  r = await send('POST', `/api/collections/${coll}/order`, { order: dragged, flow: { shape: was.shape, waves: was.waves, places: was.places, custom: was.custom, shaped: was.shaped } });
  assert.deepStrictEqual(await kept(), { custom: mine, shape: 'smooth', waves: 2, places: false, shaped: smooth, lit: false });
  // Dragged back to the smooth order by hand: lit again, Custom gives mine.
  await send('POST', `/api/collections/${coll}/order`, { order: smooth });
  assert.deepStrictEqual([(await kept()).lit, (await kept()).custom], [true, mine]);
  await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
});

test('the kept order survives every write that is not a shape pick (real routes): Remove and its Undo, Add, a drag and its Undo, a saved order with skips, a plain order from another client', async () => {
  const mine = order();
  const peak = [mine[2], mine[0], mine[4], mine[1], mine[3]];
  await send('POST', `/api/collections/${coll}/order`, { order: peak, flow: { shape: 'peak' } });
  const restored = async (what) => {
    assert.deepStrictEqual(order(), peak, what);
    const c = await kept();
    assert.strictEqual(c.lit, true, `${what}: Peak lit again`);
    assert.deepStrictEqual(c.custom, mine, `${what}: the kept order, exactly`);
  };
  // Remove, then its Undo (collections.js undoRemoveFromCollection: add back, then the old order without flow).
  await send('DELETE', `/api/collections/${coll}/items`, { ids: [peak[1]] });
  assert.strictEqual((await kept()).lit, true, 'a file taken out: still the shape');
  await send('POST', `/api/collections/${coll}/items`, { ids: [peak[1]] });
  assert.strictEqual((await kept()).lit, false, 'back at the end: not the shape');
  await send('POST', `/api/collections/${coll}/order`, { order: peak });
  await restored('Remove and its Undo');
  // A drag (move) and its Undo (the whole order).
  await send('POST', `/api/collections/${coll}/order`, { move: [peak[4]], before: peak[0] });
  assert.strictEqual((await kept()).lit, false);
  await send('POST', `/api/collections/${coll}/order`, { order: peak });
  await restored('a drag and its Undo');
  // A saved order loaded (order and skips together) and its Undo.
  await send('POST', `/api/collections/${coll}/order`, { order: mine.slice().reverse(), skips: [mine[0]] });
  await send('POST', `/api/collections/${coll}/order`, { order: peak, skips: [] });
  await restored('a saved order and its Undo');
  // Add a file (at the end): still lit; taken out again: still lit.
  await send('POST', `/api/collections/${coll}/items`, { ids: [m[5]] });
  assert.strictEqual((await kept()).lit, true, 'a file added at the end keeps the shape');
  assert.deepStrictEqual((await kept()).custom, [...mine, m[5]], 'and Custom would put it at the end');
  await send('DELETE', `/api/collections/${coll}/items`, { ids: [m[5]] });
  await restored('a file added and taken out');
  // Custom (no flow) and its Undo.
  await send('POST', `/api/collections/${coll}/order`, { order: mine });
  await send('POST', `/api/collections/${coll}/order`, { order: peak });
  await restored('Custom and its Undo');
  // A playlist import into the collection (lib/playlist/import.js onRowsAdded, its statements word for word:
  // the file in at -1, then every position written), then its Undo (the file taken out).
  const d = db.get();
  d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)').run(coll, m[5], -1);
  const setPos = d.prepare('UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_id = ? AND position IS NOT ?');
  [...peak.slice(0, 2), m[5], ...peak.slice(2)].forEach((id, i) => setPos.run(i, coll, id, i));
  assert.strictEqual((await kept()).lit, false, 'placed mid-way: not the shape');
  db.removeFromCollection(coll, [m[5]]);
  await restored('an import and its Undo');
  await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
});

test('a shaped list that cannot be read, is empty, or has none of the files is never lit', () => {
  const d = db.get();
  const mine = order();
  const put = (shaped) => d.prepare(`INSERT OR REPLACE INTO flow_custom_orders (collection_id, order_json, shape, waves, places, shaped_json, updated_at)
    VALUES (?, ?, 'peak', 2, 0, ?, 0)`).run(coll, JSON.stringify(mine), shaped);
  for (const shaped of ['garbage', '[]', 'null', '[999998,999999]', '{"a":1}']) {
    put(shaped);
    assert.strictEqual(custom.state(d, coll).lit, false, shaped);
  }
  put(JSON.stringify(mine));
  assert.strictEqual(custom.state(d, coll).lit, true, 'a good one is');
  custom.removeFor(d, coll);
});

test('the custom order keeps only files of the collection: one added later goes at the end when Custom brings it back', async () => {
  const mine = order();
  const shaped = mine.slice().reverse();
  // An Undo sending a list with a file that is not in the collection (m[5]) and one that is in no library row.
  await send('POST', `/api/collections/${coll}/order`, { order: shaped, flow: { shape: 'peak', custom: [m[5], mine[3], 999999, ...mine], shaped: [999999, ...shaped] } });
  const row = db.get().prepare('SELECT order_json, shaped_json FROM flow_custom_orders WHERE collection_id = ?').get(coll);
  assert.deepStrictEqual(JSON.parse(row.order_json), [mine[3], mine[0], mine[1], mine[2], mine[4]], 'only members, in the order sent');
  assert.deepStrictEqual(JSON.parse(row.shaped_json), shaped);
  await send('POST', `/api/collections/${coll}/items`, { ids: [m[5]] });
  assert.deepStrictEqual((await kept()).custom, [mine[3], mine[0], mine[1], mine[2], mine[4], m[5]], 'the new file at the end');
  await send('DELETE', `/api/collections/${coll}/items`, { ids: [m[5]] });
  await send('POST', `/api/collections/${coll}/order`, { order: mine, flow: null });
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
  assert.strictEqual(r.body.flow_custom_was.lit, false, 'an Undo of this puts back a waiting row: Custom lit');
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
  for (const flow of ['waves', { shape: 'zigzag' }, { shape: 'waves', waves: 9 }, { shape: 'peak', places: 'yes' }, { shape: 'peak', custom: [0] }, { shape: 'peak', shaped: [1] }, { shape: 'peak', custom: [1], shaped: 'x' }, [1]]) {
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
