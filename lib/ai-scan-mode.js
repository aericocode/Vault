/**
 * Settings > General > AI scan: whether Vault tags and describes files with a
 * local AI model (LM Studio) at all.
 *
 *   'on'    today's behaviour: new files are scanned, the panel shows, etc.
 *   'off'   no AI scan anywhere: nothing is queued, no prompt or nudge, no
 *           look at LM Studio, no model loaded or unloaded by Vault. Importing,
 *           thumbnails, faces, subtitles and the rest work as before.
 *   'auto'  as On, but nothing is scanned while something plays (see
 *           lib/playback-activity.js and lib/import-queue.js).
 *
 * "AI scan" here means the AI tagging only (lib/import-queue.js, single-file
 * rescans, lib/scan-model.js, lib/ai-slots.js discovery). Stored with the other
 * server settings (lib/app-settings.js) and applied live: listeners hear every
 * change.
 */

const appSettings = require('./app-settings');

const MODES = ['off', 'on', 'auto'];
const DEFAULT = 'on';
const KEY = 'aiScan';

function _valid(v) {
  return typeof v === 'string' && MODES.includes(v);
}

let _mode = (() => {
  const v = appSettings.all()[KEY];
  return _valid(v) ? v : DEFAULT;
})();

const _listeners = [];

/** 'off' | 'on' | 'auto' */
function get() {
  return _mode;
}

function isOff() {
  return _mode === 'off';
}

function isAuto() {
  return _mode === 'auto';
}

/**
 * Change the mode (validated). Stores it and tells every listener.
 * @returns {string} the mode now in force
 * @throws {Error} with .code 'BAD_MODE' for anything but off / on / auto
 */
function set(mode, { persist = true } = {}) {
  if (!_valid(mode)) {
    throw Object.assign(new Error('aiScan must be off, on or auto'), { code: 'BAD_MODE' });
  }
  const prev = _mode;
  _mode = mode;
  if (persist) appSettings.set({ [KEY]: mode });
  if (prev !== mode) {
    for (const fn of _listeners) {
      try { fn(mode, prev); } catch (err) { console.warn(`[AI scan] listener failed: ${err.message}`); }
    }
  }
  return _mode;
}

function onChange(fn) {
  if (typeof fn === 'function') _listeners.push(fn);
}

/** The words a refused request carries, so every route says the same thing. */
const OFF_ERROR = 'AI scan is off. Turn it on in Settings > General to scan files.';
const OFF_CODE = 'AI_SCAN_OFF';

module.exports = { get, set, isOff, isAuto, onChange, MODES, DEFAULT, KEY, OFF_ERROR, OFF_CODE };
