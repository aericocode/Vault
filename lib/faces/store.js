/**
 * Face data at rest: the face_groups / face_vectors tables, the faces_* media
 * columns, and the per-group crop JPEGs (FACES_BUILD_SPEC section 3).
 *
 * Crops follow the derived-artifact rules everything else uses:
 *   - encrypted library: secure-assets, key (media_id, 'face-<groupId>'), so
 *     secureAssets.deleteAll(mediaId) on a hard delete takes them too;
 *   - plain library: <thumbnailDir>/faces/<groupId>.jpg.
 *
 * Every write bumps version(), which is how the in-memory search index
 * (index-mem.js) knows to rebuild on its next query.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const database = require('../database');
const secureAssets = require('../secure-assets');
const ownedDir = require('../owned-dir');

const EMBED_DIM = 128;
const MAX_EXEMPLARS = 3;
const ELIGIBLE_TYPES = Object.freeze(['image', 'gif', 'video']);
const ERROR_MAX = 200;

let _version = 0;
/** Monotonic write counter: any change to searchable face data bumps it. */
function version() { return _version; }
function bump() { _version++; }

/**
 * The analysis kind for a media row, or null when the file is not eligible.
 * media_type 'image' -> 'image', 'gif' (or a .gif file) -> 'gif', 'video' -> 'video'.
 */
function kindOf(row) {
  if (!row || !ELIGIBLE_TYPES.includes(row.media_type)) return null;
  if (row.media_type === 'gif' || /\.gif$/i.test(row.filename || row.filepath || '')) return 'gif';
  return row.media_type;
}

