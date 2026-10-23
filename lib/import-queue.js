/**
 * Import scan queue — a small worker pool for AI scans of newly-referenced files.
 *
 * Files added via the native pickers (referenced in place, never copied) are
 * playable immediately (insertStubs row with the 'unscanned' marker); this
 * queue backfills the AI metadata in the background, exactly like a CLI scan
 * would. It never touches files a separate CLI scan owns — items enter only
 * via /api/import/add-paths (a fresh import) and /api/media/retry-errors (the
 * bulk bar's ↻ Retry errors, for rows whose scan never landed).
 *
 * Concurrency: N workers (IMPORT_WORKERS, default 2, clamped 1..8) each pull
 * from the shared queue until it drains. Running processFile() concurrently is
 * not new ground — commands/scan.js has always driven the same function from a
 * WorkQueue sized endpoints × VISION_WORKERS × PIPELINE_DEPTH; the import queue
 * simply never took advantage of it. setConcurrency() re-pumps immediately, so
 * raising the limit mid-run spins up the extra workers at once; lowering it is
 * cooperative — a worker over the limit finishes its current file and then
 * retires rather than being killed.
 *
 * Vault cooperation: locking closes the DB, so an in-flight item's write
 * throws — it is requeued at the front and its worker exits; every other worker
 * notices the lock at the top of its loop and drains out too. Unlock pumps them
 * all again. A failed scan (e.g. a corrupt file) records the error on the row
 * (still playable; --retry-errors or a rescan picks it up later).
 *
 * Halting: a file failing is normal; the MODEL going away is not. When LM Studio
 * JIT-unloads, an endpoint dies, or a sidecar exits, every remaining file would
 * "fail" in milliseconds and a 2000-file run would be shredded in under a minute
 * with nothing scanned. So lib/model-health.js classifies that case and the queue
 * HALTS instead: the in-flight item goes back to the front of the queue (never
 * counted as failed, never stamped with processing_error), the halt reason is
 * recorded for the panel to show, and no new work dispatches until the user
 * resumes. Nothing is lost — Resume picks the run up exactly where it stopped.
 *
 * Three things can stop dispatch, and status() names which: the vault lock
 * (automatic, clears on unlock), a user pause (the panel's ⏸ button), and a
 * model halt. Any one of them gates _pump(); resume() clears the latter two.
 *
 * Waiting (Settings > Models > Scanning, lib/scan-model.js): before anything
 * is dispatched the queue checks the scan model is loaded. When it is not,
 * files WAIT: nothing is counted as failed, nothing is stamped with
 * processing_error, and lib/scan-model.js decides whether to load it (room on
 * the GPU, the user's choice). The wait clears on its own when the model shows
 * up (a registry change, a re-check every couple of minutes, a load Vault
 * started finishing). The old model halt folded into this: a model that dies
 * mid-run is now a wait with a reason ("The scan model stopped answering")
 * that clears itself, where it used to need Resume. Resume still works, and
 * always tries at once whatever the check says. The "which model?" question
 * stays a halt with its picker: only the user can answer it.
 *
 * Watched-folder files ride in their own lanes (Q.wv / Q.wp, served after
 * everything else) so "Only scan watched folders when the GPU is free" can
 * hold just them while another model is loaded.
 *
 * Failures: the ids that failed in this run are kept (a Set, cheap at 100k)
 * until the user closes the panel, and lib/scan-failures.js groups them by
 * reason from the database. A new batch arriving while failures are still on
 * the panel joins the same run instead of wiping the list.
 *
 * Progress: _total counts everything accepted into the current run, and the
 * last 50 per-file durations feed a rolling average, so status() can offer a
 * real done/total bar with an ETA. A fresh drag-drop onto a fully idle queue
 * starts a new run (counters reset); dropping more while a run is still in
 * flight accumulates into it instead of restarting the bar.
 */

const fs = require('fs');
const path = require('path');
const database = require('./database');
const vault = require('./vault');
const modelHealth = require('./model-health');
const aiSlots = require('./ai-slots');
const scanModel = require('./scan-model');
const scanFailures = require('./scan-failures');

const MIN_WORKERS = 1;
const MAX_WORKERS = 4;          // workers PER INSTANCE (see _workersPerInstance)
const MAX_CONCURRENCY = 32;     // ceiling on instances × workers
const DURATION_SAMPLES = 50;
const MAX_HALT_RETRIES = 3;     // strikes before a file is blamed instead of the model
const NOTICE_TTL_MS = 90_000;   // how long "a copy was unloaded" stays on the panel
const RECHECK_MS = 120_000;     // while waiting: look at LM Studio again this often
const STOP_COOLDOWN_MS = 60_000; // a model that died is not trusted again sooner (see _recheck)
const PENDING_SAMPLE = 20;      // status() names this many queued files, never all of them

/**
 * Four lanes, so a hold on one kind of file never means scanning the whole
 * queue to find another: i/w = added by the user or by a watched folder,
 * v/p = needs a model that reads pictures, or plain text work (documents,
 * audio). Items carry a sequence number, so taking the lowest head keeps the
 * order the files arrived in. Items: { id, filepath, filename, mediaType,
 * source, folder, seq }.
 */
const Q = { iv: [], ip: [], wv: [], wp: [] };
let _seq = 0;
const _active = new Map();      // id -> { id, filename, startedAt }
const _durations = [];          // ms per completed file (success or failure)
const _haltCounts = new Map();  // filepath -> consecutive halts blamed on the model
const _known = new Set();       // filepaths queued or in flight — O(1) dedupe
let _running = 0;               // live workers
/**
 * Workers PER INSTANCE. This is the number the user sees and sets; the real
 * worker count is instances × this. The distinction matters because the two do
 * different jobs: a worker overlaps frame extraction with the AI call for the
 * previous file and adds almost nothing once the GPU is saturated, while a
 * second loaded instance genuinely answers a second request at the same time.
 * Sizing the pool off instances is what stops a three-copy setup from running
 * at one copy's throughput.
 */
let _workersPerInstance = _clamp(parseInt(process.env.IMPORT_WORKERS, 10), 2);
let _concurrency = 0;           // derived, never set directly — see _derive()
let _done = 0;
let _total = 0;
let _userPaused = false;        // the panel's ⏸ button
/**
 * "Which model?" questions, per kind: { reason, filename, at, needsModelChoice,
 * kind }. Each holds only its own kind of file, so a question about pictures
 * never stops documents (and the other way round).
 */
const _halts = { vision: null, plain: null };
let _awaitProbe = false;        // a run just woke: vision waits (briefly) for a fresh look
/**
 * Waiting for the scan model: { code, reason, model, at, stoppedAt, filename }.
 * stoppedAt is set when the model died mid-run (see _recheck's cool-down).
 */
