/**
 * Vision API - Analyze media frames with the vision model
 *
 * Thin wrapper over lib/llm-client.js (shared load balancer + JSON parsing).
 */

const fs = require('fs');
const { getPrompt } = require('../config/prompts');
const llm = require('./llm-client');
const modelHealth = require('./model-health');

/**
 * Load frames as base64-encoded image content for API
 */
function loadFramesAsBase64(frames) {
  return frames.map(framePath => {
    const data = fs.readFileSync(framePath);
    return {
      type: 'image_url',
      image_url: {
        url: `data:image/jpeg;base64,${data.toString('base64')}`
      }
    };
  });
}

/**
 * Analyze frames using the vision model
 * @param {string[]} frames - Array of frame file paths
 * @param {string} filename - Original filename
 * @param {string} mediaType - Type of media (video, image, gif)
 * @param {object} options - Additional options
 * @param {string} options.transcription - Audio transcription to include in analysis
 * @param {string} options.transcriptionLanguage - Detected language of transcription
 * @returns {Promise<object|null>} Parsed analysis or null on failure
 */
async function analyze(frames, filename, mediaType, options = {}) {
  if (frames.length === 0) {
    return null;
  }

  const imageContents = loadFramesAsBase64(frames);
  const prompt = getPrompt(mediaType, filename, options);

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        ...imageContents
      ]
    }
  ];

  try {
    const { content } = await llm.postChat(messages);
    return llm.parseJsonResponse(content, filename);
  } catch (err) {
    const where = err.endpoint ? ` (${err.endpoint})` : '';
    // "The model is gone" must NOT degrade to "this file failed": swallowing it
    // here is what let an unloaded model burn through the rest of the queue one
    // instant failure at a time. Rethrow tagged so the scan queue can halt and
    // keep the remaining work; genuine per-file faults still return null.
    if (modelHealth.isModelUnavailable(err)) {
      console.error(`  ⚠ Vision model unavailable${where}: ${modelHealth.describe(err)}`);
      throw modelHealth.tag(err);
    }
    console.log(`  ✗ Vision API error for ${filename}${where}: ${err.message}`);
    return null;
  }
}

module.exports = {
  analyze,
  isAvailable: llm.isAvailable,
  checkEndpoints: llm.checkEndpoints,
  getStats: llm.getStats,
  parseJsonResponse: llm.parseJsonResponse,
  clearDebugLog: llm.clearDebugLog,
  DEBUG_LOG_PATH: llm.DEBUG_LOG_PATH,
};
