/**
 * Custom, server side (lib/flow/custom.js): the collection's own order kept
 * while a Flow shape is in, and which of Custom and the shapes is lit (the
 * row's mode). POST /api/collections/:id/order with flow (a shape, Custom,
 * by hand, an Undo), GET /api/flow/collections/:id/custom, writes that say
 * nothing, files coming and going, Duplicate, Delete, skips never touched,
 * and the table's migration both ways (a library from before it or from
 * before mode; an older Vault using a library that has it).
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
const post = (body, c = coll) => send('POST', `/api/collections/${c}/order`, body);
/** The flow an Undo of this answer sends (player-lib/flow.js flowUndoOf). */
const undoOf = (answer) => {
  const was = answer.flow_custom_was, now = answer.flow_custom;
  return { restore: was ? { mode: was.mode, shape: was.shape, waves: was.waves, places: was.places, kept: was.kept, rev: was.rev } : null, rev: now ? now.rev : null };
};
const strip = (r) => r && { mode: r.mode, shape: r.shape, waves: r.waves, places: r.places, kept: r.kept, custom: r.custom, lit: r.lit };
/** Back to no row and this order. */
const clear = async (o) => {
  const k = await kept();
  await post({ order: o, flow: { restore: null, rev: k ? k.rev : null } });
  assert.strictEqual(await kept(), null);
};

test('the table: one row per collection, nothing in it until a shape is put in; mode and rev added', () => {
  assert.strictEqual(rowCount(), 0);
  const cols = db.get().prepare('PRAGMA table_info(flow_custom_orders)').all();
  assert.deepStrictEqual(cols.map(c => c.name), ['collection_id', 'order_json', 'shape', 'waves', 'places', 'shaped_json', 'updated_at', 'mode', 'rev']);
  assert.strictEqual(cols.find(c => c.name === 'collection_id').pk, 1);
  custom.ensureSchema(db.get());   // twice is fine
});

test('a shape from Custom keeps the order from before; shape to shape keeps it; Custom writes it back on the server; each Undo puts back exactly the row', async () => {
  const mine = order();
  const waves = [m[4], m[2], m[0], m[1], m[3]];
  const w = await post({ order: waves, flow: { shape: 'waves', waves: 3, places: false } });
  assert.strictEqual(w.status, 200);
  assert.deepStrictEqual(strip(w.body.flow_custom), { mode: 'shape', shape: 'waves', waves: 3, places: false, kept: mine, custom: mine, lit: true });
  assert.strictEqual(w.body.flow_custom_was, null);
  assert.deepStrictEqual(await kept(), w.body.flow_custom);
  const peak = [m[0], m[4], m[2], m[3], m[1]];
  const p = await post({ order: peak, flow: { shape: 'peak' } });
  assert.deepStrictEqual(p.body.flow_custom.kept, mine, 'shape to shape keeps the custom order');
  assert.strictEqual(p.body.flow_custom.shape, 'peak');
  assert.deepStrictEqual(p.body.flow_custom_was, w.body.flow_custom);
  // The same shape again: nothing changes (no new rev: an Undo before it still fits).
  const again = await post({ order: peak, flow: { shape: 'peak' } });
  assert.strictEqual(again.body.flow_custom.rev, p.body.flow_custom.rev);
  // Custom: no order sent; the server writes the kept order, mode custom, the kept order stays.
  const c = await post({ flow: { custom: true } });
  assert.strictEqual(c.status, 200, JSON.stringify(c.body));
  assert.deepStrictEqual(c.body.order, mine);
  assert.deepStrictEqual(order(), mine);
  assert.deepStrictEqual(strip(c.body.flow_custom), { mode: 'custom', shape: 'peak', waves: 2, places: false, kept: mine, custom: mine, lit: false });
  // Custom again: nothing written.
  const c2 = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c2.body.order, mine);
  assert.strictEqual(c2.body.flow_custom.rev, c.body.flow_custom.rev);
  // Undo of Custom: the peak order and the row exactly (its rev too).
  await post({ order: peak, flow: undoOf(c.body) });
  assert.deepStrictEqual(order(), peak);
  assert.deepStrictEqual(await kept(), p.body.flow_custom);
  // Undo of Peak: the waves order and exactly the row from before it.
  await post({ order: waves, flow: undoOf(p.body) });
  assert.deepStrictEqual(await kept(), w.body.flow_custom);
  // Undo of Waves (there was no row before it): removed.
  const u = await post({ order: mine, flow: undoOf(w.body) });
  assert.strictEqual(u.body.flow_custom, null);
  assert.strictEqual(await kept(), null);
  assert.deepStrictEqual(order(), mine);
});

