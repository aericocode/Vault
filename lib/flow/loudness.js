/**
 * Even out loudness on Stage (mpv only): the gain for one file from its
 * measured loudness (lib/flow/analyze.js).
 *
 *   gain = -16 LUFS - the file's integrated loudness, clamped to +-12 dB
 *
 * -16 LUFS sits between the streaming services' -14 and broadcast's -23: a
 * quiet file comes up without leaving the loud ones too far down, and leaves
 * some headroom. A file is never turned up past its own peak: positive gain
 * stops at 1 dB under full scale for the file's true peak (ffmpeg's ebur128
 * meter, 4x oversampled at the source rate; on a long file, over the parts
 * Vault decoded), rounded down to 0.1 dB. Turning down is always allowed.
 * With no peak reading at all, a file is turned up by 3 dB at most (logged
 * once). Unmeasured or silent files get no gain.
 */

const TARGET_LUFS = -16;
const MAX_GAIN_DB = 12;
const PEAK_CEILING_DB = -1;
const NO_PEAK_MAX_DB = 3;        // positive gain for a file with no peak reading
let warnedNoPeak = false;

/** @returns {number|null} dB, one decimal, or null for no change */
function gainDb(row, { target = TARGET_LUFS, max = MAX_GAIN_DB } = {}) {
  if (!row || row.error || row.lufs == null || !Number.isFinite(row.lufs)) return null;
  let g = Math.max(-max, Math.min(max, target - row.lufs));
  if (g > 0) {
    // Up only as far as the true peak allows, rounded down so it never passes the ceiling.
    if (row.peak_db != null && Number.isFinite(row.peak_db)) g = Math.max(0, Math.min(g, PEAK_CEILING_DB - row.peak_db));
    else {
      // No peak reading (ffmpeg's meter said nothing we could read): up a little only.
      g = Math.min(g, NO_PEAK_MAX_DB);
      if (!warnedNoPeak) { warnedNoPeak = true; console.warn('[Flow] a file has no true-peak reading: Even out loudness turns it up by at most 3 dB.'); }
    }
    g = Math.floor(g * 10 + 1e-9) / 10;
  } else {
    g = Math.round(g * 10) / 10;
  }
  return Math.abs(g) < 0.05 ? 0 : g;
}

module.exports = { gainDb, TARGET_LUFS, MAX_GAIN_DB, PEAK_CEILING_DB, NO_PEAK_MAX_DB };
