/**
 * Fuzzy vocabulary (lib/name-fuzzy.js): pg_trgm similarity, which words are
 * expanded, which columns feed the vocabulary, and that reading it in small
 * slices gives the same answers as one big read.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-fuzzy-'));
process.env.VAULT_DB = path.join(tmp, 'library.db');
process.env.VAULT_SETTINGS_FILE = path.join(tmp, 'settings.json');
delete process.env.VAULT_DB_PASSWORD;

const db = require('../lib/database');
const fuzzy = require('../lib/name-fuzzy');

test.before(() => {
  db.init();
  const ins = db.get().prepare(`INSERT INTO media (filepath, filename, media_type, tags, themes, description)
    VALUES (?, ?, 'video', ?, ?, ?)`);
  ins.run('/a/Sunset_Beach.mp4', 'Sunset_Beach.mp4', '["vacation", "Café"]', '["golden"]', 'sunsets everywhere');
  ins.run('/b/sunset2.mp4', 'sunset2.mp4', '[]', '["sunrise"]', 'nothing');
  ins.run('/folderword/x.mp4', 'x.mp4', '[]', '[]', 'descriptiononly vacatoin');
});
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('similarity is pg_trgm\'s (padded trigrams, Jaccard)', () => {
  assert.strictEqual(fuzzy.similarity('word', 'word'), 1);
  assert.deepStrictEqual([...fuzzy.trigrams('cat')].sort(), ['  c', ' ca', 'at ', 'cat']);
  // pg_trgm: similarity('vacation', 'vacasion') = 0.5
  assert.strictEqual(fuzzy.similarity('vacation', 'vacasion'), 0.5);
  assert.ok(fuzzy.similarity('vacation', 'vacatoin') < 0.4, 'a swap costs more than one change');
});

test('only words of 4+ characters without digits are expanded', () => {
  assert.strictEqual(fuzzy.isFuzzable('sunst'), true);
  assert.strictEqual(fuzzy.isFuzzable('sun'), false);
  assert.strictEqual(fuzzy.isFuzzable('img2019'), false);
  assert.strictEqual(fuzzy.isFuzzable('2019'), false);
});

test('the vocabulary is file names, tags and themes; not paths or descriptions', async () => {
  fuzzy.reset();
  await fuzzy.ensure(db.get());
  const d = db.get();
  assert.ok(fuzzy.closeTerms(d, 'sunsat').includes('sunset'));
  assert.ok(fuzzy.closeTerms(d, 'vacasion').includes('vacation'));
  assert.ok(fuzzy.closeTerms(d, 'cafe').length === 0, 'the word itself is excluded (café folds to cafe)');
  assert.deepStrictEqual(fuzzy.closeTerms(d, 'foldrword'), [], 'folder names are not in the vocabulary');
  assert.deepStrictEqual(fuzzy.closeTerms(d, 'descriptionnly'), [], 'descriptions are not either');
  // Metadata only: file-name words drop out, tags and themes stay.
  assert.ok(!fuzzy.closeTerms(d, 'sunsat', { metadataOnly: true }).includes('sunset'));
  assert.ok(fuzzy.closeTerms(d, 'goldan', { metadataOnly: true }).includes('golden'));
});

test('reading the vocabulary in tiny slices gives the same result', async () => {
  fuzzy.reset();
  await fuzzy.ensure(db.get());
  const big = fuzzy.stats();
  const words = ['sunsat', 'vacasion', 'goldan', 'sunrize', 'beech'];
  const before = words.map(w => fuzzy.closeTerms(db.get(), w));
  fuzzy.reset();
  fuzzy._tuning.vocabChunk = 2;
  fuzzy._tuning.adaptive = false;
  try {
    await fuzzy.ensure(db.get());
  } finally {
    fuzzy._tuning.vocabChunk = 1000;
    fuzzy._tuning.adaptive = true;
  }
  assert.strictEqual(fuzzy.stats().terms, big.terms);
  assert.deepStrictEqual(words.map(w => fuzzy.closeTerms(db.get(), w)), before);
});

test('a stale copy keeps answering while a fresh one builds', async () => {
  fuzzy.reset();
  const d = db.get();
  const first = await fuzzy.ensure(d);
  d.prepare(`INSERT INTO media (filepath, filename, media_type) VALUES ('/c/marmalade.mp4', 'marmalade.mp4', 'video')`).run();
  // Changed, but younger than a minute: the same copy, no rebuild.
  assert.strictEqual(await fuzzy.ensure(d), first);
  assert.deepStrictEqual(fuzzy.closeTerms(d, 'marmelade'), []);
  first.builtAt -= fuzzy.REBUILD_AFTER_MS + 1;
  assert.strictEqual(await fuzzy.ensure(d), first, 'the old copy answers while the new one builds');
  // Let the background build finish.
  for (let i = 0; i < 50 && fuzzy.closeTerms(d, 'marmelade').length === 0; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(fuzzy.closeTerms(d, 'marmelade').includes('marmalade'));
});
