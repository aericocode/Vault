/**
 * Share privately: the personal details check and the cleaned copies
 * (lib/share/meta.js), on crafted JPEG and PNG files and on ffprobe answers.
 *
 * Covered: each category (location, device, names, titles, comments) and
 * each pattern (drive and user-folder paths, UNC, emails, coordinates) in
 * EXIF, XMP, IPTC, COM, PNG text chunks and ffprobe tags; fields that are
 * not personal (software, dates, technical facts) not flagged; malformed,
 * truncated and hostile files (loops, offsets out of range, huge counts,
 * zip bombs, oversized values, control and direction characters) never
 * throw and never flag more than they should; the JPEG and PNG cleaners
 * (structure still whole, orientation and ICC kept, GPS and text gone,
 * picture data byte for byte, the original untouched, never written through
 * a link); cleanCopy failing safe when the tool fails, writes nothing, or the
 * copy still shows something; and, when this machine has ffmpeg and
 * ffprobe, one real round trip (skipped cleanly otherwise).
 */

require('./helpers/no-real-lm');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const meta = require('../lib/share/meta');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-share-meta-'));
test.after(() => {
  meta._setForTest({ probe: null, ffmpeg: null });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let fileNo = 0;
function put(buf, ext = '.jpg') {
  const p = path.join(tmp, `f${++fileNo}${ext}`);
  fs.writeFileSync(p, buf);
  return p;
}
const labels = (r) => Object.fromEntries((r.findings || []).map(f => [f.label, f.value]));

/* ── Builders ──────────────────────────────────────────────────────────── */

// A real 16x16 baseline JPEG (ffmpeg, bitexact): SOI, JFIF, DQT, DHT, SOF0, SOS, data, EOI.
const { BASE_JPEG } = require('./helpers/share-meta-fixtures');

function seg(marker, payload) {
  const h = Buffer.alloc(4);
  h[0] = 0xff; h[1] = marker; h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
}

/** A JPEG: SOI, the given segments, then the rest of BASE_JPEG after its JFIF header. */
function jpegWith(segments, { tail = Buffer.alloc(0), afterScan = [] } = {}) {
  const rest = BASE_JPEG.subarray(2 + 18);   // after SOI and the 16-byte JFIF APP0
  const body = afterScan.length ? Buffer.concat([rest.subarray(0, rest.length - 2), ...afterScan, Buffer.from([0xff, 0xd9])]) : rest;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), BASE_JPEG.subarray(2, 20), ...segments, body, tail]);
}

/**
 * A little-endian TIFF block. Entries: { tag, type, value }: 2 ASCII string,
 * 3 SHORT number(s), 4 LONG, 5 RATIONAL [[n, d], ...], 7 / 1 Buffer.
 */
function tiff({ ifd0 = [], exif = [], gps = [] } = {}) {
  const enc = (e) => {
    if (e.type === 2) { const b = Buffer.from(`${e.value}\0`, 'utf8'); return b; }
    if (e.type === 3) { const a = [].concat(e.value); const b = Buffer.alloc(a.length * 2); a.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; }
    if (e.type === 4) { const a = [].concat(e.value); const b = Buffer.alloc(a.length * 4); a.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b; }
    if (e.type === 5) { const b = Buffer.alloc(e.value.length * 8); e.value.forEach(([n, d], i) => { b.writeUInt32LE(n, i * 8); b.writeUInt32LE(d, i * 8 + 4); }); return b; }
    return Buffer.from(e.value);
  };
  const count = (e, b) => (e.type === 3 ? b.length / 2 : e.type === 4 ? b.length / 4 : e.type === 5 ? b.length / 8 : b.length);
  const dirs = [{ name: 'ifd0', list: ifd0.slice() }];
  if (exif.length) dirs.push({ name: 'exif', list: exif.slice() });
  if (gps.length) dirs.push({ name: 'gps', list: gps.slice() });
  if (exif.length) dirs[0].list.push({ tag: 0x8769, type: 4, value: 0, ptr: 'exif' });
  if (gps.length) dirs[0].list.push({ tag: 0x8825, type: 4, value: 0, ptr: 'gps' });
  let off = 8;
  for (const d of dirs) { d.off = off; d.list.sort((a, b) => a.tag - b.tag); off += 2 + d.list.length * 12 + 4; }
  const data = [];
  let dataOff = off;
  const out = Buffer.alloc(off);
  out.write('II', 0, 'latin1'); out.writeUInt16LE(42, 2); out.writeUInt32LE(8, 4);
  for (const d of dirs) {
    out.writeUInt16LE(d.list.length, d.off);
    d.list.forEach((e, i) => {
      const at = d.off + 2 + i * 12;
      const b = e.ptr ? (() => { const x = Buffer.alloc(4); x.writeUInt32LE(dirs.find(z => z.name === e.ptr).off, 0); return x; })() : enc(e);
      out.writeUInt16LE(e.tag, at); out.writeUInt16LE(e.type, at + 2); out.writeUInt32LE(e.ptr ? 1 : count(e, b), at + 4);
      if (b.length <= 4) b.copy(out, at + 8);
      else { out.writeUInt32LE(dataOff, at + 8); data.push(b); dataOff += b.length + (b.length % 2); if (b.length % 2) data.push(Buffer.alloc(1)); }
    });
    out.writeUInt32LE(0, d.off + 2 + d.list.length * 12);
  }
  return Buffer.concat([out, ...data]);
}
const exifSeg = (t) => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), t]));
const xmpSeg = (xml) => seg(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(xml, 'utf8')]));
const comSeg = (text) => seg(0xfe, Buffer.from(text, 'utf8'));
function iptcSeg(records) {
  const ds = records.map(([d, v]) => { const b = Buffer.from(v, 'utf8'); const h = Buffer.from([0x1c, 2, d, b.length >> 8, b.length & 0xff]); return Buffer.concat([h, b]); });
  const iptc = Buffer.concat(ds);
  const res = Buffer.alloc(12);
  res.write('8BIM', 0, 'latin1'); res.writeUInt16BE(0x0404, 4); res[6] = 0; res[7] = 0; res.writeUInt32BE(iptc.length, 8);
  return seg(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), res, iptc, iptc.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]));
}
const ICC = Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), crypto.randomBytes(200)]);

const GPS = [
  { tag: 0x0000, type: 1, value: Buffer.from([2, 3, 0, 0]) },
  { tag: 0x0001, type: 2, value: 'N' },
  { tag: 0x0002, type: 5, value: [[52, 1], [22, 1], [12, 1]] },
  { tag: 0x0003, type: 2, value: 'E' },
  { tag: 0x0004, type: 5, value: [[4, 1], [53, 1], [24, 1]] },
];

