const fs = require('fs');
const config = require('../config');
const db = require('../lib/database');

/**
 * Status command - show database statistics
 */
function run() {
  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found. Run "scan" first.');
    return;
  }
  
  db.init();
  const { stats, pending, byContentType, byLanguage, byMediaType } = db.getStats();
  
  console.log('=== DATABASE STATUS ===\n');
  console.log(`Total media files: ${stats.total}`);
  console.log(`Successfully processed: ${stats.success}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Pending operations: ${pending.count}`);
  
  console.log('\n--- By Content Type ---');
  byContentType.forEach(r => console.log(`  ${r.content_type || 'unknown'}: ${r.count}`));
  
  console.log('\n--- By Language ---');
  byLanguage.forEach(r => console.log(`  ${r.language || 'unknown'}: ${r.count}`));
  
  console.log('\n--- By Media Type ---');
  byMediaType.forEach(r => console.log(`  ${r.media_type}: ${r.count}`));
  
  db.close();
}

module.exports = { run };
