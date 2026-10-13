/**
 * Minimal baseline JPEG encoder (JFIF, 4:4:4, standard Annex K tables).
 *
 * Face crops are tiny (~128px) and made one at a time in the middle of
 * analysis, so spawning ffmpeg per crop (tens of ms on Windows) would cost
 * more than the encode itself, and the stub engine must be able to produce
 * crops on boxes with no ffmpeg at all. Every JPEG encoder on npm we'd
 * otherwise pull in is BSD-licensed; this keeps the dependency list at
 * MIT/Apache only. Correctness is checked in the test suite by decoding the
 * output with ffmpeg and comparing pixels.
 */

// Zigzag scan order: ZIGZAG[k] = natural (row-major) index of the k-th coefficient.
const ZIGZAG = (() => {
  const out = [];
  for (let s = 0; s < 15; s++) {
    const cells = [];
    for (let r = 0; r < 8; r++) { const c = s - r; if (c >= 0 && c < 8) cells.push(r * 8 + c); }
    if (s % 2 === 0) cells.reverse();          // even diagonals run bottom-left -> top-right
    out.push(...cells);
  }
  return out;
})();

const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA_Q = (() => {
  const q = new Array(64).fill(99);
  const top = [[17, 18, 24, 47], [18, 21, 26, 66], [24, 26, 56], [47, 66]];
  top.forEach((row, r) => row.forEach((v, c) => { q[r * 8 + c] = v; }));
  return q;
})();

function ranges(list) {
  const out = [];
  for (const [a, b] of list) for (let v = a; v <= b; v++) out.push(v);
  return out;
}
const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: ranges([[0, 11]]) };
const DC_CHROMA = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: ranges([[0, 11]]) };
const AC_LUMA = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a,
    ...ranges([[0x25, 0x2a], [0x34, 0x3a], [0x43, 0x4a], [0x53, 0x5a], [0x63, 0x6a], [0x73, 0x7a],
      [0x83, 0x8a], [0x92, 0x9a], [0xa2, 0xaa], [0xb2, 0xba], [0xc2, 0xca], [0xd2, 0xda],
      [0xe1, 0xea], [0xf1, 0xfa]]),
  ],
};
const AC_CHROMA = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    ...ranges([[0x27, 0x2a], [0x35, 0x3a], [0x43, 0x4a], [0x53, 0x5a], [0x63, 0x6a], [0x73, 0x7a],
      [0x82, 0x8a], [0x92, 0x9a], [0xa2, 0xaa], [0xb2, 0xba], [0xc2, 0xca], [0xd2, 0xda],
      [0xe2, 0xea], [0xf2, 0xfa]]),
  ],
};

/** Canonical Huffman codes: symbol -> [code, length]. */
function buildCodes({ bits, vals }) {
  const codes = new Map();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) codes.set(vals[k++], [code++, len]);
    code <<= 1;
  }
  return codes;
}
const H = {
  dcY: buildCodes(DC_LUMA), acY: buildCodes(AC_LUMA),
  dcC: buildCodes(DC_CHROMA), acC: buildCodes(AC_CHROMA),
};

// cos table for the separable 8x8 forward DCT: COS[u*8+x] = C(u)/2 * cos((2x+1)u*pi/16)
const COS = (() => {
  const t = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x++) t[u * 8 + x] = 0.5 * cu * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return t;
})();

function scaledTable(std, quality) {
  const q = Math.min(100, Math.max(1, quality | 0));
  const s = q < 50 ? 5000 / q : 200 - q * 2;
  return std.map((v) => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  write(code, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      if (++this.n === 8) this._flushByte();
    }
  }
  _flushByte() {
    this.bytes.push(this.acc);
    if (this.acc === 0xff) this.bytes.push(0);   // byte stuffing
    this.acc = 0; this.n = 0;
  }
  finish() {                                     // pad with 1-bits
    if (this.n > 0) { while (this.n > 0) this.write(1, 1); }
    return this.bytes;
  }
}

function category(v) {
  let a = v < 0 ? -v : v, n = 0;
  while (a) { n++; a >>= 1; }
  return n;
}

const tmp = new Float64Array(64);
const coef = new Float64Array(64);

function fdct(block) {
  // rows then columns
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[u * 8 + x];
      tmp[y * 8 + u] = s;
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[v * 8 + y];
      coef[v * 8 + u] = s;
    }
  }
  return coef;
}

