/**
 * /api/watch/* over HTTP against the real Express app (server/index.js) and
 * a temp library: path validation (not absolute, not found, a file, a drive
 * root without confirm), nested folders (covered, absorbed, duplicate),
 * option checks, stop watching, 423 for every route while locked, the CSRF
 * guard; the Missing and "Added since you last looked" filters and facets;
 * the New mark cleared by /seen; add-paths (now shared with the watchers)
 * still answers the same and records modified times; and the missing-files
 * banner count and the Missing filter agree.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-watch-routes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const importQueue = require('../lib/import-queue');
const watchers = require('../lib/watchers');
const { app } = require('../server/index');

let server;
let base;
const media = path.join(tmp, 'media');

test.before(async () => {
  db.init();
  importQueue.pause();                 // nothing here should reach an AI model
  fs.mkdirSync(path.join(media, 'Clips', 'Old'), { recursive: true });
  fs.mkdirSync(path.join(media, 'Other'), { recursive: true });
  fs.writeFileSync(path.join(media, 'a-file.txt'), 'x');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  watchers._resetForTest();
  importQueue.cancel();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

async function call(method, p, body, headers = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('watch a folder: path checks in plain words', async () => {
  assert.strictEqual((await call('POST', '/api/watch/folders', {})).status, 400);
  assert.strictEqual((await call('POST', '/api/watch/folders', { path: 'relative\\dir' })).status, 400);
  assert.strictEqual((await call('POST', '/api/watch/folders', { path: 42 })).status, 400);
  assert.strictEqual((await call('POST', '/api/watch/folders', { path: 'C:\\x\u0000y' })).status, 400);
  const nf = await call('POST', '/api/watch/folders', { path: path.join(media, 'nope') });
  assert.strictEqual(nf.status, 404);
  assert.match(nf.json.error, /not found/);
  const file = await call('POST', '/api/watch/folders', { path: path.join(media, 'a-file.txt') });
  assert.strictEqual(file.status, 400);
  assert.match(file.json.error, /file, not a folder/);
  if (process.platform === 'win32') {
    const root = await call('POST', '/api/watch/folders', { path: path.parse(tmp).root });
    assert.strictEqual(root.status, 409, 'a whole drive needs a confirm');
    assert.strictEqual(root.json.code, 'WATCH_CONFIRM_ROOT');
  }
  for (const r of [nf, file]) assert.ok(!/[–—]/.test(r.json.error), 'no dashes');
  assert.deepStrictEqual((await call('GET', '/api/watch/folders')).json.folders, []);
});

test('watch, nest, absorb, edit, check, stop', async () => {
  const clips = await call('POST', '/api/watch/folders', { path: path.join(media, 'Clips'), newFiles: 'add_only' });
  assert.strictEqual(clips.status, 200, JSON.stringify(clips.json));
  const f = clips.json.folder;
  assert.strictEqual(f.mode, 'live');
  assert.strictEqual(f.newFiles, 'add_only');
  assert.strictEqual(f.includeSubfolders, true);
  assert.deepStrictEqual(f.types, ['video', 'image']);
  assert.ok(f.skipPatterns.includes('*.part') && f.skipPatterns.includes('@eaDir\\'));
  assert.strictEqual(f.minSizeBytes, 0, 'smaller than is off by default');

  const dup = await call('POST', '/api/watch/folders', { path: path.join(media, 'Clips') + path.sep });
  assert.strictEqual(dup.status, 409);
  const inner = await call('POST', '/api/watch/folders', { path: path.join(media, 'Clips', 'Old') });
  assert.strictEqual(inner.status, 409);
  assert.strictEqual(inner.json.code, 'WATCH_COVERED');
  assert.match(inner.json.error, /Clips/);

  const parent = await call('POST', '/api/watch/folders', { path: media, newFiles: 'add_only' });
  assert.strictEqual(parent.status, 200);
  assert.deepStrictEqual(parent.json.merged, [path.join(media, 'Clips')], 'the inner folder folds into the parent');
  const list = (await call('GET', '/api/watch/folders')).json;
  assert.deepStrictEqual(list.folders.map(x => x.path), [media]);
  assert.strictEqual(list.checkOnStart, true);
  assert.ok(list.types.some(t => t.id === 'document' && t.offered === false), 'Documents listed, not offered yet');
  const id = list.folders[0].id;
  assert.ok(list.folders[0].status && typeof list.folders[0].status.state === 'string');

  for (const bad of [{ mode: 'sometimes' }, { types: [] }, { types: 'video' }, { minSizeBytes: -1 }, { intervalMin: 0 }, { newFiles: 'all' }]) {
    const r = await call('POST', `/api/watch/folders/${id}`, bad);
    assert.strictEqual(r.status, 400, JSON.stringify(bad));
    assert.ok(r.json.error && !/[–—]/.test(r.json.error));
  }
  const ok = await call('POST', `/api/watch/folders/${id}`, {
    mode: 'timer', intervalMin: 30, types: ['video', 'audio', 'document'], skipPatterns: '*.part\nTemp\\\n', minSizeBytes: 102400,
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.folder.mode, 'timer');
  assert.strictEqual(ok.json.folder.intervalMin, 30);
  assert.deepStrictEqual(ok.json.folder.types, ['video', 'audio'], 'documents dropped until offered');
  assert.deepStrictEqual(ok.json.folder.skipPatterns, ['*.part', 'Temp\\']);
  assert.strictEqual(ok.json.folder.minSizeBytes, 102400);

  assert.strictEqual((await call('POST', `/api/watch/folders/${id}/check`)).status, 200);
  assert.strictEqual((await call('POST', '/api/watch/folders/999/check')).status, 404);
  assert.strictEqual((await call('POST', '/api/watch/folders/abc')).status, 400);

  assert.strictEqual((await call('POST', '/api/watch/pause')).json.paused, true);
  const paused = await call('POST', `/api/watch/folders/${id}/check`);
  assert.strictEqual(paused.status, 409);
  assert.strictEqual(paused.json.code, 'WATCH_PAUSED');
  assert.strictEqual((await call('GET', '/api/watch/folders')).json.folders[0].status.state, 'paused');
  assert.strictEqual((await call('POST', '/api/watch/resume')).json.paused, false);

  assert.strictEqual((await call('POST', '/api/watch/settings', { checkOnStart: 'yes' })).status, 400);
  assert.strictEqual((await call('POST', '/api/watch/settings', { checkOnStart: false })).json.checkOnStart, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(process.env.VAULT_SETTINGS_FILE, 'utf8')).watchCheckOnStart, false);

  assert.strictEqual((await call('DELETE', `/api/watch/folders/${id}`)).status, 200);
  assert.strictEqual((await call('DELETE', `/api/watch/folders/${id}`)).status, 404);
  assert.deepStrictEqual((await call('GET', '/api/watch/folders')).json.folders, []);
});

test('every watch route is 423 while locked; cross-origin writes are refused', async () => {
  vault._locked = true;
  try {
    for (const [method, p] of [['GET', '/api/watch/folders'], ['POST', '/api/watch/folders'], ['POST', '/api/watch/folders/1'],
      ['DELETE', '/api/watch/folders/1'], ['POST', '/api/watch/folders/1/check'], ['POST', '/api/watch/pause'],
      ['POST', '/api/watch/resume'], ['POST', '/api/watch/settings'], ['GET', '/api/watch/activity'], ['POST', '/api/watch/seen']]) {
      const r = await call(method, p, method === 'GET' ? undefined : {});
      assert.strictEqual(r.status, 423, `${method} ${p}`);
    }
  } finally {
    vault._locked = false;
  }
  const csrf = await call('POST', '/api/watch/folders', { path: media }, { Origin: 'http://evil.example' });
  assert.strictEqual(csrf.status, 403);
});

test('Missing and New: kept rows, filters, facets, and /seen', async () => {
  const conn = db.get();
  const ins = conn.prepare(`INSERT INTO media (filepath, filename, media_type, filesize_bytes, user_notes, user_rating, missing_since, watch_new)
    VALUES (?, ?, 'video', 10, ?, ?, ?, ?)`);
  const gone = Number(ins.run(path.join(media, 'gone.mp4'), 'gone.mp4', 'notes stay', 4, Date.now(), 0).lastInsertRowid);
  const fresh = Number(ins.run(path.join(media, 'fresh.mp4'), 'fresh.mp4', '', 0, null, 1).lastInsertRowid);
  const plain = Number(ins.run(path.join(media, 'plain.mp4'), 'plain.mp4', '', 0, null, 0).lastInsertRowid);

  const q = async (filters) => {
    const r = await call('POST', '/api/library/query', { filters, pageSize: 100 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    return r.json.page.ids;
  };
  const only = await q({ missing: '1' });
  assert.ok(only.includes(gone) && !only.includes(fresh) && !only.includes(plain), JSON.stringify(only));
  const hide = await q({ missing: '0' });
  assert.ok(!hide.includes(gone) && hide.includes(plain));
  const news = await q({ watchNew: '1' });
  assert.deepStrictEqual(news.filter(id => [gone, fresh, plain].includes(id)), [fresh]);
  assert.strictEqual((await call('POST', '/api/library/query', { filters: { missing: 'yes' } })).status, 400);

  const facets = (await call('GET', '/api/library/facets')).json;
  assert.ok(facets.missing >= 1 && facets.watchNew >= 1, JSON.stringify({ missing: facets.missing, watchNew: facets.watchNew }));

  assert.strictEqual((await call('POST', '/api/watch/seen', { ids: ['x'] })).status, 400);
  assert.strictEqual((await call('POST', '/api/watch/seen', { ids: [fresh] })).json.cleared, 1);
  assert.strictEqual(conn.prepare('SELECT watch_new FROM media WHERE id = ?').pluck().get(fresh), 0);

  const row = conn.prepare('SELECT user_notes, user_rating FROM media WHERE id = ?').get(gone);
  assert.deepStrictEqual({ ...row }, { user_notes: 'notes stay', user_rating: 4 });

  const act = await call('GET', '/api/watch/activity');
  assert.strictEqual(act.status, 200);
  assert.strictEqual(typeof act.json.newTotal, 'number');
});

test('add-paths answers as before and records size and modified time', async () => {
  const clip = path.join(media, 'Other', 'clip.mp4');
  fs.writeFileSync(clip, Buffer.alloc(2048));
  const r = await call('POST', '/api/import/add-paths', { paths: [clip, path.join(media, 'a-file.txt'), path.join(media, 'nope.mp4')] });
  assert.strictEqual(r.status, 200);
  // The registry takes .txt as a document, as add-paths always has.
  assert.deepStrictEqual(r.json.added.map(a => a.mediaType).sort(), ['document', 'video']);
  assert.deepStrictEqual(r.json.skipped, { unsupported: 0, existing: 0, missing: 1 });
  const row = db.getByPath(clip);
  assert.strictEqual(row.filesize_bytes, 2048);
  assert.strictEqual(row.file_mtime_ms, Math.trunc(fs.statSync(clip).mtimeMs));
  assert.strictEqual(row.watch_new, 0, 'Add folder rows are not New');
  const again = await call('POST', '/api/import/add-paths', { paths: [clip] });
  assert.strictEqual(again.json.skipped.existing, 1);
});

test('the missing-files count and the Missing filter agree after the walk', async () => {
  const conn = db.get();
  const ghost = Number(conn.prepare(`INSERT INTO media (filepath, filename, media_type) VALUES (?, 'ghost.mp4', 'video')`)
    .run(path.join(media, 'ghost.mp4')).lastInsertRowid);
  const clip = db.getByPath(path.join(media, 'Other', 'clip.mp4'));
  conn.prepare('UPDATE media SET missing_since = 1 WHERE id = ?').run(clip.id);      // stale: the file is there
  let info = (await call('GET', '/api/library/missing-count?refresh=1')).json;
  for (let i = 0; i < 50 && info.computing; i++) {
    await new Promise(r => setTimeout(r, 50));
    info = (await call('GET', '/api/library/missing-count')).json;
  }
  assert.strictEqual(info.computing, false);
  const marked = conn.prepare('SELECT count(*) FROM media WHERE missing_since IS NOT NULL AND user_trashed = 0').pluck().get();
  assert.strictEqual(marked, info.count, 'the banner and the filter count the same files');
  assert.ok(conn.prepare('SELECT missing_since FROM media WHERE id = ?').pluck().get(ghost) != null);
  assert.strictEqual(conn.prepare('SELECT missing_since FROM media WHERE id = ?').pluck().get(clip.id), null);
});

test('a repointed row (relink, or a watcher move) is no longer missing', () => {
  const conn = db.get();
  const id = Number(conn.prepare(`INSERT INTO media (filepath, filename, media_type, missing_since) VALUES (?, 'm.mp4', 'video', 5)`)
    .run(path.join(media, 'm.mp4')).lastInsertRowid);
  db.repointPath(id, path.join(media, 'Other', 'm2.mp4'));
  const r = conn.prepare('SELECT filepath, missing_since FROM media WHERE id = ?').get(id);
  assert.strictEqual(r.filepath, path.join(media, 'Other', 'm2.mp4'));
  assert.strictEqual(r.missing_since, null);
});

/* ── Data safety (verifier round 1) ─────────────────────────────────────── */

