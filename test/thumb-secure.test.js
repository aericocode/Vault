/**
 * Thumbnail settings in a library with a password (the encrypted
 * secure-assets store). ffmpeg and ffprobe are fakes. Checks that:
 *  - "only while running" never writes to the store, the thumbnail folder or
 *    the temp folder, and the lock clears it;
 *  - "keep" stores covers encrypted as before;
 *  - deleting hover frames / all thumbnails removes only those kinds, never
 *    face crops or beat audio;
 *  - the disk limit trims the store least recently shown first;
 *  - the space numbers add up per kind.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-thumbsecure-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const secureAssets = require('../lib/secure-assets');
const thumbnails = require('../lib/thumbnails');
const ts = require('../lib/thumb-settings');

const ids = {};
const kinds = () => secureAssets.conn().prepare('SELECT media_id, kind FROM assets ORDER BY media_id, kind').all()
  .map(r => `${r.media_id}:${r.kind}`);
const filesIn = (d) => (fs.existsSync(d) ? fs.readdirSync(d).filter(n => !n.startsWith('.')) : []);

async function idle() {
  for (let i = 0; i < 200; i++) {
    const q = thumbnails._queueForTest();
    if (q.jobs.size === 0 && q.running === 0) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('queue never drained');
}

function setSettings(patch) {
  const prev = ts.get();
  const r = ts.update(patch);
  assert.ok(!r.error, r.error);
  thumbnails.settingsChanged(prev, r.value);
}

test.before(() => {
  db.init();
  secureAssets.init('thumb-test-pass');
  const ins = db.get().prepare('INSERT INTO media (filepath, filename, media_type, duration_seconds, art_stream) VALUES (?, ?, ?, 60, -1)');
  fs.mkdirSync(path.join(tmp, 'media'));
  for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) {
    const fp = path.join(tmp, 'media', n);
    fs.writeFileSync(fp, 'data');
    ids[n] = Number(ins.run(fp, n, 'video').lastInsertRowid);
  }
  thumbnails._setRenderer(async ({ kind, row, idx }) => Buffer.from(`secret ${kind} ${row.id} ${idx ?? ''}`));
  thumbnails._setArtProber(async () => -1);
});

test.after(() => {
  thumbnails._setRenderer();
  thumbnails._setArtProber();
  try { secureAssets.close(); } catch {}
  secureAssets.init(null);
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('only while running: nothing reaches the store or the disk, and locking clears it', async () => {
  assert.ok(secureAssets.enabled());
  setSettings({ make: 'shown', keep: 'memory' });
  const row = db.getById(ids['a.mp4']);
  assert.strictEqual(thumbnails.lookupThumb(row).type, 'pending');
  await idle();
  const hit = thumbnails.lookupThumb(row);
  assert.strictEqual(hit.type, 'buffer');
  assert.strictEqual(hit.buf.toString(), `secret thumb ${row.id} `);
  const s = await thumbnails.lookupScrub(row, 1);
  assert.strictEqual(s.type, 'buffer');
  assert.deepStrictEqual(kinds(), [], 'secure store untouched');
  assert.deepStrictEqual(filesIn(process.env.VAULT_THUMBS).filter(n => n.endsWith('.jpg')), []);
  assert.deepStrictEqual(filesIn(process.env.VAULT_TEMP).filter(n => n.endsWith('.jpg')), [], 'no temp copies either');
  assert.strictEqual(thumbnails.cacheControl({ query: {} }), 'no-store');

  thumbnails.clearMemory();   // what the server does on vault 'locking'
  assert.strictEqual(thumbnails._mem().size, 0);
  assert.strictEqual(thumbnails.lookupThumb(row).type, 'pending', 'made again after unlock');
  await idle();
});

test('keep: covers and frames are stored encrypted, as before', async () => {
  setSettings({ make: 'all', keep: 'keep' });
  const row = db.getById(ids['b.mp4']);
  assert.strictEqual(await thumbnails.ensureThumbnail(row), true);
  await thumbnails.lookupScrub(row, 0);
  await thumbnails.lookupScrub(row, 4);
  assert.deepStrictEqual(kinds(), [`${row.id}:scrub0`, `${row.id}:scrub4`, `${row.id}:thumb`]);
  assert.strictEqual(thumbnails.lookupThumb(db.getById(row.id)).buf.toString(), `secret thumb ${row.id} `);
});

test('space and delete: only thumbnail kinds go, face crops and beat audio stay', async () => {
  const id = ids['b.mp4'];
  secureAssets.put(id, 'face-12', Buffer.from('face'));
  secureAssets.put(id, 'beataudio_adts', Buffer.from('beat!'));
  secureAssets.put(id, 'subtitle', Buffer.from('WEBVTT'), 'en');
  const sp = await thumbnails.spaceUsed();
  assert.strictEqual(sp.encrypted, true);
  assert.strictEqual(sp.covers.count, 1);
  assert.strictEqual(sp.scrub.count, 2);
  assert.deepStrictEqual(sp.other, { bytes: 9, count: 2 });

  const s = await thumbnails.deleteStored('scrub');
  assert.strictEqual(s.count, 2);
  assert.deepStrictEqual(kinds(), [`${id}:beataudio_adts`, `${id}:face-12`, `${id}:subtitle`, `${id}:thumb`]);
  const a = await thumbnails.deleteStored('all');
  assert.strictEqual(a.count, 1);
  assert.deepStrictEqual(kinds(), [`${id}:beataudio_adts`, `${id}:face-12`, `${id}:subtitle`]);
  await assert.rejects(thumbnails.deleteStored('face-'), /scrub|all/);
});

test('disk limit: the encrypted store is trimmed least recently shown first', async () => {
  setSettings({ make: 'all' });
  for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) await thumbnails.ensureThumbnail(db.getById(ids[n]));
  const st = secureAssets.conn().prepare("UPDATE assets SET updated_at = ? WHERE media_id = ? AND kind = 'thumb'");
  st.run('2020-01-01 00:00:00', ids['b.mp4']);
  st.run('2021-01-01 00:00:00', ids['a.mp4']);
  setSettings({ make: 'shown', keep: 'cap' });
  thumbnails.clearMemory();
  const one = secureAssets.get(ids['c.mp4'], 'thumb').length;
  const realGet = ts.get;
  const cur = ts.get();
  // Room for two covers: the oldest (b) goes.
  ts.get = () => ({ ...cur, diskCapMB: (one * 2 + 0.5) / 0.95 / (1024 * 1024) });
  try {
    const r = await thumbnails.trimToCap({ max: Infinity });
    assert.strictEqual(r.removed, 1);
    assert.strictEqual(secureAssets.get(ids['b.mp4'], 'thumb'), null);
    assert.ok(secureAssets.get(ids['a.mp4'], 'thumb'));
    assert.ok(secureAssets.get(ids['b.mp4'], 'face-12'), 'other kinds of the same file stay');
  } finally {
    ts.get = realGet;
  }
});
