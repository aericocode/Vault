/**
 * How much of the model's context AI scans really use, per model.
 *
 * Why: scans are now sized to the context the model is loaded with
 * (lib/token-budget.js), so the question "could the model be loaded with a
 * smaller context?" has an honest answer only from what the server reported.
 * After each vision scan the largest reply of that scan (retries included) is
 * recorded here: the prompt tokens and answer tokens the server counted,
 * their sum, the pictures sent and the context the model was loaded with.
 *
 * Per model (copies m, m:2 count as one): how many scans, the largest total,
 * the 95th percentile of the last KEEP totals, the largest prompt and the
 * largest answer. Kept in memory and saved, a few seconds after a change, to a
 * small JSON file beside the settings file (<settings name>.context-use.json),
 * so the numbers survive a restart. Numbers and model ids only: no file
 * names, nothing about what was scanned. VAULT_CONTEXT_USE_FILE moves it (the
 * tests point it at a temp folder).
 */

const fs = require('fs');
const path = require('path');

const KEEP = 500;                // recent totals kept per model, for the percentile
const P95_MIN = 20;              // fewer scans than this: no percentile, it would mean little
const SAVE_DELAY_MS = 5_000;
const MAX_MODELS = 50;
const MAX_TOKENS = 10_000_000;

/** key -> { count, maxTotal, maxPrompt, maxAnswer, maxFrames, context, at, totals[] } */
let _byModel = null;
let _saveTimer = null;

function _file() {
  if (process.env.VAULT_CONTEXT_USE_FILE) return path.resolve(process.env.VAULT_CONTEXT_USE_FILE);
  const settings = require('./app-settings').SETTINGS_PATH;
  const ext = path.extname(settings);
  return path.join(path.dirname(settings), `${path.basename(settings, ext)}.context-use.json`);
}

const _n = (v, max = MAX_TOKENS) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);

function _load() {
  if (_byModel) return _byModel;
  _byModel = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(_file(), 'utf8'));
    for (const [key, e] of Object.entries(raw && raw.models ? raw.models : {})) {
      if (!e || typeof e !== 'object' || typeof key !== 'string' || !key) continue;
      const totals = Array.isArray(e.totals) ? e.totals.filter(t => _n(t) != null).slice(-KEEP) : [];
      _byModel.set(key.slice(0, 300), {
        count: _n(e.count, Number.MAX_SAFE_INTEGER) ?? totals.length,
        maxTotal: _n(e.maxTotal) ?? 0,
        maxPrompt: _n(e.maxPrompt) ?? 0,
        maxAnswer: _n(e.maxAnswer) ?? 0,
        maxFrames: _n(e.maxFrames, 10_000) ?? 0,
        context: _n(e.context),
        at: _n(e.at, Number.MAX_SAFE_INTEGER) ?? 0,
        totals,
      });
    }
  } catch {}                          // absent or unreadable: start empty
  return _byModel;
}

function _save() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveNow, SAVE_DELAY_MS);
  if (typeof _saveTimer.unref === 'function') _saveTimer.unref();
}

function _saveNow() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  if (!_byModel) return;
  const models = {};
  for (const [k, e] of _byModel) models[k] = e;
  try {
    fs.writeFileSync(_file(), JSON.stringify({ version: 1, models }));
  } catch (err) {
    console.warn(`[AI scan] could not save the context use numbers: ${err.message}`);
  }
}

/** Copies of one model (m, m:2) share one entry, as lib/token-budget.js learns them. */
function _key(model) {
  return require('./token-budget').keyFor(model || null, '');
}

/**
 * One scan's largest reply.
 * @param {{ model, promptTokens, completionTokens, frames, context }} r
 * @returns {object|null} what was recorded, or null when the numbers were not usable
 */
function record({ model, promptTokens, completionTokens, frames = 0, context = null } = {}) {
  const prompt = _n(promptTokens);
  const answer = _n(completionTokens) ?? 0;
  if (!prompt) return null;           // no prompt count: the server did not say
  const total = prompt + answer;
  const map = _load();
  const key = _key(model);
  let e = map.get(key);
  if (!e) {
    if (map.size >= MAX_MODELS) {
      const oldest = [...map].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) map.delete(oldest[0]);
    }
    e = { count: 0, maxTotal: 0, maxPrompt: 0, maxAnswer: 0, maxFrames: 0, context: null, at: 0, totals: [] };
    map.set(key, e);
  }
  e.count++;
  e.maxTotal = Math.max(e.maxTotal, total);
  e.maxPrompt = Math.max(e.maxPrompt, prompt);
  e.maxAnswer = Math.max(e.maxAnswer, answer);
  e.maxFrames = Math.max(e.maxFrames, _n(frames, 10_000) ?? 0);
  const ctx = _n(context);
  if (ctx) e.context = ctx;
  e.at = Date.now();
  e.totals.push(total);
  if (e.totals.length > KEEP) e.totals.splice(0, e.totals.length - KEEP);
  _save();
  return { key, prompt, answer, total, frames: _n(frames, 10_000) ?? 0, context: ctx };
}

/** 95th percentile (nearest rank) of the kept totals, or null with too few. */
function _p95(totals) {
  if (totals.length < P95_MIN) return null;
  const s = totals.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}

function _view(key, e) {
  return {
    model: key,
    count: e.count,
    maxTotal: e.maxTotal,
    p95: _p95(e.totals),
    maxPrompt: e.maxPrompt,
    maxAnswer: e.maxAnswer,
    maxFrames: e.maxFrames,
    context: e.context,
  };
}

/**
 * The numbers for one model, or for the one scanned most recently when
 * `model` is not given or has none. null when nothing is recorded.
 */
function summary(model = null) {
  const map = _load();
  if (model) {
    const e = map.get(_key(model));
    if (e && e.count) return _view(_key(model), e);
  }
  let best = null;
  for (const [k, e] of map) if (e.count && (!best || e.at > best[1].at)) best = [k, e];
  return best ? _view(best[0], best[1]) : null;
}

/** Every model's numbers, newest first. */
function all() {
  return [..._load()].filter(([, e]) => e.count).sort((a, b) => b[1].at - a[1].at).map(([k, e]) => _view(k, e));
}

/** Test seam: forget everything (and the file is re-read on next use). */
function _reset() {
  clearTimeout(_saveTimer);
  _saveTimer = null;
  _byModel = null;
}

module.exports = { record, summary, all, _saveNow, _reset, _file, KEEP, P95_MIN };
