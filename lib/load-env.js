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
 * SECURITY — the vault passphrase is refused here. VAULT_DB_PASSWORD (and its
 * pre-rename alias VIDEO_TAGGER_DB_PASSWORD, still honored by lib/env-var.js) is
 * the AES-256/ChaCha20 key for the entire metadata DB; it must NEVER live in a
 * plaintext file. If .env carries EITHER name, we drop it and warn — set the
 * passphrase through the viewer's lock screen on first launch instead. (A
 * password set in the real shell environment, e.g. for headless automation, is
 * still honored — only the file-sourced value is rejected.)
 *
 * Both names must be covered: config.getDbPassword() accepts either, so refusing
 * only the legacy one would let `VAULT_DB_PASSWORD=…` in .env sail straight into
 * process.env — a plaintext-passphrase bypass of this very control.
 */

const path = require('path');
const { ROOT } = require('./approot');
const { envNames } = require('./env-var');

// Every name that yields a vault passphrase, in env-var precedence order.
// Sourced from lib/env-var.js so this refusal can never fall out of sync with
// what config.getDbPassword() actually reads.
const PASS_KEYS = envNames('DB_PASSWORD');
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

  // Capture, PER NAME, whether the passphrase came from the real shell BEFORE
  // dotenv runs, so we only reject values that .env itself introduced. Tracked
  // separately for each name: a shell-set VAULT_DB_PASSWORD must not license a
  // file-set VIDEO_TAGGER_DB_PASSWORD (or vice versa).
  const fromShell = new Set(
    PASS_KEYS.filter(k => Object.prototype.hasOwnProperty.call(process.env, k))
  );

  // quiet: silence dotenv v17's promotional startup banner
  const result = dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

  // Reject every passphrase name .env supplied — if it carries both, both go.
  for (const key of PASS_KEYS) {
    if (fromShell.has(key)) continue;
    if (!result.parsed || !result.parsed[key]) continue;
    delete process.env[key];
    console.warn(
      `[env] Ignoring ${key} from .env. The vault passphrase must never ` +
      `be stored in plaintext. Set it in the viewer (lock screen) on first launch.`
    );
  }
}

module.exports = loadEnv;
