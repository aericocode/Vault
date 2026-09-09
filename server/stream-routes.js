/**
 * Playback + HLS remux routes (REMUX_STREAMING_SPEC sections 4, 5 and 8).
 *
 *   GET  /api/playback/:id?caps=…   how should this file be played?
 *   GET  /stream/:id/index.m3u8     VOD playlist (builds the keyframe index once)
 *   GET  /stream/:id/seg/:n.ts      one MPEG-TS segment, produced on demand
 *   POST /stream/:id/close          the player went away: stop now, do not wait
 *   GET  /api/stream/status         what is playing and what it holds in memory
 *   POST|GET /api/playback/backfill codec probe + index prebuild over the library,
 *                                   reporting how many files play directly,
 *                                   play via conversion, or cannot play
 *
 * The vault lock gate in server/index.js already answers 423 for /api/ and
 * /stream/ while locked, so nothing here has to re-check it.
 */

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const db = require('../lib/database');
const service = require('../lib/stream/service');
const session = require('../lib/stream/session');
const ring = require('../lib/stream/ring');
const secureAssets = require('../lib/secure-assets');
const streamIndex = require('../lib/stream/index');
const { decide, DEFAULT_CAPS } = require('../lib/stream/decide');
const mediaInfo = require('../lib/media-info');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Who is asking? Two players on one file need separate playheads, or a seek in
 * one drags the other's retention window off the segments it is about to play.
 *
 * The player mints a `c` per player instance, so two tabs in the same browser
 * are two clients. Anything else (curl, a script, an old page) gets a stable
 * token derived from where it is connecting from, which at least separates two
 * different fetchers and never grows without bound.
 */
