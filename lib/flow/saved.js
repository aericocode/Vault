/**
 * Saved Flow orders: named versions of a collection's Flow order (its shape,
 * Waves' peaks, Place tagged files on or off, and the exact order of its
 * files), so one collection can keep several and switch between them
 * (player-lib/flow.js, the chips on the Lanes row). In the main library
 * database, so they travel with the library and an encrypted library keeps
 * them encrypted with everything else.
 *
 *   flow_saved_orders(id PK, collection_id, name, shape, waves, places,
 *                     order_json, created_at, updated_at)
 *
 * order_json: the whole collection's order when it was saved (JSON list of
 * media ids). It is not kept in step with the collection: the page fits it
 * to the files there are when it is loaded (FlowOrder.reconcileOrder: gone
 * files dropped, new ones at the end). Duplicating a collection copies its
 * saved orders (database.js duplicateCollection); deleting one deletes them
 * (deleteCollection).
 *
 * Names are unique per collection, ignoring case, and a collection keeps at
 * most MAX_PER_COLLECTION.
 */

const FlowOrder = require('../../player-lib/flow-order.js');

const MAX_PER_COLLECTION = 30;
const NAME_MAX = 80;
const ORDER_MAX = 20000;      // Flow works on up to 5,000 files; this is only a sanity cap

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_saved_orders (
      id            INTEGER PRIMARY KEY,
      collection_id INTEGER NOT NULL,
      name          TEXT NOT NULL,
      shape         TEXT NOT NULL,
      waves         INTEGER,
      places        INTEGER NOT NULL DEFAULT 0,
      order_json    TEXT NOT NULL,
      created_at    INTEGER,
      updated_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_flow_saved_orders_coll ON flow_saved_orders(collection_id);
  `);
}

function err(message, code) {
  return Object.assign(new Error(message), { code });
}

/* ── Checking what the page sends ───────────────────────────────── */

function cleanName(v) {
  if (typeof v !== 'string') throw err('name must be text', 'BAD');
  const name = v.trim();
  if (!name) throw err('name is empty', 'BAD');
  if (name.length > NAME_MAX) throw err(`name is longer than ${NAME_MAX} characters`, 'BAD');
  return name;
}

function cleanShape(v) {
  if (!FlowOrder.isShape(v)) throw err(`shape must be one of ${FlowOrder.SHAPE_KEYS.join(', ')}`, 'BAD');
  return v;
}

function cleanWaves(v) {
  if (v == null) return FlowOrder.WAVES_DEFAULT;
  if (!Number.isInteger(v) || v < FlowOrder.WAVES_MIN || v > FlowOrder.WAVES_MAX) {
    throw err(`waves must be a whole number ${FlowOrder.WAVES_MIN} to ${FlowOrder.WAVES_MAX}`, 'BAD');
  }
  return v;
}

function cleanPlaces(v) {
  if (v == null) return false;
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  throw err('places must be true or false', 'BAD');
}

/** A list of media ids: whole, positive, safe numbers; repeats dropped. */
function cleanOrder(v) {
  if (!Array.isArray(v)) throw err('order must be a list of file ids', 'BAD');
  if (v.length > ORDER_MAX) throw err(`order has more than ${ORDER_MAX} files`, 'BAD');
  if (!v.every(id => Number.isSafeInteger(id) && id > 0)) throw err('order must be a list of file ids', 'BAD');
  return [...new Set(v)];
}

/* ── Rows ────────────────────────────────────────────────────────── */

function toJson(r) {
  let order = [];
  try { order = JSON.parse(r.order_json); } catch {}
  if (!Array.isArray(order)) order = [];
  return {
    id: r.id,
    collectionId: r.collection_id,
    name: r.name,
    shape: FlowOrder.isShape(r.shape) ? r.shape : 'smooth',
    waves: FlowOrder.wavesCount(r.waves),
    places: !!r.places,
    order: order.filter(id => Number.isSafeInteger(id) && id > 0),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function get(db, id) {
  const r = db.prepare('SELECT * FROM flow_saved_orders WHERE id = ?').get(id);
  return r ? toJson(r) : null;
}

/** A collection's saved orders, oldest first. */
function list(db, collectionId) {
  return db.prepare('SELECT * FROM flow_saved_orders WHERE collection_id = ? ORDER BY created_at, id')
    .all(collectionId).map(toJson);
}

function assertNameFree(db, collectionId, name, exceptId) {
  const clash = db.prepare(
    'SELECT id FROM flow_saved_orders WHERE collection_id = ? AND LOWER(name) = LOWER(?) AND id IS NOT ? LIMIT 1'
  ).get(collectionId, name, exceptId);
  if (clash) throw err('a saved order with that name already exists', 'NAME_TAKEN');
}

/**
 * Save a new order for a collection.
 * @throws {code:'NOT_FOUND'|'FOLDER'|'BAD'|'NAME_TAKEN'|'FULL'}
 */
function create(db, collectionId, body, { now = Date.now() } = {}) {
  const b = body || {};
  const name = cleanName(b.name);
  const shape = cleanShape(b.shape);
  const waves = cleanWaves(b.waves);
  const places = cleanPlaces(b.places);
  const order = cleanOrder(b.order);
  return db.transaction(() => {
    const c = db.prepare('SELECT kind FROM collections WHERE id = ?').get(collectionId);
    if (!c) throw err('collection not found', 'NOT_FOUND');
    if (c.kind === 'folder') throw err('a folder has no Flow order', 'FOLDER');
    const n = db.prepare('SELECT COUNT(*) AS n FROM flow_saved_orders WHERE collection_id = ?').get(collectionId).n;
    if (n >= MAX_PER_COLLECTION) throw err(`a collection keeps at most ${MAX_PER_COLLECTION} saved orders`, 'FULL');
    assertNameFree(db, collectionId, name, null);
    const info = db.prepare(`
      INSERT INTO flow_saved_orders (collection_id, name, shape, waves, places, order_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(collectionId, name, shape, waves, places ? 1 : 0, JSON.stringify(order), now, now);
    return get(db, Number(info.lastInsertRowid));
  })();
}

