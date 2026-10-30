/**
 * Flow (FLOW: measure each file's music, order a collection so each file
 * flows into the next): the measuring queue, the stored results and what the
 * routes answer (server/flow-routes.js).
 *
 * server/index.js calls configure() once with what the service cannot know
 * by itself: whether the vault is locked, whether a Stage is playing, and the
 * settings (Settings › Stage: "Measure for Flow"). Until then nothing is
 * measured. While locked nothing is read or written: the queue waits, a file
 * stopped half-way goes back to the front, and a result that finishes just as
 * the lock lands is dropped, not written.
 *
 * The main thread stays light: measuring (ffmpeg's output and all the DSP)
 * and Flow order run in a worker thread (lib/flow/pool.js), Flow order is
 * cached until the collection, the shape or a measurement changes, and the
 * whole-library pass walks the library in small keyset steps
 * (store.sweepBatch) with its cursor kept between steps.
 *
 * Collections over MAX_ORDER files: Flow says so and does nothing else (no
 * measuring queued, no order worked out).
 *
 * A file that could not be measured keeps why (media_flow.error, as ffmpeg
 * said it, and error_code); the page gets it in plain words (failReason) and
 * the server's console gets a line for each (at most LOG_MAX a run). When
 * Flow's worker itself failed (pool.js: it died, hung or would not start,
 * even after its one retry) that is not the file's fault: nothing is saved,
 * and the file is left for later (skipped for the rest of this run, asked
 * again by Try again, Measure the rest or the next start).
 *
 * Measure again (requestCollection all): every file of the collection is
 * measured again; one already measured keeps its numbers until the new
 * measurement succeeds (as a stale row does).
 *
 * Ignore calm intros and credits (Settings › Stage, flowEdges): applied as
 * rows become features (FlowOrder.fromRow), so changing it needs no
 * measuring; it is part of the order cache's key.
 */

const fs = require('fs');
const path = require('path');
const database = require('../database');
const store = require('./store');
const analyze = require('./analyze');
const loudness = require('./loudness');
const pool = require('./pool');
const { createQueue } = require('./queue');
const FlowOrder = require('../../player-lib/flow-order.js');
const streamTags = require('../stream-tags');

const MEASURABLE = new Set(['video', 'audio']);
const MAX_ORDER = 5000;           // Flow works on collections up to this many files
const MEASURE_MODES = ['use', 'new', 'all'];
const TOO_MANY_TEXT = `Flow works on collections of up to ${MAX_ORDER.toLocaleString('en-US')} files.`;

let deps = {
  isLocked: () => false,
  stagePlaying: () => false,
  settings: () => ({}),
  measure: null,                  // tests: (filePath, {duration, signal}) => features; default: the worker
};
let configured = false;
let queue = null;
let rev = 0;                      // bumped by every stored measurement (the order cache's key)
let lastMode = null;

const aborted = () => Object.assign(new Error('cancelled'), { code: 'ABORTED' });
const tooMany = () => Object.assign(new Error(TOO_MANY_TEXT), { code: 'TOO_MANY' });
const mode = () => {
  const m = (deps.settings() || {}).flowMeasure;
  return MEASURE_MODES.includes(m) ? m : 'use';
};
/** Ignore calm intros and credits: FlowOrder.EDGE_MODES, 'auto' by default. */
const edgesMode = () => {
  let m;
  try { m = (deps.settings() || {}).flowEdges; } catch { m = null; }
  return FlowOrder.EDGE_MODES.includes(m) ? m : 'auto';
};

function db() {
  return database.get();
}

/* ── The whole-library pass ─────────────────────────────────────────── */

const sweep = { cursor: 0, buf: [] };

/** The next library file to measure, 'later' after a stretch with none, null at the end. */
function nextSweep() {
  if (deps.isLocked()) return null;
  const d = db();
  const next = () => {
    while (sweep.buf.length) {
      const id = sweep.buf.shift();
      if (keptStale.has(id)) continue;           // its re-measure failed this run: its older numbers stay
      if (skipped.has(id)) continue;             // Flow's worker failed on it this run: later
      const r = store.get(d, id);
      if (!r || r.stale) return id;              // measured meanwhile (a collection asked first): skip it
    }
    return null;
  };
  const id = next();
  if (id != null) return id;
  const r = store.sweepBatch(d, sweep.cursor);
  sweep.cursor = r.cursor;
  sweep.buf = r.ids;
  const id2 = next();
  if (id2 != null) return id2;
  return r.done ? null : 'later';
}

