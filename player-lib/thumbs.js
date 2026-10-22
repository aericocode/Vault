/* =========================================================================
   THUMBS - how tile images get from the server onto the screen.

   Three jobs, and they are all about not asking the server twice for the
   same picture:

   - Plain mode leans on the browser's own HTTP cache. The URL carries the
     row's thumb_version as ?v=, the server answers immutable for a year, and
     a second visit to a page it has already shown makes no requests at all.
   - Vault mode cannot do that: a cached thumbnail is a decrypted copy of
     something the user locked, so the server says no-store. The page keeps
     the bytes as object URLs in an LRU instead, and throws them away when
     the vault locks.
   - Either way a thumbnail that has not been generated yet answers 404 with
     X-Thumb: pending while the server builds it in the background. The tile
     shows its type icon and the image is retried after 1, 2, 4 and 8
     seconds, then left alone. X-Thumb: missing (the media file is gone)
     stops the retries immediately, and the id is never asked for again this
     session.

   The retry is bound once, at the document, in the capture phase, so it
   covers every /thumb <img> in the page - library tiles, collection
   mosaics, the games and PMV pickers - without any of them knowing.

   The thumbnail settings (Settings > Library > Thumbnails, server side) change
   three things here: "Off" means no picture is ever asked for; "When shown"
   means a pending thumbnail is waited for as long as its tile is on the page
   (the server makes it only because the tile asked); and with hover frames
   off a tile never asks for scrub frames.
   ========================================================================= */

const THUMB_BACKOFF_MS = [1000, 2000, 4000, 8000];
// "When shown": after the backoff above, keep asking at this pace while the
// tile is on the page. Each ask also tells the server the tile still wants it.
const THUMB_SHOWN_RETRY_MS = 3000;
const THUMB_BLOB_MAX_ENTRIES = 1500;
const THUMB_BLOB_MAX_BYTES = 150 * 1024 * 1024;
const THUMB_PREFETCH_QUIET_MS = 150;

/* ── How far ahead thumbnails are warmed ──────────────────────────────────
   Deep enough that flipping through pages stays ahead of the reader, and
   ordered so the nearest guess is fetched first: the batches run one at a
   time, next page before the page after it, and everything ahead before the
   one page behind. Any page change cancels whatever is left. Costs nothing
   but bandwidth the user was about to spend anyway. */
const PREFETCH_PAGES_AHEAD = 4;    // pages after the one on screen
const PREFETCH_PAGES_BEHIND = 1;   // pages before it, which is where Back goes
const PREFETCH_ROWS_AHEAD = 10;    // continuous mode: rows below the rendered window
const PREFETCH_ROWS_BEHIND = 2;    // rows above it
const THUMB_PREFETCH_MAX_BATCHES = PREFETCH_PAGES_AHEAD + PREFETCH_PAGES_BEHIND;
const PREFETCH_BATCH_TIMEOUT_MS = 10000;  // a wedged request must not stall the queue
const PREFETCH_GATE_MAX_MS = 4000;        // how long to wait for the visible tiles
const THUMBABLE_MEDIA = new Set(['video', 'image', 'gif', 'mix']);

let _thumbsEncrypted = false;
// Server-side thumbnail settings (lib/thumb-settings.js). Defaults = today.
let _thumbCfg = { make: 'all', keep: 'keep', hover: true, inside: true, salt: 0 };
const _thumbDead = new Set();    // ids we have stopped asking about
const _thumbBlobs = new Map();   // id -> { url, size } — LRU, vault mode only
let _thumbBlobBytes = 0;

/* ── Mode ─────────────────────────────────────────────────────────────── */

function thumbsEncrypted() { return _thumbsEncrypted; }

/** Vault on or off. Switching either way drops whatever was cached. */
function setThumbsEncrypted(flag) {
  const next = !!flag;
  if (next === _thumbsEncrypted) return;
  _thumbsEncrypted = next;
  revokeThumbBlobs();
  _thumbDead.clear();
}

