/**
 * Subtitle routes (/api/media/:id/subtitles*, /api/subtitles/jobs/:id) —
 * SUBTITLES_SPEC §5.2. Generation runs in lib/subtitles/service.js's queue;
 * handlers return immediately so the app stays usable during Whisper work.
 */

const express = require('express');
const fs = require('fs');
const db = require('../lib/database');
const repo = require('../lib/subtitles/repo');
const service = require('../lib/subtitles/service');
const generator = require('../lib/subtitles/generator');
const translator = require('../lib/subtitles/translator');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function buildRouter() {
  const router = express.Router();

  // Boot-time DB write — skipped when the vault boots locked (server start
  // re-runs it after the first unlock). DB_ENCRYPTED (locked) and
  // VAULT_NO_CIPHER (misconfigured) both defer to server start()'s handling.
  try { repo.failStaleJobs(); } catch (err) { if (err.code !== 'DB_ENCRYPTED' && err.code !== 'VAULT_NO_CIPHER') throw err; }

  // What tracks does this item have? (player toggle resolution)
  router.get('/media/:id/subtitles/info', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    res.json(service.infoFor(id));
  });

  // The cue file: VTT native, ?format=srt derives on the fly
  router.get('/media/:id/subtitles', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const lang = String(req.query.lang || 'en');
    const track = repo.getTrack(id, lang);
    if (!track) return res.status(404).json({ error: 'no such track' });

    // readTrackText serves from the encrypted store in vault mode (materializing
    // the working copy when needed), or reads the on-disk VTT otherwise.
    const vtt = repo.readTrackText(id, lang);
    if (vtt == null) return res.status(404).json({ error: 'no such track' });
    if (String(req.query.format) === 'srt') {
      const row = db.getById(id);
      const base = (row?.filename || `media_${id}`).replace(/\.[^.]+$/, '');
      res.set('Content-Type', 'application/x-subrip');
      res.set('Content-Disposition', `attachment; filename="${base}.${lang}.srt"`);
      return res.send(generator.toSRT(generator.parseVTT(vtt)));
    }
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.send(vtt);
  });

  // Queue generation (idempotent — an active job for the item is reused).
  // { fresh: true } wipes existing tracks first (sidebar "Rescan all"), so a
  // re-run re-detects language/speakers from scratch instead of overwriting.
  // Generation/transcription is paid; viewing, editing, downloading and
  // deleting EXISTING tracks stays free (the data belongs to the user).
  /* Can this machine transcribe at all? Unlike ffmpeg and fpcalc there's no
     single binary to drop next to the exe — it needs a Python interpreter plus
     a pip package — so the UI explains it instead of offering a download. */
  router.get('/subtitles/preflight', (req, res) => {
    res.json(require('../lib/video-transcriber').checkTranscriber());
  });

  router.post('/media/:id/subtitles/generate', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });

    /* Refuse up front rather than queueing a job that can only fail. Before
       this the request was accepted, the job died inside the sidecar, and the
       only trace was a status the UI never surfaced — the user saw nothing at
       all. 412 + a machine-readable code so every caller can show the same
       explainer instead of inventing its own wording. */
    const tr = require('../lib/video-transcriber').checkTranscriber();
    if (!tr.ok) {
      return res.status(412).json({
        error: tr.python
          ? 'faster-whisper is not installed for the Python Vault is using'
          : 'Python was not found',
        code: 'WHISPER_MISSING',
        ...tr,
      });
    }

    /* The model itself is a ~1.5 GB fetch from HuggingFace the first time.
       Ask before it happens rather than announcing it mid-download — asked
       once, then remembered. If the model is already on disk nothing is
       downloaded and the answer simply never comes up again. */
    const consent = require('../lib/model-consent');
    const whisperModel = process.env.WHISPER_MODEL || require('../config').subtitles.model || 'large-v3-turbo';
    const whisperKey = `whisper:${whisperModel}`;
    if (!consent.isAllowed(whisperKey)) {
      return res.status(412).json({
        error: consent.ENV_ALLOWS
          ? 'Vault needs permission to download the transcription model'
          : 'Model downloads are turned off (SUB_ALLOW_DOWNLOADS=0 / VAULT_OFFLINE=1)',
        code: consent.ENV_ALLOWS ? 'MODEL_DOWNLOAD_CONSENT' : 'DOWNLOADS_OFF_BY_ENV',
        ...consent.describe(whisperKey),
        key: whisperKey,
      });
    }
    const row = db.getById(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!['video', 'audio'].includes(row.media_type)) {
      return res.status(400).json({ error: `subtitles need audio/video (got ${row.media_type})` });
    }
    if (!fs.existsSync(row.filepath)) return res.status(409).json({ error: 'file missing on disk' });

    if (req.body?.fresh) {
      if (service.isActive(id)) return res.status(409).json({ error: 'already generating' });
      for (const t of repo.listTracks(id)) repo.deleteTrack(id, t.lang);
    }

    // Optional forced spoken language (rescan modal) — whisper skips
    // auto-detect. ISO-639-ish codes only; anything else is rejected rather
    // than passed to the sidecar.
    let language = null;
    if (req.body?.lang) {
      language = String(req.body.lang).toLowerCase().trim();
      if (!/^[a-z]{2,3}$/.test(language)) return res.status(400).json({ error: 'bad lang code' });
    }

    const job = service.enqueue(id, { language });
    res.json({ jobId: job.id, status: job.status });
  });

  // Save an edited VTT (sidebar editor). Body: { vtt }. Preserves the track's
  // kind; refreshes the plain transcript when the original track is edited.
  router.put('/media/:id/subtitles', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const lang = String(req.query.lang || '');
    if (!lang) return res.status(400).json({ error: 'lang required' });
    const existing = repo.getTrack(id, lang);
    if (!existing) return res.status(404).json({ error: 'no such track' });

    let vtt = typeof req.body?.vtt === 'string' ? req.body.vtt : '';
    if (!/^﻿?WEBVTT/.test(vtt)) vtt = 'WEBVTT\n\n' + vtt;   // tolerate a header-less paste
    const cues = generator.parseVTT(vtt);
    if (!cues.length) return res.status(400).json({ error: 'no valid cues found. Check the timestamps' });

    repo.putTrack(id, lang, existing.kind, vtt);
    if (existing.kind === 'original') {
      try {
        db.get().prepare('UPDATE media SET audio_transcription = ? WHERE id = ?')
          .run(generator.toPlainText(cues), id);
      } catch { /* non-fatal */ }
    }
    if (lang === 'en') service.refreshEnglishSearchText(id);   // keep the search index in sync
    res.json({ ok: true, cues: cues.length });
  });

  router.get('/subtitles/jobs/:id', (req, res) => {
    const job = repo.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  });

  // "Fix here" — re-scan ±window seconds around a timestamp, merge into tracks
  router.post('/media/:id/subtitles/patch', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const row = db.getById(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (service.isActive(id)) return res.status(409).json({ error: 'subtitles still generating. Try again shortly' });
    const at = Number(req.body?.at);
    if (!Number.isFinite(at) || at < 0) return res.status(400).json({ error: 'at (seconds) required' });
    const window = Math.min(300, Math.max(10, Number(req.body?.window) || 60));
    try {
      res.json(await service.patchWindow(row, at, window));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/media/:id/subtitles', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const lang = String(req.query.lang || '');
    if (!lang) return res.status(400).json({ error: 'lang required' });
    repo.deleteTrack(id, lang);
    if (lang === 'en') service.refreshEnglishSearchText(id);   // clears the search index
    res.json({ ok: true });
  });

  /* ── Language-pack manager (translation models) ── */

  router.get('/subtitles/langs', (req, res) => {
    res.json({ installed: translator.listInstalled(), dir: translator.OPUS_MODEL_DIR });
  });

  // Pre-fetch a pack (auto-fetch also happens on first translate). Blocks for
  // the download/convert — the client should show a spinner.
  router.post('/subtitles/langs/:lang', async (req, res) => {
    const lang = String(req.params.lang || '').replace(/[^a-z_]/gi, '');
    if (!lang) return res.status(400).json({ error: 'bad lang' });
    if (translator.isProvisioned(lang)) return res.json({ ok: true, already: true });
    try {
      await translator.provision(lang, () => {});
      translator.shutdownSidecar();
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message.split('\n')[0] });
    }
  });

  router.delete('/subtitles/langs/:lang', (req, res) => {
    const lang = String(req.params.lang || '').replace(/[^a-z_]/gi, '');
    res.json({ ok: translator.removePack(lang) });
  });

  return router;
}

module.exports = { buildRouter };
