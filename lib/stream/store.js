/**
 * Segment store — one interface, two backends, the same split thumbnails use.
 *
 *   plaintext mode : files at <streamCacheDir>/<mediaId>/<n>.ts, guarded by the
 *                    .vault-owned marker so a misconfigured VAULT_STREAM_CACHE
 *                    can never delete somebody's own folder.
 *   vault mode     : rows in secure_assets.db as kind 'seg', lang = the segment
 *                    number. Encrypted with the same key as everything else and
 *                    unreadable while the vault is locked.
 *
 * The `stream_cache` table is the bookkeeping either backend shares: how many
 * bytes a file's segments take, which segments exist (a hex bitset), whether
 * the set is complete, and when it was last touched. That table lives in the
 * MAIN database, so it is encrypted in vault mode too.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const ownedDir = require('../owned-dir');
const secureAssets = require('../secure-assets');
const db = require('../database');

const KIND = 'seg';

function root() {
  return config.paths.streamCacheDir;
}

function dirFor(mediaId) {
  return path.join(root(), String(mediaId));
}

function fileFor(mediaId, n) {
  return path.join(dirFor(mediaId), `${n}.ts`);
}

/** Create the cache root (and the per-file dir) with the app-owned marker. */
function ensureDir(mediaId) {
  ownedDir.ensureManaged(root(), 'streamcache');
  const d = dirFor(mediaId);
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
  return d;
}

/* ── have_mask: a hex bitset, bit n = segment n is stored ─────────────────── */

function maskHas(mask, n) {
  const byte = n >> 2;                       // 4 bits per hex character
  const ch = (mask || '')[byte];
  if (!ch) return false;
  return ((parseInt(ch, 16) || 0) >> (n & 3) & 1) === 1;
}

function maskSet(mask, n, on = true) {
  const byte = n >> 2;
  const chars = (mask || '').split('');
  while (chars.length <= byte) chars.push('0');
  let v = parseInt(chars[byte], 16) || 0;
  if (on) v |= (1 << (n & 3));
  else v &= ~(1 << (n & 3));
  chars[byte] = v.toString(16);
  return chars.join('');
}

function maskCount(mask, total) {
  let n = 0;
  for (let i = 0; i < total; i++) if (maskHas(mask, i)) n++;
  return n;
}

/* ── Reads ────────────────────────────────────────────────────────────────── */

function enabled() { return secureAssets.enabled(); }

/** Is segment n stored? Answered from the filesystem / the store, not the mask,
 *  so a hand-deleted cache directory self-heals instead of 404ing forever. */
function has(mediaId, n) {
  if (enabled()) return secureAssets.has(mediaId, KIND, String(n));
  try { return fs.statSync(fileFor(mediaId, n)).size > 0; } catch { return false; }
}

/** @returns {Buffer|null} in vault mode, {path} in plaintext mode, null if absent. */
function get(mediaId, n) {
  if (enabled()) {
    const buf = secureAssets.get(mediaId, KIND, String(n));
    return buf ? { buffer: buf } : null;
  }
  const p = fileFor(mediaId, n);
  try {
    if (fs.statSync(p).size > 0) return { path: p };
  } catch {}
  return null;
}

/* ── Writes ───────────────────────────────────────────────────────────────── */

/**
 * Store segment n and update the bookkeeping row.
 * @param {number} mediaId
 * @param {number} n
 * @param {Buffer} buf
 * @param {number} segmentCount  total segments in the playlist
 */
function put(mediaId, n, buf, segmentCount) {
  const row = db.getStreamCache(mediaId);
  const oldMask = row ? row.have_mask : '';

  // A producer restart re-emits segments that are already stored: any backward
  // seek runs FFmpeg again from an earlier boundary, and every boundary from
  // there on is produced a second time. Counting those bytes again inflates
  // stream_cache.bytes without bound (a 3.6 MB file measured as 16.4 MB after
  // three seek cycles) and eviction then runs against a number that has nothing
  // to do with the disk. An already-stored segment is byte-identical, so the
  // cheapest correct thing is to leave both the file and the total alone.
  if (maskHas(oldMask, n) && has(mediaId, n)) return row.bytes;

  if (enabled()) {
    secureAssets.put(mediaId, KIND, buf, String(n));
  } else {
    ensureDir(mediaId);
    // Write to a temp name and rename: a reader must never see a half-written
    // segment, and on Windows rename over an existing file needs the unlink.
    const target = fileFor(mediaId, n);
    const tmp = `${target}.part`;
    fs.writeFileSync(tmp, buf);
    try { fs.rmSync(target, { force: true }); } catch {}
    fs.renameSync(tmp, target);
  }

  const mask = maskSet(oldMask, n, true);
  const total = segmentCount || (row ? row.segment_count : 0);
  const complete = total > 0 && maskCount(mask, total) >= total;
  // Self-heal: the running total is incremental, so the moment a file's set is
  // whole, replace it with what is really stored. One stat sweep per file, once.
  const bytes = complete ? bytesOf(mediaId) : (row ? row.bytes : 0) + buf.length;
  db.saveStreamCache(mediaId, {
    bytes,
    segment_count: total,
    have_mask: mask,
    complete,
  });
  return bytes;
}

/** What one media id's segments ACTUALLY occupy, measured not remembered. */
function bytesOf(mediaId) {
  if (enabled()) return secureAssets.sizeOfKind(mediaId, KIND);
  const d = dirFor(mediaId);
  let names = [];
  try { names = fs.readdirSync(d); } catch { return 0; }
  let total = 0;
  for (const name of names) {
    if (!/^\d+\.ts$/.test(name)) continue;
    try { total += fs.statSync(path.join(d, name)).size; } catch {}
  }
  return total;
}

