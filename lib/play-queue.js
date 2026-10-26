/**
 * Up next (PLAYLISTS_SPEC, build step 4): the order of the saved play queue.
 *
 * Pure functions, no database: given Up next as it is now (media ids, first
 * to play first) work out the new order. lib/database.js reads the current
 * order, calls these and writes positions 0..n-1 back in one transaction.
 * A file is in Up next at most once.
 *
 * Request shapes (POST /api/queue/...):
 *   add      { ids: [...], where: 'next' | 'end', source? }
 *            ids already queued move to the new place; the given order is kept
 *   move     { move: [ids], before: id | null }   same as a collection reorder
 *   remove   { ids: [...] }                       ids not queued are ignored
 *   replace  { ids: [...] }                       the exact list (Undo)
 *
 * Errors carry a `code`, so the route can answer 400 with it.
 */

const collectionOrder = require('./collection-order');

const MAX_IDS = 10000;
const MAX_SOURCE = 64;

function queueErr(message, code) {
  return Object.assign(new Error(message), { code });
}

const isId = (v) => Number.isInteger(v) && v > 0;

/**
 * A list of media ids, strictly: an array of positive integers (no strings,
 * no fractions), at most MAX_IDS. Repeats count once, first place kept.
 * `allowEmpty` for replace (Undo back to an empty Up next).
 */
function parseIds(v, { allowEmpty = false } = {}) {
  if (!Array.isArray(v) || !v.every(isId)) throw queueErr('ids must be a list of media ids', 'BAD_IDS');
  if (!allowEmpty && v.length === 0) throw queueErr('ids must name at least one file', 'BAD_IDS');
  if (v.length > MAX_IDS) throw queueErr(`at most ${MAX_IDS} files at once`, 'TOO_MANY');
  return [...new Set(v)];
}

/** 'next' (to the front) or 'end'. */
function parseWhere(v) {
  if (v !== 'next' && v !== 'end') throw queueErr("where must be 'next' or 'end'", 'BAD_WHERE');
  return v;
}

/** Where the files came from (a short label), or null. */
function parseSource(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > MAX_SOURCE) throw queueErr(`source must be text of at most ${MAX_SOURCE} characters`, 'BAD_SOURCE');
  return v;
}

/**
 * Add `ids` at the front ('next') or the back ('end'). An id that is already
 * queued leaves its old place and takes the new one, so a file is never in
 * Up next twice. The ids keep the order they were given in.
 */
function planAdd(current, ids, where) {
  const adding = parseIds(ids);
  parseWhere(where);
  const set = new Set(adding);
  const rest = current.filter(id => !set.has(id));
  return where === 'next' ? [...adding, ...rest] : [...rest, ...adding];
}

/** Take `ids` out. Ids that are not queued are ignored. */
function planRemove(current, ids) {
  const set = new Set(parseIds(ids));
  return current.filter(id => !set.has(id));
}

/**
 * Move a block to sit before `before` (null: the end), as a collection
 * reorder does. Every id must be queued.
 */
function planMove(current, move, before) {
  if (before === undefined) throw queueErr('before is required (a media id, or null for the end)', 'BAD_BEFORE');
  try {
    return collectionOrder.planMove(current, move, before);
  } catch (err) {
    // The planner speaks of collections; here it is Up next.
    if (err && err.code) throw queueErr(String(err.message).replace('this collection', 'Up next'), err.code);
    throw err;
  }
}

/** The exact list (Undo): any ids, each once. Empty clears. */
function planReplace(ids) {
  if (!Array.isArray(ids)) throw queueErr('ids must be a list of media ids', 'BAD_IDS');
  const list = parseIds(ids, { allowEmpty: true });
  if (list.length !== ids.length) throw queueErr('ids must name each file once', 'BAD_IDS');
  return list;
}

module.exports = {
  MAX_IDS, parseIds, parseWhere, parseSource, planAdd, planRemove, planMove, planReplace,
};
