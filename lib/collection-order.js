/**
 * Playlist order for one collection (PLAYLISTS_SPEC, build step 1).
 *
 * Pure functions, no database: given the collection's current order (media
 * ids, first to last) work out the new one. lib/database.js reads the current
 * order, calls these, and writes positions 0..n-1 back in one transaction.
 *
 * Two request shapes:
 *   { move: [ids], before: id | null }   move a block; null = to the end
 *   { order: [ids] }                     the whole order (Undo), an exact
 *                                        permutation of the current members
 *
 * Errors carry a `code` (the Object.assign(new Error, {code}) convention the
 * other collection functions use), so the route can answer 400 with it.
 */

function orderErr(message, code) {
  return Object.assign(new Error(message), { code });
}

const isId = (v) => Number.isInteger(v) && v > 0;

/**
 * Move `move` (ids in the collection) to sit as one block right before
 * `before` (an id in the collection, not in `move`), or at the end when
 * `before` is null. The moved ids keep the relative order they have now,
 * whatever order the request listed them in.
 * @param {number[]} current  the collection's order now
 * @param {number[]} move
 * @param {number|null} before
 * @returns {number[]} the new order
 */
function planMove(current, move, before) {
  if (!Array.isArray(move) || move.length === 0 || !move.every(isId)) {
    throw orderErr('move must be a list of media ids', 'BAD_MOVE');
  }
  if (before !== null && !isId(before)) {
    throw orderErr('before must be a media id or null', 'BAD_BEFORE');
  }
  const members = new Set(current);
  const moving = new Set(move);
  for (const id of moving) {
    if (!members.has(id)) throw orderErr(`media ${id} is not in this collection`, 'NOT_MEMBER');
  }
  if (before !== null) {
    if (moving.has(before)) throw orderErr('before cannot be one of the files being moved', 'BEFORE_IN_MOVE');
    if (!members.has(before)) throw orderErr(`media ${before} is not in this collection`, 'BEFORE_NOT_MEMBER');
  }
  const block = current.filter(id => moving.has(id));
  const rest = current.filter(id => !moving.has(id));
  const at = before === null ? rest.length : rest.indexOf(before);
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * A whole new order: it must hold every current member exactly once.
 * @returns {number[]} the order, as given
 */
function planOrder(current, order) {
  if (!Array.isArray(order) || !order.every(isId)) {
    throw orderErr('order must be a list of media ids', 'BAD_ORDER');
  }
  const members = new Set(current);
  const seen = new Set();
  for (const id of order) {
    if (!members.has(id) || seen.has(id)) {
      throw orderErr('order must list every file in the collection exactly once', 'BAD_ORDER');
    }
    seen.add(id);
  }
  if (seen.size !== members.size) {
    throw orderErr('order must list every file in the collection exactly once', 'BAD_ORDER');
  }
  return order.slice();
}

/**
 * Either request shape → the new order. `body.order` wins when present.
 * @param {number[]} current
 * @param {{move?:number[], before?:number|null, order?:number[]}} body
 */
function planReorder(current, body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.order !== undefined) return planOrder(current, b.order);
  if (b.before === undefined) throw orderErr('before is required (a media id, or null for the end)', 'BAD_BEFORE');
  return planMove(current, b.move, b.before);
}

module.exports = { planMove, planOrder, planReorder };
