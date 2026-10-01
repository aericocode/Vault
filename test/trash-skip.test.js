/**
 * /api/trash, /api/untrash and /api/delete with the viewer queue's opt-in
 * flags (verifier round 4): a row that is no longer in the state the viewer's
 * confirm counted is reported as skipped and left alone, checked on the
 * server immediately before acting, whatever the viewer's cache said. Without
 * the flags the old behavior stays (a trashed row is deleted, file and all).
 *
 * Real files in a temp folder: these routes move and unlink them.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-trashskip-'));
const media = path.join(tmp, 'media');
fs.mkdirSync(media);
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_TRASH = path.join(tmp, 'trash');
process.env.VAULT_THUMBS = path.join(tmp, 'thumbs');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const { app } = require('../server/index');

let server;
let base;
const ids = {};
const file = (name) => path.join(media, name);

test.before(async () => {
  db.init();
  const ins = db.get().prepare("INSERT INTO media (filepath, filename, media_type, filesize_bytes) VALUES (?, ?, 'video', 4)");
  for (const name of ['r1.mp4', 'r2.mp4', 'r3.mp4', 'old.mp4', 'c.mp4']) {
    fs.writeFileSync(file(name), 'data');
    ids[name] = Number(ins.run(file(name), name).lastInsertRowid);
  }
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual(res.status, 200, p);
  return (await res.json()).results;
};

test('delete with skipTrashed keeps a file trashed after the confirm, and reports it skipped', async () => {
  // Another window trashes r2 after the viewer counted r1..r3 at its confirm.
  const [t] = await post('/api/trash', { ids: [ids['r2.mp4']] });
  assert.strictEqual(t.ok, true);
  const inTrash = db.getById(ids['r2.mp4']).filepath;
  assert.ok(fs.existsSync(inTrash));

  const results = await post('/api/delete', { ids: [ids['r1.mp4'], ids['r2.mp4'], ids['r3.mp4']], mode: 'hard', skipTrashed: true });
  assert.deepStrictEqual(results.map(r => [r.ok, r.skipped || null]), [[true, null], [false, 'in trash'], [true, null]]);
  assert.ok(!results[1].error, 'skipped, not failed');
  // r1 and r3 are gone, file and record; r2 is untouched, in the trash.
  assert.ok(!fs.existsSync(file('r1.mp4')) && !fs.existsSync(file('r3.mp4')));
  assert.strictEqual(db.getById(ids['r1.mp4']), undefined);
  assert.ok(fs.existsSync(inTrash), 'the trashed file is still in the trash');
  assert.strictEqual(db.getById(ids['r2.mp4']).user_trashed, 1);
});

test('without the flag a trashed row is deleted as before (file in the trash folder too)', async () => {
  const [t] = await post('/api/trash', { ids: [ids['old.mp4']] });
  assert.strictEqual(t.ok, true);
  const inTrash = db.getById(ids['old.mp4']).filepath;
  const [r] = await post('/api/delete', { ids: [ids['old.mp4']], mode: 'hard' });
  assert.strictEqual(r.ok, true);
  assert.ok(!fs.existsSync(inTrash));
  assert.strictEqual(db.getById(ids['old.mp4']), undefined);
});

test('trash and restore with skipUnchanged: already done elsewhere is skipped, not failed', async () => {
  const c = ids['c.mp4'];
  // Not in the trash: restore skips it (the old answer was an error).
  const [u1] = await post('/api/untrash', { ids: [c], skipUnchanged: true });
  assert.deepStrictEqual([u1.ok, u1.skipped, u1.error], [false, 'not in trash', undefined]);
  const [u0] = await post('/api/untrash', { ids: [c] });
  assert.deepStrictEqual([u0.ok, u0.error], [false, 'not in trash']);

  const [t1] = await post('/api/trash', { ids: [c], skipUnchanged: true });
  assert.strictEqual(t1.ok, true);
  const [t2] = await post('/api/trash', { ids: [c], skipUnchanged: true });
  assert.deepStrictEqual([t2.ok, t2.skipped, t2.error], [false, 'already in trash', undefined]);
  const [t0] = await post('/api/trash', { ids: [c] });
  assert.deepStrictEqual([t0.ok, t0.error], [false, 'already trashed']);
});
