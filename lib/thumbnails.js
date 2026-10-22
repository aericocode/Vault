/**
 * Thumbnail generation + cache.
 *
 * All thumbnails are generated with ffmpeg (already a hard dependency of the
 * tagger, no need for sharp): images/gifs are downscaled, videos get a frame
 * seeked a configurable percentage into the file. ffmpeg writes the JPEG to
 * stdout and the bytes go wherever the settings say, so no temp file is ever
 * involved in making one.
 *
 * What is made and where it is kept follows lib/thumb-settings.js
 * (Settings > Library > Thumbnails):
 *  - "For every file" (default): the scan makes covers; everything is stored.
 *  - "When shown": nothing is made until a tile asks. Then, by `keep`:
 *      keep   stored as below, for good;
 *      cap    stored as below, least recently shown removed past the disk limit;
 *      memory held in server memory only (ByteLru), never written anywhere.
 *  - Hover frames off: no scrub frames are made at all.
 *  - Use pictures already inside files: album / cover art is read straight out
 *    of the file when shown (held in memory, never stored), for videos and audio.
 *
 * Stored means (lib/secure-assets):
 *  - vault OFF: config.paths.thumbnailDir as {id}.jpg / {id}_s{n}.jpg, the path
 *    stored in media.thumbnail_path, byte-for-byte the old behaviour.
 *  - vault ON:  secure_assets.db kinds thumb / scrub0..4. Nothing derived is
 *    left in plaintext under thumbnailDir.
 *
 * Every file name built here comes from an integer media id and, for scrub
 * frames, an index 0..4. Nothing is ever deleted by pattern alone: the
 * cleanup functions parse an id out of a name and rebuild the path from it.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./database');
const proc = require('./proc');
const secureAssets = require('./secure-assets');
const ownedDir = require('./owned-dir');
const tsettings = require('./thumb-settings');
const { ByteLru, DiskUse } = require('./thumb-cache');

const THUMBABLE_TYPES = new Set(['image', 'gif', 'video']);
const ART_TYPES = new Set(['video', 'audio']);
const SCRUB_COUNT = 5;
const SCRUB_KINDS = Array.from({ length: SCRUB_COUNT }, (_, i) => `scrub${i}`);
const THUMB_KINDS = ['thumb', ...SCRUB_KINDS];
const MB = 1024 * 1024;

// In-flight generation guard: concurrent requests for the same id/kind await one job
const inFlight = new Map();

// Bumped by clearMemory() (vault lock): a job that started before it must not
// put anything into a cache or store afterwards.
let _epoch = 0;

// Is the vault locked? The server wires this to vault.isLocked(). While it is,
// nothing here reads, writes, trims or deletes stored pictures, and nothing is
// put in memory. A sealed secure store (closed on lock) counts as locked too.
let _lockProbe = () => false;
function setLockProbe(fn) { _lockProbe = typeof fn === 'function' ? fn : () => false; }
function _isLocked() {
  try { if (_lockProbe()) return true; } catch {}
  return secureAssets.enabled() && secureAssets.sealed();
}

function ensureThumbDir() {
  // Stamp the app-owned marker so record-delete sidecar unlinks are permitted
  // in this dir (they're gated on the marker). Adoption is conditional: a dir
  // holding unrecognized user files is left unmarked (see lib/owned-dir.js).
  ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs');
}

/* ── Paths, only ever from integer ids ─────────────────────────────────── */

function _id(id) {
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`bad media id: ${id}`);
  return n;
}

function coverPath(id) {
  return path.join(config.paths.thumbnailDir, `${_id(id)}.jpg`);
}

function scrubPath(id, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= SCRUB_COUNT) throw new Error(`bad scrub index: ${idx}`);
  return path.join(config.paths.thumbnailDir, `${_id(id)}_s${idx}.jpg`);
}

const RX_COVER = /^(\d+)\.jpg$/;
const RX_SCRUB = /^(\d+)_s([0-4])\.jpg$/;
const RX_BEAT = /^\d+_beataudio\.(m4a|aac)$/;

/* ── Rendering (ffmpeg to stdout) ──────────────────────────────────────── */

function _scaleArgs() {
  return [
    '-vf', `scale='min(${config.thumbnails.width},iw)':-1`,
    '-q:v', String(config.thumbnails.jpegQuality),
  ];
}

