/**
 * Stage settings (PLAYLISTS_SPEC 5, "Settings › Stage"): what the Settings
 * page shows and the Stage window acts on.
 *
 * They live on the server (vault-settings.json, key "stage"), not in the
 * viewer's localStorage, because the server runs Stage (mpv) and acts on
 * them: the window name is mpv's title, the size preset sets the window size,
 * the name and picture times drive what mpv shows.
 *
 * Where mpv is lives under its own key ("stageMpv"), set only by the native
 * file picker (server/stage-routes.js): nothing here, and no POST, can set it.
 *
 * normalize() is pure: it takes anything (a stored object, a POST body) and
 * gives back a complete, valid settings object. Unknown keys are dropped and a
 * bad value falls back to what was there before (or the default).
 */

const SIZE_PRESETS = Object.freeze({
  '720p': Object.freeze({ w: 1280, h: 720 }),
  '1080p': Object.freeze({ w: 1920, h: 1080 }),
  '1440p': Object.freeze({ w: 2560, h: 1440 }),
});
const OPEN_SIZES = ['free', ...Object.keys(SIZE_PRESETS)];

const DEFAULTS = Object.freeze({
  showName: true,         // the file's name, lower left, as a file starts
  nameSeconds: 3,
  windowName: 'Vault Stage',
  imageSeconds: 8,        // pictures; GIFs play at least one full loop
  cursorSeconds: 1,       // the cursor hides after this long without moving
  openSize: 'free',       // 'free' (last size and spot) | a preset
  muteVault: true,        // Vault's own sound is off while Stage is open
  tips: true,             // the "Stage is open" tips next to the remote
});

const WINDOW_NAME_MAX = 60;

const LIMITS = Object.freeze({
  nameSeconds: [1, 30],
  imageSeconds: [1, 600],
  cursorSeconds: [1, 60],
});

function intIn(v, [min, max]) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** A window name Discord can list: one line, printable, trimmed, capped. Empty: null. */
function cleanWindowName(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, WINDOW_NAME_MAX).trim();
  return s || null;
}

/**
 * A complete settings object: `patch` over `base` over the defaults.
 * @param {object} patch  values to apply (any shape)
 * @param {object} [base] the current settings (any shape)
 */
function normalize(patch, base) {
  const out = { ...DEFAULTS };
  for (const src of [base, patch]) {
    if (!src || typeof src !== 'object') continue;
    for (const k of ['showName', 'muteVault', 'tips']) {
      if (typeof src[k] === 'boolean') out[k] = src[k];
    }
    for (const k of Object.keys(LIMITS)) {
      if (k in src) {
        const n = intIn(src[k], LIMITS[k]);
        if (n !== null) out[k] = n;
      }
    }
    if ('windowName' in src) {
      const name = cleanWindowName(src.windowName);
      if (name) out.windowName = name;
    }
    if (OPEN_SIZES.includes(src.openSize)) out.openSize = src.openSize;
  }
  return out;
}

/**
 * Check a POST body strictly, for the route: { ok, settings } or { ok:false, error }.
 * Unlike normalize(), a value that is there but wrong is refused, so the page
 * never thinks it saved something the server threw away.
 */
function validatePatch(body, base) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Send the settings as an object.' };
  const known = new Set(Object.keys(DEFAULTS));
  for (const k of Object.keys(body)) {
    if (!known.has(k)) return { ok: false, error: `Unknown Stage setting: ${k}` };
  }
  for (const k of ['showName', 'muteVault', 'tips']) {
    if (k in body && typeof body[k] !== 'boolean') return { ok: false, error: `${k} must be true or false` };
  }
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    if (!(k in body)) continue;
    // In range or refused: the page keeps its fields in range, so a value outside is a mistake to say.
    const n = intIn(body[k], [-Infinity, Infinity]);
    if (n === null || !Number.isInteger(Number(body[k])) || n < min || n > max) return { ok: false, error: `${k} must be a whole number of seconds (${min} to ${max})` };
  }
  if ('windowName' in body && !cleanWindowName(body.windowName)) return { ok: false, error: 'The window name cannot be empty.' };
  if ('openSize' in body && !OPEN_SIZES.includes(body.openSize)) return { ok: false, error: `openSize must be one of ${OPEN_SIZES.join(', ')}` };
  return { ok: true, settings: normalize(body, base) };
}

module.exports = { DEFAULTS, SIZE_PRESETS, OPEN_SIZES, LIMITS, WINDOW_NAME_MAX, normalize, validatePatch, cleanWindowName };