const store = require('../lib/watchers/store');
const importAdd = require('../lib/import-add');
const WIN = process.platform === 'win32';

test('paths: a folder path with no drive is refused; a link as the root is refused with its real place', { skip: !WIN }, async () => {
  const bare = await call('POST', '/api/watch/folders', { path: '\Claude\Fable' });
  assert.strictEqual(bare.status, 400);
  assert.match(bare.json.error, /drive/);
  const slash = await call('POST', '/api/watch/folders', { path: '/Claude/Fable' });
  assert.strictEqual(slash.status, 400);
  const target = path.join(media, 'Other');
  const link = path.join(tmp, 'link-to-other');
  fs.symlinkSync(target, link, 'junction');     // no admin needed for a junction
  const r = await call('POST', '/api/watch/folders', { path: link });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.code, 'WATCH_LINK');
  assert.ok(r.json.error.includes(target), r.json.error);
  assert.ok(!/[–—]/.test(r.json.error));
  fs.rmdirSync(link);              // removes the junction only
});

test('folder case: a folder typed in another case is stored in its real case and finds its rows', { skip: !WIN }, async () => {
  const sub = path.join(media, 'CaseDir');
  fs.mkdirSync(path.join(sub, 'Inner'), { recursive: true });
  const file = path.join(sub, 'Inner', 'b.jpg');
  fs.writeFileSync(file, Buffer.alloc(3000));
  importAdd.addPaths([file], { analyse: false });
  const r = await call('POST', '/api/watch/folders', { path: sub.toLowerCase(), newFiles: 'add_only' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.folder.path, sub, 'stored with the case on disk');
  const rows = store.rowsUnder(sub.toLowerCase(), null, 100);
  assert.deepStrictEqual(rows.map(x => x.filepath), [file], 'a lower-case root still finds the row');
  assert.strictEqual(store.rowAt(file.toUpperCase()).filepath, file);
  // Add files in another case: the same file, not a second row.
  const again = importAdd.addPaths([file.toUpperCase()], { analyse: false });
  assert.strictEqual(again.skipped.existing, 1);
  assert.strictEqual(db.get().prepare('SELECT count(*) FROM media WHERE filepath = ? COLLATE NOCASE').pluck().get(file), 1);
  await new Promise(res => setTimeout(res, 300));
  assert.strictEqual(db.get().prepare('SELECT count(*) FROM media WHERE filepath = ? COLLATE NOCASE').pluck().get(file), 1,
    'the first walk does not duplicate it either');
  await call('DELETE', `/api/watch/folders/${r.json.folder.id}`);
});

test('keyset paging over a folder returns every row once, case ties included', () => {
  const conn = db.get();
  const root = path.join(media, 'Paging');
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'x', 'video')");
  for (let i = 0; i < 25; i++) ins.run(path.join(root, `f${String(i).padStart(2, '0')}.mp4`));
  let after = null;
  const seen = [];
  for (;;) {
    const page = store.rowsUnder(root, after, 7);
    if (!page.length) break;
    seen.push(...page.map(r => r.filepath));
    after = page[page.length - 1];
  }
  assert.strictEqual(seen.length, 25);
  assert.strictEqual(new Set(seen).size, 25);
});