const PIPE_OUT = ['-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];

/**
 * Make one picture. spec.kind: 'thumb' (the cover), 'scrub' (hover frame
 * spec.idx) or 'art' (the attached picture at ffprobe stream spec.idx).
 * @returns {Promise<Buffer|null>}
 */
async function _ffmpegRender(spec) {
  const { kind, row, idx } = spec;
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (kind === 'thumb') {
    if (row.media_type === 'video') {
      // Seek into the video so we don't thumbnail a black intro frame
      const duration = row.duration_seconds || 0;
      const seekTo = duration > 2 ? duration * config.thumbnails.videoSeekPercent : 0;
      if (seekTo > 0) args.push('-ss', seekTo.toFixed(2));
    }
    args.push('-i', row.filepath, '-vframes', '1', ..._scaleArgs());
  } else if (kind === 'scrub') {
    const duration = row.duration_seconds || 0;
    const seekTo = duration * ((idx + 1) / (SCRUB_COUNT + 1));
    args.push('-ss', seekTo.toFixed(2), '-i', row.filepath, '-vframes', '1', ..._scaleArgs());
  } else if (kind === 'art') {
    args.push('-i', row.filepath, '-map', `0:${idx}`, '-frames:v', '1', ..._scaleArgs());
  } else {
    return null;
  }
  args.push(...PIPE_OUT);
  try {
    const buf = await proc.runBuffer('ffmpeg', args, { timeout: 60000 });
    return buf && buf.length > 0 ? buf : null;
  } catch (err) {
    if (kind === 'thumb') console.warn(`  Thumbnail failed for ${row.filename}: ${err.message}`);
    return null;
  }
}

/** ffprobe index of the file's attached picture, -1 for none, null if unknown. */
async function _ffprobeArt(row) {
  const info = await require('./media-info').getStreamInfo(row.filepath);
  return info && Number.isInteger(info.art_stream) ? info.art_stream : null;
}

let _render = _ffmpegRender;
let _probeArt = _ffprobeArt;

/** Tests: swap the ffmpeg / ffprobe calls for fakes. Pass nothing to restore. */
function _setRenderer(fn) { _render = fn || _ffmpegRender; }
function _setArtProber(fn) { _probeArt = fn || _ffprobeArt; }

function _dedupe(key, make) {
  if (inFlight.has(key)) return inFlight.get(key);
  const job = Promise.resolve().then(make).finally(() => inFlight.delete(key));
  inFlight.set(key, job);
  return job;
}

/* ── Memory cache ("Only while Vault is running", and inside pictures) ─── */

let _memCache = null;
function _mem() {
  if (!_memCache) _memCache = new ByteLru(tsettings.get().memoryMB * MB);
  return _memCache;
}
const memKey = (id, kind) => `${id}:${kind}`;
const _memKind = (key) => key.slice(key.indexOf(':') + 1);

/* ── Stored covers / frames (disk or the encrypted store) ──────────────── */

function _backfillVersion(id, file) {
  try { db.bumpThumbVersion(id, fs.statSync(file).mtimeMs / 1000); } catch {}
}

/**
 * The cached thumbnail file for a row, without generating one.
 * Plain (non-vault) mode only.
 * @returns {string|null} absolute path, or null if it is not on disk yet
 */
function peekThumbnail(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return null;
  if (secureAssets.enabled()) return null;
  if (row.thumbnail_path && fs.existsSync(row.thumbnail_path)) {
    // Libraries that predate the column have a thumbnail and no version, and
    // without one their URLs can never be cached. The file's own mtime is the
    // version, and it is right by construction.
    if (!row.thumb_version) _backfillVersion(row.id, row.thumbnail_path);
    return row.thumbnail_path;
  }
  // The file can outlive the column (a DB restored over an existing thumb
  // dir). Adopt it rather than re-render what is already there.
  const p = coverPath(row.id);
  if (fs.existsSync(p)) {
    try { db.setThumbnailPath(row.id, p); } catch {}
    return p;
  }
  return null;
}

/**
 * The stored thumbnail bytes for a row, without generating them. Vault mode.
 * @returns {Buffer|null}
 */
function peekThumbnailBuffer(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return null;
  return secureAssets.get(row.id, 'thumb', '') || null;
}

/** A stored cover as { buf } (vault) or { path } (plain), or null. */
function _storedCover(row) {
  if (secureAssets.enabled()) {
    const buf = peekThumbnailBuffer(row);
    return buf ? { buf } : null;
  }
  const p = peekThumbnail(row);
  return p ? { path: p } : null;
}

function _storedScrub(row, idx) {
  if (secureAssets.enabled()) {
    const buf = secureAssets.get(row.id, `scrub${idx}`, '');
    return buf ? { buf } : null;
  }
  const p = scrubPath(row.id, idx);
  return fs.existsSync(p) ? { path: p } : null;
}

/** Put a freshly made cover where the settings say. @returns {Buffer|null} */
function _storeCover(row, buf, storage) {
  if (_isLocked()) return null;
  if (storage === 'memory') {
    _mem().set(memKey(row.id, 'thumb'), buf);
    return buf;
  }
  if (secureAssets.enabled()) {
    secureAssets.put(row.id, 'thumb', buf, '');
    try { db.bumpThumbVersion(row.id); } catch {}
  } else {
    ensureThumbDir();
    const out = coverPath(row.id);
    fs.writeFileSync(out, buf);
    db.setThumbnailPath(row.id, out);
  }
  if (storage === 'cap') _ledgerNote(row.id);
  return buf;
}

function _storeScrub(row, idx, buf, storage) {
  if (_isLocked()) return null;
  if (storage === 'memory') {
    _mem().set(memKey(row.id, `s${idx}`), buf);
    return buf;
  }
  if (secureAssets.enabled()) {
    secureAssets.put(row.id, `scrub${idx}`, buf, '');
  } else {
    ensureThumbDir();
    fs.writeFileSync(scrubPath(row.id, idx), buf);
  }
  if (storage === 'cap') _ledgerNote(row.id);
  return buf;
}

/** Make the cover now and keep it per the settings. @returns {Promise<Buffer|null>} */
function _makeCover(row) {
  return _dedupe(`cover:${row.id}`, async () => {
    const epoch = _epoch;
    const storage = tsettings.storage();
    if (storage === 'off') return null;
    const buf = await _render({ kind: 'thumb', row });
    if (!buf || epoch !== _epoch) return null;
    return _storeCover(row, buf, storage);
  });
}

/* ── Pictures inside files ─────────────────────────────────────────────── */

function _artWanted(row, s = tsettings.get()) {
  return !!row && s.inside && ART_TYPES.has(row.media_type);
}

// Files whose inside picture would not decode: treated as having none this session.
const _artBroken = new Set();

/** The attached-picture stream index to use, -1 for none, null if not checked yet. */
function _artIndex(row) {
  if (_artBroken.has(row.id)) return -1;
  return Number.isInteger(row.art_stream) ? row.art_stream : null;
}

/** Look (once, then remembered in the DB) for an attached picture. */
async function _detectArt(row) {
  let idx = null;
  try { idx = await _probeArt(row); } catch { idx = null; }
  if (idx == null) return -1;              // could not tell: not remembered, treated as none
  try {
    db.setArtStream(row.id, idx);
    // A stored frame may already be cached by browsers under this version.
    if (idx >= 0) db.bumpThumbVersion(row.id);
  } catch {}
  return idx;
}

function _getArt(row) {
  const key = memKey(row.id, 'art');
  const hit = _mem().get(key);
  if (hit) return Promise.resolve(hit);
  return _dedupe(`art:${row.id}`, async () => {
    const epoch = _epoch;
    const buf = await _render({ kind: 'art', row, idx: row.art_stream });
    if (!buf || epoch !== _epoch || _isLocked()) return null;
    _mem().set(key, buf);
    return buf;
  });
}

/* ── What the routes call ──────────────────────────────────────────────── */

/**
 * The /thumb answer for a row, without ever running ffmpeg here.
 * @returns {{type:'buffer', buf:Buffer} | {type:'file', path:string} |
 *           {type:'pending'} | {type:'missing'} | {type:'off'}}
 *   off = thumbnails are switched off: nothing is looked up or queued.
 */
function lookupThumb(row) {
  if (!row) return { type: 'missing' };
  const s = tsettings.get();
  const storage = tsettings.storage(s);
  if (storage === 'off') return { type: 'off' };

  if (_artWanted(row, s)) {
    const a = _artIndex(row);
    if (a != null && a >= 0) {
      const buf = _mem().get(memKey(row.id, 'art'));
      if (buf) return { type: 'buffer', buf };
      return _pendingFor(row, 'thumb');
    }
    if (a == null) {
      // Not checked yet. A stored cover answers now; the check runs behind it.
      const stored = THUMBABLE_TYPES.has(row.media_type) ? _storedCover(row) : null;
      if (stored) {
        enqueueThumbnail(row, 'probe');
        _noteShown(row.id, storage);
        return stored.buf ? { type: 'buffer', buf: stored.buf } : { type: 'file', path: stored.path };
      }
      return _pendingFor(row, 'thumb');
    }
    // a === -1: no picture inside; carry on as for any file
  }

  if (!THUMBABLE_TYPES.has(row.media_type)) return { type: 'missing' };

  // Anything already stored is used in every mode (the memory mode only stops
  // NEW pictures being written; reading old ones costs nothing).
  const stored = _storedCover(row);
  if (stored) {
    _noteShown(row.id, storage);
    return stored.buf ? { type: 'buffer', buf: stored.buf } : { type: 'file', path: stored.path };
  }
  if (storage === 'memory') {
    const buf = _mem().get(memKey(row.id, 'thumb'));
    if (buf) return { type: 'buffer', buf };
  }
  return _pendingFor(row, 'thumb');
}

function _pendingFor(row, want) {
  return enqueueThumbnail(row, want) === 'skipped' ? { type: 'missing' } : { type: 'pending' };
}

/**
 * The /scrub answer. Runs ffmpeg when the frame is not there yet (as today):
 * hover frames are asked for one at a time while the pointer is on a tile.
 * @returns {Promise<{type:'none'} | {type:'missing'} | {type:'buffer', buf} | {type:'file', path}>}
 *   none = hover frames are switched off (no ffmpeg run, nothing made).
 */
async function lookupScrub(row, idx) {
  const s = tsettings.get();
  if (!s.hover || s.make === 'off') return { type: 'none' };
  if (!row || row.media_type !== 'video') return { type: 'missing' };
  if (!Number.isInteger(idx) || idx < 0 || idx >= SCRUB_COUNT) return { type: 'missing' };
  if ((row.duration_seconds || 0) < 3) return { type: 'missing' };  // too short to scrub

  const storage = tsettings.storage(s);
  const stored = _storedScrub(row, idx);
  if (stored) return stored.buf ? { type: 'buffer', buf: stored.buf } : { type: 'file', path: stored.path };
  if (storage === 'memory') {
    const hit = _mem().get(memKey(row.id, `s${idx}`));
    if (hit) return { type: 'buffer', buf: hit };
  }
  if (!fs.existsSync(row.filepath)) return { type: 'missing' };

  const buf = await _dedupe(`scrub:${row.id}:${idx}`, async () => {
    const epoch = _epoch;
    const b = await _render({ kind: 'scrub', row, idx });
    if (!b || epoch !== _epoch) return null;
    return _storeScrub(row, idx, b, storage);
  });
  if (!buf) return { type: 'missing' };
  if (storage === 'memory' || secureAssets.enabled()) return { type: 'buffer', buf };
  return { type: 'file', path: scrubPath(row.id, idx) };
}

/* ── Older entry points, kept for their callers ────────────────────────── */

/**
 * Get (or make and store) the thumbnail BYTES for a row from the secure store.
 * Only meaningful when vault mode is on.
 * @returns {Promise<Buffer|null>}
 */
async function getThumbnailBuffer(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return null;
  const cached = secureAssets.get(row.id, 'thumb', '');
  if (cached) return cached;
  if (!fs.existsSync(row.filepath)) return null;
  return _makeCover(row);
}

/**
 * Get (or make and store) the thumbnail for a row as a file path. Plain
 * library only: an encrypted one keeps its pictures in the secure store and
 * has no path to give (a decrypted temp copy would leak), and neither has the
 * memory mode. Use getThumbnailBuffer / pictureForHash instead.
 * @returns {Promise<string|null>}
 */
async function getThumbnail(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return null;
  if (secureAssets.enabled()) return null;
  const stored = peekThumbnail(row);
  if (stored) return stored;
  if (!fs.existsSync(row.filepath)) return null;
  if (tsettings.storage() === 'memory' || tsettings.storage() === 'off') return null;
  const buf = await _makeCover(row);
  return buf ? coverPath(row.id) : null;
}

/** Scrub frame `idx` as a path (plain) per the settings, or null. */
async function getScrubFrame(row, idx) {
  const r = await lookupScrub(row, idx);
  return r.type === 'file' ? r.path : null;
}

/** Scrub frame `idx` as bytes per the settings, or null. */
async function getScrubFrameBuffer(row, idx) {
  const r = await lookupScrub(row, idx);
  if (r.type === 'buffer') return r.buf;
  if (r.type === 'file') { try { return fs.readFileSync(r.path); } catch { return null; } }
  return null;
}

/**
 * For the scan and import paths, where doing the work up front is the point.
 * "When shown" makes nothing here; a file whose own picture will be used gets
 * nothing made or stored for its cover.
 * @returns {Promise<boolean>} true when there is (or will be) a picture
 */
async function ensureThumbnail(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return false;
  if (_isLocked()) return false;
  const s = tsettings.get();
  if (!tsettings.scanMakes(s)) return false;
  const art = _artWanted(row, s) ? _artIndex(row) : null;
  if (art != null && art >= 0) return true;   // its own picture is used, nothing made
  try {
    if (_storedCover(row)) return true;
    if (!fs.existsSync(row.filepath)) return false;
    return !!(await _makeCover(row));
  } catch {
    return false;
  }
}

/**
 * A picture of the row for hashing (commands/phash.js), never stored and
 * never copied to a temp file: the stored cover when there is one (as bytes
 * in an encrypted library, as its path otherwise), else the original file,
 * videos seeked the same way the cover would be.
 * @returns {Promise<{buffer:Buffer}|{path:string, seek:number}|null>}
 */
async function pictureForHash(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return null;
  if (secureAssets.enabled()) {
    const buf = peekThumbnailBuffer(row);
    if (buf) return { buffer: buf };
  } else {
    const p = peekThumbnail(row);
    if (p) return { path: p, seek: 0 };
  }
  if (!fs.existsSync(row.filepath)) return null;
  const duration = row.duration_seconds || 0;
  const seek = row.media_type === 'video' && duration > 2 ? duration * config.thumbnails.videoSeekPercent : 0;
  return { path: row.filepath, seek };
}

/* ── Background generation queue ──────────────────────────────────────────
   Deduped by id. A media file that is not on disk is remembered so a grid
   full of missing rows asks once and then stops; a file whose render keeps
   failing is dropped after a couple of tries, so a broken file cannot burn
   the CPU on every page load. Both sets last for the life of the process.

   "For every file": two at a time, first come first served (today's queue).
   "When shown": four at a time, newest request first, so the tiles on screen
   now go before the ones scrolled past. A tile keeps asking while it waits;
   one that has not asked for STALE_MS was scrolled away and is dropped.
   Checks for a picture inside a file run only when nothing else is waiting. */

const QUEUE_CONCURRENCY_ALL = 2;
const QUEUE_CONCURRENCY_SHOWN = 4;
const STALE_MS = 15000;
const GENERATE_MAX_FAILURES = 2;

const _jobs = new Map();       // id -> { want, wanted, running, seq }
let _order = [];               // [id, seq] waiting for a picture (stale seq = moved)
let _seq = 0;
let _probeOrder = [];          // ids waiting only for the inside-picture check
const _skipIds = new Set();    // media file missing: never asked again
const _failCounts = new Map(); // id -> failed render attempts
let _running = 0;

/** Ids the queue will not touch again this session (missing or broken). */
function isThumbSkipped(id) {
  return _skipIds.has(id) || (_failCounts.get(id) || 0) >= GENERATE_MAX_FAILURES;
}

/**
 * Ask for a thumbnail to be built in the background.
 * @param {object} row
 * @param {'thumb'|'probe'} [want] probe = only check for a picture inside
 * @returns {'pending'|'queued'|'skipped'} skipped = the file is gone or the
 *   render has already failed too often; the caller should stop retrying.
 */
function enqueueThumbnail(row, want = 'thumb') {
  if (tsettings.get().make === 'off') return 'skipped';
  if (!row || !(THUMBABLE_TYPES.has(row.media_type) || _artWanted(row))) return 'skipped';
  if (isThumbSkipped(row.id)) return 'skipped';
  if (!fs.existsSync(row.filepath)) { _skipIds.add(row.id); return 'skipped'; }
  const now = Date.now();
  const j = _jobs.get(row.id);
  if (j) {
    j.wanted = now;
    if (want === 'thumb' && !j.running) {
      if (j.want === 'probe') {
        j.want = 'thumb';
        _queueThumb(row.id, j);
      } else if (tsettings.get().make === 'shown') {
        // Asked again: the tile is still on screen. Move it to the front
        // (the queue takes the newest entry first in this mode).
        _queueThumb(row.id, j);
      }
    }
    return 'queued';
  }
  const job = { want, wanted: now, running: false, seq: 0 };
  _jobs.set(row.id, job);
  if (want === 'probe') _probeOrder.push(row.id);
  else _queueThumb(row.id, job);
  _pumpQueue();
  return 'pending';
}

/** Put a job at the back of the order list; any older entry for it goes stale. */
function _queueThumb(id, job) {
  job.seq = ++_seq;
  _order.push([id, job.seq]);
  // Re-asks leave stale entries behind; drop them once they pile up.
  if (_order.length > 4 * _jobs.size + 256) {
    _order = _order.filter(([i, s]) => { const j = _jobs.get(i); return j && j.seq === s; });
  }
}

function _concurrency() {
  return tsettings.get().make === 'shown' ? QUEUE_CONCURRENCY_SHOWN : QUEUE_CONCURRENCY_ALL;
}

function _nextJob() {
  const shown = tsettings.get().make === 'shown';
  const now = Date.now();
  while (_order.length) {
    const [id, seq] = shown ? _order.pop() : _order.shift();
    const j = _jobs.get(id);
    if (!j || j.running || j.want !== 'thumb' || j.seq !== seq) continue;
    if (shown && now - j.wanted > STALE_MS) { _jobs.delete(id); continue; }
    return id;
  }
  while (_probeOrder.length) {
    const id = _probeOrder.shift();
    const j = _jobs.get(id);
    if (j && !j.running) return id;
  }
  return null;
}

function _pumpQueue() {
  while (_running < _concurrency()) {
    const id = _nextJob();
    if (id == null) return;
    const j = _jobs.get(id);
    j.running = true;
    _running++;
    const epoch = _epoch;
    // A job cut short by the vault locking is not a failure of the file.
    const failed = () => {
      if (epoch !== _epoch || _isLocked()) return;
      _failCounts.set(id, (_failCounts.get(id) || 0) + 1);
    };
    _runJob(id, j.want)
      .then((ok) => {
        if (!ok) failed();
        else _failCounts.delete(id);
      })
      .catch(failed)
      .finally(() => {
        _running--;
        if (_jobs.get(id) === j) _jobs.delete(id);
        _pumpQueue();
      });
  }
}

/** @returns {Promise<boolean>} true when the row now has its picture */
async function _runJob(id, want) {
  if (_isLocked()) return false;
  // Re-read the row: it may have been probed or moved since it was queued.
  const row = db.getById(id);
  if (!row) return false;
  if (_artWanted(row)) {
    if (_artIndex(row) == null) row.art_stream = await _detectArt(row);
    const art = _artIndex(row);
    if (art != null && art >= 0) {
      if (await _getArt(row)) return true;
      _artBroken.add(id);         // fall back to a made picture, like any file
    }
  }
  if (want === 'probe') return true;
  if (!THUMBABLE_TYPES.has(row.media_type)) return false;
  if (tsettings.storage() === 'off') return true;   // switched off while waiting
  if (_storedCover(row)) return true;
  if (tsettings.storage() === 'memory' && _mem().has(memKey(id, 'thumb'))) return true;
  return !!(await _makeCover(row));
}

/* ── "Keep up to N": the disk ledger, last-shown times, trimming ───────────
   The ledger (DiskUse) knows the bytes each media id has stored and when it
   was last shown. It is built once, on first need, from the thumbnail folder
   (file mtime = last shown) or the encrypted store (updated_at). Showing a
   tile updates it in memory at once and on disk in batches: a plain library
   touches the cover file's mtime, a locked one stamps updated_at. */

const PROTECT_MS = 5 * 60 * 1000;   // shown this recently = on screen: never removed
const TOUCH_FLUSH_MS = 30 * 1000;
const TRIM_EVERY_MS = 60 * 1000;
const TRIM_STEP = 500;              // ids removed per background pass

let _ledger = null;
let _ledgerState = 'none';          // none | building | ready
let _ledgerBuild = null;
const _ledgerDirty = new Set();
const _touched = new Set();
let _touchTimer = null;
let _trimTimer = null;
let _trimSoon = null;

function _capBytes() { return tsettings.get().diskCapMB * MB; }

/** Walk the plain thumbnail folder. Nothing outside it is looked at. */
async function _walkPlain({ withFaces = false } = {}) {
  const dir = config.paths.thumbnailDir;
  const out = {
    covers: { bytes: 0, count: 0 }, scrub: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 },
    perId: new Map(),            // id -> { bytes, seen }
    coverIds: [], scrubFrames: [],
  };
  let names = [];
  try { names = await fs.promises.readdir(dir); } catch { return out; }
  const work = [];
  for (const name of names) {
    let m;
    if ((m = RX_COVER.exec(name))) work.push(['covers', Number(m[1]), -1, name]);
    else if ((m = RX_SCRUB.exec(name))) work.push(['scrub', Number(m[1]), Number(m[2]), name]);
    else if (withFaces && RX_BEAT.test(name)) work.push(['other', 0, -1, name]);
  }
  if (withFaces) {
    const fdir = path.join(dir, 'faces');
    try {
      for (const n of await fs.promises.readdir(fdir)) work.push(['other', 0, -1, path.join('faces', n)]);
    } catch {}
  }
  for (let i = 0; i < work.length; i += 256) {
    const chunk = work.slice(i, i + 256);
    const stats = await Promise.all(chunk.map(([, , , n]) =>
      fs.promises.stat(path.join(dir, n)).catch(() => null)));
    chunk.forEach(([bucket, id, idx], k) => {
      const st = stats[k];
      if (!st || !st.isFile()) return;
      out[bucket].bytes += st.size;
      out[bucket].count++;
      if (bucket === 'other' || !Number.isSafeInteger(id) || id <= 0) return;
      if (bucket === 'covers') out.coverIds.push(id);
      else out.scrubFrames.push([id, idx]);
      const e = out.perId.get(id);
      if (e) { e.bytes += st.size; e.seen = Math.max(e.seen, st.mtimeMs); }
      else out.perId.set(id, { bytes: st.size, seen: st.mtimeMs });
    });
  }
  return out;
}

