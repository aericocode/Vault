/**
 * AI slot registry — one lane per loaded copy of a model, not one per server.
 *
 * Vault has always balanced across ENDPOINTS, which is the right unit when the
 * extra capacity is a second machine. It is the wrong unit for the far more
 * common case: one PC with spare VRAM, where the user loads the same vision
 * model two or three times in LM Studio. LM Studio reports those copies as
 * `m`, `m:2`, `m:3` on a single endpoint, and Vault's one-endpoint balancer
 * sent every request to whichever copy LM Studio happened to route it to,
 * leaving the rest idle while the user watched their GPU sit at a third of its
 * throughput.
 *
 * So the unit of parallelism here is a SLOT: `{ endpoint, modelId }`. Requests
 * are spread over the live slots of the chosen family, the import queue sizes
 * itself as slots × workers, and the CLI scan does the same arithmetic.
 *
 * Liveness is deliberately forgiving. LM Studio's JIT unload makes a copy
 * vanish from /v1/models and come back a few seconds later, and treating that
 * as "gone forever" would throw away its statistics and shrink the queue for no
 * reason. A slot that disappears is marked gone and KEPT for GONE_TTL_MS; if it
 * reappears in that window it is revived with its counters intact, and only
 * then is it forgotten.
 *
 * This module never imports llm-client (which imports it) and never touches the
 * database. Its probes go through lib/net.js like every other egress. What
 * counts as loaded is decided in _probe, and it is not simply "/v1/models
 * mentioned it" — see the comment there.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('../config');
const { netFetch } = require('./net');
const appSettings = require('./app-settings');

/**
 * Which file the current async call chain is scanning.
 *
 * The scan panel wants to say which copy of the model has each in-flight file,
 * and the two ends of that fact are far apart: lib/import-queue.js knows the
 * media id, lib/llm-client.js knows the slot, and between them sits
 * processFile() and every processor under it. Threading an id through that
 * whole signature chain to serve a label would be a bad trade, so the id rides
 * in async context instead and the two ends meet here.
 */
const fileContext = new AsyncLocalStorage();

/** mediaId -> the slot currently answering for it. */
const _fileSlots = new Map();

const PROBE_TIMEOUT_MS = 4000;
const GONE_TTL_MS = 60_000;      // how long a vanished slot keeps its stats
const CACHE_TTL_MS = 15_000;     // an unforced refresh reuses anything younger
const TICK_MS = 15_000;

/** @type {Map<string, object>} `${endpoint}|${modelId}` -> slot */
const _slots = new Map();
/** @type {Map<string, {url:string, reachable:boolean|null, loaded:number|null, error:string|null}>} */
const _endpointState = new Map();

let _endpoints = [];
let _disabled = new Set();       // `${endpoint}|${modelId}` the user parked
let _lastRefreshAt = 0;
let _inflightRefresh = null;
let _refreshToken = 0;          // identifies the probe that owns _inflightRefresh
let _pickSeq = 0;                // round-robin tiebreak, see pick()
let _listeners = [];
let _activityProbe = () => false;
let _ticker = null;

function _key(endpoint, modelId) {
  return `${endpoint}|${modelId}`;
}

function _setEndpointList(list) {
  _endpoints = Array.isArray(list) ? list.filter(Boolean) : [];
  for (const url of _endpoints) {
    if (!_endpointState.has(url)) {
      _endpointState.set(url, { url, reachable: null, loaded: null, error: null });
    }
  }
  // Drop state and slots belonging to endpoints the user removed.
  const live = new Set(_endpoints);
  for (const url of [..._endpointState.keys()]) if (!live.has(url)) _endpointState.delete(url);
  for (const [k, slot] of [..._slots]) if (!live.has(slot.endpoint)) _slots.delete(k);
}

_setEndpointList(config.lmStudio.endpoints);
try {
  const stored = appSettings.all().aiDisabledSlots;
  if (Array.isArray(stored)) _disabled = new Set(stored.filter(s => typeof s === 'string'));
} catch { /* a corrupt prefs file must never stop the registry from loading */ }

