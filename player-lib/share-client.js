/* =========================================================================
   SHARE PRIVATELY: the page's one way to talk to /api/share, plus the small
   pure helpers the share window, Settings and My shares all use.

   Every request goes through shareApi(), which always sends
   "X-Vault-Share: 1" and "Content-Type: application/json" (the share routes
   refuse anything without both: server/share-routes.js), so no call can
   forget them. Background polls add "X-Vault-Background: 1" so they do not
   keep the library from locking itself.

   SECRETS. Nothing here keeps a password. Answers that carry one (the
   password, copy-block and saved-password routes) are handed straight back to
   the caller, which shows them in its own window and drops them when that
   window closes. Nothing is written to localStorage, sessionStorage,
   IndexedDB, a URL or the console. The Vault password for a gated route goes
   in the JSON body of that one request only.

   Contract: .notes/SHARE_PRIVATELY_ROUTES.md. Spec: .notes/SHARE_PRIVATELY_SPEC.md.
   ========================================================================= */

const SHARE_API_BASE = '/api/share';

/** An error from a share route: the server's plain message, its code, and any extra fields. */
class ShareError extends Error {
  constructor(message, code, status, extra) {
    super(message);
    this.name = 'ShareError';
    this.code = code || 'ERROR';
    this.status = status || 0;
    this.extra = extra || {};
  }
}

/**
 * Call a share route. method: 'GET' | 'POST'. body: an object (sent as JSON
 * on anything but GET; {} when there is nothing). opts.background: a poll.
 * Resolves with the parsed answer; rejects with a ShareError whose message is
 * ready to show.
 */
async function shareApi(method, path, body, opts = {}) {
  const m = String(method || 'GET').toUpperCase();
  const headers = { 'X-Vault-Share': '1', 'Content-Type': 'application/json' };
  if (opts.background) headers['X-Vault-Background'] = '1';
  const init = { method: m, headers, credentials: 'same-origin', cache: 'no-store' };
  if (m !== 'GET' && m !== 'HEAD') init.body = JSON.stringify(body && typeof body === 'object' ? body : {});
  let resp;
  try {
    resp = await fetch(SHARE_API_BASE + path, init);
  } catch {
    throw new ShareError('Could not reach Vault. Is it still running?', 'OFFLINE', 0);
  }
  let data = null;
  try { data = await resp.json(); } catch { data = null; }
  if (!resp.ok) {
    const d = data && typeof data === 'object' ? data : {};
    const { error, code, ...extra } = d;
    if (resp.status === 423) throw new ShareError('The library is locked.', 'VAULT_LOCKED', 423, extra);
    throw new ShareError(shareErrorText({ error, code, ...extra }, resp.status), code || 'ERROR', resp.status, extra);
  }
  return data || {};
}

/*
 * Large shares (share-ui.js step 1). Binary GB, the way shareSize counts, so
 * "10 GB" on screen is where the warning starts. These only warn: the server
 * takes any size that fits on disk.
 */
const SHARE_LARGE_BYTES = 10 * 1024 ** 3;   // the total turns amber and a note says what it takes
const SHARE_HUGE_BYTES = 30 * 1024 ** 3;    // Pack files asks first

/** Bytes in plain words: "812 MB", "1.55 GB", "2 KB". */
function shareSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  const KB = 1024, MB = KB * 1024, GB = MB * 1024;
  if (n >= GB) {
    const v = n / GB;
    return `${parseFloat(v.toFixed(v < 10 ? 2 : 1))} GB`;
  }
  if (n >= MB) return `${Math.max(1, Math.round(n / MB))} MB`;
  return `${Math.max(1, Math.round(n / KB))} KB`;
}

/** The message to show for a failed share request (the contract's words). */
function shareErrorText(d, status) {
  const o = d && typeof d === 'object' ? d : {};
  const code = o.code || '';
  let msg = typeof o.error === 'string' && o.error.trim() ? o.error.trim() : '';
  if (code === 'NO_SPACE' && Number(o.missingBytes) > 0) {
    msg = `${msg || 'There is not enough free space to pack these files.'} ${shareSize(o.missingBytes)} more is needed.`;
  }
  if (code === 'SHARE_FORBIDDEN' || code === 'ERROR' || !msg) {
    return status === 0 ? 'Could not reach Vault. Is it still running?' : 'Something went wrong. Try again.';
  }
  return msg;
}

