/**
 * "Might also be <person>" (FACES_FEEDBACK_SPEC E4): other unnamed people
 * that may be this person, one entry per person (its face closest to this
 * person), ranked by a scoring rule.
 *
 * The rule is ONE swappable object (setRule). A rule gets this person, one
 * candidate and every other NAMED person, each as { groups: [{ id, model,
 * vec (group mean) }], centroids: Map<model, vec> }, and answers { score,
 * groupId, margin } (groupId = the candidate face shown) or null;
 * tier(result, thresholds) answers 'likely', 'maybe' or null (not listed).
 *
 * Default (quality experiment 2, E7): person centroid vs person centroid,
 * listed only with a margin >= mightMargin (0.05) over the candidate's best
 * OTHER named person. likely = score >= mightLikely (0.56); maybe = score >=
 * mightMaybe (0.52); below that, not listed. The face shown is the
 * candidate's face closest to this person's centroid.
 *
 * Excluded: named people, hidden people, people with a 'different' answer
 * for this person, and people a "not this person" reject ties to this one
 * (a face of either that was taken out of the other). Hidden faces, trashed
 * files and faces of an older model never count.
 *
 * The ranking is cached for the last few people until any face or people
 * data changes (store.version / peopleVersion / peopleUserVersion) or a file
 * is trashed or restored (trashSignature: no counter moves on a trash), so
 * paging through the list does not rescore the library.
 */

const database = require('../database');
const store = require('./store');
const people = require('./people');
const { peopleThresholds } = require('./thresholds');

const CACHE_MAX = 4;