function clientToken(req) {
  const raw = String(req.query.c || '');
  if (/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  const who = `${req.ip || req.socket.remoteAddress || ''}|${req.get('user-agent') || ''}`;
  return 'a' + crypto.createHash('sha1').update(who).digest('hex').slice(0, 16);
}

/* ── Backfill job (same shape as the migrate job: one slot, outlives the request) ── */

const backfillJob = (() => {
  const RESULT_TTL_MS = 60 * 60 * 1000;
  let job = null;
  let seq = 0;

  async function execute(j) {
    try {
      const rows = db.rowsNeedingProbe(j.all);
      j.total = rows.length;
      j.phase = 'probing';
      for (const row of rows) {
        if (j.cancelled) break;
        j.processed++;
        if (!fs.existsSync(row.filepath)) { j.skipped++; continue; }
        try {
          const info = await mediaInfo.getStreamInfo(row.filepath);
          if (!info) { j.failed++; continue; }
          db.saveStreamInfo(row.id, info);
          j.probed++;

          const fresh = db.getById(row.id);
          const verdict = fresh ? decide(fresh, new Set(DEFAULT_CAPS)) : null;

          // The three counts the Settings row reports. Only video and audio
          // are decided on: a gif is drawn as an image, so calling its codec
          // undecodable would be a lie the summary line then repeats.
          if (verdict && (fresh.media_type === 'video' || fresh.media_type === 'audio')) {
            if (verdict.mode === 'native') j.plays++;
            else if (verdict.mode === 'remux') j.converts++;
            else j.cannot++;
          }

          // Prebuild the keyframe index for anything a default client would
          // have to remux, so the first play does not pay for the scan.
          if (verdict && verdict.mode === 'remux') {
            try {
              await service.ensureIndex(fresh);
              j.indexed++;
            } catch { /* an unindexable file is not a backfill failure */ }
          }
        } catch {
          j.failed++;
        }
      }
    } catch (err) {
      j.error = err && err.message ? err.message : String(err);
    } finally {
      j.done = true;
      j.phase = 'done';
      j.finishedAt = Date.now();
    }
  }

  function etaMs(j) {
    if (j.done || !j.total || j.processed <= 0) return null;
    const dt = Date.now() - j.startedAt;
    if (dt < 2000) return null;
    return Math.round((j.total - j.processed) * dt / j.processed);
  }

  return {
    isRunning() { return !!(job && !job.done); },

    start({ all = false } = {}) {
      if (job && !job.done) return { status: 409, error: 'a codec backfill is already running', jobId: job.id };
      job = {
        id: `probe-${++seq}-${Date.now()}`,
        all, startedAt: Date.now(), finishedAt: null,
        phase: 'starting', processed: 0, total: 0,
        probed: 0, indexed: 0, skipped: 0, failed: 0,
        plays: 0, converts: 0, cannot: 0,
        done: false, cancelled: false, error: null,
      };
      job.promise = execute(job);
      return { job };
    },

    cancel() { if (job && !job.done) job.cancelled = true; },

    status() {
      if (!job) return null;
      if (job.done && Date.now() - job.finishedAt > RESULT_TTL_MS) return null;
      return {
        jobId: job.id,
        running: !job.done,
        phase: job.phase,
        processed: job.processed,
        total: job.total,
        probed: job.probed,
        indexed: job.indexed,
        // What the check found, for the Settings result line.
        checked: job.plays + job.converts + job.cannot,
        plays: job.plays,
        converts: job.converts,
        cannot: job.cannot,
        skipped: job.skipped,
        failed: job.failed,
        elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
        etaMs: etaMs(job),
        done: job.done,
        error: job.error,
      };
    },
  };
})();

function buildRouter() {
  const router = express.Router();

  /* ── The decision ─────────────────────────────────────────────────────── */

  // Fixed path first, so "backfill" is never read as an id.
  router.get('/api/playback/backfill', (req, res) => {
    res.json(backfillJob.status() || { running: false, idle: true });
  });

  router.post('/api/playback/backfill', (req, res) => {
    const started = backfillJob.start({ all: req.body?.all === true });
    if (started.error) {
      return res.status(409).json({ error: started.error, jobId: started.jobId, running: true });
    }
    res.status(202).json({ ok: true, jobId: started.job.id });
  });

  router.get('/api/playback/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const row = db.getById(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await service.playbackInfo(row, service.parseCaps(req.query.caps)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ── What is playing ──────────────────────────────────────────────────── */

  router.get('/api/stream/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...session.status(), indexBuilds: service.indexBuilds });
  });

  /* ── The stream ───────────────────────────────────────────────────────── */

  router.get('/stream/:id/index.m3u8', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).end();
    const row = db.getById(id);
    if (!row) return res.status(404).end();
    if (!fs.existsSync(row.filepath)) return res.status(404).end();
    try {
      const { text } = await service.playlistFor(row, clientToken(req));
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(text);
    } catch (err) {
      res.status(500).json({ error: err.message, code: err.code || null });
    }
  });

  // The filename is matched here rather than as a ":n.ts" path param, whose
  // meaning has changed between path-to-regexp versions.
  router.get('/stream/:id/seg/:file', async (req, res) => {
    const id = parseId(req.params.id);
    const m = String(req.params.file || '').match(/^(\d+)\.ts$/);
    const n = m ? Number(m[1]) : NaN;
    if (!id || !Number.isInteger(n) || n < 0) return res.status(400).end();
    const row = db.getById(id);
    if (!row) return res.status(404).end();

    let result;
    try {
      result = await service.segmentFor(row, n, clientToken(req));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    // Segments are immutable for a given media id + index version (the version
    // rides along in the playlist URI), so the browser may keep one — except in
    // vault mode, where a decrypted copy must never sit in its disk cache.
    // Vault itself keeps nothing: the buffer is dropped as the player moves on.
    res.set('Content-Type', 'video/mp2t');
    res.set('Cache-Control', secureAssets.enabled() ? 'no-store' : 'max-age=3600');
    res.end(result.seg.buffer);
  });

  // The player's teardown beacon. Best effort only: a crashed tab sends
  // nothing, which is why the session also ends itself after an idle minute.
  //
  // One tab closing must not take the file away from another tab still playing
  // it, so the beacon only retires the closing client's window; the producer and
  // the buffers go when the last one leaves.
  //
  // "The last one leaves" means a token the ring actually knew about leaving. A
  // beacon with an unknown token reports "nobody left" too: a stray request, a
  // ring that no longer exists, or a client already pruned after CLIENT_TTL_MS
  // of quiet, which is what a paused player with a full buffer looks like.
  // Ending the session on that would tear down a producer somebody else is
  // still reading, so teardown needs both halves: the token was a known client,
  // and it was the last one. Everything else is a no-op, and the idle sweeper
  // stays the guarantee for sessions that really were abandoned.
  router.post('/stream/:id/close', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).end();
    res.status(204).end();
    try {
      const left = ring.dropClient(id, clientToken(req));
      if (!left.removed || left.remaining > 0) return;
      await session.end(id);
    } catch { /* the idle sweeper is the backstop */ }
  });

  return router;
}

module.exports = { buildRouter, backfillJob, streamIndex };
