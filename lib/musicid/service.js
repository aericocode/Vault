/**
 * Music ID — background pipeline.
 *
 * fingerprint(media) → scan vs song references → cross-match vs other
 * fingerprinted media (incremental version of the samples' auto-cluster).
 *
 * Fingerprinting is ffmpeg/fpcalc-heavy, so jobs run strictly one at a time
 * in-process; the viewer polls getQueueState() for progress. Nothing here is
 * automatic — files are only fingerprinted when the user asks (selection bar,
 * sidebar button, or CLI).
 */

const database = require('../database');
const repo = require('./repo');
const fpx = require('./fingerprint');
const matcher = require('./matcher');

// Matching knobs (samples' proven defaults)
const SCAN_THRESHOLD = 0.07;        // BER vs song references
const CLUSTER_THRESHOLD = 0.10;     // BER for cross-media chunk matching (looser)
const CLUSTER_MIN_CHUNKS = 2;       // matched chunks needed to trust a cross-media hit
const CLUSTER_MIN_OVERLAP = 60;     // fp items (~7.5s) two chunks must overlap to count
const INDEX_STRIDE = 4;             // index every Nth fp int (identical spans still collide)
const MAX_KEY_FANOUT = 200;         // skip stopword ints that appear everywhere

/* ── Job queue ──────────────────────────────────────────────────────────── */

const queue = [];          // pending media ids
const jobs = new Map();    // media_id → job record (live + recent)
let active = null;         // currently running job
let historyLimit = 25;

function jobRecord(media_id, filename) {
  return {
    media_id, filename,
    state: 'queued',       // queued | fingerprinting | scanning | done | error
    progress: 0,           // 0..1 fingerprint progress
    chunks: 0, skipped_silent: 0,
    found: [],             // [{song_id, title, artist, method}] discovered by this job
    error: null,
    queued_at: Date.now(), finished_at: null,
  };
}

function pruneHistory() {
  const finished = [...jobs.values()]
    .filter(j => j.state === 'done' || j.state === 'error')
    .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0));
  for (const j of finished.slice(historyLimit)) jobs.delete(j.media_id);
}

function getQueueState() {
  return {
    active: active ? jobs.get(active) || null : null,
    queued: queue.map(id => jobs.get(id)).filter(Boolean),
    recent: [...jobs.values()]
      .filter(j => j.state === 'done' || j.state === 'error')
      .sort((a, b) => (b.finished_at || 0) - (a.finished_at || 0))
      .slice(0, 10),
  };
}

/**
 * Queue media ids for fingerprint + scan. Already-fingerprinted files are
 * skipped unless force. Returns { queued, skipped }.
 */
function enqueueFingerprint(ids, { force = false } = {}) {
  let queuedN = 0, skipped = 0;
  for (const id of ids) {
    const row = database.getById(id);
    if (!row || !['video', 'audio'].includes(row.media_type)) { skipped++; continue; }
    if (jobs.get(id)?.state === 'queued' || jobs.get(id)?.state === 'fingerprinting' || active === id) { skipped++; continue; }
    if (!force && repo.mediaHasFingerprints(id)) { skipped++; continue; }
    jobs.set(id, jobRecord(id, row.filename));
    queue.push(id);
    queuedN++;
  }
  pump();
  return { queued: queuedN, skipped };
}

function pump() {
  if (active || queue.length === 0) return;
  const id = queue.shift();
  active = id;
  runJob(id).finally(() => {
    active = null;
    pruneHistory();
    pump();
  });
}

async function runJob(media_id) {
  const job = jobs.get(media_id);
  const row = database.getById(media_id);
  if (!job) return;
  if (!row) { job.state = 'error'; job.error = 'media row missing'; job.finished_at = Date.now(); return; }

  try {
    job.state = 'fingerprinting';
    const { chunks, skippedSilent } = await fpx.fingerprintMedia(row.filepath, {
      totalDuration: row.duration_seconds || null,
      onProgress: ({ done, total }) => { job.progress = total ? done / total : 0; },
    });
    repo.saveMediaFingerprints(media_id, chunks.map(c => ({
      ...c, fingerprint: fpx.encodeFingerprint(c.fingerprint),
    })));
    job.chunks = chunks.length;
    job.skipped_silent = skippedSilent;
    job.progress = 1;

    job.state = 'scanning';
    // Audio files: label from "Artist - Title" filenames first, so the file
    // becomes a named reference other files can match against
    const labeled = await autoLabelFromFilename(media_id);
    if (labeled) {
      job.found.push({ song_id: labeled.song_id, title: labeled.title, artist: labeled.artist, method: 'filename' });
    }
    const found = scanMedia(media_id);
    job.found.push(...found);
    job.state = 'done';
  } catch (e) {
    job.state = 'error';
    job.error = e.message;
  } finally {
    job.finished_at = Date.now();
  }
}

