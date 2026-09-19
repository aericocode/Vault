/**
 * Loading and unloading extra copies of a model through LM Studio's `lms` CLI.
 *
 * The Backend tab can already SEE every copy of a model that is loaded, and
 * spread scans over all of them. Actually loading a second copy still meant
 * alt-tabbing to LM Studio, finding the model, and remembering to set the
 * identifier to `<model>:2` so Vault groups it into the same family. That is a
 * lot of ceremony for the one action the whole tab exists to encourage, so this
 * module drives the CLI that LM Studio ships for exactly this purpose.
 *
 * Deliberately narrow:
 *
 * - Only for an endpoint on THIS PC. `lms` talks to the LM Studio it was
 *   installed by, so running it for a server on another machine would load a
 *   copy on the wrong box and report success.
 * - Only copies are unloaded, never the original. Unloading the base instance
 *   from a panel labelled "load another copy" is a foot-gun, and the base is
 *   what every other family member is grouped against.
 * - Settings are COPIED from the source instance (`lms ps --json`), never
 *   invented. GPU offload ratio is not in that output, so it is left out and LM
 *   Studio places the copy itself.
 *
 * Nothing here blocks a request. A clone starts, the route answers 202, and the
 * job is polled in the background until the copy shows up in `lms ps` or the
 * 120 s cap runs out. The registry finds the copy on its own refresh; the job
 * list exists only so the table can say "Loading :2" in the meantime.
 *
 * Every spawn passes an argument ARRAY. Model keys and identifiers contain
 * slashes, colons and dots, and building a shell string out of them is how a
 * model name turns into a command.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PS_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 120_000;   // the cap from the spec; a cold model is slow
const POLL_MS = 2_000;             // how often a loading job re-checks `lms ps`
const FAILED_TTL_MS = 60_000;      // how long a failed job stays on screen

/** Shown whenever the CLI is missing, in the UI as-is. */
const NO_LMS = 'The lms command was not found. In LM Studio open the Developer tab and '
  + 'install the lms CLI, or run: npx lmstudio install-cli';

/* ── Gating ─────────────────────────────────────────────────────────────── */

/**
 * Is this endpoint the LM Studio running on this PC?
 *
 * Host only. A different port is still the same machine (people run two LM
 * Studios), and a LAN address is another machine even when it happens to be
 * this one's own IP, because `lms` cannot be aimed at a remote instance.
 */
function isLocalEndpoint(url) {
  let host;
  try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch { return false; }
  // URL() strips the brackets from an IPv6 literal, but be forgiving anyway.
  host = host.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Where `lms` lives: on PATH first, then LM Studio's own bin directory.
 *
 * PATH first because that is the copy the user chose to install, and it is the
 * one that stays correct if LM Studio is moved. The bin fallback covers the
 * common case of LM Studio installed but "install the CLI" never pressed, where
 * the executable is there and simply not on PATH.
 *
 * Split out from findLms() with its inputs injected so the lookup ORDER can be
 * tested on a machine that has neither.
 */
function _findLmsIn({ env = process.env, platform = process.platform, exists } = {}) {
  const win = platform === 'win32';
  const seen = exists || (p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  // .exe first, whatever order PATHEXT lists it in. Node's spawn cannot start a
  // .cmd or .bat on its own (see spawnSpec), so when a directory holds both,
  // the real executable is always the better find.
  const rank = e => (/\.exe$/i.test(e) ? 0 : /\.com$/i.test(e) ? 1 : 2);
  const exts = win
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).sort((a, b) => rank(a) - rank(b))
    : [''];
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `lms${ext}`);
      if (seen(candidate)) return candidate;
    }
  }
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (!home) return null;
  const fallback = win
    ? path.join(home, '.lmstudio', 'bin', 'lms.exe')
    : path.join(home, '.lmstudio', 'bin', 'lms');
  return seen(fallback) ? fallback : null;
}

let _lmsPath;                     // undefined = not looked for yet, null = absent

/** The cached path to `lms`, or null. */
function findLms() {
  if (_lmsPath === undefined) _lmsPath = _findLmsIn();
  return _lmsPath;
}

/** Test seam: forget the cached lookup (and let a test pin a fake path). */
function _setLmsPath(p) { _lmsPath = p; }

/* ── Running the CLI ────────────────────────────────────────────────────── */

