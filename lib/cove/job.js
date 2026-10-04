/**
 * The Settings tab's "Move to Cove" job: one at a time, held in memory.
 *
 * A preview (dry run) or a move (apply) runs lib/cove/export.js runExport in
 * the background against the library handle the caller passes in (the
 * server's live one). The engine only reads it, all of it up front, so the
 * job never writes to the Vault library.
 *
 * The Cove token is passed straight through to the engine's client. It is not
 * kept in the job state, the status, or the report.
 *
 * Modes: preview | move | scan. A scan ("get your files into Cove") adds
 * library folders to Cove when asked, starts a Cove scan of just those
 * folders and follows Cove's own job; the caller chains a preview onto a
 * scan that completed (onFinish).
 *
 * States: idle | running | done | error | stopped. A stop (the Stop button, or
 * the vault locking) is checked between steps and items; what was already
 * sent stays sent, and since the export is additive and idempotent the next
 * run picks up where this one left off. The summary and report so far are
 * kept, so a stopped run still has a report to save.
 */

const { runExport, checkCoveUrl, timestamp } = require('./export');
const { CoveClient } = require('./client');
const M = require('./mapping');
const F = require('./folders');

/** How many "not found" paths the status carries for the UI (the report has all of them). */
const NOT_FOUND_CAP = 200;
/** How many item problems the status carries for the UI. */
const PROBLEM_CAP = 50;

const LOCKED_MSG = 'Vault locked during the move. Unlock and run it again; it picks up where it left off.';
const STOPPED_MSG = 'Stopped. What was already sent stays in Cove. Running it again picks up where it left off.';
const SCAN_STOPPED_MSG = 'Scan stopped. Cove keeps the files it found so far.';
const SCAN_LOCKED_MSG = 'Vault locked during the scan. Cove carries on scanning by itself; unlock Vault and press Preview when Cove is done.';
/** How often Cove's scan job is asked for its progress (tests shorten it). */
let SCAN_POLL_MS = 1000;
function _setScanPollMs(ms) { SCAN_POLL_MS = ms; }
/** How long a scan may wait in Cove's queue before Vault gives up waiting (tests shorten it). */
let SCAN_PENDING_LIMIT_MS = 10 * 60 * 1000;
function _setScanPendingLimitMs(ms) { SCAN_PENDING_LIMIT_MS = ms; }
const SCAN_LOST_MSG = 'Cove lost track of the scan. Run it again.';
const SCAN_PENDING_MSG = 'Cove has not started the scan after 10 minutes, so Vault stopped waiting. Cove may be busy with other tasks: check its Tasks page, then run the scan again.';
const SCAN_CANT_STOP_MSG = 'Couldn\'t stop the scan in Cove; it keeps running there.';

/** The Settings tab's wording for the engine's user-facing messages (no flags, no env vars). */
const UI_MESSAGES = {
  badUrl: () => 'Enter Cove\'s address, for example http://127.0.0.1:5073',
  netOff: (origin) => `Network is off (VAULT_OFFLINE=1) and ${origin} is not on this computer. Use Cove's local address.`,
  tokenRejected: () => 'Cove did not accept the API token. Create a new token in Cove (Settings, Security & access, API tokens) and paste it again.',
  noToken: () => 'Cove has login turned on. Open "Cove has login turned on" and paste an API token from Cove (Settings, Security & access, API tokens).',
  mapUnused: (h) => `The Vault folder "${h.from}" matches no file in this library. Check the folder on the left.`,
};

function fail(message, code) {
  return Object.assign(new Error(message), { code });
}

function idleJob() {
  return {
    state: 'idle', mode: null, jobId: null, phase: null, done: 0, total: 0,
    startedAt: null, finishedAt: null, inputs: null, summary: null, report: null, error: null,
    scan: null, notFoundDetail: null,
  };
}

let job = idleJob();
// The last scan, kept after the preview it led to so the page can say what was scanned.
let lastScan = null;
let controller = null;
let seq = 0;

