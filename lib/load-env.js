/**
 * .env loader — run FIRST at every entry point, before config/index.js reads
 * process.env. Layers a .env file over the built-in defaults:
 *
 *     shell environment  >  .env file  >  config/index.js default
 *
 * dotenv never overrides a variable already set in the real environment, and
 * config reads every value as `process.env.X || default`, so anything absent
 * from both the shell and .env simply keeps its coded default. A missing .env
 * (or a missing dotenv install) is a no-op — the app runs on defaults.
 *
 * SECURITY — the vault passphrase is refused here. VIDEO_TAGGER_DB_PASSWORD is
 * the AES-256/ChaCha20 key for the entire metadata DB; it must NEVER live in a
 * plaintext file. If .env carries it, we drop it and warn — set the passphrase
 * through the viewer's lock screen on first launch instead. (A password set in
 * the real shell environment, e.g. for headless automation, is still honored —
 * only the file-sourced value is rejected.)
 */

const path = require('path');
const { ROOT } = require('./approot');

const PASS_KEY = 'VIDEO_TAGGER_DB_PASSWORD';
let _loaded = false;

function loadEnv() {
  if (_loaded) return;
  _loaded = true;

  let dotenv;
  try {
    dotenv = require('dotenv');
  } catch {
    return;   // dotenv not installed — plain process.env still works, no .env
  }

  // Capture whether the passphrase came from the real shell BEFORE dotenv runs,
  // so we only reject a value that .env itself introduced.
  const passFromShell = Object.prototype.hasOwnProperty.call(process.env, PASS_KEY);

  // quiet: silence dotenv v17's promotional startup banner
  const result = dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

  if (!passFromShell && result.parsed && result.parsed[PASS_KEY]) {
    delete process.env[PASS_KEY];
    console.warn(
      `[env] Ignoring ${PASS_KEY} from .env — the vault passphrase must never ` +
      `be stored in plaintext. Set it in the viewer (lock screen) on first launch.`
    );
  }
}

module.exports = loadEnv;