/**
 * Rename a saved order and / or replace what it holds (shape, waves,
 * places, order: any of them).
 * @throws {code:'NOT_FOUND'|'BAD'|'NAME_TAKEN'}
 */
function update(db, id, body, { now = Date.now() } = {}) {
  const b = body || {};
  const sets = [];
  const vals = [];
  let name = null;
  if (b.name !== undefined) { name = cleanName(b.name); sets.push('name = ?'); vals.push(name); }
  if (b.shape !== undefined) { sets.push('shape = ?'); vals.push(cleanShape(b.shape)); }
  if (b.waves !== undefined) { sets.push('waves = ?'); vals.push(cleanWaves(b.waves)); }
  if (b.places !== undefined) { sets.push('places = ?'); vals.push(cleanPlaces(b.places) ? 1 : 0); }
  if (b.order !== undefined) { sets.push('order_json = ?'); vals.push(JSON.stringify(cleanOrder(b.order))); }
  if (!sets.length) throw err('nothing to change', 'BAD');
  return db.transaction(() => {
    const row = db.prepare('SELECT collection_id FROM flow_saved_orders WHERE id = ?').get(id);
    if (!row) throw err('saved order not found', 'NOT_FOUND');
    if (name != null) assertNameFree(db, row.collection_id, name, id);
    db.prepare(`UPDATE flow_saved_orders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
    return get(db, id);
  })();
}

/** @returns {boolean} whether there was one to delete */
function remove(db, id) {
  return db.prepare('DELETE FROM flow_saved_orders WHERE id = ?').run(id).changes > 0;
}

/** A collection's saved orders copied to another (Duplicate), names and order kept. */
function copyAll(db, fromCollectionId, toCollectionId) {
  db.prepare(`
    INSERT INTO flow_saved_orders (collection_id, name, shape, waves, places, order_json, created_at, updated_at)
    SELECT ?, name, shape, waves, places, order_json, created_at, updated_at
    FROM flow_saved_orders WHERE collection_id = ? ORDER BY created_at, id
  `).run(toCollectionId, fromCollectionId);
}

/** A deleted collection's saved orders go with it. */
function removeFor(db, collectionId) {
  db.prepare('DELETE FROM flow_saved_orders WHERE collection_id = ?').run(collectionId);
}

module.exports = { ensureSchema, list, get, create, update, remove, copyAll, removeFor, MAX_PER_COLLECTION, NAME_MAX, ORDER_MAX };
