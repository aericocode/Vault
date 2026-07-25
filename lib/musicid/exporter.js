/**
 * Music ID — stack-mix ffmpeg exporter (CJS port of SAMPLES exporter.js).
 *
 * Jobs persist in music_exports; encodes run one at a time. Each track
 * carries an absolute per-file seek, so exports work for song-aligned mixes
 * AND free-form stacks alike.
 *
 * PRIVACY MODEL (do not weaken): the finished MP4 exists ONLY in memory.
 * ffmpeg writes to stdout (fragmented MP4 — pipe-safe) and the bytes live in
 * the `results` map until the user explicitly downloads them. Nothing is
 * auto-written to an exports folder; a server restart or vault lock drops
 * every finished export, queued job, and pending overlay. The one disk
 * artifact is the beatbar overlay strip (abstract shapes on transparency,
 * no library content) staged in the managed temp dir for ffmpeg to read —
 * unlinked in `finally` and swept by wipeTempDir on every server start.
 *
 * Optional beatbar bake: the client pre-renders the bar (settings frozen at
 * submit) into a PNG frame stream, uploads it, and the export composites it
 * via image2pipe + overlay at the exact on-screen position.
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const repo = require('./repo');
const { effectToFFmpeg, buildOverlayChain } = require('./effects');
const config = require('../../config');
const ownedDir = require('../owned-dir');
const vault = require('../vault');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

let activeJob = null;
let activeProc = null;
const queue = [];

// Finished MP4s — RAM only (see the privacy model above). Insertion order is
// oldest-first, so trimming evicts the stalest export.
const MAX_RESULTS = 3;                      // completed exports kept at once
const MAX_OUTPUT_BYTES = 2 * 1024 ** 3;     // per-job encode cap (2 GB)
const results = new Map();                  // jobId -> { buf }

// Beatbar overlay uploads parked between POST /exports/overlay and their
// export job. Short TTL — an abandoned upload must not squat in RAM.
const OVERLAY_TTL_MS = 10 * 60 * 1000;
const pendingOverlays = new Map();          // token -> { buf, at }
const jobOverlays = new Map();              // jobId -> Buffer (claimed at enqueue)

/** Park an uploaded overlay stream; returns the claim token. */
function putOverlay(buf) {
  const now = Date.now();
  for (const [k, v] of pendingOverlays) {
    if (now - v.at > OVERLAY_TTL_MS) pendingOverlays.delete(k);
  }
  const token = crypto.randomBytes(16).toString('hex');
  pendingOverlays.set(token, { buf, at: now });
  return { token };
}

function takeOverlay(token) {
  const e = pendingOverlays.get(token);
  if (!e) return null;
  pendingOverlays.delete(token);
  return e.buf;
}

function buildFilter({ tracks, width, height, durationSec, beatbar }) {
  const lines = [];
  const N = tracks.length;

  for (let i = 0; i < N; i++) {
    const frag = effectToFFmpeg({
      inLabel: `${i}:v`,
      outLabel: `v${i}`,
      width, height,
      effect: tracks[i].effect,
      isBack: i === 0,
    });
    for (const l of frag) lines.push(l);
  }
  for (const l of buildOverlayChain(tracks)) lines.push(l);

  // Beatbar bake: the uploaded PNG stream is input N. It ends when its frames
  // do — eof_action=pass keeps the mix rolling if it comes up short.
  let videoLabel = 'vout';
  if (beatbar) {
    lines.push(`[${N}:v]format=rgba[bb]`);
    lines.push(`[vout][bb]overlay=x=${beatbar.x}:y=${beatbar.y}:eof_action=pass[voutbb]`);
    videoLabel = 'voutbb';
  }

  // AUDIO — mix every track with volume > 0
  let audibleCount = 0;
  for (let i = 0; i < N; i++) {
    const vol = Math.max(0, Math.min(2, tracks[i].volume ?? 0));
    if (vol <= 0) continue;
    audibleCount++;
    lines.push(
      `[${i}:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS,volume=${vol.toFixed(4)}[a${i}]`
    );
  }
  if (audibleCount === 0) {
    lines.push(`anullsrc=r=44100:cl=stereo:duration=${durationSec.toFixed(3)}[aout]`);
  } else if (audibleCount === 1) {
    const i = tracks.findIndex(t => (t.volume ?? 0) > 0);
    lines.push(`[a${i}]anull[aout]`);
  } else {
    const inputs = tracks
      .map((t, i) => ((t.volume ?? 0) > 0 ? `[a${i}]` : null))
      .filter(Boolean)
      .join('');
    lines.push(`${inputs}amix=inputs=${audibleCount}:duration=longest:dropout_transition=0:normalize=0[aout]`);
  }

  return { filter: lines.join(';'), videoLabel };
}

