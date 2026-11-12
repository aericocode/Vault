/**
 * Custom: a collection's own hand-made order, kept while a Flow shape is in
 * the playlist order, so the panel's Custom button can bring it back after
 * Undo is long gone (player-lib/flow.js). In the main library database, so
 * it survives a reload and a restart, travels with the library and stays
 * encrypted with an encrypted one.
 *
 *   flow_custom_orders(collection_id PK, order_json, shape, waves, places,
 *                      shaped_json, updated_at)
 *
 * One row per collection once a shape was put in: order_json is the order
 * from before the shape (the custom order, only files that were members
 * then), shape / waves / places the shape put in last and shaped_json the
 * playlist order it wrote.
 *
 * Lit: the shape is lit while the playlist order still equals shaped_json
 * (kept to the collection's files: gone ones dropped, new ones at the end,
 * the same rule as saved orders); Custom is lit otherwise. A shaped list
 * that cannot be read, is empty, or shares no file with the collection is
 * never lit.
 *
 * The row is only ever replaced or removed on purpose:
 *  - a shape picked while Custom is lit replaces it (the order from before
 *    that write is the custom one now); shape to shape keeps the custom order;
 *  - an Undo of a shape pick puts back exactly the row from before it (or
 *    removes it, when there was none);
 *  - deleting the collection removes it.
 * Every other write of the order (a drag, Custom itself, a saved order
 * loaded, Remove and its Undo, an import, an older Vault) leaves it alone:
 * the playlist order is no longer the shaped one, so Custom is lit and the
 * row waits (dormant). If the playlist comes back to the shaped order (an
 * Undo, a drag back by hand), the shape is lit again and Custom brings the
 * kept order back.
 *
 * A table of its own, not a column on collections: an older Vault never
 * reads or writes it (3.10 opens the library as before), collection lists
 * never carry a long order, and the row goes or is copied with the collection
 * (database.js deleteCollection, duplicateCollection). Rows of a collection
 * an older Vault deleted are removed on the next start (ids are never reused:
 * collections.id is AUTOINCREMENT).
 */

const FlowOrder = require('../../player-lib/flow-order.js');

