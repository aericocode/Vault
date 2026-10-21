/**
 * Thumbnail settings: when thumbnails are made, how they are kept, whether
 * hover frames are made at all, and whether pictures already inside files
 * (album art, video cover art) are used instead.
 *
 * Whole-library and server side, stored in vault-settings.json (lib/app-settings)
 * under one `thumbnails` key, so the viewer server and the scan CLI (a separate
 * process) obey the same values. Reads are cached for a few seconds: the /thumb
 * route asks on every tile, and a running CLI scan still picks up a change made
 * in the viewer within that time.
 *
 * Defaults are today's behaviour: made for every file during scans, kept on
 * disk, hover frames on. "Use pictures already inside files" is on by default.
 */

const appSettings = require('./app-settings');

const MAKE = ['off', 'all', 'shown'];      // Off | For every file | When shown
const KEEP = ['keep', 'cap', 'memory'];    // Keep them | Keep up to N | Only while running

const MB = 1024 * 1024;
const BOUNDS = {
  memoryMB: { min: 50, max: 4096, def: 300 },          // 50 MB to 4 GB
  diskCapMB: { min: 100, max: 1024 * 1024, def: 2048 }, // 100 MB to 1024 GB
};

const DEFAULTS = Object.freeze({
  make: 'all',
  keep: 'keep',
  diskCapMB: BOUNDS.diskCapMB.def,
  memoryMB: BOUNDS.memoryMB.def,
  hover: true,
  inside: true,
});

const CACHE_MS = 3000;
let _cache = null;
let _cacheAt = 0;

function _validInt(v, b) {
  return typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max;
}

/** Fill in defaults for anything absent or unusable in a stored object. */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    make: MAKE.includes(r.make) ? r.make : DEFAULTS.make,
    keep: KEEP.includes(r.keep) ? r.keep : DEFAULTS.keep,
    diskCapMB: _validInt(r.diskCapMB, BOUNDS.diskCapMB) ? r.diskCapMB : DEFAULTS.diskCapMB,
    memoryMB: _validInt(r.memoryMB, BOUNDS.memoryMB) ? r.memoryMB : DEFAULTS.memoryMB,
    hover: typeof r.hover === 'boolean' ? r.hover : DEFAULTS.hover,
    inside: typeof r.inside === 'boolean' ? r.inside : DEFAULTS.inside,
    // Not a user setting: added to every thumbnail URL by the viewer, and
    // bumped when browsers must stop using what they cached (bumpSalt).
    salt: Number.isSafeInteger(r.salt) && r.salt >= 0 ? r.salt : 0,
  };
}

/** The settings in force (cached briefly). */
function get() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_MS) return _cache;
  _cache = normalize(appSettings.all().thumbnails);
  _cacheAt = now;
  return _cache;
}

function _sizeText(mb) {
  return mb >= 1024 ? `${+(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
}

/**
 * Check a patch from the viewer. Returns { value } (the full new settings) or
 * { error } with a sentence the panel can show as it is.
 */
function validate(patch, current = get()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'Nothing to change.' };
  const next = { ...current };
  let any = false;
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'make':
        if (!MAKE.includes(v)) return { error: 'Make thumbnails must be "off", "all" or "shown".' };
        break;
      case 'keep':
        if (!KEEP.includes(v)) return { error: 'Keep must be "keep", "cap" or "memory".' };
        break;
      case 'diskCapMB':
      case 'memoryMB': {
        const b = BOUNDS[k];
        if (!_validInt(v, b)) {
          const what = k === 'memoryMB' ? 'The memory limit' : 'The disk limit';
          return { error: `${what} must be a whole number of MB from ${_sizeText(b.min)} to ${_sizeText(b.max)}.` };
        }
        break;
      }
      case 'hover':
      case 'inside':
        if (typeof v !== 'boolean') return { error: `${k} must be true or false.` };
        break;
      default:
        return { error: `Unknown setting: ${k}` };
    }
    next[k] = v;
    any = true;
  }
  if (!any) return { error: 'Nothing to change.' };
  return { value: next };
}

/** Validate and store a patch. Returns { value } or { error }. */
function update(patch) {
  const r = validate(patch);
  if (r.error) return r;
  appSettings.set({ thumbnails: r.value });
  _cache = r.value;
  _cacheAt = Date.now();
  return r;
}

/** New thumbnail URLs for every tile (see normalize: salt). Returns the settings. */
function bumpSalt() {
  const next = { ...get(), salt: get().salt + 1 };
  appSettings.set({ thumbnails: next });
  _cache = next;
  _cacheAt = Date.now();
  return next;
}

/** Drop the read cache (tests, and after an external edit). */
function _resetCache() { _cache = null; _cacheAt = 0; }

/**
 * Where pictures made from now on go: 'keep' (stored as today), 'cap' (stored,
 * trimmed to the disk limit) or 'memory' (server memory only). "For every file"
 * always stores, so the keep choice only applies under "When shown". 'off' =
 * thumbnails are switched off: nothing is made, stored or served.
 */
function storage(s = get()) {
  if (s.make === 'off') return 'off';
  return s.make === 'all' ? 'keep' : s.keep;
}

/** Should a scan or import make the cover now? */
function scanMakes(s = get()) {
  return s.make === 'all';
}

module.exports = {
  get, validate, update, normalize, storage, scanMakes, bumpSalt, _resetCache,
  DEFAULTS, BOUNDS, MB,
};