/* ── Scan: chunks vs song references, then cross-media cluster ──────────── */

/**
 * Match one media file's stored chunks against everything we know.
 * Synchronous CPU work (XOR+popcount) — fast even for hundreds of chunks.
 * Returns [{song_id, title, artist, method}] newly linked.
 */
function scanMedia(media_id, { threshold = SCAN_THRESHOLD } = {}) {
  const found = [];
  found.push(...scanAgainstReferences(media_id, { threshold }));
  found.push(...crossMatch(media_id));
  return found;
}

/**
 * Per-chunk best match for one media file vs song references. Shared by
 * scanAgainstReferences (spans → links) and the Section Identifier (raw
 * per-chunk view). Returns null when the file isn't fingerprinted.
 */
function matchChunksForMedia(media_id, { threshold = SCAN_THRESHOLD, onlyRefIds = null } = {}) {
  const fps = repo.getMediaFingerprints(media_id);
  if (!fps.length) return null;

  let refsRaw = repo.listSongFingerprints();
  if (onlyRefIds) refsRaw = refsRaw.filter(r => onlyRefIds.includes(r.id));
  if (!refsRaw.length) {
    // No references yet — still a valid (all-unmatched) chunk view
    return fps.map(f => ({ id: f.id, start_sec: f.start_sec, end_sec: f.end_sec, match: null }));
  }

  const references = refsRaw.map(r => ({
    id: r.id, song_id: r.song_id,
    fingerprint: fpx.decodeFingerprint(r.fingerprint),
  }));
  return fps.map(f => ({
    id: f.id, start_sec: f.start_sec, end_sec: f.end_sec,
    match: matcher.matchChunkAgainstReferences(fpx.decodeFingerprint(f.fingerprint), references, threshold),
  }));
}

function scanAgainstReferences(media_id, { threshold = SCAN_THRESHOLD, onlyRefIds = null } = {}) {
  const chunkResults = matchChunksForMedia(media_id, { threshold, onlyRefIds });
  if (!chunkResults) return [];

  const spans = matcher.groupMatches(chunkResults, { maxGapChunks: 1 });
  const existing = new Set(repo.songsForMedia(media_id).map(l => l.song_id));
  const found = [];
  for (const s of spans) {
    if (existing.has(s.song_id)) continue;
    repo.linkSongToMedia({
      media_id,
      song_id: s.song_id,
      start_sec: s.start_sec,
      end_sec: s.end_sec,
      confidence: 1 - s.mean_ber,
      method: 'auto-fp',
    });
    existing.add(s.song_id);
    const song = repo.getSong(s.song_id);
    found.push({ song_id: s.song_id, title: song?.title, artist: song?.artist, method: 'auto-fp' });
  }
  return found;
}

/**
 * Inverted index over raw fingerprint ints (the AcoustID trick): identical
 * audio produces identical int sequences regardless of where it sits in each
 * file, so ONE shared int is enough to nominate a chunk pair — the full BER
 * alignment scan then confirms or rejects it. This replaces the samples'
 * fixed-position LSH buckets, which only collided when two files' chunk
 * grids happened to align.
 */
function buildChunkIndex(chunks) {
  const index = new Map(); // int32 → array of chunk indices (capped)
  for (let i = 0; i < chunks.length; i++) {
    const fp = chunks[i].fp;
    for (let k = 0; k < fp.length; k += INDEX_STRIDE) {
      const key = fp[k];
      let arr = index.get(key);
      if (!arr) index.set(key, arr = []);
      if (arr.length < MAX_KEY_FANOUT && arr[arr.length - 1] !== i) arr.push(i);
    }
  }
  return index;
}

function candidatesFor(fp, index) {
  const cand = new Set();
  for (let k = 0; k < fp.length; k++) {
    const arr = index.get(fp[k]);
    if (!arr || arr.length >= MAX_KEY_FANOUT) continue;
    for (const idx of arr) cand.add(idx);
  }
  return cand;
}