let _wait = null;
let _forced = false;            // Resume / Try now: ignore the gate for the rest of the run
let _holdVision = null;         // the gate's answer while files needing vision are held
let _holdPlain = null;          // the same for documents and audio
let _trial = false;             // one file out to see whether a model we cannot see is back
let _stopStreak = 0;            // dead-model waits in a row: each cool-down doubles
let _recheckTimer = null;
let _kickBusy = false;
const _failedIds = new Set();   // media ids that failed in this run, until the panel is closed
let _failVersion = 0;           // bumps whenever _failedIds changes (the grouping cache key)
/**
 * A one-line "this happened and the scan carried on" for the panel.
 *
 * Losing one copy of three is not a halt and must not raise a picker, but it is
 * not nothing either: the run just got slower and the user deserves to know
 * why. So it says so in a line under the instance strip, and the scan never
 * stops.
 *
 * The `id` is what makes it dismissable. The panel polls every 1.5 s, so a line
 * the user closed would come straight back on the next tick; instead the panel
 * remembers the id it dismissed and stays quiet until a DIFFERENT event arrives
 * with a new one. A registry change no longer clears it — the user ejecting a
 * copy IS a registry change, and clearing on that took the line down before it
 * could be read. It goes when it is closed, when a newer notice replaces it, or
 * at NOTICE_TTL_MS, whichever is first.
 */
let _notice = null;             // { id, at, text }
let _noticeSeq = 0;

function _clamp(n, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.trunc(n)));
}

/** Already queued or mid-scan? O(1) — see _known. */
function isQueued(filepath) {
  return _known.has(filepath);
}

/**
 * Add a file to the run. Returns { position, added } — `added` is false when the
 * file was already queued or in flight, which callers need in order to report an
 * honest count (a bulk retry that silently deduped used to claim it had queued
 * everything it was handed).
 */
function enqueue(item) {
  const wasActive = isActive();
  if (_active.size === 0 && _queued() === 0) {
    _known.clear();               // nothing is queued or running — no stale keys
    _forced = false;              // a Resume belongs to the run it was pressed in
    _trial = false;
    _visionBlock = null;
    _notice = null;               // "Copy :2 was unloaded" was about the last run
    if (_wait && _wait.stoppedAt) _clearStop();   // a stale dead-model wait is not this run's
    _wakeProbe();
    // A drop onto a completely idle queue starts a fresh run — reset the bar.
    // Not while the last run's failures are still on the panel, though: the
    // new files join that run, so the list the user has not read yet stays.
    if (_failedIds.size === 0) {
      _done = 0;
      _total = 0;
      _durations.length = 0;
    }
  }
  const added = !_known.has(item.filepath);
  if (added) {
    _known.add(item.filepath);
    const q = { ...item, source: item.source || 'import', seq: ++_seq };
    Q[_laneOf(q)].push(q);
    _total++;
  }
  _probeOnWake(wasActive);
  _pump();
  // No findIndex here: it made enqueue O(n²) over a bulk add, which is how a
  // 20k-file retry blocked the event loop for seconds. The queue is FIFO, so an
  // item just pushed sits at the back — good enough for the "you are Nth" hint.
  return { position: _active.size + _queued(), added };
}

/** Everything still queued, all lanes. */
function _queued() {
  return Q.iv.length + Q.ip.length + Q.wv.length + Q.wp.length;
}
function _visionQueued() { return Q.iv.length + Q.wv.length; }
function _plainQueued() { return Q.ip.length + Q.wp.length; }
function _watchQueued() { return Q.wv.length + Q.wp.length; }

/** Up to `n` queued items in the order workers take them: the user's, then watched folders. */
function _dispatchOrder(n, lanes = ['iv', 'ip', 'wv', 'wp']) {
  const mine = _peek(n, lanes.filter(l => l[0] === 'i'));
  const watch = _peek(n, lanes.filter(l => l[0] === 'w'));
  return [...mine, ...watch].slice(0, n);
}

/**
 * A model answered "I cannot read pictures" (a 400 such as "does not support
 * images", or a text-only target with nothing else loaded). Pictures and
 * videos stay held, whatever Try now says, until LM Studio's picture changes.
 */
let _visionBlock = null;          // a wait info, or null

/** Up to `n` queued items from these lanes, in arrival order. */
function _peek(n, lanes = ['iv', 'ip', 'wv', 'wp']) {
  const out = [];
  for (const l of lanes) out.push(...Q[l].slice(0, n));
  return out.sort((x, y) => x.seq - y.seq).slice(0, n);
}

/**
 * Does this file need a model that can read pictures? Videos, pictures, GIFs
 * and mixes do. Documents and audio are analysed as text (a transcript, the
 * document's words), and any loaded model can do that.
 */
const VISION_TYPES = new Set(['video', 'image', 'gif', 'mix']);
function _isVisionItem(q) {
  return !q || !q.mediaType || VISION_TYPES.has(q.mediaType);
}

function _laneOf(q) {
  return (q.source === 'watch' ? 'w' : 'i') + (_isVisionItem(q) ? 'v' : 'p');
}

/** Back to the front of its own lane (a halt, a lock, a retry on a sibling). */
function _requeueFront(item) {
  if (item.seq === undefined) item.seq = ++_seq;
  Q[_laneOf(item)].unshift(item);
}

/**
 * "Only scan watched folders when the GPU is free" is on and some model other
 * than the scan model is loaded: watched-folder files are held. Try now
 * overrides it like any other hold: the user asked for the scan, now.
 */
function _gpuBlocked() {
  return !_forced && _gpuBlockedRaw();
}

/** The GPU-free rule's own answer, whatever Try now says. */
function _gpuBlockedRaw() {
  try {
    const s = scanModel.settings();
    if (!s.gpuFreeForWatch) return false;
    return scanModel.gpuFreeBlocks({
      enabled: true, source: 'watch',
      loadedFamilies: aiSlots.activeFamilies(),
      scanFamily: _target().family,
    });
  } catch { return false; }
}

/** Which lanes may start a file now (gate holds and the GPU-free rule). */
function _openLanes() {
  const gpu = _watchQueued() > 0 && _gpuBlocked();
  const v = !_holdVision && !_halts.vision && !_awaitProbe && !_visionBlock;
  const p = !_holdPlain && !_halts.plain;
  return { iv: v, ip: p, wv: v && !gpu, wp: p && !gpu, gpu };
}

/** Is there a file a worker may start right now (ignoring pause / a dead model)? */
function _hasDispatchable() {
  const o = _openLanes();
  return (o.iv && Q.iv.length > 0) || (o.ip && Q.ip.length > 0)
    || (o.wv && Q.wv.length > 0) || (o.wp && Q.wp.length > 0);
}

/** The next file to start, or null. User-started work first, then watched folders. */
function _takeNext() {
  const o = _openLanes();
  const pick = (lanes) => {
    let best = null;
    for (const l of lanes) {
      if (!o[l] || !Q[l].length) continue;
      if (!best || Q[l][0].seq < Q[best][0].seq) best = l;
    }
    return best ? Q[best].shift() : null;
  };
  return pick(['iv', 'ip']) || pick(['wv', 'wp']);
}

/**
 * A scan is starting: find out what is loaded before sizing the pool.
 *
 * Vault no longer polls the AI server in the background, so by the time a scan
 * begins the registry can be an hour old and the user may well have loaded or
 * ejected copies since. This is the moment it matters, so it is one of the few
 * places that spends a probe. Nothing waits for it: the queue starts on the
 * picture it has and resizes itself when the answer lands.
 */
function _probeOnWake(wasActive) {
  if (wasActive || !isActive()) return;
  try { aiSlots.refresh({ force: true }).catch(() => {}); } catch {}
}

/**
 * True while anything is scanning or waiting — the vault's scan probe.
 * A stopped queue reports idle even with work banked: a paused or halted run
 * isn't using the GPU, and claiming otherwise would block the autolock (and
 * every explicit lock) indefinitely while the user is away.
 */
