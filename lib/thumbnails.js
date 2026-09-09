/**
 * Thumbnail generation + cache.
 *
 * All thumbnails are generated with ffmpeg (already a hard dependency of the
 * tagger — no need for sharp): images/gifs are downscaled, videos get a frame
 * seeked a configurable percentage into the file. Generated lazily on first
 * /thumb/:id request.
 *
 * Storage depends on vault mode (lib/secure-assets):
 *  - vault OFF: cached to config.paths.thumbnailDir as {id}.jpg / {id}_s{n}.jpg,
 *    the path stored in media.thumbnail_path — byte-for-byte the old behavior.
 *  - vault ON:  ffmpeg still needs a real file, so we render into the (wiped)
 *    temp dir, read the bytes into secure_assets.db, and delete the temp file.
 *    Nothing derived is left in plaintext under thumbnailDir. Callers that need
 *    bytes use the *Buffer helpers; the path-returning helpers materialize a
 *    throwaway temp copy for the rare filesystem consumer (e.g. phash CLI).
 *
 * Audio / documents / 3D models return null — the viewer shows a type icon.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./database');
const proc = require('./proc');
const secureAssets = require('./secure-assets');
const ownedDir = require('./owned-dir');

const THUMBABLE_TYPES = new Set(['image', 'gif', 'video']);
const SCRUB_COUNT = 5;

// In-flight generation guard: concurrent requests for the same id/kind await one job
const inFlight = new Map();

function ensureThumbDir() {
  // Stamp the app-owned marker so record-delete sidecar unlinks are permitted
  // in this dir (they're gated on the marker). Adoption is conditional — a dir
  // holding unrecognized user files is left unmarked (see lib/owned-dir.js).
  ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs');
}

function ensureTempDir() {
  ownedDir.ensureManaged(config.paths.tempDir, 'temp');
}

/* ── ffmpeg render helpers (write a jpg to `outPath`, return success bool) ── */

async function _renderThumb(row, outPath) {
  const width = config.thumbnails.width;
  const quality = config.thumbnails.jpegQuality;
  const args = ['-y'];

  if (row.media_type === 'video') {
    // Seek into the video so we don't thumbnail a black intro frame
    const duration = row.duration_seconds || 0;
    const seekTo = duration > 2 ? duration * config.thumbnails.videoSeekPercent : 0;
    if (seekTo > 0) args.push('-ss', seekTo.toFixed(2));
  }

  args.push(
    '-i', row.filepath,
    '-vframes', '1',
    '-vf', `scale='min(${width},iw)':-1`,
    '-q:v', String(quality),
    outPath
  );

  try {
    await proc.run('ffmpeg', args, { timeout: 60000 });
  } catch (err) {
    console.warn(`  Thumbnail failed for ${row.filename}: ${err.message}`);
    return false;
  }
  return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
}

async function _renderScrub(row, idx, outPath) {
  const duration = row.duration_seconds || 0;
  const seekTo = duration * ((idx + 1) / (SCRUB_COUNT + 1));
  try {
    await proc.run('ffmpeg', [
      '-y', '-ss', seekTo.toFixed(2), '-i', row.filepath,
      '-vframes', '1',
      '-vf', `scale='min(${config.thumbnails.width},iw)':-1`,
      '-q:v', String(config.thumbnails.jpegQuality),
      outPath
    ], { timeout: 60000 });
  } catch (err) {
    return false;
  }
  return fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
}

/* ── Vault-mode buffer API (bytes straight from / into secure_assets.db) ──── */

/**
 * Get (or lazily generate) the thumbnail BYTES for a media row from the secure
 * store. Only meaningful when vault mode is on.
 * @returns {Promise<Buffer|null>}
 */
