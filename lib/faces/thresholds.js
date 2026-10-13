/**
 * Match-width thresholds for face search: the minimum cosine similarity a
 * file's best face needs to count as "this person". The UI never shows these
 * numbers, only the three labels (Close matches / Normal / Cast a wider net).
 *
 * The values are calibrated per embedding model and live in ONE place,
 * lib/faces/models.js (MATCH_THRESHOLDS: sface-2021dec close 0.50, normal
 * 0.42, wide 0.36). THRESHOLDS here is the shipping model's table.
 */

const { matchThresholds } = require('./models');

const DEFAULT_MODEL = 'sface-2021dec';
const THRESHOLDS = Object.freeze({ ...matchThresholds(DEFAULT_MODEL) });
const WIDTHS = Object.freeze(['close', 'normal', 'wide']);

/**
 * Threshold for a width name; unknown or missing widths mean 'normal'.
 * modelId picks that model's calibration (defaults to the shipping model).
 */
function thresholdFor(width, modelId = DEFAULT_MODEL) {
  let t = THRESHOLDS;
  try { t = matchThresholds(modelId); } catch { /* unknown model: shipping table */ }
  return WIDTHS.includes(width) ? t[width] : t.normal;
}

/**
 * People sorting thresholds for a model: { people, suggest } (see models.js).
 * Unknown models use the shipping model's numbers.
 */
function peopleThresholds(modelId = DEFAULT_MODEL) {
  let t = THRESHOLDS;
  try { t = matchThresholds(modelId); } catch { /* unknown model: shipping table */ }
  return { people: t.people, suggest: t.suggest };
}

module.exports = { THRESHOLDS, WIDTHS, thresholdFor, peopleThresholds };
