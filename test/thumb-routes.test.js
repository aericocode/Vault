/**
 * Thumbnail settings end to end through the real routes (plain library), with
 * ffmpeg and ffprobe swapped for fakes so the test needs neither:
 *  - /thumb and /scrub per mode (Off, For every file, When shown: keep, disk
 *    limit, only while running), hover frames off, pictures inside files;
 *  - the scan path (ensureThumbnail) making nothing in When shown and Off;
 *  - the delete routes touching only {id}.jpg / {id}_s{n}.jpg, never face
 *    crops, beat audio, other files or media;
 *  - the memory cache being dropped on lock, and the new routes behind the
 *    lock gate.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-thumbroutes-'));
const media = path.join(tmp, 'media');
const thumbsDir = path.join(tmp, 'thumbs');
fs.mkdirSync(media);
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TRASH = path.join(tmp, 'trash');
process.env.VAULT_THUMBS = thumbsDir;
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const ownedDir = require('../lib/owned-dir');
const thumbnails = require('../lib/thumbnails');
const ts = require('../lib/thumb-settings');
const vault = require('../lib/vault');
const { app } = require('../server/index');

let server;
let base;
const ids = {};
const renders = [];
let artProbes = 0;

const file = (name) => path.join(media, name);
const thumbFiles = () => (fs.existsSync(thumbsDir) ? fs.readdirSync(thumbsDir).filter(n => /\.jpg$/.test(n)).sort() : []);

test.before(async () => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds, filesize_bytes) VALUES (?, ?, ?, ?, 4)');
  for (const [name, type, dur] of [
    ['a.mp4', 'video', 60], ['b.mp4', 'video', 60], ['c.jpg', 'image', 0], ['d.mp4', 'video', 60],
    ['song.mp3', 'audio', 200], ['plain.mp3', 'audio', 200], ['cover.mp4', 'video', 60], ['e.mp4', 'video', 60],
  ]) {
    fs.writeFileSync(file(name), 'data');
    ids[name] = Number(ins.run(file(name), name, type, dur).lastInsertRowid);
  }
  thumbnails._setRenderer(async ({ kind, row, idx }) => {
    renders.push(`${kind}:${row.id}${idx != null ? `:${idx}` : ''}`);
    return Buffer.from(`jpeg ${kind} ${row.id} ${idx ?? ''}`);
  });
  thumbnails._setArtProber(async (row) => {
    artProbes++;
    return row.filename === 'song.mp3' || row.filename === 'cover.mp4' ? 1 : -1;
  });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  thumbnails._setRenderer();
  thumbnails._setArtProber();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

/** Store settings straight away (bypassing the route's 3 s read cache). */
async function settings(patch) {
  const res = await fetch(`${base}/api/settings/thumbnails`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  });
  const body = await res.json();
  assert.strictEqual(res.status, 200, JSON.stringify(body));
  return body;
}

