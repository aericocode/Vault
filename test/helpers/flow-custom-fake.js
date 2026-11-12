/**
 * What the server keeps for Flow's Custom (lib/flow/custom.js), for tests
 * that run player-lib/flow.js against a fake fetch: the real module on an
 * in-memory database, so the fakes answer as the server does.
 *
 *   const custom = flowCustomFake(3);
 *   // POST /api/collections/3/order: after the write
 *   Object.assign(answer, custom.write(before, after, body));
 *   // GET /api/flow/collections/3: answer.custom = custom.state(playlist)
 *   // GET /api/flow/collections/3/custom: { custom: custom.state(playlist) }
 */

const Database = require('better-sqlite3');
const custom = require('../../lib/flow/custom');

function flowCustomFake(collectionId) {
  const d = new Database(':memory:');
  d.exec('CREATE TABLE collections (id INTEGER PRIMARY KEY)');
  d.prepare('INSERT INTO collections (id) VALUES (?)').run(collectionId);
  custom.ensureSchema(d);
  return {
    /** After a playlist order write: the answer's flow fields (only when the page sent flow, as the route does). */
    write(before, after, body) {
      const sent = body && body.flow !== undefined;
      const r = custom.afterWrite(d, collectionId, before, after, sent ? custom.cleanFlow(body.flow) : undefined);
      return sent ? { flow_custom: r.now ? { ...r.now, lit: true } : null, flow_custom_was: r.was } : {};
    },
    state: (playlist) => custom.state(d, collectionId, playlist),
    db: d,
  };
}

module.exports = { flowCustomFake };
