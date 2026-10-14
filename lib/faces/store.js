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
 *
 * Vectors: face_vectors holds each group's exemplar vectors in the group's
 * model (face_groups.model): 128-d for SFace-keeper libraries, 512-d for the
 * AdaFace keepers (models.js embedDim). During a model switch
 * (model-switch.js) a re-read file's vectors of the model it left wait in
 * face_vectors_prev until the switch is over.
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');
const database = require('../database');
const secureAssets = require('../secure-assets');
const ownedDir = require('../owned-dir');
const { peopleThresholds, sameFileThreshold } = require('./thresholds');
const { embedDim, SWITCHABLE } = require('./models');

// Vector lengths accepted for a model id the registry does not know (tests,
// old data): the SFace and AdaFace layouts.
const KNOWN_DIMS = Object.freeze([...new Set(SWITCHABLE.map(embedDim))]);
const MAX_EXEMPLARS = 3;
const ELIGIBLE_TYPES = Object.freeze(['image', 'gif', 'video']);
const ERROR_MAX = 200;

let _version = 0;
/** Monotonic write counter: any change to searchable face data bumps it. */
function version() { return _version; }
function bump() { _version++; }

let _peopleVersion = 0;
/**
 * Monotonic counter for people data (face_people, rejects, decisions,
 * suggestions, face_groups.cluster_id / person_locked). Separate from
 * version(): sorting faces into people must not force a search-index rebuild.
 */
function peopleVersion() { return _peopleVersion; }
let _peopleUserVersion = 0;
/**
 * Like peopleVersion(), but NOT moved by the background sorting job: the
 * people stats cache follows this one at once and the job's own writes only
 * every few seconds (people.js), so polling while sorting stays cheap.
 */
function peopleUserVersion() { return _peopleUserVersion; }
/**
 * @param {object} [o]
 * @param {boolean} [o.background] the sorting job's own write (stats may lag up to 2 s)
 * @param {boolean} [o.membership] false = no face changed person (a name, a
 *   favorite, an answer): the job's centroids stay valid
 */
function bumpPeople({ background = false, membership = true } = {}) {
  if (membership) _peopleVersion++;
  if (!background) _peopleUserVersion++;
}

const _deletedListeners = new Set();
/** fn(personIds) after people were deleted (for per-person caches). */
function onPeopleDeleted(fn) { _deletedListeners.add(fn); return () => _deletedListeners.delete(fn); }
function emitDeleted(ids) {
  if (!ids.length) return;
  for (const fn of _deletedListeners) { try { fn(ids); } catch { /* never breaks a write */ } }
}

/*
 * Change listeners: the people sorting job schedules itself from here after
 * a file is (re-)checked, deleted or everything is wiped. Listeners run
 * synchronously (possibly inside a transaction), so they must only schedule.
 */