/** Read the vault's state and the thumbnail settings once, before the first grid render. */
async function initThumbMode() {
  const settings = loadThumbSettings();
  try {
    const s = await fetch('/api/vault/status').then(r => r.json());
    setThumbsEncrypted(!!s.encrypted && !s.locked);
  } catch { /* server unreachable — plain mode is the safe assumption */ }
  await settings;
}

/* ── Thumbnail settings ───────────────────────────────────────────────── */

async function loadThumbSettings() {
  try {
    const r = await fetch('/api/settings/thumbnails');
    if (r.ok) setThumbSettings(await r.json());
  } catch { /* older server or locked: keep the defaults */ }
}

function thumbCfg() { return _thumbCfg; }
function thumbsOff() { return _thumbCfg.make === 'off'; }
function thumbHoverOn() { return !thumbsOff() && _thumbCfg.hover !== false; }

/** New settings from the server. Whatever was given up on is asked for again. */
function setThumbSettings(cfg) {
  if (!cfg) return;
  _thumbCfg = {
    make: cfg.make || 'all', keep: cfg.keep || 'keep',
    hover: cfg.hover !== false, inside: cfg.inside !== false,
    salt: Number(cfg.salt) || 0,
  };
  _thumbDead.clear();
  cancelThumbPrefetch();
}

/** Should a pending thumbnail be waited for until it comes? */
function thumbWaitsForever() { return _thumbCfg.make === 'shown'; }

/** Delay before retry number `attempt` (0-based), or null to stop. */
function thumbRetryDelay(attempt) {
  if (attempt < THUMB_BACKOFF_MS.length) return THUMB_BACKOFF_MS[attempt];
  return thumbWaitsForever() ? THUMB_SHOWN_RETRY_MS : null;
}

/* ── URLs ─────────────────────────────────────────────────────────────── */

function thumbable(media) {
  if (!media || thumbsOff()) return false;
  // Music with album art shows it when "Use pictures already inside files" is on.
  return THUMBABLE_MEDIA.has(media.media_type) || (_thumbCfg.inside && media.media_type === 'audio');
}

/**
 * Should a tile put an <img> in for this row? No when thumbnails are off
 * (nothing is asked for, the type icon shows), and no for a file the server
 * already said has no picture.
 */
function canShowThumb(media) {
  return thumbable(media) && !_thumbDead.has(media.id);
}

/**
 * Prefetching asks for pictures nobody is looking at yet, which is the
 * opposite of "When shown": there only pictures already made are warmed (the
 * row carries a version), and "only while running" warms nothing at all.
 */
function thumbPrefetchable(media) {
  if (!canShowThumb(media)) return false;
  if (_thumbCfg.make !== 'shown') return true;
  if (_thumbCfg.keep === 'memory') return false;
  return !!media.thumb_version;
}

/** True once the server has said there is no picture for this id, ever. */
function thumbKnownMissing(id) {
  return _thumbDead.has(id);
}

/**
 * The URL for a row's thumbnail. Plain mode appends the version that lets the
 * response be cached hard; vault mode has nothing to cache, so it does not.
 */
function thumbUrl(media) {
  if (!media) return '';
  const v = media.thumb_version || 0;
  return (!_thumbsEncrypted && v) ? `/thumb/${media.id}?v=${thumbVersionTag(v)}` : `/thumb/${media.id}`;
}

/**
 * The ?v= of a cacheable URL: the row's version, plus the settings' salt when
 * the server bumped it (switching into "Keep up to" must reach the server for
 * every showing, so year-long cached answers under the old URLs are dropped).
 */
function thumbVersionTag(v) {
  return _thumbCfg.salt ? `${v}-${_thumbCfg.salt}` : String(v);
}

function thumbUrlById(id) {
  const m = (typeof getMediaById === 'function') ? getMediaById(id) : null;
  return m ? thumbUrl(m) : `/thumb/${id}`;
}

/** What a tile should show when it is not scrubbing: blob first in vault mode. */
function staticThumbSrc(id) {
  return (_thumbsEncrypted && getThumbBlob(id)) || thumbUrlById(id);
}

