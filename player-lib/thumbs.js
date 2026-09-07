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
   ========================================================================= */

const THUMB_BACKOFF_MS = [1000, 2000, 4000, 8000];
const THUMB_BLOB_MAX_ENTRIES = 1500;
const THUMB_BLOB_MAX_BYTES = 150 * 1024 * 1024;
const THUMB_PREFETCH_QUIET_MS = 150;
const THUMB_PREFETCH_MAX_BATCHES = 2;
const THUMBABLE_MEDIA = new Set(['video', 'image', 'gif', 'mix']);

let _thumbsEncrypted = false;
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

/** Read the vault's state once, before the first grid render. */
async function initThumbMode() {
  try {
    const s = await fetch('/api/vault/status').then(r => r.json());
    setThumbsEncrypted(!!s.encrypted && !s.locked);
  } catch { /* server unreachable — plain mode is the safe assumption */ }
}

/* ── URLs ─────────────────────────────────────────────────────────────── */

function thumbable(media) {
  return !!media && THUMBABLE_MEDIA.has(media.media_type);
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
  return (!_thumbsEncrypted && v) ? `/thumb/${media.id}?v=${v}` : `/thumb/${media.id}`;
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
  return v ? `/scrub/${id}/${idx}?v=${v}` : `/scrub/${id}/${idx}`;
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
  if (attempt >= THUMB_BACKOFF_MS.length) return;
  setTimeout(() => {
    if (img.isConnected) loadBlobThumb(img, id, url, attempt + 1);
  }, THUMB_BACKOFF_MS[attempt]);
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
    if (_thumbDead.has(id) || attempt >= THUMB_BACKOFF_MS.length) return;

    e.stopPropagation();
    img.dataset.thumbTry = String(attempt + 1);
    hideThumbImg(img);
    setTimeout(() => { if (img.isConnected) retryThumbImg(img, id, url); }, THUMB_BACKOFF_MS[attempt]);
  }, true);
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
  if (res.headers.get('X-Thumb') !== 'pending') { _thumbDead.add(id); return; }
  const attempt = Number(img.dataset.thumbTry || 0);
  if (attempt >= THUMB_BACKOFF_MS.length) return;
  img.dataset.thumbTry = String(attempt + 1);
  setTimeout(() => { if (img.isConnected) retryThumbImg(img, id, url); }, THUMB_BACKOFF_MS[attempt]);
}

/* ── Prefetch ─────────────────────────────────────────────────────────────
   The next page is the one the user is most likely to ask for, and the
   previous one is where Back goes, so both are worth having ready. Nothing
   starts until the view has been still for a moment: paging through five
   pages should fetch the fifth one's neighbours, not all five. */

let _prefetchTimer = null;
let _prefetchAbort = null;
let _prefetchImgs = [];

function cancelThumbPrefetch() {
  clearTimeout(_prefetchTimer);
  _prefetchTimer = null;
  if (_prefetchAbort) { _prefetchAbort.abort(); _prefetchAbort = null; }
  for (const im of _prefetchImgs) { try { im.src = ''; } catch {} }
  _prefetchImgs = [];
}

/**
 * @param {Array<Array<object>>} batches - up to two groups of media rows.
 *   Anything past the second is dropped rather than queued.
 */
function scheduleThumbPrefetch(batches) {
  cancelThumbPrefetch();
  const groups = (batches || []).filter(b => b && b.length).slice(0, THUMB_PREFETCH_MAX_BATCHES);
  if (!groups.length) return;
  _prefetchTimer = setTimeout(() => runPrefetch(groups, 0), THUMB_PREFETCH_QUIET_MS);
}

/**
 * Prefetching is for the page after this one, so it must never slow this one
 * down. On localhost the browser opens six connections and serves them in
 * order, which means a low fetch priority buys nothing: two pages of guesses
 * queued ahead of the tiles the user is looking at would leave those tiles
 * blank. So wait until every visible tile has settled, one way or the other.
 */
function gridStillLoading() {
  return [...document.querySelectorAll('#resultsGrid .tile-img')].some(img => !img.complete);
}

function runPrefetch(groups, waited) {
  _prefetchTimer = null;
  if (gridStillLoading() && waited < 4000) {
    _prefetchTimer = setTimeout(() => runPrefetch(groups, waited + 120), 120);
    return;
  }
  if (_thumbsEncrypted) {
    _prefetchAbort = new AbortController();
    const signal = _prefetchAbort.signal;
    for (const g of groups) for (const m of g) prefetchThumbBlob(m, signal);
    return;
  }
  for (const g of groups) for (const m of g) {
    if (!thumbable(m) || _thumbDead.has(m.id)) continue;
    const im = new Image();
    im.setAttribute('fetchpriority', 'low');
    im.decoding = 'async';
    // A prefetch is a guess. It must never turn into a retry loop or steal
    // the placeholder from a real tile, so it gets no error handling at all.
    im.addEventListener('error', (e) => e.stopPropagation(), true);
    im.src = thumbUrl(m);
    _prefetchImgs.push(im);
  }
}

async function prefetchThumbBlob(media, signal) {
  if (!thumbable(media) || _thumbDead.has(media.id)) return;
  if (_thumbBlobs.has(media.id)) return;
  try {
    const res = await fetch(thumbUrl(media), { cache: 'no-store', signal, priority: 'low' });
    if (!res.ok) return;
    putThumbBlob(media.id, await res.blob());
  } catch { /* aborted or offline — a prefetch has nothing to report */ }
}

initThumbRetry();
window.vaultRevokeThumbBlobs = revokeThumbBlobs;
window.vaultSetThumbsEncrypted = setThumbsEncrypted;
window.vaultThumbBlobStats = thumbBlobStats;