const _listeners = new Set();
function onChange(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function emit(kind, mediaId = null) {
  for (const fn of _listeners) { try { fn({ kind, mediaId }); } catch { /* a listener never breaks a write */ } }
}

/**
 * The analysis kind for a media row, or null when the file is not eligible.
 * media_type 'image' -> 'image', 'gif' (or a .gif file) -> 'gif', 'video' -> 'video'.
 */
function kindOf(row) {
  if (!row || !ELIGIBLE_TYPES.includes(row.media_type)) return null;
  if (row.media_type === 'gif' || /\.gif$/i.test(row.filename || row.filepath || '')) return 'gif';
  return row.media_type;
}

/**
 * float32 LE, L2-normalized. The length must be the model's (models.js
 * embedDim); a model the registry does not know accepts 128 or 512.
 * Throws on a wrong-sized vector.
 */
function encodeEmbedding(vec, modelId = null) {
  const want = modelId == null ? null : embedDim(modelId);
  const ok = vec && (want ? vec.length === want : KNOWN_DIMS.includes(vec.length));
  if (!ok) {
    throw new Error(`face embedding must have ${want || KNOWN_DIMS.join(' or ')} values (got ${vec ? vec.length : 'none'})`);
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

// A re-checked face counts as a hidden one (or as the same person) at the
// within-file grouping threshold (SFace 0.45; keepers: models.js sameFile).
const HIDE_MATCH = require('./analyze').GROUP_THRESHOLD;
// Old faces of ANOTHER model are matched by position instead: an exemplar at
// the same frame time (same sample grid: H1 picks exemplars on SFace, so a
// re-check finds the same frames and boxes) with box IoU >= POS_IOU.
const POS_IOU = 0.8;
const TIME_EPS = 1e-3;
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function bboxIou(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[0] + a[2], b[0] + b[2]), y2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = a[2] * a[3] + b[2] * b[3] - i;
  return u > 0 ? i / u : 0;
}
const sameTime = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < TIME_EPS);
/** Best IoU between two lists of { t, bbox } exemplar positions at the same frame time (0 = none). */
function posMatch(as, bs) {
  let m = 0;
  for (const a of as) for (const b of bs) if (sameTime(a.t, b.t)) m = Math.max(m, bboxIou(a.bbox, b.bbox));
  return m;
}
function parseBbox(t) { try { const b = JSON.parse(t); return Array.isArray(b) && b.length === 4 ? b : null; } catch { return null; } }
/** Best exemplar-pair cosine between two lists of vectors. */
function maxPairCos(as, bs) {
  let m = -2;
  for (const a of as) for (const b of bs) { const d = dot(a, b); if (d > m) m = d; }
  return m;
}
const SQL_CHUNK = 500;
function inChunks(ids, fn) {
  for (let i = 0; i < ids.length; i += SQL_CHUNK) {
    const chunk = ids.slice(i, i + SQL_CHUNK);
    fn(chunk, chunk.map(() => '?').join(','));
  }
}

/**
 * Delete people left with no visible face (none at all, or only hidden ones),
 * unless the user named or favorited them (a name must survive a re-check or
 * a re-import; an empty named person never shows in the Faces tab). Their
 * hidden faces are detached (hidden faces are never sorted). Trashed files
 * still count: a restore brings the person back. Runs inside the caller's
 * transaction. @returns {number} people deleted
 */
function pruneEmptyPeople(db, personIds) {
  const ids = [...new Set(personIds.filter(id => id != null))];
  let n = 0;
  if (!ids.length) return 0;
  const empty = db.prepare(`SELECT p.id FROM face_people p WHERE p.id = ? AND p.name IS NULL AND p.favorite = 0
    AND NOT EXISTS (SELECT 1 FROM face_groups g WHERE g.cluster_id = p.id AND g.hidden = 0)`);
  const gone = ids.filter(id => empty.get(id));
  inChunks(gone, (chunk, q) => {
    db.prepare(`UPDATE face_groups SET cluster_id = NULL, person_locked = 0 WHERE cluster_id IN (${q})`).run(...chunk);
    db.prepare(`DELETE FROM face_person_rejects WHERE person_id IN (${q})`).run(...chunk);
    db.prepare(`DELETE FROM face_pair_decisions WHERE a IN (${q}) OR b IN (${q})`).run(...chunk, ...chunk);
    db.prepare(`DELETE FROM face_person_suggestions WHERE a IN (${q}) OR b IN (${q})`).run(...chunk, ...chunk);
    db.prepare(`DELETE FROM studio_people WHERE person_id IN (${q})`).run(...chunk);
    n += db.prepare(`DELETE FROM face_people WHERE id IN (${q})`).run(...chunk).changes;
  });
  emitDeleted(gone);
  return n;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * After a re-check's carry-over: a person the sorter would never have started
 * (every visible face now measured unclear, norm below startNorm) goes back to
 * unsorted, so the people job holds its faces (or lets them join someone),
 * exactly as a fresh index would. Only automatic people: unnamed, not a
 * favorite, not hidden, and no face the user put there (person_locked).
 * Faces with no norm on record count as clear, as in the sorter.
 * @returns {number[]} the dissolved person ids (deleted by pruneEmptyPeople)
 */
function dissolveUnclearPeople(db, modelId, personIds) {
  const ids = [...new Set(personIds.filter(id => id != null))];
  if (!ids.length) return [];
  const { startNorm } = peopleThresholds(modelId);
  const check = db.prepare(`SELECT
      (SELECT COUNT(*) FROM face_groups g WHERE g.cluster_id = p.id AND g.hidden = 0) AS visible,
      (SELECT COUNT(*) FROM face_groups g WHERE g.cluster_id = p.id AND g.hidden = 0 AND g.norm IS NOT NULL AND g.norm < ?) AS unclear,
      (SELECT COUNT(*) FROM face_groups g WHERE g.cluster_id = p.id AND g.person_locked = 1) AS locked
    FROM face_people p WHERE p.id = ? AND p.name IS NULL AND p.favorite = 0 AND p.hidden = 0`);
  const free = db.prepare('UPDATE face_groups SET cluster_id = NULL, person_locked = 0, sort_held = 0 WHERE cluster_id = ?');
  const gone = [];
  for (const id of ids) {
    const r = check.get(startNorm, id);
    if (!r || !r.visible || r.locked || r.unclear !== r.visible) continue;
    free.run(id);
    gone.push(id);
  }
  pruneEmptyPeople(db, gone);
  return gone;
}

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
function saveFileResult(mediaId, modelId, result, { isVideo = false, now = new Date(), screenIntervalS = null } = {}) {
  const db = database.get();
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const insG = db.prepare(`INSERT INTO face_groups
    (media_id, appearances, first_time_s, best_time_s, best_bbox, det_score, model, hidden, created_at,
     cluster_id, person_locked, screen_s, not_face, norm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insReject = db.prepare('INSERT OR IGNORE INTO face_person_rejects (person_id, group_id) VALUES (?, ?)');
  const interval = isVideo && typeof screenIntervalS === 'number' && screenIntervalS > 0 ? screenIntervalS : null;
  const insV = db.prepare(`INSERT INTO face_vectors
    (group_id, media_id, frame_time_s, bbox, det_score, embedding, norm) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const time = (v) => (isVideo ? num(v) : null);

  let oldIds = [];
  let peopleTouched = false;
  const sameFile = sameFileThreshold(modelId);
  const created = db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM media WHERE id = ?').get(mediaId)) return null;
    const oldRows = db.prepare('SELECT id, cluster_id, person_locked, model, hidden, not_face FROM face_groups WHERE media_id = ?').all(mediaId);
    oldIds = oldRows.map(r => r.id);
    // People carry-over (FACES_PEOPLE_SPEC section 9): the user's names,
    // merges and splits live on group ids, and a re-check makes new ones.
    // Each new group inherits person, lock and "not this person" rejects from
    // the old group of this file it matches best: same model, exemplar cosine
    // >= sameFile (models.js); another model (a face model switch), the same
    // exemplar position (posMatch). Unmatched new groups are sorted again by
    // the people job.
    const old = oldRows.map(r => ({ ...r, vecs: [], pos: [], rejects: [] }));
    const oldById = new Map(old.map(o => [o.id, o]));
    if (old.length) {
      for (const r of db.prepare(`SELECT v.group_id, v.embedding, v.frame_time_s, v.bbox FROM face_vectors v JOIN face_groups g ON g.id = v.group_id
        WHERE g.media_id = ? ORDER BY v.id`).all(mediaId)) {
        const o = oldById.get(r.group_id);
        if (!o) continue;
        if (o.model === modelId) o.vecs.push(decodeEmbedding(r.embedding));
        o.pos.push({ t: r.frame_time_s, bbox: parseBbox(r.bbox) });
      }
      inChunks(old.map(o => o.id), (chunk, q) => {
        for (const r of db.prepare(`SELECT person_id, group_id FROM face_person_rejects WHERE group_id IN (${q})`).all(...chunk)) {
          oldById.get(r.group_id)?.rejects.push(r.person_id);
        }
      });
    }
    const covers = new Map();   // old group id -> [person ids using it as their cover]
    inChunks(oldIds, (chunk, q) => {
      for (const r of db.prepare(`SELECT id, cover_group_id FROM face_people WHERE cover_group_id IN (${q})`).all(...chunk)) {
        if (!covers.has(r.cover_group_id)) covers.set(r.cover_group_id, []);
        covers.get(r.cover_group_id).push(r.id);
      }
    });
    const oldPeople = oldRows.map(r => r.cluster_id).filter(id => id != null);
    if (oldPeople.length) peopleTouched = true;
    // "Hide this face" is permanent: a re-check must not bring the person back.
    // This file's hidden groups mark any new group that matches them hidden
    // too (same model: vector cosine; another model: exemplar position).
    // "Not a face" is a hide that also keeps its not_face mark.
    const hiddenOld = old.filter(o => o.hidden);
    db.prepare('DELETE FROM face_person_rejects WHERE group_id IN (SELECT id FROM face_groups WHERE media_id = ?)').run(mediaId);
    db.prepare('DELETE FROM face_vectors WHERE media_id = ?').run(mediaId);
    db.prepare('DELETE FROM face_vectors_prev WHERE media_id = ?').run(mediaId);
    db.prepare('DELETE FROM face_groups WHERE media_id = ?').run(mediaId);
    const out = [];
    const coverMoves = new Map();   // person id -> { gid, score }
    for (const g of groups) {
      const best = g.best || {};
      const exemplars = (Array.isArray(g.exemplars) ? g.exemplars : []).slice(0, MAX_EXEMPLARS);
      const encoded = exemplars.map(ex => encodeEmbedding(ex.embedding, modelId));   // validate before insert
      const vecs = encoded.map(decodeEmbedding);
      const pos = exemplars.map(ex => ({ t: time(ex.frameTimeS), bbox: Array.isArray(ex.bbox) ? ex.bbox.slice(0, 4).map(Number) : null }));
      // 1 + IoU for a position match ranks above any cosine (<= 1).
      const matchOf = (o) => (o.model === modelId ? (o.vecs.length ? maxPairCos(vecs, o.vecs) : -2)
        : (posMatch(pos, o.pos) >= POS_IOU ? 1 + posMatch(pos, o.pos) : -2));
      const isMatch = (o, sc) => (o.model === modelId ? sc >= sameFile : sc > 1);
      let hidden = 0, notFace = 0;
      for (const h of hiddenOld) {
        if (!isMatch(h, matchOf(h))) continue;
        hidden = 1;
        if (h.not_face) { notFace = 1; break; }
      }
      let from = null, fromScore = -2;
      for (const o of old) {
        const s = matchOf(o);
        if (isMatch(o, s) && s > fromScore) { from = o; fromScore = s; }
      }
      const appearances = Math.max(1, Math.trunc(num(g.appearances) || 1));
      // A group's norm = its clearest exemplar's (NULL when none was measured).
      const norms = exemplars.map(ex => num(ex.norm)).filter(n => n != null);
      const gnorm = norms.length ? Math.round(Math.max(...norms) * 1000) / 1000 : null;
      const info = insG.run(mediaId, appearances,
        time(g.firstTimeS), time(best.frameTimeS), bboxJson(best.bbox), num(best.detScore), modelId, hidden, stamp,
        from ? from.cluster_id : null, from ? from.person_locked : 0,
        interval == null ? null : Math.round(appearances * interval * 100) / 100, notFace, gnorm);
      const gid = Number(info.lastInsertRowid);
      exemplars.forEach((ex, i) => {
        insV.run(gid, mediaId, time(ex.frameTimeS), bboxJson(ex.bbox), num(ex.detScore), encoded[i],
          num(ex.norm) == null ? null : Math.round(ex.norm * 1000) / 1000);
      });
      if (from) {
        peopleTouched = true;
        for (const pid of from.rejects) insReject.run(pid, gid);
        for (const pid of covers.get(from.id) || []) {
          const cur = coverMoves.get(pid);
          if (!cur || fromScore > cur.score) coverMoves.set(pid, { gid, score: fromScore });
        }
      }
      out.push({ id: gid, crop: best.crop || null });
    }
    // A user-chosen cover follows its face to the new group id (else automatic).
    for (const pids of covers.values()) {
      for (const pid of pids) {
        const mv = coverMoves.get(pid);
        db.prepare('UPDATE face_people SET cover_group_id = ? WHERE id = ?').run(mv ? mv.gid : null, pid);
        peopleTouched = true;
      }
    }
    pruneEmptyPeople(db, oldPeople);
    dissolveUnclearPeople(db, modelId, oldPeople);
    db.prepare('UPDATE media SET faces_indexed_at = ?, faces_model = ?, faces_error = NULL, faces_interval_s = ? WHERE id = ?')
      .run(stamp, modelId, interval, mediaId);
    return out;
  })();
  if (!created) return null;
  bump();
  if (peopleTouched) bumpPeople();
  emit('save', mediaId);
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

/**
 * Hide a face everywhere (search, people, counts). notFace also records that
 * it is not a face at all (FACES_FEEDBACK_SPEC E6). @returns {boolean} found
 */
function hideGroup(groupId, { notFace = false } = {}) {
  const db = database.get();
  const row = db.prepare('SELECT cluster_id FROM face_groups WHERE id = ?').get(groupId);
  const n = db.transaction(() => {
    const changed = db.prepare(`UPDATE face_groups SET hidden = 1${notFace ? ', not_face = 1' : ''} WHERE id = ?`).run(groupId).changes;
    // Its person's last visible face: an unnamed person goes with it.
    if (changed && row && row.cluster_id != null) pruneEmptyPeople(db, [row.cluster_id]);
    return changed;
  })();
  if (n) bump();
  if (n && row && row.cluster_id != null) { bumpPeople(); emit('hide'); }
  return n > 0;
}

/**
 * Undo "Hide this face" / "Not a face" for one face (the Undo on the toast).
 * The face is visible again; if its person is still there it rejoins it,
 * otherwise (an unnamed person pruned when it was hidden) the people job
 * sorts it again. @returns {boolean} found
 */
function unhideGroup(groupId) {
  const n = database.get().prepare('UPDATE face_groups SET hidden = 0, not_face = 0 WHERE id = ?').run(groupId).changes;
  if (n) { bump(); bumpPeople(); emit('unhide'); }
  return n > 0;
}

/**
 * "Not a face" for every face of a person: all of them hidden and marked
 * not_face; the person is then pruned unless named or favorite.
 * @returns {{ groups: number, pruned: boolean }}
 */
function notFacePerson(personId) {
  const db = database.get();
  const out = db.transaction(() => {
    const groups = db.prepare('UPDATE face_groups SET hidden = 1, not_face = 1 WHERE cluster_id = ?').run(personId).changes;
    db.prepare('DELETE FROM face_person_suggestions WHERE a = ? OR b = ?').run(personId, personId);
    const pruned = pruneEmptyPeople(db, [personId]) > 0;
    return { groups, pruned };
  })();
  bump();
  bumpPeople();
  emit('hide');
  return out;
}

/**
 * Hard-delete hook, called by database.deleteRecords inside its transaction.
 * @returns {number[]} the removed group ids (plain crops are unlinked by the
 *   caller after commit; encrypted crops go with secureAssets.deleteAll)
 */
function cleanupForMedia(db, mediaId) {
  const rows = db.prepare('SELECT id, cluster_id FROM face_groups WHERE media_id = ?').all(mediaId);
  const ids = rows.map(r => r.id);
  db.prepare('DELETE FROM face_person_rejects WHERE group_id IN (SELECT id FROM face_groups WHERE media_id = ?)').run(mediaId);
  db.prepare('DELETE FROM face_vectors WHERE media_id = ?').run(mediaId);
  db.prepare('DELETE FROM face_vectors_prev WHERE media_id = ?').run(mediaId);
  const n = db.prepare('DELETE FROM face_groups WHERE media_id = ?').run(mediaId).changes;
  // People left with no faces go, unless named or favorited.
  const people = rows.map(r => r.cluster_id).filter(id => id != null);
  if (people.length) { pruneEmptyPeople(db, people); bumpPeople(); }
  if (n || ids.length) { bump(); emit('delete', mediaId); }
  return ids;
}

/** "Delete all face data": tables, media columns, every crop in both modes. */
function deleteAllData() {
  const db = database.get();
  db.transaction(() => {
    db.prepare('DELETE FROM face_vectors').run();
    db.prepare('DELETE FROM face_vectors_prev').run();
    db.prepare("DELETE FROM face_meta WHERE key = 'model_switch'").run();
    db.prepare('DELETE FROM face_groups').run();
    db.prepare('DELETE FROM face_people').run();
    db.prepare('DELETE FROM face_person_rejects').run();
    db.prepare('DELETE FROM face_pair_decisions').run();
    db.prepare('DELETE FROM face_person_suggestions').run();
    // Studios stay (they hold files too); their people are gone.
    db.prepare('DELETE FROM studio_people').run();
    db.prepare(`UPDATE media SET faces_indexed_at = NULL, faces_model = NULL, faces_error = NULL, faces_interval_s = NULL
      WHERE faces_indexed_at IS NOT NULL OR faces_model IS NOT NULL OR faces_error IS NOT NULL OR faces_interval_s IS NOT NULL`).run();
  })();
  bump();
  bumpPeople();
  emit('deleteAll');
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
 * `modelId` null (models not available) accepts whatever model indexed it;
 * an array accepts any of those models (a model switch in progress).
 */
function getFileFaces(mediaId, modelId) {
  if (Array.isArray(modelId)) {
    const row = database.get().prepare('SELECT faces_model FROM media WHERE id = ?').get(mediaId);
    modelId = row && modelId.includes(row.faces_model) ? row.faces_model : (modelId[0] ?? null);
  }
  const db = database.get();
  const row = db.prepare(`SELECT id, filename, filepath, media_type, faces_indexed_at, faces_model, faces_error
    FROM media WHERE id = ?`).get(mediaId);
  if (!row) return null;
  const eligible = !!kindOf(row);
  const indexed = eligible && row.faces_indexed_at != null && (modelId == null || row.faces_model === modelId);
  const rows = !indexed ? [] : db.prepare(`SELECT g.id, g.appearances, g.first_time_s, g.best_time_s,
        p.id AS person_id, p.name AS person_name
      FROM face_groups g LEFT JOIN face_people p ON p.id = g.cluster_id
      WHERE g.media_id = ? AND g.hidden = 0 AND g.model = ? ORDER BY g.appearances DESC, g.id`)
    .all(mediaId, modelId == null ? row.faces_model : modelId);
  const groups = rows.map(g => ({
    id: g.id, appearances: g.appearances, firstTimeS: g.first_time_s, bestTimeS: g.best_time_s,
    cropUrl: hasCrop(mediaId, g.id) ? `/api/faces/crop/${g.id}` : null,
    personId: g.person_id ?? null, personName: g.person_name ?? null,
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

/**
 * Library-wide numbers for the settings status line (trash excluded).
 * modelId: one model, null (any), or an array of models (a switch in progress).
 */
function counts(modelId) {
  if (Array.isArray(modelId)) {
    const parts = modelId.map(m => counts(m));
    if (!parts.length) return counts(null);
    return parts.reduce((a, b) => ({ eligible: a.eligible, indexed: a.indexed + b.indexed, withFaces: a.withFaces + b.withFaces, people: a.people + b.people }));
  }
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

/* ── Model switch (model-switch.js) ─────────────────────────────────────── */

/**
 * What the switch job needs to re-read one file: its groups (all, hidden too)
 * with the current vectors' positions, and which models wait in
 * face_vectors_prev for each group. null when the media row is gone.
 */
function switchSnapshot(mediaId) {
  const db = database.get();
  const media = db.prepare(`SELECT id, filepath, filename, media_type, duration_seconds, faces_model, faces_interval_s, faces_indexed_at
    FROM media WHERE id = ?`).get(mediaId);
  if (!media) return null;
  const groups = db.prepare('SELECT id, model FROM face_groups WHERE media_id = ? ORDER BY id').all(mediaId)
    .map(g => ({ ...g, vectors: [], prev: new Map() }));
  const byId = new Map(groups.map(g => [g.id, g]));
  for (const r of db.prepare('SELECT group_id, frame_time_s, bbox, det_score, norm FROM face_vectors WHERE media_id = ? ORDER BY id').all(mediaId)) {
    byId.get(r.group_id)?.vectors.push({ frameTimeS: r.frame_time_s, bbox: parseBbox(r.bbox), bboxText: r.bbox, detScore: r.det_score, norm: r.norm });
  }
  for (const r of db.prepare('SELECT group_id, model, COUNT(*) AS n FROM face_vectors_prev WHERE media_id = ? GROUP BY group_id, model').all(mediaId)) {
    byId.get(r.group_id)?.prev.set(r.model, r.n);
  }
  return { media, groups };
}

/**
 * Put one file into model `toModel` WITHOUT touching its groups (ids, people,
 * names, rejects, hidden, not_face, studios all stay): its current vectors
 * move to face_vectors_prev, and each group gets either newVecs.get(groupId)
 * ([{ embedding, frameTimeS, bbox, detScore, norm }]) or, with fromPrev, its
 * waiting vectors of toModel back. One transaction; refused (false) when the
 * file changed since the snapshot (expect: Map group id -> model).
 */
function switchFileModel(mediaId, toModel, { expect, newVecs = null, fromPrev = false }) {
  const db = database.get();
  const ok = db.transaction(() => {
    const now = db.prepare('SELECT id, model FROM face_groups WHERE media_id = ?').all(mediaId);
    if (now.length !== expect.size || now.some(g => expect.get(g.id) !== g.model)) return false;
    const ids = now.map(g => g.id);
    const toPrev = db.prepare(`INSERT INTO face_vectors_prev (group_id, media_id, model, frame_time_s, bbox, det_score, embedding, norm)
      SELECT v.group_id, v.media_id, g.model, v.frame_time_s, v.bbox, v.det_score, v.embedding, v.norm
      FROM face_vectors v JOIN face_groups g ON g.id = v.group_id WHERE v.group_id = ?`);
    const fromPrevIns = db.prepare(`INSERT INTO face_vectors (group_id, media_id, frame_time_s, bbox, det_score, embedding, norm)
      SELECT group_id, media_id, frame_time_s, bbox, det_score, embedding, norm FROM face_vectors_prev
      WHERE group_id = ? AND model = ? ORDER BY id`);
    const ins = db.prepare(`INSERT INTO face_vectors (group_id, media_id, frame_time_s, bbox, det_score, embedding, norm)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const setModel = db.prepare('UPDATE face_groups SET model = ? WHERE id = ?');
    for (const g of now) {
      if (g.model === toModel) continue;
      const vecs = fromPrev ? null : (newVecs && newVecs.get(g.id));
      const encoded = vecs ? vecs.map(v => encodeEmbedding(v.embedding, toModel)) : null;   // validate before any write
      if (!fromPrev && (!encoded || !encoded.length)) throw new Error(`no ${toModel} vectors for face group ${g.id}`);
      db.prepare('DELETE FROM face_vectors_prev WHERE group_id = ? AND model = ?').run(g.id, g.model);
      toPrev.run(g.id);
      db.prepare('DELETE FROM face_vectors WHERE group_id = ?').run(g.id);
      if (fromPrev) {
        if (!fromPrevIns.run(g.id, toModel).changes) throw new Error(`no waiting ${toModel} vectors for face group ${g.id}`);
        db.prepare('DELETE FROM face_vectors_prev WHERE group_id = ? AND model = ?').run(g.id, toModel);
      } else {
        vecs.forEach((v, i) => ins.run(g.id, mediaId, num(v.frameTimeS), typeof v.bbox === 'string' ? v.bbox : bboxJson(v.bbox),
          num(v.detScore), encoded[i], num(v.norm) == null ? null : Math.round(v.norm * 1000) / 1000));
      }
      setModel.run(toModel, g.id);
    }
    db.prepare('UPDATE media SET faces_model = ? WHERE id = ?').run(toModel, mediaId);
    return true;
  })();
  if (ok) {
    bump();
    // Groups changed model: the sorting job's per-model centroids are stale.
    bumpPeople({ background: true });
  }
  return ok;
}

/**
 * Media ids of indexed files whose model is one of `models`, by id.
 * tier: 'named' (a face of a named person), 'favorite' (of a favorite, no
 * named one), 'rest' (neither), or omitted (all).
 */
function filesInModels(models, { after = 0, limit = 100, tier = null } = {}) {
  if (!models.length) return [];
  const named = 'EXISTS (SELECT 1 FROM face_groups g JOIN face_people p ON p.id = g.cluster_id WHERE g.media_id = media.id AND p.name IS NOT NULL)';
  const fav = 'EXISTS (SELECT 1 FROM face_groups g JOIN face_people p ON p.id = g.cluster_id WHERE g.media_id = media.id AND p.favorite = 1)';
  const where = tier === 'named' ? `AND ${named}` : tier === 'favorite' ? `AND NOT ${named} AND ${fav}`
    : tier === 'rest' ? `AND NOT ${named} AND NOT ${fav}` : '';
  return database.get().prepare(`SELECT id FROM media WHERE faces_model IN (${models.map(() => '?').join(',')})
    AND faces_indexed_at IS NOT NULL AND id > ? ${where} ORDER BY id LIMIT ?`).all(...models, after, limit).map(r => r.id);
}

/** Named people: how many have faces, and how many still have a face outside model `to`. */
function namedProgress(to) {
  const db = database.get();
  const total = db.prepare(`SELECT COUNT(DISTINCT p.id) AS n FROM face_people p JOIN face_groups g ON g.cluster_id = p.id
    WHERE p.name IS NOT NULL`).get().n;
  const pending = db.prepare(`SELECT COUNT(DISTINCT p.id) AS n FROM face_people p JOIN face_groups g ON g.cluster_id = p.id
    WHERE p.name IS NOT NULL AND g.model <> ?`).get(to).n;
  return { total, pending };
}

/** Named people with a face in these files. */
function namedPeopleIn(mediaIds) {
  const out = new Set();
  inChunks(mediaIds, (chunk, q) => {
    for (const r of database.get().prepare(`SELECT DISTINCT p.id FROM face_groups g JOIN face_people p ON p.id = g.cluster_id
      WHERE g.media_id IN (${q}) AND p.name IS NOT NULL`).all(...chunk)) out.add(r.id);
  });
  return [...out];
}

/**
 * Indexed files per model, for these model ids: Map model id -> count (> 0
 * only; all files, trash included). One index count per model
 * (idx_media_faces_model; faces_model is set exactly when a file is indexed).
 */
function modelMix(models = require('./models').SWITCHABLE) {
  const out = new Map();
  const q = database.get().prepare('SELECT COUNT(*) AS n FROM media WHERE faces_model = ?');
  for (const m of models) { const n = q.get(m).n; if (n) out.set(m, n); }
  return out;
}

/** Is any file indexed with this model? (one index probe) */
function hasModel(modelId) {
  return !!database.get().prepare('SELECT 1 FROM media WHERE faces_model = ? LIMIT 1').get(modelId);
}

/**
 * A group's vectors by model: its current ones (face_groups.model) and any
 * waiting in face_vectors_prev (a model switch in progress).
 * @returns {Map<string, Float32Array[]>}
 */
function groupVectorsByModel(groupId) {
  const db = database.get();
  const out = new Map();
  const g = db.prepare('SELECT model FROM face_groups WHERE id = ?').get(groupId);
  if (!g) return out;
  out.set(g.model, groupVectors(groupId));
  for (const r of db.prepare('SELECT model, embedding FROM face_vectors_prev WHERE group_id = ? ORDER BY id').all(groupId)) {
    if (r.model === g.model) continue;
    if (!out.has(r.model)) out.set(r.model, []);
    out.get(r.model).push(decodeEmbedding(r.embedding));
  }
  return out;
}

/** The switch is over: the waiting old-model vectors go. */
function dropPrevVectors() {
  const n = database.get().prepare('DELETE FROM face_vectors_prev').run().changes;
  if (n) bump();
  return n;
}

/** Small persisted facts (face_meta). */
function getMeta(key) {
  const r = database.get().prepare('SELECT value FROM face_meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function setMeta(key, value) {
  const db = database.get();
  if (value == null) db.prepare('DELETE FROM face_meta WHERE key = ?').run(key);
  else db.prepare('INSERT INTO face_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = {
  MAX_EXEMPLARS, ELIGIBLE_TYPES, KNOWN_DIMS, POS_IOU,
  switchSnapshot, switchFileModel, filesInModels, namedProgress, namedPeopleIn, modelMix, hasModel, groupVectorsByModel, dropPrevVectors, getMeta, setMeta, bboxIou, parseBbox, bump,
  version, peopleVersion, peopleUserVersion, bumpPeople, onChange, unhideGroup, onPeopleDeleted, emit, pruneEmptyPeople, maxPairCos, HIDE_MATCH,
  kindOf, encodeEmbedding, decodeEmbedding, normalize,
  cropDir, cropPath, putCrop, getCrop, hasCrop, removePlainCrops, removePlainCropsIfGone, migratePlainCrops,
  saveFileResult, markError, hideGroup, notFacePerson, cleanupForMedia, deleteAllData,
  getFileFaces, groupInfo, groupVectors, counts,
};
