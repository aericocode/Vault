/**
 * Music ID — song-seed packs: portable reference fingerprints WITHOUT audio.
 *
 * A pack (`vault-songseed.json`) carries songs + their reference fingerprints
 * (the same base64 chromaprint text the DB stores), so a user can import
 * hosted packs and have their already-fingerprinted library re-scanned for
 * matches — no MP3s needed on disk, ever. song_fingerprints.media_id is
 * nullable by design: imported references simply have no local source file.
 *
 * Distribution is strictly PULL: the user downloads a pack themselves and
 * imports it (file picker / CLI). Nothing here fetches anything from the
 * network. The format reserves top-level fields (e.g. a future `signature`)
 * for signed/paid packs — unknown fields are ignored on import.
 *
 *   export: exportSeedPack()            → pack object (CLI/route serialize it)
 *   import: importSeedPack(pack)        → { songs_added, fps_added, new_ref_ids, … }
 *   rescan: startRematch(newRefIds)     → background pass over every
 *           fingerprinted file vs ONLY the new references (service's
 *           scanAgainstReferences onlyRefIds path); getRematchState() to poll.
 */

const repo = require('./repo');
const fpx = require('./fingerprint');
const vault = require('../vault');

const FORMAT = 'vault-songseed';
const VERSION = 1;

// Import sanity caps — a pack is user-supplied input
const MAX_SONGS = 50000;
const MAX_FPS_PER_SONG = 64;
const MAX_FP_CHARS = 400000;   // ~100k ints ≈ a 3.5-hour reference; nothing sane is bigger
const MAX_NAME_CHARS = 300;

/* ── Export ─────────────────────────────────────────────────────────────── */

/**
 * Songs that have reference fingerprints, bundled for distribution.
 * Auto-clustered "Unknown Song N" placeholders are excluded by default —
 * they're meaningless outside the library that coined them.
 */
function exportSeedPack({ name = '', includeUnknown = false } = {}) {
  const d = repo.db();
  const songs = d.prepare(`
    SELECT s.id, s.title, s.artist, s.is_remix, s.remix_label
    FROM songs s
    WHERE EXISTS (SELECT 1 FROM song_fingerprints sf WHERE sf.song_id = s.id)
    ${includeUnknown ? '' : "AND s.source != 'auto-cluster' AND s.artist != 'Unknown'"}
    ORDER BY s.artist COLLATE NOCASE, s.title COLLATE NOCASE
  `).all();

  const refStmt = d.prepare(`
    SELECT start_sec, end_sec, duration, fingerprint, origin
    FROM song_fingerprints WHERE song_id = ? ORDER BY start_sec
  `);

  return {
    format: FORMAT,
    version: VERSION,
    name: String(name || ''),
    created_at: new Date().toISOString(),
    songs: songs.map(s => ({
      artist: s.artist,
      title: s.title,
      is_remix: s.is_remix ? 1 : 0,
      remix_label: s.remix_label || '',
      fingerprints: refStmt.all(s.id).map(r => ({
        start_sec: r.start_sec,
        end_sec: r.end_sec,
        duration: r.duration,
        origin: r.origin || 'segment',
        fingerprint: r.fingerprint,
      })),
    })),
  };
}

/* ── Import ─────────────────────────────────────────────────────────────── */

// ~4s of chromaprint ints — anything shorter is match noise, not a reference.
// Node's base64 decoder silently drops invalid characters, so charset-check
// the string FIRST or mangled input "decodes" into a tiny garbage fingerprint.
const MIN_FP_INTS = 32;

function _validFp(str) {
  if (typeof str !== 'string' || !str.length || str.length > MAX_FP_CHARS) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(str)) return false;
  try { return fpx.decodeFingerprint(str).length >= MIN_FP_INTS; } catch { return false; }
}

/**
 * Upsert a pack into songs + song_fingerprints (media_id NULL, origin 'seed').
 * Idempotent: songs match on (title, artist, remix_label); a fingerprint the
 * song already has (exact text) is skipped, so re-importing a pack is a no-op
 * and a v2 pack only adds what's new.
 */
