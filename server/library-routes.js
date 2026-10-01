/**
 * Library search routes (/api/library/*), SERVER_SEARCH_SPEC section 6.
 *
 * The viewer asks for what it wants to see (a query spec) and gets the first
 * page right away, then the full ordered id list as a compact binary download.
 * Search, filters, sort and counts all run here, against SQLite indexes, so
 * the browser never downloads the whole library.
 *
 * Everything is under /api/, so the vault lock gate in server/index.js
 * answers 423 for these routes while the library is locked.
 *
 * POST /api/library/query takes a bigger JSON body than the app's 2 MB default
 * (focus sets and audio-sim lists can carry many ids); server/index.js gives
 * that one path its own 64 MB parser.
 */

const express = require('express');
const database = require('../lib/database');
const libraryIndex = require('../lib/library-index');
const libraryQuery = require('../lib/library-query');
const libraryFacets = require('../lib/library-facets');
const nameFuzzy = require('../lib/name-fuzzy');

const QUERY_JSON_LIMIT = '64mb';
const IDS_SUMMARY_LIMIT = '16mb';

function sendError(res, err) {
  if (err instanceof libraryQuery.QueryError) {
    const body = { error: err.message };
    if (err.code) body.code = err.code;
    return res.status(err.status).json(body);
  }
  console.error(`[library] ${err.stack || err.message}`);
  return res.status(500).json({ error: err.message });
}