test('the checker\'s repro: Peak lit, a file taken out and added again at the end; Peak stays lit and Custom puts it back in its kept place', async () => {
  const mine = order();
  const peak = [mine[2], mine[0], mine[4], mine[1], mine[3]];
  const p = await post({ order: peak, flow: { shape: 'peak' } });
  await send('DELETE', `/api/collections/${coll}/items`, { ids: [mine[3]] });
  assert.strictEqual((await kept()).lit, true);
  await send('POST', `/api/collections/${coll}/items`, { ids: [mine[3]] });
  const k = await kept();
  assert.strictEqual(k.lit, true, 'still Peak: nothing is compared');
  assert.strictEqual(k.rev, p.body.flow_custom.rev, 'the row is not touched');
  assert.deepStrictEqual(k.custom, mine, 'the file in its kept place');
  const c = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c.body.order, mine);
  await clear(mine);
});

test('by hand over a shape ({ manual: true }): edited, nothing lit, the kept order stays; again stays edited; the shaped order by hand stays edited; each Undo puts back the row exactly; a stale Undo leaves the row', async () => {
  const mine = order();
  const smooth = mine.slice().reverse();
  const s = await post({ order: smooth, flow: { shape: 'smooth' } });
  // A drag (the move route, collection-reorder.js): shape -> edited.
  const d = await post({ move: [smooth[4]], before: smooth[0], flow: { manual: true } });
  assert.deepStrictEqual(strip(d.body.flow_custom), { mode: 'edited', shape: 'smooth', waves: 2, places: false, kept: mine, custom: mine, lit: false });
  assert.notStrictEqual(d.body.flow_custom.rev, s.body.flow_custom.rev);
  assert.deepStrictEqual(d.body.flow_custom_was, s.body.flow_custom);
  // Another drag, and dragged back to the smooth order by hand: edited -> edited, the row not touched.
  const d2 = await post({ move: [smooth[0]], before: null, flow: { manual: true } });
  assert.strictEqual(d2.body.flow_custom.mode, 'edited');
  assert.strictEqual(d2.body.flow_custom.rev, d.body.flow_custom.rev, 'already edited: the row is not touched');
  const back = await post({ order: smooth, flow: { manual: true } });
  assert.strictEqual(back.body.flow_custom.mode, 'edited');
  assert.strictEqual(back.body.flow_custom.rev, d.body.flow_custom.rev);
  assert.deepStrictEqual(back.body.flow_custom.kept, mine, 'the kept order is never touched by hand');
  // Undo of the edited-to-edited drag: no row change to send back.
  assert.strictEqual(back.body.flow_custom_was.rev, back.body.flow_custom.rev);
  // The first drag's Undo: the order and the row exactly (Smooth lit, mine kept).
  await post({ order: smooth, flow: undoOf(d.body) });
  assert.deepStrictEqual(order(), smooth);
  assert.deepStrictEqual(await kept(), s.body.flow_custom);
  // A stale Undo (the drag's again, after the row changed): the order goes back, the row is left as it is.
  const later = await post({ move: [smooth[0]], before: null, flow: { manual: true } });
  assert.strictEqual(later.status, 200);
  const now = await kept();
  assert.strictEqual(now.mode, 'edited');
  await post({ order: smooth, flow: undoOf(d.body) });
  assert.deepStrictEqual(order(), smooth);
  assert.deepStrictEqual(await kept(), now, 'the row the later drag left');
  await clear(mine);
});

