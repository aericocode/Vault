/**
 * Thumbnail settings, verifier round 1 fixes:
 *  - nothing touches stored pictures while the vault is locked (trim, delete,
 *    store), the secure store does not reopen itself after close(), and the
 *    trim timers stop on lock;
 *  - a render cut short by a lock is not counted as the file failing;
 *  - deleting is asynchronous and batched (the event loop keeps turning);
 *  - in "When shown", a tile that asks again goes to the front of the queue;
 *  - hashing an encrypted library's cover never writes a temp file;
 *  - the size boxes' arrows step exactly, whatever the box displays.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-thumblock-'));
const thumbsDir = path.join(tmp, 'thumbs');
const tempDir = path.join(tmp, 'temp');
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = thumbsDir;
process.env.VAULT_TEMP = tempDir;
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const secureAssets = require('../lib/secure-assets');
const ownedDir = require('../lib/owned-dir');
const thumbnails = require('../lib/thumbnails');
const ts = require('../lib/thumb-settings');

const ids = [];
let locked = false;
let gate = null;                       // when set, renders wait on it

function setSettings(patch) {
  const prev = ts.get();
  const r = ts.update(patch);
  assert.ok(!r.error, r.error);
  thumbnails.settingsChanged(prev, r.value);
}

async function idle() {
  for (let i = 0; i < 300; i++) {
    const q = thumbnails._queueForTest();
    if (q.jobs.size === 0 && q.running === 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('queue never drained');
}

const covers = () => (fs.existsSync(thumbsDir) ? fs.readdirSync(thumbsDir).filter(n => /^\d+\.jpg$/.test(n)) : []);

test.before(() => {
  db.init();
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds, art_stream) VALUES (?, ?, ?, 60, -1)');
  fs.mkdirSync(path.join(tmp, 'media'));
  for (let i = 0; i < 12; i++) {
    const fp = path.join(tmp, 'media', `${i}.mp4`);
    fs.writeFileSync(fp, 'data');
    ids.push(Number(ins.run(fp, `${i}.mp4`, 'video').lastInsertRowid));
  }
  thumbnails.setLockProbe(() => locked);
  thumbnails._setRenderer(async ({ kind, row }) => {
    if (gate) await gate.promise;
    return Buffer.from(`${kind} ${row.id}`);
  });
  thumbnails._setArtProber(async () => -1);
});

test.after(() => {
  thumbnails._setRenderer();
  thumbnails._setArtProber();
  thumbnails.setLockProbe(null);
  try { secureAssets.close(); } catch {}
  secureAssets.init(null);
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function newGate() {
  let release;
  const promise = new Promise(r => { release = r; });
  gate = { promise, release: () => { gate = null; release(); } };
  return gate;
}

test('When shown: a tile that asks again is moved to the front of the queue', async () => {
  setSettings({ make: 'shown', keep: 'keep' });
  const order = [];
  thumbnails._setRenderer(async ({ row }) => { if (gate) await gate.promise; order.push(row.id); return Buffer.from(`t ${row.id}`); });
  const g = newGate();
  for (const id of ids.slice(0, 4)) thumbnails.enqueueThumbnail(db.getById(id));   // fill the 4 workers
  for (const id of ids.slice(4, 10)) thumbnails.enqueueThumbnail(db.getById(id));  // waiting: 4..9, newest last
  thumbnails.enqueueThumbnail(db.getById(ids[4]));                                  // the oldest one asks again
  g.release();
  await idle();
  assert.deepStrictEqual(order.slice(4, 6), [ids[4], ids[9]], 're-asked first, then newest first');
  thumbnails._setRenderer(async ({ kind, row }) => { if (gate) await gate.promise; return Buffer.from(`${kind} ${row.id}`); });
});

test('a render cut short by the vault locking is not counted against the file', async () => {
  const g = newGate();
  const id = ids[10];
  for (let k = 0; k < 3; k++) {
    const gg = k === 0 ? g : newGate();
    thumbnails.enqueueThumbnail(db.getById(id));
    await new Promise(r => setTimeout(r, 5));
    locked = true;
    thumbnails.clearMemory();          // what the server does on 'locking'
    gg.release();
    await idle();
    locked = false;
  }
  assert.strictEqual(thumbnails.isThumbSkipped(id), false, 'three locks, no strikes');
  assert.strictEqual(thumbnails.enqueueThumbnail(db.getById(id)), 'pending');
  await idle();
});

test('locked: nothing is stored, trimmed or deleted, and the trim timers stop', async () => {
  setSettings({ make: 'all' });
  for (const id of ids.slice(0, 6)) await thumbnails.ensureThumbnail(db.getById(id));
  const before = covers().length;
  assert.ok(before >= 6);
  setSettings({ make: 'shown', keep: 'cap' });
  locked = true;
  thumbnails.clearMemory();
  try {
    const realGet = ts.get;
    const cur = ts.get();
    ts.get = () => ({ ...cur, diskCapMB: 1 / (1024 * 1024) });   // far over the limit
    try {
      assert.deepStrictEqual(await thumbnails.trimToCap({ max: Infinity }), { removed: 0, bytes: 0 });
    } finally { ts.get = realGet; }
    await assert.rejects(thumbnails.deleteStored('all'), /locked/);
    await assert.rejects(thumbnails.spaceUsed(), /locked/);
    assert.strictEqual(await thumbnails.ensureThumbnail(db.getById(ids[11])), false);
    assert.strictEqual(covers().length, before, 'nothing removed or added while locked');
    const t = thumbnails._timersForTest();
    assert.deepStrictEqual(t, { trim: false, trimSoon: false, touch: false }, 'timers stopped on lock');
  } finally {
    locked = false;
  }
  thumbnails.onUnlock();
  assert.strictEqual(thumbnails._timersForTest().trim, true, 'unlock restarts the disk-limit trim');
  setSettings({ make: 'all', keep: 'keep' });
});

test('deleting is asynchronous and batched: the event loop keeps turning', async () => {
  ownedDir.ensureManaged(thumbsDir, 'thumbs');
  for (let i = 1; i <= 3000; i++) {
    fs.writeFileSync(path.join(thumbsDir, `${100000 + i}.jpg`), 'c');
    fs.writeFileSync(path.join(thumbsDir, `${100000 + i}_s0.jpg`), 's');
  }
  let ticks = 0;
  let sawProgress = false;
  const timer = setInterval(() => {
    ticks++;
    const p = thumbnails.deleteProgress();
    if (p && p.total > 0 && p.done > 0 && p.done < p.total) sawProgress = true;
  }, 0);
  const pending = thumbnails.deleteStored('all');
  let settled = false;
  pending.then(() => { settled = true; });
  await new Promise(r => setImmediate(r));
  assert.strictEqual(settled, false, 'returns before the files are gone');
  const r = await pending;
  clearInterval(timer);
  assert.ok(r.count >= 6000);
  assert.ok(ticks > 3, `other work ran during the delete (${ticks} timer ticks)`);
  assert.ok(sawProgress, 'progress was visible while it ran');
  assert.strictEqual(thumbnails.deleteProgress(), null, 'no progress once done');
  assert.deepStrictEqual(covers(), []);
});

test('encrypted library: the store stays shut after close(), until unlock', () => {
  secureAssets.init('lock-test-pass');
  try {
    secureAssets.put(ids[0], 'thumb', Buffer.from('secret'));
    secureAssets.close();
    assert.strictEqual(secureAssets.sealed(), true);
    assert.strictEqual(secureAssets.conn(), null, 'no silent reopen');
    assert.strictEqual(secureAssets.get(ids[0], 'thumb'), null);
    assert.strictEqual(secureAssets.put(ids[0], 'thumb', Buffer.from('x')), false, 'writes refused');
    assert.strictEqual(secureAssets.deleteKinds(['thumb']), 0);
    secureAssets.unlock('lock-test-pass');
    assert.strictEqual(secureAssets.sealed(), false);
    assert.strictEqual(secureAssets.get(ids[0], 'thumb').toString(), 'secret', 'nothing changed while shut');
  } finally {
    secureAssets.close();
    secureAssets.init(null);
  }
});

test('encrypted library: hashing a stored cover writes no temp file', async () => {
  secureAssets.init('lock-test-pass');
  try {
    const row = db.getById(ids[1]);
    secureAssets.put(row.id, 'thumb', Buffer.from('cover bytes'));
    const before = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
    const pic = await thumbnails.pictureForHash(row);
    assert.ok(Buffer.isBuffer(pic.buffer));
    assert.strictEqual(pic.buffer.toString(), 'cover bytes');
    assert.strictEqual(pic.path, undefined);
    assert.strictEqual(await thumbnails.getThumbnail(row), null, 'no decrypted path handed out');
    const after = fs.existsSync(tempDir) ? fs.readdirSync(tempDir) : [];
    assert.deepStrictEqual(after, before, 'temp folder untouched');
  } finally {
    secureAssets.close();
    secureAssets.init(null);
  }
});

test('size box arrows step exactly 100 MB / 1 GB from the true value', () => {
  const ctx = {
    console, Math, Number, String, JSON, Object, Array, RegExp, Promise, setTimeout, clearTimeout,
    document: { querySelector: () => null, getElementById: () => null, addEventListener: () => {} },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'thumb-settings-ui.js'), 'utf8'), ctx);
  const step = ctx.vaultThumbStepFrom;
  const fmt = ctx.vaultThumbFmtMB;
  // What used to drift: 1000 -> 1096 -> 1198 ...
  let mb = 1000;
  const seen = [];
  for (let i = 0; i < 6; i++) { mb = step(fmt(mb), mb, 'memoryMB', 1); seen.push(mb); }
  assert.deepStrictEqual(seen, [1100, 1200, 1300, 1400, 1500, 1600]);
  let disk = 2048;
  for (let i = 0; i < 3; i++) disk = step(fmt(disk), disk, 'diskCapMB', 1);
  assert.strictEqual(disk, 2048 + 3 * 1024);
  assert.strictEqual(step('450 MB', 300, 'memoryMB', 1), 550, 'a typed value is stepped from');
  assert.strictEqual(step(fmt(4096), 4096, 'memoryMB', 1), 4096, 'held at the top bound');
  assert.strictEqual(step(fmt(50), 50, 'memoryMB', -1), 50, 'held at the bottom bound');
});

function fillThumbs(from, n) {
  ownedDir.ensureManaged(thumbsDir, 'thumbs');
  for (let i = from; i < from + n; i++) {
    fs.writeFileSync(path.join(thumbsDir, `${i}.jpg`), 'c');
    fs.writeFileSync(path.join(thumbsDir, `${i}_s0.jpg`), 's');
  }
}

test('overlapping deletes: a second one joins or waits, nothing crashes or stops halfway', async () => {
  fillThumbs(200000, 2000);
  fs.writeFileSync(path.join(thumbsDir, '7_beataudio.aac'), 'beat');
  // all, then scrub while it runs: scrub is part of all, so it joins.
  const a = thumbnails.deleteStored('all');
  await new Promise(r => setImmediate(r));
  const s = thumbnails.deleteStored('scrub');
  const [ra, rs] = await Promise.all([a, s]);
  assert.strictEqual(rs, ra, 'joined the running delete');
  assert.deepStrictEqual(covers(), []);
  assert.ok(!fs.readdirSync(thumbsDir).some(n => /_s\d\.jpg$/.test(n)));
  assert.ok(fs.existsSync(path.join(thumbsDir, '7_beataudio.aac')), 'beat audio untouched');

  // scrub, then all while it runs: all waits for it, then runs in full.
  fillThumbs(300000, 1500);
  const order = [];
  const s2 = thumbnails.deleteStored('scrub').then(r => { order.push('scrub'); return r; });
  await new Promise(r => setImmediate(r));
  const a2 = thumbnails.deleteStored('all').then(r => { order.push('all'); return r; });
  const again = thumbnails.deleteStored('all');
  const [r2s, r2a, r2again] = await Promise.all([s2, a2, again]);
  assert.deepStrictEqual(order, ['scrub', 'all'], 'one after the other');
  assert.strictEqual(r2s.count, 1500);
  assert.strictEqual(r2a.count, 1500, 'the covers, once the frames were gone');
  assert.strictEqual(r2again, r2a, 'a third ask joins the queued one');
  assert.deepStrictEqual(covers(), []);
  assert.strictEqual(thumbnails.deleteProgress(), null);
});

test('encrypted library: overlapping deletes, and progress never passes 100%', async () => {
  secureAssets.init('lock-test-pass');
  try {
    for (let i = 0; i < 3000; i++) {
      secureAssets.put(500000 + i, 'thumb', Buffer.from('c'));
      secureAssets.put(500000 + i, 'scrub0', Buffer.from('s'));
    }
    secureAssets.put(500000, 'face-9', Buffer.from('face'));
    const samples = [];
    const timer = setInterval(() => { const p = thumbnails.deleteProgress(); if (p) samples.push(p); }, 0);
    const a = thumbnails.deleteStored('all');
    // A picture made while the delete runs adds a row it will also remove.
    await new Promise(r => setImmediate(r));
    secureAssets.put(600000, 'thumb', Buffer.from('late'));
    const s = thumbnails.deleteStored('scrub');
    const [ra, rs] = await Promise.all([a, s]);
    clearInterval(timer);
    assert.strictEqual(rs, ra);
    assert.ok(samples.length > 0, 'progress was visible');
    for (const p of samples) assert.ok(p.done <= p.total, `${p.done} of ${p.total}`);
    const left = secureAssets.conn().prepare('SELECT kind, COUNT(*) AS n FROM assets GROUP BY kind').all();
    assert.deepStrictEqual(left.map(r => r.kind), ['face-9'], 'only the face crop is left');
  } finally {
    secureAssets.close();
    secureAssets.init(null);
  }
});

