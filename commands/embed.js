/**
 * embed — backfill semantic-search embeddings for the library.
 *
 * Embeds EXISTING text metadata (description/tags/themes/transcription);
 * no media files are touched. Safe to interrupt and re-run: only rows
 * without an embedding are processed (use --all to re-embed everything,
 * e.g. after switching embedding models).
 */

const config = require('../config');
const db = require('../lib/database');
const embeddings = require('../lib/embeddings');
const llm = require('../lib/llm-client');

async function run(args) {
  const all = args.includes('--all');

  db.init();

  if (!(await llm.isAvailable())) {
    console.error('No LM Studio endpoint available. Start LM Studio first.');
    process.exit(1);
  }

  const handle = db.get();
  const rows = all
    ? handle.prepare('SELECT * FROM media WHERE processing_error IS NULL').all()
    : handle.prepare('SELECT * FROM media WHERE embedding IS NULL AND processing_error IS NULL').all();

  if (rows.length === 0) {
    console.log('Nothing to embed — all rows are up to date.');
    db.close();
    return;
  }

  console.log(`Embedding ${rows.length} items (model: ${config.embeddings.model})…`);
  const batchSize = config.embeddings.batchSize;
  const startTime = Date.now();
  let done = 0, saved = 0, failed = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    try {
      saved += await embeddings.embedRows(batch);
    } catch (err) {
      failed += batch.length;
      console.warn(`  batch failed (${err.message}) — continuing`);
    }
    done += batch.length;

    if (done % (batchSize * 10) === 0 || done === rows.length) {
      const rate = done / ((Date.now() - startTime) / 1000);
      const eta = Math.round((rows.length - done) / Math.max(rate, 1));
      console.log(`  ${done}/${rows.length} (${Math.round(rate)}/s, ETA ${eta}s)`);
    }
  }

  console.log(`\nDone: ${saved} embedded, ${failed} failed, ${embeddings.missingCount()} still missing.`);
  db.close();
}

module.exports = { run };
