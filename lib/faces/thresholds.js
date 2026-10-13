/**
 * Match-width thresholds for face search: the minimum cosine similarity a
 * file's best face needs to count as "this person". The UI never shows these
 * numbers, only the three labels (Close matches / Normal / Cast a wider net).
 *
 * PLACEHOLDER VALUES. The engine calibration (FACES_BUILD_SPEC section 9)
 * replaces them; this table is the ONE place they live.
 */

const THRESHOLDS = Object.freeze({
  close: 0.48,
  normal: 0.40,
  wide: 0.32,
});

const WIDTHS = Object.freeze(Object.keys(THRESHOLDS));

/** Threshold for a width name; unknown or missing widths mean 'normal'. */
function thresholdFor(width) {
  return Object.prototype.hasOwnProperty.call(THRESHOLDS, width) ? THRESHOLDS[width] : THRESHOLDS.normal;
}

module.exports = { THRESHOLDS, WIDTHS, thresholdFor };
