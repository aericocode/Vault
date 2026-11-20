/**
 * LLM Client - Shared client for all LM Studio API calls
 *
 * Owns the single LoadBalancer instance so vision, text, and (future)
 * embedding calls are balanced evenly across multi-GPU endpoints.
 * Also owns JSON response parsing/repair and the bad-JSON debug log.
 *
 * Extracted from vision-api.js / text-api.js which each duplicated this
 * logic (and each ran their own LoadBalancer, unbalancing the endpoints).
 */

const fs = require('fs');
const config = require('../config');
const { netFetch } = require('./net');
const { LoadBalancer } = require('./work-queue');
const aiSlots = require('./ai-slots');

// Single shared load balancer across ALL LLM traffic. Still the unit for
// embeddings, and the fallback for chat when the slot registry cannot answer;
// chat otherwise picks a SLOT, because one endpoint can host several loaded
// copies of the same model and the endpoint alone cannot tell them apart.
let loadBalancer = new LoadBalancer(config.lmStudio.endpoints);

// Debug log file path for bad JSON responses
const DEBUG_LOG_PATH = config.paths.debugLog;

/**
 * The model the user picked in the scan panel after LM Studio refused an
 * ambiguous request ("Multiple models are loaded"). Process memory ONLY — it is
 * deliberately never written to vault-settings.json: it describes what happens
 * to be loaded in LM Studio right now, not a preference, and a stale saved
 * choice would silently pin scans to a model that is no longer there.
 *
 * Precedence is `options.model` → AI_MODEL (config) → this. Environment config
 * always wins, matching the app's rule that env overrides in-app switches.
 */
let sessionModel = null;
/**
 * The pick for scanning pictures and videos, kept apart from the one for
 * text (documents, audio, the text features) so answering one "which
 * model?" question never sends the other kind somewhere it cannot go.
 */
let sessionVisionModel = null;

/**
 * @param {string|null} id
 * @param {{kind?: 'vision'|'text'}} [o] no kind (the Backend picker, older
 *   clients): both picks
 * @returns {string|null} the normalised value actually stored
 */
function setSessionModel(id, { kind = null } = {}) {
  const v = (typeof id === 'string' && id.trim()) ? id.trim() : null;
  if (kind !== 'vision') sessionModel = v;
  if (kind !== 'text') sessionVisionModel = v;
  // The slot set did not move, but which slots are USABLE just did: the import
  // queue sizes itself off the chosen family, so it has to hear about this.
  aiSlots.notifyChange();
  return v;
}

function getSessionModel({ kind = 'text' } = {}) {
  return kind === 'vision' ? sessionVisionModel : sessionModel;
}

/**
 * Which model id (if any) a request should carry, ignoring slots. The saved
 * scan model (Settings > Models > Scanning, lib/scan-model.js) comes last and
 * only for VISION SCANS (a video, picture or GIF from the import queue or the
 * sidebar's Rescan): it is the standing choice for analysing them, and
 * AI_MODEL and a pick made right now outrank it. Text features, and the text
 * analysis of documents and audio, never fall back to it; they keep AI_MODEL,
 * then the session pick, then whatever is loaded.
 */
function resolveModel(options = {}) {
  if (options.model) return options.model;
  // A document or audio file being scanned: AI_MODEL (env always wins), the session pick, then
  // the saved scan model if it is loaded (a vision model reads text fine),
  // then (resolveTarget) the single loaded model, and only then LM Studio's
  // "which model?" question.
  if (_isTextScan(options)) {
    return config.lmStudio.model || sessionModel || _loadedSavedScanModel() || null;
  }
  if (_isScan(options)) {
    return config.lmStudio.model || sessionVisionModel || _savedScanModel() || null;
  }
  return config.lmStudio.model || sessionModel || null;
}

/** Inside the scan of a document or audio file (not a vision scan). */
function _isTextScan(options) {
  if (options && options.forScan) return false;
  if (options && options.forTextScan) return true;
  try { const sc = aiSlots.currentScan(); return !!sc && !sc.vision; } catch { return false; }
}

