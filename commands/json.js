const fs = require('fs');
const config = require('../config');
const db = require('../lib/database');

/**
 * JSON export command - export all metadata to JSON file
 */
function run(args) {
  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found. Run "scan" first.');
    return;
  }
  
  const outputFile = args[0] || 'media_metadata.json';
  
  db.init();
  const media = db.getAll();
  
  // Parse JSON fields for cleaner output
  const data = media.map(m => ({
    ...m,
    themes: JSON.parse(m.themes || '[]'),
    locations: JSON.parse(m.locations || '[]'),
    tags: JSON.parse(m.tags || '[]'),
    media_elements: JSON.parse(m.media_elements || '[]'),
    transcribed_text: JSON.parse(m.transcribed_text || '[]'),
    explicit: Boolean(m.explicit),
  }));
  
  fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
  console.log(`Exported ${data.length} records to: ${outputFile}`);
  
  db.close();
}

module.exports = { run };
