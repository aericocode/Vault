/**
 * Token budget for scan requests: how much of the model's context a request
 * may use, how many frames fit, and how much room the answer gets.
 *
 * Why this exists: a scan used to send every extracted frame (up to 35), the
 * whole prompt and an 8,000-character transcript, and asked for a fixed
 * max_tokens of 8000. Nothing looked at the model's context length, so a long
 * video on a model loaded with a small context either overflowed or left the
 * answer too little room, and a reasoning model spent the 8000 tokens thinking
 * before the JSON was finished. Both showed up as "cut off" failures.
 *
 * The rule, per request:
 *
 *   context      = the loaded context length of the model the request goes to
 *                  (LM Studio /api/v0/models loaded_context_length, kept on the
 *                  slot by lib/ai-slots.js), else one learned from an overflow
 *                  error (llama.cpp reports n_ctx), else DEFAULT_CONTEXT.
 *   usable       = context * USABLE_SHARE (a margin for the chat template and
 *                  estimate error)
 *   text tokens  = characters / TEXT_CHARS_PER_TOKEN_BUDGET (3, deliberately
 *                  pessimistic: English runs near 4 characters a token)
 *   frame tokens = the learned cost for this model (see below) * FRAME_MARGIN,
 *                  else estimateFrameTokens(width, height)
 *   reserve      = room kept for the answer: ANSWER_RESERVE, raised by what
 *                  this model's answers have actually needed
 *   frames       = floor((usable - text - reserve) / frame tokens), clamped to
 *                  [minFrames, frames extracted]
 *   max_tokens   = min(ANSWER_GUARD, context - estimated input), at least
 *                  MIN_ANSWER. The answer gets whatever room is left; the guard
 *                  only stops a model that loops from running for minutes. The
 *                  JSON schema (config/prompts.js) bounds the real answer, so
 *                  the guard should rarely matter.
 *
 * Learning (memory only, per model family, nothing on disk): after every reply
 * the server's usage.prompt_tokens gives the real input size. Taking the text
 * at a realistic 4 characters a token, what is left divided by the frames sent
 * is that model's real per-frame cost, and the next file uses it (with a 10%
 * margin). An overflow error that names n_ctx teaches the context length; a
 * reply cut off by length raises the answer reserve, so the next file starts
 * with fewer frames rather than failing the same way.
 */

const config = require('../config');

/** Context assumed when the server does not say (not LM Studio). AI_CONTEXT_LENGTH overrides. */
const DEFAULT_CONTEXT = (() => {
  const n = parseInt(process.env.AI_CONTEXT_LENGTH, 10);
  return Number.isFinite(n) && n >= 1024 ? n : 16384;
})();
const USABLE_SHARE = 0.95;
const TEXT_CHARS_PER_TOKEN_BUDGET = 3;     // pessimistic, for planning
const TEXT_CHARS_PER_TOKEN_LEARN = 4;      // realistic, for learning frame cost
const FRAME_MARGIN = 1.1;
/** Room kept for a vision scan's answer until this model has shown what it needs. */
const ANSWER_RESERVE = 2500;
/** Same for the document / audio text analysis, whose answer is much smaller. */
const TEXT_ANSWER_RESERVE = 1000;
/** Upper bound on max_tokens: about two to three minutes of output on a local GPU. */
const ANSWER_GUARD = 8192;
/** Upper bound when the server would not let reasoning be switched off. */
const ANSWER_GUARD_REASONING = 16384;
const MIN_ANSWER = 512;
/** A plausible per-frame cost: anything outside this is a broken usage reading. */
const FRAME_TOKENS_MIN = 16;
const FRAME_TOKENS_MAX = 4096;
/** Plausible context lengths. */
const CONTEXT_MIN = 256;
const CONTEXT_MAX = 10_000_000;
/** Largest token count a usage block is believed for. */
const MAX_TOKENS_READING = 10_000_000;
const MAX_CHARS = 100_000_000;
/** Text size planned for when the caller's figure is not a number. */
const UNKNOWN_TEXT_CHARS = 12_000;

