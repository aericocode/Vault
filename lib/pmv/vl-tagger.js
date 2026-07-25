/**
 * PMV Studio — vision-language frame tagging (CJS port of the sample's
 * vl-tagger). Endpoint comes from Vault's config (config.lmStudio.endpoints)
 * instead of a hardcode.
 *
 * Port fixes vs. the sample:
 *  - error/timeout frames get relevance:null and are EXCLUDED from segment
 *    relevance averaging (the original defaulted them to 5, skewing scores)
 */

const fs = require('fs/promises');
const path = require('path');
const config = require('../../config');
const { netFetch } = require('../net');

function defaultVlConfig() {
  return {
    endpoint: config.lmStudio.endpoints[0],
    model: 'default',
    maxTokens: 200,
    concurrency: 4,
  };
}

async function frameToBase64(framePath) {
  const buffer = await fs.readFile(framePath);
  const ext = path.extname(framePath).slice(1);
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${buffer.toString('base64')}`;
}

async function tagFrame(framePath, prompt, cfg) {
  const imageData = await frameToBase64(framePath);
  const body = {
    model: cfg.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageData } },
        { type: 'text', text: prompt },
      ],
    }],
    max_tokens: cfg.maxTokens,
    temperature: 0.3,
  };

  const res = await netFetch(cfg.endpoint, {
    purpose: 'llm',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`VL API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function buildPrompt(userCriteria) {
  const base = `Analyze this video frame. Respond with a JSON object only, no markdown:
{
  "tags": ["tag1", "tag2", ...],
  "description": "brief scene description",
  "action_level": "high|medium|low",
  "mood": "energetic|calm|dramatic|dark|bright|neutral",
  "dominant_colors": ["color1", "color2"]
}`;
  if (userCriteria) {
    return `${base}\n\nThe user is specifically looking for: "${userCriteria}"\nInclude a "relevance" field (0-10) indicating how well this frame matches their criteria.`;
  }
  return base;
}

function parseVLResponse(text) {
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      tags: [], description: text.slice(0, 200),
      action_level: 'medium', mood: 'neutral',
      dominant_colors: [], relevance: null, _parseError: true,
    };
  }
}

/** Tag frames with a worker pool of cfg.concurrency parallel requests. */
async function tagFrames(frames, userCriteria, cfgOverride = {}, onProgress) {
  const cfg = { ...defaultVlConfig(), ...cfgOverride };
  const prompt = buildPrompt(userCriteria);
  const total = frames.length;
  const results = new Array(total);
  let completed = 0;

  async function processFrame(idx) {
    const frame = frames[idx];
    try {
      const parsed = parseVLResponse(await tagFrame(frame.framePath, prompt, cfg));
      results[idx] = {
        ...frame,
        vlTags: parsed.tags || [],
        vlDescription: parsed.description || '',
        actionLevel: parsed.action_level || 'medium',
        mood: parsed.mood || 'neutral',
        dominantColors: parsed.dominant_colors || [],
        relevance: typeof parsed.relevance === 'number' ? parsed.relevance : null,
      };
    } catch (err) {
      // Failed frames carry no relevance signal — excluded from averages
      results[idx] = {
        ...frame,
        vlTags: [], vlDescription: '', actionLevel: 'medium', mood: 'neutral',
        dominantColors: [], relevance: null, vlError: err.message,
      };
    }
    completed++;
    onProgress?.({ stage: 'vl-tagging', current: completed, total, percent: Math.round((completed / total) * 100) });
  }

  let nextIdx = 0;
  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= total) break;
      await processFrame(idx);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(cfg.concurrency, total); w++) workers.push(worker());
  await Promise.all(workers);

  return results.filter(Boolean);
}

/**
 * Fold frame tags into their parent segments. relevanceFloor (§6.4 of the
 * spec) lets library-metadata matches guarantee a minimum relevance even when
 * VL is sparse for that segment.
 */
function applyTagsToSegments(segments, taggedFrames, { relevanceFloor = 0 } = {}) {
  for (const segment of segments) {
    const segFrames = taggedFrames.filter(f => f.time >= segment.start && f.time < segment.end);
    if (segFrames.length === 0) {
      if (relevanceFloor > 0) segment.vlRelevance = Math.max(segment.vlRelevance || 0, relevanceFloor);
      continue;
    }

    const tagCounts = {};
    for (const f of segFrames) for (const tag of f.vlTags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    segment.vlTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);

    const scored = segFrames.filter(f => typeof f.relevance === 'number');
    const bestFrame = segFrames.reduce((best, f) => ((f.relevance ?? -1) > (best.relevance ?? -1) ? f : best));
    segment.vlDescription = bestFrame.vlDescription;
    segment.mood = bestFrame.mood;

    if (scored.length > 0) {
      segment.vlRelevance = scored.reduce((sum, f) => sum + f.relevance, 0) / scored.length;
    }
    segment.vlRelevance = Math.max(segment.vlRelevance || 0, relevanceFloor);
    if (segment.vlRelevance > 0) {
      segment.score = segment.score * 0.5 + (segment.vlRelevance / 10) * 0.5;
    }
  }
  return segments;
}

async function checkVLAvailability(cfgOverride = {}) {
  const cfg = { ...defaultVlConfig(), ...cfgOverride };
  try {
    const res = await netFetch(cfg.endpoint.replace('/chat/completions', '/models'), {
      purpose: 'llm',
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      return { available: true, models: data.data?.map(m => m.id) || [] };
    }
    return { available: false, error: `HTTP ${res.status}` };
  } catch {
    return { available: false, error: 'Connection failed — is LM Studio running?' };
  }
}

module.exports = { tagFrames, applyTagsToSegments, checkVLAvailability, buildPrompt };
