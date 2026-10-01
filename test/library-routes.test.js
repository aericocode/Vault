/**
 * /api/library/* over HTTP against the real Express app (server/index.js):
 * response shapes, the binary id list, 404 / 400 / 423, the 64 MB body limit
 * on the query route (and only there), and the old GET /api/media still
 * answering for the current viewer.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-routes-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const vault = require('../lib/vault');
const { app } = require('../server/index');

let server;
let base;
const ids = {};

test.before(async () => {
  db.init();
  const d = db.get();
  d.pragma('synchronous = OFF');
  const ins = d.prepare(`INSERT INTO media (filepath, filename, media_type, filesize_bytes, user_trashed, user_flagged_delete, processing_error, themes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [
    ['/r/a.mp4', 'a.mp4', 'video', 100, 0, 0, null, '["sea"]'],
    ['/r/b.mp4', 'b.mp4', 'video', 100, 0, 1, 'unscanned', '["sea", "sky"]'],
    ['/r/c.jpg', 'c.jpg', 'image', 5, 1, 0, 'boom', '[]'],
    ['/r/d.gif', 'd.gif', 'gif', 7, 0, 0, null, '["sky"]'],
    ['/r/e.pdf', 'e.pdf', 'document', 100, 0, 0, null, '[]'],
  ];
  for (const r of rows) ids[r[1]] = Number(ins.run(...r).lastInsertRowid);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = (p, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(base + p, { method: 'POST', headers, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) });

test('POST /api/library/query answers the first page and a qid', async () => {
  const res = await post('/api/library/query', { pageSize: 2, sort: { field: 'name', dir: 'asc' } });
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.deepStrictEqual(Object.keys(j).sort(), ['complete', 'page', 'qid', 'search', 'total', 'version']);
  assert.deepStrictEqual(j.page.ids, [ids['a.mp4'], ids['b.mp4']]);
  assert.strictEqual(j.page.rows[1].filename, 'b.mp4');
  assert.strictEqual(j.complete, false);
  assert.strictEqual(j.total, null);
  assert.deepStrictEqual(j.search, { mode: 'none', closeTerms: [], indexState: 'ready', indexProgress: null });
});

test('GET /api/library/query/:qid/ids is the binary layout from the spec', async () => {
  const j = await (await post('/api/library/query', { sort: { field: 'name', dir: 'asc' }, filters: { trashed: '' } })).json();
  const res = await fetch(`${base}/api/library/query/${j.qid}/ids`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'application/octet-stream');
  const buf = Buffer.from(await res.arrayBuffer());
  const n = buf.readUInt32LE(0);
  assert.strictEqual(n, 4);
  assert.strictEqual(res.headers.get('x-vault-total'), '4');
  assert.strictEqual(buf.readUInt32LE(4), j.version);
  assert.strictEqual(res.headers.get('x-vault-version'), String(j.version));
  const got = [0, 1, 2, 3].map(i => buf.readUInt32LE(8 + i * 4));
  assert.deepStrictEqual(got, [ids['a.mp4'], ids['b.mp4'], ids['c.jpg'], ids['d.gif']]);
  assert.deepStrictEqual([...buf.subarray(8 + n * 4)], [1, 1, 3, 4]);
});

test('an unknown or expired qid is 404 with an error', async () => {
  const res = await fetch(`${base}/api/library/query/nope/ids`);
  assert.strictEqual(res.status, 404);
  assert.ok((await res.json()).error);
});

test('bad bodies are 400 {error} naming the field; bad JSON too', async () => {
  let res = await post('/api/library/query', { sort: { field: 'color' } });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /sort\.field/);
  res = await post('/api/library/query', '{"search": ');
  assert.strictEqual(res.status, 400);
  assert.ok((await res.json()).error);
});

test('the query route takes big id lists; other routes keep the 2 MB limit', async () => {
  const many = Array.from({ length: 600000 }, (_, i) => i + 1);
  many.push(ids['c.jpg']);
  const body = JSON.stringify({ onlyIds: many, pageSize: 10 });
  assert.ok(body.length > 2 * 1024 * 1024);
  const res = await post('/api/library/query', body);
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.strictEqual(j.total, 5, 'every existing row is in the focus set, documents and trash included');

  const rows = await post('/api/media/rows', JSON.stringify({ ids: many }));
  assert.strictEqual(rows.status, 413, 'the app default still applies elsewhere');
});

test('version, facets, ids-summary and duplicates answer their shapes', async () => {
  const v = await (await fetch(`${base}/api/library/version`)).json();
  assert.strictEqual(typeof v.version, 'number');
  assert.deepStrictEqual(v.index, { state: 'ready', progress: null, step: null, steps: null });

  const f = await (await fetch(`${base}/api/library/facets`)).json();
  assert.strictEqual(f.total, 4);
  assert.deepStrictEqual(f.types, { video: 2, audio: 0, image: 1, gif: 1, mix: 0 });
  assert.deepStrictEqual(f.theme, { sea: 2, sky: 2 });
  assert.strictEqual(f.dupes, 2);
  assert.deepStrictEqual(f.scan, { success: 2, failed: 1, unscanned: 1 });
  assert.strictEqual(f.trashed, 1);
  assert.strictEqual(f.flagged, 1);
  assert.ok(f.extensions.some(e => e.type === 'document' && e.ext === 'pdf' && e.count === 1));
  assert.strictEqual(f.playbackGroups.reduce((n, g) => n + g.count, 0), 5);

  const u32 = Buffer.alloc(12);
  u32.writeUInt32LE(ids['a.mp4'], 0); u32.writeUInt32LE(ids['c.jpg'], 4); u32.writeUInt32LE(123456, 8);
  const s = await (await post('/api/library/ids-summary', u32, { 'Content-Type': 'application/octet-stream' })).json();
  assert.deepStrictEqual(s, { count: 2, trashed: 1, flagged: 0, scan: { success: 1, failed: 1, unscanned: 0 }, types: { video: 1, image: 1 } });
  // Big selections walk the sort index instead of looking rows up: same answer.
  const facetsLib = require('../lib/library-facets');
  facetsLib._tuning.summaryWalkMin = 0;
  try {
    const walked = await (await post('/api/library/ids-summary', u32, { 'Content-Type': 'application/octet-stream' })).json();
    assert.deepStrictEqual(walked, s);
  } finally {
    facetsLib._tuning.summaryWalkMin = 50000;
  }
  const odd = await post('/api/library/ids-summary', Buffer.alloc(3), { 'Content-Type': 'application/octet-stream' });
  assert.strictEqual(odd.status, 400);

  const dup = await (await fetch(`${base}/api/library/duplicates?offset=0&limit=10`)).json();
  assert.deepStrictEqual(dup, {
    totalGroups: 1, totalFiles: 2,
    groups: [{ media_type: 'video', filesize_bytes: 100, ids: [ids['a.mp4'], ids['b.mp4']] }],
  });
  assert.strictEqual((await fetch(`${base}/api/library/duplicates?limit=0`)).status, 400);
});

test('every library route is 423 while the vault is locked', async () => {
  vault.bootLocked();
  try {
    for (const [method, p] of [['POST', '/api/library/query'], ['GET', '/api/library/query/x/ids'],
      ['GET', '/api/library/facets'], ['GET', '/api/library/version'], ['POST', '/api/library/ids-summary'],
      ['GET', '/api/library/duplicates']]) {
      const res = method === 'POST' ? await post(p, {}) : await fetch(base + p);
      assert.strictEqual(res.status, 423, `${method} ${p}`);
    }
  } finally {
    vault._locked = false;
  }
});

test('the old viewer path still works: GET /api/media returns every row', async () => {
  const res = await fetch(`${base}/api/media`);
  assert.strictEqual(res.status, 200);
  const rows = await res.json();
  assert.strictEqual(rows.length, 5);
  assert.ok(!('ext' in rows[0]) && !('embedding' in rows[0]));
});

test('facets: one cached body with an ETag, theme top 1,000, and theme search', async () => {
  // 1,100 themes: "common" on 3 rows, "rare-0000".."rare-1098" on one row each.
  const d = db.get();
  const ins = d.prepare("INSERT INTO media (filepath, filename, media_type, themes) VALUES (?, ?, 'image', ?)");
  d.transaction(() => {
    for (let i = 0; i < 1099; i++) {
      const themes = [`rare-${String(i).padStart(4, '0')}`];
      if (i < 3) themes.push('common');
      ins.run(`/t/${i}.jpg`, `${i}.jpg`, JSON.stringify(themes));
    }
  })();
  require('../lib/library-facets').reset();   // else: the last counts, marked stale, for 15 s
  let res = await fetch(`${base}/api/library/facets`);
  const etag = res.headers.get('etag');
  const f = await res.json();
  assert.ok(etag);
  assert.strictEqual(f.themeTotal, 1099 + 3, 'sea, sky and common besides the rare ones');
  const keys = Object.keys(f.theme);
  assert.strictEqual(keys.length, 1000);
  assert.deepStrictEqual(keys.slice(0, 3), ['common', 'sea', 'sky'], 'by count, then A to Z');
  assert.strictEqual(keys[3], 'rare-0000');
  // Unchanged library: 304, and the same bytes again without If-None-Match.
  res = await fetch(`${base}/api/library/facets`, { headers: { 'If-None-Match': etag } });
  assert.strictEqual(res.status, 304);
  const again = await fetch(`${base}/api/library/facets`);
  assert.strictEqual(again.headers.get('etag'), etag);

  const t = await (await fetch(`${base}/api/library/themes?q=RARE-109&limit=5`)).json();
  assert.deepStrictEqual(t.themes.map(x => x.value), ['rare-1090', 'rare-1091', 'rare-1092', 'rare-1093', 'rare-1094']);
  assert.strictEqual(t.themes[0].count, 1);
  const all = await (await fetch(`${base}/api/library/themes`)).json();
  assert.deepStrictEqual(all.themes.slice(0, 2), [{ value: 'common', count: 3 }, { value: 'sea', count: 2 }]);
  assert.strictEqual(all.themes.length, 50);
  assert.strictEqual((await fetch(`${base}/api/library/themes?limit=501`)).status, 400);
});

test('theme search waits while the search index builds', async () => {
  const libraryIndex = require('../lib/library-index');
  libraryIndex.setMeta(db.get(), 'search_built', 0);
  require('../lib/library-facets').reset();
  try {
    const t = await (await fetch(`${base}/api/library/themes?q=sea`)).json();
    assert.deepStrictEqual(t, { themes: null, indexState: 'building' });
    const f = await (await fetch(`${base}/api/library/facets`)).json();
    assert.strictEqual(f.theme, null);
    assert.strictEqual(f.themeTotal, null);
  } finally {
    libraryIndex.setMeta(db.get(), 'search_built', 1);
    require('../lib/library-facets').reset();
  }
});

test('after an unlock the index step runs after the response, reporting preparing (R3-1)', async () => {
  const libraryRoutes = require('../server/library-routes');
  const listeners = [];
  const fakeVault = { onChange: (cb) => listeners.push(cb), isLocked: () => false };
  libraryRoutes.startIndexing(fakeVault, { log: () => {} });
  db.get().exec('DROP INDEX idx_media_sort_views; DROP INDEX idx_media_sort_rating; DROP INDEX idx_media_ext_type');
  const t0 = Date.now();
  for (const cb of listeners) cb('unlocked');          // what vault.unlock() does, inside the request
  assert.ok(Date.now() - t0 < 50, 'the unlock handler returns at once');
  assert.strictEqual(require('../lib/library-index').missingIndexes(db.get()).length, 3, 'nothing built inside it');
  // 'preparing' from the moment it is scheduled, never 'building' first (round 4).
  const s0 = require('../lib/library-index').status(db.get());
  assert.deepStrictEqual([s0.state, s0.step, s0.steps], ['preparing', 0, 3]);
  const first = await (await fetch(`${base}/api/library/version`)).json();
  assert.strictEqual(first.index.state, 'preparing');
  assert.ok(first.index.step <= 1 && first.index.steps === 3, JSON.stringify(first.index));
  const states = new Set();
  for (let i = 0; i < 400; i++) {
    const v = await (await fetch(`${base}/api/library/version`)).json();
    states.add(v.index.state === 'preparing' ? `preparing ${v.index.step}/${v.index.steps}` : v.index.state);
    if (v.index.state === 'ready' && states.size > 1) break;
    // Library routes keep answering while preparing.
    if (v.index.state === 'preparing') {
      const q = await (await fetch(`${base}/api/library/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ search: { text: 'a' } }) })).json();
      assert.strictEqual(q.search.indexState, 'building');
      assert.deepStrictEqual(q.page.ids, []);
    }
    await new Promise(r => setTimeout(r, 5));
  }
  assert.ok([...states].some(s => s.startsWith('preparing')), [...states].join(', '));
  assert.ok(states.has('ready'));
  assert.deepStrictEqual(require('../lib/library-index').missingIndexes(db.get()), []);
});
