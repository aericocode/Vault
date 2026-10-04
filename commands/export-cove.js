/**
 * Move a Vault library's metadata into Cove.
 *
 *   node vault.js export-cove --cove http://127.0.0.1:5073 [--apply]
 *       [--map "D:\Media=/media"]... [--resume] [--report out.json] [--limit N]
 *
 * Cove has already scanned the same files; this command finds each Vault item
 * in Cove (by path, see lib/cove/mapping.js matchItems) and copies over what
 * Vault knows that Cove does not: the AI tags and descriptions, the AI
 * metadata as custom fields, notes, star ratings, favorites and collections.
 * Every item is stamped with custom field `vault_id`, which is how a re-run
 * (and the later Cove extensions that port Vault's AI features) find their
 * way back to the Vault record.
 *
 * DRY RUN BY DEFAULT. Without --apply every read, match and plan runs, the
 * summary and report are written, and Cove gets nothing but GET requests (the
 * client is built read-only and refuses anything else). --apply sends the
 * writes.
 *
 * ADDITIVE AND IDEMPOTENT. Nothing in Cove is deleted, cleared or replaced:
 * tags are added to what an item has, details and custom fields are only
 * filled where Cove's are empty, a rating only where Cove has none, favorites
 * only switched on, collection items only appended. A second run against the
 * same Cove finds nothing left to do and sends no writes.
 *
 * THE VAULT LIBRARY IS ONLY READ. It is opened read-only, never through
 * lib/database.js (that opens read-write and runs migrations). A leftover
 * `<db>-journal` (a write that never finished) means the file may be
 * mid-transaction: we refuse and leave every file exactly as it is. Vault
 * itself rolls the journal back correctly the next time it opens.
 *
 * Token: env COVE_TOKEN only (never a flag, so it stays out of shell history),
 * and only needed when Cove has login turned on. With login off (Cove's
 * default) a local request without one is treated as Cove's owner.
 * Encrypted library: VAULT_DB_PASSWORD, the same variable Vault reads.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const M = require('../lib/cove/mapping');
const { runExport, readVaultData, checkCoveUrl, timestamp } = require('../lib/cove/export');

const HOT_JOURNAL_MSG = 'Vault is running or did not close cleanly. Close Vault (or open and close it once), then run this again.';
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// Reading Vault (read-only)
// ---------------------------------------------------------------------------

/**
 * The SQLite build, loaded exactly like lib/database.js does (packaged exe:
 * runtime/node_modules beside the exe) but without requiring database.js,
 * whose module scope is shared with code that opens the library read-write.
 */
function loadSqlite() {
  const { createRequire } = require('module');
  const { ROOT, isSea } = require('../lib/approot');
  const nativeRequire = isSea ? createRequire(path.join(ROOT, 'runtime', 'index.js')) : createRequire(__filename);
  try {
    return { Database: nativeRequire('better-sqlite3-multiple-ciphers'), hasCipher: true };
  } catch {
    return { Database: nativeRequire('better-sqlite3'), hasCipher: false };
  }
}

/**
 * Open the library read-only. Refuses (touching nothing) when a -journal sits
 * next to it. Encryption is read from the file header with plain fs, so a
 * locked library without a password is refused before SQLite sees it.
 */
