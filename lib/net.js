/**
 * Network chokepoint — the single, auditable egress point for the app.
 *
 * This app's privacy posture is: NO network egress without user consent, no
 * telemetry, no automatic update pings. To make that reviewable rather than a
 * promise, EVERY Node-side network request routes through netFetch() here —
 * grep the codebase for `fetch(` and the only non-loopback hits should be in
 * this file. New egress that skips this module is a bug.
 *
 * Policy:
 *  - Loopback (localhost / 127.0.0.0/8 / [::1]) is ALWAYS allowed and never
 *    gated: the local LLM and Python sidecars are IPC over HTTP, not egress.
 *    Loopback is decided by strict, fail-closed validation of the hostname —
 *    NOT a prefix match — so DNS names like `127.0.0.1.evil.com` are treated
 *    as egress and gated, never smuggled through as "loopback".
 *  - VAULT_OFFLINE=1 (config.net.offline) is the hard kill switch — any
 *    non-loopback request throws a typed error (code NET_OFF), no exceptions.
 *  - Redirects are followed MANUALLY (max 5 hops) and EVERY hop re-passes this
 *    exact gate: a loopback response that 3xx-redirects off-box is re-checked
 *    against the redirect target and blocked offline just like a direct request,
 *    so the "no non-loopback egress" guarantee holds on hop two, not just hop
 *    one. Over the cap throws code TOO_MANY_REDIRECTS. A hop to a different
 *    origin (scheme+host+port) drops Authorization / Proxy-Authorization /
 *    Cookie first, so a redirect can never carry the caller's credentials to
 *    another host (WHATWG fetch behaviour; same-origin hops keep them).
 *  - opts.purpose is REQUIRED and must be exactly one of 'model' | 'update' |
 *    'llm' | 'tool'. It classifies the request:
 *      'model'  — AI model downloads (whisper / OPUS-MT / diarizer). Also
 *                 requires config.subtitles.allowModelDownload; else code
 *                 DOWNLOADS_OFF.
 *      'update' — the manual "check for updates" click. Only ever user-clicked,
 *                 never automatic; blocked only by VAULT_OFFLINE.
 *      'llm'    — user-configured LLM/vision/embedding endpoints (localhost by
 *                 default). Non-loopback is blocked only by VAULT_OFFLINE.
 *      'tool'   — the setup banner's "download ffmpeg" click. Like 'update':
 *                 only ever user-clicked, never automatic; blocked only by
 *                 VAULT_OFFLINE. Not 'model' on purpose — SUB_ALLOW_DOWNLOADS
 *                 governs AI models fetched as a side effect of a scan, and an
 *                 explicit button press shouldn't be silenced by that flag.
 *    A missing or unrecognized purpose throws a plain Error — that's a
 *    programmer mistake, and failing loudly keeps the discipline that every
 *    call declares its intent (and closes the "typo skips model consent" hole).
 *
 * NOTE: the Python sidecars (faster-whisper, OPUS-MT/transformers, pyannote)
 * make their own HTTP calls to HuggingFace and can't route through this module.
 * They are gated BEFORE spawn via the same flags (SUB_ALLOW_DOWNLOADS /
 * VAULT_OFFLINE), and when offline we additionally set HF_HUB_OFFLINE=1 /
 * TRANSFORMERS_OFFLINE=1 in their spawn env so the libraries themselves refuse
 * to reach the network at model-load time.
 */

const config = require('../config');

function _err(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * True iff `host` is a syntactically complete IPv4 address in 127.0.0.0/8:
 * exactly four dot-separated decimal octets, each 0-255, first octet 127.
 * No shorthand (`127.1`), no leading zeros / junk, no trailing junk — anything
 * that isn't a full, well-formed dotted-quad fails closed (returns false).
 */
function is127Ipv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    // Reject empty, non-digit, or leading-zero forms so parsing is unambiguous
    // and there's no room for octal/leading-junk tricks.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return false;
    if (Number(p) > 255) return false;
  }
  return parts[0] === '127';
}

/**
 * Loopback = localhost, ::1/[::1], or a well-formed 127.0.0.0/8 IPv4 literal.
 * Sidecars and the local LLM live here, so these are always allowed regardless
 * of the offline switch. This is a strict, fail-closed hostname check — never a
 * prefix match — so `127.0.0.1.evil.com` / `127.attacker.net` are NOT loopback
 * and get gated. No DNS resolution here (that would itself leak a query).
 */
function isLoopback(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;   // unparseable → treat as non-loopback (gets gated)
  }
  return host === 'localhost' || host === '::1' || host === '[::1]' || is127Ipv4(host);
}

const VALID_PURPOSES = ['model', 'update', 'llm', 'tool'];
const REDIRECT_STATUS = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;