test('the owner\'s case: own order A, Smooth, a nudge, Peak: the kept order is still A, and Custom brings A back after Undo is gone; each Undo exact', async () => {
  const A = order();
  const smooth = A.slice().reverse();
  const s = await post({ order: smooth, flow: { shape: 'smooth' } });
  const nudge = await post({ move: [smooth[2]], before: smooth[0], flow: { manual: true } });
  assert.strictEqual(nudge.body.flow_custom.mode, 'edited');
  const nudged = order();
  // edited + a shape: mode shape, the kept order untouched (A, not the nudged Smooth).
  const peak = [A[2], A[0], A[4], A[1], A[3]];
  const p = await post({ order: peak, flow: { shape: 'peak' } });
  assert.deepStrictEqual(strip(p.body.flow_custom), { mode: 'shape', shape: 'peak', waves: 2, places: false, kept: A, custom: A, lit: true });
  assert.deepStrictEqual(p.body.flow_custom_was, nudge.body.flow_custom);
  // Undo of that pick: the nudged order and the edited row exactly.
  await post({ order: nudged, flow: undoOf(p.body) });
  assert.deepStrictEqual(order(), nudged);
  assert.deepStrictEqual(await kept(), nudge.body.flow_custom);
  // Peak again, no Undo this time; Custom: A back.
  await post({ order: peak, flow: { shape: 'peak' } });
  const c = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c.body.order, A);
  assert.strictEqual(c.body.flow_custom.mode, 'custom');
  // A shape picked from Custom: the playlist order there now is kept (the one deliberate replacement).
  await post({ move: [A[0]], before: null, flow: { manual: true } });
  const own = order();
  assert.strictEqual((await kept()).mode, 'custom', 'a drag over Custom stays custom');
  const b = await post({ order: A, flow: { shape: 'build' } });
  assert.deepStrictEqual(b.body.flow_custom.kept, own);
  assert.strictEqual(b.body.flow_custom_was.mode, 'custom');
  assert.ok(s.status === 200);
  await clear(A);
});

test('edited + Custom: the kept order back (kept files in kept order, others after them, gone ones dropped), mode custom; its Undo puts back the edited row and the order', async () => {
  const mine = order();
  const smooth = mine.slice().reverse();
  await post({ order: smooth, flow: { shape: 'smooth' } });
  const d = await post({ move: [smooth[4]], before: smooth[0], flow: { manual: true } });
  const dragged = order();
  // A file taken out and a new one added while edited: the row is not touched, as for a shape.
  db.removeFromCollection(coll, [mine[1]]);
  db.addToCollection(coll, [m[5]]);
  const k = await kept();
  assert.strictEqual(k.rev, d.body.flow_custom.rev);
  assert.strictEqual(k.mode, 'edited');
  assert.strictEqual(k.lit, false);
  assert.deepStrictEqual(k.custom, [mine[0], ...mine.slice(2), m[5]]);
  const before = order();
  const c = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c.body.order, [mine[0], ...mine.slice(2), m[5]]);
  assert.strictEqual(c.body.flow_custom.mode, 'custom');
  assert.deepStrictEqual(c.body.flow_custom.kept, mine, 'the gone file keeps its kept slot');
  await post({ order: before, flow: undoOf(c.body) });
  assert.deepStrictEqual(order(), before);
  assert.deepStrictEqual(await kept(), k);
  // The file put back while edited: it goes back to its kept place when Custom is clicked.
  db.removeFromCollection(coll, [m[5]]);
  db.addToCollection(coll, [mine[1]]);
  const k2 = await kept();
  assert.strictEqual(k2.mode, 'edited');
  assert.deepStrictEqual(k2.custom, mine);
  const c2 = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c2.body.order, mine);
  assert.ok(dragged.length === 5);
  await clear(mine);
});