function isActive() {
  // Starting (the quick look at LM Studio before a run's first picture)
  // counts as busy: the run is about to go, not idle.
  return _active.size > 0 || ((_hasDispatchable() || _starting()) && !isPaused());
}

/** A run waiting only for its first fresh look at LM Studio. */
function _starting() {
  return _awaitProbe && _visionQueued() > 0;
}

/**
 * Any reason dispatch is stopped outright. A model that died mid-run is one;
 * a scan model that is not loaded only HOLDS the files that need it (see
 * _refreshHolds), so documents can go on while videos wait.
 */
function isPaused() {
  return vault.isLocked() || _userPaused || (_wait !== null && !!_wait.stoppedAt);
}

/** The question on screen: the vision one first. */
function _haltShown() {
  return _halts.vision || _halts.plain || null;
}

/** Everything queued is held for the scan model (or the GPU) and nothing runs. */
function _allHeld() {
  return _queued() > 0 && _active.size === 0 && !_hasDispatchable() && !_starting()
    && waitingInfo({ sample: 0 }).count > 0;
}

/**
 * Which one — the panel words its message off this.
 *
 * 'model-choice' is a model halt the USER can clear without touching LM Studio:
 * several models are loaded and the request has to name one. The panel shows a
 * picker for it instead of "load the model, then Resume", and POST
 * /api/ai/model-choice resumes the run once a choice lands.
 */
function pausedBy() {
  if (vault.isLocked()) return 'vault';
  if (_userPaused) return 'user';
  if (_haltShown() && _active.size === 0 && !_hasDispatchable()) return 'model-choice';
  // 'waiting' replaced 'model' for a model that is missing or died mid-run:
  // it clears itself, and the panel shows why on its Waiting tab.
  if (_wait && _wait.stoppedAt) return 'waiting';
  if (_allHeld()) return 'waiting';
  return null;
}

/* ── Waiting for the scan model ──────────────────────────────────────────── */

/** The model vision scans ask for (AI_MODEL, the session pick, the saved scan model), or null. */
function _chosen() {
  try { return require('./llm-client').resolveModel({ forScan: true }); } catch { return null; }
}

/**
 * Can we SEE what is loaded? Only on an LM Studio on this PC: it answers
 * /api/v0/models with each model's state, and `lms` can load. Anything else
 * (Ollama, llama.cpp, a remote LM Studio, a server listing nothing) is
 * "unknown" and files go out as they always did, so a model id spelled
 * differently from AI_MODEL, or LM Studio's just-in-time loading, keeps
 * working.
 */
function _observable() {
  let states = [];
  try { states = aiSlots.endpointStates(); } catch {}
  const reach = states.filter(s => s.reachable === true);
  if (!reach.length) return false;
  const lms = require('./lms-cli');
  return reach.every(s => aiSlots.speaksV0(s.url) && lms.isLocalEndpoint(s.url));
}

/**
 * Can a file of this kind be sent right now? Synchronous, off the registry.
 *
 *   ok       a model that can take it is loaded
 *   wait     a local LM Studio says it is not (and the user's choice is to
 *            wait, or Vault can load it)
 *   unknown  we cannot tell: dispatch as before and let the first file find
 *            out (a failure then waits, see _haltOnModel)
 *
 * Vision files (videos, pictures, GIFs): never to a model LM Studio calls text
 * only. In automatic mode text-only models are not candidates; a chosen model
 * that is text only waits with `notVision`. Several usable models with none
 * picked is "ok": the first request raises LM Studio's "which model?" and the
 * panel's picker answers it. A chosen model that is not loaded waits when the
 * user said "Wait until I load it" or Vault can load it; otherwise it goes out
 * and LM Studio's just-in-time loading gets its chance.
 *
 * Text files (documents, audio): any loaded model will do, as today.
 */
function _gate(kind = 'vision') {
  if (!_observable()) return { state: 'unknown' };
  let families = [];
  try { families = aiSlots.activeFamilies(); } catch {}
  if (kind === 'plain') {
    return families.length > 0 ? { state: 'ok' } : { state: 'wait' };
  }
  const chosen = _chosen();
  if (chosen) {
    if (activeSlots() > 0) {
      const fam = _target().family;
      if (aiSlots.familyVision(fam) === false) return { state: 'wait', notVision: { model: chosen, textOnly: [fam] } };
      return { state: 'ok' };
    }
    const policy = scanModel.settings().whenNotLoaded;
    if (policy !== 'wait' && !scanModel.canLoadNow()) return { state: 'unknown' };
    return { state: 'wait' };
  }
  const usable = families.filter(f => aiSlots.familyVision(f) !== false);
  if (usable.length > 0) return { state: 'ok' };
  if (families.length > 0) return { state: 'wait', notVision: { model: null, textOnly: families } };
  return { state: 'wait' };
}

/**
 * Work out which kinds of file are held, from the gate. Resume ("Try now")
 * overrides the gate for the rest of the run, until the gate says ok again
 * (after which a NEW problem may hold files again) or a model dies mid-run.
 */
function _refreshHolds() {
  const gv = _visionQueued() > 0 ? _gate('vision') : null;
  const gp = _plainQueued() > 0 ? _gate('plain') : null;
  const okNow = (!gv || gv.state === 'ok') && (!gp || gp.state === 'ok') && (gv || gp)
    && !(_watchQueued() > 0 && _gpuBlockedRaw());
  if (_forced && okNow) _forced = false;
  // Try now overrides holds, but never a model known to be unable to read
  // pictures: sending pictures there can only fail them.
  _holdVision = gv && gv.state === 'wait' && (!_forced || gv.notVision) ? gv : null;
  _holdPlain = !_forced && gp && gp.state === 'wait' ? gp : null;
  return { gv, gp };
}

function _setWait(info) {
  const fresh = !_wait;
  _wait = {
    code: info.code,
    reason: info.reason,
    model: info.model || null,
    at: _wait ? _wait.at : Date.now(),
    stoppedAt: info.stoppedAt ?? (_wait ? _wait.stoppedAt : null),
    filename: info.filename ?? (_wait ? _wait.filename : null),
    cooldownMs: info.cooldownMs ?? (_wait ? _wait.cooldownMs : null),
    sawGone: info.sawGone ?? (_wait ? _wait.sawGone : false),
    pickAgain: info.pickAgain ?? false,
  };
  if (fresh) console.log(`[Import] waiting for the scan model: ${_wait.reason}`);
  _syncTimer();
}

/**
 * The "cannot read pictures" wait. When the session pick (the scan panel or
 * the Backend page) is what chose the text model, the wait says so and the
 * panel offers to pick again, because that is what clears it.
 */
function _notVisionInfo(g) {
  let session = false;
  try {
    const llm = require('./llm-client');
    session = !!g.notVision.model && !require('../config').lmStudio.model
      && llm.getSessionModel({ kind: 'vision' }) === g.notVision.model;
  } catch {}
  let env = false;
  try { env = !!g.notVision.model && require('../config').lmStudio.model === g.notVision.model; } catch {}
  return {
    ...scanModel.describeWait('not-vision', { model: g.notVision.model, others: g.notVision.textOnly, session, env }),
    pickAgain: session,
  };
}

/**
 * A run is starting on an LM Studio we can see into: what the registry
 * remembers may be an hour old (a vision model since swapped for a text
 * one), so pictures and videos wait for one fresh look, at most
 * WAKE_PROBE_MS, before the first goes out. Documents do not need to.
 */