/** The saved scan model, only when a copy of it is loaded right now. */
function _loadedSavedScanModel() {
  const id = _savedScanModel();
  return id && aiSlots.pick(id) ? id : null;
}

/** The saved scan model, under the identifier LM Studio has it loaded as. */
function _savedScanModel() {
  try { return require('./scan-model').scanTargetId(); } catch { return null; }
}

/**
 * Where a chat request should go: `{ family, modelId, slot }`.
 *
 * Precedence for the CHOICE is unchanged (options.model → AI_MODEL → the
 * session pick). What is new is that a choice naming a family fans out over
 * every loaded copy of it, while `base:N` still pins the one copy the user
 * named. Auto behaves exactly as before: one family loaded means "just use it",
 * several means send no model id at all so LM Studio raises its "multiple
 * models are loaded" 400 and the scan panel's picker opens.
 *
 * A null slot is not an error. It means the registry has nothing to say (first
 * request before the boot probe lands, an Ollama that does not list, a probe
 * that failed), and the caller falls back to endpoint round-robin.
 */
function resolveTarget(options = {}) {
  const chosen = resolveModel(options);
  if (chosen) {
    const slot = aiSlots.pick(chosen);
    if (slot) {
      // Naming one copy exactly is a PIN, not a family choice: pick() will
      // return this slot and no other, so everything downstream that sizes
      // itself off the family has to be told the difference.
      const pinnedId = (slot.modelId === chosen && slot.family !== chosen) ? chosen : null;
      return { family: slot.family, modelId: slot.modelId, slot, pinnedId };
    }
    return { family: chosen, modelId: chosen, slot: null, pinnedId: null };
  }
  let loaded = aiSlots.activeFamilies();
  // An automatic SCAN only looks at models that can read pictures: with a big
  // text model loaded next to the vision one, "the one that is loaded" is the
  // vision one. A model LM Studio does not type (not LM Studio, an older
  // build) still counts, as before. Everything else (text features, a rescan
  // from the sidebar) keeps the plain rule.
  let noVision = false;
  if (_isScan(options)) {
    const all = loaded;
    loaded = loaded.filter(f => aiSlots.familyVision(f) !== false);
    // Only text-only models loaded: there is NO target for a picture, and a
    // request without a model id would go to the text model.
    noVision = all.length > 0 && loaded.length === 0;
  }
  if (loaded.length === 1) {
    const slot = aiSlots.pick(loaded[0]);
    if (slot) return { family: loaded[0], modelId: slot.modelId, slot, pinnedId: null };
  }
  return { family: null, modelId: null, slot: null, pinnedId: null, noVision };
}

/**
 * Is this request a vision scan? It says so with options.forScan, or it runs
 * inside the scan of a video, picture or GIF (lib/ai-slots.js runScan, while
 * that scan is still going: a timer it left behind does not count).
 */
function _isScan(options) {
  if (options && options.forScan) return true;
  try { return !!aiSlots.currentScan()?.vision; } catch { return false; }
}

/**
 * The family requests go to. { forScan: true } asks as a vision scan would
 * (the scan panel, the Backend page); without it, as everything else would
 * (the CLI scan sizes itself this way, as before).
 */
function currentFamily(options = {}) {
  return resolveTarget(options).family;
}

/** The one copy requests are pinned to, or null when the whole family is in use. */
function currentPin(options = {}) {
  return resolveTarget(options).pinnedId;
}

/**
 * Is the library protected by a password right now? Any of the three ways a
 * password arrives counts: the VAULT_DB_PASSWORD env var, the secure-assets
 * store holding a key, or the library file itself being encrypted (a password
 * set on the lock screen or in Settings, which is how most people set one;
 * the env var alone missed all of them). Lazy requires: vault.js loads the
 * database, which must not load this module's callers in a loop at startup.
 */