test('a saved order loaded ({ manual: true } with skips) over a shape: edited, the kept order stays; a shape then keeps it; its Undo puts back the order, the skips and the row', async () => {
  const mine = order();
  const peak = [mine[2], mine[0], mine[4], mine[1], mine[3]];
  const p = await post({ order: peak, flow: { shape: 'peak' } });
  const chip = await post({ order: mine.slice().reverse(), skips: [mine[0]], flow: { manual: true } });
  assert.deepStrictEqual(chip.body.skipped_ids, [mine[0]]);
  assert.strictEqual((await kept()).mode, 'edited');
  assert.deepStrictEqual((await kept()).kept, mine);
  // A shape after the chip: the kept order is still mine.
  const s = await post({ order: mine, flow: { shape: 'steady' } });
  assert.deepStrictEqual(s.body.flow_custom.kept, mine);
  await post({ order: mine.slice().reverse(), flow: undoOf(s.body) });
  assert.deepStrictEqual(await kept(), chip.body.flow_custom);
  await post({ order: peak, skips: chip.body.was_skipped_ids, flow: undoOf(chip.body) });
  assert.deepStrictEqual(order(), peak);
  assert.deepStrictEqual(db.getCollectionSkips(coll), []);
  assert.deepStrictEqual(await kept(), p.body.flow_custom);
  await clear(mine);
});

test('Custom over Custom by hand: a drag keeps Custom lit and the row untouched', async () => {
  const mine = order();
  const p = await post({ order: mine.slice().reverse(), flow: { shape: 'peak' } });
  const c = await post({ flow: { custom: true } });
  const d = await post({ move: [mine[0]], before: null, flow: { manual: true } });
  assert.strictEqual(d.body.flow_custom.mode, 'custom');
  assert.strictEqual(d.body.flow_custom.rev, c.body.flow_custom.rev);
  assert.ok(p.status === 200);
  await clear(mine);
});

