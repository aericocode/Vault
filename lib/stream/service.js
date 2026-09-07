/**
 * Streaming service — the glue between a media row and a way to play it.
 *
 * Everything above this layer (the routes, the CLI, the backfill job) asks two
 * questions: "how should this file be played?" and "give me segment n". The
 * decision matrix (decide.js), the keyframe index (index.js), the segment store
 * (store.js) and the FFmpeg producer (session.js) each own one piece; this file
 * is what puts them in order and writes the results back to the database.
 */

const fs = require('fs');
const db = require('../database');
const mediaInfo = require('../media-info');
const streamIndex = require('./index');
const store = require('./store');
const session = require('./session');
const { decide, DEFAULT_CAPS } = require('./decide');

/** Codec tags the client may send. Anything else in `caps` is ignored. */
const KNOWN_CAPS = new Set([
  'h264', 'h264hi10', 'hevc', 'hevc10', 'av1', 'vp9', 'vp8',
  'aac', 'mp3', 'opus', 'flac', 'ac3', 'eac3',
]);

/** Parse the `caps` query string into a set, falling back to the CLI default. */
function parseCaps(raw) {
  if (!raw) return new Set(DEFAULT_CAPS);
  const list = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(t => KNOWN_CAPS.has(t));
  return list.length ? new Set(list) : new Set(DEFAULT_CAPS);
}

/**
 * Make sure the row carries codec info, probing the file if this feature has
 * never seen it. Returns the (possibly re-read) row, or the original row when
 * the probe fails — a decision on stale data beats no decision at all.
 */
async function ensureProbed(row) {
  if (row.probe_version >= db.PROBE_VERSION) return row;
  if (!fs.existsSync(row.filepath)) return row;
  const info = await mediaInfo.getStreamInfo(row.filepath);
  if (!info) return row;
  db.saveStreamInfo(row.id, info);
  return db.getById(row.id) || row;
}

/** Is this a remux of an audio-only file? (no video stream at all) */
function isAudioOnly(row) {
  return !row.video_codec;
}

/** The producer plan for a row — independent of the client's capabilities. */
function planFor(row) {
  const audioOnly = isAudioOnly(row);
  const a = String(row.audio_codec || '').toLowerCase();
  return {
    audioOnly,
    audioPlan: audioOnly ? 'aac' : (a === 'aac' || a === 'mp3' ? 'copy' : 'aac'),
  };
}

/**
 * Per-media-id chain for index builds.
 *
 * The build and the cache invalidation it implies have to be one critical
 * section. Without it, two cold segment requests for the same unindexed file
 * both find nothing cached, both run ffprobe, and the second one's deleteAll()
 * removes segments the first one has already produced and served — the client
 * gets a 200 for a segment that is no longer in the store. One chain per id
 * rather than the global one in session.js, because an index build is the slow
 * part (a full ffprobe pass) and there is no reason for two different files to
 * queue behind each other.
 */
const indexChains = new Map();

/** Every index actually built by this process (verification hook). */
let indexBuilds = 0;

function serializeIndex(mediaId, fn) {
  const prev = indexChains.get(mediaId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => {}, () => {});
  indexChains.set(mediaId, tail);
  tail.then(() => { if (indexChains.get(mediaId) === tail) indexChains.delete(mediaId); });
  return run;
}