function vaultMode() {
  if (config.getDbPassword()) return true;
  try { if (require('./secure-assets').enabled()) return true; } catch {}
  try { if (require('./vault').isEncrypted()) return true; } catch {}
  return false;
}

/**
 * Log bad JSON response for debugging.
 *
 * The log is a plain text file beside the app. In vault mode it gets a
 * breadcrumb only: the time, and the media id when the caller knows it. Not
 * the raw response (it describes the picture and quotes any text in it), not
 * the file name, and not the parser's message either, because V8 quotes the
 * start of the bad input in it ("Unexpected token 'A', "A woman in"..."). The
 * library is encrypted precisely so none of that sits on disk in the clear.
 *
 * @param {string} filename
 * @param {string} rawContent
 * @param {Error} error
 * @param {{mediaId?: number}} [opts]
 */
function logBadJson(filename, rawContent, error, { mediaId } = {}) {
  try {
    const timestamp = new Date().toISOString();
    if (vaultMode()) {
      const id = Number.isInteger(mediaId) ? ` media id ${mediaId}` : '';
      fs.appendFileSync(DEBUG_LOG_PATH,
        `[${timestamp}] The AI answered with JSON that could not be read${id}. ` +
        'Not written out: the library has a password.\n');
      console.log(`  ⚠ Bad JSON noted in: ${DEBUG_LOG_PATH} (no content, vault mode)`);
      return;
    }
    const logEntry = `
================================================================================
[${timestamp}] FILE: ${filename}
ERROR: ${error.message}
--------------------------------------------------------------------------------
RAW RESPONSE:
${rawContent}
================================================================================

`;
    fs.appendFileSync(DEBUG_LOG_PATH, logEntry);
    console.log(`  ⚠ Bad JSON logged to: ${DEBUG_LOG_PATH}`);
  } catch (err) {
    // Ignore logging errors
  }
}

/**
 * Attempt to fix common JSON errors
 */
function tryFixJson(jsonStr) {
  let fixed = jsonStr;

  // Remove trailing commas before } or ]
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

  // Remove any control characters
  fixed = fixed.replace(/[\x00-\x1F\x7F]/g, ' ');

  // Try to fix missing commas between properties
  // Pattern: "value" "key" -> "value", "key"
  fixed = fixed.replace(/"\s*\n\s*"/g, '",\n"');

  // Fix arrays with missing commas
  fixed = fixed.replace(/"\s+"/g, '", "');

  return fixed;
}

/**
 * Parse JSON from model response (handles markdown wrapping).
 * Throws on unrecoverable parse failure (after logging the bad response).
 */
function parseJsonResponse(content, filename = 'unknown') {
  let jsonStr = content;

  // Try to extract JSON from markdown code blocks
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  } else {
    // Try to find raw JSON object
    const objMatch = content.match(/\{[\s\S]*\}/);
    if (objMatch) {
      jsonStr = objMatch[0];
    }
  }

  // First attempt: parse as-is
  try {
    return JSON.parse(jsonStr);
  } catch (firstError) {
    // Second attempt: try to fix common issues
    try {
      const fixedJson = tryFixJson(jsonStr);
      return JSON.parse(fixedJson);
    } catch (secondError) {
      // Log the bad JSON for debugging
      logBadJson(filename, content, firstError);
      throw firstError;
    }
  }
}

/* ── Optional request features, remembered per endpoint ─────────────────── */

/**
 * Request fields not every OpenAI-compatible server takes. Each is sent until
 * an endpoint refuses it (or, for response_format, ignores it), then that
 * endpoint is remembered for the rest of the session so the next file does not
 * pay for the same refusal. Memory only.
 *
 * - response_format: { type: 'json_schema', ... } (LM Studio, llama.cpp, vLLM,
 *   recent Ollama). LM Studio answers an unknown type with 400
 *   "'response_format.type' must be 'json_schema' or 'text'".
 * - reasoning_effort: 'none' turns thinking off on LM Studio (checked live on
 *   0.4.x with minicpm-v-4.6, a Qwen3.5-based model: reasoning_tokens went from
 *   29 to 0; chat_template_kwargs.enable_thinking was ignored). LM Studio
 *   rejects an unknown value with 400 "Invalid 'reasoning_effort' value".
 */