function buildFFmpegArgs({ tracks, width, height, durationSec, beatbar, overlayPath }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-stats'];
  for (const t of tracks) {
    args.push('-ss', String(t.seek), '-t', String(durationSec), '-i', t.mediaPath);
  }
  if (beatbar && overlayPath) {
    args.push('-f', 'image2pipe', '-framerate', String(beatbar.fps), '-i', overlayPath);
  }
  const { filter, videoLabel } = buildFilter({ tracks, width, height, durationSec, beatbar });
  args.push(
    '-filter_complex', filter,
    '-map', `[${videoLabel}]`,
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    // stdout isn't seekable, so no +faststart: fragmented MP4 streams and
    // downloads cleanly (browsers/VLC/players all take fMP4)
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-t', String(durationSec),
    '-f', 'mp4', 'pipe:1',
  );
  return args;
}

function run(cmd, args, onProgress) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    activeProc = p;
    const chunks = [];
    let total = 0;
    let overCap = false;
    p.stdout.on('data', (d) => {
      total += d.length;
      if (total > MAX_OUTPUT_BYTES) {
        if (!overCap) { overCap = true; try { p.kill('SIGKILL'); } catch {} }
        return;
      }
      chunks.push(d);
    });
    let stderr = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onProgress) {
        const m = s.match(/time=(\d+):(\d+):([\d.]+)/);
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });
    p.on('close', (code) => {
      activeProc = null;
      resolve({ code, stderr, out: Buffer.concat(chunks), overCap });
    });
    p.on('error', (e) => {
      activeProc = null;
      resolve({ code: -1, stderr: String(e), out: null, overCap });
    });
  });
}

/** DB write that survives a vault locking mid-encode (handle already gone). */
function tryDb(fn) {
  try { fn(repo.db()); return true; } catch { return false; }
}

async function runJob(jobId) {
  let row, params;
  const loaded = tryDb((d) => { row = d.prepare('SELECT * FROM music_exports WHERE id = ?').get(jobId); });
  if (!loaded || !row) return;
  try { params = JSON.parse(row.params); }
  catch (e) {
    tryDb((d) => d.prepare("UPDATE music_exports SET status='failed', error=?, completed_at=datetime('now') WHERE id=?")
      .run('Bad params JSON: ' + e.message, jobId));
    return;
  }

  tryDb((d) => d.prepare("UPDATE music_exports SET status='running' WHERE id=?").run(jobId));

  const { tracks, width, height, durationSec, beatbar } = params;

  // Stage the overlay strip (shapes only — no library content) for ffmpeg
  let overlayPath = null;
  const overlayBuf = jobOverlays.get(jobId);
  jobOverlays.delete(jobId);
  if (beatbar && overlayBuf) {
    ownedDir.ensureManaged(config.paths.tempDir, 'temp');
    overlayPath = path.join(config.paths.tempDir, `mixbb_${jobId}_${process.pid}_${Date.now()}.pngs`);
    fs.writeFileSync(overlayPath, overlayBuf);
  }

  try {
    const args = buildFFmpegArgs({
      tracks, width, height, durationSec,
      beatbar: overlayPath ? beatbar : null,
      overlayPath,
    });

    const result = await run(FFMPEG, args, (sec) => {
      tryDb((d) => d.prepare('UPDATE music_exports SET progress = ? WHERE id = ?')
        .run(Math.min(0.99, sec / durationSec), jobId));
    });

    if (result.overCap) {
      tryDb((d) => d.prepare("UPDATE music_exports SET status='failed', error=?, completed_at=datetime('now') WHERE id=?")
        .run(`output exceeded the ${(MAX_OUTPUT_BYTES / 1024 ** 3).toFixed(0)} GB in-memory cap — export a shorter range or lower resolution`, jobId));
      return;
    }
    if (result.code !== 0 || !result.out || !result.out.length) {
      tryDb((d) => d.prepare("UPDATE music_exports SET status='failed', error=?, completed_at=datetime('now') WHERE id=?")
        .run((result.stderr || 'ffmpeg produced no output').trim().slice(-500), jobId));
      return;
    }

    results.set(jobId, { buf: result.out });
    while (results.size > MAX_RESULTS) {
      const oldest = results.keys().next().value;
      results.delete(oldest);
    }
    tryDb((d) => d.prepare("UPDATE music_exports SET status='done', progress=1, completed_at=datetime('now') WHERE id=?")
      .run(jobId));
  } finally {
    if (overlayPath) { try { fs.unlinkSync(overlayPath); } catch {} }
  }
}

function pump() {
  if (activeJob) return;
  const next = queue.shift();
  if (!next) return;
  activeJob = next;
  runJob(next).catch(() => {}).finally(() => {
    activeJob = null;
    pump();
  });
}

/** Song-relative overlap window (longest range valid for every track). */
function computeOverlap(linkRows) {
  let minLen = Infinity;
  for (const l of linkRows) {
    const len = (l.end_sec ?? 0) - (l.start_sec ?? 0);
    if (len > 0 && len < minLen) minLen = len;
  }
  if (!Number.isFinite(minLen)) minLen = 0;
  return { start: 0, end: Math.max(0, minLen) };
}

