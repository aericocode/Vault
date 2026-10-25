/**
 * Thumbnail settings, final verifier round:
 *  - the panel keeps the server's URL salt when it adopts new settings;
 *  - a disk ledger build that was in flight when the ledger was thrown away
 *    (lock, settings change, a delete) is never installed or handed out;
 *  - the encrypted store's size totals are read in slices with yields, give
 *    the same answer (bytes and "last shown") as the one-statement versions,
 *    and the store builds its size index after the open instead of inside it.
 */

require('./helpers/no-real-lm');   // never the user's own LM Studio
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-thumbscale-'));
const thumbsDir = path.join(tmp, 'thumbs');
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
process.env.VAULT_THUMBS = thumbsDir;
process.env.VAULT_TEMP = path.join(tmp, 'temp');
process.env.VAULT_SECURE_ASSETS = path.join(tmp, 'secure_assets.db');
process.env.VAULT_OFFLINE = '1';
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const secureAssets = require('../lib/secure-assets');
const ownedDir = require('../lib/owned-dir');
const thumbnails = require('../lib/thumbnails');
const ts = require('../lib/thumb-settings');

test.before(() => { db.init(); });
test.after(() => {
  try { secureAssets.close(); } catch {}
  secureAssets.init(null);
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function setSettings(patch) {
  const prev = ts.get();
  const r = ts.update(patch);
  assert.ok(!r.error, r.error);
  thumbnails.settingsChanged(prev, r.value);
}

test('the panel passes the server salt on to thumbs.js', () => {
  let got = null;
  const ctx = {
    console, Math, Number, String, JSON, Object, Array, RegExp, Promise, setTimeout, clearTimeout,
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {} },
    vaultSetThumbSettings: (cfg) => { got = cfg; },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'player-lib', 'thumb-settings-ui.js'), 'utf8'), ctx);
  ctx.vaultThumbAdopt({ make: 'shown', keep: 'cap', diskCapMB: 2048, memoryMB: 300, hover: true, inside: true, salt: 7 });
  assert.strictEqual(got.salt, 7);
  assert.strictEqual(got.keep, 'cap');
});

test('a ledger build in flight when the ledger is reset is not handed out', async () => {
  ownedDir.ensureManaged(thumbsDir, 'thumbs');
  const old = new Date(Date.now() - 3600e3);
  for (let i = 0; i < 6; i++) {
    const f = path.join(thumbsDir, `${700 + i}.jpg`);
    fs.writeFileSync(f, Buffer.alloc(40 * 1024, 1));
    fs.utimesSync(f, old, old);
  }
  setSettings({ make: 'shown', keep: 'cap', diskCapMB: 100 });
  const realGet = ts.get;
  const cur = ts.get();
  ts.get = () => ({ ...cur, diskCapMB: (100 * 1024) / (1024 * 1024) });   // 100 KB: some must go
  const rd = fs.promises.readdir;
  fs.promises.readdir = async (...a) => { await new Promise(r => setTimeout(r, 100)); return rd(...a); };
  try {
    thumbnails._ensureLedger();           // a tile was shown: a build starts
    thumbnails.clearMemory();             // the vault locks and unlocks meanwhile
    const est = await thumbnails.trimEstimate();
    assert.ok(est.count >= 3 && est.bytes > 0, `measured again, not a stale null (${JSON.stringify(est)})`);

    // A build in flight when a delete starts must not survive it.
    thumbnails.clearMemory();
    const building = thumbnails._ensureLedger();
    const del = thumbnails.deleteStored('all');
    assert.strictEqual(await building, null, 'the stale build is not handed out during the delete');
    await del;
    assert.deepStrictEqual(await thumbnails.trimEstimate(), { bytes: 0, count: 0 }, 'nothing counted that the delete removed');
    const led = await thumbnails._ensureLedger();
    assert.strictEqual(led.total, 0);
  } finally {
    fs.promises.readdir = rd;
    ts.get = realGet;
    setSettings({ make: 'all', keep: 'keep' });
  }
});

