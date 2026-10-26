/**
 * Import playlist (PLAYLISTS_SPEC, build step 3): the matcher
 * (lib/playlist/import.js) step by step, its indexed batch lookups, the
 * review groups, Find in folder, commit to a new or an existing collection,
 * duplicates, Undo, the files from "Add and scan" landing at their playlist
 * position as their rows are made, and the routes over HTTP with the pickers
 * and the drop resolver faked (server._setPlaylistDialogsForTest).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-pl-import-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
process.env.VAULT_DISABLE_NATIVE_PICKER = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const importAdd = require('../lib/import-add');
const pi = require('../lib/playlist/import');
const server = require('../server/index');

const WIN = process.platform === 'win32';
const onWindows = WIN ? false : 'Windows paths';

// Files on disk (the temp folder), and paths that only exist as rows.
const disk = path.join(tmp, 'Media');
const lists = path.join(tmp, 'Lists');
const write = (p, bytes = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes); return p; };
let srv, base;
const ids = {};

function insert(filepath, extra = {}) {
  const r = db.get().prepare(`INSERT INTO media (filepath, filename, media_type, filesize_bytes, user_trashed, trashed_original_path, missing_since)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(filepath, extra.filename || path.win32.basename(filepath), extra.type || 'video',
    extra.size ?? null, extra.trashed ? 1 : 0, extra.original || null, extra.missing || null);
  return Number(r.lastInsertRowid);
}
const memberOrder = (cid) => db.getCollectionItems(cid);

test.before(async () => {
  db.init();
  ids.alpha = insert('C:\\PlTest\\Lib\\alpha.mp4');
  ids.beta = insert('C:\\PlTest\\Lib\\Beta Clip.mkv');
  ids.delta = insert('C:\\PlTest\\Lib\\delta.mp4');
  ids.gamma = insert('C:\\PlTest\\Lib\\gamma.mp4');
  ids.fwd = insert('C:/PlTest/Lib/fwd.mp4');
  ids.offline = insert('C:\\PlTest\\Lib\\offline.mp4', { missing: Date.now() });
  ids.trashed = insert('C:\\Trash\\99.mp4', { trashed: true, original: 'C:\\PlTest\\Lib\\old.mp4' });
  // On disk and in the library, recorded with its true case (É)
  ids.ete = insert(write(path.join(disk, 'Été.mp4')));
  ids.rel = insert(write(path.join(disk, 'rel.mp4')));
  write(path.join(disk, 'new one.mp4'), 'abc');
  write(path.join(disk, 'new two.mp4'), 'abcd');
  write(path.join(disk, 'data.xyz'));
  await new Promise((resolve) => { srv = server.app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  server._setPlaylistDialogsForTest(null);
  await new Promise((resolve) => srv.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const entry = (index, p) => ({ index, raw: p, path: p, url: null, title: null });

// ── Paths ──────────────────────────────────────────────────────────────────

test('normalised paths: slashes, \\\\?\\, "..", drive letter', { skip: onWindows }, () => {
  const N = pi.normalizePath;
  assert.strictEqual(N('c:/Media//x.mp4'), 'C:\\Media\\x.mp4');
  assert.strictEqual(N('\\\\?\\C:\\a\\..\\b.mp4'), 'C:\\b.mp4');
  assert.strictEqual(N('\\\\?\\UNC\\srv\\share\\x.mp4'), '\\\\srv\\share\\x.mp4');
  assert.strictEqual(N('//srv/share/x.mp4'), '\\\\srv\\share\\x.mp4');
  assert.strictEqual(N('\\\\?\\Volume{abc}\\x.mp4'), null);
  assert.strictEqual(N('relative\\x.mp4'), null);
  assert.strictEqual(N('C:\\Media\\'), 'C:\\Media');
  assert.strictEqual(pi.pathKey('C:\\été'), pi.pathKey('c:\\ÉTÉ'));
});

// ── Matching, step by step ─────────────────────────────────────────────────

test('matcher: exact, normalised (case, slashes, \\\\?\\, NTFS fold), relative, disk, missing, trashed, offline', { skip: onWindows }, async () => {
  const entries = [
    'C:\\PlTest\\Lib\\alpha.mp4',                        // 1 exact
    'c:/pltest/lib/BETA CLIP.MKV',                       // 2 case + slashes
    '\\\\?\\C:\\PlTest\\Lib\\sub\\..\\delta.mp4',        // 2 \\?\ and ..
    'C:\\PlTest\\Lib\\fwd.mp4',                          // 2 the row has forward slashes
    path.join(disk, 'été.mp4'),                          // 2 é/É: the file's true spelling names the row
    '..\\Media\\rel.mp4',                                // 3 relative to the playlist folder
    path.join(disk, 'new one.mp4'),                      // 4 on disk, not in the library
    'C:\\PlTest\\Nope\\gone.mp4',                        // 5 not found
    'C:\\PlTest\\Lib\\old.mp4',                          // trashed by Vault (moved to its trash)
    'C:\\PlTest\\Lib\\offline.mp4',                      // in the library, file offline
    path.join(disk, 'data.xyz'),                        // on disk, not a kind Vault adds
  ].map((p, i) => entry(i, p));
  entries.push({ index: entries.length, raw: 'https://x.example/a.mp4', path: null, url: 'https://x.example/a.mp4', title: null });
  const r = await pi.matchEntries(entries, { playlistDir: lists });
  const got = r.map((x) => [x.kind, x.how || null, x.mediaId || null]);
  assert.deepStrictEqual(got, [
    ['library', 'exact', ids.alpha],
    ['library', 'normalised', ids.beta],
    ['library', 'normalised', ids.delta],
    ['library', 'normalised', ids.fwd],
    ['library', 'normalised', ids.ete],
    ['library', 'relative', ids.rel],
    ['disk', 'normalised', null],
    ['missing', null, null],
    ['trashed', 'normalised', ids.trashed],
    ['library', 'exact', ids.offline],
    ['unsupported', null, null],
    ['skipped', null, null],
  ]);
  assert.strictEqual(r[6].diskPath, path.join(disk, 'new one.mp4'));
  assert.strictEqual(r[6].size, 3);
  assert.strictEqual(r[9].offline, true);
  assert.strictEqual(r[11].reason, 'web');
});

test('matcher: lookups are batched on the path indexes, never one query per entry', { skip: onWindows }, async () => {
  const conn = db.get();
  const plan = (sql, ...a) => conn.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a).map((r) => r.detail).join(' | ');
  assert.match(plan('SELECT id FROM media WHERE filepath IN (?,?)', 'a', 'b'), /USING (COVERING )?INDEX (idx_media_filepath|sqlite_autoindex_media_1) /);
  assert.match(plan('SELECT id, filename FROM media WHERE filepath COLLATE NOCASE IN (?,?)', 'a', 'b'), /USING INDEX idx_media_filepath_nocase/);
  assert.match(plan("SELECT id, filename FROM media WHERE media_type IN ('video','image') AND filesize_bytes IN (?,?)", 1, 2),
    /USING (COVERING )?INDEX idx_media_type_size/);

  // 1000 entries that are all in the library exactly: ceil(1000 / 400) queries.
  const many = [];
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
  conn.transaction(() => { for (let i = 0; i < 1000; i++) { const p = `C:\\Bulk\\${i}.mp4`; ins.run(p, `${i}.mp4`); many.push(entry(i, p)); } })();
  let before = pi._queryCount();
  let r = await pi.matchEntries(many, { playlistDir: lists });
  assert.ok(r.every((x) => x.kind === 'library' && x.how === 'exact'));
  assert.strictEqual(pi._queryCount() - before, 3);
  // The same 1000 in another case: one exact pass, one exact pass of the
  // normalised spellings, one NOCASE pass (each 3 batches of 400 or less,
  // the normalised one twice as many spellings).
  before = pi._queryCount();
  r = await pi.matchEntries(many.map((e) => entry(e.index, e.path.toLowerCase())), { playlistDir: lists });
  assert.ok(r.every((x) => x.kind === 'library' && x.how === 'normalised'));
  assert.ok(pi._queryCount() - before <= 3 + 5 + 5, `queries: ${pi._queryCount() - before}`);
  conn.prepare("DELETE FROM media WHERE filepath LIKE 'C:\\Bulk\\%'").run();
});

// ── Sessions: review, commit, Undo ─────────────────────────────────────────

function writeList(name, lines) {
  return write(path.join(lists, name), Buffer.from(['#EXTM3U', ...lines].join('\r\n') + '\r\n', 'utf8'));
}

test('review groups, duplicates kept once (first wins), commit to a new collection in playlist order, Undo', { skip: onWindows }, async () => {
  const file = writeList('Trip.m3u8', [
    '#PLAYLIST:Road trip',
    'C:\\PlTest\\Lib\\gamma.mp4',
    'C:\\PlTest\\Lib\\alpha.mp4',
    'c:\\pltest\\lib\\GAMMA.mp4',                 // the same file again
    path.join(disk, 'new one.mp4'),
    'C:\\PlTest\\Nope\\gone.mp4',
    'C:\\PlTest\\Lib\\old.mp4',
    'http://radio.example/live',
  ]);
  const rv = await pi.openPlaylist(file);
  assert.strictEqual(rv.name, 'Road trip');
  assert.deepStrictEqual(rv.library.map((x) => x.id), [ids.gamma, ids.alpha]);
  assert.strictEqual(rv.duplicates, 1);
  assert.deepStrictEqual(rv.disk.map((x) => x.name), ['new one.mp4']);
  assert.deepStrictEqual(rv.missing.map((x) => x.raw), ['C:\\PlTest\\Nope\\gone.mp4']);
  assert.deepStrictEqual(rv.trashed.map((x) => x.raw), ['C:\\PlTest\\Lib\\old.mp4']);
  assert.deepStrictEqual(rv.skipped.map((x) => x.reason), ['web']);

  const out = await pi.commit(rv.session, { target: 'new', name: 'Road trip' });
  assert.strictEqual(out.created, true);
  assert.strictEqual(out.added, 2);
  assert.strictEqual(out.duplicates, 1);
  assert.strictEqual(out.pending, 0, 'nothing waits unless Add and scan was chosen');
  assert.deepStrictEqual(memberOrder(out.collectionId), [ids.gamma, ids.alpha]);
  assert.throws(() => pi.review(rv.session), { code: 'NOT_FOUND' }, 'the session ends with the import');

  const u = pi.undo(out.importId);
  assert.deepStrictEqual(u, { removed: 2, deleted: true });
  assert.strictEqual(db.get().prepare('SELECT 1 FROM collections WHERE id = ?').get(out.collectionId), undefined);
  assert.ok(db.getById(ids.gamma), 'library rows stay');
  assert.throws(() => pi.undo(out.importId), { code: 'NOT_FOUND' });
});

test('add to an existing collection: appended after its items, files already there stay put; Undo takes out only what it added', { skip: onWindows }, async () => {
  const c = db.createCollection('Existing');
  db.addToCollection(c.id, [ids.delta, ids.alpha]);
  const file = writeList('More.m3u8', ['C:\\PlTest\\Lib\\gamma.mp4', 'C:\\PlTest\\Lib\\alpha.mp4', 'C:\\PlTest\\Lib\\Beta Clip.mkv']);
  const rv = await pi.openPlaylist(file);
  const out = await pi.commit(rv.session, { target: 'existing', collectionId: c.id });
  assert.deepStrictEqual({ added: out.added, alreadyThere: out.alreadyThere, created: out.created }, { added: 2, alreadyThere: 1, created: false });
  assert.deepStrictEqual(memberOrder(c.id), [ids.delta, ids.alpha, ids.gamma, ids.beta]);
  assert.deepStrictEqual(pi.undo(out.importId), { removed: 2, deleted: false });
  assert.deepStrictEqual(memberOrder(c.id), [ids.delta, ids.alpha]);

  const folder = db.createCollection('A folder', { kind: 'folder' });
  const rv2 = await pi.openPlaylist(file);
  await assert.rejects(pi.commit(rv2.session, { target: 'existing', collectionId: folder.id }), { code: 'BAD_TARGET' });
  await assert.rejects(pi.commit(rv2.session, { target: 'new', name: 'Existing' }), { code: 'NAME_TAKEN' });
  await assert.rejects(pi.commit(rv2.session, { target: 'new', name: '  ' }), { code: 'BAD_TARGET' });
  pi.close(rv2.session);
});

test('insert position: before the first later file of the import, else after its last earlier one, else at the end', () => {
  const tags = new Map([[10, 0], [12, 2], [14, 4]]);
  assert.strictEqual(pi.insertAt([10, 12, 14], tags, 1), 1);
  assert.strictEqual(pi.insertAt([10, 12, 14], tags, 3), 2);
  assert.strictEqual(pi.insertAt([10, 12, 14], tags, 9), 3);
  // The user moved 14 to the front: a file between 2 and 4 goes before it.
  assert.strictEqual(pi.insertAt([14, 10, 12], tags, 3), 0);
  // Other files (not from the import) are passed over: before 12, the first later one.
  assert.strictEqual(pi.insertAt([7, 8, 10, 9, 12], tags, 1), 4);
  assert.strictEqual(pi.insertAt([7, 8], new Map(), 1), 2);
});

test('Add and scan: files land at their playlist position as add-paths makes their rows, in any order', { skip: onWindows }, async () => {
  const one = path.join(disk, 'new one.mp4');
  const two = path.join(disk, 'new two.mp4');
  const file = writeList('Mixed.m3u8', ['C:\\PlTest\\Lib\\alpha.mp4', one, 'C:\\PlTest\\Lib\\gamma.mp4', two.toUpperCase()]);
  const rv = await pi.openPlaylist(file);
  assert.deepStrictEqual(rv.disk.map((d) => d.index), [1, 3]);
  const out = await pi.commit(rv.session, { target: 'new', name: 'Mixed', addAndScan: true });
  assert.strictEqual(out.pending, 2);
  assert.deepStrictEqual(out.disk.map((d) => d.path), [one, two], 'the true spelling of a case variant goes to Add');
  assert.deepStrictEqual(memberOrder(out.collectionId), [ids.alpha, ids.gamma]);

  // The fourth entry's row first, then the second's (the Add window does them in batches).
  const a2 = importAdd.addPaths([two], { analyse: false });
  assert.strictEqual(a2.added.length, 1);
  assert.deepStrictEqual(memberOrder(out.collectionId), [ids.alpha, ids.gamma, a2.added[0].id]);
  const a1 = importAdd.addPaths([one], { analyse: false });
  assert.deepStrictEqual(memberOrder(out.collectionId), [ids.alpha, a1.added[0].id, ids.gamma, a2.added[0].id]);
  const pos = db.get().prepare('SELECT position FROM collection_items WHERE collection_id = ? ORDER BY position').pluck().all(out.collectionId);
  assert.deepStrictEqual(pos, [0, 1, 2, 3], 'positions rewritten 0..n-1');
  assert.strictEqual(pi._imports.get(out.importId).pending.size, 0);

  // Undo takes those out too (the collection goes); the rows stay.
  assert.deepStrictEqual(pi.undo(out.importId), { removed: 4, deleted: true });
  assert.ok(db.getById(a1.added[0].id));
  db.get().prepare('DELETE FROM media WHERE id IN (?, ?)').run(a1.added[0].id, a2.added[0].id);
});

test('Add and scan into an existing collection, and a deleted collection stops waiting', { skip: onWindows }, async () => {
  const one = path.join(disk, 'new one.mp4');
  const c = db.createCollection('Has items');
  db.addToCollection(c.id, [ids.delta, ids.beta]);
  const file = writeList('Two.m3u8', [one, 'C:\\PlTest\\Lib\\alpha.mp4']);
  const rv = await pi.openPlaylist(file);
  const out = await pi.commit(rv.session, { target: 'existing', collectionId: c.id, addAndScan: true });
  const a1 = importAdd.addPaths([one], { analyse: false });
  // Before alpha (later in the playlist), after the collection's own files.
  assert.deepStrictEqual(memberOrder(c.id), [ids.delta, ids.beta, a1.added[0].id, ids.alpha]);
  assert.deepStrictEqual(pi.undo(out.importId), { removed: 2, deleted: false });
  assert.deepStrictEqual(memberOrder(c.id), [ids.delta, ids.beta]);
  db.get().prepare('DELETE FROM media WHERE id = ?').run(a1.added[0].id);

  const rv2 = await pi.openPlaylist(file);
  const out2 = await pi.commit(rv2.session, { target: 'new', name: 'Gone soon', addAndScan: true });
  db.deleteCollection(out2.collectionId);
  const a = importAdd.addPaths([one], { analyse: false });
  assert.strictEqual(a.added.length, 1, 'the add itself is untouched');
  assert.strictEqual(pi._imports.get(out2.importId).pending.size, 0);
  db.get().prepare('DELETE FROM media WHERE id = ?').run(a.added[0].id);
});

test('commit: a file added to the library after the review goes in as a library file', { skip: onWindows }, async () => {
  const one = path.join(disk, 'new one.mp4');
  const rv = await pi.openPlaylist(writeList('Later.m3u8', [one, 'C:\\PlTest\\Lib\\alpha.mp4']));
  assert.strictEqual(rv.disk.length, 1);
  const a = importAdd.addPaths([one], { analyse: false });
  const out = await pi.commit(rv.session, { target: 'new', name: 'Later', addAndScan: true });
  assert.strictEqual(out.pending, 0);
  assert.deepStrictEqual(memberOrder(out.collectionId), [a.added[0].id, ids.alpha]);
  pi.undo(out.importId);
  db.get().prepare('DELETE FROM media WHERE id = ?').run(a.added[0].id);
});

test('Find in folder: by file name, then name + size against the library; two matches ask', { skip: onWindows }, async () => {
  const moved = path.join(tmp, 'Moved');
  write(path.join(moved, 'a', 'Lost One.mp4'), '12345');           // a library row elsewhere has this name and size
  write(path.join(moved, 'b', 'lost two.mp4'), '1');               // not in the library
  write(path.join(moved, 'a', 'twice.mp4'), '1');
  write(path.join(moved, 'b', 'c', 'twice.mp4'), '22');
  const elsewhere = insert('E:\\Old drive\\lost one.mp4', { size: 5 });
  const file = writeList('Old PC.m3u8', [
    'F:\\Old\\lost one.mp4', 'F:\\Old\\lost two.mp4', 'F:\\Old\\twice.mp4', 'F:\\Old\\never.mp4', 'C:\\PlTest\\Lib\\alpha.mp4',
  ]);
  const rv = await pi.openPlaylist(file);
  assert.strictEqual(rv.missing.length, 4);
  const found = await pi.findInFolder(rv.session, moved);
  assert.deepStrictEqual(found, { resolved: 2, ambiguous: 1, truncated: false });
  let r = pi.review(rv.session);
  assert.deepStrictEqual(r.library.map((x) => x.id), [elsewhere, ids.alpha]);
  assert.deepStrictEqual(r.disk.map((x) => x.path), [path.join(moved, 'b', 'lost two.mp4')]);
  assert.deepStrictEqual(r.missing.map((x) => x.raw), ['F:\\Old\\never.mp4']);
  assert.strictEqual(r.ambiguous.length, 1);
  assert.strictEqual(r.ambiguous[0].options.length, 2);
  assert.throws(() => pi.choose(rv.session, r.ambiguous[0].index, 5), { code: 'BAD_CHOICE' });
  const pick = r.ambiguous[0].options.findIndex((o) => o.path.endsWith(path.join('c', 'twice.mp4')));
  pi.choose(rv.session, r.ambiguous[0].index, pick);
  r = pi.review(rv.session);
  assert.deepStrictEqual(r.disk.map((x) => x.name), ['lost two.mp4', 'twice.mp4']);
  assert.strictEqual(r.ambiguous.length, 0);
  assert.throws(() => pi.choose(rv.session, 0, 0), { code: 'BAD_CHOICE' }, 'only an entry with a choice');
  pi.close(rv.session);
  db.get().prepare('DELETE FROM media WHERE id = ?').run(elsewhere);
});

// ── Routes ─────────────────────────────────────────────────────────────────

const post = (p, body, headers = {}) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}),
});
const fakePicker = (out, seen = {}) => (res, onClose) => {
  seen.opened = (seen.opened || 0) + 1;
  onClose({ code: 0, out, errOut: '', finish: (status, body) => res.status(status).json(body) });
};

test('routes: pick a playlist, review, find in folder, commit, undo', { skip: onWindows }, async () => {
  const file = writeList('Picked.m3u8', ['C:\\PlTest\\Lib\\alpha.mp4', 'F:\\Old\\lost two.mp4', 'C:\\PlTest\\Lib\\gamma.mp4']);
  try {
    server._setPlaylistDialogsForTest({ pickPlaylist: fakePicker(file) });
    let res = await post('/api/playlists/import/pick');
    assert.strictEqual(res.status, 200);
    const rv = await res.json();
    assert.strictEqual(rv.name, 'Picked');
    assert.strictEqual(rv.missing.length, 1);
    res = await fetch(`${base}/api/playlists/import/${rv.session}`);
    assert.strictEqual((await res.json()).session, rv.session);

    server._setPlaylistDialogsForTest({ pickFolder: fakePicker(path.join(tmp, 'Moved')) });
    res = await post(`/api/playlists/import/${rv.session}/find-in-folder`);
    const after = await res.json();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(after.found, { resolved: 1, ambiguous: 0, truncated: false });
    assert.strictEqual(after.disk.length, 1);

    res = await post(`/api/playlists/import/${rv.session}/commit`, { target: 'new', name: 'Picked', addAndScan: true });
    const out = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(out));
    assert.deepStrictEqual(memberOrder(out.collectionId), [ids.alpha, ids.gamma]);
    assert.strictEqual(out.pending, 1);
    res = await post(`/api/playlists/imports/${out.importId}/undo`);
    assert.deepStrictEqual(await res.json(), { removed: 2, deleted: true });
    res = await post(`/api/playlists/imports/${out.importId}/undo`);
    assert.strictEqual(res.status, 404);
  } finally {
    server._setPlaylistDialogsForTest(null);
  }
});

test('routes: picker cancel, paths a picker should never print, non-playlists, the disabled native picker', { skip: onWindows }, async () => {
  try {
    server._setPlaylistDialogsForTest({ pickPlaylist: fakePicker('::CANCEL::') });
    assert.deepStrictEqual(await (await post('/api/playlists/import/pick')).json(), { canceled: true });
    for (const out of ['relative\\list.m3u8', 'C:\\a.m3u8\nC:\\b.m3u8', 'C:list.m3u']) {
      server._setPlaylistDialogsForTest({ pickPlaylist: fakePicker(out) });
      const res = await post('/api/playlists/import/pick');
      assert.strictEqual(res.status, 400, out);
      assert.strictEqual((await res.json()).code, 'BAD_PATH');
    }
    server._setPlaylistDialogsForTest({ pickPlaylist: fakePicker(path.join(disk, 'data.xyz')) });
    let res = await post('/api/playlists/import/pick');
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, 'BAD_FILE');
    server._setPlaylistDialogsForTest({ pickPlaylist: fakePicker(path.join(lists, 'not there.m3u')) });
    res = await post('/api/playlists/import/pick');
    assert.strictEqual(res.status, 400);
  } finally {
    server._setPlaylistDialogsForTest(null);
  }
  // The real picker, switched off by VAULT_DISABLE_NATIVE_PICKER: 409, no window.
  let res = await post('/api/playlists/import/pick');
  assert.strictEqual(res.status, 409);
  const rv = await pi.openPlaylist(writeList('F.m3u8', ['F:\\Old\\x.mp4']));
  res = await post(`/api/playlists/import/${rv.session}/find-in-folder`);
  assert.strictEqual(res.status, 409);
  pi.close(rv.session);
});

test('routes: a dropped playlist is found through the drop resolver, else the page is told to pick it', { skip: onWindows }, async () => {
  const file = writeList('Dropped.m3u8', ['C:\\PlTest\\Lib\\alpha.mp4']);
  const size = fs.statSync(file).size;
  const seen = {};
  try {
    server._setPlaylistDialogsForTest({ resolve: (cb) => { seen.ran = (seen.ran || 0) + 1; cb(JSON.stringify([[file]])); } });
    let res = await post('/api/playlists/import/drop', { name: 'Dropped.m3u8', size });
    const rv = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(rv));
    assert.strictEqual(rv.playlistPath, file);
    assert.strictEqual(rv.library.length, 1);
    pi.close(rv.session);
    // The selection is another file (or the size differs): not resolved.
    res = await post('/api/playlists/import/drop', { name: 'Dropped.m3u8', size: size + 1 });
    assert.deepStrictEqual(await res.json(), { unresolved: 'no matching selection' });
    server._setPlaylistDialogsForTest({ resolve: (cb) => cb(null) });
    res = await post('/api/playlists/import/drop', { name: 'Dropped.m3u8', size });
    assert.ok((await res.json()).unresolved);
    // The page names a file only by name and size, never a path.
    for (const body of [{ name: 'C:\\x\\Dropped.m3u8', size }, { name: 'clip.mp4', size }, { name: 'a.m3u', size: -1 }, {}]) {
      res = await post('/api/playlists/import/drop', body);
      assert.strictEqual(res.status, 400, JSON.stringify(body));
    }
    assert.strictEqual(seen.ran, 2);
  } finally {
    server._setPlaylistDialogsForTest(null);
  }
});

test('routes: session ids, bad bodies, the lock gate and the cross-site guard', { skip: onWindows }, async () => {
  let res = await fetch(`${base}/api/playlists/import/not-a-session`);
  assert.strictEqual(res.status, 404);
  res = await post('/api/playlists/import/00000000-0000-4000-8000-000000000000/commit', { target: 'new', name: 'x' });
  assert.strictEqual(res.status, 404);
  const rv = await pi.openPlaylist(writeList('G.m3u8', ['C:\\PlTest\\Lib\\alpha.mp4']));
  res = await post(`/api/playlists/import/${rv.session}/commit`, { target: 'somewhere' });
  assert.strictEqual(res.status, 400);
  res = await post(`/api/playlists/import/${rv.session}/commit`, { target: 'new', name: 5 });
  assert.strictEqual(res.status, 400);
  res = await post(`/api/playlists/import/${rv.session}/choose`, { index: 0, pick: 0 });
  assert.strictEqual(res.status, 400);

  const seen = {};
  server._setPlaylistDialogsForTest({ pickPlaylist: fakePicker('::CANCEL::', seen) });
  try {
    for (const h of [{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.strictEqual((await post('/api/playlists/import/pick', {}, h)).status, 403);
      assert.strictEqual((await post(`/api/playlists/import/${rv.session}/commit`, { target: 'new', name: 'x' }, h)).status, 403);
    }
    assert.strictEqual(seen.opened, undefined, 'no picker for a refused request');
    vault.bootLocked();
    try {
      assert.strictEqual((await post('/api/playlists/import/pick')).status, 423);
      assert.strictEqual((await post('/api/playlists/import/drop', { name: 'a.m3u', size: 1 })).status, 423);
      assert.strictEqual((await fetch(`${base}/api/playlists/import/${rv.session}`)).status, 423);
      assert.strictEqual((await post(`/api/playlists/imports/${rv.session}/undo`)).status, 423);
    } finally {
      vault._locked = false;
    }
    assert.ok(server.isLockGatedPath('/api/playlists/import/pick'));
  } finally {
    server._setPlaylistDialogsForTest(null);
  }
  pi.close(rv.session);
});

test('a big playlist (20,000 entries) is matched without holding the event loop', { skip: onWindows }, async () => {
  const lines = [];
  const conn = db.get();
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, ?, 'video')");
  conn.transaction(() => {
    for (let i = 0; i < 20000; i++) {
      const p = `C:\\Big\\${i}.mp4`;
      if (i % 2 === 0) ins.run(p, `${i}.mp4`);
      lines.push(i % 4 === 1 ? p.toLowerCase() : p);
    }
  })();
  const file = writeList('Big.m3u8', lines);
  let longest = 0;
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  const t0 = Date.now();
  const rv = await pi.openPlaylist(file);
  clearInterval(timer);
  assert.strictEqual(rv.library.length, 10000);
  assert.strictEqual(rv.missing.length, 10000);
  assert.ok(longest < 500, `event loop held for ${longest} ms`);
  console.log(`# 20,000 entries matched in ${Date.now() - t0} ms, longest event-loop stall ${longest} ms`);
  const out = await pi.commit(rv.session, { target: 'new', name: 'Big' });
  assert.strictEqual(out.added, 10000);
  pi.undo(out.importId);
  conn.prepare("DELETE FROM media WHERE filepath LIKE 'C:\\Big\\%'").run();
});

// ── Verifier round: trash index, network paths, lock race, busy, bounds, worker ──

test('trashed entries: batched lookups on the trashed-rows index, no walk of the trash', { skip: onWindows }, async () => {
  const conn = db.get();
  const plan = conn.prepare(`EXPLAIN QUERY PLAN SELECT id, trashed_original_path FROM media
    WHERE user_trashed = 1 AND trashed_original_path COLLATE NOCASE IN (?,?)`).all('a', 'b').map((r) => r.detail).join(' | ');
  assert.match(plan, /USING (COVERING )?INDEX idx_media_trash_origin/);
  // 3000 trashed rows: only the entries' own paths are looked up.
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type, user_trashed, trashed_original_path) VALUES (?, ?, 'video', 1, ?)");
  conn.transaction(() => { for (let i = 0; i < 3000; i++) ins.run(`C:\\Trash\\b${i}.mp4`, `b${i}.mp4`, `C:\\Gone\\b${i}.mp4`); })();
  const before = pi._queryCount();
  const r = await pi.matchEntries([entry(0, 'c:\\GONE\\b17.mp4'), entry(1, 'C:\\Gone\\not trashed.mp4')], { playlistDir: lists });
  assert.deepStrictEqual(r.map((x) => x.kind), ['trashed', 'missing']);
  assert.ok(pi._queryCount() - before <= 8, `queries: ${pi._queryCount() - before}`);
  conn.prepare("DELETE FROM media WHERE filepath LIKE 'C:\\Trash\\b%'").run();
});

test('network paths: servers the library does not use are never opened while reading', { skip: onWindows }, async () => {
  const nas = insert('\\\\nas\\media\\known.mp4');
  const statted = [];
  const realStat = fs.promises.stat;
  // Network paths are recorded, never really opened (no SMB from a test).
  fs.promises.stat = async (p, ...a) => {
    statted.push(String(p));
    if (/^[\\/]{2}/.test(String(p))) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return realStat(p, ...a);
  };
  try {
    const parsed = require('../lib/playlist/parse').parsePlaylist(Buffer.from([
      '\\\\attacker\\share\\x.mp4',
      'file://evil.example.com/share/a.mp4',
      '\\\\?\\UNC\\evil2\\s\\b.mp4',
      '\\\\NAS\\media\\other.mp4',          // the library has files on this server (any case)
      'C:\\PlTest\\Nope\\local.mp4',
    ].join('\n')), { fileName: 'n.m3u' });
    const r = await pi.matchEntries(parsed.entries, { playlistDir: lists });
    assert.deepStrictEqual(r.map((x) => x.kind), ['network', 'network', 'network', 'missing', 'missing']);
    assert.deepStrictEqual(r.slice(0, 3).map((x) => x.host), ['attacker', 'evil.example.com', 'evil2']);
    assert.ok(!statted.some((p) => /attacker|evil/i.test(p)), `opened: ${statted.join(', ')}`);
    assert.ok(statted.some((p) => /\\\\NAS\\media/i.test(p)), 'a known server is looked at');
    // The playlist's own server is looked at too.
    statted.length = 0;
    await pi.matchEntries([entry(0, 'clip.mp4')], { playlistDir: '\\\\listhost\\lists' });
    assert.ok(statted.some((p) => /listhost/i.test(p)));

    // The review lists them, Find in folder still finds them by name.
    const file = writeList('Net.m3u8', ['\\\\attacker\\share\\lost two.mp4']);
    const rv = await pi.openPlaylist(file);
    assert.deepStrictEqual(rv.network.map((x) => x.host), ['attacker']);
    const found = await pi.findInFolder(rv.session, path.join(tmp, 'Moved'));
    assert.strictEqual(found.resolved, 1);
    assert.strictEqual(pi.review(rv.session).network.length, 0);
    pi.close(rv.session);
  } finally {
    fs.promises.stat = realStat;
    db.get().prepare('DELETE FROM media WHERE id = ?').run(nas);
  }
});

test('a lock while a playlist is being read: no session is kept and the route answers 423', { skip: onWindows }, async () => {
  const file = writeList('Racy.m3u8', [path.join(disk, 'new one.mp4'), 'C:\\PlTest\\Nope\\x.mp4']);
  const realStat = fs.promises.stat;
  let fired = false;
  // The lock lands during the disk step (the server's lock calls clearSessions).
  fs.promises.stat = async (p, ...a) => {
    if (!fired && /new one/.test(String(p))) { fired = true; pi.clearSessions(); vault._locked = true; }
    return realStat(p, ...a);
  };
  try {
    await assert.rejects(pi.openPlaylist(file), { code: 'LOCKED' });
    fired = false;
    vault._locked = false;
    server._setPlaylistDialogsForTest({ pickPlaylist: fakePicker(file) });
    const res = await post('/api/playlists/import/pick');
    assert.strictEqual(res.status, 423);
    assert.ok(!JSON.stringify(await res.json()).includes('new one'));
  } finally {
    fs.promises.stat = realStat;
    vault._locked = false;
    server._setPlaylistDialogsForTest(null);
  }
});

test('choose waits while Find in folder runs; the imports kept for Undo are bounded', { skip: onWindows }, async () => {
  const rv = await pi.openPlaylist(writeList('Busy.m3u8', ['F:\\Old\\twice.mp4']));
  const finding = pi.findInFolder(rv.session, path.join(tmp, 'Moved'));
  assert.throws(() => pi.choose(rv.session, 0, 0), { code: 'BUSY' });
  await finding;
  assert.strictEqual(pi.review(rv.session).ambiguous.length, 1);
  pi.choose(rv.session, 0, 0);
  pi.close(rv.session);

  const file = writeList('Many.m3u8', ['C:\\PlTest\\Lib\\alpha.mp4']);
  const made = [];
  for (let i = 0; i < 55; i++) {
    const s = await pi.openPlaylist(file);
    made.push(await pi.commit(s.session, { target: 'new', name: `Many ${i}` }));
  }
  assert.strictEqual(pi._imports.size <= 50, true, `imports kept: ${pi._imports.size}`);
  assert.throws(() => pi.undo(made[0].importId), { code: 'NOT_FOUND' }, 'the oldest went first');
  for (const m of made) db.deleteCollection(m.collectionId);
});

test('a big or hostile playlist file is read in a worker thread, off the event loop', { skip: onWindows }, async () => {
  const head = '<?xml version="1.0"?><playlist><trackList>';
  const file = write(path.join(lists, 'Hostile.xspf'), head + '<track>'.repeat(150000) + '<track><location>file:///C:/PlTest/Lib/alpha.mp4</location></track>');
  assert.ok(fs.statSync(file).size > 512 * 1024);
  let longest = 0;
  let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  const t0 = Date.now();
  const rv = await pi.openPlaylist(file);
  clearInterval(timer);
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(longest < 300, `event loop held for ${longest} ms`);
  // The first <track> runs to the only </track>, so its body holds the one location.
  assert.strictEqual(rv.total, 1);
  assert.strictEqual(rv.library.length, 1);
  pi.close(rv.session);
  const direct = await pi.parseInWorker(fs.readFileSync(path.join(__dirname, 'fixtures', 'playlists', 'vlc.xspf')), 'vlc.xspf');
  assert.deepStrictEqual(direct.entries.map((e) => e.path), ['C:\\Media\\Café clip.mp4', '\\\\nas\\media\\Beta two.mkv', 'Sub/rel one.mp4', null]);
});