test('writes name their path: a row that moved in between is left alone', () => {
  const conn = db.get();
  const id = Number(conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'r.mp4', 'video')")
    .run(path.join(media, 'r.mp4')).lastInsertRowid);
  assert.strictEqual(store.markMissing([{ id, path: path.join(media, 'elsewhere.mp4') }], 5), 0);
  assert.strictEqual(store.markMissing([{ id, path: path.join(media, 'r.mp4') }], 5), 1);
  assert.strictEqual(store.clearMissing([{ id, path: path.join(media, 'elsewhere.mp4') }]), 0);
  assert.strictEqual(store.applyMoves([{ id, oldPath: path.join(media, 'nope.mp4'), newPath: path.join(media, 'r2.mp4'), size: 1, mtimeMs: 1 }]), 0);
  assert.strictEqual(store.markChanged([{ id, path: path.join(media, 'nope.mp4'), size: 1, mtimeMs: 1 }]).length, 0);
  assert.strictEqual(conn.prepare('SELECT filepath FROM media WHERE id = ?').pluck().get(id), path.join(media, 'r.mp4'));
  // Missing candidates: by size and mtime, missing rows only.
  conn.prepare('UPDATE media SET filesize_bytes = 77, file_mtime_ms = 9 WHERE id = ?').run(id);
  assert.deepStrictEqual(store.missingCandidates(77, 9).map(r => r.id), [id]);
  store.clearMissing([id]);
  assert.deepStrictEqual(store.missingCandidates(77, 9), []);
});

