/**
 * Stream tags: the user's own labels for files in a stream set, grouped into
 * lanes (a lane is a set of tags about one thing: Role, Mood, Moments).
 *
 *   stream_lanes(id, name, multi, sort, created_at)
 *     multi 1: Several per file (tags add up); 0: One per file (tagging in
 *     the lane replaces the file's tag there).
 *   stream_tags(id, lane_id, name, color, hotkey, place, sort)
 *     color '#rrggbb'; hotkey one printable key (stored upper case, unique
 *     across every tag, case-insensitive) or NULL; place: where Flow order
 *     puts a file with this tag (first | last | peak | after_peak | low |
 *     anywhere, player-lib/flow-order.js).
 *   media_stream_tags(media_id, tag_id) PK (media_id, tag_id)
 *
 * Tags live on the file, the same in every collection. They are kept apart
 * from the library's own tags (the JSON columns on media and media_clean):
 * nothing here writes those, and search never reads these. The library
 * query can still filter by one (lib/library-query.js filters.streamTag).
 *
 * In the main library database, like collections: an encrypted library keeps
 * them encrypted, a lock closes them with everything else, and a deleted
 * record takes its rows with it (database.deleteRecords -> cleanupForMedia).
 * Deleting a tag or a lane takes its assignments with it.
 *
 * Seeded once, when the tables are first made: the Role lane with Local
 * Player's five tags. Deleted, they stay deleted.
 *
 * Writes bump the library version (library_meta), so a filtered result and
 * the grid's cache notice a change, as they do for collections.
 */

const PLACES = ['first', 'last', 'peak', 'after_peak', 'low', 'anywhere'];
const NAME_MAX = 40;
const MAX_IDS = 200000;
// Keys the library already answers to wherever a tile can be hovered:
// ? opens the shortcuts list, U adds to Up next.
const RESERVED_KEYS = ['?', 'U'];

const SEED = [
  { name: 'Opener', hotkey: 'O', place: 'first', color: '#4ade80' },
  { name: 'Centerpiece', hotkey: 'C', place: 'peak', color: '#f59e0b' },
  { name: 'Palate cleanser', hotkey: 'L', place: 'low', color: '#22d3ee' },
  { name: 'Intermission', hotkey: 'I', place: 'after_peak', color: '#a78bfa' },
  { name: 'Closer', hotkey: 'X', place: 'last', color: '#f472b6' },
];

const BUMP = "UPDATE library_meta SET value = value + 1 WHERE key = 'version';";

