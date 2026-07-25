const fs = require('fs');
const config = require('../config');
const db = require('../lib/database');

/**
 * Mark-executed command - mark all pending operations as complete
 */
function run() {
  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found.');
    return;
  }
  
  db.init();
  const result = db.markAllExecuted();
  
  console.log(`Marked ${result.changes} operations as executed.`);
  
  db.close();
}

module.exports = { run };
