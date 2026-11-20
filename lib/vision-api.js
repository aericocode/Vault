/**
 * Vision API - Analyze media frames with the vision model
 *
 * Thin wrapper over lib/llm-client.js (shared load balancer + JSON parsing),
 * plus the request planning that keeps a scan inside the model's context:
 *
 * 1. Fit: lib/token-budget.js works out how many of the extracted frames fit
 *    the loaded context with room left for the answer, and sends that many,
 *    spread evenly. The answer's max_tokens is the room that is left.
 * 2. Shape: the answer's JSON schema goes in response_format (config/prompts.js
 *    responseFormat), so the reply is valid JSON by construction; a server
 *    that refuses or ignores it gets the prompt-only template instead.
 * 3. Retry smaller: a request the server says is too big, or a reply cut off
 *    by length, is sent again with about half the frames, then without the
 *    transcript. Two retries at most.
 * 4. Keep what arrived: still cut off after that, but the leading fields came
 *    through (content_type, tags or themes, description)? Those are saved and
 *    the row is marked (commands/scan.js, model_used). Nothing is made up.
 */

const fs = require('fs');
const config = require('../config');
const { getPrompt, responseFormat, usesTranscript } = require('../config/prompts');
const llm = require('./llm-client');
const modelHealth = require('./model-health');
const budget = require('./token-budget');
const aiSlots = require('./ai-slots');

/** Retries after the first request. */
const MAX_RETRIES = 2;

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