/* ── Grouping ───────────────────────────────────────────────────────────── */

/**
 * Which family does `id` belong to, given every id the SAME endpoint reports?
 *
 * The rule is narrow on purpose. `m:2` is a second copy of `m` only when `m` is
 * also loaded there: a lone `foo:2` is just a model whose name ends that way,
 * and Ollama tags (`llava:13b`) must never be folded into a `llava` family that
 * does not exist. N starts at 2 because LM Studio numbers the first copy by
 * omitting the suffix entirely.
 */
function familyOf(id, siblingIds) {
  const m = /^(.+):(\d+)$/.exec(id);
  if (!m) return id;
  const base = m[1];
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 2) return id;
  return siblingIds.has(base) ? base : id;
}

/** ':1' for the base copy, ':2'/':3'... for the numbered ones. */
function suffixOf(id, family) {
  if (id === family) return ':1';
  const m = /^(.+):(\d+)$/.exec(id);
  return m ? `:${m[2]}` : ':1';
}

/* ── Slot bookkeeping ───────────────────────────────────────────────────── */

function _ensureSlot(endpoint, modelId, family) {
  const k = _key(endpoint, modelId);
  let slot = _slots.get(k);
  if (!slot) {
    slot = {
      endpoint, modelId, family,
      suffix: suffixOf(modelId, family),
      enabled: !_disabled.has(k),
      alive: true,
      goneAt: null,
      inFlight: 0,
      done: 0,
      errors: 0,
      totalMs: 0,
      pickedAt: 0,
    };
    _slots.set(k, slot);
  } else {
    // Revived inside the TTL, or regrouped because its base id just appeared.
    slot.family = family;
    slot.suffix = suffixOf(modelId, family);
    slot.alive = true;
    slot.goneAt = null;
  }
  return slot;
}

function _markGone(slot, now) {
  if (!slot.alive) return;
  slot.alive = false;
  slot.goneAt = now;
}

function isActive(slot) {
  return !!slot && slot.enabled && slot.alive;
}

/** Live slots, optionally narrowed to one family. */
function _activeSlots(family = null) {
  const out = [];
  for (const slot of _slots.values()) {
    if (!isActive(slot)) continue;
    if (family && slot.family !== family) continue;
    out.push(slot);
  }
  return out;
}

/**
 * How many lanes the queue may fill for ONE family.
 *
 * No family means no lanes, deliberately. This used to count the whole registry
 * when asked for nothing, which against a real LM Studio (every downloaded
 * model listed, no family picked yet) reported dozens of instances and sized
 * the queue for a machine that does not exist. Callers that genuinely want the
 * registry-wide figure ask for it by name.
 */
function activeCount(family) {
  return family ? _activeSlots(family).length : 0;
}

/** Every live slot across every family. Diagnostics and change detection. */
function totalActive() {
  return _activeSlots().length;
}

/**
 * Lanes available when the user pinned ONE copy, e.g. AI_MODEL=m:2.
 *
 * A pin is not a family: pick() will only ever return that one slot, so sizing
 * the queue off its family opened four lanes onto a single instance and left
 * three of them queueing behind the first. Counted rather than hard-coded to 1
 * because the same exact id can exist on two endpoints, and pick() would use
 * both.
 */
function activeCountForId(modelId) {
  if (!modelId) return 0;
  return _activeSlots().filter(s => s.modelId === modelId).length;
}

/** Family ids with at least one active slot. */
function activeFamilies() {
  const out = [];
  for (const slot of _slots.values()) {
    if (isActive(slot) && !out.includes(slot.family)) out.push(slot.family);
  }
  return out;
}

/* ── Refresh ────────────────────────────────────────────────────────────── */

/** GET a JSON document, or null if anything at all goes wrong. */
async function _getJson(url) {
  try {
    const response = await netFetch(url, {
      purpose: 'llm',
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { json: null, error: `HTTP ${response.status}` };
    return { json: await response.json(), error: null };
  } catch (err) {
    return { json: null, error: err.message || 'no answer' };
  }
}

/** Rows out of either models document, tolerating the `{models:[…]}` forks. */
function _rows(json) {
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.models)) return json.models;
  return null;
}

