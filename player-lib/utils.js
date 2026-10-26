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

/** True when the system asks for less movement. Read fresh — the OS setting
 *  can change while the app is open. */
function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
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

/* ── Where a click actually happened ──────────────────────────────────────
   Delegated listeners on the document run one after another, and an earlier
   one is free to re-render the page. By the time a later one asks "was this
   click inside my thing?", the node that was clicked may already have been
   thrown away and replaced, and `e.target.closest(...)` on a node that has
   left the page walks a stub with no ancestors and answers "no" for a click
   that plainly was inside. The event's composed path is fixed at the moment
   the event is dispatched, so it still says where the click landed no matter
   what the handlers before us did to the page. */

/** The element matching `selector` that this event passed through, or null. */
function eventPathTarget(e, selector) {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
  if (path && path.length) {
    for (const node of path) {
      if (node === document || node === window) break;
      if (node && node.nodeType === 1 && node.matches && node.matches(selector)) return node;
    }
    return null;
  }
  // No path to read: the old question is better than no question at all.
  return e.target && e.target.closest ? e.target.closest(selector) : null;
}

/** Did this event pass through `node`, or anything inside it? */
function eventPathHasNode(e, node) {
  if (!node) return false;
  const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
  if (path && path.length) return path.includes(node);
  return node.contains ? node.contains(e.target) : false;
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
    showToast('Path copied', { type: 'success' });
  }).catch(() => {
    showToast('Could not copy the path. The clipboard is not available here.', { type: 'error' });
  });
}

/* ── Toasts ────────────────────────────────────────────────────────────────
   The one #toast (db-viewer.html), styled by css/toast.css. A newer toast
   replaces the one showing and gets its own full time: the old timer is
   cleared first, so it can no longer hide the new message early. */

let _toastTimer = null;

/** How long a toast stays up: 3 s, a little longer for a long sentence (7 s at most). */
function toastDuration(text) {
  const n = String(text == null ? '' : text).length;
  return Math.min(7000, Math.max(3000, 1000 + n * 45));
}

/** 'error' / 'success' / '' for a toast: the caller's type, else a leading ⚠ or ❌ means an error. */
function toastType(message, type) {
  if (type === 'error' || type === 'success') return type;
  return /^\s*(?:⚠|❌)/.test(String(message == null ? '' : message)) ? 'error' : '';
}

/**
 * Show a short message at the bottom of the window.
 *   showToast('Saved')
 *   showToast('Could not save the note.', { type: 'error' })   // red edge + alert icon in Modern
 *   showToast('Copied', { type: 'success', duration: 2000 })
 * A message that starts with ⚠ or ❌ counts as an error without a type, so
 * the old call sites keep a visible error cue in Modern (which drops the
 * leading emoji). A string second argument is read as the type.
 */
function showToast(message, opts) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const o = typeof opts === 'string' ? { type: opts } : (opts || {});
  const raw = String(message == null ? '' : message);
  const type = toastType(raw, o.type);
  // Modern drops the leading emoji ("Saved", not "💾 Saved"): player-lib/icons.js
  const text = typeof vaultToastText === 'function' ? vaultToastText(raw) : raw;
  toast.textContent = text;
  // The icon is Modern only (.modern-only): Classic keeps the message's own emoji.
  if (type && typeof vaultIcon === 'function' && typeof toast.insertAdjacentHTML === 'function') {
    toast.insertAdjacentHTML('afterbegin', vaultIcon(type === 'error' ? 'alert' : 'check', 'toast-ic modern-only'));
  }
  toast.classList.remove('error', 'success');
  if (type) toast.classList.add(type);
  if (typeof toast.setAttribute === 'function') toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  if (typeof vaultPlaceToasts === 'function') vaultPlaceToasts();
  toast.classList.add('active');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('active'), o.duration > 0 ? o.duration : toastDuration(text));
}

/**
 * Words a person can act on for something that went wrong, in place of raw
 * error text ("Failed to fetch", "HTTP 500", "could not read folder").
 *   err:  an Error, a server's error string, or a JSON body / Response with
 *         .error / .message / .status
 *   what: what was being done, as "-ing" words: 'saving the note'
 * Server text is passed through only when it already reads as a sentence
 * (starts with a capital, has a few words, no codes); a missing full stop
 * is added. Leading emoji are dropped.
 */