/** Stored bytes and last-shown time for one id, measured now. */
function _measureId(id) {
  if (secureAssets.enabled()) {
    const r = secureAssets.mediaSizes(THUMB_KINDS, id)[0];
    return r ? { bytes: r.bytes, seen: r.seen || 0 } : { bytes: 0, seen: 0 };
  }
  let bytes = 0;
  let seen = 0;
  for (const p of [coverPath(id), ...SCRUB_KINDS.map((_, i) => scrubPath(id, i))]) {
    try { const st = fs.statSync(p); bytes += st.size; seen = Math.max(seen, st.mtimeMs); } catch {}
  }
  return { bytes, seen };
}

// Bumped whenever the ledger is thrown away (lock, settings, a delete): a
// build that started before is stale, and must neither be installed nor be
// handed to anyone who asks after the reset.
let _ledgerGen = 0;

function _resetLedger() {
  _ledgerGen++;
  _ledger = null;
  _ledgerState = 'none';
  _ledgerBuild = null;
  _ledgerDirty.clear();
}

function _ensureLedger() {
  if (_isLocked()) return Promise.resolve(null);
  // Never measured while a delete runs: it would count what is going away.
  if (_deleting || _deleteRun) return Promise.resolve(null);
  if (_ledgerState === 'ready') return Promise.resolve(_ledger);
  if (_ledgerBuild) return _ledgerBuild;
  _ledgerState = 'building';
  const gen = _ledgerGen;
  const build = (async () => {
    const led = new DiskUse({ protectMs: PROTECT_MS });
    if (secureAssets.enabled()) {
      // In slices with yields: one statement over 900k rows held the server for ~0.75 s.
      const rows = await secureAssets.mediaSizesAsync(THUMB_KINDS);
      if (!rows) return null;
      for (const r of rows) led.add(r.media_id, r.bytes, r.seen || 0);
    } else {
      const w = await _walkPlain();
      for (const [id, e] of w.perId) led.add(id, e.bytes, e.seen);
    }
    if (gen !== _ledgerGen) return STALE;
    for (const id of _ledgerDirty) {
      const m = _measureId(id);
      led.set(id, m.bytes, Math.max(m.seen, Date.now()));
    }
    _ledgerDirty.clear();
    _ledger = led;
    _ledgerState = 'ready';
    return led;
  })().catch((err) => {
    console.warn(`[Thumbnails] could not measure stored thumbnails: ${err.message}`);
    if (gen === _ledgerGen) _ledgerState = 'none';
    return null;
  }).then((led) => {
    if (_ledgerBuild === promise) _ledgerBuild = null;
    // Reset while building: measure again for whoever was waiting.
    if (led === STALE) return _ensureLedger();
    if (led == null && gen === _ledgerGen && _ledgerState === 'building') _ledgerState = 'none';
    return led;
  });
  const promise = build;
  _ledgerBuild = promise;
  return promise;
}
const STALE = Symbol('stale ledger');

