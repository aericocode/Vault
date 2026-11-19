/**
 * Share privately: the jobs (spec 6.4) and everything the routes call.
 *
 * FLOW, and where data could leave the computer:
 *   preview()        local: sizes, names, free space.
 *   start()          local: packs into share_temp, then runs the checks
 *                    (lib/share/pack.js). Ends 'checked' or 'failed'.
 *   confirmUpload()  THE ONLY WAY AN UPLOAD STARTS. Needs confirm === true,
 *                    status 'checked' with every check passed, the parts on
 *                    disk unchanged since the checks, the feature on and
 *                    VAULT_OFFLINE off. Nothing before this point touches the
 *                    network: the gofile client is only called from
 *                    _runUpload() (reached from confirmUpload, resume and
 *                    retryPart, which need an upload the user already
 *                    confirmed) and from the delete / timer actions.
 *
 * WITH THE FEATURE OFF (spec section 1, promise 4) nothing is uploaded, no
 * account is made and no timer is set; the only requests left are deletes of
 * uploads Vault already made: Delete, Delete all and Stop and delete. They
 * delete only the folder id stored on a share row, with that row's stored
 * account token, never anything a request sent. VAULT_OFFLINE still blocks
 * them. The gofile client enforces the same split on its side.
 *
 * UPLOAD JOB: one share at a time, others wait in line. The first part goes
 * alone (it makes the gofile folder), then two at a time; the first "too many
 * requests" answer drops it to one for the rest of that upload. A failed part
 * is retried as the "If a part fails" setting says, then waits for the user;
 * other parts go on. Every change is written to the database at once.
 *
 * AFTER A RESTART nothing resumes by itself: an upload that was running is
 * 'not_finished' (Resume, or Stop and delete). Shares that never reached
 * step 3 (packing, checked) are thrown away with their files.
 *
 * LOCKING THE LIBRARY pauses the upload (every request in flight is aborted)
 * and cancels a packing job. Unlocking does not resume; the page offers it.
 * Turning the feature off pauses the same way.
 *
 * ONE SHARE, ONE STATE MACHINE. Every action that changes a share or starts
 * work on it (confirmUpload, cancel, remove, stop, resume, retryPart, pause,
 * deleteRemote, markGone, retryTimer) runs in that share's queue (_serial):
 * one at a time, in the order they came, each reading the row again first.
 * An action that has to wait on I/O writes its new status BEFORE the first
 * await: cancel and remove write 'removing' (the share is then "not found"
 * for every other action and for the page), stop writes 'stopping'. A
 * restart, or an unlock after a lock cut one short, finishes them
 * (_settleOrphans).
 * The upload worker is not in the queue (stop and pause wait for it). It
 * belongs to one generation of its job (job.gen): pause, stop, cancel, the
 * lock, the feature switch and a new start each end the generation and abort
 * its requests and waits. Before every request and every write the worker
 * checks that its generation is still current, the library is unlocked, the
 * row is still 'uploading' and (for uploads and the timer) the feature is on;
 * a worker that is no longer current stops without sending or writing.
 * One write is never skipped: a part gofile accepted is recorded (folder id,
 * file id) whatever happened meanwhile, so an upload that won a race with
 * Stop is still on record and Stop deletes it. If the library is locked at
 * that moment, the write waits for the unlock (_record).
 * The lock handler and the feature-off handler are synchronous: they cannot
 * interleave with anything, re-read the row and only move 'uploading' rows.
 *
 * SECRETS: the share password and gofile tokens never go into a log line, an
 * error message or a response, except the password through the two gated
 * routes (revealPassword, copyBlock) and the saved password through its own
 * gated routes. When "Passwords of past shares" is off the share password is
 * kept in memory only, until Vault stops.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const database = require('../database');
const vault = require('../vault');
const store = require('./store');
const settings = require('./settings');
const names = require('./names');
const temp = require('./temp');
const pack = require('./pack');
const sevenzip = require('./sevenzip');
const gate = require('./gate');
const { GofileClient, netOffMessage } = require('./gofile');

const SESSION = crypto.randomBytes(12).toString('hex');   // "this Vault start"
const MAX_FILES = 5000;
const RATE_DELAYS_MS = [5000, 10000, 20000, 40000, 60000, 60000];
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const DAY_MS = 24 * 60 * 60 * 1000;

const MAY_BE_ONLINE = ['uploaded', 'not_finished', 'paused', 'failed', 'uploading'];
const LOCK_REASON = 'Paused because the library was locked.';
const OFF_REASON = 'Paused because Share privately was turned off.';
const STOP_UNFINISHED = 'Stop and delete did not finish, so the uploaded parts may still be on gofile. Use Delete.';

let _client = new GofileClient();
/** Wait ms; an aborted signal ends the wait at once. */
const _defaultSleep = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) { resolve(); return; }
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
let _sleep = _defaultSleep;
let _now = () => Date.now();
let _program = null;     // tests may pin the 7-Zip program

const _jobs = new Map(); // shareId -> in-memory job state
const _queue = [];       // shareIds waiting to upload
let _active = null;      // shareId uploading now
let _recovered = false;
const _locks = new Map(); // shareId -> tail of that share's action queue
const _pending = [];     // records that found the library locked; written on unlock
let _orphans = false;    // a 'removing' / 'stopping' row may have lost its action

function _err(code, message, extra) {
  return Object.assign(new Error(message), { code }, extra || {});
}

/** Database writes from background work: skipped while locked, never thrown. */
function _w(fn) {
  if (vault.isLocked()) return undefined;
  try { return fn(); } catch (err) {
    console.warn(`[Share] could not save share state (${err && err.code ? err.code : 'error'})`);
    return undefined;
  }
}

/**
 * A record that must not be lost (an account gofile made, a part gofile
 * accepted). Written now, or, while the library is locked (the database may
 * already be closed), kept in memory and written right after the unlock.
 * Returns true when it was written now.
 */
function _record(fn) {
  if (vault.isLocked()) { _pending.push(fn); return false; }
  try { fn(); return true; } catch (err) {
    console.warn(`[Share] could not save share state (${err && err.code ? err.code : 'error'})`);
    return false;
  }
}

function _flushPending() {
  if (vault.isLocked()) return;
  for (const fn of _pending.splice(0)) {
    try { fn(); } catch (err) { console.warn(`[Share] could not save share state (${err && err.code ? err.code : 'error'})`); }
  }
}

function _job(id) {
  let j = _jobs.get(id);
  if (!j) {
    j = { id, phase: null, percent: 0, handle: null, packing: null, password: null,
      controllers: new Set(), concurrency: 2, running: null, gen: 0, ac: new AbortController(),
      finishing: false, bytes: new Map(), queued: false };
    _jobs.set(id, j);
  }
  return j;
}

/**
 * Run fn as the next action of one share: after every action on it that came
 * before has ended (resolved or thrown). An id that is not a share id runs at
 * once (fn throws NOT_FOUND).
 */
function _serial(id, fn) {
  const key = Number(id);
  if (!Number.isInteger(key) || key < 1) return Promise.resolve().then(fn);
  const prev = _locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => {}, () => {});
  _locks.set(key, tail);
  tail.then(() => { if (_locks.get(key) === tail) _locks.delete(key); });
  return run;
}

/** Abort what the job has in flight (requests, retry waits). */
function _wake(job) {
  try { job.ac.abort(); } catch {}
  for (const c of job.controllers) { try { c.abort(); } catch {} }
}