test('restore takes mode edited; an unknown mode in a row reads as edited (nothing lit, the kept order safe from a shape pick and from drags)', async () => {
  const mine = order();
  const k = [mine[4], mine[3], mine[2], mine[1], mine[0]];
  const r = await post({ order: mine, flow: { restore: { mode: 'edited', shape: 'build', kept: k, rev: 11 }, rev: null } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual(strip(await kept()), { mode: 'edited', shape: 'build', waves: 2, places: false, kept: k, custom: k, lit: false });
  assert.strictEqual((await kept()).rev, 11);
  // A later Vault's mode.
  db.get().prepare("UPDATE flow_custom_orders SET mode = 'something-new' WHERE collection_id = ?").run(coll);
  const u = await kept();
  assert.strictEqual(u.mode, 'edited');
  assert.strictEqual(u.lit, false);
  await post({ move: [mine[0]], before: null, flow: { manual: true } });
  assert.deepStrictEqual((await kept()).kept, k);
  const p = await post({ order: mine.slice().reverse(), flow: { shape: 'peak' } });
  assert.deepStrictEqual(p.body.flow_custom.kept, k, 'a shape from an unknown mode keeps the kept order');
  assert.strictEqual(p.body.flow_custom.mode, 'shape');
  const c = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c.body.order, k);
  await clear(mine);
});

test('a row change bumps the library version (another window reads the collection again); a write that changes nothing in it does not add a bump of its own', async () => {
  const mine = order();
  const v = () => require('../lib/library-index').version(db.get());
  const v0 = v();
  await post({ order: mine, flow: { shape: 'peak' } });   // no file moves, the row is new
  const v1 = v();
  assert.ok(v1 > v0, 'a row put in moves the version');
  await post({ order: mine, flow: { shape: 'peak' } });   // the same shape again: nothing
  assert.strictEqual(v(), v1);
  await post({ order: mine, flow: { manual: true } });     // shape -> edited, no file moved
  const v2 = v();
  assert.ok(v2 > v1);
  // GET /api/collections/:id carries the row, for another window's panel.
  const g = await send('GET', `/api/collections/${coll}`);
  assert.strictEqual(g.body.flow_custom.mode, 'edited');
  assert.deepStrictEqual(g.body.media_ids, mine);
  await clear(mine);
  assert.ok(v() > v2, 'removing the row moves it too');
  assert.strictEqual((await send('GET', `/api/collections/${coll}`)).body.flow_custom, null);
});

test('every write that says nothing leaves the row alone (real routes): Remove and its Undo, Add, a plain order and skips from another client, an import', async () => {
  const mine = order();
  const peak = [mine[2], mine[0], mine[4], mine[1], mine[3]];
  const p = await post({ order: peak, flow: { shape: 'peak' } });
  const same = async (what) => {
    const k = await kept();
    assert.strictEqual(k.rev, p.body.flow_custom.rev, `${what}: the row is not touched`);
    assert.strictEqual(k.lit, true, `${what}: Peak stays lit`);
  };
  // Remove, then its Undo (collections.js undoRemoveFromCollection: add back, then the old order without flow).
  await send('DELETE', `/api/collections/${coll}/items`, { ids: [peak[1]] });
  await same('a file taken out');
  await send('POST', `/api/collections/${coll}/items`, { ids: [peak[1]] });
  await post({ order: peak });
  await same('Remove and its Undo');
  // A plain order and skips (another client, an older Vault's saved order).
  await post({ order: mine.slice().reverse(), skips: [mine[0]] });
  await same('a plain order with skips');
  await post({ order: peak, skips: [] });
  // Add a file (at the end), and take it out again.
  await send('POST', `/api/collections/${coll}/items`, { ids: [m[5]] });
  await same('a file added');
  assert.deepStrictEqual((await kept()).custom, [...mine, m[5]], 'Custom would put it at the end');
  await send('DELETE', `/api/collections/${coll}/items`, { ids: [m[5]] });
  // A playlist import into the collection (lib/playlist/import.js onRowsAdded, its statements word for word:
  // the file in at -1, then every position written), then its Undo (the file taken out).
  const d = db.get();
  d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)').run(coll, m[5], -1);
  const setPos = d.prepare('UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_id = ? AND position IS NOT ?');
  [...peak.slice(0, 2), m[5], ...peak.slice(2)].forEach((id, i) => setPos.run(i, coll, id, i));
  await same('an import placing a file mid-way');
  db.removeFromCollection(coll, [m[5]]);
  await same('the import undone');
  const c = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c.body.order, mine, 'Custom restores the kept order exactly');
  await clear(mine);
});

test('the kept order is the members at the pick; files gone are dropped and new ones go at the end when Custom brings it back', async () => {
  const mine = order();
  await post({ order: mine.slice().reverse(), flow: { shape: 'steady' } });
  db.removeFromCollection(coll, [mine[1]]);
  db.addToCollection(coll, [m[5]]);
  const k = await kept();
  assert.strictEqual(k.lit, true);
  assert.deepStrictEqual(k.custom, [mine[0], ...mine.slice(2), m[5]]);
  const c = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c.body.order, [mine[0], ...mine.slice(2), m[5]]);
  db.removeFromCollection(coll, [m[5]]);
  db.addToCollection(coll, [mine[1]]);
  await clear(mine);
});

test('tiny collections (1 and 2 files): a shape that changes no order still lights, with an Undo that removes the row; Custom changes nothing', async () => {
  for (const n of [1, 2]) {
    const c = db.createCollection(`Tiny ${n}`).id;
    db.addToCollection(c, m.slice(0, n));
    const o = order(c);
    const p = await post({ order: o, flow: { shape: 'peak' } }, c);
    assert.deepStrictEqual(p.body.order, o);
    assert.strictEqual(p.body.flow_custom.lit, true);
    const again = await post({ order: o, flow: { shape: 'peak' } }, c);
    assert.strictEqual(again.body.flow_custom.rev, p.body.flow_custom.rev, 'the same shape again: nothing');
    const cu = await post({ flow: { custom: true } }, c);
    assert.deepStrictEqual(cu.body.order, o);
    assert.strictEqual(cu.body.flow_custom.mode, 'custom');
    await post({ order: o, flow: undoOf(cu.body) }, c);
    await post({ order: o, flow: undoOf(p.body) }, c);
    assert.strictEqual(await kept(c), null);
    db.deleteCollection(c);
  }
});