const _rejected = new Map();   // endpoint -> Set of feature names

function endpointRejects(endpoint, feature) {
  return !!_rejected.get(endpoint)?.has(feature);
}

function noteRejected(endpoint, feature) {
  if (!endpoint) return;
  let set = _rejected.get(endpoint);
  if (!set) { set = new Set(); _rejected.set(endpoint, set); }
  if (!set.has(feature)) {
    set.add(feature);
    console.log(`  AI server does not take ${feature}; not sending it there again this session`);
  }
}

function _resetFeatures() { _rejected.clear(); }

// Any 400 that names reasoning: LM Studio says "Invalid 'reasoning_effort'
// value", vLLM and others word it their own way.
const REJECTS_REASONING_RE = /reasoning/i;
const REJECTS_FORMAT_RE = /response_format|json_schema|response format|grammar/i;

/**
 * Did the server refuse the request because it is bigger than the context?
 * llama.cpp / LM Studio: 400 exceed_context_size_error "request (N tokens)
 * exceeds the available context size (M tokens)"; vLLM / OpenAI: "maximum
 * context length is N tokens"; others say "context length" or "too many tokens".
 */
function isContextOverflow(err) {
  if (!err) return false;
  if (err.contextOverflow) return true;
  const status = Number(err.status);
  if (status && status !== 400 && status !== 413 && status !== 422 && status !== 500) return false;
  const text = `${err.body || ''} ${err.message || ''}`;
  return /exceed_context_size|exceeds the available context|maximum context length|context length (?:exceeded|is)|context window|too many tokens|prompt is too long|input is too long|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context/i.test(text);
}

/** Remove <think>…</think> a server left inside the answer itself. */
function stripThinking(content) {
  let out = String(content || '');
  if (!/<think/i.test(out)) return out;
  out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // An opening tag with no close: everything after it was thinking.
  const open = out.search(/<think(?:ing)?>/i);
  if (open !== -1) out = out.slice(0, open);
  return out.trim();
}

/**
 * Parse a reply as JSON without logging anything. null when it is not JSON.
 * The scan path uses this so a reply it is about to retry does not land in
 * the bad-JSON log once per attempt.
 */
function tryParseJson(content) {
  const s = String(content || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced ? fenced[1].trim() : null, (s.match(/\{[\s\S]*\}/) || [])[0], s.trim()];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c); } catch {}
    try { return JSON.parse(tryFixJson(c)); } catch {}
  }
  return null;
}

/**
 * Turn a JSON object that was cut off mid-way into the valid JSON that had
 * fully arrived: everything up to the last complete member or array element,
 * with the open brackets closed. Nothing is made up: a member that was cut
 * mid-value is dropped, never completed. null when nothing usable arrived.
 */
