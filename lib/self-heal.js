/**
 * Self-heal — un-stick rows that failed only because a tool was missing.
 *
 * Every tool-missing processing_error this app writes ends in an instruction:
 * install ffmpeg, pip install faster-whisper. Doing exactly what the message
 * said used to fix nothing — the row kept its stale ⚠ and its null duration
 * forever, and because getProcessingStatus() maps a stamped error to
 * 'other_error', later scans skipped the file too. The only way out was a
 * per-file rescan nobody is told about.
 *
 * So: on boot (and right after the in-app ffmpeg download), find those rows and,
 * IF the tool has since appeared, put them back to the 'unscanned' sentinel that
 * fresh imports use — ⏳ on the tile, and picked up by the next scan. ffprobe
 * results are cheap and immediate, so duration/width/height are re-probed here
 * too rather than waiting for a scan the user may never run.
 *
 * Rules this file lives by:
 *   • Never throw. A healer that breaks startup is worse than a stale badge.
 *   • Never spawn a probe unless a matching row exists — the whisper check
 *     forks pip, so it must never run on a request path or on a clean library.
 *   • Never touch a row whose file is gone from disk.
 *   • One summary line, not per-file spam.
 */

const fs = require('fs');
const db = require('./database');
const mediaInfo = require('./media-info');
const perr = require('./processing-errors');

const UNSCANNED = db.UNSCANNED_MARKER;

/** Rows stamped with a tool-missing error, by message prefix. */
function _rowsWithErrorPrefix(prefix) {
  return db.get()
    .prepare("SELECT id, filepath FROM media WHERE processing_error LIKE ? || '%'")
    .all(prefix);
}

/**
 * ffmpeg/ffprobe arrived → re-probe the rows that failed without it.
 * @returns {Promise<number>} rows healed
 */
async function _healFfprobeRows() {
  const rows = _rowsWithErrorPrefix(perr.FFPROBE_MISSING_PREFIX);
  if (!rows.length) return 0;
  if (!mediaInfo.isAvailable()) return 0;

  const update = db.get().prepare(`
    UPDATE media SET duration_seconds = ?, width = ?, height = ?, processing_error = ?
    WHERE id = ?
  `);

  let healed = 0;
  for (const row of rows) {
    if (!row.filepath || !fs.existsSync(row.filepath)) continue;  // moved/deleted — leave it
    let info = null;
    try {
      info = await mediaInfo.getInfo(row.filepath);
    } catch { /* a bad file is not a reason to stop healing the rest */ }
    if (!info) continue;
    try {
      update.run(info.duration || null, info.width || null, info.height || null, UNSCANNED, row.id);
      healed++;
    } catch { /* row vanished mid-pass */ }
  }
  return healed;
}

/**
 * faster-whisper arrived → make the audio rows scannable again.
 *
 * Two sets, both retryable and both invisible until now:
 *   1. rows stamped with the tool-missing transcription error (current builds),
 *   2. the legacy lie — status success, no transcription, and the placeholder
 *      description the old audio processor wrote, which made every later scan
 *      skip the file permanently.
 * @param {{dryRun?: boolean}} opts
 * @returns {number} rows healed (or, with dryRun, rows that WOULD be healed)
 */
function _healWhisperRows({ dryRun = false } = {}) {
  const d = db.get();
  const errored = _rowsWithErrorPrefix(perr.WHISPER_MISSING_PREFIX).map(r => r.id);

  // Legacy: media_type audio + no error + no transcription + the placeholder.
  const legacy = d.prepare(`
    SELECT id FROM media
    WHERE media_type = 'audio'
      AND processing_error IS NULL
      AND (audio_transcription IS NULL OR audio_transcription = '')
      AND description LIKE ? || ?
  `).all('%', perr.AUDIO_PLACEHOLDER_SUFFIX).map(r => r.id);

  const ids = [...new Set([...errored, ...legacy])];
  if (!ids.length || dryRun) return ids.length;

  // Only NOW is the pip probe worth its cost.
  if (!require('./video-transcriber').isFasterWhisperAvailable()) return 0;

  // The placeholder description and the model_used 'lm-studio' stamp were both
  // fiction — no model ever ran. Clear them with the reset so the row reads as
  // "not scanned yet" rather than "scanned, and this is what we found".
  const reset = d.prepare(`
    UPDATE media SET processing_error = ?, description = '', model_used = NULL
    WHERE id = ?
  `);
  let healed = 0;
  const tx = d.transaction((list) => {
    for (const id of list) healed += reset.run(UNSCANNED, id).changes;
  });
  try { tx(ids); } catch { return 0; }
  return healed;
}

/**
 * Count the legacy audio rows the whisper backfill would touch, without
 * probing for python or writing anything. Verification/reporting aid.
 * @returns {number}
 */
function countWhisperHealable() {
  try {
    return _healWhisperRows({ dryRun: true });
  } catch {
    return 0;
  }
}

/**
 * Run every healer. Fire-and-forget: callers must NOT await this on a path a
 * user is waiting on (it re-probes files and may fork pip).
 * @param {{reason?: string}} opts - shown in the log line
 * @returns {Promise<{ffprobe: number, whisper: number}>}
 */
async function run({ reason = 'startup' } = {}) {
  const out = { ffprobe: 0, whisper: 0 };
  try {
    out.ffprobe = await _healFfprobeRows();
  } catch (err) {
    console.warn(`[Self-heal] ffprobe pass skipped: ${err.message}`);
  }
  try {
    out.whisper = _healWhisperRows();
  } catch (err) {
    console.warn(`[Self-heal] transcription pass skipped: ${err.message}`);
  }

  if (out.ffprobe) {
    console.log(`[Self-heal] re-probed ${out.ffprobe} file(s) after ffmpeg became available (${reason}) — queued for rescan`);
  }
  if (out.whisper) {
    console.log(`[Self-heal] reset ${out.whisper} audio file(s) for rescan now that faster-whisper is available (${reason})`);
  }
  return out;
}

module.exports = { run, countWhisperHealable };