// A slot held by a route that is still preparing a job (POST /scan reads Vault
// and Cove before it starts): everything else sees "busy" meanwhile.
let reservation = null;

function isRunning() { return job.state === 'running' || reservation !== null; }

/**
 * Hold the one job slot while a job is being prepared. Returns a token for
 * startScan, or null when busy. release() gives the slot back if the job is
 * not started after all (safe to call twice). The token's `signal` aborts
 * when stop() is called during preparation, so a Cove that stops answering
 * can always be let go of.
 */
function reserve() {
  if (isRunning()) return null;
  const ac = new AbortController();
  const r = {
    signal: ac.signal,
    abort(reason) { ac.abort(reason); r.release(); },
    release() { if (reservation === r) reservation = null; },
  };
  reservation = r;
  return r;
}

/**
 * Start a preview or a move. Throws JOB_BUSY when one is running.
 * @param {object} o
 * @param {'preview'|'move'} o.mode
 * @param {object} o.db           open library handle (only read)
 * @param {boolean} [o.encrypted]
 * @param {string} o.coveUrl
 * @param {string|null} [o.token]
 * @param {string[]} [o.maps]     "VaultFolder=CoveFolder"
 * @param {Function} [o.onFinish] called with the finished job state
 * @param {number} [o.retryBaseMs]
 * @returns {object} the job status
 */
function start(o) {
  if (isRunning()) throw fail('A scan, preview or move is already running.', 'JOB_BUSY');
  const mode = o.mode === 'move' ? 'move' : 'preview';
  controller = new AbortController();
  const signal = controller.signal;
  job = {
    ...idleJob(), state: 'running', mode, jobId: `cove-${++seq}-${Date.now()}`, phase: 'reading Cove',
    startedAt: Date.now(), inputs: { url: o.coveUrl, maps: [...(o.maps || [])], hasToken: !!o.token },
  };
  const mine = job;
  const p = runExport({
    db: o.db, encrypted: !!o.encrypted, coveUrl: o.coveUrl, token: o.token || null, maps: o.maps || [],
    apply: mode === 'move', resume: false, messages: UI_MESSAGES, signal, retryBaseMs: o.retryBaseMs,
    onProgress: ({ phase, done, total }) => { mine.phase = phase; mine.done = done; mine.total = total; },
  });
  p.then(async ({ summary, report }) => {
    mine.summary = summary;
    mine.report = report;
    mine.notFoundDetail = await notFoundDetail(report, o);
    mine.state = 'done';
  }, (err) => {
    if (err && err.partial) { mine.summary = err.partial.summary; mine.report = err.partial.report; }
    if (err && err.code === 'VAULT_LOCKED') { mine.state = 'stopped'; mine.error = LOCKED_MSG; return; }
    if (err && err.code === 'STOPPED') { mine.state = 'stopped'; mine.error = STOPPED_MSG; return; }
    mine.state = 'error';
    mine.error = (err && err.message) || String(err);
  }).finally(() => {
    mine.finishedAt = Date.now();
    mine.phase = null;
    if (controller && controller.signal === signal) controller = null;
    if (o.onFinish) { try { o.onFinish(mine); } catch {} }
  });
  return status();
}

/** A client for this Cove address. */
function clientFor({ coveUrl, token, readOnly, retryBaseMs, signal }) {
  const base = checkCoveUrl(coveUrl, UI_MESSAGES);
  return new CoveClient({ baseUrl: base.origin + base.pathname.replace(/\/+$/, ''), token: token || null, readOnly, retryBaseMs, signal });
}

/**
 * The first NOT_FOUND_CAP not-found items with a reason: gone from disk, a
 * type Cove does not scan (Cove's own extension lists), or not picked up yet.
 */
async function notFoundDetail(report, o) {
  const list = (report.unmatched || []).slice(0, NOT_FOUND_CAP);
  if (!list.length) return [];
  let cfg = null;
  try { cfg = await clientFor({ ...o, readOnly: true }).getConfig(); } catch { /* Cove's defaults */ }
  const exts = F.extensionSet(cfg);
  return list.map(u => ({ path: u.path, reason: F.notFoundReason(u.path, exts) }));
}