/** End the job's current generation: its worker stops at its next check. */
function _invalidate(job) {
  job.gen += 1;
  const qi = _queue.indexOf(job.id);
  if (qi >= 0) _queue.splice(qi, 1);
  job.queued = false;
  _wake(job);
}

/** Wait for the job's worker to have stopped. */
async function _settle(job) {
  while (job && job.running) { try { await job.running; } catch {} }
}

function _lockedErr() {
  return _err('VAULT_LOCKED', 'The library was locked, so Vault stopped. Unlock it and look at this share again.');
}

/**
 * Message for an error that is not one of ours (an unexpected one): never
 * its own text, which could quote a path or a request detail.
 */
const PLAIN_CODES = new Set(['WRONG_STATE', 'NOT_FOUND', 'NO_ACCOUNT', 'NET_OFF', 'FEATURE_OFF', 'RATE_LIMIT',
  'NETWORK', 'GOFILE_ERROR', 'BAD_ANSWER', 'SHARE_HOST', 'VAULT_LOCKED']);
function _plain(err) {
  if (err && PLAIN_CODES.has(err.code)) return { code: err.code, error: err.message };
  if (err) console.warn(`[Share] unexpected error (${err.name || 'error'})`);
  return { code: 'ERROR', error: 'Something went wrong.' };
}

/* ── Restart recovery ───────────────────────────────────────────────────── */

/**
 * Once per process, the first time the database is used: uploads that were
 * running become 'not_finished'; shares that never reached the upload are
 * removed with their files.
 */
function ensureRecovered() {
  if (vault.isLocked()) return;
  if (_pending.length) _flushPending();
  if (!_recovered) {
    _recovered = true;
    _orphans = true;
    for (const row of store.sharesWithStatus(['packing', 'checked'])) {
      if (_jobs.has(row.id)) continue;
      temp.removeWorkDir(row.work_dir).catch(() => {});
      store.deleteShare(row.id);
    }
    for (const row of store.sharesWithStatus(['uploading', 'paused'])) {
      if (_jobs.has(row.id)) continue;
      store.updateShare(row.id, { status: 'not_finished' });
      for (const p of store.getParts(row.id)) {
        if (p.status === 'uploading') store.updatePart(row.id, p.part_no, { status: 'waiting' });
      }
    }
  }
  if (_orphans) _orphans = _settleOrphans() > 0;
}

/**
 * Finish a cancel / remove / stop that a restart or a lock cut short: its
 * row is still 'removing' or 'stopping' and no action of that share is
 * running. 'removing' is removed (what the user asked for); 'stopping' ends
 * 'failed' with Delete offered when something may be on gofile, else
 * 'cancelled'. Returns how many rows were left because their action is
 * still running (checked again later).
 */
function _settleOrphans() {
  let left = 0;
  for (const row of store.sharesWithStatus(['removing', 'stopping'])) {
    if (_locks.has(row.id)) { left++; continue; }
    const wd = row.work_dir;
    if (row.status === 'removing') {
      store.deleteShare(row.id);
    } else if (row.folder_id) {
      store.updateShare(row.id, { status: 'failed', work_dir: null, last_error: STOP_UNFINISHED });
    } else {
      store.updateShare(row.id, { status: 'cancelled', work_dir: null, deleted_at: _now(), last_error: null });
    }
    _jobs.delete(row.id);
    temp.removeWorkDir(wd).catch(() => {});
  }
  return left;
}

/* ── What the page sees ─────────────────────────────────────────────────── */

function _displayStatus(row) {
  if (row.status === 'uploaded' && row.delete_after && row.delete_after <= _now()) return 'expired';
  return row.status;
}

/** The first file on disk: "<name>.7z", or "<name>.7z.001" when split. */
function _archiveFileName(row) {
  return row.part_count > 1 ? `${row.archive_name}.7z.001` : `${row.archive_name}.7z`;
}

/** The archive as people name it, without a part number: "<name>.7z". */
function _archiveDisplayName(row) {
  return `${row.archive_name}.7z`;
}

/** A share as the page may see it: no password, no token, no folder id. */
function publicShare(row) {
  const job = _jobs.get(row.id);
  const status = _displayStatus(row);
  return {
    id: row.id,
    archiveName: row.archive_name,
    archiveFileName: _archiveFileName(row),
    archiveDisplayName: _archiveDisplayName(row),
    nameTyped: !!row.name_typed,
    link: row.link || null,
    code: row.code || null,
    status,
    sizeBytes: row.size,
    partCount: row.part_count,
    partSize: row.part_size,
    fileCount: row.file_count,
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at || null,
    deleteAfterDays: row.delete_after_days,
    deleteAt: row.delete_after || null,
    timerSet: !!row.timer_set,
    deletedAt: row.deleted_at || null,
    error: row.last_error || null,
    passwordKind: row.password_kind,
    passwordKept: row.password != null || !!(job && job.password),
    accountThisSession: !!(row.account_id && (store.getAccount(row.account_id) || {}).session === SESSION),
    onGofile: !!row.folder_id && (MAY_BE_ONLINE.includes(row.status) || row.status === 'stopping'),
    canResume: ['paused', 'not_finished'].includes(row.status) && !(job && (job.running || job.queued)),
  };
}

function _row(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw _err('NOT_FOUND', 'That share was not found.');
  const row = store.getShare(n);
  // A share being removed is gone for every action and for the page.
  if (!row || row.status === 'removing') throw _err('NOT_FOUND', 'That share was not found.');
  return row;
}

/** Every share row except those being removed. */
function _listed() {
  return store.listShares().filter(r => r.status !== 'removing');
}

function listShares() {
  ensureRecovered();
  return _listed().map(publicShare);
}

function getShare(id) {
  ensureRecovered();
  const row = _row(id);
  const files = store.getFiles(row.id).map(f => ({ name: f.file_name, sizeBytes: f.size, mediaId: f.media_id }));
  let checks = null;
  try { checks = row.checks ? JSON.parse(row.checks) : null; } catch { checks = null; }
  return { ...publicShare(row), files, filesKept: files.length > 0, checks, parts: _partsView(row) };
}

function _partsView(row) {
  const job = _jobs.get(row.id);
  return store.getParts(row.id).map(p => {
    const done = p.status === 'done' ? p.size : Math.min(p.size, (job && job.bytes.get(p.part_no)) || 0);
    return {
      partNo: p.part_no, fileName: p.file_name, sizeBytes: p.size, status: p.status,
      percent: p.size ? Math.floor((done / p.size) * 100) : (p.status === 'done' ? 100 : 0),
      tries: p.tries, error: p.error || null,
    };
  });
}

function progress(id) {
  ensureRecovered();
  const row = _row(id);
  const job = _jobs.get(row.id);
  const parts = _partsView(row);
  const total = parts.reduce((n, p) => n + p.sizeBytes, 0);
  const done = parts.reduce((n, p) => n + Math.floor(p.sizeBytes * p.percent / 100), 0);
  let checks = null;
  try { checks = row.checks ? JSON.parse(row.checks) : null; } catch { checks = null; }
  return {
    id: row.id,
    status: _displayStatus(row),
    error: row.last_error || null,
    packing: row.status === 'packing' ? { phase: (job && job.phase) || 'staging', percent: (job && job.percent) || 0 } : null,
    checks,
    upload: parts.length && !['packing', 'checked'].includes(row.status) ? {
      bytesDone: done, bytesTotal: total, percent: total ? Math.floor((done / total) * 100) : 0,
      partsAtOnce: job ? job.concurrency : null,
      waitingInLine: !!(job && job.queued),
      parts,
    } : null,
    link: row.link || null,
  };
}

