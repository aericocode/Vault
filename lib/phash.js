/**
 * Perceptual hashing (pHash) — visual duplicate detection.
 *
 * The existing dupe detection matches normalized filename + size, which
 * misses re-encodes, resizes and re-muxed copies. pHash catches those:
 * ffmpeg renders the image/thumbnail to 32×32 grayscale, a 2D DCT reduces
 * it to its lowest frequencies, and the top-left 8×8 block (minus DC)
 * becomes a 64-bit hash. Visually similar files differ by only a few bits
 * regardless of resolution or compression.
 *
 * No image library needed — ffmpeg (already required) does the decode.
 */

const { spawn } = require('child_process');

const SIZE = 32;   // DCT input
const LOW = 8;     // low-frequency block kept

/** Run ffmpeg and capture BINARY stdout (proc.run is utf-8 — corrupts raw). */
function ffmpegRaw(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(require('./ffmpeg-locate').resolve('ffmpeg'), args, { windowsHide: true });
    const chunks = [];
    let stderr = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-200)}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

// Precomputed DCT-II cosine table for N=32
const COS = (() => {
  const t = [];
  for (let k = 0; k < SIZE; k++) {
    t[k] = new Float64Array(SIZE);
    for (let n = 0; n < SIZE; n++) {
      t[k][n] = Math.cos(((2 * n + 1) * k * Math.PI) / (2 * SIZE));
    }
  }
  return t;
})();

/** 2D DCT-II of a SIZE×SIZE grayscale buffer; returns only the LOW×LOW block. */
function dctLowFreq(pixels) {
  // rows first
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    rows[y] = new Float64Array(LOW);
    for (let k = 0; k < LOW; k++) {
      let sum = 0;
      for (let n = 0; n < SIZE; n++) sum += pixels[y * SIZE + n] * COS[k][n];
      rows[y][k] = sum;
    }
  }
  // then columns
  const out = new Float64Array(LOW * LOW);
  for (let k = 0; k < LOW; k++) {
    for (let x = 0; x < LOW; x++) {
      let sum = 0;
      for (let n = 0; n < SIZE; n++) sum += rows[n][x] * COS[k][n];
      out[k * LOW + x] = sum;
    }
  }
  return out;
}

/**
 * Compute the 64-bit pHash of an image file (or a video frame — pass a
 * thumbnail). @returns {string} 16-char hex hash
 */
async function phashFile(imagePath) {
  const raw = await ffmpegRaw([
    '-hide_banner', '-loglevel', 'error',
    '-i', imagePath,
    '-vf', `scale=${SIZE}:${SIZE}:flags=area,format=gray`,
    '-frames:v', '1',
    '-f', 'rawvideo', '-',
  ]);
  if (raw.length < SIZE * SIZE) throw new Error(`short read (${raw.length} bytes)`);

  const dct = dctLowFreq(raw);
  // Median of the low-frequency coefficients, excluding DC (index 0)
  const vals = Array.from(dct.slice(1)).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];

  let hash = 0n;
  for (let i = 1; i < LOW * LOW; i++) {
    hash = (hash << 1n) | (dct[i] > median ? 1n : 0n);
  }
  return hash.toString(16).padStart(16, '0');
}

/** Hamming distance between two hex hashes (0 = identical, 64 = opposite). */
function hamming(hexA, hexB) {
  let x = BigInt('0x' + hexA) ^ BigInt('0x' + hexB);
  let bits = 0;
  while (x) { bits += Number(x & 1n); x >>= 1n; }
  return bits;
}

/**
 * Group items by visual similarity (union-find over pairs within threshold).
 * @param {Array<{id:number, phash:string}>} items
 * @param {number} threshold max hamming distance to link (default 8)
 * @returns {Array<number[]>} groups of ids (only groups with 2+ members)
 */
function groupBySimilarity(items, threshold = 8) {
  const parent = new Map(items.map(it => [it.id, it.id]));
  const find = (a) => {
    while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); }
    return a;
  };
  const union = (a, b) => { parent.set(find(a), find(b)); };

  // Pre-decode to BigInt once (hamming in the hot loop)
  const decoded = items.map(it => ({ id: it.id, h: BigInt('0x' + it.phash) }));
  for (let i = 0; i < decoded.length; i++) {
    for (let j = i + 1; j < decoded.length; j++) {
      let x = decoded[i].h ^ decoded[j].h;
      let bits = 0;
      while (x && bits <= threshold) { bits += Number(x & 1n); x >>= 1n; }
      if (bits <= threshold) union(decoded[i].id, decoded[j].id);
    }
  }

  const groups = new Map();
  for (const it of items) {
    const root = find(it.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it.id);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

module.exports = { phashFile, hamming, groupBySimilarity };