/** A cover or frame was just stored for `id` (disk-limit mode). */
function _ledgerNote(id) {
  if (_ledgerState === 'ready') {
    const m = _measureId(id);
    _ledger.set(id, m.bytes, Date.now());
  } else {
    _ledgerDirty.add(id);
    _ensureLedger();
  }
  _startTrimTimer();
  if (!_trimSoon) {
    _trimSoon = setTimeout(() => { _trimSoon = null; trimToCap({ max: 100 }).catch(() => {}); }, 2000);
    if (_trimSoon.unref) _trimSoon.unref();
  }
}

/** A stored picture was just shown. Only tracked under the disk limit. */
function _noteShown(id, storage) {
  if (storage !== 'cap') return;
  if (_ledgerState === 'ready') _ledger.touch(id);
  else _ensureLedger();
  _touched.add(id);
  _startTrimTimer();
  if (!_touchTimer) {
    _touchTimer = setTimeout(() => { _touchTimer = null; _flushTouches(); }, TOUCH_FLUSH_MS);
    if (_touchTimer.unref) _touchTimer.unref();
  }
}

function _flushTouches() {
  if (!_touched.size) return;
  if (_isLocked()) { _touched.clear(); return; }
  const ids = [..._touched];
  _touched.clear();
  try {
    if (secureAssets.enabled()) {
      secureAssets.touchMany(ids, 'thumb');
    } else {
      const now = new Date();
      for (const id of ids) fs.utimes(coverPath(id), now, now, () => {});
    }
  } catch { /* a missed touch only makes a picture look older than it is */ }
}