function restartSweep() {
  sweep.cursor = 0;
  sweep.buf = [];
  q().restartSweep();
}

function q() {
  if (!queue) {
    queue = createQueue({
      measure: measureOne,
      onChange: (s) => { if (s.state === 'idle') endLogRun(); },
      isLocked: () => deps.isLocked(),
      stagePlaying: () => { try { return !!deps.stagePlaying(); } catch { return false; } },
      sweepOn: () => configured && !deps.isLocked() && mode() === 'all',
      nextSweep,
    });
  }
  return queue;
}

function configure(d = {}) {
  deps = { ...deps, ...d };
  configured = true;
  // Not now: the server is still starting (the database may not be open yet).
  setImmediate(() => { try { lastMode = mode(); q().kick(); } catch {} });
}

const MEDIA_COLS = 'id, filepath, media_type, duration_seconds, filesize_bytes, file_mtime_ms, audio_codec, video_codec';

function shortError(err) {
  const m = String((err && err.message) || err || 'unknown error').split('\n')[0];
  return m.length > 200 ? m.slice(0, 200) : m;
}

// Flow's worker itself failed (lib/flow/pool.js), after its one retry: not the file's fault.
const WORKER_CODES = new Set(['WORKER_ERROR', 'WORKER_EXIT', 'HUNG']);
const MISSING_TEXT = 'The file is not where the library says it is.';

