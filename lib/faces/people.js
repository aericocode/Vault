/**
 * People across the library (FACES_PEOPLE_SPEC sections 1 to 3): reads and
 * user corrections over face_people and face_groups.cluster_id.
 *
 * A person is a set of face groups (one group = one person seen in one file).
 * The sorting job (people-sort.js) creates people and attaches new groups;
 * everything here is what the user does: name, favorite, hide, choose a cover,
 * merge, "Not this person" and the "Same person?" review.
 *
 * Stats (files, videos, photos, screen time, last added) always exclude
 * hidden face groups, trashed media and groups of an older model, and are
 * computed in one aggregate query. The cache is dropped at once by a face
 * write (store.version) or a user's people edit (store.peopleUserVersion);
 * otherwise it lives 2 s, so the sorting job's own writes (and trashing a
 * file, which moves no counter) show up within 2 s without the aggregate
 * running on every poll while it sorts.
 *
 * Every write bumps store.peopleVersion(). Functions return plain objects and
 * throw errors carrying { status, code } for the routes.
 */

const database = require('../database');
const store = require('./store');

const STATS_TTL_MS = 2000;
const MAX_NAME = 120;
const OFTEN_WITH = 6;
const COVER_MIN_DET = 0.90;
const COVER_SAMPLE = 500;
const FILTERS = Object.freeze(['all', 'named', 'unnamed', 'favorites', 'single', 'hidden']);
const SORTS = Object.freeze(['files', 'screen', 'recent', 'name']);
const KINDS = Object.freeze(['all', 'video', 'photo']);
const SQL_CHUNK = 500;

function httpError(status, code, message, extra = {}) {
  return Object.assign(new Error(message), { status, code }, extra);
}
const notFound = () => httpError(404, 'NOT_FOUND', 'person not found');
const nowIso = () => new Date().toISOString();
const nameKey = (name) => String(name).trim().toLowerCase();

// A group counts toward a person when it is visible, its file is not in the
// trash and it was found by the model that indexed the file.
const VISIBLE = 'g.hidden = 0 AND m.user_trashed = 0 AND g.model = m.faces_model';

/* ── Stats ─────────────────────────────────────────────────────────────── */

let statsCache = null;   // { at, v, uv, map }
let totalCache = null;   // { at, v, uv, n }
const coverCache = new Map();   // person id -> { sig, gid }
store.onPeopleDeleted((ids) => { for (const id of ids) coverCache.delete(id); });

const fresh = (c, v, uv, t) => c && c.v === v && c.uv === uv && t - c.at < STATS_TTL_MS
  && (!c.spacing || c.spacing === spacingKey());

/*
 * Screen time of a video face group: appearances x the spacing between the
 * frames that were checked. Files checked since screen_s existed carry it;
 * for older ones (screen_s NULL) it is worked out at read time from the
 * file's stored spacing, else the spacing the file would get now:
 * max(intervalS, duration / maxFrames). Read time rather than a one-off
 * backfill: it needs the user's current settings (not readable from the
 * schema migration), costs one expression in queries that run anyway, and
 * the numbers become exact by themselves as files are re-checked.
 */
let spacingOf = () => ({ intervalS: 3.5, maxFrames: 2000 });
/** The service hands in its settings (intervalS, maxFrames). */
function setSpacingSource(fn) { spacingOf = fn; statsCache = null; }
function spacing() {
  const s = spacingOf() || {};
  return { iv: Number(s.intervalS) > 0 ? Number(s.intervalS) : 3.5, mf: Number(s.maxFrames) > 0 ? Number(s.maxFrames) : 2000 };
}
const spacingKey = () => { const { iv, mf } = spacing(); return `${iv}/${mf}`; };
const SCREEN = `(CASE WHEN m.media_type = 'video' THEN COALESCE(g.screen_s,
  g.appearances * COALESCE(m.faces_interval_s, MAX(@iv, COALESCE(m.duration_seconds, 0) / @mf))) END)`;

/** Map person id -> { groups, maxGid, files, videos, photos, screenS, addedAt } (non-empty people only). */
function statsMap() {
  const v = store.version(), uv = store.peopleUserVersion(), t = Date.now();
  if (fresh(statsCache, v, uv, t)) return statsCache.map;
  const map = new Map();
  for (const r of database.get().prepare(`SELECT g.cluster_id AS pid, COUNT(*) AS groups, MAX(g.id) AS maxGid,
      COUNT(DISTINCT g.media_id) AS files,
      COUNT(DISTINCT CASE WHEN m.media_type = 'video' THEN g.media_id END) AS videos,
      SUM(${SCREEN}) AS screenS,
      MAX(g.created_at) AS addedAt
    FROM face_groups g JOIN media m ON m.id = g.media_id
    WHERE g.cluster_id IS NOT NULL AND ${VISIBLE}
    GROUP BY g.cluster_id`).iterate(spacing())) {
    map.set(r.pid, {
      groups: r.groups, maxGid: r.maxGid, files: r.files, videos: r.videos, photos: r.files - r.videos,
      screenS: r.screenS == null ? 0 : Math.round(r.screenS * 10) / 10, addedAt: r.addedAt,
    });
  }
  statsCache = { at: t, v, uv, spacing: spacingKey(), map };
  return map;
}

