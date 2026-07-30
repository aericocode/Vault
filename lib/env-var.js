/**
 * Branded environment-variable lookup with a legacy-name fallback.
 *
 * The app shipped as `video-tagger` through v3.5.0, so every path/passphrase
 * override a user has in their .env or shell is named VIDEO_TAGGER_*. The
 * product is now Vault, and VAULT_* is the documented surface. This module is
 * what makes that rename non-destructive:
 *
 *     VAULT_<SUFFIX>  >  legacy name  >  the caller's own `|| default`
 *
 * WHY THE FALLBACK EXISTS — a hard rename would silently point an existing
 * install at empty defaults, and every symptom looks like data loss rather than
 * a config miss:
 *   - VIDEO_TAGGER_DB stops being read       → boots against an empty
 *                                              ./vault.db; the user's whole
 *                                              library appears gone.
 *   - VIDEO_TAGGER_DB_PASSWORD stops         → the encrypted DB no longer
 *     being read                               auto-unlocks.
 *   - _THUMBS / _SUBS / _SECURE_ASSETS       → derived assets are orphaned and
 *     stop being read                          silently regenerated elsewhere.
 * None of those are recoverable by the user guessing; all of them are avoided by
 * keeping the old name working. The legacy names are read but NOT documented —
 * new installs only ever see VAULT_*.
 *
 * SEMANTICS — deliberately identical to the `process.env.X || default` idiom
 * every call site already used, so behaviour is bit-for-bit unchanged whenever
 * no env var is set:
 *   - an EMPTY string counts as unset and falls through (that is what `||` did
 *     before, and .env files are full of accidental `KEY=` lines),
 *   - `undefined` is returned when neither name is set, so a call site's
 *     existing `|| path.join(ROOT, …)` default still fires,
 *   - only the SUFFIX is passed in; the prefixes live here rather than being
 *     spelled out at every call site.
 *
 * DEPENDENCIES — none, on purpose. config/index.js requires this at module load
 * and lib/load-env.js uses it before anything else runs, so it must not pull in
 * `config` (or anything that transitively does) or a require cycle appears.
 */

/** Current, documented prefix. */
const VAULT_PREFIX = 'VAULT_';

/** Pre-rename prefix, still honoured (see LEGACY_NAMES for any exceptions). */
const LEGACY_PREFIX = 'VIDEO_TAGGER_';

/**
 * Per-suffix legacy-name exceptions, for any variable whose pre-rename name was
 * not simply VIDEO_TAGGER_<SUFFIX>. Empty today — MEDIA_TAGGER_PORT was the one
 * candidate and it keeps its own name (read directly in config/index.js), so
 * nothing routes through here yet. Kept because the derivation below reads more
 * clearly with the exception hook than without it.
 */
const LEGACY_NAMES = {};

/**
 * The pre-rename variable name for `suffix` (e.g. 'DB' → 'VIDEO_TAGGER_DB').
 * Exported so callers that need to WARN about a legacy name (lib/load-env.js)
 * name the same variable this module reads.
 */
function legacyEnvName(suffix) {
  return LEGACY_NAMES[suffix] || (LEGACY_PREFIX + suffix);
}

/** Both names this module consults for `suffix`, in precedence order. */
function envNames(suffix) {
  return [VAULT_PREFIX + suffix, legacyEnvName(suffix)];
}

/**
 * Read `VAULT_<suffix>`, falling back to the legacy name.
 * @param {string} suffix e.g. 'DB', 'THUMBS', 'DB_PASSWORD'
 * @returns {string|undefined} the set value, or undefined when neither name is
 *   set (or both are empty) — leaving the caller's `|| default` to apply.
 */
function envVar(suffix) {
  const [current, legacy] = envNames(suffix);
  return process.env[current] || process.env[legacy] || undefined;
}

module.exports = { envVar, envNames, legacyEnvName, VAULT_PREFIX, LEGACY_PREFIX };
