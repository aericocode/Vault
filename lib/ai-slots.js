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
 * Liveness MIRRORS the server. A copy that is not in the latest probe is not a
 * slot any more, full stop: an earlier build kept unloaded copies on screen for
 * a minute so their statistics would survive a JIT blink, and what the user
 * actually saw was a Backend tab still listing a copy they had just ejected,
 * which reads as Vault being wrong rather than Vault being patient. The
 * statistics are what that retention was for, so they alone are kept, in a side
 * map (_stats) for STATS_TTL_MS: a copy that comes back picks its counters up
 * again, and nothing invisible is ever counted as a lane.
 *
 * Liveness is also EVENT-DRIVEN. A successful request proves a slot is loaded
 * and a model-unavailable error proves it is not, so both are recorded as they
 * happen and probes are reserved for discovery: boot, a scan starting, the
 * Backend tab and its Refresh button, a finished clone, one debounced probe
 * after an error, and a single 60 s sweep while a scan is running. An UNFORCED
 * refresh() never touches the network — it answers from the registry — because
 * the old 15 s ticker plus a forced probe on every model-list read showed up in
 * LM Studio's log as a permanent heartbeat from an idle app.
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
/** How long a vanished copy's COUNTERS are remembered (the copy itself is not). */
const STATS_TTL_MS = 600_000;
/** Wait after a slot error before the one confirming probe, so a burst shares it. */
const ERROR_PROBE_MS = 3000;

/**
 * The one remaining periodic probe: while a scan is running, sweep once a
 * minute so a copy loaded in LM Studio mid-scan joins within a minute. Nothing
 * ticks while the queue is idle. AI_DISCOVERY_MS overrides it; 0 turns it off.
 */
const DISCOVERY_MS = (() => {
  const raw = Number(process.env.AI_DISCOVERY_MS);
  if (!Number.isFinite(raw) || raw < 0) return 60_000;
  return Math.trunc(raw);
})();

/** @type {Map<string, object>} `${endpoint}|${modelId}` -> slot (ALIVE ones only) */
const _slots = new Map();
/** `${endpoint}|${modelId}` -> `{ done, errors, totalMs, at }` for vanished copies. */
const _stats = new Map();
/** @type {Map<string, {url:string, reachable:boolean|null, loaded:number|null, error:string|null}>} */
const _endpointState = new Map();

/** Endpoints that have answered /api/v0/models with a `state` field. */
const _v0Seen = new Set();
/** url -> consecutive probes where v0 then failed. Reset by any v0 success. */
const _v0Fails = new Map();
/** How many of those in a row are tolerated before the old behaviour returns. */
const V0_SKIP_PROBES = 4;

let _endpoints = [];
let _disabled = new Set();       // `${endpoint}|${modelId}` the user parked
let _lastRefreshAt = 0;
let _inflightRefresh = null;
let _refreshToken = 0;          // identifies the probe that owns _inflightRefresh
let _pickSeq = 0;                // round-robin tiebreak, see pick()
let _listeners = [];
let _activityProbe = () => false;
let _ticker = null;
let _errorProbe = null;          // the pending debounced probe, see _probeSoon
/** The copy most recently retired by an error, so the queue can name it. */
let _lastGone = null;            // { modelId, family, suffix, endpoint, at }

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
  for (const url of [..._v0Seen]) if (!live.has(url)) { _v0Seen.delete(url); _v0Fails.delete(url); }
  for (const [k, slot] of [..._slots]) if (!live.has(slot.endpoint)) _slots.delete(k);
}

_setEndpointList(config.lmStudio.endpoints);
try {
  const stored = appSettings.all().aiDisabledSlots;
  if (Array.isArray(stored)) _disabled = new Set(stored.filter(s => typeof s === 'string'));
} catch { /* a corrupt prefs file must never stop the registry from loading */ }

/* ── Grouping ───────────────────────────────────────────────────────────── */

/**
 * Which family does `id` belong to? A trailing `:N` (N >= 2) is always stripped.
 *
 * This used to require the base id to be loaded too, on the theory that a lone
 * `foo:2` is just a model whose name ends that way. Real use showed the cost:
 * eject the base of three copies and the family split into `…max:2` and
 * `…max:3`, so the Backend tab showed two models where there was one, the next
 * clone was numbered from a suffixed id (`…max:2:2`), and a mid-scan ejection
 * looked like the chosen model disappearing rather than one copy of it going.
 * Nothing about `m:2` changes when `m` is ejected, so nothing about its family
 * should either.
 *
 * N starts at 2 because LM Studio numbers the first copy by omitting the suffix
 * entirely. Ollama's tags (`llava:13b`, `qwen:0.5b`) are not integers >= 2 in
 * the usual case and stay their own families; a tag that IS a bare integer,
 * such as a hypothetical `foo:7`, would be grouped under `foo` by mistake. That
 * is accepted: no such tag exists in the wild, and the alternative is the split
 * family this rule exists to fix.
 */
