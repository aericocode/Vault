/**
 * content_type check for what the AI writes.
 *
 * The scan stores the model's `content_type` (images, GIFs, videos) or
 * `document_type` (documents, audio transcripts) as it came back in the JSON.
 * A model is free to answer with anything: a sentence, a made-up category, or
 * markup that the viewer then shows. So the value is checked against the
 * lists the prompts offer (config/prompts.js) before it is saved, and
 * anything else is stored as 'other', the value the prompts already use for
 * "none of these".
 *
 * Only the scan's writes go through here (db.saveMedia: scan, rescan and the
 * duplicate clone, which copies its match's value). A value the owner types
 * in the metadata editor is theirs and is kept as typed; the viewer escapes
 * every content_type it shows either way.
 */

const { CONTENT_TYPES, DOCUMENT_TYPES } = require('../config/prompts');

// Chosen by the processors themselves, not by the model: an audio file with
// no transcript, a document the model could not read, a file with no answer.
const PROCESSOR_TYPES = ['audio', 'document', 'unknown'];

const ALLOWED = new Set([...CONTENT_TYPES, ...DOCUMENT_TYPES, ...PROCESSOR_TYPES]);

/**
 * @param {*} value the model's answer
 * @returns {string} an allowed value; 'unknown' when there was no answer,
 *   'other' when the answer is not one of the choices
 */
function normalizeContentType(value) {
  if (value == null) return 'unknown';
  if (typeof value !== 'string') return 'other';
  // Forgive spelling, not content: "Live Action" and "live-action" are the
  // choice the prompt offered as live_action.
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!key) return 'unknown';
  return ALLOWED.has(key) ? key : 'other';
}

module.exports = { normalizeContentType, ALLOWED_CONTENT_TYPES: ALLOWED };