/** Scrub frames follow the same versioning as the thumbnail they replace. */
function scrubUrl(id, idx) {
  const m = (typeof getMediaById === 'function') ? getMediaById(id) : null;
  const v = (!_thumbsEncrypted && m && m.thumb_version) || 0;
  return v ? `/scrub/${id}/${idx}?v=${thumbVersionTag(v)}` : `/scrub/${id}/${idx}`;
}

/**
 * The attributes a tile <img> needs. In vault mode the tag ships without a
 * src: hydrateThumbs() fills it in from the memory cache after the render.
 */
function thumbImgAttrs(media) {
  const url = thumbUrl(media);
  return _thumbsEncrypted
    ? `data-thumb-id="${media.id}" data-thumb-src="${url}"`
    : `data-thumb-id="${media.id}" src="${url}"`;
}

/* ── The two states an <img> can be put into ──────────────────────────── */

function showThumbImg(img, src) {
  img.src = src;
  img.style.display = '';
  if (img.parentElement) img.parentElement.classList.remove('thumb-fallback');
}

/** No picture (yet): hide the img so the tile's type icon shows through. */
function hideThumbImg(img) {
  img.style.display = 'none';
  if (img.parentElement) img.parentElement.classList.add('thumb-fallback');
}

/* ── Vault mode: object-URL LRU ───────────────────────────────────────── */

function getThumbBlob(id) {
  const e = _thumbBlobs.get(id);
  if (!e) return null;
  _thumbBlobs.delete(id);          // re-insert: Map keeps insertion order,
  _thumbBlobs.set(id, e);          // so the front is always the coldest
  return e.url;
}

function putThumbBlob(id, blob) {
  const old = _thumbBlobs.get(id);
  if (old) {
    _thumbBlobs.delete(id);
    _thumbBlobBytes -= old.size;
    URL.revokeObjectURL(old.url);
  }
  const url = URL.createObjectURL(blob);
  _thumbBlobs.set(id, { url, size: blob.size });
  _thumbBlobBytes += blob.size;
  while (_thumbBlobs.size > THUMB_BLOB_MAX_ENTRIES || _thumbBlobBytes > THUMB_BLOB_MAX_BYTES) {
    const coldest = _thumbBlobs.keys().next().value;
    if (coldest === undefined || coldest === id) break;
    const e = _thumbBlobs.get(coldest);
    _thumbBlobs.delete(coldest);
    _thumbBlobBytes -= e.size;
    URL.revokeObjectURL(e.url);
  }
  return url;
}

/** Locking the vault must not leave decrypted pictures alive in the tab. */
function revokeThumbBlobs() {
  for (const e of _thumbBlobs.values()) URL.revokeObjectURL(e.url);
  _thumbBlobs.clear();
  _thumbBlobBytes = 0;
}

function thumbBlobStats() {
  return { entries: _thumbBlobs.size, bytes: _thumbBlobBytes, dead: _thumbDead.size };
}

/* ── Vault mode: fill in the images a render just put on the page ─────── */

function hydrateThumbs(root) {
  if (!_thumbsEncrypted) return;
  const scope = root || document;
  scope.querySelectorAll('img[data-thumb-src]:not([data-thumb-bound])').forEach((img) => {
    img.setAttribute('data-thumb-bound', '1');
    loadBlobThumb(img, Number(img.dataset.thumbId), img.dataset.thumbSrc, 0);
  });
}

async function loadBlobThumb(img, id, url, attempt) {
  const hit = getThumbBlob(id);
  if (hit) { showThumbImg(img, hit); return; }
  if (_thumbDead.has(id)) { hideThumbImg(img); return; }

  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    hideThumbImg(img);
    return;
  }
  if (res.ok) {
    const blob = await res.blob();
    if (img.isConnected) showThumbImg(img, putThumbBlob(id, blob));
    else putThumbBlob(id, blob);
    return;
  }

  hideThumbImg(img);
  if (res.headers.get('X-Thumb') !== 'pending') { _thumbDead.add(id); return; }
  const wait = thumbRetryDelay(attempt);
  if (wait == null) return;
  setTimeout(() => {
    if (img.isConnected) loadBlobThumb(img, id, url, attempt + 1);
  }, wait);
}

