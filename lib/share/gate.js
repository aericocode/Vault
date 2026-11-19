/**
 * Share privately: the Vault password gate (spec 6.6). Server side only.
 *
 * Routes that return a password (show or change the saved default password,
 * show or copy the password of a share made with it) call check() with the
 * Vault password the request carried.
 *
 *  - No Vault password set (library not encrypted): passes with no prompt.
 *  - Otherwise the password is checked with database.verifyPassword (read-only
 *    connections, the live one is never touched).
 *  - A wrong password returns nothing and counts. The 5th wrong try in a row
 *    starts a one minute wait, during which every try is refused, the right
 *    password included, without being checked. A right password clears the
 *    count. The count is kept in memory: a restart clears it, as it does for
 *    the Vault's own change-password lockout (lib/vault.js).
 *
 * Errors carry .code and .status for the routes:
 *   GATE_NEEDED  401  a Vault password is set and none was sent
 *   GATE_WRONG   401  wrong password (.attemptsLeft)
 *   GATE_LOCKED  429  too many wrong tries (.retryAfterMs)
 * The candidate password is never logged and never put in an error.
 */

const database = require('../database');
const vault = require('../vault');

const MAX_WRONG = 5;
const WAIT_MS = 60 * 1000;

const state = { wrong: 0, lockedUntil: 0 };
let _now = () => Date.now();
let _verify = (pass) => database.verifyPassword(pass);
let _encrypted = () => vault.isEncrypted();

function _err(code, status, message, extra) {
  return Object.assign(new Error(message), { code, status }, extra || {});
}

/** Is a Vault password set, so that the gate asks for it? */
function required() {
  return !!_encrypted();
}

/**
 * Throws unless the request may see a password. Returns true when it passed.
 * @param {unknown} candidate  the Vault password from the request body
 */
function check(candidate) {
  if (!required()) return true;
  const now = _now();
  if (state.lockedUntil > now) {
    throw _err('GATE_LOCKED', 429, 'Too many wrong passwords. Wait a minute, then try again.', { retryAfterMs: state.lockedUntil - now });
  }
  if (typeof candidate !== 'string' || candidate === '') {
    throw _err('GATE_NEEDED', 401, 'Enter your Vault password to see this.');
  }
  if (candidate.length <= 1024 && _verify(candidate)) {
    state.wrong = 0;
    return true;
  }
  state.wrong += 1;
  if (state.wrong >= MAX_WRONG) {
    state.wrong = 0;
    state.lockedUntil = now + WAIT_MS;
    throw _err('GATE_LOCKED', 429, 'Too many wrong passwords. Wait a minute, then try again.', { retryAfterMs: WAIT_MS });
  }
  throw _err('GATE_WRONG', 401, 'That is not your Vault password.', { attemptsLeft: MAX_WRONG - state.wrong });
}

/** Tests only. */
function _setForTest({ now, verify, encrypted } = {}) {
  if (now) _now = now;
  if (verify) _verify = verify;
  if (encrypted) _encrypted = encrypted;
}
function _reset() {
  state.wrong = 0; state.lockedUntil = 0;
  _now = () => Date.now();
  _verify = (pass) => database.verifyPassword(pass);
  _encrypted = () => vault.isEncrypted();
}

module.exports = { check, required, MAX_WRONG, WAIT_MS, _setForTest, _reset };