function savedPasswordStatus() {
  ensureRecovered();
  return {
    set: !!store.kvGet('saved_password'),
    vaultPasswordSet: gate.required(),
    warningNeeded: !gate.required() && store.kvGet('warning_shown') !== '1',
  };
}

function state() {
  ensureRecovered();
  const s = settings.get();
  const rows = _listed();
  const busy =rows.filter(r => ['packing', 'uploading', 'paused', 'not_finished'].includes(r.status));
  let failedParts = 0;
  for (const r of rows) {
    if (['uploading', 'paused', 'not_finished'].includes(r.status)) {
      failedParts += store.getParts(r.id).filter(p => p.status === 'failed').length;
    }
  }
  const first = busy[0] || null;
  return {
    enabled: s.enabled,
    offline: !!(config.net && config.net.offline),
    sevenZipFound: !!(_program || sevenzip.locate()),
    settings: s,
    savedPassword: savedPasswordStatus(),
    shareCount: rows.length,
    topBar: {
      show: s.topBarIcon && (busy.length > 0 || failedParts > 0),
      needsYou: failedParts,
      shareId: first ? first.id : null,
      archiveName: first ? first.archive_name : null,
      status: first ? _displayStatus(first) : null,
      percent: first ? progressPercent(first) : null,
    },
  };
}

function progressPercent(row) {
  const job = _jobs.get(row.id);
  if (row.status === 'packing') return job ? job.percent : 0;
  const parts = _partsView(row);
  const total = parts.reduce((n, p) => n + p.sizeBytes, 0);
  return total ? Math.floor(parts.reduce((n, p) => n + p.sizeBytes * p.percent / 100, 0) / total * 100) : 0;
}

/* ── Step 1: preview and start ──────────────────────────────────────────── */

function _mediaFiles(mediaIds) {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) throw _err('BAD_INPUT', 'Pick at least one file.');
  if (mediaIds.length > MAX_FILES) throw _err('BAD_INPUT', `A share can hold at most ${MAX_FILES} files.`);
  const ids = [...new Set(mediaIds)];
  if (!ids.every(n => Number.isInteger(n) && n > 0)) throw _err('BAD_INPUT', 'The file list is not valid.');
  const db = database.get();
  const out = [];
  const stmt = db.prepare('SELECT id, filepath FROM media WHERE id = ?');
  for (const id of ids) {
    const r = stmt.get(id);
    if (!r) throw _err('MEDIA_NOT_FOUND', 'A picked file is no longer in the library.');
    let st;
    try { st = fs.statSync(r.filepath); } catch { st = null; }
    if (!st || !st.isFile()) throw _err('FILE_MISSING', 'A picked file could not be found on disk.', { mediaId: id });
    out.push({ mediaId: id, filepath: r.filepath, size: st.size });
  }
  return out;
}

function preview({ mediaIds }) {
  ensureRecovered();
  const s = settings.get();
  const files = _mediaFiles(mediaIds);
  const p = pack.plan(files, { partBytes: settings.partBytes(s) });
  const free = temp.freeBytes();
  return {
    files: p.entries.map((e, i) => ({ mediaId: e.mediaId, name: path.basename(files[i].filepath), nameInArchive: e.archiveName, sizeBytes: e.size })),
    totalBytes: p.totalBytes,
    needBytes: p.needBytes,
    freeBytes: free,
    enoughSpace: free === null ? null : free >= p.needBytes,
    missingBytes: free === null ? null : Math.max(0, p.needBytes - free),
    split: p.split,
    partBytes: p.partBytes,
    partCount: p.parts,
    nameMode: s.nameMode,
    passwordChoice: s.passwordChoice,
    deleteAfterDays: s.deleteAfterDays,
    savedPasswordSet: !!store.kvGet('saved_password'),
    sevenZipFound: !!(_program || sevenzip.locate()),
  };
}

function _requireOn() {
  if (!settings.isEnabled()) throw _err('FEATURE_OFF', 'Share privately is turned off. Turn it on in Settings first.');
}

/** VAULT_OFFLINE blocks the action: 'upload', 'delete' or 'timer' (for the message). */
function _requireOnline(action) {
  if (config.net && config.net.offline) throw _err('NET_OFF', netOffMessage(action));
}

/**
 * Step 1 -> packing. Returns the new share; packing and the checks run on.
 * @param {{mediaIds:number[], name?:string, passwordChoice?:'random'|'saved', deleteAfterDays?:number}} o
 */
function start({ mediaIds, name, passwordChoice, deleteAfterDays }) {
  ensureRecovered();
  _requireOn();
  if (!(_program || sevenzip.locate())) throw _err('SEVENZIP_MISSING', 'Vault could not find its 7-Zip program, so it cannot pack files.');
  if ([..._jobs.values()].some(j => j.packing)) throw _err('PACK_BUSY', 'Another share is being packed. Wait for it to finish.');
  const s = settings.get();
  const files = _mediaFiles(mediaIds);
  const partBytes = settings.partBytes(s);
  const p = pack.plan(files, { partBytes });
  const free = temp.freeBytes();
  if (free !== null && free < p.needBytes) {
    throw _err('NO_SPACE', 'There is not enough free space to pack these files.', { missingBytes: p.needBytes - free, needBytes: p.needBytes });
  }

  let archiveName = '';
  let typed = false;
  if (s.nameMode === 'typed' && typeof name === 'string' && name.trim()) {
    archiveName = names.cleanTypedName(name);
    typed = !!archiveName;
  }
  if (!archiveName) archiveName = names.randomArchiveName();

  const choice = passwordChoice === undefined ? s.passwordChoice : passwordChoice;
  if (!['random', 'saved'].includes(choice)) throw _err('BAD_INPUT', 'Pick how the password is made.');
  let password;
  if (choice === 'saved') {
    password = store.kvGet('saved_password');
    if (!password) throw _err('NO_SAVED_PASSWORD', 'There is no saved password yet. Set one in Settings, or use a new random password.');
  } else {
    password = names.randomPassword();
  }
  const days = deleteAfterDays === undefined ? s.deleteAfterDays : deleteAfterDays;
  if (![1, 7, 30, 0].includes(days)) throw _err('BAD_INPUT', 'Pick when the upload is deleted.');

  const wd = temp.createWorkDir();
  const id = store.insertShare({
    archive_name: archiveName, name_typed: typed ? 1 : 0,
    password: s.rememberPasswords ? password : null, password_kind: choice,
    size: p.totalBytes, part_count: p.parts, part_size: p.partBytes, file_count: files.length,
    status: 'packing', created_at: _now(), delete_after_days: days, work_dir: wd.name,
    keep_local: s.keepLocal ? 1 : 0,
  });
  if (s.rememberFiles) {
    store.setFiles(id, p.entries.map(e => ({ fileName: e.archiveName, size: e.size, mediaId: e.mediaId })));
  }
  const job = _job(id);
  job.password = password;
  job.phase = 'staging';
  job.percent = 0;
  job.handle = { cancelled: false, kill: null };
  job.packing = _runPack(id, { plan: p, workDir: wd.dir, archiveName, password })
    .finally(() => { job.packing = null; });
  return publicShare(store.getShare(id));
}

