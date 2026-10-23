/**
 * The scan model: which model scans use, and what Vault does when it is not
 * loaded (Settings > Models > Scanning).
 *
 * Before this, a scan with no model loaded simply stopped ("model unavailable,
 * press Resume"), and files a watched folder added sat there until someone
 * noticed. Now the import queue asks this module, and files WAIT (never fail)
 * until the model is there. Depending on the user's choice Vault loads it for
 * them through LM Studio's `lms` CLI:
 *
 *   room    "Load it if there is room" (default): only when the GPU has the
 *           free memory for it. Free memory comes from nvidia-smi; the need is
 *           estimated from the model's file size plus a margin for context.
 *           With no NVIDIA tool there is no way to know, so it waits.
 *   wait    "Wait until I load it": never loads anything.
 *   always  "Always load it": loads even when LM Studio has to squeeze.
 *
 * Copies Vault loads itself are remembered (in memory, for this run of the
 * server) so "Unload the scan model after N min idle" can free them again. A
 * copy the user loaded is never unloaded: the list only ever holds
 * identifiers this module asked `lms` to load.
 *
 * Nothing here blocks the server: every lms / nvidia-smi call is an async
 * spawn with a timeout, and nothing loads or unloads while the library is
 * locked. The pure rules (decideLoad, gpuFreeBlocks, estimateNeedBytes,
 * parseNvidiaSmi) are exported for the tests, and the I/O goes through `_deps`
 * so a test can stand in for LM Studio and the graphics driver.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const appSettings = require('./app-settings');

const GB = 1024 ** 3;
const POLICIES = ['room', 'wait', 'always'];
const IDLE_CHOICES = [0, 5, 10, 30];
const DEFAULTS = Object.freeze({
  scanModel: '',            // '' = automatic: whatever single model is loaded
  whenNotLoaded: 'room',
  gpuFreeForWatch: false,
  unloadIdleMin: 10,        // only ever touches copies Vault loaded itself
});

const DISK_TTL_MS = 60_000;
const GPU_TTL_MS = 10_000;
const NVSMI_TIMEOUT_MS = 5_000;
const LOAD_RETRY_MS = 10 * 60_000;   // a failed load is not retried on its own sooner
const IDLE_TICK_MS = 60_000;

/* ── Settings ───────────────────────────────────────────────────────────── */

function _clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const model = typeof s.scanModel === 'string' ? s.scanModel.trim().slice(0, 300) : '';
  return {
    scanModel: model,
    whenNotLoaded: POLICIES.includes(s.whenNotLoaded) ? s.whenNotLoaded : DEFAULTS.whenNotLoaded,
    gpuFreeForWatch: typeof s.gpuFreeForWatch === 'boolean' ? s.gpuFreeForWatch : DEFAULTS.gpuFreeForWatch,
    unloadIdleMin: IDLE_CHOICES.includes(s.unloadIdleMin) ? s.unloadIdleMin : DEFAULTS.unloadIdleMin,
  };
}

let _settings = (() => {
  try { return _clean(appSettings.all().scanSettings); } catch { return { ...DEFAULTS }; }
})();

/** The saved choices (a copy). */
function settings() {
  return { ..._settings };
}

/**
 * Save a patch. Unknown keys are ignored; a value of the wrong shape is a
 * 400 for the route, so it comes back as `{ error }` rather than being
 * quietly replaced by a default.
 */
function setSettings(patch = {}) {
  const p = patch && typeof patch === 'object' ? patch : {};
  if (p.scanModel !== undefined && typeof p.scanModel !== 'string') return { error: 'scanModel must be text' };
  if (p.whenNotLoaded !== undefined && !POLICIES.includes(p.whenNotLoaded)) {
    return { error: 'whenNotLoaded must be room, wait or always' };
  }
  if (p.gpuFreeForWatch !== undefined && typeof p.gpuFreeForWatch !== 'boolean') {
    return { error: 'gpuFreeForWatch must be true or false' };
  }
  if (p.unloadIdleMin !== undefined && !IDLE_CHOICES.includes(p.unloadIdleMin)) {
    return { error: 'unloadIdleMin must be 0, 5, 10 or 30' };
  }
  const next = _clean({ ..._settings, ...p });
  const modelChanged = next.scanModel !== _settings.scanModel;
  _settings = next;
  try { appSettings.set({ scanSettings: next }); } catch {}
  if (modelChanged) { _lastLoad = null; _aliases.clear(); }   // a new model gets a fresh try
  _emit();
  return { settings: settings() };
}

