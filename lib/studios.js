/**
 * Studios (STUDIOS_SPEC sections 1 and 2): a named group of files (one studio
 * per file, media.studio_id) and people (explicit studio_people members with
 * their years there, plus everyone with a visible face in the studio's files).
 *
 * Studios work with face search off: the people parts then come back empty.
 * Counts and "from files" people skip trashed files; hard-deleted files are
 * simply gone. Deleting a studio never deletes files.
 *
 * Covers are derived artifacts, stored like face crops (lib/faces/store.js):
 *   - encrypted library: secure-assets, key (0, 'studio-<id>'); media id 0 is
 *     never a real file (ids start at 1), so no file's purge touches it;
 *   - plain library: <thumbnailDir>/studios/<id>.jpg.
 * No cover chosen = the first file's thumbnail (coverKind null).
 *
 * Functions return plain objects and throw errors carrying { status, code }.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const database = require('./database');
const secureAssets = require('./secure-assets');
const ownedDir = require('./owned-dir');
const details = require('./detail-fields');

const { httpError } = details;
const SORTS = Object.freeze(['files', 'name', 'recent', 'years']);
const FILTERS = Object.freeze(['all', 'favorites', 'nophoto']);
const KINDS = Object.freeze(['all', 'video', 'photo']);
const LIST_LIMIT_MAX = 500;
const ASSIGN_MAX = 5000;
const PAIRS_MAX = 5000;
const PREVIEW_PEOPLE = 5;
const COVER_SIDE = 640;
const COVER_QUALITY = 85;
const COVER_TYPES = Object.freeze(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp']);
const MAX_TIME_S = 1e7;

// What the library grid can show (lib/library-query.js GRID_TYPES): counts
// and file lists match what the studio page's grid will hold.
const GRID_SQL = "('video', 'audio', 'image', 'gif', 'mix')";
// Files that have a folder of their own on disk (auto-match by folder name).
const FOLDER_SQL = "('video', 'audio', 'image', 'gif')";
const PHOTO_SQL = "('image', 'gif')";
// A face counts for "from files" like it does for a person's stats
// (lib/faces/people.js VISIBLE): visible, file not trashed, current model.
const VISIBLE = 'g.hidden = 0 AND m.user_trashed = 0 AND g.model = m.faces_model';

const notFound = () => httpError(404, 'NOT_FOUND', 'studio not found');
const nowIso = () => new Date().toISOString();
const nameKey = (name) => details.labelKey(name);   // NFKC, lower case
const isId = (v) => Number.isInteger(v) && v > 0 && v <= 0xFFFFFFFF;

let peopleOnFn = () => {
  try { return !!require('./faces/service').instance().getSettings().enabled; } catch { return false; }
};
/** Test seam / wiring: is face search on (people parts shown)? */
function setPeopleSource(fn) { peopleOnFn = fn; }
const peopleOn = () => { try { return !!peopleOnFn(); } catch { return false; } };

let framesLib = null;
const frames = () => framesLib || require('./faces/frames');
/** Test seam: replace the ffmpeg frame helpers. */
function setFrames(f) { framesLib = f; }

function vaultLocked() {
  try { return require('./vault').isLocked(); } catch { return false; }
}
const lockedError = () => httpError(423, 'VAULT_LOCKED', 'vault is locked');

/* ── Covers at rest ────────────────────────────────────────────────────── */

const COVER_MEDIA = 0;
const coverKind = (id) => `studio-${id}`;
function coverDir() { return path.join(config.paths.thumbnailDir, 'studios'); }
function coverPath(id) { return path.join(coverDir(), `${id}.jpg`); }