async function _runPack(id, { plan, workDir, archiveName, password }) {
  const job = _job(id);
  const fail = async (message) => {
    await temp.removeWorkDir(path.basename(workDir));
    _w(() => store.updateShare(id, { status: 'failed', last_error: message, work_dir: null }));
    _w(() => store.setParts(id, []));
  };
  try {
    const parts = await pack.pack({
      entries: plan.entries, workDir, archiveName, password,
      partBytes: plan.partBytes, split: plan.split, handle: job.handle, program: _program || undefined,
      onProgress: ({ phase, percent }) => { job.phase = phase; job.percent = percent; },
    });
    if (job.handle.cancelled) return;
    _w(() => store.updateShare(id, { part_count: parts.length, size: parts.reduce((n, q) => n + q.size, 0) }));
    _w(() => store.setParts(id, parts));
    job.phase = 'checking';
    job.percent = 0;
    const checks = await pack.runChecks({
      workDir, archiveName, password, expected: plan.entries, parts, split: plan.split,
      handle: job.handle, program: _program || undefined,
    });
    if (job.handle.cancelled) return;
    const record = { ...checks, archiveName: { value: archiveName, typed: !!(store.getShare(id) || {}).name_typed } };
    _w(() => store.updateShare(id, { checks: JSON.stringify(record) }));
    if (!checks.ok) {
      const message = !checks.listWithoutPassword.ok
        ? 'The archive could be read without the password, so it was deleted. Nothing was uploaded.'
        : !checks.test.ok ? 'The archive did not pass its test, so it was deleted. Nothing was uploaded.'
          : !checks.contents.ok ? 'The archive does not hold exactly the picked files, so it was deleted. Nothing was uploaded.'
            : 'The packed parts on disk do not match, so they were deleted. Nothing was uploaded.';
      await fail(message);
      return;
    }
    _w(() => store.updateShare(id, { status: 'checked' }));
    job.phase = 'checked';
    job.percent = 100;
  } catch (err) {
    if (job.handle && job.handle.cancelled) return;
    const plain = {
      PACK_FAILED: err.message, BAD_NAME: err.message, BAD_PASSWORD: err.message,
      SEVENZIP_MISSING: 'Vault could not find its 7-Zip program, so it cannot pack files.',
      PARTS_MISMATCH: 'The packed parts are not complete.',
    }[err.code] || 'Packing failed. Nothing was uploaded.';
    await fail(plain);
  }
}

/**
 * Cancel and delete the archive: before anything was uploaded. The share is
 * removed from the list (nothing of it left the computer).
 */
function cancel(id) {
  return _serial(id, async () => {
    ensureRecovered();
    const row = _row(id);
    const job = _jobs.get(row.id);
    if (row.folder_id || (job && job.running)
      || ['uploading', 'paused', 'not_finished', 'uploaded', 'deleted', 'gone', 'cancelled', 'stopping'].includes(row.status)) {
      throw _err('WRONG_STATE', 'Parts of this share were already uploaded. Use Stop and delete instead.');
    }
    // Durable before the first await: from here Upload and every other action
    // find no share, and a restart finishes the removal.
    store.updateShare(row.id, { status: 'removing' });
    if (job) {
      _invalidate(job);
      if (job.handle) {
        job.handle.cancelled = true;
        if (job.handle.kill) job.handle.kill();
      }
    }
    if (job && job.packing) { try { await job.packing; } catch {} }
    await temp.removeWorkDir(row.work_dir);
    if (vault.isLocked()) throw _lockedErr();   // the unlock finishes it (_settleOrphans)
    store.deleteShare(row.id);
    _jobs.delete(row.id);
    return { removed: true };
  });
}

/* ── Step 3: confirm, and the upload job ────────────────────────────────── */

function _checksPassed(row) {
  try { return JSON.parse(row.checks || 'null')?.ok === true; } catch { return false; }
}

/** Async: runs in the share's queue (see the top of this file). */
function confirmUpload(id, { confirm } = {}) {
  return _serial(id, () => {
    ensureRecovered();
    if (confirm !== true) throw _err('CONFIRM_NEEDED', 'Tick the box to confirm the upload first.');
    _requireOn();
    _requireOnline('upload');
    const row = _row(id);
    if (row.status !== 'checked' || !_checksPassed(row)) {
      throw _err('NOT_CHECKED', 'This share has not passed its checks, so it cannot be uploaded.');
    }
    const dir = temp.workDirPath(row.work_dir);
    const parts = store.getParts(row.id);
    if (!dir || !parts.length || !pack.partsUnchanged(dir, parts.map(p => ({ fileName: p.file_name, size: p.size, mtimeMs: p.mtime_ms })))) {
      temp.removeWorkDir(row.work_dir).catch(() => {});
      store.updateShare(row.id, { status: 'failed', last_error: 'The packed parts changed after the checks, so they were deleted. Nothing was uploaded.', work_dir: null });
      throw _err('PARTS_CHANGED', 'The packed parts changed after the checks, so they were deleted. Nothing was uploaded.');
    }
    store.updateShare(row.id, { status: 'uploading', last_error: null });
    _enqueue(row.id);
    return progress(row.id);
  });
}

/**
 * Start a new generation of the share's upload. A worker of an older
 * generation that is still winding down is no longer current; the new one
 * waits in line behind it (one share at a time).
 */
function _enqueue(id) {
  const job = _job(id);
  _invalidate(job);
  job.ac = new AbortController();
  job.concurrency = 2;
  job.queued = true;
  _queue.push(id);
  _pump();
}

function _pump() {
  if (_active !== null || _queue.length === 0) return;
  const id = _queue.shift();
  const job = _job(id);
  job.queued = false;
  _active = id;
  const run = _runUpload(id, job.gen)
    .catch(() => {})
    .finally(() => {
      if (job.running === run) job.running = null;
      if (_active === id) _active = null;
      _pump();
    });
  job.running = run;
}

/**
 * The account for this share. A new guest account is asked for with the
 * generation's abort signal (a lock or a stop cancels the request); one that
 * gofile made anyway is always recorded, after the unlock if need be.
 */
function _pickAccount(row, signal) {
  if (row.account_id) {
    const acc = store.getAccount(row.account_id);
    if (acc) return Promise.resolve(acc);
  }
  const mode = settings.get().accountMode;
  let acc = null;
  if (mode === 'perStart') acc = store.latestAccount(SESSION);
  else if (mode === 'keep') acc = store.latestAccount();
  if (acc) return Promise.resolve(acc);
  return _client.createAccount({ signal }).then(({ token }) => {
    let accId = null;
    if (!_record(() => { accId = store.insertAccount(token, SESSION); })) throw _err('STALE', 'Stopped.');
    return store.getAccount(accId);
  });
}

const PART_FAIL_MESSAGES = {
  NETWORK: 'Could not reach gofile.',
  GOFILE_ERROR: 'gofile refused this part.',
  BAD_ANSWER: 'gofile sent an answer Vault did not understand.',
  UPLOAD_MISMATCH: 'gofile received a different file than Vault sent.',
  RATE_LIMIT: 'gofile kept saying too many requests.',
  NOT_FOUND: 'gofile says the folder is gone.',
};
// Errors that stop the whole upload rather than one part.
const STOP_ALL = new Set(['FEATURE_OFF', 'NET_OFF', 'SHARE_HOST', 'PART_CHANGED', 'ABORTED']);