// Vectors of one model share a length (SFace 128, AdaFace 512); only vectors
// of the same model are ever compared (centroids are per model).
function meanOf(vecs) {
  const dim = vecs.length ? vecs[0].length : 0;
  const out = new Float32Array(dim);
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i];
  return store.normalize(out);
}
function dot(a, b) {
  if (a.length !== b.length) throw new Error(`face vectors of different lengths (${a.length} vs ${b.length}): two models mixed`);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Normalised mean of group vectors, per model. */
function centroidsOf(groups) {
  const by = new Map();
  for (const g of groups) {
    if (!by.has(g.model)) by.set(g.model, []);
    by.get(g.model).push(g.vec);
  }
  return new Map([...by].map(([m, vecs]) => [m, meanOf(vecs)]));
}

/** Best centroid-centroid cosine over the models both people have (-2 = none). */
function centroidScore(a, b) {
  let s = -2;
  for (const [m, c] of a.centroids) {
    const o = b.centroids.get(m);
    if (o) s = Math.max(s, dot(c, o));
  }
  return s;
}

const CENTROID_RULE = Object.freeze({
  id: 'person-centroid-margin',
  /**
   * @param target  this person
   * @param cand    one unnamed candidate
   * @param named   every named person except this one
   * @returns {{ score, groupId, margin } | null}
   */
  score(target, cand, named) {
    const score = centroidScore(cand, target);
    if (score <= -2) return null;
    let second = -2;
    for (const p of named) second = Math.max(second, centroidScore(cand, p));
    let groupId = null, gs = -Infinity;
    for (const g of cand.groups) {
      const c = target.centroids.get(g.model);
      if (!c) continue;
      const s = dot(g.vec, c);
      if (s > gs || (s === gs && g.id < groupId)) { gs = s; groupId = g.id; }
    }
    return groupId == null ? null : { score, groupId, margin: score - second };
  },
  /** @param {{ score, margin }} r  @param th peopleThresholds() */
  tier(r, th) {
    if (r.margin < th.mightMargin) return null;
    if (r.score >= th.mightLikely) return 'likely';
    if (r.score >= th.mightMaybe) return 'maybe';
    return null;
  },
});

let rule = CENTROID_RULE;
let ruleGen = 0;
const cache = new Map();   // personId -> { key, ranked }

/** Swap the scoring rule (null = the default). Drops the cached rankings. */
function setRule(next) {
  rule = next || CENTROID_RULE;
  ruleGen++;
  cache.clear();
}

function reset() { cache.clear(); }

/** Visible groups (with their group-mean vectors) matching a WHERE fragment. */
function loadGroups(db, where, params) {
  const out = new Map();   // group id -> { id, pid, mediaId, model, vecs: [] }
  for (const r of db.prepare(`SELECT g.id, g.cluster_id AS pid, g.media_id, g.model, v.embedding
    FROM face_groups g JOIN media m ON m.id = g.media_id JOIN face_vectors v ON v.group_id = g.id
    WHERE ${people.VISIBLE} AND ${where} ORDER BY g.id, v.id`).iterate(...params)) {
    let g = out.get(r.id);
    if (!g) { g = { id: r.id, pid: r.pid, mediaId: r.media_id, model: r.model, vecs: [] }; out.set(r.id, g); }
    g.vecs.push(store.decodeEmbedding(r.embedding));
  }
  return [...out.values()].map(g => ({ id: g.id, pid: g.pid, mediaId: g.mediaId, model: g.model, vec: meanOf(g.vecs) }));
}

/** People never offered for `pid`: 'different' answers and rejects either way. */
function blockedFor(db, pid) {
  const out = new Set([pid]);
  for (const r of db.prepare('SELECT a, b FROM face_pair_decisions WHERE a = ? OR b = ?').all(pid, pid)) out.add(r.a === pid ? r.b : r.a);
  for (const r of db.prepare(`SELECT r.person_id AS p FROM face_person_rejects r JOIN face_groups g ON g.id = r.group_id
    WHERE g.cluster_id = ?`).all(pid)) out.add(r.p);
  for (const r of db.prepare(`SELECT DISTINCT g.cluster_id AS p FROM face_person_rejects r JOIN face_groups g ON g.id = r.group_id
    WHERE r.person_id = ? AND g.cluster_id IS NOT NULL`).all(pid)) out.add(r.p);
  return out;
}

/** Which files are in the trash, as a cheap fingerprint (idx_media_trashed). */
function trashSignature(db) {
  const r = db.prepare('SELECT COUNT(*) AS n, TOTAL(id) AS s, TOTAL(id * id) AS s2 FROM media INDEXED BY idx_media_trashed WHERE user_trashed = 1').get();
  return `${r.n}:${r.s}:${r.s2}`;
}

/** Ranked [{ personId, groupId, mediaId, score, tier }] for person `pid` (cached). */
function ranked(pid) {
  const db = database.get();
  const key = `${store.version()}/${store.peopleVersion()}/${store.peopleUserVersion()}/${ruleGen}/${trashSignature(db)}`;
  const hit = cache.get(pid);
  if (hit && hit.key === key) return hit.ranked;
  const own = loadGroups(db, 'g.cluster_id = ?', [pid]);
  const byModel = new Map();
  for (const g of own) {
    if (!byModel.has(g.model)) byModel.set(g.model, []);
    byModel.get(g.model).push(g.vec);
  }
  const target = { personId: pid, groups: own, centroids: new Map([...byModel].map(([m, vecs]) => [m, meanOf(vecs)])) };
  const out = [];
  if (own.length) {
    const namedGroups = new Map();
    for (const g of loadGroups(db, 'g.cluster_id IN (SELECT id FROM face_people WHERE name IS NOT NULL AND id != ?)', [pid])) {
      if (!namedGroups.has(g.pid)) namedGroups.set(g.pid, []);
      namedGroups.get(g.pid).push(g);
    }
    const named = [...namedGroups].map(([npid, groups]) => ({ personId: npid, groups, centroids: centroidsOf(groups) }));
    const blocked = blockedFor(db, pid);
    const cands = new Map();   // person id -> groups
    for (const g of loadGroups(db, `g.cluster_id IN (SELECT id FROM face_people WHERE name IS NULL AND hidden = 0 AND id != ?)`, [pid])) {
      if (blocked.has(g.pid)) continue;
      if (!cands.has(g.pid)) cands.set(g.pid, []);
      cands.get(g.pid).push(g);
    }
    // Faces the join re-check took out of this person (people-sort.js) are
    // always offered back, at least as a "maybe", until answered.
    const backOf = new Set(db.prepare(`SELECT DISTINCT cluster_id AS p FROM face_groups INDEXED BY idx_face_groups_recheck
      WHERE recheck_from = ? AND cluster_id IS NOT NULL AND hidden = 0`).all(pid).map(r => r.p));
    for (const [cpid, groups] of cands) {
      const s = rule.score(target, { personId: cpid, groups, centroids: centroidsOf(groups) }, named);
      if (!s) continue;
      const model = groups.find(g => g.id === s.groupId)?.model;
      const tier = rule.tier(s, peopleThresholds(model)) || (backOf.has(cpid) ? 'maybe' : null);
      if (!tier) continue;
      out.push({ personId: cpid, groupId: s.groupId, mediaId: groups.find(g => g.id === s.groupId)?.mediaId ?? null,
        score: Math.round(s.score * 10000) / 10000, tier });
    }
    out.sort((a, b) => (b.score - a.score) || (a.personId - b.personId));
  }
  cache.set(pid, { key, ranked: out });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return out;
}

/**
 * GET /api/faces/people/:id/candidates.
 * @returns {{ total, items: [{ personId, groupId, mediaId, filename, cropUrl, files, tier, score }] }}
 */
function list(pid, { limit = 24, offset = 0 } = {}) {
  people.requirePerson(pid);
  const all = ranked(pid);
  const page = all.slice(offset, offset + limit);
  const stats = people.statsMap();
  const info = database.get().prepare(`SELECT m.filename, m.media_type, g.best_time_s, g.first_time_s, g.best_bbox
    FROM face_groups g JOIN media m ON m.id = g.media_id WHERE g.id = ?`);
  const bboxOf = (t) => { try { const b = JSON.parse(t); return Array.isArray(b) && b.length === 4 ? b : null; } catch { return null; } };
  return {
    total: all.length,
    items: page.map(c => {
      const r = info.get(c.groupId) || {};
      const video = r.media_type === 'video';
      return {
        personId: c.personId,
        groupId: c.groupId,
        mediaId: c.mediaId,
        filename: r.filename ?? null,
        // For the card and the whole-frame view (round 4).
        mediaType: r.media_type ?? null,
        timeS: video ? (r.best_time_s ?? r.first_time_s ?? null) : null,
        bbox: bboxOf(r.best_bbox),
        cropUrl: people.cropUrlOf(c.groupId),
        files: (stats.get(c.personId) || people.EMPTY_STATS).files,
        tier: c.tier,
        score: c.score,
      };
    }),
  };
}

module.exports = { list, ranked, setRule, reset, CENTROID_RULE, ruleId: () => rule.id };
