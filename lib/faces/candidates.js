/**
 * "Might also be <person>" (FACES_FEEDBACK_SPEC E4): other unnamed people
 * that may be this person, one entry per person (its face closest to this
 * person), ranked by a scoring rule.
 *
 * The rule is ONE swappable object (setRule): the quality experiment (E7)
 * picks the joining rule and the tier bands, and only RULE changes. A rule
 * gets this person's face vectors and one candidate's, both as group means
 * per model, and answers { score, groupId } (groupId = the candidate face
 * shown) or null; tier(score, thresholds) answers 'likely', 'maybe' or null
 * (null = not listed).
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

const DIM = store.EMBED_DIM;
const CACHE_MAX = 4;

function meanOf(vecs) {
  const out = new Float32Array(DIM);
  for (const v of vecs) for (let i = 0; i < DIM; i++) out[i] += v[i];
  return store.normalize(out);
}
function dot(a, b) { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; }

/**
 * Default rule, the sorting job's joining rule: a candidate face's group mean
 * against this person's centroid (normalised mean of its group means, per
 * model). The candidate's score is its best face. likely >= the people
 * threshold (where sorting would have joined it), maybe >= the suggestion
 * threshold.
 */
const CENTROID_RULE = Object.freeze({
  id: 'centroid-best-face',
  /**
   * @param {{ groups: {id, model, vec}[], centroids: Map<string, Float32Array> }} target
   * @param {{ groups: {id, model, vec}[] }} cand
   * @returns {{ score: number, groupId: number } | null}
   */
  score(target, cand) {
    let best = null;
    for (const g of cand.groups) {
      const c = target.centroids.get(g.model);
      if (!c) continue;
      const s = dot(g.vec, c);
      if (!best || s > best.score || (s === best.score && g.id < best.groupId)) best = { score: s, groupId: g.id };
    }
    return best;
  },
  /** @param {{ people: number, suggest: number }} th */
  tier(score, th) {
    if (score >= th.people) return 'likely';
    if (score >= th.suggest) return 'maybe';
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
  const target = { groups: own, centroids: new Map([...byModel].map(([m, vecs]) => [m, meanOf(vecs)])) };
  const out = [];
  if (own.length) {
    const blocked = blockedFor(db, pid);
    const cands = new Map();   // person id -> groups
    for (const g of loadGroups(db, `g.cluster_id IN (SELECT id FROM face_people WHERE name IS NULL AND hidden = 0 AND id != ?)`, [pid])) {
      if (blocked.has(g.pid)) continue;
      if (!cands.has(g.pid)) cands.set(g.pid, []);
      cands.get(g.pid).push(g);
    }
    for (const [cpid, groups] of cands) {
      const s = rule.score(target, { personId: cpid, groups });
      if (!s) continue;
      const model = groups.find(g => g.id === s.groupId)?.model;
      const tier = rule.tier(s.score, peopleThresholds(model));
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
  const fname = database.get().prepare('SELECT filename FROM media WHERE id = ?');
  return {
    total: all.length,
    items: page.map(c => ({
      personId: c.personId,
      groupId: c.groupId,
      mediaId: c.mediaId,
      filename: c.mediaId == null ? null : (fname.get(c.mediaId)?.filename ?? null),
      cropUrl: people.cropUrlOf(c.groupId),
      files: (stats.get(c.personId) || people.EMPTY_STATS).files,
      tier: c.tier,
      score: c.score,
    })),
  };
}

module.exports = { list, ranked, setRule, reset, CENTROID_RULE, ruleId: () => rule.id };