async function idle() {
  for (let i = 0; i < 200; i++) {
    const q = thumbnails._queueForTest();
    if (q.jobs.size === 0 && q.running === 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('queue never drained');
}

const get = (p) => fetch(base + p);

test('Off: /thumb answers off without queueing, /scrub answers none, the scan makes nothing', async () => {
  await settings({ make: 'off' });
  const before = renders.length;
  const r = await get(`/thumb/${ids['a.mp4']}`);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.headers.get('x-thumb'), 'off');
  assert.strictEqual(thumbnails._queueForTest().jobs.size, 0, 'nothing queued');
  const s = await get(`/scrub/${ids['a.mp4']}/0`);
  assert.strictEqual(s.status, 404);
  assert.strictEqual(s.headers.get('x-thumb'), 'none');
  assert.strictEqual(await thumbnails.ensureThumbnail(db.getById(ids['a.mp4'])), false);
  assert.strictEqual(thumbnails.enqueueThumbnail(db.getById(ids['a.mp4'])), 'skipped');
  assert.strictEqual(renders.length, before, 'no ffmpeg run');
  assert.deepStrictEqual(thumbFiles(), []);
});

test('When shown: the scan and import paths make nothing', async () => {
  await settings({ make: 'shown', keep: 'keep' });
  assert.strictEqual(await thumbnails.ensureThumbnail(db.getById(ids['b.mp4'])), false);
  assert.deepStrictEqual(thumbFiles(), []);
});

test('For every file: the scan makes the cover and stores it as today', async () => {
  await settings({ make: 'all' });
  assert.strictEqual(await thumbnails.ensureThumbnail(db.getById(ids['b.mp4'])), true);
  assert.deepStrictEqual(thumbFiles(), [`${ids['b.mp4']}.jpg`]);
  const row = db.getById(ids['b.mp4']);
  assert.strictEqual(row.thumbnail_path, path.join(thumbsDir, `${ids['b.mp4']}.jpg`));
  const r = await get(`/thumb/${ids['b.mp4']}?v=${row.thumb_version}`);
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
});

test('For every file: a file with a picture inside gets nothing made, and shows that picture', async () => {
  const id = ids['cover.mp4'];
  db.saveStreamInfo(id, { duration: 60, width: 640, height: 360, art_stream: 1 });
  assert.strictEqual(db.getById(id).art_stream, 1);
  const n = renders.length;
  assert.strictEqual(await thumbnails.ensureThumbnail(db.getById(id)), true);
  assert.strictEqual(renders.length, n, 'no frame made');
  const first = await get(`/thumb/${id}`);
  assert.strictEqual(first.headers.get('x-thumb'), 'pending');
  await idle();
  const r = await get(`/thumb/${id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), `jpeg art ${id} 1`);
  assert.ok(!thumbFiles().includes(`${id}.jpg`), 'art is never stored');
});

test('audio with album art shows it; audio without stays an icon (missing)', async () => {
  const song = ids['song.mp3'];
  assert.strictEqual((await get(`/thumb/${song}`)).headers.get('x-thumb'), 'pending');
  await idle();
  assert.strictEqual(db.getById(song).art_stream, 1, 'the check is remembered');
  const r = await get(`/thumb/${song}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), `jpeg art ${song} 1`);

  const plain = ids['plain.mp3'];
  await get(`/thumb/${plain}`);
  await idle();
  assert.strictEqual(db.getById(plain).art_stream, -1);
  const m = await get(`/thumb/${plain}`);
  assert.strictEqual(m.headers.get('x-thumb'), 'missing');
});

test('inside pictures off: audio is not looked at, video art is not used', async () => {
  await settings({ inside: false });
  const probes = artProbes;
  const r = await get(`/thumb/${ids['song.mp3']}`);
  assert.strictEqual(r.headers.get('x-thumb'), 'missing');
  assert.strictEqual(artProbes, probes);
  await settings({ inside: true });
});

test('hover frames off: /scrub answers none and nothing is made, in any mode', async () => {
  await settings({ make: 'all', hover: false });
  const n = renders.length;
  const r = await get(`/scrub/${ids['a.mp4']}/2`);
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.headers.get('x-thumb'), 'none');
  assert.strictEqual(renders.length, n);
  assert.ok(!thumbFiles().some(f => /_s\d\.jpg$/.test(f)));
  await settings({ hover: true });
  const on = await get(`/scrub/${ids['a.mp4']}/2`);
  assert.strictEqual(on.status, 200);
  assert.ok(thumbFiles().includes(`${ids['a.mp4']}_s2.jpg`), 'hover on: stored as today');
});

