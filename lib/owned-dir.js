/**
 * App-owned-directory sentinel.
 *
 * Several destructive sweeps in this app operate on CONFIGURABLE directories
 * (thumbnailDir, tempDir, temp_audio — overridable via VAULT_THUMBS /
 * VAULT_TEMP / VAULT_TEMP_AUDIO, or relocated wholesale when the
 * portable exe is dropped inside a media folder, moving the ROOT-relative
 * defaults there too). If any of those point at a directory that actually holds
 * the user's own files, a sweep would delete data the app doesn't own.
 *
 * Guard: a marker file (`.vault-owned`) placed at the root of each directory the
 * app itself creates/manages. Every whole-directory sweep is gated on the marker
 * being present — no marker → the sweep is SKIPPED and a warning is logged.
 * Non-destructive work (reading, generating fresh thumbnails/temp files) is
 * never gated.
 *
 * Adoption of pre-existing installs (dirs made by an older version, before this
 * marker existed): a markerless directory is adopted (marker written) ONLY when
 * it is empty OR every top-level entry matches a known app-artifact pattern for
 * that directory kind. Anything unrecognized → refuse to adopt, warn, and leave
 * every sweep on that directory disabled. We bias hard toward refusing: a false
 * refusal costs a warning plus a manual step; a false adoption costs user data.
 */

const fs = require('fs');
const path = require('path');

/** Shared marker filename. */
const MARKER_NAME = '.vault-owned';

const MARKER_CONTENT =
  'Created by Vault — marks this directory as an app-managed cache/temp directory.\n' +
  'Vault only sweeps, wipes, or purges directories that carry this marker.\n' +
  'Do not place personal files here: files matching Vault cache patterns can be deleted.\n';

/**
 * Known app-artifact name patterns per directory KIND. Adoption of a markerless
 * directory succeeds only when every top-level entry matches one of these (or is
 * a known managed subdir / the marker itself). Kept deliberately tight.
 *
 * Patterns are split by ENTRY TYPE and matched against the matching type only:
 *   - `fileRx`  regexes recognize FILE artifacts (matched only when the entry is
 *               a regular file),
 *   - `dirRx`   regexes recognize DIRECTORY artifacts with generated names
 *               (mkdtemp/extraction subdirs), matched only when the entry is a
 *               directory,
 *   - `dirs`    is the set of fixed managed-subdir names (also dirs-only).
 * This keeps a directory that merely happens to be *named* like a file artifact
 * (e.g. a folder literally called `1234.jpg`) from passing as one, and vice
 * versa — a symlink or special file matches neither branch and forces refusal.
 */
const PATTERNS = {
  // thumbnailDir — see lib/thumbnails.js, server beat-audio, migrateFromDisk.
  thumbs: {
    fileRx: [
      /^\d+\.jpg$/,                       // {id}.jpg  (thumbnail)
      /^\d+_s[0-4]\.jpg$/,                // {id}_s{0..4}.jpg  (scrub frame)
      /^\d+_beataudio\.m4a$/,             // {id}_beataudio.m4a  (beat audio)
      /^\d+_beataudio\.aac$/,             // {id}_beataudio.aac  (beat audio, adts)
      /^\d+_beataudio\.(?:m4a|aac)\.part-/, // in-progress atomic-rename temp
    ],
    dirRx: [],
    dirs: new Set(['subtitles', 'pmv_previews']),
  },
  // tempDir — see lib/frame-extractor.js, lib/thumbnails.js buffer helpers,
  // lib/pmv/service.js (vault previews), lib/subtitles working copies.
  temp: {
    fileRx: [
      /^thumb_/, /^scrub_/, /^beat_/,     // per-request buffer temp files
      /^pmvprev_/,                        // vault-mode pmv preview temp
    ],
    dirRx: [
      /^\d+_[a-z0-9]+$/,                  // {ts}_{rand} ephemeral extraction subdir
    ],
    dirs: new Set(['subtitles']),
  },
  // temp_audio — see lib/video-transcriber.js, lib/subtitles/service.js.
  tempaudio: {
    fileRx: [
      /^whisper_server\.py$/,            // sidecar script
    ],
    dirRx: [
      /^\d+_[a-z0-9]+$/,                  // createTempDir uniqueId
      /^subs_/, /^patch_/,               // mkdtemp prefixes
    ],
    dirs: new Set([]),
  },
  // streamCacheDir (VAULT_STREAM_CACHE) — see lib/stream/store.js. Holds one
  // subdirectory per media id, each full of {n}.ts HLS segments.
  streamcache: {
    fileRx: [],
    dirRx: [
      /^\d+$/,                            // {mediaId}/ — the per-file segment dir
    ],
    dirs: new Set([]),
  },
  // redirected subtitles root (VAULT_SUBS) — see lib/subtitles/repo.js,
  // secure-assets migrateFromDisk. Holds only {id}.{lang}.vtt track files.
  subs: {
    fileRx: [
      /^\d+\.[A-Za-z_]{1,12}\.vtt$/,     // {id}.{lang}.vtt  (subtitle track)
    ],
    dirRx: [],
    dirs: new Set([]),
  },
};