test('encrypted store: size totals in slices match the one-statement totals and yield', async () => {
  secureAssets.init('scale-test-pass');
  try {
    const c = secureAssets.conn();
    const st = c.prepare("INSERT INTO assets (media_id, kind, lang, data, size, updated_at) VALUES (?, ?, '', ?, ?, ?)");
    const b = (n) => Buffer.alloc(n, 1);
    // Spread "last shown" over the rows, newest on a frame for some ids, so the
    // per-id newest time comes from more than one kind.
    const when = (i, k) => new Date(Date.UTC(2024, 0, 1) + ((i * 7 + k * 3600) % 86400) * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    c.transaction(() => {
      for (let i = 1; i <= 12000; i++) {
        st.run(i, 'thumb', b(10), 10, when(i, 0));
        st.run(i, 'scrub0', b(20), 20, when(i, 1));
        if (i % 3 === 0) st.run(i, 'scrub4', b(5), 5, when(i, 2));
      }
      st.run(5, 'face-1', b(7), 7, when(5, 3));
    })();
    let ticks = 0;
    const iv = setInterval(() => { ticks++; }, 0);
    const kinds = await secureAssets.sizesByKindAsync();
    const sizes = await secureAssets.mediaSizesAsync(thumbnails.THUMB_KINDS);
    clearInterval(iv);
    const norm = (rows) => JSON.stringify(rows.map(r => [r.kind, r.bytes, r.count]).sort());
    assert.strictEqual(norm(kinds), norm(secureAssets.sizesByKind()));
    assert.deepStrictEqual(Object.fromEntries(kinds.map(k => [k.kind, k.bytes])),
      { thumb: 120000, scrub0: 240000, scrub4: 20000, 'face-1': 7 });
    const sync = new Map(secureAssets.mediaSizes(thumbnails.THUMB_KINDS).map(r => [r.media_id, r]));
    assert.strictEqual(sizes.length, sync.size);
    for (const r of sizes) {
      assert.strictEqual(r.bytes, sync.get(r.media_id).bytes, `media ${r.media_id}`);
      assert.strictEqual(r.seen, sync.get(r.media_id).seen, `media ${r.media_id} last shown`);
    }
    // Same "last shown" as the newest updated_at over the id's kinds.
    const want = Math.max(Date.parse(when(3, 0) + 'Z'), Date.parse(when(3, 1) + 'Z'), Date.parse(when(3, 2) + 'Z'));
    assert.strictEqual(sizes.find(r => r.media_id === 3).seen, want);
    assert.ok(ticks >= 3, `other work ran between slices (${ticks})`);

    // Locked part way: the walk stops with null instead of reopening the store.
    const p = secureAssets.mediaSizesAsync(thumbnails.THUMB_KINDS);
    secureAssets.close();
    assert.strictEqual(await p, null);
    secureAssets.unlock('scale-test-pass');
  } finally {
    secureAssets.close();
    secureAssets.init(null);
  }
});

test('encrypted store: the size index is built after the open, and the totals wait for it', async () => {
  secureAssets.init('scale-test-pass');
  try {
    const c = secureAssets.conn();
    await secureAssets.whenIndexed();
    c.exec('DROP INDEX IF EXISTS assets_kind_media_len');
    secureAssets._setIndexDelayMs(30);
    secureAssets.close();
    secureAssets.unlock('scale-test-pass');
    const has = () => !!secureAssets.conn().prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'assets_kind_media_len'").get();
    assert.strictEqual(has(), false, 'not built inside the open');
    const kinds = await secureAssets.sizesByKindAsync();
    assert.ok(has(), 'built just after');
    assert.strictEqual(kinds.find(k => k.kind === 'thumb').count, 12000);
  } finally {
    secureAssets._setIndexDelayMs(1000);
    secureAssets.close();
    secureAssets.init(null);
  }
});