const WAKE_PROBE_MS = 2000;
const WAKE_FRESH_MS = 10_000;
function _wakeProbe() {
  if (!_observable()) return;
  // Looked at in the last few seconds: trust it, no delay.
  if (Date.now() - (aiSlots.lastCheckedAt() || 0) < WAKE_FRESH_MS) return;
  _awaitProbe = true;
  const done = () => { if (!_awaitProbe) return; _awaitProbe = false; _pump(); };
  const t = setTimeout(done, WAKE_PROBE_MS);
  if (typeof t.unref === 'function') t.unref();
  aiSlots.refresh({ force: true }).catch(() => {}).then(() => { clearTimeout(t); done(); });
}

/**
 * The user answered "which model?" for one kind ('vision' or 'text'; none =
 * both). Clears that question and carries on.
 * @returns {boolean} whether a question was waiting
 */
function answerChoice(kind = null) {
  const keys = kind === 'vision' ? ['vision'] : kind === 'text' ? ['plain'] : ['vision', 'plain'];
  let had = false;
  for (const k of keys) { if (_halts[k]) { had = true; _halts[k] = null; } }
  if (had) _pump();
  return had;
}

/** Files are held: say why, and ask lib/scan-model whether to load the scan model. */
function _enterWait(g) {
  if (_wait && _wait.stoppedAt) return;           // the more specific reason stays
  if (g && g.notVision) {
    // Nothing to load: the model that is there cannot read pictures.
    _setWait(_notVisionInfo(g));
    return;
  }
  const chosen = _chosen();
  if (!_wait) {
    if (!chosen) _setWait(scanModel.describeWait('no-model'));
    else _setWait(scanModel.describeWait('checking', { model: chosen }));
  }
  _kickLoad();
}

/**
 * Ask lib/scan-model to load the scan model if the user's choice allows, and
 * show its answer as the wait's reason. One ask at a time. A wait for a model
 * that died mid-run keeps its own reason unless a load is now under way.
 */
function _kickLoad({ force = false } = {}) {
  if (_kickBusy && !force) return Promise.resolve(null);
  _kickBusy = true;
  return scanModel.maybeLoad({ force, target: _chosen() })
    .then((w) => {
      if (!w || w.code === 'locked') return w;
      if (_wait && (!_wait.stoppedAt || w.code === 'loading')) _setWait({ code: w.code, reason: w.reason, model: w.model });
      return w;
    })
    .catch(() => null)
    .finally(() => { _kickBusy = false; });
}

/**
 * Look again: the registry changed, the timer fired, a load finished, or the
 * settings changed. Clears the wait once the scan model is there.
 *
 * The cool-down: a model that died mid-run often still LOOKS loaded (LM Studio
 * lists it, every request fails), and clearing the wait on the very next probe
 * would burn the poison-pill strikes of file after file every few seconds. So
 * after a model stopped answering the wait only clears once STOP_COOLDOWN_MS
 * has passed (looked at again the moment it ends); a fresh load or Resume
 * clears it at once.
 */
let _cooldownTimer = null;
function _recheck() {
  if (vault.isLocked()) return;
  if (_wait && _wait.stoppedAt) {
    if (_queued() === 0 && _active.size === 0) { _clearStop(); return; }
    const kind = _visionQueued() > 0 ? 'vision' : 'plain';
    const g = _gate(kind);
    const left = (_wait.cooldownMs || STOP_COOLDOWN_MS) - (Date.now() - _wait.stoppedAt);
    const seen = _observable();
    // LM Studio has looked since the model died and does not list it: the
    // next time it does, the user loaded it again, and that need not wait.
    if (seen && g.state === 'wait' && (aiSlots.lastCheckedAt() || 0) > _wait.stoppedAt) _wait.sawGone = true;
    const reloaded = seen && g.state === 'ok' && _wait.sawGone;
    if (left > 0 && !reloaded) {
      _scheduleCooldown(left);
      if (g.state === 'wait' && !g.notVision && _queued() > 0) _kickLoad();
    } else if (g.state === 'ok' || g.state === 'unknown') {
      // ONE file finds out whether the model answers again, whether or not
      // LM Studio lists it (a listed model can still be dead). It working
      // carries the run on at full speed; it failing waits again, longer,
      // and costs that file nothing.
      console.log(reloaded ? '[Import] the scan model was loaded again, trying one file'
        : '[Import] trying one file to see whether the model is back');
      _clearStop({ keepStreak: true });
      _trial = true;
    } else if (g.state === 'wait' && !g.notVision && _queued() > 0) {
      _kickLoad();               // room may have appeared, or the choice changed
    }
  }
  _pump();
}

/** Look again the moment a dead model's cool-down ends, not at the next 2-minute tick. */
function _scheduleCooldown(ms) {
  if (_cooldownTimer) return;
  _cooldownTimer = setTimeout(() => {
    _cooldownTimer = null;
    aiSlots.refresh({ force: true }).catch(() => {}).then(() => _recheck());
  }, Math.max(0, ms) + 50);
  if (typeof _cooldownTimer.unref === 'function') _cooldownTimer.unref();
}

/** The dead-model wait is over (or no longer means anything: the queue emptied). */
function _clearStop({ keepStreak = false } = {}) {
  if (_wait && _wait.stoppedAt) _wait = null;
  if (_cooldownTimer) { clearTimeout(_cooldownTimer); _cooldownTimer = null; }
  if (!keepStreak) _stopStreak = 0;
  _syncTimer();
}

/** While anything waits, look at LM Studio again every RECHECK_MS. */
let _recheckEvery = 0;
function _syncTimer() {
  const held = _wait !== null || _holdVision !== null || _holdPlain !== null || _visionBlock !== null
    || (_watchQueued() > 0 && _gpuBlocked());
  const need = held && _queued() > 0;
  // An LM Studio on this PC answers /api/v0/models in a millisecond, so while
  // files are held there it is looked at every FAST_POLL_MS: a model loaded
  // again is noticed within seconds. Anything else, every RECHECK_MS.
  const every = need ? (_observable() ? _timings.fastPollMs : RECHECK_MS) : 0;
  if (_recheckTimer && every !== _recheckEvery) { clearInterval(_recheckTimer); _recheckTimer = null; }
  if (every && !_recheckTimer) {
    _recheckEvery = every;
    _recheckTimer = setInterval(() => {
      if (vault.isLocked()) return;
      aiSlots.refresh({ force: true }).catch(() => {}).then(() => _recheck());
    }, every);
    if (typeof _recheckTimer.unref === 'function') _recheckTimer.unref();
  }
}
const _timings = { fastPollMs: 12_000 };

/** "Load anyway" from the Waiting tab: load the scan model whatever the room check says. */
function loadNow() {
  return _kickLoad({ force: true });
}

/**
 * What is waiting and why, for the panel's Waiting tab.
 * @returns {{ count, code, reason, model, since, gpuBusy, sample }}
 */
