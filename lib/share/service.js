/**
 * Share privately: the jobs (spec 6.4) and everything the routes call.
 *
 * FLOW, and where data could leave the computer:
 *   preview()        local: sizes, names, free space.
 *   start()          local: packs into share_temp, then runs the checks
 *                    (lib/share/pack.js). Ends 'checked' or 'failed'. While
 *                    another share packs it waits its turn ('queued', see
 *                    THE PACK LINE below).
 *   confirmUpload()  THE ONLY WAY AN UPLOAD STARTS. Needs confirm === true,
 *                    status 'checked' with every check passed, the parts on
 *                    disk unchanged since the checks, the feature on and
 *                    VAULT_OFFLINE off. Nothing before this point touches the
 *                    network: the gofile client is only called from
 *                    _runUpload() (reached from confirmUpload, resume and
 *                    retryPart, which need an upload the user already
 *                    confirmed) and from the delete / timer actions.
 *                    "When packing is done: Upload on its own" (afterPack
 *                    'upload') goes through the very same function
 *                    (_autoUpload -> _confirmNow), with every check above,
 *                    and only for a share whose start carried
 *                    confirmUpload === true (the page's tick box, the same
 *                    words as step 3). See UPLOAD ON ITS OWN below.
 *
 * THE PACK LINE: one 7-Zip at a time. A share started while another packs is
 * stored 'queued' (no work folder yet) and waits in line, first come first
 * served (_packQueue, _pumpPack). Until its turn it holds in memory only what
 * the packing job holds today: the password and the plan (the file paths).
 * Nothing else is written for it, and both are wiped when it is cancelled,
 * on a lock (any kind: a waiting share is cancelled like a running pack) and
 * on exit. When its turn comes, every picked file is looked at again and the
 * free space is measured again: a file that changed or is gone, too little
 * space, or the feature turned off meanwhile fails that share with a plain
 * message, and the next one takes its turn. The free-space check at start
 * counts the shares already waiting ahead, and what the running pack still
 * has to write (an estimate from its percent), so a queue is not accepted
 * that clearly cannot fit; the check at the turn is the one that counts.
 *
 * UPLOAD ON ITS OWN (afterPack 'upload'; the default 'wait' stops at
 * 'checked', "Ready to check", for the user). The mode is the one in force
 * at start, kept on the job. Once every check passed the upload is started
 * through _confirmNow, in the share's queue, so it meets every gate the
 * manual Upload meets (feature on, VAULT_OFFLINE off, status 'checked' with
 * the checks passed, the parts unchanged); the no-Vault-password warning was
 * already required at start. A failed check never uploads. It also waits for
 * the user, at 'checked' with a note, when Vault does not keep this share's
 * password (neither stored with "Passwords of past shares" nor the current
 * saved password): the user then sees the password before anything is
 * uploaded, so an upload never ends up with a password that only lived in
 * memory. Any other refusal (offline, feature off) also leaves it 'checked'
 * with the reason.
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
 * step 3 (queued, packing, checked) are thrown away with their files: their
 * password may have lived in memory only.
 *
 * LOCKING THE LIBRARY pauses the upload, cancels a packing job and every
 * share waiting to pack. Unlocking
 * does not resume; the page offers it. Turning the feature off pauses the
 * same way. From the moment the lock begins ('locking', database still open)
 * no share code sends a gofile request or touches the database: _gofile()
 * and _uploadPart() refuse (as the gofile client does), each queued action
 * answers VAULT_LOCKED when its turn comes (_serial), Delete all stops
 * between shares. Requests in flight are aborted (a part only while its
 * bytes are still going out, see _uploadPart). An aborted request's answer is
 * thrown away even if gofile carried it out (an account it made, a Delete or
 * a timer it did, is not on record; Delete again then says "already gone").
 * An answer that did come in while locked (a part past its last byte, or a
 * request answered just before the abort) is recorded on unlock (_record), a
 * part also on disk meanwhile.
 *
 * THE AUTOMATIC LOCK WAITS FOR WORK (isWorking, registered as an autolock
 * hold in lib/vault.js). While 7-Zip packs or checks a share, a share waits
 * to pack behind a pack that is alive, an upload is sending, or an upload
 * waits in line behind it, the idle lock does not fire. A share waiting to
 * pack has no clock of its own: it holds only while the pack line shows life
 * (_packSeenAt, within STALL_MS), and taking its turn starts from that
 * evidence, never from now. Nothing else holds it off: a share that is
 * checked ("Ready to check", waiting for the user), paused, not_finished,
 * failed or uploaded never does, and
 * neither does a worker whose generation ended (pause, stop, a new start).
 * The hold is not activity: the idle clock keeps running, so the library
 * locks on the first autolock tick after the work ends if nobody came back.
 * A manual lock is not affected at all: it locks at once and cancels the
 * packing or pauses the upload as described above.
 * A job holds only while it shows signs of life (job.seenAt), and only real
 * evidence counts. Packing: the share started, a file linked, copied,
 * checked for personal details or cleaned (a cached check answer and the
 * start of a step, which reports percent 0, are not), any output 7-Zip or
 * ffmpeg writes (packing prints its percent, the archive test its progress
 * on stderr), each check step after the one before ended. Uploading: the user
 * confirming or resuming it, bytes taken by the network (onBytes), and an
 * answer gofile actually sent: a part or timer accepted, or an error answer
 * (gofile.js marks those `answered`, "too many requests" included). NOT a
 * local time limit, a dropped connection, an abort, a retry being scheduled,
 * or the worker moving on to the next part or the next share in line: a
 * share that takes its turn in line starts from the last real evidence of
 * the upload line (_uploadSeenAt), not from now. With none for STALL_MS (15
 * minutes) the hold ends, so a hung 7-Zip or a blackholed connection cannot
 * keep the library open, however many parts and retries are left; the idle
 * lock then cancels or pauses it as any lock does. Error answers can keep it
 * going only as long as the retry rules allow: per part at most
 * RATE_DELAYS_MS.length "too many requests" waits and the retries of the
 * "If a part fails" setting, then the part fails and, once every part had
 * its turn, the upload pauses. Every legitimate quiet spell is far shorter
 * than STALL_MS: the gofile time limits below are 3 minutes at most, retry
 * and "too many requests" waits at most 1 minute, 7-Zip prints at every
 * percent. The one exception is a single file staged by a copy across
 * drives (pack.js), which shows no sign of life until it is copied.
 *
 * TIME LIMITS (TIMEOUTS): every gofile request is bounded, so a request that
 * never answers fails with a plain NETWORK error and releases its share's
 * queue and Delete all.
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
 * WORK FOLDERS (share_temp/share-xxxx, lib/share/temp.js). A folder Vault
 * could not delete (a file in it held open, say) is NOT forgotten: the share
 * record keeps its name (a cancelled or removed share stays as a hidden
 * 'removing' record) and the clean-up (_cleanupPass) tries again on later
 * calls, dropping the record only once the folder is gone. The clean-up also
 * deletes what 7-Zip read while packing (list.txt, stage/) wherever it is
 * still found, and sweeps work folders no record names, but only those whose
 * marker names this library (temp.js LIBRARY_MARKER), and only while the
 * library is unlocked. On exit (shutdown) a running 7-Zip is stopped and its
 * folder deleted when possible; the next unlocked start covers the rest.
 *
 * PERSONAL DETAILS (lib/share/meta.js). Always checked: there is no setting
 * for it (an old stored "checkPersonal" is ignored, settings.js). Step 1 asks
 * metaCheck / metaCheckStatus, which check the picked files a few at a time
 * and answer what was found per file (values shortened, in memory only, never
 * in the database, a share row, last_error or a log). The page sends back
 * only a yes or no, the step 1 "Remove" switch, which starts on for every
 * share (removePersonal: exactly false is "not removed"; anything else, or
 * nothing at all, is remove), never a list of files. Every way a share starts
 * (the selection bar, a whole collection, one that uploads on its own) comes
 * through start(), so this holds for all of them whatever the page sends.
 * At the pack's turn the server checks every file of
 * the share again itself (meta.checkNow: the session cache only for the very
 * same file, by size, modified and changed times and file id; a new check
 * otherwise) and only the files THAT check flags are cleaned, into the work
 * folder, before 7-Zip runs (phase 'cleaning', "Removing personal
 * details"). A file of a type Vault checks whose check FAILED (or did not
 * happen) is never taken as clean: the share fails, naming it ("could not
 * check <name>"); only a type Vault does not read goes in as it is, as step
 * 1 said. After 7-Zip, every file that went in as it is must still be the
 * file that was checked (size, modified time, file id), or the share fails.
 * The free space counts the copies: at start from what step 1 found (a file
 * not checked yet counts as one that needs a copy), and again, exactly,
 * after that check. A copy that cannot be made clean fails the share with
 * the file's name; the original is never packed in its place. A check that
 * actually ran or a file cleaned is a sign of life for the automatic lock
 * (isWorking), and so is ffmpeg's output while it copies; a cached answer
 * and the start of a step are not. Cancel, lock and exit stop ffmpeg like
 * 7-Zip, and the partial copy goes with stage/ and the work folder. The
 * found values are dropped (meta.forget) on a lock, on exit, and when the
 * feature is turned off.
 * Without ffprobe or ffmpeg (meta.toolsReady, looked up afresh for every
 * preview, check and start, so a download needs no restart) there is no
 * check: preview says personalCheckReady: false, step 1 shows the box greyed
 * with Remove off, metaCheck is refused, and start() with removePersonal
 * false packs the files as they are and is never stopped for it. start()
 * refuses a request that still asks for removal then (PERSONAL_CHECK_OFF,
 * nothing stored), and a share that was to be cleaned stops at the pack's
 * turn, nothing packed, if they went missing meanwhile: nothing ever goes
 * out as is after the user was shown that it would be cleaned.
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
const meta = require('./meta');
const sevenzip = require('./sevenzip');
const gate = require('./gate');
const { GofileClient, netOffMessage, ID_RX } = require('./gofile');

const SESSION = crypto.randomBytes(12).toString('hex');   // "this Vault start"
const MAX_FILES = 5000;
const RATE_DELAYS_MS = [5000, 10000, 20000, 40000, 60000, 60000];
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const DAY_MS = 24 * 60 * 60 * 1000;

const MAY_BE_ONLINE = ['uploaded', 'not_finished', 'paused', 'failed', 'uploading'];
const LOCK_REASON = 'Paused because the library was locked.';
const OFF_REASON = 'Paused because Share privately was turned off.';
const STOP_UNFINISHED = 'Stop and delete did not finish, so the uploaded parts may still be on gofile. Use Delete.';
const TIMEOUT_MESSAGE = 'gofile did not answer in time. Check the internet connection and try again.';
// A first part whose bytes were all sent, but whose answer never came: gofile
// may have made a folder Vault was never told about.
const UNKNOWN_FOLDER = 'gofile did not answer after the first part was sent, so it may be on gofile in a folder Vault does not know. Vault cannot delete it for you.';
const PENDING_FILE = '.vault-pending-parts.json';

/*
 * How long a gofile request may take (see _gofile and _uploadPart).
 * call:         an account, a delete, a timer: the whole request.
 * uploadIdle:   a part while its bytes go out: the longest time with no 1 MB
 *               read taken by the network. Parts can be gigabytes on a slow
 *               link, so this bounds a stall, not the whole upload.
 * uploadAnswer: a part whose bytes are all sent: the wait for gofile's answer.
 */
