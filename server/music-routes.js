/**
 * Music ID routes (/api/music/*) — fingerprinting, song links, stack-mix
 * presets and exports. Everything is user-initiated; nothing fingerprints
 * automatically. See lib/musicid/* for the pipeline.
 */

const express = require('express');
const fs = require('fs');
const db = require('../lib/database');
const repo = require('../lib/musicid/repo');
const service = require('../lib/musicid/service');
const exporter = require('../lib/musicid/exporter');
const seedpack = require('../lib/musicid/seedpack');
const { checkTools } = require('../lib/musicid/fingerprint');
const { ROOT } = require('../lib/approot');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseIdList(body) {
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number) : [];
  return ids.filter(id => Number.isInteger(id) && id > 0);
}

function buildRouter() {
  const router = express.Router();

  // Exports stuck pending/running from a previous process can never finish —
  // their in-memory buffers died with it. Skipped when the vault boots locked
  // (server start re-runs it on unlock), same as pmv-routes.
  try { exporter.failStaleExports(); } catch (err) { if (err.code !== 'DB_ENCRYPTED' && err.code !== 'VAULT_NO_CIPHER') throw err; }

  // ── Status: tool availability + library-wide counts ─────────────────────
  let toolsCache = null;
  router.get('/status', async (req, res) => {
    if (!toolsCache || req.query.recheck) toolsCache = await checkTools();
    res.json({ tools: toolsCache, stats: repo.getStats(), queue: service.getQueueState() });
  });

  // ── Fingerprint queue ────────────────────────────────────────────────────
  router.post('/fingerprint', (req, res) => {
    const ids = parseIdList(req.body);
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const result = service.enqueueFingerprint(ids, { force: !!req.body?.force });
    res.json({ ...result, queue: service.getQueueState() });
  });

  router.get('/queue', (req, res) => {
    res.json(service.getQueueState());
  });

  // ── Per-media music info (player sidebar) ────────────────────────────────
  router.get('/media/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const chunks = repo.getMediaFingerprints(id).length;
    res.json({
      media_id: id,
      fingerprinted: chunks > 0,
      chunks,
      songs: repo.songsForMedia(id),
    });
  });

  // Chunk-level section view (Section Identifier modal)
  router.get('/media/:id/sections', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const data = service.getSections(id);
    if (!data) return res.status(404).json({ error: 'media not found' });
    res.json(data);
  });

  // Tag a section: manual link + instant chunk-copy references + propagate
  router.post('/media/:id/tag-section', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      res.json(await service.tagSection(id, req.body || {}));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Re-run matching for one file (no re-fingerprint)
  router.post('/media/:id/scan', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    if (!repo.mediaHasFingerprints(id)) {
      return res.status(409).json({ error: 'not fingerprinted yet' });
    }
    const found = service.scanMedia(id);
    res.json({ found, songs: repo.songsForMedia(id) });
  });

  // Remove a file's fingerprints (+ its auto links; manual tags survive)
  router.delete('/media/:id/fingerprints', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    repo.deleteMediaFingerprints(id, { removeAutoLinks: req.query.keepLinks !== '1' });
    res.json({ ok: true, songs: repo.songsForMedia(id) });
  });

  // ── Songs ────────────────────────────────────────────────────────────────
  router.get('/songs', (req, res) => {
    res.json(repo.listSongs({
      q: (req.query.q || '').toString(),
      sort: (req.query.sort || 'usage_desc').toString(),
      source: req.query.source ? req.query.source.toString() : null,
    }));
  });

  router.post('/songs', (req, res) => {
    const { title, artist } = req.body || {};
    if (!title || !artist) return res.status(400).json({ error: 'title + artist required' });
    const id = repo.findOrCreateSong(req.body);
    res.json({ id, song: repo.getSong(id) });
  });

  router.get('/songs/:id', (req, res) => {
    const id = parseId(req.params.id);
    const song = id && repo.getSong(id);
    if (!song) return res.status(404).json({ error: 'not found' });
    res.json(song);
  });

  router.patch('/songs/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    const body = { ...req.body };
    // Renaming an "Unknown Song" placeholder identifies it — flip the source
    if (body.source == null && body.title && !body.title.startsWith('Unknown Song ')) {
      body.source = 'manual';
    }
    repo.updateSong(id, body);
    res.json(repo.getSong(id));
  });

  router.delete('/songs/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    repo.deleteSong(id);
    res.json({ ok: true });
  });

  // Media files containing a song (song page / stack launcher)
  router.get('/songs/:id/links', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    res.json(repo.mediaForSong(id));
  });

  // ── Links (media_songs) ──────────────────────────────────────────────────
  router.get('/links-map', (req, res) => {
    res.json(repo.linksMap());
  });

  router.post('/links', (req, res) => {
    const { media_id, song_id } = req.body || {};
    if (!parseId(media_id) || !parseId(song_id)) {
      return res.status(400).json({ error: 'media_id + song_id required' });
    }
    const id = repo.linkSongToMedia(req.body);
    res.json({ id });
  });

  router.patch('/links/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    repo.updateLink(id, req.body || {});
    res.json({ ok: true, link: repo.getLink(id) });
  });

  router.delete('/links/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    repo.unlinkSong(id);
    res.json({ ok: true });
  });

  // Manual tag → reference fingerprint → find the song in every other
  // fingerprinted file. Slow-ish (one ffmpeg trim + fpcalc) — client shows a spinner.
  router.post('/links/:id/reference', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    try {
      const result = await service.buildReferenceAndPropagate(id);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── Song picker suggestions: existing songs + seed corpus ────────────────
  // Existing songs come first (🔗 when they have reference fingerprints);
  // seed entries (names only, no audio yet) fill out the rest. The seed
  // corpus auto-imports from SAMPLES/seed.json (or ./seed.json) on first use.
  let seedImportTried = false;
  router.get('/song-suggest', (req, res) => {
    if (!seedImportTried && repo.seedCount() === 0) {
      seedImportTried = true;
      const path = require('path');
      for (const p of [
        path.join(ROOT, 'SAMPLES', 'seed.json'),
        path.join(ROOT, 'seed.json'),
      ]) {
        const r = repo.importSeedFile(p);
        if (r) { console.log(`  Music ID: imported ${r.imported} seed entries from ${p}`); break; }
      }
    }

    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(30, Number(req.query.limit) || 12);

    const songs = repo.listSongs({ q, sort: 'usage_desc' }).slice(0, limit).map(s => ({
      kind: 'song',
      song_id: s.id,
      artist: s.artist,
      title: s.title,
      remix_label: s.remix_label || '',
      media_count: s.media_count,
      fingerprinted: s.ref_count > 0,
      unknown: s.source === 'auto-cluster',
    }));

    const have = new Set(songs.map(s => `${s.artist.toLowerCase()}|${s.title.toLowerCase()}`));
    const seed = repo.searchSeed(q, limit)
      .filter(e => !have.has(`${e.artist.toLowerCase()}|${e.title.toLowerCase()}`))
      .slice(0, Math.max(0, limit - songs.length) + 4)
      .map(e => ({ kind: 'seed', artist: e.artist, title: e.title, usage_rank: e.usage_rank }));

    res.json([...songs, ...seed].slice(0, limit + 4));
  });

  // ── Custom mixes (library-resident, played through the Editor) ───────────
  router.post('/mixes', (req, res) => {
    const { title, description, song_id, media_ids, config } = req.body || {};
    const ids = Array.isArray(media_ids) ? media_ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
    if (ids.length < 2) return res.status(400).json({ error: 'media_ids required (2+)' });
    for (const id of ids) {
      if (!db.getById(id)) return res.status(400).json({ error: `media ${id} not found` });
    }
    const media_id = repo.createCustomMix({
      title: String(title).trim(),
      description: (description || '').toString(),
      song_id: song_id ? parseId(song_id) : null,
      media_ids: ids,
      config: config || {},
    });
    res.json({ media_id, row: db.getById(media_id) });
  });

  router.get('/mixes/:mediaId', (req, res) => {
    const id = parseId(req.params.mediaId);
    const mix = id && repo.getCustomMix(id);
    if (!mix) return res.status(404).json({ error: 'not found' });
    res.json({ ...mix, row: db.getById(id) });
  });

  router.patch('/mixes/:mediaId', (req, res) => {
    const id = parseId(req.params.mediaId);
    if (!id || !repo.getCustomMix(id)) return res.status(404).json({ error: 'not found' });
    const row = repo.updateCustomMix(id, req.body || {});
    res.json(row);
  });

  // ── Stack alignment helper ───────────────────────────────────────────────
  // Given media ids, find a song common to ALL of them (if any) so the editor
  // can auto-align the stack on it. Falls back to per-file starts of 0.
  //
  // ?song=<id> pins the song instead of auto-picking (editor "Stack on this
  // song" buttons). Link start_secs sit on the 15s chunk grid — good for
  // "these share a song", bad for sync — so each non-anchor track is REFINED
  // to ~0.12s via fingerprint fine alignment against the first (anchor) file;
  // aligned:true marks tracks whose start came from the fine pass.
  router.get('/stack-align', (req, res) => {
    const ids = (req.query.ids || '').toString().split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (ids.length < 2) return res.status(400).json({ error: 'need 2+ ids' });
    const pinnedSong = req.query.song ? parseId(req.query.song) : null;

    const perMedia = ids.map(id => ({ id, links: repo.songsForMedia(id) }));
    // Candidate songs = intersection across all files
    const counts = new Map();
    for (const { links } of perMedia) {
      for (const sid of new Set(links.map(l => l.song_id))) {
        counts.set(sid, (counts.get(sid) || 0) + 1);
      }
    }
    const common = [...counts.entries()].filter(([, n]) => n === ids.length).map(([sid]) => sid);
    if (!common.length) return res.json({ song: null, tracks: null });

    let song = null;
    if (pinnedSong && common.includes(pinnedSong)) song = repo.getSong(pinnedSong);
    if (!song) {
      // Prefer identified songs over placeholders, then most-linked overall
      const songs = common.map(sid => repo.getSong(sid)).filter(Boolean)
        .sort((a, b) => (a.source === 'auto-cluster' ? 1 : 0) - (b.source === 'auto-cluster' ? 1 : 0));
      song = songs[0];
    }
    // start_sec here is FINAL for the client (legacy offset_sec folded in —
    // nothing writes that column anymore; sync nudges PATCH start_sec).
    const tracks = ids.map(id => {
      const link = perMedia.find(p => p.id === id).links.find(l => l.song_id === song.id);
      return {
        media_id: id,
        link_id: link.link_id,
        start_sec: (link.start_sec ?? 0) + (link.offset_sec || 0),
        end_sec: link.end_sec,
        aligned: false,
      };
    });

    // Fine pass: anchor = first track; a confident fingerprint delta puts the
    // others at anchor − delta. Only applied when it moves the stored start by
    // MORE than 1.5s — fixing chunk-grid error without fighting a saved
    // sub-second hand nudge (which is finer than the grid could ever produce).
    const anchor = tracks[0];
    for (let i = 1; i < tracks.length; i++) {
      try {
        const r = service.fineAlignPair(anchor.media_id, tracks[i].media_id);
        if (r && r.pairs >= 1) {
          const refined = anchor.start_sec - r.delta_sec;
          if (Math.abs(refined - tracks[i].start_sec) > 1.5) {
            tracks[i].start_sec = refined;
            tracks[i].aligned = true;
            tracks[i].align_ber = Math.round(r.ber * 1000) / 1000;
            tracks[i].align_pairs = r.pairs;
          }
        }
      } catch { /* fine alignment is best-effort — chunk-grid start stands */ }
    }
    res.json({ song, tracks });
  });

  // Fine alignment between two files (editor ⚡ auto-align button).
  // → { delta_sec, pairs, ber }: play A at t ⇒ B belongs at t − delta_sec.
  router.get('/fine-align', (req, res) => {
    const a = parseId(req.query.a), b = parseId(req.query.b);
    if (!a || !b || a === b) return res.status(400).json({ error: 'need distinct a & b media ids' });
    const r = service.fineAlignPair(a, b);
    if (!r) return res.status(404).json({ error: 'no shared audio found — fingerprint both files first' });
    res.json(r);
  });

  // ── Mix presets ──────────────────────────────────────────────────────────
  router.get('/presets', (req, res) => {
    const songId = req.query.song_id ? parseId(req.query.song_id) : null;
    res.json(repo.listPresets(songId));
  });

  router.post('/presets', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = repo.savePreset({
      song_id: req.body?.song_id ? parseId(req.body.song_id) : null,
      name,
      media_ids: JSON.stringify(req.body?.media_ids || []),
      config_json: JSON.stringify(req.body?.config || {}),
    });
    res.json({ id });
  });

  router.get('/presets/:id', (req, res) => {
    const id = parseId(req.params.id);
    const p = id && repo.getPreset(id);
    if (!p) return res.status(404).json({ error: 'not found' });
    res.json(p);
  });

  router.delete('/presets/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    repo.deletePreset(id);
    res.json({ ok: true });
  });

  // ── Seed packs: song fingerprints WITHOUT the audio files ────────────────
  // Export the user's own reference fingerprints as a portable pack (also how
  // hosted packs get authored — fingerprint MP3s locally, export, publish).
  router.get('/seedpack/export', (req, res) => {
    const pack = seedpack.exportSeedPack({
      name: String(req.query.name || ''),
      includeUnknown: req.query.unknown === '1',
    });
    const stamp = new Date().toISOString().slice(0, 10);
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/json');
    res.set('Content-Disposition', `attachment; filename="vault-songseed-${stamp}.json"`);
    res.send(JSON.stringify(pack));
  });

  // Import a pack the user picked themselves (strictly pull — the server
  // never fetches packs). Raw body: packs with fingerprints outgrow the
  // global 2 MB JSON limit fast. After the upsert, every fingerprinted file
  // is re-scanned against ONLY the new references, in the background.
  router.post('/seedpack/import',
    express.raw({ type: () => true, limit: '200mb' }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'empty upload' });
      }
      let pack;
      try { pack = JSON.parse(req.body.toString('utf8')); }
      catch { return res.status(400).json({ error: 'not valid JSON' }); }
      let result;
      try { result = seedpack.importSeedPack(pack); }
      catch (err) {
        return res.status(err.code?.startsWith('SEED_') ? 400 : 500).json({ error: err.message });
      }
      const rescanning = seedpack.startRematch(result.new_ref_ids);
      res.json({ ...result, new_ref_ids: undefined, rescan_files: rescanning });
    });

  router.get('/seedpack/rematch-status', (req, res) => {
    res.json(seedpack.getRematchState());
  });

  // ── Exports ──────────────────────────────────────────────────────────────
  router.get('/exports', (req, res) => {
    res.json(exporter.listExports({ limit: 50 }));
  });

  // Beatbar overlay strip for an upcoming export: raw PNG frame stream,
  // parked in RAM under a short-lived token (never written to disk here).
  router.post('/exports/overlay',
    express.raw({ type: () => true, limit: '512mb' }),
    (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: 'empty overlay upload' });
      }
      res.json(exporter.putOverlay(req.body));
    });

  router.post('/exports', (req, res) => {
    const body = req.body || {};
    const tracksIn = Array.isArray(body.tracks) ? body.tracks : [];
    const width = Number(body.width) || 1280;
    const height = Number(body.height) || 720;
    const durationSec = Number(body.duration_sec);

    if (tracksIn.length < 1) return res.status(400).json({ error: 'tracks required' });
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return res.status(400).json({ error: 'invalid duration' });
    }
    if (width < 64 || height < 64) return res.status(400).json({ error: 'invalid dimensions' });

    // Optional beatbar bake — geometry must land inside the output frame
    let beatbar = null;
    if (body.beatbar) {
      const b = body.beatbar;
      const x = Math.round(Number(b.x)), y = Math.round(Number(b.y));
      const w = Math.round(Number(b.w)), h = Math.round(Number(b.h));
      const fps = Math.round(Number(b.fps));
      if (typeof b.overlay_token !== 'string' || !b.overlay_token) {
        return res.status(400).json({ error: 'beatbar.overlay_token required' });
      }
      if (![x, y, w, h, fps].every(Number.isFinite) ||
          w < 1 || h < 1 || x < 0 || y < 0 || x + w > width || y + h > height ||
          fps < 5 || fps > 60) {
        return res.status(400).json({ error: 'invalid beatbar geometry' });
      }
      beatbar = { overlay_token: b.overlay_token, x, y, w, h, fps };
    }

    const tracks = [];
    for (const t of tracksIn) {
      const mid = parseId(t.media_id);
      const row = mid && db.getById(mid);
      if (!row) return res.status(400).json({ error: `media ${t.media_id} not found` });
      if (!fs.existsSync(row.filepath)) return res.status(400).json({ error: `${row.filename} missing on disk` });
      tracks.push({
        mediaPath: row.filepath,
        seek: Math.max(0, Number(t.seek) || 0),
        volume: Math.max(0, Math.min(2, Number(t.volume) || 0)),
        effect: t.effect || { type: 'uniform', opacity: 1 },
      });
    }

    let job;
    try {
      job = exporter.enqueueExport({
        song_id: body.song_id ? parseId(body.song_id) : null,
        filename: String(body.filename || ''),
        tracks, width, height, durationSec, beatbar,
      });
    } catch (err) {
      return res.status(err.code === 'OVERLAY_MISSING' ? 400 : 500).json({ error: err.message });
    }
    res.json(job);
  });

  router.get('/exports/:id', (req, res) => {
    const id = parseId(req.params.id);
    const e = id && exporter.getExport(id);
    if (!e) return res.status(404).json({ error: 'not found' });
    res.json(e);
  });

  router.delete('/exports/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'bad id' });
    exporter.deleteExport(id);
    res.json({ ok: true });
  });

  router.get('/exports/:id/download', (req, res) => {
    const id = parseId(req.params.id);
    const e = id && exporter.getExport(id);
    if (!e || e.status !== 'done') return res.status(404).json({ error: 'not ready' });

    // The finished MP4 lives in RAM only — this download is the one moment
    // bytes reach disk, and the user picks where. no-store: never leave a
    // copy in the browser's disk cache (matches /thumb, /scrub, PMV previews).
    const buf = exporter.getExportBuffer(id);
    if (buf) {
      const name = String(e.filename || 'mix.mp4').replace(/[\r\n"]/g, '');
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'video/mp4');
      res.set('Content-Length', String(buf.length));
      res.set('Content-Disposition', `attachment; filename="${name}"`);
      return res.end(buf);
    }
    // Exports from before the in-memory model that still sit on disk
    if (e.output_path && fs.existsSync(e.output_path)) {
      return res.download(e.output_path, e.filename);
    }
    res.status(404).json({ error: 'expired — exports are held in memory until downloaded; render it again' });
  });

  return router;
}

module.exports = { buildRouter };