/** Width and height of a JPEG from its header, or null. */
function jpegSize(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
      let i = 2;
      while (i + 9 < n) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
      return null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** Does this text look like JSON that stopped before it closed? */
function looksCutOff(content) {
  const s = String(content || '').replace(/```(?:json)?/g, '').trim();
  return s.includes('{') && !s.endsWith('}');
}

/**
 * The answer as it is stored: media_elements back to [{type, details}] (the
 * schema asks for an object keyed by type), empty entries left out.
 */
function normalizeAnalysis(parsed) {
  const out = { ...parsed };
  const el = parsed && parsed.media_elements;
  if (el && typeof el === 'object' && !Array.isArray(el)) {
    out.media_elements = Object.entries(el)
      .filter(([, v]) => v != null && String(v).trim() !== '')
      .map(([type, v]) => ({ type, details: typeof v === 'string' ? v : JSON.stringify(v) }));
  }
  return out;
}

/** Enough of a cut-off answer arrived to be worth keeping. */
function salvageable(o) {
  if (!o || typeof o !== 'object') return false;
  const list = (v) => Array.isArray(v) && v.some(x => typeof x === 'string' && x.trim());
  return typeof o.content_type === 'string' && o.content_type.trim() !== ''
    && typeof o.description === 'string' && o.description.trim() !== ''
    && (list(o.tags) || list(o.themes));
}

function _withScanInfo(analysis, info) {
  Object.defineProperty(analysis, '_scan', { value: info, enumerable: false });
  return analysis;
}

/**
 * Analyze frames using the vision model
 * @param {string[]} frames - Array of frame file paths
 * @param {string} filename - Original filename
 * @param {string} mediaType - Type of media (video, image, gif)
 * @param {object} options - Additional options
 * @param {string} options.transcription - Audio transcription to include in analysis
 * @param {string} options.transcriptionLanguage - Detected language of transcription
 * @returns {Promise<object>} Parsed analysis. A non-enumerable `_scan` says
 *   { framesSent, partial, attempts }.
 * @throws {Error} on any failure, message intact — the row's processing_error
 *   is this message, so swallowing it here is what produced the useless
 *   "Processing failed" the user actually saw.
 */
async function analyze(frames, filename, mediaType, options = {}) {
  if (frames.length === 0) {
    throw new Error('no frames to analyze');
  }

  const minFrames = Math.min(frames.length, mediaType === 'video' ? Math.max(1, config.frames.minFrames) : 1);
  const size = jpegSize(frames[0]) || {};
  // Only a transcript the prompt actually carries (English) is worth dropping.
  let withTranscript = mediaType === 'video' && usesTranscript(options);
  let maxFrames = null;
  const cutReplies = [];         // replies cut off by length, newest last
  let last = null;               // { frames, textChars, key, context, transcript }
  let lastProblem = null;        // 'overflow' | 'cut'

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
            const promptOpts = {
              ...options,
              transcription: withTranscript ? options.transcription : null,
              structured: caps.structured,
            };
            const prompt = getPrompt(mediaType, filename, promptOpts);
            const plan = budget.plan({
              key, context: caps.contextLength, textChars: prompt.length,
              available: frames.length, minFrames, maxFrames,
              frameWidth: size.width, frameHeight: size.height,
              reasoning: !caps.reasoningOff,
            });
            const chosen = budget.pickEvenly(frames, plan.frames);
            sent = { frames: chosen.length, textChars: prompt.length, key, context: plan.context, transcript: !!promptOpts.transcription };
            return {
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...loadFramesAsBase64(chosen)] }],
              maxTokens: plan.maxTokens,
              responseFormat: responseFormat(mediaType, promptOpts),
            };
          },
        });
      } catch (err) {
        if (modelHealth.isModelUnavailable(err) || err.scanCutOff) throw err;
        if (llm.isContextOverflow(err) && sent) {
          budget.learnFromOverflow(sent.key, { ...budget.parseOverflow(err.body || err.message), textChars: sent.textChars, frames: sent.frames });
          last = sent; lastProblem = 'overflow';
        } else if (err.lengthCut && sent) {
          budget.learnFromUsage(sent.key, { completionTokens: err.usage?.completion_tokens, finishReason: 'length' });
          last = sent; lastProblem = 'cut';
        } else {
          throw err;
        }
        if (attempt < MAX_RETRIES) ({ maxFrames, withTranscript } = _smaller(sent, attempt, minFrames, withTranscript, filename, lastProblem));
        continue;
      }

      const usage = reply.usage || {};
      budget.learnFromUsage(sent.key, {
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        textChars: sent.textChars, frames: sent.frames, finishReason: reply.finishReason,
      });
      const parsed = llm.tryParseJson(reply.content);
      const cut = reply.finishReason === 'length' || (!parsed && looksCutOff(reply.content));

      if (parsed && !cut) {
        return _withScanInfo(normalizeAnalysis(parsed), { framesSent: sent.frames, partial: false, attempts: attempt + 1 });
      }
      if (parsed && reply.finishReason === 'length') {
        // Whole JSON arrived right at the limit: nothing is missing.
        return _withScanInfo(normalizeAnalysis(parsed), { framesSent: sent.frames, partial: false, attempts: attempt + 1 });
      }
      if (!cut) {
        if (reply.structured) {
          // Sent a schema, got something that is not JSON: this server
          // ignores response_format. Prompt-only from now on, and try again
          // at the same size (this was not a size problem).
          llm.noteRejected(reply.endpoint, 'response_format');
          last = sent;
          continue;
        }
        // Not JSON, not cut off: as before, logged and failed.
        llm.logBadJson(filename, reply.content, new Error('not JSON'));
        throw new Error('the AI reply could not be parsed as JSON (see bad_json_responses.log)');
      }
      cutReplies.push(reply.content);
      last = sent; lastProblem = 'cut';
      if (attempt < MAX_RETRIES) ({ maxFrames, withTranscript } = _smaller(sent, attempt, minFrames, withTranscript, filename, lastProblem));
    }

    // Out of retries. Keep a cut-off answer if enough of it arrived.
    for (let i = cutReplies.length - 1; i >= 0; i--) {
      const partial = llm.repairTruncatedJson(cutReplies[i]);
      if (salvageable(partial)) {
        console.log(`  ⚠ Reply cut short for ${filename}: saved the part that arrived (${last ? last.frames : '?'} pictures)`);
        return _withScanInfo(normalizeAnalysis(partial), { framesSent: last ? last.frames : frames.length, partial: true, attempts: MAX_RETRIES + 1 });
      }
    }
    throw new Error(_exhaustedMessage(lastProblem, last, frames.length));
  } catch (err) {
    const where = err.endpoint ? ` (${err.endpoint})` : '';
    // "The model is gone" must NOT degrade to "this file failed": swallowing it
    // here is what let an unloaded model burn through the rest of the queue one
    // instant failure at a time. Rethrow tagged so the scan queue can halt and
    // keep the remaining work.
    if (modelHealth.isModelUnavailable(err)) {
      // A scan cut off for playback (AI scan on Auto) is not a model problem.
      if (!err.scanCutOff) console.error(`  ⚠ Vision model unavailable${where}: ${modelHealth.describe(err)}`);
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

/** The next, smaller request: half the frames first, then no transcript. */
function _smaller(sent, attempt, minFrames, withTranscript, filename, problem) {
  let maxFrames = sent.frames;
  const half = Math.max(minFrames, Math.floor(sent.frames / 2));
  const canHalve = half < sent.frames;
  if (attempt === 0 && canHalve) {
    maxFrames = half;
  } else if (withTranscript) {
    withTranscript = false;
  } else {
    maxFrames = half;
  }
  const why = problem === 'overflow' ? 'too big for the model\'s context' : 'reply cut off';
  console.log(`  ↻ ${filename}: ${why}, retrying with ${maxFrames} pictures${withTranscript ? '' : sent.transcript ? ' and no transcript' : ''}`);
  return { maxFrames, withTranscript };
}

function _exhaustedMessage(problem, last, available) {
  const n = last ? last.frames : available;
  if (!problem) return 'the AI reply could not be parsed as JSON';
  const pics = `${n} picture${n === 1 ? '' : 's'}`;
  const ctx = last && last.context ? ` (context ${last.context} tokens)` : '';
  if (problem === 'overflow') {
    return `too big for the model's context even with ${pics}${ctx}. Load the model with a longer context length, then retry`;
  }
  return `the reply was cut off before it finished, even after retrying with ${pics}${ctx}. Load the model with a longer context length, then retry`;
}

module.exports = {
  analyze,
  normalizeAnalysis,
  salvageable,
  jpegSize,
  isAvailable: llm.isAvailable,
  checkEndpoints: llm.checkEndpoints,
  getStats: llm.getStats,
  parseJsonResponse: llm.parseJsonResponse,
  clearDebugLog: llm.clearDebugLog,
  DEBUG_LOG_PATH: llm.DEBUG_LOG_PATH,
};