function _idOf(row) {
  const id = typeof row === 'string' ? row : (row?.id || row?.name);
  return id ? String(id) : null;
}

/** The server root, so the non-OpenAI status routes can be reached from it. */
function _baseOf(chatUrl) {
  return chatUrl.replace(/\/chat\/completions\/?$/, '').replace(/\/v1$/, '');
}

/**
 * Which models are actually LOADED on this endpoint.
 *
 * The obvious source, /v1/models, is the wrong one: LM Studio lists every model
 * you have DOWNLOADED there, so a normal library answers with dozens of ids and
 * Vault would size its queue as if all of them were sitting in VRAM ready to
 * answer. LM Studio's own /api/v0/models returns the same rows with a `state`
 * field, and that is the only honest signal. Embeddings are excluded too: an
 * embedding model is genuinely loaded, and genuinely cannot answer a scan.
 *
 * Verified live against LM Studio 1234 on this machine: 37 rows from both
 * routes, `state: "loaded"` on exactly two of them (one llm, one embeddings).
 * What could NOT be verified without loading a model in the user's LM Studio is
 * whether a SECOND copy shows up in /api/v0/models as its own row. So the rule
 * below accepts either shape: a `base:N` id is alive when v0 lists that exact
 * id as loaded, OR when v0 says its base is loaded. Hence /v1/models is still
 * fetched alongside v0, as the place where copies are known to appear.
 *
 * TODO: Ollama's OpenAI shim has the same problem (it lists every local model).
 * The equivalent there is GET <base>/api/ps, which lists running models. Not
 * built: nobody has reported it, and guessing at the response shape without a
 * box to test on is how the /v1/models assumption got made in the first place.
 */
async function _probe(url) {
  const base = _baseOf(url);
  const [v0, v1] = await Promise.all([
    _getJson(`${base}/api/v0/models`),
    _getJson(url.replace('/chat/completions', '/models')),
  ]);

  const v0Rows = _rows(v0.json);
  const v1Rows = _rows(v1.json);
  const v0HasState = Array.isArray(v0Rows)
    && v0Rows.some(r => r && typeof r === 'object' && typeof r.state === 'string');

  if (v0HasState) {
    const loaded = new Set();
    for (const row of v0Rows) {
      const id = _idOf(row);
      if (!id) continue;
      if (row.state !== 'loaded') continue;
      if (row.type === 'embeddings') continue;
      loaded.add(id);
    }
    // Union of both documents, because a numbered copy may only appear in one.
    const candidates = new Set();
    for (const row of v0Rows) { const id = _idOf(row); if (id) candidates.add(id); }
    for (const row of (v1Rows || [])) { const id = _idOf(row); if (id) candidates.add(id); }

    const ids = [...candidates].filter(id => {
      if (loaded.has(id)) return true;
      const m = /^(.+):(\d+)$/.exec(id);
      return !!m && Number(m[2]) >= 2 && loaded.has(m[1]);
    });
    return { ids, error: null };
  }

  if (v1Rows) {
    // No /api/v0: this is Ollama, vLLM, llama.cpp or an older LM Studio, and
    // nothing here distinguishes loaded from merely present. Dropping anything
    // named like an embedding model is the one filter worth making blind, since
    // a scan sent to one fails every file.
    const ids = [];
    for (const row of v1Rows) {
      const id = _idOf(row);
      if (id && !/embed/i.test(id)) ids.push(id);
    }
    return { ids, error: null };
  }

  return { ids: null, error: v1.error || v0.error || 'no answer' };
}