function friendlyError(err, what) {
  const generic = what ? `Something went wrong while ${what}. Try again.` : 'Something went wrong. Try again.';
  if (err == null) return generic;
  const name = (err && typeof err === 'object' && err.name) || '';
  const status = (err && typeof err === 'object' && Number(err.status)) || 0;
  let msg = typeof err === 'string' ? err
    : (err && typeof err === 'object' && (typeof err.error === 'string' ? err.error
      : typeof err.message === 'string' ? err.message : '')) || '';
  msg = msg.replace(/^(?:\s*(?:⚠|❌|✗|✕|❗|⛔)️?)+\s*/u, '').trim();

  if (/failed to fetch|networkerror|network error|load failed|net::|err_connection|econnrefused|econnreset/i.test(msg)) {
    return 'Could not reach Vault. Is it still running?';
  }
  if (status === 423 || /\bvault is locked\b|\blibrary is locked\b/i.test(msg)) {
    return 'The library is locked. Unlock it and try again.';
  }
  if (name === 'AbortError' || name === 'TimeoutError' || /\btimed? ?out\b/i.test(msg)) {
    return 'Vault took too long to answer. Try again.';
  }
  // A script error (TypeError, SyntaxError ...) is never words for a person.
  if (name && name !== 'Error') return generic;
  const words = msg.split(/\s+/).filter(Boolean);
  const sentence = msg.length <= 240
    && words.length >= 3
    && /^[A-Z]/.test(msg)
    && !/\bHTTP\s?\d{3}\b|\breturned \d{3}\b|\bstatus(?: code)? \d{3}\b|^E[A-Z]{3,}\b|^[A-Z]\w*Error\b|\b[a-z]+_[a-z_]+\b|[{}<>]|\bat \S+:\d+|\bundefined\b|\bnull\b/.test(msg)
    && !/^(?:Internal Server Error|Bad Request|Not Found|Bad Gateway|Service Unavailable|Gateway Timeout|Forbidden|Unauthorized)\b/i.test(msg);
  if (!sentence) return generic;
  return /[.!?]$/.test(msg) ? msg : msg + '.';
}

/** showToast(friendlyError(err, what), { type: 'error' }) in one call. */
function showErrorToast(err, what) {
  showToast(friendlyError(err, what), { type: 'error' });
}

/* ── Where the toasts sit (Modern, css/toast.css) ──────────────────────────
   Bottom centre, but never on the selection bar and never on each other.
   Two numbers go on <html> for the CSS:
     --vault-toast-base  the lowest a toast may sit: above the selection bar
                         when it is up and reaches the toast's lane, else 24px
     --vault-undo-h      the undo toast's height while it shows (0 otherwise),
                         so #toast stacks just above it
   The player sets its own --toast-bottom, which wins over both. Both bars
   are made later by other scripts, so they are found as they join <body>. */

const VAULT_TOAST_BASE = 24;    // px from the window's bottom edge
const VAULT_TOAST_GAP = 10;     // between stacked pieces
const VAULT_TOAST_LANE = 560;   // the Modern toast's widest box

function vaultPlaceToasts() {
  if (typeof document === 'undefined' || !document.documentElement || typeof window === 'undefined') return;
  const root = document.documentElement;
  let base = VAULT_TOAST_BASE;
  const bar = document.getElementById('selectionBar');
  if (bar && bar.classList.contains('visible')) {
    // Layout numbers, not getBoundingClientRect: the bar may still be sliding in.
    const bottom = parseFloat(getComputedStyle(bar).bottom) || 0;
    const half = Math.min(VAULT_TOAST_LANE, window.innerWidth - 32) / 2;
    const mid = window.innerWidth / 2;
    const overlaps = bar.offsetLeft < mid + half && bar.offsetLeft + bar.offsetWidth > mid - half;
    if (overlaps) base = Math.max(base, bottom + bar.offsetHeight + VAULT_TOAST_GAP);
  }
  const undo = document.getElementById('undoToast');
  const undoH = undo && undo.classList.contains('visible') ? undo.offsetHeight + VAULT_TOAST_GAP : 0;
  root.style.setProperty('--vault-toast-base', base + 'px');
  root.style.setProperty('--vault-undo-h', undoH + 'px');
  vaultToastsClearOfMini(undo, document.getElementById('toast'));
}

/**
 * Never under the mini player or its open Up next list, in either look: a
 * toast whose box would sit on them goes just above them, or beside them
 * when there is no room above (and above both in the stacking order), so
 * its Undo stays clickable. The mini player moves and resizes, so this asks
 * the rectangles each time.
 */