/** n when it is a whole number in [min, max], else null. */
function _count(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
/** Chat template, role markers and per-image wrapper tokens, roughly. */
const REQUEST_OVERHEAD = 64;

/**
 * Conservative token cost of one frame for a model nobody has measured yet.
 *
 * Most current local vision models (Qwen2-VL / Qwen2.5-VL / Qwen3-VL and the
 * MiniCPM-V builds on them) turn a picture into one token per 28x28 pixel block
 * (14 px patches merged 2x2); Qwen3.5-based models use 32 px blocks, which is
 * cheaper. Gemma 3 is a flat 256 per picture, LLaVA 1.5 a flat 576 (LLaVA 1.6
 * can reach 2,880 and is not covered: the retry and the learning handle it).
 * So: one token per 28x28 block, never under 256, plus 16 for the image markers.
 * Measured on minicpm-v-4.6 (LM Studio, 2026-11): a 600x338 frame costs about
 * 203 tokens; this estimate says 302, which is the intended direction.
 */
function estimateFrameTokens(width, height) {
  const w = Number(width) > 0 ? Number(width) : config.frames.maxWidth;
  const h = Number(height) > 0 ? Number(height) : Math.round(w * 9 / 16);
  return Math.max(256, Math.ceil(w / 28) * Math.ceil(h / 28)) + 16;
}

/** Planning estimate of a text's tokens. */
function textTokens(chars) {
  return Math.ceil(Math.max(0, chars) / TEXT_CHARS_PER_TOKEN_BUDGET);
}

/* ── What has been learned, per model ─────────────────────────────────── */

/** key -> { frameTokens, context, reserve, samples } */
const _learned = new Map();

function keyFor(modelId, endpoint) {
  if (modelId) {
    // Copies of one model (m, m:2, m:3) cost the same: learn once for all.
    const m = /^(.+):(\d+)$/.exec(String(modelId));
    return m && Number(m[2]) >= 2 ? m[1] : String(modelId);
  }
  return `endpoint:${endpoint || ''}`;
}

function _entry(key) {
  let e = _learned.get(key);
  if (!e) { e = { frameTokens: null, context: null, reserve: null, samples: 0 }; _learned.set(key, e); }
  return e;
}

function learned(key) {
  const e = _learned.get(key);
  return e ? { ...e } : null;
}

/**
 * A reply came back with usage. `textChars` is the text the request carried,
 * `frames` how many pictures.
 */
function learnFromUsage(key, { promptTokens, completionTokens, textChars = 0, frames = 0, finishReason = null } = {}) {
  const e = _entry(key);
  const chars = _count(textChars, 0, MAX_CHARS) ?? 0;
  const n = _count(frames, 1, 10_000);
  const prompt = _count(promptTokens, 1, MAX_TOKENS_READING);
  if (prompt && n) {
    const text = Math.ceil(chars / TEXT_CHARS_PER_TOKEN_LEARN) + REQUEST_OVERHEAD;
    const per = Math.round((prompt - text) / n);
    // A reading outside what any vision model costs per frame is a broken
    // usage block, not news about the model: ignored.
    if (per >= FRAME_TOKENS_MIN && per <= FRAME_TOKENS_MAX) {
      // A bigger reading wins at once (being wrong that way overflows); a
      // smaller one only eases the figure down.
      e.frameTokens = e.frameTokens == null || per > e.frameTokens
        ? per
        : Math.round(e.frameTokens * 0.8 + per * 0.2);
      e.samples++;
    }
  }
  completionTokens = _count(completionTokens, 1, MAX_TOKENS_READING);
  if (completionTokens) {
    if (finishReason === 'length') {
      // The answer did not fit in what was left: keep more room next time.
      e.reserve = Math.min(ANSWER_GUARD, Math.max(e.reserve || 0, ANSWER_RESERVE, Math.ceil(completionTokens * 1.5)));
    } else {
      const need = Math.ceil(completionTokens * 1.25);
      if (need > (e.reserve || 0)) e.reserve = Math.min(ANSWER_GUARD, need);
    }
  }
}

/**
 * The server refused the request as too big. llama.cpp (and LM Studio, which
 * runs it) say how big it was and how big the context is.
 */
function learnFromOverflow(key, { nPrompt = null, nCtx = null, textChars = 0, frames = 0 } = {}) {
  const e = _entry(key);
  const ctx = _count(nCtx, CONTEXT_MIN, CONTEXT_MAX);
  if (ctx) e.context = ctx;
  const prompt = _count(nPrompt, 1, MAX_TOKENS_READING);
  const n = _count(frames, 1, 10_000);
  if (prompt && n) {
    // The count can be a lower bound (the server may stop counting at the
    // limit), so it only ever raises the per-frame figure, and only within
    // the plausible range.
    const chars = _count(textChars, 0, MAX_CHARS) ?? 0;
    const per = Math.round((prompt - Math.ceil(chars / TEXT_CHARS_PER_TOKEN_LEARN) - REQUEST_OVERHEAD) / n);
    if (per >= FRAME_TOKENS_MIN && per <= FRAME_TOKENS_MAX && per > (e.frameTokens || 0)) e.frameTokens = per;
  }
}

/** Pull n_prompt_tokens / n_ctx out of an overflow error body, if it has them. */
function parseOverflow(text) {
  const s = String(text || '');
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
  return {
    nPrompt: num(/"n_prompt_tokens"\s*:\s*(\d+)/) ?? num(/request \((\d+) tokens\)/i),
    nCtx: num(/"n_ctx"\s*:\s*(\d+)/) ?? num(/context size \((\d+) tokens\)/i) ?? num(/context length (?:is|of) (\d+)/i),
  };
}

/** Context length to plan with. */
function contextFor(key, reported) {
  const r = _count(reported, CONTEXT_MIN, CONTEXT_MAX);
  if (r) return r;
  const e = _learned.get(key);
  if (e && e.context) return e.context;
  return DEFAULT_CONTEXT;
}

/**
 * Plan one request.
 * @param {object} o
 * @param {string} o.key           learning key (keyFor)
 * @param {number|null} o.context  reported loaded context, or null
 * @param {number} o.textChars     prompt + transcript characters
 * @param {number} o.available     frames extracted
 * @param {number} o.minFrames
 * @param {number|null} [o.maxFrames] an upper bound from a retry (fewer than last time)
 * @param {number} [o.frameWidth]
 * @param {number} [o.frameHeight]
 * @param {number} [o.reserve]     default answer reserve for this kind of request
 * @param {boolean} [o.reasoning]  true when reasoning could not be switched off
 * @returns {{ frames, maxTokens, context, perFrame, inputTokens, fits }}
 */
function plan(o = {}) {
  const context = contextFor(o.key, o.context);
  const e = _learned.get(o.key);
  // Every input is checked: whatever arrives, the answer is whole numbers.
  // A text size that is not a number is planned as a long one.
  const learnedFrame = e && _count(e.frameTokens, FRAME_TOKENS_MIN, FRAME_TOKENS_MAX);
  const perFrame = learnedFrame
    ? Math.ceil(learnedFrame * FRAME_MARGIN)
    : estimateFrameTokens(_count(o.frameWidth, 1, 100_000), _count(o.frameHeight, 1, 100_000));
  // What answers have needed, but never more than half the context: a model
  // that once looped up to the guard must not starve every later file.
  const baseReserve = _count(o.reserve, 1, ANSWER_GUARD_REASONING) ?? ANSWER_RESERVE;
  const reserve = Math.max(baseReserve,
    Math.min((e && _count(e.reserve, 1, ANSWER_GUARD)) || 0, Math.floor(context / 2)));
  const text = textTokens(_count(o.textChars, 0, MAX_CHARS) ?? UNKNOWN_TEXT_CHARS) + REQUEST_OVERHEAD;
  const usable = Math.floor(context * USABLE_SHARE);
  const available = _count(o.available, 0, 10_000) ?? 0;
  const minFrames = Math.min(available, _count(o.minFrames, 1, 10_000) ?? 1);
  let frames = available ? Math.floor((usable - text - reserve) / perFrame) : 0;
  const cap = _count(o.maxFrames, 0, 10_000);
  if (cap != null) frames = Math.min(frames, cap);
  frames = Math.max(minFrames, Math.min(available, frames));
  if (!Number.isInteger(frames)) frames = minFrames;
  const inputTokens = text + frames * perFrame;
  const guard = o.reasoning ? ANSWER_GUARD_REASONING : ANSWER_GUARD;
  let maxTokens = Math.max(MIN_ANSWER, Math.min(guard, context - inputTokens));
  if (!Number.isInteger(maxTokens)) maxTokens = ANSWER_RESERVE;
  return { frames, maxTokens, context, perFrame, inputTokens, fits: inputTokens + reserve <= usable };
}

/** How many text characters fit, for the text-only analysis. */
function planText(o) {
  const context = contextFor(o.key, o.context);
  const e = _learned.get(o.key);
  const reserve = Math.max(o.reserve ?? TEXT_ANSWER_RESERVE, (e && e.reserve) || 0);
  const usable = Math.floor(context * USABLE_SHARE);
  const room = usable - reserve - REQUEST_OVERHEAD - textTokens(o.fixedChars || 0);
  const chars = Math.max(500, room * TEXT_CHARS_PER_TOKEN_BUDGET);
  const guard = o.reasoning ? ANSWER_GUARD_REASONING : ANSWER_GUARD;
  return { chars, context, reserve, guard };
}

/** max_tokens for a text request of `chars` characters. */
function textMaxTokens(context, chars, reasoning) {
  const guard = reasoning ? ANSWER_GUARD_REASONING : ANSWER_GUARD;
  return Math.max(MIN_ANSWER, Math.min(guard, context - textTokens(chars) - REQUEST_OVERHEAD));
}

/**
 * Pick `n` of `list`, spread evenly by position, first and last always in.
 * The frames arrive in time order and are already weighted toward the start
 * and the end of the video (lib/frame-extractor.js), so an even pick by
 * position keeps that weighting.
 */
function pickEvenly(list, n) {
  if (!Array.isArray(list)) return [];
  if (n >= list.length) return list.slice();
  if (n <= 0) return [];
  if (n === 1) return [list[Math.floor(list.length / 2)]];
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * (list.length - 1) / (n - 1))]);
  return out;
}

function _reset() { _learned.clear(); }

module.exports = {
  plan, planText, textMaxTokens, pickEvenly, estimateFrameTokens, textTokens,
  keyFor, learned, learnFromUsage, learnFromOverflow, parseOverflow, contextFor,
  DEFAULT_CONTEXT, ANSWER_RESERVE, TEXT_ANSWER_RESERVE, ANSWER_GUARD, ANSWER_GUARD_REASONING, MIN_ANSWER,
  _reset,
};