function repairTruncatedJson(content) {
  let s = String(content || '');
  s = s.replace(/^[\s\S]*?```(?:json)?\s*/, '');   // a markdown fence, if any
  const start = s.indexOf('{');
  if (start < 0) return null;
  s = s.slice(start);
  const stack = [];
  const cuts = [];
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) {
        try { return JSON.parse(s.slice(0, i + 1)); } catch { return null; }
      }
    } else if (ch === ',') cuts.push({ pos: i, stack: stack.slice() });
  }
  const close = (st) => st.slice().reverse().map(c => (c === '{' ? '}' : ']')).join('');
  for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 200; k--, tries++) {
    const c = cuts[k];
    try { return JSON.parse(s.slice(0, c.pos) + close(c.stack)); } catch {}
  }
  return null;
}

/**
 * POST a chat completion to the next endpoint in the balancer.
 *
 * Returns { content, endpoint, modelId, slot, finishReason, usage, structured,
 * reasoningOff, contextLength }. Throws on API error (err.endpoint set).
 *
 * finishReason is passed back, not acted on: 'length' means the answer was cut
 * off, and only the caller knows whether a partial answer is any use (a
 * translation keeps the lines that arrived; a scan retries smaller). The one
 * thing every caller gets is a clear error when the model spent its whole
 * reply thinking (empty content beside reasoning text), which used to read as
 * "Empty response from model". Reasoning text is never returned.
 *
 * Options beyond the old ones (temperature, maxTokens, model, forScan):
 * - prepare(caps): builds the request once the target is known. caps is
 *   { endpoint, modelId, contextLength, structured }; it returns { messages,
 *   maxTokens, responseFormat }. Called again if the server refuses
 *   response_format, with structured false, so the prompt can carry the
 *   template instead. Without it, `messages` is sent as given.
 * - reasoningOff: ask the server not to think (reasoning_effort 'none').
 */
async function postChat(messages, options = {}) {
  const target = resolveTarget(options);
  if (target.noVision) {
    // A picture, and only text-only models are loaded: never send it out
    // without a model id (it would land on the text model). The queue reads
    // this as "pictures wait for a model that can read them".
    throw Object.assign(new Error('No model that can read pictures is loaded (cannot read pictures)'), { notVision: true });
  }
  const slot = target.slot;
  // Per-endpoint stats stay meaningful either way: a slot still belongs to one
  // endpoint, so getStats() keeps reporting the same numbers it always did.
  const endpoint = slot ? slot.endpoint : loadBalancer.next().endpoint;
  const statIndex = loadBalancer.endpoints.indexOf(endpoint);
  if (slot) aiSlots.acquire(slot);
  // Which file this call belongs to, if anything upstream said. Only the import
  // queue does, which is the only place that needs the answer back.
  const scanCtx = aiSlots.fileContext.getStore();
  const mediaId = scanCtx?.mediaId;
  // AI scan Auto cuts a file off when playback starts (lib/import-queue.js):
  // the abort ends this request at once, wherever it is.
  const signal = aiSlots.scanSignal();
  if (slot) aiSlots.noteFile(mediaId, slot);
  const startTime = Date.now();

  try {
    const model = slot ? target.modelId : resolveModel(options);
    const contextLength = (slot && slot.contextLength) || null;
    let structured = !endpointRejects(endpoint, 'response_format');
    let reasoningOff = !!options.reasoningOff && !endpointRejects(endpoint, 'reasoning_effort');
    let response, prep;
    // At most one extra round per optional feature the server turns down.
    for (let round = 0; round < 3; round++) {
      prep = options.prepare
        ? options.prepare({ endpoint, modelId: model || target.modelId || null, contextLength, structured, reasoningOff })
        : { messages, maxTokens: options.maxTokens };
      const sendFormat = structured && prep.responseFormat ? prep.responseFormat : null;
      response = await netFetch(endpoint, {
        purpose: 'llm',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(signal ? { signal } : {}),
        body: JSON.stringify({
          // LM Studio ignores `model` while ONE model is loaded (it serves that
          // one); Ollama/vLLM always require it — omitted entirely when unset so
          // the single-model LM Studio case stays as-is. Load a second model and
          // LM Studio starts rejecting the omission with a 400; the scan panel's
          // picker answers that by filling sessionModel above.
          ...(model ? { model } : {}),
          messages: prep.messages,
          temperature: options.temperature ?? config.lmStudio.temperature,
          max_tokens: prep.maxTokens ?? options.maxTokens ?? config.lmStudio.maxTokens,
          ...(sendFormat ? { response_format: sendFormat } : {}),
          ...(reasoningOff ? { reasoning_effort: 'none' } : {}),
        })
      });
      if (response.ok) { structured = !!sendFormat; break; }
      if (response.status === 400 || response.status === 422) {
        const text = await response.text();
        if (reasoningOff && REJECTS_REASONING_RE.test(text)) {
          noteRejected(endpoint, 'reasoning_effort');
          reasoningOff = false;
          continue;
        }
        if (sendFormat && REJECTS_FORMAT_RE.test(text) && !/exceed|context/i.test(text)) {
          noteRejected(endpoint, 'response_format');
          structured = false;
          continue;
        }
        response = { ok: false, status: response.status, statusText: response.statusText, text: async () => text };
      }
      break;
    }

    if (!response.ok) {
      const text = await response.text();
      // status/body ride along so lib/model-health.js can tell a JIT-unloaded
      // model (404 / 503) apart from a per-request failure.
      const err = Object.assign(
        new Error(`API error: ${response.status} ${response.statusText} - ${text}`),
        { status: response.status, body: text }
      );
      if (isContextOverflow(err)) err.contextOverflow = true;
      throw err;
    }

    const data = await response.json();
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const finishReason = choice.finish_reason || null;
    const usage = data.usage || null;
    const content = stripThinking(msg.content || '');

    if (!content) {
      const thought = !!(msg.reasoning_content || msg.reasoning)
        || /<think/i.test(String(msg.content || ''))
        || Number(usage?.completion_tokens_details?.reasoning_tokens) > 0;
      if (thought) {
        throw Object.assign(new Error('the model spent its whole reply thinking and gave no answer'),
          { thinkingOnly: true, finishReason, usage });
      }
      if (finishReason === 'length') {
        throw Object.assign(new Error('the reply was cut off before any answer arrived'),
          { lengthCut: true, finishReason, usage });
      }
      throw new Error('Empty response from model');
    }

    const ms = Date.now() - startTime;
    if (statIndex >= 0) loadBalancer.recordSuccess(statIndex, ms);
    aiSlots.release(slot, { ok: true, ms });
    return {
      content, endpoint, modelId: target.modelId || model || null, slot,
      finishReason, usage, structured, reasoningOff, contextLength,
    };
  } catch (err) {
    if (signal && signal.aborted) {
      // Cut off on purpose: not the model's fault and not the file's. Tagged
      // as "model unavailable" so no processor records it on the row; the
      // queue sees the cut and puts the file back.
      aiSlots.release(slot, { ok: false, aborted: true });
      throw aiSlots.cutError();
    }
    if (statIndex >= 0) loadBalancer.recordError(statIndex);
    aiSlots.release(slot, { ok: false });
    err.endpoint = endpoint;
    if (slot) {
      err.modelId = slot.modelId;
      err.family = slot.family;
      // One copy going away must not look like the whole backend going away:
      // retiring just this slot lets the import queue carry on with the
      // siblings instead of halting the run (see lib/import-queue.js).
      const modelHealth = require('./model-health');
      if (modelHealth.isModelUnavailable(err) && !modelHealth.isModelChoiceNeeded(err)) {
        aiSlots.reportUnavailable(slot);
      }
    }
    throw err;
  } finally {
    // The attribution is only true while the call is open. Between AI calls the
    // file is extracting frames or writing rows, and the panel should say
    // nothing rather than name a copy that is busy with something else.
    if (slot) aiSlots.clearFile(mediaId);
  }
}

/**
 * Embed texts via the OpenAI-compatible /v1/embeddings endpoint.
 * Stub for the semantic-search phase — not called anywhere yet.
 * @param {string[]} texts
 * @returns {Promise<number[][]>} one vector per input text
 */
async function embed(texts) {
  // Inside a scan that AI scan Auto can cut off (lib/ai-slots.js scanSignal):
  // the cut ends this request too.
  const signal = aiSlots.scanSignal();
  if (signal && signal.aborted) throw aiSlots.cutError();
  const { endpoint, statIndex } = loadBalancer.next();
  const url = endpoint.replace('/chat/completions', '/embeddings');
  const startTime = Date.now();

  try {
    const response = await netFetch(url, {
      purpose: 'llm',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({ model: config.embeddings.model, input: texts })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw Object.assign(
        new Error(`Embeddings API error: ${response.status}${text ? ` - ${text}` : ''}`),
        { status: response.status, body: text }
      );
    }
    const data = await response.json();
    loadBalancer.recordSuccess(statIndex, Date.now() - startTime);
    return (data.data || []).map(d => d.embedding);
  } catch (err) {
    if (signal && signal.aborted) throw aiSlots.cutError();
    loadBalancer.recordError(statIndex);
    err.endpoint = url;
    throw err;
  }
}

/**
 * Check if any LM Studio endpoint is available
 */
async function isAvailable() {
  for (const endpoint of config.lmStudio.endpoints) {
    try {
      const response = await netFetch(endpoint.replace('/chat/completions', '/models'), {
        purpose: 'llm',
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) return true;
    } catch {
      // Try next endpoint
    }
  }
  return false;
}

/**
 * Check which endpoints are available
 */
async function checkEndpoints() {
  const results = [];
  for (const endpoint of config.lmStudio.endpoints) {
    try {
      const response = await netFetch(endpoint.replace('/chat/completions', '/models'), {
        purpose: 'llm',
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      results.push({ endpoint, available: response.ok });
    } catch {
      results.push({ endpoint, available: false });
    }
  }
  return results;
}

/**
 * Every model id the configured endpoints report, merged and deduped.
 *
 * Feeds the scan panel's "which model?" picker. Never throws: a backend that is
 * down contributes nothing but its error text, so the caller can render an
 * empty list with an explanation rather than a broken page.
 * @returns {Promise<{ models: {id:string}[], error: string|null }>}
 */
async function listModels() {
  const ids = new Set();
  const errors = [];
  for (const endpoint of config.lmStudio.endpoints) {
    const url = endpoint.replace('/chat/completions', '/models');
    try {
      const response = await netFetch(url, {
        purpose: 'llm',
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { errors.push(`${url}: HTTP ${response.status}`); continue; }
      const data = await response.json();
      // OpenAI shape is { data: [{ id }] }; some forks answer { models: [...] }
      // and a few hand back bare strings.
      for (const m of (Array.isArray(data?.data) ? data.data : (Array.isArray(data?.models) ? data.models : []))) {
        const id = typeof m === 'string' ? m : (m?.id || m?.name);
        if (id) ids.add(String(id));
      }
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
    }
  }
  return {
    models: [...ids].map(id => ({ id })),
    error: (ids.size === 0 && errors.length) ? errors.join('; ') : null,
  };
}

/**
 * Get load balancer statistics
 */
function getStats() {
  return loadBalancer.getStats();
}

/**
 * Swap the AI server list at runtime (POST /api/ai/endpoints).
 *
 * The balancer is rebuilt rather than mutated so its per-endpoint counters line
 * up with the new list; requests already in flight keep the endpoint they were
 * handed, which is why the UI says changes apply to the next file rather than
 * interrupting anything.
 * @param {string[]} list already-normalised chat-completions URLs
 */
function setEndpoints(list) {
  config.lmStudio.endpoints = list.slice();
  loadBalancer = new LoadBalancer(config.lmStudio.endpoints);
  return aiSlots.setEndpoints(config.lmStudio.endpoints);
}

/**
 * Clear the debug log
 */
function clearDebugLog() {
  try {
    if (fs.existsSync(DEBUG_LOG_PATH)) {
      fs.unlinkSync(DEBUG_LOG_PATH);
    }
  } catch {}
}

module.exports = {
  postChat,
  embed,
  endpointRejects,
  noteRejected,
  isContextOverflow,
  stripThinking,
  _resetFeatures,
  tryParseJson,
  repairTruncatedJson,
  parseJsonResponse,
  tryFixJson,
  logBadJson,
  isAvailable,
  checkEndpoints,
  listModels,
  setSessionModel,
  getSessionModel,
  resolveModel,
  resolveTarget,
  currentFamily,
  currentPin,
  setEndpoints,
  getStats,
  clearDebugLog,
  DEBUG_LOG_PATH,
};
