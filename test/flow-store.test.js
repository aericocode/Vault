/**
 * Flow's stored measurements (lib/flow/store.js) on a bare database: the
 * envelope column added to an older media_flow table, how the envelope is
 * stored (compact JSON pairs) and read back (FlowOrder.parseEnv), and rows
 * from the previous method (version 2: no envelope) used meanwhile as stale
 * and measured again.
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

const store = require('../lib/flow/store');
const analyze = require('../lib/flow/analyze');
const FlowOrder = require('../player-lib/flow-order.js');

const SRC = store.srcOf({ filesize_bytes: 1000, file_mtime_ms: 5 });

/** A database as version 2 left it: media_flow without env. */
function oldDb() {
  const d = new Database(':memory:');
  d.exec(`CREATE TABLE media (id INTEGER PRIMARY KEY, media_type TEXT, user_trashed INTEGER DEFAULT 0, filesize_bytes INTEGER, file_mtime_ms INTEGER);
    CREATE TABLE media_flow (media_id INTEGER PRIMARY KEY, version INTEGER NOT NULL, src TEXT, lufs REAL, peak_db REAL,
      has_music INTEGER NOT NULL DEFAULT 0, no_audio INTEGER NOT NULL DEFAULT 0, bpm_start REAL, bpm_mid REAL, bpm_end REAL,
      bpm_conf REAL, e_start REAL, e_mid REAL, e_end REAL, measured_at INTEGER, ms INTEGER, error TEXT);`);
  const m = d.prepare("INSERT INTO media (id, media_type, filesize_bytes, file_mtime_ms) VALUES (?, 'audio', 1000, 5)");
  for (const id of [1, 2, 3, 4, 5]) m.run(id);
  const f = d.prepare(`INSERT INTO media_flow (media_id, version, src, lufs, has_music, bpm_start, bpm_mid, bpm_end, e_start, e_mid, e_end, error)
    VALUES (?, ?, ?, -14, 1, 120, 120, 120, 0.4, 0.5, 0.6, ?)`);
  f.run(1, 2, SRC, null);                 // the previous method: used meanwhile
  f.run(2, 2, SRC, 'ffmpeg failed');      // the previous method, failed: asked again
  f.run(3, 1, SRC, null);                 // older still: not used
  f.run(4, 2, 'other:src', null);         // the file changed since: not used
  return d;
}

test('an older media_flow gets the env column; its rows survive', () => {
  const d = oldDb();
  store.ensureSchema(d);
  const cols = d.prepare('PRAGMA table_info(media_flow)').all().map(c => c.name);
  assert.ok(cols.includes('env'));
  assert.strictEqual(d.prepare('SELECT COUNT(*) AS n FROM media_flow').get().n, 4);
  store.ensureSchema(d);                  // twice is harmless
  assert.strictEqual(d.prepare('PRAGMA table_info(media_flow)').all().filter(c => c.name === 'env').length, 1);
});

test('a version 2 row is used meanwhile (stale, no envelope); failed, older or changed ones are not', () => {
  assert.strictEqual(analyze.VERSION, 3);
  assert.strictEqual(analyze.MIN_VERSION, 2);
  const d = oldDb();
  store.ensureSchema(d);
  const rows = store.currentFor(d, [1, 2, 3, 4, 5]);
  assert.deepStrictEqual([...rows.keys()], [1]);
  assert.strictEqual(rows.get(1).stale, 1);
  const f = FlowOrder.fromRow(1, rows.get(1));
  assert.strictEqual(f.measured, true);
  assert.strictEqual(f.env, undefined, 'drawn from start, middle and end until measured again');
  assert.deepStrictEqual([f.es, f.em, f.ee], [0.4, 0.5, 0.6]);
  // The library pass measures every one of them again (5 has no row at all).
  assert.deepStrictEqual(store.sweepBatch(d, 0).ids, [1, 2, 3, 4, 5]);
});

test('the envelope is stored as compact JSON pairs and read back rounded; a new save is current', () => {
  const d = oldDb();
  store.ensureSchema(d);
  const env = [[0.05, 0.71234], [0.15, 0.7], [0.5, 0.8], [0.95, 1.2]];
  store.save(d, 1, SRC, { lufs: -14, has_music: 1, e_start: 0.7, e_mid: 0.8, e_end: 0.9, env });
  const raw = d.prepare('SELECT env, version FROM media_flow WHERE media_id = 1').get();
  assert.strictEqual(raw.version, 3);
  assert.strictEqual(raw.env, '[[0.05,0.712],[0.15,0.7],[0.5,0.8],[0.95,1]]');
  const row = store.get(d, 1);
  assert.strictEqual(row.stale, 0);
  assert.deepStrictEqual(FlowOrder.fromRow(1, row).env, [[0.05, 0.71], [0.15, 0.7], [0.5, 0.8], [0.95, 1]]);
  // No envelope (a very short file), a malformed one, an error: NULL.
  for (const e of [null, undefined, [[0.1, 0.2]], [[0.1, 'x'], [0.2, 0.3]], 'not json']) {
    store.save(d, 5, SRC, { lufs: -14, e_mid: 0.5, env: e });
    assert.strictEqual(d.prepare('SELECT env FROM media_flow WHERE media_id = 5').get().env, null, JSON.stringify(e));
  }
  store.save(d, 1, SRC, { env }, { error: 'gone' });
  assert.strictEqual(d.prepare('SELECT env FROM media_flow WHERE media_id = 1').get().env, null);
});

test('parseEnv: rounded to 2 decimals, anything malformed is no envelope', () => {
  assert.deepStrictEqual(FlowOrder.parseEnv('[[0.123,0.456],[0.9,0.111]]'), [[0.12, 0.46], [0.9, 0.11]]);
  for (const bad of [null, '', '[]', '[[0.1,0.2]]', '{"a":1}', '[[1,"x"],[0.2,0.3]]', 'nope']) assert.strictEqual(FlowOrder.parseEnv(bad), null, bad);
  // Clamped to 0..1, junk pairs dropped, sorted by t.
  assert.deepStrictEqual(FlowOrder.parseEnv('[[0.9,1.7],[null,0.2],[0.1,-0.3],["a",1],[0.5,0.5]]'), [[0.1, 0], [0.5, 0.5], [0.9, 1]]);
  assert.deepStrictEqual(FlowOrder.parseEnv([[1.4, 0.2], [-1, 0.3]]), [[0, 0.3], [1, 0.2]]);
});

test('encodeEnv: junk pairs dropped, clamped, stored in time order', () => {
  assert.strictEqual(store.encodeEnv([[0.9, 0.5], [0.1, 0.4], [NaN, 0.1], [0.5, 2]]), '[[0.1,0.4],[0.5,1],[0.9,0.5]]');
  assert.strictEqual(store.encodeEnv('[[0.7,0.2],[0.3,0.1]]'), '[[0.3,0.1],[0.7,0.2]]');
  assert.strictEqual(store.encodeEnv([[0.1, 0.2], [Infinity, 0.3]]), null);
});