/** Note that a file's cache was read (feeds the eviction order). */
function touch(mediaId) {
  try { db.touchStreamCache(mediaId); } catch {}
}

/**
 * The one refusal message the delete paths share. A sweep that was refused is
 * reported, never swallowed: the alternative is dropping the bookkeeping row
 * while the segments stay on disk, which orphans them for good (nothing else
 * knows they exist) and reports success for a delete that did not happen.
 */
const REFUSED =
  'cache folder is not marked as Vault-owned; nothing was deleted';

/**
 * Drop every stored segment for one media id, in whichever backend holds it.
 * @returns {{ok:boolean, error?:string}}
 */
function deleteAll(mediaId) {
  // The guard runs BEFORE anything is removed. It only has anything to say
  // about the plaintext directory — the encrypted rows are inside the app's own
  // database, not in a folder a misconfigured path could point at — so a vault
  // library with no cache directory is never refused. Getting this order wrong
  // deleted the encrypted segments and then reported a refusal, leaving the
  // bookkeeping row pointing at segments that no longer existed.
  const d = dirFor(mediaId);
  const hasPlaintext = fs.existsSync(d);
  if (hasPlaintext && !ownedDir.guardSweep(root(), 'stream-cache delete')) {
    return { ok: false, error: REFUSED };
  }

  if (secureAssets.enabled()) {
    try { secureAssets.delKind(mediaId, KIND); } catch {}
  }
  // Always sweep the plaintext dir too: a library that gained a password still
  // has yesterday's plaintext segments on disk until something removes them.
  if (hasPlaintext) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
  try { db.deleteStreamCacheRow(mediaId); } catch {}
  return { ok: true };
}

/**
 * Drop the entire cache (both backends) and every bookkeeping row.
 * @returns {{ok:boolean, cleared:number, error?:string}}
 */
function clearAll() {
  const purged = purgePlaintext();
  if (!purged.ok) return { ok: false, cleared: 0, error: purged.error };
  let ids = [];
  try { ids = db.allStreamCacheIds(); } catch {}
  for (const id of ids) {
    if (secureAssets.enabled()) { try { secureAssets.delKind(id, KIND); } catch {} }
  }
  try { db.clearStreamCacheRows(); } catch {}
  return { ok: true, cleared: ids.length };
}

/**
 * Delete the plaintext cache directory's CONTENTS. Used by clearAll and by the
 * plaintext-to-vault transition (lib/vault.js setPassword): migrating gigabytes
 * of segments into the encrypted store would cost far more than regenerating
 * them, and leaving them on disk would defeat the point of the vault.
 * @returns {{ok:boolean, removed:number, error?:string}}
 */
function purgePlaintext() {
  const dir = root();
  if (!fs.existsSync(dir)) return { ok: true, removed: 0 };
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { ok: true, removed: 0 }; }
  const targets = names.filter(name => name !== ownedDir.MARKER_NAME);
  if (!targets.length) return { ok: true, removed: 0 };
  if (!ownedDir.guardSweep(dir, 'stream-cache purge')) return { ok: false, removed: 0, error: REFUSED };
  let n = 0;
  for (const name of targets) {
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); n++; } catch {}
  }
  return { ok: true, removed: n };
}

/* ── Size cap ─────────────────────────────────────────────────────────────── */

/** Configured cap in bytes; 0 means unlimited. */
function capBytes() {
  const appSettings = require('../app-settings');
  const mb = appSettings.getInt('streamCacheMaxMB', 10240, { min: 0, max: 4 * 1024 * 1024 });
  return mb * 1024 * 1024;
}

/**
 * Evict whole files, oldest access first, until the cache is under the cap.
 *
 * Two files are never dropped: any with a live producer session, and the most
 * recently accessed one. The second exception matters more than it looks — a
 * single film can be larger than the whole cap, and without it that film would
 * be produced and then instantly evicted on every single play. Better to let
 * the cap be soft for the file someone is actually watching.
 *
 * @param {Set<number>} protectedIds
 * @returns {number[]} the media ids that were dropped
 */
function evictToCap(protectedIds = new Set()) {
  const cap = capBytes();
  if (!cap) return [];
  let { bytes } = db.streamCacheTotals();
  if (bytes <= cap) return [];

  const byAge = db.streamCacheByAge();
  const newest = byAge.length ? byAge[byAge.length - 1].media_id : null;

  const dropped = [];
  for (const row of byAge) {
    if (bytes <= cap) break;
    if (protectedIds.has(row.media_id) || row.media_id === newest) continue;
    // A refused sweep leaves the row (and the bytes) exactly where they were:
    // pretending the file went away would hide real segments from every later
    // total. Move on to the next candidate instead.
    if (!deleteAll(row.media_id).ok) continue;
    bytes -= row.bytes;
    dropped.push(row.media_id);
  }
  if (dropped.length) {
    console.log(`[Stream] cache over ${Math.round(cap / 1048576)} MB, evicted ${dropped.length} file(s)`);
  }
  return dropped;
}

/** { bytes, files, capMB, encrypted } for /api/stream/cache. */
function stats() {
  const totals = db.streamCacheTotals();
  return {
    bytes: totals.bytes,
    files: totals.files,
    capMB: Math.round(capBytes() / 1048576),
    encrypted: enabled(),
  };
}

module.exports = {
  KIND, root, dirFor, fileFor, ensureDir,
  has, get, put, bytesOf, touch, deleteAll, clearAll, purgePlaintext,
  capBytes, evictToCap, stats, REFUSED,
  maskHas, maskSet, maskCount,
};