/** Merge sorted chunks into contiguous spans (30s/15s-hop ⇒ overlap = contiguous). */
function extractSpans(chunks) {
  const spans = [];
  let cur = null;
  for (const c of chunks) {
    if (!cur) cur = { start_sec: c.start_sec, end_sec: c.end_sec, count: 1 };
    else if (c.start_sec - cur.end_sec <= 0.5) {
      cur.end_sec = Math.max(cur.end_sec, c.end_sec);
      cur.count++;
    } else {
      spans.push(cur);
      cur = { start_sec: c.start_sec, end_sec: c.end_sec, count: 1 };
    }
  }
  if (cur) spans.push(cur);
  return spans;
}

function longestSpan(chunks) {
  const spans = extractSpans([...chunks].sort((a, b) => a.start_sec - b.start_sec));
  return spans.reduce((a, b) => ((b.end_sec - b.start_sec) > (a.end_sec - a.start_sec) ? b : a));
}

function nextUnknownNumber() {
  const rows = repo.db().prepare(
    "SELECT title FROM songs WHERE title LIKE 'Unknown Song %' AND artist = 'Unknown'"
  ).all();
  let next = 1;
  for (const r of rows) {
    const m = r.title.match(/Unknown Song (\d+)/);
    if (m) next = Math.max(next, parseInt(m[1], 10) + 1);
  }
  return next;
}

/**
 * Incremental cross-media matching: does this file share audio with any
 * other fingerprinted file? If the neighbour's overlapping span already has
 * a song, inherit it; otherwise both get a fresh "Unknown Song N" placeholder
 * (renameable later — renaming fixes every linked file at once).
 */
function crossMatch(media_id) {
  const myFps = repo.getMediaFingerprints(media_id);
  if (!myFps.length) return [];
  const mine = myFps.map(f => ({
    start_sec: f.start_sec, end_sec: f.end_sec,
    fp: fpx.decodeFingerprint(f.fingerprint),
  }));

  const otherRows = repo.allChunksExcept(media_id);
  if (!otherRows.length) return [];
  const others = otherRows.map(r => ({
    media_id: r.media_id, start_sec: r.start_sec, end_sec: r.end_sec,
    fp: fpx.decodeFingerprint(r.fingerprint),
  }));

  // Index the other-media chunks once, then nominate + verify pairs
  const index = buildChunkIndex(others);
  const byOtherMedia = new Map(); // other media_id → { myChunks: [], otherChunks: [] }
  for (const mc of mine) {
    for (const idx of candidatesFor(mc.fp, index)) {
      const oc = others[idx];
      const r = matcher.bestMatch(mc.fp, oc.fp, { minOverlap: CLUSTER_MIN_OVERLAP });
      if (r.ber <= CLUSTER_THRESHOLD) {
        let g = byOtherMedia.get(oc.media_id);
        if (!g) byOtherMedia.set(oc.media_id, g = { myChunks: [], otherChunks: [] });
        g.myChunks.push(mc);
        g.otherChunks.push(oc);
      }
    }
  }

  const found = [];
  const myLinked = new Set(repo.songsForMedia(media_id).map(l => l.song_id));

  for (const [otherId, g] of byOtherMedia) {
    // Count DISTINCT matching chunks on my side (one chunk matching two of
    // the neighbour's overlapping windows shouldn't double-count)
    const distinct = new Set(g.myChunks.map(c => c.start_sec)).size;
    if (distinct < CLUSTER_MIN_CHUNKS) continue;

    const mySpan = longestSpan(g.myChunks);
    const otherSpan = longestSpan(g.otherChunks);

    // Does the neighbour already know what this audio is? Prefer a link
    // overlapping the matched span; manual/identified links beat placeholders.
    const otherLinks = repo.songsForMedia(otherId)
      .filter(l => l.start_sec == null || l.end_sec == null ||
        (l.start_sec < otherSpan.end_sec && l.end_sec > otherSpan.start_sec))
      .sort((a, b) => (a.source === 'auto-cluster' ? 1 : 0) - (b.source === 'auto-cluster' ? 1 : 0));

    let songId = otherLinks[0]?.song_id ?? null;
    let method = 'auto-fp';

    if (songId == null) {
      // Nobody knows it — create a placeholder song linking both files
      songId = repo.findOrCreateSong({
        title: `Unknown Song ${nextUnknownNumber()}`,
        artist: 'Unknown',
        source: 'auto-cluster',
      });
      method = 'auto-cluster';
      repo.linkSongToMedia({
        media_id: otherId, song_id: songId,
        start_sec: otherSpan.start_sec, end_sec: otherSpan.end_sec,
        confidence: null, method: 'auto-cluster',
      });
      // Reference fingerprint so future scans catch this track directly.
      // Async + non-fatal: matching already linked these two.
      const otherRow = database.getById(otherId);
      const refSrc = (mySpan.end_sec - mySpan.start_sec) >= (otherSpan.end_sec - otherSpan.start_sec)
        ? { row: database.getById(media_id), span: mySpan, mid: media_id }
        : { row: otherRow, span: otherSpan, mid: otherId };
      if (refSrc.row && (refSrc.span.end_sec - refSrc.span.start_sec) >= fpx.MIN_FP_DURATION) {
        fpx.fingerprintSegment(refSrc.row.filepath, refSrc.span.start_sec, refSrc.span.end_sec)
          .then(({ duration, fingerprint }) => {
            repo.saveSongFingerprint({
              song_id: songId, media_id: refSrc.mid,
              start_sec: refSrc.span.start_sec, end_sec: refSrc.span.end_sec,
              duration, fingerprint: fpx.encodeFingerprint(fingerprint),
            });
          })
          .catch(() => {});
      }
    }

    if (!myLinked.has(songId)) {
      repo.linkSongToMedia({
        media_id, song_id: songId,
        start_sec: mySpan.start_sec, end_sec: mySpan.end_sec,
        confidence: null, method,
      });
      myLinked.add(songId);
      const song = repo.getSong(songId);
      found.push({ song_id: songId, title: song?.title, artist: song?.artist, method });
    }
  }
  return found;
}

