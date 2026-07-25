/**
 * Music ID — Chromaprint fingerprint matching (CJS port of SAMPLES matcher.js).
 *
 * Each fingerprint is an Int32Array; each int encodes ~0.124s of audio.
 * Match score = bit error rate (BER) between aligned arrays.
 * BER ≤ ~7% is a strong match (Chromaprint convention).
 * Dependency-free: XOR + popcount.
 */

const { decodeFingerprint } = require('./fingerprint');

// Default match threshold: BER below this is considered a match.
const DEFAULT_BER_THRESHOLD = 0.07;

// Lookup table: popcount of each byte 0..255
const POPCOUNT = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i, c = 0;
    while (v) { c += v & 1; v >>>= 1; }
    t[i] = c;
  }
  return t;
})();

function popcount32(x) {
  return POPCOUNT[x & 0xff] +
         POPCOUNT[(x >>> 8) & 0xff] +
         POPCOUNT[(x >>> 16) & 0xff] +
         POPCOUNT[(x >>> 24) & 0xff];
}

/**
 * Compare two fingerprint arrays at offset `offset` (in items) over the
 * overlapping region only. Returns { ber, length }.
 */
function compareAt(a, b, offset) {
  let aStart, bStart;
  if (offset >= 0) { aStart = offset; bStart = 0; }
  else { aStart = 0; bStart = -offset; }
  const len = Math.min(a.length - aStart, b.length - bStart);
  if (len <= 0) return { ber: 1, length: 0 };
  let bits = 0;
  for (let i = 0; i < len; i++) {
    bits += popcount32(a[aStart + i] ^ b[bStart + i]);
  }
  return { ber: bits / (len * 32), length: len };
}

/**
 * Find best alignment + BER between two fingerprints.
 * Scans offsets in [-maxOffset, +maxOffset], picks lowest BER among those
 * with sufficient overlap. Returns { ber, offset, length }.
 */
function bestMatch(a, b, opts = {}) {
  const { maxOffset = null, minOverlap = 8 } = opts;
  const aLen = a.length, bLen = b.length;
  const cap = maxOffset != null ? maxOffset : Math.max(aLen, bLen);
  const lo = -Math.min(cap, bLen - minOverlap);
  const hi = Math.min(cap, aLen - minOverlap);
  let best = { ber: 1, offset: 0, length: 0 };
  for (let off = lo; off <= hi; off++) {
    const r = compareAt(a, b, off);
    if (r.length < minOverlap) continue;
    if (r.ber < best.ber) best = { ber: r.ber, offset: off, length: r.length };
  }
  return best;
}

/**
 * Match a single media chunk against all reference song fingerprints.
 * @param chunkFp Int32Array of the media chunk
 * @param references Array<{ id, song_id, fingerprint: Int32Array }>
 * @param threshold Max BER for a match
 * @returns Best matching { song_id, ref_id, ber, offset, length } or null
 */
function matchChunkAgainstReferences(chunkFp, references, threshold = DEFAULT_BER_THRESHOLD) {
  let best = null;
  for (const ref of references) {
    const r = bestMatch(chunkFp, ref.fingerprint, { maxOffset: ref.fingerprint.length });
    if (r.ber > threshold) continue;
    if (!best || r.ber < best.ber) {
      best = { song_id: ref.song_id, ref_id: ref.id, ber: r.ber, offset: r.offset, length: r.length };
    }
  }
  return best;
}

/** Decode a row's base64 fingerprint into Int32Array (mutates row). */
function hydrateRow(row) {
  if (typeof row.fingerprint === 'string') {
    row.fingerprint = decodeFingerprint(row.fingerprint);
  }
  return row;
}

/**
 * Group consecutive matching chunks for the same song into spans.
 * Input: Array<{ start_sec, end_sec, match: { song_id, ber } | null }> in order.
 * Output: Array<{ song_id, start_sec, end_sec, chunk_count, mean_ber }>.
 * Allows up to `maxGapChunks` non-matching chunks within a span.
 */
function groupMatches(chunks, opts = {}) {
  const { maxGapChunks = 1 } = opts;
  const spans = [];
  let cur = null;
  let gap = 0;

  for (const c of chunks) {
    const sid = c.match?.song_id ?? null;
    if (cur && sid === cur.song_id) {
      cur.end_sec = c.end_sec;
      cur.chunk_count += 1;
      cur.ber_sum += c.match.ber;
      gap = 0;
    } else if (cur && sid == null && gap < maxGapChunks) {
      // tolerate a small gap, extend the span across it
      cur.end_sec = c.end_sec;
      gap += 1;
    } else {
      if (cur) {
        spans.push({
          song_id: cur.song_id,
          start_sec: cur.start_sec,
          end_sec: cur.end_sec,
          chunk_count: cur.chunk_count,
          mean_ber: cur.ber_sum / cur.chunk_count,
        });
      }
      if (sid != null) {
        cur = { song_id: sid, start_sec: c.start_sec, end_sec: c.end_sec, chunk_count: 1, ber_sum: c.match.ber };
        gap = 0;
      } else {
        cur = null;
        gap = 0;
      }
    }
  }
  if (cur) {
    spans.push({
      song_id: cur.song_id,
      start_sec: cur.start_sec,
      end_sec: cur.end_sec,
      chunk_count: cur.chunk_count,
      mean_ber: cur.ber_sum / cur.chunk_count,
    });
  }
  return spans;
}

module.exports = {
  DEFAULT_BER_THRESHOLD,
  compareAt, bestMatch, matchChunkAgainstReferences, hydrateRow, groupMatches,
};