function encodeBlock(bw, block, qt, prevDc, dcCodes, acCodes) {
  const c = fdct(block);
  const q = new Int32Array(64);
  for (let k = 0; k < 64; k++) { const i = ZIGZAG[k]; q[k] = Math.round(c[i] / qt[i]); }
  const diff = q[0] - prevDc;
  const dcCat = category(diff);
  const [dcCode, dcLen] = dcCodes.get(dcCat);
  bw.write(dcCode, dcLen);
  if (dcCat) bw.write(diff < 0 ? diff + (1 << dcCat) - 1 : diff, dcCat);
  let run = 0;
  for (let k = 1; k < 64; k++) {
    const v = q[k];
    if (v === 0) { run++; continue; }
    while (run > 15) { const [zc, zl] = acCodes.get(0xf0); bw.write(zc, zl); run -= 16; }
    const cat = category(v);
    const [code, len] = acCodes.get((run << 4) | cat);
    bw.write(code, len);
    bw.write(v < 0 ? v + (1 << cat) - 1 : v, cat);
    run = 0;
  }
  if (run > 0) { const [ec, el] = acCodes.get(0x00); bw.write(ec, el); }
  return q[0];
}

/**
 * Encode packed RGB (width*height*3) to a baseline JPEG Buffer.
 * @param {{width:number,height:number,data:Uint8Array}} img
 * @param {number} [quality=85]
 */
function encodeJpeg({ width, height, data }, quality = 85) {
  if (!(width > 0 && height > 0) || data.length < width * height * 3) throw new Error('encodeJpeg: bad image');
  const qY = scaledTable(STD_LUMA_Q, quality);
  const qC = scaledTable(STD_CHROMA_Q, quality);
  const bw = new BitWriter();
  const by = new Float64Array(64), bcb = new Float64Array(64), bcr = new Float64Array(64);
  let dcY = 0, dcCb = 0, dcCr = 0;
  for (let y0 = 0; y0 < height; y0 += 8) {
    for (let x0 = 0; x0 < width; x0 += 8) {
      for (let r = 0; r < 8; r++) {
        const y = Math.min(height - 1, y0 + r);         // replicate edges into partial blocks
        for (let c = 0; c < 8; c++) {
          const x = Math.min(width - 1, x0 + c);
          const p = (y * width + x) * 3;
          const R = data[p], G = data[p + 1], B = data[p + 2];
          const i = r * 8 + c;
          by[i] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
          bcb[i] = -0.168736 * R - 0.331264 * G + 0.5 * B;
          bcr[i] = 0.5 * R - 0.418688 * G - 0.081312 * B;
        }
      }
      dcY = encodeBlock(bw, by, qY, dcY, H.dcY, H.acY);
      dcCb = encodeBlock(bw, bcb, qC, dcCb, H.dcC, H.acC);
      dcCr = encodeBlock(bw, bcr, qC, dcCr, H.dcC, H.acC);
    }
  }
  const scan = bw.finish();

  const out = [];
  const u16 = (v) => out.push((v >> 8) & 0xff, v & 0xff);
  out.push(0xff, 0xd8);                                         // SOI
  out.push(0xff, 0xe0); u16(16); out.push(0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0); u16(1); u16(1); out.push(0, 0); // APP0 JFIF
  for (const [id, t] of [[0, qY], [1, qC]]) {                   // DQT
    out.push(0xff, 0xdb); u16(67); out.push(id);
    for (let k = 0; k < 64; k++) out.push(t[ZIGZAG[k]]);
  }
  out.push(0xff, 0xc0); u16(17); out.push(8); u16(height); u16(width); out.push(3,  // SOF0
    1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1);
  for (const [cls, tbl] of [[0x00, DC_LUMA], [0x10, AC_LUMA], [0x01, DC_CHROMA], [0x11, AC_CHROMA]]) { // DHT
    out.push(0xff, 0xc4); u16(2 + 1 + 16 + tbl.vals.length); out.push(cls, ...tbl.bits, ...tbl.vals);
  }
  out.push(0xff, 0xda); u16(12); out.push(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0); // SOS
  const head = Buffer.from(out);
  return Buffer.concat([head, Buffer.from(scan), Buffer.from([0xff, 0xd9])]);
}

module.exports = { encodeJpeg, ZIGZAG };