/* ── Fine alignment (sub-second sync between two files) ─────────────────── */

// Chromaprint frame hop: 1365 samples at 11025 Hz → one fp item ≈ 0.1238 s.
// Any systematic window offset cancels out because both files run through the
// identical pipeline — only this scale enters the delta math.
const FP_ITEM_SEC = 1365 / 11025;

/**
 * Sub-second alignment between two fingerprinted files sharing audio.
 *
 * The chunk grid gives link start_secs only ±CHUNK_HOP accuracy — good enough
 * to know "these share a song", useless for lip-sync. But bestMatch's item
 * offset pins WHERE inside two chunks the shared audio lines up, to one fp
 * item (~0.12 s). For every nominated chunk pair (a from A, b from B):
 *
 *   a[offset+i] ↔ b[i]  ⇒  the same song instant plays at
 *   A-time  a.start + (offset+i)·ITEM   and   B-time  b.start + i·ITEM
 *   ⇒  delta = timeInA − timeInB = a.start − b.start + offset·ITEM
 *
 * True pairs agree on delta within an item; repeated choruses land in other
 * clusters. Consensus = the overlap-weighted cluster with the most evidence.
 *
 * @returns {{delta_sec:number, pairs:number, ber:number}|null}
 *          delta_sec: play A at t ⇒ B belongs at t − delta_sec
 */
function fineAlignPair(mediaA, mediaB, { threshold = CLUSTER_THRESHOLD } = {}) {
  const aRows = repo.getMediaFingerprints(mediaA);
  const bRows = repo.getMediaFingerprints(mediaB);
  if (!aRows.length || !bRows.length) return null;

  const A = aRows.map(f => ({ start: f.start_sec, fp: fpx.decodeFingerprint(f.fingerprint) }));
  const B = bRows.map(f => ({ start: f.start_sec, fp: fpx.decodeFingerprint(f.fingerprint) }));
  const index = buildChunkIndex(B);

  const deltas = [];
  for (const a of A) {
    for (const idx of candidatesFor(a.fp, index)) {
      const b = B[idx];
      const r = matcher.bestMatch(a.fp, b.fp, { minOverlap: CLUSTER_MIN_OVERLAP });
      if (r.ber > threshold) continue;
      deltas.push({
        delta: a.start - b.start + r.offset * FP_ITEM_SEC,
        ber: r.ber,
        overlap: r.length,
      });
    }
  }
  if (!deltas.length) return null;

  // Seed cluster: 0.25s bins, weighted by overlap length (longer agreement =
  // stronger vote); final delta = weighted mean of everything within 0.3s of
  // the seed (so members straddling a bin edge still count).
  const bins = new Map();
  for (const d of deltas) {
    const k = Math.round(d.delta * 4);
    let bin = bins.get(k);
    if (!bin) bins.set(k, bin = { w: 0, sum: 0 });
    bin.w += d.overlap;
    bin.sum += d.delta * d.overlap;
  }
  let seed = null;
  for (const bin of bins.values()) if (!seed || bin.w > seed.w) seed = bin;
  const seedMean = seed.sum / seed.w;

  let w = 0, sum = 0, n = 0, berSum = 0;
  for (const d of deltas) {
    if (Math.abs(d.delta - seedMean) > 0.3) continue;
    w += d.overlap;
    sum += d.delta * d.overlap;
    n++;
    berSum += d.ber;
  }
  if (!(w > 0)) return null;
  return { delta_sec: sum / w, pairs: n, ber: berSum / n };
}