/* ── Plain mode: wait for a pending thumbnail ─────────────────────────── */

function thumbIdFromSrc(src) {
  const m = /\/thumb\/(\d+)/.exec(src || '');
  return m ? Number(m[1]) : 0;
}

/**
 * One capture-phase listener for every /thumb image in the page. Error events
 * do not bubble, but they do capture, and stopping one here means the tag's
 * own onerror (which would remove the img for good) never runs while there is
 * still a reason to hope.
 */
function initThumbRetry() {
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    // Vault-mode images are owned by loadBlobThumb(), which does its own
    // waiting; it never leaves a src that can fail this way.
    if (img.dataset.thumbSrc) return;
    const url = img.getAttribute('src') || '';
    const id = Number(img.dataset.thumbId) || thumbIdFromSrc(url);
    if (!id || !/\/thumb\//.test(url)) return;
    const attempt = Number(img.dataset.thumbTry || 0);
    // Out of patience, or a file we already know is not there: let the event
    // through so the page's own fallback runs.
    const wait = thumbRetryDelay(attempt);
    if (_thumbDead.has(id) || wait == null) return;

    e.stopPropagation();
    img.dataset.thumbTry = String(attempt + 1);
    hideThumbImg(img);
    setTimeout(() => { if (img.isConnected) retryThumbImg(img, id, url); }, wait);
  }, true);
}

/**
 * Stop waiting, and let the page's own fallback run: the img's onerror (a
 * tile drops its img and shows the type icon, a studio card shows its
 * letter, a collection cell its icon). The real error event was held back by
 * the listener above while there was hope; this one gets through because
 * the id is now dead or out of retries.
 */
function giveUpThumbImg(img) {
  if (!img.isConnected) return;
  hideThumbImg(img);
  img.dataset.thumbTry = String(THUMB_BACKOFF_MS.length + 1);
  img.dispatchEvent(new Event('error'));
}

/**
 * Ask once whether the thumbnail has arrived. A fetch rather than a blind
 * reload because only the response headers can tell "still generating" apart
 * from "this file does not exist", and the second one deserves to stop now
 * rather than after the full backoff.
 */
async function retryThumbImg(img, id, url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    return;
  }
  if (res.ok) {
    if (!img.isConnected) return;
    img.removeAttribute('src');
    showThumbImg(img, url);
    return;
  }
  if (res.headers.get('X-Thumb') !== 'pending') {
    // Gone for good: the tile shows its type icon (the img's own onerror).
    _thumbDead.add(id);
    giveUpThumbImg(img);
    return;
  }
  const attempt = Number(img.dataset.thumbTry || 0);
  const wait = thumbRetryDelay(attempt);
  if (wait == null) { giveUpThumbImg(img); return; }
  img.dataset.thumbTry = String(attempt + 1);
  setTimeout(() => { if (img.isConnected) retryThumbImg(img, id, url); }, wait);
}

/* ── Prefetch ─────────────────────────────────────────────────────────────
   The next page is the one the user is most likely to ask for, and the
   previous one is where Back goes, so both are worth having ready. Nothing
   starts until the view has been still for a moment: paging through five
   pages should fetch the fifth one's neighbours, not all five. */

let _prefetchTimer = null;
let _prefetchAbort = null;
let _prefetchImgs = [];
let _prefetchRun = 0;     // bumped on every cancel; in-flight batches check it

function cancelThumbPrefetch() {
  _prefetchRun++;
  clearTimeout(_prefetchTimer);
  _prefetchTimer = null;
  if (_prefetchAbort) { _prefetchAbort.abort(); _prefetchAbort = null; }
  for (const im of _prefetchImgs) { try { im.src = ''; } catch {} }
  _prefetchImgs = [];
}

/**
 * @param {Array<Array<object>>} batches - groups of media rows, most wanted
 *   first. They are fetched one group at a time, in order; anything past
 *   THUMB_PREFETCH_MAX_BATCHES is dropped rather than queued.
 */
