/**
 * Share privately: the plain settings (spec section 5).
 *
 * Kept by the SERVER, in Vault's app settings file (lib/app-settings.js,
 * under the one key "share"), next to the other settings the server acts on.
 * The on/off switch in particular is never a browser-only flag: the gofile
 * client (lib/share/gofile.js) reads it again before every request, and the
 * routes read it before starting anything.
 *
 * Nothing secret lives here: no passwords, no tokens, no share records. Those
 * are in the library database (lib/share/store.js).
 *
 * Every value is checked on write AND on read, so a hand-edited file can only
 * ever produce one of the allowed values (anything else falls back to the
 * default).
 */

const appSettings = require('../app-settings');
const names = require('./names');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const PART_PRESETS = { '500m': 500 * MB, '1g': GB, '2g': 2 * GB, '4g': 4 * GB };
const CUSTOM_MIN = 50 * MB;
const CUSTOM_MAX = 16 * GB;

const DEFAULTS = Object.freeze({
  enabled: false,
  passwordChoice: 'random',      // 'random' | 'saved'
  deleteAfterDays: 7,            // 1 | 7 | 30 | 0 (= never)
  split: '2g',                   // '500m' | '1g' | '2g' | '4g' | 'custom' | 'none'
  customPartBytes: 2 * GB,       // 50 MB .. 16 GB, used when split = 'custom'
  nameMode: 'typed',             // 'typed' (I can type my own) | 'random' (always random)
  keepLocal: false,              // keep the packed archive after upload
  afterPack: 'wait',             // 'wait' (Wait for me to check) | 'upload' (Upload on its own), see service.js
  onPartFail: 'retry3',          // 'retry3' | 'ask'
  accountMode: 'perStart',       // 'perStart' | 'perShare' | 'keep'
  copyFormat: 'default',         // 'default' | 'oneLine' | 'custom'
  customFormat: '{link}\npass: {pass}',
  rememberPasswords: true,
  rememberFiles: true,
  hideInPrivacy: true,
  topBarIcon: true,
});

const CHOICES = {
  passwordChoice: ['random', 'saved'],
  deleteAfterDays: [1, 7, 30, 0],
  split: ['500m', '1g', '2g', '4g', 'custom', 'none'],
  nameMode: ['typed', 'random'],
  afterPack: ['wait', 'upload'],
  onPartFail: ['retry3', 'ask'],
  accountMode: ['perStart', 'perShare', 'keep'],
  copyFormat: ['default', 'oneLine', 'custom'],
};
const BOOLS = ['enabled', 'keepLocal', 'rememberPasswords', 'rememberFiles', 'hideInPrivacy', 'topBarIcon'];

function _clean(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULTS };
  for (const k of BOOLS) if (typeof s[k] === 'boolean') out[k] = s[k];
  for (const [k, list] of Object.entries(CHOICES)) if (list.includes(s[k])) out[k] = s[k];
  if (Number.isInteger(s.customPartBytes) && s.customPartBytes >= CUSTOM_MIN && s.customPartBytes <= CUSTOM_MAX) {
    out.customPartBytes = s.customPartBytes;
  }
  if (typeof s.customFormat === 'string' && s.customFormat.length <= names.FORMAT_MAX) out.customFormat = s.customFormat;
  return out;
}

/** The current settings, always complete and valid. */
function get() {
  return _clean(appSettings.all().share);
}

function isEnabled() {
  return get().enabled === true;
}

/** Part size in bytes for the current settings, or null for "do not split". */
function partBytes(s = get()) {
  if (s.split === 'none') return null;
  if (s.split === 'custom') return s.customPartBytes;
  return PART_PRESETS[s.split];
}

function _bad(message) {
  return Object.assign(new Error(message), { code: 'BAD_INPUT' });
}

/**
 * Check a patch from the page. Throws BAD_INPUT with a plain message for the
 * first bad value; nothing is saved then (the last good values stay).
 */
function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw _bad('Nothing to change.');
  const out = {};
  for (const [k, v] of Object.entries(patch)) {
    if (BOOLS.includes(k)) {
      if (typeof v !== 'boolean') throw _bad(`${k} must be true or false.`);
      out[k] = v;
    } else if (k in CHOICES) {
      if (!CHOICES[k].includes(v)) throw _bad(`${k} is not one of the choices.`);
      out[k] = v;
    } else if (k === 'customPartBytes') {
      if (!Number.isInteger(v) || v < CUSTOM_MIN || v > CUSTOM_MAX) {
        throw Object.assign(_bad('The part size must be between 50 MB and 16 GB.'), { code: 'BAD_PART_SIZE' });
      }
      out[k] = v;
    } else if (k === 'customFormat') {
      if (typeof v !== 'string' || v.length > names.FORMAT_MAX) throw _bad(`The copy format can be at most ${names.FORMAT_MAX} characters.`);
      if (!v.trim()) throw _bad('The copy format is empty.');
      out[k] = v;
    } else {
      throw _bad(`Unknown setting: ${String(k).slice(0, 40)}.`);
    }
  }
  return out;
}

/** Save an already validated patch. Returns the new settings. */
function save(validPatch) {
  const next = _clean({ ...get(), ...validPatch });
  appSettings.set({ share: next });
  return next;
}

/** Everything back to the defaults, except the on/off switch (see report). */
function reset() {
  const keep = get().enabled;
  return save({ ...DEFAULTS, enabled: keep });
}

module.exports = { get, isEnabled, partBytes, validatePatch, save, reset, DEFAULTS, PART_PRESETS, CUSTOM_MIN, CUSTOM_MAX, MB, GB };