/** The Cove scan options: covers only (images: their thumbnails), or every generator. */
function scanOptions(paths, generate) {
  if (generate === 'all') return { paths, scanGenerators: true };
  return {
    paths, scanGenerators: false, scanGenerateCovers: true, scanGenerateThumbnails: true,
    scanGeneratePreviews: false, scanGenerateSprites: false, scanGenerateVrStereo: false, scanGeneratePhashes: false,
    scanGenerateMd5: false, scanGenerateImagePhashes: false, scanGenerateAudioPhashes: false, scanGenerateTextPhashes: false,
    rescan: false,
  };
}

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const t = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/**
 * Add folders to Cove's library (when asked) and scan the given folders.
 * Ends 'done' when Cove's scan completed; onFinish then decides what follows.
 * @param {object} o
 * @param {string} o.coveUrl
 * @param {string|null} [o.token]
 * @param {string[]} o.addPaths   Cove-side folders to add to Cove's library first
 * @param {string[]} o.scanPaths  Cove-side folders to scan (inside Cove's roots once added)
 * @param {'covers'|'all'} [o.generate]
 * @param {Function} [o.onFinish]
 * @param {number} [o.pollMs]
 * @param {object} [o.reservation]  the slot from reserve(), consumed here
 * @param {boolean} [o.canStop]     the token may cancel Cove jobs (jobs.cancel)
 * @param {Function} [o.stillValid] checked right before each Cove write; false ends the job unsent
 */
