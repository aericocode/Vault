/**
 * What the server keeps for Flow's Custom (lib/flow/custom.js), for tests
 * that run player-lib/flow.js against a fake fetch: the real module on an
 * in-memory database, so the fakes answer as the server does.
 *
 *   const custom = flowCustomFake(3);
 *   // POST /api/collections/3/order { order | move, flow? }: the order
 *   // written and the answer's flow fields, as the route gives them.
 *   const { order, flow_custom, flow_custom_was } = custom.post(before, body);
 *   // GET /api/flow/collections/3: answer.custom = custom.state(playlist)
 */

const Database = require('better-sqlite3');
const custom = require('../../lib/flow/custom');
const collectionOrder = require('../../lib/collection-order');

function flowCustomFake(collectionId) {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE collections (id INTEGER PRIMARY KEY)');
  d.prepare('INSERT INTO collections (id) VALUES (?)').run(collectionId);
  custom.ensureSchema(d);
  return {
    /**
     * The order route on a playlist `before`: throws { code: 'BAD' } for a
     * bad flow (the route answers 400), { code: 'STALE' } when seen is not
     * `before` or an Undo's rev no longer fits (the route answers 409).
     */
    post(before, body) {
      const flow = body && body.flow !== undefined ? custom.cleanFlow(body.flow) : undefined;
      if (body && Array.isArray(body.seen) && (body.seen.length !== before.length || body.seen.some((id, i) => id !== before[i]))) {
        throw Object.assign(new Error('This playlist was changed in another window.'), { code: 'STALE' });
      }
      return d.transaction(() => {
        const order = collectionOrder.planReorder(before, custom.planBody(d, collectionId, before, body, flow));
        const r = custom.afterWrite(d, collectionId, before, order, flow);
        return { order, flow_custom: r.now, flow_custom_was: r.was };
      })();
    },
    state: (playlist) => custom.state(d, collectionId, playlist),
    db: d,
  };
}

module.exports = { flowCustomFake };