function _startTrimTimer() {
  if (_trimTimer || _isLocked()) return;
  _trimTimer = setInterval(() => {
    if (tsettings.storage() !== 'cap' || _isLocked()) { _stopTrimTimers(); return; }
    trimToCap({ max: TRIM_STEP }).catch(() => {});
  }, TRIM_EVERY_MS);
  if (_trimTimer.unref) _trimTimer.unref();
}

function _stopTrimTimers() {
  if (_trimTimer) { clearInterval(_trimTimer); _trimTimer = null; }
  if (_trimSoon) { clearTimeout(_trimSoon); _trimSoon = null; }
  if (_touchTimer) { clearTimeout(_touchTimer); _touchTimer = null; }
}

// Deleting is done in small batches with a yield between them, so clearing a
// huge library never holds the server still (each unlink is a syscall).
const DELETE_BATCH = 64;
const _yield = () => new Promise(r => setImmediate(r));

/** Unlink paths a batch at a time, in parallel within a batch. @returns {Promise<number>} unlinked */
async function _unlinkAll(paths, epoch = _epoch) {
  let n = 0;
  for (let i = 0; i < paths.length; i += DELETE_BATCH) {
    if (epoch !== _epoch || _isLocked()) break;
    const res = await Promise.all(paths.slice(i, i + DELETE_BATCH)
      .map(p => fs.promises.unlink(p).then(() => 1, () => 0)));
    for (const r of res) n += r;
    await _yield();
  }
  return n;
}

