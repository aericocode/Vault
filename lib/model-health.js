/**
 * Model availability — tells "the backend is gone" apart from "this file failed".
 *
 * A scan queue that treats both the same way is worse than useless when a model
 * unloads mid-run: LM Studio's JIT unload, an Ollama keep_alive expiry, or a
 * killed sidecar turns every remaining file into a failure in seconds, and the
 * user comes back to a "1200 failed" bar with nothing scanned. The fix is to
 * recognise the difference and STOP — a paused queue keeps its work; a drained
 * one has thrown it away.
 *
 * Classification is deliberately CONSERVATIVE. A false negative costs one file
 * (the old behaviour); a false positive halts a healthy run and makes the user
 * click Resume for nothing. So only unambiguous "nothing is listening / nothing
 * is loaded" signals count, and a bare 500 — which LM Studio also returns for
 * ordinary per-request problems like a context overflow — does not qualify on
 * its own.
 */

// Transport-level: nothing is listening on the endpoint at all. undici nests the
// real cause one (or two) levels down inside a generic `TypeError: fetch failed`.
const DEAD_SOCKET_CODES = new Set([
  'ECONNREFUSED',           // LM Studio / Ollama not running
  'ECONNRESET',             // died mid-request
  'ENOTFOUND',              // host gone (renamed / DNS)
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

// Body phrases that mean "the model itself is not loaded", as opposed to "your
// request was bad". Matched case-insensitively against the response body.
const MODEL_GONE_PHRASES = [
  'model_not_found',
  'model not found',
  'no model',                  // LM Studio: "No models loaded"
  'no models',
  'not loaded',
  'model is not loaded',
  'failed to load model',
  'try pulling it first',      // Ollama
  'does not exist',            // vLLM
  'loading model',
  'model unloaded',
];

// Sidecar processes (faster-whisper, sherpa-onnx diarizer) reject their pending
// requests with these when the child dies — a dead sidecar is a dead model.
const DEAD_SIDECAR_RE = /\b(whisper server closed|diarizer closed|sidecar (?:closed|died|exited)|server closed)\b/i;

// LM Studio serves whatever single model is loaded, so Vault omits `model` from
// chat requests by default. Load a SECOND model — which Vault's own setup guide
// causes, since semantic search asks for an embedding model too — and every
// request comes back 400 "Multiple models are loaded. Please specify a model by
// providing a 'model' field." That is not a broken backend and not a bad file:
// it is a question only the user can answer, so it gets its own classification
// and its own halt reason (see lib/import-queue.js pausedBy()).
const MULTI_MODEL_RE = /multiple models/i;
const SPECIFY_MODEL_RE = /specify a model/i;

/** Walk `err.cause` (undici nests the real errno) collecting every code seen. */
function _codes(err) {
  const out = [];
  let cur = err;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.code) out.push(String(cur.code));
    if (cur.errno && typeof cur.errno === 'string') out.push(cur.errno);
    cur = cur.cause;
  }
  return out;
}

function _messages(err) {
  const out = [];
  let cur = err;
  for (let i = 0; cur && i < 5; i++) {
    if (cur.message) out.push(String(cur.message));
    cur = cur.cause;
  }
  return out.join(' | ');
}

/**
 * Is this a "several models are loaded — say which one" rejection?
 *
 * Deliberately narrow: only a 400 (the status every OpenAI-compatible server
 * uses for a malformed request) whose body names the ambiguity. A 400 for any
 * other reason is an ordinary per-request failure and must not open a picker.
 * @param {Error} err - ideally carrying .status/.body from lib/llm-client.js
 * @returns {boolean}
 */
function isModelChoiceNeeded(err) {
  if (!err) return false;
  if (err.needsModelChoice === true) return true;      // already classified upstream
  if (Number(err.status) !== 400) return false;
  const text = String(err.body || '') + ' ' + _messages(err);
  if (MULTI_MODEL_RE.test(text)) return true;
  // Wording varies between builds/forks — "please specify a model" alongside a
  // literal `model` mention is the same complaint.
  return SPECIFY_MODEL_RE.test(text) && /model/i.test(text);
}

const MODEL_CHOICE_REASON =
  "Multiple models are loaded in LM Studio — pick one in the scan panel or set AI_MODEL";

/**
 * Is this error "the model/backend is unavailable" rather than "this one file
 * could not be processed"?
 * @param {Error} err - ideally carrying .status/.body from lib/llm-client.js
 * @returns {boolean}
 */
function isModelUnavailable(err) {
  if (!err) return false;
  if (err.modelUnavailable === true) return true;      // already classified upstream

  // "Which model?" travels the SAME channel as a dead model — every remaining
  // file would fail identically, so the queue must halt rather than shred the
  // run. The queue then reads needsModelChoice to show a picker instead of the
  // generic "load the model and press Resume".
  if (isModelChoiceNeeded(err)) return true;

  // Nothing listening / connection torn down.
  if (_codes(err).some(c => DEAD_SOCKET_CODES.has(c))) return true;

  const msg = _messages(err);

  // A sidecar child process died and took its loaded model with it.
  if (DEAD_SIDECAR_RE.test(msg)) return true;

  const status = Number(err.status);
  const body = String(err.body || msg).toLowerCase();

  if (status === 404) {
    // The chat/embeddings route exists in every OpenAI-compatible server, so a
    // 404 here is about the *model*, not the URL — that's the JIT-unload shape.
    return true;
  }
  if (status === 502 || status === 503) {
    // Bad gateway / service unavailable — the backend behind the port is down
    // or still spinning a model up.
    return true;
  }
  if (status === 500 && MODEL_GONE_PHRASES.some(p => body.includes(p))) {
    // Only a 500 that *says* the model is missing. A bare 500 is far more often
    // a per-request problem (oversized context, bad image) and must not halt.
    return true;
  }

  // undici's opaque wrapper with no usable cause — the socket never came up.
  if (/^fetch failed$/i.test(String(err.message || '').trim())) return true;

  return false;
}

/**
 * Short, human-readable reason for a halt — what the queue panel shows.
 * @returns {string}
 */
function describe(err) {
  if (!err) return 'Model unavailable';
  if (isModelChoiceNeeded(err)) return MODEL_CHOICE_REASON;
  const msg = _messages(err);
  if (DEAD_SIDECAR_RE.test(msg)) return 'A model sidecar process exited';
  if (_codes(err).some(c => c === 'ECONNREFUSED')) {
    return 'Nothing is listening on the LLM endpoint — is LM Studio running?';
  }
  if (_codes(err).some(c => DEAD_SOCKET_CODES.has(c)) || /^fetch failed$/i.test(String(err.message || '').trim())) {
    return 'Lost the connection to the LLM endpoint';
  }
  const status = Number(err.status);
  if (status === 404) return 'The model is not loaded (endpoint answered 404)';
  if (status === 502 || status === 503) return 'The LLM backend is unavailable (HTTP ' + status + ')';
  return String(err.message || 'Model unavailable').slice(0, 200);
}

/**
 * Tag an error as a model-availability failure so callers downstream (which
 * only see `{ success: false, error }`) can still tell the two apart.
 */
function tag(err) {
  if (err && typeof err === 'object') {
    if (isModelChoiceNeeded(err)) err.needsModelChoice = true;
    err.modelUnavailable = true;
    if (!err.modelReason) err.modelReason = describe(err);
  }
  return err;
}

module.exports = { isModelUnavailable, isModelChoiceNeeded, describe, tag, MODEL_CHOICE_REASON };