const TIMEOUTS = Object.freeze({ call: 30 * 1000, uploadIdle: 3 * 60 * 1000, uploadAnswer: 3 * 60 * 1000 });
let _timeouts = { ...TIMEOUTS };
// A job with no sign of life for this long no longer holds the automatic
// lock off (see the top of this file, and isWorking).
const STALL_MS = 15 * 60 * 1000;
// The last real evidence that the upload line is moving (bytes taken, a
// gofile answer, the user confirming or resuming). A share taking its turn in
// line starts from it (_pump), so moving on never counts as evidence.
let _uploadSeenAt = 0;
// The same for the pack line: the last real evidence of the running pack. A
// share waiting to pack holds the automatic lock only while this is fresh.
let _packSeenAt = 0;

let _client = new GofileClient();
// Aborted on 'locking': every account, delete and timer request in flight gets
// it (an upload gets its job's abort instead). A new one on 'unlocked'.
let _lockAc = new AbortController();
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
const _packQueue = [];   // shareIds waiting to pack ('queued'), first come first served
let _packActive = null;  // shareId 7-Zip is packing or checking now
let _recovered = false;
const _locks = new Map(); // shareId -> tail of that share's action queue
const _pending = [];     // records that found the library locked; written on unlock
const _pendingFiles = new Set(); // their copies on disk (_persistPart), removed once written
let _orphans = false;    // a 'stopping' row may have lost its action
let _cleanupWanted = true; // a work folder may be left to delete (see the top of this file)
let _cleaning = null;      // the clean-up pass running now
let _lastCleanup = 0;
const CLEANUP_EVERY_MS = 10 * 1000;
// Statuses whose share needs no local files any more ('uploaded' only without
// "Keep the packed archive"; see _wantsNoFiles).
const NO_FILES = new Set(['removing', 'deleted', 'gone', 'cancelled', 'failed']);

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
  for (const f of [..._pendingFiles]) {
    _pendingFiles.delete(f);
    _unlinkPlainFile(f);
  }
}

/*
 * A part gofile accepted while the library was locked is also written to a
 * small file in that share's own work folder (share_temp/share-xxxx), so a
 * Vault that quits before the unlock still knows the folder on the next
 * start (_recoverPendingParts). It holds the share id, the part number and
 * gofile's folder and file ids: no token, no password, no link, no code, no
 * name (the encrypted database stays the only place for those). It goes when
 * the record is written, or with the work folder.
 */
function _isPlainFile(f) {
  try { const st = fs.lstatSync(f); return st.isFile() && !st.isSymbolicLink(); } catch { return false; }
}

function _unlinkPlainFile(f) {
  try { if (_isPlainFile(f)) fs.unlinkSync(f); } catch {}
}

