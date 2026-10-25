/**
 * Fetch Metadata gate: refuse requests another web site's page makes.
 *
 * The Host allowlist (lib/host-check.js) stops a page from reading Vault's
 * responses, and the CSRF guard stops it from writing. Neither stops a page
 * on any web site from simply MAKING GET requests: `<img src=
 * "http://127.0.0.1:8765/thumb/1">` loads fine from anywhere. That is enough
 * to:
 *  - keep the vault from ever auto-locking. Every gated request counts as the
 *    user being present (vault.touch()), so one image tag reloaded every
 *    minute held a library open indefinitely;
 *  - start work: thumbnail jobs, FFmpeg remux sessions (which can push out the
 *    stream the owner is actually watching), and outbound calls from routes
 *    such as /api/update-check, /api/cove/folders and /api/search/semantic;
 *  - learn things without reading a byte: whether an id exists, and an
 *    image's size, from the load/error events.
 *
 * Browsers say where a request came from in Sec-Fetch-Site. Vault's own page
 * sends `same-origin`; a typed address, a bookmark or the launcher opening
 * the browser sends `none`. Anything else is another site:
 *  - `cross-site`: any other web site.
 *  - `same-site`: the same host on a different port, which includes a second
 *    Vault (or anything else) on another port of 127.0.0.1. Refused too: a
 *    different port is a different program.
 *
 * Allowed:
 *  - `same-origin` and `none`.
 *  - No Sec-Fetch-Site at all: curl, VLC and other external players, the
 *    scanner's own tools, and browsers too old to send it. A request with no
 *    browser behind it has no page to abuse it.
 *  - A top-level page load of `/` from anywhere (Sec-Fetch-Mode navigate,
 *    Sec-Fetch-Dest document), so a link to Vault from another page or app
 *    still opens it. That only shows the page (or the lock screen); every
 *    request the page then makes is same-origin.
 *
 * It runs ahead of the lock gate, so a refused request never touches the
 * idle clock.
 */

const REFUSED_SITES = new Set(['cross-site', 'same-site']);

/**
 * Should this request be refused? Pure, so it can be tested on its own.
 * @param {{method:string, path:string, headers:object}} req
 */
function isRefusedCrossSite(req) {
  const site = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (!REFUSED_SITES.has(site)) return false;
  // Opening the page itself is fine; a link to the app keeps working.
  const mode = String(req.headers['sec-fetch-mode'] || '').trim().toLowerCase();
  const dest = String(req.headers['sec-fetch-dest'] || '').trim().toLowerCase();
  if ((req.method === 'GET' || req.method === 'HEAD') && req.path === '/'
    && mode === 'navigate' && dest === 'document') return false;
  return true;
}

/**
 * One line per refusal, up to LOG_MAX per LOG_WINDOW_MS, then one "more not
 * shown" line: a page that loops on an image tag cannot fill the log.
 */
const LOG_MAX = 20;
const LOG_WINDOW_MS = 10 * 60 * 1000;

function makeRefusalLogger({ warn = (msg) => console.warn(msg), now = Date.now } = {}) {
  let windowStart = 0;
  let count = 0;
  return function logRefusal(req) {
    const t = now();
    if (t - windowStart >= LOG_WINDOW_MS) { windowStart = t; count = 0; }
    count++;
    if (count > LOG_MAX) {
      if (count === LOG_MAX + 1) warn('[fetch-site] more requests from other sites refused; not logging each one for a while');
      return;
    }
    const site = String(req.headers['sec-fetch-site']).slice(0, 20);
    warn(`[fetch-site] rejected ${req.method} ${String(req.path || '').slice(0, 200)}, Sec-Fetch-Site: ${site}`);
  };
}

function fetchMetadataGate({ log = makeRefusalLogger() } = {}) {
  return function fetchMetadataMiddleware(req, res, next) {
    if (!isRefusedCrossSite(req)) return next();
    log(req);
    res.status(403).json({ error: 'request from another site refused', code: 'CROSS_SITE' });
  };
}

module.exports = { isRefusedCrossSite, fetchMetadataGate, makeRefusalLogger };