/**
 * The gofile link to open, or null. Only a link the server gave that starts
 * with https://gofile.io/ and still reads as exactly that host once parsed.
 */
function shareSafeLink(link) {
  if (typeof link !== 'string' || !link.startsWith('https://gofile.io/')) return null;
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' || u.hostname !== 'gofile.io' || u.port || u.username || u.password) return null;
    return u.href;
  } catch {
    return null;
  }
}

/* ── Copy format ────────────────────────────────────────────────────────── */

const SHARE_READY_FORMATS = {
  default: '{link}\npass: {pass}',
  oneLine: 'code: {code} | pass: {pass}',
};
const SHARE_FORMAT_MAX = 500;
/* The made-up values the format editor's preview fills in (the same ones the
   server's POST /copy-format/preview uses). Not a real share. */
const SHARE_FORMAT_EXAMPLE = { link: 'https://gofile.io/d/x7k2p9Qm', code: 'x7k2p9Qm', pass: 'T4rQ-Wq9z-Lm2K-xP7d-Vb6N-hJ3s', name: 'k7Qm2xVd9LpA' };

/** The format the settings pick (a ready one, or the user's own). */
function shareFormatFor(settings) {
  const s = settings || {};
  if (s.copyFormat === 'custom' && typeof s.customFormat === 'string' && s.customFormat.trim()) return s.customFormat;
  return SHARE_READY_FORMATS[s.copyFormat] || SHARE_READY_FORMATS.default;
}

/**
 * Fill a copy format, as the server does (lib/share/names.js renderBlock):
 * {link} {code} {pass} {name}; anything else in braces stays as typed. With
 * no password and {pass} in the format, the link alone.
 */
function shareRenderFormat(format, values) {
  const f = String(format == null ? '' : format);
  const v = values || {};
  if ((v.pass === null || v.pass === undefined) && f.includes('{pass}')) return String(v.link || '');
  const vals = { link: v.link || '', code: v.code || '', pass: v.pass || '', name: v.name || '' };
  return f.replace(/\{(link|code|pass|name)\}/g, (_, k) => vals[k]);
}

/** The editor's live preview: the format with the example values. */
function shareFormatPreview(format) {
  return shareRenderFormat(format, SHARE_FORMAT_EXAMPLE);
}

/* ── Words ──────────────────────────────────────────────────────────────── */

const SHARE_DELETE_AFTER_OPTIONS = [
  { value: 7, label: '7 days' },
  { value: 1, label: '1 day' },
  { value: 30, label: '30 days' },
  { value: 0, label: 'Never (gofile decides)' },
];
const SHARE_SPLIT_OPTIONS = [
  { value: '2g', label: '2 GB' },
  { value: '500m', label: '500 MB' },
  { value: '1g', label: '1 GB' },
  { value: '4g', label: '4 GB' },
  { value: 'custom', label: 'Custom size' },
  { value: 'none', label: 'Do not split' },
];
const SHARE_PASSWORD_CHOICE_OPTIONS = [
  { value: 'random', label: 'New random one each time' },
  { value: 'saved', label: 'My saved password' },
];
const SHARE_PART_FAIL_OPTIONS = [
  { value: 'retry3', label: 'Try 3 more times, then ask me' },
  { value: 'ask', label: 'Ask me straight away' },
];
const SHARE_AFTER_PACK_OPTIONS = [
  { value: 'wait', label: 'Wait for me to check' },
  { value: 'upload', label: 'Upload on its own' },
];
const SHARE_ACCOUNT_OPTIONS = [
  { value: 'perStart', label: 'New one each time Vault starts' },
  { value: 'perShare', label: 'New one for every share' },
  { value: 'keep', label: 'Keep using the same one' },
];
const SHARE_COPY_FORMAT_OPTIONS = [
  { value: 'default', label: 'Link, then pass: line' },
  { value: 'oneLine', label: 'One line: code and pass' },
  { value: 'custom', label: 'My own format' },
];