function vaultToastsClearOfMini(undo, toast) {
  const els = [undo, toast].filter(el => el && el.style);
  for (const el of els) { el.style.bottom = ''; el.style.left = ''; el.style.right = ''; el.style.zIndex = ''; }
  const mini = document.getElementById('miniPlayer');
  if (!mini || !mini.classList || !mini.classList.contains('active') || typeof mini.getBoundingClientRect !== 'function'
    || typeof getComputedStyle !== 'function') return;
  undo = undo && undo.style ? undo : null;
  toast = toast && toast.style ? toast : null;
  // What to stay clear of: the box, and the list above (or below) it while open.
  const u = mini.getBoundingClientRect();
  const area = { left: u.left, right: u.right, top: u.top, bottom: u.bottom };
  const pop = document.getElementById('upNextPop');
  if (pop && !pop.hidden && typeof pop.getBoundingClientRect === 'function') {
    const p = pop.getBoundingClientRect();
    area.left = Math.min(area.left, p.left);
    area.right = Math.max(area.right, p.right);
    area.top = Math.min(area.top, p.top);
    area.bottom = Math.max(area.bottom, p.bottom);
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = VAULT_TOAST_GAP;
  // Where a toast's box rests: its CSS position, not part way through a slide.
  const box = (el) => {
    const was = el.style.transition;
    el.style.transition = 'none';
    const r = el.getBoundingClientRect();
    const bottom = parseFloat(getComputedStyle(el).bottom) || 0;
    el.style.transition = was;
    return { left: r.left, right: r.right, top: vh - bottom - el.offsetHeight, bottom: vh - bottom };
  };
  const meets = (b, o) => b.right > o.left && b.left < o.right && b.bottom > o.top && b.top < o.bottom;
  // Move a toast sideways by dx px, whichever edge its look anchors it by.
  const shiftX = (el, dx) => {
    const cs = getComputedStyle(el);
    if (cs.left === 'auto' || el.classList.contains('undo-toast') && !document.body.classList.contains('layout-modern')) {
      el.style.right = (parseFloat(cs.right) - dx) + 'px';
    } else {
      el.style.left = (parseFloat(cs.left) + dx) + 'px';
    }
  };
  /** Clear of the area (and of `also`, a toast placed already). Returns where it rests. */
  const place = (el, also) => {
    let b = box(el);
    const blocked = (x) => meets(x, area) || (also && meets(x, also));
    if (!blocked(b)) return b;
    el.style.zIndex = '9002';
    // Above the area, and above a toast already placed in the same column.
    const sameColumn = also && b.right > also.left && b.left < also.right && also.top < area.top + 1;
    const ceiling = Math.min(area.top, sameColumn || (also && meets(b, also)) ? also.top : Infinity);
    const h = el.offsetHeight;
    if (ceiling - gap - h >= 8) {
      el.style.bottom = (vh - ceiling + gap) + 'px';
      return box(el);
    }
    // No room above: beside the area, on whichever side has the room.
    const w = b.right - b.left;
    if (area.left - gap - w >= 8) shiftX(el, area.left - gap - b.right);
    else if (vw - area.right - gap - w >= 8) shiftX(el, area.right + gap - b.left);
    b = box(el);
    if (also && meets(b, also)) el.style.bottom = (vh - also.top + gap) + 'px';
    return box(el);
  };
  const undoAt = undo && undo.classList.contains('visible') ? place(undo, null) : (undo ? (place(undo, null), null) : null);
  if (toast) place(toast, undoAt);
}

(function watchToastNeighbours() {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || typeof window === 'undefined') return;
  const watched = new Set();
  const classWatch = new MutationObserver(vaultPlaceToasts);
  const sizeWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(vaultPlaceToasts) : null;
  function find() {
    for (const id of ['selectionBar', 'undoToast']) {
      const el = document.getElementById(id);
      if (!el || watched.has(el)) continue;
      watched.add(el);
      classWatch.observe(el, { attributes: true, attributeFilter: ['class'] });
      if (sizeWatch) sizeWatch.observe(el);
    }
    vaultPlaceToasts();
  }
  function start() {
    find();
    new MutationObserver(find).observe(document.body, { childList: true });
    window.addEventListener('resize', vaultPlaceToasts);
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