/**
 * What to hand spawn() for `<lmsPath> <args>`.
 *
 * A .cmd or .bat is a script, not an executable: Node refuses to start one
 * without a shell and answers `spawn EINVAL`. npm's own `lms` shim on Windows
 * is exactly that, and it is what an `npx lmstudio install-cli` can leave on
 * PATH, so the case is real even though _findLmsIn prefers a .exe.
 *
 * The interpreter is named explicitly and the pieces stay an ARRAY, so this is
 * still not `shell: true` and still not a command line built out of a model
 * name full of slashes and colons.
 *
 * @returns {{ command: string, argv: string[] }}
 */
function spawnSpec(lmsPath, args) {
  if (/\.(cmd|bat)$/i.test(String(lmsPath || ''))) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    return { command: comspec, argv: ['/c', lmsPath, ...args] };
  }
  return { command: lmsPath, argv: [...args] };
}

/**
 * Run `lms <args>` and resolve `{ code, stdout, stderr }`. Never rejects on a
 * non-zero exit: a failed unload is a message for the user, not an exception.
 */
function _run(args, { timeoutMs = PS_TIMEOUT_MS } = {}) {
  const lms = findLms();
  if (!lms) return Promise.resolve({ code: -1, stdout: '', stderr: NO_LMS });
  return new Promise(resolve => {
    let child;
    try {
      // windowsHide keeps a console window from flashing up on every poll.
      const { command, argv } = spawnSpec(lms, args);
      child = spawn(command, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, stdout: '', stderr: err.message || 'could not start lms' });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ code: -1, stdout, stderr: stderr || 'lms did not answer in time' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => done({ code: -1, stdout, stderr: err.message || 'could not start lms' }));
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

/**
 * The rows `lms ps --json` reports: one per loaded instance, carrying the
 * settings a copy has to match (modelKey, contextLength, parallel, ttlMs).
 *
 * The CLI prints a banner line before the JSON on some versions, so the array
 * is cut out rather than handed straight to JSON.parse.
 */
async function psRows() {
  const { stdout } = await _run(['ps', '--json']);
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const rows = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

/** The ps row for one instance id, or null. */
function findPsRow(rows, id) {
  return (rows || []).find(r => r && (r.identifier === id || r.modelKey === id)) || null;
}

/** Every identifier LM Studio currently reports. */
function psIdentifiers(rows) {
  return (rows || []).map(r => r && (r.identifier || r.modelKey)).filter(Boolean);
}

/* ── Identifier and argument building ───────────────────────────────────── */

/**
 * The identifier for the next copy of `family`: the lowest free integer from 2
 * up. Gaps are reused, so unloading `:2` and loading again gives `:2` back
 * rather than creeping to `:4` over an afternoon of experimenting.
 */
function nextIdentifier(family, takenIds = []) {
  const used = new Set();
  for (const id of takenIds) {
    if (id === family) continue;
    const m = new RegExp(`^${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)$`).exec(String(id));
    if (m) used.add(Number(m[1]));
  }
  let n = 2;
  while (used.has(n)) n++;
  return `${family}:${n}`;
}

/**
 * `lms load` arguments for a copy of the instance described by `row`.
 *
 * Only settings that `lms ps --json` actually reports are passed. A missing or
 * nonsense context length or parallel value is left off entirely so LM Studio
 * applies the model's own default, which is a better guess than zero.
 */
function loadArgs(row, identifier) {
  const args = ['load', String(row?.modelKey || row?.identifier || ''), '--identifier', identifier];
  const ctx = Number(row?.contextLength);
  if (Number.isFinite(ctx) && ctx > 0) args.push('-c', String(Math.round(ctx)));
  const parallel = Number(row?.parallel);
  if (Number.isFinite(parallel) && parallel > 0) args.push('--parallel', String(Math.round(parallel)));
  const ttlMs = Number(row?.ttlMs);
  // ttlMs is null for "keep loaded", and --ttl takes seconds.
  if (Number.isFinite(ttlMs) && ttlMs > 0) args.push('--ttl', String(Math.max(1, Math.round(ttlMs / 1000))));
  args.push('-y');                 // the CLI otherwise asks about the GPU split
  return args;
}

/* ── Jobs ───────────────────────────────────────────────────────────────── */

/** family -> { family, identifier, startedAt, state, error, _child } */
const _jobs = new Map();

/** The job list for GET /api/ai/instances, oldest first, expired ones dropped. */
function jobs() {
  const now = Date.now();
  for (const [family, job] of [..._jobs]) {
    if (job.state === 'failed' && now - (job.failedAt || job.startedAt) >= FAILED_TTL_MS) {
      _jobs.delete(family);
    }
  }
  return [..._jobs.values()].map(j => ({
    family: j.family,
    identifier: j.identifier,
    startedAt: j.startedAt,
    state: j.state,
    error: j.error || null,
  }));
}

function activeJob(family) {
  const job = _jobs.get(family);
  return job && job.state === 'loading' ? job : null;
}

/** Identifiers already claimed by a job, so two clones never pick the same one. */
function pendingIdentifiers() {
  return [..._jobs.values()].filter(j => j.state === 'loading').map(j => j.identifier);
}

function _finish(job, error) {
  if (job.state !== 'loading') return;
  if (error) {
    job.state = 'failed';
    job.error = error;
    job.failedAt = Date.now();
  } else {
    // A finished load needs no row: the copy itself is about to appear in the
    // table, and leaving "Loading :2" beside it would read as a second one.
    _jobs.delete(job.family);
  }
  clearInterval(job._poll);
  job._poll = null;
  try { require('./ai-slots').refresh({ force: true }).catch(() => {}); } catch {}
}

/**
 * Start loading another copy of `family`, modelled on `row`.
 * Returns the job immediately; the load runs on past the response.
 */
function startClone({ family, row, identifier }) {
  const job = {
    family,
    identifier,
    startedAt: Date.now(),
    state: 'loading',
    error: null,
    failedAt: null,
    _poll: null,
  };
  _jobs.set(family, job);

  const lms = findLms();
  let child;
  try {
    const { command, argv } = spawnSpec(lms, loadArgs(row, identifier));
    child = spawn(command, argv, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    _finish(job, err.message || 'could not start lms');
    return job;
  }
  let stderr = '';
  child.stderr.on('data', d => { stderr += d; });
  child.on('error', err => _finish(job, err.message || 'could not start lms'));
  child.on('close', code => {
    // The CLI exiting is not the same as the copy being usable, so a clean exit
    // does not end the job: the poll below decides that when it sees the
    // identifier. A dirty exit is conclusive, though.
    if (code !== 0 && job.state === 'loading') {
      _finish(job, _firstLine(stderr) || `lms load exited with code ${code}`);
    }
  });

  job._poll = setInterval(async () => {
    if (job.state !== 'loading') { clearInterval(job._poll); return; }
    if (Date.now() - job.startedAt >= LOAD_TIMEOUT_MS) {
      try { child.kill(); } catch {}
      _finish(job, 'Loading took longer than 120 seconds and was given up on.');
      return;
    }
    const rows = await psRows();
    if (psIdentifiers(rows).includes(identifier)) _finish(job, null);
  }, POLL_MS);
  if (typeof job._poll.unref === 'function') job._poll.unref();
  return job;
}

/** Unload one copy. Resolves `{ ok, error }`; the caller has done the guarding. */
async function unloadInstance(identifier) {
  const { code, stderr } = await _run(['unload', identifier], { timeoutMs: 30_000 });
  if (code === 0) {
    try { require('./ai-slots').refresh({ force: true }).catch(() => {}); } catch {}
    return { ok: true, error: null };
  }
  return { ok: false, error: _firstLine(stderr) || 'lms could not unload that copy' };
}

/** CLI errors are chatty and often coloured; one line is what a toast can hold. */
function _firstLine(text) {
  const line = String(text || '')
    .replace(/\[[0-9;]*m/g, '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean)[0];
  return line ? line.slice(0, 200) : '';
}

/** Test seam. */
function _reset() {
  for (const job of _jobs.values()) clearInterval(job._poll);
  _jobs.clear();
}

module.exports = {
  isLocalEndpoint, findLms, spawnSpec, psRows, findPsRow, psIdentifiers,
  nextIdentifier, loadArgs, jobs, activeJob, pendingIdentifiers,
  startClone, unloadInstance,
  NO_LMS, LOAD_TIMEOUT_MS, FAILED_TTL_MS,
  _findLmsIn, _setLmsPath, _reset,
};