/** The kind of a stored failure that has no error_code (rows from before it was kept). */
function guessCode(raw) {
  if (/not where the library says/i.test(raw)) return 'MISSING';
  if (/^Flow worker/i.test(raw)) return 'WORKER';
  if (/couldn't run ff(mpeg|probe)|^spawn \S*ff(mpeg|probe)/i.test(raw)) return 'SPAWN';
  if (/took too long/i.test(raw)) return 'TIMEOUT';
  return null;
}

/**
 * Why a file could not be measured, in plain words (the page and the
 * console), from the stored code and ffmpeg's own text (raw).
 */
function failReason(code, raw) {
  const t = String(raw || '').trim();
  switch (code || guessCode(t)) {
    case 'MISSING': return 'the file is missing (not where the library says it is)';
    case 'SPAWN': return `Vault couldn't run ${/ffprobe/i.test(t) ? 'ffprobe' : 'ffmpeg'}`;
    case 'TIMEOUT': return 'it took too long to read';
    case 'DECODE': return t ? `ffmpeg couldn't read it: ${t}` : "ffmpeg couldn't read it";
    case 'WORKER': case 'WORKER_ERROR': case 'WORKER_EXIT': case 'HUNG': return `Flow's measuring stopped working (${t})`;
    default: return t || 'unknown error';
  }
}

/*
 * The server's console: a line for each file that could not be measured, at
 * most LOG_MAX a run (until the queue is idle), then one line with the rest.
 */
const LOG_MAX = 20;
const log = { lines: 0, more: 0 };
function logFail(filePath, reason) {
  if (log.lines >= LOG_MAX) { log.more++; return; }
  log.lines++;
  console.warn(`[Flow] couldn't measure ${path.basename(String(filePath || '')) || 'a file'}: ${reason}`);
}
function endLogRun() {
  if (log.more) console.warn(`[Flow] ${log.more} more ${log.more === 1 ? 'file' : 'files'} couldn't be measured (only the first ${LOG_MAX} are listed)`);
  log.lines = 0;
  log.more = 0;
}

/*
 * Quick answers (a missing file, a video with no sound) are written together,
 * one transaction every quarter second (or every 200), not one write each:
 * thousands of them (a disconnected drive) must not hold the server up with
 * a disk sync per file.
 */
const QUICK_FLUSH_MS = 250;       // one commit at most this often (each commit is a disk sync)
const quick = [];
let quickTimer = null;
function writeQuick(id, src, f, o) {
  quick.push([id, src, f, o]);
  if (quick.length >= 200) flushQuick();
  else if (!quickTimer) quickTimer = setTimeout(flushQuick, QUICK_FLUSH_MS);
}
// Files whose quick answer could not be written (the vault locked first, or
// the write failed): asked again on the next kick() (the unlock, a setting),
// ahead of the library walk, whose cursor has already gone past them.
const dropped = new Set();
let warnedWrite = false;
function flushQuick() {
  if (quickTimer) { clearTimeout(quickTimer); quickTimer = null; }
  const rows = quick.splice(0);
  if (!rows.length) return;
  if (deps.isLocked()) { for (const [id] of rows) dropped.add(id); return; }
  try {
    const d = db();
    d.transaction(() => { for (const [id, src, f, o] of rows) store.save(d, id, src, f, o); })();
    rev++;
  } catch (err) {
    // A disk that is full, a database that went away: never take Vault down
    // for this. The files are asked again later.
    for (const [id] of rows) dropped.add(id);
    if (!warnedWrite) { warnedWrite = true; console.warn('[Flow] could not save measurements, will try again later:', err && err.message); }
  }
}

/** Put the files that were dropped back in the queue (front). */
function requeueDropped() {
  if (!dropped.size || deps.isLocked()) return 0;
  const ids = [...dropped];
  dropped.clear();
  return q().add(ids, { front: true });
}

/*
 * A row from an older method (stale, still used) whose re-measure failed (a
 * drive that is not plugged in, a file ffmpeg cannot read today) keeps its
 * numbers: nothing is written, and its id is kept here (in memory). Until
 * Vault restarts or the user presses Try again (a collection's retry), the
 * library pass and a collection opening do not ask for it again, so a
 * missing drive is not tried on every pass. A collection's counts report
 * these as kept, not as stale still to do.
 */
const keptStale = new Set();

/*
 * Files Flow's worker failed on (not the file's fault): nothing was written,
 * and, like keptStale, they are not asked again by the library pass or a
 * collection opening until Vault restarts or the user asks (Try again,
 * Measure the rest), so a worker that cannot start is not a hot loop.
 */
const skipped = new Set();
let workerError = null;           // the last such failure's text, until a file is measured again

// Files asked for by Measure again: their numbers stay until the new measurement succeeds.
const forced = new Set();

const exists = (p) => fs.promises.access(p).then(() => true, () => false);

/** Measure one file (in the worker) and store the result. Rejects ABORTED when stopped (nothing written). */
async function measureOne(id, signal) {
  if (deps.isLocked()) throw aborted();
  const d = db();
  const row = d.prepare(`SELECT ${MEDIA_COLS} FROM media WHERE id = ?`).get(id);
  if (!row || !MEASURABLE.has(row.media_type)) { forced.delete(id); return; }
  const src = store.srcOf(row);
  const write = (f, o) => {
    if (deps.isLocked() || (signal && signal.aborted)) throw aborted();
    store.save(d, id, src, f, o);
    rev++;
  };
  const old = store.get(d, id);
  // Numbers to keep if measuring again fails: an older method's, or ones Measure again asked to redo.
  const keepOld = !!(old && !old.error && (old.stale || forced.has(id)));
  // Probed with a picture and no sound: nothing to listen to.
  if (row.media_type === 'video' && row.video_codec && !row.audio_codec) { forced.delete(id); return writeQuick(id, src, analyze.noAudioResult()); }
  if (!row.filepath || !(await exists(row.filepath))) {
    if (deps.isLocked() || (signal && signal.aborted)) throw aborted();
    forced.delete(id);
    if (keepOld) keptStale.add(id);
    else writeQuick(id, src, null, { error: MISSING_TEXT, errorCode: 'MISSING' });
    logFail(row.filepath, failReason('MISSING'));
    throw new Error('missing file');
  }
  let f;
  try {
    const run = deps.measure || pool.measure;
    f = await run(row.filepath, { duration: row.duration_seconds, signal });
  } catch (err) {
    if ((err && err.code === 'ABORTED') || (signal && signal.aborted) || deps.isLocked()) throw aborted();
    forced.delete(id);
    if (err && err.code === 'NO_AUDIO') return write(analyze.noAudioResult());
    const raw = shortError(err);
    const code = (err && typeof err.code === 'string' && err.code) || null;
    if (code && WORKER_CODES.has(code)) {
      // Flow's worker failed, not the file: nothing saved, asked again later.
      workerError = raw;
      if (keepOld) keptStale.add(id);
      else skipped.add(id);
    } else if (keepOld) keptStale.add(id);
    else write(null, { error: raw, errorCode: code });
    logFail(row.filepath, failReason(code, raw));
    throw err;
  }
  write(f);
  keptStale.delete(id);
  skipped.delete(id);
  forced.delete(id);
  workerError = null;
}

/* ── Collections ─────────────────────────────────────────────────────── */

function collectionRow(cid) {
  return db().prepare('SELECT id, kind FROM collections WHERE id = ?').get(cid) || null;
}

function itemCount(cid) {
  return db().prepare('SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?').get(cid).n;
}

/**
 * The collection's counts in one indexed query (no id lists in memory):
 * what can be measured, what is (current: same file, same method), music or
 * not, what failed.
 */
const SRC_SQL = "COALESCE(CAST(m.filesize_bytes AS TEXT), '') || ':' || COALESCE(CAST(m.file_mtime_ms AS TEXT), '')";
const countsCache = new Map();     // cid -> { rev, at, value }: a poll asks again within a second
function countsFor(cid) {
  const c = countsCache.get(cid);
  // Same measurements and under a second old, or anything under half a second old.
  if (c && ((c.rev === rev && Date.now() - c.at < 1000) || Date.now() - c.at < 500)) return c.value;
  const value = countsUncached(cid);
  countsCache.set(cid, { rev, at: Date.now(), value });
  if (countsCache.size > 16) countsCache.delete(countsCache.keys().next().value);
  return value;
}
function countsUncached(cid) {
  // Too big for Flow: only the size (an index count), never a 50,000-row join.
  const total = itemCount(cid);
  if (total > MAX_ORDER) return { total, measurable: null, measured: 0, music: 0, noMusic: 0, failed: 0, left: 0, stale: 0, kept: 0, max: MAX_ORDER, tooMany: true };
  const r = db().prepare(`SELECT
      COUNT(ci.media_id) AS total,
      COALESCE(SUM(m.media_type IN ('video', 'audio')), 0) AS measurable,
      COALESCE(SUM(m.media_type IN ('video', 'audio') AND f.media_id IS NOT NULL AND f.version BETWEEN @min AND @v AND f.src = ${SRC_SQL} AND f.error IS NULL), 0) AS measured,
      COALESCE(SUM(m.media_type IN ('video', 'audio') AND f.media_id IS NOT NULL AND f.version BETWEEN @min AND @v AND f.src = ${SRC_SQL} AND f.error IS NULL AND f.has_music = 1), 0) AS music,
      COALESCE(SUM(m.media_type IN ('video', 'audio') AND f.media_id IS NOT NULL AND f.version >= @min AND f.version < @v AND f.src = ${SRC_SQL} AND f.error IS NULL), 0) AS stale,
      COALESCE(SUM(m.media_type IN ('video', 'audio') AND f.media_id IS NOT NULL AND f.version = @v AND f.src = ${SRC_SQL} AND f.error IS NOT NULL), 0) AS failed
    FROM collection_items ci
    LEFT JOIN media m ON m.id = ci.media_id
    LEFT JOIN media_flow f ON f.media_id = ci.media_id
    WHERE ci.collection_id = @c`).get({ c: cid, v: analyze.VERSION, min: analyze.MIN_VERSION });
  const kept = keptIn(cid);
  return {
    total: r.total, measurable: r.measurable, measured: r.measured, music: r.music, noMusic: r.measured - r.music,
    // stale: measured by an older method (used meanwhile), still to be measured again.
    // kept: measuring again failed this run (see keptStale), an older method's
    // numbers or ones Measure again asked to redo: they keep their numbers.
    failed: r.failed, left: r.measurable - r.measured - r.failed, stale: Math.max(0, r.stale - kept.old), kept: kept.all,
    max: MAX_ORDER, tooMany: r.total > MAX_ORDER,
  };
}

/** How many of the collection's files are in keptStale (still with their numbers): all, and those by an older method. */
function keptIn(cid) {
  if (!keptStale.size) return { all: 0, old: 0 };
  const r = db().prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(f.version < @v), 0) AS old FROM collection_items ci JOIN media m ON m.id = ci.media_id
    JOIN media_flow f ON f.media_id = ci.media_id
    WHERE ci.collection_id = @c AND ci.media_id IN (SELECT value FROM json_each(@ids))
      AND f.version BETWEEN @min AND @v AND f.error IS NULL AND f.src = ${SRC_SQL}`)
    .get({ c: cid, ids: JSON.stringify([...keptStale]), v: analyze.VERSION, min: analyze.MIN_VERSION });
  return { all: r.n, old: r.old };
}

/**
 * The collection's files the queue still has to do (waiting or being
 * measured): queued; of those, the ones whose last try failed (queuedFailed:
 * the page does not count them as failed while they are tried again) and the
 * ones Measure again asked for (again). Not cached: the queue moves on its own.
 */
function queuedIn(cid) {
  const ids = q().ids();
  if (!ids.length) return { queued: 0, queuedFailed: 0, again: 0 };
  const r = db().prepare(`SELECT COUNT(*) AS n,
      COALESCE(SUM(f.media_id IS NOT NULL AND f.version = @v AND f.src = ${SRC_SQL} AND f.error IS NOT NULL), 0) AS failed,
      COALESCE(SUM(ci.media_id IN (SELECT value FROM json_each(@forced))), 0) AS again
    FROM collection_items ci JOIN media m ON m.id = ci.media_id
    LEFT JOIN media_flow f ON f.media_id = ci.media_id
    WHERE ci.collection_id = @c AND m.media_type IN ('video', 'audio') AND ci.media_id IN (SELECT value FROM json_each(@ids))`)
    .get({ c: cid, ids: JSON.stringify(ids), forced: JSON.stringify([...forced]), v: analyze.VERSION });
  return { queued: r.n, queuedFailed: r.failed, again: r.again };
}

/**
 * The library's title for files that have one: the song Music ID linked to
 * the file, when exactly one is (a mix of several songs has no one title),
 * as Music ID writes it ("Title by Artist"). Music ID's own placeholders
 * ("Unknown Song 3", grouped by sound alone) are not titles.
 * @returns {Map<number, string>}
 */
function songTitles(d, ids) {
  const out = new Map();
  if (!ids.length || !d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_songs'").get()) return out;
  const stmt = d.prepare(`SELECT ms.media_id AS id, COUNT(DISTINCT ms.song_id) AS n, MIN(s.title) AS title, MIN(s.artist) AS artist,
      MAX(s.source = 'auto-cluster') AS placeholder
    FROM media_songs ms JOIN songs s ON s.id = ms.song_id
    WHERE ms.media_id IN (SELECT value FROM json_each(?)) GROUP BY ms.media_id`);
  for (let i = 0; i < ids.length; i += 900) {
    for (const r of stmt.all(JSON.stringify(ids.slice(i, i + 900)))) {
      if (r.n !== 1 || !r.title || r.placeholder) continue;
      out.set(r.id, r.artist && r.artist !== 'Unknown' ? `${r.title} by ${r.artist}` : r.title);
    }
  }
  return out;
}

/** The collection's files in playlist order, with their types and current results. */
function collectionData(cid) {
  const ids = database.getCollectionItems(cid);
  const d = db();
  const types = new Map();
  const names = new Map();
  for (let i = 0; i < ids.length; i += 900) {
    const part = ids.slice(i, i + 900);
    for (const r of d.prepare('SELECT id, media_type, filename FROM media WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(part))) {
      types.set(r.id, r.media_type);
      names.set(r.id, r.filename || '');
    }
  }
  const live = ids.filter(id => types.has(id));
  const titles = songTitles(d, live);
  // Rows with no file record left: kept, unchanged, after the rest (the order
  // route wants every member exactly once).
  const dangling = ids.filter(id => !types.has(id));
  return { all: ids, ids: live, dangling, types, names, titles, rows: store.currentFor(d, live.filter(id => MEASURABLE.has(types.get(id)))) };
}

function mustExist(cid) {
  const c = collectionRow(cid);
  if (!c) throw Object.assign(new Error('No such collection.'), { code: 'NOT_FOUND' });
  // Flow is for collections, not folders (a folder gathers every collection
  // under it, so its size is unbounded; the Flow… button is not shown there).
  if (c.kind === 'folder') throw Object.assign(new Error('Flow works on a collection, not a folder. Open one of the collections in it.'), { code: 'FOLDER' });
  return c;
}

/**
 * Queue the collection's files that are not measured yet. retry: the ones
 * that failed too (Try again, Measure the rest). all: every file, measured or
 * not (Measure again); measured ones keep their numbers until the new
 * measurement succeeds.
 */
function requestCollection(cid, { retry = false, all = false } = {}) {
  if (deps.isLocked()) throw Object.assign(new Error('Vault is locked.'), { code: 'VAULT_LOCKED' });
  mustExist(cid);
  if (itemCount(cid) > MAX_ORDER) return { added: 0, ...status(cid) };
  const data = collectionData(cid);
  if (all) retry = true;
  const want = [], stale = [];
  for (const id of data.ids) {
    if (!MEASURABLE.has(data.types.get(id))) continue;
    const r = data.rows.get(id);
    if (!r) {
      // Flow's worker failed on it this run: only when asked (Try again, Measure the rest).
      if (retry || !skipped.has(id)) { skipped.delete(id); want.push(id); }
    } else if (retry && r.error) want.push(id);
    else if (all || (retry && keptStale.has(id) && !r.stale)) {
      // Measured: again, keeping its numbers until that succeeds.
      forced.add(id);
      keptStale.delete(id);
      want.push(id);
    } else if (r.stale && (retry || !keptStale.has(id))) {
      // An older method, used meanwhile: measured again after the rest. One that
      // failed this run (keptStale) is only asked again by Try again.
      keptStale.delete(id);
      stale.push(id);
    }
  }
  want.push(...stale);
  const added = q().add(want);
  return { added, ...status(cid) };
}

/** workerError: Flow's worker failed on the last file it tried (its text), else null. */
function status(cid = null) {
  const out = { queue: q().status(), mode: mode(), workerError };
  if (cid != null) {
    mustExist(cid);
    const c = countsFor(cid);
    out.collection = c.tooMany ? c : { ...c, ...queuedIn(cid) };
  }
  return out;
}

/** Features as the page and FlowOrder use them: compact, rounded, with the file name and the library's title when there is one (the chart's names). */
function featuresOf(data, edges = edgesMode()) {
  const out = [];
  for (const id of data.ids) {
    const t = data.types.get(id);
    const name = data.names.get(id) || '';
    const title = data.titles.get(id);
    if (!MEASURABLE.has(t)) { out.push({ id, measured: false, kind: 'other', music: false, es: 0, em: 0, ee: 0, bs: null, bm: null, be: null, name, ...(title ? { title } : {}) }); continue; }
    const row = data.rows.get(id) || null;
    // Couldn't be measured: why, in plain words (reason) and as ffmpeg said it (error).
    const why = row && row.error ? { reason: failReason(row.error_code, row.error), error: row.error } : {};
    out.push({ ...FlowOrder.fromRow(id, row, edges), name, ...(title ? { title } : {}), ...why });
  }
  return out;
}

/** What Flow order needs of a file (the worker is sent no names, envelopes, skips or reasons). */
const forOrder = ({ env, name, title, reason, error, skip, cut, ...f }) => f;

// Flow order, worked out in the worker, kept until the collection's members,
// the shape, the first file or any measurement changes.
const orderCache = new Map();     // key -> { at, value }
const ORDER_CACHE_MAX = 8;
function membersKey(ids) {
  let h = 0;
  for (let i = 0; i < ids.length; i++) h = (Math.imul(h, 31) + ids[i]) | 0;
  return `${ids.length}:${h}`;
}

/** The place each of these files gets from its stream tags: { id: place } (lib/stream-tags.js). */
function placesOf(ids) {
  const out = {};
  for (const [id, p] of streamTags.placesFor(db(), ids)) out[id] = p;
  return out;
}
function placesKey(places) {
  let h = 0, n = 0;
  for (const [id, p] of Object.entries(places)) { n++; h = (Math.imul(h, 31) + Number(id) * 8 + FlowOrder.PLACES.indexOf(p)) | 0; }
  return `${n}:${h}`;
}

/**
 * Flow order for a collection. places: put files with a placed stream tag
 * (First, Last, At a peak...) where their tag says (FlowOrder.planOrder
 * o.places). The answer's places lists every file's place either way, so
 * the panel knows whether to offer it. waves: Waves' peaks (1..6, else 2),
 * in the answer for Waves only.
 * @returns {Promise<{shape, waves, order, playlistOrder, features, targets, handovers, jumps, playlistJumps, counts, places, placesOn}>}
 */
async function collectionFlow(cid, { shape = 'smooth', waves: wavesAsked = null, firstId = null, places: usePlaces = false } = {}) {
  mustExist(cid);
  if (itemCount(cid) > MAX_ORDER) throw tooMany();
  const data = collectionData(cid);
  if (!FlowOrder.isShape(shape)) shape = 'smooth';
  const waves = FlowOrder.wavesCount(wavesAsked);
  const first = firstId != null && data.ids.includes(firstId) ? firstId : null;
  const places = placesOf(data.ids);
  const placesOn = !!usePlaces;
  const edges = edgesMode();
  const key = `${cid}|${shape}|${shape === 'waves' ? waves : ''}|${first}|${rev}|${edges}|${membersKey(data.all)}|${placesOn ? placesKey(places) : '-'}`;
  const hit = orderCache.get(key);
  // A minute at most: a file changed on disk (not a new measurement) shows up then.
  if (hit && Date.now() - hit.at < 60000) return { ...hit.value, counts: countsFor(cid), places };
  const feats = featuresOf(data, edges);
  const use = placesOn && Object.keys(places).length ? places : null;
  const plan = feats.length > 1 ? await pool.order(feats.map(forOrder), { shape, waves, firstId: first, places: use }) : { ...FlowOrder.planOrder(feats, { shape, waves }), ...FlowOrder.summary(feats, feats.map(f => f.id)) };
  const playlist = FlowOrder.summary(feats, data.ids);
  const value = {
    shape,
    // Waves' peaks: only in a Waves answer (the cache key leaves them out for any other shape).
    ...(shape === 'waves' ? { waves } : {}),
    places,
    placesOn,
    edges,
    order: plan.order.concat(data.dangling),
    playlistOrder: data.all,
    features: feats,
    targets: plan.targets ? plan.targets.map(t => Math.round(t * 1000) / 1000) : null,
    handovers: plan.handovers,
    jumps: plan.jumps,
    playlistJumps: playlist.jumps,
    counts: countsFor(cid),
  };
  orderCache.set(key, { at: Date.now(), value });
  while (orderCache.size > ORDER_CACHE_MAX) orderCache.delete(orderCache.keys().next().value);
  return value;
}

/** One file's features (the Stage bar), or null. */
function mediaFeatures(id) {
  const d = db();
  const t = d.prepare('SELECT media_type FROM media WHERE id = ?').get(id);
  if (!t) return null;
  if (!MEASURABLE.has(t.media_type)) return { id, measured: false, kind: 'other' };
  const r = store.get(d, id);
  const f = FlowOrder.fromRow(id, r, edgesMode());
  return { ...f, text: FlowOrder.flowText(f) };
}

/** Even out loudness: the Stage gain for a file, in dB, or null. */
function gainFor(id) {
  if (deps.isLocked()) return null;
  try { return loudness.gainDb(store.get(db(), id)); } catch { return null; }
}

/** New files came into the library: measured too when the setting says so. */
function noteAdded(ids) {
  if (!configured || deps.isLocked()) return 0;
  if (mode() === 'use') return 0;
  return q().add((ids || []).filter(Number.isInteger));
}

/**
 * Something changed (the lock, Stage, Settings): the queue looks again. The
 * library pass keeps its place; it starts over from the top only when
 * "Whole library now" is newly chosen.
 */
function kick() {
  if (!configured) return;
  const m = mode();
  const turnedOn = m === 'all' && lastMode !== 'all';
  lastMode = m;
  requeueDropped();
  if (turnedOn) restartSweep();
  else q().kick();
}
function pause() { q().pause(); return status(); }
function resume() { q().resume(); return status(); }
function cancel() { q().cancel(); forced.clear(); return status(); }

module.exports = {
  configure, requestCollection, collectionFlow, status, mediaFeatures, gainFor, noteAdded,
  kick, pause, resume, cancel, measureOne, failReason, MAX_ORDER, MEASURE_MODES, TOO_MANY_TEXT, LOG_MAX,
  _queue: () => q(),
  _skipped: () => [...skipped],
  _flushQuick: () => flushQuick(),
  _dropped: () => [...dropped],
  _sweep: () => ({ ...sweep, buf: sweep.buf.length }),
  _reset: () => { queue = null; configured = false; sweep.cursor = 0; sweep.buf = []; orderCache.clear(); },
};