/** 128 x float32 LE, L2-normalized. Throws on a wrong-sized vector. */
function encodeEmbedding(vec) {
  if (!vec || vec.length !== EMBED_DIM) {
    throw new Error(`face embedding must have ${EMBED_DIM} values (got ${vec ? vec.length : 'none'})`);
  }
  const f = normalize(Float32Array.from(vec));
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

function decodeEmbedding(buf) {
  const copy = Buffer.from(buf);   // aligned, owned copy
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function normalize(f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  const n = Math.sqrt(s);
  if (n > 0 && Math.abs(n - 1) > 1e-6) for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}

function bboxJson(b) {
  if (!Array.isArray(b) && !(b && typeof b.length === 'number')) return '[0,0,0,0]';
  return JSON.stringify(Array.from(b).slice(0, 4).map(v => Math.round(Number(v) * 10000) / 10000));
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/* ── Crops ──────────────────────────────────────────────────────────────── */

function cropDir() { return path.join(config.paths.thumbnailDir, 'faces'); }
function cropPath(groupId) { return path.join(cropDir(), `${groupId}.jpg`); }
const cropKind = (groupId) => `face-${groupId}`;

function putCrop(mediaId, groupId, buf) {
  if (!buf || !buf.length) return false;
  if (secureAssets.enabled()) return secureAssets.put(mediaId, cropKind(groupId), buf);
  // Every delete path only unlinks inside an app-owned thumbnails dir, so a
  // crop written into an unowned one could never be removed again. Skip it:
  // the chip shows without a picture (cropUrl null).
  if (!ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs')) return false;
  fs.mkdirSync(cropDir(), { recursive: true });
  const dest = cropPath(groupId);
  const tmp = `${dest}.part-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return true;
}

/** Crop bytes for a group, or null. */
function getCrop(groupId) {
  const row = database.get().prepare('SELECT media_id FROM face_groups WHERE id = ?').get(groupId);
  if (!row) return null;
  if (secureAssets.enabled()) return secureAssets.get(row.media_id, cropKind(groupId));
  try { return fs.readFileSync(cropPath(groupId)); } catch { return null; }
}

/** Is there a stored crop for this group? */
function hasCrop(mediaId, groupId) {
  if (secureAssets.enabled()) return secureAssets.has(mediaId, cropKind(groupId));
  return fs.existsSync(cropPath(groupId));
}

/**
 * Unlink the plain crops of groups that are really gone. Used when a delete
 * ran inside an outer transaction (migrate apply -> repointPath ->
 * deleteRecords): called on the next turn, after that transaction committed
 * or rolled back, it leaves alone any group a rollback brought back.
 */
function removePlainCropsIfGone(groupIds) {
  let gone = groupIds;
  try {
    const db = database.get();
    const still = new Set();
    const q = db.prepare('SELECT id FROM face_groups WHERE id = ?');
    for (const gid of groupIds) if (q.get(gid)) still.add(gid);
    gone = groupIds.filter(g => !still.has(g));
  } catch { return; }   // DB closed (locked): leave the files, delete-all still finds them
  removePlainCrops(gone);
}

/** Unlink plain crop files (only inside an app-owned thumbnail dir). */
function removePlainCrops(groupIds) {
  if (!groupIds.length || !ownedDir.isOwned(config.paths.thumbnailDir)) return;
  for (const gid of groupIds) {
    try { fs.unlinkSync(cropPath(gid)); } catch { /* absent */ }
  }
}

function removeCrops(mediaId, groupIds) {
  if (!groupIds.length) return;
  if (secureAssets.enabled()) {
    for (const gid of groupIds) {
      try { secureAssets.del(mediaId, cropKind(gid)); } catch { /* store gone */ }
    }
  }
  removePlainCrops(groupIds);
}

/**
 * Vault turned on with plain crops on disk: move them into the encrypted
 * store and delete the plaintext (registered with secure-assets so it runs
 * wherever migrateFromDisk does).
 */
function migratePlainCrops() {
  if (!secureAssets.enabled()) return 0;
  const dir = cropDir();
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  if (!ownedDir.isOwned(config.paths.thumbnailDir)) return 0;
  const lookup = database.get().prepare('SELECT media_id FROM face_groups WHERE id = ?');
  let moved = 0;
  for (const name of names) {
    const full = path.join(dir, name);
    const m = name.match(/^(\d+)\.jpg$/);
    if (m) {
      const row = lookup.get(Number(m[1]));
      if (row) {
        try { secureAssets.put(row.media_id, cropKind(Number(m[1])), fs.readFileSync(full)); moved++; } catch { continue; }
      }
      try { fs.unlinkSync(full); } catch {}
    } else if (/^\d+\.jpg\.part-/.test(name)) {
      try { fs.unlinkSync(full); } catch {}
    }
  }
  try { fs.rmdirSync(dir); } catch { /* not empty */ }
  if (moved) console.log(`[Faces] moved ${moved} face crop(s) into secure_assets.db, plaintext deleted`);
  return moved;
}
secureAssets.addDiskMigrator(migratePlainCrops);

/* ── Writes ─────────────────────────────────────────────────────────────── */

/**
 * Replace a file's faces with an analyzeFile result, in one transaction, and
 * mark it indexed by `modelId`. Crops are written after the commit.
 * @returns {number[]|null} new group ids, or null when the media row is gone
 */
function saveFileResult(mediaId, modelId, result, { isVideo = false, now = new Date() } = {}) {
  const db = database.get();
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const insG = db.prepare(`INSERT INTO face_groups
    (media_id, appearances, first_time_s, best_time_s, best_bbox, det_score, model, hidden, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`);
  const insV = db.prepare(`INSERT INTO face_vectors
    (group_id, media_id, frame_time_s, bbox, det_score, embedding) VALUES (?, ?, ?, ?, ?, ?)`);
  const time = (v) => (isVideo ? num(v) : null);

  let oldIds = [];
  const created = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM media WHERE id = ?').get(mediaId)) return null;
    oldIds = db.prepare('SELECT id FROM face_groups WHERE media_id = ?').all(mediaId).map(r => r.id);
    db.prepare('DELETE FROM face_vectors WHERE media_id = ?').run(mediaId);
    db.prepare('DELETE FROM face_groups WHERE media_id = ?').run(mediaId);
    const out = [];
    for (const g of groups) {
      const best = g.best || {};
      const exemplars = (Array.isArray(g.exemplars) ? g.exemplars : []).slice(0, MAX_EXEMPLARS);
      const encoded = exemplars.map(ex => encodeEmbedding(ex.embedding));   // validate before insert
      const info = insG.run(mediaId, Math.max(1, Math.trunc(num(g.appearances) || 1)),
        time(g.firstTimeS), time(best.frameTimeS), bboxJson(best.bbox), num(best.detScore), modelId, stamp);
      const gid = Number(info.lastInsertRowid);
      exemplars.forEach((ex, i) => {
        insV.run(gid, mediaId, time(ex.frameTimeS), bboxJson(ex.bbox), num(ex.detScore), encoded[i]);
      });
      out.push({ id: gid, crop: best.crop || null });
    }
    db.prepare('UPDATE media SET faces_indexed_at = ?, faces_model = ?, faces_error = NULL WHERE id = ?')
      .run(stamp, modelId, mediaId);
    return out;
  })();
  if (!created) return null;
  bump();
  removeCrops(mediaId, oldIds);
  for (const c of created) {
    if (!c.crop) continue;
    try { putCrop(mediaId, c.id, c.crop); } catch (err) { console.warn(`[Faces] crop write failed for group ${c.id}: ${err.message}`); }
  }
  return created.map(c => c.id);
}

/**
 * Record a failure. faces_indexed_at is left alone: a file never checked stays
 * NULL (not indexed, retryable); a file whose re-check failed keeps its faces.
 */
function markError(mediaId, message) {
  database.get().prepare('UPDATE media SET faces_error = ? WHERE id = ?')
    .run(String(message || 'unknown error').slice(0, ERROR_MAX), mediaId);
}

function hideGroup(groupId) {
  const n = database.get().prepare('UPDATE face_groups SET hidden = 1 WHERE id = ?').run(groupId).changes;
  if (n) bump();
  return n > 0;
}

/**
 * Hard-delete hook, called by database.deleteRecords inside its transaction.
 * @returns {number[]} the removed group ids (plain crops are unlinked by the
 *   caller after commit; encrypted crops go with secureAssets.deleteAll)
 */
function cleanupForMedia(db, mediaId) {
  const ids = db.prepare('SELECT id FROM face_groups WHERE media_id = ?').all(mediaId).map(r => r.id);
  db.prepare('DELETE FROM face_vectors WHERE media_id = ?').run(mediaId);
  const n = db.prepare('DELETE FROM face_groups WHERE media_id = ?').run(mediaId).changes;
  if (n || ids.length) bump();
  return ids;
}

/** "Delete all face data": tables, media columns, every crop in both modes. */
function deleteAllData() {
  const db = database.get();
  db.transaction(() => {
    db.prepare('DELETE FROM face_vectors').run();
    db.prepare('DELETE FROM face_groups').run();
    db.prepare(`UPDATE media SET faces_indexed_at = NULL, faces_model = NULL, faces_error = NULL
      WHERE faces_indexed_at IS NOT NULL OR faces_model IS NOT NULL OR faces_error IS NOT NULL`).run();
  })();
  bump();
  try { secureAssets.deleteKindPrefix('face-'); } catch { /* store disabled or closed */ }
  if (ownedDir.isOwned(config.paths.thumbnailDir)) {
    let names = [];
    try { names = fs.readdirSync(cropDir()); } catch { /* no dir */ }
    for (const name of names) {
      if (/^\d+\.jpg(\.part-\d+)?$/.test(name)) {
        try { fs.unlinkSync(path.join(cropDir(), name)); } catch {}
      }
    }
    try { fs.rmdirSync(cropDir()); } catch { /* absent or not empty */ }
  }
}

/* ── Reads ──────────────────────────────────────────────────────────────── */

const modelClause = (col) => `(? IS NULL OR ${col} = ?)`;

/**
 * Faces for one file's info panel (hidden excluded).
 * `modelId` null (models not available) accepts whatever model indexed it.
 */
function getFileFaces(mediaId, modelId) {
  const db = database.get();
  const row = db.prepare(`SELECT id, filename, filepath, media_type, faces_indexed_at, faces_model, faces_error
    FROM media WHERE id = ?`).get(mediaId);
  if (!row) return null;
  const eligible = !!kindOf(row);
  const indexed = eligible && row.faces_indexed_at != null && (modelId == null || row.faces_model === modelId);
  const rows = !indexed ? [] : db.prepare(`SELECT id, appearances, first_time_s, best_time_s FROM face_groups
      WHERE media_id = ? AND hidden = 0 AND model = ? ORDER BY appearances DESC, id`)
    .all(mediaId, modelId == null ? row.faces_model : modelId);
  const groups = rows.map(g => ({
    id: g.id, appearances: g.appearances, firstTimeS: g.first_time_s, bestTimeS: g.best_time_s,
    cropUrl: hasCrop(mediaId, g.id) ? `/api/faces/crop/${g.id}` : null,
  }));
  return { eligible, indexed, error: row.faces_error || null, groups };
}

function groupInfo(groupId) {
  return database.get().prepare('SELECT id, media_id, model, hidden FROM face_groups WHERE id = ?').get(groupId) || null;
}

function groupVectors(groupId) {
  return database.get().prepare('SELECT embedding FROM face_vectors WHERE group_id = ? ORDER BY id')
    .all(groupId).map(r => decodeEmbedding(r.embedding));
}

/** Library-wide numbers for the settings status line (trash excluded). */
function counts(modelId) {
  const db = database.get();
  const types = ELIGIBLE_TYPES.map(t => `'${t}'`).join(',');
  const eligible = db.prepare(`SELECT COUNT(*) AS n FROM media
    WHERE user_trashed = 0 AND media_type IN (${types})`).get().n;
  const indexed = db.prepare(`SELECT COUNT(*) AS n FROM media
    WHERE user_trashed = 0 AND media_type IN (${types}) AND faces_indexed_at IS NOT NULL
      AND ${modelClause('faces_model')}`).get(modelId, modelId).n;
  const g = db.prepare(`SELECT COUNT(*) AS people, COUNT(DISTINCT g.media_id) AS withFaces
    FROM face_groups g JOIN media m ON m.id = g.media_id
    WHERE g.hidden = 0 AND m.user_trashed = 0 AND m.faces_indexed_at IS NOT NULL
      AND g.model = m.faces_model AND ${modelClause('g.model')}`).get(modelId, modelId);
  return { eligible, indexed, withFaces: g.withFaces, people: g.people };
}

module.exports = {
  EMBED_DIM, MAX_EXEMPLARS, ELIGIBLE_TYPES,
  version, kindOf, encodeEmbedding, decodeEmbedding, normalize,
  cropDir, cropPath, putCrop, getCrop, hasCrop, removePlainCrops, removePlainCropsIfGone, migratePlainCrops,
  saveFileResult, markError, hideGroup, cleanupForMedia, deleteAllData,
  getFileFaces, groupInfo, groupVectors, counts,
};