/**
 * Is the worker of generation `gen` still the one that may act on share id?
 * null when it is; 'stale' when its generation ended, the library is locked,
 * or the row is gone or no longer `status`; 'off' when it is current but the
 * feature is off (only when needOn). Never reads the database while locked.
 */
function _why(id, gen, { needOn = true, status = 'uploading' } = {}) {
  const job = _jobs.get(id);
  if (!job || job.gen !== gen) return 'stale';
  if (vault.isLocked()) return 'stale';
  let row = null;
  try { row = store.getShare(id); } catch { return 'stale'; }
  if (!row || row.status !== status) return 'stale';
  if (needOn && !settings.isEnabled()) return 'off';
  return null;
}

async function _runUpload(id, gen) {
  const job = _job(id);
  const signal = job.ac.signal;   // this generation's: aborted when it ends
  /** Throws when this worker may not go on: STALE (stop, write nothing) or FEATURE_OFF. */
  const guard = (opts) => {
    const why = _why(id, gen, opts);
    if (why === 'stale') throw _err('STALE', 'Stopped.');
    if (why === 'off') throw _err('FEATURE_OFF', 'Share privately is turned off.');
  };
  try {
    guard();
  } catch (err) {
    if (err.code === 'FEATURE_OFF') _w(() => store.updateShare(id, { status: 'paused', last_error: OFF_REASON }));
    return;
  }
  let row = store.getShare(id);
  const dir = temp.workDirPath(row.work_dir);
  /** The worker's own ending. Only while it is still current. */
  const pausedNow = (message) => {
    if (_why(id, gen, { needOn: false })) return;
    _w(() => {
      store.updateShare(id, { status: 'paused', last_error: message || null });
      for (const p of store.getParts(id)) if (p.status === 'uploading') store.updatePart(id, p.part_no, { status: 'waiting' });
    });
  };
  const stopAll = (err) => {
    if (err.code === 'STALE' || _why(id, gen, { needOn: false })) return;   // whoever ended it owns the row
    if (err.code === 'PART_CHANGED') {
      _w(() => store.updateShare(id, { status: 'failed', last_error: 'A packed part changed after the checks. Vault stopped sending. Delete the uploaded parts from My shares.' }));
      return;
    }
    if (err.code === 'FEATURE_OFF' || !settings.isEnabled()) { pausedNow(OFF_REASON); return; }
    if (err.code === 'ABORTED') { pausedNow(null); return; }
    pausedNow(err.message);
  };

  let account;
  try {
    account = await _pickAccount(row, signal);
    guard();
  } catch (err) {
    if (err.code === 'STALE' || STOP_ALL.has(err.code)) { stopAll(err); return; }
    pausedNow(err.code === 'RATE_LIMIT' ? 'gofile says too many requests. Try again in a while.' : 'Could not get a gofile guest account. Try again later.');
    return;
  }
  if (!row.account_id) { _w(() => store.updateShare(id, { account_id: account.id })); row = store.getShare(id) || row; }

  const pending = store.getParts(id).filter(p => p.status !== 'done');
  const retries = settings.get().onPartFail === 'retry3' ? RETRY_DELAYS_MS.length : 0;

  // Every send attempt, retries included, takes a slot; there are
  // job.concurrency slots (2, then 1 after a rate limit answer).
  const slots = { used: 0, waiters: [] };
  const acquire = async () => {
    while (slots.used >= job.concurrency) await new Promise(r => slots.waiters.push(r));
    slots.used++;
  };
  const release = () => {
    slots.used--;
    for (const w of slots.waiters.splice(0)) w();
  };

  let fatal = null;
  const halted = () => !!fatal;

  /** One part, with its retries. Resolves true when done; throws STOP_ALL errors and STALE. */
  const sendPart = async (p) => {
    let tries = 0;
    let rate = 0;
    for (;;) {
      if (halted()) throw _err('ABORTED', 'Stopped.');
      guard();
      if (!pack.partsUnchanged(dir, [{ fileName: p.file_name, size: p.size, mtimeMs: p.mtime_ms }])) {
        throw _err('PART_CHANGED', 'A packed part changed on disk.');
      }
      await acquire();
      try {
        if (halted()) throw _err('ABORTED', 'Stopped.');
        guard();   // checked again right before the request: nothing is sent for an ended generation
      } catch (err) { release(); throw err; }
      _w(() => store.updatePart(id, p.part_no, { status: 'uploading', error: null }));
      job.bytes.set(p.part_no, 0);
      const ctrl = new AbortController();
      job.controllers.add(ctrl);
      if (signal.aborted) ctrl.abort();
      const folderId = (store.getShare(id) || row).folder_id || null;
      let r;
      let failure = null;
      try {
        r = await _client.uploadPart({
          token: account.token, filePath: path.join(dir, p.file_name), fileName: p.file_name, size: p.size,
          folderId, signal: ctrl.signal,
          onBytes: (n) => job.bytes.set(p.part_no, (job.bytes.get(p.part_no) || 0) + n),
        });
      } catch (err) {
        failure = err;
      } finally {
        release();
        job.controllers.delete(ctrl);
      }
      if (failure) {
        const err = failure;
        job.bytes.set(p.part_no, 0);
        guard();   // ended meanwhile: STALE, nothing written
        if (halted() || ctrl.signal.aborted) throw _err('ABORTED', 'Stopped.');
        if (STOP_ALL.has(err.code)) throw err;
        if (err.code === 'RATE_LIMIT' && rate < RATE_DELAYS_MS.length) {
          job.concurrency = 1;               // for the rest of this upload
          _w(() => store.updatePart(id, p.part_no, { status: 'waiting', error: 'gofile says too many requests. Waiting.' }));
          await _sleep(RATE_DELAYS_MS[rate++], signal);
          continue;
        }
        tries += 1;
        _w(() => store.updatePart(id, p.part_no, { tries: (p.tries || 0) + tries }));
        if (tries <= retries && err.code !== 'RATE_LIMIT') {
          _w(() => store.updatePart(id, p.part_no, { status: 'waiting', error: `${PART_FAIL_MESSAGES[err.code] || 'This part failed.'} Trying again.` }));
          await _sleep(RETRY_DELAYS_MS[tries - 1], signal);
          continue;
        }
        _w(() => store.updatePart(id, p.part_no, { status: 'failed', error: PART_FAIL_MESSAGES[err.code] || 'This part failed.' }));
        return false;
      }
      // gofile has this part: on record whatever happened meanwhile (a stop
      // that came while it was on its way deletes it by this folder id).
      _record(() => {
        const cur = store.getShare(id);
        if (!cur) return;
        if (!cur.folder_id) store.updateShare(id, { folder_id: r.folderId, code: r.code, link: r.link });
        store.updatePart(id, p.part_no, { status: 'done', file_id: r.fileId, md5: r.md5, error: null });
      });
      guard({ needOn: false });
      return true;
    }
  };

  const list = pending.slice();
  // Without a folder yet, the first part goes alone: it makes the folder.
  if (!(store.getShare(id) || row).folder_id && list.length) {
    let ok;
    try {
      ok = await sendPart(list.shift());
    } catch (err) {
      stopAll(err);
      return;
    }
    if (!ok) {
      // No folder means later parts would make folders of their own: wait for the user.
      pausedNow('The first part could not be uploaded. Use Try again.');
      return;
    }
  }
  // Two workers; the slots above decide how many actually send at once. The
  // first error that stops everything halts the other worker too, and its
  // request in flight is aborted, so nothing more is sent after it.
  const worker = async () => {
    while (list.length && !fatal) {
      try {
        await sendPart(list.shift());
      } catch (err) {
        if (!fatal) {
          fatal = err;
          for (const c of job.controllers) { try { c.abort(); } catch {} }
        }
        return;
      }
    }
  };
  await Promise.all([worker(), worker()]);
  if (fatal) { stopAll(fatal); return; }
  if (_why(id, gen, { needOn: false })) return;

  const parts = store.getParts(id);
  const failed = parts.filter(p => p.status === 'failed').length;
  if (failed) {
    pausedNow(failed === 1 ? '1 part could not be uploaded. Use Try again.' : `${failed} parts could not be uploaded. Use Try again.`);
    return;
  }
  job.finishing = true;
  try {
    await _finish(id, gen, account, signal);
  } finally {
    job.finishing = false;
  }
}