function familyOf(id) {
  const m = /^(.+):(\d+)$/.exec(id);
  if (!m) return id;
  const n = Number(m[2]);
  if (!Number.isInteger(n) || n < 2) return id;
  return m[1];
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
      inFlight: 0,
      done: 0,
      errors: 0,
      totalMs: 0,
      pickedAt: 0,
    };
    // A copy that was ejected and loaded again is the same copy to the user, so
    // it keeps the counters it had if they are still in the side map.
    const kept = _stats.get(k);
    if (kept && Date.now() - kept.at < STATS_TTL_MS) {
      slot.done = kept.done;
      slot.errors = kept.errors;
      slot.totalMs = kept.totalMs;
    }
    _stats.delete(k);
    _slots.set(k, slot);
  } else {
    slot.family = family;
    slot.suffix = suffixOf(modelId, family);
    slot.alive = true;
  }
  return slot;
}

/**
 * Retire a slot: it leaves the registry immediately (nothing lists a copy the
 * server is not reporting) and only its counters are banked.
 */
function _markGone(slot, now) {
  const k = _key(slot.endpoint, slot.modelId);
  slot.alive = false;
  _stats.set(k, { done: slot.done, errors: slot.errors, totalMs: slot.totalMs, at: now });
  _slots.delete(k);
}

function _forgetOldStats(now) {
  for (const [k, s] of [..._stats]) if (now - s.at >= STATS_TTL_MS) _stats.delete(k);
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
    _v0Seen.add(url);
    _v0Fails.delete(url);
  }

  /* LM Studio goes quiet on /api/v0/models while it is loading a model, and the
     4 s probe times out. /v1/models keeps answering throughout, and taking it
     at face value there would mark every DOWNLOADED model as loaded: on a real
     library that is dozens of phantom instances, which then sit in the picker
     for a minute while they age out. Pressing "Load another copy" is exactly
     when that happens, so an endpoint that has spoken v0 before and has now
     gone quiet reports nothing at all and the previous picture stands.

     Two limits on that, because "report nothing" must never become a way for a
     dead server to look alive:

     - It needs EVIDENCE the server is still there, and the only evidence in
       hand is /v1/models answering in this same probe. When both routes fail
       the endpoint is simply down, and it has to be marked unreachable with
       its slots gone exactly as it was before any of this.
     - It is capped at V0_SKIP_PROBES consecutive failures (4, so around a
       minute at the 15 s tick, and well past the longest load seen here). A v0
       that is permanently broken then falls through to the old /v1/models
       behaviour rather than freezing the picture for good. */
  if (!v0HasState && _v0Seen.has(url)) {
    const fails = (_v0Fails.get(url) || 0) + 1;
    _v0Fails.set(url, fails);
    if (v1Rows && fails <= V0_SKIP_PROBES) return { ids: null, skip: true, error: v0.error };
  }

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

  for (const { url, ids, error, skip } of results) {
    // The probe declined to answer (see _probe). Leave this endpoint's slots
    // and its reachability exactly as they were.
    if (skip) continue;
    const state = _endpointState.get(url) || { url };
    if (ids === null) {
      // Nothing answered: every slot behind this endpoint is unreachable, which
      // is indistinguishable from unloaded as far as dispatch is concerned.
      state.reachable = false;
      state.loaded = null;
      state.error = error;
      // Snapshot: _markGone deletes, and deleting out of a live iterator skips.
      for (const slot of [..._slots.values()]) if (slot.endpoint === url) _markGone(slot, now);
    } else {
      state.reachable = true;
      state.loaded = ids.length;
      state.error = null;
      const seen = new Set();
      for (const id of ids) {
        _ensureSlot(url, id, familyOf(id));
        seen.add(_key(url, id));
      }
      for (const [k, slot] of [..._slots]) {
        if (slot.endpoint === url && !seen.has(k)) _markGone(slot, now);
      }
    }
    _endpointState.set(url, state);
  }

  _forgetOldStats(now);
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
 * Probe every endpoint, or answer from the registry.
 *
 * An UNFORCED call never touches the network. It returns what is known (joining
 * a probe already in flight, so a page load during the boot probe still waits
 * for a real answer). Everything that reads the registry often — the Backend
 * tab's 5 s poll, the model dropdown, the scan panel — goes through this path,
 * and giving any of them the right to start a probe is what turned an idle
 * Vault into a constant stream of /v1/models requests in LM Studio's log.
 *
 * A FORCED call never inherits an answer that was already on its way, so
 * Refresh always reflects the moment it was pressed rather than the probe that
 * started just before it.
 */
function refresh({ force = false } = {}) {
  if (force) return _startRefresh(_inflightRefresh);
  if (_inflightRefresh) return _inflightRefresh;
  return Promise.resolve(registry());
}

/**
 * One probe soon, however many callers ask. Several copies failing in the same
 * second (an endpoint dying takes them all) must not become several probes.
 */
function _probeSoon(delayMs = ERROR_PROBE_MS) {
  if (_errorProbe) return;
  _errorProbe = setTimeout(() => {
    _errorProbe = null;
    refresh({ force: true }).catch(() => {});
  }, delayMs);
  if (typeof _errorProbe.unref === 'function') _errorProbe.unref();
}