function putCover(id, buf) {
  if (secureAssets.enabled()) {
    if (!secureAssets.put(COVER_MEDIA, coverKind(id), buf)) throw httpError(500, 'COVER_NOT_SAVED', 'The photo could not be saved.');
    return;
  }
  // Same rule as face crops: never write into a thumbnails dir the app does
  // not own (it could never clean it up).
  if (!ownedDir.ensureManaged(config.paths.thumbnailDir, 'thumbs')) {
    throw httpError(500, 'COVER_NOT_SAVED', 'The photo could not be saved (the thumbnails folder is not managed by Vault).');
  }
  fs.mkdirSync(coverDir(), { recursive: true });
  const dest = coverPath(id);
  const tmp = `${dest}.part-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

function getCover(id) {
  if (secureAssets.enabled()) return secureAssets.get(COVER_MEDIA, coverKind(id));
  try { return fs.readFileSync(coverPath(id)); } catch { return null; }
}

function deleteCover(id) {
  if (secureAssets.enabled()) {
    try { secureAssets.del(COVER_MEDIA, coverKind(id)); } catch { /* store gone */ }
  }
  if (ownedDir.isOwned(config.paths.thumbnailDir)) {
    try { fs.unlinkSync(coverPath(id)); } catch { /* absent */ }
  }
}

/**
 * Vault turned on with plain covers on disk: move them into the store, delete
 * the plaintext. These are photos the user uploaded (nothing can make them
 * again), so a file is deleted only after its encrypted copy was written and
 * read back identical. While the store is sealed (vault locked) nothing is
 * touched; the next unlock runs this again.
 */
function migratePlainCovers() {
  if (!secureAssets.enabled() || !secureAssets.writable()) return 0;
  let names;
  try { names = fs.readdirSync(coverDir()); } catch { return 0; }
  if (!ownedDir.isOwned(config.paths.thumbnailDir)) return 0;
  let moved = 0;
  let kept = 0;
  let undeleted = 0;
  for (const name of names) {
    const full = path.join(coverDir(), name);
    const m = name.match(/^(\d+)\.jpg$/);
    if (m) {
      let buf;
      try { buf = fs.readFileSync(full); } catch { continue; }
      if (!secureAssets.putVerified(COVER_MEDIA, coverKind(Number(m[1])), buf)) { kept++; continue; }
      moved++;
      try { fs.unlinkSync(full); } catch { undeleted++; }
    } else if (/^\d+\.jpg\.part-/.test(name)) {
      try { fs.unlinkSync(full); } catch {}   // an interrupted upload, never a finished photo
    }
  }
  try { fs.rmdirSync(coverDir()); } catch { /* not empty */ }
  if (moved) {
    console.log(`[Studios] moved ${moved} studio cover(s) into secure_assets.db, ` +
      (undeleted ? `${moved - undeleted} plaintext file(s) deleted, ${undeleted} could not be deleted and will be retried`
        : 'plaintext deleted'));
  }
  if (kept) console.warn(`[Studios] ${kept} studio cover(s) could not be stored and were left in place. The next start or unlock tries again`);
  return moved;
}
secureAssets.addDiskMigrator(migratePlainCovers);

/* ── Reads ─────────────────────────────────────────────────────────────── */

function studioRow(id) {
  return database.get().prepare('SELECT * FROM studios WHERE id = ?').get(id) || null;
}

function requireStudio(id) {
  const row = studioRow(id);
  if (!row) throw notFound();
  return row;
}

const EMPTY_FILES = Object.freeze({ files: 0, videos: 0, photos: 0 });

/** studio id -> { files, videos, photos } (not trashed, grid types). */
function fileStats(id = null) {
  const map = new Map();
  const where = id == null ? 'studio_id IS NOT NULL' : 'studio_id = @id';
  for (const r of database.get().prepare(`SELECT studio_id AS sid, COUNT(*) AS files,
      SUM(media_type = 'video') AS videos, SUM(media_type IN ${PHOTO_SQL}) AS photos
    FROM media WHERE ${where} AND user_trashed = 0 AND media_type IN ${GRID_SQL}
    GROUP BY studio_id`).iterate(id == null ? {} : { id })) {
    map.set(r.sid, { files: r.files, videos: r.videos || 0, photos: r.photos || 0 });
  }
  return map;
}

/** studio id -> { id, thumb_version } of its first picture-bearing file (the automatic cover). */
function firstFiles(id = null) {
  const map = new Map();
  const where = id == null ? 'studio_id IS NOT NULL' : 'studio_id = @id';
  for (const r of database.get().prepare(`SELECT m.studio_id AS sid, m.id, m.thumb_version FROM media m
    JOIN (SELECT studio_id, MIN(id) AS mid FROM media WHERE ${where} AND user_trashed = 0
      AND media_type IN ('video', 'image', 'gif') GROUP BY studio_id) f ON f.mid = m.id`).iterate(id == null ? {} : { id })) {
    map.set(r.sid, { id: r.id, thumbVersion: r.thumb_version || 0 });
  }
  return map;
}

function coverUrlOf(row, first) {
  if (row.cover_kind) return `/api/studios/${row.id}/cover?v=${Date.parse(row.updated_at) || 0}`;
  if (!first) return null;
  // Thumbnails switched off in Settings: no automatic cover (the card shows
  // its letter, and nothing is asked for).
  const ts = require('./thumb-settings').get();
  if (ts.make === 'off') return null;
  // Same URL the viewer builds for a thumbnail (player-lib/thumbs.js).
  const v = ts.salt ? `${first.thumbVersion}-${ts.salt}` : String(first.thumbVersion);
  return first.thumbVersion && !secureAssets.enabled() ? `/thumb/${first.id}?v=${v}` : `/thumb/${first.id}`;
}

/**
 * studio id -> people entries [{ pid, explicit, yearStart, yearEnd, files }],
 * explicit members first (by first year, then name), then people found in
 * the files (most files first). Empty when face search is off.
 */
function peopleMap(id = null) {
  const map = new Map();
  if (!peopleOn()) return map;
  const db = database.get();
  const entry = (sid, pid) => {
    let list = map.get(sid);
    if (!list) { list = new Map(); map.set(sid, list); }
    let e = list.get(pid);
    if (!e) { e = { pid, explicit: false, yearStart: null, yearEnd: null, files: 0 }; list.set(pid, e); }
    return e;
  };
  const one = id != null;
  for (const r of db.prepare(`SELECT sp.studio_id AS sid, sp.person_id AS pid, sp.year_start, sp.year_end
    FROM studio_people sp JOIN face_people p ON p.id = sp.person_id ${one ? 'WHERE sp.studio_id = @id' : ''}`).iterate(one ? { id } : {})) {
    const e = entry(r.sid, r.pid);
    e.explicit = true; e.yearStart = r.year_start; e.yearEnd = r.year_end;
  }
  for (const r of db.prepare(`SELECT m.studio_id AS sid, g.cluster_id AS pid, COUNT(DISTINCT g.media_id) AS n
    FROM face_groups g JOIN media m ON m.id = g.media_id JOIN face_people p ON p.id = g.cluster_id AND p.hidden = 0
    WHERE ${one ? 'm.studio_id = @id' : 'm.studio_id IS NOT NULL'} AND g.cluster_id IS NOT NULL AND ${VISIBLE}
    GROUP BY m.studio_id, g.cluster_id`).iterate(one ? { id } : {})) {
    entry(r.sid, r.pid).files = r.n;
  }
  const names = new Map();
  const nameOf = (pid) => {
    if (!names.has(pid)) names.set(pid, db.prepare('SELECT name_key FROM face_people WHERE id = ?').get(pid)?.name_key || '￿');
    return names.get(pid);
  };
  const out = new Map();
  for (const [sid, list] of map) {
    out.set(sid, [...list.values()].sort((a, b) => (b.explicit - a.explicit)
      || (a.explicit ? ((a.yearStart ?? 9999) - (b.yearStart ?? 9999)) : (b.files - a.files))
      || nameOf(a.pid).localeCompare(nameOf(b.pid)) || (a.pid - b.pid)));
  }
  return out;
}

function personOut(e) {
  const people = require('./faces/people');
  const row = people.personRow(e.pid);
  const stats = people.statsMap().get(e.pid);
  return {
    id: e.pid,
    name: row ? row.name || null : null,
    cropUrl: row ? people.cropUrlOf(people.coverGroupId(row, stats)) : null,
    yearStart: e.yearStart,
    yearEnd: e.yearEnd,
    explicit: e.explicit,
    files: e.files,
  };
}

/** The list item (spec section 2). */
function item(row, stats, first, ppl) {
  const s = stats || EMPTY_FILES;
  const list = ppl || [];
  return {
    id: row.id,
    name: row.name,
    yearStart: row.year_start ?? null,
    yearEnd: row.year_end ?? null,
    favorite: !!row.favorite,
    coverUrl: coverUrlOf(row, first),
    coverKind: row.cover_kind || null,
    files: s.files,
    videos: s.videos,
    photos: s.photos,
    people: list.length,
    peoplePreview: list.slice(0, PREVIEW_PEOPLE).map(e => {
      const p = personOut(e);
      return { id: p.id, name: p.name, cropUrl: p.cropUrl };
    }),
  };
}

/** GET /api/studios/:id: the list item plus every field and all its people. */
function get(id) {
  const row = requireStudio(id);
  const ppl = peopleMap(id).get(id) || [];
  const base = item(row, fileStats(id).get(id), firstFiles(id).get(id), ppl);
  return {
    ...base,
    ...details.detailsOut(row),
    coverRef: row.cover_ref || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    peopleCount: base.people,
    people: ppl.map(personOut),
  };
}

const byName = (a, b) => a.row.name_key.localeCompare(b.row.name_key) || (a.row.id - b.row.id);
const lastYear = (row) => (row.year_start == null ? 0 : row.year_end ?? Infinity);
const SORTERS = {
  files: (a, b) => (b.s.files - a.s.files) || byName(a, b),
  name: byName,
  recent: (a, b) => String(b.row.created_at).localeCompare(String(a.row.created_at)) || (b.row.id - a.row.id),
  // Newest first: by last year (a start year with no end = "to now"), then
  // first year; studios with no years at the end.
  years: (a, b) => ((a.row.year_start == null) - (b.row.year_start == null))
    || (lastYear(b.row) - lastYear(a.row))
    || ((b.row.year_start ?? 0) - (a.row.year_start ?? 0)) || byName(a, b),
};

function intParam(v, def, min, max, name) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || !/^\d+$/.test(String(v).trim())) throw httpError(400, 'BAD_REQUEST', `${name} must be a whole number`);
  return Math.min(n, max);
}
const strParam = (v, def) => (v === undefined || v === null || v === '' ? def : String(v));

/**
 * GET /api/studios. counts cover every studio; the search box (name and
 * other names) and the filter narrow the list, not the counts.
 */
function list(query = {}) {
  const sort = strParam(query.sort, 'files');
  const filter = strParam(query.filter, 'all');
  if (!SORTS.includes(sort)) throw httpError(400, 'BAD_SORT', `sort must be one of ${SORTS.join(', ')}`);
  if (!FILTERS.includes(filter)) throw httpError(400, 'BAD_FILTER', `filter must be one of ${FILTERS.join(', ')}`);
  const offset = intParam(query.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = intParam(query.limit, 100, 1, LIST_LIMIT_MAX, 'limit');
  const needle = details.labelKey(query.q || '');
  const stats = fileStats();
  const firsts = firstFiles();
  const counts = { all: 0, favorites: 0, nophoto: 0 };
  const picked = [];
  for (const row of database.get().prepare('SELECT * FROM studios').iterate()) {
    counts.all++;
    if (row.favorite) counts.favorites++;
    if (!row.cover_kind) counts.nophoto++;
    if (filter === 'favorites' && !row.favorite) continue;
    if (filter === 'nophoto' && row.cover_kind) continue;
    if (needle && !row.name_key.includes(needle) && !details.labelKey(row.aliases || '').includes(needle)) continue;
    picked.push({ row, s: stats.get(row.id) || EMPTY_FILES });
  }
  picked.sort(SORTERS[sort]);
  const page = picked.slice(offset, offset + limit);
  const ppl = page.length ? peopleMap() : new Map();
  return {
    total: picked.length,
    counts,
    studios: page.map(e => item(e.row, e.s, firsts.get(e.row.id), ppl.get(e.row.id))),
  };
}

/** GET /api/studios/:id/files: ids of its files (not trashed), in folder order. */
function files(id, kind) {
  const k = strParam(kind, 'all');
  if (!KINDS.includes(k)) throw httpError(400, 'BAD_KIND', `kind must be one of ${KINDS.join(', ')}`);
  requireStudio(id);
  const kindClause = k === 'video' ? "AND media_type = 'video'" : k === 'photo' ? `AND media_type IN ${PHOTO_SQL}` : '';
  const ids = database.get().prepare(`SELECT id FROM media WHERE studio_id = ? AND user_trashed = 0
    AND media_type IN ${GRID_SQL} ${kindClause} ORDER BY filepath, id`).pluck().all(id);
  return { ids };
}

/**
 * Studios a person is in: explicit memberships (with years) and studios of
 * files they are seen in. For GET /api/faces/people/:id.
 */
function studiosOfPerson(pid) {
  const db = database.get();
  const by = new Map();
  for (const r of db.prepare('SELECT studio_id, year_start, year_end FROM studio_people WHERE person_id = ?').all(pid)) {
    by.set(r.studio_id, { sid: r.studio_id, explicit: true, yearStart: r.year_start, yearEnd: r.year_end, files: 0 });
  }
  for (const r of db.prepare(`SELECT m.studio_id AS sid, COUNT(DISTINCT g.media_id) AS n FROM face_groups g
    JOIN media m ON m.id = g.media_id
    WHERE g.cluster_id = ? AND m.studio_id IS NOT NULL AND ${VISIBLE} GROUP BY m.studio_id`).all(pid)) {
    const e = by.get(r.sid) || { sid: r.sid, explicit: false, yearStart: null, yearEnd: null, files: 0 };
    e.files = r.n;
    by.set(r.sid, e);
  }
  const out = [];
  for (const e of by.values()) {
    const row = studioRow(e.sid);
    if (!row) continue;
    out.push({
      id: row.id, name: row.name, coverUrl: coverUrlOf(row, firstFiles(row.id).get(row.id)),
      yearStart: e.yearStart, yearEnd: e.yearEnd, explicit: e.explicit, files: e.files,
      _key: row.name_key,
    });
  }
  out.sort((a, b) => (b.explicit - a.explicit) || ((a.yearStart ?? 9999) - (b.yearStart ?? 9999)) || a._key.localeCompare(b._key));
  return out.map(({ _key, ...s }) => s);
}

/* ── Writes ────────────────────────────────────────────────────────────── */

/** A studio name: required text, spaces collapsed, 200 characters at most. */
function cleanName(raw) {
  if (typeof raw !== 'string') throw httpError(400, 'BAD_NAME', 'name must be text');
  const name = details.cleanLabel(raw);   // no zero-width, control or bidi characters
  if (!name) throw httpError(400, 'BAD_NAME', 'A studio needs a name.');
  if (name.length > details.MAX_NAME) throw httpError(400, 'BAD_NAME', `names are ${details.MAX_NAME} characters at most`);
  return name;
}

function assertNameFree(db, name, exceptId) {
  const other = db.prepare('SELECT id, name FROM studios WHERE name_key = ? AND id != ?').get(nameKey(name), exceptId);
  if (other) throw httpError(409, 'NAME_TAKEN', 'There is already a studio with that name.', { otherId: other.id, other: { id: other.id, name: other.name } });
}

/** Column patch for POST /api/studios(/:id) bodies (name handled by the caller). */
function readFields(body, current) {
  const patch = details.readDetails(body, current);
  if (body.favorite !== undefined) {
    if (typeof body.favorite !== 'boolean') throw httpError(400, 'BAD_REQUEST', 'favorite must be true or false');
    patch.favorite = body.favorite ? 1 : 0;
  }
  return patch;
}

function bodyOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'BAD_REQUEST', 'send a JSON object');
  return body;
}

/** POST /api/studios { name, ...fields } */
function create(body) {
  body = bodyOf(body);
  const db = database.get();
  const name = cleanName(body.name);
  const patch = readFields(body, null);
  assertNameFree(db, name, 0);
  const stamp = nowIso();
  const cols = ['name', 'name_key', 'created_at', 'updated_at', ...Object.keys(patch)];
  const vals = [name, nameKey(name), stamp, stamp, ...Object.values(patch)];
  const id = Number(db.prepare(`INSERT INTO studios (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
  return get(id);
}

/** POST /api/studios/:id { name?, aliases?, urls?, description?, notes?, yearStart?, yearEnd?, favorite? } */
function update(id, body) {
  body = bodyOf(body);
  const db = database.get();
  const row = requireStudio(id);
  const patch = readFields(body, row);
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    assertNameFree(db, name, id);
    patch.name = name;
    patch.name_key = nameKey(name);
  }
  const cols = Object.keys(patch);
  if (cols.length) {
    db.prepare(`UPDATE studios SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...cols.map(c => patch[c]), nowIso(), id);
  }
  return get(id);
}

/** DELETE /api/studios/:id: files leave it (they stay in the library), members go, the cover is deleted. */
function remove(id) {
  const db = database.get();
  requireStudio(id);
  db.transaction(() => {
    db.prepare('UPDATE media SET studio_id = NULL WHERE studio_id = ?').run(id);
    db.prepare('DELETE FROM studio_people WHERE studio_id = ?').run(id);
    db.prepare('DELETE FROM studios WHERE id = ?').run(id);
  })();
  deleteCover(id);
  return { ok: true };
}

/**
 * POST /api/studios/:id/merge { into }: this studio's files and members move
 * to `into` (where both had a member, into's years stay), this one is
 * deleted. into keeps its own details and takes what it lacks; this studio's
 * name and other names become other names of into, so folder matching still
 * finds them. A chosen cover moves over when into has none.
 */
function merge(id, body) {
  body = bodyOf(body);
  const into = body.into;
  if (!isId(into)) throw httpError(400, 'BAD_REQUEST', 'into must be a studio id');
  if (into === id) throw httpError(400, 'BAD_REQUEST', 'a studio cannot merge into itself');
  const db = database.get();
  const from = requireStudio(id);
  const keep = requireStudio(into);
  const patch = details.mergeDetails(keep, from, { extraAliases: [from.name] });
  if (from.favorite && !keep.favorite) patch.favorite = 1;
  if (!keep.cover_kind && from.cover_kind) {
    const buf = getCover(id);
    if (buf) {
      putCover(into, buf);   // before the transaction: a failed write leaves only an unused file
      patch.cover_kind = from.cover_kind;
      patch.cover_ref = from.cover_kind === 'upload' ? coverKind(into) : from.cover_ref;
    }
  }
  db.transaction(() => {
    db.prepare('UPDATE media SET studio_id = ? WHERE studio_id = ?').run(into, id);
    db.prepare(`INSERT OR IGNORE INTO studio_people (studio_id, person_id, year_start, year_end, created_at)
      SELECT ?, person_id, year_start, year_end, created_at FROM studio_people WHERE studio_id = ?`).run(into, id);
    db.prepare('DELETE FROM studio_people WHERE studio_id = ?').run(id);
    db.prepare('DELETE FROM studios WHERE id = ?').run(id);
    const cols = Object.keys(patch);
    db.prepare(`UPDATE studios SET ${cols.map(c => `${c} = ?`).join(', ')}${cols.length ? ', ' : ''}updated_at = ? WHERE id = ?`)
      .run(...cols.map(c => patch[c]), nowIso(), into);
  })();
  deleteCover(id);
  return get(into);
}

function idList(raw, max) {
  if (!Array.isArray(raw) || !raw.length || raw.length > max || !raw.every(isId)) {
    throw httpError(400, 'BAD_IDS', `ids must be 1 to ${max.toLocaleString('en-US')} file ids`);
  }
  return [...new Set(raw)];
}

/** POST /api/media/studio { ids, studioId|null }: put files in a studio (or take them out). */
function assign(body) {
  body = bodyOf(body);
  const ids = idList(body.ids, ASSIGN_MAX);
  const sid = body.studioId === undefined ? undefined : body.studioId;
  if (sid !== null && !isId(sid)) throw httpError(400, 'BAD_REQUEST', 'studioId must be a studio id or null');
  if (sid !== null) requireStudio(sid);
  const db = database.get();
  const changed = db.transaction(() => {
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      n += db.prepare(`UPDATE media SET studio_id = ? WHERE id IN (${chunk.map(() => '?').join(',')}) AND studio_id IS NOT ?`)
        .run(sid, ...chunk, sid).changes;
    }
    return n;
  })();
  return { changed };
}

/** POST /api/studios/:id/people { personId, yearStart?, yearEnd? }: add a member or change their years. */
function setMember(id, body) {
  body = bodyOf(body);
  if (!peopleOn()) throw httpError(409, 'FACES_OFF', 'Face search is turned off.');
  const db = database.get();
  requireStudio(id);
  const pid = body.personId;
  if (!isId(pid)) throw httpError(400, 'BAD_REQUEST', 'personId must be a person id');
  if (!db.prepare('SELECT 1 FROM face_people WHERE id = ?').get(pid)) throw httpError(404, 'NOT_FOUND', 'person not found');
  const cur = db.prepare('SELECT year_start, year_end FROM studio_people WHERE studio_id = ? AND person_id = ?').get(id, pid);
  const ys = body.yearStart === undefined ? (cur ? cur.year_start : null) : details.cleanYear(body.yearStart, 'yearStart');
  const ye = body.yearEnd === undefined ? (cur ? cur.year_end : null) : details.cleanYear(body.yearEnd, 'yearEnd');
  if (ye != null && ys == null) throw httpError(400, 'BAD_YEARS', 'Set the first year too.');
  if (ye != null && ye < ys) throw httpError(400, 'BAD_YEARS', 'The last year cannot come before the first year.');
  db.prepare(`INSERT INTO studio_people (studio_id, person_id, year_start, year_end, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(studio_id, person_id) DO UPDATE SET year_start = excluded.year_start, year_end = excluded.year_end`)
    .run(id, pid, ys, ye, nowIso());
  return get(id);
}

/** POST /api/studios/:id/people/:personId/remove: no longer an explicit member (still listed if seen in its files). */
function removeMember(id, pid) {
  requireStudio(id);
  database.get().prepare('DELETE FROM studio_people WHERE studio_id = ? AND person_id = ?').run(id, pid);
  return get(id);
}

/* ── Cover writes ──────────────────────────────────────────────────────── */

async function encodeCover(decode) {
  const { encodeJpeg } = require('./faces/jpeg');
  const frame = await decode();
  return encodeJpeg(frame, COVER_QUALITY);
}

function saveCover(id, buf, kind, ref, secureAtStart) {
  // The vault locked (or changed mode) while ffmpeg ran: write nothing, and
  // never let an encrypted library's cover land as a plain file.
  if (vaultLocked() || secureAssets.enabled() !== secureAtStart) throw lockedError();
  requireStudio(id);
  putCover(id, buf);
  database.get().prepare('UPDATE studios SET cover_kind = ?, cover_ref = ?, updated_at = ? WHERE id = ?').run(kind, ref, nowIso(), id);
  return get(id);
}

/** Raw image upload (jpg/png/webp) -> 640 px JPEG cover. */
async function setCoverUpload(id, buf, contentType) {
  requireStudio(id);
  const secure = secureAssets.enabled();
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!COVER_TYPES.includes(type)) throw httpError(415, 'BAD_IMAGE', 'Choose a JPG, PNG or WebP photo.');
  if (!buf || !buf.length) throw httpError(400, 'BAD_IMAGE', 'the photo is empty');
  let jpeg;
  try {
    jpeg = await encodeCover(() => frames().decodeImageBuffer(buf, { maxSide: COVER_SIDE }));
  } catch (err) {
    if (err.status) throw err;
    throw httpError(400, 'BAD_IMAGE', 'That file could not be read as a photo.');
  }
  return saveCover(id, jpeg, 'upload', coverKind(id), secure);
}

/** JSON { mediaId, timeS }: a frame of one of the studio's files. */
async function setCoverFrame(id, body) {
  const row = requireStudio(id);
  const secure = secureAssets.enabled();
  const mid = body.mediaId;
  if (!isId(mid)) throw httpError(400, 'BAD_REQUEST', 'mediaId must be a file id');
  const t = body.timeS === undefined || body.timeS === null ? 0 : body.timeS;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > MAX_TIME_S) {
    throw httpError(400, 'BAD_REQUEST', 'timeS must be a number of seconds, 0 or more');
  }
  const m = database.get().prepare('SELECT id, filepath, media_type, duration_seconds, studio_id FROM media WHERE id = ?').get(mid);
  if (!m) throw httpError(404, 'NOT_FOUND', 'file not found');
  if (m.studio_id !== row.id) throw httpError(400, 'NOT_IN_STUDIO', 'That file is not in this studio.');
  if (!['video', 'image', 'gif'].includes(m.media_type)) throw httpError(400, 'NOT_ELIGIBLE', 'Only photos, GIFs and videos have a picture to use.');
  if (!fs.existsSync(m.filepath)) throw httpError(409, 'FILE_MISSING', 'source file missing on disk');
  let at = t;
  const dur = Number(m.duration_seconds);
  if (m.media_type === 'video' && Number.isFinite(dur) && dur > 0) at = Math.min(at, Math.max(0, dur - 0.1));
  let jpeg;
  try {
    jpeg = await encodeCover(() => (m.media_type === 'video'
      ? frames().grabFrame(m.filepath, at, { maxSide: COVER_SIDE })
      : frames().decodeImage(m.filepath, { maxSide: COVER_SIDE })));
  } catch (err) {
    if (err.status) throw err;
    throw httpError(422, 'FRAME_FAILED', 'Could not read that frame.');
  }
  return saveCover(id, jpeg, 'frame', `${mid}:${Math.round(at * 1000) / 1000}`, secure);
}

/** JSON { clear: true }: back to the automatic cover (first file's thumbnail). */
function clearCover(id) {
  requireStudio(id);
  database.get().prepare('UPDATE studios SET cover_kind = NULL, cover_ref = NULL, updated_at = ? WHERE id = ?').run(nowIso(), id);
  deleteCover(id);
  return get(id);
}

/** GET /api/studios/:id/cover: { buf } for a chosen cover, { redirect } for the automatic one. */
function coverImage(id) {
  const row = requireStudio(id);
  if (row.cover_kind) {
    const buf = getCover(id);
    if (buf) return { buf };
  } else {
    const first = firstFiles(id).get(id);
    if (first) return { redirect: coverUrlOf(row, first) };
  }
  throw httpError(404, 'NO_COVER', 'this studio has no picture');
}

/* ── Put files in studios by folder name ───────────────────────────────── */

// Words: runs of letters, digits (and their combining marks). Everything else
// separates, so "nasa_2024", "(NASA)" and "[NASA]" all hold the word "nasa".
const SEP = /[^\p{L}\p{N}\p{M}]+/u;
const wordsOf = (s) => details.labelKey(s).split(SEP).filter(Boolean);

/** Every name and other name of every studio, as word lists (studio-id order, name first). */
function studioTerms() {
  const terms = [];
  for (const r of database.get().prepare('SELECT id, name, aliases FROM studios ORDER BY id').all()) {
    [r.name, ...details.aliasList(r.aliases)].forEach((n, i) => {
      const w = wordsOf(n);
      if (w.length) terms.push({ sid: r.id, name: r.name, words: w, isName: i === 0 });
    });
  }
  return terms;
}

/** Is term a a better match than term b? A studio's name beats another name, then longer, then the older studio. */
function better(a, b) {
  if (!b) return true;
  if (a.isName !== b.isName) return a.isName;
  if (a.words.length !== b.words.length) return a.words.length > b.words.length;
  return a.sid < b.sid;
}

function containsWords(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The studio a folder name names (see better()). */
function matchFolderName(seg, terms) {
  const w = wordsOf(seg);
  if (!w.length) return null;
  let best = null;
  for (const t of terms) {
    if (t.words.length > w.length || !better(t, best)) continue;
    if (containsWords(w, t.words)) best = t;
  }
  return best;
}

/**
 * For each file (not trashed, with a folder on disk): the deepest folder in
 * its path whose name names a studio. Preview and apply share it, so apply
 * does exactly what the preview showed.
 * @returns {Map<string, {folder, sid, name, free: number[], taken: number}>} keyed by folder + studio
 */
function folderMatches() {
  const terms = studioTerms();
  const out = new Map();
  if (!terms.length) return out;
  const byDir = new Map();   // dir -> { folder, t } | null
  const rows = database.get().prepare(`SELECT id, filepath, studio_id FROM media
    WHERE user_trashed = 0 AND media_type IN ${FOLDER_SQL}`).iterate();
  for (const r of rows) {
    const fp = String(r.filepath || '');
    const cut = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
    if (cut <= 0) continue;
    const dir = fp.slice(0, cut);
    let hit = byDir.get(dir);
    if (hit === undefined) {
      hit = null;
      const sep = dir.includes('\\') ? '\\' : '/';
      const segs = dir.split(/[\\/]/);
      for (let i = segs.length - 1; i >= 0; i--) {
        const seg = segs[i];
        if (!seg || /^[a-z]:$/i.test(seg)) continue;
        const t = matchFolderName(seg, terms);
        if (t) { hit = { folder: segs.slice(0, i + 1).join(sep), t }; break; }
      }
      byDir.set(dir, hit);
    }
    if (!hit) continue;
    const key = `${hit.t.sid}\u0000${hit.folder}`;
    let e = out.get(key);
    if (!e) { e = { folder: hit.folder, sid: hit.t.sid, name: hit.t.name, free: [], taken: 0 }; out.set(key, e); }
    if (r.studio_id == null) e.free.push(r.id); else e.taken++;
  }
  return out;
}

/** POST /api/studios/auto/preview. Never writes. */
function autoPreview() {
  const matches = [...folderMatches().values()].map(e => ({
    folder: e.folder, studioId: e.sid, studioName: e.name, files: e.free.length, alreadyInStudio: e.taken,
  }));
  matches.sort((a, b) => a.studioName.toLowerCase().localeCompare(b.studioName.toLowerCase()) || a.folder.localeCompare(b.folder));
  return { matches };
}

/** POST /api/studios/auto/apply { pairs:[{folder, studioId}] }: files not in a studio yet join it. */
function autoApply(body) {
  body = bodyOf(body);
  const pairs = body.pairs;
  if (!Array.isArray(pairs) || pairs.length > PAIRS_MAX
    || !pairs.every(p => p && typeof p === 'object' && typeof p.folder === 'string' && p.folder.length <= 4096 && isId(p.studioId))) {
    throw httpError(400, 'BAD_REQUEST', `pairs must be a list of up to ${PAIRS_MAX} { folder, studioId }`);
  }
  for (const sid of new Set(pairs.map(p => p.studioId))) requireStudio(sid);
  const wanted = new Set(pairs.map(p => `${p.studioId}\u0000${p.folder}`));
  const db = database.get();
  const changed = db.transaction(() => {
    const st = db.prepare('UPDATE media SET studio_id = ? WHERE id = ? AND studio_id IS NULL');
    let n = 0;
    for (const [key, e] of folderMatches()) {
      if (!wanted.has(key)) continue;
      for (const mid of e.free) n += st.run(e.sid, mid).changes;
    }
    return n;
  })();
  return { changed };
}

/** File info: the studio a file is in, or null. */
function studioOfMedia(mediaId) {
  const r = database.get().prepare('SELECT s.id, s.name FROM media m JOIN studios s ON s.id = m.studio_id WHERE m.id = ?').get(mediaId);
  return r ? { id: r.id, name: r.name } : null;
}

module.exports = {
  SORTS, FILTERS, KINDS, COVER_TYPES,
  list, get, create, update, remove, merge, files, assign, setMember, removeMember,
  setCoverUpload, setCoverFrame, clearCover, coverImage,
  autoPreview, autoApply, studiosOfPerson, studioOfMedia,
  matchFolderName, wordsOf, studioTerms, migratePlainCovers, coverPath, coverDir,
  setPeopleSource, setFrames,
};
