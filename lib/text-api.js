/**
 * Text API - Send text to LLM for summarization/analysis
 *
 * Thin wrapper over lib/llm-client.js (shared load balancer + JSON parsing).
 * The document prompt template lives in config/prompts.js with the others.
 * Falls back to truncation if LLM unavailable.
 */

const { getDocumentPrompt } = require('../config/prompts');
const llm = require('./llm-client');
const modelHealth = require('./model-health');

/**
 * Analyze document text using LLM
 * @param {string} text - Document text content
 * @param {string} filename - Original filename
 * @param {object} options - Analysis options
 * @returns {Promise<object|null>} Analysis result or null on failure
 */
async function analyze(text, filename, options = {}) {
  if (!text || text.trim().length === 0) {
    return null;
  }

  const prompt = getDocumentPrompt(filename, text, options);

  try {
    const { content } = await llm.postChat(
      [{ role: 'user', content: prompt }],
      { maxTokens: options.maxTokens }
    );
    return llm.parseJsonResponse(content, filename);
  } catch (err) {
    const where = err.endpoint ? ` (${err.endpoint})` : '';
    // Same rule as vision-api: an unloaded model halts the queue, it doesn't
    // quietly fail every remaining file. See lib/model-health.js.
    if (modelHealth.isModelUnavailable(err)) {
      console.error(`  ⚠ Text model unavailable${where}: ${modelHealth.describe(err)}`);
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