/* PNG */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); data.copy(b, 8);
  b.writeUInt32BE(meta.crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
function png(extra = [], { after = [] } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(4, 0); ihdr.writeUInt32BE(4, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(4 * (1 + 4 * 3)); for (let i = 0; i < raw.length; i++) raw[i] = i % 13 === 0 ? 0 : (i * 37) & 0xff;
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', zlib.deflateSync(raw)), ...after, chunk('IEND', Buffer.alloc(0))]);
}
const tEXt = (k, v) => chunk('tEXt', Buffer.concat([Buffer.from(`${k}\0`, 'latin1'), Buffer.from(v, 'latin1')]));
const zTXt = (k, v) => chunk('zTXt', Buffer.concat([Buffer.from(`${k}\0\0`, 'latin1'), zlib.deflateSync(Buffer.from(v, 'latin1'))]));
const iTXt = (k, v, z = false) => chunk('iTXt', Buffer.concat([Buffer.from(`${k}\0`, 'latin1'), Buffer.from([z ? 1 : 0, 0]), Buffer.from('\0\0', 'latin1'), z ? zlib.deflateSync(Buffer.from(v, 'utf8')) : Buffer.from(v, 'utf8')]));
function pngChunks(buf) {
  const out = [];
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    out.push({ type, data, crcOk: buf.readUInt32BE(p + 8 + len) === meta.crc32(buf.subarray(p + 4, p + 8 + len)) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return { list: out, end: p };
}

/** The JPEG's segments up to SOS, and whether it ends at its EOI. */
function jpegSegments(buf) {
  const out = [];
  let p = 2;
  while (p < buf.length && buf[p] === 0xff) {
    const m = buf[p + 1]; const len = buf.readUInt16BE(p + 2);
    out.push({ m, payload: buf.subarray(p + 4, p + 2 + len) });
    if (m === 0xda) break;
    p += 2 + len;
  }
  return out;
}

/* ── JPEG: what counts ─────────────────────────────────────────────────── */

test('JPEG EXIF: location (with S/W), device, serials, maker notes, names, comments, titles', async () => {
  const t = tiff({
    ifd0: [
      { tag: 0x010f, type: 2, value: 'Canon' }, { tag: 0x0110, type: 2, value: 'Canon EOS R6' },
      { tag: 0x013b, type: 2, value: 'Sam Example' }, { tag: 0x8298, type: 2, value: 'Copyright Sam' },
      { tag: 0x010e, type: 2, value: 'Birthday at home' }, { tag: 0x010d, type: 2, value: 'Scan 12' },
      { tag: 0x013c, type: 2, value: 'SAMS-LAPTOP' }, { tag: 0x0131, type: 2, value: 'Adobe Photoshop 25.0 (Windows)' },
      { tag: 0x0112, type: 3, value: 6 },
    ],
    exif: [
      { tag: 0xa431, type: 2, value: '043201234567' }, { tag: 0xa435, type: 2, value: '99887766' },
      { tag: 0xa430, type: 2, value: 'Sam Owner' }, { tag: 0x927c, type: 7, value: Buffer.from('maker-blob-123') },
      { tag: 0x9286, type: 7, value: Buffer.concat([Buffer.from('ASCII\0\0\0', 'latin1'), Buffer.from('a user comment')]) },
      { tag: 0x9003, type: 2, value: '2024:05:01 10:00:00' }, { tag: 0x829a, type: 5, value: [[1, 250]] },
    ],
    gps: [GPS[0], { tag: 1, type: 2, value: 'S' }, GPS[2], { tag: 3, type: 2, value: 'W' }, GPS[4]],
  });
  const r = await meta.detect(put(jpegWith([exifSeg(t)])));
  assert.strictEqual(r.status, 'personal');
  assert.strictEqual(r.kind, 'jpeg');
  assert.strictEqual(r.orientation, 6);
  const f = labels(r);
  assert.strictEqual(f.Location, '-52.37, -4.89');
  assert.match(f.Device, /^Canon EOS R6, /);
  assert.match(f.Device, /serial 04\d*\.\.\./, 'a serial is shown cut short');
  assert.match(f.Device, /lens serial 99\d*\.\.\./);
  assert.ok(!f.Device.includes('043201234567') && !f.Device.includes('99887766'), 'never in full');
  assert.match(f.Device, /SAMS-LAPTOP/);
  assert.match(f.Device, /camera maker notes/);
  assert.match(f.Name, /Sam Example/);
  assert.match(f.Name, /Copyright Sam/);
  assert.match(f.Name, /Sam Owner/);
  assert.match(f.Comment, /Birthday at home/);
  assert.match(f.Comment, /a user comment/);
  assert.strictEqual(f.Title, 'Scan 12');
  assert.ok(!JSON.stringify(r).includes('Photoshop'), 'software is not personal');
  assert.ok(!JSON.stringify(r).includes('2024:05:01'), 'dates are not personal');
  for (const x of r.findings) assert.ok(x.value.length <= meta.LIMITS.group, 'each line short');
});

test('JPEG: a UNICODE user comment, XP fields, an empty GPS block with only its version is not a location', async () => {
  const uc = Buffer.concat([Buffer.from('UNICODE\0', 'latin1'), Buffer.from('hello from sam', 'utf16le')]);
  const t = tiff({
    ifd0: [{ tag: 0x9c9d, type: 1, value: Buffer.from('Sam XP\0', 'utf16le') }, { tag: 0x9c9b, type: 1, value: Buffer.from('XP Title\0', 'utf16le') }],
    exif: [{ tag: 0x9286, type: 7, value: uc }],
    gps: [GPS[0]],
  });
  const r = await meta.detect(put(jpegWith([exifSeg(t)])));
  const f = labels(r);
  assert.strictEqual(f.Name, 'Sam XP');
  assert.strictEqual(f.Title, 'XP Title');
  assert.strictEqual(f.Comment, 'hello from sam');
  assert.ok(!f.Location, 'a GPS version alone says nothing about where');
});

test('JPEG: nothing personal (software, dates, exposure, orientation, ICC, Adobe) is clean', async () => {
  const t = tiff({
    ifd0: [{ tag: 0x0131, type: 2, value: 'GIMP 2.10.36' }, { tag: 0x0132, type: 2, value: '2024:01:01 00:00:00' }, { tag: 0x0112, type: 3, value: 1 }],
    exif: [{ tag: 0x829a, type: 5, value: [[1, 60]] }, { tag: 0x8827, type: 3, value: 400 }, { tag: 0xa420, type: 2, value: 'ab12cd34ef' }],
  });
  const adobe = seg(0xee, Buffer.from('Adobe\x00\x64\x00\x00\x00\x00\x01', 'latin1'));
  const r = await meta.detect(put(jpegWith([exifSeg(t), seg(0xe2, ICC), adobe, comSeg('CREATOR: gd-jpeg v1.0 (using IJG JPEG v62), quality = 90')])));
  assert.deepStrictEqual(r, { status: 'clean', kind: 'jpeg', findings: [], orientation: 1 });
});

test('patterns count in ANY field: drive and user-folder paths, UNC, emails, coordinates; URLs do not', async () => {
  const cases = [
    ['C:\\Users\\sam\\Pictures\\export', 'Folder path'], ['D:/Photos/2024/raw', 'Folder path'],
    ['\\\\nas01\\photos\\sam', 'Folder path'], ['/Users/sam/Pictures', 'Folder path'], ['/home/sam/out', 'Folder path'],
    ['file:///C:/Users/sam/x.jpg', 'Folder path'], ['/storage/emulated/0/DCIM/Camera', 'Folder path'],
    ['made by sam.example@mail.test', 'Email'],
    ['+52.3700+004.8900+000.000/', 'Location'], ['at 52.37012, 4.89021 today', 'Location'], ['52°22\'12"N', 'Location'],
  ];
  for (const [value, label] of cases) {
    const t = tiff({ ifd0: [{ tag: 0x0131, type: 2, value }] });   // Software: not personal by itself
    const r = await meta.detect(put(jpegWith([exifSeg(t)])));
    assert.strictEqual(r.status, 'personal', value);
    assert.ok(labels(r)[label], `${value} -> ${label}: ${JSON.stringify(r.findings)}`);
  }
  for (const value of ['http://ns.adobe.com/xap/1.0/', 'https://example.com/home/sam/x', 'Lavf61.7.100', 'version 1.2345, 6.78', 'uuid:faf5bdd5-ba3d-11da-ad31', '12:30/14:00']) {
    const t = tiff({ ifd0: [{ tag: 0x0131, type: 2, value }] });
    const r = await meta.detect(put(jpegWith([exifSeg(t)])));
    assert.strictEqual(r.status, 'clean', `${value}: ${JSON.stringify(r.findings)}`);
  }
});

test('JPEG XMP (attributes, elements, rdf lists, entities, extended), IPTC, COM and Ducky', async () => {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" tiff:Make="Apple" tiff:Model="iPhone 15 Pro"
      exif:GPSLatitude="52,22.2N" exif:GPSLongitude="4,53.4E" xmlns:exif="http://ns.adobe.com/exif/1.0/">
      <dc:creator><rdf:Seq><rdf:li>Sam &amp; Alex</rdf:li></rdf:Seq></dc:creator>
      <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Our trip</rdf:li></rdf:Alt></dc:description>
      <xmpMM:DerivedFrom stRef:filePath="C:\\Users\\sam\\Desktop\\a.psd"/>
      <Iptc4xmpCore:CreatorContactInfo Iptc4xmpCore:CiEmailWork="sam@studio.test"/>
      <xmp:CreatorTool>Adobe Photoshop 25.0</xmp:CreatorTool>
    </rdf:Description></rdf:RDF></x:xmpmeta>`;
  const r = await meta.detect(put(jpegWith([xmpSeg(xml)])));
  const f = labels(r);
  assert.strictEqual(f.Location, '52.37, 4.89');
  assert.strictEqual(f.Device, 'Apple iPhone 15 Pro');
  assert.strictEqual(f.Name, 'Sam & Alex');
  assert.strictEqual(f.Comment, 'Our trip');
  assert.match(f['Folder path'], /^C:\\Users\\sam\\Desktop/);
  assert.strictEqual(f.Email, 'sam@studio.test');
  assert.ok(!JSON.stringify(r).includes('Photoshop'));

  const ip = await meta.detect(put(jpegWith([iptcSeg([[80, 'Sam Byline'], [90, 'Amsterdam'], [120, 'Caption here'], [25, 'keyword']])])));
  assert.deepStrictEqual(labels(ip), { Location: 'Amsterdam', Name: 'Sam Byline', Comment: 'Caption here' });

  const com = await meta.detect(put(jpegWith([comSeg('Holiday with Sam')])));
  assert.deepStrictEqual(labels(com), { Comment: 'Holiday with Sam' });

  const ducky = Buffer.concat([Buffer.from('Ducky', 'latin1'), Buffer.from([0, 1, 0, 4, 0, 0, 0, 80])]);
  const cr = Buffer.from('Sam Ducky', 'utf16le'); cr.swap16();
  const dh = Buffer.alloc(8); dh.writeUInt16BE(3, 0); dh.writeUInt16BE(4 + cr.length, 2); dh.writeUInt32BE(cr.length / 2, 4);
  const dk = await meta.detect(put(jpegWith([seg(0xec, Buffer.concat([ducky, dh, cr, Buffer.alloc(2)]))])));
  assert.deepStrictEqual(labels(dk), { Name: 'Sam Ducky' });

  // An unknown APPn: only what its text looks like.
  const app9 = await meta.detect(put(jpegWith([seg(0xe9, Buffer.from('\x00\x01garbage /home/sam/secret/file \x02', 'latin1'))])));
  assert.match(labels(app9)['Folder path'], /^\/home\/sam\/secret/);
});

test('hostile JPEGs: loops, offsets out of range, huge counts, truncation, garbage never throw', async () => {
  // An IFD whose next pointer is itself, and an EXIF pointer to itself.
  const loop = tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'Looped Name' }] });
  loop.writeUInt32LE(8, 8 + 2 + 12);   // next IFD = IFD0
  const r1 = await meta.detect(put(jpegWith([exifSeg(loop)])));
  assert.deepStrictEqual(labels(r1), { Name: 'Looped Name' });
  // An entry count far past the block.
  const big = Buffer.from(tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'x' }] }));
  big.writeUInt16LE(60000, 8);
  const r2 = await meta.detect(put(jpegWith([exifSeg(big)])));
  assert.strictEqual(r2.status, 'failed');
  // A value offset far out of range, and a GPS pointer out of range: GPS data still counts.
  const oob = Buffer.from(tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'a long artist name' }], gps: [GPS[1]] }));
  const r3 = await meta.detect(put(jpegWith([exifSeg(oob.subarray(0, 40))])));
  assert.notStrictEqual(r3.status, 'clean');
  // Not a TIFF at all inside "Exif".
  const r4 = await meta.detect(put(jpegWith([exifSeg(Buffer.from('nonsense!'))])));
  assert.strictEqual(r4.status, 'failed');
  // Truncated in the middle of a segment, and only a few bytes.
  const whole = jpegWith([exifSeg(tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'Sam' }] }))]);
  assert.strictEqual((await meta.detect(put(whole.subarray(0, 30)))).status, 'failed');
  assert.strictEqual((await meta.detect(put(Buffer.from([0xff, 0xd8, 0xff])))).status, 'failed');
  assert.strictEqual((await meta.detect(put(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(4000)])))).status, 'failed');
  // A segment length below 2.
  assert.strictEqual((await meta.detect(put(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0, 0, 0, 0])))).status, 'failed');
  // Thousands of tiny segments: stops at the limit, not clean.
  const many = Array.from({ length: meta.LIMITS.segments + 10 }, () => seg(0xe5, Buffer.from('ab')));
  assert.strictEqual((await meta.detect(put(jpegWith(many)))).status, 'failed');
  // A missing file and a folder.
  assert.strictEqual((await meta.detect(path.join(tmp, 'nope.jpg'))).status, 'failed');
  assert.strictEqual((await meta.detect(tmp)).status, 'failed');
});

/* ── Embedded thumbnails ──────────────────────────────────────────────── */

/**
 * The TIFF block t with a chain of thumbnail directories after IFD0 (IFD1,
 * IFD2...): each one { bytes, at, len } (at may be a function of { ifd, data },
 * the directory's own offset and where its bytes would go). tailNext: the
 * last directory's next pointer.
 */
function withThumbs(t, list, { tailNext = 0 } = {}) {
  const base = t.length + (t.length % 2);
  const SIZE = 2 + 2 * 12 + 4;
  const dirs = Buffer.alloc(list.length * SIZE);
  const datas = [];
  let dOff = base + list.length * SIZE;
  list.forEach((th, i) => {
    const o = i * SIZE;
    const bytes = th.bytes || Buffer.alloc(0);
    const at = typeof th.at === 'function' ? th.at({ ifd: base + o, data: dOff }) : th.at != null ? th.at : dOff;
    const len = th.len != null ? th.len : bytes.length;
    dirs.writeUInt16LE(2, o);
    dirs.writeUInt16LE(0x201, o + 2); dirs.writeUInt16LE(4, o + 4); dirs.writeUInt32LE(1, o + 6); dirs.writeUInt32LE(at >>> 0, o + 10);
    dirs.writeUInt16LE(0x202, o + 14); dirs.writeUInt16LE(4, o + 16); dirs.writeUInt32LE(1, o + 18); dirs.writeUInt32LE(len >>> 0, o + 22);
    dirs.writeUInt32LE(i + 1 < list.length ? base + (i + 1) * SIZE : tailNext >>> 0, o + 26);
    datas.push(bytes);
    dOff += bytes.length;
  });
  const out = Buffer.concat([t, Buffer.alloc(base - t.length), dirs, ...datas]);
  const i0 = out.readUInt32LE(4);
  out.writeUInt32LE(list.length ? base : tailNext >>> 0, i0 + 2 + out.readUInt16LE(i0) * 12);
  return out;
}
/** A JPEG whose EXIF holds only the given thumbnails. */
const thumbHolder = (list, ifd0 = []) => jpegWith([exifSeg(withThumbs(tiff({ ifd0 }), list))]);
// What a phone's thumbnail could carry: its own EXIF with GPS and a camera, and a comment.
const LEAKY_THUMB = jpegWith([exifSeg(tiff({ ifd0: [{ tag: 0x010f, type: 2, value: 'Thumbcam' }], gps: GPS })), comSeg('Thumb owner Alex Smith')]);
const HARMLESS = [{ tag: 0x0112, type: 3, value: 1 }, { tag: 0x0131, type: 2, value: 'Photo editor 2.1' }];
const LEAK = { Location: '52.37, 4.89', Device: 'Thumbcam', Comment: 'Thumb owner Alex Smith' };

test('EXIF thumbnail: what it carries (GPS, a camera, a comment) counts for the file, with or without the tools, wherever the EXIF sits', async () => {
  // The main picture's EXIF alone is harmless.
  assert.strictEqual((await meta.detect(put(jpegWith([exifSeg(tiff({ ifd0: HARMLESS }))])))).status, 'clean');
  const main = withThumbs(tiff({ ifd0: HARMLESS }), [{ bytes: LEAKY_THUMB }]);
  // Photoshop's thumbnail resource: a 28-byte header, then the JPEG.
  const psRes = (id, jpg) => {
    const h = Buffer.alloc(12); h.write('8BIM', 0, 'latin1'); h.writeUInt16BE(id, 4); h.writeUInt32BE(28 + jpg.length, 8);
    const body = Buffer.concat([Buffer.alloc(28), jpg]);
    return seg(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]));
  };
  const files = {
    'JPEG EXIF IFD1': put(jpegWith([exifSeg(main)])),
    'PNG eXIf': put(png([chunk('eXIf', main)]), '.png'),
    'JFXX': put(jpegWith([seg(0xe0, Buffer.concat([Buffer.from('JFXX\0', 'latin1'), Buffer.from([0x10]), LEAKY_THUMB]))])),
    'Photoshop 0x040c': put(jpegWith([psRes(0x040c, LEAKY_THUMB)])),
    'Photoshop 0x0409': put(jpegWith([psRes(0x0409, LEAKY_THUMB)])),
  };
  for (const [where, f] of Object.entries(files)) {
    for (const tools of [true, false]) {
      const r = await meta.detect(f, { tools });
      assert.strictEqual(r.status, 'personal', `${where}, tools ${tools}`);
      assert.deepStrictEqual(labels(r), LEAK, `${where}, tools ${tools}`);
    }
  }
  // JFXX thumbnails stored as pixels (not a JPEG) hold nothing to read.
  const jfxxRgb = put(jpegWith([seg(0xe0, Buffer.concat([Buffer.from('JFXX\0', 'latin1'), Buffer.from([0x13, 1, 1, 9, 9, 9])]))]));
  assert.strictEqual((await meta.detect(jfxxRgb)).status, 'clean');
});

test('EXIF thumbnail: once flagged the cleaned copy holds none of it and checks clean, with or without the tools', async () => {
  const main = withThumbs(tiff({ ifd0: HARMLESS }), [{ bytes: LEAKY_THUMB }]);
  const MISSING = { probe: path.join(tmp, 'gone', 'ffprobe.exe'), ffmpeg: path.join(tmp, 'gone', 'ffmpeg.exe') };
  for (const tools of [true, false]) {
    if (!tools) meta._setForTest(MISSING);
    try {
      for (const [src, ext] of [[put(jpegWith([exifSeg(main)])), '.jpg'], [put(png([chunk('eXIf', main)]), '.png'), '.png'], [put(thumbHolder([{ bytes: LEAKY_THUMB }], [{ tag: 0x0112, type: 3, value: 6 }])), '.jpg']]) {
        const known = await meta.detect(src, { tools });
        assert.strictEqual(known.status, 'personal');
        const dst = path.join(stageDir(), `out${ext}`);
        await meta.cleanCopy({ src, dst, known });
        const out = fs.readFileSync(dst);
        for (const s of ['Alex', 'Thumbcam', 'Photo editor']) assert.ok(!out.includes(Buffer.from(s)), `${s} gone (${ext}, tools ${tools})`);
        for (const t of [true, false]) assert.strictEqual((await meta.detect(dst, { tools: t })).status, 'clean', `${ext}, tools ${tools}/${t}`);
      }
    } finally {
      meta._setForTest({ probe: null, ffmpeg: null });
    }
  }
});

test('EXIF thumbnail, hostile: pointers out of range, absurd lengths, overlaps, junk, loops never throw and never hide what is readable', async () => {
  const at = async (list, opts) => meta.detect(put(thumbHolder(list), opts));
  // Out of the block, or at 0: nothing there to read; the file is not broken.
  for (const p of [0, 1, 7, 0xfffffff0, 0x7fffffff]) {
    assert.strictEqual((await at([{ bytes: LEAKY_THUMB, at: p }])).status, 'clean', `at ${p}`);
  }
  // A length past the end of the block, or absurd: cut to the end, what is there still counts.
  for (const len of [LEAKY_THUMB.length + 5000, 0xffffffff, 0x7fffffff]) {
    assert.deepStrictEqual(labels(await at([{ bytes: LEAKY_THUMB, len }])), LEAK, `len ${len}`);
  }
  // A length of 0: no thumbnail.
  assert.strictEqual((await at([{ bytes: LEAKY_THUMB, len: 0 }])).status, 'clean');
  // Pointing at its own directory, or at the TIFF header: not a JPEG, passed over.
  assert.strictEqual((await at([{ bytes: LEAKY_THUMB, at: ({ ifd }) => ifd }])).status, 'clean');
  assert.strictEqual((await at([{ bytes: LEAKY_THUMB, at: 8 }])).status, 'clean');
  // Random bytes, and a JPEG start followed by garbage: passed over, never failed.
  assert.strictEqual((await at([{ bytes: crypto.randomBytes(500) }])).status, 'clean');
  assert.notStrictEqual((await at([{ bytes: Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(500)]) }])).status, 'failed');
  assert.strictEqual((await at([{ bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]) }])).status, 'clean');
  // Cut short inside its EXIF: what came before (the comment) still counts, the file is not broken.
  const cutFirst = jpegWith([comSeg('Thumb owner Alex Smith'), exifSeg(tiff({ gps: GPS }))]);
  const r = await at([{ bytes: cutFirst, len: cutFirst.indexOf(Buffer.from('Exif')) + 20 }]);
  assert.strictEqual(r.status, 'personal');
  assert.strictEqual(labels(r).Comment, 'Thumb owner Alex Smith');
  // Two directories sharing one thumbnail (overlap): read, no duplicate line.
  const two = thumbHolder([{ bytes: LEAKY_THUMB }, { at: ({ ifd }) => ifd + 30, len: LEAKY_THUMB.length }]);
  const two2 = await meta.detect(put(two));
  assert.deepStrictEqual(labels(two2), LEAK);
  // The directory chain past IFD1: junk in its last next pointer is not a broken file; a loop ends.
  assert.strictEqual((await meta.detect(put(jpegWith([exifSeg(withThumbs(tiff({ ifd0: HARMLESS }), [{ bytes: BASE_JPEG }, { bytes: BASE_JPEG }], { tailNext: 0xfffffff0 }))])))).status, 'clean');
  const loop = withThumbs(tiff({ ifd0: HARMLESS }), [{ bytes: BASE_JPEG }], { tailNext: 8 });
  assert.strictEqual((await meta.detect(put(jpegWith([exifSeg(loop)])))).status, 'clean');
  // A thumbnail in IFD2 (past the thumbnail's own directory) is read too.
  assert.deepStrictEqual(labels(await at([{ bytes: BASE_JPEG }, { bytes: LEAKY_THUMB }])), LEAK);
});

test('EXIF thumbnail, nested and many: a thumbnail\'s thumbnail is read; deeper, or more than the limit, the check failed (never clean)', async () => {
  const nest = (inner) => thumbHolder([{ bytes: inner }]);
  // main > A > B: what B carries counts.
  const ab = nest(nest(LEAKY_THUMB));
  assert.deepStrictEqual(labels(await meta.detect(put(ab))), LEAK);
  // main > A > B > C: one level too deep, even a plain C.
  assert.strictEqual((await meta.detect(put(nest(nest(nest(BASE_JPEG)))))).status, 'failed');
  assert.strictEqual((await meta.detect(put(nest(nest(nest(LEAKY_THUMB)))))).status, 'failed');
  // Six deep: bounded, never walked to the bottom.
  const deep = (n) => (n === 0 ? BASE_JPEG : nest(deep(n - 1)));
  assert.strictEqual((await meta.detect(put(deep(6)))).status, 'failed');
  // Up to LIMITS.thumbs thumbnails per file are read; one more and the check failed.
  const k = meta.LIMITS.thumbs;
  const many = (n) => put(thumbHolder(Array.from({ length: n }, () => ({ bytes: BASE_JPEG }))));
  assert.strictEqual((await meta.detect(many(k))).status, 'clean');
  assert.strictEqual((await meta.detect(many(k + 1))).status, 'failed');
  // The last of the k carries the details: found.
  const lastLeaks = thumbHolder(Array.from({ length: k }, (_, i) => ({ bytes: i === k - 1 ? LEAKY_THUMB : BASE_JPEG })));
  assert.deepStrictEqual(labels(await meta.detect(put(lastLeaks))), LEAK);
});

test('EXIF thumbnail: a normal camera JPEG whose thumbnail carries nothing new gives the same findings as before, no line twice', async () => {
  const camera = [
    { tag: 0x010f, type: 2, value: 'Canon' }, { tag: 0x0110, type: 2, value: 'Canon EOS R6' }, { tag: 0x0112, type: 3, value: 1 },
    { tag: 0x013b, type: 2, value: 'Sam Example' },
  ];
  const exif = [{ tag: 0xa431, type: 2, value: '0432999' }];
  const plain = tiff({ ifd0: camera, exif, gps: GPS });
  const before = await meta.detect(put(jpegWith([exifSeg(plain), comSeg('Holiday')])));
  assert.strictEqual(before.status, 'personal');
  // A plain thumbnail (what cameras write), and one with the very same EXIF and comment.
  const same = jpegWith([exifSeg(tiff({ ifd0: camera, exif, gps: GPS })), comSeg('Holiday')]);
  for (const thumb of [BASE_JPEG, same]) {
    const r = await meta.detect(put(jpegWith([exifSeg(withThumbs(plain, [{ bytes: thumb }])), comSeg('Holiday')])));
    assert.deepStrictEqual(r.findings, before.findings);
  }
  // A thumbnail with another place: the main picture's place is the one shown; still one Location line.
  const elsewhere = jpegWith([exifSeg(tiff({ gps: [GPS[0], GPS[1], { tag: 2, type: 5, value: [[10, 1], [0, 1], [0, 1]] }, GPS[3], { tag: 4, type: 5, value: [[20, 1], [0, 1], [0, 1]] }] }))]);
  const r = await meta.detect(put(jpegWith([exifSeg(withThumbs(plain, [{ bytes: elsewhere }]))])));
  assert.strictEqual(r.findings.filter(f => f.label === 'Location').length, 1);
  assert.strictEqual(labels(r).Location, labels(before).Location);
});

test('values: oversized ones are cut short, control and direction characters removed', async () => {
  const huge = `${'A'.repeat(50000)}`;
  const sneaky = 'Sam\u202eevil\u0000\u0007\u200b<b>x</b>\r\nnext';
  const t = tiff({ ifd0: [{ tag: 0x013b, type: 2, value: huge }, { tag: 0x8298, type: 2, value: sneaky }] });
  const r = await meta.detect(put(jpegWith([exifSeg(t)])));
  const name = labels(r).Name;
  assert.ok(name.length <= meta.LIMITS.group, name.length);
  assert.ok(!/[\u0000-\u001f\u202e\u200b]/.test(name), 'no control or direction characters');
  assert.ok(r.findings.every(f => !/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(f.value)));
  assert.strictEqual(meta.tidy('a\u2066b\u0085c\ufeffd'), 'a b c d');
  assert.strictEqual(meta.shorten('😀😀😀😀😀😀', 5), '😀😀...', 'never half a character');
});

/* ── PNG ───────────────────────────────────────────────────────────────── */

test('PNG text chunks, eXIf, XMP and ImageMagick raw profiles count; software and dates do not', async () => {
  const ex = tiff({ ifd0: [{ tag: 0x0112, type: 3, value: 3 }, { tag: 0x0110, type: 2, value: 'Pixel 8' }], gps: GPS });
  const rawExif = `\nexif\n    ${ex.length + 6}\n${Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), ex]).toString('hex').replace(/(.{72})/g, '$1\n')}\n`;
  const cases = [
    [[tEXt('Author', 'Sam Example')], { Name: 'Sam Example' }],
    [[zTXt('Comment', 'shot at home')], { Comment: 'shot at home' }],
    [[iTXt('Title', 'Holiday', true)], { Title: 'Holiday' }],
    [[iTXt('XML:com.adobe.xmp', '<x:xmpmeta><rdf:Description dc:creator="Sam XMP"/></x:xmpmeta>'.replace('dc:creator="Sam XMP"', '><dc:creator>Sam XMP</dc:creator><'))], { Name: 'Sam XMP' }],
    [[chunk('eXIf', ex)], { Location: '52.37, 4.89', Device: 'Pixel 8' }],
    [[zTXt('Raw profile type exif', rawExif)], { Location: '52.37, 4.89', Device: 'Pixel 8' }],
    [[tEXt('parameters', 'a prompt someone typed')], { Comment: 'a prompt someone typed' }],
    [[tEXt('Software', 'C:\\Users\\sam\\tools\\paint.exe')], { 'Folder path': 'C:\\Users\\sam\\tools\\paint.exe' }],
  ];
  for (const [extra, want] of cases) {
    const r = await meta.detect(put(png(extra), '.png'));
    assert.strictEqual(r.kind, 'png');
    assert.deepStrictEqual(labels(r), want, JSON.stringify(r.findings));
  }
  const clean = await meta.detect(put(png([tEXt('Software', 'GIMP 2.10'), tEXt('Creation Time', '2024-01-01'), tEXt('date:create', '2024-01-01T00:00:00'), chunk('sRGB', Buffer.from([0]))]), '.png'));
  assert.deepStrictEqual(clean, { status: 'clean', kind: 'png', findings: [], orientation: null });
});

test('hostile PNGs: a zip bomb, a length past the end, no IEND, thousands of chunks never throw', async () => {
  const bomb = chunk('zTXt', Buffer.concat([Buffer.from('Comment\0\0', 'latin1'), zlib.deflateSync(Buffer.alloc(50 * 1024 * 1024, 0x41))]));
  assert.strictEqual((await meta.detect(put(png([bomb]), '.png'))).status, 'failed', 'not unpacked past the limit');
  const bad = png([tEXt('Author', 'x')]);
  bad.writeUInt32BE(0x7ffffff0, 8 + 25);   // the tEXt length
  assert.strictEqual((await meta.detect(put(bad, '.png'))).status, 'failed');
  const noEnd = png().subarray(0, png().length - 12);
  assert.strictEqual((await meta.detect(put(noEnd, '.png'))).status, 'failed');
  const weird = png([chunk('tEXt', Buffer.from('no separator here', 'latin1'))]);
  assert.notStrictEqual((await meta.detect(put(weird, '.png'))).status, 'clean');
});

/* ── ffprobe answers ───────────────────────────────────────────────────── */

test('ffprobe tags: location, device, names, titles, comments, chapters, GPS tracks; technical tags are not personal', () => {
  const found = new meta.Found();
  const r = meta._fromProbe({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: {
      major_brand: 'isom', encoder: 'Lavf61.7.100', creation_time: '2024-05-01T10:00:00Z',
      'com.apple.quicktime.location.ISO6709': '+52.3700+004.8900+000.000/', 'com.apple.quicktime.make': 'Apple',
      'com.apple.quicktime.model': 'iPhone 15 Pro', artist: 'Sam Example', title: 'My holiday', comment: 'raw cut',
      encoded_by: 'LAME 3.100', genre: 'Home video',
    } },
    streams: [
      { codec_type: 'video', tags: { handler_name: 'VideoHandler', language: 'und', encoder: 'Lavc libx264' } },
      { codec_type: 'audio', tags: { title: 'English' } },
      { codec_type: 'subtitle', tags: { title: 'notes in /home/sam/subs' } },
      { codec_type: 'data', codec_tag_string: 'gpmd', tags: { handler_name: 'GoPro MET' } },
    ],
    chapters: [{ tags: { title: 'Chapter 1' } }, { tags: { title: '00:05:00.000' } }, { tags: { title: 'Arrival at the house' } }],
  }, found);
  assert.deepStrictEqual(r.counts, { v: 1, a: 1, s: 1, t: 0, pics: 0 });
  assert.strictEqual(r.image, false);
  const f = Object.fromEntries(found.findings().map(x => [x.label, x.value]));
  assert.match(f.Location, /^52\.37, 4\.89/);
  assert.match(f.Location, /GPS track/);
  assert.strictEqual(f.Device, 'Apple iPhone 15 Pro');
  assert.strictEqual(f.Name, 'Sam Example');
  assert.strictEqual(f.Title, 'My holiday, Arrival at the house');
  assert.strictEqual(f.Comment, 'raw cut');
  assert.match(f['Folder path'], /^\/home\/sam\/subs/);
  const all = JSON.stringify(found.findings());
  for (const no of ['Lavf', 'LAME', 'English', 'Chapter 1', 'Home video', 'VideoHandler', '2024-05-01']) assert.ok(!all.includes(no), no);

  const plain = new meta.Found();
  meta._fromProbe({ format: { format_name: 'matroska,webm', tags: { ENCODER: 'Lavf', encoded_by: 'Sam' } }, streams: [{ codec_type: 'video', tags: { DURATION: '00:00:01' } }] }, plain);
  assert.deepStrictEqual(plain.findings(), [{ label: 'Name', value: 'Sam' }], '"by" fields are names unless they are a program');

  const img = new meta.Found();
  assert.strictEqual(meta._fromProbe({ format: { format_name: 'webp_pipe' }, streams: [{ codec_type: 'video' }] }, img).image, true);
  assert.strictEqual(meta._fromProbe({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'heic' } }, streams: [] }, img).image, true);
});

test('hostile ffprobe answers: thousands of tags, odd types, huge values, never throws', () => {
  const tags = {};
  for (let i = 0; i < 5000; i++) tags[`k${i}`] = 'v';
  tags.artist = 'Sam';
  const f = new meta.Found();
  meta._fromProbe({ format: { tags }, streams: 'nope', chapters: [null, 5, { tags: null }] }, f);
  assert.strictEqual(f.over, true, 'stops at the limit');
  const g = new meta.Found();
  meta._fromProbe({ format: { tags: { artist: 'x'.repeat(1e6), comment: 12345, title: null, location: ['a'] } }, streams: [{ tags: [] }] }, g);
  for (const x of g.findings()) assert.ok(x.value.length <= meta.LIMITS.group);
  meta._fromProbe({}, new meta.Found());
});

/* ── ffmpeg's signature in a comment ───────────────────────────────────── */

// A comment that is ONLY ffmpeg's "Lavc"/"Lavf" and a version is not personal;
// that signature next to anything else is still a comment.
const ENCODER_ONLY = ['Lavc62.23.103\0', 'Lavc62.23.103', 'Lavf61.7.100', '  Lavc58.134.100 \r\n', '\0Lavf62.10.101\0\0', 'lavc62.23.103', 'Lavc62.23'];
const ENCODER_PLUS = [
  // A version always has a dot: a bare "Lavc60" is nothing ffmpeg writes.
  ['Lavc60', /Lavc60/],
  ['Lavc6', /Lavc6/],
  ['Lavc62.23.103 C:\\Users\\alex\\Pictures', /C:\\Users\\alex/],
  ['Lavc62.23.103\nC:\\Users\\alex\\Pictures', /C:\\Users\\alex/],
  ['shot by Alex, Lavc60', /shot by Alex/],
  ['Lavc62.23.103 shot by Alex', /shot by Alex/],
  ['Lavf61.7.100\r\nAlex', /Alex/],
  ['Lavc6 by Sam', /by Sam/],
  ['Lavc62.23.103.4.5', /Lavc62/],
  // Text far past the signature, beyond what one value shows, is not cut off unseen.
  [`Lavc62.23.103${' '.repeat(5000)}Alex`, /Lavc62/],
  [`Lavc62.23.103${'\0'.repeat(5000)}Alex`, /Lavc62/],
  ['Holiday with Sam', /^Holiday with Sam$/],
];

test('ffmpeg signature: a JPEG COM that is only "Lavc62.23.103" (what ffmpeg writes) is clean; with anything else it is still a comment', async () => {
  for (const value of ENCODER_ONLY) {
    const r = await meta.detect(put(jpegWith([comSeg(value)])));
    assert.deepStrictEqual(r, { status: 'clean', kind: 'jpeg', findings: [], orientation: null }, JSON.stringify(value));
  }
  for (const [value, want] of ENCODER_PLUS) {
    const r = await meta.detect(put(jpegWith([comSeg(value)])));
    assert.strictEqual(r.status, 'personal', JSON.stringify(value));
    assert.match(labels(r).Comment || '', want, `${JSON.stringify(value)}: ${JSON.stringify(r.findings)}`);
  }
  // Between progressive scans too, and next to another COM that is a comment.
  const mixed = await meta.detect(put(jpegWith([comSeg('Lavc62.23.103\0'), comSeg('Holiday with Sam')], { afterScan: [comSeg('Lavc62.23.103\0')] })));
  assert.deepStrictEqual(labels(mixed), { Comment: 'Holiday with Sam' });
});

test('ffmpeg signature: the same in a PNG Comment chunk; ffprobe comment tags are always a comment, signature or not', async () => {
  for (const value of ENCODER_ONLY) {
    const r = await meta.detect(put(png([tEXt('Comment', value)]), '.png'));
    assert.deepStrictEqual(r, { status: 'clean', kind: 'png', findings: [], orientation: null }, JSON.stringify(value));
    // ffprobe cuts a tag value at its first NUL ("Lavc6\0a@b.com" reads as
    // "Lavc6"), so a value it shows is never trusted to be the whole tag:
    // even a bare signature in a comment tag is flagged, and cleaned away.
    for (const tags of [{ COMMENT: value }, { 'comment-eng': value }, { DESCRIPTION: value }]) {
      const f = new meta.Found();
      meta._fromProbe({ format: { format_name: 'matroska,webm', tags }, streams: [] }, f);
      assert.strictEqual(f.personal(), true, `${JSON.stringify(tags)}`);
      assert.ok(Object.fromEntries(f.findings().map(x => [x.label, x.value])).Comment, JSON.stringify(tags));
    }
    const s = new meta.Found();
    meta._fromProbe({ format: { format_name: 'mp3' }, streams: [{ codec_type: 'audio', tags: { comment: value } }] }, s);
    assert.strictEqual(s.personal(), true, `stream comment ${JSON.stringify(value)}`);
  }
  // "encoded by" keeps its own rule: a versioned program is not a name, a bare "Lavc60" still is.
  const eb = new meta.Found();
  meta._fromProbe({ format: { format_name: 'mp3', tags: { encoded_by: 'Lavf61.7.100' } }, streams: [] }, eb);
  assert.deepStrictEqual(eb.findings(), []);
  const eb2 = new meta.Found();
  meta._fromProbe({ format: { format_name: 'mp3', tags: { encoded_by: 'Lavc60' } }, streams: [] }, eb2);
  assert.deepStrictEqual(eb2.findings(), [{ label: 'Name', value: 'Lavc60' }]);
  for (const [value, want] of ENCODER_PLUS) {
    const r = await meta.detect(put(png([iTXt('Comment', value)]), '.png'));
    assert.match(labels(r).Comment || '', want, `${JSON.stringify(value)}: ${JSON.stringify(r.findings)}`);
    const f = new meta.Found();
    meta._fromProbe({ format: { format_name: 'mp3', tags: { comment: value } }, streams: [] }, f);
    assert.match(Object.fromEntries(f.findings().map(x => [x.label, x.value])).Comment || '', want, JSON.stringify(value));
  }
  // A tag comment that only STARTS with a program's name is still a comment.
  const g = new meta.Found();
  meta._fromProbe({ format: { format_name: 'mp3', tags: { comment: 'Photoshop edit of our trip' } }, streams: [] }, g);
  assert.deepStrictEqual(g.findings(), [{ label: 'Comment', value: 'Photoshop edit of our trip' }]);
});

test('ffmpeg signature: a JPEG flagged for something else is still cleaned, signature COM and all', async () => {
  const src = put(jpegWith([exifSeg(tiff({ gps: GPS })), comSeg('Lavc62.23.103\0')]));
  const known = await meta.detect(src);
  assert.strictEqual(known.status, 'personal');
  assert.deepStrictEqual(Object.keys(labels(known)), ['Location'], 'the signature is not a finding');
  const dst = path.join(stageDir(), 'frame.jpg');
  await meta.cleanCopy({ src, dst, known });
  const out = fs.readFileSync(dst);
  assert.ok(!jpegSegments(out).some(s => s.m === 0xfe), 'no COM in the copy');
  assert.ok(!out.includes(Buffer.from('Lavc')));
  assert.strictEqual((await meta.detect(dst)).status, 'clean');
});

/* ── Software signatures: the whole value, or it is what the field says ── */

// What these programs really write into a JPEG COM, a PNG Comment or "encoded by".
const SOFTWARE_ONLY = [
  'CREATOR: gd-jpeg v1.0 (using IJG JPEG v62), quality = 90\n', 'CREATOR: gd-jpeg v1.0 (using IJG JPEG v80), default quality\n',
  'Created with GIMP', 'Created with The GIMP', 'Created with GIMP on a Mac', 'LEAD Technologies Inc. V1.01',
  'Handmade Software, Inc. Image Alchemy v1.11', 'Optimized by JPEGmini 3.13.3.15 0x0f7cbd26',
  'Intel(R) JPEG Library, version 1,5,4,36', 'Intel(R) JPEG Library, version [1.51.12.44]', 'AppleMark\n',
  'Compressed by jpeg-recompress', 'ACD Systems Digital Imaging', 'File written by Adobe Photoshop\u00a8 4.0',
  'File written by Adobe Photoshop\ufffd 5.0', 'Adobe Photoshop CC 2019 (Windows)', 'Adobe Photoshop 25.0 (Macintosh)',
  'Adobe ImageReady', 'Adobe Photoshop Lightroom Classic 12.4 (Windows)',
  'LAME3.100', 'LAME3.99r', 'LAME3.90.', 'LAME3.101 ', 'LAME 3.100', 'LAME 3.99.5', 'LAME 64bits version 3.100 (http://lame.sf.net)', 'LAME',
  'iTunes v7.6.2', 'iTunes 12.9.5.5', 'HandBrake 1.6.1 2023012300', 'mkvmerge v81.0 64-bit', 'libebml v1.4.5 + libmatroska v1.7.1',
  'Exact Audio Copy (Secure mode)', 'Exact Audio Copy   (Secure mode)', 'Exact Audio Copy V1.6', 'Nero AAC codec 1.5.4.0',
  'dBpoweramp Release 17.2', 'x264 - core 164 r3095 baee400', 'x265', 'ImageMagick 7.1.1-21', 'GraphicsMagick 1.3.42',
  'foobar2000 v1.6.16', 'fre:ac v1.1.7', 'Paint.NET v3.36', 'paint.net 4.3.12', 'Winamp 5.666', 'Audacity 3.4.2',
  'MediaMonkey 5.0.4', 'Mp3tag v3.21', 'Picasa', 'IrfanView', 'XnView', 'Exiv2 0.27.5', 'FFmpeg', 'Lavf61.7.100',
];
// A program's name with anything else: flagged (padding past what one value
// shows, a NUL or a line break before the rest included).
const SOFTWARE_PLUS = [
  'Photoshop edit of our trip with Alex', 'Adobe Photoshop by Sam', 'Adobe Photoshop CC 2019 (Windows) Sam\'s edit',
  'Created with GIMP by Alex', 'Created with GIMP\nAlex', 'Created with GIMP\0Alex', 'Created with GIMP\r\n\r\nC:\\Users\\alex\\x.xcf',
  `Created with GIMP${' '.repeat(5000)}Alex`, `LAME3.100${'\0'.repeat(5000)}Alex`, `CREATOR: gd-jpeg v1.0 (using IJG JPEG v62), quality = 90\n${' '.repeat(200)}Sam`,
  'LAME 3.100 Alex', 'LAME3.100 ripped by Sam', 'iTunes v7.6.2 ripped by Sam', 'Exact Audio Copy (Secure mode) by Sam',
  'x264 holiday edit', 'x264 - core 164 r3095 baee400 Sam', 'Winamp 5.666 C:\\Users\\x', 'Nero Alex', 'HandBrake Sam',
  'mkvmerge v81.0 (\'Alex Smith\') 64-bit', 'AppleMark Sam', 'Picasa album of Sam',
];

test('software signatures: what programs really write is clean in a JPEG COM, a PNG Comment and "encoded by"', async () => {
  for (const value of SOFTWARE_ONLY) {
    const j = await meta.detect(put(jpegWith([comSeg(value)])));
    assert.deepStrictEqual(j.findings, [], `COM ${JSON.stringify(value)}`);
    assert.strictEqual(j.status, 'clean', `COM ${JSON.stringify(value)}`);
    const p = await meta.detect(put(png([iTXt('Comment', value)]), '.png'));
    assert.strictEqual(p.status, 'clean', `PNG ${JSON.stringify(value)}: ${JSON.stringify(p.findings)}`);
    const f = new meta.Found();
    meta._fromProbe({ format: { format_name: 'mp3', tags: { encoded_by: value } }, streams: [] }, f);
    assert.strictEqual(f.personal(), false, `encoded_by ${JSON.stringify(value)}: ${JSON.stringify(f.findings())}`);
  }
});

test('software signatures: a program name with anything else is flagged; padding and line tricks too', async () => {
  for (const value of SOFTWARE_PLUS) {
    const j = await meta.detect(put(jpegWith([comSeg(value)])));
    assert.strictEqual(j.status, 'personal', `COM ${JSON.stringify(value.slice(0, 80))}`);
    assert.ok(labels(j).Comment, `COM ${JSON.stringify(value.slice(0, 80))}: ${JSON.stringify(j.findings)}`);
    const p = await meta.detect(put(png([iTXt('Comment', value)]), '.png'));
    assert.ok(labels(p).Comment, `PNG ${JSON.stringify(value.slice(0, 80))}: ${JSON.stringify(p.findings)}`);
    const f = new meta.Found();
    meta._fromProbe({ format: { format_name: 'mp3', tags: { encoded_by: value } }, streams: [] }, f);
    assert.ok(Object.fromEntries(f.findings().map(x => [x.label, x.value])).Name, `encoded_by ${JSON.stringify(value.slice(0, 80))}`);
  }
});

test('ffmpeg\'s CS=ITU601 marker: clean as a whole JPEG COM or PNG Comment only; never through ffprobe', async () => {
  for (const value of ['CS=ITU601\0', 'CS=ITU601']) {
    assert.strictEqual((await meta.detect(put(jpegWith([comSeg('Lavc62.23.103\0'), comSeg(value)])))).status, 'clean', JSON.stringify(value));
    assert.strictEqual((await meta.detect(put(png([tEXt('Comment', value)]), '.png'))).status, 'clean', JSON.stringify(value));
  }
  for (const value of ['cs=itu601', 'CS=ITU601 Sam', 'CS=ITU601\nAlex', 'CS=ITU709', 'CS=ITU601,Alex', `CS=ITU601${'\0'.repeat(5000)}Sam`]) {
    const r = await meta.detect(put(jpegWith([comSeg(value)])));
    assert.ok(labels(r).Comment, JSON.stringify(value.slice(0, 40)));
  }
  // ffprobe-read values never get it: they may be cut at a NUL.
  for (const [key, label] of [['comment', 'Comment'], ['encoded_by', 'Name']]) {
    const f = new meta.Found();
    meta._fromProbe({ format: { format_name: 'mp3', tags: { [key]: 'CS=ITU601' } }, streams: [] }, f);
    assert.deepStrictEqual(f.findings(), [{ label, value: 'CS=ITU601' }], key);
  }
});

test('"encoded by" through ffprobe: a person unless the whole value is a known program; nothing flagged before comes out clean', () => {
  const probe = (encoded_by) => {
    const f = new meta.Found();
    meta._fromProbe({ format: { format_name: 'mp3', tags: { encoded_by } }, streams: [] }, f);
    return Object.fromEntries(f.findings().map(x => [x.label, x.value]));
  };
  // A version number no longer makes a value a program.
  for (const v of ['Alex Smith v1.2', 'Alex 2.0', 'ripped by Sam 1.0', 'SomeTool 2.1', 'Sam']) assert.strictEqual(probe(v).Name, v, v);
  // Flagged before this rule and still flagged: no word-boundary loosening on
  // values ffprobe may have cut short.
  for (const v of ['Lavc60', 'Lavf61', 'LAME3', 'XLD 20230627', 'CS=ITU601']) assert.strictEqual(probe(v).Name, v, v);
  // Encoder-style tags are never names, whatever they hold (only scanned).
  const f = new meta.Found();
  meta._fromProbe({ format: { format_name: 'mp3', tags: { encoder: 'Alex Smith v1.2', encoding_tool: 'SomeTool 2.1' } }, streams: [] }, f);
  assert.deepStrictEqual(f.findings(), []);
});

/* ── Cleaners ──────────────────────────────────────────────────────────── */

function stageDir() {
  const d = path.join(tmp, `stage-${++fileNo}`);
  fs.mkdirSync(d);
  return d;
}

test('JPEG cleaner: APPn and COM gone (between scans and after the end too), ICC and orientation kept, picture data byte for byte, original untouched', async () => {
  const t = tiff({
    ifd0: [{ tag: 0x010f, type: 2, value: 'Canon' }, { tag: 0x0110, type: 2, value: 'EOS R6' }, { tag: 0x0112, type: 3, value: 6 }],
    exif: [{ tag: 0xa431, type: 2, value: '0432999' }, { tag: 0x927c, type: 7, value: Buffer.from('maker') }],
    gps: GPS,
  });
  const adobe = seg(0xee, Buffer.from('Adobe\x00\x64\x00\x00\x00\x00\x01', 'latin1'));
  const src = put(jpegWith([exifSeg(t), xmpSeg('<x><dc:creator>Sam</dc:creator></x>'), seg(0xe2, ICC), adobe,
    iptcSeg([[80, 'Sam']]), comSeg('Holiday with Sam')], { afterScan: [comSeg('between scans: Sam'), seg(0xe7, Buffer.from('C:\\Users\\sam\\x'))], tail: Buffer.from('TRAILER with sam@mail.test') }));
  const before = fs.readFileSync(src);
  const known = await meta.detect(src);
  assert.strictEqual(known.status, 'personal');
  const dir = stageDir();
  const dst = path.join(dir, 'IMG_1.jpg');
  const mtime = new Date(Date.now() - 86400000 * 30);
  fs.utimesSync(src, mtime, mtime);
  await meta.cleanCopy({ src, dst, known });
  assert.strictEqual(sha(fs.readFileSync(src)), sha(before), 'the original is byte for byte the same');
  const out = fs.readFileSync(dst);
  assert.deepStrictEqual(fs.readdirSync(dir), ['IMG_1.jpg'], 'no partial file left');
  assert.strictEqual(Math.trunc(fs.statSync(dst).mtimeMs / 1000), Math.trunc(mtime.getTime() / 1000), 'the modified date stays');
  assert.strictEqual(fs.statSync(dst).nlink, 1);
  // Structure: SOI, JFIF, a minimal EXIF, ICC, Adobe, the tables, SOS ... EOI, nothing after.
  const segs = jpegSegments(out);
  assert.deepStrictEqual(segs.map(s => s.m.toString(16)), ['e0', 'e1', 'e2', 'ee', 'db', 'c4', 'c0', 'da']);
  assert.ok(segs[2].payload.equals(ICC), 'ICC kept byte for byte');
  assert.strictEqual(segs[1].payload.length, 6 + 26, 'EXIF holds the orientation and nothing else');
  assert.ok(out.subarray(out.length - 2).equals(Buffer.from([0xff, 0xd9])), 'ends at its EOI');
  for (const s of ['Sam', 'Canon', 'maker', 'TRAILER', 'between', 'Users']) assert.ok(!out.includes(Buffer.from(s)), `${s} gone`);
  // The picture data (from SOS to EOI) is the original's.
  const scan = (b) => { const i = b.lastIndexOf(Buffer.from([0xff, 0xda])); return b.subarray(i, b.indexOf(Buffer.from([0xff, 0xd9]), i)); };
  assert.ok(scan(out).equals(scan(BASE_JPEG)));
  const again = await meta.detect(dst);
  assert.deepStrictEqual(again, { status: 'clean', kind: 'jpeg', findings: [], orientation: 6 });
});

test('JPEG cleaner: orientation 1 or none writes no EXIF at all; a JPEG with no end fails', async () => {
  const src = put(jpegWith([exifSeg(tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'Sam' }, { tag: 0x0112, type: 3, value: 1 }] }))]));
  const known = await meta.detect(src);
  const dst = path.join(stageDir(), 'a.jpg');
  await meta.cleanCopy({ src, dst, known });
  assert.deepStrictEqual(jpegSegments(fs.readFileSync(dst)).map(s => s.m.toString(16)), ['e0', 'db', 'c4', 'c0', 'da']);
  assert.ok((await meta.jpegStrip(fs.readFileSync(dst))).length > 0);
  await assert.rejects(meta.jpegStrip(BASE_JPEG.subarray(0, BASE_JPEG.length - 2)), { code: 'BAD_JPEG' });
  await assert.rejects(meta.jpegStrip(Buffer.from('not a jpeg')), { code: 'BAD_JPEG' });
  assert.strictEqual((await meta.detect(put(BASE_JPEG.subarray(0, BASE_JPEG.length - 2)))).status, 'failed', 'no end marker: the check failed');
});

test('PNG cleaner: text, eXIf and unknown chunks gone, colour and animation kept, orientation as a new eXIf, original untouched', async () => {
  const ex = tiff({ ifd0: [{ tag: 0x0112, type: 3, value: 3 }, { tag: 0x013b, type: 2, value: 'Sam' }], gps: GPS });
  const iccp = chunk('iCCP', Buffer.concat([Buffer.from('ICC\0\0', 'latin1'), zlib.deflateSync(crypto.randomBytes(100))]));
  const keep = [iccp, chunk('sRGB', Buffer.from([0])), chunk('gAMA', Buffer.from([0, 0, 0xb1, 0x8f])), chunk('pHYs', Buffer.alloc(9, 1))];
  const src = put(png([...keep, tEXt('Author', 'Sam'), zTXt('Comment', 'x'), iTXt('Title', 'y'), chunk('eXIf', ex), chunk('prVW', Buffer.from('preview of sam'))],
    { after: [tEXt('Comment', 'after the data')] }), '.png');
  const before = fs.readFileSync(src);
  const known = await meta.detect(src);
  assert.strictEqual(known.status, 'personal');
  const dst = path.join(stageDir(), 'p.png');
  await meta.cleanCopy({ src, dst, known });
  assert.strictEqual(sha(fs.readFileSync(src)), sha(before));
  const out = fs.readFileSync(dst);
  const { list, end } = pngChunks(out);
  assert.strictEqual(end, out.length, 'ends at IEND');
  assert.deepStrictEqual(list.map(c => c.type), ['IHDR', 'eXIf', 'iCCP', 'sRGB', 'gAMA', 'pHYs', 'IDAT', 'IEND']);
  assert.ok(list.every(c => c.crcOk), 'every CRC right');
  const srcList = pngChunks(before).list;
  for (const t of ['IHDR', 'iCCP', 'sRGB', 'gAMA', 'pHYs', 'IDAT']) {
    assert.ok(list.find(c => c.type === t).data.equals(srcList.find(c => c.type === t).data), `${t} byte for byte`);
  }
  assert.ok(list.find(c => c.type === 'eXIf').data.equals(meta.orientationTiff(3)));
  const again = await meta.detect(dst);
  assert.deepStrictEqual(again, { status: 'clean', kind: 'png', findings: [], orientation: 3 });
  // Animation chunks stay.
  const ap = put(png([chunk('acTL', Buffer.alloc(8)), chunk('fcTL', Buffer.alloc(26)), tEXt('Author', 'Sam')]), '.png');
  const dst2 = path.join(stageDir(), 'a.png');
  await meta.cleanCopy({ src: ap, dst: dst2, known: await meta.detect(ap) });
  assert.deepStrictEqual(pngChunks(fs.readFileSync(dst2)).list.map(c => c.type), ['IHDR', 'acTL', 'fcTL', 'IDAT', 'IEND']);
});

test('cleanCopy never writes through a link: a name already there (a hard link to the original) fails, the original stays', async (t) => {
  const src = put(jpegWith([comSeg('Holiday with Sam')]));
  const before = fs.readFileSync(src);
  const known = await meta.detect(src);
  const dir = stageDir();
  const dst = path.join(dir, 'x.jpg');
  try { fs.linkSync(src, dst); } catch { t.skip('no hard links here'); return; }
  await assert.rejects(meta.cleanCopy({ src, dst, known }), { code: 'CLEAN_FAILED' });
  assert.strictEqual(sha(fs.readFileSync(src)), sha(before));
  assert.deepStrictEqual(fs.readdirSync(dir), ['x.jpg'], 'no temporary file left');
  // dst === src, and a result that is not "personal", are refused too.
  await assert.rejects(meta.cleanCopy({ src, dst: src, known }), { code: 'CLEAN_FAILED' });
  await assert.rejects(meta.cleanCopy({ src, dst: path.join(dir, 'y.jpg'), known: { status: 'clean', kind: 'jpeg' } }), { code: 'CLEAN_FAILED' });
  assert.strictEqual(sha(fs.readFileSync(src)), sha(before));
});

/* ── Fail-safe with a stand-in ffmpeg and ffprobe ─────────────────────── */

const FAKE_FF = path.join(tmp, 'fake-ff.js');
fs.writeFileSync(FAKE_FF, `
const fs = require('fs');
const args = process.argv.slice(2);
const strip = (s) => s.replace(/^file:/, '');
if (args.includes('-show_format')) {
  if (process.env.FAKE_PROBE === 'fail') process.exit(1);
  const f = strip(args[args.length - 1]);
  let b; try { b = fs.readFileSync(f); } catch { process.exit(1); }
  const tags = b.includes('PERSONAL') ? { artist: 'Sam Example', location: '+52.3700+004.8900/' } : { encoder: 'Lavf' };
  process.stdout.write(JSON.stringify({ format: { format_name: 'mov,mp4', tags }, streams: [{ codec_type: 'video' }, { codec_type: 'audio' }] }));
  process.exit(0);
}
const input = strip(args[args.indexOf('-i') + 1]);
const output = strip(args[args.length - 1]);
if (!args.includes('-n') || fs.existsSync(output)) process.exit(1);
const mode = process.env.FAKE_FF_MODE || 'clean';
const src = fs.readFileSync(input);
if (mode === 'fail') process.exit(1);
if (mode === 'empty') { fs.writeFileSync(output, ''); process.exit(0); }
if (mode === 'copy') { fs.writeFileSync(output, src); process.exit(0); }
if (mode === 'small') { fs.writeFileSync(output, src.subarray(0, 10)); process.exit(0); }
if (mode === 'clean') { fs.writeFileSync(output, Buffer.from(src.toString('latin1').replace(/PERSONAL/g, 'scrubbed'), 'latin1')); process.stdout.write('progress=end\\n'); process.exit(0); }
`);
/** The stand-in programs: node running the script above. */
function useFakes() {
  meta._setForTest({ probe: { exe: process.execPath, pre: [FAKE_FF] }, ffmpeg: { exe: process.execPath, pre: [FAKE_FF] } });
}

test('cleanCopy fails safe: the tool fails, writes nothing, writes too little, or the copy still shows something', async (t) => {
  useFakes();
  t.after(() => { meta._setForTest({ probe: null, ffmpeg: null }); delete process.env.FAKE_FF_MODE; meta.forget(); });
  const m2 = meta;
  const src = put(Buffer.concat([Buffer.from('xxxx PERSONAL xxxx'), crypto.randomBytes(100 * 1024)]), '.mp4');
  const before = sha(fs.readFileSync(src));
  const known = await m2.detect(src);
  assert.strictEqual(known.status, 'personal');
  assert.strictEqual(known.kind, 'av');
  for (const mode of ['fail', 'empty', 'copy', 'small']) {
    process.env.FAKE_FF_MODE = mode;
    const dir = stageDir();
    await assert.rejects(m2.cleanCopy({ src, dst: path.join(dir, 'clip.mp4'), known }), { code: 'CLEAN_FAILED' }, mode);
    assert.deepStrictEqual(fs.readdirSync(dir), [], `${mode}: nothing left behind`);
    assert.strictEqual(sha(fs.readFileSync(src)), before);
  }
  process.env.FAKE_FF_MODE = 'clean';
  const dir = stageDir();
  await m2.cleanCopy({ src, dst: path.join(dir, 'clip.mp4'), known });
  assert.deepStrictEqual(fs.readdirSync(dir), ['clip.mp4']);
  assert.ok(!fs.readFileSync(path.join(dir, 'clip.mp4')).includes(Buffer.from('PERSONAL')));
  assert.strictEqual(sha(fs.readFileSync(src)), before);
  // A file name starting with "-" goes to the tools as file:<absolute path>.
  const dash = path.join(tmp, '-n clip & x;.mp4');
  fs.copyFileSync(src, dash);
  const k2 = await m2.detect(dash);
  assert.strictEqual(k2.status, 'personal', 'read through file:, not taken for an option');
});

test('a cancelled clean stops the tool and leaves nothing', async () => {
  const src = put(jpegWith([comSeg('Holiday with Sam')]));
  const known = await meta.detect(src);
  const dir = stageDir();
  await assert.rejects(meta.cleanCopy({ src, dst: path.join(dir, 'c.jpg'), known, handle: { cancelled: true, kill: null } }), { code: 'CANCELLED' });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

/* ── The session cache and step 1 checks ──────────────────────────────── */

test('the cache: same path, size and time come from memory; a changed file is checked again; forget() drops it all', async () => {
  meta.forget();
  const p = put(jpegWith([comSeg('first words')]));
  const st = fs.statSync(p);
  const f = { path: p, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
  const a = await meta.checkFile(f);
  assert.strictEqual(meta.cached(f), a);
  fs.writeFileSync(p, jpegWith([comSeg('other words!')]));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(p, later, later);
  const [b] = await meta.checkNow([p]);
  assert.match(JSON.stringify(b.findings), /other words/);
  const id = meta.startCheck([f]);
  for (let i = 0; i < 200 && !meta.checkStatus(id).done; i++) await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(meta.checkStatus(id).done, true);
  meta.forget();
  assert.strictEqual(meta.cached(f), null);
  assert.strictEqual(meta.checkStatus(id), null, 'checks go too');
  assert.strictEqual(meta._stateForTest().cache, 0);
});

test('the cache: a modified time just before a millisecond\'s end is read the way fs.statSync reads it; another millisecond is another file', async (t) => {
  meta.forget();
  const p = put(jpegWith([comSeg('first words')]));
  // 50 ns before ...462 ms. fs.statSync's mtimeMs (a double) rounds it up to
  // ...462; the nanoseconds cut to whole milliseconds say ...461.
  const NS = 1700000000461999950n;
  const AS_STAT = 1700000000462;
  // Linux: the real file gets that time (touch takes nanoseconds) and Node
  // itself shows the rounding. Elsewhere (NTFS keeps 100 ns ticks, and Node
  // sets whole milliseconds there) meta.js is shown that time instead.
  let real = false;
  if (process.platform === 'linux') {
    const r = spawnSync('touch', ['-d', '@1700000000.461999950', p]);
    real = r.status === 0 && fs.statSync(p, { bigint: true }).mtimeNs === NS;
  }
  if (real) {
    assert.strictEqual(fs.statSync(p).mtimeMs, AS_STAT, 'Node reads it as the next millisecond');
  } else {
    const stat = fs.promises.stat;
    fs.promises.stat = async function (q, o) {
      const st = await stat.call(this, q, o);
      if (q === p && o && o.bigint) st.mtimeNs = NS;
      return st;
    };
    t.after(() => { fs.promises.stat = stat; });
  }
  t.after(() => meta.forget());
  const size = fs.statSync(p).size;
  const a = await meta.checkFile({ path: p });
  assert.strictEqual(a.status, 'personal');
  // The file just checked is found, with the time fs.statSync gives for it.
  assert.strictEqual(meta.cached({ path: p, size, mtimeMs: AS_STAT }), a);
  // A time read as another millisecond, or another size, is another file.
  assert.strictEqual(meta.cached({ path: p, size, mtimeMs: AS_STAT - 1 }), null);
  assert.strictEqual(meta.cached({ path: p, size, mtimeMs: AS_STAT + 1 }), null);
  assert.strictEqual(meta.cached({ path: p, size: size + 1, mtimeMs: AS_STAT }), null);
});

test('a step 1 check runs a few at a time and never blocks: hundreds of files', async () => {
  meta.forget();
  const files = [];
  for (let i = 0; i < 300; i++) {
    const p = put(i % 3 ? png() : jpegWith([comSeg(`note ${i}`)]), i % 3 ? '.png' : '.jpg');
    const st = fs.statSync(p);
    files.push({ path: p, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) });
  }
  const id = meta.startCheck(files);
  let maxActive = 0;
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 1);
  for (let i = 0; i < 2000; i++) {
    maxActive = Math.max(maxActive, meta._stateForTest().active);
    const st = meta.checkStatus(id);
    if (st.done) break;
    await new Promise(r => setTimeout(r, 2));
  }
  clearInterval(timer);
  const st = meta.checkStatus(id);
  assert.strictEqual(st.done, true);
  assert.ok(maxActive <= meta.LIMITS.concurrency, `at most ${meta.LIMITS.concurrency} at once (${maxActive})`);
  assert.ok(ticks > 0, 'the event loop kept turning');
  assert.strictEqual(st.results.filter(r => r.status === 'personal').length, 100);
  meta.forget();
});

/* ── Review findings: failed versus not read, places looked at, covers ── */

test('a failed check is "failed", never clean or "could not be checked": by type; a type Vault does not read is "unchecked"', async (t) => {
  useFakes();
  t.after(() => { meta._setForTest({ probe: null, ffmpeg: null }); delete process.env.FAKE_PROBE; });
  process.env.FAKE_PROBE = 'fail';
  const junk = crypto.randomBytes(3000);
  // Video and audio by name, or by their first bytes under any name.
  for (const ext of ['.mp4', '.mkv', '.mov', '.mp3', '.m4a', '.flac', '.wav', '.webm', '.avi']) {
    assert.deepStrictEqual(await meta.detect(put(junk, ext)), { status: 'failed', kind: 'av', findings: [] }, ext);
  }
  const iso = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom\0\0\0\0', 'latin1'), junk]);
  assert.strictEqual((await meta.detect(put(iso, '.bin'))).status, 'failed', 'an MP4 by its bytes');
  const mkv = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), junk]);
  assert.strictEqual((await meta.detect(put(mkv, '.dat'))).status, 'failed', 'a Matroska file by its bytes');
  // Types Vault does not read: packed as they are.
  const webp = Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'), junk]);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'), junk]);
  for (const [buf, ext] of [[webp, '.webp'], [heic, '.heic'], [junk, '.gif'], [junk, '.pdf'], [junk, '.zip']]) {
    assert.deepStrictEqual(await meta.detect(put(buf, ext)), { status: 'unchecked', kind: null, findings: [] }, ext);
  }
  // A JPEG or PNG Vault cannot follow is a failed check, whatever its name.
  assert.strictEqual((await meta.detect(put(BASE_JPEG.subarray(0, 100), '.webp'))).status, 'failed');
});

test('the cache: the very same file only (size, modified and changed times, file id); a rewrite with its old size and time is checked again; a failed check is never kept', async (t) => {
  meta.forget();
  const p = put(jpegWith([comSeg('first words')]));
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(p, old, old);
  const st0 = fs.statSync(p);
  const a = await meta.checkFile({ path: p });
  assert.match(JSON.stringify(a.findings), /first words/);
  // Same size, the modified time put back: only the changed time (and content)
  // differ. Windows stamps times at its clock tick (about 16 ms), so wait past
  // one: a rewrite inside the same tick cannot be told apart by any key.
  await new Promise(r => setTimeout(r, 60));
  fs.writeFileSync(p, jpegWith([comSeg('other words')]));
  fs.utimesSync(p, st0.atime, st0.mtime);
  assert.strictEqual(fs.statSync(p).size, st0.size);
  assert.strictEqual(fs.statSync(p).mtimeMs, st0.mtimeMs);
  assert.notStrictEqual(fs.statSync(p).ctimeMs, st0.ctimeMs, 'the changed time moved');
  const [b] = await meta.checkNow([p]);
  assert.match(JSON.stringify(b.findings), /other words/, 'checked again, not taken from the cache');
  // A failed check is not kept: the next ask checks again.
  useFakes();
  t.after(() => { meta._setForTest({ probe: null, ffmpeg: null }); delete process.env.FAKE_PROBE; meta.forget(); });
  process.env.FAKE_PROBE = 'fail';
  const v = put(Buffer.from('a video with PERSONAL tags'), '.mp4');
  assert.strictEqual((await meta.checkFile({ path: v })).status, 'failed');
  delete process.env.FAKE_PROBE;
  assert.strictEqual((await meta.checkFile({ path: v })).status, 'personal', 'asked again, checked again');
});

/** An ISO BMFF box. */
function box(type, ...data) {
  const body = Buffer.concat(data);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}
const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');
const PROJECT_XMP = '<x:xmpmeta><rdf:RDF><rdf:Description><dc:creator><rdf:Seq><rdf:li>Sam Editor</rdf:li></rdf:Seq></dc:creator>'
  + '<xmpMM:Ingredients><rdf:Bag><rdf:li stRef:filePath="C:\\Users\\sam\\Premiere\\proj.prproj"/></rdf:Bag></xmpMM:Ingredients></rdf:Description></rdf:RDF></x:xmpmeta>';

test('places the check now looks: JPEG data after its end and APPn/COM between scans, PNG private chunks and data after IEND, MP4/MOV XMP', async (t) => {
  // JPEG: a trailer after the end marker.
  const trailer = await meta.detect(put(Buffer.concat([BASE_JPEG, Buffer.from('notes C:/Users/sam/secret.txt')])));
  assert.strictEqual(labels(trailer)['Folder path'], 'C:/Users/sam/secret.txt');
  // A second picture after the end (a gain map, a depth map): its EXIF is read.
  const second = jpegWith([exifSeg(tiff({ gps: GPS }))]);
  const withSecond = await meta.detect(put(Buffer.concat([BASE_JPEG, second])));
  assert.strictEqual(labels(withSecond).Location, '52.37, 4.89', 'GPS in a picture after the end');
  // APPn and COM between scans count like those before them.
  const between = await meta.detect(put(jpegWith([], { afterScan: [comSeg('between scans: Sam'), seg(0xe7, Buffer.from('\x00C:\\Users\\sam\\x\x00', 'latin1'))] })));
  assert.strictEqual(labels(between).Comment, 'between scans: Sam');
  assert.match(labels(between)['Folder path'], /^C:\\Users\\sam/);
  // A tail longer than the limit is not looked at in full: the check failed.
  const big = put(BASE_JPEG);
  fs.truncateSync(big, BASE_JPEG.length + meta.LIMITS.tail + 1);
  assert.strictEqual((await meta.detect(big)).status, 'failed');
  // A JPEG over the size limit is neither checked nor cleaned: the check failed, at once.
  const huge = put(BASE_JPEG);
  fs.truncateSync(huge, meta.LIMITS.jpegMax + 1);
  assert.strictEqual((await meta.detect(huge)).status, 'failed');
  // PNG: a private ancillary chunk, an unknown critical one, and data after IEND.
  const prvt = await meta.detect(put(png([chunk('prVt', Buffer.from('\x00\x01C:/Users/sam/x private', 'latin1'))]), '.png'));
  assert.match(labels(prvt)['Folder path'], /^C:\/Users\/sam\/x/);
  const crit = await meta.detect(put(png([chunk('SaMx', Buffer.from('mail sam@studio.test', 'latin1'))]), '.png'));
  assert.strictEqual(labels(crit).Email, 'sam@studio.test');
  const after = await meta.detect(put(Buffer.concat([png(), Buffer.from('appended /home/sam/notes')]), '.png'));
  assert.match(labels(after)['Folder path'], /^\/home\/sam\/notes/);
  const pngTail = put(png(), '.png');
  fs.truncateSync(pngTail, png().length + meta.LIMITS.tail + 1);
  assert.strictEqual((await meta.detect(pngTail)).status, 'failed');
  // The cleaners keep none of it, and the copies check clean.
  for (const [src, name] of [[put(Buffer.concat([jpegWith([], { afterScan: [comSeg('Sam')] }), second, Buffer.from('C:/Users/sam')])), 'j.jpg'],
    [put(Buffer.concat([png([chunk('prVt', Buffer.from('C:/Users/sam/x')), chunk('SaMx', Buffer.from('sam@studio.test'))]), Buffer.from('/home/sam/n')]), '.png'), 'p.png']]) {
    const dst = path.join(stageDir(), name);
    await meta.cleanCopy({ src, dst, known: await meta.detect(src) });
    const out = fs.readFileSync(dst);
    for (const s of ['Sam', 'sam']) assert.ok(!out.includes(Buffer.from(s)), `${name}: ${s} gone`);
    assert.strictEqual((await meta.detect(dst)).status, 'clean', name);
  }
  // MP4/MOV: XMP in a top-level uuid box and in moov/udta/XMP_ (ffprobe shows neither).
  useFakes();
  t.after(() => meta._setForTest({ probe: null, ffmpeg: null }));
  const ftyp = box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2', 'latin1'));
  for (const file of [
    Buffer.concat([ftyp, box('uuid', XMP_UUID, Buffer.from(PROJECT_XMP)), box('mdat', crypto.randomBytes(500))]),
    Buffer.concat([ftyp, box('mdat', crypto.randomBytes(500)), box('moov', box('udta', box('XMP_', Buffer.from(PROJECT_XMP))))]),
    Buffer.concat([ftyp, box('moov', box('trak', box('udta', box('XMP_', Buffer.from(PROJECT_XMP))))), box('mdat', crypto.randomBytes(500))]),
  ]) {
    const r = await meta.detect(put(file, '.mp4'));
    assert.strictEqual(r.status, 'personal');
    assert.strictEqual(labels(r).Name, 'Sam Editor');
    assert.match(labels(r)['Folder path'], /^C:\\Users\\sam\\Premiere/);
  }
  const otherUuid = Buffer.concat([ftyp, box('uuid', crypto.randomBytes(16), Buffer.from('<x:xmpmeta><dc:creator>Nobody</dc:creator></x:xmpmeta>')), box('mdat', crypto.randomBytes(500))]);
  assert.strictEqual((await meta.detect(put(otherUuid, '.mp4'))).status, 'clean', 'another uuid box is not XMP');
  const brokenBox = Buffer.concat([ftyp, Buffer.from([0, 0, 0, 3]), Buffer.from('junk'), crypto.randomBytes(100)]);
  assert.strictEqual((await meta.detect(put(brokenBox, '.mp4'))).status, 'failed', 'a box of an impossible size: the walk failed');
});

test('cover pictures: their kind ("Cover (front)", "Other") is not personal; a path in one still is; they are counted apart from video', () => {
  const found = new meta.Found();
  const r = meta._fromProbe({
    format: { format_name: 'mp3', tags: { encoder: 'Lavf61.7.100' } },
    streams: [
      { codec_type: 'audio', tags: {} },
      { codec_type: 'video', disposition: { attached_pic: 1 }, tags: { comment: 'Cover (front)', title: 'front' } },
      { codec_type: 'video', disposition: { attached_pic: 1 }, tags: { comment: 'Other' } },
    ],
  }, found);
  assert.deepStrictEqual(r.counts, { v: 0, a: 1, s: 0, t: 0, pics: 2 });
  assert.deepStrictEqual(found.findings(), [], 'a cover\'s kind and caption are not flagged');
  const f2 = new meta.Found();
  meta._fromProbe({ format: {}, streams: [{ codec_type: 'video', disposition: { attached_pic: 1 }, tags: { comment: 'scan of C:\\Users\\sam\\cover.png' } }] }, f2);
  assert.match(f2.findings()[0].value, /^C:\\Users\\sam/);
  // Attachments are counted, their names scanned.
  const f3 = new meta.Found();
  const r3 = meta._fromProbe({ format: {}, streams: [{ codec_type: 'video' }, { codec_type: 'attachment', tags: { filename: 'Arial.ttf', mimetype: 'font/ttf' } },
    { codec_type: 'attachment', tags: { filename: 'sam@mail.test.ttf', mimetype: 'font/ttf' } }] }, f3);
  assert.strictEqual(r3.counts.t, 2);
  assert.deepStrictEqual(r3.attachments.map(a => a.filename), ['Arial.ttf', 'sam@mail.test.ttf']);
  assert.deepStrictEqual(f3.findings(), [{ label: 'Email', value: 'sam@mail.test.ttf' }]);
});

test('no long block of the event loop: hostile XMP just under its limit, and a big JPEG checked and cleaned in blocks', async () => {
  const { performance } = require('node:perf_hooks');
  let worst = 0;
  let last = performance.now();
  const timer = setInterval(() => { const n = performance.now(); worst = Math.max(worst, n - last); last = n; }, 1);
  const measure = async (fn) => {
    await new Promise(r => setTimeout(r, 5));
    worst = 0; last = performance.now();
    const out = await fn();
    await new Promise(r => setTimeout(r, 5));
    return { worst, out };
  };
  const LIMIT_MS = 250;   // was 2158 ms (XMP) and 2700 ms (a 240 MB JPEG) before
  try {
    const cap = meta.LIMITS.xmp - 64;
    const fill = (unit, head = '') => { let s = head; while (s.length + unit.length < cap) s += unit; return s; };
    const xmps = {
      'unclosed elements': fill('<dc:creator>'),
      'unclosed elements with text': fill('<dc:creator>Sam '),
      'several unclosed fields': fill('<dc:creator><dc:title><photoshop:City><tiff:Make>'),
      'an unclosed quote': fill(` dc:creator="${'a'.repeat(3000)}`, '<r'),
      'only <': '<'.repeat(cap),
      entities: `<dc:creator>${fill('&amp;')}`,
      'paths and emails': fill('C:\\x a@b.c '),
    };
    for (const [name, xml] of Object.entries(xmps)) {
      const p = put(png([iTXt('XML:com.adobe.xmp', xml)]), '.png');
      const { worst: w, out } = await measure(() => meta.detect(p));
      assert.ok(w < LIMIT_MS, `${name}: blocked ${w.toFixed(0)} ms`);
      assert.ok(['clean', 'personal', 'failed'].includes(out.status), `${name}: ${out.status}`);
    }
    // A JPEG of 64 MB whose picture data is all stuffed bytes (FF 00): one
    // marker test per two bytes, the worst case for the walk.
    const p = path.join(tmp, 'big.jpg');
    const head = jpegWith([comSeg('Holiday with Sam')]);
    const fd = fs.openSync(p, 'w');
    fs.writeSync(fd, head.subarray(0, head.length - 2));
    const blk = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < blk.length; i += 2) { blk[i] = 0xff; blk[i + 1] = 0; }
    for (let i = 0; i < 8; i++) fs.writeSync(fd, blk);
    fs.writeSync(fd, Buffer.from([0xff, 0xd9]));
    fs.closeSync(fd);
    const d = await measure(() => meta.detect(p));
    assert.strictEqual(d.out.status, 'personal');
    assert.ok(d.worst < LIMIT_MS, `check: blocked ${d.worst.toFixed(0)} ms`);
    const dst = path.join(stageDir(), 'big.jpg');
    const c = await measure(() => meta.cleanCopy({ src: p, dst, known: d.out }));
    assert.ok(c.worst < LIMIT_MS, `clean: blocked ${c.worst.toFixed(0)} ms`);
    assert.strictEqual(fs.statSync(dst).size, fs.statSync(p).size - (head.length - BASE_JPEG.length));
    fs.rmSync(p);
    fs.rmSync(dst);
  } finally {
    clearInterval(timer);
  }
});

