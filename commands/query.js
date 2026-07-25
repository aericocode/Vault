const fs = require('fs');
const config = require('../config');
const db = require('../lib/database');

/**
 * Parse query arguments into filter object
 */
function parseFilters(args) {
  const filters = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace('--', '');
    const value = args[i + 1];
    if (key && value) {
      filters[key] = value;
    }
  }
  return filters;
}

/**
 * Query command - search database with filters
 */
function run(args) {
  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found. Run "scan" first.');
    return;
  }
  
  const verbose = args.includes('--verbose') || args.includes('-v');
  const filters = parseFilters(args.filter(a => a !== '--verbose' && a !== '-v'));
  
  // Map CLI args to filter keys
  const mappedFilters = {
    language: filters.language || filters.lang,
    theme: filters.theme,
    content: filters.content || filters.type,
    mediaType: filters.media || filters.mediaType,
    explicit: filters.explicit,
  };
  
  db.init();
  const results = db.query(mappedFilters);
  
  console.log(`Found ${results.length} results:\n`);
  
  results.forEach(r => {
    console.log(`${r.filename}`);
    console.log(`  Path: ${r.filepath}`);
    console.log(`  Media: ${r.media_type} | Content: ${r.content_type} | Lang: ${r.language} | Explicit: ${r.explicit ? 'Yes' : 'No'}`);
    console.log(`  Themes: ${r.themes}`);
    console.log(`  Description: ${r.description}`);
    
    if (verbose) {
      // Parse and display video elements
      try {
        const elements = JSON.parse(r.media_elements || '[]');
        if (elements.length > 0) {
          console.log(`  Video Elements:`);
          elements.forEach(e => {
            console.log(`    - ${e.type}: ${e.details}`);
          });
        }
      } catch {}
      
      // Parse and display transcribed text
      try {
        const texts = JSON.parse(r.transcribed_text || '[]');
        if (texts.length > 0) {
          console.log(`  Transcribed Text:`);
          texts.forEach(t => {
            console.log(`    - "${t.text}" (${t.location})`);
          });
        }
      } catch {}
    }
    
    console.log('');
  });
  
  db.close();
}

module.exports = { run };