test('When shown, only while running: made on request, held in memory, never on disk', async () => {
  await settings({ make: 'shown', keep: 'memory' });
  const id = ids['d.mp4'];
  const before = thumbFiles();
  const p = await get(`/thumb/${id}`);
  assert.strictEqual(p.headers.get('x-thumb'), 'pending');
  await idle();
  const r = await get(`/thumb/${id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store', 'not even the browser keeps it');
  const s = await get(`/scrub/${id}/0`);
  assert.strictEqual(s.status, 200);
  assert.deepStrictEqual(thumbFiles(), before, 'no file written');
  assert.ok(thumbnails._mem().has(`${id}:thumb`) && thumbnails._mem().has(`${id}:s0`));

  // A stored cover from before still answers (read only).
  const b = await get(`/thumb/${ids['b.mp4']}`);
  assert.strictEqual(b.status, 200);
});

test('locking the vault drops the memory cache and the queue', async () => {
  assert.ok(thumbnails._mem().size > 0);
  vault._notify('locking');
  assert.strictEqual(thumbnails._mem().size, 0);
  assert.strictEqual(thumbnails._queueForTest().jobs.size, 0);
});

test('the new routes are behind the lock gate', async () => {
  vault._locked = true;
  try {
    for (const p of ['/api/settings/thumbnails', '/api/thumbnails/space']) {
      assert.strictEqual((await get(p)).status, 423, p);
    }
    const d = await fetch(`${base}/api/thumbnails/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"what":"all"}' });
    assert.strictEqual(d.status, 423);
  } finally {
    vault._locked = false;
  }
});

test('When shown: a tile that stopped asking is dropped from the queue', async () => {
  await settings({ make: 'shown', keep: 'keep' });
  const q = thumbnails._queueForTest();
  let release;
  const gate = new Promise(r => { release = r; });
  // Hold the four workers busy so e.mp4 waits.
  thumbnails._setRenderer(async ({ kind, row }) => { await gate; return Buffer.from(`${kind} ${row.id}`); });
  const busy = ['a.mp4', 'c.jpg', 'd.mp4', 'cover.mp4'];
  db.get().prepare('UPDATE media SET art_stream = -1 WHERE id = ?').run(ids['cover.mp4']);
  for (const n of busy) thumbnails.enqueueThumbnail(db.getById(ids[n]));
  thumbnails.enqueueThumbnail(db.getById(ids['e.mp4']));
  const job = q.jobs.get(ids['e.mp4']);
  assert.ok(job && !job.running);
  job.wanted = Date.now() - 60000;       // last asked a minute ago: scrolled away
  release();
  await idle();
  assert.ok(!thumbFiles().includes(`${ids['e.mp4']}.jpg`), 'never made');
  thumbnails._setRenderer(async ({ kind, row, idx }) => {
    renders.push(`${kind}:${row.id}`);
    return Buffer.from(`jpeg ${kind} ${row.id} ${idx ?? ''}`);
  });
});

test('disk limit: least recently shown removed first, what is on screen kept', async () => {
  await settings({ make: 'shown', keep: 'cap' });
  for (const n of ['a.mp4', 'c.jpg', 'e.mp4']) thumbnails.enqueueThumbnail(db.getById(ids[n]));
  await idle();
  const ago = (h) => new Date(Date.now() - h * 3600_000);
  const at = (n, d) => fs.utimesSync(path.join(thumbsDir, n), d, d);
  at(`${ids['a.mp4']}.jpg`, ago(3));
  at(`${ids['a.mp4']}_s2.jpg`, ago(3));
  at(`${ids['c.jpg']}.jpg`, ago(2));
  at(`${ids['b.mp4']}.jpg`, ago(1));
  thumbnails.clearMemory();                 // the ledger is measured again from disk
  const size = (n) => fs.statSync(path.join(thumbsDir, n)).size;
  // The limit fits everything except a.mp4's and c.jpg's pictures.
  const gone = [`${ids['a.mp4']}.jpg`, `${ids['a.mp4']}_s2.jpg`, `${ids['c.jpg']}.jpg`];
  const keepBytes = thumbFiles().filter(n => !gone.includes(n)).reduce((t, n) => t + size(n), 0);
  const realGet = ts.get;
  const cur = ts.get();
  ts.get = () => ({ ...cur, diskCapMB: (keepBytes + 0.5) / 0.95 / (1024 * 1024) });
  try {
    const est = await thumbnails.trimEstimate();
    const r = await thumbnails.trimToCap({ max: Infinity });
    assert.strictEqual(r.removed, 2);
    assert.deepStrictEqual([est.count, est.bytes], [r.removed, r.bytes], 'the dialog names exactly what Remove takes');
    const left = thumbFiles();
    assert.ok(!left.includes(`${ids['a.mp4']}.jpg`) && !left.includes(`${ids['a.mp4']}_s2.jpg`), 'oldest went first, its frames with it');
    assert.ok(!left.includes(`${ids['c.jpg']}.jpg`), 'next oldest');
    assert.ok(left.includes(`${ids['b.mp4']}.jpg`), 'shown more recently: kept');
    assert.ok(left.includes(`${ids['e.mp4']}.jpg`), 'just made (on screen): kept');
    // Over the limit with only on-screen pictures left: nothing more goes.
    ts.get = () => ({ ...cur, diskCapMB: 1 / (1024 * 1024) });
    await thumbnails.trimToCap({ max: Infinity });
    assert.ok(thumbFiles().includes(`${ids['e.mp4']}.jpg`), 'never below what is on screen');
  } finally {
    ts.get = realGet;
  }
});

