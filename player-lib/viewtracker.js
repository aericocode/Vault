/* =========================================================================
   VIEW TRACKER - Counts real views to surface forgotten files

   Rules (owner-defined):
   - video/audio: counts once when CUMULATIVE watch time reaches 75% of the
     duration (seek-proof: only forward progress < 2s per tick accumulates,
     so skipping to the end doesn't count, but watching in pieces does)
   - image/gif/document/3D: counts after a 2s dwell (rapid next/next
     flipping doesn't count)

   Counted once per playback; persisted via POST /api/media/:id/viewed.
   ========================================================================= */

const WATCH_THRESHOLD = 0.75;   // fraction of duration for A/V
const WATCH_THRESHOLD_SECONDS = 180; // OR watch at least this many seconds
const DWELL_MS = 2000;          // dwell for instant-view types
const INSTANT_VIEW_TYPES = ['image', 'gif', 'document'];

async function postViewed(item, watchSeconds = 0) {
  if (!item || !item.id) return;
  item.view_count = (item.view_count || 0) + 1; // optimistic
  try {
    const resp = await fetch(`/api/media/${item.id}/viewed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watch_s: Math.round(watchSeconds) }),
    });
    if (resp.ok) {
      // Merge ONLY the view fields — assigning the whole row would clobber
      // concurrent local updates (e.g. last_position saved during playback)
      const updated = await resp.json();
      item.view_count = updated.view_count;
      item.last_viewed_at = updated.last_viewed_at;
      // Gamify (opt-in): server attaches scoring results when enabled
      if (updated.gamify) {
        window.dispatchEvent(new CustomEvent('gamify:update', { detail: updated.gamify }));
      }
    }
  } catch (err) {
    console.warn('[Views] failed to record view:', err);
  }
}

/* ── Instant-view types: dwell timer hooked via playMedia wrapper ───────── */

let _dwellTimer = null;

// Wrap the global playMedia (defined in player-core.js, loaded before us).
// Every entry point — tiles, cards, details, next/prev — routes through it.
const _origPlayMedia = playMedia;
playMedia = function (mediaData, ...rest) {
  // ...rest forwards playMedia's options (the hands-free source flag).
  _origPlayMedia(mediaData, ...rest);

  clearTimeout(_dwellTimer);
  if (mediaData && INSTANT_VIEW_TYPES.includes(mediaData.media_type)) {
    const filepath = mediaData.filepath;
    _dwellTimer = setTimeout(() => {
      const item = allMedia.find(m => m.filepath === filepath);
      // Only count if the player is still showing (not closed mid-dwell)
      const overlay = document.getElementById('mediaPlayerOverlay');
      if (item && overlay && overlay.classList.contains('active')) {
        postViewed(item);
      }
    }, DWELL_MS);
  }
};

/* ── Video/audio: cumulative watch time via capture-phase timeupdate ────── */

const RESUME_MIN_S = 10;         // don't bother resuming under 10s in
const RESUME_MAX_FRACTION = 0.9; // ≥90% through → treat as finished
const POSITION_SAVE_EVERY_S = 5; // throttle for position writes

let _watch = { src: null, item: null, accumulated: 0, lastTime: null, counted: false, lastSaved: 0, heat: {} };

/* ── Watch-activity heatmap ─────────────────────────────────────────────────
   Real watch-seconds are binned into 100 buckets across the duration and
   flushed to the server (additive merge) on pause / media change / Done.
   Powers the YouTube-style "most watched" curve over the seek bar. */

function flushWatchHeat() {
  const item = _watch.item;
  const buckets = _watch.heat;
  _watch.heat = {};
  if (!item || !item.id) return;

  const total = Object.values(buckets).reduce((s, v) => s + v, 0);
  if (total < 1) return; // noise — not worth a write

  // Round for compact payloads
  for (const k of Object.keys(buckets)) buckets[k] = Math.round(buckets[k] * 10) / 10;

  fetch(`/api/media/${item.id}/heatmap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buckets }),
  }).then(r => r.ok ? r.json() : null).then(data => {
    if (data?.watch_heatmap) item.watch_heatmap = JSON.stringify(data.watch_heatmap);
  }).catch(() => {});
}