test('flow never changes the skips; a bad flow is refused and nothing is written', async () => {
  const mine = order();
  db.replaceCollectionSkips(coll, [mine[2]]);
  const p = await post({ order: mine.slice().reverse(), flow: { shape: 'peak' } });
  assert.deepStrictEqual(db.getCollectionSkips(coll), [mine[2]]);
  await post({ flow: { custom: true } });
  await post({ order: mine.slice().reverse(), flow: undoOf(p.body) });
  assert.deepStrictEqual(db.getCollectionSkips(coll), [mine[2]]);
  await clear(mine);
  const good = { mode: 'shape', shape: 'peak', kept: mine, rev: 5 };
  for (const flow of [
    null, 'waves', [1], {}, { shape: 'zigzag' }, { shape: 'waves', waves: 9 }, { shape: 'peak', places: 'yes' },
    { shape: 'peak', custom: [1] }, { shape: 'peak', shaped: [1] }, { shape: 'peak', manual: true },
    { custom: false }, { custom: true, manual: true }, { manual: 1 },
    { restore: null }, { restore: null, rev: 0 }, { restore: null, rev: 'x' }, { restore: [1], rev: null },
    { restore: { ...good, mode: 'lit' }, rev: null }, { restore: { ...good, shape: 'zigzag' }, rev: null },
    { restore: { ...good, kept: [mine[0], mine[0]] }, rev: null }, { restore: { ...good, kept: [0] }, rev: null },
    { restore: { ...good, kept: 'x' }, rev: null }, { restore: { ...good, rev: undefined }, rev: null },
    { restore: { ...good, shaped: [1] }, rev: null }, { restore: good, rev: null, shape: 'peak' },
  ]) {
    const r = await post({ order: mine.slice().reverse(), flow });
    assert.strictEqual(r.status, 400, JSON.stringify(flow));
  }
  assert.deepStrictEqual(order(), mine);
  assert.strictEqual(await kept(), null);
  assert.strictEqual((await post({ order: [], flow: { shape: 'peak' } }, folder)).status, 400);
  assert.strictEqual((await post({ flow: { custom: true } }, folder)).status, 400);
  assert.strictEqual(rowCount(), 0);
  assert.strictEqual((await send('GET', '/api/flow/collections/abc/custom')).status, 400);
  db.replaceCollectionSkips(coll, []);
});

test('an Undo row with files not in the collection now keeps them (a file taken out keeps its place), but they are never written into the playlist', async () => {
  const mine = order();
  const k = [m[5], mine[3], 999999, mine[0], mine[1], mine[2], mine[4]];
  const r = await post({ order: mine, flow: { restore: { mode: 'shape', shape: 'peak', kept: k, rev: 7 }, rev: null } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await kept()).kept, k);
  assert.deepStrictEqual((await kept()).custom, [mine[3], mine[0], mine[1], mine[2], mine[4]]);
  const c = await post({ flow: { custom: true } });
  assert.deepStrictEqual(c.body.order, [mine[3], mine[0], mine[1], mine[2], mine[4]]);
  await clear(mine);
});