function ensureSchema(db) {
  const had = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stream_lanes'").get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS stream_lanes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      multi      INTEGER NOT NULL DEFAULT 1,
      sort       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stream_tags (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      lane_id INTEGER NOT NULL,
      name    TEXT NOT NULL,
      color   TEXT NOT NULL,
      hotkey  TEXT,
      place   TEXT NOT NULL DEFAULT 'anywhere',
      sort    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_stream_tags_lane ON stream_tags(lane_id);
    CREATE TABLE IF NOT EXISTS media_stream_tags (
      media_id INTEGER NOT NULL,
      tag_id   INTEGER NOT NULL,
      PRIMARY KEY (media_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_media_stream_tags_tag ON media_stream_tags(tag_id);
  `);
  // The library version (lib/library-index.js): a filter by stream tag, and
  // the grid's cached pages, see assignments change.
  const hasMeta = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'library_meta'").get();
  if (hasMeta) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS media_stream_tags_version_ai AFTER INSERT ON media_stream_tags BEGIN ${BUMP} END;
      CREATE TRIGGER IF NOT EXISTS media_stream_tags_version_ad AFTER DELETE ON media_stream_tags BEGIN ${BUMP} END;
    `);
  }
  if (!had) seed(db);
}

function seed(db) {
  db.transaction(() => {
    const lane = Number(db.prepare('INSERT INTO stream_lanes (name, multi, sort) VALUES (?, 1, 0)').run('Role').lastInsertRowid);
    const ins = db.prepare('INSERT INTO stream_tags (lane_id, name, color, hotkey, place, sort) VALUES (?, ?, ?, ?, ?, ?)');
    SEED.forEach((t, i) => ins.run(lane, t.name, t.color, t.hotkey, t.place, i));
  })();
}

/* ── Validation ─────────────────────────────────────────────────────── */

function bad(message, code = 'BAD_REQUEST', status = 400) {
  return Object.assign(new Error(message), { status, code });
}

const isId = (v) => Number.isInteger(v) && v > 0 && v <= 0xFFFFFFFF;

// Bidi overrides, embeddings, isolates and marks: they can make a name read
// as something else, so they are taken out of every name.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g;
// What shows nothing on its own: spaces, format characters (zero-width and
// the like), combining marks with nothing to sit on, and the Hangul fillers.
const INVISIBLE = /[\s\p{Z}\p{Cf}\p{M}ᅟᅠㅤﾠ]/gu;

function cleanName(v, what) {
  if (typeof v !== 'string') throw bad(`${what} needs a name`);
  const s = v.normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(BIDI, '')
    .replace(/\s+/g, ' ').trim();
  if (!s || !s.replace(INVISIBLE, '')) throw bad(`${what} needs a name you can see`);
  if ([...s].length > NAME_MAX) throw bad(`A ${what.toLowerCase()} name can be ${NAME_MAX} characters at most`);
  return s;
}

/** How names are compared for "already taken": the same letters in any case, any composition. */
const nameKey = (s) => String(s).normalize('NFC').toLowerCase().normalize('NFC');

function cleanColor(v) {
  if (typeof v !== 'string') throw bad('color must be like #4ade80');
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  throw bad('color must be like #4ade80');
}

/** One printable key, upper case, or null. */
function cleanHotkey(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw bad('hotkey must be one key');
  const chars = [...v.normalize('NFC')];
  if (chars.length !== 1) throw bad('hotkey must be one key');
  const c = chars[0];
  // Printable: no space, no control, format or other invisible characters,
  // and no combining mark on its own.
  // (U+FFFD: what a key that did not arrive as UTF-8 turns into.)
  if (/[\s\p{C}\p{M}\p{Z}�]/u.test(c)) throw bad('hotkey must be a key you can see, like C or 2');
  const k = c.toUpperCase();
  // Still one key in either case (ß is SS upper case, ﬁ is FI): the page
  // matches a key in any case, so both must be single keys.
  if ([...k].length !== 1 || [...c.toLowerCase()].length !== 1 || [...k.toLowerCase()].length !== 1) {
    throw bad('hotkey must be one key in both upper and lower case. Pick another key.');
  }
  if (RESERVED_KEYS.includes(k)) throw bad(`${k} is already a library shortcut. Pick another key.`, 'HOTKEY_RESERVED');
  return k;
}

function cleanPlace(v) {
  if (v === undefined || v === null) return 'anywhere';
  if (!PLACES.includes(v)) throw bad(`place must be one of ${PLACES.join(', ')}`);
  return v;
}

function cleanIds(v, what = 'mediaIds') {
  if (!Array.isArray(v)) throw bad(`${what} must be a list of ids`);
  if (v.length > MAX_IDS) throw bad(`${what} has more than ${MAX_IDS.toLocaleString('en-US')} ids`);
  if (!v.every(isId)) throw bad(`${what} must be a list of ids`);
  return [...new Set(v)];
}

/* ── Reading ────────────────────────────────────────────────────────── */

const tagOut = (t, count = 0) => ({
  id: t.id, laneId: t.lane_id, name: t.name, color: t.color, hotkey: t.hotkey || null, place: t.place, sort: t.sort, count,
});
const laneOut = (l) => ({ id: l.id, name: l.name, multi: !!l.multi, sort: l.sort });

/**
 * Every lane in order with its tags in order. Each tag says how many files
 * it is on; each lane how many files carry it (files) and how many carry
 * more than one of its tags (several: what switching to One per file trims).
 */
function list(db) {
  const counts = new Map(db.prepare('SELECT tag_id, COUNT(*) AS n FROM media_stream_tags GROUP BY tag_id').all().map(r => [r.tag_id, r.n]));
  const laneStats = new Map(db.prepare(`SELECT lane_id, COUNT(*) AS files, SUM(n > 1) AS several FROM (
      SELECT t.lane_id, mst.media_id, COUNT(*) AS n FROM media_stream_tags mst JOIN stream_tags t ON t.id = mst.tag_id
      GROUP BY t.lane_id, mst.media_id) GROUP BY lane_id`).all().map(r => [r.lane_id, r]));
  const tags = db.prepare('SELECT * FROM stream_tags ORDER BY sort, id').all();
  return db.prepare('SELECT * FROM stream_lanes ORDER BY sort, id').all().map((l) => {
    const s = laneStats.get(l.id);
    return {
      ...laneOut(l),
      files: s ? s.files : 0,
      several: s ? s.several || 0 : 0,
      tags: tags.filter(t => t.lane_id === l.id).map(t => tagOut(t, counts.get(t.id) || 0)),
    };
  });
}

function laneRow(db, id) {
  const l = db.prepare('SELECT * FROM stream_lanes WHERE id = ?').get(id);
  if (!l) throw bad('No such lane.', 'NOT_FOUND', 404);
  return l;
}
function tagRow(db, id) {
  const t = db.prepare('SELECT * FROM stream_tags WHERE id = ?').get(id);
  if (!t) throw bad('No such stream tag.', 'NOT_FOUND', 404);
  return t;
}

/** { mediaId: [tagId, ...] } for these files (files with none are left out). */
function forMedia(db, ids) {
  const wanted = cleanIds(ids);
  const out = {};
  for (let i = 0; i < wanted.length; i += 5000) {
    const rows = db.prepare(`SELECT mst.media_id AS m, mst.tag_id AS t FROM media_stream_tags mst
      JOIN stream_tags st ON st.id = mst.tag_id JOIN stream_lanes sl ON sl.id = st.lane_id
      WHERE mst.media_id IN (SELECT value FROM json_each(?)) ORDER BY mst.media_id, sl.sort, sl.id, st.sort, st.id`)
      .all(JSON.stringify(wanted.slice(i, i + 5000)));
    for (const r of rows) (out[r.m] || (out[r.m] = [])).push(r.t);
  }
  return out;
}

/** The same for a collection's files. */
function forCollection(db, cid) {
  if (!db.prepare('SELECT 1 FROM collections WHERE id = ?').get(cid)) throw bad('No such collection.', 'NOT_FOUND', 404);
  const out = {};
  const rows = db.prepare(`SELECT mst.media_id AS m, mst.tag_id AS t FROM collection_items ci
    JOIN media_stream_tags mst ON mst.media_id = ci.media_id
    JOIN stream_tags st ON st.id = mst.tag_id JOIN stream_lanes sl ON sl.id = st.lane_id
    WHERE ci.collection_id = ? ORDER BY mst.media_id, sl.sort, sl.id, st.sort, st.id`).all(cid);
  for (const r of rows) (out[r.m] || (out[r.m] = [])).push(r.t);
  return out;
}

/** Every assignment, compact: [[mediaId, tagId], ...] (the page's cache). */
function allAssignments(db) {
  return db.prepare('SELECT media_id, tag_id FROM media_stream_tags ORDER BY media_id, tag_id').raw().all();
}

/**
 * The place each file gets from its tags (Flow order), for these files:
 * Map(mediaId -> place). Precedence First > Last > At a peak > After a peak
 * > At a low point; Anywhere and no tag: left out.
 */
const PLACE_RANK = { first: 0, last: 1, peak: 2, after_peak: 3, low: 4 };
function placesFor(db, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 5000) {
    const rows = db.prepare(`SELECT mst.media_id AS m, st.place AS p FROM media_stream_tags mst JOIN stream_tags st ON st.id = mst.tag_id
      WHERE st.place != 'anywhere' AND mst.media_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids.slice(i, i + 5000)));
    for (const r of rows) {
      if (!(r.p in PLACE_RANK)) continue;
      const cur = out.get(r.m);
      if (cur === undefined || PLACE_RANK[r.p] < PLACE_RANK[cur]) out.set(r.m, r.p);
    }
  }
  return out;
}

/* ── Lanes ──────────────────────────────────────────────────────────── */

function assertLaneNameFree(db, name, exceptId = null) {
  // Compared here, not with SQLite's lower(), which only folds A to Z.
  const k = nameKey(name);
  const hit = db.prepare('SELECT id, name FROM stream_lanes WHERE id IS NOT ?').all(exceptId).find(l => nameKey(l.name) === k);
  if (hit) throw bad(`There is already a lane called ${name}.`, 'NAME_TAKEN', 409);
}

function createLane(db, body = {}) {
  const name = cleanName(body.name, 'Lane');
  assertLaneNameFree(db, name);
  const multi = body.multi === undefined ? true : body.multi;
  if (typeof multi !== 'boolean') throw bad('multi must be true or false');
  const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM stream_lanes').get().s;
  const id = Number(db.prepare('INSERT INTO stream_lanes (name, multi, sort) VALUES (?, ?, ?)').run(name, multi ? 1 : 0, sort).lastInsertRowid);
  return laneOut(laneRow(db, id));
}

/**
 * Rename, or switch One per file / Several per file. Switching to One per
 * file keeps each file's first tag in the lane (in the lane's order) and
 * takes the rest off: trimmed says how many tags came off.
 */
function updateLane(db, id, body = {}) {
  laneRow(db, id);
  let trimmed = 0;
  db.transaction(() => {
    if (body.name !== undefined) {
      const name = cleanName(body.name, 'Lane');
      assertLaneNameFree(db, name, id);
      db.prepare('UPDATE stream_lanes SET name = ? WHERE id = ?').run(name, id);
    }
    if (body.multi !== undefined) {
      if (typeof body.multi !== 'boolean') throw bad('multi must be true or false');
      db.prepare('UPDATE stream_lanes SET multi = ? WHERE id = ?').run(body.multi ? 1 : 0, id);
      if (!body.multi) {
        // Each file keeps the first of its tags here (lane order, then id).
        trimmed = db.prepare(`DELETE FROM media_stream_tags WHERE rowid IN (
            SELECT mst.rowid FROM media_stream_tags mst JOIN stream_tags t ON t.id = mst.tag_id
            WHERE t.lane_id = @lane AND EXISTS (
              SELECT 1 FROM media_stream_tags m2 JOIN stream_tags t2 ON t2.id = m2.tag_id
              WHERE m2.media_id = mst.media_id AND t2.lane_id = @lane
                AND (t2.sort < t.sort OR (t2.sort = t.sort AND t2.id < t.id))))`).run({ lane: id }).changes;
      }
    }
  })();
  return { ...laneOut(laneRow(db, id)), trimmed };
}

/** Delete a lane, its tags and their assignments. files: how many files lost a tag. */
function deleteLane(db, id) {
  laneRow(db, id);
  let files = 0;
  db.transaction(() => {
    files = db.prepare(`SELECT COUNT(DISTINCT mst.media_id) AS n FROM media_stream_tags mst JOIN stream_tags t ON t.id = mst.tag_id WHERE t.lane_id = ?`).get(id).n;
    db.prepare('DELETE FROM media_stream_tags WHERE tag_id IN (SELECT id FROM stream_tags WHERE lane_id = ?)').run(id);
    db.prepare('DELETE FROM stream_tags WHERE lane_id = ?').run(id);
    db.prepare('DELETE FROM stream_lanes WHERE id = ?').run(id);
  })();
  return { deleted: true, files };
}

/** Put lanes in this order (every lane id once; ids left out keep their place after). */
function reorder(db, table, ids, where = '', whereArgs = []) {
  const want = cleanIds(ids, 'ids');
  const have = db.prepare(`SELECT id FROM ${table} ${where} ORDER BY sort, id`).all(...whereArgs).map(r => r.id);
  const set = new Set(have);
  if (!want.every(id => set.has(id))) throw bad('ids must be ids from this list');
  const rest = have.filter(id => !want.includes(id));
  const upd = db.prepare(`UPDATE ${table} SET sort = ? WHERE id = ?`);
  db.transaction(() => { [...want, ...rest].forEach((id, i) => upd.run(i, id)); })();
}

function reorderLanes(db, ids) {
  reorder(db, 'stream_lanes', ids);
  return list(db);
}

/* ── Tags ───────────────────────────────────────────────────────────── */

function assertTagNameFree(db, laneId, name, exceptId = null) {
  const k = nameKey(name);
  const hit = db.prepare('SELECT id, name FROM stream_tags WHERE lane_id = ? AND id IS NOT ?').all(laneId, exceptId).find(t => nameKey(t.name) === k);
  if (hit) throw bad(`This lane already has a tag called ${name}.`, 'NAME_TAKEN', 409);
}

function assertHotkeyFree(db, key, exceptId = null) {
  if (key == null) return;
  const k = nameKey(key);
  const hit = db.prepare('SELECT t.name, t.hotkey, l.name AS lane FROM stream_tags t JOIN stream_lanes l ON l.id = t.lane_id WHERE t.hotkey IS NOT NULL AND t.id IS NOT ?')
    .all(exceptId).find(t => nameKey(t.hotkey) === k);
  if (hit) throw bad(`${key} is already the key for ${hit.name} (${hit.lane}).`, 'HOTKEY_TAKEN', 409);
}

function createTag(db, body = {}) {
  if (!isId(body.laneId)) throw bad('laneId must be a lane id');
  laneRow(db, body.laneId);
  const name = cleanName(body.name, 'Tag');
  const color = cleanColor(body.color);
  const hotkey = cleanHotkey(body.hotkey);
  const place = cleanPlace(body.place);
  assertTagNameFree(db, body.laneId, name);
  assertHotkeyFree(db, hotkey);
  const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM stream_tags WHERE lane_id = ?').get(body.laneId).s;
  const id = Number(db.prepare('INSERT INTO stream_tags (lane_id, name, color, hotkey, place, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(body.laneId, name, color, hotkey, place, sort).lastInsertRowid);
  return tagOut(tagRow(db, id));
}

function updateTag(db, id, body = {}) {
  const t = tagRow(db, id);
  const set = {};
  if (body.name !== undefined) { set.name = cleanName(body.name, 'Tag'); assertTagNameFree(db, t.lane_id, set.name, id); }
  if (body.color !== undefined) set.color = cleanColor(body.color);
  if (body.hotkey !== undefined) { set.hotkey = cleanHotkey(body.hotkey); assertHotkeyFree(db, set.hotkey, id); }
  if (body.place !== undefined) set.place = cleanPlace(body.place);
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE stream_tags SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...set, id });
  const n = db.prepare('SELECT COUNT(*) AS n FROM media_stream_tags WHERE tag_id = ?').get(id).n;
  return tagOut(tagRow(db, id), n);
}

function deleteTag(db, id) {
  tagRow(db, id);
  let files = 0;
  db.transaction(() => {
    files = db.prepare('DELETE FROM media_stream_tags WHERE tag_id = ?').run(id).changes;
    db.prepare('DELETE FROM stream_tags WHERE id = ?').run(id);
  })();
  return { deleted: true, files };
}

function reorderTags(db, laneId, ids) {
  laneRow(db, laneId);
  reorder(db, 'stream_tags', ids, 'WHERE lane_id = ?', [laneId]);
  return list(db).find(l => l.id === laneId);
}

/* ── Tagging files ──────────────────────────────────────────────────── */

/**
 * Put a tag on files, take it off, or toggle it (on all of them unless every
 * one already has it, then off all: like Flag). In a One per file lane,
 * putting a tag on takes the lane's other tags off those files. Ids that are
 * not in the library are skipped.
 * @returns {{ op: 'add'|'remove', changed: number, assignments: object }}
 */
function assign(db, body = {}) {
  if (!isId(body.tagId)) throw bad('tagId must be a stream tag id');
  const t = tagRow(db, body.tagId);
  const lane = laneRow(db, t.lane_id);
  const ids = cleanIds(body.mediaIds);
  let op = body.op === undefined ? 'toggle' : body.op;
  if (!['add', 'remove', 'toggle'].includes(op)) throw bad('op must be add, remove or toggle');
  let changed = 0;
  db.transaction(() => {
    const json = JSON.stringify(ids);
    const live = db.prepare('SELECT id FROM media WHERE id IN (SELECT value FROM json_each(?))').all(json).map(r => r.id);
    const liveJson = JSON.stringify(live);
    if (op === 'toggle') {
      const have = db.prepare('SELECT COUNT(*) AS n FROM media_stream_tags WHERE tag_id = ? AND media_id IN (SELECT value FROM json_each(?))').get(t.id, liveJson).n;
      op = live.length && have === live.length ? 'remove' : 'add';
    }
    if (op === 'remove') {
      changed = db.prepare('DELETE FROM media_stream_tags WHERE tag_id = ? AND media_id IN (SELECT value FROM json_each(?))').run(t.id, liveJson).changes;
      return;
    }
    if (!lane.multi) {
      db.prepare(`DELETE FROM media_stream_tags WHERE tag_id IN (SELECT id FROM stream_tags WHERE lane_id = ? AND id != ?)
        AND media_id IN (SELECT value FROM json_each(?))`).run(lane.id, t.id, liveJson);
    }
    changed = db.prepare('INSERT OR IGNORE INTO media_stream_tags (media_id, tag_id) SELECT value, ? FROM json_each(?)').run(t.id, liveJson).changes;
  })();
  return { op, changed, assignments: forMedia(db, ids) };
}

/** Take every stream tag (or one lane's) off these files. */
function clear(db, body = {}) {
  const ids = cleanIds(body.mediaIds);
  let removed = 0;
  if (body.laneId !== undefined && body.laneId !== null) {
    if (!isId(body.laneId)) throw bad('laneId must be a lane id');
    laneRow(db, body.laneId);
    removed = db.prepare(`DELETE FROM media_stream_tags WHERE tag_id IN (SELECT id FROM stream_tags WHERE lane_id = ?)
      AND media_id IN (SELECT value FROM json_each(?))`).run(body.laneId, JSON.stringify(ids)).changes;
  } else {
    removed = db.prepare('DELETE FROM media_stream_tags WHERE media_id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids)).changes;
  }
  return { removed, assignments: forMedia(db, ids) };
}

/** database.deleteRecords: a record that leaves the library takes its tags. */
function cleanupForMedia(db, mediaId) {
  try { db.prepare('DELETE FROM media_stream_tags WHERE media_id = ?').run(mediaId); } catch { /* no table yet */ }
}

module.exports = {
  PLACES, PLACE_RANK, NAME_MAX, RESERVED_KEYS, SEED, MAX_IDS,
  ensureSchema, list, forMedia, forCollection, allAssignments, placesFor,
  createLane, updateLane, deleteLane, reorderLanes,
  createTag, updateTag, deleteTag, reorderTags,
  assign, clear, cleanupForMedia,
  cleanName, cleanColor, cleanHotkey, cleanPlace, nameKey,
};
