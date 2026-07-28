/**
 * Server-side user preferences — the few settings that must survive a restart
 * WITHOUT the user editing environment variables.
 *
 * Most of Vault's preferences live in the browser (localStorage, see
 * player-lib/settings.js) because they're purely about how the UI behaves. That
 * doesn't work for settings the server acts on by itself: the autolock clock has
 * to be right from the moment the process starts, whether or not anyone has
 * opened the viewer yet. Env vars cover that for a CLI user, but someone who
 * double-clicks Vault.exe has nowhere to set one — so the value is stored here
 * instead, next to gamify-config.json.
 *
 * Env still wins on first run: an explicitly-set VAULT_AUTOLOCK_MINUTES seeds
 * the file, and after that the UI owns the value. Anything unreadable falls back
 * to the config default rather than throwing — a corrupt prefs file must never
 * stop the app from booting.
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('./approot');

const SETTINGS_PATH = path.join(ROOT, 'vault-settings.json');

function _read() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};                       // absent or corrupt — defaults apply
  }
}

function _write(obj) {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
    return true;
  } catch (err) {
    console.warn(`[Settings] could not save ${SETTINGS_PATH}: ${err.message}`);
    return false;
  }
}

/** All stored values (may be empty). */
function all() {
  return _read();
}

/**
 * A stored integer, clamped, or `fallback` when absent/unusable.
 * @param {string} key
 * @param {number} fallback
 * @param {{min?: number, max?: number}} bounds
 */
function getInt(key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = _read()[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

/** Merge a patch into the stored settings. Returns the new full object. */
function set(patch) {
  const next = { ..._read(), ...patch };
  _write(next);
  return next;
}

module.exports = { all, getInt, set, SETTINGS_PATH };