test('add-paths with no ffprobe makes nothing in the background, as before', async () => {
  const mediaInfo = require('../lib/media-info');
  const thumbnails = require('../lib/thumbnails');
  const realAvail = mediaInfo.isAvailable;
  const realEnqueue = thumbnails.enqueueThumbnail;
  const asked = [];
  mediaInfo.isAvailable = () => false;
  thumbnails.enqueueThumbnail = (row) => { asked.push(row && row.id); return 'queued'; };
  importAdd._resetProbeCheck();
  try {
    const pic = path.join(media, 'Other', 'pic.jpg');
    fs.writeFileSync(pic, Buffer.alloc(500));
    const added = importAdd.addPaths([pic], { analyse: false }).added;
    await importAdd.probeAndThumb(added, { requireProbe: true });
    assert.deepStrictEqual(asked, [], 'Add files: no ffprobe, nothing made');
    await importAdd.probeAndThumb(added, {});
    assert.deepStrictEqual(asked, [added[0].id], 'the watchers still make a picture thumbnail');
  } finally {
    mediaInfo.isAvailable = realAvail;
    thumbnails.enqueueThumbnail = realEnqueue;
    importAdd._resetProbeCheck();
  }
});

/* ── Verifier round 2 ───────────────────────────────────────────────────── */

