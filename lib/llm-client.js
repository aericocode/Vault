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
    const model = options.model ?? config.lmStudio.model;
    const response = await netFetch(endpoint, {
      purpose: 'llm',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // LM Studio ignores `model` (serves whatever is loaded); Ollama/vLLM
        // require it — omitted entirely when unset so LM Studio stays as-is
        ...(model ? { model } : {}),
        messages,
        temperature: options.temperature ?? config.lmStudio.temperature,
        max_tokens: options.maxTokens ?? config.lmStudio.maxTokens,
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error: ${response.status} ${response.statusText} - ${text}`);
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
      throw new Error(`Embeddings API error: ${response.status}`);
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
  getStats,
  clearDebugLog,
  DEBUG_LOG_PATH,
};
