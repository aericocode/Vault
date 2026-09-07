/**
 * Playback + HLS remux routes (REMUX_STREAMING_SPEC sections 4, 5 and 8).
 *
 *   GET  /api/playback/:id?caps=…   how should this file be played?
 *   GET  /stream/:id/index.m3u8     VOD playlist (builds the keyframe index once)
 *   GET  /stream/:id/seg/:n.ts      one MPEG-TS segment, produced on demand
 *   GET  /api/stream/cache          size / cap / encrypted
 *   POST /api/stream/cache/clear    kill producers, drop everything
 *   POST|GET /api/playback/backfill codec probe + index prebuild over the library
 *
 * The vault lock gate in server/index.js already answers 423 for /api/ and
 * /stream/ while locked, so nothing here has to re-check it.
 */

const express = require('express');
const fs = require('fs');
const db = require('../lib/database');
const service = require('../lib/stream/service');
const store = require('../lib/stream/store');
const session = require('../lib/stream/session');
const streamIndex = require('../lib/stream/index');
const { decide, DEFAULT_CAPS } = require('../lib/stream/decide');
const mediaInfo = require('../lib/media-info');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
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

          // Prebuild the keyframe index for anything a default client would
          // have to remux, so the first play does not pay for the scan.
          const fresh = db.getById(row.id);
          if (fresh && decide(fresh, new Set(DEFAULT_CAPS)).mode === 'remux') {
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

  /* ── The cache ────────────────────────────────────────────────────────── */

  router.get('/api/stream/cache', (req, res) => {
    res.json({ ...store.stats(), ...session.status(), indexBuilds: service.indexBuilds });
  });

  router.post('/api/stream/cache/clear', async (req, res) => {
    await session.stopAll();
    const result = store.clearAll();
    // A refused sweep is a real failure, not a quiet no-op: the rows are still
    // there, the segments are still on disk, and the caller has to be told.
    if (!result.ok) {
      return res.status(409).json({ ok: false, error: result.error, ...store.stats() });
    }
    res.json({ ok: true, cleared: result.cleared, ...store.stats() });
  });

  /* ── The stream ───────────────────────────────────────────────────────── */

  router.get('/stream/:id/index.m3u8', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).end();
    const row = db.getById(id);
    if (!row) return res.status(404).end();
    if (!fs.existsSync(row.filepath)) return res.status(404).end();
    try {
      const { text } = await service.playlistFor(row);
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
      result = await service.segmentFor(row, n);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    // Segments are immutable for a given media id + index version (the version
    // rides along in the playlist URI), so they may be cached — except in vault
    // mode, where a decrypted copy must never sit in the browser's disk cache.
    res.set('Content-Type', 'video/mp2t');
    res.set('Cache-Control', store.stats().encrypted ? 'no-store' : 'max-age=3600');
    if (result.seg.buffer) return res.end(result.seg.buffer);
    res.sendFile(result.seg.path, (err) => {
      if (err && !res.headersSent) res.status(err.status || 500).end();
    });
  });

  return router;
}

module.exports = { buildRouter, backfillJob, streamIndex };