const missingSweep = require('../lib/missing-sweep');
const libraryIndex = require('../lib/library-index');

/** A worker stand-in: a set of paths that exist, volumes that hang. */
function fakeChecker({ exist = new Set(), hang = [] } = {}) {
  const calls = [];
  return {
    calls,
    async check(paths) {
      calls.push(paths.slice());
      if (paths.some(p => hang.some(h => p.toLowerCase().startsWith(h.toLowerCase())))) return null;
      return paths.map(p => exist.has(p) || /^[A-Za-z]:\\$/.test(p) && exist.has(p));
    },
  };
}

test('missing sweep: volumes that are not there or hang are left alone; automatic sweeps skip network and removable drives', { skip: !WIN }, async () => {
  const conn = db.get();
  conn.prepare('DELETE FROM media').run();
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type, missing_since) VALUES (?, 'x', 'video', ?)");
  const here = path.join(media, 'here.mp4');
  const gone = path.join(media, 'gone.mp4');
  const unc = '\\\\host-that-hangs\\share\\a.mp4';
  const usb = 'Q:\\usb\\b.mp4';
  const held = path.join(media, 'Held', 'c.mp4');
  const ids = {};
  for (const [k, p, m] of [['here', here, 5], ['gone', gone, null], ['unc', unc, null], ['usb', usb, 7], ['held', held, null]]) {
    ids[k] = Number(ins.run(p, m).lastInsertRowid);
  }
  const vol = path.parse(media).root;     // e.g. C:\
  const exist = new Set([vol, here, path.join(media, 'Held')]);
  const checker = fakeChecker({ exist, hang: ['\\\\host-that-hangs'] });
  const out = await missingSweep.sweep({
    getDb: () => conn, stopped: () => false, store, checker,
    auto: true, types: new Map([['Q:', 2]]), holdRoots: [path.join(media, 'Held')],
  });
  const st = (id) => conn.prepare('SELECT missing_since FROM media WHERE id = ?').pluck().get(id);
  assert.strictEqual(st(ids.here), null, 'there: cleared');
  assert.ok(st(ids.gone) != null, 'gone: marked');
  assert.strictEqual(st(ids.unc), null, 'network share: not touched by the automatic sweep');
  assert.strictEqual(st(ids.usb), 7, 'removable drive: left as it was');
  assert.strictEqual(st(ids.held), null, 'below an offline watched folder: left alone');
  assert.ok(!checker.calls.flat().some(p => p.startsWith('\\\\')), 'the share was never even asked');
  assert.strictEqual(out.count, 2, 'gone + the removable row already marked');
  assert.strictEqual(out.count, conn.prepare('SELECT count(*) FROM media WHERE missing_since IS NOT NULL').pluck().get(), 'banner and filter agree');
  // An on-demand sweep asks the share once; it does not answer: nothing on it is marked.
  const c2 = fakeChecker({ exist, hang: ['\\\\host-that-hangs'] });
  const out2 = await missingSweep.sweep({ getDb: () => conn, stopped: () => false, store, checker: c2, auto: false });
  assert.strictEqual(st(ids.unc), null);
  assert.ok(out2.skipped.includes('\\\\host-that-hangs\\share'));
  assert.strictEqual(c2.calls.filter(c => c.some(p => p.startsWith('\\\\'))).length, 1, 'one look at the share, then skipped');
  // A watched folder that is not there holds its rows too.
  conn.prepare('UPDATE media SET missing_since = NULL WHERE id = ?').run(ids.held);
  await missingSweep.sweep({ getDb: () => conn, stopped: () => false, store, checker: fakeChecker({ exist: new Set([vol, here]) }),
    watchedRoots: [path.join(media, 'Held')] });
  assert.strictEqual(st(ids.held), null, 'its folder is not there: nothing marked');
  // Stopping mid-way writes nothing more.
  let n = 0;
  const stopped = await missingSweep.sweep({ getDb: () => conn, stopped: () => ++n > 1, store, checker: fakeChecker({ exist }) });
  assert.strictEqual(stopped, null);
});