/** Do two indexes cut the file at the same places? */
function sameBoundaries(a, b) {
  if (!a || !b) return false;
  if (a.indexVersion !== b.indexVersion) return false;
  if (a.containerStart !== b.containerStart) return false;
  const x = a.segments || [], y = b.segments || [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Load the keyframe index, building and storing it when missing or stale. */
async function ensureIndex(row) {
  const cached = db.getStreamIndex(row.id, streamIndex.INDEX_VERSION);
  if (cached) return cached;
  return serializeIndex(row.id, async () => {
    // Re-check inside the section: while this request was queued, the one ahead
    // of it may have built exactly the index we came for.
    const fresh = db.getStreamIndex(row.id, streamIndex.INDEX_VERSION);
    if (fresh) return fresh;

    // Whatever is stored under any version, for the comparison below.
    const before = db.getStreamIndex(row.id, null);
    const idx = await streamIndex.build(row.filepath, row.duration_seconds || 0, isAudioOnly(row));
    indexBuilds++;
    db.saveStreamIndex(row.id, idx);

    // A rebuilt index invalidates whatever was cached against the old one — but
    // only when the cuts actually moved. A rebuild that lands on the same
    // boundaries (a bumped version with unchanged output, a row that went
    // missing) leaves segments that are still byte-for-byte correct, and
    // throwing those away costs a full re-remux for nothing.
    const cache = db.getStreamCache(row.id);
    if (cache && !sameBoundaries(before, idx)) {
      const dropped = store.deleteAll(row.id);
      // Refused because the cache folder is not marked Vault-owned: say so rather
      // than leaving segments cut for a different index quietly in place.
      if (!dropped.ok) console.warn(`[Stream] stale segments for media ${row.id} kept: ${dropped.error}`);
    }
    return idx;
  });
}

/**
 * The /api/playback/:id answer.
 * @param {object} row  a media row
 * @param {Set<string>} caps
 */
async function playbackInfo(row, caps) {
  const probed = await ensureProbed(row);
  const d = decide(probed, caps);

  const cache = db.getStreamCache(probed.id);
  const base = {
    mode: d.mode,
    reason: d.reason,
    hint: d.hint,
    duration: probed.duration_seconds || 0,
    video_codec: probed.video_codec,
    audio_codec: probed.audio_codec,
    container: probed.container,
    cached: !!cache,
    complete: !!(cache && cache.complete),
  };

  if (d.mode === 'native') {
    return { ...base, url: `/media/${probed.id}`, fallback: d.fallback };
  }
  if (d.mode === 'remux') {
    return { ...base, url: `/stream/${probed.id}/index.m3u8`, fallback: null };
  }
  return { ...base, url: null, fallback: null };
}

/**
 * Serve-side helper: the playlist text for a media id, building the index on
 * the first request. Throws with .code STREAM_* on failure.
 */
async function playlistFor(row) {
  // Probe FIRST. Everything downstream branches on the codec columns — an
  // unprobed row looks audio-only, and would be indexed and remuxed as if the
  // video stream were not there.
  const probed = await ensureProbed(row);
  const idx = await ensureIndex(probed);
  db.saveStreamCache(probed.id, {
    ...(db.getStreamCache(probed.id) || { bytes: 0, have_mask: '', complete: 0 }),
    segment_count: idx.segments.length,
  });
  return { idx, text: streamIndex.playlist(idx) };
}

/**
 * Get segment n, starting or steering the producer as needed.
 * @returns {Promise<{ok:true, seg:object}|{ok:false, status:number, error:string}>}
 */
async function segmentFor(inputRow, n) {
  // Cheap path first: a stored segment needs neither a probe nor an index.
  if (Number.isInteger(n) && n >= 0) {
    const cached = store.get(inputRow.id, n);
    if (cached) {
      store.touch(inputRow.id);
      return { ok: true, seg: cached };
    }
  }

  // Same reason as playlistFor: the plan and the index both read the codec
  // columns, so the row has to carry them before either is computed.
  const row = await ensureProbed(inputRow);
  const idx = await ensureIndex(row);
  if (!Number.isInteger(n) || n < 0 || n >= idx.segments.length) {
    return { ok: false, status: 404, error: 'no such segment' };
  }

  const hit = store.get(row.id, n);
  if (hit) {
    store.touch(row.id);
    return { ok: true, seg: hit };
  }

  if (!fs.existsSync(row.filepath)) {
    return { ok: false, status: 404, error: 'the source file is missing' };
  }

  try {
    await session.ensure(row.id, row, idx, planFor(row), n);
  } catch (err) {
    return { ok: false, status: 503, error: err.message };
  }
  const waited = await session.waitFor(row.id, n);
  if (!waited.ok) return { ok: false, status: 503, error: waited.error };

  store.touch(row.id);
  const seg = store.get(row.id, n);
  if (!seg) return { ok: false, status: 503, error: 'the segment went missing after it was written' };
  return { ok: true, seg };
}

/** Everything a locked / cleared / deleted file needs done at once. */
async function forget(mediaId) {
  await session.stop(mediaId);
  store.deleteAll(mediaId);
  db.deleteStreamIndex(mediaId);
}

module.exports = {
  parseCaps, ensureProbed, ensureIndex, planFor, isAudioOnly,
  playbackInfo, playlistFor, segmentFor, forget, KNOWN_CAPS,
  get indexBuilds() { return indexBuilds; },
};