/* ── A real round trip, when this machine has ffmpeg and ffprobe ──────── */

const ff = (() => {
  const exe = require('../lib/ffmpeg-locate');
  const a = spawnSync(exe.resolve('ffmpeg'), ['-version'], { windowsHide: true });
  const b = spawnSync(exe.resolve('ffprobe'), ['-version'], { windowsHide: true });
  return a.status === 0 && b.status === 0 ? { ffmpeg: exe.resolve('ffmpeg'), ffprobe: exe.resolve('ffprobe') } : null;
})();

test('real ffmpeg: a tagged mp4 and mkv with chapters come out clean, streams and chapters kept, the original unchanged', { skip: ff ? false : 'no ffmpeg or ffprobe on this machine' }, async () => {
  delete require.cache[require.resolve('../lib/share/meta')];
  const m3 = require('../lib/share/meta');
  const metaTxt = path.join(tmp, 'meta.txt');
  fs.writeFileSync(metaTxt, ';FFMETADATA1\ntitle=My holiday\nartist=Sam Example\nlocation=+52.3700+004.8900/\nmake=Apple\nmodel=iPhone 15 Pro\n'
    + '[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=At home with Sam\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=500\nEND=1000\ntitle=Chapter 2\n');
  for (const ext of ['.mp4', '.mkv']) {
    const src = path.join(tmp, `real${ext}`);
    const mk = spawnSync(ff.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=d=1:s=32x24', '-f', 'lavfi', '-i', 'sine=d=1',
      '-i', metaTxt, '-map', '0', '-map', '1', '-map_metadata', '2', '-map_chapters', '2', '-c:v', 'mpeg4', '-c:a', 'aac',
      '-metadata:s:a:0', 'title=notes in C:\\Users\\sam', ...(ext === '.mp4' ? ['-movflags', 'use_metadata_tags'] : []), src], { windowsHide: true });
    assert.strictEqual(mk.status, 0, String(mk.stderr));
    const before = sha(fs.readFileSync(src));
    const known = await m3.detect(src);
    assert.strictEqual(known.status, 'personal', ext);
    const f = labels(known);
    assert.match(f.Location, /52\.37, 4\.89/);
    assert.strictEqual(f.Name, 'Sam Example');
    const dst = path.join(stageDir(), `out${ext}`);
    await m3.cleanCopy({ src, dst, known });
    assert.strictEqual(sha(fs.readFileSync(src)), before, 'the original is unchanged');
    const again = await m3.detect(dst);
    assert.strictEqual(again.status, 'clean', JSON.stringify(again));
    assert.deepStrictEqual(again.counts, known.counts);
    const probe = JSON.parse(spawnSync(ff.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_chapters', '-show_format', dst], { windowsHide: true }).stdout);
    assert.strictEqual(probe.chapters.length, 2, 'chapters keep their times');
    assert.ok(!JSON.stringify(probe).includes('Sam'));
    assert.ok(!/encoder"\s*:\s*"Lavf\d/.test(JSON.stringify(probe.format.tags || {})), 'no versioned encoder tag');
  }
  // The cleaned JPEG decodes to the very same pixels.
  const jsrc = put(jpegWith([exifSeg(tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'Sam' }], gps: GPS })), comSeg('x')], { tail: Buffer.from('junk') }));
  const jdst = path.join(stageDir(), 'j.jpg');
  await m3.cleanCopy({ src: jsrc, dst: jdst, known: await m3.detect(jsrc) });
  const md5 = (p) => spawnSync(ff.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', p, '-f', 'md5', '-'], { windowsHide: true }).stdout.toString().trim();
  assert.ok(md5(jsrc).startsWith('MD5='));
  assert.strictEqual(md5(jdst), md5(jsrc), 'the same picture');
});