function waitingInfo({ sample = 50 } = {}) {
  const none = { count: 0, code: null, reason: null, model: null, since: null, gpuBusy: false, loadable: false, sample: [] };
  const stopped = !!(_wait && _wait.stoppedAt);
  // Real waits only: a "which model?" question is not one (the panel asks it
  // itself), and neither is the quick look at a run's start.
  const gpu = _watchQueued() > 0 && _gpuBlocked();
  const vHeld = !!(_holdVision || _visionBlock);
  const lanesHeld = { iv: vHeld, ip: !!_holdPlain, wv: vHeld || gpu, wp: !!_holdPlain || gpu };
  const held = stopped ? ['iv', 'ip', 'wv', 'wp'] : ['iv', 'ip', 'wv', 'wp'].filter(l => lanesHeld[l]);
  const count = held.reduce((n, l) => n + Q[l].length, 0);
  if (!count) return none;
  const gpuOnly = !stopped && !vHeld && !_holdPlain && gpu;
  let info = _wait || (_visionBlock ? { ..._visionBlock, at: null } : null);
  if (!info || gpuOnly) {
    let others = [];
    try { others = aiSlots.activeFamilies().filter(f => f !== _target().family); } catch {}
    info = { ...scanModel.describeWait('gpu-busy', { others }), at: null };
  }
  return {
    count,
    code: info.code,
    reason: info.reason,
    model: info.model || null,
    since: info.at || null,
    gpuBusy: gpuOnly,
    // Whether "Load anyway" can do anything: there is a scan model to load
    // and Vault can load models here.
    // Not for a model LM Studio still lists (dead but listed): loading it
    // again would only make a second copy.
    // Right after a death the model was listed (it was answering), so not
    // until LM Studio has looked again and does not list it (sawGone).
    loadable: LOADABLE_CODES.has(info.code) && !!_chosen() && scanModel.canLoadNow() && activeSlots() === 0
      && !(stopped && !_wait.sawGone),
    pickAgain: !!info.pickAgain,
    sample: sample > 0 ? _dispatchOrder(sample, held).map(_itemView) : [],
  };
}
const LOADABLE_CODES = new Set(['policy-wait', 'no-room', 'no-gpu-info', 'unknown-size', 'load-failed', 'model-stopped', 'checking']);

function _itemView(q) {
  return {
    id: q.id,
    filename: q.filename,
    folder: path.dirname(String(q.filepath || '')),
    source: q.source || 'import',
    watchFolder: q.source === 'watch' && q.folder ? q.folder : null,
  };
}

/* ── Failures of this run ────────────────────────────────────────────────── */

function _markFailed(id) {
  if (id === undefined || id === null) return;
  if (!_failedIds.has(id)) { _failedIds.add(id); _failVersion++; }
}

/** Ids that failed in this run (a copy). */
function failedIds() {
  return [..._failedIds];
}

function failVersion() {
  return _failVersion;
}

/**
 * These are no longer failed (fixed by Force refresh, a rescan, or gone).
 * They count as done for the bar: the file is sorted.
 */
function forgetFailures(ids, { requeued = false } = {}) {
  let n = 0;
  for (const id of ids || []) {
    if (_failedIds.delete(id)) n++;
  }
  if (n) {
    // Going back in the queue: enqueue counts it into the total again.
    if (requeued) _total = Math.max(0, _total - n); else _done += n;
    _failVersion++;
  }
  return n;
}

/**
 * The panel was closed: the failure list goes with it. With nothing queued or
 * running the run is over, so the counters reset too.
 */
function clearFailures() {
  const n = _failedIds.size;
  _failedIds.clear();
  _failVersion++;
  if (_active.size === 0 && _queued() === 0) {
    _done = 0; _total = 0; _durations.length = 0;
  }
  return n;
}

/**
 * Queue the failed files of this run again: all of them, or one reason's.
 * Reads in chunks with a yield between them (a retry of 100k files must not
 * stall the server); files missing from disk or in the trash stay failed.
 */
async function retryFailures(key = null) {
  const handle = database.get();
  const ids = await scanFailures.idsFor(handle, [..._failedIds], key);
  let queued = 0, alreadyQueued = 0, missing = 0;
  for (let i = 0; i < ids.length; i += 500) {
    if (vault.isLocked()) break;
    const chunk = ids.slice(i, i + 500);
    const rows = handle.prepare(
      `SELECT id, filepath, filename, media_type FROM media
        WHERE id IN (${chunk.map(() => '?').join(',')}) AND user_trashed = 0`
    ).all(...chunk);
    for (const row of rows) {
      if (!fs.existsSync(row.filepath)) { missing++; continue; }
      if (_failedIds.delete(row.id)) _total = Math.max(0, _total - 1);
      const { added } = enqueue({
        id: row.id, filepath: row.filepath, filename: row.filename, mediaType: row.media_type, source: 'retry',
      });
      if (added) queued++; else alreadyQueued++;
    }
    _failVersion++;
    if (i + 500 < ids.length) await new Promise(r => setImmediate(r));
  }
  return { matched: ids.length, queued, alreadyQueued, missing };
}

/**
 * Stop the run because the model went away.
 *
 * The item normally goes back to the FRONT of the queue — it wasn't its fault,
 * and Resume should retry it first. But a file that has halted MAX_HALT_RETRIES
 * times running is a poison pill, not a victim: a frame batch that kills the
 * server every time, or one that always trips the socket timeout. Left at the
 * front it wedges the queue permanently — every Resume re-halts on the same
 * file, and the only way out is Cancel, which throws away the entire run. That
 * is exactly the outcome this feature exists to prevent. Past the cap the file
 * is recorded as an ordinary failure so the queue can get past it (a rescan or
 * the panel's Retry errors picks it up later).
 *
 * The run halts either way: the user is still told, and nothing marches on into
 * an endpoint that might genuinely be dead. First worker to notice owns the
 * reason — the others are about to fail identically and would just churn it.
 */
/**
 * One instance went away, but siblings are still loaded: keep going.
 *
 * With several copies of a model loaded, LM Studio unloading one of them is a
 * routine event, not a dead backend. Halting the whole run for it would undo
 * the entire point of loading extras. lib/llm-client.js has already retired the
 * failing slot by the time we get here, so "is anyone left?" is just a count.
 * The strike counter is shared with _haltOnModel so a file that trips this
 * every single time still stops going round in circles.
 *
 * @returns {boolean} true when the file was requeued and the run continues
 */
function _retryOnSurvivingInstance(item, reason) {
  const left = activeSlots();
  if (left <= 0) return false;
  const strikes = (_haltCounts.get(item.filepath) || 0) + 1;
  if (strikes >= MAX_HALT_RETRIES) return false;   // let the halt path judge it
  _haltCounts.set(item.filepath, strikes);
  _requeueFront(item);
  _setNotice(left);
  console.warn(`[Import] one instance stopped answering, retrying ${item.filename} on another: ${String(reason).slice(0, 160)}`);
  return true;
}

/** Name the copy that went, if the registry retired one in the last few seconds. */
function _setNotice(left) {
  let which = 'A copy';
  try {
    const gone = aiSlots.lastGone();
    if (gone && Date.now() - gone.at < 30_000 && gone.suffix) which = `Copy ${gone.suffix}`;
  } catch {}
  _notice = {
    id: `n${++_noticeSeq}`,
    at: Date.now(),
    text: `${which} was unloaded. Continuing on ${left} cop${left === 1 ? 'y' : 'ies'}.`,
  };
}

/** The live notice, or null once it has aged out. */
function notice() {
  if (_notice && Date.now() - _notice.at >= NOTICE_TTL_MS) _notice = null;
  return _notice;
}