/** Remove these ids' stored covers and frames. Never anything else. */
async function _evictStored(ids, epoch) {
  const list = ids.map(_id);
  if (secureAssets.enabled()) {
    // One commit per slice, not per id, and each slice stops after a few ms
    // (secure_delete makes a stored picture slow to remove), with a yield
    // between slices so the server keeps answering.
    let i = 0;
    while (i < list.length) {
      if (epoch !== _epoch || _isLocked()) return;
      const done = secureAssets.deleteKindsMany(THUMB_KINDS, list.slice(i, i + DELETE_BATCH));
      if (!done) return;              // store sealed or gone
      i += done;
      await _yield();
    }
    return;
  }
  const paths = [];
  for (const n of list) paths.push(coverPath(n), ...SCRUB_KINDS.map((_, i) => scrubPath(n, i)));
  await _unlinkAll(paths, epoch);
}

let _trimming = null;
/**
 * Bring stored thumbnails under the disk limit, least recently shown first,
 * never one shown in the last few minutes. Down to 95% of the limit so it does
 * not run again for every new picture.
 * @param {{max?: number}} [opts] max ids removed in this pass (Infinity = all)
 * @returns {Promise<{removed:number, bytes:number}>}
 */
function trimToCap({ max = TRIM_STEP } = {}) {
  // One at a time; a call made during a pass runs its own pass after it.
  if (_trimming) return _trimming.then(() => trimToCap({ max }));
  _trimming = (async () => {
    const none = { removed: 0, bytes: 0 };
    if (_isLocked() || tsettings.storage() !== 'cap') return none;
    const epoch = _epoch;
    const led = await _ensureLedger();
    if (!led || epoch !== _epoch || _isLocked()) return none;
    _flushTouches();
    const cap = _capBytes();
    if (led.total <= cap) return none;
    if (!secureAssets.enabled() && !ownedDir.guardSweep(config.paths.thumbnailDir, 'thumbnail disk limit')) {
      return none;
    }
    const victims = led.victims(Math.floor(cap * 0.95), max);
    let bytes = 0;
    let removed = 0;
    for (let i = 0; i < victims.length; i += DELETE_BATCH) {
      if (epoch !== _epoch || _isLocked()) break;
      const chunk = victims.slice(i, i + DELETE_BATCH);
      await _evictStored(chunk, epoch);
      if (epoch !== _epoch || _isLocked()) break;
      for (const id of chunk) bytes += led.remove(id);
      try { db.clearThumbnailPaths(chunk); } catch {}
      removed += chunk.length;
    }
    _spaceCache = null;
    return { removed, bytes };
  })().finally(() => { _trimming = null; });
  return _trimming;
}

