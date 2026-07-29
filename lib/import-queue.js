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

const MIN_WORKERS = 1;
const MAX_WORKERS = 8;
const DURATION_SAMPLES = 50;
const MAX_HALT_RETRIES = 3;     // strikes before a file is blamed instead of the model

const _queue = [];              // [{ id, filepath, filename, mediaType }]
const _active = new Map();      // id -> { id, filename, startedAt }
const _durations = [];          // ms per completed file (success or failure)
const _haltCounts = new Map();  // filepath -> consecutive halts blamed on the model
const _known = new Set();       // filepaths queued or in flight — O(1) dedupe
let _running = 0;               // live workers
let _concurrency = _clamp(parseInt(process.env.IMPORT_WORKERS, 10), 2);
let _done = 0;
let _failed = 0;
let _total = 0;
let _userPaused = false;        // the panel's ⏸ button
let _halt = null;               // { reason, filename, at } — model went away

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
  _pump();
  // No findIndex here: it made enqueue O(n²) over a bulk add, which is how a
  // 20k-file retry blocked the event loop for seconds. The queue is FIFO, so an
  // item just pushed sits at the back — good enough for the "you are Nth" hint.
  return { position: _active.size + _queue.length, added };
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
function _haltOnModel(item, reason, { needsModelChoice = false } = {}) {
  const strikes = (_haltCounts.get(item.filepath) || 0) + 1;
  let requeued = true;
  if (strikes >= MAX_HALT_RETRIES) {
    requeued = false;
    _haltCounts.delete(item.filepath);
    _failed++;
    console.warn(`[Import] ${item.filename} halted the scan ${strikes}× — blaming the file and moving on`);
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
    console.warn(`[Import] ⏸ scan halted — ${_halt.reason}${item ? ` (at ${item.filename})` : ''}`);
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
  _userPaused = false;
  _halt = null;
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
  _haltCounts.clear();
  if (dropped) console.log(`[Import] scan cancelled — ${dropped} queued file(s) dropped`);
  return { dropped, active: _active.size };
}

function getConcurrency() {
  return _concurrency;
}

/** Change the worker count at runtime; takes effect without a restart. */
function setConcurrency(n) {
  _concurrency = _clamp(typeof n === 'number' ? n : parseInt(n, 10), _concurrency);
  _pump();                       // raising it starts the extra workers now
  return _concurrency;           // lowering it is honoured as workers finish
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
  return {
    active: [..._active.values()].map(a => ({ id: a.id, filename: a.filename, startedAt: a.startedAt })),
    pending: _queue.map(q => ({ id: q.id, filename: q.filename })),
    paused,
    pausedBy: pausedBy(),
    halt: _halt,
    done: _done,
    failed: _failed,
    total: _total,
    concurrency: _concurrency,
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
      const result = await processFile(
        { path: item.filepath, name: item.filename, mediaType: item.mediaType },
        { reprocess: true, retryErrors: true }
      );
      if (result?.modelUnavailable) {
        // Not this file's fault (usually) — stop the run rather than marching
        // the rest of the queue into the same dead endpoint. _haltOnModel owns
        // the requeue, including the poison-pill cap.
        counted = false;
        requeued = _haltOnModel(item, result.error, { needsModelChoice: !!result.needsModelChoice });
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
        console.log(`[Import] scan of ${item.filename} interrupted by Vault lock — requeued`);
      } else if (modelHealth.isModelUnavailable(err)) {
        // Threw rather than returning — same deal, same cap.
        counted = false;
        requeued = _haltOnModel(item, err.modelReason || modelHealth.describe(err),
          { needsModelChoice: modelHealth.isModelChoiceNeeded(err) });
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
  pause, resume, cancel, isPaused, pausedBy, isQueued,
};