async function _doRefresh() {
  const now = Date.now();
  const before = totalActive();
  const beforeKeys = _activeSlots().map(s => _key(s.endpoint, s.modelId)).sort().join(',');

  const results = await Promise.all(_endpoints.map(async url => ({ url, ...(await _probe(url)) })));

  for (const { url, ids, error } of results) {
    const state = _endpointState.get(url) || { url };
    if (ids === null) {
      // Nothing answered: every slot behind this endpoint is unreachable, which
      // is indistinguishable from unloaded as far as dispatch is concerned.
      state.reachable = false;
      state.loaded = null;
      state.error = error;
      for (const slot of _slots.values()) if (slot.endpoint === url) _markGone(slot, now);
    } else {
      state.reachable = true;
      state.loaded = ids.length;
      state.error = null;
      const idSet = new Set(ids);
      const seen = new Set();
      for (const id of ids) {
        _ensureSlot(url, id, familyOf(id, idSet));
        seen.add(_key(url, id));
      }
      for (const [k, slot] of _slots) {
        if (slot.endpoint === url && !seen.has(k)) _markGone(slot, now);
      }
    }
    _endpointState.set(url, state);
  }

  for (const [k, slot] of [..._slots]) {
    if (!slot.alive && slot.goneAt !== null && now - slot.goneAt >= GONE_TTL_MS) _slots.delete(k);
  }

  _lastRefreshAt = now;
  const afterKeys = _activeSlots().map(s => _key(s.endpoint, s.modelId)).sort().join(',');
  if (afterKeys !== beforeKeys || totalActive() !== before) _emitChange();
  return registry();
}

/** Start a probe, optionally only once `after` has settled. */
function _startRefresh(after) {
  const token = ++_refreshToken;
  const run = after ? after.catch(() => {}).then(() => _doRefresh()) : _doRefresh();
  const wrapped = run.finally(() => { if (_refreshToken === token) _inflightRefresh = null; });
  _inflightRefresh = wrapped;
  return wrapped;
}

/**
 * Probe every endpoint.
 *
 * Unforced calls reuse a result younger than CACHE_TTL_MS and share whatever is
 * already running, so a page that polls and a queue that ticks do not multiply
 * into a request storm against LM Studio.
 *
 * A FORCED call never inherits an answer that was already on its way. It used
 * to, and that made Refresh a lie: press it just after the 15 s tick fired and
 * you got the tick's older picture, which is exactly the moment someone who has
 * just loaded another copy in LM Studio presses it.
 */
function refresh({ force = false } = {}) {
  if (force) return _startRefresh(_inflightRefresh);
  if (_inflightRefresh) return _inflightRefresh;
  if (_lastRefreshAt && Date.now() - _lastRefreshAt < CACHE_TTL_MS) {
    return Promise.resolve(registry());
  }
  return _startRefresh(null);
}

/**
 * A slot just failed with a model-availability error. Marking it gone right
 * here (rather than waiting for the next 15 s tick) is what lets the import
 * queue keep running on the surviving copies instead of halting the whole run
 * because one of three instances was unloaded.
 */
function reportUnavailable(slot) {
  if (!slot) return;
  const live = _slots.get(_key(slot.endpoint, slot.modelId));
  if (live) _markGone(live, Date.now());
  _emitChange();
  refresh({ force: true }).catch(() => {});
}

/* ── Dispatch ───────────────────────────────────────────────────────────── */

/**
 * The slot a request should go to: fewest in flight, and on a tie the one that
 * waited longest. `pickedAt` is a monotonic counter rather than a clock so two
 * picks inside the same millisecond still alternate.
 *
 * `null` means "the registry cannot answer" (nothing probed yet, an Ollama that
 * does not list its models, the family is not loaded). Callers fall back to the
 * pre-slot behaviour: endpoint round-robin and the model id as written.
 */
function pick(familyOrModelId) {
  if (!familyOrModelId) return null;
  let candidates = _activeSlots(familyOrModelId);
  if (candidates.length === 0) {
    // An exact `base:N` pins that one copy, wherever it lives.
    candidates = _activeSlots().filter(s => s.modelId === familyOrModelId);
  }
  if (candidates.length === 0) return null;
  let best = candidates[0];
  for (const slot of candidates) {
    if (slot.inFlight < best.inFlight
      || (slot.inFlight === best.inFlight && slot.pickedAt < best.pickedAt)) best = slot;
  }
  return best;
}