/**
 * What trimToCap would remove right now, without removing anything (the
 * "Remove saved thumbnails?" dialog names this number).
 * @returns {Promise<{bytes:number, count:number}>}
 */
async function trimEstimate() {
  if (_isLocked() || tsettings.storage() !== 'cap') return { bytes: 0, count: 0 };
  const led = await _ensureLedger();
  if (!led) return { bytes: 0, count: 0 };
  const victims = led.victims(Math.floor(_capBytes() * 0.95));
  let bytes = 0;
  for (const id of victims) bytes += led.items.get(id).bytes;
  return { bytes, count: victims.length };
}

/* ── Space used and cleanup ────────────────────────────────────────────── */

let _deleting = null;   // progress of the delete running now: { what, done, total }
let _deleteRun = null;  // the newest delete asked for: { what, promise }

/**
 * Progress of a running delete, or null. done never passes total: in an
 * encrypted library a picture made during the delete can add rows to remove.
 */
function deleteProgress() {
  if (!_deleting && !_deleteRun) return null;
  const p = _deleting || { what: _deleteRun.what, done: 0, total: 0 };
  const total = Math.max(p.total, p.done);
  return { what: _deleteRun ? _deleteRun.what : p.what, done: Math.min(p.done, total), total };
}

/**
 * What thumbnails take up right now: covers, hover frames, and other derived
 * files (face crops, beat audio; shown, never deleted here), plus memory.
 */
const SPACE_CACHE_MS = 10 * 1000;
let _spaceCache = null;     // { at, promise }

async function spaceUsed() {
  if (_isLocked()) throw Object.assign(new Error('vault is locked'), { code: 'VAULT_LOCKED' });
  const now = Date.now();
  // Opening the fold-out twice in a row must not walk a 2M-file folder twice.
  if (!_spaceCache || now - _spaceCache.at > SPACE_CACHE_MS) {
    const p = _measureStored();
    _spaceCache = { at: now, promise: p };
    p.catch(() => { if (_spaceCache && _spaceCache.promise === p) _spaceCache = null; });
  }
  const stored = await _spaceCache.promise;
  const mem = _mem();
  return {
    ...stored,
    memory: {
      ...mem.stats((k) => _memKind(k) !== 'art'),
      art: mem.stats((k) => _memKind(k) === 'art'),
      max: mem.maxBytes,
    },
  };
}

async function _measureStored() {
  const mem = _mem();
  const memory = {
    ...mem.stats((k) => _memKind(k) !== 'art'),
    art: mem.stats((k) => _memKind(k) === 'art'),
    max: mem.maxBytes,
  };
  const out = {
    encrypted: secureAssets.enabled(),
    covers: { bytes: 0, count: 0 }, scrub: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 },
    memory,
  };
  if (secureAssets.enabled()) {
    const kinds = await secureAssets.sizesByKindAsync();   // in slices, see secure-assets
    if (!kinds) throw Object.assign(new Error('vault is locked'), { code: 'VAULT_LOCKED' });
    for (const r of kinds) {
      const k = String(r.kind);
      const bucket = k === 'thumb' ? out.covers
        : SCRUB_KINDS.includes(k) ? out.scrub
          : (k.startsWith('face-') || k.startsWith('beataudio')) ? out.other : null;
      if (!bucket) continue;
      bucket.bytes += r.bytes || 0;
      bucket.count += r.count || 0;
    }
  } else {
    const w = await _walkPlain({ withFaces: true });
    out.covers = w.covers;
    out.scrub = w.scrub;
    out.other = w.other;
  }
  return out;
}

/**
 * Delete stored hover frames ('scrub') or covers and hover frames ('all').
 * Face crops, beat audio and media files are never touched: plain mode only
 * unlinks {id}.jpg / {id}_s{n}.jpg rebuilt from parsed integer ids, in the
 * app-owned thumbnail folder; vault mode deletes only the literal kinds.
 * @returns {Promise<{bytes:number, count:number}>}
 */
function deleteStored(what) {
  if (what !== 'scrub' && what !== 'all') return Promise.reject(new Error('what must be "scrub" or "all"'));
  if (_isLocked()) return Promise.reject(Object.assign(new Error('vault is locked'), { code: 'VAULT_LOCKED' }));
  // One delete at a time. Asking again for what is already being done (or for
  // hover frames while everything goes) joins the running one; anything else
  // waits for it and runs after.
  if (_deleteRun && (_deleteRun.what === what || _deleteRun.what === 'all')) return _deleteRun.promise;
  const before = _deleteRun ? _deleteRun.promise.catch(() => {}) : Promise.resolve();
  const run = { what, promise: null };
  run.promise = before
    .then(() => _deleteStoredNow(what))
    .finally(() => { if (_deleteRun === run) _deleteRun = null; });
  _deleteRun = run;
  return run.promise;
}

