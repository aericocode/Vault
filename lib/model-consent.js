/**
 * Per-model download consent — one decision per artifact, never a blanket yes.
 *
 * Vault fetches three different things from the network on first use, at three
 * different moments: the Whisper transcription model, an OPUS-MT translation
 * pack (one per language pair), and the speaker-diarization models. A single
 * "allow downloads" switch would mean approving a 1.5 GB Whisper pull also
 * silently approves a Japanese translation pack three weeks later — which is
 * not what the user agreed to. Consent is therefore keyed per artifact:
 *
 *   whisper:large-v3-turbo     the transcription model
 *   opus:ja                    the ja→en translation pack (one key per source)
 *   diarize                    the speaker-detection models
 *
 * Once an artifact is on disk it never asks again, because the callers only
 * consult this when the local-first load has already failed.
 *
 * The environment is a hard ceiling above all of it, unchanged:
 *   SUB_ALLOW_DOWNLOADS=0 / VAULT_OFFLINE=1  → never, and no click overrides it
 *   SUB_ALLOW_DOWNLOADS=1                    → pre-approved, no prompts
 *   unset                                     → ask, once per artifact
 *
 * Unset-and-unanswered means NOT allowed. That is the point: the old default
 * was "yes unless told otherwise", which let the first Generate press start a
 * download the user never agreed to.
 */

const config = require('../config');
const appSettings = require('./app-settings');

// Snapshot the ceiling at load, before anything can mutate the config field.
const ENV_ALLOWS = config.subtitles.allowModelDownload !== false;
const ENV_EXPLICIT = !!config.subtitles.downloadConsentExplicit;

// Artifacts that were needed but had no consent — what the UI offers to enable.
// In memory only: a restart should re-surface anything still missing, and a
// stale ask is worse than asking again.
const _wanted = new Map();   // key -> { key, kind, detail, sizeHint, at }

/** Human-facing description for a key the UI hasn't been handed metadata for. */
function describe(key) {
  if (key.startsWith('whisper:')) {
    return { kind: 'whisper', detail: key.slice(8), sizeHint: '~1.5 GB',
      label: 'transcription model', why: 'turning speech into subtitles' };
  }
  if (key.startsWith('opus:')) {
    return { kind: 'opus', detail: key.slice(5), sizeHint: '~300 MB',
      label: 'offline translation model', why: 'translating subtitles without the LLM' };
  }
  if (key === 'diarize') {
    return { kind: 'diarize', detail: '', sizeHint: '~35 MB',
      label: 'speaker-detection models', why: 'labelling who is speaking' };
  }
  return { kind: 'other', detail: key, sizeHint: '', label: key, why: '' };
}

function _store() {
  const v = appSettings.all().modelConsents;
  return (v && typeof v === 'object') ? v : {};
}

/** Has the user approved THIS artifact? Env can veto; it can also pre-approve. */
function isAllowed(key) {
  if (!ENV_ALLOWS) return false;
  if (ENV_EXPLICIT) return true;
  return _store()[key] === true;
}

/**
 * Called by a fetch site that wanted an artifact it isn't allowed to get.
 * Records it so the UI can offer the choice, and returns false for convenience
 * at the call site: `if (!consent.request(key)) throw …`
 */
function request(key, meta = {}) {
  if (isAllowed(key)) return true;
  if (ENV_ALLOWS) {   // no point offering something the environment forbids
    const d = describe(key);
    _wanted.set(key, { key, ...d, ...meta, at: Date.now() });
  }
  return false;
}

/** Artifacts wanted but not approved — newest first. */
function pending() {
  return [..._wanted.values()].sort((a, b) => b.at - a.at);
}

function grant(key, allow) {
  if (!ENV_ALLOWS) return { ok: false, code: 'DOWNLOADS_OFF_BY_ENV' };
  appSettings.set({ modelConsents: { ..._store(), [key]: !!allow } });
  _wanted.delete(key);          // answered either way — stop offering it
  return { ok: true, key, allowed: !!allow };
}

function state() {
  return { envAllows: ENV_ALLOWS, explicit: ENV_EXPLICIT, consents: _store(), pending: pending() };
}

module.exports = { isAllowed, request, pending, grant, state, describe, ENV_ALLOWS, ENV_EXPLICIT };
