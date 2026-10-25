/**
 * Host header allowlist (DNS-rebinding guard).
 *
 * The server binds 127.0.0.1, but binding alone does not stop a browser from
 * reaching it under someone else's name: a page on evil.example can re-point
 * its own DNS record at 127.0.0.1, and from then on the browser treats this
 * server as evil.example and lets that page read every GET response (library
 * data, /media, /stream, thumbnails) as same-origin. The one thing the
 * attacker cannot change is the Host header, which still says evil.example.
 * So every request, static files included, must name this server by a
 * loopback address and the port it arrived on, or it gets a 403.
 *
 * Allowed, and nothing else:
 *   127.0.0.1:<port>   localhost:<port>   [::1]:<port>
 *  - The hostname compares case-insensitively (Host is case-insensitive); the
 *    port must match exactly, digit for digit.
 *  - No port is refused: a browser always sends one for a port other than 80,
 *    and Vault never listens on 80.
 *  - A missing Host is refused (HTTP/1.1 requires it; only hand-made requests
 *    leave it out).
 *  - `localhost.` (trailing dot) is refused. It is a different origin to the
 *    browser, and nothing in Vault ever opens that address.
 *  - Other loopback spellings (127.0.0.2, 0.0.0.0, 127.1) are refused. Browsers
 *    send the canonical 127.0.0.1 for the short forms, and 0.0.0.0 is itself a
 *    known way for a web page to reach local services.
 *  - [::1] is listed so the check is right if Vault ever listens on IPv6 too.
 *    Today config.server.host is fixed at 127.0.0.1 (no env override), so an
 *    IPv6 connection never arrives at all. If the bind address ever becomes
 *    configurable, this list must stay loopback-only: a LAN address here would
 *    make the guard meaningless and the server reachable off-box.
 *
 * The raw header is read, never req.hostname, which would honour
 * X-Forwarded-Host if `trust proxy` were ever turned on.
 */

const ALLOWED_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Is `hostHeader` one of the three loopback names with exactly `port`?
 * Pure: no request, no config, so it can be unit tested on its own.
 *
 * @param {string|undefined} hostHeader  the raw Host header value
 * @param {number|string} port           the port this server is listening on
 */
function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return false;
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return false;
  const host = hostHeader.toLowerCase();
  return ALLOWED_HOSTNAMES.some(name => host === `${name}:${p}`);
}

/**
 * One console line per distinct refused Host, at most LOG_MAX of them per
 * LOG_WINDOW_MS, then a single "more not shown" line. A page that rebinds and
 * hammers the server cannot fill the log, and the first sighting of each new
 * name is still visible.
 */
const LOG_MAX = 20;
const LOG_WINDOW_MS = 10 * 60 * 1000;

function makeRefusalLogger({ warn = (msg) => console.warn(msg), now = Date.now } = {}) {
  let windowStart = 0;
  let seen = new Set();
  let capped = false;
  return function logRefusal(hostHeader, req) {
    const t = now();
    if (t - windowStart >= LOG_WINDOW_MS) { windowStart = t; seen = new Set(); capped = false; }
    const shown = hostHeader === undefined ? '(none)' : JSON.stringify(String(hostHeader).slice(0, 100));
    if (seen.has(shown)) return;
    if (seen.size >= LOG_MAX) {
      if (!capped) {
        capped = true;
        warn(`[host] more requests with other Host headers refused; not logging each one for a while`);
      }
      return;
    }
    seen.add(shown);
    warn(`[host] refused ${req.method} ${String(req.path || req.url || '').slice(0, 200)}, Host: ${shown}`);
  };
}

/**
 * Express middleware. `port` is a number, or a function (req) => number for
 * the port the request actually arrived on.
 */
function hostCheck({ port, log = makeRefusalLogger() } = {}) {
  const portFor = typeof port === 'function' ? port : () => port;
  return function hostCheckMiddleware(req, res, next) {
    const hostHeader = req.headers.host;
    if (isAllowedHost(hostHeader, portFor(req))) return next();
    log(hostHeader, req);
    res.status(403).json({ error: 'host not allowed', code: 'HOST_NOT_ALLOWED' });
  };
}

module.exports = { isAllowedHost, hostCheck, makeRefusalLogger, ALLOWED_HOSTNAMES };