function enqueueExport(cfg) {
  const d = repo.db();
  let filename = String(cfg.filename || `mix-${Date.now()}.mp4`).replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!filename.toLowerCase().endsWith('.mp4')) filename += '.mp4';

  // Claim the pre-rendered overlay NOW: the bake is frozen at submit time,
  // and a dead token means the client's upload never landed.
  let overlayBuf = null;
  let beatbar = null;
  if (cfg.beatbar) {
    overlayBuf = takeOverlay(cfg.beatbar.overlay_token);
    if (!overlayBuf) {
      const e = new Error('beatbar overlay upload missing or expired — submit the export again');
      e.code = 'OVERLAY_MISSING';
      throw e;
    }
    beatbar = {
      x: cfg.beatbar.x, y: cfg.beatbar.y,
      w: cfg.beatbar.w, h: cfg.beatbar.h,
      fps: cfg.beatbar.fps,
    };
  }

  const r = d.prepare(`
    INSERT INTO music_exports (song_id, filename, status, progress, params)
    VALUES (?, ?, 'pending', 0, ?)
  `).run(
    cfg.song_id ?? null,
    filename,
    JSON.stringify({
      tracks: cfg.tracks,
      width: cfg.width,
      height: cfg.height,
      durationSec: cfg.durationSec,
      beatbar,
    })
  );
  const id = r.lastInsertRowid;
  if (overlayBuf) jobOverlays.set(id, overlayBuf);
  queue.push(id);
  pump();
  return { id };
}

/** RAM-held finished MP4 (null once expired/locked/restarted). */
function getExportBuffer(id) {
  return results.get(id)?.buf || null;
}

/** Row + availability flags the UI needs (buffer present / legacy file). */
function decorate(row) {
  if (!row) return row;
  const buf = results.get(row.id)?.buf;
  const legacy = !!(row.output_path && fs.existsSync(row.output_path));
  return {
    ...row,
    available: !!buf || legacy,
    size_bytes: buf ? buf.length : null,
  };
}

function getExport(id) {
  return decorate(repo.db().prepare('SELECT * FROM music_exports WHERE id = ?').get(id));
}

function listExports({ limit = 50 } = {}) {
  return repo.db().prepare('SELECT * FROM music_exports ORDER BY id DESC LIMIT ?').all(limit).map(decorate);
}

function deleteExport(id) {
  results.delete(id);
  jobOverlays.delete(id);
  const row = repo.db().prepare('SELECT * FROM music_exports WHERE id = ?').get(id);
  if (row?.output_path) {
    // pre-memory-era export that was written to disk — remove the file too
    try { fs.unlinkSync(row.output_path); } catch {}
  }
  return repo.db().prepare('DELETE FROM music_exports WHERE id = ?').run(id);
}

/**
 * Rows stuck pending/running from a previous process (or a lock that killed
 * the encode) can never finish — their buffers died with that session.
 * Same idiom as pmv/repo.failStaleJobs: routes call it at mount, server
 * start re-runs it on first unlock when the vault booted locked.
 */
function failStaleExports() {
  const live = new Set([activeJob, ...queue].filter(Boolean));
  const rows = repo.db().prepare(
    "SELECT id FROM music_exports WHERE status IN ('pending','running')"
  ).all();
  const stale = rows.map(r => r.id).filter(id => !live.has(id));
  if (!stale.length) return 0;
  const mark = repo.db().prepare(
    "UPDATE music_exports SET status='failed', error='interrupted (server restart or vault lock)', completed_at=datetime('now') WHERE id=?"
  );
  for (const id of stale) mark.run(id);
  return stale.length;
}

// Vault lock = the session key is gone: kill the encode, drop every queued
// job, pending overlay, and finished MP4. Mirrors "stops all activity on
// Vault lock" everywhere else in the app.
vault.onChange((e) => {
  if (e !== 'locking') return;
  const doomed = [activeJob, ...queue].filter(Boolean);
  queue.length = 0;
  jobOverlays.clear();
  pendingOverlays.clear();
  results.clear();
  if (activeProc) { try { activeProc.kill('SIGKILL'); } catch {} }
  // 'locking' fires while the DB handle is still open — mark the doomed rows
  // now, or a mid-session lock leaves them "running" until the next restart's
  // mount sweep (the unlock sweep only exists when the server BOOTED locked).
  for (const id of doomed) {
    tryDb((d) => d.prepare(
      "UPDATE music_exports SET status='failed', error='interrupted (vault locked)', completed_at=datetime('now') WHERE id=? AND status IN ('pending','running')"
    ).run(id));
  }
});

module.exports = {
  enqueueExport, getExport, listExports, deleteExport, computeOverlap,
  putOverlay, getExportBuffer, failStaleExports,
};
