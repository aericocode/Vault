/**
 * Recording files in place: the body of POST /api/import/add-paths, shared
 * with the folder watchers (lib/watchers/) so a watched folder adds a file
 * exactly the way Add files / Add folder does.
 *
 *   addPaths(paths, opts)   stub rows ('unscanned', playable at once), then
 *                           the AI scan queue (lib/import-queue.js, fresh)
 *                           unless opts.analyse is false ("Add only")
 *   probeAndThumb(added)    background: one ffprobe per audio/video file
 *                           (duration, size, codecs) and a thumbnail per the
 *                           thumbnail settings
 *   refreshFiles(ids)       a file changed in place: probe it again and make
 *                           its thumbnail and hover frames again
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('./database');
const importQueue = require('./import-queue');
const thumbnails = require('./thumbnails');
const thumbSettings = require('./thumb-settings');

/**
 * The media type a path is recorded as, or null when Vault does not import it.
 * Default types first (video/image/gif): the video processor also claims
 * image/gif extensions in the registry, so getProcessorMediaType would tag an
 * imported .png/.gif as 'video'. getMediaType returns the true type for those;
 * the registry covers audio/document.
 */
function mediaTypeOf(p) {
  const ext = path.extname(p).toLowerCase();
  return config.getMediaType(ext) || config.getProcessorMediaType(ext);
}

/**
 * @param {string[]} paths
 * @param {object} [opts]
 * @param {boolean} [opts.analyse=true]  queue the AI scan (false = Add only)
 * @param {boolean} [opts.watchNew=false] mark rows New (a watcher added them)
 * @param {Map<string,{size,mtimeMs}>} [opts.stats] sizes already known (skips a stat)
 * @returns {{added: Array<{id, mediaType, row}>, skipped: {unsupported, existing, missing}, queued: boolean}}
 */
