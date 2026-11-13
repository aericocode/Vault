/**
 * Custom: a collection's own hand-made order, kept while a Flow shape is in
 * the playlist order, so the panel's Custom button can bring it back after
 * Undo is long gone (player-lib/flow.js). In the main library database, so
 * it survives a reload and a restart, travels with the library and stays
 * encrypted with an encrypted one.
 *
 *   flow_custom_orders(collection_id PK, order_json, shape, waves, places,
 *                      shaped_json, updated_at, mode, rev)
 *
 * The row stores what the user did; nothing is worked out by comparing it
 * with the playlist order:
 *   mode   'shape': the shape (shape, waves, places) is lit;
 *          'custom': Custom is lit (no row: Custom is lit too);
 *          'edited': a shape's order changed by hand since (a drag, a saved
 *          order loaded): nothing is lit, Custom brings the kept order back.
 *          NULL (rows written before mode existed): 'shape'. Any other value
 *          (a later Vault's) reads as 'edited': nothing replaces the kept
 *          order then but Custom and a shape picked after it.
 *   order_json  the kept order: the playlist order from right before a shape
 *          was picked while Custom was lit (only then is it replaced, never
 *          from a shape order changed by hand). Files taken out since stay in it
 *          (one put back goes back to its place); it is kept to the
 *          collection's files when it is read.
 *   rev    changes with every change of the row: an Undo puts the row back
 *          (with its rev, so an Undo before it in a chain still fits) only
 *          while the row is still the one its write left.
 *   shaped_json  no longer read (kept for rows from earlier builds).
 *
 * Each change comes from what the page says it did (POST
 * /api/collections/:id/order, flow; cleanFlow):
 *   { shape, waves?, places? }  a shape picked. From Custom (or no row) the
 *       playlist order before this write is kept; from a shape or an edited
 *       shape the kept order stays. mode 'shape'.
 *   { custom: true }  Custom: the server writes the kept order (kept to the
 *       files now: kept ones in kept order, others after them as they are)
 *       and sets mode 'custom'; the kept order stays for Undo. While Custom
 *       is lit already it writes nothing.
 *   { manual: true }  the user put the order in by hand (a drag, Alt+arrows,
 *       a saved order loaded): from 'shape' mode 'edited', else as it was
 *       ('custom' stays custom, 'edited' stays edited). The kept order stays.
 * A change of the row bumps the library version, so another window reads
 * the collection again and its panel lights the right button even when no
 * file moved.
 *   { restore: row | null, rev }  an Undo: exactly that row (its rev too)
 *       back, or none. Only while the row is still the one with this rev
 *       (rev null: no row). Else the whole write is refused (STALE, 409):
 *       no order, no skips, no row, no version move, so a mode never ends
 *       up over an order it does not describe. A drag's Undo and Remove's
 *       Undo send the row they saw unchanged ({ restore: that row, rev })
 *       just for this check.
 * Any order write without flow (an import, an older Vault) leaves the row
 * alone.
 *
 * A table of its own, not a column on collections: an older Vault never
 * reads or writes it (3.10 opens the library as before), collection lists
 * never carry a long order, and the row goes or is copied with the collection
 * (database.js deleteCollection, duplicateCollection). Rows of a collection
 * an older Vault deleted are removed on the next start (ids are never reused:
 * collections.id is AUTOINCREMENT).
 */

const crypto = require('crypto');
const FlowOrder = require('../../player-lib/flow-order.js');

const ORDER_MAX = 20000;
const MODES = ['shape', 'custom', 'edited'];

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
  const cols = new Set(db.prepare('PRAGMA table_info(flow_custom_orders)').all().map(c => c.name));
  if (!cols.has('mode')) db.exec('ALTER TABLE flow_custom_orders ADD COLUMN mode TEXT');
  if (!cols.has('rev')) db.exec('ALTER TABLE flow_custom_orders ADD COLUMN rev INTEGER');
  // Rows from before rev: one each, so an Undo can name them.
  db.exec('UPDATE flow_custom_orders SET rev = (abs(random()) % 140737488355327) + 1 WHERE rev IS NULL');
  db.exec('DELETE FROM flow_custom_orders WHERE collection_id NOT IN (SELECT id FROM collections)');
}

function err(message, code) {
  return Object.assign(new Error(message), { code });
}

const idList = (text) => {
  let v = null;
  try { v = JSON.parse(text); } catch {}
  return Array.isArray(v) ? [...new Set(v.filter(id => Number.isSafeInteger(id) && id > 0))] : [];
};

function cleanIds(v, what) {
  if (!Array.isArray(v) || v.length > ORDER_MAX || !v.every(id => Number.isSafeInteger(id) && id > 0)) {
    throw err(`${what} must be a list of file ids`, 'BAD');
  }
  if (new Set(v).size !== v.length) throw err(`${what} lists a file twice`, 'BAD');
  return v.slice();
}

