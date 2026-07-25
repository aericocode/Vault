#!/usr/bin/env node

/**
 * Video Tagger v3 - Optimized parallel processing
 */

// Load .env over config defaults before any command (which pull in config).
require('./lib/load-env')();

const commands = {
  scan: () => require('./commands/scan'),
  status: () => require('./commands/status'),
  export: () => require('./commands/export'),
  query: () => require('./commands/query'),
  json: () => require('./commands/json'),
  embed: () => require('./commands/embed'),
  clean: () => require('./commands/clean'),
  phash: () => require('./commands/phash'),
  wizard: () => require('./commands/wizard'),
  'mark-executed': () => require('./commands/mark-executed'),
  music: () => require('./commands/music'),
  subtitles: () => require('./commands/subtitles'),
  serve: () => require('./server/index'),
};

function showHelp() {
  console.log(`
Video Tagger v3 - Optimized parallel processing

Usage: node video-tagger.js <command> [options]

Run with NO command for the interactive wizard (menus instead of flags).

Commands:
  wizard              Interactive mode — pick options with arrow keys
  scan <directory> [options]
      Scan and analyze media files (parallel processing)
      
      Options:
        --recursive, -r     Scan subdirectories
        --reprocess         Re-analyze already processed files
        --workers, -w N     Number of parallel workers (default: auto)
      
  status              Show database statistics
  export [filename]   Export move commands to script
  query [filters]     Query the database
  json [filename]     Export all metadata to JSON
  embed [--all]       Backfill semantic-search embeddings (existing metadata, no rescan)
  phash [options]     Visual duplicate detection (catches re-encodes/resizes)

      Options:
        --threshold N       Max hash distance to match (default: 8, lower = stricter)
        --link              Join found groups as dupes (shared notes, ⧉ badge)
        --force             Re-hash every file

  music <sub>         Music ID: check-tools | fingerprint <id|all> [--force] |
                      scan <id|all> | status  (fingerprint = one-time per file,
                      then auto-matches songs across the library)
  mark-executed       Mark pending operations as complete
  serve [options]     Start the viewer server (same as start.bat)

      Options:
        --gamify            Opt in to the local gamification tracker
                            (Obsession Score, quests, streaks — all data
                            stays in the local DB, nothing leaves your machine)
        --no-gamify         Opt back out (also deletes gamify-config.json)

Performance Environment Variables:
  LM_STUDIO_URLS      Comma-separated list of LM Studio endpoints
                      Example: http://localhost:1234/v1/chat/completions,http://localhost:1235/v1/chat/completions
  
  FRAME_WORKERS       Parallel frame extraction workers (default: 4)
  VISION_WORKERS      Vision API workers per endpoint (default: 1)
  DEDUPE_FRAMES       Enable frame deduplication (default: true)

Other Environment Variables:
  VIDEO_TAGGER_DB             Database path
  VIDEO_TAGGER_OUTPUT         Output base path
  VIDEO_TAGGER_TEMP           Temp frames path

Multi-GPU Setup:
  1. Start LM Studio instance 1 on port 1234 (GPU 0)
  2. Start LM Studio instance 2 on port 1235 (GPU 1)
  3. Set: LM_STUDIO_URLS=http://localhost:1234/v1/chat/completions,http://localhost:1235/v1/chat/completions
  4. Run: node video-tagger.js scan ./media -r

Examples:
  node video-tagger.js scan ./videos --recursive
  node video-tagger.js scan ./videos -r --workers 4
  node video-tagger.js status
  node video-tagger.js query --language Japanese --content anime
`);
}

const [,, command, ...args] = process.argv;

// Packaged exe (Node SEA), launched with no command — the double-click path.
// Mirror start.bat: open the viewer in the default browser, then serve in this
// console window (closing it ends the server, same as today). Flags still pass
// through (e.g. `Vault.exe --gamify`, `--no-browser`); real commands
// (`Vault.exe scan …`, `wizard`, `status`) take the normal CLI route below.
const { isSea } = require('./lib/approot');
if (isSea && (!command || command.startsWith('--'))) {
  const flags = process.argv.slice(2);
  if (!flags.includes('--no-browser')) {
    const port = require('./config').server.port;
    require('child_process').exec(`start "" "http://127.0.0.1:${port}"`);
  }
  require('./server/index').run(flags.filter(f => f !== '--no-browser'));
  return;
}

if (!command) {
  // No command: launch the interactive wizard in a real terminal,
  // fall back to help when piped/scripted (no TTY)
  if (process.stdin.isTTY && process.stdout.isTTY) {
    require('./commands/wizard').run([]);
    return;
  }
  showHelp();
  process.exit(0);
}

if (command === 'help' || command === '--help' || command === '-h') {
  showHelp();
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error('Run with --help for usage');
  process.exit(1);
}

const cmd = commands[command]();
cmd.run(args);