/**
 * Every part is on gofile: the delete timer, then 'uploaded', then the local
 * parts. Each step only while this generation is current and the library is
 * unlocked; the timer only with the feature on (with it off the share still
 * ends 'uploaded', without a timer).
 */
async function _finish(id, gen, account, signal) {
  if (_why(id, gen, { needOn: false })) return;
  const row = store.getShare(id);
  const now = _now();
  const deleteAt = row.delete_after_days > 0 ? now + row.delete_after_days * DAY_MS : null;
  let timerSet = 0;
  let note = null;
  if (deleteAt) {
    for (let i = 0; i < 3 && !timerSet; i++) {
      const why = _why(id, gen);
      if (why === 'stale') return;
      if (why === 'off') break;
      try {
        await _client.setExpiry({ token: account.token, folderId: row.folder_id, expiresAtSec: Math.floor(deleteAt / 1000), signal });
        timerSet = 1;
      } catch (err) {
        if (_why(id, gen, { needOn: false })) return;   // stopped or locked while it was out
        if (STOP_ALL.has(err.code)) break;
        if (i < 2) await _sleep(RETRY_DELAYS_MS[i], signal);
      }
    }
    if (!timerSet) note = 'Uploaded, but the delete timer could not be set on gofile. Use Set timer again, or Delete.';
  }
  if (_why(id, gen, { needOn: false })) return;
  _w(() => store.updateShare(id, {
    status: 'uploaded', uploaded_at: now, delete_after: deleteAt, timer_set: timerSet, last_error: note,
  }));
  if (!row.keep_local) {
    if (_why(id, gen, { needOn: false, status: 'uploaded' })) return;
    await temp.removeWorkDir(row.work_dir);
    _w(() => store.updateShare(id, { work_dir: null }));
  }
  // A password that is not remembered stays in this job's memory, so step 4
  // can still show it, until Vault stops.
}

function pause(id) {
  return _serial(id, async () => {
    ensureRecovered();
    const row = _row(id);
    if (row.status !== 'uploading') throw _err('WRONG_STATE', 'This share is not uploading.');
    const job = _job(row.id);
    _invalidate(job);
    store.updateShare(row.id, { status: 'paused' });
    for (const p of store.getParts(row.id)) if (p.status === 'uploading') store.updatePart(row.id, p.part_no, { status: 'waiting' });
    // A part that finished on its way is still recorded as done by the worker.
    await _settle(job);
    if (vault.isLocked()) throw _lockedErr();
    return progress(row.id);
  });
}

function _partsPresent(row, onlyPending) {
  const dir = temp.workDirPath(row.work_dir);
  if (!dir) return false;
  const parts = store.getParts(row.id).filter(p => !onlyPending || p.status !== 'done');
  return pack.partsUnchanged(dir, parts.map(p => ({ fileName: p.file_name, size: p.size, mtimeMs: p.mtime_ms })));
}

/** Resume, inside the share's queue. */
function _resumeNow(id) {
  _requireOn();
  _requireOnline('upload');
  const row = _row(id);
  if (!['paused', 'not_finished'].includes(row.status)) throw _err('WRONG_STATE', 'This share is not paused.');
  if (!_partsPresent(row, true)) {
    store.updateShare(row.id, { status: 'failed', last_error: 'The packed parts are no longer on this computer, so the upload cannot go on. Delete the uploaded parts from My shares.' });
    throw _err('PARTS_MISSING', 'The packed parts are no longer on this computer, so the upload cannot go on.');
  }
  for (const p of store.getParts(row.id)) if (p.status !== 'done') store.updatePart(row.id, p.part_no, { status: 'waiting', error: null, tries: p.status === 'failed' ? 0 : p.tries });
  store.updateShare(row.id, { status: 'uploading', last_error: null });
  _enqueue(row.id);
  return progress(row.id);
}

/** Async: runs in the share's queue. */
function resume(id) {
  return _serial(id, () => {
    ensureRecovered();
    return _resumeNow(id);
  });
}

/** Async: runs in the share's queue. */
function retryPart(id, partNo) {
  return _serial(id, () => {
    ensureRecovered();
    const row = _row(id);
    const n = Number(partNo);
    const part = store.getParts(row.id).find(p => p.part_no === n);
    if (!part) throw _err('NOT_FOUND', 'That part was not found.');
    if (part.status !== 'failed') throw _err('WRONG_STATE', 'That part has not failed.');
    if (row.status === 'uploading') {
      // The job is still sending other parts: it picks this one up on resume.
      throw _err('WRONG_STATE', 'Wait for the other parts to finish, then try this one again.');
    }
    return _resumeNow(row.id);
  });
}

/**
 * Stop and delete uploaded parts (spec 6.4). Works with the feature off.
 * 'stopping' is written before anything is awaited, so nothing can restart
 * the upload meanwhile; the worker is then waited for, and the folder id is
 * read AFTER it stopped, so a part that reached gofile on its way out is
 * deleted too.
 */
function stop(id, { confirm } = {}) {
  return _serial(id, async () => {
    ensureRecovered();
    if (confirm !== true) throw _err('CONFIRM_NEEDED', 'Confirm that the upload should stop and its parts be deleted.');
    const row = _row(id);
    if (!['uploading', 'paused', 'not_finished', 'failed'].includes(row.status)) throw _err('WRONG_STATE', 'This share is not being uploaded.');
    const job = _job(row.id);
    _invalidate(job);
    store.updateShare(row.id, { status: 'stopping', last_error: null });
    await _settle(job);
    if (vault.isLocked()) throw _lockedErr();   // the unlock settles it (_settleOrphans)
    const cur = store.getShare(row.id);
    let remoteError = null;
    if (cur.folder_id) {
      try {
        await _deleteRemoteRow(cur);
      } catch (err) {
        remoteError = err;
      }
    }
    await temp.removeWorkDir(cur.work_dir);
    if (vault.isLocked()) throw _lockedErr();
    if (remoteError && remoteError.code !== 'NOT_FOUND') {
      const why = remoteError.code === 'NET_OFF'
        ? 'Stopped. Vault is set to stay offline (VAULT_OFFLINE=1), so the uploaded parts could not be deleted from gofile yet. Use Delete in My shares once Vault may go online.'
        : `Stopped. The uploaded parts could not be deleted from gofile yet: ${_plain(remoteError).error} Use Delete in My shares.`;
      store.updateShare(row.id, { status: 'failed', work_dir: null, last_error: why });
      throw Object.assign(remoteError, { stopped: true });
    }
    store.updateShare(row.id, { status: 'cancelled', work_dir: null, deleted_at: _now(), last_error: null });
    store.pruneAccounts(store.latestAccount(SESSION)?.id ?? null);
    _jobs.delete(row.id);
    return publicShare(store.getShare(row.id));
  });
}

