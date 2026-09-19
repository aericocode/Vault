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
 * Progress: _total counts everything accepted into the current run, and the
 * last 50 per-file durations feed a rolling average, so status() can offer a
 * real done/total bar with an ETA. A fresh drag-drop onto a fully idle queue
 * starts a new run (counters reset); dropping more while a run is still in
 * flight accumulates into it instead of restarting the bar.
 */

const database = require('./database');
const vault = require('./vault');
const modelHealth = require('./model-health');
const aiSlots = require('./ai-slots');

const MIN_WORKERS = 1;
const MAX_WORKERS = 4;          // workers PER INSTANCE (see _workersPerInstance)
const MAX_CONCURRENCY = 32;     // ceiling on instances × workers
const DURATION_SAMPLES = 50;
const MAX_HALT_RETRIES = 3;     // strikes before a file is blamed instead of the model
const NOTICE_TTL_MS = 90_000;   // how long "a copy was unloaded" stays on the panel

const _queue = [];              // [{ id, filepath, filename, mediaType }]
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
let _failed = 0;
let _total = 0;
let _userPaused = false;        // the panel's ⏸ button
let _halt = null;               // { reason, filename, at } — model went away
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
  // A drop onto a completely idle queue starts a fresh run — reset the bar.
  if (_active.size === 0 && _queue.length === 0) {
    _done = 0;
    _failed = 0;
    _total = 0;
    _durations.length = 0;
    _known.clear();               // nothing is queued or running — no stale keys
  }
  const added = !_known.has(item.filepath);
  if (added) {
    _known.add(item.filepath);
    _queue.push(item);
    _total++;
  }
  _probeOnWake(wasActive);
  _pump();
  // No findIndex here: it made enqueue O(n²) over a bulk add, which is how a
  // 20k-file retry blocked the event loop for seconds. The queue is FIFO, so an
  // item just pushed sits at the back — good enough for the "you are Nth" hint.
  return { position: _active.size + _queue.length, added };
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
  return _active.size > 0 || (_queue.length > 0 && !isPaused());
}

/** Any reason dispatch is stopped. */
function isPaused() {
  return vault.isLocked() || _userPaused || _halt !== null;
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
  if (_halt) return _halt.needsModelChoice ? 'model-choice' : 'model';
  if (_userPaused) return 'user';
  return null;
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
  _queue.unshift(item);
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
    text: `${which} was unloaded in LM Studio. Continuing on ${left} cop${left === 1 ? 'y' : 'ies'}.`,
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
    return aiSlots.activeFamilies().length > 0;
  } catch { return false; }
}

function _haltOnModel(item, reason, { needsModelChoice = false } = {}) {
  const strikes = (_haltCounts.get(item.filepath) || 0) + 1;
  let requeued = true;
  if (strikes >= MAX_HALT_RETRIES) {
    requeued = false;
    _haltCounts.delete(item.filepath);
    _failed++;
    console.warn(`[Import] ${item.filename} halted the scan ${strikes}×, blaming the file and moving on`);
    try {
      database.get().prepare('UPDATE media SET processing_error = ? WHERE id = ?')
        .run(`Repeatedly interrupted the scan: ${String(reason).slice(0, 240)}`, item.id);
    } catch {}
  } else {
    _haltCounts.set(item.filepath, strikes);
    _queue.unshift(item);
  }
  if (!_halt) {
    _halt = {
      reason: String(reason || 'Model unavailable').slice(0, 300),
      filename: item?.filename || null,
      at: Date.now(),
      needsModelChoice: !!needsModelChoice,
    };
    console.warn(`[Import] ⏸ scan halted: ${_halt.reason}${item ? ` (at ${item.filename})` : ''}`);
  }
  return requeued;      // false = the item left the queue, so drop its _known key
}

/** User pause — in-flight files finish, nothing new starts. */
function pause() {
  _userPaused = true;
  return status();
}

/** Clear the user pause AND any model halt, then dispatch again. */
function resume() {
  const wasActive = isActive();
  _userPaused = false;
  _halt = null;
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
  const dropped = _queue.length;
  for (const q of _queue) _known.delete(q.filepath);   // active items stay known
  _queue.length = 0;
  _total = Math.max(_done + _failed + _active.size, _total - dropped);
  _userPaused = false;
  _halt = null;
  _notice = null;
  _haltCounts.clear();
  if (dropped) console.log(`[Import] scan cancelled: ${dropped} queued file(s) dropped`);
  return { dropped, active: _active.size };
}

/** Where scans are going right now: a family, one pinned copy, or nowhere. */
function _target() {
  try {
    const llm = require('./llm-client');
    const t = llm.resolveTarget();
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
aiSlots.onChange(() => { _derive(); });

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
  const remaining = _total - _done - _failed;
  const paused = isPaused();
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
      };
    }),
    pending: _queue.map(q => ({ id: q.id, filename: q.filename })),
    paused,
    pausedBy: pausedBy(),
    halt: _halt,
    // Something worth saying that did NOT stop the run (8.5). The panel prints
    // it under the instance strip; null means there is nothing to say.
    notice: notice(),
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
  while (_running < _concurrency && _queue.length > 0 && !isPaused()) {
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
  while (_queue.length > 0) {
    if (isPaused()) break;                    // vault lock / user pause / model halt
    if (_running > _concurrency) break;       // limit was lowered — retire
    const item = _queue.shift();
    const startedAt = Date.now();
    _active.set(item.id, { id: item.id, filename: item.filename, filepath: item.filepath, startedAt });
    let counted = true;
    let requeued = false;         // true = still in _queue, so keep its _known key
    try {
      const { processFile } = require('../commands/scan');
      require('./frame-extractor').ensureTempDir();
      // Carry the media id through the whole scan in async context. Every AI
      // call underneath, however deep, can then say which file it is for
      // without processFile and every processor growing a parameter that only
      // exists to draw a label. See lib/ai-slots.js fileContext.
      const result = await aiSlots.fileContext.run({ mediaId: item.id }, () => processFile(
        { path: item.filepath, name: item.filename, mediaType: item.mediaType },
        { reprocess: true, retryErrors: true }
      ));
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
      if (result?.error) {
        _failed++;
        console.warn(`[Import] scan failed for ${item.filename}: ${result.error}`);
      } else {
        _haltCounts.delete(item.filepath);      // it scanned — strikes reset
        _done++;
        try { require('./embeddings').invalidateCache(); } catch {}
        console.log(`[Import] scanned ${item.filename}`);
      }
    } catch (err) {
      if (vault.isLocked()) {
        // Lock interrupted the scan mid-file — retry this one after unlock
        _queue.unshift(item);
        counted = false;
        requeued = true;
        console.log(`[Import] scan of ${item.filename} interrupted by Vault lock, requeued`);
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
        _failed++;
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
    }
  }
}

vault.onChange((event) => { if (event === 'unlocked') _pump(); });

module.exports = {
  enqueue, isActive, status, setConcurrency, getConcurrency,
  setWorkersPerInstance, getWorkersPerInstance, activeSlots,
  pause, resume, cancel, isPaused, pausedBy, isQueued, notice,
  // Test seams. The halt matrix and the notice are decided deep inside a
  // worker loop that would otherwise need a database, a scan and a real model
  // to reach, and they are exactly the rules worth pinning down.
  _needsModelChoice, _retryOnSurvivingInstance,
};
