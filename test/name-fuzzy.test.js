/**
 * Fuzzy vocabulary (lib/name-fuzzy.js): edit distance, which words are
 * expanded and to what, which columns feed the vocabulary, and that reading
 * it in small slices gives the same answers as one big read.
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
  // A realistic vocabulary for the typo table, one file per entry: test and
  // beach name more files than their neighbours.
  const words = ['test', 'test', 'test', 'tests', 'testing', 'sets', 'pets', 'jets', 'teta', 'beach', 'beach',
    'bench', 'beaches', 'birthday', 'birthdays', 'sunstone', 'sunsets', 'kitten', 'kittens', 'mitten',
    'holiday', 'holidays', 'harbor', 'harbour'];
  words.forEach((w, i) => ins.run(`/v/${w} ${i}.jpg`, `${w} ${i}.jpg`, '[]', '[]', ''));
});
test.after(() => {
  db.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('distance is Damerau-Levenshtein (optimal string alignment)', () => {
  assert.strictEqual(fuzzy.distance('test', 'test'), 0);
  assert.strictEqual(fuzzy.distance('tets', 'test'), 1, 'a swap of two adjacent letters costs 1');
  assert.strictEqual(fuzzy.distance('sunst', 'sunset'), 1);
  assert.strictEqual(fuzzy.distance('vacasion', 'vacation'), 1);
  assert.strictEqual(fuzzy.distance('kiten', 'mitten'), 2);
  assert.strictEqual(fuzzy.distance('ca', 'abc'), 3, 'optimal string alignment: no edit after a swap');
  assert.strictEqual(fuzzy.maxDistance('harbr'), 1);
  assert.strictEqual(fuzzy.maxDistance('holidya'), 2);
});

test('only words of 4+ characters without digits are expanded', () => {
  assert.strictEqual(fuzzy.isFuzzable('sunst'), true);
  assert.strictEqual(fuzzy.isFuzzable('sun'), false);
  assert.strictEqual(fuzzy.isFuzzable('img2019'), false);
  assert.strictEqual(fuzzy.isFuzzable('2019'), false);
});

test('typos find the words they were meant to be', async () => {
  fuzzy.reset();
  await fuzzy.ensure(db.get());
  const d = db.get();
  const close = (w) => fuzzy.closeTerms(d, w);
  const table = {
    tets: ['test', 'tests', 'teta'],   // the swap first; sets, pets, jets start with another letter
    beahc: ['beach'],
    bech: ['beach', 'bench'],          // one letter missing either way; beach names more files
    brithday: ['birthday', 'birthdays'],
    birthdya: ['birthday', 'birthdays'],
    kiten: ['kitten'],                 // mitten is two changes away and starts with another letter
    sunst: ['sunset'],
    holidya: ['holiday', 'holidays'],
    harbr: ['harbor'],                 // harbour is two letters away: too far for a 5-letter word
  };
  for (const [typo, want] of Object.entries(table)) assert.deepStrictEqual(close(typo), want, typo);
  // Up to 5 letters the first letter must match; from 6 on another one may
  // (ranked after the same one at equal distance).
  assert.deepStrictEqual(close('gest'), [], 'test, one change away, starts with another letter');
  assert.deepStrictEqual(close('mittens'), ['mitten', 'kittens', 'kitten']);
  // Real words are not typos (the query skips them); short words and words
  // with digits never expand.
  assert.ok(fuzzy.isTerm(d, 'test') && fuzzy.isTerm(d, 'Beach'));
  assert.ok(!fuzzy.isTerm(d, 'tets'));
  assert.deepStrictEqual(close('tet'), []);
  assert.deepStrictEqual(close('tets2'), []);
});

test('the vocabulary is file names, tags and themes; not paths or descriptions', async () => {
  fuzzy.reset();
  await fuzzy.ensure(db.get());
  const d = db.get();
  assert.ok(fuzzy.closeTerms(d, 'sunsat').includes('sunset'));
  assert.ok(fuzzy.closeTerms(d, 'vacasion').includes('vacation'));
  assert.ok(fuzzy.closeTerms(d, 'vacatoin').includes('vacation'), 'a swap is one change');
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
  const words = ['sunsat', 'vacasion', 'goldan', 'sunrize', 'beech', 'tets', 'holidya'];
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