async function getThumbnailBuffer(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return null;

  const cached = secureAssets.get(row.id, 'thumb', '');
  if (cached) return cached;
  if (!fs.existsSync(row.filepath)) return null;

  const key = `thumbbuf:${row.id}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    ensureTempDir();
    const tmp = path.join(config.paths.tempDir, `thumb_${row.id}_${process.pid}_${Date.now()}.jpg`);
    const ok = await _renderThumb(row, tmp);
    if (!ok) { try { fs.unlinkSync(tmp); } catch {} return null; }
    const buf = fs.readFileSync(tmp);
    secureAssets.put(row.id, 'thumb', buf, '');
    try { db.bumpThumbVersion(row.id); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    return buf;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/**
 * Get (or lazily generate) scrub frame `idx` BYTES for a video row from the
 * secure store. Only meaningful when vault mode is on.
 * @returns {Promise<Buffer|null>}
 */
async function getScrubFrameBuffer(row, idx) {
  if (!row || row.media_type !== 'video') return null;
  if (!Number.isInteger(idx) || idx < 0 || idx >= SCRUB_COUNT) return null;
  const duration = row.duration_seconds || 0;
  if (duration < 3) return null;

  const kind = `scrub${idx}`;
  const cached = secureAssets.get(row.id, kind, '');
  if (cached) return cached;
  if (!fs.existsSync(row.filepath)) return null;

  const key = `scrubbuf:${row.id}:${idx}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    ensureTempDir();
    const tmp = path.join(config.paths.tempDir, `scrub_${row.id}_${idx}_${process.pid}_${Date.now()}.jpg`);
    const ok = await _renderScrub(row, idx, tmp);
    if (!ok) { try { fs.unlinkSync(tmp); } catch {} return null; }
    const buf = fs.readFileSync(tmp);
    secureAssets.put(row.id, kind, buf, '');
    try { fs.unlinkSync(tmp); } catch {}
    return buf;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/* ── Path API (non-vault filesystem cache; vault mode materializes a temp) ── */

/**
 * Get (or lazily generate) the thumbnail for a media row.
 * @returns {Promise<string|null>} absolute path to a readable JPEG, or null
 */
async function getThumbnail(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return null;

  if (secureAssets.enabled()) {
    // Bytes live encrypted; hand filesystem consumers a throwaway temp copy.
    const buf = await getThumbnailBuffer(row);
    if (!buf) return null;
    ensureTempDir();
    const p = path.join(config.paths.tempDir, `thumb_${row.id}.jpg`);
    try { fs.writeFileSync(p, buf); } catch { return null; }
    return p;
  }

  // Cached and still on disk?
  if (row.thumbnail_path && fs.existsSync(row.thumbnail_path)) {
    return row.thumbnail_path;
  }
  if (!fs.existsSync(row.filepath)) return null;

  if (inFlight.has(row.id)) return inFlight.get(row.id);
  const job = generate(row).finally(() => inFlight.delete(row.id));
  inFlight.set(row.id, job);
  return job;
}

// Non-vault only: render into thumbnailDir and remember the path.
async function generate(row) {
  ensureThumbDir();
  const outPath = path.join(config.paths.thumbnailDir, `${row.id}.jpg`);
  const ok = await _renderThumb(row, outPath);
  if (!ok) return null;
  db.setThumbnailPath(row.id, outPath);
  return outPath;
}

/**
 * Get (or lazily generate) scrub frame `idx` (0-based) for a video row.
 * @returns {Promise<string|null>} absolute path, or null if not applicable
 */
async function getScrubFrame(row, idx) {
  if (!row || row.media_type !== 'video') return null;
  if (!Number.isInteger(idx) || idx < 0 || idx >= SCRUB_COUNT) return null;

  const duration = row.duration_seconds || 0;
  if (duration < 3) return null; // too short to scrub — thumb is enough

  if (secureAssets.enabled()) {
    const buf = await getScrubFrameBuffer(row, idx);
    if (!buf) return null;
    ensureTempDir();
    const p = path.join(config.paths.tempDir, `scrub_${row.id}_${idx}.jpg`);
    try { fs.writeFileSync(p, buf); } catch { return null; }
    return p;
  }

  const outPath = path.join(config.paths.thumbnailDir, `${row.id}_s${idx}.jpg`);
  if (fs.existsSync(outPath)) return outPath;
  if (!fs.existsSync(row.filepath)) return null;

  const key = `${row.id}_s${idx}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    ensureThumbDir();
    const ok = await _renderScrub(row, idx, outPath);
    return ok ? outPath : null;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, job);
  return job;
}

/* ── Peek: is there a thumbnail RIGHT NOW? ────────────────────────────────
   The /thumb route answers a browser that is waiting on an <img>, so it must
   never run ffmpeg. These two look, and only look; when they come back empty
   the route replies 404 + X-Thumb: pending and enqueues the work below. */

/**
 * The cached thumbnail file for a row, without generating one.
 * Plain (non-vault) mode only.
 * @returns {string|null} absolute path, or null if it is not on disk yet
 */
function _backfillVersion(id, file) {
  try { db.bumpThumbVersion(id, fs.statSync(file).mtimeMs / 1000); } catch {}
}

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
  const p = path.join(config.paths.thumbnailDir, `${row.id}.jpg`);
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

/* ── Background generation queue ──────────────────────────────────────────
   Two ffmpeg runs at a time, deduped by id. A media file that is not on disk
   is remembered so a grid full of missing rows asks once and then stops; a
   file whose render keeps failing is dropped after a couple of tries, so a
   broken file cannot burn the CPU on every page load. Both sets last for the
   life of the process, which is the "once per session" the spec asks for. */

const QUEUE_CONCURRENCY = 2;
const GENERATE_MAX_FAILURES = 2;

const _queued = new Set();     // ids waiting or running
const _pendingIds = [];        // FIFO of ids waiting
const _skipIds = new Set();    // media file missing: never asked again
const _failCounts = new Map(); // id -> failed render attempts
let _running = 0;

/** Ids the queue will not touch again this session (missing or broken). */
function isThumbSkipped(id) {
  return _skipIds.has(id) || (_failCounts.get(id) || 0) >= GENERATE_MAX_FAILURES;
}

/**
 * Ask for a thumbnail to be built in the background.
 * @returns {'pending'|'queued'|'skipped'} skipped = the file is gone or the
 *   render has already failed too often; the caller should stop retrying.
 */
function enqueueThumbnail(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return 'skipped';
  if (isThumbSkipped(row.id)) return 'skipped';
  if (!fs.existsSync(row.filepath)) { _skipIds.add(row.id); return 'skipped'; }
  if (_queued.has(row.id)) return 'queued';
  _queued.add(row.id);
  _pendingIds.push(row.id);
  _pumpQueue();
  return 'pending';
}

function _pumpQueue() {
  while (_running < QUEUE_CONCURRENCY && _pendingIds.length) {
    const id = _pendingIds.shift();
    _running++;
    (async () => {
      // Re-read the row: it may have been probed or moved since it was queued.
      const fresh = db.getById(id);
      if (!fresh) return null;
      return secureAssets.enabled()
        ? await getThumbnailBuffer(fresh)
        : await getThumbnail(fresh);
    })()
      .then((out) => {
        if (!out) _failCounts.set(id, (_failCounts.get(id) || 0) + 1);
        else _failCounts.delete(id);
      })
      .catch(() => { _failCounts.set(id, (_failCounts.get(id) || 0) + 1); })
      .finally(() => {
        _running--;
        _queued.delete(id);
        _pumpQueue();
      });
  }
}

/**
 * Generate the thumbnail now and wait for it. For the scan and import paths,
 * where doing the work up front is the point: on-demand generation should be
 * the exception, not how every library fills in.
 */
async function ensureThumbnail(row) {
  if (!row || !THUMBABLE_TYPES.has(row.media_type)) return false;
  try {
    const out = secureAssets.enabled()
      ? await getThumbnailBuffer(row)
      : await getThumbnail(row);
    return !!out;
  } catch {
    return false;
  }
}

module.exports = {
  getThumbnail, getScrubFrame,
  getThumbnailBuffer, getScrubFrameBuffer,
  peekThumbnail, peekThumbnailBuffer,
  enqueueThumbnail, isThumbSkipped, ensureThumbnail,
  SCRUB_COUNT, THUMBABLE_TYPES,
};