/** "7 days", "1 day", "Never (gofile decides)". */
function shareDeleteAfterLabel(days) {
  const o = SHARE_DELETE_AFTER_OPTIONS.find(x => x.value === Number(days));
  return o ? o.label : `${Number(days)} days`;
}

/** "Today 14:02", "Yesterday 09:10", "14 Nov", "14 Nov 2025". */
function shareWhen(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const d = new Date(t), n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(n) - day(d)) / 86400000);
  if (diff === 0) return `Today ${hm}`;
  if (diff === 1) return `Yesterday ${hm}`;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${d.getDate()} ${mon}${d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}

/** " today", " yesterday", " on 4 Nov", or '' with no time. */
function shareOnDay(ms, now = Date.now()) {
  const w = shareWhen(ms, now);
  if (!w) return '';
  if (w.startsWith('Today')) return ' today';
  if (w.startsWith('Yesterday')) return ' yesterday';
  return ` on ${w}`;
}

/** "in 7 days", "in 1 day", "in 5 hours", "within the hour". */
function shareTimeLeft(ms, now = Date.now()) {
  const left = Number(ms) - now;
  if (!(left > 0)) return 'now';
  const h = left / 3600000;
  if (h >= 24) { const d = Math.round(h / 24); return `in ${d} ${d === 1 ? 'day' : 'days'}`; }
  if (h >= 1) { const r = Math.round(h); return `in ${r} ${r === 1 ? 'hour' : 'hours'}`; }
  return 'within the hour';
}

/** "about 6 minutes left" from bytes still to send and a rate in bytes/s, or ''. */
function shareEta(bytesLeft, rate) {
  if (!(rate > 0) || !(bytesLeft > 0)) return '';
  const s = bytesLeft / rate;
  if (s < 60) return 'less than a minute left';
  const m = Math.round(s / 60);
  if (m < 60) return `about ${m} ${m === 1 ? 'minute' : 'minutes'} left`;
  const h = Math.round(m / 60);
  return `about ${h} ${h === 1 ? 'hour' : 'hours'} left`;
}

/**
 * A share's status in My shares: { text, tone } where tone is 'ok', 'soon',
 * 'busy', 'bad' or 'done' (ended, nothing left to do).
 */
function shareStatusWords(share, now = Date.now()) {
  const s = share || {};
  switch (s.status) {
    case 'queued': return { text: 'Waiting to pack', tone: 'plain' };
    case 'packing': return { text: 'Packing', tone: 'busy' };
    case 'checked': return { text: 'Ready to check', tone: 'soon' };
    case 'uploading': return { text: 'Uploading', tone: 'busy' };
    case 'paused': return { text: 'Paused', tone: 'soon' };
    case 'not_finished': return { text: 'Upload not finished', tone: 'soon' };
    case 'uploaded': {
      if (!s.deleteAt) {
        return s.deleteAfterDays && !s.timerSet
          ? { text: 'Uploaded, gofile did not take the timer', tone: 'soon' }
          : { text: 'Uploaded, no timer', tone: 'plain' };
      }
      const soon = s.deleteAt - now < 2.5 * 86400000;
      return { text: `Uploaded, timer ends ${shareTimeLeft(s.deleteAt, now)}`, tone: soon ? 'soon' : 'ok' };
    }
    case 'expired': return { text: `Timer ran out${shareOnDay(s.deleteAt, now)}`, tone: 'done' };
    case 'deleted': return { text: `Deleted by you${shareOnDay(s.deletedAt, now)}`, tone: 'done' };
    case 'gone': return { text: 'Marked as gone', tone: 'done' };
    case 'stopping': return { text: 'Stopping and deleting', tone: 'busy' };
    case 'cancelled': return { text: 'Stopped and deleted', tone: 'done' };
    case 'failed': return { text: 'Failed', tone: 'bad' };
    default: return { text: String(s.status || ''), tone: 'plain' };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    shareApi, ShareError, shareSize, shareErrorText, shareSafeLink, shareFormatFor, shareRenderFormat,
    shareFormatPreview, shareWhen, shareTimeLeft, shareEta, shareStatusWords, shareDeleteAfterLabel,
    SHARE_READY_FORMATS, SHARE_FORMAT_EXAMPLE,
  };
}
