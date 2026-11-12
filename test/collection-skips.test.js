/**
 * Skip on tracks, server side: collection_items.skipped (lib/database.js),
 * its migration and what an older Vault still does with the library, the
 * routes (POST / PUT /api/collections/:id/skips, GET /api/collections/:id),
 * the length fields the count line reads, Duplicate, export leaving skipped
 * files out, the lock gate, and an encrypted library (child processes).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-coll-skips-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_STAGE_NO_MPV = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const { app } = require('../server/index');

let server, base, coll, folder;
const m = [];

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds) VALUES (?, ?, ?, ?)');
  // f0..f4: 60, 120, 180, 240, 300 s videos; f5 a picture.
  for (let i = 0; i < 5; i++) m.push(Number(ins.run(path.join(tmp, `f${i}.mp4`), `f${i}.mp4`, 'video', (i + 1) * 60).lastInsertRowid));
  m.push(Number(ins.run(path.join(tmp, 'p.jpg'), 'p.jpg', 'image', null).lastInsertRowid));
  coll = db.createCollection('Friday').id;
  db.addToCollection(coll, m);
  folder = db.createCollection('A folder', { kind: 'folder' }).id;
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  vault._locked = false;
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const send = (method, p, body) => fetch(base + p, {
  method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('the migration adds collection_items.skipped, 0 for every file already there', () => {
  const cols = db.get().prepare('PRAGMA table_info(collection_items)').all();
  const col = cols.find(c => c.name === 'skipped');
  assert.ok(col, 'the column is there');
  assert.strictEqual(col.notnull, 1);
  assert.strictEqual(String(col.dflt_value), '0');
  assert.deepStrictEqual(db.getCollectionSkips(coll), []);
});

test('skip and unskip: the order is kept, non-members are left alone, a folder is refused', () => {
  const order = db.getCollectionItems(coll);
  assert.deepStrictEqual(db.setCollectionSkips(coll, [m[3], m[1], 999999], true), [m[1], m[3]], 'in playlist order');
  assert.deepStrictEqual(db.getCollectionItems(coll), order, 'nothing moved, nothing left');
  assert.deepStrictEqual(db.setCollectionSkips(coll, [m[1]], false), [m[3]]);
  assert.strictEqual(code(() => db.setCollectionSkips(folder, [m[0]], true)), 'FOLDER_TARGET');
  assert.strictEqual(code(() => db.setCollectionSkips(424242, [m[0]], true)), 'NOT_FOUND');
  const r = db.replaceCollectionSkips(coll, [m[0], m[2]]);
  assert.deepStrictEqual(r, { skipped: [m[0], m[2]], was: [m[3]] });
  assert.deepStrictEqual(db.replaceCollectionSkips(coll, []).skipped, []);
});

test('a skip stays with its file through a reorder, and leaves with it', () => {
  db.setCollectionSkips(coll, [m[4]], true);
  db.reorderCollection(coll, { move: [m[4]], before: m[0] });
  assert.deepStrictEqual(db.getCollectionItems(coll)[0], m[4]);
  assert.deepStrictEqual(db.getCollectionSkips(coll), [m[4]]);
  db.reorderCollection(coll, { move: [m[4]], before: null });
  db.removeFromCollection(coll, [m[4]]);
  assert.deepStrictEqual(db.getCollectionSkips(coll), []);
  db.addToCollection(coll, [m[4]]);
  assert.deepStrictEqual(db.getCollectionSkips(coll), [], 'added again: not skipped');
});

test('the length fields: what the skips take off, timed and not', () => {
  db.replaceCollectionSkips(coll, [m[1], m[5]]);   // 120 s video and the picture
  const len = db.collectionLength(coll);
  assert.strictEqual(len.total_seconds, 900, 'the whole collection, skipped files too');
  assert.strictEqual(len.skipped_count, 2);
  assert.strictEqual(len.skipped_timed_count, 1);
  assert.strictEqual(len.skipped_seconds, 120);
  assert.strictEqual(len.skipped_unknown_count, 0);
  assert.strictEqual(db.collectionLength(folder).skipped_count, 0, 'a folder has none');
  const listed = db.getCollections().find(c => c.id === coll);
  assert.strictEqual(listed.skipped_seconds, 120, 'GET /api/collections carries them too');
  db.replaceCollectionSkips(coll, []);
});

test('Duplicate copies the skips; the original keeps its own', () => {
  db.replaceCollectionSkips(coll, [m[2]]);
  const copy = db.duplicateCollection(coll).id;
  assert.deepStrictEqual(db.getCollectionSkips(copy), [m[2]]);
  db.setCollectionSkips(copy, [m[2]], false);
  assert.deepStrictEqual(db.getCollectionSkips(coll), [m[2]], 'per collection');
  db.deleteCollection(copy);
  db.replaceCollectionSkips(coll, []);
});

test('what an older Vault does with the library still works (it never names the column)', () => {
  const d = db.get();
  const c = db.createCollection('Old code').id;
  // 3.10's own statements, word for word (lib/database.js, lib/playlist/import.js).
  d.prepare('INSERT OR IGNORE INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)').run(c, m[0], 0);
  d.prepare('INSERT INTO collection_items (collection_id, media_id, position) VALUES (?, ?, ?)').run(c, m[1], -1);
  d.prepare('UPDATE collection_items SET position = ? WHERE collection_id = ? AND media_id = ? AND position IS NOT ?').run(1, c, m[1], 1);
  const dup = d.prepare('INSERT INTO collections (name, kind) VALUES (?, ?)').run('Old dup', 'collection').lastInsertRowid;
  d.prepare('INSERT INTO collection_items (collection_id, media_id, position, added_at) SELECT ?, media_id, position, added_at FROM collection_items WHERE collection_id = ?').run(dup, c);
  assert.deepStrictEqual(d.prepare('SELECT media_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at').pluck().all(c), [m[0], m[1]]);
  assert.deepStrictEqual(db.getCollectionSkips(c), [], 'rows an older Vault adds are not skipped');
  assert.deepStrictEqual(db.getCollectionSkips(Number(dup)), []);
  d.prepare('DELETE FROM collection_items WHERE collection_id = ? AND media_id = ?').run(c, m[0]);
  db.deleteCollection(c);
  db.deleteCollection(Number(dup));
});

test('a library from before Skip (no column) is migrated on open, its order untouched', () => {
  const cp2 = require('node:child_process');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-skips-old-'));
  const env = { ...process.env, VAULT_DB: path.join(work, 'library.db'), VAULT_SETTINGS_FILE: path.join(work, 'settings.json') };
  try {
    const run = (body) => {
      const r = cp2.spawnSync(process.execPath, ['-e', `const out = {}; ${body}; console.log('@@' + JSON.stringify(out));`],
        { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 120000 });
      const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('@@'));
      assert.ok(line, `child produced no result: ${r.stderr}`);
      return JSON.parse(line.slice(2));
    };
    // A library as 3.10 left it: the table without the column.
    run(`const db = require('./lib/database'); db.init();
      const d = db.get();
      const ins = d.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
      const a = ins.run('/a.mp4', 'a.mp4').lastInsertRowid, b = ins.run('/b.mp4', 'b.mp4').lastInsertRowid;
      const c = db.createCollection('Kept').id; db.addToCollection(c, [Number(b), Number(a)]);
      d.exec('ALTER TABLE collection_items DROP COLUMN skipped');
      out.cols = d.prepare('PRAGMA table_info(collection_items)').all().map(x => x.name);
      db.close();`);
    const out = run(`const db = require('./lib/database'); db.init();
      const c = db.getCollections().find(x => x.name === 'Kept').id;
      out.cols = db.get().prepare('PRAGMA table_info(collection_items)').all().map(x => x.name);
      out.names = db.getCollectionItems(c).map(id => db.get().prepare('SELECT filename FROM media WHERE id = ?').pluck().get(id));
      out.skips = db.getCollectionSkips(c);
      db.close();`);
    assert.ok(out.cols.includes('skipped'));
    assert.deepStrictEqual(out.names, ['b.mp4', 'a.mp4']);
    assert.deepStrictEqual(out.skips, []);
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
});

test('routes: skip, unskip, replace (Unskip all and its Undo), and GET carries them', async () => {
  let r = await send('POST', `/api/collections/${coll}/skips`, { ids: [m[0], m[3]], skip: true });
  assert.strictEqual(r.status, 200);
  let body = await r.json();
  assert.deepStrictEqual(body.skipped_ids, [m[0], m[3]]);
  assert.strictEqual(body.skipped_seconds, 60 + 240);
  assert.strictEqual(body.total_seconds, 900);
  body = await (await send('GET', `/api/collections/${coll}`)).json();
  assert.deepStrictEqual(body.skipped_ids, [m[0], m[3]]);
  r = await send('PUT', `/api/collections/${coll}/skips`, { ids: [] });
  body = await r.json();
  assert.deepStrictEqual([body.skipped_ids, body.was_ids], [[], [m[0], m[3]]]);
  // Undo puts them back.
  body = await (await send('POST', `/api/collections/${coll}/skips`, { ids: body.was_ids, skip: true })).json();
  assert.deepStrictEqual(body.skipped_ids, [m[0], m[3]]);
  body = await (await send('POST', `/api/collections/${coll}/skips`, { ids: [m[0]], skip: false })).json();
  assert.deepStrictEqual(body.skipped_ids, [m[3]]);
  // A folder's answer has none.
  assert.deepStrictEqual((await (await send('GET', `/api/collections/${folder}`)).json()).skipped_ids, []);
  await send('PUT', `/api/collections/${coll}/skips`, { ids: [] });
});

test('POST .../order with skips: the order and exactly those skips in one go (a saved order loaded), and its Undo', async () => {
  const before = db.getCollectionItems(coll);
  db.replaceCollectionSkips(coll, [m[1]]);
  const want = before.slice().reverse();
  let r = await send('POST', `/api/collections/${coll}/order`, { order: want, skips: [m[0], m[2], 999999] });
  assert.strictEqual(r.status, 200);
  let body = await r.json();
  assert.deepStrictEqual(body.order, want);
  assert.deepStrictEqual(body.skipped_ids, [m[2], m[0]].filter(id => want.includes(id)).sort((a, b) => want.indexOf(a) - want.indexOf(b)), 'in the new order, non-members left out');
  assert.deepStrictEqual(body.was_skipped_ids, [m[1]]);
  assert.strictEqual(body.skipped_seconds, 60 + 180, 'the length fields count the new skips');
  assert.deepStrictEqual(db.getCollectionItems(coll), want);
  // Undo: the order and the skips from before.
  body = await (await send('POST', `/api/collections/${coll}/order`, { order: before, skips: body.was_skipped_ids })).json();
  assert.deepStrictEqual([db.getCollectionItems(coll), db.getCollectionSkips(coll)], [before, [m[1]]]);
  // Without skips the answer is as it was (the skips untouched, not in it).
  body = await (await send('POST', `/api/collections/${coll}/order`, { order: before })).json();
  assert.strictEqual(body.skipped_ids, undefined);
  assert.deepStrictEqual(db.getCollectionSkips(coll), [m[1]]);
  // A bad order changes neither (one transaction); bad skips are refused.
  r = await send('POST', `/api/collections/${coll}/order`, { order: want.slice(1), skips: [] });
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual([db.getCollectionItems(coll), db.getCollectionSkips(coll)], [before, [m[1]]]);
  assert.strictEqual((await send('POST', `/api/collections/${coll}/order`, { order: want, skips: 'x' })).status, 400);
  assert.strictEqual((await send('POST', `/api/collections/${folder}/order`, { order: [], skips: [] })).status, 400);
  assert.deepStrictEqual(db.getCollectionItems(coll), before);
  db.replaceCollectionSkips(coll, []);
});

test('routes refuse what is not right', async () => {
  const bad = [
    ['POST', coll, { ids: [m[0]] }, 400],                 // no skip
    ['POST', coll, { ids: [m[0]], skip: 'yes' }, 400],
    ['POST', coll, { ids: [], skip: true }, 400],
    ['POST', coll, { ids: ['1'], skip: true }, 400],
    ['POST', coll, { ids: [-1], skip: true }, 400],
    ['PUT', coll, {}, 400],
    ['PUT', coll, { ids: 'x' }, 400],
    ['POST', folder, { ids: [m[0]], skip: true }, 400],
    ['PUT', folder, { ids: [] }, 400],
    ['POST', 987654, { ids: [m[0]], skip: true }, 404],
  ];
  for (const [method, id, body, status] of bad) {
    const r = await send(method, `/api/collections/${id}/skips`, body);
    assert.strictEqual(r.status, status, `${method} ${id} ${JSON.stringify(body)}`);
  }
  assert.strictEqual((await send('POST', '/api/collections/abc/skips', { ids: [m[0]], skip: true })).status, 400);
});

test('the routes are 423 while the vault is locked', async () => {
  vault.bootLocked();
  try {
    assert.strictEqual((await send('POST', `/api/collections/${coll}/skips`, { ids: [m[0]], skip: true })).status, 423);
    assert.strictEqual((await send('PUT', `/api/collections/${coll}/skips`, { ids: [] })).status, 423);
  } finally {
    vault._locked = false;
  }
  assert.deepStrictEqual(db.getCollectionSkips(coll), [], 'nothing changed while locked');
});

test('export leaves skipped files out and counts them apart', async () => {
  db.replaceCollectionSkips(coll, [m[1]]);
  const r = await send('GET', `/api/collections/${coll}/export?links=vault`);
  assert.strictEqual(r.status, 200);
  const text = await r.text();
  assert.ok(!text.includes(`/media/${m[1]}\r\n`) && !text.includes(`/media/${m[1]}\n`), 'the skipped file is not in it');
  assert.ok(text.includes(`/media/${m[0]}`), 'the others are');
  assert.strictEqual(r.headers.get('x-vault-skipped-by-you'), '1');
  assert.strictEqual(r.headers.get('x-vault-skipped'), '0');
  const built = require('../lib/playlist/export').buildExport(coll, { links: 'vault', baseUrl: 'http://127.0.0.1:1' });
  assert.strictEqual(built.skippedByYou, 1);
  assert.strictEqual(built.count, m.length - 1);
  db.replaceCollectionSkips(coll, []);
});

// An encrypted library keeps its skips encrypted with everything else, and a
// library encrypted before Skip existed is migrated with its key.
let Cipher = null;
try { Cipher = require('better-sqlite3-multiple-ciphers'); } catch { /* skipped below */ }
test('encrypted library: migrated with the key, skips saved and read back (child processes)', {
  skip: Cipher ? false : 'better-sqlite3-multiple-ciphers is not installed',
}, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-skips-enc-'));
  const PASS = 'skip-test-pass';
  const env = { ...process.env, VAULT_OFFLINE: '1',
    VAULT_DB: path.join(work, 'library.db'), VAULT_SETTINGS_FILE: path.join(work, 'settings.json'),
    VAULT_THUMBS: path.join(work, 'thumbs'), VAULT_SECURE_ASSETS: path.join(work, 'secure.db'),
    VAULT_TRASH: path.join(work, 'trash'), VAULT_SUBS: path.join(work, 'subs') };
  for (const k of ['VAULT_DB_PASSWORD', 'VIDEO_TAGGER_DB_PASSWORD', 'MEDIA_TAGGER_DB_PASSWORD']) delete env[k];
  const child = (code) => new Promise((resolve) => {
    cp.execFile(process.execPath, ['-e', `(async () => { const out = {}; ${code}; console.log('@@' + JSON.stringify(out)); process.exit(0); })()
      .catch((e) => { console.log('@@' + JSON.stringify({ error: e.message })); process.exit(1); });`], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 120000,
    }, (err, stdout, stderr) => {
      const line = (stdout || '').split(/\r?\n/).find((l) => l.startsWith('@@'));
      resolve(line ? JSON.parse(line.slice(2)) : { error: `no result: ${stderr}` });
    });
  });
  try {
    // An encrypted library as 3.10 left it (no column).
    const a = await child(`const db = require('./lib/database'); const vault = require('./lib/vault');
      db.init();
      const ins = db.get().prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
      const ids = [1, 2, 3].map(i => Number(ins.run('/e' + i + '.mp4', 'e' + i + '.mp4').lastInsertRowid));
      const c = db.createCollection('Enc').id; db.addToCollection(c, ids);
      await vault.setPassword(${JSON.stringify(PASS)});
      out.encrypted = vault.isEncrypted();
      db.get().exec('ALTER TABLE collection_items DROP COLUMN skipped');
      out.ids = ids; out.c = c;
      await vault.lock({ force: true });`);
    assert.strictEqual(a.error, undefined, a.error);
    assert.strictEqual(a.encrypted, true);
    const b = await child(`const db = require('./lib/database');
      db.init(process.env.VAULT_DB, ${JSON.stringify(PASS)});
      out.cols = db.get().prepare('PRAGMA table_info(collection_items)').all().map(x => x.name);
      out.skips = db.setCollectionSkips(${a.c}, [${a.ids[1]}], true);
      db.close();
      db.init(process.env.VAULT_DB, ${JSON.stringify(PASS)});
      out.again = db.getCollectionSkips(${a.c});
      out.order = db.getCollectionItems(${a.c});
      db.close();
      try { db.init(process.env.VAULT_DB, null); out.plain = 'opened'; } catch (e) { out.plain = e.code; }`);
    assert.strictEqual(b.error, undefined, b.error);
    assert.ok(b.cols.includes('skipped'));
    assert.deepStrictEqual(b.skips, [a.ids[1]]);
    assert.deepStrictEqual(b.again, [a.ids[1]], 'kept across a reopen with the key');
    assert.deepStrictEqual(b.order, a.ids);
    assert.strictEqual(b.plain, 'DB_ENCRYPTED', 'still encrypted: no key, no skips');
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
});