function openVaultReadOnly(dbPath, password) {
  if (!dbPath || !fs.existsSync(dbPath)) throw fail(`No Vault library found at ${dbPath}.`, 'NO_DB');
  if (fs.existsSync(dbPath + '-journal')) throw fail(HOT_JOURNAL_MSG, 'HOT_JOURNAL');

  const header = Buffer.alloc(16);
  const fd = fs.openSync(dbPath, 'r');
  let n;
  try { n = fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (n < 16) throw fail(`${dbPath} is not a Vault library (the file is empty or cut short).`, 'NOT_A_DB');
  const encrypted = !header.equals(SQLITE_MAGIC);

  const { Database, hasCipher } = loadSqlite();
  if (encrypted && !password) {
    throw fail('This library is encrypted. Set VAULT_DB_PASSWORD to its password and run this again.', 'DB_ENCRYPTED');
  }
  if (encrypted && !hasCipher) {
    throw fail('This library is encrypted, but the encrypted-SQLite module (better-sqlite3-multiple-ciphers) is not installed.', 'VAULT_NO_CIPHER');
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (encrypted) db.pragma(`key='${String(password).replace(/'/g, "''")}'`);
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    try { db.close(); } catch {}
    if (err && err.code === 'SQLITE_READONLY_ROLLBACK') throw fail(HOT_JOURNAL_MSG, 'HOT_JOURNAL');
    throw fail(encrypted ? 'The library password is wrong (VAULT_DB_PASSWORD).' : `Could not read ${dbPath}: ${err.message}`, 'DB_ENCRYPTED');
  }
  return { db, encrypted };
}

/** Everything the export needs from the library, read in one go; the connection is closed before Cove is contacted. */
function readVault(dbPath, password) {
  const { db, encrypted } = openVaultReadOnly(dbPath, password);
  try {
    return { ...readVaultData(db, dbPath), encrypted };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// The export (the engine lives in lib/cove/export.js)
// ---------------------------------------------------------------------------

/**
 * Open the library read-only, read it, close it, then run the export.
 * Takes the engine's options plus o.dbPath and o.password (see runExport).
 * The address and --map values are checked before the library is touched.
 */
async function exportCove(o) {
  checkCoveUrl(o.coveUrl);
  M.parseMaps(o.maps || []);
  const vault = readVault(o.dbPath, o.password || null);
  return runExport({ ...o, vault, encrypted: vault.encrypted });
}


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
Usage: node vault.js export-cove --cove <url> [options]

Copies this library's tags, descriptions, AI details, notes, ratings,
favorites and collections into Cove. Cove must already have scanned the
same files. Nothing in Vault changes, and nothing in Cove is deleted.

Without --apply this is a dry run: it shows what would change and sends
nothing that changes Cove.

Options:
  --cove <url>          Cove's address, for example http://127.0.0.1:5073
  --apply               Make the changes (default: dry run)
  --map "<from>=<to>"   Cove sees your files under another path, for example
                        --map "D:\\Media=/media". Repeat for more folders.
  --resume              Also copy resume points (adds one playback session
                        per item to Cove's history)
  --report <file>       Where to write the JSON report
                        (default: cove-export-report-<time>.json here)
  --limit <n>           Only handle the first n matched items (to try it out)

Environment:
  COVE_TOKEN            Only when Cove has login turned on: an API token from
                        Settings > Security & access > API tokens.
  VAULT_DB_PASSWORD     Password, if the library is encrypted.
`;

function parseArgs(args) {
  const o = { apply: false, resume: false, maps: [], limit: null, report: null, cove: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined];
    const value = () => {
      if (inline !== undefined) return inline;
      const v = args[++i];
      if (v === undefined) throw fail(`${flag} needs a value.`, 'BAD_ARGS');
      return v;
    };
    switch (flag) {
      case '--cove': o.cove = value(); break;
      case '--apply': o.apply = true; break;
      case '--resume': o.resume = true; break;
      case '--map': o.maps.push(value()); break;
      case '--report': o.report = value(); break;
      case '--limit': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) throw fail('--limit needs a whole number.', 'BAD_ARGS');
        o.limit = n;
        break;
      }
      case '--help': case '-h': o.help = true; break;
      default: throw fail(`Unknown option: ${a}`, 'BAD_ARGS');
    }
  }
  return o;
}

function printSummary(s, reportPath, log) {
  const k = (o) => `videos ${o.video}, images ${o.image}, audio ${o.audio}`;
  const done = s.mode === 'apply';
  const verb = (past, future) => (done ? past : future);
  log('');
  log(s.mode === 'apply' ? '=== Moved to Cove ===' : '=== Dry run: nothing was changed in Cove ===');
  log(`Vault items:         ${s.vault.total} (${k(s.vault.byKind)})`);
  log(`  skipped:           ${s.vault.trashed} in the trash, ${s.vault.unsupported} documents or mixes`);
  log(`Cove items:          ${k(s.cove)}`);
  log(`Matched:             ${s.matched.byKind.video + s.matched.byKind.image + s.matched.byKind.audio} (${k(s.matched.byKind)})`);
  log(`  by path:           ${s.matched.byPath}`);
  log(`  by name and size:  ${s.matched.byNameSize}`);
  log(`  from earlier run:  ${s.matched.byVaultId}`);
  if (s.limitedTo != null) log(`  limited to:        ${s.limitedTo}`);
  log(`Not found in Cove:   ${s.unmatched}`);
  log(`Unclear matches:     ${s.ambiguous} (left alone, see the report)`);
  log(`Items ${verb('updated', 'to update')}: ${s.items.changed}, already up to date: ${s.items.upToDate}`);
  log(`Tags ${verb('created', 'to create')}: ${s.tagsCreated}, existing tags ${verb('put', 'to put')} under "Vault AI": ${s.tagsGivenParent}`);
  log(`Custom fields ${verb('created', 'to create')}: ${s.fieldsCreated}${s.fieldsExtended ? `, ${verb('extended', 'to extend')}: ${s.fieldsExtended}` : ''}`);
  log(`Ratings ${verb('set', 'to set')}: ${s.ratingsSet}, favorites: ${s.favoritesSet}${s.resumePointsSet ? `, resume points: ${s.resumePointsSet}` : ''}`);
  log(`Collections: ${s.groupsCreated} groups ${verb('created', 'to create')}, ${s.groupItemsAdded} items ${verb('added', 'to add')}`);
  log(`Errors:              ${s.errors}`);
  log(`Report:              ${reportPath}`);
  if (s.mode !== 'apply') log('\nRun again with --apply to make these changes.');
}

async function run(args) {
  const opts = parseArgs(args || []);
  if (opts.help) { console.log(USAGE); return; }
  if (!opts.cove) { console.log(USAGE); throw fail('--cove is required.', 'BAD_ARGS'); }

  const reportPath = path.resolve(opts.report || `cove-export-report-${timestamp()}.json`);
  const tty = process.stdout.isTTY;
  const progress = tty
    ? (l) => process.stdout.write(`\r  matched ${l.matched} / updated ${l.updated} / skipped ${l.skipped} / errors ${l.errors}   `)
    : () => {};

  const { summary, report } = await exportCove({
    coveUrl: opts.cove,
    token: process.env.COVE_TOKEN || null,
    dbPath: config.paths.database,
    password: config.getDbPassword(),
    apply: opts.apply,
    maps: opts.maps,
    resume: opts.resume,
    limit: opts.limit,
    log: (line) => console.log(line),
    progress,
  });
  if (tty) process.stdout.write('\n');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  printSummary(summary, reportPath, (line) => console.log(line));
  if (summary.errors) process.exitCode = 1;
}

module.exports = { run, exportCove, parseArgs, readVault, openVaultReadOnly, HOT_JOURNAL_MSG };