/* ── Auto-label audio files from their filename ─────────────────────────── */

/**
 * "Artist - Title.mp3" → { artist, title } (also handles "01 - Artist - Title"
 * track-number prefixes and en/em dashes). Null when there's no clear split —
 * the file still fingerprints and cross-matches, it just stays unlabeled.
 */
function parseArtistTitle(filename) {
  let base = filename.replace(/\.[^.]+$/, '').trim();
  // Normalize fancy dashes, collapse whitespace, drop "03. " track prefixes
  base = base.replace(/\s*[–—]\s*/g, ' - ').replace(/\s+/g, ' ');
  base = base.replace(/^\d{1,3}[.)]\s+/, '');
  let parts = base.split(' - ').map(s => s.trim()).filter(Boolean);
  // Leading track number ("01", "1.", "03)") → drop it
  if (parts.length > 2 && /^\d{1,3}[.)]?$/.test(parts[0])) parts = parts.slice(1);
  if (parts.length < 2) return null;
  const artist = parts[0];
  const title = parts.slice(1).join(' - ');
  if (!artist || !title || /^\d+$/.test(artist)) return null;
  return { artist, title };
}

/**
 * Turn a fingerprinted AUDIO file into a labeled song reference: song row
 * from the filename, whole-file link (method 'filename'), and a reference
 * fingerprint — so every video containing this track auto-labels on scan.
 * No-ops on videos, unparseable names, or files already linked to the song.
 * Returns { song_id, artist, title, created_ref } or null.
 */
async function autoLabelFromFilename(media_id) {
  const row = database.getById(media_id);
  if (!row || row.media_type !== 'audio') return null;
  const parsed = parseArtistTitle(row.filename);
  if (!parsed) return null;

  const song_id = repo.findOrCreateSong({
    title: parsed.title,
    artist: parsed.artist,
    source: 'filename',
  });

  const duration = row.duration_seconds || null;
  const already = repo.songsForMedia(media_id).some(l => l.song_id === song_id);
  if (!already) {
    repo.linkSongToMedia({
      media_id, song_id,
      start_sec: 0, end_sec: duration,
      confidence: null, method: 'filename',
    });
  }

  // Whole-file reference fingerprint (skip if one exists for this segment)
  let created_ref = false;
  if (duration && duration >= fpx.MIN_FP_DURATION && !repo.hasSongReference(song_id, media_id, 0)) {
    try {
      const seg = await fpx.fingerprintSegment(row.filepath, 0, duration);
      repo.saveSongFingerprint({
        song_id, media_id,
        start_sec: 0, end_sec: duration,
        duration: seg.duration,
        fingerprint: fpx.encodeFingerprint(seg.fingerprint),
      });
      created_ref = true;
    } catch { /* reference is best-effort; chunks still cross-match */ }
  }
  return { song_id, artist: parsed.artist, title: parsed.title, created_ref };
}

/* ── Manual tag → reference → propagate ─────────────────────────────────── */

/**
 * Build a reference fingerprint from a (manual) link's segment, then scan
 * every other fingerprinted file against just that reference. This is the
 * "teach it once, find it everywhere" flow, triggered from the sidebar.
 * Returns { ref_id, matched: [{media_id, filename}] }.
 */