function _readPendingFile(f) {
  if (!_isPlainFile(f)) return [];
  try {
    const st = fs.statSync(f);
    if (st.size > 256 * 1024) return [];
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function _persistPart(dir, id, rec) {
  if (!dir) return;
  const f = path.join(dir, PENDING_FILE);
  try {
    const list = _readPendingFile(f).concat([{ shareId: id, partNo: rec.partNo, folderId: rec.folderId, fileId: rec.fileId }]);
    // A new file, then renamed over: never written through a link someone put there.
    const tmpFile = path.join(dir, `${PENDING_FILE}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmpFile, JSON.stringify(list), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmpFile, f);
    _pendingFiles.add(f);
  } catch (err) {
    console.warn(`[Share] could not keep a part record on disk (${err && err.code ? err.code : 'error'})`);
  }
}

/**
 * Next start: part records a locked Vault kept on disk and never wrote.
 * Only well-formed ids for a part that exists on that share are used.
 */
function _recoverPendingParts() {
  for (const row of store.listShares()) {
    const dir = temp.workDirPath(row.work_dir);
    if (!dir) continue;
    const f = path.join(dir, PENDING_FILE);
    const list = _readPendingFile(f);
    if (!list.length) { _unlinkPlainFile(f); continue; }
    const partNos = new Set(store.getParts(row.id).map(p => p.part_no));
    for (const r of list) {
      if (!r || r.shareId !== row.id || !partNos.has(r.partNo)) continue;
      // The folder is what matters (Stop and Delete act on it).
      if (typeof r.folderId !== 'string' || !ID_RX.test(r.folderId)) continue;
      const fileId = typeof r.fileId === 'string' && ID_RX.test(r.fileId) ? r.fileId : null;
      try {
        _applyPart(row.id, { partNo: r.partNo, folderId: r.folderId, fileId });
      } catch (err) {
        console.warn(`[Share] could not save share state (${err && err.code ? err.code : 'error'})`);
      }
    }
    _unlinkPlainFile(f);
  }
}

/** A part gofile accepted, on the share row (see the "never skipped" write above). */
function _applyPart(id, { partNo, folderId, fileId, code = null, link = null, md5 = null }) {
  const cur = store.getShare(id);
  if (!cur) return;
  if (!cur.folder_id) store.updateShare(id, { folder_id: folderId, code, link });
  else if (!cur.link && link && cur.folder_id === folderId) store.updateShare(id, { code, link });
  store.updatePart(id, partNo, { status: 'done', file_id: fileId, md5, error: null });
}

/** Record a part gofile accepted: now, or on unlock (and on disk meanwhile). */
function _recordPart(id, dir, rec) {
  if (vault.isLocked()) {
    _pending.push(() => _applyPart(id, rec));
    _persistPart(dir, id, rec);
    return false;
  }
  return _record(() => _applyPart(id, rec));
}

function _job(id) {
  let j = _jobs.get(id);
  if (!j) {
    j = { id, phase: null, percent: 0, handle: null, packing: null, password: null,
      controllers: new Set(), concurrency: 2, running: null, runGen: -1, gen: 0, ac: new AbortController(),
      finishing: false, bytes: new Map(), queued: false, unknownFolder: false, seenAt: 0,
      // The pack line: waiting its turn, the plan (file paths) until it
      // starts, and "Upload on its own" as it was at start (THE PACK LINE).
      packQueued: false, plan: null, archiveName: null, autoUpload: false,
      // The step 1 "Remove" switch, as start() read it (PERSONAL DETAILS).
      removePersonal: false };
    _jobs.set(id, j);
  }
  return j;
}

/** The job showed a sign of life: real evidence only (see the top of this file). */
function _saw(job) {
  job.seenAt = _now();
}

/** The same, for a pack: also the pack line's last evidence. */
function _sawPack(job) {
  _saw(job);
  _packSeenAt = job.seenAt;
}

/** What a share waiting to pack holds until its turn: gone (cancel, lock, exit, a failed turn). */
function _wipePackSecrets(job) {
  if (!job) return;
  job.password = null;
  job.plan = null;
  job.autoUpload = false;
}

/** The same, for an upload: also the upload line's last evidence. */
function _sawUpload(job) {
  _saw(job);
  _uploadSeenAt = job.seenAt;
}

/**
 * Is Share privately working right now, so the AUTOMATIC lock should wait?
 * True while a share is being packed or checked by 7-Zip (not cancelled), an
 * upload worker of the current generation is running, or an upload waits in
 * line, and that job showed a sign of life within STALL_MS; or while a share
 * waits to pack behind a pack that is running and showed a sign of life
 * within STALL_MS (it has no clock of its own). Anything that waits on the
 * user (checked, paused, not_finished, failed) is not work.
 * Never reads the database. See the top of this file.
 */
function isWorking() {
  if (vault.isLocked()) return false;
  const now = _now();
  const head = _packActive !== null ? _jobs.get(_packActive) : null;
  const lineAlive = !!(head && head.packing && head.handle && !head.handle.cancelled)
    && Math.abs(now - _packSeenAt) < STALL_MS;
  for (const job of _jobs.values()) {
    const packing = !!job.packing && !!job.handle && !job.handle.cancelled;
    const uploading = (!!job.running && job.runGen === job.gen) || job.queued;
    // abs: a clock set back far does not make an old sign of life look new.
    if ((packing || uploading) && Math.abs(now - job.seenAt) < STALL_MS) return true;
    const waitingToPack = job.packQueued && !(job.handle && job.handle.cancelled);
    if (waitingToPack && lineAlive) return true;
  }
  return false;
}

/**
 * Run fn as the next action of one share: after every action on it that came
 * before has ended (resolved or thrown). An id that is not a share id runs at
 * once (fn throws NOT_FOUND).
 */
function _serial(id, fn) {
  // When its turn comes, an action that was queued before a lock answers
  // VAULT_LOCKED and touches neither the database nor gofile.
  const turn = () => {
    if (vault.isLocked()) throw _lockedErr();
    return fn();
  };
  const key = Number(id);
  if (!Number.isInteger(key) || key < 1) return Promise.resolve().then(turn);
  const prev = _locks.get(key) || Promise.resolve();
  const run = prev.then(turn);
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

function _timeoutErr() {
  return _err('NETWORK', TIMEOUT_MESSAGE, { timedOut: true });
}

/*
 * THE ONLY WAYS THIS FILE CALLS THE GOFILE CLIENT: _gofile() for an account,
 * a delete or a timer, _uploadPart() for a part. Both refuse while the
 * library is locked (as the client does too), whatever the caller checked
 * before, and both bound the request in time.
 */

/**
 * createAccount, setExpiry or deleteContent, with a total time limit. The
 * request gets an abort signal that fires on the caller's signal, on a lock
 * and on the time limit. The answer is still waited for after an abort (a
 * fetch ends at once when aborted; a request gofile finished is then on
 * record), except past the time limit: the action then fails with a plain
 * NETWORK error, which releases the share's queue.
 */
function _gofile(name, opts = {}) {
  if (vault.isLocked()) return Promise.reject(_lockedErr());
  if (_lockAc.signal.aborted) _lockAc = new AbortController();   // unlocked since
  const limit = new AbortController();
  const { signal, release } = _anySignal([_lockAc.signal, limit.signal, ...(opts.signal ? [opts.signal] : [])]);
  let timer = null;
  const expired = new Promise((resolve, reject) => {
    timer = setTimeout(() => { limit.abort(); reject(_timeoutErr()); }, _timeouts.call);
  });
  let call;
  try { call = Promise.resolve(_client[name]({ ...opts, signal })); } catch (err) { call = Promise.reject(err); }
  return Promise.race([call, expired]).finally(() => { clearTimeout(timer); release(); });
}

/**
 * A signal aborted when any of `signals` is. AbortSignal.any (Node 20.3 and
 * later) links them weakly; the fallback for older Node removes its
 * listeners once the request has settled (release).
 */
function _anySignal(signals) {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(signals), release: () => {} };
  const ac = new AbortController();
  const onAbort = () => { try { ac.abort(); } catch {} };
  for (const s of signals) {
    if (s.aborted) { onAbort(); break; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: ac.signal, release: () => { for (const s of signals) s.removeEventListener('abort', onAbort); } };
}

/**
 * One part. `stop` is the worker's abort signal (pause, stop, lock, feature
 * off, a new generation). While the body is still being sent, a stop aborts
 * the request at once. Once every byte has been handed to the network
 * (onBodySent, see multipartBody in gofile.js) gofile may store the part
 * whatever Vault does, so a stop no longer aborts it: the answer is waited
 * for, so its folder and file ids can be recorded and the stop act on them.
 * Time limits: uploadIdle while sending (reset by every read the network
 * takes), uploadAnswer once all is sent. A failure says whether the body had
 * been sent (err.bodySent).
 */
function _uploadPart(opts, stop) {
  if (vault.isLocked()) return Promise.reject(_lockedErr());
  const req = new AbortController();
  let bodySent = false;
  let timer = null;
  let expire = null;
  const expired = new Promise((resolve, reject) => { expire = reject; });
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => { req.abort(); expire(_timeoutErr()); }, ms);
  };
  const onStop = () => { if (!bodySent) req.abort(); };
  if (stop.aborted) req.abort();
  else stop.addEventListener('abort', onStop, { once: true });
  arm(_timeouts.uploadIdle);
  let call;
  try {
    call = Promise.resolve(_client.uploadPart({
      ...opts,
      signal: req.signal,
      onBytes: (n) => {
        if (!bodySent) arm(_timeouts.uploadIdle);
        if (opts.onBytes) opts.onBytes(n);
      },
      onBodySent: () => {
        if (bodySent || req.signal.aborted) return;
        bodySent = true;
        arm(_timeouts.uploadAnswer);
      },
    }));
  } catch (err) { call = Promise.reject(err); }
  return Promise.race([call, expired])
    .catch((err) => { throw Object.assign(err instanceof Error ? err : _err('NETWORK', 'Could not reach gofile.'), { bodySent }); })
    .finally(() => {
      clearTimeout(timer);
      stop.removeEventListener('abort', onStop);
    });
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
    _recoverPendingParts();
    for (const row of store.sharesWithStatus(['queued', 'packing', 'checked'])) {
      if (_jobs.has(row.id)) continue;
      // Removed with its files by the clean-up below, the record last.
      store.updateShare(row.id, { status: 'removing' });
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
  _maybeCleanup();
}

/**
 * Finish a stop that a restart or a lock cut short: its row is still
 * 'stopping' and no action of that share is running. It ends 'failed' with
 * Delete offered when something may be on gofile, else 'cancelled'; its
 * folder goes with the clean-up. ('removing' rows are the clean-up's own:
 * folder first, then the record.) Returns how many rows were left because
 * their action is still running (checked again later).
 */
function _settleOrphans() {
  let left = 0;
  for (const row of store.sharesWithStatus(['removing', 'stopping'])) {
    if (_locks.has(row.id)) { left++; continue; }
    _cleanupWanted = true;
    if (row.status === 'removing') continue;
    if (row.folder_id) {
      store.updateShare(row.id, { status: 'failed', last_error: STOP_UNFINISHED });
    } else {
      const unknown = _unknownFolder(row);
      store.updateShare(row.id, { status: 'cancelled', deleted_at: _now(), last_error: unknown ? UNKNOWN_FOLDER : null });
    }
    _jobs.delete(row.id);
  }
  return left;
}

/* ── Work folder clean-up (see WORK FOLDERS at the top) ─────────────────── */

/** This library's random id (the marker in each of its work folders), made on first use. */
function _libraryId() {
  let id = store.kvGet('library_id');
  if (!id || !temp.LIBRARY_ID_RX.test(id)) {
    id = crypto.randomBytes(16).toString('hex');
    store.kvSet('library_id', id);
  }
  return id;
}

/** Does this share need no local files any more? */
function _wantsNoFiles(row) {
  return NO_FILES.has(row.status) || (row.status === 'uploaded' && !row.keep_local);
}

/** Is an action, an upload or a packing job of this share running? */
function _busy(id) {
  const j = _jobs.get(id);
  return _locks.has(id) || !!(j && (j.running || j.packing || j.queued || j.packQueued));
}

/** Forget a work folder's name on the record: only once the folder is gone. */
function _forgetWorkDir(id, name) {
  const cur = store.getShare(id);
  if (cur && cur.work_dir === name) store.updateShare(id, { work_dir: null });
}

/**
 * Delete a share's work folder. Gone: the record forgets it. Not gone: the
 * record keeps it and the clean-up tries again. Returns true when gone.
 */
async function _dropWorkDir(id, name) {
  if (!name) return true;
  const gone = await temp.removeWorkDir(name);
  if (!gone) { _cleanupWanted = true; return false; }
  _w(() => _forgetWorkDir(id, name));
  return true;
}

/** Start a clean-up pass when one is wanted (at most every CLEANUP_EVERY_MS unless forced). */
function _maybeCleanup({ force = false } = {}) {
  if (_cleaning) return _cleaning;
  if (vault.isLocked()) return null;
  if (!force && (!_cleanupWanted || Date.now() - _lastCleanup < CLEANUP_EVERY_MS)) return null;
  _lastCleanup = Date.now();
  _cleaning = _cleanupPass()
    .catch((err) => {
      _cleanupWanted = true;
      console.warn(`[Share] clean-up stopped (${err && err.code ? err.code : 'error'})`);
    })
    .finally(() => { _cleaning = null; });
  return _cleaning;
}

/**
 * One clean-up pass. Never while locked (it stops at the lock), never on a
 * share something else is working on. Leaves _cleanupWanted set when
 * anything is left for a later pass.
 */
async function _cleanupPass() {
  _cleanupWanted = false;
  let left = false;
  const stopHere = () => { if (vault.isLocked()) { left = true; return true; } return false; };
  for (const row of store.listShares()) {
    if (stopHere()) break;
    if (_busy(row.id)) {
      if (row.work_dir && _wantsNoFiles(row)) left = true;
      continue;
    }
    if (!row.work_dir) {
      if (row.status === 'removing') { store.deleteShare(row.id); _jobs.delete(row.id); }
      continue;
    }
    if (!_wantsNoFiles(row)) {
      // A share that still needs its archive: only what 7-Zip read goes.
      if (!(await temp.removeScratch(row.work_dir))) left = true;
      continue;
    }
    const gone = await temp.removeWorkDir(row.work_dir);
    if (stopHere()) break;
    if (!gone) { left = true; continue; }
    const cur = store.getShare(row.id);
    if (!cur || cur.work_dir !== row.work_dir || _busy(row.id)) continue;
    if (cur.status === 'removing') { store.deleteShare(row.id); _jobs.delete(row.id); }
    else store.updateShare(row.id, { work_dir: null });
  }
  // Work folders no record names (a crash, an exit while locked): only this
  // library's, by the marker inside. Without a library id this library never
  // made a marked folder.
  const lib = stopHere() ? null : store.kvGet('library_id');
  if (lib) {
    const named = (name) => {
      for (const j of _jobs.values()) if (j.workDir === name) return true;
      return store.listShares().some(r => r.work_dir === name);
    };
    for (const name of temp.listWorkDirs()) {
      if (stopHere()) break;
      if (temp.readLibraryMarker(name) !== lib || named(name)) continue;
      if (!(await temp.removeWorkDir(name))) left = true;
    }
  }
  if (left) _cleanupWanted = true;
}

/** Did a first part of this share lose its answer after being sent (see UNKNOWN_FOLDER)? */
function _unknownFolder(row) {
  const job = _jobs.get(row.id);
  return !!(job && job.unknownFolder) || (typeof row.last_error === 'string' && row.last_error.includes(UNKNOWN_FOLDER));
}

/**
 * A first part was sent in full but its answer never came (time limit). Kept
 * in the job and on the row (after the unlock if need be), so a stop does not
 * report a clean cancel.
 */
function _noteUnknownFolder(id, job) {
  job.unknownFolder = true;
  _record(() => {
    const cur = store.getShare(id);
    if (cur && !cur.folder_id && cur.status !== 'removing') store.updateShare(id, { last_error: UNKNOWN_FOLDER });
  });
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

/** The share a waiting share comes after ("Starts when <name> is packed"), as "<name>.7z", or null. */
function _packAheadName(id) {
  const i = _packQueue.indexOf(id);
  const ahead = i > 0 ? _packQueue[i - 1] : i === 0 ? _packActive : null;
  if (ahead === null || ahead === undefined) return null;
  const r = store.getShare(ahead);
  return r && r.status !== 'removing' ? _archiveDisplayName(r) : null;
}

/** Packing progress of a share being packed: { phase, percent }. */
function _packView(row) {
  const job = _jobs.get(row.id);
  return { phase: (job && job.phase) || 'staging', percent: (job && job.percent) || 0 };
}

/** An upload in short, for My shares and the top bar: { percent, partNo, partCount }. */
function _uploadView(row) {
  const parts = _partsView(row);
  const total = parts.reduce((n, p) => n + p.sizeBytes, 0);
  const going = parts.find(p => p.status === 'uploading');
  const done = parts.filter(p => p.status === 'done').length;
  return {
    percent: total ? Math.floor(parts.reduce((n, p) => n + p.sizeBytes * p.percent / 100, 0) / total * 100) : 0,
    partNo: going ? going.partNo : Math.min(parts.length, done + 1),
    partCount: parts.length,
  };
}

/** The share's note: the row's, or (a failed share, while Vault runs) the one kept in memory with a file name. */
function _errorShown(row) {
  const job = _jobs.get(row.id);
  if (row.status === 'failed' && job && job.errorShown) return job.errorShown;
  return row.last_error || null;
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
    error: _errorShown(row),
    passwordKind: row.password_kind,
    passwordKept: row.password != null || !!(job && job.password),
    accountThisSession: !!(row.account_id && (store.getAccount(row.account_id) || {}).session === SESSION),
    onGofile: !!row.folder_id && (MAY_BE_ONLINE.includes(row.status) || row.status === 'stopping'),
    canResume: ['paused', 'not_finished'].includes(row.status) && !(job && (job.running || job.queued)),
    // The pack line and the badges in My shares (all null when they do not apply).
    packing: row.status === 'packing' ? _packView(row) : null,
    waitingFor: row.status === 'queued' ? _packAheadName(row.id) : null,
    uploadsOnItsOwn: !!(job && job.autoUpload),
    upload: row.status === 'uploading' ? { ..._uploadView(row), waitingInLine: !!(job && job.queued) } : null,
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
    error: _errorShown(row),
    packing: row.status === 'packing' ? _packView(row) : null,
    waitingFor: row.status === 'queued' ? _packAheadName(row.id) : null,
    uploadsOnItsOwn: !!(job && job.autoUpload),
    checks,
    upload: parts.length && !['queued', 'packing', 'checked'].includes(row.status) ? {
      bytesDone: done, bytesTotal: total, percent: total ? Math.floor((done / total) * 100) : 0,
      partsAtOnce: job ? job.concurrency : null,
      waitingInLine: !!(job && job.queued),
      parts,
    } : null,
    link: row.link || null,
  };
}

/*
 * The one-time warning about secrets kept in an unencrypted library file
 * (spec 6.5). With no Vault password the library file is not encrypted, and
 * what Share privately keeps there (the saved password; with "Passwords of
 * past shares" on, each share's password; and every share's link and upload
 * key) can be read by anyone who can open the file. Before the first of these
 * is stored, the request must say the user saw the warning
 * (acknowledgeNoVaultPassword: true), or it is refused with WARNING_NEEDED
 * and nothing is stored. One warning, shown once, covers both cases: setting
 * the saved password and making a share while passwords are remembered.
 * The flag is a new key: the older 'warning_shown' was given for a narrower
 * text (the saved password only), so it does not count.
 */
const PLAIN_WARNING_KEY = 'plain_warning_shown';
const PLAIN_WARNING_MESSAGE = 'There is no Vault password, so passwords, links and upload keys of shares would be stored unprotected in the library file. Confirm that first.';

function _plainWarningNeeded() {
  return !gate.required() && store.kvGet(PLAIN_WARNING_KEY) !== '1';
}

/** Throws WARNING_NEEDED unless acknowledged; marks it shown when it was. */
function _plainWarning(acknowledged) {
  if (!_plainWarningNeeded()) return;
  if (acknowledged !== true) throw _err('WARNING_NEEDED', PLAIN_WARNING_MESSAGE);
  store.kvSet(PLAIN_WARNING_KEY, '1');
}

function savedPasswordStatus() {
  ensureRecovered();
  return {
    set: !!store.kvGet('saved_password'),
    vaultPasswordSet: gate.required(),
    warningNeeded: _plainWarningNeeded(),
  };
}

function state() {
  ensureRecovered();
  const s = settings.get();
  const rows = _listed();
  const busy = rows.filter(r => ['packing', 'uploading', 'paused', 'not_finished'].includes(r.status));
  let failedParts = 0;
  for (const r of rows) {
    if (['uploading', 'paused', 'not_finished'].includes(r.status)) {
      failedParts += store.getParts(r.id).filter(p => p.status === 'failed').length;
    }
  }
  const first = busy[0] || null;
  // What runs now, for the popup: the pack, and the upload (else the first
  // paused or unfinished one, which needs the user).
  const packRow = rows.find(r => r.id === _packActive && r.status === 'packing') || rows.find(r => r.status === 'packing') || null;
  const upRow = rows.find(r => r.id === _active && r.status === 'uploading') || rows.find(r => r.status === 'uploading')
    || rows.find(r => ['paused', 'not_finished'].includes(r.status)) || null;
  const packWaiting = rows.filter(r => r.status === 'queued').length;
  const readyToCheck = rows.filter(r => r.status === 'checked').length;
  // active: something is running or needs the user (the page's Activity
  // button then has a Share privately section). show: active, or the feature
  // is on (the page offers My shares under the Activity list).
  const active = busy.length > 0 || failedParts > 0 || packWaiting > 0 || readyToCheck > 0;
  return {
    enabled: s.enabled,
    offline: !!(config.net && config.net.offline),
    // With the feature off nothing is looked for or started (the version
    // check runs the program): null, not false, so the page shows nothing.
    sevenZipFound: s.enabled ? !!(_program || sevenzip.locate()) : null,
    settings: s,
    savedPassword: savedPasswordStatus(),
    shareCount: rows.length,
    topBar: {
      show: active || s.enabled,
      active,
      needsYou: failedParts,
      shareId: first ? first.id : null,
      archiveName: first ? first.archive_name : null,
      status: first ? _displayStatus(first) : null,
      percent: first ? progressPercent(first) : null,
      packing: packRow ? { shareId: packRow.id, archiveName: packRow.archive_name, ..._packView(packRow) } : null,
      upload: upRow ? {
        shareId: upRow.id, archiveName: upRow.archive_name, status: _displayStatus(upRow), error: upRow.last_error || null,
        ..._uploadView(upRow), waitingInLine: !!((_jobs.get(upRow.id) || {}).queued),
      } : null,
      packWaiting,
      readyToCheck,
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
    out.push({ mediaId: id, filepath: r.filepath, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
  }
  return out;
}

/**
 * Free space the pack line will still take before a new share's turn: every
 * share waiting to pack, and what the running pack has still to write (its
 * whole need while staging, the part not yet written while packing, nothing
 * while checking). An estimate for the check at start; the check when its
 * turn comes measures the disk again (THE PACK LINE at the top).
 */
function _packNeedAhead() {
  let n = 0;
  for (const id of _packQueue) {
    const j = _jobs.get(id);
    if (j && j.plan) n += j.plan.needBytes;
  }
  const head = _packActive !== null ? _jobs.get(_packActive) : null;
  if (head && head.needBytes) {
    if (head.phase === 'staging' || head.phase === 'cleaning') n += head.needBytes;
    else if (head.phase === 'packing') n += Math.ceil(head.needBytes * Math.max(0, 100 - (head.percent || 0)) / 100);
  }
  return n;
}

const NO_SPACE_MESSAGE = 'There is not enough free space to pack these files.';
const NO_SPACE_CLEAN = 'There was not enough free space for the cleaned copies of the files that carry personal details, so this share was not packed. Nothing was uploaded. Free some space and start it again.';
// "Vault could not remove personal details from <name>, so ..." (the page
// blurs the name in privacy mode by these words).
const CLEAN_FAILED_START = 'Vault could not remove personal details from ';
const CLEAN_FAILED_END = ', so this share was not packed. Nothing was uploaded. Your own file was not changed.';
// "Vault could not check <name> for personal details, so ..." (blurred the
// same way): with Remove on, a file of a type Vault checks whose check
// failed is never packed as if it were clean.
const CHECK_FAILED_START = 'Vault could not check ';
const CHECK_FAILED_END = ' for personal details, so this share was not packed. Nothing was uploaded. To pack it without the check, start the share again and turn off Remove under Personal details.';
// Without ffprobe and ffmpeg (meta.toolsReady): step 1's note, and the two
// ways a share that was to have its details removed is refused or stopped
// when they went missing after step 1 said they were there. Neither says or
// suggests that anything was removed; nothing is uploaded either way.
const NO_FFMPEG_CHECK = 'Vault needs ffmpeg to check files for personal details. They are packed as they are.';
const NO_FFMPEG_START = 'Vault can no longer find ffmpeg, so it cannot remove personal details. Nothing was packed. Press Pack files again to pack the files as they are.';
const NO_FFMPEG_PACK = 'Vault could not find ffmpeg, so it could not remove personal details and this share was not packed. Nothing was uploaded. Start the share again to pack the files as they are.';
const CHANGED_WHILE_PACKED = 'A picked file changed while this share was being packed, so it was not kept. Nothing was uploaded. Start the share again.';
const NO_SPACE_QUEUED = 'There is not enough free space to pack these files as well as the shares already waiting to be packed.';

function preview({ mediaIds }) {
  ensureRecovered();
  _requireOn();
  const s = settings.get();
  const files = _mediaFiles(mediaIds);
  const p = pack.plan(files, { partBytes: settings.partBytes(s) });
  const free = temp.freeBytes();
  const ahead = _packNeedAhead();
  return {
    files: p.entries.map((e, i) => ({ mediaId: e.mediaId, name: path.basename(files[i].filepath), nameInArchive: e.archiveName, sizeBytes: e.size })),
    totalBytes: p.totalBytes,
    needBytes: p.needBytes,
    freeBytes: free,
    enoughSpace: free === null ? null : free >= p.needBytes + ahead,
    missingBytes: free === null ? null : Math.max(0, p.needBytes + ahead - free),
    // Another share is packing (or waiting): this one waits its turn.
    packBusy: _packActive !== null || _packQueue.length > 0,
    afterPack: s.afterPack,
    split: p.split,
    partBytes: p.partBytes,
    partCount: p.parts,
    passwordChoice: s.passwordChoice,
    deleteAfterDays: s.deleteAfterDays,
    savedPasswordSet: !!store.kvGet('saved_password'),
    sevenZipFound: !!(_program || sevenzip.locate()),
    // Can the files be checked for personal details (ffprobe and ffmpeg
    // there, meta.toolsReady)? Read afresh for every share window.
    personalCheckReady: meta.toolsReady(),
  };
}

/* ── Step 1: the personal details check (PERSONAL DETAILS at the top) ───── */

const CHECK_ID_RX = /^[0-9a-f]{24}$/;

/**
 * Start checking the picked files (every share; there is no setting to turn
 * it off). Answers where the check is (metaCheckStatus).
 */
function metaCheck({ mediaIds }) {
  ensureRecovered();
  _requireOn();
  // Without ffprobe and ffmpeg there is no check to run (step 1 then shows
  // the box greyed, and the files are packed as they are).
  if (!meta.toolsReady()) throw _err('PERSONAL_CHECK_OFF', NO_FFMPEG_CHECK);
  const s = settings.get();
  const files = _mediaFiles(mediaIds);
  const id = meta.startCheck(files.map(f => ({ path: f.filepath, size: f.size, mtimeMs: f.mtimeMs, mediaId: f.mediaId })),
    { partBytes: settings.partBytes(s) });
  return metaCheckStatus(id);
}

/**
 * Where a step 1 check is: { id, done, checked, total }, and once done, the
 * flagged files with what was found (files, personalCount), the files whose
 * check failed (failedFiles: [{ mediaId }], failedCount: a type Vault checks,
 * so with Remove on the share fails for them unless their check at the
 * pack's turn works), how many
 * are of a type Vault does not read (uncheckedCount: packed as they are),
 * and the free space with the cleaned copies counted. Only the page that
 * started it knows its id; it is in memory only and goes on a lock.
 */
function metaCheckStatus(id) {
  ensureRecovered();
  _requireOn();
  const st = typeof id === 'string' && CHECK_ID_RX.test(id) ? meta.checkStatus(id) : null;
  if (!st) throw _err('NOT_FOUND', 'That check is no longer there. Open the share window again.');
  const out = { id, done: st.done, checked: st.checked, total: st.total };
  if (!st.done) return out;
  const files = st.files.map(f => ({ mediaId: f.mediaId, filepath: f.path, size: f.size }));
  const base = pack.plan(files, { partBytes: st.extra ? st.extra.partBytes : null });
  const flags = st.results.map(r => !!r && r.status === 'personal');
  const cleaned = pack.withClean(base, flags);
  const free = temp.freeBytes();
  const ahead = _packNeedAhead();
  out.files = st.results.map((r, i) => (flags[i] ? { mediaId: st.files[i].mediaId, findings: r.findings } : null)).filter(Boolean);
  out.personalCount = out.files.length;
  // A result missing or failed is never taken as clean: it is a failed check.
  out.failedFiles = st.results.map((r, i) => (!r || r.status === 'failed' ? { mediaId: st.files[i].mediaId } : null)).filter(Boolean);
  out.failedCount = out.failedFiles.length;
  out.uncheckedCount = st.results.filter(r => !!r && r.status === 'unchecked').length;
  // The extra space the cleaned copies take, and the totals with them.
  out.extraBytes = Math.max(0, cleaned.needBytes - base.needBytes);
  out.needBytes = cleaned.needBytes;
  out.enoughSpace = free === null ? null : free >= cleaned.needBytes + ahead;
  out.missingBytes = free === null ? null : Math.max(0, cleaned.needBytes + ahead - free);
  return out;
}

function _requireOn() {
  if (!settings.isEnabled()) throw _err('FEATURE_OFF', 'Share privately is turned off. Turn it on in Settings first.');
}

/** VAULT_OFFLINE blocks the action: 'upload', 'delete' or 'timer' (for the message). */
function _requireOnline(action) {
  if (config.net && config.net.offline) throw _err('NET_OFF', netOffMessage(action));
}

/**
 * Step 1 -> packing, or 'queued' while another share packs (THE PACK LINE).
 * Returns the new share; packing and the checks run on.
 * With no Vault password and "Passwords of past shares" on, the first share
 * needs acknowledgeNoVaultPassword: true (WARNING_NEEDED otherwise, checked
 * after every other check and before anything is stored).
 * confirmUpload: true is the step 1 tick box for "Upload on its own"; it
 * counts only while afterPack is 'upload' (UPLOAD ON ITS OWN at the top).
 * Without it the share waits for the user once checked, whatever the setting.
 * @param {{mediaIds:number[], name?:string, passwordChoice?:'random'|'saved', deleteAfterDays?:number, acknowledgeNoVaultPassword?:boolean, confirmUpload?:boolean}} o
 */
function start({ mediaIds, name, passwordChoice, deleteAfterDays, acknowledgeNoVaultPassword, confirmUpload, removePersonal }) {
  ensureRecovered();
  _requireOn();
  if (!(_program || sevenzip.locate())) throw _err('SEVENZIP_MISSING', 'Vault could not find its 7-Zip program, so it cannot pack files.');
  const s = settings.get();
  const files = _mediaFiles(mediaIds);
  const partBytes = settings.partBytes(s);
  // Personal details: always checked, and removed unless the page says
  // exactly false (the step 1 switch turned off for this share). Nothing
  // sent, or anything else, means remove. Which files get a cleaned copy is
  // decided at the pack's turn by the server's own check, never by the page.
  // Without ffprobe and ffmpeg there is no check: step 1 showed the box
  // greyed with its Remove switch off, and that page sends false, so the
  // files are packed as they are. A request that still asks for removal
  // (step 1 was drawn while they were there) is refused before anything is
  // stored, never packed as is behind the user's back; the page then shows
  // the greyed box and Pack files sends false. Pinned here for the pack's
  // turn (job.removePersonal), so ffmpeg turning up later changes nothing.
  const ready = meta.toolsReady();
  if (removePersonal !== false && !ready) throw _err('PERSONAL_CHECK_OFF', NO_FFMPEG_START);
  const clean = ready && removePersonal !== false;
  let p = pack.plan(files, { partBytes });
  if (clean) {
    // The space at start counts the copies step 1 found, and every file not
    // checked yet as one that may need a copy; the turn measures it exactly.
    const est = pack.withClean(p, files.map((f) => {
      const r = meta.cached({ path: f.filepath, size: f.size, mtimeMs: f.mtimeMs });
      return !r || r.status === 'personal';
    }));
    p = { ...p, needBytes: est.needBytes };
  }
  const free = temp.freeBytes();
  const ahead = _packNeedAhead();
  if (free !== null && free < p.needBytes + ahead) {
    throw _err('NO_SPACE', ahead ? NO_SPACE_QUEUED : NO_SPACE_MESSAGE, { missingBytes: p.needBytes + ahead - free, needBytes: p.needBytes + ahead });
  }

  let archiveName = '';
  let typed = false;
  if (typeof name === 'string' && name.trim()) {
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
  if (s.rememberPasswords) _plainWarning(acknowledgeNoVaultPassword);

  // Packs now when the line is free (the work folder made first, as before:
  // a folder that cannot be made refuses the share), else waits its turn
  // with no work folder yet.
  const now = _packActive === null && _packQueue.length === 0;
  const wd = now ? temp.createWorkDir(_libraryId()) : null;
  const id = store.insertShare({
    archive_name: archiveName, name_typed: typed ? 1 : 0,
    password: s.rememberPasswords ? password : null, password_kind: choice,
    size: p.totalBytes, part_count: p.parts, part_size: p.partBytes, file_count: files.length,
    status: now ? 'packing' : 'queued', created_at: _now(), delete_after_days: days, work_dir: wd ? wd.name : null,
    keep_local: s.keepLocal ? 1 : 0,
  });
  if (s.rememberFiles) {
    store.setFiles(id, p.entries.map(e => ({ fileName: e.archiveName, size: e.size, mediaId: e.mediaId })));
  }
  const job = _job(id);
  job.password = password;
  job.plan = p;
  job.archiveName = archiveName;
  job.autoUpload = s.afterPack === 'upload' && confirmUpload === true;
  job.removePersonal = clean;
  job.handle = { cancelled: false, kill: null };
  job.phase = now ? 'staging' : null;
  job.percent = 0;
  if (now) {
    _sawPack(job);   // the user started it
    _beginPack(id, wd);
  } else {
    _saw(job);
    job.packQueued = true;
    _packQueue.push(id);
  }
  return publicShare(store.getShare(id));
}

/** The share's turn: 7-Zip runs for it. The line takes the next one when it ends. */
function _beginPack(id, wd) {
  const job = _job(id);
  const plan = job.plan;
  job.plan = null;   // the pack holds it from here
  job.packQueued = false;
  job.workDir = wd.name;
  job.needBytes = plan.needBytes;
  job.phase = 'staging';
  job.percent = 0;
  _packActive = id;
  job.packing = _runPack(id, { plan, workDir: wd.dir, archiveName: job.archiveName, password: job.password })
    .finally(() => {
      job.packing = null;
      if (_packActive === id) _packActive = null;
      _pumpPack();
    });
}

/**
 * The next share waiting to pack, when the line is free. Its files and the
 * free space are looked at again first (THE PACK LINE at the top); a share
 * that cannot be packed now fails with a plain message and the next one
 * takes its turn. Nothing starts while the library is locked (the lock
 * cancels every waiting share anyway).
 */
function _pumpPack() {
  while (_packActive === null && _packQueue.length) {
    if (vault.isLocked()) return;
    const id = _packQueue.shift();
    const job = _jobs.get(id);
    if (!job || !job.packQueued || (job.handle && job.handle.cancelled)) { _wipePackSecrets(job); continue; }
    job.packQueued = false;
    // Taking its turn is not evidence: it goes on from the pack line's last
    // real evidence (or its own start, if later), never from now.
    job.seenAt = Math.min(Math.max(job.seenAt, _packSeenAt), _now());
    let row = null;
    try { row = store.getShare(id); } catch { row = null; }
    if (!row || row.status !== 'queued' || !job.plan) { _wipePackSecrets(job); continue; }
    const why = _packTurnProblem(job.plan);
    if (why) { _failQueued(id, job, why); continue; }
    let wd = null;
    try {
      wd = temp.createWorkDir(_libraryId());
      store.updateShare(id, { status: 'packing', work_dir: wd.name });
    } catch (err) {
      if (wd) temp.removeWorkDir(wd.name).catch(() => {});
      _failQueued(id, job, err && err.code === 'TEMP_NOT_OWNED' && err.message
        ? err.message : 'Vault could not make a work folder to pack this share, so it was not packed. Nothing was uploaded.');
      continue;
    }
    _beginPack(id, wd);
  }
}

/** Why a waiting share cannot be packed now (plain words), or null. */
function _packTurnProblem(plan) {
  if (!settings.isEnabled()) return 'Share privately was turned off before this share\'s turn came, so it was not packed. Nothing was uploaded.';
  for (const e of plan.entries) {
    let st = null;
    try { st = fs.statSync(e.src); } catch { st = null; }
    // Its size and its modified time, both as they were when it was started.
    if (!st || !st.isFile() || st.size !== e.size || (e.mtimeMs != null && Math.trunc(st.mtimeMs) !== e.mtimeMs)) {
      return 'A picked file changed or is no longer there since this share was started, so it was not packed. Nothing was uploaded. Start the share again.';
    }
  }
  const free = temp.freeBytes();
  if (free !== null && free < plan.needBytes) {
    return 'When its turn came there was not enough free space left to pack this share, so it was not packed. Nothing was uploaded. Free some space and start it again.';
  }
  return null;
}

/** A waiting share that cannot be packed: failed, its secrets and plan gone from memory. */
function _failQueued(id, job, message) {
  _wipePackSecrets(job);
  if (job.handle) job.handle.cancelled = true;
  _w(() => {
    const cur = store.getShare(id);
    if (cur && cur.status === 'queued') store.updateShare(id, { status: 'failed', last_error: message });
  });
  _jobs.delete(id);
}

async function _runPack(id, { plan, workDir, archiveName, password }) {
  const job = _job(id);
  const fail = async (message) => {
    const name = path.basename(workDir);
    const gone = await temp.removeWorkDir(name);
    // Not gone: the record keeps the folder's name and the clean-up retries.
    if (!gone) _cleanupWanted = true;
    _w(() => store.updateShare(id, { status: 'failed', last_error: message, ...(gone ? { work_dir: null } : {}) }));
    _w(() => store.setParts(id, []));
    // Nothing of it will be uploaded: what it held in memory goes.
    job.autoUpload = false;
    job.password = null;
  };
  // A message that names a file: with "Which files were in each share" off
  // no file name is stored, so the row gets the words without it and the
  // page sees the name while Vault runs.
  const failNamed = async (start, end, fileName, { more = 0 } = {}) => {
    const name = typeof fileName === 'string' && fileName ? meta.shorten(meta.tidy(fileName), 120) : '';
    const others = more ? ` and ${more} more ${more === 1 ? 'file' : 'files'}` : '';
    const unnamed = more ? `${more + 1} of the files` : 'one of the files';
    const named = name ? `${start}${name}${others}${end}` : `${start}${unnamed}${end}`;
    if (settings.get().rememberFiles) await fail(named);
    else {
      job.errorShown = named;
      await fail(`${start}${unnamed}${end}`);
    }
  };
  let ids = null;
  try {
    let entries = plan.entries;
    let cleaner;
    const cleanSizes = new Map();
    if (job.removePersonal) {
      // ffprobe or ffmpeg went missing after the share started (it may have
      // waited its turn): the details cannot be removed, and packing the
      // files as they are would go against what step 1 showed. Stopped with
      // nothing packed, the way a failed check stops it.
      if (!meta.toolsReady()) { await fail(NO_FFMPEG_PACK); return; }
      // The server's own check of every file, as it is now (PERSONAL DETAILS).
      // A check that ran is a sign of life; a cached answer is not.
      job.phase = 'cleaning';
      job.percent = 0;
      ids = [];
      const results = await meta.checkNow(entries.map(e => e.src), { handle: job.handle, onFile: () => _sawPack(job), ids });
      if (job.handle.cancelled) return;
      // A file whose check failed (or did not happen) is never packed as if
      // it were clean: the share fails, naming it. Only a type Vault does
      // not read ('unchecked') goes in as it is, as step 1 said.
      const failedAt = results.findIndex(r => !r || r.status === 'failed');
      if (failedAt >= 0) {
        const more = results.filter(r => !r || r.status === 'failed').length - 1;
        await failNamed(CHECK_FAILED_START, CHECK_FAILED_END, entries[failedAt].archiveName, { more });
        return;
      }
      const flags = results.map(r => !!r && r.status === 'personal');
      if (flags.some(Boolean)) {
        const cleaned = pack.withClean(plan, flags);
        // Exactly, now: the cleaned copies are real copies even on the same drive.
        const free = temp.freeBytes();
        if (free !== null && free < cleaned.needBytes) {
          job.needBytes = cleaned.needBytes;
          await fail(NO_SPACE_CLEAN);
          return;
        }
        job.needBytes = cleaned.needBytes;
        const known = new Map(cleaned.entries.map((e, i) => [e, results[i]]));
        entries = cleaned.entries;
        cleaner = async (e, dst) => {
          await meta.cleanCopy({ src: e.src, dst, known: known.get(e), handle: job.handle, onActivity: () => _sawPack(job) });
          // The archive check expects the copy's own size.
          cleanSizes.set(e, fs.statSync(dst).size);
        };
      }
    }
    const parts = await pack.pack({
      entries, workDir, archiveName, password,
      partBytes: plan.partBytes, split: plan.split, handle: job.handle, program: _program || undefined,
      // What to show only: the start of a step (percent 0) is not work done.
      // Real work reports through onActivity (a file cleaned, linked or
      // copied, 7-Zip's output).
      onProgress: ({ phase, percent }) => { job.phase = phase; job.percent = percent; },
      onActivity: () => _sawPack(job),
      cleaner,
    });
    if (job.handle.cancelled) return;
    // Every file that went in as it is must still be the very file that was
    // checked (size, modified time, file id): one changed after its check
    // could hold anything.
    if (ids) {
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].clean) continue;
        const now = await meta.fileId(entries[i].src);
        if (!now || now.content !== ids[i]) { await fail(CHANGED_WHILE_PACKED); return; }
      }
    }
    _w(() => store.updateShare(id, { part_count: parts.length, size: parts.reduce((n, q) => n + q.size, 0) }));
    _w(() => store.setParts(id, parts));
    job.phase = 'checking';
    job.percent = 0;
    _sawPack(job);
    const checks = await pack.runChecks({
      workDir, archiveName, password, parts, split: plan.split,
      expected: entries.map(e => (e.clean ? { archiveName: e.archiveName, size: cleanSizes.get(e) } : e)),
      handle: job.handle, program: _program || undefined,
      onActivity: () => _sawPack(job),
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
    // Upload on its own: through the same gates as the Upload button.
    if (job.autoUpload) _autoUpload(id);
  } catch (err) {
    if (job.handle && job.handle.cancelled) return;
    if (err && err.code === 'CLEAN_FAILED') {
      // The file's name in the archive (control characters already gone),
      // never anything found in it.
      await failNamed(CLEAN_FAILED_START, CLEAN_FAILED_END, err.fileName);
      return;
    }
    const plain = {
      PACK_FAILED: err.message, BAD_NAME: err.message, BAD_PASSWORD: err.message,
      SEVENZIP_MISSING: 'Vault could not find its 7-Zip program, so it cannot pack files.',
      SEVENZIP_CHANGED: 'Vault\'s 7-Zip program was changed after Vault was built, so Vault did not run it. Nothing was uploaded.',
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
      // Waiting to pack: out of the line, and what it held in memory goes.
      const qi = _packQueue.indexOf(row.id);
      if (qi >= 0) _packQueue.splice(qi, 1);
      job.packQueued = false;
      _wipePackSecrets(job);
    }
    if (job && job.packing) { try { await job.packing; } catch {} }
    // A share that never had its turn has no work folder.
    const gone = row.work_dir ? await temp.removeWorkDir(row.work_dir) : true;
    if (vault.isLocked()) throw _lockedErr();   // the unlock finishes it (the clean-up)
    _jobs.delete(row.id);
    // A folder that could not be deleted keeps its hidden 'removing' record:
    // the clean-up deletes the folder later, then the record.
    if (gone) store.deleteShare(row.id);
    else _cleanupWanted = true;
    return { removed: true };
  });
}

/* ── Step 3: confirm, and the upload job ────────────────────────────────── */

function _checksPassed(row) {
  try { return JSON.parse(row.checks || 'null')?.ok === true; } catch { return false; }
}

/** Async: runs in the share's queue (see the top of this file). */
function confirmUpload(id, { confirm } = {}) {
  return _serial(id, () => _confirmNow(id, { confirm }));
}

/**
 * The upload gates, run inside the share's queue. The Upload button
 * (confirmUpload) and Upload on its own (_autoUpload) both come through here.
 */
function _confirmNow(id, { confirm } = {}) {
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
    store.updateShare(row.id, { status: 'failed', last_error: 'The packed parts changed after the checks, so they were deleted. Nothing was uploaded.' });
    // The record forgets the folder only once it is gone (else the clean-up retries).
    _dropWorkDir(row.id, row.work_dir).catch(() => {});
    throw _err('PARTS_CHANGED', 'The packed parts changed after the checks, so they were deleted. Nothing was uploaded.');
  }
  store.updateShare(row.id, { status: 'uploading', last_error: null });
  const job = _jobs.get(row.id);
  if (job) job.autoUpload = false;
  _enqueue(row.id);
  return progress(row.id);
}

const AUTO_NOT = 'Packed and checked, but not uploaded on its own.';
const AUTO_NO_PASSWORD = `${AUTO_NOT} Vault is not keeping the password of this share, so look at it and copy it first, then upload.`;

/**
 * Can the user still get this share's password later, without this Vault
 * process? Stored with the share ("Passwords of past shares" on), or it is
 * the saved password and that is still the same one.
 */
function _passwordLasts(row, job) {
  if (row.password != null) return true;
  if (row.password_kind !== 'saved' || !job || !job.password) return false;
  const saved = store.kvGet('saved_password');
  return !!saved && saved === job.password;
}

/**
 * Upload on its own, once a share passed its checks (UPLOAD ON ITS OWN at
 * the top). In the share's queue, through _confirmNow with the confirm the
 * user gave at start, so every gate of the Upload button applies. When a gate
 * is not met, or Vault would be the only one keeping the password, the share
 * stays 'checked' ("Ready to check") and its note says why.
 */
function _autoUpload(id) {
  return _serial(id, () => {
    ensureRecovered();
    const job = _jobs.get(id);
    const row = _row(id);
    if (row.status !== 'checked' || !job || !job.autoUpload) return null;
    job.autoUpload = false;   // once: from here the user decides
    if (!_passwordLasts(row, job)) {
      store.updateShare(row.id, { last_error: AUTO_NO_PASSWORD });
      return null;
    }
    return _confirmNow(id, { confirm: true });
  }).catch((err) => {
    const job = _jobs.get(id);
    if (job) job.autoUpload = false;
    // Locked meanwhile: nothing is written; it waits for the user after the unlock.
    _w(() => {
      const cur = store.getShare(id);
      if (cur && cur.status === 'checked') store.updateShare(id, { last_error: `${AUTO_NOT} ${_plain(err).error}` });
    });
    return null;
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
  // Only confirmUpload and resume / Try again come here: the user asked for it.
  _sawUpload(job);
  _queue.push(id);
  _pump();
}

function _pump() {
  if (_active !== null || _queue.length === 0) return;
  const id = _queue.shift();
  const job = _job(id);
  job.queued = false;
  _active = id;
  job.runGen = job.gen;   // isWorking: only this generation's worker is work
  // Taking its turn is not evidence: the share goes on from the line's last
  // real evidence (or its own confirm, if later), never from now.
  // (Never later than now, should the clock have been set back.)
  job.seenAt = Math.min(Math.max(job.seenAt, _uploadSeenAt), _now());
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
  return _gofile('createAccount', { signal }).then(({ token }) => {
    let accId = null;
    // Stored, and linked to this share, so a Resume after a lock that came
    // while it was being made uses it instead of asking for another.
    const save = () => {
      accId = store.insertAccount(token, SESSION);
      const cur = store.getShare(row.id);
      if (cur && !cur.account_id && cur.status !== 'removing') store.updateShare(row.id, { account_id: accId });
    };
    if (!_record(save)) throw _err('STALE', 'Stopped.');
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
      const unknown = job.unknownFolder && !(store.getShare(id) || {}).folder_id;
      const note = unknown ? (message ? `${message} ${UNKNOWN_FOLDER}` : UNKNOWN_FOLDER) : message;
      store.updateShare(id, { status: 'paused', last_error: note || null });
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
        // ctrl aborts it only while its bytes are still going out (_uploadPart).
        r = await _uploadPart({
          token: account.token, filePath: path.join(dir, p.file_name), fileName: p.file_name, size: p.size,
          folderId,
          onBytes: (n) => { job.bytes.set(p.part_no, (job.bytes.get(p.part_no) || 0) + n); _sawUpload(job); },
        }, ctrl.signal);
        _sawUpload(job);   // gofile accepted the part
      } catch (err) {
        failure = err;
        // Only an answer gofile sent counts; a time limit, a dropped
        // connection or an abort does not (see the top of this file).
        if (err && err.answered === true) _sawUpload(job);
      } finally {
        release();
        job.controllers.delete(ctrl);
      }
      if (failure) {
        const err = failure;
        job.bytes.set(p.part_no, 0);
        // Sent in full without a folder yet, and no answer (time limit, or
        // the connection dropped): gofile may have made a folder Vault never
        // heard of. Noted whatever happened meanwhile, and not sent again by
        // itself (each try could leave one more); the user decides.
        const lost = !!err.bodySent && !folderId && ['NETWORK', 'ABORTED'].includes(err.code);
        if (lost) _noteUnknownFolder(id, job);
        guard();   // ended meanwhile: STALE, nothing written
        if (halted() || ctrl.signal.aborted) throw _err('ABORTED', 'Stopped.');
        if (STOP_ALL.has(err.code)) throw err;
        if (lost) {
          _w(() => store.updatePart(id, p.part_no, { status: 'failed', tries: (p.tries || 0) + tries + 1, error: PART_FAIL_MESSAGES[err.code] || 'This part failed.' }));
          return false;
        }
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
      // Locked: written on unlock, and kept on disk until then.
      _recordPart(id, dir, { partNo: p.part_no, folderId: r.folderId, fileId: r.fileId, code: r.code, link: r.link, md5: r.md5 });
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
  const seen = () => { const j = _jobs.get(id); if (j) _sawUpload(j); };
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
        await _gofile('setExpiry', { token: account.token, folderId: row.folder_id, expiresAtSec: Math.floor(deleteAt / 1000), signal });
        timerSet = 1;
        seen();   // gofile answered
      } catch (err) {
        if (err && err.answered === true) seen();   // an error answer; a time limit is not one
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
    await _dropWorkDir(id, row.work_dir);
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
    const unknownBefore = _unknownFolder(row);
    _invalidate(job);
    store.updateShare(row.id, { status: 'stopping', last_error: unknownBefore ? UNKNOWN_FOLDER : null });
    // A part whose bytes were all sent is answered first (_uploadPart): its
    // folder is then on record and deleted below.
    await _settle(job);
    if (vault.isLocked()) throw _lockedErr();   // the unlock settles it (_settleOrphans)
    const cur = store.getShare(row.id);
    const note = (unknownBefore || _unknownFolder(cur)) ? UNKNOWN_FOLDER : null;
    let remoteError = null;
    if (cur.folder_id) {
      try {
        await _deleteRemoteRow(cur);
      } catch (err) {
        remoteError = err;
      }
    }
    // The folder's name stays on the record until the folder is gone
    // (_dropWorkDir, or the clean-up).
    const cancelled = () => {
      const now = store.getShare(row.id);
      if (!now || now.status !== 'stopping') return false;
      store.updateShare(row.id, { status: 'cancelled', deleted_at: _now(), last_error: note });
      store.pruneAccounts(store.latestAccount(SESSION)?.id ?? null);
      return true;
    };
    if (vault.isLocked()) {
      // gofile deleted it: on record after the unlock. Otherwise the unlock
      // ends it 'failed' with Delete offered (_settleOrphans). The folder
      // goes with the clean-up after the unlock.
      _cleanupWanted = true;
      if (cur.folder_id && (!remoteError || remoteError.code === 'NOT_FOUND')) _record(cancelled);
      throw _lockedErr();
    }
    const gone = await temp.removeWorkDir(cur.work_dir);
    if (!gone) _cleanupWanted = true;
    if (vault.isLocked()) {
      if (!remoteError || remoteError.code === 'NOT_FOUND') _record(cancelled);
      throw _lockedErr();
    }
    if (remoteError && remoteError.code !== 'NOT_FOUND') {
      const why = remoteError.code === 'NET_OFF'
        ? 'Stopped. Vault is set to stay offline (VAULT_OFFLINE=1), so the uploaded parts could not be deleted from gofile yet. Use Delete in My shares once Vault may go online.'
        : `Stopped. The uploaded parts could not be deleted from gofile yet: ${_plain(remoteError).error} Use Delete in My shares.`;
      store.updateShare(row.id, { status: 'failed', ...(gone ? { work_dir: null } : {}), last_error: note ? `${why} ${UNKNOWN_FOLDER}` : why });
      throw Object.assign(remoteError, { stopped: true });
    }
    cancelled();
    if (gone) _forgetWorkDir(row.id, cur.work_dir);
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
  await _gofile('deleteContent', { token: acc.token, folderId: row.folder_id });
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
        if (vault.isLocked()) throw _lockedErr();
        if (!['FEATURE_OFF', 'NET_OFF'].includes(err.code)) {
          store.updateShare(row.id, { last_error: `Could not delete from gofile: ${_plain(err).error}` });
        }
        throw err;
      }
      gone = true;
    }
    // gofile no longer has it: on record whatever happens next, after the
    // unlock if the library was locked meanwhile.
    // The folder's name stays on the record until the folder is gone.
    const done = () => {
      const cur = store.getShare(row.id);
      if (!cur || !MAY_BE_ONLINE.includes(cur.status) || cur.folder_id !== row.folder_id) return false;
      store.updateShare(row.id, {
        status: gone ? 'gone' : 'deleted', deleted_at: _now(),
        last_error: gone ? 'gofile said it was already gone.' : null,
      });
      _jobs.delete(row.id);
      store.pruneAccounts(store.latestAccount(SESSION)?.id ?? null);
      return true;
    };
    if (vault.isLocked()) {
      _cleanupWanted = true;   // the folder goes with the clean-up after the unlock
      _record(done);
      throw _lockedErr();
    }
    const folderGone = await temp.removeWorkDir(row.work_dir);
    if (!folderGone) _cleanupWanted = true;
    if (vault.isLocked()) { _record(done); throw _lockedErr(); }
    done();
    if (folderGone) _forgetWorkDir(row.id, row.work_dir);
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
    // Locked meanwhile: nothing more is sent (what was deleted is on record).
    if (vault.isLocked()) throw _lockedErr();
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
  if (vault.isLocked()) throw _lockedErr();
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
    if (['uploading', 'queued', 'packing', 'stopping'].includes(row.status) || (job && (job.running || job.packing || job.packQueued))) {
      throw _err('WRONG_STATE', 'This share is busy. Stop it first.');
    }
    const mayBeOnline = !!row.folder_id && MAY_BE_ONLINE.includes(row.status) && _displayStatus(row) !== 'expired';
    if (mayBeOnline && confirm !== true) {
      throw _err('STILL_ONLINE', 'This upload may still be on gofile. Once it is off the list, Vault cannot delete it for you.');
    }
    // Durable before the first await (see cancel).
    store.updateShare(row.id, { status: 'removing' });
    if (job) _invalidate(job);
    const gone = await temp.removeWorkDir(row.work_dir);
    if (vault.isLocked()) throw _lockedErr();
    _jobs.delete(row.id);
    // Not gone: the hidden 'removing' record stays until the clean-up has
    // deleted the folder (see cancel).
    if (gone) store.deleteShare(row.id);
    else _cleanupWanted = true;
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
    try {
      await _gofile('setExpiry', { token: acc.token, folderId: row.folder_id, expiresAtSec: Math.floor(row.delete_after / 1000) });
    } catch (err) {
      if (vault.isLocked()) throw _lockedErr();
      throw err;
    }
    // gofile has the timer: on record, after the unlock if need be.
    const done = () => {
      const cur = store.getShare(row.id);
      if (cur && cur.status === 'uploaded' && cur.folder_id === row.folder_id) store.updateShare(row.id, { timer_set: 1, last_error: null });
    };
    if (vault.isLocked()) { _record(done); throw _lockedErr(); }
    done();
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
  const next = random === true ? names.randomPassword() : _validSavedPassword(password);
  _plainWarning(acknowledgeNoVaultPassword);
  store.kvSet('saved_password', next);
  return { set: true, password: next };
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
  // What the personal details check found goes with the feature.
  if (next.enabled === false) meta.forget();
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

// The automatic lock waits while a share is working (isWorking). A manual
// lock does not: it goes through the 'locking' handler below.
vault.registerAutolockHold('share', isWorking);

vault.onChange((e) => {
  if (e === 'unlocked') {
    _lockAc = new AbortController();
    // Records that came in while locked, then any action the lock cut short,
    // then folders left to delete.
    _flushPending();
    _orphans = true;
    _cleanupWanted = true;
    _lastCleanup = 0;
    return;
  }
  if (e !== 'locking') return;
  _orphans = true;
  // What the personal details check found is about the library: gone at once.
  meta.forget();
  // Accounts, deletes and timers in flight are aborted (their answers, if
  // gofile still gives one, are recorded on unlock). Nothing new is sent:
  // _gofile and _uploadPart refuse while locked.
  try { _lockAc.abort(); } catch {}
  // The database is still open during 'locking': write the pauses now.
  // Shares waiting to pack are cancelled like a running pack: hidden at once,
  // their password and file list gone from memory (no work folder yet; the
  // clean-up after the unlock drops the record).
  _packQueue.length = 0;
  for (const job of _jobs.values()) {
    if (job.packQueued) {
      job.packQueued = false;
      if (job.handle) job.handle.cancelled = true;
      _wipePackSecrets(job);
      _cleanupWanted = true;
      try { if (store.getShare(job.id)) store.updateShare(job.id, { status: 'removing' }); } catch {}
      continue;
    }
    if (job.packing && job.handle) {
      job.handle.cancelled = true;
      if (job.handle.kill) job.handle.kill();
      const row = (() => { try { return store.getShare(job.id); } catch { return null; } })();
      _cleanupWanted = true;
      if (row) {
        // Hidden at once; the record goes only once its folder is gone (the
        // clean-up after the unlock, or the next unlocked start).
        try { store.updateShare(job.id, { status: 'removing' }); } catch {}
        const wd = row.work_dir;
        job.packing.finally(() => temp.removeWorkDir(wd)).catch(() => {});
      }
      _wipePackSecrets(job);
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

/* ── Exit ───────────────────────────────────────────────────────────────── */

/**
 * Vault is closing (server/index.js shutdown hook): a running 7-Zip is
 * stopped (it would otherwise go on reading the library and writing into
 * share_temp after Vault is gone) and the folders of shares being packed
 * are deleted when possible. No database write: the next start finds those
 * records 'packing' (or 'queued') and the clean-up removes what is left.
 * @param {{waitMs?:number}} o  how long to wait for 7-Zip to end
 */
async function shutdown({ waitMs = 3000 } = {}) {
  meta.forget();
  // Shares waiting to pack never start: out of the line, secrets wiped. They
  // have no work folder; their 'queued' records go on the next start.
  for (const id of _packQueue.splice(0)) {
    const j = _jobs.get(id);
    if (!j) continue;
    j.packQueued = false;
    if (j.handle) j.handle.cancelled = true;
    _wipePackSecrets(j);
  }
  const waits = [];
  for (const job of _jobs.values()) {
    if (!job.packing || !job.handle) continue;
    job.handle.cancelled = true;
    try { if (job.handle.kill) job.handle.kill(); } catch {}
    _wipePackSecrets(job);
    const name = job.workDir;
    waits.push(Promise.race([job.packing.catch(() => {}), new Promise(r => setTimeout(r, waitMs))])
      .then(() => (name ? temp.removeWorkDir(name) : true))
      .catch(() => false));
  }
  await Promise.all(waits);
}

/* ── Tests only ─────────────────────────────────────────────────────────── */

function _setForTest({ client, sleep, now, program, timeouts } = {}) {
  if (client !== undefined) _client = client || new GofileClient();
  if (sleep !== undefined) _sleep = sleep || _defaultSleep;
  if (now !== undefined) _now = now || (() => Date.now());
  if (program !== undefined) _program = program;
  if (timeouts !== undefined) _timeouts = { ...TIMEOUTS, ...(timeouts || {}) };
}

/** Tests only: forget memory state, as a restart would. */
function _simulateRestart() {
  _jobs.clear();
  _queue.length = 0;
  _active = null;
  _uploadSeenAt = 0;
  _packQueue.length = 0;
  _packActive = null;
  _packSeenAt = 0;
  _recovered = false;
  _locks.clear();
  _pending.length = 0;
  _pendingFiles.clear();
  _lockAc = new AbortController();
  _cleanupWanted = true;
  _lastCleanup = 0;
}

/** Tests only: the pack line, and whether a job still holds its password and plan. */
function _packStateForTest() {
  const jobs = {};
  for (const [id, j] of _jobs) jobs[id] = { packQueued: j.packQueued, hasPassword: j.password != null, hasPlan: j.plan != null, autoUpload: j.autoUpload };
  return { queue: [..._packQueue], active: _packActive, jobs };
}

/** Tests only: run a clean-up pass now and wait for it. */
async function _cleanupNow() {
  if (_cleaning) await _cleaning;
  await _maybeCleanup({ force: true });
}

async function _idle() {
  // Until nothing moves: a pack that ends starts the next in line, and may
  // queue an upload of its own (Upload on its own).
  for (let i = 0; i < 50; i++) {
    await Promise.all([..._locks.values()]);
    if (_cleaning) await _cleaning;
    let waited = false;
    for (const j of [..._jobs.values()]) {
      if (j.packing) { waited = true; try { await j.packing; } catch {} }
      if (j.running) waited = true;
      await _settle(j);
    }
    if (!waited && _locks.size === 0 && !(_packQueue.length && _packActive === null)) return;
  }
}

module.exports = {
  SESSION,
  state, preview, metaCheck, metaCheckStatus, start, cancel, progress, listShares, getShare,
  confirmUpload, pause, resume, retryPart, stop,
  deleteRemote, deleteAll, markGone, remove, retryTimer,
  revealPassword, copyBlock, previewFormat,
  savedPasswordStatus, revealSavedPassword, changeSavedPassword,
  updateSettings, onFeatureOff, ensureRecovered, shutdown, isWorking, STALL_MS,
  _setForTest, _simulateRestart, _idle, _cleanupNow, _packStateForTest,
};