// Headers that carry the caller's credentials. Dropped before following a
// redirect to a different origin (WHATWG fetch strips Authorization; we also
// drop Proxy-Authorization and Cookie since there is no cookie jar here to
// re-scope them). Once dropped they stay dropped for the rest of the chain,
// even if a later hop comes back to the original origin — same as fetch.
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];
// Headers that describe a request body. Dropped when a redirect turns the
// request into a body-less GET (WHATWG "request-body-header name").
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];

/**
 * Same origin = same scheme + host + port, per URL.origin. Opaque origins
 * (non-special schemes report "null") are never treated as same-origin, so
 * an unparseable or odd-scheme hop fails closed and loses credentials.
 */
function sameOrigin(a, b) {
  try {
    const oa = new URL(a).origin;
    const ob = new URL(b).origin;
    return oa !== 'null' && oa === ob;
  } catch {
    return false;
  }
}

/**
 * The policy gate for a single URL. Loopback is IPC, never egress — always
 * allowed. Otherwise the offline kill switch and (for 'model') the download
 * consent flag apply. Throws the typed error on a blocked request; returns
 * nothing when the request may proceed. Called for the initial URL AND for
 * every redirect target, so hop two is gated exactly like hop one.
 */
function gate(url, purpose) {
  if (isLoopback(url)) return;
  // Hard offline switch trumps everything for non-loopback requests.
  if (config.net?.offline) {
    throw _err('NET_OFF', `Network is off (VAULT_OFFLINE=1). Blocked ${purpose} request to ${url}`);
  }
  // Model downloads additionally respect the download-consent flag.
  if (purpose === 'model' && config.subtitles?.allowModelDownload === false) {
    throw _err('DOWNLOADS_OFF', `Model downloads are off (SUB_ALLOW_DOWNLOADS=0). Blocked request to ${url}`);
  }
  // 'update', 'llm' and 'tool' are only gated by VAULT_OFFLINE (handled above).
}

/**
 * The one function every Node-side network request must go through.
 * Redirects are followed manually so each hop re-passes gate() — fetch's own
 * redirect follower would escape the chokepoint on a loopback→external 3xx.
 * @param {string} url
 * @param {object} opts - standard fetch opts PLUS a required `purpose`
 *   ('model' | 'update' | 'llm'). `purpose` is stripped before the real fetch.
 */
async function netFetch(url, opts = {}) {
  const { purpose, ...fetchOpts } = opts;
  if (!VALID_PURPOSES.includes(purpose)) {
    // Programmer error, not a runtime condition — a call reached the chokepoint
    // without declaring a valid intent. Throw plainly so it's caught in dev, not
    // swallowed, and so an unknown purpose can never silently skip model consent.
    throw new Error('netFetch: opts.purpose is required and must be one of model | update | llm | tool');
  }

  let current = url;
  let method = (fetchOpts.method || 'GET').toUpperCase();
  let body = fetchOpts.body;
  // Normalize once (plain object, [k, v][] or Headers all work) so per-hop
  // deletions are case-insensitive and never mutate the caller's object.
  const headers = new Headers(fetchOpts.headers);
  let redirects = 0;

  // We drive redirects ourselves (redirect: 'manual') so the gate runs on every
  // hop. Letting fetch follow redirects would leak the target past the gate.
  while (true) {
    gate(current, purpose);
    const res = await fetch(current, { ...fetchOpts, method, body, headers, redirect: 'manual' });

    const loc = REDIRECT_STATUS.includes(res.status) ? res.headers.get('location') : null;
    if (loc === null) return res;   // not a redirect (or no Location) — done

    if (++redirects > MAX_REDIRECTS) {
      throw _err('TOO_MANY_REDIRECTS', `Exceeded ${MAX_REDIRECTS} redirects for ${purpose} request (last: ${current} → ${loc})`);
    }

    // Standard fetch redirect method/body semantics:
    //  - 303 (except GET/HEAD, which stay as-is), or 301/302 on POST → switch
    //    to GET, drop the body and its Content-* headers
    //  - 307/308 preserve method and body verbatim
    if ((res.status === 303 && method !== 'GET' && method !== 'HEAD') ||
        ((res.status === 301 || res.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      for (const h of BODY_HEADERS) headers.delete(h);
    }
    const next = new URL(loc, current).toString();   // resolve relative Location
    // Never hand the caller's credentials to a different origin. Without this
    // a server (even a loopback one) could 3xx a Bearer token off-box.
    if (!sameOrigin(current, next)) {
      for (const h of CREDENTIAL_HEADERS) headers.delete(h);
    }
    current = next;
  }
}

module.exports = { netFetch, isLoopback };