function startScan(o) {
  if (job.state === 'running' || (reservation && reservation !== o.reservation)) {
    throw fail('A scan, preview or move is already running.', 'JOB_BUSY');
  }
  // A reservation stopped during preparation has already let go of the slot.
  if (o.reservation && o.reservation.signal && o.reservation.signal.aborted) {
    throw fail('Stopped before the scan started. Nothing was sent to Cove.', 'STOPPED');
  }
  reservation = null;
  controller = new AbortController();
  const signal = controller.signal;
  const generate = o.generate === 'all' ? 'all' : 'covers';
  const addPaths = o.addPaths || [];
  job = {
    ...idleJob(), state: 'running', mode: 'scan', jobId: `cove-${++seq}-${Date.now()}`,
    phase: addPaths.length ? 'adding folders' : 'starting scan', startedAt: Date.now(),
    inputs: { url: o.coveUrl, hasToken: !!o.token },
    scan: { generate, added: [], paths: [...o.scanPaths], coveJobId: null, coveStatus: null, progress: 0, etaSeconds: null,
      state: 'running', finishedAt: null, canStop: o.canStop !== false },
  };
  const mine = job;
  lastScan = mine.scan;
  const checkValid = () => {
    if (o.stillValid && !o.stillValid()) {
      throw fail('The Cove settings changed before the scan started, so nothing was sent. Check the settings and run it again.', 'SETTINGS_CHANGED');
    }
  };
  const run = async () => {
    // Reads and the scan request follow Stop and a vault lock; cancelling
    // Cove's job after a Stop needs a client that isn't already aborted.
    const client = clientFor({ ...o, readOnly: false, signal });
    const cancelClient = clientFor({ ...o, readOnly: false });
    const goOn = () => { if (signal.aborted) throw signal.reason; checkValid(); };
    if (addPaths.length) {
      goOn();
      mine.scan.added = await F.addRoots(client, addPaths, { beforeWrite: goOn });
    }
    mine.phase = 'starting scan';
    goOn();
    // Not cut off halfway either: if Stop comes meanwhile, the loop below cancels the scan it started.
    const started = await client.startScan(scanOptions(o.scanPaths, generate), { signal: null });
    const coveJobId = started && started.jobId;
    if (!coveJobId) throw fail('Cove did not start a scan.', 'SCAN_FAILED');
    mine.scan.coveJobId = coveJobId;
    mine.phase = 'scanning';
    let misses = 0;
    let pendingSince = Date.now();
    for (;;) {
      await sleep(o.pollMs || SCAN_POLL_MS, signal);
      if (signal.aborted) {
        // The Stop button stops Cove's scan too; a vault lock leaves Cove to finish on its own.
        if (signal.reason && signal.reason.code === 'STOPPED') {
          try {
            await cancelClient.cancelJob(coveJobId);
          } catch {
            throw fail(SCAN_CANT_STOP_MSG, 'SCAN_NOT_STOPPED');
          }
        }
        throw signal.reason;
      }
      let j;
      try {
        j = await client.getJob(coveJobId);
      } catch (e) {
        // Gone from Cove's list: it can't be told apart from a crash, so it is not "completed".
        if (e.status === 404) throw fail(SCAN_LOST_MSG, 'SCAN_LOST');
        if (++misses >= 30) throw e;
        continue;
      }
      misses = 0;
      const st = String(j.status || '').toLowerCase();
      Object.assign(mine.scan, { coveStatus: st, progress: Number(j.progress) || 0, etaSeconds: j.etaSeconds ?? null });
      mine.total = Number(j.unitsTotal) || 0;
      mine.done = Number(j.unitsCompleted) || 0;
      if (st !== 'pending') pendingSince = Date.now();
      else if (Date.now() - pendingSince > SCAN_PENDING_LIMIT_MS) throw fail(SCAN_PENDING_MSG, 'SCAN_PENDING');
      if (st === 'completed') return;
      if (st === 'failed') throw fail(`Cove's scan failed${j.error ? `: ${j.error}` : '.'}`, 'SCAN_FAILED');
      if (st === 'cancelled') throw fail('The scan was stopped in Cove. Start it again here when you are ready.', 'SCAN_CANCELLED');
    }
  };
  run().then(() => {
    mine.state = 'done';
  }, (err) => {
    if (err && err.code === 'VAULT_LOCKED') { mine.state = 'stopped'; mine.error = SCAN_LOCKED_MSG; return; }
    if (err && err.code === 'STOPPED') { mine.state = 'stopped'; mine.error = SCAN_STOPPED_MSG; return; }
    mine.state = 'error';
    mine.error = (err && err.message) || String(err);
  }).finally(() => {
    mine.finishedAt = Date.now();
    mine.scan.finishedAt = mine.finishedAt;
    mine.scan.state = mine.state;
    mine.phase = null;
    if (controller && controller.signal === signal) controller = null;
    if (o.onFinish) { try { o.onFinish(mine); } catch {} }
  });
  return status();
}

/** Ask a running job to stop. `reason` 'locked' ends it with the vault-locked message. */
function stop(reason) {
  // Still preparing (POST /scan reading Vault and Cove): let go of the slot.
  if (reservation && job.state !== 'running') {
    reservation.abort(reason === 'locked' ? fail(LOCKED_MSG, 'VAULT_LOCKED') : fail(STOPPED_MSG, 'STOPPED'));
    return true;
  }
  if (job.state !== 'running' || !controller) return false;
  // A scan this token can't cancel in Cove keeps being followed, so the preview still comes after it.
  if (reason !== 'locked' && job.mode === 'scan' && job.scan && !job.scan.canStop) return false;
  controller.abort(reason === 'locked'
    ? fail(LOCKED_MSG, 'VAULT_LOCKED')
    : fail(STOPPED_MSG, 'STOPPED'));
  return true;
}

/** The report of the last job that has one, or null. */
function lastReport() {
  if (!job.report) return null;
  return { report: job.report, at: new Date(job.finishedAt || job.startedAt) };
}