/* ── My shares actions ──────────────────────────────────────────────────── */

/**
 * Delete one share's folder on gofile. Works with the feature off (spec
 * section 1, promise 4), never while offline. `row` must come from the store:
 * the folder id and the account are Vault's own records.
 */
async function _deleteRemoteRow(row) {
  _requireOnline('delete');
  const acc = row.account_id ? store.getAccount(row.account_id) : null;
  if (!acc || !row.folder_id) throw _err('NO_ACCOUNT', 'Vault no longer has what it needs to delete this upload.');
  await _client.deleteContent({ token: acc.token, folderId: row.folder_id });
}

function deleteRemote(id) {
  return _serial(id, async () => {
    ensureRecovered();
    const row = _row(id);
    if (row.status === 'uploading' || (_jobs.get(row.id) || {}).running) throw _err('WRONG_STATE', 'This share is uploading. Use Stop and delete instead.');
    if (!row.folder_id || !MAY_BE_ONLINE.includes(row.status)) throw _err('WRONG_STATE', 'There is nothing of this share on gofile to delete.');
    let gone = false;
    try {
      await _deleteRemoteRow(row);
    } catch (err) {
      if (err.code !== 'NOT_FOUND') {
        if (!['FEATURE_OFF', 'NET_OFF'].includes(err.code) && !vault.isLocked()) {
          store.updateShare(row.id, { last_error: `Could not delete from gofile: ${_plain(err).error}` });
        }
        throw err;
      }
      gone = true;
    }
    await temp.removeWorkDir(row.work_dir);
    if (vault.isLocked()) throw _lockedErr();
    store.updateShare(row.id, {
      status: gone ? 'gone' : 'deleted', deleted_at: _now(), work_dir: null,
      last_error: gone ? 'gofile said it was already gone.' : null,
    });
    _jobs.delete(row.id);
    store.pruneAccounts(store.latestAccount(SESSION)?.id ?? null);
    return publicShare(store.getShare(row.id));
  });
}