function acquire(slot) {
  if (!slot) return;
  slot.inFlight++;
  slot.pickedAt = ++_pickSeq;
}

function release(slot, { ok = true, ms = 0 } = {}) {
  if (!slot) return;
  slot.inFlight = Math.max(0, slot.inFlight - 1);
  if (ok) {
    slot.done++;
    slot.totalMs += Math.max(0, ms);
  } else {
    slot.errors++;
  }
}

/* ── Which slot has which file ──────────────────────────────────────────── */

/** Record that `mediaId` is being answered by `slot`. Called from postChat. */
function noteFile(mediaId, slot) {
  if (mediaId === undefined || mediaId === null || !slot) return;
  _fileSlots.set(mediaId, slot);
}

/** Forget the attribution. Always paired with noteFile in a finally. */
function clearFile(mediaId) {
  if (mediaId === undefined || mediaId === null) return;
  _fileSlots.delete(mediaId);
}

/**
 * `{ suffix, id }` for the copy currently handling this file, or null.
 * Null is the normal answer between AI calls (frame extraction, database work),
 * and the panel simply leaves the label off.
 */
function slotForFile(mediaId) {
  const slot = _fileSlots.get(mediaId);
  return slot ? { suffix: slot.suffix, id: slot.modelId } : null;
}

/* ── User switches ──────────────────────────────────────────────────────── */

/**
 * Park or un-park one copy. Persisted, because "I keep a third instance loaded
 * for something else" is a standing preference, not a session one: an unparked
 * slot after a restart would quietly steal the GPU back.
 */
function setEnabled(endpoint, modelId, enabled) {
  const k = _key(endpoint, modelId);
  if (enabled) _disabled.delete(k); else _disabled.add(k);
  const slot = _slots.get(k);
  if (slot) slot.enabled = !!enabled;
  try { appSettings.set({ aiDisabledSlots: [..._disabled] }); } catch {}
  _emitChange();
  return slot || null;
}

/* ── Views ──────────────────────────────────────────────────────────────── */

function _instanceView(slot) {
  return {
    id: slot.modelId,
    suffix: slot.suffix,
    endpoint: slot.endpoint,
    enabled: slot.enabled,
    alive: slot.alive,
    goneAt: slot.alive ? null : slot.goneAt,
    inFlight: slot.inFlight,
    done: slot.done,
    errors: slot.errors,
    avgMs: slot.done > 0 ? Math.round(slot.totalMs / slot.done) : 0,
  };
}

/** Grouped view for GET /api/ai/instances and the models picker. */
function families(currentFamily = null) {
  const byFamily = new Map();
  for (const slot of _slots.values()) {
    if (!byFamily.has(slot.family)) byFamily.set(slot.family, []);
    byFamily.get(slot.family).push(slot);
  }
  return [...byFamily.entries()].map(([family, slots]) => ({
    family,
    selected: currentFamily === family,
    instances: slots
      .slice()
      .sort((a, b) => a.suffix.localeCompare(b.suffix, 'en', { numeric: true })
        || a.endpoint.localeCompare(b.endpoint))
      .map(_instanceView),
  })).sort((a, b) => a.family.localeCompare(b.family));
}

/** Flat instance list for the scan panel strip (3.11). */
function instancesOf(family) {
  if (!family) return [];
  return _activeSlotsIncludingGone(family).map(s => ({
    id: s.modelId,
    suffix: s.suffix,
    endpoint: s.endpoint,
    alive: s.alive,
    enabled: s.enabled,
    inFlight: s.inFlight,
    done: s.done,
  }));
}

function _activeSlotsIncludingGone(family) {
  return [...(_slots.values())]
    .filter(s => s.family === family)
    .sort((a, b) => a.suffix.localeCompare(b.suffix, 'en', { numeric: true }));
}

/** Per-endpoint reachability for GET /api/ai/endpoints. */
function endpointStates() {
  return _endpoints.map(url => {
    const s = _endpointState.get(url) || { url, reachable: null, loaded: null, error: null };
    return { url, reachable: s.reachable ?? null, loaded: s.loaded ?? null, error: s.error ?? null };
  });
}