test('the real worker answers, and a batch that hangs comes back null without blocking', async () => {
  const { ExistsChecker } = require('../lib/exists-check');
  const c = new ExistsChecker();
  try {
    const r = await c.check([__filename, path.join(tmp, 'nope.bin')], 5000);
    assert.deepStrictEqual(r, [true, false]);
    // A worker that never answers (stand-in for an unreachable share): null after the timeout.
    c._ensure().postMessage = () => {};
    const t0 = Date.now();
    assert.strictEqual(await c.check(['x'], 200), null);
    assert.ok(Date.now() - t0 < 2000);
    assert.deepStrictEqual(await c.check([__filename], 5000), [true], 'a fresh worker after the timeout');
  } finally {
    c.close();
  }
});

test('rowsUnder keyset uses the NOCASE index with both bounds; counts come in slices', { skip: !WIN }, () => {
  const conn = db.get();
  libraryIndex.missingWatchIndexes(conn).forEach(([n, on]) => conn.exec(`CREATE INDEX IF NOT EXISTS ${n} ON ${on}`));
  const root = path.join(media, 'Plan');
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'x', 'video')");
  for (let i = 0; i < 30; i++) ins.run(path.join(root, i % 2 ? `F${i}.mp4` : `f${i}.mp4`));
  const plan = conn.prepare(`EXPLAIN QUERY PLAN SELECT id FROM media WHERE filepath >= ? COLLATE NOCASE AND filepath < ? COLLATE NOCASE
      AND (filepath > ? COLLATE NOCASE OR id > ?) AND COALESCE(user_trashed, 0) = 0 ORDER BY filepath COLLATE NOCASE, id LIMIT 5`)
    .all('a', 'b', 'a', 1).map(r => r.detail).join(' | ');
  assert.match(plan, /idx_media_filepath_nocase \(filepath>\? AND filepath<\?\)/, plan);
  let after = null;
  const seen = [];
  for (;;) {
    const page = store.rowsUnder(root, after, 4);
    if (!page.length) break;
    seen.push(...page.map(r => r.id));
    after = page[page.length - 1];
  }
  assert.strictEqual(seen.length, 30);
  assert.strictEqual(new Set(seen).size, 30);
  return store.countUnder(root, { step: 7 }).then((n) => assert.strictEqual(n, 30));
});