/**
 * Is this a question for the user rather than a breakage?
 *
 * Only when the family scans are going to has no copies left AND something else
 * is loaded to choose instead. With a sibling still up the run simply carries
 * on; with nothing at all loaded there is nothing to pick, so the plain
 * "model unavailable, press Resume" halt is the honest message.
 */
function _needsModelChoice() {
  try {
    if (activeSlots() > 0) return false;
    // A pinned copy that died while its siblings live is not a "which model?"
    // question: the family is still there. Only a family with nothing left,
    // next to some OTHER loaded family, needs the user to choose.
    const { family } = _target();
    if (family && aiSlots.activeCount(family) > 0) return false;
    return aiSlots.activeFamilies().some(f => f !== family);
  } catch { return false; }
}

/** "This model cannot read pictures", in the words servers use. */
function _isNotVisionAnswer(text) {
  return /cannot read pictures|does not support (?:images|vision|image)|image input is not supported|vision (?:is )?not supported|model does not support image/i
    .test(String(text || ''));
}

/** Put a picture back and hold pictures until LM Studio's models change. */
function _holdForNotVision(item, text) {
  _requeueFront(item);
  // processFile already wrote the reply onto the row; this was not the file.
  try {
    database.get().prepare("UPDATE media SET processing_error = 'unscanned' WHERE id = ? AND processing_error IS NOT NULL")
      .run(item.id);
  } catch {}
  if (!_visionBlock) {
    const fam = _target().family;
    _visionBlock = scanModel.describeWait('not-vision', fam ? { model: fam, refused: true } : { others: [] });
    console.warn(`[Import] the model cannot read pictures, pictures wait: ${String(text).slice(0, 160)}`);
  }
  if (_trial) _trial = false;
  try { aiSlots.refresh({ force: true }).catch(() => {}); } catch {}
  _syncTimer();
  return true;
}

/** Is this "several models are loaded, name one"? Read from the flag or the words. */
function _isChoiceAnswer(flag, text) {
  if (flag) return true;
  const t = String(text || '');
  return /multiple models/i.test(t) || t === modelHealth.MODEL_CHOICE_REASON;
}

function _haltOnModel(item, reason, { needsModelChoice = false } = {}) {
  // "Which model?" is a question, not a dead model: no strike, no wait.
  // A trial file failing is the model's fault, not the file's: no strike,
  // and it goes to the back of its lane so the next trial is another file
  // (a file that kills the model every time then gets its strikes only on
  // runs where the model otherwise answers).
  const trial = !!item._trial;
  delete item._trial;
  const strikes = needsModelChoice || trial ? 0 : (_haltCounts.get(item.filepath) || 0) + 1;
  let requeued = true;
  if (needsModelChoice) {
    _requeueFront(item);
  } else if (trial) {
    item.seq = ++_seq;                  // to the back: the next trial is another file
    Q[_laneOf(item)].push(item);
  } else if (strikes >= MAX_HALT_RETRIES) {
    requeued = false;
    _haltCounts.delete(item.filepath);
    _markFailed(item.id);
    console.warn(`[Import] ${item.filename} halted the scan ${strikes}×, blaming the file and moving on`);
    try {
      database.get().prepare('UPDATE media SET processing_error = ? WHERE id = ?')
        .run(`Repeatedly interrupted the scan: ${String(reason).slice(0, 240)}`, item.id);
    } catch {}
  } else {
    _haltCounts.set(item.filepath, strikes);
    _requeueFront(item);
  }
  const text = String(reason || 'Model unavailable').slice(0, 300);
  if (needsModelChoice) {
    // A question only the user can answer: it holds this kind of file, with
    // its picker; the other kind carries on.
    const kind = _isVisionItem(item) ? 'vision' : 'plain';
    if (!_halts[kind]) {
      _halts[kind] = { reason: text, filename: item?.filename || null, at: Date.now(), needsModelChoice: true, kind };
      console.warn(`[Import] scan halted (${kind}): ${text}${item ? ` (at ${item.filename})` : ''}`);
    }
  } else if (!_wait || !_wait.stoppedAt) {
    _forced = false;            // a real new event: the gate gets its say again
    _trial = false;
    // The model went away: wait for it rather than stop. First worker to
    // notice owns the reason; the others are about to fail identically.
    let reachable = false;
    try { reachable = aiSlots.endpointStates().some(s => s.reachable === true); } catch {}
    const refused = /nothing is listening|lost the connection/i.test(text);
    // Where Vault cannot see what is loaded, it tries one file after the
    // cool-down; each failure doubles the cool-down (up to 16 min).
    const blind = !_observable();
    const cooldownMs = STOP_COOLDOWN_MS * 2 ** Math.min(_stopStreak, 4);
    _stopStreak++;
    const info = scanModel.describeWait(!reachable || refused ? 'not-running' : 'model-stopped',
      { model: _chosen() || _target().family, detail: text, blind });
    _setWait({ ...info, stoppedAt: Date.now(), filename: item?.filename || null, cooldownMs, sawGone: false });
    _scheduleCooldown(cooldownMs);
    // On LM Studio, look again shortly: if it no longer lists the model, the
    // user loading it again can carry the run on at once (see _recheck).
    if (!blind) {
      const t = setTimeout(() => { aiSlots.refresh({ force: true }).catch(() => {}).then(() => _recheck()); }, 3500);
      if (typeof t.unref === 'function') t.unref();
    }
    console.warn(`[Import] the scan model stopped answering, files wait: ${text}${item ? ` (at ${item.filename})` : ''}`);
  }
  return requeued;      // false = the item left the queue, so drop its _known key
}

/** User pause — in-flight files finish, nothing new starts. */
function pause() {
  _userPaused = true;
  return status();
}

/**
 * Clear the user pause, any halt and any wait, then dispatch again. A wait the
 * user resumes is tried at once even if the check still says the model is not
 * there: a check that is wrong must never trap the user in a stopped queue.
 */
function resume() {
  const wasActive = isActive();
  _userPaused = false;
  _halts.vision = null;
  _halts.plain = null;
  if (_wait || _holdVision || _holdPlain || (_watchQueued() > 0 && _gpuBlocked())) _forced = true;
  _wait = null;
  _holdVision = null;
  _holdPlain = null;
  _probeOnWake(wasActive);          // the user has probably just fixed LM Studio
  _pump();
  return status();
}

/**
 * Drop everything still queued. In-flight files are left to finish — there is
 * no safe way to abort a vision call mid-stream, and their rows are half-written
 * until they do. _total is wound back so the bar reads honestly rather than
 * sitting at "40/2000" forever.
 */
function cancel() {
  const dropped = _queued();
  for (const l of Object.keys(Q)) {
    for (const q of Q[l]) _known.delete(q.filepath);   // active items stay known
    Q[l].length = 0;
  }
  _trial = false;
  _stopStreak = 0;
  _awaitProbe = false;
  _visionBlock = null;
  // Cancel ends the run, failure list included (the rows keep their errors,
  // and the library's Scan failed filter still finds them).
  _failedIds.clear();
  _failVersion++;
  // Cancel ends the run: what is left is what finished and what is still finishing.
  _total = _done + _active.size;
  _userPaused = false;
  _halts.vision = null;
  _halts.plain = null;
  _wait = null;
  _forced = false;
  _holdVision = null;
  _holdPlain = null;
  _syncTimer();
  _notice = null;
  _haltCounts.clear();
  if (dropped) console.log(`[Import] scan cancelled: ${dropped} queued file(s) dropped`);
  return { dropped, active: _active.size };
}