function registry() {
  return { endpoints: endpointStates(), slots: [..._slots.values()].map(_instanceView) };
}

/* ── URL normalisation (shared by the endpoints routes and config) ──────── */

/**
 * Accept what people actually type. A bare origin, or a path that stops short
 * of the route, becomes a full chat-completions URL; anything that is not an
 * http(s) URL is rejected with a sentence the UI can show as-is.
 * @returns {{ url: string|null, error: string|null }}
 */
function normalizeEndpoint(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { url: null, error: 'Enter a server address' };
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return { url: null, error: `Not a valid address: ${text}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: null, error: 'Server address must start with http:// or https://' };
  }
  parsed.hash = '';
  parsed.search = '';
  let pathname = parsed.pathname.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(pathname)) {
    // A bare origin needs the version segment too; a path like `/v1` already
    // carries it and only wants the route appended.
    pathname = pathname === '' ? '/v1/chat/completions' : `${pathname}/chat/completions`;
  }
  parsed.pathname = pathname;
  return { url: parsed.toString(), error: null };
}

/** Normalise a whole list, deduped, order preserved. Throws on the first bad one. */
function normalizeEndpoints(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return { urls: null, error: 'Add at least one server' };
  }
  const out = [];
  for (const raw of list) {
    const { url, error } = normalizeEndpoint(raw);
    if (error) return { urls: null, error };
    if (!out.includes(url)) out.push(url);
  }
  return { urls: out, error: null };
}

/** Swap the endpoint list (POST /api/ai/endpoints) and re-probe. */
function setEndpoints(list) {
  _setEndpointList(list);
  _lastRefreshAt = 0;
  _emitChange();
  return refresh({ force: true });
}

/* ── Change notification + background cadence ───────────────────────────── */

function onChange(fn) {
  if (typeof fn === 'function') _listeners.push(fn);
}

/**
 * Tell listeners the dispatch picture changed for a reason this module cannot
 * see. Picking a family is one: the slot set is identical, but the number of
 * lanes the queue may use just went from "ambiguous" to "two".
 */
function notifyChange() {
  _emitChange();
}

function _emitChange() {
  for (const fn of _listeners) {
    try { fn(); } catch { /* a listener must never break a refresh */ }
  }
}

/**
 * Non-blocking first probe plus a slow ticker. The ticker only spends a request
 * while something is actually scanning: polling LM Studio every 15 s forever
 * would show up in its log as a permanent heartbeat from an idle app.
 */
function boot({ activeProbe } = {}) {
  if (typeof activeProbe === 'function') _activityProbe = activeProbe;
  refresh({ force: true }).catch(() => {});
  if (_ticker) return;
  _ticker = setInterval(() => {
    let active = false;
    try { active = !!_activityProbe(); } catch {}
    if (active) refresh({ force: true }).catch(() => {});
  }, TICK_MS);
  if (typeof _ticker.unref === 'function') _ticker.unref();
}

function stop() {
  if (_ticker) { clearInterval(_ticker); _ticker = null; }
}

/** Test seam: drop every slot and endpoint result. */
function _reset(endpoints = config.lmStudio.endpoints) {
  _slots.clear();
  _endpointState.clear();
  _disabled = new Set();
  _lastRefreshAt = 0;
  _inflightRefresh = null;
  _pickSeq = 0;
  _listeners = [];
  _setEndpointList(endpoints);
}

module.exports = {
  refresh, families, instancesOf, pick, acquire, release, setEnabled,
  activeCount, totalActive, activeCountForId, activeFamilies, onChange, setEndpoints,
  endpointStates, fileContext, noteFile, clearFile, slotForFile,
  registry, reportUnavailable, boot, stop, notifyChange, probe: _probe,
  familyOf, suffixOf, normalizeEndpoint, normalizeEndpoints,
  GONE_TTL_MS,
  _slots, _reset,
};