const EMPTY_STATS = Object.freeze({ groups: 0, maxGid: 0, files: 0, videos: 0, photos: 0, screenS: 0, addedAt: null });

function resetCaches() { statsCache = null; totalCache = null; coverCache.clear(); }

/* ── Covers ────────────────────────────────────────────────────────────── */

function meanVec(vecs) {
  const out = new Float32Array(store.EMBED_DIM);
  for (const v of vecs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return store.normalize(out);
}

/**
 * Cover group for a person: the user's pick while it is still one of the
 * person's visible faces; else the face closest to the person's centroid
 * among clear (det >= 0.90) and larger-than-median faces; else the highest
 * detection score. Cached per person until its membership changes.
 */
function coverGroupId(row, stats) {
  if (!stats || !stats.groups) return null;
  const db = database.get();
  if (row.cover_group_id != null) {
    const ok = db.prepare(`SELECT 1 FROM face_groups g JOIN media m ON m.id = g.media_id
      WHERE g.id = ? AND g.cluster_id = ? AND ${VISIBLE}`).get(row.cover_group_id, row.id);
    if (ok) return row.cover_group_id;
  }
  const sig = `${stats.groups}:${stats.maxGid}`;
  const hit = coverCache.get(row.id);
  if (hit && hit.sig === sig) return hit.gid;
  const groups = db.prepare(`SELECT g.id, g.det_score, g.best_bbox FROM face_groups g JOIN media m ON m.id = g.media_id
    WHERE g.cluster_id = ? AND ${VISIBLE} ORDER BY COALESCE(g.det_score, 0) DESC, g.id LIMIT ${COVER_SAMPLE}`).all(row.id);
  let gid = groups.length ? groups[0].id : null;
  if (groups.length > 2) {
    const vecs = new Map();
    const ids = groups.map(g => g.id);
    for (let i = 0; i < ids.length; i += SQL_CHUNK) {
      const chunk = ids.slice(i, i + SQL_CHUNK);
      for (const r of db.prepare(`SELECT group_id, embedding FROM face_vectors WHERE group_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        if (!vecs.has(r.group_id)) vecs.set(r.group_id, []);
        vecs.get(r.group_id).push(store.decodeEmbedding(r.embedding));
      }
    }
    const means = new Map();
    for (const [k, list] of vecs) means.set(k, meanVec(list));
    const centroid = meanVec([...means.values()]);
    const area = (g) => { try { const b = JSON.parse(g.best_bbox); return (b[2] || 0) * (b[3] || 0); } catch { return 0; } };
    const areas = groups.map(area).sort((a, b) => a - b);
    const median = areas[Math.floor(areas.length / 2)];
    const cands = groups.filter(g => (g.det_score || 0) >= COVER_MIN_DET && area(g) >= median && means.has(g.id));
    let best = -2;
    for (const g of cands) {
      const m = means.get(g.id);
      let d = 0;
      for (let i = 0; i < m.length; i++) d += m[i] * centroid[i];
      if (d > best) { best = d; gid = g.id; }
    }
  }
  coverCache.set(row.id, { sig, gid });
  return gid;
}

function cropUrlOf(gid) {
  if (gid == null) return null;
  const g = store.groupInfo(gid);
  return g && store.hasCrop(g.media_id, gid) ? `/api/faces/crop/${gid}` : null;
}

/* ── Shapes ────────────────────────────────────────────────────────────── */

function personRow(id) {
  return database.get().prepare('SELECT * FROM face_people WHERE id = ?').get(id) || null;
}

/** The list item shape (spec section 3). */
function item(row, stats = statsMap().get(row.id) || EMPTY_STATS) {
  return {
    id: row.id,
    name: row.name || null,
    favorite: !!row.favorite,
    hidden: !!row.hidden,
    files: stats.files,
    videos: stats.videos,
    photos: stats.photos,
    screenS: stats.screenS,
    coverUrl: cropUrlOf(coverGroupId(row, stats)),
    addedAt: stats.addedAt,
  };
}

function smallItem(row, stats) {
  return { id: row.id, name: row.name || null, coverUrl: cropUrlOf(coverGroupId(row, stats)) };
}

/* ── Listing ───────────────────────────────────────────────────────────── */

const byName = (a, b) => (a.row.name_key || '').localeCompare(b.row.name_key || '');
const SORTERS = {
  // favorites first, then most files, then name (named before unnamed)
  files: (a, b) => (b.row.favorite - a.row.favorite) || (b.s.files - a.s.files)
    || ((a.row.name == null) - (b.row.name == null)) || byName(a, b) || (a.row.id - b.row.id),
  screen: (a, b) => (b.s.screenS - a.s.screenS) || (b.s.files - a.s.files) || (a.row.id - b.row.id),
  recent: (a, b) => String(b.s.addedAt || '').localeCompare(String(a.s.addedAt || '')) || (b.row.id - a.row.id),
  name: (a, b) => ((a.row.name == null) - (b.row.name == null)) || byName(a, b)
    || (b.s.files - a.s.files) || (a.row.id - b.row.id),
};

function matchesFilter(e, filter) {
  const { row, s } = e;
  if (filter === 'hidden') return !!row.hidden;
  if (row.hidden) return false;
  switch (filter) {
    case 'named': return row.name != null;
    case 'unnamed': return row.name == null;
    case 'favorites': return !!row.favorite;
    case 'single': return s.files === 1;
    default: return true;
  }
}

/**
 * GET /api/faces/people. Counts for every filter come from one pass over the
 * (cached) stats; the search box narrows the list, not the counts.
 */
function list({ filter = 'all', sort = 'files', q = '', offset = 0, limit = 100 } = {}) {
  if (!FILTERS.includes(filter)) throw httpError(400, 'BAD_FILTER', `filter must be one of ${FILTERS.join(', ')}`);
  if (!SORTS.includes(sort)) throw httpError(400, 'BAD_SORT', `sort must be one of ${SORTS.join(', ')}`);
  const stats = statsMap();
  const counts = { all: 0, named: 0, unnamed: 0, favorites: 0, single: 0, hidden: 0 };
  const needle = String(q || '').trim().toLowerCase();
  const picked = [];
  for (const row of database.get().prepare('SELECT * FROM face_people').iterate()) {
    const s = stats.get(row.id);
    if (!s) continue;   // empty people (kept names) never show
    const e = { row, s };
    if (row.hidden) counts.hidden++;
    else {
      counts.all++;
      if (row.name != null) counts.named++; else counts.unnamed++;
      if (row.favorite) counts.favorites++;
      if (s.files === 1) counts.single++;
    }
    if (!matchesFilter(e, filter)) continue;
    if (needle && !(row.name_key || '').includes(needle)) continue;
    picked.push(e);
  }
  picked.sort(SORTERS[sort]);
  const page = picked.slice(offset, offset + limit);
  return { total: picked.length, counts, people: page.map(e => item(e.row, e.s)) };
}

/** Number of people the Faces tab shows under "Everyone". */
function total() {
  const v = store.version(), uv = store.peopleUserVersion(), t = Date.now();
  if (fresh(totalCache, v, uv, t)) return totalCache.n;
  const n = database.get().prepare(`SELECT COUNT(*) AS n FROM face_people p WHERE p.hidden = 0 AND EXISTS
    (SELECT 1 FROM face_groups g JOIN media m ON m.id = g.media_id WHERE g.cluster_id = p.id AND ${VISIBLE})`).get().n;
  totalCache = { at: t, v, uv, n };
  return n;
}

/* ── One person ────────────────────────────────────────────────────────── */

function requirePerson(id) {
  const row = personRow(id);
  if (!row) throw notFound();
  return row;
}

/** GET /api/faces/people/:id: the list item plus coverGroupId and oftenWith. */
function get(id) {
  const row = requirePerson(id);
  const stats = statsMap();
  const s = stats.get(id) || EMPTY_STATS;
  const others = database.get().prepare(`SELECT g2.cluster_id AS pid, COUNT(DISTINCT g2.media_id) AS shared
    FROM face_groups g1 JOIN media m ON m.id = g1.media_id
    JOIN face_groups g2 ON g2.media_id = g1.media_id AND g2.cluster_id IS NOT NULL AND g2.cluster_id != g1.cluster_id
      AND g2.hidden = 0 AND g2.model = m.faces_model
    JOIN face_people p ON p.id = g2.cluster_id AND p.hidden = 0
    WHERE g1.cluster_id = ? AND g1.hidden = 0 AND m.user_trashed = 0 AND g1.model = m.faces_model
    GROUP BY g2.cluster_id ORDER BY shared DESC, g2.cluster_id LIMIT ${OFTEN_WITH}`).all(id);
  const oftenWith = others.map(o => {
    const r = personRow(o.pid);
    return { ...smallItem(r, stats.get(o.pid)), shared: o.shared };
  });
  return { ...item(row, s), coverGroupId: coverGroupId(row, s), oftenWith };
}

/**
 * GET /api/faces/people/:id/files. Videos by the person's screen time in them
 * (then appearances), then photos and GIFs, each tie broken by media id.
 */
function files(id, kind = 'all') {
  if (!KINDS.includes(kind)) throw httpError(400, 'BAD_KIND', `kind must be one of ${KINDS.join(', ')}`);
  requirePerson(id);
  const kindClause = kind === 'video' ? "AND m.media_type = 'video'" : kind === 'photo' ? "AND m.media_type != 'video'" : '';
  const rows = database.get().prepare(`SELECT g.id, g.media_id, g.appearances, g.first_time_s, ${SCREEN} AS screen_s, m.media_type
    FROM face_groups g JOIN media m ON m.id = g.media_id
    WHERE g.cluster_id = @id AND ${VISIBLE} ${kindClause} ORDER BY g.media_id, g.id`).all({ id, ...spacing() });
  const by = new Map();
  for (const r of rows) {
    let f = by.get(r.media_id);
    if (!f) { f = { video: r.media_type === 'video', screen: 0, out: { firstTimeS: null, appearances: 0, groupIds: [] } }; by.set(r.media_id, f); }
    f.out.appearances += r.appearances;
    f.out.groupIds.push(r.id);
    f.screen += r.screen_s || 0;
    if (r.first_time_s != null && (f.out.firstTimeS == null || r.first_time_s < f.out.firstTimeS)) f.out.firstTimeS = r.first_time_s;
  }
  const ids = [...by.keys()].sort((a, b) => {
    const A = by.get(a), B = by.get(b);
    if (A.video !== B.video) return A.video ? -1 : 1;
    if (A.video) return (B.screen - A.screen) || (B.out.appearances - A.out.appearances) || (a - b);
    return a - b;
  });
  const out = {};
  for (const mid of ids) out[mid] = by.get(mid).out;
  return { ids, files: out };
}

/** GET /api/faces/people/:id/faces: one face per file, the cover's file first. */
function faces(id, limit = 8) {
  const row = requirePerson(id);
  const s = statsMap().get(id);
  const cover = coverGroupId(row, s);
  const rows = database.get().prepare(`SELECT g.id, g.media_id FROM face_groups g JOIN media m ON m.id = g.media_id
    WHERE g.cluster_id = ? AND ${VISIBLE} ORDER BY COALESCE(g.det_score, 0) DESC, g.id`).all(id);
  const seen = new Set();
  const out = [];
  const coverRow = rows.find(r => r.id === cover);
  for (const r of coverRow ? [coverRow, ...rows] : rows) {
    if (seen.has(r.media_id)) continue;
    seen.add(r.media_id);
    out.push({ groupId: r.id, mediaId: r.media_id, cropUrl: cropUrlOf(r.id) });
    if (out.length >= limit) break;
  }
  return out;
}

/* ── Corrections ───────────────────────────────────────────────────────── */

function lockMembers(db, id) {
  db.prepare('UPDATE face_groups SET person_locked = 1 WHERE cluster_id = ?').run(id);
}

/** Would the Faces grid show this person (any visible face in a file not in the trash)? */
function isVisible(db, id) {
  return !!db.prepare(`SELECT 1 FROM face_groups g JOIN media m ON m.id = g.media_id
    WHERE g.cluster_id = ? AND ${VISIBLE} LIMIT 1`).get(id);
}

/**
 * Move every group of `from` people into `into`, lock them, carry rejects and
 * decisions over, and delete the merged people. Inside a transaction.
 */
function mergeInto(db, into, from) {
  const stamp = nowIso();
  const target = personRow(into);
  let name = target.name, key = target.name_key;
  let favorite = target.favorite;
  for (const pid of from) {
    const r = personRow(pid);
    if (!r) continue;
    if (name == null && r.name != null) { name = r.name; key = r.name_key; }
    if (r.favorite) favorite = 1;
    db.prepare('UPDATE face_groups SET cluster_id = ? WHERE cluster_id = ?').run(into, pid);
    db.prepare('INSERT OR IGNORE INTO face_person_rejects (person_id, group_id) SELECT ?, group_id FROM face_person_rejects WHERE person_id = ?').run(into, pid);
    db.prepare('DELETE FROM face_person_rejects WHERE person_id = ?').run(pid);
    for (const d of db.prepare('SELECT a, b, decision, created_at FROM face_pair_decisions WHERE a = ? OR b = ?').all(pid, pid)) {
      const o = d.a === pid ? d.b : d.a;
      if (o !== into && !from.includes(o)) {
        db.prepare('INSERT OR IGNORE INTO face_pair_decisions (a, b, decision, created_at) VALUES (?, ?, ?, ?)')
          .run(Math.min(into, o), Math.max(into, o), d.decision, d.created_at);
      }
    }
    db.prepare('DELETE FROM face_pair_decisions WHERE a = ? OR b = ?').run(pid, pid);
    db.prepare('DELETE FROM face_person_suggestions WHERE a = ? OR b = ?').run(pid, pid);
    db.prepare('DELETE FROM face_people WHERE id = ?').run(pid);
    coverCache.delete(pid);
  }
  // A face the user just put into this person is no longer "not this person".
  db.prepare('DELETE FROM face_person_rejects WHERE person_id = ? AND group_id IN (SELECT id FROM face_groups WHERE cluster_id = ?)').run(into, into);
  db.prepare('DELETE FROM face_person_suggestions WHERE a = ? OR b = ?').run(into, into);
  lockMembers(db, into);
  db.prepare('UPDATE face_people SET name = ?, name_key = ?, favorite = ?, updated_at = ? WHERE id = ?')
    .run(name, key, favorite, stamp, into);
}

/** POST /api/faces/people/merge { ids, into }. @returns {{person, merged:number[]}} */
function merge(ids, into) {
  const db = database.get();
  const from = ids.filter(id => id !== into);
  for (const id of ids) if (!personRow(id)) throw notFound();
  db.transaction(() => mergeInto(db, into, from))();
  store.bumpPeople();
  coverCache.delete(into);
  return { person: get(into), merged: from };
}

/** A name from a request: text, spaces collapsed; '' or null = no name. Throws BAD_NAME. */
function cleanName(raw) {
  if (raw !== null && raw !== undefined && typeof raw !== 'string') throw httpError(400, 'BAD_NAME', 'name must be text');
  const name = raw == null ? '' : raw.replace(/\s+/g, ' ').trim();
  if (name.length > MAX_NAME) throw httpError(400, 'BAD_NAME', `names are ${MAX_NAME} characters at most`);
  return name || null;
}

/**
 * Other people holding this name. Same rule as the grid: a person with no
 * visible face in a file outside the trash (an empty kept name, trashed files
 * only, hidden faces only) is not shown, so its name is taken over without
 * asking: it merges into the new holder (faces, favorite, rejects and answers
 * come along). A visible person (also one the user hid) asks first.
 * @returns {{ shown: object|null, absorb: number[] }}
 */
function nameHolders(db, name, exceptId) {
  const others = db.prepare('SELECT * FROM face_people WHERE name_key = ? AND id != ? ORDER BY id').all(nameKey(name), exceptId);
  const shown = others.find(o => isVisible(db, o.id)) || null;
  return { shown, absorb: others.filter(o => o !== shown).map(o => o.id) };
}

const nameTaken = (shown) => httpError(409, 'NAME_TAKEN', 'That name is already in Faces.', { otherId: shown.id, other: item(shown) });

/**
 * POST /api/faces/people/:id { name?, favorite?, hidden?, coverGroupId?, mergeIfTaken? }
 * A name another non-empty person has -> 409 NAME_TAKEN unless mergeIfTaken
 * (then this person merges into that one). A name only an EMPTY person holds
 * (kept after its files were deleted) is simply taken over.
 * @returns {{ person, mergedInto: number|null }}
 */
function update(id, body = {}) {
  const db = database.get();
  requirePerson(id);
  const patch = {};
  if (body.name !== undefined) patch.name = cleanName(body.name);
  for (const k of ['favorite', 'hidden']) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') throw httpError(400, 'BAD_REQUEST', `${k} must be true or false`);
      patch[k] = body[k] ? 1 : 0;
    }
  }
  if (body.coverGroupId !== undefined) {
    const g = body.coverGroupId;
    if (g !== null) {
      if (!Number.isInteger(g) || g <= 0) throw httpError(400, 'BAD_COVER', 'coverGroupId must be a face of this person');
      const ok = db.prepare(`SELECT 1 FROM face_groups g JOIN media m ON m.id = g.media_id
        WHERE g.id = ? AND g.cluster_id = ? AND ${VISIBLE}`).get(g, id);
      if (!ok) throw httpError(400, 'BAD_COVER', 'coverGroupId must be a face of this person');
    }
    patch.cover_group_id = g;
  }
  if (body.mergeIfTaken !== undefined && typeof body.mergeIfTaken !== 'boolean') {
    throw httpError(400, 'BAD_REQUEST', 'mergeIfTaken must be true or false');
  }

  let mergedInto = null;
  let absorb = [];   // people holding this name that the grid does not show
  if (patch.name != null) {
    const holders = nameHolders(db, patch.name, id);
    absorb = holders.absorb;
    if (holders.shown) {
      if (body.mergeIfTaken === true) mergedInto = holders.shown.id;
      else throw nameTaken(holders.shown);
    }
  }

  const stamp = nowIso();
  db.transaction(() => {
    const cols = Object.keys(patch);
    if (cols.length) {
      const sets = cols.map(c => `${c} = ?`);
      const vals = cols.map(c => patch[c]);
      if (patch.name !== undefined) { sets.push('name_key = ?'); vals.push(patch.name == null ? null : nameKey(patch.name)); }
      db.prepare(`UPDATE face_people SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, stamp, id);
    }
    if (absorb.length) mergeInto(db, id, absorb);
    // Naming says "these faces are this person": auto-sorting never moves them.
    if (patch.name != null) lockMembers(db, id);
    // Hidden people are never part of a "Same person?" question.
    if (patch.hidden === 1) db.prepare('DELETE FROM face_person_suggestions WHERE a = ? OR b = ?').run(id, id);
    if (mergedInto != null) {
      // The surviving person keeps its own name; this one's other edits
      // (favorite) carry over through mergeInto.
      db.prepare('UPDATE face_people SET name = NULL, name_key = NULL WHERE id = ?').run(id);
      mergeInto(db, mergedInto, [id]);
    }
  })();
  // Faces only change person when names were merged; otherwise the sorting
  // job's centroids stay valid.
  store.bumpPeople({ membership: absorb.length > 0 || mergedInto != null });
  coverCache.delete(id);
  const final = mergedInto ?? id;
  return { person: get(final), mergedInto };
}

/**
 * "Not this person", step 1: the groups of person `id` in a file.
 * @returns {number[]} group ids (404 when the person is not in that file)
 */
function notInGroups(id, mediaId) {
  requirePerson(id);
  const ids = database.get().prepare('SELECT id FROM face_groups WHERE cluster_id = ? AND media_id = ? ORDER BY id')
    .all(id, mediaId).map(r => r.id);
  if (!ids.length) throw httpError(404, 'NOT_FOUND', 'this person is not in that file');
  return ids;
}

/**
 * "Not this person", step 2, inside the sorting job's transaction (which then
 * sorts the faces again with this person excluded): the faces leave the
 * person, unlocked, and a reject keeps them (and a re-check of them) out of
 * it for good.
 */
function detachForNotIn(db, id, groupIds) {
  const stamp = nowIso();
  for (const gid of groupIds) {
    db.prepare('UPDATE face_groups SET cluster_id = NULL, person_locked = 0 WHERE id = ? AND cluster_id = ?').run(gid, id);
    db.prepare('INSERT OR IGNORE INTO face_person_rejects (person_id, group_id) VALUES (?, ?)').run(id, gid);
  }
  db.prepare('UPDATE face_people SET updated_at = ? WHERE id = ?').run(stamp, id);
  db.prepare('DELETE FROM face_person_suggestions WHERE a = ? OR b = ?').run(id, id);
  coverCache.delete(id);
}

/**
 * POST /api/faces/people/:id/restore { groupIds }: put these faces (back)
 * into this person, locked, and drop their "not this person" rejects for it.
 * The exact undo of not-in; a person the faces leave is pruned if that left
 * it with no visible face and no name or favorite.
 * @returns {{ person, from: number[] }}
 */
function restore(id, groupIds) {
  const db = database.get();
  requirePerson(id);
  const rows = groupIds.map(g => db.prepare('SELECT id, cluster_id FROM face_groups WHERE id = ?').get(g));
  if (rows.some(r => !r)) throw httpError(404, 'NOT_FOUND', 'face not found');
  const from = [...new Set(rows.map(r => r.cluster_id).filter(c => c != null && c !== id))];
  db.transaction(() => {
    for (const r of rows) {
      db.prepare('UPDATE face_groups SET cluster_id = ?, person_locked = 1 WHERE id = ?').run(id, r.id);
      db.prepare('DELETE FROM face_person_rejects WHERE person_id = ? AND group_id = ?').run(id, r.id);
    }
    db.prepare('UPDATE face_people SET updated_at = ? WHERE id = ?').run(nowIso(), id);
    store.pruneEmptyPeople(db, from);
  })();
  store.bumpPeople();
  coverCache.delete(id);
  for (const f of from) coverCache.delete(f);
  return { person: get(id), from };
}

/* ── Adding faces (FACES_FEEDBACK_SPEC E2, E3) ─────────────────────────── */

/**
 * Move these face groups into person `id`, inside the caller's transaction.
 * Moved faces are locked and lose their "not this person" reject for `id`.
 * Faces already in the person are listed in `already` (and locked).
 * Skipped: 'gone' (no such face), 'hidden' (hidden or not a face),
 * 'other-named' (in another named person, unless takeFromNamed).
 * @returns {{ moved: number[], already: number[], skipped: {groupId, reason}[], from: number[], locked: number }}
 */
function addGroupsTx(db, id, groupIds, { takeFromNamed = false } = {}) {
  const read = db.prepare(`SELECT g.id, g.cluster_id, g.hidden, g.person_locked, p.name AS pname
    FROM face_groups g LEFT JOIN face_people p ON p.id = g.cluster_id WHERE g.id = ?`);
  const move = db.prepare('UPDATE face_groups SET cluster_id = ?, person_locked = 1 WHERE id = ?');
  const unreject = db.prepare('DELETE FROM face_person_rejects WHERE person_id = ? AND group_id = ?');
  const moved = [], already = [], skipped = [], from = new Set();
  let locked = 0;
  for (const gid of groupIds) {
    const r = read.get(gid);
    if (!r) { skipped.push({ groupId: gid, reason: 'gone' }); continue; }
    if (r.hidden) { skipped.push({ groupId: gid, reason: 'hidden' }); continue; }
    if (r.cluster_id === id) {
      already.push(gid);
      if (!r.person_locked) { db.prepare('UPDATE face_groups SET person_locked = 1 WHERE id = ?').run(gid); locked++; }
      continue;
    }
    if (r.cluster_id != null && r.cluster_id !== id && r.pname != null && !takeFromNamed) {
      skipped.push({ groupId: gid, reason: 'other-named' });
      continue;
    }
    move.run(id, gid);
    unreject.run(id, gid);
    if (r.cluster_id != null) from.add(r.cluster_id);
    moved.push(gid);
  }
  if (moved.length) db.prepare('UPDATE face_people SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  return { moved, already, skipped, from: [...from], locked };
}

function afterAdd(id, from, { membership = true } = {}) {
  store.bumpPeople({ membership });
  coverCache.delete(id);
  for (const f of from) coverCache.delete(f);
}

/**
 * POST /api/faces/people/:id/add { groupIds, takeFromNamed? }. People the
 * faces left are pruned as usual (unless named or favorite).
 * @returns {{ person, moved, skipped, from }}
 */
function add(id, groupIds, opts = {}) {
  const db = database.get();
  requirePerson(id);
  const out = db.transaction(() => {
    const r = addGroupsTx(db, id, groupIds, opts);
    store.pruneEmptyPeople(db, r.from);
    return r;
  })();
  // Nothing moved: no counter moves (a lock alone changes no stats or centroid).
  if (out.moved.length) afterAdd(id, out.from);
  else if (out.locked) store.bumpPeople({ membership: false });
  const { locked, ...rest } = out;
  return { person: get(id), ...rest };
}

/**
 * POST /api/faces/people { name?, groupIds, mergeIfTaken?, takeFromNamed? }:
 * a new person made of these faces. A name another shown person has is
 * NAME_TAKEN (409) unless mergeIfTaken, which adds the faces to that person
 * instead; a name only hidden-from-the-grid people hold is taken over. When
 * none of the faces can be moved nothing is created (409 NO_FACES).
 * @returns {{ person, moved, skipped, from, mergedInto: number|null }}
 */
function create({ name, groupIds, mergeIfTaken = false, takeFromNamed = false }) {
  const db = database.get();
  const clean = cleanName(name);
  let absorb = [];
  if (clean != null) {
    const holders = nameHolders(db, clean, 0);
    if (holders.shown) {
      if (!mergeIfTaken) throw nameTaken(holders.shown);
      return { ...add(holders.shown.id, groupIds, { takeFromNamed }), mergedInto: holders.shown.id };
    }
    absorb = holders.absorb;
  }
  const stamp = nowIso();
  const out = db.transaction(() => {
    const pid = Number(db.prepare('INSERT INTO face_people (name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(clean, clean == null ? null : nameKey(clean), stamp, stamp).lastInsertRowid);
    const r = addGroupsTx(db, pid, groupIds, { takeFromNamed });
    if (!r.moved.length) throw httpError(409, 'NO_FACES', 'None of those faces can be added.', { skipped: r.skipped });
    if (absorb.length) mergeInto(db, pid, absorb);
    store.pruneEmptyPeople(db, r.from);
    return { pid, ...r };
  })();
  afterAdd(out.pid, out.from);
  return { person: get(out.pid), moved: out.moved, already: [], skipped: out.skipped, from: out.from, mergedInto: null };
}

/* ── "Might also be" answers (FACES_FEEDBACK_SPEC E4) ──────────────────── */

/**
 * POST /api/faces/people/:id/candidates { accept, reject }: accepted people
 * merge into this one (faces locked); rejected ones get a 'different'
 * decision. Never merged from here: named people ('named'), hidden people
 * ('hidden') and people with a 'different' answer for this one
 * ('different'); people gone meanwhile are skipped ('gone'). unreject takes a
 * 'different' answer back (the Undo of a rejection), so the person can be
 * suggested again.
 * @returns {{ person, merged: number[], rejected: number[], unrejected: number[], skipped: {personId, reason}[] }}
 */
function answerCandidates(id, accept, reject, unreject = []) {
  const db = database.get();
  requirePerson(id);
  const skipped = [];
  const usable = (pid, forMerge) => {
    const r = personRow(pid);
    if (!r) { skipped.push({ personId: pid, reason: 'gone' }); return false; }
    if (!forMerge) return true;
    if (r.name != null) { skipped.push({ personId: pid, reason: 'named' }); return false; }
    if (r.hidden) { skipped.push({ personId: pid, reason: 'hidden' }); return false; }
    if (db.prepare("SELECT 1 FROM face_pair_decisions WHERE a = ? AND b = ? AND decision = 'different'").get(Math.min(id, pid), Math.max(id, pid))) {
      skipped.push({ personId: pid, reason: 'different' });
      return false;
    }
    return true;
  };
  const merged = accept.filter(pid => usable(pid, true));
  const rejected = reject.filter(pid => usable(pid, false));
  const unrejected = [];
  const stamp = nowIso();
  db.transaction(() => {
    for (const pid of unreject) {
      const n = db.prepare("DELETE FROM face_pair_decisions WHERE a = ? AND b = ? AND decision = 'different'")
        .run(Math.min(id, pid), Math.max(id, pid)).changes;
      if (n) unrejected.push(pid);
    }
    if (merged.length) mergeInto(db, id, merged);
    for (const pid of rejected) {
      const lo = Math.min(id, pid), hi = Math.max(id, pid);
      db.prepare(`INSERT INTO face_pair_decisions (a, b, decision, created_at) VALUES (?, ?, 'different', ?)
        ON CONFLICT(a, b) DO UPDATE SET decision = excluded.decision`).run(lo, hi, stamp);
      db.prepare('DELETE FROM face_person_suggestions WHERE a = ? AND b = ?').run(lo, hi);
    }
  })();
  if (merged.length || rejected.length || unrejected.length) store.bumpPeople({ membership: merged.length > 0 });
  coverCache.delete(id);
  return { person: get(id), merged, rejected, unrejected, skipped };
}

/* ── Review ("Same person?") ───────────────────────────────────────────── */

function sampleMedia(id, n = 3) {
  return database.get().prepare(`SELECT g.media_id AS m, MAX(COALESCE(g.det_score, 0)) AS d
    FROM face_groups g JOIN media m ON m.id = g.media_id
    WHERE g.cluster_id = ? AND ${VISIBLE} GROUP BY g.media_id ORDER BY d DESC, g.media_id LIMIT ?`).all(id, n).map(r => r.m);
}

/** Valid suggestion rows: both people exist, have faces, are not hidden, no decision. Named-vs-unnamed first. */
function validPairs() {
  const stats = statsMap();
  const rows = database.get().prepare(`SELECT s.a, s.b, s.score, pa.name AS an, pb.name AS bn
    FROM face_person_suggestions s
    JOIN face_people pa ON pa.id = s.a AND pa.hidden = 0
    JOIN face_people pb ON pb.id = s.b AND pb.hidden = 0
    WHERE NOT EXISTS (SELECT 1 FROM face_pair_decisions d WHERE d.a = s.a AND d.b = s.b)`).all();
  const out = rows.filter(r => stats.has(r.a) && stats.has(r.b) && !(r.an != null && r.bn != null));
  const mixed = (r) => ((r.an != null) !== (r.bn != null) ? 1 : 0);
  out.sort((x, y) => (mixed(y) - mixed(x)) || (y.score - x.score) || (x.a - y.a) || (x.b - y.b));
  return out;
}

/** GET /api/faces/review */
function review(limit = 20) {
  const pairs = validPairs();
  return {
    total: pairs.length,
    pairs: pairs.slice(0, limit).map(p => ({
      a: item(personRow(p.a)), b: item(personRow(p.b)),
      sample: { a: sampleMedia(p.a), b: sampleMedia(p.b) },
    })),
  };
}

/**
 * POST /api/faces/review { a, b, answer }. 'same' merges into the named one,
 * else the one with more files (ties: the older person). 'different' is
 * remembered forever.
 * @returns {{ ok: true, person: object|null, merged: number[] }}
 */
function answer(a, b, ans) {
  if (a === b) throw httpError(400, 'BAD_REQUEST', 'a and b must be two different people');
  const ra = requirePerson(a), rb = requirePerson(b);
  const db = database.get();
  const lo = Math.min(a, b), hi = Math.max(a, b);
  if (ans === 'different') {
    db.transaction(() => {
      db.prepare(`INSERT INTO face_pair_decisions (a, b, decision, created_at) VALUES (?, ?, 'different', ?)
        ON CONFLICT(a, b) DO UPDATE SET decision = excluded.decision`).run(lo, hi, nowIso());
      db.prepare('DELETE FROM face_person_suggestions WHERE a = ? AND b = ?').run(lo, hi);
    })();
    store.bumpPeople({ membership: false });
    return { ok: true, person: null, merged: [] };
  }
  const stats = statsMap();
  const files = (id) => (stats.get(id) || EMPTY_STATS).files;
  let into;
  if ((ra.name != null) !== (rb.name != null)) into = ra.name != null ? a : b;
  else into = files(a) !== files(b) ? (files(a) > files(b) ? a : b) : lo;
  const { person, merged } = merge([a, b], into);
  return { ok: true, person, merged };
}

module.exports = {
  FILTERS, SORTS, KINDS, httpError,
  list, total, get, files, faces, update, merge, notInGroups, detachForNotIn, restore, review, answer, requirePerson,
  add, create, answerCandidates, cleanName,
  statsMap, coverGroupId, cropUrlOf, resetCaches, personRow, setSpacingSource, VISIBLE, EMPTY_STATS,
};