function cleanShape(v, what) {
  if (!FlowOrder.isShape(v.shape)) throw err(`${what}.shape must be one of ${FlowOrder.SHAPE_KEYS.join(', ')}`, 'BAD');
  if (v.waves != null && (!Number.isInteger(v.waves) || v.waves < FlowOrder.WAVES_MIN || v.waves > FlowOrder.WAVES_MAX)) {
    throw err(`${what}.waves must be a whole number ${FlowOrder.WAVES_MIN} to ${FlowOrder.WAVES_MAX}`, 'BAD');
  }
  if (v.places != null && typeof v.places !== 'boolean') throw err(`${what}.places must be true or false`, 'BAD');
  return { shape: v.shape, waves: FlowOrder.wavesCount(v.waves), places: !!v.places };
}

const only = (v, keys, what) => {
  const extra = Object.keys(v).filter(k => !keys.includes(k));
  if (extra.length) throw err(`${what} does not take ${extra.join(', ')}`, 'BAD');
};

/**
 * What the page sends with an order write (flow). One intent each:
 *   { shape, waves?, places? } | { custom: true } | { manual: true } |
 *   { restore: null | { mode, shape, waves?, places?, kept, rev }, rev: number|null }
 * @returns {{ kind: 'shape'|'custom'|'manual'|'restore', ... }}
 * @throws {code:'BAD'}
 */
function cleanFlow(v) {
  const shapes = '{ shape, waves?, places? }, { custom: true }, { manual: true } or { restore, rev }';
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw err(`flow must be one of ${shapes}`, 'BAD');
  if (v.restore !== undefined) {
    only(v, ['restore', 'rev'], 'flow');
    if (!(v.rev === null || (Number.isSafeInteger(v.rev) && v.rev > 0))) throw err('flow.rev must be a row rev or null', 'BAD');
    const r = v.restore;
    if (r === null) return { kind: 'restore', row: null, rev: v.rev };
    if (typeof r !== 'object' || Array.isArray(r)) throw err('flow.restore must be null or a row', 'BAD');
    only(r, ['mode', 'shape', 'waves', 'places', 'kept', 'rev'], 'flow.restore');
    if (!MODES.includes(r.mode)) throw err('flow.restore.mode must be shape, custom or edited', 'BAD');
    if (!Number.isSafeInteger(r.rev) || r.rev <= 0) throw err('flow.restore.rev must be a row rev', 'BAD');
    return { kind: 'restore', row: { mode: r.mode, ...cleanShape(r, 'flow.restore'), kept: cleanIds(r.kept, 'flow.restore.kept'), rev: r.rev }, rev: v.rev };
  }
  if (v.custom !== undefined) {
    only(v, ['custom'], 'flow');
    if (v.custom !== true) throw err('flow.custom must be true', 'BAD');
    return { kind: 'custom' };
  }
  if (v.manual !== undefined) {
    only(v, ['manual'], 'flow');
    if (v.manual !== true) throw err('flow.manual must be true', 'BAD');
    return { kind: 'manual' };
  }
  if (v.shape === undefined) throw err(`flow must be one of ${shapes}`, 'BAD');
  only(v, ['shape', 'waves', 'places'], 'flow');
  return { kind: 'shape', ...cleanShape(v, 'flow') };
}

function rowOf(db, collectionId) {
  const r = db.prepare('SELECT * FROM flow_custom_orders WHERE collection_id = ?').get(collectionId);
  if (!r) return null;
  return {
    // NULL: a row from before mode (a lit shape). Unknown: nothing lit, the kept order safe.
    mode: r.mode == null ? 'shape' : MODES.includes(r.mode) ? r.mode : 'edited',
    shape: FlowOrder.isShape(r.shape) ? r.shape : 'smooth',
    waves: FlowOrder.wavesCount(r.waves),
    places: !!r.places,
    kept: idList(r.order_json),
    rev: Number.isSafeInteger(r.rev) ? r.rev : 0,
  };
}

/** The row as the page gets it: lit from the mode, custom = the kept order kept to these files. */
function view(row, members) {
  if (!row) return null;
  return { ...row, lit: row.mode === 'shape', custom: FlowOrder.reconcileOrder(row.kept, members) };
}

const newRev = () => crypto.randomInt(1, 2 ** 47);

const sameIdList = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
/** Two rows say the same (rev aside). */
const sameRow = (a, b) => !!a && !!b && a.mode === b.mode && a.shape === b.shape && a.waves === b.waves &&
  a.places === b.places && sameIdList(a.kept, b.kept);

/**
 * The row changed: the library version moves (library-index.js), so another
 * window reads the collection again even when no file moved, and its Flow
 * panel lights the right button. A database without the search tables (a
 * bare test one) has no version to move.
 */