/** Persist the playback position (throttled by the caller). */
function _savePosition(item, position) {
  if (!item || !item.id) return;
  item.last_position = position;
  fetch(`/api/media/${item.id}/flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ last_position: Math.round(position * 10) / 10 }),
  }).catch(() => {});
}

// Auto-resume: when media loads, seek to the stored position
document.addEventListener('loadedmetadata', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (!['VIDEO', 'AUDIO'].includes(el.tagName)) return;
  if (!el.closest('#mediaPlayerContent') && !el.closest('#miniPlayerMedia')) return;

  // Settings: "Resume playback positions" gates ONLY the auto-seek. Positions
  // are still saved (pause handler below), so re-enabling restores behavior.
  if (typeof vaultSetting === 'function' && vaultSetting('resumePlayback') === false) return;

  const item = _mediaItemFromSrc(el.currentSrc || el.src);
  const pos = item?.last_position || 0;
  if (item && pos > RESUME_MIN_S && el.duration > 0 && pos < el.duration * RESUME_MAX_FRACTION) {
    el.currentTime = pos;
    showToast(`⏵ Resumed at ${formatDuration(pos)}`);
  }
}, true);

// Save position + flush the activity heatmap on pause (catches
// close-while-paused too — teardown pauses the element first)
document.addEventListener('pause', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement) || !['VIDEO', 'AUDIO'].includes(el.tagName)) return;
  if (!el.closest('#mediaPlayerContent') && !el.closest('#miniPlayerMedia')) return;
  flushWatchHeat();
  const item = _mediaItemFromSrc(el.currentSrc || el.src);
  if (item && el.currentTime > 0 && el.duration > 0) {
    const finished = el.currentTime >= el.duration * RESUME_MAX_FRACTION;
    _savePosition(item, finished ? 0 : el.currentTime);
  }
}, true);

function _mediaItemFromSrc(src) {
  try {
    const u = new URL(src, location.origin);
    const p = u.searchParams.get('p');
    if (p) return allMedia.find(m => m.filepath === p) || null;
    const m = u.pathname.match(/^\/media\/(\d+)/);
    if (m) return getMediaById(Number(m[1]));
  } catch {}
  return null;
}

document.addEventListener('timeupdate', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (!['VIDEO', 'AUDIO'].includes(el.tagName)) return;
  if (!el.closest('#mediaPlayerContent') && !el.closest('#miniPlayerMedia')) return;

  const src = el.currentSrc || el.src;
  if (!src) return;

  // New media started — flush the old heatmap, then reset the accumulator
  if (_watch.src !== src) {
    flushWatchHeat();
    _watch = {
      src,
      item: _mediaItemFromSrc(src),
      accumulated: 0,
      lastTime: el.currentTime,
      counted: false,
      lastSaved: el.currentTime,
      heat: {},
    };
    return;
  }

  const delta = el.currentTime - _watch.lastTime;
  _watch.lastTime = el.currentTime;

  // Only small forward steps count as watching (ignores seeks/loops-jumps)
  if (delta > 0 && delta < 2) {
    _watch.accumulated += delta;
    // Bin into the activity heatmap (100 buckets across the duration)
    if (el.duration > 0) {
      const bucket = Math.max(0, Math.min(99, Math.floor((el.currentTime / el.duration) * 100)));
      _watch.heat[bucket] = (_watch.heat[bucket] || 0) + delta;
    }
  }

  // Count the view once the cumulative watch time reaches the threshold % or seconds
  if (!_watch.counted && el.duration > 0 && (_watch.accumulated >= el.duration * WATCH_THRESHOLD || _watch.accumulated >= WATCH_THRESHOLD_SECONDS)) {
    _watch.counted = true;
    if (_watch.item) postViewed(_watch.item, _watch.accumulated);
  }

  // Throttled resume-position save (cleared once effectively finished)
  if (_watch.item && el.duration > 0 &&
      Math.abs(el.currentTime - _watch.lastSaved) >= POSITION_SAVE_EVERY_S) {
    _watch.lastSaved = el.currentTime;
    const finished = el.currentTime >= el.duration * RESUME_MAX_FRACTION;
    _savePosition(_watch.item, finished ? 0 : el.currentTime);
  }
}, true);