test('folders list answers at once and counts files in the background', async () => {
  const dir = path.join(media, 'Counted');
  fs.mkdirSync(dir, { recursive: true });
  const conn = db.get();
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'x', 'video')");
  for (let i = 0; i < 12; i++) ins.run(path.join(dir, `c${i}.mp4`));
  const r = await call('POST', '/api/watch/folders', { path: dir, newFiles: 'add_only' });
  assert.strictEqual(r.status, 200);
  const first = (await call('GET', '/api/watch/folders')).json.folders.find(f => f.path === dir);
  assert.ok(first.files === null || first.files === 12, 'never counted inside the request');
  await new Promise(res => setTimeout(res, 200));
  const later = (await call('GET', '/api/watch/folders')).json.folders.find(f => f.path === dir);
  assert.strictEqual(later.files, 12);
  await call('DELETE', `/api/watch/folders/${r.json.folder.id}`);
});

test('rows spelled with forward slashes are found, never duplicated, and judged on disk', { skip: !WIN }, async () => {
  const conn = db.get();
  const real = path.join(media, 'Slash', 's.jpg');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, Buffer.alloc(100));
  const slashed = real.replace(/\\/g, '/');
  const gonePath = path.join(media, 'Slash', 'gone.jpg').replace(/\\/g, '/');
  const id = Number(conn.prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes) VALUES (?, 's.jpg', 'image', 100)").run(slashed).lastInsertRowid);
  const gid = Number(conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'gone.jpg', 'image')").run(gonePath).lastInsertRowid);
  assert.strictEqual(store.rowAt(real).id, id);
  assert.strictEqual(importAdd.addPaths([real], { analyse: false }).skipped.existing, 1, 'not a second row');
  const { catchUp } = require('../lib/watchers/catchup');
  const res = await catchUp({ path: path.join(media, 'Slash'), includeSubfolders: true, types: ['image'], skipPatterns: [], minSizeBytes: 0 },
    { rowsUnder: (r, a, l, s) => store.rowsUnder(r, a, l, s) });
  assert.deepStrictEqual(res.gone.map(g => g.id), [gid], 'the slash row whose file is gone, and only it');
});

test('add-paths: two spellings of one file in one request make one row', { skip: !WIN }, () => {
  const p = path.join(media, 'Other', 'twice.jpg');
  fs.writeFileSync(p, Buffer.alloc(300));
  const r = importAdd.addPaths([p, p.toUpperCase()], { analyse: false });
  assert.strictEqual(r.added.length, 1);
  assert.strictEqual(r.skipped.existing, 1);
});

test('watchers\' indexes: not built inside the open of a big library; built in the background after', async () => {
  const conn = db.get();
  for (const [n] of libraryIndex.WATCH_INDEXES) conn.exec(`DROP INDEX IF EXISTS ${n}`);
  libraryIndex._setWatchIndexNowRows(0);
  try {
    libraryIndex.ensureSchema(conn);
    assert.strictEqual(libraryIndex.missingWatchIndexes(conn).length, 4, 'the open does not build them');
    // Everything still works without them (slower).
    assert.ok(Array.isArray(store.rowsUnder(media, null, 5)));
    const counts = await store.activityCounts([{ id: 1, path: media }]);
    assert.strictEqual(counts.pending, true, 'the pill counts wait for their indexes');
    const done = await libraryIndex.buildWatchIndexes(() => conn, { pauseMs: 1, log: () => {} });
    assert.strictEqual(done.length, 4);
    assert.strictEqual(libraryIndex.missingWatchIndexes(conn).length, 0);
  } finally {
    libraryIndex._setWatchIndexNowRows(20000);
  }
});

test('fingerprint: first and last 64 KB plus size; a change in the middle is not seen, at either end it is', async () => {
  const { quickHash } = require('../lib/watchers/fingerprint');
  const a = path.join(tmp, 'fa.bin');
  const buf = Buffer.alloc(300 * 1024, 1);
  fs.writeFileSync(a, buf);
  const h1 = await quickHash(a);
  buf[150 * 1024] = 9; fs.writeFileSync(a, buf);
  assert.strictEqual(await quickHash(a), h1, 'the middle is not read');
  buf[10] = 9; fs.writeFileSync(a, buf);
  assert.notStrictEqual(await quickHash(a), h1);
  assert.strictEqual(await quickHash(path.join(tmp, 'none.bin')), null);
  const small = path.join(tmp, 'fs.bin');
  fs.writeFileSync(small, 'tiny');
  assert.match(await quickHash(small), /^[0-9a-f]{24}$/);
});

/* ── Verifier round 3 ───────────────────────────────────────────────────── */

