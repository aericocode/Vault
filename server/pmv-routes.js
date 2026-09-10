/**
 * PMV Studio routes (/api/pmv/*) — jobs, EDL review, render, previews,
 * recipes, library import. Heavy work runs in lib/pmv/service.js's queue;
 * these handlers return immediately so the rest of the app stays usable
 * while a job analyzes/renders.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../lib/database');
const repo = require('../lib/pmv/repo');
const service = require('../lib/pmv/service');
const gpuDetect = require('../lib/pmv/gpu-detect');
const vlTagger = require('../lib/pmv/vl-tagger');
const secureAssets = require('../lib/secure-assets');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function buildRouter() {
  const router = express.Router();

  // Jobs left running by a previous process can never finish — mark them.
  // Skipped when the vault boots locked (server start re-runs it on unlock).
  // DB_ENCRYPTED (locked) and VAULT_NO_CIPHER (misconfigured) both defer to
  // server start()'s own handling — bootLocked / hard-fail banner respectively.
  try { repo.failStaleJobs(); } catch (err) { if (err.code !== 'DB_ENCRYPTED' && err.code !== 'VAULT_NO_CIPHER') throw err; }

  router.get('/status', async (req, res) => {
    const gpu = await gpuDetect.detectGPU();
    const vl = await vlTagger.checkVLAvailability();
    res.json({ gpu: { label: gpu.label, hint: gpu.hint || null }, vl });
  });

  /* ── Jobs ── */

  router.get('/jobs', (req, res) => {
    res.json(repo.listJobs({ limit: 20 }).map(service.decorateJob));
  });

  router.post('/jobs', (req, res) => {
    const videoIds = (req.body?.video_ids || []).map(parseId).filter(Boolean);
    const audioIds = (req.body?.audio_ids || []).map(parseId).filter(Boolean);
    if (videoIds.length < 1) return res.status(400).json({ error: 'at least one source video required' });
    if (audioIds.length < 1) return res.status(400).json({ error: 'a soundtrack file is required' });

    for (const id of videoIds) {
      const row = db.getById(id);
      if (!row) return res.status(404).json({ error: `media ${id} not found` });
      if (row.media_type !== 'video') return res.status(400).json({ error: `media ${id} is not a video` });
      if (!fs.existsSync(row.filepath)) return res.status(409).json({ error: `${row.filename} missing on disk` });
    }
    for (const id of audioIds) {
      const row = db.getById(id);
      if (!row) return res.status(404).json({ error: `media ${id} not found` });
      if (!['audio', 'video'].includes(row.media_type)) {
        return res.status(400).json({ error: `soundtrack must be audio or video (media ${id} is ${row.media_type})` });
      }
      if (!fs.existsSync(row.filepath)) return res.status(409).json({ error: `${row.filename} missing on disk` });
    }

    const job = repo.createJob({
      video_ids: videoIds,
      audio_ids: audioIds,
      options: req.body?.options || {},
    });
    service.enqueue(job.id);
    res.json({ jobId: job.id });
  });

  router.get('/jobs/:id', (req, res) => {
    const job = repo.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(service.decorateJob(job));
  });

  // Replace EDL entries (review edits: remove/swap). Only cut fields accepted.
  router.put('/jobs/:id/edl', (req, res) => {
    const job = repo.getJob(req.params.id);
    if (!job?.edl) return res.status(400).json({ error: 'EDL not ready' });
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries must be a non-empty array' });
    repo.updateJob(job.id, { edl: { ...job.edl, entries } });
    res.json({ ok: true, totalEdits: entries.length });
  });

  router.post('/jobs/:id/render', (req, res) => {
    const job = repo.getJob(req.params.id);
    if (!job?.edl) return res.status(400).json({ error: 'EDL not ready' });
    if (service.isActive(job.id)) return res.status(409).json({ error: 'job is still processing' });
    service.enqueueRender(job.id);
    res.json({ ok: true });
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    const ok = service.cancelJob(req.params.id);
    res.json({ ok });
  });

  router.post('/jobs/:id/import', (req, res) => {
    const result = service.importToLibrary(req.params.id);
    if (result.error) return res.status(409).json(result);
    res.json(result);
  });

  router.delete('/jobs/:id', async (req, res) => {
    if (!repo.isValidJobId(req.params.id)) return res.status(400).json({ error: 'invalid job id' });
    if (service.isActive(req.params.id)) service.cancelJob(req.params.id);
    await service.deleteJobArtifacts(req.params.id);
    res.json({ ok: true });
  });

  /* ── Preview stills + rendered output ── */

  router.get('/previews/:jobId/:file', (req, res) => {
    const jobId = path.basename(String(req.params.jobId));
    const file = path.basename(String(req.params.file));
    if (!repo.isValidJobId(jobId)) return res.status(400).end();
    const m = /^p_(\d+)\.jpg$/.exec(file);
    if (!m) return res.status(400).end();

    // no-store in ALL modes: never leave a decrypted preview in the browser's
    // disk cache (matches /thumb and /scrub).
    res.set('Cache-Control', 'no-store');

    // Vault mode: bytes live encrypted in secure_assets.db, keyed by (jobId,idx).
    if (secureAssets.enabled()) {
      const buf = secureAssets.getPmvPreview(jobId, Number(m[1]));
      if (!buf) return res.status(404).end();
      res.set('Content-Type', 'image/jpeg');
      return res.end(buf);
    }

    const p = path.join(service.PREVIEWS_DIR, jobId, file);
    if (!fs.existsSync(p)) return res.status(404).end();
    res.sendFile(p);
  });

  // Stream the rendered mp4 (review player before Add to library). Fresh
  // renders live in RAM only — served with Range support so the player can
  // seek; no-store so the browser's disk cache never keeps a decrypted copy.
  function sendBufferVideo(req, res, buf) {
    res.set('Cache-Control', 'no-store');
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', 'video/mp4');
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : Math.max(0, buf.length - parseInt(m[2], 10));
      const end = (m[1] && m[2]) ? Math.min(parseInt(m[2], 10), buf.length - 1) : buf.length - 1;
      if (!(start >= 0) || start > end || start >= buf.length) {
        return res.status(416).set('Content-Range', `bytes */${buf.length}`).end();
      }
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${buf.length}`);
      res.set('Content-Length', String(end - start + 1));
      return res.end(buf.subarray(start, end + 1));
    }
    res.set('Content-Length', String(buf.length));
    res.end(buf);
  }

  router.get('/jobs/:id/output', (req, res) => {
    const job = repo.getJob(req.params.id);
    if (!job) return res.status(404).end();
    const buf = service.getOutput(job.id);
    if (buf) return sendBufferVideo(req, res, buf);
    // imported or legacy pre-memory render — the file on disk
    const out = job.result?.outputPath;
    if (!out || !fs.existsSync(out)) return res.status(404).end();
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.resolve(out));
  });

  // Explicit save: attachment download of the RAM-held render (or the
  // imported/legacy file). This is the user's "export" moment.
  router.get('/jobs/:id/download', (req, res) => {
    const job = repo.getJob(req.params.id);
    if (!job || job.status !== 'complete') return res.status(404).json({ error: 'not ready' });
    const name = String(job.result?.filename || 'pmv.mp4').replace(/[\r\n"]/g, '');
    const buf = service.getOutput(job.id);
    res.set('Cache-Control', 'no-store');
    if (buf) {
      res.set('Content-Type', 'video/mp4');
      res.set('Content-Length', String(buf.length));
      res.set('Content-Disposition', `attachment; filename="${name}"`);
      return res.end(buf);
    }
    const out = job.result?.outputPath;
    if (out && fs.existsSync(out)) return res.download(out, name);
    res.status(404).json({ error: 'expired. Renders are held in memory until saved, re-render it' });
  });

  /* ── Recipes ── */

  router.get('/recipes', (req, res) => {
    res.json(repo.listRecipes());
  });

  router.post('/recipes', (req, res) => {
    const { name, media_ids, config, song_id } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if (!Array.isArray(media_ids) || !media_ids.length) return res.status(400).json({ error: 'media_ids required' });
    try {
      const recipe = repo.saveRecipe({
        name: String(name).trim().slice(0, 120),
        media_ids: media_ids.map(parseId).filter(Boolean),
        config: config || {},
        song_id: parseId(song_id) || null,
      });
      res.json({ recipe });
    } catch (err) {
      res.status(err.code === 'NAME_TAKEN' ? 409 : 500).json({ error: err.message });
    }
  });

  router.delete('/recipes/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    repo.deleteRecipe(id);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { buildRouter };
