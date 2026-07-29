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

// Single shared load balancer across ALL LLM traffic
const loadBalancer = new LoadBalancer(config.lmStudio.endpoints);

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
  return sessionModel;
}

function getSessionModel() {
  return sessionModel;
}

/** Which model id (if any) a request should carry. */
function resolveModel(options = {}) {
  return options.model || config.lmStudio.model || sessionModel || null;
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
      rawContent = '[redacted — vault mode: raw response not written to plaintext log]';
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
  const { endpoint, statIndex } = loadBalancer.next();
  const startTime = Date.now();

  try {
    const model = resolveModel(options);
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

    loadBalancer.recordSuccess(statIndex, Date.now() - startTime);
    return { content, endpoint };
  } catch (err) {
    loadBalancer.recordError(statIndex);
    err.endpoint = endpoint;
    throw err;
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
  getStats,
  clearDebugLog,
  DEBUG_LOG_PATH,
};