/**
 * A slot just failed with a model-availability error.
 *
 * The error IS the evidence: nothing needs confirming before this copy stops
 * being a lane, and waiting for a probe would send the next few files to a copy
 * that is already gone. So it is retired here and now, the import queue carries
 * on with the siblings, and one probe three seconds later sizes the lanes again
 * and notices if the whole server (rather than one copy) went away.
 */
function reportUnavailable(slot) {
  if (!slot) return;
  const live = _slots.get(_key(slot.endpoint, slot.modelId));
  const target = live || slot;
  _lastGone = {
    modelId: target.modelId,
    family: target.family,
    suffix: target.suffix,
    endpoint: target.endpoint,
    at: Date.now(),
  };
  if (live) _markGone(live, Date.now());
  _emitChange();
  _probeSoon();
}

/** The copy an error most recently retired, for the scan panel's notice line. */
function lastGone() {
  return _lastGone;
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
    // A request that answered is the strongest possible proof this copy is
    // loaded, and it costs nothing. With probes now rare, this is how a copy
    // that a failed probe wrote off finds its way back without waiting for one.
    const k = _key(slot.endpoint, slot.modelId);
    if (!_slots.has(k)) {
      slot.alive = true;
      _stats.delete(k);
      _slots.set(k, slot);
      _emitChange();
    }
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
    // Always true: the registry holds nothing else. Kept in the payload because
    // the viewer and the CLI scan both filter on it, and an older viewer served
    // from a newer server must not read `undefined` as "unloaded".
    alive: true,
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

/** Flat instance list for the scan panel strip (3.11). Live copies only. */
function instancesOf(family) {
  if (!family) return [];
  return [..._slots.values()]
    .filter(s => s.family === family)
    .sort((a, b) => a.suffix.localeCompare(b.suffix, 'en', { numeric: true }))
    .map(s => ({
      id: s.modelId,
      suffix: s.suffix,
      endpoint: s.endpoint,
      alive: true,
      enabled: s.enabled,
      inFlight: s.inFlight,
      done: s.done,
    }));
}

/** Per-endpoint reachability for GET /api/ai/endpoints. */
function endpointStates() {
  return _endpoints.map(url => {
    const s = _endpointState.get(url) || { url, reachable: null, loaded: null, error: null };
    return { url, reachable: s.reachable ?? null, loaded: s.loaded ?? null, error: s.error ?? null };
  });
}

function registry() {
  return {
    endpoints: endpointStates(),
    slots: [..._slots.values()].map(_instanceView),
    lastCheckedAt: _lastRefreshAt || null,
  };
}

/** Epoch ms of the last probe, or null before the first one lands. */
function lastCheckedAt() {
  return _lastRefreshAt || null;
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
 * Non-blocking first probe, plus the one periodic call Vault still makes.
 *
 * The discovery sweep exists for a single case that no event can cover: the
 * user loads another copy in LM Studio while a scan is running, and nothing in
 * Vault would ever hear about it. Once a minute, and only while the queue is
 * actually working, is enough to pick it up without going back to a heartbeat.
 */
function boot({ activeProbe } = {}) {
  if (typeof activeProbe === 'function') _activityProbe = activeProbe;
  refresh({ force: true }).catch(() => {});
  if (_ticker || DISCOVERY_MS <= 0) return;
  _ticker = setInterval(() => {
    let active = false;
    try { active = !!_activityProbe(); } catch {}
    if (active) refresh({ force: true }).catch(() => {});
  }, DISCOVERY_MS);
  if (typeof _ticker.unref === 'function') _ticker.unref();
}

function stop() {
  if (_ticker) { clearInterval(_ticker); _ticker = null; }
  if (_errorProbe) { clearTimeout(_errorProbe); _errorProbe = null; }
}

/** Test seam: drop every slot and endpoint result. */
function _reset(endpoints = config.lmStudio.endpoints) {
  _slots.clear();
  _stats.clear();
  _lastGone = null;
  if (_errorProbe) { clearTimeout(_errorProbe); _errorProbe = null; }
  _endpointState.clear();
  _disabled = new Set();
  _lastRefreshAt = 0;
  _inflightRefresh = null;
  _pickSeq = 0;
  // Listeners survive on purpose: lib/import-queue.js subscribes once when it
  // is required, and dropping that here would quietly disconnect the queue from
  // the registry for the rest of the process.
  _v0Seen.clear();
  _v0Fails.clear();
  _setEndpointList(endpoints);
}

module.exports = {
  refresh, families, instancesOf, pick, acquire, release, setEnabled,
  activeCount, totalActive, activeCountForId, activeFamilies, onChange, setEndpoints,
  endpointStates, fileContext, noteFile, clearFile, slotForFile,
  registry, reportUnavailable, lastGone, lastCheckedAt, boot, stop, notifyChange, probe: _probe,
  familyOf, suffixOf, normalizeEndpoint, normalizeEndpoints,
  STATS_TTL_MS, DISCOVERY_MS, ERROR_PROBE_MS,
  _slots, _stats, _reset,
};
