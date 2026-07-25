/**
 * Import scan queue — a small worker pool for AI scans of newly-referenced files.
 *
 * Files added via the native pickers (referenced in place, never copied) are
 * playable immediately (insertStubs row with the 'unscanned' marker); this
 * queue backfills the AI metadata in the background, exactly like a CLI scan
 * would. It never touches files a separate CLI scan owns — items enter only
 * via /api/import/add-paths.
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
 * all again. A failed scan (e.g. LM Studio offline) records the error on the
 * row (still playable; --retry-errors or a rescan picks it up later).
 *
 * Progress: _total counts everything accepted into the current run, and the
 * last 50 per-file durations feed a rolling average, so status() can offer a
 * real done/total bar with an ETA. A fresh drag-drop onto a fully idle queue
 * starts a new run (counters reset); dropping more while a run is still in
 * flight accumulates into it instead of restarting the bar.
 */

const database = require('./database');
const vault = require('./vault');

const MIN_WORKERS = 1;
const MAX_WORKERS = 8;
const DURATION_SAMPLES = 50;

const _queue = [];              // [{ id, filepath, filename, mediaType }]
const _active = new Map();      // id -> { id, filename, startedAt }
const _durations = [];          // ms per completed file (success or failure)
let _running = 0;               // live workers
let _concurrency = _clamp(parseInt(process.env.IMPORT_WORKERS, 10), 2);
let _done = 0;
let _failed = 0;
let _total = 0;

function _clamp(n, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, Math.trunc(n)));
}

function enqueue(item) {
  // A drop onto a completely idle queue starts a fresh run — reset the bar.
  if (_active.size === 0 && _queue.length === 0) {
    _done = 0;
    _failed = 0;
    _total = 0;
    _durations.length = 0;
  }
  const known = _queue.some(q => q.filepath === item.filepath)
    || [..._active.values()].some(a => a.filepath === item.filepath);
  if (!known) {
    _queue.push(item);
    _total++;
  }
  _pump();
  const i = _queue.findIndex(q => q.filepath === item.filepath);
  return _active.size + (i === -1 ? _queue.length : i + 1);
}

/** True while anything is scanning or waiting — the vault's scan probe. */
function isActive() {
  return _active.size > 0 || _queue.length > 0;
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
  let etaMs = null;
  if (avgMs !== null && remaining > 0) {
    const lanes = Math.max(1, Math.min(_concurrency, remaining || 1));
    etaMs = Math.round(remaining * avgMs / lanes);
  }
  return {
    active: [..._active.values()].map(a => ({ id: a.id, filename: a.filename, startedAt: a.startedAt })),
    pending: _queue.map(q => ({ id: q.id, filename: q.filename })),
    paused: vault.isLocked(),
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
  while (_running < _concurrency && _queue.length > 0 && !vault.isLocked()) {
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
    if (vault.isLocked()) break;              // resumes via the unlock hook below
    if (_running > _concurrency) break;       // limit was lowered — retire
    const item = _queue.shift();
    const startedAt = Date.now();
    _active.set(item.id, { id: item.id, filename: item.filename, filepath: item.filepath, startedAt });
    let counted = true;
    try {
      const { processFile } = require('../commands/scan');
      require('./frame-extractor').ensureTempDir();
      const result = await processFile(
        { path: item.filepath, name: item.filename, mediaType: item.mediaType },
        { reprocess: true, retryErrors: true }
      );
      if (result?.error) {
        _failed++;
        console.warn(`[Import] scan failed for ${item.filename}: ${result.error}`);
      } else {
        _done++;
        try { require('./embeddings').invalidateCache(); } catch {}
        console.log(`[Import] scanned ${item.filename}`);
      }
    } catch (err) {
      if (vault.isLocked()) {
        // Lock interrupted the scan mid-file — retry this one after unlock
        _queue.unshift(item);
        counted = false;
        console.log(`[Import] scan of ${item.filename} interrupted by Vault lock — requeued`);
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
      if (counted) {
        _durations.push(Date.now() - startedAt);
        if (_durations.length > DURATION_SAMPLES) _durations.shift();
      }
    }
  }
}

vault.onChange((event) => { if (event === 'unlocked') _pump(); });

module.exports = { enqueue, isActive, status, setConcurrency, getConcurrency };
