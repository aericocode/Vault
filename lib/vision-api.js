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
 * @returns {Promise<object>} Parsed analysis
 * @throws {Error} on any failure, message intact — the row's processing_error
 *   is this message, so swallowing it here is what produced the useless
 *   "Processing failed" the user actually saw.
 */
async function analyze(frames, filename, mediaType, options = {}) {
  if (frames.length === 0) {
    throw new Error('no frames to analyze');
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
    const parsed = llm.parseJsonResponse(content, filename);
    if (!parsed) {
      // parseJsonResponse logs the raw body and returns null; a null here is a
      // real, per-file failure and deserves a message of its own.
      throw new Error('the AI reply could not be parsed as JSON (see bad_json_responses.log)');
    }
    return parsed;
  } catch (err) {
    const where = err.endpoint ? ` (${err.endpoint})` : '';
    // "The model is gone" must NOT degrade to "this file failed": swallowing it
    // here is what let an unloaded model burn through the rest of the queue one
    // instant failure at a time. Rethrow tagged so the scan queue can halt and
    // keep the remaining work.
    if (modelHealth.isModelUnavailable(err)) {
      console.error(`  ⚠ Vision model unavailable${where}: ${modelHealth.describe(err)}`);
      throw modelHealth.tag(err);
    }
    // Per-file faults used to return null, which reached commands/scan.js as
    // "no analysis, no reason" and got stored as the literal "Processing
    // failed" — erasing whatever real error the row already had. Rethrow so the
    // message survives all the way into processing_error.
    console.log(`  ✗ Vision API error for ${filename}${where}: ${err.message}`);
    throw err;
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