async function _deleteStoredNow(what) {
  const kinds = what === 'all' ? THUMB_KINDS : SCRUB_KINDS;
  let bytes = 0;
  let count = 0;

  if (_isLocked()) throw Object.assign(new Error('vault is locked'), { code: 'VAULT_LOCKED' });
  const epoch = _epoch;
  _spaceCache = null;
  const prog = { what, done: 0, total: 0 };
  _deleting = prog;
  _resetLedger();             // a build in flight would count what is about to go
  try {
    if (secureAssets.enabled()) {
      for (const r of (await secureAssets.sizesByKindAsync()) || []) {
        if (kinds.includes(r.kind)) { bytes += r.bytes || 0; count += r.count || 0; }
      }
      prog.total = count;
      // Many short statements, a yield between each, so the server keeps answering.
      for (;;) {
        if (epoch !== _epoch || _isLocked()) break;
        const n = secureAssets.deleteKindsStep(kinds, 500);
        prog.done += n;
        if (!n) break;
        await _yield();
      }
    } else if (ownedDir.guardSweep(config.paths.thumbnailDir, 'delete thumbnails')) {
      const w = await _walkPlain();
      bytes = w.scrub.bytes + (what === 'all' ? w.covers.bytes : 0);
      count = w.scrub.count + (what === 'all' ? w.covers.count : 0);
      const paths = w.scrubFrames.map(([id, idx]) => scrubPath(id, idx));
      if (what === 'all') for (const id of w.coverIds) paths.push(coverPath(id));
      prog.total = paths.length;
      for (let i = 0; i < paths.length; i += DELETE_BATCH * 16) {
        if (epoch !== _epoch || _isLocked()) break;
        prog.done += await _unlinkAll(paths.slice(i, i + DELETE_BATCH * 16), epoch);
      }
    }
    if (what === 'all' && epoch === _epoch && !_isLocked()) {
      try {
        while (db.clearThumbnailPaths('step') > 0) {
          if (epoch !== _epoch || _isLocked()) break;
          await _yield();
        }
      } catch {}
    }
  } finally {
    if (_deleting === prog) _deleting = null;
    _spaceCache = null;
  }

  const mem = _mem();
  mem.deleteWhere((k) => {
    const kind = _memKind(k);
    return what === 'all' ? true : /^s[0-4]$/.test(kind);
  });
  // The ledger is measured again on next need.
  _resetLedger();
  return { bytes, count };
}

/* ── Lifecycle ─────────────────────────────────────────────────────────── */

/**
 * Drop everything held in memory: pictures, the queue, the disk ledger.
 * Called when the vault locks (nothing decrypted may outlive the lock).
 */
function clearMemory() {
  _epoch++;
  _stopTrimTimers();
  _spaceCache = null;
  if (_memCache) _memCache.clear();
  _jobs.clear();
  _order = [];
  _probeOrder = [];
  _resetLedger();
  _touched.clear();
}

/** The vault unlocked: the disk-limit trim picks up again. */
function onUnlock() {
  if (tsettings.storage() === 'cap') _startTrimTimer();
}

/** Forget ids whose records were removed (memory, queue, ledger). */
function forgetIds(ids) {
  const set = new Set((ids || []).map(Number));
  if (!set.size) return;
  if (_memCache) _memCache.deleteWhere((k) => set.has(Number(k.slice(0, k.indexOf(':')))));
  for (const id of set) {
    _jobs.delete(id);
    if (_ledger) _ledger.remove(id);
    _touched.delete(id);
  }
}

/**
 * These files changed on disk (folder watchers): drop every picture made from
 * the old copy (cover, hover frames, picture inside, in memory and stored),
 * forget past failures, and make the cover again per the settings ("For
 * every file" makes it now; "When shown" waits for the tile; "Off" nothing).
 * Hover frames are made again when next hovered.
 */
async function refreshIds(ids) {
  const list = [...new Set((ids || []).map(Number))].filter(Number.isInteger);
  if (!list.length || _isLocked()) return;
  forgetIds(list);
  for (const id of list) { _skipIds.delete(id); _failCounts.delete(id); _artBroken.delete(id); }
  await _evictStored(list, _epoch);
  if (_isLocked()) return;
  try { db.clearThumbnailPaths(list); } catch {}
  if (!tsettings.scanMakes()) return;
  for (const id of list) {
    try { enqueueThumbnail(db.getById(id)); } catch {}
  }
}

/** The settings just changed: resize the memory cache, start or stop trimming. */
function settingsChanged(prev, next) {
  _mem().setMax(next.memoryMB * MB);
  if (next.make === 'off') {
    // Off: nothing waits in the queue and nothing is held in memory.
    _jobs.clear(); _order = []; _probeOrder = [];
    if (_memCache) _memCache.clear();
  }
  const before = tsettings.storage(prev);
  const after = tsettings.storage(next);
  if (before === 'memory' && after !== 'memory' && _memCache) {
    _memCache.deleteWhere((k) => _memKind(k) !== 'art');
  }
  if (!next.inside && _memCache) _memCache.deleteWhere((k) => _memKind(k) === 'art');
  if (!next.hover && _memCache) _memCache.deleteWhere((k) => /^s[0-4]$/.test(_memKind(k)));
  if (after === 'cap') {
    _startTrimTimer();
    trimToCap({ max: TRIM_STEP }).catch(() => {});
  } else {
    _stopTrimTimers();
  }
  _spaceCache = null;
  if (after !== 'cap') { _resetLedger(); _touched.clear(); }
}

/** How long a browser may keep a /thumb or /scrub answer. */
function cacheControl(req) {
  if (secureAssets.enabled()) return 'no-store';
  const storage = tsettings.storage();
  // Memory mode: nothing on disk, the browser's disk cache included.
  if (storage === 'memory') return 'no-store';
  // Disk limit: the browser revalidates, so every showing reaches the server
  // and counts as "shown" (a 304 costs next to nothing on localhost).
  if (storage === 'cap') return 'no-cache';
  return req && req.query && req.query.v ? 'private, max-age=31536000, immutable' : 'no-cache';
}

module.exports = {
  // routes
  lookupThumb, lookupScrub, cacheControl,
  spaceUsed, deleteStored, deleteProgress, trimToCap, trimEstimate, clearMemory, onUnlock, forgetIds, refreshIds, settingsChanged,
  setLockProbe,
  // older callers
  getThumbnail, getScrubFrame,
  getThumbnailBuffer, getScrubFrameBuffer,
  peekThumbnail, peekThumbnailBuffer,
  enqueueThumbnail, isThumbSkipped, ensureThumbnail, pictureForHash,
  coverPath, scrubPath,
  SCRUB_COUNT, THUMBABLE_TYPES, THUMB_KINDS, SCRUB_KINDS,
  // tests
  _setRenderer, _setArtProber, _mem, _ensureLedger,
  _ledgerForTest: () => _ledger, _queueForTest: () => ({ jobs: _jobs, order: _order, probe: _probeOrder, running: _running }),
  _flushTouches,
  _timersForTest: () => ({ trim: !!_trimTimer, trimSoon: !!_trimSoon, touch: !!_touchTimer }),
};
