/**
 * Setup notices the user chose to hide ("Don't show again" on the setup banner).
 *
 * Stored server side, in vault-settings.json (lib/app-settings.js), not in the
 * browser: the banner is about this machine's tools, so hiding it should hold
 * on this computer and in every browser that opens this library, the same way
 * passwordPromptSeen does.
 *
 * Only OPTIONAL tools can be hidden. A required tool (ffmpeg) blocks imports,
 * so its notice always shows while it is missing, whatever the file says.
 */

const SETTINGS_KEY = 'hiddenSetupNotices';

/**
 * The stored list, cleaned against the current tool registry: known keys only,
 * optional tools only, no duplicates. A hand-edited or stale file can't hide
 * ffmpeg or smuggle in junk.
 * @param {unknown} raw   whatever is stored under SETTINGS_KEY
 * @param {Record<string, {required?: boolean}>} tools   checkTools() output
 * @returns {string[]}
 */
function sanitizeHidden(raw, tools) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const key of raw) {
    if (typeof key !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(tools || {}, key)) continue;
    if (!tools[key] || tools[key].required) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * A copy of the tool map with `hidden` set per tool. Never mutates the input
 * (the caller's object is a cache). Required tools are always hidden: false.
 */
function annotate(tools, hidden) {
  const out = {};
  for (const [key, t] of Object.entries(tools || {})) {
    out[key] = { ...t, hidden: !t.required && hidden.includes(key) };
  }
  return out;
}

/**
 * Validate a POST body and return the new list, or an error for a 400.
 * @returns {{ok: true, hidden: string[]} | {ok: false, error: string}}
 */
function applyChange(current, body, tools) {
  const tool = typeof body?.tool === 'string' ? body.tool : '';
  if (!tool || !Object.prototype.hasOwnProperty.call(tools || {}, tool)) {
    return { ok: false, error: 'unknown tool' };
  }
  if (tools[tool].required) {
    return { ok: false, error: 'required tools are always shown when missing' };
  }
  if (typeof body.hidden !== 'boolean') {
    return { ok: false, error: 'hidden must be true or false' };
  }
  const list = sanitizeHidden(current, tools).filter((k) => k !== tool);
  if (body.hidden) list.push(tool);
  return { ok: true, hidden: list };
}

module.exports = { SETTINGS_KEY, sanitizeHidden, annotate, applyChange };