function markerPath(dir) {
  return path.join(dir, MARKER_NAME);
}

/** True when `dir` carries the app-owned marker. */
function isOwned(dir) {
  try {
    return fs.existsSync(markerPath(dir));
  } catch {
    return false;
  }
}

/** Write the marker into `dir` (creating `dir` if needed). Idempotent. */
function markOwned(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markerPath(dir), MARKER_CONTENT);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a markerless `dir` may be adopted. Returns the list of
 * unrecognized entries (empty ⇒ adoptable). Missing dir ⇒ adoptable (empty).
 */
function _unrecognizedEntries(dir, kind) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { missing: true, unrecognized: [] };
  }
  return { missing: false, unrecognized: _classifyEntries(names, kind) };
}

/** Shared classification loop over Dirent entries (see _unrecognizedEntries). */
function _classifyEntries(names, kind) {
  const pat = PATTERNS[kind];
  const unrecognized = [];
  for (const ent of names) {
    if (ent.name === MARKER_NAME) continue;
    // Type-matched recognition: a directory is only ever recognized by a known
    // subdir name or a dir-name regex; a file only by a file regex. Anything
    // that is neither a plain dir nor a plain file (symlink, socket, …) matches
    // neither branch and is treated as unrecognized — biasing toward refusal.
    let ok = false;
    if (ent.isDirectory()) {
      ok = pat.dirs.has(ent.name) || pat.dirRx.some(rx => rx.test(ent.name));
    } else if (ent.isFile()) {
      ok = pat.fileRx.some(rx => rx.test(ent.name));
    }
    if (!ok) unrecognized.push(ent.name);
  }
  return unrecognized;
}

/**
 * Ensure `dir` exists and, if it is not already marked, adopt it when safe.
 * Silent (no logging) — for use at directory-creation sites. When the app
 * freshly creates the dir it is empty ⇒ adopted; a pre-existing all-app-pattern
 * dir is also adopted; a dir holding unrecognized files is left unmarked.
 * @returns {boolean} whether the dir is owned after the call.
 */
function ensureManaged(dir, kind) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* fall through — isOwned will report false */ }
  if (isOwned(dir)) return true;
  const { unrecognized } = _unrecognizedEntries(dir, kind);
  if (unrecognized.length === 0) return markOwned(dir);
  return false;
}

/**
 * Startup adoption pass with logging. If `dir` exists without a marker: adopt it
 * when empty / all-app-pattern (writing the marker), otherwise log a prominent
 * warning naming the offending entries and leave it unmarked. Missing dirs are a
 * no-op (they'll be created+marked on demand).
 * @returns {'owned'|'adopted'|'refused'|'absent'}
 */
function adoptOnStartup(dir, kind, label = kind) {
  if (isOwned(dir)) return 'owned';
  const { missing, unrecognized } = _unrecognizedEntries(dir, kind);
  return _decideAdoption(dir, label, missing, unrecognized);
}

/**
 * Async twin of adoptOnStartup — same decision and logging, but the directory
 * read never blocks the event loop. For the startup pass over roots that can
 * be huge and cold (a whole library's thumbnails on a spun-down disk): the
 * server keeps answering requests while the readdir is in flight.
 * @returns {Promise<'owned'|'adopted'|'refused'|'absent'>}
 */
async function adoptOnStartupAsync(dir, kind, label = kind) {
  if (isOwned(dir)) return 'owned';
  let names;
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 'absent';
  }
  return _decideAdoption(dir, label, false, _classifyEntries(names, kind));
}

/** Shared adopt-or-refuse tail of the startup passes above. */
function _decideAdoption(dir, label, missing, unrecognized) {
  if (missing) return 'absent';
  if (unrecognized.length === 0) {
    markOwned(dir);
    return 'adopted';
  }
  const sample = unrecognized.slice(0, 5).join(', ');
  const more = unrecognized.length > 5 ? `, +${unrecognized.length - 5} more` : '';
  console.warn(
    `[owned-dir] NOT adopting ${label} directory ${dir}: it contains ${unrecognized.length} ` +
    `unrecognized entr${unrecognized.length === 1 ? 'y' : 'ies'} (${sample}${more}). ` +
    `Vault will REFUSE to sweep/clean it. If this really is an app cache directory, ` +
    `clean it out or create the marker file "${MARKER_NAME}" inside it manually; ` +
    `otherwise point ${label} at a dedicated folder.`
  );
  return 'refused';
}

/**
 * Gate a destructive whole-directory sweep. Returns true only when `dir` is
 * app-owned; otherwise logs one clear refusal warning and returns false so the
 * caller SKIPS the sweep.
 */
function guardSweep(dir, label) {
  if (isOwned(dir)) return true;
  console.warn(
    `[owned-dir] refusing to sweep ${dir}: not marked as app-owned ` +
    `(missing ${MARKER_NAME}) — ${label} skipped.`
  );
  return false;
}

module.exports = {
  MARKER_NAME,
  markerPath,
  isOwned,
  markOwned,
  ensureManaged,
  adoptOnStartup,
  adoptOnStartupAsync,
  guardSweep,
};
