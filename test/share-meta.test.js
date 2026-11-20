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
  assert.strictEqual(r2.status, 'unchecked');
  // A value offset far out of range, and a GPS pointer out of range: GPS data still counts.
  const oob = Buffer.from(tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'a long artist name' }], gps: [GPS[1]] }));
  const r3 = await meta.detect(put(jpegWith([exifSeg(oob.subarray(0, 40))])));
  assert.notStrictEqual(r3.status, 'clean');
  // Not a TIFF at all inside "Exif".
  const r4 = await meta.detect(put(jpegWith([exifSeg(Buffer.from('nonsense!'))])));
  assert.strictEqual(r4.status, 'unchecked');
  // Truncated in the middle of a segment, and only a few bytes.
  const whole = jpegWith([exifSeg(tiff({ ifd0: [{ tag: 0x013b, type: 2, value: 'Sam' }] }))]);
  assert.strictEqual((await meta.detect(put(whole.subarray(0, 30)))).status, 'unchecked');
  assert.strictEqual((await meta.detect(put(Buffer.from([0xff, 0xd8, 0xff])))).status, 'unchecked');
  assert.strictEqual((await meta.detect(put(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), crypto.randomBytes(4000)])))).status, 'unchecked');
  // A segment length below 2.
  assert.strictEqual((await meta.detect(put(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0, 0, 0, 0])))).status, 'unchecked');
  // Thousands of tiny segments: stops at the limit, not clean.
  const many = Array.from({ length: meta.LIMITS.segments + 10 }, () => seg(0xe5, Buffer.from('ab')));
  assert.strictEqual((await meta.detect(put(jpegWith(many)))).status, 'unchecked');
  // A missing file and a folder.
  assert.strictEqual((await meta.detect(path.join(tmp, 'nope.jpg'))).status, 'unchecked');
  assert.strictEqual((await meta.detect(tmp)).status, 'unchecked');
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
  assert.strictEqual((await meta.detect(put(png([bomb]), '.png'))).status, 'unchecked', 'not unpacked past the limit');
  const bad = png([tEXt('Author', 'x')]);
  bad.writeUInt32BE(0x7ffffff0, 8 + 25);   // the tEXt length
  assert.strictEqual((await meta.detect(put(bad, '.png'))).status, 'unchecked');
  const noEnd = png().subarray(0, png().length - 12);
  assert.strictEqual((await meta.detect(put(noEnd, '.png'))).status, 'unchecked');
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
  assert.deepStrictEqual(r.counts, { v: 1, a: 1, s: 1 });
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
  assert.ok(meta.jpegStrip(fs.readFileSync(dst)).length > 0);
  assert.throws(() => meta.jpegStrip(BASE_JPEG.subarray(0, BASE_JPEG.length - 2)), { code: 'BAD_JPEG' });
  assert.throws(() => meta.jpegStrip(Buffer.from('not a jpeg')), { code: 'BAD_JPEG' });
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