function addPaths(paths, { analyse = true, watchNew = false, stats = null } = {}) {
  const added = [];
  let unsupported = 0, existing = 0, missing = 0;
  const stubs = [];
  const seen = new Set();                 // one row per file, whatever case each spelling uses
  for (const p of paths) {
    // NTFS-style folding (é/É meet, ß/ẞ stay apart), as the watchers key paths.
    const key = WIN ? require('./watchers/rules').foldCase(p.replace(/\//g, '\\')) : p;
    if (seen.has(key)) { existing++; continue; }
    seen.add(key);
    const mediaType = mediaTypeOf(p);
    if (!mediaType) { unsupported++; continue; }
    const known = stats && stats.get(p);
    if (!known && !fs.existsSync(p)) { missing++; continue; }
    // Windows paths ignore case (a.jpg and A.JPG, été and ÉTÉ, are one file,
    // one row), and some older rows were recorded with forward slashes:
    // store.rowAt looks every one of those ways.
    if (db.getByPath(p) || (WIN && require('./watchers/store').rowAt(p))) {
      existing++;
      continue;
    }
    stubs.push({ path: p, name: path.basename(p), mediaType, size: known?.size, mtimeMs: known?.mtimeMs, quickHash: known?.hash || null, watchNew });
  }
  if (stubs.length) db.insertStubs(stubs);

  for (const s of stubs) {
    const row = db.getByPath(s.path);
    if (!row) continue;
    added.push({ id: row.id, mediaType: s.mediaType, row });
    // fresh: a brand-new row, which the face auto-index hook acts on
    if (analyse) {
      importQueue.enqueue({ id: row.id, filepath: s.path, filename: row.filename, mediaType: s.mediaType, fresh: true });
    }
  }
  return { added, skipped: { unsupported, existing, missing }, queued: !!analyse };
}

/**
 * Is ffprobe there? media-info's check runs `ffprobe -version` synchronously
 * (about 200 ms of a blocked server on Windows), so a watcher adding batch
 * after batch asks once a minute, and only when a batch has audio or video.
 */
const PROBE_CHECK_MS = 60 * 1000;
let _probeCheck = { at: 0, ok: false };
function probeAvailable(mediaInfo) {
  const now = Date.now();
  if (now - _probeCheck.at > PROBE_CHECK_MS) _probeCheck = { at: now, ok: mediaInfo.isAvailable() };
  return _probeCheck.ok;
}
const PROBED = ['video', 'audio', 'gif'];
const WIN = process.platform === 'win32';

/**
 * Background probe + thumbnails for rows just added, one file at a time,
 * fully detached from any response. Errors are cosmetic only.
 * @param {Array<{id, mediaType, row}>} added
 * @param {{isLocked?: Function, requireProbe?: boolean}} [opts] requireProbe:
 *   with no ffprobe, make nothing at all (Add files / Add folder have always
 *   done this; the watchers still make thumbnails for pictures)
 */
async function probeAndThumb(added, { isLocked = () => false, requireProbe = false } = {}) {
  try {
    const mediaInfo = require('./media-info');
    if (requireProbe && !probeAvailable(mediaInfo)) return;
    if (added.some(a => PROBED.includes(a.mediaType)) && probeAvailable(mediaInfo)) {
      for (const a of added) {
        if (isLocked()) return;
        if (!PROBED.includes(a.mediaType)) continue;
        try {
          // One ffprobe now covers the tile (duration/size) AND the playback
          // decision (codecs), so a freshly imported file never has to be
          // probed again on its first play.
          const info = await mediaInfo.getStreamInfo(a.row.filepath);
          if (info && !isLocked()) db.saveStreamInfo(a.id, info);
        } catch { /* per-file probe failure is fine */ }
      }
    }
    // Thumbnails for everything just added, whatever type. The scan pass
    // makes them too, but the import queue may be paused or hours behind,
    // and a new tile should not sit on a placeholder until then.
    // ("When shown" and "Off" make nothing here; see lib/thumb-settings.)
    if (thumbSettings.scanMakes()) {
      for (const a of added) {
        if (isLocked()) return;
        try { thumbnails.enqueueThumbnail(db.getById(a.id)); } catch {}
      }
    }
    // The quick fingerprint (lib/watchers/fingerprint.js) for rows that came
    // without one (Add files / Add folder), so a later move or rename of
    // these files can be told apart from a different file of the same size.
    // Not on network shares (week 3): reads there can hang a thread for long.
    const { quickHashStat } = require('./watchers/fingerprint');
    const store = require('./watchers/store');
    for (const a of added) {
      if (isLocked()) return;
      if (a.row && a.row.quick_hash) continue;
      const p = a.row ? a.row.filepath : null;
      if (!p || /^[\\/]{2}/.test(p)) continue;
      const r = await quickHashStat(p);
      if (r && !isLocked()) { try { store.setQuickHash([{ id: a.id, path: p, ...r }]); } catch {} }
    }
  } catch { /* probe loop is best-effort */ }
}

/**
 * Files that changed in place (re-encoded, trimmed, or finished copying
 * after a scan read half of them): probe again, drop the old keyframe index,
 * and make the thumbnail and hover frames again per the thumbnail settings.
 * @param {number[]} ids
 */
async function refreshFiles(ids, { isLocked = () => false } = {}) {
  const mediaInfo = require('./media-info');
  let probeOk = null;
  for (const id of ids) {
    if (isLocked()) return;
    const row = db.getById(id);
    if (!row) continue;
    try { db.deleteStreamIndex(id); } catch {}
    if (PROBED.includes(row.media_type) && (probeOk ??= probeAvailable(mediaInfo))) {
      try {
        const info = await mediaInfo.getStreamInfo(row.filepath);
        if (info && !isLocked()) {
          // A new copy may carry a different picture inside: look again.
          db.setArtStream(id, null);
          db.saveStreamInfo(id, info);
        }
      } catch { /* the file may still be unreadable; its row says so */ }
    }
  }
  if (isLocked()) return;
  try { await thumbnails.refreshIds(ids); } catch (err) {
    console.warn(`[Watch] thumbnail refresh failed: ${err.message}`);
  }
}

module.exports = {
  addPaths, probeAndThumb, refreshFiles, mediaTypeOf,
  _resetProbeCheck: () => { _probeCheck = { at: 0, ok: false }; },   // tests
};