function bump(db) {
  try { db.prepare("UPDATE library_meta SET value = value + 1 WHERE key = 'version'").run(); } catch {}
}

function put(db, collectionId, row) {
  db.prepare(`
    INSERT INTO flow_custom_orders (collection_id, order_json, shape, waves, places, shaped_json, updated_at, mode, rev)
    VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?)
    ON CONFLICT(collection_id) DO UPDATE SET order_json = excluded.order_json, shape = excluded.shape,
      waves = excluded.waves, places = excluded.places, shaped_json = excluded.shaped_json,
      updated_at = excluded.updated_at, mode = excluded.mode, rev = excluded.rev
  `).run(collectionId, JSON.stringify(row.kept), row.shape, row.waves, row.places ? 1 : 0, Date.now(), row.mode, row.rev || newRev());
}

/**
 * The order request to run, before the write (inside its transaction):
 * Custom asks for the kept order kept to the files now, or for no change
 * while Custom is lit already. An Undo over a row that changed since
 * throws { code: 'STALE' } (the transaction then writes nothing).
 * Everything else runs as sent.
 */
function planBody(db, collectionId, before, body, flow) {
  if (flow && flow.kind === 'restore') {
    // Checked in the write's own transaction: nothing can change the row between this and the write.
    const now = rowOf(db, collectionId);
    if ((now ? now.rev : null) !== flow.rev) throw err('This order was changed in another window, so there was nothing to undo.', 'STALE');
  }
  if (!flow || flow.kind !== 'custom') return body;
  const row = rowOf(db, collectionId);
  return { order: row && row.mode !== 'custom' ? FlowOrder.reconcileOrder(row.kept, before) : before.slice() };
}

/**
 * After a playlist order was written, inside its transaction: what the
 * collection keeps. `before` is the playlist order from before the write,
 * `after` the order written, flow what the page sent (cleanFlow; undefined
 * when it sent none).
 * @returns {{ was: object|null, now: object|null }} the row before and after (view)
 */
function afterWrite(db, collectionId, before, after, flow) {
  const was = rowOf(db, collectionId);
  const out = () => ({ was: view(was, before), now: view(rowOf(db, collectionId), after) });
  if (!flow) return out();
  let next;   // the row to keep; undefined: leave it
  if (flow.kind === 'shape') {
    const pick = { shape: flow.shape, waves: flow.waves, places: flow.places };
    // Only from Custom (or no row) is the order before kept: a shape, or a
    // shape changed by hand ('edited'), keeps the kept order it has.
    if (!was || was.mode === 'custom') next = { mode: 'shape', ...pick, kept: before.slice() };
    else next = { ...was, mode: 'shape', ...pick };
  } else if (flow.kind === 'custom') {
    if (was && was.mode !== 'custom') next = { ...was, mode: 'custom' };
  } else if (flow.kind === 'manual') {
    if (was && was.mode === 'shape') next = { ...was, mode: 'edited' };
  } else if (flow.kind === 'restore') {
    // Only over the row this Undo's write left (planBody refused any other).
    if ((was ? was.rev : null) === flow.rev) {
      if (flow.row) { if (!sameRow(flow.row, was) || flow.row.rev !== was.rev) { put(db, collectionId, flow.row); bump(db); } }
      else if (was) { db.prepare('DELETE FROM flow_custom_orders WHERE collection_id = ?').run(collectionId); bump(db); }
    }
  }
  // Nothing new (the same shape again, Custom while Custom is lit): the row and its rev stay.
  if (next && !sameRow(next, was)) { put(db, collectionId, { ...next, rev: 0 }); bump(db); }
  return out();
}

/** What the page needs: the row (view: lit, the kept order kept to the files now), or null: no row. */
function state(db, collectionId, playlist) {
  const row = rowOf(db, collectionId);
  if (!row) return null;
  const members = playlist || db.prepare('SELECT media_id FROM collection_items WHERE collection_id = ? ORDER BY position, added_at').pluck().all(collectionId);
  return view(row, members);
}

/** Duplicate: the copy keeps the same kept order, shape and mode. */
function copy(db, fromCollectionId, toCollectionId) {
  db.prepare(`
    INSERT OR REPLACE INTO flow_custom_orders (collection_id, order_json, shape, waves, places, shaped_json, updated_at, mode, rev)
    SELECT ?, order_json, shape, waves, places, shaped_json, updated_at, mode, ? FROM flow_custom_orders WHERE collection_id = ?
  `).run(toCollectionId, newRev(), fromCollectionId);
}

/** A deleted collection's row goes with it. */
function removeFor(db, collectionId) {
  db.prepare('DELETE FROM flow_custom_orders WHERE collection_id = ?').run(collectionId);
}

module.exports = { ensureSchema, cleanFlow, planBody, afterWrite, state, copy, removeFor };