async function buildReferenceAndPropagate(link_id) {
  const link = repo.getLink(link_id);
  if (!link) throw new Error('link not found');
  const row = database.getById(link.media_id);
  if (!row) throw new Error('media row missing');
  const len = (link.end_sec ?? 0) - (link.start_sec ?? 0);
  if (!Number.isFinite(len) || len < fpx.MIN_FP_DURATION) {
    throw new Error(`Segment too short (${len.toFixed(1)}s, needs ≥ ${fpx.MIN_FP_DURATION}s with an end time)`);
  }

  let ref_id = null;
  if (!repo.hasSongReference(link.song_id, link.media_id, link.start_sec)) {
    const { duration, fingerprint } = await fpx.fingerprintSegment(row.filepath, link.start_sec, link.end_sec);
    ref_id = repo.saveSongFingerprint({
      song_id: link.song_id, media_id: link.media_id,
      start_sec: link.start_sec, end_sec: link.end_sec,
      duration, fingerprint: fpx.encodeFingerprint(fingerprint),
    });
  }

  // Propagate: scan all other fingerprinted media against this song's refs
  const refIds = repo.listSongFingerprints(link.song_id).map(r => r.id);
  const matched = [];
  for (const { media_id } of repo.fingerprintCounts()) {
    if (media_id === link.media_id) continue;
    const hits = scanAgainstReferences(media_id, { onlyRefIds: refIds });
    if (hits.length) {
      const m = database.getById(media_id);
      matched.push({ media_id, filename: m?.filename });
    }
  }
  return { ref_id, matched };
}

/* ── Section Identifier (chunk-level tagging — see MUSICID_SECTIONS_SPEC) ── */

/**
 * The data behind the Section Identifier timeline: every stored chunk with
 * its current best match, silence gaps (hop-grid slots with no chunk), the
 * existing links, and a song lookup for the legend. Recomputed on open —
 * per-chunk results go stale every time a reference lands anywhere.
 */
function getSections(media_id) {
  const row = database.getById(media_id);
  if (!row) return null;
  // Looser cluster threshold so the UI can show near-misses too
  // (ber ≤ SCAN_THRESHOLD renders strong, above it weak).
  const chunks = matchChunksForMedia(media_id, { threshold: CLUSTER_THRESHOLD }) || [];
  const duration = row.duration_seconds
    || (chunks.length ? chunks[chunks.length - 1].end_sec : 0);

  // Hop-grid positions with no stored chunk = silence-gated dead air
  const have = new Set(chunks.map(c => Math.round(c.start_sec / fpx.CHUNK_HOP)));
  const gaps = [];
  for (let s = 0; s + fpx.MIN_FP_DURATION <= duration; s += fpx.CHUNK_HOP) {
    if (!have.has(Math.round(s / fpx.CHUNK_HOP))) {
      gaps.push({ start_sec: s, end_sec: Math.min(s + fpx.CHUNK_DURATION, duration) });
    }
  }

  const links = repo.songsForMedia(media_id);
  const songs = {};
  const need = new Set([
    ...links.map(l => l.song_id),
    ...chunks.filter(c => c.match).map(c => c.match.song_id),
  ]);
  for (const sid of need) {
    const s = repo.getSong(sid);
    if (s) songs[sid] = { title: s.title, artist: s.artist, source: s.source };
  }

  return {
    media_id, duration_seconds: duration,
    chunk_hop: fpx.CHUNK_HOP, chunk_duration: fpx.CHUNK_DURATION,
    scan_threshold: SCAN_THRESHOLD,
    chunks, gaps, links, songs,
  };
}

/**
 * Correction sweep: auto links overlapping the new manual tag. Same song →
 * delete (the manual tag replaces it). Different song → delete when the tag
 * covers >50% of the link; trim a poking edge; SPLIT a long span that fully
 * covers the selection (the "one greedy span, four songs" case). Manual
 * links are never touched — returned as conflicts for the UI to flag.
 */
