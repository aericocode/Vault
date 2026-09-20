// The matcher's bestMatch abandons hopeless offsets early. These tests pin
// that optimisation to the naive full-count implementation it replaced:
// same BER, same offset, same overlap length, same winner, on random data,
// on planted matches around the 7% threshold, and at exact boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const matcher = require('../lib/musicid/matcher');

/* ── The pre-optimisation matcher, kept here as the oracle ─────────────── */

function naivePopcount(x) {
  let c = 0;
  for (let v = x >>> 0; v; v >>>= 1) c += v & 1;
  return c;
}

function naiveCompareAt(a, b, offset) {
  let aStart, bStart;
  if (offset >= 0) { aStart = offset; bStart = 0; }
  else { aStart = 0; bStart = -offset; }
  const len = Math.min(a.length - aStart, b.length - bStart);
  if (len <= 0) return { ber: 1, length: 0 };
  let bits = 0;
  for (let i = 0; i < len; i++) bits += naivePopcount(a[aStart + i] ^ b[bStart + i]);
  return { ber: bits / (len * 32), length: len };
}

function naiveBestMatch(a, b, opts = {}) {
  const { maxOffset = null, minOverlap = 8 } = opts;
  const aLen = a.length, bLen = b.length;
  const cap = maxOffset != null ? maxOffset : Math.max(aLen, bLen);
  const lo = -Math.min(cap, bLen - minOverlap);
  const hi = Math.min(cap, aLen - minOverlap);
  let best = { ber: 1, offset: 0, length: 0 };
  for (let off = lo; off <= hi; off++) {
    const r = naiveCompareAt(a, b, off);
    if (r.length < minOverlap) continue;
    if (r.ber < best.ber) best = { ber: r.ber, offset: off, length: r.length };
  }
  return best;
}

function naiveMatchChunk(chunkFp, references, threshold) {
  let best = null;
  for (const ref of references) {
    const r = naiveBestMatch(chunkFp, ref.fingerprint, { maxOffset: ref.fingerprint.length });
    if (r.ber > threshold) continue;
    if (!best || r.ber < best.ber) {
      best = { song_id: ref.song_id, ref_id: ref.id, ber: r.ber, offset: r.offset, length: r.length };
    }
  }
  return best;
}

/* ── Deterministic fixtures ────────────────────────────────────────────── */

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
}

function randomFp(next, n) {
  const fp = new Int32Array(n);
  for (let i = 0; i < n; i++) fp[i] = next() | 0;
  return fp;
}

/** Copy of ref[start..start+len) with exactly `flips` single-bit errors spread over it. */
function plant(next, ref, start, len, flips) {
  const fp = ref.slice(start, start + len);
  for (let k = 0; k < flips; k++) {
    const i = k % len, bit = (k * 7 + (next() % 32)) % 32;
    fp[i] ^= (1 << bit);
  }
  return fp;
}

test('bestMatch equals the full-count matcher on random pairs', () => {
  const next = rng(11);
  for (let trial = 0; trial < 60; trial++) {
    const a = randomFp(next, 8 + (next() % 60));
    const b = randomFp(next, 8 + (next() % 60));
    for (const opts of [{}, { minOverlap: 3 }, { maxOffset: 5 }, { maxOffset: 0 }, { minOverlap: 1, maxOffset: 200 }]) {
      assert.deepEqual(matcher.bestMatch(a, b, opts), naiveBestMatch(a, b, opts), JSON.stringify(opts));
    }
  }
});

test('bestMatch equals the full-count matcher on planted matches near the threshold', () => {
  const next = rng(23);
  for (let trial = 0; trial < 80; trial++) {
    const ref = randomFp(next, 120 + (next() % 200));
    const len = 20 + (next() % 60);
    const start = next() % (ref.length - len);
    // 0 .. ~12% BER, dense around 7% (= 2.24 bits per int)
    const flips = Math.round(len * (next() % 40) / 10);
    const chunk = plant(next, ref, start, len, flips);
    const got = matcher.bestMatch(chunk, ref, { maxOffset: ref.length });
    const want = naiveBestMatch(chunk, ref, { maxOffset: ref.length });
    assert.deepEqual(got, want);
    if (flips === 0) assert.equal(got.offset, -start);   // sanity: the plant is found
  }
});

test('bestMatch is exact at the threshold boundary and honours maxBer', () => {
  const next = rng(37);
  const ref = randomFp(next, 300);
  // len 25 → 7% of 25*32 bits is exactly 56 bits: at, just under, just over
  for (const flips of [55, 56, 57]) {
    const chunk = plant(next, ref, 100, 25, flips);
    const want = naiveBestMatch(chunk, ref, { maxOffset: ref.length });
    assert.deepEqual(matcher.bestMatch(chunk, ref, { maxOffset: ref.length }), want);
    // With a ceiling of 0.07 the planted offset must still be reported
    // exactly when it qualifies (<= 0.07) and must not be "beaten" by a
    // worse offset when it does not.
    const capped = matcher.bestMatch(chunk, ref, { maxOffset: ref.length, maxBer: 0.07 });
    if (want.ber <= 0.07) assert.deepEqual(capped, want);
    else assert.ok(capped.ber > 0.07, `flips ${flips}: capped ber ${capped.ber}`);
  }
});

test('matchChunkAgainstReferences picks the same reference as the full-count matcher', () => {
  const next = rng(41);
  const refs = [];
  for (let i = 0; i < 40; i++) {
    refs.push({ id: i + 1, song_id: 100 + (i % 7), fingerprint: randomFp(next, 150 + (next() % 150)) });
  }
  const chunks = [];
  for (let t = 0; t < 40; t++) {
    const r = refs[next() % refs.length];
    const len = 16 + (next() % 48);
    const start = next() % (r.fingerprint.length - len);
    chunks.push(plant(next, r.fingerprint, start, len, Math.round(len * (next() % 30) / 10)));
  }
  chunks.push(randomFp(next, 40));            // no planted match at all
  for (const th of [0.07, 0.10, 0.02]) {
    for (const c of chunks) {
      assert.deepEqual(matcher.matchChunkAgainstReferences(c, refs, th), naiveMatchChunk(c, refs, th));
    }
  }
});