const ORDER_MAX = 20000;

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_custom_orders (
      collection_id INTEGER PRIMARY KEY,
      order_json    TEXT NOT NULL,
      shape         TEXT NOT NULL,
      waves         INTEGER,
      places        INTEGER NOT NULL DEFAULT 0,
      shaped_json   TEXT NOT NULL,
      updated_at    INTEGER
    );
  `);
  db.exec('DELETE FROM flow_custom_orders WHERE collection_id NOT IN (SELECT id FROM collections)');
}

function err(message, code) {
  return Object.assign(new Error(message), { code });
}

const idList = (text) => {
  let v = null;
  try { v = JSON.parse(text); } catch {}
  return Array.isArray(v) ? v.filter(id => Number.isSafeInteger(id) && id > 0) : [];
};

function cleanOrder(v, what) {
  if (!Array.isArray(v) || v.length > ORDER_MAX || !v.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw err(`${what} must be a list of file ids`, 'BAD');
  }
  return [...new Set(v)];
}

/**
 * What the page sends with a playlist order it writes (POST
 * /api/collections/:id/order, flow). Left out: the row is left alone.
 * null: no row (an Undo of a shape picked when there was none).
 * { shape, waves?, places? }: a shape picked (the server works out the
 * custom order). With custom (and shaped): exactly that row (an Undo).
 * @throws {code:'BAD'}
 */
function cleanFlow(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err('flow must be null or { shape, waves, places, custom, shaped }', 'BAD');
  if (!FlowOrder.isShape(v.shape)) throw err(`flow.shape must be one of ${FlowOrder.SHAPE_KEYS.join(', ')}`, 'BAD');
  if (v.waves != null && (!Number.isInteger(v.waves) || v.waves < FlowOrder.WAVES_MIN || v.waves > FlowOrder.WAVES_MAX)) {
    throw err(`flow.waves must be a whole number ${FlowOrder.WAVES_MIN} to ${FlowOrder.WAVES_MAX}`, 'BAD');
  }
  if (v.places != null && typeof v.places !== 'boolean') throw err('flow.places must be true or false', 'BAD');
  if (v.shaped !== undefined && v.custom === undefined) throw err('flow.shaped comes with flow.custom', 'BAD');
  return {
    shape: v.shape,
    waves: FlowOrder.wavesCount(v.waves),
    places: !!v.places,
    custom: v.custom === undefined ? undefined : cleanOrder(v.custom, 'flow.custom'),
    shaped: v.shaped === undefined ? undefined : cleanOrder(v.shaped, 'flow.shaped'),
  };
}

function rowOf(db, collectionId) {
  const r = db.prepare('SELECT * FROM flow_custom_orders WHERE collection_id = ?').get(collectionId);
  if (!r) return null;
  return {
    custom: idList(r.order_json),
    shape: FlowOrder.isShape(r.shape) ? r.shape : 'smooth',
    waves: FlowOrder.wavesCount(r.waves),
    places: !!r.places,
    shaped: idList(r.shaped_json),
  };
}

const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

/** The playlist order is still the shape put in (kept to its files now). Never for a shaped list with none of its files. */
function isLit(row, playlist) {
  if (!row || !Array.isArray(row.shaped) || !row.shaped.length || !playlist.length) return false;
  const members = new Set(playlist);
  if (!row.shaped.some(id => members.has(id))) return false;
  return sameIds(playlist, FlowOrder.reconcileOrder(row.shaped, playlist));
}

/**
 * After a playlist order was written, inside its transaction: what the
 * collection keeps. `before` is the playlist order from before the write,
 * `after` the order written, flow what the page sent (cleanFlow; undefined
 * when it sent none).
 * @returns {{ was: object|null, now: object|null }} the row before and
 *   after, each with lit (was: against before, now: against after)
 */
function afterWrite(db, collectionId, before, after, flow) {
  const was = rowOf(db, collectionId);
  if (was) was.lit = isLit(was, before);
  const nowRow = () => { const r = rowOf(db, collectionId); if (r) r.lit = isLit(r, after); return r; };
  if (flow === undefined) return { was, now: nowRow() };
  if (flow === null) {
    db.prepare('DELETE FROM flow_custom_orders WHERE collection_id = ?').run(collectionId);
    return { was, now: null };
  }
  const members = new Set(after);
  // Shape to shape keeps the custom order; from Custom (no lit shape) the
  // order from before this write is the custom one. Only files that are in
  // the collection are kept: one added later goes at the end when Custom
  // brings the order back.
  const custom = (flow.custom !== undefined ? flow.custom : (was && was.lit ? was.custom : before)).filter(id => members.has(id));
  const shaped = (flow.shaped !== undefined ? flow.shaped : after).filter(id => members.has(id));
  db.prepare(`
    INSERT INTO flow_custom_orders (collection_id, order_json, shape, waves, places, shaped_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(collection_id) DO UPDATE SET order_json = excluded.order_json, shape = excluded.shape,
      waves = excluded.waves, places = excluded.places, shaped_json = excluded.shaped_json, updated_at = excluded.updated_at
  `).run(collectionId, JSON.stringify(custom), flow.shape, flow.waves, flow.places ? 1 : 0, JSON.stringify(shaped), Date.now());
  return { was, now: nowRow() };
}

/**
 * What the page needs: the shape put in (and the order it wrote, to tell
 * whether it is still lit), and the custom order kept to the collection's
 * files now (gone ones dropped, new ones at the end), or null: no row.
 */
function state(db, collectionId, playlist) {
  const row = rowOf(db, collectionId);
  if (!row) return null;
  const members = playlist || db.prepare('SELECT media_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at').pluck().all(collectionId);
  return { ...row, custom: FlowOrder.reconcileOrder(row.custom, members), lit: isLit(row, members) };
}

/** Duplicate: the copy keeps the same custom order and shape. */
function copy(db, fromCollectionId, toCollectionId) {
  db.prepare(`
    INSERT OR REPLACE INTO flow_custom_orders (collection_id, order_json, shape, waves, places, shaped_json, updated_at)
    SELECT ?, order_json, shape, waves, places, shaped_json, updated_at FROM flow_custom_orders WHERE collection_id = ?
  `).run(toCollectionId, fromCollectionId);
}

/** A deleted collection's row goes with it. */
function removeFor(db, collectionId) {
  db.prepare('DELETE FROM flow_custom_orders WHERE collection_id = ?').run(collectionId);
}

module.exports = { ensureSchema, cleanFlow, afterWrite, state, copy, removeFor, isLit };