function sweepAutoLinks(media_id, song_id, start_sec, end_sec) {
  const MIN_REMAINDER = fpx.MIN_FP_DURATION;
  const conflicts = [];
  for (const l of repo.songsForMedia(media_id)) {
    const s = l.start_sec ?? 0;
    const e = l.end_sec ?? Infinity;
    const ovl = Math.min(e, end_sec) - Math.max(s, start_sec);
    if (ovl <= 0) continue;

    if (l.method === 'manual') {
      if (l.song_id !== song_id) {
        conflicts.push({ link_id: l.link_id, title: l.title, artist: l.artist, manual: true });
      } else {
        repo.unlinkSong(l.link_id); // same-song re-tag supersedes the old manual link
      }
      continue;
    }
    if (l.song_id === song_id) { repo.unlinkSong(l.link_id); continue; } // upgraded to manual

    const linkLen = (Number.isFinite(e) ? e : end_sec) - s;
    if (linkLen <= 0 || ovl / linkLen > 0.5) { repo.unlinkSong(l.link_id); continue; }

    const spansLeft = s < start_sec;
    const spansRight = Number.isFinite(e) && e > end_sec;
    if (spansLeft && spansRight) {
      // Split around the tagged section; drop slivers under MIN_REMAINDER
      if (e - end_sec >= MIN_REMAINDER) {
        repo.linkSongToMedia({
          media_id, song_id: l.song_id, start_sec: end_sec, end_sec: e,
          confidence: l.confidence, method: l.method,
        });
      }
      if (start_sec - s >= MIN_REMAINDER) repo.updateLink(l.link_id, { end_sec: start_sec });
      else repo.unlinkSong(l.link_id);
    } else if (spansLeft) {
      if (start_sec - s >= MIN_REMAINDER) repo.updateLink(l.link_id, { end_sec: start_sec });
      else repo.unlinkSong(l.link_id);
    } else if (spansRight) {
      if (e - end_sec >= MIN_REMAINDER) repo.updateLink(l.link_id, { start_sec: end_sec });
      else repo.unlinkSong(l.link_id);
    } else {
      repo.unlinkSong(l.link_id); // fully inside always exceeds 50%; safety net
    }
  }
  return conflicts;
}

/**
 * Tag a section with a song and teach the matcher from the ALREADY-STORED
 * chunk fingerprints — a SQL copy instead of an ffmpeg+fpcalc re-run. Chunks
 * fully contained in the selection are copied stride-2 (30s/15s-hop chunks
 * tile exactly at stride 2) plus the final chunk; boundary chunks never
 * become references (they carry neighbor audio). Falls back to a segment
 * fingerprint when the selection is too short to contain a full chunk.
 */
async function tagSection(media_id, { start_sec, end_sec, song, replace_overlapping_auto = true } = {}) {
  const row = database.getById(media_id);
  if (!row) throw new Error('media not found');
  start_sec = Number(start_sec); end_sec = Number(end_sec);
  const len = end_sec - start_sec;
  if (!Number.isFinite(len) || len < fpx.MIN_FP_DURATION) {
    throw new Error(`Section too short (${(len || 0).toFixed(1)}s, needs ≥ ${fpx.MIN_FP_DURATION}s)`);
  }
  if (!repo.mediaHasFingerprints(media_id)) throw new Error('not fingerprinted yet');

  // Resolve the song: existing id, or find-or-create from artist/title
  let song_id;
  if (song?.song_id) {
    song_id = Number(song.song_id);
    if (!repo.getSong(song_id)) throw new Error('song not found');
  } else if (song?.title?.trim() && song?.artist?.trim()) {
    song_id = repo.findOrCreateSong({
      title: song.title.trim(), artist: song.artist.trim(),
      is_remix: song.is_remix ? 1 : 0, remix_label: (song.remix_label || '').trim(),
      source: 'manual',
    });
  } else {
    throw new Error('song required (song_id or artist+title)');
  }

  // Contained chunks only (±0.5s tolerance) → stride-2 + always the last
  const contained = repo.getMediaFingerprints(media_id)
    .filter(c => c.start_sec >= start_sec - 0.5 && c.end_sec <= end_sec + 0.5);
  const picked = contained.filter((c, i) => i % 2 === 0);
  if (contained.length > 1 && picked[picked.length - 1] !== contained[contained.length - 1]) {
    picked.push(contained[contained.length - 1]);
  }

  let conflicts = [];
  let link_id = null;
  const newRefIds = [];
  repo.db().transaction(() => {
    if (replace_overlapping_auto) conflicts = sweepAutoLinks(media_id, song_id, start_sec, end_sec);
    link_id = repo.linkSongToMedia({ media_id, song_id, start_sec, end_sec, confidence: null, method: 'manual' });
    for (const c of picked) {
      if (repo.hasSongReference(song_id, media_id, c.start_sec)) continue;
      newRefIds.push(repo.saveSongFingerprint({
        song_id, media_id, start_sec: c.start_sec, end_sec: c.end_sec,
        duration: c.duration, fingerprint: c.fingerprint, origin: 'chunk-copy',
      }));
    }
  })();

  // Fallback: selection too short to contain a full chunk → deep segment ref
  if (!picked.length && !repo.hasSongReference(song_id, media_id, start_sec)) {
    const { duration, fingerprint } = await fpx.fingerprintSegment(row.filepath, start_sec, end_sec);
    newRefIds.push(repo.saveSongFingerprint({
      song_id, media_id, start_sec, end_sec, duration,
      fingerprint: fpx.encodeFingerprint(fingerprint), origin: 'segment',
    }));
  }

  // Propagate: scan every other fingerprinted file against just the new refs
  const matched = [];
  if (newRefIds.length) {
    for (const { media_id: mid } of repo.fingerprintCounts()) {
      if (mid === media_id) continue;
      const hits = scanAgainstReferences(mid, { onlyRefIds: newRefIds });
      if (hits.length) {
        const m = database.getById(mid);
        matched.push({ media_id: mid, filename: m?.filename });
      }
    }
  }
  return { link_id, song_id, refs_created: newRefIds.length, matched, conflicts };
}

