/**
 * clean — (re)build the canonicalized metadata table (media_clean) from the
 * raw AI output already in the DB. Pure string normalization, NO AI, no media
 * touched — safe to run any time, especially after the cleaning rules improve.
 *
 *   node video-tagger.js clean
 */

const db = require('../lib/database');

async function run() {
  db.init();
  console.log('🧹 Rebuilding clean metadata (themes / tags / locations)…');
  const t0 = Date.now();
  const n = db.backfillClean();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✓ Normalized ${n.toLocaleString()} record(s) in ${secs}s`);

  const themes = db.distinctCleanThemes(20);
  if (themes.length) {
    console.log(`\n  Top themes now: ${themes.slice(0, 15).join(', ')}${themes.length > 15 ? ', …' : ''}`);
  }
  db.close();
}

module.exports = { run };