/** The model scans should ask for, or null for automatic. */
function chosenModel() {
  return _settings.scanModel || null;
}

/**
 * modelKey -> identifier, for a scan model the user loaded under a name of
 * their own (`lms ps --json` gives both; /api/v0/models only the identifier).
 * Learned before Vault would load anything, so it never loads a duplicate.
 */
const _aliases = new Map();

/**
 * The id a scan should ask for: the saved scan model, or the identifier the
 * user has it loaded under when that copy is live. null for automatic.
 */
function scanTargetId() {
  const key = chosenModel();
  if (!key) return null;
  const alias = _aliases.get(key);
  if (alias) {
    try {
      const slots = require('./ai-slots');
      if (slots.activeCountForId(alias) > 0 || slots.activeCount(slots.familyOf(alias)) > 0) return alias;
    } catch {}
  }
  return key;
}

/**
 * Can Vault load models here at all (lms present, a local LM Studio, and
 * `lms ps` answering)? Synchronous. While `lms ps` fails Vault cannot tell
 * whether the user already has the model loaded, so it loads nothing (that
 * risks a duplicate) and the queue sends files out as it did before.
 */
const PS_FAIL_MS = 2 * 60_000;
let _psFailedAt = 0;
function canLoadNow() {
  if (_psFailedAt && _deps.now() - _psFailedAt < PS_FAIL_MS) return false;
  try { return !!_deps.canLoad().ok; } catch { return false; }
}

/* ── Pure rules ─────────────────────────────────────────────────────────── */

/**
 * GPU memory a model needs, from its file size: the weights, plus room for the
 * context (KV cache) and the vision adapter. A fifth of the file, never less
 * than 1 GB. Deliberately on the generous side: a load that does not fit
 * spills into system memory and every scan crawls.
 */
function estimateNeedBytes(sizeBytes) {
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0) return null;
  return Math.round(size + Math.max(GB, size * 0.2));
}

/**
 * Load now, or wait? `{ load, code }`.
 * @param {{ policy: string, needBytes: number|null, gpu: {freeBytes:number}|null }} p
 */
function decideLoad({ policy, needBytes, gpu }) {
  if (policy === 'wait') return { load: false, code: 'policy-wait' };
  if (policy === 'always') return { load: true, code: 'always' };
  // "If there is room": without a reading there is no way to know.
  if (!gpu || !Number.isFinite(gpu.freeBytes)) return { load: false, code: 'no-gpu-info' };
  if (!Number.isFinite(needBytes) || needBytes <= 0) return { load: false, code: 'unknown-size' };
  return gpu.freeBytes >= needBytes ? { load: true, code: 'room' } : { load: false, code: 'no-room' };
}

/**
 * "Only scan watched folders when the GPU is free": a watched-folder file waits
 * while any model OTHER than the scan model is loaded. Imports, retries and
 * other files the user started are never held by it.
 */
function gpuFreeBlocks({ enabled, source, loadedFamilies, scanFamily }) {
  if (!enabled || source !== 'watch') return false;
  return (loadedFamilies || []).some(f => f !== scanFamily);
}

/**
 * nvidia-smi --query-gpu=memory.free,memory.total --format=csv,noheader,nounits
 * prints one "free, total" line per GPU, in MiB. Summed over every GPU: LM
 * Studio spreads a model over all of them by default.
 * @returns {{freeBytes:number,totalBytes:number,gpus:number}|null}
 */
function parseNvidiaSmi(stdout) {
  let free = 0, total = 0, gpus = 0;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(line);
    if (!m) continue;
    free += Number(m[1]);
    total += Number(m[2]);
    gpus++;
  }
  if (!gpus) return null;
  return { freeBytes: free * 1024 * 1024, totalBytes: total * 1024 * 1024, gpus };
}

