/**
 * Share privately: names, passwords and the copy block (spec 6.1, section 5).
 * Pure functions, no I/O.
 *
 *  - Random archive names: 12 characters a-z A-Z 0-9.
 *  - Random passwords: 24 characters from the same set, in groups of four
 *    joined by dashes (the dashes are part of the password, 29 characters in
 *    all). Both from crypto.randomInt, which is the system's secure source and
 *    has no modulo bias.
 *  - A typed archive name keeps letters, digits, space, dash, underscore and
 *    dot, at most 80 characters, without leading or trailing spaces or dots.
 *    Windows device names (CON, NUL, COM1 ...) are refused.
 *  - Names inside the archive: the base name only; a repeat gets " (2)",
 *    " (3)" before the extension (compared without case, as Windows does).
 */

const crypto = require('crypto');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomString(n) {
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

function randomArchiveName() { return randomString(12); }

function randomPassword() {
  const raw = randomString(24);
  return raw.match(/.{4}/g).join('-');
}

const NAME_MAX = 80;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Clean a typed archive name. Returns '' when nothing usable is left (the
 * caller then uses a random name) and throws BAD_NAME for a device name.
 */
function cleanTypedName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/[^A-Za-z0-9 _.\-]/g, '').slice(0, NAME_MAX);
  s = s.replace(/^[\s.]+|[\s.]+$/g, '');
  if (!s) return '';
  if (RESERVED.test(s.split('.')[0].trim())) {
    throw Object.assign(new Error('That name cannot be used for a file. Pick another one.'), { code: 'BAD_NAME' });
  }
  return s;
}

/** True for a name Vault would produce itself (checked again before use). */
function isSafeArchiveName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= NAME_MAX
    && /^[A-Za-z0-9 _.\-]+$/.test(s) && !/^[\s.]|[\s.]$/.test(s)
    && !RESERVED.test(s.split('.')[0].trim());
}

/**
 * Give each base name a unique spelling: "clip.mp4", "clip (2).mp4", ...
 * @param {string[]} names
 * @returns {string[]} same order
 */
function uniqueNames(names) {
  const taken = new Set();
  const out = [];
  for (const name of names) {
    let candidate = name;
    if (taken.has(candidate.toLowerCase())) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      for (let i = 2; ; i++) {
        candidate = `${stem} (${i})${ext}`;
        if (!taken.has(candidate.toLowerCase())) break;
      }
    }
    taken.add(candidate.toLowerCase());
    out.push(candidate);
  }
  return out;
}

/* ── Copy block ──────────────────────────────────────────────────────────── */

const READY_FORMATS = {
  // "Link, then pass: line (default)"
  default: '{link}\npass: {pass}',
  // "One line: code and pass"
  oneLine: 'code: {code} | pass: {pass}',
};
const FORMAT_MAX = 500;

/**
 * Fill a copy format. Only the four known pieces are replaced, in one pass,
 * so a value that itself contains "{pass}" is never expanded again. Anything
 * else in braces stays exactly as typed.
 * When the format needs the password and it is not available (not
 * remembered), the block is the link alone (spec section 5).
 */
function renderBlock(format, { link = '', code = '', pass = null, name = '' } = {}) {
  format = String(format);
  if ((pass === null || pass === undefined) && format.includes('{pass}')) return String(link || '');
  const values = { link: link || '', code: code || '', pass: pass || '', name: name || '' };
  return format.replace(/\{(link|code|pass|name)\}/g, (_, k) => values[k]);
}

function formatFor(settings) {
  if (settings.copyFormat === 'custom' && typeof settings.customFormat === 'string' && settings.customFormat.trim()) {
    return settings.customFormat;
  }
  return READY_FORMATS[settings.copyFormat] || READY_FORMATS.default;
}

module.exports = {
  ALPHABET, randomString, randomArchiveName, randomPassword,
  cleanTypedName, isSafeArchiveName, uniqueNames, NAME_MAX,
  READY_FORMATS, FORMAT_MAX, renderBlock, formatFor,
};