test('real ffmpeg: covers (a plain one does not fail the share, a cleaned copy never keeps one), MKV fonts kept and counted, MP4 XMP found and dropped', { skip: ff ? false : 'no ffmpeg or ffprobe on this machine' }, async () => {
  delete require.cache[require.resolve('../lib/share/meta')];
  const m4 = require('../lib/share/meta');
  const mk = (args) => spawnSync(ff.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  const streams = (p) => JSON.parse(spawnSync(ff.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', p], { windowsHide: true }).stdout).streams;
  // A cover holding a comment someone wrote: Vault does not look inside covers.
  const cover = put(jpegWith([comSeg('cover scanned at C:\Users\sam\covers')]));
  const audio = [];
  const m4a = (name, extra) => {
    const p = path.join(tmp, name);
    const r = mk(['-f', 'lavfi', '-i', 'sine=d=1', '-i', cover, '-map', '0', '-map', '1', '-c:a', 'aac', '-c:v', 'copy', '-disposition:v:0', 'attached_pic', ...extra, p]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    audio.push(p);
    return p;
  };
  const plain = m4a('plain.m4a', []);
  const tagged = m4a('tagged.m4a', ['-metadata', 'artist=Sam Example']);
  let mp3Plain = null;
  let mp3Tagged = null;
  const mp3 = (name, extra) => {
    const p = path.join(tmp, name);
    const r = mk(['-f', 'lavfi', '-i', 'sine=d=1', '-i', cover, '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-c:v', 'copy', '-id3v2_version', '3',
      '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', ...extra, p]);
    return r.status === 0 ? p : null;
  };
  mp3Plain = mp3('plain.mp3', []);
  mp3Tagged = mp3('tagged.mp3', ['-metadata', 'artist=Sam Example']);
  // A plain cover and no personal tags: clean, packed as it is, never a failure.
  for (const p of [plain, mp3Plain].filter(Boolean)) {
    const r = await m4.detect(p);
    assert.strictEqual(r.status, 'clean', `${path.basename(p)}: ${JSON.stringify(r)}`);
    assert.strictEqual(r.counts.pics, 1);
    assert.strictEqual(r.counts.v, 0, 'a cover is not a video');
  }
  // Personal tags: the cleaned copy keeps the audio and drops the cover; the step 1 list says so.
  for (const p of [tagged, mp3Tagged].filter(Boolean)) {
    const known = await m4.detect(p);
    assert.strictEqual(known.status, 'personal', path.basename(p));
    assert.strictEqual(labels(known).Picture, 'cover picture');
    const dst = path.join(stageDir(), path.basename(p));
    await m4.cleanCopy({ src: p, dst, known });
    assert.deepStrictEqual(streams(dst).map(s => s.codec_type), ['audio'], 'no cover in the cleaned copy');
    assert.ok(!fs.readFileSync(dst).includes(Buffer.from('C:\Users\sam')), 'nothing of the cover left');
    assert.strictEqual((await m4.detect(dst)).status, 'clean');
  }
  // MKV: fonts for styled subtitles are kept (name and type set again); a
  // name that is not plainly a file name is replaced; the copy has as many.
  const font = put(crypto.randomBytes(3000), '.ttf');
  const srt = path.join(tmp, 's.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:00,500\nhello\n');
  const mkv = path.join(tmp, 'fonts.mkv');
  const r = mk(['-f', 'lavfi', '-i', 'testsrc=d=1:s=32x24', '-f', 'lavfi', '-i', 'sine=d=1', '-i', srt, '-attach', font, '-attach', font,
    '-metadata:s:t:0', 'mimetype=application/x-truetype-font', '-metadata:s:t:0', 'filename=Arial Bold.ttf',
    '-metadata:s:t:1', 'mimetype=application/x-truetype-font', '-metadata:s:t:1', 'filename=sam@mail.test.ttf',
    '-map', '0', '-map', '1', '-map', '2', '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata', 'artist=Sam Example', mkv]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const known = await m4.detect(mkv);
  assert.strictEqual(known.status, 'personal');
  assert.strictEqual(known.counts.t, 2);
  assert.match(labels(known).Email, /sam@mail\.test/);
  const dst = path.join(stageDir(), 'fonts.mkv');
  await m4.cleanCopy({ src: mkv, dst, known });
  const att = streams(dst).filter(s => s.codec_type === 'attachment');
  assert.deepStrictEqual(att.map(s => [s.tags.filename, s.tags.mimetype]), [['Arial Bold.ttf', 'application/x-truetype-font'], ['attachment-2.ttf', 'application/x-truetype-font']]);
  assert.strictEqual((await m4.detect(dst)).status, 'clean');
  // MP4 with Adobe XMP in a top-level uuid box: found, and not in the copy.
  const mp4 = path.join(tmp, 'xmp.mp4');
  assert.strictEqual(mk(['-f', 'lavfi', '-i', 'testsrc=d=1:s=32x24', '-c:v', 'mpeg4', mp4]).status, 0);
  fs.appendFileSync(mp4, box('uuid', XMP_UUID, Buffer.from(PROJECT_XMP)));
  const kx = await m4.detect(mp4);
  assert.strictEqual(kx.status, 'personal');
  assert.strictEqual(labels(kx).Name, 'Sam Editor');
  const dx = path.join(stageDir(), 'xmp.mp4');
  await m4.cleanCopy({ src: mp4, dst: dx, known: kx });
  assert.ok(!fs.readFileSync(dx).includes(XMP_UUID), 'no XMP box in the copy');
  assert.strictEqual((await m4.detect(dx)).status, 'clean');
});

test('real ffmpeg: a cleaned copy cut short is refused, cover or not, whatever its header claims; a copy that only lost a big cover passes', { skip: ff ? false : 'no ffmpeg or ffprobe on this machine' }, async (t) => {
  delete require.cache[require.resolve('../lib/share/meta')];
  const m5 = require('../lib/share/meta');
  t.after(() => { m5._setForTest({ ffmpeg: null }); delete process.env.FF_WRAP; });
  const mk = (args) => spawnSync(ff.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  // A cover of about 3 MB (noise does not compress) on 30 s of audio (about 0.5 MB).
  const cover = path.join(tmp, 'big-cover.jpg');
  assert.strictEqual(mk(['-f', 'lavfi', '-i', 'nullsrc=s=1600x1600,geq=random(1)*255:random(1)*255:random(1)*255', '-frames', '1', '-q:v', '1', cover]).status, 0);
  assert.ok(fs.statSync(cover).size > 2 * 1024 * 1024, 'a big cover');
  const make = (name, codec, withCover) => {
    const p = path.join(tmp, name);
    const r = mk(['-f', 'lavfi', '-i', 'sine=d=30', ...(withCover ? ['-i', cover, '-map', '0', '-map', '1', '-c:v', 'copy', '-disposition:v:0', 'attached_pic'] : []),
      '-c:a', codec, '-b:a', '128k', '-metadata', 'artist=Sam Example', p]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    return p;
  };
  const files = [make('cover30.mp3', 'libmp3lame', true), make('cover30.m4a', 'aac', true), make('plain30.mp3', 'libmp3lame', false)];
  // Vault's ffmpeg behind a stand-in: FF_WRAP=trunc cuts the copy to 30% after
  // ffmpeg says it is done (exit 0); FF_WRAP=nomeasure fails the cover measuring.
  const wrap = path.join(tmp, 'ff-wrap.js');
  fs.writeFileSync(wrap, `
const cp = require('child_process'), fs = require('fs');
const a = process.argv.slice(2);
const measuring = a.includes('data') && a.includes('pipe:1');
if (measuring && process.env.FF_WRAP === 'nomeasure') process.exit(1);
const r = cp.spawnSync(${JSON.stringify(ff.ffmpeg)}, a, { stdio: 'inherit', windowsHide: true });
if (r.status === 0 && !measuring && process.env.FF_WRAP === 'trunc') {
  const out = a[a.length - 1].replace(/^file:/, '');
  const b = fs.readFileSync(out);
  fs.writeFileSync(out, b.subarray(0, Math.floor(b.length * 0.3)));
}
process.exit(r.status == null ? 1 : r.status);
`);
  m5._setForTest({ ffmpeg: { exe: process.execPath, pre: [wrap] } });
  for (const src of files) {
    const known = await m5.detect(src);
    assert.strictEqual(known.status, 'personal', path.basename(src));
    const hasCover = !/plain/.test(src);
    assert.strictEqual(known.counts.pics, hasCover ? 1 : 0);
    // Cut short: refused, with its duration known or not.
    process.env.FF_WRAP = 'trunc';
    for (const k of [known, { ...known, duration: null }]) {
      const dir = stageDir();
      await assert.rejects(m5.cleanCopy({ src, dst: path.join(dir, 'x' + path.extname(src)), known: k }), { code: 'CLEAN_FAILED' }, `${path.basename(src)} cut short`);
      assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing left behind');
    }
    // Whole: passes, even when the copy is a fraction of the original because the cover went.
    process.env.FF_WRAP = '';
    const dst = path.join(stageDir(), path.basename(src));
    await m5.cleanCopy({ src, dst, known: { ...known, duration: null } });
    if (hasCover) assert.ok(fs.statSync(dst).size < fs.statSync(src).size * 0.3, 'most of the original was the cover');
    // The covers cannot be measured: the rule only gets stricter, so a copy
    // that lost a big cover fails (safe), and one with no cover still passes.
    process.env.FF_WRAP = 'nomeasure';
    const d2 = stageDir();
    const p2 = m5.cleanCopy({ src, dst: path.join(d2, path.basename(src)), known });
    if (hasCover) await assert.rejects(p2, { code: 'CLEAN_FAILED' });
    else await p2;
  }
});
