/**
 * What the library browser and the JSON export get from the media table.
 *
 * Every row used to carry its embedding BLOB, which Express serializes as
 * ~10.8 KB of JSON numbers: /api/media outgrew V8's max string length at ~35k
 * embedded files and `vault json` failed even earlier. The viewer reads drop
 * the two columns the browser never uses and keep everything else (including
 * columns migrations add later); the export streams and drops only the vector.
 *
 * Runs against a throwaway database built by the app's own init().
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-payload-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const exportJson = require('../commands/json');

test.before(() => {
  db.init();
  const insert = db.get().prepare(`
    INSERT INTO media (filepath, filename, media_type, themes, tags, locations,
      media_elements, transcribed_text, explicit, description,
      audio_transcription, embedding, embedding_model, probe_version)
    VALUES (?, ?, 'video', ?, ?, '[]', ?, '[]', 1, ?, ?, ?, 'nomic-embed-text', 1)
  `);
  insert.run('/lib/b.mp4', 'b.mp4', '["beach"]', '["sand","sea"]', '{"camera":"wide"}',
    'A beach at dusk', 'waves and gulls', Buffer.from(new Float32Array(768).fill(0.5).buffer));
  insert.run('/lib/a.mp4', 'a.mp4', '[]', '[]', '[]', 'No embedding yet', null, null);
});
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('the viewer rows leave out exactly the embedding and the audio transcription', () => {
  const full = db.getById(1);
  const viewer = db.getByIdForViewer(1);
  assert.ok(Buffer.isBuffer(full.embedding), 'getById still returns the full row');

  // `ext` is the generated column the server's filters use. SELECT * returns
  // it, PRAGMA table_info (which builds the viewer projection) does not, and
  // the browser computes the extension itself.
  const dropped = Object.keys(full).filter(k => !(k in viewer)).sort();
  assert.deepStrictEqual(dropped, ['audio_transcription', 'embedding', 'ext']);
  assert.deepStrictEqual(Object.keys(viewer).filter(k => !(k in full)), []);

  // A column added by a late migration still reaches the browser, as do the
  // joined clean copies and the derived language fields
  assert.strictEqual(viewer.probe_version, 1);
  assert.strictEqual(viewer.embedding_model, 'nomic-embed-text');
  assert.ok('themes_clean' in viewer && 'language_name' in viewer && 'language_code' in viewer);
  assert.strictEqual(viewer.description, 'A beach at dusk');
});

test('the full viewer list matches the per-id rows, in filepath order', () => {
  const rows = db.getAllForViewer();
  assert.deepStrictEqual(rows.map(r => r.filepath), ['/lib/a.mp4', '/lib/b.mp4']);
  assert.deepStrictEqual(rows[1], db.getByIdForViewer(1));
  assert.strictEqual(db.getByIdForViewer(999), undefined);
});

test('the JSON export is a valid array without the vector but with the transcription', () => {
  const out = path.join(tmp, 'export.json');
  exportJson.run([out]);   // closes the database when it is done
  db.init();

  const text = fs.readFileSync(out, 'utf8');
  const records = JSON.parse(text);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(text, JSON.stringify(records, null, 2), 'same pretty-printed layout as before');

  const [a, b] = records;
  assert.strictEqual(a.filepath, '/lib/a.mp4');
  for (const r of records) assert.ok(!('embedding' in r), 'no embedding field');
  assert.strictEqual(b.audio_transcription, 'waves and gulls');
  assert.strictEqual(b.embedding_model, 'nomic-embed-text');
  assert.deepStrictEqual(b.themes, ['beach']);
  assert.deepStrictEqual(b.tags, ['sand', 'sea']);
  assert.deepStrictEqual(b.media_elements, { camera: 'wide' });
  assert.deepStrictEqual(b.transcribed_text, []);
  assert.strictEqual(b.explicit, true);
  assert.ok('themes_clean' in b && 'language_name' in b);
});
