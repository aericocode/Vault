const fs = require('fs');
const config = require('../config');
const db = require('../lib/database');

/**
 * JSON export command - export all metadata to JSON file
 *
 * Streams one record at a time: building the whole array as a single string
 * failed past V8's max string length on large libraries. The output is
 * byte-identical to JSON.stringify(records, null, 2), minus the embedding BLOB
 * (a binary vector is useless as a list of numbers).
 */
function run(args) {
  if (!fs.existsSync(config.paths.database)) {
    console.log('No database found. Run "scan" first.');
    return;
  }

  const outputFile = args[0] || 'media_metadata.json';

  db.init();

  // Write beside the target and rename at the end, so a failed export never
  // replaces a previous good one with a truncated, invalid file.
  const tmpFile = `${outputFile}.partial`;
  const fd = fs.openSync(tmpFile, 'w');
  let count = 0;
  let ok = false;
  try {
    fs.writeSync(fd, '[');
    for (const m of db.iterateForExport()) {
      // Parse JSON fields for cleaner output
      const record = {
        ...m,
        themes: JSON.parse(m.themes || '[]'),
        locations: JSON.parse(m.locations || '[]'),
        tags: JSON.parse(m.tags || '[]'),
        media_elements: JSON.parse(m.media_elements || '[]'),
        transcribed_text: JSON.parse(m.transcribed_text || '[]'),
        explicit: Boolean(m.explicit),
      };
      // Indent one level, as the element of a pretty-printed array
      const body = JSON.stringify(record, null, 2).replace(/\n/g, '\n  ');
      fs.writeSync(fd, (count ? ',\n  ' : '\n  ') + body);
      count++;
    }
    fs.writeSync(fd, count ? '\n]' : ']');
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) try { fs.unlinkSync(tmpFile); } catch {}
  }
  fs.renameSync(tmpFile, outputFile);
  console.log(`Exported ${count} records to: ${outputFile}`);

  db.close();
}

module.exports = { run };