function importSeedPack(pack) {
  if (!pack || pack.format !== FORMAT) {
    const e = new Error(`not a ${FORMAT} file`); e.code = 'SEED_BAD_FORMAT'; throw e;
  }
  if (pack.version !== VERSION) {
    const e = new Error(`unsupported seed version ${pack.version} (this build reads v${VERSION})`);
    e.code = 'SEED_BAD_VERSION'; throw e;
  }
  if (!Array.isArray(pack.songs) || !pack.songs.length) {
    const e = new Error('pack has no songs'); e.code = 'SEED_EMPTY'; throw e;
  }
  if (pack.songs.length > MAX_SONGS) {
    const e = new Error(`pack too large (${pack.songs.length} songs; cap ${MAX_SONGS})`);
    e.code = 'SEED_TOO_LARGE'; throw e;
  }

  const d = repo.db();
  const existingFps = d.prepare('SELECT fingerprint FROM song_fingerprints WHERE song_id = ?');
  const res = {
    songs_added: 0, songs_existing: 0,
    fps_added: 0, fps_skipped: 0, fps_invalid: 0,
    new_ref_ids: [],
  };

  const runAll = d.transaction(() => {
    for (const s of pack.songs) {
      const title = String(s?.title ?? '').trim().slice(0, MAX_NAME_CHARS);
      const artist = String(s?.artist ?? '').trim().slice(0, MAX_NAME_CHARS);
      if (!title || !artist) continue;
      const remix_label = String(s.remix_label ?? '').trim().slice(0, MAX_NAME_CHARS);

      const before = d.prepare(
        'SELECT id FROM songs WHERE title = ? AND artist = ? AND remix_label = ?'
      ).get(title, artist, remix_label);
      const song_id = repo.findOrCreateSong({
        title, artist, remix_label,
        is_remix: s.is_remix ? 1 : 0,
        source: 'seed',
      });
      if (before) res.songs_existing++; else res.songs_added++;

      const have = new Set(existingFps.all(song_id).map(r => r.fingerprint));
      const fps = Array.isArray(s.fingerprints) ? s.fingerprints.slice(0, MAX_FPS_PER_SONG) : [];
      for (const f of fps) {
        if (!_validFp(f?.fingerprint)) { res.fps_invalid++; continue; }
        if (have.has(f.fingerprint)) { res.fps_skipped++; continue; }
        const dur = Number(f.duration) > 0 ? Number(f.duration)
          : Math.max(0, Number(f.end_sec) - Number(f.start_sec)) || 0;
        const id = repo.saveSongFingerprint({
          song_id,
          media_id: null,                       // detached — no local audio file
          start_sec: Number(f.start_sec) || 0,
          end_sec: Number(f.end_sec) || dur,
          duration: dur,
          fingerprint: f.fingerprint,
          origin: 'seed',
        });
        have.add(f.fingerprint);
        res.new_ref_ids.push(id);
        res.fps_added++;
      }
    }
  });
  runAll();
  return res;
}

/* ── Post-import rematch (background) ───────────────────────────────────── */

let _rematch = { running: false, total: 0, done: 0, new_links: 0, error: null, finished_at: null };

function getRematchState() { return { ..._rematch, new_ref_ids: undefined }; }

/**
 * Re-scan every fingerprinted file against ONLY the given reference ids
 * (service.scanAgainstReferences onlyRefIds). Runs in the background,
 * yielding between files; a vault lock aborts it cleanly.
 * @returns {number} files queued (0 when a rematch is already running)
 */
function startRematch(onlyRefIds, { onDone = null } = {}) {
  if (_rematch.running || !onlyRefIds?.length) return 0;
  const service = require('./service');
  const ids = repo.db().prepare('SELECT DISTINCT media_id FROM media_fingerprints').all()
    .map(r => r.media_id);
  _rematch = { running: true, total: ids.length, done: 0, new_links: 0, error: null, finished_at: null };

  (async () => {
    try {
      for (const media_id of ids) {
        if (vault.isLocked()) { _rematch.error = 'interrupted (vault locked)'; break; }
        try {
          _rematch.new_links += service.scanAgainstReferences(media_id, { onlyRefIds }).length;
        } catch (e) {
          // one bad file never aborts the sweep — but a closed DB does
          if (vault.isLocked()) { _rematch.error = 'interrupted (vault locked)'; break; }
          console.warn(`[SeedPack] rematch skipped media ${media_id}: ${e.message}`);
        }
        _rematch.done++;
        if (_rematch.done % 20 === 0) await new Promise(r => setImmediate(r));
      }
    } finally {
      _rematch.running = false;
      _rematch.finished_at = new Date().toISOString();
      if (onDone) { try { onDone(getRematchState()); } catch {} }
    }
  })();
  return ids.length;
}

module.exports = { FORMAT, VERSION, exportSeedPack, importSeedPack, startRematch, getRematchState };