test('delete routes touch only thumbnail files, never face crops, beat audio or media', async () => {
  await settings({ make: 'all', keep: 'keep' });
  ownedDir.ensureManaged(thumbsDir, 'thumbs');
  fs.mkdirSync(path.join(thumbsDir, 'faces'), { recursive: true });
  const keep = {
    face: path.join(thumbsDir, 'faces', '7.jpg'),
    beat: path.join(thumbsDir, '5_beataudio.aac'),
    other: path.join(thumbsDir, 'notes.jpg.txt'),
    trick: path.join(thumbsDir, '12.jpg.bak'),
    neg: path.join(thumbsDir, '-3.jpg'),
    big: path.join(thumbsDir, '9_s7.jpg'),
  };
  for (const p of Object.values(keep)) fs.writeFileSync(p, 'keep me');
  fs.writeFileSync(path.join(thumbsDir, '901.jpg'), 'cover');
  fs.writeFileSync(path.join(thumbsDir, '901_s0.jpg'), 'frame');
  fs.writeFileSync(path.join(thumbsDir, '902_s4.jpg'), 'frame');

  const sp = await (await get('/api/thumbnails/space')).json();
  assert.ok(sp.covers.count >= 1 && sp.scrub.count >= 2);
  assert.strictEqual(sp.other.count, 2, 'face crop + beat audio counted as Other');

  const bad = await fetch(`${base}/api/thumbnails/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"what":"../media"}' });
  assert.strictEqual(bad.status, 400);

  const del = async (what) => (await fetch(`${base}/api/thumbnails/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what }),
  })).json();
  const s = await del('scrub');
  assert.ok(s.count >= 2);
  assert.ok(!thumbFiles().some(f => /^\d+_s[0-4]\.jpg$/.test(f)), 'hover frames gone');
  assert.ok(fs.existsSync(path.join(thumbsDir, '901.jpg')), 'covers kept on "hover frames"');

  await del('all');
  assert.ok(!thumbFiles().some(f => /^\d+\.jpg$/.test(f)), 'covers gone');
  for (const [k, p] of Object.entries(keep)) assert.ok(fs.existsSync(p), `${k} untouched`);
  for (const n of Object.keys(ids)) assert.ok(fs.existsSync(file(n)), `media ${n} untouched`);
  assert.strictEqual(db.getById(ids['b.mp4']).thumbnail_path, null, 'stored paths forgotten');
});

test('settings route refuses out-of-range sizes with the range in words', async () => {
  const res = await fetch(`${base}/api/settings/thumbnails`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memoryMB: 1 }),
  });
  assert.strictEqual(res.status, 400);
  assert.match((await res.json()).error, /50 MB to 4 GB/);
});