/** The job as the UI sees it: no report body, the not-found list capped. */
function status() {
  const { report, ...rest } = job;
  // `starting`: a scan is being prepared (Vault and Cove are being read), so
  // other actions answer "busy" even though no job is running yet.
  const out = { ...rest, starting: reservation !== null && job.state !== 'running', lastScan, elapsedMs:job.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : 0 };
  if (report) {
    out.notFound = report.unmatched.slice(0, NOT_FOUND_CAP).map(u => u.path);
    out.notFoundTotal = report.unmatched.length;
    out.problems = report.errors.slice(0, PROBLEM_CAP).map(e => ({
      path: e.path || e.group || e.tag || e.field || null, step: e.step || null, message: e.message,
    }));
    out.warnings = report.warnings || [];
    out.skippedFieldWrites = (report.skippedFieldWrites || []).length;
    out.missingPermissionsForApply = report.missingPermissionsForApply || [];
    out.coveVersion = report.cove && report.cove.version;
    if (report.plannedGroups) out.plannedGroups = report.plannedGroups.length;
  }
  return out;
}

/** Back to idle (tests). Refused while running. */
function reset() {
  if (isRunning()) return false;
  job = idleJob();
  lastScan = null;
  return true;
}

/**
 * The "Check connection" step: can Vault reach Cove, is the token (if any)
 * accepted, may it read what the export needs, and how much does Cove hold.
 * Only GETs (the client is read-only).
 * @returns {Promise<{ ok: true, version, counts: {videos, images, audios}, authEnabled }>}
 */
async function checkConnection({ coveUrl, token, retryBaseMs = 250 }) {
  const base = checkCoveUrl(coveUrl, UI_MESSAGES);
  const client = new CoveClient({ baseUrl: base.origin + base.pathname.replace(/\/+$/, ''), token: token || null,
    readOnly: true, retryBaseMs });
  let me;
  try {
    me = await client.me();
  } catch (e) {
    if (e.status === 401 && token) throw Object.assign(fail(UI_MESSAGES.tokenRejected(), 'TOKEN_REJECTED'), { authEnabled: true });
    if (e.status === 401) throw Object.assign(fail(UI_MESSAGES.noToken(), 'NO_TOKEN'), { authEnabled: true });
    if (e.code === 'NET_OFF') throw e;
    if (!e.status) {
      throw fail(`Could not reach Cove at ${base.origin}. Is Cove running? The address is in Cove's window title.`, 'UNREACHABLE');
    }
    throw fail(`Cove answered with an error (${e.status}). Is ${base.origin} really Cove?`, 'COVE_ERROR');
  }
  const perms = (me && me.permissions) || [];
  const need = ['files.read', 'system.read', 'tags.read', 'groups.read', 'videos.read', 'images.read', 'audios.read'];
  const missing = need.filter(p => !M.hasPermission(perms, p));
  if (missing.length) {
    throw fail(`${token ? 'The Cove token' : 'Cove'} is missing permissions this needs: ${missing.join(', ')}. ` +
      'Create a token that can read videos, images, audio, files, tags, groups and system settings.', 'NO_PERMISSION');
  }
  let st = null;
  try { st = await client.status(); } catch { /* version stays unknown */ }
  const count = async (kind) => {
    try {
      const r = await client.get(`/api/${kind}s`, { page: 1, perPage: 1 });
      return r && Number.isFinite(r.totalCount) && r.totalCount >= 0 ? r.totalCount : null;
    } catch { return null; }
  };
  const [videos, images, audios] = [await count('video'), await count('image'), await count('audio')];
  const authEnabled = st && typeof st.authEnabled === 'boolean' ? st.authEnabled : (token ? null : false);
  return { ok: true, version: (st && st.version) || null, counts: { videos, images, audios }, authEnabled };
}

module.exports = {
  _setScanPollMs, _setScanPendingLimitMs, reserve, start, startScan, stop, status, lastReport, isRunning, reset, checkConnection, clientFor, scanOptions, timestamp,
  UI_MESSAGES, LOCKED_MSG, STOPPED_MSG, SCAN_STOPPED_MSG, SCAN_LOCKED_MSG, SCAN_LOST_MSG, SCAN_PENDING_MSG, SCAN_CANT_STOP_MSG, NOT_FOUND_CAP,
};
