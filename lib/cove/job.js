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
 * States: idle | running | done | error | stopped. A stop (the Stop button, or
 * the vault locking) is checked between steps and items; what was already
 * sent stays sent, and since the export is additive and idempotent the next
 * run picks up where this one left off. The summary and report so far are
 * kept, so a stopped run still has a report to save.
 */

const { runExport, checkCoveUrl, timestamp } = require('./export');
const { CoveClient } = require('./client');
const M = require('./mapping');

/** How many "not found" paths the status carries for the UI (the report has all of them). */
const NOT_FOUND_CAP = 200;
/** How many item problems the status carries for the UI. */
const PROBLEM_CAP = 50;

const LOCKED_MSG = 'Vault locked during the move. Unlock and run it again; it picks up where it left off.';
const STOPPED_MSG = 'Stopped. What was already sent stays in Cove. Running it again picks up where it left off.';

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
  };
}

let job = idleJob();
let controller = null;
let seq = 0;

function isRunning() { return job.state === 'running'; }

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
  if (isRunning()) throw fail('A preview or move is already running.', 'JOB_BUSY');
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
  p.then(({ summary, report }) => {
    mine.state = 'done';
    mine.summary = summary;
    mine.report = report;
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

/** Ask a running job to stop. `reason` 'locked' ends it with the vault-locked message. */
function stop(reason) {
  if (!isRunning() || !controller) return false;
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
  const out = { ...rest, elapsedMs: job.startedAt ? (job.finishedAt || Date.now()) - job.startedAt : 0 };
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
  start, stop, status, lastReport, isRunning, reset, checkConnection, timestamp,
  UI_MESSAGES, LOCKED_MSG, STOPPED_MSG, NOT_FOUND_CAP,
};
