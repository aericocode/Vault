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

/** @returns {string|null} the normalised value actually stored */
function setSessionModel(id) {
  sessionModel = (typeof id === 'string' && id.trim()) ? id.trim() : null;
  // The slot set did not move, but which slots are USABLE just did: the import
  // queue sizes itself off the chosen family, so it has to hear about this.
  aiSlots.notifyChange();
  return sessionModel;
}

function getSessionModel() {
  return sessionModel;
}

/** Which model id (if any) a request should carry, ignoring slots. */
function resolveModel(options = {}) {
  return options.model || config.lmStudio.model || sessionModel || null;
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
  const loaded = aiSlots.activeFamilies();
  if (loaded.length === 1) {
    const slot = aiSlots.pick(loaded[0]);
    if (slot) return { family: loaded[0], modelId: slot.modelId, slot, pinnedId: null };
  }
  return { family: null, modelId: null, slot: null, pinnedId: null };
}

/** The family scans are currently going to, for the queue and instance views. */
function currentFamily() {
  return resolveTarget().family;
}

/** The one copy scans are pinned to, or null when the whole family is in use. */
function currentPin() {
  return resolveTarget().pinnedId;
}

/**
 * Log bad JSON response for debugging
 */
function logBadJson(filename, rawContent, error) {
  try {
    // Vault mode: the raw LLM response can echo content from encrypted source
    // drives — never spill it into the plaintext debug log. Keep a redacted
    // breadcrumb (filename + error) so the failure is still traceable.
    if (config.getDbPassword()) {
      rawContent = '[redacted: vault mode, raw response not written to plaintext log]';
    }
    const timestamp = new Date().toISOString();
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

/**
 * POST a chat completion to the next endpoint in the balancer.
 * Returns { content, endpoint }. Throws on API error (err.endpoint set).
 */
async function postChat(messages, options = {}) {
  const target = resolveTarget(options);
  const slot = target.slot;
  // Per-endpoint stats stay meaningful either way: a slot still belongs to one
  // endpoint, so getStats() keeps reporting the same numbers it always did.
  const endpoint = slot ? slot.endpoint : loadBalancer.next().endpoint;
  const statIndex = loadBalancer.endpoints.indexOf(endpoint);
  if (slot) aiSlots.acquire(slot);
  // Which file this call belongs to, if anything upstream said. Only the import
  // queue does, which is the only place that needs the answer back.
  const mediaId = aiSlots.fileContext.getStore()?.mediaId;
  if (slot) aiSlots.noteFile(mediaId, slot);
  const startTime = Date.now();

  try {
    const model = slot ? target.modelId : resolveModel(options);
    const response = await netFetch(endpoint, {
      purpose: 'llm',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // LM Studio ignores `model` while ONE model is loaded (it serves that
        // one); Ollama/vLLM always require it — omitted entirely when unset so
        // the single-model LM Studio case stays as-is. Load a second model and
        // LM Studio starts rejecting the omission with a 400; the scan panel's
        // picker answers that by filling sessionModel above.
        ...(model ? { model } : {}),
        messages,
        temperature: options.temperature ?? config.lmStudio.temperature,
        max_tokens: options.maxTokens ?? config.lmStudio.maxTokens,
      })
    });

    if (!response.ok) {
      const text = await response.text();
      // status/body ride along so lib/model-health.js can tell a JIT-unloaded
      // model (404 / 503) apart from a per-request failure.
      throw Object.assign(
        new Error(`API error: ${response.status} ${response.statusText} - ${text}`),
        { status: response.status, body: text }
      );
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    if (!content) {
      throw new Error('Empty response from model');
    }

    const ms = Date.now() - startTime;
    if (statIndex >= 0) loadBalancer.recordSuccess(statIndex, ms);
    aiSlots.release(slot, { ok: true, ms });
    return { content, endpoint, modelId: target.modelId, slot };
  } catch (err) {
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
  const { endpoint, statIndex } = loadBalancer.next();
  const url = endpoint.replace('/chat/completions', '/embeddings');
  const startTime = Date.now();

  try {
    const response = await netFetch(url, {
      purpose: 'llm',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