function buildRouter() {
  const router = express.Router();

  // 6.1 First page of a query, plus the qid for its full id list.
  router.post('/query', async (req, res) => {
    try {
      const spec = libraryQuery.normalizeSpec(req.body);
      res.json(await libraryQuery.query(spec));
    } catch (err) {
      sendError(res, err);
    }
  });

  // 6.2 Every id of a query, in order: u32 count, u32 version, ids, type codes.
  router.get('/query/:qid/ids', async (req, res) => {
    try {
      const out = await libraryQuery.idsForQid(String(req.params.qid));
      if (!out) return res.status(404).json({ error: 'unknown or expired query. Send it again.' });
      res.set('Content-Type', 'application/octet-stream');
      res.set('X-Vault-Total', String(out.ids.length));
      res.set('X-Vault-Version', String(out.version));
      res.send(libraryQuery.encodeIds(out));
    } catch (err) {
      sendError(res, err);
    }
  });

  // 6.4 Library-wide counts: a cached body, and 304 when the viewer has it.
  router.get('/facets', async (req, res) => {
    try {
      const { body, etag } = await libraryFacets.facetsBody();
      res.set('ETag', etag);
      res.set('Cache-Control', 'no-cache');
      if (req.get('If-None-Match') === etag) return res.status(304).end();
      res.type('application/json').send(body);
    } catch (err) {
      sendError(res, err);
    }
  });

  // 6.9 Theme search for the Theme popover (facets carry only the top 1,000).
  router.get('/themes', async (req, res) => {
    const q = req.query.q === undefined ? '' : String(req.query.q);
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (q.length > 200) return res.status(400).json({ error: 'q must be 200 characters or fewer' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return res.status(400).json({ error: 'limit must be 1 to 500' });
    try {
      res.json(await libraryFacets.themes({ q, limit }));
    } catch (err) {
      sendError(res, err);
    }
  });

  // 6.5 Cheap: the viewer polls it in the background.
  router.get('/version', (req, res) => {
    const db = database.get();
    const s = libraryIndex.status(db);
    res.json({ version: libraryIndex.version(db), index: { state: s.state, progress: s.progress, step: s.step, steps: s.steps } });
  });

  // 6.6 Counts for a selection too big to fetch rows for (u32 ids, little-endian).
  router.post('/ids-summary', express.raw({ type: () => true, limit: IDS_SUMMARY_LIMIT }), async (req, res) => {
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (body.length % 4 !== 0) return res.status(400).json({ error: 'body must be a list of u32 ids' });
      const ids = new Uint32Array(body.length / 4);
      for (let i = 0; i < ids.length; i++) ids[i] = body.readUInt32LE(i * 4);
      res.json(await libraryFacets.idsSummary(ids));
    } catch (err) {
      sendError(res, err);
    }
  });

  // 6.7 Duplicate groups (same type and size, 2+ files), paged.
  router.get('/duplicates', async (req, res) => {
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
    if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: 'offset must be 0 or more' });
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return res.status(400).json({ error: 'limit must be 1 to 1000' });
    try {
      res.json(await libraryFacets.duplicates({ offset, limit }));
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}

/**
 * The query route's own JSON parser (64 MB) and error shape. Installed by
 * server/index.js in place of the 2 MB default for that one path.
 */
const queryJsonParser = express.json({ limit: QUERY_JSON_LIMIT });

/** Body parser failures on /api/library/* as `{error}` JSON, not an HTML page. */
function bodyErrorHandler(err, req, res, next) {
  if (!err || !err.type) return next(err);
  const status = err.status || 400;
  const error = err.type === 'entity.too.large' ? 'request body is too large'
    : err.type === 'entity.parse.failed' ? 'body must be valid JSON'
    : err.message;
  res.status(status).json({ error });
}

/**
 * Create the plain sort/filter indexes the library lacks, synchronously, with
 * a console line per index (spec 5.3). The server calls this before it
 * listens; a library that booted locked gets the asynchronous step after
 * its unlock instead (startIndexing): one CREATE INDEX
 * blocks for seconds at 2M files, and a listening server that blocks that
 * long drops connections. Only the first launch after an update has work.
 */
function prepareIndexes({ log = console.log } = {}) {
  let db;
  try { db = database.get(); } catch { return []; }
  // A schema bump: search reports building from before the first request.
  if (libraryIndex.buildReason(db) === 'schema') libraryIndex.setMeta(db, 'search_built', 0);
  const done = libraryIndex.createMissingIndexes(db, { log });
  if (done.length) {
    const s = done.reduce((n, [, ms]) => n + ms, 0) / 1000;
    log(`  Library ready for search indexing (${done.length} indexes, ${s.toFixed(1)} s).`);
  }
  return done;
}

/**
 * Build the search indexes in the background and keep doing so across vault
 * lock/unlock: the build stops when the database closes and resumes on the
 * next unlock (it is idempotent per row).
 */
function startIndexing(vault, { log = console.log } = {}) {
  // Never let the build reopen a locked library: database.get() opens the
  // file when no connection is live, so ask the vault first.
  const liveDb = () => {
    if (vault && vault.isLocked()) return null;
    try { return database.get(); } catch { return null; }
  };
  const run = () => {
    const db = liveDb();
    if (!db || !db.open) return;
    // A build stopped by a lock may still be winding down (it notices at its
    // next batch); try again shortly rather than skipping this unlock.
    if (libraryIndex.status(db).phase) return void setTimeout(run, 250);
    libraryIndex.startBuild(liveDb, { log })
      .catch(err => log(`[search-index] ${err.message}`))
      .then(() => {
        // Load the fuzzy vocabulary now (in slices), not on the first search.
        const ready = liveDb();
        if (ready && libraryIndex.status(ready).state === 'ready') nameFuzzy.prewarm(ready);
      });
  };
  if (vault) {
    vault.onChange((e) => {
      if (e === 'locking' || e === 'locked') {
        libraryIndex.stopBuild();
        libraryQuery.clearPlans();
        libraryFacets.reset();
        nameFuzzy.reset();
      } else if (e === 'unlocked') {
        // Never inside the unlock request (round 3): at 2M on an encrypted
        // file the indexes take minutes. Let the response go out, then run
        // the index step one statement per turn ('preparing'), then build.
        // 'preparing' (step 0) shows from here, not 'building' for the gap.
        libraryIndex.markPreparing(liveDb());
        setTimeout(() => {
          const db = liveDb();
          if (db && libraryIndex.buildReason(db) === 'schema') libraryIndex.setMeta(db, 'search_built', 0);
          libraryIndex.prepareIndexesAsync(liveDb, { log })
            .then((done) => { if (done) setImmediate(run); })
            .catch(err => log(`[search-index] preparing failed: ${err.message}`));
        }, 50);
      }
    });
  }
  if (!vault || !vault.isLocked()) setImmediate(run);
}

module.exports = { buildRouter, queryJsonParser, bodyErrorHandler, prepareIndexes, startIndexing };