test('Duplicate copies what is kept (mode too); Delete removes it', async () => {
  const mine = order();
  const shaped = mine.slice().reverse();
  await post({ order: shaped, flow: { shape: 'waves', waves: 4, places: true } });
  const copy = db.duplicateCollection(coll).id;
  assert.deepStrictEqual(strip(await kept(copy)), strip(await kept(coll)));
  assert.strictEqual((await kept(copy)).lit, true);
  // Each on its own afterwards.
  await post({ flow: { custom: true } }, copy);
  assert.strictEqual((await kept(copy)).mode, 'custom');
  assert.strictEqual((await kept(coll)).mode, 'shape');
  const n = rowCount();
  db.deleteCollection(copy);
  assert.strictEqual(rowCount(), n - 1);
  await clear(mine);
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
      out.custom = require('./lib/flow/custom').state(d, c).custom;
      out.ids = ids;
      d.prepare('DELETE FROM collection_items WHERE collection_id = ?').run(c);
      d.prepare('DELETE FROM collections WHERE id = ?').run(c);
      out.orphan = d.prepare('SELECT COUNT(*) FROM flow_custom_orders WHERE collection_id = ?').pluck().get(c);
      db.close();`);
    assert.strictEqual(old.dupItems, 3, 'its duplicate copies the files');
    assert.strictEqual(old.lit, true, 'its reorder leaves the mode: the shape stays lit');
    assert.deepStrictEqual(old.custom, old.ids, 'and Custom still restores the kept order');
    assert.strictEqual(old.orphan, 1, 'its delete leaves the row');
    const out = run(`const db = require('./lib/database'); db.init();
      out.rows = db.get().prepare('SELECT COUNT(*) FROM flow_custom_orders').pluck().get();
      db.close();`);
    assert.strictEqual(out.rows, 0, 'the deleted collection\'s row is gone on the next start');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
});

test('a library with rows from before mode (e5d2750, 87131f8: no mode, no rev) opens: each row is a lit shape with a rev, and Custom restores its order', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-custom-premode-'));
  const run = child(work);
  try {
    run(`const db = require('./lib/database'); db.init();
      const d = db.get();
      const ins = d.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
      const ids = [1, 2, 3].map(i => Number(ins.run('/' + i + '.mp4', i + '.mp4').lastInsertRowid));
      const c = db.createCollection('Before mode').id; db.addToCollection(c, ids);
      // The table as those commits made it, and a row as they wrote it (a dormant one: shaped is not the playlist).
      d.exec('DROP TABLE flow_custom_orders');
      d.exec('CREATE TABLE flow_custom_orders (collection_id INTEGER PRIMARY KEY, order_json TEXT NOT NULL, shape TEXT NOT NULL, waves INTEGER, places INTEGER NOT NULL DEFAULT 0, shaped_json TEXT NOT NULL, updated_at INTEGER)');
      d.prepare('INSERT INTO flow_custom_orders VALUES (?, ?, ?, ?, ?, ?, ?)').run(c, JSON.stringify([ids[2], ids[0], ids[1]]), 'peak', 2, 0, JSON.stringify([ids[1], ids[2], ids[0]]), 1);
      db.close();`);
    const out = run(`const db = require('./lib/database'); db.init();
      const c = db.getCollections().find(x => x.name === 'Before mode').id;
      out.cols = db.get().prepare('PRAGMA table_info(flow_custom_orders)').all().map(x => x.name);
      out.state = require('./lib/flow/custom').state(db.get(), c);
      out.order = db.reorderCollectionFull(c, {}, { flow: require('./lib/flow/custom').cleanFlow({ custom: true }) }).order;
      out.names = out.order.map(id => db.get().prepare('SELECT filename FROM media WHERE id = ?').pluck().get(id));
      db.close();`);
    assert.deepStrictEqual(out.cols.slice(-2), ['mode', 'rev']);
    assert.strictEqual(out.state.mode, 'shape');
    assert.strictEqual(out.state.lit, true);
    assert.strictEqual(out.state.shape, 'peak');
    assert.ok(Number.isSafeInteger(out.state.rev) && out.state.rev > 0, 'a rev to Undo against');
    assert.deepStrictEqual(out.names, ['3.mp4', '1.mp4', '2.mp4']);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
});