/** Delete every upload that may still be on gofile, one by one. */
async function deleteAll({ confirm } = {}) {
  ensureRecovered();
  if (confirm !== true) throw _err('CONFIRM_NEEDED', 'Tick the box to confirm deleting all uploads.');
  // No feature switch check: deleting works with the feature off.
  _requireOnline('delete');
  const results = [];
  for (const row of _listed()) {
    if (!row.folder_id || !MAY_BE_ONLINE.includes(row.status)) continue;
    if (row.status === 'uploading') {
      results.push({ id: row.id, archiveName: row.archive_name, ok: false, code: 'WRONG_STATE', error: 'This share is uploading. Stop it first.' });
      continue;
    }
    try {
      const s = await deleteRemote(row.id);
      results.push({ id: row.id, archiveName: row.archive_name, ok: true, status: s.status });
    } catch (err) {
      // Our own errors carry fixed plain messages; anything else gets the
      // generic one, like sendError() gives (never a raw message).
      results.push({ id: row.id, archiveName: row.archive_name, ok: false, ..._plain(err) });
    }
  }
  return { results, deleted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
}

/** Async: runs in the share's queue. */
function markGone(id) {
  return _serial(id, () => {
    ensureRecovered();
    const row = _row(id);
    if (!['uploaded', 'failed', 'not_finished', 'paused'].includes(row.status)) throw _err('WRONG_STATE', 'This share cannot be marked as gone.');
    store.updateShare(row.id, { status: 'gone', deleted_at: _now() });
    return publicShare(store.getShare(row.id));
  });
}

function remove(id, { confirm } = {}) {
  return _serial(id, async () => {
    ensureRecovered();
    const row = _row(id);
    const job = _jobs.get(row.id);
    if (['uploading', 'packing', 'stopping'].includes(row.status) || (job && (job.running || job.packing))) {
      throw _err('WRONG_STATE', 'This share is busy. Stop it first.');
    }
    const mayBeOnline = !!row.folder_id && MAY_BE_ONLINE.includes(row.status) && _displayStatus(row) !== 'expired';
    if (mayBeOnline && confirm !== true) {
      throw _err('STILL_ONLINE', 'This upload may still be on gofile. Once it is off the list, Vault cannot delete it for you.');
    }
    // Durable before the first await (see cancel).
    store.updateShare(row.id, { status: 'removing' });
    if (job) _invalidate(job);
    await temp.removeWorkDir(row.work_dir);
    if (vault.isLocked()) throw _lockedErr();
    store.deleteShare(row.id);
    _jobs.delete(row.id);
    store.pruneAccounts(store.latestAccount(SESSION)?.id ?? null);
    return { removed: true };
  });
}

function retryTimer(id) {
  return _serial(id, async () => {
    ensureRecovered();
    _requireOn();
    _requireOnline('timer');
    const row = _row(id);
    if (row.status !== 'uploaded' || row.timer_set || !row.delete_after) throw _err('WRONG_STATE', 'This share does not need its timer set.');
    const acc = store.getAccount(row.account_id);
    if (!acc) throw _err('NO_ACCOUNT', 'Vault no longer has what it needs to set the timer.');
    await _client.setExpiry({ token: acc.token, folderId: row.folder_id, expiresAtSec: Math.floor(row.delete_after / 1000) });
    if (vault.isLocked()) throw _lockedErr();
    store.updateShare(row.id, { timer_set: 1, last_error: null });
    return publicShare(store.getShare(row.id));
  });
}

/* ── Passwords (gated) ──────────────────────────────────────────────────── */

function _sharePassword(row) {
  if (row.password) return row.password;
  const job = _jobs.get(row.id);
  return job && job.password ? job.password : null;
}

/** The password of one share. Saved-password shares need the Vault password. */
function revealPassword(id, { vaultPassword } = {}) {
  ensureRecovered();
  const row = _row(id);
  if (row.password_kind === 'saved') gate.check(vaultPassword);
  const pass = _sharePassword(row);
  if (!pass) throw _err('NO_PASSWORD', 'Vault did not keep the password of this share.');
  return { password: pass };
}

/**
 * Copy as block, rendered here so the template rules live in one place.
 * @param {{vaultPassword?:string, format?:string}} o  format: try a format
 *        without saving it (the editor preview); defaults to the setting
 */
function copyBlock(id, { vaultPassword, format } = {}) {
  ensureRecovered();
  const row = _row(id);
  if (!row.link) throw _err('NO_LINK', 'This share has no link yet.');
  let fmt = names.formatFor(settings.get());
  if (format !== undefined) {
    if (typeof format !== 'string' || !format.trim() || format.length > names.FORMAT_MAX) throw _err('BAD_INPUT', 'The copy format is not valid.');
    fmt = format;
  }
  let pass = null;
  if (fmt.includes('{pass}')) {
    pass = _sharePassword(row);
    if (pass && row.password_kind === 'saved') gate.check(vaultPassword);
  }
  const text = names.renderBlock(fmt, { link: row.link, code: row.code, pass, name: row.archive_name });
  return { text, passwordIncluded: !!pass && fmt.includes('{pass}') };
}

/** The copy format filled with made-up values (for the format editor). */
function previewFormat(format) {
  if (typeof format !== 'string' || !format.trim() || format.length > names.FORMAT_MAX) throw _err('BAD_INPUT', 'The copy format is not valid.');
  return { text: names.renderBlock(format, { link: 'https://gofile.io/d/x7k2p9Qm', code: 'x7k2p9Qm', pass: 'T4rQ-Wq9z-Lm2K-xP7d-Vb6N-hJ3s', name: 'k7Qm2xVd9LpA' }) };
}

function _validSavedPassword(p) {
  if (typeof p !== 'string') throw _err('BAD_PASSWORD', 'Type a password.');
  if (p.length < 8 || p.length > 128) throw _err('BAD_PASSWORD', 'The password must be 8 to 128 characters long.');
  // Printable ASCII only: it is typed by whoever receives the share, and
  // some 7-Zip builds read other characters differently (see sevenzip.js).
  if (!/^[\x20-\x7e]+$/.test(p)) throw _err('BAD_PASSWORD', 'Use only letters, digits, spaces and the usual keyboard symbols.');
  if (/^\s|\s$/.test(p)) throw _err('BAD_PASSWORD', 'The password cannot start or end with a space.');
  return p;
}

function revealSavedPassword({ vaultPassword } = {}) {
  ensureRecovered();
  gate.check(vaultPassword);
  const p = store.kvGet('saved_password');
  if (!p) throw _err('NO_SAVED_PASSWORD', 'There is no saved password yet.');
  return { password: p };
}

/**
 * Change (or set, or clear) the saved default password.
 * @param {{vaultPassword?, password?, random?:boolean, clear?:boolean, acknowledgeNoVaultPassword?:boolean}} o
 */
function changeSavedPassword({ vaultPassword, password, random, clear, acknowledgeNoVaultPassword } = {}) {
  ensureRecovered();
  gate.check(vaultPassword);
  if (clear === true) {
    store.kvSet('saved_password', null);
    return { set: false };
  }
  if (!gate.required() && store.kvGet('warning_shown') !== '1') {
    if (acknowledgeNoVaultPassword !== true) {
      throw _err('WARNING_NEEDED', 'There is no Vault password, so the saved password would be stored unencrypted. Confirm that first.');
    }
    store.kvSet('warning_shown', '1');
  }
  const next = random === true ? names.randomPassword() : _validSavedPassword(password);
  store.kvSet('saved_password', next);
  return { set: true, password: next };
}

function markWarningShown() {
  ensureRecovered();
  store.kvSet('warning_shown', '1');
  return savedPasswordStatus();
}

/* ── Settings that act on records ───────────────────────────────────────── */

async function updateSettings(patch, { confirm } = {}) {
  ensureRecovered();
  const valid = settings.validatePatch(patch);
  const before = settings.get();
  const forgetsPasswords = before.rememberPasswords && valid.rememberPasswords === false;
  const forgetsFiles = before.rememberFiles && valid.rememberFiles === false;
  if ((forgetsPasswords || forgetsFiles) && confirm !== true) {
    throw _err('CONFIRM_NEEDED', forgetsPasswords
      ? 'Turning this off deletes the stored passwords of past shares. Confirm first.'
      : 'Turning this off deletes the stored file lists of past shares. Confirm first.');
  }
  const next = settings.save(valid);
  const out = { settings: next };
  if (forgetsPasswords) out.passwordsCleared = store.clearSharePasswords();
  if (forgetsFiles) out.fileListsCleared = store.clearFileLists();
  if (before.enabled && next.enabled === false) await onFeatureOff();
  return out;
}

/**
 * The switch went off: nothing more is uploaded and no timer is set. A share
 * waiting in line, or still sending parts, is paused at once (written before
 * anything is awaited, and only while it is still 'uploading'). A share whose
 * parts are all on gofile (setting its timer) is woken instead: it ends
 * 'uploaded' without a timer, and is never written over afterwards.
 */
async function onFeatureOff() {
  const ids = [..._queue, ...(_active !== null ? [_active] : [])];
  const waits = [];
  for (const id of ids) {
    const job = _jobs.get(id);
    if (!job) continue;
    if (job.finishing && job.running && _active === id) {
      _wake(job);
    } else {
      _invalidate(job);
      _w(() => {
        if (store.getShare(id)?.status !== 'uploading') return;
        store.updateShare(id, { status: 'paused', last_error: OFF_REASON });
        for (const p of store.getParts(id)) if (p.status === 'uploading') store.updatePart(id, p.part_no, { status: 'waiting' });
      });
    }
    waits.push(_settle(job));
  }
  await Promise.all(waits);
}

/* ── Vault lock ─────────────────────────────────────────────────────────── */

vault.onChange((e) => {
  if (e === 'unlocked') {
    // Records that came in while locked, then any action the lock cut short.
    _flushPending();
    _orphans = true;
    return;
  }
  if (e !== 'locking') return;
  _orphans = true;
  // The database is still open during 'locking': write the pauses now.
  for (const job of _jobs.values()) {
    if (job.packing && job.handle) {
      job.handle.cancelled = true;
      if (job.handle.kill) job.handle.kill();
      const row = (() => { try { return store.getShare(job.id); } catch { return null; } })();
      if (row) {
        try { store.deleteShare(job.id); } catch {}
        const wd = row.work_dir;
        job.packing.finally(() => temp.removeWorkDir(wd)).catch(() => {});
      }
      continue;
    }
    if (job.running || job.queued) {
      // The worker stops at its next check: no request, no write after this.
      _invalidate(job);
      try {
        if (store.getShare(job.id)?.status !== 'uploading') continue;
        store.updateShare(job.id, { status: 'paused', last_error: LOCK_REASON });
        for (const p of store.getParts(job.id)) if (p.status === 'uploading') store.updatePart(job.id, p.part_no, { status: 'waiting' });
      } catch {}
    }
  }
});

/* ── Tests only ─────────────────────────────────────────────────────────── */

function _setForTest({ client, sleep, now, program } = {}) {
  if (client !== undefined) _client = client || new GofileClient();
  if (sleep !== undefined) _sleep = sleep || _defaultSleep;
  if (now !== undefined) _now = now || (() => Date.now());
  if (program !== undefined) _program = program;
}

/** Tests only: forget memory state, as a restart would. */
function _simulateRestart() {
  _jobs.clear();
  _queue.length = 0;
  _active = null;
  _recovered = false;
  _locks.clear();
  _pending.length = 0;
}

async function _idle() {
  await Promise.all([..._locks.values()]);
  for (const j of [..._jobs.values()]) {
    if (j.packing) { try { await j.packing; } catch {} }
    await _settle(j);
  }
}

module.exports = {
  SESSION,
  state, preview, start, cancel, progress, listShares, getShare,
  confirmUpload, pause, resume, retryPart, stop,
  deleteRemote, deleteAll, markGone, remove, retryTimer,
  revealPassword, copyBlock, previewFormat,
  savedPasswordStatus, revealSavedPassword, changeSavedPassword, markWarningShown,
  updateSettings, onFeatureOff, ensureRecovered,
  _setForTest, _simulateRestart, _idle,
};