test('setQuickHash: only into a row with none, and only for the copy the row describes', () => {
  const conn = db.get();
  const p = path.join(media, 'qh.jpg');
  const id = Number(conn.prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes, file_mtime_ms) VALUES (?, 'qh.jpg', 'image', 5011, 22)").run(p).lastInsertRowid);
  assert.strictEqual(store.setQuickHash([{ id, path: p, hash: 'old', size: 5000, mtimeMs: 11 }]), 0, 'read from an older copy');
  assert.strictEqual(store.setQuickHash([{ id, path: p, hash: 'nosize' }]), 0, 'no size or time: not stored');
  assert.strictEqual(store.setQuickHash([{ id, path: p, hash: 'right', size: 5011, mtimeMs: 22 }]), 1);
  assert.strictEqual(store.setQuickHash([{ id, path: p, hash: 'again', size: 5011, mtimeMs: 22 }]), 0, 'never overwrites');
  assert.strictEqual(conn.prepare('SELECT quick_hash FROM media WHERE id = ?').pluck().get(id), 'right');
});

test('lookups stay on the index: no per-folder scan for non-ASCII names, Add files as fast as for ASCII (Windows)', { skip: !WIN }, () => {
  const conn = db.get();
  const dir = path.join(media, 'Cyr');
  fs.mkdirSync(dir, { recursive: true });
  const ins = conn.prepare("INSERT INTO media (filepath, filename, media_type) VALUES (?, 'x', 'image')");
  conn.transaction(() => { for (let i = 0; i < 5000; i++) ins.run(path.join(dir, `Фо_${i}.jpg`)); })();
  // NOCASE folds A-Z only: an É spelling of an é row is not found (week 1 known limit).
  const e = Number(ins.run(path.join(dir, 'été.jpg')).lastInsertRowid);
  assert.strictEqual(store.rowAt(path.join(dir, 'ÉTÉ.jpg')), null);
  assert.strictEqual(store.rowAt(path.join(dir, 'ÉTÉ.JPG'.replace('.JPG', '.jpg')).replace('ÉTÉ', 'été')).id, e);
  const fresh = [];
  for (let i = 0; i < 300; i++) { const p = path.join(dir, `Жо_${i}.jpg`); fs.writeFileSync(p, 'x'); fresh.push(p); }
  const t0 = Date.now();
  const r = importAdd.addPaths(fresh, { analyse: false });
  const ms = Date.now() - t0;
  assert.strictEqual(r.added.length, 300);
  assert.ok(ms < 3000, `300 Cyrillic adds took ${ms} ms`);
  // Two spellings of one non-ASCII name in one request still make one row.
  const one = path.join(dir, 'Ünï.jpg');
  fs.writeFileSync(one, 'u');
  const twice = importAdd.addPaths([one, path.join(dir, 'üNÏ.jpg')], { analyse: false });
  assert.strictEqual(twice.added.length, 1);
});

test('fold rule: round-trip safe; never joins names NTFS keeps apart', () => {
  const rules = require('../lib/watchers/rules');
  const same = (a, b) => rules.foldCase(a) === rules.foldCase(b);
  for (const [a, b] of [['é', 'É'], ['ç', 'Ç'], ['ж', 'Ж'], ['ñ', 'Ñ'], ['abc', 'ABC']]) assert.ok(same(a, b), `${a}/${b} meet`);
  for (const [a, b] of [['i', 'ı'], ['s', 'ſ'], ['µ', 'μ'], ['ς', 'σ'], ['ẛ', 'ṡ'], ['ͅ', 'ι'], ['ß', 'ẞ'], ['ǅ', 'ǆ'], ['ǅ', 'Ǆ'], ['ǆ', 'Ǆ'], ['İ', 'i'], ['Sila', 'Sıla'], ['5µm', '5μm'], ['pass', 'paſſ']]) {
    assert.ok(!same(a, b), `${a}/${b} stay apart`);
  }
});

test('a probe worker stuck past its timeout is reported, so shutdown does not wait on it', async () => {
  const { ExistsChecker, hasStuckWorkers } = require('../lib/exists-check');
  const c = new ExistsChecker();
  try {
    c._ensure().postMessage = () => {};
    assert.strictEqual(await c.check(['x'], 100), null);
    assert.strictEqual(hasStuckWorkers(), true);
  } finally {
    c.close();
  }
  for (let i = 0; i < 50 && hasStuckWorkers(); i++) await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(hasStuckWorkers(), false, 'gone once it has really stopped');
});