/** Where scans are going right now: a family, one pinned copy, or nowhere. */
function _target() {
  try {
    const llm = require('./llm-client');
    // As a scan sees it: in automatic mode only models that read pictures.
    const t = llm.resolveTarget({ forScan: true });
    return { family: t.family, pinnedId: t.pinnedId };
  } catch { return { family: null, pinnedId: null }; }
}

/** Which model family scans are going to right now (null when it is ambiguous). */
function _family() {
  return _target().family;
}

/**
 * How many copies this run can actually keep busy.
 *
 * Zero while the registry knows nothing, and also zero while the family is
 * ambiguous (several loaded, none picked) — fanning out across unrelated models
 * would send half the run to the wrong one, and that case is about to stop for
 * a model choice anyway. A pinned copy counts only itself: the family may have
 * three instances, but a pin means every request goes to one of them, and lanes
 * opened for the other two would just queue up behind it.
 */
function activeSlots() {
  try {
    const { family, pinnedId } = _target();
    if (pinnedId) return aiSlots.activeCountForId(pinnedId);
    return family ? aiSlots.activeCount(family) : 0;
  } catch { return 0; }
}

/**
 * The real worker count: instances × workers-per-instance.
 *
 * An empty registry counts as one instance rather than zero, so a setup with no
 * /v1/models answer (Ollama, a probe that failed, the first second after boot)
 * keeps exactly the pool size it had before slots existed.
 */
function _derive() {
  const slots = Math.max(1, activeSlots());
  const next = Math.max(MIN_WORKERS, Math.min(MAX_CONCURRENCY, slots * _workersPerInstance));
  if (next === _concurrency) return _concurrency;
  _concurrency = next;
  _pump();                       // more lanes: start the extra workers now
  return _concurrency;           // fewer: honoured as workers finish
}

_derive();
// An instance appearing or vanishing resizes the pool with no user action. The
// notice is deliberately NOT cleared here: the ejection that raised it is
// itself a registry change, so doing so took the line down in the same tick it
// appeared. It expires on its own, or the user closes it.
aiSlots.onChange(() => { _visionBlock = null; _derive(); _recheck(); });
// A load Vault started finished (or failed), or the Scanning settings changed.
scanModel.onChange(() => { _recheck(); });

function getConcurrency() {
  return _concurrency;
}

function getWorkersPerInstance() {
  return _workersPerInstance;
}

/** Change workers per instance at runtime; takes effect without a restart. */
function setWorkersPerInstance(n) {
  _workersPerInstance = _clamp(typeof n === 'number' ? n : parseInt(n, 10), _workersPerInstance);
  _derive();
  return _workersPerInstance;
}

/**
 * Internal: force an absolute worker count, bypassing the instances × workers
 * arithmetic. Kept for tests and for callers that really do mean "N workers".
 */
function setConcurrency(n) {
  const raw = typeof n === 'number' ? n : parseInt(n, 10);
  if (!Number.isFinite(raw)) return _concurrency;
  _concurrency = Math.max(MIN_WORKERS, Math.min(MAX_CONCURRENCY, Math.trunc(raw)));
  _pump();
  return _concurrency;
}

function _avgMs() {
  if (_durations.length === 0) return null;
  return Math.round(_durations.reduce((a, b) => a + b, 0) / _durations.length);
}

function status() {
  const avgMs = _avgMs();
  const _failed = _failedIds.size;
  // Held files are not counted into the time left: they are not moving.
  const remaining = _total - _done - _failed - waitingInfo({ sample: 0 }).count;
  // Everything queued is held: as far as the panel goes, the run is stopped.
  // A "which model?" question with nothing else running is a stop too.
  const paused = isPaused() || _allHeld() || pausedBy() === 'model-choice';
  let etaMs = null;
  // A stopped queue has no honest ETA — the old estimate would tick down against
  // work that isn't moving.
  if (!paused && avgMs !== null && remaining > 0) {
    const lanes = Math.max(1, Math.min(_concurrency, remaining || 1));
    etaMs = Math.round(remaining * avgMs / lanes);
  }
  const { family, pinnedId } = _target();
  return {
    // `suffix`/`slot` name the copy answering for this file RIGHT NOW, which is
    // null between AI calls (frames, database writes). The panel leaves the
    // label off then rather than claiming an instance that has moved on.
    active: [..._active.values()].map(a => {
      const at = (() => { try { return aiSlots.slotForFile(a.id); } catch { return null; } })();
      return {
        id: a.id,
        filename: a.filename,
        startedAt: a.startedAt,
        suffix: at ? at.suffix : null,
        slot: at ? at.id : null,
        // Where it came from, for "Now: <file> from <watched folder>".
        source: a.source || 'import',
        watchFolder: a.source === 'watch' && a.folder ? a.folder : null,
      };
    }),
    // A sample, never the whole queue: this is polled every 1.5 s, and a
    // 100k-file queue made it a megabytes-per-poll response.
    // In the order workers will take them: the user's files, then watched folders.
    pending: _dispatchOrder(PENDING_SAMPLE).map(q => ({ id: q.id, filename: q.filename })),
    pendingCount: _queued(),
    paused,
    pausedBy: pausedBy(),
    halt: _haltShown(),
    // Files held for the scan model, and why (null when nothing waits).
    waiting: (() => {
      const w = waitingInfo({ sample: 0 });
      return w.count ? { count: w.count, code: w.code, reason: w.reason, model: w.model, since: w.since, gpuBusy: w.gpuBusy, loadable: w.loadable, pickAgain: w.pickAgain } : null;
    })(),
    // "model (N copies)" on the Progress tab.
    model: (() => {
      const name = family || _chosen();
      return name ? { name: scanModel.shortName(name), copies: activeSlots() } : null;
    })(),
    loading: (() => { try { return scanModel.status().loading; } catch { return null; } })(),
    // Something worth saying that did NOT stop the run (8.5). The panel prints
    // it under the instance strip; null means there is nothing to say.
    // Not while every copy is dead and the run waits: "continuing on 1 copy"
    // would be untrue.
    notice: (_wait && _wait.stoppedAt) ? null : notice(),
    starting: _starting(),
    done: _done,
    failed: _failed,
    total: _total,
    concurrency: _concurrency,
    // The scan panel draws its per-instance strip straight off these, so it
    // never has to make a second request just to label the bar.
    workersPerInstance: _workersPerInstance,
    activeSlots: activeSlots(),
    // Pinned to one copy: the strip shows that copy only, matching the lanes.
    instances: (() => {
      try {
        const all = aiSlots.instancesOf(family);
        return pinnedId ? all.filter(i => i.id === pinnedId) : all;
      } catch { return []; }
    })(),
    avgMs,
    etaMs,
  };
}