function scheduleThumbPrefetch(batches) {
  cancelThumbPrefetch();
  const groups = (batches || []).filter(b => b && b.length).slice(0, THUMB_PREFETCH_MAX_BATCHES);
  if (!groups.length) return;
  const run = _prefetchRun;
  const deadline = Date.now() + THUMB_PREFETCH_QUIET_MS + PREFETCH_GATE_MAX_MS;
  _prefetchTimer = setTimeout(() => runPrefetch(groups, deadline, run), THUMB_PREFETCH_QUIET_MS);
}

/**
 * Prefetching is for the page after this one, so it must never slow this one
 * down. On localhost the browser opens six connections and serves them in
 * order, which means a low fetch priority buys nothing: pages of guesses
 * queued ahead of the tiles the user is looking at would leave those tiles
 * blank. So wait until every visible tile has settled, one way or the other.
 */
function gridStillLoading() {
  return [...document.querySelectorAll('#resultsGrid .tile-img')].some(img => !img.complete);
}

function runPrefetch(groups, deadline, run) {
  _prefetchTimer = null;
  if (run !== _prefetchRun) return;
  // Wall clock, not a tick count: a background tab throttles timers to about
  // one a second, and counting 120 ms per tick would have made this wait half
  // a minute rather than four seconds.
  if (gridStillLoading() && Date.now() < deadline) {
    _prefetchTimer = setTimeout(() => runPrefetch(groups, deadline, run), 120);
    return;
  }
  if (_thumbsEncrypted) _prefetchAbort = new AbortController();
  prefetchGroups(groups, run);
}

/** One batch at a time, in the order given, until something cancels us. */
async function prefetchGroups(groups, run) {
  for (const g of groups) {
    if (run !== _prefetchRun) return;
    await prefetchBatch(g, run);
  }
}

function prefetchBatch(group, run) {
  const signal = _prefetchAbort && _prefetchAbort.signal;
  const work = _thumbsEncrypted
    ? group.map(m => prefetchThumbBlob(m, signal))
    : group.map(m => prefetchThumbImg(m, run));
  // A request that never settles must not hold up the batches behind it.
  return Promise.race([
    Promise.all(work),
    new Promise(resolve => setTimeout(resolve, PREFETCH_BATCH_TIMEOUT_MS)),
  ]);
}

function prefetchThumbImg(media, run) {
  return new Promise((resolve) => {
    if (!thumbPrefetchable(media) || run !== _prefetchRun) { resolve(); return; }
    const im = new Image();
    im.setAttribute('fetchpriority', 'low');
    im.decoding = 'async';
    // One listener does both jobs, and the error one captures. A prefetch is a
    // guess: it must never turn into a retry loop or steal the placeholder
    // from a real tile, so the error stops here. It cannot be two listeners --
    // Chrome runs a capture listener on the target during the capture phase,
    // and the stopPropagation in it then skips every later listener on the
    // same image, which left this promise pending until its batch timed out.
    const done = (e) => { if (e && e.type === 'error') e.stopPropagation(); resolve(); };
    im.addEventListener('load', done);
    im.addEventListener('error', done, true);
    im.src = thumbUrl(media);
    _prefetchImgs.push(im);
  });
}

async function prefetchThumbBlob(media, signal) {
  if (!thumbPrefetchable(media)) return;
  if (_thumbBlobs.has(media.id)) return;
  try {
    const res = await fetch(thumbUrl(media), { cache: 'no-store', signal, priority: 'low' });
    if (!res.ok) return;
    putThumbBlob(media.id, await res.blob());
  } catch { /* aborted or offline - a prefetch has nothing to report */ }
}

initThumbRetry();
window.vaultRevokeThumbBlobs = revokeThumbBlobs;
window.vaultSetThumbsEncrypted = setThumbsEncrypted;
window.vaultThumbBlobStats = thumbBlobStats;
window.vaultSetThumbSettings = setThumbSettings;
