/**
 * Text API - Send text to LLM for summarization/analysis
 *
 * Thin wrapper over lib/llm-client.js (shared load balancer + JSON parsing).
 * The document prompt template lives in config/prompts.js with the others.
 * Falls back to truncation if LLM unavailable.
 *
 * Same care as the vision scan (lib/vision-api.js): the answer's shape goes in
 * response_format when the server takes it, reasoning is switched off where
 * the server allows, the text is cut to what fits the model's context with
 * room for the answer (lib/token-budget.js), and a request that is too big or
 * an answer cut off by length is retried with half the text, twice at most.
 */

const config = require('../config');
const { getDocumentPrompt, documentResponseFormat } = require('../config/prompts');
const llm = require('./llm-client');
const modelHealth = require('./model-health');
const budget = require('./token-budget');
const aiSlots = require('./ai-slots');

const MAX_RETRIES = 2;

/**
 * Analyze document text using LLM
 * @param {string} text - Document text content
 * @param {string} filename - Original filename
 * @param {object} options - Analysis options
 * @param {number} [options.maxInputChars] most text to send (8000)
 * @param {boolean} [options.sample] start, middle and end instead of the head
 * @returns {Promise<object|null>} Analysis result or null on failure
 */
async function analyze(text, filename, options = {}) {
  if (!text || text.trim().length === 0) {
    return null;
  }

  const wanted = options.maxInputChars || 8000;
  let limit = null;            // characters allowed after a retry

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      aiSlots.throwIfCut();
      let sent = null;
      let reply;
      try {
        reply = await llm.postChat(null, {
          reasoningOff: !config.lmStudio.scanReasoning,
          prepare: (caps) => {
            const key = budget.keyFor(caps.modelId, caps.endpoint);
            const fits = budget.planText({ key, context: caps.contextLength, fixedChars: 1200, reasoning: !caps.reasoningOff });
            const chars = Math.max(200, Math.min(wanted, fits.chars, limit ?? Infinity));
            const prompt = getDocumentPrompt(filename, text, { ...options, maxInputChars: chars, structured: caps.structured });
            sent = { key, chars: Math.min(chars, text.length) };
            return {
              messages: [{ role: 'user', content: prompt }],
              maxTokens: options.maxTokens ?? budget.textMaxTokens(fits.context, prompt.length, !caps.reasoningOff),
              responseFormat: documentResponseFormat(),
            };
          },
        });
      } catch (err) {
        if (modelHealth.isModelUnavailable(err) || err.scanCutOff) throw err;
        if ((llm.isContextOverflow(err) || err.lengthCut) && sent && attempt < MAX_RETRIES) {
          if (llm.isContextOverflow(err)) budget.learnFromOverflow(sent.key, budget.parseOverflow(err.body || err.message));
          limit = Math.floor(sent.chars / 2);
          console.log(`  ↻ ${filename}: too big for the model, retrying with ${limit} characters`);
          continue;
        }
        throw err;
      }

      const usage = reply.usage || {};
      budget.learnFromUsage(sent.key, { completionTokens: usage.completion_tokens, finishReason: reply.finishReason });
      const parsed = llm.tryParseJson(reply.content);
      if (parsed && (reply.finishReason !== 'length' || reply.content.trim().endsWith('}'))) return parsed;
      if (reply.finishReason === 'length' && attempt < MAX_RETRIES) {
        limit = Math.floor(sent.chars / 2);
        console.log(`  ↻ ${filename}: reply cut off, retrying with ${limit} characters`);
        continue;
      }
      if (!parsed && reply.structured && reply.finishReason !== 'length' && attempt < MAX_RETRIES) {
        // A schema went out and something else came back: prompt-only from now on.
        llm.noteRejected(reply.endpoint, 'response_format');
        continue;
      }
      if (reply.finishReason === 'length') throw new Error('the reply was cut off before it finished, even with less text');
      // As before: logged (content-free in vault mode) and the caller falls back.
      return llm.parseJsonResponse(reply.content, filename);
    }
    return null;
  } catch (err) {
    const where = err.endpoint ? ` (${err.endpoint})` : '';
    // Same rule as vision-api: an unloaded model halts the queue, it doesn't
    // quietly fail every remaining file. See lib/model-health.js.
    if (modelHealth.isModelUnavailable(err)) {
      // A scan cut off for playback (AI scan on Auto) is not a model problem.
      if (!err.scanCutOff) console.error(`  ⚠ Text model unavailable${where}: ${modelHealth.describe(err)}`);
      throw modelHealth.tag(err);
    }
    console.error(`  Text API error${where}: ${err.message}`);
    return null;
  }
}

/**
 * Simple fallback summarization without LLM
 * Just extracts first paragraph and keywords
 */
function simpleSummarize(text, filename) {
  const lines = text.split('\n').filter(l => l.trim());

  // Get first few meaningful lines as description
  const descLines = [];
  let charCount = 0;
  for (const line of lines) {
    if (charCount > 500) break;
    if (line.length > 10) {
      descLines.push(line.trim());
      charCount += line.length;
    }
  }

  const description = descLines.slice(0, 3).join(' ').slice(0, 500);

  // Extract potential keywords (common words > 4 chars, appearing multiple times)
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] || 0) + 1;
  }

  const tags = Object.entries(freq)
    .filter(([w, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);

  return {
    description: description || 'Document content',
    document_type: 'other',
    language: 'unknown',
    themes: [],
    tags,
    has_sensitive_data: false,
    sentiment: 'neutral',
  };
}

module.exports = {
  analyze,
  simpleSummarize,
  isAvailable: llm.isAvailable,
  getDocumentPrompt,
};