/** Spawn workers up to the current limit while there is queued work. */
function _pump() {
  if (_queued() === 0 && _active.size === 0 && _wait && _wait.stoppedAt) _clearStop();
  if (isPaused() || _queued() === 0) { _syncTimer(); return; }
  // Is a model that can take each kind of file there? If not, those files
  // are held (and the scan model may get loaded) instead of being sent to a
  // model that cannot answer. Documents and audio go on meanwhile. Resume
  // overrides this for the rest of the run, so a check that is wrong can
  // never trap the queue.
  _refreshHolds();
  if (_holdVision || _holdPlain) {
    _enterWait(_holdVision || _holdPlain);
  } else if (_wait && !_wait.stoppedAt) {
    _wait = null;                 // nothing is held any more
  }
  if (!_hasDispatchable()) { _syncTimer(); return; }
  while (_running < _concurrency && _hasDispatchable() && !isPaused()) {
    if (_trial && (_active.size > 0 || _running > 0)) break;   // one file at a time on a trial
    _running++;
    // Re-pump on the way out: workers read _running to decide whether they are
    // over the limit, so several settling in the same flush all see the stale
    // pre-decrement count and all retire at once. Pumping after the decrement
    // is what refills the gap — without it a lowered limit (or one shared
    // promise rejecting for every worker) strands the rest of the queue for
    // good. Safe to call unconditionally: the guards above no-op on an empty
    // queue or a locked vault, and a worker always reaches its first await
    // before returning, so this can't recurse.
    _worker().catch(() => {}).finally(() => { _running--; _pump(); });
  }
}

async function _worker() {
  while (_queued() > 0) {
    if (isPaused()) break;                    // vault lock / user pause / halt / dead model
    _refreshHolds();
    if (!_hasDispatchable()) break;           // what is left is held for the scan model
    if (_trial && _active.size > 0) break;    // a trial is one file
    if (_running > _concurrency) break;       // limit was lowered — retire
    const item = _takeNext();
    if (!item) break;
    if (_trial) item._trial = true;
    const startedAt = Date.now();
    _active.set(item.id, {
      id: item.id, filename: item.filename, filepath: item.filepath, startedAt,
      source: item.source, folder: item.folder,
    });
    let counted = true;
    let requeued = false;         // true = still in _queue, so keep its _known key
    try {
      const { processFile } = require('../commands/scan');
      require('./frame-extractor').ensureTempDir();
      // Carry the media id through the whole scan in async context. Every AI
      // call underneath, however deep, can then say which file it is for
      // without processFile and every processor growing a parameter that only
      // exists to draw a label. See lib/ai-slots.js fileContext.
      // Scoped to this file: see ai-slots runScan. vision decides whether the
      // saved scan model and the "reads pictures only" rule apply.
      const result = await aiSlots.runScan({ mediaId: item.id, scan: true, vision: _isVisionItem(item) }, () => processFile(
        { path: item.filepath, name: item.filename, mediaType: item.mediaType },
        { reprocess: true, retryErrors: true }
      ));
      if (result?.modelUnavailable && _isChoiceAnswer(result.needsModelChoice, result.error)) {
        // "Multiple models are loaded": a question for the user, the same as
        // on dev. Never a dying copy, never a strike.
        counted = false;
        requeued = _haltOnModel(item, result.error, { needsModelChoice: true });
        break;
      }
      if (result?.modelUnavailable) {
        // Not this file's fault (usually) — stop the run rather than marching
        // the rest of the queue into the same dead endpoint. _haltOnModel owns
        // the requeue, including the poison-pill cap.
        counted = false;
        // Siblings first, whatever the server called the error: one copy of
        // three going away is not a question for the user, it is a smaller
        // pool. The picker is only for a family with nothing left.
        if (_retryOnSurvivingInstance(item, result.error)) {
          requeued = true;
          continue;                 // other copies are alive, the run goes on
        }
        requeued = _haltOnModel(item, result.error, { needsModelChoice: _needsModelChoice() });
        break;
      }
      if ((result?.error || result?.modelUnavailable) && _isVisionItem(item) && _isNotVisionAnswer(result.error)) {
        // The model cannot read pictures: hold pictures and videos, never
        // fail or strike the file, and look at LM Studio again.
        counted = false;
        requeued = _holdForNotVision(item, result.error);
        break;
      }
      if (result?.error) {
        // The model answered (the file was the problem): a trial is over.
        if (_trial) { _trial = false; setImmediate(_pump); }
        _markFailed(item.id);
        console.warn(`[Import] scan failed for ${item.filename}: ${result.error}`);
      } else {
        _haltCounts.delete(item.filepath);      // it scanned — strikes reset
        _stopStreak = 0;                         // a model answered: back-off over
        if (_trial) { _trial = false; setImmediate(_pump); }   // back to full speed
        _done++;
        try { require('./embeddings').invalidateCache(); } catch {}
        console.log(`[Import] scanned ${item.filename}`);
      }
    } catch (err) {
      if (vault.isLocked()) {
        // Lock interrupted the scan mid-file — retry this one after unlock
        _requeueFront(item);
        counted = false;
        requeued = true;
        console.log(`[Import] scan of ${item.filename} interrupted by Vault lock, requeued`);
      } else if (_isVisionItem(item) && _isNotVisionAnswer(err && err.message)) {
        counted = false;
        requeued = _holdForNotVision(item, err.message);
      } else if (modelHealth.isModelUnavailable(err) && _isChoiceAnswer(modelHealth.isModelChoiceNeeded(err), err.message)) {
        counted = false;
        requeued = _haltOnModel(item, modelHealth.MODEL_CHOICE_REASON, { needsModelChoice: true });
      } else if (modelHealth.isModelUnavailable(err)) {
        // Threw rather than returning — same deal, same cap.
        counted = false;
        const reason = err.modelReason || modelHealth.describe(err);
        if (_retryOnSurvivingInstance(item, reason)) {
          requeued = true;
        } else {
          requeued = _haltOnModel(item, reason, { needsModelChoice: _needsModelChoice() });
        }
      } else {
        _markFailed(item.id);
        console.warn(`[Import] scan error for ${item.filename}: ${err.message}`);
        try {
          database.get().prepare('UPDATE media SET processing_error = ? WHERE id = ?')
            .run(String(err.message).slice(0, 300), item.id);
        } catch {}
      }
    } finally {
      _active.delete(item.id);
      // The file has left the system unless a halt/lock put it back — only then
      // may it be enqueued again.
      if (!requeued) _known.delete(item.filepath);
      if (counted) {
        _durations.push(Date.now() - startedAt);
        if (_durations.length > DURATION_SAMPLES) _durations.shift();
      }
      if (!requeued) _notifyDone(item);
    }
  }
}

/* Listeners told when a file has left the queue for good (scanned or failed;
   never for a halt/lock requeue). The face auto-index hook lives here. */
const _doneListeners = [];
function onItemDone(fn) { _doneListeners.push(fn); }
function _notifyDone(item) {
  for (const fn of _doneListeners) {
    try { fn(item); } catch (err) { console.warn(`[Import] done listener failed: ${err.message}`); }
  }
}

vault.onChange((event) => { if (event === 'unlocked') _pump(); });

module.exports = {
  enqueue, isActive, status, setConcurrency, getConcurrency,
  setWorkersPerInstance, getWorkersPerInstance, activeSlots,
  pause, resume, cancel, isPaused, pausedBy, isQueued, notice, onItemDone,
  waitingInfo, loadNow, answerChoice, failedIds, failVersion, forgetFailures, clearFailures, retryFailures,
  // Test seams. The halt matrix and the notice are decided deep inside a
  // worker loop that would otherwise need a database, a scan and a real model
  // to reach, and they are exactly the rules worth pinning down.
  _setTimings: (t) => Object.assign(_timings, t),
  _needsModelChoice, _retryOnSurvivingInstance, _gate, _recheck, _haltOnModel, _markFailed,
};
