/* ==========================================
   Utility Functions
   ========================================== */

/**
 * Convert a linear slider position (0-1) to perceptual volume using a power curve.
 * Attempt to make 50% on the slider sound like 50% as loud.
 * Using x^2.5 curve — stronger than square, gives good low-end control.
 * @param {number} sliderValue - Linear slider position (0 to max)
 * @param {number} max - Maximum slider value (1 for audio, 1.5 for video boost)
 * @returns {number} Perceptual volume value (0 to max)
 */
function sliderToVolume(sliderValue, max = 1) {
  const normalized = sliderValue / max; // 0-1
  const curved = Math.pow(normalized, 2.0);
  return curved * max;
}

/**
 * Convert a perceptual volume back to linear slider position.
 * Inverse of sliderToVolume — used when setting slider from a known volume.
 * @param {number} volume - Actual volume (0 to max)
 * @param {number} max - Maximum slider value
 * @returns {number} Linear slider position (0 to max)
 */
function volumeToSlider(volume, max = 1) {
  const normalized = volume / max; // 0-1
  const linear = Math.pow(normalized, 1 / 2.5);
  return linear * max;
}

function debounce(fn, ms) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}

/** True only for a meaningful language value (hides none/undefined/na noise). */
function isRealLanguage(lang) {
  if (!lang) return false;
  const v = String(lang).trim().toLowerCase();
  return v !== '' && !['none', 'unknown', 'undefined', 'null', 'na', 'n/a'].includes(v);
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function truncatePath(path, maxLen = 50) {
  if (path.length <= maxLen) return path;
  const parts = path.split(/[/\\]/);
  if (parts.length <= 3) return path;
  return parts[0] + '/.../' + parts.slice(-2).join('/');
}

function safeParseJSON(str, fallback = []) {
  try {
    return JSON.parse(str) || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Escape text for interpolation into HTML.
 *
 * textContent→innerHTML handles & < > but leaves quotes alone, which is fine in
 * a text node and not fine in an attribute: a value containing a double quote
 * closed the attribute early and everything after it was parsed as real markup
 * (`onclick=`, `onmouseover=`…). Every attribute in this codebase is
 * double-quoted, so escaping " closes that.
 *
 * ' is deliberately NOT escaped. Several call sites build inline handlers as
 * onclick="fn('${escapeHtml(p).replace(/'/g, "\\'")}')" — they rely on the
 * apostrophe reaching them intact so they can backslash-escape it for the JS
 * string. Turning it into &#39; here would have the HTML parser hand a bare
 * quote back to the JS parser, which is the very injection this prevents.
 */
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  // & is already escaped by the step above, so this can't double-encode.
  return div.innerHTML.replace(/"/g, '&quot;');
}

/* ── Bottom-right queue stack ─────────────────────────────────────────────
   The import, AI-scan and delete panels can all be on screen at once and each
   one grows with its own list, so hand-tuned `bottom` offsets inevitably
   overlap. Every panel goes into this one bottom-anchored column instead and
   lets flex do the spacing; css/tiles.css pins each panel to a slot with
   `order`, so a panel that removes and re-appends its node (importPanel) never
   reshuffles the stack. */
function queuePanelStack() {
  let stack = document.getElementById('queueStack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'queueStack';
    document.body.appendChild(stack);
  }
  return stack;
}

// Snake/kebab/camel key → Title Case ("main_person" → "Main Person").
function titleCaseKey(s) {
  return String(s == null ? '' : s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')  // split camelCase
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// Media URL for a local filepath — served by the viewer server with HTTP
// Range support (seeking). Replaces the old fragile file:/// URLs.
function pathToFileUrl(filepath) {
  return '/media/by-path?p=' + encodeURIComponent(filepath);
}

function copyPath(path) {
  navigator.clipboard.writeText(path).then(() => {
    showToast('Path copied to clipboard!');
  });
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('active');
  setTimeout(() => toast.classList.remove('active'), 3000);
}