/* ── CLI batch (fingerprint many files, then match) ─────────────────────── */

/**
 * Fingerprint many files with a small concurrency pool. ffmpeg/fpcalc is
 * CPU-bound, so 2 overlap cleanly without thrashing — and because this only
 * spawns processes (the JS between awaits is tiny), it runs happily ALONGSIDE
 * a GPU-bound AI scan instead of serializing behind it.
 *
 * Fingerprint ONLY: matching (scanMedia) is synchronous CPU work that would
 * stall the event loop, so callers run scanBatch() afterwards, once any
 * concurrent scan has finished. Returns { stats, readyIds }.
 */
async function fingerprintBatch(ids, { concurrency = 2, force = false, autoLabel = false, onProgress = null } = {}) {
  const { runPool } = require('../proc');
  const stats = { total: ids.length, fingerprinted: 0, skipped: 0, failed: 0, silent: 0, labeled: 0 };
  const readyIds = [];
  let done = 0;

  const tasks = ids.map((id) => async () => {
    const row = database.getById(id);
    if (!row || !['video', 'audio'].includes(row.media_type)) { stats.skipped++; return; }
    if (!force && repo.mediaHasFingerprints(id)) {
      stats.skipped++;
      readyIds.push(id);
      // Still label already-fingerprinted audio (idempotent) — a re-run over
      // an MP3 folder backfills names without re-doing the fpcalc work
      const labeled = autoLabel ? await autoLabelFromFilename(id).catch(() => null) : null;
      if (labeled) stats.labeled++;
      if (onProgress) onProgress({ done: ++done, total: ids.length, filename: row.filename, skipped: true, labeled });
      return;
    }
    try {
      const { chunks, skippedSilent } = await fpx.fingerprintMedia(row.filepath, {
        totalDuration: row.duration_seconds || null,
      });
      repo.saveMediaFingerprints(id, chunks.map((c) => ({
        ...c, fingerprint: fpx.encodeFingerprint(c.fingerprint),
      })));
      stats.fingerprinted++;
      stats.silent += skippedSilent;
      readyIds.push(id);
      const labeled = autoLabel ? await autoLabelFromFilename(id).catch(() => null) : null;
      if (labeled) stats.labeled++;
      if (onProgress) onProgress({ done: ++done, total: ids.length, filename: row.filename, chunks: chunks.length, skippedSilent, labeled });
    } catch (e) {
      stats.failed++;
      if (onProgress) onProgress({ done: ++done, total: ids.length, filename: row.filename, error: e.message });
    }
  });

  await runPool(tasks, concurrency);
  return { stats, readyIds };
}

/**
 * Match already-fingerprinted files against song references + other media.
 * Synchronous (XOR/popcount) — run AFTER any concurrent scan completes so the
 * heavy compare loop doesn't block the event loop. Returns { matched, perFile }.
 */
function scanBatch(ids, { onMatch = null } = {}) {
  let matched = 0;
  const perFile = [];
  for (const id of ids) {
    if (!repo.mediaHasFingerprints(id)) continue;
    const found = scanMedia(id);
    if (found.length) {
      matched += found.length;
      perFile.push({ id, found });
      if (onMatch) onMatch({ id, found });
    }
  }
  return { matched, perFile };
}

module.exports = {
  SCAN_THRESHOLD, CLUSTER_THRESHOLD, FP_ITEM_SEC,
  enqueueFingerprint, getQueueState,
  scanMedia, scanAgainstReferences, crossMatch, fineAlignPair,
  matchChunksForMedia, getSections, tagSection,
  buildReferenceAndPropagate,
  fingerprintBatch, scanBatch,
  parseArtistTitle, autoLabelFromFilename,
};