/** "mradermacher/minicpm-v-4.6-abliterated-max" -> "minicpm-v-4.6-abliterated-max". */
function shortName(id) {
  const s = String(id || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function fmtGb(bytes) {
  const g = bytes / GB;
  return g >= 10 ? `${Math.round(g)} GB` : `${g.toFixed(1)} GB`;
}

/* ── The outside world (stand-ins for tests) ────────────────────────────── */

function _nvidiaSmiPath() {
  const exe = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, exe);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
    try { if (fs.statSync(sys).isFile()) return sys; } catch {}
  }
  return null;
}

function _readGpu() {
  const exe = _nvidiaSmiPath();
  if (!exe) return Promise.resolve(null);
  return new Promise(resolve => {
    execFile(exe, ['--query-gpu=memory.free,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: NVSMI_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : parseNvidiaSmi(stdout)));
  });
}

/** Where `lms load` would land: an LM Studio endpoint on this PC, with the CLI installed. */
function _canLoad() {
  const lms = require('./lms-cli');
  const slots = require('./ai-slots');
  if (!lms.findLms()) return { ok: false, reason: 'the lms command is not installed' };
  const states = slots.endpointStates();
  const local = states.some(s => lms.isLocalEndpoint(s.url) && slots.speaksV0(s.url));
  if (!local) return { ok: false, reason: 'the AI server is not LM Studio on this PC' };
  return { ok: true };
}

const _deps = {
  listModels: () => require('./lms-cli').listModels(),
  readGpu: _readGpu,
  load: (o) => require('./lms-cli').loadModel(o),
  unload: (id) => require('./lms-cli').unloadInstance(id),
  psRows: () => require('./lms-cli').psRowsOrNull(),
  refresh: () => require('./ai-slots').refresh({ force: true }),
  loadedFamilies: () => require('./ai-slots').activeFamilies(),
  canLoad: _canLoad,
  isLocked: () => { try { return require('./vault').isLocked(); } catch { return false; } },
  isBusy: () => false,          // boot() wires the import queue in
  now: () => Date.now(),
};

/* ── Disk list and GPU reading (cached) ─────────────────────────────────── */

let _disk = { at: 0, rows: null, inflight: null };
let _gpu = { at: 0, value: undefined, inflight: null };

/** Models on disk, vision-capable first. Cached for a minute. */
async function diskModels({ force = false } = {}) {
  const now = _deps.now();
  if (!force && _disk.rows && now - _disk.at < DISK_TTL_MS) return _disk.rows;
  if (_disk.inflight) return _disk.inflight;
  _disk.inflight = (async () => {
    let rows = [];
    try { rows = await _deps.listModels(); } catch { rows = []; }
    _disk = { at: _deps.now(), rows: Array.isArray(rows) ? rows : [], inflight: null };
    return _disk.rows;
  })();
  return _disk.inflight;
}

/** Free / total GPU memory, or null when there is no NVIDIA tool. Cached for 10 s. */
async function gpu({ force = false } = {}) {
  const now = _deps.now();
  if (!force && _gpu.value !== undefined && now - _gpu.at < GPU_TTL_MS) return _gpu.value;
  if (_gpu.inflight) return _gpu.inflight;
  _gpu.inflight = (async () => {
    let v = null;
    try { v = await _deps.readGpu(); } catch { v = null; }
    _gpu = { at: _deps.now(), value: v || null, inflight: null };
    return _gpu.value;
  })();
  return _gpu.inflight;
}

/* ── Loading ────────────────────────────────────────────────────────────── */

let _loading = null;          // { modelKey, identifier, startedAt }
let _lastLoad = null;         // { at, ok, error, modelKey }
/** identifier -> { modelKey, at }: ONLY copies this module loaded. */
const _vaultLoaded = new Map();
let _lastBusyAt = 0;

/**
 * Words for a wait. Plain sentences: the panel shows them as they are.
 * @returns {{ code: string, reason: string, model: string|null }}
 */
function describeWait(code, ctx = {}) {
  const name = ctx.model ? shortName(ctx.model) : null;
  const others = (ctx.others || []).map(shortName);
  const whileOthers = others.length ? ` while ${others.slice(0, 2).join(' and ')}${others.length > 2 ? ' and others are' : ' is'} loaded` : '';
  let reason;
  switch (code) {
    case 'no-model':
      reason = 'No model is loaded in LM Studio, and no scan model is chosen. Load a vision model, or pick a scan model in Settings so Vault can load it for you.';
      break;
    case 'policy-wait':
      reason = `${name} is not loaded. Files start when you load it in LM Studio.`;
      break;
    case 'no-room':
      reason = `Not enough free GPU memory to load ${name} (needs about ${fmtGb(ctx.needBytes)}, ${fmtGb(ctx.freeBytes)} free)${whileOthers}. Files start when there is room.`;
      break;
    case 'no-gpu-info':
      reason = `${name} is not loaded, and Vault cannot read how much GPU memory is free on this PC, so it waits. Load it in LM Studio, choose "Always load it", or press Load anyway.`;
      break;
    case 'unknown-size':
      reason = `${name} is not loaded, and LM Studio did not say how big it is, so Vault waits. Load it in LM Studio, or press Load anyway.`;
      break;
    case 'loading':
      reason = `Loading ${name} in LM Studio. Files start as soon as it is ready.`;
      break;
    case 'load-failed':
      reason = `LM Studio could not load ${name}: ${ctx.error || 'no reason given'}. Vault tries again in a few minutes.`;
      break;
    case 'not-on-disk':
      reason = `${name} is not in LM Studio's models any more. Pick another scan model in Settings.`;
      break;
    case 'cannot-load':
      reason = `${name} is not loaded, and Vault cannot load it here (${ctx.why || 'no lms command'}). Load it in LM Studio.`;
      break;
    case 'not-running':
      reason = `The AI server is not answering${ctx.detail ? ` (${ctx.detail})` : ''}. Start LM Studio (or your AI server) and load ${name || 'your scan model'}. Vault tries one file again now and then, or press Try now.`;
      break;
    case 'model-stopped':
      reason = ctx.blind
        ? `The scan model stopped answering${ctx.detail ? `: ${ctx.detail}` : ''}. Vault cannot see what this AI server has loaded, so it tries one file again now and then. Press Try now when the model is back.`
        : `The scan model stopped answering${ctx.detail ? `: ${ctx.detail}` : ''}. Files start again when it is back.`;
      break;
    case 'listed-dead':
      reason = `${name} is loaded in LM Studio but is not answering. Unload it and load it again in LM Studio.`;
      break;
    case 'not-vision': {
      if (name && ctx.refused) {
        reason = `${name} refused to read pictures. Pick a model that can read pictures, or load one.`;
      } else if (name && ctx.env) {
        reason = `AI_MODEL in the environment picks ${name}, which cannot read pictures. Change or remove AI_MODEL.`;
      } else if (name && ctx.session) {
        reason = `${name}, picked in the scan panel or on the Backend page, cannot read pictures. Pick a model that can read pictures.`;
      } else if (name) {
        reason = `${name} cannot read pictures (LM Studio lists it as text only). Pick a vision model as the scan model in Settings.`;
      } else {
        const list = others.length ? others.slice(0, 2).join(' and ') + (others.length > 2 ? ' and others' : '') : 'the loaded model';
        reason = `No model that can read pictures is loaded (${list} ${others.length > 1 ? 'are' : 'is'} text only). Pick a scan model in Settings or load one.`;
      }
      break;
    }
    case 'checking':
      reason = `Checking whether ${name || 'the scan model'} is loaded.`;
      break;
    case 'gpu-busy':
      reason = `Watched folder files wait while another model is loaded (${others.slice(0, 2).join(', ') || 'another model'}). You can turn this off in Settings, Models, Scanning.`;
      break;
    default:
      reason = name ? `Waiting for ${name}.` : 'Waiting for the scan model.';
  }
  return { code, reason, model: ctx.model || null };
}

/**
 * The scan model is not loaded and files are waiting: decide whether to load
 * it, and start the load if so. Never throws, never blocks; resolves with the
 * wait to show (`code: 'loading'` while a load runs).
 *
 * @param {{ force?: boolean, target?: string|null }} [o] force = "Load anyway":
 *   ignore the policy, the room check and the retry back-off.
 */
async function maybeLoad({ force = false, target = null } = {}) {
  const model = target || chosenModel();
  if (_deps.isLocked()) return describeWait('locked', { model });
  if (!model) return describeWait('no-model');
  if (_loading) return describeWait('loading', { model: _loading.modelKey });

  // Loaded already, under an identifier of the user's own? Use that copy.
  // `lms ps` failing means we cannot know, and loading then could make a
  // duplicate: load nothing, and let the queue send files out (canLoadNow).
  let ps = null;
  try { ps = await _deps.psRows(); } catch { ps = null; }
  if (!Array.isArray(ps)) {
    if (_deps.canLoad().ok) {
      const fresh = !_psFailedAt || _deps.now() - _psFailedAt >= PS_FAIL_MS;
      _psFailedAt = _deps.now();
      if (fresh) _emit();
    }
    return describeWait('cannot-load', { model, why: 'lms ps did not answer' });
  }
  _psFailedAt = 0;
  // Listed by LM Studio under its own name, yet not answering: `lms load`
  // would only make a second copy. That needs the user (unload, load again).
  if (ps.some(r => r && (r.identifier === model))) {
    return describeWait('listed-dead', { model });
  }
  try {
    const mine = ps.find(r => r && r.modelKey === model && r.identifier && r.identifier !== model);
    if (mine) {
      if (_aliases.get(model) !== mine.identifier) {
        _aliases.set(model, mine.identifier);
        try { await _deps.refresh(); } catch {}
        _emit();
      }
      return describeWait('checking', { model });
    }
  } catch {}

  const policy = force ? 'always' : _settings.whenNotLoaded;
  if (policy === 'wait') return describeWait('policy-wait', { model });

  const can = _deps.canLoad();
  if (!can.ok) return describeWait('cannot-load', { model, why: can.reason });

  if (!force && _lastLoad && !_lastLoad.ok && _lastLoad.modelKey === model
      && _deps.now() - _lastLoad.at < LOAD_RETRY_MS) {
    return describeWait('load-failed', { model, error: _lastLoad.error });
  }

  const rows = await diskModels();
  const row = rows.find(r => r.modelKey === model)
    || rows.find(r => r.modelKey.toLowerCase() === String(model).toLowerCase());
  if (!row) {
    // An empty list means lms said nothing at all; that is not "gone from disk".
    if (!rows.length) return describeWait('cannot-load', { model, why: 'LM Studio did not list its models' });
    return describeWait('not-on-disk', { model });
  }

  // Never load a model LM Studio itself says cannot read pictures.
  if (row.vision === false) return describeWait('not-vision', { model });

  const needBytes = estimateNeedBytes(row.sizeBytes);
  const reading = policy === 'room' ? await gpu() : null;
  const decision = decideLoad({ policy, needBytes, gpu: reading });
  if (!decision.load) {
    const others = (() => { try { return _deps.loadedFamilies(); } catch { return []; } })();
    return describeWait(decision.code, { model, needBytes, freeBytes: reading?.freeBytes, others });
  }
  if (_deps.isLocked()) return describeWait('locked', { model });
  if (_loading) return describeWait('loading', { model: _loading.modelKey });
  _startLoad(row.modelKey);
  return describeWait('loading', { model: row.modelKey });
}

function _startLoad(modelKey) {
  const identifier = modelKey;            // LM Studio's own default identifier
  _loading = { modelKey, identifier, startedAt: _deps.now() };
  console.log(`[Scan model] loading ${modelKey} in LM Studio`);
  Promise.resolve()
    .then(() => _deps.load({ modelKey, identifier }))
    .catch(err => ({ ok: false, error: err && err.message }))
    .then(async (res) => {
      _loading = null;
      // ok: lms load itself succeeded, so this copy is Vault's to unload later.
      // listed only: it is there, but it may be the user's, so it is used and
      // never unloaded by Vault.
      const ok = !!(res && res.ok);
      const there = ok || !!(res && res.listed);
      _lastLoad = { at: _deps.now(), ok: there, error: there ? null : String(res?.error || 'unknown error').slice(0, 200), modelKey };
      if (there) {
        if (ok) _vaultLoaded.set(identifier, { modelKey, at: _deps.now() });
        _lastBusyAt = _deps.now();          // a fresh load is not "idle for 10 min"
        console.log(`[Scan model] ${modelKey} is loaded`);
        try { await _deps.refresh(); } catch {}
      } else {
        console.warn(`[Scan model] could not load ${modelKey}: ${_lastLoad.error}`);
      }
      _emit();
    });
}

/* ── Idle unload ────────────────────────────────────────────────────────── */

/**
 * Free the copies Vault loaded once the queue has been idle long enough.
 * Only identifiers in _vaultLoaded are candidates, and only while `lms ps`
 * still lists them: one the user already unloaded is just forgotten.
 * @returns {Promise<string[]>} the identifiers unloaded
 */
async function unloadIfIdle() {
  const now = _deps.now();
  let busy = false;
  try { busy = !!_deps.isBusy(); } catch {}
  if (busy || _loading) { _lastBusyAt = now; return []; }
  const mins = _settings.unloadIdleMin;
  if (!mins || !_vaultLoaded.size || _deps.isLocked()) return [];
  if (now - _lastBusyAt < mins * 60_000) return [];
  const rows = await _deps.psRows();
  const live = new Set((rows || []).map(r => r && (r.identifier || r.modelKey)).filter(Boolean));
  const out = [];
  for (const id of [..._vaultLoaded.keys()]) {
    if (!live.has(id)) { _vaultLoaded.delete(id); continue; }
    if (_deps.isLocked()) break;
    try { busy = !!_deps.isBusy(); } catch {}
    if (busy) break;                       // work arrived while we were asking
    const r = await _deps.unload(id);
    if (r && r.ok) {
      _vaultLoaded.delete(id);
      out.push(id);
      console.log(`[Scan model] unloaded ${id} after ${mins} min idle`);
    }
  }
  if (out.length) _emit();
  return out;
}

let _tick = null;
/** Start the idle clock. `isBusy` is the import queue's "is anything scanning?". */
function boot({ isBusy } = {}) {
  if (typeof isBusy === 'function') _deps.isBusy = isBusy;
  _lastBusyAt = _deps.now();
  if (_tick) return;
  _tick = setInterval(() => { unloadIfIdle().catch(() => {}); }, IDLE_TICK_MS);
  if (typeof _tick.unref === 'function') _tick.unref();
}

function stop() {
  if (_tick) { clearInterval(_tick); _tick = null; }
}

/* ── Change listeners (the import queue re-checks on these) ─────────────── */

const _listeners = [];
function onChange(fn) { if (typeof fn === 'function') _listeners.push(fn); }
function _emit() {
  for (const fn of _listeners) { try { fn(); } catch {} }
}

/** For the Scanning settings group and the panel. */
function status() {
  let can = { ok: false };
  try { can = _deps.canLoad(); } catch {}
  return {
    settings: settings(),
    loading: _loading ? { ..._loading } : null,
    lastLoad: _lastLoad ? { ..._lastLoad } : null,
    vaultLoaded: [..._vaultLoaded.keys()],
    canLoad: !!can.ok,
    cannotLoadReason: can.ok ? null : can.reason || null,
  };
}

/** Test seam: swap the outside world, and reset state. */
function _setDeps(patch) { Object.assign(_deps, patch); }
function _reset() {
  _loading = null;
  _lastLoad = null;
  _vaultLoaded.clear();
  _aliases.clear();
  _psFailedAt = 0;
  _disk = { at: 0, rows: null, inflight: null };
  _gpu = { at: 0, value: undefined, inflight: null };
  _settings = { ...DEFAULTS };
  _lastBusyAt = _deps.now();
}

module.exports = {
  settings, setSettings, chosenModel, scanTargetId, canLoadNow, diskModels, gpu, maybeLoad, unloadIfIdle,
  describeWait, status, boot, stop, onChange, shortName,
  estimateNeedBytes, decideLoad, gpuFreeBlocks, parseNvidiaSmi,
  POLICIES, IDLE_CHOICES, DEFAULTS,
  _setDeps, _reset, _vaultLoaded,
  _markVaultLoaded: (id, modelKey) => _vaultLoaded.set(id, { modelKey: modelKey || id, at: _deps.now() }),
  _setLastBusy: (t) => { _lastBusyAt = t; },
};
